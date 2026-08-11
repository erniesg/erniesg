import type {
  NormalizedSourceBox,
  PdfLineBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfFurnitureBand,
  PdfFurnitureClassification,
  PdfFurnitureEvidence,
  PdfFurnitureReview,
  PdfReadingOrderAmbiguityClass,
  PdfReadingOrderEdge,
  PdfReadingOrderEvaluation,
  PdfReadingOrderEvidence,
  PdfReadingOrderGraph,
  PdfReadingOrderResolution,
  PdfRegionColumn,
  PdfRegionKind,
  PdfRegionLine,
  PdfSourceFragmentLineage,
  PdfSourceSemanticFlowBoundaryDecision,
  PdfSourceRun,
} from './import-types'
import {
  groupRunsIntoLines,
  inlineHardHyphenLexicon,
  inlineUnhyphenatedLexicon,
  joinPdfLineTexts,
  mergePdfRunText,
  type PdfTextLine,
} from './pdf-lines'
import { copyPdfLinkedTokenSourceAnnotations } from './pdf-links'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import { sanitizeXmlText } from './publication-integrity'
import { sha256HexSync } from './sha256-sync'

type ClassifiedLine = PdfTextLine & {
  id: string
  kind: PdfRegionKind
  confidence: number
  noteLabel: string | null
  captionContinuationSeedId?: string
  panelLabelContinuationSeedId?: string
  noteContinuationSeedId?: string
  headingContinuationSeedId?: string
  displayEquationClusterSeedId?: string
  tabularGridBandId?: string
  captionLaneSplitAmbiguous?: boolean
  sourceFragmentLineage?: PdfSourceFragmentLineage
  furniture?: PdfFurnitureEvidence
  furnitureReview?: PdfFurnitureReview
}

type ColumnLayout = {
  split: number | null
  accepted: boolean
  ambiguous: boolean
  resolution: Omit<PdfReadingOrderResolution, 'page' | 'regionIds'> | null
  tabularGridBands?: ReadonlyMap<string, string>
  tabularGridColumns?: ReadonlyMap<string, PdfRegionColumn>
}

const NOTE_LABEL = String.raw`(?:\d{1,3}|[*†‡§])`
export const READING_ORDER_RESOLUTION_POLICY_VERSION = '1.0.0' as const
export const READING_ORDER_RESOLUTION_THRESHOLD = 0.85

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

export function pdfSourceSemanticFlowRunSha256(run: PdfSourceRun) {
  return sha256HexSync(
    JSON.stringify([
      run.page,
      run.rotation,
      run.method,
      run.x,
      run.y,
      run.width,
      run.height,
      run.text.normalize('NFC'),
      run.fontName,
      run.fontSize,
      run.sourceSequenceIndex ?? null,
      run.sourceWhitespaceBefore ?? null,
      run.sourceWhitespacePredecessorIndex ?? null,
    ]),
  )
}

export function pdfSourceFragmentId(line: PdfRegionLine) {
  const lineage = line.sourceFragmentLineage
  return lineage ? `${lineage.sourceLineId}:${lineage.fragment}` : null
}

export const PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE = Object.freeze(
  [
    'exact-source-sequence-adjacency',
    'font-baseline-compatible',
    'explicit-fragment-lineage',
  ].sort(),
)

export const PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE = Object.freeze(
  [
    ...PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE,
    'continuation-punctuation',
    'stacked-fragment-transition',
  ].sort(),
)

export const PDF_SOURCE_SEMANTIC_FLOW_SPACE_WHITESPACE_EVIDENCE = Object.freeze(
  [
    ...PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE,
    'source-whitespace-separator',
  ].sort(),
)

export const PDF_SOURCE_SEMANTIC_FLOW_COLUMN_EVIDENCE = Object.freeze(
  [
    'exact-source-sequence-adjacency',
    'explicit-fragment-lineage',
    'same-page-column-flow',
    'same-page-column-geometry',
  ].sort(),
)

// A page break is not a source-order adjacency: `sourceSequenceIndex` is the
// per-page text-item index, so the tail of page N and the head of page N+1 are
// never numerically adjacent. What the source can prove instead is that the
// tail is the last prose text item its page paints and the continuation is the
// first prose text item the next page paints, with only independently accounted
// non-prose between them. That includes issue 042 page furniture and validated
// visual/table ownership, neither of which may enter the paragraph.
export const PDF_SOURCE_SEMANTIC_FLOW_CROSS_PAGE_EVIDENCE = Object.freeze(
  [
    'cross-page-column-geometry',
    'explicit-fragment-lineage',
    'non-prose-excluded-page-boundary',
    'page-head-source-order-extremum',
    'page-tail-source-order-extremum',
  ].sort(),
)

export type PdfBodySourceOrderExtremum = { first: number; last: number }

/**
 * Per-page first and last source text-item index over everything that is not
 * accounted page furniture or validated non-prose visual content. Extraction
 * and the independent quality audit both derive the cross-page prose boundary
 * from this map, so they cannot disagree about which runs a page break may skip.
 */
export function pdfBodySourceOrderExtremaByPage(
  regions: readonly Pick<
    PdfPageRegion,
    'id' | 'page' | 'lines' | 'furniture'
  >[],
  accountedNonProseRegionIds: ReadonlySet<string> = new Set(),
) {
  const extrema = new Map<number, PdfBodySourceOrderExtremum>()
  for (const region of regions) {
    if (region.furniture || accountedNonProseRegionIds.has(region.id)) continue
    for (const line of region.lines) {
      for (const run of line.runs) {
        if (!run.text.trim() || run.sourceSequenceIndex === undefined) continue
        const current = extrema.get(run.page)
        if (!current) {
          extrema.set(run.page, {
            first: run.sourceSequenceIndex,
            last: run.sourceSequenceIndex,
          })
          continue
        }
        current.first = Math.min(current.first, run.sourceSequenceIndex)
        current.last = Math.max(current.last, run.sourceSequenceIndex)
      }
    }
  }
  return extrema
}

export function pdfSourceColumnFlowStartsWithCjkNumericContinuation(
  continuationText: string,
) {
  return /^\p{N}+(?:[,.]\p{N}+)*(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana})/u.test(
    continuationText.trimStart(),
  )
}

export function pdfSourceColumnFlowJoinOutcome(
  language: string | null,
  continuationText: string,
  continuationRun: PdfSourceRun,
) {
  const hasSourceWhitespace =
    continuationRun.sourceWhitespaceBefore === 'pdf-text-item' &&
    continuationRun.sourceWhitespacePredecessorIndex !== undefined
  if (hasSourceWhitespace) {
    return { outcome: 'space' as const, separator: ' ' as const }
  }
  const cjkScript =
    /^[^\p{L}\p{N}]*(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana})/u.test(
      continuationText,
    ) || pdfSourceColumnFlowStartsWithCjkNumericContinuation(continuationText)
  return cjkScript
    ? { outcome: 'no-space' as const, separator: '' as const }
    : { outcome: 'space' as const, separator: ' ' as const }
}

export function canonicalPdfSourceSemanticFlowEvidence(
  evidence: readonly string[],
) {
  return [...new Set(evidence)].sort()
}

export function pdfSourceSemanticFlowBoundaryDecisionId(
  decision: Omit<PdfSourceSemanticFlowBoundaryDecision, 'id'>,
) {
  const endpoint = (value: PdfSourceSemanticFlowBoundaryDecision['from']) => [
    value.regionId,
    value.lineId,
    value.runIndex,
    value.sourceSequenceIndex,
    value.sourceRunSha256,
    value.sourceFragmentId,
  ]
  return sha256HexSync(
    JSON.stringify([
      'pdf-source-semantic-flow-boundary-v1',
      decision.page,
      decision.rotation,
      decision.method,
      decision.topology,
      decision.outcome,
      endpoint(decision.from),
      endpoint(decision.to),
      canonicalPdfSourceSemanticFlowEvidence(decision.evidence),
    ]),
  )
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

function quantile(values: number[], fraction: number) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[
    Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))
  ]
}

function normalizeMarginText(text: string) {
  return text
    .toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/[\p{N}]+/gu, '#')
    .replace(/\b[ivxlcdm]+\b/giu, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

type FurnitureRunOccurrence = {
  run: PdfSourceRun
  band: PdfFurnitureBand
  key: string
  normalizedText: string
  numericValues: number[]
}

export type PdfFurnitureAssessment = {
  patterns: Array<{
    classification: PdfFurnitureClassification
    band: PdfFurnitureBand
    normalizedText: string
    pages: number[]
    boxes: NormalizedSourceBox[]
    sequence?: number[]
    evidence: string[]
  }>
  furnitureRuns: Array<{
    run: PdfSourceRun
    evidence: PdfFurnitureEvidence
  }>
  reviewRuns: Array<{
    run: PdfSourceRun
    review: PdfFurnitureReview
  }>
  repeatedMarginCount: number
  byRunKey: ReadonlyMap<string, PdfFurnitureEvidence>
  reviewByRunKey: ReadonlyMap<string, PdfFurnitureReview>
  objectById: ReadonlyMap<string, PdfFurnitureEvidence>
}

function isQuarterTurn(rotation: number) {
  const value = Math.abs(rotation % 180)
  return Math.abs(value - 90) <= 2
}

function furnitureBand(
  source: Pick<
    NormalizedSourceBox,
    'x' | 'y' | 'width' | 'height' | 'rotation'
  >,
): PdfFurnitureBand | null {
  if (isQuarterTurn(source.rotation) && source.x <= 0.05) {
    return 'left'
  }
  if (isQuarterTurn(source.rotation) && source.x + source.width >= 0.95) {
    return 'right'
  }
  // Narrow, unrotated runs flush with the page edge are also margin bands.
  // The width gate keeps ordinary two-column body text out of review.
  if (source.x <= 0.05 && source.width <= 0.2) return 'left'
  if (source.x + source.width >= 0.95 && source.width <= 0.2) return 'right'
  if (source.y <= 0.1) return 'top'
  if (source.y + source.height >= 0.9) return 'bottom'
  return null
}

function sourceRunBox(run: PdfSourceRun): NormalizedSourceBox {
  return {
    page: run.page,
    x: run.x,
    y: run.y,
    width: run.width,
    height: run.height,
    rotation: run.rotation,
    method: run.method,
  }
}

function furnitureRunKey(run: PdfSourceRun) {
  return [
    run.page,
    run.text,
    run.x,
    run.y,
    run.width,
    run.height,
    run.rotation,
    run.fontName,
    run.fontSize,
    run.sourceSequenceIndex ?? '',
  ].join('\u001f')
}

function digitValue(character: string) {
  const codePoint = character.codePointAt(0) ?? -1
  const ranges = [
    [0x30, 0x39],
    [0x660, 0x669],
    [0x6f0, 0x6f9],
    [0x7c0, 0x7c9],
    [0x966, 0x96f],
    [0x9e6, 0x9ef],
    [0xa66, 0xa6f],
    [0xae6, 0xaef],
    [0xb66, 0xb6f],
    [0xbe6, 0xbef],
    [0xc66, 0xc6f],
    [0xce6, 0xcef],
    [0xd66, 0xd6f],
    [0xde6, 0xdef],
    [0xe50, 0xe59],
    [0xed0, 0xed9],
    [0xf20, 0xf29],
    [0x1040, 0x1049],
    [0x1090, 0x1099],
    [0x17e0, 0x17e9],
    [0x1810, 0x1819],
    [0x1946, 0x194f],
    [0x19d0, 0x19d9],
    [0x1a80, 0x1a89],
    [0x1a90, 0x1a99],
    [0x1b50, 0x1b59],
    [0x1bb0, 0x1bb9],
    [0x1c40, 0x1c49],
    [0x1c50, 0x1c59],
    [0xa620, 0xa629],
    [0xa8d0, 0xa8d9],
    [0xa900, 0xa909],
    [0xa9d0, 0xa9d9],
    [0xa9f0, 0xa9f9],
    [0xaa50, 0xaa59],
    [0xabf0, 0xabf9],
    [0x104a0, 0x104a9],
    [0x10d30, 0x10d39],
    [0x11066, 0x1106f],
    [0x110f0, 0x110f9],
    [0x11136, 0x1113f],
    [0x111d0, 0x111d9],
    [0x112f0, 0x112f9],
    [0x11450, 0x11459],
    [0x114d0, 0x114d9],
    [0x11650, 0x11659],
    [0x116c0, 0x116c9],
    [0x11730, 0x11739],
    [0x118e0, 0x118e9],
    [0x11950, 0x11959],
    [0x11c50, 0x11c59],
    [0x11d50, 0x11d59],
    [0x11da0, 0x11da9],
    [0x16a60, 0x16a69],
    [0x16ac0, 0x16ac9],
    [0x16b50, 0x16b59],
    [0x1d7ce, 0x1d7ff],
    [0x1e140, 0x1e149],
    [0x1e2f0, 0x1e2f9],
    [0x1e950, 0x1e959],
    [0x1fbf0, 0x1fbf9],
    [0xff10, 0xff19],
  ] as const
  for (const [start, end] of ranges) {
    if (codePoint >= start && codePoint <= end) return codePoint - start
  }
  return null
}

function numericTokenValue(token: string) {
  const digits = [...token]
  if (
    digits.length > 0 &&
    digits.every((character) => digitValue(character) !== null)
  ) {
    return digits.reduce(
      (value, character) => value * 10 + (digitValue(character) ?? 0),
      0,
    )
  }
  const roman = token.toLocaleLowerCase()
  if (!/^[ivxlcdm]+$/u.test(roman)) return null
  const values: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
    l: 50,
    c: 100,
    d: 500,
    m: 1000,
  }
  let total = 0
  let previous = 0
  for (const character of [...roman].reverse()) {
    const value = values[character]
    if (value < previous) total -= value
    else {
      total += value
      previous = value
    }
  }
  return total > 0 ? total : null
}

function marginNumericValues(text: string) {
  const values: number[] = []
  for (const match of text
    .normalize('NFKC')
    .matchAll(/[\p{N}]+|\b[ivxlcdm]+\b/giu)) {
    const value = numericTokenValue(match[0])
    if (value !== null) values.push(value)
  }
  return values
}

function marginTextIsNumeralOnly(text: string) {
  return (
    marginNumericValues(text).length > 0 &&
    /^[\s.,:;()[\]{}+\-–—\p{N}ivxlcdm]+$/iu.test(text)
  )
}

function firstPageTitleBlockRun(run: PdfSourceRun, bodyFontSize: number) {
  if (isQuarterTurn(run.rotation)) return false
  if (run.page !== 1 || run.y > 0.42) return false
  if (run.y < 0.08 && run.fontSize < bodyFontSize * 1.2 && run.width < 0.55) {
    return false
  }
  return run.width >= 0.28 || run.fontSize >= bodyFontSize * 0.92
}

function furniturePatternProven(occurrences: FurnitureRunOccurrence[]) {
  const pages = [
    ...new Set(occurrences.map((occurrence) => occurrence.run.page)),
  ].sort((left, right) => left - right)
  if (pages.length < 2) return null
  const hasNumbers = occurrences.some(
    (occurrence) => occurrence.numericValues.length > 0,
  )
  const orderedOccurrences = occurrences
    .slice()
    .sort((left, right) => left.run.page - right.run.page)
  const sequence = orderedOccurrences.flatMap((occurrence) => {
    const values = occurrence.numericValues
    return values.length > 0 ? [values.at(-1)!] : []
  })
  const stableNumericPrefix = orderedOccurrences.every((occurrence) => {
    const values = occurrence.numericValues
    const first = orderedOccurrences[0]?.numericValues ?? []
    return (
      values.length === first.length &&
      values.slice(0, -1).every((value, index) => value === first[index])
    )
  })
  const incrementing =
    hasNumbers &&
    sequence.length === pages.length &&
    stableNumericPrefix &&
    sequence.every(
      (value, index) => index === 0 || value === sequence[index - 1] + 1,
    )
  const exactText =
    new Set(
      occurrences.map((occurrence) => occurrence.run.text.normalize('NFKC')),
    ).size === 1
  if (!exactText && !incrementing) return null
  const rotated = occurrences.some((occurrence) =>
    isQuarterTurn(occurrence.run.rotation),
  )
  const geometryKey = (occurrence: FurnitureRunOccurrence) =>
    [
      Math.round(occurrence.run.x / 0.025),
      Math.round(occurrence.run.y / 0.025),
      Math.round(occurrence.run.width / 0.025),
      Math.round(occurrence.run.height / 0.01),
      isQuarterTurn(occurrence.run.rotation)
        ? Math.round(Math.abs(occurrence.run.rotation) / 90)
        : 0,
    ].join(':')
  const stableGeometry = new Set(occurrences.map(geometryKey)).size === 1
  const classification: PdfFurnitureClassification = rotated
    ? 'rotated-margin'
    : incrementing
      ? 'incrementing-numeral'
      : 'repeated-text'
  const evidence = [
    'cross-page-repetition',
    'same-margin-band',
    ...(stableGeometry
      ? ['stable-source-geometry']
      : ['bounded-margin-geometry']),
    ...(incrementing ? ['incrementing-numeral-sequence'] : []),
    ...(rotated ? ['quarter-turn-margin-rotation'] : []),
  ]
  return {
    classification,
    pages,
    boxes: occurrences
      .slice()
      .sort(
        (left, right) =>
          left.run.page - right.run.page || left.run.x - right.run.x,
      )
      .map((occurrence) => sourceRunBox(occurrence.run)),
    sequence: incrementing ? sequence : undefined,
    evidence,
  }
}

/**
 * Classify page furniture before line grouping.  The output keeps a stable
 * source-run key so line splitting can carry the proof into PdfPageRegion.
 */
export function classifyPdfFurniture(
  pages: readonly PdfPageAnalysis[],
  {
    deferredRunKeys = new Set<string>(),
  }: { deferredRunKeys?: ReadonlySet<string> } = {},
): PdfFurnitureAssessment {
  const bodyFontSize = median(
    pages
      .flatMap((page) => page.runs.map((run) => run.fontSize))
      .filter((size) => size > 0),
  )
  const occurrencesByPattern = new Map<string, FurnitureRunOccurrence[]>()
  for (const page of pages) {
    for (const run of page.runs) {
      if (deferredRunKeys.has(furnitureRunKey(run))) continue
      const band = furnitureBand(run)
      if (!band || firstPageTitleBlockRun(run, bodyFontSize)) continue
      const text = run.text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
      if (!text) continue
      const numericValues = marginNumericValues(text)
      const alphabeticCharacters = (text.match(/[\p{L}]/gu) ?? []).length
      const numericOnly =
        numericValues.length > 0 &&
        (alphabeticCharacters === 0 || marginTextIsNumeralOnly(text))
      if ((!numericOnly && text.length < 4) || run.width < 0.01) continue
      const normalizedText = normalizeMarginText(text)
      // The band, rather than an exact x coordinate, is the invariant across
      // alternating-page headers and two-column folios.  Geometry is still
      // retained in the evidence boxes and used to keep body text out of the
      // candidate set.
      const numericSystem =
        numericValues.length > 0
          ? (text
              .match(/[\p{N}]+/u)?.[0]
              ?.codePointAt(0)
              ?.toString(16)
              .slice(0, -1) ??
            (marginTextIsNumeralOnly(text) ? 'roman' : 'numeric'))
          : ''
      const key = `${band}\u0000${normalizedText}\u0000${numericSystem}`
      const list = occurrencesByPattern.get(key) ?? []
      list.push({ run, band, key, normalizedText, numericValues })
      occurrencesByPattern.set(key, list)
    }
  }
  const furnitureRuns: Array<{
    run: PdfSourceRun
    evidence: PdfFurnitureEvidence
  }> = []
  const byRunKey = new Map<string, PdfFurnitureEvidence>()
  const patterns: PdfFurnitureAssessment['patterns'] = []
  for (const occurrences of occurrencesByPattern.values()) {
    const proven = furniturePatternProven(occurrences)
    if (!proven) continue
    const first = occurrences[0]
    const evidence: PdfFurnitureEvidence = {
      classification: proven.classification,
      band: first.band,
      pages: proven.pages,
      boxes: proven.boxes,
      evidence: proven.evidence,
      normalizedText: first.normalizedText,
      ...(proven.sequence ? { sequence: proven.sequence } : {}),
      sourceRunIndexes: occurrences
        .map(({ run }) => run.sourceSequenceIndex)
        .filter((index): index is number => index !== undefined)
        .sort((left, right) => left - right),
    }
    patterns.push({
      classification: proven.classification,
      band: first.band,
      normalizedText: first.normalizedText,
      pages: proven.pages,
      boxes: proven.boxes,
      evidence: proven.evidence,
      ...(proven.sequence ? { sequence: proven.sequence } : {}),
    })
    for (const occurrence of occurrences) {
      const key = furnitureRunKey(occurrence.run)
      byRunKey.set(key, evidence)
      furnitureRuns.push({ run: occurrence.run, evidence })
    }
  }
  // A quarter-turned margin stamp is self-proving from geometry and rotation;
  // it does not need a text or journal-name match.  Keep this deliberately
  // narrow so a single horizontal sentence at the bottom remains reviewable.
  for (const page of pages) {
    for (const run of page.runs) {
      if (deferredRunKeys.has(furnitureRunKey(run))) continue
      const band = furnitureBand(run)
      if (
        !band ||
        !isQuarterTurn(run.rotation) ||
        byRunKey.has(furnitureRunKey(run))
      )
        continue
      const evidence: PdfFurnitureEvidence = {
        classification: 'rotated-margin',
        band,
        pages: [run.page],
        boxes: [sourceRunBox(run)],
        evidence: ['quarter-turn-margin-rotation', 'margin-band-geometry'],
        normalizedText: normalizeMarginText(run.text),
        sourceRunIndexes:
          run.sourceSequenceIndex === undefined
            ? []
            : [run.sourceSequenceIndex],
      }
      byRunKey.set(furnitureRunKey(run), evidence)
      furnitureRuns.push({ run, evidence })
    }
  }
  const reviewRuns: Array<{ run: PdfSourceRun; review: PdfFurnitureReview }> =
    []
  const reviewByRunKey = new Map<string, PdfFurnitureReview>()
  for (const page of pages) {
    for (const run of page.runs) {
      const key = furnitureRunKey(run)
      if (deferredRunKeys.has(key)) continue
      if (byRunKey.has(key)) continue
      const band = furnitureBand(run)
      if (!band || firstPageTitleBlockRun(run, bodyFontSize)) continue
      const edgeLike =
        band === 'left' ||
        band === 'right' ||
        (band === 'top' && run.y <= 0.06) ||
        (band === 'bottom' && run.y + run.height >= 0.92)
      if (!edgeLike) continue
      const text = run.text.replace(/\s+/gu, ' ').trim()
      const words = text.match(/[\p{L}\p{N}]{2,}/gu) ?? []
      if (text.length < 8 || words.length < 2 || run.width < 0.08) continue
      const review: PdfFurnitureReview = {
        reason: 'single-occurrence-margin',
        band,
        pages: [run.page],
        boxes: [sourceRunBox(run)],
        evidence: [
          'single-page-occurrence',
          'margin-band-geometry',
          'repetition-unproven',
        ],
      }
      reviewByRunKey.set(key, review)
      reviewRuns.push({ run, review })
    }
  }
  const objectById = new Map<string, PdfFurnitureEvidence>()
  const ruleGroups = new Map<
    string,
    Array<{
      object: NonNullable<PdfPageAnalysis['objects']>[number]
      band: PdfFurnitureBand
    }>
  >()
  for (const page of pages) {
    for (const object of page.objects ?? []) {
      const band = furnitureBand(object.box)
      if (
        !band ||
        object.kind !== 'vector' ||
        object.box.width < 0.45 ||
        object.box.height > 0.015
      ) {
        continue
      }
      const key = [
        band,
        Math.round(object.box.x / 0.025),
        Math.round(object.box.y / 0.025),
        Math.round(object.box.width / 0.025),
        Math.round(object.box.height / 0.01),
      ].join(':')
      const group = ruleGroups.get(key) ?? []
      group.push({ object, band })
      ruleGroups.set(key, group)
    }
  }
  const hasMarginRunOnPage = new Set(furnitureRuns.map(({ run }) => run.page))
  for (const group of ruleGroups.values()) {
    const pagesForRule = [
      ...new Set(group.map(({ object }) => object.page)),
    ].sort((left, right) => left - right)
    if (
      pagesForRule.length < 2 &&
      !pagesForRule.some((page) => hasMarginRunOnPage.has(page))
    ) {
      continue
    }
    const first = group[0]
    const evidence: PdfFurnitureEvidence = {
      classification: 'separator-rule',
      band: first.band,
      pages: pagesForRule,
      boxes: group
        .slice()
        .sort((left, right) => left.object.page - right.object.page)
        .map(({ object }) => ({ ...object.box })),
      evidence: [
        ...(pagesForRule.length >= 2 ? ['cross-page-repetition'] : []),
        'same-margin-band',
        'thin-rule-geometry',
      ],
    }
    for (const { object } of group) objectById.set(object.id, evidence)
  }
  return {
    patterns: patterns.sort(
      (left, right) =>
        left.pages[0] - right.pages[0] ||
        left.band.localeCompare(right.band) ||
        left.normalizedText.localeCompare(right.normalizedText),
    ),
    furnitureRuns,
    reviewRuns,
    repeatedMarginCount: patterns.length,
    byRunKey,
    reviewByRunKey,
    objectById,
  }
}

/** Backwards-compatible descriptive alias for callers that name the stage. */
export const classifyPageFurniture = classifyPdfFurniture

function beginsVisualCaption(text: string) {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return (
    Boolean(
      parsePdfScholarlyVisualLabel(normalized, {
        context: 'caption',
      }),
    ) ||
    /^[^.!?;:]{1,72}\s+(?:fig(?:ure)?|table)\.?\s*(?:\d+|[ivxlcdm]+)\s*[.:–—-]\s*\p{Lu}/iu.test(
      normalized,
    )
  )
}

function beginsSourceStyledVisualCaption(line: PdfTextLine) {
  const dedicatedStyle = (run: PdfSourceRun) =>
    run.bold === true ||
    /(?:bold|black|demi|semibold|(?:^|[-_])medi(?:um)?(?:$|[-_]))/iu.test(
      run.fontName,
    )
  const substantiveRuns = line.runs.filter((run) => run.text.trim())
  const styledPrefixRuns: PdfSourceRun[] = []
  for (const run of substantiveRuns) {
    if (!dedicatedStyle(run)) break
    styledPrefixRuns.push(run)
  }
  if (styledPrefixRuns.length === 0) return false
  const styledPrefix = styledPrefixRuns.map((run) => run.text.trim()).join(' ')
  const styledLabel = parsePdfScholarlyVisualLabel(styledPrefix, {
    context: 'reference',
  })
  const lineLabel = parsePdfScholarlyVisualLabel(line.text, {
    context: 'reference',
  })
  return (
    styledLabel?.status === 'parsed' &&
    lineLabel?.status === 'parsed' &&
    styledLabel.kind === lineLabel.kind &&
    styledLabel.identifier === lineLabel.identifier &&
    styledLabel.consumedEnd === styledPrefix.length
  )
}

