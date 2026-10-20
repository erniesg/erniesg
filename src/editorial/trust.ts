/**
 * The trust contract for the authenticated producer export.
 *
 * This module states the *contract*; it performs no cryptography. Signature
 * verification, the key registry and the online authority are the follow-up
 * job's work (E05b), and this file is the fixed shape it builds against.
 *
 * The split is deliberate and is the reason the release record is not the
 * authenticated artifact:
 *
 *  - the **release record** (`records.ts`) is the app's own durable ledger
 *    entry. It says what was published and is written by the writer.
 *  - the **producer record** (here) is the *export* of a release, signed by a
 *    producer key. It is the artifact a consumer authenticates before it
 *    resolves anything, and it carries everything a consumer needs without
 *    having the release itself.
 *
 * The rules a consumer must enforce, all of them fail-closed:
 *
 *  - **Monotonic epochs.** `policyEpoch` is a non-negative integer that
 *    only ever increases. A consumer keeps the highest epoch it has accepted
 *    and refuses anything at or below it. A record that replays an old epoch
 *    is a rollback and is refused, not merged. The epoch is the epoch of the
 *    *key's authority*, so the rule admits exactly one producer record per
 *    epoch; §9.3 of the design record settles what a distinct record at an
 *    already-accepted epoch would need (a per-record replay ledger keyed by
 *    `eventId` and the record digest) and what a `supersedes` record does
 *    to the epoch (it inherits the epoch of the record it replaces).
 *  - **Freshness.** A record outside its validity window, or issued too long
 *    ago, is refused. Stale or offline status is a refusal, never a
 *    fallback to the last known good record.
 *  - **Rotation.** A new key is introduced under a new epoch. The old key
 *    stays usable only until its `notAfter`, and only for records it issued
 *    before then.
 *  - **Revocation.** A revoked key invalidates what it signed from the
 *    revocation's effective time. A *compromised* key invalidates what it
 *    signed for its entire lifetime, unless the record carries a trusted
 *    timestamp or a transparency-log inclusion proof that places its issue
 *    time before the compromise.
 */
import { z } from 'zod'

import {
  commitShaSchema,
  editorialArtifactSchema,
  editorialReleaseIdSchema,
  editorialRevisionIdSchema,
  editorialSchemaVersionsSchema,
  editorialTargetSchema,
  sha256Schema,
  timestampSchema,
} from './records'

/** The version of the trust policy these bounds belong to. */
export const EDITORIAL_TRUST_POLICY_VERSION = '1.0.0' as const

/** The record type of a producer export. */
export const EDITORIAL_PRODUCER_RECORD_TYPE =
  'erniesg.editorial.producer-export.v1' as const

/** The signature algorithms a producer key may use. */
export const EDITORIAL_SIGNATURE_ALGORITHMS = [
  'ed25519',
  'ecdsa-p256-sha256',
  'rsa-pss-sha256',
] as const
export type EditorialSignatureAlgorithm =
  (typeof EDITORIAL_SIGNATURE_ALGORITHMS)[number]

/**
 * How long a producer record may be older than the consumer's clock.
 *
 * A record older than this is refused even if its signature is good: the
 * window is what stops a captured record from being replayed indefinitely.
 */
export const TRUST_MAX_RECORD_AGE_SECONDS = 86_400

/** How far in the future a producer record may claim to have been issued. */
export const TRUST_MAX_FUTURE_SKEW_SECONDS = 300

/** The longest validity window a producer record may carry. */
export const TRUST_MAX_VALIDITY_SECONDS = 604_800

/**
 * The longest window during which a retired key and its successor may both
 * be accepted.
 *
 * A rotation that overlaps longer than this is a migration, not a rotation,
 * and needs a new epoch rather than a longer overlap.
 */
export const TRUST_KEY_ROTATION_MAX_OVERLAP_SECONDS = 86_400

