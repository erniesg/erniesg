import { z } from 'zod'
import type { Principal } from '../principal'
import { principalKey } from './identity'
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
  joinSource,
  recordToWebAnnotation,
  splitSource,
  VISIBILITIES,
  webAnnotationSchema,
  webAnnotationToRecord,
  type MarginVisibility,
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
 *   PATCH  /annotations/:id          owner-scoped update
 *   DELETE /annotations/:id          owner-scoped delete
 *   GET    /prefs                    read the caller's default visibility
 *   PATCH  /prefs                    set it; existing rows are never rewritten
 *   GET    /proposals                list, restricted to `editing`
 *   POST   /proposals/:id/apply      501 — issue 060
 *   GET    /documents/:id/history    501 — issue 059
 *
 * `GET /health` is answered by the Worker entry point instead, so that it
 * still reports a running Worker when the database binding is what is missing.
 */

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
  const split = splitSource(`${site}${document}`)
  // The canonical pair, not the one that was sent — the same normalisation POST
  // and `?source=` go through. Validating the concatenation and then querying
  // the raw spelling meant `site=https://ERNIE.SG` or `site=https://ernie.sg:443`
  // read an empty collection while writing to the canonical tenant.
  if (!split || split.site !== canonicalOrigin(site)) {
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
    ...(motivation ? { motivation } : {}),
    limit: page.limit + 1,
    ...(page.after ? { after: page.after } : {}),
  })
  const rows = records.slice(0, page.limit)
  const more = records.length > page.limit
  const last = rows[rows.length - 1]

  return json({
    annotations: rows.map(recordToWebAnnotation),
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

  // PATCH already refuses this pair. Creation used to accept `margin:color` on a
  // note or a proposal and then store `null`, so the 201 body and every later GET
  // came back missing a field the client had sent. Same rule in both places.
  if (
    record.annotation.kind !== 'highlight' &&
    parsed.data['margin:color'] !== undefined
  ) {
    return problem(
      400,
      'unexpected_color',
      'margin:color applies only to an annotation motivated by highlighting',
    )
  }

  // A reply must point at an annotation the caller can see in the same
  // tenancy. The lookup is scoped, so a parent id from another site or another
  // document simply does not resolve and the row is never written.
  if (record.parentId !== null) {
    const parent = await context.repository.findAnnotation(
      scope,
      record.parentId,
      owner,
    )
    if (!parent) {
      return problem(
        400,
        'unknown_parent',
        'margin:parentId must name an annotation on the same site and document',
      )
    }
  }

  await context.repository.insertAnnotation(record)
  // The advertised URI has to be one a client can actually use. The item routes
  // need a scope like every other read, so the header carries the canonical one
  // rather than leaving a caller that follows it with `missing_scope`.
  const source = encodeURIComponent(joinSource(scope.site, scope.document))
  return json(recordToWebAnnotation(record), 201, {
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
    return problem(404, 'not_found', 'no annotation you can see has that id here')
  }
  return json(recordToWebAnnotation(found))
}

const annotationPatchSchema = z
  .object({
    body: z.string().min(1).max(8_000).optional(),
    'margin:visibility': z.enum(VISIBILITIES).optional(),
    'margin:color': z.string().min(1).max(64).optional(),
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

  // A highlight has no body and a note has no colour. Checking the existing
  // row first turns what the schema would otherwise reject as a constraint
  // violation into an ordinary 400, and keeps the 404 for a row the caller
  // does not own.
  const existing = await context.repository.findAnnotation(scope, id, owner)
  if (!existing || existing.creator !== owner) {
    return problem(404, 'not_found', 'no annotation of yours has that id here')
  }
  const isHighlight = existing.annotation.kind === 'highlight'
  if (isHighlight && parsed.data.body !== undefined) {
    return problem(
      400,
      'unexpected_body',
      'an annotation motivated by highlighting carries no body',
    )
  }
  if (!isHighlight && parsed.data['margin:color'] !== undefined) {
    return problem(
      400,
      'unexpected_color',
      'margin:color applies only to an annotation motivated by highlighting',
    )
  }

  const updated = await context.repository.updateAnnotation(scope, id, owner, {
    ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
    ...(parsed.data['margin:visibility'] !== undefined
      ? { visibility: parsed.data['margin:visibility'] }
      : {}),
    ...(parsed.data['margin:color'] !== undefined
      ? { color: parsed.data['margin:color'] }
      : {}),
    modified: context.now(),
  })
  if (!updated) {
    return problem(404, 'not_found', 'no annotation of yours has that id here')
  }
  return json(recordToWebAnnotation(updated))
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
  // annotations, which no owner-scoped delete should be able to do, so a thread
  // with replies in it refuses instead. Tombstoning a deleted parent and
  // keeping the thread readable is 056's problem, not this route's.
  if (await context.repository.countReplies(scope, id)) {
    return problem(
      409,
      'has_replies',
      'other people have replied to this; deleting it would delete their replies',
    )
  }

  // A reply can arrive between the count above and the delete below. The
  // constraint catches it, and that is a conflict the caller can act on, not the
  // store being unavailable — so it is translated here rather than escaping as
  // the Worker's generic 503.
  let removed: boolean
  try {
    removed = await context.repository.deleteAnnotation(scope, id, owner)
  } catch (error) {
    if (isForeignKeyConflict(error)) {
      return problem(
        409,
        'has_replies',
        'a reply arrived while this was being deleted; deleting it would delete theirs',
      )
    }
    throw error
  }
  if (!removed) {
    return problem(404, 'not_found', 'no annotation of yours has that id here')
  }
  return new Response(null, { status: 204, headers: JSON_HEADERS })
}

const prefsPatchSchema = z
  .object({ defaultVisibility: z.enum(VISIBILITIES) })
  .strict()

async function readPrefs(
  context: MarginRouteContext,
  owner: string,
): Promise<Response> {
  const prefs = await context.repository.getPrefs(owner)
  return json({ defaultVisibility: prefs.defaultVisibility })
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
  return json({ defaultVisibility: prefs.defaultVisibility })
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

  if (path.length === 1 && path[0] === 'proposals') {
    if (method !== 'GET') return methodNotAllowed(['GET', 'HEAD'])
    return listAnnotations(url, context, owner, 'editing')
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
