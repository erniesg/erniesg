import { beforeEach, describe, expect, it } from 'vitest'
import {
  ADA,
  ADA_KEY,
  BOB_KEY,
  BOB,
  CHAPTER_ONE,
  CHAPTER_TWO,
  createHarness,
  OTHER_SITE,
  scopeQuery,
  webAnnotation,
  type MarginHarness,
} from './fixtures'
import {
  MAX_CONTEXT_LENGTH,
  MAX_QUOTE_LENGTH,
  STRUCT_SELECTOR_TYPE,
} from './web-annotation'
import { MARGIN_API_PREFIX } from './routes'
import { MAX_PAGE_SIZE } from './repository'
import { MAX_SOURCE_LENGTH } from './web-annotation'

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
        (
          await post(
            webAnnotation({ source: CHAPTER_ONE, visibility, body }),
            as,
          )
        ).status,
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
      webAnnotation({
        source: CHAPTER_ONE,
        visibility: 'public',
        body: 'ernie',
      }),
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
    expect(await initial.json()).toEqual({
      defaultVisibility: 'private',
      creator: ADA_KEY,
    })

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
    expect(await changed.json()).toEqual({
      defaultVisibility: 'public',
      creator: ADA_KEY,
    })

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
    expect(
      await (await harness.request('GET', '/prefs', { as: ADA })).json(),
    ).toEqual({ defaultVisibility: 'private', creator: ADA_KEY })
    expect(
      await (await harness.request('GET', '/prefs', { as: BOB })).json(),
    ).toEqual({ defaultVisibility: 'public', creator: BOB_KEY })

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
    expect((await harness.request('GET', '/prefs', { as: null })).status).toBe(
      401,
    )
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
      webAnnotation({
        source: CHAPTER_ONE,
        visibility: 'public',
        body: 'note',
      }),
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

