import { describe, expect, it } from 'vitest'
import { formatHunks } from '../../src/annotations/criticmarkup'

const head = 'a'.repeat(40)
const sourcePath = 'books/chapters/intro.md'
export function input() {
  return {
    expectedHead: head,
    snapshot: { site: 'https://ernie.sg', document: 'https://ernie.sg/books/test/intro/', revision: 1, baseCommit: head, sourcePath, body: formatHunks([{ baseStartLine: 1, baseEndLine: 1, criticMarkup: '{~~old~>new~~}\n' }]) },
    mapping: { site: 'https://ernie.sg', head, documents: [{ document: 'https://ernie.sg/books/test/intro/', sourcePath }] },
    baseBytes: Buffer.from('old\n'), currentBytes: Buffer.from('old\n'),
  }
}

describe('approved source data planner', () => {
  it('computes exact bytes and the existing authoritative diff', async () => {
    const { planApprovedSource } = await import('./source-plan')
    const result = planApprovedSource(input())
    expect(result.status).toBe('planned')
    if (result.status !== 'planned') throw Error('not planned')
    expect(Buffer.from(result.proposedBytes).toString()).toBe('new\n')
    expect(result.approvedBaseDiff).toContain('-old\n+new\n')
    expect(result.rebased).toBe(false)
  })
  it('refuses mapping confusion and duplicate document identities', async () => {
    const { planApprovedSource } = await import('./source-plan')
    const data = input()
    data.mapping.documents.push({ ...data.mapping.documents[0] })
    expect(planApprovedSource(data)).toMatchObject({ status: 'refused', reason: 'ambiguous-document' })
    data.mapping.documents.pop()
    data.snapshot.sourcePath = 'books/chapters/other.md'
    expect(planApprovedSource(data)).toMatchObject({ status: 'refused', reason: 'source-mismatch' })
  })
  it('preserves UTF8 BOM, CRLF and missing final newline', async () => {
    const { planApprovedSource } = await import('./source-plan')
    const data = input()
    data.baseBytes = data.currentBytes = Buffer.from('\ufeffold\r\nlast')
    data.snapshot.body = formatHunks([{ baseStartLine: 1, baseEndLine: 1, criticMarkup: '\ufeff{~~old~>new~~}\r\n' }])
    const result = planApprovedSource(data)
    expect(result.status).toBe('planned')
    if (result.status !== 'planned') throw Error('not planned')
    expect(Buffer.from(result.proposedBytes)).toEqual(Buffer.from('\ufeffnew\r\nlast'))
  })
})

