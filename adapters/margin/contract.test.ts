import { describe, expect, it } from 'vitest'
import { createApprovedSnapshot, type SourceAdapter } from './contract'
import { resolveChallengeDocument } from './challenges'

const registry = [
  { id: 'ch01-values', kind: 'chapter' },
  { id: 'missing-items', kind: 'challenge' },
] as const

describe('portable margin adapter pilot', () => {
  it('resolves a known chapter to its source', () => {
    expect(resolveChallengeDocument('ch01-values', registry)).toEqual({
      documentId: 'ch01-values',
      kind: 'chapter',
      location: 'books/chapters/ch01-values.md',
    })
  })

  it('resolves a known challenge to its source', () => {
    expect(resolveChallengeDocument('missing-items', registry)).toEqual({
      documentId: 'missing-items',
      kind: 'challenge',
      location: 'books/challenges/missing-items/challenge.md',
    })
  })

  it('rejects an unknown document', () => {
    expect(() => resolveChallengeDocument('not-in-registry', registry)).toThrow()
  })

  it('copies a reviewed revision for a second in-memory adapter', async () => {
    const input = {
      proposalId: 'proposal-1',
      revision: 2,
      baseRevision: 'base-7',
      canonicalBody: '{"v":1,"hunks":[{"baseStartLine":1,"baseEndLine":1,"criticMarkup":"{++new++}"}]}',
      sourceReference: { documentId: 'doc-1', location: 'memory:doc-1' },
    }
    const snapshot = createApprovedSnapshot(input)
    const written: string[] = []
    const adapter: SourceAdapter = {
      resolveDocument: (id) => ({ documentId: id, location: `memory:${id}` }),
      applyApproved: async (approved) => {
        written.push(approved.canonicalBody)
        return { state: 'submitted', reference: 'memory:change-1' }
      },
    }
    input.canonicalBody = 'edited later'
    input.sourceReference.location = 'memory:changed'
    expect(await adapter.applyApproved(snapshot)).toEqual({ state: 'submitted', reference: 'memory:change-1' })
    expect(written).toEqual(['{"v":1,"hunks":[{"baseStartLine":1,"baseEndLine":1,"criticMarkup":"{++new++}"}]}'])
    expect(snapshot.sourceReference.location).toBe('memory:doc-1')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.sourceReference)).toBe(true)
  })
})

describe('registry-bound document resolution', () => {
  it.each([
    '', '/books/chapters/ch01-values.md', '../ch01-values', 'ch01/values',
    'ch01\\values', '.', '..', 'ch01%2fvalues', '%2e%2e',
    'ch01-values.md', 'ch01_values', 'CH01-values', 'a'.repeat(129),
  ])('rejects unsafe or malformed id %j', (id) => {
    expect(() => resolveChallengeDocument(id, registry)).toThrow()
  })

  it('rejects a known node requested as the wrong kind', () => {
    expect(() => resolveChallengeDocument('ch01-values', registry, 'challenge')).toThrow(/kind mismatch/)
    expect(() => resolveChallengeDocument('missing-items', registry, 'chapter')).toThrow(/kind mismatch/)
  })

  it.each([
    { entries: [{ id: 'ch01-values', kind: 'chapter', sourcePath: '../../outside' }] },
    { entries: [{ id: 'ch01-values', kind: 'other' }] },
    { entries: [{ id: '../escape', kind: 'chapter' }] },
    { entries: [{ id: 'ch01-values', kind: 'chapter' }, { id: 'ch01-values', kind: 'chapter' }] },
    { entries: [{ id: 'ch01-values', kind: 'chapter' }, { id: 'bad%2fid', kind: 'chapter' }] },
  ])('rejects malformed registry entries, including entries after the match', ({ entries }) => {
    expect(() => resolveChallengeDocument('ch01-values', entries as never)).toThrow()
  })

  it('rejects a registry beyond the bounded number of entries', () => {
    const entries = Array.from({ length: 10_001 }, (_, index) => ({ id: `node-${index}`, kind: 'chapter' as const }))
    expect(() => resolveChallengeDocument('node-1', entries)).toThrow(/registry/)
  })
})

describe('approved snapshot boundary', () => {
  const valid = () => ({
    proposalId: 'proposal-1', revision: 1, baseRevision: 'commit-1',
    canonicalBody: '{"v":1,"hunks":[]}',
    sourceReference: { documentId: 'doc-1', location: 'memory:doc-1' },
  })

  it('rejects extra service input, including credentials', () => {
    expect(() => createApprovedSnapshot({ ...valid(), token: 'unexpected' })).toThrow(/fields/)
    expect(() => createApprovedSnapshot({ ...valid(), sourceReference: {
      ...valid().sourceReference, credential: 'unexpected',
    } })).toThrow(/fields/)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2'])('rejects invalid revision %j', (revision) => {
    expect(() => createApprovedSnapshot({ ...valid(), revision })).toThrow(/revision/)
  })

  it('rejects missing source, base, body, or proposal identity', () => {
    for (const key of ['proposalId', 'baseRevision', 'canonicalBody'] as const) {
      expect(() => createApprovedSnapshot({ ...valid(), [key]: '' })).toThrow()
    }
    expect(() => createApprovedSnapshot({ ...valid(), sourceReference: { documentId: '', location: 'x' } })).toThrow()
  })

  it('hands the exact approved values to a second site adapter', async () => {
    const applied: unknown[] = []
    const adapter: SourceAdapter = {
      resolveDocument: (id) => ({ documentId: id, location: `memory:${id}` }),
      applyApproved: async (snapshot) => {
        applied.push(snapshot)
        return { state: 'completed', revision: 'memory-revision-9' }
      },
    }
    const source = await adapter.resolveDocument('doc-1')
    const snapshot = createApprovedSnapshot({ ...valid(), revision: 7, sourceReference: source })
    expect(await adapter.applyApproved(snapshot)).toEqual({ state: 'completed', revision: 'memory-revision-9' })
    expect(applied).toEqual([{
      proposalId: 'proposal-1', revision: 7, baseRevision: 'commit-1',
      canonicalBody: '{"v":1,"hunks":[]}',
      sourceReference: { documentId: 'doc-1', location: 'memory:doc-1' },
    }])
  })
})
