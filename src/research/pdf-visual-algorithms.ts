import type {
  NormalizedSourceBox,
  PdfImportProgress,
  PdfPageRegion,
  PdfSourceCropAttemptRequest,
  PdfVisualAsset,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import {
  completeSourcePageCropPdfVisualAsset,
  mergePdfVisualAsset,
  samePdfSourceBox,
  sourcePageCropTouchesEdge,
} from './pdf-visual-source-crops'
import {
  neighborBoundedCropBoxes,
  unionBox,
} from './pdf-visual-source-geometry'
import {
  PDF_VISUAL_COOPERATIVE_BATCH_SIZE,
  yieldPdfVisualTask,
} from './pdf-visual-figure-grouping'
import { horizontalOverlapRatio } from './pdf-visual-matching'

export type PdfFigureRasterizer = (
  input: PdfSourceCropAttemptRequest,
) => Promise<PdfVisualAsset | null>

type BoundedAlgorithmBlock = {
  caption: PdfPageRegion
  label: string
  sourceRegions: PdfPageRegion[]
  sourceLineIds: string[]
  sourceText: string
  sourceBox: NormalizedSourceBox
}

const ALGORITHM_SOURCE_CROP_PADDING = 0.012
const ALGORITHM_SOURCE_CROP_RETRY_PADDINGS = [
  0.014, 0.016, 0.02, 0.024, 0.028,
] as const

function parsedAlgorithmCaption(region: PdfPageRegion) {
  const normalized = region.text.replace(/\s+/gu, ' ').trim()
  const match =
    /^Algorithm\s+((?:\d+(?:\.\d+)*[A-Za-z]?|[IVXLCDM]+))(?=$|[\s:.)-])(?:\s*[:.)-]?\s*)(.*)$/iu.exec(
      normalized,
    )
  if (!match) return null
  return {
    label: `Algorithm ${match[1]}`,
    title: match[2].trim(),
  }
}

function algorithmLineMarkers(value: string) {
  return [...value.matchAll(/(?:^|\s)(\d{1,3})\s*[:.]/gu)].map((match) =>
    Number(match[1]),
  )
}

function algorithmTerminalLine(value: string) {
  return (
    /\breturn\b/iu.test(value) ||
    /\boutput\s*:/iu.test(value) ||
    /\bend\s+(?:algorithm|procedure|while|for|if|loop|function)\b/iu.test(value)
  )
}

function recoveredAlgorithmSourceText(regions: PdfPageRegion[]) {
  return regions
    .flatMap((region) =>
      region.lines.length > 0
        ? region.lines.map((line) => line.text.trim()).filter(Boolean)
        : [region.text.trim()].filter(Boolean),
    )
    .join('\n')
}

function boundedAlgorithmBlocks(
  regions: PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
) {
  const claimedRegionIds = new Set<string>()
  const blocks: BoundedAlgorithmBlock[] = []
  const captions = regions
    .filter(
      (region) =>
        !consumedRegionIds.has(region.id) &&
        region.lines.length > 0 &&
        parsedAlgorithmCaption(region) !== null,
    )
    .sort(
      (left, right) =>
        left.page - right.page ||
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    )
  for (const caption of captions) {
    if (claimedRegionIds.has(caption.id)) continue
    const parsed = parsedAlgorithmCaption(caption)!
    const candidates = regions
      .filter(
        (region) =>
          region.id !== caption.id &&
          !claimedRegionIds.has(region.id) &&
          !consumedRegionIds.has(region.id) &&
          region.page === caption.page &&
          region.lines.length > 0 &&
          region.text.trim().length > 0 &&
          region.kind !== 'caption' &&
          region.box.y >= caption.box.y + caption.box.height - 0.006 &&
          region.box.y <= caption.box.y + 0.65 &&
          horizontalOverlapRatio(region.box, caption.box) >= 0.7,
      )
      .sort(
        (left, right) =>
          left.box.y - right.box.y ||
          left.box.x - right.box.x ||
          left.id.localeCompare(right.id),
      )
    const requireIndex = candidates.findIndex((region) =>
      /^(?:\d{1,3}\s*[:.]\s*)?(?:Require|Input)\s*:/iu.test(region.text.trim()),
    )
    if (requireIndex < 0) continue
    const sourceRegions: PdfPageRegion[] = []
    let expectedMarker = 1
    let previousBottom = caption.box.y + caption.box.height
    let terminal = false
    const anchoredCandidates = candidates.slice(requireIndex)
    for (const [candidateIndex, region] of anchoredCandidates.entries()) {
      const gap = region.box.y - previousBottom
      if (gap > 0.06) break
      const markers = algorithmLineMarkers(region.text)
      if (
        markers.some((marker) => {
          if (marker !== expectedMarker) return true
          expectedMarker += 1
          return false
        })
      ) {
        sourceRegions.length = 0
        break
      }
      sourceRegions.push(region)
      previousBottom = Math.max(
        previousBottom,
        region.box.y + region.box.height,
      )
      const nextRegion = anchoredCandidates[candidateIndex + 1]
      const nextMarkers = nextRegion
        ? algorithmLineMarkers(nextRegion.text)
        : []
      const nextContinuesSequence = Boolean(
        nextRegion &&
        nextRegion.box.y - previousBottom <= 0.06 &&
        nextMarkers[0] === expectedMarker,
      )
      if (
        expectedMarker >= 4 &&
        algorithmTerminalLine(region.text) &&
        !nextContinuesSequence
      ) {
        terminal = true
        break
      }
    }
    if (
      !terminal ||
      expectedMarker < 4 ||
      sourceRegions.length === 0 ||
      sourceRegions[0] !== candidates[requireIndex]
    ) {
      continue
    }
    const sourceLineIds = sourceRegions.flatMap((region) =>
      region.lines.map((line) => line.id),
    )
    if (
      sourceLineIds.length === 0 ||
      new Set(sourceLineIds).size !== sourceLineIds.length
    ) {
      continue
    }
    const panelRegions = [caption, ...sourceRegions]
    blocks.push({
      caption,
      label: parsed.label,
      sourceRegions,
      sourceLineIds,
      sourceText: recoveredAlgorithmSourceText(sourceRegions),
      sourceBox: unionBox(panelRegions),
    })
    for (const region of panelRegions) claimedRegionIds.add(region.id)
  }
  return blocks
}

