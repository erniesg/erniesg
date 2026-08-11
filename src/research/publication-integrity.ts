import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfNoteRelationship,
  PdfPageRegion,
} from './import-types'
import {
  normalizedNoteLabel,
  noteLabelsFromMarkerText,
} from './note-label'
import type { ResearchNode, ResearchPaper } from './schema'

export type NoteRelationshipSourceEvidence = {
  regions: readonly PdfPageRegion[]
  provenance: Readonly<Record<string, NodeSourceEvidence>>
}

export type CanonicalTextIntegrityIssue = {
  code: 'EPUB_TEXT_SANITIZATION_LOSS'
  nodeId: string
  field: string
  sourceCharacterCount: number
  sanitizedCharacterCount: number
  forbiddenXmlCharacterCount: number
  replacementGlyphCount: number
}

export type InternalReferenceIntegrityIssue = {
  code: 'DANGLING_EPUB_INTERNAL_REFERENCE'
  sourceId: string
  targetId: string
  relationship:
    | 'figure-caption'
    | 'note-reference'
    | 'note-backlink'
    | 'note-anchor'
    | 'note-source-anchor'
    | 'note-orphan'
    | 'citation-target'
    | 'cross-reference-target'
    | 'semantic-reference-text'
  detail?:
    | 'duplicate-rendered-note-reference'
    | 'duplicate-note-backlink'
    | 'missing-note-relationship'
    | 'missing-rendered-note-reference'
    | 'note-target-mismatch'
    | 'note-anchor-mismatch'
    | 'invalid-source-note-anchor'
    | 'duplicate-canonical-note-anchor'
    | 'overlapping-canonical-note-anchor'
    | 'duplicate-source-note-anchor'
    | 'overlapping-source-note-anchor'
    | 'published-orphan-footnote'
    | 'unbounded-scholarly-reference-text'
}

const SCHOLARLY_REFERENCE_PREFIX =
  /^(?:(?:fig(?:ure)?s?|tables?|sections?|secs?|appendix|appendices|eq(?:uation)?s?)\.?\s+|§\s*)/iu
const SCHOLARLY_REFERENCE_CONNECTOR = String.raw`(?:\s*(?:[,;]|\b(?:and|or)\b|[\u2013\u2014-])\s*)`
const CANONICAL_UPPER_ROMAN_IDENTIFIER = String.raw`(?=[IVXLCDM])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})`
const SCHOLARLY_REFERENCE_ATOM = String.raw`(?:[A-Za-z]?\d+(?:\.\d+)*(?:[A-Za-z])?|${CANONICAL_UPPER_ROMAN_IDENTIFIER}|[A-Za-z](?:\.\d+)*)`
const SCHOLARLY_REFERENCE_IDENTIFIER = String.raw`(?:\(${SCHOLARLY_REFERENCE_ATOM}(?:${SCHOLARLY_REFERENCE_CONNECTOR}${SCHOLARLY_REFERENCE_ATOM})*\)|${SCHOLARLY_REFERENCE_ATOM})`
const BOUNDED_SCHOLARLY_REFERENCE_IDENTIFIERS = new RegExp(
  String.raw`^${SCHOLARLY_REFERENCE_IDENTIFIER}(?:${SCHOLARLY_REFERENCE_CONNECTOR}${SCHOLARLY_REFERENCE_IDENTIFIER})*$`,
  'u',
)

export function isBoundedScholarlyReferenceText(value: string) {
  const trimmed = value.trim()
  const prefix = trimmed.match(SCHOLARLY_REFERENCE_PREFIX)?.[0]
  return Boolean(
    prefix &&
    BOUNDED_SCHOLARLY_REFERENCE_IDENTIFIERS.test(trimmed.slice(prefix.length)),
  )
}

function isXml10Character(codePoint: number) {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  )
}

export function sanitizeXmlText(value: string) {
  return [...value]
    .filter((character) => isXml10Character(character.codePointAt(0)!))
    .join('')
}

