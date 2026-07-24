import type { ResearchNode, ResearchPaper } from './schema'
import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfCitationRelationship,
  PdfLinkAnnotation,
  PdfLineBoundaryDecision,
  PdfNoteMarkerClassification,
  PdfNoteRelationship,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfRegionColumn,
  PdfReconstruction,
  PdfScholarlyCrossReferenceRelationship,
  PdfSourceRun,
  PdfVisualAsset,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import {
  resolvePdfScholarlyCrossReferences,
  type PdfCanonicalCrossReferenceTarget,
} from './pdf-cross-references'
import {
  assessPdfCompleteness,
  classifyStructuralLineBoundaryDecisions,
  type CanonicalFloatScopeEvidence,
} from './pdf-quality'
import {
  classifyPdfNoteMarkers,
  noteLabelsFromMarkerText,
  PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
  splitPdfCompoundAffiliationNote,
} from './pdf-note-classifier'
import {
  inlineHardHyphenLexicon,
  inlineUnhyphenatedLexicon,
  positionedPdfPrefixAccentText,
  replayPdfRegionLineRanges,
} from './pdf-lines'
import { sourceMathAtomCompactionRanges } from './pdf-inline-script-integrity'
import { inferPublicationLanguageFromPdfText } from './pdf-language'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import {
  normalizePdfLinkAnnotations,
  normalizedPdfExternalLinkTarget,
  resolvePdfInternalLinkAnnotation,
  resolvePdfLinkedTokenRangeContinuity,
  resolveRegisteredPdfLinkedTokenContinuity,
  safePdfExternalLinkTarget,
  type PdfCanonicalInternalLinkTarget,
} from './pdf-links'
import {
  hasUnprovedTwoDimensionalEquationTranscript,
  reconstructPdfVisuals,
  type PdfFigureRasterizer,
} from './pdf-visuals'
import {
  normalizedNoteLabel,
  noteLabelFromText,
  reconstructPageRegions,
} from './pdf-regions'
import type { CanonicalTable } from './visual-assets'

export type PdfDocumentMetadata = {
  title?: string
  author?: string
  subject?: string
  modified?: string
  modifiedSource?: 'pdf-info-mod-date' | 'file-last-modified'
}

type RegionBlock = {
  type: 'heading' | 'paragraph' | 'caption' | 'footnote'
  region: PdfPageRegion
  text: string
  confidence: number
  headingLevel?: 1 | 2 | 3
  list?: {
    level: number
    ordered: boolean
    numberingId: string
    markerStyle:
      | 'decimal'
      | 'lower-roman'
      | 'upper-roman'
      | 'lower-alpha'
      | 'upper-alpha'
      | 'disc'
    ordinal?: number
    markerText?: string
    continuedFromPreviousPage?: boolean
  }
  noteKind?: 'footnote' | 'endnote'
  noteLabel?: string
  noteMarkerText?: string
  sourceSegments?: Array<{
    region: PdfPageRegion
    evidenceRegion?: PdfPageRegion
    sourceStart: number
    canonicalStart: number
    text: string
  }>
  suppressSourceInlineRuns?: boolean
  nodeId?: string
  bibliographyContinuedFromPreviousPage?: boolean
  frontMatterRole?:
    'title' | 'author' | 'affiliation' | 'abstract-heading' | 'abstract-body'
}

type NoteReferenceDraft = {
  id: string
  label: string
  region: PdfPageRegion
  start: number
  end: number
  classification: PdfNoteMarkerClassification
  canonicalAnchor:
    | { kind: 'node'; nodeId: string; start: number; end: number }
    | { kind: 'author'; author: string }
    | null
}

type AuthorNoteReferenceDraft = NoteReferenceDraft & {
  author: string
}

type SemanticReferenceDraft = {
  id: string
  start: number
  end: number
  semanticRole:
    'citation' | 'cross-reference' | 'affiliation-marker' | 'bibliography-entry'
  targetIds?: string[]
}

export const PDF_NOTE_RELATIONSHIP_THRESHOLD = 0.7

type CanonicalInlineRun = NonNullable<
  Extract<ResearchNode, { type: 'paragraph' }>['inlineRuns']
>[number]

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

type PdfAuthorResolution = {
  authors: string[]
  provenance: 'visible-source' | 'metadata-only' | 'unresolved'
  metadataAssessment: 'absent' | 'corroborated' | 'conflicting' | 'placeholder'
  unresolvedReasons: string[]
}

function comparableAuthorName(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function placeholderAuthorMetadata(value: string) {
  const comparable = comparableAuthorName(value)
  return (
    /microsoft(?:office)?word/u.test(comparable) ||
    /(?:pdf)?creator/u.test(comparable) ||
    new Set([
      'author',
      'defaultauthor',
      'unknown',
      'unknownauthor',
      'anonymous',
      'user',
    ]).has(comparable)
  )
}

function corroboratesVisibleAuthors(
  visibleAuthors: readonly string[],
  metadataAuthors: readonly string[],
) {
  const comparable = (values: readonly string[]) =>
    values.map(comparableAuthorName).filter(Boolean).sort()
  const visible = comparable(visibleAuthors)
  const metadata = comparable(metadataAuthors)
  return (
    visible.length > 0 &&
    visible.length === metadata.length &&
    visible.every((value, index) => value === metadata[index])
  )
}

function resolvePdfAuthors(
  visibleAuthors: readonly string[],
  metadataAuthor?: string,
): PdfAuthorResolution {
  const visible = [...new Set(visibleAuthors.map(normalizedAuthorName))]
    .map((author) => author.trim())
    .filter(Boolean)
  const rawMetadata = metadataAuthor?.trim()
  const metadataIsPlaceholder = Boolean(
    rawMetadata && placeholderAuthorMetadata(rawMetadata),
  )
  const metadataAuthors =
    rawMetadata && !metadataIsPlaceholder ? parseAuthors(rawMetadata) : []

  if (visible.length > 0) {
    if (!rawMetadata) {
      return {
        authors: visible,
        provenance: 'visible-source',
        metadataAssessment: 'absent',
        unresolvedReasons: [],
      }
    }
    if (metadataIsPlaceholder) {
      return {
        authors: visible,
        provenance: 'visible-source',
        metadataAssessment: 'placeholder',
        unresolvedReasons: ['placeholder author metadata'],
      }
    }
    if (corroboratesVisibleAuthors(visible, metadataAuthors)) {
      return {
        authors: visible,
        provenance: 'visible-source',
        metadataAssessment: 'corroborated',
        unresolvedReasons: [],
      }
    }
    return {
      authors: visible,
      provenance: 'visible-source',
      metadataAssessment: 'conflicting',
      unresolvedReasons: ['author metadata/source conflict'],
    }
  }

  if (metadataIsPlaceholder) {
    return {
      authors: ['Imported locally'],
      provenance: 'unresolved',
      metadataAssessment: 'placeholder',
      unresolvedReasons: ['placeholder author metadata', 'source author role'],
    }
  }
  if (metadataAuthors.length > 0) {
    return {
      authors: metadataAuthors,
      provenance: 'metadata-only',
      metadataAssessment: 'absent',
      unresolvedReasons: ['metadata-only author provenance'],
    }
  }
  return {
    authors: ['Imported locally'],
    provenance: 'unresolved',
    metadataAssessment: 'absent',
    unresolvedReasons: ['source author role'],
  }
}

function headingLevel(text: string, largestFont: number, bodySize: number) {
  const numbered = text.trim().match(/^(\d+(?:\.\d+){0,2})\.?\s+\S/)
  if (numbered) {
    return Math.min(3, numbered[1].split('.').length) as 1 | 2 | 3
  }
  const lettered = text.trim().match(/^([A-Z](?:\.\d+){0,2})\.?\s+\S/u)
  if (lettered) {
    return Math.min(3, lettered[1].split('.').length) as 1 | 2 | 3
  }
  if (
    /^(?:abstract|introduction|methods?|results?|discussion|conclusion|references|acknowledg(?:e)?ments?|ethics statement|impact statement|broader impacts?|limitations?|endnotes?|notes?)\b/i.test(
      text,
    )
  ) {
    return 1 as const
  }
  return largestFont >= bodySize * 1.45 ? (1 as const) : (2 as const)
}

function numberedHeadingOrdinal(text: string) {
  const match = text.trim().match(/^(\d+(?:\.\d+){0,3})[.)]?\s+\p{Lu}/u)
  return match?.[1].split('.').map(Number) ?? null
}

