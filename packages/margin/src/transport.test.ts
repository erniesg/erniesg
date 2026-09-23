import { describe, expect, it } from 'vitest'
import {
  createHttpTransport,
  createMarginClient,
  MARGIN_API_PREFIX,
  type MarginRequest,
  type MarginTransport,
  webAnnotationTarget,
  toWebAnnotation,
} from './transport'
import { createSemanticTextAnchorFromRange, withStructSelector } from './anchor'

function stubTransport(): MarginTransport & { calls: MarginRequest[] } {
  const calls: MarginRequest[] = []
  return {
    calls,
    async request(request) {
      calls.push(request)
      return { status: 200, body: { ok: true } }
    },
  }
}

describe('the injectable transport', () => {
  it('drives the whole client from a stub, with no source change', async () => {
    const transport = stubTransport()
    const client = createMarginClient(transport)

    await client.health()
    await client.listAnnotations('https://example.test/books/a/b')
    await client.deleteAnnotation(
      'an id/with slash',
      'https://example.test/books/a/b',
    )

    expect(transport.calls.map((call) => call.path)).toEqual([
      `${MARGIN_API_PREFIX}/health`,
      // `?source=`, which is the parameter 054's `readScope` reads. `?document=`
      // is half a scope and answers `missing_scope`.
      `${MARGIN_API_PREFIX}/annotations?source=https%3A%2F%2Fexample.test%2Fbooks%2Fa%2Fb`,
      `${MARGIN_API_PREFIX}/annotations/an%20id%2Fwith%20slash?source=https%3A%2F%2Fexample.test%2Fbooks%2Fa%2Fb`,
    ])
    for (const call of transport.calls) {
      expect(call.path.startsWith(`${MARGIN_API_PREFIX}/`)).toBe(true)
    }
  })

  it('uses the service scope for pagination, owner edits, deletion, and future defaults', async () => {
    const transport = stubTransport()
    const client = createMarginClient(transport)
    const source = 'https://example.test/book'
    await client.listAnnotations(source, '2026-09-23T00:00:00Z one')
    await client.readPreferences()
    await client.setDefaultVisibility('public')
    await client.updateAnnotation('urn:margin:annotation:one', source, {
      visibility: 'private',
      body: 'edited',
    })
    await client.deleteAnnotation('urn:margin:annotation:one', source)
    expect(transport.calls).toMatchObject([
      {
        path: `${MARGIN_API_PREFIX}/annotations?source=https%3A%2F%2Fexample.test%2Fbook&cursor=2026-09-23T00%3A00%3A00Z%20one`,
      },
      { path: `${MARGIN_API_PREFIX}/prefs` },
      {
        path: `${MARGIN_API_PREFIX}/prefs`,
        method: 'PATCH',
        body: { defaultVisibility: 'public' },
      },
      {
        path: `${MARGIN_API_PREFIX}/annotations/urn%3Amargin%3Aannotation%3Aone?source=https%3A%2F%2Fexample.test%2Fbook`,
        method: 'PATCH',
        body: { body: 'edited', 'margin:visibility': 'private' },
      },
      {
        path: `${MARGIN_API_PREFIX}/annotations/urn%3Amargin%3Aannotation%3Aone?source=https%3A%2F%2Fexample.test%2Fbook`,
        method: 'DELETE',
      },
    ])
  })

  it('refuses to invent an origin', () => {
    expect(() => createHttpTransport({ baseUrl: '' })).toThrow(
      /explicit baseUrl/,
    )
  })

  it('points at whatever host it is given', async () => {
    const seen: string[] = []
    const transport = createHttpTransport({
      baseUrl: 'https://margin.another-site.test/',
      fetch: async (input) => {
        seen.push(String(input))
        return new Response('{"status":"ok"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    const response = await createMarginClient(transport).health()

    expect(seen).toEqual([
      `https://margin.another-site.test${MARGIN_API_PREFIX}/health`,
    ])
    expect(response).toEqual({ status: 200, body: { status: 'ok' } })
  })

  it('rejects a relative request path rather than resolving it somewhere', async () => {
    const transport = createHttpTransport({
      baseUrl: 'https://margin.another-site.test',
      fetch: async () => new Response('{}'),
    })

    await expect(transport.request({ path: 'annotations' })).rejects.toThrow(
      /must be absolute/,
    )
  })
})

describe('the wire format is a Web Annotation', () => {
  // Spec 054 fixes what the service exchanges, and it is the reason to have
  // chosen the standard: an annotation this client writes should be readable by
  // something that never heard of `margin`. Sending this package's own
  // `{documentUri, kind, targets}` shape would be a private protocol wearing a
  // standard's name, and 054's routes would refuse it.
  const anchorText = 'Once a sentence ends.'
  const anchor = withStructSelector(
    createSemanticTextAnchorFromRange('p-proposition-1', anchorText, 5, 15),
    { id: 'block-ch01-prose-2', digest: 'abc123' },
  )

  it('converts UTF-16 positions using the full node text before a duplicate quote', () => {
    const text = '🌊 x x'
    const target = webAnnotationTarget(
      'https://example.test/x',
      createSemanticTextAnchorFromRange('n', text, 5, 6),
      text,
    )
    expect((target.selector as any[])[1]).toEqual({
      type: 'TextPositionSelector',
      start: 4,
      end: 5,
    })
    expect(() =>
      webAnnotationTarget(
        'https://example.test/x',
        createSemanticTextAnchorFromRange('n', text, 5, 6),
      ),
    ).toThrow(/full.*text/i)
  })

  it('counts a selected non-BMP character as one wire character', () => {
    const text = '🌊 x x'
    const target = webAnnotationTarget(
      'https://example.test/x',
      createSemanticTextAnchorFromRange('n', text, 0, 2),
      text,
    )
    expect((target.selector as any[])[1]).toEqual({
      type: 'TextPositionSelector',
      start: 0,
      end: 1,
    })
  })

  it('refuses wrong full text and a range splitting a surrogate pair', () => {
    const text = '🌊 x x'
    const second = createSemanticTextAnchorFromRange('n', text, 5, 6)
    expect(() =>
      webAnnotationTarget('https://example.test/x', second, '🦀 x x'),
    ).toThrow(/context/)
    expect(() =>
      webAnnotationTarget(
        'https://example.test/x',
        createSemanticTextAnchorFromRange('n', text, 0, 1),
        text,
      ),
    ).toThrow(/Unicode character/)
  })

  it('passes through explicit wire codepoint positions without source text', () => {
    const target = webAnnotationTarget('https://example.test/x', {
      nodeId: 'n',
      positionUnit: 'codepoint',
      position: { start: 4, end: 5 },
      quote: { exact: 'x', prefix: '🌊 x ', suffix: '' },
    })
    expect((target.selector as any[])[1]).toEqual({
      type: 'TextPositionSelector',
      start: 4,
      end: 5,
    })
  })

  it('checks every target before posting any of a multi-block selection', async () => {
    const transport = stubTransport()
    const first = createSemanticTextAnchorFromRange('one', 'first', 0, 5)
    const second = createSemanticTextAnchorFromRange('two', '🌊 x x', 5, 6)
    await expect(
      createMarginClient(transport).createAnnotations({
        documentUri: 'https://example.test/x',
        kind: 'highlight',
        targets: [first, second],
        targetTexts: ['first'],
      }),
    ).rejects.toThrow(/full.*text/i)
    expect(transport.calls).toEqual([])
  })

  it('serializes proposals with an editing motivation and body', () => {
    const wire = toWebAnnotation({
      documentUri: 'https://example.test/x',
      kind: 'proposal',
      body: 'replacement',
      target: anchor,
      targetText: anchorText,
    })
    expect(wire).toMatchObject({
      motivation: 'editing',
      body: { value: 'replacement' },
    })
  })

  it('requires a non-empty note body before any request is sent', async () => {
    const transport = stubTransport()
    const client = createMarginClient(transport)
    const common = {
      documentUri: 'https://example.test/x',
      targets: [anchor],
      targetTexts: [anchorText],
    }
    await expect(
      // @ts-expect-error A note request cannot omit its body.
      client.createAnnotations({ ...common, kind: 'note' }),
    ).rejects.toThrow(/note body/)
    await expect(
      client.createAnnotations({ ...common, kind: 'note', body: '   ' }),
    ).rejects.toThrow(/note body/)
    expect(transport.calls).toEqual([])
  })

  it('sends motivation, a target source and typed selectors', async () => {
    const transport = stubTransport()
    const responses = await createMarginClient(transport).createAnnotations({
      documentUri: 'https://example.test/books/a/b',
      kind: 'note',
      targets: [{ ...anchor, quote: { ...anchor.quote } }],
      targetTexts: [anchorText],
      body: 'a remark',
      visibility: 'public',
    })

    expect(responses).toHaveLength(1)
    const sent = transport.calls[0].body as Record<string, any>
    expect(transport.calls[0].method).toBe('POST')
    expect(sent.type).toBe('Annotation')
    expect(sent.motivation).toBe('commenting')
    expect(sent.body).toEqual({
      type: 'TextualBody',
      value: 'a remark',
      format: 'text/plain',
    })
    expect(sent.target.source).toBe('https://example.test/books/a/b')
    expect(sent.target.selector.map((one: any) => one.type)).toEqual([
      'TextQuoteSelector',
      'TextPositionSelector',
      'margin:StructSelector',
    ])
    expect(sent.target.selector[0]).toEqual({
      type: 'TextQuoteSelector',
      exact: 'a sentence',
      prefix: 'Once ',
      suffix: ' ends.',
    })
    expect(sent.target.selector[1]).toEqual({
      type: 'TextPositionSelector',
      start: 5,
      end: 15,
    })
    expect(sent.target.selector[2]).toEqual({
      type: 'margin:StructSelector',
      'margin:nodeId': 'p-proposition-1',
      'margin:structId': 'block-ch01-prose-2',
    })
    expect(sent['margin:visibility']).toBe('public')
    // Not this package's own shape, anywhere in the body.
    expect(sent.documentUri).toBeUndefined()
    expect(sent.targets).toBeUndefined()
    expect(sent.kind).toBeUndefined()
  })

  it('sends a highlight with a colour and no body', async () => {
    const transport = stubTransport()
    await createMarginClient(transport).createAnnotations({
      documentUri: 'https://example.test/books/a/b',
      kind: 'highlight',
      targets: [anchor],
      targetTexts: [anchorText],
      color: 'amber',
    })

    const sent = transport.calls[0].body as Record<string, any>
    expect(sent.motivation).toBe('highlighting')
    expect(sent.body).toBeUndefined()
    expect(sent['margin:color']).toBe('amber')
  })

  // One target per annotation, because that is the service's unit: a selection
  // spanning three blocks is three annotations, and the caller gets a status for
  // each rather than one for all of them.
  it('posts one annotation per target, in order', async () => {
    const transport = stubTransport()
    const responses = await createMarginClient(transport).createAnnotations({
      documentUri: 'https://example.test/books/a/b',
      kind: 'highlight',
      targets: [
        anchor,
        { ...anchor, nodeId: 'p-proposition-2', struct: { id: 'block-b' } },
      ],
      targetTexts: [anchorText, anchorText],
    })

    expect(responses).toHaveLength(2)
    expect(transport.calls).toHaveLength(2)
    expect(
      transport.calls.map(
        (call) => (call.body as any).target.selector[2]['margin:nodeId'],
      ),
    ).toEqual(['p-proposition-1', 'p-proposition-2'])
  })

  // The package must not name a site, so the default context is the W3C one and
  // a host supplies its own when its `margin:` prefix should resolve.
  it('defaults to the W3C context, and takes the host one when given', async () => {
    const transport = stubTransport()
    const client = createMarginClient(transport)

    await client.createAnnotations({
      documentUri: 'https://example.test/x',
      kind: 'highlight',
      targets: [anchor],
      targetTexts: [anchorText],
    })
    expect((transport.calls[0].body as any)['@context']).toBe(
      'http://www.w3.org/ns/anno.jsonld',
    )

    const hostContext = [
      'http://www.w3.org/ns/anno.jsonld',
      { margin: 'https://margin.example.test/ns#' },
    ]
    await client.createAnnotations({
      documentUri: 'https://example.test/x',
      kind: 'highlight',
      targets: [anchor],
      targetTexts: [anchorText],
      context: hostContext,
    })
    expect((transport.calls[1].body as any)['@context']).toEqual(hostContext)
  })
})