function canonicalTextFields(node: ResearchNode) {
  const fields: Array<{ field: string; value: string }> = []
  if ('text' in node) fields.push({ field: 'text', value: node.text })
  if (node.type === 'figure') {
    fields.push({ field: 'title', value: node.title })
    if (node.sourceText) {
      fields.push({ field: 'sourceText', value: node.sourceText })
    }
    for (const [rowIndex, row] of (node.table?.rows ?? []).entries()) {
      for (const [cellIndex, cell] of row.cells.entries()) {
        fields.push({
          field: `table.rows[${rowIndex}].cells[${cellIndex}].text`,
          value: cell.text,
        })
      }
    }
  }
  if (node.type === 'paragraph' && node.list?.markerText) {
    fields.push({ field: 'list.markerText', value: node.list.markerText })
  }
  if (node.type === 'footnote') {
    fields.push({ field: 'label', value: node.label })
    if (node.markerText) {
      fields.push({ field: 'markerText', value: node.markerText })
    }
  }
  return fields
}

export function canonicalTextIntegrityIssues(
  paper: ResearchPaper,
): CanonicalTextIntegrityIssue[] {
  return paper.nodes.flatMap((node) =>
    canonicalTextFields(node).flatMap(({ field, value }) => {
      const characters = [...value]
      const sanitized = sanitizeXmlText(value)
      const forbiddenXmlCharacterCount = characters.filter(
        (character) => !isXml10Character(character.codePointAt(0)!),
      ).length
      const replacementGlyphCount = characters.filter(
        (character) => character === '\ufffd',
      ).length
      if (forbiddenXmlCharacterCount === 0 && replacementGlyphCount === 0) {
        return []
      }
      return [
        {
          code: 'EPUB_TEXT_SANITIZATION_LOSS' as const,
          nodeId: node.id,
          field,
          sourceCharacterCount: characters.length,
          sanitizedCharacterCount: [...sanitized].length,
          forbiddenXmlCharacterCount,
          replacementGlyphCount,
        },
      ]
    }),
  )
}

function validNoteReferenceRange(
  text: string,
  reference: { start: number; end: number },
) {
  return (
    reference.start >= 0 &&
    reference.start < reference.end &&
    reference.end <= text.length
  )
}

export function renderableAuthorNoteReferences(paper: ResearchPaper) {
  return (paper.authorNotes ?? []).filter((reference) =>
    paper.authors.includes(reference.author),
  )
}

type RenderedNoteReference =
  | {
      kind: 'node'
      id: string
      label: string
      target: string
      nodeId: string
      start: number
      end: number
    }
  | {
      kind: 'author'
      id: string
      label: string
      target: string
      author: string
    }

function renderedNoteReferences(paper: ResearchPaper): RenderedNoteReference[] {
  return [
    ...renderableAuthorNoteReferences(paper).map((reference) => ({
      kind: 'author' as const,
      id: reference.id,
      label: reference.label,
      target: reference.target,
      author: reference.author,
    })),
    ...paper.nodes.flatMap((node) => [
      ...('noteReferences' in node
        ? (node.noteReferences ?? [])
            .filter((reference) =>
              validNoteReferenceRange(node.text, reference),
            )
            .map((reference) => ({
              kind: 'node' as const,
              id: reference.id,
              label: reference.label,
              target: reference.target,
              nodeId: node.id,
              start: reference.start,
              end: reference.end,
            }))
        : []),
      ...(node.type === 'figure' && node.table
        ? node.table.rows.flatMap((row, rowIndex) =>
            row.cells.flatMap((cell, cellIndex) =>
              (cell.noteReferences ?? [])
                .filter((reference) =>
                  validNoteReferenceRange(cell.text, reference),
                )
                .map((reference) => ({
                  kind: 'node' as const,
                  id: reference.id,
                  label: reference.label,
                  target: reference.target,
                  nodeId: `${node.id}:table:${cell.id ?? `${rowIndex}:${cellIndex}`}`,
                  start: reference.start,
                  end: reference.end,
                })),
            ),
          )
        : []),
    ]),
  ]
}

function groupById<T extends { id: string }>(values: readonly T[]) {
  const grouped = new Map<string, T[]>()
  for (const value of values) {
    const matches = grouped.get(value.id) ?? []
    matches.push(value)
    grouped.set(value.id, matches)
  }
  return grouped
}

type NoteAnchorSpan = {
  id: string
  ownerId: string
  start: number
  end: number
}

