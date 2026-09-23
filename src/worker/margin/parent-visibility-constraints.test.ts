import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { insertAnnotationQuery } from './queries'
import { applyMigrations } from './sqlite-database'

const SCOPE = { site: 'https://ernie.sg', document: '/chapter' }
const OTHER_SCOPE = { site: 'https://other.test', document: '/chapter' }
const CREATED = '2026-09-23T00:00:00.000Z'

function database() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  applyMigrations(db)
  return db
}

function insert(
  db: DatabaseSync,
  id: string,
  creator: string,
  visibility: 'public' | 'private',
  parentId: string | null = null,
  scope = SCOPE,
) {
  const query = insertAnnotationQuery({
    id,
    ...scope,
    creator,
    visibility,
    motivation: 'commenting',
    parentId,
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
    created: CREATED,
    modified: CREATED,
  })
  db.prepare(query.sql).run(...(query.params as never[]))
}

describe('parent visibility constraints in SQLite', () => {
  it('rejects a public child of a private parent on insert or visibility update', () => {
    const db = database()
    insert(db, 'parent', 'ada', 'private')
    expect(() => insert(db, 'public-child', 'ada', 'public', 'parent')).toThrow(
      'MARGIN_PARENT_VISIBILITY_CONFLICT',
    )
    insert(db, 'private-child', 'ada', 'private', 'parent')
    expect(() =>
      db
        .prepare(
          "UPDATE margin_annotations SET visibility = 'public' WHERE id = 'private-child'",
        )
        .run(),
    ).toThrow('MARGIN_PARENT_VISIBILITY_CONFLICT')
  })

  it('rejects an other-owner private child of a private parent, including parent-id updates', () => {
    const db = database()
    insert(db, 'private-parent', 'ada', 'private')
    insert(db, 'public-parent', 'ada', 'public')
    expect(() =>
      insert(db, 'other-child', 'bob', 'private', 'private-parent'),
    ).toThrow('MARGIN_PARENT_VISIBILITY_CONFLICT')
    insert(db, 'movable-child', 'bob', 'private', 'public-parent')
    expect(() =>
      db
        .prepare(
          "UPDATE margin_annotations SET parent_id = 'private-parent' WHERE id = 'movable-child'",
        )
        .run(),
    ).toThrow('MARGIN_PARENT_VISIBILITY_CONFLICT')
  })

  it('rejects a parent from a different tenant', () => {
    const db = database()
    insert(db, 'parent', 'ada', 'public')
    expect(() =>
      insert(db, 'child', 'ada', 'public', 'parent', OTHER_SCOPE),
    ).toThrow('MARGIN_PARENT_VISIBILITY_CONFLICT')
  })

  it('rejects a public parent downgrade with a public child', () => {
    const db = database()
    insert(db, 'parent', 'ada', 'public')
    insert(db, 'child', 'ada', 'public', 'parent')
    expect(() =>
      db
        .prepare(
          "UPDATE margin_annotations SET visibility = 'private' WHERE id = 'parent'",
        )
        .run(),
    ).toThrow('MARGIN_VISIBLE_REPLIES_CONFLICT')
  })

  it('rejects a public parent downgrade with another owner’s private child', () => {
    const db = database()
    insert(db, 'parent', 'ada', 'public')
    insert(db, 'child', 'bob', 'private', 'parent')
    expect(() =>
      db
        .prepare(
          "UPDATE margin_annotations SET visibility = 'private' WHERE id = 'parent'",
        )
        .run(),
    ).toThrow('MARGIN_VISIBLE_REPLIES_CONFLICT')
  })

  it('allows a private parent with its own private children', () => {
    const db = database()
    insert(db, 'parent', 'ada', 'public')
    insert(db, 'child', 'ada', 'private', 'parent')
    db.prepare(
      "UPDATE margin_annotations SET visibility = 'private' WHERE id = 'parent'",
    ).run()
    const rows = db
      .prepare("SELECT visibility FROM margin_annotations WHERE id = 'parent'")
      .all() as {
      visibility: string
    }[]
    expect(rows).toEqual([{ visibility: 'private' }])
  })
})
