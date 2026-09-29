import { beforeEach, describe, expect, it } from 'vitest'

import {
  ADA,
  BASE_COMMIT,
  BOB,
  CHAPTER_ONE,
  createHarness,
  proposalBody,
  scopeQuery,
  webAnnotation,
  type MarginHarness,
} from './fixtures'
import { insertAnnotationQuery } from './queries'

/**
 * Edit proposals name the text they change (issue 059): a full base commit, a
 * repo-relative source file, a revision a review binds to, and withdrawal that
 * takes a proposal out of review without deleting it.
 */

type Wire = {
  id: string
  motivation: string
  body?: { value: string }
  'margin:baseCommit'?: string
  'margin:sourcePath'?: string
  'margin:revision'?: number
  'margin:withdrawnAt'?: string
}

let harness: MarginHarness

beforeEach(() => {
  harness = createHarness()
})

const NEWER = 'b'.repeat(40)
const SHA256 = 'c'.repeat(64)

function post(body: unknown, as = ADA) {
  return harness.request('POST', '/annotations', { as, body })
}

function bareId(wire: Wire): string {
  return wire.id.replace('urn:margin:annotation:', '')
}

async function createProposal(overrides: Parameters<typeof webAnnotation>[0] | object = {}) {
  const response = await post({
    ...webAnnotation({ source: CHAPTER_ONE, motivation: 'editing' }),
    ...overrides,
  })
  expect(response.status).toBe(201)
  return (await response.json()) as Wire
}

function patch(id: string, body: unknown, as = ADA) {
  return harness.request('PATCH', `/annotations/${id}${scopeQuery(CHAPTER_ONE)}`, {
    as,
    body,
  })
}

function withdraw(id: string, as = ADA) {
  return harness.request(
    'POST',
    `/proposals/${id}/withdraw${scopeQuery(CHAPTER_ONE)}`,
    { as },
  )
}

async function reviewListing(as = ADA): Promise<Wire[]> {
  const response = await harness.request('GET', `/proposals${scopeQuery(CHAPTER_ONE)}`, { as })
  expect(response.status).toBe(200)
  return ((await response.json()) as { annotations: Wire[] }).annotations
}

