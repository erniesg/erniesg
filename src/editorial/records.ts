/**
 * The durable editorial record contract.
 *
 * These are the records the app writes when it publishes, and the only
 * evidence a reader has that a publication was approved. Seven kinds:
 *
 * | kind          | what it is                                              |
 * | ------------- | ------------------------------------------------------- |
 * | `revision`    | the immutable content revision, with its rendering intent |
 * | `decision`    | a reviewer's decision about exactly one revision          |
 * | `candidate`   | the release candidate assembled from one approved revision |
 * | `validation`  | one mandatory check and its outcome                       |
 * | `approval`    | an authenticated approval bound to a candidate's digests  |
 * | `release`     | the published release, binding every digest above         |
 * | `supersession`| the record that retires a release                         |
 *
 * Every record is **immutable**: it is written once and never updated. The
 * lifecycle state of a candidate or a release is a projection over this
 * record set, computed in `validation.ts` and enforced in
 * `state-machine.ts`, not a column of the record. That is what lets an id be
 * a digest of the record's own content (`ids.ts`).
 *
 * The schemas are strict: an unknown field is a refusal, not a shrug, so a
 * record written by a newer writer cannot be half-understood by an older
 * reader.
 */
import { z } from 'zod'

import {
  editorialArtifactSetDigest,
  editorialContentDigest,
} from './ids'

export const EDITORIAL_REVISION_VERSION = '1.0.0' as const
export const EDITORIAL_DECISION_VERSION = '1.0.0' as const
export const EDITORIAL_CANDIDATE_VERSION = '1.0.0' as const
export const EDITORIAL_VALIDATION_VERSION = '1.0.0' as const
export const EDITORIAL_APPROVAL_VERSION = '1.0.0' as const
export const EDITORIAL_RELEASE_VERSION = '1.0.0' as const
export const EDITORIAL_SUPERSESSION_VERSION = '1.0.0' as const
export const EDITORIAL_TARGET_VERSION = '1.0.0' as const

/** The record kinds the durable editorial store holds. */
export const EDITORIAL_RECORD_KINDS = [
  'revision',
  'decision',
  'candidate',
  'validation',
  'approval',
  'release',
  'supersession',
] as const
export type EditorialRecordKind = (typeof EDITORIAL_RECORD_KINDS)[number]

/* ------------------------------------------------------------------ leaves */

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
export const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/)
export const timestampSchema = z.string().datetime()

const slugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9.-]*$/)

/* ------------------------------------------------------------------ actors */

/**
 * The actor kinds.
 *
 * `editor`, `reviewer` and `approver` are people, authenticated by the
 * WorkOS session the margin service already uses; their identity is the
 * `(provider, issuer, subject)` triple, never an email address. `tool` is a
 * deterministic program (EPUBCheck, Ace, the bundle verifier) and `producer`
 * is the writing session that exports a release.
 */
export const EDITORIAL_ACTOR_KINDS = [
  'editor',
  'reviewer',
  'approver',
  'tool',
  'producer',
] as const
export type EditorialActorKind = (typeof EDITORIAL_ACTOR_KINDS)[number]

/** A human actor: an authenticated principal and the role it acts in. */
export const editorialHumanActorSchema = z
  .object({
    kind: z.enum(['editor', 'reviewer', 'approver']),
    /**
     * The principal key, in the margin service's own spelling:
     * `urn:margin:principal:<provider>:<issuer>:<subject>`.
     */
    principal: z.string().min(1).max(512),
    provider: z.string().min(1).max(64),
    issuer: z.string().min(1).max(256),
    subject: z.string().min(1).max(256),
  })
  .strict()
export type EditorialHumanActor = z.infer<typeof editorialHumanActorSchema>

/** A deterministic program that produced a validation. */
export const editorialToolActorSchema = z
  .object({
    kind: z.literal('tool'),
    toolId: z.string().min(1).max(128),
    toolVersion: z.string().min(1).max(64),
  })
  .strict()
export type EditorialToolActor = z.infer<typeof editorialToolActorSchema>

/** The writing session that exported a release, and its trust epoch. */
export const editorialProducerActorSchema = z
  .object({
    kind: z.literal('producer'),
    keyId: z.string().min(1).max(128),
    policyEpoch: z.number().int().nonnegative(),
  })
  .strict()
