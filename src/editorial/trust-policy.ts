/**
 * The consumer side of the producer trust contract: the authenticated policy
 * epoch, the key registry it carries, the monotonic trust state, and the
 * verification that refuses everything it must.
 *
 * ## What the consumer is owed
 *
 * A consumer that holds a **release record** proves nothing: the release
 * record is the app's own ledger entry, and anybody can write one. What a
 * consumer authenticates is the **producer record** — the signed export of a
 * release — and this module is what it authenticates it against.
 *
 * The chain is:
 *
 * ```
 * trust root (app-owned, configured out of band)
 *   └── signs the policy epoch document
 *         └── carries the key registry: the producer keys, their epochs,
 *             their validity windows, their revocations and compromises
 *               └── one of those keys signs the producer record
 *                     └── the record binds the revision, the digests, the
 *                         package, the schema versions, the artifacts, the
 *                         target, the event, the issue time and the status
 * ```
 *
 * Every link is verified before the next one is used. A consumer that cannot
 * verify a link **fails closed**: it never treats an unverified record as
 * valid, and it never falls back to the last record it did accept.
 *
 * ## The epoch rule
 *
 * The **policy epoch** is the monotonic unit, and it is the epoch of the
 * *authority* (the key set), not a counter of the records.
 *
 * - A policy at a **lower** epoch than the one the consumer has accepted is a
 *   **rollback** and is refused (`trust_policy_rollback`). This is the
 *   anti-rollback property: an attacker cannot serve an old policy, with an
 *   old key set, to resurrect a key that has since been revoked.
 * - A policy at the **same** epoch is the same policy. It neither advances
 *   the state nor is a refusal.
 * - A policy at a **higher** epoch advances the state, and the advance is a
 *   **compare-and-advance**: it happens only if the state has not moved since
 *   it was read. Two consumers that race lose one of the two advances, and
 *   the loser refuses rather than merges.
 *
 * The **record's** `policyEpoch` is the epoch of the key that signed it. It
 * must equal that key's epoch and must not exceed the policy's epoch. It is
 * *not* compared with the accepted epoch, because a key that is superseded
 * stays usable for the records it issued before its `notAfter` (the rotation
 * overlap), and those records carry the old epoch. Whether an old key may
 * still validate a record is decided by the **current** policy's registry
 * entry — its validity window, its revocation and its compromise — not by an
 * epoch counter.
 *
 * ## The replay ledger
 *
 * The epoch cannot tell a distinct record from a replayed one, so the
 * consumer keeps the pair (`eventId`, the record's own digest) of every
 * record it has accepted. A pair that is already in the ledger is a replay
 * (`producer_record_replayed`); an `eventId` that is already in the ledger
 * with a *different* digest is an event id presented twice with different
 * content (`producer_event_id_reused`). Both are refusals.
 *
 * This is the answer to the question E-05a's design record leaves open in
 * §9.3: the ledger, not the epoch, is what tells a superseding record from a
 * replay, and the epoch is what detects a rollback of the authority.
 *
 * The ledger only has to hold the pairs inside the freshness window: a
 * record older than the freshness bound is refused before the ledger is
 * consulted, so it can never be replayed whatever the ledger says.
 *
 * ## The compromised key
 *
 * A revoked key is refused **from the revocation's effective time onwards**:
 * what it signed before the revocation is still good, because the revocation
 * is a decision about the future.
 *
 * A **compromised** key is refused for its **entire lifetime**. The records
 * it signed before the compromise are exactly the records an attacker could
 * have made, so there is no point in the key's history at which its output
 * can be believed. The one exception is evidence: a record that carries a
 * **pre-compromise inclusion proof** — a trusted timestamp or a transparency
 * log inclusion — that places its issue time *before* the compromise is
 * accepted, because the proof is evidence that the record existed before
 * the key was compromised. Without such a proof the key is treated as
 * revoked for its whole life.
 *
 * ## Failing closed
 *
 * The rules above are all refusals, and the refusal is always a specific
 * reason:
 *
 * - a policy that is missing, malformed, unauthenticated, expired or rolled
 *   back is refused;
 * - a trust state that cannot be read (offline, unavailable) is refused, and
 *   the answer is never "assume valid";
 * - a compare-and-advance that lost the race is refused;
 * - a record whose trust status cannot be established for any reason is
 *   refused, and the reason says which one.
 */
