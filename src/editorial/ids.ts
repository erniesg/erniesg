/**
 * The immutable identifiers of the durable editorial record contract.
 *
 * Every editorial record is **content addressed**: its id is the SHA-256 of
 * the record's own immutable payload. Three rules make that safe, and the
 * whole module exists to enforce them.
 *
 * 1. **An id never changes.** Nothing in this module reads a mutable field,
 *    because no editorial record has one. The lifecycle state of a candidate
 *    or a release is a *projection* over the append-only record set, never a
 *    column of the record, so it can never leak into an id.
 * 2. **An id never encodes mutable state.** The identity payload excludes the
 *    record's timestamp. A timestamp is evidence of *when* a record was
 *    written, not of *what* it is, and two identical submissions at different
 *    times are the same record.
 * 3. **An id never encodes server state.** The payload is the record's own
 *    fields. No sequence number, no row id, no clock reading, no actor
 *    session token.
 *
 * The digest itself comes from the pinned Struct package
 * (`@erniesg/struct/identity`), which is the app's one canonical digest
 * primitive after the E-03 cutover. It is synchronous and runs unchanged in
 * Node, in the Worker and in a browser, so the same id can be derived on
 * either side of the store.
 *
 * The canonical form is the package's code-unit-sorted serialization: object
 * members are ordered by code unit (never by collation, which is
 * locale-dependent), arrays keep their order, and an absent optional field is
 * indistinguishable from an explicit `undefined`. `canonicalRecordValue`
 * enforces the last rule, because `JSON.stringify` drops `undefined` values
 * while the digest serializer would spell them out.
 */
import { structDigest } from '@erniesg/struct/identity'
import type {
  EditorialApproval,
  EditorialArtifact,
  EditorialCandidate,
  EditorialDecision,
  EditorialRecord,
  EditorialRecordKind,
  EditorialRelease,
  EditorialRevision,
  EditorialSupersession,
  EditorialValidation,
} from './records'

/** The domain tag every editorial digest is computed under. */
export const EDITORIAL_ID_DERIVATION = 'erniesg.editorial.id.v1' as const

/** The domain tag of the revision content hash. */
export const EDITORIAL_CONTENT_DERIVATION = 'erniesg.editorial.content.v1' as const

/** The domain tag of the artifact-set digest. */
export const EDITORIAL_ARTIFACT_SET_DERIVATION =
  'erniesg.editorial.artifact-set.v1' as const

/** The domain tag of the idempotency fingerprint. */
export const EDITORIAL_IDEMPOTENCY_DERIVATION =
  'erniesg.editorial.idempotency.v1' as const

/** The namespace every editorial id lives in. */
export const EDITORIAL_ID_PREFIX = 'urn:editorial:'

/**
 * The one field of each record kind that is *when* rather than *what*.
 *
 * It is excluded from the identity payload, so a record's id depends on its
 * content and not on the moment it was written.
 */
export const EDITORIAL_TIMESTAMP_FIELD_BY_KIND: Record<
  EditorialRecordKind,
  string
> = {
  revision: 'created',
  decision: 'decidedAt',
  candidate: 'created',
  validation: 'validatedAt',
  approval: 'approvedAt',
  release: 'releasedAt',
  supersession: 'at',
}

/**
 * A value with every `undefined` removed, recursively.
 *
 * Zod keeps an absent optional key on the parsed object as an explicit
 * `undefined`, and the digest serializer would spell that out as the text
 * `undefined`. Dropping it makes "absent" and "explicitly undefined" the same
 * value, which is what a reader of the record means.
 */
export function canonicalRecordValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRecordValue)
  if (value !== null && typeof value === 'object') {
    const canonical: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested === undefined) continue
      canonical[key] = canonicalRecordValue(nested)
    }
    return canonical
  }
  return value
}

/** The canonical SHA-256 of a value, as lowercase hex. */
export function editorialDigest(value: unknown): string {
  return structDigest(canonicalRecordValue(value))
}

/**
 * A record that has not been given its id yet.
 *
 * Minting an id is the act of writing a record, so the record without its id
 * is the thing an id is derived from.
 */
export type EditorialUnidentifiedRecord =
  | Omit<EditorialRevision, 'id'>
  | Omit<EditorialDecision, 'id'>
  | Omit<EditorialCandidate, 'id'>
  | Omit<EditorialValidation, 'id'>
  | Omit<EditorialApproval, 'id'>
  | Omit<EditorialRelease, 'id'>
  | Omit<EditorialSupersession, 'id'>

/** A record whose identity payload can be computed. */
export type EditorialIdentityInput =
  | EditorialRecord
  | EditorialUnidentifiedRecord

/**
 * The exact payload an editorial id is derived from.
 *
 * It is the record's own fields, minus its id and minus its timestamp, under
 * a domain tag and the record's kind. Nothing else enters it.
 */
export function editorialIdentityPayload(
  record: EditorialIdentityInput,
): Record<string, unknown> {
  const timestampField = EDITORIAL_TIMESTAMP_FIELD_BY_KIND[record.kind]
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(
    record as unknown as Record<string, unknown>,
  )) {
    if (key === 'id' || key === timestampField) continue
    if (value === undefined) continue
    payload[key] = canonicalRecordValue(value)
  }
  return {
    domain: EDITORIAL_ID_DERIVATION,
    kind: record.kind,
    payload,
  }
}

