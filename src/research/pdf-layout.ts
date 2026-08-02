import type { ResearchNode, ResearchPaper } from './schema'
import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfCanonicalHyphenBoundaryDecision,
  PdfCitationRelationship,
  PdfImportProgress,
  PdfLinkAnnotation,
  PdfLinkSourceAnchor,
  PdfLinkSourceAnchorFragment,
  PdfLineBoundaryDecision,
  PdfNoteMarkerClassification,
  PdfNoteRelationship,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfRegionColumn,
  PdfReconstruction,
  PdfScholarlyCrossReferenceRelationship,
  PdfSourceSemanticFlowBoundaryDecision,
  PdfSourceRun,
  PdfVisualAsset,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import { PdfImportError } from './import-types'
import {
  resolvePdfScholarlyCrossReferences,
  type PdfCanonicalCrossReferenceTarget,
} from './pdf-cross-references'
import {
  assessPdfCompleteness,
  classifyStructuralLineBoundaryDecisions,
  sourceSemanticFlowHyphenVerdict,
  type CanonicalFloatScopeEvidence,
} from './pdf-quality'
import { parsePdfCitationSurface } from './pdf-citation-surface'
import {
  classifyPdfNoteMarkers,
  pdfAlternateAuthorYearKeyFromBoundary,
  pdfAuthorYearKey,
  noteLabelsFromMarkerText,
  pdfBibliographyAuthorYearKey,
  pdfBibliographyFirstAuthorSurname,
  PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
  splitPdfCompoundAffiliationNote,
} from './pdf-note-classifier'
import {
  inlineHardHyphenLexicon,
  inlineUnhyphenatedLexicon,
  mergePdfRunText,
  positionedPdfPrefixAccentText,
  replayPdfRegionLineRanges,
} from './pdf-lines'
import {
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE,
  PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE,
  resolvePdfHyphenBoundary,
  type PdfHyphenBoundaryProof,
} from './pdf-hyphenation'
import { sourceMathAtomCompactionRanges } from './pdf-inline-script-integrity'
import { inferPublicationLanguageFromPdfText } from './pdf-language'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import {
  normalizePdfLinkAnnotations,
  normalizedPdfExternalLinkTarget,
  resolvePdfInternalLinkAnnotation,
  resolvePdfExternalLinkSourceIntervalOwnership,
  resolvePdfLinkedTokenRangeContinuity,
  resolveRegisteredPdfLinkedTokenContinuity,
  safePdfExternalLinkTarget,
  type PdfCanonicalInternalLinkTarget,
} from './pdf-links'
import {
  reconstructPdfVisuals,
  visualCanonicalNodeId,
  type PdfFigureRasterizer,
} from './pdf-visuals'
import type { TableCandidateProvider } from './table-candidate-provider'
export { visualCanonicalNodeId } from './pdf-visuals'
import {
  canonicalPdfSourceSemanticFlowEvidence,
  PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_SPACE_WHITESPACE_EVIDENCE,
  pdfSourceFragmentId,
  pdfSourceSemanticFlowBoundaryDecisionId,
  pdfSourceSemanticFlowRunSha256,
  normalizedNoteLabel,
  noteLabelFromText,
  reconstructPageRegions,
} from './pdf-regions'
import type { CanonicalTable } from './visual-assets'

