import { describe, expect, it } from 'vitest'

import { editorialArtifactSetDigest } from './ids'
import {
  ARTIFACTS,
  BUNDLE_SHA256,
  DOCUMENT_SHA256,
  OTHER_DOCUMENT_SHA256,
  revisionFixture,
} from './fixtures'
import {
  generateProducerKeyPair,
  inclusionProofFixture,
  makeProducerTestKeys,
  producerKeyMaterial,
  producerRecordFixture,
  trustPolicyFixture,
  trustRootFixture,
  NOW,
  type ProducerTestKeys,
} from './producer-fixtures'
import { producerRecordDigest } from './producer-record'
import {
  EMPTY_PRODUCER_TRUST_STATE,
  createInMemoryProducerTrustStore,
  producerPolicyEpochIsAcceptable,
  producerReplayStatus,
  verifyProducerRecord,
  type ProducerExpectation,
  type ProducerRefusalReason,
  type ProducerTrustLedgerWindow,
  type ProducerTrustStore,
  type ProducerVerification,
} from './trust-policy'

const OTHER_REVISION_ID = `urn:editorial:revision:${'c'.repeat(64)}`

/**
 * The window the ledger is read inside.
 *
 * The in-memory store keeps every pair, so the window does not change what
 * it returns; the durable store bounds its read by it.
 */
const LEDGER_WINDOW = { since: '1970-01-01T00:00:00.000Z' }

/** A store whose state cannot be read: the consumer is offline. */
function unavailableStore(): ProducerTrustStore {
  return {
    async read() {
      throw new Error('the trust state cannot be read')
    },
    async compareAndAdvance() {
      return false
    },
  }
}

/** A store whose compare-and-advance always loses the race. */
function racingStore(state: ProducerTrustStore): ProducerTrustStore {
  return {
    async read(window: ProducerTrustLedgerWindow) {
      return state.read(window)
    },
    async compareAndAdvance() {
      return false
    },
  }
}

async function verify(input: {
  keys: ProducerTestKeys
  record: unknown
  policy?: unknown
  root?: unknown
  store?: ProducerTrustStore
  now?: Date
  expectation?: ProducerExpectation
  inclusionProof?: unknown
  policyOverrides?: Parameters<typeof trustPolicyFixture>[0]['overrides']
  keyOverrides?: Parameters<typeof trustPolicyFixture>[0]['keyOverrides']
}): Promise<ProducerVerification> {
  const policy =
    input.policy ??
    (await trustPolicyFixture({
      keys: input.keys,
      overrides: input.policyOverrides,
      keyOverrides: input.keyOverrides,
    }))
  return verifyProducerRecord({
    record: input.record,
    policy,
    root: input.root ?? (await trustRootFixture(input.keys)),
    store: input.store ?? createInMemoryProducerTrustStore(),
    now: input.now ?? NOW,
    ...(input.expectation === undefined
      ? {}
      : { expectation: input.expectation }),
    ...(input.inclusionProof === undefined
      ? {}
      : { inclusionProof: input.inclusionProof }),
  })
}

/** The reason a verification refused, or a failure of the test itself. */
function refusalOf(outcome: ProducerVerification): ProducerRefusalReason {
  if (outcome.ok) {
    throw new Error('the verification accepted a record it must refuse')
  }
  return outcome.reason
}