function noteAnchorCollisionIssues(
  spans: readonly NoteAnchorSpan[],
  relationship: 'note-anchor' | 'note-source-anchor',
  duplicateDetail:
    'duplicate-canonical-note-anchor' | 'duplicate-source-note-anchor',
  overlapDetail:
    'overlapping-canonical-note-anchor' | 'overlapping-source-note-anchor',
) {
  const issues: InternalReferenceIntegrityIssue[] = []
  const spansByOwner = new Map<string, NoteAnchorSpan[]>()
  for (const span of spans) {
    const ownerSpans = spansByOwner.get(span.ownerId) ?? []
    ownerSpans.push(span)
    spansByOwner.set(span.ownerId, ownerSpans)
  }

  for (const ownerSpans of spansByOwner.values()) {
    const ordered = [...ownerSpans].sort(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        left.id.localeCompare(right.id),
    )
    for (const [index, left] of ordered.entries()) {
      for (const right of ordered.slice(index + 1)) {
        if (right.start >= left.end) break
        const duplicate = left.start === right.start && left.end === right.end
        issues.push({
          code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
          sourceId: right.id,
          targetId: left.id,
          relationship,
          detail: duplicate ? duplicateDetail : overlapDetail,
        })
      }
    }
  }

  return issues
}

function boxesOverlap(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  return (
    left.page === right.page &&
    Math.max(left.x, right.x) <
      Math.min(left.x + left.width, right.x + right.width) &&
    Math.max(left.y, right.y) <
      Math.min(left.y + left.height, right.y + right.height)
  )
}

function validSourceBox(box: NormalizedSourceBox) {
  return (
    Number.isSafeInteger(box.page) &&
    box.page >= 1 &&
    [box.x, box.y, box.width, box.height, box.rotation].every((value) =>
      Number.isFinite(value),
    ) &&
    box.width > 0 &&
    box.height > 0 &&
    ['pdf-text', 'pdf-object', 'pdf-link', 'ocr'].includes(box.method)
  )
}

function sourceLineBoxesForRange(
  region: PdfPageRegion,
  start: number,
  end: number,
) {
  const boxes: NormalizedSourceBox[] = []
  let cursor = 0
  for (const line of region.lines) {
    const lineStart = region.text.indexOf(line.text, cursor)
    if (lineStart < 0) continue
    const lineEnd = lineStart + line.text.length
    cursor = lineEnd
    if (Math.max(start, lineStart) < Math.min(end, lineEnd)) {
      boxes.push(line.box)
    }
  }
  return boxes
}

function tableCellProvenanceOwnerIds(paper: ResearchPaper) {
  return new Map<string, string>(
    paper.nodes.flatMap((node) =>
      node.type === 'figure' && node.table
        ? node.table.rows.flatMap((row, rowIndex) =>
            row.cells.map(
              (cell, cellIndex) =>
                [
                  `${node.id}:table:${cell.id ?? `${rowIndex}:${cellIndex}`}`,
                  node.id,
                ] as const,
            ),
          )
        : [],
    ),
  )
}

function hasValidNoteRelationshipSourceEvidence(
  paper: ResearchPaper,
  relationship: PdfNoteRelationship,
  sourceEvidence: NoteRelationshipSourceEvidence,
) {
  const region = sourceEvidence.regions.find(
    (candidate) => candidate.id === relationship.referenceRegionId,
  )
  if (
    !region ||
    relationship.referenceStart < 0 ||
    relationship.referenceStart >= relationship.referenceEnd ||
    relationship.referenceEnd > region.text.length ||
    noteLabelsFromMarkerText(
      region.text.slice(relationship.referenceStart, relationship.referenceEnd),
    ).join(',') !== normalizedNoteLabel(relationship.label) ||
    relationship.sourceBoxes.length === 0 ||
    relationship.sourceBoxes.some(
      (box) =>
        !validSourceBox(box) ||
        !sourceEvidence.regions.some((candidate) =>
          boxesOverlap(box, candidate.box),
        ),
    )
  ) {
    return false
  }
  const exactLineBoxes = sourceLineBoxesForRange(
    region,
    relationship.referenceStart,
    relationship.referenceEnd,
  )
  if (
    exactLineBoxes.length === 0 ||
    !relationship.sourceBoxes.some((box) =>
      exactLineBoxes.some((lineBox) => boxesOverlap(box, lineBox)),
    )
  ) {
    return false
  }

  const anchor = relationship.canonicalAnchor
  if (anchor?.kind === 'author') {
    return paper.authors.includes(anchor.author)
  }
  if (anchor?.kind !== 'node') return false
  const nodesById = new Map(paper.nodes.map((node) => [node.id, node]))
  const provenanceOwnerId = nodesById.has(anchor.nodeId)
    ? anchor.nodeId
    : tableCellProvenanceOwnerIds(paper).get(anchor.nodeId)
  return Boolean(
    provenanceOwnerId &&
    sourceEvidence.provenance[provenanceOwnerId]?.regionIds.includes(
      relationship.referenceRegionId,
    ),
  )
}

