import { beforeEach, describe, expect, it } from 'vitest'
import {
  ADA,
  ADA_KEY,
  BOB,
  CHAPTER_ONE,
  CHAPTER_TWO,
  createHarness,
  OTHER_SITE,
  scopeQuery,
  webAnnotation,
  type MarginHarness,
} from './fixtures'
import { STRUCT_SELECTOR_TYPE } from './web-annotation'

/** The acceptance tests from issue 054, against the real router and real SQL. */

let harness: MarginHarness

beforeEach(() => {
  harness = createHarness()
})

type WireAnnotation = {
  id: string
  motivation: string
  body?: { value: string }
  target: { source: string; selector: { type: string }[] }
  creator: string
  'margin:visibility': string
  'margin:parentId'?: string
}

async function list(source: string, as: typeof ADA | null = ADA) {
  const response = await harness.request(
    'GET',
    `/annotations${scopeQuery(source)}`,
    { as },
  )
  expect(response.status).toBe(200)
  const { annotations } = (await response.json()) as {
    annotations: WireAnnotation[]
  }
  return annotations
}

async function post(body: unknown, as: typeof ADA | null = ADA) {
  return harness.request('POST', '/annotations', { as, body })
}

/** The stored id, stripped of the `urn:margin:annotation:` IRI prefix. */
function bareId(wire: WireAnnotation): string {
  return wire.id.replace('urn:margin:annotation:', '')
}

describe('GET|POST /annotations', () => {
  it('shows each reader their own private rows plus every public one', async () => {
    for (const [as, visibility, body] of [
      [ADA, 'private', 'ada private'],
      [ADA, 'public', 'ada public'],
      [BOB, 'private', 'bob private'],
      [BOB, 'public', 'bob public'],
    ] as const) {
      expect(
        (await post(webAnnotation({ source: CHAPTER_ONE, visibility, body }), as))
          .status,
      ).toBe(201)
    }

    const forAda = await list(CHAPTER_ONE, ADA)
    expect(forAda).toHaveLength(3)
    expect(forAda.map((a) => a.body?.value).sort()).toEqual([
      'ada private',
      'ada public',
      'bob public',
    ])

    const forBob = await list(CHAPTER_ONE, BOB)
    expect(forBob).toHaveLength(3)

    expect(await list(CHAPTER_ONE, null)).toHaveLength(2)
  })

  it('refuses an unauthenticated write', async () => {
    const response = await post(webAnnotation({ source: CHAPTER_ONE }), null)
    expect(response.status).toBe(401)
    expect(await list(CHAPTER_ONE, ADA)).toHaveLength(0)
  })

  it('accepts either ?source= or ?site=&document=', async () => {
    await post(webAnnotation({ source: CHAPTER_ONE, visibility: 'public' }))
    const response = await harness.request(
      'GET',
      '/annotations?site=https%3A%2F%2Fernie.sg&document=%2Fchallenges%2Fchapter-1',
    )
    expect(response.status).toBe(200)
    const { annotations } = (await response.json()) as {
      annotations: WireAnnotation[]
    }
    expect(annotations).toHaveLength(1)
  })

  it('rejects a read with no tenancy scope', async () => {
    const response = await harness.request('GET', '/annotations')
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('missing_scope')
  })
})

describe('tenancy', () => {
  it('keeps a second document invisible to the first', async () => {
    await post(
      webAnnotation({ source: CHAPTER_ONE, visibility: 'public', body: 'one' }),
    )
    await post(
      webAnnotation({ source: CHAPTER_TWO, visibility: 'public', body: 'two' }),
    )

    expect((await list(CHAPTER_ONE)).map((a) => a.body?.value)).toEqual(['one'])
    expect((await list(CHAPTER_TWO)).map((a) => a.body?.value)).toEqual(['two'])
  })

  it('keeps a second site invisible to the first, with no migration', async () => {
    await post(
      webAnnotation({ source: CHAPTER_ONE, visibility: 'public', body: 'ernie' }),
    )
    await post(
      webAnnotation({
        source: OTHER_SITE,
        visibility: 'public',
        body: 'berlayar',
      }),
    )

    expect((await list(CHAPTER_ONE)).map((a) => a.body?.value)).toEqual([
      'ernie',
    ])
    expect((await list(OTHER_SITE)).map((a) => a.body?.value)).toEqual([
      'berlayar',
    ])
  })
})

