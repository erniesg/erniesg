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
  it('restores a deferred multi-appendix float run to its source-proved heading scopes', () => {
    const figure = (
      ordinal: number,
    ): Extract<ResearchNode, { type: 'figure' }> => ({
      id: `visual-${ordinal}`,
      type: 'figure',
      objectType: 'figure',
      title: `Figure ${ordinal}. Deferred appendix result.`,
      relationships: {
        caption: `caption-${ordinal}`,
        assets: [`asset-${ordinal}`],
      },
      source: `pdf:test#page=${ordinal}`,
    })
    const caption = (
      ordinal: number,
    ): Extract<ResearchNode, { type: 'caption' }> => ({
      id: `caption-${ordinal}`,
      type: 'caption',
      text: `Figure ${ordinal}. Deferred appendix result.`,
      source: `pdf:test#page=${ordinal}`,
    })
    const nodes: ResearchNode[] = [
      visualOrderHeading('appendix-b', 1, 'B Prompt details'),
      visualOrderHeading('appendix-b-4', 2, 'B.4 Experiment prompts'),
      visualOrderParagraph(
        'appendix-b-reference',
        'The complete prompt appears in Figure 22.',
      ),
      visualOrderHeading('appendix-c', 1, 'C Human evaluation'),
      visualOrderParagraph(
        'appendix-c-reference',
        'The evaluation interface appears in Figure 23.',
      ),
      visualOrderHeading('appendix-d', 1, 'D Grouping rules'),
      visualOrderParagraph(
        'appendix-d-reference',
        'The grouping rules appear in Figure 26.',
      ),
      visualOrderHeading('appendix-f', 1, 'F Generated outline'),
      visualOrderParagraph(
        'appendix-f-reference',
        'The generated outline appears in Figure 30.',
      ),
      figure(22),
      caption(22),
      figure(23),
      caption(23),
      figure(26),
      caption(26),
      figure(30),
      caption(30),
      visualOrderHeading('appendix-g', 1, 'G Generated story'),
    ]
    const relationship = (ordinal: number, anchorNodeId: string, y: number) => {
      const result = matchedVisualOrderReference({
        id: `cross-reference-figure-${ordinal}`,
        anchorNodeId,
        referenceRegionId: `${anchorNodeId}-region`,
        visualNodeId: `visual-${ordinal}`,
        page: 16,
        y,
      })
      return {
        ...result,
        text: `Figure ${ordinal}`,
        labels: [`Figure ${ordinal}`],
        targets: result.targets.map((target) => ({
          ...target,
          label: `Figure ${ordinal}`,
        })),
      } satisfies PdfScholarlyCrossReferenceRelationship
    }
    const sourceEvidence = (
      pageNumber: number,
      x: number,
      y: number,
      width = 0.36,
    ): NodeSourceEvidence => ({
      confidence: 1,
      pages: [pageNumber],
      regionIds: [`region-${pageNumber}-${x}-${y}`],
      boxes: [
        {
          page: pageNumber,
          x,
          y,
          width,
          height: 0.02,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })
    const provenance: Record<string, NodeSourceEvidence> = {
      'appendix-b': sourceEvidence(15, 0.55, 0.7),
      'appendix-b-4': sourceEvidence(16, 0.1, 0.2),
      'appendix-b-reference': sourceEvidence(16, 0.1, 0.24),
      'appendix-c': sourceEvidence(16, 0.1, 0.32),
      'appendix-c-reference': sourceEvidence(16, 0.1, 0.36),
      'appendix-d': sourceEvidence(16, 0.1, 0.7),
      'appendix-d-reference': sourceEvidence(16, 0.1, 0.74),
      'appendix-f': sourceEvidence(16, 0.55, 0.5),
      'appendix-f-reference': sourceEvidence(16, 0.55, 0.54),
      'visual-22': sourceEvidence(22, 0.1, 0.5, 0.8),
      'caption-22': sourceEvidence(22, 0.1, 0.82, 0.8),
      'visual-23': sourceEvidence(23, 0.1, 0.1, 0.8),
      'caption-23': sourceEvidence(23, 0.1, 0.46, 0.8),
      'visual-26': sourceEvidence(24, 0.1, 0.52, 0.8),
      'caption-26': sourceEvidence(24, 0.1, 0.89, 0.8),
      'visual-30': sourceEvidence(28, 0.1, 0.2, 0.8),
      'caption-30': sourceEvidence(28, 0.1, 0.78, 0.8),
      'appendix-g': sourceEvidence(32, 0.1, 0.18),
    }
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [22, 23, 26, 30].map((ordinal) => ({
        page: provenance[`caption-${ordinal}`].pages[0],
        column: 'single' as const,
        sourceBox: provenance[`caption-${ordinal}`].boxes[0],
        visualNodeId: `visual-${ordinal}`,
        captionNodeId: `caption-${ordinal}`,
      })),
      [
        relationship(22, 'appendix-b-reference', 0.24),
        relationship(23, 'appendix-c-reference', 0.36),
        relationship(26, 'appendix-d-reference', 0.74),
        relationship(30, 'appendix-f-reference', 0.54),
      ],
      diagnostics,
      provenance,
    )

    expect(nodes.map((node) => node.id)).toEqual([
      'appendix-b',
      'appendix-b-4',
      'appendix-b-reference',
      'visual-22',
      'caption-22',
      'appendix-c',
      'appendix-c-reference',
      'visual-23',
      'caption-23',
      'appendix-d',
      'appendix-d-reference',
      'visual-26',
      'caption-26',
      'appendix-f',
      'appendix-f-reference',
      'visual-30',
      'caption-30',
      'appendix-g',
    ])
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'AMBIGUOUS_READING_ORDER',
      ),
    ).toEqual([])
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'RESOLVED_READING_ORDER',
      ),
    ).toHaveLength(3)
  })

  it('falls back to atomic source order when a reference-scope move would invert a deferred float run', () => {
    const figure = (ordinal: number): ResearchNode => ({
      id: `source-ordered-visual-${ordinal}`,
      type: 'figure',
      objectType: 'figure',
      title: `Figure ${ordinal}. Deferred source result.`,
      relationships: {
        caption: `source-ordered-caption-${ordinal}`,
        assets: [`source-ordered-asset-${ordinal}`],
      },
      source: `pdf:test#page=${ordinal + 2}`,
    })
    const caption = (ordinal: number): ResearchNode => ({
      id: `source-ordered-caption-${ordinal}`,
      type: 'caption',
      text: `Figure ${ordinal}. Deferred source result.`,
      source: `pdf:test#page=${ordinal + 2}`,
    })
    const nodes: ResearchNode[] = [
      visualOrderHeading('source-scope-a', 2, 'A Earlier scope'),
      visualOrderParagraph(
        'source-scope-a-reference',
        'Figure 2 is discussed in the earlier scope.',
      ),
      visualOrderHeading('source-scope-b', 2, 'B Later scope'),
      visualOrderParagraph(
        'source-scope-b-reference',
        'Figure 1 is discussed in the later scope.',
      ),
      figure(1),
      caption(1),
      figure(2),
      caption(2),
      visualOrderHeading('source-scope-c', 2, 'C Following scope'),
    ]
    const sourceEvidence = (
      pageNumber: number,
      y: number,
    ): NodeSourceEvidence => ({
      confidence: 1,
      pages: [pageNumber],
      regionIds: [`source-region-${pageNumber}-${y}`],
      boxes: [
        {
          page: pageNumber,
          x: 0.1,
          y,
          width: 0.8,
          height: 0.03,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })
    const diagnostics: ReconstructionDiagnostic[] = []
    const sourceOrder = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [1, 2].map((ordinal) => ({
        page: ordinal + 2,
        column: 'single' as const,
        sourceBox: {
          page: ordinal + 2,
          x: 0.1,
          y: 0.2,
          width: 0.8,
          height: 0.2,
          rotation: 0,
          method: 'pdf-object' as const,
        },
        visualNodeId: `source-ordered-visual-${ordinal}`,
        captionNodeId: `source-ordered-caption-${ordinal}`,
      })),
      [
        matchedVisualOrderReference({
          id: 'source-order-reference-figure-1',
          anchorNodeId: 'source-scope-b-reference',
          referenceRegionId: 'source-scope-b-reference-region',
          visualNodeId: 'source-ordered-visual-1',
          page: 1,
          y: 0.42,
        }),
        matchedVisualOrderReference({
          id: 'source-order-reference-figure-2',
          anchorNodeId: 'source-scope-a-reference',
          referenceRegionId: 'source-scope-a-reference-region',
          visualNodeId: 'source-ordered-visual-2',
          page: 1,
          y: 0.18,
        }),
      ],
      diagnostics,
      {
        'source-scope-a': sourceEvidence(1, 0.1),
        'source-scope-a-reference': sourceEvidence(1, 0.18),
        'source-scope-b': sourceEvidence(1, 0.34),
        'source-scope-b-reference': sourceEvidence(1, 0.42),
        'source-ordered-visual-1': sourceEvidence(3, 0.2),
        'source-ordered-caption-1': sourceEvidence(3, 0.42),
        'source-ordered-visual-2': sourceEvidence(4, 0.2),
        'source-ordered-caption-2': sourceEvidence(4, 0.42),
        'source-scope-c': sourceEvidence(5, 0.1),
      },
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(
      nodes.flatMap((node, index) =>
        node.type === 'figure'
          ? [[node.id, nodes[index + 1]?.id] as const]
          : [],
      ),
    ).toEqual([
      ['source-ordered-visual-1', 'source-ordered-caption-1'],
      ['source-ordered-visual-2', 'source-ordered-caption-2'],
    ])
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          severity: 'info',
          message: expect.stringContaining(
            'reverse source-proved visual-caption pair order',
          ),
        }),
      ]),
    )
  })

  it('fails closed when a float fallback encounters a pre-existing reversed atomic pair order', () => {
    const nodes: ResearchNode[] = [
      visualOrderHeading('reversed-scope-a', 2, 'A. Earlier scope'),
      visualOrderParagraph(
        'reversed-scope-a-reference',
        'Figure 21 is discussed in the earlier scope.',
      ),
      visualOrderHeading('reversed-scope-b', 2, 'B. Later scope'),
      visualOrderParagraph(
        'reversed-scope-b-reference',
        'Figure 21 is also discussed in the later scope.',
      ),
      visualOrderFigure('reversed-visual-2', 'reversed-caption-2'),
      visualOrderCaption('reversed-caption-2'),
      visualOrderFigure('reversed-visual-1', 'reversed-caption-1'),
      visualOrderCaption('reversed-caption-1'),
    ]
    const sourceOrder = nodes.map((node) => node.id)
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 3,
          column: 'single',
          sourceBox: {
            page: 3,
            x: 0.1,
            y: 0.2,
            width: 0.8,
            height: 0.2,
            rotation: 0,
            method: 'pdf-object',
          },
          visualNodeId: 'reversed-visual-1',
          captionNodeId: 'reversed-caption-1',
        },
        {
          page: 4,
          column: 'single',
          sourceBox: {
            page: 4,
            x: 0.1,
            y: 0.2,
            width: 0.8,
            height: 0.2,
            rotation: 0,
            method: 'pdf-object',
          },
          visualNodeId: 'reversed-visual-2',
          captionNodeId: 'reversed-caption-2',
        },
      ],
      [
        matchedVisualOrderReference({
          id: 'reversed-scope-a-reference-relationship',
          anchorNodeId: 'reversed-scope-a-reference',
          referenceRegionId: 'reversed-scope-a-reference-region',
          visualNodeId: 'reversed-visual-1',
          page: 1,
          y: 0.2,
        }),
        matchedVisualOrderReference({
          id: 'reversed-scope-b-reference-relationship',
          anchorNodeId: 'reversed-scope-b-reference',
          referenceRegionId: 'reversed-scope-b-reference-region',
          visualNodeId: 'reversed-visual-1',
          page: 2,
          y: 0.2,
        }),
      ],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'error',
          message: expect.stringContaining(
            'source-proved atomic visual-caption order is not intact',
          ),
        }),
      ]),
    )
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'SOURCE_ORDER_FLOAT_FALLBACK',
      ),
    ).toEqual([])
  })

  it('uses physical source order rather than numeric labels for a safe float fallback', () => {
    const firstFigure = visualOrderFigure(
      'physical-visual-1',
      'physical-caption-1',
    ) as Extract<ResearchNode, { type: 'figure' }>
    firstFigure.title = 'Figure 1. First numbered result.'
    const firstCaption = {
      ...visualOrderCaption('physical-caption-1'),
      text: 'Figure 1. First numbered result.',
    } satisfies ResearchNode
    const secondFigure = visualOrderFigure(
      'physical-visual-2',
      'physical-caption-2',
    ) as Extract<ResearchNode, { type: 'figure' }>
    secondFigure.title = 'Figure 2. Second numbered result.'
    const secondCaption = {
      ...visualOrderCaption('physical-caption-2'),
      text: 'Figure 2. Second numbered result.',
    } satisfies ResearchNode
    const nodes: ResearchNode[] = [
      visualOrderHeading('physical-scope-a', 2, 'A. Earlier scope'),
      visualOrderParagraph(
        'physical-scope-a-reference',
        'Figure 1 is discussed in the earlier scope.',
      ),
      visualOrderHeading('physical-scope-b', 2, 'B. Later scope'),
      visualOrderParagraph(
        'physical-scope-b-reference',
        'Figure 1 is also discussed in the later scope.',
      ),
      secondFigure,
      secondCaption,
      firstFigure,
      firstCaption,
    ]
    const sourceOrder = nodes.map((node) => node.id)
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 4,
          column: 'single',
          sourceBox: {
            page: 4,
            x: 0.1,
            y: 0.2,
            width: 0.8,
            height: 0.2,
            rotation: 0,
            method: 'pdf-object',
          },
          visualNodeId: firstFigure.id,
          captionNodeId: firstCaption.id,
        },
        {
          page: 3,
          column: 'single',
          sourceBox: {
            page: 3,
            x: 0.1,
            y: 0.2,
            width: 0.8,
            height: 0.2,
            rotation: 0,
            method: 'pdf-object',
          },
          visualNodeId: secondFigure.id,
          captionNodeId: secondCaption.id,
        },
      ],
      [
        matchedVisualOrderReference({
          id: 'physical-scope-a-reference-relationship',
          anchorNodeId: 'physical-scope-a-reference',
          referenceRegionId: 'physical-scope-a-reference-region',
          visualNodeId: firstFigure.id,
          page: 1,
          y: 0.2,
        }),
        matchedVisualOrderReference({
          id: 'physical-scope-b-reference-relationship',
          anchorNodeId: 'physical-scope-b-reference',
          referenceRegionId: 'physical-scope-b-reference-region',
          visualNodeId: firstFigure.id,
          page: 2,
          y: 0.2,
        }),
      ],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          severity: 'info',
        }),
      ]),
    )
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'AMBIGUOUS_READING_ORDER',
      ),
    ).toEqual([])
  })

  it('atomically places adjacent unreferenced deferred floats in the unique slot bounded by proved appendix scopes', () => {
    const figure = (ordinal: number): ResearchNode => ({
      id: `bounded-visual-${ordinal}`,
      type: 'figure',
      objectType: 'figure',
      title: `Figure ${ordinal}. Deferred prompt.`,
      relationships: {
        caption: `bounded-caption-${ordinal}`,
        assets: [`bounded-asset-${ordinal}`],
      },
      source: `pdf:test#page=${ordinal}`,
    })
    const caption = (ordinal: number): ResearchNode => ({
      id: `bounded-caption-${ordinal}`,
      type: 'caption',
      text: `Figure ${ordinal}. Deferred prompt.`,
      source: `pdf:test#page=${ordinal}`,
    })
    const nodes: ResearchNode[] = [
      visualOrderHeading('bounded-b-3', 2, 'B.3 Analyzer prompts'),
      visualOrderParagraph(
        'bounded-b-3-reference',
        'The analyzer prompt appears in Figure 21.',
      ),
      visualOrderHeading('bounded-b-4', 2, 'B.4 Experiment prompts'),
      visualOrderParagraph(
        'bounded-b-4-prose',
        'The next source prompt is described here.',
      ),
      visualOrderHeading('bounded-c', 1, 'C Human evaluation'),
      visualOrderParagraph(
        'bounded-c-reference',
        'The interface appears in Figure 24.',
      ),
      figure(21),
      caption(21),
      figure(22),
      caption(22),
      figure(23),
      caption(23),
      figure(24),
      caption(24),
      visualOrderHeading('bounded-g', 1, 'G Generated story'),
    ]
    const evidence = (
      pageNumber: number,
      x: number,
      y: number,
      width = 0.36,
    ): NodeSourceEvidence => ({
      confidence: 1,
      pages: [pageNumber],
      regionIds: [`bounded-region-${pageNumber}-${x}-${y}`],
      boxes: [
        {
          page: pageNumber,
          x,
          y,
          width,
          height: 0.02,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })
    const provenance: Record<string, NodeSourceEvidence> = {
      'bounded-b-3': evidence(15, 0.55, 0.7),
      'bounded-b-3-reference': evidence(16, 0.1, 0.08),
      'bounded-b-4': evidence(16, 0.1, 0.2),
      'bounded-b-4-prose': evidence(16, 0.1, 0.24),
      'bounded-c': evidence(16, 0.1, 0.32),
      'bounded-c-reference': evidence(16, 0.1, 0.36),
      'bounded-visual-21': evidence(21, 0.1, 0.1, 0.8),
      'bounded-caption-21': evidence(21, 0.1, 0.45, 0.8),
      'bounded-visual-22': evidence(22, 0.1, 0.1, 0.8),
      'bounded-caption-22': evidence(22, 0.1, 0.45, 0.8),
      'bounded-visual-23': evidence(23, 0.1, 0.1, 0.8),
      'bounded-caption-23': evidence(23, 0.1, 0.45, 0.8),
      'bounded-visual-24': evidence(24, 0.1, 0.1, 0.8),
      'bounded-caption-24': evidence(24, 0.1, 0.45, 0.8),
      'bounded-g': evidence(32, 0.1, 0.18),
    }
    const reference = (ordinal: number, anchorNodeId: string, y: number) => {
      const result = matchedVisualOrderReference({
        id: `bounded-reference-${ordinal}`,
        anchorNodeId,
        referenceRegionId: `${anchorNodeId}-region`,
        visualNodeId: `bounded-visual-${ordinal}`,
        page: 16,
        y,
      })
      return {
        ...result,
        text: `Figure ${ordinal}`,
        labels: [`Figure ${ordinal}`],
        targets: result.targets.map((target) => ({
          ...target,
          label: `Figure ${ordinal}`,
        })),
      } satisfies PdfScholarlyCrossReferenceRelationship
    }
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [21, 22, 23, 24].map((ordinal) => ({
        page: ordinal,
        column: 'single' as const,
        sourceBox: provenance[`bounded-caption-${ordinal}`].boxes[0],
        visualNodeId: `bounded-visual-${ordinal}`,
        captionNodeId: `bounded-caption-${ordinal}`,
      })),
      [
        reference(21, 'bounded-b-3-reference', 0.08),
        reference(24, 'bounded-c-reference', 0.36),
      ],
      diagnostics,
      provenance,
    )

    expect(nodes.map((node) => node.id)).toEqual([
      'bounded-b-3',
      'bounded-b-3-reference',
      'bounded-visual-21',
      'bounded-caption-21',
      'bounded-b-4',
      'bounded-b-4-prose',
      'bounded-visual-22',
      'bounded-caption-22',
      'bounded-visual-23',
      'bounded-caption-23',
      'bounded-c',
      'bounded-c-reference',
      'bounded-visual-24',
      'bounded-caption-24',
      'bounded-g',
    ])
    expect(diagnostics).toEqual(
      expect.arrayContaining(
        [22, 23].map((pageNumber) =>
          expect.objectContaining({
            code: 'RESOLVED_READING_ORDER',
            severity: 'info',
            page: pageNumber,
            sourceBoxes: [provenance[`bounded-caption-${pageNumber}`].boxes[0]],
          }),
        ),
      ),
    )
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'AMBIGUOUS_READING_ORDER',
      ),
    ).toEqual([])

    const rollbackNodes: ResearchNode[] = [
      visualOrderHeading('bounded-b-3', 2, 'B.3 Analyzer prompts'),
      visualOrderParagraph(
        'bounded-b-3-reference',
        'The analyzer prompt appears in Figure 21.',
      ),
      visualOrderHeading('bounded-b-4', 2, 'B.4 Experiment prompts'),
      visualOrderParagraph(
        'bounded-b-4-prose',
        'The next source prompt is described here.',
      ),
      visualOrderHeading('bounded-c', 1, 'C Human evaluation'),
      visualOrderParagraph(
        'bounded-c-reference',
        'The interface appears in Figure 24.',
      ),
      figure(21),
      caption(21),
      figure(23),
      caption(23),
      figure(22),
      caption(22),
      figure(24),
      caption(24),
      visualOrderHeading('bounded-g', 1, 'G Generated story'),
    ]
    const rollbackProvenance: Record<string, NodeSourceEvidence> = {
      ...provenance,
      'bounded-visual-22': evidence(23, 0.1, 0.1, 0.8),
      'bounded-caption-22': evidence(23, 0.1, 0.45, 0.8),
      'bounded-visual-23': evidence(22, 0.1, 0.1, 0.8),
      'bounded-caption-23': evidence(22, 0.1, 0.45, 0.8),
    }
    const rollbackDiagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      rollbackNodes,
      [21, 22, 23, 24].map((ordinal) => ({
        page: rollbackProvenance[`bounded-caption-${ordinal}`].boxes[0].page,
        column: 'single' as const,
        sourceBox: rollbackProvenance[`bounded-caption-${ordinal}`].boxes[0],
        visualNodeId: `bounded-visual-${ordinal}`,
        captionNodeId: `bounded-caption-${ordinal}`,
      })),
      [
        reference(21, 'bounded-b-3-reference', 0.08),
        reference(24, 'bounded-c-reference', 0.36),
      ],
      rollbackDiagnostics,
      rollbackProvenance,
    )

    const rollbackOrder = rollbackNodes.map((node) => node.id)
    expect(rollbackOrder).toEqual([
      'bounded-b-3',
      'bounded-b-3-reference',
      'bounded-b-4',
      'bounded-b-4-prose',
      'bounded-c',
      'bounded-c-reference',
      'bounded-visual-21',
      'bounded-caption-21',
      'bounded-visual-23',
      'bounded-caption-23',
      'bounded-visual-22',
      'bounded-caption-22',
      'bounded-visual-24',
      'bounded-caption-24',
      'bounded-g',
    ])
    expect(
      rollbackDiagnostics.filter(
        (diagnostic) =>
          diagnostic.code === 'RESOLVED_READING_ORDER' &&
          (diagnostic.page === 22 || diagnostic.page === 23),
      ),
    ).toEqual([])
    expect(
      rollbackDiagnostics.filter(
        (diagnostic) =>
          diagnostic.code === 'SOURCE_ORDER_FLOAT_FALLBACK' &&
          (diagnostic.page === 22 || diagnostic.page === 23),
      ),
    ).toHaveLength(2)
  })
})
