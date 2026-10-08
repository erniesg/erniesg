import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatHunks } from '../annotations/criticmarkup'
import { ReviewSession } from './margin-review-session'

const SITE = 'https://ernie.sg'
const target = {
  id: 'urn:margin:annotation:proposal-1',
  source: SITE + '/books/chapter/?edition=one#point',
}
const principal = { provider: 'fixture', issuer: 'urn:test', subject: 'admin' }
const reviewer = 'urn:margin:principal:fixture:urn%3Atest:admin'
const wire = () => ({
  id: target.id,
  type: 'Annotation',
  motivation: 'editing',
  target: { source: target.source },
  created: '2026-10-08T00:00:00.000Z',
  body: {
    type: 'TextualBody',
    format: 'text/plain',
    value: formatHunks([
      { baseStartLine: 1, baseEndLine: 1, criticMarkup: 'A {++new++} line.' },
    ]),
  },
  'margin:revision': 1,
  'margin:baseCommit': 'a'.repeat(40),
  'margin:sourcePath': 'books/chapter.md',
})
const saved = (comments = '') => ({
  decision: 'ready',
  comments,
  revision: 1,
  reviewer,
  at: '2026-10-08T00:01:00.000Z',
})
function fixture(
  options: {
    post?: (body: any) => Response | Promise<Response>
    read?: () => Response | Promise<Response>
    identity?: () => unknown
  } = {},
) {
  let metadata: unknown = null
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url === '/auth/me')
      return Response.json(
        options.identity?.() ?? {
          authenticated: true,
          principal,
          canWrite: false,
          isAdmin: false,
        },
      )
    expect(url).toBe(
      '/api/margin/v1/proposals/proposal-1/review?' +
        new URLSearchParams({ source: target.source }),
    )
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string)
      metadata = saved(body.comments)
      return options.post ? options.post(body) : Response.json(wire())
    }
    return options.read
      ? options.read()
      : Response.json({ annotation: wire(), savedReview: metadata })
  }
  const privacy = vi.fn(),
    changed = vi.fn()
  const session = new ReviewSession(SITE, fetcher, changed, privacy)
  return {
    session,
    calls,
    privacy,
    changed,
    writes: () => calls.filter((x) => x.init?.method === 'POST'),
  }
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Save session RED pilots', () => {
  it('loads saved review then sends one exact metadata-only Save and reads its separate envelope', async () => {
    const f = fixture()
    await f.session.open(target)
    expect(f.session.canSave).toBe(true)
    await f.session.save(' ready ', '')
    expect(f.writes()).toHaveLength(1)
    expect(JSON.parse(f.writes()[0].init!.body as string)).toEqual({
      revision: 1,
      decision: 'ready',
      comments: '',
    })
    expect(f.session.state.outcome).toBe('acknowledged')
    expect(f.session.state.observed?.savedReview).toEqual(saved())
  })
  it('refreshes a409 without reusing the stale action', async () => {
    const f = fixture({ post: () => new Response(null, { status: 409 }) })
    await f.session.open(target)
    await f.session.save('ready', 'draft')
    expect(f.session.state.outcome).toBe('conflict')
    expect(f.session.canSave).toBe(false)
    expect(f.writes()).toHaveLength(1)
  })
  it('reconciles response loss with exactly one write and never claims operation identity', async () => {
    const f = fixture({
      post: () => {
        throw new Error('response lost after stored effect')
      },
    })
    await f.session.open(target)
    await f.session.save('ready', 'kept')
    expect(f.session.state.outcome).toBe('uncertain')
    expect(f.session.state.observed?.savedReview?.comments).toBe('kept')
    expect(f.session.canSave).toBe(false)
    expect(f.writes()).toHaveLength(1)
  })
  it('clears private state and draft when the observed identity changes before Save', async () => {
    let who = principal
    const f = fixture({
      identity: () => ({ authenticated: true, principal: who }),
    })
    await f.session.open(target)
    expect(f.session.state.observed).toBeDefined()
    who = { ...principal, subject: 'other' }
    await f.session.save('ready', 'private draft')
    expect(f.writes()).toHaveLength(0)
    expect(f.session.state.observed).toBeUndefined()
    expect(f.session.state.attempt).toBeUndefined()
    expect(f.privacy).toHaveBeenCalled()
  })
  it('refuses malformed readback and does not enable Save or interpret text as markup', async () => {
    const bad = {
      ...wire(),
      body: {
        type: 'TextualBody',
        format: 'text/plain',
        value: 'not canonical hunks',
      },
    }
    const f = fixture({
      read: () => Response.json({ annotation: bad, savedReview: null }),
    })
    await f.session.open(target)
    expect(f.session.state.status).toBe('malformed')
    expect(f.session.canSave).toBe(false)
    expect(f.writes()).toHaveLength(0)
  })
})

