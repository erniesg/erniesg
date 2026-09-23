import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_SCOPE_NODE_ID,
  MAX_SOURCE_LENGTH,
  MARGIN_CONTEXT,
  MOTIVATIONS,
  recordToWebAnnotation,
  splitSource,
  STRUCT_SELECTOR_TYPE,
  webAnnotationSchema,
  webAnnotationToRecord,
  type MarginVisibility,
  type Motivation,
  type WebAnnotation,
} from './web-annotation'

const SOURCE = 'https://ernie.sg/challenges/chapter-1'
const CREATOR = 'urn:margin:principal:dev:urn%3Amargin%3Adev:ada'
const CREATED = '2026-09-22T10:00:00.000Z'

function canonicalWire(
  motivation: Motivation,
  overrides: Partial<WebAnnotation> = {},
): WebAnnotation {
  return {
    '@context': MARGIN_CONTEXT,
    id: 'urn:margin:annotation:a1',
    type: 'Annotation',
    motivation,
    ...(motivation === 'highlighting'
      ? {}
      : {
          body: {
            type: 'TextualBody' as const,
            value: 'the sentence carries the claim',
            format: 'text/plain',
          },
        }),
    target: {
      source: SOURCE,
      selector: [
        {
          type: 'TextQuoteSelector' as const,
          exact: 'meaning becomes coordinates',
          prefix: 'Once ',
          suffix: ', every new screen',
        },
        { type: 'TextPositionSelector' as const, start: 5, end: 32 },
        {
          type: STRUCT_SELECTOR_TYPE,
          'margin:nodeId': 'p-proposition-1',
          'margin:structId': 'sec-propositions',
        },
      ],
    },
    creator: CREATOR,
    created: CREATED,
    modified: CREATED,
    'margin:visibility': 'private' as MarginVisibility,
    ...overrides,
  }
}

/**
 * The mapping's own round trip. Server-owned fields (`id`, `creator`,
 * `created`, `modified`, visibility) are fed back in from the same wire
 * annotation, because a request never lets a caller set them; what is under
 * test here is that motivation, selectors and body survive the crossing.
 */
function roundTrip(wire: WebAnnotation): WebAnnotation {
  const mapped = webAnnotationToRecord(wire, {
    id: 'a1',
    creator: String(wire.creator),
    visibility: wire['margin:visibility'] ?? 'private',
    created: String(wire.created),
    modified: String(wire.modified),
  })
  if (!mapped.ok)
    throw new Error(`${mapped.error.code}: ${mapped.error.message}`)
  return recordToWebAnnotation(mapped.value)
}

