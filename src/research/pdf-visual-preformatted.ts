import type {
  NormalizedSourceBox,
  PdfImportProgress,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import type { PdfScholarlyVisualLabel } from './pdf-scholarly-label'
import {
  sourceLineOrder,
  sourceRegionOrder,
  type BoundedPreformattedBlock,
} from './pdf-preformatted-source'
import { retainedCaptionText } from './pdf-preformatted-blocks'
import { boundedPreformattedBlocks } from './pdf-preformatted-panels'
import {
  completeSourcePageCropPdfVisualAsset as completeSourcePageCropAsset,
  mergePdfVisualAsset as mergeAsset,
  samePdfSourceBox as sameSourceBox,
  sourcePageCropTouchesEdge,
} from './pdf-visual-source-crops'
import {
  neighborBoundedCropBoxes,
  nextSourceRegions,
} from './pdf-visual-source-geometry'
import { intersectionArea } from './pdf-visual-figure-lineage'
import {
  PDF_VISUAL_COOPERATIVE_BATCH_SIZE,
  yieldPdfVisualTask,
} from './pdf-visual-figure-grouping'
import type { PdfFigureRasterizer } from './pdf-visual-algorithms'

const PREFORMATTED_SOURCE_CROP_PADDING = 0.012
const PREFORMATTED_SOURCE_CROP_RETRY_PADDINGS = [
  0.016, 0.02, 0.024, 0.028, 0.032, 0.04, 0.05,
] as const
const PREFORMATTED_NEIGHBOR_GAP_FRACTION = 0.8

type PreformattedScopeEvidence = {
  hasMathExtensionFontProvenance: (region: PdfPageRegion) => boolean
  sourceMathFragment: (region: PdfPageRegion) => boolean
  dedicatedCaptionLabelStyle: (
    run: PdfPageRegion['lines'][number]['runs'][number],
  ) => boolean
  unstyledProseTableReference: (region: PdfPageRegion) => boolean
}

type ConsumeRegionLineSelection = (
  regionId: string,
  selectedLineIds: readonly string[],
  regions: readonly PdfPageRegion[],
  consumedRegionIds: Set<string>,
  consumedLineIds: Set<string>,
) => void

type PreformattedScopeReservation = {
  lineIds: Set<string>
  captionRegionIds: Set<string>
}

function preformattedScopeReservations(
  pages: PdfPageAnalysis[],
  regions: PdfPageRegion[],
  captionLabels: ReadonlyMap<PdfPageRegion, PdfScholarlyVisualLabel>,
  scopeEvidence: PreformattedScopeEvidence,
): PreformattedScopeReservation {
  const lineIds = new Set<string>()
  const captionRegionIds = new Set<string>()
  const reserveRegion = (region: PdfPageRegion) => {
    for (const line of region.lines) lineIds.add(line.id)
  }

  // Regions already typed by the source adapter are semantic owners, even
  // when their visual rendition is unresolved. Generic listing detection must
  // not steal their lines or their captions and make the typed pass disappear.
  for (const region of regions) {
    if (['table', 'equation', 'figure'].includes(region.kind)) {
      reserveRegion(region)
    }
    if (
      region.kind === 'equation' ||
      scopeEvidence.hasMathExtensionFontProvenance(region) ||
      scopeEvidence.sourceMathFragment(region)
    ) {
      reserveRegion(region)
    }
  }

  const typedCaption = (region: PdfPageRegion) => {
    const label = captionLabels.get(region)
    if (!label) return null
    const firstRun = region.lines
      .flatMap((line) => line.runs)
      .find((run) => run.text.trim())
    if (
      region.kind !== 'caption' &&
      !(firstRun && scopeEvidence.dedicatedCaptionLabelStyle(firstRun))
    ) {
      return null
    }
    if (scopeEvidence.unstyledProseTableReference(region)) return null
    return label
  }

  for (const [caption] of captionLabels) {
    const typed = typedCaption(caption)
    if (!typed) continue

    // Caption-bounded program listings are the one typed-looking figure
    // envelope intentionally handled by the preformatted detector itself.
    // Leave that caption available to programListingBlocks.
    const programListing =
      typed.kind === 'figure' &&
      /\b(?:example|generated)\s+program\b|\bprogram\s+for\b/iu.test(
        caption.text,
      )
    if (!programListing) {
      captionRegionIds.add(caption.id)
      reserveRegion(caption)
    }

    if (typed.kind === 'table' || typed.kind === 'equation') {
      // These are the same bounded source lanes used by the typed visual pass.
      // Reserving them before generic detection prevents a monospaced table row
      // or formula fragment from becoming a competing code block.
      for (const source of nextSourceRegions(caption, regions, typed.kind)) {
        reserveRegion(source)
      }
    }

    if (typed.kind === 'figure') {
      const page = pages.find((candidate) => candidate.page === caption.page)
      const nativeBoxes = (page?.objects ?? [])
        .filter((object) => object.kind === 'image' || object.kind === 'vector')
        .map((object) => object.box)
      for (const source of regions) {
        if (source.page !== caption.page || source.id === caption.id) continue
        if (source.kind === 'figure' || source.kind === 'chart-label') {
          reserveRegion(source)
          continue
        }
        if (
          source.kind === 'body' ||
          source.kind === 'spanning' ||
          source.kind === 'side'
        ) {
          const overlapsNative = nativeBoxes.some(
            (nativeBox) =>
              intersectionArea(nativeBox, source.box) >
              Math.min(
                nativeBox.width * nativeBox.height,
                source.box.width * source.box.height,
              ) *
                0.2,
          )
          if (overlapsNative) reserveRegion(source)
        }
      }
    }
  }

  // Bibliography entries are intentionally source-backed prose/list structure,
  // not listings. Reserve an identifiable reference section before a leading
  // "References:" line can be used as a generic introducer.
  const bibliographyHeading = (value: string) =>
    /^(?:(?:\d+(?:\.\d+)*)[.)]?\s+)?(?:references|bibliography)\s*:?[\s]*$/iu.test(
      value.trim(),
    )
  const headings = regions.filter(
    (region) =>
      bibliographyHeading(region.text) ||
      region.lines.some((line) => bibliographyHeading(line.text)),
  )
  for (const heading of headings) {
    reserveRegion(heading)
    const following = regions
      .filter(
        (region) =>
          region.page === heading.page &&
          region.id !== heading.id &&
          region.column === heading.column &&
          region.box.y >= heading.box.y + heading.box.height - 0.004,
      )
      .sort(sourceRegionOrder)
    for (const region of following) {
      const entryLike = region.lines.some((line) =>
        /^(?:\[\s*\d+\s*\]|\d+[.)])\s+/u.test(line.text.trim()),
      )
      if (entryLike) reserveRegion(region)
    }
  }

  return { lineIds, captionRegionIds }
}