/** The findings from review of the rescue PR, each with the case that found it. */
describe('review findings', () => {
  // The delete path is owner-scoped, so nothing it does may reach somebody
  // else's annotation. A cascade through `parent_id` would have done exactly
  // that, and quietly.
  it('refuses to delete a parent that other people have replied to', async () => {
    const parent = (await (
      await post(
        webAnnotation({
          source: CHAPTER_ONE,
          visibility: 'public',
          body: 'ada asks',
        }),
      )
    ).json()) as WireAnnotation

    const reply = await post(
      webAnnotation({
        source: CHAPTER_ONE,
        visibility: 'public',
        body: 'bob answers',
        parentId: bareId(parent),
      }),
      BOB,
    )
    expect(reply.status).toBe(201)

    const refused = await harness.request(
      'DELETE',
      `/annotations/${bareId(parent)}${scopeQuery(CHAPTER_ONE)}`,
      { as: ADA },
    )
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({
      error: { code: 'has_replies' },
    })

    // Both are still there, Bob's included.
    const remaining = await list(CHAPTER_ONE, BOB)
    expect(remaining.map((entry) => entry.body?.value).sort()).toEqual([
      'ada asks',
      'bob answers',
    ])
  })

  it('still deletes an annotation nobody has replied to', async () => {
    const own = (await (
      await post(
        webAnnotation({ source: CHAPTER_ONE, body: 'no replies here' }),
      )
    ).json()) as WireAnnotation

    const response = await harness.request(
      'DELETE',
      `/annotations/${bareId(own)}${scopeQuery(CHAPTER_ONE)}`,
      { as: ADA },
    )
    expect(response.status).toBe(204)
  })

  // A client writing a reply has the parent's returned `id`, which is the IRI.
  // Requiring the bare key meant the obvious thing failed with `unknown_parent`.
  it('takes the parent id in the form it handed back', async () => {
    const parent = (await (
      await post(webAnnotation({ source: CHAPTER_ONE, body: 'the question' }))
    ).json()) as WireAnnotation
    expect(parent.id).toMatch(/^urn:margin:annotation:/)

    for (const reference of [parent.id, bareId(parent)]) {
      const response = await post(
        webAnnotation({
          source: CHAPTER_ONE,
          body: `reply to ${reference}`,
          parentId: reference,
        }),
      )
      expect(response.status, `parentId ${reference}`).toBe(201)
      const created = (await response.json()) as WireAnnotation
      expect(created['margin:parentId']).toBe(bareId(parent))
    }
  })

  // Valid absolute targets the URL parser rewrites: a default port spelled out,
  // an upper-case host, a path with dot segments. Rejecting them turned ordinary
  // external annotations away.
  it('canonicalises a target rather than refusing its spelling', async () => {
    for (const [sent, canonical] of [
      ['https://ernie.sg:443/challenges/chapter-1', CHAPTER_ONE],
      ['https://ERNIE.SG/challenges/chapter-1', CHAPTER_ONE],
      ['https://ernie.sg/challenges/./chapter-1', CHAPTER_ONE],
      ['https://ernie.sg/challenges/x/../chapter-1', CHAPTER_ONE],
    ] as const) {
      const response = await post(
        webAnnotation({ source: sent, body: `via ${sent}` }),
      )
      expect(response.status, sent).toBe(201)
      const created = (await response.json()) as WireAnnotation
      expect(created.target.source, sent).toBe(canonical)
    }

    // And all of them landed on the one document, not four tenants.
    expect((await list(CHAPTER_ONE)).length).toBe(4)
  })

  it('refuses a target carrying credentials rather than dropping them', async () => {
    const response = await post(
      webAnnotation({
        source: 'https://user:secret@ernie.sg/challenges/chapter-1',
      }),
    )

    expect(response.status).toBe(400)
  })

  // The store keeps a body's `value` and nothing else, so accepting metadata it
  // would silently rewrite is worse than refusing it.
  it('refuses body metadata it cannot keep', async () => {
    for (const body of [
      { type: 'TextualBody', value: 'a remark', format: 'text/markdown' },
      { type: 'TextualBody', value: 'a remark', language: 'fr' },
    ]) {
      const response = await post({
        ...webAnnotation({ source: CHAPTER_ONE }),
        body,
      })
      expect(response.status, JSON.stringify(body)).toBe(400)
    }

    const accepted = await post({
      ...webAnnotation({ source: CHAPTER_ONE }),
      body: { type: 'TextualBody', value: 'a remark', format: 'text/plain' },
    })
    expect(accepted.status).toBe(201)
  })

  // An uncaught `URIError` from `decodeURIComponent` would be a 500 on a public
  // request. A path that cannot be decoded matches no route.
  it('answers a malformed percent escape with a 404, not a 500', async () => {
    for (const bad of ['%', '%E0%A4%A', 'annotations/%']) {
      const response = await harness.request('GET', `/${bad}`, { as: ADA })
      expect(response.status, bad).toBe(404)
      expect(await response.json()).toMatchObject({
        error: { code: 'not_found' },
      })
    }
  })
})

