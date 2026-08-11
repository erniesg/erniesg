import { describe, expect, it } from 'vitest'
import type { PdfCitationRelationship } from './import-types'
import { canonicalTableWithSemanticInlineRuns } from './pdf-layout'
import type { CanonicalTable } from './visual-assets'

function box(x: number, width = 0.08) {
  return {
    page: 1,
    x,
    y: 0.4,
    width,
    height: 0.02,
    rotation: 0,
    method: 'pdf-text' as const,
  }
}

function repeatedMarkerTable(): CanonicalTable {
  return {
    rows: [
      {
        cells: [
          {
            id: 'cell-left',
            text: '[1]',
            headerScope: null,
            columnSpan: 1,
            rowSpan: 1,
            sourceRuns: [
              {
                regionId: 'table-region',
                lineId: 'left-line',
                runIndex: 0,
                text: '[1]',
                box: box(0.1),
              },
            ],
          },
          {
            id: 'cell-right',
            text: '[1]',
            headerScope: null,
            columnSpan: 1,
            rowSpan: 1,
            sourceRuns: [
              {
                regionId: 'table-region',
                lineId: 'right-line',
                runIndex: 0,
                text: '[1]',
                box: box(0.6),
              },
            ],
          },
        ],
      },
    ],
  }
}

function citation(sourceBox = box(0.6)): PdfCitationRelationship {
  return {
    id: 'citation-in-cell',
    label: '1',
    labels: ['1'],
    referenceRegionId: 'table-region',
    referenceStart: 4,
    referenceEnd: 7,
    taxonomy: 'bracketed-bibliography-citation',
    targetNodeIds: ['reference-1'],
    targets: [
      {
        label: '1',
        targetNodeId: 'reference-1',
        referenceStart: 4,
        referenceEnd: 7,
        sourceBoxes: [sourceBox],
        evidence: ['target-specific-source-geometry'],
      },
    ],
    status: 'matched',
    canonicalAnchor: { nodeId: 'table-1', start: 4, end: 7 },
    confidence: 0.98,
    evidence: ['bibliography-label-target'],
    sourceBoxes: [sourceBox],
  }
}

function ambiguousCitation(sourceBox = box(0.6)): PdfCitationRelationship {
  return {
    ...citation(sourceBox),
    targetNodeIds: [],
    candidateNodeIds: ['reference-1', 'reference-duplicate'],
    targets: [],
    status: 'ambiguous',
    evidence: ['bibliography-label-target-ambiguous'],
  }
}

describe('semantic references inside canonical table cells', () => {
  it('uses source geometry to select one cell when marker text repeats', () => {
    const table = canonicalTableWithSemanticInlineRuns({
      table: repeatedMarkerTable(),
      sourceText: '[1] [1]',
      inlineRuns: [
        {
          start: 4,
          end: 7,
          relationshipId: 'citation-in-cell',
          semanticRole: 'citation',
          targetIds: ['reference-1'],
        },
      ],
      citationRelationships: [citation()],
    })

    expect(table.rows[0].cells[0].inlineRuns).toBeUndefined()
    expect(table.rows[0].cells[1].inlineRuns).toEqual([
      {
        start: 0,
        end: 3,
        relationshipId: 'citation-in-cell',
        semanticRole: 'citation',
        targetIds: ['reference-1'],
      },
    ])
  })

  it('keeps repeated cell markers unlinked when geometry is not unique', () => {
    const broad = box(0.08, 0.65)
    const table = canonicalTableWithSemanticInlineRuns({
      table: repeatedMarkerTable(),
      sourceText: '[1] [1]',
      inlineRuns: [
        {
          start: 4,
          end: 7,
          relationshipId: 'citation-in-cell',
          semanticRole: 'citation',
          targetIds: ['reference-1'],
        },
      ],
      citationRelationships: [citation(broad)],
    })

    expect(table.rows.flatMap((row) => row.cells)).toEqual(
      expect.arrayContaining([
        expect.not.objectContaining({ inlineRuns: expect.anything() }),
      ]),
    )
    expect(
      table.rows.flatMap((row) =>
        row.cells.flatMap((cell) => cell.inlineRuns ?? []),
      ),
    ).toEqual([])
  })

  it('keeps a uniquely projected ambiguous citation targetless', () => {
    const table = canonicalTableWithSemanticInlineRuns({
      table: repeatedMarkerTable(),
      sourceText: '[1] [1]',
      inlineRuns: [
        {
          start: 4,
          end: 7,
          relationshipId: 'citation-in-cell',
          semanticRole: 'citation',
        },
      ],
      citationRelationships: [ambiguousCitation()],
    })

    expect(table.rows[0].cells[0].inlineRuns).toBeUndefined()
    expect(table.rows[0].cells[1].inlineRuns).toEqual([
      {
        start: 0,
        end: 3,
        relationshipId: 'citation-in-cell',
        semanticRole: 'citation',
      },
    ])
  })

  it('projects matched and ambiguous note markers into their proven cells', () => {
    const matched = canonicalTableWithSemanticInlineRuns({
      table: repeatedMarkerTable(),
      sourceText: '[1] [1]',
      inlineRuns: [],
      citationRelationships: [],
      noteReferences: [
        {
          id: 'matched-cell-note',
          label: '1',
          target: 'note-body-1',
          start: 4,
          end: 7,
          confidence: 0.98,
          status: 'matched',
          referenceRegionId: 'table-region',
          sourceBoxes: [box(0.6)],
        },
      ],
    })
    expect(matched.rows[0].cells[0].noteReferences).toBeUndefined()
    expect(matched.rows[0].cells[1].noteReferences).toEqual([
      expect.objectContaining({
        id: 'matched-cell-note',
        target: 'note-body-1',
        start: 0,
        end: 3,
      }),
    ])

    const ambiguous = canonicalTableWithSemanticInlineRuns({
      table: repeatedMarkerTable(),
      sourceText: '[1] [1]',
      inlineRuns: [],
      citationRelationships: [],
      noteReferences: [
        {
          id: 'ambiguous-cell-note',
          label: '1',
          target: null,
          start: 4,
          end: 7,
          confidence: 0.85,
          status: 'ambiguous',
          referenceRegionId: 'table-region',
          sourceBoxes: [box(0.6)],
        },
      ],
    })
    expect(ambiguous.rows[0].cells[1].noteReferences).toBeUndefined()
    expect(ambiguous.rows[0].cells[1].inlineRuns).toEqual([
      {
        start: 0,
        end: 3,
        relationshipId: 'ambiguous-cell-note',
        semanticRole: 'note-reference',
      },
    ])
  })
})