import { z } from 'zod'

import { editorialArtifactSetDigest } from './ids'
import {
  deriveProducerRecordId,
  importProducerPublicKey,
  producerCanonicalPayload,
  producerKeyFingerprint,
  producerKeyId,
  producerKeyMaterialSchema,
  producerPublicKeySchema,
  producerRecordDigest,
  signDetached,
  verifyDetached,
  verifyProducerRecordSignature,
} from './producer-record'
import { sha256Schema, timestampSchema } from './records'
import {
  EDITORIAL_SIGNATURE_ALGORITHMS,
  producerRecordSchema,
  type ProducerRecord,
} from './trust'

/** The record type of an authenticated policy epoch document. */
export const EDITORIAL_TRUST_POLICY_RECORD_TYPE =
  'erniesg.editorial.trust-policy.v1' as const

/** The domain tag a policy epoch document's signature is computed under. */
export const EDITORIAL_TRUST_POLICY_SIGNATURE_DERIVATION =
  'erniesg.editorial.trust-policy.v1' as const

/** The domain tag an inclusion proof's signature is computed under. */
export const EDITORIAL_INCLUSION_PROOF_DERIVATION =
  'erniesg.editorial.inclusion-proof.v1' as const

/* ------------------------------------------------------------------ policy */

/**
 * The bounds a policy epoch document carries.
 *
 * They are the policy's own bounds, so the authority can tighten them
 * without a new release of the consumer, and they are inside the policy's
 * signature, so they cannot be widened by an attacker.
 */
export const producerTrustBoundsSchema = z
  .object({
    /** How old a producer record may be. */
    maxRecordAgeSeconds: z.number().int().positive().max(604_800),
    /** The longest validity window a producer record may claim. */
    maxValiditySeconds: z.number().int().positive().max(604_800),
    /** How far in the future a record or a policy may claim to be from. */
    maxFutureSkewSeconds: z.number().int().nonnegative().max(3_600),
    /** The longest overlap a key rotation may have. */
    maxRotationOverlapSeconds: z.number().int().nonnegative().max(604_800),
  })
  .strict()
export type ProducerTrustBounds = z.infer<typeof producerTrustBoundsSchema>

/**
 * The authenticated policy epoch document.
 *
 * It is signed by the trust root. It carries the key registry, the bounds and
 * the epoch, and the consumer verifies all three before it uses any of them.
 */
export const producerTrustPolicySchema = z
  .object({
    recordType: z.literal(EDITORIAL_TRUST_POLICY_RECORD_TYPE),
    version: z.literal('1.0.0'),
    /** The epoch of this authority. It only ever increases. */
    policyEpoch: z.number().int().nonnegative(),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    bounds: producerTrustBoundsSchema,
    /** The producer keys this policy vouches for. */
    keys: z.array(producerKeyMaterialSchema).min(1).max(64),
    signatureAlgorithm: z.enum(EDITORIAL_SIGNATURE_ALGORITHMS),
    /** The trust root's detached signature, base64url. */
    signature: z.string().min(1).max(2048),
  })
  .strict()
export type ProducerTrustPolicy = z.infer<typeof producerTrustPolicySchema>

/**
 * The trust root: the app-owned key that signs the policy epoch documents.
 *
 * It is **configured out of band** (the same way the margin service's
 * allowlist and the target registry are app-owned configuration), and it is
 * the only thing a consumer trusts a priori. The timestamp authorities are
 * the keys that may vouch for a record's inclusion.
 */
export const producerTrustRootSchema = z
  .object({
    version: z.literal('1.0.0'),
    key: producerPublicKeySchema,
    timestampAuthorities: z.array(producerPublicKeySchema).max(16),
  })
  .strict()
export type ProducerTrustRoot = z.infer<typeof producerTrustRootSchema>

/* --------------------------------------------------------- inclusion proof */

/**
 * Evidence that a record existed before its key was compromised.
 *
 * Either a trusted timestamp authority or a transparency log vouches for the
 * record's digest at `observedAt`. The proof is signed by the authority, and
 * it names the record's digest, so it cannot be carried over to another
 * record.
 */
