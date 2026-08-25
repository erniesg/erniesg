import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfScholarlyCrossReferenceRelationship,
  PdfSourceRun,
  ReconstructionDiagnostic,
} from './import-types'
import {
  canonicalVisualSourceTranscript,
  orderCanonicalVisualPairs,
  reconstructPageAnalyses,
} from './pdf-layout'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import { createSourcePageCropAsset } from './visual-assets'
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

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height: 0.018,
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
  kind: PdfPageAnalysis['kind'] = 'born-digital',
): PdfPageAnalysis {
  return {
    page: number,
    kind,
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: kind === 'born-digital' ? 0 : 1,
    runs,
  }
}

describe('PDF semantic reconstruction', () => {
  it('uses visual line grouping to detect split, out-of-order captions', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '1. A split caption', 0.2, 0.398, 0.32, 8),
          run(1, 'Figure', 0.1, 0.4, 0.08, 8),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'split-caption.pdf',
      byteLength: 2048,
    })

    expect(result.semanticSignals.captions).toBe(1)
    expect(result.completeness.unresolvedObjects.captions).toBe(1)
    expect(result.readiness.ready).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INCOMPLETE_RELATIONSHIP_COVERAGE',
          severity: 'error',
        }),
      ]),
    )
  })

  it('reconciles a multi-run caption envelope with strict visual provenance', async () => {
    const figureBox: NormalizedSourceBox = {
      page: 1,
      x: 0.25,
      y: 0.14,
      width: 0.3,
      height: 0.2,
      rotation: 0,
      method: 'pdf-object',
    }
    const sourcePage = page(1, [
      run(
        1,
        'Figure 1. A multi-run',
        0.20004503944386193,
        0.4,
        0.20003758366009416,
        8,
      ),
      run(
        1,
        'caption envelope.',
        0.42003177397559277,
        0.4,
        0.2000623840055811,
        8,
      ),
    ])
    sourcePage.imageCount = 1
    sourcePage.objects = [
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image',
        box: figureBox,
        confidence: 0.99,
        assetId: null,
        role: 'semantic',
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: 'a'.repeat(64),
      fileName: 'multi-run-caption.pdf',
      byteLength: 4096,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 8,
          height: 8,
          pixels: new Uint8Array(8 * 8 * 4).fill(96),
        }),
    })

    const relationship = result.visualRelationships.find(
      (candidate) => candidate.status === 'matched',
    )!
    const captionEvidence = result.provenance[relationship.captionNodeId!]
    const visualEvidence = result.provenance[relationship.canonicalNodeId!]
    expect(captionEvidence.boxes).toHaveLength(2)
    expect(relationship.sourceBoxes[0]).toMatchObject({
      page: 1,
      x: 0.20005,
      y: 0.4,
      width: 0.42004,
      height: 0.018,
      rotation: 0,
      method: 'pdf-text',
    })
    expect(visualEvidence.boxes).toEqual(relationship.sourceBoxes)
    expect(
      validatedPdfVisualRelationships({
        paper: result.paper,
        provenance: result.provenance,
        relationships: result.visualRelationships,
        assets: result.assets,
        regions: result.regions,
        pages: result.pages,
      }),
    ).toEqual([relationship])
  })

  it('retains a source transcript for a matched table when semantic token spacing differs from raw line joins', () => {
    const semanticTranscript =
      'Method Score ROLLING 45.7 RE 3 60.0 ROLLING - FT 48.7'
    const rawLineJoin = 'Method Score 45.7 ROLLING RE3 60.0 48.7 ROLLING-FT'

    expect(rawLineJoin).not.toBe(semanticTranscript)
    expect(
      canonicalVisualSourceTranscript(
        {
          kind: 'table',
          status: 'matched',
          sourceText: semanticTranscript,
        },
        rawLineJoin,
      ),
    ).toBe(semanticTranscript)
  })

  it('orders canonical figure-caption pairs by the verified visual column flow', async () => {
    const figureBoxes: NormalizedSourceBox[] = [
      {
        page: 1,
        x: 0.09,
        y: 0.09,
        width: 0.38,
        height: 0.15,
        rotation: 0,
        method: 'pdf-object',
      },
      {
        page: 1,
        x: 0.09,
        y: 0.32,
        width: 0.38,
        height: 0.14,
        rotation: 0,
        method: 'pdf-object',
      },
      {
        page: 1,
        x: 0.09,
        y: 0.58,
        width: 0.38,
        height: 0.23,
        rotation: 0,
        method: 'pdf-object',
      },
      {
        page: 1,
        x: 0.502,
        y: 0.27,
        width: 0.38,
        height: 0.36,
        rotation: 0,
        method: 'pdf-object',
      },
    ]
    const sourcePage = page(1, [
      run(1, 'Figure 15. First left-column figure.', 0.09, 0.255, 0.38, 8),
      run(1, 'Figure 16. Second left-column figure.', 0.09, 0.47, 0.38, 8),
      run(1, 'Figure 17. Third left-column figure.', 0.09, 0.827, 0.38, 8),
      run(1, 'Figure 18. Right-column figure.', 0.502, 0.652, 0.38, 8),
    ])
    sourcePage.imageCount = figureBoxes.length
    sourcePage.objects = figureBoxes.map((box, index) => ({
      id: `image-visual-column-${index + 1}`,
      page: 1,
      kind: 'image',
      box,
      confidence: 0.98,
      assetId: null,
      role: 'semantic',
    }))

    const result = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: 'f'.repeat(64),
      fileName: 'visual-column-order.pdf',
      byteLength: 4096,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 8,
          height: 8,
          pixels: new Uint8Array(8 * 8 * 4).fill(96),
        }),
    })
    const labelByNodeId = new Map(
      result.visualRelationships.map((relationship) => [
        relationship.canonicalNodeId,
        relationship.label,
      ]),
    )
    expect(result.visualRelationships.map(({ label }) => label)).toEqual([
      'Figure 15',
      'Figure 16',
      'Figure 17',
      'Figure 18',
    ])
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'figure' ? [labelByNodeId.get(node.id)] : [],
      ),
    ).toEqual(['Figure 15', 'Figure 16', 'Figure 17', 'Figure 18'])
  })

  it('keeps single-column visual pairs at their source caption slots when discovery order is reversed', () => {
    const paragraph = (id: string, text: string): ResearchNode => ({
      id,
      type: 'paragraph',
      text,
      source: 'pdf:test#page=1',
    })
    const heading = (id: string, text: string): ResearchNode => ({
      id,
      type: 'heading',
      level: 2,
      text,
      source: 'pdf:test#page=1',
    })
    const figure = (id: string, caption: string): ResearchNode => ({
      id,
      type: 'figure',
      objectType: 'figure',
      title: id,
      relationships: { caption, assets: [`asset-${id}`] },
      source: 'pdf:test#page=1',
    })
    const nodes: ResearchNode[] = [
      figure('visual-screenshot', 'caption-screenshot'),
      paragraph('caption-screenshot', 'Figure 3. Screenshot.'),
      heading('appendix', 'A Appendix'),
      heading('prompt-section', 'A.2 Prompts for the agent system'),
      figure('visual-prompt', 'caption-prompt'),
      paragraph('caption-prompt', 'Here is the specific prompt used:'),
    ]

    orderCanonicalVisualPairs(nodes, [
      {
        page: 1,
        column: 'single',
        visualNodeId: 'visual-prompt',
        captionNodeId: 'caption-prompt',
      },
      {
        page: 1,
        column: 'single',
        visualNodeId: 'visual-screenshot',
        captionNodeId: 'caption-screenshot',
      },
    ])

    expect(nodes.map((node) => node.id)).toEqual([
      'visual-screenshot',
      'caption-screenshot',
      'appendix',
      'prompt-section',
      'visual-prompt',
      'caption-prompt',
    ])
  })

  it('restores proved left-before-right visual flow even when canonical discovery starts in the right column', () => {
    const pair = (
      id: string,
      captionId: string,
      label: string,
    ): [ResearchNode, ResearchNode] => [
      {
        id,
        type: 'figure',
        objectType: 'figure',
        title: label,
        relationships: { caption: captionId, assets: [`asset-${id}`] },
        source: 'pdf:test#page=1',
      },
      {
        id: captionId,
        type: 'caption',
        text: label,
        source: 'pdf:test#page=1',
      },
    ]
    const nodes: ResearchNode[] = [
      ...pair('right-visual', 'right-caption', 'Figure 3. Right column.'),
      ...pair('left-visual-1', 'left-caption-1', 'Figure 1. Left column.'),
      ...pair('left-visual-2', 'left-caption-2', 'Figure 2. Left column.'),
    ]

    orderCanonicalVisualPairs(nodes, [
      {
        page: 1,
        column: 'right',
        sourceBox: {
          page: 1,
          x: 0.55,
          y: 0.1,
          width: 0.35,
          height: 0.15,
          rotation: 0,
          method: 'pdf-object',
        },
        visualNodeId: 'right-visual',
        captionNodeId: 'right-caption',
      },
      {
        page: 1,
        column: 'left',
        sourceBox: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.35,
          height: 0.15,
          rotation: 0,
          method: 'pdf-object',
        },
        visualNodeId: 'left-visual-1',
        captionNodeId: 'left-caption-1',
      },
      {
        page: 1,
        column: 'left',
        sourceBox: {
          page: 1,
          x: 0.1,
          y: 0.5,
          width: 0.35,
          height: 0.15,
          rotation: 0,
          method: 'pdf-object',
        },
        visualNodeId: 'left-visual-2',
        captionNodeId: 'left-caption-2',
      },
    ])

    expect(nodes.map((node) => node.id)).toEqual([
      'left-visual-1',
      'left-caption-1',
      'left-visual-2',
      'left-caption-2',
      'right-visual',
      'right-caption',
    ])
  })

  it('keeps mixed span and column visual pairs at their caption anchors when a later column pair is materialized', () => {
    const pair = (
      id: string,
      captionId: string,
      label: string,
    ): [ResearchNode, ResearchNode] => [
      {
        id,
        type: 'figure',
        objectType: 'equation',
        title: label,
        relationships: { caption: captionId, assets: [`asset-${id}`] },
        source: 'pdf:test#page=1',
      },
      {
        id: captionId,
        type: 'caption',
        text: label,
        source: 'pdf:test#page=1',
      },
    ]
    const nodes: ResearchNode[] = [
      visualOrderParagraph('opening-prose', 'Opening source prose.'),
      ...pair('span-visual-early', 'span-caption-early', 'Equation 2'),
      visualOrderParagraph('bridge-prose', 'The source continues.'),
      ...pair('left-visual', 'left-caption', 'Equation 3'),
      visualOrderParagraph('equation-discussion', 'Equation discussion.'),
      visualOrderHeading('later-scope', 3, 'Later source scope'),
      visualOrderParagraph('later-introduction', 'Later source prose.'),
      ...pair(
        'span-visual-late',
        'span-caption-late',
        'Display equation p001-003',
      ),
      visualOrderParagraph('following-prose', 'Following source prose.'),
      ...pair('right-visual', 'right-caption', 'Equation 4'),
    ]

    orderCanonicalVisualPairs(nodes, [
      {
        page: 1,
        column: 'span',
        sourceBox: {
          page: 1,
          x: 0.45,
          y: 0.2,
          width: 0.1,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
        visualNodeId: 'span-visual-early',
        captionNodeId: 'span-caption-early',
      },
      {
        page: 1,
        column: 'left',
        sourceBox: {
          page: 1,
          x: 0.3,
          y: 0.3,
          width: 0.18,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
        visualNodeId: 'left-visual',
        captionNodeId: 'left-caption',
      },
      {
        page: 1,
        column: 'span',
        sourceBox: {
          page: 1,
          x: 0.35,
          y: 0.68,
          width: 0.3,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
        visualNodeId: 'span-visual-late',
        captionNodeId: 'span-caption-late',
      },
      {
        page: 1,
        column: 'right',
        sourceBox: {
          page: 1,
          x: 0.56,
          y: 0.77,
          width: 0.1,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
        visualNodeId: 'right-visual',
        captionNodeId: 'right-caption',
      },
    ])

    expect(nodes.map((node) => node.id)).toEqual([
      'opening-prose',
      'span-visual-early',
      'span-caption-early',
      'bridge-prose',
      'left-visual',
      'left-caption',
      'equation-discussion',
      'later-scope',
      'later-introduction',
      'span-visual-late',
      'span-caption-late',
      'following-prose',
      'right-visual',
      'right-caption',
    ])
  })

  it('keeps a float in its sole physical heading scope when an earlier section cross-references it', () => {
    const visualNodeId = 'visual-physical-scope'
    const captionNodeId = 'caption-physical-scope'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 Earlier discussion'),
      visualOrderParagraph(
        'earlier-reference',
        'Figure 21 previews the later physical result.',
      ),
      visualOrderHeading('scope-b', 2, 'A.2 Physical figure scope'),
      visualOrderParagraph(
        'physical-prose',
        'The source-backed result is developed here.',
      ),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
      visualOrderHeading('scope-c', 2, 'A.3 Following discussion'),
    ]
    const earlierReference = matchedVisualOrderReference({
      id: 'cross-reference-earlier-physical-scope',
      anchorNodeId: 'earlier-reference',
      referenceRegionId: 'earlier-reference-region',
      visualNodeId,
      page: 1,
      y: 0.3,
    })
    const sourceOrder = nodes.map((node) => node.id)
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [
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
          visualNodeId,
          captionNodeId,
        },
      ],
      [earlierReference],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          severity: 'info',
          relationshipId: earlierReference.id,
        }),
      ]),
    )
  })

  it('keeps a top-of-page float in the preceding-page physical heading scope when a later section references it', () => {
    const visualNodeId = 'visual-previous-page-scope'
    const captionNodeId = 'caption-previous-page-scope'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 Physical scope'),
      visualOrderParagraph(
        'scope-a-prose',
        'The section continues across the page boundary.',
      ),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
      visualOrderHeading('scope-b', 2, 'A.2 Later reference scope'),
      visualOrderParagraph(
        'later-reference',
        'The later section revisits Figure 21.',
      ),
      visualOrderHeading('scope-c', 2, 'A.3 Following scope'),
    ]
    const laterReference = matchedVisualOrderReference({
      id: 'cross-reference-later-previous-page-scope',
      anchorNodeId: 'later-reference',
      referenceRegionId: 'later-reference-region',
      visualNodeId,
      page: 2,
      y: 0.5,
    })
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
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })
    const sourceOrder = nodes.map((node) => node.id)
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 2,
          column: 'left',
          sourceBox: {
            page: 2,
            x: 0.1,
            y: 0.08,
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
      {
        'scope-a': sourceEvidence(1, 0.08, 0.72, 0.84),
        'scope-b': sourceEvidence(2, 0.08, 0.4, 0.84),
        'scope-c': sourceEvidence(3, 0.08, 0.1, 0.84),
      },
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
})