export type EditorialProducerActor = z.infer<typeof editorialProducerActorSchema>

/** Any actor that may appear in an editorial record. */
export const editorialActorSchema = z.discriminatedUnion('kind', [
  editorialHumanActorSchema,
  editorialToolActorSchema,
  editorialProducerActorSchema,
])
export type EditorialActor = z.infer<typeof editorialActorSchema>

/* ------------------------------------------------- the E-04 source binding */

/**
 * The Struct-cutover source binding, in the exact shape the E-04 contract
 * freezes for `sourceBinding`:
 * `documentSha256`, `bundleSha256?`, `semanticReceiptSha256?`,
 * `packageSourceCommit`, `packageArtifact`, `packageArtifactSha256`,
 * `packageIntegrity`, `packageVersion`.
 *
 * The legacy `ResearchPaper` variant of the E-04 union is deliberately not
 * admitted here: a release in this contract must bind a Struct-cutover
 * source, so the shape is pinned rather than inherited.
 *
 * E-05 does not import `src/publication/**` (the E-04 module does not exist
 * on this base and E-05 must not touch that tree), so the shape is restated
 * here. `editorialSourceBindingSchema.test.ts` pins the exact field set so a
 * drift against the E-04 module is visible rather than silent.
 */
export const editorialSourceBindingSchema = z
  .object({
    kind: z.literal('struct-cutover'),
    documentSha256: sha256Schema,
    bundleSha256: sha256Schema.optional(),
    semanticReceiptSha256: sha256Schema.optional(),
    packageSourceCommit: commitShaSchema,
    packageArtifact: z.string().min(1).max(256),
    packageArtifactSha256: sha256Schema,
    packageIntegrity: z.string().min(1).max(256),
    packageVersion: z.string().min(1).max(64),
  })
  .strict()
export type EditorialSourceBinding = z.infer<typeof editorialSourceBindingSchema>

/* ------------------------------------------- schema versions and rendering */

/**
 * The schema versions of the artifacts a release publishes.
 *
 * The same field set as the E-04 `PublicationContractReceipt`'s `contracts`
 * object, so a release can be compared with a publication receipt without a
 * translation table.
 */
export const editorialSchemaVersionsSchema = z
  .object({
    publicationGraph: z.string().min(1).max(32),
    assetBundle: z.string().min(1).max(32),
    compositionContext: z.string().min(1).max(32),
    transformationPolicy: z.string().min(1).max(32),
    sourceAdapter: z.string().min(1).max(32),
    targetProfile: z.string().min(1).max(32),
  })
  .strict()
export type EditorialSchemaVersions = z.infer<
  typeof editorialSchemaVersionsSchema
>

/**
 * The rendering configuration a revision is cut against and a release
 * publishes under: which renderer, at which version, for which profiles, and
 * under which output policy versions.
 */
export const editorialRenderingSchema = z
  .object({
    rendererId: z.string().min(1).max(64),
    rendererVersion: z.string().min(1).max(64),
    profileIds: z.array(z.string().min(1).max(64)).min(1).max(16),
    policyVersions: z
      .object({
        renderer: z.string().min(1).max(32),
        semanticHtml: z.string().min(1).max(32),
        accessibility: z.string().min(1).max(32),
        transformationPolicy: z.string().min(1).max(32),
        publicationCheck: z.string().min(1).max(32),
      })
      .strict(),
  })
  .strict()
export type EditorialRendering = z.infer<typeof editorialRenderingSchema>

/* ---------------------------------------------------------------- artifacts */

/** One published artifact and the exact bytes of it. */
export const editorialArtifactSchema = z
  .object({
    path: z.string().min(1).max(512),
    sha256: sha256Schema,
    byteLength: z.number().int().nonnegative(),
    profile: z.string().min(1).max(64),
    renderer: z.string().min(1).max(64),
  })
  .strict()
export type EditorialArtifact = z.infer<typeof editorialArtifactSchema>

/* ------------------------------------------------------------------ targets */

/**
 * The mandatory checks. Every release needs all four; a target policy may
 * add more but may never drop one.
 */