export type PdfDocumentMetadata = {
  title?: string
  author?: string
  subject?: string
  language?: string
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

// A section ordinal is a numeral, not a word. Papers number sections with
// arabic digits, upper or lower roman numerals, or letters, and the numeral
// system carries no evidence about whether a line is a heading. Matching only
// single characters silently accepts `I.` and `X.` while rejecting `II.`
// through `IX.`, which drops most sections of a roman-numbered paper.
const SECTION_ORDINAL_SOURCE =
  '(?:\\d+|[IVXLCDM]+|[ivxlcdm]+|[A-Za-z])(?:\\.\\d+){0,3}'

function headingLevel(text: string, largestFont: number, bodySize: number) {
  // Depth comes from the ordinal's dotted segments, whatever numeral system
  // the paper uses. Reading depth from arabic and single-letter ordinals only
  // put every multi-character roman section one level below its siblings.
  const ordinal = text
    .trim()
    .match(new RegExp(`^(${SECTION_ORDINAL_SOURCE})\\.?\\s+\\S`, 'u'))
  if (ordinal) {
    return Math.min(3, ordinal[1].split('.').length) as 1 | 2 | 3
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
    const unresolvedBoundedTableCaption =
      relationship.status === 'unresolved' &&
      relationship.kind === 'table' &&
      relationship.canonicalNodeId === null &&
      Boolean(relationship.captionNodeId) &&
      relationship.assetIds.length === 0 &&
      relationship.sourceRegionIds.length > 0 &&
      (relationship.sourceLineIds?.length ?? 0) > 0 &&
      relationship.evidence.includes('partial-parent-line-selection') &&
      relationship.evidence.includes('unresolved-bounded-table-text-owned')
    const targetNodeId =
      relationship.status === 'matched'
        ? relationship.canonicalNodeId
        : unresolvedBoundedTableCaption
          ? relationship.captionNodeId
          : null
    if (
      !targetNodeId ||
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
        nodeId: targetNodeId,
        evidence: unresolvedBoundedTableCaption
          ? [
              'unresolved-bounded-table-caption-relationship',
              'source-proved-visual-label',
            ]
          : [
              'matched-canonical-visual-relationship',
              'source-proved-visual-label',
            ],
        sourceBoxes: (unresolvedBoundedTableCaption
          ? relationship.sourceBoxes.slice(0, 1)
          : relationship.sourceBoxes
        ).map((box) => ({ ...box })),
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
  const authorLineTexts: string[] = []
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
    authorLineTexts.push(line.text.trim())
    const lineNames = authorNamesFromLine(line.text)
    const runNames = line.runs.flatMap((run) => authorNamesFromLine(run.text))
    const selectedNames =
      runNames.length > lineNames.length ? runNames : lineNames
    if (selectedNames.length > 0) {
      names.push(...selectedNames)
      peerAuthorFontSize = Math.max(peerAuthorFontSize, line.fontSize)
    }
  }
  // Author lists commonly wrap a person's given name and family name across
  // two centered PDF lines. Parsing each line independently loses that person
  // (for example, "Pradyumna" / "Shukla³"), so also parse the visible author
  // lines as one source-ordered string.
  const joinedLineNames = authorNamesFromLine(
    authorLineTexts.filter(Boolean).join(' '),
  )
  return [...new Set([...names, ...joinedLineNames])]
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

// A section heading and its first body line often land in one region when the
// heading carries no size or weight contrast, so classification alone can only
// choose between calling the whole section a heading or losing the heading. If
// the leading line stands on its own typographic evidence, split it back out so
// the heading keeps its own node and the paragraph starts at the next line.
function splitLeadingOrdinalHeadings(
  blocks: RegionBlock[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
  bodySize: number,
) {
  // Split from the end so inserting fragments cannot invalidate later indexes.
  for (const [blockIndex, block] of [...blocks.entries()].reverse()) {
    if (
      block.type !== 'paragraph' ||
      block.sourceSegments ||
      block.region.lines.length < 2
    ) {
      continue
    }
    const headingLine = block.region.lines[0]
    if (!sourceStyledOrdinalSmallCapsHeading(headingLine)) continue
    const bodyLines = block.region.lines.slice(1)
    // The heading must under-fill the measure that its own body lines fill.
    const bodyWidth = Math.max(...bodyLines.map((line) => line.box.width))
    if (headingLine.box.width >= bodyWidth - 0.01) continue

    const replay = replayPdfRegionLineRanges(
      block.region,
      lineBoundaryDecisions,
    )
    const headingRange = replay?.ranges.get(headingLine.id)
    const bodyStart = replay?.ranges.get(bodyLines[0].id)
    const bodyEnd = replay?.ranges.get(bodyLines.at(-1)!.id)
    if (
      !replay ||
      replay.text !== block.text ||
      !headingRange ||
      !bodyStart ||
      !bodyEnd
    ) {
      continue
    }

    const sourceRegion = block.region
    const fragment = (
      lines: PdfPageRegion['lines'],
      start: number,
      end: number,
      type: RegionBlock['type'],
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
        type,
        region: evidenceRegion,
        text,
        ...(type === 'heading'
          ? {
              headingLevel: headingLevel(
                text,
                Math.max(
                  headingLine.fontSize,
                  ...headingLine.runs.map((run) => run.fontSize),
                ),
                bodySize,
              ),
            }
          : {}),
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
      fragment([headingLine], headingRange.start, headingRange.end, 'heading'),
      fragment(bodyLines, bodyStart.start, bodyEnd.end, 'paragraph'),
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

// Compact publisher front matter can place keywords and the publication
// citation in one geometric region even though the labelled citation begins a
// new source block. Preserve that explicit line boundary instead of emitting a
// single run-on paragraph in reflowable output.
function splitEmbeddedPublicationReference(
  blocks: RegionBlock[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  for (const [blockIndex, block] of [...blocks.entries()].reverse()) {
    if (
      block.type !== 'paragraph' ||
      block.sourceSegments ||
      block.region.page !== 1 ||
      block.region.lines.length < 2
    ) {
      continue
    }
    const boundaryIndex = block.region.lines.findIndex(
      (line, index) =>
        index > 0 && /^ACM\s+Reference\s+Format\s*:/iu.test(line.text.trim()),
    )
    if (boundaryIndex < 1) continue
    const leadingLines = block.region.lines.slice(0, boundaryIndex)
    const referenceLines = block.region.lines.slice(boundaryIndex)
    const replay = replayPdfRegionLineRanges(
      block.region,
      lineBoundaryDecisions,
    )
    const leadingStart = replay?.ranges.get(leadingLines[0].id)
    const leadingEnd = replay?.ranges.get(leadingLines.at(-1)!.id)
    const referenceStart = replay?.ranges.get(referenceLines[0].id)
    const referenceEnd = replay?.ranges.get(referenceLines.at(-1)!.id)
    if (
      !replay ||
      replay.text !== block.text ||
      !leadingStart ||
      !leadingEnd ||
      !referenceStart ||
      !referenceEnd
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
      fragment(leadingLines, leadingStart.start, leadingEnd.end),
      fragment(referenceLines, referenceStart.start, referenceEnd.end),
    )
  }
}

function classifyFrontMatter(
  blocks: RegionBlock[],
  metadataTitle: string | undefined,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  splitEmbeddedPublicationReference(blocks, lineBoundaryDecisions)
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
  const publicationLanguageToken = metadata.language?.trim() ?? ''
  const normalizedTokens = explicitTokens.map((token) => ({
    token,
    tag: canonicalOcrLanguageTag(token),
  }))
  const normalizedPublicationLanguage = publicationLanguageToken
    ? {
        token: publicationLanguageToken,
        tag: canonicalOcrLanguageTag(publicationLanguageToken),
      }
    : null
  const authoritativeTokens = [
    ...(normalizedPublicationLanguage ? [normalizedPublicationLanguage] : []),
    ...normalizedTokens,
  ]
  const invalidTokens = authoritativeTokens.filter(({ tag }) => tag === null)
  const languageCandidates = [
    ...new Set(
      authoritativeTokens.flatMap(({ tag }) =>
        tag && tag !== 'und' ? [tag] : [],
      ),
    ),
  ]
  const candidateBaseLanguages = new Set(
    languageCandidates.map((tag) => new Intl.Locale(tag).language),
  )
  const languageCandidatesAgree = candidateBaseLanguages.size <= 1
  const preferredLanguageCandidate =
    normalizedPublicationLanguage?.tag &&
    normalizedPublicationLanguage.tag !== 'und'
      ? normalizedPublicationLanguage.tag
      : languageCandidates[0]
  const textLanguageInference =
    authoritativeTokens.length === 0
      ? inferPublicationLanguageFromPdfText(pages)
      : null
  const candidateLanguage =
    authoritativeTokens.length > 0 &&
    invalidTokens.length === 0 &&
    languageCandidates.length > 0 &&
    languageCandidatesAgree
      ? (preferredLanguageCandidate ?? 'und')
      : authoritativeTokens.length === 0 && textLanguageInference
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
        `${normalizedPublicationLanguage ? 'publication' : 'ocr'}-language-script-conflict:${candidateLanguage}:${scriptDirection.observedDirection}`,
      ]
    : languageProven
      ? authoritativeTokens.length > 0
        ? [
            ...(normalizedPublicationLanguage
              ? [
                  `publication-language:${normalizedPublicationLanguage.token}->${normalizedPublicationLanguage.tag}`,
                ]
              : []),
            ...new Set(
              normalizedTokens.map(
                ({ token, tag }) => `ocr-language:${token}->${tag}`,
              ),
            ),
          ]
        : [textLanguageInference!.evidence]
      : invalidTokens.length > 0
        ? invalidTokens.map(({ token }) =>
            token === publicationLanguageToken
              ? `invalid-publication-language-candidate:${token}`
              : `invalid-ocr-language-candidate:${token}`,
          )
        : !languageCandidatesAgree
          ? [
              `${normalizedPublicationLanguage ? 'mixed-or-conflicting-publication' : 'mixed-or-conflicting-ocr'}-language-candidates:${languageCandidates.join(',')}`,
            ]
          : hasAutomaticOcr
            ? ['automatic-ocr-language-is-not-publication-authority']
            : ['no-authoritative-publication-language']

  const explicitLanguageConflict =
    authoritativeTokens.length > 0 && !languageProven
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
          ? authoritativeTokens.length > 0
            ? normalizedPublicationLanguage
              ? 'publication-language'
              : 'pdf-ocr-explicit'
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

type CanonicalHyphenDeletionRequest = {
  context: PdfCanonicalHyphenBoundaryDecision['context']
  proof: PdfHyphenBoundaryProof
  left: string
  right: string
  decisions: PdfCanonicalHyphenBoundaryDecision[]
}

function canonicalHyphenDeletionDecision(
  target: RegionBlock,
  continuation: RegionBlock,
  targetSegments: ReturnType<typeof blockSourceSegments>,
  request: CanonicalHyphenDeletionRequest | null,
): PdfCanonicalHyphenBoundaryDecision | null {
  if (!request) return null
  const tailSegment = targetSegments.at(-1)
  const headSegment = blockSourceSegments(continuation)[0]
  const tailEvidenceRegion = tailSegment?.evidenceRegion ?? tailSegment?.region
  const headEvidenceRegion = headSegment?.evidenceRegion ?? headSegment?.region
  const tailLine = tailEvidenceRegion?.lines.at(-1)
  const headLine = headEvidenceRegion?.lines[0]
  const actualLeft = target.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const actualRight = continuation.text
    .trimStart()
    .match(/^([\p{L}\p{N}]+)/u)?.[1]
  const joinedForm = `${request.left}${request.right}`.normalize('NFKC')
  const proof = request.proof
  const lexicalProof = proof.lexicalProof
  const exactSameDocumentProof =
    lexicalProof?.tier === 'exact-same-document' &&
    proof.pinnedJoinedFormValid &&
    proof.sameDocumentJoinedFormValid &&
    proof.evidence.includes('same-document-unhyphenated-word')
  const derivedAffixProof =
    lexicalProof?.tier === 'same-document-derived-affix' &&
    !proof.pinnedJoinedFormValid &&
    !proof.sameDocumentJoinedFormValid &&
    lexicalProof.derivedWord ===
      joinedForm.normalize('NFKC').toLocaleLowerCase('en-US') &&
    lexicalProof.productivePrefix.kind ===
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.kind &&
    lexicalProof.productivePrefix.value ===
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.value &&
    lexicalProof.productivePrefix.affixClass ===
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.affixClass &&
    lexicalProof.productivePrefix.flag ===
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.flag &&
    lexicalProof.productivePrefix.crossProduct ===
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.crossProduct &&
    lexicalProof.productivePrefix.affixSha256 ===
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.affixSha256 &&
    lexicalProof.pinnedBaseWordValid &&
    lexicalProof.sameDocumentBaseWordValid &&
    PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE.every((evidence) =>
      proof.evidence.includes(evidence),
    )
  if (
    !tailSegment ||
    !headSegment ||
    !tailLine ||
    !headLine ||
    !actualLeft ||
    !actualRight ||
    actualLeft.normalize('NFKC') !== request.left.normalize('NFKC') ||
    actualRight.normalize('NFKC') !== request.right.normalize('NFKC') ||
    !/[-‐‑]$/u.test(target.text) ||
    !/[-‐‑]$/u.test(tailSegment.text) ||
    proof.verdict !== 'remove' ||
    !proof.sourceBoundaryProven ||
    !proof.joinedFormValid ||
    !proof.splitPointValid ||
    proof.hardHyphenFormValid ||
    proof.model === null ||
    !lexicalProof ||
    (!exactSameDocumentProof && !derivedAffixProof) ||
    proof.joinedForm !== joinedForm ||
    proof.evidence.includes('hard-hyphen-form-valid:same-document')
  ) {
    return null
  }
  const pinnedSplit = {
    left: request.left,
    right: request.right,
    index: request.left.normalize('NFKC').length,
  }
  const commonProof = {
    sourceBoundaryProven: true as const,
    pinnedSplit,
    splitPointValid: true as const,
    hardHyphenForm: proof.hardHyphenForm,
    hardHyphenCounterproof: null,
    model: { ...proof.model },
    evidence: [...proof.evidence],
  }
  const canonicalProof =
    lexicalProof.tier === 'exact-same-document'
      ? {
          ...commonProof,
          tier: 'exact-same-document' as const,
          pinnedWord: proof.joinedForm,
          pinnedJoinedFormValid: true as const,
          exactSameDocumentJoinedForm: proof.joinedForm,
          sameDocumentJoinedFormValid: true as const,
        }
      : {
          ...commonProof,
          tier: 'same-document-derived-affix' as const,
          derivedWord: proof.joinedForm,
          productivePrefix: { ...lexicalProof.productivePrefix },
          baseWord: lexicalProof.baseWord,
          pinnedBaseWordValid: true as const,
          exactSameDocumentBaseWord: lexicalProof.exactSameDocumentBaseWord,
          sameDocumentBaseWordValid: true as const,
        }
  return {
    id: `canonical-hyphen-boundary:${request.context}:${tailSegment.region.id}:${tailLine.id}->${headSegment.region.id}:${headLine.id}`,
    context: request.context,
    outcome: 'removed-discretionary-hyphen',
    fromRegionId: tailSegment.region.id,
    fromLineId: tailLine.id,
    toRegionId: headSegment.region.id,
    toLineId: headLine.id,
    geometry: {
      from: { ...tailLine.box },
      to: { ...headLine.box },
    },
    proof: canonicalProof,
  }
}

function dominantSemanticFlowLineMetrics(line: PdfPageRegion['lines'][number]) {
  const runs = line.runs.filter((run) => run.text.trim())
  if (runs.length === 0) return null
  const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
  const dominantRuns = runs.filter(
    (run) => run.fontSize >= maximumFontSize * 0.9,
  )
  return {
    fontSize: maximumFontSize,
    baseline:
      dominantRuns.reduce(
        (total, run) =>
          total + (run.y + run.height) * Math.max(run.text.trim().length, 1),
        0,
      ) /
      dominantRuns.reduce(
        (total, run) => total + Math.max(run.text.trim().length, 1),
        0,
      ),
    height: Math.max(...dominantRuns.map((run) => run.height)),
  }
}

type SourceSemanticFlowBoundaryCandidate = Omit<
  PdfSourceSemanticFlowBoundaryDecision,
  'id' | 'outcome' | 'topology'
> & {
  topology:
    | PdfSourceSemanticFlowBoundaryDecision['topology']
    | 'cross-gutter-to-span'
    | 'same-column-citation-year'
    | 'cross-column-citation-year'
    | 'aligned-enumeration'
    | 'bibliography-same-baseline'
    | 'bibliography-hanging-indent'
  outcome:
    PdfSourceSemanticFlowBoundaryDecision['outcome'] | 'space' | 'unresolved'
}

function sourceSemanticFlowBoundaryCandidate(
  target: RegionBlock,
  continuation: RegionBlock,
  outcome: SourceSemanticFlowBoundaryCandidate['outcome'],
  topology: SourceSemanticFlowBoundaryCandidate['topology'],
): SourceSemanticFlowBoundaryCandidate | null {
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
    !targetTailLine ||
    !continuationHeadLine
  ) {
    return null
  }
  const targetSourceLines = targetTailSegment.region.lines.filter(
    (line) => line.id === targetTailLine.id,
  )
  const continuationSourceLines = continuationHeadSegment.region.lines.filter(
    (line) => line.id === continuationHeadLine.id,
  )
  if (targetSourceLines.length !== 1 || continuationSourceLines.length !== 1) {
    return null
  }
  const fromLine = targetSourceLines[0]
  const toLine = continuationSourceLines[0]
  const fromVisibleRuns = fromLine.runs
    .map((run, runIndex) => ({ run, runIndex }))
    .filter(({ run }) => run.text.trim())
  const toVisibleRuns = toLine.runs
    .map((run, runIndex) => ({ run, runIndex }))
    .filter(({ run }) => run.text.trim())
  if (
    fromVisibleRuns.length === 0 ||
    toVisibleRuns.length === 0 ||
    fromVisibleRuns.some(({ run }) => run.sourceSequenceIndex === undefined) ||
    toVisibleRuns.some(({ run }) => run.sourceSequenceIndex === undefined)
  ) {
    return null
  }
  const maximumFromSequence = Math.max(
    ...fromVisibleRuns.map(({ run }) => run.sourceSequenceIndex!),
  )
  const minimumToSequence = Math.min(
    ...toVisibleRuns.map(({ run }) => run.sourceSequenceIndex!),
  )
  const fromCandidates = fromVisibleRuns.filter(
    ({ run }) => run.sourceSequenceIndex === maximumFromSequence,
  )
  const toCandidates = toVisibleRuns.filter(
    ({ run }) => run.sourceSequenceIndex === minimumToSequence,
  )
  if (fromCandidates.length !== 1 || toCandidates.length !== 1) return null
  const exactFragmentLineage = (
    line: PdfPageRegion['lines'][number],
    visibleRuns: Array<{ run: PdfSourceRun; runIndex: number }>,
  ) => {
    const lineage = line.sourceFragmentLineage
    const sourceSequenceIndexes = visibleRuns.map(
      ({ run }) => run.sourceSequenceIndex!,
    )
    return Boolean(
      lineage &&
      new Set(lineage.sourceSequenceIndexes).size ===
        lineage.sourceSequenceIndexes.length &&
      lineage.sourceSequenceIndexes.length === sourceSequenceIndexes.length &&
      lineage.sourceSequenceIndexes.every(
        (sequence, index) => sequence === sourceSequenceIndexes[index],
      ),
    )
  }
  if (
    !exactFragmentLineage(fromLine, fromVisibleRuns) ||
    !exactFragmentLineage(toLine, toVisibleRuns)
  ) {
    return null
  }
  const from = fromCandidates[0]
  const to = toCandidates[0]
  const exactSourceAdjacency =
    minimumToSequence === maximumFromSequence + 1 ||
    (to.run.sourceWhitespaceBefore === 'pdf-text-item' &&
      to.run.sourceWhitespacePredecessorIndex === maximumFromSequence)
  const fromFragmentId = pdfSourceFragmentId(fromLine)
  const toFragmentId = pdfSourceFragmentId(toLine)
  const fromMetrics = dominantSemanticFlowLineMetrics(fromLine)
  const toMetrics = dominantSemanticFlowLineMetrics(toLine)
  if (
    !exactSourceAdjacency ||
    !fromFragmentId ||
    !toFragmentId ||
    !fromMetrics ||
    !toMetrics ||
    from.run.page !== to.run.page ||
    from.run.rotation !== to.run.rotation ||
    from.run.method !== to.run.method ||
    (from.run.method !== 'pdf-text' && from.run.method !== 'ocr')
  ) {
    return null
  }
  const fontRatio =
    Math.max(fromMetrics.fontSize, toMetrics.fontSize) /
    Math.max(1, Math.min(fromMetrics.fontSize, toMetrics.fontSize))
  const baselineGap = Math.abs(fromMetrics.baseline - toMetrics.baseline)
  if (
    fontRatio > 1.5 ||
    baselineGap >
      Math.max(0.06, Math.max(fromMetrics.height, toMetrics.height) * 4)
  ) {
    return null
  }
  const exactStackedPunctuationTransition = Boolean(
    fromLine.sourceFragmentLineage?.fragment === 'inline-stacked-formula' &&
    toLine.sourceFragmentLineage?.fragment === 'inline-stacked-after' &&
    fromLine.sourceFragmentLineage.sourceLineId ===
      toLine.sourceFragmentLineage.sourceLineId &&
    /^[,.;:!?%)}\]]/u.test(continuation.text.trimStart()),
  )
  if (
    (outcome === 'no-space') !== exactStackedPunctuationTransition ||
    (outcome === 'space' && exactStackedPunctuationTransition)
  ) {
    return null
  }
  const evidence = canonicalPdfSourceSemanticFlowEvidence(
    exactStackedPunctuationTransition
      ? PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE
      : outcome === 'space' &&
          to.run.sourceWhitespaceBefore === 'pdf-text-item' &&
          to.run.sourceWhitespacePredecessorIndex === maximumFromSequence
        ? PDF_SOURCE_SEMANTIC_FLOW_SPACE_WHITESPACE_EVIDENCE
        : PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE,
  )
  const decision: SourceSemanticFlowBoundaryCandidate = {
    page: from.run.page,
    rotation: from.run.rotation,
    method: from.run.method,
    topology,
    outcome,
    from: {
      regionId: targetTailSegment.region.id,
      lineId: fromLine.id,
      runIndex: from.runIndex,
      sourceSequenceIndex: maximumFromSequence,
      sourceRunSha256: pdfSourceSemanticFlowRunSha256(from.run),
      sourceFragmentId: fromFragmentId,
    },
    to: {
      regionId: continuationHeadSegment.region.id,
      lineId: toLine.id,
      runIndex: to.runIndex,
      sourceSequenceIndex: minimumToSequence,
      sourceRunSha256: pdfSourceSemanticFlowRunSha256(to.run),
      sourceFragmentId: toFragmentId,
    },
    evidence,
  }
  return decision
}

function sourceSemanticFlowBoundaryDecision(
  target: RegionBlock,
  continuation: RegionBlock,
  outcome: PdfSourceSemanticFlowBoundaryDecision['outcome'],
  topology: PdfSourceSemanticFlowBoundaryDecision['topology'],
): PdfSourceSemanticFlowBoundaryDecision | null {
  const decision = sourceSemanticFlowBoundaryCandidate(
    target,
    continuation,
    outcome,
    topology,
  )
  if (!decision) return null
  const canonicalDecision: Omit<PdfSourceSemanticFlowBoundaryDecision, 'id'> = {
    ...decision,
    topology,
    outcome,
  }
  return {
    id: pdfSourceSemanticFlowBoundaryDecisionId(canonicalDecision),
    ...canonicalDecision,
  }
}

function appendBlockContinuation(
  target: RegionBlock,
  continuation: RegionBlock,
  requestedSeparator = target.text ? ' ' : '',
  hyphenDeletion: CanonicalHyphenDeletionRequest | null = null,
  sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[] = [],
  requestedTopology:
    SourceSemanticFlowBoundaryCandidate['topology'] | null = null,
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
  const deletionDecision = canonicalHyphenDeletionDecision(
    target,
    continuation,
    targetSegments,
    hyphenDeletion,
  )
  const deletionDecisionIsUnique =
    deletionDecision !== null &&
    hyphenDeletion !== null &&
    !hyphenDeletion.decisions.some(
      (decision) =>
        decision.id === deletionDecision.id ||
        (decision.fromRegionId === deletionDecision.fromRegionId &&
          decision.fromLineId === deletionDecision.fromLineId &&
          decision.toRegionId === deletionDecision.toRegionId &&
          decision.toLineId === deletionDecision.toLineId),
    )
  const semanticHyphenVerdict = hyphenDeletion
    ? sourceSemanticFlowHyphenVerdict(hyphenDeletion.proof)
    : 'unresolved'
  const semanticDeletionDecision =
    deletionDecision === null &&
    hyphenDeletion?.proof.sourceBoundaryProven === true &&
    semanticHyphenVerdict === 'remove'
      ? sourceSemanticFlowBoundaryDecision(
          target,
          continuation,
          'discretionary-hyphen-delete',
          'lexical-hyphen',
        )
      : null
  const semanticDeletionDecisionIsUnique =
    semanticDeletionDecision !== null &&
    !sourceSemanticFlowBoundaryDecisions.some(
      (decision) =>
        decision.id === semanticDeletionDecision.id ||
        (decision.from.regionId === semanticDeletionDecision.from.regionId &&
          decision.from.lineId === semanticDeletionDecision.from.lineId &&
          decision.to.regionId === semanticDeletionDecision.to.regionId &&
          decision.to.lineId === semanticDeletionDecision.to.lineId),
    )
  const deletionApplied =
    (deletionDecision !== null && deletionDecisionIsUnique) ||
    (semanticDeletionDecision !== null &&
      semanticDeletionDecisionIsUnique &&
      semanticHyphenVerdict === 'remove')
  if (deletionApplied) {
    targetText = targetText.slice(0, -1)
    const tail = targetSegments.at(-1)!
    tail.text = tail.text.slice(0, -1)
    if (deletionDecision) {
      hyphenDeletion!.decisions.push(deletionDecision)
    }
  }
  const semanticFlowOutcome: SourceSemanticFlowBoundaryCandidate['outcome'] =
    deletionApplied
      ? 'discretionary-hyphen-delete'
      : separator === ' '
        ? 'space'
        : /[-‐‑]$/u.test(targetText.trimEnd())
          ? semanticHyphenVerdict === 'preserve'
            ? 'hard-hyphen-retain'
            : 'unresolved'
          : 'no-space'
  const targetLineage = targetTailLine?.sourceFragmentLineage
  const continuationLineage = continuationHeadLine?.sourceFragmentLineage
  const inferredTopology:
    SourceSemanticFlowBoundaryCandidate['topology'] | null =
    semanticFlowOutcome === 'discretionary-hyphen-delete' ||
    semanticFlowOutcome === 'hard-hyphen-retain'
      ? 'lexical-hyphen'
      : targetLineage &&
          continuationLineage &&
          targetLineage.sourceLineId === continuationLineage.sourceLineId &&
          (targetLineage.fragment.startsWith('inline-stacked-') ||
            continuationLineage.fragment.startsWith('inline-stacked-'))
        ? 'inline-stacked-fragment'
        : target.region.column === 'right' &&
            continuation.region.column === 'span' &&
            targetLineage?.fragment === 'cross-gutter-right'
          ? 'cross-gutter-to-span'
          : requestedTopology
  const semanticFlowDecision =
    semanticDeletionDecision ??
    (inferredTopology &&
    semanticFlowOutcome !== 'space' &&
    semanticFlowOutcome !== 'unresolved' &&
    (inferredTopology === 'inline-stacked-fragment' ||
      inferredTopology === 'lexical-hyphen')
      ? sourceSemanticFlowBoundaryDecision(
          target,
          continuation,
          semanticFlowOutcome,
          inferredTopology,
        )
      : null)
  if (
    semanticFlowDecision &&
    !sourceSemanticFlowBoundaryDecisions.some(
      (decision) =>
        decision.id === semanticFlowDecision.id ||
        (decision.from.regionId === semanticFlowDecision.from.regionId &&
          decision.from.lineId === semanticFlowDecision.from.lineId &&
          decision.to.regionId === semanticFlowDecision.to.regionId &&
          decision.to.lineId === semanticFlowDecision.to.lineId),
    )
  ) {
    sourceSemanticFlowBoundaryDecisions.push(semanticFlowDecision)
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

type InlineStackedParagraphFragment = {
  baseId: string
  part: 'before' | 'formula' | 'after'
  line: PdfPageRegion['lines'][number]
}

function inlineStackedParagraphFragments(block: RegionBlock) {
  return block.region.lines.flatMap<InlineStackedParagraphFragment>((line) => {
    const match = line.id?.match(
      /^(.*-inline-stacked-\d+)-(before|formula|after)$/u,
    )
    return match
      ? [
          {
            baseId: match[1],
            part: match[2] as InlineStackedParagraphFragment['part'],
            line,
          },
        ]
      : []
  })
}

function exactInlineStackedParagraphFragment(
  block: RegionBlock,
): InlineStackedParagraphFragment | null {
  const fragments = inlineStackedParagraphFragments(block)
  return fragments.length === 1 ? fragments[0] : null
}

function sourceProvesInlineStackedBoundary(
  left: InlineStackedParagraphFragment,
  right: InlineStackedParagraphFragment,
) {
  const leftRuns = left.line.runs.filter((run) => run.text.trim())
  const rightRuns = right.line.runs.filter((run) => run.text.trim())
  if (
    leftRuns.length === 0 ||
    rightRuns.length === 0 ||
    leftRuns.some((run) => run.sourceSequenceIndex === undefined) ||
    rightRuns.some((run) => run.sourceSequenceIndex === undefined)
  ) {
    return false
  }
  const leftMaximumSequence = Math.max(
    ...leftRuns.map((run) => run.sourceSequenceIndex!),
  )
  const rightMinimumSequence = Math.min(
    ...rightRuns.map((run) => run.sourceSequenceIndex!),
  )
  const leftBoundaryRuns = leftRuns.filter(
    (run) => run.sourceSequenceIndex === leftMaximumSequence,
  )
  const rightBoundaryRuns = rightRuns.filter(
    (run) => run.sourceSequenceIndex === rightMinimumSequence,
  )
  return (
    leftBoundaryRuns.length === 1 &&
    rightBoundaryRuns.length === 1 &&
    rightBoundaryRuns[0].sourceWhitespaceBefore === 'pdf-text-item' &&
    rightBoundaryRuns[0].sourceWhitespacePredecessorIndex ===
      leftBoundaryRuns[0].sourceSequenceIndex
  )
}

function sourceProvesInlineStackedBlockScope(
  block: RegionBlock,
  fragment: InlineStackedParagraphFragment,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const nonblankLines = block.region.lines.filter((line) => line.text.trim())
  if (fragment.part !== 'after') {
    return nonblankLines.length === 1 && nonblankLines[0] === fragment.line
  }
  if (nonblankLines[0] !== fragment.line) return false
  for (let index = 1; index < nonblankLines.length; index += 1) {
    const previous = nonblankLines[index - 1]
    const current = nonblankLines[index]
    const decisions = lineBoundaryDecisions.filter(
      (decision) =>
        decision.regionId === block.region.id &&
        decision.fromLineId === previous.id &&
        decision.toLineId === current.id,
    )
    if (
      decisions.length !== 1 ||
      ![
        'space',
        'no-space',
        'preserved-lexical-hyphen',
        'removed-discretionary-hyphen',
      ].includes(decisions[0].outcome)
    ) {
      return false
    }
  }
  return true
}

function visualRelationshipTouchesInlineFormula(
  relationship: PdfVisualRelationship,
  formulaRegionId: string,
  formulaLineId: string,
) {
  return (
    relationship.sourceRegionIds.includes(formulaRegionId) ||
    relationship.sourceLineIds?.includes(formulaLineId) === true ||
    relationship.candidates.some(
      (candidate) =>
        candidate.sourceRegionIds.includes(formulaRegionId) ||
        candidate.sourceLineIds?.includes(formulaLineId) === true,
    )
  )
}

function provesUnresolvedInlineFormulaRelationship(
  relationship: PdfVisualRelationship,
  beforeRegionId: string,
  formulaBlock: RegionBlock,
  formulaLineId: string,
  afterRegionId: string,
) {
  if (
    relationship.kind !== 'equation' ||
    relationship.status !== 'unresolved' ||
    !relationship.evidence.includes('source-text-transcript-unresolved') ||
    relationship.captionRegionId !== formulaBlock.region.id
  ) {
    return false
  }
  const directSource =
    relationship.sourceRegionIds.includes(formulaBlock.region.id) &&
    !relationship.sourceRegionIds.includes(beforeRegionId) &&
    !relationship.sourceRegionIds.includes(afterRegionId) &&
    relationship.sourceLineIds?.filter((lineId) => lineId === formulaLineId)
      .length === 1
  if (directSource) return true

  if (
    relationship.sourceRegionIds.length !== 0 ||
    (relationship.sourceLineIds?.length ?? 0) !== 0 ||
    relationship.sourceObjectIds.length !== 0 ||
    relationship.assetIds.length !== 0 ||
    relationship.canonicalNodeId !== null ||
    !relationship.evidence.includes('incomplete-equation-source-scope') ||
    !relationship.evidence.includes('source-rendition-unavailable') ||
    relationship.candidates.length !== 1 ||
    relationship.sourceBoxes.length !== 1 ||
    !sameSourceBox(relationship.sourceBoxes[0], formulaBlock.region.box)
  ) {
    return false
  }
  const candidate = relationship.candidates[0]
  return (
    candidate.sourceRegionIds.length === 1 &&
    candidate.sourceRegionIds[0] === formulaBlock.region.id &&
    (candidate.sourceLineIds === undefined ||
      (candidate.sourceLineIds.length === 1 &&
        candidate.sourceLineIds[0] === formulaLineId)) &&
    candidate.sourceObjectIds.length === 1 &&
    candidate.assetIds.length === 0 &&
    candidate.sourceBoxes.length === 1 &&
    sameSourceBox(candidate.sourceBoxes[0], formulaBlock.region.box) &&
    candidate.evidence.includes('source-text-transcript-unresolved') &&
    candidate.evidence.includes('incomplete-equation-source-scope') &&
    candidate.evidence.includes('source-rendition-unavailable')
  )
}

function coalesceProvedInlineStackedParagraphs(
  blocks: RegionBlock[],
  relationships: readonly PdfVisualRelationship[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
  sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[],
) {
  const fragments = blocks.map(exactInlineStackedParagraphFragment)
  const occurrencesByBaseId = new Map<
    string,
    Array<{ index: number; fragment: InlineStackedParagraphFragment }>
  >()
  for (const [index, block] of blocks.entries()) {
    for (const fragment of inlineStackedParagraphFragments(block)) {
      const occurrences = occurrencesByBaseId.get(fragment.baseId) ?? []
      occurrences.push({ index, fragment })
      occurrencesByBaseId.set(fragment.baseId, occurrences)
    }
  }

  for (let index = 0; index <= blocks.length - 3;) {
    const candidateBlocks = blocks.slice(index, index + 3)
    const candidateFragments = candidateBlocks.map(
      exactInlineStackedParagraphFragment,
    )
    const before = candidateFragments[0]
    const formula = candidateFragments[1]
    const after = candidateFragments[2]
    if (
      candidateBlocks.some(
        (block) => block.type !== 'paragraph' || block.list !== undefined,
      ) ||
      !before ||
      !formula ||
      !after ||
      before.part !== 'before' ||
      formula.part !== 'formula' ||
      after.part !== 'after' ||
      before.baseId !== formula.baseId ||
      formula.baseId !== after.baseId ||
      (occurrencesByBaseId.get(formula.baseId)?.length ?? 0) !== 3 ||
      new Set(candidateBlocks.map((block) => block.region.id)).size !== 3 ||
      new Set(candidateBlocks.map((block) => block.region.page)).size !== 1 ||
      new Set(
        candidateBlocks.map(
          (block) =>
            block.region.kind === 'footnote' || block.region.kind === 'endnote',
        ),
      ).size !== 1 ||
      !/\p{L}{2,}/u.test(candidateBlocks[0].text) ||
      !/^[,.;:!?)}\]]/u.test(candidateBlocks[2].text.trimStart()) ||
      !/\p{L}{2,}/u.test(candidateBlocks[2].text) ||
      !sourceProvesInlineStackedBlockScope(
        candidateBlocks[0],
        before,
        lineBoundaryDecisions,
      ) ||
      !sourceProvesInlineStackedBlockScope(
        candidateBlocks[1],
        formula,
        lineBoundaryDecisions,
      ) ||
      !sourceProvesInlineStackedBlockScope(
        candidateBlocks[2],
        after,
        lineBoundaryDecisions,
      ) ||
      !sourceProvesInlineStackedBoundary(before, formula) ||
      !sourceProvesInlineStackedBoundary(formula, after)
    ) {
      index += 1
      continue
    }
    const participatingRelationships = relationships.filter(
      (relationship) =>
        relationship.kind === 'equation' &&
        visualRelationshipTouchesInlineFormula(
          relationship,
          candidateBlocks[1].region.id,
          formula.line.id,
        ),
    )
    const relationshipCandidates = participatingRelationships.filter(
      (relationship) =>
        provesUnresolvedInlineFormulaRelationship(
          relationship,
          candidateBlocks[0].region.id,
          candidateBlocks[1],
          formula.line.id,
          candidateBlocks[2].region.id,
        ),
    )
    if (
      participatingRelationships.length !== 1 ||
      relationshipCandidates.length !== 1
    ) {
      index += 1
      continue
    }

    appendBlockContinuation(
      candidateBlocks[0],
      candidateBlocks[1],
      ' ',
      null,
      sourceSemanticFlowBoundaryDecisions,
    )
    appendBlockContinuation(
      candidateBlocks[0],
      candidateBlocks[2],
      '',
      null,
      sourceSemanticFlowBoundaryDecisions,
    )
    blocks.splice(index + 1, 2)
    fragments.splice(index + 1, 2)
    index += 1
  }
}

function bibliographyContinuationJoin(
  target: RegionBlock,
  continuation: RegionBlock,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
) {
  const left = target.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const right = continuation.text.trimStart().match(/^([\p{L}\p{N}]+)/u)?.[1]
  if (left && right) {
    const proof = resolvePdfHyphenBoundary({
      left,
      right,
      language,
      sourceProven: true,
      hardHyphenLexicon,
      unhyphenatedLexicon,
    })
    return {
      separator: '',
      hyphenBoundary: { proof, left, right },
    }
  }
  if (/^[,;:)\]]/u.test(continuation.text.trimStart())) {
    return { separator: '', hyphenBoundary: null }
  }
  const previousYearPrefix = target.text.match(/(?:18|19|20)\d$/u)?.[0]
  const finalYearDigit = continuation.text.match(/^(\d)(?=[.,;:)])/u)?.[1]
  if (
    previousYearPrefix &&
    finalYearDigit &&
    Number(`${previousYearPrefix}${finalYearDigit}`) <= 2099
  ) {
    return { separator: '', hyphenBoundary: null }
  }
  if (/[-–—]$/u.test(target.text) && /^\d/u.test(continuation.text)) {
    return { separator: '', hyphenBoundary: null }
  }
  return {
    separator: target.text ? ' ' : '',
    hyphenBoundary: null,
  }
}

function appendBibliographyContinuation(
  target: RegionBlock,
  continuation: RegionBlock,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
  canonicalHyphenBoundaryDecisions: PdfCanonicalHyphenBoundaryDecision[],
  sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[],
  topology: 'bibliography-same-baseline' | 'bibliography-hanging-indent',
) {
  const join = bibliographyContinuationJoin(
    target,
    continuation,
    hardHyphenLexicon,
    unhyphenatedLexicon,
    language,
  )
  appendBlockContinuation(
    target,
    continuation,
    join.separator,
    join.hyphenBoundary
      ? {
          context: 'bibliography-continuation',
          ...join.hyphenBoundary,
          decisions: canonicalHyphenBoundaryDecisions,
        }
      : null,
    sourceSemanticFlowBoundaryDecisions,
    topology,
  )
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
      detachedNumericProseContinuation(previousText, continuationText) ||
      detachedDashProseContinuation(previousText, continuationText)),
  )
}