export const producerInclusionProofSchema = z
  .object({
    kind: z.enum(['trusted-timestamp', 'transparency-log']),
    /** The authority that vouches for the inclusion. */
    authorityKeyId: z.string().min(1).max(128),
    /** The digest of the record the authority observed. */
    recordDigest: sha256Schema,
    /** When the authority observed the record. */
    observedAt: timestampSchema,
    signatureAlgorithm: z.enum(EDITORIAL_SIGNATURE_ALGORITHMS),
    /** The authority's detached signature, base64url. */
    signature: z.string().min(1).max(2048),
  })
  .strict()
export type ProducerInclusionProof = z.infer<typeof producerInclusionProofSchema>

/* ------------------------------------------------------------------- state */

/** One accepted event: the event id and the digest of the record it carried. */
export type AcceptedProducerEvent = {
  eventId: string
  digest: string
}

/**
 * The consumer's trust state.
 *
 * `highestAcceptedEpoch` is the highest **policy** epoch the consumer has
 * accepted; `-1` means it has accepted none. It never goes down.
 */
export type ProducerTrustState = {
  highestAcceptedEpoch: number
  /** The (event id, digest) pairs the consumer has accepted. */
  acceptedEvents: readonly AcceptedProducerEvent[]
}

/** The state of a consumer that has accepted nothing yet. */
export const EMPTY_PRODUCER_TRUST_STATE: ProducerTrustState = {
  highestAcceptedEpoch: -1,
  acceptedEvents: [],
}

/**
 * The durable trust state, with a linearizable compare-and-advance.
 *
 * `compareAndAdvance` must apply the change **only** when the state is still
 * the one the caller read. A store that cannot do that atomically cannot
 * detect a rollback, and a rollback that two consumers both accept is a
 * rollback that is not detected.
 */
export interface ProducerTrustStore {
  /** The current state. It throws when the state cannot be established. */
  read(): Promise<ProducerTrustState>
  /**
   * Advance the state from `expected` to `next`, or refuse.
   *
   * It returns `false` when the state moved since it was read: somebody
   * else got there first, and the caller must re-read and re-decide.
   */
  compareAndAdvance(
    expected: ProducerTrustState,
    next: ProducerTrustState,
  ): Promise<boolean>
}

function sameTrustState(
  left: ProducerTrustState,
  right: ProducerTrustState,
): boolean {
  if (left.highestAcceptedEpoch !== right.highestAcceptedEpoch) return false
  if (left.acceptedEvents.length !== right.acceptedEvents.length) return false
  return left.acceptedEvents.every((event, index) => {
    const other = right.acceptedEvents[index]
    if (other === undefined) return false
    return other.eventId === event.eventId && other.digest === event.digest
  })
}

/**
 * An in-memory trust store with the compare-and-advance semantics.
 *
 * It is the reference implementation of the store's contract, and the tests
 * use it. The durable store (E05c) must implement the same contract with a
 * conditional update, the way the margin service's CAS does.
 */
export function createInMemoryProducerTrustStore(
  initial: ProducerTrustState = EMPTY_PRODUCER_TRUST_STATE,
): ProducerTrustStore {
  let current = initial
  return {
    async read(): Promise<ProducerTrustState> {
      return current
    },
    async compareAndAdvance(
      expected: ProducerTrustState,
      next: ProducerTrustState,
    ): Promise<boolean> {
      if (!sameTrustState(current, expected)) return false
      current = next
      return true
    },
  }
}

/* ------------------------------------------------------------------- rules */

/**
 * Whether a policy epoch may be accepted against the current state.
 *
 * A lower epoch is a rollback and is not acceptable. An equal epoch is the
 * same epoch. A higher epoch is a new authority.
 */
export function producerPolicyEpochIsAcceptable(
  policyEpoch: number,
  state: ProducerTrustState,
): boolean {
  return policyEpoch >= state.highestAcceptedEpoch
}

/**
 * Whether a record's event has been accepted before.
 *
 * `'replayed'` is the same event id with the same digest — the same record,
 * presented twice. `'reused'` is the same event id with a different digest —
 * the same event, claimed twice with different content. Both are refusals;
 * the second is the more alarming one.
 */
