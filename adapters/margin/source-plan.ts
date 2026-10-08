/** Offline data conversion only. Neither supplied snapshots nor mappings confer approval authority. */
import { createHash } from 'node:crypto'
import { applyHunks, isFullCommitId, parseHunks, toUnifiedDiff } from '../../src/annotations/criticmarkup'

export const LIMITS = Object.freeze({ mappingRows: 10_000, mappingBytes: 2 * 1024 * 1024, bodyBytes: 64 * 1024, hunks: 1_000, sourceBytes: 2 * 1024 * 1024, sourceLines: 100_000, outputBytes: 8 * 1024 * 1024, metadataBytes: 256 * 1024, gitCalls: 16, commandMs: 5_000, totalMs: 20_000 })
export type SnapshotData = { site: string; document: string; revision: number; body: string; baseCommit: string; sourcePath: string }
export type MappingData = { site: string; head: string; documents: { document: string; sourcePath: string }[] }
export type ContextData = { expectedHead: string; snapshot: SnapshotData; mapping: MappingData }
export type Failure = { status: 'refused' | 'not_evaluated'; reason: string }
export type Prepared = {
  status: 'planned' | 'needs_merge'; sourcePath: string; baseCommit: string; currentCommit: string;
  snapshotBodySha256: string; baseSha256: string; currentSha256: string; proposedSha256: string;
  approvedBaseDiff: string; proposedBytes: Uint8Array; rebased: boolean; changed: boolean;
}
export type SourcePlan = Prepared | Failure
export const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
const refused = (reason: string): Failure => ({ status: 'refused', reason })
const unavailable = (reason: string): Failure => ({ status: 'not_evaluated', reason })
const slug = '[a-z0-9]+(?:-[a-z0-9]+)*'
const source = new RegExp(`^books/(?:chapters/${slug}\\.md|challenges/${slug}/challenge\\.md)$`)
const route = new RegExp(`^/books/${slug}/${slug}/$`)
function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && Buffer.byteLength(value, 'utf8') <= max && Buffer.from(value).toString('utf8') === value
}
function origin(value: unknown): value is string {
  if (!text(value, 2048)) return false
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password } catch { return false }
}
function documentUri(value: unknown, site: string): value is string {
  if (!text(value, 4096)) return false
  try { const url = new URL(value); return url.href === value && url.origin === site && !url.username && !url.password && !url.search && !url.hash && route.test(url.pathname) } catch { return false }
}

