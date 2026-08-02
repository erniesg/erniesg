import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  PdfEmbeddedLink,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReconstruction,
  PdfRegionLine,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import type { ResearchPaper } from './schema'
import { buildEpub, renderPublicationXhtml } from './epub'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import { assessPdfCompleteness } from './pdf-quality'
import { isSourceVerifiedSemanticTable } from './semantic-table'
import {
  detectTableNearCaption,
  detectWrappedCellTableWithinProvenScope,
  type PdfDetectedTableGrid,
} from './pdf-table-detection'
import { canonicalTableFromLines, createTableAsset } from './visual-assets'

function sourceBox(x: number, y: number, width = 0.12, height = 0.02) {
  return {
    page: 1,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text' as const,
  }
}

function line(
  id: string,
  y: number,
  cells: Array<{
    text: string
    x: number
    bold?: boolean
    italic?: boolean
    fontName?: string
    fontSize?: number
    height?: number
    y?: number
  }>,
): PdfRegionLine {
  const runs = cells.map((cell) => ({
    ...sourceBox(cell.x, cell.y ?? y, 0.12, cell.height ?? 0.02),
    text: cell.text,
    fontName: cell.fontName ?? 'TableSerif',
    fontSize: cell.fontSize ?? 10,
    bold: cell.bold,
    italic: cell.italic,
    confidence: 1,
  }))
  return {
    id,
    text: cells.map((cell) => cell.text).join(' '),
    fontSize: 10,
    box: sourceBox(
      Math.min(...runs.map((run) => run.x)),
      Math.min(...runs.map((run) => run.y)),
      Math.max(...runs.map((run) => run.x + run.width)) -
        Math.min(...runs.map((run) => run.x)),
      Math.max(...runs.map((run) => run.y + run.height)) -
        Math.min(...runs.map((run) => run.y)),
    ),
    runs,
  }
}

