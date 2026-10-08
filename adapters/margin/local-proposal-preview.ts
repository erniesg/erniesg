/** Local private-memory prerequisite. Supplied proposals are never authenticated here. */
import { performance } from 'node:perf_hooks'
import { withLocalBookPreviewInputs } from '../../src/lib/books'
import { withExactBookBaseSnapshot } from '../../src/lib/book-history'
import { captureExactBookInput, withReadOnlyBookRenderer } from '../../src/lib/book-history-rendered'
import { previewCurrentProposalWithRenderer } from './proposal-preview'
import { LIMITS, resolveDocument, sha256, type Failure } from './source-plan'

const refused = (reason: string): Failure => ({ status: 'refused', reason })
const unavailable = (reason: string): Failure => ({ status: 'not_evaluated', reason })
function closed(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)))
}

export function previewLocalProposal(raw: unknown) {
  const deadline = performance.now() + 120_000
  if (!closed(raw, ['expectedHead', 'snapshot']) || !closed(raw.snapshot, ['site', 'document', 'revision', 'body', 'baseCommit', 'sourcePath'])) return refused('invalid-local-preview-input')
  // This provisional row validates supplied scalar shapes only. The actual
  // mapping is freshly obtained inside the source witness before any preview.
  const validated = resolveDocument({ ...raw, mapping: { site: raw.snapshot.site, head: raw.expectedHead,
    documents: [{ document: raw.snapshot.document, sourcePath: raw.snapshot.sourcePath }] } })
  if ('status' in validated) return validated
  const { snapshot, expectedHead } = validated
  try {
    return withReadOnlyBookRenderer(handle => withLocalBookPreviewInputs(deadline, context => {
      if (context.head !== expectedHead) return refused('current-head-mismatch')
      if (context.site !== snapshot.site) return refused('current-site-mismatch')
      return withExactBookBaseSnapshot(context.root, context.site, () => context.loadNodes(), {
        expectedHead, baseCommit: snapshot.baseCommit, deadline, gitCalls: 4080,
      }, (nodes, base) => {
        const mapping = { site: context.site, head: context.head, documents: nodes.map(node => ({ document: new URL(node.path, context.site).href, sourcePath: node.sourcePath })) }
        const exact = resolveDocument({ expectedHead, snapshot, mapping })
        if ('status' in exact) return exact
        const captured = captureExactBookInput(base, snapshot.sourcePath)
        const preview = previewCurrentProposalWithRenderer({ expectedHead, snapshot, mapping,
          tree: { commit: snapshot.baseCommit, files: captured.files, occupied: captured.occupied } }, handle)
        if (preview.status !== 'previewed') return preview
        context.remaining(); base.remaining(); void handle.fingerprint
        const objects = new Map(captured.objects.map(row => [row.path, row]))
        const source = objects.get(snapshot.sourcePath)
        if (!source || source.oid !== captured.sourceOID || source.sha256 !== preview.baseSha256) return unavailable('source-evidence-unavailable')
        const dependencies = preview.dependencies.map(read => {
          const object = objects.get(read.path)
          if (!object || object.mode !== read.mode || object.sha256 !== read.sha256) throw Error('dependency evidence differs')
          return { ...read, oid: object.oid }
        })
        const result = {
          status: 'previewed' as const, proposalProvenance: 'supplied-unverified' as const, sourceProvenance: 'git-bound' as const,
          preview,
          evidence: { expectedHead, currentHead: context.head, baseCommit: snapshot.baseCommit, treeOID: captured.treeOID,
            document: snapshot.document, revision: snapshot.revision, sourcePath: snapshot.sourcePath,
            sourceOID: source.oid, sourceSha256: source.sha256, bodySha256: preview.bodySha256, proposedSha256: preview.proposedSha256,
            mappingSha256: sha256(JSON.stringify(mapping)), sourceWitnessFingerprint: context.fingerprint,
            rendererFingerprint: handle.fingerprint, dependencies,
            optionalAbsences: preview.optionalAbsences.map(name => ({ path: name, treeOID: captured.treeOID })),
          },
        }
        if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.outputBytes) return unavailable('local-preview-envelope-limit')
        context.remaining(); base.remaining(); void handle.fingerprint
        return result
      })
    }), { deadline })
  } catch { return unavailable('local-preview-inspection-unavailable') }
}
