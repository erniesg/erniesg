import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfNoteRelationship,
  PdfPageRegion,
} from './import-types'
import {
  assertPublicationIntegrity,
  internalReferenceIntegrityIssues,
  isBoundedScholarlyReferenceText,
  validMatchedSemanticNoteRelationshipIds,
} from './publication-integrity'
import { assessPdfCompleteness } from './pdf-quality'
import type { ResearchPaper } from './schema'

type AnchoredNoteRelationship = PdfNoteRelationship & {
  canonicalAnchor:
    | { kind: 'node'; nodeId: string; start: number; end: number }
    | { kind: 'author'; author: string }
    | null
}

function paperFixture(): ResearchPaper {
  return {
    id: 'note-integrity-paper',
    version: '1.0.0',
    status: 'published',
    title: 'Exact note integrity',
    subtitle: 'Test fixture',
    authors: ['Ada Example'],
    authorNotes: [
      {
        id: 'author-note-reference',
        author: 'Ada Example',
        label: '*',
        target: 'author-note',
      },
    ],
    updated: '2026-07-23',
    abstract: 'A canonical note integrity fixture.',
    nodes: [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'A1 B2',
        noteReferences: [
          {
            id: 'claim-note-reference',
            label: '1',
            target: 'claim-note',
            start: 1,
            end: 2,
            confidence: 1,
          },
        ],
        source: 'test',
      },
      {
        id: 'claim-note',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        text: 'The claim note.',
        relationships: { backlinks: ['claim-note-reference'] },
        source: 'test',
      },
      {
        id: 'author-note',
        type: 'footnote',
        kind: 'footnote',
        label: '*',
        text: 'The author note.',
        relationships: { backlinks: ['author-note-reference'] },
        source: 'test',
      },
    ],
  }
}

function relationshipFixture(): AnchoredNoteRelationship[] {
  return [
    {
      id: 'claim-note-reference',
      label: '1',
      referenceRegionId: 'source-claim',
      referenceStart: 1,
      referenceEnd: 2,
      targetNoteId: 'claim-note',
      status: 'matched',
      canonicalAnchor: {
        kind: 'node',
        nodeId: 'claim',
        start: 1,
        end: 2,
      },
      confidence: 1,
      threshold: 0.72,
      evidence: ['test'],
      candidates: [],
      sourceBoxes: [],
    },
    {
      id: 'author-note-reference',
      label: '*',
      referenceRegionId: 'source-authors',
      referenceStart: 11,
      referenceEnd: 12,
      targetNoteId: 'author-note',
      status: 'matched',
      canonicalAnchor: { kind: 'author', author: 'Ada Example' },
      confidence: 1,
      threshold: 0.72,
      evidence: ['test'],
      candidates: [],
      sourceBoxes: [],
    },
  ]
}

function sourceBox(
  x: number,
  y: number,
  width: number,
  height = 0.02,
): NormalizedSourceBox {
  return {
    page: 1,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text',
  }
}

