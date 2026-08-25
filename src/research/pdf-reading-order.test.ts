import { describe, expect, it } from 'vitest'
import type { PdfReadingOrderGraph } from './import-types'
import { evaluateReadingOrder, hasAcceptedCycle } from './pdf-reading-order'

describe('pdf reading order', () => {
  it('detects a cycle formed only by accepted edges', () => {
    expect(
      hasAcceptedCycle(
        ['first', 'second', 'third'],
        [
          {
            id: 'edge-1',
            from: 'first',
            to: 'second',
            status: 'accepted',
            confidence: 1,
            evidence: [],
            sourceBoxes: [],
          },
          {
            id: 'edge-2',
            from: 'second',
            to: 'first',
            status: 'accepted',
            confidence: 1,
            evidence: [],
            sourceBoxes: [],
          },
          {
            id: 'edge-3',
            from: 'third',
            to: 'first',
            status: 'candidate',
            confidence: 0.5,
            evidence: [],
            sourceBoxes: [],
          },
        ],
      ),
    ).toBe(true)
  })

  it('reports a hand-checked partial ordering accuracy', () => {
    const graph: PdfReadingOrderGraph = {
      schemaVersion: '1.0.0',
      regionIds: ['first', 'second', 'third'],
      order: ['first', 'third', 'second'],
      edges: [],
      resolutions: [],
      acyclic: true,
      evaluation: {
        schemaVersion: '1.0.0',
        algorithm: 'deterministic-geometry-v1',
        mode: 'deterministic-only',
        regionCount: 3,
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

    expect(
      evaluateReadingOrder(graph, ['first', 'second', 'third']),
    ).toMatchObject({
      orderAccuracy: 0.33333,
    })
  })
})
