import type { ResearchNode, ResearchPaper } from './schema'
import type {
  NodeSourceEvidence,
  PdfCanonicalHyphenBoundaryDecision,
  PdfCitationRelationship,
  PdfImportProgress,
  PdfLineBoundaryDecision,
  PdfNoteRelationship,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReconstruction,
  PdfSourceSemanticFlowBoundaryDecision,
  ReconstructionDiagnostic,
} from './import-types'
import { resolvePdfScholarlyCrossReferences } from './pdf-cross-references'
import {
  assessPdfCompleteness,
  classifyStructuralLineBoundaryDecisions,
  sourceSemanticFlowHyphenVerdict,
  type CanonicalFloatScopeEvidence,
} from './pdf-quality'
import {
  classifyPdfFrontMatter,
  inferredAuthors,
  normalizedAuthorName,
} from './pdf-front-matter-classification'
import {
  splitEmbeddedPublicationReference,
  splitFrontMatterAffiliationContact,
  splitLeadingFrontMatterAffiliationFromProse,
} from './pdf-front-matter-splitting'
import {
  detachedCitationYearContinuation,
  likelyUnmarkedCrossPageContinuation,
  scholarlyLabelFloatContinuation,
  sourceProvenCrossPageBoundary,
} from './pdf-continuation-evidence'
import {
  blockSourceSegments,
  synthesizeRecoveredBibliographyClassifications,
} from './pdf-list-markers'
export type { RecoveredBibliographyClassificationBlock } from './pdf-list-markers'
export { synthesizeRecoveredBibliographyClassifications } from './pdf-list-markers'
import {
  appendBlockContinuation,
  coalesceProvedInlineStackedParagraphs,
} from './pdf-paragraph-continuations'
import {
  captionBoundedTableInterruption,
  floatInterruptedHyphenJoin,
  recordAmbiguousCaptionBoundedTable,
  sourceColumnFlowJoin,
  sourceProvenCrossPageColumnFlowBoundary,
  sourceProvenCrossPageColumnGeometryBoundary,
  sourceProvenSamePageColumnBoundary,
  sourceProvenSamePageColumnFloatBoundary,
  sourceProvenSamePageColumnFlowBoundary,
  sourceProvenSamePageFloatTailBoundary,
  sourceProvenSamePageParagraphBoundary,
  sourceProvenSamePageVerticalFloatBoundary,
} from './pdf-prose-boundary-evidence'
export { sourceProvenRunFragmentToSpanBoundary } from './pdf-prose-boundary-evidence'
import {
  buildCitationRelationships,
  detectAuthorAffiliationReferences,
  detectAuthorNoteReferences,
  detectReferences,
  exactSourceBoxesForCitationRange,
  semanticRoleForClassification,
  type NoteReferenceDraft,
  type SemanticReferenceDraft,
} from './pdf-reference-relationships'
import {
  PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE,
  boxForRegionLines,
  extendBibliographyScopeFromStructuralHeading,
  mapPdfReconstructionInBatches,
  recoverBibliographyBlocks,
  throwIfPdfReconstructionAborted,
  yieldPdfReconstructionTask,
} from './pdf-region-block-recovery'
import {
  classifyPdfRegionBlocks,
  splitListItemTailParagraphs,
} from './pdf-region-block-classification'
import { assignPdfRegionBlockLists } from './pdf-region-block-list-assignment'
import { sourceSemanticFlowBoundaryDecision } from './pdf-semantic-flow-boundaries'
import { classifyPdfNoteMarkers } from './pdf-note-classifier'
import { matchPdfNotes } from './pdf-note-matching'
export { PDF_NOTE_RELATIONSHIP_THRESHOLD } from './pdf-note-matching'
import {
  inlineHardHyphenLexicon,
  inlineUnhyphenatedLexicon,
  replayPdfRegionLineRanges,
} from './pdf-lines'
import {
  boxesOverlap,
  canonicalVisualSourceInlineMapping,
  canonicalVisualSourceTranscript,
  canonicalVisualTextOwner,
  exactVisualCanonicalRangeForSource,
  materializeCanonicalVisualNode,
  runVerticalAlign,
} from './pdf-visual-source-mapping'
import { sourceStyledOrdinalSmallCapsHeading } from './pdf-region-fragments'
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
import {
  canonicalBibliographyInternalLinkTargets,
  canonicalCitationInternalLinkTargets,
  canonicalHeadingCrossReferenceTargets,
  canonicalNoteInternalLinkTargets,
  canonicalVisualCrossReferenceTargets,
  headingLevel,
  promoteAdjacentNumberedParentChildHeadings,
} from './pdf-structural-headings'
export {
  buildPdfLinkSourceAnchorLedger,
  resolveCanonicalHyperlinkObligations,
} from './pdf-canonical-hyperlinks'
import { sourceEvidence, sourceInlineRuns } from './pdf-source-inline-evidence'
import {
  canonicalVisualDraft,
  placeMatchedCanonicalNotes,
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
  pdfPublicationMetadata,
  validDate,
  type PdfDocumentMetadata,
} from './pdf-publication-metadata'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import { orderCanonicalVisualPairs } from './pdf-visual-order'
export { orderCanonicalVisualPairs } from './pdf-visual-order'
import { normalizePdfLinkAnnotations } from './pdf-links'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import type { TableCandidateProvider } from './table-candidate-provider'
export { visualCanonicalNodeId } from './pdf-visuals'
import {
  pdfBodySourceOrderExtremaByPage,
  type PdfBodySourceOrderExtremum,
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

// Compact publisher front matter can place keywords and the publication
// citation in one geometric region even though the labelled citation begins a
// new source block. Preserve that explicit line boundary instead of emitting a
// single run-on paragraph in reflowable output.
function classifyFrontMatter(
  blocks: RegionBlock[],
  metadataTitle: string | undefined,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  splitEmbeddedPublicationReference(blocks, lineBoundaryDecisions)
  splitLeadingFrontMatterAffiliationFromProse(blocks, lineBoundaryDecisions)
  splitFrontMatterAffiliationContact(blocks, lineBoundaryDecisions)
  return classifyPdfFrontMatter(blocks, metadataTitle)
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
  const { initialBlocks, bodySize, hardHyphenLexicon, unhyphenatedLexicon } =
    await classifyPdfRegionBlocks(
      orderedRegions,
      regions,
      excludedRegionIds,
      bibliographyRegionIds,
      sourceEquationCaptions,
      consumedLineIds,
      lineBoundaryDecisions,
      onProgress,
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

  return assignPdfRegionBlockLists(
    blocks,
    bibliographyScopeRegionIds,
    bibliographyRegionIds,
    bodySize,
    hardHyphenLexicon,
    unhyphenatedLexicon,
    language,
    canonicalHyphenBoundaryDecisions,
    sourceSemanticFlowBoundaryDecisions,
    diagnostics,
    citationLedRegionIds,
    signal,
  )
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
