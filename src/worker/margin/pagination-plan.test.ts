import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from './sqlite-database'
import { insertAnnotationQuery, listAnnotationsQuery } from './queries'
import { DEFAULT_PAGE_SIZE } from './repository'

/**
 * Pagination bounds the response. An index is what bounds the work behind it.
 *
 * Without one ending in `(created, id)`, SQLite sorts every visible matching row
 * before `LIMIT` takes a handful — `USE TEMP B-TREE FOR ORDER BY` — so a
 * long-lived document's later pages cost the same as reading the whole
 * collection. This asserts the plan against the real engine and the real
 * migration, because the index is only useful if the planner actually picks it.
 */
describe('the collection query plan', () => {
  function planFor(
    options: Parameters<typeof listAnnotationsQuery>[2],
    viewer: string | null = 'workos:https://api.workos.test:user_01H',
  ) {
    const database = new DatabaseSync(':memory:')
    applyMigrations(database)
    const query = listAnnotationsQuery(
      { site: 'https://ernie.sg', document: '/challenges/chapter-1' },
      viewer,
      options,
    )
    return (
      database
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .all(...(query.params as never[])) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join('\n')
  }

  it('orders from an index rather than a temporary B-tree', () => {
    const plan = planFor({ limit: DEFAULT_PAGE_SIZE + 1 })

    expect(plan).not.toContain('TEMP B-TREE')
    expect(plan).toContain('MERGE (UNION ALL)')
    expect(plan).toContain('margin_annotations_public_page')
    expect(plan).toContain('margin_annotations_private_page')
  })

  it('does the same for a later page', () => {
    const plan = planFor({
      limit: DEFAULT_PAGE_SIZE + 1,
      after: { created: '2026-09-23T00:00:00.000Z', id: 'annotation-050' },
    })

    expect(plan).not.toContain('TEMP B-TREE')
    expect(plan).toContain('MERGE (UNION ALL)')
    expect(plan).toContain('margin_annotations_public_page')
    expect(plan).toContain('margin_annotations_private_page')
    expect(plan.match(/\(created,id\)>\(\?,\?\)/g)).toHaveLength(2)
  })

  it('uses the motivation-aware ordered index for proposals', () => {
    const plan = planFor({
      limit: DEFAULT_PAGE_SIZE + 1,
      motivation: 'editing',
    })

    expect(plan).not.toContain('TEMP B-TREE')
    expect(plan).toContain('MERGE (UNION ALL)')
    expect(plan).toContain('margin_annotations_public_proposal_page')
    expect(plan).toContain('margin_annotations_private_proposal_page')
  })

  it('seeks through both fields of a signed-in proposal cursor', () => {
    const plan = planFor({
      limit: DEFAULT_PAGE_SIZE + 1,
      motivation: 'editing',
      after: { created: '2026-09-23T00:00:00.000Z', id: 'annotation-050' },
    })

    expect(plan).not.toContain('TEMP B-TREE')
    expect(plan).toContain('MERGE (UNION ALL)')
    expect(plan).toContain('margin_annotations_public_proposal_page')
    expect(plan).toContain('margin_annotations_private_proposal_page')
    expect(plan.match(/\(created,id\)>\(\?,\?\)/g)).toHaveLength(2)
  })
  it('uses the public proposal index before returning an anonymous first page', () => {
    const plan = planFor(
      { limit: DEFAULT_PAGE_SIZE + 1, motivation: 'editing' },
      null,
    )

    expect(plan).not.toContain('TEMP B-TREE')
    expect(plan).toContain('margin_annotations_public_proposal_page')
  })

  it('keeps private proposals out of an anonymous keyset page scan', () => {
    const plan = planFor(
      {
        limit: DEFAULT_PAGE_SIZE + 1,
        motivation: 'editing',
        after: { created: '2026-09-23T00:00:00.000Z', id: 'annotation-050' },
      },
      null,
    )

    expect(plan).not.toContain('TEMP B-TREE')
    expect(plan).toContain('margin_annotations_public_proposal_page')
    expect(plan).toContain('(created,id)>(?,?)')
  })
  it('uses the visibility-aware ordered index for anonymous pages', () => {
    const database = new DatabaseSync(':memory:')
    applyMigrations(database)
    const query = listAnnotationsQuery(
      { site: 'https://ernie.sg', document: '/challenges/chapter-1' },
      null,
      { limit: DEFAULT_PAGE_SIZE + 1 },
    )
    const plan = (
      database
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .all(...(query.params as never[])) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join('\n')
    expect(plan).toContain('margin_annotations_public_page')
    expect(plan).not.toContain('TEMP B-TREE')
  })
})

it('merges public and owner-private keyset pages through long other-owner private history', () => {
  const database = new DatabaseSync(':memory:')
  applyMigrations(database)
  const scope = { site: 'https://ernie.sg', document: '/challenges/chapter-1' }
  const viewer = 'workos:https://api.workos.test:user_01H'
  const created = '2026-09-23T00:00:00.000Z'
  const insert = (
    id: string,
    creator: string,
    visibility: 'public' | 'private',
    motivation: 'commenting' | 'editing' = 'commenting',
  ) => {
    const query = insertAnnotationQuery({
      id,
      ...scope,
      creator,
      visibility,
      motivation,
      parentId: null,
      structId: null,
      nodeId: 'p-1',
      positionStart: 0,
      positionEnd: 1,
      positionUnit: 'utf16',
      quoteExact: 'a',
      quotePrefix: '',
      quoteSuffix: '',
      body: 'note',
      color: null,
      created,
      modified: created,
    })
    database.prepare(query.sql).run(...(query.params as never[]))
  }
  for (let n = 0; n < 300; n += 1) {
    insert('x' + String(n).padStart(3, '0'), 'other', 'private', 'editing')
  }
  insert('x150a', 'other', 'public')
  insert('x150b', viewer, 'private', 'editing')
  insert('x150c', viewer, 'public', 'editing')
  insert('x150d', 'other', 'public', 'editing')
  insert('x150e', viewer, 'private')
  const ids = (
    options: Parameters<typeof listAnnotationsQuery>[2],
  ): string[] => {
    const query = listAnnotationsQuery(scope, viewer, options)
    return (
      database.prepare(query.sql).all(...(query.params as never[])) as {
        id: string
      }[]
    ).map((row) => row.id)
  }

  expect(ids({ limit: 2 })).toEqual(['x150a', 'x150b'])
  expect(ids({ limit: 2, after: { created, id: 'x150b' } })).toEqual([
    'x150c',
    'x150d',
  ])
  expect(ids({ limit: 2, after: { created, id: 'x150d' } })).toEqual(['x150e'])
  expect(ids({ limit: 2, motivation: 'editing' })).toEqual(['x150b', 'x150c'])
  expect(
    ids({ limit: 2, motivation: 'editing', after: { created, id: 'x150c' } }),
  ).toEqual(['x150d'])

  const query = listAnnotationsQuery(scope, viewer, {
    limit: 2,
    motivation: 'editing',
    after: { created, id: 'x150c' },
  })
  const plan = (
    database
      .prepare('EXPLAIN QUERY PLAN ' + query.sql)
      .all(...(query.params as never[])) as { detail: string }[]
  )
    .map((row) => row.detail)
    .join('\n')
  expect(plan).toContain('margin_annotations_public_proposal_page')
  expect(plan).toContain('margin_annotations_private_proposal_page')
  expect(plan).not.toContain('TEMP B-TREE')
})