describe('prefs and the default visibility', () => {
  it('defaults to private and never rewrites an existing annotation', async () => {
    const initial = await harness.request('GET', '/prefs')
    expect(await initial.json()).toEqual({ defaultVisibility: 'private' })

    // No `margin:visibility` on the wire: the stored default applies.
    const created = await post(
      webAnnotation({ source: CHAPTER_ONE, body: 'takes the default' }),
    )
    expect(created.status).toBe(201)
    expect((await created.json())['margin:visibility']).toBe('private')

    const changed = await harness.request('PATCH', '/prefs', {
      body: { defaultVisibility: 'public' },
    })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual({ defaultVisibility: 'public' })

    // The earlier annotation is untouched...
    const [existing] = await list(CHAPTER_ONE)
    expect(existing['margin:visibility']).toBe('private')

    // ...and only the next one picks the new default up.
    const next = await post(
      webAnnotation({ source: CHAPTER_ONE, body: 'takes the new default' }),
    )
    expect((await next.json())['margin:visibility']).toBe('public')
  })

  it('keeps one default per user, not per document', async () => {
    await harness.request('PATCH', '/prefs', {
      as: BOB,
      body: { defaultVisibility: 'public' },
    })
    expect(await (await harness.request('GET', '/prefs', { as: ADA })).json())
      .toEqual({ defaultVisibility: 'private' })
    expect(await (await harness.request('GET', '/prefs', { as: BOB })).json())
      .toEqual({ defaultVisibility: 'public' })

    const bobSecondDocument = await post(
      webAnnotation({ source: CHAPTER_TWO, body: 'still public' }),
      BOB,
    )
    expect((await bobSecondDocument.json())['margin:visibility']).toBe('public')
  })

  it('rejects an unknown default and requires a caller', async () => {
    const bad = await harness.request('PATCH', '/prefs', {
      body: { defaultVisibility: 'semi-public' },
    })
    expect(bad.status).toBe(400)
    expect(
      (await harness.request('GET', '/prefs', { as: null })).status,
    ).toBe(401)
  })
})

describe('replies', () => {
  it('stores and returns a reply with its parent id intact', async () => {
    const parent = (await (
      await post(
        webAnnotation({
          source: CHAPTER_ONE,
          visibility: 'public',
          body: 'the root note',
        }),
      )
    ).json()) as WireAnnotation
    const parentId = bareId(parent)

    const reply = await post(
      webAnnotation({
        source: CHAPTER_ONE,
        visibility: 'public',
        body: 'a reply',
        parentId,
      }),
      BOB,
    )
    expect(reply.status).toBe(201)
    expect((await reply.json())['margin:parentId']).toBe(parentId)

    const listed = await list(CHAPTER_ONE, BOB)
    const stored = listed.find((a) => a.body?.value === 'a reply')
    expect(stored?.['margin:parentId']).toBe(parentId)
  })

  it('refuses a parent id from another tenant and stores nothing', async () => {
    const elsewhere = (await (
      await post(
        webAnnotation({
          source: OTHER_SITE,
          visibility: 'public',
          body: 'on another site',
        }),
      )
    ).json()) as WireAnnotation

    const response = await post(
      webAnnotation({
        source: CHAPTER_ONE,
        visibility: 'public',
        body: 'cross-tenant reply',
        parentId: bareId(elsewhere),
      }),
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('unknown_parent')
    expect(await list(CHAPTER_ONE)).toHaveLength(0)
  })

  it('refuses a parent id the caller cannot see', async () => {
    const hidden = (await (
      await post(
        webAnnotation({
          source: CHAPTER_ONE,
          visibility: 'private',
          body: 'ada keeps this',
        }),
        ADA,
      )
    ).json()) as WireAnnotation

    const response = await post(
      webAnnotation({
        source: CHAPTER_ONE,
        body: 'bob replies to what he cannot read',
        parentId: bareId(hidden),
      }),
      BOB,
    )
    expect(response.status).toBe(400)
    expect(await list(CHAPTER_ONE, BOB)).toHaveLength(0)
  })
})

describe('rejected input is never stored', () => {
  it.each([
    [
      'an unknown motivation',
      { ...webAnnotation({ source: CHAPTER_ONE }), motivation: 'bookmarking' },
    ],
    [
      'a malformed selector',
      {
        ...webAnnotation({ source: CHAPTER_ONE }),
        target: {
          source: CHAPTER_ONE,
          selector: [{ type: 'XPathSelector', value: '/html/body' }],
        },
      },
    ],
    [
      'an oversized body',
      {
        ...webAnnotation({ source: CHAPTER_ONE }),
        body: { type: 'TextualBody', value: 'x'.repeat(8_001) },
      },
    ],
    [
      'a non-http target source',
      {
        ...webAnnotation({ source: CHAPTER_ONE }),
        target: {
          ...webAnnotation({ source: CHAPTER_ONE }).target,
          source: 'urn:isbn:9780000000000',
        },
      },
    ],
  ])('rejects %s with 4xx and writes no row', async (_name, body) => {
    const response = await post(body)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)

    const rows = harness.database.query(
      'SELECT count(*) AS total FROM margin_annotations',
    ) as { total: number }[]
    expect(rows[0].total).toBe(0)
  })

  it('rejects a request with no JSON body at all', async () => {
    const response = await harness.request('POST', '/annotations')
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('malformed_json')
  })
})

