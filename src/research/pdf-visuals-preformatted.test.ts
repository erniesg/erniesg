import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
} from './import-types'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import { createSourcePageCropAsset } from './visual-assets'

function box(x: number, y: number, width = 0.2, height = 0.1, page = 1) {
  return {
    page,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-object',
  } satisfies NormalizedSourceBox
}

function containsSourceBox(
  container: NormalizedSourceBox,
  candidate: NormalizedSourceBox,
  tolerance = 0.00001,
) {
  return (
    container.page === candidate.page &&
    container.rotation === candidate.rotation &&
    candidate.x >= container.x - tolerance &&
    candidate.y >= container.y - tolerance &&
    candidate.x + candidate.width <=
      container.x + container.width + tolerance &&
    candidate.y + candidate.height <= container.y + container.height + tolerance
  )
}

function equationRegion(
  id: string,
  text: string,
  sourceBox: NormalizedSourceBox,
): PdfPageRegion {
  const textBox = { ...sourceBox, method: 'pdf-text' as const }
  return {
    id,
    page: 1,
    kind: 'equation',
    column: 'single',
    text,
    confidence: 0.93,
    box: textBox,
    lines: [
      {
        id: `${id}-line`,
        text,
        fontSize: 12,
        box: textBox,
        runs: [
          {
            ...textBox,
            text,
            fontName: 'EquationFont',
            fontSize: 12,
            confidence: 0.98,
          },
        ],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
}

function page(
  objects: PdfPageAnalysis['objects'],
  pageNumber = objects?.[0]?.page ?? 1,
  assets: PdfVisualAsset[] = [],
): PdfPageAnalysis {
  return {
    page: pageNumber,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: 20,
    imageCount: objects?.length ?? 0,
    objects,
    assets,
    runs: [],
  }
}

function preformattedTestRegion(
  id: string,
  pageNumber: number,
  lines: Array<{
    text: string
    fontName: string
    x?: number
    width?: number
    y: number
    runs?: Array<{
      text: string
      fontName: string
      x?: number
      y?: number
      width?: number
      height?: number
      page?: number
      rotation?: number
      sourceSequenceIndex?: number
    }>
  }>,
  kind: PdfPageRegion['kind'] = 'body',
) {
  const regionLines = lines.map((line, index) => {
    const lineX = line.x ?? 0.18
    const sourceBox = {
      ...box(lineX, line.y, line.width ?? 0.62, 0.014, pageNumber),
      method: 'pdf-text' as const,
    }
    const runs = line.runs ?? [
      { text: line.text, fontName: line.fontName, x: lineX },
    ]
    return {
      id: `${id}-line-${String(index + 1).padStart(2, '0')}`,
      text: line.text,
      fontSize: 9,
      box: sourceBox,
      runs: runs.map((run, runIndex) => ({
        ...sourceBox,
        page: run.page ?? sourceBox.page,
        x: run.x ?? lineX + runIndex * 0.08,
        y: run.y ?? sourceBox.y,
        width: run.width ?? 0.08,
        height: run.height ?? sourceBox.height,
        rotation: run.rotation ?? sourceBox.rotation,
        text: run.text,
        fontName: run.fontName,
        fontSize: 9,
        confidence: 0.99,
        ...(run.sourceSequenceIndex === undefined
          ? {}
          : { sourceSequenceIndex: run.sourceSequenceIndex }),
      })),
    }
  })
  const top = Math.min(...regionLines.map((line) => line.box.y))
  const bottom = Math.max(
    ...regionLines.map((line) => line.box.y + line.box.height),
  )
  const left = Math.min(...regionLines.map((line) => line.box.x))
  const right = Math.max(
    ...regionLines.map((line) => line.box.x + line.box.width),
  )
  return {
    id,
    page: pageNumber,
    kind,
    column: 'single',
    text: regionLines.map((line) => line.text).join(' '),
    confidence: 0.99,
    box: {
      ...box(left, top, right - left, bottom - top, pageNumber),
      method: 'pdf-text' as const,
    },
    lines: regionLines,
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
}

function preformattedCropRasterizer() {
  return vi.fn(async (input: Parameters<PdfFigureRasterizer>[0]) =>
    createSourcePageCropAsset({
      kind: 'raster',
      cropBox: input.sourceBox,
      sourceObjectIds: input.sourceObjectIds,
      sourceBoxes: input.sourceBoxes,
      width: 160,
      height: 96,
      pixels: new Uint8Array(160 * 96 * 4).fill(64),
    }),
  )
}

describe('PDF preformatted source blocks', () => {
  it('detects a shell transcript from monospaced source evidence without language keywords', async () => {
    const fixture = preformattedTestRegion('shell-transcript', 1, [
      {
        text: 'Captured session:',
        fontName: 'NimbusRomNo9L-Regu',
        y: 0.2,
      },
      { text: '$ tool --version', fontName: 'NimbusMonoPS-Regular', y: 0.24 },
      { text: 'tool 4.2.0', fontName: 'NimbusMonoPS-Regular', y: 0.26 },
      { text: '$ exit', fontName: 'NimbusMonoPS-Regular', y: 0.28 },
    ])

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [fixture],
      rasterizeFigure: preformattedCropRasterizer(),
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        semanticKind: 'code',
        captionRegionId: fixture.id,
        evidence: expect.arrayContaining(['monospaced-source-lines']),
        preformatted: expect.objectContaining({
          status: 'proved',
          lines: fixture.lines.slice(1).map((line) =>
            expect.objectContaining({
              text: line.text,
              sourceRegionId: fixture.id,
              sourceLineId: line.id,
            }),
          ),
        }),
      }),
    ])
  })

  it('keeps keyword-shaped justified prose as prose without source listing evidence', async () => {
    const prose = preformattedTestRegion('keyword-prose', 1, [
      {
        text: 'Here is some source code:',
        fontName: 'NimbusRomNo9L-Regu',
        y: 0.2,
      },
      {
        text: 'This ordinary paragraph remains fully justified.',
        fontName: 'NimbusRomNo9L-Regu',
        y: 0.23,
      },
      {
        text: 'Its language does not establish a listing boundary.',
        fontName: 'NimbusRomNo9L-Regu',
        y: 0.25,
      },
      {
        text: 'Source geometry remains the only promotion authority.',
        fontName: 'NimbusRomNo9L-Regu',
        y: 0.27,
      },
    ])

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [prose],
      rasterizeFigure: preformattedCropRasterizer(),
    })

    expect(result.relationships).toEqual([])
    expect(result.consumedLineIds.size).toBe(0)
  })

  it('keeps one proved listing across a two-column source break in canonical line order', async () => {
    const caption: PdfPageRegion = {
      ...preformattedTestRegion('column-listing-caption', 1, [
        {
          text: 'Listing 2: Recorded values',
          fontName: 'NimbusRomNo9L-Regu',
          y: 0.62,
        },
      ]),
      column: 'left',
    }
    const left: PdfPageRegion = {
      ...preformattedTestRegion('column-listing-left', 1, [
        { text: 'alpha := 1', fontName: 'SFTT1000', y: 0.67 },
        { text: 'beta := 2', fontName: 'SFTT1000', y: 0.7 },
      ]),
      column: 'left',
    }
    const right: PdfPageRegion = {
      ...preformattedTestRegion('column-listing-right', 1, [
        { text: 'gamma := 3', fontName: 'SFTT1000', x: 0.55, y: 0.1 },
        { text: 'delta := 4', fontName: 'SFTT1000', x: 0.55, y: 0.13 },
      ]),
      column: 'right',
    }
    const rasterizeFigure = preformattedCropRasterizer()

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [right, caption, left],
      rasterizeFigure,
    })
    const relationship = result.relationships[0]

    expect(result.relationships).toHaveLength(1)
    expect(relationship).toMatchObject({
      label: 'Listing 2',
      semanticKind: 'code',
      sourceLineIds: [...left.lines, ...right.lines].map((line) => line.id),
      preformatted: {
        status: 'proved',
        lines: [...left.lines, ...right.lines].map((line) =>
          expect.objectContaining({ text: line.text, sourceLineId: line.id }),
        ),
      },
    })
    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
  })

  it('preserves proportional-font pseudocode as an exact source crop', async () => {
    const introducer = preformattedTestRegion('pseudocode-introducer', 1, [
      {
        text: "Here's a simple example of pseudocode demonstrating how a smart contract could work:",
        fontName: 'NimbusRomNo9L-Regu',
        y: 0.28,
      },
    ])
    const pseudocode = preformattedTestRegion('pseudocode', 1, [
      {
        text: 'contract ArbitrageAI {',
        fontName: 'NimbusRomNo9L-Regu',
        y: 0.33,
      },
      {
        text: 'DataAnalyzer dataAnalyzer; // AI module for data analysis',
        fontName: 'NimbusRomNo9L-Regu',
        x: 0.21,
        y: 0.35,
      },
      {
        text: 'PriceFeed priceFeed; // Interface for real time price data',
        fontName: 'NimbusRomNo9L-Regu',
        x: 0.21,
        y: 0.37,
      },
      {
        text: 'function Arbitrage public() {',
        fontName: 'NimbusRomNo9L-Regu',
        x: 0.21,
        y: 0.39,
      },
      {
        text: 'MarketTrends trends = dataAnalyzer.AnalyzeMarket();',
        fontName: 'NimbusRomNo9L-Regu',
        x: 0.24,
        y: 0.41,
      },
    ])
    const following = preformattedTestRegion('pseudocode-following', 1, [
      {
        text: 'The example illustrates how the integration can operate.',
        fontName: 'NimbusRomNo9L-Regu',
        y: 0.46,
      },
    ])
    const rasterizeFigure = preformattedCropRasterizer()

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [following, pseudocode, introducer],
      rasterizeFigure,
    })
    const relationship = result
      .relationships[0] as (typeof result.relationships)[number] & {
      semanticKind?: string
      preformatted?: { status: string; lines: unknown[] }
    }

    expect(result.relationships).toHaveLength(1)
    expect(relationship).toMatchObject({
      semanticKind: 'code',
      status: 'matched',
      captionRegionId: introducer.id,
      preformatted: {
        status: 'proved',
        lines: [
          expect.objectContaining({
            text: 'contract ArbitrageAI {',
            indentColumns: 0,
          }),
          expect.objectContaining({
            text: 'DataAnalyzer dataAnalyzer; // AI module for data analysis',
            indentColumns: 2,
          }),
          expect.objectContaining({
            text: 'PriceFeed priceFeed; // Interface for real time price data',
            indentColumns: 2,
          }),
          expect.objectContaining({
            text: 'function Arbitrage public() {',
            indentColumns: 2,
          }),
          expect.objectContaining({
            text: 'MarketTrends trends = dataAnalyzer.AnalyzeMarket();',
            indentColumns: 4,
          }),
        ],
      },
      evidence: expect.arrayContaining([
        'source-indentation-and-ragged-measure',
        'exact-single-run-line-text',
        'source-geometry-indentation',
        'source-page-crop',
      ]),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.consumedRegionIds.has(pseudocode.id)).toBe(true)
    expect(result.consumedRegionIds.has(following.id)).toBe(false)
  })

  it('preserves exact single-run monospaced source lines in deterministic page order', async () => {
    const opening = preformattedTestRegion('prompt-opening', 1, [
      {
        text: 'Here is the specific prompt used:',
        fontName: 'NimbusRomNo9L-Regu',
        y: 0.58,
      },
      {
        text: 'You are an expert in using API functions.',
        fontName: 'SFTT1000',
        y: 0.61,
      },
      {
        text: 'GET url?name=value&format=json',
        fontName: 'SFTT1000',
        y: 0.625,
      },
    ])
    const body = preformattedTestRegion('prompt-body', 1, [
      {
        text: 'POST url',
        fontName: 'SFTT1000',
        y: 0.66,
      },
      {
        text: '[your payload data in JSON format]',
        fontName: 'SFTT1000',
        y: 0.675,
      },
      {
        text: '{functions}',
        fontName: 'SFTT1000',
        y: 0.69,
      },
    ])
    const continuation = preformattedTestRegion('prompt-continuation', 2, [
      {
        text: 'Context: {context}',
        fontName: 'SFTT1000',
        y: 0.09,
      },
      {
        text: 'Question: {question}',
        fontName: 'SFTT1000',
        y: 0.105,
      },
    ])
    const followingHeading = preformattedTestRegion('following-heading', 2, [
      {
        text: 'A.3 Subgroup analysis',
        fontName: 'NimbusRomNo9L-Medi',
        y: 0.14,
      },
    ])
    const rasterizeFigure = preformattedCropRasterizer()

    const result = await reconstructPdfVisuals({
      pages: [page([], 1), page([], 2)],
      // Extraction order is deliberately scrambled. Source page/y order must
      // be the only serialization order.
      regions: [body, continuation, followingHeading, opening],
      rasterizeFigure,
    })
    const relationship = result.relationships[0] as
      | (PdfVisualAsset & { preformatted?: never })
      | ((typeof result.relationships)[number] & {
          semanticKind?: string
          preformatted?: {
            status: string
            lines: Array<{
              text: string
              sourceRegionId: string
              sourceLineId: string
              sourceBox: NormalizedSourceBox
              sourceRunBoxes: NormalizedSourceBox[]
            }>
          }
        })

    expect(result.relationships).toHaveLength(1)
    expect(relationship).toMatchObject({
      kind: 'figure',
      semanticKind: 'code',
      captionRegionId: opening.id,
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-preformatted-block',
        'deterministic-source-line-order',
        'exact-single-run-line-text',
        'source-page-crop',
      ]),
      preformatted: {
        status: 'proved',
        lines: [
          expect.objectContaining({
            text: 'You are an expert in using API functions.',
            sourceRegionId: opening.id,
            sourceLineId: opening.lines[1].id,
          }),
          expect.objectContaining({
            text: 'GET url?name=value&format=json',
            sourceRegionId: opening.id,
            sourceLineId: opening.lines[2].id,
          }),
          expect.objectContaining({
            text: 'POST url',
            sourceRegionId: body.id,
            sourceLineId: body.lines[0].id,
          }),
          expect.objectContaining({
            text: '[your payload data in JSON format]',
            sourceRegionId: body.id,
            sourceLineId: body.lines[1].id,
          }),
          expect.objectContaining({
            text: '{functions}',
            sourceRegionId: body.id,
            sourceLineId: body.lines[2].id,
          }),
          expect.objectContaining({
            text: 'Context: {context}',
            sourceRegionId: continuation.id,
            sourceLineId: continuation.lines[0].id,
          }),
          expect.objectContaining({
            text: 'Question: {question}',
            sourceRegionId: continuation.id,
            sourceLineId: continuation.lines[1].id,
          }),
        ],
      },
    })
    expect(rasterizeFigure).toHaveBeenCalledTimes(2)
    expect(opening.kind).toBe('caption')
    expect(result.consumedLineIds.has(opening.lines[0].id)).toBe(false)
    for (const line of [
      ...opening.lines.slice(1),
      ...body.lines,
      ...continuation.lines,
    ]) {
      expect(result.consumedLineIds.has(line.id)).toBe(true)
    }
    expect(result.consumedRegionIds.has(followingHeading.id)).toBe(false)
  })

  it('proves exact multi-run source lines only from ordered source and geometry evidence', async () => {
    const opening = preformattedTestRegion('multi-run-opening', 1, [
      {
        text: 'Here is the specific prompt used:',
        fontName: 'NimbusRomNo9L-Regu',
        y: 0.58,
      },
      {
        text: 'function price(){',
        fontName: 'SFTT1000',
        y: 0.61,
        runs: [
          {
            text: 'function price()',
            fontName: 'SFTT1000',
            x: 0.18,
            width: 0.13,
            sourceSequenceIndex: 10,
          },
          {
            text: '{',
            fontName: 'SFTT1000',
            x: 0.31,
            width: 0.01,
            sourceSequenceIndex: 11,
          },
        ],
      },
      {
        text: 'return currentPrice;',
        fontName: 'SFTT1000',
        y: 0.625,
        runs: [
          {
            text: 'return',
            fontName: 'SFTT1000',
            x: 0.18,
            width: 0.04,
            sourceSequenceIndex: 12,
          },
          {
            text: 'currentPrice;',
            fontName: 'SFTT1000',
            x: 0.23,
            width: 0.09,
            sourceSequenceIndex: 13,
          },
        ],
      },
      {
        text: '}',
        fontName: 'SFTT1000',
        y: 0.64,
      },
    ])

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [opening],
      rasterizeFigure: preformattedCropRasterizer(),
    })
    const relationship = result
      .relationships[0] as (typeof result.relationships)[number] & {
      preformatted?: { status: string; lines: Array<{ text: string }> }
    }

    expect(relationship).toMatchObject({
      semanticKind: 'code',
      status: 'matched',
      preformatted: {
        status: 'proved',
        lines: [
          { text: 'function price(){' },
          { text: 'return currentPrice;' },
          { text: '}' },
        ],
      },
      evidence: expect.arrayContaining([
        'deterministic-source-line-order',
        'exact-ordered-multi-run-line-text',
        'source-page-crop',
      ]),
    })
    expect(relationship.evidence).not.toContain('exact-single-run-line-text')
  })

  it.each([
    {
      name: 'a missing source sequence',
      lineText: 'function price(){',
      runs: [
        {
          text: 'function price()',
          fontName: 'SFTT1000',
          x: 0.18,
          width: 0.13,
        },
        {
          text: '{',
          fontName: 'SFTT1000',
          x: 0.31,
          width: 0.01,
          sourceSequenceIndex: 11,
        },
      ],
    },
    {
      name: 'duplicate source sequences',
      lineText: 'function price(){',
      runs: [
        {
          text: 'function price()',
          fontName: 'SFTT1000',
          x: 0.18,
          width: 0.13,
          sourceSequenceIndex: 10,
        },
        {
          text: '{',
          fontName: 'SFTT1000',
          x: 0.31,
          width: 0.01,
          sourceSequenceIndex: 10,
        },
      ],
    },
    {
      name: 'reversed source sequences',
      lineText: 'function price(){',
      runs: [
        {
          text: 'function price()',
          fontName: 'SFTT1000',
          x: 0.18,
          width: 0.13,
          sourceSequenceIndex: 11,
        },
        {
          text: '{',
          fontName: 'SFTT1000',
          x: 0.31,
          width: 0.01,
          sourceSequenceIndex: 10,
        },
      ],
    },
    {
      name: 'source order that disagrees with visual x order',
      lineText: 'function price(){',
      runs: [
        {
          text: 'function price()',
          fontName: 'SFTT1000',
          x: 0.32,
          width: 0.13,
          sourceSequenceIndex: 10,
        },
        {
          text: '{',
          fontName: 'SFTT1000',
          x: 0.18,
          width: 0.01,
          sourceSequenceIndex: 11,
        },
      ],
    },
    {
      name: 'a different source page',
      lineText: 'function price(){',
      runs: [
        {
          text: 'function price()',
          fontName: 'SFTT1000',
          x: 0.18,
          width: 0.13,
          sourceSequenceIndex: 10,
        },
        {
          text: '{',
          fontName: 'SFTT1000',
          x: 0.31,
          width: 0.01,
          page: 2,
          sourceSequenceIndex: 11,
        },
      ],
    },
    {
      name: 'a different source rotation',
      lineText: 'function price(){',
      runs: [
        {
          text: 'function price()',
          fontName: 'SFTT1000',
          x: 0.18,
          width: 0.13,
          sourceSequenceIndex: 10,
        },
        {
          text: '{',
          fontName: 'SFTT1000',
          x: 0.31,
          width: 0.01,
          rotation: 90,
          sourceSequenceIndex: 11,
        },
      ],
    },
    {
      name: 'a different baseline',
      lineText: 'function price(){',
      runs: [
        {
          text: 'function price()',
          fontName: 'SFTT1000',
          x: 0.18,
          width: 0.13,
          sourceSequenceIndex: 10,
        },
        {
          text: '{',
          fontName: 'SFTT1000',
          x: 0.31,
          y: 0.62,
          width: 0.01,
          sourceSequenceIndex: 11,
        },
      ],
    },
    {
      name: 'materially overlapping runs',
      lineText: 'function price(){',
      runs: [
        {
          text: 'function price()',
          fontName: 'SFTT1000',
          x: 0.18,
          width: 0.16,
          sourceSequenceIndex: 10,
        },
        {
          text: '{',
          fontName: 'SFTT1000',
          x: 0.31,
          width: 0.01,
          sourceSequenceIndex: 11,
        },
      ],
    },
    {
      name: 'a run outside the source line box',
      lineText: 'function price() {',
      runs: [
        {
          text: 'function price()',
          fontName: 'SFTT1000',
          x: 0.18,
          width: 0.13,
          sourceSequenceIndex: 10,
        },
        {
          text: '{',
          fontName: 'SFTT1000',
          x: 0.82,
          width: 0.01,
          sourceSequenceIndex: 11,
        },
      ],
    },
    {
      name: 'merged text that disagrees with the source line',
      lineText: 'function price() {',
      runs: [
        {
          text: 'function price()',
          fontName: 'SFTT1000',
          x: 0.18,
          width: 0.13,
          sourceSequenceIndex: 10,
        },
        {
          text: '{',
          fontName: 'SFTT1000',
          x: 0.31,
          width: 0.01,
          sourceSequenceIndex: 11,
        },
      ],
    },
    {
      name: 'a replacement glyph',
      lineText: 'function price()\uFFFD',
      runs: [
        {
          text: 'function price()',
          fontName: 'SFTT1000',
          x: 0.18,
          width: 0.13,
          sourceSequenceIndex: 10,
        },
        {
          text: '\uFFFD',
          fontName: 'SFTT1000',
          x: 0.31,
          width: 0.01,
          sourceSequenceIndex: 11,
        },
      ],
    },
    {
      name: 'an interleaved-column-sized gap',
      lineText: 'function price() {',
      runs: [
        {
          text: 'function price()',
          fontName: 'SFTT1000',
          x: 0.18,
          width: 0.13,
          sourceSequenceIndex: 10,
        },
        {
          text: '{',
          fontName: 'SFTT1000',
          x: 0.55,
          width: 0.01,
          sourceSequenceIndex: 11,
        },
      ],
    },
  ])(
    'fails multi-run transcript proof closed for $name',
    async ({ lineText, runs }) => {
      const opening = preformattedTestRegion('ambiguous-multi-run-opening', 1, [
        {
          text: 'Here is the specific prompt used:',
          fontName: 'NimbusRomNo9L-Regu',
          y: 0.58,
        },
        {
          text: lineText,
          fontName: 'SFTT1000',
          y: 0.61,
          runs,
        },
        {
          text: 'return currentPrice;',
          fontName: 'SFTT1000',
          y: 0.625,
        },
        {
          text: '}',
          fontName: 'SFTT1000',
          y: 0.64,
        },
      ])

      const result = await reconstructPdfVisuals({
        pages: [page([], 1), page([], 2)],
        regions: [opening],
        rasterizeFigure: preformattedCropRasterizer(),
      })
      const relationship = result
        .relationships[0] as (typeof result.relationships)[number] & {
        preformatted?: { status: string }
      }

      expect(relationship).toMatchObject({
        semanticKind: 'code',
        status: 'matched',
        preformatted: { status: 'unresolved' },
        evidence: expect.arrayContaining([
          'source-text-exactness-unresolved',
          'source-text-transcript-unresolved',
        ]),
      })
      expect(relationship.evidence).not.toContain(
        'exact-ordered-multi-run-line-text',
      )
    },
  )

  it('owns a syntax-highlighted panel as an exact crop without claiming its corrupted text layer is code', async () => {
    const panel = preformattedTestRegion('syntax-panel', 1, [
      {
        text: 'Theorems and Tactics. The following record is in JSON.',
        fontName: 'NimbusRomNo9L-Regu',
        y: 0.39,
      },
      {
        text: '" url " : " https : // example.test " ,',
        fontName: 'SFTT1000',
        y: 0.5,
        runs: [
          { text: '"url"', fontName: 'SFTT1000', x: 0.18 },
          { text: ':', fontName: 'CMR10', x: 0.25 },
          { text: '"https://example.test",', fontName: 'SFTT1000', x: 0.27 },
        ],
      },
      {
        text: '" state_after " : " 2 goals \\ n⊢ goal "',
        fontName: 'SFTT1000',
        y: 0.515,
        runs: [
          { text: '"state_after"', fontName: 'SFTT1000', x: 0.18 },
          { text: ':', fontName: 'CMR10', x: 0.3 },
          { text: '"2 goals \\n⊢ goal"', fontName: 'SFTT1000', x: 0.32 },
        ],
      },
      {
        text: '}',
        fontName: 'SFTT1000',
        y: 0.53,
      },
    ])
    const vectorObjects = [0.497, 0.512, 0.527].map((y, index) => ({
      id: `panel-strip-${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: box(0.176, y, 0.648, 0.015),
      confidence: 1,
      assetId: null,
      role: 'semantic' as const,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(vectorObjects)],
      regions: [panel],
      rasterizeFigure: preformattedCropRasterizer(),
    })
    const relationship = result
      .relationships[0] as (typeof result.relationships)[number] & {
      semanticKind?: string
      preformatted?: { status: string; lines: unknown[] }
    }

    expect(relationship).toMatchObject({
      semanticKind: 'code',
      status: 'matched',
      sourceText: '',
      preformatted: { status: 'unresolved', lines: [] },
      evidence: expect.arrayContaining([
        'source-preformatted-block',
        'source-page-crop',
        'source-text-transcript-unresolved',
      ]),
    })
    expect(
      panel.lines.slice(1).every((line) => result.consumedLineIds.has(line.id)),
    ).toBe(true)
  })

  it('preserves a caption-bounded three-column program listing as one crop instead of flattening its columns', async () => {
    const caption = preformattedTestRegion(
      'program-caption',
      1,
      [
        {
          text: 'Figure 16: An example program for an audio sequence.',
          fontName: 'NimbusRomNo9L-Regu',
          y: 0.83,
        },
      ],
      'caption',
    )
    const headers = [
      preformattedTestRegion('input-header', 1, [
        {
          text: 'Input Sequence',
          fontName: 'NimbusRomNo9L-Medi',
          x: 0.24,
          width: 0.1,
          y: 0.16,
        },
      ]),
      preformattedTestRegion('program-header', 1, [
        {
          text: 'Generated Program',
          fontName: 'NimbusRomNo9L-Medi',
          x: 0.45,
          width: 0.14,
          y: 0.16,
        },
      ]),
      preformattedTestRegion('output-header', 1, [
        {
          text: 'Produced Sequence',
          fontName: 'NimbusRomNo9L-Medi',
          x: 0.69,
          width: 0.12,
          y: 0.16,
        },
      ]),
    ]
    const columns = [
      preformattedTestRegion('input-values', 1, [
        {
          text: '[6, 7, 7, 8, 10, 11]',
          fontName: 'NimbusRomNo9L-Regu',
          x: 0.19,
          width: 0.16,
          y: 0.19,
        },
      ]),
      preformattedTestRegion('program-lines', 1, [
        {
          text: '# Predefined Constants',
          fontName: 'SFTT1000',
          x: 0.39,
          width: 0.22,
          y: 0.19,
        },
        {
          text: 'def pattern(start):',
          fontName: 'SFTT1000',
          x: 0.39,
          width: 0.2,
          y: 0.21,
        },
        {
          text: 'return start + 1',
          fontName: 'SFTT1000',
          x: 0.42,
          width: 0.18,
          y: 0.23,
        },
      ]),
      preformattedTestRegion('output-values', 1, [
        {
          text: '[6, 7, 8, 9, 10, 11]',
          fontName: 'NimbusRomNo9L-Regu',
          x: 0.65,
          width: 0.18,
          y: 0.19,
        },
      ]),
    ]
    const rasterizeFigure = preformattedCropRasterizer()

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [...columns.reverse(), caption, ...headers.reverse()],
      rasterizeFigure,
    })
    const relationship = result
      .relationships[0] as (typeof result.relationships)[number] & {
      semanticKind?: string
      preformatted?: { status: string; lines: unknown[] }
    }

    expect(result.relationships).toHaveLength(1)
    expect(relationship).toMatchObject({
      kind: 'figure',
      semanticKind: 'code',
      label: 'Figure 16',
      captionRegionId: caption.id,
      status: 'matched',
      preformatted: { status: 'unresolved', lines: [] },
      evidence: expect.arrayContaining([
        'caption-bounded-program-listing',
        'three-column-source-order-unresolved',
        'source-page-crop',
      ]),
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(
      containsSourceBox(
        rasterizeFigure.mock.calls[0][0].sourceBox,
        headers[0].box,
      ),
    ).toBe(true)
    expect(
      containsSourceBox(
        rasterizeFigure.mock.calls[0][0].sourceBox,
        columns[0].box,
      ),
    ).toBe(true)
    for (const region of [...headers, ...columns]) {
      expect(result.consumedRegionIds.has(region.id)).toBe(true)
    }
  })

  it('retries a bounded program crop far enough to include source ink without crossing its caption', async () => {
    const caption = preformattedTestRegion(
      'tight-program-caption',
      1,
      [
        {
          text: 'Figure 16: An example generated program.',
          fontName: 'NimbusRomNo9L-Regu',
          y: 0.29,
        },
      ],
      'caption',
    )
    const regions = [
      preformattedTestRegion('tight-input-header', 1, [
        {
          text: 'Input Sequence',
          fontName: 'NimbusRomNo9L-Medi',
          x: 0.19,
          width: 0.12,
          y: 0.16,
        },
      ]),
      preformattedTestRegion('tight-program-header', 1, [
        {
          text: 'Generated Program',
          fontName: 'NimbusRomNo9L-Medi',
          x: 0.42,
          width: 0.15,
          y: 0.16,
        },
      ]),
      preformattedTestRegion('tight-output-header', 1, [
        {
          text: 'Produced Sequence',
          fontName: 'NimbusRomNo9L-Medi',
          x: 0.68,
          width: 0.15,
          y: 0.16,
        },
      ]),
      preformattedTestRegion('tight-input-values', 1, [
        {
          text: '[1, 2, 3]',
          fontName: 'NimbusRomNo9L-Regu',
          x: 0.19,
          width: 0.12,
          y: 0.2,
        },
      ]),
      preformattedTestRegion('tight-program-lines', 1, [
        {
          text: 'def pattern(start):',
          fontName: 'SFTT1000',
          x: 0.42,
          width: 0.18,
          y: 0.2,
        },
        {
          text: 'return start + 1',
          fontName: 'SFTT1000',
          x: 0.42,
          width: 0.18,
          y: 0.23,
        },
      ]),
      preformattedTestRegion('tight-output-values', 1, [
        {
          text: '[2, 3, 4]',
          fontName: 'NimbusRomNo9L-Regu',
          x: 0.7,
          width: 0.13,
          y: 0.2,
        },
      ]),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const right = input.sourceBox.x + input.sourceBox.width
        const bottom = input.sourceBox.y + input.sourceBox.height
        if (right < 0.875 || bottom < 0.27) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        if (bottom >= caption.box.y) {
          throw new Error('crop crossed the caption boundary')
        }
        return createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 160,
          height: 96,
          pixels: new Uint8Array(160 * 96 * 4).fill(64),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [...regions, caption],
      rasterizeFigure,
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        semanticKind: 'code',
        status: 'matched',
        evidence: expect.arrayContaining([
          'source-page-crop-adaptive-padding',
          'source-page-crop',
        ]),
      }),
    ])
    expect(rasterizeFigure.mock.calls.length).toBeGreaterThan(1)
    const selected = rasterizeFigure.mock.calls.at(-1)![0].sourceBox
    expect(selected.x + selected.width).toBeGreaterThanOrEqual(0.875)
    expect(selected.y + selected.height).toBeLessThan(caption.box.y)
  })

  it('fails a bounded code block closed when its exact crop is unavailable', async () => {
    const opening = preformattedTestRegion('failed-code-opening', 1, [
      {
        text: 'Here is the specific prompt used:',
        fontName: 'NimbusRomNo9L-Regu',
        y: 0.58,
      },
      {
        text: 'GET url?name=value',
        fontName: 'SFTT1000',
        y: 0.61,
      },
      {
        text: 'POST url',
        fontName: 'SFTT1000',
        y: 0.625,
      },
      {
        text: '{functions}',
        fontName: 'SFTT1000',
        y: 0.64,
      },
    ])

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [opening],
      rasterizeFigure: async () => null,
    })
    const relationship = result
      .relationships[0] as (typeof result.relationships)[number] & {
      semanticKind?: string
      preformatted?: { status: string }
    }

    expect(relationship).toMatchObject({
      semanticKind: 'code',
      status: 'unresolved',
      preformatted: { status: 'proved' },
      sourceText: 'GET url?name=value\nPOST url\n{functions}',
      evidence: expect.arrayContaining([
        'source-rendition-unavailable',
        'unresolved-visual-text-owned',
      ]),
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_PREFORMATTED_BLOCK',
          severity: 'error',
        }),
      ]),
    )
    expect(
      opening.lines
        .slice(1)
        .every((line) => result.consumedLineIds.has(line.id)),
    ).toBe(true)
  })

  it('uses literal leading whitespace without adding quantized geometry indentation', async () => {
    const opening = preformattedTestRegion('literal-indent-listing', 1, [
      {
        text: 'The following listing keeps authored indentation:',
        fontName: 'NimbusRomNo9L-Regu',
        y: 0.2,
      },
      {
        text: '  if ready:',
        fontName: 'SFTT1000',
        x: 0.18,
        width: 0.35,
        y: 0.24,
      },
      {
        text: '    return value',
        fontName: 'SFTT1000',
        x: 0.21,
        width: 0.28,
        y: 0.255,
      },
      { text: '  else:', fontName: 'SFTT1000', x: 0.18, width: 0.2, y: 0.27 },
      {
        text: '    return fallback',
        fontName: 'SFTT1000',
        x: 0.21,
        width: 0.24,
        y: 0.285,
      },
    ])

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [opening],
      rasterizeFigure: preformattedCropRasterizer(),
    })

    const relationship = result.relationships[0]
    expect(relationship.preformatted).toMatchObject({
      status: 'proved',
      lines: [
        { text: '  if ready:', indentColumns: 0 },
        { text: '    return value', indentColumns: 0 },
        { text: '  else:', indentColumns: 0 },
        { text: '    return fallback', indentColumns: 0 },
      ],
    })
  })

  it('continues a listing from the right column into the next page left column', async () => {
    const opening = {
      ...preformattedTestRegion('right-column-listing', 1, [
        {
          text: 'The listing continues on the next page:',
          fontName: 'NimbusRomNo9L-Regu',
          y: 0.58,
        },
        { text: 'const first = 1', fontName: 'SFTT1000', y: 0.61 },
        { text: 'const second = 2', fontName: 'SFTT1000', y: 0.625 },
        { text: 'return first + second', fontName: 'SFTT1000', y: 0.64 },
      ]),
      column: 'right' as const,
    }
    const continuation = {
      ...preformattedTestRegion('next-page-left-listing', 2, [
        { text: 'const third = 3', fontName: 'SFTT1000', y: 0.09 },
        { text: 'return third', fontName: 'SFTT1000', y: 0.105 },
      ]),
      column: 'left' as const,
    }

    const result = await reconstructPdfVisuals({
      pages: [page([], 1), page([], 2)],
      regions: [continuation, opening],
      rasterizeFigure: preformattedCropRasterizer(),
    })

    expect(result.relationships).toHaveLength(1)
    expect(
      result.relationships[0].preformatted?.lines.map((line) => line.text),
    ).toEqual([
      'const first = 1',
      'const second = 2',
      'return first + second',
      'const third = 3',
      'return third',
    ])
  })

  it('keeps a mid-page spanning source lane deterministic around column bands', async () => {
    const spanListing = {
      ...preformattedTestRegion('mid-page-span-listing', 1, [
        {
          text: 'Listing 4: Shared configuration',
          fontName: 'NimbusRomNo9L-Regu',
          y: 0.43,
        },
        { text: 'host = "localhost"', fontName: 'SFTT1000', y: 0.47 },
        { text: 'port = 8080', fontName: 'SFTT1000', y: 0.485 },
        { text: 'secure = true', fontName: 'SFTT1000', y: 0.5 },
      ]),
      column: 'span' as const,
    }
    const leftProse = {
      ...preformattedTestRegion('mid-page-left-prose', 1, [
        {
          text: 'Left column material above the shared listing.',
          fontName: 'NimbusRomNo9L-Regu',
          y: 0.2,
        },
      ]),
      column: 'left' as const,
    }
    const rightProse = {
      ...preformattedTestRegion('mid-page-right-prose', 1, [
        {
          text: 'Right column material above the shared listing.',
          fontName: 'NimbusRomNo9L-Regu',
          y: 0.2,
        },
      ]),
      column: 'right' as const,
    }

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [rightProse, spanListing, leftProse],
      rasterizeFigure: preformattedCropRasterizer(),
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0].captionRegionId).toBe(spanListing.id)
    expect(
      result.relationships[0].preformatted?.lines.map((line) => line.text),
    ).toEqual(['host = "localhost"', 'port = 8080', 'secure = true'])
  })

  it('reserves typed table rows before generic listing detection', async () => {
    const caption = {
      ...preformattedTestRegion(
        'typed-table-caption',
        1,
        [
          {
            text: 'Table 1: Monospaced rows remain tabular',
            fontName: 'NimbusRomNo9L-Regu',
            y: 0.2,
          },
        ],
        'caption',
      ),
    }
    const rows = preformattedTestRegion('typed-table-rows', 1, [
      { text: 'alpha     1', fontName: 'SFTT1000', y: 0.24, width: 0.22 },
      { text: 'beta      2', fontName: 'SFTT1000', y: 0.255, width: 0.2 },
      { text: 'gamma     3', fontName: 'SFTT1000', y: 0.27, width: 0.18 },
      { text: 'delta     4', fontName: 'SFTT1000', y: 0.285, width: 0.16 },
    ])

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [rows, caption],
      rasterizeFigure: preformattedCropRasterizer(),
    })

    expect(
      result.relationships.some(
        (relationship) => relationship.semanticKind === 'code',
      ),
    ).toBe(false)
    expect(
      result.relationships.some(
        (relationship) => relationship.kind === 'table',
      ),
    ).toBe(true)
  })

  it('does not promote a bibliography entry run or a typed equation to code', async () => {
    const references = preformattedTestRegion('bibliography-negative', 1, [
      { text: 'References:', fontName: 'NimbusRomNo9L-Regu', y: 0.2 },
      { text: '[1] A source-backed entry', fontName: 'SFTT1000', y: 0.24 },
      {
        text: '[2] Another source-backed entry',
        fontName: 'SFTT1000',
        y: 0.255,
      },
      {
        text: '[3] A final source-backed entry',
        fontName: 'SFTT1000',
        y: 0.27,
      },
    ])
    const equation = equationRegion(
      'typed-equation-negative',
      'x = y + 1',
      box(0.2, 0.42, 0.3, 0.02),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [references, equation],
      rasterizeFigure: preformattedCropRasterizer(),
    })

    expect(
      result.relationships.some(
        (relationship) => relationship.semanticKind === 'code',
      ),
    ).toBe(false)
    expect(
      result.relationships.some(
        (relationship) => relationship.kind === 'equation',
      ),
    ).toBe(true)
  })
})
