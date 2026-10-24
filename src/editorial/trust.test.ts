import { describe, expect, it } from 'vitest'

import {
  EDITORIAL_PRODUCER_RECORD_TYPE,
  producerRecordSchema,
  trustEpochIsAcceptable,
  trustKeyIsUsableAt,
  trustNextState,
  trustPreconditionsHold,
  trustProducerRecordIsFresh,
  trustRotationOverlapsWithin,
  TRUST_MAX_RECORD_AGE_SECONDS,
  type ProducerKey,
  type ProducerRecord,
} from './trust'
import {
  ARTIFACTS,
  BUNDLE_SHA256,
  DOCUMENT_SHA256,
  LATER,
  PACKAGE_ARTIFACT,
  PACKAGE_ARTIFACT_SHA256,
  PACKAGE_INTEGRITY,
  PACKAGE_SOURCE_COMMIT,
  PACKAGE_VERSION,
  candidateFixture,
  revisionFixture,
} from './fixtures'
import { editorialArtifactSetDigest } from './ids'

const KEY: ProducerKey = {
  keyId: 'producer-key-1',
  policyEpoch: 4,
  algorithm: 'ed25519',
  notBefore: '2026-10-01T00:00:00.000Z',
  notAfter: '2026-12-01T00:00:00.000Z',
}

function producerRecordFixture(
  overrides: Partial<ProducerRecord> = {},
): ProducerRecord {
  const revision = revisionFixture()
  const candidate = candidateFixture(revision)
  return {
    recordType: EDITORIAL_PRODUCER_RECORD_TYPE,
    version: '1.0.0',
    producerRecordId: 'producer-record-1',
    eventId: 'event-1',
    keyId: KEY.keyId,
    policyEpoch: KEY.policyEpoch,
    releaseId: 'urn:editorial:release:' + 'a'.repeat(64),
    releaseSha256: 'b'.repeat(64),
    approvedRevisionId: revision.id,
    contentHash: revision.contentHash,
    documentSha256: DOCUMENT_SHA256,
    bundleSha256: BUNDLE_SHA256,
    package: {
      sourceCommit: PACKAGE_SOURCE_COMMIT,
      artifact: PACKAGE_ARTIFACT,
      artifactSha256: PACKAGE_ARTIFACT_SHA256,
      integrity: PACKAGE_INTEGRITY,
      version: PACKAGE_VERSION,
    },
    schemaVersions: revision.schemaVersions,
    artifacts: [...ARTIFACTS],
    artifactSetSha256: editorialArtifactSetDigest(ARTIFACTS),
    target: candidate.target,
    issuedAt: LATER,
    expiresAt: '2026-10-21T10:00:00.000Z',
    status: 'active',
    signatureAlgorithm: 'ed25519',
    signature: 'c2lnbmF0dXJl',
    ...overrides,
  }
}