function structuralOrdinalHeadingText(text: string) {
  return /^(?:\d+(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?\s+\p{Lu}/u.test(
    text.trim(),
  )
}

function promoteAdjacentNumberedParentChildHeadings(
  blocks: RegionBlock[],
  bodySize: number,
) {
  for (let index = 0; index < blocks.length - 1; index += 1) {
    const parent = blocks[index]
    const child = blocks[index + 1]
    if (
      !['heading', 'paragraph'].includes(parent.type) ||
      !['heading', 'paragraph'].includes(child.type) ||
      (parent.type !== 'heading' && child.type !== 'heading') ||
      parent.region.lines.length > 2 ||
      child.region.lines.length > 2 ||
      parent.text.trim().length > 180 ||
      child.text.trim().length > 180 ||
      /[.!?](?:["'’”)\]]*)$/u.test(parent.text.trim()) ||
      /[.!?](?:["'’”)\]]*)$/u.test(child.text.trim())
    ) {
      continue
    }
    const parentOrdinal = numberedHeadingOrdinal(parent.text)
    const childOrdinal = numberedHeadingOrdinal(child.text)
    if (
      !parentOrdinal ||
      !childOrdinal ||
      childOrdinal.length !== parentOrdinal.length + 1 ||
      !parentOrdinal.every(
        (part, partIndex) => childOrdinal[partIndex] === part,
      )
    ) {
      continue
    }
    for (const block of [parent, child]) {
      const largestFont = Math.max(
        ...block.region.lines.map((line) => line.fontSize),
        bodySize,
      )
      block.type = 'heading'
      block.headingLevel = headingLevel(block.text, largestFont, bodySize)
      block.confidence = Math.min(block.confidence, 0.9)
    }
  }
}

function canonicalBlockTargetSourceBoxes(block: RegionBlock | undefined) {
  if (!block) return []
  return [
    ...new Map(
      blockSourceSegments(block).map((segment) => {
        const box = segment.region.box
        return [
          [
            box.page,
            box.x,
            box.y,
            box.width,
            box.height,
            box.rotation,
            box.method,
          ].join(':'),
          { ...box },
        ] as const
      }),
    ).values(),
  ]
}

function canonicalHeadingCrossReferenceTargets(
  blocks: readonly RegionBlock[],
): PdfCanonicalCrossReferenceTarget[] {
  const plainLetteredHeadings = blocks.flatMap((block) => {
    if (block.type !== 'heading') return []
    const match = block.text.trim().match(/^([A-Z])\s+\p{Lu}/u)
    return match ? [{ block, ordinal: match[1].charCodeAt(0) }] : []
  })
  const sequencedPlainLetteredHeadings = new Set<RegionBlock>()
  for (let index = 0; index < plainLetteredHeadings.length - 1; index += 1) {
    const current = plainLetteredHeadings[index]
    const next = plainLetteredHeadings[index + 1]
    if (next.ordinal === current.ordinal + 1) {
      sequencedPlainLetteredHeadings.add(current.block)
      sequencedPlainLetteredHeadings.add(next.block)
    }
  }
  const nestedLetteredParentLabels = new Set(
    blocks.flatMap((block) => {
      if (block.type !== 'heading') return []
      const match = block.text.trim().match(/^([A-Z])\.\d+(?:\.\d+)*\.?\s+\S/u)
      return match ? [match[1]] : []
    }),
  )
  return blocks.flatMap((block) => {
    if (block.type !== 'heading' || !block.nodeId) return []
    const text = block.text.trim()
    const explicitAppendix = text.match(/^appendix\s+([A-Z](?:\.\d+)*)\b/iu)
    const lettered = text.match(/^([A-Z](?:\.\d+)*)\.\s+\S/u)
    const nestedLettered = text.match(/^([A-Z](?:\.\d+)+)\s+\S/u)
    const plainLetteredMatch = text.match(/^([A-Z])\s+\p{Lu}/u)
    const plainLettered =
      plainLetteredMatch &&
      (sequencedPlainLetteredHeadings.has(block) ||
        nestedLetteredParentLabels.has(plainLetteredMatch[1]))
        ? plainLetteredMatch
        : null
    const numbered = text.match(/^(\d+(?:\.\d+)*)\.?\s+\S/u)
    const identifier =
      explicitAppendix?.[1] ??
      lettered?.[1] ??
      nestedLettered?.[1] ??
      plainLettered?.[1]
    const targets: PdfCanonicalCrossReferenceTarget[] = []
    if (numbered?.[1]) {
      targets.push({
        kind: 'section',
        label: `Section ${numbered[1]}`,
        nodeId: block.nodeId,
        evidence: ['canonical-heading-label', 'source-heading-typography'],
        sourceBoxes: canonicalBlockTargetSourceBoxes(block),
      })
    }
    if (identifier) {
      targets.push({
        kind: 'appendix',
        label: `Appendix ${identifier}`,
        nodeId: block.nodeId,
        evidence: ['canonical-heading-label', 'source-heading-typography'],
        sourceBoxes: canonicalBlockTargetSourceBoxes(block),
      })
      if (identifier.includes('.')) {
        targets.push({
          kind: 'section',
          label: `Section ${identifier}`,
          nodeId: block.nodeId,
          evidence: [
            'canonical-appendix-subheading-label',
            'source-heading-typography',
          ],
          sourceBoxes: canonicalBlockTargetSourceBoxes(block),
        })
      }
    }
    return targets
  })
}

function canonicalVisualCrossReferenceTargets(
  relationships: readonly PdfVisualRelationship[],
): PdfCanonicalCrossReferenceTarget[] {
  return relationships.flatMap((relationship) => {
    const parsedLabel = parsePdfScholarlyVisualLabel(relationship.label, {
      context: 'reference',
    })
    if (
      relationship.status !== 'matched' ||
      !relationship.canonicalNodeId ||
      parsedLabel?.status !== 'parsed' ||
      parsedLabel.plural ||
      parsedLabel.kind !== relationship.kind ||
      relationship.label.slice(parsedLabel.consumedEnd).trim().length > 0
    ) {
      return []
    }
    return [
      {
        kind: relationship.kind,
        label: relationship.label,
        nodeId: relationship.canonicalNodeId,
        evidence: [
          'matched-canonical-visual-relationship',
          'source-proved-visual-label',
        ],
        sourceBoxes: relationship.sourceBoxes.map((box) => ({ ...box })),
      },
    ]
  })
}

function canonicalCitationInternalLinkTargets(
  relationships: readonly PdfCitationRelationship[],
  blocks: readonly RegionBlock[],
): PdfCanonicalInternalLinkTarget[] {
  const blocksByNodeId = new Map(
    blocks.flatMap((block) =>
      block.nodeId ? [[block.nodeId, block] as const] : [],
    ),
  )
  return relationships.flatMap((relationship) => {
    if (
      relationship.status !== 'matched' ||
      relationship.labels.length !== relationship.targetNodeIds.length
    ) {
      return []
    }
    return relationship.labels.map((label, index) => ({
      kind: 'reference' as const,
      label: `Reference ${label}`,
      nodeId: relationship.targetNodeIds[index],
      sourceBoxes: canonicalBlockTargetSourceBoxes(
        blocksByNodeId.get(relationship.targetNodeIds[index]),
      ),
    }))
  })
}

function canonicalBibliographyInternalLinkTargets(
  blocks: readonly RegionBlock[],
): PdfCanonicalInternalLinkTarget[] {
  return blocks.flatMap((block) => {
    if (block.list?.numberingId !== 'references' || !block.nodeId) return []
    const label =
      block.list.markerText ??
      (block.list.ordinal === undefined
        ? block.nodeId
        : `${block.list.ordinal}`)
    return [
      {
        kind: 'reference',
        label: `Reference ${label}`,
        nodeId: block.nodeId,
        sourceBoxes: canonicalBlockTargetSourceBoxes(block),
      },
    ]
  })
}

function canonicalNoteInternalLinkTargets(
  blocks: readonly RegionBlock[],
): PdfCanonicalInternalLinkTarget[] {
  return blocks.flatMap((block) => {
    if (block.type !== 'footnote' || !block.nodeId) return []
    return [
      {
        kind: 'note',
        label: `${block.noteKind === 'endnote' ? 'Endnote' : 'Footnote'} ${block.noteLabel ?? block.nodeId}`,
        nodeId: block.nodeId,
        sourceBoxes: canonicalBlockTargetSourceBoxes(block),
      },
    ]
  })
}

function likelyAffiliation(value: string) {
  return (
    /(?:university|institute|department|laborator(?:y|ies)|\blabs?\b|school|college|centre|center|hospital|academy|research (?:group|team)|fellows? program|corporation|\binc\b|compan(?:y|ies)|studios?|technolog(?:y|ies)|@|https?:\/\/)/i.test(
      value,
    ) ||
    /^\s*(?:\d+\s*)?[\p{Lu}\p{N}][\p{Lu}\p{N}*+&.-]{2,}\s+\p{Lu}\p{Ll}[\p{L}.-]*(?:\s+\p{Lu}\p{Ll}[\p{L}.-]*){0,3}\s*$/u.test(
      value,
    )
  )
}

function normalizedAuthorName(value: string) {
  return value
    .replace(/(?:\s*[\d*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+)+\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function likelyPersonName(value: string) {
  const normalized = normalizedAuthorName(value)
  if (!normalized || likelyAffiliation(normalized)) return false
  const words = normalized.split(/\s+/)
  if (words.length < 2 || words.length > 8) return false
  return words.every((word) =>
    /^(?:\p{Lu}[\p{L}'’.-]*|(?:de|del|der|di|du|la|le|van|von))$/u.test(word),
  )
}

function authorNamesFromLine(value: string) {
  const allCapsWithoutListEvidence =
    /\p{Lu}/u.test(value) &&
    !/\p{Ll}/u.test(value) &&
    !/[,;]|\s+(?:and|&)\s+/iu.test(value)
  if (allCapsWithoutListEvidence) return []
  const hasAttachedAffiliationMarkers =
    /(\p{L})\s*[\d*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\s+[\d*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+)*\s+(?=\p{Lu}\p{Ll})/u.test(
      value,
    )
  const separated = value
    .replace(
      /(\p{L})\s*[\d*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\s+[\d*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+)*\s+(?=\p{Lu}\p{Ll})/gu,
      '$1; ',
    )
    .replace(/\s+\d+(?=[A-Z]{2,}\b)/g, '; ')
    .split(/\s+(?:and|&)\s+|\s*[;,]\s*(?:(?:and|&)\s+)?/i)
    .map(normalizedAuthorName)
    .filter(Boolean)
  const names = separated.filter(likelyPersonName)
  if (
    names.length > 0 &&
    (!likelyAffiliation(value) || hasAttachedAffiliationMarkers)
  ) {
    return names
  }
  return likelyPersonName(value) ? [normalizedAuthorName(value)] : []
}

function numberedAffiliationsFromLine(line: PdfPageRegion['lines'][number]) {
  const runs = line.runs.filter((run) => run.text.trim())
  const largestFont = Math.max(...runs.map((run) => run.fontSize), 0)
  const isMarker = (run: (typeof runs)[number], index: number) => {
    if (!/^\d{1,3}(?:,\d{1,3})*$/u.test(run.text.trim())) return false
    if (run.fontSize <= largestFont * 0.82 + 0.01) return true
    const next = runs[index + 1]
    if (!next || /^\d{1,3}(?:,\d{1,3})*$/u.test(next.text.trim())) {
      return false
    }
    const runCenter = run.y + run.height / 2
    const nextCenter = next.y + next.height / 2
    const horizontalGap = next.x - (run.x + run.width)
    return (
      run.fontSize <= next.fontSize * 0.92 + 0.01 &&
      runCenter <= nextCenter - Math.max(0.0005, next.height * 0.18) &&
      horizontalGap >= -0.001 &&
      horizontalGap <= 0.012
    )
  }
  if (runs.length < 2 || !isMarker(runs[0], 0)) return []

  const entries: string[] = []
  let parts: string[] = []
  for (const [index, run] of runs.entries()) {
    if (isMarker(run, index)) {
      if (parts.length > 1) entries.push(parts.join(' ').replace(/\s+/gu, ' '))
      parts = [run.text.trim()]
    } else if (parts.length > 0) {
      parts.push(run.text.trim())
    }
  }
  if (parts.length > 1) entries.push(parts.join(' ').replace(/\s+/gu, ' '))
  return entries.map((entry) => entry.trim()).filter(Boolean)
}

function numberedAffiliationsFromBlock(block: RegionBlock) {
  return block.region.lines.flatMap(numberedAffiliationsFromLine)
}

function markedCollectiveAuthorName(
  line: PdfPageRegion['lines'][number],
  peerAuthorFontSize: number,
) {
  const text = line.text.trim()
  const normalized = normalizedAuthorName(text)
  if (
    peerAuthorFontSize <= 0 ||
    line.fontSize < peerAuthorFontSize * 0.9 ||
    !/[\p{L})]\s*[*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+\s*$/u.test(text) ||
    !/\b(?:collaboration|consortium|collective|research\s+team)\b/iu.test(
      normalized,
    )
  ) {
    return null
  }
  const words = normalized.split(/\s+/u)
  return words.length >= 2 && words.length <= 10 ? normalized : null
}

function authorNamesFromBlock(block: RegionBlock) {
  const names: string[] = []
  let peerAuthorFontSize = 0
  for (const line of block.region.lines) {
    if (
      likelyAffiliation(line.text) ||
      numberedAffiliationsFromLine(line).length > 0
    ) {
      const collective = markedCollectiveAuthorName(line, peerAuthorFontSize)
      if (collective) names.push(collective)
      break
    }
    const lineNames = authorNamesFromLine(line.text)
    const runNames = line.runs.flatMap((run) => authorNamesFromLine(run.text))
    const selectedNames =
      runNames.length > lineNames.length ? runNames : lineNames
    if (selectedNames.length > 0) {
      names.push(...selectedNames)
      peerAuthorFontSize = Math.max(peerAuthorFontSize, line.fontSize)
    }
  }
  return [...new Set(names)]
}

function inferredAuthors(blocks: RegionBlock[]) {
  const firstPage = blocks.filter(
    (block) => block.region.page === 1 && block.region.box.y < 0.32,
  )
  const titleIndex = firstPage.findIndex((block) => block.type === 'heading')
  if (titleIndex < 0) return []
  const candidates: string[] = []
  for (const block of firstPage.slice(titleIndex + 1)) {
    if (block.type === 'heading') break
    if (
      block.type !== 'paragraph' ||
      likelyAffiliation(block.text) ||
      numberedAffiliationsFromBlock(block).length > 0
    ) {
      continue
    }
    candidates.push(...authorNamesFromBlock(block))
  }
  return [...new Set(candidates)]
}

function largestBlockFont(block: RegionBlock) {
  return Math.max(...block.region.lines.map((line) => line.fontSize), 0)
}

function splitLeadingFrontMatterAffiliationFromProse(
  blocks: RegionBlock[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  for (const [blockIndex, block] of [...blocks].entries()) {
    if (
      block.region.page !== 1 ||
      block.type !== 'paragraph' ||
      block.sourceSegments ||
      block.region.lines.length < 3 ||
      block.region.box.y >= 0.45 ||
      !blocks
        .slice(0, blockIndex)
        .some(
          (candidate) =>
            candidate.region.page === 1 &&
            (authorNamesFromBlock(candidate).length > 0 ||
              largestBlockFont(candidate) >= 14),
        )
    ) {
      continue
    }
    const replay = replayPdfRegionLineRanges(
      block.region,
      lineBoundaryDecisions,
    )
    if (!replay || replay.text !== block.text) continue

    let splitIndex = -1
    for (
      let candidateIndex = 1;
      candidateIndex < Math.min(5, block.region.lines.length);
      candidateIndex += 1
    ) {
      const prefixLines = block.region.lines.slice(0, candidateIndex)
      const suffixLines = block.region.lines.slice(candidateIndex)
      const prefixRange = replay.ranges.get(prefixLines[0].id)
      const prefixEndRange = replay.ranges.get(prefixLines.at(-1)!.id)
      const suffixRange = replay.ranges.get(suffixLines[0].id)
      const suffixEndRange = replay.ranges.get(suffixLines.at(-1)!.id)
      if (!prefixRange || !prefixEndRange || !suffixRange || !suffixEndRange) {
        continue
      }
      const prefixText = block.text
        .slice(prefixRange.start, prefixEndRange.end)
        .trim()
      const suffixText = block.text
        .slice(suffixRange.start, suffixEndRange.end)
        .trim()
      const suffixWordCount = suffixText.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
      const suffixSentenceCount =
        suffixText.match(/[.!?](?:\s|$)/gu)?.length ?? 0
      if (
        prefixText.length <= 320 &&
        likelyAffiliation(prefixText) &&
        suffixText.length >= 300 &&
        suffixWordCount >= 40 &&
        suffixSentenceCount >= 2
      ) {
        splitIndex = candidateIndex
        break
      }
    }
    if (splitIndex < 0) continue

    const makeFragment = (
      lines: PdfPageRegion['lines'],
      sourceStart: number,
      sourceEnd: number,
    ): RegionBlock => {
      const text = block.region.text.slice(sourceStart, sourceEnd)
      const evidenceRegion: PdfPageRegion = {
        ...block.region,
        box: boxForRegionLines(lines),
        lines,
        text,
      }
      return {
        ...block,
        region: evidenceRegion,
        text,
        sourceSegments: [
          {
            region: block.region,
            evidenceRegion,
            sourceStart,
            canonicalStart: 0,
            text,
          },
        ],
      }
    }
    const prefixLines = block.region.lines.slice(0, splitIndex)
    const suffixLines = block.region.lines.slice(splitIndex)
    const prefixStart = replay.ranges.get(prefixLines[0].id)!.start
    const prefixEnd = replay.ranges.get(prefixLines.at(-1)!.id)!.end
    const suffixStart = replay.ranges.get(suffixLines[0].id)!.start
    const suffixEnd = replay.ranges.get(suffixLines.at(-1)!.id)!.end
    blocks.splice(
      blockIndex,
      1,
      makeFragment(prefixLines, prefixStart, prefixEnd),
      makeFragment(suffixLines, suffixStart, suffixEnd),
    )
  }
}

function splitFrontMatterAffiliationContact(
  blocks: RegionBlock[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  for (const [blockIndex, block] of [...blocks].entries()) {
    if (
      block.region.page !== 1 ||
      block.type !== 'paragraph' ||
      block.sourceSegments ||
      block.region.lines.length < 2 ||
      block.region.box.y >= 0.35
    ) {
      continue
    }
    const contactLineIndex = block.region.lines.findIndex((line) =>
      /@[\p{L}\p{N}.-]+\.\p{L}{2,}/iu.test(line.text),
    )
    if (contactLineIndex <= 0) continue
    const affiliationLines = block.region.lines.slice(0, contactLineIndex)
    const contactLines = block.region.lines.slice(contactLineIndex)
    if (
      contactLines.some(
        (line) => !/@[\p{L}\p{N}.-]+\.\p{L}{2,}/iu.test(line.text),
      )
    ) {
      continue
    }
    const replay = replayPdfRegionLineRanges(
      block.region,
      lineBoundaryDecisions,
    )
    const affiliationStart = replay?.ranges.get(affiliationLines[0].id)
    const affiliationEnd = replay?.ranges.get(affiliationLines.at(-1)!.id)
    const contactStart = replay?.ranges.get(contactLines[0].id)
    const contactEnd = replay?.ranges.get(contactLines.at(-1)!.id)
    if (
      !replay ||
      replay.text !== block.text ||
      !affiliationStart ||
      !affiliationEnd ||
      !contactStart ||
      !contactEnd
    ) {
      continue
    }
    const affiliationText = block.text
      .slice(affiliationStart.start, affiliationEnd.end)
      .trim()
    const contactText = block.text
      .slice(contactStart.start, contactEnd.end)
      .trim()
    if (
      numberedAffiliationsFromBlock({
        ...block,
        region: {
          ...block.region,
          lines: affiliationLines,
          text: affiliationText,
        },
        text: affiliationText,
      }).length === 0 ||
      !contactText
    ) {
      continue
    }
    const sourceRegion = block.region
    const affiliationRegion: PdfPageRegion = {
      ...sourceRegion,
      box: boxForRegionLines(affiliationLines),
      lines: affiliationLines,
      text: affiliationText,
    }
    const contactEvidenceRegion: PdfPageRegion = {
      ...sourceRegion,
      box: boxForRegionLines(contactLines),
      lines: contactLines,
      text: contactText,
    }
    const contactRegion: PdfPageRegion = {
      ...contactEvidenceRegion,
      id: `${sourceRegion.id}-contact`,
      kind: 'footnote',
      text: `Correspondence to: ${contactText}`,
    }
    blocks.splice(
      blockIndex,
      1,
      {
        ...block,
        region: affiliationRegion,
        text: affiliationText,
        sourceSegments: [
          {
            region: sourceRegion,
            evidenceRegion: affiliationRegion,
            sourceStart: affiliationStart.start,
            canonicalStart: 0,
            text: affiliationText,
          },
        ],
      },
      {
        type: 'footnote',
        region: contactRegion,
        text: contactText,
        confidence: block.confidence,
        noteKind: 'footnote',
        noteLabel: 'Correspondence',
        noteMarkerText: 'Correspondence',
        sourceSegments: [
          {
            region: sourceRegion,
            evidenceRegion: contactEvidenceRegion,
            sourceStart: contactStart.start,
            canonicalStart: 0,
            text: contactText,
          },
        ],
      },
    )
  }
}

function sourceLineEndsSentenceBeforeRaisedNoteMarker(
  line: PdfPageRegion['lines'][number],
) {
  if (/[.!?](?:["'’”)\]]*)$/u.test(line.text.trimEnd())) return true
  const runs = line.runs
    .filter((run) => run.text.trim())
    .sort((left, right) => left.x - right.x)
  const marker = runs.at(-1)
  const prose = runs.at(-2)
  if (
    !marker ||
    !prose ||
    !/^(?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*†‡§]+)$/u.test(marker.text.trim()) ||
    marker.fontSize > prose.fontSize * 0.85
  ) {
    return false
  }
  const markerCenter = marker.y + marker.height / 2
  const proseCenter = prose.y + prose.height / 2
  return (
    markerCenter <
      proseCenter -
        Math.max(0.0005, Math.min(marker.height, prose.height) * 0.08) &&
    /[.!?](?:["'’”)\]]*)$/u.test(prose.text.trimEnd())
  )
}

function splitListItemTailParagraphs(
  blocks: RegionBlock[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  // Split from the end so inserting two fragments cannot invalidate the
  // source indexes of later candidates captured from the original block list.
  for (const [blockIndex, block] of [...blocks.entries()].reverse()) {
    if (
      block.type !== 'paragraph' ||
      block.sourceSegments ||
      block.region.lines.length < 2
    ) {
      continue
    }
    const firstLine = block.region.lines[0]
    const marker =
      parsedOrderedListMarker(firstLine.text) ??
      parsedBulletListMarker(firstLine.text)
    if (!marker) continue
    const firstRuns = firstLine.runs
      .filter((run) => run.text.trim())
      .sort((left, right) => left.x - right.x)
    const markerRunIndex = firstRuns.findIndex(
      (run) => run.text.trim() === marker.markerText,
    )
    const firstContentRun =
      markerRunIndex >= 0 ? firstRuns[markerRunIndex + 1] : undefined
    if (!firstContentRun) continue

    const splitIndex = block.region.lines.findIndex(
      (line, lineIndex, lines) => {
        if (lineIndex === 0) return false
        const previous = lines[lineIndex - 1]
        const verticalGap = line.box.y - (previous.box.y + previous.box.height)
        const paragraphGap = Math.max(
          0.005,
          Math.min(line.box.height, previous.box.height) * 0.4,
        )
        return (
          verticalGap >= paragraphGap &&
          line.box.x <= firstContentRun.x - 0.01 &&
          sourceLineEndsSentenceBeforeRaisedNoteMarker(previous) &&
          /^(?:["'‘“(]\s*)?\p{Lu}/u.test(line.text.trimStart())
        )
      },
    )
    if (splitIndex <= 0) continue

    const replay = replayPdfRegionLineRanges(
      block.region,
      lineBoundaryDecisions,
    )
    const itemLines = block.region.lines.slice(0, splitIndex)
    const tailLines = block.region.lines.slice(splitIndex)
    const itemStart = replay?.ranges.get(itemLines[0].id)
    const itemEnd = replay?.ranges.get(itemLines.at(-1)!.id)
    const tailStart = replay?.ranges.get(tailLines[0].id)
    const tailEnd = replay?.ranges.get(tailLines.at(-1)!.id)
    if (
      !replay ||
      replay.text !== block.text ||
      !itemStart ||
      !itemEnd ||
      !tailStart ||
      !tailEnd
    ) {
      continue
    }
    const sourceRegion = block.region
    const fragment = (
      lines: PdfPageRegion['lines'],
      start: number,
      end: number,
    ): RegionBlock => {
      const text = block.text.slice(start, end)
      const evidenceRegion: PdfPageRegion = {
        ...sourceRegion,
        box: boxForRegionLines(lines),
        lines,
        text,
      }
      return {
        ...block,
        region: evidenceRegion,
        text,
        sourceSegments: [
          {
            region: sourceRegion,
            evidenceRegion,
            sourceStart: start,
            canonicalStart: 0,
            text,
          },
        ],
      }
    }
    blocks.splice(
      blockIndex,
      1,
      fragment(itemLines, itemStart.start, itemEnd.end),
      fragment(tailLines, tailStart.start, tailEnd.end),
    )
  }
}

function inferredUnlabelledAbstractBlocks(
  firstPage: RegionBlock[],
  visibleMetadataTitleBlocks: RegionBlock[],
) {
  const boundaryIndex = firstPage.findIndex((block, index) => {
    if (index === 0) return false
    const text = block.text.trim()
    return (
      /^(?:CCS\s+Concepts?|Additional\s+Key\s+Words(?:\s+and\s+Phrases)?|Key\s*words?|Index\s+Terms?|Categories\s+and\s+Subject\s+Descriptors|ACM\s+Reference\s+Format)\b/iu.test(
        text,
      ) || /^(?:\d+(?:\.\d+){0,3}|[IVXLCDM]+)[.)]?\s+\p{L}/iu.test(text)
    )
  })
  if (boundaryIndex < 0) return []

  const compactMetadataIndexes = firstPage.flatMap((block, index) => {
    if (index >= boundaryIndex) return []
    const compact =
      block.text.trim().length <= 320 && block.region.lines.length <= 4
    return visibleMetadataTitleBlocks.includes(block) ||
      authorNamesFromBlock(block).length > 0 ||
      (compact &&
        (likelyAffiliation(block.text) ||
          numberedAffiliationsFromBlock(block).length > 0))
      ? [index]
      : []
  })
  const candidateStart = (compactMetadataIndexes.at(-1) ?? -1) + 1
  if (candidateStart >= boundaryIndex) return []

  const candidates = firstPage
    .slice(candidateStart, boundaryIndex)
    .filter(
      (block) =>
        block.type === 'paragraph' &&
        !/^(?:authors?['’]?\s+address|permission\s+to|copyright|©|doi\b|https?:\/\/doi\.org)\b/iu.test(
          block.text.trim(),
        ),
    )
  const candidateText = candidates
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
  const wordCount = candidateText.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
  const sentenceCount = candidateText.match(/[.!?](?:\s|$)/gu)?.length ?? 0
  return candidateText.length >= 300 && wordCount >= 40 && sentenceCount >= 2
    ? candidates
    : []
}

function classifyFrontMatter(
  blocks: RegionBlock[],
  metadataTitle: string | undefined,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  splitLeadingFrontMatterAffiliationFromProse(blocks, lineBoundaryDecisions)
  splitFrontMatterAffiliationContact(blocks, lineBoundaryDecisions)
  const firstPage = blocks.filter((block) => block.region.page === 1)
  const comparableTitle = (value: string) =>
    value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const comparableMetadataTitle = metadataTitle
    ? comparableTitle(metadataTitle)
    : undefined
  const matchingMetadataTitleBlocks = (candidates: RegionBlock[]) => {
    if (!comparableMetadataTitle) return []
    for (let start = 0; start < candidates.length; start += 1) {
      let visible = ''
      for (
        let end = start;
        end < candidates.length && end < start + 4;
        end += 1
      ) {
        visible = [visible, candidates[end].text].filter(Boolean).join(' ')
        const comparableVisible = comparableTitle(visible)
        if (comparableVisible === comparableMetadataTitle) {
          return candidates.slice(start, end + 1)
        }
        if (!comparableMetadataTitle.startsWith(comparableVisible)) break
      }
    }
    return []
  }
  const visibleMetadataTitleBlocks = matchingMetadataTitleBlocks(firstPage)
  const abstractIndex = firstPage.findIndex((block) =>
    /^abstract(?:\s*[:.—-]|\s|$)/i.test(block.text.trim()),
  )
  const inferredAbstractBlocks =
    abstractIndex < 0
      ? inferredUnlabelledAbstractBlocks(firstPage, visibleMetadataTitleBlocks)
      : []
  const inferredAbstractBlockSet = new Set(inferredAbstractBlocks)
  const hasTitlePageEvidence =
    abstractIndex >= 0 ||
    inferredAbstractBlocks.length > 0 ||
    visibleMetadataTitleBlocks.length > 0 ||
    (firstPage.some(
      (block) =>
        block.region.box.y < 0.32 &&
        (likelyAffiliation(block.text) ||
          numberedAffiliationsFromBlock(block).length > 0),
    ) &&
      firstPage.some(
        (block) => block.region.box.y < 0.2 && largestBlockFont(block) >= 14,
      ))
  if (!hasTitlePageEvidence) {
    return {
      detected: false,
      title: undefined,
      authors: [],
      affiliations: [],
      abstract: '',
      inferredAbstract: false,
    }
  }
  const abstractBlock =
    abstractIndex >= 0 ? firstPage[abstractIndex] : undefined
  const beforeAbstract = abstractBlock
    ? firstPage.filter(
        (block) =>
          block !== abstractBlock &&
          block.region.box.y + block.region.box.height <=
            abstractBlock.region.box.y + 0.01,
      )
    : firstPage.filter((block) => block.region.box.y < 0.32)
  const metadataTitleBlocks = matchingMetadataTitleBlocks(beforeAbstract)
  const metadataTitleBlock = metadataTitleBlocks[0]
  const titleBlock =
    metadataTitleBlock ??
    [...beforeAbstract]
      .filter(
        (block) =>
          !inferredAbstractBlockSet.has(block) &&
          !likelyAffiliation(block.text) &&
          numberedAffiliationsFromBlock(block).length === 0,
      )
      .sort(
        (left, right) =>
          largestBlockFont(right) - largestBlockFont(left) ||
          left.region.box.y - right.region.box.y,
      )[0]
  const titleBlocks = new Set(metadataTitleBlocks)
  if (titleBlock) titleBlocks.add(titleBlock)
  for (const block of titleBlocks) block.frontMatterRole = 'title'

  const titleFont = titleBlock ? largestBlockFont(titleBlock) : 0
  for (const block of beforeAbstract) {
    if (titleBlocks.has(block)) continue
    if (block.type === 'footnote' && block.noteLabel === 'Correspondence') {
      continue
    }
    if (inferredAbstractBlockSet.has(block)) {
      block.frontMatterRole = 'abstract-body'
      continue
    }
    const alignedWithTitle = Boolean(
      titleBlock &&
      (Math.abs(block.region.box.x - titleBlock.region.box.x) <= 0.025 ||
        Math.abs(
          block.region.box.x +
            block.region.box.width / 2 -
            (titleBlock.region.box.x + titleBlock.region.box.width / 2),
        ) <= 0.035),
    )
    const strongTitleContinuation = Boolean(
      titleBlock &&
      block.region.box.y > titleBlock.region.box.y &&
      !/^\p{L}$/u.test(block.text.trim()) &&
      !likelyAffiliation(block.text) &&
      numberedAffiliationsFromBlock(block).length === 0 &&
      authorNamesFromBlock(block).length === 0 &&
      alignedWithTitle &&
      largestBlockFont(block) >= titleFont * 0.72 &&
      block.region.box.y < 0.32,
    )
    if (strongTitleContinuation) {
      block.frontMatterRole = 'title'
    } else if (authorNamesFromBlock(block).length > 0) {
      block.frontMatterRole = 'author'
    } else if (
      likelyAffiliation(block.text) ||
      numberedAffiliationsFromBlock(block).length > 0
    ) {
      block.frontMatterRole = 'affiliation'
    }
  }

  let abstractText = inferredAbstractBlocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
  if (abstractBlock) {
    const inlineAbstract = abstractBlock.text
      .trim()
      .match(/^abstract\s*[:.—-]?\s+(.+)$/i)?.[1]
    abstractBlock.frontMatterRole = inlineAbstract
      ? 'abstract-body'
      : 'abstract-heading'
    if (inlineAbstract) abstractText = inlineAbstract.trim()
    for (const block of firstPage.slice(abstractIndex + 1)) {
      if (block.region.box.y <= abstractBlock.region.box.y) continue
      const overlap = Math.max(
        0,
        Math.min(
          block.region.box.x + block.region.box.width,
          abstractBlock.region.box.x + abstractBlock.region.box.width,
        ) - Math.max(block.region.box.x, abstractBlock.region.box.x),
      )
      if (
        overlap <
        Math.min(block.region.box.width, abstractBlock.region.box.width) * 0.5
      ) {
        continue
      }
      if (block.type === 'heading') break
      block.frontMatterRole = 'abstract-body'
      abstractText = [abstractText, block.text].filter(Boolean).join(' ')
    }
  }

  const inferredTitle = beforeAbstract
    .filter((block) => block.frontMatterRole === 'title')
    .sort(
      (left, right) =>
        left.region.page - right.region.page ||
        left.region.box.y - right.region.box.y ||
        left.region.box.x - right.region.box.x,
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
  // A matching metadata title corroborates identity, but it is not a
  // typography authority. PDF document properties commonly flatten authored
  // dashes and apostrophes, so retain the exact visible source text whenever
  // the title page supplied it.
  const title =
    inferredTitle || metadataTitle?.trim().replace(/\s+/g, ' ') || undefined
  const authors = beforeAbstract.flatMap((block) =>
    block.frontMatterRole === 'author' ? authorNamesFromBlock(block) : [],
  )
  const affiliations = beforeAbstract.flatMap((block) =>
    block.frontMatterRole === 'author' ||
    block.frontMatterRole === 'affiliation'
      ? (() => {
          const numbered = numberedAffiliationsFromBlock(block)
          if (numbered.length > 0) return numbered
          const collectiveAuthors = new Set(authorNamesFromBlock(block))
          const lines = block.region.lines
            .map((line) => line.text.trim())
            .filter(
              (line) =>
                line &&
                likelyAffiliation(line) &&
                !collectiveAuthors.has(normalizedAuthorName(line)),
            )
          return lines.length > 0
            ? lines
            : block.frontMatterRole === 'affiliation'
              ? [block.text.trim()]
              : []
        })()
      : [],
  )
  return {
    detected: true,
    title,
    authors: [...new Set(authors)],
    affiliations: [...new Set(affiliations)],
    abstract: abstractText.trim(),
    inferredAbstract: inferredAbstractBlocks.length > 0,
  }
}

function validDate(value?: string) {
  if (!value) return '1970-01-01'
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf())
    ? '1970-01-01'
    : parsed.toISOString().slice(0, 10)
}

function validArtifactModifiedAt(value?: string) {
  if (!value) return '1970-01-01T00:00:00.000Z'
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf())
    ? '1970-01-01T00:00:00.000Z'
    : parsed.toISOString()
}

const OCR_LANGUAGE_TAGS: Readonly<Record<string, string>> = {
  ara: 'ar',
  ben: 'bn',
  ces: 'cs',
  chi_sim: 'zh-Hans',
  chi_tra: 'zh-Hant',
  cze: 'cs',
  deu: 'de',
  div: 'dv',
  dut: 'nl',
  ell: 'el',
  eng: 'en',
  fas: 'fa',
  fra: 'fr',
  fre: 'fr',
  ger: 'de',
  gre: 'el',
  heb: 'he',
  hin: 'hi',
  ind: 'id',
  ita: 'it',
  jpn: 'ja',
  kor: 'ko',
  may: 'ms',
  msa: 'ms',
  nld: 'nl',
  per: 'fa',
  pol: 'pl',
  por: 'pt',
  pus: 'ps',
  rus: 'ru',
  snd: 'sd',
  spa: 'es',
  syr: 'syr',
  tam: 'ta',
  tel: 'te',
  tha: 'th',
  tur: 'tr',
  uig: 'ug',
  ukr: 'uk',
  urd: 'ur',
  vie: 'vi',
  yid: 'yi',
  zho: 'zh',
}

function canonicalOcrLanguageTag(value: string) {
  const normalized = value.trim().replace(/_/g, '_').toLocaleLowerCase()
  const mapped = OCR_LANGUAGE_TAGS[normalized]
  if (mapped) return mapped
  if (
    normalized !== 'und' &&
    !/^[a-z]{2}(?:-[a-z0-9]{2,8})*$/i.test(value.trim())
  ) {
    return null
  }
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? null
  } catch {
    return null
  }
}

function rtlLanguage(tag: string) {
  const locale = new Intl.Locale(tag)
  const script = locale.script
  if (
    script &&
    ['Arab', 'Hebr', 'Syrc', 'Thaa', 'Nkoo', 'Adlm'].includes(script)
  ) {
    return true
  }
  return [
    'ar',
    'dv',
    'fa',
    'he',
    'ks',
    'ku',
    'ps',
    'sd',
    'syr',
    'ug',
    'ur',
    'yi',
  ].includes(locale.language)
}

const RTL_STRONG_SCRIPT =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u

function strongScriptDirection(pages: readonly PdfPageAnalysis[]) {
  const letters = pages
    .flatMap((page) => page.runs)
    .flatMap((run) => run.text.match(/\p{Letter}/gu) ?? [])
  const rtlCount = letters.filter((character) =>
    RTL_STRONG_SCRIPT.test(character),
  ).length
  const otherStrongCount = letters.length - rtlCount
  return {
    value:
      rtlCount > 0 && otherStrongCount === 0
        ? ('rtl' as const)
        : ('unknown' as const),
    observedDirection:
      rtlCount > 0 && otherStrongCount === 0
        ? ('rtl' as const)
        : otherStrongCount > 0 && rtlCount === 0
          ? ('ltr' as const)
          : ('unknown' as const),
    rtlCount,
    otherStrongCount,
  }
}

function pdfPublicationMetadata(
  pages: readonly PdfPageAnalysis[],
  metadata: PdfDocumentMetadata,
): Pick<
  ResearchPaper,
  'language' | 'baseDirection' | 'artifactModifiedAt' | 'metadataLineage'
> {
  const explicitTokens = pages.flatMap((page) =>
    page.ocr?.languageMode === 'explicit'
      ? page.ocr.languages.flatMap((language) =>
          language
            .split('+')
            .map((candidate) => candidate.trim())
            .filter(Boolean),
        )
      : [],
  )
  const normalizedTokens = explicitTokens.map((token) => ({
    token,
    tag: canonicalOcrLanguageTag(token),
  }))
  const invalidTokens = normalizedTokens.filter(({ tag }) => tag === null)
  const languageCandidates = [
    ...new Set(
      normalizedTokens.flatMap(({ tag }) =>
        tag && tag !== 'und' ? [tag] : [],
      ),
    ),
  ]
  const textLanguageInference =
    explicitTokens.length === 0
      ? inferPublicationLanguageFromPdfText(pages)
      : null
  const candidateLanguage =
    explicitTokens.length > 0 &&
    invalidTokens.length === 0 &&
    languageCandidates.length === 1
      ? languageCandidates[0]
      : explicitTokens.length === 0 && textLanguageInference
        ? textLanguageInference.tag
        : 'und'
  const scriptDirection = strongScriptDirection(pages)
  const languageScriptConflict =
    candidateLanguage !== 'und' &&
    scriptDirection.observedDirection !== 'unknown' &&
    (rtlLanguage(candidateLanguage) ? 'rtl' : 'ltr') !==
      scriptDirection.observedDirection
  const language = languageScriptConflict ? 'und' : candidateLanguage
  const languageProven = language !== 'und'
  const hasAutomaticOcr = pages.some(
    (page) => page.ocr?.languageMode === 'automatic-fallback',
  )
  const languageEvidence = languageScriptConflict
    ? [
        `ocr-language-script-conflict:${candidateLanguage}:${scriptDirection.observedDirection}`,
      ]
    : languageProven
      ? explicitTokens.length > 0
        ? [
            ...new Set(
              normalizedTokens.map(
                ({ token, tag }) => `ocr-language:${token}->${tag}`,
              ),
            ),
          ]
        : [textLanguageInference!.evidence]
      : invalidTokens.length > 0
        ? invalidTokens.map(
            ({ token }) => `invalid-ocr-language-candidate:${token}`,
          )
        : languageCandidates.length > 1
          ? [
              `mixed-or-conflicting-ocr-language-candidates:${languageCandidates.join(',')}`,
            ]
          : hasAutomaticOcr
            ? ['automatic-ocr-language-is-not-publication-authority']
            : ['no-authoritative-publication-language']

  const explicitLanguageConflict = explicitTokens.length > 0 && !languageProven
  const baseDirection = languageProven
    ? rtlLanguage(language)
      ? ('rtl' as const)
      : ('ltr' as const)
    : !explicitLanguageConflict && scriptDirection.value === 'rtl'
      ? ('rtl' as const)
      : ('unknown' as const)
  const directionProven = baseDirection !== 'unknown'
  const artifactModifiedAt = validArtifactModifiedAt(metadata.modified)
  const artifactSource =
    metadata.modifiedSource ??
    (metadata.modified ? 'pdf-info-mod-date' : 'unproven')
  const artifactProven = artifactSource !== 'unproven'

  return {
    language,
    baseDirection,
    artifactModifiedAt,
    metadataLineage: {
      language: {
        status: languageProven ? 'proven' : 'unresolved',
        source: languageProven
          ? explicitTokens.length > 0
            ? 'pdf-ocr-explicit'
            : 'pdf-text-language-inference'
          : 'unproven',
        evidence: languageEvidence,
      },
      baseDirection: {
        status: directionProven ? 'proven' : 'unresolved',
        source: languageProven
          ? 'publication-language'
          : directionProven
            ? 'pdf-strong-script'
            : 'unproven',
        evidence: languageProven
          ? [`language:${language}`]
          : directionProven
            ? [`strong-rtl-script-only:${scriptDirection.rtlCount}`]
            : explicitLanguageConflict
              ? ['mixed-or-invalid-explicit-ocr-language']
              : scriptDirection.rtlCount > 0 &&
                  scriptDirection.otherStrongCount > 0
                ? [
                    `mixed-strong-script-directions:rtl=${scriptDirection.rtlCount},other=${scriptDirection.otherStrongCount}`,
                  ]
                : ['no-authoritative-base-direction'],
      },
      publicationDate: {
        status: 'unresolved',
        source: 'pdf-xmp-not-extracted',
        evidence: ['pdf-xmp-metadata-not-extracted'],
      },
      artifactModifiedAt: {
        status: artifactProven ? 'proven' : 'unresolved',
        source: artifactSource,
        evidence: [
          artifactSource === 'pdf-info-mod-date'
            ? 'pdf-info:ModDate'
            : artifactSource === 'file-last-modified'
              ? 'file:lastModified'
              : 'artifact-modified-time-unavailable',
        ],
      },
    },
  }
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

function visualCanonicalNodeId(
  relationship: PdfVisualRelationship,
  page: number,
) {
  const sourceAnchor =
    relationship.sourceObjectIds[0] ??
    relationship.sourceRegionIds[0] ??
    relationship.captionRegionId
  return [
    'visual',
    relationship.kind,
    `p${String(page).padStart(3, '0')}`,
    slug(relationship.label, 24),
    slug(sourceAnchor, 40),
    slug(relationship.id, 32),
  ].join('-')
}

function assertUniqueCanonicalNodeIds(nodes: ResearchNode[]) {
  const seen = new Set<string>()
  for (const node of nodes) {
    if (seen.has(node.id)) {
      throw new Error('PDF canonical node ids must be globally unique.')
    }
    seen.add(node.id)
  }
}

function isIsolatedProseGlyph(block: RegionBlock) {
  return (
    (block.type === 'paragraph' || block.type === 'heading') &&
    /^\p{L}$/u.test(block.text.trim())
  )
}

function noteText(region: PdfPageRegion, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const independentlyRunBackedMarker =
    normalizedNoteLabel(
      region.lines[0]?.runs.find((run) => run.text.trim())?.text ?? '',
    ) === label
  if (
    independentlyRunBackedMarker &&
    normalizedNoteLabel(region.text).startsWith(label)
  ) {
    return normalizedNoteLabel(region.text).slice(label.length).trim()
  }
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

function noteMarkerText(region: PdfPageRegion, label: string) {
  const marker = region.text
    .trim()
    .match(
      /^(?:(?:footnote|note)\s+)?(?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*∗†‡§])(?:\s*[:.)\]-])?/iu,
    )?.[0]
    ?.trim()
  return marker && normalizedNoteLabel(marker).includes(label) ? marker : label
}

function exactCanonicalSubtextSourceSegment(
  region: PdfPageRegion,
  canonicalText: string,
) {
  const directStart = region.text.indexOf(canonicalText)
  const leadingWhitespace = region.text.length - region.text.trimStart().length
  const normalizedStart =
    directStart >= 0
      ? directStart
      : normalizedNoteLabel(region.text).indexOf(canonicalText)
  const sourceStart =
    directStart >= 0
      ? directStart
      : normalizedStart >= 0
        ? leadingWhitespace + normalizedStart
        : -1
  if (
    sourceStart < 0 ||
    sourceStart + canonicalText.length > region.text.length
  ) {
    return undefined
  }
  return [
    {
      region,
      sourceStart,
      canonicalStart: 0,
      text: canonicalText,
    },
  ]
}

function romanOrdinal(value: string) {
  const digits: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
    l: 50,
    c: 100,
    d: 500,
    m: 1000,
  }
  const normalized = value.toLocaleLowerCase()
  let total = 0
  for (let index = 0; index < normalized.length; index += 1) {
    const current = digits[normalized[index]] ?? 0
    const next = digits[normalized[index + 1]] ?? 0
    total += current < next ? -current : current
  }
  return Math.max(total, 1)
}

function validRomanNumeral(value: string) {
  return /^(?:M{0,3})(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/iu.test(
    value,
  )
}

function orderedMarker(marker: string) {
  if (/^\d+$/.test(marker)) {
    return { markerStyle: 'decimal' as const, ordinal: Number(marker) }
  }
  if (/^[ivxlcdm]+$/i.test(marker)) {
    return {
      markerStyle: (marker === marker.toLocaleUpperCase()
        ? 'upper-roman'
        : 'lower-roman') as 'upper-roman' | 'lower-roman',
      ordinal: romanOrdinal(marker),
    }
  }
  return {
    markerStyle: (marker === marker.toLocaleUpperCase()
      ? 'upper-alpha'
      : 'lower-alpha') as 'upper-alpha' | 'lower-alpha',
    ordinal: marker.toLocaleLowerCase().charCodeAt(0) - 96,
  }
}

function parsedOrderedListMarker(value: string) {
  const trimmed = value.trimStart()
  const match = trimmed.match(
    /^(?:(\[\s*(\d+)\s*\])|(\(\s*(\d+|[A-Za-z]|[ivxlcdm]+)\s*\))|((\d+|[A-Za-z]|[ivxlcdm]+)[.)]))\s+(.+)$/i,
  )
  if (!match) return null
  const markerText = match[1] ?? match[3] ?? match[5]
  const marker = match[2] ?? match[4] ?? match[6]
  if (/^\d{4}$/.test(marker) && Number(marker) >= 1800) return null
  if (/^[ivxlcdm]{2,}$/iu.test(marker) && !validRomanNumeral(marker)) {
    return null
  }
  return {
    markerText,
    itemText: match[7],
    contentStart:
      value.length - trimmed.length + match[0].length - match[7].length,
    ...orderedMarker(marker),
  }
}

function ambiguousParenthesizedRomanListMarker(
  marker: ReturnType<typeof parsedOrderedListMarker>,
) {
  return Boolean(
    marker &&
    marker.markerStyle === 'lower-roman' &&
    /^\(\s*[ivxlcdm]+\s*\)$/iu.test(marker.markerText),
  )
}

function parenthesizedDecimalOrdinals(value: string) {
  return [...value.matchAll(/\(\s*(\d{1,3})\s*\)/gu)].map((match) =>
    Number(match[1]),
  )
}

function suffixedDecimalOrdinals(value: string) {
  return [...value.matchAll(/(?:^|\s)(\d{1,3})\)(?=\s)/gu)].map((match) =>
    Number(match[1]),
  )
}

function alignedParagraphSourceFlow(
  preceding: RegionBlock,
  continuation: RegionBlock,
) {
  if (
    preceding.region.page !== continuation.region.page ||
    preceding.region.column !== continuation.region.column
  ) {
    return false
  }
  const precedingTail = preceding.region.lines.at(-1)
  const continuationHead = continuation.region.lines[0]
  if (!precedingTail || !continuationHead) return false
  const verticalGap =
    continuationHead.box.y - (precedingTail.box.y + precedingTail.box.height)
  return (
    Math.abs(continuationHead.box.x - precedingTail.box.x) <= 0.012 &&
    verticalGap >= -0.006 &&
    verticalGap <= 0.021 &&
    Math.abs(continuationHead.fontSize - precedingTail.fontSize) <=
      Math.max(0.5, precedingTail.fontSize * 0.08)
  )
}

function flowingParenthesizedDecimalEnumerationContinuation(
  preceding: RegionBlock | undefined,
  continuation: RegionBlock,
  marker: ReturnType<typeof parsedOrderedListMarker>,
) {
  if (
    !preceding ||
    preceding.type !== 'paragraph' ||
    preceding.list ||
    !marker ||
    marker.markerStyle !== 'decimal' ||
    !/^\(\s*\d{1,3}\s*\)$/u.test(marker.markerText) ||
    !alignedParagraphSourceFlow(preceding, continuation)
  ) {
    return false
  }

  const precedingOrdinals = parenthesizedDecimalOrdinals(preceding.text)
  const continuationOrdinals = parenthesizedDecimalOrdinals(continuation.text)
  return (
    precedingOrdinals.includes(marker.ordinal - 1) &&
    continuationOrdinals[0] === marker.ordinal &&
    continuationOrdinals.includes(marker.ordinal + 1)
  )
}

function flowingSuffixedDecimalEnumerationContinuation(
  preceding: RegionBlock | undefined,
  continuation: RegionBlock,
  marker: ReturnType<typeof parsedOrderedListMarker>,
) {
  if (
    !preceding ||
    preceding.type !== 'paragraph' ||
    preceding.list ||
    !marker ||
    marker.markerStyle !== 'decimal' ||
    !/^\d{1,3}\)$/u.test(marker.markerText) ||
    !alignedParagraphSourceFlow(preceding, continuation) ||
    !/(?:\bor|\band|[,;:])\s*$/iu.test(preceding.text)
  ) {
    return false
  }
  return suffixedDecimalOrdinals(preceding.text).includes(marker.ordinal - 1)
}

function flowingSentenceFinalMathVariableContinuation(
  preceding: RegionBlock | undefined,
  continuation: RegionBlock,
  marker: ReturnType<typeof parsedOrderedListMarker>,
) {
  if (
    !preceding ||
    preceding.type !== 'paragraph' ||
    preceding.list ||
    !marker ||
    !/^[A-Z]\.$/u.test(marker.markerText) ||
    /[.!?;:]\s*$/u.test(preceding.text) ||
    !alignedParagraphSourceFlow(preceding, continuation)
  ) {
    return false
  }
  const runs = continuation.region.lines[0]?.runs.filter((run) =>
    run.text.trim(),
  )
  const variable = runs?.[0]
  const prose = runs?.[1]
  const sourceVariable = marker.markerText.slice(0, -1)
  return Boolean(
    variable &&
    prose &&
    variable.text.trim() === sourceVariable &&
    (variable.italic || /(?:CMMI|math|symbol)/iu.test(variable.fontName)) &&
    /^\.\p{Lu}\p{Ll}+/u.test(prose.text.trimStart()),
  )
}

function parsedBibliographyListMarker(value: string) {
  const trimmed = value.trimStart()
  const match = trimmed.match(
    /^(?:(\[\s*(\d{1,4})\s*\])|(\(\s*(\d{1,4})\s*\))|((\d{1,3})[.)]))\s+(.+)$/u,
  )
  if (!match) return null
  const markerText = match[1] ?? match[3] ?? match[5]
  const marker = match[2] ?? match[4] ?? match[6]
  if (/^\d{4}$/u.test(marker) && Number(marker) >= 1800) return null
  if (Number(marker) === 0) return null
  return {
    label: marker,
    markerText,
    itemText: match[7],
    contentStart:
      value.length - trimmed.length + match[0].length - match[7].length,
    markerStyle: 'decimal' as const,
    ordinal: Number(marker),
  }
}

export type RecoveredBibliographyClassificationBlock = {
  region: PdfPageRegion
  list?: {
    numberingId: string
    ordinal?: number
    markerText?: string
  }
  sourceSegments?: Array<{
    region: PdfPageRegion
    evidenceRegion?: PdfPageRegion
    sourceStart: number
    canonicalStart: number
    text: string
  }>
}

export function synthesizeRecoveredBibliographyClassifications(
  classifications: readonly PdfNoteMarkerClassification[],
  blocks: readonly RecoveredBibliographyClassificationBlock[],
) {
  const recovered = [...classifications]
  const classifiedLabels = new Set(
    classifications
      .filter(
        (classification) => classification.taxonomy === 'bibliography-entry',
      )
      .map(
        (classification) =>
          `${classification.referenceRegionId}:${normalizedNoteLabel(classification.label)}`,
      ),
  )
  const usedIds = new Set(
    classifications.map((classification) => classification.id),
  )

  for (const block of blocks) {
    if (
      block.list?.numberingId !== 'references' ||
      block.list.ordinal === undefined ||
      !block.list.markerText
    ) {
      continue
    }
    const firstSegment = block.sourceSegments?.find(
      (segment) => segment.canonicalStart === 0,
    )
    if (!firstSegment) continue
    const evidenceRegion = firstSegment.evidenceRegion ?? firstSegment.region
    const marker = parsedBibliographyListMarker(evidenceRegion.text)
    if (
      !marker ||
      marker.ordinal !== block.list.ordinal ||
      marker.markerText !== block.list.markerText
    ) {
      continue
    }
    const labelKey = `${firstSegment.region.id}:${normalizedNoteLabel(marker.label)}`
    if (classifiedLabels.has(labelKey)) continue

    const markerOffset = evidenceRegion.text.indexOf(marker.markerText)
    const evidenceSourceStart = firstSegment.sourceStart - marker.contentStart
    const start = evidenceSourceStart + markerOffset
    const end = start + marker.markerText.length
    if (
      markerOffset < 0 ||
      start < 0 ||
      firstSegment.region.text.slice(start, end) !== marker.markerText
    ) {
      continue
    }

    const idBase = `noteref-p${String(firstSegment.region.page).padStart(3, '0')}-${slug(marker.label, 16)}-${slug(firstSegment.region.id, 48)}-s${String(start).padStart(6, '0')}-e${String(end).padStart(6, '0')}`
    let occurrence = 1
    let id = `${idBase}-${String(occurrence).padStart(3, '0')}`
    while (usedIds.has(id)) {
      occurrence += 1
      id = `${idBase}-${String(occurrence).padStart(3, '0')}`
    }
    usedIds.add(id)
    classifiedLabels.add(labelKey)
    recovered.push({
      id,
      label: marker.label,
      referenceRegionId: firstSegment.region.id,
      start,
      end,
      taxonomy: 'bibliography-entry',
      disposition: 'plain-text',
      confidence: 0.99,
      threshold: PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
      accepted: true,
      evidence: [
        'source-backed-bibliography-marker',
        'recovered-bibliography-entry',
        'reference-list-section-scope',
      ],
      sourceBox: { ...evidenceRegion.box },
    })
  }

  return recovered
}

function parsedBulletListMarker(value: string) {
  const trimmed = value.trimStart()
  const match = trimmed.match(/^([•◦▪‣–—-])\s+(.+)$/u)
  return match
    ? {
        markerText: match[1],
        itemText: match[2],
        contentStart:
          value.length - trimmed.length + match[0].length - match[2].length,
      }
    : null
}

function blockSourceSegments(block: RegionBlock) {
  return (
    block.sourceSegments ?? [
      {
        region: block.region,
        sourceStart: 0,
        canonicalStart: 0,
        text: block.text,
      },
    ]
  )
}

function stripBlockMarker(
  block: RegionBlock,
  marker: { itemText: string; contentStart: number },
) {
  const text = marker.itemText.trim()
  const contentEnd = marker.contentStart + text.length
  const existingSegments = blockSourceSegments(block)
  block.text = text
  block.sourceSegments = existingSegments.flatMap((segment) => {
    const segmentEnd = segment.canonicalStart + segment.text.length
    const overlapStart = Math.max(marker.contentStart, segment.canonicalStart)
    const overlapEnd = Math.min(contentEnd, segmentEnd)
    if (overlapStart >= overlapEnd) return []
    const relativeStart = overlapStart - segment.canonicalStart
    const relativeEnd = overlapEnd - segment.canonicalStart
    return [
      {
        region: segment.region,
        ...(segment.evidenceRegion
          ? { evidenceRegion: segment.evidenceRegion }
          : {}),
        sourceStart: segment.sourceStart + relativeStart,
        canonicalStart: overlapStart - marker.contentStart,
        text: segment.text.slice(relativeStart, relativeEnd),
      },
    ]
  })
}

function appendBlockContinuation(
  target: RegionBlock,
  continuation: RegionBlock,
  requestedSeparator = target.text ? ' ' : '',
  removeTrailingDiscretionaryHyphen = false,
) {
  const targetTailLine = blockSourceSegments(target).at(-1)?.region.lines.at(-1)
  const continuationHeadLine =
    blockSourceSegments(continuation)[0]?.region.lines[0]
  const linkedTokenContinuities =
    targetTailLine && continuationHeadLine
      ? resolveRegisteredPdfLinkedTokenContinuity([
          targetTailLine,
          continuationHeadLine,
        ])
      : []
  const linkedTargetPrefix =
    linkedTokenContinuities.length === 1 &&
    linkedTokenContinuities[0].status === 'unresolved' &&
    linkedTokenContinuities[0].reason === 'url-round-trip-failed' &&
    linkedTokenContinuities[0].visibleText.startsWith(
      linkedTokenContinuities[0].target,
    ) &&
    /^[,.;:!?)}\]\s]/u.test(
      linkedTokenContinuities[0].visibleText.slice(
        linkedTokenContinuities[0].target.length,
      ),
    )
  const separator =
    (linkedTokenContinuities.length === 1 &&
      linkedTokenContinuities[0].status === 'matched') ||
    linkedTargetPrefix
      ? ''
      : requestedSeparator
  const targetSegments = blockSourceSegments(target).map((segment) => ({
    ...segment,
  }))
  let targetText = target.text
  if (
    removeTrailingDiscretionaryHyphen &&
    /[-‐‑]$/u.test(targetText) &&
    /[-‐‑]$/u.test(targetSegments.at(-1)?.text ?? '')
  ) {
    targetText = targetText.slice(0, -1)
    const tail = targetSegments.at(-1)!
    tail.text = tail.text.slice(0, -1)
  }
  const previousMaximumPage = Math.max(
    ...targetSegments.map((segment) => segment.region.page),
  )
  const canonicalStart = targetText.length + separator.length
  target.sourceSegments = [
    ...targetSegments,
    ...blockSourceSegments(continuation).map((segment) => ({
      ...segment,
      canonicalStart: canonicalStart + segment.canonicalStart,
    })),
  ]
  target.text = `${targetText}${separator}${continuation.text}`
  target.confidence = Math.min(target.confidence, continuation.confidence)
  if (target.list && continuation.region.page > previousMaximumPage) {
    target.list.continuedFromPreviousPage = true
  }
}

function bibliographyContinuationSeparator(
  target: RegionBlock,
  continuation: RegionBlock,
) {
  if (/^[,;:)\]]/u.test(continuation.text.trimStart())) {
    return ''
  }
  const previousYearPrefix = target.text.match(/(?:18|19|20)\d$/u)?.[0]
  const finalYearDigit = continuation.text.match(/^(\d)(?=[.,;:)])/u)?.[1]
  if (
    previousYearPrefix &&
    finalYearDigit &&
    Number(`${previousYearPrefix}${finalYearDigit}`) <= 2099
  ) {
    return ''
  }
  if (/[-–—]$/u.test(target.text) && /^\d/u.test(continuation.text)) {
    return ''
  }
  return target.text ? ' ' : ''
}

function hasOmittedSourceBetweenBlocks(
  target: RegionBlock,
  continuation: RegionBlock,
) {
  const targetSegments = blockSourceSegments(target)
  const continuationSegments = blockSourceSegments(continuation)
  return continuationSegments.some((continuationSegment) => {
    const precedingTargetSegments = targetSegments.filter(
      (targetSegment) =>
        targetSegment.region.id === continuationSegment.region.id &&
        targetSegment.sourceStart < continuationSegment.sourceStart,
    )
    if (precedingTargetSegments.length === 0) return false
    const precedingSourceEnd = Math.max(
      ...precedingTargetSegments.map(
        (targetSegment) =>
          targetSegment.sourceStart + targetSegment.text.length,
      ),
    )
    // A reconstructed region inserts at most one separator between adjacent
    // retained line ranges. A larger gap proves that another source span was
    // consumed by a visual or otherwise omitted, so prose/reference flow must
    // not jump across it.
    return continuationSegment.sourceStart > precedingSourceEnd + 1
  })
}

function bibliographyContinuationFormEvidence(
  target: RegionBlock,
  continuation: RegionBlock,
) {
  const continuationSegments = blockSourceSegments(continuation)
  const continuationHeadSegment = continuationSegments[0]
  const continuationEvidenceRegion =
    continuationHeadSegment?.evidenceRegion ?? continuationHeadSegment?.region
  const continuationText = continuation.text.trimStart()
  if (
    !continuationText ||
    (continuationEvidenceRegion &&
      likelyAuthorYearBibliographyEntryStart(
        continuationEvidenceRegion.lines,
        0,
      ))
  ) {
    return false
  }

  const targetHeadSegment = blockSourceSegments(target)[0]
  const targetEvidenceRegion =
    targetHeadSegment?.evidenceRegion ?? targetHeadSegment?.region
  const targetHeadLine = targetEvidenceRegion?.lines.find((line) =>
    line.text.trim(),
  )
  const continuationHeadLine = continuationEvidenceRegion?.lines.find((line) =>
    line.text.trim(),
  )
  const hangingIndentContinuation = Boolean(
    targetHeadLine &&
    continuationHeadLine &&
    continuationHeadLine.box.x - targetHeadLine.box.x >= 0.008 &&
    continuationHeadLine.box.x - targetHeadLine.box.x <= 0.06,
  )
  const bibliographicLocator =
    /\b(?:arXiv|doi|preprint|proceedings|journal|volume|vol\.|pages?|pp?\.|https?:\/\/|www\.)\b/iu.test(
      continuationText,
    )
  return (
    !/[.!?](?:["'’”\])}]*)$/u.test(target.text.trimEnd()) ||
    /^[\p{Ll}\p{N},;:)\]]/u.test(continuationText) ||
    hangingIndentContinuation ||
    bibliographicLocator
  )
}

function sourceContiguousSamePageBibliographyContinuation(
  target: RegionBlock,
  continuation: RegionBlock,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetEvidenceRegion =
    targetTailSegment?.evidenceRegion ?? targetTailSegment?.region
  const continuationEvidenceRegion =
    continuationHeadSegment?.evidenceRegion ?? continuationHeadSegment?.region
  const targetTailLine = targetEvidenceRegion?.lines.at(-1)
  const continuationHeadLine = continuationEvidenceRegion?.lines[0]
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    targetTailSegment.region.column !== continuationHeadSegment.region.column ||
    hasOmittedSourceBetweenBlocks(target, continuation) ||
    !bibliographyContinuationFormEvidence(target, continuation)
  ) {
    return false
  }
  const verticalGap =
    continuationHeadLine.box.y -
    (targetTailLine.box.y + targetTailLine.box.height)
  const maximumVerticalGap = Math.max(
    0.025,
    Math.max(targetTailLine.box.height, continuationHeadLine.box.height) * 2.5,
  )
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  const targetFlowStartX = Math.min(
    ...blockSourceSegments(target).flatMap((segment) => {
      const evidenceRegion = segment.evidenceRegion ?? segment.region
      return evidenceRegion.lines
        .filter((line) => line.text.trim())
        .map((line) => line.box.x)
    }),
  )
  const alignedContinuation =
    Math.abs(continuationHeadLine.box.x - targetTailLine.box.x) <= 0.06
  const rightEdgeLineWrap =
    targetTailLine.box.x + targetTailLine.box.width >= 0.65 &&
    continuationHeadLine.box.x >= targetFlowStartX - 0.012 &&
    continuationHeadLine.box.x <= targetFlowStartX + 0.06
  return (
    verticalGap >= -0.006 &&
    verticalGap <= maximumVerticalGap &&
    (alignedContinuation || rightEdgeLineWrap) &&
    fontRatio <= 1.12
  )
}

function sourceProvenAdjacentPageBibliographyContinuation(
  target: RegionBlock,
  continuation: RegionBlock,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetEvidenceRegion =
    targetTailSegment?.evidenceRegion ?? targetTailSegment?.region
  const continuationEvidenceRegion =
    continuationHeadSegment?.evidenceRegion ?? continuationHeadSegment?.region
  const targetTailLine = targetEvidenceRegion?.lines
    .filter((line) => line.text.trim())
    .at(-1)
  const continuationHeadLine = continuationEvidenceRegion?.lines.find((line) =>
    line.text.trim(),
  )
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetEvidenceRegion ||
    !continuationEvidenceRegion ||
    !targetTailLine ||
    !continuationHeadLine
  ) {
    return false
  }
  const targetColumn = targetTailSegment.region.column
  const continuationColumn = continuationHeadSegment.region.column
  const wrappedColumnTransition =
    targetColumn === 'right' && continuationColumn === 'left'
  const nonColumnarTransition =
    (targetColumn === 'single' || targetColumn === 'span') &&
    (continuationColumn === 'single' || continuationColumn === 'span')
  const compatibleColumnFlow =
    targetColumn === continuationColumn ||
    wrappedColumnTransition ||
    nonColumnarTransition
  const targetFlowStartX = Math.min(
    ...blockSourceSegments(target)
      .filter(
        (segment) => segment.region.page === targetTailSegment.region.page,
      )
      .flatMap((segment) => {
        const evidenceRegion = segment.evidenceRegion ?? segment.region
        return evidenceRegion.lines
          .filter((line) => line.text.trim())
          .map((line) => line.box.x)
      }),
  )
  const horizontallyAligned =
    wrappedColumnTransition ||
    Math.abs(continuationHeadLine.box.x - targetFlowStartX) <= 0.06
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  return (
    compatibleColumnFlow &&
    horizontallyAligned &&
    fontRatio <= 1.12 &&
    sourceProvenCrossPageBoundary(target, continuation, []) &&
    !hasOmittedSourceBetweenBlocks(target, continuation) &&
    likelyUnmarkedCrossPageContinuation(target, continuation) &&
    bibliographyContinuationFormEvidence(target, continuation)
  )
}

function provenBibliographyContinuation(
  target: RegionBlock,
  continuation: RegionBlock,
) {
  if (sourceContiguousSamePageBibliographyContinuation(target, continuation)) {
    return 'same-page' as const
  }
  if (sourceProvenAdjacentPageBibliographyContinuation(target, continuation)) {
    return 'adjacent-page' as const
  }
  return null
}

const UNCERTAIN_BIBLIOGRAPHY_BOUNDARY_MESSAGE =
  'The bibliography item boundary is uncertain because a plausible markerless continuation lacks source-contiguous same-flow or adjacent-page geometry.'

function recordUncertainBibliographyBoundary(
  diagnostics: ReconstructionDiagnostic[],
  target: RegionBlock,
  continuation: RegionBlock,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  if (!targetTailSegment || !continuationHeadSegment) return
  const targetEvidenceRegion =
    targetTailSegment.evidenceRegion ?? targetTailSegment.region
  const continuationEvidenceRegion =
    continuationHeadSegment.evidenceRegion ?? continuationHeadSegment.region
  const sourceBoxes = [targetEvidenceRegion.box, continuationEvidenceRegion.box]
  const duplicate = diagnostics.some((diagnostic) => {
    const diagnosticBoxes = diagnostic.sourceBoxes
    return (
      diagnostic.code === 'LOW_CONFIDENCE_BLOCK' &&
      diagnostic.message === UNCERTAIN_BIBLIOGRAPHY_BOUNDARY_MESSAGE &&
      diagnosticBoxes !== undefined &&
      diagnosticBoxes.length === sourceBoxes.length &&
      diagnosticBoxes.every((box, index) =>
        sameSourceBox(box, sourceBoxes[index]),
      )
    )
  })
  if (duplicate) return
  diagnostics.push({
    code: 'LOW_CONFIDENCE_BLOCK',
    severity: 'warning',
    page: continuationEvidenceRegion.page,
    message: UNCERTAIN_BIBLIOGRAPHY_BOUNDARY_MESSAGE,
    sourceBoxes,
    target: {
      regionIds: [
        ...new Set([
          targetTailSegment.region.id,
          continuationHeadSegment.region.id,
        ]),
      ],
      markerId: null,
    },
  })
}

function likelyUnmarkedCrossPageContinuation(
  target: RegionBlock,
  continuation: RegionBlock,
) {
  const previousText = target.text.trimEnd()
  const continuationText = continuation.text.trimStart()
  return Boolean(
    previousText &&
    continuationText &&
    !/[.!?](?:["'’”\])}]*)$/u.test(previousText) &&
    (/^\p{Ll}/u.test(continuationText) ||
      detachedScholarlyReferenceContinuation(previousText, continuationText) ||
      detachedCitationYearContinuation(previousText, continuationText) ||
      detachedDashProseContinuation(previousText, continuationText)),
  )
}

function detachedScholarlyReferenceContinuation(
  previousText: string,
  continuationText: string,
) {
  return (
    /\b(?:Section|Appendix|Figure|Fig\.|Table|Equation|Eq\.)$/u.test(
      previousText.trimEnd(),
    ) &&
    /^(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)\.(?:\s|$)/u.test(
      continuationText.trimStart(),
    )
  )
}

function detachedDashProseContinuation(
  previousText: string,
  continuationText: string,
) {
  return (
    !/[.!?:;](?:["'’”\])}]*)$/u.test(previousText.trimEnd()) &&
    /^[–—-]\s+\p{Ll}/u.test(continuationText.trimStart())
  )
}

function detachedCitationYearContinuation(
  previousText: string,
  continuationText: string,
) {
  return (
    /\b\p{Lu}[\p{L}'’.-]*(?:\s+et\s+al\.)?,\s*$/u.test(
      previousText.trimEnd(),
    ) &&
    /^(?:18|19|20)\d{2}[a-z]?(?=[,;:)])/u.test(continuationText.trimStart())
  )
}

function scholarlyLabelFloatContinuation(
  previousText: string,
  continuationText: string,
) {
  return (
    /\b(?:in|of|to|from|with|by|at|on|as|than|between|for|following)\s*$/iu.test(
      previousText.trimEnd(),
    ) &&
    /^(?:Table|Figure|Equation|Eq\.|Section|Appendix)\s+(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)\b/u.test(
      continuationText.trimStart(),
    )
  )
}

function sourceProvenCrossPageBoundary(
  target: RegionBlock,
  continuation: RegionBlock,
  interveningCaptions: readonly RegionBlock[],
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetEvidenceRegion =
    targetTailSegment?.evidenceRegion ?? targetTailSegment?.region
  const continuationEvidenceRegion =
    continuationHeadSegment?.evidenceRegion ?? continuationHeadSegment?.region
  const targetTailLine = targetEvidenceRegion?.lines.at(-1)
  const continuationHeadLine = continuationEvidenceRegion?.lines[0]
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    continuationHeadSegment.region.page !== targetTailSegment.region.page + 1 ||
    targetTailLine.box.y < 0.55
  ) {
    return false
  }
  if (interveningCaptions.length === 0) {
    return continuationHeadLine.box.y <= 0.35
  }
  return interveningCaptions.some((caption) => {
    if (caption.region.page === continuationHeadSegment.region.page) {
      return (
        caption.region.box.y + caption.region.box.height <=
        continuationHeadLine.box.y + 0.004
      )
    }
    return (
      caption.region.page === targetTailSegment.region.page &&
      caption.region.box.y >=
        targetTailLine.box.y + targetTailLine.box.height - 0.004
    )
  })
}

function sourceProvenSamePageColumnFloatBoundary(
  target: RegionBlock,
  continuation: RegionBlock,
  interveningCaptions: readonly RegionBlock[],
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetTailLine = targetTailSegment?.region.lines.at(-1)
  const continuationHeadLine = continuationHeadSegment?.region.lines[0]
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    targetTailSegment.region.column !== 'left' ||
    continuationHeadSegment.region.column !== 'right' ||
    targetTailLine.box.y + targetTailLine.box.height < 0.65 ||
    targetTailLine.box.x >= continuationHeadLine.box.x ||
    targetTailLine.box.x + targetTailLine.box.width >
      continuationHeadLine.box.x + 0.01
  ) {
    return false
  }
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  if (fontRatio > 1.12) return false
  return interveningCaptions.some((caption) => {
    const captionBottom = caption.region.box.y + caption.region.box.height
    const captionCenterX = caption.region.box.x + caption.region.box.width / 2
    return (
      caption.region.page === targetTailSegment.region.page &&
      captionCenterX >= 0.5 &&
      captionBottom <= continuationHeadLine.box.y + 0.004 &&
      continuationHeadLine.box.y - captionBottom <= 0.12
    )
  })
}

function sourceProvenSamePageFloatTailBoundary(
  target: RegionBlock,
  continuation: RegionBlock,
  interveningCaptions: readonly RegionBlock[],
) {
  const targetSegments = blockSourceSegments(target)
  const targetTailSegment = targetSegments.at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetTailLine = targetTailSegment?.region.lines.at(-1)
  const continuationHeadLine = continuationHeadSegment?.region.lines[0]
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    new Set(targetSegments.map((segment) => segment.region.page)).size < 2 ||
    targetTailSegment.region.column !== continuationHeadSegment.region.column
  ) {
    return false
  }
  const verticalGap =
    continuationHeadLine.box.y -
    (targetTailLine.box.y + targetTailLine.box.height)
  if (
    verticalGap < -0.004 ||
    verticalGap > 0.035 ||
    Math.abs(continuationHeadLine.box.x - targetTailLine.box.x) > 0.04
  ) {
    return false
  }
  const firstCurrentPageLineY = Math.min(
    ...targetSegments
      .filter(
        (segment) => segment.region.page === targetTailSegment.region.page,
      )
      .flatMap((segment) => segment.region.lines.map((line) => line.box.y)),
  )
  return interveningCaptions.some(
    (caption) =>
      caption.region.page === targetTailSegment.region.page &&
      caption.region.box.y + caption.region.box.height <=
        firstCurrentPageLineY + 0.004,
  )
}

function sourceProvenSamePageVerticalFloatBoundary(
  target: RegionBlock,
  continuation: RegionBlock,
  interveningCaptions: readonly RegionBlock[],
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetTailLine = targetTailSegment?.region.lines.at(-1)
  const continuationHeadLine = continuationHeadSegment?.region.lines[0]
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page
  ) {
    return false
  }
  const targetColumn = targetTailSegment.region.column
  const continuationColumn = continuationHeadSegment.region.column
  const compatibleColumnFlow =
    targetColumn === continuationColumn ||
    ((targetColumn === 'single' || targetColumn === 'span') &&
      (continuationColumn === 'single' || continuationColumn === 'span'))
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  if (
    !compatibleColumnFlow ||
    Math.abs(continuationHeadLine.box.x - targetTailLine.box.x) > 0.06 ||
    fontRatio > 1.12 ||
    hasOmittedSourceBetweenBlocks(target, continuation)
  ) {
    return false
  }
  const targetBottom = targetTailLine.box.y + targetTailLine.box.height
  const continuationTop = continuationHeadLine.box.y
  return interveningCaptions.some(
    (caption) =>
      caption.region.page === targetTailSegment.region.page &&
      targetBottom <= caption.region.box.y + 0.004 &&
      caption.region.box.y + caption.region.box.height <=
        continuationTop + 0.004,
  )
}

type CaptionBoundedTableInterruption = {
  caption: RegionBlock
  continuationIndex: number
  scopeBlocks: RegionBlock[]
}

function compatibleFloatScopeColumn(
  left: PdfPageRegion['column'],
  right: PdfPageRegion['column'],
) {
  return (
    left === right ||
    ((left === 'single' || left === 'span') &&
      (right === 'single' || right === 'span'))
  )
}

function captionBoundedTableInterruption(
  blocks: readonly RegionBlock[],
  targetIndex: number,
): CaptionBoundedTableInterruption | null {
  const target = blocks[targetIndex]
  if (target?.type !== 'paragraph' || target.list) return null
  const scopeBlocks: RegionBlock[] = []
  let captionIndex = -1
  const maximumScopeEnd = Math.min(blocks.length, targetIndex + 97)
  for (
    let candidateIndex = targetIndex + 1;
    candidateIndex < maximumScopeEnd;
    candidateIndex += 1
  ) {
    const candidate = blocks[candidateIndex]
    if (candidate.type === 'heading') return null
    if (candidate.type === 'caption') {
      const label = parsePdfScholarlyVisualLabel(candidate.text, {
        context: 'caption',
      })
      if (label?.kind !== 'table') return null
      captionIndex = candidateIndex
      break
    }
    if (candidate.type !== 'paragraph' && candidate.type !== 'footnote') {
      return null
    }
    scopeBlocks.push(candidate)
  }
  if (captionIndex < 0 || scopeBlocks.length === 0) return null

  let continuationIndex = captionIndex + 1
  while (
    continuationIndex < blocks.length &&
    blocks[continuationIndex].type === 'footnote'
  ) {
    continuationIndex += 1
  }
  const caption = blocks[captionIndex]
  const continuation = blocks[continuationIndex]
  if (
    continuation?.type !== 'paragraph' ||
    continuation.list ||
    target.region.page !== caption.region.page ||
    continuation.region.page !== caption.region.page ||
    !likelyUnmarkedCrossPageContinuation(target, continuation)
  ) {
    return null
  }

  const captionColumn = caption.region.column
  const scopeRegions = scopeBlocks.map((block) => block.region)
  const firstScopeTop = Math.min(...scopeRegions.map((region) => region.box.y))
  const captionTop = caption.region.box.y
  const captionBottom = captionTop + caption.region.box.height
  const continuationTop =
    continuation.region.lines[0]?.box.y ?? continuation.region.box.y
  const physicallyBounded =
    firstScopeTop <= 0.35 &&
    scopeRegions.every(
      (region) =>
        region.page === caption.region.page &&
        compatibleFloatScopeColumn(region.column, captionColumn) &&
        region.box.y + region.box.height <= captionTop + 0.02,
    ) &&
    continuationTop >= captionBottom - 0.004
  if (!physicallyBounded) return null
  return {
    caption,
    continuationIndex,
    scopeBlocks: [...scopeBlocks, caption],
  }
}

const AMBIGUOUS_CAPTION_BOUNDED_TABLE_MESSAGE =
  'A plausible caption-bounded table interrupts two prose fragments, but no source-proven nearby sentence boundary establishes a safe canonical placement.'

function recordAmbiguousCaptionBoundedTable(
  diagnostics: ReconstructionDiagnostic[],
  target: RegionBlock,
  continuation: RegionBlock,
  interruption: CaptionBoundedTableInterruption,
) {
  const regionIds = [
    target.region.id,
    ...interruption.scopeBlocks.map((block) => block.region.id),
    continuation.region.id,
  ]
  if (
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'AMBIGUOUS_READING_ORDER' &&
        diagnostic.message === AMBIGUOUS_CAPTION_BOUNDED_TABLE_MESSAGE &&
        diagnostic.target?.regionIds.some((regionId) =>
          regionIds.includes(regionId),
        ),
    )
  ) {
    return
  }
  diagnostics.push({
    code: 'AMBIGUOUS_READING_ORDER',
    severity: 'error',
    page: interruption.caption.region.page,
    message: AMBIGUOUS_CAPTION_BOUNDED_TABLE_MESSAGE,
    sourceBoxes: [
      target.region.box,
      ...interruption.scopeBlocks.map((block) => block.region.box),
      continuation.region.box,
    ],
    target: {
      regionIds: [...new Set(regionIds)],
      markerId: null,
    },
  })
}

function sourceProvenSamePageParagraphBoundary(
  target: RegionBlock,
  continuation: RegionBlock,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetEvidenceRegion =
    targetTailSegment?.evidenceRegion ?? targetTailSegment?.region
  const continuationEvidenceRegion =
    continuationHeadSegment?.evidenceRegion ?? continuationHeadSegment?.region
  const targetTailLine = targetEvidenceRegion?.lines.at(-1)
  const continuationHeadLine = continuationEvidenceRegion?.lines[0]
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.id === continuationHeadSegment.region.id ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    targetTailSegment.region.column !== continuationHeadSegment.region.column ||
    hasOmittedSourceBetweenBlocks(target, continuation)
  ) {
    return false
  }
  const verticalGap =
    continuationHeadLine.box.y -
    (targetTailLine.box.y + targetTailLine.box.height)
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  return (
    verticalGap >= -0.006 &&
    verticalGap <=
      Math.max(
        0.025,
        Math.max(targetTailLine.box.height, continuationHeadLine.box.height) *
          2.5,
      ) &&
    Math.abs(continuationHeadLine.box.x - targetTailLine.box.x) <= 0.06 &&
    fontRatio <= 1.12
  )
}

function sourceProvenSamePageColumnBoundary(
  target: RegionBlock,
  continuation: RegionBlock,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetTailLine = targetTailSegment?.region.lines.at(-1)
  const continuationHeadLine = continuationHeadSegment?.region.lines[0]
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    targetTailSegment.region.column !== 'left' ||
    continuationHeadSegment.region.column !== 'right' ||
    targetTailLine.box.y + targetTailLine.box.height < 0.75 ||
    continuationHeadLine.box.y > 0.35 ||
    targetTailLine.box.x >= continuationHeadLine.box.x ||
    targetTailLine.box.x + targetTailLine.box.width >
      continuationHeadLine.box.x + 0.01 ||
    !(
      (/[\p{L}\p{N}][-‐‑]$/u.test(target.text.trimEnd()) &&
        /^\p{Ll}/u.test(continuation.text.trimStart())) ||
      detachedCitationYearContinuation(target.text, continuation.text)
    )
  ) {
    return false
  }
  return true
}

function normalizedBoundaryToken(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase()
}

function floatInterruptedHyphenJoin(
  target: RegionBlock,
  continuation: RegionBlock,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
) {
  const left = target.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const right = continuation.text.trimStart().match(/^([\p{L}\p{N}]+)/u)?.[1]
  if (!left || !right) {
    return {
      separator: target.text ? ' ' : '',
      removeTrailingDiscretionaryHyphen: false,
    }
  }
  const hardForm = normalizedBoundaryToken(`${left}-${right}`)
  const unhyphenatedForm = normalizedBoundaryToken(`${left}${right}`)
  return {
    // A printed terminal hyphen and its lowercase page continuation are one
    // source token. Preserve the printed hyphen when lexical evidence is
    // inconclusive, but never invent whitespace inside that token.
    separator: '',
    removeTrailingDiscretionaryHyphen:
      unhyphenatedLexicon.has(unhyphenatedForm) &&
      !hardHyphenLexicon.has(hardForm),
  }
}

function mergeProseContinuations(
  blocks: RegionBlock[],
  {
    ownedFloatCaptionRegionIds = new Set<string>(),
    hardHyphenLexicon = new Set<string>(),
    unhyphenatedLexicon = new Set<string>(),
    diagnostics = [],
    canonicalFloatScopes = [],
  }: {
    ownedFloatCaptionRegionIds?: ReadonlySet<string>
    hardHyphenLexicon?: ReadonlySet<string>
    unhyphenatedLexicon?: ReadonlySet<string>
    diagnostics?: ReconstructionDiagnostic[]
    canonicalFloatScopes?: CanonicalFloatScopeEvidence[]
  } = {},
) {
  for (let index = 0; index < blocks.length; index += 1) {
    const target = blocks[index]
    if (target.type !== 'paragraph' || target.list) continue
    while (true) {
      const tableInterruption = captionBoundedTableInterruption(blocks, index)
      let continuationIndex = tableInterruption?.continuationIndex ?? index + 1
      const interveningOwnedCaptions: RegionBlock[] = tableInterruption
        ? [tableInterruption.caption]
        : []
      while (
        !tableInterruption &&
        continuationIndex < blocks.length &&
        (blocks[continuationIndex].type === 'caption' ||
          blocks[continuationIndex].type === 'footnote')
      ) {
        // A source-text display equation is represented canonically as a
        // visual immediately followed by its transcript caption.  It is a
        // semantic boundary in the sentence, not a floating caption that
        // prose may merge across.
        if (
          blocks[continuationIndex].type === 'caption' &&
          blocks[continuationIndex].region.kind === 'equation'
        ) {
          const equationIndex = continuationIndex
          let followingIndex = equationIndex + 1
          while (
            followingIndex < blocks.length &&
            blocks[followingIndex].type === 'footnote'
          ) {
            followingIndex += 1
          }
          const following = blocks[followingIndex]
          if (
            followingIndex > equationIndex + 1 &&
            following?.type === 'paragraph' &&
            !following.list &&
            following.region.page > blocks[equationIndex].region.page &&
            likelyUnmarkedCrossPageContinuation(target, following)
          ) {
            // Printed page-bottom notes are outside the sentence flow. When a
            // display equation ends the page and its explanation continues on
            // the next one, keep the continuation beside the equation and
            // defer those note bodies until after the completed sentence.
            const notes = blocks.splice(
              equationIndex + 1,
              followingIndex - equationIndex - 1,
            )
            blocks.splice(equationIndex + 2, 0, ...notes)
          }
          break
        }
        if (
          blocks[continuationIndex].type === 'caption' &&
          !ownedFloatCaptionRegionIds.has(blocks[continuationIndex].region.id)
        ) {
          break
        }
        if (blocks[continuationIndex].type === 'caption') {
          interveningOwnedCaptions.push(blocks[continuationIndex])
        }
        continuationIndex += 1
      }
      const continuation = blocks[continuationIndex]
      const crossesOwnedFloat = interveningOwnedCaptions.length > 0
      const sourceProvenPageBoundary =
        continuation?.type === 'paragraph' &&
        sourceProvenCrossPageBoundary(
          target,
          continuation,
          interveningOwnedCaptions,
        )
      const sourceProvenColumnBoundary =
        continuation?.type === 'paragraph' &&
        interveningOwnedCaptions.length === 0 &&
        sourceProvenSamePageColumnBoundary(target, continuation)
      const sourceProvenSamePageBoundary =
        continuation?.type === 'paragraph' &&
        interveningOwnedCaptions.length === 0 &&
        sourceProvenSamePageParagraphBoundary(target, continuation)
      const sourceProvenFloatBoundary =
        crossesOwnedFloat &&
        (sourceProvenPageBoundary ||
          (continuation?.type === 'paragraph' &&
            sourceProvenSamePageColumnFloatBoundary(
              target,
              continuation,
              interveningOwnedCaptions,
            )) ||
          (continuation?.type === 'paragraph' &&
            sourceProvenSamePageFloatTailBoundary(
              target,
              continuation,
              interveningOwnedCaptions,
            )) ||
          (continuation?.type === 'paragraph' &&
            sourceProvenSamePageVerticalFloatBoundary(
              target,
              continuation,
              interveningOwnedCaptions,
            )))
      if (
        tableInterruption &&
        continuation?.type === 'paragraph' &&
        !sourceProvenFloatBoundary
      ) {
        recordAmbiguousCaptionBoundedTable(
          diagnostics,
          target,
          continuation,
          tableInterruption,
        )
      }
      const citationYearContinuation =
        continuation?.type === 'paragraph' &&
        detachedCitationYearContinuation(target.text, continuation.text)
      const sourceProvenCitationBoundary =
        citationYearContinuation &&
        (sourceProvenPageBoundary ||
          sourceProvenColumnBoundary ||
          sourceProvenSamePageBoundary)
      if (
        continuation?.type !== 'paragraph' ||
        continuation.list ||
        (crossesOwnedFloat && !sourceProvenFloatBoundary) ||
        (citationYearContinuation && !sourceProvenCitationBoundary) ||
        (!likelyUnmarkedCrossPageContinuation(target, continuation) &&
          !(
            sourceProvenFloatBoundary &&
            (scholarlyLabelFloatContinuation(target.text, continuation.text) ||
              /^\p{Ll}/u.test(continuation.text.trimStart()))
          ))
      ) {
        break
      }
      const hyphenJoin =
        sourceProvenPageBoundary ||
        sourceProvenColumnBoundary ||
        sourceProvenFloatBoundary
          ? floatInterruptedHyphenJoin(
              target,
              continuation,
              hardHyphenLexicon,
              unhyphenatedLexicon,
            )
          : {
              separator: target.text ? ' ' : '',
              removeTrailingDiscretionaryHyphen: false,
            }
      if (tableInterruption && sourceProvenFloatBoundary) {
        const startRegionId = blockSourceSegments(target).at(-1)?.region.id
        const endRegionId = blockSourceSegments(continuation)[0]?.region.id
        const scopeRegionIds = tableInterruption.scopeBlocks.map(
          (block) => block.region.id,
        )
        if (
          startRegionId &&
          endRegionId &&
          !canonicalFloatScopes.some(
            (scope) =>
              scope.interruptedRegionIds[0] === startRegionId &&
              scope.interruptedRegionIds[1] === endRegionId &&
              scope.scopeRegionIds.length === scopeRegionIds.length &&
              scope.scopeRegionIds.every(
                (regionId, scopeIndex) =>
                  regionId === scopeRegionIds[scopeIndex],
              ),
          )
        ) {
          canonicalFloatScopes.push({
            interruptedRegionIds: [startRegionId, endRegionId],
            scopeRegionIds,
          })
        }
      }
      appendBlockContinuation(
        target,
        continuation,
        hyphenJoin.separator,
        hyphenJoin.removeTrailingDiscretionaryHyphen,
      )
      blocks.splice(continuationIndex, 1)
    }
  }
}

function boxForRegionLines(lines: PdfPageRegion['lines']): NormalizedSourceBox {
  const left = Math.min(...lines.map((line) => line.box.x))
  const top = Math.min(...lines.map((line) => line.box.y))
  const right = Math.max(...lines.map((line) => line.box.x + line.box.width))
  const bottom = Math.max(...lines.map((line) => line.box.y + line.box.height))
  return {
    page: lines[0].box.page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: lines[0].box.rotation,
    method: lines.some((line) => line.box.method === 'ocr')
      ? 'ocr'
      : 'pdf-text',
  }
}

type BibliographyIndentationProfile = {
  baseX: number
  continuationX: number
}

function bibliographyFlowKey(region: Pick<PdfPageRegion, 'page' | 'column'>) {
  return region.column
}

function bibliographyIndentationProfiles(
  blocks: RegionBlock[],
  bibliographyRegionIds: ReadonlySet<string>,
) {
  const linesByFlow = new Map<string, PdfPageRegion['lines']>()
  for (const block of blocks) {
    if (
      block.type !== 'paragraph' ||
      !bibliographyRegionIds.has(block.region.id)
    ) {
      continue
    }
    const key = bibliographyFlowKey(block.region)
    const lines = linesByFlow.get(key) ?? []
    lines.push(...block.region.lines.filter((line) => line.text.trim()))
    linesByFlow.set(key, lines)
  }

  const profiles = new Map<string, BibliographyIndentationProfile>()
  for (const [key, lines] of linesByFlow) {
    if (lines.length < 4) continue
    const xClusters: Array<{ x: number; values: number[] }> = []
    for (const x of lines.map((line) => line.box.x).sort((a, b) => a - b)) {
      const cluster = xClusters.find(
        (candidate) => Math.abs(candidate.x - x) <= 0.004,
      )
      if (cluster) {
        cluster.values.push(x)
        cluster.x = median(cluster.values)
      } else {
        xClusters.push({ x, values: [x] })
      }
    }
    const candidates = xClusters
      .filter((cluster) => cluster.values.length >= 2)
      .flatMap((base) =>
        xClusters
          .filter(
            (continuation) =>
              continuation.values.length >= 2 &&
              continuation.x - base.x >= 0.008 &&
              continuation.x - base.x <= 0.04,
          )
          .map((continuation) => ({
            base,
            continuation,
            coverage: base.values.length + continuation.values.length,
          })),
      )
      .sort(
        (left, right) =>
          right.coverage - left.coverage ||
          right.continuation.values.length - left.continuation.values.length ||
          left.base.x - right.base.x,
      )
    const best = candidates[0]
    if (!best) continue
    profiles.set(key, {
      baseX: best.base.x,
      continuationX: best.continuation.x,
    })
  }
  return profiles
}

function bibliographyLineIndentation(
  line: PdfPageRegion['lines'][number],
  profile: BibliographyIndentationProfile,
) {
  if (Math.abs(line.box.x - profile.baseX) <= 0.004) return 'entry' as const
  if (Math.abs(line.box.x - profile.continuationX) <= 0.004) {
    return 'continuation' as const
  }
  return 'unknown' as const
}

function sameBaselineBibliographyFragment(
  target: RegionBlock,
  continuation: RegionBlock,
  profile: BibliographyIndentationProfile | undefined,
) {
  if (
    target.region.page !== continuation.region.page ||
    target.region.column !== continuation.region.column ||
    parsedBibliographyListMarker(continuation.text)
  ) {
    return false
  }
  const continuationLine = continuation.region.lines.find((line) =>
    line.text.trim(),
  )
  if (
    !continuationLine ||
    (profile &&
      bibliographyLineIndentation(continuationLine, profile) === 'entry')
  ) {
    return false
  }
  const continuationCenter =
    continuationLine.box.y + continuationLine.box.height / 2
  const candidates = blockSourceSegments(target)
    .flatMap((segment) => {
      const evidenceRegion = segment.evidenceRegion ?? segment.region
      return evidenceRegion.lines
    })
    .filter((line) => {
      const lineCenter = line.box.y + line.box.height / 2
      const fontRatio =
        Math.max(line.fontSize, continuationLine.fontSize) /
        Math.max(1, Math.min(line.fontSize, continuationLine.fontSize))
      const gap = continuationLine.box.x - (line.box.x + line.box.width)
      return (
        Math.abs(lineCenter - continuationCenter) <=
          Math.max(
            0.002,
            Math.min(line.box.height, continuationLine.box.height) * 0.2,
          ) &&
        fontRatio <= 1.08 &&
        gap >= -0.003 &&
        gap <= 0.12
      )
    })
    .map((line) => ({
      line,
      gap: continuationLine.box.x - (line.box.x + line.box.width),
    }))
    .sort(
      (left, right) =>
        left.gap - right.gap ||
        right.line.box.x +
          right.line.box.width -
          (left.line.box.x + left.line.box.width),
    )
  if (candidates.length === 0) return false
  return (
    candidates.length === 1 ||
    Math.abs(candidates[0].gap - candidates[1].gap) > 0.002
  )
}

function likelyAuthorYearBibliographyEntryStart(
  lines: PdfPageRegion['lines'],
  index: number,
) {
  const text = lines[index]?.text.trim() ?? ''
  if (!(
    /^\p{Lu}[\p{L}'’.-]+,\s*(?:\p{Lu}(?:[.-]\p{Lu})*\.?|[\p{Lu}][\p{L}'’.-]+)/u.test(
      text,
    ) ||
    /^(?:[\p{Lu}\p{N}][\p{L}\p{N}&'’+.-]*\s*){1,5}\.\s+\p{Lu}/u.test(text) ||
    /^[a-z][\p{L}\p{N}.-]*\.\s+\p{Lu}/u.test(text)
  )) {
    return false
  }
  return /\b(?:18|19|20)\d{2}[a-z]?\b/u.test(
    lines
      .slice(index, index + 8)
      .map((line) => line.text)
      .join(' '),
  )
}

function splitBibliographyBlock(
  block: RegionBlock,
  bibliographyRegionIds: ReadonlySet<string>,
  profiles: ReadonlyMap<string, BibliographyIndentationProfile>,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const bibliography = bibliographyRegionIds.has(block.region.id)
  if (
    !bibliography ||
    block.type !== 'paragraph' ||
    block.region.lines.length < 2 ||
    block.sourceSegments
  ) {
    return [block]
  }
  const replay = replayPdfRegionLineRanges(block.region, lineBoundaryDecisions)
  if (!replay || replay.text !== block.text) return [block]

  const profile = profiles.get(bibliographyFlowKey(block.region))
  const fragmentStarts = [0]
  for (let index = 1; index < block.region.lines.length; index += 1) {
    const line = block.region.lines[index]
    const previous = block.region.lines[index - 1]
    const lineRange = replay.ranges.get(line.id)
    const previousRange = replay.ranges.get(previous.id)
    if (
      !lineRange ||
      !previousRange ||
      lineRange.start !== previousRange.end + 1
    ) {
      continue
    }
    const explicitEntry = Boolean(parsedBibliographyListMarker(line.text))
    const hangingIndentEntry =
      profile && bibliographyLineIndentation(line, profile) === 'entry'
    const localAuthorYearReset =
      previous.box.x - line.box.x >= 0.008 &&
      likelyAuthorYearBibliographyEntryStart(block.region.lines, index)
    const completedNumberedAuthorYearReset = Boolean(
      profile &&
      parsedBibliographyListMarker(previous.text) &&
      bibliographyLineIndentation(previous, profile) === 'entry' &&
      bibliographyLineIndentation(line, profile) === 'continuation' &&
      /[.!?](?:["'’”\])}]*)$/u.test(previous.text.trimEnd()) &&
      likelyAuthorYearBibliographyEntryStart(block.region.lines, index),
    )
    if (
      explicitEntry ||
      hangingIndentEntry ||
      localAuthorYearReset ||
      completedNumberedAuthorYearReset
    ) {
      fragmentStarts.push(index)
    }
  }
  if (fragmentStarts.length === 1) return [block]

  const fragments: RegionBlock[] = []
  for (const [fragmentIndex, startIndex] of fragmentStarts.entries()) {
    const endIndex =
      (fragmentStarts[fragmentIndex + 1] ?? block.region.lines.length) - 1
    const lines = block.region.lines.slice(startIndex, endIndex + 1)
    const firstRange = replay.ranges.get(lines[0].id)
    const lastRange = replay.ranges.get(lines.at(-1)!.id)
    if (!firstRange || !lastRange || firstRange.start >= lastRange.end) {
      return [block]
    }
    const sourceStart = firstRange.start
    const sourceEnd = lastRange.end
    const text = block.region.text.slice(sourceStart, sourceEnd)
    const evidenceRegion: PdfPageRegion = {
      ...block.region,
      box: boxForRegionLines(lines),
      lines,
      text,
    }
    fragments.push({
      ...block,
      region: evidenceRegion,
      text,
      sourceSegments: [
        {
          region: block.region,
          evidenceRegion,
          sourceStart,
          canonicalStart: 0,
          text,
        },
      ],
    })
  }
  return fragments
}

function recoverBibliographyBlocks(
  blocks: RegionBlock[],
  bibliographyRegionIds: ReadonlySet<string>,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
  diagnostics: ReconstructionDiagnostic[] = [],
) {
  const profiles = bibliographyIndentationProfiles(
    blocks,
    bibliographyRegionIds,
  )
  const uncertainFlows = new Map<string, RegionBlock[]>()
  for (const block of blocks) {
    if (
      block.type !== 'paragraph' ||
      !bibliographyRegionIds.has(block.region.id) ||
      parsedBibliographyListMarker(block.text) ||
      profiles.has(bibliographyFlowKey(block.region))
    ) {
      continue
    }
    const key = bibliographyFlowKey(block.region)
    const candidates = uncertainFlows.get(key) ?? []
    candidates.push(block)
    uncertainFlows.set(key, candidates)
  }
  for (const candidates of uncertainFlows.values()) {
    if (candidates.length < 2) continue
    diagnostics.push({
      code: 'LOW_CONFIDENCE_BLOCK',
      severity: 'warning',
      page: candidates[0].region.page,
      message:
        'The bibliography item cardinality is uncertain because unnumbered source regions have neither a stable hanging-indent profile nor explicit entry markers.',
      sourceBoxes: candidates.map((block) => block.region.box),
      target: {
        regionIds: candidates.map((block) => block.region.id),
        markerId: null,
      },
    })
  }
  const splitBlocks = blocks.flatMap((block) =>
    splitBibliographyBlock(
      block,
      bibliographyRegionIds,
      profiles,
      lineBoundaryDecisions,
    ),
  )
  const recovered: RegionBlock[] = []
  let previousBibliographyBlock: RegionBlock | undefined
  for (const block of splitBlocks) {
    const bibliography =
      block.type === 'paragraph' && bibliographyRegionIds.has(block.region.id)
    if (!bibliography) {
      recovered.push(block)
      previousBibliographyBlock = undefined
      continue
    }
    const profile = profiles.get(bibliographyFlowKey(block.region))
    const lineIndentations = profile
      ? block.region.lines
          .filter((line) => line.text.trim())
          .map((line) => bibliographyLineIndentation(line, profile))
      : []
    const entry = parsedBibliographyListMarker(block.text)
    const wrappedPageRangeEndpoint = Boolean(
      entry &&
      previousBibliographyBlock &&
      /(?:\bpp?\.\s*)?\d+\s*[-–—]$/iu.test(
        previousBibliographyBlock.text.trimEnd(),
      ) &&
      lineIndentations.length > 0 &&
      lineIndentations.every(
        (indentation) =>
          indentation === 'continuation' || indentation === 'unknown',
      ) &&
      lineIndentations.includes('continuation'),
    )
    const punctuationLedContinuation = Boolean(
      !entry &&
      previousBibliographyBlock &&
      /^[,;:)\]]/u.test(block.text.trimStart()) &&
      bibliographyFlowKey(block.region) ===
        bibliographyFlowKey(previousBibliographyBlock.region) &&
      block.region.page >= previousBibliographyBlock.region.page &&
      block.region.page <= previousBibliographyBlock.region.page + 1 &&
      !hasOmittedSourceBetweenBlocks(previousBibliographyBlock, block),
    )
    const sameBaselineFragment = Boolean(
      !entry &&
      previousBibliographyBlock &&
      sameBaselineBibliographyFragment(
        previousBibliographyBlock,
        block,
        profile,
      ) &&
      !hasOmittedSourceBetweenBlocks(previousBibliographyBlock, block),
    )
    const provenContinuation =
      !entry && previousBibliographyBlock
        ? provenBibliographyContinuation(previousBibliographyBlock, block)
        : null
    const previousNumberedBibliographyEntry = Boolean(
      previousBibliographyBlock &&
      parsedBibliographyListMarker(previousBibliographyBlock.text),
    )
    const profiledContinuation = Boolean(
      (!entry || wrappedPageRangeEndpoint) &&
      profile &&
      !lineIndentations.includes('entry') &&
      lineIndentations.includes('continuation'),
    )
    if (
      !provenContinuation &&
      previousNumberedBibliographyEntry &&
      previousBibliographyBlock &&
      (punctuationLedContinuation || profiledContinuation) &&
      bibliographyContinuationFormEvidence(previousBibliographyBlock, block)
    ) {
      recordUncertainBibliographyBoundary(
        diagnostics,
        previousBibliographyBlock,
        block,
      )
    }
    const continuation = Boolean(
      sameBaselineFragment ||
      ((punctuationLedContinuation || profiledContinuation) &&
        (!previousNumberedBibliographyEntry || provenContinuation)),
    )
    if (continuation && previousBibliographyBlock) {
      const previousPages = blockSourceSegments(previousBibliographyBlock).map(
        (segment) => segment.region.page,
      )
      if (block.region.page > Math.max(...previousPages)) {
        previousBibliographyBlock.bibliographyContinuedFromPreviousPage = true
      }
      appendBlockContinuation(
        previousBibliographyBlock,
        block,
        bibliographyContinuationSeparator(previousBibliographyBlock, block),
      )
      continue
    }
    recovered.push(block)
    previousBibliographyBlock = block
  }
  return recovered
}

export type PdfResidualRegionFragment = {
  region: PdfPageRegion
  sourceRegion: PdfPageRegion
  sourceStart: number
  sourceEnd: number
}

const EXPLICIT_BOLD_STYLE_FONT_NAME =
  /(?:^|[+,._\s-])(?:bold|black|demi(?:bold)?|semibold)(?:(?:italic|ital|oblique|obl))?(?=$|[+,._\s-])/iu
const CAMELCASE_BOLD_STYLE_FONT_NAME =
  /(?:Bold|Black|DemiBold|SemiBold)(?:Italic|Oblique)?$/u
const NIMBUS_ROMAN_BOLD_FACE_FONT_NAME =
  /(?:^|[+,._\s-])nimbusrom(?:an)?no9l-medi(?:um)?(?:(?:italic|ital|oblique|obl))?(?=$|[+,._\s-])/iu
const TEX_BOLD_FACE_FONT_NAME =
  /(?:^|[+,._\s-])(?:cm(?:bx|b)(?:ti|sl)?\d*|lin(?:biolinum|libertine)t?b(?:i)?)(?=$|[+,._\s-])/iu
const MEDIUM_FACE_FONT_NAME =
  /(?:^|[+,._\s-])medi(?:um)?(?:(?:italic|ital|oblique|obl))?(?=$|[+,._\s-])/iu

function fontNameIndicatesBold(fontName: string) {
  return (
    EXPLICIT_BOLD_STYLE_FONT_NAME.test(fontName) ||
    CAMELCASE_BOLD_STYLE_FONT_NAME.test(fontName) ||
    NIMBUS_ROMAN_BOLD_FACE_FONT_NAME.test(fontName) ||
    TEX_BOLD_FACE_FONT_NAME.test(fontName)
  )
}

function fontNameIndicatesEmphasizedFace(fontName: string) {
  return fontNameIndicatesBold(fontName) || MEDIUM_FACE_FONT_NAME.test(fontName)
}

function emphasizedLineShare(line: PdfPageRegion['lines'][number]) {
  const runs = line.runs.filter((run) => run.text.trim())
  const visible = runs.reduce((total, run) => total + run.text.trim().length, 0)
  const emphasized = runs.reduce(
    (total, run) =>
      total +
      (run.bold || fontNameIndicatesEmphasizedFace(run.fontName)
        ? run.text.trim().length
        : 0),
    0,
  )
  return visible > 0 ? emphasized / visible : 0
}

function sourceSmallCapsLine(line: PdfPageRegion['lines'][number]) {
  const text = line.text.replace(/\s+/gu, ' ').trim()
  const letters = text.match(/\p{L}/gu) ?? []
  if (
    letters.length < 4 ||
    letters.some((letter) => letter !== letter.toLocaleUpperCase())
  ) {
    return false
  }
  const letterRuns = line.runs.filter(
    (run) => run.text.trim() && /\p{L}/u.test(run.text),
  )
  if (letterRuns.length < 2) return false
  const leadingLetters =
    letterRuns[0].text.match(/\p{L}/gu)?.length ?? Number.POSITIVE_INFINITY
  const largestSize = Math.max(...letterRuns.map((run) => run.fontSize))
  return (
    leadingLetters <= 2 &&
    letterRuns[0].fontSize >= largestSize * 0.95 &&
    letterRuns.slice(1).some((run) => run.fontSize <= largestSize * 0.9)
  )
}

function sourceStyledLetteredSmallCapsHeading(
  line: PdfPageRegion['lines'][number],
) {
  const match = line.text.trim().match(/^[A-Z](?:\.\d+){0,3}\.?\s+(\S.*)$/u)
  if (!match || /\p{Ll}/u.test(match[1])) return false
  const letterRuns = line.runs.filter(
    (run) => run.text.trim() && /\p{L}/u.test(run.text),
  )
  if (letterRuns.length < 2) return false
  const largestSize = Math.max(...letterRuns.map((run) => run.fontSize))
  return (
    letterRuns.some((run) => run.fontSize >= largestSize * 0.95) &&
    letterRuns.some((run) => run.fontSize <= largestSize * 0.9)
  )
}

function sameHeadingFlow(left: PdfPageRegion, right: PdfPageRegion) {
  if (left.page !== right.page) return false
  if (left.column === right.column) return true
  return (
    ['single', 'span'].includes(left.column) &&
    ['single', 'span'].includes(right.column)
  )
}

function sourceStyledStandaloneBoundaryHeading(
  region: PdfPageRegion,
  readingRegions: readonly PdfPageRegion[],
) {
  if (region.lines.length !== 1) return false
  const text = region.text.replace(/\s+/gu, ' ').trim()
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? []
  const letters = text.match(/\p{L}/gu) ?? []
  if (
    text.length > 96 ||
    words.length === 0 ||
    words.length > 10 ||
    letters.length < 4 ||
    letters.some((letter) => letter !== letter.toLocaleUpperCase()) ||
    structuralOrdinalHeadingText(text) ||
    /(?:https?:\/\/|www\.|\S*[_@]\S*|(?:\.\s*){3,})/iu.test(text)
  ) {
    return false
  }
  const line = region.lines[0]
  if (!sourceSmallCapsLine(line) && emphasizedLineShare(line) < 0.8) {
    return false
  }
  const regionIndex = readingRegions.indexOf(region)
  if (regionIndex < 0) return false
  const previous = readingRegions
    .slice(0, regionIndex)
    .reverse()
    .find((candidate) => sameHeadingFlow(region, candidate))
  const next = readingRegions
    .slice(regionIndex + 1)
    .find((candidate) => sameHeadingFlow(region, candidate))
  if (!next) return false
  const lineHeight = Math.max(region.box.height, line.box.height, 0.008)
  const precedingGap = previous
    ? region.box.y - (previous.box.y + previous.box.height)
    : Number.POSITIVE_INFINITY
  const followingGap = next.box.y - (region.box.y + region.box.height)
  const startsAtPageBoundary = !previous && region.box.y <= 0.22
  const hasPrecedingBoundary =
    startsAtPageBoundary || precedingGap >= Math.max(0.006, lineHeight * 0.45)
  const hasFollowingBoundary =
    followingGap >= Math.max(0.004, lineHeight * 0.3) &&
    followingGap <= Math.max(0.055, lineHeight * 3.5)
  const nextIsProse =
    next.text.trim().length >= 40 &&
    next.box.width >= Math.max(0.3, region.box.width * 1.35) &&
    Math.abs(next.box.x - region.box.x) <= 0.07
  return hasPrecedingBoundary && hasFollowingBoundary && nextIsProse
}

function splitLeadingStyledHeadingRegion(
  region: PdfPageRegion,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
): PdfResidualRegionFragment[] {
  if (region.lines.length < 2) {
    return [
      {
        region,
        sourceRegion: region,
        sourceStart: 0,
        sourceEnd: region.text.length,
      },
    ]
  }
  const firstLine = region.lines[0]
  const continuationLine = region.lines[1]
  const numberedMatch = firstLine.text
    .trim()
    .match(/^\d+(?:\.\d+){0,3}[.)]?\s+(\S.*)$/u)
  const titleText = numberedMatch?.[1] ?? ''
  const multiLevelSmallCaps =
    /^\d+(?:\.\d+){2,3}[.)]?\s/u.test(firstLine.text.trim()) &&
    /\p{Lu}/u.test(titleText) &&
    !/\p{Ll}/u.test(titleText)
  const styledHeadingPrefix =
    Boolean(numberedMatch) &&
    emphasizedLineShare(firstLine) >= 0.6 &&
    emphasizedLineShare(continuationLine) < 0.5
  const letteredSmallCaps = sourceStyledLetteredSmallCapsHeading(firstLine)
  if (!styledHeadingPrefix && !multiLevelSmallCaps && !letteredSmallCaps) {
    return [
      {
        region,
        sourceRegion: region,
        sourceStart: 0,
        sourceEnd: region.text.length,
      },
    ]
  }
  const headingLines = [firstLine]
  if (letteredSmallCaps) {
    for (const line of region.lines.slice(1)) {
      if (!sourceStyledLetteredSmallCapsHeading(line)) break
      headingLines.push(line)
    }
  }
  const replay = replayPdfRegionLineRanges(region, lineBoundaryDecisions)
  const headingRanges = headingLines.map((line) => replay?.ranges.get(line.id))
  const firstProseLine = region.lines[headingLines.length]
  const firstProseRange = firstProseLine
    ? replay?.ranges.get(firstProseLine.id)
    : undefined
  const adjacentRanges = headingRanges.every((range, index) => {
    if (!range) return false
    const next =
      headingRanges[index + 1] ??
      (index === headingRanges.length - 1 ? firstProseRange : undefined)
    return !next || next.start === range.end + 1
  })
  if (!replay || replay.text !== region.text || !adjacentRanges) {
    return [
      {
        region,
        sourceRegion: region,
        sourceStart: 0,
        sourceEnd: region.text.length,
      },
    ]
  }
  const headings = headingLines.map((line, index) => {
    const range = headingRanges[index]!
    return {
      region: {
        ...region,
        box: boxForRegionLines([line]),
        lines: [line],
        text: region.text.slice(range.start, range.end),
      },
      sourceRegion: region,
      sourceStart: range.start,
      sourceEnd: range.end,
    }
  })
  if (!firstProseLine || !firstProseRange) return headings
  const proseLines = region.lines.slice(headingLines.length)
  return [
    ...headings,
    {
      region: {
        ...region,
        box: boxForRegionLines(proseLines),
        lines: proseLines,
        text: region.text.slice(firstProseRange.start),
      },
      sourceRegion: region,
      sourceStart: firstProseRange.start,
      sourceEnd: region.text.length,
    },
  ]
}

export function residualPdfRegionFragmentsAfterLineConsumption(
  region: PdfPageRegion,
  consumedLineIds: ReadonlySet<string>,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
): PdfResidualRegionFragment[] {
  if (region.lines.every((line) => !consumedLineIds.has(line.id))) {
    return [
      {
        region,
        sourceRegion: region,
        sourceStart: 0,
        sourceEnd: region.text.length,
      },
    ]
  }
  const replay = replayPdfRegionLineRanges(region, lineBoundaryDecisions)
  if (!replay || replay.text !== region.text) {
    throw new Error(
      `Cannot replay source line boundaries for partial PDF region ${region.id}.`,
    )
  }
  const retainedRuns: PdfPageRegion['lines'][] = []
  for (const line of region.lines) {
    if (consumedLineIds.has(line.id)) continue
    const previous = region.lines[region.lines.indexOf(line) - 1]
    if (!previous || consumedLineIds.has(previous.id)) retainedRuns.push([])
    retainedRuns.at(-1)!.push(line)
  }
  return retainedRuns.map((lines) => {
    const first = replay.ranges.get(lines[0].id)
    const last = replay.ranges.get(lines.at(-1)!.id)
    if (!first || !last || first.start > last.end) {
      throw new Error(
        `Cannot map retained source lines for partial PDF region ${region.id}.`,
      )
    }
    const sourceStart = first.start
    const sourceEnd = last.end
    return {
      region: {
        ...region,
        box: boxForRegionLines(lines),
        lines,
        text: region.text.slice(sourceStart, sourceEnd),
      },
      sourceRegion: region,
      sourceStart,
      sourceEnd,
    }
  })
}

export function residualPdfRegionAfterLineConsumption(
  region: PdfPageRegion,
  consumedLineIds: ReadonlySet<string>,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
): PdfPageRegion | null {
  const fragments = residualPdfRegionFragmentsAfterLineConsumption(
    region,
    consumedLineIds,
    lineBoundaryDecisions,
  )
  if (fragments.length > 1) {
    throw new Error(
      `Cannot collapse noncontiguous retained lines for partial PDF region ${region.id}.`,
    )
  }
  return fragments[0]?.region ?? null
}

function blocksFromRegions(
  orderedRegions: PdfPageRegion[],
  regions: PdfPageRegion[],
  excludedRegionIds = new Set<string>(),
  bibliographyRegionIds: ReadonlySet<string> = new Set<string>(),
  sourceEquationCaptions: ReadonlyMap<string, string> = new Map<
    string,
    string
  >(),
  consumedLineIds: ReadonlySet<string> = new Set<string>(),
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[] = [],
  diagnostics: ReconstructionDiagnostic[] = [],
  citationLedRegionIds: ReadonlySet<string> = new Set<string>(),
) {
  const residualFragments = new WeakMap<
    PdfPageRegion,
    PdfResidualRegionFragment
  >()
  const retainedRegions = orderedRegions.flatMap((region) => {
    if (
      excludedRegionIds.has(region.id) ||
      ![
        'body',
        'spanning',
        'caption',
        'equation',
        'footnote',
        'endnote',
      ].includes(region.kind)
    ) {
      return []
    }
    const fragments = residualPdfRegionFragmentsAfterLineConsumption(
      region,
      consumedLineIds,
      lineBoundaryDecisions,
    )
    for (const fragment of fragments) {
      if (
        fragment.sourceStart !== 0 ||
        fragment.sourceEnd !== fragment.sourceRegion.text.length
      ) {
        residualFragments.set(fragment.region, fragment)
      }
    }
    return fragments.map((fragment) => fragment.region)
  })
  const bodySize =
    median(
      regions
        .filter((region) => region.kind === 'body')
        .flatMap((region) => region.lines.map((line) => line.fontSize)),
    ) || 12
  const readingRegions = retainedRegions.flatMap((region) => {
    if (bibliographyRegionIds.has(region.id) || residualFragments.has(region)) {
      return [region]
    }
    const fragments = splitLeadingStyledHeadingRegion(
      region,
      lineBoundaryDecisions,
    )
    if (fragments.length === 1) return [region]
    for (const fragment of fragments) {
      residualFragments.set(fragment.region, fragment)
    }
    return fragments.map((fragment) => fragment.region)
  })
  const explicitSectionHierarchy = readingRegions.some(
    (region) =>
      /^(?:\d+(?:\.\d+){0,3}|[A-Z](?:\.\d+)+)[.)]?\s+\p{Lu}/u.test(
        region.text.trim(),
      ) && region.lines.some((line) => emphasizedLineShare(line) >= 0.6),
  )
  const regionsByPage = new Map<number, PdfPageRegion[]>()
  for (const region of readingRegions) {
    const pageRegions = regionsByPage.get(region.page) ?? []
    pageRegions.push(region)
    regionsByPage.set(region.page, pageRegions)
  }
  const hasAppendixContentsStructure = (pageRegions: PdfPageRegion[]) => {
    const dotLeaderEntries = pageRegions.filter(
      (region) =>
        /(?:\.\s*){3,}\d+\s*$/u.test(region.text.trim()) &&
        /^[A-Z](?:\.\d+(?:\.\d+)*)?\.?\s+\S/u.test(region.text.trim()),
    )
    const rightAlignedPageNumbers = pageRegions.filter(
      (region) => /^\d{1,4}$/u.test(region.text.trim()) && region.box.x >= 0.65,
    )
    const entriesWithTrailingPageNumbers = pageRegions.filter((region) => {
      const trimmed = region.text.trim()
      if (!/^[A-Z](?:\.\d+(?:\.\d+)*)?\.?\s+\S/u.test(trimmed)) {
        return false
      }
      if (/\s\d{1,4}\s*$/u.test(trimmed)) return true
      return rightAlignedPageNumbers.some(
        (pageNumber) =>
          Math.abs(pageNumber.box.y - region.box.y) <= 0.006 &&
          pageNumber.box.x >= region.box.x + region.box.width + 0.02,
      )
    })
    return (
      dotLeaderEntries.length >= 2 || entriesWithTrailingPageNumbers.length >= 2
    )
  }
  const appendixContentsPages = new Set<number>()
  for (const marker of readingRegions.filter((region) =>
    /^appendix(?: contents)?$/iu.test(region.text.trim()),
  )) {
    for (let page = marker.page; regionsByPage.has(page); page += 1) {
      const pageRegions = regionsByPage.get(page)!
      const explicitContentsLabel =
        page === marker.page && /^appendix contents$/iu.test(marker.text.trim())
      if (
        !explicitContentsLabel &&
        !hasAppendixContentsStructure(pageRegions)
      ) {
        break
      }
      appendixContentsPages.add(page)
    }
  }
  const numberedCandidates = readingRegions.flatMap((region, index) => {
    const trimmed = region.text.trim()
    const match = trimmed.match(/^(\d+(?:\.\d+){0,3})[.)]?\s+(\S.*)$/u)
    const largestFont = Math.max(
      ...region.lines.map((line) => line.fontSize),
      bodySize,
    )
    const emphasizedShare = Math.max(
      ...region.lines.map((line) => emphasizedLineShare(line)),
      0,
    )
    const styledAsHeading =
      largestFont >= bodySize * 1.12 || emphasizedShare >= 0.6
    const partiallyStyledRunInLabel =
      largestFont < bodySize * 1.12 &&
      emphasizedShare >= 0.3 &&
      emphasizedShare < 0.98 &&
      /^\d+[.)]\s+.+:\s+(?:This|These|The|A|An|We|Our|It)$/u.test(trimmed)
    if (
      !match ||
      partiallyStyledRunInLabel ||
      /^(?:(?:https?:\/\/|www\.)|\S*[_@]\S*)/iu.test(match[2]) ||
      (/^\d+[.)]\s/u.test(trimmed) && !styledAsHeading) ||
      region.lines.length > 2 ||
      trimmed.length > 180 ||
      /[.!?](?:["'’”)\]]*)$/u.test(trimmed)
    ) {
      return []
    }
    return [
      {
        index,
        regionId: region.id,
        ordinal: match[1].split('.').map(Number),
        styledAsHeading,
      },
    ]
  })
  const sequencedNumberedHeadingRegions = new Set<PdfPageRegion>()
  const followsInSequence = (left: number[], right: number[]) =>
    left.length === right.length &&
    left.slice(0, -1).every((part, index) => part === right[index]) &&
    right.at(-1) === (left.at(-1) ?? 0) + 1
  const isDirectChild = (parent: number[], child: number[]) =>
    child.length === parent.length + 1 &&
    parent.every((part, index) => child[index] === part)
  const advancesToNextRoot = (left: number[], right: number[]) =>
    left.length > 1 && right.length === 1 && right[0] === (left[0] ?? 0) + 1
  for (let index = 0; index < numberedCandidates.length - 1; index += 1) {
    const current = numberedCandidates[index]
    const next = numberedCandidates[index + 1]
    if (
      next.index > current.index + 1 &&
      followsInSequence(current.ordinal, next.ordinal)
    ) {
      sequencedNumberedHeadingRegions.add(readingRegions[current.index])
      sequencedNumberedHeadingRegions.add(readingRegions[next.index])
    } else if (
      next.index > current.index + 1 &&
      current.styledAsHeading &&
      isDirectChild(current.ordinal, next.ordinal)
    ) {
      sequencedNumberedHeadingRegions.add(readingRegions[current.index])
      sequencedNumberedHeadingRegions.add(readingRegions[next.index])
    }
  }
  const letteredCandidates = readingRegions.flatMap((region, index) => {
    const trimmed = region.text.trim()
    const match = trimmed.match(
      /^([A-Z])(?:\.(\d+(?:\.\d+){0,2}))?\.?\s+\p{Lu}/u,
    )
    const styledAsHeading =
      Math.max(...region.lines.map((line) => line.fontSize), bodySize) >=
        bodySize * 1.12 ||
      sourceStyledLetteredSmallCapsHeading(region.lines[0]) ||
      region.lines.some((line) => emphasizedLineShare(line) >= 0.6)
    if (
      !match ||
      !styledAsHeading ||
      region.lines.length > 2 ||
      trimmed.length > 180 ||
      /[.!?](?:["'’”)\]]*)$/u.test(trimmed)
    ) {
      return []
    }
    return [
      {
        index,
        ordinal: [
          match[1].charCodeAt(0) - 'A'.charCodeAt(0) + 1,
          ...(match[2]?.split('.').map(Number) ?? []),
        ],
      },
    ]
  })
  const sequencedLetteredHeadingRegions = new Set<PdfPageRegion>()
  for (let index = 0; index < letteredCandidates.length; index += 1) {
    const current = letteredCandidates[index]
    const next = letteredCandidates
      .slice(index + 1)
      .find(
        (candidate) =>
          followsInSequence(current.ordinal, candidate.ordinal) ||
          isDirectChild(current.ordinal, candidate.ordinal) ||
          advancesToNextRoot(current.ordinal, candidate.ordinal),
      )
    if (!next) continue
    if (
      followsInSequence(current.ordinal, next.ordinal) ||
      advancesToNextRoot(current.ordinal, next.ordinal)
    ) {
      sequencedLetteredHeadingRegions.add(readingRegions[current.index])
      sequencedLetteredHeadingRegions.add(readingRegions[next.index])
    } else if (isDirectChild(current.ordinal, next.ordinal)) {
      sequencedLetteredHeadingRegions.add(readingRegions[current.index])
      sequencedLetteredHeadingRegions.add(readingRegions[next.index])
    }
  }
  const expandedReadingRegions = readingRegions.flatMap((region) => {
    if (bibliographyRegionIds.has(region.id) || residualFragments.has(region)) {
      return [region]
    }
    const compound = splitPdfCompoundAffiliationNote(
      region,
      lineBoundaryDecisions,
    )
    if (!compound) return [region]
    return [
      ...compound.affiliations,
      ...(compound.correspondence ? [compound.correspondence] : []),
    ].map((segment) => {
      const selectedLines = segment.sourceLineIds.length
        ? region.lines.filter((line) => segment.sourceLineIds.includes(line.id))
        : region.lines
      const text =
        segment.label === 'Correspondence'
          ? `Correspondence to: ${segment.text}`
          : `${segment.markerText} ${segment.text}`
      return {
        ...region,
        text,
        lines: selectedLines,
        ...(selectedLines.length > 0
          ? { box: boxForRegionLines(selectedLines) }
          : {}),
      }
    })
  })
  const initialBlocks = expandedReadingRegions.map<RegionBlock>(
    (region, regionIndex) => {
      const residualFragment = residualFragments.get(region)
      const sourceSegments = residualFragment
        ? [
            {
              region: residualFragment.sourceRegion,
              evidenceRegion: region,
              sourceStart: residualFragment.sourceStart,
              canonicalStart: 0,
              text: region.text,
            },
          ]
        : undefined
      if (region.kind === 'caption') {
        return {
          type: 'caption',
          region,
          text: region.text,
          confidence: region.confidence,
          ...(sourceSegments ? { sourceSegments } : {}),
        }
      }
      if (region.kind === 'equation' && sourceEquationCaptions.has(region.id)) {
        return {
          type: 'caption',
          region,
          text: sourceEquationCaptions.get(region.id)!,
          confidence: region.confidence,
          suppressSourceInlineRuns: true,
        }
      }
      if (
        (region.kind === 'footnote' || region.kind === 'endnote') &&
        !bibliographyRegionIds.has(region.id)
      ) {
        const correspondence = region.text.match(
          /^Correspondence\s+to\s*:\s*(.+)$/iu,
        )
        const label = correspondence
          ? 'Correspondence'
          : (noteLabelFromText(region.text) ?? '?')
        const text = correspondence?.[1]?.trim() ?? noteText(region, label)
        const sourceSegments = exactCanonicalSubtextSourceSegment(region, text)
        return {
          type: 'footnote',
          region,
          text,
          confidence: region.confidence,
          noteKind: region.kind,
          noteLabel: label,
          noteMarkerText: correspondence
            ? 'Correspondence'
            : noteMarkerText(region, label),
          ...(sourceSegments ? { sourceSegments } : {}),
        }
      }
      const largestFont = Math.max(
        ...region.lines.map((line) => line.fontSize),
        bodySize,
      )
      const styledRuns = region.lines.flatMap((line) =>
        line.runs.filter((run) => run.text.trim()),
      )
      const emphasizedCharacters = styledRuns.reduce(
        (total, run) =>
          total +
          (run.bold || fontNameIndicatesEmphasizedFace(run.fontName)
            ? run.text.trim().length
            : 0),
        0,
      )
      const visibleCharacters = styledRuns.reduce(
        (total, run) => total + run.text.trim().length,
        0,
      )
      const representativeFontSize = (() => {
        const weightedSizes = styledRuns
          .map((run) => ({
            size: run.fontSize,
            weight: run.text.replace(/\s/gu, '').length,
          }))
          .filter(({ size, weight }) => size > 0 && weight > 0)
          .sort((left, right) => left.size - right.size)
        const midpoint =
          weightedSizes.reduce((total, run) => total + run.weight, 0) / 2
        let cumulative = 0
        for (const run of weightedSizes) {
          cumulative += run.weight
          if (cumulative >= midpoint) return run.size
        }
        return largestFont
      })()
      const sourceStyledLetteredHeading =
        region.lines.length === 1 &&
        sourceStyledLetteredSmallCapsHeading(region.lines[0])
      const sourceStyledNamedBoundaryHeading =
        sourceStyledStandaloneBoundaryHeading(region, readingRegions)
      const appendixContentsEntry =
        appendixContentsPages.has(region.page) &&
        /^[A-Z](?:\.\d+(?:\.\d+)*)?\.?\s+\S/u.test(region.text.trim())
      const alignedTabularHeaderPeers = readingRegions.filter(
        (peer) =>
          peer !== region &&
          peer.page === region.page &&
          ['body', 'spanning'].includes(peer.kind) &&
          Math.abs(peer.box.y - region.box.y) <= 0.004,
      )
      const alignedTabularHeaderPeerCount = alignedTabularHeaderPeers.length
      const alignedExcludedTableLabelPeerCount = regions.filter(
        (peer) =>
          peer.page === region.page &&
          peer.kind === 'chart-label' &&
          Math.abs(peer.box.y - region.box.y) <= 0.004,
      ).length
      const nearbyTableCaption = readingRegions.some((peer) => {
        const label = parsePdfScholarlyVisualLabel(peer.text, {
          context: 'caption',
        })
        return (
          peer.page === region.page &&
          (peer.column === region.column ||
            peer.column === 'span' ||
            region.column === 'span' ||
            (peer.column === 'single' && region.column === 'single')) &&
          peer.box.y <= region.box.y &&
          region.box.y - (peer.box.y + peer.box.height) <= 0.12 &&
          label?.kind === 'table'
        )
      })
      const allAlignedPeersAreStructural =
        structuralOrdinalHeadingText(region.text) &&
        alignedTabularHeaderPeers.every((peer) =>
          structuralOrdinalHeadingText(peer.text),
        )
      const probableTabularColumnHeader =
        alignedExcludedTableLabelPeerCount >= 2 ||
        (!allAlignedPeersAreStructural &&
          (alignedTabularHeaderPeerCount >= 2 ||
            (nearbyTableCaption && alignedTabularHeaderPeerCount >= 1)))
      const compactEquationSyntax = (() => {
        if (region.kind !== 'equation' || !/[=+−×÷∫∑√≤≥≈]/u.test(region.text)) {
          return false
        }
        const words = region.text.match(/\p{L}+/gu) ?? []
        return (
          words.length <= 6 &&
          words.filter((word) => word.length > 2).length <= 1
        )
      })()
      const emphasizedNumberedHeading =
        emphasizedCharacters >= Math.max(1, visibleCharacters * 0.6) &&
        /^\d+(?:\.\d+){0,3}[.)]?\s+\p{Lu}/u.test(region.text.trim()) &&
        (!/^\d+[.)]\s/u.test(region.text.trim()) ||
          largestFont >= bodySize * 1.12)
      const emphasizedLetteredHeading =
        emphasizedCharacters >= Math.max(1, visibleCharacters * 0.6) &&
        /^(?:[A-Z]\.\s+|[A-Z](?:\.\d+)+\.?\s+)\p{Lu}/u.test(region.text.trim())
      const namedSectionPrefix =
        /^(?:abstract|introduction|methods?|results?|discussion|conclusion|references|acknowledg(?:e)?ments?|ethics statement|impact statement|broader impacts?|limitations?|endnotes?|notes?)\b/i.test(
          region.text,
        )
      const namedSectionHeading =
        namedSectionPrefix &&
        (/^(?:abstract|introduction|methods?|results?|discussion|conclusion|references|acknowledg(?:e)?ments?|ethics statement|impact statement|broader impacts?|limitations?|endnotes?|notes?)$/i.test(
          region.text.trim(),
        ) ||
          emphasizedCharacters >= Math.max(1, visibleCharacters * 0.6))
      const numberedSectionHeading =
        /^\d+(?:\.\d+){0,3}[.)]?\s+(?:abstract|introduction|background|related work|literature review|methods?|methodology|approach|framework|experiments?|evaluation|results?|discussion|limitations?|conclusion|references|appendix)\b/i.test(
          region.text.trim(),
        )
      const sourceStyledWrappedStructuralHeading =
        region.lines.length <= 3 &&
        region.lines.every((line) => emphasizedLineShare(line) >= 0.6) &&
        /^(?:\d+(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?\s+\p{Lu}/u.test(
          region.text.trim(),
        )
      const headingBoundaryEvidence =
        (region.lines.length <= 2 || sourceStyledWrappedStructuralHeading) &&
        region.text.trim().length <= 180 &&
        (sourceStyledLetteredHeading ||
          !/[.](?:["'’”)]*)$/.test(region.text.trim()) ||
          emphasizedNumberedHeading ||
          emphasizedLetteredHeading)
      const probableFirstPageAuthorLine =
        region.page === 1 &&
        regionIndex > 0 &&
        region.box.y < 0.28 &&
        !/[.!?](?:\s|$)/.test(region.text) &&
        authorNamesFromLine(region.text).length > 0
      const fontOnlyHeading =
        region.text.trim().length > 1 &&
        representativeFontSize >= bodySize * 1.18 &&
        (/^\p{Lu}/u.test(region.text.trim()) ||
          /^\d+(?:\.\d+){1,3}\s+\p{Lu}/u.test(region.text.trim()) ||
          compactEquationSyntax) &&
        !/[,;]/u.test(region.text) &&
        (!explicitSectionHierarchy ||
          /^\d+(?:\.\d+){0,3}[.)]?\s+\p{Lu}/u.test(region.text.trim()) ||
          /^[A-Z](?:\.\d+)+\.?\s+\p{Lu}/u.test(region.text.trim()) ||
          sequencedLetteredHeadingRegions.has(region) ||
          namedSectionPrefix)
      const heading =
        !probableFirstPageAuthorLine &&
        !appendixContentsEntry &&
        !probableTabularColumnHeader &&
        headingBoundaryEvidence &&
        (namedSectionHeading ||
          numberedSectionHeading ||
          emphasizedNumberedHeading ||
          emphasizedLetteredHeading ||
          sourceStyledLetteredHeading ||
          sourceStyledNamedBoundaryHeading ||
          sequencedNumberedHeadingRegions.has(region) ||
          sequencedLetteredHeadingRegions.has(region) ||
          fontOnlyHeading)
      return {
        type: heading ? 'heading' : 'paragraph',
        region,
        text: region.text,
        confidence: Math.min(region.confidence, heading ? 0.9 : 0.86),
        ...(sourceSegments ? { sourceSegments } : {}),
        ...(heading
          ? {
              headingLevel: sourceStyledNamedBoundaryHeading
                ? (1 as const)
                : headingLevel(region.text, largestFont, bodySize),
            }
          : {}),
      }
    },
  )
  promoteAdjacentNumberedParentChildHeadings(initialBlocks, bodySize)
  const bibliographyScopeRegionIds = new Set(bibliographyRegionIds)
  const blocks = recoverBibliographyBlocks(
    initialBlocks,
    bibliographyScopeRegionIds,
    lineBoundaryDecisions,
    diagnostics,
  )
  splitListItemTailParagraphs(blocks, lineBoundaryDecisions)

  let activeList:
    | {
        page: number
        column: PdfPageRegion['column']
        baseX: number
        numberingId: string
        ordered: boolean
        markerStyle: NonNullable<RegionBlock['list']>['markerStyle']
        lastOrdinal?: number
      }
    | undefined
  let lastBibliographyEntryPage: number | undefined
  let pendingBibliographyContinuation:
    { target: RegionBlock; tailPage: number } | undefined
  let activeNumberedBibliographyEntry: RegionBlock | undefined
  let lastListBlock: RegionBlock | undefined
  const mergedContinuationBlocks = new Set<RegionBlock>()
  const listCounts = new Map<number, number>()
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]
    if (block.type !== 'paragraph') {
      lastBibliographyEntryPage = undefined
      pendingBibliographyContinuation = undefined
      activeNumberedBibliographyEntry = undefined
      activeList = undefined
      lastListBlock = undefined
      continue
    }
    const bibliography = bibliographyScopeRegionIds.has(block.region.id)
    if (bibliography) {
      const entry = parsedBibliographyListMarker(block.text)
      const numberedContinuationTarget =
        activeNumberedBibliographyEntry ??
        pendingBibliographyContinuation?.target
      const continuationProof =
        !entry && numberedContinuationTarget
          ? provenBibliographyContinuation(numberedContinuationTarget, block)
          : null
      if (continuationProof === 'same-page' && numberedContinuationTarget) {
        appendBlockContinuation(
          numberedContinuationTarget,
          block,
          bibliographyContinuationSeparator(numberedContinuationTarget, block),
        )
        mergedContinuationBlocks.add(block)
        lastBibliographyEntryPage = block.region.page
        if (pendingBibliographyContinuation) {
          pendingBibliographyContinuation.tailPage = block.region.page
        }
        activeList = undefined
        continue
      }
      if (
        continuationProof === 'adjacent-page' &&
        numberedContinuationTarget &&
        pendingBibliographyContinuation &&
        pendingBibliographyContinuation.target === numberedContinuationTarget
      ) {
        appendBlockContinuation(
          numberedContinuationTarget,
          block,
          bibliographyContinuationSeparator(numberedContinuationTarget, block),
        )
        mergedContinuationBlocks.add(block)
        lastBibliographyEntryPage = block.region.page
        pendingBibliographyContinuation.tailPage = block.region.page
        activeList = undefined
        continue
      }
      if (
        !entry &&
        numberedContinuationTarget &&
        !continuationProof &&
        bibliographyContinuationFormEvidence(numberedContinuationTarget, block)
      ) {
        recordUncertainBibliographyBoundary(
          diagnostics,
          numberedContinuationTarget,
          block,
        )
      }
      pendingBibliographyContinuation = undefined
      if (entry) stripBlockMarker(block, entry)
      const continuedFromPreviousPage =
        lastBibliographyEntryPage !== undefined &&
        block.region.page > lastBibliographyEntryPage
      block.list = {
        level: 1,
        ordered: Boolean(entry),
        numberingId: 'references',
        markerStyle: entry?.markerStyle ?? 'disc',
        ...(entry
          ? { ordinal: entry.ordinal, markerText: entry.markerText }
          : {}),
        ...(continuedFromPreviousPage
          ? { continuedFromPreviousPage: true }
          : block.bibliographyContinuedFromPreviousPage
            ? { continuedFromPreviousPage: true }
            : {}),
      }
      lastBibliographyEntryPage = block.region.page
      if (entry) {
        pendingBibliographyContinuation = {
          target: block,
          tailPage: block.region.page,
        }
        activeNumberedBibliographyEntry = block
      } else {
        activeNumberedBibliographyEntry = undefined
      }
      activeList = undefined
      lastListBlock = entry ? block : undefined
      continue
    }
    lastBibliographyEntryPage = undefined
    pendingBibliographyContinuation = undefined
    activeNumberedBibliographyEntry = undefined
    let ordered = parsedOrderedListMarker(block.text)
    const precedingBlock = blocks[blockIndex - 1]
    if (
      flowingParenthesizedDecimalEnumerationContinuation(
        precedingBlock,
        block,
        ordered,
      ) ||
      flowingSuffixedDecimalEnumerationContinuation(
        precedingBlock,
        block,
        ordered,
      ) ||
      flowingSentenceFinalMathVariableContinuation(
        precedingBlock,
        block,
        ordered,
      )
    ) {
      appendBlockContinuation(precedingBlock!, block)
      mergedContinuationBlocks.add(block)
      activeList = undefined
      lastListBlock = undefined
      continue
    }
    if (
      ordered &&
      /^\[\s*\d+\s*\]$/u.test(ordered.markerText) &&
      citationLedRegionIds.has(block.region.id)
    ) {
      ordered = null
    }
    if (
      ordered &&
      precedingBlock?.type === 'paragraph' &&
      detachedScholarlyReferenceContinuation(precedingBlock.text, block.text)
    ) {
      appendBlockContinuation(precedingBlock, block)
      mergedContinuationBlocks.add(block)
      activeList = undefined
      lastListBlock = undefined
      continue
    }
    if (!activeList && ambiguousParenthesizedRomanListMarker(ordered)) {
      const nextBlock = blocks[blockIndex + 1]
      const nextMarker =
        nextBlock?.type === 'paragraph' &&
        !bibliographyRegionIds.has(nextBlock.region.id)
          ? parsedOrderedListMarker(nextBlock.text)
          : null
      const sourceBackedSequence = Boolean(
        nextMarker &&
        ambiguousParenthesizedRomanListMarker(nextMarker) &&
        nextMarker.ordinal === ordered!.ordinal + 1 &&
        (nextBlock.region.page !== block.region.page ||
          nextBlock.region.column === block.region.column),
      )
      if (!sourceBackedSequence) ordered = null
    }
    let bullet = parsedBulletListMarker(block.text)
    if (bullet && !activeList && /^[–—-]$/u.test(bullet.markerText)) {
      const nextBlock = blocks[blockIndex + 1]
      const nextBullet =
        nextBlock?.type === 'paragraph'
          ? parsedBulletListMarker(nextBlock.text)
          : null
      const sourceBackedSequence = Boolean(
        nextBullet &&
        nextBlock?.region.column === block.region.column &&
        (nextBlock.region.page === block.region.page ||
          nextBlock.region.page === block.region.page + 1),
      )
      const introducedIndentedItem = Boolean(
        precedingBlock?.type === 'paragraph' &&
        /:\s*$/u.test(precedingBlock.text) &&
        block.region.box.x > precedingBlock.region.box.x + 0.012,
      )
      if (!sourceBackedSequence && !introducedIndentedItem) bullet = null
    }
    const marker = ordered
    const itemText = ordered?.itemText ?? bullet?.itemText
    if (!itemText) {
      const continuationStartBox =
        block.region.lines[0]?.box ?? block.region.box
      const targetTailSegment = lastListBlock
        ? blockSourceSegments(lastListBlock).at(-1)
        : undefined
      const targetTailRegion =
        targetTailSegment?.evidenceRegion ?? targetTailSegment?.region
      const samePageVerticalGap = targetTailRegion
        ? continuationStartBox.y -
          (targetTailRegion.box.y + targetTailRegion.box.height)
        : Number.POSITIVE_INFINITY
      const samePageIndentedContinuation = Boolean(
        activeList &&
        block.region.page === activeList.page &&
        block.region.column === activeList.column &&
        continuationStartBox.x > activeList.baseX + 0.012 &&
        samePageVerticalGap >= -0.004 &&
        samePageVerticalGap <= 0.03,
      )
      const crossPageContinuation = Boolean(
        activeList &&
        block.region.page > activeList.page &&
        block.region.box.x >= activeList.baseX - 0.012,
      )
      const nextListBlock = blocks[blockIndex + 1]
      const nextOrderedMarker =
        nextListBlock?.type === 'paragraph' &&
        !bibliographyScopeRegionIds.has(nextListBlock.region.id)
          ? parsedOrderedListMarker(nextListBlock.text)
          : null
      const targetTailLine = targetTailRegion?.lines.at(-1)
      const continuationHeadLine = block.region.lines[0]
      const continuationFontRatio =
        targetTailLine && continuationHeadLine
          ? Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
            Math.max(
              1,
              Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
            )
          : Number.POSITIVE_INFINITY
      const samePageFlushContinuationBeforeNextMarker = Boolean(
        activeList &&
        lastListBlock &&
        activeList.ordered &&
        activeList.lastOrdinal !== undefined &&
        nextOrderedMarker &&
        nextOrderedMarker.markerStyle === activeList.markerStyle &&
        nextOrderedMarker.ordinal === activeList.lastOrdinal + 1 &&
        nextListBlock?.region.page === block.region.page &&
        nextListBlock.region.column === block.region.column &&
        block.region.page === activeList.page &&
        block.region.column === activeList.column &&
        Math.abs(continuationStartBox.x - activeList.baseX) <= 0.012 &&
        samePageVerticalGap >= -0.004 &&
        samePageVerticalGap <= 0.03 &&
        continuationFontRatio <= 1.12,
      )
      if (
        activeList &&
        lastListBlock &&
        (samePageIndentedContinuation ||
          samePageFlushContinuationBeforeNextMarker ||
          crossPageContinuation) &&
        likelyUnmarkedCrossPageContinuation(lastListBlock, block)
      ) {
        appendBlockContinuation(lastListBlock, block)
        mergedContinuationBlocks.add(block)
        activeList.page = block.region.page
        activeList.column = block.region.column
        continue
      }
      activeList = undefined
      lastListBlock = undefined
      continue
    }
    const continuesAcrossPage = Boolean(
      activeList &&
      activeList.page !== block.region.page &&
      activeList.ordered &&
      marker &&
      activeList.markerStyle === marker.markerStyle &&
      activeList.lastOrdinal !== undefined &&
      marker.ordinal > activeList.lastOrdinal,
    )
    const isNestedItem = Boolean(
      activeList &&
      activeList.page === block.region.page &&
      activeList.column === block.region.column &&
      block.region.box.x > activeList.baseX + 0.012,
    )
    const continuesCurrentList = Boolean(
      activeList &&
      (isNestedItem ||
        ((activeList.page === block.region.page || continuesAcrossPage) &&
          (activeList.page !== block.region.page ||
            activeList.column === block.region.column) &&
          activeList.ordered === Boolean(ordered) &&
          activeList.markerStyle === (marker?.markerStyle ?? 'disc') &&
          (!marker ||
            activeList.lastOrdinal === undefined ||
            marker.ordinal > activeList.lastOrdinal))),
    )
    if (!continuesCurrentList) {
      const sequence = (listCounts.get(block.region.page) ?? 0) + 1
      listCounts.set(block.region.page, sequence)
      activeList = {
        page: block.region.page,
        column: block.region.column,
        baseX: block.region.box.x,
        numberingId: `pdf-list-p${String(block.region.page).padStart(3, '0')}-${String(sequence).padStart(3, '0')}`,
        ordered: Boolean(ordered),
        markerStyle: marker?.markerStyle ?? 'disc',
        lastOrdinal: marker?.ordinal,
      }
    } else if (activeList && !isNestedItem) {
      activeList.page = block.region.page
      activeList.column = block.region.column
      activeList.lastOrdinal = marker?.ordinal
    }
    const list = activeList
    if (!list) continue
    const indentation = Math.max(0, block.region.box.x - list.baseX)
    stripBlockMarker(block, ordered ?? bullet!)
    block.list = {
      level: Math.min(9, Math.max(1, Math.round(indentation / 0.025) + 1)),
      ordered: Boolean(ordered),
      numberingId: list.numberingId,
      markerStyle: marker?.markerStyle ?? 'disc',
      ...(marker ? { ordinal: marker.ordinal } : {}),
      ...(ordered
        ? { markerText: ordered.markerText }
        : bullet
          ? { markerText: bullet.markerText }
          : {}),
      ...(continuesAcrossPage ? { continuedFromPreviousPage: true } : {}),
    }
    lastListBlock = block
  }
  return blocks.filter((block) => !mergedContinuationBlocks.has(block))
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

function detectReferences(
  classifications: PdfNoteMarkerClassification[],
  regionMap: ReadonlyMap<string, PdfPageRegion>,
) {
  return classifications.flatMap<NoteReferenceDraft>((classification) => {
    if (classification.disposition !== 'note-reference') return []
    const region = regionMap.get(classification.referenceRegionId)
    if (!region) return []
    return [
      {
        id: classification.id,
        label: classification.label,
        region,
        start: classification.start,
        end: classification.end,
        classification,
        canonicalAnchor: null,
      },
    ]
  })
}

function exactAuthorSpans(block: RegionBlock) {
  return authorNamesFromBlock(block).flatMap((author) => {
    const occurrences: Array<{ author: string; start: number; end: number }> =
      []
    let cursor = 0
    while (cursor < block.text.length) {
      const start = block.text.indexOf(author, cursor)
      if (start < 0) break
      const end = start + author.length
      const before = block.text.slice(Math.max(0, start - 1), start)
      const after = block.text.slice(end, end + 1)
      if (!/\p{L}/u.test(before) && !/\p{L}/u.test(after)) {
        occurrences.push({ author, start, end })
      }
      cursor = Math.max(end, start + 1)
    }
    return occurrences.length === 1 ? occurrences : []
  })
}

function detectAuthorNoteReferences(
  blocks: RegionBlock[],
  classifications: PdfNoteMarkerClassification[],
): AuthorNoteReferenceDraft[] {
  const classificationsByRegion = new Map<
    string,
    PdfNoteMarkerClassification[]
  >()
  for (const classification of classifications) {
    if (
      !classification.accepted ||
      classification.disposition !== 'note-reference'
    ) {
      continue
    }
    const values =
      classificationsByRegion.get(classification.referenceRegionId) ?? []
    values.push(classification)
    classificationsByRegion.set(classification.referenceRegionId, values)
  }
  return blocks.flatMap((block) => {
    if (block.frontMatterRole !== 'author') return []
    const authorSpans = exactAuthorSpans(block).sort(
      (left, right) => left.start - right.start || left.end - right.end,
    )
    return (classificationsByRegion.get(block.region.id) ?? []).flatMap(
      (classification) => {
        const sourceMarker = block.text.slice(
          classification.start,
          classification.end,
        )
        if (
          classification.start < 0 ||
          classification.end > block.text.length ||
          normalizedNoteLabel(sourceMarker) !==
            normalizedNoteLabel(classification.label)
        ) {
          return []
        }
        const preceding = authorSpans.filter(
          (span) => span.end <= classification.start,
        )
        const owner = preceding.at(-1)
        if (!owner) return []
        const markerPrefix = block.text.slice(owner.end, classification.start)
        if (!/^[\s,;–—\-\d⁰¹²³⁴⁵⁶⁷⁸⁹*∗†‡§]*$/u.test(markerPrefix)) {
          return []
        }
        const nextAuthor = authorSpans.find((span) => span.start > owner.start)
        if (nextAuthor && classification.start >= nextAuthor.start) return []
        return [
          {
            id: classification.id,
            label: classification.label,
            author: owner.author,
            region: block.region,
            start: classification.start,
            end: classification.end,
            classification,
            canonicalAnchor: null,
          },
        ]
      },
    )
  })
}

function detectAuthorAffiliationReferences(
  blocks: RegionBlock[],
  classifications: PdfNoteMarkerClassification[],
) {
  const classificationsByRegion = new Map<
    string,
    PdfNoteMarkerClassification[]
  >()
  for (const classification of classifications) {
    if (
      !classification.accepted ||
      classification.taxonomy !== 'author-affiliation-superscript'
    ) {
      continue
    }
    const values =
      classificationsByRegion.get(classification.referenceRegionId) ?? []
    values.push(classification)
    classificationsByRegion.set(classification.referenceRegionId, values)
  }
  return blocks.flatMap((block) => {
    if (block.frontMatterRole !== 'author') return []
    const authorSpans = exactAuthorSpans(block).sort(
      (left, right) => left.start - right.start || left.end - right.end,
    )
    return (classificationsByRegion.get(block.region.id) ?? []).flatMap(
      (classification) => {
        const sourceMarker = block.text.slice(
          classification.start,
          classification.end,
        )
        if (
          classification.start < 0 ||
          classification.end > block.text.length ||
          normalizedNoteLabel(sourceMarker) !==
            normalizedNoteLabel(classification.label)
        ) {
          return []
        }
        const owner = authorSpans
          .filter((span) => span.end <= classification.start)
          .at(-1)
        if (!owner) return []
        const markerPrefix = block.text.slice(owner.end, classification.start)
        if (!/^[\s,;–—\-\d⁰¹²³⁴⁵⁶⁷⁸⁹*∗†‡§]*$/u.test(markerPrefix)) {
          return []
        }
        const nextAuthor = authorSpans.find((span) => span.start > owner.start)
        if (nextAuthor && classification.start >= nextAuthor.start) return []
        return [{ author: owner.author, label: classification.label }]
      },
    )
  })
}

function semanticRoleForClassification(
  classification: PdfNoteMarkerClassification,
): SemanticReferenceDraft['semanticRole'] | undefined {
  if (classification.disposition === 'citation') return 'citation'
  if (
    classification.taxonomy === 'equation-reference' ||
    classification.taxonomy === 'section-reference'
  ) {
    return 'cross-reference'
  }
  if (classification.taxonomy === 'author-affiliation-superscript') {
    return 'affiliation-marker'
  }
  if (classification.taxonomy === 'bibliography-entry') {
    return 'bibliography-entry'
  }
  return undefined
}

function normalizedAuthorYearCitationKey(surname: string, year: string) {
  const normalizedSurname = surname
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/’/gu, "'")
    .toLowerCase()
  return `${normalizedSurname}:${year.toLowerCase()}`
}