export const EDITORIAL_VALIDATION_CHECKS = [
  'bundle-verification',
  'epubcheck',
  'ace',
  'human-review',
] as const
export type EditorialValidationCheck =
  (typeof EDITORIAL_VALIDATION_CHECKS)[number]

/** The checks no release may be published without. */
export const MANDATORY_VALIDATION_CHECKS: readonly EditorialValidationCheck[] =
  EDITORIAL_VALIDATION_CHECKS

/**
 * A target: the audience, channel and environment a release is published to.
 *
 * This is the *editorial* target — where a release goes — and it is not the
 * rendering `TargetProfile` of `src/research/targets.ts`, which says how a
 * page is laid out. The two are separate concerns and separate modules.
 */
export const editorialTargetSchema = z
  .object({
    version: z.literal(EDITORIAL_TARGET_VERSION),
    id: slugSchema,
    audience: z.enum(['public', 'members', 'subscribers', 'internal']),
    channel: z.enum(['web', 'epub', 'pdf', 'print', 'email']),
    environment: z.enum(['production', 'staging', 'preview']),
    route: z.string().min(1).max(256),
    policy: z
      .object({
        requiredValidationChecks: z
          .array(z.enum(EDITORIAL_VALIDATION_CHECKS))
          .min(1)
          .max(16),
        requireHumanReview: z.literal(true),
        requireAuthenticatedApproval: z.literal(true),
        maxApprovalAgeSeconds: z.number().int().positive().max(31_536_000),
      })
      .strict(),
  })
  .strict()
export type EditorialTarget = z.infer<typeof editorialTargetSchema>

/* ------------------------------------------------------------- record ids */

export const editorialRevisionIdSchema = z
  .string()
  .regex(/^urn:editorial:revision:[a-f0-9]{64}$/)
export const editorialDecisionIdSchema = z
  .string()
  .regex(/^urn:editorial:decision:[a-f0-9]{64}$/)
export const editorialCandidateIdSchema = z
  .string()
  .regex(/^urn:editorial:candidate:[a-f0-9]{64}$/)
export const editorialValidationIdSchema = z
  .string()
  .regex(/^urn:editorial:validation:[a-f0-9]{64}$/)
export const editorialApprovalIdSchema = z
  .string()
  .regex(/^urn:editorial:approval:[a-f0-9]{64}$/)
export const editorialReleaseIdSchema = z
  .string()
  .regex(/^urn:editorial:release:[a-f0-9]{64}$/)
export const editorialSupersessionIdSchema = z
  .string()
  .regex(/^urn:editorial:supersession:[a-f0-9]{64}$/)

/* ----------------------------------------------------------------- subjects */

/**
 * The digests a decision binds: the exact revision and the exact content.
 *
 * A decision about a different content hash is a decision about a different
 * thing, and this is the shape that says so.
 */
export const editorialRevisionSubjectSchema = z
  .object({
    revisionId: editorialRevisionIdSchema,
    contentHash: sha256Schema,
    documentSha256: sha256Schema,
    bundleSha256: sha256Schema.optional(),
  })
  .strict()
export type EditorialRevisionSubject = z.infer<
  typeof editorialRevisionSubjectSchema
>

/**
 * The digests a validation or an approval binds: the exact candidate, and
 * through it the exact revision, content, target and artifact bytes.
 */
export const editorialCandidateSubjectSchema = z
  .object({
    candidateId: editorialCandidateIdSchema,
    revisionId: editorialRevisionIdSchema,
    contentHash: sha256Schema,
    documentSha256: sha256Schema,
    bundleSha256: sha256Schema.optional(),
    targetId: slugSchema,
    artifactSetSha256: sha256Schema,
  })
  .strict()
export type EditorialCandidateSubject = z.infer<
  typeof editorialCandidateSubjectSchema
>

/* --------------------------------------------------------------- references */

/** A durable reference to a validation record. */
export const editorialValidationRefSchema = z
  .object({
    id: editorialValidationIdSchema,
    sha256: sha256Schema,
  })
  .strict()
export type EditorialValidationRef = z.infer<
  typeof editorialValidationRefSchema
>

/** A durable reference to an approval record. */
export const editorialApprovalRefSchema = z
  .object({
    id: editorialApprovalIdSchema,
    sha256: sha256Schema,
  })
  .strict()
