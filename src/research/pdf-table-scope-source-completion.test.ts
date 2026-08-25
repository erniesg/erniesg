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

describe('PDF table source-completion family', () => {
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
})
