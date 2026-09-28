import { expect, test, type Page } from '@playwright/test'
import type { Principal } from '../../src/worker/principal'
import { D1MarginRepository } from '../../src/worker/margin/d1-repository'
import { handleMarginRequest } from '../../src/worker/margin/routes'
import { SqliteD1Database } from '../../src/worker/margin/sqlite-database'
import { installStaticRoutes } from './static-build'

/**
 * Issue 058: threaded comments in the rail, on a real book page, with the real
 * router over a real SQLite database behind it — the harness
 * `margin-rail.spec.ts` uses. `service.as` stands in for the session cookie.
 *
 * Both principals carry an email, as a WorkOS session can, so the page can be
 * checked for never showing one.
 */

const CHAPTER = '/books/build-a-coding-agent/ch12-hash-maps/'
const RAIL = 'margin-rail'
const ENTRY = `${RAIL} li[data-margin-annotation]`
const REPLY = `${RAIL} li[data-margin-reply]`

const ADA: Principal = {
  provider: 'dev',
  issuer: 'urn:margin:dev',
  subject: 'ada',
  email: 'ada@lovelace.example',
}
const BOB: Principal = {
  provider: 'dev',
  issuer: 'urn:margin:dev',
  subject: 'bob',
  email: 'bob@babbage.example',
}

type Wire = {
  id: string
  body?: { value: string }
  target: unknown
  'margin:parentId'?: string
}

type Service = {
  as: Principal | null
  /** How many list requests the page has made. */
  lists: number
  /** Every list response body, as the browser received it. */
  bodies: string[]
  /** Hold every GET /prefs on this until it resolves. */
  holdPrefs: Promise<void> | null
  /** How many POST /annotations the page has made. */
  posts: number
  call(
    method: string,
    path: string,
    principal: Principal,
    body?: unknown,
  ): Promise<Response>
}

let documentUri = ''

async function mountService(page: Page): Promise<Service> {
  const repository = new D1MarginRepository(SqliteD1Database.inMemory())
  let clock = 0
  let sequence = 0
  const handle = (request: Request, principal: Principal | null) =>
    handleMarginRequest(request, {
      repository,
      principal,
      now: () => {
        clock += 1
        return new Date(Date.UTC(2026, 8, 28, 0, 0, 0, clock)).toISOString()
      },
      newId: () => {
        sequence += 1
        return `thread-${String(sequence).padStart(3, '0')}`
      },
    })

  const service: Service = {
    as: ADA,
    lists: 0,
    holdPrefs: null,
    posts: 0,
    bodies: [],
    call: (method, path, principal, body) =>
      handle(
        new Request(`https://ernie.sg/api/margin/v1${path}`, {
          method,
          ...(body === undefined
            ? {}
            : {
                body: JSON.stringify(body),
                headers: { 'content-type': 'application/json' },
              }),
        }),
        principal,
      ),
  }

  await page.route('**/api/margin/v1/**', async (route) => {
    const incoming = route.request()
    const method = incoming.method()
    const path = new URL(incoming.url()).pathname
    if (method === 'GET' && path.endsWith('/prefs') && service.holdPrefs) {
      await service.holdPrefs
    }
    if (method === 'POST' && path.endsWith('/annotations')) service.posts += 1
    const response = await handle(
      new Request(incoming.url(), {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'GET' || method === 'HEAD'
          ? {}
          : { body: incoming.postData() ?? undefined }),
      }),
      service.as,
    )
    const text = await response.text()
    if (
      method === 'GET' &&
      new URL(incoming.url()).pathname.endsWith('/annotations')
    ) {
      service.lists += 1
      service.bodies.push(text)
    }
    await route.fulfill({
      status: response.status,
      headers: { 'content-type': 'application/json' },
      body: text,
    })
  })
  return service
}