function unpublishableText(text: string) {
  return text.includes('\ufffd') || sanitizeXmlText(text) !== text
}

function unresolvedMathExtensionLine(line: PdfTextLine) {
  return line.runs.some(
    (run) => /CMEX\d*/iu.test(run.fontName) && unpublishableText(run.text),
  )
}

export function proseDominantPdfMathSource(source: {
  text: string
  width: number
  runs: readonly PdfSourceRun[]
}) {
  const text = source.text.replace(/\s+/gu, ' ').trim()
  const proseWords = text.match(/\p{L}{3,}/gu) ?? []
  const visibleRuns = source.runs.filter((run) => run.text.trim())
  const visibleCharacters = visibleRuns.reduce(
    (total, run) => total + run.text.replace(/\s/gu, '').length,
    0,
  )
  const mathCharacters = visibleRuns.reduce(
    (total, run) =>
      total +
      (/(?:cmmi|cmsy|cmex|math|symbol)/iu.test(run.fontName)
        ? run.text.replace(/\s/gu, '').length
        : 0),
    0,
  )
  const proseFontShare =
    visibleCharacters > 0 ? 1 - mathCharacters / visibleCharacters : 1
  const numberedInstruction =
    /^(?:\d+|[A-Za-z])[.)]\s+\p{Lu}/u.test(text) && proseWords.length >= 3
  const relationCount = (text.match(/(?:<=|>=|==|!=|=|≤|≥|≈|≠|<|>)/gu) ?? [])
    .length
  const alphabeticTokenCount = (text.match(/\p{L}{2,}/gu) ?? []).length
  const strongMathSignal =
    /[\p{Script=Greek}\p{N}∆_=+*/<>^−×÷≤≥≈≠∼⊙∂∞∏∈∉→←∫∑√]/u.test(text)
  const openingDelimiter = /[\p{Ps}\p{Pi}]/u
  const closingDelimiter = /[\p{Pe}\p{Pf}]/u
  const delimiterDepth = (value: string) =>
    Array.from(value).reduce(
      (depth, character) =>
        depth +
        Number(openingDelimiter.test(character)) -
        Number(closingDelimiter.test(character)),
      0,
    )
  const insideSourceDelimiter = (start: number, end: number) => {
    const before = text.slice(0, start)
    const after = text.slice(end)
    const pairedStraightQuote = ['"', "'"].some(
      (quote) => before.lastIndexOf(quote) >= 0 && after.indexOf(quote) >= 0,
    )
    return (
      delimiterDepth(before) > 0 ||
      delimiterDepth(after) < 0 ||
      pairedStraightQuote
    )
  }
  const compactMathContext = /[\p{Script=Greek}∆_=+*/<>^−×÷≤≥≈≠∼⊙∂∞∏∈∉→←∫∑√]/u
  const compactLeftAtom = /[\p{L}\p{N}\p{Pe}]/u
  const compactRightAtom = /[\p{L}\p{N}\p{Ps}]/u
  const delimitedUnsupportedAlphabeticTokens = [
    ...text.matchAll(/\p{L}{2,}/gu),
  ].flatMap((match) => {
    const word = match[0]
    const start = match.index
    const end = start + word.length
    const compactBefore =
      compactMathContext.test(text[start - 1] ?? '') &&
      compactLeftAtom.test(text[start - 2] ?? '')
    const compactAfter =
      compactMathContext.test(text[end] ?? '') &&
      compactRightAtom.test(text[end + 1] ?? '')
    const compactSymbolIdentifier =
      Array.from(word).length <= 3 && (compactBefore || compactAfter)
    return insideSourceDelimiter(start, end) &&
      !/^\p{Ll}\p{Lu}$/u.test(word) &&
      !/^d(?:\p{Ll}|\p{Script=Greek}){1,2}$/u.test(word) &&
      !/\p{Script=Greek}/u.test(word) &&
      !compactSymbolIdentifier &&
      !/^(?:arg|cosh?|det|diag|dim|exp|gcd|lim|log|max|min|mod|sinh?|sqrt|tanh?|var)$/iu.test(
        word,
      )
      ? [{ word, start, end }]
      : []
  })
  const unresolvedDelimitedProse =
    unpublishableText(text) &&
    (delimitedUnsupportedAlphabeticTokens.length >= 2 ||
      delimitedUnsupportedAlphabeticTokens.some(({ end }) =>
        /^[^\p{L}]{0,8}[.!?]/u.test(text.slice(end)),
      ))
  const shortWordSentence =
    alphabeticTokenCount >= 3 &&
    relationCount === 0 &&
    (!strongMathSignal || /[.!?](?:\s|$)/u.test(text))
  const narrowProseSentence =
    source.width < 0.3 &&
    proseWords.length >= 4 &&
    proseFontShare >= 0.7 &&
    relationCount <= 1 &&
    /(?:[.!?]\s*$|[,;:](?:\s|$)|\s[-–—]\s)/u.test(text) &&
    /\b(?:this|that|these|those|is|are|was|were|be|been|being|has|have|had|with|without|not|remains?|after|before|because|while|where|which|who|we|our|their)\b/iu.test(
      text,
    )
  const narrowProseLeadIn =
    source.width < 0.3 &&
    proseFontShare >= 0.7 &&
    relationCount === 0 &&
    alphabeticTokenCount >= 1 &&
    text.includes(':')
  return (
    numberedInstruction ||
    unresolvedDelimitedProse ||
    shortWordSentence ||
    narrowProseLeadIn ||
    narrowProseSentence ||
    (source.width >= 0.3 && proseWords.length >= 4 && proseFontShare >= 0.5)
  )
}

function proseDominantInlineMathLine(line: PdfTextLine) {
  return proseDominantPdfMathSource(line)
}

function marginBand(
  source: Pick<PdfTextLine, 'x' | 'y' | 'width' | 'height'> & {
    rotation?: number
  },
) {
  return (
    source.y <= 0.1 ||
    source.y + source.height >= 0.9 ||
    (isQuarterTurn(source.rotation ?? 0) &&
      (source.x <= 0.12 || source.x + source.width >= 0.88))
  )
}

function textLineFromRuns(source: PdfTextLine, runs: PdfTextLine['runs']) {
  const left = Math.min(...runs.map((run) => run.x))
  const top = Math.min(...runs.map((run) => run.y))
  const right = Math.max(...runs.map((run) => run.x + run.width))
  const bottom = Math.max(...runs.map((run) => run.y + run.height))
  const fragment = {
    ...source,
    text: mergePdfRunText(runs),
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    fontSize: Math.max(...runs.map((run) => run.fontSize)),
    runs,
  }
  copyPdfLinkedTokenSourceAnnotations(source, fragment)
  return fragment
}

function computerModernMathSourceRun(
  run: PdfTextLine['runs'][number],
  maximumFontSize: number,
) {
  const text = run.text.replace(/\s+/gu, ' ').trim()
  if (!text) return false
  if (/(?:^|[+_-])CM(?:MI|SY|EX)\d*(?:$|[+_-])/iu.test(run.fontName)) {
    return true
  }
  if (!/(?:^|[+_-])CMR\d*(?:$|[+_-])/iu.test(run.fontName)) return false
  const proseWords = text.match(/\p{L}{3,}/gu) ?? []
  return (
    run.fontSize <= maximumFontSize * 0.82 ||
    proseWords.length === 0 ||
    (proseWords.length === 1 &&
      /^(?:arg|cosh?|diag|exp|min|max|log|sinh?|sqrt|tanh?|var)\b/iu.test(text))
  )
}

function horizontallyStackedMathPair(
  left: PdfTextLine['runs'][number],
  right: PdfTextLine['runs'][number],
  maximumFontSize: number,
) {
  if (
    left.fontSize > maximumFontSize * 0.86 ||
    right.fontSize > maximumFontSize * 0.86
  ) {
    return false
  }
  const horizontalOverlap = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
  const minimumWidth = Math.min(left.width, right.width)
  if (
    minimumWidth <= 0 ||
    horizontalOverlap < minimumWidth * 0.7 ||
    Math.abs(left.x + left.width / 2 - (right.x + right.width / 2)) >
      Math.max(0.008, Math.max(left.width, right.width) * 0.3)
  ) {
    return false
  }
  const leftCenterY = left.y + left.height / 2
  const rightCenterY = right.y + right.height / 2
  const minimumHeight = Math.min(left.height, right.height)
  const verticalGap = Math.max(
    left.y - (right.y + right.height),
    right.y - (left.y + left.height),
    0,
  )
  return (
    Math.abs(leftCenterY - rightCenterY) >=
      Math.max(0.003, minimumHeight * 0.45) &&
    verticalGap <= Math.max(0.006, minimumHeight * 0.7)
  )
}

function horizontalBoxGap(
  left: PdfTextLine['runs'][number],
  right: PdfTextLine['runs'][number],
) {
  return Math.max(
    left.x - (right.x + right.width),
    right.x - (left.x + left.width),
    0,
  )
}

export function sourceStackedMathPairs(
  runs: PdfTextLine['runs'],
  maximumFontSize: number,
) {
  return runs.flatMap((left, leftIndex) =>
    runs
      .slice(leftIndex + 1)
      .flatMap((right) =>
        horizontallyStackedMathPair(left, right, maximumFontSize)
          ? [[left, right] as const]
          : [],
      ),
  )
}

export function sourceInlineFractionPairs(line: PdfTextLine) {
  const runs = line.runs.filter((run) => run.text.trim())
  if (runs.length < 2 || runs.some(mathExtensionSourceRun)) return []
  const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
  // PDF placement alone cannot distinguish a stacked numerator/denominator
  // from simultaneous super/subscripts, including mixed letter pairs such as
  // x/y beside a coefficient. Preserve every such pair as a two-dimensional
  // equation obligation instead of guessing canonical inline semantics.
  return sourceStackedMathPairs(runs, maximumFontSize)
}

function verticalLineOverlap(left: PdfTextLine, right: PdfTextLine) {
  return Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  )
}

function mathExtensionSourceRun(run: PdfTextLine['runs'][number]) {
  return (
    /(?:^|[+_-])CMEX\d*(?:$|[+_-])/iu.test(run.fontName) ||
    /^[∑∫∏√]$/u.test(run.text.trim())
  )
}

/**
 * Large operators can cause PDF.js to split one visual row into two source
 * lines: the operator and its scripts land in one line while a neighboring
 * fraction plus prose land in another. Coalesce only the proved source case:
 * a vertically interleaved math-extension line beside a companion that owns a
 * small stacked pair and prose before the operator. The ordinary inline
 * splitter can then retain prose and crop the complete 2-D formula envelope.
 */
function mergeInterleavedStackedFormulaLines(lines: PdfTextLine[]) {
  const claimed = new Set<number>()
  const mergedAt = new Map<number, PdfTextLine>()

  for (const [lineIndex, line] of lines.entries()) {
    if (claimed.has(lineIndex)) continue
    const extensionRuns = line.runs.filter(mathExtensionSourceRun)
    if (extensionRuns.length === 0) continue
    const extensionLeft = Math.min(...extensionRuns.map((run) => run.x))
    const candidates = lines
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate, candidateIndex }) => {
        if (
          candidateIndex === lineIndex ||
          claimed.has(candidateIndex) ||
          candidate.page !== line.page
        ) {
          return false
        }
        const overlap = verticalLineOverlap(line, candidate)
        if (overlap < Math.min(line.height, candidate.height) * 0.45) {
          return false
        }
        const maximumFontSize = Math.max(
          ...candidate.runs.map((run) => run.fontSize),
        )
        const pairs = sourceStackedMathPairs(candidate.runs, maximumFontSize)
        if (pairs.length === 0) return false
        const pairNearExtension = pairs.some((pair) =>
          pair.some((run) =>
            extensionRuns.some(
              (extension) => horizontalBoxGap(run, extension) <= 0.02,
            ),
          ),
        )
        if (!pairNearExtension) return false
        return candidate.runs.some(
          (run) =>
            run.x + run.width <= extensionLeft &&
            !computerModernMathSourceRun(run, maximumFontSize) &&
            (run.text.match(/\p{L}{2,}/gu)?.length ?? 0) > 0,
        )
      })
      .sort(
        (left, right) =>
          Math.abs(left.candidate.y - line.y) -
            Math.abs(right.candidate.y - line.y) ||
          left.candidateIndex - right.candidateIndex,
      )
    const match = candidates[0]
    if (!match) continue

    const runs = [...line.runs, ...match.candidate.runs].sort(
      (left, right) => left.x - right.x || left.y - right.y,
    )
    const merged = textLineFromRuns(line, runs)
    const outputIndex = Math.min(lineIndex, match.candidateIndex)
    mergedAt.set(outputIndex, merged)
    claimed.add(lineIndex)
    claimed.add(match.candidateIndex)
  }

  return lines.flatMap((line, lineIndex) => {
    const merged = mergedAt.get(lineIndex)
    if (merged) return [merged]
    return claimed.has(lineIndex) ? [] : [line]
  })
}

/**
 * A PDF text line can contain a prose prefix and a visually stacked fraction
 * or simultaneous super/subscripts. Linear text merging cannot distinguish
 * those semantics. Split the source-backed two-dimensional run geometry,
 * retaining the prose runs as ordinary text and the exact run envelope as an
 * equation crop candidate.
 */
function splitSourceStackedInlineFormulaLines(lines: PdfTextLine[]) {
  return mergeInterleavedStackedFormulaLines(lines).flatMap(
    (line, lineIndex) => {
      const runs = line.runs.filter((run) => run.text.trim())
      if (runs.length < 2) return [line]
      const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
      const stackedPairs = sourceStackedMathPairs(runs, maximumFontSize)
      if (stackedPairs.length === 0) return [line]
      const baseId = `page-${String(line.page).padStart(3, '0')}-inline-stacked-${String(lineIndex + 1).padStart(4, '0')}`
      const withFragmentLineage = (
        fragmentLine: PdfTextLine,
        part: 'before' | 'formula' | 'after',
      ) => {
        const visibleRuns = fragmentLine.runs.filter((run) => run.text.trim())
        const sourceSequenceIndexes = visibleRuns.flatMap((run) =>
          run.sourceSequenceIndex === undefined
            ? []
            : [run.sourceSequenceIndex],
        )
        const sourceFragmentLineage =
          sourceSequenceIndexes.length === visibleRuns.length &&
          new Set(sourceSequenceIndexes).size === sourceSequenceIndexes.length
            ? {
                algorithm: 'source-run-fragment-v1' as const,
                sourceLineId: line.id ?? baseId,
                fragment: `inline-stacked-${part}` as const,
                sourceSequenceIndexes,
              }
            : undefined
        return {
          ...fragmentLine,
          ...(sourceFragmentLineage ? { sourceFragmentLineage } : {}),
        }
      }

      const formulaRuns = new Set(stackedPairs.flat())
      let expanded = true
      while (expanded) {
        expanded = false
        for (const candidate of runs) {
          const compactCandidateText = candidate.text.replace(/\s+/gu, '')
          const adjacentBaselineAnchor =
            candidate.fontSize >= maximumFontSize * 0.9 &&
            /^[\p{L}\p{N})\]}]{1,4}$/u.test(compactCandidateText) &&
            stackedPairs.some((pair) => {
              const pairLeft = Math.min(...pair.map((run) => run.x))
              const pairCenters = pair
                .map((run) => run.y + run.height / 2)
                .sort((left, right) => left - right)
              const horizontalGap = pairLeft - (candidate.x + candidate.width)
              const candidateCenter = candidate.y + candidate.height / 2
              return (
                !pair.includes(candidate) &&
                horizontalGap >= -0.001 &&
                horizontalGap <= Math.max(0.004, candidate.width * 0.45) &&
                candidateCenter > pairCenters[0] &&
                candidateCenter < pairCenters[1]
              )
            })
          if (
            formulaRuns.has(candidate) ||
            (!computerModernMathSourceRun(candidate, maximumFontSize) &&
              !adjacentBaselineAnchor)
          ) {
            continue
          }
          if (
            [...formulaRuns].some(
              (owned) => horizontalBoxGap(owned, candidate) <= 0.02,
            )
          ) {
            formulaRuns.add(candidate)
            expanded = true
          }
        }
      }
      const formulaLeft = Math.min(...[...formulaRuns].map((run) => run.x))
      const formulaRight = Math.max(
        ...[...formulaRuns].map((run) => run.x + run.width),
      )
      for (const candidate of runs) {
        if (
          !formulaRuns.has(candidate) &&
          /^[,.;:!?()[\]{}]+$/u.test(candidate.text.trim()) &&
          horizontalBoxGap(candidate, {
            ...candidate,
            x: formulaLeft,
            width: formulaRight - formulaLeft,
          }) <= 0.008
        ) {
          formulaRuns.add(candidate)
        }
      }
      const beforeRuns = runs.filter(
        (run) => !formulaRuns.has(run) && run.x + run.width <= formulaLeft,
      )
      const afterRuns = runs.filter(
        (run) => !formulaRuns.has(run) && run.x >= formulaRight,
      )
      const unownedRuns = runs.filter(
        (run) =>
          !formulaRuns.has(run) &&
          !beforeRuns.includes(run) &&
          !afterRuns.includes(run),
      )
      const proseWordCount =
        [...beforeRuns, ...afterRuns]
          .map((run) => run.text)
          .join(' ')
          .match(/\p{L}{2,}/gu)?.length ?? 0
      const hasProseSiblings = beforeRuns.length > 0 || afterRuns.length > 0
      if (unownedRuns.length > 0 || (hasProseSiblings && proseWordCount < 2)) {
        // The stacked source geometry is still ambiguous even when the
        // surrounding text cannot be split conservatively. Withhold the whole
        // line as one equation obligation rather than publishing guessed
        // super/subscript semantics.
        return [
          withFragmentLineage({ ...line, id: `${baseId}-formula` }, 'formula'),
        ]
      }

      const fragments: PdfTextLine[] = []
      if (beforeRuns.length > 0) {
        fragments.push(
          withFragmentLineage(
            {
              ...textLineFromRuns(line, beforeRuns),
              id: `${baseId}-before`,
            },
            'before',
          ),
        )
      }
      fragments.push(
        withFragmentLineage(
          {
            ...textLineFromRuns(
              line,
              [...formulaRuns].sort(
                (left, right) => left.x - right.x || left.y - right.y,
              ),
            ),
            id: `${baseId}-formula`,
          },
          'formula',
        ),
      )
      if (afterRuns.length > 0) {
        fragments.push(
          withFragmentLineage(
            {
              ...textLineFromRuns(line, afterRuns),
              id: `${baseId}-after`,
            },
            'after',
          ),
        )
      }
      return fragments
    },
  )
}

function splitDetachedMathExtensionProseRuns(lines: PdfTextLine[]) {
  const mathFont = (fontName: string) =>
    /(?:cmmi|cmsy|cmex|math|symbol)/iu.test(fontName)
  const extensionFont = (fontName: string) =>
    /(?:CMEX|MathExtensions)/iu.test(fontName)
  const sourceLineId = (line: PdfTextLine, lineIndex: number) =>
    line.id ??
    `page-${String(line.page).padStart(3, '0')}-source-line-${String(lineIndex + 1).padStart(4, '0')}`
  const lineIndexes = new Map(lines.map((line, lineIndex) => [line, lineIndex]))
  const exactRadicalHosts = new Map<PdfSourceRun, string>()
  const exactHostLineIds = new Map<PdfTextLine, string>()
  const runEntries = lines.flatMap((line) =>
    line.runs.filter((run) => run.text.trim()).map((run) => ({ line, run })),
  )

  for (const { line: rootLine, run: root } of runEntries) {
    if (
      root.text.trim() !== '√' ||
      !extensionFont(root.fontName) ||
      root.sourceSequenceIndex === undefined
    ) {
      continue
    }
    const candidates = runEntries.filter(({ line, run: candidate }) => {
      if (
        line === rootLine ||
        line.page !== rootLine.page ||
        candidate.sourceSequenceIndex !== root.sourceSequenceIndex! + 1 ||
        !candidate.text.trim() ||
        extensionFont(candidate.fontName) ||
        !mathFont(candidate.fontName)
      ) {
        return false
      }
      if (
        root.sourceTextPaint &&
        candidate.sourceTextPaint &&
        (root.sourceTextPaint.textLedgerSha256 !==
          candidate.sourceTextPaint.textLedgerSha256 ||
          root.sourceTextPaint.operatorLedgerSha256 !==
            candidate.sourceTextPaint.operatorLedgerSha256)
      ) {
        return false
      }
      const horizontalTolerance = Math.max(0.00001, root.width * 0.001)
      const radicalBottom = root.y + root.height
      const verticalTolerance = Math.max(0.001, root.height * 0.08)
      const fontSizeRatio = candidate.fontSize / root.fontSize
      const heightRatio = candidate.height / root.height
      return (
        Math.abs(candidate.x - (root.x + root.width)) <= horizontalTolerance &&
        candidate.y > root.y + root.height * 0.5 &&
        Math.abs(candidate.y - radicalBottom) <= verticalTolerance &&
        fontSizeRatio >= 0.65 &&
        fontSizeRatio <= 1.5 &&
        heightRatio >= 0.65 &&
        heightRatio <= 1.5
      )
    })
    if (candidates.length !== 1) continue
    const hostLine = candidates[0].line
    const hostLineIndex = lineIndexes.get(hostLine)
    if (hostLineIndex === undefined) continue
    const hostLineId = sourceLineId(hostLine, hostLineIndex)
    exactHostLineIds.set(hostLine, hostLineId)
    exactRadicalHosts.set(root, hostLineId)
  }
  const probableHost = (line: PdfTextLine) => {
    if (proseDominantInlineMathLine(line)) return false
    if (/-inline-stacked-\d+-formula$/u.test(line.id ?? '')) return true
    const runs = line.runs.filter((run) => run.text.trim())
    const visibleCharacters = runs.reduce(
      (total, run) => total + run.text.replace(/\s+/gu, '').length,
      0,
    )
    const mathCharacters = runs
      .filter((run) => mathFont(run.fontName))
      .reduce((total, run) => total + run.text.replace(/\s+/gu, '').length, 0)
    return (
      visibleCharacters > 0 &&
      mathCharacters / visibleCharacters >= 0.7 &&
      /[=+−×÷∫∑√≤≥≈]/u.test(line.text)
    )
  }
  const hosts = lines.filter(probableHost)
  const boxDistance = (run: PdfSourceRun, line: PdfTextLine) => {
    const horizontalGap = Math.max(
      line.x - (run.x + run.width),
      run.x - (line.x + line.width),
      0,
    )
    const verticalGap = Math.max(
      line.y - (run.y + run.height),
      run.y - (line.y + line.height),
      0,
    )
    const centerDistance = Math.abs(
      run.x + run.width / 2 - (line.x + line.width / 2),
    )
    return verticalGap * 2 + horizontalGap + centerDistance * 0.05
  }

  return lines.flatMap((line, lineIndex) => {
    const preparedLine =
      !line.id && exactHostLineIds.has(line)
        ? { ...line, id: exactHostLineIds.get(line)! }
        : line
    const runs = line.runs.filter((run) => run.text.trim())
    const extensionRuns = runs.filter(
      (run) =>
        extensionFont(run.fontName) &&
        /^[√∫∑∏()[\]{}|]+$/u.test(run.text.trim()),
    )
    const proseRuns = runs.filter((run) => !extensionRuns.includes(run))
    if (extensionRuns.length === 0) return [preparedLine]
    const fallbackProseCue =
      proseRuns.length > 0 &&
      proseDominantPdfMathSource({
        text: proseRuns.map((run) => run.text).join(' '),
        width:
          Math.max(...proseRuns.map((run) => run.x + run.width)) -
          Math.min(...proseRuns.map((run) => run.x)),
        runs: proseRuns,
      })
    const exactDetached = extensionRuns.filter((run) =>
      exactRadicalHosts.has(run),
    )
    if (!fallbackProseCue && exactDetached.length === 0) return [preparedLine]
    const maximumProseFontSize =
      proseRuns.length > 0
        ? Math.max(...proseRuns.map((run) => run.fontSize))
        : 0
    const proseBaselineCenter =
      proseRuns.length > 0
        ? proseRuns.reduce((total, run) => total + run.y + run.height / 2, 0) /
          proseRuns.length
        : 0
    const detachedHosts = new Map<PdfSourceRun, string | null>()
    const detached = extensionRuns.filter((run) => {
      const exactHost = exactRadicalHosts.get(run)
      if (exactHost) {
        detachedHosts.set(run, exactHost)
        return true
      }
      if (!fallbackProseCue) return false
      if (
        run.fontSize > maximumProseFontSize * 0.82 ||
        Math.abs(run.y + run.height / 2 - proseBaselineCenter) <
          Math.max(0.002, run.height * 0.3)
      ) {
        return false
      }
      const candidates = hosts
        .filter((host) => {
          if (host === line || host.page !== line.page || !host.id) return false
          const horizontalGap = Math.max(
            host.x - (run.x + run.width),
            run.x - (host.x + host.width),
            0,
          )
          const verticalGap = Math.max(
            host.y - (run.y + run.height),
            run.y - (host.y + host.height),
            0,
          )
          return horizontalGap <= 0.02 && verticalGap <= 0.018
        })
        .map((host) => ({ host, score: boxDistance(run, host) }))
        .sort(
          (left, right) =>
            left.score - right.score ||
            sourceLineFlowOrder(left.host, right.host),
        )
      const uniquelyHosted =
        candidates.length > 0 &&
        (candidates.length === 1 ||
          candidates[1].score - candidates[0].score > 0.0015)
      if (uniquelyHosted) {
        detachedHosts.set(run, candidates[0].host.id!)
      } else {
        // A visibly displaced extension glyph is not prose merely because two
        // nearby formula hosts are tied. Split it into an explicit unresolved
        // equation obligation; retaining it in the cue would silently publish
        // the prose while allowing both candidate formulas to omit the glyph.
        detachedHosts.set(run, null)
      }
      return true
    })
    if (detached.length === 0) return [preparedLine]
    const retainedRuns = runs.filter((run) => !detached.includes(run))
    const fragments: PdfTextLine[] =
      retainedRuns.length > 0
        ? [
            {
              ...textLineFromRuns(preparedLine, retainedRuns),
              id: preparedLine.id,
            },
          ]
        : []
    for (const [index, run] of detached.entries()) {
      const detachedSourceLineId = sourceLineId(preparedLine, lineIndex)
      const hostLineId = detachedHosts.get(run)
      fragments.push({
        ...textLineFromRuns(preparedLine, [run]),
        id: `${detachedSourceLineId}-detached-math-${String(index + 1).padStart(3, '0')}-host-${
          hostLineId ? encodeURIComponent(hostLineId) : 'ambiguous'
        }`,
      })
    }
    return fragments
  })
}

