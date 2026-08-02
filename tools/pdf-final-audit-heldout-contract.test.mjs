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

describe('final audit blind held-out contract', () => {
  it('locks the complete complement left untouched by fixed and round-2 samples', async () => {
    const [baseBytes, round2Bytes, finalBytes] = await Promise.all([
      readFile(
        new URL('../benchmarks/pdf/corpus-contract-v2.json', import.meta.url),
      ),
      readFile(
        new URL(
          '../benchmarks/pdf/overnight-heldout-contract-v1.json',
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          '../benchmarks/pdf/final-audit-heldout-contract-v1.json',
          import.meta.url,
        ),
      ),
    ])
    const base = JSON.parse(baseBytes)
    const round2 = JSON.parse(round2Bytes)
    const final = JSON.parse(finalBytes)
    expect(sha256(baseBytes)).toBe(final.sourceContracts.fixedCorpusFileSha256)
    expect(sha256(round2Bytes)).toBe(final.sourceContracts.round2DrawFileSha256)
    expect(sha256(final.selection.seed)).toBe(
      final.selection.seedCommitmentSha256,
    )

    const excludedIds = new Set([
      ...base.frozen.documents.map(({ id }) => id),
      ...base.seededRandom.documents.map(({ id }) => id),
      ...round2.selection.documents.map(({ id }) => id),
    ])
    const eligible = base.seededRandom.catalog.filter(
      ({ id }) => !excludedIds.has(id),
    )
    expect(eligible).toHaveLength(final.selection.eligibleCatalogCount)
    expect(
      sha256(
        canonicalJson(
          [...eligible].sort((left, right) => left.id.localeCompare(right.id)),
        ),
      ),
    ).toBe(final.selection.eligibleCatalogSha256)

    const expected = eligible
      .map((document) => ({
        document,
        rankSha256: sha256(
          `${final.selection.seed}\0${document.id}\0${document.sha256}`,
        ),
      }))
      .sort(
        (left, right) =>
          left.rankSha256.localeCompare(right.rankSha256) ||
          left.document.id.localeCompare(right.document.id),
      )
    expect(
      final.selection.documents.map(({ rankSha256, ...document }) => ({
        document,
        rankSha256,
      })),
    ).toEqual(expected)
    expect(final.selection.documents).toHaveLength(3)
    expect(
      sha256(
        canonicalJson(
          final.selection.documents.map(
            ({ rankSha256: _rankSha256, ...document }) => document,
          ),
        ),
      ),
    ).toBe(final.selection.selectionSha256)
    expect(final.noTuningPolicy).toMatchObject({
      implementationLockedBeforeFirstInspection: true,
      paperSpecificChangesAfterObservationForbidden: true,
      failuresRemainFailures: true,
    })
  })
})