/** Strict supplied-data validation, not authentication of the capture or application row. */
export function resolveDocument(raw: unknown): ContextData | Failure {
  try {
    if (!raw || typeof raw !== 'object') return refused('invalid-context')
    const { expectedHead, snapshot, mapping } = raw as Record<string, unknown>
    if (typeof expectedHead !== 'string' || !isFullCommitId(expectedHead)) return refused('invalid-head')
    if (!object(snapshot, ['site', 'document', 'revision', 'body', 'baseCommit', 'sourcePath'])) return refused('invalid-snapshot')
    if (!origin(snapshot.site) || !documentUri(snapshot.document, snapshot.site) || typeof snapshot.revision !== 'number' || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || snapshot.revision >= Number.MAX_SAFE_INTEGER || typeof snapshot.baseCommit !== 'string' || !isFullCommitId(snapshot.baseCommit) || snapshot.baseCommit.length !== expectedHead.length || !text(snapshot.sourcePath, 4096) || !source.test(snapshot.sourcePath)) return refused('invalid-snapshot')
    if (typeof snapshot.body === 'string' && Buffer.byteLength(snapshot.body) > LIMITS.bodyBytes) return unavailable('body-limit')
    if (!text(snapshot.body, LIMITS.bodyBytes)) return refused('invalid-body')
    if (mapping === null || mapping === undefined) return unavailable('mapping-unavailable')
    if (!object(mapping, ['site', 'head', 'documents']) || mapping.site !== snapshot.site || mapping.head !== expectedHead || !Array.isArray(mapping.documents)) return refused('invalid-mapping')
    if (mapping.documents.length > LIMITS.mappingRows) return unavailable('mapping-limit')
    let bytes = 0; let match: { document: string; sourcePath: string } | undefined
    const seen = new Set<string>()
    for (const row of mapping.documents) {
      if (!object(row, ['document', 'sourcePath']) || !documentUri(row.document, snapshot.site) || !text(row.sourcePath, 4096) || !source.test(row.sourcePath)) return refused('invalid-mapping-row')
      bytes += Buffer.byteLength(JSON.stringify(row))
      if (bytes > LIMITS.mappingBytes) return unavailable('mapping-limit')
      if (seen.has(row.document)) return refused('ambiguous-document')
      seen.add(row.document)
      if (row.document === snapshot.document) match = row as { document: string; sourcePath: string }
    }
    if (Buffer.byteLength(JSON.stringify(mapping)) > LIMITS.mappingBytes) return unavailable('mapping-limit')
    if (!match) return refused('document-not-mapped')
    if (match.sourcePath !== snapshot.sourcePath) return refused('source-mismatch')
    return { expectedHead, snapshot: { ...snapshot } as SnapshotData, mapping: { site: mapping.site as string, head: mapping.head as string, documents: mapping.documents.map(row => ({ ...row })) } }
  } catch { return refused('invalid-context') }
}

export function decodeSource(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > LIMITS.sourceBytes) throw Error('source-limit')
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (decoded.includes('\0') || !Buffer.from(decoded).equals(Buffer.from(bytes))) throw Error('invalid-source')
  if (decoded.split('\n').length > LIMITS.sourceLines) throw Error('source-limit')
  return decoded
}

/** Size-bounded synchronous pure function. Wall-clock isolation belongs to local-source. */
export function planApprovedSource(raw: unknown): SourcePlan {
  const context = resolveDocument(raw)
  if ('status' in context) return context
  try {
    const { baseBytes, currentBytes } = raw as { baseBytes: Uint8Array; currentBytes: Uint8Array }
    const base = decodeSource(baseBytes); const current = decodeSource(currentBytes)
    // Check hunk cardinality before the canonical parser allocates its validated representation.
    const shape: unknown = JSON.parse(context.snapshot.body)
    if (shape && typeof shape === 'object' && Array.isArray((shape as { hunks?: unknown }).hunks) && (shape as { hunks: unknown[] }).hunks.length > LIMITS.hunks) return unavailable('hunk-limit')
    const hunks = parseHunks(context.snapshot.body)
    const approvedBaseDiff = toUnifiedDiff(hunks, base, context.snapshot.sourcePath)
    const proposedBytes = Buffer.from(applyHunks(hunks, base), 'utf8')
    decodeSource(proposedBytes)
    if (Buffer.byteLength(approvedBaseDiff) > LIMITS.outputBytes) return unavailable('diff-limit')
    const rebased = context.snapshot.baseCommit !== context.expectedHead
    if (!rebased && !Buffer.from(baseBytes).equals(Buffer.from(currentBytes))) return refused('same-commit-byte-mismatch')
    return { status: rebased && base !== current ? 'needs_merge' : 'planned', sourcePath: context.snapshot.sourcePath, baseCommit: context.snapshot.baseCommit, currentCommit: context.expectedHead, snapshotBodySha256: sha256(context.snapshot.body), baseSha256: sha256(baseBytes), currentSha256: sha256(currentBytes), proposedSha256: sha256(proposedBytes), approvedBaseDiff, proposedBytes, rebased, changed: !proposedBytes.equals(Buffer.from(currentBytes)) }
  } catch (error) {
    return error instanceof Error && error.message === 'source-limit' ? unavailable('source-limit') : refused('invalid-source-or-proposal')
  }
}