describe('Save session invariant sweep', () => {
  it('distinguishes acknowledged Save with unavailable readback from unknown write', async () => {
    let reads = 0
    const f = fixture({
      read: () =>
        ++reads === 1
          ? Response.json({ annotation: wire(), savedReview: null })
          : new Response(null, { status: 503 }),
    })
    await f.session.open(target)
    await f.session.save('ready', 'kept')
    expect(f.session.state.status).toBe('unavailable')
    expect(f.session.state.outcome).toBe('acknowledged')
    expect(f.session.state.attempt?.comments).toBe('kept')
    expect(f.session.canSave).toBe(false)
    expect(f.writes()).toHaveLength(1)
  })
  it('checks identity even after a readback error and clears uncertain private attempts on change', async () => {
    let who = principal,
      reads = 0
    const f = fixture({
      identity: () => ({ authenticated: true, principal: who }),
      read: () => {
        if (++reads === 1)
          return Response.json({ annotation: wire(), savedReview: null })
        who = { ...principal, subject: 'other' }
        return new Response(null, { status: 503 })
      },
    })
    await f.session.open(target)
    await f.session.save('ready', 'private attempt')
    expect(f.session.state.attempt).toBeUndefined()
    expect(f.session.state.observed).toBeUndefined()
    expect(f.privacy).toHaveBeenCalled()
    expect(f.writes()).toHaveLength(1)
  })
  it('coalesces rapid Save calls before auth awaits and never sends body or base edits', async () => {
    let release!: (r: Response) => void
    const f = fixture({
      post: () =>
        new Promise((r) => {
          release = r
        }),
    })
    await f.session.open(target)
    const first = f.session.save('ready', 'draft'),
      second = f.session.save('other', 'second')
    await vi.waitFor(() => expect(f.writes()).toHaveLength(1))
    release(Response.json(wire()))
    await Promise.all([first, second])
    expect(f.writes()).toHaveLength(1)
    expect(
      Object.keys(JSON.parse(f.writes()[0].init!.body as string)).sort(),
    ).toEqual(['comments', 'decision', 'revision'])
  })
  it.each([401, 403])(
    'clears both read/attempt after server refusal%s',
    async (status) => {
      const f = fixture({ post: () => new Response(null, { status }) })
      await f.session.open(target)
      await f.session.save('ready', 'secret fixture draft')
      expect(f.session.state.observed).toBeUndefined()
      expect(f.session.state.attempt).toBeUndefined()
      expect(f.privacy).toHaveBeenCalled()
      expect(f.writes()).toHaveLength(1)
    },
  )
  it('retains uncertainty for malformed Save success and concurrent same-revision metadata', async () => {
    let reads = 0
    const f = fixture({
      post: () =>
        Response.json({ annotation: wire(), savedReview: saved('ours') }),
      read: () =>
        Response.json({
          annotation: wire(),
          savedReview: ++reads === 1 ? null : saved('another latest review'),
        }),
    })
    await f.session.open(target)
    await f.session.save('ready', 'ours')
    expect(f.session.state.outcome).toBe('uncertain')
    expect(f.session.state.attempt?.comments).toBe('ours')
    expect(f.session.state.observed?.savedReview?.comments).toBe(
      'another latest review',
    )
    expect(f.session.canSave).toBe(false)
    await f.session.save('ready', 'automatic repeat')
    expect(f.writes()).toHaveLength(1)
    await f.session.open(target)
    expect(f.session.canSave).toBe(true)
    expect(f.session.state.attempt).toBeUndefined()
  })
  it('clears on close and cannot resurrect a deferred read or post-effect result', async () => {
    let release!: (r: Response) => void
    const f = fixture({
      read: () =>
        new Promise((r) => {
          release = r
        }),
    })
    const pending = f.session.open(target)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    f.session.close()
    release(
      Response.json({ annotation: wire(), savedReview: saved('private') }),
    )
    await pending
    expect(f.session.state).toEqual({ status: 'idle', outcome: 'none' })
    let finish!: (r: Response) => void
    const g = fixture({
      post: () =>
        new Promise((r) => {
          finish = r
        }),
    })
    await g.session.open(target)
    const save = g.session.save('ready', 'private')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    g.session.close()
    finish(Response.json(wire()))
    await save
    expect(g.session.state).toEqual({ status: 'idle', outcome: 'none' })
    expect(g.writes()).toHaveLength(1)
  })
  it('uses a fresh bounded read after a POST timeout without poisoning the lifetime signal', async () => {
    vi.useFakeTimers()
    const f = fixture({ post: () => new Promise(() => {}) })
    await f.session.open(target)
    const pending = f.session.save('ready', 'timeout')
    await vi.advanceTimersByTimeAsync(10_001)
    await pending
    expect(f.session.state.outcome).toBe('uncertain')
    expect(f.session.state.observed?.savedReview?.comments).toBe('timeout')
    expect(f.writes()).toHaveLength(1)
  })
  it('distinguishes unstamped/withdrawn/approved/maximum revision from editable modern rows', async () => {
    const cases: Record<string, unknown>[] = [
      {
        'margin:baseCommit': undefined,
        'margin:sourcePath': undefined,
        'margin:revision': undefined,
        body: {
          type: 'TextualBody',
          format: 'text/plain',
          value: 'old free text',
        },
      },
      { 'margin:withdrawnAt': '2026-10-08T00:00:00Z' },
      { 'margin:proposalState': 'approved', 'margin:approvedRevision': 1 },
      { 'margin:revision': Number.MAX_SAFE_INTEGER },
    ]
    for (const extra of cases) {
      const f = fixture({
        read: () =>
          Response.json({
            annotation: { ...wire(), ...extra },
            savedReview: null,
          }),
      })
      await f.session.open(target)
      expect(f.session.state.status).toBe('ready')
      expect(f.session.canSave).toBe(false)
      await f.session.save('ready', '')
      expect(f.writes()).toHaveLength(0)
    }
  })
  it('rejects invalid input locally and keeps exact source identity and bounded request options', async () => {
    const f = fixture()
    await f.session.open(target)
    for (const [decision, comments] of [
      ['', ''],
      [' '.repeat(20), ''],
      ['x'.repeat(201), ''],
      ['ready', 'x'.repeat(8001)],
    ])
      await f.session.save(decision, comments)
    expect(f.writes()).toHaveLength(0)
    expect(f.session.canSave).toBe(true)
    await f.session.save('ready', '')
    for (const call of f.calls)
      expect(call.init).toMatchObject({
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      })
  })
  it('refuses foreign or ambiguous selected targets before any writer request', async () => {
    for (const bad of [
      { ...target, id: 'bare-id' },
      { ...target, id: 'urn:margin:annotation:' },
      { ...target, id: 'urn:margin:annotation:../other' },
      { ...target, source: 'https://other.example/private' },
      { ...target, source: 'https://user:pass@ernie.sg/private' },
    ]) {
      const f = fixture()
      await f.session.open(bad)
      expect(f.session.canSave).toBe(false)
      expect(f.calls).toHaveLength(0)
    }
  })
  it('refuses malformed saved metadata, scopes, revisions and source stamps as whole readbacks', async () => {
    const mutations: ((v: any) => void)[] = [
      (v) => {
        delete v.savedReview
      },
      (v) => {
        v.savedReview = {}
      },
      (v) => {
        v.extra = 1
      },
      (v) => {
        v.savedReview = saved()
        delete v.savedReview.at
      },
      (v) => {
        v.savedReview = { ...saved(), revision: true }
      },
      (v) => {
        v.savedReview = { ...saved(), revision: 2 }
      },
      (v) => {
        v.savedReview = { ...saved(), reviewer: 'display name' }
      },
      (v) => {
        v.savedReview = { ...saved(), decision: ' ready' }
      },
      (v) => {
        v.savedReview = { ...saved(), comments: 'x'.repeat(8001) }
      },
      (v) => {
        v.savedReview = { ...saved(), at: 'yesterday' }
      },
      (v) => {
        v.annotation.id = 'urn:margin:annotation:other'
      },
      (v) => {
        v.annotation.target.source = SITE + '/other'
      },
      (v) => {
        delete v.annotation['margin:sourcePath']
      },
      (v) => {
        v.annotation['margin:approvedRevision'] = 1
      },
      (v) => {
        v.annotation['margin:proposalState'] = 'approved'
      },
      (v) => {
        v.annotation['margin:revision'] = '1'
      },
      (v) => {
        v.annotation['margin:sourcePath'] = '../other'
      },
      (v) => {
        v.annotation['margin:baseCommit'] = 'dirty'
      },
    ]
    for (const mutate of mutations) {
      const value = { annotation: wire(), savedReview: null }
      mutate(value)
      const f = fixture({ read: () => Response.json(value) })
      await f.session.open(target)
      expect(f.session.state.status).toBe('malformed')
      expect(f.session.state.observed).toBeUndefined()
      expect(f.writes()).toHaveLength(0)
    }
  })
  it('bounds readback bytes and refuses invalid UTF8/JSON/content types', async () => {
    for (const response of [
      () =>
        new Response('x'.repeat(1_048_577), {
          headers: { 'content-type': 'application/json' },
        }),
      () =>
        new Response(new Uint8Array([0xff]), {
          headers: { 'content-type': 'application/json' },
        }),
      () =>
        new Response('{', { headers: { 'content-type': 'application/json' } }),
      () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    ]) {
      const f = fixture({ read: response })
      await f.session.open(target)
      expect(f.session.state.status).toBe('malformed')
      expect(f.writes()).toHaveLength(0)
    }
  })
})

