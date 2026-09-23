import type { ListOptions, TenantScope, ViewerKey } from './repository'

/**
 * Every SQL statement margin runs, as pure `(sql, params)` values.
 *
 * They live apart from the D1 client so the visibility proof in
 * `visibility.test.ts` can run the exact statement a request would run,
 * against a real SQLite database, and count the rows it returns. That is the
 * difference success criterion 3 asks for: a private row belonging to someone
 * else is never read, as opposed to read and then dropped on the way out.
 */

export type Query = { sql: string; params: unknown[] }

export const ANNOTATION_COLUMNS = [
  'id',
  'site',
  'document',
  'creator',
  'visibility',
  'motivation',
  'parent_id',
  'struct_id',
  'node_id',
  'position_start',
  'position_end',
  'position_unit',
  'quote_exact',
  'quote_prefix',
  'quote_suffix',
  'body',
  'color',
  'created',
  'modified',
].join(', ')

/**
 * The one visibility rule, in one place.
 *
 * An anonymous reader gets `visibility = 'public'` and no owner escape hatch:
 * there is no parameter they could supply that makes a private row match. A
 * signed-in reader additionally matches rows they created. Neither branch can
 * widen beyond the `(site, document)` pair supplied by the caller.
 */
export function visibilityPredicate(viewer: ViewerKey): Query {
  if (viewer === null) {
    return { sql: "visibility = 'public'", params: [] }
  }
  return { sql: "(visibility = 'public' OR creator = ?)", params: [viewer] }
}

function scopedRead(
  scope: TenantScope,
  viewer: ViewerKey,
  extraSql: string[],
  extraParams: unknown[],
): Query {
  const visibility = visibilityPredicate(viewer)
  return {
    sql: [
      `SELECT ${ANNOTATION_COLUMNS} FROM margin_annotations`,
      `WHERE site = ? AND document = ? AND ${visibility.sql}`,
      ...extraSql,
    ].join('\n'),
    params: [scope.site, scope.document, ...visibility.params, ...extraParams],
  }
}

export function listAnnotationsQuery(
  scope: TenantScope,
  viewer: ViewerKey,
  options: ListOptions = {},
): Query {
  const extraSql: string[] = []
  const extraParams: unknown[] = []
  if (options.motivation) {
    extraSql.push('AND motivation = ?')
    extraParams.push(options.motivation)
  }
  // Keyset, not OFFSET: the collection is ordered by `(created, id)`, so
  // resuming after the last row the caller saw is one comparison and cannot
  // skip or repeat a row when something is inserted between pages.
  if (options.after) {
    extraSql.push('AND (created, id) > (?, ?)')
    extraParams.push(options.after.created, options.after.id)
  }
  extraSql.push('ORDER BY created ASC, id ASC')
  if (options.limit !== undefined) {
    extraSql.push('LIMIT ?')
    extraParams.push(options.limit)
  }
  return scopedRead(scope, viewer, extraSql, extraParams)
}

export function findAnnotationQuery(
  scope: TenantScope,
  id: string,
  viewer: ViewerKey,
): Query {
  return scopedRead(scope, viewer, ['AND id = ?', 'LIMIT 1'], [id])
}

export function insertAnnotationQuery(row: {
  id: string
  site: string
  document: string
  creator: string
  visibility: string
  motivation: string
  parentId: string | null
  structId: string | null
  nodeId: string
  positionStart: number
  positionEnd: number
  positionUnit: string
  quoteExact: string
  quotePrefix: string
  quoteSuffix: string
  body: string | null
  color: string | null
  created: string
  modified: string
}): Query {
  return {
    sql: `INSERT INTO margin_annotations (${ANNOTATION_COLUMNS})
VALUES (${new Array(19).fill('?').join(', ')})`,
    params: [
      row.id,
      row.site,
      row.document,
      row.creator,
      row.visibility,
      row.motivation,
      row.parentId,
      row.structId,
      row.nodeId,
      row.positionStart,
      row.positionEnd,
      row.positionUnit,
      row.quoteExact,
      row.quotePrefix,
      row.quoteSuffix,
      row.body,
      row.color,
      row.created,
      row.modified,
    ],
  }
}

/**
 * Writes are owner-scoped in SQL for the same reason reads are viewer-scoped:
 * `creator = ?` is the authorization check, so a handler cannot skip it.
 */
export function updateAnnotationQuery(
  scope: TenantScope,
  id: string,
  owner: string,
  patch: {
    body?: string
    visibility?: string
    color?: string
    modified: string
  },
): Query {
  const assignments = ['modified = ?']
  const params: unknown[] = [patch.modified]
  if (patch.body !== undefined) {
    assignments.push('body = ?')
    params.push(patch.body)
  }
  if (patch.visibility !== undefined) {
    assignments.push('visibility = ?')
    params.push(patch.visibility)
  }
  if (patch.color !== undefined) {
    assignments.push('color = ?')
    params.push(patch.color)
  }
  return {
    sql: `UPDATE margin_annotations SET ${assignments.join(', ')}
WHERE site = ? AND document = ? AND id = ? AND creator = ?`,
    params: [...params, scope.site, scope.document, id, owner],
  }
}

/**
 * How many annotations hang off this one, whoever wrote them.
 *
 * Deliberately not owner-scoped: the question is whether deleting this would
 * take somebody else's annotation with it, and a reply the caller cannot see
 * still counts.
 */
export function countRepliesQuery(scope: TenantScope, id: string): Query {
  return {
    sql: `SELECT COUNT(*) AS replies FROM margin_annotations
WHERE site = ? AND document = ? AND parent_id = ?`,
    params: [scope.site, scope.document, id],
  }
}

export function deleteAnnotationQuery(
  scope: TenantScope,
  id: string,
  owner: string,
): Query {
  return {
    sql: `DELETE FROM margin_annotations
WHERE site = ? AND document = ? AND id = ? AND creator = ?`,
    params: [scope.site, scope.document, id, owner],
  }
}

export function getPrefsQuery(owner: string): Query {
  return {
    sql: `SELECT creator, default_visibility, created, modified
FROM margin_prefs WHERE creator = ? LIMIT 1`,
    params: [owner],
  }
}

export function upsertPrefsQuery(
  owner: string,
  defaultVisibility: string,
  now: string,
): Query {
  return {
    sql: `INSERT INTO margin_prefs (creator, default_visibility, created, modified)
VALUES (?, ?, ?, ?)
ON CONFLICT (creator) DO UPDATE SET default_visibility = excluded.default_visibility, modified = excluded.modified`,
    params: [owner, defaultVisibility, now, now],
  }
}
