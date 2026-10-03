import { describe, expect, it } from 'vitest'
import { handleMarginRequest, MARGIN_API_PREFIX } from './routes'
import {
  ADA,
  BOB,
  CHAPTER_ONE,
  OTHER_SITE,
  createHarness,
  webAnnotation,
} from './fixtures'
import type { MarginHarness } from './fixtures'
import type { MarginRepository } from './repository'

const KEY = '123e4567-e89b-42d3-a456-426614174000'

function requestFor(
  harness: MarginHarness,
  repository: MarginRepository = harness.repository,
) {
  let clock = 0
  let sequence = 0
  return async (
    method: string,
    path: string,
    options: {
      as?: typeof ADA | typeof BOB | null
      body?: unknown
      key?: string
    } = {},
  ) => {
    const headers = new Headers()
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    if (options.key !== undefined) headers.set('Idempotency-Key', options.key)
    return handleMarginRequest(
      new Request(`https://ernie.sg${MARGIN_API_PREFIX}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
      {
        repository,
        principal: options.as === undefined ? ADA : options.as,
        now: () => {
          clock += 1
          return new Date(Date.UTC(2026, 8, 22, 0, 0, clock)).toISOString()
        },
        newId: () => `test-${++sequence}`,
      },
    )
  }
}

function annotationCount(harness: MarginHarness): number {
  return Number(
    harness.database.query('SELECT COUNT(*) AS count FROM margin_annotations')[0]
      .count,
  )
}

describe('annotation creation idempotency', () => {
  it('returns the existing row when a committed response is lost and retried', async () => {
    const harness = createHarness()
    const request = requestFor(harness)
    const body = webAnnotation({ source: CHAPTER_ONE, visibility: 'private' })

    const first = await request('POST', '/annotations', { body, key: KEY })
    // Simulate the client losing this successful response before it can read it.
    expect(first.status).toBe(201)
    const retry = await request('POST', '/annotations', { body, key: KEY })

    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({
      id: expect.stringMatching(/^urn:margin:annotation:request-[a-f0-9]{64}$/),
    })
    expect(annotationCount(harness)).toBe(1)
  })

  it('atomically converges simultaneous retries on one row', async () => {
    const harness = createHarness()
    let entered = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const repository = new Proxy(harness.repository, {
      get(target, property, receiver) {
        if (property === 'insertAnnotation') {
          return async (...args: Parameters<MarginRepository['insertAnnotation']>) => {
            entered += 1
            if (entered === 2) release()
            await gate
            return target.insertAnnotation(...args)
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as MarginRepository
    const request = requestFor(harness, repository)
    const body = webAnnotation({ source: CHAPTER_ONE })

    const responses = await Promise.all([
      request('POST', '/annotations', { body, key: KEY }),
      request('POST', '/annotations', { body, key: KEY }),
    ])

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201])
    expect(annotationCount(harness)).toBe(1)
  })

  it('refuses a changed request body for a previously used key', async () => {
    const harness = createHarness()
    const request = requestFor(harness)
    await request('POST', '/annotations', {
      body: webAnnotation({ source: CHAPTER_ONE, body: 'first' }),
      key: KEY,
    })
    const changed = await request('POST', '/annotations', {
      body: webAnnotation({ source: CHAPTER_ONE, body: 'changed' }),
      key: KEY,
    })

    expect(changed.status).toBe(409)
    await expect(changed.json()).resolves.toMatchObject({
      error: { code: 'idempotency_conflict' },
    })
    expect(annotationCount(harness)).toBe(1)
  })

  it('keeps reused keys isolated by owner and canonical source', async () => {
    const harness = createHarness()
    const request = requestFor(harness)
    const ada = await request('POST', '/annotations', {
      body: webAnnotation({ source: CHAPTER_ONE, visibility: 'private' }),
      key: KEY,
    })
    const bob = await request('POST', '/annotations', {
      as: BOB,
      body: webAnnotation({ source: CHAPTER_ONE, visibility: 'private' }),
      key: KEY,
    })
    const otherSite = await request('POST', '/annotations', {
      body: webAnnotation({ source: OTHER_SITE, visibility: 'private' }),
      key: KEY,
    })

    const adaBody = (await ada.json()) as { id: string }
    const bobBody = (await bob.json()) as { id: string }
    const otherBody = (await otherSite.json()) as { id: string }
    expect(new Set([adaBody.id, bobBody.id, otherBody.id]).size).toBe(3)
    const unreadable = await request(
      'GET',
      `/annotations/${encodeURIComponent(adaBody.id)}?source=${encodeURIComponent(CHAPTER_ONE)}`,
      { as: BOB },
    )
    expect(unreadable.status).toBe(404)
    expect(annotationCount(harness)).toBe(3)
  })

  it('rejects malformed keys without inserting a row', async () => {
    const harness = createHarness()
    const response = await requestFor(harness)('POST', '/annotations', {
      body: webAnnotation({ source: CHAPTER_ONE }),
      key: 'not-a-uuid',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_idempotency_key' },
    })
    expect(annotationCount(harness)).toBe(0)
  })

  it('preserves distinct creation for requests without a key', async () => {
    const harness = createHarness()
    const request = requestFor(harness)
    const body = webAnnotation({ source: CHAPTER_ONE })
    const first = await request('POST', '/annotations', { body })
    const second = await request('POST', '/annotations', { body })

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect((await first.json()).id).not.toBe((await second.json()).id)
    expect(annotationCount(harness)).toBe(2)
  })
})
