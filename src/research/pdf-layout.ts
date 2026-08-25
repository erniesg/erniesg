import type { ResearchNode, ResearchPaper } from './schema'
import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfCanonicalHyphenBoundaryDecision,
  PdfCitationRelationship,
  PdfImportProgress,
  PdfLineBoundaryDecision,
  PdfNoteMarkerClassification,
  PdfNoteRelationship,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReconstruction,
  PdfSourceSemanticFlowBoundaryDecision,
  PdfSourceRun,
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
import {
  MAX_CITATION_TARGETS_PER_RELATIONSHIP,
  parsePdfCitationSurface,
} from './pdf-citation-surface'
import {
  classifyPdfNoteMarkers,
  pdfAlternateAuthorYearKeyFromBoundary,
  pdfAuthorYearKey,
  pdfBibliographyAuthorYearKey,
  pdfBibliographyFirstAuthorSurname,
  PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
  splitPdfCompoundAffiliationNote,
} from './pdf-note-classifier'
import { matchPdfNotes } from './pdf-note-matching'
export { PDF_NOTE_RELATIONSHIP_THRESHOLD } from './pdf-note-matching'
import {
  inlineHardHyphenLexicon,
  inlineUnhyphenatedLexicon,
  replayPdfRegionLineRanges,
} from './pdf-lines'
import { exactSourceRunRanges } from './pdf-source-run-ranges'
import {
  boxesOverlap,
  canonicalVisualSourceInlineMapping,
  canonicalVisualSourceTranscript,
  canonicalVisualTextOwner,
  exactVisualCanonicalRangeForSource,
  materializeCanonicalVisualNode,
  runVerticalAlign,
} from './pdf-visual-source-mapping'
import {
  emphasizedLineShare,
  fontNameIndicatesEmphasizedFace,
  residualPdfRegionFragmentsAfterLineConsumption,
  sourceStyledOrdinalSmallCapsHeading,
  sourceStyledStandaloneBoundaryHeading,
  splitLeadingStyledHeadingRegion,
} from './pdf-region-fragments'
import type { PdfResidualRegionFragment } from './pdf-region-fragments'
import {
  canonicalTableHyperlinkOccurrences,
  canonicalTableWithApprovedHyperlinks,
  canonicalTableWithSemanticInlineRuns,
  exactCanonicalNoteReferenceAnchor,
  exactCanonicalRangeForSource,
} from './pdf-canonical-source-anchors'
import {
  resolveCanonicalHyperlinkObligations,
  type CanonicalInternalHyperlinkSurface,
} from './pdf-canonical-hyperlinks'
export {
  buildPdfLinkSourceAnchorLedger,
  resolveCanonicalHyperlinkObligations,
} from './pdf-canonical-hyperlinks'
import { sourceEvidence, sourceInlineRuns } from './pdf-source-inline-evidence'
import {
  canonicalVisualDraft,
  placeMatchedCanonicalNotes,
  sameSourceBox,
  type CanonicalVisualDraft,
} from './pdf-canonical-node-composition'
export {
  canonicalVisualSourceInlineMapping,
  canonicalVisualSourceTranscript,
  materializeCanonicalVisualNode,
} from './pdf-visual-source-mapping'
export {
  residualPdfRegionAfterLineConsumption,
  residualPdfRegionFragmentsAfterLineConsumption,
} from './pdf-region-fragments'
export type { PdfResidualRegionFragment } from './pdf-region-fragments'
export {
  canonicalHyperlinkOccurrencesForTable,
  canonicalTableWithApprovedHyperlinks,
  canonicalTableWithSemanticInlineRuns,
} from './pdf-canonical-source-anchors'
export {
  retainUniqueMonotoneSourceRunAssignment,
  retainUniqueSourceRunAssignmentWithAliases,
  sourceRunBoundaryNormalizationAliasText,
} from './pdf-source-run-ranges'
import {
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE,
  PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE,
  resolvePdfHyphenBoundary,
  type PdfHyphenBoundaryProof,
} from './pdf-hyphenation'
import {
  pdfPublicationMetadata,
  rtlLanguage,
  validDate,
  type PdfDocumentMetadata,
} from './pdf-publication-metadata'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import { orderCanonicalVisualPairs } from './pdf-visual-order'
export { orderCanonicalVisualPairs } from './pdf-visual-order'
import {
  normalizePdfLinkAnnotations,
  resolveRegisteredPdfLinkedTokenContinuity,
  type PdfCanonicalInternalLinkTarget,
} from './pdf-links'
import {
  reconstructPdfVisuals,
  type PdfFigureRasterizer,
} from './pdf-visuals'
import type { TableCandidateProvider } from './table-candidate-provider'
export { visualCanonicalNodeId } from './pdf-visuals'
import {
  canonicalPdfSourceSemanticFlowEvidence,
  PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_COLUMN_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_CROSS_PAGE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_SPACE_WHITESPACE_EVIDENCE,
  pdfBodySourceOrderExtremaByPage,
  type PdfBodySourceOrderExtremum,
  pdfSourceColumnFlowJoinOutcome,
  pdfSourceColumnFlowStartsWithCjkNumericContinuation,
  pdfSourceFragmentId,
  pdfSourceSemanticFlowBoundaryDecisionId,
  pdfSourceSemanticFlowRunSha256,
  normalizedNoteLabel,
  noteLabelFromText,
  reconstructPageRegions,
} from './pdf-regions'
export type { PdfDocumentMetadata } from './pdf-publication-metadata'
export {
  captionProvenanceEnvelope,
  placeMatchedCanonicalNotes,
} from './pdf-canonical-node-composition'

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
    | 'citation'
    | 'cross-reference'
    | 'affiliation-marker'
    | 'bibliography-entry'
    | 'note-reference'
  targetIds?: string[]
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

type SourceMarkupShape = {
  heading: boolean
  emphasis: boolean
  template: boolean
  orderedList: boolean
}