export type EditorialApprovalRef = z.infer<typeof editorialApprovalRefSchema>

/* ----------------------------------------------------------------- records */

/**
 * The immutable content revision.
 *
 * It binds the exact document digests, the package pin that produced them,
 * the renderer and profiles the content is cut against, the schema versions
 * in force, and the content hash that every later decision refers to.
 */
export const editorialRevisionSchema = z
  .object({
    kind: z.literal('revision'),
    version: z.literal(EDITORIAL_REVISION_VERSION),
    id: editorialRevisionIdSchema,
    contentHash: sha256Schema,
    documentSha256: sha256Schema,
    bundleSha256: sha256Schema.optional(),
    semanticReceiptSha256: sha256Schema.optional(),
    sourceBinding: editorialSourceBindingSchema,
    schemaVersions: editorialSchemaVersionsSchema,
    rendering: editorialRenderingSchema,
    author: editorialActorSchema,
    created: timestampSchema,
  })
  .strict()
export type EditorialRevision = z.infer<typeof editorialRevisionSchema>

/** The outcomes a review decision can have. */
export const EDITORIAL_DECISION_OUTCOMES = [
  'approved',
  'rejected',
  'changes-requested',
] as const
export type EditorialDecisionOutcome =
  (typeof EDITORIAL_DECISION_OUTCOMES)[number]

/**
 * A review decision.
 *
 * It binds the exact revision *and* the exact content hash, so a decision
 * taken about one cut of the content cannot authorize a later, different cut.
 */
export const editorialDecisionSchema = z
  .object({
    kind: z.literal('decision'),
    version: z.literal(EDITORIAL_DECISION_VERSION),
    id: editorialDecisionIdSchema,
    subject: editorialRevisionSubjectSchema,
    outcome: z.enum(EDITORIAL_DECISION_OUTCOMES),
    actor: editorialActorSchema,
    rationale: z.string().max(4096).optional(),
    decidedAt: timestampSchema,
  })
  .strict()
export type EditorialDecision = z.infer<typeof editorialDecisionSchema>

/**
 * The release candidate: what would be published if it were released.
 *
 * It is assembled from exactly one approved revision and it fixes the target
 * and the artifact bytes, so everything after it is bound to it.
 */
export const editorialCandidateSchema = z
  .object({
    kind: z.literal('candidate'),
    version: z.literal(EDITORIAL_CANDIDATE_VERSION),
    id: editorialCandidateIdSchema,
    revisionId: editorialRevisionIdSchema,
    contentHash: sha256Schema,
    documentSha256: sha256Schema,
    bundleSha256: sha256Schema.optional(),
    target: editorialTargetSchema,
    artifacts: z.array(editorialArtifactSchema).min(1).max(64),
    artifactSetSha256: sha256Schema,
    requiredValidationChecks: z.array(z.enum(EDITORIAL_VALIDATION_CHECKS)).min(1).max(16),
    author: editorialActorSchema,
    created: timestampSchema,
  })
  .strict()
export type EditorialCandidate = z.infer<typeof editorialCandidateSchema>

/** The outcomes a validation can have. */
export const EDITORIAL_VALIDATION_OUTCOMES = ['passed', 'failed'] as const
export type EditorialValidationOutcome =
  (typeof EDITORIAL_VALIDATION_OUTCOMES)[number]

/**
 * One validation, with the exact digests it was run against.
 *
 * A validation of different digests is a validation of a different thing and
 * does not satisfy the candidate it is offered for.
 */
export const editorialValidationSchema = z
  .object({
    kind: z.literal('validation'),
    version: z.literal(EDITORIAL_VALIDATION_VERSION),
    id: editorialValidationIdSchema,
    check: z.enum(EDITORIAL_VALIDATION_CHECKS),
    subject: editorialCandidateSubjectSchema,
    outcome: z.enum(EDITORIAL_VALIDATION_OUTCOMES),
    evidence: z
      .object({
        tool: z.string().min(1).max(128),
        toolVersion: z.string().min(1).max(64),
        reportSha256: sha256Schema.optional(),
        detail: z.string().max(4096).optional(),
      })
      .strict(),
    actor: editorialActorSchema,
    validatedAt: timestampSchema,
  })
  .strict()
