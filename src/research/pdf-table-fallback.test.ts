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
        sourceRegionIds: [],
        sourceObjectIds: [],
        assetIds: [],
        status: 'unresolved',
        evidence: expect.arrayContaining([
          'bounded-table-scope',
          'non-semantic-source-scope',
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
    expect(first.consumedRegionIds.has(table.id)).toBe(false)
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
