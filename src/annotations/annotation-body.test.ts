import { describe, expect, it } from 'vitest'
import { annotationBody, textAnnotationSchema } from './annotations'

/**
 * `proposal` joined the union and every consumer testing `kind === 'note'`
 * silently rendered nothing for it — a body a reader wrote, stored and
 * invisible. `annotationBody` is exhaustive over the union, so adding a kind
 * stops compiling until it says whether it has a body.
 */
const anchor = {
  nodeId: 'p-1',
  position: { start: 0, end: 5 },
  quote: { exact: 'hello', prefix: '', suffix: '' },
}

function parse(kind: string, extra: Record<string, unknown> = {}) {
  return textAnnotationSchema.parse({
    id: `a-${kind}`,
    kind,
    target: anchor,
    geometryCache: [],
    ...extra,
  })
}

describe('annotationBody', () => {
  it('reports the body of a note and of a proposal', () => {
    expect(annotationBody(parse('note', { body: 'a remark' }))).toBe('a remark')
    expect(annotationBody(parse('proposal', { body: 'a rewrite' }))).toBe(
      'a rewrite',
    )
  })

  it('reports none for a highlight', () => {
    expect(
      annotationBody(parse('highlight', { appearance: { color: 'amber' } })),
    ).toBeNull()
  })

  it('covers every kind the schema accepts', () => {
    // If the union grows and this list does not, the parse below throws — so the
    // test fails rather than quietly checking a subset.
    const kinds = ['highlight', 'note', 'proposal'] as const
    for (const kind of kinds) {
      const annotation =
        kind === 'highlight'
          ? parse(kind, { appearance: { color: 'amber' } })
          : parse(kind, { body: 'a body' })
      expect(() => annotationBody(annotation)).not.toThrow()
    }
  })
})
