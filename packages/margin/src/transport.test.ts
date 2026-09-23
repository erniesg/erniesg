import { describe, expect, it } from 'vitest'
import {
  createHttpTransport,
  createMarginClient,
  MARGIN_API_PREFIX,
  type MarginRequest,
  type MarginTransport,
} from './transport'

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
    await client.deleteAnnotation('an id/with slash')

    expect(transport.calls.map((call) => call.path)).toEqual([
      `${MARGIN_API_PREFIX}/health`,
      // `?source=`, which is the parameter 054's `readScope` reads. `?document=`
      // is half a scope and answers `missing_scope`.
      `${MARGIN_API_PREFIX}/annotations?source=https%3A%2F%2Fexample.test%2Fbooks%2Fa%2Fb`,
      `${MARGIN_API_PREFIX}/annotations/an%20id%2Fwith%20slash`,
    ])
    for (const call of transport.calls) {
      expect(call.path.startsWith(`${MARGIN_API_PREFIX}/`)).toBe(true)
    }
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
  const anchor = {
    nodeId: 'p-proposition-1',
    struct: { id: 'block-ch01-prose-2', digest: 'abc123' },
    position: { start: 5, end: 14 },
    quote: { exact: 'a sentence', prefix: 'Once ', suffix: ' ends.' },
  }

  it('sends motivation, a target source and typed selectors', async () => {
    const transport = stubTransport()
    const responses = await createMarginClient(transport).createAnnotations({
      documentUri: 'https://example.test/books/a/b',
      kind: 'note',
      targets: [{ ...anchor, quote: { ...anchor.quote } }],
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
      end: 14,
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
      context: hostContext,
    })
    expect((transport.calls[1].body as any)['@context']).toEqual(hostContext)
  })
})
