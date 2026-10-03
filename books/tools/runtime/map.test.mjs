import { describe, expect, it } from 'vitest'

import { mapCounts, mapElements, topicStates } from './map.mjs'

// a -> b -> c, and d needs nothing; e has nothing written yet.
const topic = (id, requiresIds, nodes) => ({
  id,
  title: id.toUpperCase(),
  part: 1,
  partName: 'Basics',
  agent: '',
  requiresIds,
  requires: requiresIds.map((r) => r.toUpperCase()),
  unlocks: [],
  nodes,
})
const TOPICS = [
  topic('a', [], [{ id: 'ch-a', title: 'A', kind: 'concept' }, { id: 'a1', title: 'A1', kind: 'challenge' }]),
  topic('b', ['a'], [{ id: 'b1', title: 'B1', kind: 'challenge' }, { id: 'b2', title: 'B2', kind: 'challenge' }]),
  topic('c', ['b'], [{ id: 'c1', title: 'C1', kind: 'challenge' }]),
  topic('d', [], [{ id: 'ch-d', title: 'D', kind: 'concept' }]),
  topic('e', ['a'], []),
]

describe('topicStates', () => {
  it('follows the preview: cleared, open, locked, empty', () => {
    expect(Object.fromEntries(topicStates(TOPICS, []))).toEqual({
      a: 'open', b: 'locked', c: 'locked', d: 'open', e: 'empty',
    })
    expect(Object.fromEntries(topicStates(TOPICS, ['a1', 'b1']))).toEqual({
      a: 'cleared', b: 'open', c: 'locked', d: 'open', e: 'empty',
    })
    expect(Object.fromEntries(topicStates(TOPICS, ['a1', 'b1', 'b2']))).toEqual({
      a: 'cleared', b: 'cleared', c: 'open', d: 'open', e: 'empty',
    })
  })

  it('treats a topic with only concepts as never cleared', () => {
    expect(topicStates(TOPICS, ['ch-d']).get('d')).toBe('open')
  })
})

describe('mapElements', () => {
  it('draws one node per topic and one edge per requirement, with progress on each', () => {
    const elements = mapElements(TOPICS, ['a1'])
    const nodes = elements.filter((e) => !e.data.source)
    const edges = elements.filter((e) => e.data.source)
    expect(nodes.map((n) => n.data.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(edges.map((e) => e.data.id)).toEqual(['a->b', 'b->c', 'a->e'])
    const a = nodes[0].data
    expect([a.state, a.solved, a.total]).toEqual(['cleared', 1, 1])
    expect(a.nodes.find((n) => n.id === 'a1').solved).toBe(true)
  })
})

describe('mapCounts', () => {
  it('counts topics, cleared ones and ones with something written', () => {
    expect(mapCounts(TOPICS, ['a1'])).toEqual({ topics: 5, cleared: 1, written: 4 })
  })
})