export function detectPreformattedVisuals({
  pages,
  regions,
  captionLabels,
  diagnostics,
  scopeEvidence,
}: {
  pages: PdfPageAnalysis[]
  regions: PdfPageRegion[]
  captionLabels: ReadonlyMap<PdfPageRegion, PdfScholarlyVisualLabel>
  diagnostics: ReconstructionDiagnostic[]
  scopeEvidence: PreformattedScopeEvidence
}) {
  const detection = boundedPreformattedBlocks(
    pages,
    regions,
    preformattedScopeReservations(pages, regions, captionLabels, scopeEvidence),
  )
  for (const unresolved of detection.unresolved) {
    diagnostics.push({
      code: 'UNRESOLVED_PREFORMATTED_BLOCK',
      severity: 'warning',
      page: unresolved.page,
      message:
        'A source run has preformatted font or indentation evidence, but no unique attached caption or introducer proves its complete scope; it remains prose.',
      sourceBoxes: unresolved.sourceBoxes,
      target: { regionIds: unresolved.regionIds, markerId: null },
    })
  }
  return {
    blocks: detection.blocks,
    captionRegionIds: new Set(
      detection.blocks.map((block) => block.caption.id),
    ),
  }
}

export async function reconstructPreformattedVisuals({
  preformattedBlocks,
  regions,
  rasterizeFigure,
  assetStore,
  consumedRegionIds,
  consumedLineIds,
  relationships,
  diagnostics,
  consumeRegionLineSelection,
  onProgress,
  signal,
}: {
  preformattedBlocks: BoundedPreformattedBlock[]
  regions: PdfPageRegion[]
  rasterizeFigure?: PdfFigureRasterizer
  assetStore: Map<string, PdfVisualAsset>
  consumedRegionIds: Set<string>
  consumedLineIds: Set<string>
  relationships: PdfVisualRelationship[]
  diagnostics: ReconstructionDiagnostic[]
  consumeRegionLineSelection: ConsumeRegionLineSelection
  onProgress?: (progress: PdfImportProgress) => void
  signal?: AbortSignal
}) {
  const preformattedCountByPage = new Map<number, number>()
  for (const [blockIndex, block] of preformattedBlocks.entries()) {
    if (
      blockIndex > 0 &&
      blockIndex % PDF_VISUAL_COOPERATIVE_BATCH_SIZE === 0
    ) {
      onProgress?.({
        phase: 'semantic-promotion',
        completed: blockIndex,
        total: preformattedBlocks.length,
        message: `Resolving bounded preformatted blocks ${blockIndex} of ${preformattedBlocks.length}…`,
      })
      await yieldPdfVisualTask(signal)
    }
    const pageSequence =
      (preformattedCountByPage.get(block.caption.page) ?? 0) + 1
    preformattedCountByPage.set(block.caption.page, pageSequence)
    const retainedCaption =
      block.captionFallbackLineId !== null
        ? (block.caption.lines.find(
            (line) => line.id === block.captionFallbackLineId,
          )?.text ?? block.label)
        : retainedCaptionText(
            block.caption,
            new Set(block.sourceLines.map(({ line }) => line.id)),
          ) || block.caption.text
    const renderedSegments: Array<{
      asset: PdfVisualAsset
      sourceObjectIds: string[]
      sourceObjectBoxes: NormalizedSourceBox[]
      sourceCropBox: NormalizedSourceBox
      adaptivePaddingRetry: boolean
    }> = []
    let allSegmentsMatched =
      Boolean(rasterizeFigure) && block.segments.length > 0
    for (const [segmentIndex, segment] of block.segments.entries()) {
      const syntheticSourceObjectId = `code-source-p${String(
        segment.page,
      ).padStart(3, '0')}-${String(pageSequence).padStart(3, '0')}-${String(
        segmentIndex + 1,
      ).padStart(3, '0')}`
      const sourceObjectIds =
        segment.sourceObjectIds.length > 0
          ? segment.sourceObjectIds
          : [syntheticSourceObjectId]
      const sourceObjectBoxes =
        segment.sourceObjectBoxes.length > 0
          ? segment.sourceObjectBoxes
          : [segment.sourceBox]
      const selectedLineIds = new Set(
        segment.sourceLines.map(({ line }) => line.id),
      )
      let sourceCropBox = neighborBoundedCropBoxes(
        segment.sourceBox,
        selectedLineIds,
        regions,
        PREFORMATTED_SOURCE_CROP_PADDING,
      )[0]
      let sourceCrop: PdfVisualAsset | null = null
      let cropTouchedEdge = false
      let adaptivePaddingRetry = false
      if (rasterizeFigure) {
        sourceCrop = await rasterizeFigure({
          kind: 'figure',
          page: segment.page,
          sourceBox: sourceCropBox,
          sourceObjectIds,
          sourceBoxes: sourceObjectBoxes,
          tightenToSourceInk: false,
        }).catch((error: unknown) => {
          cropTouchedEdge = sourcePageCropTouchesEdge(error)
          return null
        })
        const attemptedBoxes = [sourceCropBox]
        retryPreformattedCrop: for (const padding of PREFORMATTED_SOURCE_CROP_RETRY_PADDINGS) {
          if (sourceCrop || !cropTouchedEdge) break
          const retryBoxes = [
            neighborBoundedCropBoxes(
              segment.sourceBox,
              selectedLineIds,
              regions,
              padding,
            )[0],
            neighborBoundedCropBoxes(
              segment.sourceBox,
              selectedLineIds,
              regions,
              padding,
              PREFORMATTED_NEIGHBOR_GAP_FRACTION,
            )[0],
          ]
          for (const retryBox of retryBoxes) {
            if (
              attemptedBoxes.some((attempted) =>
                sameSourceBox(attempted, retryBox),
              )
            ) {
              continue
            }
            attemptedBoxes.push(retryBox)
            let retryTouchedEdge = false
            const retryCrop = await rasterizeFigure({
              kind: 'figure',
              page: segment.page,
              sourceBox: retryBox,
              sourceObjectIds,
              sourceBoxes: sourceObjectBoxes,
              tightenToSourceInk: false,
            }).catch((error: unknown) => {
              retryTouchedEdge = sourcePageCropTouchesEdge(error)
              return null
            })
            cropTouchedEdge = retryTouchedEdge
            if (retryCrop) {
              sourceCropBox = retryBox
              sourceCrop = retryCrop
              adaptivePaddingRetry = true
              break retryPreformattedCrop
            }
            if (!retryTouchedEdge) break retryPreformattedCrop
          }
        }
      }
      const cropMatched = Boolean(
        sourceCrop &&
        completeSourcePageCropAsset(
          sourceCrop,
          'figure',
          sourceObjectIds,
          sourceObjectBoxes,
          sourceCropBox,
        ),
      )
      if (!cropMatched || !sourceCrop) {
        allSegmentsMatched = false
        continue
      }
      renderedSegments.push({
        asset: sourceCrop,
        sourceObjectIds,
        sourceObjectBoxes,
        sourceCropBox,
        adaptivePaddingRetry,
      })
    }
    if (renderedSegments.length !== block.segments.length) {
      allSegmentsMatched = false
    }
    if (allSegmentsMatched) {
      for (const segment of renderedSegments) {
        mergeAsset(assetStore, segment.asset)
      }
    }
    block.caption.kind = 'caption'
    const consumedByRegion = new Map<string, string[]>()
    for (const { region, line } of block.sourceLines) {
      if (line.id === block.captionFallbackLineId) continue
      const values = consumedByRegion.get(region.id) ?? []
      values.push(line.id)
      consumedByRegion.set(region.id, values)
    }
    for (const [regionId, selectedLineIds] of consumedByRegion) {
      for (const lineId of selectedLineIds) consumedLineIds.add(lineId)
      consumeRegionLineSelection(
        regionId,
        selectedLineIds,
        regions,
        consumedRegionIds,
        consumedLineIds,
      )
    }
    const orderedSourceLines = [...block.sourceLines].sort(sourceLineOrder)
    const recoveredSourceText = orderedSourceLines
      .map(({ line }) => line.text)
      .join('\n')
    const sourceRegionIds = [
      ...new Set(orderedSourceLines.map(({ region }) => region.id)),
    ]
    const sourceLineIds = orderedSourceLines.map(({ line }) => line.id)
    const expectedSourceObjectIds = block.segments.flatMap(
      (segment, segmentIndex) =>
        segment.sourceObjectIds.length > 0
          ? segment.sourceObjectIds
          : [
              `code-source-p${String(segment.page).padStart(3, '0')}-${String(
                pageSequence,
              ).padStart(3, '0')}-${String(segmentIndex + 1).padStart(3, '0')}`,
            ],
    )
    const evidence = [
      ...block.evidence,
      ...(block.preformatted.status === 'unresolved'
        ? ['source-text-transcript-unresolved']
        : []),
      ...(renderedSegments.some((segment) => segment.adaptivePaddingRetry)
        ? ['source-page-crop-adaptive-padding']
        : []),
      ...(allSegmentsMatched
        ? ['source-page-crop']
        : ['source-rendition-unavailable', 'unresolved-visual-text-owned']),
    ]
    relationships.push({
      id: '',
      kind: 'figure',
      semanticKind: block.semanticKind,
      preformatted: block.preformatted,
      label: block.label,
      captionRegionId: block.caption.id,
      sourceRegionIds,
      sourceLineIds,
      sourceObjectIds: allSegmentsMatched ? expectedSourceObjectIds : [],
      assetIds: allSegmentsMatched
        ? renderedSegments.map((segment) => segment.asset.id)
        : [],
      status: allSegmentsMatched ? 'matched' : 'unresolved',
      confidence: Math.min(
        block.caption.confidence,
        ...block.sourceLines.map(({ region }) => region.confidence),
      ),
      evidence,
      candidates: [
        {
          sourceRegionIds,
          sourceObjectIds: expectedSourceObjectIds,
          assetIds: allSegmentsMatched
            ? renderedSegments.map((segment) => segment.asset.id)
            : [],
          score: block.caption.confidence,
          evidence,
          sourceBoxes: block.segments.map((segment) => segment.sourceBox),
        },
      ],
      sourceBoxes: [
        block.caption.box,
        ...block.segments.map((segment) => segment.sourceBox),
      ],
      sourceText:
        allSegmentsMatched && block.preformatted.status === 'unresolved'
          ? ''
          : recoveredSourceText,
      altText: retainedCaption,
      altTextSource: 'caption',
      canonicalNodeId: null,
      captionNodeId: null,
    })
    if (!allSegmentsMatched) {
      diagnostics.push({
        code: 'UNRESOLVED_PREFORMATTED_BLOCK',
        severity: 'error',
        page: block.caption.page,
        message: `${block.label} has a proved bounded source scope, but no complete exact source crop is available; its ordered lines were withheld from canonical prose.`,
        sourceBoxes: [
          block.caption.box,
          ...block.segments.map((segment) => segment.sourceBox),
        ],
        target: {
          regionIds: sourceRegionIds,
          markerId: null,
        },
      })
    }
  }
}
