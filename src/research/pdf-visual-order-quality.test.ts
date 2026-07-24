import { describe, expect, it } from 'vitest'
import type {
  PdfReadingOrderGraph,
  PdfVisualRelationship,
} from './import-types'
import {
  canonicalVisualOrderViolationRelationshipIds,
} from './pdf-quality'
import type { ResearchPaper } from './schema'

function relationship(
  ordinal: number,
  captionRegionId: string,
): PdfVisualRelationship {
  return {
    id: `figure-relationship-${ordinal}`,
    kind: 'figure',
    label: `Figure ${ordinal}`,
    captionRegionId,
    sourceRegionIds: [captionRegionId],
    sourceLineIds: [`${captionRegionId}-line`],
    sourceObjectIds: [`figure-object-${ordinal}`],
    assetIds: [`figure-asset-${ordinal}`],
    status: 'matched',
    confidence: 1,
    evidence: ['source-preserved'],
    candidates: [],
    sourceBoxes: [
      {
        page: ordinal,
        x: 0.1,
        y: 0.2,
        width: 0.8,
        height: 0.2,
        rotation: 0,
        method: 'pdf-object',
      },
    ],
    sourceText: `Figure ${ordinal}. Caption.`,
    altText: `Figure ${ordinal}. Caption.`,
    altTextSource: 'caption',
    canonicalNodeId: `figure-${ordinal}`,
    captionNodeId: `caption-${ordinal}`,
  }
}

function paper(order: readonly number[]): ResearchPaper {
  return {
    id: 'visual-order-paper',
    version: '1.0.0',
    status: 'working',
    title: 'Visual order',
    subtitle: 'Test',
    authors: ['Test'],
    updated: '2026-07-24',
    abstract: 'Test',
    nodes: order.flatMap((ordinal) => [
      {
        id: `figure-${ordinal}`,
        type: 'figure' as const,
        title: `Figure ${ordinal}`,
        source: 'test',
        relationships: {
          caption: `caption-${ordinal}`,
          assets: [`figure-asset-${ordinal}`],
        },
      },
      {
        id: `caption-${ordinal}`,
        type: 'caption' as const,
        text: `Figure ${ordinal}. Caption.`,
        source: 'test',
      },
    ]),
  }
}

function readingOrder(regionIds: readonly string[]): PdfReadingOrderGraph {
  return {
    schemaVersion: '1.0.0',
    regionIds: [...regionIds],
    order: [...regionIds],
    edges: [],
    resolutions: [],
    acyclic: true,
    evaluation: {
      schemaVersion: '1.0.0',
      algorithm: 'deterministic-geometry-v1',
      mode: 'deterministic-only',
      regionCount: regionIds.length,
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
  }
}

function typedRelationship(
  kind: PdfVisualRelationship['kind'],
  ordinal: number,
  captionRegionId: string,
): PdfVisualRelationship {
  const value = relationship(ordinal, captionRegionId)
  return {
    ...value,
    id: `${kind}-relationship-${ordinal}`,
    kind,
    label: `${kind === 'table' ? 'Table' : kind === 'equation' ? 'Equation' : 'Figure'} ${ordinal}`,
    sourceRegionIds: [`${kind}-source-${ordinal}`],
    sourceLineIds: [`${kind}-source-${ordinal}-line`],
    sourceObjectIds: [`${kind}-object-${ordinal}`],
    assetIds: [`${kind}-asset-${ordinal}`],
    canonicalNodeId: `${kind}-${ordinal}`,
    captionNodeId: `${kind}-caption-${ordinal}`,
  }
}

function paperForRelationships(
  ordered: readonly PdfVisualRelationship[],
): ResearchPaper {
  return {
    id: 'mixed-visual-order-paper',
    version: '1.0.0',
    status: 'working',
    title: 'Mixed visual order',
    subtitle: 'Test',
    authors: ['Test'],
    updated: '2026-07-24',
    abstract: 'Test',
    nodes: ordered.flatMap((item) => [
      {
        id: item.canonicalNodeId!,
        type: 'figure' as const,
        objectType: item.kind,
        title: item.label,
        source: 'test',
        relationships: {
          caption: item.captionNodeId!,
          assets: [...item.assetIds],
        },
      },
      {
        id: item.captionNodeId!,
        type: 'caption' as const,
        text: `${item.label}. Caption.`,
        source: 'test',
      },
    ]),
  }
}

describe('canonical visual source order', () => {
  const relationships = [
    relationship(1, 'caption-region-1'),
    relationship(2, 'caption-region-2'),
    relationship(3, 'caption-region-3'),
  ]
  const sourceOrder = readingOrder([
    'caption-region-1',
    'caption-region-2',
    'caption-region-3',
  ])

  it('accepts source-monotone atomic visual-caption pairs', () => {
    expect(
      canonicalVisualOrderViolationRelationshipIds(
        paper([1, 2, 3]),
        relationships,
        sourceOrder,
      ),
    ).toEqual([])
  })

  it('fails closed when float placement reverses source-proved pairs', () => {
    expect(
      canonicalVisualOrderViolationRelationshipIds(
        paper([1, 3, 2]),
        relationships,
        sourceOrder,
      ),
    ).toEqual(['figure-relationship-2', 'figure-relationship-3'])
  })

  it('does not invent order when two pairs share one source rank', () => {
    expect(
      canonicalVisualOrderViolationRelationshipIds(
        paper([2, 1, 3]),
        [
          relationship(1, 'shared-caption-region'),
          relationship(2, 'shared-caption-region'),
          relationship(3, 'caption-region-3'),
        ],
        readingOrder(['shared-caption-region', 'caption-region-3']),
      ),
    ).toEqual([])
  })

  it('checks each visual kind independently when figures and tables interleave', () => {
    const figureOne = typedRelationship('figure', 1, 'figure-caption-region-1')
    const figureTwo = typedRelationship('figure', 2, 'figure-caption-region-2')
    const tableOne = typedRelationship('table', 1, 'table-caption-region-1')
    const tableTwo = typedRelationship('table', 2, 'table-caption-region-2')

    expect(
      canonicalVisualOrderViolationRelationshipIds(
        paperForRelationships([tableOne, figureOne, tableTwo, figureTwo]),
        [figureOne, tableOne, figureTwo, tableTwo],
        readingOrder([
          'figure-caption-region-1',
          'table-caption-region-1',
          'figure-caption-region-2',
          'table-caption-region-2',
        ]),
      ),
    ).toEqual([])
  })
})