describe('PATCH and DELETE /annotations/:id', () => {
  async function seedOwn() {
    const created = (await (
      await post(
        webAnnotation({
          source: CHAPTER_ONE,
          visibility: 'private',
          body: 'first draft',
        }),
      )
    ).json()) as WireAnnotation
    return bareId(created)
  }

  it('lets the owner edit the body and the visibility', async () => {
    const id = await seedOwn()
    const response = await harness.request(
      'PATCH',
      `/annotations/${id}${scopeQuery(CHAPTER_ONE)}`,
      { body: { body: 'second draft', 'margin:visibility': 'public' } },
    )
    expect(response.status).toBe(200)
    const updated = (await response.json()) as WireAnnotation
    expect(updated.body?.value).toBe('second draft')
    expect(updated['margin:visibility']).toBe('public')
  })

  it('will not let another user edit or delete it', async () => {
    const id = await seedOwn()
    const patched = await harness.request(
      'PATCH',
      `/annotations/${id}${scopeQuery(CHAPTER_ONE)}`,
      { as: BOB, body: { body: 'bob was here' } },
    )
    expect(patched.status).toBe(404)

    const deleted = await harness.request(
      'DELETE',
      `/annotations/${id}${scopeQuery(CHAPTER_ONE)}`,
      { as: BOB },
    )
    expect(deleted.status).toBe(404)
    expect(await list(CHAPTER_ONE, ADA)).toHaveLength(1)
  })

  it('deletes the owner’s own row', async () => {
    const id = await seedOwn()
    const response = await harness.request(
      'DELETE',
      `/annotations/${id}${scopeQuery(CHAPTER_ONE)}`,
    )
    expect(response.status).toBe(204)
    expect(await list(CHAPTER_ONE, ADA)).toHaveLength(0)
  })
})

describe('proposals and the routes 059 and 060 will finish', () => {
  it('lists only annotations motivated by editing', async () => {
    await post(
      webAnnotation({ source: CHAPTER_ONE, visibility: 'public', body: 'note' }),
    )
    await post(
      webAnnotation({
        source: CHAPTER_ONE,
        motivation: 'editing',
        visibility: 'public',
        body: 'read "coordinates" as "positions"',
      }),
    )

    const response = await harness.request(
      'GET',
      `/proposals${scopeQuery(CHAPTER_ONE)}`,
    )
    expect(response.status).toBe(200)
    const { annotations } = (await response.json()) as {
      annotations: WireAnnotation[]
    }
    expect(annotations).toHaveLength(1)
    expect(annotations[0].motivation).toBe('editing')
  })

  it.each([
    ['POST', '/proposals/annotation-001/apply', '060'],
    ['GET', '/documents/chapter-1/history', '059'],
  ])('answers %s %s with 501', async (method, path, issue) => {
    const response = await harness.request(method, path)
    expect(response.status).toBe(501)
    expect((await response.json()).error.message).toContain(issue)
  })
})

describe('the wire format survives a POST and a GET', () => {
  it('round-trips a plain Web Annotation without losing motivation, selectors or body', async () => {
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
          source: CHAPTER_ONE,
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

    const created = await post({ ...foreign, 'margin:visibility': 'public' })
    expect(created.status).toBe(201)

    const [stored] = await list(CHAPTER_ONE)
    expect(stored.motivation).toBe('commenting')
    expect(stored.body).toEqual({
      type: 'TextualBody',
      value: 'quoted out of context',
      format: 'text/plain',
    })
    expect(stored.target.source).toBe(CHAPTER_ONE)
    expect(stored.target.selector).toEqual(
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
    // The server owns identity: the foreign `id` and `creator` do not stick.
    expect(stored.id).not.toBe(foreign.id)
    expect(stored.creator).toBe(ADA_KEY)
  })

  it('keeps a structural selector when one was supplied', async () => {
    await post(
      webAnnotation({
        source: CHAPTER_ONE,
        visibility: 'public',
        nodeId: 'p-proposition-1',
        structId: 'sec-propositions',
      }),
    )
    const [stored] = await list(CHAPTER_ONE)
    expect(stored.target.selector).toContainEqual({
      type: STRUCT_SELECTOR_TYPE,
      'margin:nodeId': 'p-proposition-1',
      'margin:structId': 'sec-propositions',
    })
  })

  it('stores a highlight with no body and a proposal with one', async () => {
    await post(
      webAnnotation({
        source: CHAPTER_ONE,
        motivation: 'highlighting',
        visibility: 'public',
      }),
    )
    await post(
      webAnnotation({
        source: CHAPTER_ONE,
        motivation: 'editing',
        visibility: 'public',
        body: 'a proposed replacement',
      }),
    )

    const stored = await list(CHAPTER_ONE)
    const highlight = stored.find((a) => a.motivation === 'highlighting')
    const proposal = stored.find((a) => a.motivation === 'editing')
    expect(highlight?.body).toBeUndefined()
    expect(proposal?.body?.value).toBe('a proposed replacement')
  })
})
