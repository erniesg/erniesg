import { describe, expect, it, vi } from 'vitest'
import { formatHunks } from '../annotations/criticmarkup'
import {
  markupTokens,
  parseReviewPage,
  revisionLabel,
  ReviewQueue,
} from './margin-review'

const SITE = 'https://ernie.sg'
const body = formatHunks([
  {
    baseStartLine: 1,
    baseEndLine: 1,
    criticMarkup: 'A {--old--}{++new++} {~~left~>right~~}',
  },
])
const wire = (id = 'one', extra = {}) => ({
  id: `urn:margin:annotation:${id}`,
  type: 'Annotation',
  motivation: 'editing',
  body: { type: 'TextualBody', format: 'text/plain', value: body },
  target: { source: SITE + '/books/chapter/' },
  created: '2026-10-07T00:00:00.000Z',
  'margin:revision': 2,
  'margin:baseCommit': 'a'.repeat(40),
  'margin:visibility': 'private',
  ...extra,
})
const answer = (annotations: unknown[] = [], nextCursor?: string) =>
  Response.json({ annotations, ...(nextCursor ? { nextCursor } : {}) })
const queue = (fetcher: typeof fetch) =>
  new ReviewQueue(SITE, fetcher, () => {})

describe('admin review reader RED pilots', () => {
  it('distinguishes server auth, unavailable, malformed and authorized empty responses', async () => {
    for (const [status, expected] of [
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [503, 'unavailable'],
    ] as const) {
      const q = queue(async () => new Response('', { status }))
      await q.reset()
      expect(q.state.status).toBe(expected)
      expect(q.state.rows).toEqual([])
    }
    const empty = queue(async () => answer())
    await empty.reset()
    expect(empty.state.status).toBe('empty')
    const bad = queue(async () => Response.json({}))
    await bad.reset()
    expect(bad.state.status).toBe('malformed')
  })
  it('pages only the fixed API with same-origin credentials and resets filters/cursors', async () => {
    const calls: [string, RequestInit | undefined][] = []
    const q = queue(async (input, init) => {
      calls.push([String(input), init])
      return calls.length === 1
        ? answer([wire()], 'opaque cursor')
        : answer([wire('two')])
    })
    await q.reset({ state: 'pending', document: '/books/chapter/' })
    await q.more()
    expect(q.state.rows.map((r: any) => r.id)).toEqual([
      'urn:margin:annotation:one',
      'urn:margin:annotation:two',
    ])
    expect(new URL(calls[1][0], SITE).searchParams.get('cursor')).toBe(
      'opaque cursor',
    )
    for (const [url, init] of calls) {
      expect(url.startsWith('/api/margin/v1/proposals?')).toBe(true)
      expect(init).toMatchObject({
        method: 'GET',
        credentials: 'same-origin',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      })
    }
    await q.reset({ state: 'pending', document: '' })
    expect(new URL(calls[2][0], SITE).searchParams.has('cursor')).toBe(false)
    expect(new URL(calls[2][0], SITE).searchParams.has('document')).toBe(false)
    expect(q.state.rows).toHaveLength(1)
  })
  it('marks exact additions/deletions/substitutions without interpreting literal markup', () => {
    expect(markupTokens(body)).toEqual([
      {
        start: 1,
        end: 1,
        tokens: [
          { kind: 'equal', text: 'A ' },
          { kind: 'delete', text: 'old' },
          { kind: 'insert', text: 'new' },
          { kind: 'equal', text: ' ' },
          { kind: 'delete', text: 'left' },
          { kind: 'insert', text: 'right' },
        ],
      },
    ])
    const literal = formatHunks([
      {
        baseStartLine: 1,
        baseEndLine: 1,
        criticMarkup: '{++<img src=x onerror=alert(1)>++}',
      },
    ])
    expect(markupTokens(literal)).toEqual([
      {
        start: 1,
        end: 1,
        tokens: [{ kind: 'insert', text: '<img src=x onerror=alert(1)>' }],
      },
    ])
  })
  it('rejects malformed, nonproposal, foreign-source and inconsistent state data as a whole page', () => {
    for (const bad of [
      null,
      {},
      { annotations: [wire(), wire()] },
      { annotations: [wire('x', { motivation: 'commenting' })] },
      {
        annotations: [
          wire('x', { target: { source: 'https://other.test/private' } }),
        ],
      },
      { annotations: [wire('x', { 'margin:proposalState': 'approved' })] },
      {
        annotations: [
          wire('x', {
            body: { type: 'TextualBody', format: 'text/plain', value: '{}' },
          }),
        ],
      },
    ])
      expect(() => parseReviewPage(bad, SITE, 'pending')).toThrow()
    expect(
      parseReviewPage({ annotations: [wire()] }, SITE, 'pending').rows,
    ).toHaveLength(1)
  })
  it('labels current versus approved revisions and ignores an old response after reset', async () => {
    const row = parseReviewPage(
      {
        annotations: [
          wire('x', {
            'margin:proposalState': 'approved',
            'margin:approvedRevision': 1,
          }),
        ],
      },
      SITE,
      'approved',
    ).rows[0]
    expect(revisionLabel(row)).toContain('Current revision 2')
    expect(revisionLabel(row)).toContain('Approved revision 1')
    let finish!: (r: Response) => void
    const q = queue(
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve
            }),
        )
        .mockImplementationOnce(async () => answer()),
    )
    const stale = q.reset()
    await q.reset({ state: 'merged' })
    finish(answer([wire()]))
    await stale
    expect(q.state.status).toBe('empty')
    expect(q.state.rows).toEqual([])
  })
})

