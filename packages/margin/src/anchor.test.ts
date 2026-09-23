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
import { annotationsFromAnchors } from './controller'

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