describe('the W3C wire format', () => {
  it.each(MOTIVATIONS)(
    'round-trips %s from wire to internal model and back unchanged',
    (motivation) => {
      const wire = canonicalWire(motivation)
      expect(roundTrip(wire)).toEqual(wire)
    },
  )

  it('keeps a highlight colour only when the wire carried one', () => {
    const plain = canonicalWire('highlighting')
    expect(roundTrip(plain)).not.toHaveProperty('margin:color')

    const coloured = canonicalWire('highlighting', { 'margin:color': 'amber' })
    expect(roundTrip(coloured)['margin:color']).toBe('amber')
  })

  it('round-trips a reply, keeping margin:parentId', () => {
    const wire = canonicalWire('commenting', { 'margin:parentId': 'a0' })
    expect(roundTrip(wire)['margin:parentId']).toBe('a0')
  })

  it('carries an annotation from an unrelated tool without losing its meaning', () => {
    // Hypothesis-shaped: target as a one-element array, quote and position
    // selectors only, no structural selector, a TextualBody.
    const foreign = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: 'https://hypothes.is/a/8f21c9',
      type: 'Annotation',
      motivation: 'commenting',
      body: {
        type: 'TextualBody',
        value: 'quoted out of context',
        format: 'text/plain',
      },
      target: [
        {
          source: SOURCE,
          selector: [
            { type: 'TextPositionSelector', start: 5, end: 32 },
            {
              type: 'TextQuoteSelector',
              exact: 'meaning becomes coordinates',
              prefix: 'Once ',
              suffix: ', every new screen',
            },
          ],
        },
      ],
    }

    const parsed = webAnnotationSchema.safeParse(foreign)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    const mapped = webAnnotationToRecord(parsed.data, {
      id: 'a2',
      creator: CREATOR,
      visibility: 'public',
      created: CREATED,
      modified: CREATED,
    })
    expect(mapped.ok).toBe(true)
    if (!mapped.ok) return

    // No structural selector means the annotation is anchored to the document
    // as a whole, and it stays that way on the trip back out.
    expect(mapped.value.annotation.target.nodeId).toBe(DOCUMENT_SCOPE_NODE_ID)
    expect(mapped.value.structId).toBeNull()

    const back = recordToWebAnnotation(mapped.value)
    expect(back.motivation).toBe('commenting')
    expect(back.body).toEqual({
      type: 'TextualBody',
      value: 'quoted out of context',
      format: 'text/plain',
    })
    const target = Array.isArray(back.target) ? back.target[0] : back.target
    expect(target.source).toBe(SOURCE)
    expect(target.selector).toEqual(
      expect.arrayContaining([
        { type: 'TextPositionSelector', start: 5, end: 32 },
        {
          type: 'TextQuoteSelector',
          exact: 'meaning becomes coordinates',
          prefix: 'Once ',
          suffix: ', every new screen',
        },
      ]),
    )
    expect(
      (target.selector as { type: string }[]).some(
        (entry) => entry.type === STRUCT_SELECTOR_TYPE,
      ),
    ).toBe(false)
  })

  it('rejects an unknown motivation', () => {
    const result = webAnnotationSchema.safeParse({
      ...canonicalWire('commenting'),
      motivation: 'bookmarking',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown selector type', () => {
    const wire = canonicalWire('commenting')
    const result = webAnnotationSchema.safeParse({
      ...wire,
      target: {
        source: SOURCE,
        selector: [{ type: 'XPathSelector', value: '/html/body/p[1]' }],
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects offsets that do not span the quoted text', () => {
    const wire = canonicalWire('commenting')
    const target = wire.target as { source: string; selector: unknown[] }
    const mapped = webAnnotationToRecord(
      {
        ...wire,
        target: {
          source: SOURCE,
          selector: [
            target.selector[0],
            { type: 'TextPositionSelector', start: 5, end: 9 },
            target.selector[2],
          ] as never,
        },
      },
      {
        id: 'a3',
        creator: CREATOR,
        visibility: 'private',
        created: CREATED,
        modified: CREATED,
      },
    )
    expect(mapped.ok).toBe(false)
    if (!mapped.ok) expect(mapped.error.code).toBe('malformed_selector')
  })

  it('rejects a body on a highlight and a highlight with no anchor selectors', () => {
    const withBody = webAnnotationToRecord(
      canonicalWire('highlighting', { body: 'not allowed here' }),
      {
        id: 'a4',
        creator: CREATOR,
        visibility: 'private',
        created: CREATED,
        modified: CREATED,
      },
    )
    expect(withBody.ok).toBe(false)
    if (!withBody.ok) expect(withBody.error.code).toBe('unexpected_body')

    const withoutQuote = webAnnotationToRecord(
      {
        ...canonicalWire('highlighting'),
        target: {
          source: SOURCE,
          selector: [{ type: 'TextPositionSelector', start: 5, end: 32 }],
        },
      },
      {
        id: 'a5',
        creator: CREATOR,
        visibility: 'private',
        created: CREATED,
        modified: CREATED,
      },
    )
    expect(withoutQuote.ok).toBe(false)
    if (!withoutQuote.ok)
      expect(withoutQuote.error.code).toBe('missing_selector')
  })

  it('rejects an oversized body before anything is mapped', () => {
    const result = webAnnotationSchema.safeParse({
      ...canonicalWire('commenting'),
      body: { type: 'TextualBody', value: 'x'.repeat(8_001) },
    })
    expect(result.success).toBe(false)
  })
})

describe('target.source and the tenancy key', () => {
  it.each([
    'https://ernie.sg/challenges/chapter-1',
    'https://berlayar.ai/notes/one?v=2',
    'http://localhost:4321/a/b#c',
  ])('splits and rejoins %s exactly', (source) => {
    const split = splitSource(source)
    expect(split).not.toBeNull()
    if (!split) return
    expect(`${split.site}${split.document}`).toBe(source)
  })

  it('separates two sites at the origin', () => {
    expect(splitSource('https://ernie.sg/x')?.site).toBe('https://ernie.sg')
    expect(splitSource('https://berlayar.ai/x')?.site).toBe(
      'https://berlayar.ai',
    )
  })

  it('refuses a non-http source', () => {
    expect(splitSource('urn:isbn:9780000000000')).toBeNull()
    expect(splitSource('not a uri')).toBeNull()
  })
})

describe('canonical target delimiters and offset units', () => {
  it.each(['https://ernie.sg/document?', 'https://ernie.sg/document#'])(
    'round-trips %s without dropping its empty delimiter',
    (source) => {
      const wire = canonicalWire('commenting')
      const target = wire.target as { source: string; selector: never[] }
      expect(
        roundTrip({ ...wire, target: { ...target, source } }),
      ).toMatchObject({
        target: { source },
      })
    },
  )

  it('retains W3C code-point offsets in the shared anchor', () => {
    const wire = canonicalWire('commenting')
    const target = wire.target as { source: string; selector: unknown[] }
    const mapped = webAnnotationToRecord(
      {
        ...wire,
        target: {
          source: SOURCE,
          selector: [
            {
              type: 'TextQuoteSelector',
              exact: '🌊 x',
              prefix: '',
              suffix: '',
            },
            { type: 'TextPositionSelector', start: 0, end: 3 },
            target.selector[2],
          ] as never,
        },
      },
      {
        id: 'codepoint',
        creator: CREATOR,
        visibility: 'private',
        created: CREATED,
        modified: CREATED,
      },
    )
    expect(mapped).toMatchObject({
      ok: true,
      value: { annotation: { target: { positionUnit: 'codepoint' } } },
    })
  })
})

it('rejects a Unicode-host source whose canonical href exceeds the limit', () => {
  const host = `${'é'.repeat(57)}.test`
  const prefix = `https://${host}/`
  const canonicalPrefix = new URL(prefix).href
  const source = `${prefix}${'a'.repeat(MAX_SOURCE_LENGTH - canonicalPrefix.length)}?`
  expect(source.length).toBeLessThan(MAX_SOURCE_LENGTH)
  expect(new URL(source).href.length).toBe(MAX_SOURCE_LENGTH + 1)
  expect(splitSource(source)).toBeNull()
})
