import {
  MAX_PAGE_SIZE,
  type ListOptions,
  type OwnListOptions,
  type ReviewListOptions,
  type TenantScope,
  type ViewerKey,
  type ProposalReview,
} from './repository'
import type { Principal } from '../principal'
import { principalKey } from './identity'

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
  principal?: Principal | null,
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
      publicWhere.push('withdrawn_at IS NULL', noApplication)
      privateWhere.push('withdrawn_at IS NULL', noApplication)
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
    return projectProposalState({
      sql: `SELECT ${ANNOTATION_COLUMNS} FROM margin_annotations INDEXED BY ${publicIndex}
WHERE ${publicWhere.join(' AND ')}
UNION ALL
SELECT ${ANNOTATION_COLUMNS} FROM margin_annotations INDEXED BY ${privateIndex}
WHERE ${privateWhere.join(' AND ')}
ORDER BY created ASC, id ASC LIMIT ?`,
      params: [...publicParams, ...privateParams, limit],
    }, viewer, principal)
  }

  const extraSql: string[] = []
  const extraParams: unknown[] = []
  if (options.motivation) {
    extraSql.push('AND motivation = ?')
    extraParams.push(options.motivation)
  }
  if (options.pendingOnly) extraSql.push('AND withdrawn_at IS NULL', `AND ${noApplication}`)
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
  return projectProposalState(scopedRead(scope, viewer, extraSql, extraParams), viewer, principal)
}

/**
 * The owner's own annotations on every document of `site` whose path starts
 * with `prefix` (issue 073), in `(document, created, id)` order.
 *
 * `creator = ?` is the whole visibility rule here: it is the first column of
 * `margin_annotations_owner_keyset (creator, site, document, created, id)`
 * (migration 0005), so another creator's row is never read, public or not.
 * The prefix is a range on `document` rather than a `LIKE`, so the same index
 * serves it, and its trailing `(created, id)` gives the page order without a
 * sort: every path starting with `prefix` sorts at or after it and before its
 * successor. The route only accepts a
 * prefix ending in `/`, so the successor is the same string ending in `0`.
 */
