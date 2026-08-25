import type {
  NormalizedSourceBox,
  PdfLineBoundaryDecision,
  PdfPageRegion,
} from './import-types'
import { replayPdfRegionLineRanges } from './pdf-lines'
import { fontNameIndicatesBold } from './pdf-visual-source-mapping'

const SECTION_ORDINAL_SOURCE =
  '(?:\\d+|[IVXLCDM]+|[ivxlcdm]+|[A-Za-z])(?:\\.\\d+){0,3}'

function structuralOrdinalHeadingText(text: string) {
  return /^(?:\d+(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?\s+\p{Lu}/u.test(
    text.trim(),
  )
}

function roundedSourceBoxCoordinate(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
}

function boxForRegionLines(lines: PdfPageRegion['lines']): NormalizedSourceBox {
  const left = Math.min(...lines.map((line) => line.box.x))
  const top = Math.min(...lines.map((line) => line.box.y))
  const right = Math.max(...lines.map((line) => line.box.x + line.box.width))
  const bottom = Math.max(...lines.map((line) => line.box.y + line.box.height))
  return {
    page: lines[0].box.page,
    x: roundedSourceBoxCoordinate(left),
    y: roundedSourceBoxCoordinate(top),
    width: roundedSourceBoxCoordinate(right - left),
    height: roundedSourceBoxCoordinate(bottom - top),
    rotation: lines[0].box.rotation,
    method: lines.some((line) => line.box.method === 'ocr')
      ? 'ocr'
      : 'pdf-text',
  }
}

export type PdfResidualRegionFragment = {
  region: PdfPageRegion
  sourceRegion: PdfPageRegion
  sourceStart: number
  sourceEnd: number
}

const MEDIUM_FACE_FONT_NAME =
  /(?:^|[+,._\s-])medi(?:um)?(?:(?:italic|ital|oblique|obl))?(?=$|[+,._\s-])/iu

export function fontNameIndicatesEmphasizedFace(fontName: string) {
  return fontNameIndicatesBold(fontName) || MEDIUM_FACE_FONT_NAME.test(fontName)
}

export function emphasizedLineShare(line: PdfPageRegion['lines'][number]) {
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

export function sourceStyledOrdinalSmallCapsHeading(
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

export function sourceStyledStandaloneBoundaryHeading(
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

export function splitLeadingStyledHeadingRegion(
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