export type EditorialValidation = z.infer<typeof editorialValidationSchema>

/**
 * The authenticated approval that authorizes a candidate for release.
 *
 * It binds the candidate's digests, so an approval cannot be carried over to
 * a candidate with different artifacts.
 */
export const editorialApprovalSchema = z
  .object({
    kind: z.literal('approval'),
    version: z.literal(EDITORIAL_APPROVAL_VERSION),
    id: editorialApprovalIdSchema,
    candidateId: editorialCandidateIdSchema,
    subject: editorialCandidateSubjectSchema,
    actor: editorialActorSchema,
    approvedAt: timestampSchema,
  })
  .strict()
export type EditorialApproval = z.infer<typeof editorialApprovalSchema>

/**
 * The release: the record of what was published.
 *
 * It binds the exact package pin and source binding, the exact schema
 * versions, the exact bundle and document digests, the exact renderer and
 * profiles, the exact validations, the exact approval, the exact target and
 * the exact artifact bytes. Nothing downstream may substitute anything.
 */
export const editorialReleaseSchema = z
  .object({
    kind: z.literal('release'),
    version: z.literal(EDITORIAL_RELEASE_VERSION),
    id: editorialReleaseIdSchema,
    candidateId: editorialCandidateIdSchema,
    revisionId: editorialRevisionIdSchema,
    contentHash: sha256Schema,
    sourceBinding: editorialSourceBindingSchema,
    schemaVersions: editorialSchemaVersionsSchema,
    rendering: editorialRenderingSchema,
    validations: z.array(editorialValidationRefSchema).min(1).max(16),
    approval: editorialApprovalRefSchema,
    target: editorialTargetSchema,
    artifacts: z.array(editorialArtifactSchema).min(1).max(64),
    artifactSetSha256: sha256Schema,
    producer: editorialProducerActorSchema,
    releasedAt: timestampSchema,
  })
  .strict()
export type EditorialRelease = z.infer<typeof editorialReleaseSchema>

/** The reasons a release can be retired. */
export const EDITORIAL_SUPERSESSION_REASONS = [
  'replacement',
  'correction',
  'withdrawn',
  'revocation',
] as const
export type EditorialSupersessionReason =
  (typeof EDITORIAL_SUPERSESSION_REASONS)[number]

/**
 * The record that retires a release.
 *
 * A release is never edited to say it is old. The supersession says it, and
 * the release becomes non-current by being named here. `supersedingReleaseId`
 * is `null` when the release is withdrawn without a replacement.
 */
export const editorialSupersessionSchema = z
  .object({
    kind: z.literal('supersession'),
    version: z.literal(EDITORIAL_SUPERSESSION_VERSION),
    id: editorialSupersessionIdSchema,
    subjectReleaseId: editorialReleaseIdSchema,
    supersedingReleaseId: editorialReleaseIdSchema.nullable(),
    reason: z.enum(EDITORIAL_SUPERSESSION_REASONS),
    actor: editorialActorSchema,
    at: timestampSchema,
  })
  .strict()
export type EditorialSupersession = z.infer<typeof editorialSupersessionSchema>

/* ------------------------------------------------------------------ unions */

/** Any editorial record. */
export const editorialRecordSchema = z.discriminatedUnion('kind', [
  editorialRevisionSchema,
  editorialDecisionSchema,
  editorialCandidateSchema,
  editorialValidationSchema,
  editorialApprovalSchema,
  editorialReleaseSchema,
  editorialSupersessionSchema,
])
export type EditorialRecord = z.infer<typeof editorialRecordSchema>

/* ------------------------------------------------------------- derivations */

/** The content hash a revision's digests imply. */
export function revisionContentHash(
  revision: Pick<
    EditorialRevision,
    'documentSha256' | 'bundleSha256' | 'semanticReceiptSha256'
  >,
): string {
  return editorialContentDigest({
    documentSha256: revision.documentSha256,
    bundleSha256: revision.bundleSha256,
    semanticReceiptSha256: revision.semanticReceiptSha256,
  })
}

/** The artifact-set digest a candidate's artifacts imply. */
export function candidateArtifactSetHash(
  candidate: Pick<EditorialCandidate, 'artifacts'>,
): string {
  return editorialArtifactSetDigest(candidate.artifacts)
}
