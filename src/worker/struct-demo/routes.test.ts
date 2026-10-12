import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1Database } from '../margin/sqlite-database'
import { handleStructDemoRequest, MAX_BYTES, type StructDemoEnv } from './index'

const SITE = 'https://ernie.sg'
const PRIVATE_ID = 'a'.repeat(32)
const PDF = '%PDF-1.7\nexample'
let db: SqliteD1Database
let env: StructDemoEnv
let now: Date
let backend: ReturnType<
  typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>
>
function req(
  path: string,
  method = 'GET',
  ip = '192.0.2.1',
  body?: BodyInit,
  extra: Record<string, string> = {},
) {
  return new Request(SITE + '/api/struct-demo/' + path, {
    method,
    body,
    headers: {
      'CF-Connecting-IP': ip,
      Origin: SITE,
      'Content-Type': 'application/pdf',
      ...extra,
    },
  })
}
function run(request: Request) {
  return handleStructDemoRequest(request, env, {
    fetch: backend,
    now: () => now,
  }) as Promise<Response>
}
async function submit(ip = '192.0.2.1') {
  const response = await run(req('jobs', 'POST', ip, PDF))
  return { response, data: (await response.json()) as any }
}
beforeEach(() => {
  db = SqliteD1Database.inMemory()
  env = {
    MARGIN_DB: db,
    MARGIN_ENVIRONMENT: 'staging',
    STRUCT_DEMO_ORIGIN: 'https://converter.example',
    STRUCT_DEMO_TOKEN: 'private-secret',
  }
  now = new Date('2026-10-12T23:59:00Z')
  let sequence = 0
  backend = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST')
      return Response.json(
        {
          id:
            sequence++ === 0
              ? PRIVATE_ID
              : sequence.toString(16).padStart(32, '0'),
        },
        { status: 202 },
      )
    if (init?.method === 'DELETE') return Response.json({ deleted: PRIVATE_ID })
    if (_url.endsWith('.epub'))
      return new Response('epub bytes', {
        headers: {
          'Content-Type': 'application/epub+zip',
          'X-Secret': 'private-secret',
        },
      })
    return Response.json({
      id: PRIVATE_ID,
      status: 'done',
      files: [
        { name: 'document-paperpro.epub' },
        { name: '../secret.epub' },
        { name: 'run.log' },
      ],
      message: 'private-secret raw error',
      summary: { pageCount: 4, textCoverage: 0.95, secret: 'private-secret' },
    })
  })
})
describe('public Struct gateway', () => {
  it('submits fixed profiles with a sanitized filename and returns only a public UUID', async () => {
    const response = await run(
      req('jobs', 'POST', undefined, PDF, {
        'X-Filename': '../../private document.pdf',
      }),
    )
    expect(response.status).toBe(202)
    const data = (await response.json()) as any
    expect(data).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'queued',
    })
    expect(JSON.stringify(data)).not.toContain(PRIVATE_ID)
    const [url, init] = backend.mock.calls[0]
    expect(url).toBe('https://converter.example/api/jobs')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer private-secret',
    )
    const form = init?.body as FormData
    expect(form.get('profiles')).toBe('paperPro,paperProMove')
    expect((form.get('file') as File).name).toBe('private-document.pdf')
  })
  it('enforces per-network quota atomically during concurrent submissions', async () => {
    await submit()
    const results = await Promise.all(
      Array.from({ length: 12 }, () => submit()),
    )
    expect(results.filter((r) => r.response.status === 202)).toHaveLength(2)
    expect(results.filter((r) => r.response.status === 429)).toHaveLength(10)
    expect(backend).toHaveBeenCalledTimes(3)
    expect(db.query('SELECT * FROM struct_demo_jobs')).toHaveLength(3)
  })
  it('decodes the filename once before sanitizing, with a safe malformed fallback', async () => {
    expect(
      (
        await run(
          req('jobs', 'POST', undefined, PDF, {
            'X-Filename': encodeURIComponent('../../private document.pdf'),
          }),
        )
      ).status,
    ).toBe(202)
    expect(
      ((backend.mock.calls[0][1]?.body as FormData).get('file') as File).name,
    ).toBe('private-document.pdf')
    expect(
      (
        await run(
          req('jobs', 'POST', undefined, PDF, { 'X-Filename': 'bad%zz.pdf' }),
        )
      ).status,
    ).toBe(202)
    expect(
      ((backend.mock.calls[1][1]?.body as FormData).get('file') as File).name,
    ).toBe('document.pdf')
  })
  it('enforces the global quota across networks concurrently', async () => {
    for (let i = 0; i < 18; i++)
      expect((await submit(`198.51.100.${i + 1}`)).response.status).toBe(202)
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => submit(`192.0.2.${i + 1}`)),
    )
    expect(results.filter((r) => r.response.status === 202)).toHaveLength(2)
    expect(backend).toHaveBeenCalledTimes(20)
  })
  it('resets at UTC midnight while retaining stable download ownership', async () => {
    const { data } = await submit()
    await submit()
    await submit()
    expect(
      ((await run(req('limits')).then((r) => r.json())) as any).remaining,
    ).toBe(0)
    now = new Date('2026-10-13T00:00:00Z')
    expect(
      ((await run(req('limits')).then((r) => r.json())) as any).remaining,
    ).toBe(3)
    expect((await run(req(`jobs/${data.id}`))).status).toBe(200)
  })
  it('ignores forwarded headers and does not persist the raw IP', async () => {
    for (let i = 0; i < 3; i++)
      expect(
        (
          await run(
            req('jobs', 'POST', undefined, PDF, {
              'X-Forwarded-For': `192.0.2.${i + 10}`,
            }),
          )
        ).status,
      ).toBe(202)
    expect((await submit()).response.status).toBe(429)
    expect(
      JSON.stringify(db.query('SELECT * FROM struct_demo_jobs')),
    ).not.toContain('192.0.2.1')
    const request = req('limits')
    request.headers.delete('CF-Connecting-IP')
    request.headers.set('X-Forwarded-For', '192.0.2.2')
    expect((await run(request)).status).toBe(503)
  })
  it('rejects wrong-owner status, downloads and delete without backend calls', async () => {
    const { data } = await submit()
    backend.mockClear()
    for (const [suffix, method] of [
      ['', 'GET'],
      ['/files/document-paperpro.epub', 'GET'],
      ['', 'DELETE'],
    ]) {
      expect(
        (await run(req(`jobs/${data.id}${suffix}`, method, '192.0.2.2')))
          .status,
      ).toBe(404)
    }
    expect(backend).not.toHaveBeenCalled()
  })
  it('sanitizes state, allows only listed EPUBs, and strips private download headers', async () => {
    const { data } = await submit()
    const state = await run(req(`jobs/${data.id}`)).then((r) => r.json())
    expect(state).toEqual({
      id: data.id,
      status: 'done',
      files: [{ name: 'document-paperpro.epub' }],
      summary: { pageCount: 4, textCoverage: 0.95 },
    })
    expect((await run(req(`jobs/${data.id}/files/run.log`))).status).toBe(404)
    expect((await run(req(`jobs/${data.id}/files/unlisted.epub`))).status).toBe(
      404,
    )
    const download = await run(
      req(`jobs/${data.id}/files/document-paperpro.epub`),
    )
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('epub bytes')
    expect(download.headers.get('X-Secret')).toBeNull()
    expect(download.headers.get('Cache-Control')).toContain('no-store')
    expect((await run(req(`jobs/${data.id}`, 'DELETE'))).status).toBe(200)
    expect((await run(req(`jobs/${data.id}`))).status).toBe(404)
    expect(
      ((await run(req('limits')).then((r) => r.json())) as any).remaining,
    ).toBe(2)
  })
  it('rejects uploads before upstream and counts attempts after cheap header checks', async () => {
    expect((await run(req('jobs', 'POST', undefined, 'not PDF'))).status).toBe(
      400,
    )
    expect(
      (
        await run(
          req('jobs', 'POST', undefined, PDF, { 'Content-Type': 'text/plain' }),
        )
      ).status,
    ).toBe(415)
    expect(
      (
        await run(
          req('jobs', 'POST', undefined, PDF, {
            'Content-Length': String(MAX_BYTES + 1),
          }),
        )
      ).status,
    ).toBe(413)
    expect(
      (
        await run(
          req('jobs', 'POST', undefined, '%PDF-' + 'x'.repeat(MAX_BYTES)),
        )
      ).status,
    ).toBe(413)
    expect(backend).not.toHaveBeenCalled()
    expect(db.query('SELECT * FROM struct_demo_jobs')).toHaveLength(2)
  })
  it('requires same-origin writes, blocks cross-site reads and exposes no CORS', async () => {
    expect(
      (
        await run(
          req('jobs', 'POST', undefined, PDF, {
            Origin: 'https://evil.example',
          }),
        )
      ).status,
    ).toBe(403)
    const request = req('jobs', 'POST', undefined, PDF)
    request.headers.delete('Origin')
    expect((await run(request)).status).toBe(403)
    expect(
      (
        await run(
          req('limits', 'GET', undefined, undefined, {
            'Sec-Fetch-Site': 'cross-site',
          }),
        )
      ).status,
    ).toBe(403)
    expect(
      (await run(req('limits'))).headers.get('Access-Control-Allow-Origin'),
    ).toBeNull()
  })
  it('fails closed for missing bindings, invalid config and missing schema', async () => {
    for (const origin of [
      'http://converter.example',
      'https://user:pass@converter.example',
      'https://converter.example?token=x',
      'https://converter.example#x',
      'https://converter.example/private',
    ]) {
      env.STRUCT_DEMO_ORIGIN = origin
      expect((await run(req('limits'))).status).toBe(503)
    }
    env.STRUCT_DEMO_ORIGIN = 'https://converter.example'
    env.STRUCT_DEMO_TOKEN = ''
    expect((await run(req('limits'))).status).toBe(503)
    env.STRUCT_DEMO_TOKEN = 'private-secret'
    db.execute('DROP TABLE struct_demo_jobs')
    expect((await run(req('limits'))).status).toBe(503)
  })
  it('reserves attempts on provider failures and never leaks provider errors', async () => {
    backend.mockImplementation(
      async () =>
        new Response('private-secret /private/path ' + PRIVATE_ID, {
          status: 500,
        }),
    )
    const { response, data } = await submit()
    expect(response.status).toBe(503)
    expect(JSON.stringify(data)).not.toMatch(
      /private-secret|private\/path|aaaaaaaa/,
    )
    backend.mockImplementation(async () => {
      throw new Error('private-secret')
    })
    expect((await submit()).response.status).toBe(503)
    expect(
      ((await run(req('limits')).then((r) => r.json())) as any).remaining,
    ).toBe(1)
  })
  it('maps provider validation and queue errors to generic public responses', async () => {
    for (const status of [400, 413, 429]) {
      backend.mockImplementation(
        async () => new Response('private-secret', { status }),
      )
      expect((await submit()).response.status).toBe(status)
    }
  })
  it('rejects malformed upstream job IDs and states', async () => {
    backend.mockImplementationOnce(async () =>
      Response.json({ id: '../../secret' }, { status: 202 }),
    )
    expect((await submit()).response.status).toBe(503)
    const { data } = await submit()
    backend.mockImplementationOnce(async () =>
      Response.json({ status: 'private-secret' }),
    )
    expect((await run(req(`jobs/${data.id}`))).status).toBe(503)
  })
  it('expires public job access and removes old quota records after 72 hours', async () => {
    const { data } = await submit()
    now = new Date('2026-10-16T00:00:00Z')
    expect((await run(req(`jobs/${data.id}`))).status).toBe(404)
    expect(db.query('SELECT * FROM struct_demo_jobs')).toHaveLength(0)
  })
  it('handles fragmented PDF headers and accepts the exact byte boundary', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const char of PDF)
          controller.enqueue(new TextEncoder().encode(char))
        controller.close()
      },
    })
    const request = new Request(SITE + '/api/struct-demo/jobs', {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: {
        'CF-Connecting-IP': '192.0.2.1',
        Origin: SITE,
        'Content-Type': 'application/pdf',
      },
    } as RequestInit)
    expect((await run(request)).status).toBe(202)
    expect(
      (
        await run(
          req('jobs', 'POST', undefined, '%PDF-' + 'x'.repeat(MAX_BYTES - 5)),
        )
      ).status,
    ).toBe(202)
    expect(
      (backend.mock.calls[1][1]?.body as FormData).get('file'),
    ).toHaveProperty('size', MAX_BYTES)
  })
  it('cancels oversized streamed uploads before buffering the excess', async () => {
    const cancelled = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('%PDF-'))
        controller.enqueue(new Uint8Array(MAX_BYTES))
      },
      cancel: cancelled,
    })
    const request = new Request(SITE + '/api/struct-demo/jobs', {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: {
        'CF-Connecting-IP': '192.0.2.1',
        Origin: SITE,
        'Content-Type': 'application/pdf',
      },
    } as RequestInit)
    expect((await run(request)).status).toBe(413)
    expect(cancelled).toHaveBeenCalled()
    expect(backend).not.toHaveBeenCalled()
  })
  it('times out a stalled upload without invoking the backend', async () => {
    vi.useFakeTimers()
    try {
      const cancelled = vi.fn()
      const stream = new ReadableStream<Uint8Array>({ cancel: cancelled })
      const request = new Request(SITE + '/api/struct-demo/jobs', {
        method: 'POST',
        body: stream,
        duplex: 'half',
        headers: {
          'CF-Connecting-IP': '192.0.2.1',
          Origin: SITE,
          'Content-Type': 'application/pdf',
        },
      } as RequestInit)
      const pending = run(request)
      // The ownership digest executes outside fake timers.
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
      await vi.advanceTimersByTimeAsync(30_000)
      expect((await pending).status).toBe(408)
      expect(cancelled).toHaveBeenCalled()
      expect(backend).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('only exposes files for completed conversions and gives generic failure copy', async () => {
    const { data } = await submit()
    for (const status of ['queued', 'running', 'failed']) {
      backend.mockImplementationOnce(async () =>
        Response.json({
          status,
          files: [{ name: 'document-paperpro.epub' }],
          message: 'private-secret',
          summary: { pageCount: 1 },
        }),
      )
      const result = (await run(req(`jobs/${data.id}`)).then((r) =>
        r.json(),
      )) as any
      expect(result.files).toEqual([])
      expect(result.summary).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain('private-secret')
      if (status === 'failed')
        expect(result.message).toBe(
          'This PDF could not be converted. Try another PDF.',
        )
    }
    backend.mockImplementationOnce(
      async () => new Response('private-secret', { status: 409 }),
    )
    expect((await run(req(`jobs/${data.id}`, 'DELETE'))).status).toBe(409)
    expect((await run(req(`jobs/${data.id}`))).status).toBe(200)
  })
  it('blocks encoded traversal, log/report routes and arbitrary upstream payloads', async () => {
    const { data } = await submit()
    for (const suffix of [
      '/log',
      '/report',
      '/files/%2Fsecret.epub',
      '/files/%2e%2e%2Fsecret.epub',
    ]) {
      expect((await run(req(`jobs/${data.id}${suffix}`))).status).toBe(404)
    }
    backend.mockImplementationOnce(
      async () => new Response('not-json private-secret'),
    )
    expect((await run(req(`jobs/${data.id}`))).status).toBe(503)
    backend.mockImplementationOnce(
      async () => new Response('x'.repeat(256 * 1024 + 1)),
    )
    expect((await run(req(`jobs/${data.id}`))).status).toBe(503)
    backend.mockImplementationOnce(
      async () => new Response('private-secret', { status: 404 }),
    )
    expect((await run(req(`jobs/${data.id}`))).status).toBe(404)
  })
  it('refuses non-EPUB download responses and uses a bounded upstream deadline', async () => {
    const { data } = await submit()
    backend.mockImplementationOnce(async () =>
      Response.json({
        status: 'done',
        files: [{ name: 'document-paperpro.epub' }],
      }),
    )
    backend.mockImplementationOnce(
      async () =>
        new Response('private-secret', {
          headers: { 'Content-Type': 'text/html' },
        }),
    )
    expect(
      (await run(req(`jobs/${data.id}/files/document-paperpro.epub`))).status,
    ).toBe(503)
    expect(
      backend.mock.calls.every(
        ([, init]) =>
          init?.redirect === 'error' && init.signal instanceof AbortSignal,
      ),
    ).toBe(true)
  })
  it('fails closed on missing database and environment, and ignores unrelated routes', async () => {
    env.MARGIN_DB = undefined
    expect((await run(req('limits'))).status).toBe(503)
    env.MARGIN_DB = db
    env.MARGIN_ENVIRONMENT = undefined
    expect((await run(req('limits'))).status).toBe(503)
    expect(
      await handleStructDemoRequest(new Request(SITE + '/api/unrelated'), env),
    ).toBeNull()
  })
  it('shares quota across IPv6 /64 networks while keeping full-IP ownership private', async () => {
    const addresses = [
      '2001:db8:abcd:12::1',
      '2001:0DB8:ABCD:0012:0:0:0:2',
      '2001:db8:abcd:12::3',
      '2001:db8:abcd:12::4',
    ]
    const results = []
    for (const ip of addresses) results.push(await submit(ip))
    expect(results.filter((r) => r.response.status === 202)).toHaveLength(3)
    expect(results.filter((r) => r.response.status === 429)).toHaveLength(1)
    expect(
      (await run(req(`jobs/${results[0].data.id}`, 'GET', addresses[1])))
        .status,
    ).toBe(404)
    expect(
      (
        await run(
          req(
            `jobs/${results[0].data.id}`,
            'GET',
            '2001:0DB8:ABCD:0012:0:0:0:1',
          ),
        )
      ).status,
    ).toBe(200)
    expect((await submit('2001:db8:abcd:13::1')).response.status).toBe(202)
  })
  it('normalizes mapped IPv4 and rejects malformed provider IPs', async () => {
    expect((await submit('192.0.2.1')).response.status).toBe(202)
    expect((await submit('::ffff:192.0.2.1')).response.status).toBe(202)
    expect((await submit('0:0:0:0:0:ffff:c000:201')).response.status).toBe(202)
    expect((await submit('::FFFF:c000:0201')).response.status).toBe(429)
    for (const ip of [
      '999.0.2.1',
      '192.0.2',
      '2001:::1',
      'deadbeef',
      '1:2:3:4:5:6:7:8:9',
    ])
      expect((await submit(ip)).response.status).toBe(503)
  })
  it('reserves quota before reading stalled request streams and cancels excess bodies', async () => {
    const cancelled = vi.fn()
    for (let i = 0; i < 3; i++) {
      expect(
        (await run(req('jobs', 'POST', undefined, 'invalid'))).status,
      ).toBe(400)
    }
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          throw new Error('must not pull')
        },
        cancel: cancelled,
      },
      { highWaterMark: 0 },
    )
    const request = new Request(SITE + '/api/struct-demo/jobs', {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: {
        Origin: SITE,
        'CF-Connecting-IP': '192.0.2.1',
        'Content-Type': 'application/pdf',
      },
    } as RequestInit)
    expect((await run(request)).status).toBe(429)
    expect(cancelled).toHaveBeenCalled()
    expect(backend).not.toHaveBeenCalled()
  })
  it('submits only the pinned sample without credentials and shares upload quota', async () => {
    backend.mockImplementationOnce(
      async () =>
        new Response(PDF, { headers: { 'Content-Type': 'application/pdf' } }),
    )
    const sample = await run(req('samples/attention-is-all-you-need', 'POST'))
    expect(sample.status).toBe(202)
    const [url, init] = backend.mock.calls[0]
    expect(url).toBe('https://arxiv.org/pdf/1706.03762v7')
    expect(new Headers(init?.headers).get('Authorization')).toBeNull()
    expect(init?.credentials).toBe('omit')
    expect(init?.redirect).toBe('error')
    await submit()
    await submit()
    expect(
      (await run(req('samples/attention-is-all-you-need', 'POST'))).status,
    ).toBe(429)
    expect(backend).toHaveBeenCalledTimes(4)
    expect((await run(req('samples/unknown', 'POST'))).status).toBe(404)
    expect((await run(req('samples/attention-is-all-you-need'))).status).toBe(
      405,
    )
  })
  it('counts failed, redirected, invalid and oversized sample downloads as attempts', async () => {
    for (const fail of [
      async () => {
        throw new Error('private-secret')
      },
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://evil.example' },
        }),
      async () => new Response('not-pdf'),
    ]) {
      backend.mockImplementationOnce(fail)
      expect(
        (await run(req('samples/attention-is-all-you-need', 'POST'))).status,
      ).toBe(503)
    }
    expect((await submit()).response.status).toBe(429)
    backend.mockImplementationOnce(
      async () =>
        new Response(PDF, {
          headers: { 'Content-Length': String(MAX_BYTES + 1) },
        }),
    )
    expect(
      (await run(req('samples/attention-is-all-you-need', 'POST', '192.0.2.2')))
        .status,
    ).toBe(503)
  })
  it('bounds download headers and streamed bytes with cancellation', async () => {
    const { data } = await submit()
    for (const length of [String(32 * 1024 * 1024 + 1), 'invalid', '-1']) {
      backend.mockImplementationOnce(async () =>
        Response.json({
          status: 'done',
          files: [{ name: 'document-paperpro.epub' }],
        }),
      )
      const cancel = vi.fn()
      backend.mockImplementationOnce(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: {
              'Content-Type': 'application/epub+zip',
              'Content-Length': length,
            },
          }),
      )
      expect(
        (await run(req(`jobs/${data.id}/files/document-paperpro.epub`))).status,
      ).toBe(503)
      expect(cancel).toHaveBeenCalled()
    }
    backend.mockImplementationOnce(async () =>
      Response.json({
        status: 'done',
        files: [{ name: 'document-paperpro.epub' }],
      }),
    )
    const cancel = vi.fn()
    backend.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(32 * 1024 * 1024))
              c.enqueue(new Uint8Array(1))
            },
            cancel,
          }),
          { headers: { 'Content-Type': 'application/epub+zip' } },
        ),
    )
    const response = await run(
      req(`jobs/${data.id}/files/document-paperpro.epub`),
    )
    await expect(response.arrayBuffer()).rejects.toThrow('Download unavailable')
    expect(cancel).toHaveBeenCalled()
  })
  it('accepts exactly 32 MiB output and refuses absent or deceptive download streams', async () => {
    const { data } = await submit()
    const state = () =>
      Response.json({
        status: 'done',
        files: [{ name: 'document-paperpro.epub' }],
      })
    backend.mockImplementationOnce(async () => state())
    backend.mockImplementationOnce(
      async () =>
        new Response(new Uint8Array(32 * 1024 * 1024), {
          headers: {
            'Content-Type': 'application/epub+zip',
            'Content-Length': String(32 * 1024 * 1024),
          },
        }),
    )
    const exact = await run(req(`jobs/${data.id}/files/document-paperpro.epub`))
    expect((await exact.arrayBuffer()).byteLength).toBe(32 * 1024 * 1024)
    backend.mockImplementationOnce(async () => state())
    backend.mockImplementationOnce(
      async () =>
        new Response(null, {
          headers: { 'Content-Type': 'application/epub+zip' },
        }),
    )
    expect(
      (await run(req(`jobs/${data.id}/files/document-paperpro.epub`))).status,
    ).toBe(503)
    for (const length of ['1', '100']) {
      backend.mockImplementationOnce(async () => state())
      backend.mockImplementationOnce(
        async () =>
          new Response('bytes', {
            headers: {
              'Content-Type': 'application/epub+zip',
              'Content-Length': length,
            },
          }),
      )
      const deceptive = await run(
        req(`jobs/${data.id}/files/document-paperpro.epub`),
      )
      await expect(deceptive.arrayBuffer()).rejects.toThrow(
        'Download unavailable',
      )
    }
  })
  it('times out and cancels hung EPUB streams without exposing upstream errors', async () => {
    const { data } = await submit()
    const cancel = vi.fn()
    backend.mockImplementationOnce(async () =>
      Response.json({
        status: 'done',
        files: [{ name: 'document-paperpro.epub' }],
      }),
    )
    backend.mockImplementationOnce(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'Content-Type': 'application/epub+zip' },
        }),
    )
    vi.useFakeTimers()
    try {
      const response = await run(
        req(`jobs/${data.id}/files/document-paperpro.epub`),
      )
      const body = response.arrayBuffer()
      const rejection = expect(body).rejects.toThrow('Download unavailable')
      await vi.advanceTimersByTimeAsync(30_000)
      await rejection
      expect(cancel).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('concurrently leases only two stalled uploads across twenty networks before readers start', async () => {
    vi.useFakeTimers()
    try {
      const pulls = vi.fn()
      const cancels = vi.fn()
      const requests = Array.from(
        { length: 20 },
        (_, i) =>
          new Request(SITE + '/api/struct-demo/jobs', {
            method: 'POST',
            duplex: 'half',
            body: new ReadableStream<Uint8Array>(
              { pull: pulls, cancel: cancels },
              { highWaterMark: 0 },
            ),
            headers: {
              Origin: SITE,
              'CF-Connecting-IP': `192.0.2.${i + 1}`,
              'Content-Type': 'application/pdf',
            },
          } as RequestInit),
      )
      const pending = requests.map(run)
      await vi.waitFor(() => expect(cancels).toHaveBeenCalledTimes(18))
      expect(pulls).toHaveBeenCalledTimes(2)
      expect(db.query('SELECT * FROM struct_demo_jobs')).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(30_000)
      const results = await Promise.all(pending)
      expect(results.filter((r) => r.status === 408)).toHaveLength(2)
      expect(results.filter((r) => r.status === 429)).toHaveLength(18)
      for (const response of results.filter((r) => r.status === 429))
        expect(((await response.json()) as any).error.code).toBe('busy')
      expect(cancels).toHaveBeenCalledTimes(20)
      expect(backend).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('rejects duplicate converter IDs without granting the second client access', async () => {
    const normal = backend.getMockImplementation()!
    backend.mockImplementation(async () =>
      Response.json({ id: PRIVATE_ID }, { status: 202 }),
    )
    const results = await Promise.all([
      submit('192.0.2.1'),
      submit('192.0.2.2'),
    ])
    expect(results.map((r) => r.response.status).sort()).toEqual([202, 503])
    const winner = results.find((r) => r.response.status === 202)!
    const loserIndex = results.findIndex((r) => r.response.status === 503)
    const loserIp = `192.0.2.${loserIndex + 1}`
    expect(JSON.stringify(results)).not.toContain(PRIVATE_ID)
    const losingRows = db.query(
      'SELECT public_id FROM struct_demo_jobs WHERE backend_id IS NULL',
    )
    backend.mockClear()
    for (const id of [winner.data.id, losingRows[0].public_id]) {
      for (const [suffix, method] of [
        ['', 'GET'],
        ['/files/document-paperpro.epub', 'GET'],
        ['', 'DELETE'],
      ])
        expect(
          (await run(req(`jobs/${id}${suffix}`, method, loserIp))).status,
        ).toBe(404)
    }
    expect(backend).not.toHaveBeenCalled()
    expect(
      db.query('SELECT * FROM struct_demo_jobs WHERE backend_id IS NOT NULL'),
    ).toHaveLength(1)
    backend.mockImplementation(normal)
    const winnerIp = `192.0.2.${results.findIndex((r) => r.response.status === 202) + 1}`
    const state = await run(req(`jobs/${winner.data.id}`, 'GET', winnerIp))
    expect(state.status).toBe(200)
    expect(await state.text()).not.toContain(PRIVATE_ID)
    const download = await run(
      req(
        `jobs/${winner.data.id}/files/document-paperpro.epub`,
        'GET',
        winnerIp,
      ),
    )
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('epub bytes')
    expect(
      (await run(req(`jobs/${winner.data.id}`, 'DELETE', winnerIp))).status,
    ).toBe(200)
  })
  it('recovers expired crash leases and releases leases after success and source failure', async () => {
    for (let i = 0; i < 2; i++)
      db.execute(
        'INSERT INTO struct_demo_jobs(public_id,owner_hash,network_hash,quota_day,created_at,expires_at,lease_expires_at) VALUES(?,?,?,?,?,?,?)',
        [
          crypto.randomUUID(),
          'other',
          'other',
          '2026-10-12',
          now.getTime(),
          now.getTime() + 86400000,
          now.getTime() + 120000,
        ],
      )
    expect((await submit()).data.error.code).toBe('busy')
    expect(db.query('SELECT * FROM struct_demo_jobs')).toHaveLength(2)
    now = new Date(now.getTime() + 120001)
    expect((await submit()).response.status).toBe(202)
    expect(
      db.query('SELECT * FROM struct_demo_jobs WHERE lease_expires_at > ?', [
        now.getTime(),
      ]),
    ).toHaveLength(0)
    backend.mockImplementationOnce(async () => {
      throw new Error('private-secret')
    })
    expect(
      (await run(req('samples/attention-is-all-you-need', 'POST'))).status,
    ).toBe(503)
    expect(
      db.query('SELECT * FROM struct_demo_jobs WHERE lease_expires_at > ?', [
        now.getTime(),
      ]),
    ).toHaveLength(0)
    expect((await submit()).response.status).toBe(202)
  })
})
