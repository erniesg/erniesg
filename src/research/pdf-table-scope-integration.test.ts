import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfNativeObject,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfRegionLine,
  PdfSourceRun,
} from './import-types'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import { createPngAsset, createSourcePageCropAsset } from './visual-assets'

function box(
  x: number,
  y: number,
  width: number,
  height: number,
  method: NormalizedSourceBox['method'] = 'pdf-object',
): NormalizedSourceBox {
  return { page: 1, x, y, width, height, rotation: 0, method }
}

function paddedCropBox(sourceBox: NormalizedSourceBox) {
  const rounded = (value: number) => Math.round(value * 100_000) / 100_000
  const left = Math.max(0, sourceBox.x - 0.004)
  const top = Math.max(0, sourceBox.y - 0.004)
  const right = Math.min(1, sourceBox.x + sourceBox.width + 0.004)
  const bottom = Math.min(1, sourceBox.y + sourceBox.height + 0.004)
  return box(
    rounded(left),
    rounded(top),
    rounded(right - left),
    rounded(bottom - top),
  )
}

function caption(
  id: string,
  text: string,
  sourceBox = box(0.12, 0.4, 0.68, 0.02, 'pdf-text'),
): PdfPageRegion {
  return {
    id,
    page: 1,
    kind: 'caption',
    column: 'single',
    text,
    confidence: 0.99,
    box: sourceBox,
    lines: [],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function objectRegion(
  id: string,
  objectId: string,
  sourceBox: NormalizedSourceBox,
): PdfPageRegion {
  return {
    id,
    page: 1,
    kind: 'figure',
    column: 'single',
    text: '',
    confidence: 0.99,
    box: sourceBox,
    lines: [],
    nativeObjectIds: [objectId],
    includedInReadingOrder: true,
  }
}

function page(
  objects: PdfNativeObject[],
  assets: NonNullable<PdfPageAnalysis['assets']> = [],
): PdfPageAnalysis {
  return {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: 0,
    imageCount: objects.filter((object) => object.kind === 'image').length,
    objects,
    assets,
    runs: [],
  }
}

function tabularLine(id: string, y: number, anchors: number[]): PdfRegionLine {
  const runs = anchors.map<PdfSourceRun>((x, index) => ({
    ...box(x, y, 0.075, 0.014, 'pdf-text'),
    text: `${id}-${index + 1}`,
    fontName: 'TableSerif',
    fontSize: 8,
    confidence: 0.99,
  }))
  return {
    id,
    text: runs.map((run) => run.text).join(' '),
    fontSize: 8,
    box: box(
      anchors[0],
      y,
      anchors.at(-1)! + 0.075 - anchors[0],
      0.014,
      'pdf-text',
    ),
    runs,
  }
}

function tableLine(id: string, y: number): PdfRegionLine {
  return tabularLine(id, y, [0.12, 0.4, 0.67])
}

function equationTableCellLine(id: string, y: number, x = 0.32): PdfRegionLine {
  const sourceBox = box(x, y, 0.28, 0.014, 'pdf-text')
  return {
    id,
    text: `Output ONLY a number. {a}+{b}=`,
    fontSize: 8,
    box: sourceBox,
    runs: [
      {
        ...sourceBox,
        text: `Output ONLY a number. {a}+{b}=`,
        fontName: 'TableSerif',
        fontSize: 8,
        confidence: 0.99,
      },
    ],
  }
}

function proseLine(id: string, y: number): PdfRegionLine {
  const runs = [0.12, 0.202, 0.284, 0.366].map<PdfSourceRun>((x, index) => ({
    ...box(x, y, 0.078, 0.014, 'pdf-text'),
    text: `${id}-word-${index + 1}`,
    fontName: 'BodySerif',
    fontSize: 10,
    confidence: 0.99,
  }))
  return {
    id,
    text: runs.map((run) => run.text).join(' '),
    fontSize: 10,
    box: box(0.12, y, 0.324, 0.014, 'pdf-text'),
    runs,
  }
}

function mixedParent(
  id: string,
  sourceBox: NormalizedSourceBox,
  lines: PdfRegionLine[],
): PdfPageRegion {
  return {
    id,
    page: 1,
    kind: 'body',
    column: 'single',
    text: lines.map((line) => line.text).join(' '),
    confidence: 0.99,
    box: sourceBox,
    lines,
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function distantTextGrid(): PdfPageRegion {
  const lines = [
    tableLine('header', 0.1),
    tableLine('row-1', 0.125),
    tableLine('row-2', 0.15),
  ]
  return {
    id: 'distant-table-grid',
    page: 1,
    kind: 'body',
    column: 'single',
    text: lines.map((line) => line.text).join(' '),
    confidence: 0.99,
    box: box(0.12, 0.1, 0.625, 0.064, 'pdf-text'),
    lines,
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function distantNonuniformGrid(): PdfPageRegion {
  const grid = distantTextGrid()
  const lines = grid.lines.map((line, index) => {
    if (index !== 1) return line
    const runs = [line.runs[0], line.runs[2]]
    return {
      ...line,
      text: runs.map((run) => run.text).join(' '),
      runs,
    }
  })
  return {
    ...grid,
    id: 'distant-nonuniform-table-grid',
    text: lines.map((line) => line.text).join(' '),
    lines,
  }
}

function cropRasterizer() {
  return vi.fn(async (input: Parameters<PdfFigureRasterizer>[0]) =>
    createSourcePageCropAsset({
      kind: 'table',
      cropBox: input.sourceBox,
      sourceObjectIds: input.sourceObjectIds,
      sourceBoxes: input.sourceBoxes,
      width: 48,
      height: 20,
      pixels: new Uint8Array(48 * 20 * 4).fill(88),
    }),
  )
}

describe('bounded table-scope visual fallback', () => {
  it('reuses one exact native raster without claiming semantic HTML', async () => {
    const sourceBox = box(0.16, 0.18, 0.61, 0.15)
    const sourceObjectId = 'image-p001-001'
    const visualAsset = await createPngAsset({
      sourceObjectId,
      sourceBox,
      width: 20,
      height: 10,
      colorSpace: 'rgba',
      pixels: new Uint8Array(20 * 10 * 4).fill(72),
    })
    const object: PdfNativeObject = {
      id: sourceObjectId,
      page: 1,
      kind: 'image',
      box: sourceBox,
      confidence: 0.99,
      assetId: visualAsset.id,
    }
    const sourceRegion = objectRegion(
      'native-table-region',
      object.id,
      sourceBox,
    )
    const rasterizeFigure = cropRasterizer()

    const result = await reconstructPdfVisuals({
      pages: [page([object], [visualAsset])],
      regions: [
        sourceRegion,
        caption('table-caption', 'Table 1. Native benchmark results.'),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      kind: 'table',
      status: 'matched',
      sourceRegionIds: [sourceRegion.id],
      sourceObjectIds: [object.id],
      assetIds: [visualAsset.id],
      evidence: expect.arrayContaining([
        'bounded-table-scope',
        'source-native-raster',
        'non-semantic-source-scope',
      ]),
      altText: 'Table 1. Native benchmark results.',
    })
    expect(result.relationships[0].evidence).not.toContain('semantic-table')
    expect(result.canonicalTablesByAssetId.size).toBe(0)
    expect(result.consumedRegionIds.has(sourceRegion.id)).toBe(true)
  })

  it('leaves a table unresolved when source text separates its caption from a later figure raster', async () => {
    const sourceBox = box(
      0.5023529411764706,
      0.4974699575757575,
      0.17470802352941173,
      0.1503330727272727,
    )
    const sourceObjectId = 'image-p013-002'
    const visualAsset = await createPngAsset({
      sourceObjectId,
      sourceBox,
      width: 20,
      height: 10,
      colorSpace: 'rgba',
      pixels: new Uint8Array(20 * 10 * 4).fill(72),
    })
    const object: PdfNativeObject = {
      id: sourceObjectId,
      page: 1,
      kind: 'image',
      box: sourceBox,
      confidence: 0.99,
      assetId: visualAsset.id,
    }
    const sourceRegion = objectRegion(
      'page-013-object-region-033',
      object.id,
      sourceBox,
    )
    const promptLine = tabularLine(
      'page-013-prompt-row',
      0.44611,
      [0.20336, 0.31195, 0.70188],
    )
    const interveningPrompt = {
      ...mixedParent('page-013-intervening-prompt', promptLine.box, [
        promptLine,
      ]),
      kind: 'equation' as const,
    }
    const tableCaption = caption(
      'page-013-table-2-caption',
      'Table 2. The prompts used and accuracy of each model.',
      box(0.24623, 0.37696, 0.48284, 0.01132, 'pdf-text'),
    )
    const figureCaption = caption(
      'page-013-figure-13-caption',
      'Figure 13. Periodic representations.',
      box(0.50153, 0.66433, 0.3856, 0.02516, 'pdf-text'),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([object], [visualAsset])],
      regions: [tableCaption, interveningPrompt, sourceRegion, figureCaption],
    })

    const table = result.relationships.find(
      (relationship) => relationship.label === 'Table 2',
    )
    const figure = result.relationships.find(
      (relationship) => relationship.label === 'Figure 13',
    )
    expect(table).toMatchObject({
      kind: 'table',
      status: 'unresolved',
      sourceRegionIds: [],
      sourceObjectIds: [],
      assetIds: [],
      evidence: expect.arrayContaining(['intervening-source-text']),
      candidates: [],
    })
    expect(figure).toMatchObject({
      kind: 'figure',
      status: 'matched',
      sourceRegionIds: [sourceRegion.id],
      sourceObjectIds: [object.id],
      assetIds: [visualAsset.id],
    })
  })

  it('rasterizes one exact native ruled scope without promoting it to a semantic table', async () => {
    const horizontal = [0.2, 0.28, 0.36].map<PdfNativeObject>((y, index) => ({
      id: `vector-horizontal-${index + 1}`,
      page: 1,
      kind: 'vector',
      box: box(0.15, y, 0.6, 0.002),
      confidence: 0.99,
      assetId: `asset-horizontal-${index + 1}`,
    }))
    const vertical = [0.15, 0.45, 0.75].map<PdfNativeObject>((x, index) => ({
      id: `vector-vertical-${index + 1}`,
      page: 1,
      kind: 'vector',
      box: box(x, 0.2, 0.002, 0.162),
      confidence: 0.99,
      assetId: `asset-vertical-${index + 1}`,
    }))
    const objects = [...horizontal, ...vertical]
    const sourceRegions = objects.map((object, index) =>
      objectRegion(`rule-region-${index + 1}`, object.id, object.box),
    )
    const rasterizeFigure = cropRasterizer()

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...sourceRegions,
        caption(
          'table-caption',
          'Table 2. Ruled benchmark results.',
          box(0.12, 0.43, 0.68, 0.02, 'pdf-text'),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure).toHaveBeenCalledWith({
      kind: 'table',
      page: 1,
      sourceBox: paddedCropBox(box(0.15, 0.2, 0.602, 0.162)),
      sourceObjectIds: objects.map((object) => object.id).sort(),
      sourceBoxes: objects
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((object) => object.box),
    })
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: sourceRegions.map((region) => region.id).sort(),
      sourceObjectIds: objects.map((object) => object.id).sort(),
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining([
        'bounded-table-scope',
        'source-native-ruled-geometry',
        'non-semantic-source-scope',
        'source-page-crop',
      ]),
    })
    expect(result.relationships[0].evidence).not.toContain('semantic-table')
    expect(result.canonicalTablesByAssetId.size).toBe(0)
    expect(
      sourceRegions.every((region) => result.consumedRegionIds.has(region.id)),
    ).toBe(true)
  })

  it('preserves competing bounded scopes as ambiguity and consumes neither', async () => {
    const sourceBoxes = [
      box(0.16, 0.16, 0.61, 0.07),
      box(0.16, 0.29, 0.61, 0.07),
    ]
    const assets = await Promise.all(
      sourceBoxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-00${index + 1}`,
          sourceBox,
          width: 20,
          height: 8,
          colorSpace: 'rgba',
          pixels: new Uint8Array(20 * 8 * 4).fill(72 + index),
        }),
      ),
    )
    const objects = sourceBoxes.map<PdfNativeObject>((sourceBox, index) => ({
      id: `image-p001-00${index + 1}`,
      page: 1,
      kind: 'image',
      box: sourceBox,
      confidence: 0.99,
      assetId: assets[index].id,
    }))
    const sourceRegions = objects.map((object, index) =>
      objectRegion(`raster-region-${index + 1}`, object.id, object.box),
    )
    const rasterizeFigure = cropRasterizer()

    const result = await reconstructPdfVisuals({
      pages: [page(objects, assets)],
      regions: [
        ...sourceRegions,
        caption('table-caption', 'Table 1. Competing raster scopes.'),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      status: 'ambiguous',
      sourceRegionIds: [],
      sourceObjectIds: [],
      assetIds: [],
      evidence: expect.arrayContaining([
        'bounded-table-scope-ambiguous',
        'competing-scopes',
      ]),
      candidates: [
        expect.objectContaining({ sourceObjectIds: [objects[0].id] }),
        expect.objectContaining({ sourceObjectIds: [objects[1].id] }),
      ],
    })
    expect(
      sourceRegions.every((region) => !result.consumedRegionIds.has(region.id)),
    ).toBe(true)
  })

  it('does not let a second table caption reclaim a consumed native region', async () => {
    const sourceBox = box(0.16, 0.18, 0.61, 0.15)
    const sourceObjectId = 'image-p001-001'
    const visualAsset = await createPngAsset({
      sourceObjectId,
      sourceBox,
      width: 20,
      height: 10,
      colorSpace: 'rgba',
      pixels: new Uint8Array(20 * 10 * 4).fill(72),
    })
    const object: PdfNativeObject = {
      id: sourceObjectId,
      page: 1,
      kind: 'image',
      box: sourceBox,
      confidence: 0.99,
      assetId: visualAsset.id,
    }
    const sourceRegion = objectRegion(
      'native-table-region',
      object.id,
      sourceBox,
    )

    const result = await reconstructPdfVisuals({
      pages: [page([object], [visualAsset])],
      regions: [
        sourceRegion,
        caption('table-caption-1', 'Table 1. First claim.'),
        caption('table-caption-2', 'Table 2. Duplicate claim.'),
      ],
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        label: 'Table 1',
        status: 'matched',
        sourceRegionIds: [sourceRegion.id],
      }),
      expect.objectContaining({
        label: 'Table 2',
        status: 'unresolved',
        sourceRegionIds: [],
        candidates: [],
      }),
    ])
  })

  it('derives fallback text-grid lineage from source scope rather than caption identity', async () => {
    const grid = distantTextGrid()
    const firstCaption = caption(
      'caption-alpha',
      'Table 1. Distant exact grid.',
      box(0.12, 0.39, 0.68, 0.02, 'pdf-text'),
    )
    const secondCaption = { ...firstCaption, id: 'caption-beta' }
    const firstRasterizer = cropRasterizer()
    const secondRasterizer = cropRasterizer()

    const first = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [grid, firstCaption],
      rasterizeFigure: firstRasterizer,
    })
    const second = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [grid, secondCaption],
      rasterizeFigure: secondRasterizer,
    })

    expect(firstRasterizer).toHaveBeenCalledOnce()
    expect(secondRasterizer).toHaveBeenCalledOnce()
    const firstInput = firstRasterizer.mock.calls[0]![0]
    const secondInput = secondRasterizer.mock.calls[0]![0]
    expect(firstInput.sourceObjectIds).toEqual(secondInput.sourceObjectIds)
    expect(firstInput.sourceObjectIds[0]).not.toContain(firstCaption.id)
    expect(firstInput.sourceObjectIds[0]).not.toContain(secondCaption.id)
    expect(firstInput.sourceBox).toEqual(paddedCropBox(grid.box))
    expect(first.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: [grid.id],
      sourceObjectIds: firstInput.sourceObjectIds,
      evidence: expect.arrayContaining([
        'bounded-table-scope',
        'repeated-row-bands',
        'repeated-column-anchors',
        'non-semantic-source-scope',
        'source-page-crop',
      ]),
      altText: firstCaption.text,
    })
    expect(first.relationships[0].evidence).not.toContain('semantic-table')
    expect(first.canonicalTablesByAssetId.size).toBe(0)
    expect(second.canonicalTablesByAssetId.size).toBe(0)
  })

  it('keeps a nonuniform majority-anchor scope crop-only', async () => {
    const grid = distantNonuniformGrid()
    const tableCaption = caption(
      'nonuniform-caption',
      'Table 1. Nonuniform exact grid.',
      box(0.12, 0.39, 0.68, 0.02, 'pdf-text'),
    )
    const rasterizeFigure = cropRasterizer()

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [grid, tableCaption],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: [grid.id],
      evidence: expect.arrayContaining([
        'bounded-table-scope',
        'connected-sparse-rows',
        'non-semantic-source-scope',
        'source-page-crop',
      ]),
    })
    expect(result.relationships[0].evidence).not.toContain('semantic-table')
    expect(result.canonicalTablesByAssetId.size).toBe(0)
  })

  it('crops an exact partial-parent line band while retaining parent prose', async () => {
    const prose = [proseLine('prose-1', 0.27), proseLine('prose-2', 0.31)]
    const tableLines = [
      tabularLine('table-header', 0.52, [0.12, 0.4, 0.67]),
      tabularLine('table-row-1', 0.56, [0.12, 0.3, 0.5, 0.7]),
      tabularLine('table-row-2', 0.6, [0.12, 0.25, 0.38, 0.53, 0.7]),
      tabularLine('table-row-3', 0.64, [0.12, 0.23, 0.34, 0.46, 0.58, 0.7]),
    ]
    const parent = mixedParent(
      'mixed-parent',
      box(0.12, 0.25, 0.66, 0.404, 'pdf-text'),
      [...prose, ...tableLines],
    )
    const tableCaption = caption(
      'partial-table-caption',
      'Table 7. Exact partial-parent results.',
      box(0.12, 0.678, 0.68, 0.02, 'pdf-text'),
    )
    const rasterizeFigure = cropRasterizer()

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [parent, tableCaption],
      rasterizeFigure,
    })

    const cropBox = box(0.12, 0.52, 0.655, 0.134, 'pdf-text')
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure).toHaveBeenCalledWith({
      kind: 'table',
      page: 1,
      sourceBox: paddedCropBox(cropBox),
      sourceObjectIds: [expect.stringMatching(/^table-scope-source:/)],
      sourceBoxes: [cropBox],
    })
    expect(result.relationships[0]).toMatchObject({
      kind: 'table',
      status: 'matched',
      sourceRegionIds: [parent.id],
      sourceLineIds: tableLines.map((line) => line.id),
      sourceObjectIds: [expect.stringMatching(/^table-scope-source:/)],
      sourceBoxes: [tableCaption.box, cropBox],
      sourceText: tableLines.map((line) => line.text).join(' '),
      evidence: expect.arrayContaining([
        'bounded-table-scope',
        'multi-run-tabular-line-band',
        'partial-parent-line-selection',
        'non-semantic-source-scope',
        'source-page-crop',
      ]),
    })
    expect(result.relationships[0].sourceText).not.toContain('prose')
    expect(result.consumedRegionIds.has(parent.id)).toBe(false)
    expect([...result.consumedLineIds].sort()).toEqual(
      tableLines.map((line) => line.id).sort(),
    )
    expect(result.partialRegionLineSelections).toEqual([
      {
        regionId: parent.id,
        consumedLineIds: tableLines.map((line) => line.id).sort(),
        retainedLineIds: prose.map((line) => line.id).sort(),
      },
    ])
    expect(result.canonicalTablesByAssetId.size).toBe(0)
  })

  it('crops a proved body scope with its unique adjacent table header', async () => {
    const headerLine = tabularLine('omitted-header', 0.49, [0.12, 0.4, 0.67])
    const header = {
      ...mixedParent(
        'omitted-header-region',
        box(0.12, 0.49, 0.625, 0.014, 'pdf-text'),
        [headerLine],
      ),
      kind: 'header' as const,
    }
    const bodyLines = [
      tabularLine('body-row-1', 0.52, [0.12, 0.4, 0.67]),
      tabularLine('body-row-2', 0.56, [0.12, 0.3, 0.5, 0.7]),
      tabularLine('body-row-3', 0.6, [0.12, 0.25, 0.38, 0.53, 0.7]),
    ]
    const body = mixedParent(
      'table-body-region',
      box(0.12, 0.52, 0.655, 0.094, 'pdf-text'),
      bodyLines,
    )
    const tableCaption = caption(
      'header-omission-caption',
      'Table 9. Header-complete results.',
      box(0.12, 0.638, 0.68, 0.02, 'pdf-text'),
    )
    const rasterizeFigure = cropRasterizer()

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [header, body, tableCaption],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      kind: 'table',
      status: 'matched',
      sourceRegionIds: [header.id, body.id],
      sourceLineIds: [headerLine.id, ...bodyLines.map((line) => line.id)],
      evidence: expect.arrayContaining([
        'bounded-table-scope',
        'caption-lane-source-completion',
        'non-semantic-source-scope',
        'source-page-crop',
      ]),
    })
    expect(result.consumedRegionIds).toEqual(new Set([header.id, body.id]))
    expect(result.consumedLineIds).toEqual(
      new Set([headerLine.id, ...bodyLines.map((line) => line.id)]),
    )
    expect(result.canonicalTablesByAssetId.size).toBe(0)
  })

  it('promotes a complete rectangular table when source header regions close the proved body scope', async () => {
    const headerLine = tabularLine('source-header', 0.49, [0.12, 0.4, 0.67])
    const header = {
      ...mixedParent(
        'source-header-region',
        box(0.12, 0.49, 0.625, 0.014, 'pdf-text'),
        [headerLine],
      ),
      kind: 'header' as const,
    }
    const bodyLines = [
      tabularLine('body-row-1', 0.52, [0.12, 0.4, 0.67]),
      tabularLine('body-row-2', 0.56, [0.12, 0.4, 0.67]),
      tabularLine('body-row-3', 0.6, [0.12, 0.4, 0.67]),
    ]
    const body = mixedParent(
      'complete-table-body',
      box(0.12, 0.52, 0.625, 0.094, 'pdf-text'),
      bodyLines,
    )
    const tableCaption = caption(
      'source-header-caption',
      'Table 10. Header-complete rectangular results.',
      box(0.12, 0.638, 0.68, 0.02, 'pdf-text'),
    )
    const rasterizeFigure = cropRasterizer()

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [header, body, tableCaption],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      kind: 'table',
      status: 'matched',
      sourceRegionIds: [header.id, body.id],
      sourceLineIds: [headerLine.id, ...bodyLines.map((line) => line.id)],
      evidence: expect.arrayContaining([
        'detected-table-geometry',
        'semantic-table',
        'semantic-header-table-local-geometry',
        'complete-bounded-table-scope',
      ]),
    })
    expect(result.canonicalTablesByAssetId.size).toBe(1)
    expect(result.consumedRegionIds).toEqual(new Set([header.id, body.id]))
  })

  it('promotes a complete left-aligned table only after its equation cell shard is independently scoped', async () => {
    const headerLine = tabularLine(
      'table-header-left-middle',
      0.22,
      [0.2, 0.32],
    )
    headerLine.runs.forEach((run) => {
      run.bold = true
      run.fontName = 'TableSerif-Medium'
    })
    const left = mixedParent(
      'table-left-shard',
      box(0.2, 0.22, 0.195, 0.074, 'pdf-text'),
      [
        headerLine,
        tabularLine('table-row-1-left', 0.25, [0.2]),
        tabularLine('table-row-2-left', 0.28, [0.2]),
      ],
    )
    const rightHeader = tabularLine('table-row-0-right', 0.22, [0.7])
    rightHeader.runs.forEach((run) => {
      run.bold = true
      run.fontName = 'TableSerif-Medium'
    })
    const right = mixedParent(
      'table-right-shard',
      box(0.7, 0.22, 0.075, 0.074, 'pdf-text'),
      [
        rightHeader,
        tabularLine('table-row-1-right', 0.25, [0.7]),
        tabularLine('table-row-2-right', 0.28, [0.7]),
      ],
    )
    const equation = {
      ...mixedParent(
        'table-equation-shard',
        box(0.32, 0.25, 0.28, 0.044, 'pdf-text'),
        [
          equationTableCellLine('table-equation-cell-1', 0.25),
          equationTableCellLine('table-equation-cell-2', 0.28),
        ],
      ),
      kind: 'equation' as const,
    }
    const final = {
      ...mixedParent(
        'table-final-row',
        box(0.2, 0.31, 0.575, 0.014, 'pdf-text'),
        [tabularLine('table-final-row-line', 0.31, [0.2, 0.32, 0.7])],
      ),
      kind: 'spanning' as const,
    }
    const tableCaption = caption(
      'supplemented-table-caption',
      'Table 2. Prompts and model accuracy.',
      box(0.18, 0.18, 0.6, 0.02, 'pdf-text'),
    )
    const rasterizeFigure = cropRasterizer()

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [tableCaption, left, right, equation, final],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      kind: 'table',
      status: 'matched',
      sourceRegionIds: expect.arrayContaining([
        left.id,
        right.id,
        equation.id,
        final.id,
      ]),
      sourceLineIds: expect.arrayContaining([
        headerLine.id,
        'table-row-0-right',
        'table-row-1-left',
        'table-equation-cell-1',
        'table-row-1-right',
        'table-row-2-left',
        'table-equation-cell-2',
        'table-row-2-right',
        'table-final-row-line',
      ]),
      evidence: expect.arrayContaining([
        'detected-table-geometry',
        'semantic-table',
        'complete-bounded-table-scope',
        'semantic-header-explicit-style',
        'supplemental-equation-cell-shard',
      ]),
    })
    expect(result.canonicalTablesByAssetId.size).toBe(1)
    expect(
      [...result.canonicalTablesByAssetId.values()][0].rows.map((row) =>
        row.cells.map((cell) => cell.text),
      ),
    ).toEqual([
      [
        'table-header-left-middle-1',
        'table-header-left-middle-2',
        'table-row-0-right-1',
      ],
      [
        'table-row-1-left-1',
        'Output ONLY a number. {a}+{b}=',
        'table-row-1-right-1',
      ],
      [
        'table-row-2-left-1',
        'Output ONLY a number. {a}+{b}=',
        'table-row-2-right-1',
      ],
      [
        'table-final-row-line-1',
        'table-final-row-line-2',
        'table-final-row-line-3',
      ],
    ])
  })

  it('does not crop or consume either partial parent when line bands compete', async () => {
    const aboveLines = [
      tabularLine('above-row-1', 0.38, [0.12, 0.4, 0.67]),
      tabularLine('above-row-2', 0.42, [0.12, 0.3, 0.5, 0.7]),
      tabularLine('above-row-3', 0.46, [0.12, 0.25, 0.38, 0.53, 0.7]),
    ]
    const belowLines = [
      tabularLine('below-row-1', 0.544, [0.12, 0.4, 0.67]),
      tabularLine('below-row-2', 0.584, [0.12, 0.3, 0.5, 0.7]),
      tabularLine('below-row-3', 0.624, [0.12, 0.25, 0.38, 0.53, 0.7]),
    ]
    const above = mixedParent(
      'above-parent',
      box(0.12, 0.12, 0.66, 0.354, 'pdf-text'),
      [proseLine('above-prose', 0.14), ...aboveLines],
    )
    const below = mixedParent(
      'below-parent',
      box(0.12, 0.544, 0.66, 0.31, 'pdf-text'),
      [...belowLines, proseLine('below-prose', 0.84)],
    )
    const tableCaption = caption(
      'ambiguous-partial-caption',
      'Table 8. Competing partial parents.',
      box(0.12, 0.5, 0.68, 0.02, 'pdf-text'),
    )
    const rasterizeFigure = cropRasterizer()

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [above, tableCaption, below],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      kind: 'table',
      status: 'ambiguous',
      sourceRegionIds: [],
      evidence: expect.arrayContaining([
        'bounded-table-scope-ambiguous',
        'competing-scopes',
      ]),
    })
    expect(result.consumedRegionIds.size).toBe(0)
    expect(result.consumedLineIds.size).toBe(0)
    expect(result.partialRegionLineSelections).toEqual([])
  })
})
