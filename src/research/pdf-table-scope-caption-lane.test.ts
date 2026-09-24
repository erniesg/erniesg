import { describe, expect, it } from 'vitest'
import type {
  NormalizedSourceBox,
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

describe('PDF table caption-lane family', () => {
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
})
