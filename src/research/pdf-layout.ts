import type { ResearchNode, ResearchPaper } from './schema'
import type {
  NodeSourceEvidence,
  PdfNoteRelationship,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReconstruction,
  ReconstructionDiagnostic,
} from './import-types'
import { assessPdfCompleteness } from './pdf-quality'
import {
  normalizedNoteLabel,
  noteLabelFromText,
  reconstructPageRegions,
} from './pdf-regions'

export type PdfDocumentMetadata = {
  title?: string
  author?: string
  subject?: string
  modified?: string
}

type RegionBlock = {
  type: 'heading' | 'paragraph' | 'caption' | 'footnote'
  region: PdfPageRegion
  text: string
  confidence: number
  noteKind?: 'footnote' | 'endnote'
  noteLabel?: string
  nodeId?: string
}

type NoteReferenceDraft = {
  id: string
  label: string
  region: PdfPageRegion
  start: number
  end: number
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function parseAuthors(author?: string) {
  const authors = author
    ?.split(/[;,]/)
    .map((value) => value.trim())
    .filter(Boolean)
  return authors?.length ? authors : ['Imported locally']
}

function validDate(value?: string) {
  if (!value) return '1970-01-01'
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf())
    ? '1970-01-01'
    : parsed.toISOString().slice(0, 10)
}

function slug(value: string, maximum = 36) {
  return (
    value
      .toLocaleLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, maximum) || 'content'
  )
}

function nodeId(index: number, type: RegionBlock['type'], text: string) {
  const prefix =
    type === 'heading' ? 'sec' : type === 'caption' ? 'caption' : 'p'
  return `${prefix}-${String(index + 1).padStart(3, '0')}-${slug(text)}`
}

function noteText(region: PdfPageRegion, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    normalizedNoteLabel(region.text)
      .replace(
        new RegExp(
          `^(?:(?:footnote|note)\\s+)?${escaped}(?:\\s*[:.)\\]-]|\\s+)\\s*`,
          'i',
        ),
        '',
      )
      .trim() || region.text.trim()
  )
}

function blocksFromRegions(
  orderedRegions: PdfPageRegion[],
  regions: PdfPageRegion[],
) {
  const readingRegions = orderedRegions.filter((region) =>
    ['body', 'spanning', 'caption', 'footnote', 'endnote'].includes(
      region.kind,
    ),
  )
  const bodySize =
    median(
      regions
        .filter((region) => region.kind === 'body')
        .flatMap((region) => region.lines.map((line) => line.fontSize)),
    ) || 12
  return readingRegions.map<RegionBlock>((region) => {
    if (region.kind === 'caption') {
      return {
        type: 'caption',
        region,
        text: region.text,
        confidence: region.confidence,
      }
    }
    if (region.kind === 'footnote' || region.kind === 'endnote') {
      const label = noteLabelFromText(region.text) ?? '?'
      return {
        type: 'footnote',
        region,
        text: noteText(region, label),
        confidence: region.confidence,
        noteKind: region.kind,
        noteLabel: label,
      }
    }
    const largestFont = Math.max(
      ...region.lines.map((line) => line.fontSize),
      bodySize,
    )
    const heading =
      region.text.length <= 180 &&
      (largestFont >= bodySize * 1.28 ||
        /^(?:abstract|introduction|methods?|results?|discussion|conclusion|references|endnotes?|notes?)\b/i.test(
          region.text,
        ))
    return {
      type: heading ? 'heading' : 'paragraph',
      region,
      text: region.text,
      confidence: Math.min(region.confidence, heading ? 0.9 : 0.86),
    }
  })
}

