import { z } from 'zod'
import { isFullCommitId, parseHunks } from '../../annotations/criticmarkup'
import type { Principal } from '../principal'
import { principalKey } from './identity'
import { displayNameFor } from './participants'
import {
  MAX_PROGRESS_ITEMS_PER_BOOK,
  parseProgressBody,
  progressToWire,
  readProgressScope,
  type ProgressScope,
} from './progress'
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ListCursor,
  type MarginRepository,
  type TenantScope,
  type ViewerKey,
} from './repository'
import {
  annotationIdFromIri,
  isTombstoneBody,
  isRepoRelativePath,
  BODY_TOO_LARGE,
  joinSource,
  maxBodyLength,
  motivationForKind,
  recordToWebAnnotation,
  splitSource,
  VISIBILITIES,
  webAnnotationSchema,
  webAnnotationToRecord,
  type MarginVisibility,
  type MarginAnnotationRecord,
} from './web-annotation'

/**
 * The `/api/margin/v1/` route table.
 *
 * Nothing here knows what a database is. Every read and every write goes
 * through `MarginRepository`, and the visibility rule is enforced by the
 * statements that interface runs rather than by anything in this file — there
 * is deliberately no `.filter()` over annotations anywhere below.
 *
 *   GET    /annotations              list, scoped and visibility-filtered
 *   POST   /annotations              create
 *   PATCH  /annotations/:id          owner-scoped update; 403 on another's
 *   DELETE /annotations/:id          owner-scoped delete (204); a note with
 *                                    replies is tombstoned instead (200 + body)
 *   GET    /prefs                    read the caller's default visibility
 *   PATCH  /prefs                    set it; existing rows are never rewritten
 *   GET    /progress?site&book       the caller's own progress in a book
 *   PATCH  /progress?site&book       merge into it; never removes or un-solves
 *   GET    /proposals                list, restricted to `editing`
 *   POST   /proposals/:id/withdraw   owner-scoped; keeps the row (059)
 *   POST   /proposals/:id/apply      501 — issue 060
 *   GET    /documents/:id/history    501 — issue 059
 *
 * `GET /health` is answered by the Worker entry point instead, so that it
 * still reports a running Worker when the database binding is what is missing.
 *
 * Threads (issue 058) are not a route of their own. A reply is a `commenting`
 * annotation whose `margin:parentId` names another `commenting` annotation, so
 * `GET /annotations` already returns a document's threads in the same single
 * query as its annotations, in `(created, id)` order, and a client assembles
 * the tree in memory. The visibility rules compose through that query and the
 * migration's triggers:
 *
 * - A reply to a public note may be private; a public reply to a private note
 *   is refused, by this file and atomically by the database.
 * - A reply to a note the caller cannot read is a 404 identical to a reply to
 *   one that does not exist.
 * - A note cannot be made private while a reply someone else can read hangs
 *   from it, so a reply never outlives its reader's access to the parent's
 *   quote. The database refuses that write (`has_visible_replies`).
 * - Deleting a note with replies tombstones it: see `TOMBSTONE_BODY`.
 * - Every response names each participant by `margin:creatorName`, a
 *   pseudonym, never by an email address.
 */

/** A record as a response carries it: the Web Annotation plus a display name. */
function present(record: MarginAnnotationRecord) {
  return {
    ...recordToWebAnnotation(record),
    'margin:creatorName': displayNameFor(record.creator),
  }
}

const NOT_VISIBLE_MESSAGE = 'no annotation you can see has that id here'

function isTombstone(record: MarginAnnotationRecord): boolean {
  return (
    record.annotation.kind === 'note' &&
    isTombstoneBody(record.annotation.body)
  )
}

export const MARGIN_API_PREFIX = '/api/margin/v1'

export type MarginRouteContext = {
  repository: MarginRepository
  principal: Principal | null
  /** Injected so tests get deterministic timestamps and ids. */
  now: () => string
  newId: () => string
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function json(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  })
}

function problem(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status)
}

function methodNotAllowed(allow: string[]): Response {
  return new Response(null, {
    status: 405,
    headers: { allow: allow.join(', '), ...JSON_HEADERS },
  })
}