it('refuses stale selection and wrong identity witnesses without inheriting queue authority', async () => {
  const f = fixture()
  await f.session.open(target, JSON.stringify(['fixture', 'urn:test', 'other']))
  expect(f.session.state.status).toBe('session-changed')
  expect(f.session.state.observed).toBeUndefined()
  expect(f.writes()).toHaveLength(0)
  expect(f.calls.every((x) => x.url === '/auth/me')).toBe(true)
})
it('times out a stalled response stream and releases its reader', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  const f = fixture({
    read: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'))
          },
          cancel,
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  })
  const request = f.session.open(target)
  await vi.advanceTimersByTimeAsync(10_001)
  await request
  expect(f.session.state.status).toBe('unavailable')
  expect(cancel).toHaveBeenCalled()
  expect(f.writes()).toHaveLength(0)
})
it('does not dispatch after close while pre-Save identity is pending', async () => {
  const f = fixture()
  await f.session.open(target)
  let release!: (r: Response) => void
  // A separate complete session keeps the delayed identity response inside its
  // injected fetcher; no global network or auth state is modified.
  let identityCalls = 0,
    writes = 0
  const session = new ReviewSession(
    SITE,
    async (input, init) => {
      if (String(input) === '/auth/me') {
        identityCalls++
        if (identityCalls === 3)
          return new Promise((r) => {
            release = r
          })
        return Response.json({ authenticated: true, principal })
      }
      if (init?.method === 'POST') writes++
      return Response.json({ annotation: wire(), savedReview: null })
    },
    () => {},
  )
  await session.open(target)
  const save = session.save('ready', 'private')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  session.close()
  release(Response.json({ authenticated: true, principal }))
  await save
  expect(writes).toBe(0)
  expect(session.state).toEqual({ status: 'idle', outcome: 'none' })
})
it.each([
  undefined,
  null,
  {},
  { authenticated: true },
  {
    authenticated: true,
    principal: { provider: '', issuer: 'x', subject: 'y' },
  },
  { authenticated: false, principal },
  { authenticated: true, principal: [] },
])('does not infer identity from malformed auth metadata%s', async (value) => {
  const privacy = vi.fn()
  let other = 0
  const s = new ReviewSession(
    SITE,
    async (input) => {
      if (String(input) !== '/auth/me') other++
      return Response.json(
        value === undefined ? { canWrite: true, isAdmin: true } : value,
      )
    },
    () => {},
    privacy,
  )
  await s.open(target)
  expect(s.state.observed).toBeUndefined()
  expect(s.canSave).toBe(false)
  expect(other).toBe(0)
  expect(privacy).toHaveBeenCalled()
})

