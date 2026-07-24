import type {
  NormalizedSourceBox,
  PdfLineBoundaryDecision,
  PdfNoteMarkerClassification,
  PdfNoteMarkerTaxonomy,
  PdfPageRegion,
} from './import-types'
import { replayPdfRegionLineRanges } from './pdf-lines'
import { normalizedNoteLabel, noteLabelFromText } from './pdf-regions'

export const PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD = 0.85
export const PDF_NOTE_CITATION_DENSITY_THRESHOLD = 2
const PDF_MINIMUM_SEMANTIC_MARKER_FONT_SIZE = 5

type MarkerSyntax =
  | 'explicit-note-language'
  | 'author-year-syntax'
  | 'bracketed-numeric-syntax'
  | 'superscript-cluster-syntax'
  | 'superscript-syntax'
  | 'rendered-superscript-geometry'

type MarkerCandidate = {
  label: string
  labels: string[]
  region: PdfPageRegion
  start: number
  end: number
  syntax: MarkerSyntax
  sourceBox: NormalizedSourceBox
}

export type PdfNoteMarkerClassificationResult = {
  classifications: PdfNoteMarkerClassification[]
  bibliographyRegionIds: string[]
  noteBodyRegionIds: string[]
}

export type PdfCompoundAffiliationNoteSegment = {
  label: string
  markerText: string
  text: string
  sourceStart: number
  sourceEnd: number
  sourceLineIds: string[]
}

export type PdfCompoundAffiliationNote = {
  affiliations: PdfCompoundAffiliationNoteSegment[]
  correspondence?: PdfCompoundAffiliationNoteSegment
}

const REFERENCE_HEADING =
  /^(?:(?:\d+(?:\.\d+)*)\s+)?(?:references|bibliography|works cited|literature cited)$/i
const REFERENCE_SECTION_END =
  /^(?:appendix\b|acknowledg(?:e)?ments?\b|supplement(?:ary)?\b|author contributions?\b|data availability\b)/i
const BODY_SECTION_HEADING = /^(?:abstract|introduction)\b/i
const NOTE_TOKEN_SOURCE = String.raw`(?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*∗†‡§])`
const AUTHOR_YEAR_SURNAME_SOURCE = String.raw`\p{Lu}[\p{L}\p{M}'’.-]*`
const AUTHOR_YEAR_SOURCE = String.raw`(?:18|19|20)\d{2}[a-z]?`
const MAX_EXPANDED_CITATION_RANGE = 100

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function markerSlug(value: string) {
  return (
    normalizedNoteLabel(value)
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'marker'
  )
}

function markerSourceAnchor(
  marker: Pick<
    PdfNoteMarkerClassification,
    'referenceRegionId' | 'start' | 'end'
  >,
) {
  return `${markerSlug(marker.referenceRegionId)}-s${String(marker.start).padStart(6, '0')}-e${String(marker.end).padStart(6, '0')}`
}

function positionCompare(left: PdfPageRegion, right: PdfPageRegion) {
  return (
    left.page - right.page ||
    left.box.y - right.box.y ||
    left.box.x - right.box.x ||
    left.id.localeCompare(right.id)
  )
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle]
}

function endsReferenceSection(region: PdfPageRegion, bodyFontSize: number) {
  const text = region.text.trim()
  if (REFERENCE_SECTION_END.test(text)) return true
  const largestFontSize = Math.max(
    ...region.lines.map((line) => line.fontSize),
    0,
  )
  const emphasizedFace = region.lines.some((line) =>
    line.runs.some((run) =>
      /(?:bold|semi[- ]?bold|demi|medi)/iu.test(run.fontName),
    ),
  )
  return (
    bodyFontSize > 0 &&
    region.lines.length > 0 &&
    region.lines.length <= 2 &&
    text.length <= 180 &&
    /^[A-Z](?:\.)?\s+\p{Lu}/u.test(text) &&
    (largestFontSize >= bodyFontSize * 1.12 || emphasizedFace)
  )
}

function sourceBox(region: PdfPageRegion): NormalizedSourceBox {
  return { ...region.box }
}

function escapedPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function declaredTitlePageAffiliationLabels(
  orderedRegions: readonly PdfPageRegion[],
  firstBodySectionY: number,
) {
  const labels = new Set<string>()
  for (const region of orderedRegions) {
    if (
      region.page !== 1 ||
      region.box.y >= Math.min(0.34, firstBodySectionY) ||
      region.lines.length === 0 ||
      region.lines.length > 2 ||
      region.text.length > 180 ||
      /[.!?](?:\s|$)/u.test(region.text)
    ) {
      continue
    }
    const runs = region.lines
      .flatMap((line) => line.runs)
      .filter((run) => run.text.trim())
    const largestRun = Math.max(...runs.map((run) => run.fontSize), 0)
    const isNumericMarkerRun = (run: (typeof runs)[number]) =>
      /^\d{1,3}(?:,\d{1,3})*$/u.test(normalizedNoteLabel(run.text)) &&
      run.fontSize <= largestRun * 0.82
    if (!runs[0] || !isNumericMarkerRun(runs[0])) continue
    for (const run of runs.filter(isNumericMarkerRun)) {
      for (const label of normalizedNoteLabel(run.text).split(',')) {
        labels.add(label)
      }
    }
  }
  return labels
}

function hasTitlePageAffiliationLabel(
  candidate: MarkerCandidate,
  orderedRegions: readonly PdfPageRegion[],
  firstBodySectionY: number | undefined,
) {
  if (
    firstBodySectionY === undefined ||
    candidate.region.page !== 1 ||
    candidate.region.box.y >= firstBodySectionY ||
    !(
      candidate.syntax === 'superscript-syntax' ||
      candidate.syntax === 'rendered-superscript-geometry'
    ) ||
    !candidate.labels.every((label) => /^\d{1,3}$/u.test(label))
  ) {
    return false
  }
  const affiliationRegions = orderedRegions.filter(
    (region) => region.page === 1 && region.box.y < firstBodySectionY,
  )
  const declaredLabels = declaredTitlePageAffiliationLabels(
    orderedRegions,
    firstBodySectionY,
  )
  if (candidate.labels.every((label) => declaredLabels.has(label))) {
    return true
  }
  return candidate.labels.every((label) => {
    const marker = new RegExp(`(?:^|[\\s,;])${escapedPattern(label)}\\s*`, 'gu')
    return affiliationRegions.some((region) => {
      const text =
        region.id === candidate.region.id
          ? region.text.slice(candidate.end)
          : region.text
      for (const match of text.matchAll(marker)) {
        const tail = text.slice(
          (match.index ?? 0) + match[0].length,
          (match.index ?? 0) + match[0].length + 140,
        )
        if (
          /\b(?:university|institute|laborator(?:y|ies)|college|department|school|faculty|centre|center|research|company|corporation|studios?|technology|polytechnic|berkeley|ucla|meta|ai)\b/iu.test(
            tail,
          )
        ) {
          return true
        }
      }
      return false
    })
  })
}

