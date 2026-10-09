/** Provider-visible mutable traversals; never absence, adoption or write authority. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { publicCorrelationSchema } from '../../src/worker/margin/adapter'
import { reportCommit, reportInteger } from '../../src/worker/margin/repository'

const repository = 'erniesg/erniesg' as const
const api = `https://api.github.com/repos/${repository}`
const html = `https://github.com/${repository}`
type Kind = 'issues' | 'pulls'
type Relation = 'next' | 'prev' | 'first' | 'last'
export type DiscoveryReason =
  'pagination' | 'row_binding' | 'incomplete' | 'bounds'
export class ArtifactDiscoveryError extends Error {
  constructor(readonly reason: DiscoveryReason) {
    super(reason)
  }
}
export type PublicArtifactInput = { branch: string; marker: string }
type Body = { kind: 'null' } | { kind: 'text'; bytes: number; sha256: string }
type Common = {
  id: number
  number: number
  url: string
  state: 'open' | 'closed'
  titleSha256: string
  body: Body
}
type Issue = Common & { markerOccurrences: number }
type Pull = Common & {
  headSha: string
  baseSha: string
  baseRef: string
  mergedAt: string | null
  draft: boolean
}
export type PublicArtifactObservation = {
  provenance: 'github-api-observed'
  repository: typeof repository
  repositoryId: number
  branch: string
  marker: string
  issues: {
    pageCount: number
    rowCount: number
    pullRowCount: number
    matches: Issue[]
  }
  pulls: { pageCount: number; rowCount: number; matches: Pull[] }
  coverage: { kind: 'terminal-provider-visible-traversals'; atomic: false }
}
export type PublicArtifactReadResult =
  | { status: 'ready'; observation: PublicArtifactObservation }
  | {
      status: 'refused' | 'not_evaluated'
      reason:
        | DiscoveryReason
        | 'config'
        | 'input'
        | 'closed'
        | 'busy'
        | 'timeout'
        | 'aborted'
        | 'transport'
        | 'response'
        | 'body'
        | 'provider_refused'
        | 'not_found_or_hidden'
        | 'response_status'
      httpStatus?: number
    }

function data(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('input')
  const own = Reflect.ownKeys(input)
  if (
    own.length !== keys.length ||
    own.some((k) => typeof k !== 'string' || !keys.includes(k))
  )
    throw Error('input')
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('input')
    result[key] = descriptor.value
  }
  return result
}
/** Capture only owned scalar data before the operation's first await. */
export function capturePublicArtifactInput(
  input: unknown,
): PublicArtifactInput {
  const outer = data(input, ['publicCorrelation'])
  const captured = data(outer.publicCorrelation, ['version', 'value'])
  const correlation = publicCorrelationSchema.parse(captured)
  return {
    branch: `coordinator/margin-proposal-${correlation.value}`,
    marker: `<!-- margin-proposal:${correlation.value} -->`,
  }
}
function failure(reason: DiscoveryReason): never {
  throw new ArtifactDiscoveryError(reason)
}
function bounded(value: string, limit: number) {
  if (value.length > limit || Buffer.byteLength(value, 'utf8') > limit)
    failure('bounds')
}
function timestamp(value: string): number {
  if (
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    failure('row_binding')
  const time = Date.parse(value)
  if (!Number.isFinite(time)) failure('row_binding')
  return time
}
const metadataSchema = z.object({
  id: reportInteger.positive(),
  full_name: z.literal(repository),
  url: z.literal(api),
  html_url: z.literal(html),
})
const rowSchema = z.object({
  id: reportInteger.positive(),
  number: reportInteger.positive(),
  url: z.string().max(2048),
  html_url: z.string().max(2048),
  state: z.enum(['open', 'closed']),
  title: z.string(),
  body: z.string().nullable(),
  created_at: z.string().max(64),
})
const repoSchema = z.object({
  id: reportInteger.positive(),
  full_name: z.literal(repository),
})
const pullSchema = z.object({
  head: z.object({ ref: z.string(), sha: reportCommit, repo: repoSchema }),
  base: z.object({ ref: z.string(), sha: reportCommit, repo: repoSchema }),
  merged_at: z.string().max(64).nullable(),
  draft: z.boolean(),
})
function boundURL(actual: string, suffix: string, id: number) {
  if (
    actual !== api + suffix &&
    actual !== `https://api.github.com/repositories/${id}${suffix}`
  )
    failure('row_binding')
}
function fixedQuery(kind: Kind, branch: string): Record<string, string> {
  return {
    state: 'all',
    ...(kind === 'pulls' ? { head: 'erniesg:' + branch } : {}),
    sort: 'created',
    direction: 'asc',
    per_page: '100',
  }
}
function pageURL(kind: Kind, branch: string, page: number, after?: string) {
  const query = new URLSearchParams({
    ...fixedQuery(kind, branch),
    page: String(page),
  })
  if (after !== undefined) query.set('after', after)
  return `${api}/${kind}?${query}`
}
type LinkTarget = { page: number; after?: string; before?: string }
type Walk = {
  family?: 'numbered' | 'cursor'
  last?: number
  cursors: Set<string>
  targets: Set<string>
}
function pageLinks(
  link: string | null,
  kind: Kind,
  branch: string,
  id: number,
  current: number,
  walk: Walk,
): string | undefined {
  if (link === null) {
    if (walk.last !== undefined && current !== walk.last) failure('pagination')
    return undefined
  }
  bounded(link, 8192)
  if (!link.trim()) failure('pagination')
  const relations = new Map<Relation, LinkTarget>()
  let offset = 0
  while (offset < link.length) {
    const match =
      /^\s*<([^<>\s]+)>\s*;\s*rel="(next|prev|first|last)"\s*(,|$)/.exec(
        link.slice(offset),
      )
    if (!match) failure('pagination')
    offset += match[0].length
    if (match[3] === ',' && !link.slice(offset).trim()) failure('pagination')
    const relation = match[2] as Relation
    if (relations.has(relation)) failure('pagination')
    const raw = match[1]
    if (
      !raw.startsWith('https://api.github.com/') ||
      raw.includes('\\') ||
      /%(?![0-9a-fA-F]{2})/.test(raw)
    )
      failure('pagination')
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      failure('pagination')
    }
    if (
      url.origin !== 'https://api.github.com' ||
      url.username ||
      url.password ||
      url.hash ||
      ![`/repos/${repository}/${kind}`, `/repositories/${id}/${kind}`].includes(
        url.pathname,
      )
    )
      failure('pagination')
    const expected = fixedQuery(kind, branch),
      params = url.searchParams
    const keys = [...params.keys()]
    // Required-key equality, not entry count: cursors cannot replace a fixed key.
    if (
      new Set(keys).size !== keys.length ||
      keys.some(
        (k) =>
          !Object.hasOwn(expected, k) &&
          !['page', 'after', 'before'].includes(k),
      )
    )
      failure('pagination')
    for (const [key, value] of Object.entries(expected))
      if (params.get(key) !== value) failure('pagination')
    const page = params.get('page')
    if (
      page === null ||
      !/^[1-9][0-9]*$/.test(page) ||
      !Number.isSafeInteger(Number(page))
    )
      failure('pagination')
    const target: LinkTarget = { page: Number(page) }
    for (const name of ['after', 'before'] as const) {
      const cursor = params.get(name)
      if (cursor !== null) {
        if (!/^[\x21-\x7e]{1,1024}$/.test(cursor)) failure('pagination')
        target[name] = cursor
      }
    }
    if (target.after !== undefined && target.before !== undefined)
      failure('pagination')
    if (
      relation === 'next' &&
      (target.page !== current + 1 || target.before !== undefined)
    )
      failure('pagination')
    if (
      relation === 'prev' &&
      (current === 1 ||
        target.page !== current - 1 ||
        target.after !== undefined)
    )
      failure('pagination')
    if (relation === 'first' && target.page !== 1) failure('pagination')
    if (relation === 'last' && target.page < current) failure('pagination')
    relations.set(relation, target)
  }
  const next = relations.get('next'),
    last = relations.get('last')
  if (last) {
    if (walk.last !== undefined && walk.last !== last.page)
      failure('pagination')
    walk.last = last.page
  }
  if (
    walk.last !== undefined &&
    (current > walk.last ||
      (next ? next.page > walk.last : current < walk.last))
  )
    failure('pagination')
  if (!next) return undefined
  const family = next.after === undefined ? 'numbered' : 'cursor'
  if (walk.family !== undefined && walk.family !== family) failure('pagination')
  walk.family = family
  if (next.after !== undefined) {
    if (walk.cursors.has(next.after)) failure('pagination')
    walk.cursors.add(next.after)
  }
  const target = pageURL(kind, branch, next.page, next.after)
  if (walk.targets.has(target)) failure('pagination')
  walk.targets.add(target)
  return target
}