function bibliographyFirstAuthorSurname(text: string) {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return (
    normalized.match(/^(\p{Lu}[\p{L}\p{M}'’.-]*)(?=\s*,|\s+et\s+al\.)/u)?.[1] ??
    normalized.match(
      /^(?:\p{Lu}[\p{L}\p{M}'’.-]*\s+)+(\p{Lu}[\p{L}\p{M}'’.-]*)(?=\s*,)/u,
    )?.[1]
  )
}

function bibliographyYearCandidates(text: string) {
  const paginationYearOffsets = new Set<number>()
  for (const match of text.matchAll(
    /(?:\b\d{1,4}\s*:|\bpp?\.?\s+|\bpages?\s+)((?:18|19|20)\d{2})\s*[–—-]\s*((?:18|19|20)\d{2})\b/giu,
  )) {
    const matchStart = match.index ?? 0
    const firstLocalOffset = match[0].indexOf(match[1])
    const secondLocalOffset = match[0].indexOf(
      match[2],
      firstLocalOffset + match[1].length,
    )
    paginationYearOffsets.add(matchStart + firstLocalOffset)
    paginationYearOffsets.add(matchStart + secondLocalOffset)
  }
  return [
    ...new Set(
      [...text.matchAll(/\b((?:18|19|20)\d{2}[a-z]?)\b/gu)]
        .filter((match) => !paginationYearOffsets.has(match.index ?? 0))
        .map((match) => match[1].toLowerCase()),
    ),
  ]
}

function bibliographyPublicationYear(text: string) {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  const beforeExternalIdentifier =
    normalized.split(
      /\b(?:URL|doi|https?:|www\.|arXiv(?:\s+preprint)?(?:\s+arXiv:)?|abs\/)/iu,
      1,
    )[0] ?? ''
  const yearsBeforeExternalIdentifier = bibliographyYearCandidates(
    beforeExternalIdentifier,
  )
  if (yearsBeforeExternalIdentifier.length === 1) {
    return yearsBeforeExternalIdentifier[0]
  }
  if (yearsBeforeExternalIdentifier.length > 1) {
    const suffixedYears = yearsBeforeExternalIdentifier.filter((year) =>
      /[a-z]$/u.test(year),
    )
    const suffixedYear = suffixedYears.length === 1 ? suffixedYears[0] : null
    if (
      suffixedYear &&
      yearsBeforeExternalIdentifier.every(
        (year) => year.replace(/[a-z]$/u, '') === suffixedYear.slice(0, -1),
      )
    ) {
      return suffixedYear
    }
    return null
  }
  const allYears = bibliographyYearCandidates(normalized)
  return allYears.length === 1 ? allYears[0] : null
}

function bibliographyAuthorYearKey(text: string) {
  const surname = bibliographyFirstAuthorSurname(text)
  const year = bibliographyPublicationYear(text)
  return surname && year ? normalizedAuthorYearCitationKey(surname, year) : null
}

function buildCitationRelationships(
  classifications: PdfNoteMarkerClassification[],
  blocks: RegionBlock[],
) {
  const blocksBySourceRegion = new Map<string, RegionBlock[]>()
  for (const block of blocks) {
    for (const regionId of new Set(
      blockSourceSegments(block).map((segment) => segment.region.id),
    )) {
      const owners = blocksBySourceRegion.get(regionId) ?? []
      owners.push(block)
      blocksBySourceRegion.set(regionId, owners)
    }
  }
  const bibliographyTargets = new Map<string, string>()
  for (const classification of classifications.filter(
    (candidate) => candidate.taxonomy === 'bibliography-entry',
  )) {
    const owners =
      blocksBySourceRegion.get(classification.referenceRegionId) ?? []
    const bibliographyOrdinal = /^\d+$/.test(classification.label)
      ? Number(classification.label)
      : null
    const markerOwners = owners.filter(
      (block) =>
        block.list?.numberingId === 'references' &&
        ((bibliographyOrdinal !== null &&
          block.list.ordinal === bibliographyOrdinal) ||
          normalizedNoteLabel(block.list.markerText ?? '') ===
            normalizedNoteLabel(classification.label)),
    )
    const target = (
      markerOwners.length === 1
        ? markerOwners[0]
        : owners.length === 1
          ? owners[0]
          : undefined
    )?.nodeId
    if (!target) continue
    for (const label of classification.label.split(',')) {
      if (!bibliographyTargets.has(label))
        bibliographyTargets.set(label, target)
    }
  }
  const authorYearTargets = new Map<string, string[]>()
  const storeAuthorYearTarget = (key: string, nodeId: string) => {
    const targets = authorYearTargets.get(key) ?? []
    if (!targets.includes(nodeId)) targets.push(nodeId)
    authorYearTargets.set(key, targets)
  }
  for (const [index, block] of blocks.entries()) {
    if (block.list?.numberingId !== 'references' || !block.nodeId) continue
    const key = bibliographyAuthorYearKey(block.text)
    if (key) storeAuthorYearTarget(key, block.nodeId)
    const continuation = blocks[index + 1]
    const continuationIndentation = continuation
      ? continuation.region.box.x - block.region.box.x
      : 0
    if (
      key ||
      !bibliographyFirstAuthorSurname(block.text) ||
      continuation?.list?.numberingId !== 'references' ||
      !continuation.list.continuedFromPreviousPage ||
      continuationIndentation < 0.008 ||
      continuationIndentation > 0.04
    ) {
      continue
    }
    const continuedKey = bibliographyAuthorYearKey(
      `${block.text} ${continuation.text}`,
    )
    if (continuedKey) storeAuthorYearTarget(continuedKey, block.nodeId)
  }

  return classifications.flatMap<PdfCitationRelationship>((classification) => {
    if (!classification.accepted || classification.disposition !== 'citation')
      return []
    const labels = classification.label.split(',').filter(Boolean)
    if (classification.taxonomy === 'author-year-bibliography-citation') {
      const candidates = labels.map(
        (label) => authorYearTargets.get(label) ?? [],
      )
      const missing = candidates.some((targets) => targets.length === 0)
      const ambiguous = candidates.some((targets) => targets.length > 1)
      const status = !missing && !ambiguous ? 'matched' : 'unresolved'
      const targetNodeIds =
        status === 'matched'
          ? [...new Set(candidates.map((targets) => targets[0]))]
          : []
      return [
        {
          id: classification.id,
          label: classification.label,
          labels,
          referenceRegionId: classification.referenceRegionId,
          referenceStart: classification.start,
          referenceEnd: classification.end,
          taxonomy: classification.taxonomy,
          targetNodeIds,
          status,
          canonicalAnchor: null,
          confidence: classification.confidence,
          evidence: [
            ...classification.evidence,
            ...(ambiguous
              ? ['bibliography-author-year-target-ambiguous']
              : missing
                ? ['bibliography-author-year-target-missing']
                : ['bibliography-author-year-key-unique']),
          ],
          sourceBoxes: [{ ...classification.sourceBox }],
        },
      ]
    }
    const targetNodeIds = labels.flatMap((label) => {
      const target = bibliographyTargets.get(label)
      return target ? [target] : []
    })
    const status =
      targetNodeIds.length === labels.length ? 'matched' : 'unresolved'
    return [
      {
        id: classification.id,
        label: classification.label,
        labels,
        referenceRegionId: classification.referenceRegionId,
        referenceStart: classification.start,
        referenceEnd: classification.end,
        taxonomy:
          classification.taxonomy as PdfCitationRelationship['taxonomy'],
        targetNodeIds: [...new Set(targetNodeIds)],
        status,
        canonicalAnchor: null,
        confidence: classification.confidence,
        evidence: [
          ...classification.evidence,
          ...(status === 'matched'
            ? ['bibliography-label-target']
            : ['bibliography-label-target-missing']),
        ],
        sourceBoxes: [{ ...classification.sourceBox }],
      },
    ]
  })
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
    const canonicalAnchorMissing = reference.canonicalAnchor === null
    const matched =
      Boolean(best) &&
      best.score >= PDF_NOTE_RELATIONSHIP_THRESHOLD &&
      !ambiguous &&
      !canonicalAnchorMissing
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
        target: {
          regionIds: [
            reference.region.id,
            ...candidates.map((candidate) => candidate.targetRegionId),
          ],
          markerId: reference.id,
        },
      })
    } else if (!matched) {
      diagnostics.push({
        code: 'UNRESOLVED_NOTE_REFERENCE',
        severity: 'error',
        page: reference.region.page,
        message:
          canonicalAnchorMissing && best
            ? `Note reference ${reference.id} has a label-matched target but no exact canonical source anchor.`
            : `Note reference ${reference.id} has no deterministic target at or above the ${PDF_NOTE_RELATIONSHIP_THRESHOLD.toFixed(2)} confidence threshold.`,
        relationshipId: reference.id,
        sourceBoxes: [
          reference.region.box,
          ...candidates.map((candidate) => candidate.sourceBoxes[1]),
        ],
        target: {
          regionIds: [reference.region.id],
          markerId: reference.id,
        },
      })
    }
    return {
      id: reference.id,
      label: reference.label,
      referenceRegionId: reference.region.id,
      referenceStart: reference.start,
      referenceEnd: reference.end,
      targetNoteId: matched ? best.targetNoteId : null,
      status: ambiguous ? 'ambiguous' : matched ? 'matched' : 'unresolved',
      canonicalAnchor: reference.canonicalAnchor,
      confidence: best?.score ?? 0,
      threshold: PDF_NOTE_RELATIONSHIP_THRESHOLD,
      evidence: [
        ...(best?.evidence ?? ['no-label-match']),
        ...(canonicalAnchorMissing ? ['canonical-anchor-missing'] : []),
      ],
      candidates,
      sourceBoxes: matched ? best.sourceBoxes : [reference.region.box],
    }
  })

  const referencedNotes = new Set(
    relationships.flatMap((relationship) =>
      relationship.status === 'matched'
        ? [relationship.targetNoteId]
        : relationship.status === 'ambiguous'
          ? relationship.candidates.map((candidate) => candidate.targetNoteId)
          : [],
    ),
  )
  for (const note of notes) {
    if (
      referencedNotes.has(note.nodeId!) ||
      (note.noteLabel === 'Correspondence' &&
        /^Correspondence\s+to\s*:/iu.test(note.region.text))
    ) {
      continue
    }
    diagnostics.push({
      code: 'UNREFERENCED_NOTE',
      severity: 'error',
      page: note.region.page,
      message: `Note ${note.nodeId} remains explicit because no unique reference resolved to it.`,
      sourceBoxes: [note.region.box],
      target: {
        regionIds: [note.region.id],
        markerId: note.nodeId ?? null,
      },
    })
  }
  return relationships
}