function isTitlePageAffiliationDeclaration(
  candidate: MarkerCandidate,
  firstBodySectionY: number | undefined,
) {
  if (
    firstBodySectionY === undefined ||
    candidate.region.page !== 1 ||
    candidate.region.box.y >= Math.min(0.34, firstBodySectionY) ||
    candidate.region.lines.length === 0 ||
    candidate.syntax !== 'rendered-superscript-geometry' ||
    !candidate.labels.every((label) => /^\d{1,3}$/u.test(label))
  ) {
    return false
  }
  const markerCenterY = candidate.sourceBox.y + candidate.sourceBox.height / 2
  const declarationLine = candidate.region.lines.find(
    (line) =>
      markerCenterY >= line.box.y - 0.004 &&
      markerCenterY <= line.box.y + line.box.height + 0.004 &&
      line.text.length <= 180 &&
      !/[.!?](?:\s|$)/u.test(line.text) &&
      /^\s*\d{1,3}\s*\p{L}/u.test(line.text),
  )
  if (!declarationLine) return false
  const runs = declarationLine.runs.filter((run) => run.text.trim())
  const firstRun = runs[0]
  const largestRun = Math.max(...runs.map((run) => run.fontSize), 0)
  return Boolean(
    firstRun &&
    /^\d{1,3}$/u.test(normalizedNoteLabel(firstRun.text)) &&
    firstRun.fontSize <= largestRun * 0.82,
  )
}

export function noteLabelsFromMarkerText(value: string) {
  const labels: string[] = []
  const pattern = new RegExp(
    `(${NOTE_TOKEN_SOURCE})(?:\\s*[–—-]\\s*(${NOTE_TOKEN_SOURCE}))?`,
    'gu',
  )
  const add = (label: string) => {
    if (label && !labels.includes(label)) labels.push(label)
  }
  for (const match of value.matchAll(pattern)) {
    const first = normalizedNoteLabel(match[1])
    const last = match[2] ? normalizedNoteLabel(match[2]) : null
    const firstOrdinal = /^\d+$/.test(first) ? Number(first) : null
    const lastOrdinal = last && /^\d+$/.test(last) ? Number(last) : null
    if (
      firstOrdinal !== null &&
      lastOrdinal !== null &&
      lastOrdinal >= firstOrdinal &&
      lastOrdinal - firstOrdinal <= MAX_EXPANDED_CITATION_RANGE
    ) {
      for (let ordinal = firstOrdinal; ordinal <= lastOrdinal; ordinal += 1) {
        add(String(ordinal))
      }
      continue
    }
    add(first)
    if (last) add(last)
  }
  return labels
}

function isMathematicalBracket(text: string, start: number) {
  if (/^\[\s*0\s*,\s*1\s*\]/u.test(text.slice(start))) return true
  const prefix = text.slice(Math.max(0, start - 64), start).trimEnd()
  return /(?:[:=∈∉≤≥<>+\-−×÷*/]|\b(?:set|list|array|vector|matrix|tuple|values?|numbers?|tokens?|tokenizes?|integers?|ranges?|periods?|moduli|indices|dimensions?|shape)\s*(?::|=)?)$/iu.test(
    prefix,
  )
}