describe('the producer trust contract', () => {
  it('binds a versioned record type and every published digest', () => {
    const record = producerRecordFixture()

    expect(producerRecordSchema.safeParse(record).success).toBe(true)
    expect(record.recordType).toBe(EDITORIAL_PRODUCER_RECORD_TYPE)
    expect(record.documentSha256).toBe(DOCUMENT_SHA256)
    expect(record.bundleSha256).toBe(BUNDLE_SHA256)
    expect(record.package.artifactSha256).toBe(PACKAGE_ARTIFACT_SHA256)
    expect(record.artifactSetSha256).toBe(
      editorialArtifactSetDigest(ARTIFACTS),
    )
  })

  it('refuses a producer record that names no revision', () => {
    expect(
      producerRecordSchema.safeParse(
        producerRecordFixture({ approvedRevisionId: 'not-a-revision' }),
      ).success,
    ).toBe(false)
  })

  it('accepts only an epoch that advances', () => {
    expect(trustEpochIsAcceptable(5, { highestAcceptedEpoch: 4 })).toBe(true)
    expect(trustEpochIsAcceptable(4, { highestAcceptedEpoch: 4 })).toBe(false)
    expect(trustEpochIsAcceptable(3, { highestAcceptedEpoch: 4 })).toBe(false)
  })

  it('advances the accepted epoch and never lowers it', () => {
    expect(
      trustNextState(5, { highestAcceptedEpoch: 4 }).highestAcceptedEpoch,
    ).toBe(5)
    expect(
      trustNextState(3, { highestAcceptedEpoch: 4 }).highestAcceptedEpoch,
    ).toBe(4)
  })

  it('refuses a record that is expired', () => {
    const record = producerRecordFixture()

    expect(
      trustProducerRecordIsFresh(record, new Date('2026-10-20T11:00:00.000Z')),
    ).toBe(true)
    expect(
      trustProducerRecordIsFresh(record, new Date('2026-10-25T11:00:00.000Z')),
    ).toBe(false)
  })

  it('refuses a record issued too far in the future', () => {
    const record = producerRecordFixture({
      issuedAt: '2026-10-20T11:10:00.000Z',
      expiresAt: '2026-10-21T10:00:00.000Z',
    })

    expect(
      trustProducerRecordIsFresh(record, new Date('2026-10-20T11:00:00.000Z')),
    ).toBe(false)
  })

  it('refuses a record whose validity window is longer than the policy allows', () => {
    const record = producerRecordFixture({
      issuedAt: '2026-10-20T10:00:00.000Z',
      expiresAt: '2026-11-20T10:00:00.000Z',
    })

    expect(
      trustProducerRecordIsFresh(record, new Date('2026-10-20T11:00:00.000Z')),
    ).toBe(false)
  })

  it('refuses a record older than the freshness bound', () => {
    const issued = new Date('2026-10-20T10:00:00.000Z')
    const record = producerRecordFixture({
      issuedAt: issued.toISOString(),
      expiresAt: '2026-10-21T10:00:00.000Z',
    })
    const tooLate = new Date(
      issued.getTime() + (TRUST_MAX_RECORD_AGE_SECONDS + 60) * 1000,
    )

    expect(trustProducerRecordIsFresh(record, tooLate)).toBe(false)
  })

  it('refuses a revoked key from its revocation onwards', () => {
    const revoked: ProducerKey = {
      ...KEY,
      revokedAt: '2026-10-20T09:00:00.000Z',
    }

    expect(
      trustKeyIsUsableAt(revoked, new Date('2026-10-20T08:00:00.000Z')),
    ).toBe(true)
    expect(
      trustKeyIsUsableAt(revoked, new Date('2026-10-20T10:00:00.000Z')),
    ).toBe(false)
  })

  it('refuses a compromised key for its entire lifetime', () => {
    const compromised: ProducerKey = {
      ...KEY,
      compromisedAt: '2026-10-20T09:00:00.000Z',
    }

    expect(
      trustKeyIsUsableAt(compromised, new Date('2026-10-20T08:00:00.000Z')),
    ).toBe(false)
  })

  it('refuses a key used outside its own validity window', () => {
    expect(
      trustKeyIsUsableAt(KEY, new Date('2026-09-30T23:00:00.000Z')),
    ).toBe(false)
    expect(
      trustKeyIsUsableAt(KEY, new Date('2026-12-02T00:00:00.000Z')),
    ).toBe(false)
  })

  it('bounds the overlap of a key rotation', () => {
    expect(
      trustRotationOverlapsWithin(
        { notAfter: '2026-10-20T00:00:00.000Z' },
        { notBefore: '2026-10-20T12:00:00.000Z' },
      ),
    ).toBe(true)
    expect(
      trustRotationOverlapsWithin(
        { notAfter: '2026-10-20T00:00:00.000Z' },
        { notBefore: '2026-10-25T00:00:00.000Z' },
      ),
    ).toBe(false)
  })

  it('fails closed when the epoch has not advanced', () => {
    const record = producerRecordFixture()
    const outcome = trustPreconditionsHold({
      record,
      key: { ...KEY, policyEpoch: 4 },
      state: { highestAcceptedEpoch: 4 },
      now: new Date('2026-10-20T11:00:00.000Z'),
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('producer_epoch_not_advanced')
  })

  it('fails closed when the key was revoked', () => {
    const record = producerRecordFixture()
    const outcome = trustPreconditionsHold({
      record,
      key: { ...KEY, revokedAt: '2026-10-20T09:00:00.000Z' },
      state: { highestAcceptedEpoch: 3 },
      now: new Date('2026-10-20T11:00:00.000Z'),
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('producer_key_not_usable')
  })

  it('fails closed when the record is stale', () => {
    const record = producerRecordFixture()
    const outcome = trustPreconditionsHold({
      record,
      key: KEY,
      state: { highestAcceptedEpoch: 3 },
      now: new Date('2026-10-25T11:00:00.000Z'),
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('producer_record_not_fresh')
  })

  it('passes when the epoch advanced, the record is fresh and the key is usable', () => {
    const record = producerRecordFixture()
    const outcome = trustPreconditionsHold({
      record,
      key: KEY,
      state: { highestAcceptedEpoch: 3 },
      now: new Date('2026-10-20T11:00:00.000Z'),
    })

    expect(outcome.ok).toBe(true)
  })
})