async function open(page: Page) {
  await installStaticRoutes(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(CHAPTER)
  await expect(
    page.locator(`${RAIL} [data-margin-action="keyboard-select"]`),
  ).toBeAttached()
  documentUri = (await page
    .locator(RAIL)
    .getAttribute('document-uri')) as string
}

/** The anchor `noteAsReader` makes: the first 24 characters of that block. */
async function firstAnchor(page: Page) {
  const block = await firstProseBlock(page)
  const exact = await page.evaluate(
    (id) => (document.getElementById(id)!.textContent ?? '').slice(0, 24),
    block,
  )
  return {
    nodeId: block,
    positionUnit: 'codepoint',
    position: { start: 0, end: 24 },
    quote: { exact, prefix: '', suffix: '' },
  }
}

async function firstProseBlock(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      Array.from(
        document.querySelectorAll('.book-content [data-block-kind="prose"]'),
      ).find((block) => (block.textContent ?? '').length > 120)!.id,
  )
}

/** A note by whoever `service.as` is, on the start of the first long block. */
async function noteAsReader(page: Page, service: Service, body: string) {
  const block = await firstProseBlock(page)
  await page.evaluate((blockId) => {
    const block = document.getElementById(blockId)!
    const point = (offset: number) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      let seen = 0
      let node = walker.nextNode() as Text | null
      while (node) {
        if (offset <= seen + node.data.length)
          return { node, offset: offset - seen }
        seen += node.data.length
        node = walker.nextNode() as Text | null
      }
      throw new Error(`offset ${offset} is past the end of ${blockId}`)
    }
    const from = point(0)
    const to = point(24)
    const range = document.createRange()
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }, block)
  await expect(
    page.locator(`${RAIL} [data-margin-action="highlight"]`),
  ).toBeEnabled()
  await page.evaluate((body) => {
    const rail = document.querySelector('margin-rail') as HTMLElement & {
      noteSelection(body: string): unknown[]
    }
    rail.noteSelection(body)
  }, body)
  await expect.poll(async () => (await rows(service)).length).toBeGreaterThan(0)
  return (await rows(service))[0]
}

async function rows(service: Service): Promise<Wire[]> {
  const response = await service.call(
    'GET',
    `/annotations?source=${encodeURIComponent(documentUri)}`,
    ADA,
  )
  return ((await response.json()) as { annotations: Wire[] }).annotations
}

async function reply(
  service: Service,
  parent: Wire,
  body: string,
  principal: Principal,
  visibility: 'public' | 'private' = 'public',
): Promise<Wire> {
  const response = await service.call('POST', '/annotations', principal, {
    type: 'Annotation',
    motivation: 'commenting',
    body: { type: 'TextualBody', value: body },
    target: parent.target,
    'margin:visibility': visibility,
    'margin:parentId': parent.id,
  })
  expect(response.status).toBe(201)
  return (await response.json()) as Wire
}

/** The focused element inside the rail's shadow root. */
async function focusedInRail(page: Page) {
  return page.evaluate(() => {
    const rail = document.querySelector('margin-rail')
    if (document.activeElement !== rail) return null
    const active = rail?.shadowRoot?.activeElement
    return {
      key: active?.getAttribute('data-focus-key') ?? null,
      reply: active?.getAttribute('data-margin-reply') ?? null,
    }
  })
}

async function tabTo(page: Page, key: string, limit = 800) {
  for (let presses = 0; presses < limit; presses += 1) {
    if ((await focusedInRail(page))?.key === key) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`Tab never reached ${key}`)
}

const bare = (id: string) => id.replace('urn:margin:annotation:', '')

