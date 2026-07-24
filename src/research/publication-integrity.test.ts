import { describe, expect, it } from 'vitest'
import type { PdfNoteRelationship } from './import-types'
import {
  assertPublicationIntegrity,
  internalReferenceIntegrityIssues,
  isBoundedScholarlyReferenceText,
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
