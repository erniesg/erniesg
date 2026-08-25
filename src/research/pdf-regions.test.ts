import { strFromU8 } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { buildEpub } from './epub'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import {
  classifyPdfFurniture,
  hasAcceptedCycle,
  noteLabelFromText,
  pdfSourceColumnFlowJoinOutcome,
  reconstructPageRegions,
  splitRunBackedCrossGutterProse,
  sourceProvenDominantBaselineSequentialWrap,
  sourceInlineFractionPairs,
} from './pdf-regions'
import type { PdfFigureRasterizer } from './pdf-visuals'
import { createSourcePageCropAsset } from './visual-assets'

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
  height = 0.018,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text',
    fontName: fontSize > 12 ? 'Heading' : 'Body',
    fontSize,
    confidence: 1,
  }
}

function page(
  number: number,
  runs: PdfSourceRun[],
  objects: NonNullable<PdfPageAnalysis['objects']> = [],
): PdfPageAnalysis {
  return {
    page: number,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: objects.length,
    objects,
    runs,
  }
}

function detachedDisplayFractionAtomPage({
  atomText = 'h',
  atomFontName = 'Synthetic-LMRoman10-Bold',
  includeEquation = true,
  competingDenominator = false,
}: {
  atomText?: string
  atomFontName?: string
  includeEquation?: boolean
  competingDenominator?: boolean
} = {}) {
  const sourceRun = (
    text: string,
    x: number,
    y: number,
    width: number,
    fontName: string,
    sourceSequenceIndex: number,
    fontSize = 10.9091,
    height = 0.0129561758,
  ) => ({
    ...run(1, text, x, y, width, fontSize, height),
    fontName,
    sourceSequenceIndex,
  })
  const prose = [
    sourceRun(
      'Ordinary prose establishes the body font and page geometry.',
      0.14097,
      0.72,
      0.58,
      'Synthetic-NimbusRoman-Regular',
      120,
    ),
    sourceRun(
      'A second ordinary source line keeps the lower page band substantive.',
      0.14097,
      0.74,
      0.62,
      'Synthetic-NimbusRoman-Regular',
      122,
    ),
    sourceRun(
      'normalization function is given by',
      0.14097,
      0.7907965558,
      0.2515880752,
      'Synthetic-NimbusRoman-Regular',
      133,
    ),
  ]
  const atom = sourceRun(
    atomText,
    0.5526047731,
    0.8174477197,
    atomText === 'h' ? 0.0117158234 : 0.22,
    atomFontName,
    145,
  )
  if (!includeEquation) return page(1, [...prose, atom])

  const baseline = [
    sourceRun(
      'LNorm(',
      0.3686722689,
      0.8261412114,
      0.0640062118,
      'Synthetic-LMRoman10-Regular',
      135,
    ),
    sourceRun(
      'h',
      0.4326047059,
      0.8261412114,
      0.0117158234,
      'Synthetic-LMRoman10-Bold',
      136,
    ),
    sourceRun(
      ')',
      0.4443024538,
      0.8261412114,
      0.0071321679,
      'Synthetic-LMRoman10-Regular',
      137,
    ),
    sourceRun(
      '=',
      0.4683046739,
      0.8261412114,
      0.0142643358,
      'Synthetic-LMRoman10-Regular',
      139,
    ),
    sourceRun(
      'α',
      0.4993616134,
      0.8261412114,
      0.011734158,
      'Synthetic-LMMathItalic10-Regular',
      141,
    ),
    sourceRun(
      '·',
      0.515294521,
      0.8261412114,
      0.0050970249,
      'Synthetic-LMMathSymbols10-Regular',
      143,
    ),
  ]
  const denominator = [
    sourceRun(
      'σ',
      0.5263865546,
      0.8351198337,
      0.0104690691,
      'Synthetic-LMMathItalic10-Regular',
      147,
    ),
    sourceRun(
      'rms',
      0.5368736807,
      0.8406052019,
      0.0231522001,
      'Synthetic-LMRoman8-Regular',
      148,
      7.97011,
      0.0094656888,
    ),
    sourceRun(
      '+',
      0.5649074622,
      0.8351198337,
      0.0142643358,
      'Synthetic-LMRoman10-Regular',
      150,
    ),
    sourceRun(
      'ǫ',
      0.5832602353,
      0.8351198337,
      0.0074438565,
      'Synthetic-LMMathItalic10-Regular',
      152,
    ),
  ]
  const equationTail = [
    sourceRun(
      '+',
      0.5967732269,
      0.8261410214,
      0.0142643358,
      'Synthetic-LMRoman10-Regular',
      154,
    ),
    sourceRun(
      'β',
      0.615126,
      0.8261410214,
      0.010377396,
      'Synthetic-LMMathItalic10-Regular',
      156,
    ),
    sourceRun(
      '(2.24)',
      0.8099495294,
      0.8261410214,
      0.0440214271,
      'Synthetic-NimbusRoman-Regular',
      158,
    ),
  ]
  const competing = competingDenominator
    ? [
        sourceRun(
          'τ',
          0.5263865546,
          0.847,
          0.0104690691,
          'Synthetic-LMMathItalic10-Regular',
          149,
        ),
        sourceRun(
          '+ δ',
          0.541,
          0.847,
          0.0497,
          'Synthetic-LMMathItalic10-Regular',
          151,
        ),
      ]
    : []
  return page(1, [
    ...prose,
    ...baseline,
    atom,
    ...denominator,
    ...competing,
    ...equationTail,
  ])
}

function multiComponentUnderbracedDisplayPage({
  includeEquationNumber = true,
  competingEquationNumber = false,
  includeStackedStructure = true,
}: {
  includeEquationNumber?: boolean
  competingEquationNumber?: boolean
  includeStackedStructure?: boolean
} = {}) {
  const sourceRun = (
    text: string,
    x: number,
    y: number,
    width: number,
    fontName: string,
    sourceSequenceIndex: number,
    fontSize = 10.9,
    height = 0.013,
  ) => ({
    ...run(1, text, x, y, width, fontSize, height),
    fontName,
    sourceSequenceIndex,
  })
  const bodyFont = 'Synthetic-Serif-Regular'
  const romanFont = 'Synthetic-LMRoman10-Regular'
  const smallRomanFont = 'Synthetic-LMRoman8-Regular'
  const mathFont = 'Synthetic-LMMathItalic10-Regular'
  const extensionFont = 'Synthetic-LMMathExtension10-Regular'
  const prose = [
    sourceRun(
      'Ordinary prose establishes the page body font and geometry.',
      0.14,
      0.7,
      0.58,
      bodyFont,
      10,
    ),
    sourceRun(
      'A second ordinary line keeps the lower page band substantive.',
      0.14,
      0.72,
      0.58,
      bodyFont,
      12,
    ),
    sourceRun(
      'The bounded multi-part expression is',
      0.14,
      0.761,
      0.31,
      bodyFont,
      30,
    ),
  ]
  const anchor = [
    sourceRun('F', 0.282, 0.796, 0.012, mathFont, 40),
    sourceRun('(a, b)', 0.295, 0.796, 0.05, mathFont, 42),
    sourceRun('=', 0.365, 0.796, 0.014, romanFont, 44),
  ]
  const firstNumerator = [
    sourceRun('17', 0.417, 0.787, 0.018, romanFont, 46),
    sourceRun('.', 0.435, 0.787, 0.005, mathFont, 47),
    sourceRun('5', 0.44, 0.787, 0.009, romanFont, 48),
  ]
  const firstDenominator = [
    sourceRun('a', 0.417, 0.805, 0.014, mathFont, 50),
    sourceRun('0.31', 0.433, 0.805, 0.027, smallRomanFont, 52, 8, 0.0095),
    sourceRun('+', 0.483, 0.796, 0.014, romanFont, 64),
  ]
  const firstBrace = [
    sourceRun('︸', 0.415, 0.811, 0.008, extensionFont, 56, 10, 0.012),
    sourceRun('︷︷', 0.431, 0.811, 0.015, extensionFont, 58, 10, 0.012),
    sourceRun('︸', 0.454, 0.811, 0.008, extensionFont, 60, 10, 0.012),
  ]
  const firstLabel = sourceRun(
    'capacity term',
    0.396,
    0.825,
    0.084,
    smallRomanFont,
    62,
    8,
    0.0095,
  )
  const secondNumerator = [
    sourceRun('23', 0.526, 0.787, 0.018, romanFont, 66),
    sourceRun('.', 0.544, 0.787, 0.005, mathFont, 67),
    sourceRun('8', 0.549, 0.787, 0.009, romanFont, 68),
  ]
  const secondDenominator = [
    sourceRun('b', 0.526, 0.805, 0.014, mathFont, 70),
    sourceRun('0.27', 0.542, 0.805, 0.027, smallRomanFont, 72, 8, 0.0095),
  ]
  const secondBrace = [
    sourceRun('︸', 0.524, 0.811, 0.008, extensionFont, 75, 10, 0.012),
    sourceRun('︷︷', 0.539, 0.811, 0.015, extensionFont, 77, 10, 0.012),
    sourceRun('︸', 0.562, 0.811, 0.008, extensionFont, 79, 10, 0.012),
  ]
  const secondLabel = sourceRun(
    'data term',
    0.501,
    0.825,
    0.073,
    smallRomanFont,
    81,
    8,
    0.0095,
  )
  const tail = [
    sourceRun('+', 0.596, 0.796, 0.014, romanFont, 83),
    sourceRun('0', 0.647, 0.796, 0.009, romanFont, 85),
    sourceRun('.', 0.656, 0.796, 0.005, mathFont, 86),
    sourceRun('91', 0.661, 0.796, 0.018, romanFont, 87),
    sourceRun('︸', 0.647, 0.802, 0.008, extensionFont, 88, 10, 0.012),
    sourceRun('︷︷', 0.656, 0.802, 0.015, extensionFont, 89, 10, 0.012),
    sourceRun('︸', 0.672, 0.802, 0.008, extensionFont, 90, 10, 0.012),
    sourceRun('floor term', 0.613, 0.816, 0.08, smallRomanFont, 92, 8, 0.0095),
  ]
  const equationNumbers = [
    ...(includeEquationNumber
      ? [sourceRun('(7.4)', 0.81, 0.796, 0.044, bodyFont, 94)]
      : []),
    ...(competingEquationNumber
      ? [sourceRun('(7.5)', 0.81, 0.818, 0.044, bodyFont, 93)]
      : []),
  ]
  const nextProse = sourceRun(
    'The next paragraph must remain ordinary prose.',
    0.17,
    0.855,
    0.41,
    bodyFont,
    95,
  )

  return page(1, [
    ...prose,
    ...anchor,
    ...firstNumerator,
    ...(includeStackedStructure
      ? [
          ...firstDenominator,
          ...firstBrace,
          firstLabel,
          ...secondNumerator,
          ...secondDenominator,
          ...secondBrace,
          secondLabel,
          ...tail,
        ]
      : [
          sourceRun(
            'This decimal belongs to ordinary nearby prose.',
            0.417,
            0.787,
            0.29,
            bodyFont,
            46,
          ),
        ]),
    ...equationNumbers,
    nextProse,
  ])
}

