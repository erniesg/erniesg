/**
 * The fixtures the producer-record and trust-policy tests share.
 *
 * They are the same kind of thing as `fixtures.ts`: real values, derived the
 * way the code derives them, so a fixture can never carry an id, a digest or
 * a signature that its own content does not produce. The keys are generated
 * with WebCrypto, so the signature in a fixture is a real signature over the
 * real payload — and a fixture that is tampered with is tampered with the
 * same bytes the verifier recomputes.
 */
import { editorialArtifactSetDigest } from './ids'
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
import {
  base64UrlEncode,
  deriveProducerRecordId,
  producerKeyFingerprint,
  producerKeyId,
  producerRecordDigest,
  signProducerRecord,
  type ProducerKeyMaterial,
  type ProducerPublicKey,
} from './producer-record'
import {
  EDITORIAL_TRUST_POLICY_RECORD_TYPE,
  signProducerInclusionProof,
  signProducerTrustPolicy,
  signProducerTrustRoot,
  type ProducerInclusionProof,
  type ProducerTrustPolicy,
  type ProducerTrustRoot,
} from './trust-policy'
import { EDITORIAL_PRODUCER_RECORD_TYPE, type ProducerRecord } from './trust'

/** The epoch the producer key is issued under. */
export const PRODUCER_KEY_EPOCH = 7

/** The epoch of the policy epoch document. */
export const POLICY_EPOCH = 9

/** The consumer's clock in the tests. */
export const NOW = new Date('2026-10-20T11:00:00.000Z')

/** The producer key's validity window. */
export const PRODUCER_NOT_BEFORE = '2026-10-01T00:00:00.000Z'
export const PRODUCER_NOT_AFTER = '2026-12-01T00:00:00.000Z'

/** The policy's validity window. */
export const POLICY_ISSUED_AT = '2026-10-20T09:00:00.000Z'
export const POLICY_EXPIRES_AT = '2026-10-27T09:00:00.000Z'

/** The bounds the policy carries. */
export const TRUST_BOUNDS = {
  maxRecordAgeSeconds: 86_400,
  maxValiditySeconds: 604_800,
  maxFutureSkewSeconds: 300,
  maxRotationOverlapSeconds: 86_400,
} as const

/** A generated key pair and the public material a registry carries. */
export type ProducerTestKey = {
  keyPair: CryptoKeyPair
  publicKey: ProducerPublicKey
}

/** The three keys the fixtures need: the root, the producer and a timestamp. */
export type ProducerTestKeys = {
  root: ProducerTestKey
  producer: ProducerTestKey
  timestamp: ProducerTestKey
}

/** Generate an ECDSA P-256 key pair. */
export async function generateProducerKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
}

/** The public material of a key pair: its SPKI bytes and its fingerprint. */
export async function publicKeyOf(
  keyPair: CryptoKeyPair,
): Promise<ProducerPublicKey> {
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey)
  const publicKeySpki = base64UrlEncode(new Uint8Array(spki))
  const fingerprint = await producerKeyFingerprint(publicKeySpki)
  if (fingerprint === null) {
    throw new Error('the fixture key does not have a fingerprint')
  }
  return {
    keyId: producerKeyId('ecdsa-p256-sha256', fingerprint),
    algorithm: 'ecdsa-p256-sha256',
    publicKeySpki,
    fingerprint,
  }
}

/** Generate the root, producer and timestamp keys the tests use. */
export async function makeProducerTestKeys(): Promise<ProducerTestKeys> {
  const [root, producer, timestamp] = await Promise.all([
    generateProducerKeyPair(),
    generateProducerKeyPair(),
    generateProducerKeyPair(),
  ])
  const [rootKey, producerKey, timestampKey] = await Promise.all([
    publicKeyOf(root),
    publicKeyOf(producer),
    publicKeyOf(timestamp),
  ])
  return {
    root: { keyPair: root, publicKey: rootKey },
    producer: { keyPair: producer, publicKey: producerKey },
    timestamp: { keyPair: timestamp, publicKey: timestampKey },
  }
}

/** The registry entry of the producer key. */
export function producerKeyMaterial(
  keys: ProducerTestKeys,
  overrides: Partial<ProducerKeyMaterial> = {},
): ProducerKeyMaterial {
  return {
    keyId: keys.producer.publicKey.keyId,
    policyEpoch: PRODUCER_KEY_EPOCH,
    algorithm: 'ecdsa-p256-sha256',
    notBefore: PRODUCER_NOT_BEFORE,
    notAfter: PRODUCER_NOT_AFTER,
    publicKeySpki: keys.producer.publicKey.publicKeySpki,
    fingerprint: keys.producer.publicKey.fingerprint,
    ...overrides,
  }
}

