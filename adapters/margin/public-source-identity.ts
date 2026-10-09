/** Pure public metadata for the existing local plan. No discovery or write authority. */
import { createHash } from 'node:crypto'
import { publicCorrelationSchema } from '../../src/worker/margin/adapter'
import { LIMITS, sha256, type ContextData, type Failure, type Prepared } from './source-plan'

export type PublicContext = { version: 1; publicCorrelation: { version: 1; value: string } }
export type PublicSource = {
  version: 1
  provenance: { proposal: 'supplied-unverified'; correlation: 'supplied-unverified'; source: 'local-git-bound' }
  intent: 'source-change' | 'no-op'
  repository: 'erniesg/erniesg'; site: 'https://ernie.sg'; document: string; node: string
  branch: string; marker: string; trailer: string; title: string; initialIssueBody: string
  content: { parent: string; path: string; mode: '100644' | '100755'; currentBlob: string; currentSha256: string; proposedBlob: string; proposedSha256: string; proposedBytes: number }
}
type LocalContent = Omit<Prepared, 'status'> & { status: 'planned'; baseBlob: string; currentBlob: string; mode: string }
export type PublicIdentity = {
  metadata: Omit<PublicSource, 'intent' | 'content'>
  binding: { parent: string; path: string; base: string; bodySha256: string }
}
const refused = (reason: string): Failure => ({ status: 'refused', reason })
const commit = (value: string) => /^[0-9a-f]{40}$/.test(value)
const digest = (value: string) => /^[0-9a-f]{64}$/.test(value)

/** raw is the constrained scalar copy captured synchronously by local-source. */
export function preparePublicIdentity(context: ContextData, raw: PublicContext): PublicIdentity | Failure {
  const parsed = publicCorrelationSchema.safeParse(raw.publicCorrelation)
  if (raw.version !== 1 || !parsed.success || Buffer.byteLength(JSON.stringify(raw)) > 256) return refused('invalid-public-context')
  const { snapshot } = context
  const route = /^https:\/\/ernie\.sg\/books\/[a-z0-9]+(?:-[a-z0-9]+)*\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(snapshot.document)
  if (snapshot.site !== 'https://ernie.sg' || !route || !commit(context.expectedHead) || !commit(snapshot.baseCommit) ||
      ![ `books/chapters/${route[1]}.md`, `books/challenges/${route[1]}/challenge.md` ].includes(snapshot.sourcePath)) return refused('unsupported-public-target')
  if (Buffer.byteLength(snapshot.document) > 4096 || Buffer.byteLength(snapshot.sourcePath) > 512) return { status: 'not_evaluated', reason: 'public-metadata-limit' }
  const opaque = parsed.data.value, node = route[1], marker = `margin-proposal:${opaque}`
  return {
    metadata: { version: 1, provenance: { proposal: 'supplied-unverified', correlation: 'supplied-unverified', source: 'local-git-bound' },
      repository: 'erniesg/erniesg', site: 'https://ernie.sg', document: snapshot.document, node,
      branch: `coordinator/margin-proposal-${opaque}`, marker, trailer: `Margin-Proposal: ${opaque}`,
      title: `Margin proposal for ${node}`, initialIssueBody: `Node: ${snapshot.document}\n\n<!-- ${marker} -->\n` },
    binding: { parent: context.expectedHead, path: snapshot.sourcePath, base: snapshot.baseCommit, bodySha256: sha256(snapshot.body) },
  }
}

/** Only local-source supplies LocalContent; these hashes bind bytes, not approval. */
export function bindPublicSource(identity: PublicIdentity, plan: LocalContent): PublicSource | Failure {
  const { binding } = identity
  if (plan.currentCommit !== binding.parent || plan.sourcePath !== binding.path || plan.baseCommit !== binding.base ||
      plan.snapshotBodySha256 !== binding.bodySha256 || !['100644', '100755'].includes(plan.mode) ||
      !commit(plan.currentBlob) || !commit(plan.baseBlob) || !digest(plan.currentSha256) || !digest(plan.proposedSha256) ||
      !(plan.proposedBytes instanceof Uint8Array) || plan.proposedBytes.byteLength > LIMITS.sourceBytes ||
      sha256(plan.proposedBytes) !== plan.proposedSha256 || plan.changed !== (plan.currentSha256 !== plan.proposedSha256)) return refused('public-content-mismatch')
  const result: PublicSource = { ...identity.metadata, provenance: { ...identity.metadata.provenance }, intent: plan.changed ? 'source-change' : 'no-op',
    content: { parent: plan.currentCommit, path: plan.sourcePath, mode: plan.mode as '100644' | '100755', currentBlob: plan.currentBlob,
      currentSha256: plan.currentSha256, proposedBlob: createHash('sha1').update(`blob ${plan.proposedBytes.byteLength}\0`).update(plan.proposedBytes).digest('hex'),
      proposedSha256: plan.proposedSha256, proposedBytes: plan.proposedBytes.byteLength } }
  return Buffer.byteLength(JSON.stringify(result)) > 8192 ? { status: 'not_evaluated', reason: 'public-metadata-limit' } : result
}