function resolvedCrossColumnDisplayDecoyPage() {
  const sourceRun = (
    text: string,
    x: number,
    y: number,
    width: number,
    fontName: string,
    sourceSequenceIndex: number,
    fontSize = 10,
    height = 0.013,
  ) => ({
    ...run(1, text, x, y, width, fontSize, height),
    fontName,
    sourceSequenceIndex,
  })
  const bodyFont = 'Synthetic-Serif-Regular'
  const mathFont = 'Synthetic-LMMathItalic10-Regular'
  const romanFont = 'Synthetic-LMRoman10-Regular'
  const smallRomanFont = 'Synthetic-LMRoman8-Regular'
  const extensionFont = 'Synthetic-LMMathExtension10-Regular'
  const twoColumnProse = Array.from({ length: 10 }, (_, index) => {
    const y = 0.18 + index * 0.048
    return [
      sourceRun(
        `Left column sentence ${index + 1} remains independent.`,
        0.1,
        y,
        0.33,
        bodyFont,
        index * 4 + 1,
      ),
      sourceRun(
        `Right column sentence ${index + 1} remains independent.`,
        0.57,
        y,
        0.33,
        bodyFont,
        index * 4 + 3,
      ),
    ]
  }).flat()
  const leftColumnAnchor = sourceRun('G(x) =', 0.12, 0.796, 0.08, mathFont, 100)
  const rightColumnDisplay = [
    sourceRun('17.5', 0.62, 0.787, 0.04, romanFont, 102),
    sourceRun('a', 0.63, 0.805, 0.014, mathFont, 104),
    sourceRun('︸︷︷︸', 0.615, 0.811, 0.05, extensionFont, 106),
    sourceRun('capacity', 0.61, 0.825, 0.06, smallRomanFont, 108, 8, 0.0095),
    sourceRun('+', 0.68, 0.796, 0.014, romanFont, 110),
    sourceRun('23.8', 0.74, 0.787, 0.04, romanFont, 112),
    sourceRun('b', 0.75, 0.805, 0.014, mathFont, 114),
    sourceRun('︸︷︷︸', 0.735, 0.811, 0.05, extensionFont, 116),
    sourceRun('data', 0.74, 0.825, 0.04, smallRomanFont, 118, 8, 0.0095),
    sourceRun('+', 0.8, 0.796, 0.014, romanFont, 120),
    sourceRun('0.91', 0.83, 0.796, 0.04, romanFont, 122),
    sourceRun('︸︷︷︸', 0.825, 0.802, 0.05, extensionFont, 124),
    sourceRun('floor', 0.82, 0.816, 0.04, smallRomanFont, 126, 8, 0.0095),
    sourceRun('(7.4)', 0.91, 0.796, 0.04, bodyFont, 128),
  ]
  return page(1, [...twoColumnProse, leftColumnAnchor, ...rightColumnDisplay])
}

async function reconstruct(pages: PdfPageAnalysis[], hash = '7') {
  return reconstructPageAnalyses({
    pages,
    sourceHash: hash.repeat(64),
    fileName: 'regions.pdf',
    byteLength: 4096,
  })
}