describe('the producer trust contract', () => {
  describe('the accept path', () => {
    it('accepts a producer record the policy vouches for', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })

      const outcome = await verify({ keys, record })

      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.record.eventId).toBe('event-1')
        expect(outcome.policy.policyEpoch).toBe(9)
      }
    })

    it('advances the epoch and keeps the replay ledger', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const store = createInMemoryProducerTrustStore()

      const outcome = await verify({ keys, record, store })

      expect(outcome.ok).toBe(true)
      const state = await store.read(LEDGER_WINDOW)
      expect(state.highestAcceptedEpoch).toBe(9)
      expect(state.acceptedEvents).toHaveLength(1)
      expect(state.acceptedEvents[0]?.eventId).toBe('event-1')
      expect(state.acceptedEvents[0]?.digest).toBe(producerRecordDigest(record))
    })

    it('refuses a policy that rolls the epoch back', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const store = createInMemoryProducerTrustStore({
        highestAcceptedEpoch: 12,
        acceptedEventCount: 0,
        acceptedEvents: [],
      })

      const outcome = await verify({ keys, record, store })

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toBe('trust_policy_rollback')
    })

    it('accepts a second, distinct record at the same epoch', async () => {
      const keys = await makeProducerTestKeys()
      const first = await producerRecordFixture({ keys })
      const second = await producerRecordFixture({
        keys,
        overrides: { eventId: 'event-2' },
      })
      const store = createInMemoryProducerTrustStore()

      const firstOutcome = await verify({ keys, record: first, store })
      const secondOutcome = await verify({ keys, record: second, store })

      expect(firstOutcome.ok).toBe(true)
      expect(secondOutcome.ok).toBe(true)
    })

    it('accepts a record from a superseded key that it issued before its notAfter', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({
        keys,
        overrides: { policyEpoch: 5 },
      })
      const predecessor = producerKeyMaterial(keys, {
        policyEpoch: 5,
        notBefore: '2026-09-01T00:00:00.000Z',
        notAfter: '2026-10-20T12:00:00.000Z',
      })
      const successor = producerKeyMaterial(keys, { policyEpoch: 7 })

      const outcome = await verify({
        keys,
        record,
        policyOverrides: { keys: [predecessor, successor] },
      })

      expect(outcome.ok).toBe(true)
    })

    it('accepts a record a revoked key issued before its revocation', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const revoked = producerKeyMaterial(keys, {
        revokedAt: '2026-10-20T10:30:00.000Z',
      })

      const outcome = await verify({ keys, record, keyOverrides: revoked })

      expect(outcome.ok).toBe(true)
    })

    it('accepts a compromised key record that carries a pre-compromise inclusion proof', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const compromised = producerKeyMaterial(keys, {
        compromisedAt: '2026-10-20T10:30:00.000Z',
      })
      const proof = await inclusionProofFixture({
        keys,
        record,
        observedAt: '2026-10-20T09:30:00.000Z',
      })

      const outcome = await verify({
        keys,
        record,
        keyOverrides: compromised,
        inclusionProof: proof,
      })

      expect(outcome.ok).toBe(true)
    })

    it('treats an epoch at or below the accepted one as a rollback', () => {
      const at = (epoch: number) => ({
        highestAcceptedEpoch: epoch,
        acceptedEventCount: 0,
        acceptedEvents: [],
      })
      expect(producerPolicyEpochIsAcceptable(8, at(9))).toBe(false)
      expect(producerPolicyEpochIsAcceptable(9, at(9))).toBe(true)
      expect(producerPolicyEpochIsAcceptable(10, at(9))).toBe(true)
      expect(
        producerPolicyEpochIsAcceptable(0, EMPTY_PRODUCER_TRUST_STATE),
      ).toBe(true)
    })
  })

  describe('the negative matrix', () => {
    it('refuses a forged bundle that passes every Struct integrity check', async () => {
      const keys = await makeProducerTestKeys()
      const attacker = await generateProducerKeyPair()
      const forgedArtifacts = ARTIFACTS.map((artifact) => ({
        ...artifact,
        sha256: 'd'.repeat(64),
      }))
      const forged = await producerRecordFixture({
        keys,
        signingKey: attacker.privateKey,
        overrides: {
          artifacts: forgedArtifacts,
          artifactSetSha256: editorialArtifactSetDigest(forgedArtifacts),
        },
      })

      // The bundle is self-consistent: the Struct digest of the artifacts is
      // the digest the record claims.
      expect(forged.artifactSetSha256).toBe(
        editorialArtifactSetDigest(forgedArtifacts),
      )

      const outcome = await verify({ keys, record: forged })

      expect(refusalOf(outcome)).toBe('producer_signature_invalid')
    })

    it('refuses a record whose digests do not match the bundle it claims', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({
        keys,
        overrides: { documentSha256: OTHER_DOCUMENT_SHA256 },
      })

      const outcome = await verify({
        keys,
        record,
        expectation: { documentSha256: DOCUMENT_SHA256 },
      })

      expect(refusalOf(outcome)).toBe('producer_digest_mismatch')
    })

    it('refuses a record that was issued against a superseded revision', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })

      const outcome = await verify({
        keys,
        record,
        expectation: { approvedRevisionId: OTHER_REVISION_ID },
      })

      expect(refusalOf(outcome)).toBe('producer_revision_stale')
    })

    it('refuses a record whose release is no longer current', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({
        keys,
        overrides: { status: 'superseded' },
      })

      const outcome = await verify({ keys, record })

      expect(refusalOf(outcome)).toBe('producer_record_superseded')
    })

    it('refuses a record that was presented twice', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const store = createInMemoryProducerTrustStore()

      const first = await verify({ keys, record, store })
      const second = await verify({ keys, record, store })

      expect(first.ok).toBe(true)
      expect(refusalOf(second)).toBe('producer_record_replayed')
    })

    it('refuses an event id that was presented with different content', async () => {
      const keys = await makeProducerTestKeys()
      const first = await producerRecordFixture({ keys })
      const second = await producerRecordFixture({
        keys,
        overrides: { documentSha256: OTHER_DOCUMENT_SHA256 },
      })
      const store = createInMemoryProducerTrustStore()

      const firstOutcome = await verify({ keys, record: first, store })
      const secondOutcome = await verify({ keys, record: second, store })

      expect(firstOutcome.ok).toBe(true)
      expect(refusalOf(secondOutcome)).toBe('producer_event_id_reused')
    })

    it('refuses a record for the wrong audience', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })

      const outcome = await verify({
        keys,
        record,
        expectation: { audience: 'members' },
      })

      expect(refusalOf(outcome)).toBe('producer_audience_mismatch')
    })

    it('refuses a record for the wrong target', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })

      const outcome = await verify({
        keys,
        record,
        expectation: { targetId: 'ernie-sg-staging' },
      })

      expect(refusalOf(outcome)).toBe('producer_target_mismatch')
    })

    it('refuses a record a revoked key issued after its revocation', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const revoked = producerKeyMaterial(keys, {
        revokedAt: '2026-10-20T09:30:00.000Z',
      })

      const outcome = await verify({ keys, record, keyOverrides: revoked })

      expect(refusalOf(outcome)).toBe('producer_key_revoked')
    })

    it('refuses a record whose own digests do not match its contents', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({
        keys,
        overrides: { artifactSetSha256: 'a'.repeat(64) },
      })

      const outcome = await verify({ keys, record })

      expect(refusalOf(outcome)).toBe('producer_artifact_set_mismatch')
    })

    it('refuses a policy that rolls the epoch back', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const store = createInMemoryProducerTrustStore()

      const accepted = await verify({ keys, record, store })
      const rolled = await verify({
        keys,
        record,
        store,
        policyOverrides: { policyEpoch: 4 },
      })

      expect(accepted.ok).toBe(true)
      expect(refusalOf(rolled)).toBe('trust_policy_rollback')
    })

    it('refuses a policy that has expired', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })

      const outcome = await verify({
        keys,
        record,
        policyOverrides: {
          issuedAt: '2026-10-10T09:00:00.000Z',
          expiresAt: '2026-10-11T09:00:00.000Z',
        },
      })

      expect(refusalOf(outcome)).toBe('trust_policy_expired')
    })

    it('refuses a record whose trust status cannot be established', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })

      const outcome = await verify({
        keys,
        record,
        store: unavailableStore(),
      })

      expect(refusalOf(outcome)).toBe('trust_authority_unavailable')
    })

    it('refuses a record that is older than the freshness bound', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({
        keys,
        overrides: {
          issuedAt: '2026-10-18T10:00:00.000Z',
          expiresAt: '2026-10-19T10:00:00.000Z',
        },
      })

      const outcome = await verify({ keys, record })

      expect(refusalOf(outcome)).toBe('producer_record_not_fresh')
    })

    it('never falls back to a stale record when the authority is unavailable', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({
        keys,
        overrides: {
          issuedAt: '2026-10-18T10:00:00.000Z',
          expiresAt: '2026-10-19T10:00:00.000Z',
        },
      })

      const outcome = await verify({
        keys,
        record,
        store: unavailableStore(),
      })

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.reason).toBe('trust_authority_unavailable')
      }
    })

    it('refuses a record that was backdated after its key was compromised', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const compromised = producerKeyMaterial(keys, {
        compromisedAt: '2026-10-20T10:30:00.000Z',
      })

      const outcome = await verify({ keys, record, keyOverrides: compromised })

      expect(refusalOf(outcome)).toBe('producer_key_compromised')
    })

    it('refuses a backdated record whose inclusion proof came after the compromise', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const compromised = producerKeyMaterial(keys, {
        compromisedAt: '2026-10-20T10:30:00.000Z',
      })
      const proof = await inclusionProofFixture({
        keys,
        record,
        observedAt: '2026-10-20T11:00:00.000Z',
      })

      const outcome = await verify({
        keys,
        record,
        keyOverrides: compromised,
        inclusionProof: proof,
      })

      expect(refusalOf(outcome)).toBe('producer_key_compromised')
    })
  })

  describe('the epoch floor', () => {
    it('refuses a policy below the epoch floor the trust root carries', async () => {
      const keys = await makeProducerTestKeys()
      // The record the attacker wants accepted: it is signed with the
      // producer key, and it carries the old epoch the key was issued under.
      const record = await producerRecordFixture({
        keys,
        overrides: { policyEpoch: 4 },
      })
      // The authority's current policy: epoch 9, with the producer key
      // revoked from 10:30.
      await trustPolicyFixture({
        keys,
        keyOverrides: { revokedAt: '2026-10-20T10:30:00.000Z' },
      })
      // The attacker's policy: signed by the same genuine trust root, the
      // same producer key, the revocation not yet in force, at the old epoch.
      const stale = await trustPolicyFixture({
        keys,
        overrides: { policyEpoch: 4 },
        keyOverrides: { policyEpoch: 4 },
      })
      // The app has provisioned epoch 9, so the root carries that floor.
      const root = await trustRootFixture(keys, { minPolicyEpoch: 9 })

      // The consumer has accepted nothing yet, so the epoch rule on its own
      // cannot tell the stale policy from the current one.
      const outcome = await verifyProducerRecord({
        record,
        policy: stale,
        root,
        store: createInMemoryProducerTrustStore(),
        now: NOW,
      })

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.reason).toBe('trust_policy_epoch_below_floor')
      }
    })

    it('refuses a stale policy before its key set is consulted', async () => {
      const keys = await makeProducerTestKeys()
      const other = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      // A stale policy whose key set does not carry the record's key at all.
      // The floor is checked before the key lookup, so the reason is the
      // floor and not "the key is unknown".
      const stale = await trustPolicyFixture({
        keys,
        overrides: {
          policyEpoch: 4,
          keys: [producerKeyMaterial(other)],
        },
      })
      const root = await trustRootFixture(keys, { minPolicyEpoch: 9 })

      const outcome = await verifyProducerRecord({
        record,
        policy: stale,
        root,
        store: createInMemoryProducerTrustStore(),
        now: NOW,
      })

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.reason).toBe('trust_policy_epoch_below_floor')
      }
    })

    it('accepts a policy at the epoch floor', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const root = await trustRootFixture(keys, { minPolicyEpoch: 9 })

      const outcome = await verify({ keys, record, root })

      expect(outcome.ok).toBe(true)
    })

    it('refuses a trust root whose floor was lowered without re-signing it', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const policy = await trustPolicyFixture({ keys })
      const root = await trustRootFixture(keys, { minPolicyEpoch: 9 })
      // The floor is lowered, and the root is not re-signed.
      const lowered = { ...root, minPolicyEpoch: 0 }

      const outcome = await verify({ keys, record, policy, root: lowered })

      expect(refusalOf(outcome)).toBe('trust_root_unauthenticated')
    })

    it('refuses a trust root whose own signature does not verify', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const policy = await trustPolicyFixture({ keys })
      const root = await trustRootFixture(keys, { minPolicyEpoch: 9 })

      const outcome = await verify({
        keys,
        record,
        policy,
        root: { ...root, signature: 'not-a-signature' },
      })

      expect(refusalOf(outcome)).toBe('trust_root_unauthenticated')
    })
  })

  describe('the rest of the refusals', () => {
    it('refuses a policy that no authority signed', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const policy = await trustPolicyFixture({ keys })

      // The root is the genuine, signed one; the policy's own signature is
      // not the root's.
      const outcome = await verify({
        keys,
        record,
        root: await trustRootFixture(keys),
        policy: { ...policy, signature: 'not-a-signature' },
      })

      expect(refusalOf(outcome)).toBe('trust_policy_unauthenticated')
    })

    it('refuses when there is no policy at all', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })

      const outcome = await verifyProducerRecord({
        record,
        policy: undefined,
        root: await trustRootFixture(keys),
        store: createInMemoryProducerTrustStore(),
        now: NOW,
      })

      expect(refusalOf(outcome)).toBe('trust_policy_unavailable')
    })

    it('refuses a record that does not satisfy its own schema', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })

      const outcome = await verify({
        keys,
        record: { ...record, policyEpoch: 'seven' },
      })

      expect(refusalOf(outcome)).toBe('producer_record_malformed')
    })

    it('refuses a record whose id was minted by something else', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })

      const outcome = await verify({
        keys,
        record: { ...record, producerRecordId: '0'.repeat(64) },
      })

      expect(refusalOf(outcome)).toBe('producer_record_id_mismatch')
    })

    it('refuses a policy that carries no key at all', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })

      const outcome = await verify({
        keys,
        record,
        policyOverrides: { keys: [] },
      })

      expect(refusalOf(outcome)).toBe('trust_policy_malformed')
    })

    it('refuses a record signed by a key the policy does not carry', async () => {
      const keys = await makeProducerTestKeys()
      const other = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys: other })

      const outcome = await verify({ keys, record })

      expect(refusalOf(outcome)).toBe('producer_key_unknown')
    })

    it('refuses a registry entry whose key id is not its fingerprint', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({
        keys,
        overrides: { keyId: 'producer-key-1' },
      })

      const outcome = await verify({
        keys,
        record,
        keyOverrides: { keyId: 'producer-key-1' },
      })

      expect(refusalOf(outcome)).toBe('producer_key_identity_mismatch')
    })

    it('refuses a record whose key was used outside its validity window', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const expired = producerKeyMaterial(keys, {
        notAfter: '2026-10-20T09:30:00.000Z',
      })

      const outcome = await verify({ keys, record, keyOverrides: expired })

      expect(refusalOf(outcome)).toBe('producer_key_not_usable')
    })

    it('refuses a policy that rotates with too long an overlap', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const predecessor = producerKeyMaterial(keys, {
        policyEpoch: 4,
        notBefore: '2026-09-01T00:00:00.000Z',
        notAfter: '2026-09-20T00:00:00.000Z',
      })

      const outcome = await verify({
        keys,
        record,
        policyOverrides: {
          keys: [predecessor, producerKeyMaterial(keys)],
        },
      })

      expect(refusalOf(outcome)).toBe(
        'trust_policy_rotation_overlap_exceeded',
      )
    })

    it('refuses when the compare-and-advance loses the race', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const store = createInMemoryProducerTrustStore()

      const outcome = await verify({
        keys,
        record,
        store: racingStore(store),
      })

      expect(refusalOf(outcome)).toBe('trust_state_concurrent_modification')
    })

    it('does not advance the trust state when it refuses', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const store = createInMemoryProducerTrustStore()

      const outcome = await verify({
        keys,
        record,
        store,
        expectation: { targetId: 'ernie-sg-staging' },
      })

      expect(refusalOf(outcome)).toBe('producer_target_mismatch')
      const state = await store.read(LEDGER_WINDOW)
      expect(state.highestAcceptedEpoch).toBe(-1)
      expect(state.acceptedEvents).toHaveLength(0)
    })

    it('tells a replay from a distinct record at the same epoch', async () => {
      const keys = await makeProducerTestKeys()
      const record = await producerRecordFixture({ keys })
      const state = {
        highestAcceptedEpoch: 9,
        acceptedEventCount: 1,
        acceptedEvents: [
          {
            eventId: record.eventId,
            digest: producerRecordDigest(record),
            acceptedAt: '2026-10-20T11:00:00.000Z',
          },
        ],
      }

      expect(producerReplayStatus(record, state)).toBe('replayed')
      expect(
        producerReplayStatus(
          { ...record, documentSha256: OTHER_DOCUMENT_SHA256 },
          state,
        ),
      ).toBe('reused')
      expect(
        producerReplayStatus({ ...record, eventId: 'event-2' }, state),
      ).toBeNull()
    })

    it('binds the record to the revision it names', async () => {
      const keys = await makeProducerTestKeys()
      const revision = revisionFixture()
      const record = await producerRecordFixture({ keys })

      expect(record.approvedRevisionId).toBe(revision.id)
      expect(record.contentHash).toBe(revision.contentHash)
      expect(record.bundleSha256).toBe(BUNDLE_SHA256)
    })
  })
})