/** The second review round: each finding with the request that found it. */
describe('review findings, round two', () => {
  // POST and `?source=` canonicalise; the explicit pair validated the
  // concatenation and then queried the raw spelling, so a write and a read could
  // land on different tenants.
  it('canonicalises the explicit site and document too', async () => {
    expect(
      (await post(webAnnotation({ source: CHAPTER_ONE, body: 'stored' })))
        .status,
    ).toBe(201)

    for (const site of [
      'https://ernie.sg',
      'https://ERNIE.SG',
      'https://ernie.sg:443',
    ]) {
      const response = await harness.request(
        'GET',
        `/annotations?site=${encodeURIComponent(site)}` +
          `&document=${encodeURIComponent('/challenges/chapter-1')}`,
        { as: ADA },
      )
      expect(response.status, site).toBe(200)
      const { annotations } = (await response.json()) as {
        annotations: WireAnnotation[]
      }
      expect(
        annotations.map((a) => a.body?.value),
        site,
      ).toEqual(['stored'])
    }
  })

  // Without the leading slash the concatenation can leave the origin altogether
  // and split back into a different tenant, which is a read and a write against
  // somebody else's site rather than a malformed request.
  it('refuses a document that is not a path', async () => {
    for (const document of [
      '.example.com/x',
      'chapter',
      '@evil.test/x',
      '',
      '?q=1',
      '#frag',
    ]) {
      const response = await harness.request(
        'GET',
        `/annotations?site=${encodeURIComponent('https://ernie.sg')}` +
          `&document=${encodeURIComponent(document)}`,
        { as: ADA },
      )
      expect(response.status, JSON.stringify(document)).toBe(400)
    }
  })

  it('refuses a site that is not an origin on its own', async () => {
    for (const site of [
      'https://ernie.sg/challenges',
      'https://ernie.sg/?a=1',
      'https://ernie.sg/#x',
      'https://user:secret@ernie.sg',
      'ftp://ernie.sg',
    ]) {
      const response = await harness.request(
        'GET',
        `/annotations?site=${encodeURIComponent(site)}` +
          `&document=${encodeURIComponent('/challenges/chapter-1')}`,
        { as: ADA },
      )
      expect(response.status, site).toBe(400)
    }
  })

  // 409 vs 404 on an annotation the caller cannot see would tell them it exists
  // and whether anybody has replied to it — an oracle over what visibility hides.
  it("does not let the reply check reveal somebody else's annotation", async () => {
    const hidden = (await (
      await post(
        webAnnotation({
          source: CHAPTER_ONE,
          visibility: 'private',
          body: 'bob private',
        }),
        BOB,
      )
    ).json()) as WireAnnotation
    const withReply = (await (
      await post(
        webAnnotation({
          source: CHAPTER_ONE,
          visibility: 'public',
          body: 'bob public',
        }),
        BOB,
      )
    ).json()) as WireAnnotation
    expect(
      (
        await post(
          webAnnotation({
            source: CHAPTER_ONE,
            visibility: 'public',
            body: 'ada replies',
            parentId: bareId(withReply),
          }),
        )
      ).status,
    ).toBe(201)

    // Ada is signed in and is not the owner of either. Both answers must match,
    // and neither may be 409.
    for (const target of [hidden, withReply]) {
      const response = await harness.request(
        'DELETE',
        `/annotations/${bareId(target)}${scopeQuery(CHAPTER_ONE)}`,
        { as: ADA },
      )
      expect(response.status, bareId(target)).toBe(404)
    }
  })

  // These three were the only strings on the wire with no maximum, and they are
  // copied into D1 and into every collection response.
  it('bounds the selector text', async () => {
    const huge = 'x'.repeat(MAX_QUOTE_LENGTH + 1)
    const longContext = 'y'.repeat(MAX_CONTEXT_LENGTH + 1)
    const base = webAnnotation({ source: CHAPTER_ONE })
    const withSelector = (patch: Record<string, unknown>) => ({
      ...base,
      target: {
        ...base.target,
        selector: base.target.selector.map((entry) =>
          (entry as { type: string }).type === 'TextQuoteSelector'
            ? { ...entry, ...patch }
            : entry,
        ),
      },
    })

    for (const patch of [
      { exact: huge },
      { prefix: longContext },
      { suffix: longContext },
    ]) {
      expect(
        (await post(withSelector(patch))).status,
        JSON.stringify(Object.keys(patch)),
      ).toBe(400)
    }

    // At the bound, with the position selector agreeing: a quote and a position
    // that describe different lengths is a different rejection, and this test is
    // about the length limit.
    const atBound = 'x'.repeat(MAX_QUOTE_LENGTH)
    const consistent = {
      ...base,
      target: {
        ...base.target,
        selector: base.target.selector.map((entry) => {
          const typed = entry as { type: string }
          if (typed.type === 'TextQuoteSelector')
            return { ...entry, exact: atBound }
          if (typed.type === 'TextPositionSelector') {
            return { ...entry, start: 5, end: 5 + atBound.length }
          }
          return entry
        }),
      },
    }
    const accepted = await post(consistent)
    expect(accepted.status, JSON.stringify(await accepted.clone().json())).toBe(
      201,
    )
  })

  // A `Location` a client cannot dereference is worse than none.
  it('returns a Location a client can actually follow', async () => {
    const created = await post(
      webAnnotation({ source: CHAPTER_ONE, body: 'follow me' }),
    )
    expect(created.status).toBe(201)
    const location = created.headers.get('location') as string

    expect(location).toContain('source=')

    const followed = await harness.request(
      'GET',
      location.slice(MARGIN_API_PREFIX.length),
      { as: ADA },
    )
    expect(followed.status).toBe(200)
    expect(((await followed.json()) as WireAnnotation).body?.value).toBe(
      'follow me',
    )
  })

  it('shows a public annotation at its own URI and hides a private one', async () => {
    const mine = (await (
      await post(
        webAnnotation({
          source: CHAPTER_ONE,
          visibility: 'private',
          body: 'ada private',
        }),
      )
    ).json()) as WireAnnotation

    const asOwner = await harness.request(
      'GET',
      `/annotations/${bareId(mine)}${scopeQuery(CHAPTER_ONE)}`,
      { as: ADA },
    )
    expect(asOwner.status).toBe(200)

    const asOther = await harness.request(
      'GET',
      `/annotations/${bareId(mine)}${scopeQuery(CHAPTER_ONE)}`,
      { as: BOB },
    )
    expect(asOther.status).toBe(404)
  })

  // PATCH already refused this; creation accepted it and stored null, so the
  // annotation came back changed.
  it('refuses a colour on an annotation that is not a highlight', async () => {
    for (const motivation of ['commenting', 'editing'] as const) {
      const response = await post({
        ...webAnnotation({ source: CHAPTER_ONE, motivation }),
        'margin:color': 'amber',
      })
      expect(response.status, motivation).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: 'unexpected_color' },
      })
    }

    const highlight = await post({
      ...webAnnotation({ source: CHAPTER_ONE, motivation: 'highlighting' }),
      'margin:color': 'amber',
    })
    expect(highlight.status).toBe(201)
    expect(
      ((await highlight.json()) as { 'margin:color'?: string })['margin:color'],
    ).toBe('amber')
  })
})