/** Private bounded GET returns only copied Link metadata; no Response/transport escapes. */
export async function observePublicArtifacts(
  input: PublicArtifactInput,
  get: <T>(
    url: string,
    decode: (bytes: Uint8Array) => T,
    link?: (value: string | null) => void,
  ) => Promise<T>,
  json: (bytes: Uint8Array) => unknown,
  check: () => void,
): Promise<PublicArtifactReadResult> {
  const metadata = await get(api, (bytes) => metadataSchema.parse(json(bytes)))
  const digest = (value: string) => {
    check()
    const result = createHash('sha256').update(value, 'utf8').digest('hex')
    check()
    return result
  }
  const issues: PublicArtifactObservation['issues'] = {
    pageCount: 0,
    rowCount: 0,
    pullRowCount: 0,
    matches: [],
  }
  const pulls: PublicArtifactObservation['pulls'] = {
    pageCount: 0,
    rowCount: 0,
    matches: [],
  }
  for (const kind of ['issues', 'pulls'] as const) {
    const walk: Walk = { cursors: new Set(), targets: new Set() }
    const ids = new Set<number>(),
      numbers = new Set<number>()
    let previous = -Infinity,
      url: string | undefined = pageURL(kind, input.branch, 1)
    const summary = kind === 'issues' ? issues : pulls
    while (url !== undefined) {
      check()
      if (summary.pageCount >= 10) failure('bounds')
      let next: string | undefined
      const rows = await get(
        url,
        (bytes) => {
          const raw = json(bytes)
          if (!Array.isArray(raw)) failure('row_binding')
          if (raw.length > 100) failure('bounds')
          return raw as unknown[]
        },
        (link) => {
          next = pageLinks(
            link,
            kind,
            input.branch,
            metadata.id,
            summary.pageCount + 1,
            walk,
          )
        },
      )
      summary.pageCount++
      for (const raw of rows) {
        check()
        try {
          const row = rowSchema.parse(raw)
          bounded(row.title, 1024)
          if (row.body !== null) bounded(row.body, 64 * 1024)
          const created = timestamp(row.created_at)
          if (created < previous || ids.has(row.id) || numbers.has(row.number))
            failure('row_binding')
          previous = created
          ids.add(row.id)
          numbers.add(row.number)
          summary.rowCount++
          const record = raw as Record<string, unknown>
          const isPullRow =
            kind === 'issues' && Object.hasOwn(record, 'pull_request')
          boundURL(row.url, `/${kind}/${row.number}`, metadata.id)
          if (
            row.html_url !==
            `${html}/${kind === 'pulls' || isPullRow ? 'pull' : 'issues'}/${row.number}`
          )
            failure('row_binding')
          if (kind === 'issues') {
            const issue = z
              .object({ repository_url: z.string().max(2048) })
              .parse(raw)
            boundURL(issue.repository_url, '', metadata.id)
            if (isPullRow) {
              const link = z
                .object({
                  url: z.string().max(2048),
                  html_url: z.literal(`${html}/pull/${row.number}`),
                })
                .parse(record.pull_request)
              boundURL(link.url, `/pulls/${row.number}`, metadata.id)
              issues.pullRowCount++
              continue
            }
          }
          let occurrence = 0
          if (kind === 'issues' && row.body !== null) {
            for (const line of row.body.split(/\r?\n/u)) {
              check()
              if (line === input.marker) occurrence++
            }
          }
          // Even nonmatches above had complete row identity validation and accounting.
          if (kind === 'issues' && !occurrence) continue
          let pr: z.infer<typeof pullSchema> | undefined
          if (kind === 'pulls') {
            pr = pullSchema.parse(raw)
            if (
              pr.head.ref !== input.branch ||
              pr.head.repo.id !== metadata.id ||
              pr.base.repo.id !== metadata.id
            )
              failure('row_binding')
            bounded(pr.base.ref, 1024)
            if (!pr.base.ref) failure('row_binding')
            if (pr.merged_at !== null) {
              timestamp(pr.merged_at)
              if (row.state !== 'closed') failure('row_binding')
            }
          }
          const common: Common = {
            id: row.id,
            number: row.number,
            url: row.html_url,
            state: row.state,
            titleSha256: digest(row.title),
            body:
              row.body === null
                ? { kind: 'null' }
                : {
                    kind: 'text',
                    bytes: Buffer.byteLength(row.body, 'utf8'),
                    sha256: digest(row.body),
                  },
          }
          if (pr)
            pulls.matches.push({
              ...common,
              headSha: pr.head.sha,
              baseSha: pr.base.sha,
              baseRef: pr.base.ref,
              mergedAt: pr.merged_at,
              draft: pr.draft,
            })
          else issues.matches.push({ ...common, markerOccurrences: occurrence })
        } catch (error) {
          check()
          if (error instanceof ArtifactDiscoveryError) throw error
          failure('row_binding')
        }
      }
      url = next
    }
  }
  check()
  issues.matches.sort((a, b) => a.number - b.number)
  pulls.matches.sort((a, b) => a.number - b.number)
  const result: PublicArtifactReadResult = {
    status: 'ready',
    observation: {
      provenance: 'github-api-observed',
      repository,
      repositoryId: metadata.id,
      ...input,
      issues,
      pulls,
      coverage: { kind: 'terminal-provider-visible-traversals', atomic: false },
    },
  }
  bounded(JSON.stringify(result), 1024 * 1024)
  check()
  return result
}
