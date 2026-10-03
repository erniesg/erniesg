import { describe, expect, it } from 'vitest'
import {
  annotationBody,
  createSemanticTextAnchor,
  createSemanticTextAnchorFromRange,
  resolveTextAnchor,
  semanticTextAnchorSchema,
  withStructSelector,
  type AnchorableNode,
} from './anchor'
import { annotationsFromAnchors, isPaintedPlacement, paintTargetsFor } from './controller'
import { NOTE_PAINT_KEY } from './palette'

const PROSE =
  'A page is a rendition, not a document. Once meaning becomes coordinates, ' +
  'every new screen or sheet becomes a repair job.'
const QUOTE = 'Once meaning becomes coordinates'

function node(overrides: Partial<AnchorableNode> = {}): AnchorableNode {
  return {
    id: 'block-intro-prose-1',
    type: 'paragraph',
    text: PROSE,
    structId: 'block-intro-prose-1',
    structDigest: 'a1b2c3d4e5f6',
    ...overrides,
  }
}

const anchor = createSemanticTextAnchor('block-intro-prose-1', PROSE, QUOTE)
const structAnchor = withStructSelector(anchor, {
  id: 'block-intro-prose-1',
  digest: 'a1b2c3d4e5f6',
})

describe('the anchor schema', () => {
  it('keeps proposal intent and replacement body through the public annotation factory', () => {
    const [proposal] = annotationsFromAnchors([anchor], {
      kind: 'proposal',
      body: 'replacement',
      id: 'p',
    })
    expect(proposal.kind).toBe('proposal')
    expect(annotationBody(proposal)).toBe('replacement')
  })
  it('omits the struct selector entirely when none was given', () => {
    expect(anchor).not.toHaveProperty('struct')
    expect(Object.keys(anchor).sort()).toEqual(['nodeId', 'position', 'quote'])
  })

  it('keeps offsets and quote in agreement', () => {
    expect(() =>
      semanticTextAnchorSchema.parse({
        ...anchor,
        position: {
          start: anchor.position.start,
          end: anchor.position.end + 1,
        },
      }),
    ).toThrow(/Text offsets must span the stored exact quote/)
  })

  it('adds a struct selector without disturbing the rest of the anchor', () => {
    const { struct, ...rest } = structAnchor
    expect(rest).toEqual(anchor)
    expect(struct).toEqual({
      id: 'block-intro-prose-1',
      digest: 'a1b2c3d4e5f6',
    })
  })
})