describe('review findings, round three', () => {
  // Every response carries `urn:margin:annotation:<uuid>` as its `id`, so that is
  // what a client holds. Requiring the bare key here meant the identifier the API
  // hands out did not work in the API's own URLs.
  it('takes either spelling of an id on the item routes', async () => {
    const created = (await (
      await post(
        webAnnotation({ source: CHAPTER_ONE, body: 'either spelling' }),
      )
    ).json()) as WireAnnotation

    for (const reference of [created.id, bareId(created)]) {
      const got = await harness.request(
        'GET',
        `/annotations/${encodeURIComponent(reference)}${scopeQuery(CHAPTER_ONE)}`,
        { as: ADA },
      )
      expect(got.status, `GET ${reference}`).toBe(200)

      const patched = await harness.request(
        'PATCH',
        `/annotations/${encodeURIComponent(reference)}${scopeQuery(CHAPTER_ONE)}`,
        { as: ADA, body: { body: `edited via ${reference}` } },
      )
      expect(patched.status, `PATCH ${reference}`).toBe(200)
    }

    const deleted = await harness.request(
      'DELETE',
      `/annotations/${encodeURIComponent(created.id)}${scopeQuery(CHAPTER_ONE)}`,
      { as: ADA },
    )
    expect(deleted.status).toBe(204)
  })

  // A page is always bounded: one response would otherwise carry every row on a
  // document, and each row can hold a few kilobytes of body and selector text.
  it('bounds a collection and hands back a cursor', async () => {
    for (let index = 0; index < 5; index += 1) {
      expect(
        (
          await post(
            webAnnotation({ source: CHAPTER_ONE, body: `note ${index}` }),
          )
        ).status,
      ).toBe(201)
    }

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const query =
        `${scopeQuery(CHAPTER_ONE)}&limit=2` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
      const response = await harness.request('GET', `/annotations${query}`, {
        as: ADA,
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        annotations: WireAnnotation[]
        nextCursor?: string
      }
      expect(body.annotations.length).toBeLessThanOrEqual(2)
      seen.push(...body.annotations.map((entry) => entry.body?.value as string))
      cursor = body.nextCursor
      pages += 1
      expect(pages, 'paging must terminate').toBeLessThan(10)
    } while (cursor)

    expect(pages).toBe(3)
    expect(seen).toEqual(['note 0', 'note 1', 'note 2', 'note 3', 'note 4'])
  })

  it('refuses a limit outside the bound and a cursor it did not issue', async () => {
    for (const query of [
      '&limit=0',
      `&limit=${MAX_PAGE_SIZE + 1}`,
      '&limit=2.5',
      '&limit=many',
    ]) {
      const response = await harness.request(
        'GET',
        `/annotations${scopeQuery(CHAPTER_ONE)}${query}`,
        { as: ADA },
      )
      expect(response.status, query).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid_limit' },
      })
    }

    const bad = await harness.request(
      'GET',
      `/annotations${scopeQuery(CHAPTER_ONE)}&cursor=nonsense`,
      { as: ADA },
    )
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({
      error: { code: 'invalid_cursor' },
    })
  })

  it('omits the cursor on the last page', async () => {
    expect(
      (await post(webAnnotation({ source: CHAPTER_ONE, body: 'only one' })))
        .status,
    ).toBe(201)

    const response = await harness.request(
      'GET',
      `/annotations${scopeQuery(CHAPTER_ONE)}&limit=2`,
      { as: ADA },
    )
    const body = (await response.json()) as { nextCursor?: string }
    expect(body.nextCursor).toBeUndefined()
  })

  // A reply can arrive between the count and the delete. The constraint catches
  // it, and that is a conflict the caller can act on rather than the store being
  // unavailable.
  it('reports a lost race as a conflict, not as an outage', async () => {
    const parent = (await (
      await post(
        webAnnotation({
          source: CHAPTER_ONE,
          visibility: 'public',
          body: 'the parent',
        }),
      )
    ).json()) as WireAnnotation

    // Slip a reply in between the reply count and the delete.
    const original = harness.repository.countReplies.bind(harness.repository)
    harness.repository.countReplies = async (scope, id) => {
      const count = await original(scope, id)
      if (id === bareId(parent) && count === 0) {
        await post(
          webAnnotation({
            source: CHAPTER_ONE,
            visibility: 'public',
            body: 'bob slips in',
            parentId: bareId(parent),
          }),
          BOB,
        )
      }
      return count
    }

    const response = await harness.request(
      'DELETE',
      `/annotations/${bareId(parent)}${scopeQuery(CHAPTER_ONE)}`,
      { as: ADA },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'has_replies' },
    })
  })
})