function relationshipMatchesRenderedReference(
  relationship: PdfNoteRelationship,
  reference: RenderedNoteReference,
) {
  const anchor = relationship.canonicalAnchor
  return (
    relationship.targetNoteId === reference.target &&
    normalizedNoteLabel(relationship.label) ===
      normalizedNoteLabel(reference.label) &&
    (anchor?.kind === 'node' && reference.kind === 'node'
      ? anchor.nodeId === reference.nodeId &&
        anchor.start === reference.start &&
        anchor.end === reference.end
      : anchor?.kind === 'author' && reference.kind === 'author'
        ? anchor.author === reference.author
        : false)
  )
}

export function validMatchedSemanticNoteRelationshipIds(
  paper: ResearchPaper,
  noteRelationships: readonly PdfNoteRelationship[],
  sourceEvidence?: NoteRelationshipSourceEvidence,
) {
  const referencesById = groupById(renderedNoteReferences(paper))
  const matchedRelationshipsById = groupById(
    noteRelationships.filter(
      (relationship) => relationship.status === 'matched',
    ),
  )
  const nodesById = new Map(paper.nodes.map((node) => [node.id, node]))
  const validIds = new Set<string>()
  for (const [id, relationships] of matchedRelationshipsById) {
    const references = referencesById.get(id) ?? []
    if (relationships.length !== 1 || references.length !== 1) continue
    const relationship = relationships[0]
    const reference = references[0]
    const target = relationship.targetNoteId
      ? nodesById.get(relationship.targetNoteId)
      : undefined
    if (
      !relationshipMatchesRenderedReference(relationship, reference) ||
      target?.type !== 'footnote' ||
      target.relationships.backlinks.filter((backlink) => backlink === id)
        .length !== 1 ||
      (sourceEvidence !== undefined &&
        !hasValidNoteRelationshipSourceEvidence(
          paper,
          relationship,
          sourceEvidence,
        ))
    ) {
      continue
    }
    validIds.add(id)
  }
  return validIds
}

