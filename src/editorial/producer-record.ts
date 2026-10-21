/**
 * The authenticated producer export: the record, its identity, and its
 * detached signature.
 *
 * E-05a's `trust.ts` states the *shape* of the producer record and the trust
 * bounds, and deliberately performs no cryptography. This module is the other
 * half: the bytes a consumer verifies, and the verification itself.
 *
 * ## The primitive
 *
 * **ECDSA over NIST P-256 with SHA-256, detached, through WebCrypto**
 * (`globalThis.crypto.subtle`).
 *
 * - It is **already in the repository**: no dependency is added, and the
 *   primitive is the one the app already uses for digests
 *   (`crypto.subtle.digest` in `src/research/epub.ts`,
 *   `src/research/docx-import.ts`, `src/research/pdf.ts` and
 *   `src/worker/margin/routes.ts`; `src/research/overrides.ts` hashes with
 *   `node:crypto`'s `createHash` instead). It runs unchanged in Node, in
 *   the Cloudflare Worker and in a browser, so a producer in Node and a
 *   consumer in the Worker verify with the same code.
 * - It is **asymmetric**: the consumer holds the *public* key, so the trust
 *   root can be published and every consumer does not need a shared secret.
 *   That is what makes the key registry of `trust-policy.ts` possible.
 * - **P-256 is the algorithm with the widest support**: it is the one
 *   asymmetric algorithm every WebCrypto implementation — Node, Workers,
 *   browsers — is required to have. Ed25519 is not required by the WebCrypto
 *   specification, so this implementation refuses it rather than depend on it.
 *
 * `EDITORIAL_SIGNATURE_ALGORITHMS` (E-05a) names three algorithms. This
 * implementation supports exactly one of them, and **refuses the other two**
 * with `producer_signature_algorithm_unsupported` rather than half-verifying
 * them. Adding one is a table entry and a branch, not a new scheme.
 *
 * ## What is signed
 *
 * The signed message is the **canonical digest** of the record's signing
 * payload, under the domain tag `erniesg.editorial.producer-export.v1`:
 *
 * ```
 * signing payload = every field of the record except `signature`
 * digest          = structDigest({ domain, payload })      // the pinned Struct digest
 * signed message  = the 32 raw bytes of that digest
 * signature       = ECDSA-P256-SHA256(message, privateKey)  // base64url, detached
 * ```
 *
 * Two properties matter:
 *
 * 1. **Every field is covered**, including `issuedAt`, `expiresAt`,
 *    `status`, `target`, `package` and every digest. A field that is not in
 *    the payload is a field an attacker may change.
 * 2. **The canonical form is the repository's own**. The digest is the pinned
 *    Struct package's `structDigest` (`ids.ts`), so the bytes that are signed
 *    are the bytes the app's one canonical serializer produces, in Node, in
 *    the Worker and in a browser. There is no second serializer to drift.
 *
 * Signing the digest rather than a re-serialised payload is deliberate: the
 * repository exposes exactly one canonical form (a digest), and a signature
 * over a digest is the standard construction for signing a structured
 * document. A second record that differs in any field has a different digest
 * and therefore a different signature.
 *
 * ## The identity
 *
 * A producer key's identity is its **public key fingerprint**: the SHA-256 of
 * its SPKI bytes. The key id is derived from it
 * (`<algorithm>:<fingerprint>`), so a record that claims a key id can only be
 * verified against the key whose fingerprint that id names. The consumer does
 * not need a separate "who is this key" table: the id *is* the fingerprint.
 */
import { z } from 'zod'

import { canonicalRecordValue, editorialDigest } from './ids'
import { sha256Schema } from './records'
import {
  EDITORIAL_SIGNATURE_ALGORITHMS,
  producerKeySchema,
  type ProducerRecord,
} from './trust'

/** The domain tag the producer record's own digest is computed under. */
export const EDITORIAL_PRODUCER_DIGEST_DERIVATION =
  'erniesg.editorial.producer-export.v1' as const

/** The domain tag the producer record's id is computed under. */
export const EDITORIAL_PRODUCER_ID_DERIVATION =
  'erniesg.editorial.producer-id.v1' as const

/** The namespace every producer record id lives in. */
export const EDITORIAL_PRODUCER_ID_PREFIX = 'urn:editorial:producer-export:' as const

/**
 * The signature algorithms this implementation signs and verifies.
 *
 * The other two algorithms of `EDITORIAL_SIGNATURE_ALGORITHMS` are refused,
 * not half-supported: a verifier that guesses is a verifier that can be
 * fooled.
 */
export const SUPPORTED_PRODUCER_SIGNATURE_ALGORITHMS = [
  'ecdsa-p256-sha256',
] as const
export type SupportedProducerSignatureAlgorithm =
  (typeof SUPPORTED_PRODUCER_SIGNATURE_ALGORITHMS)[number]