describe('review reader invariant sweep', () => {
  it('preserves legacy pending rows without inventing revision metadata', () => {
    const old = wire() as Record<string, unknown>
    delete old['margin:revision']
    delete old['margin:baseCommit']
    expect(
      revisionLabel(
        parseReviewPage({ annotations: [old] }, SITE, 'pending').rows[0],
      ),
    ).toContain('Current revision unavailable')
  })
  it('accepts all six actual states only with paired bounded revision metadata', () => {
    for (const state of [
      'approved',
      'pr_open',
      'conflict',
      'merged',
      'closed',
      'apply_failed',
    ] as const) {
      const row = wire('one', {
        'margin:proposalState': state,
        'margin:approvedRevision': 1,
      })
      expect(
        parseReviewPage({ annotations: [row] }, SITE, state).rows[0].state,
      ).toBe(state)
      for (const bad of [
        0,
        -1,
        1.1,
        '1',
        null,
        3,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        expect(() =>
          parseReviewPage(
            { annotations: [{ ...row, 'margin:approvedRevision': bad }] },
            SITE,
            state,
          ),
        ).toThrow()
      }
      expect(() =>
        parseReviewPage({ annotations: [row] }, SITE, 'pending'),
      ).toThrow()
    }
  })
  it('refuses oversized pages, bodies, cursor, malformed hunks and wrong document', () => {
    const invalid = [
      { annotations: Array.from({ length: 26 }, (_, i) => wire(String(i))) },
      { annotations: [], nextCursor: 'x' },
      { annotations: [wire()], nextCursor: '' },
      { annotations: [wire()], nextCursor: 'x'.repeat(16_385) },
      { annotations: [wire()], unexpected: true },
      {
        annotations: [
          wire('one', {
            body: {
              type: 'TextualBody',
              format: 'text/plain',
              value: 'x'.repeat(64_001),
            },
          }),
        ],
      },
      {
        annotations: [
          wire('one', {
            body: {
              type: 'TextualBody',
              format: 'text/plain',
              value: formatHunks([
                {
                  baseStartLine: 1,
                  baseEndLine: 1,
                  criticMarkup: '{++unclosed',
                },
              ]),
            },
          }),
        ],
      },
      {
        annotations: [
          wire('one', { 'margin:withdrawnAt': '2026-01-01T00:00:00Z' }),
        ],
      },
    ]
    for (const page of invalid)
      expect(() => parseReviewPage(page, SITE, 'pending')).toThrow()
    expect(() =>
      parseReviewPage({ annotations: [wire()] }, SITE, 'pending', '/other/'),
    ).toThrow()
  })
  it('rejects invalid filters before any fetch', async () => {
    const fetcher = vi.fn(async () => answer())
    const q = queue(fetcher)
    for (const document of [
      'https://other.test',
      '//other.test',
      '/a/../b',
      '/a\\b',
      '/a b',
      '/a\n',
      '/' + 'a'.repeat(8192),
    ]) {
      await q.reset({ document })
      expect(q.state.status).toBe('invalid-filter')
    }
    await q.reset({ state: 'other' as never })
    expect(q.state.status).toBe('invalid-filter')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('preserves the complete canonical document query and fragment in the filter', async () => {
    let requested = ''
    const doc = '/books/chapter/?edition=one#passage'
    const q = queue(async (input) => {
      requested = String(input)
      return answer([wire('x', { target: { source: SITE + doc } })])
    })
    await q.reset({ document: doc })
    expect(q.state.status).toBe('ready')
    expect(new URL(requested, SITE).searchParams.get('document')).toBe(doc)
  })
  it('stops repeated cursors and duplicate rows across pages without keeping stale private data', async () => {
    for (const second of [
      answer([wire('two')], 'cursor'),
      answer([wire()], 'new'),
    ]) {
      const q = queue(
        vi
          .fn()
          .mockResolvedValueOnce(answer([wire()], 'cursor'))
          .mockResolvedValueOnce(second),
      )
      await q.reset()
      await q.more()
      expect(q.state.status).toBe('malformed')
      expect(q.state.rows).toEqual([])
    }
  })
  it('limits pagination to ten pages and does not issue an eleventh request', async () => {
    let count = 0
    const q = queue(async () =>
      answer([wire(String(++count))], 'cursor-' + count),
    )
    await q.reset()
    for (let i = 0; i < 14; i++) await q.more()
    expect(count).toBe(10)
    expect(q.state.status).toBe('limited')
    expect(q.state.more).toBe(false)
    expect(q.state.rows).toHaveLength(10)
  })
  it('does not run overlapping more requests and clears private rows after authorization loss', async () => {
    let finish!: (r: Response) => void
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(answer([wire()], 'cursor'))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            finish = r
          }),
      )
    const q = queue(fetcher)
    await q.reset()
    const pending = q.more()
    await q.more()
    expect(fetcher).toHaveBeenCalledTimes(2)
    finish(new Response('', { status: 403 }))
    await pending
    expect(q.state.status).toBe('forbidden')
    expect(q.state.rows).toEqual([])
  })
  it('ignores late failures and disposal cancels and clears the visible model', async () => {
    let fail!: (e: Error) => void
    let signal: AbortSignal | undefined
    const q = queue(
      vi
        .fn()
        .mockImplementationOnce((_: unknown, init: RequestInit) => {
          signal = init.signal!
          return new Promise<Response>((_, reject) => {
            fail = reject
          })
        })
        .mockImplementationOnce(async () => answer([wire()])),
    )
    const old = q.reset()
    await q.reset()
    expect(signal?.aborted).toBe(true)
    fail(new Error('private backend message'))
    await old
    expect(q.state.status).toBe('ready')
    q.dispose()
    expect(q.state.rows).toEqual([])
    expect(q.state.status).toBe('idle')
  })
  it('bounds an unresponsive fetch by ten seconds and classifies it unavailable', async () => {
    vi.useFakeTimers()
    try {
      const q = queue(() => new Promise<Response>(() => {}))
      const pending = q.reset()
      await vi.advanceTimersByTimeAsync(10_001)
      await pending
      expect(q.state.status).toBe('unavailable')
    } finally {
      vi.useRealTimers()
    }
  })
  it('classifies invalid JSON, UTF-8, content type and oversized streaming data as malformed', async () => {
    for (const response of [
      new Response('{', { headers: { 'content-type': 'application/json' } }),
      new Response('{}', { headers: { 'content-type': 'text/html' } }),
      new Response(new Uint8Array([0xff]), {
        headers: { 'content-type': 'application/json' },
      }),
      new Response(new Uint8Array(8 * 1024 * 1024 + 1), {
        headers: { 'content-type': 'application/json' },
      }),
    ]) {
      const q = queue(async () => response)
      await q.reset()
      expect(q.state.status).toBe('malformed')
    }
  })
  it('consumes real site-authorized repository presentation without any writer request', async () => {
    const { ADA, BOB, createHarness, webAnnotation } =
      await import('../worker/margin/fixtures')
    const h = createHarness()
    h.database.execute(
      'INSERT INTO margin_identity(provider,issuer,subject,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)',
      [ADA.provider, ADA.issuer, ADA.subject, '2026-10-01', '2026-10-01'],
    )
    const id = h.database.query('SELECT id FROM margin_identity')[0].id
    h.database.execute(
      'INSERT INTO margin_allowlist(identity_id,role,added_at) VALUES(?,?,?)',
      [id, 'admin', '2026-10-01'],
    )
    h.database.execute(
      'INSERT INTO margin_site_admins(site,identity_id) VALUES(?,?)',
      [SITE, id],
    )
    const created = await h.request('POST', '/annotations', {
      as: BOB,
      body: webAnnotation({
        source: SITE + '/books/chapter/',
        motivation: 'editing',
        visibility: 'private',
        body,
      }),
    })
    expect(created.status).toBe(201)
    const q = queue(async (url, init) => {
      expect(init?.method).toBe('GET')
      return h.request('GET', String(url).replace('/api/margin/v1', ''))
    })
    await q.reset()
    expect(q.state.status).toBe('ready')
    expect(q.state.rows[0].hunks[0].tokens[1]).toEqual({
      kind: 'delete',
      text: 'old',
    })
  })
})

it('accepts the existing full SHA-256 base profile as well as SHA-1', () => {
  expect(
    parseReviewPage(
      {
        annotations: [wire('sha256', { 'margin:baseCommit': 'b'.repeat(64) })],
      },
      SITE,
      'pending',
    ).rows,
  ).toHaveLength(1)
})
