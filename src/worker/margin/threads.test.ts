import { beforeEach, describe, expect, it } from 'vitest'
import type { Principal } from '../principal'
import {
  ADA,
  BOB,
  CHAPTER_ONE,
  createHarness,
  scopeQuery,
  webAnnotation,
  type MarginHarness,
} from './fixtures'
import { DISPLAY_NAME_PREFIX, displayNameFor } from './participants'
import { TOMBSTONE_BODY } from './web-annotation'

/**
 * Issue 058's acceptance tests for threaded comments, against the real router
 * over a real SQLite database built from the real migration.
 */

type Wire = {
  id: string
  motivation: string
  body?: { value: string }
  target: { selector: { type: string; exact?: string }[] }
  creator: string
  created: string
  modified: string
  'margin:visibility': string
  'margin:parentId'?: string
  'margin:creatorName'?: string
  'margin:deleted'?: true
}

/** Principals that carry an email, the way a WorkOS session can. */
const ADA_MAILED: Principal = { ...ADA, email: 'ada@lovelace.example' }
const BOB_MAILED: Principal = { ...BOB, email: 'bob@babbage.example' }
const CAROL: Principal = {
  provider: 'dev',
  issuer: 'urn:margin:dev',
  subject: 'carol',
  email: 'carol@herschel.example',
}

let harness: MarginHarness

beforeEach(() => {
  harness = createHarness()
})

const bareId = (wire: Wire) => wire.id.replace('urn:margin:annotation:', '')

/** A note on its own passage, so a test can look for that passage by text. */
function note(options: {
  body: string
  visibility?: 'private' | 'public'
  parentId?: string
  quote?: string
}) {
  const base = webAnnotation({
    source: CHAPTER_ONE,
    body: options.body,
    visibility: options.visibility,
    parentId: options.parentId,
  })
  if (!options.quote) return base
  const quote = options.quote
  return {
    ...base,
    target: {
      ...base.target,
      selector: [
        { type: 'TextQuoteSelector', exact: quote },
        { type: 'TextPositionSelector', start: 0, end: quote.length },
      ],
    },
  }
}

async function create(body: unknown, as: Principal): Promise<Wire> {
  const response = await harness.request('POST', '/annotations', { as, body })
  expect(response.status, await response.clone().text()).toBe(201)
  return (await response.json()) as Wire
}

async function listText(as: Principal | null) {
  const response = await harness.request(
    'GET',
    `/annotations${scopeQuery(CHAPTER_ONE)}`,
    { as },
  )
  expect(response.status).toBe(200)
  return response.text()
}

async function list(as: Principal | null): Promise<Wire[]> {
  return (JSON.parse(await listText(as)) as { annotations: Wire[] })
    .annotations
}

function item(id: string) {
  return `/annotations/${encodeURIComponent(id)}${scopeQuery(CHAPTER_ONE)}`
}

