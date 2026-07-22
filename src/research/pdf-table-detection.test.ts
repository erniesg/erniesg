import { describe, expect, it } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfRegionLine,
  PdfSourceRun,
} from './import-types'
import { detectTableNearCaption } from './pdf-table-detection'

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
      [
        line('header-main', 0.07, [0.1, 0.3]),
        line('header-continuation', 0.081, [0.32]),
      ],
      'span',
    )
    headerLead.box = box(0.1, 0.07, 0.34, 0.021)
    headerLead.lines[0].runs[0].text = 'Dataset'
    headerLead.lines[0].runs[1].text = 'Automatically'
    headerLead.lines[1].runs[0].text = 'Constructed?'
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
      headerTail,
      body,
      tableCaption,
    ])

    expect(detected).toMatchObject({
      direction: 'above',
      sourceRegions: expect.arrayContaining([
        expect.objectContaining({ id: headerLead.id }),
        expect.objectContaining({ id: headerTail.id }),
        expect.objectContaining({ id: body.id }),
      ]),
      headerEvidence: {
        kind: 'table-local-geometry',
        sourceRegionIds: [headerLead.id, headerTail.id],
      },
    })
    expect(detected?.lines).toHaveLength(4)
    expect(detected?.lines[0].runs).toHaveLength(4)
    expect(detected?.lines[0].runs[1].text).toContain('Automatically')
    expect(detected?.lines[0].runs[1].text).toContain('Constructed?')
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
})
