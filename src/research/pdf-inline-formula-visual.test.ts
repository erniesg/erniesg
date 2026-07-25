import { expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
} from './import-types'
import {
  isProbableDisplayEquation,
  reconstructPdfVisuals,
  type PdfFigureRasterizer,
} from './pdf-visuals'
import { reconstructPageRegions } from './pdf-regions'
import { createSourcePageCropAsset } from './visual-assets'

function sourceBox(
  x: number,
  y: number,
  width: number,
  height: number,
): NormalizedSourceBox {
  return {
    page: 1,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text',
  }
}

function sourceRun(
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontName: string,
  fontSize: number,
): PdfSourceRun {
  return {
    ...sourceBox(x, y, width, height),
    text,
    fontName,
    fontSize,
    confidence: 1,
  }
}

it('source-crops a stacked fraction separated from a sub-pixel-close prose baseline', async () => {
  const box = sourceBox(0.50235, 0.11434, 0.16344, 0.01924)
  const runs = [
    sourceRun('c', 0.50235, 0.11667, 0.00705, 0.01258, 'Synthetic-CMMI10', 10),
    sourceRun('a', 0.5094, 0.12233, 0.00706, 0.00881, 'Synthetic-CMMI7', 7),
    sourceRun('+', 0.51646, 0.12233, 0.00999, 0.00881, 'Synthetic-CMR7', 7),
    sourceRun('b', 0.52645, 0.12233, 0.00572, 0.00881, 'Synthetic-CMMI7', 7),
    sourceRun('=', 0.53751, 0.11667, 0.01266, 0.01258, 'Synthetic-CMR10', 10),
    sourceRun('DE', 0.55665, 0.11549, 0.01855, 0.00881, 'Synthetic-CMR7', 7),
    sourceRun('TE', 0.5569, 0.12478, 0.01804, 0.00881, 'Synthetic-CMR7', 7),
    sourceRun(
      'helix(',
      0.57911,
      0.12478,
      0.03227,
      0.00881,
      'Synthetic-CMR7',
      7,
    ),
    sourceRun(
      'helix(',
      0.58937,
      0.11434,
      0.03227,
      0.00881,
      'Synthetic-CMR7',
      7,
    ),
    sourceRun(
      'a,b,a',
      0.61138,
      0.12478,
      0.02758,
      0.00881,
      'Synthetic-CMMI7',
      7,
    ),
    sourceRun('a+b)', 0.62164, 0.11434, 0.02787, 0.00881, 'Synthetic-CMMI7', 7),
    sourceRun('+b)', 0.63896, 0.12478, 0.0208, 0.00881, 'Synthetic-CMMI7', 7),
    sourceRun('.', 0.66172, 0.11667, 0.00407, 0.01258, 'Synthetic-Serif', 10),
  ]
  const flattened = 'ca+b = DETE helix(helix(a,b,aa+b+)b).'
  const equation = {
    id: 'stacked-inline-formula',
    page: 1,
    kind: 'equation',
    column: 'single',
    text: flattened,
    confidence: 0.96,
    box,
    lines: [
      {
        id: 'stacked-inline-formula-line',
        text: flattened,
        fontSize: 10,
        box,
        runs,
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const precedingBox = sourceBox(0.50235, 0.09977, 0.38235, 0.01447)
  const preceding = {
    id: 'preceding-prose',
    page: 1,
    kind: 'body',
    column: 'single',
    text: 'ca+b as the confidence the head is an a + b head, using',
    confidence: 0.96,
    box: precedingBox,
    lines: [
      {
        id: 'preceding-prose-line',
        text: 'ca+b as the confidence the head is an a + b head, using',
        fontSize: 10,
        box: precedingBox,
        runs: [
          sourceRun(
            'ca+b as the confidence the head is an a + b head, using',
            precedingBox.x,
            precedingBox.y,
            precedingBox.width,
            precedingBox.height,
            'Synthetic-Serif',
            10,
          ),
        ],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const page = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: flattened.length,
    imageCount: 0,
    runs,
    objects: [],
    assets: [],
  } satisfies PdfPageAnalysis
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
        ...(input.excludedSourceBoxes?.length
          ? {
              sourceExclusionMask: {
                algorithm: 'nearest-source-box-v1',
                expansionPixels: 2,
                ownedSourceBoxes: input.ownedSourceBoxes!,
                excludedSourceBoxes: input.excludedSourceBoxes,
              } as const,
            }
          : {}),
      }),
  )

  expect(isProbableDisplayEquation(equation)).toBe(true)
  const result = await reconstructPdfVisuals({
    pages: [page],
    regions: [preceding, equation],
    rasterizeFigure,
  })

  expect(rasterizeFigure).toHaveBeenCalledOnce()
  expect(rasterizeFigure).toHaveBeenCalledWith(
    expect.objectContaining({
      ownedSourceBoxes: expect.arrayContaining([
        expect.objectContaining({
          x: 0.55665,
          y: 0.11549,
          width: 0.01855,
          height: 0.00881,
        }),
        expect.objectContaining({
          x: 0.5569,
          y: 0.12478,
          width: 0.01804,
          height: 0.00881,
        }),
      ]),
      sourceBox: expect.objectContaining({
        y: expect.any(Number),
      }),
      excludedSourceBoxes: [
        expect.objectContaining({
          x: precedingBox.x,
          y: precedingBox.y,
          width: precedingBox.width,
          height: precedingBox.height,
        }),
      ],
    }),
  )
  const cropBox = rasterizeFigure.mock.calls[0]![0].sourceBox
  expect(cropBox.y).toBeGreaterThan(precedingBox.y + precedingBox.height)
  expect(cropBox.y).toBeLessThan(box.y)
  expect(result.consumedRegionIds).not.toContain(preceding.id)
  expect(result.relationships).toEqual([
    expect.objectContaining({
      kind: 'equation',
      status: 'matched',
      sourceRegionIds: [equation.id],
      sourceText: '',
      altTextSource: 'caption',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-unowned-text-masked',
        'source-text-transcript-unresolved',
      ]),
    }),
  ])
})