describe('review findings, round four', () => {
  // `@document` is the service's own sentinel for "no structural selector", so
  // accepting it as a node id and reading it back as the selector's absence
  // would quietly turn a structurally anchored annotation into a document-wide
  // one.
  it('reserves the document sentinel rather than losing it on the round trip', async () => {
    const base = webAnnotation({ source: CHAPTER_ONE })
    const withSentinel = {
      ...base,
      target: {
        ...base.target,
        selector: base.target.selector.map((entry) =>
          (entry as { type: string }).type === STRUCT_SELECTOR_TYPE
            ? { type: STRUCT_SELECTOR_TYPE, 'margin:nodeId': '@document' }
            : entry,
        ),
      },
    }

    const response = await post(withSentinel)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_annotation' },
    })
  })

  it('still round-trips a real node id, and still omits an absent selector', async () => {
    const scoped = (await (
      await post(
        webAnnotation({ source: CHAPTER_ONE, nodeId: 'p-proposition-7' }),
      )
    ).json()) as WireAnnotation
    const struct = scoped.target.selector.find(
      (entry) => entry.type === STRUCT_SELECTOR_TYPE,
    ) as { 'margin:nodeId'?: string } | undefined
    expect(struct?.['margin:nodeId']).toBe('p-proposition-7')
  })

  // W3C TextPositionSelector offsets count characters. An emoji is one
  // character and two UTF-16 units, so counting `.length` rejected a valid
  // selector over any non-BMP quote.
  it('accepts a selector whose quote contains a non-BMP character', async () => {
    const exact = 'a 🌊 wave'
    const base = webAnnotation({ source: CHAPTER_ONE })
    const emoji = {
      ...base,
      target: {
        ...base.target,
        selector: base.target.selector.map((entry) => {
          const typed = entry as { type: string }
          if (typed.type === 'TextQuoteSelector') {
            return { ...entry, exact, prefix: '', suffix: '' }
          }
          if (typed.type === 'TextPositionSelector') {
            // Characters, not UTF-16 units: `[...exact].length` is 8 where
            // `exact.length` is 9.
            return { ...entry, start: 5, end: 5 + [...exact].length }
          }
          return entry
        }),
      },
    }
    expect([...exact].length).toBe(8)
    expect(exact.length).toBe(9)

    const response = await post(emoji)
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(
      201,
    )

    const created = (await response.json()) as WireAnnotation
    const position = created.target.selector.find(
      (entry) => entry.type === 'TextPositionSelector',
    ) as unknown as { start: number; end: number }
    expect(position.end - position.start).toBe([...exact].length)
  })

  it('still refuses a span that does not match its quote', async () => {
    const base = webAnnotation({ source: CHAPTER_ONE })
    const mismatched = {
      ...base,
      target: {
        ...base.target,
        selector: base.target.selector.map((entry) =>
          (entry as { type: string }).type === 'TextPositionSelector'
            ? { ...entry, start: 5, end: 6 }
            : entry,
        ),
      },
    }

    expect((await post(mismatched)).status).toBe(400)
  })
})

