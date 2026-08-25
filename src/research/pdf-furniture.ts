import type {
  NormalizedSourceBox,
  PdfFurnitureBand,
  PdfFurnitureClassification,
  PdfFurnitureEvidence,
  PdfFurnitureReview,
  PdfPageAnalysis,
  PdfSourceRun,
} from './import-types'

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

export function normalizeMarginText(text: string) {
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

export function isQuarterTurn(rotation: number) {
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

export function sourceRunBox(run: PdfSourceRun): NormalizedSourceBox {
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

export function furnitureRunKey(run: PdfSourceRun) {
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

export function digitValue(character: string) {
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
    [0x10d40, 0x10d49],
    [0x11066, 0x1106f],
    [0x110f0, 0x110f9],
    [0x11136, 0x1113f],
    [0x111d0, 0x111d9],
    [0x112f0, 0x112f9],
    [0x11450, 0x11459],
    [0x114d0, 0x114d9],
    [0x11650, 0x11659],
    [0x116c0, 0x116c9],
    [0x116d0, 0x116d9],
    [0x116da, 0x116e3],
    [0x11730, 0x11739],
    [0x118e0, 0x118e9],
    [0x11950, 0x11959],
    [0x11bf0, 0x11bf9],
    [0x11c50, 0x11c59],
    [0x11d50, 0x11d59],
    [0x11da0, 0x11da9],
    [0x11de0, 0x11de9],
    [0x11f50, 0x11f59],
    [0x16130, 0x16139],
    [0x16a60, 0x16a69],
    [0x16ac0, 0x16ac9],
    [0x16b50, 0x16b59],
    [0x16d70, 0x16d79],
    [0x1ccf0, 0x1ccf9],
    [0x1d7ce, 0x1d7ff],
    [0x1e140, 0x1e149],
    [0x1e2f0, 0x1e2f9],
    [0x1e4f0, 0x1e4f9],
    [0x1e5f1, 0x1e5fa],
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

export function marginTextIsNumeralOnly(text: string) {
  return (
    marginNumericValues(text).length > 0 &&
    /^[\s.,:;()[\]{}+\-–—\p{N}ivxlcdm]+$/iu.test(text)
  )
}

export function firstPageTitleBlockRun(run: PdfSourceRun, bodyFontSize: number) {
  if (isQuarterTurn(run.rotation)) return false
  if (run.page !== 1 || run.y > 0.42) return false
  if (run.y < 0.08 && run.fontSize < bodyFontSize * 1.2 && run.width < 0.55) {
    return false
  }
  return (
    run.y >= 0.08 || run.width >= 0.28 || run.fontSize >= bodyFontSize * 0.92
  )
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
