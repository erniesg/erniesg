import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfRegionLine,
  PdfSourceRun,
} from './import-types'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import { createSourcePageCropAsset } from './visual-assets'

function sourceBox(
  x: number,
  y: number,
  width: number,
  height: number,
): NormalizedSourceBox {
  return { page: 1, x, y, width, height, rotation: 0, method: 'pdf-text' }
}

function tableLine(
  id: string,
  y: number,
  cells: Array<{ text: string; x: number }>,
): PdfRegionLine {
  const runs = cells.map<PdfSourceRun>((cell) => ({
    ...sourceBox(cell.x, y, 0.1, 0.014),
    text: cell.text,
    fontName: 'Table',
    fontSize: 8,
    confidence: 1,
  }))
  return {
    id,
    text: runs.map((run) => run.text).join(' '),
    fontSize: 8,
    box: sourceBox(0.12, y, 0.68, 0.014),
    runs,
  }
}

function region(
  id: string,
  kind: PdfPageRegion['kind'],
  box: NormalizedSourceBox,
  lines: PdfRegionLine[],
  text: string,
): PdfPageRegion {
  return {
    id,
    page: 1,
    kind,
    column: 'single',
    text,
    confidence: 0.96,
    box,
    lines,
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function page(): PdfPageAnalysis {
  return {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: 0,
    imageCount: 0,
    objects: [],
    runs: [],
  }
}

describe('fail-closed non-semantic PDF table fallback', () => {
  it('reconstructs an atomized source-proved table semantically before raster fallback', async () => {
    const atomicLine = (
      id: string,
      y: number,
      cells: Array<{ text: string; x: number; width: number }>,
    ) => {
      const runs = cells.map<PdfSourceRun>((cell) => ({
        ...sourceBox(cell.x, y, cell.width, 0.01258),
        text: cell.text,
        fontName: 'Table',
        fontSize: 8,
        confidence: 1,
      }))
      const left = Math.min(...runs.map((run) => run.x))
      const right = Math.max(...runs.map((run) => run.x + run.width))
      return {
        id,
        text: runs.map((run) => run.text).join(' '),
        fontSize: 8,
        box: sourceBox(left, y, right - left, 0.01258),
        runs,
      } satisfies PdfRegionLine
    }
    const traitLines = [
      atomicLine('trait-header', 0.6167, [
        { text: 'Trait', x: 0.30697, width: 0.03497 },
      ]),
      atomicLine('evil-row-label', 0.63685, [
        { text: 'Evil', x: 0.30697, width: 0.02714 },
      ]),
      atomicLine('sycophancy-row-label', 0.65069, [
        { text: 'Sycophancy', x: 0.30697, width: 0.07933 },
      ]),
      atomicLine('hallucination-row-label', 0.66452, [
        { text: 'Hallucination', x: 0.30697, width: 0.08862 },
      ]),
    ]
    const sourceRegions = [
      region(
        'trait-column',
        'body',
        sourceBox(0.30697, 0.6167, 0.08862, 0.0604),
        traitLines,
        traitLines.map((line) => line.text).join(' '),
      ),
      region(
        'table-header',
        'spanning',
        sourceBox(0.41577, 0.6167, 0.27726, 0.01258),
        [
          atomicLine('score-header', 0.6167, [
            { text: 'LLM Judge Score', x: 0.41577, width: 0.11755 },
            { text: 'Projection Difference', x: 0.55286, width: 0.14017 },
          ]),
        ],
        'LLM Judge Score Projection Difference',
      ),
      region(
        'evil-judge-score',
        'body',
        sourceBox(0.4377, 0.63685, 0.07369, 0.01258),
        [
          atomicLine('evil-score', 0.63685, [
            { text: '1.6261e-14', x: 0.4377, width: 0.07369 },
          ]),
        ],
        '1.6261e-14',
      ),
      region(
        'right-stagger-a',
        'body',
        sourceBox(0.44809, 0.63685, 0.19723, 0.02642),
        [
          atomicLine('evil-projection', 0.63685, [
            { text: '4.3220', x: 0.60055, width: 0.04477 },
          ]),
          atomicLine('sycophancy-score', 0.65069, [
            { text: '31.7378', x: 0.44809, width: 0.05291 },
          ]),
        ],
        '4.3220 31.7378',
      ),
      region(
        'right-stagger-b',
        'body',
        sourceBox(0.44809, 0.65069, 0.19724, 0.02641),
        [
          atomicLine('sycophancy-projection', 0.65069, [
            { text: '4.9830', x: 0.60056, width: 0.04477 },
          ]),
          atomicLine('hallucination-score', 0.66452, [
            { text: '72.7075', x: 0.44809, width: 0.05291 },
          ]),
        ],
        '4.9830 72.7075',
      ),
      region(
        'hallucination-projection',
        'body',
        sourceBox(0.60056, 0.66452, 0.04477, 0.01258),
        [
          atomicLine('hallucination-projection-value', 0.66452, [
            { text: '2.2456', x: 0.60056, width: 0.04477 },
          ]),
        ],
        '2.2456',
      ),
    ]
    const captionLine = atomicLine('atomized-caption-line', 0.69411, [
      {
        text: 'Table 6. Filtering thresholds for both classifiers.',
        x: 0.23748,
        width: 0.52504,
      },
    ])
    captionLine.fontSize = 10
    captionLine.runs[0].fontSize = 10
    const caption = region(
      'atomized-table-caption',
      'caption',
      sourceBox(0.23748, 0.69411, 0.52504, 0.01258),
      [captionLine],
      captionLine.text,
    )
    const detectedTableBox = sourceBox(0.30697, 0.6167, 0.38606, 0.0604)
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const padding = detectedTableBox.x - input.sourceBox.x
        if (padding < 0.0119) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'table',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 48,
          height: 18,
          pixels: new Uint8Array(48 * 18 * 4).fill(80),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page()],
      regions: [...sourceRegions, caption],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      kind: 'table',
      status: 'matched',
      evidence: expect.arrayContaining([
        'detected-table-geometry',
        'semantic-table',
        'complete-bounded-table-scope',
        'semantic-header-explicit-matrix-geometry',
        'repeated-uniform-numeric-body-rows',
      ]),
    })
    expect(result.assets).toEqual([
      expect.objectContaining({
        kind: 'table',
        mediaType: 'application/xhtml+xml',
        rendition: 'semantic-table',
        sourceBoxes: [detectedTableBox],
      }),
    ])
  })

  it('expands an edge-touching proved table crop within neighboring source text', async () => {
    const lines = [
      tableLine('header', 0.22, [
        { text: 'Model', x: 0.12 },
        { text: 'English', x: 0.4 },
        { text: 'Chinese', x: 0.67 },
      ]),
      tableLine('row-1', 0.27, [
        { text: 'Baseline', x: 0.12 },
        { text: '72.1', x: 0.4 },
        { text: '71.4', x: 0.67 },
      ]),
      tableLine('row-2', 0.32, [
        { text: 'Proposed', x: 0.12 },
        { text: '81.4', x: 0.4 },
        { text: '79.8', x: 0.67 },
      ]),
    ]
    const tableBox = sourceBox(0.12, 0.22, 0.68, 0.114)
    const table = region(
      'edge-touching-table-source',
      'body',
      tableBox,
      lines,
      lines.map((line) => line.text).join(' '),
    )
    const precedingLine = tableLine('preceding-line', 0.19, [
      { text: 'Preceding prose remains outside the crop.', x: 0.12 },
    ])
    const preceding = region(
      'preceding-prose',
      'body',
      sourceBox(0.12, 0.19, 0.58, 0.014),
      [precedingLine],
      precedingLine.text,
    )
    const captionLine = tableLine('caption-line', 0.38, [
      { text: 'Table 1. Complete comparison results.', x: 0.12 },
    ])
    captionLine.fontSize = 10
    captionLine.runs[0].fontSize = 10
    const caption = region(
      'edge-touching-table-caption',
      'caption',
      sourceBox(0.12, 0.38, 0.68, 0.018),
      [captionLine],
      captionLine.text,
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const padding = tableBox.x - input.sourceBox.x
        if (padding < 0.0119) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'table',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 48,
          height: 18,
          pixels: new Uint8Array(48 * 18 * 4).fill(80),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page()],
      regions: [preceding, table, caption],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.map(([input]) =>
        Math.round((tableBox.x - input.sourceBox.x) * 1_000),
      ),
    ).toEqual([4, 0, 6, 8, 10, 12])
    const retained = rasterizeFigure.mock.calls.at(-1)![0].sourceBox
    expect(retained.y).toBeGreaterThanOrEqual(
      preceding.box.y + preceding.box.height,
    )
    expect(retained.y + retained.height).toBeLessThanOrEqual(caption.box.y)
    expect(result.relationships[0]).toMatchObject({
      kind: 'table',
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-neighbor-bounded',
      ]),
    })
  })

  it('uses more of a narrow caption gap when a bounded table edge still touches ink', async () => {
    const captionLine = tableLine('caption-line', 0.204, [
      { text: 'Table 1. Complete comparison results.', x: 0.12 },
    ])
    const caption = region(
      'narrow-gap-table-caption',
      'caption',
      sourceBox(0.12, 0.195, 0.68, 0.023),
      [captionLine],
      captionLine.text,
    )
    const lines = [
      tableLine('header', 0.22, [
        { text: 'Model', x: 0.12 },
        { text: 'English', x: 0.4 },
        { text: 'Chinese', x: 0.67 },
      ]),
      tableLine('row-1', 0.25, [
        { text: 'Baseline', x: 0.12 },
        { text: 'A', x: 0.31 },
        { text: '72.1', x: 0.49 },
        { text: '71.4', x: 0.67 },
      ]),
      tableLine('row-2', 0.28, [
        { text: 'Proposed', x: 0.12 },
        { text: 'A', x: 0.26 },
        { text: 'B', x: 0.4 },
        { text: '81.4', x: 0.54 },
        { text: '79.8', x: 0.68 },
      ]),
      tableLine('row-3', 0.31, [
        { text: 'A', x: 0.12 },
        { text: 'B', x: 0.23 },
        { text: 'C', x: 0.34 },
        { text: 'D', x: 0.45 },
        { text: 'E', x: 0.56 },
        { text: 'F', x: 0.67 },
      ]),
    ]
    const tableBox = sourceBox(0.12, 0.22, 0.68, 0.104)
    const table = region(
      'narrow-gap-table-source',
      'body',
      tableBox,
      lines,
      lines.map((line) => line.text).join(' '),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const topPadding = tableBox.y - input.sourceBox.y
        const horizontalPadding = tableBox.x - input.sourceBox.x
        if (topPadding < 0.00149 || horizontalPadding < 0.0119) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'table',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 48,
          height: 18,
          pixels: new Uint8Array(48 * 18 * 4).fill(80),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page()],
      regions: [caption, table],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'table',
      status: 'matched',
      evidence: expect.arrayContaining([
        'bounded-table-scope',
        'source-page-crop',
        'source-page-crop-adaptive-neighbor-gap',
        'source-page-crop-neighbor-bounded',
      ]),
    })
    const retained = rasterizeFigure.mock.calls.at(-1)![0].sourceBox
    expect(retained.y).toBeGreaterThanOrEqual(
      caption.box.y + caption.box.height,
    )
    expect(tableBox.y - retained.y).toBeGreaterThanOrEqual(0.00149)
  })

  it('retries a wide ruled envelope through 32pt while remaining caption-bounded', async () => {
    const lines = [
      tableLine('wide-header', 0.22, [
        { text: 'Method', x: 0.14 },
        { text: 'Automatic', x: 0.4 },
        { text: 'Human', x: 0.7 },
      ]),
      tableLine('wide-row-1', 0.27, [
        { text: 'Baseline', x: 0.14 },
        { text: '72.1', x: 0.4 },
        { text: '3.8', x: 0.7 },
      ]),
      tableLine('wide-row-2', 0.32, [
        { text: 'Proposed', x: 0.14 },
        { text: '81.4', x: 0.4 },
        { text: '4.2', x: 0.7 },
      ]),
    ]
    const tableBox = sourceBox(0.14, 0.22, 0.66, 0.114)
    const table = region(
      'wide-edge-table-source',
      'body',
      tableBox,
      lines,
      lines.map((line) => line.text).join(' '),
    )
    const captionLine = tableLine('wide-caption-line', 0.35, [
      { text: 'Table 1. Complete comparison results.', x: 0.14 },
    ])
    const caption = region(
      'wide-edge-table-caption',
      'caption',
      sourceBox(0.14, 0.35, 0.66, 0.018),
      [captionLine],
      captionLine.text,
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const horizontalPadding = tableBox.x - input.sourceBox.x
        if (horizontalPadding < 0.0319) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'table',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 96,
          height: 24,
          pixels: new Uint8Array(96 * 24 * 4).fill(80),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page()],
      regions: [table, caption],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.map(([input]) =>
        Math.round((tableBox.x - input.sourceBox.x) * 1_000),
      ),
    ).toEqual([24, 20, 26, 28, 30, 32])
    expect(
      rasterizeFigure.mock.calls.every(
        ([input]) =>
          input.sourceBox.y + input.sourceBox.height <= caption.box.y + 0.00001,
      ),
    ).toBe(true)
    expect(
      rasterizeFigure.mock.calls.every(
        ([input]) =>
          JSON.stringify(input.sourceObjectIds) ===
          JSON.stringify(rasterizeFigure.mock.calls[0][0].sourceObjectIds),
      ),
    ).toBe(true)
    expect(result.relationships[0]).toMatchObject({
      kind: 'table',
      status: 'matched',
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-page-crop-neighbor-bounded',
      ]),
    })
  })

  it('does not expand an edge-touching table crop through its caption', async () => {
    const lines = [
      tableLine(
        'header',
        0.22,
        [0.12, 0.4, 0.67].map((x) => ({ text: 'H', x })),
      ),
      tableLine(
        'row-1',
        0.27,
        [0.12, 0.4, 0.67].map((x) => ({ text: '1', x })),
      ),
      tableLine(
        'row-2',
        0.32,
        [0.12, 0.4, 0.67].map((x) => ({ text: '2', x })),
      ),
    ]
    const tableBox = sourceBox(0.12, 0.22, 0.68, 0.114)
    const table = region(
      'bounded-edge-table-source',
      'body',
      tableBox,
      lines,
      lines.map((line) => line.text).join(' '),
    )
    const captionLine = tableLine('near-caption-line', 0.34, [
      { text: 'Table 1. Caption must not be captured.', x: 0.12 },
    ])
    const caption = region(
      'near-table-caption',
      'caption',
      sourceBox(0.12, 0.34, 0.68, 0.018),
      [captionLine],
      captionLine.text,
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) => {
        const bottomPadding =
          input.sourceBox.y +
          input.sourceBox.height -
          (tableBox.y + tableBox.height)
        if (bottomPadding < 0.0119) {
          throw new Error('PDF page crop has source ink touching its edge')
        }
        return createSourcePageCropAsset({
          kind: 'table',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 48,
          height: 18,
          pixels: new Uint8Array(48 * 18 * 4).fill(80),
        })
      },
    )

    const result = await reconstructPdfVisuals({
      pages: [page()],
      regions: [table, caption],
      rasterizeFigure,
    })

    expect(
      rasterizeFigure.mock.calls.every(([input]) =>
        Boolean(
          input.sourceBox.y + input.sourceBox.height <= caption.box.y + 0.00001,
        ),
      ),
    ).toBe(true)
    expect(result.relationships[0]).toMatchObject({
      kind: 'table',
      status: 'unresolved',
      sourceRegionIds: [table.id],
      sourceLineIds: lines.map((line) => line.id),
      assetIds: [],
      sourceBoxes: expect.arrayContaining([caption.box, table.box]),
      sourceText: lines.map((line) => line.text).join(' '),
      evidence: expect.arrayContaining([
        'source-page-crop-edge-contact',
        'unresolved-bounded-table-text-owned',
      ]),
    })
    expect(result.relationships[0].evidence).not.toContain(
      'source-page-crop-payload-rejected',
    )
    expect(result.consumedRegionIds.has(table.id)).toBe(true)
    expect([...result.consumedLineIds]).toEqual([])
  })

  it('keeps a detected nonuniform table review-required without source pixels', async () => {
    const lines = [
      tableLine('header', 0.22, [
        { text: 'Model', x: 0.12 },
        { text: 'English', x: 0.4 },
        { text: 'Chinese', x: 0.67 },
      ]),
      tableLine('nonuniform-row', 0.27, [
        { text: 'Baseline', x: 0.12 },
        { text: '72.1', x: 0.67 },
      ]),
      tableLine('complete-row', 0.32, [
        { text: 'Proposed', x: 0.12 },
        { text: '81.4', x: 0.4 },
        { text: '79.8', x: 0.67 },
      ]),
    ]
    const table = region(
      'table-source',
      'body',
      sourceBox(0.12, 0.22, 0.68, 0.114),
      lines,
      lines.map((line) => line.text).join(' '),
    )
    const captionLine = tableLine('caption-line', 0.38, [
      { text: 'Table 1. Nonuniform comparison results.', x: 0.12 },
    ])
    captionLine.fontSize = 10
    captionLine.runs[0].fontSize = 10
    const caption = region(
      'table-caption',
      'caption',
      sourceBox(0.12, 0.38, 0.68, 0.018),
      [captionLine],
      captionLine.text,
    )

    const first = await reconstructPdfVisuals({
      pages: [page()],
      regions: [table, caption],
    })
    const second = await reconstructPdfVisuals({
      pages: [page()],
      regions: [table, caption],
    })

    expect(second.assets).toEqual(first.assets)
    expect(second.relationships).toEqual(first.relationships)
    expect(first.assets).toEqual([])
    expect(first.relationships).toEqual([
      expect.objectContaining({
        kind: 'table',
        label: 'Table 1',
        captionRegionId: caption.id,
        sourceRegionIds: [table.id],
        sourceLineIds: lines.map((line) => line.id),
        sourceObjectIds: [],
        assetIds: [],
        status: 'unresolved',
        sourceBoxes: expect.arrayContaining([caption.box, table.box]),
        sourceText: lines.map((line) => line.text).join(' '),
        evidence: expect.arrayContaining([
          'bounded-table-scope',
          'non-semantic-source-scope',
          'unresolved-bounded-table-text-owned',
          'source-rendition-unavailable',
        ]),
        candidates: [
          expect.objectContaining({
            sourceRegionIds: [table.id],
            assetIds: [],
          }),
        ],
      }),
    ])
    expect(first.consumedRegionIds.has(table.id)).toBe(true)
    expect(first.canonicalTablesByAssetId.size).toBe(0)
    expect(first.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_VISUAL_OBJECT',
          severity: 'error',
          target: expect.objectContaining({
            regionIds: expect.arrayContaining([caption.id, table.id]),
          }),
        }),
      ]),
    )

    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'table',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 24,
          height: 10,
          pixels: new Uint8Array(24 * 10 * 4).fill(80),
        }),
    )
    const cropped = await reconstructPdfVisuals({
      pages: [page()],
      regions: [table, caption],
      rasterizeFigure,
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(cropped.relationships[0]).toMatchObject({
      kind: 'table',
      status: 'matched',
      sourceRegionIds: [table.id],
      sourceObjectIds: [expect.stringMatching(/^table-scope-source:/)],
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(cropped.canonicalTablesByAssetId.size).toBe(0)
    expect(cropped.consumedRegionIds).toEqual(new Set([table.id]))
  })

  it('does not promote a caption-adjacent prose block into a table fallback', async () => {
    const lines = Array.from({ length: 7 }, (_, index) =>
      tableLine(`source-${index + 1}`, 0.2 + index * 0.02, [
        { text: `Source line ${index + 1}`, x: 0.12 },
      ]),
    )
    const source = region(
      'single-column-source',
      'body',
      sourceBox(0.1, 0.2, 0.72, 0.14),
      lines,
      lines.map((line) => line.text).join(' '),
    )
    const captionLine = tableLine('caption-line', 0.36, [
      { text: 'Table 1. Bounded source block.', x: 0.3 },
    ])
    captionLine.fontSize = 10
    captionLine.runs[0].fontSize = 10
    const caption = region(
      'table-caption',
      'caption',
      sourceBox(0.3, 0.36, 0.32, 0.018),
      [captionLine],
      captionLine.text,
    )

    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'table',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 24,
          height: 10,
          pixels: new Uint8Array(24 * 10 * 4).fill(80),
        }),
    )
    const result = await reconstructPdfVisuals({
      pages: [page()],
      regions: [source, caption],
      rasterizeFigure,
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'table',
      status: 'unresolved',
      sourceRegionIds: [],
      assetIds: [],
      candidates: [],
    })
    expect(result.assets).toEqual([])
    expect(result.consumedRegionIds.has(source.id)).toBe(false)
    expect(rasterizeFigure).not.toHaveBeenCalled()
  })
})