function referenceOffsets(region: PdfPageRegion) {
  const found: Array<{ label: string; start: number; end: number }> = []
  const add = (label: string, start: number, end: number) => {
    const normalized = normalizedNoteLabel(label)
    if (start < 0 || end <= start) return
    if (
      found.some(
        (candidate) =>
          candidate.label === normalized &&
          Math.abs(candidate.start - start) <= 1,
      )
    ) {
      return
    }
    found.push({ label: normalized, start, end })
  }

  const explicit =
    /\b(?:footnote|note)\s+(?:reference\s+)?(\d{1,3}|[*†‡§])(?=\s|[.,;:)\]]|$)/giu
  for (const match of region.text.matchAll(explicit)) {
    const label = match[1]
    const offset = (match.index ?? 0) + match[0].lastIndexOf(label)
    add(label, offset, offset + label.length)
  }
  const inline = /\[(\d{1,3}|[*†‡§])\]|([⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*†‡§])/gu
  for (const match of region.text.matchAll(inline)) {
    const raw = match[1] ?? match[2]
    const offset = (match.index ?? 0) + match[0].indexOf(raw)
    add(raw, offset, offset + raw.length)
  }

  let lineOffset = 0
  for (const line of region.lines) {
    const largestRun = Math.max(...line.runs.map((run) => run.fontSize), 0)
    for (const run of line.runs) {
      const raw = run.text.trim()
      const label = normalizedNoteLabel(raw)
      if (
        !/^(?:\d{1,3}|[*†‡§])$/.test(label) ||
        run.fontSize > largestRun * 0.82
      ) {
        continue
      }
      const withinLine = Math.max(
        line.text.lastIndexOf(raw),
        line.text.lastIndexOf(label),
      )
      add(label, lineOffset + withinLine, lineOffset + withinLine + raw.length)
    }
    lineOffset += line.text.length + 1
  }
  return found.sort((left, right) => left.start - right.start)
}

function noteNodeIds(blocks: RegionBlock[]) {
  const occurrences = new Map<string, number>()
  for (const block of blocks.filter(
    (candidate) => candidate.type === 'footnote',
  )) {
    const base = `${block.noteKind === 'endnote' ? 'en' : 'fn'}-p${String(block.region.page).padStart(3, '0')}-${slug(block.noteLabel ?? 'note', 16)}`
    const occurrence = (occurrences.get(base) ?? 0) + 1
    occurrences.set(base, occurrence)
    block.nodeId = occurrence === 1 ? base : `${base}-${occurrence}`
  }
}

function detectReferences(blocks: RegionBlock[]) {
  const counters = new Map<string, number>()
  const references: NoteReferenceDraft[] = []
  for (const block of blocks.filter(
    (candidate) =>
      candidate.type === 'paragraph' || candidate.type === 'heading',
  )) {
    for (const offset of referenceOffsets(block.region)) {
      const key = `${block.region.page}:${offset.label}`
      const count = (counters.get(key) ?? 0) + 1
      counters.set(key, count)
      references.push({
        id: `noteref-p${String(block.region.page).padStart(3, '0')}-${slug(offset.label, 16)}-${String(count).padStart(3, '0')}`,
        label: offset.label,
        region: block.region,
        start: offset.start,
        end: offset.end,
      })
    }
  }
  return references
}

function scoreNoteCandidate(reference: NoteReferenceDraft, note: RegionBlock) {
  let score = 0.55
  const evidence = ['label-exact']
  if (reference.region.page === note.region.page) {
    score += 0.25
    evidence.push('same-page-scope')
    if (reference.region.column === note.region.column) {
      score += 0.1
      evidence.push('same-column-geometry')
    } else if (note.region.column === 'span') {
      score += 0.06
      evidence.push('page-wide-note-region')
    }
    if (note.region.box.y >= reference.region.box.y) {
      score += 0.05
      evidence.push('note-follows-reference')
    }
  } else if (
    note.noteKind === 'endnote' &&
    note.region.page >= reference.region.page
  ) {
    const distance = note.region.page - reference.region.page
    score += Math.max(0.12, 0.2 - distance * 0.025)
    evidence.push('later-endnote-section-scope')
  }
  return { score: rounded(Math.min(score, 1)), evidence }
}

