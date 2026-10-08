/** Public site-owned build data. This module has no Worker, Git or credential dependencies. */
export type MarginHistoryVersion = {
  commit: string
  author: string
  date: string
  message: string
  path: string
  change: string
  deleted: boolean
  content: string | null
}
export type MarginHistoryAsset = {
  schemaVersion: 1
  site: string
  document: string
  book: string
  node: string
  buildCommit: string
  sourcePath: string
  versions: MarginHistoryVersion[]
}
export type MarginHistoryLocation = {
  schemaVersion: 1
  site: string
  document: string
  historyLocation: string
}
export type MarginHistoryResponse = MarginHistoryLocation &
  ({ kind: 'locator' } | { kind: 'asset'; history: MarginHistoryAsset })
export const HISTORY_ASSET_BYTES = 8 * 1024 * 1024
export const HISTORY_CONTENT_BYTES = 2 * 1024 * 1024
export const HISTORY_VERSION_LIMIT = 10_000

const encoder = new TextEncoder()
function invalid(): never {
  throw Error('invalid history asset')
}
function text(value: unknown, max: number, empty = false): value is string {
  return (
    typeof value === 'string' &&
    (empty || value.length > 0) &&
    value.length <= max &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    encoder.encode(value).length <= max
  )
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const fields = Object.keys(value)
  if (
    fields.length !== keys.length ||
    fields.some((key) => !keys.includes(key))
  )
    invalid()
  return value as Record<string, unknown>
}
function relativePath(value: unknown): value is string {
  return (
    text(value, 4096) &&
    !/[\\\x00-\x1f\x7f]/.test(value) &&
    value
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  )
}
function commit(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
  )
}
/** Check calendar fields before Date.parse can normalize an impossible date. */
function date(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/.exec(
      value,
    )
  if (!m) return false
  const [, ys, ms, ds, hs, mins, ss, , ohs, oms] = m
  const [y, mo, d, h, min, sec, oh, om] = [
    ys,
    ms,
    ds,
    hs,
    mins,
    ss,
    ohs,
    oms,
  ].map(Number)
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return (
    mo >= 1 &&
    mo <= 12 &&
    d >= 1 &&
    d <= days[mo - 1] &&
    h < 24 &&
    min < 60 &&
    sec < 60 &&
    oh < 24 &&
    om < 60 &&
    Number.isFinite(Date.parse(value))
  )
}

/**
 * Accept the existing producer's canonical JSON bytes, not a permissive JSON
 * dialect. Closed, shallow shapes are checked before reserialization; no
 * recursive walk over untrusted nested data is needed. Unknown/deep members,
 * duplicate keys and lexical aliases never become valid public history.
 */
export function parseMarginHistoryAsset(
  bytes: Uint8Array,
  site: string,
  document: string,
): MarginHistoryAsset {
  if (bytes.byteLength > HISTORY_ASSET_BYTES) invalid()
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    bytes,
  )
  const root = object(JSON.parse(raw), [
    'schemaVersion',
    'site',
    'document',
    'book',
    'node',
    'buildCommit',
    'sourcePath',
    'versions',
  ])
  if (
    root.schemaVersion !== 1 ||
    root.site !== site ||
    root.document !== document ||
    !text(root.site, 2048) ||
    !text(root.document, 2048) ||
    !text(root.book, 128) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(root.book) ||
    !text(root.node, 128) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(root.node) ||
    !commit(root.buildCommit) ||
    !relativePath(root.sourcePath) ||
    !Array.isArray(root.versions) ||
    root.versions.length > HISTORY_VERSION_LIMIT
  )
    invalid()
  const commits = new Set<string>()
  for (const item of root.versions) {
    const v = object(item, [
      'commit',
      'author',
      'date',
      'message',
      'path',
      'change',
      'deleted',
      'content',
    ])
    if (
      !commit(v.commit) ||
      commits.has(v.commit) ||
      !text(v.author, 4096) ||
      !date(v.date) ||
      !text(v.message, 65_536, true) ||
      !relativePath(v.path) ||
      typeof v.change !== 'string' ||
      !/^(?:[AMDT]|R(?:100|0\d{2}))$/.test(v.change) ||
      (v.change === 'D'
        ? v.deleted !== true || v.content !== null
        : v.deleted !== false || !text(v.content, HISTORY_CONTENT_BYTES, true))
    )
      invalid()
    commits.add(v.commit)
  }
  if (JSON.stringify(root) + '\n' !== raw) invalid()
  return root as MarginHistoryAsset
}
