/** Local supplied-data preview only. No approval, authenticated transport or publication authority. */
import { applyHunks, parseHunks, toUnifiedDiff } from '../../src/annotations/criticmarkup'
import { safeHistoryHtml, type SafeHistoryBlock } from '../../src/lib/book-history-safe-html'
import { RENDERED_HISTORY_LIMITS, ReadonlyBookInputError, withReadOnlyBookRenderer, type ReadonlyBookInput } from '../../src/lib/book-history-rendered'
import { decodeSource, LIMITS, resolveDocument, sha256, type Failure } from './source-plan'

type Preview = {
  status: 'previewed'; provenance: 'unverified-input-provenance'; document: string; revision: number;
  baseCommit: string; sourcePath: string; bodySha256: string; baseSha256: string; proposedSha256: string;
  rendererFingerprint: string; safeHtml: string; blocks: SafeHistoryBlock[];
  dependencies: { path: string; mode: string; sha256: string }[]; optionalAbsences: string[]; staleBase: boolean;
}
const refused = (reason: string): Failure => ({ status: 'refused', reason })
const unavailable = (reason: string): Failure => ({ status: 'not_evaluated', reason })
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)))
}

/** Size-bounded synchronous computation; the owned Python child has its own hard deadline. */
export function previewCurrentProposal(raw: unknown): Preview | Failure {
  if (!shape(raw, ['expectedHead', 'snapshot', 'mapping', 'tree'])) return refused('invalid-preview-input')
  const context = resolveDocument(raw)
  if ('status' in context) return context
  const { snapshot } = context
  if (!shape(raw.tree, ['commit', 'files', 'occupied']) || raw.tree.commit !== snapshot.baseCommit || !Array.isArray(raw.tree.files) || !Array.isArray(raw.tree.occupied)) return refused('base-tree-mismatch')
  // Preflight before map scanning/copying. The shared renderer validates every
  // row/hash/type/occupancy; this phase only locates the exact patched source.
  if (raw.tree.files.length > RENDERED_HISTORY_LIMITS.mapFiles) return unavailable('map-limit')
  const sources = raw.tree.files.filter(row => row && typeof row === 'object' && row.path === snapshot.sourcePath)
  if (sources.length !== 1 || typeof sources[0].content !== 'string') return refused('source-missing-or-ambiguous')
  const source = sources[0], tree = raw.tree
  if (source.content.length > LIMITS.sourceBytes || Buffer.byteLength(source.content) > LIMITS.sourceBytes) return unavailable('source-limit')
  let base: string, proposed: string
  try {
    const bytes = Buffer.from(source.content, 'utf8')
    base = decodeSource(bytes)
    if (base !== source.content || sha256(bytes) !== source.sha256) return refused('source-bytes-mismatch')
    const value: unknown = JSON.parse(snapshot.body)
    if (value && typeof value === 'object' && Array.isArray((value as { hunks?: unknown }).hunks) && (value as { hunks: unknown[] }).hunks.length > LIMITS.hunks) return unavailable('hunk-limit')
    const hunks = parseHunks(snapshot.body)
    const diff = toUnifiedDiff(hunks, base, snapshot.sourcePath)
    if (Buffer.byteLength(diff) > LIMITS.outputBytes) return unavailable('diff-limit')
    proposed = applyHunks(hunks, base)
    decodeSource(Buffer.from(proposed, 'utf8'))
  } catch (error) {
    return error instanceof Error && error.message === 'source-limit' ? unavailable('source-limit') : refused('invalid-source-or-proposal')
  }
  try {
    return withReadOnlyBookRenderer(handle => {
      // Validate the original map as well as the derived one without rendering
      // twice: replacement preserves original metadata keys and shared input
      // validation still checks the original hash separately above.
      const files = (tree.files as ReadonlyBookInput['files']).map(row => row === source ? { ...row, content: proposed, sha256: sha256(proposed) } : row)
      const render = handle.render({ sourcePath: snapshot.sourcePath, files, occupied: tree.occupied } as ReadonlyBookInput)
      const safe = safeHistoryHtml(render.html, 'proposal-preview')
      const result: Preview = {
        status: 'previewed', provenance: 'unverified-input-provenance', document: snapshot.document, revision: snapshot.revision,
        baseCommit: snapshot.baseCommit, sourcePath: snapshot.sourcePath, bodySha256: sha256(snapshot.body),
        baseSha256: sha256(base), proposedSha256: sha256(proposed), rendererFingerprint: handle.fingerprint,
        safeHtml: safe.html, blocks: safe.blocks, dependencies: render.reads.filter(row => row.path !== snapshot.sourcePath), optionalAbsences: render.optionalAbsences,
        staleBase: snapshot.baseCommit !== context.expectedHead,
      }
      if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.outputBytes) return unavailable('preview-result-limit')
      return result
    })
  } catch (error) {
    return error instanceof ReadonlyBookInputError ? { status: error.kind, reason: 'readonly-input-' + error.kind } : unavailable('renderer-unavailable')
  }
}
