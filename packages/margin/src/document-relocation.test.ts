import { describe, expect, it } from 'vitest'
import { resolveAnchorInDocument } from './document'
import { withStructSelector } from './anchor'

/**
 * `unique-quote` means "the only occurrence in this block" and nothing more — the
 * stored prefix and suffix were never confirmed. So when the original moves to
 * another block and a duplicate happens to remain behind, accepting the in-node
 * result attaches the annotation to the duplicate and never looks at the
 * occurrence whose whole neighbourhood still matches.
 */
const anchor = {
  nodeId: 'p-1',
  // `Once ` is five characters, so the quote starts at 5 — the struct fast path
  // checks the stored offsets, and an off-by-one there silently demotes it to a
  // context match, which is how this fixture was wrong the first time.
  position: { start: 5, end: 15 },
  quote: { exact: 'the signal', prefix: 'Once ', suffix: ' arrives,' },
}

function node(id: string, text: string) {
  return { id, type: 'prose' as const, text }
}

describe('a weak in-node match does not shadow a strong one elsewhere', () => {
  it('prefers the block whose stored context still matches', () => {
    const placement = resolveAnchorInDocument(anchor, [
      // The duplicate left behind: the only occurrence here, wrong neighbours.
      node('p-1', 'We lost the signal entirely.'),
      // Where it went: both sides of the stored context intact.
      node('p-2', 'Once the signal arrives, the loop begins.'),
    ])

    expect(placement.status).toBe('anchored')
    if (placement.status !== 'anchored') return
    expect(placement.nodeId).toBe('p-2')
    expect(placement.matchedBy).toBe('relocated-quote')
    expect(placement.movedFromNodeId).toBe('p-1')
  })

  it('keeps the in-node match when nothing elsewhere has better evidence', () => {
    const placement = resolveAnchorInDocument(anchor, [
      node('p-1', 'We lost the signal entirely.'),
      node('p-2', 'Nothing relevant in this block at all.'),
    ])

    expect(placement.status).toBe('anchored')
    if (placement.status !== 'anchored') return
    expect(placement.nodeId).toBe('p-1')
    expect(placement.matchedBy).toBe('unique-quote')
  })

  it('keeps the in-node match when the contextual match is the same block', () => {
    // `relocate` searches every block including this one, so a contextual hit
    // here must not be reported as a relocation.
    const placement = resolveAnchorInDocument(anchor, [
      node('p-1', 'Once the signal arrives, the loop begins.'),
    ])

    expect(placement.status).toBe('anchored')
    if (placement.status !== 'anchored') return
    expect(placement.nodeId).toBe('p-1')
    expect(placement.matchedBy).not.toBe('relocated-quote')
  })

  // Every rung above `unique-quote` already carries its own confirmation, so it
  // must be returned without a second document pass.
  it('returns a context-confirmed in-node match immediately', () => {
    const placement = resolveAnchorInDocument(anchor, [
      node('p-1', 'Once the signal arrives, the loop begins.'),
      node('p-2', 'Once the signal arrives, the loop begins.'),
    ])

    expect(placement.status).toBe('anchored')
    if (placement.status !== 'anchored') return
    expect(placement.nodeId).toBe('p-1')
    expect(['position-and-context', 'quote-and-context']).toContain(
      placement.matchedBy,
    )
  })

  it('still prefers the struct fast path over any of this', () => {
    const scoped = withStructSelector(anchor, { id: 'block-1', digest: 'abc' })
    const placement = resolveAnchorInDocument(scoped, [
      {
        ...node('p-1', 'Once the signal arrives, the loop begins.'),
        structId: 'block-1',
        structDigest: 'abc',
      },
      node('p-2', 'Once the signal arrives, the loop begins.'),
    ])

    expect(placement.status).toBe('anchored')
    if (placement.status !== 'anchored') return
    expect(placement.matchedBy).toBe('struct-id')
  })
})
