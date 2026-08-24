import { describe, expect, it } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfNativeObject,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfRegionColumn,
  PdfRegionLine,
  PdfSourceRun,
} from './import-types'
import { reconstructPageRegions } from './pdf-regions'
import {
  compactTabularSlabMayFollowCaption,
  resolvePdfTableScope,
} from './pdf-table-scope'

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

function equationCellLine(id: string, y: number, x = 0.32) {
  const sourceBox = box(x, y, 0.22, 0.016)
  return {
    id,
    text: 'Prompt cell with inline symbols',
    fontSize: 8,
    box: sourceBox,
    runs: [
      {
        ...sourceBox,
        text: 'Prompt cell with inline symbols',
        fontName: 'TableSerif',
        fontSize: 8,
        confidence: 0.99,
      },
    ],
  } satisfies PdfRegionLine
}

function supplementalEquationTableFixture({
  equationYs = [0.25, 0.28],
  equationX = 0.32,
  finalHasMiddleAnchor = true,
  competingSupplement = false,
  includeNeighbors = false,
}: {
  equationYs?: number[]
  equationX?: number
  finalHasMiddleAnchor?: boolean
  competingSupplement?: boolean
  includeNeighbors?: boolean
} = {}) {
  const ys = [0.22, 0.25, 0.28, 0.31]
  const leftLines = [
    line('table-header-left-middle', ys[0], [0.2, 0.32]),
    line('table-row-1-left', ys[1], [0.2]),
    line('table-row-2-left', ys[2], [0.2]),
  ]
  const rightLines = ys
    .slice(0, 3)
    .map((y, index) => line(`table-row-${index}-right`, y, [0.7]))
  const left = textRegion(
    'table-left-shard',
    box(0.2, ys[0], 0.195, ys[2] + 0.016 - ys[0]),
    leftLines,
  )
  const right = textRegion(
    'table-right-shard',
    box(0.7, ys[0], 0.075, ys[2] + 0.016 - ys[0]),
    rightLines,
  )
  const equationLines = equationYs.map((y, index) =>
    equationCellLine(`table-equation-cell-${index + 1}`, y, equationX),
  )
  const equation = textRegion(
    'table-equation-shard',
    box(
      equationX,
      Math.min(...equationYs),
      0.22,
      Math.max(...equationYs) + 0.016 - Math.min(...equationYs),
    ),
    equationLines,
    'equation',
  )
  const final = textRegion(
    'table-final-row',
    box(0.2, ys[3], 0.575, 0.016),
    [
      line(
        'table-final-row-line',
        ys[3],
        finalHasMiddleAnchor ? [0.2, 0.32, 0.7] : [0.2, 0.7],
      ),
    ],
    'spanning',
  )
  const tableCaption = {
    ...caption(
      'caption-table-2',
      0.18,
      'Table 2. Caption-bounded benchmark results.',
    ),
    box: box(0.18, 0.18, 0.6, 0.02),
  }
  const precedingCaption = {
    ...caption('caption-figure-11', 0.12, 'Figure 11. Previous visual.'),
    box: box(0.15, 0.12, 0.65, 0.02),
  }
  const followingCaption = {
    ...caption('caption-figure-13', 0.4, 'Figure 13. Following visual.'),
    box: box(0.5, 0.4, 0.35, 0.02),
  }
  const competing = competingSupplement
    ? textRegion(
        'competing-equation-shard',
        box(
          0.328,
          Math.min(...equationYs),
          0.22,
          Math.max(...equationYs) + 0.016 - Math.min(...equationYs),
        ),
        equationYs.map((y, index) =>
          equationCellLine(`competing-equation-cell-${index + 1}`, y, 0.328),
        ),
        'equation',
      )
    : null
  const neighboringDiagram = includeNeighbors
    ? textRegion(
        'neighboring-diagram-labels',
        box(0.05, ys[0], 0.075, ys[2] + 0.016 - ys[0]),
        ys
          .slice(0, 3)
          .map((y, index) => line(`diagram-label-${index + 1}`, y, [0.05])),
        'chart-label',
      )
    : null
  const neighboringProse = includeNeighbors
    ? textRegion(
        'neighboring-prose',
        box(0.82, ys[0], 0.12, ys[2] + 0.016 - ys[0]),
        ys
          .slice(0, 3)
          .map((y, index) => line(`neighboring-prose-${index + 1}`, y, [0.82])),
      )
    : null
  return {
    caption: tableCaption,
    expectedRegions: [left, right, equation, final],
    regions: [
      precedingCaption,
      left,
      right,
      equation,
      final,
      ...(competing ? [competing] : []),
      ...(neighboringDiagram ? [neighboringDiagram] : []),
      ...(neighboringProse ? [neighboringProse] : []),
      tableCaption,
      followingCaption,
    ],
  }
}

