import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { formatHunks } from '../../src/annotations/criticmarkup'
import { bindPublicSource, preparePublicIdentity, type PublicContext } from './public-source-identity'
import { LIMITS, planApprovedSource, resolveDocument, sha256 } from './source-plan'

const opaque = '1'.repeat(64), head = 'a'.repeat(40)
const option = (): PublicContext => ({ version: 1, publicCorrelation: { version: 1, value: opaque } })
const oid = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
function fixture(base = 'old\n', markup = '{~~old~>new~~}\n', sourcePath = 'books/chapters/intro.md', document = 'https://ernie.sg/books/test/intro/') {
  const raw = { expectedHead: head,
    snapshot: { site: 'https://ernie.sg', document, revision: 1, baseCommit: head, sourcePath, body: formatHunks([{ baseStartLine: 1, baseEndLine: 1, criticMarkup: markup }]) },
    mapping: { site: 'https://ernie.sg', head, documents: [{ document, sourcePath }] }, baseBytes: Buffer.from(base), currentBytes: Buffer.from(base) }
  const context = resolveDocument(raw), source = planApprovedSource(raw)
  if ('status' in context || source.status !== 'planned') throw Error('invalid synthetic context')
  const plan = { ...source, status: 'planned' as const, baseBlob: oid(raw.baseBytes), currentBlob: oid(raw.currentBytes), mode: '100644' }
  const identity = preparePublicIdentity(context, option())
  if ('status' in identity) throw Error('invalid identity fixture')
  return { raw, context, plan, identity }
}

describe('deterministic public metadata and exact byte binding', () => {
  it('returns only the exact closed public shape and safe fixed templates', () => {
    const f = fixture(), result = bindPublicSource(f.identity, f.plan)
    expect(result).toEqual({ version: 1, provenance: { proposal: 'supplied-unverified', correlation: 'supplied-unverified', source: 'local-git-bound' },
      intent: 'source-change', repository: 'erniesg/erniesg', site: 'https://ernie.sg', document: f.context.snapshot.document, node: 'intro',
      branch: `coordinator/margin-proposal-${opaque}`, marker: `margin-proposal:${opaque}`, trailer: `Margin-Proposal: ${opaque}`,
      title: 'Margin proposal for intro', initialIssueBody: `Node: ${f.context.snapshot.document}\n\n<!-- margin-proposal:${opaque} -->\n`,
      content: { parent: head, path: f.plan.sourcePath, mode: '100644', currentBlob: oid(f.raw.currentBytes), currentSha256: sha256(f.raw.currentBytes),
        proposedBlob: oid(Buffer.from('new\n')), proposedSha256: sha256('new\n'), proposedBytes: 4 } })
    expect(JSON.stringify(result)).not.toContain(f.raw.snapshot.body)
    const next = preparePublicIdentity(f.context, { version: 1, publicCorrelation: { version: 1, value: '2'.repeat(64) } })
    expect(next).not.toHaveProperty('status'); if ('status' in next) throw Error('identity missing')
    expect(next.metadata.branch).not.toBe(f.identity.metadata.branch)
    expect(preparePublicIdentity(f.context, option())).toEqual(f.identity)
  })
  it.each(['100644', '100755'])('preserves regular file mode %s', mode => {
    const f = fixture(); const result = bindPublicSource(f.identity, { ...f.plan, mode })
    expect(result).toMatchObject({ content: { mode } })
  })
  it.each([
    ['BOM/CRLF', '\ufeffold\r\nlast', '\ufeff{~~old~>new~~}\r\n', '\ufeffnew\r\nlast'],
    ['no final newline', 'old', '{~~old~>new~~}', 'new'],
    ['Unicode', 'old\n', '{~~old~>新しい~~}\n', '新しい\n'],
  ])('binds exact %s bytes', (_name, base, markup, expected) => {
    const f = fixture(base, markup), before = Buffer.from(f.plan.proposedBytes)
    expect(bindPublicSource(f.identity, f.plan)).toMatchObject({ content: { proposedBlob: oid(Buffer.from(expected)), proposedSha256: sha256(expected), proposedBytes: Buffer.byteLength(expected) } })
    expect(Buffer.from(f.plan.proposedBytes)).toEqual(before)
  })
  it('uses the same node for challenge and shared routes without conflating selected documents', () => {
    const a = fixture('old\n', '{~~old~>new~~}\n', 'books/challenges/intro/challenge.md')
    const b = fixture('old\n', '{~~old~>new~~}\n', 'books/challenges/intro/challenge.md', 'https://ernie.sg/books/second/intro/')
    expect(a.identity.metadata.branch).toBe(b.identity.metadata.branch)
    expect(a.identity.metadata.node).toBe(b.identity.metadata.node)
    expect(a.identity.metadata.document).not.toBe(b.identity.metadata.document)
  })
  it('retains explicit no-op without publication or adoption authority', () => {
    const f = fixture('old\n', 'old\n')
    const result = bindPublicSource(f.identity, f.plan)
    expect(result).toMatchObject({ intent: 'no-op', content: { currentBlob: f.plan.currentBlob, proposedBlob: f.plan.currentBlob } })
    for (const key of ['create', 'adopt', 'observed', 'candidate_match', 'issueNumber', 'prNumber']) expect(result).not.toHaveProperty(key)
  })
})