export function listOwnAnnotationsQuery(
  site: string,
  prefix: string,
  creator: string,
  options: OwnListOptions,
): Query {
  const upper = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`
  // A later page starts at its cursor rather than at the prefix: the cursor
  // row is under the prefix already, so the row value is the lower bound and
  // the index seeks straight to it instead of filtering the rows before it.
  const where = options.after
    ? ['creator = ? AND site = ? AND (document, created, id) > (?, ?, ?) AND document < ?']
    : ['creator = ? AND site = ? AND document >= ? AND document < ?']
  const params: unknown[] = options.after
    ? [creator, site, options.after.document, options.after.created, options.after.id, upper]
    : [creator, site, prefix, upper]
  return projectProposalState({
    sql: `SELECT ${ANNOTATION_COLUMNS} FROM margin_annotations INDEXED BY margin_annotations_owner_keyset
WHERE ${where.join(' AND ')}
ORDER BY document ASC, created ASC, id ASC LIMIT ?`,
    params: [...params, Math.min(options.limit, MAX_PAGE_SIZE + 1)],
  }, creator, undefined, true)
}

/**
 * Authority and page share one SQLite/D1 statement snapshot. Returning tagged
 * authority rows preserves forbidden versus authorized-empty without a second
 * check that can race revocation. Private rows are gated inside the page CTE.
 */
export function listReviewProposalsQuery(principal: Principal, options: ReviewListOptions): Query {
  const where = [
    "motivation = 'editing' AND withdrawn_at IS NULL",
    options.state && options.state !== 'pending' ? 'EXISTS (SELECT 1 FROM margin_proposal_applications WHERE proposal_id = margin_annotations.id AND state = ?)' : noApplication,
    "EXISTS (SELECT 1 FROM review_authority WHERE review_role = 'admin' AND review_site = margin_annotations.site)",
  ]
  const params: unknown[] = [principal.provider, principal.issuer, principal.subject, ...(options.state && options.state !== 'pending' ? [options.state] : [])]
  if (options.site !== undefined) {
    where.push('site = ?')
    params.push(options.site)
  }
  if (options.document !== undefined) {
    where.push('document = ?')
    params.push(options.document)
  }
  if (options.after) {
    where.push('(created, id) > (?, ?)')
    params.push(options.after.created, options.after.id)
  }
  return {
    sql: `WITH review_authority AS (
  SELECT identity.id AS review_identity_id, allowlist.role AS review_role, mapping.site AS review_site
  FROM margin_identity AS identity
  LEFT JOIN margin_allowlist AS allowlist ON allowlist.identity_id = identity.id
  LEFT JOIN margin_site_admins AS mapping ON mapping.identity_id = identity.id
  WHERE identity.provider = ? AND identity.issuer = ? AND identity.subject = ?
), review_page AS (
  SELECT ${ANNOTATION_COLUMNS},
    (SELECT state FROM margin_proposal_applications WHERE proposal_id = margin_annotations.id) AS proposal_state,
    (SELECT revision FROM margin_proposal_applications WHERE proposal_id = margin_annotations.id) AS approved_revision
  FROM margin_annotations
  WHERE ${where.join(' AND ')}
  ORDER BY created ASC, id ASC LIMIT ?
)
SELECT 'authority' AS review_kind, review_identity_id, review_role, review_site,
  ${ANNOTATION_COLUMNS.split(', ').map(column => `NULL AS ${column}`).join(', ')}, NULL AS proposal_state, NULL AS approved_revision
FROM review_authority
UNION ALL
SELECT 'annotation' AS review_kind, NULL, NULL, NULL, ${ANNOTATION_COLUMNS}, proposal_state, approved_revision
FROM review_page
ORDER BY review_kind DESC, created ASC, id ASC`,
    params: [...params, Math.min(options.limit, MAX_PAGE_SIZE + 1)],
  }
}

export function findAnnotationQuery(
  scope: TenantScope,
  id: string,
  viewer: ViewerKey,
  principal?: Principal | null,
): Query {
  return projectProposalState(scopedRead(scope, viewer, ['AND id = ?', 'LIMIT 1'], [id]), viewer, principal)
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

export function findIdempotencyReceiptQuery(
  scope: TenantScope,
  owner: string,
  key: string,
): Query {
  return {
    sql: `SELECT fingerprint, annotation_id FROM margin_idempotency_receipts
WHERE creator = ? AND site = ? AND document = ? AND request_key = ? LIMIT 1`,
    params: [owner, scope.site, scope.document, key],
  }
}

export function insertIdempotencyReceiptQuery(receipt: {
  creator: string
  site: string
  document: string
  key: string
  fingerprint: string
  annotationId: string
  created: string
}): Query {
  return {
    sql: `INSERT INTO margin_idempotency_receipts
(creator, site, document, request_key, fingerprint, annotation_id, created)
VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [
      receipt.creator,
      receipt.site,
      receipt.document,
      receipt.key,
      receipt.fingerprint,
      receipt.annotationId,
      receipt.created,
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
  // Current creator content remains mutable after approval; only withdrawal
  // stops revision. The separate application snapshot is never updated here.
  const pending = patch.reviseProposal ? ' AND withdrawn_at IS NULL' : ''
  return {
    sql: `UPDATE margin_annotations SET ${assignments.join(', ')}
WHERE site = ? AND document = ? AND id = ? AND creator = ?${pending}`,
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
WHERE site = ? AND document = ? AND id = ? AND creator = ? AND motivation = 'editing' AND withdrawn_at IS NULL AND ${noApplication}`,
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
WHERE site = ? AND document = ? AND id = ? AND creator = ? AND ${noApplication}`,
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


const noApplication = 'NOT EXISTS (SELECT 1 FROM margin_proposal_applications WHERE proposal_id = margin_annotations.id)'

/** Principal is authenticated composition input; the viewer key alone grants no admin read. */
function adminPredicate(site: string): string {
  return `EXISTS (SELECT 1 FROM margin_identity AS identity
    JOIN margin_allowlist AS allowlist ON allowlist.identity_id = identity.id AND allowlist.role = 'admin'
    JOIN margin_site_admins AS mapping ON mapping.identity_id = identity.id
    WHERE identity.provider = ? AND identity.issuer = ? AND identity.subject = ? AND mapping.site = ${site})`
}

export function projectProposalState(query: Query, viewer: ViewerKey, principal?: Principal | null, own = false): Query {
  if (principal && principalKey(principal) !== viewer) throw new Error('viewer/principal mismatch')
  const permission = principal ? `(visible.creator = ? OR ${adminPredicate('visible.site')})` : 'visible.creator = ?'
  const context = principal ? [viewer, principal.provider, principal.issuer, principal.subject] : [viewer]
  // Anonymous reads do not reference identity storage at all. Only state is projected;
  // review metadata and snapshot contents never enter ordinary public rows.
  return {
    sql: `SELECT visible.*, application.state AS proposal_state
      FROM (${query.sql}) AS visible
      LEFT JOIN margin_proposal_applications AS application ON application.proposal_id = visible.id AND ${permission}
      ORDER BY ${own ? 'visible.document ASC, ' : ''}visible.created ASC, visible.id ASC`,
    params: [...query.params, ...context],
  }
}

export function reviewMutationQuery(scope: TenantScope, id: string, principal: Principal,
  input: ProposalReview | { revision: number }, at: string, apply: boolean): Query {
  const binding = [scope.site, scope.document, id, input.revision, principal.provider, principal.issuer, principal.subject]
  const where = `site = ? AND document = ? AND id = ? AND revision = ?
    AND motivation = 'editing' AND withdrawn_at IS NULL AND ${noApplication}
    AND ${adminPredicate('margin_annotations.site')}
    AND base_commit IS NOT NULL AND source_path IS NOT NULL`
  if (apply) return {
    sql: `INSERT INTO margin_proposal_applications
      (proposal_id,site,document,creator,visibility,body,base_commit,source_path,revision,approved_by,approved_at,state)
      SELECT id,site,document,creator,visibility,body,base_commit,source_path,revision,?,?,'approved'
      FROM margin_annotations WHERE ${where}
      RETURNING proposal_id,site,document,creator,visibility,body,base_commit,source_path,revision,approved_by,approved_at,state`,
    params: [principalKey(principal), at, ...binding],
  }
  const review = input as ProposalReview
  const revised = review.body !== undefined || review.baseCommit !== undefined
  return {
    sql: `UPDATE margin_annotations SET review_decision=?, review_comments=?, reviewed_by=?, reviewed_at=?,
      reviewed_revision=revision+?, modified=?, body=COALESCE(?,body), base_commit=COALESCE(?,base_commit), revision=revision+?
      WHERE ${where}
      RETURNING ${ANNOTATION_COLUMNS}`,
    params: [review.decision,review.comments,principalKey(principal),at,Number(revised),at,review.body ?? null,review.baseCommit ?? null,Number(revised),...binding],
  }
}

/** One snapshot distinguishes revoked authority from a missing/nonpending row. */
export function reviewTargetQuery(scope: TenantScope, id: string, principal: Principal): Query {
  return {
    sql: `SELECT ${adminPredicate('?')} AS authorized,
      (SELECT json_object(${ANNOTATION_COLUMNS.split(', ').map(column => `'${column}', ${column}`).join(', ')}, 'proposal_state', (SELECT state FROM margin_proposal_applications WHERE proposal_id=margin_annotations.id), 'approved_revision', (SELECT revision FROM margin_proposal_applications WHERE proposal_id=margin_annotations.id))
       FROM margin_annotations WHERE site=? AND document=? AND id=? AND motivation='editing'
       AND ${adminPredicate('margin_annotations.site')}) AS annotation`,
    params: [principal.provider,principal.issuer,principal.subject,scope.site,
      scope.site,scope.document,id,principal.provider,principal.issuer,principal.subject],
  }
}

/** Privileged readback only: review metadata never enters ordinary projections. */
export function reviewReadbackQuery(scope: TenantScope, id: string, principal: Principal, includeExecution = false): Query {
  return {
    sql: `SELECT ${adminPredicate('?')} AS authorized,
      (SELECT json_object(
        'annotation', json_object(${ANNOTATION_COLUMNS.split(', ').map(column => `'${column}', ${column}`).join(', ')},
          'proposal_state', (SELECT state FROM margin_proposal_applications WHERE proposal_id=margin_annotations.id),
          'approved_revision', (SELECT revision FROM margin_proposal_applications WHERE proposal_id=margin_annotations.id)),
        'saved_review', json_object('review_decision',review_decision,'review_comments',review_comments,
          'reviewed_revision',reviewed_revision,'reviewed_by',reviewed_by,'reviewed_at',reviewed_at)${includeExecution ? `,
        'application', (SELECT json_set(${reportTargetJson},'$.document',p.document)
          FROM margin_proposal_applications p LEFT JOIN margin_proposal_execution e ON e.proposal_id=p.proposal_id
          WHERE p.proposal_id=margin_annotations.id)` : ''})
       FROM margin_annotations WHERE site=? AND document=? AND id=? AND motivation='editing'
       AND ${adminPredicate('margin_annotations.site')}) AS review`,
    params: [principal.provider,principal.issuer,principal.subject,scope.site,
      scope.site,scope.document,id,principal.provider,principal.issuer,principal.subject],
  }
}

/** Selector is public lookup material, not authentication by itself. */
export function adapterCredentialQuery(tokenId: string): Query {
  return {
    sql: `SELECT t.token_id, t.site, t.adapter, t.token_sha256, t.capability,
      t.created_at, t.revoked_at, a.enabled, a.created_at AS registration_created_at
      FROM margin_adapter_tokens t JOIN margin_adapters a ON a.site=t.site AND a.adapter=t.adapter
      WHERE t.token_id=? LIMIT 2`,
    params: [tokenId],
  }
}

export function approvedFeedQuery(
  credential: import('./repository').AdapterCredential,
  options: import('./repository').ApprovedFeedOptions,
): Query {
  const after = options.after
  const columns =
    'proposal_id, site, document, visibility, body, base_commit, source_path, revision, approved_at, state'
  return {
    sql: `WITH authority AS (
      SELECT t.site FROM margin_adapter_tokens t
      JOIN margin_adapters a ON a.site=t.site AND a.adapter=t.adapter
      WHERE t.token_id=? AND t.token_sha256=? AND t.site=? AND t.adapter=?
        AND t.capability='approved_feed' AND t.revoked_at IS NULL AND a.enabled=1
    ), page AS (
      SELECT ${columns
        .split(', ')
        .map((x) => `p.${x}`)
        .join(', ')}
      FROM margin_proposal_applications p JOIN authority ON authority.site=p.site
      WHERE p.state='approved'${after ? ' AND (p.approved_at > ? OR (p.approved_at = ? AND p.proposal_id > ?))' : ''}
      ORDER BY p.approved_at ASC, p.proposal_id ASC LIMIT ?
    )
    SELECT 'authority' AS kind, CASE WHEN EXISTS(SELECT 1 FROM authority) THEN 1 ELSE 0 END AS authorized,
      ${columns
        .split(', ')
        .map((x) => `NULL AS ${x}`)
        .join(', ')}
    UNION ALL SELECT 'item' AS kind, 1 AS authorized, ${columns} FROM page
    ORDER BY kind ASC, approved_at ASC, proposal_id ASC`,
    params: [
      credential.tokenId,
      credential.tokenSha256,
      credential.site,
      credential.adapter,
      ...(after ? [after.approvedAt, after.approvedAt, after.proposalId] : []),
      options.limit,
    ],
  }
}


// Report capability is explicit and current-token-specific. This predicate is
// shared by mutation, no-row classification and response-loss receipt recovery.
const reportAuthority = `SELECT t.site,t.adapter FROM margin_adapter_tokens t
  JOIN margin_adapters a ON a.site=t.site AND a.adapter=t.adapter
  JOIN margin_adapter_report_grants g ON g.token_id=t.token_id
    AND g.token_sha256=t.token_sha256 AND g.site=t.site AND g.adapter=t.adapter
  WHERE t.token_id=? AND t.token_sha256=? AND t.site=? AND t.adapter=?
    AND t.capability='approved_feed' AND t.revoked_at IS NULL AND a.enabled=1 AND g.revoked_at IS NULL`
function reportAuthorityParams(c: import('./repository').AdapterCredential) {
  return [c.tokenId, c.tokenSha256, c.site, c.adapter]
}
export const REPORT_RECEIPT_COLUMNS =
  'site, adapter, event_id, proposal_id, approved_revision, expected_version, fingerprint, accepted_at, state_version, failed_apply_count, state, pr_number, pr_url, pr_head, checks, detail, merge_commit'
const executionColumns =
  'proposal_id, site, approved_revision, state_version, failed_apply_count, bound_adapter, pr_number, pr_url, pr_head, checks, detail, merge_commit, last_event, updated_at'
const reportTargetJson = `json_object('proposal_id',p.proposal_id,'site',p.site,'revision',p.revision,'approved_at',p.approved_at,'state',p.state,
  'execution',CASE WHEN e.proposal_id IS NULL THEN NULL ELSE json_object(${executionColumns
    .split(', ')
    .map((c) => `'${c}',e.${c}`)
    .join(',')}) END)`

/** One scoped snapshot. A NULL target never distinguishes foreign from absent. */
export function adapterReportSnapshotQuery(
  c: import('./repository').AdapterCredential,
  eventId: string,
  proposalId?: string,
): Query {
  return {
    sql: `WITH authority AS (${reportAuthority})
    SELECT CASE WHEN EXISTS(SELECT 1 FROM authority) THEN 1 ELSE 0 END AS authorized,
      (SELECT json_object(${REPORT_RECEIPT_COLUMNS.split(', ')
        .map((c) => `'${c}',r.${c}`)
        .join(',')})
       FROM margin_adapter_report_receipts r JOIN authority a ON a.site=r.site AND a.adapter=r.adapter WHERE r.event_id=?) AS receipt,
      (SELECT ${reportTargetJson} FROM margin_proposal_applications p
       JOIN authority a ON a.site=p.site LEFT JOIN margin_proposal_execution e ON e.proposal_id=p.proposal_id
       WHERE p.proposal_id=?) AS target`,
    params: [...reportAuthorityParams(c), eventId, proposalId ?? null],
  }
}

export function insertAdapterReportQuery(
  c: import('./repository').AdapterCredential,
  report: import('./repository').AdapterExecutionReport,
  fingerprint: string,
  at: string,
  exactTarget: string,
): Query {
  const o = report.outcome,
    pr = 'pr' in o ? o.pr : null
  const retained = o.state === 'conflict'
  const projection = [pr?.number ?? null, pr?.url ?? null, pr?.head ?? null]
  return {
    // The complete decoded snapshot is compared inside the write as well as CAS.
    // No metadata repair, authority fallback or stale pre-read can authorize it.
    sql: `INSERT INTO margin_adapter_report_receipts(${REPORT_RECEIPT_COLUMNS})
      WITH authority AS (${reportAuthority})
      SELECT p.site,a.adapter,?,p.proposal_id,p.revision,e.state_version,?,?,
        e.state_version+1,e.failed_apply_count+CASE WHEN ?='apply_failed' THEN 1 ELSE 0 END,?,
        ${retained ? 'e.pr_number,e.pr_url,e.pr_head' : '?,?,?'},
        ${retained ? "CASE WHEN e.pr_number IS NULL THEN NULL ELSE 'not_evaluated' END" : '?'},?,?
      FROM margin_proposal_applications p JOIN authority a ON a.site=p.site
      JOIN margin_proposal_execution e ON e.proposal_id=p.proposal_id AND e.site=p.site AND e.approved_revision=p.revision
      WHERE p.proposal_id=? AND p.revision=? AND e.state_version=? AND e.state_version<9007199254740991
        AND (e.bound_adapter IS NULL OR e.bound_adapter=a.adapter)
        AND p.state IN ('approved','pr_open','conflict','apply_failed')
        AND (?!='apply_failed' OR (e.pr_number IS NULL AND e.failed_apply_count<3))
        AND (e.pr_number IS NULL OR ? IS NULL OR (e.pr_number=? AND e.pr_url=?))
        AND ${reportTargetJson}=?
        AND NOT EXISTS(SELECT 1 FROM margin_adapter_report_receipts r WHERE r.site=p.site AND r.adapter=a.adapter AND r.event_id=?)
      RETURNING ${REPORT_RECEIPT_COLUMNS}`,
    params: [
      ...reportAuthorityParams(c),
      report.eventId,
      fingerprint,
      at,
      o.state,
      o.state,
      ...(retained ? [] : projection),
      ...(retained ? [] : [o.state === 'pr_open' ? o.checks : null]),
      'detail' in o ? o.detail : null,
      o.state === 'merged' ? o.mergeCommit : null,
      report.proposalId,
      report.approvedRevision,
      report.expectedStateVersion,
      o.state,
      pr?.number ?? null,
      pr?.number ?? null,
      pr?.url ?? null,
      exactTarget,
      report.eventId,
    ],
  }
}


/** Candidate scan is tenant-scoped, before any execution eligibility filtering. */
export function adapterWorkQuery(
  credential: import('./repository').AdapterCredential,
  options: import('./repository').ApprovedFeedOptions,
): Query {
  const columns =
    'proposal_id, site, document, visibility, body, base_commit, source_path, revision, approved_at, state'
  const after = options.after
  return {
    sql: `WITH authority AS (${reportAuthority}), page AS (
      SELECT ${columns
        .split(', ')
        .map((c) => `p.${c}`)
        .join(', ')},
        CASE WHEN e.proposal_id IS NULL THEN NULL ELSE json_object(${executionColumns
          .split(', ')
          .map((c) => `'${c}',e.${c}`)
          .join(',')}) END AS execution
      FROM margin_proposal_applications p JOIN authority a ON a.site=p.site
      LEFT JOIN margin_proposal_execution e ON e.proposal_id=p.proposal_id
      WHERE p.state IN ('approved','pr_open','conflict','apply_failed')
        ${after ? 'AND (p.approved_at > ? OR (p.approved_at = ? AND p.proposal_id > ?))' : ''}
      ORDER BY p.approved_at ASC,p.proposal_id ASC LIMIT ?
    )
    SELECT 'authority' AS kind, CASE WHEN EXISTS(SELECT 1 FROM authority) THEN 1 ELSE 0 END AS authorized,
      ${columns
        .split(', ')
        .map((c) => `NULL AS ${c}`)
        .join(', ')}, NULL AS execution
    UNION ALL SELECT 'item' AS kind,1 AS authorized,${columns},execution FROM page
    ORDER BY kind ASC,approved_at ASC,proposal_id ASC`,
    params: [
      ...reportAuthorityParams(credential),
      ...(after ? [after.approvedAt, after.approvedAt, after.proposalId] : []),
      options.limit,
    ],
  }
}


/** Public registration only: no private annotation, credential or application join. */
export function historyRegistrationQuery(site: string): Query {
  return {
    sql: 'SELECT site, adapter, enabled, created_at, history_location FROM margin_adapters WHERE site = ?',
    params: [site],
  }
}
