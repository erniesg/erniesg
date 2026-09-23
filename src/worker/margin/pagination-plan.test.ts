import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from './sqlite-database'
import { listAnnotationsQuery } from './queries'
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
    expect(plan).toContain('margin_annotations_page')
  })

  it('does the same for a later page', () => {
    const plan = planFor({
      limit: DEFAULT_PAGE_SIZE + 1,
      after: { created: '2026-09-23T00:00:00.000Z', id: 'annotation-050' },
    })

    expect(plan).not.toContain('TEMP B-TREE')
    expect(plan).toContain('margin_annotations_page')
  })

  it('uses the motivation-aware ordered index for proposals', () => {
    const plan = planFor({
      limit: DEFAULT_PAGE_SIZE + 1,
      motivation: 'editing',
    })

    expect(plan).not.toContain('TEMP B-TREE')
    expect(plan).toContain('margin_annotations_proposal_page')
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
  })
  it('uses the visibility-aware ordered index for anonymous pages', () => {})

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