function inlineStackedFragmentParts(line: Pick<PdfTextLine, 'id'>) {
  const match = line.id?.match(
    /^(.*-inline-stacked-\d+)-(before|formula|after)$/u,
  )
  return match
    ? {
        baseId: match[1],
        part: match[2] as 'before' | 'formula' | 'after',
      }
    : null
}

function inlineStackedFragmentOrder(
  left: Pick<PdfTextLine, 'id'>,
  right: Pick<PdfTextLine, 'id'>,
) {
  const leftParts = inlineStackedFragmentParts(left)
  const rightParts = inlineStackedFragmentParts(right)
  if (!leftParts || !rightParts || leftParts.baseId !== rightParts.baseId) {
    return null
  }
  const order = { before: 0, formula: 1, after: 2 } as const
  return order[leftParts.part] - order[rightParts.part]
}

function restoreInlineStackedAtomicUnits(ordered: PdfPageRegion[]) {
  const units = new Map<
    string,
    {
      page: number
      invalid: boolean
      parts: Map<'before' | 'formula' | 'after', PdfPageRegion>
    }
  >()
  const basesByRegionId = new Map<string, Set<string>>()

  for (const region of ordered) {
    for (const line of region.lines) {
      const fragment = inlineStackedFragmentParts(line)
      if (!fragment) continue
      const unit = units.get(fragment.baseId) ?? {
        page: region.page,
        invalid: false,
        parts: new Map<'before' | 'formula' | 'after', PdfPageRegion>(),
      }
      const existing = unit.parts.get(fragment.part)
      if (unit.page !== region.page || existing !== undefined) {
        unit.invalid = true
      }
      unit.parts.set(fragment.part, region)
      units.set(fragment.baseId, unit)
      const regionBases = basesByRegionId.get(region.id) ?? new Set<string>()
      regionBases.add(fragment.baseId)
      basesByRegionId.set(region.id, regionBases)
    }
  }

  const validUnits = new Map<
    string,
    [PdfPageRegion, PdfPageRegion, PdfPageRegion]
  >()
  for (const [baseId, unit] of units) {
    const before = unit.parts.get('before')
    const formula = unit.parts.get('formula')
    const after = unit.parts.get('after')
    const regionIds = new Set(
      [before, formula, after].flatMap((region) =>
        region === undefined ? [] : [region.id],
      ),
    )
    const notePartitions = new Set(
      [before, formula, after].flatMap((region) =>
        region === undefined
          ? []
          : [region.kind === 'footnote' || region.kind === 'endnote'],
      ),
    )
    if (
      unit.invalid ||
      !before ||
      !formula ||
      !after ||
      regionIds.size !== 3 ||
      notePartitions.size !== 1 ||
      [...regionIds].some(
        (regionId) => (basesByRegionId.get(regionId)?.size ?? 0) !== 1,
      )
    ) {
      continue
    }
    validUnits.set(baseId, [before, formula, after])
  }
  if (validUnits.size === 0) return ordered

  const unitByRegionId = new Map<
    string,
    [PdfPageRegion, PdfPageRegion, PdfPageRegion]
  >()
  for (const unit of validUnits.values()) {
    for (const region of unit) unitByRegionId.set(region.id, unit)
  }
  const emittedRegionIds = new Set<string>()
  return ordered.flatMap((region) => {
    if (emittedRegionIds.has(region.id)) return []
    const unit = unitByRegionId.get(region.id)
    if (!unit) {
      emittedRegionIds.add(region.id)
      return [region]
    }
    for (const member of unit) emittedRegionIds.add(member.id)
    return unit
  })
}

function sourceLineFlowOrder(left: PdfTextLine, right: PdfTextLine) {
  if (left.page !== right.page) return left.page - right.page
  const inlineOrder = inlineStackedFragmentOrder(left, right)
  return inlineOrder ?? (left.y - right.y || left.x - right.x)
}

function emphasizedSourceRun(run: PdfTextLine['runs'][number]) {
  return (
    run.bold === true ||
    /(?:bold|semibold|demi|medi(?:um)?|black)/iu.test(run.fontName) ||
    /(?:^|[+,._\s-])cm(?:bx|b)(?:ti|sl)?\d*(?=$|[+,._\s-])/iu.test(
      run.fontName,
    ) ||
    /(?:^|[+,._\s-])lin(?:biolinum|libertine)t?b(?:i)?(?=$|[+,._\s-])/iu.test(
      run.fontName,
    )
  )
}

function sourceProvenRepeatedMarginHeadingLines(
  pages: readonly (readonly PdfTextLine[])[],
  repeated: ReadonlySet<string>,
) {
  const candidates = pages.flatMap((lines) =>
    lines.flatMap((line) => {
      const runs = line.runs
        .filter((run) => run.text.trim())
        .sort((left, right) => left.x - right.x)
      if (!marginBand(line) || runs.length !== 2) return []
      const prefixText = runs[0].text.replace(/\s+/gu, ' ').trim()
      const titleText = runs[1].text.replace(/\s+/gu, ' ').trim()
      const prefix = prefixText.match(
        /^([A-Z])\.(\d{1,3}(?:\.\d{1,3}){0,2})\.?$/u,
      )
      const titleWords = titleText.match(/[\p{L}\p{N}]+/gu) ?? []
      const normalizedTitle = normalizeMarginText(titleText)
      if (
        !prefix ||
        !repeated.has(normalizedTitle) ||
        !normalizedTitle.includes('#') ||
        titleWords.length < 2 ||
        titleWords.length > 12 ||
        titleText.length > 120 ||
        !/^\p{Lu}/u.test(titleText) ||
        /[.!?;:](?:["'’”)\]]*)$/u.test(titleText) ||
        !emphasizedSourceRun(runs[0]) ||
        !emphasizedSourceRun(runs[1]) ||
        runs[0].fontName !== runs[1].fontName ||
        runs[0].width > 0.08 ||
        runs[1].width < 0.12
      ) {
        return []
      }
      const ordinal = prefix[2].split('.').map(Number)
      const finalOrdinal = ordinal.at(-1)!
      const titleOrdinal = Number(titleText.match(/(\d{1,3})\s*$/u)?.[1])
      const fontRatio =
        Math.max(runs[0].fontSize, runs[1].fontSize) /
        Math.max(1, Math.min(runs[0].fontSize, runs[1].fontSize))
      const baselineGap = Math.abs(
        runs[0].y + runs[0].height / 2 - (runs[1].y + runs[1].height / 2),
      )
      const horizontalGap = runs[1].x - (runs[0].x + runs[0].width)
      if (
        titleOrdinal !== finalOrdinal ||
        fontRatio > 1.03 ||
        baselineGap >
          Math.max(0.0025, Math.min(runs[0].height, runs[1].height) * 0.2) ||
        horizontalGap < 0 ||
        horizontalGap > 0.035
      ) {
        return []
      }
      return [
        {
          line,
          letter: prefix[1],
          ordinal,
          normalizedTitle,
        },
      ]
    }),
  )
  const groups = new Map<string, typeof candidates>()
  for (const candidate of candidates) {
    const key = `${candidate.letter}\u0000${candidate.normalizedTitle}`
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }

  const protectedLines = new Set<PdfTextLine>()
  const allLines = pages.flat()
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        left.line.page - right.line.page || left.line.y - right.line.y,
    )
    const depth = ordered[0]?.ordinal.length ?? 0
    if (
      ordered.length < 3 ||
      ordered[0].ordinal.at(-1) !== 1 ||
      ordered.some(
        (candidate, index) =>
          candidate.ordinal.length !== depth ||
          candidate.line.page <= (ordered[index - 1]?.line.page ?? 0) ||
          candidate.ordinal
            .slice(0, -1)
            .some(
              (part, partIndex) => part !== ordered[0].ordinal[partIndex],
            ) ||
          candidate.ordinal.at(-1) !== index + 1,
      )
    ) {
      continue
    }
    const first = ordered[0]
    const parentPattern = new RegExp(`^${first.letter}\\.?\\s+\\p{Lu}`, 'u')
    const parent = allLines.find((line) => {
      const text = line.text.replace(/\s+/gu, ' ').trim()
      const visibleRuns = line.runs.filter((run) => run.text.trim())
      const precedesFirst =
        line.page < first.line.page ||
        (line.page === first.line.page && line.y < first.line.y)
      return (
        precedesFirst &&
        parentPattern.test(text) &&
        text.length <= 120 &&
        !/[.!?;:](?:["'’”)\]]*)$/u.test(text) &&
        visibleRuns.length > 0 &&
        visibleRuns.every(emphasizedSourceRun) &&
        Math.max(...visibleRuns.map((run) => run.fontSize)) >=
          first.line.fontSize * 0.95
      )
    })
    if (!parent) continue
    ordered.forEach((candidate) => protectedLines.add(candidate.line))
  }
  return protectedLines
}

function splitRepeatedMarginSourceRuns(
  lines: PdfTextLine[],
  repeated: ReadonlySet<string>,
  protectedLines: ReadonlySet<PdfTextLine> = new Set(),
  furnitureByRunKey: ReadonlyMap<string, PdfFurnitureEvidence> = new Map(),
) {
  return lines.flatMap((line) => {
    if (
      protectedLines.has(line) ||
      !marginBand(line) ||
      line.runs.length < 2 ||
      noteLabelFromText(line.text) !== null
    ) {
      return [line]
    }
    const orderedRuns = [...line.runs].sort((left, right) => left.x - right.x)
    const repeatedIndexes = orderedRuns.flatMap((run, index) =>
      marginBand(run) &&
      (furnitureByRunKey.has(furnitureRunKey(run)) ||
        repeated.has(normalizeMarginText(run.text)))
        ? [index]
        : [],
    )
    if (repeatedIndexes.length === 0) return [line]
    // A diagram title and a margin run can overlap vertically enough for line
    // grouping to fuse them. Split only runs with furniture evidence (or a
    // bounded review record), retaining every residual run as its own line.
    const repeatedIndexSet = new Set(repeatedIndexes)
    const fragments: PdfTextLine[] = []
    let ordinaryRuns: typeof orderedRuns = []
    const flushOrdinaryRuns = () => {
      if (ordinaryRuns.length === 0) return
      fragments.push(textLineFromRuns(line, ordinaryRuns))
      ordinaryRuns = []
    }
    orderedRuns.forEach((run, index) => {
      if (!repeatedIndexSet.has(index)) {
        ordinaryRuns.push(run)
        return
      }
      flushOrdinaryRuns()
      fragments.push(textLineFromRuns(line, [run]))
    })
    flushOrdinaryRuns()
    return fragments.sort((left, right) => left.x - right.x)
  })
}

function explicitFirstPageParatextSeed(line: PdfTextLine, bodySize: number) {
  if (line.page !== 1 || line.y < 0.65) return false
  const text = line.text.replace(/\s+/gu, ' ').trim()
  const geometricFooter =
    line.x < 0.45 &&
    line.x + line.width > 0.55 &&
    line.width >= 0.4 &&
    line.height <= 0.04 &&
    // Geometry alone must not turn ordinary first-page prose near the bottom
    // into page furniture. Unlabelled publication bands are materially
    // smaller than body text; explicit address/legal/venue patterns below
    // remain eligible independently of this stricter typographic gate.
    medianLineFontSize(line) <= bodySize * 0.86 &&
    (text.match(/\p{L}{2,}/gu)?.length ?? 0) >= 4 &&
    !beginsVisualCaption(text) &&
    noteLabelFromText(text) === null
  return (
    geometricFooter ||
    /^authors?[’']?\s+address\s*:/iu.test(text) ||
    /^(?:permission to (?:make|copy)|(?:this )?work is licensed under|licensed under (?:the )?|creative commons\b|all rights reserved\b)/iu.test(
      text,
    ) ||
    /^(?:©\s*)?(?:\d{4}\s+)?copyright\b/iu.test(text) ||
    /^proceedings\s+of\s+(?:the\s+)?(?:\d+\s*(?:st|nd|rd|th)?\s+)?(?:international\s+)?(?:conference|symposium|workshop)\b/iu.test(
      text,
    ) ||
    /^(?:preprint(?:[.,].*)?|manuscript under review|under review)\.?$/iu.test(
      text,
    )
  )
}

function medianLineFontSize(line: PdfTextLine) {
  return (
    median(
      line.runs
        .filter((run) => run.text.trim())
        .map((run) => run.fontSize)
        .filter((size) => size > 0),
    ) || line.fontSize
  )
}

function firstPageParatextLines(lines: PdfTextLine[]) {
  const bodySize = bodyFontSize(lines)
  const ordered = [...lines].sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )
  const bibliographyHeadingY = ordered.find((line) =>
    /^(?:(?:\d+(?:\.\d+)*)[.)]?\s+)?references$/iu.test(line.text.trim()),
  )?.y
  const claimed = new Set<PdfTextLine>()
  for (const [seedIndex, seed] of ordered.entries()) {
    if (bibliographyHeadingY !== undefined && seed.y > bibliographyHeadingY) {
      continue
    }
    if (!explicitFirstPageParatextSeed(seed, bodySize)) continue
    claimed.add(seed)
    let previous = seed
    for (const candidate of ordered.slice(seedIndex + 1)) {
      if (candidate.page !== 1 || candidate.y < previous.y) continue
      const compactInlineFragment =
        candidate.text.trim().length <= 4 &&
        candidate.width <= 0.05 &&
        candidate.x >= seed.x - 0.01 &&
        candidate.x + candidate.width <= seed.x + seed.width + 0.01 &&
        candidate.y < seed.y + seed.height &&
        candidate.y + candidate.height > seed.y
      if (compactInlineFragment) {
        claimed.add(candidate)
        continue
      }
      const horizontalOverlap = Math.max(
        0,
        Math.min(seed.x + seed.width, candidate.x + candidate.width) -
          Math.max(seed.x, candidate.x),
      )
      const overlapRatio =
        horizontalOverlap /
        Math.max(0.001, Math.min(seed.width, candidate.width))
      const aligned =
        Math.abs(candidate.x - seed.x) <= 0.08 || overlapRatio >= 0.72
      const horizontalSeparation = Math.max(
        candidate.x - (seed.x + seed.width),
        seed.x - (candidate.x + candidate.width),
        0,
      )
      if (!aligned && horizontalSeparation >= 0.012) continue
      const gap = candidate.y - (previous.y + previous.height)
      const fontRatio =
        Math.max(medianLineFontSize(previous), medianLineFontSize(candidate)) /
        Math.max(
          1,
          Math.min(medianLineFontSize(previous), medianLineFontSize(candidate)),
        )
      const wrapped =
        gap >= -0.002 &&
        gap <= Math.max(0.012, previous.height * 1.8) &&
        fontRatio <= 1.12 &&
        aligned &&
        !beginsVisualCaption(candidate.text) &&
        noteLabelFromText(candidate.text) === null
      if (!wrapped) break
      claimed.add(candidate)
      previous = candidate
    }
  }
  return claimed
}

const UNICODE_DECIMAL_ZERO_CODE_POINTS = [
  0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66,
  0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040,
  0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0,
  0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0,
  0xff10, 0x104a0, 0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0,
  0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730,
  0x118e0, 0x11950, 0x11bf0, 0x11c50, 0x11d50, 0x11da0, 0x11de0, 0x11f50,
  0x16130, 0x16a60, 0x16ac0, 0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8,
  0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950,
  0x1fbf0,
] as const

function normalizedDecimalDigit(character: string) {
  const codePoint = character.codePointAt(0)!
  for (const zero of UNICODE_DECIMAL_ZERO_CODE_POINTS) {
    if (codePoint >= zero && codePoint <= zero + 9) {
      return String(codePoint - zero)
    }
  }
  return character
}

export function normalizedNoteLabel(value: string) {
  const superscripts: Record<string, string> = {
    '⁰': '0',
    '¹': '1',
    '²': '2',
    '³': '3',
    '⁴': '4',
    '⁵': '5',
    '⁶': '6',
    '⁷': '7',
    '⁸': '8',
    '⁹': '9',
    '∗': '*',
  }
  return [...value]
    .map(
      (character) =>
        superscripts[character] ?? normalizedDecimalDigit(character),
    )
    .join('')
    .trim()
}

export function noteLabelFromText(text: string) {
  const normalized = normalizedNoteLabel(text)
  const attachedSymbolic = normalized.match(/^([*†‡§])/u)
  if (attachedSymbolic) return attachedSymbolic[1]
  const explicit = normalized.match(
    new RegExp(`^(?:footnote|note)\\s+(${NOTE_LABEL})(?:\\s*[:.)-]|\\s+)`, 'i'),
  )
  if (explicit) return explicit[1]
  const leading = normalized.match(
    new RegExp(`^(${NOTE_LABEL})(?:[.)\\]]|\\s+)`),
  )
  return leading?.[1] ?? null
}

const NUMBERED_BODY_SECTION_TITLE =
  /^(?:abstract|introduction|background|related work|literature review|methods?|methodology|approach|framework|experiments?|evaluation|results?|discussion|limitations?|conclusion|references|appendix)\b/iu

function numberedBodySectionHeading(text: string) {
  const match = text.match(
    /^(\d{1,3}(?:\.\d+){0,3})([.)]?)\s+(\p{Lu}[^.,;:!?]{0,99})$/u,
  )
  if (!match) return false
  const [, sectionNumber, markerPunctuation, title] = match
  return (
    sectionNumber.includes('.') ||
    (markerPunctuation === '' && NUMBERED_BODY_SECTION_TITLE.test(title))
  )
}

function fusedNumberedListOrdinal(line: PdfTextLine) {
  const firstRun = line.runs.find((run) => run.text.trim())
  const match = firstRun?.text.match(/^\s*(\d{1,3})\.\s+\S/u)
  return match ? Number(match[1]) : null
}

