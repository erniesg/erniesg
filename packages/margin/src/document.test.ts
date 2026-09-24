import { describe, expect, it } from 'vitest'
import {
  createSemanticTextAnchor,
  textAnnotationSchema,
  resolveTextAnchor,
  withStructSelector,
  type AnchorableNode,
  type TextAnnotation,
} from './anchor'
import {
  orphanedPlacements,
  placeAnnotations,
  resolveAnchorInDocument,
} from './document'

const FIRST =
  'A page is a rendition, not a document. Once meaning becomes coordinates, ' +
  'every new screen or sheet becomes a repair job.'
const SECOND =
  'The renderer owns geometry. The document owns meaning, and the two meet ' +
  'only at the moment of composition.'
const QUOTE = 'Once meaning becomes coordinates'

function block(
  id: string,
  text: string,
  digest = 'digest-of-' + id,
): AnchorableNode {
  return { id, type: 'paragraph', text, structId: id, structDigest: digest }
}

const graph = [
  block('block-intro-prose-1', FIRST),
  block('block-intro-prose-2', SECOND),
]

describe('document-wide wire anchors', () => {
  const nodes = [
    block('one', '🌊 before '),
    block('two', 'x then x'),
    block('figure', 'x'),
  ]

  it('converts absolute codepoint positions and checks cross-node context', () => {
    const placement = resolveAnchorInDocument(
      {
        nodeId: '@document',
        positionUnit: 'codepoint',
        position: { start: 9, end: 10 },
        quote: { exact: 'x', prefix: 'before ', suffix: ' then' },
      },
      nodes,
    )
    expect(placement).toMatchObject({
      status: 'anchored',
      nodeId: 'two',
      start: 0,
      end: 1,
      matchedBy: 'position-and-context',
    })
  })

  it('refuses genuinely indistinguishable occurrences', () => {
    const placement = resolveAnchorInDocument(
      {
        nodeId: '@document',
        positionUnit: 'codepoint',
        position: { start: 99, end: 100 },
        quote: { exact: 'x', prefix: '', suffix: '' },
      },
      [block('a', 'x'), block('b', 'x')],
    )
    expect(placement).toMatchObject({ status: 'orphaned', reason: 'ambiguous' })
  })
})

const anchor = withStructSelector(
  createSemanticTextAnchor('block-intro-prose-1', FIRST, QUOTE),
  { id: 'block-intro-prose-1', digest: 'digest-of-block-intro-prose-1' },
)

/** The five edits criterion 6 names, each against the same stored anchor. */
describe('re-anchoring across realistic edits', () => {
  it('survives text inserted above the anchor', () => {
    const edited = [
      block(
        'block-intro-prose-1',
        `A new opening sentence. ${FIRST}`,
        'digest-after-insert',
      ),
      graph[1],
    ]

    expect(resolveAnchorInDocument(anchor, edited)).toMatchObject({
      status: 'anchored',
      nodeId: 'block-intro-prose-1',
      start: FIRST.indexOf(QUOTE) + 'A new opening sentence. '.length,
      matchedBy: 'quote-and-context',
    })
  })

  it('survives the containing paragraph being reworded around it', () => {
    const reworded = FIRST.replace(
      'A page is a rendition, not a document.',
      'A page is one rendition among several.',
    )
    const edited = [
      block('block-intro-prose-1', reworded, 'digest-after-rewording'),
      graph[1],
    ]

    expect(resolveAnchorInDocument(anchor, edited)).toMatchObject({
      status: 'anchored',
      nodeId: 'block-intro-prose-1',
      start: reworded.indexOf(QUOTE),
    })
  })

  it('follows its own words into a different block', () => {
    const moved = [
      block(
        'block-intro-prose-1',
        'The opening paragraph now says something else entirely.',
        'digest-emptied',
      ),
      block('block-intro-prose-2', `${SECOND} ${FIRST}`, 'digest-grew'),
    ]

    expect(resolveAnchorInDocument(anchor, moved)).toMatchObject({
      status: 'anchored',
      nodeId: 'block-intro-prose-2',
      matchedBy: 'relocated-quote',
      movedFromNodeId: 'block-intro-prose-1',
    })
  })

  it('relocates when the old node becomes non-text', () => {
    const edited: AnchorableNode[] = [
      { id: 'block-intro-prose-1', type: 'figure' },
      block('block-intro-prose-2', `${SECOND} ${FIRST}`, 'digest-grew'),
    ]
    expect(resolveAnchorInDocument(anchor, edited)).toMatchObject({
      status: 'anchored',
      nodeId: 'block-intro-prose-2',
      matchedBy: 'relocated-quote',
      movedFromNodeId: 'block-intro-prose-1',
    })
  })

  it('keeps a non-text old node orphaned when relocation is ambiguous', () => {
    const edited: AnchorableNode[] = [
      { id: 'block-intro-prose-1', type: 'figure' },
      block('one', `${QUOTE}.`, 'one'),
      block('two', `${QUOTE}.`, 'two'),
    ]
    expect(resolveAnchorInDocument(anchor, edited)).toMatchObject({
      status: 'orphaned',
      reason: 'ambiguous',
      quote: QUOTE,
    })
  })

  it('orphans rather than guess when the same quote appears twice', () => {
    const duplicated = [
      block(
        'block-intro-prose-1',
        FIRST.replace(QUOTE, 'Something else'),
        'd1',
      ),
      block('block-intro-prose-2', `${QUOTE}. ${QUOTE}.`, 'd2'),
    ]

    expect(resolveAnchorInDocument(anchor, duplicated)).toMatchObject({
      status: 'orphaned',
      reason: 'ambiguous',
      quote: QUOTE,
    })
  })

  it('orphans when the anchored text is deleted outright', () => {
    const deleted = [
      block(
        'block-intro-prose-1',
        'A page is a rendition, not a document.',
        'd3',
      ),
      graph[1],
    ]

    expect(resolveAnchorInDocument(anchor, deleted)).toMatchObject({
      status: 'orphaned',
      reason: 'quote-not-found',
      quote: QUOTE,
    })
  })

  it('orphans when the whole block is gone and the words with it', () => {
    expect(resolveAnchorInDocument(anchor, [graph[1]])).toMatchObject({
      status: 'orphaned',
      reason: 'missing-node',
      quote: QUOTE,
    })
  })
})