describe('threads', () => {
  it('returns a three-deep thread in order from one request and one query', async () => {
    const root = await create(
      note({ body: 'root', visibility: 'public' }),
      ADA,
    )
    const first = await create(
      note({ body: 'first', visibility: 'public', parentId: root.id }),
      BOB,
    )
    const second = await create(
      note({ body: 'second', visibility: 'public', parentId: first.id }),
      ADA,
    )
    const third = await create(
      note({ body: 'third', visibility: 'public', parentId: second.id }),
      BOB,
    )
    const sibling = await create(
      note({ body: 'sibling', visibility: 'public', parentId: root.id }),
      CAROL,
    )

    harness.database.executed.length = 0
    const thread = await list(CAROL)
    // One statement: the thread is the list, not a query per reply.
    expect(harness.database.reads()).toHaveLength(1)
    expect(harness.database.executed).toHaveLength(1)

    expect(thread.map((entry) => entry.body?.value)).toEqual([
      'root',
      'first',
      'second',
      'third',
      'sibling',
    ])
    expect(thread.map((entry) => entry['margin:parentId'] ?? null)).toEqual([
      null,
      bareId(root),
      bareId(first),
      bareId(second),
      bareId(root),
    ])
    // Stable: created ascending, and the order never changes between reads.
    const created = thread.map((entry) => entry.created)
    expect([...created].sort()).toEqual(created)
    expect((await list(CAROL)).map((entry) => entry.id)).toEqual(
      [root, first, second, third, sibling].map((entry) => entry.id),
    )
  })

  it('does not issue more queries as a thread gets deeper', async () => {
    let parent = await create(note({ body: 'root', visibility: 'public' }), ADA)
    for (let depth = 0; depth < 12; depth += 1) {
      parent = await create(
        note({
          body: `depth ${depth}`,
          visibility: 'public',
          parentId: parent.id,
        }),
        depth % 2 ? ADA : BOB,
      )
    }
    harness.database.executed.length = 0
    expect(await list(null)).toHaveLength(13)
    expect(harness.database.executed).toHaveLength(1)
  })

  it('only threads notes under notes', async () => {
    const highlight = await create(
      webAnnotation({
        source: CHAPTER_ONE,
        motivation: 'highlighting',
        visibility: 'public',
      }),
      ADA,
    )
    const toHighlight = await harness.request('POST', '/annotations', {
      as: BOB,
      body: note({ body: 'on a highlight', parentId: highlight.id }),
    })
    expect(toHighlight.status).toBe(400)
    expect(await toHighlight.json()).toMatchObject({
      error: { code: 'invalid_reply' },
    })

    const root = await create(note({ body: 'root', visibility: 'public' }), ADA)
    const highlightReply = await harness.request('POST', '/annotations', {
      as: BOB,
      body: {
        ...webAnnotation({
          source: CHAPTER_ONE,
          motivation: 'highlighting',
          parentId: root.id,
        }),
      },
    })
    expect(highlightReply.status).toBe(400)
    expect(await highlightReply.json()).toMatchObject({
      error: { code: 'invalid_reply' },
    })
  })
})

describe('thread visibility', () => {
  it('hides a private reply to a public note from a second reader, keeping the note', async () => {
    const root = await create(
      note({ body: 'a public note', visibility: 'public' }),
      ADA,
    )
    await create(
      note({
        body: 'bob thinks privately',
        visibility: 'private',
        parentId: root.id,
      }),
      BOB,
    )

    const forCarol = await list(CAROL)
    expect(forCarol.map((entry) => entry.body?.value)).toEqual([
      'a public note',
    ])
    expect(await listText(CAROL)).not.toContain('bob thinks privately')
    expect((await list(null)).map((entry) => entry.id)).toEqual([root.id])
    expect((await list(BOB)).map((entry) => entry.body?.value)).toEqual([
      'a public note',
      'bob thinks privately',
    ])
  })

  it('refuses a public reply to a private note, even from its owner', async () => {
    const root = await create(
      note({ body: 'kept', visibility: 'private' }),
      ADA,
    )
    const response = await harness.request('POST', '/annotations', {
      as: ADA,
      body: note({ body: 'loud', visibility: 'public', parentId: root.id }),
    })
    expect(response.status).toBe(400)
    expect(await list(null)).toEqual([])
  })

  it('removes a parent made private, quote and all, from a non-owner response', async () => {
    const quote = 'a sentence only the parent quotes'
    const root = await create(
      note({ body: 'ada notes', visibility: 'public', quote }),
      ADA,
    )
    const reply = await create(
      note({
        body: 'ada replies to herself',
        visibility: 'public',
        parentId: root.id,
        quote,
      }),
      ADA,
    )
    expect(await listText(BOB)).toContain(quote)

    // While a reply another reader can see hangs from it, the parent stays
    // public: the reply cannot outlive its readers' access to the quote.
    const refused = await harness.request('PATCH', item(root.id), {
      as: ADA,
      body: { 'margin:visibility': 'private' },
    })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({
      error: { code: 'has_visible_replies' },
    })
    expect(await listText(BOB)).toContain(quote)

    // Hide the reply, then the parent: now neither row, nor any reply
    // payload, nor the quote they share reaches Bob or an anonymous reader.
    for (const target of [reply, root]) {
      const response = await harness.request('PATCH', item(target.id), {
        as: ADA,
        body: { 'margin:visibility': 'private' },
      })
      expect(response.status).toBe(200)
    }
    for (const reader of [BOB, null]) {
      const text = await listText(reader)
      expect(text).not.toContain(quote)
      expect(JSON.parse(text)).toEqual({ annotations: [] })
    }
    const direct = await harness.request('GET', item(reply.id), { as: BOB })
    expect(direct.status).toBe(404)
    expect(await direct.text()).not.toContain(quote)
    expect(await list(ADA)).toHaveLength(2)
  })

  it('keeps a parent public while another reader has replied, even privately', async () => {
    const root = await create(note({ body: 'root', visibility: 'public' }), ADA)
    await create(
      note({ body: 'bob, privately', visibility: 'private', parentId: root.id }),
      BOB,
    )
    const response = await harness.request('PATCH', item(root.id), {
      as: ADA,
      body: { 'margin:visibility': 'private' },
    })
    expect(response.status).toBe(409)
    // Bob still sees what he replied to.
    expect((await list(BOB)).map((entry) => entry.body?.value)).toEqual([
      'root',
      'bob, privately',
    ])
  })

  it('answers a reply to an unreadable note exactly as a reply to no note', async () => {
    const hidden = await create(
      note({ body: 'ada only', visibility: 'private' }),
      ADA,
    )
    const toHidden = await harness.request('POST', '/annotations', {
      as: BOB,
      body: note({ body: 'hello?', visibility: 'private', parentId: hidden.id }),
    })
    const toNothing = await harness.request('POST', '/annotations', {
      as: BOB,
      body: note({
        body: 'hello?',
        visibility: 'private',
        parentId: 'urn:margin:annotation:never-issued',
      }),
    })
    expect(toHidden.status).toBe(404)
    expect(toNothing.status).toBe(404)
    expect(await toHidden.text()).toBe(await toNothing.text())
    expect(await list(BOB)).toEqual([])
  })
})