function boxesOverlap(
  left: {
    page?: number
    x: number
    y: number
    width: number
    height: number
  },
  right: {
    page?: number
    x: number
    y: number
    width: number
    height: number
  },
) {
  return (
    (left.page === undefined ||
      right.page === undefined ||
      left.page === right.page) &&
    Math.min(left.x + left.width, right.x + right.width) >
      Math.max(left.x, right.x) &&
    Math.min(left.y + left.height, right.y + right.height) >
      Math.max(left.y, right.y)
  )
}

const CAPTION_ENVELOPE_TOLERANCE = 0.00002

function validNormalizedSourceBox(box: NormalizedSourceBox) {
  return (
    Number.isInteger(box.page) &&
    box.page > 0 &&
    [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= 1 + CAPTION_ENVELOPE_TOLERANCE &&
    box.y + box.height <= 1 + CAPTION_ENVELOPE_TOLERANCE
  )
}

function boxGap(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  return {
    horizontal: Math.max(
      left.x - (right.x + right.width),
      right.x - (left.x + left.width),
      0,
    ),
    vertical: Math.max(
      left.y - (right.y + right.height),
      right.y - (left.y + left.height),
      0,
    ),
  }
}

function connectedCaptionBoxes(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  const gap = boxGap(left, right)
  const verticalOverlap =
    Math.min(left.y + left.height, right.y + right.height) -
    Math.max(left.y, right.y)
  const horizontalOverlap =
    Math.min(left.x + left.width, right.x + right.width) -
    Math.max(left.x, right.x)
  return (
    (verticalOverlap > 0 &&
      gap.horizontal <= Math.max(0.04, left.height * 2, right.height * 2)) ||
    (horizontalOverlap > 0 &&
      gap.vertical <= Math.max(0.03, left.height * 1.5, right.height * 1.5))
  )
}

function oneConnectedCaptionComponent(boxes: NormalizedSourceBox[]) {
  const reached = new Set<number>([0])
  let changed = true
  while (changed) {
    changed = false
    for (let index = 0; index < boxes.length; index += 1) {
      if (reached.has(index)) continue
      if (
        [...reached].some((candidate) =>
          connectedCaptionBoxes(boxes[candidate], boxes[index]),
        )
      ) {
        reached.add(index)
        changed = true
      }
    }
  }
  return reached.size === boxes.length
}

function sameSourceBox(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  return (
    left.page === right.page &&
    left.rotation === right.rotation &&
    left.method === right.method &&
    (['x', 'y', 'width', 'height'] as const).every(
      (key) => rounded(left[key]) === rounded(right[key]),
    )
  )
}

function visualLineageBoxes(
  relationship: PdfVisualRelationship,
  assetsById: ReadonlyMap<string, PdfVisualAsset>,
) {
  if (
    relationship.assetIds.length === 0 ||
    new Set(relationship.assetIds).size !== relationship.assetIds.length
  ) {
    return null
  }
  const assets = relationship.assetIds.map((assetId) => assetsById.get(assetId))
  if (assets.some((asset) => asset === undefined)) return null
  const matchedAssets = assets.filter(
    (asset): asset is PdfVisualAsset => asset !== undefined,
  )
  const sourceObjectIds = matchedAssets.flatMap(
    (asset) => asset.sourceObjectIds,
  )
  const sourceBoxes = matchedAssets.flatMap((asset) => asset.sourceBoxes)
  if (
    sourceBoxes.length === 0 ||
    sourceBoxes.some((box) => !validNormalizedSourceBox(box)) ||
    sourceObjectIds.length !== relationship.sourceObjectIds.length ||
    sourceObjectIds.some(
      (sourceObjectId, index) =>
        sourceObjectId !== relationship.sourceObjectIds[index],
    )
  ) {
    return null
  }
  return sourceBoxes.map((box) => ({ ...box }))
}

export function captionProvenanceEnvelope(
  evidence: NodeSourceEvidence | undefined,
  captionRegionId: string,
  placeholder: NormalizedSourceBox,
  options: { allowExactRegionOverflow?: boolean } = {},
) {
  const boxes = evidence?.boxes ?? []
  const first = boxes[0]
  if (
    !evidence ||
    evidence.regionIds.length !== 1 ||
    evidence.regionIds[0] !== captionRegionId ||
    evidence.pages.length !== 1 ||
    !validNormalizedSourceBox(placeholder) ||
    !first ||
    boxes.some(
      (box) =>
        !validNormalizedSourceBox(box) ||
        box.page !== first.page ||
        box.rotation !== first.rotation ||
        box.method !== first.method ||
        box.page !== placeholder.page ||
        box.rotation !== placeholder.rotation ||
        box.method !== placeholder.method ||
        (!options.allowExactRegionOverflow &&
          (box.x < placeholder.x - CAPTION_ENVELOPE_TOLERANCE ||
            box.y < placeholder.y - CAPTION_ENVELOPE_TOLERANCE ||
            box.x + box.width >
              placeholder.x + placeholder.width + CAPTION_ENVELOPE_TOLERANCE ||
            box.y + box.height >
              placeholder.y + placeholder.height + CAPTION_ENVELOPE_TOLERANCE)),
    ) ||
    evidence.pages[0] !== first.page ||
    !oneConnectedCaptionComponent(boxes)
  ) {
    return null
  }
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  const envelope: NormalizedSourceBox = {
    page: first.page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: first.rotation,
    method: first.method,
  }
  return validNormalizedSourceBox(envelope) ? envelope : null
}

const ACADEMIC_MATH_ITALIC_FONT_NAME =
  /(?:^|[+,._\s-])(?:(?:cm|lm)mi(?:b)?\d+|mtmi\d*|math(?:italic|ital))(?=$|[+,._\s-])/iu
const EXPLICIT_ITALIC_STYLE_FONT_NAME =
  /(?:^|[+,._\s-])(?:(?:(?:regular|regu|roman|book|medium|med|bold|demi|semi(?:bold)?)?(?:italic|ital|oblique|obl)|it)(?:mt)?)(?=$|[+,._\s-])/iu

function fontNameIndicatesItalic(fontName: string) {
  return (
    ACADEMIC_MATH_ITALIC_FONT_NAME.test(fontName) ||
    EXPLICIT_ITALIC_STYLE_FONT_NAME.test(fontName)
  )
}

function unmatchedClosingDelimiter(value: string, open: string, close: string) {
  return value.split(close).length > value.split(open).length
}

function literalAbsoluteHyperlinks(value: string) {
  const links: Array<{ start: number; end: number; url: string }> = []
  for (const match of value.matchAll(/(?:https?:\/\/|mailto:)[^\s<>"']+/giu)) {
    if (match.index === undefined) continue
    let url = match[0].replace(/[.,;:!?]+$/u, '')
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ]) {
      while (
        url.endsWith(close) &&
        unmatchedClosingDelimiter(url, open, close)
      ) {
        url = url.slice(0, -1)
      }
    }
    if (!url || !safePdfExternalLinkTarget(url)) continue
    links.push({ start: match.index, end: match.index + url.length, url })
  }
  return links
}

function runVerticalAlign(
  line: PdfPageRegion['lines'][number],
  run: PdfPageRegion['lines'][number]['runs'][number],
) {
  const maximumFontSize = Math.max(
    ...line.runs.map((candidate) => candidate.fontSize),
  )
  if (run.fontSize >= maximumFontSize * 0.82) return undefined
  const baselineRuns = line.runs.filter(
    (candidate) => candidate.fontSize >= maximumFontSize * 0.9,
  )
  const baselineCenter = median(
    baselineRuns.map((candidate) => candidate.y + candidate.height / 2),
  )
  const runCenter = run.y + run.height / 2
  const threshold = Math.max(
    0.0015,
    median(baselineRuns.map((candidate) => candidate.height)) * 0.12,
  )
  if (runCenter < baselineCenter - threshold) return 'superscript' as const
  if (runCenter > baselineCenter + threshold) return 'subscript' as const
  return undefined
}

type InlineMappingLedger = { expected: number; mapped: number }
type HyperlinkMappingLedger = { expected: number; mapped: number }

type CanonicalHyperlinkMapping = {
  annotationId: string
  blockNodeId: string
  start: number
  end: number
  href: string
}

type CanonicalHyperlinkOccurrence = {
  annotationId: string
  url: string
}

type CanonicalInternalHyperlinkSurface = {
  targetNodeId: string
  blockNodeId: string
  start: number
  end: number
  sourceBoxes: NormalizedSourceBox[]
}

function canonicalRangeForSource(
  block: RegionBlock,
  regionId: string,
  start: number,
  end: number,
) {
  for (const segment of blockSourceSegments(block)) {
    if (segment.region.id !== regionId) continue
    const sourceEnd = segment.sourceStart + segment.text.length
    const overlapStart = Math.max(start, segment.sourceStart)
    const overlapEnd = Math.min(end, sourceEnd)
    if (overlapStart >= overlapEnd) continue
    return {
      start: segment.canonicalStart + overlapStart - segment.sourceStart,
      end: segment.canonicalStart + overlapEnd - segment.sourceStart,
    }
  }
  return null
}

function exactCanonicalRangeForSource(
  block: RegionBlock,
  regionId: string,
  start: number,
  end: number,
) {
  if (start < 0 || start >= end) return null
  const containsExactRange = blockSourceSegments(block).some(
    (segment) =>
      segment.region.id === regionId &&
      segment.sourceStart <= start &&
      segment.sourceStart + segment.text.length >= end,
  )
  if (!containsExactRange) return null
  const range = canonicalRangeForSource(block, regionId, start, end)
  return range && range.end - range.start === end - start ? range : null
}

function canonicalCitationHyperlinkSurfaces(
  relationships: readonly PdfCitationRelationship[],
  blocks: readonly RegionBlock[],
): CanonicalInternalHyperlinkSurface[] {
  return relationships.flatMap((relationship) => {
    if (
      relationship.status !== 'matched' ||
      relationship.labels.length !== 1 ||
      relationship.targetNodeIds.length !== 1 ||
      relationship.sourceBoxes.length === 0
    ) {
      return []
    }
    const candidates = blocks.flatMap((block) => {
      if (
        !block.nodeId ||
        (block.type !== 'heading' && block.type !== 'paragraph')
      ) {
        return []
      }
      const range = exactCanonicalRangeForSource(
        block,
        relationship.referenceRegionId,
        relationship.referenceStart,
        relationship.referenceEnd,
      )
      if (!range) return []
      const sourceText = blockSourceSegments(block).flatMap((segment) =>
        segment.region.id === relationship.referenceRegionId &&
        segment.sourceStart <= relationship.referenceStart &&
        segment.sourceStart + segment.text.length >= relationship.referenceEnd
          ? [
              segment.region.text.slice(
                relationship.referenceStart,
                relationship.referenceEnd,
              ),
            ]
          : [],
      )
      if (
        sourceText.length !== 1 ||
        block.text.slice(range.start, range.end) !== sourceText[0]
      ) {
        return []
      }
      return [
        {
          targetNodeId: relationship.targetNodeIds[0],
          blockNodeId: block.nodeId,
          ...range,
          sourceBoxes: relationship.sourceBoxes.map((box) => ({ ...box })),
        },
      ]
    })
    return candidates.length === 1 ? candidates : []
  })
}

function normalizedInlineSourceText(value: string) {
  return value
    .replace(/\u00ad/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

type ExactSourceRunRange = {
  line: PdfPageRegion['lines'][number]
  run: PdfSourceRun
  sourceStart: number
  sourceEnd: number
  text: string
}

function exactFallbackLineRanges(region: PdfPageRegion) {
  const ranges = new Map<string, { start: number; end: number }>()
  let cursor = 0
  for (const line of region.lines) {
    const text = normalizedInlineSourceText(line.text)
    if (!text) return null
    const start = region.text.indexOf(text, cursor)
    if (start < 0 || region.text.indexOf(text, start + 1) >= 0) {
      return null
    }
    const end = start + text.length
    ranges.set(line.id, { start, end })
    cursor = end
  }
  return ranges
}

function exactSourceRunRanges(
  region: PdfPageRegion,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const replay = replayPdfRegionLineRanges(region, lineBoundaryDecisions)
  const lineRanges =
    replay?.text === region.text
      ? replay.ranges
      : lineBoundaryDecisions.some(
            (decision) => decision.regionId === region.id,
          )
        ? null
        : exactFallbackLineRanges(region)
  if (!lineRanges) return []

  const removedDiscretionaryHyphenLineIds = new Set(
    lineBoundaryDecisions.flatMap((decision) =>
      decision.regionId === region.id &&
      decision.outcome === 'removed-discretionary-hyphen'
        ? [decision.fromLineId]
        : [],
    ),
  )
  const mapped: ExactSourceRunRange[] = []
  for (const line of region.lines) {
    const lineRange = lineRanges.get(line.id)
    if (!lineRange) continue
    const positionedAccentTextByRun = new Map<PdfSourceRun, string>()
    for (let index = 0; index < line.runs.length - 1; index += 1) {
      const accent = line.runs[index]
      const target = line.runs[index + 1]
      const text = positionedPdfPrefixAccentText(accent, target)
      if (!text) continue
      const normalizedText = normalizedInlineSourceText(text)
      positionedAccentTextByRun.set(accent, normalizedText)
      positionedAccentTextByRun.set(target, normalizedText)
      index += 1
    }
    const candidates = line.runs.map((run, runIndex) => {
      let text =
        positionedAccentTextByRun.get(run) ??
        normalizedInlineSourceText(run.text)
      if (
        runIndex === line.runs.length - 1 &&
        removedDiscretionaryHyphenLineIds.has(line.id) &&
        /[-‐‑]$/u.test(text)
      ) {
        text = text.slice(0, -1)
      }
      const occurrences: Array<{ start: number; end: number }> = []
      if (text) {
        let cursor = lineRange.start
        while (cursor <= lineRange.end - text.length) {
          const start = region.text.indexOf(text, cursor)
          if (start < 0 || start + text.length > lineRange.end) break
          occurrences.push({ start, end: start + text.length })
          cursor = start + Math.max(text.length, 1)
        }
      }
      return { run, text, occurrences }
    })

    const firstWithCandidates = candidates.findIndex(
      (candidate) => candidate.occurrences.length > 0,
    )
    if (firstWithCandidates === 0) {
      const edge = candidates[0].occurrences.filter(
        (candidate) => candidate.start === lineRange.start,
      )
      if (edge.length > 0) candidates[0].occurrences = edge
    }
    let lastWithCandidates = -1
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (candidates[index].occurrences.length > 0) {
        lastWithCandidates = index
        break
      }
    }
    if (lastWithCandidates === candidates.length - 1) {
      const edge = candidates[lastWithCandidates].occurrences.filter(
        (candidate) => candidate.end === lineRange.end,
      )
      if (edge.length > 0) {
        candidates[lastWithCandidates].occurrences = edge
      }
    }

    let changed = true
    while (changed) {
      changed = false
      for (const [index, candidate] of candidates.entries()) {
        if (candidate.occurrences.length === 0) continue
        const resolvedBefore = candidates
          .slice(0, index)
          .flatMap((peer) =>
            peer.occurrences.length === 1 ? peer.occurrences : [],
          )
        const resolvedAfter = candidates
          .slice(index + 1)
          .flatMap((peer) =>
            peer.occurrences.length === 1 ? peer.occurrences : [],
          )
        const lowerBound =
          resolvedBefore.length > 0
            ? Math.max(...resolvedBefore.map((peer) => peer.end))
            : lineRange.start
        const upperBound =
          resolvedAfter.length > 0
            ? Math.min(...resolvedAfter.map((peer) => peer.start))
            : lineRange.end
        const filtered = candidate.occurrences.filter(
          (occurrence) =>
            occurrence.start >= lowerBound && occurrence.end <= upperBound,
        )
        if (filtered.length !== candidate.occurrences.length) {
          candidate.occurrences = filtered
          changed = true
        }
      }
    }

    for (const candidate of candidates) {
      if (candidate.occurrences.length !== 1) continue
      mapped.push({
        line,
        run: candidate.run,
        sourceStart: candidate.occurrences[0].start,
        sourceEnd: candidate.occurrences[0].end,
        text: candidate.text,
      })
    }
  }
  return mapped
}

function escapedRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function exactInternalLinkSurfacePattern(
  target:
    { kind: PdfCanonicalInternalLinkTarget['kind']; label: string } | undefined,
) {
  if (!target) return null
  const prefixByKind = {
    section: 'Section',
    appendix: 'Appendix',
    figure: 'Figure',
    table: 'Table',
    equation: 'Equation',
    reference: 'Reference',
    note: '(?:Footnote|Endnote)',
  } as const
  const prefix = prefixByKind[target.kind]
  const identifier = target.label.match(
    new RegExp(`^(?:${prefix})\\s+(.+)$`, 'iu'),
  )?.[1]
  if (!identifier) return null
  const exactIdentifier = escapedRegularExpression(identifier)
  const surface =
    target.kind === 'section'
      ? `(?:§\\s*|Sections?\\s+|Secs?\\.?\\s*)${exactIdentifier}`
      : target.kind === 'figure'
        ? `(?:Figures?\\s+|Figs?\\.?\\s*)${exactIdentifier}`
        : target.kind === 'table'
          ? `(?:Tables?\\s+|Tabs?\\.?\\s*)${exactIdentifier}`
          : target.kind === 'equation'
            ? `(?:Equations?\\s+|Eqs?\\.?\\s*)\\(?${exactIdentifier}\\)?`
            : target.kind === 'appendix'
              ? `Appendix\\s+${exactIdentifier}`
              : target.kind === 'note'
                ? `(?:Footnotes?|Endnotes?)\\s+${exactIdentifier}`
                : null
  return surface
    ? new RegExp(`(?<![\\p{L}\\p{N}])${surface}(?![\\p{L}\\p{N}])`, 'giu')
    : null
}

function exactInternalLinkSurfaceRanges(
  block: RegionBlock,
  annotation: { box: NormalizedSourceBox },
  target:
    { kind: PdfCanonicalInternalLinkTarget['kind']; label: string } | undefined,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const pattern = exactInternalLinkSurfacePattern(target)
  if (!pattern) return []
  const ranges: Array<{ start: number; end: number }> = []
  for (const segment of blockSourceSegments(block)) {
    const replay = replayPdfRegionLineRanges(
      segment.region,
      lineBoundaryDecisions,
    )
    if (replay?.text !== segment.region.text) continue
    for (const line of segment.region.lines) {
      if (!line.runs.some((run) => boxesOverlap(annotation.box, run))) continue
      const lineRange = replay.ranges.get(line.id)
      if (!lineRange) continue
      for (const match of line.text.matchAll(pattern)) {
        if (match.index === undefined || !match[0]) continue
        const range = exactCanonicalRangeForSource(
          block,
          segment.region.id,
          lineRange.start + match.index,
          lineRange.start + match.index + match[0].length,
        )
        if (range) ranges.push(range)
      }
    }
  }
  return [
    ...new Map(
      ranges.map((range) => [`${range.start}:${range.end}`, range] as const),
    ).values(),
  ]
}

function canonicalHyperlinkRange(
  block: RegionBlock,
  annotation: { box: NormalizedSourceBox },
  target:
    { kind: PdfCanonicalInternalLinkTarget['kind']; label: string } | undefined,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const exactTargetSurfaces = exactInternalLinkSurfaceRanges(
    block,
    annotation,
    target,
    lineBoundaryDecisions,
  )
  if (exactTargetSurfaces.length === 1) return exactTargetSurfaces[0]
  if (exactTargetSurfaces.length > 1) return null
  if (target?.kind === 'reference' || target?.kind === 'note') return null

  const ranges: Array<{ start: number; end: number }> = []
  let hasStrictlyNarrowOverlappingAnnotation = false
  for (const segment of blockSourceSegments(block)) {
    for (const sourceRun of exactSourceRunRanges(
      segment.region,
      lineBoundaryDecisions,
    )) {
      if (!boxesOverlap(annotation.box, sourceRun.run)) continue
      if (annotation.box.width < sourceRun.run.width * 0.8) {
        hasStrictlyNarrowOverlappingAnnotation = true
      }
      const range = exactCanonicalRangeForSource(
        block,
        segment.region.id,
        sourceRun.sourceStart,
        sourceRun.sourceEnd,
      )
      if (range) ranges.push(range)
    }
  }
  const ordered = [
    ...new Map(
      ranges.map((range) => [`${range.start}:${range.end}`, range] as const),
    ).values(),
  ].sort((left, right) => left.start - right.start || left.end - right.end)
  if (ordered.length === 0) return null
  for (let index = 1; index < ordered.length; index += 1) {
    const prior = ordered[index - 1]
    const current = ordered[index]
    if (
      current.start > prior.end &&
      block.text.slice(prior.end, current.start).trim()
    ) {
      return null
    }
  }
  const start = ordered[0].start
  const end = Math.max(...ordered.map((range) => range.end))
  if (
    exactInternalLinkSurfacePattern(target) &&
    hasStrictlyNarrowOverlappingAnnotation &&
    /\s/u.test(block.text.slice(start, end).trim())
  ) {
    return null
  }
  return start < end ? { start, end } : null
}

function exactCanonicalInternalHyperlinkSurfaceRange({
  annotationBox,
  block,
  surfaces,
  targetNodeId,
}: {
  annotationBox: NormalizedSourceBox
  block: RegionBlock
  surfaces: readonly CanonicalInternalHyperlinkSurface[]
  targetNodeId: string
}) {
  if (!block.nodeId) return null
  const candidates = [
    ...new Map(
      surfaces
        .filter(
          (surface) =>
            surface.targetNodeId === targetNodeId &&
            surface.blockNodeId === block.nodeId &&
            surface.sourceBoxes.some((box) =>
              boxesOverlap(annotationBox, box),
            ) &&
            surface.start >= 0 &&
            surface.start < surface.end &&
            surface.end <= block.text.length,
        )
        .map(
          (surface) =>
            [
              `${surface.blockNodeId}:${surface.start}:${surface.end}`,
              { start: surface.start, end: surface.end },
            ] as const,
        ),
    ).values(),
  ]
  return candidates.length === 1 ? candidates[0] : null
}

export function resolveCanonicalHyperlinkObligations({
  blocks,
  annotations,
  canonicalOccurrences = [],
  canonicalTargets = [],
  canonicalInternalSurfaces = [],
  lineBoundaryDecisions = [],
}: {
  blocks: RegionBlock[]
  annotations: PdfLinkAnnotation[]
  canonicalOccurrences?: CanonicalHyperlinkOccurrence[]
  canonicalTargets?: PdfCanonicalInternalLinkTarget[]
  canonicalInternalSurfaces?: CanonicalInternalHyperlinkSurface[]
  lineBoundaryDecisions?: readonly PdfLineBoundaryDecision[]
}) {
  const mappings: CanonicalHyperlinkMapping[] = []
  const diagnostics: ReconstructionDiagnostic[] = []
  const approvedAnnotationIds = new Set<string>()
  let mappedAnnotationCount = 0
  const overlappingAnnotationIds = new Set<string>()
  for (let leftIndex = 0; leftIndex < annotations.length; leftIndex += 1) {
    const left = annotations[leftIndex]
    if (!left.box) continue
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < annotations.length;
      rightIndex += 1
    ) {
      const right = annotations[rightIndex]
      const sameExternalTarget =
        left.status === 'external' &&
        right.status === 'external' &&
        normalizedPdfExternalLinkTarget(left.url) !== null &&
        normalizedPdfExternalLinkTarget(left.url) ===
          normalizedPdfExternalLinkTarget(right.url)
      if (
        right.box &&
        boxesOverlap(left.box, right.box) &&
        !sameExternalTarget
      ) {
        overlappingAnnotationIds.add(left.id)
        overlappingAnnotationIds.add(right.id)
      }
    }
  }

  for (const annotation of annotations) {
    let failure: string | null = null
    if (annotation.status === 'unresolved') {
      failure = `PDF link annotation ${annotation.id} remains unresolved (${annotation.reason})${annotation.target ? ` for ${annotation.target}` : ''}.`
    } else if (overlappingAnnotationIds.has(annotation.id)) {
      failure = `PDF link annotation ${annotation.id} overlaps another annotation, so no unique canonical target can be proved.`
    } else {
      const destinationResolution =
        annotation.status === 'internal'
          ? resolvePdfInternalLinkAnnotation(annotation, canonicalTargets)
          : null
      const parsedDestination =
        destinationResolution && 'parsed' in destinationResolution
          ? destinationResolution.parsed
          : undefined
      const resolvedCanonicalSurfaceTargets =
        destinationResolution?.status === 'matched'
          ? [
              ...new Map(
                canonicalTargets
                  .filter(
                    (target) =>
                      target.nodeId === destinationResolution.targetNodeId &&
                      (!parsedDestination ||
                        target.kind === parsedDestination.kind),
                  )
                  .map(
                    (target) =>
                      [`${target.kind}:${target.label}`, target] as const,
                  ),
              ).values(),
            ]
          : []
      const sourceSurfaceTarget =
        resolvedCanonicalSurfaceTargets.length === 1
          ? resolvedCanonicalSurfaceTargets[0]
          : parsedDestination
      const isReferenceDestination =
        destinationResolution?.status === 'matched' &&
        (sourceSurfaceTarget?.kind === 'reference' ||
          canonicalTargets.some(
            (target) =>
              target.nodeId === destinationResolution.targetNodeId &&
              target.kind === 'reference',
          ))
      const candidates = blocks.flatMap((block) => {
        if (!block.nodeId) return []
        const range = isReferenceDestination
          ? exactCanonicalInternalHyperlinkSurfaceRange({
              annotationBox: annotation.box,
              block,
              surfaces: canonicalInternalSurfaces,
              targetNodeId: destinationResolution.targetNodeId,
            })
          : canonicalHyperlinkRange(
              block,
              annotation,
              sourceSurfaceTarget,
              lineBoundaryDecisions,
            )
        return range
          ? [
              {
                annotationId: annotation.id,
                blockNodeId: block.nodeId,
                ...range,
              },
            ]
          : []
      })
      if (annotation.status === 'internal') {
        if (!destinationResolution) {
          throw new Error('missing internal PDF destination resolution')
        }
        if (destinationResolution.status === 'unsupported') {
          failure = `Internal PDF destination ${annotation.destination} uses an unsupported internal PDF destination scheme.`
        } else if (destinationResolution.status === 'missing') {
          failure = `Internal PDF destination ${annotation.destination} has no exact canonical target.`
        } else if (destinationResolution.status === 'ambiguous') {
          failure = `Internal PDF destination ${annotation.destination} maps to more than one canonical target.`
        } else if (candidates.length !== 1) {
          failure =
            candidates.length === 0
              ? `PDF link annotation ${annotation.id} has no exact canonical inline owner.`
              : `PDF link annotation ${annotation.id} maps to ${candidates.length} canonical inline owners.`
        } else {
          mappings.push({
            ...candidates[0],
            href: `#${destinationResolution.targetNodeId}`,
          })
          approvedAnnotationIds.add(annotation.id)
          mappedAnnotationCount += 1
        }
      } else if (!safePdfExternalLinkTarget(annotation.url)) {
        failure = `PDF link annotation ${annotation.id} has an unsafe external target.`
      } else {
        const existingOccurrences = canonicalOccurrences.filter(
          (candidate) => candidate.annotationId === annotation.id,
        )
        const candidateCount = candidates.length + existingOccurrences.length
        if (
          candidateCount === 1 &&
          existingOccurrences.every(
            (candidate) => candidate.url === annotation.url,
          )
        ) {
          mappings.push(
            ...candidates.map((candidate) => ({
              ...candidate,
              href: annotation.url,
            })),
          )
          approvedAnnotationIds.add(annotation.id)
          mappedAnnotationCount += 1
        } else {
          failure =
            candidateCount === 0
              ? `PDF link annotation ${annotation.id} has no exact canonical inline owner.`
              : `PDF link annotation ${annotation.id} maps to ${candidateCount} canonical inline owners.`
        }
      }
    }
    if (!failure) continue
    const regionIds = annotation.box
      ? [
          ...new Set(
            blocks.flatMap((block) =>
              blockSourceSegments(block)
                .filter((segment) =>
                  segment.region.lines.some((line) =>
                    line.runs.some((run) => boxesOverlap(annotation.box!, run)),
                  ),
                )
                .map((segment) => segment.region.id),
            ),
          ),
        ]
      : []
    diagnostics.push({
      code: 'UNRESOLVED_HYPERLINK',
      severity: 'error',
      page: annotation.page,
      message: failure,
      ...(annotation.box ? { sourceBoxes: [annotation.box] } : {}),
      relationshipId: annotation.id,
      ...(regionIds.length > 0
        ? {
            target: {
              regionIds,
              markerId: annotation.id,
            },
          }
        : {}),
    })
  }
  const externalAnnotationsById = new Map(
    annotations.flatMap((annotation) =>
      annotation.status === 'external'
        ? [[annotation.id, annotation] as const]
        : [],
    ),
  )
  const blocksByNodeId = new Map(
    blocks.flatMap((block) =>
      block.nodeId ? [[block.nodeId, block] as const] : [],
    ),
  )
  for (const mapping of mappings) {
    const annotation = externalAnnotationsById.get(mapping.annotationId)
    const block = blocksByNodeId.get(mapping.blockNodeId)
    const normalizedTarget = annotation
      ? normalizedPdfExternalLinkTarget(annotation.url)
      : null
    if (!annotation || !block || !normalizedTarget) continue
    const literalCandidates = literalAbsoluteHyperlinks(block.text).filter(
      (candidate) =>
        normalizedPdfExternalLinkTarget(candidate.url) === normalizedTarget &&
        candidate.start <= mapping.end &&
        candidate.end >= mapping.start,
    )
    if (literalCandidates.length !== 1) continue
    mapping.start = literalCandidates[0].start
    mapping.end = literalCandidates[0].end
  }
  const linkedTokenRangeResolutions = resolvePdfLinkedTokenRangeContinuity({
    ownerTexts: new Map(
      blocks.flatMap((block) =>
        block.nodeId ? [[block.nodeId, block.text] as const] : [],
      ),
    ),
    ranges: mappings.flatMap((mapping) => {
      const annotation = externalAnnotationsById.get(mapping.annotationId)
      return annotation
        ? [
            {
              annotationId: mapping.annotationId,
              ownerId: mapping.blockNodeId,
              start: mapping.start,
              end: mapping.end,
              target: annotation.url,
              sourceBox: annotation.box,
            },
          ]
        : []
    }),
  })
  const mappingKey = (
    mapping: Pick<
      CanonicalHyperlinkMapping,
      'annotationId' | 'blockNodeId' | 'start' | 'end'
    >,
  ) =>
    `${mapping.annotationId}\u0000${mapping.blockNodeId}\u0000${mapping.start}\u0000${mapping.end}`
  for (const resolution of linkedTokenRangeResolutions) {
    const fragmentKeys = new Set(
      resolution.fragments.map((fragment) =>
        mappingKey({
          annotationId: fragment.annotationId,
          blockNodeId: fragment.ownerId,
          start: fragment.start,
          end: fragment.end,
        }),
      ),
    )
    const indexes = mappings.flatMap((mapping, index) =>
      fragmentKeys.has(mappingKey(mapping)) ? [index] : [],
    )
    if (resolution.status === 'unresolved') {
      for (const index of [...indexes].sort((left, right) => right - left)) {
        mappings.splice(index, 1)
      }
      for (const annotationId of resolution.annotationIds) {
        if (approvedAnnotationIds.delete(annotationId)) {
          mappedAnnotationCount -= 1
        }
      }
      diagnostics.push({
        code: 'UNRESOLVED_HYPERLINK',
        severity: 'error',
        ...(resolution.sourceBoxes[0]
          ? { page: resolution.sourceBoxes[0].page }
          : {}),
        message:
          resolution.reason === 'unproven-wrap-whitespace'
            ? `PDF link annotations ${resolution.annotationIds.join(', ')} have visible URL fragments that round-trip only after removing unproven source whitespace.`
            : `PDF link annotations ${resolution.annotationIds.join(', ')} have visible URL fragments that do not round-trip to their normalized target.`,
        ...(resolution.sourceBoxes.length > 0
          ? { sourceBoxes: resolution.sourceBoxes }
          : {}),
        relationshipId: resolution.annotationIds.join('+'),
      })
      continue
    }
    if (indexes.length !== resolution.fragments.length) continue
    const insertionIndex = Math.min(...indexes)
    for (const index of [...indexes].sort((left, right) => right - left)) {
      mappings.splice(index, 1)
    }
    mappings.splice(
      insertionIndex,
      0,
      ...resolution.fragments.map((fragment) => ({
        annotationId: fragment.annotationId,
        blockNodeId: resolution.ownerId,
        start: resolution.start,
        end: resolution.end,
        href:
          externalAnnotationsById.get(fragment.annotationId)?.url ??
          resolution.normalizedTarget,
      })),
    )
  }
  return {
    mappings,
    approvedAnnotationIds,
    diagnostics,
    ledger: {
      expected: annotations.length,
      mapped: mappedAnnotationCount,
    } satisfies HyperlinkMappingLedger,
  }
}

export function canonicalHyperlinkOccurrencesForTable(table: CanonicalTable) {
  return table.rows.flatMap((row) =>
    row.cells.flatMap((cell) =>
      (cell.inlineRuns ?? []).flatMap((run) =>
        run.annotationId && run.href
          ? [{ annotationId: run.annotationId, url: run.href }]
          : [],
      ),
    ),
  )
}

function canonicalTableHyperlinkOccurrences(
  relationships: PdfVisualRelationship[],
  drafts: ReadonlyMap<string, CanonicalVisualDraft>,
  tablesByAssetId: ReadonlyMap<string, CanonicalTable>,
) {
  return relationships.flatMap((relationship) => {
    if (!drafts.has(relationship.id)) return []
    const table = relationship.assetIds
      .map((assetId) => tablesByAssetId.get(assetId))
      .find((candidate) => candidate !== undefined)
    if (!table) return []
    return canonicalHyperlinkOccurrencesForTable(table)
  })
}

export function canonicalTableWithApprovedHyperlinks(
  table: CanonicalTable,
  approvedAnnotationIds: ReadonlySet<string>,
): CanonicalTable {
  return {
    rows: table.rows.map((row) => ({
      cells: row.cells.map((cell) => {
        const removedAnnotationCount = (cell.inlineRuns ?? []).filter(
          (run) =>
            run.annotationId !== undefined &&
            !approvedAnnotationIds.has(run.annotationId),
        ).length
        const inlineRuns = (cell.inlineRuns ?? []).flatMap((run) => {
          if (
            !run.annotationId ||
            approvedAnnotationIds.has(run.annotationId)
          ) {
            return [run]
          }
          const { annotationId: _annotationId, href: _href, ...rest } = run
          return rest.bold || rest.italic || rest.verticalAlign ? [rest] : []
        })
        return {
          ...cell,
          ...(inlineRuns.length > 0 ? { inlineRuns } : {}),
          ...(cell.inlineMapping
            ? {
                inlineMapping: {
                  expected: Math.max(
                    0,
                    cell.inlineMapping.expected - removedAnnotationCount,
                  ),
                  mapped: Math.max(
                    0,
                    cell.inlineMapping.mapped - removedAnnotationCount,
                  ),
                },
              }
            : {}),
        }
      }),
    })),
  }
}

function exactCanonicalNoteReferenceAnchor(
  reference: NoteReferenceDraft,
  canonicalBlocks: RegionBlock[],
  renderedAuthorReferenceIds: ReadonlySet<string>,
): NoteReferenceDraft['canonicalAnchor'] {
  if (
    reference.start < 0 ||
    reference.end <= reference.start ||
    reference.end > reference.region.text.length
  ) {
    return null
  }
  const sourceMarker = reference.region.text.slice(
    reference.start,
    reference.end,
  )
  const sourceLabels =
    noteLabelsFromMarkerText(sourceMarker).map(normalizedNoteLabel)
  const expectedLabels = reference.label
    .split(',')
    .map(normalizedNoteLabel)
    .filter(Boolean)
  if (
    sourceLabels.length !== expectedLabels.length ||
    sourceLabels.some((label, index) => label !== expectedLabels[index])
  ) {
    return null
  }
  if (renderedAuthorReferenceIds.has(reference.id)) {
    return 'author' in reference && typeof reference.author === 'string'
      ? { kind: 'author', author: reference.author }
      : null
  }
  const candidates = canonicalBlocks.flatMap((block) => {
    if (!block.nodeId) return []
    const range = exactCanonicalRangeForSource(
      block,
      reference.region.id,
      reference.start,
      reference.end,
    )
    return range && block.text.slice(range.start, range.end) === sourceMarker
      ? [{ kind: 'node' as const, nodeId: block.nodeId, ...range }]
      : []
  })
  return candidates.length === 1 ? candidates[0] : null
}

type CanonicalVisualTextSegment = {
  regionId: string
  lineId: string
  sourceStart: number
  sourceEnd: number
  canonicalStart: number
  text: string
  box: NormalizedSourceBox
}

type CanonicalVisualTextOwner = {
  nodeId: string
  relationshipId: string
  text: string
  segments: CanonicalVisualTextSegment[]
}

export function canonicalVisualSourceTranscript(
  relationship: Pick<PdfVisualRelationship, 'kind' | 'status' | 'sourceText'>,
  exactSourceText: string | null | undefined,
) {
  if (
    relationship.kind === 'table' &&
    relationship.status === 'matched' &&
    relationship.sourceText.trim()
  ) {
    return relationship.sourceText
  }
  return exactSourceText?.trim() ? exactSourceText : undefined
}

function canonicalVisualTextOwner(
  relationship: PdfVisualRelationship,
  nodeId: string,
  regions: PdfPageRegion[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
): CanonicalVisualTextOwner | null {
  if (
    relationship.kind !== 'table' ||
    relationship.status !== 'matched' ||
    !relationship.sourceText ||
    !relationship.sourceLineIds?.length ||
    new Set(relationship.sourceLineIds).size !==
      relationship.sourceLineIds.length
  ) {
    return null
  }
  const selectedRegionIds = new Set(relationship.sourceRegionIds)
  const lineOwners = new Map<
    string,
    Array<{ region: PdfPageRegion; line: PdfPageRegion['lines'][number] }>
  >()
  for (const region of regions.filter((candidate) =>
    selectedRegionIds.has(candidate.id),
  )) {
    for (const line of region.lines) {
      const owners = lineOwners.get(line.id) ?? []
      owners.push({ region, line })
      lineOwners.set(line.id, owners)
    }
  }
  const sourceRangesByRegion = new Map<
    string,
    ReturnType<typeof replayPdfRegionLineRanges>
  >()
  const segments: CanonicalVisualTextSegment[] = []
  let canonicalStart = 0
  for (const lineId of relationship.sourceLineIds) {
    const owners = lineOwners.get(lineId) ?? []
    if (owners.length !== 1) return null
    const { region, line } = owners[0]
    let ranges = sourceRangesByRegion.get(region.id)
    if (ranges === undefined) {
      ranges = replayPdfRegionLineRanges(region, lineBoundaryDecisions)
      sourceRangesByRegion.set(region.id, ranges)
    }
    if (ranges?.text !== region.text) return null
    const range = ranges.ranges.get(line.id)
    if (!range) return null
    segments.push({
      regionId: region.id,
      lineId,
      sourceStart: range.start,
      sourceEnd: range.end,
      canonicalStart,
      text: line.text,
      box: { ...line.box },
    })
    canonicalStart += line.text.length + 1
  }
  if (
    segments.map((segment) => segment.text).join(' ') !==
    relationship.sourceText
  ) {
    return null
  }
  return {
    nodeId,
    relationshipId: relationship.id,
    text: relationship.sourceText,
    segments,
  }
}

function exactVisualCanonicalRangeForSource(
  owner: CanonicalVisualTextOwner,
  relationship: PdfCitationRelationship,
  regionsById: ReadonlyMap<string, PdfPageRegion>,
) {
  if (
    relationship.referenceStart < 0 ||
    relationship.referenceStart >= relationship.referenceEnd
  ) {
    return null
  }
  const region = regionsById.get(relationship.referenceRegionId)
  if (!region) return null
  const markerText = region.text.slice(
    relationship.referenceStart,
    relationship.referenceEnd,
  )
  if (!markerText) return null
  const segments = owner.segments.filter(
    (segment) =>
      segment.regionId === relationship.referenceRegionId &&
      segment.sourceStart <= relationship.referenceStart &&
      segment.sourceEnd >= relationship.referenceEnd &&
      relationship.sourceBoxes.some((box) => boxesOverlap(box, segment.box)),
  )
  if (segments.length !== 1) return null
  const segment = segments[0]
  const start =
    segment.canonicalStart + relationship.referenceStart - segment.sourceStart
  const end = start + markerText.length
  return owner.text.slice(start, end) === markerText
    ? { nodeId: owner.nodeId, start, end }
    : null
}

function sourceInlineRuns(
  block: RegionBlock,
  links: PdfLinkAnnotation[],
  canonicalHyperlinks: CanonicalHyperlinkMapping[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
  noteReferences: Array<{
    id: string
    start: number
    end: number
    regionId: string
    canonicalRange?: { start: number; end: number }
  }>,
  semanticReferences: Array<SemanticReferenceDraft & { regionId: string }> = [],
) {
  const mapped = new Map<string, CanonicalInlineRun>()
  const ledger: InlineMappingLedger = { expected: 0, mapped: 0 }
  const sourceAnnotationRanges: Array<{ start: number; end: number }> = []
  const store = (run: CanonicalInlineRun) => {
    const rangeKey = `${run.start}:${run.end}`
    const key = run.annotationId
      ? `${rangeKey}:annotation:${run.annotationId}`
      : rangeKey
    mapped.set(key, {
      ...(run.annotationId ? mapped.get(rangeKey) : undefined),
      ...mapped.get(key),
      ...run,
    })
  }
  for (const segment of blockSourceSegments(block)) {
    const exactRangesByRun = new Map(
      exactSourceRunRanges(segment.region, lineBoundaryDecisions).map(
        (sourceRun) => [sourceRun.run, sourceRun] as const,
      ),
    )
    for (const line of segment.region.lines) {
      for (const run of line.runs) {
        const sourceText = normalizedInlineSourceText(run.text)
        if (!sourceText) continue
        const bold = run.bold ?? fontNameIndicatesBold(run.fontName)
        const italic = run.italic ?? fontNameIndicatesItalic(run.fontName)
        const verticalAlign = runVerticalAlign(line, run)
        const compactMathSpans = sourceMathAtomCompactionRanges(
          sourceText,
          run.fontName,
        )
        const overlappingLinks = links.filter(
          (candidate) =>
            candidate.box !== null && boxesOverlap(candidate.box, run),
        )
        // Literal URLs are mapped only after the complete canonical block has
        // been assembled, so a line-wrapped URL cannot become a partial link.
        const rawLiteralLinks: Array<{
          start: number
          end: number
          url: string
        }> = []
        const expectedStyleCount =
          Number(bold) +
          Number(italic) +
          Number(Boolean(verticalAlign)) +
          compactMathSpans.length
        const exactRange = exactRangesByRun.get(run)
        if (!exactRange) {
          ledger.expected += expectedStyleCount + rawLiteralLinks.length
          continue
        }
        const { sourceStart, sourceEnd } = exactRange
        const canonicalRange = canonicalRangeForSource(
          block,
          segment.region.id,
          sourceStart,
          sourceEnd,
        )
        if (!canonicalRange) continue
        if (
          overlappingLinks.length > 0 ||
          links.some(
            (candidate) =>
              candidate.page === run.page && candidate.box === null,
          )
        ) {
          sourceAnnotationRanges.push(canonicalRange)
        }
        const intersectionStart =
          segment.sourceStart + canonicalRange.start - segment.canonicalStart
        const canonicalText = segment.region.text.slice(
          intersectionStart,
          intersectionStart + canonicalRange.end - canonicalRange.start,
        )
        const hyperlinkSpans = rawLiteralLinks
          .map((link) => ({
            start: sourceStart + link.start,
            end: sourceStart + link.end,
            url: link.url,
          }))
          .flatMap((link) => {
            const start = Math.max(link.start, intersectionStart)
            const end = Math.min(
              link.end,
              intersectionStart + canonicalText.length,
            )
            return start < end
              ? [
                  {
                    start: start - intersectionStart,
                    end: end - intersectionStart,
                    url: link.url,
                  },
                ]
              : []
          })
        ledger.expected += expectedStyleCount + hyperlinkSpans.length
        if (
          bold ||
          italic ||
          hyperlinkSpans.length > 0 ||
          verticalAlign ||
          compactMathSpans.length > 0
        ) {
          const boundaries = [
            0,
            canonicalText.length,
            ...hyperlinkSpans.flatMap((link) => [link.start, link.end]),
            ...compactMathSpans.flatMap((span) => [span.start, span.end]),
          ]
          const points = [...new Set(boundaries)].sort(
            (left, right) => left - right,
          )
          for (let index = 0; index < points.length - 1; index += 1) {
            const segmentStart = points[index]
            const segmentEnd = points[index + 1]
            if (segmentStart === segmentEnd) continue
            const hyperlink = hyperlinkSpans.find(
              (candidate) =>
                candidate.start <= segmentStart && candidate.end >= segmentEnd,
            )
            const compactMathAtom = compactMathSpans.some(
              (candidate) =>
                candidate.start <= segmentStart &&
                candidate.end >= segmentEnd,
            )
            store({
              start: canonicalRange.start + segmentStart,
              end: canonicalRange.start + segmentEnd,
              ...(bold ? { bold: true } : {}),
              ...(italic ? { italic: true } : {}),
              ...(hyperlink ? { href: hyperlink.url } : {}),
              ...(verticalAlign ? { verticalAlign } : {}),
              ...(compactMathAtom ? { compactMathAtom: true } : {}),
            })
          }
          ledger.mapped += expectedStyleCount + hyperlinkSpans.length
        }
      }
    }
  }
  const explicitHyperlinkRanges = canonicalHyperlinks.filter(
    (candidate) => candidate.blockNodeId === block.nodeId,
  )
  const literalLinks = literalAbsoluteHyperlinks(block.text).filter(
    (link) =>
      !sourceAnnotationRanges.some(
        (range) => link.start < range.end && link.end > range.start,
      ) &&
      !explicitHyperlinkRanges.some(
        (range) => link.start < range.end && link.end > range.start,
      ),
  )
  ledger.expected += literalLinks.length
  ledger.mapped += literalLinks.length
  for (const link of literalLinks) {
    store({ start: link.start, end: link.end, href: link.url })
  }
  for (const hyperlink of canonicalHyperlinks.filter(
    (candidate) => candidate.blockNodeId === block.nodeId,
  )) {
    ledger.expected += 1
    ledger.mapped += 1
    store({
      start: hyperlink.start,
      end: hyperlink.end,
      href: hyperlink.href,
      annotationId: hyperlink.annotationId,
    })
  }
  for (const reference of noteReferences) {
    const range =
      reference.canonicalRange ??
      canonicalRangeForSource(
        block,
        reference.regionId,
        reference.start,
        reference.end,
      )
    if (!range) continue
    store({ ...range, relationshipId: reference.id })
  }
  for (const reference of semanticReferences) {
    const range = canonicalRangeForSource(
      block,
      reference.regionId,
      reference.start,
      reference.end,
    )
    if (!range) continue
    store({
      ...range,
      relationshipId: reference.id,
      semanticRole: reference.semanticRole,
      ...(reference.targetIds ? { targetIds: reference.targetIds } : {}),
    })
  }
  const hydratedRuns = [...mapped.entries()]
    .map(([key, run]) => {
      if (!run.annotationId) return run
      const rangeKey = key.slice(0, key.indexOf(':annotation:'))
      return { ...mapped.get(rangeKey), ...run }
    })
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const orderedRuns = hydratedRuns.filter((run, index) => {
    if (!run.annotationId) {
      return !hydratedRuns.some(
        (candidate) =>
          candidate.annotationId &&
          candidate.start === run.start &&
          candidate.end === run.end,
      )
    }
    return !(
      run.href &&
      hydratedRuns
        .slice(0, index)
        .some(
          (candidate) =>
            candidate.annotationId &&
            candidate.start === run.start &&
            candidate.end === run.end &&
            candidate.href === run.href,
        )
    )
  })
  const coalescedRuns: CanonicalInlineRun[] = []
  for (const run of orderedRuns) {
    const previous = coalescedRuns.at(-1)
    const sameStyle =
      previous &&
      previous.end === run.start &&
      previous.bold === run.bold &&
      previous.italic === run.italic &&
      previous.verticalAlign === run.verticalAlign &&
      previous.compactMathAtom === run.compactMathAtom &&
      Boolean(
        run.bold || run.italic || run.verticalAlign || run.compactMathAtom,
      ) &&
      !previous.href &&
      !run.href &&
      !previous.annotationId &&
      !run.annotationId &&
      !previous.relationshipId &&
      !run.relationshipId &&
      !previous.semanticRole &&
      !run.semanticRole &&
      !previous.targetIds &&
      !run.targetIds
    if (sameStyle) {
      previous.end = run.end
    } else {
      coalescedRuns.push({ ...run })
    }
  }
  return {
    runs: coalescedRuns,
    ledger,
  }
}

function sourceEvidence(
  block: RegionBlock,
  links: PdfLinkAnnotation[],
): NodeSourceEvidence {
  const sourceRegions = blockSourceSegments(block).map(
    (segment) => segment.evidenceRegion ?? segment.region,
  )
  return {
    confidence: rounded(block.confidence),
    pages: [...new Set(sourceRegions.map((region) => region.page))],
    regionIds: [...new Set(sourceRegions.map((region) => region.id))],
    boxes: sourceRegions.flatMap((region) =>
      region.lines.flatMap((line) =>
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
    ),
    links: links.filter(
      (link) =>
        link.box !== null &&
        sourceRegions.some(
          (region) =>
            link.box !== null &&
            link.box.page === region.page &&
            boxesOverlap(link.box, region.box),
        ),
    ),
  }
}

type CanonicalVisualDraft = {
  captionBlock: RegionBlock & { nodeId: string }
  captionEnvelope: NormalizedSourceBox
  lineageBoxes: NormalizedSourceBox[]
  page: number
  id: string
  source: string
}

export function orderCanonicalVisualPairs(
  nodes: ResearchNode[],
  pairs: readonly {
    page: number
    column: PdfRegionColumn
    sourceBox?: NormalizedSourceBox
    visualNodeId: string
    captionNodeId: string
  }[],
  crossReferences: readonly PdfScholarlyCrossReferenceRelationship[] = [],
  diagnostics: ReconstructionDiagnostic[] = [],
  nodeSourceEvidence: Readonly<Record<string, NodeSourceEvidence>> = {},
) {
  const initialNodePositions = new Map(
    nodes.map((node, index) => [node.id, index] as const),
  )
  const initialNodesById = new Map(
    nodes.map((node) => [node.id, node] as const),
  )
  const comparePairSourceOrder = (
    left: (typeof pairs)[number],
    right: (typeof pairs)[number],
  ) => {
    const sourceColumnRank = (pair: (typeof pairs)[number]) =>
      pair.column === 'right' ? 1 : pair.column === 'left' ? 0 : -1
    return (
      left.page - right.page ||
      sourceColumnRank(left) - sourceColumnRank(right) ||
      (left.sourceBox?.y ?? Number.MAX_SAFE_INTEGER) -
        (right.sourceBox?.y ?? Number.MAX_SAFE_INTEGER) ||
      (left.sourceBox?.x ?? Number.MAX_SAFE_INTEGER) -
        (right.sourceBox?.x ?? Number.MAX_SAFE_INTEGER) ||
      (initialNodePositions.get(left.captionNodeId) ??
        Number.MAX_SAFE_INTEGER) -
        (initialNodePositions.get(right.captionNodeId) ??
          Number.MAX_SAFE_INTEGER) ||
      left.captionNodeId.localeCompare(right.captionNodeId)
    )
  }
  const integerLabelForPair = (pair: (typeof pairs)[number]) => {
    const caption = initialNodesById.get(pair.captionNodeId)
    if (caption?.type !== 'caption') return null
    const parsed = parsePdfScholarlyVisualLabel(caption.text, {
      context: 'caption',
    })
    if (parsed?.status !== 'parsed' || !/^\d+$/u.test(parsed.identifier)) {
      return null
    }
    return {
      kind: parsed.kind,
      ordinal: Number(parsed.identifier),
    }
  }
  const comparePairScopedOrder = (
    left: (typeof pairs)[number],
    right: (typeof pairs)[number],
  ) => {
    const leftLabel = integerLabelForPair(left)
    const rightLabel = integerLabelForPair(right)
    if (
      leftLabel &&
      rightLabel &&
      leftLabel.kind === rightLabel.kind &&
      leftLabel.ordinal !== rightLabel.ordinal
    ) {
      return leftLabel.ordinal - rightLabel.ordinal
    }
    return comparePairSourceOrder(left, right)
  }
  const sourceOrderedPairs = [...pairs]
    .filter(
      (pair) =>
        initialNodePositions.has(pair.visualNodeId) &&
        initialNodePositions.has(pair.captionNodeId),
    )
    .sort(comparePairScopedOrder)
  const sourceRankByVisualNodeId = new Map(
    sourceOrderedPairs.map(
      (pair, index) => [pair.visualNodeId, index] as const,
    ),
  )
  const pairByVisualNodeId = new Map(
    sourceOrderedPairs.map((pair) => [pair.visualNodeId, pair] as const),
  )
  const preservesAtomicSourcePairOrder = () => {
    let previousRank = -1
    let encountered = 0
    for (const [nodeIndex, node] of nodes.entries()) {
      const sourceRank = sourceRankByVisualNodeId.get(node.id)
      if (sourceRank === undefined) continue
      const pair = pairByVisualNodeId.get(node.id)
      if (
        !pair ||
        nodes[nodeIndex + 1]?.id !== pair.captionNodeId ||
        sourceRank <= previousRank
      ) {
        return false
      }
      previousRank = sourceRank
      encountered += 1
    }
    return encountered === sourceOrderedPairs.length
  }
  const restoreNodes = (snapshot: readonly ResearchNode[]) => {
    nodes.splice(0, nodes.length, ...snapshot)
  }
  const pairsByPage = new Map<number, typeof pairs>()
  for (const pair of pairs) {
    const pagePairs = pairsByPage.get(pair.page) ?? []
    pairsByPage.set(pair.page, [...pagePairs, pair])
  }

  for (const pagePairs of pairsByPage.values()) {
    const sourcePositions = new Map(
      nodes.map((node, index) => [node.id, index] as const),
    )
    const pairNodeIds = new Set(
      pagePairs.flatMap(({ visualNodeId, captionNodeId }) => [
        visualNodeId,
        captionNodeId,
      ]),
    )
    const pairSlots = nodes.flatMap((node, index) =>
      pairNodeIds.has(node.id) ? [index] : [],
    )
    const pairsAreContiguous =
      pairSlots.length > 0 &&
      pairSlots.at(-1)! - pairSlots[0] + 1 === pairSlots.length
    const hasProvenColumnFlow =
      pagePairs.some((pair) => pair.column === 'left') &&
      pagePairs.some((pair) => pair.column === 'right')
    const pagePairLabels = pagePairs.map(integerLabelForPair)
    const hasProvedIntegerLabelOrder =
      pagePairs.every(
        (pair) =>
          pair.sourceBox !== undefined &&
          validNormalizedSourceBox(pair.sourceBox),
      ) &&
      pagePairLabels.every(
        (label): label is NonNullable<typeof label> => label !== null,
      ) &&
      new Set(pagePairLabels.map((label) => label.kind)).size === 1
    const orderedPairs =
      hasProvenColumnFlow || hasProvedIntegerLabelOrder
        ? [...pagePairs].sort(comparePairScopedOrder)
        : !pairsAreContiguous
          ? [...pagePairs].sort(
              (left, right) =>
                (sourcePositions.get(left.captionNodeId) ??
                  Number.MAX_SAFE_INTEGER) -
                  (sourcePositions.get(right.captionNodeId) ??
                    Number.MAX_SAFE_INTEGER) ||
                left.captionNodeId.localeCompare(right.captionNodeId),
            )
          : pagePairs
    const orderedIds = orderedPairs.flatMap(
      ({ visualNodeId, captionNodeId }) => [visualNodeId, captionNodeId],
    )
    const uniqueIds = new Set(orderedIds)
    if (uniqueIds.size !== orderedIds.length) continue

    const nodesById = new Map(
      nodes
        .filter((node) => uniqueIds.has(node.id))
        .map((node) => [node.id, node]),
    )
    const slots = pairSlots
    if (
      nodesById.size !== orderedIds.length ||
      slots.length !== orderedIds.length
    ) {
      continue
    }
    for (const [index, nodeId] of orderedIds.entries()) {
      nodes[slots[index]] = nodesById.get(nodeId)!
    }
  }

  const headingScopeForAnchor = (anchorNodeId: string) => {
    const anchorIndex = nodes.findIndex((node) => node.id === anchorNodeId)
    if (anchorIndex < 0) return null
    for (let index = anchorIndex; index >= 0; index -= 1) {
      if (nodes[index].type === 'heading') {
        return { headingNodeId: nodes[index].id, anchorIndex }
      }
    }
    return null
  }
  const precedingReferenceScopes = (pair: (typeof pairs)[number]) =>
    crossReferences.flatMap((relationship) => {
      if (
        relationship.status !== 'matched' ||
        relationship.canonicalAnchor === null ||
        !relationship.targetNodeIds.includes(pair.visualNodeId) ||
        !relationship.targets.some(
          (target) =>
            target.status === 'matched' &&
            target.targetNodeId === pair.visualNodeId,
        ) ||
        !relationship.sourceBoxes.some((box) => box.page < pair.page)
      ) {
        return []
      }
      const scope = headingScopeForAnchor(relationship.canonicalAnchor.nodeId)
      return scope ? [{ ...scope, relationship }] : []
    })
  const adjacentPairRuns: Array<Array<(typeof pairs)[number]>> = []
  const positionedPairs = pairs
    .flatMap((pair) => {
      const visualIndex = nodes.findIndex(
        (node) => node.id === pair.visualNodeId,
      )
      const captionIndex = nodes.findIndex(
        (node) => node.id === pair.captionNodeId,
      )
      return visualIndex >= 0 &&
        captionIndex === visualIndex + 1 &&
        pair.sourceBox
        ? [{ pair, visualIndex, captionIndex }]
        : []
    })
    .sort(
      (left, right) =>
        left.visualIndex - right.visualIndex ||
        left.pair.visualNodeId.localeCompare(right.pair.visualNodeId),
    )
  for (const positioned of positionedPairs) {
    const run = adjacentPairRuns.at(-1)
    const previousPair = run?.at(-1)
    const previousCaptionIndex = previousPair
      ? nodes.findIndex((node) => node.id === previousPair.captionNodeId)
      : -1
    if (run && positioned.visualIndex === previousCaptionIndex + 1) {
      run.push(positioned.pair)
    } else {
      adjacentPairRuns.push([positioned.pair])
    }
  }
  const deferredPairRuns = adjacentPairRuns.filter((run) => {
    if (run.length < 2 || Object.keys(nodeSourceEvidence).length === 0) {
      return false
    }
    const provedScopes = new Set(
      run.flatMap((pair) => {
        const orderedReferences = precedingReferenceScopes(pair).sort(
          (left, right) =>
            right.anchorIndex - left.anchorIndex ||
            left.relationship.id.localeCompare(right.relationship.id),
        )
        return orderedReferences[0]?.headingNodeId
          ? [orderedReferences[0].headingNodeId]
          : []
      }),
    )
    return provedScopes.size >= 2
  })
  const deferredVisualPairIds = new Set(
    deferredPairRuns.flatMap((run) => run.map((pair) => pair.visualNodeId)),
  )

  const containmentCandidates = pairs
    .flatMap((pair) => {
      const visualIndex = nodes.findIndex(
        (node) => node.id === pair.visualNodeId,
      )
      const captionIndex = nodes.findIndex(
        (node) => node.id === pair.captionNodeId,
      )
      if (
        visualIndex < 0 ||
        captionIndex !== visualIndex + 1 ||
        !pair.sourceBox
      ) {
        return []
      }
      const sourceColumn = (
        box: NormalizedSourceBox,
      ): 'left' | 'right' | 'span' => {
        if (box.width >= 0.65 || (box.x < 0.45 && box.x + box.width > 0.55)) {
          return 'span'
        }
        return box.x + box.width / 2 < 0.5 ? 'left' : 'right'
      }
      const pairSourceColumn = sourceColumn(pair.sourceBox)
      if (
        (pair.column === 'left' || pair.column === 'right') &&
        pair.column !== pairSourceColumn
      ) {
        return []
      }
      const sourceColumnRank = (box: NormalizedSourceBox) => {
        const column = sourceColumn(box)
        return column === 'right' ? 1 : column === 'left' ? 0 : -1
      }
      const exactReferenceEnvelope = (
        boxes: readonly NormalizedSourceBox[],
      ) => {
        const first = boxes[0]
        if (
          !first ||
          boxes.some(
            (box) =>
              box.page !== first.page ||
              box.rotation !== first.rotation ||
              box.method !== first.method ||
              !validNormalizedSourceBox(box),
          )
        ) {
          return null
        }
        const left = Math.min(...boxes.map((box) => box.x))
        const top = Math.min(...boxes.map((box) => box.y))
        const right = Math.max(...boxes.map((box) => box.x + box.width))
        const bottom = Math.max(...boxes.map((box) => box.y + box.height))
        const envelope: NormalizedSourceBox = {
          page: first.page,
          x: rounded(left),
          y: rounded(top),
          width: rounded(right - left),
          height: rounded(bottom - top),
          rotation: first.rotation,
          method: first.method,
        }
        return validNormalizedSourceBox(envelope) ? envelope : null
      }
      const exactReferences = crossReferences
        .flatMap((relationship) => {
          if (
            relationship.status !== 'matched' ||
            relationship.canonicalAnchor === null ||
            !relationship.targetNodeIds.includes(pair.visualNodeId) ||
            !relationship.targets.some(
              (target) =>
                target.status === 'matched' &&
                target.targetNodeId === pair.visualNodeId,
            )
          ) {
            return []
          }
          const referenceBox = exactReferenceEnvelope(relationship.sourceBoxes)
          if (!referenceBox) return []
          const anchorIndex = nodes.findIndex(
            (node) => node.id === relationship.canonicalAnchor!.nodeId,
          )
          return anchorIndex >= 0
            ? [
                {
                  anchorIndex,
                  relationship,
                  referenceBox,
                },
              ]
            : []
        })
        .flatMap((candidate) => {
          let containingHeadingIndex = -1
          for (let index = candidate.anchorIndex; index >= 0; index -= 1) {
            if (nodes[index].type === 'heading') {
              containingHeadingIndex = index
              break
            }
          }
          const containingHeading = nodes[containingHeadingIndex]
          return [
            {
              ...candidate,
              containingHeadingIndex,
              containingHeading:
                containingHeading?.type === 'heading'
                  ? containingHeading
                  : null,
            },
          ]
        })
      const isDeferredMultiScopePair = deferredVisualPairIds.has(
        pair.visualNodeId,
      )
      const precedingExactReferences = exactReferences.filter(
        (candidate) =>
          candidate.referenceBox.page < pair.page ||
          (candidate.referenceBox.page === pair.page &&
            (sourceColumnRank(candidate.referenceBox) <
              sourceColumnRank(pair.sourceBox!) ||
              (sourceColumnRank(candidate.referenceBox) ===
                sourceColumnRank(pair.sourceBox!) &&
                candidate.referenceBox.y <= pair.sourceBox!.y))),
      )
      const ownershipReferences =
        isDeferredMultiScopePair && precedingExactReferences.length > 0
          ? precedingExactReferences
          : exactReferences
      if (ownershipReferences.length === 0) return []

      const headingScopeIds = new Set(
        ownershipReferences.map(
          (candidate) =>
            candidate.containingHeading?.id ?? 'document-root-heading-scope',
        ),
      )
      const sourceOrderedReferences = [...ownershipReferences].sort(
        (left, right) =>
          left.anchorIndex - right.anchorIndex ||
          left.referenceBox.page - right.referenceBox.page ||
          sourceColumnRank(left.referenceBox) -
            sourceColumnRank(right.referenceBox) ||
          left.referenceBox.y - right.referenceBox.y ||
          left.relationship.id.localeCompare(right.relationship.id),
      )
      const hasNodeSourceEvidence = Object.keys(nodeSourceEvidence).length > 0
      const samePhysicalLane = (box: NormalizedSourceBox) => {
        if (pair.column === 'left' || pair.column === 'right') {
          const headingColumn = sourceColumn(box)
          return headingColumn === pair.column || headingColumn === 'span'
        }
        const overlap =
          Math.min(
            pair.sourceBox!.x + pair.sourceBox!.width,
            box.x + box.width,
          ) - Math.max(pair.sourceBox!.x, box.x)
        return overlap > Math.min(pair.sourceBox!.width, box.width) * 0.25
      }
      const physicalHeadingCandidates = hasNodeSourceEvidence
        ? nodes.flatMap((node, index) => {
            if (node.type !== 'heading') return []
            const precedingBoxes = (
              nodeSourceEvidence[node.id]?.boxes ?? []
            ).filter(
              (box) =>
                box.page <= pair.page &&
                samePhysicalLane(box) &&
                (box.page < pair.page || box.y <= pair.sourceBox!.y + 0.004),
            )
            const latestBox = precedingBoxes.sort(
              (left, right) =>
                right.page - left.page ||
                sourceColumnRank(right) - sourceColumnRank(left) ||
                right.y - left.y ||
                right.x - left.x,
            )[0]
            return latestBox ? [{ index, box: latestBox }] : []
          })
        : nodes.flatMap((node, index) =>
            index < visualIndex && node.type === 'heading'
              ? [
                  {
                    index,
                    box: null,
                  },
                ]
              : [],
          )
      const physicalHeadingIndex =
        physicalHeadingCandidates
          .sort((left, right) => {
            if (left.box && right.box) {
              return (
                left.box.page - right.box.page ||
                sourceColumnRank(left.box) - sourceColumnRank(right.box) ||
                left.box.y - right.box.y ||
                left.box.x - right.box.x ||
                left.index - right.index
              )
            }
            return left.index - right.index
          })
          .at(-1)?.index ?? -1
      const physicalHeading = nodes[physicalHeadingIndex]
      const physicalHeadingScopeId =
        physicalHeading?.type === 'heading' ? physicalHeading.id : null

      if (physicalHeadingScopeId !== null && headingScopeIds.size > 1) {
        if (isDeferredMultiScopePair) {
          // A later-page run of adjacent visual-caption pairs can be a
          // source-authored float queue. Its exact anchors, not the final
          // heading before that queue, prove the intended Appendix scopes.
        } else {
          diagnostics.push({
            code: 'AMBIGUOUS_READING_ORDER',
            severity: 'error',
            page: pair.page,
            message: `Canonical visual ${pair.visualNodeId} has exact references in ${headingScopeIds.size} distinct heading or document-root scopes; source order is retained for review.`,
            sourceBoxes: sourceOrderedReferences.map(
              (candidate) => candidate.referenceBox,
            ),
            target: {
              regionIds: sourceOrderedReferences.map(
                (candidate) => candidate.relationship.referenceRegionId,
              ),
              markerId: null,
            },
          })
          return []
        }
      }

      const scopeDistance = new Map<string, number>()
      for (const candidate of ownershipReferences) {
        const scopeId =
          candidate.containingHeading?.id ?? 'document-root-heading-scope'
        scopeDistance.set(
          scopeId,
          Math.min(
            scopeDistance.get(scopeId) ?? Number.MAX_SAFE_INTEGER,
            Math.abs(candidate.anchorIndex - visualIndex),
          ),
        )
      }
      const orderedScopeDistances = [...scopeDistance].sort(
        ([leftId, leftDistance], [rightId, rightDistance]) =>
          leftDistance - rightDistance || leftId.localeCompare(rightId),
      )
      const nearestScopeIsUnique =
        orderedScopeDistances.length === 1 ||
        orderedScopeDistances[0][1] < orderedScopeDistances[1][1]
      if (physicalHeadingScopeId === null && !nearestScopeIsUnique) {
        diagnostics.push({
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'error',
          page: pair.page,
          message: `Canonical visual ${pair.visualNodeId} has equally near exact references in distinct heading or document-root scopes; source order is retained for review.`,
          sourceBoxes: sourceOrderedReferences.map(
            (candidate) => candidate.referenceBox,
          ),
          target: {
            regionIds: sourceOrderedReferences.map(
              (candidate) => candidate.relationship.referenceRegionId,
            ),
            markerId: null,
          },
        })
        return []
      }
      const selectedReferenceScopeId =
        !isDeferredMultiScopePair &&
        physicalHeadingScopeId !== null &&
        headingScopeIds.has(physicalHeadingScopeId)
          ? physicalHeadingScopeId
          : orderedScopeDistances[0][0]
      const selectedReferences = ownershipReferences
        .filter(
          (candidate) =>
            (candidate.containingHeading?.id ??
              'document-root-heading-scope') === selectedReferenceScopeId,
        )
        .sort(
          (left, right) =>
            Math.abs(left.anchorIndex - visualIndex) -
              Math.abs(right.anchorIndex - visualIndex) ||
            left.anchorIndex - right.anchorIndex ||
            left.relationship.id.localeCompare(right.relationship.id),
        )
      const firstExactReference = selectedReferences[0]
      const containingHeading = firstExactReference.containingHeading
      const referenceHeadingScopeId =
        containingHeading?.id ?? 'document-root-heading-scope'
      if (
        !isDeferredMultiScopePair &&
        physicalHeadingScopeId !== null &&
        physicalHeadingScopeId !== referenceHeadingScopeId
      ) {
        diagnostics.push({
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'error',
          page: pair.page,
          message: `Canonical visual ${pair.visualNodeId} is physically source-ordered in heading scope ${physicalHeadingScopeId}, while its exact reference is in ${referenceHeadingScopeId}; source order is retained for review.`,
          relationshipId: firstExactReference.relationship.id,
          sourceBoxes: [
            pair.sourceBox,
            ...selectedReferences.map((candidate) => candidate.referenceBox),
          ],
          target: {
            regionIds: selectedReferences.map(
              (candidate) => candidate.relationship.referenceRegionId,
            ),
            markerId: null,
          },
        })
        return []
      }
      if (!containingHeading) return []
      const boundaryIndex = nodes.findIndex(
        (node, index) =>
          index > firstExactReference.containingHeadingIndex &&
          node.type === 'heading' &&
          node.level <= containingHeading.level,
      )
      const scopeEndIndex = boundaryIndex < 0 ? nodes.length : boundaryIndex
      if (
        visualIndex > firstExactReference.containingHeadingIndex &&
        captionIndex < scopeEndIndex
      ) {
        return []
      }
      return [
        {
          ...pair,
          sourceIndex: visualIndex,
          anchorNodeId:
            firstExactReference.relationship.canonicalAnchor!.nodeId,
          scopeHeadingNodeId: containingHeading.id,
          boundaryNodeId: boundaryIndex < 0 ? null : nodes[boundaryIndex].id,
          referenceRegionId: firstExactReference.relationship.referenceRegionId,
          relationshipId: firstExactReference.relationship.id,
          referenceBox: firstExactReference.referenceBox,
        },
      ]
    })
    .sort(
      (left, right) =>
        left.sourceIndex - right.sourceIndex ||
        left.visualNodeId.localeCompare(right.visualNodeId),
    )

  for (const pair of containmentCandidates) {
    const visualIndex = nodes.findIndex((node) => node.id === pair.visualNodeId)
    const captionIndex = nodes.findIndex(
      (node) => node.id === pair.captionNodeId,
    )
    const anchorIndex = nodes.findIndex((node) => node.id === pair.anchorNodeId)
    const boundaryIndex =
      pair.boundaryNodeId === null
        ? nodes.length
        : nodes.findIndex((node) => node.id === pair.boundaryNodeId)
    if (
      visualIndex < 0 ||
      captionIndex !== visualIndex + 1 ||
      anchorIndex < 0 ||
      boundaryIndex <= anchorIndex
    ) {
      continue
    }
    const nodeSnapshot = [...nodes]
    const pairNodes = nodes.splice(visualIndex, 2)
    const insertionIndex =
      pair.boundaryNodeId === null
        ? nodes.length
        : nodes.findIndex((node) => node.id === pair.boundaryNodeId)
    if (insertionIndex < 0) {
      nodes.splice(visualIndex, 0, ...pairNodes)
      continue
    }
    const scopeHeadingIndex = nodes.findIndex(
      (node) => node.id === pair.scopeHeadingNodeId,
    )
    const laterPeerIndex =
      scopeHeadingIndex < 0
        ? -1
        : (pairs
            .filter(
              (candidate) =>
                candidate.visualNodeId !== pair.visualNodeId &&
                comparePairScopedOrder(pair, candidate) < 0,
            )
            .flatMap((candidate) => {
              const candidateIndex = nodes.findIndex(
                (node) => node.id === candidate.visualNodeId,
              )
              return candidateIndex > scopeHeadingIndex &&
                candidateIndex < insertionIndex
                ? [candidateIndex]
                : []
            })
            .sort((left, right) => left - right)[0] ?? -1)
    nodes.splice(
      laterPeerIndex >= 0 ? laterPeerIndex : insertionIndex,
      0,
      ...pairNodes,
    )
    if (!preservesAtomicSourcePairOrder()) {
      restoreNodes(nodeSnapshot)
      diagnostics.push({
        code: 'AMBIGUOUS_READING_ORDER',
        severity: 'error',
        page: pair.page,
        message: `Canonical visual ${pair.visualNodeId} was retained at its source position because the proposed reference-scope placement would reverse source-proved visual-caption pair order.`,
        relationshipId: pair.relationshipId,
        sourceBoxes: [
          ...(pair.sourceBox ? [pair.sourceBox] : []),
          pair.referenceBox,
        ],
        target: {
          regionIds: [pair.referenceRegionId],
          markerId: null,
        },
      })
      continue
    }
    diagnostics.push({
      code: 'RESOLVED_READING_ORDER',
      severity: 'info',
      page: pair.page,
      message: `Placed canonical visual ${pair.visualNodeId} within its one proved reference scope using the nearest exact anchor while preserving source order among visual pairs.`,
      relationshipId: pair.relationshipId,
      sourceBoxes: [pair.referenceBox],
      target: {
        regionIds: [pair.referenceRegionId],
        markerId: null,
      },
    })
  }

  for (const run of deferredPairRuns) {
    const scopedPairs = run.map((pair) => {
      const references = precedingReferenceScopes(pair).sort(
        (left, right) =>
          right.anchorIndex - left.anchorIndex ||
          left.relationship.id.localeCompare(right.relationship.id),
      )
      return {
        pair,
        owner: references[0] ?? null,
        hasMatchedReference: crossReferences.some(
          (relationship) =>
            relationship.status === 'matched' &&
            relationship.canonicalAnchor !== null &&
            relationship.targetNodeIds.includes(pair.visualNodeId) &&
            relationship.targets.some(
              (target) =>
                target.status === 'matched' &&
                target.targetNodeId === pair.visualNodeId,
            ),
        ),
      }
    })
    for (const [pairIndex, scopedPair] of scopedPairs.entries()) {
      if (scopedPair.owner || scopedPair.hasMatchedReference) continue
      const precedingOwner = scopedPairs
        .slice(0, pairIndex)
        .reverse()
        .find((candidate) => candidate.owner)?.owner
      const followingOwner = scopedPairs
        .slice(pairIndex + 1)
        .find((candidate) => candidate.owner)?.owner
      if (!precedingOwner || !followingOwner) continue

      const precedingHeadingPosition = initialNodePositions.get(
        precedingOwner.headingNodeId,
      )
      const followingHeadingPosition = initialNodePositions.get(
        followingOwner.headingNodeId,
      )
      if (
        precedingHeadingPosition === undefined ||
        followingHeadingPosition === undefined ||
        precedingHeadingPosition > followingHeadingPosition
      ) {
        continue
      }
      const slotHeading =
        precedingOwner.headingNodeId === followingOwner.headingNodeId
          ? initialNodesById.get(precedingOwner.headingNodeId)
          : (nodes
              .filter(
                (node) =>
                  node.type === 'heading' &&
                  (initialNodePositions.get(node.id) ?? -1) >
                    precedingHeadingPosition &&
                  (initialNodePositions.get(node.id) ??
                    Number.MAX_SAFE_INTEGER) < followingHeadingPosition,
              )
              .sort(
                (left, right) =>
                  (initialNodePositions.get(right.id) ?? -1) -
                  (initialNodePositions.get(left.id) ?? -1),
              )[0] ?? initialNodesById.get(precedingOwner.headingNodeId))
      if (slotHeading?.type !== 'heading') continue

      const visualIndex = nodes.findIndex(
        (node) => node.id === scopedPair.pair.visualNodeId,
      )
      const captionIndex = nodes.findIndex(
        (node) => node.id === scopedPair.pair.captionNodeId,
      )
      const slotHeadingIndex = nodes.findIndex(
        (node) => node.id === slotHeading.id,
      )
      if (
        visualIndex < 0 ||
        captionIndex !== visualIndex + 1 ||
        slotHeadingIndex < 0
      ) {
        continue
      }
      const originalBoundaryIndex = nodes.findIndex(
        (node, index) =>
          index > slotHeadingIndex &&
          node.type === 'heading' &&
          node.level <= slotHeading.level,
      )
      const scopeEndIndex =
        originalBoundaryIndex < 0 ? nodes.length : originalBoundaryIndex
      if (visualIndex > slotHeadingIndex && captionIndex < scopeEndIndex) {
        continue
      }

      const boundaryNodeId =
        originalBoundaryIndex < 0 ? null : nodes[originalBoundaryIndex].id
      const nodeSnapshot = [...nodes]
      const pairNodes = nodes.splice(visualIndex, 2)
      const insertionBoundary =
        boundaryNodeId === null
          ? nodes.length
          : nodes.findIndex((node) => node.id === boundaryNodeId)
      if (insertionBoundary < 0) {
        nodes.splice(visualIndex, 0, ...pairNodes)
        continue
      }
      const currentSlotHeadingIndex = nodes.findIndex(
        (node) => node.id === slotHeading.id,
      )
      const laterPeerIndex =
        run
          .filter(
            (candidate) =>
              candidate.visualNodeId !== scopedPair.pair.visualNodeId &&
              comparePairScopedOrder(scopedPair.pair, candidate) < 0,
          )
          .flatMap((candidate) => {
            const candidateIndex = nodes.findIndex(
              (node) => node.id === candidate.visualNodeId,
            )
            return candidateIndex > currentSlotHeadingIndex &&
              candidateIndex < insertionBoundary
              ? [candidateIndex]
              : []
          })
          .sort((left, right) => left - right)[0] ?? -1
      nodes.splice(
        laterPeerIndex >= 0 ? laterPeerIndex : insertionBoundary,
        0,
        ...pairNodes,
      )
      if (!preservesAtomicSourcePairOrder()) {
        restoreNodes(nodeSnapshot)
        diagnostics.push({
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'error',
          page: scopedPair.pair.page,
          message: `Canonical visual ${scopedPair.pair.visualNodeId} was retained at its source position because the only inferred scope placement would reverse source-proved visual-caption pair order.`,
          sourceBoxes: scopedPair.pair.sourceBox
            ? [scopedPair.pair.sourceBox]
            : [],
          target: {
            regionIds: [
              precedingOwner.relationship.referenceRegionId,
              followingOwner.relationship.referenceRegionId,
            ],
            markerId: null,
          },
        })
        continue
      }
      diagnostics.push({
        code: 'AMBIGUOUS_READING_ORDER',
        severity: 'error',
        page: scopedPair.pair.page,
        message: `Canonical visual ${scopedPair.pair.visualNodeId} has no exact reference; its complete visual-caption pair remains in source order at the only slot bounded by adjacent source-proved Appendix scopes.`,
        sourceBoxes: scopedPair.pair.sourceBox
          ? [scopedPair.pair.sourceBox]
          : [],
        target: {
          regionIds: [
            precedingOwner.relationship.referenceRegionId,
            followingOwner.relationship.referenceRegionId,
          ],
          markerId: null,
        },
      })
    }
  }
}

function placeMatchedCanonicalNotes(
  nodes: ResearchNode[],
  relationships: readonly PdfNoteRelationship[],
) {
  const sourcePositions = new Map(
    nodes.map((node, index) => [node.id, index] as const),
  )
  const matchedByTarget = new Map<
    string,
    Array<
      PdfNoteRelationship & {
        targetNoteId: string
        canonicalAnchor: NonNullable<PdfNoteRelationship['canonicalAnchor']>
      }
    >
  >()
  for (const relationship of relationships) {
    if (
      relationship.status !== 'matched' ||
      relationship.targetNoteId === null ||
      relationship.canonicalAnchor === null
    ) {
      continue
    }
    const matches = matchedByTarget.get(relationship.targetNoteId) ?? []
    matches.push(
      relationship as PdfNoteRelationship & {
        targetNoteId: string
        canonicalAnchor: NonNullable<PdfNoteRelationship['canonicalAnchor']>
      },
    )
    matchedByTarget.set(relationship.targetNoteId, matches)
  }

  const moved = new Set<string>()
  const authorNotes: ResearchNode[] = []
  const notesAfterOwner = new Map<string, ResearchNode[]>()
  for (const [targetNoteId, targetRelationships] of matchedByTarget) {
    const note = nodes.find(
      (node) => node.id === targetNoteId && node.type === 'footnote',
    )
    if (!note) continue
    const anchorKinds = new Set(
      targetRelationships.map(
        (relationship) => relationship.canonicalAnchor.kind,
      ),
    )
    if (anchorKinds.size !== 1) continue
    if (anchorKinds.has('author')) {
      authorNotes.push(note)
      moved.add(note.id)
      continue
    }
    const ownerIds = [
      ...new Set(
        targetRelationships.flatMap((relationship) =>
          relationship.canonicalAnchor.kind === 'node'
            ? [relationship.canonicalAnchor.nodeId]
            : [],
        ),
      ),
    ]
    if (
      ownerIds.length === 0 ||
      ownerIds.some((ownerId) => !sourcePositions.has(ownerId))
    ) {
      continue
    }
    const ownerId = ownerIds.sort(
      (left, right) => sourcePositions.get(right)! - sourcePositions.get(left)!,
    )[0]
    const ownerNotes = notesAfterOwner.get(ownerId) ?? []
    ownerNotes.push(note)
    notesAfterOwner.set(ownerId, ownerNotes)
    moved.add(note.id)
  }

  const sourceOrder = (left: ResearchNode, right: ResearchNode) =>
    sourcePositions.get(left.id)! - sourcePositions.get(right.id)!
  authorNotes.sort(sourceOrder)
  for (const ownerNotes of notesAfterOwner.values()) {
    ownerNotes.sort(sourceOrder)
  }
  const placed = nodes
    .filter((node) => !moved.has(node.id))
    .flatMap((node) => [node, ...(notesAfterOwner.get(node.id) ?? [])])
  nodes.splice(0, nodes.length, ...authorNotes, ...placed)
}

function canonicalVisualDraft(
  relationship: PdfVisualRelationship,
  blocks: RegionBlock[],
  assetsById: ReadonlyMap<string, PdfVisualAsset>,
  embeddedLinks: PdfLinkAnnotation[],
  sourceHash: string,
): CanonicalVisualDraft | null {
  const captionBlock = blocks.find(
    (block): block is RegionBlock & { nodeId: string } =>
      block.region.id === relationship.captionRegionId && Boolean(block.nodeId),
  )
  relationship.captionNodeId = captionBlock?.nodeId ?? null
  // Table and equation relationships carry their bounded content scope in
  // sourceBoxes. The caption is identified separately, so never infer it from
  // the first content box: doing so loses a valid caption-below table node.
  const captionPlaceholder = captionBlock?.region.box
  const lineageBoxes = visualLineageBoxes(relationship, assetsById)
  const verifiedCaptionEnvelope =
    captionBlock && captionPlaceholder
      ? captionProvenanceEnvelope(
          sourceEvidence(captionBlock, embeddedLinks),
          relationship.captionRegionId,
          captionPlaceholder,
          {
            allowExactRegionOverflow:
              relationship.kind === 'equation' &&
              relationship.altTextSource === 'source-text' &&
              relationship.sourceRegionIds.includes(
                relationship.captionRegionId,
              ),
          },
        )
      : null
  // A caption can contain source-backed runs whose PDF coordinates extend
  // beyond its classified region (for example, an adjacent export stamp). The
  // caption node is already canonical and source-identified; retain its
  // bounded region as the relationship anchor instead of discarding a fully
  // validated table crop and all of its table-cell provenance.
  const captionEnvelope =
    verifiedCaptionEnvelope ??
    (captionBlock && validNormalizedSourceBox(captionBlock.region.box)
      ? { ...captionBlock.region.box }
      : null)
  if (
    relationship.status !== 'matched' ||
    !captionBlock ||
    !captionPlaceholder ||
    !sameSourceBox(captionPlaceholder, captionBlock.region.box) ||
    !captionEnvelope ||
    !lineageBoxes
  ) {
    return null
  }
  const page = captionEnvelope.page
  const id = visualCanonicalNodeId(relationship, page)
  relationship.canonicalNodeId = id
  return {
    captionBlock,
    captionEnvelope,
    lineageBoxes,
    page,
    id,
    source: `pdf:${sourceHash.slice(0, 16)}#page=${page}`,
  }
}

export async function reconstructPageAnalyses({
  pages,
  sourceHash,
  fileName,
  byteLength,
  metadata = {},
  rasterizeFigure,
}: {
  pages: PdfPageAnalysis[]
  sourceHash: string
  fileName: string
  byteLength: number
  metadata?: PdfDocumentMetadata
  rasterizeFigure?: PdfFigureRasterizer
}): Promise<PdfReconstruction> {
  const normalizedPageLinks = pages.map((page) =>
    normalizePdfLinkAnnotations(page.page, page.links ?? []),
  )
  const embeddedLinks = normalizedPageLinks.flat()
  pages = pages.map((page, index) => ({
    ...page,
    ...(page.links !== undefined ? { links: normalizedPageLinks[index] } : {}),
  }))
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
    if (page.ocr && page.ocr.confidence < 0.75) {
      diagnostics.push({
        code: 'LOW_CONFIDENCE_OCR',
        severity: 'error',
        page: page.page,
        message: `Page ${page.page} OCR confidence ${page.ocr.confidence.toFixed(3)} is below the review threshold 0.750.`,
      })
    }
    if (page.ocr?.words.some((word) => word.mergeStatus === 'conflict')) {
      diagnostics.push({
        code: 'MIXED_OCR_CONFLICT',
        severity: 'error',
        page: page.page,
        message: `Page ${page.page} retains conflicting embedded and OCR text at overlapping source boxes for review.`,
      })
    }
    if (page.spread?.status === 'uncertain') {
      diagnostics.push({
        code: 'UNCERTAIN_SPREAD_BOUNDARY',
        severity: 'error',
        page: page.page,
        message: `Page ${page.page} is likely a two-page scan, but its logical split boundary remains uncertain.`,
      })
    }
  }

  const regionResult = reconstructPageRegions(pages)
  for (const diagnostic of diagnostics.filter(
    (candidate) => candidate.code === 'MIXED_PAGE' && candidate.page,
  )) {
    diagnostic.target = {
      regionIds: regionResult.regions
        .filter((region) => region.page === diagnostic.page)
        .map((region) => region.id),
      markerId: null,
    }
  }
  const regionMap = new Map(
    regionResult.regions.map((region) => [region.id, region]),
  )
  const markerResult = classifyPdfNoteMarkers(
    regionResult.regions,
    regionResult.readingOrder.order,
    regionResult.lineBoundaryDecisions,
  )
  const bibliographyRegionIds = new Set(markerResult.bibliographyRegionIds)
  const orderedRegions = regionResult.readingOrder.order
    .map((id) => regionMap.get(id))
    .filter((region): region is PdfPageRegion => Boolean(region))
  if (regionResult.repeatedMarginCount > 0) {
    diagnostics.push({
      code: 'REPEATED_MARGIN_TEXT',
      severity: 'info',
      message: `Removed ${regionResult.repeatedMarginCount} repeated header or footer pattern${regionResult.repeatedMarginCount === 1 ? '' : 's'} from reading order.`,
      target: {
        regionIds: regionResult.regions
          .filter(
            (region) => region.kind === 'header' || region.kind === 'footer',
          )
          .map((region) => region.id),
        markerId: null,
      },
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
        target: { regionIds: [regionId], markerId: null },
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
      target: {
        regionIds: resolution?.regionIds ?? [],
        markerId: null,
      },
    })
  }
  if (!regionResult.readingOrder.acyclic) {
    diagnostics.push({
      code: 'READING_ORDER_CYCLE',
      severity: 'error',
      message: 'The accepted reading-order edges contain a cycle.',
    })
  }

  for (const classification of markerResult.classifications) {
    diagnostics.push({
      code: 'CLASSIFIED_NOTE_MARKER',
      severity: 'info',
      page: classification.sourceBox.page,
      message: `Classified ${classification.id} as ${classification.taxonomy} at confidence ${classification.confidence.toFixed(2)} against threshold ${classification.threshold.toFixed(2)} using ${classification.evidence.join(', ')}.`,
      noteMarkerClassification: classification,
    })
  }

  const visualResult = await reconstructPdfVisuals({
    pages,
    regions: regionResult.regions,
    rasterizeFigure,
  })
  diagnostics.push(...visualResult.diagnostics)
  const citationLedRegionIds = new Set(
    markerResult.classifications.flatMap((classification) => {
      const sourceRegion = regionMap.get(classification.referenceRegionId)
      return classification.accepted &&
        classification.disposition === 'citation' &&
        sourceRegion &&
        sourceRegion.text.slice(0, classification.start).trim() === ''
        ? [classification.referenceRegionId]
        : []
    }),
  )
  const blocks = blocksFromRegions(
    orderedRegions,
    regionResult.regions,
    visualResult.consumedRegionIds,
    bibliographyRegionIds,
    new Map(
      visualResult.relationships.flatMap((relationship) => {
        if (relationship.kind !== 'equation') return []
        const captionRegion = regionMap.get(relationship.captionRegionId)
        const matchedSourceCaption =
          relationship.status === 'matched' &&
          relationship.sourceRegionIds.includes(relationship.captionRegionId) &&
          (relationship.altTextSource === 'source-text' ||
            relationship.evidence.includes('source-text-transcript-unresolved'))
        const unresolvedTwoDimensionalCaption =
          relationship.status !== 'matched' &&
          relationship.sourceText.trim() === '' &&
          relationship.altTextSource === 'caption' &&
          relationship.evidence.includes('source-text-transcript-unresolved') &&
          relationship.candidates.some((candidate) =>
            candidate.sourceRegionIds.includes(relationship.captionRegionId),
          ) &&
          captionRegion !== undefined &&
          hasUnprovedTwoDimensionalEquationTranscript([captionRegion])
        return matchedSourceCaption || unresolvedTwoDimensionalCaption
          ? [
              [
                relationship.captionRegionId,
                relationship.altTextSource === 'source-text'
                  ? relationship.sourceText
                  : relationship.altText,
              ] as const,
            ]
          : []
      }),
    ),
    visualResult.consumedLineIds,
    regionResult.lineBoundaryDecisions,
    diagnostics,
    citationLedRegionIds,
  )
  const markerClassifications = synthesizeRecoveredBibliographyClassifications(
    markerResult.classifications,
    blocks,
  )
  const originalClassificationIds = new Set(
    markerResult.classifications.map((classification) => classification.id),
  )
  for (const classification of markerClassifications.filter(
    (candidate) => !originalClassificationIds.has(candidate.id),
  )) {
    diagnostics.push({
      code: 'CLASSIFIED_NOTE_MARKER',
      severity: 'info',
      page: classification.sourceBox.page,
      message: `Classified ${classification.id} as ${classification.taxonomy} at confidence ${classification.confidence.toFixed(2)} against threshold ${classification.threshold.toFixed(2)} using ${classification.evidence.join(', ')}.`,
      noteMarkerClassification: classification,
    })
  }
  const frontMatter = classifyFrontMatter(
    blocks,
    metadata.title,
    regionResult.lineBoundaryDecisions,
  )
  const orderedTitleBlocks = blocks
    .filter((block) => block.frontMatterRole === 'title')
    .sort(
      (left, right) =>
        left.region.page - right.region.page ||
        left.region.box.y - right.region.box.y ||
        left.region.box.x - right.region.box.x,
    )
  const canonicalTitleBlock =
    frontMatter.title &&
    orderedTitleBlocks.length > 0 &&
    orderedTitleBlocks.every((block) => block.text === block.text.trim()) &&
    orderedTitleBlocks.some((block) =>
      block.region.lines.some((line) =>
        line.runs.some((run) => Boolean(runVerticalAlign(line, run))),
      ),
    ) &&
    orderedTitleBlocks.map((block) => block.text).join(' ') ===
      frontMatter.title
      ? orderedTitleBlocks[0]
      : undefined
  if (canonicalTitleBlock) {
    canonicalTitleBlock.type = 'heading'
    canonicalTitleBlock.headingLevel = 1
    for (const continuation of orderedTitleBlocks.slice(1)) {
      appendBlockContinuation(canonicalTitleBlock, continuation)
    }
  }
  const canonicalBlocks = blocks.filter(
    (block) =>
      (block.frontMatterRole !== 'title' || block === canonicalTitleBlock) &&
      block.frontMatterRole !== 'author' &&
      block.frontMatterRole !== 'affiliation',
  )
  const sourceRegionLines = regionResult.regions.flatMap(
    (region) => region.lines,
  )
  const canonicalFloatScopes: CanonicalFloatScopeEvidence[] = []
  mergeProseContinuations(canonicalBlocks, {
    ownedFloatCaptionRegionIds: new Set(
      visualResult.relationships.flatMap((relationship) =>
        relationship.status === 'matched' && relationship.kind !== 'equation'
          ? [relationship.captionRegionId]
          : [],
      ),
    ),
    hardHyphenLexicon: inlineHardHyphenLexicon(sourceRegionLines),
    unhyphenatedLexicon: inlineUnhyphenatedLexicon(sourceRegionLines),
    diagnostics,
    canonicalFloatScopes,
  })
  noteNodeIds(blocks)
  for (const [index, block] of blocks.entries()) {
    block.nodeId ??= nodeId(index, block.type, block.text)
  }
  const citationRelationships = buildCitationRelationships(
    markerClassifications,
    canonicalBlocks,
  )
  const authorNoteReferences = detectAuthorNoteReferences(
    blocks,
    markerClassifications,
  )
  const sourceAuthors =
    frontMatter.authors.length > 0
      ? frontMatter.authors
      : inferredAuthors(blocks)
  const authorResolution = resolvePdfAuthors(sourceAuthors, metadata.author)
  const paperAuthors = authorResolution.authors
  const affiliationLabels = new Set(
    frontMatter.affiliations.flatMap(
      (affiliation) =>
        affiliation.match(/^\s*([\d*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+)(?=\s|\p{L})/u)?.[1] ?? [],
    ),
  )
  const authorAffiliations = [
    ...new Map(
      detectAuthorAffiliationReferences(blocks, markerClassifications)
        .filter(
          (reference) =>
            paperAuthors.includes(reference.author) &&
            affiliationLabels.has(reference.label),
        )
        .map(
          (reference) =>
            [`${reference.author}\u0000${reference.label}`, reference] as const,
        ),
    ).values(),
  ]
  const renderedAuthorNoteReferences = authorNoteReferences.filter(
    (reference) => paperAuthors.includes(reference.author),
  )
  const visualAssetsById = new Map(
    visualResult.assets.map((asset) => [asset.id, asset] as const),
  )
  const canonicalVisualDrafts = new Map<string, CanonicalVisualDraft>()
  for (const relationship of visualResult.relationships) {
    const draft = canonicalVisualDraft(
      relationship,
      blocks,
      visualAssetsById,
      embeddedLinks,
      sourceHash,
    )
    if (draft) canonicalVisualDrafts.set(relationship.id, draft)
  }
  const canonicalCrossReferenceTargets = [
    ...canonicalHeadingCrossReferenceTargets(canonicalBlocks),
    ...canonicalVisualCrossReferenceTargets(visualResult.relationships),
  ]
  const hyperlinkResolution = resolveCanonicalHyperlinkObligations({
    blocks: canonicalBlocks,
    annotations: embeddedLinks,
    lineBoundaryDecisions: regionResult.lineBoundaryDecisions,
    canonicalInternalSurfaces: canonicalCitationHyperlinkSurfaces(
      citationRelationships,
      canonicalBlocks,
    ),
    canonicalOccurrences: canonicalTableHyperlinkOccurrences(
      visualResult.relationships,
      canonicalVisualDrafts,
      visualResult.canonicalTablesByAssetId,
    ),
    canonicalTargets: [
      ...canonicalCrossReferenceTargets,
      ...canonicalCitationInternalLinkTargets(
        citationRelationships,
        canonicalBlocks,
      ),
      ...canonicalBibliographyInternalLinkTargets(canonicalBlocks),
      ...canonicalNoteInternalLinkTargets(blocks),
    ],
  })
  diagnostics.push(...hyperlinkResolution.diagnostics)
  const canonicalVisualTextOwners = visualResult.relationships.flatMap(
    (relationship) => {
      const draft = canonicalVisualDrafts.get(relationship.id)
      if (!draft) return []
      const owner = canonicalVisualTextOwner(
        relationship,
        draft.id,
        regionResult.regions,
        regionResult.lineBoundaryDecisions,
      )
      return owner ? [owner] : []
    },
  )
  const canonicalVisualTextOwnersByNodeId = new Map(
    canonicalVisualTextOwners.map((owner) => [owner.nodeId, owner] as const),
  )
  for (const relationship of citationRelationships) {
    const candidates = canonicalBlocks.flatMap((block) => {
      if (block.type !== 'heading' && block.type !== 'paragraph') return []
      const range = exactCanonicalRangeForSource(
        block,
        relationship.referenceRegionId,
        relationship.referenceStart,
        relationship.referenceEnd,
      )
      return range && block.nodeId ? [{ nodeId: block.nodeId, ...range }] : []
    })
    candidates.push(
      ...canonicalVisualTextOwners.flatMap((owner) => {
        const range = exactVisualCanonicalRangeForSource(
          owner,
          relationship,
          regionMap,
        )
        return range ? [range] : []
      }),
    )
    relationship.canonicalAnchor =
      candidates.length === 1 ? candidates[0] : null
  }
  for (const relationship of citationRelationships.filter(
    (candidate) => candidate.status === 'unresolved',
  )) {
    diagnostics.push({
      code: 'UNRESOLVED_CITATION_REFERENCE',
      severity: 'error',
      page: relationship.sourceBoxes[0]?.page,
      message: `Citation marker ${relationship.id} has no complete bibliography-label target.`,
      sourceBoxes: relationship.sourceBoxes,
      relationshipId: relationship.id,
      target: {
        regionIds: [relationship.referenceRegionId],
        markerId: relationship.id,
      },
    })
  }
  for (const relationship of citationRelationships.filter(
    (candidate) =>
      candidate.status === 'matched' && candidate.canonicalAnchor === null,
  )) {
    diagnostics.push({
      code: 'UNMAPPED_CITATION_ANCHOR',
      severity: 'error',
      page: relationship.sourceBoxes[0]?.page,
      message: `Citation marker ${relationship.id} has bibliography targets but no exact canonical inline anchor.`,
      sourceBoxes: relationship.sourceBoxes,
      relationshipId: relationship.id,
      target: {
        regionIds: [relationship.referenceRegionId],
        markerId: relationship.id,
      },
    })
  }
  const crossReferenceRegions = new Map<string, PdfPageRegion>()
  for (const block of canonicalBlocks) {
    if (
      block.type !== 'paragraph' ||
      block.list?.numberingId === 'references'
    ) {
      continue
    }
    for (const segment of blockSourceSegments(block)) {
      crossReferenceRegions.set(segment.region.id, segment.region)
    }
  }
  const crossReferenceRelationships = resolvePdfScholarlyCrossReferences({
    regions: [...crossReferenceRegions.values()],
    canonicalTargets: canonicalCrossReferenceTargets,
  })
  for (const relationship of crossReferenceRelationships) {
    const candidates = canonicalBlocks.flatMap((block) => {
      if (
        !block.nodeId ||
        (block.type !== 'heading' && block.type !== 'paragraph')
      ) {
        return []
      }
      const range = exactCanonicalRangeForSource(
        block,
        relationship.referenceRegionId,
        relationship.referenceStart,
        relationship.referenceEnd,
      )
      return range &&
        block.text.slice(range.start, range.end) === relationship.text
        ? [{ nodeId: block.nodeId, ...range }]
        : []
    })
    relationship.canonicalAnchor =
      candidates.length === 1 ? candidates[0] : null
  }
  for (const relationship of crossReferenceRelationships.filter(
    (candidate) => candidate.status !== 'matched',
  )) {
    const ambiguous = relationship.status === 'ambiguous'
    diagnostics.push({
      code: ambiguous
        ? 'AMBIGUOUS_SCHOLARLY_CROSS_REFERENCE'
        : 'UNRESOLVED_SCHOLARLY_CROSS_REFERENCE',
      severity: 'error',
      page: relationship.sourceBoxes[0]?.page,
      message: ambiguous
        ? `${relationship.text} maps to more than one canonical scholarly target.`
        : `${relationship.text} has no complete canonical scholarly target.`,
      sourceBoxes: relationship.sourceBoxes,
      relationshipId: relationship.id,
      target: {
        regionIds: [relationship.referenceRegionId],
        markerId: relationship.id,
      },
    })
  }
  for (const relationship of crossReferenceRelationships.filter(
    (candidate) =>
      candidate.status === 'matched' && candidate.canonicalAnchor === null,
  )) {
    diagnostics.push({
      code: 'UNMAPPED_SCHOLARLY_CROSS_REFERENCE_ANCHOR',
      severity: 'error',
      page: relationship.sourceBoxes[0]?.page,
      message: `${relationship.text} has canonical targets but no exact canonical inline anchor.`,
      sourceBoxes: relationship.sourceBoxes,
      relationshipId: relationship.id,
      target: {
        regionIds: [relationship.referenceRegionId],
        markerId: relationship.id,
      },
    })
  }
  const citationsById = new Map(
    citationRelationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  )
  const semanticReferencesByRegion = new Map<string, SemanticReferenceDraft[]>()
  for (const classification of markerClassifications) {
    const semanticRole = semanticRoleForClassification(classification)
    if (!semanticRole || !classification.accepted) continue
    const citation = citationsById.get(classification.id)
    const values =
      semanticReferencesByRegion.get(classification.referenceRegionId) ?? []
    values.push({
      id: classification.id,
      start: classification.start,
      end: classification.end,
      semanticRole,
      ...(citation?.targetNodeIds.length
        ? { targetIds: citation.targetNodeIds }
        : {}),
    })
    semanticReferencesByRegion.set(classification.referenceRegionId, values)
  }
  for (const relationship of crossReferenceRelationships) {
    const values =
      semanticReferencesByRegion.get(relationship.referenceRegionId) ?? []
    values.push({
      id: relationship.id,
      start: relationship.referenceStart,
      end: relationship.referenceEnd,
      semanticRole: 'cross-reference',
      ...(relationship.targetNodeIds.length > 0
        ? { targetIds: relationship.targetNodeIds }
        : {}),
    })
    semanticReferencesByRegion.set(relationship.referenceRegionId, values)
  }
  const authorRegionIds = new Set(
    blocks
      .filter((block) => block.frontMatterRole === 'author')
      .map((block) => block.region.id),
  )
  const rawReferences = [
    ...detectReferences(markerClassifications, regionMap).filter(
      (reference) => !authorRegionIds.has(reference.region.id),
    ),
    ...renderedAuthorNoteReferences,
  ]
  const renderedAuthorReferenceIds = new Set(
    renderedAuthorNoteReferences.map((reference) => reference.id),
  )
  const references = rawReferences.map<NoteReferenceDraft>((reference) => ({
    ...reference,
    canonicalAnchor: exactCanonicalNoteReferenceAnchor(
      reference,
      canonicalBlocks,
      renderedAuthorReferenceIds,
    ),
  }))
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

  if (canonicalBlocks.length === 0) {
    diagnostics.push({
      code: 'NO_RECONSTRUCTABLE_TEXT',
      severity: 'error',
      message: 'No reconstructable embedded text was found.',
    })
  }

  const provenance: Record<string, NodeSourceEvidence> = {}
  const inlineSpanLedger: InlineMappingLedger = {
    expected: citationRelationships.length + crossReferenceRelationships.length,
    mapped:
      citationRelationships.filter(
        (relationship) => relationship.canonicalAnchor !== null,
      ).length +
      crossReferenceRelationships.filter(
        (relationship) => relationship.canonicalAnchor !== null,
      ).length,
  }
  const nodes: ResearchNode[] = canonicalBlocks.map((block, index) => {
    const id = block.nodeId ?? nodeId(index, block.type, block.text)
    provenance[id] = sourceEvidence(block, embeddedLinks)
    if (isIsolatedProseGlyph(block)) {
      diagnostics.push({
        code: 'ISOLATED_PROSE_GLYPH',
        severity: 'error',
        page: block.region.page,
        message: `An isolated alphabetic glyph remains in canonical prose on page ${block.region.page}; source-region evidence is insufficient to classify it as a visual, table, list, equation, or page-furniture fragment.`,
        sourceBoxes: [block.region.box],
        target: {
          regionIds: [block.region.id],
          markerId: null,
        },
      })
    }
    if (
      block.confidence < 0.75 &&
      !regionResult.ambiguousPages.includes(block.region.page)
    ) {
      diagnostics.push({
        code: 'LOW_CONFIDENCE_BLOCK',
        severity: 'warning',
        page: block.region.page,
        message: `A reconstructed ${block.region.kind} region on page ${block.region.page} needs review.`,
        sourceBoxes: [block.region.box],
        target: {
          regionIds: [block.region.id],
          markerId: null,
        },
      })
    }
    const source = `pdf:${sourceHash.slice(0, 16)}#page=${block.region.page}`
    if (block.type === 'footnote') {
      const inlineMapping = block.suppressSourceInlineRuns
        ? { runs: [], ledger: { expected: 0, mapped: 0 } }
        : sourceInlineRuns(
            block,
            embeddedLinks,
            hyperlinkResolution.mappings,
            regionResult.lineBoundaryDecisions,
            [],
          )
      inlineSpanLedger.expected += inlineMapping.ledger.expected
      inlineSpanLedger.mapped += inlineMapping.ledger.mapped
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
        ...(block.noteMarkerText ? { markerText: block.noteMarkerText } : {}),
        text: block.text,
        ...(inlineMapping.runs.length > 0
          ? { inlineRuns: inlineMapping.runs }
          : {}),
        relationships: { backlinks },
        source,
      }
    }
    const sourceNoteReferences = [...matchedReferences.values()].flatMap(
      (relationship) => {
        const draft = referenceDrafts.get(relationship.id)!
        const anchor = draft.canonicalAnchor
        return anchor?.kind === 'node' && anchor.nodeId === id
          ? [
              {
                id: relationship.id,
                label: relationship.label,
                target: relationship.targetNoteId,
                start: draft.start,
                end: draft.end,
                regionId: relationship.referenceRegionId,
                confidence: relationship.confidence,
                canonicalRange: {
                  start: anchor.start,
                  end: anchor.end,
                },
              },
            ]
          : []
      },
    )
    const noteReferences = sourceNoteReferences.map((reference) => ({
      id: reference.id,
      label: reference.label,
      target: reference.target,
      ...reference.canonicalRange,
      confidence: reference.confidence,
    }))
    const semanticReferences = blockSourceSegments(block).flatMap((segment) =>
      (semanticReferencesByRegion.get(segment.region.id) ?? []).flatMap(
        (reference) => {
          if (reference.semanticRole !== 'citation') {
            return [{ ...reference, regionId: segment.region.id }]
          }
          const anchor = citationsById.get(reference.id)?.canonicalAnchor
          return anchor?.nodeId === id
            ? [{ ...reference, regionId: segment.region.id }]
            : []
        },
      ),
    )
    const inlineMapping = block.suppressSourceInlineRuns
      ? { runs: [], ledger: { expected: 0, mapped: 0 } }
      : sourceInlineRuns(
          block,
          embeddedLinks,
          hyperlinkResolution.mappings,
          regionResult.lineBoundaryDecisions,
          sourceNoteReferences,
          semanticReferences,
        )
    inlineSpanLedger.expected += inlineMapping.ledger.expected
    inlineSpanLedger.mapped += inlineMapping.ledger.mapped
    const inlineRuns = inlineMapping.runs
    if (block.type === 'heading') {
      return {
        id,
        type: 'heading' as const,
        level: block.headingLevel ?? (2 as const),
        text: block.text,
        ...(noteReferences.length > 0 ? { noteReferences } : {}),
        ...(inlineRuns.length > 0 ? { inlineRuns } : {}),
        source,
      }
    }
    if (block.type === 'caption') {
      return {
        id,
        type: 'caption' as const,
        text: block.text,
        ...(inlineRuns.length > 0 ? { inlineRuns } : {}),
        source,
      }
    }
    return {
      id,
      type: 'paragraph' as const,
      text: block.text,
      ...(noteReferences.length > 0 ? { noteReferences } : {}),
      ...(inlineRuns.length > 0 ? { inlineRuns } : {}),
      ...(block.list ? { list: block.list } : {}),
      source,
    }
  })

  for (const relationship of visualResult.relationships) {
    const draft = canonicalVisualDrafts.get(relationship.id)
    if (!draft) continue
    relationship.sourceBoxes = [draft.captionEnvelope, ...draft.lineageBoxes]
    const sourceTable =
      relationship.kind === 'table'
        ? relationship.assetIds
            .map((assetId) =>
              visualResult.canonicalTablesByAssetId.get(assetId),
            )
            .find((candidate) => candidate !== undefined)
        : undefined
    const table = sourceTable
      ? canonicalTableWithApprovedHyperlinks(
          sourceTable,
          hyperlinkResolution.approvedAnnotationIds,
        )
      : undefined
    if (table) {
      for (const cell of table.rows.flatMap((row) => row.cells)) {
        inlineSpanLedger.expected += cell.inlineMapping?.expected ?? 0
        inlineSpanLedger.mapped += cell.inlineMapping?.mapped ?? 0
      }
    }
    const textOwner = canonicalVisualTextOwnersByNodeId.get(draft.id)
    const sourceText = canonicalVisualSourceTranscript(
      relationship,
      textOwner?.text,
    )
    const inlineRuns = textOwner
      ? citationRelationships.flatMap((citation) =>
          citation.canonicalAnchor?.nodeId === draft.id
            ? [
                {
                  start: citation.canonicalAnchor.start,
                  end: citation.canonicalAnchor.end,
                  relationshipId: citation.id,
                  semanticRole: 'citation' as const,
                  targetIds: citation.targetNodeIds,
                },
              ]
            : [],
        )
      : []
    const node: ResearchNode = {
      id: draft.id,
      type: 'figure',
      objectType: relationship.kind,
      ...(table ? { table } : {}),
      ...(sourceText ? { sourceText } : {}),
      ...(inlineRuns.length > 0 ? { inlineRuns } : {}),
      title: relationship.altText,
      relationships: {
        caption: draft.captionBlock.nodeId,
        assets: relationship.assetIds,
      },
      source: draft.source,
    }
    provenance[draft.id] = {
      confidence: relationship.confidence,
      pages: [...new Set(relationship.sourceBoxes.map((box) => box.page))],
      regionIds: [...relationship.sourceRegionIds],
      boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
      links: embeddedLinks.filter(
        (link) =>
          link.box !== null &&
          regionResult.regions
            .filter((region) =>
              relationship.sourceRegionIds.includes(region.id),
            )
            .some((region) =>
              region.lines.some((line) =>
                line.runs.some(
                  (run) => link.box !== null && boxesOverlap(link.box, run),
                ),
              ),
            ),
      ),
    }
    const captionIndex = nodes.findIndex(
      (candidate) => candidate.id === draft.captionBlock.nodeId,
    )
    nodes.splice(captionIndex < 0 ? nodes.length : captionIndex, 0, node)
  }

  orderCanonicalVisualPairs(
    nodes,
    visualResult.relationships.flatMap((relationship) => {
      const draft = canonicalVisualDrafts.get(relationship.id)
      return draft
        ? [
            {
              page: draft.page,
              column: draft.captionBlock.region.column,
              sourceBox: draft.captionEnvelope,
              visualNodeId: draft.id,
              captionNodeId: draft.captionBlock.nodeId,
            },
          ]
        : []
    }),
    crossReferenceRelationships,
    diagnostics,
    provenance,
  )
  placeMatchedCanonicalNotes(nodes, noteRelationships)

  assertUniqueCanonicalNodeIds(nodes)

  const firstHeading = nodes.find(
    (node): node is Extract<ResearchNode, { type: 'heading' }> =>
      node.type === 'heading',
  )
  const firstParagraph = nodes.find(
    (node): node is Extract<ResearchNode, { type: 'paragraph' }> =>
      node.type === 'paragraph',
  )
  const authorNotes = renderedAuthorNoteReferences.flatMap((reference) => {
    const relationship = noteRelationships.find(
      (candidate) =>
        candidate.id === reference.id &&
        candidate.status === 'matched' &&
        candidate.targetNoteId !== null,
    )
    return relationship && paperAuthors.includes(reference.author)
      ? [
          {
            id: reference.id,
            author: reference.author,
            label: reference.label,
            target: relationship.targetNoteId!,
          },
        ]
      : []
  })
  const publicationMetadata = pdfPublicationMetadata(pages, metadata)
  const paper: ResearchPaper = {
    id: `pdf-${sourceHash.slice(0, 16)}`,
    version: '1.0.0-import',
    status: 'working',
    title:
      frontMatter.title ||
      firstHeading?.text ||
      fileName.replace(/\.pdf$/i, ''),
    subtitle:
      metadata.subject?.trim() || `Reconstructed locally from ${fileName}`,
    authors: paperAuthors,
    ...publicationMetadata,
    ...(authorNotes.length > 0 ? { authorNotes } : {}),
    ...(authorAffiliations.length > 0 ? { authorAffiliations } : {}),
    ...(frontMatter.affiliations.length > 0
      ? { affiliations: frontMatter.affiliations }
      : {}),
    updated: validDate(publicationMetadata.artifactModifiedAt),
    abstract:
      frontMatter.abstract.slice(0, 700) ||
      firstParagraph?.text.slice(0, 700) ||
      'This document requires OCR or manual reconstruction before publication.',
    nodes,
  }

  if (frontMatter.detected || authorResolution.unresolvedReasons.length > 0) {
    const comparableFrontMatter = (value: string) =>
      value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const titleComparable = comparableFrontMatter(paper.title)
    const reasons = [
      ...(!frontMatter.title ? ['source title role'] : []),
      ...(paperAuthors.includes('Imported locally')
        ? ['source author role']
        : []),
      ...authorResolution.unresolvedReasons,
      ...(frontMatter.inferredAbstract ? ['source abstract role'] : []),
      ...(paperAuthors.some((author) => {
        const candidate = comparableFrontMatter(author)
        return candidate.length >= 5 && titleComparable.includes(candidate)
      })
        ? ['title/author boundary']
        : []),
      ...(frontMatter.affiliations.some(
        (affiliation) => comparableFrontMatter(affiliation) === titleComparable,
      )
        ? ['title/affiliation boundary']
        : []),
    ]
    if (reasons.length > 0) {
      diagnostics.push({
        code: 'UNRESOLVED_FRONT_MATTER',
        severity: 'error',
        page: 1,
        message: `Publication front matter remains unresolved: ${[
          ...new Set(reasons),
        ].join(', ')}.`,
        sourceBoxes: blocks
          .filter(
            (block) => block.region.page === 1 && block.region.box.y < 0.36,
          )
          .map((block) => block.region.box),
      })
    }
  }

  const classifiedLineBoundaries = classifyStructuralLineBoundaryDecisions({
    decisions: regionResult.lineBoundaryDecisions,
    paper,
    provenance,
    visualRelationships: visualResult.relationships,
    assets: visualResult.assets,
  })

  const assessment = assessPdfCompleteness({
    pages,
    sourceSha256: sourceHash,
    paper,
    diagnostics,
    readingOrder: regionResult.readingOrder,
    regions: regionResult.regions,
    visualRelationships: visualResult.relationships,
    assets: visualResult.assets,
    citationRelationships,
    noteRelationships,
    provenance,
    lineBoundaryDecisions: classifiedLineBoundaries.decisions,
    unresolvedCorruptingJoinCount:
      classifiedLineBoundaries.unresolvedCorruptingJoinCount,
    structurallyConsumedLineBoundaryCount:
      classifiedLineBoundaries.structurallyConsumedLineBoundaryCount,
    inlineSpanLedger,
    hyperlinkLedger: hyperlinkResolution.ledger,
    canonicalFloatScopes,
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
    lineBoundaryDecisions: classifiedLineBoundaries.decisions,
    unresolvedCorruptingJoinCount:
      classifiedLineBoundaries.unresolvedCorruptingJoinCount,
    structurallyConsumedLineBoundaryCount:
      classifiedLineBoundaries.structurallyConsumedLineBoundaryCount,
    readingOrder: regionResult.readingOrder,
    noteRelationships,
    citationRelationships,
    crossReferenceRelationships,
    visualRelationships: visualResult.relationships,
    assets: visualResult.assets,
    provenance,
    humanAdjudications: {
      schemaVersion: '1.0.0',
      documentSha256: sourceHash,
      applied: [],
      stale: [],
      countsByDiagnosticCode: {},
    },
    diagnostics: assessment.diagnostics,
    semanticSignals: assessment.semanticSignals,
    completeness: assessment.completeness,
    readiness: assessment.readiness,
  }
}