function sourceRegion(
  id: string,
  text: string,
  box: NormalizedSourceBox,
): PdfPageRegion {
  return {
    id,
    page: box.page,
    kind: 'body',
    column: 'single',
    text,
    confidence: 1,
    box,
    lines: [
      {
        id: `${id}-line`,
        text,
        fontSize: 10,
        box,
        runs: [
          {
            ...box,
            text,
            fontName: 'Body',
            fontSize: 10,
            confidence: 1,
          },
        ],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function sourceEvidenceFixture() {
  const relationships = relationshipFixture()
  const claimBox = sourceBox(0.1, 0.2, 0.3)
  const authorBox = sourceBox(0.1, 0.1, 0.3)
  relationships[0].sourceBoxes = [sourceBox(0.16, 0.2, 0.01)]
  relationships[1].sourceBoxes = [sourceBox(0.37, 0.1, 0.01)]
  return {
    relationships,
    sourceEvidence: {
      regions: [
        sourceRegion('source-claim', 'A1 B2', claimBox),
        sourceRegion('source-authors', 'Ada Example*', authorBox),
      ],
      provenance: {
        claim: {
          confidence: 1,
          pages: [1],
          regionIds: ['source-claim'],
          boxes: [claimBox],
          links: [],
        },
      } satisfies Record<string, NodeSourceEvidence>,
    },
  }
}

function issueDetails(
  paper: ResearchPaper,
  relationships?: readonly AnchoredNoteRelationship[],
) {
  return internalReferenceIntegrityIssues(paper, relationships).map(
    (issue) => issue.detail,
  )
}

describe('exact semantic note-anchor integrity', () => {
  it('accepts a complete node-anchor and author-anchor bijection', () => {
    const paper = paperFixture()
    const relationships = relationshipFixture()

    expect(internalReferenceIntegrityIssues(paper, relationships)).toEqual([])
    expect(() => assertPublicationIntegrity(paper, relationships)).not.toThrow()
  })

  it('rejects a matched relationship whose canonical node offsets are stale', () => {
    const paper = paperFixture()
    const relationships = relationshipFixture()
    relationships[0].canonicalAnchor = {
      kind: 'node',
      nodeId: 'claim',
      start: 0,
      end: 2,
    }

    expect(issueDetails(paper, relationships)).toContain('note-anchor-mismatch')
  })

  it('accepts exact node and author source evidence without inventing author provenance', () => {
    const { relationships, sourceEvidence } = sourceEvidenceFixture()

    expect(
      internalReferenceIntegrityIssues(
        paperFixture(),
        relationships,
        sourceEvidence,
      ),
    ).toEqual([])
    expect(() =>
      assertPublicationIntegrity(paperFixture(), relationships, sourceEvidence),
    ).not.toThrow()
  })

  it('accepts a bounded bracketed source marker for the same canonical label', () => {
    const { relationships, sourceEvidence } = sourceEvidenceFixture()
    const claimRegion = sourceEvidence.regions[0]
    claimRegion.text = 'A[1] B2'
    claimRegion.lines[0].text = claimRegion.text
    claimRegion.lines[0].runs[0].text = claimRegion.text
    relationships[0].referenceStart = 1
    relationships[0].referenceEnd = 4

    expect(
      internalReferenceIntegrityIssues(
        paperFixture(),
        relationships,
        sourceEvidence,
      ),
    ).toEqual([])
  })

  it.each([
    { marker: '[1; 2]', label: '1,2' },
    { marker: '[1–3]', label: '1,2,3' },
    { marker: '†', label: '†' },
    { marker: '¹˒²', label: '1,2' },
  ])('accepts the fully bounded note marker $marker', ({ marker, label }) => {
    const paper = paperFixture()
    const claim = paper.nodes[0]
    const note = paper.nodes[1]
    if (claim.type !== 'paragraph' || note.type !== 'footnote') {
      throw new Error('missing canonical note fixture')
    }
    claim.text = `A${label} B`
    claim.noteReferences![0].label = label
    claim.noteReferences![0].start = 1
    claim.noteReferences![0].end = 1 + label.length
    note.label = label

    const { relationships, sourceEvidence } = sourceEvidenceFixture()
    const relationship = relationships[0]
    relationship.label = label
    relationship.referenceStart = 0
    relationship.referenceEnd = marker.length
    relationship.canonicalAnchor = {
      kind: 'node',
      nodeId: 'claim',
      start: 1,
      end: 1 + label.length,
    }
    const claimRegion = sourceEvidence.regions[0]
    claimRegion.text = marker
    claimRegion.lines[0].text = marker
    claimRegion.lines[0].runs[0].text = marker

    expect(
      internalReferenceIntegrityIssues(paper, relationships, sourceEvidence),
    ).toEqual([])
  })

  it.each(['[1] trailing prose', 'leading prose [1]'])(
    'rejects a source span containing prose around marker %s',
    (marker) => {
      const { relationships, sourceEvidence } = sourceEvidenceFixture()
      const claimRegion = sourceEvidence.regions[0]
      claimRegion.text = marker
      claimRegion.lines[0].text = marker
      claimRegion.lines[0].runs[0].text = marker
      relationships[0].referenceStart = 0
      relationships[0].referenceEnd = marker.length

      expect(
        internalReferenceIntegrityIssues(
          paperFixture(),
          relationships,
          sourceEvidence,
        ).map((issue) => issue.detail),
      ).toContain('invalid-source-note-anchor')
      expect(
        validMatchedSemanticNoteRelationshipIds(
          paperFixture(),
          relationships,
          sourceEvidence,
        ).has(relationships[0].id),
      ).toBe(false)
    },
  )

  it('rejects matched note evidence whose source region does not exist', () => {
    const { relationships, sourceEvidence } = sourceEvidenceFixture()
    relationships[0].referenceRegionId = 'missing-source-claim'

    expect(
      internalReferenceIntegrityIssues(
        paperFixture(),
        relationships,
        sourceEvidence,
      ).map((issue) => issue.detail),
    ).toContain('invalid-source-note-anchor')
  })

  it.each([
    {
      label: 'out-of-range source offset',
      mutate: (relationship: AnchoredNoteRelationship) => {
        relationship.referenceEnd = 99
      },
    },
    {
      label: 'source label mismatch',
      mutate: (relationship: AnchoredNoteRelationship) => {
        relationship.label = '9'
      },
    },
  ])('rejects a matched note with a $label', ({ mutate }) => {
    const { relationships, sourceEvidence } = sourceEvidenceFixture()
    mutate(relationships[0])

    expect(
      internalReferenceIntegrityIssues(
        paperFixture(),
        relationships,
        sourceEvidence,
      ).map((issue) => issue.detail),
    ).toContain('invalid-source-note-anchor')
  })

  it.each([
    {
      label: 'missing source box',
      sourceBoxes: [],
    },
    {
      label: 'zero-area source box',
      sourceBoxes: [sourceBox(0.16, 0.2, 0)],
    },
    {
      label: 'non-overlapping source box',
      sourceBoxes: [sourceBox(0.8, 0.8, 0.01)],
    },
  ])('rejects a matched note with a $label', ({ sourceBoxes }) => {
    const { relationships, sourceEvidence } = sourceEvidenceFixture()
    relationships[0].sourceBoxes = sourceBoxes

    expect(
      internalReferenceIntegrityIssues(
        paperFixture(),
        relationships,
        sourceEvidence,
      ).map((issue) => issue.detail),
    ).toContain('invalid-source-note-anchor')
  })

  it('rejects a source region absent from the canonical owner provenance', () => {
    const { relationships, sourceEvidence } = sourceEvidenceFixture()
    sourceEvidence.provenance.claim.regionIds = ['source-authors']

    expect(
      internalReferenceIntegrityIssues(
        paperFixture(),
        relationships,
        sourceEvidence,
      ).map((issue) => issue.detail),
    ).toContain('invalid-source-note-anchor')
  })

  it('binds a table note anchor to the exact source cell when labels repeat', () => {
    const markerBox = sourceBox(0.2, 0.4, 0.01)
    const tableBox = sourceBox(0.1, 0.4, 0.7)
    const leftCellBox = sourceBox(0.1, 0.4, 0.2)
    const rightCellBox = sourceBox(0.55, 0.4, 0.2)
    const reference = {
      id: 'table-note-reference',
      label: '1',
      target: 'table-note',
      start: 4,
      end: 5,
      confidence: 1,
    }
    const paper: ResearchPaper = {
      ...paperFixture(),
      authorNotes: undefined,
      nodes: [
        {
          id: 'table-node',
          type: 'figure',
          title: 'Table 1.',
          objectType: 'table',
          table: {
            rows: [
              {
                cells: [
                  {
                    id: 'cell-left',
                    text: 'Left1',
                    headerScope: null,
                    columnSpan: 1,
                    rowSpan: 1,
                    sourceRuns: [
                      {
                        regionId: 'table-source',
                        lineId: 'table-line',
                        runIndex: 0,
                        text: 'Left1',
                        box: leftCellBox,
                      },
                    ],
                    noteReferences: [reference],
                  },
                  {
                    id: 'cell-right',
                    text: 'Right1',
                    headerScope: null,
                    columnSpan: 1,
                    rowSpan: 1,
                    sourceRuns: [
                      {
                        regionId: 'table-source',
                        lineId: 'table-line',
                        runIndex: 1,
                        text: 'Right1',
                        box: rightCellBox,
                      },
                    ],
                  },
                ],
              },
            ],
          },
          relationships: { caption: 'table-caption' },
          source: 'test',
        },
        {
          id: 'table-caption',
          type: 'caption',
          text: 'Table 1.',
          source: 'test',
        },
        {
          id: 'table-note',
          type: 'footnote',
          kind: 'footnote',
          label: '1',
          text: 'The table note.',
          relationships: { backlinks: ['table-note-reference'] },
          source: 'test',
        },
      ],
    }
    const relationship: AnchoredNoteRelationship = {
      ...relationshipFixture()[0],
      id: 'table-note-reference',
      referenceRegionId: 'table-source',
      referenceStart: 4,
      referenceEnd: 5,
      targetNoteId: 'table-note',
      canonicalAnchor: {
        kind: 'node',
        nodeId: 'table-node:table:cell-left',
        start: 4,
        end: 5,
      },
      sourceBoxes: [markerBox],
    }
    const sourceEvidence = {
      regions: [sourceRegion('table-source', 'Left1 Right1', tableBox)],
      provenance: {
        'table-node': {
          confidence: 1,
          pages: [1],
          regionIds: ['table-source'],
          boxes: [tableBox],
          links: [],
        },
      } satisfies Record<string, NodeSourceEvidence>,
    }

    expect(
      internalReferenceIntegrityIssues(paper, [relationship], sourceEvidence),
    ).toEqual([])

    const table = paper.nodes[0]
    if (table.type !== 'figure' || !table.table) {
      throw new Error('missing table fixture')
    }
    table.table.rows[0].cells[0].noteReferences = undefined
    table.table.rows[0].cells[1].noteReferences = [
      { ...reference, start: 5, end: 6 },
    ]
    relationship.canonicalAnchor = {
      kind: 'node',
      nodeId: 'table-node:table:cell-right',
      start: 5,
      end: 6,
    }

    expect(
      internalReferenceIntegrityIssues(paper, [relationship], sourceEvidence),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: 'invalid-source-note-anchor' }),
      ]),
    )
  })

  it('rejects a matched author relationship owned by a different author', () => {
    const paper = paperFixture()
    const relationships = relationshipFixture()
    relationships[1].canonicalAnchor = {
      kind: 'author',
      author: 'Grace Example',
    }

    expect(issueDetails(paper, relationships)).toContain('note-anchor-mismatch')
  })

  it('requires every matched relationship and rendered reference to map one-to-one', () => {
    const paper = paperFixture()
    const relationships = relationshipFixture()
    const missingRendered = {
      ...relationships[0],
      id: 'missing-rendered-reference',
      referenceStart: 3,
      referenceEnd: 4,
      canonicalAnchor: {
        kind: 'node' as const,
        nodeId: 'claim',
        start: 3,
        end: 4,
      },
    }

    expect(issueDetails(paper, [relationships[1]])).toContain(
      'missing-note-relationship',
    )
    expect(issueDetails(paper, [...relationships, missingRendered])).toContain(
      'missing-rendered-note-reference',
    )
  })

  it('requires relationship, rendered reference, footnote target, and backlink targets to agree', () => {
    const paper = paperFixture()
    const relationships = relationshipFixture()
    relationships[0].targetNoteId = 'author-note'

    expect(issueDetails(paper, relationships)).toContain('note-target-mismatch')
  })

  it('rejects duplicate and overlapping canonical node anchors', () => {
    const duplicatePaper = paperFixture()
    const claim = duplicatePaper.nodes[0]
    if (claim.type !== 'paragraph') throw new Error('missing claim paragraph')
    claim.noteReferences!.push({
      id: 'duplicate-anchor-reference',
      label: '2',
      target: 'author-note',
      start: 1,
      end: 2,
      confidence: 1,
    })
    duplicatePaper.nodes[2].type === 'footnote' &&
      duplicatePaper.nodes[2].relationships.backlinks.push(
        'duplicate-anchor-reference',
      )
    const duplicateRelationships = relationshipFixture()
    duplicateRelationships.push({
      ...duplicateRelationships[0],
      id: 'duplicate-anchor-reference',
      label: '2',
      targetNoteId: 'author-note',
      referenceStart: 3,
      referenceEnd: 4,
    })

    expect(issueDetails(duplicatePaper, duplicateRelationships)).toContain(
      'duplicate-canonical-note-anchor',
    )

    const overlappingPaper = paperFixture()
    const overlappingClaim = overlappingPaper.nodes[0]
    if (overlappingClaim.type !== 'paragraph') {
      throw new Error('missing claim paragraph')
    }
    overlappingClaim.noteReferences![0].end = 3
    overlappingClaim.noteReferences!.push({
      id: 'overlapping-anchor-reference',
      label: '2',
      target: 'author-note',
      start: 2,
      end: 4,
      confidence: 1,
    })
    overlappingPaper.nodes[2].type === 'footnote' &&
      overlappingPaper.nodes[2].relationships.backlinks.push(
        'overlapping-anchor-reference',
      )
    const overlappingRelationships = relationshipFixture()
    overlappingRelationships[0].canonicalAnchor = {
      kind: 'node',
      nodeId: 'claim',
      start: 1,
      end: 3,
    }
    overlappingRelationships.push({
      ...overlappingRelationships[0],
      id: 'overlapping-anchor-reference',
      label: '2',
      targetNoteId: 'author-note',
      referenceStart: 3,
      referenceEnd: 4,
      canonicalAnchor: {
        kind: 'node',
        nodeId: 'claim',
        start: 2,
        end: 4,
      },
    })

    expect(issueDetails(overlappingPaper, overlappingRelationships)).toContain(
      'overlapping-canonical-note-anchor',
    )
  })

  it('rejects duplicate and overlapping source offsets independently of canonical offsets', () => {
    const paper = paperFixture()
    const claim = paper.nodes[0]
    if (claim.type !== 'paragraph') throw new Error('missing claim paragraph')
    claim.noteReferences!.push({
      id: 'second-claim-reference',
      label: '2',
      target: 'author-note',
      start: 4,
      end: 5,
      confidence: 1,
    })
    paper.nodes[2].type === 'footnote' &&
      paper.nodes[2].relationships.backlinks.push('second-claim-reference')
    const relationships = relationshipFixture()
    relationships.push({
      ...relationships[0],
      id: 'second-claim-reference',
      label: '2',
      targetNoteId: 'author-note',
      canonicalAnchor: {
        kind: 'node',
        nodeId: 'claim',
        start: 4,
        end: 5,
      },
    })

    expect(issueDetails(paper, relationships)).toContain(
      'duplicate-source-note-anchor',
    )

    relationships[2].referenceStart = 1
    relationships[2].referenceEnd = 3

    expect(issueDetails(paper, relationships)).toContain(
      'overlapping-source-note-anchor',
    )
  })

  it('rejects duplicate backlinks instead of treating includes() as exact membership', () => {
    const paper = paperFixture()
    const note = paper.nodes[1]
    if (note.type !== 'footnote') throw new Error('missing claim note')
    note.relationships.backlinks.push('claim-note-reference')

    expect(issueDetails(paper, relationshipFixture())).toContain(
      'duplicate-note-backlink',
    )
  })

  it('blocks empty-backlink footnotes only once the paper claims publication quality', () => {
    const paper = paperFixture()
    const note = paper.nodes[1]
    if (note.type !== 'footnote') throw new Error('missing claim note')
    note.relationships.backlinks = []
    const claim = paper.nodes[0]
    if (claim.type !== 'paragraph') throw new Error('missing claim paragraph')
    claim.noteReferences = []

    expect(issueDetails(paper, [relationshipFixture()[1]])).toContain(
      'published-orphan-footnote',
    )

    paper.status = 'review'
    expect(issueDetails(paper, [relationshipFixture()[1]])).not.toContain(
      'published-orphan-footnote',
    )
  })

  it('leaves unresolved relationship candidates diagnostic rather than blocking publication integrity', () => {
    const paper = paperFixture()
    paper.status = 'working'
    paper.authorNotes = undefined
    paper.nodes = [
      {
        id: 'unowned-note',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        text: 'A retained diagnostic note.',
        relationships: { backlinks: [] },
        source: 'test',
      },
    ]
    const unresolved: AnchoredNoteRelationship = {
      ...relationshipFixture()[0],
      targetNoteId: null,
      status: 'unresolved',
      canonicalAnchor: null,
    }

    expect(internalReferenceIntegrityIssues(paper, [unresolved])).toEqual([])
  })

  it('excludes table-cell notes when their semantic table is not rendered', () => {
    const paper = paperFixture()
    paper.status = 'working'
    paper.authorNotes = undefined
    paper.nodes = [
      {
        id: 'table-with-note',
        type: 'figure',
        title: 'Table with note',
        objectType: 'table',
        table: {
          rows: [
            {
              cells: [
                {
                  id: 'cell-1',
                  text: 'Value1',
                  headerScope: null,
                  columnSpan: 1,
                  rowSpan: 1,
                  noteReferences: [
                    {
                      id: 'table-note-reference',
                      label: '1',
                      target: 'table-note',
                      start: 5,
                      end: 6,
                      confidence: 1,
                    },
                  ],
                },
              ],
            },
          ],
        },
        relationships: { caption: 'table-caption' },
        source: 'test',
      },
      {
        id: 'table-caption',
        type: 'caption',
        text: 'Table 1.',
        source: 'test',
      },
      {
        id: 'table-note',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        text: 'The table note.',
        relationships: { backlinks: ['table-note-reference'] },
        source: 'test',
      },
    ]

    expect(
      internalReferenceIntegrityIssues(paper, undefined, undefined, {
        renderedSemanticTableNodeIds: new Set(),
      }),
    ).toContainEqual(
      expect.objectContaining({
        sourceId: 'table-note',
        targetId: 'table-note-reference',
        relationship: 'note-backlink',
      }),
    )
    expect(
      internalReferenceIntegrityIssues(paper, undefined, undefined, {
        renderedSemanticTableNodeIds: new Set(['table-with-note']),
      }),
    ).toEqual([])
  })

  it('feeds exact note-anchor failures into the publication-readiness gate', () => {
    const relationships = relationshipFixture()
    relationships[0].canonicalAnchor = {
      kind: 'node',
      nodeId: 'claim',
      start: 0,
      end: 2,
    }

    const result = assessPdfCompleteness({
      pages: [],
      paper: paperFixture(),
      diagnostics: [],
      noteRelationships: relationships,
    })

    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'DANGLING_EPUB_INTERNAL_REFERENCE',
    )
  })
})