export function producerReplayStatus(
  record: ProducerRecord,
  state: ProducerTrustState,
): 'replayed' | 'reused' | null {
  const digest = producerRecordDigest(record)
  for (const accepted of state.acceptedEvents) {
    if (accepted.eventId !== record.eventId) continue
    return accepted.digest === digest ? 'replayed' : 'reused'
  }
  return null
}

/** The state a consumer holds after accepting a record under a policy. */
export function producerNextState(
  state: ProducerTrustState,
  policyEpoch: number,
  record: ProducerRecord,
): ProducerTrustState {
  return {
    highestAcceptedEpoch: Math.max(state.highestAcceptedEpoch, policyEpoch),
    acceptedEvents: [
      ...state.acceptedEvents,
      { eventId: record.eventId, digest: producerRecordDigest(record) },
    ],
  }
}

/* --------------------------------------------------------------- refusals */

/**
 * Every reason a producer record can be refused.
 *
 * A refusal is always one of these. There is no "invalid" and no "error":
 * a caller that gets a refusal knows exactly what to say, and a caller that
 * gets `ok` knows the whole chain was verified.
 */
export const PRODUCER_REFUSAL_REASONS = [
  'producer_record_malformed',
  'producer_record_id_mismatch',
  'producer_signature_algorithm_unsupported',
  'producer_signature_invalid',
  'producer_key_unknown',
  'producer_key_identity_mismatch',
  'producer_key_material_invalid',
  'producer_epoch_mismatch',
  'producer_record_not_fresh',
  'producer_record_superseded',
  'producer_record_revoked',
  'producer_record_replayed',
  'producer_event_id_reused',
  'producer_key_not_usable',
  'producer_key_revoked',
  'producer_key_compromised',
  'producer_artifact_set_mismatch',
  'producer_digest_mismatch',
  'producer_target_mismatch',
  'producer_audience_mismatch',
  'producer_release_mismatch',
  'producer_revision_stale',
  'trust_root_malformed',
  'trust_policy_malformed',
  'trust_policy_unavailable',
  'trust_policy_unauthenticated',
  'trust_policy_expired',
  'trust_policy_not_yet_valid',
  'trust_policy_rollback',
  'trust_policy_rotation_overlap_exceeded',
  'trust_authority_unavailable',
  'trust_state_concurrent_modification',
] as const
export type ProducerRefusalReason = (typeof PRODUCER_REFUSAL_REASONS)[number]

/* ----------------------------------------------------------------- policy */

/** The payload a policy epoch document's signature covers. */
export function producerTrustPolicyPayload(
  policy: object,
): Record<string, unknown> {
  return producerCanonicalPayload(policy, ['signature'])
}

/** Sign a policy epoch document with the trust root's key. */
export async function signProducerTrustPolicy(input: {
  policy: ProducerTrustPolicy
  privateKey: CryptoKey
}): Promise<ProducerTrustPolicy> {
  const signature = await signDetached({
    domain: EDITORIAL_TRUST_POLICY_SIGNATURE_DERIVATION,
    payload: producerTrustPolicyPayload(input.policy),
    privateKey: input.privateKey,
  })
  return { ...input.policy, signature }
}

/**
 * Verify a policy epoch document against the trust root.
 *
 * A policy that does not verify is not an authority, and the consumer has
 * none: the refusal is `trust_policy_unauthenticated`, whatever the cause.
 */
export async function verifyProducerTrustPolicySignature(input: {
  policy: ProducerTrustPolicy
  root: ProducerTrustRoot
}): Promise<{ ok: true } | { ok: false; reason: 'trust_policy_unauthenticated' }> {
  if (input.policy.signatureAlgorithm !== input.root.key.algorithm) {
    return { ok: false, reason: 'trust_policy_unauthenticated' }
  }
  const publicKey = await importProducerPublicKey(input.root.key)
  if (publicKey === null) {
    return { ok: false, reason: 'trust_policy_unauthenticated' }
  }
  const verified = await verifyDetached({
    domain: EDITORIAL_TRUST_POLICY_SIGNATURE_DERIVATION,
    payload: producerTrustPolicyPayload(input.policy),
    publicKey,
    signature: input.policy.signature,
  })
  if (!verified) {
    return { ok: false, reason: 'trust_policy_unauthenticated' }
  }
  return { ok: true }
}