function matchNotes(
  blocks: RegionBlock[],
  references: NoteReferenceDraft[],
  diagnostics: ReconstructionDiagnostic[],
) {
  const notes = blocks.filter((block) => block.type === 'footnote')
  const relationships: PdfNoteRelationship[] = references.map((reference) => {
    const candidates = notes
      .filter(
        (note) =>
          normalizedNoteLabel(note.noteLabel ?? '') ===
          normalizedNoteLabel(reference.label),
      )
      .map((note) => {
        const scored = scoreNoteCandidate(reference, note)
        return {
          targetNoteId: note.nodeId!,
          targetRegionId: note.region.id,
          score: scored.score,
          evidence: scored.evidence,
          sourceBoxes: [reference.region.box, note.region.box],
        }
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.targetNoteId.localeCompare(right.targetNoteId),
      )
    const best = candidates[0]
    const ambiguous =
      Boolean(best) &&
      Boolean(candidates[1]) &&
      best.score - candidates[1].score < 0.04
    const matched = Boolean(best) && best.score >= 0.7 && !ambiguous
    if (ambiguous) {
      diagnostics.push({
        code: 'AMBIGUOUS_NOTE_MATCH',
        severity: 'error',
        page: reference.region.page,
        message: `Note reference ${reference.id} retains ${candidates.length} similarly scored targets for review.`,
        relationshipId: reference.id,
        sourceBoxes: [
          reference.region.box,
          ...candidates.map((candidate) => candidate.sourceBoxes[1]),
        ],
      })
    } else if (!matched) {
      diagnostics.push({
        code: 'UNRESOLVED_NOTE_REFERENCE',
        severity: 'error',
        page: reference.region.page,
        message: `Note reference ${reference.id} has no deterministic target above the confidence threshold.`,
        relationshipId: reference.id,
        sourceBoxes: [
          reference.region.box,
          ...candidates.map((candidate) => candidate.sourceBoxes[1]),
        ],
      })
    }
    return {
      id: reference.id,
      label: reference.label,
      referenceRegionId: reference.region.id,
      targetNoteId: matched ? best.targetNoteId : null,
      status: ambiguous ? 'ambiguous' : matched ? 'matched' : 'unresolved',
      confidence: best?.score ?? 0,
      evidence: best?.evidence ?? ['no-label-match'],
      candidates,
      sourceBoxes: matched ? best.sourceBoxes : [reference.region.box],
    }
  })

  const referencedNotes = new Set(
    relationships
      .filter((relationship) => relationship.status === 'matched')
      .map((relationship) => relationship.targetNoteId),
  )
  for (const note of notes) {
    if (referencedNotes.has(note.nodeId!)) continue
    diagnostics.push({
      code: 'UNREFERENCED_NOTE',
      severity: 'error',
      page: note.region.page,
      message: `Note ${note.nodeId} remains explicit because no unique reference resolved to it.`,
      sourceBoxes: [note.region.box],
    })
  }
  return relationships
}

function sourceEvidence(block: RegionBlock): NodeSourceEvidence {
  return {
    confidence: rounded(block.confidence),
    pages: [block.region.page],
    boxes: block.region.lines.flatMap((line) =>
      line.runs.map((run) => ({
        ...run,
        x: rounded(run.x),
        y: rounded(run.y),
        width: rounded(run.width),
        height: rounded(run.height),
        fontSize: rounded(run.fontSize),
        confidence: rounded(run.confidence),
      })),
    ),
  }
}

export function reconstructPageAnalyses({
  pages,
  sourceHash,
  fileName,
  byteLength,
  metadata = {},
}: {
  pages: PdfPageAnalysis[]
  sourceHash: string
  fileName: string
  byteLength: number
  metadata?: PdfDocumentMetadata
}): PdfReconstruction {
  const diagnostics: ReconstructionDiagnostic[] = []
  for (const page of pages) {
    if (page.kind === 'ocr-required') {
      diagnostics.push({
        code: 'OCR_REQUIRED',
        severity: 'error',
        page: page.page,
        message: `Page ${page.page} has insufficient embedded text and requires local OCR.`,
        sourceBoxes: [
          {
            page: page.page,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            rotation: page.rotation,
            method: 'pdf-object',
          },
        ],
      })
    } else if (page.kind === 'mixed') {
      diagnostics.push({
        code: 'MIXED_PAGE',
        severity: 'warning',
        page: page.page,
        message: `Page ${page.page} mixes sparse text with image content; review the reconstruction.`,
        sourceBoxes: [
          ...page.runs,
          ...(page.objects ?? []).map((object) => object.box),
        ],
      })
    }
  }

  const regionResult = reconstructPageRegions(pages)
  const regionMap = new Map(
    regionResult.regions.map((region) => [region.id, region]),
  )
  const orderedRegions = regionResult.readingOrder.order
    .map((id) => regionMap.get(id))
    .filter((region): region is PdfPageRegion => Boolean(region))
  if (regionResult.repeatedMarginCount > 0) {
    diagnostics.push({
      code: 'REPEATED_MARGIN_TEXT',
      severity: 'info',
      message: `Removed ${regionResult.repeatedMarginCount} repeated header or footer pattern${regionResult.repeatedMarginCount === 1 ? '' : 's'} from reading order.`,
    })
  }
  for (const resolution of regionResult.readingOrder.resolutions.filter(
    (candidate) => candidate.status === 'resolved',
  )) {
    const { regionIds, ...readingOrderResolution } = resolution
    for (const regionId of regionIds) {
      diagnostics.push({
        code: 'RESOLVED_READING_ORDER',
        severity: 'info',
        page: resolution.page,
        message: `Resolved ${regionId} as ${resolution.ambiguityClass} at confidence ${resolution.confidence.toFixed(2)} against threshold ${resolution.threshold.toFixed(2)} using ${resolution.evidence.map((item) => item.code).join(', ')}.`,
        readingOrderResolution: {
          ...readingOrderResolution,
          regionId,
        },
      })
    }
  }
  for (const page of regionResult.ambiguousPages) {
    const resolution = regionResult.readingOrder.resolutions.find(
      (candidate) =>
        candidate.page === page && candidate.status === 'ambiguous',
    )
    const { regionIds: _regionIds, ...readingOrderResolution } = resolution ?? {
      policyVersion: '1.0.0' as const,
      page,
      ambiguityClass: 'sparse-column-gutter' as const,
      status: 'ambiguous' as const,
      confidence: 0.5,
      threshold: 0.85,
      evidence: [],
      regionIds: [],
    }
    diagnostics.push({
      code: 'AMBIGUOUS_READING_ORDER',
      severity: 'error',
      page,
      message: `Page ${page} retains both column-order candidates at confidence ${readingOrderResolution.confidence.toFixed(2)}, below threshold ${readingOrderResolution.threshold.toFixed(2)}.`,
      readingOrderResolution,
      sourceBoxes: regionResult.regions
        .filter(
          (region) => region.page === page && region.includedInReadingOrder,
        )
        .map((region) => region.box),
    })
  }
  if (!regionResult.readingOrder.acyclic) {
    diagnostics.push({
      code: 'READING_ORDER_CYCLE',
      severity: 'error',
      message: 'The accepted reading-order edges contain a cycle.',
    })
  }

  const blocks = blocksFromRegions(orderedRegions, regionResult.regions)
  noteNodeIds(blocks)
  const references = detectReferences(blocks)
  const noteRelationships = matchNotes(blocks, references, diagnostics)
  const matchedReferences = new Map(
    noteRelationships
      .filter(
        (
          relationship,
        ): relationship is PdfNoteRelationship & { targetNoteId: string } =>
          relationship.status === 'matched' &&
          relationship.targetNoteId !== null,
      )
      .map((relationship) => [relationship.id, relationship]),
  )
  const referenceDrafts = new Map(
    references.map((reference) => [reference.id, reference]),
  )

  if (blocks.length === 0) {
    diagnostics.push({
      code: 'NO_RECONSTRUCTABLE_TEXT',
      severity: 'error',
      message: 'No reconstructable embedded text was found.',
    })
  }

  const provenance: Record<string, NodeSourceEvidence> = {}
  const nodes: ResearchNode[] = blocks.map((block, index) => {
    const id = block.nodeId ?? nodeId(index, block.type, block.text)
    block.nodeId = id
    provenance[id] = sourceEvidence(block)
    if (block.confidence < 0.75) {
      diagnostics.push({
        code: 'LOW_CONFIDENCE_BLOCK',
        severity: 'warning',
        page: block.region.page,
        message: `A reconstructed ${block.region.kind} region on page ${block.region.page} needs review.`,
        sourceBoxes: [block.region.box],
      })
    }
    const source = `pdf:${sourceHash.slice(0, 16)}#page=${block.region.page}`
    if (block.type === 'footnote') {
      const backlinks = noteRelationships
        .filter(
          (relationship) =>
            relationship.status === 'matched' &&
            relationship.targetNoteId === id,
        )
        .map((relationship) => relationship.id)
      return {
        id,
        type: 'footnote' as const,
        kind: block.noteKind!,
        label: block.noteLabel!,
        text: block.text,
        relationships: { backlinks },
        source,
      }
    }
    const noteReferences = [...matchedReferences.values()]
      .filter(
        (relationship) => relationship.referenceRegionId === block.region.id,
      )
      .map((relationship) => {
        const draft = referenceDrafts.get(relationship.id)!
        return {
          id: relationship.id,
          label: relationship.label,
          target: relationship.targetNoteId,
          start: draft.start,
          end: draft.end,
          confidence: relationship.confidence,
        }
      })
    if (block.type === 'heading') {
      return {
        id,
        type: 'heading' as const,
        level: 2 as const,
        text: block.text,
        ...(noteReferences.length > 0 ? { noteReferences } : {}),
        source,
      }
    }
    if (block.type === 'caption') {
      return {
        id,
        type: 'caption' as const,
        text: block.text,
        source,
      }
    }
    return {
      id,
      type: 'paragraph' as const,
      text: block.text,
      ...(noteReferences.length > 0 ? { noteReferences } : {}),
      source,
    }
  })

  const firstHeading = nodes.find(
    (node): node is Extract<ResearchNode, { type: 'heading' }> =>
      node.type === 'heading',
  )
  const firstParagraph = nodes.find(
    (node): node is Extract<ResearchNode, { type: 'paragraph' }> =>
      node.type === 'paragraph',
  )
  const paper: ResearchPaper = {
    id: `pdf-${sourceHash.slice(0, 16)}`,
    version: '1.0.0-import',
    status: 'working',
    title:
      metadata.title?.trim() ||
      firstHeading?.text ||
      fileName.replace(/\.pdf$/i, ''),
    subtitle:
      metadata.subject?.trim() || `Reconstructed locally from ${fileName}`,
    authors: parseAuthors(metadata.author),
    updated: validDate(metadata.modified),
    abstract:
      firstParagraph?.text.slice(0, 700) ||
      'This document requires OCR or manual reconstruction before publication.',
    nodes,
  }

  const assessment = assessPdfCompleteness({
    pages,
    paper,
    diagnostics,
    readingOrder: regionResult.readingOrder,
  })

  return {
    source: {
      fileName,
      byteLength,
      sha256: sourceHash,
      pageCount: pages.length,
      localOnly: true,
    },
    paper,
    pages,
    regions: regionResult.regions,
    readingOrder: regionResult.readingOrder,
    noteRelationships,
    provenance,
    diagnostics: assessment.diagnostics,
    semanticSignals: assessment.semanticSignals,
    completeness: assessment.completeness,
    readiness: assessment.readiness,
  }
}