/* -------------------------------------------------------------------------- */
/* Tenancy                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The scope comes from the request, never from a constant. A caller supplies
 * either `?source=<absolute URI>` or the `(site, document)` pair directly, so
 * a second site is a different query string rather than a code change.
 */
function readScope(url: URL): TenantScope | { error: Response } {
  const source = url.searchParams.get('source')
  if (source) {
    const split = splitSource(source)
    if (!split) {
      return {
        error: problem(
          400,
          'invalid_source',
          'source must be an absolute http(s) URI',
        ),
      }
    }
    return split
  }

  const site = url.searchParams.get('site')
  const document = url.searchParams.get('document')
  if (!site || !document) {
    return {
      error: problem(
        400,
        'missing_scope',
        'supply either source, or both site and document',
      ),
    }
  }
  // The canonical origin first, then the document joined to *that*. Joining the
  // raw value left `site=https://ernie.sg/` + `document=/chapter` producing
  // `https://ernie.sg//chapter`, which splits back to the document `//chapter`
  // and reads an empty collection — a trailing slash silently addressing a
  // different document than the one written.
  // A document is a path, and it has to say so. Without the leading slash the
  // concatenation can leave the origin entirely: `document=.example.com/x`
  // against `site=https://ernie.sg` is `https://ernie.sg.example.com/x`, which
  // splits back cleanly into a *different tenant* — so a caller could read and
  // write somebody else's site by spelling the pair carefully.
  const origin = document.startsWith('/') ? canonicalOrigin(site) : null
  if (!origin) {
    return {
      error: problem(
        400,
        'invalid_scope',
        'site must be a URL origin and document must begin with /',
      ),
    }
  }
  const split = splitSource(`${origin}${document}`)
  if (!split) {
    return {
      error: problem(
        400,
        'invalid_scope',
        'site must be a URL origin and document must begin with /',
      ),
    }
  }
  return split
}

/** `site` on its own: an origin and nothing else, canonically spelled. */
function canonicalOrigin(site: string): string | null {
  try {
    const url = new URL(site)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    // An origin carries no path, query or fragment, so anything the parser puts
    // in those came from the caller mixing a document into `site`.
    if (url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Whether a store error is the `parent_id` constraint refusing a delete.
 *
 * SQLite and D1 both report it in the message, so this matches on that rather
 * than on a code neither of them promises. Anything else is rethrown, because a
 * store that is genuinely broken must not look like a conflict.
 */
function isForeignKeyConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /FOREIGN KEY constraint failed/i.test(message)
}

function parentVisibilityConflict(status: 400 | 409): Response {
  return problem(
    status,
    'parent_visibility_conflict',
    'a reply must not expose its parent to readers who cannot see it',
  )
}

/** Stable trigger tokens distinguish write races from a broken store. */
function replyVisibilityConflict(error: unknown): Response | null {
  const message = error instanceof Error ? error.message : String(error)
  if (/\bMARGIN_PARENT_VISIBILITY_CONFLICT\b/.test(message)) {
    return parentVisibilityConflict(409)
  }
  if (/\bMARGIN_VISIBLE_REPLIES_CONFLICT\b/.test(message)) {
    return problem(
      409,
      'has_visible_replies',
      'replies visible to other readers prevent making this annotation private',
    )
  }
  return null
}

const MALFORMED_JSON = Symbol('malformed-json')

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return MALFORMED_JSON
  }
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `?limit=` and `?cursor=`, or the refusal to explain why not.
 *
 * A page is always bounded. A document that collects enough annotations would
 * otherwise make one response carry every row, and each row can hold a few
 * kilobytes of bounded body and selector text, so an unbounded collection is a
 * 503 waiting for a popular page rather than a theoretical limit.
 */
function readPage(
  url: URL,
): { limit: number; after?: ListCursor } | { error: Response } {
  const raw = url.searchParams.get('limit')
  let limit = DEFAULT_PAGE_SIZE
  if (raw !== null) {
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
      return {
        error: problem(
          400,
          'invalid_limit',
          `limit must be a whole number between 1 and ${MAX_PAGE_SIZE}`,
        ),
      }
    }
    limit = parsed
  }

  const cursor = url.searchParams.get('cursor')
  if (cursor === null) return { limit }
  const separator = cursor.indexOf(' ')
  const created = separator === -1 ? '' : cursor.slice(0, separator)
  const id = separator === -1 ? '' : cursor.slice(separator + 1)
  if (!created || !id) {
    return {
      error: problem(400, 'invalid_cursor', 'cursor must be one this API returned'),
    }
  }
  return { limit, after: { created, id } }
}

