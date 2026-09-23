import { beforeEach, describe, expect, it } from 'vitest'
import {
  ADA,
  ADA_KEY,
  BOB,
  BOB_KEY,
  CHAPTER_ONE,
  createHarness,
  OTHER_SITE,
  scopeQuery,
  webAnnotation,
  type MarginHarness,
} from './fixtures'
import { DEFAULT_PAGE_SIZE } from './repository'
import { listAnnotationsQuery, visibilityPredicate } from './queries'
import type { TenantScope } from './repository'

/**
 * Success criterion 3: visibility is enforced in the query, never in
 * serialization.
 *
 * These assertions are deliberately made below the HTTP surface. The rows
 * being counted are the rows SQLite hands back for the statement a request
 * would run, not the rows a response happens to contain — so a change that
 * fetched everything and filtered it on the way out would fail here even if
 * the response body stayed correct.
 */

const SCOPE: TenantScope = {
  site: 'https://ernie.sg',
  document: '/challenges/chapter-1',
}

let harness: MarginHarness

/** Ada and Bob each own one private and one public annotation on chapter one. */
async function seed() {
  harness = createHarness()
  const rows: [typeof ADA, 'private' | 'public', string][] = [
    [ADA, 'private', "ada's private note"],
    [ADA, 'public', "ada's public note"],
    [BOB, 'private', "bob's private note"],
    [BOB, 'public', "bob's public note"],
  ]
  for (const [principal, visibility, body] of rows) {
    const response = await harness.request('POST', '/annotations', {
      as: principal,
      body: webAnnotation({ source: CHAPTER_ONE, visibility, body }),
    })
    expect(response.status).toBe(201)
  }
  // A fifth row on a second site, same path, to prove tenancy is real.
  expect(
    (
      await harness.request('POST', '/annotations', {
        as: ADA,
        body: webAnnotation({
          source: OTHER_SITE,
          visibility: 'public',
          body: 'another site entirely',
        }),
      })
    ).status,
  ).toBe(201)
  harness.database.executed.length = 0
}

/** Runs the production statement verbatim and returns the raw database rows. */
function rowsFor(viewer: string | null) {
  const { sql, params } = listAnnotationsQuery(SCOPE, viewer)
  return harness.database.query(sql, params) as {
    id: string
    creator: string
    visibility: string
    body: string | null
  }[]
}

beforeEach(seed)

describe('the visibility predicate', () => {
  it('gives an anonymous reader no owner clause to satisfy at all', () => {
    const predicate = visibilityPredicate(null)
    expect(predicate.sql).toBe("visibility = 'public'")
    expect(predicate.params).toEqual([])
    expect(predicate.sql).not.toContain('creator')
  })

  it('binds the viewer, so a signed-in reader matches only their own rows', () => {
    const predicate = visibilityPredicate(ADA_KEY)
    expect(predicate.sql).toBe("(visibility = 'public' OR creator = ?)")
    expect(predicate.params).toEqual([ADA_KEY])
  })

  it('is present in every list statement, with the tenancy key ahead of it', () => {
    const { sql } = listAnnotationsQuery(SCOPE, ADA_KEY)
    expect(sql).toContain('WHERE site = ? AND document = ?')
    expect(sql).toContain("visibility = 'public'")
    expect(sql).toContain("visibility = 'private' AND creator = ?")
    expect(sql.match(/WHERE site = \? AND document = \?/g)).toHaveLength(2)
  })
})

describe('what SQL returns for each reader', () => {
  it('returns exactly three rows to each owner and never the other private one', () => {
    const forAda = rowsFor(ADA_KEY)
    expect(forAda).toHaveLength(3)
    expect(forAda.map((row) => row.body).sort()).toEqual([
      "ada's private note",
      "ada's public note",
      "bob's public note",
    ])
    expect(
      forAda.some(
        (row) => row.visibility === 'private' && row.creator !== ADA_KEY,
      ),
    ).toBe(false)

    const forBob = rowsFor(BOB_KEY)
    expect(forBob).toHaveLength(3)
    expect(forBob.map((row) => row.body).sort()).toEqual([
      "ada's public note",
      "bob's private note",
      "bob's public note",
    ])
    expect(
      forBob.some(
        (row) => row.visibility === 'private' && row.creator !== BOB_KEY,
      ),
    ).toBe(false)
  })

  it('returns only the two public rows to an anonymous reader', () => {
    const rows = rowsFor(null)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.visibility === 'public')).toBe(true)
  })

  it('cannot be made to yield a private row belonging to someone else, whatever the viewer parameter is', () => {
    const everyCreator = [
      ADA_KEY,
      BOB_KEY,
      '',
      "' OR 1=1 --",
      'urn:margin:principal:dev:x:y',
    ]
    for (const viewer of everyCreator) {
      const rows = rowsFor(viewer)
      const leaked = rows.filter(
        (row) => row.visibility === 'private' && row.creator !== viewer,
      )
      expect(leaked).toEqual([])
    }
  })

  it('keeps a second site out of the first site’s rows', () => {
    const rows = rowsFor(ADA_KEY)
    expect(rows.map((row) => row.body)).not.toContain('another site entirely')
    expect(rows).toHaveLength(3)

    const otherSite = listAnnotationsQuery(
      { site: 'https://berlayar.ai', document: '/challenges/chapter-1' },
      ADA_KEY,
    )
    const otherRows = harness.database.query(
      otherSite.sql,
      otherSite.params,
    ) as { body: string | null }[]
    expect(otherRows.map((row) => row.body)).toEqual(['another site entirely'])
  })
})

describe('the repository runs that statement and nothing wider', () => {
  it('reads once, scoped, with no unscoped follow-up', async () => {
    const response = await harness.request(
      'GET',
      `/annotations${scopeQuery(CHAPTER_ONE)}`,
      { as: BOB },
    )
    expect(response.status).toBe(200)

    // The route asks for one row more than a page, so it can tell whether there
    // is another page without a second query. Same statement otherwise.
    const expected = listAnnotationsQuery(SCOPE, BOB_KEY, {
      limit: DEFAULT_PAGE_SIZE + 1,
    })
    const reads = harness.database.reads()
    expect(reads).toHaveLength(1)
    expect(reads[0].sql).toBe(expected.sql)
    expect(reads[0].params).toEqual(expected.params)
    expect(reads[0].sql).toContain("visibility = 'private' AND creator = ?")
    expect(reads[0].sql).toContain('UNION ALL')
    expect(reads[0].sql).toContain('LIMIT ?')

    const { annotations } = (await response.json()) as {
      annotations: unknown[]
    }
    expect(annotations).toHaveLength(3)
  })

  it('never selects without a site and document bound', async () => {
    await harness.request('GET', `/annotations${scopeQuery(CHAPTER_ONE)}`, {
      as: null,
    })
    for (const read of harness.database.reads()) {
      if (!read.sql.includes('margin_annotations')) continue
      expect(read.sql).toContain('site = ? AND document = ?')
      expect(read.params.slice(0, 2)).toEqual([SCOPE.site, SCOPE.document])
    }
  })
})
