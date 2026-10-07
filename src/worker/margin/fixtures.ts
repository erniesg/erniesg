import { formatHunks, parseHunks } from '../../annotations/criticmarkup'
import type { Principal } from '../principal'
import { D1MarginRepository } from './d1-repository'
import { principalKey, SCHEMA_STATEMENTS } from './identity'
import { handleMarginRequest, MARGIN_API_PREFIX } from './routes'
import { SqliteD1Database } from './sqlite-database'
import {
  MARGIN_CONTEXT,
  STRUCT_SELECTOR_TYPE,
  type MarginVisibility,
  type Motivation,
} from './web-annotation'

/**
 * Shared test scaffolding for the margin route and visibility suites.
 *
 * Requests go through the real router over a real SQLite database created from
 * the real migration, so a test can seed through the HTTP surface and then
 * make its assertions against the rows SQL actually returns.
 */

export const ADA: Principal = {
  provider: 'dev',
  issuer: 'urn:margin:dev',
  subject: 'ada',
}

export const BOB: Principal = {
  provider: 'dev',
  issuer: 'urn:margin:dev',
  subject: 'bob',
}

export const ADA_KEY = principalKey(ADA)
export const BOB_KEY = principalKey(BOB)

export const CHAPTER_ONE = 'https://ernie.sg/challenges/chapter-1'
export const CHAPTER_TWO = 'https://ernie.sg/challenges/chapter-2'
export const OTHER_SITE = 'https://berlayar.ai/challenges/chapter-1'

const PASSAGE = 'meaning becomes coordinates'

/** A full commit id an edit proposal can name as its base (issue 059). */
export const BASE_COMMIT = 'a'.repeat(40)
export const SOURCE_PATH = 'books/chapters/ch01-values.md'

/** An edit proposal's body: canonical hunks, one hunk carrying `markup`. */
export function proposalBody(markup = 'A {~~remark~>comment~~}.'): string {
  return formatHunks([{ baseStartLine: 1, baseEndLine: 1, criticMarkup: markup }])
}

/** A valid proposal body exactly `length` characters long, for the caps. */
export function proposalBodyOfLength(length: number): string {
  const frame = proposalBody('').length
  return proposalBody('x'.repeat(length - frame))
}

function bodyFor(motivation: Motivation, body: string | undefined): string {
  if (motivation !== 'editing') return body ?? 'a remark'
  if (body === undefined) return proposalBody()
  // A test that names its own proposal body means it: already hunks, keep it;
  // anything else becomes the text of one hunk, so only the body's meaning,
  // not its format, is under test.
  try {
    parseHunks(body)
    return body
  } catch {
    return proposalBody(body)
  }
}

export function webAnnotation(options: {
  source: string
  motivation?: Motivation
  body?: string
  visibility?: MarginVisibility
  parentId?: string
  nodeId?: string
  structId?: string
  /** An edit proposal's base; defaults to `BASE_COMMIT`, `null` omits it. */
  baseCommit?: string | null
  sourcePath?: string | null
}) {
  const motivation = options.motivation ?? 'commenting'
  const baseCommit = options.baseCommit === undefined ? BASE_COMMIT : options.baseCommit
  const sourcePath = options.sourcePath === undefined ? SOURCE_PATH : options.sourcePath
  return {
    '@context': MARGIN_CONTEXT,
    type: 'Annotation',
    motivation,
    ...(motivation === 'highlighting'
      ? {}
      : { body: { type: 'TextualBody', value: bodyFor(motivation, options.body) } }),
    ...(motivation === 'editing' && baseCommit !== null
      ? { 'margin:baseCommit': baseCommit }
      : {}),
    ...(motivation === 'editing' && sourcePath !== null
      ? { 'margin:sourcePath': sourcePath }
      : {}),
    target: {
      source: options.source,
      selector: [
        {
          type: 'TextQuoteSelector',
          exact: PASSAGE,
          prefix: 'Once ',
          suffix: ', every new screen',
        },
        { type: 'TextPositionSelector', start: 5, end: 5 + PASSAGE.length },
        {
          type: STRUCT_SELECTOR_TYPE,
          'margin:nodeId': options.nodeId ?? 'p-proposition-1',
          ...(options.structId ? { 'margin:structId': options.structId } : {}),
        },
      ],
    },
    ...(options.visibility ? { 'margin:visibility': options.visibility } : {}),
    ...(options.parentId ? { 'margin:parentId': options.parentId } : {}),
  }
}

export type MarginHarness = {
  database: SqliteD1Database
  /** Exposed so a test can interleave a write inside a request being served. */
  repository: D1MarginRepository
  request(
    method: string,
    path: string,
    options?: { as?: Principal | null; body?: unknown },
  ): Promise<Response>
}

export function createHarness(options: { identitySchema?: boolean } = {}): MarginHarness {
  const database = SqliteD1Database.inMemory()
  if (options.identitySchema !== false) for (const sql of SCHEMA_STATEMENTS) database.execute(sql)
  database.executed.length = 0
  const repository = new D1MarginRepository(database)
  let clock = 0
  let sequence = 0

  return {
    database,
    repository,
    async request(method, path, options = {}) {
      const request = new Request(`https://ernie.sg${MARGIN_API_PREFIX}${path}`, {
        method,
        ...(options.body === undefined
          ? {}
          : {
              body: JSON.stringify(options.body),
              headers: { 'content-type': 'application/json' },
            }),
      })
      return handleMarginRequest(request, {
        repository,
        principal: options.as === undefined ? ADA : options.as,
        now: () => {
          clock += 1
          return new Date(Date.UTC(2026, 8, 22, 0, 0, clock)).toISOString()
        },
        newId: () => {
          sequence += 1
          return `annotation-${String(sequence).padStart(3, '0')}`
        },
      })
    },
  }
}

/** `?source=` is the tenancy scope every read takes. */
export function scopeQuery(source: string): string {
  return `?source=${encodeURIComponent(source)}`
}
