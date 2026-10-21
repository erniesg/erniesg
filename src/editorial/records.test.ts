import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  EDITORIAL_RECORD_KINDS,
  EDITORIAL_SOURCE_BINDING_FIELDS,
  editorialApprovalSchema,
  editorialCandidateSchema,
  editorialDecisionSchema,
  editorialRecordSchema,
  editorialReleaseSchema,
  editorialRevisionSchema,
  editorialSourceBindingSchema,
  editorialSupersessionSchema,
  editorialTargetSchema,
  editorialValidationSchema,
  MANDATORY_VALIDATION_CHECKS,
} from './records'
import {
  ARTIFACTS,
  DOCUMENT_SHA256,
  OTHER_DOCUMENT_SHA256,
  approvalFixture,
  candidateFixture,
  decisionFixture,
  releaseFixture,
  revisionFixture,
  supersessionFixture,
  targetFixture,
  validationFixture,
} from './fixtures'

describe('editorial record schemas', () => {
  it('accepts every record kind', () => {
    const revision = revisionFixture()
    const decision = decisionFixture(revision)
    const candidate = candidateFixture(revision)
    const validation = validationFixture(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, [validation], approval)
    const supersession = supersessionFixture(release)

    expect(editorialRevisionSchema.safeParse(revision).success).toBe(true)
    expect(editorialDecisionSchema.safeParse(decision).success).toBe(true)
    expect(editorialCandidateSchema.safeParse(candidate).success).toBe(true)
    expect(editorialValidationSchema.safeParse(validation).success).toBe(true)
    expect(editorialApprovalSchema.safeParse(approval).success).toBe(true)
    expect(editorialReleaseSchema.safeParse(release).success).toBe(true)
    expect(editorialSupersessionSchema.safeParse(supersession).success).toBe(true)

    expect(EDITORIAL_RECORD_KINDS).toEqual([
      'revision',
      'decision',
      'candidate',
      'validation',
      'approval',
      'release',
      'supersession',
    ])
  })

  it('reads every record kind through one union', () => {
    const revision = revisionFixture()

    expect(editorialRecordSchema.safeParse(revision).success).toBe(true)
    expect(
      editorialRecordSchema.safeParse(decisionFixture(revision)).success,
    ).toBe(true)
    expect(
      editorialRecordSchema.safeParse(
        supersessionFixture(
          releaseFixture(
            revision,
            candidateFixture(revision),
            [validationFixture(candidateFixture(revision))],
            approvalFixture(candidateFixture(revision)),
          ),
        ),
      ).success,
    ).toBe(true)
  })

  it('refuses an unknown field on any record', () => {
    const revision = revisionFixture()

    expect(
      editorialRevisionSchema.safeParse({ ...revision, extra: true }).success,
    ).toBe(false)
    expect(
      editorialDecisionSchema.safeParse({
        ...decisionFixture(revision),
        extra: true,
      }).success,
    ).toBe(false)
  })

  it('refuses a record whose id is not a well-formed editorial id', () => {
    const revision = revisionFixture()

    expect(
      editorialRevisionSchema.safeParse({
        ...revision,
        id: 'urn:editorial:revision:not-a-digest',
      }).success,
    ).toBe(false)
  })

  it('pins the source binding field list in one shared constant', () => {
    expect(Object.keys(editorialSourceBindingSchema.shape)).toEqual([
      ...EDITORIAL_SOURCE_BINDING_FIELDS,
    ])
  })

  it('pins the shared source binding field list itself', () => {
    expect([...EDITORIAL_SOURCE_BINDING_FIELDS]).toEqual([
      'kind',
      'documentSha256',
      'bundleSha256',
      'semanticReceiptSha256',
      'packageSourceCommit',
      'packageArtifact',
      'packageArtifactSha256',
      'packageIntegrity',
      'packageVersion',
    ])
  })

  it('refuses a source binding that names a different document', () => {
    const revision = revisionFixture()

    expect(
      editorialRevisionSchema.safeParse({
        ...revision,
        sourceBinding: {
          ...revision.sourceBinding,
          documentSha256: OTHER_DOCUMENT_SHA256,
        },
      }).success,
    ).toBe(false)
  })

  it('refuses a source binding that names a different bundle', () => {
    const revision = revisionFixture()

    expect(
      editorialRevisionSchema.safeParse({
        ...revision,
        sourceBinding: {
          ...revision.sourceBinding,
          bundleSha256: OTHER_DOCUMENT_SHA256,
        },
      }).success,
    ).toBe(false)
  })

  it('refuses a revision whose content hash is not the hash of its digests', () => {
    const revision = revisionFixture()

    expect(
      editorialRevisionSchema.safeParse({
        ...revision,
        contentHash: OTHER_DOCUMENT_SHA256,
      }).success,
    ).toBe(false)
  })

  it('refuses a revision whose author is not an editor', () => {
    const revision = revisionFixture()

    expect(
      editorialRevisionSchema.safeParse({
        ...revision,
        author: { ...revision.author, kind: 'reviewer' },
      }).success,
    ).toBe(false)
  })

  it('refuses a candidate whose artifact digest is not the digest of its artifacts', () => {
    const candidate = candidateFixture(revisionFixture())

    expect(
      editorialCandidateSchema.safeParse({
        ...candidate,
        artifactSetSha256: OTHER_DOCUMENT_SHA256,
      }).success,
    ).toBe(false)
  })

  it('refuses a candidate that drops a mandatory check', () => {
    const candidate = candidateFixture(revisionFixture())

    expect(
      editorialCandidateSchema.safeParse({
        ...candidate,
        requiredValidationChecks: ['bundle-verification', 'epubcheck'],
      }).success,
    ).toBe(false)
  })

  it('refuses a target policy that drops a mandatory check', () => {
    const target = targetFixture()

    expect(
      editorialTargetSchema.safeParse({
        ...target,
        policy: {
          ...target.policy,
          requiredValidationChecks: ['bundle-verification', 'epubcheck'],
        },
      }).success,
    ).toBe(false)
  })

  it('refuses a target policy that turns human review off', () => {
    const target = targetFixture()

    expect(
      editorialTargetSchema.safeParse({
        ...target,
        policy: { ...target.policy, requireHumanReview: false },
      }).success,
    ).toBe(false)
  })

  it('refuses a target policy that turns authenticated approval off', () => {
    const target = targetFixture()

    expect(
      editorialTargetSchema.safeParse({
        ...target,
        policy: { ...target.policy, requireAuthenticatedApproval: false },
      }).success,
    ).toBe(false)
  })

  it('names every mandatory check', () => {
    expect([...MANDATORY_VALIDATION_CHECKS]).toEqual([
      'bundle-verification',
      'epubcheck',
      'ace',
      'human-review',
    ])
  })

  it('binds a release to every digest it publishes', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validation = validationFixture(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, [validation], approval)

    expect(release.sourceBinding.documentSha256).toBe(DOCUMENT_SHA256)
    expect(release.sourceBinding.packageArtifactSha256).toBe(
      revision.sourceBinding.packageArtifactSha256,
    )
    expect(release.schemaVersions).toEqual(revision.schemaVersions)
    expect(release.rendering).toEqual(revision.rendering)
    expect(release.target).toEqual(candidate.target)
    expect(release.artifacts).toEqual(candidate.artifacts)
    expect(release.artifactSetSha256).toBe(candidate.artifactSetSha256)
    expect(release.validations).toHaveLength(1)
    expect(release.approval.id).toBe(approval.id)
  })

  it('refuses a release that binds artifacts the candidate does not have', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validation = validationFixture(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, [validation], approval, {
      artifacts: [{ ...ARTIFACTS[0], sha256: 'b'.repeat(64) }, ARTIFACTS[1]],
    })

    expect(editorialReleaseSchema.safeParse(release).success).toBe(false)
  })

  it('refuses a release with no validations bound', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validation = validationFixture(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, [validation], approval)

    expect(
      editorialReleaseSchema.safeParse({ ...release, validations: [] }).success,
    ).toBe(false)
  })

  it('refuses a supersession that names no release', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validation = validationFixture(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, [validation], approval)

    expect(
      editorialSupersessionSchema.safeParse({
        ...supersessionFixture(release),
        subjectReleaseId: 'urn:editorial:release:not-a-digest',
      }).success,
    ).toBe(false)
  })

  /**
   * The sources of the contract stay text.
   *
   * A raw NUL byte in a source file makes the file register as binary data,
   * and a recursive grep over the tree then skips it silently: the file that
   * defines the whole record contract would be the one file a reader could
   * not find. The separators are therefore written as escapes.
   */
  it('keeps every editorial source free of raw NUL bytes', () => {
    const directory = fileURLToPath(new URL('.', import.meta.url))

    for (const name of readdirSync(directory).sort()) {
      const source = readFileSync(`${directory}/${name}`, 'utf8')
      expect(
        source.includes('\u0000'),
        `${name} carries a raw NUL byte`,
      ).toBe(false)
    }
  })
})