function isMathematicalInlineAsterisk(
  text: string,
  start: number,
  end: number,
) {
  const before = text.slice(0, start).match(/(\S)\s*$/u)?.[1] ?? ''
  const after = text.slice(end).match(/^\s*(\S)/u)?.[1] ?? ''
  return /[\d)\]}]/u.test(before) && /[\d([{]/u.test(after)
}

function repeatedRenderedNameTokens(regions: readonly PdfPageRegion[]) {
  const counts = new Map<string, number>()
  for (const region of regions) {
    for (const match of region.text.matchAll(
      /(?<![\p{L}\p{M}\d])(\p{Lu}[\p{L}\p{M}]{1,11}\d{1,3})(?![\p{L}\p{M}\d])/gu,
    )) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
    }
  }
  return new Set(
    [...counts].flatMap(([token, count]) => (count >= 2 ? [token] : [])),
  )
}

function isMathematicalScript(
  text: string,
  start: number,
  end: number,
  repeatedNameTokens: ReadonlySet<string> = new Set(),
) {
  const scriptCharacters = '0-9⁰¹²³⁴⁵⁶⁷⁸⁹'
  const tokenCharacters = new RegExp(`[\\p{L}${scriptCharacters}]`, 'u')
  let tokenStart = start
  let tokenEnd = end
  while (tokenStart > 0 && tokenCharacters.test(text[tokenStart - 1])) {
    tokenStart -= 1
  }
  while (tokenEnd < text.length && tokenCharacters.test(text[tokenEnd])) {
    tokenEnd += 1
  }
  const token = text.slice(tokenStart, tokenEnd)
  const variableWithScript = new RegExp(
    `^[\\p{L}][${scriptCharacters}]+$`,
    'u',
  ).test(token)
  const greekVariableWithScript = new RegExp(
    `^[${scriptCharacters}]*\\p{Script=Greek}[\\p{L}\\p{M}]{0,3}[${scriptCharacters}]+$`,
    'u',
  ).test(token)
  let tokenOccurrences = 0
  for (
    let occurrence = text.indexOf(token);
    token && occurrence >= 0;
    occurrence = text.indexOf(token, occurrence + token.length)
  ) {
    tokenOccurrences += 1
  }
  const repeatedNamedScript =
    new RegExp(`^[\\p{L}]{2,12}[${scriptCharacters}]+$`, 'u').test(token) &&
    tokenOccurrences >= 2
  const before = text.slice(Math.max(0, start - 1), start)
  const beforeWindow = text.slice(Math.max(0, start - 32), start)
  const after = text.slice(end, end + 8)
  const decoratedVariableBefore = /[\p{L}\p{N}][\p{M}ˆ̂~¯ˇ˘˙¨˚´`]+$/u.test(
    beforeWindow,
  )
  const poweredMathematicalGroup =
    /[)\]}]$/u.test(before) &&
    /[([{][^()[\]{}]{0,24}(?:[∆∂∑√=+\-−×÷≤≥≈∈∉]|\p{L}\p{M})[^()[\]{}]{0,24}[)\]}]$/u.test(
      beforeWindow,
    )
  const poweredVariableGroup =
    /(?:[\p{L}\p{N}′'][([{]\p{L}{1,4}[)\]}]|[([{]d\p{L}[)\]}])$/u.test(
      beforeWindow,
    )
  const mathematicalDelimiterAdjacent =
    /[⎧⎫⎩⎭⎨⎬⎪⎡⎤⎣⎦]/u.test(before) || /^[⎧⎫⎩⎭⎨⎬⎪⎡⎤⎣⎦]/u.test(after)
  const mathematicalOperatorAdjacent =
    /(?:=|[∑∫√])\s*$/u.test(beforeWindow) || /^\s*[∑∫√]/u.test(after)
  const scientificNotationExponent = /(?:\d|[eE])[-−]\s*$/u.test(beforeWindow)
  const parenthesizedMathematicalIndex =
    /\p{L}\s*\(\s*$/u.test(beforeWindow) && /^\s*\)/u.test(after)
  const embeddedBetweenSymbols =
    /[\p{L}\p{N})\]}]/u.test(before) && /^[\p{L}\p{N}([{]/u.test(after)
  const followedByMathematicalRelation =
    /[\p{L}\p{N})\]}]/u.test(before) && /^\s*(?:=|[+\-−×÷≤≥≈∈∉])/u.test(after)
  return (
    variableWithScript ||
    greekVariableWithScript ||
    repeatedNamedScript ||
    repeatedNameTokens.has(token) ||
    decoratedVariableBefore ||
    poweredMathematicalGroup ||
    poweredVariableGroup ||
    mathematicalDelimiterAdjacent ||
    mathematicalOperatorAdjacent ||
    scientificNotationExponent ||
    parenthesizedMathematicalIndex ||
    embeddedBetweenSymbols ||
    followedByMathematicalRelation
  )
}

function isRenderedPowerOfTenExponent(
  line: PdfPageRegion['lines'][number],
  runIndex: number,
) {
  const run = line.runs[runIndex]
  if (!run || !/^\d$/u.test(normalizedNoteLabel(run.text))) return false
  for (let index = runIndex - 1; index >= 0; index -= 1) {
    const previousText = line.runs[index].text.trim()
    if (!previousText) continue
    return previousText === '10'
  }
  return false
}

function markerCandidates(
  region: PdfPageRegion,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
  repeatedNameTokens: ReadonlySet<string>,
) {
  const found: MarkerCandidate[] = []
  const add = (
    rawLabels: string[],
    start: number,
    end: number,
    syntax: MarkerSyntax,
    box = sourceBox(region),
  ) => {
    const labels = rawLabels.map(normalizedNoteLabel).filter(Boolean)
    if (labels.length === 0 || start < 0 || end <= start) return
    const overlappingIndex = found.findIndex(
      (candidate) =>
        Math.max(candidate.start, start) < Math.min(candidate.end, end),
    )
    if (overlappingIndex >= 0) {
      const overlapping = found[overlappingIndex]
      const strongerGeometryRange =
        syntax === 'rendered-superscript-geometry' &&
        overlapping.syntax === 'superscript-syntax' &&
        start <= overlapping.start &&
        end >= overlapping.end &&
        end - start > overlapping.end - overlapping.start
      if (!strongerGeometryRange) return
      found.splice(overlappingIndex, 1)
    }
    found.push({
      label: labels.join(','),
      labels,
      region,
      start,
      end,
      syntax,
      sourceBox: box,
    })
  }

  const explicit =
    /\b(?:footnote|note)\s+(?:(?:reference|marker)\s+)?(\d{1,3}|[*∗†‡§])(?=\s|[.,;:)\]]|$)/giu
  for (const match of region.text.matchAll(explicit)) {
    const label = match[1]
    const start = (match.index ?? 0) + match[0].lastIndexOf(label)
    add([label], start, start + label.length, 'explicit-note-language')
  }

  const bracketed =
    /\[\s*((?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*∗†‡§])(?:\s*(?:[,;]|[–—-])\s*(?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*∗†‡§]))*)\s*\]/gu
  for (const match of region.text.matchAll(bracketed)) {
    const start = match.index ?? 0
    if (isMathematicalBracket(region.text, start)) continue
    add(
      noteLabelsFromMarkerText(match[1]),
      start,
      start + match[0].length,
      'bracketed-numeric-syntax',
    )
  }

  const superscriptCluster = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\s*[,;˒]\s*[⁰¹²³⁴⁵⁶⁷⁸⁹]+)+/gu
  for (const match of region.text.matchAll(superscriptCluster)) {
    const start = match.index ?? 0
    if (isMathematicalScript(region.text, start, start + match[0].length)) {
      continue
    }
    add(
      noteLabelsFromMarkerText(match[0]),
      start,
      start + match[0].length,
      'superscript-cluster-syntax',
    )
  }

  const inlineSuperscript = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu
  for (const match of region.text.matchAll(inlineSuperscript)) {
    const start = match.index ?? 0
    if (isMathematicalScript(region.text, start, start + match[0].length)) {
      continue
    }
    add([match[0]], start, start + match[0].length, 'superscript-syntax')
  }

  const inlineSymbol = /[*∗†‡§]/gu
  for (const match of region.text.matchAll(inlineSymbol)) {
    const start = match.index ?? 0
    if (
      (match[0] === '*' || match[0] === '∗') &&
      isMathematicalInlineAsterisk(region.text, start, start + match[0].length)
    ) {
      continue
    }
    add([match[0]], start, start + match[0].length, 'superscript-syntax')
  }

  const replay = replayPdfRegionLineRanges(region, lineBoundaryDecisions)
  const exactReplay = replay?.text === region.text ? replay : null
  for (const line of region.lines) {
    const lineRange = exactReplay?.ranges.get(line.id)
    if (!lineRange) continue
    const lineText = line.text.replace(/\s+/g, ' ').trim()
    const largestRun = Math.max(...line.runs.map((run) => run.fontSize), 0)
    const baselineRuns = line.runs.filter(
      (run) => run.fontSize >= largestRun * 0.9,
    )
    const baselineCenter =
      baselineRuns.reduce((total, run) => total + run.y + run.height / 2, 0) /
      Math.max(1, baselineRuns.length)
    let runTextCursor = 0
    for (const [runIndex, run] of line.runs.entries()) {
      const raw = run.text.trim().replace(/\s+/g, ' ')
      const label = normalizedNoteLabel(raw)
      const geometryLabels = noteLabelsFromMarkerText(raw)
      const geometryParts = [...raw.matchAll(/[*∗†‡§]|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|\d{1,3}/gu)]
      const geometryResidue = raw
        .replace(/[*∗†‡§]|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|\d{1,3}/gu, '')
        .replace(/[\s,;˒]/gu, '')
      const rawPosition = lineText.indexOf(raw, runTextCursor)
      const labelPosition =
        rawPosition < 0 ? lineText.indexOf(label, runTextCursor) : -1
      const withinLine = Math.max(rawPosition, labelPosition)
      if (withinLine >= 0) {
        runTextCursor = withinLine + raw.length
      }
      const runCenter = run.y + run.height / 2
      const baselineHeight = Math.max(
        ...baselineRuns.map((candidate) => candidate.height),
        0,
      )
      if (
        run.fontSize < PDF_MINIMUM_SEMANTIC_MARKER_FONT_SIZE ||
        geometryParts.length === 0 ||
        geometryResidue !== '' ||
        geometryLabels.length === 0 ||
        run.fontSize > largestRun * 0.82 ||
        runCenter >= baselineCenter - Math.max(0.0005, baselineHeight * 0.04)
      ) {
        continue
      }
      if (withinLine < 0) continue
      const start = lineRange.start + withinLine
      const end = start + raw.length
      if (region.text.slice(start, end) !== raw) continue
      if (isMathematicalScript(region.text, start, end, repeatedNameTokens)) {
        continue
      }
      if (isRenderedPowerOfTenExponent(line, runIndex)) continue
      const box = {
        page: run.page,
        x: run.x,
        y: run.y,
        width: run.width,
        height: run.height,
        rotation: run.rotation,
        method: run.method,
      }
      if (geometryParts.length > 1) {
        for (const part of geometryParts) {
          const partStart = start + (part.index ?? 0)
          add(
            [part[0]],
            partStart,
            partStart + part[0].length,
            'rendered-superscript-geometry',
            box,
          )
        }
      } else {
        add(geometryLabels, start, end, 'rendered-superscript-geometry', box)
      }
    }
  }

  return found.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )
}

function normalizedCompoundNoteText(value: string) {
  return value.replace(/\s+/gu, ' ').trim()
}

function sourceLineIdsForRange(
  region: PdfPageRegion,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
  start: number,
  end: number,
) {
  const replay = replayPdfRegionLineRanges(region, lineBoundaryDecisions)
  if (!replay || replay.text !== region.text) return []
  return region.lines.flatMap((line) => {
    const range = replay.ranges.get(line.id)
    return range && Math.max(start, range.start) < Math.min(end, range.end)
      ? [line.id]
      : []
  })
}

/**
 * Some title-page footers place several independently raised numeric
 * affiliation definitions in one physical region. Split only a monotonic,
 * multi-label run with visible text after every marker; a single ordinary
 * footnote and prose numerals remain untouched.
 */
export function splitPdfCompoundAffiliationNote(
  region: PdfPageRegion,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[] = [],
): PdfCompoundAffiliationNote | null {
  if (
    region.page !== 1 ||
    (region.kind !== 'footnote' && region.kind !== 'endnote') ||
    region.lines.length < 2
  ) {
    return null
  }
  const markers = markerCandidates(
    region,
    lineBoundaryDecisions,
    new Set<string>(),
  )
    .filter(
      (candidate) =>
        candidate.syntax === 'rendered-superscript-geometry' &&
        candidate.labels.length === 1 &&
        /^\d{1,3}$/u.test(candidate.labels[0]) &&
        /^\s*\p{L}/u.test(region.text.slice(candidate.end)),
    )
    .filter(
      (candidate, index, candidates) =>
        index === 0 || candidate.start !== candidates[index - 1].start,
    )
  if (markers.length < 2) return null
  const ordinals = markers.map((marker) => Number(marker.labels[0]))
  if (
    new Set(ordinals).size !== ordinals.length ||
    ordinals.some(
      (ordinal, index) => index > 0 && ordinal <= ordinals[index - 1],
    )
  ) {
    return null
  }

  const lastMarker = markers.at(-1)!
  const trailingText = region.text.slice(lastMarker.end)
  const correspondenceMatch = trailingText.match(
    /\bcorrespon(?:-\s*)?dence\s+to\s*:\s*/iu,
  )
  const correspondenceStart =
    correspondenceMatch?.index === undefined
      ? null
      : lastMarker.end + correspondenceMatch.index
  const affiliations = markers.flatMap<PdfCompoundAffiliationNoteSegment>(
    (marker, index) => {
      const nextMarker = markers[index + 1]
      const sourceEnd =
        nextMarker?.start ??
        (correspondenceStart === null
          ? region.text.length
          : correspondenceStart)
      const value = normalizedCompoundNoteText(
        region.text.slice(marker.end, sourceEnd),
      )
      return value
        ? [
            {
              label: marker.labels[0],
              markerText: region.text.slice(marker.start, marker.end),
              text: value,
              sourceStart: marker.start,
              sourceEnd,
              sourceLineIds: sourceLineIdsForRange(
                region,
                lineBoundaryDecisions,
                marker.start,
                sourceEnd,
              ),
            },
          ]
        : []
    },
  )
  if (affiliations.length !== markers.length) return null

  const correspondence =
    correspondenceStart === null || !correspondenceMatch
      ? undefined
      : (() => {
          const contentStart =
            correspondenceStart + correspondenceMatch[0].length
          const value = normalizedCompoundNoteText(
            region.text.slice(contentStart),
          )
          return value
            ? {
                label: 'Correspondence',
                markerText: 'Correspondence',
                text: value,
                sourceStart: correspondenceStart,
                sourceEnd: region.text.length,
                sourceLineIds: sourceLineIdsForRange(
                  region,
                  lineBoundaryDecisions,
                  correspondenceStart,
                  region.text.length,
                ),
              }
            : undefined
        })()
  return {
    affiliations,
    ...(correspondence ? { correspondence } : {}),
  }
}

function noteDefinitionLabels(
  region: PdfPageRegion,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const compound = splitPdfCompoundAffiliationNote(
    region,
    lineBoundaryDecisions,
  )
  if (compound) return compound.affiliations.map(({ label }) => label)
  const label = noteLabelFromText(region.text)
  return label === null ? [] : [normalizedNoteLabel(label)]
}

function normalizedAuthorYearKey(surname: string, year: string) {
  const normalizedSurname = surname
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/’/gu, "'")
    .toLowerCase()
  return `${normalizedSurname}:${year.toLowerCase()}`
}

function bibliographyFirstAuthorSurname(text: string) {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return (
    normalized.match(/^(\p{Lu}[\p{L}\p{M}'’.-]*)(?=\s*,|\s+et\s+al\.)/u)?.[1] ??
    normalized.match(
      /^(?:\p{Lu}[\p{L}\p{M}'’.-]*\s+)+(\p{Lu}[\p{L}\p{M}'’.-]*)(?=\s*,)/u,
    )?.[1]
  )
}

function bibliographyYearCandidates(text: string) {
  const paginationYearOffsets = new Set<number>()
  for (const match of text.matchAll(
    /(?:\b\d{1,4}\s*:|\bpp?\.?\s+|\bpages?\s+)((?:18|19|20)\d{2})\s*[–—-]\s*((?:18|19|20)\d{2})\b/giu,
  )) {
    const matchStart = match.index ?? 0
    const firstLocalOffset = match[0].indexOf(match[1])
    const secondLocalOffset = match[0].indexOf(
      match[2],
      firstLocalOffset + match[1].length,
    )
    paginationYearOffsets.add(matchStart + firstLocalOffset)
    paginationYearOffsets.add(matchStart + secondLocalOffset)
  }
  return [
    ...new Set(
      [...text.matchAll(/\b((?:18|19|20)\d{2}[a-z]?)\b/gu)]
        .filter((match) => !paginationYearOffsets.has(match.index ?? 0))
        .map((match) => match[1].toLowerCase()),
    ),
  ]
}

function bibliographyPublicationYear(text: string) {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  const beforeExternalIdentifier =
    normalized.split(
      /\b(?:URL|doi|https?:|www\.|arXiv(?:\s+preprint)?(?:\s+arXiv:)?|abs\/)/iu,
      1,
    )[0] ?? ''
  const yearsBeforeExternalIdentifier = bibliographyYearCandidates(
    beforeExternalIdentifier,
  )
  if (yearsBeforeExternalIdentifier.length === 1) {
    return yearsBeforeExternalIdentifier[0]
  }
  if (yearsBeforeExternalIdentifier.length > 1) {
    const suffixedYears = yearsBeforeExternalIdentifier.filter((year) =>
      /[a-z]$/u.test(year),
    )
    const suffixedYear = suffixedYears.length === 1 ? suffixedYears[0] : null
    if (
      suffixedYear &&
      yearsBeforeExternalIdentifier.every(
        (year) => year.replace(/[a-z]$/u, '') === suffixedYear.slice(0, -1),
      )
    ) {
      return suffixedYear
    }
    return null
  }
  const allYears = bibliographyYearCandidates(normalized)
  return allYears.length === 1 ? allYears[0] : null
}

function bibliographyAuthorYearKey(text: string) {
  const surname = bibliographyFirstAuthorSurname(text)
  const year = bibliographyPublicationYear(text)
  return surname && year ? normalizedAuthorYearKey(surname, year) : null
}

function authorYearMarkerCandidates(
  region: PdfPageRegion,
  uniqueBibliographyKeys: ReadonlySet<string>,
) {
  const found: MarkerCandidate[] = []
  const add = (labels: string[], start: number, end: number) => {
    if (labels.length === 0 || start < 0 || end <= start) return
    found.push({
      label: labels.join(','),
      labels,
      region,
      start,
      end,
      syntax: 'author-year-syntax',
      sourceBox: sourceBox(region),
    })
  }
  const etAlComponent = new RegExp(
    `^\\s*(${AUTHOR_YEAR_SURNAME_SOURCE})\\s+et\\s+al\\.\\s*,\\s*(${AUTHOR_YEAR_SOURCE})\\s*$`,
    'u',
  )
  const commonComponent = new RegExp(
    `^\\s*(${AUTHOR_YEAR_SURNAME_SOURCE})(?:\\s+(?:&|and)\\s+(${AUTHOR_YEAR_SURNAME_SOURCE}))?\\s*,\\s*(${AUTHOR_YEAR_SOURCE})\\s*$`,
    'u',
  )
  for (const match of region.text.matchAll(/\([^()]{1,240}\)/gu)) {
    const content = match[0].slice(1, -1)
    const parts = [...content.matchAll(/[^;]+/gu)]
    const parsed = parts.map((part) => {
      const etAl = part[0].match(etAlComponent)
      if (etAl) {
        return {
          key: normalizedAuthorYearKey(etAl[1], etAl[2]),
          requiresExactBibliographyKey: false,
        }
      }
      const common = part[0].match(commonComponent)
      if (!common) return null
      return {
        key: normalizedAuthorYearKey(common[1], common[3]),
        requiresExactBibliographyKey: true,
      }
    })
    if (parsed.some((part) => !part)) continue
    for (const [index, part] of parts.entries()) {
      const candidate = parsed[index]!
      if (
        candidate.requiresExactBibliographyKey &&
        !uniqueBibliographyKeys.has(candidate.key)
      ) {
        continue
      }
      const raw = part[0]
      const leadingWhitespace = raw.length - raw.trimStart().length
      const start =
        (match.index ?? 0) + 1 + (part.index ?? 0) + leadingWhitespace
      const end =
        (match.index ?? 0) + 1 + (part.index ?? 0) + raw.trimEnd().length
      add([candidate.key], start, end)
    }
  }
  const narrative = new RegExp(
    `(?<![\\p{L}\\p{M}'’.-])(${AUTHOR_YEAR_SURNAME_SOURCE})\\s+et\\s+al\\.\\s*\\(\\s*(${AUTHOR_YEAR_SOURCE})\\s*\\)`,
    'gu',
  )
  for (const match of region.text.matchAll(narrative)) {
    const start = match.index ?? 0
    add(
      [normalizedAuthorYearKey(match[1], match[2])],
      start,
      start + match[0].length,
    )
  }
  const commonNarrative = new RegExp(
    `(?<![\\p{L}\\p{M}'’.-])(${AUTHOR_YEAR_SURNAME_SOURCE})(?:\\s+(?:&|and)\\s+(${AUTHOR_YEAR_SURNAME_SOURCE}))?\\s*\\(\\s*(${AUTHOR_YEAR_SOURCE})\\s*\\)`,
    'gu',
  )
  for (const match of region.text.matchAll(commonNarrative)) {
    const key = normalizedAuthorYearKey(match[1], match[3])
    if (!uniqueBibliographyKeys.has(key)) continue
    const start = match.index ?? 0
    add([key], start, start + match[0].length)
  }
  return found.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )
}

function contextualTaxonomy(
  candidate: MarkerCandidate,
): PdfNoteMarkerTaxonomy | null {
  const prefix = candidate.region.text
    .slice(Math.max(0, candidate.start - 64), candidate.start)
    .trimEnd()
  if (/(?:equation|eq\.?)\s*(?:\(?\s*)?$/i.test(prefix)) {
    return 'equation-reference'
  }
  if (/(?:section|sec\.?)\s*(?:\(?\s*)?$/i.test(prefix)) {
    return 'section-reference'
  }
  return null
}

function classification(
  candidate: MarkerCandidate,
  taxonomy: PdfNoteMarkerTaxonomy,
  disposition: PdfNoteMarkerClassification['disposition'],
  confidence: number,
  evidence: string[],
): Omit<PdfNoteMarkerClassification, 'id'> {
  return {
    label: candidate.label,
    referenceRegionId: candidate.region.id,
    start: candidate.start,
    end: candidate.end,
    taxonomy,
    disposition,
    confidence: rounded(confidence),
    threshold: PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
    accepted: confidence >= PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
    evidence: [...new Set([candidate.syntax, ...evidence])],
    sourceBox: candidate.sourceBox,
  }
}

function bibliographyEntryMarker(region: PdfPageRegion) {
  const normalized = normalizedNoteLabel(region.text)
  const bracketed = normalized.match(/^\s*\[\s*(\d{1,3}|[*†‡§])\s*\](?=\s|$)/u)
  if (bracketed?.[1]) {
    const start = Math.max(0, normalized.indexOf(bracketed[1]))
    return {
      label: bracketed[1],
      start,
      end: start + bracketed[1].length,
      syntax: 'bracketed-numeric-syntax' as const,
    }
  }
  const label = noteLabelFromText(normalized)
  if (!label) return null
  const start = Math.max(0, normalized.indexOf(label))
  return {
    label: normalizedNoteLabel(label),
    start,
    end: start + label.length,
    syntax: 'rendered-superscript-geometry' as const,
  }
}

export function pdfRegionHasStrongBibliographyEntryEvidence(
  region: PdfPageRegion,
) {
  const marker = bibliographyEntryMarker(region)
  if (!marker || marker.syntax !== 'bracketed-numeric-syntax') return false
  const itemText = normalizedNoteLabel(region.text).slice(marker.end).trim()
  const nonemptyLines = region.lines.filter((line) => line.text.trim())
  const firstLine = nonemptyLines[0]
  const hangingIndent = Boolean(
    firstLine &&
      nonemptyLines
        .slice(1)
        .some((line) => line.box.x - firstLine.box.x >= 0.008),
  )
  const publicationYear = bibliographyPublicationYear(itemText)
  if (!publicationYear) return hangingIndent
  const yearOffset = itemText.search(
    new RegExp(`\\b${publicationYear}\\b`, 'iu'),
  )
  const authorPrefix =
    yearOffset < 0 ? '' : itemText.slice(0, yearOffset).trim()
  const authorNameTokens =
    authorPrefix.match(
      /(?:\p{Lu}[\p{L}\p{M}'’.-]+|\p{Lu}\.)(?=\s|,|\.|$)/gu,
    ) ?? []
  const authorYearEvidence =
    authorPrefix.length <= 180 &&
    authorNameTokens.length >= 2 &&
    /(?:,\s|\band\b|\bet\s+al\.\s*$|\.\s*$)/iu.test(authorPrefix)
  return hangingIndent || authorYearEvidence
}

export function classifyPdfNoteMarkers(
  regions: PdfPageRegion[],
  readingOrder?: readonly string[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[] = [],
): PdfNoteMarkerClassificationResult {
  const regionById = new Map(regions.map((region) => [region.id, region]))
  const orderedRegionIds = new Set(readingOrder ?? [])
  const orderedRegions = [
    ...(readingOrder ?? []).flatMap((id) => {
      const region = regionById.get(id)
      return region ? [region] : []
    }),
    ...regions
      .filter((region) => !orderedRegionIds.has(region.id))
      .sort(positionCompare),
  ]
  const bodyFontSize = median(
    orderedRegions.flatMap((region) =>
      region.lines.map((line) => line.fontSize).filter((value) => value > 0),
    ),
  )
  const physicallyOrderedRegions = [...orderedRegions].sort(positionCompare)
  const orderedReferenceHeadingIndex = orderedRegions.findLastIndex(
    (region) =>
      orderedRegionIds.has(region.id) &&
      REFERENCE_HEADING.test(region.text.trim()),
  )
  const referenceScopeRegions =
    orderedReferenceHeadingIndex >= 0 ? orderedRegions : physicallyOrderedRegions
  const referenceHeadingIndex =
    orderedReferenceHeadingIndex >= 0
      ? orderedReferenceHeadingIndex
      : referenceScopeRegions.findLastIndex((region) =>
          REFERENCE_HEADING.test(region.text.trim()),
        )
  const referenceSectionEndIndex =
    referenceHeadingIndex < 0
      ? -1
      : referenceScopeRegions.findIndex(
          (region, index) =>
            index > referenceHeadingIndex &&
            endsReferenceSection(region, bodyFontSize),
        )
  const bibliographyRegionIds = new Set([
    ...(referenceHeadingIndex < 0
      ? []
      : referenceScopeRegions
          .slice(
            referenceHeadingIndex + 1,
            referenceSectionEndIndex < 0 ? undefined : referenceSectionEndIndex,
          )
          .map((region) => region.id)),
    ...orderedRegions
      .filter(pdfRegionHasStrongBibliographyEntryEvidence)
      .map((region) => region.id),
  ])
  const bibliographyLabelCounts = new Map<string, number>()
  for (const region of orderedRegions) {
    if (!bibliographyRegionIds.has(region.id)) continue
    const marker = bibliographyEntryMarker(region)
    if (!marker) continue
    const label = normalizedNoteLabel(marker.label)
    bibliographyLabelCounts.set(
      label,
      (bibliographyLabelCounts.get(label) ?? 0) + 1,
    )
  }
  const bibliographyLabels = new Set(bibliographyLabelCounts.keys())
  const bibliographyAuthorYearKeyCounts = new Map<string, number>()
  for (const region of orderedRegions) {
    if (!bibliographyRegionIds.has(region.id)) continue
    const key = bibliographyAuthorYearKey(region.text)
    if (!key) continue
    bibliographyAuthorYearKeyCounts.set(
      key,
      (bibliographyAuthorYearKeyCounts.get(key) ?? 0) + 1,
    )
  }
  const uniqueBibliographyAuthorYearKeys = new Set(
    [...bibliographyAuthorYearKeyCounts]
      .filter(([, count]) => count === 1)
      .map(([key]) => key),
  )
  const noteBodies = orderedRegions.filter(
    (region) =>
      (region.kind === 'footnote' || region.kind === 'endnote') &&
      !bibliographyRegionIds.has(region.id),
  )
  const repeatedNameTokens = repeatedRenderedNameTokens(orderedRegions)
  const ordinaryCandidates = orderedRegions
    .filter((region) => region.kind === 'body' || region.kind === 'spanning')
    .flatMap((region) =>
      markerCandidates(region, lineBoundaryDecisions, repeatedNameTokens),
    )
  const authorYearCandidates =
    referenceHeadingIndex < 0
      ? []
      : orderedRegions
          .filter(
            (region) =>
              (region.kind === 'body' || region.kind === 'spanning') &&
              !bibliographyRegionIds.has(region.id),
          )
          .flatMap((region) =>
            authorYearMarkerCandidates(
              region,
              uniqueBibliographyAuthorYearKeys,
            ),
          )
  const bibliographyEntryCandidates = orderedRegions
    .filter(
      (region) =>
        bibliographyRegionIds.has(region.id) &&
        (region.kind === 'footnote' || region.kind === 'endnote'),
    )
    .flatMap((region) => {
      const marker = bibliographyEntryMarker(region)
      if (!marker) return []
      return [
        {
          label: marker.label,
          labels: [marker.label],
          region,
          start: marker.start,
          end: marker.end,
          syntax: marker.syntax,
          sourceBox: sourceBox(region),
        },
      ]
    })
  const candidates = [
    ...ordinaryCandidates,
    ...authorYearCandidates,
    ...bibliographyEntryCandidates,
  ].sort(
    (left, right) =>
      positionCompare(left.region, right.region) ||
      left.start - right.start ||
      left.end - right.end,
  )
  const citationMarkerDensity = ordinaryCandidates
    .filter(
      (candidate) =>
        !bibliographyRegionIds.has(candidate.region.id) &&
        (candidate.syntax === 'bracketed-numeric-syntax' ||
          candidate.syntax === 'superscript-cluster-syntax' ||
          candidate.syntax === 'superscript-syntax'),
    )
    .reduce((total, candidate) => total + candidate.labels.length, 0)
  const footnoteBands = noteBodies.filter(
    (region) => region.kind === 'footnote',
  )
  const firstBodySectionY = orderedRegions.find(
    (region) => region.page === 1 && BODY_SECTION_HEADING.test(region.text),
  )?.box.y

  const drafts = candidates.map((candidate) => {
    if (bibliographyRegionIds.has(candidate.region.id)) {
      return classification(
        candidate,
        'bibliography-entry',
        'plain-text',
        0.99,
        ['reference-list-section-detected', 'reference-list-section-scope'],
      )
    }

    const contextual = contextualTaxonomy(candidate)
    if (contextual) {
      return classification(candidate, contextual, 'plain-text', 0.98, [
        'scholarly-cross-reference-context',
      ])
    }

    if (candidate.syntax === 'author-year-syntax') {
      return classification(
        candidate,
        'author-year-bibliography-citation',
        'citation',
        0.98,
        ['reference-list-section-detected', 'bounded-author-year-syntax'],
      )
    }

    const matchingBodies = noteBodies.filter((region) =>
      noteDefinitionLabels(region, lineBoundaryDecisions).some((label) =>
        candidate.labels.includes(label),
      ),
    )
    const titlePageAffiliationLabel = hasTitlePageAffiliationLabel(
      candidate,
      orderedRegions,
      firstBodySectionY,
    )
    const titlePageAffiliationDeclaration = isTitlePageAffiliationDeclaration(
      candidate,
      firstBodySectionY,
    )
    const titlePageAffiliation =
      candidate.region.page === 1 &&
      candidate.region.box.y < 0.34 &&
      firstBodySectionY !== undefined &&
      candidate.region.box.y < firstBodySectionY &&
      (candidate.syntax === 'superscript-syntax' ||
        candidate.syntax === 'rendered-superscript-geometry') &&
      (matchingBodies.length === 0 ||
        titlePageAffiliationLabel ||
        titlePageAffiliationDeclaration)
    if (titlePageAffiliation) {
      return classification(
        candidate,
        'author-affiliation-superscript',
        'plain-text',
        0.96,
        [
          'title-page-position',
          'before-first-body-section',
          titlePageAffiliationLabel
            ? 'affiliation-label-redeclared-before-body'
            : titlePageAffiliationDeclaration
              ? 'affiliation-declaration-row-before-body'
              : 'no-matching-note-body',
        ],
      )
    }

    const symbolicSuperscriptAnnotation =
      candidate.labels.every((label) => /^[*†‡§]+$/u.test(label)) &&
      (candidate.syntax === 'superscript-syntax' ||
        candidate.syntax === 'rendered-superscript-geometry')
    if (symbolicSuperscriptAnnotation) {
      const samePageFootnotes = matchingBodies.filter(
        (region) =>
          region.kind === 'footnote' && region.page === candidate.region.page,
      )
      if (samePageFootnotes.length > 0) {
        return classification(
          candidate,
          'footnote-reference',
          'note-reference',
          0.97,
          ['matching-note-label', 'same-page-footnote-band'],
        )
      }
      const laterEndnotes = matchingBodies.filter(
        (region) =>
          region.kind === 'endnote' && region.page >= candidate.region.page,
      )
      if (laterEndnotes.length > 0) {
        return classification(
          candidate,
          'endnote-reference',
          'note-reference',
          0.93,
          ['matching-note-label', 'later-endnote-section-scope'],
        )
      }
      return classification(
        candidate,
        'symbolic-annotation-marker',
        'plain-text',
        0.96,
        ['symbolic-marker-not-bibliography-citation', 'no-matching-note-body'],
      )
    }

    const multiLabelBracketedCitation =
      candidate.syntax === 'bracketed-numeric-syntax' &&
      candidate.labels.length > 1
    const exactBracketedBibliographyCitation =
      candidate.syntax === 'bracketed-numeric-syntax' &&
      candidate.labels.every((label) => bibliographyLabels.has(label))
    const uniqueExactSingletonBibliographyCitation =
      candidate.syntax === 'bracketed-numeric-syntax' &&
      candidate.labels.length === 1 &&
      bibliographyLabelCounts.get(candidate.labels[0]) === 1
    const citationDensityThresholdMet =
      citationMarkerDensity >= PDF_NOTE_CITATION_DENSITY_THRESHOLD
    const citationEvidence =
      referenceHeadingIndex >= 0 &&
      (citationDensityThresholdMet ||
        uniqueExactSingletonBibliographyCitation) &&
      (matchingBodies.length === 0 ||
        multiLabelBracketedCitation ||
        exactBracketedBibliographyCitation)
    if (citationEvidence && candidate.syntax === 'bracketed-numeric-syntax') {
      return classification(
        candidate,
        'bracketed-bibliography-citation',
        'citation',
        0.98,
        [
          'reference-list-section-detected',
          ...(citationDensityThresholdMet
            ? [
                `citation-marker-density-at-least-${PDF_NOTE_CITATION_DENSITY_THRESHOLD}`,
              ]
            : [
                'unique-exact-bibliography-label-target',
                'singleton-citation-density-bypass',
              ]),
          ...(matchingBodies.length === 0
            ? ['no-footnote-band', 'no-matching-note-body']
            : exactBracketedBibliographyCitation
              ? [
                  'exact-bibliography-label-target',
                  'overlapping-note-label-does-not-reclassify-citation',
                ]
              : [
                  'multi-label-bracketed-citation-cluster',
                  'overlapping-note-label-does-not-reclassify-cluster',
                ]),
        ],
      )
    }
    if (citationEvidence && candidate.syntax === 'superscript-cluster-syntax') {
      return classification(
        candidate,
        'superscript-citation-cluster',
        'citation',
        0.96,
        [
          'reference-list-section-detected',
          `citation-marker-density-at-least-${PDF_NOTE_CITATION_DENSITY_THRESHOLD}`,
          'no-footnote-band',
          'no-matching-note-body',
        ],
      )
    }
    if (
      citationEvidence &&
      (candidate.syntax === 'superscript-syntax' ||
        candidate.syntax === 'rendered-superscript-geometry')
    ) {
      return classification(
        candidate,
        'superscript-bibliography-citation',
        'citation',
        0.94,
        [
          'reference-list-section-detected',
          `citation-marker-density-at-least-${PDF_NOTE_CITATION_DENSITY_THRESHOLD}`,
          'no-matching-note-body',
        ],
      )
    }

    const samePageFootnotes = matchingBodies.filter(
      (region) =>
        region.kind === 'footnote' && region.page === candidate.region.page,
    )
    if (samePageFootnotes.length > 0) {
      return classification(
        candidate,
        'footnote-reference',
        'note-reference',
        0.97,
        ['matching-note-label', 'same-page-footnote-band'],
      )
    }
    const laterEndnotes = matchingBodies.filter(
      (region) =>
        region.kind === 'endnote' && region.page >= candidate.region.page,
    )
    if (laterEndnotes.length > 0) {
      return classification(
        candidate,
        'endnote-reference',
        'note-reference',
        0.93,
        ['matching-note-label', 'later-endnote-section-scope'],
      )
    }

    return classification(
      candidate,
      'unresolved-note-marker',
      'note-reference',
      candidate.syntax === 'explicit-note-language' ? 0.7 : 0.5,
      [
        'insufficient-reclassification-evidence',
        footnoteBands.length > 0
          ? 'footnote-band-present'
          : 'no-matching-note-body',
      ],
    )
  })

  const counters = new Map<string, number>()
  const classifications = drafts.map<PdfNoteMarkerClassification>((draft) => {
    const page = draft.sourceBox.page
    const idBase = `noteref-p${String(page).padStart(3, '0')}-${markerSlug(draft.label)}-${markerSourceAnchor(draft)}`
    const key = idBase
    const count = (counters.get(key) ?? 0) + 1
    counters.set(key, count)
    return {
      id: `${idBase}-${String(count).padStart(3, '0')}`,
      ...draft,
    }
  })

  return {
    classifications,
    bibliographyRegionIds: [...bibliographyRegionIds],
    noteBodyRegionIds: noteBodies.flatMap((region) => {
      const compound = splitPdfCompoundAffiliationNote(
        region,
        lineBoundaryDecisions,
      )
      return compound ? compound.affiliations.map(() => region.id) : [region.id]
    }),
  }
}
