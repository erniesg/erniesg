import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

describe('overnight blind held-out contract', () => {
  it('reproduces a selection disjoint from the complete fixed 20', async () => {
    const [baseBytes, heldoutBytes] = await Promise.all([
      readFile(
        new URL('../benchmarks/pdf/corpus-contract-v2.json', import.meta.url),
      ),
      readFile(
        new URL(
          '../benchmarks/pdf/overnight-heldout-contract-v1.json',
          import.meta.url,
        ),
      ),
    ])
    const base = JSON.parse(baseBytes)
    const heldout = JSON.parse(heldoutBytes)
    expect(sha256(baseBytes)).toBe(heldout.fixedCorpus.sourceContractFileSha256)

    const fixed = [...base.frozen.documents, ...base.seededRandom.documents]
    expect(fixed).toHaveLength(20)
    expect(sha256(canonicalJson(fixed))).toBe(
      heldout.fixedCorpus.identitySha256,
    )
    const fixedIds = new Set(fixed.map(({ id }) => id))
    const eligible = base.seededRandom.catalog.filter(
      ({ id }) => !fixedIds.has(id),
    )
    expect(eligible).toHaveLength(heldout.selection.eligibleCatalogCount)
    expect(
      sha256(
        canonicalJson(
          [...eligible].sort((left, right) => left.id.localeCompare(right.id)),
        ),
      ),
    ).toBe(heldout.selection.eligibleCatalogSha256)
    expect(sha256(heldout.selection.seed)).toBe(
      heldout.selection.seedCommitmentSha256,
    )

    const expected = eligible
      .map((document) => ({
        document,
        rankSha256: sha256(
          `${heldout.selection.seed}\0${document.id}\0${document.sha256}`,
        ),
      }))
      .sort(
        (left, right) =>
          left.rankSha256.localeCompare(right.rankSha256) ||
          left.document.id.localeCompare(right.document.id),
      )
      .slice(0, heldout.selection.sampleSize)
    expect(
      heldout.selection.documents.map(({ rankSha256, ...document }) => ({
        document,
        rankSha256,
      })),
    ).toEqual(expected)
    const selected = heldout.selection.documents.map(
      ({ rankSha256: _rankSha256, ...document }) => document,
    )
    const untouched = eligible.filter(
      ({ id }) => !selected.some((document) => document.id === id),
    )
    expect(sha256(canonicalJson(selected))).toBe(
      heldout.selection.selectionSha256,
    )
    expect(selected.some(({ id }) => fixedIds.has(id))).toBe(false)
    expect(selected).toHaveLength(3)
    expect(untouched).toHaveLength(3)
    expect(heldout.selection.untouchedFinalAuditCount).toBe(untouched.length)
    expect(heldout.noTuningPolicy).toMatchObject({
      implementationLockedBeforeRun: true,
      paperSpecificChangesAfterObservationForbidden: true,
      failuresRemainFailures: true,
    })
  })
})