/**
 * The exact field list of the producer record.
 *
 * The record is versioned and strict: an unknown field is a refusal, not a
 * shrug. This constant is the field-by-field statement of that, and
 * `producer-record.test.ts` pins it against the schema's own shape, so a
 * field that is added to one and not the other fails loudly.
 */
export const PRODUCER_RECORD_FIELDS = [
  'recordType',
  'version',
  'producerRecordId',
  'eventId',
  'keyId',
  'policyEpoch',
  'releaseId',
  'releaseSha256',
  'approvedRevisionId',
  'contentHash',
  'documentSha256',
  'bundleSha256',
  'package',
  'schemaVersions',
  'artifacts',
  'artifactSetSha256',
  'target',
  'issuedAt',
  'expiresAt',
  'status',
  'supersedes',
  'signatureAlgorithm',
  'signature',
] as const
export type ProducerRecordField = (typeof PRODUCER_RECORD_FIELDS)[number]

/* ------------------------------------------------------------------- keys */

/**
 * A public key, and the fingerprint that identifies it.
 *
 * `publicKeySpki` holds the SPKI (DER) bytes of the public key in base64url.
 * The fingerprint is the SHA-256 of those bytes, and the key id is derived
 * from it.
 */
export const producerPublicKeySchema = z
  .object({
    keyId: z.string().min(1).max(128),
    algorithm: z.enum(EDITORIAL_SIGNATURE_ALGORITHMS),
    publicKeySpki: z.string().min(1).max(2048),
    fingerprint: sha256Schema,
  })
  .strict()
export type ProducerPublicKey = z.infer<typeof producerPublicKeySchema>

/**
 * A registry entry: a public key and the trust facts about it.
 *
 * It is E-05a's `producerKeySchema` (the epoch, the validity window, the
 * revocation and the compromise) with the material a consumer needs to
 * verify. `revokedAt` is the *effective time* of a revocation and
 * `compromisedAt` is the effective time of a compromise; they are different
 * things and are enforced differently.
 */
export const producerKeyMaterialSchema = producerKeySchema.extend({
  publicKeySpki: z.string().min(1).max(2048),
  fingerprint: sha256Schema,
})
export type ProducerKeyMaterial = z.infer<typeof producerKeyMaterialSchema>

/* --------------------------------------------------------------- encodings */

/** The bytes of a lowercase hex string. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/** The base64url encoding of some bytes. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * The bytes of a base64url string, or `null` when it is not one.
 *
 * `null` is a refusal, not a fallback: a signature that does not decode is a
 * signature that does not verify.
 */
export function base64UrlDecode(text: string): Uint8Array | null {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4)
    const binary = atob(withPadding)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

/** The SHA-256 of some bytes, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  let hex = ''
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * The fingerprint of a public key: the SHA-256 of its SPKI bytes.
 *
 * `null` when the material does not decode, which is a refusal.
 */
export async function producerKeyFingerprint(
  publicKeySpki: string,
): Promise<string | null> {
  const bytes = base64UrlDecode(publicKeySpki)
  if (bytes === null) return null
  return sha256Hex(bytes)
}

/**
 * The key id a public key must carry: its algorithm and its fingerprint.
 *
 * The id is derived, never chosen, so a registry entry whose key id is not
 * this value is an entry whose id was minted by something other than its key.
 */
export function producerKeyId(
  algorithm: EditorialSignatureAlgorithmName,
  fingerprint: string,
): string {
  return `${algorithm}:${fingerprint}`
}

/** The name of the algorithm field of a key. */
export type EditorialSignatureAlgorithmName =
  (typeof EDITORIAL_SIGNATURE_ALGORITHMS)[number]

/* ---------------------------------------------------------------- payloads */

/**
 * A canonical payload: every field of a value except the excluded ones, with
 * every absent optional field removed.
 *
 * `canonicalRecordValue` is the repository's own canonicaliser, so an absent
 * field and an explicit `undefined` are the same value, and the digest of
 * the payload is the digest of the record as it was written.
 */
export function producerCanonicalPayload(
  value: object,
  exclude: readonly string[] = [],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (exclude.includes(key)) continue
    payload[key] = canonicalRecordValue(nested)
  }
  return payload
}

/**
 * The identity payload of a producer record: every field except its own id
 * and its signature.
 *
 * The id cannot depend on the signature (the signature covers the id), and
 * the signature cannot be part of the id (the id would then depend on
 * itself).
 */
export function producerRecordIdentityPayload(
  record: object,
): Record<string, unknown> {
  return producerCanonicalPayload(record, ['producerRecordId', 'signature'])
}

/**
 * The signing payload of a producer record: every field except the
 * signature.
 *
 * The id is in it, so a signature covers the record's own name as well as
 * its contents.
 */