/* --------------------------------------------------------- inclusion proof */

/** The payload an inclusion proof's signature covers. */
export function producerInclusionProofPayload(
  proof: object,
): Record<string, unknown> {
  return producerCanonicalPayload(proof, ['signature'])
}

/** Sign an inclusion proof with a timestamp authority's key. */
export async function signProducerInclusionProof(input: {
  proof: ProducerInclusionProof
  privateKey: CryptoKey
}): Promise<ProducerInclusionProof> {
  const signature = await signDetached({
    domain: EDITORIAL_INCLUSION_PROOF_DERIVATION,
    payload: producerInclusionProofPayload(input.proof),
    privateKey: input.privateKey,
  })
  return { ...input.proof, signature }
}

/**
 * Whether an inclusion proof vouches for a record that was issued before its
 * key was compromised.
 *
 * The proof must be signed by a registered timestamp authority, it must name
 * this record's digest, and the authority must have observed the record
 * strictly before the compromise.
 */
export async function verifyProducerInclusionProof(input: {
  proof: unknown
  record: ProducerRecord
  root: ProducerTrustRoot
  compromisedAt: string
}): Promise<boolean> {
  const proof = producerInclusionProofSchema.safeParse(input.proof)
  if (!proof.success) return false
  const authority = input.root.timestampAuthorities.find(
    (entry) => entry.keyId === proof.data.authorityKeyId,
  )
  if (authority === undefined) return false
  const observed = Date.parse(proof.data.observedAt)
  const compromised = Date.parse(input.compromisedAt)
  if (Number.isNaN(observed) || Number.isNaN(compromised)) return false
  if (observed >= compromised) return false
  if (proof.data.recordDigest !== producerRecordDigest(input.record)) {
    return false
  }
  const publicKey = await importProducerPublicKey(authority)
  if (publicKey === null) return false
  return verifyDetached({
    domain: EDITORIAL_INCLUSION_PROOF_DERIVATION,
    payload: producerInclusionProofPayload(proof.data),
    publicKey,
    signature: proof.data.signature,
  })
}

/* ------------------------------------------------------------ verification */

/**
 * What the consumer expects the record to bind.
 *
 * Every field is optional: a consumer that only resolves one target
 * compares only that target. A field that is present and does not match is a
 * refusal with its own reason.
 */
export type ProducerExpectation = {
  targetId?: string
  audience?: string
  documentSha256?: string
  bundleSha256?: string
  artifactSetSha256?: string
  releaseId?: string
  releaseSha256?: string
  approvedRevisionId?: string
}

/** The outcome of a verification. */
export type ProducerVerification =
  | {
      ok: true
      record: ProducerRecord
      policy: ProducerTrustPolicy
      state: ProducerTrustState
    }
  | { ok: false; reason: ProducerRefusalReason }

function refuse(reason: ProducerRefusalReason): ProducerVerification {
  return { ok: false, reason }
}

/**
 * Whether the policy is current.
 *
 * A policy that is past its expiry is expired; a policy that claims to be
 * from the future is not yet valid; a policy whose own validity window is
 * longer than the bound it carries is malformed.
 */
function policyIsCurrent(
  policy: ProducerTrustPolicy,
  now: Date,
): { ok: true } | { ok: false; reason: ProducerRefusalReason } {
  const issued = Date.parse(policy.issuedAt)
  const expires = Date.parse(policy.expiresAt)
  const current = now.getTime()
  if (Number.isNaN(issued) || Number.isNaN(expires)) {
    return { ok: false, reason: 'trust_policy_malformed' }
  }
  if (expires - issued > policy.bounds.maxValiditySeconds * 1000) {
    return { ok: false, reason: 'trust_policy_malformed' }
  }
  if (issued > current + policy.bounds.maxFutureSkewSeconds * 1000) {
    return { ok: false, reason: 'trust_policy_not_yet_valid' }
  }
  if (expires <= current) {
    return { ok: false, reason: 'trust_policy_expired' }
  }
  return { ok: true }
}

