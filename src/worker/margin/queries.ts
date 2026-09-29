import {
  MAX_PAGE_SIZE,
  type ListOptions,
  type TenantScope,
  type ViewerKey,
} from './repository'

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
  'base_commit',
  'source_path',
  'revision',
  'withdrawn_at',
].join(', ')

/**
 * The visibility predicate for single-row reads.
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
  if (viewer !== null) {
    // SQLite merges two index-ordered streams under one LIMIT. The disjoint
    // visibility predicates return a viewer's own public row only once, and
    // neither stream walks another owner's private history to fill a page.
    const limit = options.limit ?? MAX_PAGE_SIZE
    const publicWhere = ["site = ? AND document = ? AND visibility = 'public'"]
    const privateWhere = [
      "site = ? AND document = ? AND visibility = 'private' AND creator = ?",
    ]
    const publicParams: unknown[] = [scope.site, scope.document]
    const privateParams: unknown[] = [scope.site, scope.document, viewer]
    if (options.motivation) {
      publicWhere.push('motivation = ?')
      privateWhere.push('motivation = ?')
      publicParams.push(options.motivation)
      privateParams.push(options.motivation)
    }
    if (options.pendingOnly) {
      publicWhere.push('withdrawn_at IS NULL')
      privateWhere.push('withdrawn_at IS NULL')
    }
    if (options.after) {
      publicWhere.push('(created, id) > (?, ?)')
      privateWhere.push('(created, id) > (?, ?)')
      publicParams.push(options.after.created, options.after.id)
      privateParams.push(options.after.created, options.after.id)
    }
    const publicIndex = options.motivation
      ? 'margin_annotations_public_proposal_page'
      : 'margin_annotations_public_page'
    const privateIndex = options.motivation
      ? 'margin_annotations_private_proposal_page'
      : 'margin_annotations_private_page'
    return {
      sql: `SELECT ${ANNOTATION_COLUMNS} FROM margin_annotations INDEXED BY ${publicIndex}
WHERE ${publicWhere.join(' AND ')}
UNION ALL
SELECT ${ANNOTATION_COLUMNS} FROM margin_annotations INDEXED BY ${privateIndex}
WHERE ${privateWhere.join(' AND ')}
ORDER BY created ASC, id ASC LIMIT ?`,
      params: [...publicParams, ...privateParams, limit],
    }
  }

  const extraSql: string[] = []
  const extraParams: unknown[] = []
  if (options.motivation) {
    extraSql.push('AND motivation = ?')
    extraParams.push(options.motivation)
  }
  if (options.pendingOnly) extraSql.push('AND withdrawn_at IS NULL')
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
  /** Proposal fields (migration 0003); absent on a highlight or a note. */
  baseCommit?: string | null
  sourcePath?: string | null
  revision?: number | null
  withdrawnAt?: string | null
}): Query {
  return {
    sql: `INSERT INTO margin_annotations (${ANNOTATION_COLUMNS})
VALUES (${new Array(23).fill('?').join(', ')})`,
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
      row.baseCommit ?? null,
      row.sourcePath ?? null,
      row.revision ?? null,
      row.withdrawnAt ?? null,
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
    baseCommit?: string
    sourcePath?: string
    reviseProposal?: boolean
    modified: string
  },
): Query {
  const assignments = ['modified = ?']
  const params: unknown[] = [patch.modified]
  if (patch.baseCommit !== undefined) {
    assignments.push('base_commit = ?')
    params.push(patch.baseCommit)
  }
  if (patch.sourcePath !== undefined) {
    assignments.push('source_path = ?')
    params.push(patch.sourcePath)
  }
  // A revision of a proposal's body or base is a new revision, which is what a
  // review approval binds to (060). Counted in SQL so two revisions cannot both
  // read the same number.
  // A proposal from before migration 0003 has no revision; its first counted
  // revision is 1.
  if (patch.reviseProposal) assignments.push('revision = COALESCE(revision, 0) + 1')
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

/**
 * Replace a note's body with the tombstone, keeping the row and its place in
 * the thread. Owner-scoped like every write, and limited to `commenting` rows:
 * a highlight has no body to replace. `visibility` is not touched, so the
 * parent-visibility triggers have nothing to decide.
 */
export function tombstoneAnnotationQuery(
  scope: TenantScope,
  id: string,
  owner: string,
  tombstone: string,
  modified: string,
): Query {
  return {
    sql: `UPDATE margin_annotations SET body = ?, color = NULL, modified = ?
WHERE site = ? AND document = ? AND id = ? AND creator = ? AND motivation = 'commenting'`,
    params: [tombstone, modified, scope.site, scope.document, id, owner],
  }
}

/**
 * Withdraw a pending proposal from review. The row stays, so replies to it
 * stay readable; the review listing leaves it out. Owner-scoped, `editing`
 * only, and only once.
 */
export function withdrawProposalQuery(
  scope: TenantScope,
  id: string,
  owner: string,
  at: string,
): Query {
  return {
    sql: `UPDATE margin_annotations SET withdrawn_at = ?, modified = ?
WHERE site = ? AND document = ? AND id = ? AND creator = ? AND motivation = 'editing' AND withdrawn_at IS NULL`,
    params: [at, at, scope.site, scope.document, id, owner],
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

/* Reading progress. Every statement is keyed by the caller as `creator`. */

export function listProgressQuery(owner: string, site: string, book: string): Query {
  return {
    sql: `SELECT item, solved, solved_at, draft, draft_updated
FROM margin_progress WHERE creator = ? AND site = ? AND book = ?
ORDER BY item LIMIT 2000`,
    params: [owner, site, book],
  }
}

/**
 * The merge, in one statement per item: `solved` only goes up, `solved_at`
 * keeps the earliest time, and a draft is replaced only by a newer one. Times
 * share one ISO spelling, so comparing them as text orders them.
 */
export function mergeProgressQuery(
  owner: string,
  site: string,
  book: string,
  item: {
    item: string
    solved: boolean
    solvedAt: string | null
    draft: string | null
    draftUpdated: string | null
  },
  now: string,
  cap: number,
): Query {
  // One statement, so the cap holds under concurrent requests: a new item is
  // inserted only while the book holds fewer than `cap`; an item already held
  // always updates. A refused insert changes no row, which the caller reads.
  return {
    sql: `INSERT INTO margin_progress
  (creator, site, book, item, solved, solved_at, draft, draft_updated, modified)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE EXISTS (
    SELECT 1 FROM margin_progress
    WHERE creator = ? AND site = ? AND book = ? AND item = ?
  )
  OR (
    SELECT COUNT(*) FROM margin_progress WHERE creator = ? AND site = ? AND book = ?
  ) < ?
ON CONFLICT (creator, site, book, item) DO UPDATE SET
  solved = MAX(margin_progress.solved, excluded.solved),
  solved_at = CASE
    WHEN margin_progress.solved_at IS NULL THEN excluded.solved_at
    WHEN excluded.solved_at IS NULL THEN margin_progress.solved_at
    WHEN excluded.solved_at < margin_progress.solved_at THEN excluded.solved_at
    ELSE margin_progress.solved_at
  END,
  draft = CASE
    WHEN excluded.draft_updated IS NOT NULL
      AND (margin_progress.draft_updated IS NULL
        OR excluded.draft_updated > margin_progress.draft_updated
        OR (excluded.draft_updated = margin_progress.draft_updated
          AND excluded.draft > margin_progress.draft))
    THEN excluded.draft ELSE margin_progress.draft
  END,
  draft_updated = CASE
    WHEN excluded.draft_updated IS NOT NULL
      AND (margin_progress.draft_updated IS NULL
        OR excluded.draft_updated > margin_progress.draft_updated
        OR (excluded.draft_updated = margin_progress.draft_updated
          AND excluded.draft > margin_progress.draft))
    THEN excluded.draft_updated ELSE margin_progress.draft_updated
  END,
  modified = excluded.modified`,
    params: [
      owner,
      site,
      book,
      item.item,
      item.solved ? 1 : 0,
      item.solved ? item.solvedAt : null,
      item.draft,
      item.draft === null ? null : item.draftUpdated,
      now,
      owner,
      site,
      book,
      item.item,
      owner,
      site,
      book,
      cap,
    ],
  }
}