function tableFixture() {
  const header = line('table-header', 0.2, [
    { text: 'Method', x: 0.1, bold: true },
    { text: 'Score', x: 0.5, bold: true },
  ])
  const body = line('table-body', 0.25, [
    { text: 'Ours', x: 0.1, italic: true },
    {
      text: '−4.2',
      x: 0.5,
      fontName: 'TableSerif',
      fontSize: 7,
      height: 0.012,
      y: 0.242,
    },
  ])
  const region = {
    id: 'table-region',
    page: 1,
    kind: 'body',
    column: 'single',
    text: 'Method Score Ours −4.2',
    confidence: 1,
    box: sourceBox(0.1, 0.2, 0.52, 0.062),
    lines: [header, body],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const links = [
    {
      id: 'table-link-method',
      page: 1,
      status: 'external',
      url: 'https://example.org/method',
      box: sourceBox(0.1, 0.25),
    },
  ] satisfies PdfEmbeddedLink[]
  return { header, body, region, links }
}

describe('source-verifiable semantic tables', () => {
  it('keeps wrapped body-cell lineage when a continuation row is canonicalized', () => {
    const header = line('continuation-header', 0.2, [
      { text: 'Reference', x: 0.1, bold: true, fontName: 'Table-Bold' },
      { text: 'Environment', x: 0.3, bold: true, fontName: 'Table-Bold' },
      { text: 'NPC', x: 0.5, bold: true, fontName: 'Table-Bold' },
      { text: 'Outcome', x: 0.7, bold: true, fontName: 'Table-Bold' },
    ])
    const body = line('continuation-body-1', 0.24, [
      { text: 'A', x: 0.1 },
      { text: 'The environment begins', x: 0.3 },
      { text: 'the NPC waits', x: 0.5 },
      { text: 'The action resolves', x: 0.7 },
    ])
    const continuation = line('continuation-body-1-more', 0.26, [
      { text: 'and the light changes', x: 0.3 },
      { text: 'before the door opens', x: 0.5 },
    ])
    const completeBody = (id: string, y: number, prefix: string) =>
      line(id, y, [
        { text: prefix, x: 0.1 },
        { text: `${prefix} environment`, x: 0.3 },
        { text: `${prefix} NPC`, x: 0.5 },
        { text: `${prefix} outcome`, x: 0.7 },
      ])
    const sourceLines = [
      header,
      body,
      continuation,
      completeBody('continuation-body-2', 0.3, 'B'),
      completeBody('continuation-body-3', 0.36, 'C'),
      completeBody('continuation-body-4', 0.42, 'D'),
    ]
    const region = {
      id: 'continuation-table-region',
      page: 1,
      kind: 'body',
      column: 'span',
      text: sourceLines.map((sourceLine) => sourceLine.text).join(' '),
      confidence: 1,
      box: sourceBox(0.1, 0.2, 0.72, 0.24),
      lines: sourceLines,
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const detected = detectWrappedCellTableWithinProvenScope([region], {
      direction: 'below',
      sourceRegionIds: [region.id],
      sourceLineIds: sourceLines.map((sourceLine) => sourceLine.id),
      evidence: [
        { code: 'repeated-row-bands' },
        { code: 'repeated-column-anchors' },
      ],
    })
    if (!detected) throw new Error('Expected a wrapped-cell table grid')

    const table = canonicalTableFromLines(detected.lines, {
      detectedGrid: detected,
      sourceRegions: [region],
    })
    if (!table) throw new Error('Expected a source-verifiable table')

    expect(table.rows).toHaveLength(5)
    expect(table.rows[1].cells[1]).toMatchObject({
      text: 'The environment begins and the light changes',
      sourceRuns: [
        expect.objectContaining({
          lineId: body.id,
          text: 'The environment begins',
        }),
        expect.objectContaining({
          lineId: continuation.id,
          text: 'and the light changes',
        }),
      ],
    })
    expect(table.rows[1].cells[2].sourceRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lineId: body.id, text: 'the NPC waits' }),
        expect.objectContaining({
          lineId: continuation.id,
          text: 'before the door opens',
        }),
      ]),
    )
    expect(
      isSourceVerifiedSemanticTable({
        table,
        relationship: {
          id: 'continuation-table-relationship',
          kind: 'table',
          label: 'Table 1',
          captionRegionId: 'continuation-caption',
          sourceRegionIds: [region.id],
          sourceLineIds: sourceLines.map((sourceLine) => sourceLine.id),
          sourceObjectIds: ['continuation-table-object'],
          assetIds: ['continuation-table-asset'],
          status: 'matched',
          confidence: 1,
          evidence: ['semantic-table'],
          candidates: [],
          sourceBoxes: [region.box],
          sourceText: detected.lines
            .map((sourceLine) => sourceLine.text)
            .join(' '),
          altText: 'Table 1. Wrapped body cells.',
          altTextSource: 'caption',
          canonicalNodeId: 'continuation-table-node',
          captionNodeId: 'continuation-caption-node',
        },
        regions: [region],
        evidence: {
          confidence: 1,
          pages: [1],
          regionIds: [region.id],
          boxes: [region.box],
          links: [],
        },
      }),
    ).toBe(true)
  })

  it('preserves exact lineage and associations for a proved two-tier column header', async () => {
    const groupHeader = line('group-header', 0.2, [
      { text: 'Methods', x: 0.1 },
      { text: 'Auto Evaluation', x: 0.4 },
      { text: 'Human Evaluation', x: 0.7 },
    ])
    const leafHeader = line(
      'leaf-header',
      0.23,
      ['Words', 'Conflict', 'Entropy', 'Plot', 'Coherence'].map(
        (text, index) => ({ text, x: 0.3 + index * 0.12 }),
      ),
    )
    const bodyLines = [0.26, 0.29, 0.32].map((y, rowIndex) =>
      line(`body-${rowIndex + 1}`, y, [
        { text: ['Baseline', 'Ablation', 'Ours'][rowIndex], x: 0.1 },
        ...Array.from({ length: 5 }, (_, columnIndex) => ({
          text: `${rowIndex + 1}.${columnIndex + 1}`,
          x: 0.3 + columnIndex * 0.12,
        })),
      ]),
    )
    const sourceLines = [groupHeader, leafHeader, ...bodyLines]
    const region = {
      id: 'hierarchical-table-region',
      page: 1,
      kind: 'body',
      column: 'span',
      text: sourceLines.map((sourceLine) => sourceLine.text).join(' '),
      confidence: 1,
      box: sourceBox(0.1, 0.2, 0.8, 0.14),
      lines: sourceLines,
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const detectedLine = (
      sourceLine: PdfRegionLine,
      cells: PdfDetectedTableGrid['lines'][number]['cells'],
    ): PdfDetectedTableGrid['lines'][number] => ({
      ...sourceLine,
      sourceLineIds: [sourceLine.id],
      sourceRegionIds: [region.id],
      sourceRegionKinds: ['body'],
      runs: cells.map((cell) => cell.run),
      cells,
    })
    const grid = {
      sourceRegions: [region],
      sourceLineIds: sourceLines.map((sourceLine) => sourceLine.id),
      lines: [
        detectedLine(groupHeader, [
          {
            run: groupHeader.runs[0],
            columnIndex: 0,
            columnSpan: 1,
            rowSpan: 2,
          },
          {
            run: groupHeader.runs[1],
            columnIndex: 1,
            columnSpan: 3,
            rowSpan: 1,
          },
          {
            run: groupHeader.runs[2],
            columnIndex: 4,
            columnSpan: 2,
            rowSpan: 1,
          },
        ]),
        detectedLine(
          leafHeader,
          leafHeader.runs.map((run, index) => ({
            run,
            columnIndex: index + 1,
            columnSpan: 1,
            rowSpan: 1,
          })),
        ),
        ...bodyLines.map((bodyLine) =>
          detectedLine(
            bodyLine,
            bodyLine.runs.map((run, index) => ({
              run,
              columnIndex: index,
              columnSpan: 1,
              rowSpan: 1,
            })),
          ),
        ),
      ],
      columnCount: 6,
      headerRowCount: 2,
      evidence: ['semantic-header-hierarchical-geometry'],
    } satisfies PdfDetectedTableGrid
    const table = canonicalTableFromLines(grid.lines, {
      detectedGrid: grid,
      sourceRegions: [region],
    })
    if (!table) throw new Error('Expected hierarchical semantic table')
    const relationship = {
      id: 'hierarchical-table-relationship',
      kind: 'table',
      label: 'Table 2',
      captionRegionId: 'caption',
      sourceRegionIds: [region.id],
      sourceLineIds: grid.sourceLineIds,
      sourceObjectIds: ['table-object'],
      assetIds: ['table-asset'],
      status: 'matched',
      confidence: 1,
      evidence: ['semantic-table'],
      candidates: [],
      sourceBoxes: [region.box],
      sourceText: region.text,
      altText: 'Table 2',
      altTextSource: 'caption',
      canonicalNodeId: 'table-node',
      captionNodeId: 'caption-node',
    } satisfies PdfVisualRelationship

    expect(table.rows[0].cells).toMatchObject([
      {
        id: 'cell-r1-c1',
        text: 'Methods',
        columnSpan: 1,
        rowSpan: 2,
      },
      {
        id: 'cell-r1-c2',
        text: 'Auto Evaluation',
        columnSpan: 3,
        rowSpan: 1,
      },
      {
        id: 'cell-r1-c5',
        text: 'Human Evaluation',
        columnSpan: 2,
        rowSpan: 1,
      },
    ])
    expect(table.rows[2].cells[1].headerIds).toEqual([
      'cell-r1-c2',
      'cell-r2-c2',
    ])
    expect(
      isSourceVerifiedSemanticTable({
        table,
        relationship,
        regions: [region],
        evidence: {
          confidence: 1,
          pages: [1],
          regionIds: [region.id],
          boxes: [region.box],
          links: [],
        },
      }),
    ).toBe(true)
    const missingGroupHeader = structuredClone(table)
    missingGroupHeader.rows[2].cells[1].headerIds = ['cell-r2-c2']
    expect(
      isSourceVerifiedSemanticTable({
        table: missingGroupHeader,
        relationship,
        regions: [region],
        evidence: {
          confidence: 1,
          pages: [1],
          regionIds: [region.id],
          boxes: [region.box],
          links: [],
        },
      }),
    ).toBe(false)

    const asset = await createTableAsset({
      sourceObjectId: 'hierarchical-table-object',
      sourceBox: region.box,
      lines: grid.lines,
      detectedGrid: grid,
      sourceRegions: [region],
      pageWidth: 612,
      pageHeight: 792,
    })
    const xhtml = strFromU8(asset!.bytes)
    expect(xhtml.match(/<thead>/gu)).toHaveLength(1)
    expect(xhtml.match(/<tr>/gu)).toHaveLength(5)
    expect(xhtml).toContain(
      '<th id="cell-r1-c1" scope="col" rowspan="2">Methods</th>',
    )
    expect(xhtml).toContain(
      '<th id="cell-r1-c2" scope="col" colspan="3">Auto Evaluation</th>',
    )
    expect(xhtml).toContain('headers="cell-r1-c2 cell-r2-c2"')
  })

  it('records stable cell identities, explicit headers, exact source-run lineage, and cell-local inline evidence', () => {
    const { header, body, region, links } = tableFixture()

    const table = canonicalTableFromLines([header, body], {
      sourceRegions: [region],
      links,
    })

    expect(table).toEqual({
      rows: [
        {
          cells: [
            expect.objectContaining({
              id: 'cell-r1-c1',
              text: 'Method',
              headerScope: 'column',
              headerIds: [],
              sourceRuns: [
                expect.objectContaining({
                  regionId: region.id,
                  lineId: header.id,
                  runIndex: 0,
                  text: 'Method',
                  box: expect.objectContaining({
                    page: header.runs[0].page,
                    x: header.runs[0].x,
                    y: header.runs[0].y,
                    width: header.runs[0].width,
                    height: header.runs[0].height,
                  }),
                }),
              ],
              inlineMapping: { expected: 1, mapped: 1 },
              inlineRuns: [
                {
                  start: 0,
                  end: 6,
                  bold: true,
                },
              ],
            }),
            expect.objectContaining({
              id: 'cell-r1-c2',
              text: 'Score',
              headerScope: 'column',
              headerIds: [],
            }),
          ],
        },
        {
          cells: [
            expect.objectContaining({
              id: 'cell-r2-c1',
              text: 'Ours',
              headerScope: null,
              headerIds: ['cell-r1-c1'],
              inlineMapping: { expected: 2, mapped: 2 },
              inlineRuns: [
                {
                  start: 0,
                  end: 4,
                  italic: true,
                  href: 'https://example.org/method',
                  annotationId: 'table-link-method',
                },
              ],
            }),
            expect.objectContaining({
              id: 'cell-r2-c2',
              text: '−4.2',
              headerScope: null,
              headerIds: ['cell-r1-c2'],
              inlineMapping: { expected: 1, mapped: 1 },
              inlineRuns: [
                {
                  start: 0,
                  end: 4,
                  verticalAlign: 'superscript',
                },
              ],
            }),
          ],
        },
      ],
    })
  })

  it('maps one detected cell to an exact ordered sequence of bounded source runs', () => {
    const formulaRuns = [
      { text: 'a', x: 0.1, width: 0.018 },
      { text: '//', x: 0.118, width: 0.02 },
      { text: '5', x: 0.138, width: 0.018 },
      { text: '=', x: 0.16, width: 0.018 },
    ].map((source, index) => ({
      ...sourceBox(source.x, 0.2, source.width, 0.02),
      text: source.text,
      fontName: 'TableSerif-Medium',
      fontSize: 10,
      bold: true,
      confidence: 1,
      sourceIndex: index,
    }))
    const scoreHeader = {
      ...sourceBox(0.5, 0.2, 0.12, 0.02),
      text: 'Score',
      fontName: 'TableSerif-Medium',
      fontSize: 10,
      bold: true,
      confidence: 1,
    }
    const sourceHeader = {
      id: 'composite-source-header',
      text: 'a // 5 = Score',
      fontSize: 10,
      box: sourceBox(0.1, 0.2, 0.52, 0.02),
      runs: [...formulaRuns, scoreHeader],
    } satisfies PdfRegionLine
    const sourceBody = line('composite-source-body', 0.25, [
      { text: 'Model', x: 0.1 },
      { text: '2.98', x: 0.5 },
    ])
    const detectedHeader = {
      ...sourceHeader,
      id: 'detected-composite-header',
      runs: [
        {
          ...formulaRuns[0],
          text: 'a//5 =',
          width:
            formulaRuns.at(-1)!.x +
            formulaRuns.at(-1)!.width -
            formulaRuns[0].x,
        },
        scoreHeader,
      ],
      sourceLineIds: [sourceHeader.id],
    }
    const detectedBody = {
      ...sourceBody,
      id: 'detected-composite-body',
      sourceLineIds: [sourceBody.id],
    }
    const region = {
      id: 'composite-source-table-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'a // 5 = Score Model 2.98',
      confidence: 1,
      box: sourceBox(0.1, 0.2, 0.52, 0.07),
      lines: [sourceHeader, sourceBody],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion

    const table = canonicalTableFromLines([detectedHeader, detectedBody], {
      detectedRectangularGeometry: true,
      sourceRegions: [region],
    })

    expect(table?.rows[0].cells[0]).toMatchObject({
      text: 'a//5 =',
      sourceRuns: formulaRuns.map((run, runIndex) => ({
        regionId: region.id,
        lineId: sourceHeader.id,
        runIndex,
        text: run.text,
        box: sourceBox(run.x, run.y, run.width, run.height),
      })),
      inlineMapping: { expected: 4, mapped: 4 },
    })
    expect(table?.rows[0].cells[0].inlineRuns).toEqual([
      { start: 0, end: 1, bold: true },
      { start: 1, end: 3, bold: true },
      { start: 3, end: 4, bold: true },
      { start: 5, end: 6, bold: true },
    ])
    if (!table) throw new Error('Expected exact multi-run semantic table')
    expect(
      isSourceVerifiedSemanticTable({
        table,
        relationship: {
          id: 'composite-source-table-relationship',
          kind: 'table',
          label: 'Table 1',
          captionRegionId: 'composite-source-table-caption',
          sourceRegionIds: [region.id],
          sourceLineIds: [sourceHeader.id, sourceBody.id],
          sourceObjectIds: ['composite-source-table-object'],
          assetIds: ['composite-source-table-asset'],
          status: 'matched',
          confidence: 1,
          evidence: ['semantic-table'],
          candidates: [],
          sourceBoxes: [region.box],
          sourceText: region.text,
          altText: 'Table 1. Exact composite cells.',
          altTextSource: 'caption',
          canonicalNodeId: 'composite-source-table-node',
          captionNodeId: 'composite-source-table-caption-node',
        },
        regions: [region],
        evidence: {
          confidence: 1,
          pages: [1],
          regionIds: [region.id],
          boxes: [region.box],
          links: [],
        },
      }),
    ).toBe(true)
  })

  it('maps a unique source cell throughout the detector column-center tolerance', () => {
    const { header, body, region } = tableFixture()
    const detectedHeader = {
      ...header,
      id: 'normalized-anchor-header',
      runs: header.runs.map((run, index) => ({
        ...run,
        x: run.x + (index === 0 ? 0 : 0.042),
      })),
      sourceLineIds: [header.id],
    }
    const detectedBody = {
      ...body,
      id: 'normalized-anchor-body',
      runs: body.runs.map((run, index) => ({
        ...run,
        x: run.x + (index === 0 ? 0 : 0.042),
      })),
      sourceLineIds: [body.id],
    }

    expect(
      canonicalTableFromLines([detectedHeader, detectedBody], {
        detectedRectangularGeometry: true,
        sourceRegions: [region],
      })?.rows[0].cells[1],
    ).toMatchObject({
      text: 'Score',
      sourceRuns: [
        expect.objectContaining({
          regionId: region.id,
          lineId: header.id,
          runIndex: 1,
          text: 'Score',
          box: sourceBox(
            header.runs[1].x,
            header.runs[1].y,
            header.runs[1].width,
            header.runs[1].height,
          ),
        }),
      ],
    })
  })

  it('uses detector-preserved source boxes after column normalization', () => {
    const { header, body, region } = tableFixture()
    const normalizedX = 0.57
    const detectedHeader = {
      ...header,
      id: 'source-box-normalized-header',
      runs: header.runs.map((run, index) => ({
        ...run,
        x: index === 0 ? run.x : normalizedX,
      })),
      sourceLineIds: [header.id],
      sourceCellBoxes: header.runs.map((run) =>
        sourceBox(run.x, run.y, run.width, run.height),
      ),
    }
    const detectedBody = {
      ...body,
      id: 'source-box-normalized-body',
      runs: body.runs.map((run, index) => ({
        ...run,
        x: index === 0 ? run.x : normalizedX,
      })),
      sourceLineIds: [body.id],
      sourceCellBoxes: body.runs.map((run) =>
        sourceBox(run.x, run.y, run.width, run.height),
      ),
    }

    expect(
      canonicalTableFromLines([detectedHeader, detectedBody], {
        detectedRectangularGeometry: true,
        sourceRegions: [region],
      })?.rows[0].cells[1],
    ).toMatchObject({
      text: 'Score',
      sourceRuns: [
        expect.objectContaining({
          regionId: region.id,
          lineId: header.id,
          runIndex: 1,
          text: 'Score',
          box: sourceBox(
            header.runs[1].x,
            header.runs[1].y,
            header.runs[1].width,
            header.runs[1].height,
          ),
        }),
      ],
    })
  })

  it('fails closed when detector-preserved source boxes have invalid cardinality', () => {
    const { header, body, region } = tableFixture()
    const detectedHeader = {
      ...header,
      id: 'invalid-source-box-cardinality-header',
      runs: header.runs.map((run, index) => ({
        ...run,
        x: run.x + (index === 0 ? 0 : 0.042),
      })),
      sourceLineIds: [header.id],
      sourceCellBoxes: [
        sourceBox(
          header.runs[0].x,
          header.runs[0].y,
          header.runs[0].width,
          header.runs[0].height,
        ),
      ],
    }
    const detectedBody = {
      ...body,
      id: 'invalid-source-box-cardinality-body',
      sourceLineIds: [body.id],
      sourceCellBoxes: body.runs.map((run) =>
        sourceBox(run.x, run.y, run.width, run.height),
      ),
    }

    expect(
      canonicalTableFromLines([detectedHeader, detectedBody], {
        detectedRectangularGeometry: true,
        sourceRegions: [region],
      }),
    ).toBeNull()
  })

  it('fails closed when detector-preserved source boxes contain a missing or null entry', () => {
    const { header, body, region } = tableFixture()
    const validHeaderBoxes = header.runs.map((run) =>
      sourceBox(run.x, run.y, run.width, run.height),
    )
    const sparseHeaderBoxes = [...validHeaderBoxes]
    delete sparseHeaderBoxes[1]
    const nullHeaderBoxes = [
      validHeaderBoxes[0],
      null,
    ] as unknown as typeof validHeaderBoxes
    const detectedBody = {
      ...body,
      id: 'malformed-source-box-entry-body',
      sourceLineIds: [body.id],
      sourceCellBoxes: body.runs.map((run) =>
        sourceBox(run.x, run.y, run.width, run.height),
      ),
    }

    for (const sourceCellBoxes of [sparseHeaderBoxes, nullHeaderBoxes]) {
      const detectedHeader = {
        ...header,
        id: 'malformed-source-box-entry-header',
        runs: header.runs.map((run, index) => ({
          ...run,
          x: run.x + (index === 0 ? 0 : 0.042),
        })),
        sourceLineIds: [header.id],
        sourceCellBoxes,
      }

      expect(
        canonicalTableFromLines([detectedHeader, detectedBody], {
          detectedRectangularGeometry: true,
          sourceRegions: [region],
        }),
      ).toBeNull()
    }
  })

  it('fails closed when two same-text source columns fall inside the normalized anchor tolerance', () => {
    const { header, body, region } = tableFixture()
    const ambiguousHeader = {
      ...header,
      runs: [
        ...header.runs,
        {
          ...header.runs[1],
          x: header.runs[1].x + 0.02,
        },
      ],
    }
    const ambiguousRegion = {
      ...region,
      lines: [ambiguousHeader, body],
    }
    const detectedHeader = {
      ...header,
      id: 'ambiguous-normalized-anchor-header',
      runs: header.runs.map((run, index) => ({
        ...run,
        x: run.x + (index === 0 ? 0 : 0.01),
      })),
      sourceLineIds: [header.id],
    }
    const detectedBody = {
      ...body,
      id: 'ambiguous-normalized-anchor-body',
      sourceLineIds: [body.id],
    }

    expect(
      canonicalTableFromLines([detectedHeader, detectedBody], {
        detectedRectangularGeometry: true,
        sourceRegions: [ambiguousRegion],
      }),
    ).toBeNull()
  })

  it('fails closed when one cell has ambiguous source hyperlink evidence', () => {
    const { header, body, region, links } = tableFixture()

    expect(
      canonicalTableFromLines([header, body], {
        sourceRegions: [region],
        links: [
          ...links,
          {
            id: 'table-link-competing-target',
            page: 1,
            status: 'external',
            url: 'https://example.org/competing-target',
            box: sourceBox(0.1, 0.25),
          },
        ],
      }),
    ).toBeNull()
  })

  it('replays one logical row assembled from multiple same-band source lines', () => {
    const headerLeft = line('header-left', 0.2, [
      { text: 'Method', x: 0.1, bold: true },
    ])
    const headerRight = line('header-right', 0.2, [
      { text: 'Score', x: 0.5, bold: true },
    ])
    const bodyLeft = line('body-left', 0.25, [{ text: 'Baseline', x: 0.1 }])
    const bodyRight = line('body-right', 0.25, [{ text: '−8.0', x: 0.5 }])
    const lines = [headerLeft, headerRight, bodyLeft, bodyRight]
    const region = {
      id: 'fragmented-table-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'Method Score Baseline −8.0',
      confidence: 1,
      box: sourceBox(0.1, 0.2, 0.52, 0.07),
      lines,
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const table = canonicalTableFromLines(lines, {
      sourceHeaderLineIds: [headerLeft.id, headerRight.id],
      sourceRegions: [region],
    })
    if (!table) throw new Error('Expected same-band table')
    const relationship = {
      id: 'same-band-table',
      kind: 'table',
      label: 'Table 2',
      captionRegionId: 'caption',
      sourceRegionIds: [region.id],
      sourceLineIds: lines.map((sourceLine) => sourceLine.id),
      sourceObjectIds: ['table-object'],
      assetIds: ['table-asset'],
      status: 'matched',
      confidence: 1,
      evidence: ['semantic-table'],
      candidates: [],
      sourceBoxes: [],
      sourceText: region.text,
      altText: 'Table 2',
      altTextSource: 'caption',
      canonicalNodeId: 'table-node',
      captionNodeId: 'caption-node',
    } satisfies PdfVisualRelationship

    expect(
      isSourceVerifiedSemanticTable({
        table,
        relationship,
        regions: [region],
        evidence: {
          confidence: 1,
          pages: [1],
          regionIds: [region.id],
          boxes: [region.box],
          links: [],
        },
      }),
    ).toBe(true)
  })

  it('verifies detector lineage for a multi-run header cell spanning multiple continuation bands', () => {
    const headerLine = line('wrapped-header-base', 0.49, [
      { text: 'Method', x: 0.1, height: 0.006 },
      { text: 'Dataset', x: 0.35, height: 0.006 },
      { text: 'Automatically', x: 0.475, height: 0.006 },
      { text: 'Scenario', x: 0.65, height: 0.006 },
      { text: 'Scope', x: 0.85, height: 0.006 },
    ])
    const continuationLines = [
      line('wrapped-header-continuation-1', 0.497, [
        { text: 'Constructed?', x: 0.48, height: 0.006 },
      ]),
      line('wrapped-header-continuation-2', 0.504, [
        { text: 'by Authors?', x: 0.485, height: 0.006 },
      ]),
    ]
    const bodyLines = [0.519, 0.545, 0.571].map((y, rowIndex) =>
      line(`wrapped-body-${rowIndex + 1}`, y, [
        { text: `Method ${rowIndex + 1}`, x: 0.1 },
        { text: rowIndex % 2 === 0 ? 'Yes' : 'No', x: 0.35 },
        { text: `Scenario ${rowIndex + 1}`, x: 0.65 },
        { text: `Scope ${rowIndex + 1}`, x: 0.85 },
      ]),
    )
    const sourceRegion = (
      id: string,
      kind: PdfPageRegion['kind'],
      sourceLines: PdfRegionLine[],
    ) => {
      const left = Math.min(...sourceLines.map((item) => item.box.x))
      const top = Math.min(...sourceLines.map((item) => item.box.y))
      const right = Math.max(
        ...sourceLines.map((item) => item.box.x + item.box.width),
      )
      const bottom = Math.max(
        ...sourceLines.map((item) => item.box.y + item.box.height),
      )
      return {
        id,
        page: 1,
        kind,
        column: 'span',
        text: sourceLines.map((item) => item.text).join(' '),
        confidence: 1,
        box: sourceBox(left, top, right - left, bottom - top),
        lines: sourceLines,
        nativeObjectIds: [],
        includedInReadingOrder: true,
      } satisfies PdfPageRegion
    }
    const header = sourceRegion('wrapped-header-region', 'header', [headerLine])
    const continuations = continuationLines.map((sourceLine, index) =>
      sourceRegion(
        `wrapped-header-continuation-region-${index + 1}`,
        'header',
        [sourceLine],
      ),
    )
    const body = sourceRegion('wrapped-body-region', 'body', bodyLines)
    const caption = {
      id: 'wrapped-table-caption',
      page: 1,
      kind: 'caption',
      column: 'span',
      text: 'Table 7. Wrapped headers.',
      confidence: 1,
      box: sourceBox(0.1, 0.61, 0.87, 0.02),
      lines: [],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const detected = detectTableNearCaption(caption, [
      header,
      ...continuations,
      body,
      caption,
    ])
    if (!detected?.headerEvidence) {
      throw new Error('Expected a detector-closed wrapped header')
    }
    const table = canonicalTableFromLines(detected.lines, {
      sourceHeaderLineIds: detected.headerEvidence.detectedHeaderLineIds,
      detectedRectangularGeometry: true,
      sourceRegions: detected.sourceRegions,
    })
    if (!table) throw new Error('Expected a source-verifiable table')
    const relationship = {
      id: 'wrapped-table-relationship',
      kind: 'table',
      label: 'Table 7',
      captionRegionId: caption.id,
      sourceRegionIds: detected.sourceRegions.map((region) => region.id),
      sourceLineIds: detected.sourceLineIds,
      sourceObjectIds: ['wrapped-table-object'],
      assetIds: ['wrapped-table-asset'],
      status: 'matched',
      confidence: 1,
      evidence: ['semantic-table'],
      candidates: [],
      sourceBoxes: detected.sourceRegions.map((region) => region.box),
      sourceText: detected.lines.map((sourceLine) => sourceLine.text).join(' '),
      altText: caption.text,
      altTextSource: 'caption',
      canonicalNodeId: 'wrapped-table-node',
      captionNodeId: 'wrapped-table-caption-node',
    } satisfies PdfVisualRelationship
    const evidence = {
      confidence: 1,
      pages: [1],
      regionIds: relationship.sourceRegionIds,
      boxes: relationship.sourceBoxes,
      links: [],
    } satisfies NodeSourceEvidence

    expect(table.rows[0].cells[1]).toMatchObject({
      text: 'Dataset Automatically Constructed? by Authors?',
      sourceRuns: [
        expect.objectContaining({ lineId: headerLine.id, text: 'Dataset' }),
        expect.objectContaining({
          lineId: headerLine.id,
          text: 'Automatically',
        }),
        expect.objectContaining({
          lineId: continuationLines[0].id,
          text: 'Constructed?',
        }),
        expect.objectContaining({
          lineId: continuationLines[1].id,
          text: 'by Authors?',
        }),
      ],
    })
    expect(
      isSourceVerifiedSemanticTable({
        table,
        relationship,
        regions: [...detected.sourceRegions, caption],
        evidence,
      }),
    ).toBe(true)

    const tampered = structuredClone(table)
    const wrappedCell = tampered.rows[0].cells[1]
    const adjacentCell = tampered.rows[0].cells[2]
    const tamperedSource = wrappedCell.sourceRuns?.pop()
    if (!tamperedSource || !adjacentCell.sourceRuns) {
      throw new Error('Expected continuation lineage')
    }
    adjacentCell.sourceRuns.unshift(tamperedSource)
    wrappedCell.text = 'Dataset Automatically Constructed?'
    adjacentCell.text = 'by Authors? Scenario'
    expect(
      isSourceVerifiedSemanticTable({
        table: tampered,
        relationship,
        regions: [...detected.sourceRegions, caption],
        evidence,
      }),
    ).toBe(false)
  })

  it('stores the same stable associations and inline semantics in the table asset XHTML', async () => {
    const { header, body, region, links } = tableFixture()

    const asset = await createTableAsset({
      sourceObjectId: 'table-source-object',
      sourceBox: region.box,
      lines: [header, body],
      sourceRegions: [region],
      links,
      pageWidth: 612,
      pageHeight: 792,
    })

    expect(asset).not.toBeNull()
    const xhtml = strFromU8(asset!.bytes)
    expect(xhtml).toContain(
      '<th id="cell-r1-c1" scope="col"><strong>Method</strong></th>',
    )
    expect(xhtml).toContain(
      '<td id="cell-r2-c1" headers="cell-r1-c1"><a href="https://example.org/method"><em>Ours</em></a></td>',
    )
    expect(xhtml).toContain(
      '<td id="cell-r2-c2" headers="cell-r1-c2"><sup>−4.2</sup></td>',
    )
  })

  it('serializes subset-prefixed Computer Modern table emphasis', async () => {
    const header = line('tex-table-header', 0.2, [
      { text: 'Model', x: 0.1, fontName: 'ABCDEF+CMBX12' },
      { text: 'Score', x: 0.5, fontName: 'ABCDEF+CMBX12' },
    ])
    const body = line('tex-table-body', 0.25, [
      { text: 's', x: 0.1, fontName: 'ABCDEF+CMMI10' },
      { text: '70.281', x: 0.5, fontName: 'ABCDEF+CMBX12' },
    ])
    const region = {
      id: 'tex-table-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'Model Score s 70.281',
      confidence: 1,
      box: sourceBox(0.1, 0.2, 0.52, 0.07),
      lines: [header, body],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion

    const table = canonicalTableFromLines([header, body], {
      sourceRegions: [region],
    })
    expect(table?.rows[0].cells[0]).toMatchObject({
      text: 'Model',
      headerScope: 'column',
      inlineRuns: [{ start: 0, end: 5, bold: true }],
      inlineMapping: { expected: 1, mapped: 1 },
    })
    expect(table?.rows[1].cells).toEqual([
      expect.objectContaining({
        text: 's',
        inlineRuns: [{ start: 0, end: 1, italic: true }],
        inlineMapping: { expected: 1, mapped: 1 },
      }),
      expect.objectContaining({
        text: '70.281',
        inlineRuns: [{ start: 0, end: 6, bold: true }],
        inlineMapping: { expected: 1, mapped: 1 },
      }),
    ])

    const asset = await createTableAsset({
      sourceObjectId: 'tex-table-source-object',
      sourceBox: region.box,
      lines: [header, body],
      sourceRegions: [region],
      pageWidth: 612,
      pageHeight: 792,
    })
    if (!asset) throw new Error('Expected Computer Modern semantic table')
    const xhtml = strFromU8(asset.bytes)
    expect(xhtml).toContain(
      '<th id="cell-r1-c1" scope="col"><strong>Model</strong></th>',
    )
    expect(xhtml).toContain(
      '<td id="cell-r2-c1" headers="cell-r1-c1"><em>s</em></td>',
    )
    expect(xhtml).toContain(
      '<td id="cell-r2-c2" headers="cell-r1-c2"><strong>70.281</strong></td>',
    )
  })

  it('rejects changed, transposed, unprovenanced, or inaccessible cells against the exact source regions', async () => {
    const { header, body, region, links } = tableFixture()
    const table = canonicalTableFromLines([header, body], {
      sourceRegions: [region],
      links,
    })
    if (!table) throw new Error('Expected source-verifiable table')
    const tableBox = sourceBox(0.1, 0.2, 0.52, 0.062)
    const asset = await createTableAsset({
      sourceObjectId: 'table-source-object',
      sourceBox: tableBox,
      lines: [header, body],
      sourceRegions: [region],
      links,
      pageWidth: 612,
      pageHeight: 792,
    })
    if (!asset) throw new Error('Expected semantic-table asset')
    const captionBox = sourceBox(0.1, 0.29, 0.52, 0.02)
    const titleLine = line('table-title-line', 0.08, [
      { text: 'Table truth', x: 0.1, bold: true, fontSize: 18 },
    ])
    const authorLine = line('table-author-line', 0.13, [
      { text: 'Ada Researcher', x: 0.1, fontSize: 11 },
    ])
    const captionLine = line('table-caption-line', 0.29, [
      { text: 'Table 1. Exact signed scores.', x: 0.1, fontSize: 9 },
    ])
    const titleRegion = {
      id: 'table-title-region',
      page: 1,
      kind: 'spanning',
      column: 'single',
      text: titleLine.text,
      confidence: 1,
      box: titleLine.box,
      lines: [titleLine],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const authorRegion = {
      id: 'table-author-region',
      page: 1,
      kind: 'spanning',
      column: 'single',
      text: authorLine.text,
      confidence: 1,
      box: authorLine.box,
      lines: [authorLine],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const caption = {
      id: 'table-caption-region',
      page: 1,
      kind: 'caption',
      column: 'single',
      text: 'Table 1. Exact signed scores.',
      confidence: 1,
      box: captionBox,
      lines: [captionLine],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const relationship = {
      id: 'table-relationship',
      kind: 'table',
      label: 'Table 1',
      captionRegionId: caption.id,
      sourceRegionIds: [region.id],
      sourceLineIds: [header.id, body.id],
      sourceObjectIds: ['table-source-object'],
      assetIds: [asset.id],
      status: 'matched',
      confidence: 1,
      evidence: ['semantic-table', 'complete-bounded-table-scope'],
      candidates: [],
      sourceBoxes: [captionBox, tableBox],
      sourceText: region.text,
      altText: caption.text,
      altTextSource: 'caption',
      canonicalNodeId: 'table-node',
      captionNodeId: 'table-caption',
    } satisfies PdfVisualRelationship
    const paper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Table truth',
      subtitle: '',
      authors: ['Ada Researcher'],
      updated: '2026-07-23',
      abstract: '',
      nodes: [
        {
          id: 'table-node',
          type: 'figure',
          title: relationship.altText,
          objectType: 'table',
          sourceText: relationship.sourceText,
          table,
          relationships: {
            caption: 'table-caption',
            assets: [asset.id],
          },
          source: 'test',
        },
        {
          id: 'table-caption',
          type: 'caption',
          text: caption.text,
          source: 'test',
        },
      ],
    } as unknown as ResearchPaper
    const provenance = {
      'table-node': {
        confidence: 1,
        pages: [1],
        regionIds: [region.id],
        boxes: [captionBox, tableBox],
        links,
        relationshipIds: [relationship.id],
      },
      'table-caption': {
        confidence: 1,
        pages: [1],
        regionIds: [caption.id],
        boxes: [captionBox],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>
    const validate = (candidate: ResearchPaper) =>
      validatedPdfVisualRelationships({
        paper: candidate,
        provenance,
        relationships: [relationship],
        assets: [asset],
        regions: [region, caption],
      })

    expect(validate(paper)).toEqual([relationship])

    const mutations = [
      (candidate: typeof table) => {
        candidate.rows[1].cells[1].text = '+4.2'
      },
      (candidate: typeof table) => {
        candidate.rows[1].cells.reverse()
      },
      (candidate: typeof table) => {
        candidate.rows[1].cells[1].sourceRuns = []
      },
      (candidate: typeof table) => {
        candidate.rows[1].cells[1].headerIds = []
      },
      (candidate: typeof table) => {
        candidate.rows[1].cells[0].inlineMapping!.mapped = 0
      },
      (candidate: typeof table) => {
        candidate.rows[1].cells[0].inlineRuns![0].annotationId =
          'wrong-table-annotation'
      },
    ]
    for (const mutate of mutations) {
      const tampered = structuredClone(paper) as ResearchPaper
      const tableNode = tampered.nodes.find((node) => node.id === 'table-node')
      if (tableNode?.type !== 'figure' || !tableNode.table) {
        throw new Error('Missing cloned table')
      }
      mutate(tableNode.table as typeof table)
      expect(validate(tampered)).toEqual([])
    }

    const staleReadyPaper = structuredClone(paper) as ResearchPaper
    const staleTableNode = staleReadyPaper.nodes.find(
      (node) => node.id === 'table-node',
    )
    if (staleTableNode?.type !== 'figure' || !staleTableNode.table) {
      throw new Error('Missing stale-ready table')
    }
    staleTableNode.table.rows[1].cells[1].text = '+4.2'
    const page = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: [titleLine, authorLine, header, body, captionLine]
        .flatMap((sourceLine) => sourceLine.runs)
        .reduce((total, run) => total + run.text.length, 0),
      imageCount: 0,
      objects: [],
      links,
      runs: [titleLine, authorLine, header, body, captionLine].flatMap(
        (sourceLine) => sourceLine.runs,
      ),
    } satisfies PdfPageAnalysis
    const lineBoundaryDecisions = [
      {
        id: 'table-line-boundary',
        page: 1,
        regionId: region.id,
        fromLineId: header.id,
        toLineId: body.id,
        outcome: 'space' as const,
        evidence: ['source-table-row-order'],
      },
    ]
    const candidateReconstruction = {
      source: {
        fileName: 'table.pdf',
        byteLength: 1,
        sha256: 'b'.repeat(64),
        pageCount: 1,
        localOnly: true,
      },
      paper,
      pages: [page],
      regions: [titleRegion, authorRegion, region, caption],
      lineBoundaryDecisions,
      unresolvedCorruptingJoinCount: 0,
      structurallyConsumedLineBoundaryCount: 0,
      readingOrder: {
        schemaVersion: '1.0.0',
        regionIds: [titleRegion.id, authorRegion.id, region.id, caption.id],
        order: [titleRegion.id, authorRegion.id, region.id, caption.id],
        edges: [],
        resolutions: [],
        acyclic: true,
        evaluation: {
          schemaVersion: '1.0.0',
          algorithm: 'deterministic-geometry-v1',
          mode: 'deterministic-only',
          regionCount: 4,
          acceptedEdgeCount: 0,
          unresolvedEdgeCount: 0,
          cycleRate: 0,
          orderAccuracy: null,
          provider: null,
          modelVersion: null,
          latencyMs: 0,
          costUsd: 0,
          reviewRequired: false,
        },
      },
      citationRelationships: [],
      crossReferenceRelationships: [],
      visualRelationships: [relationship],
      assets: [asset],
      provenance,
      humanAdjudications: {
        schemaVersion: '1.1.0',
        documentSha256: 'b'.repeat(64),
        applied: [],
        stale: [],
        countsByDiagnosticCode: {},
      },
      diagnostics: [],
      semanticSignals: {
        captions: 0,
        tables: 0,
        equations: 0,
        citations: 0,
        footnoteReferences: 0,
        footnotes: 0,
      },
      completeness: {
        expectedInlineSpanCount: 5,
        mappedInlineSpanCount: 5,
        expectedHyperlinkCount: 1,
        mappedHyperlinkCount: 1,
      },
      readiness: {
        ready: true,
        status: 'ready',
        policy: {
          minimumTextCoverage: 0.98,
          minimumAssetCoverage: 1,
          minimumRelationshipCoverage: 1,
          maximumUnresolvedObjects: 0,
          maximumOcrRequiredPages: 0,
          maximumReadingOrderDiagnostics: 0,
        },
        blockingDiagnosticCodes: [],
      },
      noteRelationships: [],
      sourceSemanticFlowBoundaryDecisions: [],
      sourceSemanticFlowBoundaryDecisionCount: 0,
      canonicalHyphenBoundaryDecisions: [],
      canonicalHyphenBoundaryDecisionCount: 0,
    } as unknown as PdfReconstruction
    const assessment = assessPdfCompleteness({
      pages: candidateReconstruction.pages,
      paper: candidateReconstruction.paper,
      diagnostics: candidateReconstruction.diagnostics,
      readingOrder: candidateReconstruction.readingOrder,
      regions: candidateReconstruction.regions,
      visualRelationships: candidateReconstruction.visualRelationships,
      assets: candidateReconstruction.assets,
      citationRelationships: candidateReconstruction.citationRelationships,
      noteRelationships: candidateReconstruction.noteRelationships,
      policy: candidateReconstruction.readiness.policy,
      lineBoundaryDecisions: candidateReconstruction.lineBoundaryDecisions,
      sourceSemanticFlowBoundaryDecisions:
        candidateReconstruction.sourceSemanticFlowBoundaryDecisions,
      sourceSemanticFlowBoundaryDecisionCount:
        candidateReconstruction.sourceSemanticFlowBoundaryDecisionCount,
      canonicalHyphenBoundaryDecisions:
        candidateReconstruction.canonicalHyphenBoundaryDecisions,
      canonicalHyphenBoundaryDecisionCount:
        candidateReconstruction.canonicalHyphenBoundaryDecisionCount,
      unresolvedCorruptingJoinCount:
        candidateReconstruction.unresolvedCorruptingJoinCount,
      structurallyConsumedLineBoundaryCount:
        candidateReconstruction.structurallyConsumedLineBoundaryCount,
      provenance: candidateReconstruction.provenance,
      inlineSpanLedger: { expected: 5, mapped: 5 },
      hyperlinkLedger: { expected: 1, mapped: 1 },
      sourceSha256: candidateReconstruction.source.sha256,
    })
    const validReadyReconstruction = {
      ...candidateReconstruction,
      semanticSignals: assessment.semanticSignals,
      completeness: assessment.completeness,
      diagnostics: assessment.diagnostics,
      readiness: assessment.readiness,
    } satisfies PdfReconstruction
    expect(validReadyReconstruction.readiness.blockingDiagnosticCodes).toEqual(
      [],
    )

    await expect(
      buildEpub(paper, validReadyReconstruction),
    ).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
    const staleReadyReconstruction = {
      ...validReadyReconstruction,
      paper: staleReadyPaper,
    }
    await expect(
      buildEpub(staleReadyPaper, staleReadyReconstruction),
    ).rejects.toThrow(/visual relationship table-relationship/i)
  })

  it('renders stable cell/header IDs, explicit data-cell associations, and cell-local semantics', () => {
    const { header, body, region, links } = tableFixture()
    const table = canonicalTableFromLines([header, body], {
      sourceRegions: [region],
      links,
    })
    if (!table) throw new Error('Expected source-verifiable table')
    const asset = {
      id: 'table-asset',
      href: 'assets/table-asset.xhtml',
      mediaType: 'application/xhtml+xml',
      kind: 'table',
      rendition: 'semantic-table',
      sha256: 'a'.repeat(64),
      bytes: new Uint8Array(),
      width: 400,
      height: 160,
      resolutionDpi: null,
      sourceObjectIds: ['table-source-object'],
      sourceBoxes: [sourceBox(0.1, 0.2, 0.52, 0.062)],
    } satisfies PdfVisualAsset
    const relationship = {
      id: 'table-relationship',
      kind: 'table',
      label: 'Table 1',
      captionRegionId: 'caption-region',
      sourceRegionIds: [region.id],
      sourceLineIds: [header.id, body.id],
      sourceObjectIds: ['table-source-object'],
      assetIds: [asset.id],
      status: 'matched',
      confidence: 1,
      evidence: ['semantic-table'],
      candidates: [],
      sourceBoxes: [],
      sourceText: region.text,
      altText: 'Table 1. Exact signed scores.',
      altTextSource: 'caption',
      canonicalNodeId: 'table-node',
      captionNodeId: 'table-caption',
    } satisfies PdfVisualRelationship
    const paper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Table truth',
      subtitle: '',
      authors: [],
      updated: '2026-07-23',
      abstract: '',
      nodes: [
        {
          id: 'table-node',
          type: 'figure',
          title: relationship.altText,
          objectType: 'table',
          sourceText: relationship.sourceText,
          table,
          relationships: {
            caption: 'table-caption',
            assets: [asset.id],
          },
          source: 'test',
        },
        {
          id: 'table-caption',
          type: 'caption',
          text: relationship.altText,
          source: 'test',
        },
      ],
    } as unknown as ResearchPaper
    const reconstruction = {
      readiness: { ready: true },
      visualRelationships: [relationship],
      assets: [asset],
    } as unknown as PdfReconstruction

    const xhtml = renderPublicationXhtml(paper, {
      reconstruction,
      visualAssets: new Map([[asset.id, asset]]),
    })

    expect(xhtml).toContain(
      '<th id="table-node-cell-r1-c1" scope="col"><strong>Method</strong></th>',
    )
    expect(xhtml).toContain(
      '<td id="table-node-cell-r2-c1" headers="table-node-cell-r1-c1"><a href="https://example.org/method"><em>Ours</em></a></td>',
    )
    expect(xhtml).toContain(
      '<td id="table-node-cell-r2-c2" headers="table-node-cell-r1-c2"><sup>−4.2</sup></td>',
    )
  })
})