describe('review findings, round five', () => {
  // `site=https://ernie.sg/` + `document=/chapter` concatenated to
  // `https://ernie.sg//chapter`, which splits back to the document `//chapter`.
  // A trailing slash silently addressed a different document than was written.
  it('joins the document to the canonical origin, trailing slash and all', async () => {
    expect(
      (await post(webAnnotation({ source: CHAPTER_ONE, body: 'stored' })))
        .status,
    ).toBe(201)

    for (const site of [
      'https://ernie.sg',
      'https://ernie.sg/',
      'https://ERNIE.SG/',
    ]) {
      const response = await harness.request(
        'GET',
        `/annotations?site=${encodeURIComponent(site)}` +
          `&document=${encodeURIComponent('/challenges/chapter-1')}`,
        { as: ADA },
      )
      expect(response.status, site).toBe(200)
      const { annotations } = (await response.json()) as {
        annotations: WireAnnotation[]
      }
      expect(
        annotations.map((a) => a.body?.value),
        site,
      ).toEqual(['stored'])
    }
  })

  // The mirror of the delete race: the parent goes away between the lookup and
  // the insert, so `parent_id` refuses the row. The store is healthy.
  it('reports a deleted parent as a conflict, not as an outage', async () => {
    const parent = (await (
      await post(
        webAnnotation({ source: CHAPTER_ONE, body: 'about to vanish' }),
      )
    ).json()) as WireAnnotation

    // Delete the parent between `findAnnotation` and `insertAnnotation`.
    //
    // Once, and the guard is load-bearing rather than tidy: the DELETE below
    // goes through `deleteAnnotation`, which calls `findAnnotation` itself, so an
    // unguarded wrapper re-enters through its own interleaving and recurses
    // until the heap is gone. It did exactly that — a 4 GB OOM after 267 s —
    // which is how this comment came to exist.
    const original = harness.repository.findAnnotation.bind(harness.repository)
    let interleaved = false
    harness.repository.findAnnotation = async (scope, id, viewer) => {
      const found = await original(scope, id, viewer)
      if (!interleaved && id === bareId(parent)) {
        interleaved = true
        await harness.request(
          'DELETE',
          `/annotations/${bareId(parent)}${scopeQuery(CHAPTER_ONE)}`,
          { as: ADA },
        )
      }
      return found
    }

    const response = await post(
      webAnnotation({
        source: CHAPTER_ONE,
        body: 'a reply to nothing',
        parentId: bareId(parent),
      }),
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'unknown_parent' },
    })
  })

  // The record does not store `type` and the response always says `Annotation`,
  // so anything else was accepted and read back with different JSON-LD meaning.
  it('refuses a type it cannot preserve', async () => {
    for (const type of [
      'AnnotationPage',
      ['Annotation', 'CustomType'],
      [],
      'annotation',
    ]) {
      const response = await post({
        ...webAnnotation({ source: CHAPTER_ONE }),
        type,
      })
      expect(response.status, JSON.stringify(type)).toBe(400)
    }

    for (const type of ['Annotation', ['Annotation']]) {
      const response = await post({
        ...webAnnotation({ source: CHAPTER_ONE }),
        type,
      })
      expect(response.status, JSON.stringify(type)).toBe(201)
      expect(((await response.json()) as { type: string }).type).toBe(
        'Annotation',
      )
    }
  })

  // TextPositionSelector is W3C code-point based. The wire mapping records that
  // unit, so accepting a UTF-16 span here would create an ambiguous anchor.
  it('accepts only the W3C code-point span', async () => {
    const exact = 'a 🌊 wave'
    const base = webAnnotation({ source: CHAPTER_ONE })
    const withSpan = (end: number) => ({
      ...base,
      target: {
        ...base.target,
        selector: base.target.selector.map((entry) => {
          const typed = entry as { type: string }
          if (typed.type === 'TextQuoteSelector') {
            return { ...entry, exact, prefix: '', suffix: '' }
          }
          if (typed.type === 'TextPositionSelector')
            return { ...entry, start: 5, end }
          return entry
        }),
      },
    })

    // 8 code points; 9 is the UTF-16 spelling and must not enter storage.
    expect((await post(withSpan(5 + [...exact].length))).status).toBe(201)
    expect((await post(withSpan(5 + exact.length))).status).toBe(400)
    expect((await post(withSpan(5 + 4))).status).toBe(400)
  })
})

