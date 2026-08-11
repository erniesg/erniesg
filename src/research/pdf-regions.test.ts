import { strFromU8 } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { buildEpub, buildReadableEpub, inspectEpub } from './epub'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import {
  evaluateReadingOrder,
  hasAcceptedCycle,
  noteLabelFromText,
  pdfSourceColumnFlowJoinOutcome,
  proseDominantPdfMathSource,
  captionFontFamily,
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

function withExplicitEnglishLanguage(page: PdfPageAnalysis): PdfPageAnalysis {
  return {
    ...page,
    ocr: {
      engine: 'test-language-authority',
      engineVersion: '1',
      model: 'test-en',
      modelVersion: '1',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: '1'.repeat(64),
      rasterSha256: '2'.repeat(64),
      confidence: 1,
      words: [],
      lines: [],
    },
  }
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

  it('keeps a detached right-margin equation number out of following prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'CR = m/N × 100%,', 0.22, 0.4, 0.17),
        run(1, '(4)', 0.466, 0.4, 0.022),
        run(
          1,
          'where N is the number of quadruples in the graph.',
          0.12,
          0.424,
          0.37,
        ),
      ]),
    ])

    const texts = result.regions.map((region) => region.text)
    expect(texts).toContain('(4)')
    expect(texts).toContain('where N is the number of quadruples in the graph.')
    expect(texts).not.toContain(
      '(4) where N is the number of quadruples in the graph.',
    )
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.list !== undefined &&
          node.text.includes('quadruples'),
      ),
    ).toBe(false)
  })

  it('isolates compact unsafe CMEX glyph lines as equation fragments', () => {
    const largeOperator = run(1, 'Z', 0.36, 0.5, 0.018)
    const delimiter = run(1, '\u0000', 0.382, 0.5, 0.01)
    delimiter.fontName = 'Synthetic-CMEX10'
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.5),
        run(1, 'A second ordinary prose line remains intact.', 0.1, 0.23, 0.5),
        run(1, 'The drift is pinned down by', 0.1, 0.47, 0.24),
        largeOperator,
        delimiter,
        run(1, 'μ(t, x) = a + b', 0.4, 0.53, 0.22),
      ]),
    ])

    const fragment = result.regions.find((region) =>
      region.text.includes('\u0000'),
    )
    expect(fragment).toMatchObject({
      kind: 'equation',
      text: '\u0000',
    })
    expect(fragment?.text).not.toContain('Z')
    expect(fragment?.text).not.toContain('The drift is pinned down by')
    expect(fragment?.text).not.toContain('μ(t, x)')
  })

  it('isolates a nonpublishable CMEX line without relying on compact math text', () => {
    const replacement = run(1, '\ufffd', 0.312, 0.37798, 0.012, 11, 0.0142)
    replacement.fontName = 'Synthetic-CMEX99'
    const left = run(1, 'N(a,b)', 0.25, 0.38948, 0.06, 11, 0.0142)
    left.fontName = 'Synthetic-CMMI10'
    const right = run(1, 'cdefghijklmnop', 0.326, 0.38948, 0.18, 11, 0.0142)
    right.fontName = 'Synthetic-CMMI10'

    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.5),
        run(1, 'A second ordinary prose line remains intact.', 0.1, 0.23, 0.5),
        run(1, 'Preceding prose must remain accessible.', 0.12, 0.34, 0.42),
        left,
        replacement,
        right,
        run(1, 'Following prose must remain accessible.', 0.12, 0.42843, 0.42),
      ]),
    ])

    const fragment = result.regions.find((region) =>
      region.lines.some((line) =>
        line.runs.some((sourceRun) => sourceRun.text.includes('\ufffd')),
      ),
    )
    expect(fragment).toMatchObject({ kind: 'equation' })
    expect(fragment?.text).toContain('\ufffd')
    expect(fragment?.text).not.toContain(
      'Preceding prose must remain accessible.',
    )
    expect(fragment?.text).not.toContain(
      'Following prose must remain accessible.',
    )
    expect(result.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'body',
          text: 'Preceding prose must remain accessible.',
        }),
        expect.objectContaining({
          kind: 'body',
          text: 'Following prose must remain accessible.',
        }),
      ]),
    )
  })

  it('keeps prose-dominant lines with inline math and CMEX accents out of display equations', () => {
    const accent = run(1, '\u0302', 0.302, 0.4, 0.012)
    accent.fontName = 'Synthetic-CMEX10'
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.5),
        run(1, 'A second ordinary prose line remains intact.', 0.1, 0.23, 0.5),
        run(1, 'over [t, t + ∆] be ν', 0.1, 0.4, 0.2),
        accent,
        run(
          1,
          'b(t, ∆) (aggregate across positions). Hedge via an x-variance strip with safeguards.',
          0.315,
          0.4,
          0.57,
        ),
        run(
          1,
          '2. Compute rx and δx via (8)–(9); produce xbid/ask and display pbid/ask = S(·) with safeguards.',
          0.1,
          0.48,
          0.78,
        ),
        run(1, 'β = Cov(x, y) ≈ ρ.', 0.32, 0.58, 0.3),
      ]),
    ])

    expect(
      result.regions.find((region) => region.text.includes('Hedge via')),
    ).toMatchObject({ kind: 'body' })
    expect(
      result.regions.find((region) => region.text.startsWith('2. Compute')),
    ).toMatchObject({ kind: 'body' })
    expect(
      result.regions.find((region) => region.text === 'β = Cov(x, y) ≈ ρ.'),
    ).toMatchObject({ kind: 'equation' })
  })

  it('keeps held-out prose with one unresolved CMEX glyph out of display equations', () => {
    const unresolvedGlyph = run(1, '\ufffd', 0.525, 0.4, 0.012)
    unresolvedGlyph.fontName = 'Synthetic-CMEX99'
    const shortPrefix = run(1, 'Ask us if x is in y', 0.1, 0.48, 0.22)
    shortPrefix.fontName = 'Synthetic-CMMI10'
    const shortGlyph = run(1, '\ufffd', 0.322, 0.48, 0.012)
    shortGlyph.fontName = 'Synthetic-CMEX99'
    const shortSuffix = run(1, 'now.', 0.338, 0.48, 0.05)
    shortSuffix.fontName = 'Synthetic-CMMI10'
    const punctuatedPrefix = run(1, 'Go, do; it.', 0.1, 0.56, 0.12)
    punctuatedPrefix.fontName = 'Synthetic-CMMI10'
    const punctuatedGlyph = run(1, '\ufffd', 0.222, 0.56, 0.012)
    punctuatedGlyph.fontName = 'Synthetic-CMEX99'
    const bracketedPrefix = run(
      1,
      '（Read1） （this1） （now1）',
      0.1,
      0.64,
      0.24,
    )
    bracketedPrefix.fontName = 'Synthetic-CMMI10'
    const bracketedGlyph = run(1, '\ufffd', 0.342, 0.64, 0.012)
    bracketedGlyph.fontName = 'Synthetic-CMEX99'
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.5),
        run(1, 'A second ordinary prose line remains intact.', 0.1, 0.23, 0.5),
        run(1, 'Sensitivity analysis demonstrates robustness', 0.1, 0.4, 0.415),
        unresolvedGlyph,
        run(1, 'across conditions.', 0.55, 0.4, 0.16),
        shortPrefix,
        shortGlyph,
        shortSuffix,
        punctuatedPrefix,
        punctuatedGlyph,
        bracketedPrefix,
        bracketedGlyph,
      ]),
    ])

    expect(
      result.regions.find((region) =>
        region.text.includes('Sensitivity analysis'),
      ),
    ).toMatchObject({
      kind: 'body',
    })
    expect(
      result.regions.find((region) =>
        region.text.includes('across conditions.'),
      ),
    ).toMatchObject({ kind: 'body' })
    expect(
      result.regions.find((region) => region.text.includes('Ask us if')),
    ).toMatchObject({
      kind: 'body',
      text: expect.stringContaining('now.'),
    })
    expect(
      result.regions.find((region) => region.text.includes('Go, do; it.')),
    ).toMatchObject({
      kind: 'body',
    })
    expect(
      result.regions.find((region) =>
        region.text.includes('（Read1） （this1） （now1）'),
      ),
    ).toMatchObject({
      kind: 'body',
    })
    expect(
      result.regions
        .filter((region) => region.kind === 'equation')
        .some((region) => /\p{L}{3,}/u.test(region.text)),
    ).toBe(false)
  })

  it('keeps narrow Type3 prose sentences with one relation out of display equations', () => {
    const firstCount = run(
      1,
      "* First letter: 'r' - This is an 'r', count = 1.",
      0.12,
      0.4,
      0.27,
    )
    firstCount.fontName = 'Synthetic-Type3'
    const seventhCount = run(
      1,
      "* Seventh letter: 'r' - This is an 'r', count = 2.",
      0.12,
      0.44,
      0.28,
    )
    seventhCount.fontName = 'Synthetic-Type3'
    const lexicalEquation = run(
      1,
      'The expected token count = total sequence length.',
      0.34,
      0.52,
      0.27,
    )
    const mathFontEquation = run(
      1,
      'This value is the expected token count = total sequence length.',
      0.33,
      0.58,
      0.29,
    )
    mathFontEquation.fontName = 'Synthetic-CMMI10'
    const multipleRelationEquation = run(
      1,
      'This value is token count = sequence length ≈ budget size.',
      0.33,
      0.64,
      0.29,
    )
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.5),
        run(1, 'A second ordinary prose line remains intact.', 0.1, 0.23, 0.5),
        firstCount,
        seventhCount,
        lexicalEquation,
        mathFontEquation,
        multipleRelationEquation,
      ]),
    ])

    expect(
      result.regions.find((region) => region.text.includes('First letter')),
    ).toMatchObject({ kind: 'body' })
    expect(
      result.regions.find((region) => region.text.includes('Seventh letter')),
    ).toMatchObject({ kind: 'body' })
    expect(
      result.regions.find((region) =>
        region.text.startsWith('The expected token count'),
      ),
    ).toMatchObject({ kind: 'equation' })
    expect(
      result.regions.find((region) =>
        region.text.startsWith('This value is the expected token count'),
      ),
    ).toMatchObject({ kind: 'equation' })
    expect(
      result.regions.find((region) =>
        region.text.includes('sequence length ≈ budget size'),
      ),
    ).toMatchObject({ kind: 'equation' })
  })

  it('isolates a source-stacked terminal fraction from its prose prefix without linearizing it', () => {
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
        run(1, 'Left column line one establishes its flow.', 0.1, 0.2, 0.36),
        run(1, 'Right column line one establishes its flow.', 0.52, 0.2, 0.36),
        run(1, 'Left column line two establishes its flow.', 0.1, 0.24, 0.36),
        run(1, 'Right column line two establishes its flow.', 0.52, 0.24, 0.36),
        run(1, 'Left column line three establishes its flow.', 0.1, 0.28, 0.36),
        run(
          1,
          'Right column line three establishes its flow.',
          0.52,
          0.28,
          0.36,
        ),
        sourceRun('which we quantify with', 0.1, 0.74, 0.17, 'Synthetic-Serif'),
        sourceRun('c', 0.278, 0.74, 0.008, 'Synthetic-CMMI10'),
        sourceRun('a,b', 0.286, 0.747, 0.018, 'Synthetic-CMMI7', 7, 0.009),
        sourceRun('=', 0.309, 0.74, 0.012, 'Synthetic-CMR10'),
        sourceRun('(1', 0.33, 0.74, 0.014, 'Synthetic-CMR10'),
        sourceRun('−', 0.348, 0.74, 0.012, 'Synthetic-CMSY10'),
        sourceRun('DE', 0.366, 0.737, 0.02, 'Synthetic-CMR7', 7, 0.009),
        sourceRun('TE', 0.366, 0.75, 0.02, 'Synthetic-CMR7', 7, 0.009),
        sourceRun(')', 0.389, 0.74, 0.006, 'Synthetic-CMR10'),
        sourceRun(
          'helix(a+b)',
          0.402,
          0.737,
          0.068,
          'Synthetic-CMR7',
          7,
          0.009,
        ),
        sourceRun(
          'helix(a,b,a+b)',
          0.4,
          0.75,
          0.085,
          'Synthetic-CMR7',
          7,
          0.009,
        ),
        sourceRun('.', 0.49, 0.74, 0.005, 'Synthetic-Serif'),
        run(
          1,
          'Following prose remains independently readable.',
          0.1,
          0.78,
          0.36,
        ),
      ]),
    ])

    const prefix = result.regions.find(
      (region) => region.text === 'which we quantify with',
    )
    const formula = result.regions.find((region) =>
      region.lines.some(
        (line) =>
          line.runs.some((source) => source.text === 'DE') &&
          line.runs.some((source) => source.text === 'TE'),
      ),
    )
    const following = result.regions.find((region) =>
      region.text.includes('Following prose remains'),
    )

    expect(prefix).toMatchObject({ kind: 'body', column: 'left' })
    expect(formula).toMatchObject({ kind: 'equation', column: 'left' })
    expect(formula?.text).not.toContain('which we quantify with')
    expect(following).toMatchObject({ kind: 'body', column: 'left' })
    expect(
      result.regions
        .filter((region) => region.kind === 'body')
        .map((region) => region.text)
        .join(' '),
    ).not.toMatch(/DE\s*TE|DETE/u)
    const ordered = result.readingOrder.order
    expect(ordered.indexOf(prefix!.id)).toBeLessThan(
      ordered.indexOf(formula!.id),
    )
    expect(ordered.indexOf(formula!.id)).toBeLessThan(
      ordered.indexOf(following!.id),
    )
  })

  it('keeps an indivisible prose-heavy stacked line between display equations in reading order', () => {
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
    const sourcePage = page(1, [
      run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
      run(1, 'A second ordinary prose line remains intact.', 0.1, 0.21, 0.5),
      sourceRun('u = 1506 W/m3', 0.36, 0.3, 0.24, 'Synthetic-CMMI10'),
      sourceRun(
        'The volume of the object is four thirds pi R cubed, so its new power is found below.',
        0.1,
        0.35,
        0.68,
        'Synthetic-Serif',
      ),
      sourceRun('n', 0.5, 0.343, 0.01, 'Synthetic-CMMI7', 7, 0.009),
      sourceRun('d', 0.5, 0.358, 0.01, 'Synthetic-CMMI7', 7, 0.009),
      sourceRun(
        'P = sigma A T4 = four pi sigma R2 T4',
        0.3,
        0.4,
        0.4,
        'Synthetic-CMMI10',
      ),
      run(1, 'Solving for temperature gives the next result.', 0.1, 0.46, 0.5),
    ])

    const first = reconstructPageRegions([sourcePage])
    const second = reconstructPageRegions([sourcePage])
    const prose = first.regions.find((region) =>
      region.text.includes('The volume of the object'),
    )
    const equations = first.regions.filter(
      (region) => region.kind === 'equation',
    )

    expect(prose).toMatchObject({ kind: 'body' })
    expect(
      prose?.lines.some((line) =>
        /-inline-stacked-\d+-formula$/u.test(line.id),
      ),
    ).toBe(true)
    expect(equations.map((region) => region.text)).toEqual([
      expect.stringContaining('u = 1506'),
      expect.stringContaining('P = sigma'),
    ])
    expect(equations.every((region) => !region.text.includes('volume'))).toBe(
      true,
    )
    expect(first.regions.map((region) => region.id)).toEqual(
      second.regions.map((region) => region.id),
    )
    expect(first.readingOrder.order.indexOf(equations[0].id)).toBeLessThan(
      first.readingOrder.order.indexOf(prose!.id),
    )
    expect(first.readingOrder.order.indexOf(prose!.id)).toBeLessThan(
      first.readingOrder.order.indexOf(equations[1].id),
    )
  })

  it('keeps narrow derivation lead-ins separate from source-cropped EPUB equations', async () => {
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
    expect(
      proseDominantPdfMathSource({
        text: 'Case A: x = y',
        width: 0.2,
        runs: [sourceRun('Case A: x = y', 0.1, 0.1, 0.2, 'Synthetic-Serif')],
      }),
    ).toBe(false)
    expect(
      proseDominantPdfMathSource({
        text: 'Multiply by 2:',
        width: 0.1,
        runs: [sourceRun('Multiply by 2:', 0.1, 0.1, 0.1, 'Synthetic-CMMI10')],
      }),
    ).toBe(false)
    const sourcePage = page(1, [
      run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
      run(1, 'A second ordinary prose line remains intact.', 0.1, 0.21, 0.5),
      run(1, 'Plugging in the coordinates of C:', 0.1, 0.27, 0.22),
      sourceRun('sqrt', 0.315, 0.27, 0.02, 'Synthetic-CMEX10'),
      sourceRun(
        '(1-t)/(2 cos θ) + √3t/(2 sin θ) = 1',
        0.18,
        0.31,
        0.48,
        'Synthetic-CMMI10',
      ),
      sourceRun('Multiply by 2:', 0.1, 0.36, 0.1, 'Synthetic-Serif'),
      sourceRun('n', 0.19, 0.353, 0.01, 'Synthetic-CMMI7', 7, 0.009),
      sourceRun('d', 0.19, 0.368, 0.01, 'Synthetic-CMMI7', 7, 0.009),
      sourceRun(
        '(1-t) sin θ + √3t cos θ = 2 sin θ cos θ',
        0.12,
        0.41,
        0.62,
        'Synthetic-CMMI10',
      ),
      sourceRun(
        'sin θ - t sin θ + √3t cos θ = sin(2θ)',
        0.14,
        0.45,
        0.58,
        'Synthetic-CMMI10',
      ),
    ])

    const result = reconstructPageRegions([sourcePage])
    const coordinateLeadIn = result.regions.find((region) =>
      region.text.includes('Plugging in the coordinates'),
    )
    const multiplyLeadIn = result.regions.find((region) =>
      region.text.includes('Multiply by 2:'),
    )
    const equations = result.regions.filter(
      (region) => region.kind === 'equation',
    )

    expect(coordinateLeadIn).toMatchObject({ kind: 'body' })
    expect(multiplyLeadIn).toMatchObject({ kind: 'body' })
    expect(
      multiplyLeadIn?.lines.some((line) =>
        /-inline-stacked-\d+-formula$/u.test(line.id),
      ),
    ).toBe(true)
    expect(
      equations.every(
        (region) =>
          !region.text.includes('Plugging') &&
          !region.text.includes('Multiply by'),
      ),
    ).toBe(true)
    expect(equations.length).toBeGreaterThanOrEqual(2)
    expect(
      result.readingOrder.order.indexOf(coordinateLeadIn!.id),
    ).toBeLessThan(result.readingOrder.order.indexOf(equations[0].id))
    expect(result.readingOrder.order.indexOf(equations[0].id)).toBeLessThan(
      result.readingOrder.order.indexOf(multiplyLeadIn!.id),
    )
    expect(result.readingOrder.order.indexOf(multiplyLeadIn!.id)).toBeLessThan(
      result.readingOrder.order.indexOf(equations.at(-1)!.id),
    )

    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 24,
          pixels: new Uint8Array(96 * 24 * 4).fill(72),
        }),
    )
    const reconstructed = await reconstructPageAnalyses({
      pages: [withExplicitEnglishLanguage(sourcePage)],
      sourceHash: '7'.repeat(64),
      fileName: 'derivation-regression.pdf',
      byteLength: 4096,
      rasterizeFigure,
    })
    const matchedEquations = reconstructed.visualRelationships.filter(
      (relationship) =>
        relationship.kind === 'equation' && relationship.status === 'matched',
    )
    const proseLineIds = new Set([
      ...coordinateLeadIn!.lines.map((line) => line.id),
      ...multiplyLeadIn!.lines.map((line) => line.id),
    ])

    expect(matchedEquations.length).toBeGreaterThanOrEqual(2)
    expect(
      matchedEquations.every((relationship) =>
        (relationship.sourceLineIds ?? []).every(
          (lineId) => !proseLineIds.has(lineId),
        ),
      ),
    ).toBe(true)
    expect(
      new Set(
        matchedEquations.map((relationship) => relationship.captionRegionId),
      ).size,
    ).toBe(matchedEquations.length)
    const canonicalText = reconstructed.paper.nodes
      .flatMap((node) =>
        'text' in node && typeof node.text === 'string' ? [node.text] : [],
      )
      .join('\n')
    expect(
      canonicalText.match(/Plugging in the coordinates of C:/gu),
    ).toHaveLength(1)
    expect(canonicalText.match(/Multiply by 2:/gu)).toHaveLength(1)

    const epub = await buildReadableEpub(reconstructed.paper, reconstructed)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content.match(/Plugging in the coordinates of C:/gu)).toHaveLength(1)
    expect(content.match(/Multiply by 2:/gu)).toHaveLength(1)
    expect(content).not.toContain('>Display equation p001-')
  })

  it('conserves a uniquely hosted detached math-extension run outside its prose cue', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      fontSize = 10,
      height = 0.0126,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
    })
    const cue = sourceRun(
      'Multiply by 2:',
      0.1,
      0.35,
      0.1,
      'Synthetic-STIXGeneral-Regular',
    )
    const detachedRoot = sourceRun(
      '√',
      0.15,
      0.3584,
      0.011,
      'Synthetic-STIXMathExtensions-Regular',
      7.5,
      0.0094,
    )
    const hostNumerator = sourceRun(
      '1',
      0.1,
      0.3675,
      0.008,
      'Synthetic-STIXMath-Regular',
      7,
      0.008,
    )
    const hostDenominator = sourceRun(
      '2',
      0.1,
      0.3795,
      0.008,
      'Synthetic-STIXMath-Regular',
      7,
      0.008,
    )
    const hostBaseline = sourceRun(
      '+ x = 1',
      0.115,
      0.372,
      0.12,
      'Synthetic-STIXMath-Regular',
    )
    const secondCue = sourceRun(
      'Plugging in values:',
      0.1,
      0.5,
      0.13,
      'Synthetic-STIXGeneral-Regular',
    )
    const secondDetachedRoot = sourceRun(
      '√',
      0.15,
      0.5084,
      0.011,
      'Synthetic-STIXMathExtensions-Regular',
      7.5,
      0.0094,
    )
    const secondHostNumerator = sourceRun(
      '3',
      0.1,
      0.5175,
      0.008,
      'Synthetic-STIXMath-Regular',
      7,
      0.008,
    )
    const secondHostDenominator = sourceRun(
      '4',
      0.1,
      0.5295,
      0.008,
      'Synthetic-STIXMath-Regular',
      7,
      0.008,
    )
    const secondHostBaseline = sourceRun(
      '+ y = 2',
      0.115,
      0.522,
      0.12,
      'Synthetic-STIXMath-Regular',
    )
    const sourcePage = page(1, [
      run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
      run(1, 'A second ordinary prose line remains intact.', 0.1, 0.21, 0.5),
      cue,
      detachedRoot,
      hostNumerator,
      hostDenominator,
      hostBaseline,
      secondCue,
      secondDetachedRoot,
      secondHostNumerator,
      secondHostDenominator,
      secondHostBaseline,
    ])

    const result = reconstructPageRegions([sourcePage])
    const replay = reconstructPageRegions([sourcePage])
    const shuffled = reconstructPageRegions([
      { ...sourcePage, runs: [...sourcePage.runs].reverse() },
    ])
    const cueRegion = result.regions.find((region) =>
      region.text.includes('Multiply by 2:'),
    )
    const detachedLines = result.regions
      .flatMap((region) => region.lines)
      .filter((line) => /-detached-math-\d+-host-/u.test(line.id))
    const detachedLine = detachedLines[0]
    const sourceRunKey = (candidate: PdfSourceRun) =>
      [
        candidate.text,
        candidate.x,
        candidate.y,
        candidate.width,
        candidate.height,
        candidate.fontName,
        candidate.fontSize,
      ].join('\u001f')
    const expectedRunLedger = [
      cue,
      detachedRoot,
      hostNumerator,
      hostDenominator,
      hostBaseline,
      secondCue,
      secondDetachedRoot,
      secondHostNumerator,
      secondHostDenominator,
      secondHostBaseline,
    ]
      .map(sourceRunKey)
      .sort()
    const actualRunLedger = result.regions
      .flatMap((region) => region.lines)
      .flatMap((line) => line.runs)
      .filter((candidate) =>
        [
          cue,
          detachedRoot,
          hostNumerator,
          hostDenominator,
          hostBaseline,
          secondCue,
          secondDetachedRoot,
          secondHostNumerator,
          secondHostDenominator,
          secondHostBaseline,
        ]
          .map(sourceRunKey)
          .includes(sourceRunKey(candidate)),
      )
      .map(sourceRunKey)
      .sort()

    expect(cueRegion).toMatchObject({
      kind: 'body',
      text: 'Multiply by 2:',
    })
    expect(cueRegion?.text).not.toContain('√')
    expect(detachedLines).toHaveLength(2)
    expect(new Set(detachedLines.map((line) => line.id)).size).toBe(2)
    expect(detachedLines.every((line) => !line.id.includes('undefined'))).toBe(
      true,
    )
    expect(detachedLine).toMatchObject({ text: '√' })
    expect(
      result.regions.find((region) =>
        region.lines.some((line) => line.id === detachedLine?.id),
      ),
    ).toMatchObject({ kind: 'equation' })
    expect(actualRunLedger).toEqual(expectedRunLedger)
    expect(new Set(actualRunLedger).size).toBe(expectedRunLedger.length)
    expect(result.regions.map((region) => region.id)).toEqual(
      replay.regions.map((region) => region.id),
    )
    expect(
      result.regions.map(({ id, kind, text }) => ({ id, kind, text })),
    ).toEqual(
      shuffled.regions.map(({ id, kind, text }) => ({ id, kind, text })),
    )
    expect(result.readingOrder.order.indexOf(cueRegion!.id)).toBeLessThan(
      result.readingOrder.order.indexOf(
        result.regions.find((region) =>
          region.lines.some((line) => line.id === detachedLine?.id),
        )!.id,
      ),
    )
  })

  it('links an extension-only radical to its exact next-sequence radicand on a different source line', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      sourceSequenceIndex: number,
      fontSize = 7.47,
      height = 0.009434,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
      sourceSequenceIndex,
    })
    const root = sourceRun(
      '√',
      0.2,
      0.3,
      0.01133,
      'Synthetic-STIXMathExtensions-Regular',
      100,
    )
    const radicand = sourceRun(
      '3',
      0.2113308,
      0.3091086,
      0.0061,
      'Synthetic-STIXMath-Regular',
      101,
    )
    const hostProse = sourceRun(
      'is the exact radicand on its prose-dominant source line.',
      0.225,
      0.3091086,
      0.55,
      'Synthetic-STIXGeneral-Regular',
      102,
      10,
      0.0126,
    )
    const sourcePage = page(1, [
      run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
      run(1, 'A second ordinary prose line remains intact.', 0.1, 0.21, 0.5),
      root,
      radicand,
      hostProse,
    ])

    const result = reconstructPageRegions([sourcePage])
    const replay = reconstructPageRegions([
      { ...sourcePage, runs: [...sourcePage.runs].reverse() },
    ])
    const allLines = result.regions.flatMap((region) => region.lines)
    const hostLine = allLines.find((line) =>
      line.runs.some((candidate) => candidate.sourceSequenceIndex === 101),
    )
    const detachedRootLine = allLines.find((line) =>
      line.runs.some((candidate) => candidate.sourceSequenceIndex === 100),
    )

    expect(hostLine?.text).toContain('exact radicand')
    expect(detachedRootLine).toMatchObject({ text: '√' })
    expect(detachedRootLine?.id).toMatch(
      new RegExp(
        `^page-001-source-line-\\d+-detached-math-001-host-${encodeURIComponent(
          hostLine!.id,
        )}$`,
        'u',
      ),
    )
    expect(detachedRootLine?.id).not.toContain('host-ambiguous')
    expect(
      allLines
        .flatMap((line) => line.runs)
        .filter((candidate) => candidate.sourceSequenceIndex === 100),
    ).toHaveLength(1)
    expect(
      result.regions.find((region) =>
        region.lines.some((line) => line.id === detachedRootLine?.id),
      ),
    ).toMatchObject({ kind: 'equation' })
    expect(
      replay.regions
        .flatMap((region) => region.lines)
        .find((line) =>
          line.runs.some((candidate) => candidate.sourceSequenceIndex === 100),
        )?.id,
    ).toBe(detachedRootLine?.id)
  })

  it('links an exact next-sequence radical even when its prose-line font size and baseline are not detached', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      sourceSequenceIndex: number,
      fontSize = 10,
      height = 0.0126,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
      sourceSequenceIndex,
    })
    const cue = sourceRun(
      'Therefore:',
      0.1,
      0.35,
      0.09,
      'Synthetic-STIXGeneral-Regular',
      200,
    )
    const root = sourceRun(
      '√',
      0.19,
      0.35,
      0.011,
      'Synthetic-STIXMathExtensions-Regular',
      201,
    )
    const radicand = sourceRun(
      '3',
      0.2010008,
      0.3622,
      0.006,
      'Synthetic-STIXMath-Regular',
      202,
      10,
      0.0126,
    )
    const hostProse = sourceRun(
      'continues on the proved host line.',
      0.215,
      0.3622,
      0.36,
      'Synthetic-STIXGeneral-Regular',
      203,
    )
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
        run(1, 'A second ordinary prose line remains intact.', 0.1, 0.21, 0.5),
        cue,
        root,
        radicand,
        hostProse,
      ]),
    ])
    const allLines = result.regions.flatMap((region) => region.lines)
    const cueLine = allLines.find((line) =>
      line.runs.some((candidate) => candidate.sourceSequenceIndex === 200),
    )
    const hostLine = allLines.find((line) =>
      line.runs.some((candidate) => candidate.sourceSequenceIndex === 202),
    )
    const rootLine = allLines.find((line) =>
      line.runs.some((candidate) => candidate.sourceSequenceIndex === 201),
    )

    expect(cueLine).toMatchObject({ text: 'Therefore:' })
    expect(cueLine?.runs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceSequenceIndex: 201 }),
      ]),
    )
    expect(rootLine).toMatchObject({ text: '√' })
    expect(rootLine?.id).toContain(`-host-${encodeURIComponent(hostLine!.id)}`)
  })

  it.each([
    {
      name: 'nonconsecutive source sequence',
      candidateSequenceIndex: 12,
      candidateX: 0.2113308,
      candidateY: 0.3091086,
      candidateFont: 'Synthetic-STIXMath-Regular',
      duplicate: false,
    },
    {
      name: 'material horizontal gap',
      candidateSequenceIndex: 11,
      candidateX: 0.21333,
      candidateY: 0.3091086,
      candidateFont: 'Synthetic-STIXMath-Regular',
      duplicate: false,
    },
    {
      name: 'prose-font neighbor',
      candidateSequenceIndex: 11,
      candidateX: 0.2113308,
      candidateY: 0.3091086,
      candidateFont: 'Synthetic-STIXGeneral-Regular',
      duplicate: false,
    },
    {
      name: 'duplicate next-sequence candidates',
      candidateSequenceIndex: 11,
      candidateX: 0.2113308,
      candidateY: 0.3091086,
      candidateFont: 'Synthetic-STIXMath-Regular',
      duplicate: true,
    },
    {
      name: 'same-line ordinary radical',
      candidateSequenceIndex: 11,
      candidateX: 0.2113308,
      candidateY: 0.3,
      candidateFont: 'Synthetic-STIXMath-Regular',
      duplicate: false,
    },
  ])(
    'does not link an extension-only radical for a $name',
    ({
      candidateSequenceIndex,
      candidateX,
      candidateY,
      candidateFont,
      duplicate,
    }) => {
      const sourceRun = (
        text: string,
        x: number,
        y: number,
        width: number,
        fontName: string,
        sourceSequenceIndex: number,
      ) => ({
        ...run(1, text, x, y, width, 7.47, 0.009434),
        fontName,
        sourceSequenceIndex,
      })
      const root = sourceRun(
        '√',
        0.2,
        0.3,
        0.01133,
        'Synthetic-STIXMathExtensions-Regular',
        10,
      )
      const candidate = sourceRun(
        '3',
        candidateX,
        candidateY,
        0.0061,
        candidateFont,
        candidateSequenceIndex,
      )
      const candidates = duplicate
        ? [
            candidate,
            sourceRun(
              '5',
              candidateX,
              candidateY,
              0.0061,
              candidateFont,
              candidateSequenceIndex,
            ),
          ]
        : [candidate]
      const result = reconstructPageRegions([
        page(1, [
          run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
          run(
            1,
            'A second ordinary prose line remains intact.',
            0.1,
            0.21,
            0.5,
          ),
          root,
          ...candidates,
        ]),
      ])
      const rootLine = result.regions
        .flatMap((region) => region.lines)
        .find((line) =>
          line.runs.some(
            (runCandidate) => runCandidate.sourceSequenceIndex === 10,
          ),
        )

      expect(rootLine).toBeDefined()
      expect(rootLine!.id).not.toMatch(/-detached-math-\d+-host-(?!ambiguous)/u)
      expect(
        result.regions
          .flatMap((region) => region.lines)
          .flatMap((line) => line.runs)
          .filter((runCandidate) => runCandidate.sourceSequenceIndex === 10),
      ).toHaveLength(1)
    },
  )

  it('does not guess ownership for an equal-distance detached math-extension run', async () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      fontSize = 10,
      height = 0.012,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
    })
    const sourcePage = page(1, [
      run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
      run(1, 'A second ordinary prose line remains intact.', 0.1, 0.21, 0.5),
      sourceRun('1', 0.1, 0.368, 0.008, 'Synthetic-STIXMath-Regular', 7, 0.008),
      sourceRun('2', 0.1, 0.38, 0.008, 'Synthetic-STIXMath-Regular', 7, 0.008),
      sourceRun('+ a = c', 0.115, 0.374, 0.12, 'Synthetic-STIXMath-Regular'),
      sourceRun('Hence:', 0.1, 0.392, 0.06, 'Synthetic-STIXGeneral-Regular'),
      sourceRun(
        '√',
        0.13,
        0.4,
        0.01,
        'Synthetic-STIXMathExtensions-Regular',
        7.5,
        0.008,
      ),
      sourceRun('3', 0.1, 0.42, 0.008, 'Synthetic-STIXMath-Regular', 7, 0.008),
      sourceRun('4', 0.1, 0.432, 0.008, 'Synthetic-STIXMath-Regular', 7, 0.008),
      sourceRun('+ d = f', 0.115, 0.426, 0.12, 'Synthetic-STIXMath-Regular'),
    ])

    const result = reconstructPageRegions([sourcePage])
    const cueRegion = result.regions.find((region) =>
      region.text.includes('Hence:'),
    )

    expect(cueRegion).toMatchObject({ kind: 'body' })
    expect(cueRegion?.text).toBe('Hence:')
    const ambiguousRootRegion = result.regions.find((region) =>
      region.lines.some((line) =>
        /-detached-math-\d+-host-ambiguous$/u.test(line.id),
      ),
    )
    expect(ambiguousRootRegion).toMatchObject({
      kind: 'equation',
      text: '√',
    })
    expect(
      result.regions
        .flatMap((region) => region.lines)
        .flatMap((line) => line.runs)
        .filter((candidate) => candidate.text === '√'),
    ).toHaveLength(1)

    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 20,
          pixels: new Uint8Array(80 * 20 * 4).fill(72),
        }),
    )
    const reconstructed = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: '8'.repeat(64),
      fileName: 'ambiguous-detached-host.pdf',
      byteLength: 2048,
      rasterizeFigure,
    })
    const ambiguousRelationship = reconstructed.visualRelationships.find(
      (relationship) =>
        relationship.kind === 'equation' &&
        (relationship.sourceLineIds ?? []).some((lineId) =>
          /-detached-math-\d+-host-ambiguous$/u.test(lineId),
        ),
    )
    expect(ambiguousRelationship).toMatchObject({
      status: 'unresolved',
    })
    expect(ambiguousRelationship?.evidence).toContain(
      'unresolved-detached-math-host',
    )
    expect(ambiguousRelationship?.assetIds).toEqual([])
  })

  it('keeps a hyphenated prose word intact around an interleaved summation crop', async () => {
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
    const sourcePage = page(1, [
      run(1, 'Left column establishes its first line.', 0.1, 0.2, 0.36),
      run(1, 'Right column establishes its first line.', 0.52, 0.2, 0.36),
      run(1, 'Left column establishes its second line.', 0.1, 0.24, 0.36),
      run(1, 'Right column establishes its second line.', 0.52, 0.24, 0.36),
      run(1, 'Left column establishes its third line.', 0.1, 0.28, 0.36),
      run(1, 'Right column establishes its third line.', 0.52, 0.28, 0.36),
      run(
        1,
        'An earlier baseline is optimal for another option.',
        0.52,
        0.32,
        0.36,
      ),
      sourceRun(
        'A method selects the option that opti-',
        0.502,
        0.5687,
        0.385,
        'Subset+NimbusRomNo9L-Regu',
        9.9626,
        0.01258,
      ),
      sourceRun('a', 0.6094, 0.59071, 0.00706, 'Subset+CMMI7', 6.9738, 0.00881),
      sourceRun(
        'l',
        0.60985,
        0.58303,
        0.00412,
        'Subset+CMMI7',
        6.9738,
        0.00881,
      ),
      sourceRun(
        'LD',
        0.58484,
        0.58383,
        0.02456,
        'Subset+CMMI10',
        9.9626,
        0.01258,
      ),
      sourceRun(
        '∑',
        0.55995,
        0.57439,
        0.01718,
        'Subset+CMEX10',
        9.9626,
        0.01258,
      ),
      sourceRun(
        'mizes',
        0.50235,
        0.58383,
        0.03798,
        'Subset+NimbusRomNo9L-Regu',
        9.9626,
        0.01258,
      ),
      sourceRun(
        'L',
        0.54635,
        0.59194,
        0.00893,
        'Subset+CMMI7',
        6.9738,
        0.00881,
      ),
      sourceRun('1', 0.54758, 0.58265, 0.00649, 'Subset+CMR7', 6.9738, 0.00881),
      sourceRun(
        'l',
        0.57714,
        0.59137,
        0.00412,
        'Subset+CMMI7',
        6.9738,
        0.00881,
      ),
      sourceRun(
        'as the objective.',
        0.6213,
        0.5838,
        0.14,
        'Subset+NimbusRomNo9L-Regu',
        9.9626,
        0.01258,
      ),
      run(1, 'Following prose remains readable.', 0.502, 0.61, 0.28),
    ])
    const regional = reconstructPageRegions([sourcePage])
    const formula = regional.regions.find(
      (region) =>
        region.kind === 'equation' &&
        region.lines.some((line) =>
          line.runs.some((source) => source.text === '∑'),
        ),
    )
    const formulaRunTexts =
      formula?.lines.flatMap((line) =>
        line.runs.map((source) => source.text),
      ) ?? []

    expect(formulaRunTexts).toEqual(
      expect.arrayContaining(['L', '1', '∑', 'l', 'LD', 'l', 'a']),
    )
    expect(formulaRunTexts).not.toEqual(
      expect.arrayContaining(['mizes', 'as the objective.']),
    )

    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 20,
          pixels: new Uint8Array(80 * 20 * 4).fill(72),
        }),
    )
    const reconstructed = await reconstructPageAnalyses({
      pages: [withExplicitEnglishLanguage(sourcePage)],
      sourceHash: '7'.repeat(64),
      fileName: 'regions.pdf',
      byteLength: 4096,
      rasterizeFigure,
    })
    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(reconstructed.visualRelationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'equation',
          status: 'unresolved',
          evidence: expect.arrayContaining([
            'overlapping-unowned-source-text',
            'source-rendition-unavailable',
          ]),
        }),
      ]),
    )
    const targetParagraphIndex = reconstructed.paper.nodes.findIndex(
      (node) =>
        node.type === 'paragraph' &&
        node.text.includes('A method selects the option'),
    )
    const formulaNodeIndex = reconstructed.paper.nodes.findIndex(
      (node) =>
        'text' in node &&
        typeof node.text === 'string' &&
        node.text.includes('∑'),
    )
    const targetParagraph = reconstructed.paper.nodes[targetParagraphIndex]
    const canonicalTextSequence = reconstructed.paper.nodes
      .flatMap((node) =>
        'text' in node && typeof node.text === 'string' ? [node.text] : [],
      )
      .join('\n')

    expect(targetParagraph).toMatchObject({
      type: 'paragraph',
      text: expect.stringContaining('option that opti-mizes'),
    })
    expect(
      'text' in targetParagraph && typeof targetParagraph.text === 'string'
        ? targetParagraph.text
        : '',
    ).not.toContain('opti- mizes')
    expect(reconstructed.lineBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'unresolved',
          evidence: expect.arrayContaining([
            'source-proven-wrapped-line-boundary',
            'joined-form-valid:pinned-lexicon',
            'split-point-valid:pinned-hyphenation-pattern',
          ]),
        }),
      ]),
    )
    expect(formulaNodeIndex).toBeGreaterThan(targetParagraphIndex)
    expect(canonicalTextSequence).toContain('∑')
    expect(
      reconstructed.provenance[reconstructed.paper.nodes[formulaNodeIndex].id]
        ?.boxes.length,
    ).toBeGreaterThan(0)
    expect(canonicalTextSequence.indexOf('opti-mizes')).toBeLessThan(
      canonicalTextSequence.indexOf('∑'),
    )
    expect(canonicalTextSequence.indexOf('∑')).toBeLessThan(
      canonicalTextSequence.indexOf('as the objective.'),
    )
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

  it('segments one-column flow without inventing a column boundary', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'One column title', 0.1, 0.12, 0.72, 18),
        run(1, 'First body line.', 0.1, 0.24, 0.72),
        run(1, 'Second body line.', 0.1, 0.28, 0.72),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => region.includedInReadingOrder)
        .every((region) => region.column === 'single'),
    ).toBe(true)
    expect(result.readingOrder).toMatchObject({ acyclic: true })
    expect(result.readingOrder.evaluation).toMatchObject({
      mode: 'deterministic-only',
      unresolvedEdgeCount: 0,
      cycleRate: 0,
      reviewRequired: false,
    })
  })

  it('ignores a dense full-width table grid when proving genuine page columns', () => {
    const tableRows = [
      ['Model', 'Method', 'Score A', 'Score B'],
      ['alpha', 'direct', '75.3', '84.1'],
      ['beta', 'guided', '65.2', '91.3'],
      ['gamma', 'direct', '87.0', '95.7'],
      ['delta', 'guided', '73.9', '82.6'],
    ]
    const tableRuns = tableRows.flatMap((row, rowIndex) =>
      row.map((text, columnIndex) =>
        run(
          1,
          text,
          [0.06, 0.26, 0.46, 0.75][columnIndex],
          0.16 + rowIndex * 0.028,
          [0.1, 0.1, 0.1, 0.15][columnIndex],
          9,
          0.012,
        ),
      ),
    )

    const tableOnly = reconstructPageRegions([page(1, tableRuns)])
    const tableOnlyRows = tableOnly.regions.filter(
      (region) => region.kind === 'body',
    )
    expect(tableOnlyRows).toHaveLength(tableRows.length)
    expect(tableOnlyRows.every((region) => region.column === 'single')).toBe(
      true,
    )
    expect(tableOnlyRows.map((region) => region.text)).toContain(
      'Model Method Score A Score B',
    )

    const mixed = reconstructPageRegions([
      page(1, [
        ...tableRuns,
        run(1, 'Left column establishes genuine prose.', 0.08, 0.48, 0.36),
        run(1, 'Right column establishes genuine prose.', 0.56, 0.48, 0.36),
        run(1, 'Left column continues independently.', 0.08, 0.52, 0.36),
        run(1, 'Right column continues independently.', 0.56, 0.52, 0.36),
        run(1, 'Left column reaches its conclusion.', 0.08, 0.56, 0.36),
        run(1, 'Right column reaches its conclusion.', 0.56, 0.56, 0.36),
      ]),
    ])
    expect(
      mixed.regions.find((region) =>
        region.text.includes('Left column establishes genuine prose.'),
      ),
    ).toMatchObject({ column: 'left' })
    expect(
      mixed.regions.find((region) =>
        region.text.includes('Right column establishes genuine prose.'),
      ),
    ).toMatchObject({ column: 'right' })
    expect(
      mixed.regions.find(
        (region) => region.text === 'Model Method Score A Score B',
      ),
    ).toMatchObject({ kind: 'spanning', column: 'span' })
    expect(mixed.readingOrder.evaluation.reviewRequired).toBe(false)
  })

  it('keeps a dense one-column table row separate from parallel prose using exact source runs', () => {
    const prose = Array.from({ length: 4 }, (_, rowIndex) =>
      run(
        1,
        `Left prose row ${rowIndex + 1} remains outside the table.`,
        0.088,
        0.3 + rowIndex * 0.028,
        0.394,
        9,
        0.011,
      ),
    )
    const tableRows = Array.from({ length: 4 }, (_, rowIndex) => {
      const y = 0.3 + rowIndex * 0.028
      return [
        run(1, `Model-${rowIndex + 1}`, 0.528, y, 0.112, 9, 0.011),
        run(1, `0.${rowIndex + 1}01`, 0.688, y, 0.031, 9, 0.011),
        run(1, `0.${rowIndex + 1}02`, 0.751, y, 0.031, 9, 0.011),
        run(1, `0.${rowIndex + 1}03`, 0.813, y, 0.031, 9, 0.011),
        run(1, `0.${rowIndex + 1}04`, 0.875, y, 0.031, 9, 0.011),
      ]
    }).flat()
    const result = reconstructPageRegions([
      page(1, [
        ...prose,
        ...tableRows,
        run(1, 'Left column continues after the table.', 0.088, 0.48, 0.394),
        run(1, 'Right column continues after the table.', 0.528, 0.48, 0.378),
        run(1, 'Left column reaches its conclusion.', 0.088, 0.52, 0.394),
        run(1, 'Right column reaches its conclusion.', 0.528, 0.52, 0.378),
      ]),
    ])

    for (let rowIndex = 0; rowIndex < 4; rowIndex += 1) {
      const expectedTexts = [
        `Model-${rowIndex + 1}`,
        `0.${rowIndex + 1}01`,
        `0.${rowIndex + 1}02`,
        `0.${rowIndex + 1}03`,
        `0.${rowIndex + 1}04`,
      ]
      const tableRegion = result.regions.find(
        (region) => region.text === expectedTexts.join(' '),
      )
      expect(tableRegion).toMatchObject({
        kind: 'body',
        column: 'right',
      })
      expect(
        tableRegion?.lines.flatMap((line) =>
          line.runs.map((sourceRun) => sourceRun.text),
        ),
      ).toEqual(expectedTexts)
      expect(tableRegion?.text).not.toContain(`Left prose row ${rowIndex + 1}`)
    }
    expect(
      result.regions.find((region) =>
        region.text.includes('Left prose row 1 remains outside the table.'),
      ),
    ).toMatchObject({ kind: 'body', column: 'left' })
    const leftIds = result.regions
      .filter(
        (region) => region.includedInReadingOrder && region.column === 'left',
      )
      .map((region) => region.id)
    const rightIds = result.regions
      .filter(
        (region) => region.includedInReadingOrder && region.column === 'right',
      )
      .map((region) => region.id)
    expect(
      Math.max(
        ...leftIds.map((regionId) =>
          result.readingOrder.order.indexOf(regionId),
        ),
      ),
    ).toBeLessThan(
      Math.min(
        ...rightIds.map((regionId) =>
          result.readingOrder.order.indexOf(regionId),
        ),
      ),
    )
    expect(
      result.readingOrder.edges.some((edge) =>
        edge.evidence.some((evidence) => evidence.code === 'column-flow'),
      ),
    ).toBe(true)
    expect(result.readingOrder.evaluation.reviewRequired).toBe(false)
  })

  it('retains a proved table lane when no prose establishes a global column split', () => {
    const tableRows = Array.from({ length: 4 }, (_, rowIndex) => {
      const y = 0.3 + rowIndex * 0.028
      return [
        run(1, `Model-${rowIndex + 1}`, 0.528, y, 0.112, 9, 0.011),
        run(1, `0.${rowIndex + 1}01`, 0.688, y, 0.031, 9, 0.011),
        run(1, `0.${rowIndex + 1}02`, 0.751, y, 0.031, 9, 0.011),
        run(1, `0.${rowIndex + 1}03`, 0.813, y, 0.031, 9, 0.011),
        run(1, `0.${rowIndex + 1}04`, 0.875, y, 0.031, 9, 0.011),
      ]
    }).flat()
    const result = reconstructPageRegions([
      page(1, [
        run(
          1,
          'Figure 1. Independent chart in the opposite lane.',
          0.09,
          0.3,
          0.37,
          8,
          0.011,
        ),
        ...tableRows,
      ]),
    ])

    for (let rowIndex = 0; rowIndex < 4; rowIndex += 1) {
      const tableRegion = result.regions.find((region) =>
        region.text.startsWith(`Model-${rowIndex + 1} `),
      )
      expect(tableRegion).toMatchObject({
        kind: 'body',
        column: 'right',
      })
      expect(tableRegion?.text).not.toContain('Independent chart')
    }
    expect(
      result.regions.find((region) =>
        region.text.includes('Independent chart in the opposite lane.'),
      ),
    ).toMatchObject({ kind: 'caption', column: 'single' })
  })

  it('keeps a mirrored dense left-column numeric matrix separate from right prose', () => {
    const tableRows = Array.from({ length: 4 }, (_, rowIndex) => {
      const y = 0.3 + rowIndex * 0.028
      return [
        run(1, `Method-${rowIndex + 1}`, 0.09, y, 0.1, 9, 0.011),
        run(1, `${rowIndex + 1}.01`, 0.23, y, 0.03, 9, 0.011),
        run(1, `${rowIndex + 1}.02`, 0.3, y, 0.03, 9, 0.011),
        run(1, `${rowIndex + 1}.03`, 0.37, y, 0.03, 9, 0.011),
        run(1, `${rowIndex + 1}.04`, 0.44, y, 0.03, 9, 0.011),
      ]
    }).flat()
    const prose = Array.from({ length: 4 }, (_, rowIndex) =>
      run(
        1,
        `Right prose row ${rowIndex + 1} remains outside the table.`,
        0.53,
        0.3 + rowIndex * 0.028,
        0.38,
        9,
        0.011,
      ),
    )
    const result = reconstructPageRegions([
      page(1, [
        ...tableRows,
        ...prose,
        run(1, 'Left column continues after the table.', 0.09, 0.48, 0.38),
        run(1, 'Right column continues after the table.', 0.53, 0.48, 0.38),
        run(1, 'Left column reaches its conclusion.', 0.09, 0.52, 0.38),
        run(1, 'Right column reaches its conclusion.', 0.53, 0.52, 0.38),
      ]),
    ])

    for (let rowIndex = 0; rowIndex < 4; rowIndex += 1) {
      const expectedTexts = [
        `Method-${rowIndex + 1}`,
        `${rowIndex + 1}.01`,
        `${rowIndex + 1}.02`,
        `${rowIndex + 1}.03`,
        `${rowIndex + 1}.04`,
      ]
      const tableRegion = result.regions.find(
        (region) => region.text === expectedTexts.join(' '),
      )
      expect(tableRegion).toMatchObject({
        kind: 'body',
        column: 'left',
      })
      expect(
        tableRegion?.lines.flatMap((line) =>
          line.runs.map((sourceRun) => sourceRun.text),
        ),
      ).toEqual(expectedTexts)
      expect(tableRegion?.text).not.toContain(`Right prose row ${rowIndex + 1}`)
    }
    expect(
      result.regions.find((region) =>
        region.text.includes('Right prose row 1 remains outside the table.'),
      ),
    ).toMatchObject({ kind: 'body', column: 'right' })

    const leftIds = result.regions
      .filter(
        (region) => region.includedInReadingOrder && region.column === 'left',
      )
      .map((region) => region.id)
    const rightIds = result.regions
      .filter(
        (region) => region.includedInReadingOrder && region.column === 'right',
      )
      .map((region) => region.id)
    expect(
      Math.max(
        ...leftIds.map((regionId) =>
          result.readingOrder.order.indexOf(regionId),
        ),
      ),
    ).toBeLessThan(
      Math.min(
        ...rightIds.map((regionId) =>
          result.readingOrder.order.indexOf(regionId),
        ),
      ),
    )
    expect(
      result.readingOrder.edges.some((edge) =>
        edge.evidence.some((evidence) => evidence.code === 'column-flow'),
      ),
    ).toBe(true)
    expect(result.readingOrder.evaluation.reviewRequired).toBe(false)
  })

  it('does not treat fragmented numeric prose as a one-column numeric matrix', () => {
    const rows = Array.from({ length: 4 }, (_, rowIndex) => {
      const y = 0.2 + rowIndex * 0.04
      return [
        run(
          1,
          `Left column row ${rowIndex + 1} preserves independent prose.`,
          0.088,
          y,
          0.394,
          9,
          0.011,
        ),
        run(1, '2024', 0.528, y, 0.035, 9, 0.011),
        run(1, 'survey readers report', 0.58, y, 0.14, 9, 0.011),
        run(1, '88', 0.738, y, 0.018, 9, 0.011),
        run(1, 'percent agreement.', 0.774, y, 0.132, 9, 0.011),
      ]
    }).flat()
    const result = reconstructPageRegions([page(1, rows)])
    const left = result.regions.find((region) =>
      region.text.includes('Left column row 1 preserves independent prose.'),
    )
    const right = result.regions.find((region) =>
      region.text.includes('2024 survey readers report 88 percent agreement.'),
    )

    expect(left).toMatchObject({ kind: 'body', column: 'left' })
    expect(right).toMatchObject({ kind: 'body', column: 'right' })
    expect(left?.text).not.toContain('survey readers')
    expect(right?.text).not.toContain('Left column')
    const orderedColumns = result.readingOrder.order
      .map((regionId) =>
        result.regions.find((region) => region.id === regionId),
      )
      .filter(
        (region) => region?.column === 'left' || region?.column === 'right',
      )
      .map((region) => region!.column)
    const firstRightIndex = orderedColumns.indexOf('right')
    expect(firstRightIndex).toBeGreaterThan(0)
    expect(
      orderedColumns
        .slice(0, firstRightIndex)
        .every((column) => column === 'left'),
    ).toBe(true)
    expect(
      orderedColumns
        .slice(firstRightIndex)
        .every((column) => column === 'right'),
    ).toBe(true)
    expect(result.readingOrder.resolutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ page: 1, status: 'resolved' }),
      ]),
    )
    expect(
      result.readingOrder.edges.some((edge) =>
        edge.evidence.some((evidence) => evidence.code === 'column-flow'),
      ),
    ).toBe(true)
    expect(result.readingOrder.evaluation.reviewRequired).toBe(false)
  })

  it('does not collapse two wide fragmented prose columns into dense table rows', () => {
    const fragment = (text: string, x: number, y: number, width: number) =>
      run(1, text, x, y, width, 10, 0.013)
    const rows = Array.from({ length: 4 }, (_, rowIndex) => {
      const y = 0.18 + rowIndex * 0.04
      return [
        fragment(`Left${rowIndex + 1}`, 0.119, y, 0.07),
        fragment('column', 0.205, y, 0.07),
        fragment('prose', 0.291, y, 0.06),
        fragment('continues.', 0.367, y, 0.12),
        fragment(`Right${rowIndex + 1}`, 0.514, y, 0.08),
        fragment('column', 0.61, y, 0.07),
        fragment('prose', 0.696, y, 0.06),
        fragment('continues.', 0.772, y, 0.11),
      ]
    }).flat()

    const result = reconstructPageRegions([page(1, rows)])
    const left = result.regions.find((region) =>
      region.text.includes('Left1 column prose continues.'),
    )
    const right = result.regions.find((region) =>
      region.text.includes('Right1 column prose continues.'),
    )

    expect(left).toMatchObject({ column: 'left', kind: 'body' })
    expect(right).toMatchObject({ column: 'right', kind: 'body' })
    expect(left?.text).not.toContain('Right1')
    expect(right?.text).not.toContain('Left1')
  })

  it('does not collapse paired prompt columns when one side uses fragmented word runs', () => {
    const word = (text: string, x: number, y: number, width: number) =>
      run(1, text, x, y, width, 9, 0.011)
    const rows = Array.from({ length: 4 }, (_, rowIndex) => {
      const y = 0.2 + rowIndex * 0.035
      return [
        word(`Left${rowIndex + 1}`, 0.129, y, 0.055),
        word('prompt', 0.195, y, 0.052),
        word('prose', 0.258, y, 0.045),
        word('continues', 0.314, y, 0.07),
        word('independently.', 0.395, y, 0.08),
        word(`Right prompt value ${rowIndex + 1}`, 0.524, y, 0.226),
      ]
    }).flat()

    const result = reconstructPageRegions([page(1, rows)])
    const left = result.regions.find((region) =>
      region.text.includes('Left1 prompt prose continues independently.'),
    )
    const right = result.regions.find((region) =>
      region.text.includes('Right prompt value 1'),
    )

    expect(left).toMatchObject({ column: 'left', kind: 'body' })
    expect(right).toMatchObject({ column: 'right', kind: 'body' })
    expect(left?.text).not.toContain('Right prompt value 1')
    expect(right?.text).not.toContain('Left1')
  })

  it('keeps an inline table reference in prose when opposite-column text is vertically nearer', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Left column establishes its first line.', 0.08, 0.12, 0.36),
        run(1, 'Right column establishes its first line.', 0.56, 0.12, 0.36),
        run(1, 'Left column establishes its second line.', 0.08, 0.16, 0.36),
        run(1, 'Right column establishes its second line.', 0.56, 0.16, 0.36),
        run(
          1,
          'Names are generated from the descriptions shown in',
          0.56,
          0.2,
          0.36,
        ),
        run(1, 'An interleaved left-column reference line.', 0.08, 0.218, 0.36),
        run(1, 'Table 6. Thus a known name can be copied.', 0.56, 0.225, 0.36),
        run(1, 'Left column establishes its final line.', 0.08, 0.26, 0.36),
        run(1, 'Right column establishes its final line.', 0.56, 0.28, 0.36),
        run(1, 'Table 6: A genuine complete table caption.', 0.56, 0.5, 0.36),
      ]),
    ])
    const inlineReference = result.regions.find((region) =>
      region.text.includes('known name can be copied'),
    )
    const genuineCaption = result.regions.find((region) =>
      region.text.includes('genuine complete table caption'),
    )

    expect(inlineReference).toMatchObject({
      kind: 'body',
      column: 'right',
      text: expect.stringContaining(
        'descriptions shown in Table 6. Thus a known name can be copied.',
      ),
    })
    expect(genuineCaption).toMatchObject({
      kind: 'caption',
      column: 'right',
    })
  })

  it('prefers a proven central prose gutter over repeated gaps inside one column', () => {
    const trueColumns = Array.from({ length: 3 }, (_, index) => {
      const y = 0.18 + index * 0.05
      return [
        run(
          1,
          `Left column line ${index + 1} establishes the page flow.`,
          0.09,
          y,
          0.385,
        ),
        run(
          1,
          `Right column line ${index + 1} establishes the page flow.`,
          0.502,
          y,
          0.385,
        ),
      ]
    }).flat()
    const rightColumnFragments = Array.from({ length: 6 }, (_, index) => {
      const y = 0.4 + index * 0.04
      return [
        run(1, `right${index + 1}`, 0.502, y, 0.1),
        run(1, 'column continuation', 0.7, y, 0.18),
      ]
    }).flat()
    const result = reconstructPageRegions([
      page(1, [
        ...trueColumns,
        ...rightColumnFragments,
        {
          ...run(
            1,
            '4.2 Parameterizing the Structure as a Helix',
            0.502,
            0.72,
            0.31,
          ),
          fontName: 'NimbusRomNo9L-Medi',
        },
      ]),
    ])

    expect(
      result.regions.find((region) =>
        region.text.includes('4.2 Parameterizing the Structure as a Helix'),
      ),
    ).toMatchObject({ column: 'right', kind: 'body' })
    expect(
      result.regions.find((region) =>
        region.text.includes('Left column line 1'),
      ),
    ).toMatchObject({ column: 'left', kind: 'body' })
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

  it('keeps repeated margins, page numbers, chart labels, and notes out of body prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Journal running header', 0.1, 0.02, 0.4, 8),
        run(1, 'Page one body.', 0.1, 0.24, 0.72),
        run(1, '50%', 0.82, 0.5, 0.06, 7),
        run(1, 'Sidebar context', 0.82, 0.58, 0.12, 7),
        run(1, 'Footnote 1: Separated note.', 0.1, 0.82, 0.72, 7),
        run(1, 'Journal running footer', 0.1, 0.93, 0.4, 8),
        run(1, '1', 0.48, 0.96, 0.02, 8),
      ]),
      page(2, [
        run(2, 'Journal running header', 0.1, 0.02, 0.4, 8),
        run(2, 'Page two body.', 0.1, 0.24, 0.72),
        run(2, 'Journal running footer', 0.1, 0.93, 0.4, 8),
        run(2, '2', 0.48, 0.96, 0.02, 8),
      ]),
    ])

    expect(result.regions.map((region) => region.kind)).toEqual(
      expect.arrayContaining([
        'header',
        'footer',
        'page-number',
        'chart-label',
        'side',
        'footnote',
      ]),
    )
    const body = result.paper.nodes
      .filter((node) => node.type === 'paragraph')
      .map((node) => node.text)
      .join(' ')
    expect(body).not.toContain('running header')
    expect(body).not.toContain('running footer')
    expect(body).not.toContain('50%')
    expect(body).not.toContain('Sidebar context')
  })

  it('classifies repeated source-run margins before a colliding diagram title is joined', () => {
    const runningAuthor =
      'Paul Pu Liang, Amir Zadeh, and Louis-Philippe Morency'
    const runningTitle = 'Foundations & Trends in Multimodal Machine Learning'
    const result = reconstructPageRegions([
      page(2, [
        run(2, '1:2', 0.094, 0.083, 0.019, 8, 0.011),
        run(2, runningAuthor, 0.525, 0.083, 0.381, 8, 0.011),
        run(2, 'Page-two prose remains canonical.', 0.094, 0.14, 0.72),
      ]),
      page(3, [
        run(3, runningTitle, 0.094, 0.083, 0.377, 8, 0.011),
        run(3, '1:3', 0.887, 0.083, 0.019, 8, 0.011),
        run(3, 'Page-three prose remains canonical.', 0.094, 0.14, 0.72),
      ]),
      page(4, [
        run(4, '1:4', 0.094, 0.083, 0.019, 8, 0.011),
        run(4, runningAuthor, 0.525, 0.083, 0.381, 8, 0.011),
        run(4, 'Dimensions of Heterogeneity', 0.176, 0.075, 0.386, 13.5, 0.019),
        run(4, 'Page-four prose remains canonical.', 0.094, 0.14, 0.72),
      ]),
      page(5, [
        run(5, runningTitle, 0.094, 0.083, 0.377, 8, 0.011),
        run(5, '1:5', 0.887, 0.083, 0.019, 8, 0.011),
        run(5, 'Page-five prose remains canonical.', 0.094, 0.14, 0.72),
      ]),
    ])

    const furniture = result.regions.filter(
      (region) =>
        region.text === runningAuthor ||
        region.text === runningTitle ||
        /^1:\d+$/u.test(region.text),
    )
    expect(furniture).toHaveLength(8)
    expect(
      furniture.every(
        (region) =>
          ['header', 'page-number'].includes(region.kind) &&
          region.includedInReadingOrder === false,
      ),
    ).toBe(true)
    expect(
      result.regions.find(
        (region) => region.text === 'Dimensions of Heterogeneity',
      ),
    ).toMatchObject({
      includedInReadingOrder: true,
    })
    expect(
      result.regions
        .filter((region) => region.includedInReadingOrder)
        .map((region) => region.text),
    ).toEqual([
      'Page-two prose remains canonical.',
      'Page-three prose remains canonical.',
      'Dimensions of Heterogeneity',
      'Page-four prose remains canonical.',
      'Page-five prose remains canonical.',
    ])
  })

  it('does not treat normalized numeric repetitions on one page as margins', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, '3. MLPs 14-18 fit the b token', 0.1, 0.18, 0.55),
        run(1, 'and retain the ordinary step explanation.', 0.12, 0.205, 0.68),
        run(1, '4. MLPs 19-27 fit the a token', 0.1, 0.34, 0.55),
        run(
          1,
          'and retain the next ordinary step explanation.',
          0.12,
          0.365,
          0.7,
        ),
      ]),
    ])

    expect(
      result.regions.map((region) => ({
        kind: region.kind,
        includedInReadingOrder: region.includedInReadingOrder,
        text: region.text,
      })),
    ).toEqual([
      {
        kind: 'body',
        includedInReadingOrder: true,
        text: '3. MLPs 14-18 fit the b token and retain the ordinary step explanation.',
      },
      {
        kind: 'body',
        includedInReadingOrder: true,
        text: '4. MLPs 19-27 fit the a token and retain the next ordinary step explanation.',
      },
    ])
  })

  it('owns explicit first-page address and legal bands as source-preserved paratext', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'The introduction begins as continuous prose and reaches this',
          0.094,
          0.706,
          0.81,
          10,
          0.014,
        ),
        run(
          1,
          'Authors’ address: Ada Example, ada@example.edu;',
          0.094,
          0.75,
          0.5,
          8,
          0.011,
        ),
        run(
          1,
          'Example Institute, 500 Research Avenue.',
          0.094,
          0.764,
          0.38,
          8,
          0.011,
        ),
        run(
          1,
          'Permission to make digital or hard copies of this work is granted without fee',
          0.094,
          0.816,
          0.81,
          8,
          0.011,
        ),
        run(
          1,
          'provided that copies bear this notice and the full citation.',
          0.094,
          0.83,
          0.64,
          8,
          0.011,
        ),
        run(
          1,
          '© 2022 Copyright held by the owner/author(s).',
          0.094,
          0.873,
          0.31,
          8,
          0.011,
        ),
        run(1, '0360-0300/2022/10-ART1', 0.094, 0.887, 0.17, 8, 0.011),
        run(1, 'https://doi.org/10.0000/example', 0.094, 0.901, 0.26, 8, 0.011),
        run(
          1,
          'Preprint, Vol. 1, No. 1. Publication date: October 2022.',
          0.48,
          0.934,
          0.43,
          8,
          0.011,
        ),
      ].map((sourceRun, sourceSequenceIndex) => ({
        ...sourceRun,
        sourceSequenceIndex,
      }))),
      page(2, [
        {
          ...run(
            2,
            'vibrant research continues without intervening page furniture.',
            0.094,
            0.14,
            0.72,
          ),
          sourceSequenceIndex: 0,
        },
      ]),
    ])

    const paratext = result.regions.filter((region) =>
      /(?:Authors.? address|Permission to make|Copyright held|0360-0300|doi\.org|Preprint, Vol\.)/iu.test(
        region.text,
      ),
    )
    expect(paratext.length).toBeGreaterThanOrEqual(4)
    expect(
      paratext.every(
        (region) =>
          region.kind === 'footer' && region.includedInReadingOrder === false,
      ),
    ).toBe(true)
    const canonicalText = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .filter(Boolean)
    expect(canonicalText).toEqual([
      'The introduction begins as continuous prose and reaches this vibrant research continues without intervening page furniture.',
    ])
  })

  it('keeps near-bottom first-page body text in canonical prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Earlier body prose establishes the primary type size.',
          0.18,
          0.5,
          0.64,
          11,
        ),
        run(
          1,
          'A second ordinary body line continues the discussion.',
          0.18,
          0.53,
          0.64,
          11,
        ),
        run(
          1,
          'The paragraph reaches the lower page while producing',
          0.18,
          0.755,
          0.64,
          10,
        ),
        run(
          1,
          'the complete result and retains all enumerated benefits,',
          0.18,
          0.772,
          0.64,
          10,
        ),
        run(
          1,
          'including the final source-backed contribution.',
          0.18,
          0.789,
          0.64,
          10,
        ),
      ]),
    ])

    const lowerBody = result.regions.filter((region) =>
      /(?:lower page|enumerated benefits|final source-backed)/u.test(
        region.text,
      ),
    )
    expect(lowerBody.length).toBeGreaterThan(0)
    expect(
      lowerBody.every(
        (region) =>
          region.kind === 'body' && region.includedInReadingOrder === true,
      ),
    ).toBe(true)
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).toContain('retains all enumerated benefits')
  })

  it('excludes geometrically isolated first-page small print from two-column prose flow', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'systems support a large range of tasks, including robotics (Driess et al., 2023; Brohan',
          0.08,
          0.6,
          0.4,
          10,
        ),
        run(
          1,
          'et al., 2023), bioinformatics and health-care.',
          0.54,
          0.14,
          0.38,
          10,
        ),
        run(
          1,
          'Workshop publication metadata and venue details',
          0.08,
          0.82,
          0.58,
          8,
          0.011,
        ),
        run(
          1,
          'Right-column prose continues independently.',
          0.7,
          0.827,
          0.22,
          10,
        ),
        run(
          1,
          'Volume information, publication date, and rights statement.',
          0.16,
          0.836,
          0.62,
          8,
          0.011,
        ),
        run(1, 'Another right-column line follows.', 0.7, 0.845, 0.22, 10),
      ]),
    ])

    const imprintRegions = result.regions.filter((region) =>
      /(?:publication metadata|Volume information)/u.test(region.text),
    )
    expect(imprintRegions.length).toBeGreaterThan(0)
    expect(
      imprintRegions.every(
        (region) =>
          region.kind === 'footer' && region.includedInReadingOrder === false,
      ),
    ).toBe(true)
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).not.toContain('Workshop publication metadata')
  })

  it('keeps a complete chart-axis label out of neighboring prose', async () => {
    const result = await reconstruct([
      page(
        2,
        [
          run(2, 'Horizontal measure (sample=19)', 0.08, 0.54, 0.34, 8),
          run(
            2,
            'neighboring prose continues in the other column.',
            0.54,
            0.54,
            0.38,
            10,
          ),
        ],
        [
          {
            id: 'vector-chart',
            page: 2,
            kind: 'vector',
            box: {
              page: 2,
              x: 0.06,
              y: 0.2,
              width: 0.4,
              height: 0.38,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 1,
            assetId: null,
            role: 'semantic',
          },
        ],
      ),
    ])

    expect(
      result.regions.some(
        (region) =>
          region.kind === 'chart-label' &&
          region.text === 'Horizontal measure (sample=19)',
      ),
    ).toBe(true)
    expect(
      result.paper.nodes
        .map((node) => ('text' in node ? node.text : ''))
        .join(' '),
    ).toContain('neighboring prose continues in the other column.')
  })

  it('separates publication status while retaining notes, captions, and bottom prose', () => {
    const result = reconstructPageRegions([
      page(1, [
        ...Array.from({ length: 5 }, (_, index) =>
          run(
            1,
            `Earlier body line ${index + 1} establishes page typography.`,
            0.176,
            0.2 + index * 0.08,
            0.65,
            10,
            0.013,
          ),
        ),
        run(
          1,
          'Ordinary body prose remains canonical near the bottom of the page.',
          0.176,
          0.88,
          0.65,
          10,
          0.013,
        ),
        run(1, '∗ Equal contribution.', 0.176, 0.905, 0.15, 8, 0.011),
        run(
          1,
          'Figure 7. A genuine bottom-band caption.',
          0.48,
          0.923,
          0.35,
          8,
          0.011,
        ),
        run(1, 'Preprint. Under review.', 0.176, 0.946, 0.14, 9, 0.011),
      ]),
    ])

    expect(
      result.regions.find((region) =>
        region.text.includes('Ordinary body prose'),
      ),
    ).toMatchObject({ kind: 'body', includedInReadingOrder: true })
    expect(
      result.regions.find((region) => region.text === '∗ Equal contribution.'),
    ).toMatchObject({ kind: 'footnote', includedInReadingOrder: true })
    expect(
      result.regions.find((region) => region.text.startsWith('Figure 7.')),
    ).toMatchObject({ kind: 'caption', includedInReadingOrder: true })
    expect(
      result.regions.find(
        (region) => region.text === 'Preprint. Under review.',
      ),
    ).toMatchObject({ kind: 'footer', includedInReadingOrder: false })
  })

  it('keeps repeated URL notes when dense chart labels skew page font statistics', async () => {
    const chartLabels = Array.from({ length: 48 }, (_, index) =>
      run(
        1,
        String(index),
        0.12 + (index % 8) * 0.09,
        0.38 + Math.floor(index / 8) * 0.045,
        0.03,
        3.5,
        0.006,
      ),
    )
    const note = (pageNumber: number, label: string) => {
      const marker = run(pageNumber, label, 0.197, 0.909, 0.005, 6, 0.0075)
      const url = run(
        pageNumber,
        'https://github.com/example/repeated-source',
        0.203,
        0.91,
        0.42,
        9,
        0.0113,
      )
      url.fontName = 'SyntheticMono'
      return [marker, url]
    }
    const prose = (pageNumber: number) => [
      run(
        pageNumber,
        'Ordinary scholarly prose establishes the actual body font.',
        0.176,
        0.18,
        0.64,
      ),
      run(
        pageNumber,
        'A second continuous sentence supplies stable prose evidence.',
        0.176,
        0.21,
        0.64,
      ),
      run(
        pageNumber,
        'A third continuous sentence supplies stable prose evidence.',
        0.176,
        0.24,
        0.64,
      ),
    ]
    const result = await reconstruct([
      page(1, [...prose(1), ...chartLabels, ...note(1, '8')]),
      page(2, [...prose(2), ...note(2, '9')]),
    ])

    expect(
      result.regions
        .filter((region) => region.kind === 'footnote')
        .map((region) => region.text),
    ).toEqual([
      '8 https://github.com/example/repeated-source',
      '9 https://github.com/example/repeated-source',
    ])
  })

  it('does not classify repeated table-cell symbols as page margins', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Table heading', 0.1, 0.06, 0.3, 10),
        run(1, '✓', 0.45, 0.083, 0.03, 8),
        run(1, 'First table row', 0.1, 0.083, 0.25, 8),
      ]),
      page(2, [
        run(2, 'Another table heading', 0.1, 0.06, 0.3, 10),
        run(2, '✓', 0.45, 0.083, 0.03, 8),
        run(2, 'Second table row', 0.1, 0.083, 0.25, 8),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => region.text === '✓')
        .every(
          (region) => region.kind !== 'header' && region.kind !== 'footer',
        ),
    ).toBe(true)
  })

  it('reconstructs complete wrapped captions without swallowing following prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 1. A complete synthetic caption whose first',
          0.54,
          0.2,
          0.36,
          9,
        ),
        run(1, 'line wraps into this concluding line.', 0.54, 0.222, 0.25, 9),
        run(
          1,
          'Following body prose remains independent.',
          0.56,
          0.27,
          0.34,
          10,
        ),
        run(
          1,
          'Its continuation remains in the prose flow.',
          0.54,
          0.292,
          0.36,
          10,
        ),
      ]),
    ])

    const captions = result.regions.filter(
      (region) => region.kind === 'caption',
    )
    expect(captions).toHaveLength(1)
    expect(captions[0]).toMatchObject({
      column: 'single',
      text: 'Figure 1. A complete synthetic caption whose first line wraps into this concluding line.',
    })
    expect(captions[0].lines).toHaveLength(2)
    expect(
      result.paper.nodes.find((node) => node.type === 'caption'),
    ).toMatchObject({ text: captions[0].text })
    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' && node.text.includes('Following body'),
      ),
    ).toMatchObject({
      text: 'Following body prose remains independent. Its continuation remains in the prose flow.',
    })
  })

  it('keeps a bottom-edge caption continuation misclassified as footer when it completes a split word', async () => {
    const result = await reconstruct([
      withExplicitEnglishLanguage(
        page(1, [
          run(
            1,
            'Predicted probabilities establish the body size.',
            0.12,
            0.2,
            0.37,
            11,
          ),
          run(
            1,
            'STRUCTURED-DETECT appears elsewhere in the source.',
            0.12,
            0.22,
            0.37,
            11,
          ),
          run(
            1,
            'Table 5: ROC-AUC score of predicted contradiction probabili-',
            0.514,
            0.88648,
            0.37,
            9,
            0.01065,
          ),
          run(
            1,
            'ties for different methods on our evaluation set. STRUCTURED-',
            0.514,
            0.89831,
            0.369,
            9,
            0.01065,
          ),
          run(
            1,
            'DETECT outperforms our two entailment-based baselines.',
            0.515,
            0.91014,
            0.347,
            9,
            0.01065,
          ),
        ]),
      ),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Table 5: ROC-AUC score of predicted contradiction probabilities for different methods on our evaluation set. STRUCTURED-DETECT outperforms our two entailment-based baselines.',
        lines: expect.arrayContaining([
          expect.objectContaining({
            text: 'DETECT outperforms our two entailment-based baselines.',
          }),
        ]),
      }),
    ])
    expect(
      result.regions.some(
        (region) =>
          region.kind === 'footer' &&
          region.text.includes('DETECT outperforms'),
      ),
    ).toBe(false)
  })

  it('keeps a quoted inline formula on the final line of a caption', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure I: The model tried to simplify the goal but failed.',
          0.176,
          0.2,
          0.65,
          9,
          0.012,
        ),
        run(
          1,
          'Then it rewrote the goal from “a + b + c',
          0.176,
          0.214,
          0.648,
          9,
          0.012,
        ),
        run(
          1,
          '= a + c + b” to “b + a + c = a + c + b”.',
          0.176,
          0.228,
          0.32,
          9,
          0.012,
        ),
        run(1, 'Following body prose remains separate.', 0.176, 0.27, 0.4, 9),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Figure I: The model tried to simplify the goal but failed. Then it rewrote the goal from “a + b + c = a + c + b” to “b + a + c = a + c + b”.',
        lines: expect.arrayContaining([
          expect.objectContaining({
            text: '= a + c + b” to “b + a + c = a + c + b”.',
          }),
        ]),
      }),
    ])
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text === 'Following body prose remains separate.',
      ),
    ).toBe(true)
  })

  it('ignores a tall inline symbol when comparing caption continuation type size', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 5. If an optimal representation exists, larger hypothesis spaces are more likely to',
          0.09,
          0.2,
          0.795,
          9,
          0.0113,
        ),
        run(
          1,
          'cover it. LEFT: Two small models find different solutions (marked by outlined',
          0.091,
          0.214,
          0.69,
          9,
          0.0113,
        ),
        run(1, '☆', 0.783, 0.211, 0.016, 11.25, 0.0142),
        run(1, '). RIGHT: As', 0.799, 0.214, 0.086, 9, 0.0113),
        run(
          1,
          'the models become larger, they converge to the same solution (marked by filled ⋆).',
          0.091,
          0.228,
          0.63,
          9,
          0.0119,
        ),
        run(1, 'Following prose remains separate.', 0.09, 0.27, 0.39),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Figure 5. If an optimal representation exists, larger hypothesis spaces are more likely to cover it. LEFT: Two small models find different solutions (marked by outlined ☆). RIGHT: As the models become larger, they converge to the same solution (marked by filled ⋆).',
        lines: expect.arrayContaining([
          expect.objectContaining({
            text: 'cover it. LEFT: Two small models find different solutions (marked by outlined ☆). RIGHT: As',
          }),
        ]),
      }),
    ])
  })

  it('requires the dominant caption font family instead of an incidental shared run', async () => {
    const seed = {
      ...run(1, 'Figure 6. A', 0.09, 0.2, 0.22, 9, 0.011),
      fontName: 'CaptionSerif-BoldMT',
    }
    const seedShared = {
      ...run(1, 'zz', 0.32, 0.2, 0.02, 9, 0.011),
      fontName: 'SharedSymbol',
    }
    const candidate = {
      ...run(1, 'continued', 0.09, 0.214, 0.2, 9, 0.011),
      fontName: 'BodySans-Regular',
    }
    const candidateShared = {
      ...run(1, 'zz', 0.3, 0.214, 0.02, 9, 0.011),
      fontName: 'SharedSymbol',
    }
    const result = await reconstruct([
      page(1, [seed, seedShared, candidate, candidateShared]),
    ])
    const caption = result.regions.find((region) => region.kind === 'caption')
    expect(caption).toBeDefined()
    expect(caption?.text).toContain('Figure 6.')
    expect(caption?.text).not.toContain('continued')
    expect(
      result.paper.nodes.some(
        (node) => node.type === 'paragraph' && node.text.includes('continued'),
      ),
    ).toBe(true)
  })

  it('normalizes PostScript MT suffixes when matching caption font families', async () => {
    const seed = {
      ...run(
        1,
        'Figure 7. A caption continues across lines',
        0.09,
        0.2,
        0.7,
        9,
        0.011,
      ),
      fontName: 'Arial-BoldMT',
    }
    const candidate = {
      ...run(1, 'with the same family.', 0.09, 0.214, 0.3, 9, 0.011),
      fontName: 'ArialMT',
    }
    const result = await reconstruct([page(1, [seed, candidate])])
    expect(
      result.regions.find((region) => region.kind === 'caption')?.text,
    ).toContain('with the same family.')
  })

  it('normalizes PostScript PS markers independently of style suffixes', async () => {
    const seed = {
      ...run(
        1,
        'Figure 8. A caption continues across lines',
        0.09,
        0.2,
        0.7,
        9,
        0.011,
      ),
      fontName: 'TimesNewRomanPS-BoldMT',
    }
    const candidate = {
      ...run(1, 'with the same family.', 0.09, 0.214, 0.3, 9, 0.011),
      fontName: 'TimesNewRomanPSMT',
    }
    const result = await reconstruct([page(1, [seed, candidate])])
    expect(
      result.regions.find((region) => region.kind === 'caption')?.text,
    ).toContain('with the same family.')
  })

  it('preserves opaque PDF.js font IDs and recognizes abbreviated style suffixes', () => {
    expect(captionFontFamily('g_d0_f1')).toBe('gd0f1')
    expect(captionFontFamily('g_d0_f1')).not.toBe(captionFontFamily('g_d0_f2'))
    expect(captionFontFamily('HelveticaNeueLTStd-Bd')).toBe(
      captionFontFamily('HelveticaNeueLTStd-Regular'),
    )
    expect(captionFontFamily('MinionPro-It')).toBe(
      captionFontFamily('MinionPro-Regular'),
    )
    expect(captionFontFamily('NimbusRomNo9L-Medi')).toBe(
      captionFontFamily('NimbusRomNo9L-Regu'),
    )
    expect(captionFontFamily('NimbusRomNo9L-ReguItal')).toBe(
      captionFontFamily('NimbusRomNo9L-Ital'),
    )
  })

  it('keeps caption continuations together when opposite-column prose interleaves by y', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 19. A left-column caption begins with a long first',
          0.09,
          0.68,
          0.383,
          9,
          0.011,
        ),
        run(
          1,
          'Right-column prose is geometrically interleaved.',
          0.502,
          0.691,
          0.382,
          10,
          0.012,
        ),
        run(
          1,
          'line and continues at the same left-column indent before',
          0.091,
          0.696,
          0.382,
          9,
          0.011,
        ),
        run(
          1,
          'More right-column prose follows independently.',
          0.502,
          0.706,
          0.382,
          10,
          0.012,
        ),
        run(1, 'ending with a short final line.', 0.091, 0.712, 0.19, 9, 0.011),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Figure 19. A left-column caption begins with a long first line and continues at the same left-column indent before ending with a short final line.',
        lines: expect.arrayContaining([
          expect.objectContaining({
            text: 'ending with a short final line.',
          }),
        ]),
      }),
    ])
    expect(
      result.paper.nodes.filter((node) => node.type === 'caption'),
    ).toHaveLength(1)
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph')
        .map((node) => node.text)
        .join(' '),
    ).toContain('Right-column prose is geometrically interleaved.')
  })

  it('keeps interleaved side-by-side figure captions as separate regions', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 30. Left result begins here',
          0.09,
          0.28,
          0.383,
          9,
          0.009,
        ),
        run(
          1,
          'Figure 32. Right result begins here',
          0.502,
          0.291,
          0.383,
          9,
          0.009,
        ),
        run(1, 'and finishes in its own column.', 0.09, 0.294, 0.24, 9, 0.009),
        run(1, 'and continues on the right', 0.502, 0.305, 0.28, 9, 0.009),
        run(1, 'before ending there.', 0.502, 0.319, 0.2, 9, 0.009),
      ]),
    ])

    const captions = result.regions
      .filter((region) => region.kind === 'caption')
      .map((region) => region.text)
    expect(captions).toHaveLength(2)
    expect(captions[0]).toMatch(/^Figure 30\./)
    expect(captions[0]).toContain('finishes in its own column')
    expect(captions[1]).toMatch(/^Figure 32\./)
    expect(captions[1]).toContain('continues on the right')
    expect(captions[1]).toContain('ending there')
  })

  it('classifies same-baseline gutter-partitioned table captions as separate regions', async () => {
    const layoutRuns = [
      run(1, 'Left column establishes the layout.', 0.09, 0.1, 0.37),
      run(1, 'Right column establishes the layout.', 0.54, 0.1, 0.37),
      run(1, 'Left column remains independent.', 0.09, 0.14, 0.37),
      run(1, 'Right column remains independent.', 0.54, 0.14, 0.37),
      run(1, 'Left column has a third row.', 0.09, 0.18, 0.37),
      run(1, 'Right column has a third row.', 0.54, 0.18, 0.37),
    ]
    const captionRuns = [
      run(1, 'Table', 0.09, 0.4, 0.04, 9, 0.009),
      run(1, '2.', 0.135, 0.4, 0.018, 9, 0.009),
      run(1, 'Left benchmark results.', 0.158, 0.4, 0.395, 9, 0.009),
      run(1, 'Table', 0.562, 0.4, 0.04, 9, 0.009),
      run(1, '3.', 0.607, 0.4, 0.018, 9, 0.009),
      run(1, 'Right ablation results.', 0.63, 0.4, 0.251, 9, 0.009),
      run(1, 'Left caption continuation.', 0.09, 0.4113, 0.463, 9, 0.009),
      run(1, 'Right caption continuation.', 0.562, 0.4113, 0.319, 9, 0.009),
    ]
    const result = await reconstruct([page(1, [...layoutRuns, ...captionRuns])])

    const captions = result.regions.filter(
      (region) => region.kind === 'caption',
    )
    expect(
      captions.map(({ text, column, sourceCaptionLane }) => ({
        text,
        column,
        sourceCaptionLane,
      })),
    ).toEqual([
      {
        text: 'Table 2. Left benchmark results. Left caption continuation.',
        column: 'span',
        sourceCaptionLane: {
          boundary: expect.closeTo(0.5575, 4),
          side: 'left',
        },
      },
      {
        text: 'Table 3. Right ablation results. Right caption continuation.',
        column: 'right',
        sourceCaptionLane: {
          boundary: expect.closeTo(0.5575, 4),
          side: 'right',
        },
      },
    ])
    expect(captions[0].box.x + captions[0].box.width).toBeLessThan(
      captions[1].box.x,
    )
    expect(captions[0].text).not.toContain('Right caption')
    expect(captions[1].text).not.toContain('Left caption')
    const sourceRunKey = (sourceRun: PdfSourceRun) =>
      [
        sourceRun.text,
        sourceRun.x,
        sourceRun.y,
        sourceRun.width,
        sourceRun.height,
      ].join('|')
    const captionOutputRuns = captions.flatMap((caption) =>
      caption.lines.flatMap((line) => line.runs),
    )
    for (const sourceRun of captionRuns) {
      expect(
        captionOutputRuns.filter(
          (candidate) => sourceRunKey(candidate) === sourceRunKey(sourceRun),
        ),
      ).toHaveLength(1)
    }
    const leftLineIds = new Set(captions[0].lines.map((line) => line.id))
    expect(captions[1].lines.some((line) => leftLineIds.has(line.id))).toBe(
      false,
    )
    for (const caption of captions) {
      const [seed, ...continuations] = caption.lines
      expect(continuations).not.toHaveLength(0)
      expect(
        continuations.every(
          (line) => line.captionContinuationSeedId === seed.id,
        ),
      ).toBe(true)
    }
    expect(
      result.visualRelationships
        .filter((relationship) => relationship.kind === 'table')
        .map(({ label, captionRegionId }) => ({ label, captionRegionId })),
    ).toEqual([
      {
        label: 'Table 2',
        captionRegionId: expect.stringMatching(/region/u),
      },
      {
        label: 'Table 3',
        captionRegionId: expect.stringMatching(/region/u),
      },
    ])
  })

  it('fails closed when two source partitions claim the same local-caption continuation band', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Left column layout row one.', 0.09, 0.1, 0.37),
        run(1, 'Right column layout row one.', 0.54, 0.1, 0.37),
        run(1, 'Left column layout row two.', 0.09, 0.14, 0.37),
        run(1, 'Right column layout row two.', 0.54, 0.14, 0.37),
        run(1, 'Left column layout row three.', 0.09, 0.18, 0.37),
        run(1, 'Right column layout row three.', 0.54, 0.18, 0.37),
        run(1, 'Table 2. Left benchmark results', 0.09, 0.4, 0.463, 9, 0.009),
        run(1, 'Table 3. Right ablation results', 0.562, 0.4, 0.319, 9, 0.009),
        run(1, 'Left continuation candidate.', 0.09, 0.4113, 0.453, 9, 0.009),
        run(1, 'ambiguous', 0.547, 0.4113, 0.008, 9, 0.009),
        run(1, 'Right continuation candidate.', 0.562, 0.4113, 0.319, 9, 0.009),
      ]),
    ])

    const captions = result.regions.filter(
      (region) => region.kind === 'caption',
    )
    expect(captions.map((caption) => caption.text)).toEqual([
      'Table 2. Left benchmark results',
      'Table 3. Right ablation results',
    ])
    expect(
      captions.some((caption) => /continuation candidate/iu.test(caption.text)),
    ).toBe(false)
    expect(
      result.regions
        .filter((region) => region.kind !== 'caption')
        .map((region) => region.text)
        .join(' '),
    ).toContain('continuation candidate')
  })

  it('keeps interleaved multi-panel label continuations with their source panel', () => {
    const result = reconstructPageRegions([
      page(
        1,
        [
          run(
            1,
            '(a) SEQCODER-1.5B accuracy as a function of',
            0.176,
            0.277,
            0.291,
            9,
            0.011,
          ),
          run(
            1,
            '(b) SEQCODER-1.5B accuracy as a function of',
            0.532,
            0.277,
            0.291,
            9,
            0.011,
          ),
          run(1, 'gold program lengths.', 0.176, 0.29, 0.129, 9, 0.011),
          run(1, 'input sequence lengths.', 0.532, 0.29, 0.137, 9, 0.011),
          run(
            1,
            'Figure 11: Accuracy as a function of program and input sequence lengths.',
            0.182,
            0.315,
            0.635,
            9,
            0.013,
          ),
        ],
        [
          {
            id: 'panel-a',
            page: 1,
            kind: 'image',
            box: {
              page: 1,
              x: 0.176,
              y: 0.103,
              width: 0.291,
              height: 0.169,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 1,
            assetId: null,
          },
          {
            id: 'panel-b',
            page: 1,
            kind: 'image',
            box: {
              page: 1,
              x: 0.532,
              y: 0.103,
              width: 0.291,
              height: 0.169,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 1,
            assetId: null,
          },
        ],
      ),
    ])

    expect(
      result.regions
        .filter((region) => /^\([ab]\)/u.test(region.text))
        .map((region) => region.text),
    ).toEqual([
      '(a) SEQCODER-1.5B accuracy as a function of gold program lengths.',
      '(b) SEQCODER-1.5B accuracy as a function of input sequence lengths.',
    ])
  })

  it('keeps prose with inline equations in the complete caption', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 16. We plot the magnitude of each Fourier feature.',
          0.09,
          0.2,
          0.39,
          9,
        ),
        run(
          1,
          'The period T = 2 component is omitted from the plotted basis.',
          0.09,
          0.222,
          0.39,
          9,
        ),
        run(
          1,
          'Its output is measured on a different scale.',
          0.09,
          0.244,
          0.32,
          9,
        ),
        run(1, 'Following body prose.', 0.09, 0.29, 0.39, 10),
      ]),
    ])

    const caption = result.regions.find((region) => region.kind === 'caption')
    expect(caption?.text).toBe(
      'Figure 16. We plot the magnitude of each Fourier feature. The period T = 2 component is omitted from the plotted basis. Its output is measured on a different scale.',
    )
    expect(caption?.lines).toHaveLength(3)
    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' && node.text === 'Following body prose.',
      ),
    ).toBeDefined()
  })

  it('keeps split caption prose and source-backed stacked formula obligations', async () => {
    const mathRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontSize: number,
      height: number,
      fontName: string,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
    })
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 8. An inline formula is preserved by',
          0.5,
          0.2,
          0.385,
          9,
          0.01132,
        ),
        run(
          1,
          'helix(x). We use evidence to show that',
          0.5,
          0.214,
          0.305,
          9,
          0.01132,
        ),
        mathRun('l', 0.8197, 0.213, 0.004, 6, 0.00755, 'Synthetic+CMMI6'),
        mathRun('=', 0.8197, 0.2208, 0.009, 6, 0.00755, 'Synthetic+CMR6'),
        mathRun('h', 0.811, 0.214, 0.0087, 9, 0.01132, 'Synthetic+CMMI9'),
        run(1, 'for', 0.835, 0.214, 0.02, 9, 0.01132),
        run(
          1,
          'the model in every evaluated layer.',
          0.5,
          0.228,
          0.24,
          9,
          0.01132,
        ),
      ]),
    ])

    const caption = result.paper.nodes.find((node) => node.type === 'caption')
    expect(caption?.text).toContain(
      'Figure 8. An inline formula is preserved by helix(x). We use evidence to show that',
    )
    expect(caption?.text).toContain('for the model in every evaluated layer.')
    expect(caption?.text).not.toContain('hl=')
    const formulaNodes = result.paper.nodes.filter(
      (node) =>
        node.type === 'paragraph' &&
        /^(?:l=h|hl=)(?:\s+for)?$/u.test(node.text),
    )
    expect(formulaNodes).toEqual([
      expect.objectContaining({
        type: 'paragraph',
        text: 'hl=',
        inlineRuns: expect.arrayContaining([
          expect.objectContaining({ verticalAlign: 'superscript' }),
          expect.objectContaining({ verticalAlign: 'subscript' }),
        ]),
      }),
    ])
    expect(result.provenance[formulaNodes[0].id]?.boxes.length).toBeGreaterThan(
      0,
    )
    const captionRegion = result.regions.find(
      (region) => region.kind === 'caption',
    )
    expect(
      captionRegion?.lines.flatMap((line) =>
        line.runs.map((sourceRun) => sourceRun.text),
      ),
    ).toEqual(expect.arrayContaining(['for']))
    expect(
      captionRegion?.lines.flatMap((line) =>
        line.runs.map((sourceRun) => sourceRun.text),
      ),
    ).not.toEqual(expect.arrayContaining(['h', 'l', '=']))

    expect(
      result.visualRelationships.find(
        (relationship) =>
          relationship.kind === 'equation' &&
          relationship.evidence.includes('source-text-transcript-unresolved'),
      ),
    ).toMatchObject({
      status: 'unresolved',
      sourceText: '',
      altTextSource: 'caption',
    })
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNRESOLVED_VISUAL_OBJECT',
      ]),
    })
    expect(result.completeness.expectedInlineSpanCount).toBeGreaterThan(0)

    const epub = await buildReadableEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toContain('<em>h</em><sup><em>l</em></sup><sub>=</sub>')
    expect(content).not.toContain('>Display equation p001-001<')
    expect(content).not.toContain('orphan-caption omitted-visual')
  })

  it('keeps a short sentence-like inline equation continuation in its caption', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 39. We analyze each selected neuron’s maximally',
          0.09,
          0.28,
          0.79,
          9,
          0.011,
        ),
        run(1, 'activating a + b example.', 0.091, 0.294, 0.15, 9, 0.011),
        run(1, 'Following prose remains separate.', 0.09, 0.35, 0.36, 9),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Figure 39. We analyze each selected neuron’s maximally activating a + b example.',
        lines: expect.arrayContaining([
          expect.objectContaining({ text: 'activating a + b example.' }),
        ]),
      }),
    ])
  })

  it('keeps enumerated subfigure prose in one complete caption', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 1. Comparison of three strategies. (a) Fixed planning.',
          0.54,
          0.2,
          0.36,
          9,
        ),
        run(
          1,
          '(b) Interactive planning. The proposed method appears in (c).',
          0.54,
          0.222,
          0.36,
          9,
        ),
        run(
          1,
          'Following body prose remains independent.',
          0.54,
          0.27,
          0.34,
          10,
        ),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Figure 1. Comparison of three strategies. (a) Fixed planning. (b) Interactive planning. The proposed method appears in (c).',
        lines: expect.arrayContaining([
          expect.objectContaining({
            text: '(b) Interactive planning. The proposed method appears in (c).',
          }),
        ]),
      }),
    ])
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text === 'Following body prose remains independent.',
      ),
    ).toBe(true)
  })

  it('keeps an inline abbreviated figure reference in continuous body prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'The comparison is continued in', 0.12, 0.2, 0.34, 10, 0.018),
        run(
          1,
          'Fig. 8. Specifically, the discussion follows the same protocol',
          0.12,
          0.218,
          0.52,
          10,
          0.018,
        ),
        run(
          1,
          'and remains part of the surrounding paragraph.',
          0.12,
          0.236,
          0.4,
          10,
          0.018,
        ),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([])
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph')
        .map((node) => node.text),
    ).toEqual([
      'The comparison is continued in Fig. 8. Specifically, the discussion follows the same protocol and remains part of the surrounding paragraph.',
    ])
  })

  it('stops after a short terminal caption even when prose follows at normal leading', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Figure 2. A short caption.', 0.1, 0.2, 0.2, 9),
        run(
          1,
          'Following prose begins without an extra vertical gap.',
          0.1,
          0.222,
          0.38,
          9,
        ),
        run(
          1,
          'Its second line remains ordinary body text.',
          0.1,
          0.244,
          0.34,
          9,
        ),
      ]),
    ])

    expect(
      result.regions.find((region) => region.kind === 'caption'),
    ).toMatchObject({
      text: 'Figure 2. A short caption.',
      lines: [expect.objectContaining({ text: 'Figure 2. A short caption.' })],
    })
    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' && node.text.startsWith('Following prose'),
      ),
    ).toMatchObject({
      text: 'Following prose begins without an extra vertical gap. Its second line remains ordinary body text.',
    })
  })

  it('keeps a multi-line page-spanning table caption in one caption region', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Left column establishes a stable layout.', 0.08, 0.1, 0.34),
        run(1, 'Left column continues in source order.', 0.08, 0.13, 0.34),
        run(1, 'Right column establishes a stable layout.', 0.58, 0.1, 0.34),
        run(1, 'Right column continues in source order.', 0.58, 0.13, 0.34),
        run(
          1,
          'Table 1. Comparison across all evaluated systems and',
          0.08,
          0.4,
          0.84,
          9,
        ),
        run(
          1,
          'the dimensions included by each benchmark.',
          0.08,
          0.422,
          0.64,
          9,
        ),
        run(1, 'Subsequent prose starts after the caption.', 0.08, 0.48, 0.34),
        run(1, 'A second prose line follows normally.', 0.08, 0.502, 0.34),
      ]),
    ])

    const caption = result.regions.find((region) => region.kind === 'caption')
    expect(caption).toMatchObject({
      column: 'span',
      text: 'Table 1. Comparison across all evaluated systems and the dimensions included by each benchmark.',
    })
    expect(caption?.lines).toHaveLength(2)
    expect(
      result.paper.nodes.filter((node) => node.type === 'caption'),
    ).toEqual([expect.objectContaining({ text: caption?.text })])
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text.includes('Subsequent prose starts after the caption.'),
      ),
    ).toBe(true)
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

  it('matches a page-wide symbolic footnote and emits EPUB note semantics and backlinks', async () => {
    const result = await reconstruct(
      [
        page(1, [
          run(1, 'Page-Wide Symbolic Notes', 0.2, 0.06, 0.6, 18, 0.03),
          run(1, 'Ada Example', 0.4, 0.13, 0.2, 11),
          run(1, 'Abstract', 0.08, 0.22, 0.18, 14),
          run(
            1,
            'This abstract establishes a source-backed scholarly document.',
            0.08,
            0.27,
            0.84,
          ),
          run(1, '1 Regions', 0.35, 0.39, 0.3, 16, 0.03),
          run(1, 'Left one.', 0.08, 0.5, 0.32),
          run(1, 'Left two.', 0.08, 0.54, 0.32),
          run(1, 'Left marker', 0.08, 0.58, 0.24),
          run(1, '*', 0.325, 0.583, 0.008, 6, 0.009),
          run(1, 'Right one.', 0.56, 0.5, 0.32),
          run(1, 'Right two.', 0.56, 0.54, 0.32),
          run(1, 'Right three.', 0.56, 0.58, 0.32),
          run(
            1,
            '*. A note spanning the full page width.',
            0.08,
            0.84,
            0.84,
            7,
          ),
        ]),
      ],
      '8',
    )

    expect(result.noteRelationships).toEqual([
      expect.objectContaining({
        label: '*',
        status: 'matched',
        evidence: expect.arrayContaining(['page-wide-note-region']),
      }),
    ])
    expect(result.readiness.ready).toBe(true)
    const epub = await buildEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toContain('epub:type="noteref"')
    expect(content).toContain('epub:type="footnote"')
    expect(content).toContain('class="note-backlink"')
  })

  it('splits independently run-backed symbolic note definitions on one source line', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Run-backed author notes', 0.1, 0.08, 0.72, 18),
        run(1, 'Ada Example', 0.2, 0.15, 0.12, 11),
        run(1, '*', 0.321, 0.146, 0.008, 6, 0.009),
        run(1, 'Ben Reader', 0.35, 0.15, 0.12, 11),
        run(1, '†', 0.471, 0.146, 0.008, 6, 0.009),
        run(1, 'Abstract', 0.1, 0.28, 0.25, 16),
        run(1, 'The abstract remains canonical prose.', 0.1, 0.34, 0.72),
        run(1, '*', 0.1, 0.856, 0.008, 6, 0.009),
        run(1, 'Lead author.', 0.109, 0.86, 0.1, 8),
        run(1, '†', 0.22, 0.854, 0.008, 6, 0.009),
        run(1, 'Core contributor.', 0.229, 0.86, 0.14, 8),
      ]),
    ])

    const sourceNotes = result.regions.filter(
      (region) => region.kind === 'footnote',
    )
    expect(
      sourceNotes.map((region) => ({
        id: region.id,
        text: region.text,
        runs: region.lines.flatMap((line) =>
          line.runs.map((sourceRun) => sourceRun.text),
        ),
      })),
    ).toEqual([
      {
        id: expect.stringMatching(/page-001-region-\d{3}$/),
        text: '* Lead author.',
        runs: ['*', 'Lead author.'],
      },
      {
        id: expect.stringMatching(/page-001-region-\d{3}-note-002$/),
        text: '†Core contributor.',
        runs: ['†', 'Core contributor.'],
      },
    ])
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'footnote')
        .map((node) => ({
          label: node.label,
          text: node.text,
          backlinkCount: node.relationships.backlinks.length,
          sourceRuns: result.provenance[node.id].boxes.map((box) =>
            'text' in box ? box.text : undefined,
          ),
        })),
    ).toEqual([
      {
        label: '*',
        text: 'Lead author.',
        backlinkCount: 1,
        sourceRuns: ['*', 'Lead author.'],
      },
      {
        label: '†',
        text: 'Core contributor.',
        backlinkCount: 1,
        sourceRuns: ['†', 'Core contributor.'],
      },
    ])
    expect(
      result.noteRelationships.map((relationship) => ({
        label: relationship.label,
        status: relationship.status,
        targetRegionId: relationship.candidates[0]?.targetRegionId,
      })),
    ).toEqual([
      {
        label: '*',
        status: 'matched',
        targetRegionId: sourceNotes[0].id,
      },
      {
        label: '†',
        status: 'matched',
        targetRegionId: sourceNotes[1].id,
      },
    ])
  })

  it('does not split a symbol embedded inside a prose run', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Body line one.', 0.1, 0.2, 0.7, 10),
        run(1, 'Body line two.', 0.1, 0.25, 0.7, 10),
        run(1, 'Body line three.', 0.1, 0.3, 0.7, 10),
        run(1, '*', 0.1, 0.856, 0.008, 6, 0.009),
        run(1, 'Lead author. †Core contributor.', 0.109, 0.86, 0.26, 8),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => region.kind === 'footnote')
        .map((region) => ({
          id: region.id,
          text: region.text,
          runs: region.lines.flatMap((line) =>
            line.runs.map((sourceRun) => sourceRun.text),
          ),
        })),
    ).toEqual([
      {
        id: expect.stringMatching(/page-001-region-\d{3}$/),
        text: '* Lead author. †Core contributor.',
        runs: ['*', 'Lead author. †Core contributor.'],
      },
    ])
  })

  it('retains a near-body-size symbolic bottom note as a footnote', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Body line one.', 0.08, 0.2, 0.7, 10),
        run(1, 'Body line two.', 0.08, 0.25, 0.7, 10),
        run(1, 'Body line three.', 0.08, 0.3, 0.7, 10),
        run(1, '* Work done during the internship.', 0.08, 0.86, 0.7, 9.5),
      ]),
    ])

    expect(result.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'footnote',
          text: expect.stringContaining('Work done during the internship.'),
        }),
      ]),
    )
    expect(
      result.paper.nodes.some(
        (node) => node.type === 'footnote' && node.text.includes('Work done'),
      ),
    ).toBe(true)
  })

  it('separates an attached raised affiliation note before paragraph joining', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Introduction', 0.1, 0.12, 0.3, 16),
        run(1, 'Body line one.', 0.1, 0.2, 0.7, 10),
        run(1, 'Body line two.', 0.1, 0.25, 0.7, 10),
        run(1, 'Body line three.', 0.1, 0.3, 0.7, 10),
        run(1, 'LLMs use a form', 0.1, 0.82, 0.32, 10),
        run(1, '1', 0.1, 0.848, 0.008, 6, 0.008),
        run(
          1,
          'Example Institute. Correspondence to:',
          0.108,
          0.849,
          0.52,
          9,
          0.016,
        ),
        run(1, 'Ada <ada@example.edu>.', 0.1, 0.866, 0.36, 9, 0.016),
      ]),
    ])

    const note = result.regions.find((region) => region.kind === 'footnote')
    const prose = result.regions
      .filter((region) => region.kind === 'body')
      .map((region) => region.text)
      .join(' ')

    expect(note).toMatchObject({
      kind: 'footnote',
      text: '1 Example Institute. Correspondence to: Ada <ada@example.edu>.',
    })
    expect(note?.lines).toHaveLength(2)
    expect(prose).toContain('LLMs use a form')
    expect(prose).not.toContain('Example Institute')
    expect(
      result.paper.nodes.find((node) => node.type === 'footnote'),
    ).toMatchObject({
      label: '1',
      text: 'Example Institute. Correspondence to: Ada <ada@example.edu>.',
    })
  })

  it('keeps a wrapped symbolic note continuation in the note', async () => {
    const result = await reconstruct([
      withExplicitEnglishLanguage(
        page(1, [
          run(1, 'LightSpeed Studios, Tencent', 0.2, 0.1, 0.5, 9),
          run(1, 'Body line one.', 0.08, 0.2, 0.7, 10),
          run(1, 'Body line two.', 0.08, 0.25, 0.7, 10),
          run(1, 'Body line three.', 0.08, 0.3, 0.7, 10),
          run(
            1,
            '*Work done during the internship at Tencent Lightspeed stu-',
            0.109,
            0.862,
            0.369,
            9,
            0.011,
          ),
          run(1, 'dios.', 0.088, 0.875, 0.028, 9, 0.011),
        ]),
      ),
    ])

    expect(
      result.paper.nodes.find((node) => node.type === 'footnote'),
    ).toMatchObject({
      text: '*Work done during the internship at Tencent Lightspeed studios.',
    })
    expect(
      result.paper.nodes.some(
        (node) => node.type === 'paragraph' && node.text.includes('dios.'),
      ),
    ).toBe(false)
  })

  it('keeps short continuation lines with page-wide numbered footnotes', async () => {
    const result = await reconstruct([
      withExplicitEnglishLanguage(
        page(1, [
          run(
            1,
            'Left-column prose establishes the first column.',
            0.08,
            0.2,
            0.34,
          ),
          run(
            1,
            'Right-column prose establishes the second column.',
            0.56,
            0.2,
            0.34,
          ),
          run(1, 'More left-column prose continues below.', 0.08, 0.24, 0.34),
          run(1, 'More right-column prose continues below.', 0.56, 0.24, 0.34),
          run(1, 'Final left-column evidence.', 0.08, 0.28, 0.34),
          run(1, 'Final right-column evidence.', 0.56, 0.28, 0.34),
          run(
            1,
            '2 We found that response tokens yield more effective steering directions than alternative positions such as',
            0.197,
            0.87,
            0.626,
            8,
            0.012,
          ),
          run(
            1,
            'prompt tokens (see Appendix A.3).',
            0.176,
            0.884,
            0.207,
            8,
            0.011,
          ),
          run(
            1,
            '3 We show results for four additional traits, including positive traits such as optimism and humor, in Ap-',
            0.197,
            0.897,
            0.626,
            8,
            0.012,
          ),
          run(1, 'pendix G.', 0.176, 0.911, 0.058, 8, 0.011),
        ]),
      ),
    ])

    expect(
      result.paper.nodes
        .filter((node) => node.type === 'footnote')
        .map((node) => ({ label: node.label, text: node.text })),
    ).toEqual([
      {
        label: '2',
        text: 'We found that response tokens yield more effective steering directions than alternative positions such as prompt tokens (see Appendix A.3).',
      },
      {
        label: '3',
        text: 'We show results for four additional traits, including positive traits such as optimism and humor, in Appendix G.',
      },
    ])
  })

  it('keeps a wrapped URL continuation in its symbolic footnote', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Body line one.', 0.08, 0.2, 0.7, 10),
        run(1, 'Body line two.', 0.08, 0.25, 0.7, 10),
        run(1, 'Body line three.', 0.08, 0.3, 0.7, 10),
        run(
          1,
          '* The implementation is available at https://github.',
          0.109,
          0.862,
          0.369,
          9,
          0.011,
        ),
        run(1, 'com/example/project', 0.088, 0.875, 0.16, 9, 0.011),
      ]),
    ])

    expect(
      result.paper.nodes.find((node) => node.type === 'footnote'),
    ).toMatchObject({
      text: 'The implementation is available at https://github.com/example/project',
    })
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text.includes('com/example/project'),
      ),
    ).toBe(false)
  })

  it('retains unresolved and equally plausible note candidates as explicit diagnostics', async () => {
    const unresolved = await reconstruct([
      page(1, [run(1, 'A claim with an unavailable note[3].', 0.1, 0.2, 0.72)]),
    ])
    expect(unresolved.noteRelationships).toEqual([
      expect.objectContaining({
        label: '3',
        status: 'unresolved',
        targetNoteId: null,
        candidates: [],
      }),
    ])
    expect(unresolved.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNRESOLVED_NOTE_REFERENCE' }),
      ]),
    )

    const ambiguous = await reconstruct([
      page(1, [
        run(1, 'Left one.', 0.08, 0.2, 0.32),
        run(1, 'Left two.', 0.08, 0.24, 0.32),
        run(1, 'Left three.', 0.08, 0.28, 0.32),
        run(1, 'Right one.', 0.56, 0.2, 0.32),
        run(1, 'Right two.', 0.56, 0.24, 0.32),
        run(1, 'Right three.', 0.56, 0.28, 0.32),
        run(1, 'A spanning claim has note reference 1.', 0.1, 0.42, 0.8),
        run(1, '1. Left candidate.', 0.08, 0.82, 0.32, 7),
        run(1, '1. Right candidate.', 0.56, 0.82, 0.32, 7),
      ]),
    ])
    expect(ambiguous.noteRelationships).toEqual([
      expect.objectContaining({
        status: 'ambiguous',
        targetNoteId: null,
        candidates: [
          expect.objectContaining({ score: 0.85 }),
          expect.objectContaining({ score: 0.85 }),
        ],
      }),
    ])
    expect(ambiguous.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_NOTE_MATCH' }),
      ]),
    )
  })

  it('resolves multi-page endnotes and exposes machine-readable order accuracy', async () => {
    const result = await reconstruct(
      [
        page(1, [
          run(1, 'The first claim has note reference 1.', 0.1, 0.2, 0.72),
          run(1, 'The second claim has note reference 2.', 0.1, 0.25, 0.72),
        ]),
        page(2, [
          run(2, 'Endnotes', 0.1, 0.12, 0.3, 18),
          run(2, '1. First endnote on page two.', 0.1, 0.22, 0.72),
        ]),
        page(3, [run(3, '2. Second endnote on page three.', 0.1, 0.18, 0.72)]),
      ],
      '9',
    )

    expect(
      result.paper.nodes.filter((node) => node.type === 'footnote'),
    ).toEqual([
      expect.objectContaining({ kind: 'endnote', label: '1' }),
      expect.objectContaining({ kind: 'endnote', label: '2' }),
    ])
    expect(
      result.noteRelationships.every((note) => note.status === 'matched'),
    ).toBe(true)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 2,
      resolvedRelationshipCount: 2,
      relationshipCoverage: 1,
    })
    expect(
      evaluateReadingOrder(result.readingOrder, result.readingOrder.order),
    ).toMatchObject({ orderAccuracy: 1, cycleRate: 0 })
  })

  it('accounts for Unicode folios, rotated stamps, and one-off margin review', () => {
    const arabic = ['١', '٢', '٣']
    const devanagari = ['१', '२', '३']
    const roman = ['I', 'II', 'III']
    const pages = [1, 2, 3].map((pageNumber, index) =>
      page(pageNumber, [
        run(pageNumber, arabic[index], 0.46, 0.95, 0.03, 8),
        run(pageNumber, devanagari[index], 0.52, 0.95, 0.03, 8),
        run(pageNumber, roman[index], 0.58, 0.95, 0.03, 8),
        {
          ...run(
            pageNumber,
            'opaque rotated archive stamp',
            0.02,
            0.35,
            0.5,
            8,
          ),
          rotation: 90,
        },
        run(
          pageNumber,
          pageNumber === 2
            ? 'A genuine sentence in the lower margin remains reviewable.'
            : `Canonical body prose on page ${pageNumber}.`,
          0.12,
          pageNumber === 2 ? 0.94 : 0.2,
          0.7,
          10,
        ),
      ]),
    )
    const first = reconstructPageRegions(pages)
    const second = reconstructPageRegions(pages)
    const furniture = first.regions.filter((region) => region.furniture)
    expect(
      furniture.filter((region) => region.kind === 'page-number'),
    ).toHaveLength(9)
    expect(
      furniture.some(
        (region) =>
          region.furniture?.classification === 'rotated-margin' &&
          region.furniture.evidence.includes('quarter-turn-margin-rotation'),
      ),
    ).toBe(true)
    expect(
      first.regions.some(
        (region) =>
          region.furnitureReview?.reason === 'single-occurrence-margin' &&
          region.includedInReadingOrder,
      ),
    ).toBe(true)
    expect(first.regions).toEqual(second.regions)
  })

  it('defers overlapping repeated numeral bands to the footnote stratum', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Body prose establishes the page font.', 0.12, 0.2, 0.72, 10),
        run(
          1,
          '1. Genuine note body remains a footnote, not page furniture,',
          0.12,
          0.86,
          0.72,
          7,
        ),
        run(
          1,
          'The wrapped note continuation remains owned by the footnote.',
          0.12,
          0.884,
          0.72,
          7,
        ),
      ]),
      page(2, [
        run(
          2,
          'More body prose establishes the page font.',
          0.12,
          0.2,
          0.72,
          10,
        ),
        run(
          2,
          '2. Genuine note body remains a footnote, not page furniture,',
          0.12,
          0.86,
          0.72,
          7,
        ),
        run(
          2,
          'The wrapped note continuation remains owned by the footnote.',
          0.12,
          0.884,
          0.72,
          7,
        ),
      ]),
    ])

    const notes = result.regions.filter((region) => region.kind === 'footnote')
    expect(notes).toHaveLength(2)
    expect(notes.every((region) => region.includedInReadingOrder)).toBe(true)
    expect(notes.every((region) => region.furniture === undefined)).toBe(true)
    expect(
      notes.every((region) =>
        region.text.includes('wrapped note continuation'),
      ),
    ).toBe(true)
    expect(result.furnitureAssessment.furnitureRuns).toHaveLength(0)
  })
})