function sourceMarkupShape(value: string): SourceMarkupShape {
  const trimmed = value.trim()
  return {
    heading: /^#{1,6}\s+/u.test(trimmed),
    emphasis: /^(?:\*\*(?=\S)[\s\S]*\*\*|__(?=\S)[\s\S]*__)$/u.test(trimmed),
    template: /^\{[A-Za-z_][A-Za-z0-9_.-]*\}$/u.test(trimmed),
    orderedList:
      /^(?:(?:\d+(?:\.\d+){0,3})[.)]|\(\s*\d{1,3}\s*\)|\[\s*\d{1,4}\s*\])\s+\S/u.test(
        trimmed,
      ),
  }
}

function orderedMarkerHasWithinBlockHangingIndent(
  block: RegionBlock,
  marker: NonNullable<ReturnType<typeof parsedOrderedListMarker>>,
) {
  const visibleLines = block.region.lines.filter((line) => line.text.trim())
  if (visibleLines.length < 2) return false
  const firstLine = visibleLines[0]
  const continuationLine = visibleLines[1]
  const firstLineRuns = firstLine.runs.filter((run) => run.text.trim())
  const continuationRuns = continuationLine.runs.filter((run) =>
    run.text.trim(),
  )
  if (firstLineRuns.length === 0 || continuationRuns.length === 0) {
    return false
  }

  const firstLineMarker = parsedOrderedListMarker(firstLine.text)
  if (
    !firstLineMarker ||
    firstLineMarker.markerText !== marker.markerText ||
    firstLineMarker.itemText.length === 0
  ) {
    return false
  }
  const markerRun = firstLineRuns[0]
  const markerRunText = markerRun.text.trimStart()
  if (!markerRunText.startsWith(marker.markerText)) return false
  const markerStartX = markerRun.x
  const contentStartX =
    markerRunText === marker.markerText && firstLineRuns.length > 1
      ? firstLineRuns[1].x
      : markerRun.x +
        markerRun.width *
          (firstLineMarker.contentStart /
            Math.max(Array.from(markerRun.text).length, 1))
  const continuationStartX = Math.min(...continuationRuns.map((run) => run.x))
  const verticalGap =
    continuationLine.box.y - (firstLine.box.y + firstLine.box.height)
  const fontRatio =
    Math.max(firstLine.fontSize, continuationLine.fontSize) /
    Math.max(1, Math.min(firstLine.fontSize, continuationLine.fontSize))
  return (
    contentStartX - markerStartX >= 0.012 &&
    Math.abs(continuationStartX - contentStartX) <= 0.012 &&
    verticalGap >= -0.004 &&
    verticalGap <=
      Math.max(
        0.03,
        Math.max(firstLine.box.height, continuationLine.box.height) * 2,
      ) &&
    fontRatio <= 1.12
  )
}

