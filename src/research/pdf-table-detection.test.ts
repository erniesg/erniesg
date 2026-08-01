import { describe, expect, it } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfRegionLine,
  PdfSourceRun,
} from './import-types'
import {
  detectExplicitHeaderNumericTableWithinProvenScope,
  detectHierarchicalTableWithinProvenScope,
  detectRectangularTableWithinProvenScope,
  detectTableNearCaption,
  detectTableWithinProvenScope,
  detectUniformTableWithinProvenScope,
  detectWrappedCellTableWithinProvenScope,
  detectWrappedHeaderTableWithinProvenScope,
} from './pdf-table-detection'

function box(
  x: number,
  y: number,
  width = 0.39,
  height = 0.01,
): NormalizedSourceBox {
  return { page: 1, x, y, width, height, rotation: 0, method: 'pdf-text' }
}

function line(id: string, y: number, xs: number[]): PdfRegionLine {
  const runs = xs.map<PdfSourceRun>((x, index) => ({
    ...box(x, y, 0.04),
    text: `cell-${id}-${index}`,
    fontName: 'serif',
    fontSize: 8,
    confidence: 1,
  }))
  return {
    id,
    text: runs.map((run) => run.text).join(' '),
    fontSize: 8,
    box: box(xs[0], y),
    runs,
  }
}