export async function reconstructBoundedAlgorithms({
  regions,
  rasterizeFigure,
  assetStore,
  consumedRegionIds,
  consumedLineIds,
  relationships,
  diagnostics,
  onProgress,
  signal,
}: {
  regions: PdfPageRegion[]
  rasterizeFigure?: PdfFigureRasterizer
  assetStore: Map<string, PdfVisualAsset>
  consumedRegionIds: Set<string>
  consumedLineIds: Set<string>
  relationships: PdfVisualRelationship[]
  diagnostics: ReconstructionDiagnostic[]
  onProgress?: (progress: PdfImportProgress) => void
  signal?: AbortSignal
}) {
  const algorithmCountByPage = new Map<number, number>()
  onProgress?.({
    phase: 'semantic-promotion',
    completed: 0,
    total: regions.length,
    message: `Indexing bounded algorithm evidence across ${regions.length} source regions…`,
    checkpoint: 'algorithm-block-discovery',
  })
  await yieldPdfVisualTask(signal)
  const algorithms = boundedAlgorithmBlocks(regions, consumedRegionIds)
  for (const [algorithmIndex, algorithm] of algorithms.entries()) {
    if (
      algorithmIndex > 0 &&
      algorithmIndex % PDF_VISUAL_COOPERATIVE_BATCH_SIZE === 0
    ) {
      onProgress?.({
        phase: 'semantic-promotion',
        completed: algorithmIndex,
        total: algorithms.length,
        message: `Resolving bounded algorithm blocks ${algorithmIndex} of ${algorithms.length}…`,
      })
      await yieldPdfVisualTask(signal)
    }
    const pageSequence =
      (algorithmCountByPage.get(algorithm.caption.page) ?? 0) + 1
    algorithmCountByPage.set(algorithm.caption.page, pageSequence)
    const sourceObjectId = `algorithm-source-p${String(
      algorithm.caption.page,
    ).padStart(3, '0')}-${String(pageSequence).padStart(3, '0')}`
    const selectedLineIds = new Set([
      ...algorithm.caption.lines.map((line) => line.id),
      ...algorithm.sourceLineIds,
    ])
    let sourceCropBox = neighborBoundedCropBoxes(
      algorithm.sourceBox,
      selectedLineIds,
      regions,
      ALGORITHM_SOURCE_CROP_PADDING,
    )[0]
    let sourceCrop: PdfVisualAsset | null = null
    let cropTouchedEdge = false
    let adaptivePaddingRetry = false
    if (rasterizeFigure) {
      sourceCrop = await rasterizeFigure({
        kind: 'figure',
        page: algorithm.caption.page,
        sourceBox: sourceCropBox,
        sourceObjectIds: [sourceObjectId],
        sourceBoxes: [algorithm.sourceBox],
      }).catch((error: unknown) => {
        cropTouchedEdge = sourcePageCropTouchesEdge(error)
        return null
      })
      const attemptedBoxes = [sourceCropBox]
      retryAlgorithmCrop: for (const padding of ALGORITHM_SOURCE_CROP_RETRY_PADDINGS) {
        if (sourceCrop || !cropTouchedEdge) break
        const retryBox = neighborBoundedCropBoxes(
          algorithm.sourceBox,
          selectedLineIds,
          regions,
          padding,
        )[0]
        if (
          attemptedBoxes.some((attempted) =>
            samePdfSourceBox(attempted, retryBox),
          )
        ) {
          continue
        }
        attemptedBoxes.push(retryBox)
        let retryTouchedEdge = false
        const retryCrop = await rasterizeFigure({
          kind: 'figure',
          page: algorithm.caption.page,
          sourceBox: retryBox,
          sourceObjectIds: [sourceObjectId],
          sourceBoxes: [algorithm.sourceBox],
        }).catch((error: unknown) => {
          retryTouchedEdge = sourcePageCropTouchesEdge(error)
          return null
        })
        cropTouchedEdge = retryTouchedEdge
        if (retryCrop) {
          sourceCropBox = retryBox
          sourceCrop = retryCrop
          adaptivePaddingRetry = true
          break retryAlgorithmCrop
        }
        if (!retryTouchedEdge) break retryAlgorithmCrop
      }
    }
    const cropMatched = Boolean(
      sourceCrop &&
      completeSourcePageCropPdfVisualAsset(
        sourceCrop,
        'figure',
        [sourceObjectId],
        [algorithm.sourceBox],
        sourceCropBox,
      ),
    )
    if (sourceCrop && cropMatched) mergePdfVisualAsset(assetStore, sourceCrop)
    const evidence = [
      'source-algorithm-block',
      'bounded-source-geometry',
      'contiguous-algorithm-line-markers',
      'source-text-transcript-unresolved',
      ...(adaptivePaddingRetry ? ['source-page-crop-adaptive-padding'] : []),
      ...(cropMatched
        ? ['source-page-crop']
        : ['source-rendition-unavailable', 'unresolved-visual-text-owned']),
    ]
    // The explicit Algorithm heading is the caption for this visual owner.
    // Promotion happens only after a Require/Input anchor, a contiguous 1..N
    // marker sequence, and a terminal line prove the complete bounded panel.
    algorithm.caption.kind = 'caption'
    if (cropMatched) {
      for (const region of algorithm.sourceRegions) {
        consumedRegionIds.add(region.id)
        for (const line of region.lines) consumedLineIds.add(line.id)
      }
    }
    relationships.push({
      id: '',
      kind: 'figure',
      semanticKind: 'algorithm',
      label: algorithm.label,
      captionRegionId: algorithm.caption.id,
      sourceRegionIds: algorithm.sourceRegions.map((region) => region.id),
      sourceLineIds: [...algorithm.sourceLineIds],
      sourceObjectIds: cropMatched ? [sourceObjectId] : [],
      assetIds: cropMatched ? [sourceCrop!.id] : [],
      status: cropMatched ? 'matched' : 'unresolved',
      confidence: Math.min(
        algorithm.caption.confidence,
        ...algorithm.sourceRegions.map((region) => region.confidence),
      ),
      evidence,
      candidates: [
        {
          sourceRegionIds: algorithm.sourceRegions.map((region) => region.id),
          sourceObjectIds: [sourceObjectId],
          assetIds: cropMatched ? [sourceCrop!.id] : [],
          score: algorithm.caption.confidence,
          evidence,
          sourceBoxes: [algorithm.sourceBox],
        },
      ],
      sourceBoxes: [algorithm.caption.box, algorithm.sourceBox],
      // A crop conserves the exact printed pseudocode, but the PDF text layer
      // does not prove indentation or continuation ownership. Never count its
      // flattened extraction as canonical text. On a failed crop, retain it
      // only as an explicitly unresolved recovery transcript.
      sourceText: cropMatched ? '' : algorithm.sourceText,
      altText: algorithm.caption.text,
      altTextSource: 'caption',
      canonicalNodeId: null,
      captionNodeId: null,
    })
    if (!cropMatched) {
      diagnostics.push({
        code: 'UNRESOLVED_ALGORITHM_BLOCK',
        severity: 'error',
        page: algorithm.caption.page,
        message: `${algorithm.label} has a proved bounded source panel, but no exact source crop is available; its numbered lines remain in canonical text flow while the visual relationship stays unresolved.`,
        sourceBoxes: [algorithm.caption.box, algorithm.sourceBox],
        target: {
          regionIds: algorithm.sourceRegions.map((region) => region.id),
          markerId: null,
        },
      })
    }
  }
}
