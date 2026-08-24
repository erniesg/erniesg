import { describe, expect, it } from 'vitest'
import { orderCanonicalVisualPairs } from './pdf-visual-order'
import type { ResearchNode } from './schema'

function visualPair(
  visualNodeId: string,
  captionNodeId: string,
  label: string,
): [ResearchNode, ResearchNode] {
  return [
    {
      id: visualNodeId,
      type: 'figure',
      objectType: 'figure',
      title: label,
      relationships: {
        caption: captionNodeId,
        assets: [`asset-${visualNodeId}`],
      },
      source: 'pdf:test#page=1',
    },
    {
      id: captionNodeId,
      type: 'caption',
      text: label,
      source: 'pdf:test#page=1',
    },
  ]
}

describe('canonical PDF visual pair ordering', () => {
  it('orders source-proved columns through the direct module', () => {
    const nodes: ResearchNode[] = [
      ...visualPair('right-visual', 'right-caption', 'Figure 2. Right.'),
      ...visualPair('left-visual', 'left-caption', 'Figure 1. Left.'),
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
          height: 0.2,
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
          height: 0.2,
          rotation: 0,
          method: 'pdf-object',
        },
        visualNodeId: 'left-visual',
        captionNodeId: 'left-caption',
      },
    ])

    expect(nodes.map((node) => node.id)).toEqual([
      'left-visual',
      'left-caption',
      'right-visual',
      'right-caption',
    ])
  })
})