describe('bounded PDF table source scoping', () => {
  it('stops a dense table band before a materially larger gap into ordinary prose', () => {
    const tableLines = Array.from({ length: 6 }, (_, index) =>
      line(
        index === 0 ? 'dense-header' : `dense-row-${index}`,
        0.32603 + index * 0.0156,
        [0.21, 0.34, 0.49, 0.7],
      ),
    )
    tableLines.forEach((sourceLine) => {
      sourceLine.box.height = 0.01258
      sourceLine.runs.forEach((run) => {
        run.height = 0.01258
      })
    })
    tableLines[0].runs.forEach((run) => {
      run.bold = true
      run.fontName = 'TableSerif-Medium'
    })
    const tableFragment = (
      id: string,
      selections: Array<{ row: number; columns: number[] }>,
    ) => {
      const fragmentLines = selections.map(({ row, columns }) => {
        const runs = columns.map((column) => tableLines[row].runs[column])
        const left = Math.min(...runs.map((run) => run.x))
        const right = Math.max(...runs.map((run) => run.x + run.width))
        return {
          ...tableLines[row],
          id: `${id}-row-${row + 1}`,
          text: runs.map((run) => run.text).join(' '),
          box: box(
            left,
            tableLines[row].box.y,
            right - left,
            tableLines[row].box.height,
          ),
          runs,
        }
      })
      const left = Math.min(
        ...fragmentLines.map((sourceLine) => sourceLine.box.x),
      )
      const top = Math.min(
        ...fragmentLines.map((sourceLine) => sourceLine.box.y),
      )
      const right = Math.max(
        ...fragmentLines.map(
          (sourceLine) => sourceLine.box.x + sourceLine.box.width,
        ),
      )
      const bottom = Math.max(
        ...fragmentLines.map(
          (sourceLine) => sourceLine.box.y + sourceLine.box.height,
        ),
      )
      return textRegion(
        id,
        box(left, top, right - left, bottom - top),
        fragmentLines,
      )
    }
    const tableFragments = [
      tableFragment('fragmented-header-one', [{ row: 0, columns: [0] }]),
      tableFragment('fragmented-header-two', [{ row: 0, columns: [1] }]),
      tableFragment('fragmented-header-three', [{ row: 0, columns: [2] }]),
      tableFragment(
        'fragmented-accuracy-column',
        [0, 1, 2, 3].map((row) => ({ row, columns: [3] })),
      ),
      tableFragment('fragmented-first-task', [{ row: 1, columns: [0] }]),
      tableFragment('fragmented-middle-prompt-column', [
        { row: 1, columns: [1, 2] },
        { row: 2, columns: [2] },
        { row: 3, columns: [2] },
        { row: 4, columns: [2, 3] },
        { row: 5, columns: [2] },
      ]),
      tableFragment('fragmented-left-pair-one', [
        { row: 2, columns: [0, 1] },
        { row: 3, columns: [0] },
      ]),
      tableFragment('fragmented-left-pair-two', [
        { row: 3, columns: [1] },
        { row: 4, columns: [0, 1] },
      ]),
      tableFragment('fragmented-final-left-pair', [
        { row: 5, columns: [0, 1] },
      ]),
      tableFragment('fragmented-final-accuracy', [{ row: 5, columns: [3] }]),
    ]
    const proseLines = Array.from({ length: 6 }, (_, index) => {
      const sourceBox = box(0.53, 0.44679 + index * 0.0151, 0.34, 0.01258)
      return {
        id: `following-prose-line-${index + 1}`,
        text: `Ordinary prose continues after the table on line ${index + 1}.`,
        fontSize: 10,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Ordinary prose continues after the table on line ${index + 1}.`,
            fontName: 'BodySerif',
            fontSize: 10,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    })
    const prose = textRegion(
      'ordinary-prose-after-dense-table',
      box(0.53, 0.44679, 0.34, 0.08808),
      proseLines,
    )
    const tableCaption = {
      ...caption(
        'caption-before-dense-table',
        0.296,
        'Table 3. Exact benchmark accuracy.',
      ),
      box: box(0.21, 0.296, 0.565, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [tableCaption, ...tableFragments, prose],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-tabular-line-band',
        sourceRegionIds: tableFragments.map((region) => region.id).sort(),
      },
    })
  })

  it('keeps intentionally loose table rows when their vertical gaps remain consistent', () => {
    const tableLines = Array.from({ length: 5 }, (_, index) =>
      line(
        index === 0 ? 'loose-header' : `loose-row-${index}`,
        0.24 + index * 0.03,
        [0.16, 0.35, 0.56],
      ),
    )
    tableLines[0].runs.forEach((run) => {
      run.bold = true
      run.fontName = 'TableSerif-Medium'
    })
    const table = textRegion(
      'consistent-loose-table',
      box(0.16, 0.24, 0.475, 0.136),
      tableLines,
    )
    const tableCaption = caption(
      'caption-after-loose-table',
      0.4,
      'Table 4. Intentionally loose rows.',
    )

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [table, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        sourceLineIds: tableLines.map((sourceLine) => sourceLine.id),
      },
    })
  })

  it('rejects a numbered prose sequence that competes with the actual table', () => {
    const tableLines = [
      line('header', 0.26, [0.14, 0.3, 0.46]),
      line('row-1', 0.284, [0.14, 0.3, 0.46]),
      line('row-2', 0.308, [0.14, 0.3, 0.46]),
      line('row-3', 0.332, [0.14, 0.3, 0.46]),
    ]
    const table = textRegion(
      'actual-table',
      box(0.14, 0.26, 0.395, 0.088),
      tableLines,
    )
    const listRegions = [1, 2, 3].map((ordinal, index) => {
      const y = 0.42 + index * 0.024
      const runs = [
        {
          ...box(0.52, y, 0.035, 0.016),
          text: `${ordinal}.`,
          fontName: 'BodySerif',
          fontSize: 10,
          confidence: 0.99,
        },
        {
          ...box(0.6, y, 0.24, 0.016),
          text: `Prose item ${ordinal}.`,
          fontName: 'BodySerif',
          fontSize: 10,
          confidence: 0.99,
        },
      ]
      const sourceLine = {
        id: `list-line-${ordinal}`,
        text: `${ordinal}. Prose item ${ordinal}.`,
        fontSize: 10,
        box: box(0.52, y, 0.32, 0.016),
        runs,
      }
      return textRegion(`list-region-${ordinal}`, sourceLine.box, [sourceLine])
    })
    const tableCaption = caption('caption-between-table-and-list', 0.38)

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [table, tableCaption, ...listRegions],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      candidates: [
        {
          sourceRegionIds: [table.id],
        },
      ],
      scope: {
        sourceRegionIds: [table.id],
      },
    })
  })

  it('returns one exact crop scope for a wide contiguous single-anchor slab above its caption', () => {
    const slabLines = Array.from({ length: 8 }, (_, index) => {
      const y = 0.18 + index * 0.024
      const sourceBox = box(0.12, y, 0.68 - index * 0.02, 0.016)
      return {
        id: `slab-line-${index + 1}`,
        text: `Field ${index + 1}: structured table value`,
        fontSize: 9,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Field ${index + 1}: structured table value`,
            fontName: 'PromptSerif-Bold',
            fontSize: 9,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
    })
    const slab = textRegion(
      'wide-single-anchor-slab',
      box(0.12, 0.18, 0.68, 0.184),
      slabLines,
    )
    const precedingProseLine = proseLine('preceding-prose-line', 0.143)
    const precedingProse = textRegion(
      'preceding-prose',
      box(0.12, 0.143, 0.324, 0.016),
      [precedingProseLine],
    )
    const tableCaption = caption(
      'caption-table-prompt',
      0.38,
      'Table 4. Source-authored prompt template.',
    )

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [precedingProse, slab, tableCaption],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        direction: 'above',
        sourceRegionIds: [slab.id],
        sourceLineIds: slabLines.map((item) => item.id),
        cropBox: box(0.12, 0.18, 0.68, 0.184),
        regionLineage: [
          {
            regionId: slab.id,
            selection: 'whole',
            lineIds: slabLines.map((item) => item.id),
          },
        ],
        evidence: expect.arrayContaining([
          expect.objectContaining({ code: 'caption-bounded-scope' }),
          expect.objectContaining({
            code: 'contiguous-single-anchor-slab',
            rowCount: 8,
            wideLayout: true,
          }),
        ]),
      },
    })
  })

  it('rejects a full-width slab that crosses a disjoint sibling table caption lane', () => {
    const slabLines = Array.from({ length: 8 }, (_, index) => {
      const y = 0.12 + index * 0.024
      const sourceBox = box(0.12, y, 0.76, 0.016)
      return {
        id: `composite-slab-line-${index + 1}`,
        text: `Field ${index + 1}: value from two adjacent source tables`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Field ${index + 1}: value from two adjacent source tables`,
            fontName: 'TableSerif-Bold',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
    })
    const compositeSlab = textRegion(
      'composite-two-table-slab',
      box(0.12, 0.12, 0.76, 0.184),
      slabLines,
    )
    const leftCaption = {
      ...caption('left-table-caption', 0.324, 'Table 2. Left source table.'),
      column: 'left' as const,
      box: box(0.12, 0.324, 0.35, 0.02),
    }
    const rightCaption = {
      ...caption('right-table-caption', 0.44, 'Table 3. Right source table.'),
      column: 'right' as const,
      box: box(0.53, 0.44, 0.35, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: leftCaption,
        pageRegions: [compositeSlab, leftCaption, rightCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: {
        code: 'no-proven-scope',
        evidence: expect.arrayContaining([
          'table-scope-crosses-sibling-caption-lane',
          rightCaption.id,
        ]),
      },
    })
  })

  it('keeps two local table lanes disjoint inside one global page column', () => {
    const laneLine = (
      id: string,
      y: number,
      anchors: number[],
    ): PdfRegionLine => {
      const runs = anchors.map<PdfSourceRun>((x, index) => ({
        ...box(x, y, 0.035, 0.016),
        text: `${id}-${index + 1}`,
        fontName: 'TableSerif',
        fontSize: 8,
        confidence: 0.99,
      }))
      return {
        id,
        text: runs.map((sourceRun) => sourceRun.text).join(' '),
        fontSize: 8,
        box: box(anchors[0], y, anchors.at(-1)! + 0.035 - anchors[0], 0.016),
        runs,
      }
    }
    const localTable = (id: string, anchors: number[]): PdfPageRegion => {
      const lines = [0.2, 0.23, 0.26].map((y, index) =>
        laneLine(`${id}-row-${index + 1}`, y, anchors),
      )
      return {
        ...textRegion(
          id,
          box(anchors[0], 0.2, anchors.at(-1)! + 0.035 - anchors[0], 0.076),
          lines,
        ),
        column: 'right',
      }
    }
    const leftTable = localTable('local-left-table', [0.53, 0.59, 0.65])
    const rightTable = localTable('local-right-table', [0.75, 0.81, 0.87])
    const leftCaption = {
      ...caption('local-left-caption', 0.3, 'Table 2. Left mini-table.'),
      column: 'right' as const,
      box: box(0.52, 0.3, 0.18, 0.02),
      sourceCaptionLane: {
        boundary: 0.72,
        side: 'left' as const,
      },
    }
    const rightCaption = {
      ...caption('local-right-caption', 0.3, 'Table 3. Right mini-table.'),
      column: 'right' as const,
      box: box(0.74, 0.3, 0.18, 0.02),
      sourceCaptionLane: {
        boundary: 0.72,
        side: 'right' as const,
      },
    }
    const pageRegions = [leftTable, rightTable, leftCaption, rightCaption]

    const leftResult = resolvePdfTableScope({
      caption: leftCaption,
      pageRegions,
      nativeObjects: [],
    })
    const rightResult = resolvePdfTableScope({
      caption: rightCaption,
      pageRegions,
      nativeObjects: [],
    })
    expect(leftResult).toMatchObject({
      status: 'matched',
      scope: {
        sourceRegionIds: [leftTable.id],
        sourceLineIds: leftTable.lines.map((sourceLine) => sourceLine.id),
        cropBox: expect.objectContaining({
          x: expect.closeTo(0.53, 4),
          width: expect.closeTo(0.155, 4),
        }),
      },
    })
    expect(rightResult).toMatchObject({
      status: 'matched',
      scope: {
        sourceRegionIds: [rightTable.id],
        sourceLineIds: rightTable.lines.map((sourceLine) => sourceLine.id),
        cropBox: expect.objectContaining({
          x: expect.closeTo(0.75, 4),
          width: expect.closeTo(0.155, 4),
        }),
      },
    })
    expect(
      leftResult.scope?.sourceLineIds.some((lineId) =>
        rightResult.scope?.sourceLineIds.includes(lineId),
      ),
    ).toBe(false)
  })

  it('rejects an unheaded page-top prose slab because its multi-page start boundary is unproven', () => {
    const pageTwoBox = (
      x: number,
      y: number,
      width: number,
      height: number,
    ): NormalizedSourceBox => ({
      ...box(x, y, width, height),
      page: 2,
    })
    const tailLines = Array.from({ length: 8 }, (_, index) => {
      const sourceBox = pageTwoBox(
        0.15677,
        0.08654 + index * 0.024,
        0.69,
        0.016,
      )
      return {
        id: `continued-story-line-${index + 1}`,
        text:
          index === 0
            ? '"That is fine," she said, continuing the story.'
            : `The unheaded story continuation remains on line ${index + 1}.`,
        fontSize: 9,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text:
              index === 0
                ? '"That is fine," she said, continuing the story.'
                : `The unheaded story continuation remains on line ${index + 1}.`,
            fontName: 'Mono-Regular',
            fontSize: 9,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    })
    const currentPageTail = {
      ...textRegion(
        'current-page-tail',
        pageTwoBox(0.15677, 0.08654, 0.69, 0.184),
        tailLines,
      ),
      page: 2,
    }
    const precedingPageTailBox = box(0.15677, 0.78, 0.69, 0.12)
    const precedingPageTail = textRegion(
      'preceding-page-tail',
      precedingPageTailBox,
      [
        {
          id: 'preceding-page-tail-line',
          text: 'The same source story continues across the page boundary,',
          fontSize: 9,
          box: precedingPageTailBox,
          runs: [
            {
              ...precedingPageTailBox,
              text: 'The same source story continues across the page boundary,',
              fontName: 'Mono-Regular',
              fontSize: 9,
              confidence: 0.99,
            },
          ],
        },
      ],
    )
    const pageTwoBodyBox = pageTwoBox(0.12, 0.5, 0.32, 0.016)
    const ordinaryPageBody = {
      ...textRegion('page-two-body', pageTwoBodyBox, [
        {
          id: 'page-two-body-line',
          text: 'Ordinary body copy establishes the larger page type size.',
          fontSize: 11,
          box: pageTwoBodyBox,
          runs: [
            {
              ...pageTwoBodyBox,
              text: 'Ordinary body copy establishes the larger page type size.',
              fontName: 'BodySerif',
              fontSize: 11,
              confidence: 0.99,
            },
          ],
        },
      ]),
      page: 2,
    }
    const terminalCaption = {
      ...caption(
        'terminal-table-caption',
        0.292,
        'Table 22. Complete source story.',
      ),
      page: 2,
      box: pageTwoBox(0.12, 0.292, 0.76, 0.03),
    }

    expect(
      resolvePdfTableScope({
        caption: terminalCaption,
        pageRegions: [
          precedingPageTail,
          currentPageTail,
          terminalCaption,
          ordinaryPageBody,
        ],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: {
        code: 'no-proven-scope',
        evidence: expect.arrayContaining([
          'table-source-start-boundary-unproven',
        ]),
      },
    })
  })

  it('retains a page-top slab when its first source line proves a table heading', () => {
    const slabLines = Array.from({ length: 8 }, (_, index) => {
      const y = 0.08654 + index * 0.024
      const sourceBox = box(0.13, y, 0.74, 0.016)
      const heading = index === 0
      return {
        id: `headed-page-top-line-${index + 1}`,
        text: heading
          ? 'Prompt for Later Story Generation Step'
          : `Structured source value ${index + 1}`,
        fontSize: 9,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: heading
              ? 'Prompt for Later Story Generation Step'
              : `Structured source value ${index + 1}`,
            fontName: heading ? 'TableSerif-Medium' : 'TableMono-Regular',
            fontSize: 9,
            confidence: 0.99,
            bold: heading,
          },
        ],
      } satisfies PdfRegionLine
    })
    const slab = textRegion(
      'headed-page-top-slab',
      box(0.13, 0.08654, 0.74, 0.184),
      slabLines,
    )
    const tableCaption = {
      ...caption(
        'headed-page-top-caption',
        0.292,
        'Table 47. Complete source prompt.',
      ),
      box: box(0.12, 0.292, 0.76, 0.03),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [slab, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        sourceRegionIds: [slab.id],
      },
    })
  })

  it('extends a distant caption lane over one complete numeric table with multi-tier headers', () => {
    const headerLines = [
      line('group-header', 0.06, [0.25, 0.34, 0.43, 0.52]),
      line('column-header', 0.082, [0.1, 0.25, 0.43, 0.61, 0.79]),
      line('metric-header', 0.104, [0.25, 0.34, 0.43, 0.52, 0.61]),
    ]
    headerLines.forEach((sourceLine) =>
      sourceLine.runs.forEach((run) => {
        run.bold = true
        run.fontName = 'TableSerif-Bold'
      }),
    )
    const headers = textRegion(
      'multi-tier-headers',
      box(0.1, 0.06, 0.765, 0.06),
      headerLines,
      'header',
    )
    const sectionLine = line('table-section', 0.126, [0.1])
    sectionLine.runs[0].bold = true
    sectionLine.runs[0].fontName = 'TableSerif-Bold'
    const section = textRegion('table-section-row', sectionLine.box, [
      sectionLine,
    ])
    const ys = Array.from({ length: 10 }, (_, index) => 0.15 + index * 0.026)
    const stubLines = ys.map((y, rowIndex) => {
      const sourceLine = line(`model-${rowIndex + 1}`, y, [0.1])
      sourceLine.runs[0].text = `Model ${rowIndex + 1}`
      sourceLine.text = sourceLine.runs[0].text
      return sourceLine
    })
    const metricLines = ys.map((y, rowIndex) => {
      const sourceLine = line(
        `metrics-${rowIndex + 1}`,
        y,
        [0.25, 0.34, 0.43, 0.52, 0.61, 0.7, 0.79],
      )
      sourceLine.runs.forEach((run, columnIndex) => {
        run.text = `${rowIndex + 1}.${columnIndex + 1} ± 0.1`
      })
      sourceLine.text = sourceLine.runs.map((run) => run.text).join(' ')
      return sourceLine
    })
    const stubs = textRegion(
      'table-stubs',
      box(0.1, ys[0], 0.075, ys.at(-1)! + 0.016 - ys[0]),
      stubLines,
    )
    const metrics = textRegion(
      'table-metrics',
      box(0.25, ys[0], 0.615, ys.at(-1)! + 0.016 - ys[0]),
      metricLines,
      'spanning',
    )
    const tableCaption = {
      ...caption('distant-table-caption', 0.414),
      box: box(0.08, 0.414, 0.84, 0.03),
    }

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [headers, section, stubs, metrics, tableCaption],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-tabular-line-band',
        cropBox: expect.objectContaining({ y: 0.056 }),
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'multi-run-tabular-line-band',
          }),
        ]),
      },
    })
    expect(result.scope?.sourceLineIds).toHaveLength(
      headerLines.length + 1 + stubLines.length + metricLines.length,
    )
    expect(result.scope?.sourceLineIds).toEqual(
      expect.arrayContaining([
        ...headerLines.map((sourceLine) => sourceLine.id),
        sectionLine.id,
        ...stubLines.map((sourceLine) => sourceLine.id),
        ...metricLines.map((sourceLine) => sourceLine.id),
      ]),
    )
  })

  it('does not extend a distant caption lane over aligned prose with a styled heading', () => {
    const heading = line('styled-prose-heading', 0.06, [0.12, 0.28, 0.44])
    heading.runs.forEach((run) => {
      run.bold = true
      run.fontName = 'BodySerif-Bold'
    })
    const prose = Array.from({ length: 11 }, (_, index) =>
      proseLine(`aligned-prose-${index + 1}`, 0.09 + index * 0.028),
    )
    const source = textRegion(
      'aligned-prose-source',
      box(0.12, 0.06, 0.324, 0.34),
      [heading, ...prose],
    )
    const tableCaption = {
      ...caption('distant-prose-caption', 0.414),
      box: box(0.08, 0.414, 0.84, 0.03),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [source, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
    })
  })

  it('does not absorb aligned neighboring prose into a distant numeric table', () => {
    const header = line('numeric-table-header', 0.06, [0.1, 0.22, 0.32, 0.42])
    header.runs.forEach((run) => {
      run.bold = true
      run.fontName = 'TableSerif-Bold'
    })
    const ys = Array.from({ length: 10 }, (_, index) => 0.1 + index * 0.03)
    const tableLines = ys.map((y, rowIndex) => {
      const sourceLine = line(
        `numeric-table-row-${rowIndex + 1}`,
        y,
        [0.1, 0.22, 0.32, 0.42],
      )
      sourceLine.runs.forEach((run, columnIndex) => {
        run.text =
          columnIndex === 0
            ? `Model ${rowIndex + 1}`
            : `${rowIndex + 1}.${columnIndex}`
      })
      sourceLine.text = sourceLine.runs.map((run) => run.text).join(' ')
      return sourceLine
    })
    const proseLines = ys.map((y, rowIndex) => {
      const sourceLine = line(`neighboring-prose-${rowIndex + 1}`, y, [0.58])
      sourceLine.runs[0] = {
        ...sourceLine.runs[0],
        width: 0.3,
        text: `Unrelated prose sentence ${rowIndex + 1} remains body text.`,
        fontName: 'BodySerif',
      }
      sourceLine.text = sourceLine.runs[0].text
      sourceLine.box = box(0.58, y, 0.3, 0.016)
      return sourceLine
    })
    const headers = textRegion(
      'numeric-table-headers',
      header.box,
      [header],
      'header',
    )
    const table = textRegion(
      'numeric-table-body',
      box(0.1, ys[0], 0.395, ys.at(-1)! + 0.016 - ys[0]),
      tableLines,
    )
    const prose = textRegion(
      'neighboring-prose-column',
      box(0.58, ys[0], 0.3, ys.at(-1)! + 0.016 - ys[0]),
      proseLines,
    )
    const tableCaption = {
      ...caption('numeric-table-caption', 0.414),
      box: box(0.08, 0.414, 0.84, 0.03),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [headers, table, prose, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: {
        evidence: expect.arrayContaining([
          'table-source-start-boundary-unproven',
        ]),
      },
    })
  })

  it('does not treat aligned left-side prose as a numeric table row stub', () => {
    const header = line('right-numeric-table-header', 0.06, [0.4, 0.5, 0.6])
    header.runs.forEach((run) => {
      run.bold = true
      run.fontName = 'TableSerif-Bold'
    })
    const ys = Array.from({ length: 10 }, (_, index) => 0.1 + index * 0.03)
    const tableLines = ys.map((y, rowIndex) => {
      const sourceLine = line(
        `right-numeric-table-row-${rowIndex + 1}`,
        y,
        [0.4, 0.5, 0.6],
      )
      sourceLine.runs.forEach((run, columnIndex) => {
        run.text = `${rowIndex + 1}.${columnIndex + 1}`
      })
      sourceLine.text = sourceLine.runs.map((run) => run.text).join(' ')
      return sourceLine
    })
    const proseLines = ys.map((y, rowIndex) => {
      const sourceLine = line(
        `left-neighboring-prose-${rowIndex + 1}`,
        y,
        [0.05],
      )
      sourceLine.runs[0] = {
        ...sourceLine.runs[0],
        width: 0.3,
        text: `Unrelated prose sentence ${rowIndex + 1} remains body text.`,
        fontName: 'BodySerif',
      }
      sourceLine.text = sourceLine.runs[0].text
      sourceLine.box = box(0.05, y, 0.3, 0.016)
      return sourceLine
    })
    const headers = textRegion(
      'right-numeric-table-headers',
      header.box,
      [header],
      'header',
    )
    const table = textRegion(
      'right-numeric-table-body',
      box(0.4, ys[0], 0.28, ys.at(-1)! + 0.016 - ys[0]),
      tableLines,
    )
    const prose = textRegion(
      'left-neighboring-prose-column',
      box(0.05, ys[0], 0.3, ys.at(-1)! + 0.016 - ys[0]),
      proseLines,
    )
    const tableCaption = {
      ...caption('right-numeric-table-caption', 0.414),
      box: box(0.03, 0.414, 0.89, 0.03),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [headers, table, prose, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: {
        evidence: expect.arrayContaining([
          'table-source-start-boundary-unproven',
        ]),
      },
    })
  })

  it('does not extend a distant caption lane when numeric rows have two competing column signatures', () => {
    const header = line('competing-grid-header', 0.06, [0.1, 0.25, 0.4, 0.55])
    header.runs.forEach((run) => {
      run.bold = true
      run.fontName = 'TableSerif-Bold'
    })
    const rows = Array.from({ length: 10 }, (_, rowIndex) => {
      const anchors =
        rowIndex % 2 === 0 ? [0.1, 0.25, 0.4, 0.55] : [0.1, 0.31, 0.46, 0.61]
      const sourceLine = line(
        `competing-grid-row-${rowIndex + 1}`,
        0.1 + rowIndex * 0.03,
        anchors,
      )
      sourceLine.runs.forEach((run, columnIndex) => {
        run.text =
          columnIndex === 0
            ? `Model ${rowIndex + 1}`
            : `${rowIndex + 1}.${columnIndex}`
      })
      sourceLine.text = sourceLine.runs.map((run) => run.text).join(' ')
      return sourceLine
    })
    const source = textRegion(
      'competing-numeric-grids',
      box(0.1, 0.06, 0.585, 0.326),
      [header, ...rows],
    )
    const tableCaption = {
      ...caption('competing-grid-caption', 0.414),
      box: box(0.08, 0.414, 0.84, 0.03),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [source, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: {
        evidence: expect.arrayContaining([
          'table-source-start-boundary-unproven',
        ]),
      },
    })
  })

  function longCaptionBelowTableFixture({
    competingSignatures = false,
    reverseInput = false,
  }: {
    competingSignatures?: boolean
    reverseInput?: boolean
  } = {}) {
    const anchors = [0.18129, 0.36295, 0.45178, 0.58543]
    const competingAnchors = [0.18129, 0.397, 0.505, 0.647]
    const tableLine = (
      id: string,
      y: number,
      values: string[],
      rowAnchors = anchors,
    ) => {
      const runs = values.map<PdfSourceRun>((text, index) => ({
        ...box(
          rowAnchors[index],
          y,
          index === 0 ? 0.14 : index === values.length - 1 ? 0.16 : 0.065,
          0.01258,
        ),
        text,
        fontName: 'CompactTableSerif',
        fontSize: 9.9626,
        confidence: 0.99,
      }))
      return {
        id,
        text: values.join(' '),
        fontSize: 9.9626,
        box: box(
          rowAnchors[0],
          y,
          rowAnchors.at(-1)! + 0.16 - rowAnchors[0],
          0.01258,
        ),
        runs,
      } satisfies PdfRegionLine
    }
    const header = tableLine('long-below-header', 0.44882, [
      'Category',
      'Count',
      'Total measure',
      'Descriptor',
    ])
    const body = Array.from({ length: 26 }, (_, index) =>
      tableLine(
        `long-below-row-${index + 1}`,
        0.47023 + index * 0.015095,
        [
          `Record family ${index + 1}`,
          String(109 - index),
          `${560 - index}.2K`,
          `Descriptor group ${index + 1}`,
        ],
        competingSignatures && index % 2 === 1 ? competingAnchors : anchors,
      ),
    )
    const tableRegions = [header, ...body].map((sourceLine, index) => ({
      ...textRegion(
        `long-below-region-${index + 1}`,
        sourceLine.box,
        [sourceLine],
        'spanning',
      ),
      column: 'span' as const,
    }))
    const followingHeadingLine = {
      ...tableLine(
        'following-section-heading-line',
        0.88325,
        ['C.2. Following section'],
        [0.09059],
      ),
      runs: [
        {
          ...box(0.09059, 0.88325, 0.32561, 0.01258),
          text: 'C.2. Following section',
          fontName: 'CompactTableSerif-Bold',
          fontSize: 9.9626,
          confidence: 0.99,
          bold: true,
        },
      ],
      box: box(0.09059, 0.88325, 0.32561, 0.01258),
    } satisfies PdfRegionLine
    const followingHeading = textRegion(
      'following-section-heading',
      followingHeadingLine.box,
      [followingHeadingLine],
    )
    const tableCaption = {
      ...caption(
        'long-below-caption',
        0.41619,
        'Table 12. Summary of the source records.',
      ),
      column: 'span' as const,
      box: box(0.08977, 0.41619, 0.79494, 0.02641),
    }
    const pageRegions = [tableCaption, ...tableRegions, followingHeading]
    return {
      tableCaption,
      tableRegions,
      followingHeading,
      pageRegions: reverseInput ? [...pageRegions].reverse() : pageRegions,
    }
  }

  it('extends one repeated caption-below table past the ordinary distance cap and stops at the following section', () => {
    const fixture = longCaptionBelowTableFixture()

    const result = resolvePdfTableScope({
      caption: fixture.tableCaption,
      pageRegions: fixture.pageRegions,
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-tabular-line-band',
        direction: 'below',
        sourceRegionIds: fixture.tableRegions.map((region) => region.id).sort(),
      },
    })
    expect(result.scope?.sourceLineIds).toHaveLength(
      fixture.tableRegions.length,
    )
    expect(result.scope?.sourceRegionIds).not.toContain(
      fixture.followingHeading.id,
    )
    expect(result.scope?.cropBox.y).toBe(0.44882)
    expect(
      result.scope!.cropBox.y + result.scope!.cropBox.height,
    ).toBeGreaterThan(0.85)
  })

  it('extends a wrapped caption-below table when sparse continuations stay on its dominant columns', () => {
    const tableCaption = {
      ...caption(
        'wrapped-long-below-caption',
        0.19382,
        'Table 13. Composition of the source collection.',
      ),
      column: 'span' as const,
      box: box(0.08977, 0.19382, 0.79494, 0.0415),
    }
    const ys = [
      0.24156, 0.25666, 0.27176, 0.29317, 0.30826, 0.32336, 0.33845, 0.35355,
      0.36864, 0.38374, 0.39883, 0.41392, 0.42902, 0.44412, 0.45921, 0.4743,
      0.4894, 0.50449, 0.51959, 0.53468, 0.54978, 0.56487, 0.57997, 0.59506,
      0.61016, 0.62525, 0.64035, 0.65544, 0.67054, 0.68563, 0.70073, 0.71582,
      0.73092, 0.74601, 0.76742, 0.78252,
    ]
    const denseIndexes = new Set([
      0, 3, 4, 5, 8, 9, 13, 14, 15, 17, 20, 22, 26, 27, 29, 30, 32, 34,
    ])
    const dominantAnchors = [0.16683, 0.40405, 0.6737, 0.74882]
    const tableRegions = ys.map((y, index) => {
      const rowAnchors = denseIndexes.has(index)
        ? dominantAnchors
        : [index < 3 ? 0.74882 : 0.40405]
      const runs = rowAnchors.map<PdfSourceRun>((x, columnIndex) => ({
        ...box(x, y, columnIndex < 2 ? 0.18 : 0.055, 0.01258),
        text:
          index === 0
            ? ['Source', 'Description', 'Samples', 'Average length'][
                columnIndex
              ]
            : denseIndexes.has(index)
              ? columnIndex < 2
                ? `Record text ${index + 1}-${columnIndex + 1}`
                : `${1000 - index * 7 + columnIndex}`
              : `wrapped continuation ${index + 1}`,
        fontName: 'CompactTableSerif',
        fontSize: 9.9626,
        confidence: 0.99,
      }))
      const sourceLine = {
        id: `wrapped-long-below-line-${index + 1}`,
        text: runs.map((run) => run.text).join(' '),
        fontSize: 9.9626,
        box: box(
          rowAnchors[0],
          y,
          rowAnchors.at(-1)! + runs.at(-1)!.width - rowAnchors[0],
          0.01258,
        ),
        runs,
      } satisfies PdfRegionLine
      return {
        ...textRegion(
          `wrapped-long-below-region-${index + 1}`,
          sourceLine.box,
          [sourceLine],
          'spanning',
        ),
        column: 'span' as const,
      }
    })

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, ...tableRegions],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        direction: 'below',
        sourceRegionIds: tableRegions.map((region) => region.id).sort(),
      },
    })
    expect(result.scope?.sourceLineIds).toHaveLength(tableRegions.length)
    expect(
      result.scope!.cropBox.y + result.scope!.cropBox.height,
    ).toBeGreaterThan(0.79)
  })

  it('keeps styled group headers that span proven columns inside one long repeated table', () => {
    const fixture = longCaptionBelowTableFixture()
    const groupIndexes = new Set([7, 18])
    const tableRegions = fixture.tableRegions.map((region, index) => {
      if (!groupIndexes.has(index)) return region
      const y = region.lines[0].box.y
      const sourceBox = box(0.31, y, 0.25, 0.01258)
      const sourceLine = {
        id: `spanning-group-header-line-${index}`,
        text: `Published group ${index}`,
        fontSize: 9.9626,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Published group ${index}`,
            fontName: 'CompactTableSerif-Bold',
            fontSize: 9.9626,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
      return {
        ...textRegion(
          `spanning-group-header-region-${index}`,
          sourceBox,
          [sourceLine],
          'spanning',
        ),
        column: 'span' as const,
      }
    })

    const result = resolvePdfTableScope({
      caption: fixture.tableCaption,
      pageRegions: [
        fixture.tableCaption,
        ...tableRegions,
        fixture.followingHeading,
      ],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        direction: 'below',
        sourceRegionIds: tableRegions.map((region) => region.id).sort(),
      },
    })
    expect(result.scope?.sourceLineIds).toEqual(
      expect.arrayContaining(
        [...groupIndexes].map((index) => `spanning-group-header-line-${index}`),
      ),
    )
  })

  it('does not treat styled side prose outside every proven table column as a spanning group header', () => {
    const fixture = longCaptionBelowTableFixture()
    const replacementIndex = 12
    const tableRegions = fixture.tableRegions.map((region, index) => {
      if (index !== replacementIndex) return region
      const y = region.lines[0].box.y
      const sourceBox = box(0.82, y, 0.1, 0.01258)
      const sourceLine = {
        id: 'styled-side-prose-line',
        text: 'Unrelated styled prose',
        fontSize: 9.9626,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: 'Unrelated styled prose',
            fontName: 'CompactTableSerif-Bold',
            fontSize: 9.9626,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
      return {
        ...textRegion(
          'styled-side-prose-region',
          sourceBox,
          [sourceLine],
          'spanning',
        ),
        column: 'span' as const,
      }
    })

    expect(
      resolvePdfTableScope({
        caption: fixture.tableCaption,
        pageRegions: [
          fixture.tableCaption,
          ...tableRegions,
          fixture.followingHeading,
        ],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      ambiguity: {
        evidence: expect.arrayContaining([
          'table-source-start-boundary-unproven',
        ]),
      },
    })
  })

  it('fails closed when a distant caption-below lane contains two competing repeated column signatures', () => {
    const fixture = longCaptionBelowTableFixture({
      competingSignatures: true,
    })

    expect(
      resolvePdfTableScope({
        caption: fixture.tableCaption,
        pageRegions: fixture.pageRegions,
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      ambiguity: {
        evidence: expect.arrayContaining([
          'table-source-start-boundary-unproven',
        ]),
      },
    })
  })

  it('resolves the extended caption-below table deterministically under reversed region input', () => {
    const forward = longCaptionBelowTableFixture()
    const reversed = longCaptionBelowTableFixture({ reverseInput: true })

    const forwardResult = resolvePdfTableScope({
      caption: forward.tableCaption,
      pageRegions: forward.pageRegions,
      nativeObjects: [],
    })
    const reversedResult = resolvePdfTableScope({
      caption: reversed.tableCaption,
      pageRegions: reversed.pageRegions,
      nativeObjects: [],
    })

    expect(reversedResult).toEqual(forwardResult)
  })

  it('accepts a normal body-measure wrapped table only when its symbolic header is inside the scope', () => {
    const header = line('symbolic-header', 0.2, [0.17647, 0.27, 0.39, 0.56])
    header.text =
      'Feature Similarity Score Feature description from source evidence'
    header.runs.forEach((run, index) => {
      run.text = ['Feature', 'Similarity', 'Score', 'Feature description'][
        index
      ]
      run.bold = true
    })
    const headerRegion = textRegion(
      'symbolic-table-header',
      box(0.17647, 0.2, 0.64706, 0.016),
      [header],
      'equation',
    )
    const bodyLines = Array.from({ length: 5 }, (_, rowIndex) => {
      const y = 0.23 + rowIndex * 0.046
      const lead = line(
        `wrapped-row-${rowIndex + 1}`,
        y,
        [0.17647, 0.27, 0.39, 0.56],
      )
      const continuation = line(
        `wrapped-continuation-${rowIndex + 1}`,
        y + 0.018,
        [0.56],
      )
      continuation.box = box(0.56, y + 0.018, 0.26353, 0.016)
      continuation.runs[0] = {
        ...continuation.runs[0],
        width: 0.26353,
      }
      return [lead, continuation]
    }).flat()
    const body = textRegion(
      'normal-body-measure-table',
      box(0.17647, 0.23, 0.64706, 0.2),
      bodyLines,
    )
    const tableCaption = {
      ...caption(
        'normal-body-measure-caption',
        0.45,
        'Table 8. Wrapped source rows.',
      ),
      box: box(0.17647, 0.45, 0.64706, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [headerRegion, body, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-tabular-line-band',
        direction: 'above',
        sourceRegionIds: [body.id, headerRegion.id],
        sourceLineIds: expect.arrayContaining([header.id]),
        cropBox: expect.objectContaining({
          x: 0.17647,
          y: 0.2,
          width: 0.64706,
        }),
      },
    })
  })

  it('closes a proved body scope over its unique adjacent symbolic header', () => {
    const omittedHeader = line(
      'omitted-symbolic-header',
      0.2,
      [0.17647, 0.39, 0.56],
    )
    omittedHeader.text = 'x α y'
    omittedHeader.runs.forEach((run, index) => {
      run.text = ['x', 'α', 'y'][index]
      run.bold = true
    })
    const headerRegion = textRegion(
      'omitted-table-header',
      box(0.17647, 0.2, 0.64706, 0.016),
      [omittedHeader],
      'equation',
    )
    const bodyLines = Array.from({ length: 5 }, (_, index) =>
      line(
        `body-only-row-${index + 1}`,
        0.23 + index * 0.03,
        [0.17647, 0.39, 0.56],
      ),
    )
    const body = textRegion(
      'body-with-omitted-header',
      box(0.17647, 0.23, 0.64706, 0.136),
      bodyLines,
    )
    const tableCaption = {
      ...caption('omitted-header-caption', 0.39),
      box: box(0.17647, 0.39, 0.64706, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [headerRegion, body, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        sourceRegionIds: [body.id, headerRegion.id],
        sourceLineIds: [omittedHeader.id, ...bodyLines.map((item) => item.id)],
        cropBox: expect.objectContaining({
          x: 0.17247,
          y: 0.196,
        }),
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'caption-lane-source-completion',
            headerLineIds: [omittedHeader.id],
            borderInkPadding: 0.004,
          }),
        ]),
      },
    })
  })

  it('retains an explicit source header with distinct typography', () => {
    const headerLine = line(
      'distinct-font-header-line',
      0.2,
      [0.17647, 0.39, 0.56],
    )
    headerLine.runs.forEach((run) => {
      run.fontName = 'HeaderSans'
      run.bold = false
    })
    const headerRegion = textRegion(
      'distinct-font-header-region',
      headerLine.box,
      [headerLine],
      'header',
    )
    const bodyLines = Array.from({ length: 5 }, (_, index) =>
      line(
        `distinct-font-body-row-${index + 1}`,
        0.23 + index * 0.03,
        [0.17647, 0.39, 0.56],
      ),
    )
    const body = textRegion(
      'distinct-font-body',
      box(0.17647, 0.23, 0.64706, 0.136),
      bodyLines,
    )
    const tableCaption = {
      ...caption('distinct-font-header-caption', 0.39),
      box: box(0.17647, 0.39, 0.64706, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [headerRegion, body, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        sourceRegionIds: [body.id, headerRegion.id],
        sourceLineIds: [headerLine.id, ...bodyLines.map((item) => item.id)],
      },
    })
  })

  it('atomically closes a unique wrapped header continuation', () => {
    const headerLeadLine = line('wrapped-header-lead', 0.19, [0.17647, 0.39])
    const headerTailLine = line('wrapped-header-tail', 0.19, [0.56, 0.72])
    const continuationLine = line('wrapped-header-continuation', 0.207, [0.39])
    continuationLine.runs[0] = {
      ...continuationLine.runs[0],
      width: 0.07,
    }
    continuationLine.box = box(0.39, 0.207, 0.07, 0.016)
    const headerLead = textRegion(
      'wrapped-header-lead-region',
      headerLeadLine.box,
      [headerLeadLine],
      'header',
    )
    const headerTail = textRegion(
      'wrapped-header-tail-region',
      headerTailLine.box,
      [headerTailLine],
      'header',
    )
    const headerContinuation = textRegion(
      'wrapped-header-continuation-region',
      continuationLine.box,
      [continuationLine],
      'header',
    )
    const bodyLines = Array.from({ length: 5 }, (_, index) =>
      line(
        `wrapped-header-body-row-${index + 1}`,
        0.235 + index * 0.03,
        [0.17647, 0.39, 0.56, 0.72],
      ),
    )
    const body = textRegion(
      'wrapped-header-body',
      box(0.17647, 0.235, 0.61853, 0.136),
      bodyLines,
    )
    const tableCaption = {
      ...caption('wrapped-header-caption', 0.395),
      box: box(0.17647, 0.395, 0.64706, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [
          headerLead,
          headerTail,
          headerContinuation,
          body,
          tableCaption,
        ],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        sourceRegionIds: [
          body.id,
          headerContinuation.id,
          headerLead.id,
          headerTail.id,
        ],
        sourceLineIds: [
          headerLeadLine.id,
          headerTailLine.id,
          continuationLine.id,
          ...bodyLines.map((item) => item.id),
        ],
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'caption-lane-source-completion',
            headerLineIds: [
              continuationLine.id,
              headerLeadLine.id,
              headerTailLine.id,
            ].sort(),
          }),
        ]),
      },
    })
  })

  it('fails closed when a wrapped continuation matches multiple base cells', () => {
    const baseLine = line(
      'ambiguous-wrapped-header-base',
      0.19,
      [0.17647, 0.36, 0.38, 0.56, 0.72],
    )
    const continuationLine = line(
      'ambiguous-wrapped-header-continuation',
      0.207,
      [0.37],
    )
    const base = textRegion(
      'ambiguous-wrapped-header-base-region',
      baseLine.box,
      [baseLine],
      'header',
    )
    const continuation = textRegion(
      'ambiguous-wrapped-header-continuation-region',
      continuationLine.box,
      [continuationLine],
      'header',
    )
    const bodyLines = Array.from({ length: 5 }, (_, index) =>
      line(
        `ambiguous-wrapped-header-body-row-${index + 1}`,
        0.235 + index * 0.03,
        [0.17647, 0.39, 0.56, 0.72],
      ),
    )
    const body = textRegion(
      'ambiguous-wrapped-header-body',
      box(0.17647, 0.235, 0.61853, 0.136),
      bodyLines,
    )
    const tableCaption = {
      ...caption('ambiguous-wrapped-header-caption', 0.395),
      box: box(0.17647, 0.395, 0.64706, 0.02),
    }
    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [base, continuation, body, tableCaption],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        sourceRegionIds: [body.id],
        sourceLineIds: bodyLines.map((item) => item.id),
      },
    })
  })

  it('fails closed when one explicit header could own two disjoint table bodies', () => {
    const left = textRegion(
      'left-header-candidate',
      box(0.1, 0.22, 0.28, 0.096),
      [
        line('left-row-1', 0.22, [0.1, 0.19, 0.28]),
        line('left-row-2', 0.26, [0.1, 0.19, 0.28]),
        line('left-row-3', 0.3, [0.1, 0.19, 0.28]),
      ],
    )
    const right = textRegion(
      'right-header-candidate',
      box(0.58, 0.22, 0.28, 0.096),
      [
        line('right-row-1', 0.22, [0.58, 0.67, 0.76]),
        line('right-row-2', 0.26, [0.58, 0.67, 0.76]),
        line('right-row-3', 0.3, [0.58, 0.67, 0.76]),
      ],
    )
    const sharedHeaderLine = line(
      'shared-header-line',
      0.19,
      [0.1, 0.34, 0.58, 0.8],
    )
    sharedHeaderLine.runs.forEach((run) => {
      run.bold = true
      run.fontName = 'TableSerif-Bold'
    })
    const sharedHeader = textRegion(
      'shared-header',
      box(0.1, 0.19, 0.775, 0.016),
      [sharedHeaderLine],
      'header',
    )
    const tableCaption = {
      ...caption('ambiguous-header-caption', 0.34),
      column: 'span' as const,
      box: box(0.08, 0.34, 0.84, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [sharedHeader, left, right, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: {
        code: 'no-proven-scope',
        evidence: expect.arrayContaining(['table-header-outside-source-scope']),
      },
    })
  })

  it('proves a below-caption label-value table with bounded prose-like equation rows', () => {
    const recordLine = (
      id: string,
      y: number,
      label: string,
      value: string,
    ) => {
      const labelRun: PdfSourceRun = {
        ...box(0.18624, y, 0.15, 0.01258),
        text: `${label}:`,
        fontName: 'TableSerif-Bold',
        fontSize: 8,
        confidence: 0.99,
        bold: true,
      }
      const valueRun: PdfSourceRun = {
        ...box(0.34, y, 0.46, 0.01258),
        text: value,
        fontName: 'TableSerif',
        fontSize: 8,
        confidence: 0.99,
      }
      return {
        id,
        text: `${label}: ${value}`,
        fontSize: 8,
        box: box(0.18624, y, 0.6147, 0.01258),
        runs: [labelRun, valueRun],
      } satisfies PdfRegionLine
    }
    const continuationLine = (id: string, y: number) => {
      const sourceBox = box(0.18624, y, 0.6147, 0.01258)
      return {
        id,
        text: 'Wrapped record value continues across the full source measure.',
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: 'Wrapped record value continues across the full source measure.',
            fontName: 'TableSerif',
            fontSize: 8,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    }
    const question = recordLine(
      'record-question',
      0.15,
      'Question',
      'How should the source response be interpreted?',
    )
    const original = recordLine(
      'record-original',
      0.19,
      'Original output',
      'The first source answer begins here.',
    )
    const coefficient = recordLine(
      'record-coefficient',
      0.23,
      'Steering during inference (coef=0.5)',
      'The source answer remains ordinary prose.',
    )
    const training = recordLine(
      'record-training',
      0.27,
      'Steering during training (coef=1.0)',
      'The final source answer remains ordinary prose.',
    )
    const body = textRegion(
      'label-value-record-body',
      box(0.18624, 0.15, 0.6147, 0.145),
      [
        question,
        continuationLine('record-question-continuation', 0.164),
        original,
        continuationLine('record-original-continuation', 0.204),
        continuationLine('record-coefficient-continuation', 0.244),
        training,
        continuationLine('record-training-continuation', 0.284),
      ],
    )
    const equationLikeLabel = textRegion(
      'equation-like-record-label',
      coefficient.box,
      [coefficient],
      'equation',
    )
    const tableCaption = {
      ...caption(
        'label-value-caption',
        0.11,
        'Table 3. Source-authored steering records.',
      ),
      box: box(0.18624, 0.11, 0.6147, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [tableCaption, body, equationLikeLabel],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        direction: 'below',
        sourceRegionIds: [equationLikeLabel.id, body.id],
        sourceLineIds: expect.arrayContaining([coefficient.id]),
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'repeated-labeled-record-rows',
            labeledRowCount: 4,
          }),
        ]),
      },
    })
  })

  it('does not cross a following caption or page to extend a below-caption record table', () => {
    const labeledLine = (id: string, y: number) => {
      const sourceBox = box(0.12, y, 0.68, 0.016)
      return {
        id,
        text: `Field ${id}: bounded table value`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            width: 0.14,
            text: `Field ${id}:`,
            fontName: 'Table-Bold',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
          {
            ...sourceBox,
            x: 0.28,
            width: 0.52,
            text: 'bounded table value',
            fontName: 'Table',
            fontSize: 8,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    }
    const firstLines = [0.15, 0.18, 0.21].map((y, index) =>
      labeledLine(`first-${index + 1}`, y),
    )
    const firstTable = textRegion(
      'first-bounded-record-table',
      box(0.12, 0.15, 0.68, 0.076),
      firstLines,
    )
    const firstCaption = caption(
      'first-record-caption',
      0.11,
      'Table 1. First records.',
    )
    const secondCaption = caption(
      'second-record-caption',
      0.27,
      'Table 2. Separate records.',
    )
    const secondLines = [0.31, 0.34, 0.37].map((y, index) =>
      labeledLine(`second-${index + 1}`, y),
    )
    const secondTable = textRegion(
      'second-bounded-record-table',
      box(0.12, 0.31, 0.68, 0.076),
      secondLines,
    )
    const nextPage = {
      ...textRegion(
        'next-page-record-table',
        box(0.12, 0.1, 0.68, 0.076),
        [0.1, 0.13, 0.16].map((y, index) =>
          labeledLine(`next-${index + 1}`, y),
        ),
      ),
      page: 2,
      box: {
        ...box(0.12, 0.1, 0.68, 0.076),
        page: 2,
      },
    }
    nextPage.lines = nextPage.lines.map((sourceLine) => ({
      ...sourceLine,
      box: { ...sourceLine.box, page: 2 },
      runs: sourceLine.runs.map((run) => ({ ...run, page: 2 })),
    }))

    const result = resolvePdfTableScope({
      caption: firstCaption,
      pageRegions: [
        firstCaption,
        firstTable,
        secondCaption,
        secondTable,
        nextPage,
      ],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        direction: 'below',
        sourceRegionIds: [firstTable.id],
      },
    })
    expect(result.scope?.sourceRegionIds).not.toContain(secondTable.id)
    expect(result.scope?.sourceRegionIds).not.toContain(nextPage.id)
  })

  it('does not turn a narrow ordinary paragraph into a caption-bounded table slab', () => {
    const paragraphLines = Array.from({ length: 6 }, (_, index) =>
      proseLine(`ordinary-paragraph-${index + 1}`, 0.2 + index * 0.024),
    )
    const paragraph = textRegion(
      'ordinary-paragraph',
      box(0.12, 0.2, 0.324, 0.136),
      paragraphLines,
    )
    const tableCaption = caption('caption-after-prose', 0.36)

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [paragraph, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: { code: 'no-proven-scope' },
    })
  })

  it('does not turn wide wrapped prose on either side of a caption into a table slab', () => {
    const wrappedLines = (prefix: string, startY: number) =>
      Array.from({ length: 7 }, (_, index) => {
        const sourceBox = box(0.17647, startY + index * 0.022, 0.64706, 0.016)
        return {
          id: `${prefix}-${index + 1}`,
          text: `This ordinary wrapped sentence ${index + 1} remains canonical prose.`,
          fontSize: 10,
          box: sourceBox,
          runs: [
            {
              ...sourceBox,
              text: `This ordinary wrapped sentence ${index + 1} remains canonical prose.`,
              fontName: 'BodySerif',
              fontSize: 10,
              confidence: 0.99,
            },
          ],
        } satisfies PdfRegionLine
      })
    const above = textRegion(
      'wide-prose-above',
      box(0.17647, 0.12, 0.64706, 0.148),
      wrappedLines('above-prose', 0.12),
    )
    const tableCaption = {
      ...caption('wide-prose-caption', 0.29),
      box: box(0.17647, 0.29, 0.64706, 0.02),
    }
    const below = textRegion(
      'wide-prose-below',
      box(0.17647, 0.33, 0.64706, 0.148),
      wrappedLines('below-prose', 0.33),
    )

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [above, tableCaption, below],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: { code: 'no-proven-scope' },
    })
  })

  it('owns a sparse monospaced prompt panel only when its caption and internal records prove the scope', () => {
    const promptLine = (
      id: string,
      text: string,
      y: number,
      x = 0.12,
      width = 0.34,
    ) => {
      const sourceBox = box(x, y, width, 0.011)
      return {
        id,
        text,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text,
            fontName: 'Inconsolata-Regular',
            fontSize: 8,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    }
    const storyLines = Array.from({ length: 18 }, (_, index) =>
      promptLine(
        `prompt-story-${index + 1}`,
        index === 0
          ? '"I do not know," answered Maria.'
          : `Source prompt passage line ${index + 1}.`,
        0.086 + index * 0.017,
      ),
    )
    const promptRegions = [
      textRegion('prompt-story', box(0.12, 0.086, 0.34, 0.3), storyLines),
      textRegion('prompt-question', box(0.12, 0.404, 0.34, 0.011), [
        promptLine(
          'prompt-question-1',
          'Question: List very brief facts about Lucy.',
          0.404,
        ),
      ]),
      ...[1, 2, 3].map((ordinal, index) => {
        const y = 0.441 + index * 0.024
        const sourceLine = promptLine(
          `prompt-answer-${ordinal}`,
          `${ordinal}. Lucy fact ${ordinal}.`,
          y,
        )
        return textRegion(`prompt-answer-region-${ordinal}`, sourceLine.box, [
          sourceLine,
        ])
      }),
    ]
    const promptCaption = {
      ...caption(
        'caption-sparse-prompt',
        0.513,
        'Table 8: An example prompt for listing initial facts about a character.',
      ),
      box: box(0.12, 0.513, 0.34, 0.024),
    }
    const expectedLineIds = promptRegions
      .flatMap((region) => region.lines.map((sourceLine) => sourceLine.id))
      .sort((left, right) => {
        const sourceLine = (id: string) =>
          promptRegions
            .flatMap((region) => region.lines)
            .find((candidate) => candidate.id === id)!
        return sourceLine(left).box.y - sourceLine(right).box.y
      })

    expect(
      resolvePdfTableScope({
        caption: promptCaption,
        pageRegions: [...promptRegions, promptCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        direction: 'above',
        sourceRegionIds: promptRegions.map((region) => region.id).sort(),
        sourceLineIds: expectedLineIds,
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'caption-bounded-prompt-slab',
            rowCount: 22,
            monospacedRowCount: 22,
            structuredRecordCount: 4,
          }),
        ]),
      },
    })
  })

  it('owns a proportional prompt slab only between exact sibling table captions', () => {
    const proportionalPromptLine = (id: string, text: string, y: number) => {
      const sourceBox = box(0.2, y, 0.46, 0.014)
      return {
        id,
        text,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text,
            fontName: 'SourceSans-Regular',
            fontSize: 8,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    }
    const promptLines = [
      proportionalPromptLine(
        'prompt-question',
        'Question: classify the record.',
        0.17,
      ),
      proportionalPromptLine(
        'prompt-detail-1',
        'Use the supplied source fields.',
        0.194,
      ),
      proportionalPromptLine(
        'prompt-context',
        'Context: bounded example.',
        0.218,
      ),
      proportionalPromptLine(
        'prompt-detail-2',
        'Return one exact response.',
        0.242,
      ),
      proportionalPromptLine('prompt-output', 'Output: accepted label.', 0.266),
      proportionalPromptLine(
        'prompt-detail-3',
        'End of the prompt record.',
        0.29,
      ),
    ]
    const prompt = textRegion(
      'proportional-prompt',
      box(0.2, 0.17, 0.46, 0.134),
      promptLines,
    )
    const previousCaption = {
      ...caption(
        'previous-table-caption',
        0.12,
        'Table 4. Previous bounded prompt.',
      ),
      box: box(0.18, 0.12, 0.5, 0.02),
    }
    const promptCaption = {
      ...caption(
        'proportional-prompt-caption',
        0.32,
        'Table 5. Prompt records used for evaluation.',
      ),
      box: box(0.18, 0.32, 0.5, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: promptCaption,
        pageRegions: [previousCaption, prompt, promptCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        sourceRegionIds: [prompt.id],
        sourceLineIds: promptLines.map((item) => item.id),
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'caption-bounded-prompt-slab',
            rowCount: 6,
            monospacedRowCount: 0,
            structuredRecordCount: 3,
          }),
        ]),
      },
    })
  })

  it('rejects a proportional prompt slab with unowned flow inside its sibling-caption lane', () => {
    const promptLine = (id: string, text: string, y: number) => {
      const sourceBox = box(0.2, y, 0.46, 0.014)
      return {
        id,
        text,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text,
            fontName: 'SourceSans-Regular',
            fontSize: 8,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    }
    const strayLine = {
      ...promptLine(
        'unowned-flow-line',
        'Ordinary prose remains outside the prompt.',
        0.16,
      ),
      runs: [
        {
          ...box(0.2, 0.16, 0.46, 0.014),
          text: 'Ordinary prose remains outside the prompt.',
          fontName: 'BodySerif',
          fontSize: 10,
          confidence: 0.99,
        },
      ],
      fontSize: 10,
    }
    const stray = textRegion('unowned-flow', strayLine.box, [strayLine])
    const promptLines = [
      promptLine('bounded-question', 'Question: classify the record.', 0.22),
      promptLine('bounded-detail-1', 'Use the supplied fields.', 0.244),
      promptLine('bounded-context', 'Context: exact example.', 0.268),
      promptLine('bounded-detail-2', 'Return one response.', 0.292),
      promptLine('bounded-output', 'Output: accepted label.', 0.316),
      promptLine('bounded-detail-3', 'End of prompt.', 0.34),
    ]
    const prompt = textRegion(
      'bounded-proportional-prompt',
      box(0.2, 0.22, 0.46, 0.134),
      promptLines,
    )
    const previousCaption = {
      ...caption('bounded-previous-caption', 0.11, 'Table 6. Previous block.'),
      box: box(0.18, 0.11, 0.5, 0.02),
    }
    const promptCaption = {
      ...caption(
        'bounded-proportional-caption',
        0.37,
        'Table 7. Prompt records.',
      ),
      box: box(0.18, 0.37, 0.5, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: promptCaption,
        pageRegions: [previousCaption, stray, prompt, promptCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: { code: 'no-proven-scope' },
    })
  })

  it('does not own sparse monospaced prose without source-authored prompt records', () => {
    const lines = Array.from({ length: 7 }, (_, index) => {
      const y = 0.1 + index * 0.05
      const sourceBox = box(0.12, y, 0.34, 0.011)
      return {
        id: `sparse-prose-${index + 1}`,
        text: `Ordinary monospaced prose fragment ${index + 1}.`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Ordinary monospaced prose fragment ${index + 1}.`,
            fontName: 'Inconsolata-Regular',
            fontSize: 8,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    })
    const prose = textRegion(
      'sparse-monospaced-prose',
      box(0.12, 0.1, 0.34, 0.311),
      lines,
    )
    const tableCaption = {
      ...caption(
        'caption-after-sparse-prose',
        0.43,
        'Table 8: A narrative excerpt.',
      ),
      box: box(0.12, 0.43, 0.34, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [prose, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: { code: 'no-proven-scope' },
    })
  })

  it('keeps a unique wide slab when a short caption only touches its edge', () => {
    const slabLines = Array.from({ length: 6 }, (_, index) => {
      const sourceBox = box(0.12, 0.2 + index * 0.024, 0.68, 0.016)
      return {
        id: `edge-slab-line-${index + 1}`,
        text: `Field ${index + 1}: bounded table value`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Field ${index + 1}: bounded table value`,
            fontName: 'TableSerif-Bold',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
    })
    const slab = textRegion(
      'edge-touching-wide-slab',
      box(0.12, 0.2, 0.68, 0.136),
      slabLines,
    )
    const shortCaption = {
      ...caption('short-edge-caption', 0.36),
      box: box(0.05, 0.36, 0.09, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: shortCaption,
        pageRegions: [slab, shortCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        sourceRegionIds: [slab.id],
        sourceLineIds: slabLines.map((line) => line.id),
      },
    })
  })

  it('keeps an interleaved neighboring column out of a caption-bounded text slab', () => {
    const singleAnchorLines = (
      prefix: string,
      x: number,
      y: number,
      width: number,
      fontSize: number,
    ) =>
      Array.from({ length: 6 }, (_, index) => {
        const sourceBox = box(x, y + index * 0.024, width, 0.016)
        return {
          id: `${prefix}-${index + 1}`,
          text: `${prefix}-${index + 1}`,
          fontSize,
          box: sourceBox,
          runs: [
            {
              ...sourceBox,
              text: `${prefix}-${index + 1}`,
              fontName: prefix === 'table' ? 'TableSerif' : 'BodySerif',
              fontSize,
              confidence: 0.99,
            },
          ],
        } satisfies PdfRegionLine
      })
    const tableLines = singleAnchorLines('table', 0.56, 0.194, 0.32, 8)
    const neighboringLines = singleAnchorLines(
      'neighboring-prose',
      0.08,
      0.206,
      0.32,
      10,
    )
    const table = textRegion(
      'right-column-table',
      box(0.56, 0.194, 0.32, 0.136),
      tableLines,
    )
    const neighboringProse = textRegion(
      'left-column-prose',
      box(0.08, 0.206, 0.32, 0.136),
      neighboringLines,
    )
    const tableCaption = {
      ...caption('right-column-caption', 0.348),
      box: box(0.52, 0.348, 0.4, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [neighboringProse, table, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        sourceRegionIds: [table.id],
        sourceLineIds: tableLines.map((item) => item.id),
        cropBox: box(0.56, 0.194, 0.32, 0.136),
      },
    })
  })

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
    const spanningHeaderLines = [
      line('spanning-header-top', 0.18, [0.39, 0.58]),
      line('spanning-header-bottom', 0.2, [0.39, 0.58, 0.76]),
    ]
    const spanningHeader = textRegion(
      'spanning-multiline-header',
      box(0.39, 0.18, 0.445, 0.036),
      spanningHeaderLines,
      'spanning',
    )
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
      pageRegions: [...cells, spanningHeader, adjacentProse, caption()],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-nonuniform-grid',
        sourceRegionIds: [...cells, spanningHeader]
          .map((cell) => cell.id)
          .sort(),
        cropBox: box(0.12, 0.18, 0.715, 0.176),
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

  it('completes same-row fragments across a spanning caption lane and pads border ink', () => {
    const core = textRegion('core-table-grid', box(0.28, 0.2, 0.295, 0.116), [
      line('core-row-1', 0.2, [0.28, 0.5]),
      line('core-row-2', 0.25, [0.28, 0.5]),
      line('core-row-3', 0.3, [0.28, 0.5]),
    ])
    const fragments = [0.2, 0.25, 0.3].flatMap((y, index) =>
      [
        ['left', 0.1],
        ['right', 0.8],
      ].map(([side, x]) => {
        const fragmentLine = line(`${side}-fragment-${index + 1}`, y, [
          x as number,
        ])
        return textRegion(
          `${side}-fragment-region-${index + 1}`,
          fragmentLine.box,
          [fragmentLine],
          'chart-label',
        )
      }),
    )
    const tableCaption = {
      ...caption('spanning-fragment-caption', 0.35),
      column: 'span' as const,
      box: box(0.08, 0.35, 0.84, 0.02),
    }

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [core, ...fragments, tableCaption],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        sourceRegionIds: [
          core.id,
          ...fragments.map((region) => region.id),
        ].sort(),
        sourceLineIds: expect.arrayContaining([
          ...core.lines.map((item) => item.id),
          ...fragments.flatMap((region) => region.lines.map((item) => item.id)),
        ]),
        cropBox: expect.objectContaining({
          x: 0.096,
          y: 0.196,
        }),
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'caption-lane-source-completion',
            rowFragmentLineIds: fragments
              .flatMap((region) => region.lines.map((item) => item.id))
              .sort(),
            borderInkPadding: 0.004,
          }),
        ]),
      },
    })
  })

  it('keeps row-fragment completion inside a narrow caption column', () => {
    const core = {
      ...textRegion('left-column-core-grid', box(0.12, 0.2, 0.255, 0.116), [
        line('left-core-row-1', 0.2, [0.12, 0.3]),
        line('left-core-row-2', 0.25, [0.12, 0.3]),
        line('left-core-row-3', 0.3, [0.12, 0.3]),
      ]),
      column: 'left' as const,
    }
    const leftFragmentLine = line('left-owned-fragment', 0.25, [0.46])
    const leftFragment = {
      ...textRegion(
        'left-owned-fragment-region',
        leftFragmentLine.box,
        [leftFragmentLine],
        'chart-label',
      ),
      column: 'left' as const,
    }
    const rightFragmentLine = line('right-unowned-fragment', 0.25, [0.72])
    const rightFragment = {
      ...textRegion(
        'right-unowned-fragment-region',
        rightFragmentLine.box,
        [rightFragmentLine],
        'chart-label',
      ),
      column: 'right' as const,
    }
    const tableCaption = {
      ...caption('left-column-fragment-caption', 0.35),
      column: 'left' as const,
      box: box(0.08, 0.35, 0.45, 0.02),
    }

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [core, leftFragment, rightFragment, tableCaption],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        sourceRegionIds: [core.id, leftFragment.id].sort(),
        sourceLineIds: expect.arrayContaining([
          leftFragmentLine.id,
          ...core.lines.map((item) => item.id),
        ]),
      },
    })
    expect(result.scope?.sourceRegionIds).not.toContain(rightFragment.id)
    expect(result.scope?.sourceLineIds).not.toContain(rightFragmentLine.id)
  })

  it('rejects a table completion corridor interrupted by unowned prose', () => {
    const table = textRegion(
      'interrupted-table-grid',
      box(0.12, 0.18, 0.455, 0.096),
      [
        line('interrupted-row-1', 0.18, [0.12, 0.31, 0.5]),
        line('interrupted-row-2', 0.22, [0.12, 0.31, 0.5]),
        line('interrupted-row-3', 0.26, [0.12, 0.31, 0.5]),
      ],
    )
    const prose = textRegion(
      'intervening-unowned-prose',
      box(0.12, 0.292, 0.45, 0.016),
      [proseLine('intervening-prose-line', 0.292)],
    )
    const tableCaption = {
      ...caption('interrupted-table-caption', 0.32),
      box: box(0.1, 0.32, 0.52, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [table, prose, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: { code: 'no-proven-scope' },
    })
  })

  it('keeps formula-bearing row labels inside an atomized caption-bounded table grid', () => {
    const atomicCell = (
      id: string,
      text: string,
      x: number,
      y: number,
      width: number,
      kind: PdfPageRegion['kind'] = 'body',
    ) => {
      const sourceBox = box(x, y, width, 0.016)
      const sourceLine = {
        id: `${id}-line`,
        text,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text,
            fontName: 'TableSerif',
            fontSize: 8,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
      return textRegion(id, sourceBox, [sourceLine], kind)
    }
    const header = [
      atomicCell('header-model', 'Model', 0.31, 0.15, 0.17),
      atomicCell('header-score', 'MT-Bench', 0.52, 0.15, 0.08),
      atomicCell('header-error', 'Std. Error', 0.61, 0.15, 0.09),
    ]
    const rows = Array.from({ length: 6 }, (_, rowIndex) => {
      const y = 0.18 + rowIndex * 0.022
      return [
        atomicCell(
          `row-${rowIndex + 1}-model`,
          rowIndex % 2 === 0
            ? `cache compression, s = ${4 + rowIndex}`
            : `baseline, ${64 - rowIndex * 4} iterations`,
          0.31,
          y,
          0.18,
          'equation',
        ),
        atomicCell(
          `row-${rowIndex + 1}-score`,
          `5.${856 - rowIndex * 31}`,
          0.52,
          y,
          0.05,
        ),
        atomicCell(
          `row-${rowIndex + 1}-error`,
          `0.${395 - rowIndex * 2}`,
          0.61,
          y,
          0.05,
        ),
      ]
    }).flat()
    const tableCaption = {
      ...caption(
        'caption-formula-label-table',
        0.09,
        'Table 6: First turn scores and standard errors.',
      ),
      box: box(0.09, 0.09, 0.8, 0.04),
    }
    const followingHeading = textRegion(
      'following-section-heading',
      box(0.09, 0.33, 0.2, 0.02),
      [
        {
          ...line('following-section-line', 0.33, [0.09]),
          text: 'A.2. Hardware',
          runs: [
            {
              ...box(0.09, 0.33, 0.2, 0.02),
              text: 'A.2. Hardware',
              fontName: 'BodySerif-Bold',
              fontSize: 10,
              confidence: 0.99,
              bold: true,
            },
          ],
        },
      ],
    )

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, ...header, ...rows, followingHeading],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        direction: 'below',
        sourceRegionIds: [...header, ...rows].map((region) => region.id).sort(),
      },
    })
    expect(result.scope?.sourceRegionIds).not.toContain(followingHeading.id)
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

  it('closes a partial table header over a split subscript cell on the same source row', () => {
    const cellLine = (
      id: string,
      x: number,
      y: number,
      text: string,
      {
        width = 0.064,
        height = 0.0142,
        subscript,
      }: { width?: number; height?: number; subscript?: string } = {},
    ) => {
      const baseWidth = subscript ? width - 0.015 : width
      const runs: PdfSourceRun[] = [
        {
          ...box(x, y, baseWidth, 0.0142),
          text,
          fontName: 'TableSerif',
          fontSize: 11.9,
          confidence: 0.99,
        },
        ...(subscript
          ? [
              {
                ...box(x + baseWidth, y + 0.0081, 0.015, 0.0095),
                text: subscript,
                fontName: 'TableSerif-Script',
                fontSize: 8,
                confidence: 0.99,
              },
            ]
          : []),
      ]
      return {
        id,
        text: `${text}${subscript ?? ''}`,
        fontSize: 11.9,
        box: box(x, y, width, height),
        runs,
      } satisfies PdfRegionLine
    }
    const headerLines = [
      cellLine('header-model', 0.218, 0.135, 'Model', { width: 0.063 }),
      cellLine('header-mse', 0.492, 0.135, 'MSE', {
        width: 0.057,
        height: 0.0164,
        subscript: 'all',
      }),
      cellLine('header-mae', 0.601, 0.135, 'MAE', {
        width: 0.061,
        height: 0.0164,
        subscript: 'all',
      }),
      cellLine('header-qlike', 0.695, 0.135, 'QLIKE', {
        width: 0.079,
        height: 0.0176,
        subscript: 'all',
      }),
    ]
    const header = textRegion(
      'split-script-header-parent',
      box(0.218, 0.135, 0.556, 0.0176),
      headerLines,
    )
    const body = [0.159, 0.176, 0.193, 0.21, 0.227].map((y, rowIndex) => {
      const sourceLines = [
        cellLine(`row-${rowIndex + 1}-model`, 0.218, y, 'Model value', {
          width: 0.19,
        }),
        cellLine(`row-${rowIndex + 1}-mse`, 0.492, y, '70.281', {
          width: 0.061,
        }),
        cellLine(`row-${rowIndex + 1}-mae`, 0.607, y, '1.588', {
          width: 0.051,
        }),
        cellLine(`row-${rowIndex + 1}-qlike`, 0.708, y, '1.4621', {
          width: 0.055,
        }),
      ]
      const retainedSourceLines =
        rowIndex === 3 ? [sourceLines[0], sourceLines[3]] : sourceLines
      return textRegion(
        `table-row-${rowIndex + 1}`,
        box(0.218, y, 0.545, 0.0142),
        retainedSourceLines,
      )
    })
    const splitNumericLines = [
      cellLine('row-4-mse-detached', 0.492, 0.21, '1.71 × 10¹⁷', {
        width: 0.105,
      }),
      cellLine('row-4-mae-detached', 0.607, 0.21, '3.67 × 10⁷', {
        width: 0.095,
      }),
    ]
    const splitNumericCells = textRegion(
      'split-numeric-table-cells',
      box(0.492, 0.21, 0.21, 0.0142),
      splitNumericLines,
      'equation',
    )
    const tableCaption = {
      ...caption(
        'caption-before-split-script-table',
        0.08,
        'Table 1. Complete four-column results.',
      ),
      box: box(0.12, 0.08, 0.76, 0.031),
    }

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, header, ...body, splitNumericCells],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-tabular-line-band',
        direction: 'below',
        sourceLineIds: expect.arrayContaining(
          [...headerLines, ...splitNumericLines].map(
            (sourceLine) => sourceLine.id,
          ),
        ),
        regionLineage: expect.arrayContaining([
          expect.objectContaining({
            regionId: header.id,
            selection: 'whole',
            lineIds: headerLines.map((sourceLine) => sourceLine.id).sort(),
            retainedLineIds: [],
          }),
          expect.objectContaining({
            regionId: splitNumericCells.id,
            selection: 'whole',
            lineIds: splitNumericLines
              .map((sourceLine) => sourceLine.id)
              .sort(),
            retainedLineIds: [],
          }),
        ]),
      },
    })
    if (!result.scope) throw new Error('expected complete table source scope')
    expect(result.scope.cropBox.x + result.scope.cropBox.width).toBeCloseTo(
      0.774,
      5,
    )
  })

  it('stops a below-caption table band before a source-styled section heading', () => {
    const tableLines = [
      line('table-header', 0.14, [0.22, 0.38, 0.54]),
      line('table-row-1', 0.164, [0.22, 0.38, 0.54]),
      line('table-row-2', 0.188, [0.22, 0.38, 0.54]),
      line('table-row-3', 0.212, [0.22, 0.38, 0.54]),
      line('table-row-4', 0.236, [0.22, 0.38, 0.54]),
    ]
    const headingRuns: PdfSourceRun[] = [
      {
        ...box(0.12, 0.276, 0.04, 0.019),
        text: '6.4',
        fontName: 'NimbusRomNo9L-Medi',
        fontSize: 12,
        bold: true,
        confidence: 0.99,
      },
      {
        ...box(0.18, 0.276, 0.24, 0.019),
        text: 'Implementation Details',
        fontName: 'NimbusRomNo9L-Medi',
        fontSize: 12,
        bold: true,
        confidence: 0.99,
      },
    ]
    const headingLine: PdfRegionLine = {
      id: 'section-heading',
      text: '6.4 Implementation Details',
      fontSize: 12,
      box: box(0.12, 0.276, 0.3, 0.019),
      runs: headingRuns,
    }
    const prose = [
      proseLine('section-prose-1', 0.312),
      proseLine('section-prose-2', 0.336),
      proseLine('section-prose-3', 0.36),
    ]
    const parentLines = [...tableLines, headingLine, ...prose]
    const parent = textRegion(
      'table-followed-by-section',
      box(0.12, 0.14, 0.625, 0.236),
      parentLines,
    )
    const tableCaption = caption(
      'caption-before-table-and-section',
      0.1,
      'Table 1. Results before the next section.',
    )

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, parent],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-tabular-line-band',
        sourceLineIds: tableLines.map((sourceLine) => sourceLine.id),
        cropBox: box(0.22, 0.14, 0.395, 0.112),
      },
    })
    expect(result.scope?.sourceLineIds).not.toEqual(
      expect.arrayContaining([
        headingLine.id,
        ...prose.map((sourceLine) => sourceLine.id),
      ]),
    )
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

  it('assigns an adjacent table band to its closer numbered caption', () => {
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
    const above = textRegion(
      'table-14-grid',
      box(0.12, 0.38, 0.63, 0.096),
      aboveLines,
    )
    const below = textRegion(
      'table-15-grid',
      box(0.12, 0.544, 0.63, 0.096),
      belowLines,
    )
    const currentCaption = caption(
      'caption-table-14',
      0.5,
      'Table 14. Baseline results.',
    )
    const nextCaption = caption(
      'caption-table-15',
      0.65,
      'Table 15. Ablation results.',
    )

    const result = resolvePdfTableScope({
      caption: currentCaption,
      pageRegions: [above, currentCaption, below, nextCaption],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        direction: 'above',
        sourceRegionIds: ['table-14-grid'],
      },
      candidates: [{ sourceRegionIds: ['table-14-grid'] }],
      ambiguity: { code: 'none' },
    })
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

  it('closes a narrow centered caption across the complete proven row band', () => {
    const ys = [0.22, 0.244, 0.268]
    const columnRegion = (id: string, x: number) => {
      const lines = ys.map((y, rowIndex) => {
        const sourceBox = box(x, y, 0.04, 0.016)
        return {
          id: `${id}-row-${rowIndex + 1}`,
          text: `${id}-${rowIndex + 1}`,
          fontSize: 8,
          box: sourceBox,
          runs: [
            {
              ...sourceBox,
              text: `${id}-${rowIndex + 1}`,
              fontName: 'AtomizedTable',
              fontSize: 8,
              confidence: 0.99,
            },
          ],
        } satisfies PdfRegionLine
      })
      return textRegion(
        id,
        box(x, ys[0], 0.04, ys.at(-1)! + 0.016 - ys[0]),
        lines,
      )
    }
    const columns = [
      columnRegion('left-labels', 0.17),
      columnRegion('left-values', 0.25),
      columnRegion('center-a', 0.36),
      columnRegion('center-b', 0.44),
      columnRegion('center-c', 0.52),
      columnRegion('center-d', 0.6),
      columnRegion('right-a', 0.7),
      columnRegion('right-b', 0.78),
    ]
    const diagramLines = ys.map((y, rowIndex) => {
      const sourceBox = box(0.05, y, 0.18, 0.008)
      return {
        id: `small-diagram-label-${rowIndex + 1}`,
        text: `diagram-${rowIndex + 1}`,
        fontSize: 5,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `diagram-${rowIndex + 1}`,
            fontName: 'DiagramLabel',
            fontSize: 5,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    })
    const neighboringDiagram = textRegion(
      'small-neighboring-diagram-labels',
      box(0.05, ys[0], 0.18, ys.at(-1)! + 0.008 - ys[0]),
      diagramLines,
      'chart-label',
    )
    const narrowCaption = {
      ...caption(
        'caption-narrow-table-2',
        0.3,
        'Table 2. Ablation study of different modules.',
      ),
      box: box(0.35, 0.3, 0.3, 0.018),
    }

    const result = resolvePdfTableScope({
      caption: narrowCaption,
      pageRegions: [...columns, neighboringDiagram, narrowCaption],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-tabular-line-band',
        sourceRegionIds: columns.map((region) => region.id).sort(),
        cropBox: box(0.17, 0.22, 0.65, 0.064),
      },
      ambiguity: { code: 'none' },
    })
    expect(result.scope?.sourceLineIds).toHaveLength(ys.length * columns.length)
    expect(result.scope?.sourceRegionIds).not.toContain(neighboringDiagram.id)
  })

  it('recovers a caption-bounded table when a multi-line equation region is a proven middle-column shard', () => {
    const fixture = supplementalEquationTableFixture()

    const result = resolvePdfTableScope({
      caption: fixture.caption,
      pageRegions: fixture.regions,
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-tabular-line-band',
        sourceRegionIds: fixture.expectedRegions
          .map((region) => region.id)
          .sort(),
        sourceLineIds: [
          'table-header-left-middle',
          'table-row-0-right',
          'table-row-1-left',
          'table-equation-cell-1',
          'table-row-1-right',
          'table-row-2-left',
          'table-equation-cell-2',
          'table-row-2-right',
          'table-final-row-line',
        ],
        cropBox: box(0.2, 0.22, 0.575, 0.106),
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: 'multi-run-tabular-line-band',
            rowCount: 4,
            qualifyingRowCount: 4,
            requiredQualifyingRowCount: 3,
          }),
          expect.objectContaining({
            code: 'supplemental-equation-cell-shard',
            regionIds: ['table-equation-shard'],
            lineIds: ['table-equation-cell-1', 'table-equation-cell-2'],
            columnAnchors: [0.32],
          }),
        ]),
      },
      ambiguity: { code: 'none' },
    })
  })

  it('does not supplement equation lines on unmatched row baselines', () => {
    const fixture = supplementalEquationTableFixture({
      equationYs: [0.255, 0.285],
    })

    expect(
      resolvePdfTableScope({
        caption: fixture.caption,
        pageRegions: fixture.regions,
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: { code: 'no-proven-scope' },
    })
  })

  it('does not supplement an equation anchor outside established table columns', () => {
    const fixture = supplementalEquationTableFixture({
      equationX: 0.82,
    })

    expect(
      resolvePdfTableScope({
        caption: fixture.caption,
        pageRegions: fixture.regions,
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: { code: 'no-proven-scope' },
    })
  })

  it('requires two ordinary strong rows to establish a supplemental equation column', () => {
    const fixture = supplementalEquationTableFixture({
      finalHasMiddleAnchor: false,
    })

    expect(
      resolvePdfTableScope({
        caption: fixture.caption,
        pageRegions: fixture.regions,
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: { code: 'no-proven-scope' },
    })
  })

  it('does not promote a multi-line equation-only display into a table', () => {
    const tableCaption = caption(
      'caption-equation-only',
      0.18,
      'Table 2. Caption without a source grid.',
    )
    const equations = textRegion(
      'equation-only-display',
      box(0.32, 0.22, 0.22, 0.106),
      [0.22, 0.25, 0.28, 0.31].map((y, index) =>
        equationCellLine(`display-equation-${index + 1}`, y),
      ),
      'equation',
    )

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [tableCaption, equations],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: { code: 'no-proven-scope' },
    })
  })

  it('excludes neighboring prose and diagram labels from a recovered equation-shard table', () => {
    const fixture = supplementalEquationTableFixture({
      includeNeighbors: true,
    })

    const result = resolvePdfTableScope({
      caption: fixture.caption,
      pageRegions: fixture.regions,
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        sourceRegionIds: fixture.expectedRegions
          .map((region) => region.id)
          .sort(),
      },
    })
    expect(result.scope?.sourceRegionIds).not.toContain(
      'neighboring-diagram-labels',
    )
    expect(result.scope?.sourceRegionIds).not.toContain('neighboring-prose')
  })

  it('fails closed when two equation shards compete for the same supplemental cells', () => {
    const fixture = supplementalEquationTableFixture({
      competingSupplement: true,
    })

    expect(
      resolvePdfTableScope({
        caption: fixture.caption,
        pageRegions: fixture.regions,
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
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

  it('does not cross intervening source text to claim a later native raster', () => {
    const tableCaption = {
      ...caption(
        'page-013-table-2-caption',
        0.37696,
        'Table 2. The prompts used and accuracy of each model.',
      ),
      box: box(0.24623, 0.37696, 0.48284, 0.01132),
    }
    const promptLine = line(
      'page-013-prompt-row',
      0.44611,
      [0.20336, 0.31195, 0.70188],
    )
    const interveningPrompt = textRegion(
      'page-013-intervening-prompt',
      promptLine.box,
      [promptLine],
      'equation',
    )
    const rasterBox = box(
      0.5023529411764706,
      0.4974699575757575,
      0.17470802352941173,
      0.1503330727272727,
      'pdf-object',
    )
    const raster = nativeObject('image-p013-002', 'image', rasterBox)
    const rasterRegion = objectRegion(
      'page-013-object-region-033',
      raster.id,
      rasterBox,
    )
    const followingFigureCaption = {
      ...caption(
        'page-013-figure-13-caption',
        0.66433,
        'Figure 13. Periodic representations.',
      ),
      box: box(0.50153, 0.66433, 0.3856, 0.02516),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [
          tableCaption,
          interveningPrompt,
          rasterRegion,
          followingFigureCaption,
        ],
        nativeObjects: [raster],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
      ambiguity: {
        code: 'no-proven-scope',
        evidence: expect.arrayContaining([
          'intervening-source-text',
          interveningPrompt.id,
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

  it('prefers one exact repeated text grid over unproven raster candidates', () => {
    const grid = textRegion('proven-table-grid', box(0.12, 0.2, 0.63, 0.116), [
      line('header', 0.2, [0.12, 0.4, 0.67]),
      line('row-1', 0.25, [0.12, 0.4, 0.67]),
      line('row-2', 0.3, [0.12, 0.4, 0.67]),
    ])
    const tableCaption = caption('caption-proven-grid', 0.38)
    const rasterBoxes = [
      box(0.12, 0.42, 0.18, 0.1, 'pdf-object'),
      box(0.34, 0.42, 0.18, 0.1, 'pdf-object'),
      box(0.56, 0.42, 0.18, 0.1, 'pdf-object'),
    ]
    const rasters = rasterBoxes.map((sourceBox, index) =>
      nativeObject(`image-p001-chart-${index + 1}`, 'image', sourceBox),
    )
    const rasterRegions = rasters.map((raster, index) =>
      objectRegion(`chart-raster-${index + 1}`, raster.id, raster.box),
    )

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [grid, tableCaption, ...rasterRegions],
      nativeObjects: rasters,
    })

    expect(result).toMatchObject({
      status: 'matched',
      ambiguity: { code: 'none' },
      scope: {
        proof: 'text-grid',
        direction: 'above',
        sourceRegionIds: [grid.id],
        sourceObjectIds: [],
      },
    })
    expect(result.candidates).toHaveLength(1)
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

  it('does not band a fragmented right-column table across the gutter', () => {
    // Region and line geometry reduced from an observed two-column scholarly
    // page. Its right-column table fragments into many single-line regions, so
    // the grid detector cannot own it and the line-band fallback runs. Left
    // column prose shares the same row coordinates. Text is synthetic; only
    // the bounding geometry is faithful.
    const lineHeight = 0.01296
    const lineage: Array<{
      id: string
      column: PdfRegionColumn
      lines: Array<[string, number, number, number]>
    }> = [
      {
        id: 'r01',
        column: 'right',
        lines: [['l01', 0.52739, 0.07296, 0.07508]],
      },
      {
        id: 'r02',
        column: 'right',
        lines: [
          ['l02', 0.65486, 0.07296, 0.21736],
          ['l05', 0.52739, 0.09191, 0.04364],
        ],
      },
      {
        id: 'r03',
        column: 'left',
        lines: [
          ['l03', 0.12101, 0.07481, 0.36675],
          ['l04', 0.12101, 0.09092, 0.36671],
          ['l09', 0.12101, 0.10702, 0.3061],
        ],
      },
      {
        id: 'r04',
        column: 'right',
        lines: [['l06', 0.67503, 0.09191, 0.03342]],
      },
      { id: 'r05', column: 'right', lines: [['l07', 0.73795, 0.09191, 0.079]] },
      {
        id: 'r06',
        column: 'right',
        lines: [
          ['l08', 0.84787, 0.09191, 0.02435],
          ['l10', 0.52739, 0.10802, 0.06786],
        ],
      },
      {
        id: 'r07',
        column: 'right',
        lines: [['l11', 0.67502, 0.10802, 0.03342]],
      },
      {
        id: 'r08',
        column: 'right',
        lines: [
          ['l12', 0.73795, 0.10802, 0.13426],
          ['l14', 0.52739, 0.12412, 0.09809],
        ],
      },
      {
        id: 'r09',
        column: 'left',
        lines: [
          ['l13', 0.13936, 0.12355, 0.34836],
          ['l16', 0.12101, 0.13966, 0.36675],
          ['l19', 0.12101, 0.15576, 0.36655],
          ['l22', 0.12101, 0.17172, 0.36671],
        ],
      },
      {
        id: 'r10',
        column: 'right',
        lines: [
          ['l15', 0.67503, 0.12412, 0.19719],
          ['l17', 0.52739, 0.14065, 0.1072],
        ],
      },
      {
        id: 'r11',
        column: 'right',
        lines: [
          ['l18', 0.67503, 0.14065, 0.19719],
          ['l20', 0.52739, 0.15676, 0.05372],
        ],
      },
      {
        id: 'r12',
        column: 'right',
        lines: [
          ['l21', 0.67503, 0.15676, 0.19719],
          ['l23', 0.52739, 0.17286, 0.07185],
        ],
      },
      {
        id: 'r13',
        column: 'right',
        lines: [['l24', 0.67502, 0.17286, 0.19719]],
      },
    ]

    const regions = lineage.map<PdfPageRegion>((spec) => {
      const lines = spec.lines.map<PdfRegionLine>(([id, x, y, width]) => {
        const header = id === 'l01' || id === 'l02'
        const text =
          spec.column === 'left'
            ? `Left column body text fragment ${id} continues across the measure`
            : header
              ? `Header ${id}`
              : `${id.slice(1)}%`
        const run: PdfSourceRun = {
          ...box(x, y, width, lineHeight),
          text,
          fontName: spec.column === 'left' ? 'BodySerif' : 'TableSerif',
          fontSize: spec.column === 'left' ? 10 : 8,
          confidence: 0.99,
          ...(header ? { bold: true } : {}),
        }
        return {
          id,
          text,
          fontSize: run.fontSize,
          box: box(x, y, width, lineHeight),
          runs: [run],
        }
      })
      const left = Math.min(...lines.map((item) => item.box.x))
      const top = Math.min(...lines.map((item) => item.box.y))
      const right = Math.max(
        ...lines.map((item) => item.box.x + item.box.width),
      )
      const bottom = Math.max(
        ...lines.map((item) => item.box.y + item.box.height),
      )
      return {
        id: spec.id,
        page: 1,
        kind: 'body',
        column: spec.column,
        text: lines.map((item) => item.text).join(' '),
        confidence: 0.98,
        box: box(left, top, right - left, bottom - top),
        lines,
        nativeObjectIds: [],
        includedInReadingOrder: true,
      }
    })

    const tableCaption: PdfPageRegion = {
      ...caption('caption-table', 0.19, 'Table 1. Synthetic column results.'),
      column: 'right',
      box: box(0.52739, 0.19, 0.34496, 0.024),
    }

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [...regions, tableCaption],
      nativeObjects: [],
    })

    // The scope may fail closed, but it may never claim the other column.
    expect(result.scope?.sourceRegionIds ?? []).not.toContain('r03')
    expect(result.scope?.sourceRegionIds ?? []).not.toContain('r09')
    if (result.scope) {
      expect(result.scope.cropBox.x).toBeGreaterThanOrEqual(0.5)
      expect(
        result.scope.cropBox.x + result.scope.cropBox.width,
      ).toBeLessThanOrEqual(0.9)
    }
  })

  it('keeps a caption-owned tabular line band in its proved column lane', () => {
    const cellLine = (
      id: string,
      text: string,
      x: number,
      y: number,
      width = 0.052,
    ): PdfRegionLine => {
      const sourceBox = box(x, y, width, 0.012)
      const sourceRun: PdfSourceRun = {
        ...sourceBox,
        text,
        fontName: 'TableSerif',
        fontSize: 8,
        confidence: 0.99,
      }
      return {
        id,
        text,
        fontSize: 8,
        box: sourceBox,
        runs: [sourceRun],
      }
    }
    const rowRegion = (rowIndex: number, y: number): PdfPageRegion => {
      const lines = [0.557, 0.681, 0.739, 0.792].map((x, cellIndex) =>
        cellLine(
          `table-row-${rowIndex}-cell-${cellIndex + 1}`,
          cellIndex === 0 ? `Model-${rowIndex}` : `${rowIndex}.${cellIndex}`,
          x,
          y,
          cellIndex === 0 ? 0.086 : 0.028,
        ),
      )
      return {
        ...textRegion(
          `table-row-${rowIndex}`,
          box(0.557, y, 0.263, 0.012),
          lines,
        ),
        column: 'right',
      }
    }
    const tableRows = Array.from({ length: 6 }, (_, index) =>
      rowRegion(index + 1, 0.52 + index * 0.019),
    )
    const chartLabels = [0.523, 0.561, 0.599].map((y, index) => {
      const sourceLine = cellLine(
        `chart-label-${index + 1}`,
        `${30 - index * 5}`,
        0.11,
        y,
        0.012,
      )
      return {
        ...textRegion(
          `chart-label-region-${index + 1}`,
          sourceLine.box,
          [sourceLine],
          'chart-label',
        ),
        column: 'left' as const,
      }
    })
    const tableCaption: PdfPageRegion = {
      ...caption(
        'caption-column-table',
        0.645,
        'Table 1. Caption-owned column results.',
      ),
      column: 'right',
      box: box(0.557, 0.645, 0.263, 0.02),
    }

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, ...chartLabels, ...tableRows],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        sourceRegionIds: tableRows.map((region) => region.id).sort(),
      },
    })
    expect(result.scope?.sourceRegionIds).not.toEqual(
      expect.arrayContaining(chartLabels.map((region) => region.id)),
    )
    expect(result.scope?.cropBox.x).toBeGreaterThanOrEqual(0.5)
    expect(
      result.scope!.cropBox.x + result.scope!.cropBox.width,
    ).toBeLessThanOrEqual(0.9)
  })

  it('uses a proved table seed column when neighboring chart labels have no global column assignment', () => {
    let sourceSequenceIndex = 0
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontSize = 8,
      height = 0.012,
      fontName = 'TableSerif',
      bold = false,
    ): PdfSourceRun => ({
      ...box(x, y, width, height),
      text,
      fontName,
      fontSize,
      confidence: 0.99,
      sourceSequenceIndex: sourceSequenceIndex++,
      ...(bold ? { bold: true } : {}),
    })
    const runs: PdfSourceRun[] = []
    for (let rowIndex = 0; rowIndex < 6; rowIndex += 1) {
      const y = 0.52 + rowIndex * 0.019
      if (rowIndex % 2 === 0) {
        runs.push(
          sourceRun(
            `${30 - rowIndex * 2}`,
            0.11,
            y,
            0.012,
            7,
            0.012,
            'ChartSans',
          ),
        )
      }
      for (const [cellIndex, x, width] of [
        [0, 0.557, 0.086],
        [1, 0.681, 0.028],
        [2, 0.739, 0.028],
        [3, 0.792, 0.028],
      ] as const) {
        runs.push(
          sourceRun(
            cellIndex === 0
              ? `Model-${rowIndex + 1}`
              : `${rowIndex + 1}.${cellIndex}`,
            x,
            y,
            width,
          ),
        )
      }
    }
    runs.push(
      sourceRun(
        'Figure 1. Independent chart panel.',
        0.09,
        0.49,
        0.31,
        8,
        0.011,
        'Body-Bold',
        true,
      ),
      sourceRun(
        'Table 1. Caption-owned results.',
        0.557,
        0.645,
        0.263,
        8,
        0.014,
        'Body-Bold',
        true,
      ),
    )
    const chartBox = box(0.07, 0.505, 0.4, 0.13, 'pdf-object')
    const chartObject: PdfNativeObject = {
      id: 'source-chart',
      page: 1,
      kind: 'vector',
      box: chartBox,
      confidence: 0.99,
      assetId: 'source-chart-asset',
    }
    const sourcePage: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce(
        (total, source) => total + source.text.length,
        0,
      ),
      imageCount: 0,
      objects: [chartObject],
      runs,
    }
    const reconstructed = reconstructPageRegions([sourcePage])
    const tableCaption = reconstructed.regions.find((region) =>
      region.text.startsWith('Table 1.'),
    )
    const tableRows = reconstructed.regions.filter((region) =>
      region.text.startsWith('Model-'),
    )
    const chartLabels = reconstructed.regions.filter(
      (region) => region.kind === 'chart-label',
    )

    expect(tableCaption).toBeDefined()
    expect(tableCaption?.column).toBe('single')
    expect(chartLabels).toHaveLength(3)
    expect(chartLabels.map((region) => region.column)).toEqual([
      'single',
      'single',
      'single',
    ])
    expect(tableRows).toHaveLength(6)
    expect(
      tableRows.every(
        (region) => region.column === 'right' && region.lines.length === 4,
      ),
    ).toBe(true)

    const result = resolvePdfTableScope({
      caption: tableCaption!,
      pageRegions: reconstructed.regions,
      nativeObjects: [chartObject],
    })
    const expectedSourceSequenceIndexes = [
      1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22,
      23, 24, 25, 26,
    ]

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-tabular-line-band',
        sourceRegionIds: tableRows.map((region) => region.id).sort(),
        cropBox: box(0.557, 0.52, 0.263, 0.107),
      },
    })
    expect(result.scope?.sourceRegionIds).not.toEqual(
      expect.arrayContaining(chartLabels.map((region) => region.id)),
    )
    expect(result.scope?.sourceLineIds).toHaveLength(24)

    const selectedSourceRuns = result.scope!.lineLineage.flatMap(
      (lineage) =>
        reconstructed.regions
          .find((region) => region.id === lineage.regionId)!
          .lines.find((sourceLine) => sourceLine.id === lineage.lineId)!.runs,
    )
    expect(
      selectedSourceRuns.map((source) => source.sourceSequenceIndex),
    ).toEqual(expectedSourceSequenceIndexes)
    for (const selectedSourceRun of selectedSourceRuns) {
      const original = runs.find(
        (source) =>
          source.sourceSequenceIndex === selectedSourceRun.sourceSequenceIndex,
      )
      expect(original).toBeDefined()
      expect(selectedSourceRun).toMatchObject({
        text: original!.text,
        x: original!.x,
        y: original!.y,
        width: original!.width,
        height: original!.height,
      })
    }
  })

  it('keeps a proved above-caption table across an internal font-family transition', () => {
    const sourceLines = Array.from({ length: 7 }, (_, index) => {
      const sourceBox = box(0.12, 0.15 + index * 0.018, 0.68, 0.012)
      return {
        id: `above-caption-mixed-font-row-${index + 1}`,
        text: `Metric ${index + 1}: source bounded value`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Metric ${index + 1}: source bounded value`,
            fontName: index < 4 ? 'TableHeaderSans' : 'TableBodySerif',
            fontSize: 8,
            confidence: 0.99,
            bold: index < 4,
          },
        ],
      } satisfies PdfRegionLine
    })
    const table = textRegion(
      'above-caption-mixed-font-table',
      box(0.12, 0.15, 0.68, 0.12),
      sourceLines,
    )
    const tableCaption = caption(
      'above-caption-mixed-font-caption',
      0.29,
      'Table 4. Bounded records with styled row groups.',
    )

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [table, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        direction: 'above',
        sourceRegionIds: [table.id],
        sourceLineIds: sourceLines.map((sourceLine) => sourceLine.id),
      },
    })
  })

  it('keeps a proved above-caption table across both sides of a composite source region', () => {
    const sourceLines = Array.from({ length: 8 }, (_, index) => {
      const sourceBox = box(
        index % 2 === 0 ? 0.08 : 0.52,
        0.15 + index * 0.02,
        0.36,
        0.012,
      )
      return {
        id: `above-caption-composite-row-${index + 1}`,
        text: `Metric ${index + 1}: source bounded value`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Metric ${index + 1}: source bounded value`,
            fontName: 'TableSerif-Bold',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
    })
    const table = {
      ...textRegion(
        'above-caption-composite-table',
        box(0.08, 0.15, 0.8, 0.152),
        sourceLines,
      ),
      column: 'left' as const,
    }
    const tableCaption = {
      ...caption(
        'above-caption-composite-caption',
        0.315,
        'Table 5. Full-width bounded records.',
      ),
      column: 'left' as const,
      box: box(0.08, 0.315, 0.38, 0.02),
    }

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [table, tableCaption],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        direction: 'above',
        sourceRegionIds: [table.id],
        sourceLineIds: sourceLines.map((sourceLine) => sourceLine.id),
      },
    })
  })
})
