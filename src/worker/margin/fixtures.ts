import type { Principal } from '../principal'
import { D1MarginRepository } from './d1-repository'
import { principalKey } from './identity'
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

export function webAnnotation(options: {
  source: string
  motivation?: Motivation
  body?: string
  visibility?: MarginVisibility
  parentId?: string
  nodeId?: string
  structId?: string
}) {
  const motivation = options.motivation ?? 'commenting'
  return {
    '@context': MARGIN_CONTEXT,
    type: 'Annotation',
    motivation,
    ...(motivation === 'highlighting'
      ? {}
      : { body: { type: 'TextualBody', value: options.body ?? 'a remark' } }),
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
  request(
    method: string,
    path: string,
    options?: { as?: Principal | null; body?: unknown },
  ): Promise<Response>
}

export function createHarness(): MarginHarness {
  const database = SqliteD1Database.inMemory()
  const repository = new D1MarginRepository(database)
  let clock = 0
  let sequence = 0

  return {
    database,
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
