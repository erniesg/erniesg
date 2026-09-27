import { describe, expect, it } from 'vitest'
import { highlightRole } from './palette.js'
import { recordFromWebAnnotation } from './records.js'
import {
  createMarginClient,
  MARGIN_API_PREFIX,
  type MarginRequest,
} from './transport.js'

const ME = 'urn:margin:principal:dev:urn%3Amargin%3Adev:ada'
const SOURCE = 'https://example.test/books/a/ch1'

function wire(overrides: Record<string, unknown> = {}) {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    id: 'urn:margin:annotation:annotation-001',
    type: 'Annotation',
    motivation: 'highlighting',
    creator: ME,
    'margin:visibility': 'public',
    'margin:color': 'question',
    target: {
      source: SOURCE,
      selector: [
        {
          type: 'TextQuoteSelector',
          exact: 'café au lait',
          prefix: 'a ',
          suffix: ' please',
        },
        { type: 'TextPositionSelector', start: 2, end: 14 },
        {
          type: 'margin:StructSelector',
          'margin:nodeId': 'p-1',
          'margin:structId': 's-1',
        },
      ],
    },
    ...overrides,
  }
}

describe('recordFromWebAnnotation', () => {
  it('maps a highlight, keeping code-point positions and the struct id', () => {
    const record = recordFromWebAnnotation(wire(), ME)
    expect(record).toEqual({
      annotation: {
        id: 'annotation-001',
        kind: 'highlight',
        target: {
          nodeId: 'p-1',
          struct: { id: 's-1' },
          positionUnit: 'codepoint',
          position: { start: 2, end: 14 },
          quote: { exact: 'café au lait', prefix: 'a ', suffix: ' please' },
        },
        appearance: { color: 'question' },
        geometryCache: [],
      },
      visibility: 'public',
      mine: true,
      serverId: 'annotation-001',
    })
  })

  it('maps a note body and marks someone else’s annotation as not mine', () => {
    const record = recordFromWebAnnotation(
      wire({
        motivation: 'commenting',
        body: { type: 'TextualBody', value: 'hm', format: 'text/plain' },
        'margin:color': undefined,
        creator: 'urn:margin:principal:dev:urn%3Amargin%3Adev:bob',
        'margin:visibility': 'private',
      }),
      ME,
    )
    expect(record?.annotation).toMatchObject({ kind: 'note', body: 'hm' })
    expect(record?.mine).toBe(false)
    expect(record?.visibility).toBe('private')
  })

  it('treats a signed-out reader as owning nothing', () => {
    expect(recordFromWebAnnotation(wire(), null)?.mine).toBe(false)
  })

  it('anchors a selector-less annotation to the whole document', () => {
    const record = recordFromWebAnnotation(
      wire({
        target: {
          source: SOURCE,
          selector: [
            { type: 'TextQuoteSelector', exact: 'café au lait' },
            { type: 'TextPositionSelector', start: 2, end: 14 },
          ],
        },
      }),
      ME,
    )
    expect(record?.annotation.target.nodeId).toBe('@document')
    expect(record?.annotation.target.struct).toBeUndefined()
  })

  it('skips replies, which belong to the thread view, and anything malformed', () => {
    expect(
      recordFromWebAnnotation(
        wire({ 'margin:parentId': 'urn:margin:annotation:x' }),
        ME,
      ),
    ).toBeNull()
    expect(
      recordFromWebAnnotation(wire({ motivation: 'bookmarking' }), ME),
    ).toBeNull()
    expect(
      recordFromWebAnnotation(wire({ target: { source: SOURCE } }), ME),
    ).toBeNull()
    // Offsets that do not span the quote fail the anchor schema.
    expect(
      recordFromWebAnnotation(
        wire({
          target: {
            source: SOURCE,
            selector: [
              { type: 'TextQuoteSelector', exact: 'café' },
              { type: 'TextPositionSelector', start: 0, end: 9 },
            ],
          },
        }),
        ME,
      ),
    ).toBeNull()
    expect(recordFromWebAnnotation(null, ME)).toBeNull()
  })
})

describe('highlight roles', () => {
  it('reads a stored role as itself and a legacy hue as the role it stood for', () => {
    expect(highlightRole('revisit')).toBe('revisit')
    expect(highlightRole('amber')).toBe('key')
    expect(highlightRole('blue')).toBe('question')
    expect(highlightRole('#ff0000')).toBe('key')
    expect(highlightRole(null)).toBe('key')
  })
})

describe('the client’s owner-scoped calls', () => {
  it('scopes update and delete by source, and sends prefs as the service reads them', async () => {
    const calls: MarginRequest[] = []
    const client = createMarginClient({
      request: async (request) => {
        calls.push(request)
        return { status: 200, body: {} }
      },
    })
    await client.updateAnnotation('annotation-001', SOURCE, {
      visibility: 'public',
    })
    await client.updateAnnotation('annotation-001', SOURCE, { body: 'edited' })
    await client.deleteAnnotation('annotation-001', SOURCE)
    await client.listAnnotationsAfter(
      SOURCE,
      '2026-09-26T00:00:00.000Z annotation-001',
    )
    await client.readPrefs()
    await client.writePrefs('public')

    const scope = `?source=${encodeURIComponent(SOURCE)}`
    expect(calls).toEqual([
      {
        path: `${MARGIN_API_PREFIX}/annotations/annotation-001${scope}`,
        method: 'PATCH',
        body: { 'margin:visibility': 'public' },
      },
      {
        path: `${MARGIN_API_PREFIX}/annotations/annotation-001${scope}`,
        method: 'PATCH',
        body: { body: 'edited' },
      },
      {
        path: `${MARGIN_API_PREFIX}/annotations/annotation-001${scope}`,
        method: 'DELETE',
      },
      {
        path: `${MARGIN_API_PREFIX}/annotations${scope}&cursor=2026-09-26T00%3A00%3A00.000Z%20annotation-001`,
      },
      { path: `${MARGIN_API_PREFIX}/prefs` },
      {
        path: `${MARGIN_API_PREFIX}/prefs`,
        method: 'PATCH',
        body: { defaultVisibility: 'public' },
      },
    ])
  })

  it('refuses an empty patch rather than sending one the service would reject', () => {
    const client = createMarginClient({
      request: async () => ({ status: 200, body: {} }),
    })
    expect(() => client.updateAnnotation('a', SOURCE, {})).toThrow(
      /must change something/,
    )
  })
})
