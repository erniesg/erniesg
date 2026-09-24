import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfPreformattedSource,
} from './import-types'
import {
  attachedPreformattedLabel,
  contiguousPreformattedFlow,
  exactPreformattedLineProof,
  hasLiteralLeadingWhitespace,
  monospacedSourceLine,
  normalizedLineageBox,
  orderedSourceLines,
  sourceIndentationListingEvidence,
  sourceLineOrder,
  sourceLineRecord,
  type BoundedPreformattedBlock,
  type BoundedPreformattedSegment,
  type PreformattedLineOwner,
  type UnresolvedPreformattedDetection,
} from './pdf-preformatted-source'

type PdfNativeObject = NonNullable<PdfPageAnalysis['objects']>[number]

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function boxForLines(lines: PdfPageRegion['lines']): NormalizedSourceBox {
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

export function sourceEvidencePreformattedBlocks(
  regions: PdfPageRegion[],
  claimedLineIds: Set<string>,
  claimedCaptionRegionIds: Set<string>,
) {
  const ordered = orderedSourceLines(regions)
  const blocks: BoundedPreformattedBlock[] = []
  const unresolved: UnresolvedPreformattedDetection[] = []

  const attachedCaption = (
    sourceLines: PreformattedLineOwner[],
    firstIndex: number,
    lastIndex: number,
  ) => {
    const first = sourceLines[0]
    const last = sourceLines.at(-1)!
    const candidates = [ordered[firstIndex - 1], ordered[lastIndex + 1]].filter(
      (
        candidate,
      ): candidate is PreformattedLineOwner & {
        canonicalOrder: number
      } => {
        if (!candidate || sourceLines.includes(candidate)) return false
        if (claimedCaptionRegionIds.has(candidate.region.id)) return false
        const before = candidate === ordered[firstIndex - 1]
        const gap = before
          ? first.line.box.y -
            (candidate.line.box.y + candidate.line.box.height)
          : candidate.line.box.y - (last.line.box.y + last.line.box.height)
        const samePage =
          candidate.line.box.page ===
          (before ? first.line.box.page : last.line.box.page)
        if (!samePage || gap < -0.006 || gap > 0.08) return false
        return (
          attachedPreformattedLabel(candidate.line.text) ||
          (before && /:\s*$/u.test(candidate.line.text.trim()))
        )
      },
    )
    const regionIds = new Set(candidates.map(({ region }) => region.id))
    return regionIds.size === 1 ? candidates[0] : null
  }

  const accept = (
    sourceLines: PreformattedLineOwner[],
    firstIndex: number,
    lastIndex: number,
    evidence: string,
  ) => {
    if (
      sourceLines.length < 3 ||
      sourceLines.some(({ line }) => claimedLineIds.has(line.id))
    ) {
      return
    }
    const caption = attachedCaption(sourceLines, firstIndex, lastIndex)
    if (!caption) {
      unresolved.push({
        page: sourceLines[0].line.box.page,
        regionIds: [...new Set(sourceLines.map(({ region }) => region.id))],
        sourceBoxes: sourceLines.map(({ line }) =>
          normalizedLineageBox(line.box),
        ),
      })
      return
    }
    const preformatted = exactPreformattedSource(sourceLines, true)
    blocks.push({
      caption: caption.region,
      label: attachedPreformattedLabel(caption.line.text)
        ? caption.line.text
            .trim()
            .match(
              /^(?:Algorithm|Listing)\s+(?:\d+(?:\.\d+)*[A-Za-z]?|[IVXLCDM]+)/iu,
            )![0]
        : `Code block p${String(sourceLines[0].line.box.page).padStart(3, '0')}-${String(
            blocks.filter(
              (block) => block.caption.page === sourceLines[0].line.box.page,
            ).length + 1,
          ).padStart(3, '0')}`,
      semanticKind: /^Algorithm\b/iu.test(caption.line.text.trim())
        ? 'algorithm'
        : 'code',
      sourceLines,
      segments: preformattedSegments(sourceLines),
      preformatted,
      evidence: [
        'source-preformatted-block',
        evidence,
        'source-region-lane-continuity',
        ...preformatted.evidence,
      ],
      captionFallbackLineId: null,
    })
    claimedCaptionRegionIds.add(caption.region.id)
    for (const { line } of sourceLines) claimedLineIds.add(line.id)
  }

  for (let index = 0; index < ordered.length; index += 1) {
    if (claimedLineIds.has(ordered[index].line.id)) continue
    if (monospacedSourceLine(ordered[index].line)) {
      const sourceLines = [ordered[index]]
      let lastIndex = index
      while (
        lastIndex + 1 < ordered.length &&
        !claimedLineIds.has(ordered[lastIndex + 1].line.id) &&
        monospacedSourceLine(ordered[lastIndex + 1].line) &&
        contiguousPreformattedFlow(ordered[lastIndex], ordered[lastIndex + 1])
      ) {
        sourceLines.push(ordered[++lastIndex])
      }
      if (sourceLines.length >= 3) {
        accept(sourceLines, index, lastIndex, 'monospaced-source-lines')
        index = lastIndex
        continue
      }
    }

    const anchor = ordered[index]
    if (
      monospacedSourceLine(anchor.line) ||
      (!attachedPreformattedLabel(anchor.line.text) &&
        !/:\s*$/u.test(anchor.line.text.trim()))
    ) {
      continue
    }
    const sourceLines: PreformattedLineOwner[] = []
    let lastIndex = index
    while (
      lastIndex + 1 < ordered.length &&
      !claimedLineIds.has(ordered[lastIndex + 1].line.id) &&
      (lastIndex === index
        ? ordered[lastIndex].line.box.page ===
            ordered[lastIndex + 1].line.box.page &&
          ordered[lastIndex + 1].line.box.y -
            (ordered[lastIndex].line.box.y +
              ordered[lastIndex].line.box.height) >=
            -0.006 &&
          ordered[lastIndex + 1].line.box.y -
            (ordered[lastIndex].line.box.y +
              ordered[lastIndex].line.box.height) <=
            0.08
        : contiguousPreformattedFlow(
            ordered[lastIndex],
            ordered[lastIndex + 1],
          ))
    ) {
      sourceLines.push(ordered[++lastIndex])
    }
    if (sourceIndentationListingEvidence(sourceLines)) {
      accept(
        sourceLines,
        index + 1,
        lastIndex,
        'source-indentation-and-ragged-measure',
      )
      index = lastIndex
    }
  }
  return { blocks, unresolved }
}

export function exactPreformattedSource(
  lines: PreformattedLineOwner[],
  allowTranscriptProof: boolean,
): PdfPreformattedSource {
  const ordered = [...lines].sort(sourceLineOrder)
  const lineProofs = ordered.map(({ line }) => exactPreformattedLineProof(line))
  const laneKey = ({ region, line }: PreformattedLineOwner) =>
    `${line.box.page}:${region.column}`
  const laneBaselines = new Map<string, number>()
  for (const owner of ordered) {
    const key = laneKey(owner)
    laneBaselines.set(
      key,
      Math.min(laneBaselines.get(key) ?? owner.line.box.x, owner.line.box.x),
    )
  }
  const relativeIndent = (owner: PreformattedLineOwner) =>
    owner.line.box.x - laneBaselines.get(laneKey(owner))!
  const stablePageIndent = ordered.every(
    (owner) => Math.abs(relativeIndent(owner)) <= 0.002,
  )
  const hasLiteralIndentation = ordered.some(({ line }) =>
    hasLiteralLeadingWhitespace(line.text),
  )
  const proved =
    allowTranscriptProof &&
    ordered.length > 0 &&
    lineProofs.every((proof) => proof !== null)
  const indentationLevels: number[] = []
  for (const owner of ordered) {
    const indent = relativeIndent(owner)
    const tolerance = Math.max(owner.line.box.height * 0.75, 0.006)
    if (
      !indentationLevels.some((level) => Math.abs(level - indent) <= tolerance)
    ) {
      indentationLevels.push(indent)
      indentationLevels.sort((left, right) => left - right)
    }
  }
  const recordedLines = ordered.map((owner) => {
    const indent = relativeIndent(owner)
    const level = indentationLevels.reduce(
      (best, candidate, index) =>
        Math.abs(candidate - indent) <
        Math.abs(indentationLevels[best] - indent)
          ? index
          : best,
      0,
    )
    // A source line may already carry literal indentation. In that case the
    // text itself is the lossless representation; adding a quantized geometry
    // class would double the visual indent. Geometry supplies indentation only
    // when extraction discarded the leading whitespace.
    const indentColumns =
      hasLiteralIndentation || stablePageIndent
        ? 0
        : Math.min(16, Math.max(0, level * 2))
    return sourceLineRecord(owner, indentColumns)
  })
  return {
    status: proved ? 'proved' : 'unresolved',
    lines: allowTranscriptProof ? recordedLines : [],
    evidence: proved
      ? [
          'deterministic-source-line-order',
          lineProofs.includes('exact-ordered-multi-run-line-text')
            ? 'exact-ordered-multi-run-line-text'
            : 'exact-single-run-line-text',
          'source-line-breaks-preserved',
          stablePageIndent
            ? 'zero-derived-indentation'
            : 'source-geometry-indentation',
        ]
      : [
          'deterministic-source-line-order',
          'source-text-exactness-unresolved',
          ...(allowTranscriptProof
            ? ['unresolved-source-lines-retained-for-review']
            : []),
        ],
  }
}

export function preformattedSegments(
  sourceLines: PreformattedLineOwner[],
  sourceObjects: PdfNativeObject[] = [],
) {
  const lanes = [
    ...new Map(
      sourceLines.map((owner) => [
        `${owner.line.box.page}:${owner.region.column}`,
        { page: owner.line.box.page, column: owner.region.column },
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.page - right.page ||
      (left.column === 'left' ? 0 : left.column === 'right' ? 1 : -1) -
        (right.column === 'left' ? 0 : right.column === 'right' ? 1 : -1),
  )
  return lanes.map<BoundedPreformattedSegment>(({ page, column }) => {
    const pageLines = sourceLines
      .filter(
        ({ region, line }) =>
          line.box.page === page && region.column === column,
      )
      .sort(sourceLineOrder)
    const pageObjects = sourceObjects
      .filter((object) => object.page === page)
      .sort(
        (left, right) =>
          left.box.y - right.box.y ||
          left.box.x - right.box.x ||
          left.id.localeCompare(right.id),
      )
    const lineBox = boxForLines(pageLines.map(({ line }) => line))
    const sourceRegions = [
      ...new Map(
        pageLines.map(({ region }) => [region.id, region] as const),
      ).values(),
    ]
    // Some PDF text layers report a line box that ends before its final
    // painted glyph. The owning region is the conservative source boundary
    // for an exact code crop; using only the line box can clip long code lines.
    const sourceBoxes = [
      lineBox,
      ...sourceRegions.map((region) => region.box),
      ...pageObjects.map((object) => object.box),
    ]
    const left = Math.min(...sourceBoxes.map((box) => box.x))
    const top = Math.min(...sourceBoxes.map((box) => box.y))
    const right = Math.max(...sourceBoxes.map((box) => box.x + box.width))
    const bottom = Math.max(...sourceBoxes.map((box) => box.y + box.height))
    return {
      page,
      sourceLines: pageLines,
      sourceBox: {
        page,
        x: rounded(left),
        y: rounded(top),
        width: rounded(right - left),
        height: rounded(bottom - top),
        rotation: lineBox.rotation,
        method:
          pageObjects.length > 0 ? ('pdf-object' as const) : lineBox.method,
      },
      sourceObjectIds: pageObjects.map((object) => object.id),
      sourceObjectBoxes: pageObjects.map((object) =>
        normalizedLineageBox(object.box),
      ),
    }
  })
}

export function retainedCaptionText(
  caption: PdfPageRegion,
  sourceLineIds: ReadonlySet<string>,
) {
  return caption.lines
    .filter((line) => !sourceLineIds.has(line.id))
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join(' ')
}
