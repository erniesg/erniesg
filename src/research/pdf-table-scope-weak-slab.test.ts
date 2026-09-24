import { describe, expect, it } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfRegionLine,
  PdfSourceRun,
} from './import-types'
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
describe('weak caption-bounded slab ownership', () => {
  it('recovers a compact caption-above metric table without claiming following prose', () => {
    expect(
      compactTabularSlabMayFollowCaption({
        tabularSlab: true,
        cropWidth: 0.38,
      }),
    ).toBe(true)
    expect(
      compactTabularSlabMayFollowCaption({
        tabularSlab: false,
        cropWidth: 0.38,
      }),
    ).toBe(false)
    const rowSpecs = [
      { id: 'table-header', y: 0.632, cells: [0.528, 0.674, 0.84] },
      {
        id: 'table-subheader',
        y: 0.646,
        cells: [0.674, 0.75, 0.812, 0.874],
      },
      {
        id: 'table-row-1',
        y: 0.665,
        cells: [0.528, 0.688, 0.751, 0.813, 0.875],
      },
      {
        id: 'table-row-2',
        y: 0.679,
        cells: [0.528, 0.688, 0.751, 0.813, 0.875],
      },
      {
        id: 'table-row-3',
        y: 0.693,
        cells: [0.528, 0.685, 0.748, 0.809, 0.872],
      },
    ]
    const tableRegions = rowSpecs.map((spec, index) => {
      const sourceLine = line(spec.id, spec.y, spec.cells)
      if (index === 0) {
        sourceLine.runs = sourceLine.runs.map((run) => ({
          ...run,
          bold: true,
        }))
      }
      return {
        ...textRegion(`table-region-${index + 1}`, sourceLine.box, [
          sourceLine,
        ]),
        column: 'right' as const,
      }
    })
    const followingProseLine = proseLine('following-prose', 0.735)
    const followingProse = {
      ...textRegion('following-prose', followingProseLine.box, [
        followingProseLine,
      ]),
      column: 'right' as const,
    }
    const tableCaption: PdfPageRegion = {
      ...caption(
        'caption-table-2',
        0.588,
        'Table 2. Claim detection and veracity results.',
      ),
      column: 'right',
      box: box(0.519, 0.588, 0.396, 0.025),
    }

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, ...tableRegions, followingProse],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'text-nonuniform-grid',
        direction: 'below',
        sourceRegionIds: tableRegions.map((region) => region.id).sort(),
      },
    })
    expect(result.scope?.sourceRegionIds).not.toContain(followingProse.id)
  })

  it('keeps opposite-column child lines out of a weak caption-bounded slab', () => {
    const ownedLines = Array.from({ length: 7 }, (_, index) => {
      const sourceBox = box(0.48, 0.15 + index * 0.024, 0.5, 0.012)
      return {
        id: `owned-record-${index + 1}`,
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
    const oppositeColumnLines = Array.from({ length: 7 }, (_, index) => {
      const sourceBox = box(0.02, 0.161 + index * 0.024, 0.4, 0.012)
      return {
        id: `opposite-prose-${index + 1}`,
        text: `Unrelated prose remains in the other column ${index + 1}.`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Unrelated prose remains in the other column ${index + 1}.`,
            fontName: 'BodySerif',
            fontSize: 8,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    })
    const compositeRegion = {
      ...textRegion(
        'composite-column-region',
        box(0.02, 0.15, 0.96, 0.167),
        ownedLines.flatMap((sourceLine, index) => [
          oppositeColumnLines[index],
          sourceLine,
        ]),
      ),
      // A region-level classifier can assign a composite extraction block to
      // the caption column even when individual child lines remain elsewhere.
      column: 'right' as const,
    }
    const tableCaption = {
      ...caption(
        'right-column-record-caption',
        0.11,
        'Table 2. Bounded records.',
      ),
      column: 'right' as const,
      box: box(0.47, 0.11, 0.51, 0.02),
    }

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, compositeRegion],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        direction: 'below',
        sourceRegionIds: [compositeRegion.id],
        sourceLineIds: ownedLines.map((sourceLine) => sourceLine.id),
        cropBox: box(0.48, 0.15, 0.5, 0.156),
        regionLineage: [
          expect.objectContaining({
            regionId: compositeRegion.id,
            selection: 'partial',
            lineIds: ownedLines.map((sourceLine) => sourceLine.id),
            retainedLineIds: oppositeColumnLines.map(
              (sourceLine) => sourceLine.id,
            ),
          }),
        ],
      },
    })
  })

  it('stops a weak table slab at a strong typography discontinuity before a figure', () => {
    const recordLines = Array.from({ length: 7 }, (_, index) => {
      const sourceBox = box(0.12, 0.15 + index * 0.018, 0.68, 0.012)
      return {
        id: `table-record-${index + 1}`,
        text: `Measure ${index + 1}: source bounded result`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Measure ${index + 1}: source bounded result`,
            fontName: 'TableSerif-Bold',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
    })
    const chartLines = Array.from({ length: 6 }, (_, index) => {
      const sourceBox = box(0.12, 0.284 + index * 0.012, 0.68, 0.007)
      return {
        id: `chart-overlay-${index + 1}`,
        text: `${index * 10} ${index * 20} ${index * 30}`,
        fontSize: 6,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `${index * 10} ${index * 20} ${index * 30}`,
            fontName: 'ChartSans',
            fontSize: 6,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    })
    const records = textRegion(
      'bounded-table-records',
      box(0.12, 0.15, 0.68, 0.12),
      recordLines,
    )
    const chartOverlays = textRegion(
      'following-chart-overlays',
      box(0.12, 0.284, 0.68, 0.067),
      chartLines,
      'chart-label',
    )
    const tableCaption = caption(
      'caption-before-record-table',
      0.11,
      'Table 3. Bounded results.',
    )
    const figureCaption = {
      ...caption('caption-after-chart', 0.365, 'Figure 4. Following chart.'),
      box: box(0.12, 0.365, 0.68, 0.02),
    }

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, records, chartOverlays, figureCaption],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        direction: 'below',
        sourceRegionIds: [records.id],
        sourceLineIds: recordLines.map((sourceLine) => sourceLine.id),
        cropBox: box(0.12, 0.15, 0.68, 0.12),
      },
    })
    expect(result.scope?.sourceRegionIds).not.toContain(chartOverlays.id)
    expect(result.scope?.sourceLineIds).not.toEqual(
      expect.arrayContaining(chartLines.map((sourceLine) => sourceLine.id)),
    )
  })

  it('stops a weak table slab when equal-height rows switch font families', () => {
    const recordLines = Array.from({ length: 7 }, (_, index) => {
      const sourceBox = box(0.12, 0.15 + index * 0.018, 0.68, 0.012)
      return {
        id: `equal-height-table-record-${index + 1}`,
        text: `Measure ${index + 1}: source bounded result`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Measure ${index + 1}: source bounded result`,
            fontName: 'TableSerif-Bold',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
    })
    const chartLines = Array.from({ length: 6 }, (_, index) => {
      const sourceBox = box(0.12, 0.276 + index * 0.018, 0.68, 0.012)
      return {
        id: `equal-height-chart-overlay-${index + 1}`,
        text: `${index * 10} ${index * 20} ${index * 30}`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `${index * 10} ${index * 20} ${index * 30}`,
            fontName: 'ChartSans',
            fontSize: 8,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    })
    const records = textRegion(
      'equal-height-bounded-table-records',
      box(0.12, 0.15, 0.68, 0.12),
      recordLines,
    )
    const chartOverlays = textRegion(
      'equal-height-following-chart-overlays',
      box(0.12, 0.276, 0.68, 0.102),
      chartLines,
      'chart-label',
    )
    const tableCaption = caption(
      'equal-height-record-table-caption',
      0.11,
      'Table 3. Bounded results.',
    )
    const figureCaption = {
      ...caption(
        'equal-height-following-chart-caption',
        0.396,
        'Figure 4. Following chart.',
      ),
      box: box(0.12, 0.396, 0.68, 0.02),
    }

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, records, chartOverlays, figureCaption],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        direction: 'below',
        sourceRegionIds: [records.id],
        sourceLineIds: recordLines.map((sourceLine) => sourceLine.id),
        cropBox: box(0.12, 0.15, 0.68, 0.12),
      },
    })
    expect(result.scope?.sourceRegionIds).not.toContain(chartOverlays.id)
    expect(result.scope?.sourceLineIds).not.toEqual(
      expect.arrayContaining(chartLines.map((sourceLine) => sourceLine.id)),
    )
  })

  it('does not treat bold styling as font-family continuity for a weak slab', () => {
    const recordLines = Array.from({ length: 7 }, (_, index) => {
      const sourceBox = box(0.12, 0.15 + index * 0.018, 0.68, 0.012)
      return {
        id: `bold-family-table-record-${index + 1}`,
        text: `Measure ${index + 1}: source bounded result`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Measure ${index + 1}: source bounded result`,
            fontName: 'TableSerif-Bold',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
    })
    const chartLines = Array.from({ length: 6 }, (_, index) => {
      const sourceBox = box(0.12, 0.276 + index * 0.018, 0.68, 0.012)
      return {
        id: `bold-family-chart-overlay-${index + 1}`,
        text: `${index * 10} ${index * 20} ${index * 30}`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `${index * 10} ${index * 20} ${index * 30}`,
            fontName: 'ChartSans-Bold',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
    })
    const records = textRegion(
      'bold-family-bounded-table-records',
      box(0.12, 0.15, 0.68, 0.12),
      recordLines,
    )
    const chartOverlays = textRegion(
      'bold-family-following-chart-overlays',
      box(0.12, 0.276, 0.68, 0.102),
      chartLines,
      'chart-label',
    )
    const tableCaption = caption(
      'bold-family-record-table-caption',
      0.11,
      'Table 3. Bounded results.',
    )
    const figureCaption = {
      ...caption(
        'bold-family-following-chart-caption',
        0.396,
        'Figure 4. Following chart.',
      ),
      box: box(0.12, 0.396, 0.68, 0.02),
    }

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, records, chartOverlays, figureCaption],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        direction: 'below',
        sourceRegionIds: [records.id],
        sourceLineIds: recordLines.map((sourceLine) => sourceLine.id),
        cropBox: box(0.12, 0.15, 0.68, 0.12),
      },
    })
    expect(result.scope?.sourceRegionIds).not.toContain(chartOverlays.id)
    expect(result.scope?.sourceLineIds).not.toEqual(
      expect.arrayContaining(chartLines.map((sourceLine) => sourceLine.id)),
    )
  })

  it('rejects a foreign font family even when one visible family is shared', () => {
    const recordLines = Array.from({ length: 7 }, (_, index) => {
      const sourceBox = box(0.12, 0.15 + index * 0.018, 0.68, 0.012)
      return {
        id: `mixed-family-table-record-${index + 1}`,
        text: `Measure ${index + 1}: source bounded result`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...box(0.12, sourceBox.y, 0.62, 0.012),
            text: `Measure ${index + 1}: source bounded result`,
            fontName: 'TableSerif-Bold',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
          {
            ...box(0.12, sourceBox.y, 0.01, 0.012),
            text: '◆',
            fontName: 'SharedSymbol',
            fontSize: 8,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    })
    const chartLines = Array.from({ length: 6 }, (_, index) => {
      const sourceBox = box(0.12, 0.276 + index * 0.018, 0.68, 0.012)
      return {
        id: `mixed-family-chart-overlay-${index + 1}`,
        text: `${index * 10} ${index * 20} ${index * 30}`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...box(0.12, sourceBox.y, 0.62, 0.012),
            text: `${index * 10} ${index * 20} ${index * 30}`,
            fontName: 'ChartSans-Bold',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
          {
            ...box(0.12, sourceBox.y, 0.01, 0.012),
            text: '◆',
            fontName: 'SharedSymbol',
            fontSize: 8,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
    })
    const records = textRegion(
      'mixed-family-bounded-table-records',
      box(0.12, 0.15, 0.68, 0.12),
      recordLines,
    )
    const chartOverlays = textRegion(
      'mixed-family-following-chart-overlays',
      box(0.12, 0.276, 0.68, 0.102),
      chartLines,
      'chart-label',
    )
    const tableCaption = caption(
      'mixed-family-record-table-caption',
      0.11,
      'Table 3. Bounded results.',
    )
    const figureCaption = {
      ...caption(
        'mixed-family-following-chart-caption',
        0.396,
        'Figure 4. Following chart.',
      ),
      box: box(0.12, 0.396, 0.68, 0.02),
    }

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, records, chartOverlays, figureCaption],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        sourceRegionIds: [records.id],
        sourceLineIds: recordLines.map((sourceLine) => sourceLine.id),
      },
    })
    expect(result.scope?.sourceLineIds).not.toEqual(
      expect.arrayContaining(chartLines.map((sourceLine) => sourceLine.id)),
    )
  })

  it('admits a body font introduced by a second labeled record row', () => {
    const recordLine = (
      id: string,
      y: number,
      label: string | null,
      value: string,
    ) => {
      const sourceBox = box(0.12, y, 0.68, 0.012)
      const labelWidth = label ? 0.14 : 0
      return {
        id,
        text: label ? `${label} ${value}` : value,
        fontSize: 8,
        box: sourceBox,
        runs: label
          ? [
              {
                ...box(0.12, y, labelWidth, 0.012),
                text: label,
                fontName: 'RecordLabelFace',
                fontSize: 8,
                confidence: 0.99,
                bold: true,
              },
              {
                ...box(0.265, y, 0.535, 0.012),
                text: value,
                fontName: 'RecordBodyFace',
                fontSize: 8,
                confidence: 0.99,
              },
            ]
          : [
              {
                ...sourceBox,
                text: value,
                fontName: 'RecordBodyFace',
                fontSize: 8,
                confidence: 0.99,
              },
            ],
      } satisfies PdfRegionLine
    }
    const sourceLines: PdfRegionLine[] = [
      {
        ...recordLine(
          'record-question',
          0.15,
          null,
          'Question: Which evidence supports this source result?',
        ),
        runs: [
          {
            ...box(0.12, 0.15, 0.68, 0.012),
            text: 'Question: Which evidence supports this source result?',
            fontName: 'RecordLabelFace',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
        ],
      },
      recordLine(
        'record-original-output',
        0.168,
        'Original Output:',
        'The source provides a complete bounded response.',
      ),
      recordLine(
        'record-original-continuation',
        0.186,
        null,
        'Its explanation continues in the regular body face.',
      ),
      recordLine(
        'record-steering-one',
        0.204,
        'Steering against drift:',
        'The first controlled response remains source owned.',
      ),
      recordLine(
        'record-steering-one-continuation',
        0.222,
        null,
        'This continuation retains the established body typography.',
      ),
      recordLine(
        'record-steering-two',
        0.24,
        'Steering towards control:',
        'The second controlled response remains source owned.',
      ),
      recordLine(
        'record-steering-two-continuation',
        0.258,
        null,
        'The final continuation closes the bounded record slab.',
      ),
    ]
    const table = textRegion(
      'mixed-font-labeled-record-table',
      box(0.12, 0.15, 0.68, 0.12),
      sourceLines,
    )
    const tableCaption = caption(
      'mixed-font-labeled-record-caption',
      0.11,
      'Table 4. Source-authored labeled records.',
    )

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [tableCaption, table],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        direction: 'below',
        sourceRegionIds: [table.id],
        sourceLineIds: sourceLines.map((sourceLine) => sourceLine.id),
        cropBox: box(0.12, 0.15, 0.68, 0.12),
      },
    })
  })

  it('keeps short left-aligned continuations owned by a centered single-column caption', () => {
    const recordLine = (
      id: string,
      y: number,
      label: string | null,
      value: string,
      width = 0.68,
    ) => {
      const sourceBox = box(0.12, y, width, 0.012)
      const labelWidth = label ? 0.14 : 0
      return {
        id,
        text: label ? `${label} ${value}` : value,
        fontSize: 8,
        box: sourceBox,
        runs: label
          ? [
              {
                ...box(0.12, y, labelWidth, 0.012),
                text: label,
                fontName: 'RecordLabelFace',
                fontSize: 8,
                confidence: 0.99,
                bold: true,
              },
              {
                ...box(0.265, y, width - 0.145, 0.012),
                text: value,
                fontName: 'RecordBodyFace',
                fontSize: 8,
                confidence: 0.99,
              },
            ]
          : [
              {
                ...sourceBox,
                text: value,
                fontName: 'RecordBodyFace',
                fontSize: 8,
                confidence: 0.99,
              },
            ],
      } satisfies PdfRegionLine
    }
    const sourceLines: PdfRegionLine[] = [
      {
        ...recordLine(
          'single-column-question',
          0.15,
          null,
          'Question: Which source record should remain complete?',
        ),
        runs: [
          {
            ...box(0.12, 0.15, 0.68, 0.012),
            text: 'Question: Which source record should remain complete?',
            fontName: 'RecordLabelFace',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
        ],
      },
      recordLine(
        'single-column-original',
        0.168,
        'Original Output:',
        'The source record starts with a regular body.',
      ),
      recordLine(
        'single-column-original-continuation',
        0.186,
        null,
        'Its final sentence wraps onto a short terminal line.',
      ),
      recordLine('single-column-short-continuation', 0.204, null, 'to.', 0.02),
      recordLine(
        'single-column-steering-one',
        0.222,
        'Steering against drift:',
        'The next labeled record stays in the same table.',
      ),
      recordLine(
        'single-column-steering-one-continuation',
        0.24,
        null,
        'Its continuation keeps the established body typography.',
      ),
      recordLine(
        'single-column-steering-two',
        0.258,
        'Steering towards control:',
        'The final labeled record remains source owned.',
      ),
      recordLine(
        'single-column-steering-two-continuation',
        0.276,
        null,
        'The bounded slab closes after this continuation.',
      ),
    ]
    const table = textRegion(
      'single-column-short-continuation-table',
      box(0.12, 0.15, 0.68, 0.138),
      sourceLines,
    )
    const tableCaption = {
      ...caption(
        'single-column-centered-caption',
        0.11,
        'Table 5. Centered source-authored records.',
      ),
      box: box(0.34, 0.11, 0.32, 0.02),
    }
    const foreignLine = recordLine(
      'explicit-right-lane-foreign-record',
      0.213,
      'Foreign panel:',
      'A neighboring lane must remain outside the single-column table.',
      0.24,
    )
    const foreign = {
      ...textRegion(
        'explicit-right-lane-foreign-region',
        box(0.56, 0.213, 0.24, 0.012),
        [
          {
            ...foreignLine,
            box: box(0.56, 0.213, 0.24, 0.012),
            runs: foreignLine.runs.map((run, index) => ({
              ...run,
              x: index === 0 ? 0.56 : 0.665,
              width: index === 0 ? 0.1 : 0.135,
            })),
          },
        ],
      ),
      column: 'right' as const,
    }

    const result = resolvePdfTableScope({
      caption: tableCaption,
      pageRegions: [tableCaption, table, foreign],
      nativeObjects: [],
    })

    expect(result).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        direction: 'below',
        sourceRegionIds: [table.id],
        sourceLineIds: sourceLines.map((sourceLine) => sourceLine.id),
        cropBox: box(0.12, 0.15, 0.68, 0.138),
      },
    })
    expect(result.scope?.sourceLineIds).not.toContain(foreignLine.id)
  })

  it.each([
    ['different label typography', 0.12, 'ForeignChartFace-Bold'],
    ['a different label anchor', 0.16, 'RecordLabelFace'],
  ])(
    'does not admit a foreign labeled family with %s after labeled records',
    (_case, foreignX, foreignFontName) => {
      const ownedLines = Array.from({ length: 7 }, (_, index) => {
        const sourceBox = box(0.12, 0.15 + index * 0.018, 0.68, 0.012)
        return {
          id: `bounded-labeled-record-${index + 1}`,
          text: `Measure ${index + 1}: source bounded result`,
          fontSize: 8,
          box: sourceBox,
          runs: [
            {
              ...sourceBox,
              text: `Measure ${index + 1}: source bounded result`,
              fontName: 'RecordLabelFace',
              fontSize: 8,
              confidence: 0.99,
              bold: true,
            },
          ],
        } satisfies PdfRegionLine
      })
      const foreignBox = box(foreignX, 0.276, 0.8 - foreignX, 0.012)
      const foreignLine = {
        id: 'foreign-labeled-row',
        text: 'Foreign panel: Following chart overlay remains outside the record table',
        fontSize: 8,
        box: foreignBox,
        runs: [
          {
            ...foreignBox,
            text: 'Foreign panel: Following chart overlay remains outside the record table',
            fontName: foreignFontName,
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
      const table = textRegion(
        'bounded-labeled-records',
        box(0.12, 0.15, 0.68, 0.12),
        ownedLines,
      )
      const foreign = textRegion(
        'foreign-labeled-overlay',
        foreignBox,
        [foreignLine],
        'chart-label',
      )
      const tableCaption = caption(
        'bounded-labeled-record-caption',
        0.11,
        'Table 4. Source-authored labeled records.',
      )

      const result = resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [tableCaption, table, foreign],
        nativeObjects: [],
      })

      expect(result).toMatchObject({
        status: 'matched',
        scope: {
          proof: 'caption-bounded-text-slab',
          sourceRegionIds: [table.id],
          sourceLineIds: ownedLines.map((sourceLine) => sourceLine.id),
        },
      })
      expect(result.scope?.sourceLineIds).not.toContain(foreignLine.id)
    },
  )

  it('does not bridge a foreign single-anchor body from a styled header', () => {
    const header = line('foreign-body-header', 0.15, [0.12, 0.44])
    for (const run of header.runs) {
      run.fontName = 'HeaderSans-Bold'
      run.bold = true
    }
    const bodyLines = Array.from({ length: 6 }, (_, index) => {
      const sourceBox = box(0.12, 0.168 + index * 0.018, 0.68, 0.012)
      return {
        id: `foreign-single-anchor-body-${index + 1}`,
        text: `Measure ${index + 1}: source bounded result`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Measure ${index + 1}: source bounded result`,
            fontName: 'BodySerif-Bold',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
    })
    const table = textRegion(
      'foreign-header-body-table',
      box(0.12, 0.15, 0.68, 0.12),
      [header, ...bodyLines],
    )
    const tableCaption = caption(
      'foreign-header-body-caption',
      0.11,
      'Table 3. Bounded results.',
    )

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [tableCaption, table],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
    })
  })

  it('does not bridge clustered body anchors through one styled header anchor', () => {
    const header = line('clustered-body-header', 0.15, [0.12, 0.44, 0.68])
    for (const run of header.runs) {
      run.fontName = 'HeaderSans-Bold'
      run.bold = true
    }
    const firstBodyBox = box(0.12, 0.168, 0.68, 0.016)
    const clusteredBody = {
      id: 'clustered-body-row-1',
      text: 'Measure 1: source bounded result 10 20',
      fontSize: 8,
      box: firstBodyBox,
      runs: [
        {
          ...box(0.12, firstBodyBox.y, 0.001, 0.016),
          text: 'Measure 1: source bounded result',
          fontName: 'BodySerif-Bold',
          fontSize: 8,
          confidence: 0.99,
          bold: true,
        },
        {
          ...box(0.127, firstBodyBox.y, 0.001, 0.016),
          text: '10',
          fontName: 'BodySerif-Bold',
          fontSize: 8,
          confidence: 0.99,
          bold: true,
        },
        {
          ...box(0.134, firstBodyBox.y, 0.001, 0.016),
          text: '20',
          fontName: 'BodySerif-Bold',
          fontSize: 8,
          confidence: 0.99,
          bold: true,
        },
      ],
    } satisfies PdfRegionLine
    const remainingBody = Array.from({ length: 5 }, (_, index) => {
      const sourceBox = box(0.12, 0.186 + index * 0.018, 0.68, 0.016)
      return {
        id: `clustered-body-row-${index + 2}`,
        text: `Measure ${index + 2}: source bounded result`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Measure ${index + 2}: source bounded result`,
            fontName: 'BodySerif-Bold',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
    })
    const table = textRegion(
      'clustered-header-body-table',
      box(0.12, 0.15, 0.68, 0.124),
      [header, clusteredBody, ...remainingBody],
    )
    const tableCaption = caption(
      'clustered-header-body-caption',
      0.11,
      'Table 3. Bounded results.',
    )

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [tableCaption, table],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'unresolved',
      scope: null,
      candidates: [],
    })
  })

  it('bridges distinctly aligned body anchors from a styled header', () => {
    const header = line('aligned-body-header', 0.15, [0.12, 0.44, 0.68])
    for (const run of header.runs) {
      run.fontName = 'HeaderSans-Bold'
      run.bold = true
    }
    const firstBodyBox = box(0.12, 0.168, 0.68, 0.016)
    const alignedBody = {
      id: 'aligned-body-row-1',
      text: 'Measure 1: source bounded result 10 20',
      fontSize: 8,
      box: firstBodyBox,
      runs: [0.12, 0.44, 0.68].map<PdfSourceRun>((x, index) => ({
        ...box(x, firstBodyBox.y, 0.075, 0.016),
        text:
          index === 0 ? 'Measure 1: source bounded result' : String(index * 10),
        fontName: 'BodySerif-Bold',
        fontSize: 8,
        confidence: 0.99,
        bold: true,
      })),
    } satisfies PdfRegionLine
    const remainingBody = Array.from({ length: 5 }, (_, index) => {
      const sourceBox = box(0.12, 0.186 + index * 0.018, 0.68, 0.016)
      return {
        id: `aligned-body-row-${index + 2}`,
        text: `Measure ${index + 2}: source bounded result`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Measure ${index + 2}: source bounded result`,
            fontName: 'BodySerif-Bold',
            fontSize: 8,
            confidence: 0.99,
            bold: true,
          },
        ],
      } satisfies PdfRegionLine
    })
    const bodyLines = [alignedBody, ...remainingBody]
    const table = textRegion(
      'aligned-header-body-table',
      box(0.12, 0.15, 0.68, 0.124),
      [header, ...bodyLines],
    )
    const tableCaption = caption(
      'aligned-header-body-caption',
      0.11,
      'Table 3. Bounded results.',
    )

    expect(
      resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [tableCaption, table],
        nativeObjects: [],
      }),
    ).toMatchObject({
      status: 'matched',
      scope: {
        proof: 'caption-bounded-text-slab',
        sourceRegionIds: [table.id],
        sourceLineIds: [
          header.id,
          ...bodyLines.map((sourceLine) => sourceLine.id),
        ],
      },
    })
  })
})