/** The package pin a producer record binds. */
export const producerPackageBindingSchema = z
  .object({
    sourceCommit: commitShaSchema,
    artifact: z.string().min(1).max(256),
    artifactSha256: sha256Schema,
    integrity: z.string().min(1).max(256),
    version: z.string().min(1).max(64),
  })
  .strict()
export type ProducerPackageBinding = z.infer<typeof producerPackageBindingSchema>

/**
 * One producer key.
 *
 * `revokedAt` is the effective time of a revocation. `compromisedAt` is the
 * effective time of a compromise, and it is a different thing: a compromise
 * retroactively invalidates everything the key signed, while a revocation
 * only reaches back to the moment it took effect.
 */
export const producerKeySchema = z
  .object({
    keyId: z.string().min(1).max(128),
    policyEpoch: z.number().int().nonnegative(),
    algorithm: z.enum(EDITORIAL_SIGNATURE_ALGORITHMS),
    notBefore: timestampSchema,
    notAfter: timestampSchema,
    revokedAt: timestampSchema.optional(),
    compromisedAt: timestampSchema.optional(),
  })
  .strict()
export type ProducerKey = z.infer<typeof producerKeySchema>

/**
 * The authenticated export of a release.
 *
 * It is self-contained: a consumer that holds only this record knows which
 * revision was approved, which bytes were published, under which package,
 * schema, target and artifact versions, and it can check all of it.
 */
export const producerRecordSchema = z
  .object({
    recordType: z.literal(EDITORIAL_PRODUCER_RECORD_TYPE),
    version: z.literal(EDITORIAL_TRUST_POLICY_VERSION),
    /** This record's own id, and the event it reports. */
    producerRecordId: z.string().min(1).max(128),
    eventId: z.string().min(1).max(128),
    keyId: z.string().min(1).max(128),
    policyEpoch: z.number().int().nonnegative(),
    /** The release this record exports. */
    releaseId: editorialReleaseIdSchema,
    /** The digest of the exported release record. */
    releaseSha256: sha256Schema,
    approvedRevisionId: editorialRevisionIdSchema,
    contentHash: sha256Schema,
    documentSha256: sha256Schema,
    bundleSha256: sha256Schema.optional(),
    package: producerPackageBindingSchema,
    schemaVersions: editorialSchemaVersionsSchema,
    artifacts: z.array(editorialArtifactSchema).min(1).max(64),
    artifactSetSha256: sha256Schema,
    target: editorialTargetSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    status: z.enum(['active', 'superseded', 'revoked']),
    /** The producer record this one replaces, when it replaces one. */
    supersedes: z.string().min(1).max(128).optional(),
    signatureAlgorithm: z.enum(EDITORIAL_SIGNATURE_ALGORITHMS),
    /** The detached signature, base64url. */
    signature: z.string().min(1).max(4096),
  })
  .strict()
export type ProducerRecord = z.infer<typeof producerRecordSchema>

/** The epoch a consumer must refuse to go back to. */
export type TrustState = {
  /** The highest epoch the consumer has accepted. */
  highestAcceptedEpoch: number
}

/**
 * Whether a record's epoch may be accepted.
 *
 * Strictly greater than the highest accepted epoch. An equal epoch is a
 * replay of an epoch already in force and is refused; a lower epoch is a
 * rollback and is refused.
 *
 * The rule admits exactly one producer record per epoch, because the epoch
 * is the epoch of the key's authority and not a counter of the records.
 * §9.3 of the design record says what a distinct record at an
 * already-accepted epoch would need, and what a `supersedes` record does to
 * the epoch.
 */
export function trustEpochIsAcceptable(
  policyEpoch: number,
  state: TrustState,
): boolean {
  return policyEpoch > state.highestAcceptedEpoch
}

/** The epoch a consumer advances to after accepting a record. */
export function trustNextState(
  policyEpoch: number,
  state: TrustState,
): TrustState {
  return {
    highestAcceptedEpoch: Math.max(state.highestAcceptedEpoch, policyEpoch),
  }
}