function region(
  id: string,
  kind: PdfPageRegion['kind'],
  y: number,
  lines: PdfRegionLine[],
  column: PdfPageRegion['column'] = 'single',
): PdfPageRegion {
  return {
    id,
    page: 1,
    kind,
    column,
    text:
      kind === 'caption'
        ? `${id}. Caption.`
        : lines.map((item) => item.text).join(' '),
    confidence: 0.94,
    box: box(0.1, y),
    lines,
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

describe('bounded table region detection', () => {
  it('promotes a uniform source-proven grid with an explicit header', () => {
    const header = line('grid-header', 0.16, [0.1, 0.26, 0.42])
    header.runs = header.runs.map((run) => ({
      ...run,
      bold: true,
      fontName: 'serif-bold',
    }))
    const body = [
      line('grid-row-1', 0.19, [0.1, 0.26, 0.42]),
      line('grid-row-2', 0.22, [0.1, 0.26, 0.42]),
    ]
    const table = region('source-grid', 'body', 0.16, [header, ...body])
    const detected = detectUniformTableWithinProvenScope([table], {
      sourceRegionIds: [table.id],
      sourceLineIds: table.lines.map((sourceLine) => sourceLine.id),
      evidence: [{ code: 'repeated-row-bands' }],
    })

    expect(detected).toMatchObject({
      columnCount: 3,
      headerRowCount: 1,
      evidence: expect.arrayContaining([
        'general-source-grid-promoter',
        'complete-source-lineage',
      ]),
    })
    expect(detected?.lines).toHaveLength(3)
    expect(detected?.lines.every((row) => row.cells.length === 3)).toBe(true)
    expect(detected?.lines[0].cells.map((cell) => cell.run)).toEqual(
      header.runs,
    )
  })

  it('accepts partial source-region lineage when wrapped rows remain provable', () => {
    const header = line('partial-header', 0.1, [0.1, 0.3, 0.5])
    header.runs = header.runs.map((run) => ({
      ...run,
      bold: true,
      fontName: 'serif-bold',
    }))
    const bodyOne = line('partial-body-one', 0.13, [0.1, 0.3, 0.5])
    bodyOne.runs[1]!.text = 'first value'
    const bodyOneContinuation = line(
      'partial-body-one-continuation',
      0.145,
      [0.3],
    )
    bodyOneContinuation.runs[0]!.text = 'continued'
    const bodyTwo = line('partial-body-two', 0.18, [0.1, 0.3, 0.5])
    const bodyThree = line('partial-body-three', 0.21, [0.1, 0.3, 0.5])
    const excludedFromScope = line(
      'partial-region-unselected-line',
      0.25,
      [0.1],
    )
    const table = region('partial-source-region', 'body', 0.1, [
      header,
      bodyOne,
      bodyOneContinuation,
      bodyTwo,
      bodyThree,
      excludedFromScope,
    ])

    const detected = detectWrappedCellTableWithinProvenScope([table], {
      direction: 'above',
      sourceRegionIds: [table.id],
      sourceLineIds: [
        header.id,
        bodyOne.id,
        bodyOneContinuation.id,
        bodyTwo.id,
        bodyThree.id,
      ],
      evidence: [{ code: 'contiguous-single-anchor-slab' }],
    })

    expect(detected).not.toBeNull()
    expect(detected?.lines).toHaveLength(4)
    expect(detected?.lines[1].cells[1]?.run.text).toContain('continued')
    expect(detected?.sourceLineIds).toEqual([
      header.id,
      bodyOne.id,
      bodyOneContinuation.id,
      bodyTwo.id,
      bodyThree.id,
    ])
  })

  it('selects repeated columns above a numbered table caption', () => {
    const caption = region('Table 3', 'caption', 0.3, [])
    const table = region('table-grid', 'body', 0.16, [
      line('header', 0.16, [0.1, 0.22, 0.34]),
      line('row-1', 0.19, [0.1, 0.22, 0.34]),
      line('row-2', 0.22, [0.1, 0.22, 0.34]),
    ])

    expect(detectTableNearCaption(caption, [table, caption])).toMatchObject({
      direction: 'above',
      sourceRegions: [expect.objectContaining({ id: 'table-grid' })],
      lines: expect.arrayContaining([
        expect.objectContaining({ id: expect.any(String) }),
      ]),
    })
  })

  it('does not treat prose after a caption as table cells', () => {
    const caption = region('Table 5', 'caption', 0.7, [])
    const prose = region('prose', 'body', 0.72, [
      line('sentence-1', 0.72, [0.1]),
      line('sentence-2', 0.75, [0.1]),
    ])

    expect(detectTableNearCaption(caption, [caption, prose])).toBeNull()
  })

  it('excludes a nearby running page header from an otherwise complete local table grid', () => {
    const caption = region('Table 5', 'caption', 0.3, [])
    const runningHeader = region('running-paper-header', 'header', 0.14, [
      line('running-paper-header-line', 0.14, [0.1]),
    ])
    runningHeader.text = 'Paper title'
    runningHeader.lines[0].text = 'Paper title'
    runningHeader.lines[0].runs[0].text = 'Paper title'
    const table = region('table-grid', 'body', 0.16, [
      line('table-header', 0.16, [0.1, 0.22, 0.34]),
      line('row-1', 0.19, [0.1, 0.22, 0.34]),
      line('row-2', 0.22, [0.1, 0.22, 0.34]),
    ])

    expect(
      detectTableNearCaption(caption, [runningHeader, table, caption]),
    ).toMatchObject({
      direction: 'above',
      sourceRegions: [expect.objectContaining({ id: table.id })],
      sourceLineIds: table.lines.map((sourceLine) => sourceLine.id),
      headerEvidence: null,
    })
  })

  it('merges wrapped table rows with conservative source classifications', () => {
    const caption = region('Table 5', 'caption', 0.7, [])
    const left = region('left-cells', 'side', 0.54, [
      line('left-1', 0.54, [0.54, 0.65]),
      line('left-2', 0.6, [0.54, 0.65]),
      line('left-3', 0.66, [0.54, 0.65]),
    ])
    const right = region('right-cells', 'footnote', 0.54, [
      line('right-1', 0.54, [0.72, 0.8]),
      line('right-2', 0.6, [0.72, 0.8]),
      line('right-3', 0.66, [0.72, 0.8]),
    ])

    expect(
      detectTableNearCaption(caption, [left, right, caption]),
    ).toMatchObject({
      direction: 'above',
      sourceRegions: expect.arrayContaining([
        expect.objectContaining({ id: 'left-cells' }),
        expect.objectContaining({ id: 'right-cells' }),
      ]),
      lines: [
        expect.objectContaining({ runs: expect.any(Array) }),
        expect.objectContaining({ runs: expect.any(Array) }),
        expect.objectContaining({ runs: expect.any(Array) }),
      ],
    })
  })

  it('detects repeated columns when table cells contain multiple source runs', () => {
    const caption = region('Table 6', 'caption', 0.42, [])
    const table = region('multi-run-cells', 'body', 0.22, [
      line('header', 0.22, [0.1, 0.15, 0.34, 0.39, 0.62, 0.67]),
      line('row-1', 0.27, [0.1, 0.15, 0.34, 0.39, 0.62, 0.67]),
      line('row-2', 0.32, [0.1, 0.15, 0.34, 0.39, 0.62, 0.67]),
    ])

    expect(detectTableNearCaption(caption, [table, caption])).toMatchObject({
      direction: 'above',
      sourceRegions: [expect.objectContaining({ id: 'multi-run-cells' })],
      lines: [
        expect.objectContaining({ runs: expect.any(Array) }),
        expect.objectContaining({ runs: expect.any(Array) }),
        expect.objectContaining({ runs: expect.any(Array) }),
      ],
    })
  })

  it('detects compact repeated columns below the fixed cell-gap cap', () => {
    const caption = region('Table 7', 'caption', 0.38, [])
    const compactColumns = [0.1, 0.142, 0.191, 0.233, 0.282, 0.324]
    const table = region('compact-multi-run-cells', 'body', 0.2, [
      line('header', 0.2, compactColumns),
      line('row-1', 0.24, compactColumns),
      line('row-2', 0.28, compactColumns),
    ])

    const detected = detectTableNearCaption(caption, [table, caption])

    expect(detected).toMatchObject({
      direction: 'above',
      sourceRegions: [
        expect.objectContaining({ id: 'compact-multi-run-cells' }),
      ],
    })
    expect(detected?.lines).toHaveLength(3)
    expect(detected?.lines.every((item) => item.runs.length === 3)).toBe(true)
  })

  it('detects variable-width left-aligned cells only inside an independently proven scope', () => {
    const caption = region('Table 2', 'caption', 0.42, [], 'span')
    caption.box = box(0.2, 0.42, 0.6, 0.014)
    const anchors = [0.2, 0.4, 0.72]
    const widths = [
      [0.08, 0.06, 0.07],
      [0.09, 0.23, 0.05],
      [0.1, 0.18, 0.05],
      [0.11, 0.25, 0.05],
    ]
    const rows = widths.map((rowWidths, rowIndex) => {
      const sourceLine = line(
        `variable-width-row-${rowIndex + 1}`,
        0.24 + rowIndex * 0.035,
        anchors,
      )
      sourceLine.box = box(0.2, sourceLine.box.y, 0.57, 0.012)
      sourceLine.runs = sourceLine.runs.map((run, columnIndex) => ({
        ...run,
        width: rowWidths[columnIndex],
      }))
      return sourceLine
    })
    const table = region(
      'variable-width-left-aligned-table',
      'body',
      0.24,
      rows,
      'span',
    )
    table.box = box(0.2, 0.24, 0.57, 0.117)

    expect(detectTableNearCaption(caption, [table, caption])).toBeNull()
    expect(
      detectTableWithinProvenScope(caption, [table, caption], {
        direction: 'above',
        sourceRegionIds: [table.id],
        sourceLineIds: rows.map((row) => row.id),
        evidence: [],
      }),
    ).toBeNull()

    const detected = detectTableWithinProvenScope(caption, [table, caption], {
      direction: 'above',
      sourceRegionIds: [table.id],
      sourceLineIds: rows.map((row) => row.id),
      evidence: [{ code: 'supplemental-equation-cell-shard' }],
    })

    expect(detected).toMatchObject({
      direction: 'above',
      sourceRegions: [
        expect.objectContaining({ id: 'variable-width-left-aligned-table' }),
      ],
    })
    expect(detected?.lines).toHaveLength(4)
    expect(
      detected?.lines.every(
        (row) =>
          row.runs.length === anchors.length &&
          row.runs.every(
            (cell, columnIndex) =>
              Math.abs(cell.x - anchors[columnIndex]) < 0.001,
          ),
      ),
    ).toBe(true)
  })

  it('rejects one accidental compact gap without repeated row evidence', () => {
    const caption = region('Table 8', 'caption', 0.38, [])
    const prose = region('accidental-gap-prose', 'body', 0.2, [
      line('sentence-1', 0.2, [0.12, 0.163, 0.206]),
      line('sentence-2', 0.23, [0.12, 0.163, 0.206]),
      line('sentence-3', 0.26, [0.12, 0.163, 0.212]),
      line('sentence-4', 0.29, [0.12, 0.163, 0.206]),
    ])

    expect(detectTableNearCaption(caption, [prose, caption])).toBeNull()
  })

  it('joins both halves of a page-spanning table before a left caption', () => {
    const captionLine = line('caption', 0.3, [0.1])
    captionLine.fontSize = 10
    const caption = region('Table 1', 'caption', 0.3, [captionLine], 'left')
    const left = region(
      'left-half',
      'body',
      0.16,
      [
        line('left-header', 0.16, [0.1, 0.24]),
        line('left-row-1', 0.19, [0.1, 0.24]),
        line('left-row-2', 0.22, [0.1, 0.24]),
      ],
      'left',
    )
    const right = region(
      'right-half',
      'side',
      0.16,
      [
        line('right-header', 0.16, [0.56, 0.72]),
        line('right-row-1', 0.19, [0.56, 0.72]),
        line('right-row-2', 0.22, [0.56, 0.72]),
      ],
      'right',
    )

    expect(
      detectTableNearCaption(caption, [left, right, caption]),
    ).toMatchObject({
      direction: 'above',
      sourceRegions: expect.arrayContaining([
        expect.objectContaining({ id: 'left-half' }),
        expect.objectContaining({ id: 'right-half' }),
      ]),
    })
  })

  it('rejects a wide single-column prose block without table structure', () => {
    const captionLine = line('caption', 0.7, [0.3])
    captionLine.fontSize = 10
    const caption = {
      ...region('Table 1', 'caption', 0.7, [captionLine]),
      box: box(0.3, 0.7, 0.32, 0.014),
    }
    const lines = Array.from({ length: 7 }, (_, index) =>
      line(`source-${index + 1}`, 0.5 + index * 0.025, [0.12]),
    )
    const source = {
      ...region('single-column-source', 'body', 0.5, lines),
      box: box(0.1, 0.5, 0.72, 0.17),
    }

    expect(detectTableNearCaption(caption, [source, caption])).toBeNull()
  })

  it('rejects prose word runs that align but have no inter-column whitespace', () => {
    const caption = region('Table 2', 'caption', 0.35, [])
    const prose = region(
      'aligned-prose',
      'body',
      0.16,
      Array.from({ length: 5 }, (_, index) =>
        line(`sentence-${index + 1}`, 0.16 + index * 0.03, [0.12, 0.165, 0.21]),
      ),
    )

    expect(detectTableNearCaption(caption, [prose, caption])).toBeNull()
  })

  it('does not call an ordinary caption-width prose block a one-column table', () => {
    const caption = {
      ...region('Table 1', 'caption', 0.7, []),
      box: box(0.2, 0.7, 0.5, 0.014),
    }
    const lines = Array.from({ length: 7 }, (_, index) =>
      line(`prose-${index + 1}`, 0.5 + index * 0.025, [0.2]),
    )
    const prose = {
      ...region('prose-block', 'body', 0.5, lines),
      box: box(0.2, 0.5, 0.5, 0.16),
    }

    expect(detectTableNearCaption(caption, [prose, caption])).toBeNull()
  })

  it('retains a contiguous source-classified header and its wrapped cell text', () => {
    const headerLead = region(
      'header-lead',
      'header',
      0.07,
      [line('header-main', 0.07, [0.1, 0.3])],
      'span',
    )
    headerLead.box = box(0.1, 0.07, 0.34, 0.01)
    headerLead.lines[0].runs[0].text = 'Dataset'
    headerLead.lines[0].runs[1].text = 'Automatically'
    const headerContinuation = region(
      'header-continuation',
      'header',
      0.081,
      [line('header-continuation-line', 0.081, [0.32])],
      'span',
    )
    headerContinuation.box = box(0.32, 0.081, 0.04, 0.01)
    headerContinuation.lines[0].runs[0].text = 'Constructed?'
    const headerTail = region(
      'header-tail',
      'header',
      0.07,
      [line('header-tail-line', 0.07, [0.5, 0.7])],
      'right',
    )
    headerTail.box = box(0.5, 0.07, 0.24, 0.01)
    const body = region(
      'table-body',
      'body',
      0.1,
      [
        line('row-1', 0.1, [0.1, 0.3, 0.5, 0.7]),
        line('row-2', 0.12, [0.1, 0.3, 0.5, 0.7]),
        line('row-3', 0.14, [0.1, 0.3, 0.5, 0.7]),
      ],
      'span',
    )
    body.box = box(0.1, 0.1, 0.64, 0.05)
    const tableCaption = region('Table 1', 'caption', 0.17, [], 'left')
    tableCaption.box = box(0.1, 0.17, 0.7, 0.03)

    const detected = detectTableNearCaption(tableCaption, [
      headerLead,
      headerContinuation,
      headerTail,
      body,
      tableCaption,
    ])

    expect(detected).toMatchObject({
      direction: 'above',
      sourceRegions: expect.arrayContaining([
        expect.objectContaining({ id: headerLead.id }),
        expect.objectContaining({ id: headerContinuation.id }),
        expect.objectContaining({ id: headerTail.id }),
        expect.objectContaining({ id: body.id }),
      ]),
      headerEvidence: {
        kind: 'table-local-geometry',
        sourceRegionIds: [headerContinuation.id, headerLead.id, headerTail.id],
      },
    })
    expect(detected?.lines).toHaveLength(4)
    expect(detected?.lines[0].runs).toHaveLength(4)
    expect(detected?.lines[0].runs[1].text).toContain('Automatically')
    expect(detected?.lines[0].runs[1].text).toContain('Constructed?')
    expect(new Set(detected?.sourceRegions.map((source) => source.id))).toEqual(
      new Set([headerLead.id, headerContinuation.id, headerTail.id, body.id]),
    )
    expect(
      detected?.sourceLineIds.every(
        (lineId) =>
          detected.sourceRegions.reduce(
            (count, source) =>
              count + Number(source.lines.some((item) => item.id === lineId)),
            0,
          ) === 1,
      ),
    ).toBe(true)
    expect(detected?.lines[0].sourceCellBoxes?.[1]).toMatchObject({
      x: 0.3,
      y: 0.07,
      width: 0.06,
    })
    expect(detected?.lines[0].sourceCellBoxes?.[1].height).toBeCloseTo(0.021)
  })

  it('reconstructs a split styled header and atomic table rows', () => {
    const anchors = [0.203, 0.329, 0.426, 0.516, 0.612, 0.729]
    const styledRun = (text: string, x: number, width = 0.05) => ({
      ...box(x, 0.0866, width, 0.0107),
      text,
      fontName: 'NimbusRomNo9L-Medi',
      fontSize: 8.97,
      confidence: 0.99,
    })
    const headerLines: PdfRegionLine[] = [
      {
        id: 'header-left-line',
        text: 'Method',
        fontSize: 8.97,
        box: box(anchors[0], 0.0866, 0.05, 0.0107),
        runs: [styledRun('Method', anchors[0])],
      },
      {
        id: 'header-middle-line',
        text: 'Interesting Coherent',
        fontSize: 8.97,
        box: box(anchors[1] - 0.028, 0.0866, 0.174, 0.0107),
        runs: [
          styledRun('Interesting', anchors[1] - 0.028, 0.07),
          styledRun('Coherent', anchors[2] - 0.022, 0.06),
        ],
      },
      {
        id: 'header-right-line',
        text: 'Relevant Humanlike Misc. Problems',
        fontSize: 8.97,
        box: box(anchors[3] - 0.021, 0.0866, 0.303, 0.0107),
        runs: [
          styledRun('Relevant', anchors[3] - 0.021, 0.057),
          styledRun('Humanlike', anchors[4] - 0.029, 0.072),
          styledRun('Misc. Problems', anchors[5] - 0.042, 0.1),
        ],
      },
    ]
    const headerRegions = headerLines.map((sourceLine, index) => {
      const source = region(
        `styled-header-${index + 1}`,
        index === 2 ? 'spanning' : 'side',
        sourceLine.box.y,
        [sourceLine],
        'span',
      )
      source.box = sourceLine.box
      return source
    })
    const bodyRegions = [0.1052, 0.1179, 0.1365, 0.1491].flatMap(
      (y, rowIndex) =>
        anchors.map((x, columnIndex) => {
          const sourceLine = line(
            `atomic-${rowIndex + 1}-${columnIndex + 1}`,
            y,
            [x],
          )
          sourceLine.box = box(x, y, 0.04, 0.0107)
          sourceLine.runs[0] = {
            ...sourceLine.runs[0],
            ...sourceLine.box,
            text: `${rowIndex + 1}-${columnIndex + 1}`,
          }
          const source = region(
            `atomic-region-${rowIndex + 1}-${columnIndex + 1}`,
            columnIndex === 0 ? 'side' : 'body',
            y,
            [sourceLine],
            'span',
          )
          source.box = sourceLine.box
          return source
        }),
    )
    const tableCaption = region('Table 1', 'caption', 0.176, [], 'span')
    tableCaption.box = box(0.1185, 0.176, 0.7624, 0.047)

    const detected = detectTableNearCaption(tableCaption, [
      ...headerRegions,
      ...bodyRegions,
      tableCaption,
    ])

    expect(detected?.lines).toHaveLength(5)
    expect(detected?.lines.every((row) => row.runs.length === 6)).toBe(true)
    expect(detected?.sourceRegions).toHaveLength(27)
  })

  it('preserves source spacing while joining font-split small-cap runs inside one cell', () => {
    const caption = region('Table 11', 'caption', 0.3, [], 'span')
    const rows = [0.16, 0.19, 0.22].map((y, rowIndex) => {
      const sourceLine = line(`small-cap-row-${rowIndex}`, y, [0.1, 0.5])
      if (rowIndex === 2) {
        sourceLine.runs = [
          {
            ...sourceLine.runs[0],
            x: 0.1,
            width: 0.0072,
            text: 'S',
          },
          {
            ...sourceLine.runs[0],
            x: 0.10775,
            width: 0.0332,
            text: 'YNTHETIC',
          },
          {
            ...sourceLine.runs[0],
            x: 0.1442,
            width: 0.0078,
            text: 'P',
          },
          {
            ...sourceLine.runs[0],
            x: 0.15255,
            width: 0.0442,
            text: 'ROFILE',
          },
          sourceLine.runs[1],
        ]
        sourceLine.text = 'SYNTHETIC PROFILE cell'
      }
      return sourceLine
    })
    const table = region('small-cap-table', 'body', 0.16, rows, 'span')
    table.box = box(0.1, 0.16, 0.64, 0.07)

    const detected = detectTableNearCaption(caption, [table, caption])

    expect(detected?.lines[2].runs[0].text).toBe('SYNTHETIC PROFILE')
  })

  it('proves a two-tier header only when repeated numeric body rows close every source column', () => {
    const sourceLine = (
      id: string,
      y: number,
      cells: Array<{ text: string; x: number; width?: number }>,
    ): PdfRegionLine => {
      const runs = cells.map<PdfSourceRun>((cell) => ({
        ...box(cell.x, y, cell.width ?? 0.04),
        text: cell.text,
        fontName: 'TableSerif',
        fontSize: 8,
        confidence: 1,
      }))
      return {
        id,
        text: runs.map((run) => run.text).join(' '),
        fontSize: 8,
        box: box(
          runs[0].x,
          y,
          Math.max(...runs.map((run) => run.x + run.width)) - runs[0].x,
        ),
        runs,
      }
    }
    const lines = [
      sourceLine('group-header', 0.2, [
        { text: 'Methods', x: 0.1, width: 0.08 },
        { text: 'Auto Evaluation', x: 0.37, width: 0.1 },
        { text: 'Human Evaluation', x: 0.62, width: 0.1 },
      ]),
      sourceLine(
        'leaf-header',
        0.23,
        ['Words', 'Conflict', 'Entropy', 'Plot', 'Coherence'].map(
          (text, index) => ({ text, x: 0.3 + index * 0.1 }),
        ),
      ),
      ...[0.26, 0.29, 0.32].map((y, rowIndex) =>
        sourceLine(`body-${rowIndex + 1}`, y, [
          { text: ['Baseline', 'Ablation', 'Ours'][rowIndex], x: 0.1 },
          ...Array.from({ length: 5 }, (_, columnIndex) => ({
            text: `${rowIndex + 1}.${columnIndex + 1}`,
            x: 0.3 + columnIndex * 0.1,
          })),
        ]),
      ),
    ]
    const table = region('hierarchical-table', 'body', 0.2, lines, 'span')
    table.box = box(0.1, 0.2, 0.64, 0.13)
    const scope = {
      direction: 'below' as const,
      sourceRegionIds: [table.id],
      sourceLineIds: lines.map((sourceLine) => sourceLine.id),
      evidence: [{ code: 'contiguous-tabular-slab' }],
    }

    const detected = detectHierarchicalTableWithinProvenScope([table], scope)

    expect(detected).toMatchObject({
      columnCount: 6,
      headerRowCount: 2,
      evidence: expect.arrayContaining([
        'semantic-header-hierarchical-geometry',
        'repeated-uniform-numeric-body-rows',
      ]),
    })
    expect(detected?.lines[0].cells).toMatchObject([
      { columnIndex: 0, columnSpan: 1, rowSpan: 2 },
      { columnIndex: 1, columnSpan: 3, rowSpan: 1 },
      { columnIndex: 4, columnSpan: 2, rowSpan: 1 },
    ])
  })

  it('proves one explicit header over a complete numeric matrix with a variable-width stub', () => {
    const sourceLine = (
      id: string,
      y: number,
      cells: Array<{ text: string; x: number; width?: number }>,
    ): PdfRegionLine => {
      const runs = cells.map<PdfSourceRun>((cell) => ({
        ...box(cell.x, y, cell.width ?? 0.04),
        text: cell.text,
        fontName: 'PlainTableSerif',
        fontSize: 8,
        confidence: 1,
      }))
      return {
        id,
        text: runs.map((run) => run.text).join(' '),
        fontSize: 8,
        box: box(
          runs[0].x,
          y,
          Math.max(...runs.map((run) => run.x + run.width)) - runs[0].x,
        ),
        runs,
      }
    }
    const lines = [
      sourceLine('header', 0.2, [
        { text: 'Method', x: 0.1, width: 0.06 },
        { text: 'Score', x: 0.4, width: 0.05 },
        { text: 'Error', x: 0.61, width: 0.05 },
      ]),
      sourceLine('body-1', 0.23, [
        { text: 'A', x: 0.1, width: 0.02 },
        { text: '5.856', x: 0.4, width: 0.05 },
        { text: '0.395', x: 0.61, width: 0.05 },
      ]),
      sourceLine('body-2', 0.26, [
        { text: 'Long baseline name', x: 0.1, width: 0.18 },
        { text: '5.711', x: 0.4, width: 0.05 },
        { text: '0.402', x: 0.61, width: 0.05 },
      ]),
      sourceLine('body-3', 0.29, [
        { text: 'Medium method', x: 0.1, width: 0.11 },
        { text: '5.562', x: 0.4, width: 0.05 },
        { text: '0.389', x: 0.61, width: 0.05 },
      ]),
    ]
    const table = region('explicit-matrix', 'body', 0.2, lines, 'span')

    const detected = detectExplicitHeaderNumericTableWithinProvenScope(
      [table],
      {
        direction: 'below',
        sourceRegionIds: [table.id],
        sourceLineIds: lines.map((sourceLine) => sourceLine.id),
        evidence: [
          { code: 'repeated-row-bands' },
          { code: 'multi-run-tabular-line-band' },
        ],
      },
    )

    expect(detected).toMatchObject({
      columnCount: 3,
      headerRowCount: 1,
      evidence: expect.arrayContaining([
        'semantic-header-explicit-matrix-geometry',
        'repeated-uniform-numeric-body-rows',
        'variable-width-stub-left-anchor',
      ]),
    })
    expect(detected?.lines).toHaveLength(4)
    expect(
      detected?.lines.every((sourceRow) =>
        sourceRow.cells.every(
          (cell) => cell.columnSpan === 1 && cell.rowSpan === 1,
        ),
      ),
    ).toBe(true)
  })

  it('accepts compact scientific notation without altering the source cell text', () => {
    const header = line('header', 0.2, [0.1, 0.4, 0.61])
    ;['Model', 'MSE', 'QLIKE'].forEach((text, index) => {
      header.runs[index].text = text
    })
    header.text = header.runs.map((run) => run.text).join(' ')
    const body = [0.23, 0.26, 0.29].map((y, rowIndex) => {
      const sourceLine = line(`body-${rowIndex + 1}`, y, [0.1, 0.4, 0.61])
      sourceLine.runs[0] = {
        ...sourceLine.runs[0],
        width: 0.12 + rowIndex * 0.03,
        text: `Method ${rowIndex + 1}`,
      }
      sourceLine.runs[1].text = `${rowIndex + 1}.25`
      sourceLine.runs[2].text = `${rowIndex + 1}.7×10${rowIndex + 3}`
      sourceLine.text = sourceLine.runs.map((run) => run.text).join(' ')
      return sourceLine
    })
    const table = region(
      'scientific-matrix',
      'body',
      0.2,
      [header, ...body],
      'span',
    )

    const detected = detectExplicitHeaderNumericTableWithinProvenScope(
      [table],
      {
        direction: 'below',
        sourceRegionIds: [table.id],
        sourceLineIds: table.lines.map((sourceLine) => sourceLine.id),
        evidence: [
          { code: 'repeated-row-bands' },
          { code: 'multi-run-tabular-line-band' },
        ],
      },
    )

    expect(detected?.lines[1].cells[2]).toMatchObject({
      run: expect.objectContaining({ text: '1.7×103' }),
      columnIndex: 2,
      columnSpan: 1,
      rowSpan: 1,
    })
  })

  it('promotes a proved rectangular table with mixed source text', () => {
    const lines = [
      line('header', 0.2, [0.1, 0.35, 0.62]),
      line('body-1', 0.23, [0.1, 0.35, 0.62]),
      line('body-2', 0.26, [0.1, 0.35, 0.62]),
      line('body-3', 0.29, [0.1, 0.35, 0.62]),
    ]
    ;['Model', 'Environment', 'Result'].forEach((text, index) => {
      lines[0].runs[index] = {
        ...lines[0].runs[index],
        text,
        fontName: 'TableSerif-Medium',
      }
    })
    ;[
      ['BookWorld', 'Castle', 'Characters interact'],
      ['Baseline', 'Village', 'No interaction'],
      ['Ablation', 'Harbor', 'Interaction delayed'],
    ].forEach((texts, rowIndex) => {
      texts.forEach((text, columnIndex) => {
        lines[rowIndex + 1].runs[columnIndex] = {
          ...lines[rowIndex + 1].runs[columnIndex],
          text,
          width: columnIndex === 2 ? 0.12 : 0.08,
        }
      })
    })
    for (const sourceLine of lines) {
      sourceLine.text = sourceLine.runs.map((run) => run.text).join(' ')
    }
    const table = region('mixed-text-table', 'body', 0.2, lines, 'span')

    const detected = detectRectangularTableWithinProvenScope([table], {
      direction: 'above',
      sourceRegionIds: [table.id],
      sourceLineIds: lines.map((sourceLine) => sourceLine.id),
      evidence: [
        { code: 'repeated-row-bands' },
        { code: 'repeated-column-anchors' },
      ],
    })

    expect(detected).toMatchObject({
      columnCount: 3,
      headerRowCount: 1,
      evidence: expect.arrayContaining([
        'complete-bounded-table-scope',
        'repeated-rectangular-column-geometry',
        'source-typography-header',
      ]),
    })
    expect(detected?.lines[1].cells[2].run.text).toBe('Characters interact')
  })

  it('keeps a rectangular text slab as fallback without header proof', () => {
    const lines = [
      line('row-1', 0.2, [0.1, 0.35, 0.62]),
      line('row-2', 0.23, [0.1, 0.35, 0.62]),
      line('row-3', 0.26, [0.1, 0.35, 0.62]),
    ]
    const table = region('unproved-header-table', 'body', 0.2, lines, 'span')

    expect(
      detectRectangularTableWithinProvenScope([table], {
        direction: 'above',
        sourceRegionIds: [table.id],
        sourceLineIds: lines.map((sourceLine) => sourceLine.id),
        evidence: [
          { code: 'repeated-row-bands' },
          { code: 'repeated-column-anchors' },
        ],
      }),
    ).toBeNull()
  })

  it.each([
    {
      name: 'an implicit blank stub header',
      headerXs: [0.4, 0.61],
      headerTexts: ['Score', 'Error'],
      bodyRows: 3,
      evidence: [
        { code: 'repeated-row-bands' },
        { code: 'multi-run-tabular-line-band' },
      ],
    },
    {
      name: 'a section row in the numeric body',
      headerXs: [0.1, 0.4, 0.61],
      headerTexts: ['Method', 'Score', 'Error'],
      bodyRows: 3,
      sectionRow: true,
      evidence: [
        { code: 'repeated-row-bands' },
        { code: 'multi-run-tabular-line-band' },
      ],
    },
    {
      name: 'a scope without text-line-band proof',
      headerXs: [0.1, 0.4, 0.61],
      headerTexts: ['Method', 'Score', 'Error'],
      bodyRows: 3,
      evidence: [{ code: 'repeated-row-bands' }],
    },
    {
      name: 'fewer than three complete body rows',
      headerXs: [0.1, 0.4, 0.61],
      headerTexts: ['Method', 'Score', 'Error'],
      bodyRows: 2,
      evidence: [
        { code: 'repeated-row-bands' },
        { code: 'multi-run-tabular-line-band' },
      ],
    },
    {
      name: 'a nonnumeric body value',
      headerXs: [0.1, 0.4, 0.61],
      headerTexts: ['Method', 'Score', 'Error'],
      bodyRows: 3,
      nonnumericBody: true,
      evidence: [
        { code: 'repeated-row-bands' },
        { code: 'multi-run-tabular-line-band' },
      ],
    },
    {
      name: 'a numeric-looking scientific header',
      headerXs: [0.1, 0.4, 0.61],
      headerTexts: ['Method', '1e3', 'Error'],
      bodyRows: 3,
      evidence: [
        { code: 'repeated-row-bands' },
        { code: 'multi-run-tabular-line-band' },
      ],
    },
  ])('rejects $name', (fixture) => {
    const header = line('header', 0.2, fixture.headerXs)
    fixture.headerTexts.forEach((text, index) => {
      header.runs[index].text = text
    })
    header.text = header.runs.map((run) => run.text).join(' ')
    const body = Array.from({ length: fixture.bodyRows }, (_, rowIndex) => {
      const sourceLine = line(
        `body-${rowIndex + 1}`,
        0.23 + rowIndex * 0.03,
        fixture.sectionRow && rowIndex === 1 ? [0.1] : [0.1, 0.4, 0.61],
      )
      sourceLine.runs.forEach((run, columnIndex) => {
        run.text =
          columnIndex === 0
            ? fixture.sectionRow && rowIndex === 1
              ? 'Held-out section'
              : `Method ${rowIndex + 1}`
            : fixture.nonnumericBody && rowIndex === 1 && columnIndex === 1
              ? 'not measured'
              : `${rowIndex + 1}.${columnIndex}`
      })
      sourceLine.text = sourceLine.runs.map((run) => run.text).join(' ')
      return sourceLine
    })
    const table = region(
      `rejected-${fixture.name}`,
      'body',
      0.2,
      [header, ...body],
      'span',
    )

    expect(
      detectExplicitHeaderNumericTableWithinProvenScope([table], {
        direction: 'below',
        sourceRegionIds: [table.id],
        sourceLineIds: table.lines.map((sourceLine) => sourceLine.id),
        evidence: fixture.evidence,
      }),
    ).toBeNull()
  })

  it('keeps wrapped header continuations as exact semantic header cells', () => {
    const header = line('header', 0.2, [0.1, 0.22, 0.34, 0.46, 0.58, 0.7])
    ;['Split', 'Not Check-', 'Check-', 'True', 'False', 'Total'].forEach(
      (text, index) => {
        header.runs[index].text = text
      },
    )
    header.text = header.runs.map((run) => run.text).join(' ')
    const continuation = line(
      'header-continuation',
      0.23,
      [0.22, 0.34, 0.46, 0.58],
    )
    ;['worthy', 'worthy', 'Claims', 'Claims'].forEach((text, index) => {
      continuation.runs[index].text = text
    })
    continuation.text = continuation.runs.map((run) => run.text).join(' ')
    const body = ['Train', 'Dev', 'Test'].map((label, rowIndex) => {
      const sourceLine = line(
        `body-${rowIndex + 1}`,
        0.26 + rowIndex * 0.03,
        [0.1, 0.22, 0.34, 0.46, 0.58, 0.7],
      )
      sourceLine.runs.forEach((run, columnIndex) => {
        run.text =
          columnIndex === 0 ? label : String((rowIndex + 1) * 10 + columnIndex)
      })
      sourceLine.text = sourceLine.runs.map((run) => run.text).join(' ')
      return sourceLine
    })
    const table = region(
      'wrapped-header-table',
      'body',
      0.2,
      [header, continuation, ...body],
      'span',
    )
    const detected = detectWrappedHeaderTableWithinProvenScope([table], {
      direction: 'below',
      sourceRegionIds: [table.id],
      sourceLineIds: table.lines.map((sourceLine) => sourceLine.id),
      evidence: [
        { code: 'repeated-row-bands' },
        { code: 'repeated-column-anchors' },
      ],
    })

    expect(detected).toMatchObject({
      columnCount: 6,
      headerRowCount: 2,
      evidence: expect.arrayContaining(['semantic-header-wrapped-geometry']),
    })
    expect(detected?.lines[0].cells).toMatchObject([
      { columnIndex: 0, rowSpan: 2 },
      { columnIndex: 1, rowSpan: 1 },
      { columnIndex: 2, rowSpan: 1 },
      { columnIndex: 3, rowSpan: 1 },
      { columnIndex: 4, rowSpan: 1 },
      { columnIndex: 5, rowSpan: 2 },
    ])
    expect(detected?.lines[1].cells.map((cell) => cell.columnIndex)).toEqual([
      1, 2, 3, 4,
    ])
  })

  it('folds source-backed body continuations into their owning table row', () => {
    const header = line('wrapped-body-header', 0.2, [0.1, 0.3, 0.5, 0.7])
    ;['Reference', 'Environment', 'NPC', 'Outcome'].forEach((text, index) => {
      header.runs[index].text = text
      header.runs[index].fontName = 'Table-Bold'
      header.runs[index].bold = true
    })
    header.text = header.runs.map((run) => run.text).join(' ')

    const bodyLine = (
      id: string,
      y: number,
      values: string[],
      xs = [0.1, 0.3, 0.5, 0.7],
    ) => {
      const sourceLine = line(id, y, xs)
      sourceLine.runs.forEach((run, index) => {
        run.text = values[index]
      })
      sourceLine.text = sourceLine.runs.map((run) => run.text).join(' ')
      return sourceLine
    }
    const body1 = bodyLine('wrapped-body-1', 0.24, [
      'A',
      'The environment begins',
      'the NPC waits',
      'The action resolves',
    ])
    const body1Continuation = bodyLine(
      'wrapped-body-1-continuation',
      0.26,
      ['and the light changes', 'before the door opens'],
      [0.3, 0.5],
    )
    const body2 = bodyLine('wrapped-body-2', 0.3, [
      'B',
      'A second environment',
      'a second NPC',
      'A second outcome',
    ])
    const body3 = bodyLine('wrapped-body-3', 0.36, [
      'C',
      'A third environment',
      'a third NPC',
      'A third outcome',
    ])
    const body4 = bodyLine('wrapped-body-4', 0.42, [
      'D',
      'A fourth environment',
      'a fourth NPC',
      'A fourth outcome',
    ])
    const table = region(
      'wrapped-body-table',
      'body',
      0.2,
      [header, body1, body1Continuation, body2, body3, body4],
      'span',
    )

    const detected = detectWrappedCellTableWithinProvenScope([table], {
      direction: 'below',
      sourceRegionIds: [table.id],
      sourceLineIds: table.lines.map((sourceLine) => sourceLine.id),
      evidence: [
        { code: 'repeated-row-bands' },
        { code: 'repeated-column-anchors' },
      ],
    })

    expect(detected).toMatchObject({
      columnCount: 4,
      headerRowCount: 1,
      evidence: expect.arrayContaining(['semantic-body-continuation-geometry']),
    })
    expect(detected?.lines).toHaveLength(5)
    expect(detected?.lines[1].sourceLineIds).toEqual([
      body1.id,
      body1Continuation.id,
    ])
    expect(detected?.lines[1].cells.map((cell) => cell.run.text)).toEqual([
      'A',
      'The environment begins and the light changes',
      'the NPC waits before the door opens',
      'The action resolves',
    ])
  })

  it('rejects a sparse wide section row instead of attaching it to a body cell', () => {
    const header = line('section-header', 0.2, [0.1, 0.3, 0.5, 0.7])
    ;['Reference', 'Environment', 'NPC', 'Outcome'].forEach((text, index) => {
      header.runs[index].text = text
      header.runs[index].fontName = 'Table-Bold'
      header.runs[index].bold = true
    })
    header.text = header.runs.map((run) => run.text).join(' ')
    const complete = (id: string, y: number) => {
      const sourceLine = line(id, y, [0.1, 0.3, 0.5, 0.7])
      sourceLine.runs.forEach((run, index) => {
        run.text = `${id}-${index}`
      })
      sourceLine.text = sourceLine.runs.map((run) => run.text).join(' ')
      return sourceLine
    }
    const section = line('section-row', 0.27, [0.1])
    section.runs[0].text = 'Environment and NPC responses'
    section.runs[0].width = 0.7
    section.text = section.runs[0].text
    const table = region(
      'section-row-table',
      'body',
      0.2,
      [
        header,
        complete('section-body-1', 0.24),
        section,
        complete('section-body-2', 0.32),
        complete('section-body-3', 0.38),
        complete('section-body-4', 0.44),
      ],
      'span',
    )

    expect(
      detectWrappedCellTableWithinProvenScope([table], {
        direction: 'below',
        sourceRegionIds: [table.id],
        sourceLineIds: table.lines.map((sourceLine) => sourceLine.id),
        evidence: [
          { code: 'repeated-row-bands' },
          { code: 'repeated-column-anchors' },
        ],
      }),
    ).toBeNull()
  })

  it('does not split one merged PDF run into invented hierarchical header cells', () => {
    const mergedHeader = line('merged-header', 0.2, [0.1, 0.3])
    mergedHeader.runs[0].text = 'LLM'
    mergedHeader.runs[1] = {
      ...mergedHeader.runs[1],
      width: 0.44,
      text: 'Nodes Relations Quadruples API calls',
    }
    mergedHeader.text = mergedHeader.runs.map((run) => run.text).join(' ')
    const bodyLines = [0.23, 0.26, 0.29].map((y, rowIndex) => {
      const body = line(
        `merged-body-${rowIndex + 1}`,
        y,
        [0.1, 0.3, 0.4, 0.5, 0.6],
      )
      body.runs[0].text = `Model ${rowIndex + 1}`
      body.runs.slice(1).forEach((run, columnIndex) => {
        run.text = `${rowIndex + 1}.${columnIndex + 1}`
      })
      body.text = body.runs.map((run) => run.text).join(' ')
      return body
    })
    const table = region(
      'merged-header-table',
      'body',
      0.2,
      [mergedHeader, ...bodyLines],
      'span',
    )

    expect(
      detectHierarchicalTableWithinProvenScope([table], {
        direction: 'above',
        sourceRegionIds: [table.id],
        sourceLineIds: table.lines.map((sourceLine) => sourceLine.id),
        evidence: [{ code: 'multi-run-tabular-line-band' }],
      }),
    ).toBeNull()
  })
})
