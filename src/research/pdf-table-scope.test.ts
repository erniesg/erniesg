import { describe, expect, it } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfNativeObject,
  PdfPageRegion,
  PdfRegionLine,
  PdfSourceRun,
} from './import-types'
import { resolvePdfTableScope } from './pdf-table-scope'

function box(
  x: number,
  y: number,
  width: number,
  height: number,
  method: NormalizedSourceBox['method'] = 'pdf-text',
): NormalizedSourceBox {
  return { page: 1, x, y, width, height, rotation: 0, method }
}

function line(id: string, y: number, cells: number[]): PdfRegionLine {
  const runs = cells.map<PdfSourceRun>((x, index) => ({
    ...box(x, y, 0.075, 0.016),
    text: `${id}-${index + 1}`,
    fontName: 'TableSerif',
    fontSize: 8,
    confidence: 0.99,
  }))
  return {
    id,
    text: runs.map((run) => run.text).join(' '),
    fontSize: 8,
    box: box(cells[0], y, cells.at(-1)! + 0.075 - cells[0], 0.016),
    runs,
  }
}

function proseLine(id: string, y: number): PdfRegionLine {
  const runs = [0.12, 0.202, 0.284, 0.366].map<PdfSourceRun>((x, index) => ({
    ...box(x, y, 0.078, 0.016),
    text: `${id}-word-${index + 1}`,
    fontName: 'BodySerif',
    fontSize: 10,
    confidence: 0.99,
  }))
  return {
    id,
    text: runs.map((run) => run.text).join(' '),
    fontSize: 10,
    box: box(0.12, y, 0.324, 0.016),
    runs,
  }
}