describe('mapping and conversion invariant sweep', () => {
  it.each([
    ['site-confusion', (d: ReturnType<typeof input>) => { d.snapshot.site = 'https://elsewhere.invalid' }],
    ['fragment', (d: ReturnType<typeof input>) => { d.snapshot.document += '#selection' }],
    ['query', (d: ReturnType<typeof input>) => { d.snapshot.document += '?q=1' }],
    ['escaped-alias', (d: ReturnType<typeof input>) => { d.snapshot.document = d.snapshot.document.replace('intro', '%69ntro') }],
    ['userinfo', (d: ReturnType<typeof input>) => { d.snapshot.document = d.snapshot.document.replace('https://', 'https://user@') }],
    ['traversal', (d: ReturnType<typeof input>) => { d.snapshot.sourcePath = 'books/chapters/../intro.md' }],
    ['diff-header', (d: ReturnType<typeof input>) => { d.snapshot.sourcePath += '\nother' }],
    ['absolute', (d: ReturnType<typeof input>) => { d.snapshot.sourcePath = '/' + d.snapshot.sourcePath }],
    ['windows', (d: ReturnType<typeof input>) => { d.snapshot.sourcePath = 'books\\chapters\\intro.md' }],
    ['stale-capture', (d: ReturnType<typeof input>) => { d.mapping.head = 'c'.repeat(40) }],
    ['short-head', (d: ReturnType<typeof input>) => { d.expectedHead = 'abc123' }],
    ['short-base', (d: ReturnType<typeof input>) => { d.snapshot.baseCommit = 'abc123' }],
    ['uppercase-base', (d: ReturnType<typeof input>) => { d.snapshot.baseCommit = 'A'.repeat(40) }],
    ['zero-revision', (d: ReturnType<typeof input>) => { d.snapshot.revision = 0 }],
    ['fraction-revision', (d: ReturnType<typeof input>) => { d.snapshot.revision = 1.5 }],
    ['overflow-revision', (d: ReturnType<typeof input>) => { d.snapshot.revision = Number.MAX_SAFE_INTEGER }],
    ['caller-approval', (d: ReturnType<typeof input>) => { Object.assign(d.snapshot, { approved: true }) }],
    ['missing-stamp', (d: ReturnType<typeof input>) => { Object.assign(d.snapshot, { baseCommit: null }) }],
    ['current-envelope', (d: ReturnType<typeof input>) => { Object.assign(d.snapshot, { revision: '1' }) }],
    ['unmapped', (d: ReturnType<typeof input>) => { d.mapping.documents = [] }],
    ['noncanonical-json', (d: ReturnType<typeof input>) => { d.snapshot.body = ' ' + d.snapshot.body }],
    ['rejected-text-mismatch', (d: ReturnType<typeof input>) => { d.baseBytes = d.currentBytes = Buffer.from('other\n') }],
    ['invalid-utf8', (d: ReturnType<typeof input>) => { d.baseBytes = Buffer.from([0xff]) }],
    ['nul-source', (d: ReturnType<typeof input>) => { d.baseBytes = Buffer.from('old\0\n') }],
    ['lone-surrogate', (d: ReturnType<typeof input>) => { d.snapshot.body += '\ud800' }],
  ])('refuses %s without a usable file', async (_name, change) => {
    const { planApprovedSource } = await import('./source-plan')
    const d = input(); change(d)
    const r = planApprovedSource(d)
    expect(r.status).toBe('refused'); expect(r).not.toHaveProperty('proposedBytes')
  })
  it('requires the converter mid-line invariant, not applyHunks alone', async () => {
    const { planApprovedSource } = await import('./source-plan')
    const d = input(); d.baseBytes = d.currentBytes = Buffer.from('old\nlast\n')
    d.snapshot.body = formatHunks([{ baseStartLine: 1, baseEndLine: 1, criticMarkup: '{~~old\n~>new~~}' }])
    expect(planApprovedSource(d).status).toBe('refused')
  })
  it.each(['body', 'source', 'lines', 'rows'] as const)('reports unavailable for the %s resource bound', async kind => {
    const { planApprovedSource, LIMITS } = await import('./source-plan')
    const d = input()
    if (kind === 'body') d.snapshot.body = 'x'.repeat(LIMITS.bodyBytes + 1)
    if (kind === 'source') d.baseBytes = Buffer.alloc(LIMITS.sourceBytes + 1)
    if (kind === 'lines') d.baseBytes = Buffer.from('\n'.repeat(LIMITS.sourceLines))
    if (kind === 'rows') d.mapping.documents = Array.from({ length: LIMITS.mappingRows + 1 }, () => d.mapping.documents[0])
    const r = planApprovedSource(d); expect(r.status).toBe('not_evaluated'); expect(r).not.toHaveProperty('proposedBytes')
  })
  it('keeps absence separate, supports challenge/shared-node mappings and full SHA256 IDs', async () => {
    const { planApprovedSource } = await import('./source-plan')
    const d = input()
    expect(planApprovedSource({ ...d, mapping: null })).toMatchObject({ status: 'not_evaluated', reason: 'mapping-unavailable' })
    d.expectedHead = d.snapshot.baseCommit = d.mapping.head = 'a'.repeat(64)
    d.snapshot.sourcePath = d.mapping.documents[0].sourcePath = 'books/challenges/intro/challenge.md'
    d.mapping.documents.push({ document: 'https://ernie.sg/books/second/intro/', sourcePath: d.snapshot.sourcePath })
    expect(planApprovedSource(d).status).toBe('planned')
  })
  it('binds only the supplied snapshot and explicitly labels stale-base computation', async () => {
    const { planApprovedSource } = await import('./source-plan')
    const d = input(); d.snapshot.baseCommit = 'c'.repeat(40)
    const old = planApprovedSource(d)
    expect(old).toMatchObject({ status: 'planned', rebased: true })
    d.currentBytes = Buffer.from('old\nextra\n')
    expect(planApprovedSource(d)).toMatchObject({ status: 'needs_merge', rebased: true })
    // Extra current-annotation envelope is not substituted for the separately supplied snapshot.
    expect(planApprovedSource({ ...input(), currentAnnotation: { body: 'later', revision: 99 } })).toEqual(planApprovedSource(input()))
  })
  it('returns an explicit no-op without treating marker-looking source as a conflict', async () => {
    const { planApprovedSource } = await import('./source-plan')
    const d = input(); d.baseBytes = d.currentBytes = Buffer.from('<<<<<<< current\n')
    d.snapshot.body = formatHunks([{ baseStartLine: 1, baseEndLine: 1, criticMarkup: '<<<<<<< current\n' }])
    expect(planApprovedSource(d)).toMatchObject({ status: 'planned', changed: false })
  })
})

it('accepts exact source, canonical-body and mapping-row limits without off-by-one refusal', async () => {
  const { LIMITS, planApprovedSource } = await import('./source-plan')
  const d = input()
  const fixed = formatHunks([{ baseStartLine: 1, baseEndLine: 1, criticMarkup: '{~~old~>new~~}\n' }])
  const filler = 'z'.repeat(LIMITS.bodyBytes - Buffer.byteLength(fixed))
  d.snapshot.body = formatHunks([{ baseStartLine: 1, baseEndLine: 1, criticMarkup: '{~~old~>new~~}' + filler + '\n' }])
  d.baseBytes = d.currentBytes = Buffer.from('old' + filler + '\n' + 'x'.repeat(LIMITS.sourceBytes - 4 - filler.length))
  expect(Buffer.byteLength(d.snapshot.body)).toBe(LIMITS.bodyBytes)
  d.mapping.documents = [d.mapping.documents[0], ...Array.from({ length: LIMITS.mappingRows - 1 }, (_, i) => ({ document: `https://ernie.sg/books/other/intro-${i}/`, sourcePath: d.snapshot.sourcePath }))]
  const r = planApprovedSource(d)
  expect(r.status).toBe('planned')
  if (r.status !== 'planned') throw Error('not planned')
  expect(r.proposedBytes.byteLength).toBe(LIMITS.sourceBytes)
})

it.each(['user@', 'user:password@'])('refuses userinfo even when both supplied mapping and document agree: %s', async userinfo => {
  const { planApprovedSource } = await import('./source-plan')
  const d = input(); d.snapshot.document = d.mapping.documents[0].document = d.snapshot.document.replace('https://', `https://${userinfo}`)
  expect(planApprovedSource(d).status).toBe('refused')
})
