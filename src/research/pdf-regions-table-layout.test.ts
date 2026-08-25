import { describe, expect, it } from 'vitest'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { reconstructPageRegions } from './pdf-regions'

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
  height = 0.018,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text',
    fontName: fontSize > 12 ? 'Heading' : 'Body',
    fontSize,
    confidence: 1,
  }
}

function page(
  number: number,
  runs: PdfSourceRun[],
  objects: NonNullable<PdfPageAnalysis['objects']> = [],
): PdfPageAnalysis {
  return {
    page: number,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: objects.length,
    objects,
    runs,
  }
}

async function reconstruct(pages: PdfPageAnalysis[], hash = '7') {
  return reconstructPageAnalyses({
    pages,
    sourceHash: hash.repeat(64),
    fileName: 'regions.pdf',
    byteLength: 4096,
  })
}

describe('deterministic scholarly page regions', () => {
  it('segments one-column flow without inventing a column boundary', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'One column title', 0.1, 0.12, 0.72, 18),
        run(1, 'First body line.', 0.1, 0.24, 0.72),
        run(1, 'Second body line.', 0.1, 0.28, 0.72),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => region.includedInReadingOrder)
        .every((region) => region.column === 'single'),
    ).toBe(true)
    expect(result.readingOrder).toMatchObject({ acyclic: true })
    expect(result.readingOrder.evaluation).toMatchObject({
      mode: 'deterministic-only',
      unresolvedEdgeCount: 0,
      cycleRate: 0,
      reviewRequired: false,
    })
  })

  it('ignores a dense full-width table grid when proving genuine page columns', () => {
    const tableRows = [
      ['Model', 'Method', 'Score A', 'Score B'],
      ['alpha', 'direct', '75.3', '84.1'],
      ['beta', 'guided', '65.2', '91.3'],
      ['gamma', 'direct', '87.0', '95.7'],
      ['delta', 'guided', '73.9', '82.6'],
    ]
    const tableRuns = tableRows.flatMap((row, rowIndex) =>
      row.map((text, columnIndex) =>
        run(
          1,
          text,
          [0.06, 0.26, 0.46, 0.75][columnIndex],
          0.16 + rowIndex * 0.028,
          [0.1, 0.1, 0.1, 0.15][columnIndex],
          9,
          0.012,
        ),
      ),
    )

    const tableOnly = reconstructPageRegions([page(1, tableRuns)])
    const tableOnlyRows = tableOnly.regions.filter(
      (region) => region.kind === 'body',
    )
    expect(tableOnlyRows).toHaveLength(tableRows.length)
    expect(tableOnlyRows.every((region) => region.column === 'single')).toBe(
      true,
    )
    expect(tableOnlyRows.map((region) => region.text)).toContain(
      'Model Method Score A Score B',
    )

    const mixed = reconstructPageRegions([
      page(1, [
        ...tableRuns,
        run(1, 'Left column establishes genuine prose.', 0.08, 0.48, 0.36),
        run(1, 'Right column establishes genuine prose.', 0.56, 0.48, 0.36),
        run(1, 'Left column continues independently.', 0.08, 0.52, 0.36),
        run(1, 'Right column continues independently.', 0.56, 0.52, 0.36),
        run(1, 'Left column reaches its conclusion.', 0.08, 0.56, 0.36),
        run(1, 'Right column reaches its conclusion.', 0.56, 0.56, 0.36),
      ]),
    ])
    expect(
      mixed.regions.find((region) =>
        region.text.includes('Left column establishes genuine prose.'),
      ),
    ).toMatchObject({ column: 'left' })
    expect(
      mixed.regions.find((region) =>
        region.text.includes('Right column establishes genuine prose.'),
      ),
    ).toMatchObject({ column: 'right' })
    expect(
      mixed.regions.find(
        (region) => region.text === 'Model Method Score A Score B',
      ),
    ).toMatchObject({ kind: 'spanning', column: 'span' })
    expect(mixed.readingOrder.evaluation.reviewRequired).toBe(false)
  })

  it('keeps a dense one-column table row separate from parallel prose using exact source runs', () => {
    const prose = Array.from({ length: 4 }, (_, rowIndex) =>
      run(
        1,
        `Left prose row ${rowIndex + 1} remains outside the table.`,
        0.088,
        0.3 + rowIndex * 0.028,
        0.394,
        9,
        0.011,
      ),
    )
    const tableRows = Array.from({ length: 4 }, (_, rowIndex) => {
      const y = 0.3 + rowIndex * 0.028
      return [
        run(1, `Model-${rowIndex + 1}`, 0.528, y, 0.112, 9, 0.011),
        run(1, `0.${rowIndex + 1}01`, 0.688, y, 0.031, 9, 0.011),
        run(1, `0.${rowIndex + 1}02`, 0.751, y, 0.031, 9, 0.011),
        run(1, `0.${rowIndex + 1}03`, 0.813, y, 0.031, 9, 0.011),
        run(1, `0.${rowIndex + 1}04`, 0.875, y, 0.031, 9, 0.011),
      ]
    }).flat()
    const result = reconstructPageRegions([
      page(1, [
        ...prose,
        ...tableRows,
        run(1, 'Left column continues after the table.', 0.088, 0.48, 0.394),
        run(1, 'Right column continues after the table.', 0.528, 0.48, 0.378),
        run(1, 'Left column reaches its conclusion.', 0.088, 0.52, 0.394),
        run(1, 'Right column reaches its conclusion.', 0.528, 0.52, 0.378),
      ]),
    ])

    for (let rowIndex = 0; rowIndex < 4; rowIndex += 1) {
      const expectedTexts = [
        `Model-${rowIndex + 1}`,
        `0.${rowIndex + 1}01`,
        `0.${rowIndex + 1}02`,
        `0.${rowIndex + 1}03`,
        `0.${rowIndex + 1}04`,
      ]
      const tableRegion = result.regions.find(
        (region) => region.text === expectedTexts.join(' '),
      )
      expect(tableRegion).toMatchObject({
        kind: 'body',
        column: 'right',
      })
      expect(
        tableRegion?.lines.flatMap((line) =>
          line.runs.map((sourceRun) => sourceRun.text),
        ),
      ).toEqual(expectedTexts)
      expect(tableRegion?.text).not.toContain(`Left prose row ${rowIndex + 1}`)
    }
    expect(
      result.regions.find((region) =>
        region.text.includes('Left prose row 1 remains outside the table.'),
      ),
    ).toMatchObject({ kind: 'body', column: 'left' })
    const leftIds = result.regions
      .filter(
        (region) => region.includedInReadingOrder && region.column === 'left',
      )
      .map((region) => region.id)
    const rightIds = result.regions
      .filter(
        (region) => region.includedInReadingOrder && region.column === 'right',
      )
      .map((region) => region.id)
    expect(
      Math.max(
        ...leftIds.map((regionId) =>
          result.readingOrder.order.indexOf(regionId),
        ),
      ),
    ).toBeLessThan(
      Math.min(
        ...rightIds.map((regionId) =>
          result.readingOrder.order.indexOf(regionId),
        ),
      ),
    )
    expect(
      result.readingOrder.edges.some((edge) =>
        edge.evidence.some((evidence) => evidence.code === 'column-flow'),
      ),
    ).toBe(true)
    expect(result.readingOrder.evaluation.reviewRequired).toBe(false)
  })

  it('retains a proved table lane when no prose establishes a global column split', () => {
    const tableRows = Array.from({ length: 4 }, (_, rowIndex) => {
      const y = 0.3 + rowIndex * 0.028
      return [
        run(1, `Model-${rowIndex + 1}`, 0.528, y, 0.112, 9, 0.011),
        run(1, `0.${rowIndex + 1}01`, 0.688, y, 0.031, 9, 0.011),
        run(1, `0.${rowIndex + 1}02`, 0.751, y, 0.031, 9, 0.011),
        run(1, `0.${rowIndex + 1}03`, 0.813, y, 0.031, 9, 0.011),
        run(1, `0.${rowIndex + 1}04`, 0.875, y, 0.031, 9, 0.011),
      ]
    }).flat()
    const result = reconstructPageRegions([
      page(1, [
        run(
          1,
          'Figure 1. Independent chart in the opposite lane.',
          0.09,
          0.3,
          0.37,
          8,
          0.011,
        ),
        ...tableRows,
      ]),
    ])

    for (let rowIndex = 0; rowIndex < 4; rowIndex += 1) {
      const tableRegion = result.regions.find((region) =>
        region.text.startsWith(`Model-${rowIndex + 1} `),
      )
      expect(tableRegion).toMatchObject({
        kind: 'body',
        column: 'right',
      })
      expect(tableRegion?.text).not.toContain('Independent chart')
    }
    expect(
      result.regions.find((region) =>
        region.text.includes('Independent chart in the opposite lane.'),
      ),
    ).toMatchObject({ kind: 'caption', column: 'single' })
  })

  it('keeps a mirrored dense left-column numeric matrix separate from right prose', () => {
    const tableRows = Array.from({ length: 4 }, (_, rowIndex) => {
      const y = 0.3 + rowIndex * 0.028
      return [
        run(1, `Method-${rowIndex + 1}`, 0.09, y, 0.1, 9, 0.011),
        run(1, `${rowIndex + 1}.01`, 0.23, y, 0.03, 9, 0.011),
        run(1, `${rowIndex + 1}.02`, 0.3, y, 0.03, 9, 0.011),
        run(1, `${rowIndex + 1}.03`, 0.37, y, 0.03, 9, 0.011),
        run(1, `${rowIndex + 1}.04`, 0.44, y, 0.03, 9, 0.011),
      ]
    }).flat()
    const prose = Array.from({ length: 4 }, (_, rowIndex) =>
      run(
        1,
        `Right prose row ${rowIndex + 1} remains outside the table.`,
        0.53,
        0.3 + rowIndex * 0.028,
        0.38,
        9,
        0.011,
      ),
    )
    const result = reconstructPageRegions([
      page(1, [
        ...tableRows,
        ...prose,
        run(1, 'Left column continues after the table.', 0.09, 0.48, 0.38),
        run(1, 'Right column continues after the table.', 0.53, 0.48, 0.38),
        run(1, 'Left column reaches its conclusion.', 0.09, 0.52, 0.38),
        run(1, 'Right column reaches its conclusion.', 0.53, 0.52, 0.38),
      ]),
    ])

    for (let rowIndex = 0; rowIndex < 4; rowIndex += 1) {
      const expectedTexts = [
        `Method-${rowIndex + 1}`,
        `${rowIndex + 1}.01`,
        `${rowIndex + 1}.02`,
        `${rowIndex + 1}.03`,
        `${rowIndex + 1}.04`,
      ]
      const tableRegion = result.regions.find(
        (region) => region.text === expectedTexts.join(' '),
      )
      expect(tableRegion).toMatchObject({
        kind: 'body',
        column: 'left',
      })
      expect(
        tableRegion?.lines.flatMap((line) =>
          line.runs.map((sourceRun) => sourceRun.text),
        ),
      ).toEqual(expectedTexts)
      expect(tableRegion?.text).not.toContain(`Right prose row ${rowIndex + 1}`)
    }
    expect(
      result.regions.find((region) =>
        region.text.includes('Right prose row 1 remains outside the table.'),
      ),
    ).toMatchObject({ kind: 'body', column: 'right' })

    const leftIds = result.regions
      .filter(
        (region) => region.includedInReadingOrder && region.column === 'left',
      )
      .map((region) => region.id)
    const rightIds = result.regions
      .filter(
        (region) => region.includedInReadingOrder && region.column === 'right',
      )
      .map((region) => region.id)
    expect(
      Math.max(
        ...leftIds.map((regionId) =>
          result.readingOrder.order.indexOf(regionId),
        ),
      ),
    ).toBeLessThan(
      Math.min(
        ...rightIds.map((regionId) =>
          result.readingOrder.order.indexOf(regionId),
        ),
      ),
    )
    expect(
      result.readingOrder.edges.some((edge) =>
        edge.evidence.some((evidence) => evidence.code === 'column-flow'),
      ),
    ).toBe(true)
    expect(result.readingOrder.evaluation.reviewRequired).toBe(false)
  })

  it('does not treat fragmented numeric prose as a one-column numeric matrix', () => {
    const rows = Array.from({ length: 4 }, (_, rowIndex) => {
      const y = 0.2 + rowIndex * 0.04
      return [
        run(
          1,
          `Left column row ${rowIndex + 1} preserves independent prose.`,
          0.088,
          y,
          0.394,
          9,
          0.011,
        ),
        run(1, '2024', 0.528, y, 0.035, 9, 0.011),
        run(1, 'survey readers report', 0.58, y, 0.14, 9, 0.011),
        run(1, '88', 0.738, y, 0.018, 9, 0.011),
        run(1, 'percent agreement.', 0.774, y, 0.132, 9, 0.011),
      ]
    }).flat()
    const result = reconstructPageRegions([page(1, rows)])
    const left = result.regions.find((region) =>
      region.text.includes('Left column row 1 preserves independent prose.'),
    )
    const right = result.regions.find((region) =>
      region.text.includes('2024 survey readers report 88 percent agreement.'),
    )

    expect(left).toMatchObject({ kind: 'body', column: 'left' })
    expect(right).toMatchObject({ kind: 'body', column: 'right' })
    expect(left?.text).not.toContain('survey readers')
    expect(right?.text).not.toContain('Left column')
    const orderedColumns = result.readingOrder.order
      .map((regionId) =>
        result.regions.find((region) => region.id === regionId),
      )
      .filter(
        (region) => region?.column === 'left' || region?.column === 'right',
      )
      .map((region) => region!.column)
    const firstRightIndex = orderedColumns.indexOf('right')
    expect(firstRightIndex).toBeGreaterThan(0)
    expect(
      orderedColumns
        .slice(0, firstRightIndex)
        .every((column) => column === 'left'),
    ).toBe(true)
    expect(
      orderedColumns
        .slice(firstRightIndex)
        .every((column) => column === 'right'),
    ).toBe(true)
    expect(result.readingOrder.resolutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ page: 1, status: 'resolved' }),
      ]),
    )
    expect(
      result.readingOrder.edges.some((edge) =>
        edge.evidence.some((evidence) => evidence.code === 'column-flow'),
      ),
    ).toBe(true)
    expect(result.readingOrder.evaluation.reviewRequired).toBe(false)
  })

  it('does not collapse two wide fragmented prose columns into dense table rows', () => {
    const fragment = (text: string, x: number, y: number, width: number) =>
      run(1, text, x, y, width, 10, 0.013)
    const rows = Array.from({ length: 4 }, (_, rowIndex) => {
      const y = 0.18 + rowIndex * 0.04
      return [
        fragment(`Left${rowIndex + 1}`, 0.119, y, 0.07),
        fragment('column', 0.205, y, 0.07),
        fragment('prose', 0.291, y, 0.06),
        fragment('continues.', 0.367, y, 0.12),
        fragment(`Right${rowIndex + 1}`, 0.514, y, 0.08),
        fragment('column', 0.61, y, 0.07),
        fragment('prose', 0.696, y, 0.06),
        fragment('continues.', 0.772, y, 0.11),
      ]
    }).flat()

    const result = reconstructPageRegions([page(1, rows)])
    const left = result.regions.find((region) =>
      region.text.includes('Left1 column prose continues.'),
    )
    const right = result.regions.find((region) =>
      region.text.includes('Right1 column prose continues.'),
    )

    expect(left).toMatchObject({ column: 'left', kind: 'body' })
    expect(right).toMatchObject({ column: 'right', kind: 'body' })
    expect(left?.text).not.toContain('Right1')
    expect(right?.text).not.toContain('Left1')
  })

  it('does not collapse paired prompt columns when one side uses fragmented word runs', () => {
    const word = (text: string, x: number, y: number, width: number) =>
      run(1, text, x, y, width, 9, 0.011)
    const rows = Array.from({ length: 4 }, (_, rowIndex) => {
      const y = 0.2 + rowIndex * 0.035
      return [
        word(`Left${rowIndex + 1}`, 0.129, y, 0.055),
        word('prompt', 0.195, y, 0.052),
        word('prose', 0.258, y, 0.045),
        word('continues', 0.314, y, 0.07),
        word('independently.', 0.395, y, 0.08),
        word(`Right prompt value ${rowIndex + 1}`, 0.524, y, 0.226),
      ]
    }).flat()

    const result = reconstructPageRegions([page(1, rows)])
    const left = result.regions.find((region) =>
      region.text.includes('Left1 prompt prose continues independently.'),
    )
    const right = result.regions.find((region) =>
      region.text.includes('Right prompt value 1'),
    )

    expect(left).toMatchObject({ column: 'left', kind: 'body' })
    expect(right).toMatchObject({ column: 'right', kind: 'body' })
    expect(left?.text).not.toContain('Right prompt value 1')
    expect(right?.text).not.toContain('Left1')
  })

  it('keeps an inline table reference in prose when opposite-column text is vertically nearer', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Left column establishes its first line.', 0.08, 0.12, 0.36),
        run(1, 'Right column establishes its first line.', 0.56, 0.12, 0.36),
        run(1, 'Left column establishes its second line.', 0.08, 0.16, 0.36),
        run(1, 'Right column establishes its second line.', 0.56, 0.16, 0.36),
        run(
          1,
          'Names are generated from the descriptions shown in',
          0.56,
          0.2,
          0.36,
        ),
        run(1, 'An interleaved left-column reference line.', 0.08, 0.218, 0.36),
        run(1, 'Table 6. Thus a known name can be copied.', 0.56, 0.225, 0.36),
        run(1, 'Left column establishes its final line.', 0.08, 0.26, 0.36),
        run(1, 'Right column establishes its final line.', 0.56, 0.28, 0.36),
        run(1, 'Table 6: A genuine complete table caption.', 0.56, 0.5, 0.36),
      ]),
    ])
    const inlineReference = result.regions.find((region) =>
      region.text.includes('known name can be copied'),
    )
    const genuineCaption = result.regions.find((region) =>
      region.text.includes('genuine complete table caption'),
    )

    expect(inlineReference).toMatchObject({
      kind: 'body',
      column: 'right',
      text: expect.stringContaining(
        'descriptions shown in Table 6. Thus a known name can be copied.',
      ),
    })
    expect(genuineCaption).toMatchObject({
      kind: 'caption',
      column: 'right',
    })
  })

  it('prefers a proven central prose gutter over repeated gaps inside one column', () => {
    const trueColumns = Array.from({ length: 3 }, (_, index) => {
      const y = 0.18 + index * 0.05
      return [
        run(
          1,
          `Left column line ${index + 1} establishes the page flow.`,
          0.09,
          y,
          0.385,
        ),
        run(
          1,
          `Right column line ${index + 1} establishes the page flow.`,
          0.502,
          y,
          0.385,
        ),
      ]
    }).flat()
    const rightColumnFragments = Array.from({ length: 6 }, (_, index) => {
      const y = 0.4 + index * 0.04
      return [
        run(1, `right${index + 1}`, 0.502, y, 0.1),
        run(1, 'column continuation', 0.7, y, 0.18),
      ]
    }).flat()
    const result = reconstructPageRegions([
      page(1, [
        ...trueColumns,
        ...rightColumnFragments,
        {
          ...run(
            1,
            '4.2 Parameterizing the Structure as a Helix',
            0.502,
            0.72,
            0.31,
          ),
          fontName: 'NimbusRomNo9L-Medi',
        },
      ]),
    ])

    expect(
      result.regions.find((region) =>
        region.text.includes('4.2 Parameterizing the Structure as a Helix'),
      ),
    ).toMatchObject({ column: 'right', kind: 'body' })
    expect(
      result.regions.find((region) =>
        region.text.includes('Left column line 1'),
      ),
    ).toMatchObject({ column: 'left', kind: 'body' })
  })
})