/**
 * Whether the policy's key rotation stays inside the overlap bound.
 *
 * A successor key that takes over more than the bound after its predecessor
 * stopped is a migration, not a rotation, and a migration needs its own
 * epoch. A policy that carries such a pair is refused.
 */
function rotationOverlapsWithin(policy: ProducerTrustPolicy): boolean {
  const keys = [...policy.keys].sort(
    (left, right) => left.policyEpoch - right.policyEpoch,
  )
  for (let index = 1; index < keys.length; index += 1) {
    const previous = keys[index - 1]
    const next = keys[index]
    if (previous === undefined || next === undefined) continue
    if (next.policyEpoch === previous.policyEpoch) continue
    const gap = Date.parse(next.notBefore) - Date.parse(previous.notAfter)
    if (gap > policy.bounds.maxRotationOverlapSeconds * 1000) return false
  }
  return true
}

/**
 * Whether the record is inside its validity window and fresh enough.
 *
 * The bounds are the policy's own. A record that is expired, that is issued
 * too far in the future, that claims a longer validity window than the
 * policy allows, or that is older than the freshness bound is refused.
 */
function recordIsFresh(
  record: ProducerRecord,
  bounds: ProducerTrustBounds,
  now: Date,
): boolean {
  const issued = Date.parse(record.issuedAt)
  const expires = Date.parse(record.expiresAt)
  const current = now.getTime()
  if (Number.isNaN(issued) || Number.isNaN(expires)) return false
  if (issued > current + bounds.maxFutureSkewSeconds * 1000) return false
  if (expires <= current) return false
  if (expires - issued > bounds.maxValiditySeconds * 1000) return false
  if (current - issued > bounds.maxRecordAgeSeconds * 1000) return false
  return true
}

/**
 * Authenticate a producer record and advance the consumer's trust state.
 *
 * The order of the checks is the order a reader cares about: **who is the
 * authority** (the root, the policy, its epoch and its freshness), then
 * **what is the record** (its schema, its id, its key, its epoch), then
 * **is it authentic** (its signature), then **may it be used** (its status,
 * its freshness, its key's usability, the replay ledger), and finally **does
 * it bind what the consumer is resolving** (the target, the digests, the
 * release and the revision).
 *
 * A refusal writes nothing: the trust state is advanced only when the whole
 * chain has been verified.
 */