/** The opaque-ish cursor a client sends back. `created` cannot contain a space. */
function encodeCursor(record: { created: string; id: string }): string {
  return `${record.created} ${record.id}`
}

async function listAnnotations(
  url: URL,
  context: MarginRouteContext,
  viewer: ViewerKey,
  motivation?: 'editing',
): Promise<Response> {
  const scope = readScope(url)
  if ('error' in scope) return scope.error
  const page = readPage(url)
  if ('error' in page) return page.error

  // One row more than asked for, so "is there another page" is an observation
  // rather than a second query.
  const records = await context.repository.listAnnotations(scope, viewer, {
    // The review listing leaves withdrawn proposals out; the row, and any
    // thread under it, stays readable through GET /annotations (issue 059).
    ...(motivation ? { motivation, pendingOnly: true } : {}),
    limit: page.limit + 1,
    ...(page.after ? { after: page.after } : {}),
  })
  const rows = records.slice(0, page.limit)
  const more = records.length > page.limit
  const last = rows[rows.length - 1]

  return json({
    annotations: rows.map(present),
    ...(more && last ? { nextCursor: encodeCursor(last) } : {}),
  })
}

async function createAnnotation(
  request: Request,
  context: MarginRouteContext,
  owner: string,
): Promise<Response> {
  const payload = await readJsonBody(request)
  if (payload === MALFORMED_JSON) {
    return problem(400, 'malformed_json', 'the request body is not JSON')
  }

  const parsed = webAnnotationSchema.safeParse(payload)
  if (!parsed.success) {
    const tooLarge = parsed.error.issues.find(
      (entry) =>
        entry.code === 'custom' && entry.params?.code === BODY_TOO_LARGE,
    )
    if (tooLarge) return problem(413, BODY_TOO_LARGE, tooLarge.message)
    const issue = parsed.error.issues[0]
    return problem(
      400,
      'invalid_annotation',
      `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`,
    )
  }

  // Visibility is the caller's stored default unless this annotation names
  // one. The default is read now and copied onto the row, so changing it later
  // cannot reach back and rewrite anything.
  const prefs = await context.repository.getPrefs(owner)
  const visibility: MarginVisibility =
    parsed.data['margin:visibility'] ?? prefs.defaultVisibility

  const now = context.now()
  const mapped = webAnnotationToRecord(parsed.data, {
    id: context.newId(),
    creator: owner,
    visibility,
    created: now,
    modified: now,
  })
  if (!mapped.ok) {
    return problem(400, mapped.error.code, mapped.error.message)
  }
  const record = mapped.value
  const scope: TenantScope = { site: record.site, document: record.document }

  // A highlight or a note may carry a role colour (a note tagged "question",
  // say); a proposal may not, since review shows it as a diff, not a role.
  // Refused rather than stored as null, so nothing the client sent goes
  // missing from the 201 body or a later GET. PATCH applies the same rule.
  if (
    record.annotation.kind === 'proposal' &&
    parsed.data['margin:color'] !== undefined
  ) {
    return problem(400, 'unexpected_color', COLOR_SCOPE_MESSAGE)
  }

  // A reply is a note answering a note (issue 058). Checked before the parent
  // lookup, so it says nothing about whether the parent exists.
  if (record.parentId !== null && record.annotation.kind !== 'note') {
    return problem(
      400,
      'invalid_reply',
      'a reply is an annotation motivated by commenting',
    )
  }

  // A reply must point at an annotation the caller can see in the same
  // tenancy. The lookup is scoped, so a parent id from another site or another
  // document simply does not resolve and the row is never written.
  //
  // 404, and the same 404 `GET /annotations/:id` gives for an id that was
  // never issued: replying to a note the caller cannot read must be
  // indistinguishable from replying to one that does not exist. A 403 or a
  // distinct code here would confirm the note is there.
  if (record.parentId !== null) {
    const parent = await context.repository.findAnnotation(
      scope,
      record.parentId,
      owner,
    )
    if (!parent) {
      return problem(404, 'not_found', NOT_VISIBLE_MESSAGE)
    }
    if (parent.annotation.kind !== 'note') {
      return problem(
        400,
        'invalid_reply',
        'margin:parentId must name an annotation motivated by commenting',
      )
    }
    // Author access does not imply access for everyone who can see the reply.
    if (record.visibility === 'public' && parent.visibility !== 'public') {
      return parentVisibilityConflict(400)
    }
  }

  // The mirror of the delete race: the parent can be deleted between the lookup
  // above and this insert, and `parent_id` then refuses the row. The store is
  // healthy — the parent simply went away — so this is the same answer the
  // caller would have got a moment earlier, not a 503.
  try {
    await context.repository.insertAnnotation(record)
  } catch (error) {
    const conflict = replyVisibilityConflict(error)
    if (conflict) {
      // A deleted parent and one that became unreadable must remain
      // indistinguishable. Recheck through the same tenant/viewer boundary;
      // only a parent still readable by this caller may explain its conflict.
      const parent = record.parentId === null
        ? null
        : await context.repository.findAnnotation(scope, record.parentId, owner)
      if (!parent) {
        return problem(
          409,
          'unknown_parent',
          'the annotation this replies to is no longer available',
        )
      }
      return conflict
    }
    if (isForeignKeyConflict(error)) {
      return problem(
        409,
        'unknown_parent',
        'the annotation this replies to was deleted while this was being written',
      )
    }
    throw error
  }
  // The advertised URI has to be one a client can actually use. The item routes
  // need a scope like every other read, so the header carries the canonical one
  // rather than leaving a caller that follows it with `missing_scope`.
  const source = encodeURIComponent(joinSource(scope.site, scope.document))
  return json(present(record), 201, {
    location:
      `${MARGIN_API_PREFIX}/annotations/${encodeURIComponent(record.id)}` +
      `?source=${source}`,
  })
}

