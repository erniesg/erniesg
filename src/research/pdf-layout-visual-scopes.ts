import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  PdfScholarlyCrossReferenceRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import { orderCanonicalVisualPairs } from './pdf-layout'
import type { ResearchNode } from './schema'

function visualOrderHeading(
  id: string,
  level: 1 | 2 | 3,
  text: string,
): ResearchNode {
  return {
    id,
    type: 'heading',
    level,
    text,
    source: 'pdf:test#page=1',
  }
}

function visualOrderParagraph(id: string, text: string): ResearchNode {
  return {
    id,
    type: 'paragraph',
    text,
    source: 'pdf:test#page=1',
  }
}

function visualOrderFigure(id: string, captionId: string): ResearchNode {
  return {
    id,
    type: 'figure',
    objectType: 'figure',
    title: 'Figure 21. Source-backed result.',
    relationships: {
      caption: captionId,
      assets: [`asset-${id}`],
    },
    source: 'pdf:test#page=4',
  }
}

function visualOrderCaption(
  id: string,
): Extract<ResearchNode, { type: 'caption' }> {
  return {
    id,
    type: 'caption',
    text: 'Figure 21. Source-backed result.',
    source: 'pdf:test#page=4',
  }
}

function matchedVisualOrderReference({
  id,
  anchorNodeId,
  referenceRegionId,
  visualNodeId,
  page,
  y,
}: {
  id: string
  anchorNodeId: string
  referenceRegionId: string
  visualNodeId: string
  page: number
  y: number
}): PdfScholarlyCrossReferenceRelationship {
  return {
    id,
    kind: 'figure',
    text: 'Figure 21',
    labels: ['Figure 21'],
    referenceRegionId,
    referenceStart: 0,
    referenceEnd: 9,
    targets: [
      {
        kind: 'figure',
        label: 'Figure 21',
        referenceStart: 0,
        referenceEnd: 9,
        status: 'matched',
        candidateNodeIds: [visualNodeId],
        targetNodeId: visualNodeId,
        evidence: ['canonical-label-unique'],
      },
    ],
    targetNodeIds: [visualNodeId],
    status: 'matched',
    canonicalAnchor: {
      nodeId: anchorNodeId,
      start: 0,
      end: 9,
    },
    confidence: 1,
    evidence: ['explicit-scholarly-cross-reference-syntax'],
    sourceBoxes: [
      {
        page,
        x: 0.1,
        y,
        width: 0.36,
        height: 0.04,
        rotation: 0,
        method: 'pdf-text',
      },
    ],
  }
}