describe('canonical correlation and fixed public target', () => {
  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), '1'.repeat(63) + 'g', opaque + '\n', opaque + '\r', opaque + '\r\n', opaque + '\u2028', opaque + '\u2029'])('refuses noncanonical opaque %j', value => {
    expect(preparePublicIdentity(fixture().context, { version: 1, publicCorrelation: { version: 1, value } })).toEqual({ status: 'refused', reason: 'invalid-public-context' })
  })
  it.each(['site', 'document', 'sourcePath', 'head', 'base'] as const)('refuses unsupported %s', key => {
    const f = fixture()
    if (key === 'site') f.context.snapshot.site = 'https://other.invalid'
    if (key === 'document') f.context.snapshot.document = 'https://ernie.sg/books/test/intro/?private=value'
    if (key === 'sourcePath') f.context.snapshot.sourcePath = 'books/chapters/other.md'
    if (key === 'head') f.context.expectedHead = 'a'.repeat(64)
    if (key === 'base') f.context.snapshot.baseCommit = 'a'.repeat(64)
    expect(preparePublicIdentity(f.context, option())).toEqual({ status: 'refused', reason: 'unsupported-public-target' })
  })
  it('does not serialize private fields on the source context', () => {
    const f = fixture(); Object.assign(f.context, { proposalId: 'private-id', title: 'private-title', author: 'private-author', toJSON() { throw Error('no context serialization') } })
    expect(preparePublicIdentity(f.context, option())).toEqual(f.identity)
  })
})

describe('every content binding and resource bound', () => {
  it.each(['parent', 'path', 'base', 'body', 'mode', 'currentBlob', 'baseBlob', 'currentDigest', 'proposedDigest', 'bytes', 'changed'] as const)('refuses mismatched %s', field => {
    const f = fixture(), p = { ...f.plan }
    if (field === 'parent') p.currentCommit = 'b'.repeat(40)
    if (field === 'path') p.sourcePath = 'books/chapters/other.md'
    if (field === 'base') p.baseCommit = 'b'.repeat(40)
    if (field === 'body') p.snapshotBodySha256 = 'b'.repeat(64)
    if (field === 'mode') p.mode = '120000'
    if (field === 'currentBlob') p.currentBlob = 'a'.repeat(64)
    if (field === 'baseBlob') p.baseBlob = 'a'.repeat(64)
    if (field === 'currentDigest') p.currentSha256 = 'A'.repeat(64)
    if (field === 'proposedDigest') p.proposedSha256 = 'b'.repeat(64)
    if (field === 'bytes') p.proposedBytes = Buffer.from('different\n')
    if (field === 'changed') p.changed = false
    expect(bindPublicSource(f.identity, p)).toEqual({ status: 'refused', reason: 'public-content-mismatch' })
  })
  it('accepts the exact source-byte ceiling and refuses one byte more', () => {
    const f = fixture(), bytes = Buffer.alloc(LIMITS.sourceBytes, 120)
    const p = { ...f.plan, proposedBytes: bytes, proposedSha256: sha256(bytes) }
    expect(bindPublicSource(f.identity, p)).toMatchObject({ content: { proposedBytes: LIMITS.sourceBytes } })
    const over = Buffer.alloc(LIMITS.sourceBytes + 1, 120)
    expect(bindPublicSource(f.identity, { ...p, proposedBytes: over, proposedSha256: sha256(over) })).toEqual({ status: 'refused', reason: 'public-content-mismatch' })
  })
  it('bounds actual generated metadata around 8KiB without truncating', () => {
    const f = fixture()
    // A long valid public book slug duplicates in document/body. Find the
    // reachable adjacent sizes; no arbitrary caller metadata is introduced.
    const results = [3400, 3500, 3600, 3700, 3800].map(length => {
      const context = { ...f.context, snapshot: { ...f.context.snapshot, document: `https://ernie.sg/books/${'b'.repeat(length)}/intro/` } }
      const identity = preparePublicIdentity(context, option())
      if ('status' in identity) return identity
      return bindPublicSource(identity, f.plan)
    })
    expect(results.some(r => !('status' in r))).toBe(true)
    expect(results.some(r => 'status' in r && r.reason === 'public-metadata-limit')).toBe(true)
    for (const r of results) if (!('status' in r)) expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(8192)
  })
  it('copies metadata provenance so caller mutation of a returned value cannot change later output', () => {
    const f = fixture(), first = bindPublicSource(f.identity, f.plan)
    if ('status' in first) throw Error('missing metadata')
    first.provenance.source = 'changed' as typeof first.provenance.source
    expect(bindPublicSource(f.identity, f.plan)).toMatchObject({ provenance: { source: 'local-git-bound' } })
  })
})
