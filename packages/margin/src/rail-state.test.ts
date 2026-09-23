import { expect, it } from 'vitest'
import { createSemanticTextAnchorFromRange } from './anchor'
import {
  decodeWebAnnotation,
  orderAndFilterEntries,
  reconcileEntries,
} from './rail-state'

const target = createSemanticTextAnchorFromRange('later', 'blue text', 0, 4)

it('reads a service annotation as a codepoint anchor with its body and visibility', () => {
  const entry = decodeWebAnnotation({
    id: 'urn:margin:annotation:one',
    motivation: 'commenting',
    body: { type: 'TextualBody', value: 'a thought', format: 'text/plain' },
    'margin:visibility': 'private',
    target: {
      source: 'https://example.test/book',
      selector: [
        { type: 'TextQuoteSelector', exact: '🌊', prefix: '', suffix: '' },
        { type: 'TextPositionSelector', start: 0, end: 1 },
        { type: 'margin:StructSelector', 'margin:nodeId': 'early' },
      ],
    },
  })
  expect(entry).toMatchObject({
    visibility: 'private',
    annotation: {
      kind: 'note',
      body: 'a thought',
      target: {
        nodeId: 'early',
        positionUnit: 'codepoint',
        position: { start: 0, end: 1 },
      },
    },
  })
})

it('orders by document placement and searches quote or body', () => {
  const entries = [
    {
      annotation: {
        id: 'later',
        kind: 'note' as const,
        target,
        body: 'Ocean',
        geometryCache: [],
      },
      visibility: 'private' as const,
    },
    {
      annotation: {
        id: 'early',
        kind: 'note' as const,
        target: { ...target, nodeId: 'early' },
        body: 'Sky',
        geometryCache: [],
      },
      visibility: 'public' as const,
    },
  ]
  const placements = [
    {
      status: 'anchored' as const,
      nodeId: 'later',
      start: 0,
      end: 4,
      matchedBy: 'unique-quote' as const,
    },
    {
      status: 'anchored' as const,
      nodeId: 'early',
      start: 0,
      end: 4,
      matchedBy: 'unique-quote' as const,
    },
  ]
  expect(
    orderAndFilterEntries(entries, placements, ['early', 'later'], '').map(
      (entry) => entry.annotation.id,
    ),
  ).toEqual(['early', 'later'])
  expect(
    orderAndFilterEntries(entries, placements, ['early', 'later'], 'OCEAN').map(
      (entry) => entry.annotation.id,
    ),
  ).toEqual(['later'])
})

it('treats API refresh as authoritative except for each distinct in-flight write', () => {
  const entry = (id: string, body: string) => ({
    annotation: { id, kind: 'note' as const, target, body, geometryCache: [] },
    visibility: 'private' as const,
  })
  const current = [
    entry('revoked', 'old'),
    entry('editing', 'optimistic'),
    entry('deleting', 'removed'),
    entry('local-post', 'unsaved'),
  ]
  const server = [
    entry('editing', 'stale'),
    entry('deleting', 'still there'),
    entry('fresh', 'new'),
  ]
  expect(
    reconcileEntries(
      server,
      current,
      new Set(['local-post']),
      new Set(['editing', 'deleting']),
      new Set(['deleting']),
    ),
  ).toEqual([current[1], server[2], current[3]])
})