export function producerRecordSigningPayload(
  record: object,
): Record<string, unknown> {
  return producerCanonicalPayload(record, ['signature'])
}

/** The canonical digest of a producer record, as lowercase hex. */
export function producerRecordDigest(record: object): string {
  return editorialDigest({
    domain: EDITORIAL_PRODUCER_DIGEST_DERIVATION,
    payload: producerRecordSigningPayload(record),
  })
}

/** The 32 bytes that are signed for a producer record. */
export function producerSigningMessage(record: object): Uint8Array {
  return hexToBytes(producerRecordDigest(record))
}

/** The id a producer record must carry. */
export function deriveProducerRecordId(record: object): string {
  return `${EDITORIAL_PRODUCER_ID_PREFIX}${editorialDigest({
    domain: EDITORIAL_PRODUCER_ID_DERIVATION,
    payload: producerRecordIdentityPayload(record),
  })}`
}

/* -------------------------------------------------------------- signatures */

/**
 * Sign a canonical payload and return the detached signature, base64url.
 *
 * The signed message is the payload's canonical digest, under the domain tag
 * the caller names, so two payloads under two domains never share a
 * signature.
 */
export async function signDetached(input: {
  domain: string
  payload: Record<string, unknown>
  privateKey: CryptoKey
}): Promise<string> {
  const message = hexToBytes(
    editorialDigest({ domain: input.domain, payload: input.payload }),
  )
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    input.privateKey,
    message,
  )
  return base64UrlEncode(new Uint8Array(signature))
}

/**
 * Verify a detached signature over a canonical payload.
 *
 * It answers one question — does this signature match these bytes under
 * this domain — and it never says *why* it does not. The comparison happens
 * inside the WebCrypto verifier, over the whole signature, so it does not
 * leak how much of the signature was right.
 */
export async function verifyDetached(input: {
  domain: string
  payload: Record<string, unknown>
  publicKey: CryptoKey
  signature: string
}): Promise<boolean> {
  const bytes = base64UrlDecode(input.signature)
  if (bytes === null) return false
  const message = hexToBytes(
    editorialDigest({ domain: input.domain, payload: input.payload }),
  )
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      input.publicKey,
      bytes,
      message,
    )
  } catch {
    return false
  }
}

/**
 * Sign a producer record and return it with its signature.
 *
 * The record that comes back is the record that was signed: the signature
 * covers every field, so the id is derived from the signed content.
 */
export async function signProducerRecord(input: {
  record: ProducerRecord
  privateKey: CryptoKey
}): Promise<ProducerRecord> {
  const signature = await signDetached({
    domain: EDITORIAL_PRODUCER_DIGEST_DERIVATION,
    payload: producerRecordSigningPayload(input.record),
    privateKey: input.privateKey,
  })
  return { ...input.record, signature }
}

/** The reasons a producer record's signature may be refused. */
export const PRODUCER_SIGNATURE_REFUSALS = [
  'producer_signature_algorithm_unsupported',
  'producer_signature_invalid',
] as const
export type ProducerSignatureRefusal =
  (typeof PRODUCER_SIGNATURE_REFUSALS)[number]

/**
 * Verify that a producer record was authored by the key that signed it and
 * that its contents were not altered.
 *
 * The refusal is deliberately **non-leaking**: a bad signature, a truncated
 * signature, a signature over different bytes and a signature by a different
 * key are all `producer_signature_invalid`. The reason names the outcome,
 * never the difference.
 */
export async function verifyProducerRecordSignature(input: {
  record: ProducerRecord
  publicKey: CryptoKey
}): Promise<{ ok: true } | { ok: false; reason: ProducerSignatureRefusal }> {
  const supported: readonly string[] = SUPPORTED_PRODUCER_SIGNATURE_ALGORITHMS
  if (!supported.includes(input.record.signatureAlgorithm)) {
    return { ok: false, reason: 'producer_signature_algorithm_unsupported' }
  }
  const verified = await verifyDetached({
    domain: EDITORIAL_PRODUCER_DIGEST_DERIVATION,
    payload: producerRecordSigningPayload(input.record),
    publicKey: input.publicKey,
    signature: input.record.signature,
  })
  if (!verified) {
    return { ok: false, reason: 'producer_signature_invalid' }
  }
  return { ok: true }
}

/**
 * Import a public key from its SPKI bytes.
 *
 * `null` when the material does not import, which is a refusal: a key that
 * cannot be imported cannot verify anything.
 */
export async function importProducerPublicKey(key: {
  algorithm: string
  publicKeySpki: string
}): Promise<CryptoKey | null> {
  const bytes = base64UrlDecode(key.publicKeySpki)
  if (bytes === null) return null
  try {
    return await crypto.subtle.importKey(
      'spki',
      bytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    )
  } catch {
    return null
  }
}