test.describe('threaded comments in the margin', () => {
  test('a three-deep thread renders in order from one request and takes a keyboard reply', async ({
    page,
  }) => {
    const service = await mountService(page)
    await service.call('PATCH', '/prefs', BOB, { defaultVisibility: 'public' })
    await service.call('PATCH', '/prefs', ADA, { defaultVisibility: 'public' })
    service.as = BOB
    await open(page)
    const note = await noteAsReader(page, service, 'why an array?')
    const first = await reply(service, note, 'because of hashing', ADA)
    const second = await reply(service, first, 'what about collisions?', BOB)
    const third = await reply(service, second, 'chaining, here', ADA)

    service.as = ADA
    const before = service.lists
    await page.reload()
    await expect(page.locator(REPLY)).toHaveCount(3)
    // The thread came with the annotations: one list request, no follow-ups.
    expect(service.lists - before).toBe(1)

    await expect(page.locator(`${REPLY} .body`)).toHaveText([
      'because of hashing',
      'what about collisions?',
      'chaining, here',
    ])
    expect(
      await page.locator(REPLY).evaluateAll((items) =>
        items.map((item) => item.getAttribute('data-depth')),
      ),
    ).toEqual(['1', '2', '3'])

    // Display names, never an address — on screen or on the wire.
    const railText = await page.locator(RAIL).evaluate(
      (rail) => rail.shadowRoot?.textContent ?? '',
    )
    expect(railText).toContain('You')
    expect(railText).toMatch(/Reader [0-9A-Z]{5}/)
    for (const text of [railText, ...service.bodies]) {
      expect(text).not.toContain('lovelace')
      expect(text).not.toContain('babbage')
    }

    // Keyboard only: reply to the deepest reply.
    await page.locator(`${RAIL} [data-margin-search]`).focus()
    await tabTo(page, `reply:${bare(third.id)}`)
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => (await focusedInRail(page))?.key)
      .toBe(`reply-field:${bare(third.id)}`)
    await page.keyboard.type('and a fourth level')
    await tabTo(page, `reply-send:${bare(third.id)}`)
    await page.keyboard.press('Enter')

    await expect(page.locator(REPLY)).toHaveCount(4)
    const fourth = page.locator(REPLY).nth(3)
    await expect(fourth).toHaveAttribute('data-depth', '4')
    await expect(fourth.locator('.body')).toHaveText('and a fourth level')
    // Drawn at the indent cap, so it says what it answers.
    await expect(fourth.locator('[data-margin-in-reply-to]')).toHaveText(
      'Replying to you',
    )
    await expect
      .poll(async () => (await focusedInRail(page))?.reply)
      .toBe(await fourth.getAttribute('data-margin-reply'))

    // Each reply is addressable: a link to it focuses it.
    await page.goto(`${page.url().split('#')[0]}#margin-reply-${bare(second.id)}`)
    await expect(page.locator(REPLY)).toHaveCount(4)
    await expect
      .poll(async () => (await focusedInRail(page))?.reply)
      .toBe(bare(second.id))
  })

  test('a private reply is absent for a second reader while the note stays', async ({
    page,
  }) => {
    const service = await mountService(page)
    await service.call('PATCH', '/prefs', ADA, { defaultVisibility: 'public' })
    service.as = ADA
    await open(page)
    const note = await noteAsReader(page, service, 'a public note')
    await reply(service, note, 'bob, privately', BOB, 'private')

    service.as = BOB
    await page.reload()
    await expect(page.locator(REPLY)).toHaveCount(1)
    await expect(page.locator(`${REPLY} .body`)).toHaveText('bob, privately')

    service.as = null
    service.bodies.length = 0
    await page.reload()
    await expect(page.locator(ENTRY)).toHaveCount(1)
    await expect(page.locator(REPLY)).toHaveCount(0)
    for (const body of service.bodies) {
      expect(body).not.toContain('bob, privately')
    }
  })

  test('deleting a note with replies leaves a tombstone and the thread', async ({
    page,
  }) => {
    const service = await mountService(page)
    await service.call('PATCH', '/prefs', ADA, { defaultVisibility: 'public' })
    service.as = ADA
    await open(page)
    const note = await noteAsReader(page, service, 'soon gone')
    await reply(service, note, 'still here', BOB)
    await page.reload()
    await expect(page.locator(REPLY)).toHaveCount(1)

    await page.locator(`${ENTRY} [data-margin-action="delete"]`).click()
    await expect(page.locator(ENTRY)).toHaveCount(1)
    await expect(page.locator(`${ENTRY} > .body`)).toHaveText(
      'This note was deleted.',
    )
    await expect(page.locator(`${REPLY} .body`)).toHaveText('still here')

    service.as = BOB
    await page.reload()
    await expect(page.locator(`${ENTRY} > .body`)).toHaveText(
      'This note was deleted.',
    )
    await expect(page.locator(`${REPLY} .body`)).toHaveText('still here')
    // Bob cannot edit Ada's tombstone or anything else of hers, and his own
    // reply keeps its controls.
    await expect(
      page.locator(`${REPLY} [data-margin-action="reply-edit"]`),
    ).toHaveCount(1)
    expect((await rows(service)).map((row) => row.body?.value)).toEqual([
      undefined,
      'still here',
    ])
  })

  test('a reply the owner cannot see still tombstones the note, and its text is purged locally', async ({
    page,
  }) => {
    const service = await mountService(page)
    await service.call('PATCH', '/prefs', ADA, { defaultVisibility: 'public' })
    service.as = ADA
    await open(page)
    const note = await noteAsReader(page, service, 'secret words')
    // Bob answers privately: Ada's rail never sees it, but the service does.
    await reply(service, note, 'bob, privately', BOB, 'private')
    await page.reload()
    await expect(page.locator(REPLY)).toHaveCount(0)

    await page.locator(`${ENTRY} [data-margin-action="delete"]`).click()
    // The service tombstoned it, so the entry stays, as a tombstone, now.
    await expect(page.locator(`${ENTRY} > .body`)).toHaveText(
      'This note was deleted.',
    )
    const local = await page.locator(RAIL).evaluate((rail) => {
      const element = rail as HTMLElement & {
        annotations: readonly { kind: string; body?: string }[]
      }
      return JSON.stringify(element.annotations)
    })
    expect(local).not.toContain('secret words')
    // Search no longer finds the deleted text either.
    await page.locator(`${RAIL} [data-margin-search]`).fill('secret')
    await expect(page.locator(ENTRY)).toHaveCount(0)
    await page.locator(`${RAIL} [data-margin-search]`).fill('')
    // And a reload agrees with what was shown.
    await page.reload()
    await expect(page.locator(`${ENTRY} > .body`)).toHaveText(
      'This note was deleted.',
    )
  })

  test('a host-cached note the service has since tombstoned loses its cached text', async ({
    page,
  }) => {
    const service = await mountService(page)
    await service.call('PATCH', '/prefs', ADA, { defaultVisibility: 'public' })
    service.as = ADA
    await open(page)
    const note = await noteAsReader(page, service, 'cached words')
    await reply(service, note, 'keeps it alive', BOB)
    // Tombstoned elsewhere: another tab, another device.
    const deleted = await service.call(
      'DELETE',
      `/annotations/${bare(note.id)}?source=${encodeURIComponent(documentUri)}`,
      ADA,
    )
    expect(deleted.status).toBe(200)

    // A host that cached the note hands it to a fresh rail under the
    // service's id, before that rail's first load matches it by that id.
    await page.reload()
    await expect(page.locator(REPLY)).toHaveCount(1)
    const target = await firstAnchor(page)
    await page.evaluate(
      ({ id, target }) => {
        const old = document.querySelector('margin-rail')!
        const fresh = document.createElement('margin-rail') as HTMLElement & {
          annotations: unknown
        }
        for (const { name, value } of Array.from(old.attributes)) {
          fresh.setAttribute(name, value)
        }
        fresh.annotations = [
          { id, kind: 'note', target, body: 'cached words', geometryCache: [] },
        ]
        old.replaceWith(fresh)
      },
      { id: bare(note.id), target },
    )
    await expect(page.locator(REPLY)).toHaveCount(1)
    await expect(page.locator(`${ENTRY} > .body`)).toHaveText(
      'This note was deleted.',
    )
    const local = await page.locator(RAIL).evaluate((rail) =>
      JSON.stringify((rail as HTMLElement & { annotations: unknown }).annotations),
    )
    expect(local).not.toContain('cached words')
  })

  test('a root note shows its author by display name', async ({ page }) => {
    const service = await mountService(page)
    await service.call('PATCH', '/prefs', ADA, { defaultVisibility: 'public' })
    service.as = ADA
    await open(page)
    await noteAsReader(page, service, 'started by ada')

    service.as = BOB
    await page.reload()
    const author = page.locator(`${ENTRY} [data-margin-author]`)
    await expect(author).toHaveText(/^Reader [0-9A-Z]{5}$/)
    service.as = ADA
    await page.reload()
    await expect(author).toHaveText('You')
  })

  test('a reply waiting on preferences is not sent through a connection that changed', async ({
    page,
  }) => {
    const service = await mountService(page)
    await service.call('PATCH', '/prefs', ADA, { defaultVisibility: 'public' })
    service.as = ADA
    await open(page)
    const note = await noteAsReader(page, service, 'answer me')
    await page.reload()
    await expect(page.locator(ENTRY)).toHaveCount(1)

    let release!: () => void
    service.holdPrefs = new Promise<void>((resolve) => {
      release = resolve
    })
    // A reload of the same connection starts a new preferences read, which
    // the reply below has to wait for.
    await page.locator(RAIL).evaluate((rail) => {
      const element = rail as HTMLElement & { transport: unknown }
      element.transport = element.transport
    })
    const postsBefore = service.posts
    const sent = page.locator(RAIL).evaluate(
      (rail, parentId) =>
        (rail as HTMLElement & {
          reply(id: string, body: string): Promise<boolean>
        }).reply(parentId, 'sent to the wrong place?'),
      bare(note.id),
    )
    // The connection changes while the reply waits.
    await page.locator(RAIL).evaluate((rail) => {
      rail.setAttribute('api-base', '/api/margin/v1/')
    })
    release()
    service.holdPrefs = null
    expect(await sent).toBe(false)
    expect(service.posts).toBe(postsBefore)
    expect((await rows(service)).map((row) => row.body?.value)).toEqual([
      'answer me',
    ])
  })

  test('a tombstone can be deleted for good once its replies are gone', async ({
    page,
  }) => {
    const service = await mountService(page)
    await service.call('PATCH', '/prefs', ADA, { defaultVisibility: 'public' })
    service.as = ADA
    await open(page)
    const note = await noteAsReader(page, service, 'soon a tombstone')
    const answer = await reply(service, note, 'short-lived', BOB)
    await page.reload()
    await page.locator(`${ENTRY} [data-margin-action="delete"]`).click()
    await expect(page.locator(`${ENTRY} > .body`)).toHaveText(
      'This note was deleted.',
    )
    // A tombstone takes no edits and no visibility change, but keeps Delete.
    await expect(
      page.locator(`${ENTRY} [data-margin-action="edit"]`),
    ).toHaveCount(0)
    await expect(
      page.locator(`${ENTRY} [data-margin-action="visibility"]`),
    ).toHaveCount(0)
    await expect(
      page.locator(`${ENTRY} [data-margin-action="delete"]`),
    ).toHaveCount(1)

    expect(
      (await service.call('DELETE', `/annotations/${bare(answer.id)}?source=${encodeURIComponent(documentUri)}`, BOB)).status,
    ).toBe(204)
    await page.reload()
    await page.locator(`${ENTRY} [data-margin-action="delete"]`).click()
    await expect(page.locator(ENTRY)).toHaveCount(0)
    expect(await rows(service)).toEqual([])
  })
})