/** The digest of a record's identity payload: the hex inside its id. */
export function editorialRecordDigest(
  record: EditorialIdentityInput,
): string {
  return editorialDigest(editorialIdentityPayload(record))
}

/** The id a record must carry. */
export function deriveEditorialId(record: EditorialIdentityInput): string {
  return `${EDITORIAL_ID_PREFIX}${record.kind}:${editorialRecordDigest(record)}`
}

/**
 * Whether a record's id is the id its content derives.
 *
 * A record that fails this check is a record whose id was minted by
 * something other than its own content, which is the shape a forged record
 * takes. The state machine refuses it.
 */
export function editorialRecordIdMatches(record: EditorialRecord): boolean {
  return record.id === deriveEditorialId(record)
}

/** A durable reference to a record: its id and the digest behind that id. */
export type EditorialRecordRef = {
  /** The content-addressed id of the referenced record. */
  id: string
  /** The digest of the referenced record's identity payload. */
  sha256: string
}

/** The durable reference to a record. */
export function editorialRecordRef(
  record: EditorialRecord,
): EditorialRecordRef {
  return { id: record.id, sha256: editorialRecordDigest(record) }
}

/**
 * The content hash of a revision: the digest of the exact content digests.
 *
 * This is the value a decision binds. It deliberately does not cover the
 * renderer, the profile or the schema versions, because those are how the
 * content is *presented*, not what it *is*: two revisions of the same content
 * under different renderers share a content hash and differ in their ids.
 *
 * `semanticReceiptSha256` is mandatory, because the source binding it comes
 * from is: the semantic receipt digest is the only semantic identity a
 * Struct-cutover source carries, so a content hash that could leave it out
 * would not name the content it claims to name. `bundleSha256` stays
 * optional, for the nonpublishing metadata cases that have no wire bytes.
 */
export function editorialContentDigest(input: {
  documentSha256: string
  bundleSha256?: string | undefined
  semanticReceiptSha256: string
}): string {
  return editorialDigest({
    domain: EDITORIAL_CONTENT_DERIVATION,
    documentSha256: input.documentSha256,
    ...(input.bundleSha256 === undefined
      ? {}
      : { bundleSha256: input.bundleSha256 }),
    semanticReceiptSha256: input.semanticReceiptSha256,
  })
}

/**
 * The digest of an artifact set: the exact bytes the release publishes.
 *
 * The artifacts are ordered by path before hashing, so the digest does not
 * depend on the order the writer happened to produce them in.
 */
export function editorialArtifactSetDigest(
  artifacts: readonly EditorialArtifact[],
): string {
  const ordered = [...artifacts]
    .map((artifact) => ({ ...artifact }))
    .sort((left, right) =>
      left.path === right.path
        ? left.sha256.localeCompare(right.sha256)
        : left.path < right.path
          ? -1
          : 1,
    )
  return editorialDigest({
    domain: EDITORIAL_ARTIFACT_SET_DERIVATION,
    artifacts: ordered,
  })
}

/**
 * The idempotency fingerprint of a submission.
 *
 * Because every editorial record is content addressed, the fingerprint is the
 * record's own identity digest: the same hex that appears in its id. A retry
 * of the same submission therefore carries the same fingerprint, and a
 * submission with the same key but different content carries a different one,
 * which is exactly the distinction the idempotency receipt stores.
 */
export function idempotencyFingerprint(record: EditorialRecord): string {
  return editorialRecordDigest(record)
}

/* The per-kind derivation helpers, so a caller never builds a payload itself. */

export function deriveRevisionId(
  revision: Omit<EditorialRevision, 'id'> | EditorialRevision,
): string {
  return deriveEditorialId(revision)
}

export function deriveDecisionId(
  decision: Omit<EditorialDecision, 'id'> | EditorialDecision,
): string {
  return deriveEditorialId(decision)
}

export function deriveCandidateId(
  candidate: Omit<EditorialCandidate, 'id'> | EditorialCandidate,
): string {
  return deriveEditorialId(candidate)
}

export function deriveValidationId(
  validation: Omit<EditorialValidation, 'id'> | EditorialValidation,
): string {
  return deriveEditorialId(validation)
}

export function deriveApprovalId(
  approval: Omit<EditorialApproval, 'id'> | EditorialApproval,
): string {
  return deriveEditorialId(approval)
}

export function deriveReleaseId(
  release: Omit<EditorialRelease, 'id'> | EditorialRelease,
): string {
  return deriveEditorialId(release)
}

export function deriveSupersessionId(
  supersession: Omit<EditorialSupersession, 'id'> | EditorialSupersession,
): string {
  return deriveEditorialId(supersession)
}

/**
 * The id a not-yet-written record will carry.
 *
 * This is the only supported way to mint an editorial id: the id is a
 * function of the record, never a value a caller chose.
 */
export function mintEditorialId<T extends EditorialUnidentifiedRecord>(
  record: T,
): T & { id: string } {
  return { ...record, id: deriveEditorialId(record) } as T & { id: string }
}