function sourceSmallCapsTypography(line: PdfTextLine) {
  const letters = line.text.match(/\p{L}/gu) ?? []
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

function sourceStyledBoundaryHeadingLine(
  lines: readonly PdfTextLine[],
  lineIndex: number,
  bodySize: number,
) {
  const line = lines[lineIndex]
  const text = line.text.replace(/\s+/gu, ' ').trim()
  const letters = text.match(/\p{L}/gu) ?? []
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? []
  if (
    text.length > 96 ||
    letters.length < 4 ||
    words.length === 0 ||
    words.length > 10 ||
    letters.some((letter) => letter !== letter.toLocaleUpperCase()) ||
    /(?:https?:\/\/|www\.|\S*[_@]\S*|(?:\.\s*){3,})/iu.test(text)
  ) {
    return false
  }
  const emphasized =
    line.runs.some(
      (run) =>
        run.bold === true ||
        /(?:bold|semibold|demi|medi(?:um)?|black)/iu.test(run.fontName) ||
        /(?:^|[+,._\s-])cm(?:bx|b)(?:ti|sl)?\d*(?=$|[+,._\s-])/iu.test(
          run.fontName,
        ) ||
        /(?:^|[+,._\s-])lin(?:biolinum|libertine)t?b(?:i)?(?=$|[+,._\s-])/iu.test(
          run.fontName,
        ),
    ) ||
    sourceSmallCapsTypography(line) ||
    line.fontSize >= bodySize * 1.12
  if (!emphasized) return false

  const contentLike = (candidate: PdfTextLine) =>
    candidate.text.trim().length >= 40 &&
    candidate.width >= Math.max(0.3, line.width * 1.35) &&
    Math.abs(candidate.x - line.x) <= 0.07
  const previous = lines
    .slice(0, lineIndex)
    .reverse()
    .find(
      (candidate) =>
        contentLike(candidate) &&
        candidate.y + candidate.height <= line.y + 0.002,
    )
  const next = lines
    .slice(lineIndex + 1)
    .find(
      (candidate) =>
        contentLike(candidate) && candidate.y >= line.y + line.height - 0.002,
    )
  if (!next) return false
  const lineHeight = Math.max(line.height, 0.008)
  const precedingGap = previous
    ? line.y - (previous.y + previous.height)
    : Number.POSITIVE_INFINITY
  const followingGap = next.y - (line.y + line.height)
  const startsAtPageBoundary = !previous && line.y <= 0.22
  return (
    (startsAtPageBoundary ||
      precedingGap >= Math.max(0.006, lineHeight * 0.45)) &&
    followingGap >= Math.max(0.004, lineHeight * 0.3) &&
    followingGap <= Math.max(0.055, lineHeight * 3.5)
  )
}

function hasApparentNumericNoteReference(
  lines: readonly PdfTextLine[],
  definitionLines: ReadonlySet<PdfTextLine>,
  labels: ReadonlySet<string>,
) {
  const explicitReference = new RegExp(
    String.raw`\b(?:footnote|note(?:\s+reference)?)\s*#?\s*(${[...labels].join('|')})\b`,
    'iu',
  )
  for (const line of lines) {
    if (definitionLines.has(line)) continue
    if (explicitReference.test(normalizedNoteLabel(line.text))) return true
    const runs = line.runs.filter((run) => run.text.trim())
    const largestFont = Math.max(...runs.map((run) => run.fontSize), 0)
    const tallestRun = Math.max(...runs.map((run) => run.height), 0)
    if (
      runs.some(
        (run) =>
          labels.has(normalizedNoteLabel(run.text)) &&
          runs.length > 1 &&
          (run.fontSize <= largestFont * 0.82 ||
            run.height <= tallestRun * 0.82),
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * A compact numbered prompt/list at the bottom of a page can share every
 * coarse feature of a footnote band. Keep only the narrow source-backed case:
 * at least three consecutive dotted items beginning at 1, aligned and set in
 * one fused prose run, with no raised or explicit same-page note reference.
 * Separately typeset note markers and referenced compact note bands therefore
 * remain eligible for normal note classification.
 */
function unreferencedSequentialNumberedListLines(lines: PdfTextLine[]) {
  const candidates = lines
    .flatMap((line) => {
      const ordinal = fusedNumberedListOrdinal(line)
      return ordinal === null ? [] : [{ line, ordinal }]
    })
    .sort(
      (left, right) => left.line.y - right.line.y || left.line.x - right.line.x,
    )
  const sequences: (typeof candidates)[] = []
  let sequence: typeof candidates = []
  const flush = () => {
    if (sequence.length > 0) sequences.push(sequence)
    sequence = []
  }
  for (const candidate of candidates) {
    const previous = sequence.at(-1)
    const fontRatio = previous
      ? Math.max(previous.line.fontSize, candidate.line.fontSize) /
        Math.max(1, Math.min(previous.line.fontSize, candidate.line.fontSize))
      : 1
    if (
      previous &&
      candidate.ordinal === previous.ordinal + 1 &&
      candidate.line.y - previous.line.y <=
        Math.max(0.06, previous.line.height * 5) &&
      Math.abs(candidate.line.x - previous.line.x) <=
        Math.max(0.012, previous.line.height) &&
      fontRatio <= 1.08
    ) {
      sequence.push(candidate)
    } else {
      flush()
      sequence = [candidate]
    }
  }
  flush()

  const bodyListLines = new Set<PdfTextLine>()
  for (const candidateSequence of sequences) {
    if (candidateSequence.length < 3 || candidateSequence[0].ordinal !== 1) {
      continue
    }
    const definitionLines = new Set(
      candidateSequence.map((candidate) => candidate.line),
    )
    const labels = new Set(
      candidateSequence.map((candidate) => String(candidate.ordinal)),
    )
    if (hasApparentNumericNoteReference(lines, definitionLines, labels)) {
      continue
    }
    for (const candidate of candidateSequence) {
      bodyListLines.add(candidate.line)
    }
  }
  return bodyListLines
}

function bodyFontSize(lines: PdfTextLine[]) {
  const central = lines.filter(
    (line) => line.y > 0.1 && line.y + line.height < 0.9,
  )
  const prose = central.filter(
    (line) =>
      line.width >= 0.25 && (line.text.match(/\p{L}{2,}/gu)?.length ?? 0) >= 3,
  )
  // Dense plots and diagrams can contribute hundreds of tiny label lines and
  // overwhelm a page-wide font quantile. Prefer repeated, wide prose evidence
  // whenever it exists so genuine bottom notes are compared with the document
  // body rather than with chart ticks.
  const population =
    prose.length >= 2 ? prose : central.length > 0 ? central : lines
  const sizes = population
    .map((line) => line.fontSize)
    .filter((size) => size > 0)
  return quantile(sizes, 0.75) || median(sizes) || 12
}

type NoteLineClassificationEvidence = {
  label: string | null
  explicitFootnote: boolean
  symbolicFootnote: boolean
  renderedFootnote: boolean
}

function noteLineClassificationEvidence(
  line: PdfTextLine,
  fontSize: number,
  lowerBand: number,
  numberedBodyListLines: ReadonlySet<PdfTextLine>,
): NoteLineClassificationEvidence {
  const normalized = normalizedNoteLabel(line.text)
  const label = noteLabelFromText(normalized)
  const explicitFootnote = new RegExp(
    `^(?:footnote|note)\\s+${NOTE_LABEL}`,
    'i',
  ).test(normalized)
  const symbolicFootnote = /^[*†‡§]/u.test(normalized)
  const substantiveRuns = line.runs.filter((run) => run.text.trim())
  const monospacedNumberedContent =
    !symbolicFootnote &&
    /^\d{1,3}(?:[.)\]]|\s)/u.test(normalized) &&
    substantiveRuns.length > 0 &&
    substantiveRuns.every((run) =>
      /(?:courier|inconsolata|nimbusmon|mono|typewriter|cmtt|lmtt|sftt)/iu.test(
        run.fontName,
      ),
    )
  // Decimal-leading lower-band content is overwhelmingly a plot tick, metric
  // row, or table cell, not an integer-labeled note body. Integer-only labels
  // remain eligible because a genuine footnote may place its marker on a line
  // of its own.
  const decimalTabularContent = /^[-+]?\d+[.,]\d/u.test(normalized)
  const isolatedMarginFolio =
    substantiveRuns.length > 0 &&
    substantiveRuns.every((run) =>
      marginTextIsNumeralOnly(run.text.normalize('NFKC').trim()),
    ) &&
    (line.y <= 0.08 || line.y + line.height >= 0.92)
  const renderedFootnote =
    label !== null &&
    !decimalTabularContent &&
    !isolatedMarginFolio &&
    !monospacedNumberedContent &&
    !numberedBodyListLines.has(line) &&
    !numberedBodySectionHeading(normalized) &&
    line.y + line.height >= lowerBand &&
    line.fontSize >= 5 &&
    line.fontSize <= fontSize * (symbolicFootnote ? 0.96 : 0.9) + 0.01
  return {
    label,
    explicitFootnote,
    symbolicFootnote,
    renderedFootnote,
  }
}

/**
 * Footnote ownership is resolved before furniture. This hand-off is
 * geometry- and marker-based; it deliberately has no journal or keyword
 * allowlist. Any source run in a note-owned line is deferred to the note
 * stratum, so a repeated lower band cannot hide a genuine note body.
 */
function noteStratumRunKeys(lines: readonly PdfTextLine[]) {
  const pageFontSize = bodyFontSize([...lines])
  const numberedBodyListLines = unreferencedSequentialNumberedListLines([
    ...lines,
  ])
  const lowerBand = quantile(
    lines.map((line) => line.y + line.height),
    0.65,
  )
  const orderedLines = [...lines].sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )
  const keys = new Set<string>()
  const noteSeeds = orderedLines.filter((line) => {
    const evidence = noteLineClassificationEvidence(
      line,
      pageFontSize,
      lowerBand,
      numberedBodyListLines,
    )
    return evidence.explicitFootnote || evidence.renderedFootnote
  })
  for (const seed of noteSeeds) {
    for (const run of seed.runs) {
      if (run.text.trim()) keys.add(furnitureRunKey(run))
    }
    let previous = seed
    while (
      !endsCaptionSentence(previous.text) ||
      endsIncompleteWrappedUrl(previous.text)
    ) {
      const candidate = orderedLines
        .filter((line) => {
          if (
            line.page !== seed.page ||
            line === seed ||
            line.y <= previous.y ||
            noteLabelFromText(line.text) !== null
          ) {
            return false
          }
          const verticalGap = line.y - (previous.y + previous.height)
          const fontTolerance = Math.max(0.6, seed.fontSize * 0.08)
          return (
            verticalGap <= Math.max(0.008, seed.height * 0.8) &&
            Math.abs(line.x - seed.x) <= 0.04 &&
            Math.abs(line.fontSize - seed.fontSize) <= fontTolerance
          )
        })
        .sort(
          (left, right) =>
            left.y - right.y ||
            Math.abs(left.x - seed.x) - Math.abs(right.x - seed.x),
        )[0]
      if (!candidate) break
      previous = candidate
      for (const run of candidate.runs) {
        if (run.text.trim()) keys.add(furnitureRunKey(run))
      }
    }
  }
  return keys
}

function spread(values: number[]) {
  return values.length < 2 ? 0 : Math.max(...values) - Math.min(...values)
}

function distinctLines(values: ClassifiedLine[]): ClassifiedLine[] {
  return [...new Set(values)]
}

function alignedBandCount(
  members: Array<{ left: ClassifiedLine; right: ClassifiedLine }>,
) {
  const centers = members
    .map(
      ({ left, right }) =>
        (left.y + left.height / 2 + right.y + right.height / 2) / 2,
    )
    .sort((left, right) => left - right)
  const bands: number[] = []
  for (const center of centers) {
    if (bands.every((candidate) => Math.abs(candidate - center) > 0.012)) {
      bands.push(center)
    }
  }
  return bands.length
}

function maximumVerticalGap(lines: ClassifiedLine[]) {
  const ordered = distinctLines(lines).sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )
  if (ordered.length < 2) return Number.POSITIVE_INFINITY
  return Math.max(
    ...ordered.slice(1).map((line, index) => {
      const previous = ordered[index]
      return line.y - (previous.y + previous.height)
    }),
  )
}

function dominantIndent(lines: ClassifiedLine[]) {
  const clusters = lines.map((seed) => {
    const members = lines.filter((line) => Math.abs(line.x - seed.x) <= 0.04)
    return {
      members,
      x: median(members.map((line) => line.x)),
    }
  })
  return clusters.sort(
    (left, right) =>
      right.members.length - left.members.length || left.x - right.x,
  )[0]
}

function preclassifyMarginNotes(
  lines: ClassifiedLine[],
  pageBodyFontSize: number,
) {
  const body = lines.filter((line) => line.kind === 'body')
  const dominant = dominantIndent(body)
  if (!dominant || dominant.members.length < 2) return
  for (const line of body) {
    if (line.furnitureReview) continue
    if (dominant.members.includes(line)) continue
    const alignedWithBody = dominant.members.some((candidate) => {
      const lineCenter = line.y + line.height / 2
      const candidateCenter = candidate.y + candidate.height / 2
      return (
        Math.abs(lineCenter - candidateCenter) <=
        Math.max(0.012, line.height, candidate.height)
      )
    })
    if (
      alignedWithBody &&
      line.fontSize <= pageBodyFontSize * 0.85 &&
      line.width <= 0.25 &&
      line.text.length <= 120 &&
      Math.abs(line.x - dominant.x) >= 0.18
    ) {
      line.kind = 'side'
      line.confidence = 0.9
    }
  }
}

function sourceRaisedFrontMatterAffiliation(line: ClassifiedLine) {
  if (line.page !== 1 || line.y >= 0.32) return false
  const runs = line.runs.filter((run) => run.text.trim())
  const marker = runs[0]
  const institution = runs[1]
  if (
    !marker ||
    !institution ||
    !/^\d{1,3}(?:,\d{1,3})*$/u.test(marker.text.trim()) ||
    !/(?:university|institute|department|laborator(?:y|ies)|school|college|centre|center|hospital|academy|technolog(?:y|ies))/iu.test(
      runs
        .slice(1)
        .map((run) => run.text)
        .join(' '),
    )
  ) {
    return false
  }
  const markerCenter = marker.y + marker.height / 2
  const institutionCenter = institution.y + institution.height / 2
  const horizontalGap = institution.x - (marker.x + marker.width)
  return (
    marker.fontSize <= institution.fontSize * 0.92 + 0.01 &&
    markerCenter <=
      institutionCenter - Math.max(0.0005, institution.height * 0.18) &&
    horizontalGap >= -0.001 &&
    horizontalGap <= 0.012
  )
}

function endsCaptionSentence(text: string) {
  return /[.!?][”’'"\])}]*$/u.test(text.trim())
}

function endsIncompleteWrappedUrl(text: string) {
  return /(?:https?:\/\/|www\.)\S+\.$/iu.test(text.trim())
}

function captionLineFontSize(line: PdfTextLine) {
  const runs = line.runs
    .filter((run) => run.fontSize > 0 && run.text.trim().length > 0)
    .map((run) => ({
      fontSize: run.fontSize,
      weight: Math.max(1, run.text.replace(/\s/gu, '').length),
    }))
    .sort((left, right) => left.fontSize - right.fontSize)
  if (runs.length === 0) return line.fontSize

  const midpoint = runs.reduce((total, run) => total + run.weight, 0) / 2
  let cumulative = 0
  for (const run of runs) {
    cumulative += run.weight
    if (cumulative >= midpoint) return run.fontSize
  }
  return line.fontSize
}

export function captionFontFamily(fontName: string) {
  const normalized = fontName.trim().toLocaleLowerCase()
  if (/^[a-z][a-z0-9]*_d\d+_f\d+$/u.test(normalized)) {
    return normalized.replace(/[^a-z0-9]+/gu, '')
  }
  return normalized
    .replace(/^[a-z]{6}\+/iu, '')
    .replace(/mt$/iu, '')
    .replace(/ps(?=[-+_,.\s]|$)/iu, '')
    .replace(
      /(?:[-+_,.\s]*(?:bold|black|demi(?:bold)?|semibold|medium|regular|roman|book|italic|ital|oblique|obl))+$/iu,
      '',
    )
    .replace(
      /(?:[-+_,.\s]+(?:reguital|medi|regu|bdit|bdi|bi|bd|it|reg|rm|md|med|lt|sb))+$/iu,
      '',
    )
    .replace(/\d+$/u, '')
    .replace(/[^a-z0-9]+/gu, '')
}

function captionLineDominantFontFamily(line: PdfTextLine) {
  const counts = new Map<string, number>()
  for (const run of line.runs) {
    const textLength = run.text.replace(/\s/gu, '').length
    if (textLength === 0) continue
    const family = captionFontFamily(run.fontName)
    if (!family) continue
    counts.set(family, (counts.get(family) ?? 0) + textLength)
  }
  return (
    [...counts.entries()].sort(
      ([leftFamily, leftCount], [rightFamily, rightCount]) =>
        rightCount - leftCount || leftFamily.localeCompare(rightFamily),
    )[0]?.[0] ?? null
  )
}

function captionTypographyCompatible(
  seed: PdfTextLine,
  candidate: PdfTextLine,
) {
  return (
    captionLineDominantFontFamily(seed) ===
    captionLineDominantFontFamily(candidate)
  )
}

function captionLaneCompatible(
  seed: PdfTextLine,
  previous: PdfTextLine,
  candidate: PdfTextLine,
) {
  const boundary =
    seed.sourceCaptionLaneBoundary ?? previous.sourceCaptionLaneBoundary
  const side = seed.sourceCaptionLaneSide ?? previous.sourceCaptionLaneSide
  if (boundary === undefined || side === undefined) return true
  if (
    (candidate.sourceCaptionLaneBoundary !== undefined &&
      Math.abs(candidate.sourceCaptionLaneBoundary - boundary) > 0.002) ||
    (candidate.sourceCaptionLaneSide !== undefined &&
      candidate.sourceCaptionLaneSide !== side)
  ) {
    return false
  }
  const left = candidate.x
  const right = candidate.x + candidate.width
  const tolerance = 0.004
  if (candidate.sourceCaptionLaneSide === undefined) {
    if (side === 'left' && right > boundary - tolerance) return false
    if (side === 'right' && left < boundary + tolerance) return false
  }
  if (left < boundary - tolerance && right > boundary + tolerance) {
    return false
  }
  const center = left + candidate.width / 2
  return side === 'left'
    ? center <= boundary + tolerance
    : center >= boundary - tolerance
}

function completesQuotedCaptionExpression(
  previous: ClassifiedLine,
  candidate: ClassifiedLine,
) {
  const openQuotes = previous.text.match(/“/gu)?.length ?? 0
  const closeQuotes = previous.text.match(/”/gu)?.length ?? 0
  return (
    openQuotes > closeQuotes &&
    candidate.text.includes('”') &&
    endsCaptionSentence(candidate.text)
  )
}

function captionContinuationGeometry(
  seed: ClassifiedLine,
  previous: ClassifiedLine,
  candidate: ClassifiedLine,
  enforceCaptionLane = true,
) {
  if (candidate.captionLaneSplitAmbiguous) return false
  if (
    (enforceCaptionLane && !captionLaneCompatible(seed, previous, candidate)) ||
    !captionTypographyCompatible(seed, candidate)
  ) {
    return false
  }
  const candidateProseWordCount =
    candidate.text.match(/\p{L}{2,}/gu)?.length ?? 0
  const equationClassifiedCaptionProse =
    candidate.kind === 'equation' &&
    (candidateProseWordCount >= 4 ||
      (candidateProseWordCount >= 2 && endsCaptionSentence(candidate.text)) ||
      completesQuotedCaptionExpression(previous, candidate))
  const footerClassifiedSplitWordContinuation =
    candidate.kind === 'footer' &&
    /\p{L}-$|\p{L}‐$/u.test(previous.text.trim()) &&
    /^\p{L}/u.test(candidate.text.trim())
  if (
    candidate.page !== seed.page ||
    beginsVisualCaption(candidate.text) ||
    (candidate.kind !== 'body' &&
      candidate.kind !== 'caption' &&
      !equationClassifiedCaptionProse &&
      !footerClassifiedSplitWordContinuation)
  )
    return false
  if (candidate.y <= previous.y + previous.height * 0.35) return false

  const gap = candidate.y - (previous.y + previous.height)
  const maximumGap = Math.max(
    0.006,
    Math.max(previous.height, candidate.height) * 0.72,
  )
  if (gap < -0.004 || gap > maximumGap) return false

  const seedFontSize = captionLineFontSize(seed)
  const candidateFontSize = captionLineFontSize(candidate)
  const fontRatio =
    Math.max(seedFontSize, candidateFontSize) /
    Math.max(1, Math.min(seedFontSize, candidateFontSize))
  if (fontRatio > 1.12) return false

  const intersection = Math.max(
    0,
    Math.min(seed.x + seed.width, candidate.x + candidate.width) -
      Math.max(seed.x, candidate.x),
  )
  const overlapRatio =
    intersection / Math.max(0.001, Math.min(seed.width, candidate.width))
  const alignmentTolerance = Math.max(0.025, seed.height * 1.6)
  const aligned =
    Math.abs(candidate.x - seed.x) <= alignmentTolerance ||
    Math.abs(candidate.x + candidate.width - (seed.x + seed.width)) <=
      alignmentTolerance ||
    Math.abs(candidate.x + candidate.width / 2 - (seed.x + seed.width / 2)) <=
      alignmentTolerance
  return overlapRatio >= 0.72 && aligned
}

function sourceCaptionLaneSeedPairs(lines: ClassifiedLine[]) {
  const seeds = lines.filter(
    (line) =>
      line.kind === 'caption' &&
      line.sourceCaptionLaneBoundary !== undefined &&
      (line.sourceCaptionLaneSide === 'left' ||
        line.sourceCaptionLaneSide === 'right'),
  )
  const candidates = seeds.flatMap((left) => {
    if (left.sourceCaptionLaneSide !== 'left') return []
    const rightCandidates = seeds.filter(
      (right) =>
        right.sourceCaptionLaneSide === 'right' &&
        right.page === left.page &&
        right.sourceCaptionLaneBoundary === left.sourceCaptionLaneBoundary &&
        Math.abs(left.y + left.height / 2 - (right.y + right.height / 2)) <=
          Math.max(0.004, left.height * 0.65, right.height * 0.65),
    )
    return rightCandidates.length === 1
      ? [
          {
            left,
            right: rightCandidates[0],
            boundary: left.sourceCaptionLaneBoundary!,
          },
        ]
      : []
  })
  return candidates.filter(
    ({ left, right, boundary }) =>
      candidates.filter(
        (candidate) =>
          candidate.right.id === right.id && candidate.boundary === boundary,
      ).length === 1 &&
      left.x + left.width <= boundary &&
      right.x >= boundary,
  )
}

function splitSourceCaptionLaneContinuations(lines: ClassifiedLine[]) {
  const output = [...lines]
  const claimed = new Set<string>()
  for (const pair of sourceCaptionLaneSeedPairs(output)) {
    let leftPrevious = pair.left
    let rightPrevious = pair.right
    while (true) {
      const candidates = output.flatMap((line) => {
        if (
          claimed.has(line.id) ||
          line.page !== pair.left.page ||
          beginsVisualCaption(line.text) ||
          line.sourceCaptionLaneSide !== undefined ||
          line.runs.length < 2 ||
          line.x >= pair.boundary ||
          line.x + line.width <= pair.boundary
        ) {
          return []
        }
        const runs = [...line.runs].sort(
          (left, right) => left.x - right.x || left.y - right.y,
        )
        const boundaries = runs.flatMap((rightRun, index) => {
          if (index === 0) return []
          const leftRun = runs[index - 1]
          const leftEdge = leftRun.x + leftRun.width
          const gap = rightRun.x - leftEdge
          const center = (leftEdge + rightRun.x) / 2
          if (
            gap <
              Math.max(
                0.002,
                Math.min(leftRun.height, rightRun.height) * 0.2,
              ) ||
            Math.abs(center - pair.boundary) > 0.02
          ) {
            return []
          }
          const left = {
            ...classifiedLineFragment(line, runs.slice(0, index), 'left'),
            sourceCaptionLaneBoundary: pair.boundary,
            sourceCaptionLaneSide: 'left' as const,
          }
          const right = {
            ...classifiedLineFragment(line, runs.slice(index), 'right'),
            sourceCaptionLaneBoundary: pair.boundary,
            sourceCaptionLaneSide: 'right' as const,
          }
          return captionContinuationGeometry(
            pair.left,
            leftPrevious,
            left,
            false,
          ) &&
            captionContinuationGeometry(pair.right, rightPrevious, right, false)
            ? [{ line, left, right }]
            : []
        })
        if (boundaries.length !== 1) {
          if (
            captionContinuationGeometry(pair.left, leftPrevious, line, false) ||
            captionContinuationGeometry(pair.right, rightPrevious, line, false)
          ) {
            line.captionLaneSplitAmbiguous = true
          }
          return []
        }
        return boundaries
      })
      const orderedCandidates = candidates.sort(
        (left, right) =>
          Math.max(left.left.y, left.right.y) -
            Math.max(right.left.y, right.right.y) ||
          left.line.id.localeCompare(right.line.id),
      )
      const first = orderedCandidates[0]
      if (!first) break
      const firstCenter = first.line.y + first.line.height / 2
      const immediateCandidates = orderedCandidates.filter((candidate) => {
        const center = candidate.line.y + candidate.line.height / 2
        return (
          Math.abs(center - firstCenter) <=
          Math.max(
            0.004,
            first.line.height * 0.65,
            candidate.line.height * 0.65,
          )
        )
      })
      if (immediateCandidates.length !== 1) {
        for (const candidate of immediateCandidates) {
          candidate.line.captionLaneSplitAmbiguous = true
        }
        break
      }
      const [next] = immediateCandidates

      const index = output.indexOf(next.line)
      if (index < 0) break
      output.splice(index, 1, next.left, next.right)
      claimed.add(next.line.id)
      leftPrevious = next.left
      rightPrevious = next.right
    }
  }
  return output
}

function demoteInlineVisualReferenceContinuations(lines: ClassifiedLine[]) {
  const ordered = [...lines].sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )
  for (const candidate of ordered.filter(
    (line) => line.kind === 'caption' && beginsVisualCaption(line.text),
  )) {
    const previous = ordered
      .filter(
        (line) =>
          line.id !== candidate.id &&
          line.page === candidate.page &&
          line.kind === 'body' &&
          line.y < candidate.y,
      )
      .filter((line) => {
        const text = line.text.trim()
        const proseWordCount = text.match(/\p{L}{2,}/gu)?.length ?? 0
        const unfinishedBodyLine =
          proseWordCount >= 4 &&
          /\p{Ll}[\p{L}\p{M}'’]*$/u.test(text) &&
          !/[.!?;:]\s*$/u.test(text)
        if (!unfinishedBodyLine) return false

        const gap = candidate.y - (line.y + line.height)
        const maximumGap = Math.max(
          0.006,
          Math.max(line.height, candidate.height) * 0.45,
        )
        if (gap < -0.003 || gap > maximumGap) return false

        const previousFontSize = captionLineFontSize(line)
        const candidateFontSize = captionLineFontSize(candidate)
        const fontRatio =
          Math.max(previousFontSize, candidateFontSize) /
          Math.max(1, Math.min(previousFontSize, candidateFontSize))
        if (fontRatio > 1.06) return false

        const intersection = Math.max(
          0,
          Math.min(line.x + line.width, candidate.x + candidate.width) -
            Math.max(line.x, candidate.x),
        )
        const overlapRatio =
          intersection / Math.max(0.001, Math.min(line.width, candidate.width))
        const alignmentTolerance = Math.max(
          0.014,
          Math.max(line.height, candidate.height),
        )
        return (
          overlapRatio >= 0.72 &&
          Math.abs(line.x - candidate.x) <= alignmentTolerance
        )
      })
      .sort(
        (left, right) =>
          right.y + right.height - (left.y + left.height) ||
          Math.abs(left.x - candidate.x) - Math.abs(right.x - candidate.x),
      )[0]
    if (!previous) continue

    candidate.kind = 'body'
    candidate.confidence = Math.min(candidate.confidence, previous.confidence)
  }
}

/**
 * PDF text extraction marks only the label-bearing first line of a wrapped
 * caption. Promote its geometrically continuous wrap lines before column
 * classification so a page-spanning table caption does not become a separate
 * `spanning` prose region. The chain stops at whitespace, font, alignment, and
 * paragraph-boundary evidence rather than consuming the following body flow.
 */
function promoteCaptionContinuations(lines: ClassifiedLine[]) {
  const claimed = new Set<string>()
  const seeds = lines
    .filter((line) => line.kind === 'caption')
    .sort((left, right) => left.y - right.y || left.x - right.x)

  for (const seed of seeds) {
    let previous = seed
    const alignmentTolerance = Math.max(0.025, seed.height * 1.6)
    const seedFontSize = captionLineFontSize(seed)
    let widestLine = Math.max(
      seed.width,
      ...lines
        .filter((line) => {
          const lineFontSize = captionLineFontSize(line)
          const fontRatio =
            Math.max(seedFontSize, lineFontSize) /
            Math.max(1, Math.min(seedFontSize, lineFontSize))
          return (
            line.page === seed.page &&
            fontRatio <= 1.12 &&
            Math.abs(line.x - seed.x) <= alignmentTolerance
          )
        })
        .map((line) => line.width),
    )
    while (true) {
      const previousIsShortConclusion =
        endsCaptionSentence(previous.text) && previous.width < widestLine * 0.82
      if (previousIsShortConclusion) break

      const candidate = lines
        .filter(
          (line) =>
            !claimed.has(line.id) &&
            captionContinuationGeometry(seed, previous, line),
        )
        .sort(
          (left, right) =>
            left.y - right.y ||
            Math.abs(left.x - seed.x) - Math.abs(right.x - seed.x),
        )[0]
      if (!candidate) break

      const paragraphIndent = candidate.x - seed.x
      if (
        endsCaptionSentence(previous.text) &&
        paragraphIndent > Math.max(0.018, seed.height * 1.25)
      ) {
        break
      }

      const fragmentParts = inlineStackedFragmentParts(candidate)
      const fragmentSiblings = fragmentParts
        ? lines
            .filter(
              (line) =>
                inlineStackedFragmentParts(line)?.baseId ===
                fragmentParts.baseId,
            )
            .sort(sourceLineFlowOrder)
        : [candidate]
      const continuationLines = fragmentSiblings.every(
        (line) => !claimed.has(line.id),
      )
        ? fragmentSiblings
        : [candidate]
      for (const continuation of continuationLines) {
        const continuationFragment = inlineStackedFragmentParts(continuation)
        if (continuationFragment?.part === 'formula') {
          // Keep the exact source geometry in the caption's reading-order
          // neighborhood, but do not relabel a provably two-dimensional math
          // fragment as linear caption prose. The visual pass owns this line
          // as an unresolved equation crop obligation.
          continuation.kind = 'equation'
          delete continuation.captionContinuationSeedId
        } else {
          continuation.kind = 'caption'
          continuation.captionContinuationSeedId = seed.id
        }
        continuation.confidence = Math.min(
          seed.confidence,
          continuation.confidence,
        )
        claimed.add(continuation.id)
        widestLine = Math.max(widestLine, continuation.width)
      }
      previous = continuationLines.at(-1)!
    }
  }
}

function horizontalOverlapRatio(
  left: Pick<PdfTextLine, 'x' | 'width'>,
  right: Pick<PdfTextLine, 'x' | 'width'>,
) {
  const overlap = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
  return overlap / Math.max(0.001, Math.min(left.width, right.width))
}

/**
 * Side-by-side panels are emitted row-first by PDF.js: panel A line 1,
 * panel B line 1, panel A line 2, panel B line 2. Without the native-panel
 * and shared-caption proof below, sequential region joining assigns each
 * continuation to the opposite panel. Preserve the source lane before region
 * grouping so the visual pass can own complete `(a)` / `(b)` labels.
 */
function markAdjacentPanelLabelContinuations(
  lines: ClassifiedLine[],
  objects: PdfPageAnalysis['objects'],
) {
  const images = (objects ?? []).filter(
    (object) => object.kind === 'image' && object.role !== 'scan-source',
  )
  if (images.length < 2) return

  for (const caption of lines.filter(
    (line) => line.kind === 'caption' && beginsVisualCaption(line.text),
  )) {
    const eligibleImages = images.filter(
      (image) =>
        image.box.y + image.box.height <= caption.y + 0.004 &&
        caption.y - (image.box.y + image.box.height) <= 0.12,
    )
    if (eligibleImages.length < 2) continue
    const closestBottom = Math.max(
      ...eligibleImages.map((image) => image.box.y + image.box.height),
    )
    const bandReference = eligibleImages.reduce((closest, candidate) =>
      candidate.box.y + candidate.box.height >
      closest.box.y + closest.box.height
        ? candidate
        : closest,
    )
    const panels = eligibleImages
      .filter((image) => {
        const bottom = image.box.y + image.box.height
        const verticalOverlap = Math.max(
          0,
          Math.min(
            image.box.y + image.box.height,
            bandReference.box.y + bandReference.box.height,
          ) - Math.max(image.box.y, bandReference.box.y),
        )
        return (
          closestBottom - bottom <= 0.02 &&
          verticalOverlap >=
            Math.min(image.box.height, bandReference.box.height) * 0.7
        )
      })
      .sort((left, right) => left.box.x - right.box.x)
    if (panels.length < 2) continue
    const panelLeft = Math.min(...panels.map((panel) => panel.box.x))
    const panelRight = Math.max(
      ...panels.map((panel) => panel.box.x + panel.box.width),
    )
    if (
      panelRight - panelLeft < 0.5 ||
      caption.width < (panelRight - panelLeft) * 0.75
    ) {
      continue
    }

    const panelBottom = Math.max(
      ...panels.map((panel) => panel.box.y + panel.box.height),
    )
    const seeds = lines
      .filter(
        (line) =>
          line.kind === 'body' &&
          /^\s*\([a-z0-9ivxlcdm]+\)\s+\p{L}/iu.test(line.text) &&
          line.y >= panelBottom - 0.012 &&
          line.y + line.height <= caption.y + 0.004,
      )
      .sort((left, right) => left.x - right.x)
    if (seeds.length !== panels.length) continue
    const seedPanels = seeds.map((seed) => {
      const overlaps = panels.map((panel) =>
        horizontalOverlapRatio(seed, panel.box),
      )
      const best = Math.max(...overlaps)
      const bestIndex = overlaps.indexOf(best)
      const runnerUp = Math.max(
        ...overlaps.filter((_overlap, index) => index !== bestIndex),
        0,
      )
      return best >= 0.7 && best - runnerUp >= 0.2 ? bestIndex : -1
    })
    if (
      seedPanels.some((index) => index < 0) ||
      new Set(seedPanels).size !== panels.length
    ) {
      continue
    }

    const claimed = new Set(seeds.map((seed) => seed.id))
    for (const [seedIndex, seed] of seeds.entries()) {
      const panel = panels[seedPanels[seedIndex]]
      let previous = seed
      while (true) {
        const candidates = lines
          .filter((candidate) => {
            if (
              claimed.has(candidate.id) ||
              candidate.kind !== 'body' ||
              candidate.page !== seed.page ||
              candidate.y < previous.y + previous.height - 0.002 ||
              candidate.y + candidate.height > caption.y + 0.004 ||
              /^\s*\([a-z0-9ivxlcdm]+\)\s+\p{L}/iu.test(candidate.text)
            ) {
              return false
            }
            const gap = candidate.y - (previous.y + previous.height)
            const fontRatio =
              Math.max(seed.fontSize, candidate.fontSize) /
              Math.max(1, Math.min(seed.fontSize, candidate.fontSize))
            return (
              gap <= Math.max(0.014, seed.height * 1.25) &&
              fontRatio <= 1.18 &&
              horizontalOverlapRatio(candidate, panel.box) >= 0.7 &&
              panels.filter(
                (otherPanel) =>
                  horizontalOverlapRatio(candidate, otherPanel.box) >= 0.7,
              ).length === 1
            )
          })
          .sort(
            (left, right) =>
              left.y - right.y ||
              Math.abs(left.x - panel.box.x) - Math.abs(right.x - panel.box.x),
          )
        if (candidates.length === 0) break
        const candidate = candidates[0]
        candidate.panelLabelContinuationSeedId = seed.id
        candidate.confidence = Math.min(seed.confidence, candidate.confidence)
        claimed.add(candidate.id)
        previous = candidate
      }
    }
  }
}

function promoteNoteContinuations(lines: ClassifiedLine[]) {
  const claimed = new Set<string>()
  const seeds = lines
    .filter(
      (line) =>
        (line.kind === 'footnote' || line.kind === 'endnote') && line.y >= 0.65,
    )
    .sort((left, right) => left.y - right.y || left.x - right.x)

  for (const seed of seeds) {
    let previous = seed
    while (
      !endsCaptionSentence(previous.text) ||
      endsIncompleteWrappedUrl(previous.text)
    ) {
      const candidate = lines
        .filter((line) => {
          if (
            line.page !== seed.page ||
            !(
              line.kind === 'body' ||
              line.kind === 'footer' ||
              ((line.kind === 'footnote' || line.kind === 'endnote') &&
                line.noteLabel === null)
            ) ||
            claimed.has(line.id) ||
            line.y <= previous.y
          ) {
            return false
          }
          const verticalGap = line.y - (previous.y + previous.height)
          const fontTolerance = Math.max(0.6, seed.fontSize * 0.08)
          return (
            verticalGap <= Math.max(0.008, seed.height * 0.8) &&
            Math.abs(line.x - seed.x) <= 0.04 &&
            Math.abs(line.fontSize - seed.fontSize) <= fontTolerance
          )
        })
        .sort(
          (left, right) =>
            left.y - right.y ||
            Math.abs(left.x - seed.x) - Math.abs(right.x - seed.x),
        )[0]
      if (!candidate) break
      candidate.kind = seed.kind
      candidate.noteContinuationSeedId = seed.id
      candidate.confidence = Math.min(seed.confidence, candidate.confidence)
      claimed.add(candidate.id)
      previous = candidate
    }
  }
}

type TabularGridFragment = {
  left: number
  right: number
  text: string
}

type TabularGridBand = {
  center: number
  lines: ClassifiedLine[]
  fragments: TabularGridFragment[]
  column: Extract<PdfRegionColumn, 'left' | 'right' | 'span'>
}

function tabularGridFragments(lines: ClassifiedLine[]) {
  const fragments: TabularGridFragment[] = []
  const runs = lines
    .flatMap((line) => line.runs.filter((run) => run.text.trim()))
    .sort((left, right) => left.x - right.x)
  for (const run of runs) {
    const right = run.x + run.width
    const previous = fragments.at(-1)
    const joinsPrevious =
      previous && run.x <= previous.right + Math.max(0.006, run.height * 0.5)
    if (previous && joinsPrevious) {
      previous.right = Math.max(previous.right, right)
      previous.text = `${previous.text} ${run.text}`
      continue
    }
    fragments.push({
      left: run.x,
      right,
      text: run.text,
    })
  }
  return fragments
}

function hasParallelProseColumnFragments(
  fragments: readonly TabularGridFragment[],
) {
  const left = fragments.filter((fragment) => fragment.right <= 0.49)
  const right = fragments.filter((fragment) => fragment.left >= 0.51)
  if (left.length === 0 || right.length === 0) return false
  const leftCoverage = left.at(-1)!.right - left[0].left
  const rightCoverage = right.at(-1)!.right - right[0].left
  const gutter = right[0].left - left.at(-1)!.right
  const wordCount = (side: readonly TabularGridFragment[]) =>
    side.reduce(
      (total, fragment) =>
        total + (fragment.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0),
      0,
    )
  return (
    leftCoverage >= 0.28 &&
    rightCoverage >= 0.28 &&
    gutter >= 0.015 &&
    wordCount(left) >= 4 &&
    wordCount(right) >= 4
  )
}

function hasParallelProseColumnLines(lines: readonly ClassifiedLine[]) {
  const proseLine = (line: ClassifiedLine) =>
    line.width >= 0.18 && (line.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 3
  const left = lines.some(
    (line) => line.x < 0.49 && line.x + line.width <= 0.5 && proseLine(line),
  )
  const right = lines.some(
    (line) => line.x >= 0.5 && line.x + line.width > 0.51 && proseLine(line),
  )
  return left && right
}

function strictTabularNumericCell(text: string) {
  return /^(?:[<>≤≥~≈])?[+\-−]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:(?:[eE][+\-−]?\d+)|(?:[x×]10[+\-−]?\d+))?(?:%|[x×])?$/u.test(
    text.replace(/\s+/gu, ''),
  )
}

function denseTabularGridBand(band: Omit<TabularGridBand, 'fragments'>) {
  const fragments = tabularGridFragments(band.lines)
  if (fragments.length < 4) return null
  const coverage = fragments.at(-1)!.right - fragments[0].left
  const compactFragments = fragments.filter((fragment) => {
    const wordCount = fragment.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
    return fragment.right - fragment.left <= 0.18 || wordCount <= 3
  }).length
  const minimumCoverage = band.column === 'span' ? 0.45 : 0.2
  const coversColumnLane =
    band.column === 'span' ||
    (band.column === 'left'
      ? fragments.at(-1)!.right >= 0.42
      : fragments[0].left <= 0.58)
  const provesLaneNumericMatrixBody =
    band.column === 'span' ||
    (!strictTabularNumericCell(fragments[0].text) &&
      /\p{L}/u.test(fragments[0].text) &&
      fragments
        .slice(1)
        .every((fragment) => strictTabularNumericCell(fragment.text)))
  if (
    coverage < minimumCoverage ||
    compactFragments < fragments.length * 0.75 ||
    !coversColumnLane ||
    !provesLaneNumericMatrixBody
  ) {
    return null
  }
  return { ...band, fragments }
}

/**
 * Dense table rows can repeat many source-run anchors while presenting only
 * two or three grouped text lines. Those repeated cell gaps are not evidence
 * for page columns. Identify compact full-width grids, or numeric grids wholly
 * inside one page lane, with at least four recurring anchors in three adjacent
 * row bands; ordinary two-column prose therefore remains eligible to prove its
 * real gutter.
 */
function denseTabularGridBands(lines: ClassifiedLine[]) {
  const bands: Array<Omit<TabularGridBand, 'fragments' | 'column'>> = []
  for (const line of lines
    .filter((candidate) => candidate.kind === 'body' && candidate.text.trim())
    .sort((left, right) => left.y - right.y || left.x - right.x)) {
    const center = line.y + line.height / 2
    const band = bands.find(
      (candidate) =>
        Math.abs(candidate.center - center) <=
        Math.max(0.007, line.height * 0.7),
    )
    if (band) {
      band.lines.push(line)
      band.center = median(
        band.lines.map((candidate) => candidate.y + candidate.height / 2),
      )
    } else {
      bands.push({ center, lines: [line] })
    }
  }

  const denseBands = bands.flatMap<TabularGridBand>((band) => {
    const spanning = denseTabularGridBand({ ...band, column: 'span' })
    if (
      spanning &&
      !hasParallelProseColumnLines(spanning.lines) &&
      !hasParallelProseColumnFragments(spanning.fragments)
    ) {
      return [spanning]
    }
    // A table can occupy one page column while prose continues in the other.
    // Keep only whole PDF.js-backed lines on each side of the page center;
    // never split a source run or synthesize a character/cell box.
    return [
      {
        column: 'left' as const,
        lines: band.lines.filter((line) => line.x + line.width <= 0.49),
      },
      {
        column: 'right' as const,
        lines: band.lines.filter((line) => line.x >= 0.51),
      },
    ]
      .filter((candidate) => candidate.lines.length > 0)
      .flatMap((candidate) => {
        const dense = denseTabularGridBand({
          center: band.center,
          lines: candidate.lines,
          column: candidate.column,
        })
        return dense ? [dense] : []
      })
  })

  const recurringBands = denseBands.filter((band) => {
    const recurringFragments = band.fragments.filter((fragment) => {
      const matchingBands = denseBands.filter(
        (candidate) =>
          candidate !== band &&
          candidate.column === band.column &&
          candidate.fragments.some(
            (candidateFragment) =>
              Math.abs(candidateFragment.left - fragment.left) <= 0.025 ||
              Math.abs(candidateFragment.right - fragment.right) <= 0.025,
          ),
      )
      return matchingBands.length >= 2
    })
    return recurringFragments.length >= 4
  })

  const adjacentClusters: TabularGridBand[][] = []
  for (const band of recurringBands.sort(
    (left, right) =>
      left.column.localeCompare(right.column) || left.center - right.center,
  )) {
    const cluster = adjacentClusters.at(-1)
    if (
      cluster &&
      cluster[0].column === band.column &&
      band.center - cluster.at(-1)!.center <= 0.08
    ) {
      cluster.push(band)
    } else {
      adjacentClusters.push([band])
    }
  }

  const entries = adjacentClusters.flatMap((cluster, clusterIndex) =>
    cluster.length < 3
      ? []
      : cluster.flatMap((band, bandIndex) =>
          band.lines.map(
            (line) =>
              ({
                lineId: line.id,
                bandId: `tabular-grid-${cluster[0].column}-${clusterIndex + 1}-band-${bandIndex + 1}`,
                column: cluster[0].column,
              }) as const,
          ),
        ),
  )
  return {
    bands: new Map(entries.map((entry) => [entry.lineId, entry.bandId])),
    columns: new Map(
      entries.map((entry) => [entry.lineId, entry.column] as const),
    ),
  }
}

function detectColumns(lines: ClassifiedLine[]): ColumnLayout {
  const sideLines = lines.filter((line) => line.kind === 'side')
  const tabularGrid = denseTabularGridBands(lines)
  const tabularGridBands = tabularGrid.bands
  const tabularGridColumns = tabularGrid.columns
  const candidates = lines.filter(
    (line) =>
      line.kind === 'body' &&
      line.text.length > 1 &&
      line.width < 0.72 &&
      !tabularGridBands.has(line.id),
  )
  const gaps: Array<{
    split: number
    left: ClassifiedLine
    right: ClassifiedLine
  }> = []
  for (let index = 0; index < candidates.length; index += 1) {
    for (
      let nextIndex = index + 1;
      nextIndex < candidates.length;
      nextIndex += 1
    ) {
      const first = candidates[index]
      const second = candidates[nextIndex]
      const left = first.x <= second.x ? first : second
      const right = left === first ? second : first
      const centerDifference = Math.abs(
        left.y + left.height / 2 - (right.y + right.height / 2),
      )
      const gap = right.x - (left.x + left.width)
      if (
        centerDifference > Math.max(0.007, left.height, right.height) ||
        gap <= Math.max(0.01, Math.min(left.height, right.height) * 0.6)
      ) {
        continue
      }
      gaps.push({ split: left.x + left.width + gap / 2, left, right })
    }
  }
  if (gaps.length === 0) {
    const bodyIndent = spread(candidates.map((line) => line.x))
    if (sideLines.length > 0 && candidates.length >= 2 && bodyIndent <= 0.04) {
      const bodyMedian = median(candidates.map((line) => line.fontSize))
      const sideMedian = median(sideLines.map((line) => line.fontSize))
      return {
        split: null,
        accepted: false,
        ambiguous: false,
        tabularGridBands,
        tabularGridColumns,
        resolution: {
          policyVersion: READING_ORDER_RESOLUTION_POLICY_VERSION,
          ambiguityClass: 'single-column-with-margin-notes',
          status: 'resolved',
          confidence: 0.94,
          threshold: READING_ORDER_RESOLUTION_THRESHOLD,
          evidence: [
            {
              code: 'font-metrics',
              detail: `Margin median font ${rounded(sideMedian)} is subordinate to body median font ${rounded(bodyMedian)}.`,
            },
            {
              code: 'indentation-continuity',
              detail: `The retained body flow has normalized indentation spread ${rounded(bodyIndent)}.`,
            },
            {
              code: 'margin-note-exclusion',
              detail: `${sideLines.length} aligned narrow side region${sideLines.length === 1 ? '' : 's'} remain outside canonical reading order.`,
            },
          ],
        },
      }
    }
    return {
      split: null,
      accepted: false,
      ambiguous: false,
      tabularGridBands,
      tabularGridColumns,
      resolution: null,
    }
  }

  const clusters = gaps.map((seed) => {
    const members = gaps.filter(
      (candidate) => Math.abs(candidate.split - seed.split) <= 0.05,
    )
    return {
      members,
      split: median(members.map((member) => member.split)),
    }
  })
  const rankedClusters = clusters.sort(
    (left, right) =>
      right.members.length - left.members.length || left.split - right.split,
  )
  let strongest = rankedClusters[0]
  const crossingCandidateCount = (split: number) =>
    candidates.filter((line) => {
      const tolerance = Math.max(0.006, Math.min(0.018, line.height * 0.4))
      return (
        line.x < split - tolerance && line.x + line.width > split + tolerance
      )
    }).length
  const strongestCrossingCount = crossingCandidateCount(strongest.split)
  // A compact grid can repeat an internal cell gap more often than the real
  // page gutter. Prefer only another well-supported central gap, and only
  // when it partitions more source lines instead of cutting through them.
  const centralProseGutter = rankedClusters
    .filter(
      (cluster) =>
        cluster.split >= 0.4 &&
        cluster.split <= 0.6 &&
        alignedBandCount(cluster.members) >= 2 &&
        cluster.members.length >=
          Math.max(2, Math.ceil(strongest.members.length * 0.4)),
    )
    .map((cluster) => ({
      ...cluster,
      crossingCount: crossingCandidateCount(cluster.split),
    }))
    .sort(
      (left, right) =>
        left.crossingCount - right.crossingCount ||
        right.members.length - left.members.length ||
        Math.abs(left.split - 0.5) - Math.abs(right.split - 0.5),
    )[0]
  if (
    centralProseGutter &&
    (strongest.split < 0.4 ||
      strongest.split > 0.6 ||
      centralProseGutter.crossingCount < strongestCrossingCount)
  ) {
    strongest = centralProseGutter
  }
  const selectedCrossingCount = crossingCandidateCount(strongest.split)
  const tolerance = 0.008
  const leftLines = candidates.filter(
    (line) => line.x + line.width <= strongest.split + tolerance,
  )
  const rightLines = candidates.filter(
    (line) => line.x >= strongest.split - tolerance,
  )
  const leftRange = [
    Math.min(...leftLines.map((line) => line.y)),
    Math.max(...leftLines.map((line) => line.y + line.height)),
  ]
  const rightRange = [
    Math.min(...rightLines.map((line) => line.y)),
    Math.max(...rightLines.map((line) => line.y + line.height)),
  ]
  const overlapsVertically =
    leftLines.length > 0 &&
    rightLines.length > 0 &&
    Math.min(leftRange[1], rightRange[1]) >
      Math.max(leftRange[0], rightRange[0])
  const pairedLeft = distinctLines(
    strongest.members.map((member) => member.left),
  )
  const pairedRight = distinctLines(
    strongest.members.map((member) => member.right),
  )
  const alignedBands = alignedBandCount(strongest.members)
  if (
    overlapsVertically &&
    alignedBands < 2 &&
    pairedLeft.length >= 2 &&
    pairedRight.length >= 2
  ) {
    return {
      split: null,
      accepted: false,
      ambiguous: false,
      tabularGridBands,
      tabularGridColumns,
      resolution: {
        policyVersion: READING_ORDER_RESOLUTION_POLICY_VERSION,
        ambiguityClass: 'fragmented-inline-cluster',
        status: 'resolved',
        confidence: 0.92,
        threshold: READING_ORDER_RESOLUTION_THRESHOLD,
        evidence: [
          {
            code: 'block-adjacency',
            detail:
              'Separated fragments occupy one horizontal band and do not establish adjacent vertical column blocks.',
          },
        ],
      },
    }
  }

  const splitDeviation = Math.max(
    ...strongest.members.map((member) =>
      Math.abs(member.split - strongest.split),
    ),
  )
  const minimumGutter = Math.min(
    ...strongest.members.map(
      (member) => member.right.x - (member.left.x + member.left.width),
    ),
  )
  const gutterStable =
    alignedBands >= 2 &&
    strongest.split >= 0.25 &&
    strongest.split <= 0.75 &&
    splitDeviation <= 0.025 &&
    minimumGutter >= 0.01
  const leftIndentSpread = spread(pairedLeft.map((line) => line.x))
  const rightIndentSpread = spread(pairedRight.map((line) => line.x))
  const leftWidthSpread = spread(pairedLeft.map((line) => line.width))
  const rightWidthSpread = spread(pairedRight.map((line) => line.width))
  const indentationContinuous =
    leftIndentSpread <= 0.035 &&
    rightIndentSpread <= 0.035 &&
    leftWidthSpread <= 0.08 &&
    rightWidthSpread <= 0.08
  const leftFont = median(pairedLeft.map((line) => line.fontSize))
  const rightFont = median(pairedRight.map((line) => line.fontSize))
  const fontRatio =
    Math.max(leftFont, rightFont) / Math.max(1, Math.min(leftFont, rightFont))
  const fontCompatible = fontRatio <= 1.15
  const leftGap = maximumVerticalGap(pairedLeft)
  const rightGap = maximumVerticalGap(pairedRight)
  const blocksAdjacent =
    alignedBands >= 2 && leftGap <= 0.12 && rightGap <= 0.12

  const crossesSplit = (line: ClassifiedLine) =>
    line.x < strongest.split - 0.04 &&
    line.x + line.width > strongest.split + 0.04
  const captions = lines.filter(
    (line) => line.kind === 'caption' && crossesSplit(line),
  )
  const spanning = lines.filter(
    (line) => line.kind === 'body' && crossesSplit(line),
  )
  const footnotes = lines.filter(
    (line) => line.kind === 'footnote' || line.kind === 'endnote',
  )
  const ambiguityClass: PdfReadingOrderAmbiguityClass = lines.some((line) =>
    /^(?:references|bibliography)$/i.test(line.text.trim()),
  )
    ? 'dense-reference-section'
    : footnotes.length > 0
      ? 'footnote-band'
      : captions.length > 0
        ? 'two-column-with-spanning-float'
        : spanning.length > 0
          ? 'mixed-single-two-column'
          : 'sparse-column-gutter'
  const evidence: PdfReadingOrderEvidence[] = []
  let confidence = 0.45
  if (gutterStable) {
    confidence += 0.2
    evidence.push({
      code: 'column-gutter',
      detail: `${alignedBands} aligned bands repeat a normalized gutter at ${rounded(strongest.split)} with maximum deviation ${rounded(splitDeviation)}; ${selectedCrossingCount} candidate line${selectedCrossingCount === 1 ? '' : 's'} cross the selected split.`,
    })
  }
  if (fontCompatible) {
    confidence += 0.1
    evidence.push({
      code: 'font-metrics',
      detail: `Left and right median font sizes are ${rounded(leftFont)} and ${rounded(rightFont)} (ratio ${rounded(fontRatio)}).`,
    })
  }
  if (indentationContinuous) {
    confidence += 0.1
    evidence.push({
      code: 'indentation-continuity',
      detail: `Column indentation spreads are ${rounded(leftIndentSpread)} left and ${rounded(rightIndentSpread)} right; width spreads are ${rounded(leftWidthSpread)} and ${rounded(rightWidthSpread)}.`,
    })
  }
  if (blocksAdjacent) {
    confidence += 0.1
    evidence.push({
      code: 'block-adjacency',
      detail: `Maximum normalized within-column gaps are ${rounded(leftGap)} left and ${rounded(rightGap)} right.`,
    })
  }
  if (captions.length > 0) {
    confidence += 0.03
    evidence.push({
      code: 'caption-proximity',
      detail: `${captions.length} caption region${captions.length === 1 ? '' : 's'} cross the stable gutter as a page-spanning boundary.`,
    })
  }
  if (spanning.length > 0) {
    confidence += 0.02
    evidence.push({
      code: 'spanning-boundary',
      detail: `${spanning.length} body region${spanning.length === 1 ? '' : 's'} cross the stable gutter and delimit column bands.`,
    })
  }
  if (footnotes.length > 0) {
    confidence += 0.02
    evidence.push({
      code: 'footnote-band',
      detail: `${footnotes.length} smaller-font note region${footnotes.length === 1 ? '' : 's'} form a separated lower band after body flow.`,
    })
  }
  confidence = rounded(Math.min(confidence, 0.99))
  const coreEvidenceCount = [
    fontCompatible,
    indentationContinuous,
    blocksAdjacent,
  ].filter(Boolean).length
  const repeatedGeometry =
    overlapsVertically &&
    alignedBands >= 3 &&
    pairedLeft.length >= 3 &&
    pairedRight.length >= 3
  const resolvedSparseGeometry =
    overlapsVertically &&
    gutterStable &&
    coreEvidenceCount >= 2 &&
    confidence >= READING_ORDER_RESOLUTION_THRESHOLD
  const accepted = repeatedGeometry || resolvedSparseGeometry
  const ambiguous =
    !accepted &&
    overlapsVertically &&
    alignedBands >= 2 &&
    pairedLeft.length >= 2 &&
    pairedRight.length >= 2
  return {
    split: accepted || ambiguous ? rounded(strongest.split) : null,
    accepted,
    ambiguous,
    tabularGridBands,
    tabularGridColumns,
    resolution:
      resolvedSparseGeometry || ambiguous
        ? {
            policyVersion: READING_ORDER_RESOLUTION_POLICY_VERSION,
            ambiguityClass,
            status: resolvedSparseGeometry ? 'resolved' : 'ambiguous',
            confidence,
            threshold: READING_ORDER_RESOLUTION_THRESHOLD,
            evidence,
          }
        : null,
  }
}

function columnFor(
  line: PdfTextLine & { id?: string },
  layout: ColumnLayout,
): PdfRegionColumn {
  const tabularColumn = line.id
    ? layout.tabularGridColumns?.get(line.id)
    : undefined
  if (tabularColumn && tabularColumn !== 'span') return tabularColumn
  if (layout.split === null) return 'single'
  if (tabularColumn) return tabularColumn
  const tolerance = Math.max(0.006, Math.min(0.018, line.height * 0.4))
  if (line.x + line.width <= layout.split + tolerance) return 'left'
  if (line.x >= layout.split - tolerance) return 'right'
  const hangsIntoGutterFromRight =
    line.x >= layout.split - Math.max(0.02, tolerance * 2) &&
    line.width <= 0.48 &&
    line.x + line.width >= layout.split + Math.max(0.12, line.width * 0.35) &&
    line.x + line.width <= 0.96
  if (hangsIntoGutterFromRight) return 'right'
  return 'span'
}

function classifiedLineFragment(
  source: ClassifiedLine,
  runs: ClassifiedLine['runs'],
  suffix: 'left' | 'right',
): ClassifiedLine {
  const orderedRuns = [...runs].sort(
    (left, right) => left.x - right.x || left.y - right.y,
  )
  const left = Math.min(...orderedRuns.map((run) => run.x))
  const top = Math.min(...orderedRuns.map((run) => run.y))
  const right = Math.max(...orderedRuns.map((run) => run.x + run.width))
  const bottom = Math.max(...orderedRuns.map((run) => run.y + run.height))
  const sourceSequenceIndexes = orderedRuns.flatMap((run) =>
    run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
  )
  const sourceFragmentLineage =
    sourceSequenceIndexes.length === orderedRuns.length &&
    new Set(sourceSequenceIndexes).size === sourceSequenceIndexes.length
      ? {
          algorithm: 'source-run-fragment-v1' as const,
          sourceLineId: source.id,
          fragment: `cross-gutter-${suffix}` as const,
          sourceSequenceIndexes,
        }
      : undefined
  return {
    ...source,
    id: `${source.id}-${suffix}`,
    text: mergePdfRunText(orderedRuns),
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    fontSize: Math.max(...orderedRuns.map((run) => run.fontSize)),
    runs: orderedRuns,
    ...(sourceFragmentLineage ? { sourceFragmentLineage } : {}),
  }
}

export function splitRunBackedCrossGutterProse(
  lines: ClassifiedLine[],
  layout: ColumnLayout,
) {
  if (layout.split === null) return lines
  const split = layout.split
  return lines.flatMap((line) => {
    if (
      line.kind !== 'body' ||
      layout.tabularGridBands?.has(line.id) ||
      line.runs.length < 2 ||
      line.x >= split - 0.08 ||
      line.x + line.width <= split + 0.08
    ) {
      return [line]
    }
    const runs = [...line.runs].sort(
      (left, right) => left.x - right.x || left.y - right.y,
    )
    const boundaries = runs.flatMap((rightRun, index) => {
      if (index === 0) return []
      const leftRun = runs[index - 1]
      const leftEdge = leftRun.x + leftRun.width
      const gap = rightRun.x - leftEdge
      const center = (leftEdge + rightRun.x) / 2
      if (
        gap <
          Math.max(0.018, Math.min(leftRun.height, rightRun.height) * 0.8) ||
        Math.abs(center - split) > 0.035
      ) {
        return []
      }
      const leftRuns = runs.slice(0, index)
      const rightRuns = runs.slice(index)
      const leftWords =
        mergePdfRunText(leftRuns).match(/\p{L}{2,}/gu)?.length ?? 0
      const rightWords =
        mergePdfRunText(rightRuns).match(/\p{L}{2,}/gu)?.length ?? 0
      return leftWords >= 2 && rightWords >= 2
        ? [{ index, distance: Math.abs(center - split) }]
        : []
    })
    const boundary = boundaries.sort(
      (left, right) => left.distance - right.distance,
    )[0]
    if (!boundary) return [line]
    return [
      classifiedLineFragment(line, runs.slice(0, boundary.index), 'left'),
      classifiedLineFragment(line, runs.slice(boundary.index), 'right'),
    ]
  })
}

function lineBelongsToNativeVisual(
  line: PdfTextLine,
  objects: PdfPageAnalysis['objects'],
) {
  const centerX = line.x + line.width / 2
  const centerY = line.y + line.height / 2
  return (objects ?? [])
    .filter(
      (object) =>
        object.role !== 'scan-source' &&
        object.box.width * object.box.height <= 0.72,
    )
    .some((object) => {
      const padding = Math.max(0.012, Math.min(0.04, line.height * 2.5))
      return (
        centerX >= object.box.x - padding &&
        centerX <= object.box.x + object.box.width + padding &&
        centerY >= object.box.y - padding &&
        centerY <= object.box.y + object.box.height + padding
      )
    })
}

function lineBox(line: PdfTextLine): NormalizedSourceBox {
  return {
    page: line.page,
    x: rounded(line.x),
    y: rounded(line.y),
    width: rounded(line.width),
    height: rounded(line.height),
    rotation: line.runs[0]?.rotation ?? 0,
    method: line.runs.some((run) => run.method === 'ocr') ? 'ocr' : 'pdf-text',
  }
}

function unionBox(lines: PdfRegionLine[]): NormalizedSourceBox {
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

function unionRunBox(runs: PdfRegionLine['runs']): NormalizedSourceBox | null {
  if (runs.length === 0) return null
  const left = Math.min(...runs.map((run) => run.x))
  const top = Math.min(...runs.map((run) => run.y))
  const right = Math.max(...runs.map((run) => run.x + run.width))
  const bottom = Math.max(...runs.map((run) => run.y + run.height))
  return {
    page: runs[0].page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: runs[0].rotation,
    method: runs.some((run) => run.method === 'ocr') ? 'ocr' : 'pdf-text',
  }
}

function splitRunBackedSymbolicNoteDefinitions(region: PdfPageRegion) {
  if (
    (region.kind !== 'footnote' && region.kind !== 'endnote') ||
    region.lines.length !== 1
  ) {
    return [region]
  }
  const line = region.lines[0]
  const runs = line.runs.filter((run) => run.text.trim())
  if (runs.length < 4 || !/^[*†‡§]$/u.test(runs[0].text.trim())) {
    return [region]
  }

  const runRanges: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const run of runs) {
    const text = run.text.replace(/\s+/gu, ' ').trim()
    const start = region.text.indexOf(text, cursor)
    if (start < cursor) return [region]
    runRanges.push({ start, end: start + text.length })
    cursor = start + text.length
  }
  const markerIndexes = runs.flatMap((run, index) =>
    /^[*†‡§]$/u.test(run.text.trim()) ? [index] : [],
  )
  if (
    markerIndexes.length < 2 ||
    markerIndexes[0] !== 0 ||
    markerIndexes.some(
      (markerIndex, index) =>
        (markerIndexes[index + 1] ?? runs.length) - markerIndex < 2,
    )
  ) {
    return [region]
  }

  return markerIndexes.map((markerIndex, index) => {
    const nextMarkerIndex = markerIndexes[index + 1] ?? runs.length
    const fragmentRuns = runs
      .slice(markerIndex, nextMarkerIndex)
      .map((run) => ({ ...run }))
    const sourceStart = runRanges[markerIndex].start
    const sourceEnd =
      index + 1 < markerIndexes.length
        ? runRanges[nextMarkerIndex].start
        : region.text.length
    const text = region.text.slice(sourceStart, sourceEnd).trimEnd()
    const box = unionRunBox(fragmentRuns)
    if (!box) return region
    const suffix =
      index === 0 ? '' : `-note-${String(index + 1).padStart(3, '0')}`
    const fragmentLine: PdfRegionLine = {
      ...line,
      id: `${line.id}${suffix}`,
      text,
      box,
      runs: fragmentRuns,
    }
    return {
      ...region,
      id: `${region.id}${suffix}`,
      text,
      box,
      lines: [fragmentLine],
    }
  })
}

function splitNoteDefinitionOrder(left: PdfPageRegion, right: PdfPageRegion) {
  const parts = (id: string) => {
    const match = id.match(/^(.*)-note-(\d{3})$/u)
    return {
      base: match?.[1] ?? id,
      ordinal: match ? Number(match[2]) : 1,
    }
  }
  const leftParts = parts(left.id)
  const rightParts = parts(right.id)
  return leftParts.base === rightParts.base
    ? leftParts.ordinal - rightParts.ordinal
    : null
}

function standaloneSectionHeading(line: ClassifiedLine) {
  if (line.kind !== 'body' && line.kind !== 'spanning') return false
  const text = line.text.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 120) return false
  if (
    /^(?:abstract|acknowledg(?:e)?ments?|limitations?|ethics statement|references|bibliography|appendix)$/i.test(
      text,
    )
  ) {
    return true
  }
  const machineIdentifierTitle = /^(?:(?:https?:\/\/|www\.)|\S*[_@]\S*)/iu.test(
    text.replace(/^(?:\d{1,3}(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?\s+/u, ''),
  )
  const stronglyStyledStructuralHeading =
    !machineIdentifierTitle &&
    emphasizedFaceShare(line) >= 0.6 &&
    /^(?:(?:\d{1,3}(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?)\s+\p{Lu}.{0,100}$/u.test(
      text,
    )
  return (
    /^\d{1,3}(?:\.\d+){0,3}\s+\p{Lu}[^.,;:!?]{0,100}$/u.test(text) ||
    /^[A-Z](?:\.\d+)?\s+\p{Lu}[^,;:!?]{0,100}$/u.test(text) ||
    stronglyStyledStructuralHeading
  )
}

function dominantLineHeight(line: ClassifiedLine) {
  const largestFont = Math.max(...line.runs.map((run) => run.fontSize), 0)
  const baselineHeights = line.runs
    .filter((run) => run.fontSize >= largestFont * 0.9)
    .map((run) => run.height)
    .filter((height) => height > 0)
  return median(baselineHeights) || line.height
}

function dominantBaselineMetrics(line: PdfTextLine) {
  const visibleRuns = line.runs.filter((run) => run.text.trim())
  if (visibleRuns.length === 0) return null
  const maximumFontSize = Math.max(...visibleRuns.map((run) => run.fontSize))
  const dominantRuns = visibleRuns.filter(
    (run) => run.fontSize >= maximumFontSize * 0.9,
  )
  const characterWeight = (run: PdfSourceRun) =>
    Math.max(run.text.replace(/\s+/gu, '').length, 1)
  const totalWeight = dominantRuns.reduce(
    (total, run) => total + characterWeight(run),
    0,
  )
  const representative = [...dominantRuns].sort(
    (left, right) =>
      characterWeight(right) - characterWeight(left) ||
      right.fontSize - left.fontSize ||
      left.x - right.x,
  )[0]
  return {
    fontSize: maximumFontSize,
    fontName: representative.fontName,
    top: Math.min(...dominantRuns.map((run) => run.y)),
    bottom: Math.max(...dominantRuns.map((run) => run.y + run.height)),
    baseline:
      dominantRuns.reduce(
        (total, run) => total + (run.y + run.height) * characterWeight(run),
        0,
      ) / totalWeight,
    height: median(dominantRuns.map((run) => run.height)),
  }
}

function comparableSemanticFlowFontName(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(
      /(?:bold|semibold|demi|medium|black|italic|ital|oblique|regular)/gu,
      '',
    )
    .replace(/\d+/gu, '')
    .replace(/[^a-z]+/gu, '')
}

export function sourceProvenDominantBaselineSequentialWrap(
  previous: PdfTextLine,
  line: PdfTextLine,
) {
  const previousRuns = previous.runs.filter((run) => run.text.trim())
  const lineRuns = line.runs.filter((run) => run.text.trim())
  if (
    previous.page !== line.page ||
    previous.column !== line.column ||
    previousRuns.length < 2 ||
    lineRuns.length === 0 ||
    previousRuns.some((run) => run.sourceSequenceIndex === undefined) ||
    lineRuns.some((run) => run.sourceSequenceIndex === undefined)
  ) {
    return false
  }
  const maximumPreviousSequence = Math.max(
    ...previousRuns.map((run) => run.sourceSequenceIndex!),
  )
  const minimumLineSequence = Math.min(
    ...lineRuns.map((run) => run.sourceSequenceIndex!),
  )
  const previousBoundaryRuns = previousRuns.filter(
    (run) => run.sourceSequenceIndex === maximumPreviousSequence,
  )
  const lineBoundaryRuns = lineRuns.filter(
    (run) => run.sourceSequenceIndex === minimumLineSequence,
  )
  if (previousBoundaryRuns.length !== 1 || lineBoundaryRuns.length !== 1) {
    return false
  }
  const previousBoundaryRun = previousBoundaryRuns[0]
  const lineBoundaryRun = lineBoundaryRuns[0]
  const exactSourceAdjacency =
    minimumLineSequence === maximumPreviousSequence + 1 ||
    (lineBoundaryRun.sourceWhitespaceBefore === 'pdf-text-item' &&
      lineBoundaryRun.sourceWhitespacePredecessorIndex ===
        maximumPreviousSequence)
  const previousMetrics = dominantBaselineMetrics(previous)
  const lineMetrics = dominantBaselineMetrics(line)
  if (
    !exactSourceAdjacency ||
    !previousMetrics ||
    !lineMetrics ||
    previousBoundaryRun.page !== lineBoundaryRun.page ||
    previousBoundaryRun.rotation !== lineBoundaryRun.rotation ||
    previousBoundaryRun.method !== lineBoundaryRun.method
  ) {
    return false
  }
  const fullEnvelopeGap = line.y - (previous.y + previous.height)
  const dominantGap = lineMetrics.top - previousMetrics.bottom
  const hasStackedEnvelope =
    previousRuns.some(
      (run) =>
        run.fontSize < previousMetrics.fontSize * 0.9 &&
        (run.y < previousMetrics.top ||
          run.y + run.height > previousMetrics.bottom),
    ) ||
    lineRuns.some(
      (run) =>
        run.fontSize < lineMetrics.fontSize * 0.9 &&
        (run.y < lineMetrics.top || run.y + run.height > lineMetrics.bottom),
    )
  const fontRatio =
    Math.max(previousMetrics.fontSize, lineMetrics.fontSize) /
    Math.max(1, Math.min(previousMetrics.fontSize, lineMetrics.fontSize))
  const previousFont = comparableSemanticFlowFontName(previousMetrics.fontName)
  const lineFont = comparableSemanticFlowFontName(lineMetrics.fontName)
  const fontCompatible =
    previousFont === lineFont ||
    previousFont.includes(lineFont) ||
    lineFont.includes(previousFont)
  return (
    hasStackedEnvelope &&
    fullEnvelopeGap < -0.004 &&
    dominantGap >= -0.004 &&
    dominantGap <=
      Math.max(
        0.014,
        Math.max(previousMetrics.height, lineMetrics.height) * 1.25,
      ) &&
    fontRatio <= 1.18 &&
    fontCompatible &&
    Math.abs(line.x - previous.x) <=
      Math.max(0.06, Math.max(previousMetrics.height, lineMetrics.height) * 4)
  )
}

function sourceProvenSpanningInlineMathContinuation(
  previous: ClassifiedLine,
  line: ClassifiedLine,
  sourceSequenceCounts: ReadonlyMap<number, number>,
) {
  if (
    previous.page !== line.page ||
    previous.kind !== 'spanning' ||
    previous.column !== 'span' ||
    line.kind !== 'body' ||
    (line.column !== 'left' && line.column !== 'right') ||
    previous.y >= line.y ||
    !proseDominantInlineMathLine(previous) ||
    /[.!?](?:["'’”\])}]*)$/u.test(previous.text.trim()) ||
    !/^\p{Ll}/u.test(line.text.trim())
  ) {
    return false
  }
  const continuationWords = line.text.match(/[\p{L}\p{N}]+/gu) ?? []
  if (
    continuationWords.length === 0 ||
    continuationWords.length > 8 ||
    line.text.trim().length > 72 ||
    line.width > Math.min(0.3, previous.width * 0.45)
  ) {
    return false
  }

  const previousRuns = previous.runs.filter((run) => run.text.trim())
  const lineRuns = line.runs.filter((run) => run.text.trim())
  const inlineMathEvidence = previousRuns.some(
    (run) =>
      /(?:cmmi|cmsy|cmex|msbm|math|symbol)/iu.test(run.fontName) ||
      /[\p{Script=Greek}∆_=+*/<>^−×÷≤≥≈≠∼⊙∂∞∏∈∉→←∫∑√]/u.test(run.text),
  )
  const previousSequenceIndexes = previousRuns.flatMap((run) =>
    run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
  )
  const lineSequenceIndexes = lineRuns.flatMap((run) =>
    run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
  )
  if (
    !inlineMathEvidence ||
    previousRuns.length === 0 ||
    lineRuns.length === 0 ||
    previousSequenceIndexes.length !== previousRuns.length ||
    lineSequenceIndexes.length !== lineRuns.length ||
    new Set(previousSequenceIndexes).size !== previousSequenceIndexes.length ||
    new Set(lineSequenceIndexes).size !== lineSequenceIndexes.length
  ) {
    return false
  }
  const previousBoundary = Math.max(...previousSequenceIndexes)
  const lineBoundary = Math.min(...lineSequenceIndexes)
  if (
    lineBoundary !== previousBoundary + 1 ||
    sourceSequenceCounts.get(previousBoundary) !== 1 ||
    sourceSequenceCounts.get(lineBoundary) !== 1
  ) {
    return false
  }

  const previousSource = previousRuns[0]
  const lineSource = lineRuns[0]
  if (
    previousRuns.some(
      (run) =>
        run.page !== previous.page ||
        run.rotation !== previousSource.rotation ||
        run.method !== previousSource.method,
    ) ||
    lineRuns.some(
      (run) =>
        run.page !== line.page ||
        run.rotation !== lineSource.rotation ||
        run.method !== lineSource.method,
    ) ||
    previousSource.rotation !== lineSource.rotation ||
    previousSource.method !== lineSource.method
  ) {
    return false
  }

  const previousMetrics = dominantBaselineMetrics(previous)
  const lineMetrics = dominantBaselineMetrics(line)
  if (!previousMetrics || !lineMetrics) return false
  const fontRatio =
    Math.max(previousMetrics.fontSize, lineMetrics.fontSize) /
    Math.max(1, Math.min(previousMetrics.fontSize, lineMetrics.fontSize))
  const previousFont = comparableSemanticFlowFontName(previousMetrics.fontName)
  const lineFont = comparableSemanticFlowFontName(lineMetrics.fontName)
  const fontCompatible =
    previousFont.length > 0 &&
    lineFont.length > 0 &&
    (previousFont === lineFont ||
      previousFont.includes(lineFont) ||
      lineFont.includes(previousFont))
  const dominantHeight = Math.max(previousMetrics.height, lineMetrics.height)
  const dominantGap = lineMetrics.top - previousMetrics.bottom
  const baselineStep = lineMetrics.baseline - previousMetrics.baseline
  return (
    fontRatio <= 1.08 &&
    fontCompatible &&
    Math.abs(line.x - previous.x) <=
      Math.max(
        0.006,
        Math.min(previousMetrics.height, lineMetrics.height) * 0.5,
      ) &&
    dominantGap >= -0.002 &&
    dominantGap <= Math.max(0.008, dominantHeight * 0.75) &&
    baselineStep >= dominantHeight * 0.75 &&
    baselineStep <= Math.max(0.024, dominantHeight * 1.75)
  )
}

function promoteSourceProvenSpanningInlineMathContinuations(
  lines: ClassifiedLine[],
) {
  const sourceSequenceCounts = new Map<number, number>()
  for (const run of lines.flatMap((line) => line.runs)) {
    if (!run.text.trim() || run.sourceSequenceIndex === undefined) continue
    sourceSequenceCounts.set(
      run.sourceSequenceIndex,
      (sourceSequenceCounts.get(run.sourceSequenceIndex) ?? 0) + 1,
    )
  }
  const proposals = lines.flatMap((line) => {
    const predecessors = lines.filter((previous) =>
      sourceProvenSpanningInlineMathContinuation(
        previous,
        line,
        sourceSequenceCounts,
      ),
    )
    return predecessors.length === 1
      ? [{ previous: predecessors[0], line }]
      : []
  })
  const predecessorClaims = new Map<ClassifiedLine, number>()
  const continuationClaims = new Map<ClassifiedLine, number>()
  for (const proposal of proposals) {
    predecessorClaims.set(
      proposal.previous,
      (predecessorClaims.get(proposal.previous) ?? 0) + 1,
    )
    continuationClaims.set(
      proposal.line,
      (continuationClaims.get(proposal.line) ?? 0) + 1,
    )
  }
  for (const proposal of proposals) {
    if (
      predecessorClaims.get(proposal.previous) !== 1 ||
      continuationClaims.get(proposal.line) !== 1
    ) {
      continue
    }
    proposal.line.kind = 'spanning'
    proposal.line.column = 'span'
  }
}

function hasEmphasizedFace(line: ClassifiedLine) {
  return line.runs.some(
    (run) =>
      run.bold === true ||
      /(?:bold|semibold|demi|medi(?:um)?|black)/i.test(run.fontName) ||
      /(?:^|[+,._\s-])cm(?:bx|b)(?:ti|sl)?\d*(?=$|[+,._\s-])/iu.test(
        run.fontName,
      ) ||
      /(?:^|[+,._\s-])lin(?:biolinum|libertine)t?b(?:i)?(?=$|[+,._\s-])/iu.test(
        run.fontName,
      ),
  )
}

function emphasizedFaceShare(line: ClassifiedLine) {
  const visibleRuns = line.runs.filter((run) => run.text.trim())
  const visibleCharacters = visibleRuns.reduce(
    (total, run) => total + run.text.replace(/\s/gu, '').length,
    0,
  )
  const emphasizedCharacters = visibleRuns.reduce(
    (total, run) =>
      total +
      (run.bold === true ||
      /(?:bold|semibold|demi|medi(?:um)?|black)/i.test(run.fontName) ||
      /(?:^|[+,._\s-])cm(?:bx|b)(?:ti|sl)?\d*(?=$|[+,._\s-])/iu.test(
        run.fontName,
      ) ||
      /(?:^|[+,._\s-])lin(?:biolinum|libertine)t?b(?:i)?(?=$|[+,._\s-])/iu.test(
        run.fontName,
      )
        ? run.text.replace(/\s/gu, '').length
        : 0),
    0,
  )
  return visibleCharacters > 0 ? emphasizedCharacters / visibleCharacters : 0
}

function markWrappedHeadingContinuations(lines: ClassifiedLine[]) {
  const claimed = new Set<string>()
  const seeds = lines
    .filter(
      (line) =>
        line.kind === 'body' &&
        standaloneSectionHeading(line) &&
        hasEmphasizedFace(line) &&
        /^(?:\d{1,3}(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?\s+\p{Lu}/u.test(
          line.text.trim(),
        ),
    )
    .sort((left, right) => left.y - right.y || left.x - right.x)
  for (const seed of seeds) {
    const sameBaselineCrossGutterCandidates = lines.filter((candidate) => {
      if (
        candidate === seed ||
        claimed.has(candidate.id) ||
        candidate.page !== seed.page ||
        seed.column !== 'left' ||
        candidate.column !== 'right' ||
        candidate.kind !== 'body' ||
        !hasEmphasizedFace(candidate) ||
        !/[:–—-]$/u.test(seed.text.trim())
      ) {
        return false
      }
      const fontRatio =
        Math.max(seed.fontSize, candidate.fontSize) /
        Math.max(1, Math.min(seed.fontSize, candidate.fontSize))
      const horizontalGap = candidate.x - (seed.x + seed.width)
      const text = candidate.text.replace(/\s+/gu, ' ').trim()
      return (
        Math.abs(candidate.y - seed.y) <=
          Math.max(0.004, Math.max(seed.height, candidate.height) * 0.4) &&
        candidate.x > seed.x + Math.min(0.12, seed.width * 0.5) &&
        horizontalGap >= -0.03 &&
        horizontalGap <= 0.18 &&
        fontRatio <= 1.05 &&
        text.length <= 72 &&
        /^\p{Lu}[\p{L}\p{N}'’&/(),:–—\s-]*$/u.test(text) &&
        !/(?:https?:\/\/|www\.|\S*[_@]\S*)/iu.test(text)
      )
    })
    if (sameBaselineCrossGutterCandidates.length === 1) {
      const candidate = sameBaselineCrossGutterCandidates[0]
      candidate.headingContinuationSeedId = seed.id
      claimed.add(candidate.id)
    }
    const candidates = lines.filter((candidate) => {
      if (
        candidate === seed ||
        claimed.has(candidate.id) ||
        candidate.page !== seed.page ||
        candidate.column !== seed.column ||
        candidate.kind !== 'body' ||
        !hasEmphasizedFace(candidate)
      ) {
        return false
      }
      const gap = candidate.y - (seed.y + seed.height)
      const fontRatio =
        Math.max(seed.fontSize, candidate.fontSize) /
        Math.max(1, Math.min(seed.fontSize, candidate.fontSize))
      const text = candidate.text.replace(/\s+/gu, ' ').trim()
      const continuesDiscretionaryHyphen =
        /\p{L}-$/u.test(seed.text.trim()) && /^\p{Ll}/u.test(text)
      const beginsOrdinaryHeadingWrap = /^\p{Lu}/u.test(text)
      const continuesFullyEmphasizedLowercaseWrap =
        /^\p{Ll}/u.test(text) &&
        emphasizedFaceShare(candidate) >= 0.9 &&
        (text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) <= 8
      return (
        gap >= -0.002 &&
        gap <= Math.max(0.007, seed.height * 0.55) &&
        candidate.x - seed.x >= 0.015 &&
        candidate.x - seed.x <= 0.08 &&
        fontRatio <= 1.05 &&
        text.length <= 72 &&
        (continuesDiscretionaryHyphen ||
          beginsOrdinaryHeadingWrap ||
          continuesFullyEmphasizedLowercaseWrap) &&
        /^[\p{L}\p{N}][\p{L}\p{N}'’&/(),:–—\s-]*$/u.test(text) &&
        !/[.!?][”’'"\])}]*$/u.test(text) &&
        !/(?:https?:\/\/|www\.|\S*[_@]\S*)/iu.test(text)
      )
    })
    if (candidates.length !== 1) continue
    candidates[0].headingContinuationSeedId = seed.id
    claimed.add(candidates[0].id)
  }
}

function repairCrossGutterHeadingPrefixes(
  lines: ClassifiedLine[],
  layout: ColumnLayout,
) {
  const split = layout.split
  if (split === null) return lines
  const consumed = new Set<ClassifiedLine>()
  for (const prefix of lines) {
    const prefixText = prefix.text.trim()
    if (
      prefix.kind !== 'body' ||
      prefix.column !== 'left' ||
      !/^\d{1,3}$/u.test(prefixText) ||
      !hasEmphasizedFace(prefix)
    ) {
      continue
    }
    const prefixRight = prefix.x + prefix.width
    if (Math.abs(prefixRight - split) > 0.04) continue
    const candidates = lines
      .filter((candidate) => {
        const text = candidate.text.replace(/\s+/g, ' ').trim()
        const baselineTolerance = Math.max(
          0.003,
          Math.min(prefix.height, candidate.height) * 0.25,
        )
        const gap = candidate.x - prefixRight
        const fontRatio =
          Math.max(prefix.fontSize, candidate.fontSize) /
          Math.max(1, Math.min(prefix.fontSize, candidate.fontSize))
        return (
          candidate !== prefix &&
          candidate.page === prefix.page &&
          candidate.kind === 'body' &&
          candidate.column === 'right' &&
          hasEmphasizedFace(candidate) &&
          Math.abs(candidate.y - prefix.y) <= baselineTolerance &&
          gap >= 0 &&
          gap <= 0.06 &&
          candidate.x - split <= 0.08 &&
          fontRatio <= 1.08 &&
          text.length <= 80 &&
          /^\p{Lu}[\p{L}\p{N}'’&/–—-]*(?:\s+\p{Lu}[\p{L}\p{N}'’&/–—-]*){1,10}$/u.test(
            text,
          )
        )
      })
      .sort(
        (left, right) =>
          left.x - prefixRight - (right.x - prefixRight) || left.x - right.x,
      )
    if (candidates.length !== 1) continue
    const heading = candidates[0]
    const right = Math.max(prefix.x + prefix.width, heading.x + heading.width)
    const bottom = Math.max(
      prefix.y + prefix.height,
      heading.y + heading.height,
    )
    heading.text = `${prefixText} ${heading.text.trim()}`
    heading.x = prefix.x
    heading.y = Math.min(prefix.y, heading.y)
    heading.width = right - heading.x
    heading.height = bottom - heading.y
    heading.fontSize = Math.max(prefix.fontSize, heading.fontSize)
    heading.confidence = Math.min(prefix.confidence, heading.confidence)
    heading.runs = [...prefix.runs, ...heading.runs].sort(
      (left, right) => left.x - right.x,
    )
    consumed.add(prefix)
  }
  return lines.filter((line) => !consumed.has(line))
}

function sourceProvenLexicalHyphenContinuation(
  previous: ClassifiedLine,
  line: ClassifiedLine,
  hardHyphenLexicon: ReadonlySet<string>,
) {
  if (
    previous.page !== line.page ||
    previous.kind !== line.kind ||
    previous.column !== line.column
  ) {
    return false
  }
  const left = previous.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const right = line.text.trimStart().match(/^([\p{L}\p{N}]+)/u)?.[1]
  if (!left || !right) return false
  const candidate = `${left}-${right}`
    .normalize('NFKC')
    .replace(/[‐‑]/gu, '-')
    .toLocaleLowerCase()
  if (!hardHyphenLexicon.has(candidate)) return false

  const leftEdgeTolerance = Math.max(
    0.012,
    Math.max(previous.height, line.height) * 0.75,
  )
  if (Math.abs(previous.x - line.x) > leftEdgeTolerance) return false
  const previousRight = previous.x + previous.width
  const lineRight = line.x + line.width
  const rightEdgeTolerance = Math.max(
    0.025,
    Math.min(previous.width, line.width) * 0.08,
  )
  return previousRight >= lineRight - rightEdgeTolerance
}

function sourceProvenDetachedDisplayEquationAtomHost(
  previous: ClassifiedLine,
  line: ClassifiedLine,
  lines: readonly ClassifiedLine[],
): ClassifiedLine | null {
  if (
    previous.page !== line.page ||
    previous.kind !== line.kind ||
    previous.column !== line.column ||
    line.kind !== 'body'
  ) {
    return null
  }
  const visibleRuns = line.runs.filter((run) => run.text.trim())
  if (visibleRuns.length !== 1) return null
  const atom = visibleRuns[0]
  const atomText = atom.text.replace(/\s+/gu, '')
  if (
    atom.sourceSequenceIndex === undefined ||
    !/^[\p{L}\p{N}]{1,3}$/u.test(atomText) ||
    (!emphasizedSourceRun(atom) &&
      !/(?:math|cmmi|cmsy|msbm|symbol)/iu.test(atom.fontName))
  ) {
    return null
  }

  const atomCenterX = line.x + line.width / 2
  const atomCenterY = line.y + line.height / 2
  const nearbyEquationLines = lines.filter((candidate) => {
    if (
      candidate === line ||
      candidate.page !== line.page ||
      candidate.column !== line.column ||
      candidate.kind !== 'equation'
    ) {
      return false
    }
    const centerY = candidate.y + candidate.height / 2
    const horizontalGap = Math.max(
      candidate.x - (line.x + line.width),
      line.x - (candidate.x + candidate.width),
      0,
    )
    return (
      Math.abs(centerY - atomCenterY) <= Math.max(0.04, line.height * 3) &&
      horizontalGap <= Math.max(0.08, line.height * 6)
    )
  })
  const nearbyEquationRuns = nearbyEquationLines.flatMap((candidate) =>
    candidate.runs.filter(
      (run) =>
        run.text.trim() &&
        run.sourceSequenceIndex !== undefined &&
        run.page === atom.page &&
        run.rotation === atom.rotation &&
        run.method === atom.method,
    ),
  )
  const precedingEquationIndexes = nearbyEquationRuns
    .map((run) => run.sourceSequenceIndex!)
    .filter(
      (sourceSequenceIndex) => sourceSequenceIndex < atom.sourceSequenceIndex!,
    )
  const followingEquationIndexes = nearbyEquationRuns
    .map((run) => run.sourceSequenceIndex!)
    .filter(
      (sourceSequenceIndex) => sourceSequenceIndex > atom.sourceSequenceIndex!,
    )
  if (
    precedingEquationIndexes.length === 0 ||
    followingEquationIndexes.length === 0 ||
    atom.sourceSequenceIndex - Math.max(...precedingEquationIndexes) > 4 ||
    Math.min(...followingEquationIndexes) - atom.sourceSequenceIndex > 4
  ) {
    return null
  }

  const stackedHosts = nearbyEquationLines
    .flatMap((candidate) => {
      const baselineBands: PdfSourceRun[][] = []
      for (const run of candidate.runs
        .filter((candidateRun) => candidateRun.text.trim())
        .sort(
          (left, right) =>
            left.y + left.height / 2 - (right.y + right.height / 2) ||
            left.x - right.x,
        )) {
        const centerY = run.y + run.height / 2
        const band = baselineBands.find((candidateBand) => {
          const bandCenterY = median(
            candidateBand.map(
              (candidateRun) => candidateRun.y + candidateRun.height / 2,
            ),
          )
          const bandHeight = Math.max(
            ...candidateBand.map((candidateRun) => candidateRun.height),
          )
          return (
            Math.abs(centerY - bandCenterY) <=
            Math.max(0.0025, Math.min(run.height, bandHeight) * 0.45)
          )
        })
        if (band) band.push(run)
        else baselineBands.push([run])
      }
      return baselineBands.map((runs) => {
        const x = Math.min(...runs.map((run) => run.x))
        const y = Math.min(...runs.map((run) => run.y))
        const right = Math.max(...runs.map((run) => run.x + run.width))
        const bottom = Math.max(...runs.map((run) => run.y + run.height))
        return {
          line: candidate,
          runs,
          x,
          y,
          width: right - x,
          height: bottom - y,
        }
      })
    })
    .filter((candidate) => {
      if (
        candidate.runs.length === 0 ||
        !candidate.runs.some(
          (run) =>
            run.sourceSequenceIndex !== undefined &&
            Math.abs(run.sourceSequenceIndex - atom.sourceSequenceIndex!) <=
              4 &&
            run.page === atom.page &&
            run.rotation === atom.rotation &&
            run.method === atom.method,
        )
      ) {
        return false
      }
      const overlap = Math.max(
        0,
        Math.min(line.x + line.width, candidate.x + candidate.width) -
          Math.max(line.x, candidate.x),
      )
      const minimumWidth = Math.min(line.width, candidate.width)
      const candidateCenterX = candidate.x + candidate.width / 2
      const candidateCenterY = candidate.y + candidate.height / 2
      const minimumHeight = Math.min(line.height, candidate.height)
      const verticalGap = Math.max(
        line.y - (candidate.y + candidate.height),
        candidate.y - (line.y + line.height),
        0,
      )
      return (
        minimumWidth > 0 &&
        overlap >= minimumWidth * 0.8 &&
        Math.abs(atomCenterX - candidateCenterX) <=
          Math.max(0.006, minimumWidth * 0.2) &&
        Math.abs(atomCenterY - candidateCenterY) >=
          Math.max(0.004, minimumHeight * 0.75) &&
        verticalGap <= Math.max(0.018, minimumHeight * 1.4)
      )
    })
  return stackedHosts.length === 1 ? stackedHosts[0].line : null
}

function visibleSourceSequenceIndexes(line: PdfTextLine) {
  const visibleRuns = line.runs.filter((run) => run.text.trim())
  const sourceSequenceIndexes = visibleRuns.flatMap((run) =>
    run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
  )
  return sourceSequenceIndexes.length === visibleRuns.length
    ? sourceSequenceIndexes
    : null
}

function sourceProvenMultiComponentDisplayCluster(
  anchor: ClassifiedLine,
  lines: readonly ClassifiedLine[],
): ClassifiedLine[] | null {
  if (
    anchor.kind !== 'equation' ||
    !/(?:=|≤|≥|≈|≠)/u.test(anchor.text) ||
    proseDominantInlineMathLine(anchor)
  ) {
    return null
  }
  const anchorRuns = anchor.runs.filter((run) => run.text.trim())
  const anchorSequenceIndexes = visibleSourceSequenceIndexes(anchor)
  if (
    anchorRuns.length === 0 ||
    !anchorSequenceIndexes ||
    new Set(anchorSequenceIndexes).size !== anchorSequenceIndexes.length
  ) {
    return null
  }
  const anchorSource = anchorRuns[0]
  const anchorStart = Math.min(...anchorSequenceIndexes)
  const anchorEnd = Math.max(...anchorSequenceIndexes)
  const anchorCenterY = anchor.y + anchor.height / 2
  const equationNumberCandidates = lines.filter((candidate) => {
    if (
      candidate === anchor ||
      candidate.page !== anchor.page ||
      !/^\(\s*\d+(?:\.\d+)*\s*\)$/u.test(candidate.text.trim()) ||
      candidate.x < anchor.x + anchor.width ||
      Math.abs(candidate.y + candidate.height / 2 - anchorCenterY) >
        Math.max(0.05, anchor.height * 4)
    ) {
      return false
    }
    const runs = candidate.runs.filter((run) => run.text.trim())
    const sequenceIndexes = visibleSourceSequenceIndexes(candidate)
    return (
      runs.length > 0 &&
      sequenceIndexes !== null &&
      Math.min(...sequenceIndexes) > anchorEnd &&
      Math.min(...sequenceIndexes) - anchorEnd <= 128 &&
      runs.every(
        (run) =>
          run.page === anchorSource.page &&
          run.rotation === anchorSource.rotation &&
          run.method === anchorSource.method,
      )
    )
  })
  if (equationNumberCandidates.length !== 1) return null
  const equationNumber = equationNumberCandidates[0]
  const equationNumberSequenceIndexes =
    visibleSourceSequenceIndexes(equationNumber)!
  const sequenceEnd = Math.max(...equationNumberSequenceIndexes)
  const corridorLeft = anchor.x - Math.max(0.025, anchor.height * 2)
  const corridorRight =
    equationNumber.x +
    equationNumber.width +
    Math.max(0.015, equationNumber.height)
  const corridorTop = anchor.y - Math.max(0.045, anchor.height * 3.5)
  const corridorBottom =
    anchor.y + anchor.height + Math.max(0.065, anchor.height * 5)
  const sequenceIntersectingLines = lines.filter((candidate) => {
    if (candidate.page !== anchor.page) return false
    const sequenceIndexes = visibleSourceSequenceIndexes(candidate)
    return (
      sequenceIndexes !== null &&
      sequenceIndexes.some(
        (sourceSequenceIndex) =>
          sourceSequenceIndex >= anchorStart &&
          sourceSequenceIndex <= sequenceEnd,
      )
    )
  })
  const members = sequenceIntersectingLines.filter((candidate) => {
    const sequenceIndexes = visibleSourceSequenceIndexes(candidate)!
    const visibleRuns = candidate.runs.filter((run) => run.text.trim())
    return (
      sequenceIndexes.every(
        (sourceSequenceIndex) =>
          sourceSequenceIndex >= anchorStart &&
          sourceSequenceIndex <= sequenceEnd,
      ) &&
      candidate.x >= corridorLeft &&
      candidate.x + candidate.width <= corridorRight &&
      candidate.y >= corridorTop &&
      candidate.y + candidate.height <= corridorBottom &&
      visibleRuns.every(
        (run) =>
          run.page === anchorSource.page &&
          run.rotation === anchorSource.rotation &&
          run.method === anchorSource.method,
      )
    )
  })
  if (
    members.length < 8 ||
    members.length !== sequenceIntersectingLines.length ||
    !members.includes(anchor) ||
    !members.includes(equationNumber)
  ) {
    return null
  }
  const allSequenceIndexes = members
    .flatMap((member) => visibleSourceSequenceIndexes(member)!)
    .sort((left, right) => left - right)
  if (
    new Set(allSequenceIndexes).size !== allSequenceIndexes.length ||
    allSequenceIndexes[0] !== anchorStart ||
    allSequenceIndexes.at(-1) !== sequenceEnd ||
    allSequenceIndexes
      .slice(1)
      .some(
        (sourceSequenceIndex, index) =>
          sourceSequenceIndex - allSequenceIndexes[index] > 4,
      )
  ) {
    return null
  }

  const numericNumerators = members.filter((candidate) => {
    if (!/^[+-]?\d+(?:[.,]\d+)?$/u.test(candidate.text.trim())) return false
    return candidate.y + candidate.height / 2 < anchorCenterY
  })
  const extensionFont = (fontName: string) =>
    /(?:CMEX|MathExtensions?)/iu.test(fontName)
  const mathFont = (fontName: string) =>
    /(?:cmmi|cmsy|cmex|math|symbol)/iu.test(fontName)
  const denominatorHosts = new Set<ClassifiedLine>()
  for (const numerator of numericNumerators) {
    const numeratorSequenceIndexes = visibleSourceSequenceIndexes(numerator)!
    const numeratorEnd = Math.max(...numeratorSequenceIndexes)
    const numeratorCenterX = numerator.x + numerator.width / 2
    const denominatorCandidates = members.filter((candidate) => {
      if (candidate === numerator || denominatorHosts.has(candidate)) {
        return false
      }
      return candidate.runs.some((run) => {
        if (
          !run.text.trim() ||
          run.sourceSequenceIndex === undefined ||
          run.sourceSequenceIndex <= numeratorEnd ||
          extensionFont(run.fontName) ||
          !mathFont(run.fontName)
        ) {
          return false
        }
        const runCenterX = run.x + run.width / 2
        const runCenterY = run.y + run.height / 2
        return (
          runCenterY - (numerator.y + numerator.height / 2) >= 0.004 &&
          runCenterY - (numerator.y + numerator.height / 2) <=
            Math.max(0.04, numerator.height * 3) &&
          Math.abs(runCenterX - numeratorCenterX) <=
            Math.max(0.035, numerator.width * 0.9)
        )
      })
    })
    if (denominatorCandidates.length === 1) {
      denominatorHosts.add(denominatorCandidates[0])
    }
  }
  const extensionRuns = members.flatMap((member) =>
    member.runs.filter((run) => run.text.trim() && extensionFont(run.fontName)),
  )
  if (
    numericNumerators.length < 2 ||
    denominatorHosts.size < 2 ||
    extensionRuns.length < 3
  ) {
    return null
  }
  return members
}

function promoteSourceProvenMultiComponentDisplayClusters(
  lines: ClassifiedLine[],
  layout: ColumnLayout,
) {
  const resolvedColumnAuthority =
    layout.accepted &&
    !layout.ambiguous &&
    layout.resolution?.status === 'resolved'
  const proposals = lines.flatMap((anchor) => {
    const members = sourceProvenMultiComponentDisplayCluster(anchor, lines)
    return members &&
      (!resolvedColumnAuthority ||
        members.every((member) => member.column === anchor.column))
      ? [{ anchor, members }]
      : []
  })
  const accepted = proposals.filter(
    (proposal) =>
      !proposals.some(
        (candidate) =>
          candidate !== proposal &&
          candidate.members.some((member) => proposal.members.includes(member)),
      ),
  )
  for (const { anchor, members } of accepted) {
    const seedId = `${anchor.id}-source-bounded-display-cluster`
    for (const member of members) {
      member.kind = 'equation'
      member.confidence = Math.max(member.confidence, 0.98)
      member.displayEquationClusterSeedId = seedId
    }
  }
}

function joinsRegion(
  previous: ClassifiedLine,
  line: ClassifiedLine,
  hardHyphenLexicon: ReadonlySet<string>,
) {
  if (previous.page !== line.page) return false
  if (
    unresolvedMathExtensionLine(previous) ||
    unresolvedMathExtensionLine(line)
  ) {
    return false
  }
  if (previous.kind !== line.kind || previous.column !== line.column)
    return false
  if (previous.tabularGridBandId || line.tabularGridBandId) {
    return (
      previous.tabularGridBandId !== undefined &&
      previous.tabularGridBandId === line.tabularGridBandId
    )
  }
  const standaloneListMarker = (text: string) =>
    /^(?:\d{1,3}|[A-Za-z]|[ivxlcdm]+)[.)]$/iu.test(text.trim())
  if (line.kind !== 'caption' && standaloneListMarker(line.text)) {
    return false
  }
  if (
    previous.kind !== 'caption' &&
    standaloneListMarker(previous.text) &&
    line.x > previous.x + previous.width &&
    line.x - (previous.x + previous.width) <= 0.12 &&
    Math.abs(line.y - previous.y) <=
      Math.max(0.004, Math.max(previous.height, line.height) * 0.4)
  ) {
    return true
  }
  if (previous.headingContinuationSeedId) return false
  if (line.kind === 'caption' && beginsVisualCaption(line.text)) return false
  if (standaloneSectionHeading(previous) || standaloneSectionHeading(line)) {
    return false
  }
  if (
    (line.kind === 'footnote' || line.kind === 'endnote') &&
    line.noteLabel !== null
  ) {
    return false
  }
  if (line.kind === 'chart-label' || line.kind === 'page-number') return false
  // A printed display-equation number is often emitted as a standalone line at
  // the right edge of a column.  Do not merge it into the prose explanation
  // that begins below and to its left: the visual pass needs the detached
  // fragment so it can attach the number to the aligned equation instead of
  // layout interpreting `(4) where ...` as an ordered-list item.
  if (
    /^\(\s*\d+[a-z]?\s*\)$/iu.test(previous.text.trim()) &&
    line.x + Math.max(0.08, line.width * 0.2) < previous.x
  ) {
    return false
  }
  if (
    previous.page === 1 &&
    previous.y < 0.3 &&
    /(?:,|\s(?:and|&)\s)/i.test(previous.text) &&
    /(?:university|institute|department|laborator(?:y|ies)|\blab\b|school|college|centre|center|hospital|academy|research group)/i.test(
      line.text,
    )
  ) {
    return false
  }
  const listItem =
    /^(?:[•◦▪‣–—-]|\[\s*\d+\s*\]|\(\s*(?:\d+|[A-Za-z]|[ivxlcdm]+)\s*\)|(?:\d+|[A-Za-z]|[ivxlcdm]+)[.)])\s+/iu
  if (
    line.kind !== 'caption' &&
    listItem.test(line.text.trim()) &&
    !sourceProvenLexicalHyphenContinuation(previous, line, hardHyphenLexicon)
  ) {
    return false
  }
  if (sourceProvenDominantBaselineSequentialWrap(previous, line)) {
    return true
  }
  const gap = line.y - (previous.y + previous.height)
  const fontRatio =
    Math.max(previous.fontSize, line.fontSize) /
    Math.max(1, Math.min(previous.fontSize, line.fontSize))
  if (gap < -0.004 || fontRatio > 1.18) return false
  // Scripts legitimately expand the source-backed line envelope, but they do
  // not expand the body leading that decides whether the next baseline starts
  // a new paragraph. Using the full union here can merge separate paragraphs
  // whenever a subscript or superscript reaches toward the following line.
  const lineHeight = Math.max(
    dominantLineHeight(previous),
    dominantLineHeight(line),
  )
  return gap <= Math.max(0.014, lineHeight * 1.25)
}

function beginsRepeatedFirstLineIndent(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  if (group.length < 2) return false
  const first = group[0]
  const previous = group.at(-1)!
  if (
    line.page !== first.page ||
    line.kind !== first.kind ||
    line.column !== first.column
  ) {
    return false
  }
  const continuationX = median(group.slice(1).map((candidate) => candidate.x))
  const indent = first.x - continuationX
  const tolerance = Math.max(0.007, first.height * 0.45)
  return (
    Math.abs(indent) >= Math.max(0.012, first.height * 0.75) &&
    Math.abs(line.x - first.x) <= tolerance &&
    Math.abs(previous.x - continuationX) <= tolerance
  )
}

function endsProseSentence(line: ClassifiedLine) {
  return /[.!?](?:["'’”\])}]*)$/u.test(line.text.trim())
}

function beginsUppercaseProse(line: ClassifiedLine) {
  return /^\p{Lu}/u.test(line.text.trim())
}

function beginsIndentedParagraph(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  if (group.length < 2 || !beginsUppercaseProse(line)) return false
  const previous = group.at(-1)!
  if (!endsProseSentence(previous)) return false
  const continuationX = median(
    group.slice(-Math.min(5, group.length)).map((candidate) => candidate.x),
  )
  const lineHeight = Math.max(
    dominantLineHeight(previous),
    dominantLineHeight(line),
  )
  return line.x - continuationX >= Math.max(0.012, lineHeight * 0.75)
}

function runUsesEmphasizedOrItalicFace(run: ClassifiedLine['runs'][number]) {
  return (
    run.bold === true ||
    run.italic === true ||
    /(?:bold|semibold|demi|medi(?:um)?|black|italic|ital|oblique)/iu.test(
      run.fontName,
    ) ||
    /(?:^|[+,._\s-])cm(?:bx|b|ti|it|sl)\d*(?=$|[+,._\s-])/iu.test(run.fontName)
  )
}

function beginsStyledRunInParagraph(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  if (group.length === 0 || !beginsUppercaseProse(line)) return false
  const previous = group.at(-1)!
  if (!endsProseSentence(previous)) return false
  const visibleRuns = [...line.runs]
    .filter((run) => run.text.trim())
    .sort((left, right) => left.x - right.x)
  if (
    visibleRuns.length === 0 ||
    !runUsesEmphasizedOrItalicFace(visibleRuns[0])
  ) {
    return false
  }
  const styledRunIn =
    visibleRuns.length > 1 &&
    visibleRuns.slice(1).some((run) => !runUsesEmphasizedOrItalicFace(run))
  const continuationX = median(
    group.slice(-Math.min(5, group.length)).map((candidate) => candidate.x),
  )
  const lineHeight = Math.max(
    dominantLineHeight(previous),
    dominantLineHeight(line),
  )
  const visiblyIndented =
    line.x - continuationX >= Math.max(0.012, lineHeight * 0.75)
  return styledRunIn || visiblyIndented
}

function beginsBlankLeadingParagraph(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  if (group.length === 0) return false
  const previous = group.at(-1)!
  if (
    previous.page !== line.page ||
    previous.kind !== line.kind ||
    previous.column !== line.column ||
    !['body', 'spanning'].includes(line.kind)
  ) {
    return false
  }
  const gap = line.y - (previous.y + previous.height)
  const lineHeight = Math.max(
    dominantLineHeight(previous),
    dominantLineHeight(line),
  )
  if (
    !endsProseSentence(previous) ||
    (/:\s*$/u.test(line.text.trim()) &&
      (line.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) <= 8)
  ) {
    return false
  }
  const priorGaps = group
    .slice(1)
    .map((candidate, index) => {
      const prior = group[index]
      return candidate.y - (prior.y + prior.height)
    })
    .filter(
      (candidateGap) =>
        candidateGap >= -0.002 && candidateGap <= lineHeight * 0.55,
    )
  if (priorGaps.length === 0) return false
  const threshold = Math.max(
    0.006,
    median(priorGaps) + lineHeight * 0.35,
    lineHeight * 0.5,
  )
  return gap >= threshold
}

function beginsParagraphBoundary(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  return (
    beginsRepeatedFirstLineIndent(group, line) ||
    beginsBlankLeadingParagraph(group, line) ||
    beginsIndentedParagraph(group, line) ||
    beginsStyledRunInParagraph(group, line)
  )
}

function makeRegions(
  lines: ClassifiedLine[],
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
  lineBoundaryDecisions: PdfLineBoundaryDecision[],
) {
  const groups: ClassifiedLine[][] = []
  const detachedDisplayEquationAtomHosts = new Map<
    ClassifiedLine,
    ClassifiedLine
  >()
  const displayEquationClusterGroups = new Map<string, ClassifiedLine[]>()
  const ordered = [...lines].sort((left, right) => {
    if (left.page !== right.page) return left.page - right.page
    const columnOrder = left.column.localeCompare(right.column)
    if (columnOrder !== 0) return columnOrder
    return sourceLineFlowOrder(left, right)
  })
  for (const line of ordered) {
    if (line.displayEquationClusterSeedId) {
      const clusterGroup = displayEquationClusterGroups.get(
        line.displayEquationClusterSeedId,
      )
      if (clusterGroup) clusterGroup.push(line)
      else {
        const group = [line]
        groups.push(group)
        displayEquationClusterGroups.set(
          line.displayEquationClusterSeedId,
          group,
        )
      }
      continue
    }
    const headingGroup = line.headingContinuationSeedId
      ? groups.find((group) =>
          group.some(
            (candidate) => candidate.id === line.headingContinuationSeedId,
          ),
        )
      : undefined
    if (headingGroup) {
      headingGroup.push(line)
      continue
    }
    const captionGroup = line.captionContinuationSeedId
      ? groups.find((group) =>
          group.some(
            (candidate) => candidate.id === line.captionContinuationSeedId,
          ),
        )
      : undefined
    if (captionGroup) {
      captionGroup.push(line)
      continue
    }
    const panelLabelGroup = line.panelLabelContinuationSeedId
      ? groups.find((group) =>
          group.some(
            (candidate) => candidate.id === line.panelLabelContinuationSeedId,
          ),
        )
      : undefined
    if (panelLabelGroup) {
      panelLabelGroup.push(line)
      continue
    }
    const previousGroup = groups.at(-1)
    const previous = previousGroup?.at(-1)
    const paragraphBoundary = previous
      ? beginsParagraphBoundary(previousGroup!, line)
      : false
    const detachedDisplayEquationAtomHost =
      previous && !paragraphBoundary
        ? sourceProvenDetachedDisplayEquationAtomHost(previous, line, ordered)
        : null
    if (detachedDisplayEquationAtomHost) {
      detachedDisplayEquationAtomHosts.set(
        line,
        detachedDisplayEquationAtomHost,
      )
    }
    if (
      previous &&
      !paragraphBoundary &&
      !detachedDisplayEquationAtomHost &&
      joinsRegion(previous, line, hardHyphenLexicon)
    )
      previousGroup!.push(line)
    else groups.push([line])
  }

  for (const [atom, host] of detachedDisplayEquationAtomHosts.entries()) {
    const atomGroup = groups.find((group) => group.includes(atom))
    const hostGroup = groups.find((group) => group.includes(host))
    if (!atomGroup || !hostGroup || atomGroup === hostGroup) continue
    // The atom boundary was proved before grouping, but move it only while it
    // remains a standalone region. Any later claimant makes the ownership
    // ambiguous and must leave the atom visible for review.
    if (atomGroup.length !== 1) continue
    const hostIndex = hostGroup.indexOf(host)
    if (hostIndex < 0) continue
    atom.kind = 'equation'
    atom.confidence = Math.max(atom.confidence, 0.98)
    hostGroup.splice(hostIndex, 0, atom)
    groups.splice(groups.indexOf(atomGroup), 1)
  }

  const sourceOrderedGroups = groups.sort((left, right) =>
    sourceLineFlowOrder(left[0], right[0]),
  )
  const pageCounters = new Map<number, number>()
  return sourceOrderedGroups.map<PdfPageRegion>((group) => {
    const page = group[0].page
    const number = (pageCounters.get(page) ?? 0) + 1
    pageCounters.set(page, number)
    const id = `page-${String(page).padStart(3, '0')}-region-${String(number).padStart(3, '0')}`
    const orderedGroup = group[0].tabularGridBandId
      ? [...group].sort((left, right) => left.x - right.x || left.y - right.y)
      : group[0].displayEquationClusterSeedId
        ? [...group].sort((left, right) => {
            const leftSequenceIndexes = visibleSourceSequenceIndexes(left) ?? []
            const rightSequenceIndexes =
              visibleSourceSequenceIndexes(right) ?? []
            return (
              Math.min(...leftSequenceIndexes) -
                Math.min(...rightSequenceIndexes) ||
              sourceLineFlowOrder(left, right)
            )
          })
        : group.some((line) => line.headingContinuationSeedId)
          ? [...group].sort(
              (left, right) => left.y - right.y || left.x - right.x,
            )
          : group
    const regionLines = orderedGroup.map<PdfRegionLine>((line) => {
      const visibleRuns = line.runs.filter((run) => run.text.trim())
      const sourceSequenceIndexes = visibleRuns.flatMap((run) =>
        run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
      )
      const sourceFragmentLineage =
        line.sourceFragmentLineage ??
        (sourceSequenceIndexes.length === visibleRuns.length &&
        new Set(sourceSequenceIndexes).size === sourceSequenceIndexes.length
          ? {
              algorithm: 'source-run-fragment-v1' as const,
              sourceLineId: line.id,
              fragment: 'whole' as const,
              sourceSequenceIndexes,
            }
          : undefined)
      const regionLine = {
        id: line.id,
        text: line.text,
        fontSize: rounded(line.fontSize),
        box: lineBox(line),
        runs: line.runs.map((run) => ({ ...run })),
        ...(line.captionContinuationSeedId
          ? {
              captionContinuationSeedId: line.captionContinuationSeedId,
            }
          : {}),
        ...(sourceFragmentLineage ? { sourceFragmentLineage } : {}),
      }
      copyPdfLinkedTokenSourceAnnotations(line, regionLine)
      return regionLine
    })
    const kind = orderedGroup[0].kind
    const furnitureEvidence = orderedGroup.find(
      (line) => line.furniture,
    )?.furniture
    const furnitureReview = orderedGroup.find(
      (line) => line.furnitureReview,
    )?.furnitureReview
    const sourceCaptionLaneBoundary = orderedGroup[0].sourceCaptionLaneBoundary
    const sourceCaptionLaneSide = orderedGroup[0].sourceCaptionLaneSide
    const sourceCaptionLane =
      sourceCaptionLaneBoundary !== undefined &&
      sourceCaptionLaneSide !== undefined &&
      orderedGroup.every(
        (line) =>
          line.sourceCaptionLaneBoundary === sourceCaptionLaneBoundary &&
          line.sourceCaptionLaneSide === sourceCaptionLaneSide,
      )
        ? {
            boundary: rounded(sourceCaptionLaneBoundary),
            side: sourceCaptionLaneSide,
          }
        : null
    return {
      id,
      page,
      kind,
      column: orderedGroup[0].column,
      text: joinPdfLineTexts(orderedGroup, {
        hardHyphenLexicon,
        unhyphenatedLexicon,
        language,
        regionId: id,
        decisions: lineBoundaryDecisions,
      }),
      confidence: rounded(
        Math.min(...orderedGroup.map((line) => line.confidence)),
      ),
      box: unionBox(regionLines),
      lines: regionLines,
      nativeObjectIds: [],
      includedInReadingOrder: ![
        'header',
        'footer',
        'page-number',
        'side',
        'chart-label',
      ].includes(kind),
      ...(furnitureEvidence ? { furniture: furnitureEvidence } : {}),
      ...(furnitureReview ? { furnitureReview } : {}),
      ...(sourceCaptionLane ? { sourceCaptionLane } : {}),
    }
  })
}

function makeObjectRegions(
  pages: PdfPageAnalysis[],
  layouts: Map<number, ColumnLayout>,
  furnitureByObjectId: ReadonlyMap<string, PdfFurnitureEvidence> = new Map(),
) {
  return pages.flatMap((page) =>
    (page.objects ?? [])
      .filter((object) => object.role !== 'scan-source')
      .map<PdfPageRegion>((object, index) => {
        const layout = layouts.get(page.page) ?? {
          split: null,
          accepted: false,
          ambiguous: false,
          resolution: null,
        }
        const column = columnFor(
          {
            page: page.page,
            text: '',
            x: object.box.x,
            y: object.box.y,
            width: object.box.width,
            height: object.box.height,
            fontSize: 0,
            runs: [],
            column: 'single',
          },
          layout,
        )
        const furniture = furnitureByObjectId.get(object.id)
        return {
          id: `page-${String(page.page).padStart(3, '0')}-object-region-${String(index + 1).padStart(3, '0')}`,
          page: page.page,
          kind: 'figure',
          column,
          text: '',
          confidence: object.confidence,
          box: { ...object.box },
          lines: [],
          nativeObjectIds: [object.id],
          includedInReadingOrder: !furniture,
          ...(furniture ? { furniture } : {}),
        }
      }),
  )
}

function columnOrdered(regions: PdfPageRegion[]) {
  const readingAnchor = (region: PdfPageRegion) => {
    const firstSourceLine = [...region.lines]
      .filter((line) => line.text.trim())
      .sort(
        (left, right) => left.box.y - right.box.y || left.box.x - right.box.x,
      )[0]
    return firstSourceLine?.box ?? region.box
  }
  const byY = (left: PdfPageRegion, right: PdfPageRegion) => {
    const splitDefinitionOrder = splitNoteDefinitionOrder(left, right)
    const leftAnchor = readingAnchor(left)
    const rightAnchor = readingAnchor(right)
    const inlineOrder = inlineStackedFragmentOrder(
      left.lines[0] ?? { id: undefined },
      right.lines[0] ?? { id: undefined },
    )
    return (
      splitDefinitionOrder ??
      inlineOrder ??
      (leftAnchor.y - rightAnchor.y ||
        leftAnchor.x - rightAnchor.x ||
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id))
    )
  }
  return [
    ...regions.filter((region) => region.column === 'left').sort(byY),
    ...regions.filter((region) => region.column === 'right').sort(byY),
    ...regions
      .filter(
        (region) => region.column === 'single' || region.column === 'span',
      )
      .sort(byY),
  ]
}

function orderPageRegions(regions: PdfPageRegion[], layout: ColumnLayout) {
  const included = regions.filter((region) => region.includedInReadingOrder)
  const notes = included.filter(
    (region) => region.kind === 'footnote' || region.kind === 'endnote',
  )
  const flow = included.filter(
    (region) => region.kind !== 'footnote' && region.kind !== 'endnote',
  )
  if (layout.split === null) {
    return restoreInlineStackedAtomicUnits([
      ...flow.sort(
        (left, right) =>
          inlineStackedFragmentOrder(
            left.lines[0] ?? { id: undefined },
            right.lines[0] ?? { id: undefined },
          ) ??
          (left.box.y - right.box.y || left.box.x - right.box.x),
      ),
      ...notes.sort(
        (left, right) =>
          splitNoteDefinitionOrder(left, right) ??
          (left.box.y - right.box.y || left.box.x - right.box.x),
      ),
    ])
  }

  const spanning = flow
    .filter((region) => region.column === 'span')
    .sort((left, right) => left.box.y - right.box.y)
  const columnFlow = flow.filter((region) => region.column !== 'span')
  const ordered: PdfPageRegion[] = []
  const emitted = new Set<string>()
  for (const span of spanning) {
    const band = columnFlow.filter(
      (region) => !emitted.has(region.id) && region.box.y < span.box.y,
    )
    ordered.push(...columnOrdered(band), span)
    for (const region of band) emitted.add(region.id)
  }
  ordered.push(
    ...columnOrdered(columnFlow.filter((region) => !emitted.has(region.id))),
    ...columnOrdered(notes),
  )
  return restoreInlineStackedAtomicUnits(ordered)
}

function edgeEvidence(from: PdfPageRegion, to: PdfPageRegion) {
  if (from.page !== to.page) {
    return {
      code: 'page-sequence' as const,
      detail: `Page ${from.page} precedes page ${to.page}.`,
    }
  }
  if (to.kind === 'footnote' || to.kind === 'endnote') {
    return {
      code: 'note-after-body' as const,
      detail: 'The separated note region follows the page body flow.',
    }
  }
  if (from.column !== to.column) {
    return {
      code: 'column-flow' as const,
      detail: `${from.column} column flow precedes ${to.column} column flow.`,
    }
  }
  if (
    from.kind === 'spanning' ||
    to.kind === 'spanning' ||
    from.column === 'span' ||
    to.column === 'span'
  ) {
    return {
      code: 'spanning-boundary' as const,
      detail: 'A page-spanning region forms a deterministic flow boundary.',
    }
  }
  return {
    code: 'vertical-flow' as const,
    detail: 'Regions in the same flow follow normalized vertical geometry.',
  }
}

export function hasAcceptedCycle(
  regionIds: string[],
  edges: PdfReadingOrderEdge[],
) {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges.filter(
    (candidate) => candidate.status === 'accepted',
  )) {
    const targets = outgoing.get(edge.from) ?? []
    targets.push(edge.to)
    outgoing.set(edge.from, targets)
  }
  const state = new Map<string, 'visiting' | 'visited'>()
  for (const root of regionIds) {
    if (state.has(root)) continue
    state.set(root, 'visiting')
    const stack = [{ id: root, nextTarget: 0 }]
    while (stack.length > 0) {
      const frame = stack.at(-1)!
      const targets = outgoing.get(frame.id) ?? []
      if (frame.nextTarget >= targets.length) {
        state.set(frame.id, 'visited')
        stack.pop()
        continue
      }
      const target = targets[frame.nextTarget]
      frame.nextTarget += 1
      if (state.get(target) === 'visiting') return true
      if (state.get(target) === 'visited') continue
      state.set(target, 'visiting')
      stack.push({ id: target, nextTarget: 0 })
    }
  }
  return false
}

function buildReadingOrder(
  regions: PdfPageRegion[],
  layouts: Map<number, ColumnLayout>,
) {
  const orderedRegions = [...layouts.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([page, layout]) =>
      orderPageRegions(
        regions.filter((region) => region.page === page),
        layout,
      ),
    )
  const edges: PdfReadingOrderEdge[] = []
  for (let index = 0; index < orderedRegions.length - 1; index += 1) {
    const from = orderedRegions[index]
    const to = orderedRegions[index + 1]
    const layout = layouts.get(from.page)
    const crossColumnBoundary =
      from.page === to.page && from.column === 'left' && to.column === 'right'
    const ambiguousBoundary = crossColumnBoundary && Boolean(layout?.ambiguous)
    const resolvedBoundary =
      crossColumnBoundary && layout?.resolution?.status === 'resolved'
    edges.push({
      id: `reading-edge-${String(edges.length + 1).padStart(4, '0')}`,
      from: from.id,
      to: to.id,
      status: ambiguousBoundary ? 'candidate' : 'accepted',
      confidence:
        ambiguousBoundary || resolvedBoundary
          ? (layout?.resolution?.confidence ?? 0.5)
          : 0.96,
      evidence: ambiguousBoundary
        ? [
            ...(layout?.resolution?.evidence ?? []),
            {
              code: 'ambiguous-column-flow',
              detail: `Both column orders remain candidates because confidence ${layout?.resolution?.confidence ?? 0.5} is below threshold ${READING_ORDER_RESOLUTION_THRESHOLD}.`,
            },
          ]
        : resolvedBoundary
          ? [...layout.resolution!.evidence, edgeEvidence(from, to)]
          : [edgeEvidence(from, to)],
      sourceBoxes: [from.box, to.box],
    })
    if (ambiguousBoundary) {
      const rightRegions = orderedRegions.filter(
        (region) => region.page === from.page && region.column === 'right',
      )
      const leftRegions = orderedRegions.filter(
        (region) => region.page === from.page && region.column === 'left',
      )
      const reverseFrom = rightRegions.at(-1)
      const reverseTo = leftRegions[0]
      if (reverseFrom && reverseTo) {
        edges.push({
          id: `reading-edge-${String(edges.length + 1).padStart(4, '0')}`,
          from: reverseFrom.id,
          to: reverseTo.id,
          status: 'candidate',
          confidence: layout?.resolution?.confidence ?? 0.5,
          evidence: [
            ...(layout?.resolution?.evidence ?? []),
            {
              code: 'ambiguous-column-flow',
              detail: `The reverse column order is retained for bounded review below threshold ${READING_ORDER_RESOLUTION_THRESHOLD}.`,
            },
          ],
          sourceBoxes: [reverseFrom.box, reverseTo.box],
        })
      }
    }
  }
  const regionIds = regions.map((region) => region.id)
  const resolutions = [...layouts.entries()]
    .filter(
      (
        entry,
      ): entry is [
        number,
        ColumnLayout & { resolution: NonNullable<ColumnLayout['resolution']> },
      ] => entry[1].resolution !== null,
    )
    .map<PdfReadingOrderResolution>(([page, layout]) => ({
      page,
      ...layout.resolution,
      regionIds: regions
        .filter(
          (region) => region.page === page && region.includedInReadingOrder,
        )
        .map((region) => region.id),
    }))
  const acyclic = !hasAcceptedCycle(regionIds, edges)
  const unresolvedEdgeCount = edges.filter(
    (edge) => edge.status === 'candidate',
  ).length
  const evaluation: PdfReadingOrderEvaluation = {
    schemaVersion: '1.0.0',
    algorithm: 'deterministic-geometry-v1',
    mode: 'deterministic-only',
    regionCount: orderedRegions.length,
    acceptedEdgeCount: edges.length - unresolvedEdgeCount,
    unresolvedEdgeCount,
    cycleRate: acyclic ? 0 : 1,
    orderAccuracy: null,
    provider: null,
    modelVersion: null,
    latencyMs: 0,
    costUsd: 0,
    reviewRequired: !acyclic || unresolvedEdgeCount > 0,
  }
  return {
    schemaVersion: '1.0.0',
    regionIds,
    order: orderedRegions.map((region) => region.id),
    edges,
    resolutions,
    acyclic,
    evaluation,
  } satisfies PdfReadingOrderGraph
}

export function evaluateReadingOrder(
  graph: PdfReadingOrderGraph,
  expectedOrder?: readonly string[],
) {
  if (!expectedOrder) return { ...graph.evaluation }
  const expectedPositions = new Map(
    expectedOrder.map((id, index) => [id, index]),
  )
  const comparable = graph.order.filter((id) => expectedPositions.has(id))
  const correct = comparable.filter(
    (id, index) => expectedPositions.get(id) === index,
  ).length
  return {
    ...graph.evaluation,
    orderAccuracy:
      expectedOrder.length === 0
        ? 1
        : rounded(correct / Math.max(expectedOrder.length, graph.order.length)),
  }
}

export function reconstructPageRegions(
  pages: PdfPageAnalysis[],
  { language = null }: { language?: string | null } = {},
) {
  const groupedLines = pages.map((page) => groupRunsIntoLines(page))
  const deferredFurnitureRunKeys = new Set<string>()
  for (const lines of groupedLines) {
    for (const key of noteStratumRunKeys(lines)) {
      deferredFurnitureRunKeys.add(key)
    }
  }
  const furnitureAssessment = classifyPdfFurniture(pages, {
    deferredRunKeys: deferredFurnitureRunKeys,
  })
  const repeated = new Set(
    furnitureAssessment.patterns.map((pattern) => pattern.normalizedText),
  )
  const protectedRepeatedMarginHeadings =
    sourceProvenRepeatedMarginHeadingLines(groupedLines, repeated)
  const rawLines = groupedLines.map((lines) =>
    splitDetachedMathExtensionProseRuns(
      splitSourceStackedInlineFormulaLines(
        splitRepeatedMarginSourceRuns(
          lines,
          repeated,
          protectedRepeatedMarginHeadings,
          furnitureAssessment.byRunKey,
        ),
      ),
    ),
  )
  const hardHyphenLexicon = inlineHardHyphenLexicon(rawLines.flat())
  const unhyphenatedLexicon = inlineUnhyphenatedLexicon(rawLines.flat())
  const classified: ClassifiedLine[] = []
  const layouts = new Map<number, ColumnLayout>()
  let inEndnotes = false

  const lineFurniture = (line: PdfTextLine) => {
    const visibleRuns = line.runs.filter((run) => run.text.trim())
    if (visibleRuns.length === 0) return undefined
    const evidences = visibleRuns.flatMap((run) => {
      const evidence = furnitureAssessment.byRunKey.get(furnitureRunKey(run))
      return evidence ? [evidence] : []
    })
    if (evidences.length === visibleRuns.length && evidences.length > 0) {
      return evidences[0]
    }
    return undefined
  }
  const lineDeferredToNotes = (line: PdfTextLine) => {
    const visibleRuns = line.runs.filter((run) => run.text.trim())
    return (
      visibleRuns.length > 0 &&
      visibleRuns.every((run) =>
        deferredFurnitureRunKeys.has(furnitureRunKey(run)),
      )
    )
  }
  const lineFurnitureReview = (
    line: PdfTextLine,
    explicitParatextLines?: ReadonlySet<PdfTextLine>,
  ) => {
    if (explicitParatextLines?.has(line)) return undefined
    const visibleRuns = line.runs.filter((run) => run.text.trim())
    if (visibleRuns.length === 0) return undefined
    const reviews = visibleRuns.flatMap((run) => {
      const review = furnitureAssessment.reviewByRunKey.get(
        furnitureRunKey(run),
      )
      return review ? [review] : []
    })
    return reviews.length === visibleRuns.length && reviews.length > 0
      ? reviews[0]
      : undefined
  }

  for (const [pageIndex, pageLines] of rawLines.entries()) {
    const page = pages[pageIndex]
    const fontSize = bodyFontSize(pageLines)
    const paratextLines = firstPageParatextLines(pageLines)
    const numberedBodyListLines =
      unreferencedSequentialNumberedListLines(pageLines)
    const lowerBand = quantile(
      pageLines.map((line) => line.y + line.height),
      0.65,
    )
    let preliminary = pageLines
      .sort(sourceLineFlowOrder)
      .map<ClassifiedLine>((line, lineIndex) => {
        const furniture = lineFurniture(line)
        const furnitureReview = lineFurnitureReview(line, paratextLines)
        const normalized = normalizedNoteLabel(line.text)
        const endnoteHeading = /^(?:endnotes?|notes?)$/i.test(normalized)
        const noteEvidence = noteLineClassificationEvidence(
          line,
          fontSize,
          lowerBand,
          numberedBodyListLines,
        )
        const { label, explicitFootnote, renderedFootnote } = noteEvidence
        const inlineStackedFragment = inlineStackedFragmentParts(line)
        let kind: PdfRegionKind = 'body'
        let confidence = 0.9
        if (inEndnotes && label !== null) {
          kind = 'endnote'
          confidence = 0.96
        } else if (explicitFootnote || renderedFootnote) {
          kind = 'footnote'
          confidence = explicitFootnote ? 0.98 : 0.9
        } else if (
          beginsVisualCaption(normalized) ||
          beginsSourceStyledVisualCaption(line)
        ) {
          kind = 'caption'
          confidence = 0.94
        } else if (
          page.page === 1 &&
          /^arxiv:\s*\d{4}\.\d{4,5}(?:v\d+)?\b/i.test(normalized) &&
          line.width >= 0.45 &&
          line.height <= 0.04 &&
          line.fontSize >= 16
        ) {
          kind = 'side'
          confidence = 0.99
        } else if (paratextLines.has(line)) {
          kind = 'footer'
          confidence = 0.99
        } else if (furniture) {
          kind =
            furniture.band === 'left' || furniture.band === 'right'
              ? 'side'
              : furniture.classification === 'incrementing-numeral' &&
                  marginTextIsNumeralOnly(line.text)
                ? 'page-number'
                : furniture.band === 'top'
                  ? 'header'
                  : 'footer'
          confidence = 0.99
        } else if (
          marginBand(line) &&
          repeated.has(normalizeMarginText(line.text))
        ) {
          kind = line.y < 0.5 ? 'header' : 'footer'
          confidence = 0.99
        } else if (
          furniture &&
          (line.y <= 0.08 || line.y + line.height >= 0.92) &&
          line.fontSize <= fontSize * 0.9
        ) {
          kind = line.y <= 0.08 ? 'header' : 'footer'
          confidence = 0.78
        } else if (/-detached-math-\d+-host-/u.test(line.id ?? '')) {
          kind = 'equation'
          confidence = 0.98
        } else if (
          unresolvedMathExtensionLine(line) &&
          !proseDominantInlineMathLine(line)
        ) {
          kind = 'equation'
          confidence = 0.96
        } else if (
          inlineStackedFragment?.part === 'formula' &&
          !proseDominantInlineMathLine(line)
        ) {
          kind = 'equation'
          confidence = 0.96
        } else if (
          line.fontSize >= fontSize * 0.95 &&
          line.text.length <= 120 &&
          /(?:=|[+−×÷∫∑√≤≥≈])/u.test(line.text) &&
          !proseDominantInlineMathLine(line)
        ) {
          kind = 'equation'
          confidence = 0.9
        } else if (
          line.fontSize <= fontSize * 0.95 &&
          normalized.length <= 120 &&
          lineBelongsToNativeVisual(line, page.objects) &&
          !sourceStyledBoundaryHeadingLine(pageLines, lineIndex, fontSize)
        ) {
          kind = 'chart-label'
          confidence = 0.94
        } else if (
          line.fontSize <= fontSize * 0.82 &&
          normalized.length <= 32 &&
          !sourceStyledBoundaryHeadingLine(pageLines, lineIndex, fontSize) &&
          /(?:%|^[-+]?\d+(?:[.,]\d+)?$|^[A-Za-z]{2,12}$)/.test(normalized)
        ) {
          kind = 'chart-label'
          confidence = 0.82
        }
        if (endnoteHeading) inEndnotes = true
        return {
          ...line,
          id:
            line.id ??
            `page-${String(page.page).padStart(3, '0')}-line-${String(lineIndex + 1).padStart(4, '0')}`,
          kind,
          confidence,
          noteLabel: label,
          ...(furniture
            ? { furniture }
            : paratextLines.has(line) && !lineDeferredToNotes(line)
              ? {
                  furniture: {
                    classification: 'explicit-paratext' as const,
                    band: 'bottom' as const,
                    pages: [line.page],
                    boxes: line.runs
                      .filter((run) => run.text.trim())
                      .map(sourceRunBox),
                    evidence: ['first-page-paratext-geometry'],
                    normalizedText: normalizeMarginText(line.text),
                  },
                }
              : {}),
          ...(furnitureReview ? { furnitureReview } : {}),
        }
      })

    demoteInlineVisualReferenceContinuations(preliminary)
    preliminary = splitSourceCaptionLaneContinuations(preliminary)
    promoteCaptionContinuations(preliminary)
    markAdjacentPanelLabelContinuations(preliminary, page.objects)
    promoteNoteContinuations(preliminary)
    preclassifyMarginNotes(preliminary, fontSize)
    const spreadBoundary =
      page.spread?.status === 'split' ? page.spread.boundary : null
    const layout: ColumnLayout =
      spreadBoundary !== null
        ? {
            split: spreadBoundary,
            accepted: true,
            ambiguous: false,
            resolution: null,
          }
        : detectColumns(preliminary)
    preliminary = splitRunBackedCrossGutterProse(preliminary, layout)
    layouts.set(page.page, layout)
    const commonX = median(
      preliminary.filter((line) => line.kind === 'body').map((line) => line.x),
    )
    for (const line of preliminary) {
      line.tabularGridBandId = layout.tabularGridBands?.get(line.id)
      const continuationSeedId =
        line.captionContinuationSeedId ??
        line.panelLabelContinuationSeedId ??
        line.noteContinuationSeedId
      const continuationSeed = continuationSeedId
        ? preliminary.find((candidate) => candidate.id === continuationSeedId)
        : undefined
      line.column = continuationSeed
        ? columnFor(continuationSeed, layout)
        : (line.sourceOwnedColumn ?? columnFor(line, layout))
      if (
        line.kind === 'body' &&
        line.column === 'span' &&
        layout.split !== null
      ) {
        line.kind = 'spanning'
        line.confidence = layout.accepted ? 0.95 : 0.58
      } else if (
        line.kind === 'body' &&
        !line.furnitureReview &&
        !/^\p{L}$/u.test(normalizedNoteLabel(line.text)) &&
        !sourceRaisedFrontMatterAffiliation(line) &&
        line.fontSize <= fontSize * 0.85 &&
        line.text.length <= 120 &&
        Math.abs(line.x - commonX) > Math.max(0.18, line.width * 0.8)
      ) {
        line.kind = 'side'
        line.confidence = 0.76
      }
      if (
        layout.ambiguous &&
        (line.column === 'left' || line.column === 'right')
      ) {
        line.confidence = Math.min(line.confidence, 0.58)
      }
    }
    promoteSourceProvenSpanningInlineMathContinuations(preliminary)
    promoteSourceProvenMultiComponentDisplayClusters(preliminary, layout)
    markWrappedHeadingContinuations(preliminary)
    classified.push(...repairCrossGutterHeadingPrefixes(preliminary, layout))
  }

  const hasSingleColumnPage =
    layouts.size > 1 &&
    [...layouts.values()].some(
      (layout) => layout.split === null && !layout.ambiguous,
    )
  if (hasSingleColumnPage) {
    for (const layout of layouts.values()) {
      if (
        layout.resolution?.status === 'resolved' &&
        layout.resolution.ambiguityClass === 'sparse-column-gutter'
      ) {
        layout.resolution.ambiguityClass = 'mixed-single-two-column'
      }
    }
  }

  const lineBoundaryDecisions: PdfLineBoundaryDecision[] = []
  const textRegions = makeRegions(
    classified,
    hardHyphenLexicon,
    unhyphenatedLexicon,
    language,
    lineBoundaryDecisions,
  ).flatMap(splitRunBackedSymbolicNoteDefinitions)
  const regions = [
    ...textRegions,
    ...makeObjectRegions(pages, layouts, furnitureAssessment.objectById),
  ].sort((left, right) => {
    if (left.page !== right.page) return left.page - right.page
    const splitDefinitionOrder = splitNoteDefinitionOrder(left, right)
    if (splitDefinitionOrder !== null) return splitDefinitionOrder
    const inlineOrder = inlineStackedFragmentOrder(
      left.lines[0] ?? { id: undefined },
      right.lines[0] ?? { id: undefined },
    )
    if (inlineOrder !== null) return inlineOrder
    return (
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id)
    )
  })
  const readingOrder = buildReadingOrder(regions, layouts)
  return {
    regions,
    lineBoundaryDecisions,
    unresolvedCorruptingJoinCount: lineBoundaryDecisions.filter(
      (decision) =>
        decision.outcome === 'unresolved' || decision.outcome === 'ambiguous',
    ).length,
    readingOrder,
    repeatedMarginCount: furnitureAssessment.repeatedMarginCount,
    furnitureExcludedRunCount: furnitureAssessment.furnitureRuns.length,
    furnitureExcludedTextCharacters: furnitureAssessment.furnitureRuns.reduce(
      (total, { run }) => total + [...run.text].length,
      0,
    ),
    furnitureReviewCount: furnitureAssessment.reviewRuns.length,
    furnitureAssessment,
    ambiguousPages: [...layouts.entries()]
      .filter(([, layout]) => layout.ambiguous)
      .map(([page]) => page),
  }
}