function detachedNumericProseContinuation(
  previousText: string,
  continuationText: string,
) {
  return (
    /\b(?:a|an|the|of|for|from|with|without|among|between|over|under|by|than|approximately|about|around|nearly|roughly|exactly|includes?|including|contains?|containing|comprises?|comprising)\s*$/iu.test(
      previousText.trimEnd(),
    ) &&
    /^\d+(?:[,.]\d+)*(?:\s*[%×x+-]\s*\d+(?:[,.]\d+)*)?\s+\p{L}/u.test(
      continuationText.trimStart(),
    )
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

export function sourceProvenRunFragmentToSpanBoundary(
  targetRegion: PdfPageRegion,
  continuationRegion: PdfPageRegion,
) {
  const targetLine = targetRegion.lines
    .filter((line) => line.text.trim())
    .at(-1)
  const continuationLine = continuationRegion.lines.find((line) =>
    line.text.trim(),
  )
  if (
    !targetLine ||
    !continuationLine ||
    targetRegion.page !== continuationRegion.page ||
    targetRegion.column !== 'right' ||
    continuationRegion.column !== 'span' ||
    targetLine.sourceFragmentLineage?.fragment !== 'cross-gutter-right' ||
    continuationLine.sourceFragmentLineage === undefined
  ) {
    return false
  }
  const verticalGap =
    continuationLine.box.y - (targetLine.box.y + targetLine.box.height)
  if (
    verticalGap < -0.006 ||
    verticalGap >
      Math.max(
        0.035,
        Math.max(targetLine.box.height, continuationLine.box.height) * 2.5,
      )
  ) {
    return false
  }
  const target: RegionBlock = {
    type: 'paragraph',
    region: targetRegion,
    text: targetRegion.text,
    confidence: targetRegion.confidence,
  }
  const continuation: RegionBlock = {
    type: 'paragraph',
    region: continuationRegion,
    text: continuationRegion.text,
    confidence: continuationRegion.confidence,
  }
  return (
    sourceSemanticFlowBoundaryCandidate(
      target,
      continuation,
      'space',
      'cross-gutter-to-span',
    ) !== null
  )
}

function sourceProvenSamePageParagraphBoundary(
  target: RegionBlock,
  continuation: RegionBlock,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetEvidenceRegion =
    targetTailSegment?.evidenceRegion ?? targetTailSegment?.region
  const continuationEvidenceRegion =
    continuationHeadSegment?.evidenceRegion ?? continuationHeadSegment?.region
  const targetTailLine = targetEvidenceRegion?.lines.at(-1)
  const continuationHeadLine = continuationEvidenceRegion?.lines[0]
  const runFragmentToSpanBoundary = sourceProvenRunFragmentToSpanBoundary(
    targetTailSegment?.region ?? target.region,
    continuationHeadSegment?.region ?? continuation.region,
  )
  const targetLineage = targetTailLine?.sourceFragmentLineage
  const continuationLineage = continuationHeadLine?.sourceFragmentLineage
  const explicitFragmentFamilyBoundary = Boolean(
    targetLineage &&
    continuationLineage &&
    targetLineage.sourceLineId === continuationLineage.sourceLineId &&
    new Set([
      'inline-stacked-before->inline-stacked-formula',
      'inline-stacked-before->inline-stacked-after',
      'inline-stacked-formula->inline-stacked-after',
      'cross-gutter-left->cross-gutter-right',
    ]).has(`${targetLineage.fragment}->${continuationLineage.fragment}`),
  )
  const targetToken = target.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const continuationToken = continuation.text
    .trimStart()
    .match(/^([\p{L}\p{N}]+)/u)?.[1]
  const sourceAttestedHyphenBoundary = Boolean(
    targetToken &&
    continuationToken &&
    sourceSemanticFlowHyphenVerdict(
      resolvePdfHyphenBoundary({
        left: targetToken,
        right: continuationToken,
        language,
        sourceProven: true,
        hardHyphenLexicon,
        unhyphenatedLexicon,
      }),
    ) !== 'unresolved',
  )
  const sourceAttestedCitationYearBoundary = detachedCitationYearContinuation(
    target.text,
    continuation.text,
  )
  const semanticFlowBoundary = sourceSemanticFlowBoundaryCandidate(
    target,
    continuation,
    'space',
    explicitFragmentFamilyBoundary
      ? 'inline-stacked-fragment'
      : runFragmentToSpanBoundary
        ? 'cross-gutter-to-span'
        : sourceAttestedCitationYearBoundary
          ? 'same-column-citation-year'
          : 'lexical-hyphen',
  )
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.id === continuationHeadSegment.region.id ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    (targetTailSegment.region.column !==
      continuationHeadSegment.region.column &&
      !runFragmentToSpanBoundary) ||
    (!runFragmentToSpanBoundary &&
      !explicitFragmentFamilyBoundary &&
      !sourceAttestedHyphenBoundary &&
      !sourceAttestedCitationYearBoundary) ||
    hasOmittedSourceBetweenBlocks(target, continuation) ||
    semanticFlowBoundary === null
  ) {
    return false
  }
  const targetMetrics = dominantSemanticFlowLineMetrics(targetTailLine)
  const continuationMetrics =
    dominantSemanticFlowLineMetrics(continuationHeadLine)
  if (!targetMetrics || !continuationMetrics) return false
  const verticalGap =
    continuationHeadLine.box.y -
    (targetTailLine.box.y + targetTailLine.box.height)
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  if (fontRatio > 1.12) return false
  if (runFragmentToSpanBoundary) return true
  const dominantBaselineAdvance =
    continuationMetrics.baseline - targetMetrics.baseline
  const sourceProvenDominantBaselineAdvance =
    dominantBaselineAdvance >=
      Math.max(
        0.004,
        Math.min(targetMetrics.height, continuationMetrics.height) * 0.25,
      ) &&
    dominantBaselineAdvance <=
      Math.max(
        0.035,
        Math.max(targetMetrics.height, continuationMetrics.height) * 2.5,
      )
  return (
    Math.abs(continuationHeadLine.box.x - targetTailLine.box.x) <= 0.06 &&
    ((verticalGap >= -0.006 &&
      verticalGap <=
        Math.max(
          0.025,
          Math.max(targetTailLine.box.height, continuationHeadLine.box.height) *
            2.5,
        )) ||
      sourceProvenDominantBaselineAdvance)
  )
}

function sourceProvenSamePageColumnBoundary(
  target: RegionBlock,
  continuation: RegionBlock,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetTailLine = targetTailSegment?.region.lines.at(-1)
  const continuationHeadLine = continuationHeadSegment?.region.lines[0]
  const hyphenatedTokenContinuation =
    /[\p{L}\p{N}][-‐‑]$/u.test(target.text.trimEnd()) &&
    /^\p{Ll}/u.test(continuation.text.trimStart())
  const citationYearContinuation = detachedCitationYearContinuation(
    target.text,
    continuation.text,
  )
  const targetToken = target.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const continuationToken = continuation.text
    .trimStart()
    .match(/^([\p{L}\p{N}]+)/u)?.[1]
  const fontRatio =
    targetTailLine && continuationHeadLine
      ? Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
        Math.max(
          1,
          Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
        )
      : Number.POSITIVE_INFINITY
  const deepHyphenContinuationIsSourceAttested = Boolean(
    targetToken &&
    continuationToken &&
    fontRatio <= 1.12 &&
    resolvePdfHyphenBoundary({
      left: targetToken,
      right: continuationToken,
      language,
      sourceProven: true,
      hardHyphenLexicon,
      unhyphenatedLexicon,
    }).verdict !== 'unresolved',
  )
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    targetTailSegment.region.column !== 'left' ||
    continuationHeadSegment.region.column !== 'right' ||
    targetTailLine.box.y + targetTailLine.box.height < 0.75 ||
    targetTailLine.box.x >= continuationHeadLine.box.x ||
    targetTailLine.box.x + targetTailLine.box.width >
      continuationHeadLine.box.x + 0.01 ||
    (!hyphenatedTokenContinuation && !citationYearContinuation) ||
    (citationYearContinuation && continuationHeadLine.box.y > 0.35) ||
    (hyphenatedTokenContinuation &&
      continuationHeadLine.box.y > 0.35 &&
      !deepHyphenContinuationIsSourceAttested)
  ) {
    return false
  }
  return true
}