describe('the selector chain', () => {
  it('matches by struct id first when the block digest is unchanged', () => {
    expect(resolveTextAnchor(structAnchor, [node()])).toEqual({
      status: 'resolved',
      nodeId: 'block-intro-prose-1',
      start: anchor.position.start,
      end: anchor.position.end,
      matchedBy: 'struct-id',
    })
  })

  it('falls through to position and context when the digest drifted', () => {
    expect(
      resolveTextAnchor(structAnchor, [node({ structDigest: 'ffffffffffff' })]),
    ).toMatchObject({ status: 'resolved', matchedBy: 'position-and-context' })
  })

  it('follows the struct id when the surface renamed the node', () => {
    const renamed = node({ id: 'paragraph-7', structId: 'block-intro-prose-1' })

    expect(resolveTextAnchor(structAnchor, [renamed])).toEqual({
      status: 'resolved',
      nodeId: 'paragraph-7',
      start: anchor.position.start,
      end: anchor.position.end,
      matchedBy: 'struct-id',
    })
  })

  it('resolves anchors that carry no struct selector exactly as before', () => {
    const shifted = node({ text: `An earlier sentence. ${PROSE}` })

    expect(resolveTextAnchor(anchor, [shifted])).toMatchObject({
      status: 'resolved',
      matchedBy: 'quote-and-context',
      start: anchor.position.start + 'An earlier sentence. '.length,
    })
  })

  it('picks the right occurrence of a duplicated quote from its context', () => {
    const text = 'the loop repeats here and the loop repeats there'
    const second = text.lastIndexOf('the loop repeats')
    const duplicated = createSemanticTextAnchorFromRange(
      'block-dup-prose-1',
      text,
      second,
      second + 'the loop repeats'.length,
      12,
    )
    // Offsets drift, so only the stored prefix and suffix can tell the two
    // occurrences apart. Resolving to the first one would be a wrong answer,
    // not a near miss.
    const prefixed = `Preamble. ${text}`

    expect(
      resolveTextAnchor(duplicated, [
        node({
          id: 'block-dup-prose-1',
          structId: 'block-dup-prose-1',
          text: prefixed,
        }),
      ]),
    ).toMatchObject({
      status: 'resolved',
      start: second + 'Preamble. '.length,
      matchedBy: 'quote-and-context',
    })
  })

  it('reports ambiguity rather than choosing between equal candidates', () => {
    const text = 'repeat gap repeat'
    const ambiguous = semanticTextAnchorSchema.parse({
      nodeId: 'block-dup-prose-1',
      position: { start: 2, end: 8 },
      quote: { exact: 'repeat', prefix: 'missing', suffix: 'context' },
    })

    expect(
      resolveTextAnchor(ambiguous, [
        node({ id: 'block-dup-prose-1', structId: 'block-dup-prose-1', text }),
      ]),
    ).toMatchObject({
      status: 'ambiguous',
      candidates: [{ start: 0 }, { start: 11 }],
    })
  })

  it('refuses a node that carries no text', () => {
    expect(
      resolveTextAnchor(anchor, [
        { id: 'block-intro-prose-1', type: 'figure' },
      ]),
    ).toEqual({
      status: 'unresolved',
      nodeId: 'block-intro-prose-1',
      reason: 'non-text-node',
    })
  })
})

describe('a note tagged with a role', () => {
  it('carries the role colour and paints in it; an untagged note paints as a note', () => {
    const [tagged] = annotationsFromAnchors([anchor], {
      kind: 'note',
      body: 'why this order?',
      color: 'question',
      id: 'n1',
    })
    expect(tagged).toMatchObject({
      kind: 'note',
      body: 'why this order?',
      appearance: { color: 'question' },
    })
    const [plain] = annotationsFromAnchors([anchor], {
      kind: 'note',
      body: 'plain',
      id: 'n2',
    })
    expect(plain).not.toHaveProperty('appearance')

    const placement = {
      status: 'anchored' as const,
      nodeId: anchor.nodeId,
      start: anchor.position.start,
      end: anchor.position.end,
    }
    const colours = paintTargetsFor([
      { annotation: tagged, placement },
      { annotation: plain, placement },
    ] as never).map((target) => target.color)
    expect(colours).toEqual(['question', NOTE_PAINT_KEY])
  })

  it('does not paint a sketch note over its block\'s opening text', () => {
    // A sketch's quote only finds its block again; the drawing is the target.
    const placement = {
      status: 'anchored',
      nodeId: 'block-intro-prose-1',
      start: anchor.position.start,
      end: anchor.position.end,
    }
    const sketchNote = {
      id: 's',
      kind: 'note',
      body: 'margin:sketch:v1\n' + JSON.stringify({
        version: 1, note: 'see', anchor: { blockId: 'block-intro-prose-1', quote: 'A page' },
        region: { x: 0, y: 0, width: 0.5, height: 0.2 }, strokes: [],
      }),
    }
    const note = { id: 'n', kind: 'note', body: 'plain note' }
    const ids = paintTargetsFor([
      { annotation: sketchNote, placement },
      { annotation: note, placement },
    ] as never).map((target) => target.id)
    expect(ids).toEqual(['n'])
    // Painting and clicking share one rule: unmarked text is never a click target.
    expect(isPaintedPlacement({ annotation: sketchNote, placement } as never)).toBe(false)
    expect(isPaintedPlacement({ annotation: note, placement } as never)).toBe(true)
  })
})