function semanticNoteRelationshipIntegrityIssues(
  paper: ResearchPaper,
  references: readonly RenderedNoteReference[],
  noteRelationships: readonly PdfNoteRelationship[],
  sourceEvidence?: NoteRelationshipSourceEvidence,
) {
  const issues: InternalReferenceIntegrityIssue[] = []
  const referencesById = groupById(references)
  const matchedRelationships = noteRelationships.filter(
    (relationship) => relationship.status === 'matched',
  )
  const matchedRelationshipsById = groupById(matchedRelationships)

  for (const [id, relationships] of matchedRelationshipsById) {
    const matchingReferences = referencesById.get(id) ?? []
    if (matchingReferences.length !== 1) {
      issues.push({
        code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
        sourceId: id,
        targetId: relationships[0].targetNoteId ?? id,
        relationship: 'note-reference',
        detail: 'missing-rendered-note-reference',
      })
      continue
    }
    if (relationships.length !== 1) {
      issues.push({
        code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
        sourceId: id,
        targetId: matchingReferences[0].target,
        relationship: 'note-reference',
        detail: 'missing-note-relationship',
      })
      continue
    }

    const relationship = relationships[0]
    const reference = matchingReferences[0]
    if (relationship.targetNoteId !== reference.target) {
      issues.push({
        code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
        sourceId: relationship.id,
        targetId: relationship.targetNoteId ?? reference.target,
        relationship: 'note-reference',
        detail: 'note-target-mismatch',
      })
    }

    const anchor = relationship.canonicalAnchor
    if (!relationshipMatchesRenderedReference(relationship, reference)) {
      issues.push({
        code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
        sourceId: relationship.id,
        targetId:
          anchor?.kind === 'node'
            ? anchor.nodeId
            : anchor?.kind === 'author'
              ? anchor.author
              : reference.id,
        relationship: 'note-anchor',
        detail: 'note-anchor-mismatch',
      })
    }
  }

  for (const reference of references) {
    if ((matchedRelationshipsById.get(reference.id) ?? []).length !== 1) {
      issues.push({
        code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
        sourceId: reference.id,
        targetId: reference.target,
        relationship: 'note-reference',
        detail: 'missing-note-relationship',
      })
    }
  }

  for (const relationship of matchedRelationships) {
    if (
      relationship.referenceStart < 0 ||
      relationship.referenceStart >= relationship.referenceEnd ||
      (sourceEvidence !== undefined &&
        !hasValidNoteRelationshipSourceEvidence(
          paper,
          relationship,
          sourceEvidence,
        ))
    ) {
      issues.push({
        code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
        sourceId: relationship.id,
        targetId: relationship.referenceRegionId,
        relationship: 'note-source-anchor',
        detail: 'invalid-source-note-anchor',
      })
    }
  }

  issues.push(
    ...noteAnchorCollisionIssues(
      matchedRelationships.flatMap((relationship) =>
        relationship.canonicalAnchor?.kind === 'node'
          ? [
              {
                id: relationship.id,
                ownerId: relationship.canonicalAnchor.nodeId,
                start: relationship.canonicalAnchor.start,
                end: relationship.canonicalAnchor.end,
              },
            ]
          : [],
      ),
      'note-anchor',
      'duplicate-canonical-note-anchor',
      'overlapping-canonical-note-anchor',
    ),
    ...noteAnchorCollisionIssues(
      matchedRelationships.flatMap((relationship) =>
        relationship.referenceStart >= 0 &&
        relationship.referenceStart < relationship.referenceEnd
          ? [
              {
                id: relationship.id,
                ownerId: relationship.referenceRegionId,
                start: relationship.referenceStart,
                end: relationship.referenceEnd,
              },
            ]
          : [],
      ),
      'note-source-anchor',
      'duplicate-source-note-anchor',
      'overlapping-source-note-anchor',
    ),
  )

  return issues
}