function textRegion(
  id: string,
  sourceBox: NormalizedSourceBox,
  lines: PdfRegionLine[],
  kind: PdfPageRegion['kind'] = 'body',
): PdfPageRegion {
  return {
    id,
    page: sourceBox.page,
    kind,
    column: 'single',
    text: lines.map((item) => item.text).join(' '),
    confidence: 0.98,
    box: sourceBox,
    lines,
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function caption(
  id = 'caption-table-1',
  y = 0.38,
  text = 'Table 1. Exact benchmark results.',
): PdfPageRegion {
  return {
    id,
    page: 1,
    kind: 'caption',
    column: 'single',
    text,
    confidence: 0.99,
    box: box(0.12, y, 0.68, 0.02),
    lines: [],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function nativeObject(
  id: string,
  kind: PdfNativeObject['kind'],
  sourceBox: NormalizedSourceBox,
): PdfNativeObject {
  return {
    id,
    page: sourceBox.page,
    kind,
    box: sourceBox,
    confidence: 0.99,
    assetId: `asset-${id}`,
  }
}

function objectRegion(
  id: string,
  objectId: string,
  sourceBox: NormalizedSourceBox,
): PdfPageRegion {
  return {
    id,
    page: sourceBox.page,
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

describe('bounded PDF table source scoping', () => {
  it('returns one exact text scope when repeated row and column geometry proves it', () => {
    const table = textRegion('table-grid', box(0.12, 0.2, 0.63, 0.116), [
      line('header', 0.2, [0.12, 0.4, 0.67]),
      line('row-1', 0.25, [0.12, 0.4, 0.67]),
      line('row-2', 0.3, [0.12, 0.4, 0.67]),
    ])
    const tableCaption = caption()

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, table],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      schemaVersion: '1.0.0',
      captionRegionId: tableCaption.id,
      status: 'matched',
      ambiguity: { code: 'none', candidateIds: [] },
      scope: {
        proof: 'text-grid',
        direction: 'above',
        sourceRegionIds: [table.id],
        sourceObjectIds: [],
        sourceBoxes: [table.box],
        cropBox: table.box,
        regionLineage: [
          {
            regionId: table.id,
            lineIds: ['header', 'row-1', 'row-2'],
            box: table.box,
          },
        ],
        objectLineage: [],
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'repeated-row-bands',
            rowCount: 3,
          }),
          expect.objectContaining({
            code: 'repeated-column-anchors',
            columnCount: 3,
            anchors: [0.12, 0.4, 0.67],
          }),
          expect.objectContaining({ code: 'caption-bounded-scope' }),
        ]),
      },
    })
    expect(result.candidates).toHaveLength(1)
  })

  it('retains a connected sparse row when a majority proves three column anchors', () => {
    const table = textRegion('nonuniform-table', box(0.12, 0.2, 0.63, 0.116), [
      line('header', 0.2, [0.12, 0.4, 0.67]),
      line('sparse-row', 0.25, [0.12, 0.67]),
      line('complete-row', 0.3, [0.12, 0.4, 0.67]),
    ])

    const result = resolvePdfTableScope({
      caption: caption(),
      pageRegions: [table, caption()],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-nonuniform-grid',
        sourceRegionIds: [table.id],
        cropBox: table.box,
        regionLineage: [
          {
            regionId: table.id,
            lineIds: ['complete-row', 'header', 'sparse-row'],
          },
        ],
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'repeated-column-anchors',
            columnCount: 3,
            anchors: [0.12, 0.4, 0.67],
            strongRowCount: 2,
            requiredStrongRowCount: 2,
          }),
          expect.objectContaining({
            code: 'connected-sparse-rows',
            sparseRowCount: 1,
            lineIds: ['sparse-row'],
          }),
        ]),
      },
    })
  })

  it('proves a source grid split into one-line cell regions with nonuniform header rows', () => {
    const atomicCell = (id: string, x: number, y: number, width = 0.08) => {
      const sourceLine = line(id, y, [x])
      sourceLine.box = box(x, y, width, 0.016)
      sourceLine.runs[0].width = width
      return textRegion(
        id,
        box(x, y, width, 0.016),
        [sourceLine],
        'chart-label',
      )
    }
    const cells = [
      atomicCell('header-wide', 0.12, 0.18, 0.22),
      atomicCell('header-right', 0.51, 0.18, 0.14),
      ...[0.22, 0.26, 0.3, 0.34].flatMap((y, rowIndex) =>
        [0.12, 0.31, 0.52, 0.7].map((x, columnIndex) =>
          atomicCell(`cell-${rowIndex + 1}-${columnIndex + 1}`, x, y),
        ),
      ),
    ]
    const adjacentProse = textRegion(
      'adjacent-prose',
      box(0.75, 0.22, 0.12, 0.116),
      [
        line('prose-1', 0.22, [0.75]),
        line('prose-2', 0.26, [0.75]),
        line('prose-3', 0.3, [0.75]),
      ],
    )

    const result = resolvePdfTableScope({
      caption: caption(),
      pageRegions: [...cells, adjacentProse, caption()],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-nonuniform-grid',
        sourceRegionIds: cells.map((cell) => cell.id).sort(),
        cropBox: box(0.12, 0.18, 0.66, 0.176),
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'repeated-column-anchors',
            columnCount: 4,
            strongRowCount: 4,
            requiredStrongRowCount: 3,
          }),
          expect.objectContaining({
            code: 'connected-sparse-rows',
            sparseRowCount: 1,
            lineIds: ['header-right', 'header-wide'],
          }),
        ]),
      },
    })
    expect(result.scope?.sourceRegionIds).not.toContain(adjacentProse.id)
  })

  it('selects an exact tabular line band from a partial parent and retains its prose lines', () => {
    const prose = [proseLine('prose-1', 0.27), proseLine('prose-2', 0.31)]
    const tableLines = [
      line('table-header', 0.52, [0.12, 0.4, 0.67]),
      line('table-row-1', 0.56, [0.12, 0.4, 0.67]),
      line('table-row-2', 0.6, [0.12, 0.4, 0.67]),
      line('table-row-3', 0.64, [0.12, 0.4, 0.67]),
    ]
    const parent = textRegion('mixed-parent', box(0.12, 0.25, 0.63, 0.406), [
      ...prose,
      ...tableLines,
    ])
    const tableCaption = caption('caption-partial-table', 0.68)

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [parent, tableCaption],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-tabular-line-band',
        sourceRegionIds: [parent.id],
        sourceLineIds: [
          'table-header',
          'table-row-1',
          'table-row-2',
          'table-row-3',
        ],
        sourceLineBoxes: tableLines.map((sourceLine) => sourceLine.box),
        cropBox: box(0.12, 0.52, 0.625, 0.136),
        regionLineage: [
          {
            regionId: parent.id,
            selection: 'partial',
            lineIds: [
              'table-header',
              'table-row-1',
              'table-row-2',
              'table-row-3',
            ],
            retainedLineIds: ['prose-1', 'prose-2'],
            box: parent.box,
          },
        ],
        lineLineage: tableLines.map((sourceLine) => ({
          regionId: parent.id,
          lineId: sourceLine.id,
          box: sourceLine.box,
        })),
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'multi-run-tabular-line-band',
            rowCount: 4,
            qualifyingRowCount: 4,
            requiredQualifyingRowCount: 3,
          }),
          expect.objectContaining({
            code: 'partial-parent-line-selection',
            partialRegionIds: [parent.id],
          }),
        ]),
      },
    })
    expect(result.scope?.sourceLineIds).not.toEqual(
      expect.arrayContaining(['prose-1', 'prose-2']),
    )

    const renamedLines = tableLines.map((sourceLine) => ({
      ...sourceLine,
      id: `renamed-${sourceLine.id}`,
    }))
    const renamedParent = textRegion(parent.id, parent.box, [
      ...prose,
      ...renamedLines,
    ])
    const renamed = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [renamedParent, tableCaption],
      nativeObjects: [],
    })
    expect(renamed.status).toBe('matched')
    expect(renamed.scope?.cropBox).toEqual(result.scope?.cropBox)
    expect(renamed.scope?.id).not.toBe(result.scope?.id)
  })

  it('rejects a partial parent whose adjacent band is continuous prose', () => {
    const lines = [
      proseLine('earlier-prose', 0.27),
      proseLine('candidate-prose-1', 0.52),
      proseLine('candidate-prose-2', 0.56),
      proseLine('candidate-prose-3', 0.6),
      proseLine('candidate-prose-4', 0.64),
    ]
    const parent = textRegion(
      'continuous-prose-parent',
      box(0.12, 0.25, 0.63, 0.406),
      lines,
    )
    const tableCaption = caption('caption-prose-negative', 0.68)

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [parent, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: { code: 'no-proven-scope' },
    })
  })

  it('keeps two exact partial-parent line bands ambiguous and selects neither', () => {
    const aboveLines = [
      line('above-row-1', 0.38, [0.12, 0.4, 0.67]),
      line('above-row-2', 0.42, [0.12, 0.4, 0.67]),
      line('above-row-3', 0.46, [0.12, 0.4, 0.67]),
    ]
    const belowLines = [
      line('below-row-1', 0.544, [0.12, 0.4, 0.67]),
      line('below-row-2', 0.584, [0.12, 0.4, 0.67]),
      line('below-row-3', 0.624, [0.12, 0.4, 0.67]),
    ]
    const aboveParent = textRegion(
      'above-mixed-parent',
      box(0.12, 0.12, 0.63, 0.356),
      [proseLine('above-prose', 0.14), ...aboveLines],
    )
    const belowParent = textRegion(
      'below-mixed-parent',
      box(0.12, 0.544, 0.63, 0.326),
      [...belowLines, proseLine('below-prose', 0.84)],
    )
    const tableCaption = caption('caption-ambiguous-partial-table', 0.5)

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [aboveParent, tableCaption, belowParent],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'ambiguous',
      scope: null,
      ambiguity: {
        code: 'competing-scopes',
        evidence: ['more-than-one-bounded-scope'],
      },
    })
    expect(result.candidates).toHaveLength(2)
    expect(
      result.candidates.map((candidate) => candidate.direction).sort(),
    ).toEqual(['above', 'below'])
    expect(
      result.candidates.every((candidate) =>
        candidate.regionLineage.every(
          (lineage) =>
            lineage.selection === 'partial' &&
            lineage.retainedLineIds.length === 1,
        ),
      ),
    ).toBe(true)
  })

  it('recognizes dense repeated columns without splitting ordinary word gaps', () => {
    const denseLine = (id: string, y: number): PdfRegionLine => {
      const runs = [0.12, 0.17, 0.22].map<PdfSourceRun>((x, index) => ({
        ...box(x, y, 0.04, 0.016),
        text: `${id}-${index + 1}`,
        fontName: 'DenseTable',
        fontSize: 7,
        confidence: 0.99,
      }))
      return {
        id,
        text: runs.map((run) => run.text).join(' '),
        fontSize: 7,
        box: box(0.12, y, 0.14, 0.016),
        runs,
      }
    }
    const table = textRegion('dense-table', box(0.12, 0.2, 0.14, 0.116), [
      denseLine('header', 0.2),
      denseLine('row-1', 0.25),
      denseLine('row-2', 0.3),
    ])

    expect(
      resolvePdfTableScope({
        caption: caption(),
        pageRegions: [table, caption()],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-grid',
        sourceRegionIds: [table.id],
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'repeated-column-anchors',
            anchors: [0.12, 0.17, 0.22],
          }),
        ]),
      },
    })
  })

  it('keeps multiword runs inside three repeated cells', () => {
    const multiwordLine = (id: string, y: number): PdfRegionLine => {
      const runs = [0.12, 0.164, 0.4, 0.444, 0.67, 0.714].map<PdfSourceRun>(
        (x, index) => ({
          ...box(x, y, 0.04, 0.016),
          text: `${id}-word-${index + 1}`,
          fontName: 'MultiwordTable',
          fontSize: 8,
          confidence: 0.99,
        }),
      )
      return {
        id,
        text: runs.map((run) => run.text).join(' '),
        fontSize: 8,
        box: box(0.12, y, 0.634, 0.016),
        runs,
      }
    }
    const table = textRegion('multiword-table', box(0.12, 0.2, 0.634, 0.116), [
      multiwordLine('header', 0.2),
      multiwordLine('row-1', 0.25),
      multiwordLine('row-2', 0.3),
    ])

    expect(
      resolvePdfTableScope({
        caption: caption(),
        pageRegions: [table, caption()],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-grid',
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'repeated-column-anchors',
            columnCount: 3,
            anchors: [0.12, 0.4, 0.67],
          }),
        ]),
      },
    })
  })

  it('merges paired split-table regions but excludes aligned same-font prose', () => {
    const leftTable = textRegion('left-table', box(0.1, 0.2, 0.22, 0.116), [
      line('left-header', 0.2, [0.1, 0.24]),
      line('left-row-1', 0.25, [0.1, 0.24]),
      line('left-row-2', 0.3, [0.1, 0.24]),
    ])
    const rightTable = textRegion('right-table', box(0.34, 0.2, 0.22, 0.116), [
      line('right-header', 0.2, [0.34, 0.48]),
      line('right-row-1', 0.25, [0.34, 0.48]),
      line('right-row-2', 0.3, [0.34, 0.48]),
    ])
    const split = resolvePdfTableScope({
      caption: caption(),
      pageRegions: [leftTable, rightTable, caption()],
      nativeObjects: [],
    })

    expect(split).toMatchObject({
      status: 'matched',
      scope: {
        sourceRegionIds: ['left-table', 'right-table'],
        cropBox: box(0.1, 0.2, 0.46, 0.116),
      },
    })

    const proseLines = Array.from({ length: 3 }, (_, index) => {
      const y = 0.2 + index * 0.05
      const runs = [0.34, 0.422, 0.504].map<PdfSourceRun>((x, runIndex) => ({
        ...box(x, y, 0.078, 0.016),
        text: `prose-${index}-${runIndex}`,
        fontName: 'TableSerif',
        fontSize: 8,
        confidence: 0.99,
      }))
      return {
        id: `prose-line-${index}`,
        text: runs.map((run) => run.text).join(' '),
        fontSize: 8,
        box: box(0.34, y, 0.242, 0.016),
        runs,
      }
    })
    const alignedProse = textRegion(
      'aligned-right-prose',
      box(0.34, 0.2, 0.242, 0.116),
      proseLines,
    )
    const scoped = resolvePdfTableScope({
      caption: caption(),
      pageRegions: [leftTable, alignedProse, caption()],
      nativeObjects: [],
    })

    expect(scoped).toMatchObject({
      status: 'matched',
      scope: {
        sourceRegionIds: ['left-table'],
        cropBox: leftTable.box,
      },
    })
    expect(scoped.scope?.sourceRegionIds).not.toContain(alignedProse.id)
  })

  it('rejects caption-adjacent continuous prose instead of inventing a table crop', () => {
    const proseLines = Array.from({ length: 5 }, (_, index) => {
      const y = 0.2 + index * 0.03
      const runs = [0.12, 0.202, 0.284, 0.366].map<PdfSourceRun>(
        (x, runIndex) => ({
          ...box(x, y, 0.078, 0.016),
          text: `word-${index}-${runIndex}`,
          fontName: 'BodySerif',
          fontSize: 10,
          confidence: 0.99,
        }),
      )
      return {
        id: `prose-${index}`,
        text: runs.map((run) => run.text).join(' '),
        fontSize: 10,
        box: box(0.12, y, 0.324, 0.016),
        runs,
      }
    })
    const prose = textRegion(
      'continuous-prose',
      box(0.12, 0.2, 0.324, 0.136),
      proseLines,
    )

    expect(
      resolvePdfTableScope({
        caption: caption(),
        pageRegions: [prose, caption()],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: { code: 'no-proven-scope', candidateIds: [] },
    })
  })

  it('rejects repeated geometry whose line lineage leaves its source page', () => {
    const lines = [
      line('header', 0.2, [0.12, 0.4, 0.67]),
      line('row-1', 0.25, [0.12, 0.4, 0.67]),
      line('row-2', 0.3, [0.12, 0.4, 0.67]),
    ].map((sourceLine) => ({
      ...sourceLine,
      box: { ...sourceLine.box, page: 2 },
      runs: sourceLine.runs.map((run) => ({ ...run, page: 2 })),
    }))
    const table = textRegion(
      'cross-page-grid',
      box(0.12, 0.2, 0.63, 0.116),
      lines,
    )

    expect(
      resolvePdfTableScope({
        caption: caption(),
        pageRegions: [table, caption()],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      ambiguity: { code: 'no-proven-scope' },
    })
  })

  it('returns an exact source-native raster scope without claiming a semantic grid', () => {
    const rasterBox = box(0.16, 0.18, 0.61, 0.15, 'pdf-object')
    const raster = nativeObject('image-p001-001', 'image', rasterBox)
    const rasterRegion = objectRegion(
      'page-001-object-region-001',
      raster.id,
      rasterBox,
    )

    const result = resolvePdfTableScope({
      caption: caption(),
      pageRegions: [rasterRegion, caption()],
      nativeObjects: [raster],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'native-raster',
        sourceRegionIds: [rasterRegion.id],
        sourceObjectIds: [raster.id],
        cropBox: rasterBox,
        objectLineage: [
          {
            objectId: raster.id,
            assetId: raster.assetId,
            kind: 'image',
            box: rasterBox,
          },
        ],
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'source-native-raster',
            objectIds: [raster.id],
          }),
        ]),
      },
    })
  })

  it('proves a ruled scope only from repeated horizontal and vertical native rules', () => {
    const horizontal = [0.2, 0.28, 0.36].map((y, index) =>
      nativeObject(
        `vector-horizontal-${index + 1}`,
        'vector',
        box(0.15, y, 0.6, 0.002, 'pdf-object'),
      ),
    )
    const vertical = [0.15, 0.45, 0.75].map((x, index) =>
      nativeObject(
        `vector-vertical-${index + 1}`,
        'vector',
        box(x, 0.2, 0.002, 0.162, 'pdf-object'),
      ),
    )
    const objects = [...horizontal, ...vertical]
    const objectRegions = objects.map((object, index) =>
      objectRegion(`rule-region-${index + 1}`, object.id, object.box),
    )

    const result = resolvePdfTableScope({
      caption: caption('caption-table-2', 0.43),
      pageRegions: [...objectRegions, caption('caption-table-2', 0.43)],
      nativeObjects: objects,
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'native-ruled',
        sourceRegionIds: objectRegions.map((region) => region.id).sort(),
        sourceObjectIds: objects.map((object) => object.id).sort(),
        cropBox: box(0.15, 0.2, 0.602, 0.162, 'pdf-object'),
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'source-native-ruled-geometry',
            horizontalRuleObjectIds: horizontal
              .map((object) => object.id)
              .sort(),
            verticalRuleObjectIds: vertical.map((object) => object.id).sort(),
          }),
        ]),
      },
    })
  })

  it('does not cross an intervening caption to reach an otherwise valid raster', () => {
    const rasterBox = box(0.16, 0.16, 0.61, 0.14, 'pdf-object')
    const raster = nativeObject('image-p001-001', 'image', rasterBox)
    const rasterRegion = objectRegion('raster-region', raster.id, rasterBox)
    const interveningCaption = caption(
      'caption-table-2',
      0.32,
      'Table 2. A different table.',
    )
    const currentCaption = caption('caption-table-3', 0.48)

    expect(
      resolvePdfTableScope({
        caption: currentCaption,
        pageRegions: [rasterRegion, interveningCaption, currentCaption],
        nativeObjects: [raster],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      ambiguity: {
        code: 'no-proven-scope',
        evidence: expect.arrayContaining(['intervening-caption-boundary']),
      },
    })
  })

  it('fails closed when two bounded native rasters compete for one caption', () => {
    const firstBox = box(0.16, 0.15, 0.61, 0.08, 'pdf-object')
    const secondBox = box(0.16, 0.27, 0.61, 0.07, 'pdf-object')
    const first = nativeObject('image-p001-001', 'image', firstBox)
    const second = nativeObject('image-p001-002', 'image', secondBox)
    const regions = [
      objectRegion('raster-region-1', first.id, firstBox),
      objectRegion('raster-region-2', second.id, secondBox),
    ]

    const result = resolvePdfTableScope({
      caption: caption(),
      pageRegions: [...regions, caption()],
      nativeObjects: [second, first],
    })

    expect(result).toMatchObject({
      status: 'ambiguous',
      scope: null,
      ambiguity: {
        code: 'competing-scopes',
        candidateIds: result.candidates.map((candidate) => candidate.id),
      },
    })
    expect(result.candidates).toHaveLength(2)
  })

  it('fails closed when duplicate regions claim the same native object lineage', () => {
    const rasterBox = box(0.16, 0.18, 0.61, 0.15, 'pdf-object')
    const raster = nativeObject('image-p001-001', 'image', rasterBox)
    const duplicateRegions = [
      objectRegion('raster-region-a', raster.id, rasterBox),
      objectRegion('raster-region-b', raster.id, rasterBox),
    ]

    const result = resolvePdfTableScope({
      caption: caption(),
      pageRegions: [...duplicateRegions, caption()],
      nativeObjects: [raster],
    })

    expect(result).toMatchObject({
      status: 'ambiguous',
      scope: null,
      ambiguity: {
        code: 'duplicate-source-lineage',
        evidence: expect.arrayContaining([raster.id]),
      },
    })
  })

  it('keeps source scope identity stable across two captions for the same lineage', () => {
    const rasterBox = box(0.16, 0.18, 0.61, 0.15, 'pdf-object')
    const raster = nativeObject('image-p001-001', 'image', rasterBox)
    const rasterRegion = objectRegion('raster-region', raster.id, rasterBox)
    const firstCaption = caption('caption-table-a')
    const secondCaption = caption('caption-table-b', 0.1)

    const first = resolvePdfTableScope({
      caption: firstCaption,
      pageRegions: [rasterRegion, firstCaption],
      nativeObjects: [raster],
    })
    const second = resolvePdfTableScope({
      caption: secondCaption,
      pageRegions: [rasterRegion, secondCaption],
      nativeObjects: [raster],
    })

    expect(first.status).toBe('matched')
    expect(second.status).toBe('matched')
    expect(first.scope?.direction).toBe('above')
    expect(second.scope?.direction).toBe('below')
    expect(second.scope?.id).toBe(first.scope?.id)
  })

  it('is byte-for-byte deterministic across source input order', () => {
    const rasterBox = box(0.16, 0.18, 0.61, 0.15, 'pdf-object')
    const raster = nativeObject('image-p001-001', 'image', rasterBox)
    const rasterRegion = objectRegion('raster-region', raster.id, rasterBox)
    const unrelated = textRegion('unrelated', box(0.1, 0.7, 0.7, 0.05), [
      line('unrelated-line', 0.7, [0.1]),
    ])
    const tableCaption = caption()
    const forward = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [rasterRegion, unrelated, tableCaption],
      nativeObjects: [raster],
    })
    const reverse = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, unrelated, rasterRegion],
      nativeObjects: [raster].reverse(),
    })

    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward))
  })
})