function orderedMarkerHasIndependentEvidence(
  blockIndex: number,
  blocks: readonly RegionBlock[],
  marker: NonNullable<ReturnType<typeof parsedOrderedListMarker>>,
  bodySize: number,
) {
  const block = blocks[blockIndex]
  if (!block) return false
  const visibleRuns = block.region.lines.flatMap((line) =>
    line.runs.filter((run) => run.text.trim()),
  )
  const firstLine = block.region.lines.find((line) => line.text.trim())
  const firstLineRuns = firstLine?.runs.filter((run) => run.text.trim()) ?? []
  const markerRunSeparated = Boolean(
    firstLineRuns.length > 1 &&
    firstLineRuns[0].text.trim() === marker.markerText,
  )
  const withinBlockHangingIndent = orderedMarkerHasWithinBlockHangingIndent(
    block,
    marker,
  )
  const largestFont = Math.max(
    ...block.region.lines.map((line) => line.fontSize),
    bodySize,
  )
  const emphasizedShare =
    visibleRuns.reduce(
      (total, run) =>
        total +
        (run.bold || fontNameIndicatesEmphasizedFace(run.fontName)
          ? run.text.trim().length
          : 0),
      0,
    ) /
    Math.max(
      1,
      visibleRuns.reduce((total, run) => total + run.text.trim().length, 0),
    )
  if (
    markerRunSeparated ||
    withinBlockHangingIndent ||
    largestFont >= bodySize * 1.12 ||
    emphasizedShare >= 0.6
  ) {
    return true
  }

  const preceding = blocks[blockIndex - 1]
  if (preceding?.type === 'paragraph' && preceding.list?.ordered) {
    return true
  }
  if (
    preceding?.type === 'paragraph' &&
    /:\s*$/u.test(preceding.text.trimEnd()) &&
    block.region.box.x > preceding.region.box.x + 0.012
  ) {
    return true
  }
  if (
    preceding?.type === 'paragraph' &&
    block.region.page >= preceding.region.page &&
    block.region.box.x >= preceding.region.box.x + 0.05
  ) {
    return true
  }

  return blocks.some((candidate, candidateIndex) => {
    if (candidateIndex === blockIndex || candidate.type !== 'paragraph') {
      return false
    }
    const parsedPeer = parsedOrderedListMarker(candidate.text)
    const peer =
      parsedPeer ??
      (candidate.list?.ordered &&
      candidate.list.markerText &&
      candidate.list.ordinal !== undefined
        ? {
            markerText: candidate.list.markerText,
            markerStyle: candidate.list.markerStyle,
            ordinal: candidate.list.ordinal,
          }
        : null)
    if (!peer) return false
    const samePage = candidate.region.page === block.region.page
    const adjacentPage =
      candidate.region.page + 1 === block.region.page &&
      candidate.region.column === block.region.column &&
      Math.abs(candidate.region.box.x - block.region.box.x) <= 0.05
    if (!samePage && !adjacentPage) return false
    const sameStyle = peer.markerStyle === marker.markerStyle
    const ordinalSequence =
      sameStyle &&
      Math.abs(peer.ordinal - marker.ordinal) === 1 &&
      (adjacentPage ||
        (candidate.region.column === block.region.column &&
          Math.abs(candidate.region.box.x - block.region.box.x) <= 0.05 &&
          Math.abs(candidate.region.box.y - block.region.box.y) <= 0.2))
    const oppositeColumnRow =
      candidate.region.column !== block.region.column &&
      Math.abs(candidate.region.box.y - block.region.box.y) <= 0.035
    const nestedGeometry =
      candidate.region.column === block.region.column &&
      candidate.region.box.x > block.region.box.x + 0.012 &&
      Math.abs(candidate.region.box.y - block.region.box.y) <= 0.12
    return ordinalSequence || oppositeColumnRow || nestedGeometry
  })
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
  bodySourceOrderExtremaByPage: ReadonlyMap<
    number,
    PdfBodySourceOrderExtremum
  > = new Map(),
): SourceSemanticFlowBoundaryCandidate | null {
  const crossPage = topology === 'cross-page-column'
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
  // Across a page break the two indexes belong to different per-page sequences,
  // so adjacency is proved by extremity instead: the tail is the last body item
  // its page paints and the head is the first body item the next page paints.
  const crossPageSourceAdjacency = Boolean(
    crossPage &&
    to.run.page === from.run.page + 1 &&
    bodySourceOrderExtremaByPage.get(from.run.page)?.last ===
      maximumFromSequence &&
    bodySourceOrderExtremaByPage.get(to.run.page)?.first === minimumToSequence,
  )
  const exactSourceAdjacency = crossPage
    ? crossPageSourceAdjacency
    : minimumToSequence === maximumFromSequence + 1 ||
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
    (crossPage
      ? to.run.page !== from.run.page + 1
      : from.run.page !== to.run.page) ||
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
    (topology !== 'same-page-column' &&
      !crossPage &&
      baselineGap >
        Math.max(0.06, Math.max(fromMetrics.height, toMetrics.height) * 4))
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
  const noSpaceColumnFlowTransition =
    (topology === 'same-page-column' || crossPage) &&
    outcome === 'no-space' &&
    to.run.sourceWhitespaceBefore !== 'pdf-text-item'
  if (
    (outcome === 'no-space' &&
      !exactStackedPunctuationTransition &&
      !noSpaceColumnFlowTransition) ||
    (outcome === 'space' && exactStackedPunctuationTransition)
  ) {
    return null
  }
  const evidence = canonicalPdfSourceSemanticFlowEvidence(
    crossPage
      ? PDF_SOURCE_SEMANTIC_FLOW_CROSS_PAGE_EVIDENCE
      : topology === 'same-page-column'
        ? PDF_SOURCE_SEMANTIC_FLOW_COLUMN_EVIDENCE
        : exactStackedPunctuationTransition
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
  bodySourceOrderExtremaByPage: ReadonlyMap<
    number,
    PdfBodySourceOrderExtremum
  > = new Map(),
): PdfSourceSemanticFlowBoundaryDecision | null {
  const decision = sourceSemanticFlowBoundaryCandidate(
    target,
    continuation,
    outcome,
    topology,
    bodySourceOrderExtremaByPage,
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
  bodySourceOrderExtremaByPage: ReadonlyMap<
    number,
    PdfBodySourceOrderExtremum
  > = new Map(),
  requiredSemanticFlowDecision: PdfSourceSemanticFlowBoundaryDecision | null = null,
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
    requestedTopology !== 'cross-page-column' &&
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
    requestedTopology === 'cross-page-column'
      ? 'cross-page-column'
      : semanticFlowOutcome === 'discretionary-hyphen-delete' ||
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
  const recordableTopology =
    inferredTopology === 'inline-stacked-fragment' ||
    inferredTopology === 'lexical-hyphen' ||
    inferredTopology === 'same-page-column' ||
    inferredTopology === 'cross-page-column'
      ? inferredTopology
      : null
  const derivedSemanticFlowDecision =
    semanticDeletionDecision ??
    (recordableTopology &&
    semanticFlowOutcome !== 'unresolved' &&
    (recordableTopology === 'same-page-column' ||
    recordableTopology === 'cross-page-column'
      ? recordableTopology === 'cross-page-column' ||
        semanticFlowOutcome === 'space' ||
        semanticFlowOutcome === 'no-space'
      : semanticFlowOutcome !== 'space'
        ? recordableTopology === 'inline-stacked-fragment' ||
          recordableTopology === 'lexical-hyphen'
        : false)
      ? sourceSemanticFlowBoundaryDecision(
          target,
          continuation,
          semanticFlowOutcome,
          recordableTopology,
          bodySourceOrderExtremaByPage,
        )
      : null)
  const requiredBoundaryAlreadyExists =
    requiredSemanticFlowDecision !== null &&
    sourceSemanticFlowBoundaryDecisions.some(
      (decision) =>
        decision.from.regionId === requiredSemanticFlowDecision.from.regionId &&
        decision.from.lineId === requiredSemanticFlowDecision.from.lineId &&
        decision.to.regionId === requiredSemanticFlowDecision.to.regionId &&
        decision.to.lineId === requiredSemanticFlowDecision.to.lineId,
    )
  if (
    requiredSemanticFlowDecision !== null &&
    (derivedSemanticFlowDecision?.id !== requiredSemanticFlowDecision.id ||
      requiredBoundaryAlreadyExists)
  ) {
    return false
  }
  const semanticFlowDecision =
    requiredSemanticFlowDecision ?? derivedSemanticFlowDecision
  if (deletionApplied && deletionDecision) {
    hyphenDeletion!.decisions.push(deletionDecision)
  }
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
  return true
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

const PDF_SENTENCE_END_WITH_CLOSING =
  /\p{Sentence_Terminal}(?:["'’”\p{Close_Punctuation}\p{Final_Punctuation}]*)$/u

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

// A lowercase leading letter is the cased-script signal that a block continues
// an unfinished sentence. Uncased scripts have no such signal: Han, Arabic and
// Hebrew letters are all `\p{Lo}`, so `\p{Ll}` is never true for them and this
// evidence is simply unavailable.
const PDF_UNMARKED_CONTINUATION_LEAD = /^\p{Ll}/u
// Admitting `\p{Lo}` restores the signal for uncased scripts, but it admits
// *every* uncased-script block, which is far weaker evidence than a lowercase
// letter is in a cased script. It is therefore opt-in per call site rather
// than shared: source-proven column flow independently establishes that the
// two blocks are the same column of the same page pair, which is the
// corroboration that makes the weaker leading-character test safe to use.
const PDF_UNMARKED_CONTINUATION_LEAD_WITH_UNCASED = /^(?:\p{Ll}|\p{Lo})/u

function likelyUnmarkedCrossPageContinuation(
  target: RegionBlock,
  continuation: RegionBlock,
  { admitUncasedScripts = false }: { admitUncasedScripts?: boolean } = {},
) {
  const previousText = target.text.trimEnd()
  const continuationText = continuation.text.trimStart()
  const leadingLetter = admitUncasedScripts
    ? PDF_UNMARKED_CONTINUATION_LEAD_WITH_UNCASED
    : PDF_UNMARKED_CONTINUATION_LEAD
  return Boolean(
    previousText &&
    continuationText &&
    !PDF_SENTENCE_END_WITH_CLOSING.test(previousText) &&
    (leadingLetter.test(continuationText) ||
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
    (/\b(?:a|an|the|of|for|from|with|without|among|between|over|under|by|than|approximately|about|around|nearly|roughly|exactly|includes?|including|contains?|containing|comprises?|comprising)\s*$/iu.test(
      previousText.trimEnd(),
    ) &&
      /^\d+(?:[,.]\d+)*(?:\s*[%×x+-]\s*\d+(?:[,.]\d+)*)?\s+\p{L}/u.test(
        continuationText.trimStart(),
      )) ||
    pdfSourceColumnFlowStartsWithCjkNumericContinuation(continuationText)
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

function sourceColumnFlowJoin(
  continuation: RegionBlock,
  language: string | null,
) {
  const continuationHeadLine = blockSourceSegments(
    continuation,
  )[0]?.region.lines.find((line) => line.text.trim())
  const continuationHeadRun = continuationHeadLine?.runs
    .filter((run) => run.text.trim() && run.sourceSequenceIndex !== undefined)
    .reduce<PdfSourceRun | undefined>(
      (candidate, run) =>
        !candidate || run.sourceSequenceIndex! < candidate.sourceSequenceIndex!
          ? run
          : candidate,
      undefined,
    )
  return continuationHeadRun
    ? pdfSourceColumnFlowJoinOutcome(
        language,
        continuation.text.trimStart(),
        continuationHeadRun,
      )
    : null
}

function sourceProvenSamePageColumnFlowBoundary(
  target: RegionBlock,
  continuation: RegionBlock,
  language: string | null,
  baseDirection: ResearchPaper['baseDirection'] | null,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetTailLine = targetTailSegment?.region.lines
    .filter((line) => line.text.trim())
    .at(-1)
  const continuationHeadLine = continuationHeadSegment?.region.lines.find(
    (line) => line.text.trim(),
  )
  const rtl =
    baseDirection === 'rtl' ||
    (baseDirection !== 'ltr' &&
      baseDirection !== 'unknown' &&
      (language ? rtlLanguage(language) : false))
  const sourceColumnsMatch = rtl
    ? targetTailSegment?.region.column === 'right' &&
      continuationHeadSegment?.region.column === 'left'
    : targetTailSegment?.region.column === 'left' &&
      continuationHeadSegment?.region.column === 'right'
  const sourceColumnsAreOrdered = rtl
    ? Boolean(
        targetTailLine &&
        continuationHeadLine &&
        continuationHeadLine.box.x + continuationHeadLine.box.width <=
          targetTailLine.box.x + 0.01,
      )
    : Boolean(
        targetTailLine &&
        continuationHeadLine &&
        targetTailLine.box.x + targetTailLine.box.width <=
          continuationHeadLine.box.x + 0.01,
      )
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    targetTailSegment.region.page !== continuationHeadSegment.region.page ||
    !sourceColumnsMatch ||
    targetTailLine.box.y + targetTailLine.box.height < 0.65 ||
    continuationHeadLine.box.y > 0.35 ||
    !sourceColumnsAreOrdered ||
    /[\p{L}\p{N}][-‐‑]$/u.test(target.text.trimEnd()) ||
    detachedCitationYearContinuation(target.text, continuation.text) ||
    // Source-proven column flow: the checks above have already established that
    // these two blocks are the same column of the same page, in reading order,
    // with no omitted source between them. That is what corroborates the weaker
    // uncased leading-character signal here.
    !likelyUnmarkedCrossPageContinuation(target, continuation, {
      admitUncasedScripts: true,
    }) ||
    hasOmittedSourceBetweenBlocks(target, continuation)
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
  const candidate = sourceSemanticFlowBoundaryCandidate(
    target,
    continuation,
    sourceColumnFlowJoin(continuation, language)?.outcome ?? 'space',
    'same-page-column',
  )
  return candidate !== null
}

const PDF_CROSS_PAGE_FLOW_TAIL_COLUMNS_LTR = new Set([
  'right',
  'single',
  'span',
])
const PDF_CROSS_PAGE_FLOW_HEAD_COLUMNS_LTR = new Set(['left', 'single', 'span'])

/**
 * A sentence that runs off the bottom of one page and resumes at the top of the
 * next.  Everything asserted here is readable from the source: the two blocks
 * are consecutive pages, the tail sits in the bottom band of the last column
 * and the head in the top band of the first, typography matches, and the
 * continuation carries language-agnostic unfinished-sentence evidence.  The
 * remaining proof — that only page furniture was painted between them — lives
 * in `sourceSemanticFlowBoundaryCandidate`, which needs the per-page body
 * source-order extrema to establish it.
 */
function sourceProvenCrossPageColumnFlowBoundary(
  target: RegionBlock,
  continuation: RegionBlock,
  language: string | null,
  baseDirection: ResearchPaper['baseDirection'] | null,
  bodySourceOrderExtremaByPage: ReadonlyMap<number, PdfBodySourceOrderExtremum>,
) {
  if (
    !sourceProvenCrossPageColumnGeometryBoundary(
      target,
      continuation,
      language,
      baseDirection,
    ) ||
    /[\p{L}\p{N}][-‐‑]$/u.test(target.text.trimEnd()) ||
    detachedCitationYearContinuation(target.text, continuation.text) ||
    !likelyUnmarkedCrossPageContinuation(target, continuation, {
      admitUncasedScripts: true,
    })
  ) {
    return false
  }
  return (
    sourceSemanticFlowBoundaryCandidate(
      target,
      continuation,
      sourceColumnFlowJoin(continuation, language)?.outcome ?? 'space',
      'cross-page-column',
      bodySourceOrderExtremaByPage,
    ) !== null
  )
}

function sourceProvenCrossPageColumnGeometryBoundary(
  target: RegionBlock,
  continuation: RegionBlock,
  language: string | null,
  baseDirection: ResearchPaper['baseDirection'] | null,
) {
  const targetTailSegment = blockSourceSegments(target).at(-1)
  const continuationHeadSegment = blockSourceSegments(continuation)[0]
  const targetTailLine = targetTailSegment?.region.lines
    .filter((line) => line.text.trim())
    .at(-1)
  const continuationHeadLine = continuationHeadSegment?.region.lines.find(
    (line) => line.text.trim(),
  )
  if (
    !targetTailSegment ||
    !continuationHeadSegment ||
    !targetTailLine ||
    !continuationHeadLine ||
    continuationHeadSegment.region.page !== targetTailSegment.region.page + 1
  ) {
    return false
  }
  const rtl =
    baseDirection === 'rtl' ||
    (baseDirection !== 'ltr' &&
      baseDirection !== 'unknown' &&
      (language ? rtlLanguage(language) : false))
  const tailColumns = rtl
    ? PDF_CROSS_PAGE_FLOW_HEAD_COLUMNS_LTR
    : PDF_CROSS_PAGE_FLOW_TAIL_COLUMNS_LTR
  const headColumns = rtl
    ? PDF_CROSS_PAGE_FLOW_TAIL_COLUMNS_LTR
    : PDF_CROSS_PAGE_FLOW_HEAD_COLUMNS_LTR
  if (
    !tailColumns.has(targetTailSegment.region.column) ||
    !headColumns.has(continuationHeadSegment.region.column) ||
    targetTailLine.box.y + targetTailLine.box.height < 0.65 ||
    continuationHeadLine.box.y > 0.35
  ) {
    return false
  }
  const fontRatio =
    Math.max(targetTailLine.fontSize, continuationHeadLine.fontSize) /
    Math.max(
      1,
      Math.min(targetTailLine.fontSize, continuationHeadLine.fontSize),
    )
  return fontRatio <= 1.12
}

function sourceProvenSamePageParagraphBoundary(
  target: RegionBlock,
  continuation: RegionBlock,
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
  baseDirection: ResearchPaper['baseDirection'] | null,
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
  const sourceProvenColumnFlowBoundary = sourceProvenSamePageColumnFlowBoundary(
    target,
    continuation,
    language,
    baseDirection,
  )
  const sourceColumnFlowOutcome = sourceProvenColumnFlowBoundary
    ? (sourceColumnFlowJoin(continuation, language)?.outcome ?? 'space')
    : 'space'
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
    sourceColumnFlowOutcome,
    explicitFragmentFamilyBoundary
      ? 'inline-stacked-fragment'
      : runFragmentToSpanBoundary
        ? 'cross-gutter-to-span'
        : sourceAttestedCitationYearBoundary
          ? 'same-column-citation-year'
          : sourceProvenColumnFlowBoundary
            ? 'same-page-column'
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
      !runFragmentToSpanBoundary &&
      !sourceProvenColumnFlowBoundary) ||
    (!runFragmentToSpanBoundary &&
      !explicitFragmentFamilyBoundary &&
      !sourceAttestedHyphenBoundary &&
      !sourceAttestedCitationYearBoundary &&
      !sourceProvenColumnFlowBoundary) ||
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
  if (runFragmentToSpanBoundary || sourceProvenColumnFlowBoundary) return true
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
    baseDirection = null,
    diagnostics = [],
    canonicalFloatScopes = [],
    canonicalHyphenBoundaryDecisions = [],
    sourceSemanticFlowBoundaryDecisions = [],
    bodySourceOrderExtremaByPage = new Map(),
  }: {
    ownedFloatCaptionRegionIds?: ReadonlySet<string>
    hardHyphenLexicon?: ReadonlySet<string>
    unhyphenatedLexicon?: ReadonlySet<string>
    language?: string | null
    baseDirection?: ResearchPaper['baseDirection'] | null
    diagnostics?: ReconstructionDiagnostic[]
    canonicalFloatScopes?: CanonicalFloatScopeEvidence[]
    canonicalHyphenBoundaryDecisions?: PdfCanonicalHyphenBoundaryDecision[]
    sourceSemanticFlowBoundaryDecisions?: PdfSourceSemanticFlowBoundaryDecision[]
    bodySourceOrderExtremaByPage?: ReadonlyMap<
      number,
      PdfBodySourceOrderExtremum
    >
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
          baseDirection,
        )
      const sourceProvenSamePageColumnFlow =
        continuation?.type === 'paragraph' &&
        interveningOwnedCaptions.length === 0 &&
        sourceProvenSamePageColumnFlowBoundary(
          target,
          continuation,
          language,
          baseDirection,
        )
      const sourceProvenCrossPageColumnFlow =
        continuation?.type === 'paragraph' &&
        interveningOwnedCaptions.length === 0 &&
        sourceProvenCrossPageColumnFlowBoundary(
          target,
          continuation,
          language,
          baseDirection,
          bodySourceOrderExtremaByPage,
        )
      const sourceProvenCrossPageColumnGeometry =
        continuation?.type === 'paragraph' &&
        sourceProvenCrossPageColumnGeometryBoundary(
          target,
          continuation,
          language,
          baseDirection,
        )
      const samePageColumnFlowJoin =
        (sourceProvenSamePageColumnFlow || sourceProvenCrossPageColumnFlow) &&
        continuation?.type === 'paragraph'
          ? sourceColumnFlowJoin(continuation, language)
          : null
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
      const crossPageContinuation =
        continuation?.type === 'paragraph' && !samePageContinuation
      const crossPageHyphenVerdict =
        crossPageContinuation &&
        lowercaseHyphenContinuation &&
        hyphenJoin.hyphenBoundary
          ? sourceSemanticFlowHyphenVerdict(hyphenJoin.hyphenBoundary.proof)
          : 'unresolved'
      const crossPageSemanticFlowOutcome =
        crossPageContinuation && continuation?.type === 'paragraph'
          ? lowercaseHyphenContinuation && hyphenJoin.hyphenBoundary
            ? crossPageHyphenVerdict === 'remove'
              ? 'discretionary-hyphen-delete'
              : crossPageHyphenVerdict === 'preserve'
                ? 'hard-hyphen-retain'
                : null
            : (sourceColumnFlowJoin(continuation, language)?.outcome ?? 'space')
          : null
      const crossPageSemanticFlowDecision =
        crossPageContinuation &&
        continuation?.type === 'paragraph' &&
        sourceProvenCrossPageColumnGeometry &&
        crossPageSemanticFlowOutcome !== null &&
        (sourceProvenCrossPageColumnFlow ||
          sourceProvenFloatBoundary ||
          sourceProvenCitationBoundary ||
          (lowercaseHyphenContinuation && sourceProvenHyphenDecision))
          ? sourceSemanticFlowBoundaryDecision(
              target,
              continuation,
              crossPageSemanticFlowOutcome,
              'cross-page-column',
              bodySourceOrderExtremaByPage,
            )
          : null
      const sourceProvenCrossPageJoin = crossPageSemanticFlowDecision !== null
      if (
        continuation?.type !== 'paragraph' ||
        continuation.list ||
        (samePageContinuation && !sourceBoundaryProven) ||
        (crossPageContinuation && !sourceProvenCrossPageJoin) ||
        (crossesOwnedFloat && !sourceProvenFloatBoundary) ||
        (citationYearContinuation && !sourceProvenCitationBoundary) ||
        !sourceProvenHyphenDecision ||
        // Admit uncased scripts only when source-proven same-page column flow
        // actually holds, not merely when the guards above did not fire. Those
        // guards are conditional implications whose antecedents can all be
        // false at once: `(samePageContinuation && !sourceBoundaryProven)`
        // binds only on the same page, and `sourceProvenHyphenDecision` is
        // unconditionally true with no trailing hyphen. A cross-page pair with
        // no float, no citation year and no hyphen therefore satisfies all of
        // them vacuously, with zero source proof — and `\p{Lo}` would then
        // match unconditionally, because every Han block starts with one.
        (!likelyUnmarkedCrossPageContinuation(target, continuation, {
          admitUncasedScripts: sourceProvenSamePageColumnFlow,
        }) &&
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
      const appended = appendBlockContinuation(
        target,
        continuation,
        samePageColumnFlowJoin?.separator ?? hyphenJoin.separator,
        samePageColumnFlowJoin
          ? null
          : hyphenJoin.hyphenBoundary
            ? {
                context: 'canonical-flow-continuation',
                ...hyphenJoin.hyphenBoundary,
                decisions: canonicalHyphenBoundaryDecisions,
              }
            : null,
        sourceSemanticFlowBoundaryDecisions,
        crossPageContinuation
          ? 'cross-page-column'
          : citationYearContinuation
            ? target.region.column === continuation.region.column
              ? 'same-column-citation-year'
              : 'cross-column-citation-year'
            : sourceProvenSamePageColumnFlow
              ? 'same-page-column'
              : null,
        bodySourceOrderExtremaByPage,
        crossPageSemanticFlowDecision,
      )
      if (!appended) break
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
      const markup = sourceMarkupShape(region.text)
      const sourceMarkupHasIndependentEvidence =
        !Object.values(markup).some(Boolean) ||
        representativeFontSize >= bodySize * 1.12 ||
        emphasizedCharacters >= Math.max(1, visibleCharacters * 0.6) ||
        sourceStyledLetteredHeading ||
        sourceStyledNamedBoundaryHeading ||
        sequencedNumberedHeadingRegions.has(region) ||
        sequencedLetteredHeadingRegions.has(region)
      const heading =
        !probableFirstPageAuthorLine &&
        !appendixContentsEntry &&
        !probableTabularColumnHeader &&
        sourceMarkupHasIndependentEvidence &&
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
    if (
      ordered &&
      !orderedMarkerHasIndependentEvidence(
        blockIndex,
        blocks,
        ordered,
        bodySize,
      )
    ) {
      ordered = null
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
  const bibliographyTargets = new Map<string, string[]>()
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
      const targets = bibliographyTargets.get(label) ?? []
      if (!targets.includes(target)) targets.push(target)
      bibliographyTargets.set(label, targets)
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
    if (
      labels.length === 0 ||
      labels.length > MAX_CITATION_TARGETS_PER_RELATIONSHIP
    ) {
      return []
    }
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
      const status = missing
        ? 'unresolved'
        : ambiguous
          ? 'ambiguous'
          : 'matched'
      const targetNodeIds =
        status === 'matched' ? candidates.map((targets) => targets[0]) : []
      const candidateNodeIds = [...new Set(candidates.flat())]
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
          ...(status !== 'matched' && candidateNodeIds.length > 0
            ? { candidateNodeIds }
            : {}),
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
            ...(missing
              ? ['bibliography-author-year-target-missing']
              : ambiguous
                ? ['bibliography-author-year-target-ambiguous']
                : ['bibliography-author-year-key-unique']),
          ],
          sourceBoxes: [{ ...classification.sourceBox }],
        },
      ]
    }
    const candidates = labels.map(
      (label) => bibliographyTargets.get(label) ?? [],
    )
    const missing = candidates.some((targets) => targets.length === 0)
    const ambiguous = candidates.some((targets) => targets.length > 1)
    const status = missing ? 'unresolved' : ambiguous ? 'ambiguous' : 'matched'
    const targetNodeIds =
      status === 'matched' ? candidates.map((targets) => targets[0]) : []
    const candidateNodeIds = [...new Set(candidates.flat())]
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
        ...(status !== 'matched' && candidateNodeIds.length > 0
          ? { candidateNodeIds }
          : {}),
        targets,
        status,
        canonicalAnchor: null,
        confidence: classification.confidence,
        evidence: [
          ...classification.evidence,
          ...(status === 'matched'
            ? ['bibliography-label-target']
            : status === 'ambiguous'
              ? ['bibliography-label-target-ambiguous']
              : ['bibliography-label-target-missing']),
        ],
        sourceBoxes: [{ ...classification.sourceBox }],
      },
    ]
  })
}

type InlineMappingLedger = { expected: number; mapped: number }

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
    baseDirection: publicationMetadata.baseDirection,
    diagnostics,
    canonicalFloatScopes,
    canonicalHyphenBoundaryDecisions,
    sourceSemanticFlowBoundaryDecisions,
    bodySourceOrderExtremaByPage: pdfBodySourceOrderExtremaByPage(
      regionResult.regions,
      new Set(
        visualResult.relationships.flatMap((relationship) =>
          relationship.status === 'matched' && relationship.kind !== 'equation'
            ? [relationship.captionRegionId, ...relationship.sourceRegionIds]
            : [],
        ),
      ),
    ),
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
  for (const reference of references) {
    if (reference.canonicalAnchor !== null) continue
    const candidates = canonicalVisualTextOwners.flatMap((owner) => {
      const range = exactVisualCanonicalRangeForSource(
        owner,
        {
          referenceRegionId: reference.region.id,
          referenceStart: reference.start,
          referenceEnd: reference.end,
          sourceBoxes: [reference.classification.sourceBox],
        },
        regionMap,
      )
      return range ? [range] : []
    })
    if (candidates.length === 1) {
      reference.canonicalAnchor = { kind: 'node', ...candidates[0] }
    }
  }
  const noteRelationships = matchPdfNotes(blocks, references, diagnostics)
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
      if (
        !block.nodeId ||
        !['heading', 'paragraph', 'caption', 'footnote'].includes(block.type)
      ) {
        return []
      }
      const range = exactCanonicalRangeForSource(
        block,
        relationship.referenceRegionId,
        relationship.referenceStart,
        relationship.referenceEnd,
      )
      return range ? [{ nodeId: block.nodeId, ...range }] : []
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
    (candidate) => candidate.status !== 'matched',
  )) {
    const ambiguous = relationship.status === 'ambiguous'
    diagnostics.push({
      code: 'UNRESOLVED_CITATION_REFERENCE',
      severity: 'error',
      page: relationship.sourceBoxes[0]?.page,
      message: ambiguous
        ? `Citation marker ${relationship.id} retains multiple bibliography targets for review.`
        : `Citation marker ${relationship.id} has no complete bibliography-label target.`,
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
  const visualDefinitionEndsByRegionId = new Map<string, number>()
  for (const relationship of visualResult.relationships) {
    const captionRegion = relationship.captionRegionId
      ? regionMap.get(relationship.captionRegionId)
      : undefined
    if (!captionRegion) continue
    const definition = parsePdfScholarlyVisualLabel(captionRegion.text, {
      context: 'caption',
    })
    const canonical = parsePdfScholarlyVisualLabel(relationship.label, {
      context: 'reference',
    })
    if (
      definition?.status !== 'parsed' ||
      canonical?.status !== 'parsed' ||
      definition.kind !== canonical.kind ||
      definition.identifier !== canonical.identifier
    ) {
      continue
    }
    visualDefinitionEndsByRegionId.set(
      captionRegion.id,
      Math.max(
        visualDefinitionEndsByRegionId.get(captionRegion.id) ?? 0,
        definition.consumedEnd,
      ),
    )
  }
  for (const block of canonicalBlocks) {
    if (
      !['paragraph', 'caption', 'footnote'].includes(block.type) ||
      block.list?.numberingId === 'references'
    ) {
      continue
    }
    for (const segment of blockSourceSegments(block)) {
      const definitionEnd = visualDefinitionEndsByRegionId.get(
        segment.region.id,
      )
      crossReferenceRegions.set(
        segment.region.id,
        definitionEnd
          ? {
              ...segment.region,
              text:
                segment.region.text
                  .slice(0, definitionEnd)
                  .replace(/\S/gu, ' ') +
                segment.region.text.slice(definitionEnd),
            }
          : segment.region,
      )
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
        !['heading', 'paragraph', 'caption', 'footnote'].includes(block.type)
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
  for (const relationship of noteRelationships) {
    if (
      relationship.status !== 'ambiguous' &&
      relationship.status !== 'unresolved'
    ) {
      continue
    }
    const reference = references.find(
      (candidate) => candidate.id === relationship.id,
    )
    if (reference?.canonicalAnchor?.kind !== 'node') continue
    const values =
      semanticReferencesByRegion.get(relationship.referenceRegionId) ?? []
    values.push({
      id: relationship.id,
      start: relationship.referenceStart,
      end: relationship.referenceEnd,
      semanticRole: 'note-reference',
    })
    semanticReferencesByRegion.set(relationship.referenceRegionId, values)
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
      if (block.type === 'footnote') {
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
          ...(noteReferences.length > 0 ? { noteReferences } : {}),
          ...(inlineMapping.runs.length > 0
            ? { inlineRuns: inlineMapping.runs }
            : {}),
          relationships: { backlinks },
          source,
        }
      }
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
          ...(noteReferences.length > 0 ? { noteReferences } : {}),
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
    const visualNoteReferences = textOwner
      ? noteRelationships.flatMap((note) => {
          if (
            note.status !== 'matched' &&
            note.status !== 'ambiguous' &&
            note.status !== 'unresolved'
          ) {
            return []
          }
          const reference = referenceDrafts.get(note.id)
          const anchor = reference?.canonicalAnchor
          if (
            !reference ||
            anchor?.kind !== 'node' ||
            anchor.nodeId !== draft.id
          ) {
            return []
          }
          const exactSourceBoxes = exactSourceBoxesForCitationRange(
            reference.region,
            reference.start,
            reference.end,
            regionResult.lineBoundaryDecisions,
          )
          return [
            {
              id: note.id,
              label: note.label,
              target: note.targetNoteId,
              start: anchor.start,
              end: anchor.end,
              confidence: note.confidence,
              status: note.status,
              referenceRegionId: note.referenceRegionId,
              sourceBoxes:
                exactSourceBoxes.length > 0
                  ? exactSourceBoxes
                  : [reference.classification.sourceBox],
            },
          ]
        })
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
    const semanticTable =
      table && sourceText
        ? canonicalTableWithSemanticInlineRuns({
            table,
            sourceText,
            inlineRuns: citationInlineRuns,
            citationRelationships,
            noteReferences: visualNoteReferences,
          })
        : table
    if (semanticTable) {
      const projectedCitationIds = new Set(
        semanticTable.rows.flatMap((row) =>
          row.cells.flatMap((cell) =>
            (cell.inlineRuns ?? []).flatMap((run) =>
              run.semanticRole === 'citation' && run.relationshipId
                ? [run.relationshipId]
                : [],
            ),
          ),
        ),
      )
      for (const run of citationInlineRuns) {
        if (
          !run.relationshipId ||
          projectedCitationIds.has(run.relationshipId)
        ) {
          continue
        }
        const citation = citationRelationships.find(
          (candidate) => candidate.id === run.relationshipId,
        )
        if (citation?.status !== 'matched') continue
        citation.candidateNodeIds = [
          ...new Set([
            ...(citation.candidateNodeIds ?? []),
            ...citation.targetNodeIds,
          ]),
        ]
        citation.targetNodeIds = []
        citation.targets = []
        citation.canonicalAnchor = null
        citation.status = 'unresolved'
        citation.evidence.push('canonical-table-cell-anchor-non-unique')
        inlineSpanLedger.mapped = Math.max(0, inlineSpanLedger.mapped - 1)
        diagnostics.push({
          code: 'UNMAPPED_CITATION_ANCHOR',
          severity: 'error',
          page: citation.sourceBoxes[0]?.page,
          message: `Citation marker ${citation.id} could not be assigned to one source-backed table cell.`,
          sourceBoxes: citation.sourceBoxes,
          relationshipId: citation.id,
          target: {
            regionIds: [citation.referenceRegionId],
            markerId: citation.id,
          },
        })
      }
      semanticTable.rows.forEach((row, rowIndex) => {
        row.cells.forEach((cell, cellIndex) => {
          for (const run of cell.inlineRuns ?? []) {
            if (run.semanticRole !== 'citation' || !run.relationshipId) {
              continue
            }
            const citation = citationRelationships.find(
              (relationship) => relationship.id === run.relationshipId,
            )
            if (citation?.status !== 'matched') continue
            citation.canonicalAnchor = {
              nodeId: `${draft.id}:table:${cell.id ?? `${rowIndex}:${cellIndex}`}`,
              start: run.start,
              end: run.end,
            }
          }
        })
      })
      const projectedNoteIds = new Set(
        semanticTable.rows.flatMap((row) =>
          row.cells.flatMap((cell) => [
            ...(cell.noteReferences ?? []).map((reference) => reference.id),
            ...(cell.inlineRuns ?? []).flatMap((run) =>
              run.semanticRole === 'note-reference' && run.relationshipId
                ? [run.relationshipId]
                : [],
            ),
          ]),
        ),
      )
      for (const reference of visualNoteReferences) {
        if (
          reference.status !== 'matched' ||
          projectedNoteIds.has(reference.id)
        ) {
          continue
        }
        const note = noteRelationships.find(
          (candidate) => candidate.id === reference.id,
        )
        if (note?.status !== 'matched') continue
        note.status = 'unresolved'
        note.targetNoteId = null
        note.evidence.push('canonical-table-cell-anchor-non-unique')
        diagnostics.push({
          code: 'UNRESOLVED_NOTE_REFERENCE',
          severity: 'error',
          page: note.sourceBoxes[0]?.page,
          message: `Note marker ${note.id} could not be assigned to one source-backed table cell.`,
          sourceBoxes: note.sourceBoxes,
          relationshipId: note.id,
          target: {
            regionIds: [note.referenceRegionId],
            markerId: note.id,
          },
        })
      }
      semanticTable.rows.forEach((row, rowIndex) => {
        row.cells.forEach((cell, cellIndex) => {
          for (const reference of cell.noteReferences ?? []) {
            const note = noteRelationships.find(
              (relationship) => relationship.id === reference.id,
            )
            if (note?.status !== 'matched') continue
            note.canonicalAnchor = {
              kind: 'node',
              nodeId: `${draft.id}:table:${cell.id ?? `${rowIndex}:${cellIndex}`}`,
              start: reference.start,
              end: reference.end,
            }
          }
        })
      })
    }
    const node: ResearchNode = materializeCanonicalVisualNode({
      relationship,
      id: draft.id,
      captionNodeId: draft.captionBlock.nodeId,
      source: draft.source,
      table: semanticTable,
      sourceText,
      inlineRuns: table ? [] : inlineRuns,
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
  const matchedNoteRelationshipIds = new Set(
    noteRelationships
      .filter((relationship) => relationship.status === 'matched')
      .map((relationship) => relationship.id),
  )
  nodes = nodes.map((node) =>
    node.type === 'footnote'
      ? {
          ...node,
          relationships: {
            ...node.relationships,
            backlinks: node.relationships.backlinks.filter((backlink) =>
              matchedNoteRelationshipIds.has(backlink),
            ),
          },
        }
      : node,
  )

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