export function internalReferenceIntegrityIssues(
  paper: ResearchPaper,
  noteRelationships?: readonly PdfNoteRelationship[],
  sourceEvidence?: NoteRelationshipSourceEvidence,
): InternalReferenceIntegrityIssue[] {
  const issues: InternalReferenceIntegrityIssue[] = []
  const nodesById = new Map(paper.nodes.map((node) => [node.id, node]))
  const renderedReferences = renderedNoteReferences(paper)
  const referencesById = groupById(renderedReferences)

  for (const node of paper.nodes) {
    if (node.type === 'figure') {
      if (nodesById.get(node.relationships.caption)?.type !== 'caption') {
        issues.push({
          code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
          sourceId: node.id,
          targetId: node.relationships.caption,
          relationship: 'figure-caption',
        })
      }
    }
    if ('inlineRuns' in node) {
      const inlineText =
        node.type === 'figure' ? (node.sourceText ?? '') : node.text
      for (const run of node.inlineRuns ?? []) {
        if (
          run.semanticRole === 'cross-reference' &&
          run.relationshipId &&
          run.start >= 0 &&
          run.start < run.end &&
          run.end <= inlineText.length &&
          !isBoundedScholarlyReferenceText(inlineText.slice(run.start, run.end))
        ) {
          issues.push({
            code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
            sourceId: run.relationshipId,
            targetId: run.targetIds?.[0] ?? node.id,
            relationship: 'semantic-reference-text',
            detail: 'unbounded-scholarly-reference-text',
          })
        }
        if (
          (run.semanticRole !== 'citation' &&
            run.semanticRole !== 'cross-reference') ||
          !run.targetIds?.length ||
          run.start < 0 ||
          run.start >= run.end ||
          run.end > inlineText.length
        ) {
          continue
        }
        for (const targetId of run.targetIds) {
          if (!nodesById.has(targetId)) {
            issues.push({
              code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
              sourceId: run.relationshipId ?? node.id,
              targetId,
              relationship:
                run.semanticRole === 'citation'
                  ? 'citation-target'
                  : 'cross-reference-target',
            })
          }
        }
      }
    }
    if (node.type === 'figure' && node.table) {
      for (const cell of node.table.rows.flatMap((row) => row.cells)) {
        for (const run of cell.inlineRuns ?? []) {
          if (
            (run.semanticRole !== 'citation' &&
              run.semanticRole !== 'cross-reference') ||
            !run.targetIds?.length ||
            run.start < 0 ||
            run.start >= run.end ||
            run.end > cell.text.length
          ) {
            continue
          }
          for (const targetId of run.targetIds) {
            if (!nodesById.has(targetId)) {
              issues.push({
                code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
                sourceId: run.relationshipId ?? cell.id ?? node.id,
                targetId,
                relationship:
                  run.semanticRole === 'citation'
                    ? 'citation-target'
                    : 'cross-reference-target',
              })
            }
          }
        }
      }
    }
    if (node.type !== 'footnote') continue
    const backlinkCounts = new Map<string, number>()
    for (const backlink of node.relationships.backlinks) {
      backlinkCounts.set(backlink, (backlinkCounts.get(backlink) ?? 0) + 1)
    }
    for (const [backlink, count] of backlinkCounts) {
      if (count !== 1) {
        issues.push({
          code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
          sourceId: node.id,
          targetId: backlink,
          relationship: 'note-backlink',
          detail: 'duplicate-note-backlink',
        })
      }
      const references = referencesById.get(backlink) ?? []
      if (references.length !== 1 || references[0].target !== node.id) {
        issues.push({
          code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
          sourceId: node.id,
          targetId: backlink,
          relationship: 'note-backlink',
        })
      }
    }
    if (
      paper.status === 'published' &&
      node.relationships.backlinks.length === 0
    ) {
      issues.push({
        code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
        sourceId: node.id,
        targetId: node.id,
        relationship: 'note-orphan',
        detail: 'published-orphan-footnote',
      })
    }
  }

  for (const [id, references] of referencesById) {
    if (references.length !== 1) {
      issues.push({
        code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
        sourceId: id,
        targetId: references[0].target,
        relationship: 'note-reference',
        detail: 'duplicate-rendered-note-reference',
      })
    }
  }

  for (const reference of renderedReferences) {
    const target = nodesById.get(reference.target)
    const backlinkCount =
      target?.type === 'footnote'
        ? target.relationships.backlinks.filter(
            (backlink) => backlink === reference.id,
          ).length
        : 0
    if (target?.type !== 'footnote' || backlinkCount !== 1) {
      issues.push({
        code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
        sourceId: reference.id,
        targetId: reference.target,
        relationship: 'note-reference',
      })
    }
  }

  if (noteRelationships !== undefined) {
    issues.push(
      ...semanticNoteRelationshipIntegrityIssues(
        paper,
        renderedReferences,
        noteRelationships,
        sourceEvidence,
      ),
    )
  } else {
    issues.push(
      ...noteAnchorCollisionIssues(
        renderedReferences.flatMap((reference) =>
          reference.kind === 'node'
            ? [
                {
                  id: reference.id,
                  ownerId: reference.nodeId,
                  start: reference.start,
                  end: reference.end,
                },
              ]
            : [],
        ),
        'note-anchor',
        'duplicate-canonical-note-anchor',
        'overlapping-canonical-note-anchor',
      ),
    )
  }

  return issues
}

export function assertPublicationIntegrity(
  paper: ResearchPaper,
  noteRelationships?: readonly PdfNoteRelationship[],
  sourceEvidence?: NoteRelationshipSourceEvidence,
) {
  const textIssues = canonicalTextIntegrityIssues(paper)
  if (textIssues.length > 0) {
    const first = textIssues[0]
    throw new Error(
      `EPUB_TEXT_SANITIZATION_LOSS: ${textIssues.length} canonical text field${textIssues.length === 1 ? '' : 's'} contain forbidden XML code points or Unicode replacement glyphs; first affected field is ${first.nodeId}.${first.field}.`,
    )
  }
  const referenceIssues = internalReferenceIntegrityIssues(
    paper,
    noteRelationships,
    sourceEvidence,
  )
  if (referenceIssues.length > 0) {
    const first = referenceIssues[0]
    throw new Error(
      `DANGLING_EPUB_INTERNAL_REFERENCE: ${referenceIssues.length} canonical dangling internal reference${referenceIssues.length === 1 ? '' : 's'} cannot resolve; first affected relationship is ${first.relationship}${first.detail ? ` (${first.detail})` : ''} from ${first.sourceId} to ${first.targetId}.`,
    )
  }
}