it('does not promote a stacked inline shard when the same prose line continues the formula', async () => {
  const shardBox = sourceBox(0.47, 0.54, 0.026, 0.018)
  const shardRuns = [
    sourceRun('h', 0.47, 0.54, 0.009, 0.014, 'Synthetic-Math', 10),
    sourceRun('l', 0.478, 0.534, 0.006, 0.009, 'Synthetic-Math', 7),
    sourceRun('=', 0.486, 0.54, 0.01, 0.014, 'Synthetic-Math', 10),
  ]
  const shard = {
    id: 'inline-script-shard',
    page: 1,
    kind: 'equation',
    column: 'single',
    text: 'hl=',
    confidence: 0.96,
    box: shardBox,
    lines: [
      {
        id: 'inline-script-shard-line',
        text: 'hl=',
        fontSize: 10,
        box: shardBox,
        runs: shardRuns,
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const continuationBox = sourceBox(0.498, 0.54, 0.34, 0.014)
  const continuation = {
    id: 'inline-formula-and-prose-continuation',
    page: 1,
    kind: 'body',
    column: 'single',
    text: '= f(a, b), where the mapping remains stable.',
    confidence: 0.98,
    box: continuationBox,
    lines: [
      {
        id: 'inline-formula-and-prose-continuation-line',
        text: '= f(a, b), where the mapping remains stable.',
        fontSize: 10,
        box: continuationBox,
        runs: [
          sourceRun(
            '= f(a, b), where the mapping remains stable.',
            continuationBox.x,
            continuationBox.y,
            continuationBox.width,
            continuationBox.height,
            'Synthetic-Serif',
            10,
          ),
        ],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const page = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: shard.text.length + continuation.text.length,
    imageCount: 0,
    runs: [...shardRuns, ...continuation.lines[0].runs],
    objects: [],
    assets: [],
  } satisfies PdfPageAnalysis
  const rasterizeFigure = vi.fn(
    async (input: Parameters<PdfFigureRasterizer>[0]) =>
      createSourcePageCropAsset({
        kind: 'equation',
        cropBox: input.sourceBox,
        sourceObjectIds: input.sourceObjectIds,
        sourceBoxes: input.sourceBoxes,
        width: 24,
        height: 16,
        pixels: new Uint8Array(24 * 16 * 4).fill(72),
      }),
  )

  expect(isProbableDisplayEquation(shard)).toBe(true)
  const result = await reconstructPdfVisuals({
    pages: [page],
    regions: [shard, continuation],
    rasterizeFigure,
  })

  expect(rasterizeFigure).not.toHaveBeenCalled()
  expect(result.relationships).toEqual([
    expect.objectContaining({
      kind: 'equation',
      status: 'unresolved',
      sourceRegionIds: [],
      evidence: expect.arrayContaining(['incomplete-equation-source-scope']),
    }),
  ])
  expect(result.consumedRegionIds.has(continuation.id)).toBe(false)
})

it('source-crops a complete stacked inline formula between its prose siblings', async () => {
  const rawRuns = [
    sourceRun(
      'Ordinary prose establishes the body font.',
      0.1,
      0.3,
      0.31,
      0.014,
      'Synthetic-Serif',
      10,
    ),
    sourceRun(
      'A second ordinary line stabilizes the page layout.',
      0.1,
      0.33,
      0.36,
      0.014,
      'Synthetic-Serif',
      10,
    ),
    sourceRun(
      'The fit best satisfies PCA(',
      0.1,
      0.5,
      0.18,
      0.014,
      'Synthetic-Serif',
      10,
    ),
    sourceRun('AA', 0.28, 0.494, 0.02, 0.009, 'Synthetic-CMR7', 7),
    sourceRun('BB', 0.28, 0.507, 0.02, 0.009, 'Synthetic-CMR7', 7),
    sourceRun(') =', 0.304, 0.5, 0.023, 0.014, 'Synthetic-CMR10', 10),
    sourceRun('C', 0.33, 0.5, 0.011, 0.014, 'Synthetic-CMMI10', 10),
    sourceRun('PCA', 0.341, 0.507, 0.024, 0.009, 'Synthetic-CMR7', 7),
    sourceRun('B', 0.367, 0.5, 0.011, 0.014, 'Synthetic-CMMI10', 10),
    sourceRun('(a)', 0.378, 0.5, 0.026, 0.014, 'Synthetic-CMR10', 10),
    sourceRun('T', 0.404, 0.494, 0.007, 0.009, 'Synthetic-CMMI7', 7),
    sourceRun(
      '. Finally, the inverse transform is applied.',
      0.415,
      0.5,
      0.31,
      0.014,
      'Synthetic-Serif',
      10,
    ),
  ]
  const page = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: rawRuns.reduce((total, run) => total + run.text.length, 0),
    imageCount: 0,
    runs: rawRuns,
    objects: [],
    assets: [],
  } satisfies PdfPageAnalysis
  const reconstructed = reconstructPageRegions([page])
  const equation = reconstructed.regions.find(
    (region) => region.kind === 'equation',
  )!
  const proseSiblings = reconstructed.regions.filter((region) =>
    region.lines.some((line) =>
      /-inline-stacked-\d+-(?:before|after)$/u.test(line.id),
    ),
  )
  expect(equation.lines[0].id).toMatch(/-inline-stacked-\d+-formula$/u)
  expect(proseSiblings).toHaveLength(2)
  expect(proseSiblings.every((region) => region.kind === 'body')).toBe(true)

  const rasterizeFigure = vi.fn(
    async (input: Parameters<PdfFigureRasterizer>[0]) =>
      createSourcePageCropAsset({
        kind: 'equation',
        cropBox: input.sourceBox,
        sourceObjectIds: input.sourceObjectIds,
        sourceBoxes: input.sourceBoxes,
        width: 96,
        height: 20,
        pixels: new Uint8Array(96 * 20 * 4).fill(72),
      }),
  )
  const result = await reconstructPdfVisuals({
    pages: [page],
    regions: reconstructed.regions,
    rasterizeFigure,
  })

  expect(rasterizeFigure).toHaveBeenCalledTimes(2)
  expect(rasterizeFigure.mock.calls[0]![0].excludedSourceBoxes).not.toEqual([])
  expect(rasterizeFigure.mock.calls[1]![0].excludedSourceBoxes).toBeUndefined()
  const cropBox = rasterizeFigure.mock.calls[1]![0].sourceBox
  const before = proseSiblings.find((region) =>
    region.lines.some((line) => line.id.endsWith('-before')),
  )!
  const after = proseSiblings.find((region) =>
    region.lines.some((line) => line.id.endsWith('-after')),
  )!
  expect(cropBox.x).toBeGreaterThanOrEqual(before.box.x + before.box.width)
  expect(cropBox.x + cropBox.width).toBeLessThanOrEqual(after.box.x)
  expect(result.relationships).toEqual([
    expect.objectContaining({
      kind: 'equation',
      status: 'matched',
      sourceRegionIds: [equation.id],
      sourceText: '',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-text-transcript-unresolved',
      ]),
    }),
  ])
  expect(
    proseSiblings.some((region) => result.consumedRegionIds.has(region.id)),
  ).toBe(false)
})

it('withholds a geometrically ambiguous super/subscript pair from prose', () => {
  const rawRuns = [
    sourceRun(
      'Ordinary prose establishes the body font.',
      0.1,
      0.3,
      0.31,
      0.014,
      'Synthetic-Serif',
      10,
    ),
    sourceRun(
      'The fit best satisfies PCA(',
      0.1,
      0.5,
      0.18,
      0.014,
      'Synthetic-Serif',
      10,
    ),
    sourceRun('h', 0.28, 0.5, 0.01, 0.014, 'Synthetic-CMMI10', 10),
    sourceRun('l', 0.29, 0.494, 0.006, 0.009, 'Synthetic-CMMI7', 7),
    sourceRun('a', 0.29, 0.507, 0.006, 0.009, 'Synthetic-CMMI7', 7),
    sourceRun(
      ') = C B(a). Finally, the inverse transform is applied.',
      0.297,
      0.5,
      0.39,
      0.014,
      'Synthetic-CMR10',
      10,
    ),
  ]
  const page = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: rawRuns.reduce((total, run) => total + run.text.length, 0),
    imageCount: 0,
    runs: rawRuns,
    objects: [],
    assets: [],
  } satisfies PdfPageAnalysis
  const reconstructed = reconstructPageRegions([page])

  expect(
    reconstructed.regions.filter((region) => region.kind === 'equation'),
  ).toHaveLength(1)
  expect(
    reconstructed.regions
      .flatMap((region) => region.lines)
      .some((line) => /-inline-stacked-/u.test(line.id)),
  ).toBe(true)
  expect(
    reconstructed.regions.some(
      (region) =>
        region.kind === 'body' &&
        region.text.includes('best satisfies PCA(hla) = C B(a). Finally'),
    ),
  ).toBe(false)
})

it('withholds an ambiguous raised script beside a reduced relation operator', () => {
  const rawRuns = [
    sourceRun(
      'Ordinary prose establishes the body font.',
      0.1,
      0.3,
      0.31,
      0.014,
      'Synthetic-Serif',
      10,
    ),
    sourceRun(
      'The hidden state ',
      0.1,
      0.5,
      0.13,
      0.014,
      'Synthetic-Serif',
      10,
    ),
    sourceRun('h', 0.23, 0.5, 0.01, 0.014, 'Synthetic-CMMI10', 10),
    sourceRun('l', 0.24, 0.494, 0.006, 0.009, 'Synthetic-CMMI7', 7),
    sourceRun('=', 0.24, 0.507, 0.01, 0.009, 'Synthetic-CMR7', 7),
    sourceRun(
      ' helix(a, b) remains stable.',
      0.252,
      0.5,
      0.2,
      0.014,
      'Synthetic-CMR10',
      10,
    ),
  ]
  const page = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: rawRuns.reduce((total, run) => total + run.text.length, 0),
    imageCount: 0,
    runs: rawRuns,
    objects: [],
    assets: [],
  } satisfies PdfPageAnalysis
  const reconstructed = reconstructPageRegions([page])

  expect(
    reconstructed.regions.filter((region) => region.kind === 'equation'),
  ).toHaveLength(1)
  expect(
    reconstructed.regions
      .flatMap((region) => region.lines)
      .some((line) => /-inline-stacked-/u.test(line.id)),
  ).toBe(true)
  expect(
    reconstructed.regions.some(
      (region) =>
        region.kind === 'body' &&
        /hidden state\s*h\s*l\s*=\s*helix\(a, b\) remains stable\./u.test(
          region.text,
        ),
    ),
  ).toBe(false)
})