export async function verifyProducerRecord(input: {
  /** The producer record, as it arrived. */
  record: unknown
  /** The policy epoch document, as it arrived. */
  policy?: unknown
  /** The app-owned trust root. */
  root: unknown
  /** The durable trust state. */
  store: ProducerTrustStore
  /** The consumer's clock. */
  now: Date
  /** What the consumer expects the record to bind. */
  expectation?: ProducerExpectation
  /** The pre-compromise inclusion proof, when there is one. */
  inclusionProof?: unknown
}): Promise<ProducerVerification> {
  const root = producerTrustRootSchema.safeParse(input.root)
  if (!root.success) return refuse('trust_root_malformed')

  if (input.policy === undefined || input.policy === null) {
    return refuse('trust_policy_unavailable')
  }
  const policy = producerTrustPolicySchema.safeParse(input.policy)
  if (!policy.success) return refuse('trust_policy_malformed')

  let state: ProducerTrustState
  try {
    state = await input.store.read()
  } catch {
    return refuse('trust_authority_unavailable')
  }

  const policySignature = await verifyProducerTrustPolicySignature({
    policy: policy.data,
    root: root.data,
  })
  if (!policySignature.ok) return refuse(policySignature.reason)

  if (!producerPolicyEpochIsAcceptable(policy.data.policyEpoch, state)) {
    return refuse('trust_policy_rollback')
  }

  const current = policyIsCurrent(policy.data, input.now)
  if (!current.ok) return refuse(current.reason)

  if (!rotationOverlapsWithin(policy.data)) {
    return refuse('trust_policy_rotation_overlap_exceeded')
  }

  const record = producerRecordSchema.safeParse(input.record)
  if (!record.success) return refuse('producer_record_malformed')

  if (record.data.producerRecordId !== deriveProducerRecordId(record.data)) {
    return refuse('producer_record_id_mismatch')
  }

  const key = policy.data.keys.find(
    (entry) => entry.keyId === record.data.keyId,
  )
  if (key === undefined) return refuse('producer_key_unknown')

  const fingerprint = await producerKeyFingerprint(key.publicKeySpki)
  if (fingerprint === null || fingerprint !== key.fingerprint) {
    return refuse('producer_key_material_invalid')
  }
  if (key.keyId !== producerKeyId(key.algorithm, key.fingerprint)) {
    return refuse('producer_key_identity_mismatch')
  }

  if (record.data.policyEpoch !== key.policyEpoch) {
    return refuse('producer_epoch_mismatch')
  }
  if (record.data.policyEpoch > policy.data.policyEpoch) {
    return refuse('producer_epoch_mismatch')
  }

  if (key.algorithm !== record.data.signatureAlgorithm) {
    return refuse('producer_signature_algorithm_unsupported')
  }

  const publicKey = await importProducerPublicKey(key)
  if (publicKey === null) return refuse('producer_key_material_invalid')

  const signature = await verifyProducerRecordSignature({
    record: record.data,
    publicKey,
  })
  if (!signature.ok) return refuse(signature.reason)

  if (record.data.status === 'superseded') {
    return refuse('producer_record_superseded')
  }
  if (record.data.status === 'revoked') {
    return refuse('producer_record_revoked')
  }

  if (!recordIsFresh(record.data, policy.data.bounds, input.now)) {
    return refuse('producer_record_not_fresh')
  }

  const issued = Date.parse(record.data.issuedAt)
  if (
    issued < Date.parse(key.notBefore) ||
    issued > Date.parse(key.notAfter)
  ) {
    return refuse('producer_key_not_usable')
  }
  if (
    key.revokedAt !== undefined &&
    issued >= Date.parse(key.revokedAt)
  ) {
    return refuse('producer_key_revoked')
  }
  if (key.compromisedAt !== undefined) {
    const proof = await verifyProducerInclusionProof({
      proof: input.inclusionProof,
      record: record.data,
      root: root.data,
      compromisedAt: key.compromisedAt,
    })
    if (!proof) return refuse('producer_key_compromised')
  }

  const replay = producerReplayStatus(record.data, state)
  if (replay === 'replayed') return refuse('producer_record_replayed')
  if (replay === 'reused') return refuse('producer_event_id_reused')

  if (
    editorialArtifactSetDigest(record.data.artifacts) !==
    record.data.artifactSetSha256
  ) {
    return refuse('producer_artifact_set_mismatch')
  }

  const expectation = input.expectation
  if (expectation !== undefined) {
    if (
      expectation.targetId !== undefined &&
      record.data.target.id !== expectation.targetId
    ) {
      return refuse('producer_target_mismatch')
    }
    if (
      expectation.audience !== undefined &&
      record.data.target.audience !== expectation.audience
    ) {
      return refuse('producer_audience_mismatch')
    }
    if (
      expectation.documentSha256 !== undefined &&
      record.data.documentSha256 !== expectation.documentSha256
    ) {
      return refuse('producer_digest_mismatch')
    }
    if (
      expectation.bundleSha256 !== undefined &&
      record.data.bundleSha256 !== expectation.bundleSha256
    ) {
      return refuse('producer_digest_mismatch')
    }
    if (
      expectation.artifactSetSha256 !== undefined &&
      record.data.artifactSetSha256 !== expectation.artifactSetSha256
    ) {
      return refuse('producer_digest_mismatch')
    }
    if (
      expectation.releaseId !== undefined &&
      record.data.releaseId !== expectation.releaseId
    ) {
      return refuse('producer_release_mismatch')
    }
    if (
      expectation.releaseSha256 !== undefined &&
      record.data.releaseSha256 !== expectation.releaseSha256
    ) {
      return refuse('producer_digest_mismatch')
    }
    if (
      expectation.approvedRevisionId !== undefined &&
      record.data.approvedRevisionId !== expectation.approvedRevisionId
    ) {
      return refuse('producer_revision_stale')
    }
  }

  const next = producerNextState(state, policy.data.policyEpoch, record.data)
  const advanced = await input.store.compareAndAdvance(state, next)
  if (!advanced) return refuse('trust_state_concurrent_modification')

  return {
    ok: true,
    record: record.data,
    policy: policy.data,
    state: next,
  }
}