describe('creating a proposal', () => {
  it('stores and returns its base commit, source file and revision 1', async () => {
    const created = await createProposal()
    expect(created['margin:baseCommit']).toBe(BASE_COMMIT)
    expect(created['margin:sourcePath']).toBe('books/chapters/ch01-values.md')
    expect(created['margin:revision']).toBe(1)
    expect(created['margin:withdrawnAt']).toBeUndefined()
    const read = await harness.request(
      'GET',
      `/annotations/${bareId(created)}${scopeQuery(CHAPTER_ONE)}`,
      { as: ADA },
    )
    expect(await read.json()).toMatchObject({
      'margin:baseCommit': BASE_COMMIT,
      'margin:revision': 1,
    })
  })

  it('accepts a SHA-256 base commit', async () => {
    const created = await createProposal({ 'margin:baseCommit': SHA256 })
    expect(created['margin:baseCommit']).toBe(SHA256)
  })

  it.each([
    ['missing', undefined],
    ['the dev server stamp', 'dirty'],
    ['the incomplete-history stamp', 'unavailable'],
    ['an abbreviated commit', 'abcdef1'],
    ['an upper-case commit', 'A'.repeat(40)],
    ['a 41-character id', 'a'.repeat(41)],
  ])('refuses %s as the base with 400 invalid_base_commit', async (_label, baseCommit) => {
    const body = webAnnotation({
      source: CHAPTER_ONE,
      motivation: 'editing',
      baseCommit: baseCommit === undefined ? null : baseCommit,
    })
    const response = await post(body)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('invalid_base_commit')
  })

  it.each([['../secrets.md'], ['/etc/passwd'], ['books//ch01.md'], ['books\\ch01.md']])(
    'refuses the source path %s',
    async (sourcePath) => {
      const response = await post(
        webAnnotation({ source: CHAPTER_ONE, motivation: 'editing', sourcePath }),
      )
      expect(response.status).toBe(400)
      expect((await response.json()).error.code).toBe('invalid_source_path')
    },
  )

  it('refuses a body that is not canonical hunks', async () => {
    const response = await post({
      ...webAnnotation({ source: CHAPTER_ONE, motivation: 'editing' }),
      body: { type: 'TextualBody', value: 'just prose, not hunks' },
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('invalid_proposal')
  })

  it('refuses a base commit on a note or a highlight', async () => {
    for (const motivation of ['commenting', 'highlighting'] as const) {
      const response = await post({
        ...webAnnotation({ source: CHAPTER_ONE, motivation }),
        'margin:baseCommit': BASE_COMMIT,
      })
      expect(response.status, motivation).toBe(400)
      expect((await response.json()).error.code).toBe('unexpected_base_commit')
    }
  })
})

describe('revising a proposal', () => {
  it('bumps the revision on every body or base change, and only then', async () => {
    const created = await createProposal()
    const id = bareId(created)

    const first = await patch(id, { body: proposalBody('A {~~remark~>note~~}.') })
    expect(first.status).toBe(200)
    expect((await first.json())['margin:revision']).toBe(2)

    const rebased = await patch(id, { 'margin:baseCommit': NEWER })
    expect(rebased.status).toBe(200)
    expect(await rebased.json()).toMatchObject({
      'margin:revision': 3,
      'margin:baseCommit': NEWER,
    })

    const visibilityOnly = await patch(id, { 'margin:visibility': 'public' })
    expect((await visibilityOnly.json())['margin:revision']).toBe(3)
  })

  it('refuses a dirty or abbreviated base and a body that is not hunks', async () => {
    const id = bareId(await createProposal())
    for (const baseCommit of ['dirty', 'abc1234']) {
      const response = await patch(id, { 'margin:baseCommit': baseCommit })
      expect(response.status, baseCommit).toBe(400)
      expect((await response.json()).error.code).toBe('invalid_base_commit')
    }
    const prose = await patch(id, { body: 'not hunks' })
    expect(prose.status).toBe(400)
    expect((await prose.json()).error.code).toBe('invalid_proposal')
  })

  it('never lets another reader revise it', async () => {
    const created = await createProposal({ 'margin:visibility': 'public' })
    const response = await patch(bareId(created), { body: proposalBody('x') }, BOB)
    expect(response.status).toBe(403)
  })
})

describe('withdrawing a proposal', () => {
  it('takes it out of the review listing without deleting the row', async () => {
    const kept = await createProposal()
    const withdrawn = await createProposal()
    expect((await reviewListing()).map(bareId).sort()).toEqual(
      [bareId(kept), bareId(withdrawn)].sort(),
    )

    const response = await withdraw(bareId(withdrawn))
    expect(response.status).toBe(200)
    const body = (await response.json()) as Wire
    expect(body['margin:withdrawnAt']).toEqual(expect.any(String))

    expect((await reviewListing()).map(bareId)).toEqual([bareId(kept)])
    // Still readable, with its state, through the ordinary annotation routes.
    const read = await harness.request(
      'GET',
      `/annotations/${bareId(withdrawn)}${scopeQuery(CHAPTER_ONE)}`,
      { as: ADA },
    )
    expect(read.status).toBe(200)
    expect((await read.json())['margin:withdrawnAt']).toEqual(expect.any(String))
    const all = await harness.request('GET', `/annotations${scopeQuery(CHAPTER_ONE)}`, { as: ADA })
    const ids = ((await all.json()) as { annotations: Wire[] }).annotations.map(bareId)
    expect(ids).toContain(bareId(withdrawn))
  })

  it('refuses a second withdrawal and any later revision with 409', async () => {
    const id = bareId(await createProposal())
    expect((await withdraw(id)).status).toBe(200)
    const again = await withdraw(id)
    expect(again.status).toBe(409)
    expect((await again.json()).error.code).toBe('proposal_withdrawn')
    const revise = await patch(id, { body: proposalBody('late') })
    expect(revise.status).toBe(409)
  })

  it('is its author’s alone, and needs a signed-in caller', async () => {
    const id = bareId(await createProposal({ 'margin:visibility': 'public' }))
    expect((await withdraw(id, BOB)).status).toBe(403)
    const anonymous = await harness.request(
      'POST',
      `/proposals/${id}/withdraw${scopeQuery(CHAPTER_ONE)}`,
      { as: null },
    )
    expect(anonymous.status).toBe(401)
    expect((await reviewListing()).map(bareId)).toEqual([id])
  })

  it('is refused for a note', async () => {
    const note = await post(webAnnotation({ source: CHAPTER_ONE }))
    const id = bareId((await note.json()) as Wire)
    expect((await withdraw(id)).status).toBe(404)
  })
})

describe('the database enforces the proposal fields', () => {
  async function insert(overrides: Record<string, unknown>) {
    const query = insertAnnotationQuery({
      id: 'p1',
      site: 'https://ernie.sg',
      document: '/x',
      creator: 'someone',
      visibility: 'private',
      motivation: 'editing',
      parentId: null,
      structId: null,
      nodeId: 'p-1',
      positionStart: 0,
      positionEnd: 1,
      positionUnit: 'codepoint',
      quoteExact: 'a',
      quotePrefix: '',
      quoteSuffix: '',
      body: proposalBody(),
      color: null,
      created: '2026-09-29T00:00:00.000Z',
      modified: '2026-09-29T00:00:00.000Z',
      baseCommit: BASE_COMMIT,
      sourcePath: 'books/chapters/ch01.md',
      revision: 1,
      ...overrides,
    })
    await harness.database.prepare(query.sql).bind(...query.params).run()
  }

  it('refuses an editing row without a full base commit, a source or a revision', async () => {
    for (const overrides of [
      { baseCommit: null },
      { baseCommit: 'dirty' },
      { baseCommit: 'g'.repeat(40) },
      { sourcePath: null },
      { revision: null },
      { revision: 0 },
    ]) {
      await expect(insert(overrides), JSON.stringify(overrides)).rejects.toThrow(
        /MARGIN_PROPOSAL_FIELDS/,
      )
    }
    await insert({})
  })

  it('refuses proposal fields on a note', async () => {
    await expect(insert({ motivation: 'commenting' })).rejects.toThrow(/MARGIN_PROPOSAL_FIELDS/)
  })
})

describe('a proposal stored before migration 0003', () => {
  // A legacy row: an editing annotation with none of the proposal fields. The
  // insert trigger refuses that shape now, so it is dropped and recreated
  // around the one insert, exactly as the row existed before the migration.
  async function insertLegacy(): Promise<string> {
    const db = harness.database
    await db.prepare('DROP TRIGGER margin_annotations_proposal_fields_insert').run()
    const query = insertAnnotationQuery({
      id: 'legacy',
      site: 'https://ernie.sg',
      document: '/challenges/chapter-1',
      creator: (await import('./fixtures')).ADA_KEY,
      visibility: 'private',
      motivation: 'editing',
      parentId: null,
      structId: null,
      nodeId: 'p-1',
      positionStart: 0,
      positionEnd: 1,
      positionUnit: 'codepoint',
      quoteExact: 'a',
      quotePrefix: '',
      quoteSuffix: '',
      body: 'an old free-text proposal',
      color: null,
      created: '2026-09-01T00:00:00.000Z',
      modified: '2026-09-01T00:00:00.000Z',
    })
    await db.prepare(query.sql).bind(...query.params).run()
    const migration = (await import('node:fs')).readFileSync('migrations/0003_margin_proposals.sql', 'utf8')
    const create = migration.slice(
      migration.indexOf('CREATE TRIGGER margin_annotations_proposal_fields_insert'),
      migration.indexOf('END;') + 'END;'.length,
    )
    await db.prepare(create).run()
    return 'legacy'
  }

  it('stays readable, and can still be withdrawn', async () => {
    const id = await insertLegacy()
    expect((await patch(id, { 'margin:visibility': 'public' })).status).toBe(200)
    expect((await withdraw(id)).status).toBe(200)
  })

  it('cannot be revised once withdrawn', async () => {
    const id = await insertLegacy()
    expect((await withdraw(id)).status).toBe(200)
    expect((await withdraw(id)).status).toBe(409)
    const upgrade = await patch(id, {
      body: proposalBody('x'),
      'margin:baseCommit': NEWER,
      'margin:sourcePath': 'books/chapters/ch01-values.md',
    })
    expect(upgrade.status).toBe(409)
    expect((await upgrade.json()).error.code).toBe('proposal_withdrawn')
  })

  it('refuses an upgrade that keeps its free-text body', async () => {
    const id = await insertLegacy()
    const metadataOnly = await patch(id, {
      'margin:baseCommit': NEWER,
      'margin:sourcePath': 'books/chapters/ch01-values.md',
    })
    expect(metadataOnly.status).toBe(400)
    expect((await metadataOnly.json()).error.code).toBe('invalid_proposal')
  })

  it('is upgraded by a revision that names both its base and its file, counting from revision 1', async () => {
    const id = await insertLegacy()
    const bodyOnly = await patch(id, { body: proposalBody('x') })
    expect(bodyOnly.status).toBe(400)
    expect((await bodyOnly.json()).error.code).toBe('invalid_base_commit')
    const baseOnly = await patch(id, { body: proposalBody('x'), 'margin:baseCommit': NEWER })
    expect(baseOnly.status).toBe(400)

    const upgraded = await patch(id, {
      body: proposalBody('x'),
      'margin:baseCommit': NEWER,
      'margin:sourcePath': 'books/chapters/ch01-values.md',
    })
    expect(upgraded.status).toBe(200)
    expect(await upgraded.json()).toMatchObject({
      'margin:baseCommit': NEWER,
      'margin:sourcePath': 'books/chapters/ch01-values.md',
      'margin:revision': 1,
    })
    // Once recorded, its file is fixed.
    const moved = await patch(id, { 'margin:sourcePath': 'books/chapters/other.md' })
    expect(moved.status).toBe(400)
    expect((await moved.json()).error.code).toBe('unexpected_source_path')
  })
})

describe('a revision racing a withdrawal', () => {
  it('lands only while the proposal is pending, checked in the write itself', async () => {
    const id = bareId(await createProposal())
    const scope = { site: 'https://ernie.sg', document: '/challenges/chapter-1' }
    const { ADA_KEY } = await import('./fixtures')
    // The withdrawal wins between the route's read and its write.
    expect(await harness.repository.withdrawProposal(scope, id, ADA_KEY, '2026-09-29T00:00:00.000Z')).toBe(true)
    const revised = await harness.repository.updateAnnotation(scope, id, ADA_KEY, {
      body: proposalBody('late'),
      reviseProposal: true,
      modified: '2026-09-29T00:00:01.000Z',
    })
    expect(revised).toBeNull()
    const read = await harness.request('GET', `/annotations/${id}${scopeQuery(CHAPTER_ONE)}`, { as: ADA })
    expect((await read.json())['margin:revision']).toBe(1)
  })
})

describe('the update trigger watches motivation too', () => {
  it('refuses turning a note into a proposal without its fields, or a proposal into a note with them', async () => {
    const note = await post(webAnnotation({ source: CHAPTER_ONE }))
    const noteId = bareId((await note.json()) as Wire)
    const proposalId = bareId(await createProposal())
    const db = harness.database
    await expect(
      db.prepare("UPDATE margin_annotations SET motivation = 'editing' WHERE id = ?").bind(noteId).run(),
    ).rejects.toThrow(/MARGIN_PROPOSAL_FIELDS/)
    await expect(
      db.prepare("UPDATE margin_annotations SET motivation = 'commenting' WHERE id = ?").bind(proposalId).run(),
    ).rejects.toThrow(/MARGIN_PROPOSAL_FIELDS/)
  })
})