describe('placing a whole rail', () => {
  const highlight: TextAnnotation = textAnnotationSchema.parse({
    id: 'a',
    kind: 'highlight',
    target: anchor,
    appearance: { color: 'amber' },
    geometryCache: [],
  })
  const orphan: TextAnnotation = textAnnotationSchema.parse({
    id: 'b',
    kind: 'note',
    target: createSemanticTextAnchor(
      'block-gone-prose-1',
      'A sentence from a deleted block.',
      'a deleted block',
    ),
    body: 'Still worth keeping.',
    geometryCache: [],
  })

  it('returns an outcome for every annotation, in order', () => {
    const placements = placeAnnotations([highlight, orphan], graph)

    expect(placements).toHaveLength(2)
    expect(placements.map(({ annotation }) => annotation.id)).toEqual([
      'a',
      'b',
    ])
    expect(placements[0].placement.status).toBe('anchored')
    expect(placements[1].placement).toMatchObject({
      status: 'orphaned',
      reason: 'missing-node',
      quote: 'a deleted block',
    })
  })

  it('keeps the orphan readable instead of dropping it', () => {
    const orphans = orphanedPlacements(
      placeAnnotations([highlight, orphan], graph),
    )

    expect(orphans).toHaveLength(1)
    expect(orphans[0].annotation).toBe(orphan)
  })
})

/**
 * Rule: a `@document` anchor's placement is exactly its document-wide
 * resolution. No block-local rung (`relocate` after a unique quote, after
 * ambiguity, or after quote-not-found) may re-decide it, because those check
 * context one block at a time and the sentinel id never equals a real node id.
 */
describe('document-scoped anchors are placed by the document pass alone', () => {
  // "abc target d" occurs twice in the document stream. The first occurrence's
  // prefix crosses the boundary between `left` and `right`; the second sits
  // wholly inside `later`. Block-local context only sees the second.
  const nodes = [
    block('left', 'ab'),
    block('right', 'c target d'),
    block('later', 'zz abc target d'),
    block('lone', 'solitary words'),
  ]
  const scoped = (exact: string, prefix: string, suffix: string) => ({
    nodeId: '@document',
    position: { start: 0, end: exact.length },
    quote: { exact, prefix, suffix },
  })
  const cases = {
    ambiguousAcrossBoundary: scoped('target', 'abc ', ' d'),
    uniqueQuote: scoped('solitary', 'nothing', 'nothing'),
    notFound: scoped('absent', '', ''),
    contextual: scoped('target', 'zz abc ', ' d'),
  }

  for (const [name, anchor] of Object.entries(cases)) {
    it(`mirrors resolveTextAnchor for ${name}`, () => {
      const resolution = resolveTextAnchor(anchor, nodes)
      const placement = resolveAnchorInDocument(anchor, nodes)
      if (resolution.status === 'resolved') {
        expect(placement).toEqual({
          status: 'anchored',
          nodeId: resolution.nodeId,
          start: resolution.start,
          end: resolution.end,
          matchedBy: resolution.matchedBy,
        })
      } else {
        expect(placement.status).toBe('orphaned')
        expect(placement).toMatchObject({
          nodeId: '@document',
          reason: resolution.status === 'ambiguous' ? 'ambiguous' : resolution.reason,
        })
      }
    })
  }

  it('keeps the cross-boundary duplicate ambiguous rather than picking one', () => {
    const placement = resolveAnchorInDocument(cases.ambiguousAcrossBoundary, nodes)
    expect(placement).toMatchObject({ status: 'orphaned', reason: 'ambiguous' })
  })
})