describe('pending revision Save behavioral RED families', () => {
  const changedBody = formatHunks([
    { baseStartLine: 1, baseEndLine: 1, criticMarkup: 'A {++better++} line.' },
  ])
  it('sends the displayed edited body once and acknowledges the exact next revision', async () => {
    const f = fixture({
      post: () =>
        Response.json({
          ...wire(),
          'margin:revision': 2,
          body: { ...wire().body, value: changedBody },
        }),
    })
    await f.session.open(target)
    await f.session.save('revise', 'clearer', changedBody)
    expect(JSON.parse(f.writes()[0].init!.body as string)).toEqual({
      revision: 1,
      decision: 'revise',
      comments: 'clearer',
      body: changedBody,
    })
    expect(f.session.state.outcome).toBe('acknowledged')
  })
  it('refuses invalid or altered-base drafts before sending any mutation', async () => {
    for (const body of [
      'not hunks',
      formatHunks([
        {
          baseStartLine: 2,
          baseEndLine: 2,
          criticMarkup: 'A {++better++} line.',
        },
      ]),
      formatHunks([
        {
          baseStartLine: 1,
          baseEndLine: 1,
          criticMarkup: 'DIFFERENT {++base++}',
        },
      ]),
    ]) {
      const f = fixture()
      await f.session.open(target)
      await f.session.save('revise', '', body)
      expect(f.writes()).toHaveLength(0)
    }
  })
  it('does not acknowledge a200 which silently ignored an edited body', async () => {
    const f = fixture()
    await f.session.open(target)
    await f.session.save('revise', '', changedBody)
    expect(f.session.state.outcome).toBe('uncertain')
    expect(f.session.canSave).toBe(false)
  })
  it('binds metadata-only success to the observed body base and source path', async () => {
    for (const extra of [
      { 'margin:baseCommit': 'b'.repeat(40) },
      { 'margin:sourcePath': 'books/other.md' },
      { body: { ...wire().body, value: changedBody } },
    ]) {
      const f = fixture({ post: () => Response.json({ ...wire(), ...extra }) })
      await f.session.open(target)
      await f.session.save('ready', '')
      expect(f.session.state.outcome).toBe('uncertain')
    }
  })
  it('retains the exact uncertain edited attempt without automatic replay', async () => {
    const f = fixture({
      post: () => {
        throw new Error('lost response')
      },
    })
    await f.session.open(target)
    await f.session.save('revise', 'draft', changedBody)
    expect(f.session.state.attempt?.body).toBe(changedBody)
    expect(f.session.state.outcome).toBe('uncertain')
    await f.session.save('revise', 'replay', changedBody)
    expect(f.writes()).toHaveLength(1)
    f.session.close()
    expect(f.session.state.attempt).toBeUndefined()
  })
})