it('turns two raw source-stacked formulas into two crops without consuming prose or inventing transcripts', async () => {
  const rawRuns = [
    sourceRun(
      'A first metric is defined by',
      0.1,
      0.6,
      0.18,
      0.014,
      'Synthetic-Serif',
      10,
    ),
    sourceRun('q', 0.29, 0.6, 0.008, 0.014, 'Synthetic-CMMI10', 10),
    sourceRun('i', 0.298, 0.607, 0.006, 0.009, 'Synthetic-CMMI7', 7),
    sourceRun('=', 0.31, 0.6, 0.012, 0.014, 'Synthetic-CMR10', 10),
    sourceRun('AA', 0.33, 0.597, 0.02, 0.009, 'Synthetic-CMR7', 7),
    sourceRun('BB', 0.33, 0.61, 0.02, 0.009, 'Synthetic-CMR7', 7),
    sourceRun('f(', 0.356, 0.597, 0.014, 0.009, 'Synthetic-CMR7', 7),
    sourceRun('x)', 0.37, 0.597, 0.014, 0.009, 'Synthetic-CMMI7', 7),
    sourceRun('y)', 0.37, 0.61, 0.014, 0.009, 'Synthetic-CMMI7', 7),
    sourceRun('.', 0.39, 0.6, 0.005, 0.014, 'Synthetic-Serif', 10),
    sourceRun(
      'A second metric is defined by',
      0.1,
      0.7,
      0.19,
      0.014,
      'Synthetic-Serif',
      10,
    ),
    sourceRun('r', 0.3, 0.7, 0.008, 0.014, 'Synthetic-CMMI10', 10),
    sourceRun('j', 0.308, 0.707, 0.006, 0.009, 'Synthetic-CMMI7', 7),
    sourceRun('=', 0.32, 0.7, 0.012, 0.014, 'Synthetic-CMR10', 10),
    sourceRun('CC', 0.34, 0.697, 0.02, 0.009, 'Synthetic-CMR7', 7),
    sourceRun('DD', 0.34, 0.71, 0.02, 0.009, 'Synthetic-CMR7', 7),
    sourceRun('g(', 0.366, 0.697, 0.014, 0.009, 'Synthetic-CMR7', 7),
    sourceRun('u)', 0.38, 0.697, 0.014, 0.009, 'Synthetic-CMMI7', 7),
    sourceRun('v)', 0.38, 0.71, 0.014, 0.009, 'Synthetic-CMMI7', 7),
    sourceRun('.', 0.4, 0.7, 0.005, 0.014, 'Synthetic-Serif', 10),
    sourceRun(
      'Following prose remains unchanged.',
      0.1,
      0.77,
      0.24,
      0.014,
      'Synthetic-Serif',
      10,
    ),
  ]
  const page = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: rawRuns.reduce((total, run) => total + run.text.length, 0),
    imageCount: 0,
    runs: rawRuns,
    objects: [],
    assets: [],
  } satisfies PdfPageAnalysis
  const reconstructed = reconstructPageRegions([page])
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

  const equations = reconstructed.regions.filter(
    (region) => region.kind === 'equation',
  )
  expect(equations).toHaveLength(2)
  expect(
    reconstructed.regions
      .filter((region) => region.kind === 'body')
      .map((region) => region.text),
  ).toEqual(
    expect.arrayContaining([
      'A first metric is defined by',
      'A second metric is defined by',
      'Following prose remains unchanged.',
    ]),
  )

  const visuals = await reconstructPdfVisuals({
    pages: [page],
    regions: reconstructed.regions,
    rasterizeFigure,
  })

  expect(rasterizeFigure).toHaveBeenCalledTimes(2)
  expect(
    [...visuals.consumedRegionIds].filter((id) =>
      reconstructed.regions
        .filter((region) => region.kind === 'body')
        .some((region) => region.id === id),
    ),
  ).toEqual([])
  expect(visuals.relationships).toHaveLength(2)
  for (const relationship of visuals.relationships) {
    expect(relationship).toMatchObject({
      kind: 'equation',
      status: 'matched',
      sourceText: '',
      altTextSource: 'caption',
    })
    expect(relationship.altText).not.toMatch(/AA|BB|CC|DD/u)
    expect(relationship.evidence).toContain('source-text-transcript-unresolved')
  }
})
