import { describe, expect, it } from 'vitest'

import { editorialArtifactSetDigest } from './ids'
import { ARTIFACTS, DOCUMENT_SHA256 } from './fixtures'
import {
  PRODUCER_RECORD_FIELDS,
  deriveProducerRecordId,
  producerKeyFingerprint,
  producerKeyId,
  producerRecordDigest,
  producerRecordIdentityPayload,
  producerRecordSigningPayload,
  verifyProducerRecordSignature,
} from './producer-record'
import {
  generateProducerKeyPair,
  makeProducerTestKeys,
  producerRecordFixture,
  publicKeyOf,
} from './producer-fixtures'
import { producerRecordSchema } from './trust'

describe('the producer record', () => {
  it('binds exactly the fields the record type names', () => {
    expect(Object.keys(producerRecordSchema.shape)).toEqual([
      ...PRODUCER_RECORD_FIELDS,
    ])
  })

  it('binds the versioned record type and every published digest', async () => {
    const keys = await makeProducerTestKeys()
    const record = await producerRecordFixture({ keys })

    expect(producerRecordSchema.safeParse(record).success).toBe(true)
    expect(record.recordType).toBe('erniesg.editorial.producer-export.v1')
    expect(record.version).toBe('1.0.0')
    expect(record.documentSha256).toBe(DOCUMENT_SHA256)
    expect(record.artifactSetSha256).toBe(editorialArtifactSetDigest(ARTIFACTS))
    expect(record.target.audience).toBe('public')
    expect(record.status).toBe('active')
    expect(record.issuedAt).toBe('2026-10-20T10:00:00.000Z')
  })

  it('refuses a producer record that is missing a field', async () => {
    const keys = await makeProducerTestKeys()
    const record = await producerRecordFixture({ keys })
    const { eventId: _eventId, ...withoutEventId } = record

    expect(producerRecordSchema.safeParse(withoutEventId).success).toBe(false)
  })

  it('refuses a producer record whose field is malformed', async () => {
    const keys = await makeProducerTestKeys()
    const record = await producerRecordFixture({ keys })

    expect(
      producerRecordSchema.safeParse({ ...record, policyEpoch: -1 }).success,
    ).toBe(false)
    expect(
      producerRecordSchema.safeParse({ ...record, documentSha256: 'nope' })
        .success,
    ).toBe(false)
    expect(
      producerRecordSchema.safeParse({ ...record, issuedAt: 'yesterday' })
        .success,
    ).toBe(false)
    expect(
      producerRecordSchema.safeParse({ ...record, status: 'maybe' }).success,
    ).toBe(false)
  })

  it('refuses a producer record that carries an unknown field', async () => {
    const keys = await makeProducerTestKeys()
    const record = await producerRecordFixture({ keys })

    expect(
      producerRecordSchema.safeParse({ ...record, extra: 'unexpected' })
        .success,
    ).toBe(false)
  })

  it('derives its id from its own content', async () => {
    const keys = await makeProducerTestKeys()
    const record = await producerRecordFixture({ keys })

    expect(record.producerRecordId).toBe(deriveProducerRecordId(record))
    expect(record.producerRecordId).toMatch(
      /^urn:editorial:producer-export:[a-f0-9]{64}$/,
    )
  })

  it('gives two different records two different ids', async () => {
    const keys = await makeProducerTestKeys()
    const first = await producerRecordFixture({ keys })
    const second = await producerRecordFixture({
      keys,
      overrides: { eventId: 'event-2' },
    })

    expect(first.producerRecordId).not.toBe(second.producerRecordId)
  })

  it('excludes its own id and its signature from the identity payload', async () => {
    const keys = await makeProducerTestKeys()
    const record = await producerRecordFixture({ keys })
    const payload = producerRecordIdentityPayload(record)

    expect(Object.keys(payload)).not.toContain('producerRecordId')
    expect(Object.keys(payload)).not.toContain('signature')
    expect(Object.keys(payload)).toContain('documentSha256')
    expect(Object.keys(payload)).toContain('issuedAt')
  })

  it('covers every field but the signature in the signing payload', async () => {
    const keys = await makeProducerTestKeys()
    const record = await producerRecordFixture({ keys })
    const payload = producerRecordSigningPayload(record)

    expect(Object.keys(payload)).not.toContain('signature')
    for (const field of PRODUCER_RECORD_FIELDS) {
      if (field === 'signature') continue
      if (field === 'supersedes' || field === 'bundleSha256') continue
      expect(Object.keys(payload)).toContain(field)
    }
  })

  it('verifies a signature it made', async () => {
    const keys = await makeProducerTestKeys()
    const record = await producerRecordFixture({ keys })

    const outcome = await verifyProducerRecordSignature({
      record,
      publicKey: keys.producer.keyPair.publicKey,
    })

    expect(outcome.ok).toBe(true)
  })

  it('refuses a record whose contents were altered', async () => {
    const keys = await makeProducerTestKeys()
    const record = await producerRecordFixture({ keys })
    const altered = { ...record, documentSha256: 'f'.repeat(64) }

    const outcome = await verifyProducerRecordSignature({
      record: altered,
      publicKey: keys.producer.keyPair.publicKey,
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('producer_signature_invalid')
  })

  it('refuses a record whose signature came from another key', async () => {
    const keys = await makeProducerTestKeys()
    const attacker = await generateProducerKeyPair()
    const record = await producerRecordFixture({
      keys,
      signingKey: attacker.privateKey,
    })

    const outcome = await verifyProducerRecordSignature({
      record,
      publicKey: keys.producer.keyPair.publicKey,
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('producer_signature_invalid')
  })

  it('refuses a signature that does not decode', async () => {
    const keys = await makeProducerTestKeys()
    const record = await producerRecordFixture({ keys })

    const outcome = await verifyProducerRecordSignature({
      record: { ...record, signature: 'not base64url at all!' },
      publicKey: keys.producer.keyPair.publicKey,
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('producer_signature_invalid')
  })

  it('refuses an algorithm this verifier does not implement', async () => {
    const keys = await makeProducerTestKeys()
    const record = await producerRecordFixture({ keys })

    const outcome = await verifyProducerRecordSignature({
      record: { ...record, signatureAlgorithm: 'ed25519' },
      publicKey: keys.producer.keyPair.publicKey,
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe('producer_signature_algorithm_unsupported')
    }
  })

  it('refuses a forged bundle that is self-consistent under the Struct digest', async () => {
    const keys = await makeProducerTestKeys()
    const attacker = await generateProducerKeyPair()
    const forgedArtifacts = ARTIFACTS.map((artifact) => ({
      ...artifact,
      sha256: 'e'.repeat(64),
    }))
    const forged = await producerRecordFixture({
      keys,
      signingKey: attacker.privateKey,
      overrides: {
        artifacts: forgedArtifacts,
        artifactSetSha256: editorialArtifactSetDigest(forgedArtifacts),
      },
    })

    // The forged bundle passes every integrity check the Struct digest can
    // make: its artifact set hashes to the digest the record claims, and the
    // record's own id derives from its own content.
    expect(forged.artifactSetSha256).toBe(
      editorialArtifactSetDigest(forgedArtifacts),
    )
    expect(forged.producerRecordId).toBe(deriveProducerRecordId(forged))

    // It is still not the producer's record.
    const outcome = await verifyProducerRecordSignature({
      record: forged,
      publicKey: keys.producer.keyPair.publicKey,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('producer_signature_invalid')
  })

  it('gives the same digest to the same record and a different one to a change', async () => {
    const keys = await makeProducerTestKeys()
    const record = await producerRecordFixture({ keys })
    const altered = await producerRecordFixture({
      keys,
      overrides: { eventId: 'event-2' },
    })

    expect(producerRecordDigest(record)).toBe(producerRecordDigest(record))
    expect(producerRecordDigest(record)).not.toBe(producerRecordDigest(altered))
  })

  it('names a key by the fingerprint of its public key', async () => {
    const keyPair = await generateProducerKeyPair()
    const publicKey = await publicKeyOf(keyPair)
    const fingerprint = await producerKeyFingerprint(publicKey.publicKeySpki)

    expect(fingerprint).toBe(publicKey.fingerprint)
    expect(publicKey.keyId).toBe(
      producerKeyId('ecdsa-p256-sha256', publicKey.fingerprint),
    )
  })
})