/**
 * The trust root the consumer is configured with.
 *
 * The root is a **signed document about itself**: it carries the epoch floor
 * the app has provisioned and the root's own signature over it. The default
 * floor is `0` — no floor beyond the epoch rule — and a deployment that has
 * provisioned the authority raises it, because the floor is what stops a
 * consumer that has accepted nothing yet from taking a stale policy.
 */
export async function trustRootFixture(
  keys: ProducerTestKeys,
  overrides: { minPolicyEpoch?: number } = {},
) {
  const root: ProducerTrustRoot = {
    version: '1.0.0',
    minPolicyEpoch: overrides.minPolicyEpoch ?? 0,
    key: keys.root.publicKey,
    timestampAuthorities: [keys.timestamp.publicKey],
    signatureAlgorithm: 'ecdsa-p256-sha256',
    signature: '',
  }
  return signProducerTrustRoot({
    root,
    privateKey: keys.root.keyPair.privateKey,
  })
}

/** A signed policy epoch document. */
export async function trustPolicyFixture(options: {
  keys: ProducerTestKeys
  overrides?: Partial<ProducerTrustPolicy>
  keyOverrides?: Partial<ProducerKeyMaterial>
}): Promise<ProducerTrustPolicy> {
  const { keys } = options
  const policy: ProducerTrustPolicy = {
    recordType: EDITORIAL_TRUST_POLICY_RECORD_TYPE,
    version: '1.0.0',
    policyEpoch: POLICY_EPOCH,
    issuedAt: POLICY_ISSUED_AT,
    expiresAt: POLICY_EXPIRES_AT,
    bounds: { ...TRUST_BOUNDS },
    keys: [producerKeyMaterial(keys, options.keyOverrides)],
    signatureAlgorithm: 'ecdsa-p256-sha256',
    signature: '',
    ...options.overrides,
  }
  return signProducerTrustPolicy({
    policy,
    privateKey: keys.root.keyPair.privateKey,
  })
}

/**
 * A producer record, with its id derived and its signature made.
 *
 * `sign: false` returns the record with the signature it would have, which
 * is what a tampered-with record looks like.
 */
export async function producerRecordFixture(options: {
  keys: ProducerTestKeys
  overrides?: Partial<ProducerRecord>
  sign?: boolean
  /** The key the record is signed with. It is the producer's by default. */
  signingKey?: CryptoKey
}): Promise<ProducerRecord> {
  const { keys } = options
  const revision = revisionFixture()
  const candidate = candidateFixture(revision)
  const withoutId = {
    recordType: EDITORIAL_PRODUCER_RECORD_TYPE,
    version: '1.0.0',
    eventId: 'event-1',
    keyId: keys.producer.publicKey.keyId,
    policyEpoch: PRODUCER_KEY_EPOCH,
    releaseId: `urn:editorial:release:${'a'.repeat(64)}`,
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
    schemaVersions: { ...revision.schemaVersions },
    artifacts: [...ARTIFACTS],
    artifactSetSha256: editorialArtifactSetDigest(ARTIFACTS),
    target: candidate.target,
    issuedAt: LATER,
    expiresAt: '2026-10-21T10:00:00.000Z',
    status: 'active',
    signatureAlgorithm: 'ecdsa-p256-sha256',
    ...options.overrides,
  }
  const withId = {
    ...withoutId,
    producerRecordId: deriveProducerRecordId(withoutId),
  }
  if (options.sign === false) {
    return { ...withId, signature: '' } as ProducerRecord
  }
  return signProducerRecord({
    record: withId as ProducerRecord,
    privateKey: options.signingKey ?? keys.producer.keyPair.privateKey,
  })
}

/** A signed inclusion proof for a record. */
export async function inclusionProofFixture(options: {
  keys: ProducerTestKeys
  record: ProducerRecord
  observedAt?: string
  kind?: 'trusted-timestamp' | 'transparency-log'
}): Promise<ProducerInclusionProof> {
  const proof: ProducerInclusionProof = {
    kind: options.kind ?? 'trusted-timestamp',
    authorityKeyId: options.keys.timestamp.publicKey.keyId,
    recordDigest: producerRecordDigest(options.record),
    observedAt: options.observedAt ?? '2026-10-20T09:30:00.000Z',
    signatureAlgorithm: 'ecdsa-p256-sha256',
    signature: '',
  }
  return signProducerInclusionProof({
    proof,
    privateKey: options.keys.timestamp.keyPair.privateKey,
  })
}