/**
 * Whether a producer record is inside its validity window and fresh.
 *
 * `now` is the consumer's clock. The record must not be issued in the future
 * beyond the allowed skew, must not be expired, must not claim a validity
 * window longer than the policy allows, and must not be older than the
 * policy's freshness bound.
 */
export function trustProducerRecordIsFresh(
  record: Pick<ProducerRecord, 'issuedAt' | 'expiresAt'>,
  now: Date,
): boolean {
  const issued = Date.parse(record.issuedAt)
  const expires = Date.parse(record.expiresAt)
  const current = now.getTime()
  if (Number.isNaN(issued) || Number.isNaN(expires)) return false
  if (issued > current + TRUST_MAX_FUTURE_SKEW_SECONDS * 1000) return false
  if (expires <= current) return false
  if (expires - issued > TRUST_MAX_VALIDITY_SECONDS * 1000) return false
  if (current - issued > TRUST_MAX_RECORD_AGE_SECONDS * 1000) return false
  return true
}

/**
 * Whether a key may have signed a record issued at `issuedAt`.
 *
 * A revoked key is refused from its revocation's effective time onwards. A
 * compromised key is refused for its entire lifetime, because the records it
 * signed before the compromise are exactly the ones an attacker could have
 * made. The escape hatch — a trusted timestamp or a transparency-log
 * inclusion proof placing the issue time before the compromise — belongs to
 * the verifier, and is not modelled here.
 */
export function trustKeyIsUsableAt(
  key: ProducerKey,
  issuedAt: Date,
): boolean {
  const issued = issuedAt.getTime()
  if (issued < Date.parse(key.notBefore)) return false
  if (issued > Date.parse(key.notAfter)) return false
  if (key.compromisedAt !== undefined) return false
  if (key.revokedAt !== undefined && issued >= Date.parse(key.revokedAt)) {
    return false
  }
  return true
}

/**
 * Whether a rotation stays inside the overlap bound.
 *
 * A successor key that takes over more than
 * `TRUST_KEY_ROTATION_MAX_OVERLAP_SECONDS` after its predecessor stops is a
 * migration and needs its own epoch.
 */
export function trustRotationOverlapsWithin(
  previous: Pick<ProducerKey, 'notAfter'>,
  next: Pick<ProducerKey, 'notBefore'>,
): boolean {
  const previousEnd = Date.parse(previous.notAfter)
  const nextStart = Date.parse(next.notBefore)
  if (Number.isNaN(previousEnd) || Number.isNaN(nextStart)) return false
  return nextStart - previousEnd <= TRUST_KEY_ROTATION_MAX_OVERLAP_SECONDS * 1000
}

/**
 * The whole fail-closed pre-signature check.
 *
 * It answers the questions a consumer can answer without the signature:
 * is the epoch current, is the record fresh, is the key usable. The
 * signature itself is checked by E05b, and a consumer that cannot check the
 * signature must not treat this result as an authorisation.
 */
export function trustPreconditionsHold(input: {
  record: ProducerRecord
  key: ProducerKey
  state: TrustState
  now: Date
}): { ok: true } | { ok: false; reason: string } {
  const { record, key, state, now } = input
  if (record.keyId !== key.keyId) {
    return { ok: false, reason: 'producer_key_mismatch' }
  }
  if (record.policyEpoch !== key.policyEpoch) {
    return { ok: false, reason: 'producer_epoch_mismatch' }
  }
  if (!trustEpochIsAcceptable(record.policyEpoch, state)) {
    return { ok: false, reason: 'producer_epoch_not_advanced' }
  }
  if (!trustProducerRecordIsFresh(record, now)) {
    return { ok: false, reason: 'producer_record_not_fresh' }
  }
  if (!trustKeyIsUsableAt(key, new Date(record.issuedAt))) {
    return { ok: false, reason: 'producer_key_not_usable' }
  }
  return { ok: true }
}