describe('review findings, round six', () => {
  // `url.pathname` percent-encodes raw non-ASCII, so a source can grow past the
  // maximum *after* the maximum has been checked — accepted, stored, and handed
  // back in a shape the schema would refuse.
  it('rechecks the source length against its canonical form', async () => {
    const tooLong = `https://ernie.sg/${'🌊'.repeat(600)}`
    expect(tooLong.length).toBeLessThan(MAX_SOURCE_LENGTH)
    expect(encodeURI(tooLong).length).toBeGreaterThan(MAX_SOURCE_LENGTH)

    expect((await post(webAnnotation({ source: tooLong }))).status).toBe(400)

    // And one that is long but fits once encoded is still accepted.
    const fits = `https://ernie.sg/${'🌊'.repeat(10)}`
    expect((await post(webAnnotation({ source: fits }))).status).toBe(201)
  })

  // A proposal has a body. Every consumer testing `kind === 'note'` rendered
  // nothing for it — a body a reader wrote, stored and invisible.
  it('reports a body for every kind that has one', async () => {
    const bodies = await Promise.all(
      (['commenting', 'editing'] as const).map(async (motivation) => {
        const response = await post(
          webAnnotation({
            source: CHAPTER_ONE,
            motivation,
            body: `a ${motivation} body`,
          }),
        )
        expect(response.status, motivation).toBe(201)
        return ((await response.json()) as WireAnnotation).body?.value
      }),
    )

    expect(bodies).toEqual(['a commenting body', 'a editing body'])
  })
})