describe('revised review same-rule controls', () => {
  const body = formatHunks([
    { baseStartLine: 1, baseEndLine: 1, criticMarkup: 'A {++better++} line.' },
  ])
  it('omits semantic no-op bodies and rejects malformed/count/size variants without writes', async () => {
    const f = fixture()
    await f.session.open(target)
    const equivalent = formatHunks([
      {
        baseStartLine: 1,
        baseEndLine: 1,
        criticMarkup: '{~~A  line.~>A new line.~~}',
      },
    ])
    await f.session.save('ready', '', equivalent)
    expect(JSON.parse(f.writes()[0].init!.body as string)).toEqual({
      revision: 1,
      decision: 'ready',
      comments: '',
    })
    expect(f.session.state.outcome).toBe('acknowledged')
    for (const invalid of [
      body + ' ',
      formatHunks([
        { baseStartLine: 1, baseEndLine: 1, criticMarkup: '{++broken' },
      ]),
      formatHunks([
        {
          baseStartLine: 1,
          baseEndLine: 2,
          criticMarkup: 'A {++better++} line.',
        },
      ]),
      formatHunks([
        {
          baseStartLine: 1,
          baseEndLine: 1,
          criticMarkup: 'A {++better++} line.',
        },
        { baseStartLine: 2, baseEndLine: 2, criticMarkup: 'other' },
      ]),
      formatHunks([
        {
          baseStartLine: 1,
          baseEndLine: 1,
          criticMarkup: 'A {++' + 'x'.repeat(64_000) + '++} line.',
        },
      ]),
    ]) {
      const bad = fixture()
      await bad.session.open(target)
      await bad.session.save('ready', '', invalid)
      expect(bad.writes()).toHaveLength(0)
    }
  })
  it('binds every edited-success field and classifies changed metadata as uncertain', async () => {
    const expected = {
      ...wire(),
      'margin:revision': 2,
      body: { ...wire().body, value: body },
    }
    for (const override of [
      { 'margin:revision': 1 },
      { 'margin:revision': 3 },
      { 'margin:baseCommit': 'b'.repeat(40) },
      { 'margin:sourcePath': 'books/other.md' },
      { id: 'urn:margin:annotation:other' },
      { 'margin:withdrawnAt': '2026-10-08T00:00:00.000Z' },
      { 'margin:proposalState': 'approved', 'margin:approvedRevision': 2 },
      { body: wire().body },
    ]) {
      const f = fixture({
        post: () => Response.json({ ...expected, ...override }),
      })
      await f.session.open(target)
      await f.session.save('ready', '', body)
      expect(f.session.state.outcome).toBe('uncertain')
      expect(f.writes()).toHaveLength(1)
    }
  })
  it('coalesces body writes and clears the attempted edit after an observed principal switch', async () => {
    let release!: (r: Response) => void,
      who = principal
    const f = fixture({
      identity: () => ({ authenticated: true, principal: who }),
      post: () =>
        new Promise((r) => {
          release = r
        }),
    })
    await f.session.open(target)
    const pending = f.session.save('revise', '', body)
    await f.session.save('again', '', body)
    await vi.waitFor(() => expect(f.writes()).toHaveLength(1))
    who = { ...principal, subject: 'other' }
    release(
      Response.json({
        ...wire(),
        'margin:revision': 2,
        body: { ...wire().body, value: body },
      }),
    )
    await pending
    expect(f.session.state.attempt).toBeUndefined()
    expect(f.session.state.observed).toBeUndefined()
    expect(f.privacy).toHaveBeenCalled()
  })
  it('keeps revision-race409 and acknowledged/readback503 separate from unknown writes', async () => {
    for (const mode of [
      'conflict',
      'ack-read-unavailable',
      'uncertain-later-body',
    ] as const) {
      let reads = 0
      const f = fixture({
        post: () =>
          mode === 'conflict'
            ? new Response(null, { status: 409 })
            : mode === 'uncertain-later-body'
              ? new Response(null, { status: 503 })
              : Response.json({
                  ...wire(),
                  'margin:revision': 2,
                  body: { ...wire().body, value: body },
                }),
        read: () =>
          ++reads === 1
            ? Response.json({ annotation: wire(), savedReview: null })
            : mode === 'ack-read-unavailable'
              ? new Response(null, { status: 503 })
              : Response.json({
                  annotation: { ...wire(), 'margin:revision': 3 },
                  savedReview: null,
                }),
      })
      await f.session.open(target)
      await f.session.save('revise', '', body)
      expect(f.session.state.outcome).toBe(
        mode === 'conflict'
          ? 'conflict'
          : mode === 'ack-read-unavailable'
            ? 'acknowledged'
            : 'uncertain',
      )
      expect(f.session.state.attempt?.body).toBe(body)
      expect(f.writes()).toHaveLength(1)
      if (mode !== 'ack-read-unavailable')
        expect(f.session.state.observed?.revision).toBe(3)
      expect(f.session.canSave).toBe(false)
    }
  })
  it('uses the same real SQLite Save path for another creator and the admin without an approval or repository call', async () => {
    const { ADA, BOB, createHarness, webAnnotation } =
      await import('../worker/margin/fixtures')
    const { ensureSchema } = await import('../worker/margin/identity')
    const external = vi
      .fn()
      .mockRejectedValue(new Error('no external operation'))
    vi.stubGlobal('fetch', external)
    try {
      for (const creator of [ADA, BOB]) {
        const h = createHarness()
        await ensureSchema(h.database)
        h.database.execute(
          'INSERT INTO margin_identity(provider,issuer,subject,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)',
          [
            ADA.provider,
            ADA.issuer,
            ADA.subject,
            '2026-10-08T00:00:00.000Z',
            '2026-10-08T00:00:00.000Z',
          ],
        )
        const identity = h.database.query('SELECT id FROM margin_identity')[0]
          .id
        h.database.execute(
          'INSERT INTO margin_allowlist(identity_id,role,added_at) VALUES(?,?,?)',
          [identity, 'admin', '2026-10-08T00:00:00.000Z'],
        )
        h.database.execute(
          'INSERT INTO margin_site_admins(site,identity_id) VALUES(?,?)',
          [SITE, identity],
        )
        const create = await h.request('POST', '/annotations', {
          as: creator,
          body: webAnnotation({
            source: target.source,
            motivation: 'editing',
            visibility: 'private',
            body: wire().body.value,
          }),
        })
        expect(create.status).toBe(201)
        const created = await create.json()
        const selected = { id: created.id, source: target.source }
        const writes: unknown[] = []
        const session = new ReviewSession(
          SITE,
          async (url, init) => {
            if (String(url) === '/auth/me')
              return Response.json({ authenticated: true, principal: ADA })
            const data = init?.body ? JSON.parse(String(init.body)) : undefined
            if (init?.method === 'POST') writes.push(data)
            return h.request(
              (init?.method ?? 'GET') as 'GET' | 'POST',
              String(url).replace('/api/margin/v1', ''),
              { as: ADA, ...(data ? { body: data } : {}) },
            )
          },
          () => {},
        )
        await session.open(selected)
        expect(session.canSave).toBe(true)
        await session.save('revise', 'clearer', body)
        expect(session.state.outcome).toBe('acknowledged')
        expect(session.state.observed?.revision).toBe(2)
        expect(session.state.observed?.body).toBe(body)
        expect(session.state.observed?.state).toBe('pending')
        expect(session.state.observed?.savedReview).toMatchObject({
          revision: 2,
          decision: 'revise',
          comments: 'clearer',
        })
        expect(writes).toEqual([
          { revision: 1, decision: 'revise', comments: 'clearer', body },
        ])
        expect(
          h.database.query('SELECT * FROM margin_proposal_applications'),
        ).toEqual([])
        expect(session.state.observed?.baseCommit).toBe(
          created['margin:baseCommit'],
        )
        expect(session.state.observed?.sourcePath).toBe(
          created['margin:sourcePath'],
        )
      }
      expect(external).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