describe('PDF semantic reconstruction', () => {
  it('does not relocate a physical float into a later cross-reference scope', () => {
    const visualNodeId = 'visual-before-later-reference'
    const captionNodeId = 'caption-before-later-reference'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 Physical figure scope'),
      visualOrderParagraph('scope-a-prose', 'Earlier prose remains unchanged.'),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
      visualOrderHeading('scope-b', 2, 'A.2 Later discussion'),
      visualOrderParagraph(
        'later-reference',
        'The later discussion cross-references Figure 21.',
      ),
      visualOrderHeading('scope-c', 2, 'A.3 Following discussion'),
    ]
    const laterReference = matchedVisualOrderReference({
      id: 'cross-reference-later-physical-scope',
      anchorNodeId: 'later-reference',
      referenceRegionId: 'later-reference-region',
      visualNodeId,
      page: 2,
      y: 0.3,
    })
    const sourceOrder = nodes.map((node) => node.id)
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 1,
          column: 'left',
          sourceBox: {
            page: 1,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId,
          captionNodeId,
        },
      ],
      [laterReference],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          severity: 'info',
          relationshipId: laterReference.id,
        }),
      ]),
    )
  })

  it('preserves sequential figure labels when a later section references the earlier float', () => {
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 First physical scope'),
      visualOrderFigure('visual-five', 'caption-five'),
      {
        ...visualOrderCaption('caption-five'),
        text: 'Figure 5. First source-backed result.',
      },
      visualOrderHeading('scope-b', 2, 'A.2 Second physical scope'),
      visualOrderParagraph(
        'later-reference',
        'The second discussion revisits Figure 21.',
      ),
      visualOrderFigure('visual-six', 'caption-six'),
      {
        ...visualOrderCaption('caption-six'),
        text: 'Figure 6. Second source-backed result.',
      },
    ]
    const laterReference = matchedVisualOrderReference({
      id: 'cross-reference-later-sequential-float',
      anchorNodeId: 'later-reference',
      referenceRegionId: 'later-reference-region',
      visualNodeId: 'visual-five',
      page: 2,
      y: 0.3,
    })

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 1,
          column: 'left',
          sourceBox: {
            page: 1,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-five',
          captionNodeId: 'caption-five',
        },
        {
          page: 2,
          column: 'left',
          sourceBox: {
            page: 2,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-six',
          captionNodeId: 'caption-six',
        },
      ],
      [laterReference],
    )

    expect(
      nodes.flatMap((node) =>
        node.type === 'caption' ? [node.text.match(/^Figure \d+/u)?.[0]] : [],
      ),
    ).toEqual(['Figure 5', 'Figure 6'])
  })

  it('inserts an earlier unscoped float before a later physical float already in the target scope', () => {
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-four', 2, '4. Earlier scope'),
      visualOrderFigure('visual-five', 'caption-five'),
      {
        ...visualOrderCaption('caption-five'),
        text: 'Figure 5. Earlier source float.',
      },
      visualOrderHeading('scope-five', 2, '5. Target scope'),
      visualOrderParagraph(
        'figure-five-reference',
        'The target scope begins by discussing Figure 21.',
      ),
      visualOrderFigure('visual-six', 'caption-six'),
      {
        ...visualOrderCaption('caption-six'),
        text: 'Figure 6. Later physical float.',
      },
      visualOrderHeading('scope-five-two', 2, '5.2 Following scope'),
    ]
    const figureFiveReference = matchedVisualOrderReference({
      id: 'cross-reference-target-scope-figure-five',
      anchorNodeId: 'figure-five-reference',
      referenceRegionId: 'figure-five-reference-region',
      visualNodeId: 'visual-five',
      page: 5,
      y: 0.7,
    })
    const evidence = (
      pageNumber: number,
      x: number,
      y: number,
    ): NodeSourceEvidence => ({
      confidence: 1,
      pages: [pageNumber],
      regionIds: [`region-${pageNumber}-${x}-${y}`],
      boxes: [
        {
          page: pageNumber,
          x,
          y,
          width: 0.36,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 5,
          column: 'right',
          sourceBox: {
            page: 5,
            x: 0.55,
            y: 0.2,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-five',
          captionNodeId: 'caption-five',
        },
        {
          page: 6,
          column: 'left',
          sourceBox: {
            page: 6,
            x: 0.1,
            y: 0.4,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-six',
          captionNodeId: 'caption-six',
        },
      ],
      [figureFiveReference],
      [],
      {
        'scope-four': evidence(4, 0.1, 0.7),
        'scope-five': evidence(5, 0.1, 0.3),
        'scope-five-two': evidence(6, 0.1, 0.7),
      },
    )

    expect(
      nodes.flatMap((node) =>
        node.type === 'caption' ? [node.text.match(/^Figure \d+/u)?.[0]] : [],
      ),
    ).toEqual(['Figure 5', 'Figure 6'])
  })

  it('orders integer-labeled floats sequentially when several resolve to the same scope', () => {
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-c', 1, 'C. Earlier appendix'),
      visualOrderFigure('visual-eighteen', 'caption-eighteen'),
      {
        ...visualOrderCaption('caption-eighteen'),
        text: 'Figure 18. Later numbered result.',
      },
      visualOrderFigure('visual-seventeen', 'caption-seventeen'),
      {
        ...visualOrderCaption('caption-seventeen'),
        text: 'Figure 17. Earlier numbered result.',
      },
      visualOrderHeading('scope-d', 1, 'D. Target appendix'),
      visualOrderParagraph(
        'figure-eighteen-reference',
        'Figure 21 is discussed in this appendix.',
      ),
      visualOrderParagraph(
        'figure-seventeen-reference',
        'Figure 21 is also discussed in this appendix.',
      ),
      visualOrderHeading('scope-e', 1, 'E. Following appendix'),
    ]
    const evidence = (
      pageNumber: number,
      x: number,
      y: number,
    ): NodeSourceEvidence => ({
      confidence: 1,
      pages: [pageNumber],
      regionIds: [`region-${pageNumber}-${x}-${y}`],
      boxes: [
        {
          page: pageNumber,
          x,
          y,
          width: 0.36,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 6,
          column: 'left',
          sourceBox: {
            page: 6,
            x: 0.1,
            y: 0.2,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-eighteen',
          captionNodeId: 'caption-eighteen',
        },
        {
          page: 6,
          column: 'right',
          sourceBox: {
            page: 6,
            x: 0.55,
            y: 0.2,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-seventeen',
          captionNodeId: 'caption-seventeen',
        },
      ],
      [
        matchedVisualOrderReference({
          id: 'target-scope-figure-eighteen',
          anchorNodeId: 'figure-eighteen-reference',
          referenceRegionId: 'figure-eighteen-reference-region',
          visualNodeId: 'visual-eighteen',
          page: 5,
          y: 0.3,
        }),
        matchedVisualOrderReference({
          id: 'target-scope-figure-seventeen',
          anchorNodeId: 'figure-seventeen-reference',
          referenceRegionId: 'figure-seventeen-reference-region',
          visualNodeId: 'visual-seventeen',
          page: 5,
          y: 0.4,
        }),
      ],
      [],
      {
        'scope-c': evidence(4, 0.1, 0.2),
        'scope-d': evidence(5, 0.1, 0.2),
        'scope-e': evidence(7, 0.1, 0.2),
      },
    )

    expect(
      nodes.flatMap((node) =>
        node.type === 'caption' ? [node.text.match(/^Figure \d+/u)?.[0]] : [],
      ),
    ).toEqual(['Figure 17', 'Figure 18'])
  })

  it('uses the unique nearest reference scope only when no same-column physical heading scopes the float', () => {
    const visualNodeId = 'visual-unscoped-float'
    const captionNodeId = 'caption-unscoped-float'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-b', 1, 'B. Earlier appendix'),
      visualOrderParagraph(
        'scope-b-reference',
        'Figure 21 is mentioned in the earlier appendix.',
      ),
      visualOrderHeading('scope-d', 1, 'D. Direct appendix'),
      visualOrderParagraph(
        'scope-d-reference',
        'Figure 21 is discussed immediately before its float page.',
      ),
      visualOrderHeading('scope-e-right', 1, 'E. Right-column prose'),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
      visualOrderHeading('scope-f', 1, 'F. Following appendix'),
    ]
    const earlierReference = matchedVisualOrderReference({
      id: 'cross-reference-earlier-unscoped-float',
      anchorNodeId: 'scope-b-reference',
      referenceRegionId: 'scope-b-reference-region',
      visualNodeId,
      page: 1,
      y: 0.3,
    })
    const directReference = matchedVisualOrderReference({
      id: 'cross-reference-direct-unscoped-float',
      anchorNodeId: 'scope-d-reference',
      referenceRegionId: 'scope-d-reference-region',
      visualNodeId,
      page: 2,
      y: 0.7,
    })
    directReference.sourceBoxes = [
      directReference.sourceBoxes[0],
      {
        ...directReference.sourceBoxes[0],
        y: 0.74,
      },
    ]
    const sourceEvidence = (
      pageNumber: number,
      x: number,
      y: number,
    ): NodeSourceEvidence => ({
      confidence: 1,
      pages: [pageNumber],
      regionIds: [`region-${pageNumber}-${x}-${y}`],
      boxes: [
        {
          page: pageNumber,
          x,
          y,
          width: 0.36,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 3,
          column: 'left',
          sourceBox: {
            page: 3,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId,
          captionNodeId,
        },
      ],
      [earlierReference, directReference],
      diagnostics,
      {
        'scope-b': sourceEvidence(1, 0.55, 0.1),
        'scope-d': sourceEvidence(2, 0.55, 0.1),
        'scope-e-right': sourceEvidence(3, 0.55, 0.2),
        'scope-f': sourceEvidence(4, 0.1, 0.1),
      },
    )

    expect(nodes.map((node) => node.id)).toEqual([
      'scope-b',
      'scope-b-reference',
      'scope-d',
      'scope-d-reference',
      visualNodeId,
      captionNodeId,
      'scope-e-right',
      'scope-f',
    ])
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RESOLVED_READING_ORDER',
          relationshipId: directReference.id,
          severity: 'info',
        }),
      ]),
    )
  })

  it('keeps a source-proved visual cluster when exact references span sibling sections', () => {
    const heading = (
      id: string,
      level: 1 | 2 | 3,
      text: string,
    ): ResearchNode => ({
      id,
      type: 'heading',
      level,
      text,
      source: 'pdf:test#page=1',
    })
    const paragraph = (id: string, text: string): ResearchNode => ({
      id,
      type: 'paragraph',
      text,
      source: 'pdf:test#page=1',
    })
    const figure: ResearchNode = {
      id: 'visual-result',
      type: 'figure',
      objectType: 'figure',
      title: 'Figure 7. Source-backed result.',
      relationships: {
        caption: 'caption-result',
        assets: ['asset-result'],
      },
      source: 'pdf:test#page=2',
    }
    const caption: ResearchNode = {
      id: 'caption-result',
      type: 'caption',
      text: 'Figure 7. Source-backed result.',
      source: 'pdf:test#page=2',
    }
    const nodes: ResearchNode[] = [
      heading('appendix-c', 1, 'C. Evidence'),
      heading('appendix-c-2', 2, 'C.2. Replication evidence'),
      paragraph('c-reference', 'The complete result appears in Figure 7.'),
      paragraph('c-conclusion', 'The evidence remains source-backed.'),
      heading('appendix-d', 1, 'D. Later analysis'),
      paragraph(
        'd-reference',
        'Figure 7 is mentioned again in later analysis.',
      ),
      heading('appendix-d-1', 2, 'D.1. Unrelated method'),
      paragraph('d-prose', 'The later analysis remains ordinary prose.'),
      figure,
      caption,
    ]
    const crossReference: PdfScholarlyCrossReferenceRelationship = {
      id: 'cross-reference-figure-7',
      kind: 'figure',
      text: 'Figure 7',
      labels: ['Figure 7'],
      referenceRegionId: 'c-reference-region',
      referenceStart: 31,
      referenceEnd: 39,
      targets: [
        {
          kind: 'figure',
          label: 'Figure 7',
          referenceStart: 31,
          referenceEnd: 39,
          status: 'matched',
          candidateNodeIds: ['visual-result'],
          targetNodeId: 'visual-result',
          evidence: ['canonical-label-unique'],
        },
      ],
      targetNodeIds: ['visual-result'],
      status: 'matched',
      canonicalAnchor: {
        nodeId: 'c-reference',
        start: 31,
        end: 39,
      },
      confidence: 1,
      evidence: ['explicit-scholarly-cross-reference-syntax'],
      sourceBoxes: [
        {
          page: 1,
          x: 0.1,
          y: 0.3,
          width: 0.7,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
    }
    const laterCrossReference: PdfScholarlyCrossReferenceRelationship = {
      ...crossReference,
      id: 'cross-reference-later-figure-7',
      referenceRegionId: 'd-reference-region',
      referenceStart: 0,
      referenceEnd: 8,
      targets: crossReference.targets.map((target) => ({
        ...target,
        referenceStart: 0,
        referenceEnd: 8,
      })),
      canonicalAnchor: {
        nodeId: 'd-reference',
        start: 0,
        end: 8,
      },
      sourceBoxes: [
        {
          page: 2,
          x: 0.55,
          y: 0.2,
          width: 0.36,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
    }
    const diagnostics: ReconstructionDiagnostic[] = []
    const sourceOrder = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 2,
          column: 'single',
          sourceBox: {
            page: 2,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: figure.id,
          captionNodeId: caption.id,
        },
      ],
      [crossReference, laterCrossReference],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          severity: 'info',
          sourceBoxes: [
            crossReference.sourceBoxes[0],
            laterCrossReference.sourceBoxes[0],
          ],
        }),
      ]),
    )
  })

  it('retains physical source order when all exact references belong to another heading scope', () => {
    const visualNodeId = 'visual-same-scope'
    const captionNodeId = 'caption-same-scope'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 Shared scope'),
      visualOrderParagraph(
        'early-reference',
        'Figure 21 first appears in this scope.',
      ),
      visualOrderParagraph('scope-prose', 'The scoped discussion continues.'),
      visualOrderParagraph(
        'later-reference',
        'Figure 21 appears again in this same scope.',
      ),
      visualOrderHeading('deeper-scope', 3, 'A.1.1 Deeper detail'),
      visualOrderParagraph(
        'deeper-prose',
        'A deeper heading does not close the containing level-two scope.',
      ),
      visualOrderHeading('scope-b', 2, 'A.2 Equal sibling'),
      visualOrderParagraph(
        'sibling-prose',
        'The sibling discussion is unrelated.',
      ),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
    ]
    const earlyReference = matchedVisualOrderReference({
      id: 'cross-reference-early-figure-21',
      anchorNodeId: 'early-reference',
      referenceRegionId: 'early-reference-region',
      visualNodeId,
      page: 1,
      y: 0.3,
    })
    const laterReference = matchedVisualOrderReference({
      id: 'cross-reference-later-figure-21',
      anchorNodeId: 'later-reference',
      referenceRegionId: 'later-reference-region',
      visualNodeId,
      page: 2,
      y: 0.2,
    })
    const diagnostics: ReconstructionDiagnostic[] = []
    const sourceOrder = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 3,
          column: 'left',
          sourceBox: {
            page: 3,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId,
          captionNodeId,
        },
      ],
      [laterReference, earlyReference],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          relationshipId: laterReference.id,
          severity: 'info',
        }),
      ]),
    )
  })

  it('keeps a visual at source order and records ambiguity when exact references span heading scopes', () => {
    const visualNodeId = 'visual-multi-scope'
    const captionNodeId = 'caption-multi-scope'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 First scope'),
      visualOrderParagraph(
        'scope-a-reference',
        'Figure 21 appears in the first scope.',
      ),
      visualOrderHeading('scope-b', 2, 'A.2 Second scope'),
      visualOrderParagraph(
        'scope-b-reference',
        'Figure 21 also appears in the second scope.',
      ),
      visualOrderHeading('scope-c', 2, 'A.3 Source visual location'),
      visualOrderParagraph(
        'source-location-prose',
        'The source flow remains unchanged when placement is ambiguous.',
      ),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
    ]
    const firstScopeReference = matchedVisualOrderReference({
      id: 'cross-reference-first-scope-figure-21',
      anchorNodeId: 'scope-a-reference',
      referenceRegionId: 'scope-a-reference-region',
      visualNodeId,
      page: 1,
      y: 0.3,
    })
    const secondScopeReference = matchedVisualOrderReference({
      id: 'cross-reference-second-scope-figure-21',
      anchorNodeId: 'scope-b-reference',
      referenceRegionId: 'scope-b-reference-region',
      visualNodeId,
      page: 2,
      y: 0.2,
    })
    const diagnostics: ReconstructionDiagnostic[] = []
    const sourceOrder = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 3,
          column: 'left',
          sourceBox: {
            page: 3,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId,
          captionNodeId,
        },
      ],
      [firstScopeReference, secondScopeReference],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          severity: 'info',
          sourceBoxes: [
            firstScopeReference.sourceBoxes[0],
            secondScopeReference.sourceBoxes[0],
          ],
          target: {
            regionIds: [
              firstScopeReference.referenceRegionId,
              secondScopeReference.referenceRegionId,
            ],
            markerId: null,
          },
        }),
      ]),
    )
  })

  it('keeps a visual at source order when exact references span the document root and a heading scope', () => {
    const visualNodeId = 'visual-root-and-heading-scope'
    const captionNodeId = 'caption-root-and-heading-scope'
    const nodes: ResearchNode[] = [
      visualOrderParagraph(
        'root-reference',
        'Figure 21 is previewed before any heading.',
      ),
      visualOrderHeading('scope-a', 1, 'A. Scoped evidence'),
      visualOrderParagraph(
        'scoped-reference',
        'Figure 21 also appears in this heading scope.',
      ),
      visualOrderHeading('scope-b', 1, 'B. Source visual location'),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
    ]
    const rootReference = matchedVisualOrderReference({
      id: 'cross-reference-root-figure-21',
      anchorNodeId: 'root-reference',
      referenceRegionId: 'root-reference-region',
      visualNodeId,
      page: 1,
      y: 0.2,
    })
    const scopedReference = matchedVisualOrderReference({
      id: 'cross-reference-scoped-figure-21',
      anchorNodeId: 'scoped-reference',
      referenceRegionId: 'scoped-reference-region',
      visualNodeId,
      page: 2,
      y: 0.2,
    })
    const diagnostics: ReconstructionDiagnostic[] = []
    const sourceOrder = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 3,
          column: 'left',
          sourceBox: {
            page: 3,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId,
          captionNodeId,
        },
      ],
      [rootReference, scopedReference],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'AMBIGUOUS_READING_ORDER',
      ),
    ).toEqual([])
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'SOURCE_ORDER_FLOAT_FALLBACK',
      ),
    ).toEqual([
      expect.objectContaining({
        severity: 'info',
        sourceBoxes: [
          rootReference.sourceBoxes[0],
          scopedReference.sourceBoxes[0],
        ],
        target: {
          regionIds: [
            rootReference.referenceRegionId,
            scopedReference.referenceRegionId,
          ],
          markerId: null,
        },
      }),
    ])
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'RESOLVED_READING_ORDER',
      ),
    ).toEqual([])
  })

  it('keeps a genuinely later-section float after its exact later-section reference', () => {
    const nodes: ResearchNode[] = [
      {
        id: 'appendix-c',
        type: 'heading',
        level: 1,
        text: 'C. Earlier evidence',
        source: 'pdf:test#page=1',
      },
      {
        id: 'early-preview',
        type: 'paragraph',
        text: 'Figure 8 previews evidence developed in a later section.',
        source: 'pdf:test#page=2',
      },
      {
        id: 'earlier-prose',
        type: 'paragraph',
        text: 'The earlier evidence remains ordinary prose.',
        source: 'pdf:test#page=1',
      },
      {
        id: 'appendix-d',
        type: 'heading',
        level: 1,
        text: 'D. Later evidence',
        source: 'pdf:test#page=2',
      },
      {
        id: 'later-reference',
        type: 'paragraph',
        text: 'The later evidence appears in Figure 8.',
        source: 'pdf:test#page=2',
      },
      {
        id: 'later-prose',
        type: 'paragraph',
        text: 'The later discussion continues.',
        source: 'pdf:test#page=2',
      },
      {
        id: 'visual-later',
        type: 'figure',
        objectType: 'figure',
        title: 'Figure 8. Later result.',
        relationships: {
          caption: 'caption-later',
          assets: ['asset-later'],
        },
        source: 'pdf:test#page=2',
      },
      {
        id: 'caption-later',
        type: 'caption',
        text: 'Figure 8. Later result.',
        source: 'pdf:test#page=2',
      },
    ]
    const crossReference: PdfScholarlyCrossReferenceRelationship = {
      id: 'cross-reference-figure-8',
      kind: 'figure',
      text: 'Figure 8',
      labels: ['Figure 8'],
      referenceRegionId: 'later-reference-region',
      referenceStart: 30,
      referenceEnd: 38,
      targets: [
        {
          kind: 'figure',
          label: 'Figure 8',
          referenceStart: 30,
          referenceEnd: 38,
          status: 'matched',
          candidateNodeIds: ['visual-later'],
          targetNodeId: 'visual-later',
          evidence: ['canonical-label-unique'],
        },
      ],
      targetNodeIds: ['visual-later'],
      status: 'matched',
      canonicalAnchor: {
        nodeId: 'later-reference',
        start: 30,
        end: 38,
      },
      confidence: 1,
      evidence: ['explicit-scholarly-cross-reference-syntax'],
      sourceBoxes: [
        {
          page: 2,
          x: 0.55,
          y: 0.2,
          width: 0.36,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
    }
    const previewReference: PdfScholarlyCrossReferenceRelationship = {
      ...crossReference,
      id: 'cross-reference-preview-figure-8',
      referenceRegionId: 'early-preview-region',
      referenceStart: 0,
      referenceEnd: 8,
      targets: crossReference.targets.map((target) => ({
        ...target,
        referenceStart: 0,
        referenceEnd: 8,
      })),
      canonicalAnchor: {
        nodeId: 'early-preview',
        start: 0,
        end: 8,
      },
      sourceBoxes: [
        {
          page: 2,
          x: 0.1,
          y: 0.6,
          width: 0.36,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
    }
    const expected = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 2,
          column: 'right',
          sourceBox: {
            page: 2,
            x: 0.55,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-later',
          captionNodeId: 'caption-later',
        },
      ],
      [previewReference, crossReference],
    )

    expect(nodes.map((node) => node.id)).toEqual(expected)
  })

  it('does not relocate unreferenced or ambiguously referenced visual pairs', () => {
    const visual = (
      id: string,
      captionId: string,
      title: string,
    ): ResearchNode => ({
      id,
      type: 'figure',
      objectType: 'figure',
      title,
      relationships: { caption: captionId, assets: [`asset-${id}`] },
      source: 'pdf:test#page=2',
    })
    const caption = (id: string, text: string): ResearchNode => ({
      id,
      type: 'caption',
      text,
      source: 'pdf:test#page=2',
    })
    const nodes: ResearchNode[] = [
      {
        id: 'appendix-a',
        type: 'heading',
        level: 1,
        text: 'A. Evidence',
        source: 'pdf:test#page=1',
      },
      {
        id: 'ambiguous-reference',
        type: 'paragraph',
        text: 'Figure 9 may refer to either source candidate.',
        source: 'pdf:test#page=1',
      },
      {
        id: 'appendix-b',
        type: 'heading',
        level: 1,
        text: 'B. Later evidence',
        source: 'pdf:test#page=2',
      },
      visual('visual-unreferenced', 'caption-unreferenced', 'Figure 10.'),
      caption('caption-unreferenced', 'Figure 10.'),
      visual('visual-ambiguous', 'caption-ambiguous', 'Figure 9.'),
      caption('caption-ambiguous', 'Figure 9.'),
    ]
    const ambiguousReference: PdfScholarlyCrossReferenceRelationship = {
      id: 'cross-reference-figure-9',
      kind: 'figure',
      text: 'Figure 9',
      labels: ['Figure 9'],
      referenceRegionId: 'ambiguous-reference-region',
      referenceStart: 0,
      referenceEnd: 8,
      targets: [
        {
          kind: 'figure',
          label: 'Figure 9',
          referenceStart: 0,
          referenceEnd: 8,
          status: 'ambiguous',
          candidateNodeIds: ['visual-ambiguous', 'visual-other'],
          targetNodeId: null,
          evidence: ['canonical-label-ambiguous'],
        },
      ],
      targetNodeIds: [],
      status: 'ambiguous',
      canonicalAnchor: null,
      confidence: 0.5,
      evidence: ['canonical-label-ambiguous'],
      sourceBoxes: [],
    }
    const expected = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 2,
          column: 'left',
          visualNodeId: 'visual-unreferenced',
          captionNodeId: 'caption-unreferenced',
        },
        {
          page: 2,
          column: 'left',
          visualNodeId: 'visual-ambiguous',
          captionNodeId: 'caption-ambiguous',
        },
      ],
      [ambiguousReference],
    )

    expect(nodes.map((node) => node.id)).toEqual(expected)
  })

  it('does not guess containment when a proved source box conflicts with a claimed visual column', () => {
    const nodes: ResearchNode[] = [
      {
        id: 'appendix-a',
        type: 'heading',
        level: 1,
        text: 'A. Evidence',
        source: 'pdf:test#page=1',
      },
      {
        id: 'a-reference',
        type: 'paragraph',
        text: 'Figure 11 contains the result.',
        source: 'pdf:test#page=1',
      },
      {
        id: 'appendix-b',
        type: 'heading',
        level: 1,
        text: 'B. Later evidence',
        source: 'pdf:test#page=2',
      },
      {
        id: 'visual-conflict',
        type: 'figure',
        objectType: 'figure',
        title: 'Figure 11. Conflicting lane evidence.',
        relationships: {
          caption: 'caption-conflict',
          assets: ['asset-conflict'],
        },
        source: 'pdf:test#page=2',
      },
      {
        id: 'caption-conflict',
        type: 'caption',
        text: 'Figure 11. Conflicting lane evidence.',
        source: 'pdf:test#page=2',
      },
    ]
    const crossReference: PdfScholarlyCrossReferenceRelationship = {
      id: 'cross-reference-figure-11',
      kind: 'figure',
      text: 'Figure 11',
      labels: ['Figure 11'],
      referenceRegionId: 'a-reference-region',
      referenceStart: 0,
      referenceEnd: 9,
      targets: [
        {
          kind: 'figure',
          label: 'Figure 11',
          referenceStart: 0,
          referenceEnd: 9,
          status: 'matched',
          candidateNodeIds: ['visual-conflict'],
          targetNodeId: 'visual-conflict',
          evidence: ['canonical-label-unique'],
        },
      ],
      targetNodeIds: ['visual-conflict'],
      status: 'matched',
      canonicalAnchor: {
        nodeId: 'a-reference',
        start: 0,
        end: 9,
      },
      confidence: 1,
      evidence: ['explicit-scholarly-cross-reference-syntax'],
      sourceBoxes: [
        {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.36,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
    }
    const expected = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 2,
          column: 'right',
          sourceBox: {
            page: 2,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-conflict',
          captionNodeId: 'caption-conflict',
        },
      ],
      [crossReference],
    )

    expect(nodes.map((node) => node.id)).toEqual(expected)
  })
})
