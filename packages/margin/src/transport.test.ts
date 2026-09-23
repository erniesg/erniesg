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
      `${MARGIN_API_PREFIX}/annotations?document=https%3A%2F%2Fexample.test%2Fbooks%2Fa%2Fb`,
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