function floatInterruptedHyphenJoin(
  target: RegionBlock,
  continuation: RegionBlock,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
) {
  const left = target.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const right = continuation.text.trimStart().match(/^([\p{L}\p{N}]+)/u)?.[1]
  if (!left || !right) {
    return {
      separator: target.text ? ' ' : '',
      hyphenBoundary: null,
    }
  }
  const proof = resolvePdfHyphenBoundary({
    left,
    right,
    language,
    sourceProven: true,
    hardHyphenLexicon,
    unhyphenatedLexicon,
  })
  return {
    // A printed terminal hyphen and its lowercase page continuation are one
    // source token. Preserve the printed hyphen when lexical evidence is
    // inconclusive, but never invent whitespace inside that token.
    separator: '',
    hyphenBoundary: { proof, left, right },
  }
}

export async function mergeProseContinuations(
  blocks: RegionBlock[],
  {
    ownedFloatCaptionRegionIds = new Set<string>(),
    hardHyphenLexicon = new Set<string>(),
    unhyphenatedLexicon = new Set<string>(),
    language = null,
    diagnostics = [],
    canonicalFloatScopes = [],
    canonicalHyphenBoundaryDecisions = [],
    sourceSemanticFlowBoundaryDecisions = [],
  }: {
    ownedFloatCaptionRegionIds?: ReadonlySet<string>
    hardHyphenLexicon?: ReadonlySet<string>
    unhyphenatedLexicon?: ReadonlySet<string>
    language?: string | null
    diagnostics?: ReconstructionDiagnostic[]
    canonicalFloatScopes?: CanonicalFloatScopeEvidence[]
    canonicalHyphenBoundaryDecisions?: PdfCanonicalHyphenBoundaryDecision[]
    sourceSemanticFlowBoundaryDecisions?: PdfSourceSemanticFlowBoundaryDecision[]
  } = {},
) {
  for (let index = 0; index < blocks.length; index += 1) {
    if (index > 0 && index % PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE === 0) {
      await yieldPdfReconstructionTask()
    }
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
        sourceProvenSamePageColumnBoundary(
          target,
          continuation,
          hardHyphenLexicon,
          unhyphenatedLexicon,
          language,
        )
      const sourceProvenSamePageBoundary =
        continuation?.type === 'paragraph' &&
        interveningOwnedCaptions.length === 0 &&
        sourceProvenSamePageParagraphBoundary(
          target,
          continuation,
          hardHyphenLexicon,
          unhyphenatedLexicon,
          language,
        )
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
      const sourceBoundaryProven =
        sourceProvenPageBoundary ||
        sourceProvenColumnBoundary ||
        sourceProvenFloatBoundary ||
        sourceProvenSamePageBoundary
      const hyphenJoin =
        sourceBoundaryProven && continuation?.type === 'paragraph'
          ? floatInterruptedHyphenJoin(
              target,
              continuation,
              hardHyphenLexicon,
              unhyphenatedLexicon,
              language,
            )
          : {
              separator: target.text ? ' ' : '',
              hyphenBoundary: null,
            }
      const lowercaseHyphenContinuation =
        continuation?.type === 'paragraph' &&
        /[\p{L}\p{N}][-‐‑]$/u.test(target.text.trimEnd()) &&
        /^\p{Ll}/u.test(continuation.text.trimStart())
      const sourceProvenHyphenDecision =
        !lowercaseHyphenContinuation ||
        (hyphenJoin.hyphenBoundary !== null &&
          hyphenJoin.hyphenBoundary.proof.sourceBoundaryProven &&
          sourceSemanticFlowHyphenVerdict(hyphenJoin.hyphenBoundary.proof) !==
            'unresolved')
      const samePageContinuation =
        continuation?.type === 'paragraph' &&
        blockSourceSegments(target).at(-1)?.region.page ===
          blockSourceSegments(continuation)[0]?.region.page
      if (
        continuation?.type !== 'paragraph' ||
        continuation.list ||
        (samePageContinuation && !sourceBoundaryProven) ||
        (crossesOwnedFloat && !sourceProvenFloatBoundary) ||
        (citationYearContinuation && !sourceProvenCitationBoundary) ||
        !sourceProvenHyphenDecision ||
        (!likelyUnmarkedCrossPageContinuation(target, continuation) &&
          !(
            sourceProvenFloatBoundary &&
            (scholarlyLabelFloatContinuation(target.text, continuation.text) ||
              /^\p{Ll}/u.test(continuation.text.trimStart()))
          ))
      ) {
        break
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
        hyphenJoin.hyphenBoundary
          ? {
              context: 'canonical-flow-continuation',
              ...hyphenJoin.hyphenBoundary,
              decisions: canonicalHyphenBoundaryDecisions,
            }
          : null,
        sourceSemanticFlowBoundaryDecisions,
        citationYearContinuation
          ? target.region.column === continuation.region.column
            ? 'same-column-citation-year'
            : 'cross-column-citation-year'
          : null,
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

async function bibliographyIndentationProfiles(
  blocks: RegionBlock[],
  bibliographyRegionIds: ReadonlySet<string>,
) {
  const linesByFlow = new Map<string, PdfPageRegion['lines']>()
  for (const [blockIndex, block] of blocks.entries()) {
    if (
      blockIndex > 0 &&
      blockIndex % PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE === 0
    ) {
      await yieldPdfReconstructionTask()
    }
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
    const sortedX = lines.map((line) => line.box.x).sort((a, b) => a - b)
    for (const [lineIndex, x] of sortedX.entries()) {
      if (
        lineIndex > 0 &&
        lineIndex % PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE === 0
      ) {
        await yieldPdfReconstructionTask()
      }
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

async function recoverBibliographyBlocks(
  blocks: RegionBlock[],
  bibliographyRegionIds: ReadonlySet<string>,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
  canonicalHyphenBoundaryDecisions: PdfCanonicalHyphenBoundaryDecision[],
  sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[],
  diagnostics: ReconstructionDiagnostic[] = [],
) {
  const profiles = await bibliographyIndentationProfiles(
    blocks,
    bibliographyRegionIds,
  )
  const uncertainFlows = new Map<string, RegionBlock[]>()
  for (const [blockIndex, block] of blocks.entries()) {
    if (
      blockIndex > 0 &&
      blockIndex % PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE === 0
    ) {
      await yieldPdfReconstructionTask()
    }
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
  const splitBlocks = (
    await mapPdfReconstructionInBatches(blocks, (block) =>
      splitBibliographyBlock(
        block,
        bibliographyRegionIds,
        profiles,
        lineBoundaryDecisions,
      ),
    )
  ).flat()
  const recovered: RegionBlock[] = []
  let previousBibliographyBlock: RegionBlock | undefined
  for (const [blockIndex, block] of splitBlocks.entries()) {
    if (
      blockIndex > 0 &&
      blockIndex % PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE === 0
    ) {
      await yieldPdfReconstructionTask()
    }
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
      appendBibliographyContinuation(
        previousBibliographyBlock,
        block,
        hardHyphenLexicon,
        unhyphenatedLexicon,
        language,
        canonicalHyphenBoundaryDecisions,
        sourceSemanticFlowBoundaryDecisions,
        sameBaselineFragment
          ? 'bibliography-same-baseline'
          : 'bibliography-hanging-indent',
      )
      continue
    }
    recovered.push(block)
    previousBibliographyBlock = block
  }
  return recovered
}

function extendBibliographyScopeFromStructuralHeading(
  blocks: readonly RegionBlock[],
  bibliographyRegionIds: Set<string>,
) {
  let activeHeadingLevel: number | undefined
  for (const block of blocks) {
    if (block.type === 'heading') {
      const level = block.headingLevel ?? 2
      if (
        /^(?:(?:\d+(?:\.\d+)*)[.)]?\s+)?references$/iu.test(block.text.trim())
      ) {
        activeHeadingLevel = level
      } else if (
        activeHeadingLevel !== undefined &&
        level <= activeHeadingLevel
      ) {
        activeHeadingLevel = undefined
      }
      continue
    }
    if (activeHeadingLevel !== undefined && block.type === 'paragraph') {
      bibliographyRegionIds.add(block.region.id)
    }
  }
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

function sourceStyledOrdinalSmallCapsHeading(
  line: PdfPageRegion['lines'][number],
) {
  const match = line.text
    .trim()
    .match(new RegExp(`^${SECTION_ORDINAL_SOURCE}\\.?\\s+(\\S.*)$`, 'u'))
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
  const letteredSmallCaps = sourceStyledOrdinalSmallCapsHeading(firstLine)
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
      if (!sourceStyledOrdinalSmallCapsHeading(line)) break
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

const PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE = 16
const PDF_BROWSER_WORKER_COOPERATIVE_BATCH_SIZE = 2
const PDF_BROWSER_WORKER_COOPERATIVE_DELAY_MS = 4

function isPdfBrowserWorkerRuntime() {
  return (
    typeof document === 'undefined' &&
    typeof location !== 'undefined' &&
    (location.protocol === 'http:' || location.protocol === 'https:') &&
    typeof globalThis.postMessage === 'function'
  )
}

function throwIfPdfReconstructionAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  throw new PdfImportError(
    'IMPORT_CANCELLED',
    'The local PDF reconstruction was cancelled and its working data was released.',
  )
}

async function yieldPdfReconstructionTask(signal?: AbortSignal) {
  throwIfPdfReconstructionAborted(signal)
  await new Promise<void>((resolve) =>
    globalThis.setTimeout(
      resolve,
      isPdfBrowserWorkerRuntime() ? PDF_BROWSER_WORKER_COOPERATIVE_DELAY_MS : 0,
    ),
  )
  throwIfPdfReconstructionAborted(signal)
}

async function mapPdfReconstructionInBatches<Input, Output>(
  values: readonly Input[],
  map: (value: Input, index: number) => Output,
  onBatch?: (completed: number, total: number) => void,
  signal?: AbortSignal,
) {
  const output: Output[] = []
  const cooperativeBatchSize = isPdfBrowserWorkerRuntime()
    ? PDF_BROWSER_WORKER_COOPERATIVE_BATCH_SIZE
    : PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && index % cooperativeBatchSize === 0) {
      onBatch?.(index, values.length)
      await yieldPdfReconstructionTask(signal)
    }
    output.push(map(values[index], index))
  }
  onBatch?.(values.length, values.length)
  return output
}

async function blocksFromRegions(
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
  language: string | null = null,
  diagnostics: ReconstructionDiagnostic[] = [],
  canonicalHyphenBoundaryDecisions: PdfCanonicalHyphenBoundaryDecision[] = [],
  sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[] = [],
  citationLedRegionIds: ReadonlySet<string> = new Set<string>(),
  onProgress?: (progress: PdfImportProgress) => void,
  signal?: AbortSignal,
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
  const sourceRegionLines = regions.flatMap((region) => region.lines)
  const hardHyphenLexicon = inlineHardHyphenLexicon(sourceRegionLines)
  const unhyphenatedLexicon = inlineUnhyphenatedLexicon(sourceRegionLines)
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
      sourceStyledOrdinalSmallCapsHeading(region.lines[0]) ||
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
    if (index > 0 && index % PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE === 0) {
      await yieldPdfReconstructionTask()
    }
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
  const compoundAffiliationSourceSegments = new WeakMap<
    PdfPageRegion,
    NonNullable<RegionBlock['sourceSegments']>[number]
  >()
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
      const derivedRegion: PdfPageRegion = {
        ...region,
        text,
        lines: selectedLines,
        ...(selectedLines.length > 0
          ? { box: boxForRegionLines(selectedLines) }
          : {}),
      }
      const sourceWindow = region.text.slice(
        segment.sourceStart,
        segment.sourceEnd,
      )
      const relativeCanonicalStart = sourceWindow.indexOf(segment.text)
      if (relativeCanonicalStart >= 0) {
        compoundAffiliationSourceSegments.set(derivedRegion, {
          region,
          evidenceRegion: derivedRegion,
          sourceStart: segment.sourceStart + relativeCanonicalStart,
          canonicalStart: 0,
          text: segment.text,
        })
      }
      return derivedRegion
    })
  })
  const initialBlocks = await mapPdfReconstructionInBatches<
    PdfPageRegion,
    RegionBlock
  >(
    expandedReadingRegions,
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
        const compoundSourceSegment =
          compoundAffiliationSourceSegments.get(region)
        const sourceSegments =
          compoundSourceSegment?.text === text
            ? [compoundSourceSegment]
            : exactCanonicalSubtextSourceSegment(region, text)
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
        sourceStyledOrdinalSmallCapsHeading(region.lines[0])
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
    (completed, total) =>
      onProgress?.({
        phase: 'reading-order',
        completed,
        total,
        message: `Reconstructing logical prose and legal float boundaries across ${completed} of ${total} regions…`,
      }),
    signal,
  )
  await yieldPdfReconstructionTask(signal)
  promoteAdjacentNumberedParentChildHeadings(initialBlocks, bodySize)
  const bibliographyScopeRegionIds = new Set(bibliographyRegionIds)
  extendBibliographyScopeFromStructuralHeading(
    initialBlocks,
    bibliographyScopeRegionIds,
  )
  const blocks = await recoverBibliographyBlocks(
    initialBlocks,
    bibliographyScopeRegionIds,
    lineBoundaryDecisions,
    hardHyphenLexicon,
    unhyphenatedLexicon,
    language,
    canonicalHyphenBoundaryDecisions,
    sourceSemanticFlowBoundaryDecisions,
    diagnostics,
  )
  await yieldPdfReconstructionTask(signal)
  splitListItemTailParagraphs(blocks, lineBoundaryDecisions)
  splitLeadingOrdinalHeadings(blocks, lineBoundaryDecisions, bodySize)
  await yieldPdfReconstructionTask(signal)

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
    if (
      blockIndex > 0 &&
      blockIndex % PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE === 0
    ) {
      await yieldPdfReconstructionTask(signal)
    }
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
        appendBibliographyContinuation(
          numberedContinuationTarget,
          block,
          hardHyphenLexicon,
          unhyphenatedLexicon,
          language,
          canonicalHyphenBoundaryDecisions,
          sourceSemanticFlowBoundaryDecisions,
          'bibliography-hanging-indent',
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
        appendBibliographyContinuation(
          numberedContinuationTarget,
          block,
          hardHyphenLexicon,
          unhyphenatedLexicon,
          language,
          canonicalHyphenBoundaryDecisions,
          sourceSemanticFlowBoundaryDecisions,
          'bibliography-hanging-indent',
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
      appendBlockContinuation(
        precedingBlock!,
        block,
        undefined,
        null,
        sourceSemanticFlowBoundaryDecisions,
        'aligned-enumeration',
      )
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
      appendBlockContinuation(
        precedingBlock,
        block,
        undefined,
        null,
        sourceSemanticFlowBoundaryDecisions,
      )
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
        appendBlockContinuation(
          lastListBlock,
          block,
          undefined,
          null,
          sourceSemanticFlowBoundaryDecisions,
        )
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
        const ownerFamilyName = owner.author
          .split(/\s+/u)
          .filter(Boolean)
          .at(-1)
        const markerOwnedByAuthorLine = block.region.lines.some((line) => {
          if (
            !ownerFamilyName ||
            !line.text.includes(ownerFamilyName) ||
            line.box.page !== classification.sourceBox.page
          ) {
            return false
          }
          const overlap = Math.max(
            0,
            Math.min(
              line.box.y + line.box.height,
              classification.sourceBox.y + classification.sourceBox.height,
            ) - Math.max(line.box.y, classification.sourceBox.y),
          )
          return overlap > 0
        })
        if (!markerOwnedByAuthorLine) return []
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
        const ownerFamilyName = owner.author
          .split(/\s+/u)
          .filter(Boolean)
          .at(-1)
        const markerOwnedByAuthorLine = block.region.lines.some((line) => {
          if (
            !ownerFamilyName ||
            !line.text.includes(ownerFamilyName) ||
            line.box.page !== classification.sourceBox.page
          ) {
            return false
          }
          const overlap = Math.max(
            0,
            Math.min(
              line.box.y + line.box.height,
              classification.sourceBox.y + classification.sourceBox.height,
            ) - Math.max(line.box.y, classification.sourceBox.y),
          )
          return overlap > 0
        })
        if (!markerOwnedByAuthorLine) return []
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

function exactSourceBoxesForCitationRange(
  region: PdfPageRegion,
  start: number,
  end: number,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  if (start < 0 || start >= end || end > region.text.length) return []
  const overlaps = exactSourceRunRanges(region, lineBoundaryDecisions)
    .flatMap((sourceRun) => {
      const overlapStart = Math.max(start, sourceRun.sourceStart)
      const overlapEnd = Math.min(end, sourceRun.sourceEnd)
      const sourceLength = sourceRun.sourceEnd - sourceRun.sourceStart
      if (
        overlapStart >= overlapEnd ||
        sourceLength <= 0 ||
        sourceRun.run.rotation !== 0 ||
        sourceRun.run.width <= 0 ||
        sourceRun.run.height <= 0
      ) {
        return []
      }
      const startRatio = (overlapStart - sourceRun.sourceStart) / sourceLength
      const endRatio = (overlapEnd - sourceRun.sourceStart) / sourceLength
      return [
        {
          sourceStart: overlapStart,
          sourceEnd: overlapEnd,
          box: {
            page: sourceRun.run.page,
            x: sourceRun.run.x + sourceRun.run.width * startRatio,
            y: sourceRun.run.y,
            width: sourceRun.run.width * (endRatio - startRatio),
            height: sourceRun.run.height,
            rotation: sourceRun.run.rotation,
            method: sourceRun.run.method,
          } satisfies NormalizedSourceBox,
        },
      ]
    })
    .sort(
      (left, right) =>
        left.sourceStart - right.sourceStart ||
        left.sourceEnd - right.sourceEnd,
    )
  if (overlaps.length === 0) return []
  let coveredEnd = start
  for (const overlap of overlaps) {
    if (
      overlap.sourceStart > coveredEnd &&
      region.text.slice(coveredEnd, overlap.sourceStart).trim()
    ) {
      return []
    }
    coveredEnd = Math.max(coveredEnd, overlap.sourceEnd)
  }
  if (coveredEnd < end && region.text.slice(coveredEnd, end).trim()) return []
  return [
    ...new Map(
      overlaps.map(({ box }) => [
        `${box.page}:${box.x}:${box.y}:${box.width}:${box.height}:${box.rotation}:${box.method}`,
        box,
      ]),
    ).values(),
  ]
}

function exactCitationTargetProvenance({
  classification,
  labels,
  targetNodeIds,
  regionMap,
  lineBoundaryDecisions,
}: {
  classification: PdfNoteMarkerClassification
  labels: readonly string[]
  targetNodeIds: readonly string[]
  regionMap: ReadonlyMap<string, PdfPageRegion>
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[]
}): NonNullable<PdfCitationRelationship['targets']> {
  if (
    labels.length === 0 ||
    labels.length !== targetNodeIds.length ||
    new Set(labels).size !== labels.length
  ) {
    return []
  }
  const region = regionMap.get(classification.referenceRegionId)
  if (!region) return []
  const sourceText = region.text.slice(classification.start, classification.end)
  if (!sourceText) return []
  const surfaces =
    labels.length === 1
      ? {
          identities: [...labels],
          links: [
            {
              identityIndex: 0,
              start: 0,
              end: sourceText.length,
            },
          ],
        }
      : parsePdfCitationSurface(sourceText)
  if (
    !surfaces ||
    surfaces.identities.length !== labels.length ||
    surfaces.identities.some((identity, index) => identity !== labels[index])
  ) {
    return []
  }
  const targets = surfaces.links.flatMap((surface) => {
    const label = labels[surface.identityIndex]
    const targetNodeId = targetNodeIds[surface.identityIndex]
    const referenceStart = classification.start + surface.start
    const referenceEnd = classification.start + surface.end
    const sourceBoxes = exactSourceBoxesForCitationRange(
      region,
      referenceStart,
      referenceEnd,
      lineBoundaryDecisions,
    )
    return label && targetNodeId && sourceBoxes.length > 0
      ? [
          {
            label,
            targetNodeId,
            referenceStart,
            referenceEnd,
            sourceBoxes,
            evidence: [
              'ordered-citation-label-target-cardinality',
              'exact-replayed-source-run-range',
              'target-specific-source-geometry',
            ],
          },
        ]
      : []
  })
  return targets.length === surfaces.links.length ? targets : []
}

function buildCitationRelationships(
  classifications: PdfNoteMarkerClassification[],
  blocks: RegionBlock[],
  regionMap: ReadonlyMap<string, PdfPageRegion>,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
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
    const key = pdfBibliographyAuthorYearKey(block.text)
    if (key) storeAuthorYearTarget(key, block.nodeId)
    const continuation = blocks[index + 1]
    const continuationIndentation = continuation
      ? continuation.region.box.x - block.region.box.x
      : 0
    if (
      key ||
      !pdfBibliographyFirstAuthorSurname(block.text) ||
      continuation?.list?.numberingId !== 'references' ||
      !continuation.list.continuedFromPreviousPage ||
      continuationIndentation < 0.008 ||
      continuationIndentation > 0.04
    ) {
      continue
    }
    const continuedKey = pdfBibliographyAuthorYearKey(
      `${block.text} ${continuation.text}`,
    )
    if (continuedKey) storeAuthorYearTarget(continuedKey, block.nodeId)
  }

  return classifications.flatMap<PdfCitationRelationship>((classification) => {
    if (!classification.accepted || classification.disposition !== 'citation')
      return []
    const labels = classification.label.split(',').filter(Boolean)
    if (classification.taxonomy === 'author-year-bibliography-citation') {
      let normalizedBoundaryKey = false
      const candidates = labels.map((label) => {
        const rawTargets = authorYearTargets.get(label) ?? []
        if (rawTargets.length !== 0) return rawTargets
        const region = regionMap.get(classification.referenceRegionId)
        const sourceText = region?.text.slice(
          classification.start,
          classification.end,
        )
        const firstSurname = sourceText?.match(
          /^\s*(\p{Lu}[\p{L}\p{M}'’.-]*)/u,
        )?.[1]
        const year = label.match(/:((?:18|19|20)\d{2}[a-z]?)$/u)?.[1]
        const surnameStart =
          region && sourceText && firstSurname
            ? classification.start + sourceText.indexOf(firstSurname)
            : -1
        if (
          !region ||
          !firstSurname ||
          !year ||
          surnameStart < classification.start ||
          pdfAuthorYearKey(firstSurname, year) !== label
        ) {
          return rawTargets
        }
        const alternateKey = pdfAlternateAuthorYearKeyFromBoundary(
          region,
          lineBoundaryDecisions,
          firstSurname,
          year,
          surnameStart,
        )
        const alternateTargets = alternateKey
          ? (authorYearTargets.get(alternateKey) ?? [])
          : []
        if (alternateTargets.length !== 1) return rawTargets
        normalizedBoundaryKey = true
        return alternateTargets
      })
      const missing = candidates.some((targets) => targets.length === 0)
      const ambiguous = candidates.some((targets) => targets.length > 1)
      const status = !missing && !ambiguous ? 'matched' : 'unresolved'
      const targetNodeIds =
        status === 'matched' ? candidates.map((targets) => targets[0]) : []
      const targets =
        status === 'matched'
          ? exactCitationTargetProvenance({
              classification,
              labels,
              targetNodeIds,
              regionMap,
              lineBoundaryDecisions,
            })
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
          targets,
          status,
          canonicalAnchor: null,
          confidence: classification.confidence,
          evidence: [
            ...classification.evidence,
            ...(normalizedBoundaryKey
              ? [
                  'author-year-key-normalized-from-unresolved-line-boundary-hyphen',
                ]
              : []),
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
    const targets =
      status === 'matched'
        ? exactCitationTargetProvenance({
            classification,
            labels,
            targetNodeIds,
            regionMap,
            lineBoundaryDecisions,
          })
        : []
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
        targetNodeIds,
        targets,
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
      !relationship.targets ||
      relationship.targets.length === 0
    ) {
      return []
    }
    return relationship.targets.flatMap((target) => {
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
          target.referenceStart,
          target.referenceEnd,
        )
        if (!range) return []
        const sourceText = blockSourceSegments(block).flatMap((segment) =>
          segment.region.id === relationship.referenceRegionId &&
          segment.sourceStart <= target.referenceStart &&
          segment.sourceStart + segment.text.length >= target.referenceEnd
            ? [
                segment.region.text.slice(
                  target.referenceStart,
                  target.referenceEnd,
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
            targetNodeId: target.targetNodeId,
            blockNodeId: block.nodeId,
            ...range,
            sourceBoxes: target.sourceBoxes.map((box) => ({ ...box })),
          },
        ]
      })
      return candidates.length === 1 ? candidates : []
    })
  })
}

function canonicalNoteHyperlinkSurfaces(
  relationships: readonly PdfNoteRelationship[],
  references: readonly NoteReferenceDraft[],
): CanonicalInternalHyperlinkSurface[] {
  const referencesById = new Map(
    references.map((reference) => [reference.id, reference] as const),
  )
  return relationships.flatMap((relationship) => {
    const reference = referencesById.get(relationship.id)
    const anchor = relationship.canonicalAnchor
    if (
      relationship.status !== 'matched' ||
      !relationship.targetNoteId ||
      anchor?.kind !== 'node' ||
      !reference ||
      !reference.classification.accepted ||
      reference.classification.disposition !== 'note-reference' ||
      reference.region.id !== relationship.referenceRegionId ||
      reference.start !== relationship.referenceStart ||
      reference.end !== relationship.referenceEnd ||
      anchor.start < 0 ||
      anchor.start >= anchor.end
    ) {
      return []
    }
    return [
      {
        targetNodeId: relationship.targetNoteId,
        blockNodeId: anchor.nodeId,
        start: anchor.start,
        end: anchor.end,
        sourceBoxes: [{ ...reference.classification.sourceBox }],
      },
    ]
  })
}

function normalizedInlineSourceText(value: string) {
  return value
    .replace(/\u00ad/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const TEX_SUFFIX_PREFIX_ACCENT = /[¨¯´¸ˆˇ˘˙˚˜˝]$/u

export function sourceRunBoundaryNormalizationAliasText(
  left: PdfSourceRun,
  right: PdfSourceRun,
) {
  const leftText = normalizedInlineSourceText(left.text)
  const rightText = normalizedInlineSourceText(right.text)
  const leftSequence = left.sourceSequenceIndex
  const rightSequence = right.sourceSequenceIndex
  const sequenceProven =
    leftSequence === undefined && rightSequence === undefined
      ? true
      : leftSequence !== undefined &&
        rightSequence !== undefined &&
        rightSequence === leftSequence + 1
  const boundaryTolerance = Math.max(
    0.0015,
    Math.min(left.height, right.height) * 0.9,
  )
  if (
    !TEX_SUFFIX_PREFIX_ACCENT.test(leftText) ||
    !/^\p{L}/u.test(rightText) ||
    left.page !== right.page ||
    left.rotation !== right.rotation ||
    left.method !== right.method ||
    left.fontName !== right.fontName ||
    Boolean(left.bold) !== Boolean(right.bold) ||
    Boolean(left.italic) !== Boolean(right.italic) ||
    !sequenceProven ||
    right.sourceWhitespaceBefore !== undefined ||
    right.x < left.x ||
    Math.abs(right.x - (left.x + left.width)) > boundaryTolerance
  ) {
    return null
  }
  const sourceJoined = `${leftText}${rightText}`
  const normalized = normalizedInlineSourceText(mergePdfRunText([left, right]))
  return normalized && normalized !== sourceJoined ? normalized : null
}

type ExactSourceRunRange = {
  line: PdfPageRegion['lines'][number]
  run: PdfSourceRun
  sourceStart: number
  sourceEnd: number
  text: string
}

type ExactSourceRunCandidate = {
  run: PdfSourceRun
  text: string
  occurrences: Array<{ start: number; end: number }>
}

export function retainUniqueMonotoneSourceRunAssignment(
  candidates: ExactSourceRunCandidate[],
) {
  // Repeated mathematical atoms (for example x, p, or a printed equation
  // number) are often individually ambiguous in the reconstructed line text.
  // Source run order can disambiguate them without guessing, but only when an
  // occurrence participates in a complete non-overlapping monotone assignment
  // for every substantive run on the line. Resolve the line only when exactly
  // one complete assignment exists; a locally fixed atom inside an otherwise
  // ambiguous sequence must remain fail-closed too.
  const substantive = candidates.filter((candidate) => candidate.text)
  if (substantive.length < 2) return false
  if (substantive.some((candidate) => candidate.occurrences.length === 0)) {
    substantive.forEach((candidate) => {
      candidate.occurrences = []
    })
    return false
  }

  const pathCounts = substantive.map((candidate) =>
    candidate.occurrences.map(() => 0),
  )
  substantive[0].occurrences.forEach((_, index) => {
    pathCounts[0][index] = 1
  })
  for (
    let candidateIndex = 1;
    candidateIndex < substantive.length;
    candidateIndex += 1
  ) {
    const previous = substantive[candidateIndex - 1]
    const candidate = substantive[candidateIndex]
    candidate.occurrences.forEach((occurrence, occurrenceIndex) => {
      pathCounts[candidateIndex][occurrenceIndex] = Math.min(
        2,
        previous.occurrences.reduce(
          (total, previousOccurrence, previousIndex) =>
            previousOccurrence.end <= occurrence.start
              ? total + pathCounts[candidateIndex - 1][previousIndex]
              : total,
          0,
        ),
      )
    })
  }
  const lastIndex = substantive.length - 1
  const completeAssignmentCount = Math.min(
    2,
    pathCounts[lastIndex].reduce((total, count) => total + count, 0),
  )
  if (completeAssignmentCount !== 1) {
    substantive.forEach((candidate) => {
      candidate.occurrences = []
    })
    return false
  }

  const assignment = new Array<number>(substantive.length)
  assignment[lastIndex] = pathCounts[lastIndex].findIndex(
    (count) => count === 1,
  )
  for (
    let candidateIndex = substantive.length - 2;
    candidateIndex >= 0;
    candidateIndex -= 1
  ) {
    const nextOccurrence =
      substantive[candidateIndex + 1].occurrences[
        assignment[candidateIndex + 1]
      ]
    const predecessors = substantive[candidateIndex].occurrences.flatMap(
      (occurrence, occurrenceIndex) =>
        pathCounts[candidateIndex][occurrenceIndex] === 1 &&
        occurrence.end <= nextOccurrence.start
          ? [occurrenceIndex]
          : [],
    )
    if (predecessors.length !== 1) {
      substantive.forEach((candidate) => {
        candidate.occurrences = []
      })
      return false
    }
    assignment[candidateIndex] = predecessors[0]
  }
  substantive.forEach((candidate, candidateIndex) => {
    candidate.occurrences = [candidate.occurrences[assignment[candidateIndex]]]
  })
  return true
}

export function retainUniqueSourceRunAssignmentWithAliases(
  candidates: ExactSourceRunCandidate[],
  partnerByRun: ReadonlyMap<PdfSourceRun, PdfSourceRun>,
) {
  // A positioned prefix accent and its target intentionally describe the same
  // canonical glyph interval. Collapse that pair to one logical atom, prove
  // one complete assignment across the whole line, then propagate the
  // selected interval back to both source runs. Unrelated logical atoms remain
  // non-overlapping.
  const grouped = new Set<ExactSourceRunCandidate>()
  const logicalCandidates = candidates.flatMap((candidate) => {
    if (grouped.has(candidate)) return []
    const partnerRun = partnerByRun.get(candidate.run)
    const partner = partnerRun
      ? candidates.find((peer) => peer.run === partnerRun)
      : undefined
    if (!partner || partner.text !== candidate.text) {
      grouped.add(candidate)
      return [{ logical: candidate, members: [candidate] }]
    }
    grouped.add(candidate)
    grouped.add(partner)
    const partnerOccurrences = new Set(
      partner.occurrences.map(
        (occurrence) => `${occurrence.start}:${occurrence.end}`,
      ),
    )
    return [
      {
        logical: {
          run: candidate.run,
          text: candidate.text,
          occurrences: candidate.occurrences.filter((occurrence) =>
            partnerOccurrences.has(`${occurrence.start}:${occurrence.end}`),
          ),
        },
        members: [candidate, partner],
      },
    ]
  })
  const unique =
    logicalCandidates.length === 1
      ? logicalCandidates[0].logical.occurrences.length === 1
      : retainUniqueMonotoneSourceRunAssignment(
          logicalCandidates.map(({ logical }) => logical),
        )
  for (const { logical, members } of logicalCandidates) {
    for (const member of members) {
      member.occurrences = [...logical.occurrences]
    }
  }
  return unique
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
    const positionedAccentPartnerByRun = new Map<PdfSourceRun, PdfSourceRun>()
    for (let index = 0; index < line.runs.length - 1; index += 1) {
      const accent = line.runs[index]
      const target = line.runs[index + 1]
      const text = positionedPdfPrefixAccentText(accent, target)
      if (!text) continue
      const normalizedText = normalizedInlineSourceText(text)
      positionedAccentTextByRun.set(accent, normalizedText)
      positionedAccentTextByRun.set(target, normalizedText)
      positionedAccentPartnerByRun.set(accent, target)
      positionedAccentPartnerByRun.set(target, accent)
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

    // Some producers leave a spacing accent at the end of one source run and
    // the base letter at the start of the next. Whole-line normalization then
    // composes the pair even though neither raw run is an exact substring.
    // Use the exact combined interval only as a logical ordering atom; neither
    // physical run receives that broad interval as an inline-style mapping.
    const normalizationOnlyRuns = new Set<PdfSourceRun>()
    for (let index = 0; index < candidates.length - 1; index += 1) {
      const left = candidates[index]
      const right = candidates[index + 1]
      const boundaryAliasText = sourceRunBoundaryNormalizationAliasText(
        left.run,
        right.run,
      )
      const provedBoundaryAlias =
        left.occurrences.length === 0 && boundaryAliasText
      if (
        ((left.occurrences.length > 0 || right.occurrences.length > 0) &&
          !provedBoundaryAlias) ||
        positionedAccentPartnerByRun.has(left.run) ||
        positionedAccentPartnerByRun.has(right.run)
      ) {
        continue
      }
      const combinedText =
        provedBoundaryAlias ??
        normalizedInlineSourceText(mergePdfRunText([left.run, right.run]))
      if (!combinedText) continue
      const occurrences: Array<{ start: number; end: number }> = []
      let cursor = lineRange.start
      while (cursor <= lineRange.end - combinedText.length) {
        const start = region.text.indexOf(combinedText, cursor)
        if (start < 0 || start + combinedText.length > lineRange.end) break
        occurrences.push({ start, end: start + combinedText.length })
        cursor = start + Math.max(combinedText.length, 1)
      }
      if (occurrences.length === 0) continue
      left.text = combinedText
      right.text = combinedText
      left.occurrences = [...occurrences]
      right.occurrences = [...occurrences]
      positionedAccentPartnerByRun.set(left.run, right.run)
      positionedAccentPartnerByRun.set(right.run, left.run)
      normalizationOnlyRuns.add(left.run)
      normalizationOnlyRuns.add(right.run)
      index += 1
    }
    retainUniqueSourceRunAssignmentWithAliases(
      candidates,
      positionedAccentPartnerByRun,
    )
    for (const candidate of candidates) {
      if (normalizationOnlyRuns.has(candidate.run)) {
        candidate.occurrences = []
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

function sourceAnchorSegments(blocks: readonly RegionBlock[]) {
  return [
    ...new Map(
      blocks
        .flatMap((block) => blockSourceSegments(block))
        .map(
          (segment) =>
            [
              `${segment.region.id}\0${segment.sourceStart}\0${segment.text.length}\0${segment.text}`,
              segment,
            ] as const,
        ),
    ).values(),
  ]
}

function exactLinkSourceAnchorFragments({
  annotation,
  segments,
  sourceRangesByRegionId,
}: {
  annotation: PdfLinkAnnotation
  segments: ReturnType<typeof sourceAnchorSegments>
  sourceRangesByRegionId: ReadonlyMap<
    string,
    ReturnType<typeof exactSourceRunRanges>
  >
}) {
  if (!annotation.box) return []
  const sourceRangeOwnerId = (
    regionId: string,
    sourceRange: ExactSourceRunRange,
  ) =>
    `${regionId}\0${sourceRange.line.id}\0${sourceRange.line.runs.indexOf(sourceRange.run)}\0${sourceRange.sourceStart}\0${sourceRange.sourceEnd}`
  const externalIntervalOwnership =
    annotation.status === 'external'
      ? resolvePdfExternalLinkSourceIntervalOwnership({
          annotation,
          candidates: [
            ...new Map(
              segments.flatMap((segment) =>
                (sourceRangesByRegionId.get(segment.region.id) ?? [])
                  .filter((sourceRange) =>
                    boxesOverlap(annotation.box, sourceRange.run),
                  )
                  .map((sourceRange) => {
                    const ownerId = sourceRangeOwnerId(
                      segment.region.id,
                      sourceRange,
                    )
                    return [
                      ownerId,
                      {
                        ownerId,
                        sourceStart: sourceRange.sourceStart,
                        sourceEnd: sourceRange.sourceEnd,
                        text: normalizedInlineSourceText(sourceRange.run.text),
                        sourceBox: sourceRange.run,
                      },
                    ] as const
                  }),
              ),
            ).values(),
          ],
        })
      : null
  const fragments: PdfLinkSourceAnchorFragment[] = []
  for (const segment of segments) {
    const sourceRanges = sourceRangesByRegionId.get(segment.region.id) ?? []
    const segmentEnd = segment.sourceStart + segment.text.length
    for (const sourceRange of sourceRanges) {
      if (!boxesOverlap(annotation.box, sourceRange.run)) continue
      const sourceOwnership =
        externalIntervalOwnership?.ownerId ===
        sourceRangeOwnerId(segment.region.id, sourceRange)
          ? externalIntervalOwnership
          : null
      // Once one target-specific source interval has unique ownership, a
      // merely overlapping neighboring run is not another fragment of that
      // link. Retaining it would make every canonical block fail the exact
      // range check even though the target surface proved one owner.
      if (externalIntervalOwnership && !sourceOwnership) continue
      const sourceStart = Math.max(
        sourceOwnership?.sourceStart ?? sourceRange.sourceStart,
        segment.sourceStart,
      )
      const sourceEnd = Math.min(
        sourceOwnership?.sourceEnd ?? sourceRange.sourceEnd,
        segmentEnd,
      )
      if (sourceStart >= sourceEnd) continue
      const segmentOffset = sourceStart - segment.sourceStart
      const text = segment.text.slice(
        segmentOffset,
        segmentOffset + sourceEnd - sourceStart,
      )
      if (!text || segment.region.text.slice(sourceStart, sourceEnd) !== text) {
        continue
      }
      const runIndex = sourceRange.line.runs.indexOf(sourceRange.run)
      if (runIndex < 0) continue
      fragments.push({
        regionId: segment.region.id,
        lineId: sourceRange.line.id,
        runIndex,
        sourceSequenceIndex: sourceRange.run.sourceSequenceIndex ?? null,
        sourceStart,
        sourceEnd,
        text,
        ...(sourceOwnership
          ? { ownershipEvidence: sourceOwnership.evidence }
          : {}),
        sourceBox: sourceOwnership
          ? { ...sourceOwnership.sourceBox }
          : {
              page: sourceRange.run.page,
              x: sourceRange.run.x,
              y: sourceRange.run.y,
              width: sourceRange.run.width,
              height: sourceRange.run.height,
              rotation: sourceRange.run.rotation,
              method: sourceRange.run.method,
            },
      })
    }
  }
  return [
    ...new Map(
      fragments.map(
        (fragment) =>
          [
            `${fragment.regionId}\0${fragment.lineId}\0${fragment.runIndex}\0${fragment.sourceStart}\0${fragment.sourceEnd}`,
            fragment,
          ] as const,
      ),
    ).values(),
  ].sort(
    (left, right) =>
      left.sourceBox.page - right.sourceBox.page ||
      left.sourceBox.y - right.sourceBox.y ||
      left.sourceBox.x - right.sourceBox.x ||
      left.regionId.localeCompare(right.regionId) ||
      left.sourceStart - right.sourceStart,
  )
}

export function buildPdfLinkSourceAnchorLedger({
  blocks,
  annotations,
  lineBoundaryDecisions = [],
}: {
  blocks: readonly RegionBlock[]
  annotations: readonly PdfLinkAnnotation[]
  lineBoundaryDecisions?: readonly PdfLineBoundaryDecision[]
}): PdfLinkSourceAnchor[] {
  const segments = sourceAnchorSegments(blocks)
  const sourceRangesByRegionId = new Map<
    string,
    ReturnType<typeof exactSourceRunRanges>
  >()
  const segmentsByPage = new Map<number, typeof segments>()
  for (const segment of segments) {
    if (!sourceRangesByRegionId.has(segment.region.id)) {
      sourceRangesByRegionId.set(
        segment.region.id,
        exactSourceRunRanges(segment.region, lineBoundaryDecisions),
      )
    }
    const pageSegments = segmentsByPage.get(segment.region.page) ?? []
    pageSegments.push(segment)
    segmentsByPage.set(segment.region.page, pageSegments)
  }
  return annotations.map((annotation) => {
    const fragments = exactLinkSourceAnchorFragments({
      annotation,
      segments: segmentsByPage.get(annotation.page) ?? [],
      sourceRangesByRegionId,
    })
    return {
      annotationId: annotation.id,
      page: annotation.page,
      status: fragments.length > 0 ? 'anchored' : 'unresolved',
      fragments,
      evidence: 'exact-source-run-interval-v1',
    }
  })
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
  annotation: Exclude<PdfLinkAnnotation, { status: 'unresolved' }>,
  sourceAnchor: PdfLinkSourceAnchor,
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

  const ranges = sourceAnchor.fragments.map((fragment) =>
    exactCanonicalRangeForSource(
      block,
      fragment.regionId,
      fragment.sourceStart,
      fragment.sourceEnd,
    ),
  )
  if (ranges.some((range) => range === null)) return null
  const ordered = [
    ...new Map(
      ranges.map((range) => [`${range!.start}:${range!.end}`, range!] as const),
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
  const substantiallyNarrowerThanSourceRun = sourceAnchor.fragments.some(
    (fragment) => annotation.box.width < fragment.sourceBox.width * 0.8,
  )
  if (substantiallyNarrowerThanSourceRun) {
    const exactLiteralExternalRanges =
      annotation.status === 'external'
        ? literalAbsoluteHyperlinks(block.text).filter(
            (candidate) =>
              normalizedPdfExternalLinkTarget(candidate.url) ===
                normalizedPdfExternalLinkTarget(annotation.url) &&
              candidate.start >= start &&
              candidate.end <= end,
          )
        : []
    if (exactLiteralExternalRanges.length === 1) {
      return {
        start: exactLiteralExternalRanges[0].start,
        end: exactLiteralExternalRanges[0].end,
      }
    }
    return null
  }
  return start < end ? { start, end } : null
}

function hasStrongCanonicalSurfaceOwnership(
  annotationBox: NormalizedSourceBox,
  surfaceBox: NormalizedSourceBox,
) {
  if (
    annotationBox.rotation !== surfaceBox.rotation ||
    !boxesOverlap(annotationBox, surfaceBox)
  ) {
    return false
  }
  const overlapWidth =
    Math.min(
      annotationBox.x + annotationBox.width,
      surfaceBox.x + surfaceBox.width,
    ) - Math.max(annotationBox.x, surfaceBox.x)
  const overlapHeight =
    Math.min(
      annotationBox.y + annotationBox.height,
      surfaceBox.y + surfaceBox.height,
    ) - Math.max(annotationBox.y, surfaceBox.y)
  const annotationArea = annotationBox.width * annotationBox.height
  const surfaceArea = surfaceBox.width * surfaceBox.height
  const overlapArea = overlapWidth * overlapHeight
  const horizontalCoverage =
    overlapWidth / Math.min(annotationBox.width, surfaceBox.width)
  const verticalCoverage =
    overlapHeight / Math.min(annotationBox.height, surfaceBox.height)
  // Link rectangles are sometimes shifted toward the delimiter between
  // adjacent citation labels. Permit bounded drift only when a candidate
  // still owns substantial overlap on both axes; the caller retains the
  // unique-target and unique-surface requirements.
  if (
    annotationArea <= 0 ||
    surfaceArea <= 0 ||
    overlapArea / Math.min(annotationArea, surfaceArea) < 0.25
  ) {
    return false
  }
  const annotationCenter = {
    x: annotationBox.x + annotationBox.width / 2,
    y: annotationBox.y + annotationBox.height / 2,
  }
  const surfaceCenter = {
    x: surfaceBox.x + surfaceBox.width / 2,
    y: surfaceBox.y + surfaceBox.height / 2,
  }
  const contains = (
    box: NormalizedSourceBox,
    point: { x: number; y: number },
  ) =>
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  return (
    contains(surfaceBox, annotationCenter) ||
    contains(annotationBox, surfaceCenter) ||
    (horizontalCoverage >= 0.35 && verticalCoverage >= 0.5)
  )
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
            surface.blockNodeId === block.nodeId &&
            surface.sourceBoxes.some((box) =>
              hasStrongCanonicalSurfaceOwnership(annotationBox, box),
            ) &&
            surface.start >= 0 &&
            surface.start < surface.end &&
            surface.end <= block.text.length,
        )
        .map(
          (surface) =>
            [
              `${surface.targetNodeId}:${surface.blockNodeId}:${surface.start}:${surface.end}`,
              surface,
            ] as const,
        ),
    ).values(),
  ]
  if (candidates.length !== 1 || candidates[0].targetNodeId !== targetNodeId) {
    return null
  }
  return { start: candidates[0].start, end: candidates[0].end }
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
  const pendingInternalClaims: Array<{
    annotation: PdfLinkAnnotation
    sourceAnchor: PdfLinkSourceAnchor
    mapping: CanonicalHyperlinkMapping
  }> = []
  let mappedAnnotationCount = 0
  const blocksBySourceRegionId = new Map<string, RegionBlock[]>()
  const blocksByNodeId = new Map(
    blocks.flatMap((block) =>
      block.nodeId ? [[block.nodeId, block] as const] : [],
    ),
  )
  for (const block of blocks) {
    const sourceRegionIds = new Set(
      blockSourceSegments(block).map((segment) => segment.region.id),
    )
    for (const regionId of sourceRegionIds) {
      const regionBlocks = blocksBySourceRegionId.get(regionId) ?? []
      regionBlocks.push(block)
      blocksBySourceRegionId.set(regionId, regionBlocks)
    }
  }
  const sourceAnchorLedger = buildPdfLinkSourceAnchorLedger({
    blocks,
    annotations,
    lineBoundaryDecisions,
  })
  const sourceAnchorsByAnnotationId = new Map(
    sourceAnchorLedger.map((anchor) => [anchor.annotationId, anchor] as const),
  )
  const recordFailure = (
    annotation: PdfLinkAnnotation,
    sourceAnchor: PdfLinkSourceAnchor,
    failure: string,
  ) => {
    const regionIds = [
      ...new Set(sourceAnchor.fragments.map((fragment) => fragment.regionId)),
    ]
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
  for (const annotation of annotations) {
    const sourceAnchor = sourceAnchorsByAnnotationId.get(annotation.id)!
    let failure: string | null = null
    if (annotation.status === 'unresolved') {
      failure = `PDF link annotation ${annotation.id} remains unresolved (${annotation.reason})${annotation.target ? ` for ${annotation.target}` : ''}.`
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
      const isCanonicalSurfaceDestination =
        destinationResolution?.status === 'matched' &&
        (sourceSurfaceTarget?.kind === 'reference' ||
          canonicalTargets.some(
            (target) =>
              target.nodeId === destinationResolution.targetNodeId &&
              target.kind === 'reference',
          ) ||
          ((sourceSurfaceTarget?.kind === 'note' ||
            canonicalTargets.some(
              (target) =>
                target.nodeId === destinationResolution.targetNodeId &&
                target.kind === 'note',
            )) &&
            canonicalInternalSurfaces.some(
              (surface) =>
                surface.targetNodeId === destinationResolution.targetNodeId,
            )))
      const sourceOwnedBlocks = [
        ...new Set(
          sourceAnchor.fragments.flatMap(
            (fragment) => blocksBySourceRegionId.get(fragment.regionId) ?? [],
          ),
        ),
      ]
      const canonicalSurfaceBlocks = isCanonicalSurfaceDestination
        ? [
            ...new Set(
              canonicalInternalSurfaces.flatMap((surface) =>
                surface.sourceBoxes.some((box) =>
                  hasStrongCanonicalSurfaceOwnership(annotation.box, box),
                )
                  ? [blocksByNodeId.get(surface.blockNodeId)]
                  : [],
              ),
            ),
          ].filter((block): block is RegionBlock => Boolean(block))
        : []
      const annotationBlocks = [
        ...new Set([...sourceOwnedBlocks, ...canonicalSurfaceBlocks]),
      ]
      const candidates = annotationBlocks.flatMap((block) => {
        if (!block.nodeId) return []
        const range = isCanonicalSurfaceDestination
          ? exactCanonicalInternalHyperlinkSurfaceRange({
              annotationBox: annotation.box,
              block,
              surfaces: canonicalInternalSurfaces,
              targetNodeId: destinationResolution.targetNodeId,
            })
          : canonicalHyperlinkRange(
              block,
              annotation,
              sourceAnchor,
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
          const href = `#${destinationResolution.targetNodeId}`
          pendingInternalClaims.push({
            annotation,
            sourceAnchor,
            mapping: {
              ...candidates[0],
              href,
            },
          })
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
    recordFailure(annotation, sourceAnchor, failure)
  }
  const internalClaimsByCanonicalRange = new Map<
    string,
    typeof pendingInternalClaims
  >()
  for (const claim of pendingInternalClaims) {
    const rangeKey = `${claim.mapping.blockNodeId}\u0000${claim.mapping.start}\u0000${claim.mapping.end}`
    const claims = internalClaimsByCanonicalRange.get(rangeKey) ?? []
    claims.push(claim)
    internalClaimsByCanonicalRange.set(rangeKey, claims)
  }
  for (const rangeKey of [...internalClaimsByCanonicalRange.keys()].sort()) {
    const claims = internalClaimsByCanonicalRange
      .get(rangeKey)!
      .sort((left, right) =>
        left.annotation.id.localeCompare(right.annotation.id),
      )
    const hrefs = [...new Set(claims.map((claim) => claim.mapping.href))].sort()
    if (hrefs.length === 1) {
      mappings.push(claims[0].mapping)
      for (const claim of claims) {
        approvedAnnotationIds.add(claim.annotation.id)
        mappedAnnotationCount += 1
      }
      continue
    }
    for (const claim of claims) {
      recordFailure(
        claim.annotation,
        claim.sourceAnchor,
        `Canonical inline owner ${claim.mapping.blockNodeId}:${claim.mapping.start}-${claim.mapping.end} has conflicting internal targets ${hrefs.join(', ')}; PDF link annotation ${claim.annotation.id} remains unresolved.`,
      )
    }
  }
  const annotationsById = new Map(
    annotations.map((annotation) => [annotation.id, annotation] as const),
  )
  const mappingsByCanonicalRange = new Map<
    string,
    Array<{ mapping: CanonicalHyperlinkMapping; index: number }>
  >()
  for (const [index, mapping] of mappings.entries()) {
    const rangeKey = `${mapping.blockNodeId}\u0000${mapping.start}\u0000${mapping.end}`
    const values = mappingsByCanonicalRange.get(rangeKey) ?? []
    values.push({ mapping, index })
    mappingsByCanonicalRange.set(rangeKey, values)
  }
  const conflictingMappingIndexes = new Set<number>()
  const conflictingMappingGroups: Array<{
    rangeKey: string
    claims: Array<{ mapping: CanonicalHyperlinkMapping; index: number }>
    hrefs: string[]
  }> = []
  for (const rangeKey of [...mappingsByCanonicalRange.keys()].sort()) {
    const claims = mappingsByCanonicalRange.get(rangeKey)!
    const hrefs = [...new Set(claims.map(({ mapping }) => mapping.href))].sort()
    if (hrefs.length <= 1) continue
    for (const { index } of claims) conflictingMappingIndexes.add(index)
    conflictingMappingGroups.push({ rangeKey, claims, hrefs })
  }
  if (conflictingMappingIndexes.size > 0) {
    mappings.splice(
      0,
      mappings.length,
      ...mappings.filter((_, index) => !conflictingMappingIndexes.has(index)),
    )
  }
  for (const { rangeKey, claims, hrefs } of conflictingMappingGroups) {
    for (const annotationId of [
      ...new Set(claims.map(({ mapping }) => mapping.annotationId)),
    ].sort()) {
      const annotation = annotationsById.get(annotationId)
      const sourceAnchor = sourceAnchorsByAnnotationId.get(annotationId)
      if (!annotation || !sourceAnchor) continue
      if (approvedAnnotationIds.delete(annotationId)) {
        mappedAnnotationCount -= 1
      }
      recordFailure(
        annotation,
        sourceAnchor,
        `Canonical inline owner ${rangeKey.replaceAll('\u0000', ':')} has conflicting hyperlink targets ${hrefs.join(', ')}; PDF link annotation ${annotationId} remains unresolved.`,
      )
    }
  }
  const externalAnnotationsById = new Map(
    annotations.flatMap((annotation) =>
      annotation.status === 'external'
        ? [[annotation.id, annotation] as const]
        : [],
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
    sourceAnchorLedger,
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

export function materializeCanonicalVisualNode({
  relationship,
  id,
  captionNodeId,
  source,
  table,
  sourceText,
  inlineRuns,
}: {
  relationship: PdfVisualRelationship
  id: string
  captionNodeId: string
  source: string
  table?: Extract<ResearchNode, { type: 'figure' }>['table']
  sourceText?: string
  inlineRuns?: Extract<ResearchNode, { type: 'figure' }>['inlineRuns']
}) {
  return {
    id,
    type: 'figure' as const,
    objectType: relationship.kind,
    ...(table ? { table } : {}),
    ...(sourceText ? { sourceText } : {}),
    ...(inlineRuns?.length ? { inlineRuns } : {}),
    title: relationship.altText,
    relationships: {
      caption: captionNodeId,
      assets: [...relationship.assetIds],
    },
    source,
  } satisfies Extract<ResearchNode, { type: 'figure' }>
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

function supportedSourceInlineStyle({
  regionId,
  line,
  run,
  runIndex,
  removedStandaloneDiscretionaryHyphens,
}: {
  regionId: string
  line: PdfPageRegion['lines'][number]
  run: PdfSourceRun
  runIndex: number
  removedStandaloneDiscretionaryHyphens: ReadonlySet<string>
}) {
  const sourceText = normalizedInlineSourceText(run.text)
  if (!sourceText) return null
  if (
    runIndex === line.runs.length - 1 &&
    /^[-‐‑]$/u.test(sourceText) &&
    /^[-‐‑]$/u.test(run.text.replace(/\s+/gu, '')) &&
    removedStandaloneDiscretionaryHyphens.has(`${regionId}:${line.id}`)
  ) {
    // PDF producers often emit the discretionary hyphen as its own styled
    // glyph run. Once the source-proved boundary decision removes that glyph,
    // it has no canonical range or inline semantic obligation of its own.
    return null
  }
  const bold = run.bold ?? fontNameIndicatesBold(run.fontName)
  const italic = run.italic ?? fontNameIndicatesItalic(run.fontName)
  const verticalAlign = runVerticalAlign(line, run)
  const compactMathSpans = sourceMathAtomCompactionRanges(
    sourceText,
    run.fontName,
  )
  return {
    sourceText,
    bold,
    italic,
    verticalAlign,
    compactMathSpans,
    expectedStyleCount:
      Number(bold) +
      Number(italic) +
      Number(Boolean(verticalAlign)) +
      compactMathSpans.length,
  }
}

function canonicalVisualSourceInlineMappingFromOwner(
  owner: CanonicalVisualTextOwner,
  regionsById: ReadonlyMap<string, PdfPageRegion>,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const mapped = new Map<string, CanonicalInlineRun>()
  const ledger: InlineMappingLedger = { expected: 0, mapped: 0 }
  const removedStandaloneDiscretionaryHyphens = new Set(
    lineBoundaryDecisions.flatMap((decision) =>
      decision.outcome === 'removed-discretionary-hyphen'
        ? [`${decision.regionId}:${decision.fromLineId}`]
        : [],
    ),
  )
  const exactRangesByRegion = new Map<
    string,
    Map<PdfSourceRun, ExactSourceRunRange>
  >()
  for (const segment of owner.segments) {
    const region = regionsById.get(segment.regionId)
    const line = region?.lines.find(
      (candidate) => candidate.id === segment.lineId,
    )
    if (!region || !line) continue
    let exactRangesByRun = exactRangesByRegion.get(region.id)
    if (!exactRangesByRun) {
      exactRangesByRun = new Map(
        exactSourceRunRanges(region, lineBoundaryDecisions).map(
          (sourceRun) => [sourceRun.run, sourceRun] as const,
        ),
      )
      exactRangesByRegion.set(region.id, exactRangesByRun)
    }
    for (const [runIndex, run] of line.runs.entries()) {
      const style = supportedSourceInlineStyle({
        regionId: region.id,
        line,
        run,
        runIndex,
        removedStandaloneDiscretionaryHyphens,
      })
      if (!style || style.expectedStyleCount === 0) continue
      ledger.expected += style.expectedStyleCount
      const exactRange = exactRangesByRun.get(run)
      if (
        !exactRange ||
        exactRange.sourceStart < segment.sourceStart ||
        exactRange.sourceEnd > segment.sourceEnd
      ) {
        continue
      }
      const start =
        segment.canonicalStart + exactRange.sourceStart - segment.sourceStart
      const end = start + exactRange.sourceEnd - exactRange.sourceStart
      if (
        start < 0 ||
        start >= end ||
        end > owner.text.length ||
        owner.text.slice(start, end) !== exactRange.text
      ) {
        continue
      }
      const boundaries = [
        0,
        exactRange.text.length,
        ...style.compactMathSpans.flatMap((span) => [span.start, span.end]),
      ]
      const points = [...new Set(boundaries)].sort(
        (left, right) => left - right,
      )
      for (let index = 0; index < points.length - 1; index += 1) {
        const segmentStart = points[index]
        const segmentEnd = points[index + 1]
        if (segmentStart === segmentEnd) continue
        const compactMathAtom = style.compactMathSpans.some(
          (span) => span.start <= segmentStart && span.end >= segmentEnd,
        )
        const runStart = start + segmentStart
        const runEnd = start + segmentEnd
        const key = `${runStart}:${runEnd}`
        mapped.set(key, {
          ...mapped.get(key),
          start: runStart,
          end: runEnd,
          ...(style.bold ? { bold: true } : {}),
          ...(style.italic ? { italic: true } : {}),
          ...(style.verticalAlign
            ? { verticalAlign: style.verticalAlign }
            : {}),
          ...(compactMathAtom ? { compactMathAtom: true } : {}),
        })
      }
      ledger.mapped += style.expectedStyleCount
    }
  }
  return {
    runs: [...mapped.values()].sort(
      (left, right) => left.start - right.start || left.end - right.end,
    ),
    ledger,
  }
}

export function canonicalVisualSourceInlineMapping({
  relationship,
  nodeId,
  regions,
  lineBoundaryDecisions,
}: {
  relationship: PdfVisualRelationship
  nodeId: string
  regions: PdfPageRegion[]
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[]
}) {
  if (
    relationship.kind !== 'table' ||
    relationship.status !== 'matched' ||
    !relationship.sourceText ||
    !relationship.sourceLineIds?.length
  ) {
    return { runs: [], ledger: { expected: 0, mapped: 0 } }
  }
  const regionsById = new Map(
    regions.map((region) => [region.id, region] as const),
  )
  const owner = canonicalVisualTextOwner(
    relationship,
    nodeId,
    regions,
    lineBoundaryDecisions,
  )
  if (owner) {
    return canonicalVisualSourceInlineMappingFromOwner(
      owner,
      regionsById,
      lineBoundaryDecisions,
    )
  }
  const selectedRegionIds = new Set(relationship.sourceRegionIds)
  const selectedLineIds = new Set(relationship.sourceLineIds)
  const selectedLineOwnerCounts = new Map<string, number>()
  for (const region of regions.filter((candidate) =>
    selectedRegionIds.has(candidate.id),
  )) {
    for (const line of region.lines) {
      if (!selectedLineIds.has(line.id)) continue
      selectedLineOwnerCounts.set(
        line.id,
        (selectedLineOwnerCounts.get(line.id) ?? 0) + 1,
      )
    }
  }
  const invalidLineage =
    new Set(relationship.sourceLineIds).size !==
      relationship.sourceLineIds.length ||
    relationship.sourceLineIds.some(
      (lineId) => selectedLineOwnerCounts.get(lineId) !== 1,
    )
  const removedStandaloneDiscretionaryHyphens = new Set(
    lineBoundaryDecisions.flatMap((decision) =>
      decision.outcome === 'removed-discretionary-hyphen'
        ? [`${decision.regionId}:${decision.fromLineId}`]
        : [],
    ),
  )
  const expected = regions
    .filter((region) => selectedRegionIds.has(region.id))
    .flatMap((region) =>
      region.lines
        .filter((line) => selectedLineIds.has(line.id))
        .flatMap((line) =>
          line.runs.flatMap((run, runIndex) => {
            const style = supportedSourceInlineStyle({
              regionId: region.id,
              line,
              run,
              runIndex,
              removedStandaloneDiscretionaryHyphens,
            })
            return style ? [style.expectedStyleCount] : []
          }),
        ),
    )
    .reduce((total, count) => total + count, 0)
  // A malformed selected-line lineage cannot prove that it enumerated every
  // source style. Retain a sentinel obligation so the ordinary inline-coverage
  // gate remains fail-closed even when the missing line cannot be inspected.
  return {
    runs: [],
    ledger: { expected: expected + Number(invalidLineage), mapped: 0 },
  }
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
  const removedStandaloneDiscretionaryHyphens = new Set(
    lineBoundaryDecisions.flatMap((decision) =>
      decision.outcome === 'removed-discretionary-hyphen'
        ? [`${decision.regionId}:${decision.fromLineId}`]
        : [],
    ),
  )
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
      for (const [runIndex, run] of line.runs.entries()) {
        const style = supportedSourceInlineStyle({
          regionId: segment.region.id,
          line,
          run,
          runIndex,
          removedStandaloneDiscretionaryHyphens,
        })
        if (!style) continue
        const {
          sourceText,
          bold,
          italic,
          verticalAlign,
          compactMathSpans,
          expectedStyleCount,
        } = style
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
                candidate.start <= segmentStart && candidate.end >= segmentEnd,
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
  const physicallySourceOrderedPairs = [...sourceOrderedPairs].sort(
    comparePairSourceOrder,
  )
  const sourceRankByVisualNodeId = new Map(
    sourceOrderedPairs.map(
      (pair, index) => [pair.visualNodeId, index] as const,
    ),
  )
  const pairByVisualNodeId = new Map(
    sourceOrderedPairs.map((pair) => [pair.visualNodeId, pair] as const),
  )
  const physicalRankByVisualNodeId = new Map(
    physicallySourceOrderedPairs.map(
      (pair, index) => [pair.visualNodeId, index] as const,
    ),
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
  const preservesAtomicPhysicalSourcePairOrder = () => {
    let previousRank = -1
    let encountered = 0
    for (const [nodeIndex, node] of nodes.entries()) {
      const sourceRank = physicalRankByVisualNodeId.get(node.id)
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
    return encountered === physicallySourceOrderedPairs.length
  }
  const restoreNodes = (snapshot: readonly ResearchNode[]) => {
    nodes.splice(0, nodes.length, ...snapshot)
  }
  const recordSourceOrderFloatFallback = ({
    page,
    visualNodeId,
    reason,
    relationshipId,
    sourceBoxes = [],
    target,
  }: {
    page: number
    visualNodeId: string
    reason: string
    relationshipId?: string
    sourceBoxes?: NormalizedSourceBox[]
    target?: ReconstructionDiagnostic['target']
  }) => {
    if (preservesAtomicPhysicalSourcePairOrder()) {
      diagnostics.push({
        code: 'SOURCE_ORDER_FLOAT_FALLBACK',
        severity: 'info',
        page,
        message: `Skipped optional placement for canonical visual ${visualNodeId}; ${reason} The source-proved atomic visual-caption order remains unchanged.`,
        ...(relationshipId ? { relationshipId } : {}),
        sourceBoxes,
        ...(target ? { target } : {}),
      })
      return
    }
    diagnostics.push({
      code: 'AMBIGUOUS_READING_ORDER',
      severity: 'error',
      page,
      message: `Canonical visual ${visualNodeId} cannot use the source-order float fallback because the source-proved atomic visual-caption order is not intact.`,
      ...(relationshipId ? { relationshipId } : {}),
      sourceBoxes,
      ...(target ? { target } : {}),
    })
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
      pagePairs.every(
        (pair) => pair.column === 'left' || pair.column === 'right',
      ) &&
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
          recordSourceOrderFloatFallback({
            page: pair.page,
            visualNodeId: pair.visualNodeId,
            reason: `exact references span ${headingScopeIds.size} distinct heading or document-root scopes.`,
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
        recordSourceOrderFloatFallback({
          page: pair.page,
          visualNodeId: pair.visualNodeId,
          reason:
            'exact references are equally near in distinct heading or document-root scopes.',
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
        recordSourceOrderFloatFallback({
          page: pair.page,
          visualNodeId: pair.visualNodeId,
          reason: `the physical heading scope ${physicalHeadingScopeId} differs from exact-reference scope ${referenceHeadingScopeId}.`,
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
      recordSourceOrderFloatFallback({
        page: pair.page,
        visualNodeId: pair.visualNodeId,
        reason:
          'the proposed reference-scope placement would reverse source-proved visual-caption pair order.',
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
    const runSnapshot = [...nodes]
    const movedPairs: Array<{
      pair: (typeof pairs)[number]
      precedingReferenceRegionId: string
      followingReferenceRegionId: string
    }> = []
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
      movedPairs.push({
        pair: scopedPair.pair,
        precedingReferenceRegionId:
          precedingOwner.relationship.referenceRegionId,
        followingReferenceRegionId:
          followingOwner.relationship.referenceRegionId,
      })
    }
    if (movedPairs.length === 0) continue
    if (!preservesAtomicPhysicalSourcePairOrder()) {
      restoreNodes(runSnapshot)
      for (const moved of movedPairs) {
        recordSourceOrderFloatFallback({
          page: moved.pair.page,
          visualNodeId: moved.pair.visualNodeId,
          reason:
            'the only bounded inferred-scope placement would reverse source-proved visual-caption pair order.',
          sourceBoxes: moved.pair.sourceBox ? [moved.pair.sourceBox] : [],
          target: {
            regionIds: [
              moved.precedingReferenceRegionId,
              moved.followingReferenceRegionId,
            ],
            markerId: null,
          },
        })
      }
      continue
    }
    for (const moved of movedPairs) {
      diagnostics.push({
        code: 'RESOLVED_READING_ORDER',
        severity: 'info',
        page: moved.pair.page,
        message: `Placed canonical visual ${moved.pair.visualNodeId} in the unique slot bounded by adjacent exact-reference scopes while preserving source-proved visual-caption pair order.`,
        sourceBoxes: moved.pair.sourceBox ? [moved.pair.sourceBox] : [],
        target: {
          regionIds: [
            moved.precedingReferenceRegionId,
            moved.followingReferenceRegionId,
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
  relationship.canonicalNodeId = null
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
  const sourcePreservedFallback =
    relationship.status !== 'matched' &&
    relationship.assetIds.length > 0 &&
    relationship.evidence.includes('source-preserved-table-fallback')
  if (
    (!sourcePreservedFallback && relationship.status !== 'matched') ||
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
  tableCandidateProvider,
  allowRemoteTableCandidateProvider = false,
  onProgress,
  signal,
}: {
  pages: PdfPageAnalysis[]
  sourceHash: string
  fileName: string
  byteLength: number
  metadata?: PdfDocumentMetadata
  rasterizeFigure?: PdfFigureRasterizer
  tableCandidateProvider?: TableCandidateProvider
  allowRemoteTableCandidateProvider?: boolean
  onProgress?: (progress: PdfImportProgress) => void
  signal?: AbortSignal
}): Promise<PdfReconstruction> {
  throwIfPdfReconstructionAborted(signal)
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

  onProgress?.({
    phase: 'segmenting',
    completed: 0,
    total: 0,
    message: 'Segmenting typed objects and physical page regions…',
  })
  const publicationMetadata = pdfPublicationMetadata(pages, metadata)
  const regionResult = reconstructPageRegions(pages, {
    language: publicationMetadata.language,
  })
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
          .filter((region) => region.furniture)
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

  onProgress?.({
    phase: 'semantic-promotion',
    completed: 0,
    total: 0,
    message:
      'Validating figures, tables, equations, and complete source fallbacks…',
    checkpoint: 'visual-index',
  })
  const visualResult = await reconstructPdfVisuals({
    pages,
    regions: regionResult.regions,
    rasterizeFigure,
    tableCandidateProvider,
    allowRemoteTableCandidateProvider,
    onProgress,
    signal,
  })
  const preformattedLineSets = visualResult.relationships.flatMap(
    (relationship) =>
      relationship.preformatted && relationship.sourceLineIds
        ? [new Set(relationship.sourceLineIds)]
        : [],
  )
  regionResult.lineBoundaryDecisions =
    regionResult.lineBoundaryDecisions.filter(
      (decision) =>
        !preformattedLineSets.some(
          (lineIds) =>
            lineIds.has(decision.fromLineId) && lineIds.has(decision.toLineId),
        ),
    )
  throwIfPdfReconstructionAborted(signal)
  onProgress?.({
    phase: 'asset-packaging',
    completed: 0,
    total: 0,
    message: 'Binding validated visual assets to their semantic objects…',
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
  onProgress?.({
    phase: 'reading-order',
    completed: 0,
    total: 0,
    message: 'Reconstructing logical prose and legal float boundaries…',
  })
  const canonicalHyphenBoundaryDecisions: PdfCanonicalHyphenBoundaryDecision[] =
    []
  const sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[] =
    []
  const blocks = await blocksFromRegions(
    orderedRegions,
    regionResult.regions,
    visualResult.consumedRegionIds,
    bibliographyRegionIds,
    new Map(
      visualResult.relationships.flatMap((relationship) => {
        if (relationship.kind !== 'equation') return []
        const matchedSourceCaption =
          relationship.status === 'matched' &&
          relationship.sourceRegionIds.includes(relationship.captionRegionId) &&
          (relationship.altTextSource === 'source-text' ||
            relationship.equationGeometryTranscript !== undefined ||
            relationship.evidence.includes('source-text-transcript-unresolved'))
        return matchedSourceCaption
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
    publicationMetadata.language,
    diagnostics,
    canonicalHyphenBoundaryDecisions,
    sourceSemanticFlowBoundaryDecisions,
    citationLedRegionIds,
    onProgress,
    signal,
  )
  onProgress?.({
    phase: 'reading-order',
    completed: 0,
    total: 0,
    message: 'Resolving front matter and cross-page prose ownership…',
  })
  await yieldPdfReconstructionTask(signal)
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
      appendBlockContinuation(
        canonicalTitleBlock,
        continuation,
        undefined,
        null,
        sourceSemanticFlowBoundaryDecisions,
      )
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
  onProgress?.({
    phase: 'reading-order',
    completed: 0,
    total: 0,
    message: 'Joining proven page and column continuations around floats…',
  })
  coalesceProvedInlineStackedParagraphs(
    canonicalBlocks,
    visualResult.relationships,
    regionResult.lineBoundaryDecisions,
    sourceSemanticFlowBoundaryDecisions,
  )
  await mergeProseContinuations(canonicalBlocks, {
    ownedFloatCaptionRegionIds: new Set(
      visualResult.relationships.flatMap((relationship) =>
        relationship.status === 'matched' && relationship.kind !== 'equation'
          ? [relationship.captionRegionId]
          : [],
      ),
    ),
    hardHyphenLexicon: inlineHardHyphenLexicon(sourceRegionLines),
    unhyphenatedLexicon: inlineUnhyphenatedLexicon(sourceRegionLines),
    language: publicationMetadata.language,
    diagnostics,
    canonicalFloatScopes,
    canonicalHyphenBoundaryDecisions,
    sourceSemanticFlowBoundaryDecisions,
  })
  await yieldPdfReconstructionTask(signal)
  noteNodeIds(blocks)
  for (const [index, block] of blocks.entries()) {
    block.nodeId ??= nodeId(index, block.type, block.text)
  }
  const citationRelationships = buildCitationRelationships(
    markerClassifications,
    canonicalBlocks,
    regionMap,
    regionResult.lineBoundaryDecisions,
  )
  onProgress?.({
    phase: 'reading-order',
    completed: 0,
    total: 0,
    message: 'Resolving citations, notes, and stable semantic targets…',
  })
  await yieldPdfReconstructionTask(signal)
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
    frontMatter.affiliations.flatMap((affiliation) => {
      const label = affiliation.match(
        /^\s*([\d*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+)(?=\s|\p{L})/u,
      )?.[1]
      if (!label) return []
      const numberedLabel = label.match(/^[\d⁰¹²³⁴⁵⁶⁷⁸⁹]+/u)?.[0]
      return numberedLabel && numberedLabel !== label
        ? [label, numberedLabel]
        : [label]
    }),
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
  onProgress?.({
    phase: 'reading-order',
    completed: 0,
    total: 0,
    message: 'Validating every internal hyperlink against canonical targets…',
  })
  const hyperlinkResolution = resolveCanonicalHyperlinkObligations({
    blocks: canonicalBlocks,
    annotations: embeddedLinks,
    lineBoundaryDecisions: regionResult.lineBoundaryDecisions,
    canonicalInternalSurfaces: [
      ...canonicalCitationHyperlinkSurfaces(
        citationRelationships,
        canonicalBlocks,
      ),
      ...canonicalNoteHyperlinkSurfaces(noteRelationships, references),
    ],
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
  await yieldPdfReconstructionTask(signal)
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
  for (const [
    relationshipIndex,
    relationship,
  ] of citationRelationships.entries()) {
    if (
      relationshipIndex > 0 &&
      relationshipIndex % PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE === 0
    ) {
      await yieldPdfReconstructionTask(signal)
    }
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
  onProgress?.({
    phase: 'reading-order',
    completed: 0,
    total: 0,
    message: 'Resolving scholarly object references and exact inline anchors…',
  })
  await yieldPdfReconstructionTask(signal)
  for (const [
    relationshipIndex,
    relationship,
  ] of crossReferenceRelationships.entries()) {
    if (
      relationshipIndex > 0 &&
      relationshipIndex % PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE === 0
    ) {
      await yieldPdfReconstructionTask(signal)
    }
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
  let nodes = await mapPdfReconstructionInBatches<RegionBlock, ResearchNode>(
    canonicalBlocks,
    (block, index) => {
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
    },
    (completed, total) =>
      onProgress?.({
        phase: 'reading-order',
        completed,
        total,
        message: `Materializing accessible canonical nodes ${completed} of ${total}…`,
      }),
    signal,
  )

  const visualNodeInsertions = new Map<string, ResearchNode[]>()
  const trailingVisualNodes: ResearchNode[] = []
  const canonicalNodeIds = new Set(nodes.map((node) => node.id))
  for (const [
    relationshipIndex,
    relationship,
  ] of visualResult.relationships.entries()) {
    if (
      relationshipIndex > 0 &&
      relationshipIndex % PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE === 0
    ) {
      onProgress?.({
        phase: 'asset-packaging',
        completed: relationshipIndex,
        total: visualResult.relationships.length,
        message: `Binding canonical visual assets ${relationshipIndex} of ${visualResult.relationships.length}…`,
      })
      await yieldPdfReconstructionTask(signal)
    }
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
    const sourceInlineMapping =
      !table && sourceText
        ? canonicalVisualSourceInlineMapping({
            relationship,
            nodeId: draft.id,
            regions: regionResult.regions,
            lineBoundaryDecisions: regionResult.lineBoundaryDecisions,
          })
        : { runs: [], ledger: { expected: 0, mapped: 0 } }
    inlineSpanLedger.expected += sourceInlineMapping.ledger.expected
    inlineSpanLedger.mapped += sourceInlineMapping.ledger.mapped
    const citationInlineRuns = textOwner
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
    const inlineRuns = [
      ...sourceInlineMapping.runs,
      ...citationInlineRuns,
    ].sort(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        Number(Boolean(left.relationshipId)) -
          Number(Boolean(right.relationshipId)),
    )
    const node: ResearchNode = materializeCanonicalVisualNode({
      relationship,
      id: draft.id,
      captionNodeId: draft.captionBlock.nodeId,
      source: draft.source,
      table,
      sourceText,
      inlineRuns,
    })
    const relationshipSourceRegions = relationship.sourceRegionIds
      .map((regionId) => regionMap.get(regionId))
      .filter((region): region is PdfPageRegion => region !== undefined)
    provenance[draft.id] = {
      confidence: relationship.confidence,
      pages: [...new Set(relationship.sourceBoxes.map((box) => box.page))],
      regionIds: [...relationship.sourceRegionIds],
      boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
      links: embeddedLinks.filter(
        (link) =>
          link.box !== null &&
          relationshipSourceRegions.some((region) =>
            region.lines.some((line) =>
              line.runs.some(
                (run) => link.box !== null && boxesOverlap(link.box, run),
              ),
            ),
          ),
      ),
    }
    if (canonicalNodeIds.has(draft.captionBlock.nodeId)) {
      const insertions =
        visualNodeInsertions.get(draft.captionBlock.nodeId) ?? []
      insertions.push(node)
      visualNodeInsertions.set(draft.captionBlock.nodeId, insertions)
    } else {
      trailingVisualNodes.push(node)
    }
  }
  nodes = [
    ...nodes.flatMap((node) => [
      ...(visualNodeInsertions.get(node.id) ?? []),
      node,
    ]),
    ...trailingVisualNodes,
  ]

  onProgress?.({
    phase: 'asset-packaging',
    completed: visualResult.relationships.length,
    total: visualResult.relationships.length,
    message: 'Placing atomic visual and note objects at legal boundaries…',
  })
  await yieldPdfReconstructionTask(signal)
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
    regions: regionResult.regions,
    pages,
  })

  onProgress?.({
    phase: 'validating',
    completed: 0,
    total: 1,
    message: 'Running fail-closed reconstruction and link validation…',
    checkpoint: 'quality-conservation',
  })
  await yieldPdfReconstructionTask(signal)
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
    sourceSemanticFlowBoundaryDecisions,
    sourceSemanticFlowBoundaryDecisionCount:
      sourceSemanticFlowBoundaryDecisions.length,
    canonicalHyphenBoundaryDecisions,
    canonicalHyphenBoundaryDecisionCount:
      canonicalHyphenBoundaryDecisions.length,
    unresolvedCorruptingJoinCount:
      classifiedLineBoundaries.unresolvedCorruptingJoinCount,
    structurallyConsumedLineBoundaryCount:
      classifiedLineBoundaries.structurallyConsumedLineBoundaryCount,
    inlineSpanLedger,
    hyperlinkLedger: hyperlinkResolution.ledger,
    canonicalFloatScopes,
    furnitureExcludedRunCount: regionResult.furnitureExcludedRunCount,
    furnitureExcludedTextCharacters:
      regionResult.furnitureExcludedTextCharacters,
    furnitureContaminationCount: regionResult.regions.reduce(
      (count, region) =>
        count + (region.furniture && region.includedInReadingOrder ? 1 : 0),
      0,
    ),
  })
  throwIfPdfReconstructionAborted(signal)
  onProgress?.({
    phase: 'validating',
    completed: 1,
    total: 1,
    message: 'Completed fail-closed reconstruction and link validation.',
    checkpoint: 'quality-complete',
  })
  await yieldPdfReconstructionTask(signal)

  return {
    source: {
      fileName,
      byteLength,
      sha256: sourceHash,
      pageCount: pages.length,
      localOnly: !visualResult.remoteTableCandidateUsed,
    },
    paper,
    pages,
    regions: regionResult.regions,
    lineBoundaryDecisions: classifiedLineBoundaries.decisions,
    sourceSemanticFlowBoundaryDecisions,
    sourceSemanticFlowBoundaryDecisionCount:
      sourceSemanticFlowBoundaryDecisions.length,
    canonicalHyphenBoundaryDecisions,
    canonicalHyphenBoundaryDecisionCount:
      canonicalHyphenBoundaryDecisions.length,
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
    ...(tableCandidateProvider
      ? { tableCandidateReceipts: visualResult.tableCandidateReceipts ?? [] }
      : {}),
    semanticSignals: assessment.semanticSignals,
    completeness: assessment.completeness,
    readiness: assessment.readiness,
  }
}