async function readAnnotation(
  context: MarginRouteContext,
  viewer: ViewerKey,
  url: URL,
  id: string,
): Promise<Response> {
  const scope = readScope(url)
  if ('error' in scope) return scope.error

  const found = await context.repository.findAnnotation(scope, id, viewer)
  if (!found) {
    return problem(404, 'not_found', NOT_VISIBLE_MESSAGE)
  }
  return json(present(found))
}

const COLOR_SCOPE_MESSAGE =
  'margin:color applies only to an annotation motivated by highlighting or commenting'

const annotationPatchSchema = z
  .object({
    // Capped by the existing row's motivation below, with a 413.
    body: z.string().min(1).optional(),
    'margin:visibility': z.enum(VISIBILITIES).optional(),
    'margin:color': z.string().min(1).max(64).optional(),
    /** A revised proposal may move to the page's newer base commit. */
    'margin:baseCommit': z.string().min(1).max(128).optional(),
    /** Names the file of a proposal stored before its base was recorded. */
    'margin:sourcePath': z.string().min(1).max(512).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'the patch is empty',
  })

async function patchAnnotation(
  request: Request,
  context: MarginRouteContext,
  owner: string,
  url: URL,
  id: string,
): Promise<Response> {
  const scope = readScope(url)
  if ('error' in scope) return scope.error

  const payload = await readJsonBody(request)
  if (payload === MALFORMED_JSON) {
    return problem(400, 'malformed_json', 'the request body is not JSON')
  }
  const parsed = annotationPatchSchema.safeParse(payload)
  if (!parsed.success) {
    return problem(
      400,
      'invalid_patch',
      parsed.error.issues[0]?.message ?? 'invalid',
    )
  }

  // A highlight has no body and a proposal has no colour. Checking the
  // existing row first turns what the schema would otherwise reject as a
  // constraint violation into an ordinary 400, and keeps the 404 for a row the
  // caller does not own.
  //
  // One the caller can read but did not write is a 403, not a 404: it is on
  // their screen already, so refusing it hides nothing, and issue 058 asks for
  // editing another reader's reply to be refused at the API in so many words.
  // One they cannot read stays a 404, so nothing here tells them it exists.
  const existing = await context.repository.findAnnotation(scope, id, owner)
  if (!existing) {
    return problem(404, 'not_found', 'no annotation of yours has that id here')
  }
  if (existing.creator !== owner) {
    return problem(403, 'forbidden', 'only its author can change an annotation')
  }
  if (isTombstone(existing)) {
    return problem(409, 'deleted', 'this note was deleted and cannot be changed')
  }
  // The tombstone is only ever written by DELETE; an edit that sends it would
  // let a note fake its own deletion, as creation already refuses.
  if (isTombstoneBody(parsed.data.body)) {
    return problem(
      400,
      'reserved_body',
      'that body value is reserved for deleted notes',
    )
  }
  const isHighlight = existing.annotation.kind === 'highlight'
  if (isHighlight && parsed.data.body !== undefined) {
    return problem(
      400,
      'unexpected_body',
      'an annotation motivated by highlighting carries no body',
    )
  }
  if (
    existing.annotation.kind === 'proposal' &&
    parsed.data['margin:color'] !== undefined
  ) {
    return problem(400, 'unexpected_color', COLOR_SCOPE_MESSAGE)
  }
  const isProposal = existing.annotation.kind === 'proposal'
  const baseCommit = parsed.data['margin:baseCommit']
  const sourcePath = parsed.data['margin:sourcePath']
  if (!isProposal && (baseCommit !== undefined || sourcePath !== undefined)) {
    return problem(
      400,
      'unexpected_base_commit',
      'only an annotation motivated by editing names a base commit',
    )
  }
  if (isProposal) {
    if (existing.proposal?.withdrawnAt || existing.withdrawnAt) {
      return problem(
        409,
        'proposal_withdrawn',
        'this proposal was withdrawn from review and cannot be revised',
      )
    }
    if (baseCommit !== undefined && !isFullCommitId(baseCommit)) {
      return problem(
        400,
        'invalid_base_commit',
        'margin:baseCommit must be the full id of the commit the proposal was made against',
      )
    }
    // A proposal stored before its base was recorded is upgraded by its first
    // revision, which names both the base commit and the file; a revision is
    // never made against a guess. A recorded proposal's file never changes.
    if (existing.proposal && sourcePath !== undefined) {
      return problem(
        400,
        'unexpected_source_path',
        'a proposal keeps the source file it was made against',
      )
    }
    if (
      !existing.proposal &&
      (parsed.data.body !== undefined || baseCommit !== undefined || sourcePath !== undefined) &&
      (baseCommit === undefined || sourcePath === undefined)
    ) {
      return problem(
        400,
        'invalid_base_commit',
        'revising this proposal needs margin:baseCommit and margin:sourcePath',
      )
    }
    // Its free-text body is not hunks, so the upgrade must replace it too.
    if (!existing.proposal && baseCommit !== undefined && parsed.data.body === undefined) {
      return problem(
        400,
        'invalid_proposal',
        'upgrading this proposal needs a new body: its hunks against the named base',
      )
    }
    if (sourcePath !== undefined && !isRepoRelativePath(sourcePath)) {
      return problem(
        400,
        'invalid_source_path',
        'margin:sourcePath must be the repo-relative file the proposal patches',
      )
    }
    if (parsed.data.body !== undefined) {
      try {
        parseHunks(parsed.data.body)
      } catch (error) {
        return problem(
          400,
          'invalid_proposal',
          `an edit proposal's body must be its hunks: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  const motivation = motivationForKind(existing.annotation.kind)
  const cap = maxBodyLength(motivation)
  if (parsed.data.body !== undefined && parsed.data.body.length > cap) {
    return problem(
      413,
      BODY_TOO_LARGE,
      `a body motivated by ${motivation} is at most ${cap} characters`,
    )
  }

  if (
    parsed.data['margin:visibility'] === 'public' &&
    existing.parentId !== null
  ) {
    const parent = await context.repository.findAnnotation(
      scope,
      existing.parentId,
      owner,
    )
    if (!parent || parent.visibility !== 'public') {
      return parentVisibilityConflict(409)
    }
  }

  // The database also checks both directions of the reference atomically:
  // publishing a reply and making its parent private cannot race each other.
  let updated: MarginAnnotationRecord | null
  try {
    updated = await context.repository.updateAnnotation(scope, id, owner, {
      ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
      ...(parsed.data['margin:visibility'] !== undefined
        ? { visibility: parsed.data['margin:visibility'] }
        : {}),
      ...(parsed.data['margin:color'] !== undefined
        ? { color: parsed.data['margin:color'] }
        : {}),
      ...(baseCommit !== undefined ? { baseCommit } : {}),
      ...(sourcePath !== undefined ? { sourcePath } : {}),
      // Every change to what a proposal says is a new revision (issue 059), and
      // a review approval binds to the revision it read (060).
      ...(isProposal && (parsed.data.body !== undefined || baseCommit !== undefined)
        ? { reviseProposal: true }
        : {}),
      modified: context.now(),
    })
  } catch (error) {
    const conflict = replyVisibilityConflict(error)
    if (conflict) return conflict
    throw error
  }
  if (!updated) {
    // A revision refused by the pending check lost a race with a withdrawal.
    const now = isProposal ? await context.repository.findAnnotation(scope, id, owner) : null
    if (now?.withdrawnAt) {
      return problem(
        409,
        'proposal_withdrawn',
        'this proposal was withdrawn from review and cannot be revised',
      )
    }
    return problem(404, 'not_found', 'no annotation of yours has that id here')
  }
  return json(present(updated))
}

/**
 * Withdraw one of the caller's own pending proposals from review (issue 059).
 * The row stays: replies to it remain readable, and it can no longer be
 * revised. Answers the withdrawn proposal.
 */
async function withdrawProposal(
  context: MarginRouteContext,
  owner: string,
  url: URL,
  id: string,
): Promise<Response> {
  const scope = readScope(url)
  if ('error' in scope) return scope.error
  const existing = await context.repository.findAnnotation(scope, id, owner)
  if (!existing || existing.annotation.kind !== 'proposal') {
    return problem(404, 'not_found', 'no proposal of yours has that id here')
  }
  if (existing.creator !== owner) {
    return problem(403, 'forbidden', 'only its author can withdraw a proposal')
  }
  if (existing.proposal?.withdrawnAt || existing.withdrawnAt) {
    return problem(409, 'proposal_withdrawn', 'this proposal is already withdrawn')
  }
  const withdrawn = await context.repository.withdrawProposal(
    scope,
    id,
    owner,
    context.now(),
  )
  if (!withdrawn) {
    return problem(404, 'not_found', 'no proposal of yours has that id here')
  }
  const updated = await context.repository.findAnnotation(scope, id, owner)
  return updated
    ? json(present(updated))
    : problem(404, 'not_found', 'no proposal of yours has that id here')
}

async function deleteAnnotation(
  context: MarginRouteContext,
  owner: string,
  url: URL,
  id: string,
): Promise<Response> {
  const scope = readScope(url)
  if ('error' in scope) return scope.error

  // Ownership first, and only then the reply count. The other way round, a 409
  // and a 404 differ for an annotation the caller cannot see, which tells them
  // it exists and whether anybody has replied to it — an oracle over exactly
  // what the visibility predicate hides.
  const own = await context.repository.findAnnotation(scope, id, owner)
  if (!own || own.creator !== owner) {
    return problem(404, 'not_found', 'no annotation of yours has that id here')
  }

  // A reply belongs to whoever wrote it. Cascading a parent's delete through
  // its children would let the parent's owner destroy other people's
  // annotations, which no owner-scoped delete should be able to do. A note with
  // replies is tombstoned instead (issue 058): its body is replaced, the row
  // and the thread under it stay readable. Anything else with replies — only a
  // row written before replies had to be notes can be one — still refuses.
  if (await context.repository.countReplies(scope, id)) {
    return tombstoneOrRefuse(context, scope, own, owner)
  }

  // A reply can arrive between the count above and the delete below. The
  // constraint catches it, and the note is tombstoned exactly as it would have
  // been had the reply arrived a moment earlier, rather than escaping as the
  // Worker's generic 503.
  let removed: boolean
  try {
    removed = await context.repository.deleteAnnotation(scope, id, owner)
  } catch (error) {
    if (isForeignKeyConflict(error)) {
      return tombstoneOrRefuse(context, scope, own, owner)
    }
    throw error
  }
  if (!removed) {
    return problem(404, 'not_found', 'no annotation of yours has that id here')
  }
  return new Response(null, { status: 204, headers: JSON_HEADERS })
}

async function tombstoneOrRefuse(
  context: MarginRouteContext,
  scope: TenantScope,
  own: MarginAnnotationRecord,
  owner: string,
): Promise<Response> {
  if (own.annotation.kind !== 'note') {
    return problem(
      409,
      'has_replies',
      'other people have replied to this; deleting it would delete their replies',
    )
  }
  // Deleting a tombstone that still has replies changes nothing, and says so
  // the same way the first delete did.
  if (
    !isTombstone(own) &&
    !(await context.repository.tombstoneAnnotation(
      scope,
      own.id,
      owner,
      context.now(),
    ))
  ) {
    return problem(404, 'not_found', 'no annotation of yours has that id here')
  }
  // 200 with the tombstone, where an outright delete is a bare 204. The caller
  // cannot tell the two apart from the replies it can see: a private reply
  // from another reader is invisible to it and still keeps the note.
  const tombstoned = await context.repository.findAnnotation(scope, own.id, owner)
  if (!tombstoned) {
    return problem(404, 'not_found', 'no annotation of yours has that id here')
  }
  return json(present(tombstoned))
}

const prefsPatchSchema = z
  .object({ defaultVisibility: z.enum(VISIBILITIES) })
  .strict()

async function readPrefs(
  context: MarginRouteContext,
  owner: string,
): Promise<Response> {
  const prefs = await context.repository.getPrefs(owner)
  // `creator` is the value this caller's annotations carry, so a client can
  // tell its own rows from others' without re-deriving the principal key.
  return json({ defaultVisibility: prefs.defaultVisibility, creator: owner })
}

async function writePrefs(
  request: Request,
  context: MarginRouteContext,
  owner: string,
): Promise<Response> {
  const payload = await readJsonBody(request)
  if (payload === MALFORMED_JSON) {
    return problem(400, 'malformed_json', 'the request body is not JSON')
  }
  const parsed = prefsPatchSchema.safeParse(payload)
  if (!parsed.success) {
    return problem(
      400,
      'invalid_prefs',
      `defaultVisibility must be one of ${VISIBILITIES.join(', ')}`,
    )
  }
  const prefs = await context.repository.setDefaultVisibility(
    owner,
    parsed.data.defaultVisibility,
    context.now(),
  )
  return json({ defaultVisibility: prefs.defaultVisibility, creator: owner })
}

async function readProgress(
  url: URL,
  context: MarginRouteContext,
  owner: string,
): Promise<Response> {
  const scope = readProgressScope(url)
  if ('status' in scope) return problem(scope.status, scope.code, scope.message)
  const rows = await context.repository.listProgress(owner, scope)
  return json(progressToWire(scope.book, rows))
}

async function writeProgress(
  request: Request,
  url: URL,
  context: MarginRouteContext,
  owner: string,
): Promise<Response> {
  const scope: ProgressScope | { status: 400 | 413; code: string; message: string } =
    readProgressScope(url)
  if ('status' in scope) return problem(scope.status, scope.code, scope.message)
  const now = context.now()
  const items = parseProgressBody(await request.text(), now)
  if ('status' in items) return problem(items.status, items.code, items.message)

  // Bounded per reader and book. An item already held can always change; only
  // new ones count against the cap, so a full book still records solves.
  const held = new Set(
    (await context.repository.listProgress(owner, scope)).map((row) => row.item),
  )
  const added = items.filter((item) => !held.has(item.item)).length
  if (held.size + added > MAX_PROGRESS_ITEMS_PER_BOOK) {
    return problem(
      413,
      'too_many_items',
      `a book holds at most ${MAX_PROGRESS_ITEMS_PER_BOOK} items of progress`,
    )
  }

  // The check above answers the common case with nothing written; this one is
  // what holds under concurrent requests, inside each statement.
  const refused = await context.repository.mergeProgress(
    owner,
    scope,
    items,
    now,
    MAX_PROGRESS_ITEMS_PER_BOOK,
  )
  if (refused > 0) {
    return problem(
      413,
      'too_many_items',
      `a book holds at most ${MAX_PROGRESS_ITEMS_PER_BOOK} items of progress; ${refused} new item(s) were not stored`,
    )
  }
  const rows = await context.repository.listProgress(owner, scope)
  return json(progressToWire(scope.book, rows))
}

function notImplemented(issue: string): Response {
  return json(
    {
      error: {
        code: 'not_implemented',
        message: `this route lands in issue ${issue}`,
      },
    },
    501,
  )
}

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The path, decoded, or `null` when it cannot be.
 *
 * `decodeURIComponent` throws `URIError` on a malformed escape such as a bare
 * `%`, and an uncaught throw here is a 500 on a public request. A path that
 * cannot be decoded matches no route, so it is a 404 like any other.
 */
function segments(pathname: string): string[] | null {
  try {
    return pathname
      .slice(MARGIN_API_PREFIX.length)
      .split('/')
      .filter((part) => part.length > 0)
      .map((part) => decodeURIComponent(part))
  } catch {
    return null
  }
}

function unauthenticated(): Response {
  return problem(401, 'unauthenticated', 'this route needs a signed-in caller')
}

export async function handleMarginRequest(
  request: Request,
  context: MarginRouteContext,
): Promise<Response> {
  const url = new URL(request.url)
  const path = segments(url.pathname)
  if (!path) return problem(404, 'not_found', 'no such margin route')
  const method = request.method === 'HEAD' ? 'GET' : request.method
  const owner = context.principal ? principalKey(context.principal) : null

  if (path.length === 1 && path[0] === 'annotations') {
    if (method === 'GET') return listAnnotations(url, context, owner)
    if (method === 'POST') {
      if (!owner) return unauthenticated()
      return createAnnotation(request, context, owner)
    }
    return methodNotAllowed(['GET', 'HEAD', 'POST'])
  }

  if (path.length === 2 && path[0] === 'annotations') {
    // Either spelling of the same annotation, the same as `margin:parentId`
    // takes: every response carries `urn:margin:annotation:<uuid>` as its `id`,
    // so that is what a client has in hand, and requiring the bare key here
    // meant the identifier the API hands out did not work in its own URLs.
    const id = annotationIdFromIri(path[1])
    // The `Location` header a POST returns points here, so this has to answer.
    // Visibility-scoped like the collection: the caller's own annotation or
    // anybody's public one, and nothing else.
    if (method === 'GET') return readAnnotation(context, owner, url, id)
    if (!owner) return unauthenticated()
    if (method === 'PATCH') {
      return patchAnnotation(request, context, owner, url, id)
    }
    if (method === 'DELETE') {
      return deleteAnnotation(context, owner, url, id)
    }
    return methodNotAllowed(['GET', 'PATCH', 'DELETE'])
  }

  if (path.length === 1 && path[0] === 'prefs') {
    if (!owner) return unauthenticated()
    if (method === 'GET') return readPrefs(context, owner)
    if (method === 'PATCH') return writePrefs(request, context, owner)
    return methodNotAllowed(['GET', 'HEAD', 'PATCH'])
  }

  if (path.length === 1 && path[0] === 'progress') {
    // Private by construction: there is no way to name another reader.
    if (!owner) return unauthenticated()
    if (method === 'GET') return readProgress(url, context, owner)
    if (method === 'PATCH') return writeProgress(request, url, context, owner)
    return methodNotAllowed(['GET', 'HEAD', 'PATCH'])
  }

  if (path.length === 1 && path[0] === 'proposals') {
    if (method !== 'GET') return methodNotAllowed(['GET', 'HEAD'])
    return listAnnotations(url, context, owner, 'editing')
  }

  if (path.length === 3 && path[0] === 'proposals' && path[2] === 'withdraw') {
    if (method !== 'POST') return methodNotAllowed(['POST'])
    if (!owner) return unauthenticated()
    return withdrawProposal(context, owner, url, annotationIdFromIri(path[1]))
  }

  if (path.length === 3 && path[0] === 'proposals' && path[2] === 'apply') {
    if (method !== 'POST') return methodNotAllowed(['POST'])
    return notImplemented('060')
  }

  if (path.length === 3 && path[0] === 'documents' && path[2] === 'history') {
    if (method !== 'GET') return methodNotAllowed(['GET', 'HEAD'])
    return notImplemented('059')
  }

  return problem(404, 'not_found', 'no such margin route')
}
