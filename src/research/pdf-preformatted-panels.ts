import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
} from './import-types'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import {
  canonicalizeSourceLineOwners,
  monospacedSourceLine,
  MONOSPACED_SOURCE_FONT,
  orderedSourceLines,
  sourceLineOrder,
  substantiveSourceRuns,
  type BoundedPreformattedBlock,
} from './pdf-preformatted-source'
import {
  exactPreformattedSource,
  preformattedSegments,
  sourceEvidencePreformattedBlocks,
} from './pdf-preformatted-blocks'

type PdfNativeObject = NonNullable<PdfPageAnalysis['objects']>[number]

type PreformattedScopeReservation = {
  lineIds: Set<string>
  captionRegionIds: Set<string>
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function horizontalBoxOverlap(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
}

export function programListingBlocks(
  regions: PdfPageRegion[],
  claimedLineIds: Set<string>,
  claimedCaptionRegionIds: Set<string>,
) {
  const blocks: BoundedPreformattedBlock[] = []
  const captions = regions
    .filter(
      (region) =>
        region.kind === 'caption' &&
        /\b(?:example|generated)\s+program\b|\bprogram\s+for\b/iu.test(
          region.text,
        ) &&
        parsePdfScholarlyVisualLabel(region.text, {
          context: 'caption',
        })?.kind === 'figure',
    )
    .sort(
      (left, right) =>
        left.page - right.page ||
        left.box.y - right.box.y ||
        left.id.localeCompare(right.id),
    )
  for (const caption of captions) {
    if (claimedCaptionRegionIds.has(caption.id)) continue
    const previousCaptionBottom = Math.max(
      ...captions
        .filter(
          (candidate) =>
            candidate.page === caption.page && candidate.box.y < caption.box.y,
        )
        .map((candidate) => candidate.box.y + candidate.box.height),
      0,
    )
    const generatedHeaders = regions
      .filter(
        (region) =>
          region.page === caption.page &&
          region.box.y > previousCaptionBottom &&
          region.box.y < caption.box.y &&
          /^Generated Program$/iu.test(region.text.trim()),
      )
      .sort((left, right) => right.box.y - left.box.y)
    const headerGroup = generatedHeaders.flatMap((generated) => {
      const sameBand = regions.filter(
        (region) =>
          region.page === caption.page &&
          Math.abs(region.box.y - generated.box.y) <= 0.012,
      )
      const input = sameBand.find((region) =>
        /^Input Sequence$/iu.test(region.text.trim()),
      )
      const produced = sameBand.find((region) =>
        /^Produced Sequence$/iu.test(region.text.trim()),
      )
      return input && produced ? [[input, generated, produced]] : []
    })[0]
    if (!headerGroup) continue
    const panelTop = Math.min(...headerGroup.map((region) => region.box.y))
    const sourceRegions = regions
      .filter(
        (region) =>
          region.id !== caption.id &&
          region.page === caption.page &&
          region.lines.length > 0 &&
          region.text.trim() &&
          !['header', 'footer', 'page-number', 'caption'].includes(
            region.kind,
          ) &&
          region.box.y >= panelTop - 0.005 &&
          region.box.y + region.box.height <= caption.box.y + 0.005 &&
          horizontalBoxOverlap(region.box, caption.box) > 0,
      )
      .sort(
        (left, right) =>
          left.box.y - right.box.y ||
          left.box.x - right.box.x ||
          left.id.localeCompare(right.id),
      )
    const sourceLines = canonicalizeSourceLineOwners(
      regions,
      sourceRegions.flatMap((region) =>
        region.lines.map((line) => ({ region, line })),
      ),
    ).sort(sourceLineOrder)
    if (
      sourceLines.length < 6 ||
      sourceLines.filter(({ line }) => monospacedSourceLine(line)).length < 2 ||
      sourceLines.some(({ line }) => claimedLineIds.has(line.id))
    ) {
      continue
    }
    const parsed = parsePdfScholarlyVisualLabel(caption.text, {
      context: 'caption',
    })
    const preformatted = exactPreformattedSource(sourceLines, false)
    blocks.push({
      caption,
      label:
        parsed?.label ??
        `Code listing p${String(caption.page).padStart(3, '0')}`,
      semanticKind: 'code',
      sourceLines,
      segments: preformattedSegments(sourceLines),
      preformatted,
      evidence: [
        'source-preformatted-block',
        'caption-bounded-program-listing',
        'three-column-source-order-unresolved',
        ...preformatted.evidence,
      ],
      captionFallbackLineId: null,
    })
    claimedCaptionRegionIds.add(caption.id)
    for (const { line } of sourceLines) claimedLineIds.add(line.id)
  }
  return blocks
}

function repeatedVectorStripGroups(pages: PdfPageAnalysis[]) {
  const groups: PdfNativeObject[][] = []
  for (const page of pages) {
    const strips = (page.objects ?? [])
      .filter(
        (object) =>
          object.kind === 'vector' &&
          object.box.width >= 0.5 &&
          object.box.height > 0 &&
          object.box.height <= 0.03,
      )
      .sort(
        (left, right) =>
          left.box.y - right.box.y ||
          left.box.x - right.box.x ||
          left.id.localeCompare(right.id),
      )
    let current: PdfNativeObject[] = []
    for (const strip of strips) {
      const previous = current.at(-1)
      const connected =
        previous &&
        Math.abs(previous.box.x - strip.box.x) <= 0.01 &&
        Math.abs(previous.box.width - strip.box.width) <= 0.01 &&
        strip.box.y - (previous.box.y + previous.box.height) <= 0.02
      if (!connected) {
        if (current.length >= 3) groups.push(current)
        current = []
      }
      current.push(strip)
    }
    if (current.length >= 3) groups.push(current)
  }
  return groups
}

export function vectorPanelPreformattedBlocks(
  pages: PdfPageAnalysis[],
  regions: PdfPageRegion[],
  claimedLineIds: Set<string>,
  claimedCaptionRegionIds: Set<string>,
) {
  const allLines = orderedSourceLines(regions)
  const blocks: BoundedPreformattedBlock[] = []
  for (const objects of repeatedVectorStripGroups(pages)) {
    const objectBox = {
      page: objects[0].page,
      x: Math.min(...objects.map((object) => object.box.x)),
      y: Math.min(...objects.map((object) => object.box.y)),
      width: 0,
      height: 0,
      rotation: objects[0].box.rotation,
      method: 'pdf-object' as const,
    }
    const right = Math.max(
      ...objects.map((object) => object.box.x + object.box.width),
    )
    const bottom = Math.max(
      ...objects.map((object) => object.box.y + object.box.height),
    )
    objectBox.width = rounded(right - objectBox.x)
    objectBox.height = rounded(bottom - objectBox.y)
    const panelLines = allLines.filter(
      ({ line }) =>
        line.box.page === objectBox.page &&
        !claimedLineIds.has(line.id) &&
        line.box.y + line.box.height >= objectBox.y - 0.006 &&
        line.box.y <= objectBox.y + objectBox.height + 0.006 &&
        horizontalBoxOverlap(line.box, objectBox) >
          Math.min(line.box.width, objectBox.width) * 0.5,
    )
    const monospacedCount = panelLines.filter(({ line }) =>
      monospacedSourceLine(line),
    ).length
    const monospacedRunLineCount = panelLines.filter(({ line }) =>
      substantiveSourceRuns(line).some((run) =>
        MONOSPACED_SOURCE_FONT.test(run.fontName),
      ),
    ).length
    if (
      panelLines.length < 3 ||
      monospacedCount < 1 ||
      monospacedRunLineCount < 2
    ) {
      continue
    }
    const proseAnchors = allLines
      .filter(
        ({ region, line }) =>
          line.box.page === objectBox.page &&
          line.box.y + line.box.height <= objectBox.y + 0.006 &&
          objectBox.y - (line.box.y + line.box.height) <= 0.15 &&
          !monospacedSourceLine(line) &&
          !claimedCaptionRegionIds.has(region.id),
      )
      .sort(sourceLineOrder)
    let captionOwner = proseAnchors.at(-1) ?? null
    if (
      captionOwner &&
      Math.min(...captionOwner.region.lines.map((line) => line.box.y)) <
        objectBox.y - 0.15
    ) {
      captionOwner = null
    }
    const sourceLines = panelLines
    let captionFallbackLineId: string | null = null
    if (!captionOwner) {
      const first = panelLines[0]
      if (
        !first ||
        first.region.lines.some(
          (line) =>
            line.box.y < objectBox.y - 0.006 ||
            line.box.y > objectBox.y + objectBox.height + 0.006,
        )
      ) {
        continue
      }
      captionOwner = first
      captionFallbackLineId = first.line.id
    }
    if (
      sourceLines.length < 2 ||
      sourceLines.some(({ line }) => claimedLineIds.has(line.id))
    ) {
      continue
    }
    const preformatted = exactPreformattedSource(sourceLines, false)
    blocks.push({
      caption: captionOwner.region,
      label: `Code block p${String(objectBox.page).padStart(3, '0')}-${String(
        blocks.filter((block) => block.caption.page === objectBox.page).length +
          1,
      ).padStart(3, '0')}`,
      semanticKind: 'code',
      sourceLines,
      segments: preformattedSegments(sourceLines, objects),
      preformatted,
      evidence: [
        'source-preformatted-block',
        'bounded-vector-code-panel',
        ...preformatted.evidence,
        ...(captionFallbackLineId
          ? ['fallback-source-line-caption']
          : ['source-prose-introducer']),
      ],
      captionFallbackLineId,
    })
    claimedCaptionRegionIds.add(captionOwner.region.id)
    for (const { line } of sourceLines) claimedLineIds.add(line.id)
  }
  return blocks
}

export function boundedPreformattedBlocks(
  pages: PdfPageAnalysis[],
  regions: PdfPageRegion[],
  reservations: PreformattedScopeReservation = {
    lineIds: new Set<string>(),
    captionRegionIds: new Set<string>(),
  },
) {
  const claimedLineIds = new Set(reservations.lineIds)
  const claimedCaptionRegionIds = new Set(reservations.captionRegionIds)
  const sourceEvidence = sourceEvidencePreformattedBlocks(
    regions,
    claimedLineIds,
    claimedCaptionRegionIds,
  )
  const blocks = [
    ...programListingBlocks(regions, claimedLineIds, claimedCaptionRegionIds),
    ...sourceEvidence.blocks,
    ...vectorPanelPreformattedBlocks(
      pages,
      regions,
      claimedLineIds,
      claimedCaptionRegionIds,
    ),
  ]
  return {
    blocks: blocks.sort((left, right) => {
      const leftLine = left.sourceLines[0]
      const rightLine = right.sourceLines[0]
      return leftLine && rightLine
        ? sourceLineOrder(leftLine, rightLine)
        : left.label.localeCompare(right.label)
    }),
    unresolved: sourceEvidence.unresolved,
  }
}
