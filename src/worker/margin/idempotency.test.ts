import { describe, expect, it } from 'vitest'
import { handleMarginRequest, MARGIN_API_PREFIX } from './routes'
import {
  ADA,
  ADA_KEY,
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

function receiptCount(harness: MarginHarness): number {
  return Number(
    harness.database.query('SELECT COUNT(*) AS count FROM margin_idempotency_receipts')[0]
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
    expect(
      (
        await request('PATCH', '/prefs', {
          body: { defaultVisibility: 'public' },
        })
      ).status,
    ).toBe(200)
    // JSON member order is not part of a request's semantics.
    const reordered = {
      target: body.target,
      body: body.body,
      motivation: body.motivation,
      type: body.type,
      '@context': body['@context'],
      'margin:visibility': body['margin:visibility'],
    }
    const retry = await request('POST', '/annotations', { body: reordered, key: KEY })

    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({
      id: expect.stringMatching(/^urn:margin:annotation:request-[a-f0-9]{64}$/),
    })
    expect(annotationCount(harness)).toBe(1)
    expect(receiptCount(harness)).toBe(1)
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
        if (property === 'insertAnnotationWithReceipt') {
          return async (
            ...args: Parameters<MarginRepository['insertAnnotationWithReceipt']>
          ) => {
            entered += 1
            if (entered === 2) release()
            await gate
            return target.insertAnnotationWithReceipt(...args)
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
    expect(receiptCount(harness)).toBe(1)
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

  it('consumes a key permanently when its annotation is deleted', async () => {
    const harness = createHarness()
    const request = requestFor(harness)
    const body = webAnnotation({ source: CHAPTER_ONE, body: 'first' })
    const created = await request('POST', '/annotations', { body, key: KEY })
    const { id } = (await created.json()) as { id: string }
    const deleted = await request(
      'DELETE',
      `/annotations/${encodeURIComponent(id)}?source=${encodeURIComponent(CHAPTER_ONE)}`,
    )
    expect(deleted.status).toBe(204)

    const replay = await request('POST', '/annotations', { body, key: KEY })
    expect(replay.status).toBe(409)
    await expect(replay.json()).resolves.toMatchObject({
      error: { code: 'idempotency_consumed' },
    })
    const changed = await request('POST', '/annotations', {
      body: webAnnotation({ source: CHAPTER_ONE, body: 'changed' }),
      key: KEY,
    })
    expect(changed.status).toBe(409)
    await expect(changed.json()).resolves.toMatchObject({
      error: { code: 'idempotency_conflict' },
    })
    expect(annotationCount(harness)).toBe(0)
  })

  it('rolls back the annotation when receipt insertion fails in its batch', async () => {
    const harness = createHarness()
    const request = requestFor(harness)
    const created = await request('POST', '/annotations', {
      body: webAnnotation({ source: CHAPTER_ONE }),
    })
    const { id } = (await created.json()) as { id: string }
    const scope = { site: 'https://ernie.sg', document: '/challenges/chapter-1' }
    const stored = await harness.repository.findAnnotation(
      scope,
      id.replace('urn:margin:annotation:', ''),
      ADA_KEY,
    )
    expect(stored).not.toBeNull()
    const rollbackId = 'receipt-batch-rollback'
    const candidate = {
      ...stored!,
      id: rollbackId,
      annotation: { ...stored!.annotation, id: rollbackId },
    }
    harness.database.execute(
      `INSERT INTO margin_idempotency_receipts
      (creator, site, document, request_key, fingerprint, annotation_id, created)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ADA_KEY, scope.site, scope.document, KEY, 'earlier', 'earlier-id', stored!.created],
    )

    await expect(
      harness.repository.insertAnnotationWithReceipt(candidate, {
        key: KEY,
        fingerprint: 'new-fingerprint',
      }),
    ).rejects.toThrow()
    expect(
      harness.database.query('SELECT id FROM margin_annotations WHERE id = ?', [rollbackId]),
    ).toEqual([])
    expect(receiptCount(harness)).toBe(1)
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
