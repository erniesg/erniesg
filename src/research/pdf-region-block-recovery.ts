import type {
  NormalizedSourceBox,
  PdfCanonicalHyphenBoundaryDecision,
  PdfLineBoundaryDecision,
  PdfPageRegion,
  PdfSourceSemanticFlowBoundaryDecision,
  ReconstructionDiagnostic,
} from './import-types'
import { PdfImportError } from './import-types'
import {
  appendBibliographyContinuation,
  bibliographyContinuationFormEvidence,
  hasOmittedSourceBetweenBlocks,
  likelyAuthorYearBibliographyEntryStart,
  provenBibliographyContinuation,
  recordUncertainBibliographyBoundary,
} from './pdf-continuation-evidence'
import {
  blockSourceSegments,
  parsedBibliographyListMarker,
  type PdfListRegionBlock,
} from './pdf-list-markers'
import { replayPdfRegionLineRanges } from './pdf-lines'

export function median(values: number[]) {
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

export function boxForRegionLines(
  lines: PdfPageRegion['lines'],
): NormalizedSourceBox {
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
  blocks: PdfListRegionBlock[],
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
  target: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
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

function splitBibliographyBlock(
  block: PdfListRegionBlock,
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

  const fragments: PdfListRegionBlock[] = []
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

export async function recoverBibliographyBlocks(
  blocks: PdfListRegionBlock[],
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
  const uncertainFlows = new Map<string, PdfListRegionBlock[]>()
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
  const recovered: PdfListRegionBlock[] = []
  let previousBibliographyBlock: PdfListRegionBlock | undefined
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

export function extendBibliographyScopeFromStructuralHeading(
  blocks: readonly PdfListRegionBlock[],
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

export const PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE = 16
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

export function throwIfPdfReconstructionAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  throw new PdfImportError(
    'IMPORT_CANCELLED',
    'The local PDF reconstruction was cancelled and its working data was released.',
  )
}

export async function yieldPdfReconstructionTask(signal?: AbortSignal) {
  throwIfPdfReconstructionAborted(signal)
  await new Promise<void>((resolve) =>
    globalThis.setTimeout(
      resolve,
      isPdfBrowserWorkerRuntime() ? PDF_BROWSER_WORKER_COOPERATIVE_DELAY_MS : 0,
    ),
  )
  throwIfPdfReconstructionAborted(signal)
}

export async function mapPdfReconstructionInBatches<Input, Output>(
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