describe('editing replies', () => {
  it('lets an author edit their own reply and records the modified time', async () => {
    const root = await create(note({ body: 'root', visibility: 'public' }), ADA)
    const reply = await create(
      note({ body: 'first try', visibility: 'public', parentId: root.id }),
      BOB,
    )
    const response = await harness.request('PATCH', item(reply.id), {
      as: BOB,
      body: { body: 'second try' },
    })
    expect(response.status).toBe(200)
    const edited = (await response.json()) as Wire
    expect(edited.body?.value).toBe('second try')
    expect(edited.created).toBe(reply.created)
    expect(edited.modified > reply.modified).toBe(true)
    expect(edited['margin:parentId']).toBe(bareId(root))
  })

  it("refuses another reader's reply with a 403 at the API", async () => {
    const root = await create(note({ body: 'root', visibility: 'public' }), ADA)
    const reply = await create(
      note({ body: 'bob said this', visibility: 'public', parentId: root.id }),
      BOB,
    )
    for (const body of [
      { body: 'ada rewrites it' },
      { 'margin:visibility': 'private' },
    ]) {
      const response = await harness.request('PATCH', item(reply.id), {
        as: ADA,
        body,
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({
        error: { code: 'forbidden' },
      })
    }
    expect(
      (await list(null)).find((entry) => entry.id === reply.id)?.body?.value,
    ).toBe('bob said this')
  })

  it('keeps a reply the caller cannot read a 404, not a 403', async () => {
    const root = await create(note({ body: 'root', visibility: 'public' }), ADA)
    const reply = await create(
      note({ body: 'private', visibility: 'private', parentId: root.id }),
      BOB,
    )
    const response = await harness.request('PATCH', item(reply.id), {
      as: ADA,
      body: { body: 'guess' },
    })
    expect(response.status).toBe(404)
  })
})

describe('deleting a note with replies', () => {
  // The documented choice (packages/margin/README.md): tombstone, not cascade.
  it('tombstones the note and keeps every reply readable', async () => {
    const root = await create(
      note({ body: 'the question', visibility: 'public' }),
      ADA,
    )
    const reply = await create(
      note({ body: 'the answer', visibility: 'public', parentId: root.id }),
      BOB,
    )
    const nested = await create(
      note({ body: 'a follow-up', visibility: 'public', parentId: reply.id }),
      CAROL,
    )

    const deleted = await harness.request('DELETE', item(root.id), { as: ADA })
    expect(deleted.status).toBe(204)

    for (const reader of [null, BOB, ADA]) {
      const thread = await list(reader)
      expect(thread.map((entry) => entry.id)).toEqual([
        root.id,
        reply.id,
        nested.id,
      ])
      expect(thread[0]).toMatchObject({ 'margin:deleted': true })
      expect(thread[0].body).toBeUndefined()
      expect(thread[1].body?.value).toBe('the answer')
      expect(thread[2]['margin:parentId']).toBe(bareId(reply))
    }
    expect(await listText(null)).not.toContain('the question')
    expect(await listText(null)).not.toContain(TOMBSTONE_BODY)

    // The tombstone can still be replied to, and cannot be edited back.
    await create(
      note({ body: 'still talking', visibility: 'public', parentId: root.id }),
      BOB,
    )
    const revived = await harness.request('PATCH', item(root.id), {
      as: ADA,
      body: { body: 'undeleted' },
    })
    expect(revived.status).toBe(409)
    expect(await revived.json()).toMatchObject({ error: { code: 'deleted' } })

    // Deleting it again changes nothing while the thread hangs from it.
    expect(
      (await harness.request('DELETE', item(root.id), { as: ADA })).status,
    ).toBe(204)
    expect(await list(null)).toHaveLength(4)
  })

  it('removes a tombstone for good once nothing hangs from it', async () => {
    const root = await create(note({ body: 'root', visibility: 'public' }), ADA)
    const reply = await create(
      note({ body: 'reply', visibility: 'public', parentId: root.id }),
      BOB,
    )
    expect(
      (await harness.request('DELETE', item(root.id), { as: ADA })).status,
    ).toBe(204)
    expect(
      (await harness.request('DELETE', item(reply.id), { as: BOB })).status,
    ).toBe(204)
    expect(await list(null)).toHaveLength(1)
    expect(
      (await harness.request('DELETE', item(root.id), { as: ADA })).status,
    ).toBe(204)
    expect(await list(null)).toEqual([])
  })

  it('deletes a reply with nothing under it outright', async () => {
    const root = await create(note({ body: 'root', visibility: 'public' }), ADA)
    const reply = await create(
      note({ body: 'reply', visibility: 'public', parentId: root.id }),
      BOB,
    )
    expect(
      (await harness.request('DELETE', item(reply.id), { as: BOB })).status,
    ).toBe(204)
    expect((await list(null)).map((entry) => entry.id)).toEqual([root.id])
  })

  it('refuses the tombstone value as a body', async () => {
    const response = await harness.request('POST', '/annotations', {
      as: ADA,
      body: note({ body: TOMBSTONE_BODY }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'reserved_body' },
    })
  })

  it('refuses the tombstone value as an edit, so a note cannot fake its own deletion', async () => {
    const own = await create(note({ body: 'ada notes' }), ADA)
    const response = await harness.request('PATCH', item(own.id), {
      as: ADA,
      body: { body: TOMBSTONE_BODY },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'reserved_body' },
    })
    expect(await listText(ADA)).toContain('ada notes')
  })
})

describe('participants', () => {
  it('names every participant by display name and never by email', async () => {
    const root = await create(
      note({ body: 'root', visibility: 'public' }),
      ADA_MAILED,
    )
    const reply = await create(
      note({ body: 'reply', visibility: 'public', parentId: root.id }),
      BOB_MAILED,
    )
    await create(
      note({ body: 'nested', visibility: 'public', parentId: reply.id }),
      CAROL,
    )
    await harness.request('DELETE', item(root.id), { as: ADA_MAILED })

    const responses = [
      await listText(null),
      await listText(BOB_MAILED),
      await (
        await harness.request('GET', item(reply.id), { as: CAROL })
      ).text(),
      await (
        await harness.request('PATCH', item(reply.id), {
          as: BOB_MAILED,
          body: { body: 'edited' },
        })
      ).text(),
    ]
    for (const text of responses) {
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/)
      for (const address of ['lovelace', 'babbage', 'herschel']) {
        expect(text).not.toContain(address)
      }
    }

    const thread = await list(null)
    const names = thread.map((entry) => entry['margin:creatorName'])
    expect(names).toEqual(
      thread.map((entry) => displayNameFor(entry.creator)),
    )
    expect(new Set(names).size).toBe(3)
    for (const name of names) {
      expect(name).toMatch(new RegExp(`^${DISPLAY_NAME_PREFIX} [0-9A-Z]{5}$`))
    }
  })
})