describe('scholarly cross-reference integrity', () => {
  it('rejects a rendered scholarly cross reference with a missing canonical target', () => {
    const paper = paperFixture()
    const claim = paper.nodes.find((node) => node.id === 'claim')
    if (!claim || claim.type !== 'paragraph') {
      throw new Error('missing claim paragraph')
    }
    claim.text = 'See Figure 4.'
    claim.noteReferences = undefined
    claim.inlineRuns = [
      {
        start: 4,
        end: 12,
        semanticRole: 'cross-reference',
        relationshipId: 'cross-reference-figure-4',
        targetIds: ['missing-figure-4'],
      },
    ]
    paper.nodes = paper.nodes.filter((node) => node.id !== 'claim-note')

    expect(internalReferenceIntegrityIssues(paper)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
          sourceId: 'cross-reference-figure-4',
          targetId: 'missing-figure-4',
          relationship: 'cross-reference-target',
        }),
      ]),
    )
  })

  it('rejects a semantic cross-reference run that absorbs unrelated prose', () => {
    const paper = paperFixture()
    paper.status = 'working'
    paper.authorNotes = undefined
    paper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Eq. (3) is the generator equation for the full model.',
        inlineRuns: [
          {
            start: 0,
            end: 51,
            semanticRole: 'cross-reference',
            relationshipId: 'cross-reference-equation-3',
            targetIds: ['equation-3'],
          },
        ],
        source: 'test',
      },
      {
        id: 'equation-3',
        type: 'figure',
        objectType: 'equation',
        title: 'Equation 3',
        relationships: { caption: 'equation-3-caption' },
        source: 'test',
      },
      {
        id: 'equation-3-caption',
        type: 'caption',
        text: 'Equation 3.',
        source: 'test',
      },
    ]

    expect(internalReferenceIntegrityIssues(paper)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'cross-reference-equation-3',
          relationship: 'semantic-reference-text',
          detail: 'unbounded-scholarly-reference-text',
        }),
      ]),
    )
    expect(() => assertPublicationIntegrity(paper)).toThrow(
      /unbounded-scholarly-reference-text/u,
    )
  })

  it('rejects a table-cell cross-reference run that absorbs unrelated prose', () => {
    const paper = paperFixture()
    paper.status = 'working'
    paper.authorNotes = undefined
    paper.nodes = [
      {
        id: 'section-1',
        type: 'heading',
        level: 1,
        text: 'Section 1',
        source: 'test',
      },
      {
        id: 'table-1',
        type: 'figure',
        title: 'Table 1',
        objectType: 'table',
        table: {
          rows: [
            {
              cells: [
                {
                  text: 'ordinary prose',
                  headerScope: null,
                  columnSpan: 1,
                  rowSpan: 1,
                  inlineRuns: [
                    {
                      start: 0,
                      end: 14,
                      semanticRole: 'cross-reference',
                      relationshipId: 'cross-reference-section-1',
                      targetIds: ['section-1'],
                    },
                  ],
                },
              ],
            },
          ],
        },
        relationships: { caption: 'table-1-caption' },
        source: 'test',
      },
      {
        id: 'table-1-caption',
        type: 'caption',
        text: 'Table 1.',
        source: 'test',
      },
    ]

    expect(internalReferenceIntegrityIssues(paper)).toContainEqual(
      expect.objectContaining({
        sourceId: 'cross-reference-section-1',
        targetId: 'section-1',
        relationship: 'semantic-reference-text',
        detail: 'unbounded-scholarly-reference-text',
      }),
    )
    expect(() => assertPublicationIntegrity(paper)).toThrow(
      /unbounded-scholarly-reference-text/u,
    )
    expect(
      internalReferenceIntegrityIssues(paper, undefined, undefined, {
        renderedSemanticTableNodeIds: new Set(),
      }),
    ).toEqual([])
  })

  it('accepts an exact scholarly range token as one bounded semantic run', () => {
    const paper = paperFixture()
    paper.status = 'working'
    paper.authorNotes = undefined
    paper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Equations (2)–(3) preserve the martingale.',
        inlineRuns: [
          {
            start: 0,
            end: 17,
            semanticRole: 'cross-reference',
            relationshipId: 'cross-reference-equations-2-3',
            targetIds: ['equation-2', 'equation-3'],
          },
        ],
        source: 'test',
      },
      ...[2, 3].flatMap((ordinal) => [
        {
          id: `equation-${ordinal}`,
          type: 'figure' as const,
          objectType: 'equation' as const,
          title: `Equation ${ordinal}`,
          relationships: { caption: `equation-${ordinal}-caption` },
          source: 'test',
        },
        {
          id: `equation-${ordinal}-caption`,
          type: 'caption' as const,
          text: `Equation ${ordinal}.`,
          source: 'test',
        },
      ]),
    ]

    expect(internalReferenceIntegrityIssues(paper)).toEqual([])
  })

  it('accepts a compact scholarly range inside one pair of parentheses', () => {
    const paper = paperFixture()
    paper.status = 'working'
    paper.authorNotes = undefined
    paper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Eqs. (4.17-4.19) establish the objective.',
        inlineRuns: [
          {
            start: 0,
            end: 16,
            semanticRole: 'cross-reference',
            relationshipId: 'cross-reference-equations-4-17-4-19',
            targetIds: ['equation-4.17', 'equation-4.18', 'equation-4.19'],
          },
        ],
        source: 'test',
      },
      ...['4.17', '4.18', '4.19'].flatMap((ordinal) => [
        {
          id: `equation-${ordinal}`,
          type: 'figure' as const,
          objectType: 'equation' as const,
          title: `Equation ${ordinal}`,
          relationships: { caption: `equation-${ordinal}-caption` },
          source: 'test',
        },
        {
          id: `equation-${ordinal}-caption`,
          type: 'caption' as const,
          text: `Equation ${ordinal}.`,
          source: 'test',
        },
      ]),
    ]

    expect(internalReferenceIntegrityIssues(paper)).toEqual([])
  })

  it.each(['Table II', 'Table IV', 'Table IX'])(
    'accepts canonical uppercase Roman scholarly reference %j',
    (value) => {
      expect(isBoundedScholarlyReferenceText(value)).toBe(true)
    },
  )

  it.each([
    'Table ii',
    'Table mix',
    'Table MCMC',
    'Table IVX',
    'Section civil',
  ])('rejects noncanonical Roman-looking reference prose %j', (value) => {
    expect(isBoundedScholarlyReferenceText(value)).toBe(false)
  })

  it.each(['-', '–', '—'])(
    'accepts bounded compact equation ranges using supported connector %j',
    (connector) => {
      expect(
        isBoundedScholarlyReferenceText(`Eqs. (4.17${connector}4.19)`),
      ).toBe(true)
    },
  )

  it.each(['−', '‑', '‒'])(
    'rejects unsupported Unicode equation-range connector %j',
    (connector) => {
      expect(
        isBoundedScholarlyReferenceText(`Eqs. (4.17${connector}4.19)`),
      ).toBe(false)
    },
  )

  it('accepts a bare non-Roman appendix letter as a bounded reference', () => {
    const paper = paperFixture()
    paper.status = 'working'
    paper.authorNotes = undefined
    paper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Appendix E contains the robustness results.',
        inlineRuns: [
          {
            start: 0,
            end: 10,
            semanticRole: 'cross-reference',
            relationshipId: 'cross-reference-appendix-e',
            targetIds: ['appendix-e'],
          },
        ],
        source: 'test',
      },
      {
        id: 'appendix-e',
        type: 'heading',
        level: 1,
        text: 'Appendix E',
        source: 'test',
      },
    ]

    expect(internalReferenceIntegrityIssues(paper)).toEqual([])
  })
})