describe('deterministic scholarly page regions', () => {
  it('uses the continuation script instead of the document language for column spacing', () => {
    const continuationRun = run(1, 'the model', 0.5, 0.2, 0.12)
    continuationRun.sourceSequenceIndex = 2

    expect(
      pdfSourceColumnFlowJoinOutcome('zh', 'the model', continuationRun),
    ).toEqual({ outcome: 'space', separator: ' ' })
    expect(
      pdfSourceColumnFlowJoinOutcome('zh', '模型', continuationRun),
    ).toEqual({ outcome: 'no-space', separator: '' })
    expect(
      pdfSourceColumnFlowJoinOutcome('zh', '2024年的结果', continuationRun),
    ).toEqual({ outcome: 'no-space', separator: '' })
  })

  it('keeps a source-bracketed bold fraction atom out of its preceding prose region', () => {
    const sourcePage = detachedDisplayFractionAtomPage()
    const result = reconstructPageRegions([sourcePage])
    const replay = reconstructPageRegions([
      { ...sourcePage, runs: [...sourcePage.runs].reverse() },
    ])
    const atomRegion = result.regions.find((region) =>
      region.lines.some((line) =>
        line.runs.some((candidate) => candidate.sourceSequenceIndex === 145),
      ),
    )
    const cueRegion = result.regions.find((region) =>
      region.text.includes('normalization function is given by'),
    )

    expect(atomRegion).toMatchObject({ kind: 'equation' })
    expect(atomRegion?.text).toContain('h')
    expect(
      atomRegion?.lines.some((line) =>
        line.runs.some((candidate) => candidate.sourceSequenceIndex === 147),
      ),
    ).toBe(true)
    expect(atomRegion?.id).not.toBe(cueRegion?.id)
    expect(cueRegion?.text).toBe('normalization function is given by')
    expect(
      replay.regions.find((region) =>
        region.lines.some((line) =>
          line.runs.some((candidate) => candidate.sourceSequenceIndex === 145),
        ),
      ),
    ).toMatchObject({ kind: 'equation' })
  })

  it.each([
    {
      name: 'ordinary final letter',
      sourcePage: detachedDisplayFractionAtomPage({
        atomFontName: 'Synthetic-LMRoman10-Regular',
      }),
      expectedContinuation: 'h',
    },
    {
      name: 'true prose continuation',
      sourcePage: detachedDisplayFractionAtomPage({
        atomText: 'a valid ordinary continuation.',
        atomFontName: 'Synthetic-LMRoman10-Bold',
      }),
      expectedContinuation: 'a valid ordinary continuation.',
    },
    {
      name: 'no nearby equation',
      sourcePage: detachedDisplayFractionAtomPage({
        includeEquation: false,
      }),
      expectedContinuation: 'h',
    },
    {
      name: 'ambiguous competing equations',
      sourcePage: detachedDisplayFractionAtomPage({
        competingDenominator: true,
      }),
      expectedContinuation: 'h',
    },
  ])(
    'does not infer a detached display atom for a $name',
    ({ sourcePage, expectedContinuation }) => {
      const result = reconstructPageRegions([sourcePage])
      const cueRegion = result.regions.find((region) =>
        region.text.includes('normalization function is given by'),
      )

      expect(cueRegion?.text).toContain(expectedContinuation)
      expect(
        cueRegion?.lines.some((line) =>
          line.runs.some((candidate) => candidate.sourceSequenceIndex === 145),
        ),
      ).toBe(true)
    },
  )

  it('owns a source-bounded multi-fraction underbraced display as one equation region', () => {
    const sourcePage = multiComponentUnderbracedDisplayPage()
    const result = reconstructPageRegions([sourcePage])
    const replay = reconstructPageRegions([
      { ...sourcePage, runs: [...sourcePage.runs].reverse() },
    ])
    const expectedSourceSequenceIndexes = [
      40, 42, 44, 46, 47, 48, 50, 52, 56, 58, 60, 62, 64, 66, 67, 68, 70, 72,
      75, 77, 79, 81, 83, 85, 86, 87, 88, 89, 90, 92, 94,
    ]
    const regionForSourceSequence = (
      regions: typeof result.regions,
      sourceSequenceIndex: number,
    ) =>
      regions.find((region) =>
        region.lines.some((line) =>
          line.runs.some(
            (candidate) =>
              candidate.sourceSequenceIndex === sourceSequenceIndex,
          ),
        ),
      )
    const owners = expectedSourceSequenceIndexes.map((sourceSequenceIndex) =>
      regionForSourceSequence(result.regions, sourceSequenceIndex),
    )
    const replayOwners = expectedSourceSequenceIndexes.map(
      (sourceSequenceIndex) =>
        regionForSourceSequence(replay.regions, sourceSequenceIndex),
    )
    const cueRegion = regionForSourceSequence(result.regions, 30)
    const nextProseRegion = regionForSourceSequence(result.regions, 95)

    expect(owners.every((owner) => owner?.kind === 'equation')).toBe(true)
    expect(new Set(owners.map((owner) => owner?.id))).toHaveLength(1)
    expect(replayOwners.every((owner) => owner?.kind === 'equation')).toBe(true)
    expect(new Set(replayOwners.map((owner) => owner?.id))).toHaveLength(1)
    expect(cueRegion?.text).toBe('The bounded multi-part expression is')
    expect(cueRegion?.kind).not.toBe('equation')
    expect(nextProseRegion?.text).toBe(
      'The next paragraph must remain ordinary prose.',
    )
    expect(nextProseRegion?.kind).not.toBe('equation')
  })

  it.each([
    {
      name: 'missing right-edge equation number',
      sourcePage: multiComponentUnderbracedDisplayPage({
        includeEquationNumber: false,
      }),
      sourceSequenceIndex: 46,
    },
    {
      name: 'ambiguous competing equation numbers',
      sourcePage: multiComponentUnderbracedDisplayPage({
        competingEquationNumber: true,
      }),
      sourceSequenceIndex: 46,
    },
    {
      name: 'ordinary nearby decimal without stacked structure',
      sourcePage: multiComponentUnderbracedDisplayPage({
        includeStackedStructure: false,
      }),
      sourceSequenceIndex: 46,
    },
  ])(
    'does not infer a multi-component display cluster for $name',
    ({ sourcePage, sourceSequenceIndex }) => {
      const result = reconstructPageRegions([sourcePage])
      const candidateRegion = result.regions.find((region) =>
        region.lines.some((line) =>
          line.runs.some(
            (candidate) =>
              candidate.sourceSequenceIndex === sourceSequenceIndex,
          ),
        ),
      )

      expect(candidateRegion?.kind).not.toBe('equation')
    },
  )

  it('does not bridge a resolved column gutter from an unnumbered equation anchor to a numbered display', () => {
    const result = reconstructPageRegions([
      resolvedCrossColumnDisplayDecoyPage(),
    ])
    const regionForSourceSequence = (sourceSequenceIndex: number) =>
      result.regions.find((region) =>
        region.lines.some((line) =>
          line.runs.some(
            (candidate) =>
              candidate.sourceSequenceIndex === sourceSequenceIndex,
          ),
        ),
      )
    const anchorRegion = regionForSourceSequence(100)
    const numberedDisplayRegion = regionForSourceSequence(128)

    expect(result.readingOrder.resolutions).toContainEqual(
      expect.objectContaining({
        page: 1,
        status: 'resolved',
        ambiguityClass: 'sparse-column-gutter',
      }),
    )
    expect(anchorRegion).toMatchObject({
      kind: 'equation',
      column: 'left',
    })
    expect(numberedDisplayRegion?.column).toBe('right')
    expect(numberedDisplayRegion?.id).not.toBe(anchorRegion?.id)
  })

  it('uses the dominant prose baseline to prove a sequential wrap hidden by a stacked-math envelope', () => {
    const previousRuns = [
      {
        ...run(1, 'The aggregate formula', 0.1, 0.3, 0.22),
        sourceSequenceIndex: 10,
      },
      {
        ...run(1, 'x', 0.33, 0.3, 0.012),
        fontName: 'Synthetic-Math',
        sourceSequenceIndex: 11,
      },
      {
        ...run(1, 'i', 0.342, 0.282, 0.007, 7, 0.01),
        fontName: 'Synthetic-Math',
        sourceSequenceIndex: 12,
      },
      {
        ...run(1, 'j', 0.342, 0.323, 0.007, 7, 0.01),
        fontName: 'Synthetic-Math',
        sourceSequenceIndex: 13,
      },
    ]
    const nextRun = {
      ...run(1, 'continues on the next ordinary baseline.', 0.1, 0.325, 0.48),
      sourceSequenceIndex: 14,
      sourceWhitespaceBefore: 'pdf-text-item' as const,
      sourceWhitespacePredecessorIndex: 13,
    }

    expect(
      sourceProvenDominantBaselineSequentialWrap(
        {
          page: 1,
          text: 'The aggregate formula xij',
          x: 0.1,
          y: 0.282,
          width: 0.249,
          height: 0.051,
          fontSize: 10,
          runs: previousRuns,
          column: 'single',
        },
        {
          page: 1,
          text: nextRun.text,
          x: nextRun.x,
          y: nextRun.y,
          width: nextRun.width,
          height: nextRun.height,
          fontSize: nextRun.fontSize,
          runs: [nextRun],
          column: 'single',
        },
      ),
    ).toBe(true)
  })

  it('does not infer a dominant-baseline wrap from an ambiguous source sequence boundary', () => {
    const duplicateTail = [
      {
        ...run(1, 'Aggregate formula', 0.1, 0.3, 0.2),
        sourceSequenceIndex: 20,
      },
      {
        ...run(1, 'x', 0.31, 0.3, 0.012),
        fontName: 'Synthetic-Math',
        sourceSequenceIndex: 21,
      },
      {
        ...run(1, 'y', 0.323, 0.323, 0.007, 7, 0.01),
        fontName: 'Synthetic-Math',
        sourceSequenceIndex: 21,
      },
    ]
    const nextRun = {
      ...run(1, 'continues ambiguously.', 0.1, 0.325, 0.35),
      sourceSequenceIndex: 22,
      sourceWhitespaceBefore: 'pdf-text-item' as const,
      sourceWhitespacePredecessorIndex: 21,
    }

    expect(
      sourceProvenDominantBaselineSequentialWrap(
        {
          page: 1,
          text: 'Aggregate formula xy',
          x: 0.1,
          y: 0.3,
          width: 0.23,
          height: 0.033,
          fontSize: 10,
          runs: duplicateTail,
          column: 'single',
        },
        {
          page: 1,
          text: nextRun.text,
          x: nextRun.x,
          y: nextRun.y,
          width: nextRun.width,
          height: nextRun.height,
          fontSize: nextRun.fontSize,
          runs: [nextRun],
          column: 'single',
        },
      ),
    ).toBe(false)
  })

  it('records exact left and right fragment lineage when splitting a run-backed gutter line', () => {
    const leftRun = {
      ...run(1, 'Left fragment remains readable', 0.08, 0.4, 0.34),
      sourceSequenceIndex: 30,
    }
    const rightRun = {
      ...run(1, 'Right fragment continues onward', 0.56, 0.4, 0.34),
      sourceSequenceIndex: 31,
    }
    const fragments = splitRunBackedCrossGutterProse(
      [
        {
          id: 'run-backed-cross-gutter-line',
          page: 1,
          text: `${leftRun.text} ${rightRun.text}`,
          x: leftRun.x,
          y: leftRun.y,
          width: rightRun.x + rightRun.width - leftRun.x,
          height: leftRun.height,
          fontSize: leftRun.fontSize,
          runs: [leftRun, rightRun],
          column: 'single',
          kind: 'body',
          confidence: 1,
          noteLabel: null,
        },
      ],
      {
        split: 0.5,
        accepted: true,
        ambiguous: false,
        resolution: null,
      },
    ).sort((left, right) => left.id.localeCompare(right.id))

    expect(fragments).toHaveLength(2)
    expect(fragments.map((line) => line.sourceFragmentLineage)).toEqual([
      {
        algorithm: 'source-run-fragment-v1',
        sourceLineId: expect.any(String),
        fragment: 'cross-gutter-left',
        sourceSequenceIndexes: [30],
      },
      {
        algorithm: 'source-run-fragment-v1',
        sourceLineId: expect.any(String),
        fragment: 'cross-gutter-right',
        sourceSequenceIndexes: [31],
      },
    ])
    expect(fragments[0].sourceFragmentLineage?.sourceLineId).toBe(
      fragments[1].sourceFragmentLineage?.sourceLineId,
    )
  })

  it('does not mistake a numeric stacked fraction beside a base for paired scripts', () => {
    const base = {
      ...run(1, '1', 0.1, 0.5, 0.01, 10, 0.014),
      fontName: 'Synthetic-CMR10',
    }
    const numerator = {
      ...run(1, '1', 0.111, 0.494, 0.006, 7, 0.009),
      fontName: 'Synthetic-CMR7',
    }
    const denominator = {
      ...run(1, '2', 0.111, 0.507, 0.006, 7, 0.009),
      fontName: 'Synthetic-CMR7',
    }

    expect(
      sourceInlineFractionPairs({
        id: 'mixed-number-fraction-line',
        page: 1,
        text: '112',
        x: 0.1,
        y: 0.494,
        width: 0.017,
        height: 0.022,
        fontSize: 10,
        column: 'single',
        runs: [base, numerator, denominator],
      }),
    ).toEqual([[numerator, denominator]])
  })

  it.each([
    { baseText: '2', numeratorText: 'x', denominatorText: 'y' },
    { baseText: 'a', numeratorText: 'b', denominatorText: 'c' },
  ])(
    'keeps $baseText $numeratorText/$denominatorText as an ambiguous two-dimensional formula',
    ({ baseText, numeratorText, denominatorText }) => {
      const base = {
        ...run(1, baseText, 0.1, 0.5, 0.01, 10, 0.014),
        fontName: 'Synthetic-CMMI10',
      }
      const numerator = {
        ...run(1, numeratorText, 0.111, 0.494, 0.006, 7, 0.009),
        fontName: 'Synthetic-CMMI7',
      }
      const denominator = {
        ...run(1, denominatorText, 0.111, 0.507, 0.006, 7, 0.009),
        fontName: 'Synthetic-CMMI7',
      }

      expect(
        sourceInlineFractionPairs({
          id: 'mixed-variable-fraction-line',
          page: 1,
          text: `${baseText}${numeratorText}${denominatorText}`,
          x: 0.1,
          y: 0.494,
          width: 0.017,
          height: 0.022,
          fontSize: 10,
          column: 'single',
          runs: [base, numerator, denominator],
        }),
      ).toEqual([[numerator, denominator]])
    },
  )

  it('keeps identical two-page geometry page-local and globally unique in the reading graph', () => {
    const twoColumnRuns = (pageNumber: number, label: string) => [
      run(pageNumber, `${label} left row one.`, 0.08, 0.2, 0.35),
      run(pageNumber, `${label} right row one.`, 0.56, 0.2, 0.35),
      run(pageNumber, `${label} left row two.`, 0.08, 0.28, 0.35),
      run(pageNumber, `${label} right row two.`, 0.56, 0.28, 0.35),
      run(pageNumber, `${label} left row three.`, 0.08, 0.36, 0.35),
      run(pageNumber, `${label} right row three.`, 0.56, 0.36, 0.35),
      run(pageNumber, `${label} left row four.`, 0.08, 0.44, 0.35),
      run(pageNumber, `${label} right row four.`, 0.56, 0.44, 0.35),
    ]
    const result = reconstructPageRegions([
      page(1, twoColumnRuns(1, 'First page')),
      page(2, twoColumnRuns(2, 'Second page')),
    ])
    const regionIds = result.regions.map((region) => region.id)
    const lineIds = result.regions.flatMap((region) =>
      region.lines.map((sourceLine) => sourceLine.id),
    )
    const includedIds = result.regions
      .filter((region) => region.includedInReadingOrder)
      .map((region) => region.id)

    expect(new Set(regionIds).size).toBe(regionIds.length)
    expect(new Set(lineIds).size).toBe(lineIds.length)
    expect(result.regions.filter((region) => region.page === 1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.stringMatching(/^page-001-/) }),
      ]),
    )
    expect(result.regions.filter((region) => region.page === 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.stringMatching(/^page-002-/) }),
      ]),
    )
    expect(new Set(result.readingOrder.order)).toEqual(new Set(includedIds))
    expect(result.readingOrder.order).toHaveLength(includedIds.length)
    expect(result.readingOrder.resolutions).toHaveLength(2)
    for (const resolution of result.readingOrder.resolutions) {
      expect(resolution.regionIds.length).toBeGreaterThan(0)
      expect(
        resolution.regionIds.every(
          (regionId) =>
            result.regions.find((region) => region.id === regionId)?.page ===
            resolution.page,
        ),
      ).toBe(true)
    }
    for (const edge of result.readingOrder.edges) {
      expect(
        regionIds.filter((regionId) => regionId === edge.from),
      ).toHaveLength(1)
      expect(regionIds.filter((regionId) => regionId === edge.to)).toHaveLength(
        1,
      )
    }
  })

  it('keeps a proved inline before-formula-after source unit atomic across column and span lanes', () => {
    let sourceSequenceIndex = 0
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      fontSize = 12,
      height = 0.014,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
      sourceSequenceIndex: sourceSequenceIndex++,
    })
    const sourceRuns = [
      sourceRun('Left layout row one.', 0.08, 0.1, 0.36, 'Synthetic-CMR12'),
      sourceRun('Right layout row one.', 0.56, 0.1, 0.36, 'Synthetic-CMR12'),
      sourceRun('Left layout row two.', 0.08, 0.16, 0.36, 'Synthetic-CMR12'),
      sourceRun('Right layout row two.', 0.56, 0.16, 0.36, 'Synthetic-CMR12'),
      sourceRun('Left layout row three.', 0.08, 0.22, 0.36, 'Synthetic-CMR12'),
      sourceRun('Right layout row three.', 0.56, 0.22, 0.36, 'Synthetic-CMR12'),
      sourceRun('where', 0.1, 0.7, 0.05, 'Synthetic-CMR12'),
      sourceRun('S', 0.16, 0.7, 0.012, 'Synthetic-CMMI12'),
      sourceRun('′', 0.173, 0.6996, 0.004, 'Synthetic-CMSY8', 8, 0.009),
      sourceRun('k', 0.172, 0.7084, 0.007, 'Synthetic-CMMI8', 8, 0.009),
      sourceRun('=', 0.186, 0.7, 0.015, 'Synthetic-CMR12'),
      sourceRun('S', 0.207, 0.7, 0.012, 'Synthetic-CMMI12'),
      sourceRun('′', 0.22, 0.6996, 0.004, 'Synthetic-CMSY8', 8, 0.009),
      sourceRun('(', 0.225, 0.7, 0.008, 'Synthetic-CMR12'),
      sourceRun('x', 0.233, 0.7, 0.011, 'Synthetic-CMMI12'),
      sourceRun('k', 0.245, 0.6996, 0.007, 'Synthetic-CMMI8', 8, 0.009),
      sourceRun('t', 0.245, 0.7084, 0.005, 'Synthetic-CMMI8', 8, 0.009),
      sourceRun(
        '). The first term follows.',
        0.255,
        0.7,
        0.64,
        'Synthetic-CMR12',
      ),
      sourceRun(
        'The explanation continues across the page.',
        0.1,
        0.72,
        0.795,
        'Synthetic-CMR12',
      ),
      sourceRun('methods [42].', 0.1, 0.74, 0.12, 'Synthetic-CMR12'),
    ]
    const reconstructFragments = (runs: PdfSourceRun[]) => {
      const result = reconstructPageRegions([page(1, runs)])
      const fragmentRegions = result.regions.filter((region) =>
        region.lines.some((line) => /-inline-stacked-\d+-/u.test(line.id)),
      )
      const orderedFragmentParts = result.readingOrder.order.flatMap(
        (regionId) => {
          const region = fragmentRegions.find(
            (candidate) => candidate.id === regionId,
          )
          return (
            region?.lines.flatMap(
              (line) =>
                /-inline-stacked-\d+-(before|formula|after)$/u.exec(
                  line.id,
                )?.[1] ?? [],
            ) ?? []
          )
        },
      )
      return { result, fragmentRegions, orderedFragmentParts }
    }

    const first = reconstructFragments(sourceRuns)
    const replay = reconstructFragments([...sourceRuns].reverse())
    const fragmentColumnByPart = Object.fromEntries(
      first.fragmentRegions.flatMap((region) =>
        region.lines.flatMap((line) => {
          const part = /-inline-stacked-\d+-(before|formula|after)$/u.exec(
            line.id,
          )?.[1]
          return part ? [[part, region.column]] : []
        }),
      ),
    )
    expect(fragmentColumnByPart).toEqual({
      before: 'left',
      formula: 'left',
      after: 'span',
    })
    expect(first.orderedFragmentParts).toEqual(['before', 'formula', 'after'])
    expect(replay.orderedFragmentParts).toEqual(first.orderedFragmentParts)
    const orderedFragmentRegionIds = first.result.readingOrder.order.filter(
      (regionId) =>
        first.fragmentRegions.some((region) => region.id === regionId),
    )
    const orderedIndexes = orderedFragmentRegionIds.map((regionId) =>
      first.result.readingOrder.order.indexOf(regionId),
    )
    expect(orderedIndexes).toEqual([
      orderedIndexes[0],
      orderedIndexes[0] + 1,
      orderedIndexes[0] + 2,
    ])
    const outputSourceSequenceIndexes = first.result.regions.flatMap((region) =>
      region.lines.flatMap((line) =>
        line.runs.flatMap((source) =>
          source.sourceSequenceIndex === undefined
            ? []
            : [source.sourceSequenceIndex],
        ),
      ),
    )
    expect(
      outputSourceSequenceIndexes.sort((left, right) => left - right),
    ).toEqual(sourceRuns.map((source) => source.sourceSequenceIndex))
  })

  it('rejects a mixed note and flow inline unit so notes remain after body', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      fontSize = 10,
      height = 0.014,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
    })
    const result = reconstructPageRegions([
      page(1, [
        sourceRun(
          'Ordinary body line one establishes font size.',
          0.1,
          0.2,
          0.6,
          'Synthetic-CMR14',
          14,
          0.018,
        ),
        sourceRun(
          'Ordinary body line two remains before the note.',
          0.1,
          0.25,
          0.6,
          'Synthetic-CMR14',
          14,
          0.018,
        ),
        sourceRun('1 This note explains', 0.1, 0.8, 0.12, 'Synthetic-CMR10'),
        sourceRun('S', 0.23, 0.8, 0.012, 'Synthetic-CMMI10'),
        sourceRun('′', 0.243, 0.7996, 0.004, 'Synthetic-CMSY7', 7, 0.009),
        sourceRun('k', 0.242, 0.8084, 0.007, 'Synthetic-CMMI7', 7, 0.009),
        sourceRun('=', 0.256, 0.8, 0.015, 'Synthetic-CMR10'),
        sourceRun('S', 0.277, 0.8, 0.012, 'Synthetic-CMMI10'),
        sourceRun('′', 0.29, 0.7996, 0.004, 'Synthetic-CMSY7', 7, 0.009),
        sourceRun('(', 0.295, 0.8, 0.008, 'Synthetic-CMR10'),
        sourceRun('x', 0.303, 0.8, 0.011, 'Synthetic-CMMI10'),
        sourceRun('k', 0.315, 0.7996, 0.007, 'Synthetic-CMMI7', 7, 0.009),
        sourceRun('t', 0.315, 0.8084, 0.005, 'Synthetic-CMMI7', 7, 0.009),
        sourceRun(
          '). and continues after math.',
          0.325,
          0.8,
          0.3,
          'Synthetic-CMR10',
        ),
        sourceRun(
          'A final body paragraph lies geometrically below the note.',
          0.1,
          0.86,
          0.6,
          'Synthetic-CMR14',
          14,
          0.018,
        ),
      ]),
    ])
    const fragmentKinds = Object.fromEntries(
      result.regions.flatMap((region) =>
        region.lines.flatMap((line) => {
          const part = /-inline-stacked-\d+-(before|formula|after)$/u.exec(
            line.id,
          )?.[1]
          return part ? [[part, region.kind]] : []
        }),
      ),
    )
    expect(fragmentKinds).toEqual({
      before: 'footnote',
      formula: 'equation',
      after: 'body',
    })

    const orderedRegions = result.readingOrder.order.map((regionId) =>
      result.regions.find((region) => region.id === regionId)!,
    )
    const firstNoteIndex = orderedRegions.findIndex(
      (region) => region.kind === 'footnote' || region.kind === 'endnote',
    )
    expect(firstNoteIndex).toBeGreaterThan(-1)
    expect(
      orderedRegions
        .slice(firstNoteIndex)
        .every(
          (region) => region.kind === 'footnote' || region.kind === 'endnote',
        ),
    ).toBe(true)
    expect(
      orderedRegions.findIndex((region) =>
        region.text.includes('A final body paragraph'),
      ),
    ).toBeLessThan(firstNoteIndex)
  })

  it('classifies bounded supplementary and compound visual captions', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Figure A1. Supplementary figure.', 0.1, 0.2, 0.62, 9),
        run(1, 'Table A.1: Appendix table.', 0.1, 0.4, 0.62, 9),
        run(1, 'Equation B-2. Appendix equation.', 0.1, 0.6, 0.62, 9),
      ]),
    ])

    expect(
      result.regions.map((region) => ({
        kind: region.kind,
        text: region.text,
      })),
    ).toEqual([
      { kind: 'caption', text: 'Figure A1. Supplementary figure.' },
      { kind: 'caption', text: 'Table A.1: Appendix table.' },
      { kind: 'caption', text: 'Equation B-2. Appendix equation.' },
    ])
  })

  it('classifies a visual caption that follows a short embedded diagram label', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(
          1,
          'UMAP of model representations Figure 2. VISION models converge as COMPETENCE increases.',
          0.1,
          0.2,
          0.72,
          9,
        ),
      ]),
    ])

    expect(result.regions).toEqual([
      expect.objectContaining({
        kind: 'caption',
        text: 'UMAP of model representations Figure 2. VISION models converge as COMPETENCE increases.',
      }),
    ])
  })

  it('classifies a typography-delimited caption without printed punctuation', () => {
    const labelPrefix = {
      ...run(1, 'Fig.', 0.2, 0.3, 0.026, 8),
      fontName: 'Georgia-Bold',
    }
    const labelOrdinal = {
      ...run(1, '1', 0.232, 0.3, 0.008, 8),
      fontName: 'Georgia-Bold',
    }
    const caption = {
      ...run(
        1,
        'Core risk mitigation strategies in distributed systems.',
        0.25,
        0.3,
        0.42,
        8,
      ),
      fontName: 'BookmanOldStyle',
    }
    const result = reconstructPageRegions([
      page(1, [labelPrefix, labelOrdinal, caption]),
    ])

    expect(result.regions).toEqual([
      expect.objectContaining({
        kind: 'caption',
        includedInReadingOrder: true,
        text: 'Fig. 1 Core risk mitigation strategies in distributed systems.',
      }),
    ])
    expect(result.readingOrder.order).toEqual([result.regions[0].id])
  })

  it('recognizes an attached symbolic footnote marker', () => {
    expect(noteLabelFromText('*Work done during the internship.')).toBe('*')
  })

  it('normalizes a TeX math asterisk used as an author-note marker', () => {
    expect(noteLabelFromText('∗daedalusrsch@gmail.com')).toBe('*')
  })

  it('keeps a numbered first-page Introduction heading out of sparse-page note detection', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Mechanistic Addition in Language Models', 0.1, 0.11, 0.72, 18),
        run(1, 'Ada Example', 0.1, 0.15, 0.24, 11),
        run(1, '1 Introduction', 0.1, 0.24, 0.35, 13),
        run(
          1,
          'Large language models display surprising mathematical aptitude.',
          0.1,
          0.31,
          0.72,
          10,
        ),
      ]),
    ])

    expect(
      result.regions.find((region) => region.text === '1 Introduction'),
    ).toMatchObject({ kind: 'body' })
    expect(
      result.paper.nodes.find(
        (node) => 'text' in node && node.text === '1 Introduction',
      ),
    ).toMatchObject({ type: 'heading' })
  })

  it('keeps a hierarchical later-page section heading out of sparse-page note detection', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Opening prose establishes the document.', 0.1, 0.2, 0.72, 10),
      ]),
      page(2, [
        run(2, 'Experimental Analysis', 0.1, 0.11, 0.72, 18),
        {
          ...run(2, '3.2 Draft Module', 0.1, 0.24, 0.35, 13),
          bold: true,
        },
        run(
          2,
          'The module composes each prompt in deterministic order.',
          0.1,
          0.31,
          0.72,
          10,
        ),
      ]),
    ])

    expect(
      result.regions.find((region) => region.text === '3.2 Draft Module'),
    ).toMatchObject({ kind: 'body' })
    expect(
      result.paper.nodes.find(
        (node) => 'text' in node && node.text === '3.2 Draft Module',
      ),
    ).toMatchObject({ type: 'heading' })
  })

  it('keeps a small-font emphasized boundary heading out of chart-label classification', async () => {
    const body = (text: string, y: number) =>
      run(1, text, 0.1, y, 0.78, 10, 0.014)
    const references = {
      ...run(1, 'REFERENCES', 0.1, 0.48, 0.12, 8, 0.011),
      bold: true,
      fontName: 'LinBiolinumTB',
    }
    const result = await reconstruct([
      page(1, [
        body('The opening paragraph establishes the main body size.', 0.12),
        body('A second ordinary line keeps that body size dominant.', 0.14),
        body('A third ordinary line precedes the closing material.', 0.16),
        body('Acknowledgement prose ends before the reference section.', 0.43),
        references,
        run(
          1,
          '[1] Ada Example. A source-backed bibliography entry.',
          0.115,
          0.51,
          0.7,
          8,
          0.011,
        ),
      ]),
    ])

    expect(
      result.regions.find((region) => region.text === 'REFERENCES'),
    ).toMatchObject({ kind: 'body' })
    expect(
      result.paper.nodes.find(
        (node) => 'text' in node && node.text === 'REFERENCES',
      ),
    ).toMatchObject({ type: 'heading' })
  })

  it('does not let a script-expanded line envelope erase a paragraph break', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'First paragraph remains separate.', 0.1, 0.2, 0.5, 10, 0.018),
        run(1, 'Inline formula H', 0.1, 0.242, 0.16, 10, 0.018),
        run(1, '2', 0.26, 0.252, 0.008, 6, 0.014),
        run(1, 'O remains readable.', 0.268, 0.242, 0.2, 10, 0.018),
      ]),
    ])

    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph')
        .map((node) => node.text),
    ).toEqual([
      'First paragraph remains separate.',
      expect.stringContaining('Inline formula H'),
    ])
  })

  const spanningInlineMathWrapPage = ({
    continuationText = 'correlation remains bounded.',
    predecessorTerminal = false,
    leading = 0.003,
    continuationSequence = 303,
    duplicateBoundarySequence = false,
    continuationMethod = 'pdf-text' as PdfSourceRun['method'],
    continuationRotation = 0,
  } = {}) => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      sourceSequenceIndex: number,
    ) => ({
      ...run(1, text, x, y, width, 10, 0.014),
      sourceSequenceIndex,
    })
    const spanningY = 0.4
    const continuation = {
      ...sourceRun(
        continuationText,
        0.1,
        spanningY + 0.014 + leading,
        0.2,
        continuationSequence,
      ),
      method: continuationMethod,
      rotation: continuationRotation,
    }
    return page(1, [
      run(1, 'Left column establishes the layout.', 0.1, 0.12, 0.34),
      run(1, 'Right column establishes the layout.', 0.56, 0.12, 0.34),
      run(1, 'Left column continues independently.', 0.1, 0.16, 0.34),
      run(1, 'Right column continues independently.', 0.56, 0.16, 0.34),
      run(1, 'Left column supplies a third row.', 0.1, 0.2, 0.34),
      run(1, 'Right column supplies a third row.', 0.56, 0.2, 0.34),
      sourceRun(
        'A coupled stochastic process',
        0.1,
        spanningY,
        0.2,
        duplicateBoundarySequence ? 302 : 300,
      ),
      {
        ...sourceRun('θ = x + y', 0.302, spanningY, 0.1, 301),
        fontName: 'Synthetic-Math-Italic',
        italic: true,
      },
      sourceRun(
        `, and remains stable under measured drift${predecessorTerminal ? '.' : ''}`,
        0.404,
        spanningY,
        0.476,
        302,
      ),
      continuation,
    ])
  }

  it('reclassifies a uniquely source-adjacent short lowercase wrap as its spanning inline-math continuation', async () => {
    const result = await reconstruct([spanningInlineMathWrapPage()])
    const expected =
      'A coupled stochastic process θ = x + y, and remains stable under measured drift correlation remains bounded.'
    const sourceParagraph = result.regions.find((region) =>
      region.lines.some((line) =>
        line.runs.some((sourceRun) => sourceRun.sourceSequenceIndex === 300),
      ),
    )

    expect(sourceParagraph).toMatchObject({
      kind: 'spanning',
      column: 'span',
      text: expected,
    })
    expect(sourceParagraph?.lines).toHaveLength(2)
    expect(
      result.paper.nodes.filter(
        (node) => node.type === 'paragraph' && node.text === expected,
      ),
    ).toHaveLength(1)
  })

  it.each([
    ['blank leading', { leading: 0.02 }],
    ['excessive leading', { leading: 0.06 }],
    ['sentence-terminal predecessor', { predecessorTerminal: true }],
    ['duplicate boundary sequence', { duplicateBoundarySequence: true }],
    ['nonadjacent source sequence', { continuationSequence: 305 }],
    ['extraction-method mismatch', { continuationMethod: 'ocr' as const }],
    ['rotation mismatch', { continuationRotation: 90 }],
    [
      'uppercase structural continuation',
      { continuationText: 'Correlation Overview' },
    ],
  ])(
    'does not reclassify a spanning inline-math wrap with %s',
    async (_label, options) => {
      const result = await reconstruct([spanningInlineMathWrapPage(options)])
      const sourceParagraph = result.regions.find((region) =>
        region.lines.some((line) =>
          line.runs.some((sourceRun) => sourceRun.sourceSequenceIndex === 301),
        ),
      )
      const continuation = result.regions.find((region) =>
        region.lines.some((line) =>
          line.runs.some((sourceRun) => {
            const continuationText =
              'continuationText' in options
                ? options.continuationText
                : 'correlation remains bounded.'
            return sourceRun.text === continuationText
          }),
        ),
      )

      expect(sourceParagraph).toMatchObject({
        kind: 'spanning',
        column: 'span',
      })
      expect(continuation?.id).not.toBe(sourceParagraph?.id)
      expect(continuation).toMatchObject({
        kind: 'body',
        column: 'left',
      })
    },
  )

  it('preserves flush-left authored paragraphs separated by blank leading', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(
          1,
          'Humans naturally expend more mental effort solving some',
          0.1,
          0.2,
          0.52,
          10,
          0.0126,
        ),
        run(
          1,
          'problems than others while reasoning continuously.',
          0.1,
          0.2151,
          0.5,
          10,
          0.0126,
        ),
        run(
          1,
          'Early attempts instead scaled the model parameters.',
          0.1,
          0.2377,
          0.49,
          10,
          0.0126,
        ),
        run(
          1,
          'More recent systems scale their test-time computation.',
          0.1,
          0.2528,
          0.53,
          10,
          0.0126,
        ),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => region.kind === 'body')
        .map((region) => region.text),
    ).toEqual([
      'Humans naturally expend more mental effort solving some problems than others while reasoning continuously.',
      'Early attempts instead scaled the model parameters. More recent systems scale their test-time computation.',
    ])
  })

  it('preserves a styled run-in paragraph at ordinary line leading', () => {
    const runInLabel = run(
      1,
      'Fusion with abstract modalities:',
      0.12,
      0.24,
      0.22,
      10,
      0.018,
    )
    runInLabel.bold = true
    runInLabel.fontName = 'NimbusRomNo9L-Medi'
    const result = reconstructPageRegions([
      page(1, [
        run(
          1,
          'The preceding paragraph describes raw modalities.',
          0.1,
          0.2,
          0.52,
        ),
        run(1, 'It ends before the styled treatment begins.', 0.1, 0.22, 0.48),
        runInLabel,
        run(1, 'We begin with a representation.', 0.345, 0.24, 0.275),
        run(
          1,
          'These operations can then be composed repeatedly.',
          0.1,
          0.26,
          0.5,
        ),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => region.kind === 'body')
        .map((region) => region.text),
    ).toEqual([
      'The preceding paragraph describes raw modalities. It ends before the styled treatment begins.',
      'Fusion with abstract modalities: We begin with a representation. These operations can then be composed repeatedly.',
    ])
  })

  it('withholds an aligned row when stacked source labels remain semantically ambiguous', () => {
    const upper = run(1, 'DE', 0.28, 0.397, 0.02, 7, 0.009)
    upper.fontName = 'Synthetic-CMR7'
    const lower = run(1, 'TE', 0.28, 0.41, 0.02, 7, 0.009)
    lower.fontName = 'Synthetic-CMR7'
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.5),
        run(1, 'A second ordinary prose line remains intact.', 0.1, 0.23, 0.5),
        run(1, 'The audited labels', 0.1, 0.4, 0.16),
        upper,
        lower,
        run(1, 'remain ordinary prose.', 0.31, 0.4, 0.18),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'equation'),
    ).toHaveLength(1)
    expect(
      result.regions.find((region) => region.text.includes('audited labels')),
    ).toMatchObject({
      kind: 'body',
      text: expect.not.stringContaining('DE'),
    })
    expect(
      result.regions
        .flatMap((region) => region.lines)
        .some((line) => /-inline-stacked-\d+-formula$/u.test(line.id)),
    ).toBe(true)
  })

  it('does not classify a full-size Computer Modern prose word as math from the literal word helix', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      fontSize = 10,
      height = 0.014,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
    })
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Body text establishes its normal size.', 0.1, 0.2, 0.4),
        run(1, 'Another body line establishes the flow.', 0.1, 0.24, 0.4),
        sourceRun('The measured', 0.1, 0.4, 0.12, 'Synthetic-Serif'),
        sourceRun('=', 0.23, 0.4, 0.012, 'Synthetic-CMR10'),
        sourceRun('DE', 0.247, 0.397, 0.02, 'Synthetic-CMR7', 7, 0.009),
        sourceRun('TE', 0.247, 0.41, 0.02, 'Synthetic-CMR7', 7, 0.009),
        sourceRun('helix', 0.273, 0.4, 0.04, 'Synthetic-CMR10'),
        sourceRun('label remains prose.', 0.319, 0.4, 0.16, 'Synthetic-Serif'),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => region.kind === 'equation')
        .map((region) => region.text)
        .join(' '),
    ).not.toMatch(/\bhelix\b/iu)
  })

  it('rejoins an emphasized section number stranded at a column gutter', async () => {
    const body = [
      run(1, 'Left column establishes its first line.', 0.1, 0.2, 0.39, 11),
      run(1, 'Right column establishes its first line.', 0.54, 0.2, 0.36, 11),
      run(1, 'Left column establishes its second line.', 0.1, 0.26, 0.39, 11),
      run(1, 'Right column establishes its second line.', 0.54, 0.26, 0.36, 11),
      run(1, 'Left column establishes its third line.', 0.1, 0.32, 0.39, 11),
      run(1, 'Right column establishes its third line.', 0.54, 0.32, 0.36, 11),
    ]
    const prefix = run(1, '2', 0.505, 0.65, 0.012, 12)
    const title = run(1, 'Related Work', 0.54, 0.65, 0.12, 12)
    prefix.fontName = 'Synthetic-Medium'
    title.fontName = 'Synthetic-Medium'
    const result = await reconstruct([
      page(1, [
        ...body,
        prefix,
        title,
        run(
          1,
          'Following left-column prose must not absorb the section number.',
          0.1,
          0.675,
          0.39,
          11,
        ),
        run(1, '2.1 Prior Systems', 0.54, 0.7, 0.18, 11),
      ]),
    ])

    expect(
      result.paper.nodes.filter((node) => node.type === 'heading'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: '2 Related Work' }),
      ]),
    )
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph')
        .map((node) => node.text),
    ).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('2 Following left-column prose'),
      ]),
    )
  })

  it('classifies decimal plot ticks as chart labels instead of footnotes', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Body text establishes the page font.', 0.1, 0.15, 0.5, 10),
        run(1, 'A second ordinary body line.', 0.1, 0.2, 0.5, 10),
        run(1, 'A third ordinary body line.', 0.1, 0.25, 0.5, 10),
        run(1, 'A fourth ordinary body line.', 0.1, 0.3, 0.5, 10),
        run(1, '0.0', 0.12, 0.74, 0.025, 7),
        run(1, '0.1', 0.2, 0.74, 0.025, 7),
        run(1, '0,198', 0.28, 0.74, 0.04, 7),
      ]),
    ])

    const ticks = result.regions.filter((region) =>
      ['0.0', '0.1', '0,198'].includes(region.text),
    )
    expect(ticks).toHaveLength(3)
    expect(ticks.every((region) => region.kind === 'chart-label')).toBe(true)
    expect(result.paper.nodes.some((node) => node.type === 'footnote')).toBe(
      false,
    )
  })

  it('does not promote tiny grouped chart ticks to numbered footnotes', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Body text establishes the page font.', 0.1, 0.15, 0.5, 10),
        run(1, 'A second ordinary body line.', 0.1, 0.2, 0.5, 10),
        run(1, 'A third ordinary body line.', 0.1, 0.25, 0.5, 10),
        run(1, '2.50', 0.251, 0.752, 0.012, 3.3, 0.0042),
        run(1, '100', 0.288, 0.752, 0.01, 3.3, 0.0042),
        run(
          1,
          '24 22 Response Avg Projection 20 18 16 14 12 10 8',
          0.42,
          0.87,
          0.13,
          2.9,
          0.007,
        ),
      ]),
    ])

    expect(
      result.paper.nodes.filter((node) => node.type === 'footnote'),
    ).toEqual([])
    expect(
      result.regions
        .filter(
          (region) =>
            region.text.includes('2.50') ||
            region.text.includes('Response Avg Projection'),
        )
        .every((region) => region.kind !== 'footnote'),
    ).toBe(true)
  })

  it('does not promote decimal-leading table and chart cells to numbered footnotes', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Body text establishes the page font.', 0.1, 0.15, 0.5, 10),
        run(1, 'A second ordinary body line.', 0.1, 0.2, 0.5, 10),
        run(1, 'A third ordinary body line.', 0.1, 0.25, 0.5, 10),
        run(1, '3.5B', 0.23, 0.72, 0.04, 7),
        run(1, '0.8T', 0.29, 0.72, 0.04, 7),
        run(1, '18.60 65.12 84.80', 0.62, 0.72, 0.16, 7),
        run(1, '1.0 ✓', 0.65, 0.76, 0.06, 7),
        run(1, '2.0 ✗', 0.65, 0.79, 0.06, 7),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => /^\d+\.\d/u.test(region.text))
        .every(
          (region) => region.kind !== 'footnote' && region.kind !== 'endnote',
        ),
    ).toBe(true)
    expect(
      result.paper.nodes.filter((node) => node.type === 'footnote'),
    ).toEqual([])
  })

  it('does not promote monospaced numbered diagram content to footnotes', async () => {
    const diagramRun = (text: string, x: number, y: number, width: number) => ({
      ...run(1, text, x, y, width, 7),
      fontName: 'Inconsolata-Regular',
    })
    const result = await reconstruct([
      page(1, [
        run(1, 'Body text establishes the page font.', 0.1, 0.15, 0.5, 10),
        run(1, 'A second ordinary body line.', 0.1, 0.2, 0.5, 10),
        run(1, 'A third ordinary body line.', 0.1, 0.25, 0.5, 10),
        diagramRun('1. Character Portrait:', 0.24, 0.76, 0.18),
        diagramRun('2. The character enters the scene', 0.24, 0.79, 0.3),
        diagramRun('3. The conflict escalates', 0.24, 0.82, 0.24),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => region.text.includes('Character Portrait'))
        .every((region) => region.kind !== 'footnote'),
    ).toBe(true)
    expect(
      result.paper.nodes.filter((node) => node.type === 'footnote'),
    ).toEqual([])
  })

  it('does not promote Nimbus monospaced data literals and their continuations to footnotes', async () => {
    const codeRun = (text: string, x: number, y: number, width: number) => ({
      ...run(1, text, x, y, width, 7),
      fontName: 'NimbusMonL-Regu',
    })
    const result = await reconstruct([
      page(1, [
        run(1, 'Body text establishes the page font.', 0.1, 0.15, 0.5, 10),
        run(1, 'A second ordinary body line.', 0.1, 0.2, 0.5, 10),
        run(1, 'A third ordinary body line.', 0.1, 0.25, 0.5, 10),
        codeRun('0]', 0.43, 0.72, 0.02),
        codeRun('i = [255, 254, 253, 253, 254,', 0.39, 0.74, 0.21),
        codeRun('255, 255, 254, 251, 251, 253,', 0.42, 0.76, 0.21),
        codeRun('7)', 0.43, 0.8, 0.02),
        codeRun('sequence += [254, 255, 0, 0, 1,', 0.39, 0.82, 0.22),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => /(?:0\]|sequence \+=)/u.test(region.text))
        .every(
          (region) => region.kind !== 'footnote' && region.kind !== 'endnote',
        ),
    ).toBe(true)
    expect(
      result.paper.nodes.filter((node) => node.type === 'footnote'),
    ).toEqual([])
  })

  it('keeps a lower-page sequential prompt list in body flow when it has no note references', async () => {
    const body = Array.from({ length: 12 }, (_, index) =>
      run(
        1,
        `Ordinary body line ${index + 1} establishes the page prose size.`,
        0.176,
        0.12 + index * 0.045,
        0.64,
        10,
      ),
    )
    const result = await reconstruct([
      page(1, [
        ...body,
        run(
          1,
          'Positive instructions (encouraging the target behavior)',
          0.202,
          0.779,
          0.38,
          10,
        ),
        run(
          1,
          '1. Your responses should demonstrate the target behavior and remain focused through-',
          0.202,
          0.807,
          0.596,
          9,
          0.0113,
        ),
        run(1, 'out the answer.', 0.202, 0.8196, 0.12, 9, 0.0113),
        run(
          1,
          '2. Respond with the requested mindset and prioritize it consistently in every',
          0.202,
          0.8322,
          0.596,
          9,
          0.0113,
        ),
        run(1, 'answer.', 0.202, 0.8448, 0.08, 9, 0.0113),
        run(
          1,
          '3. Derive each response from the requested persona and explain the result',
          0.202,
          0.8574,
          0.596,
          9,
          0.0113,
        ),
        run(1, 'clearly.', 0.202, 0.87, 0.08, 9, 0.0113),
        run(
          1,
          '4. Use the requested strategy as a tool in your responses whenever it is',
          0.202,
          0.8826,
          0.596,
          9,
          0.0113,
        ),
        run(1, 'appropriate.', 0.202, 0.8952, 0.1, 9, 0.0113),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => /^[1-4]\.\s/u.test(region.text))
        .map((region) => region.kind),
    ).toEqual(['body', 'body', 'body', 'body'])
    expect(
      result.paper.nodes.filter((node) => node.type === 'footnote'),
    ).toEqual([])
    expect(result.noteRelationships).toEqual([])
  })

  it('preserves a compact sequential numbered footnote band with raised backlink markers', async () => {
    const raisedReference = (
      text: string,
      label: string,
      y: number,
    ): PdfSourceRun[] => [
      run(1, text, 0.1, y, 0.38, 10),
      run(1, label, 0.482, y - 0.005, 0.006, 6, 0.009),
      run(1, '.', 0.49, y, 0.006, 10),
    ]
    const result = await reconstruct([
      page(1, [
        run(1, 'Body line one establishes the prose size.', 0.1, 0.12, 0.64),
        run(1, 'Body line two establishes the prose size.', 0.1, 0.15, 0.64),
        ...raisedReference('The first claim has supporting detail', '1', 0.22),
        ...raisedReference('The second claim has supporting detail', '2', 0.27),
        ...raisedReference('The third claim has supporting detail', '3', 0.32),
        run(1, '1. First compact note body.', 0.1, 0.83, 0.7, 8),
        run(1, '2. Second compact note body.', 0.1, 0.86, 0.7, 8),
        run(1, '3. Third compact note body.', 0.1, 0.89, 0.7, 8),
      ]),
    ])

    expect(
      result.paper.nodes
        .filter((node) => node.type === 'footnote')
        .map((node) => ({ label: node.label, text: node.text })),
    ).toEqual([
      { label: '1', text: 'First compact note body.' },
      { label: '2', text: 'Second compact note body.' },
      { label: '3', text: 'Third compact note body.' },
    ])
    expect(
      result.noteRelationships.map((relationship) => ({
        label: relationship.label,
        status: relationship.status,
      })),
    ).toEqual([
      { label: '1', status: 'matched' },
      { label: '2', status: 'matched' },
      { label: '3', status: 'matched' },
    ])
  })

  it('checks dense reading-order graphs without overflowing the call stack', () => {
    const regionIds = Array.from(
      { length: 20_000 },
      (_, index) => `region-${index}`,
    )
    const edges = regionIds.slice(1).map((to, index) => ({
      id: `edge-${index}`,
      from: regionIds[index],
      to,
      status: 'accepted' as const,
      confidence: 1,
      evidence: [],
      sourceBoxes: [],
    }))

    expect(hasAcceptedCycle(regionIds, edges)).toBe(false)
    expect(
      hasAcceptedCycle(regionIds, [
        ...edges,
        { ...edges[0], id: 'cycle', from: regionIds.at(-1)!, to: regionIds[0] },
      ]),
    ).toBe(true)
  })

  it('orders every left logical page region before the right side of an accepted scan spread', async () => {
    const spread = page(1, [
      run(1, 'Left opening.', 0.08, 0.12, 0.3),
      run(1, 'Right opening.', 0.62, 0.14, 0.3),
      run(1, 'Right continuation.', 0.62, 0.22, 0.3),
      run(1, 'Left conclusion.', 0.08, 0.72, 0.3),
    ])
    spread.kind = 'ocr-complete'
    spread.runs = spread.runs.map((item) => ({ ...item, method: 'ocr' }))
    spread.spread = {
      status: 'split',
      boundary: 0.5,
      confidence: 0.9,
      logicalRegions: [
        {
          id: 'physical-p001-left',
          physicalPage: 1,
          side: 'left',
          box: {
            page: 1,
            x: 0,
            y: 0,
            width: 0.5,
            height: 1,
            rotation: 0,
            method: 'ocr',
          },
        },
        {
          id: 'physical-p001-right',
          physicalPage: 1,
          side: 'right',
          box: {
            page: 1,
            x: 0.5,
            y: 0,
            width: 0.5,
            height: 1,
            rotation: 0,
            method: 'ocr',
          },
        },
      ],
    }

    const result = await reconstruct([spread])
    const text = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')

    expect(text.indexOf('Left conclusion')).toBeLessThan(
      text.indexOf('Right opening'),
    )
    expect(
      result.regions
        .filter((region) => region.text)
        .map((region) => region.column),
    ).toEqual(expect.arrayContaining(['left', 'right']))
    expect(result.readingOrder.evaluation.reviewRequired).toBe(false)
  })

  it('keeps tall narrow native visual fragments in their originating right column', () => {
    const columnRuns = Array.from({ length: 3 }, (_, index) => {
      const y = 0.14 + index * 0.06
      return [
        run(
          1,
          `Left column line ${index + 1} establishes the page flow.`,
          0.119,
          y,
          0.37,
        ),
        run(
          1,
          `Right column line ${index + 1} establishes the page flow.`,
          0.514,
          y,
          0.37,
        ),
      ]
    }).flat()
    const result = reconstructPageRegions([
      page(1, columnRuns, [
        {
          id: 'right-column-vector-strip',
          page: 1,
          kind: 'vector',
          box: {
            page: 1,
            x: 0.515,
            y: 0.35,
            width: 0.042,
            height: 0.212,
            rotation: 0,
            method: 'pdf-object',
          },
          confidence: 1,
          assetId: null,
        },
      ]),
    ])

    expect(
      result.regions.find((region) =>
        region.nativeObjectIds.includes('right-column-vector-strip'),
      ),
    ).toMatchObject({ column: 'right' })
  })

  it('starts a new region at a standalone numbered marker before its same-baseline item text', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(
          1,
          '3. The previous item ends with a complete sentence.',
          0.129,
          0.1,
          0.34,
          9,
          0.011,
        ),
        run(1, 'Outline:', 0.129, 0.125, 0.06, 9, 0.011),
        run(1, '1.', 0.129, 0.15, 0.015, 9, 0.011),
        run(
          1,
          'The first outline item begins here.',
          0.185,
          0.15,
          0.28,
          9,
          0.011,
        ),
        run(
          1,
          '2. The second outline item follows.',
          0.129,
          0.175,
          0.3,
          9,
          0.011,
        ),
      ]),
    ])

    expect(result.regions.map((region) => region.text)).toEqual([
      '3. The previous item ends with a complete sentence. Outline:',
      '1. The first outline item begins here.',
      '2. The second outline item follows.',
    ])
  })

  it('does not use an unmodeled acronym occurrence as line-join proof', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Synthetic Parser Study', 0.1, 0.1, 0.72, 18),
        run(1, 'Compare ZX-', 0.1, 0.3, 0.72),
        run(1, 'ALPHA controls.', 0.1, 0.322, 0.72),
        run(1, 'A separate paragraph cites ZXALPHA.', 0.1, 0.6, 0.72),
      ]),
    ])

    expect(result.regions.map((region) => region.text)).toContain(
      'Compare ZX-ALPHA controls.',
    )
    expect(result.lineBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'unresolved',
          evidence: expect.arrayContaining([
            'joined-form-not-proved',
            'source-form-preserved',
          ]),
        }),
      ]),
    )
  })

  it('retains uncaptioned equation text but does not promote a generated SVG to exact source visual evidence', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Equation preservation', 0.1, 0.12, 0.72, 18),
        run(1, 'x + y = z', 0.24, 0.28, 0.4, 14),
        run(1, 'Following body text.', 0.1, 0.38, 0.72),
        run(1, 'Additional body text.', 0.1, 0.44, 0.72),
        run(1, 'More body text.', 0.1, 0.5, 0.72),
        run(1, 'Final body text.', 0.1, 0.56, 0.72),
      ]),
    ])

    const equationRegion = result.regions.find(
      (region) => region.kind === 'equation',
    )!
    expect(equationRegion.text).toBe('x + y = z')
    expect(result.visualRelationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'equation',
          status: 'unresolved',
          captionRegionId: equationRegion.id,
          sourceRegionIds: [equationRegion.id],
          sourceLineIds: ['page-001-line-0002'],
          sourceObjectIds: [],
          assetIds: [],
          canonicalNodeId: null,
          sourceText: 'x + y = z',
          altText: 'x + y = z',
          altTextSource: 'source-text',
          evidence: expect.not.arrayContaining(['source-page-crop']),
          candidates: expect.arrayContaining([
            expect.objectContaining({
              id: expect.stringMatching(/^visual-candidate-[a-f0-9]{64}$/u),
              sourceRegionIds: [equationRegion.id],
              sourceLineIds: ['page-001-line-0002'],
              sourceText: 'x + y = z',
              sourceObjectIds: ['equation-source-p001-001'],
              assetIds: [expect.stringMatching(/^asset-/)],
              evidence: expect.arrayContaining([
                'readable-text-svg-approximation',
              ]),
            }),
          ]),
        }),
      ]),
    )
    const equationNodeIndex = result.paper.nodes.findIndex(
      (node) => node.type === 'figure' && node.objectType === 'equation',
    )
    const equationTextIndex = result.paper.nodes.findIndex(
      (node) => 'text' in node && node.text === 'x + y = z',
    )
    expect(equationNodeIndex).toBe(-1)
    expect(equationTextIndex).toBeGreaterThan(-1)
    expect(result.regions.map((region) => region.id)).toContain(
      equationRegion.id,
    )
    expect(result.regions.map((region) => region.text)).toContain(
      'Following body text.',
    )
    expect(
      result.paper.nodes.some(
        (node) => node.type === 'paragraph' && node.text === 'x + y = z',
      ),
    ).toBe(false)
    expect(
      result.paper.nodes.findIndex(
        (node) =>
          node.type === 'paragraph' && node.text === 'Following body text.',
      ),
    ).toBeGreaterThan(equationTextIndex)
    const asset = result.assets.find(
      (candidate) => candidate.kind === 'equation',
    )!
    expect(asset).toMatchObject({
      mediaType: 'image/svg+xml',
      rendition: 'bounded-svg-fallback',
      sourceBoxes: [equationRegion.box],
    })
    const svg = strFromU8(asset.bytes)
    expect(svg).toContain('x + y = z')
    expect(svg).not.toMatch(/<math\b|mathml|latex/i)
    expect(result.semanticSignals.equations).toBe(1)
    expect(result.completeness).toMatchObject({
      textCoverage: 1,
      unprovenancedRenderedUnitCount: 0,
      sourceAssetCount: 1,
      exportedAssetCount: 0,
      expectedRelationshipCount: 1,
      resolvedRelationshipCount: 0,
      unresolvedObjectCount: 2,
    })

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNRESOLVED_VISUAL_OBJECT' }),
        expect.objectContaining({ code: 'INCOMPLETE_ASSET_COVERAGE' }),
        expect.objectContaining({ code: 'INCOMPLETE_RELATIONSHIP_COVERAGE' }),
      ]),
    )
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNPROVENANCED_RENDERED_UNIT' }),
      ]),
    )
    expect(result.readiness.ready).toBe(false)
    await expect(buildEpub(result.paper, result)).rejects.toThrow(
      /INCOMPLETE_ASSET_COVERAGE/,
    )
  })

  it('keeps a first-page arXiv margin identifier out of canonical prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'A Synthetic Scholarly Paper', 0.14, 0.12, 0.72, 18),
        run(1, 'Abstract', 0.14, 0.24, 0.2, 12),
        run(
          1,
          'Synthetic body text remains in reading order.',
          0.14,
          0.31,
          0.72,
        ),
        run(
          1,
          'A second body line establishes body typography.',
          0.14,
          0.36,
          0.72,
        ),
        run(1, 'A third body line remains canonical.', 0.14, 0.41, 0.72),
        run(1, 'arXiv:2401.01234v2 [cs.CL] 31 Jan 2024', 0.052, 0.68, 0.81, 20),
      ]),
    ])

    const identifier = result.regions.find((region) =>
      region.text.startsWith('arXiv:'),
    )
    expect(identifier).toMatchObject({
      kind: 'side',
      includedInReadingOrder: false,
    })
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).not.toContain('arXiv:2401.01234v2')
  })

  it('retains ordinary body prose that begins with an arXiv identifier', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'A Synthetic Scholarly Paper', 0.14, 0.12, 0.72, 18),
        run(1, 'First body line.', 0.14, 0.28, 0.72),
        run(
          1,
          'arXiv:2401.01234 provides an ordinary prose example.',
          0.14,
          0.34,
          0.72,
        ),
        run(1, 'Final body line.', 0.14, 0.4, 0.72),
      ]),
    ])

    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).toContain('arXiv:2401.01234 provides an ordinary prose example.')
  })

  it('does not promote isolated author initials to section headings', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'A Synthetic Scholarly Paper', 0.14, 0.12, 0.72, 18),
        run(1, 'R', 0.14, 0.21, 0.05, 12),
        run(1, 'D', 0.14, 0.27, 0.05, 12),
        run(1, 'Abstract body line one.', 0.14, 0.35, 0.72, 9),
        run(1, 'Abstract body line two.', 0.14, 0.4, 0.72, 9),
        run(1, 'Abstract body line three.', 0.14, 0.45, 0.72, 9),
        run(1, 'Abstract body line four.', 0.14, 0.5, 0.72, 9),
        run(1, 'Abstract body line five.', 0.14, 0.55, 0.72, 9),
      ]),
    ])

    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'heading' && (node.text === 'R' || node.text === 'D'),
      ),
    ).toEqual([])
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' && (node.text === 'R' || node.text === 'D'),
      ),
    ).toHaveLength(2)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ISOLATED_PROSE_GLYPH',
          severity: 'error',
        }),
      ]),
    )
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'ISOLATED_PROSE_GLYPH',
      ),
    ).toHaveLength(2)
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
      blockingDiagnosticCodes: expect.arrayContaining(['ISOLATED_PROSE_GLYPH']),
    })
  })

  it('keeps an unclaimed small alphabetic glyph visible and fails closed', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Synthetic glyph review', 0.1, 0.12, 0.72, 18),
        run(1, 'Ordinary body text establishes typography.', 0.1, 0.24, 0.72),
        run(1, 'Q', 0.46, 0.5, 0.018, 8),
        run(1, 'More ordinary body text follows.', 0.1, 0.62, 0.72),
      ]),
    ])

    expect(result.paper.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'paragraph', text: 'Q' }),
      ]),
    )
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ISOLATED_PROSE_GLYPH',
          severity: 'error',
        }),
      ]),
    )
    expect(result.readiness.ready).toBe(false)
  })

  it('keeps unproven table-cell text visible and blocks export instead of inventing a semantic table', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Table 1. Synthetic categories.', 0.1, 0.2, 0.45, 10),
        run(1, 'Key', 0.1, 0.26, 0.08, 9),
        run(1, 'Value', 0.3, 0.26, 0.08, 9),
        run(1, 'A', 0.1, 0.3, 0.02, 9),
        run(1, '1', 0.3, 0.3, 0.02, 9),
        run(1, 'B', 0.1, 0.34, 0.02, 9),
        run(1, '2', 0.3, 0.34, 0.02, 9),
      ]),
    ])

    expect(
      result.paper.nodes.some(
        (node) => node.type === 'figure' && node.objectType === 'table',
      ),
    ).toBe(false)
    const visibleFallbackText = result.paper.nodes
      .flatMap((node) =>
        node.type === 'paragraph' && /(?:Key|Value|A|B|1|2)/.test(node.text)
          ? [node.text]
          : [],
      )
      .join(' ')
    expect(visibleFallbackText.match(/\b(?:Key|Value|A|B|1|2)\b/gu)).toEqual([
      'Key',
      'Value',
      'A',
      '1',
      'B',
      '2',
    ])
    expect(result.visualRelationships).toEqual([
      expect.objectContaining({
        kind: 'table',
        status: 'unresolved',
        assetIds: [],
        candidates: [
          expect.objectContaining({
            sourceObjectIds: ['table-p001-001'],
            assetIds: [],
            evidence: expect.arrayContaining(['semantic-table-unresolved']),
          }),
        ],
      }),
    ])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNRESOLVED_VISUAL_OBJECT' }),
        expect.objectContaining({ code: 'INCOMPLETE_ASSET_COVERAGE' }),
        expect.objectContaining({ code: 'INCOMPLETE_RELATIONSHIP_COVERAGE' }),
      ]),
    )
    expect(result.readiness.ready).toBe(false)
  })

  it('separates a larger title line from a tightly spaced author block', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Synthetic Benchmark Title', 0.18, 0.1, 0.64, 14.4),
        run(1, 'Ada Example, Babbage Example', 0.14, 0.137, 0.72, 12),
        run(1, 'Example University', 0.24, 0.158, 0.52, 12),
        run(1, 'Abstract', 0.14, 0.24, 0.2, 12),
        ...Array.from({ length: 16 }, (_, index) =>
          run(
            1,
            `Body line ${index + 1} remains ordinary prose.`,
            0.14,
            0.31 + index * 0.035,
            0.72,
            10,
          ),
        ),
      ]),
    ])

    expect(result.paper).toMatchObject({
      title: 'Synthetic Benchmark Title',
      authors: ['Ada Example', 'Babbage Example'],
      affiliations: ['Example University'],
    })
    expect(result.paper.nodes[0]).toMatchObject({
      type: 'heading',
      text: 'Abstract',
    })
    expect(
      result.paper.nodes.some(
        (node) =>
          'text' in node &&
          (node.text.includes('Synthetic Benchmark Title') ||
            node.text.includes('Ada Example') ||
            node.text.includes('Example University')),
      ),
    ).toBe(false)
  })

  it('orders both column bands around a spanning block and links notes under each column', async () => {
    const result = await reconstruct([
      page(
        1,
        [
          run(1, 'Two column study', 0.08, 0.1, 0.84, 18),
          run(1, 'Left above one.', 0.08, 0.2, 0.32),
          run(1, 'Left above two.', 0.08, 0.24, 0.32),
          run(1, 'Left claim', 0.08, 0.28, 0.24),
          run(1, '1', 0.325, 0.283, 0.008, 6, 0.009),
          run(1, 'Right above one.', 0.56, 0.2, 0.32),
          run(1, 'Right above two.', 0.56, 0.24, 0.32),
          run(1, 'Right claim', 0.56, 0.28, 0.24),
          run(1, '2', 0.805, 0.283, 0.008, 6, 0.009),
          run(1, 'Spanning figure between column bands', 0.12, 0.42, 0.76, 11),
          run(1, 'Left below one.', 0.08, 0.54, 0.32),
          run(1, 'Left below two.', 0.08, 0.58, 0.32),
          run(1, 'Left below three.', 0.08, 0.62, 0.32),
          run(1, 'Right below one.', 0.56, 0.54, 0.32),
          run(1, 'Right below two.', 0.56, 0.58, 0.32),
          run(1, 'Right below three.', 0.56, 0.62, 0.32),
          run(1, '1. Left-column note.', 0.08, 0.82, 0.32, 7),
          run(1, '2. Right-column note.', 0.56, 0.82, 0.32, 7),
        ],
        [
          {
            id: 'image-p001-001',
            page: 1,
            kind: 'image',
            assetId: null,
            box: {
              page: 1,
              x: 0.2,
              y: 0.36,
              width: 0.6,
              height: 0.05,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 0.98,
          },
        ],
      ),
    ])

    const canonicalText = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')
    expect(canonicalText.indexOf('Left above')).toBeLessThan(
      canonicalText.indexOf('Right above'),
    )
    expect(canonicalText.indexOf('Right above')).toBeLessThan(
      canonicalText.indexOf('Spanning figure'),
    )
    expect(canonicalText.indexOf('Spanning figure')).toBeLessThan(
      canonicalText.indexOf('Left below'),
    )
    expect(result.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'spanning', column: 'span' }),
        expect.objectContaining({ kind: 'figure', column: 'span' }),
        expect.objectContaining({ kind: 'footnote', column: 'left' }),
        expect.objectContaining({ kind: 'footnote', column: 'right' }),
      ]),
    )
    const figure = result.regions.find((region) => region.kind === 'figure')!
    const above = result.regions.find((region) =>
      region.text.includes('Left above'),
    )!
    const below = result.regions.find((region) =>
      region.text.includes('Left below'),
    )!
    expect(result.readingOrder.order.indexOf(above.id)).toBeLessThan(
      result.readingOrder.order.indexOf(figure.id),
    )
    expect(result.readingOrder.order.indexOf(figure.id)).toBeLessThan(
      result.readingOrder.order.indexOf(below.id),
    )
    expect(result.noteRelationships).toHaveLength(2)
    expect(
      result.noteRelationships.every((note) => note.status === 'matched'),
    ).toBe(true)
    expect(result.noteRelationships.map((note) => note.evidence)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['same-column-geometry']),
      ]),
    )
    expect(
      result.regions.every(
        (region) => region.confidence > 0 && region.box.page === region.page,
      ),
    ).toBe(true)
    expect(
      result.readingOrder.edges.every(
        (edge) =>
          edge.confidence > 0 &&
          edge.evidence.length > 0 &&
          edge.sourceBoxes.length === 2,
      ),
    ).toBe(true)
    expect(
      result.noteRelationships.every(
        (relationship) =>
          relationship.confidence > 0 && relationship.sourceBoxes.length === 2,
      ),
    ).toBe(true)
    expect(result.completeness).toMatchObject({
      relationshipCoverage: 1,
      readingOrderDiagnostics: 0,
    })
  })

  it('orders same-row fragments by their top source line instead of a later union-box indent', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'First left-column line.', 0.09, 0.12, 0.37),
        run(1, 'First right-column line.', 0.52, 0.12, 0.37),
        run(1, 'Second left-column line.', 0.09, 0.16, 0.37),
        run(1, 'Second right-column line.', 0.52, 0.16, 0.37),
        run(1, 'Third left-column line.', 0.09, 0.2, 0.37),
        run(1, 'Third right-column line.', 0.52, 0.2, 0.37),
        run(1, 'author.', 0.502, 0.3, 0.08, 10, 0.0126),
        run(1, 'interpreting', 0.689, 0.3, 0.077, 10, 0.0126),
        run(1, 'GPT:', 0.797, 0.3, 0.036, 10, 0.0126),
        run(1, 'the', 0.864, 0.3, 0.021, 10, 0.0126),
        run(1, 'logit', 0.518, 0.315, 0.031, 10, 0.0126),
      ]),
    ])
    const textByRegionId = new Map(
      result.regions.map((region) => [region.id, region.text]),
    )
    const fragmentOrder = result.readingOrder.order
      .map((regionId) => textByRegionId.get(regionId))
      .filter((text) =>
        ['author.', 'interpreting', 'GPT:', 'the logit'].includes(text ?? ''),
      )

    expect(fragmentOrder).toEqual([
      'author.',
      'interpreting',
      'GPT:',
      'the logit',
    ])
  })

  it('keeps every included column region when a spanning object overlaps its vertical band', async () => {
    const result = await reconstruct([
      page(
        1,
        [
          run(1, 'Overlapping float study', 0.08, 0.08, 0.84, 18),
          run(1, 'Left retained one.', 0.08, 0.2, 0.32),
          run(1, 'Left retained two.', 0.08, 0.24, 0.32),
          run(1, 'Left retained three.', 0.08, 0.28, 0.32),
          run(1, 'Right retained one.', 0.56, 0.2, 0.32),
          run(1, 'Right retained two.', 0.56, 0.24, 0.32),
          run(1, 'Right retained three.', 0.56, 0.28, 0.32),
        ],
        [
          {
            id: 'vector-p001-001',
            page: 1,
            kind: 'vector',
            assetId: null,
            box: {
              page: 1,
              x: 0.2,
              y: 0.15,
              width: 0.6,
              height: 0.5,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 0.98,
          },
        ],
      ),
    ])

    const included = result.regions
      .filter((region) => region.includedInReadingOrder)
      .map((region) => region.id)
    expect(new Set(result.readingOrder.order)).toEqual(new Set(included))
    expect(result.readingOrder.order).toHaveLength(included.length)
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).toContain('Left retained')
  })
})