describe('reply visibility boundaries', () => {
  async function create(
    visibility: 'private' | 'public',
    parentId?: string,
    as = ADA,
  ) {
    const response = await post(
      webAnnotation({ source: CHAPTER_ONE, visibility, parentId }),
      as,
    )
    expect(response.status).toBe(201)
    return (await response.json()) as WireAnnotation
  }

  async function setVisibility(
    annotation: WireAnnotation,
    visibility: 'private' | 'public',
    as = ADA,
  ) {
    return harness.request(
      'PATCH',
      `/annotations/${bareId(annotation)}${scopeQuery(CHAPTER_ONE)}`,
      { as, body: { 'margin:visibility': visibility } },
    )
  }

  it.each(['explicit', 'preference'] as const)(
    'rejects an owner public reply to a private parent using %s visibility',
    async (mode) => {
      const parent = await create('private')
      if (mode === 'preference') {
        expect(
          (
            await harness.request('PATCH', '/prefs', {
              body: { defaultVisibility: 'public' },
            })
          ).status,
        ).toBe(200)
      }
      const response = await post(
        webAnnotation({
          source: CHAPTER_ONE,
          parentId: bareId(parent),
          ...(mode === 'explicit' ? { visibility: 'public' as const } : {}),
        }),
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: 'parent_visibility_conflict' },
      })
      expect(await list(CHAPTER_ONE, null)).toEqual([])
      expect(await list(CHAPTER_ONE)).toHaveLength(1)
    },
  )

  it('keeps private replies to an owner private parent usable', async () => {
    const parent = await create('private')
    const reply = await create('private', bareId(parent))
    expect(reply['margin:parentId']).toBe(bareId(parent))
    expect(await list(CHAPTER_ONE, null)).toEqual([])
    expect(await list(CHAPTER_ONE, BOB)).toEqual([])
    expect(await list(CHAPTER_ONE)).toHaveLength(2)
  })

  it('rejects publishing an existing private reply to a private parent', async () => {
    const parent = await create('private')
    const reply = await create('private', bareId(parent))
    const response = await setVisibility(reply, 'public')
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'parent_visibility_conflict' },
    })
    expect(await list(CHAPTER_ONE, null)).toEqual([])
  })

  it('refuses to hide a parent with a public reply without changing either row', async () => {
    const parent = await create('public')
    const reply = await create('public', bareId(parent), BOB)
    const response = await setVisibility(parent, 'private')
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'has_visible_replies' },
    })
    expect((await list(CHAPTER_ONE, null)).map((row) => row.id)).toEqual([
      parent.id,
      reply.id,
    ])
  })

  it('refuses to hide a parent that another owner has privately replied to', async () => {
    const parent = await create('public')
    const reply = await create('private', bareId(parent), BOB)
    const response = await setVisibility(parent, 'private')
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'has_visible_replies' },
    })
    expect((await list(CHAPTER_ONE, BOB)).map((row) => row.id)).toEqual([
      parent.id,
      reply.id,
    ])
    expect(await list(CHAPTER_ONE, null)).toHaveLength(1)
  })

  it('keeps ownership checks ahead of visibility conflicts', async () => {
    const parent = await create('public')
    await create('public', bareId(parent), BOB)
    expect((await setVisibility(parent, 'private', BOB)).status).toBe(404)
  })

  it('allows an owner to hide a parent with only their private replies', async () => {
    const parent = await create('public')
    await create('private', bareId(parent))
    expect((await setVisibility(parent, 'private')).status).toBe(200)
    expect(await list(CHAPTER_ONE, null)).toEqual([])
    expect(await list(CHAPTER_ONE)).toHaveLength(2)
  })

  it('returns a conflict when a parent becomes private after the reply precheck', async () => {
    const parent = await create('public')
    const original = harness.repository.insertAnnotation.bind(
      harness.repository,
    )
    harness.repository.insertAnnotation = async (record) => {
      expect((await setVisibility(parent, 'private')).status).toBe(200)
      return original(record)
    }
    const response = await post(
      webAnnotation({
        source: CHAPTER_ONE,
        visibility: 'public',
        parentId: bareId(parent),
      }),
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'parent_visibility_conflict' },
    })
    expect(await list(CHAPTER_ONE, null)).toEqual([])
    expect(await list(CHAPTER_ONE)).toHaveLength(1)
  })

  it('rejects another owner private reply when the parent becomes private before insertion', async () => {
    const parent = await create('public')
    const original = harness.repository.insertAnnotation.bind(
      harness.repository,
    )
    harness.repository.insertAnnotation = async (record) => {
      expect((await setVisibility(parent, 'private')).status).toBe(200)
      return original(record)
    }
    const response = await post(
      webAnnotation({
        source: CHAPTER_ONE,
        visibility: 'private',
        parentId: bareId(parent),
      }),
      BOB,
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'unknown_parent' },
    })
    expect(await list(CHAPTER_ONE, BOB)).toEqual([])
    expect(await list(CHAPTER_ONE)).toHaveLength(1)
  })

  it('returns a conflict when a parent becomes private before a reply publication write', async () => {
    const parent = await create('public')
    const reply = await create('private', bareId(parent))
    const original = harness.repository.updateAnnotation.bind(
      harness.repository,
    )
    harness.repository.updateAnnotation = async (scope, id, owner, patch) => {
      if (id === bareId(reply)) {
        expect((await setVisibility(parent, 'private')).status).toBe(200)
      }
      return original(scope, id, owner, patch)
    }
    const response = await setVisibility(reply, 'public')
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'parent_visibility_conflict' },
    })
    expect(await list(CHAPTER_ONE, null)).toEqual([])
  })

  it('returns a conflict when a public reply arrives before a parent privacy write', async () => {
    const parent = await create('public')
    const original = harness.repository.updateAnnotation.bind(
      harness.repository,
    )
    harness.repository.updateAnnotation = async (scope, id, owner, patch) => {
      await create('public', bareId(parent), BOB)
      return original(scope, id, owner, patch)
    }
    const response = await setVisibility(parent, 'private')
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'has_visible_replies' },
    })
    expect(await list(CHAPTER_ONE, null)).toHaveLength(2)
  })
})
