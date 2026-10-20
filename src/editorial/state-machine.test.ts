import { describe, expect, it } from 'vitest'

import {
  applyTransition,
  EDITORIAL_TRANSITIONS,
  type EditorialRefusalCode,
  type TransitionOutcome,
} from './state-machine'
import {
  LATER,
  MUCH_LATER,
  OTHER_DOCUMENT_SHA256,
  REVIEWER,
  approvalFixture,
  candidateFixture,
  candidateSubjectOf,
  decisionFixture,
  releaseFixture,
  revisionFixture,
  supersessionFixture,
  validationFixture,
} from './fixtures'
import { editorialArtifactSetDigest } from './ids'
import type {
  EditorialCandidate,
  EditorialDecision,
  EditorialRevision,
  EditorialValidation,
} from './records'

const NOW = '2026-10-20T11:00:00.000Z'

function expectRefusal(
  outcome: TransitionOutcome,
  code: EditorialRefusalCode,
): void {
  if (outcome.ok) {
    throw new Error(
      `expected the refusal "${code}", got an allowed transition to ${outcome.to}`,
    )
  }
  expect(outcome.refusal.code).toBe(code)
}

function validationSet(candidate: EditorialCandidate): EditorialValidation[] {
  return [
    validationFixture(candidate, { check: 'bundle-verification' }),
    validationFixture(candidate, { check: 'epubcheck' }),
    validationFixture(candidate, { check: 'ace' }),
    validationFixture(candidate, { check: 'human-review', actor: REVIEWER }),
  ]
}

describe('the editorial state machine', () => {
  it('publishes one pipeline from a revision to a superseded release', () => {
    const revision = revisionFixture()
    const proposed = applyTransition({
      action: 'propose-revision',
      actor: revision.author,
      now: NOW,
      revision,
    })
    expect(proposed.ok).toBe(true)
    if (proposed.ok) expect(proposed.to).toBe('revision-proposed')

    const decision = decisionFixture(revision)
    const decided = applyTransition({
      action: 'record-decision',
      actor: decision.actor,
      now: NOW,
      revision,
      decision,
      decisions: [],
    })
    expect(decided.ok).toBe(true)
    if (decided.ok) expect(decided.to).toBe('revision-approved')

    const candidate = candidateFixture(revision)
    const assembled = applyTransition({
      action: 'assemble-candidate',
      actor: candidate.author,
      now: NOW,
      revision,
      candidate,
      decisions: [decision],
    })
    expect(assembled.ok).toBe(true)
    if (assembled.ok) expect(assembled.to).toBe('candidate-assembled')

    const validations = validationSet(candidate)
    let validationsState = ''
    for (const validation of validations) {
      const outcome = applyTransition({
        action: 'record-validation',
        actor: validation.actor,
        now: NOW,
        candidate,
        validation,
        validations: validations.filter((other) => other.id !== validation.id),
        approvals: [],
        releases: [],
      })
      expect(outcome.ok).toBe(true)
      if (outcome.ok) validationsState = outcome.to
    }
    expect(validationsState).toBe('candidate-validated')

    const approval = approvalFixture(candidate)
    const approved = applyTransition({
      action: 'record-approval',
      actor: approval.actor,
      now: NOW,
      candidate,
      approval,
      validations,
      approvals: [],
    })
    expect(approved.ok).toBe(true)
    if (approved.ok) expect(approved.to).toBe('candidate-approved-for-release')

    const release = releaseFixture(revision, candidate, validations, approval)
    const released = applyTransition({
      action: 'record-release',
      actor: release.producer,
      now: NOW,
      revision,
      candidate,
      release,
      validations,
      approvals: [approval],
      releases: [],
      supersessions: [],
    })
    expect(released.ok).toBe(true)
    if (released.ok) expect(released.to).toBe('release-released')

    const supersession = supersessionFixture(release)
    const superseded = applyTransition({
      action: 'supersede-release',
      actor: supersession.actor,
      now: NOW,
      release,
      supersession,
      releases: [release],
      supersessions: [],
    })
    expect(superseded.ok).toBe(true)
    if (superseded.ok) expect(superseded.to).toBe('release-superseded')
  })

  it('names one rule per action', () => {
    expect(EDITORIAL_TRANSITIONS.map((rule) => rule.action)).toEqual([
      'propose-revision',
      'record-decision',
      'assemble-candidate',
      'record-validation',
      'record-approval',
      'record-release',
      'supersede-release',
    ])
  })

  it('refuses a decision made by an editor', () => {
    const revision = revisionFixture()
    const decision = decisionFixture(revision, { actor: revision.author })

    const outcome = applyTransition({
      action: 'record-decision',
      actor: decision.actor,
      now: NOW,
      revision,
      decision,
      decisions: [],
    })

    expectRefusal(outcome, 'actor_not_permitted')
  })

  it('refuses a release written by an approver', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = validationSet(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, validations, approval)

    const outcome = applyTransition({
      action: 'record-release',
      actor: approval.actor,
      now: NOW,
      revision,
      candidate,
      release,
      validations,
      approvals: [approval],
      releases: [],
      supersessions: [],
    })

    expectRefusal(outcome, 'actor_not_permitted')
  })

  it('refuses a human review recorded by a tool', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validation = validationFixture(candidate, { check: 'human-review' })

    const outcome = applyTransition({
      action: 'record-validation',
      actor: validation.actor,
      now: NOW,
      candidate,
      validation,
      validations: [],
      approvals: [],
      releases: [],
    })

    expectRefusal(outcome, 'actor_not_permitted')
  })

  it('refuses a candidate assembled from an unapproved revision', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)

    const outcome = applyTransition({
      action: 'assemble-candidate',
      actor: candidate.author,
      now: NOW,
      revision,
      candidate,
      decisions: [],
    })

    expectRefusal(outcome, 'revision_not_approved')
  })

  it('refuses a candidate assembled from a rejected revision', () => {
    const revision = revisionFixture()
    const decision = decisionFixture(revision, { outcome: 'rejected' })
    const candidate = candidateFixture(revision)

    const outcome = applyTransition({
      action: 'assemble-candidate',
      actor: candidate.author,
      now: NOW,
      revision,
      candidate,
      decisions: [decision],
    })

    expectRefusal(outcome, 'revision_not_approved')
  })

  it('refuses a candidate authorized by a stale decision', () => {
    const revision = revisionFixture()
    const stale = decisionFixture(revision, { contentHash: OTHER_DOCUMENT_SHA256 })
    const candidate = candidateFixture(revision)

    const outcome = applyTransition({
      action: 'assemble-candidate',
      actor: candidate.author,
      now: NOW,
      revision,
      candidate,
      decisions: [stale],
    })

    expectRefusal(outcome, 'stale_decision')
  })

  it('refuses a second decision on a decided revision', () => {
    const revision = revisionFixture()
    const first = decisionFixture(revision)
    const second = decisionFixture(revision, { outcome: 'rejected' })

    const outcome = applyTransition({
      action: 'record-decision',
      actor: second.actor,
      now: NOW,
      revision,
      decision: second,
      decisions: [first],
    })

    expectRefusal(outcome, 'wrong_state')
  })

  it('refuses a validation of different artifact digests', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validation = validationFixture(candidate, {
      subject: {
        ...candidateSubjectOf(candidate),
        artifactSetSha256: OTHER_DOCUMENT_SHA256,
      },
    })

    const outcome = applyTransition({
      action: 'record-validation',
      actor: validation.actor,
      now: NOW,
      candidate,
      validation,
      validations: [],
      approvals: [],
      releases: [],
    })

    expectRefusal(outcome, 'digest_mismatch')
  })

  it('refuses an approval of a different candidate', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = validationSet(candidate)
    const approval = approvalFixture(candidate, {
      subject: {
        ...candidateSubjectOf(candidate),
        artifactSetSha256: OTHER_DOCUMENT_SHA256,
      },
    })

    const outcome = applyTransition({
      action: 'record-approval',
      actor: approval.actor,
      now: NOW,
      candidate,
      approval,
      validations,
      approvals: [],
    })

    expectRefusal(outcome, 'digest_mismatch')
  })

  it('refuses an approval while a mandatory validation is missing', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const partial = validationSet(candidate).slice(0, 2)
    const approval = approvalFixture(candidate)

    const outcome = applyTransition({
      action: 'record-approval',
      actor: approval.actor,
      now: NOW,
      candidate,
      approval,
      validations: partial,
      approvals: [],
    })

    expectRefusal(outcome, 'mandatory_validation_missing')
  })

  it('refuses a release that leaves out a mandatory validation', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = validationSet(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(
      revision,
      candidate,
      validations.slice(0, 3),
      approval,
    )

    const outcome = applyTransition({
      action: 'record-release',
      actor: release.producer,
      now: NOW,
      revision,
      candidate,
      release,
      validations,
      approvals: [approval],
      releases: [],
      supersessions: [],
    })

    expectRefusal(outcome, 'mandatory_validation_missing')
  })

  it('refuses a release whose human review failed', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = validationSet(candidate)
    const failed = validationFixture(candidate, {
      check: 'human-review',
      outcome: 'failed',
      actor: REVIEWER,
    })
    const approval = approvalFixture(candidate)
    const release = releaseFixture(
      revision,
      candidate,
      validations.map((validation) =>
        validation.check === 'human-review' ? failed : validation,
      ),
      approval,
    )

    const outcome = applyTransition({
      action: 'record-release',
      actor: release.producer,
      now: NOW,
      revision,
      candidate,
      release,
      validations: validations.map((validation) =>
        validation.check === 'human-review' ? failed : validation,
      ),
      approvals: [approval],
      releases: [],
      supersessions: [],
    })

    expectRefusal(outcome, 'validation_not_passed')
  })

  it('refuses a release with no approval behind it', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = validationSet(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, validations, approval, {
      approvalRef: {
        id: `urn:editorial:approval:${'a'.repeat(64)}`,
        sha256: 'b'.repeat(64),
      },
    })

    const outcome = applyTransition({
      action: 'record-release',
      actor: release.producer,
      now: NOW,
      revision,
      candidate,
      release,
      validations,
      approvals: [approval],
      releases: [],
      supersessions: [],
    })

    expectRefusal(outcome, 'approval_missing')
  })

  it('refuses a release whose artifacts are not the candidate artifacts', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = validationSet(candidate)
    const approval = approvalFixture(candidate)
    const swapped = [
      { ...candidate.artifacts[0], sha256: 'e'.repeat(64) },
      candidate.artifacts[1],
    ]
    const release = releaseFixture(revision, candidate, validations, approval, {
      artifacts: swapped,
      artifactSetSha256: editorialArtifactSetDigest(swapped),
    })

    const outcome = applyTransition({
      action: 'record-release',
      actor: release.producer,
      now: NOW,
      revision,
      candidate,
      release,
      validations,
      approvals: [approval],
      releases: [],
      supersessions: [],
    })

    expectRefusal(outcome, 'digest_mismatch')
  })

  it('refuses a release whose source binding is not the revision binding', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = validationSet(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, validations, approval, {
      sourceBinding: {
        ...revision.sourceBinding,
        packageArtifactSha256: 'f'.repeat(64),
      },
    })

    const outcome = applyTransition({
      action: 'record-release',
      actor: release.producer,
      now: NOW,
      revision,
      candidate,
      release,
      validations,
      approvals: [approval],
      releases: [],
      supersessions: [],
    })

    expectRefusal(outcome, 'digest_mismatch')
  })

  it('refuses a release whose approval has expired', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = validationSet(candidate)
    const approval = approvalFixture(candidate, { approvedAt: LATER })
    const release = releaseFixture(revision, candidate, validations, approval)

    const outcome = applyTransition({
      action: 'record-release',
      actor: release.producer,
      now: MUCH_LATER,
      revision,
      candidate,
      release,
      validations,
      approvals: [approval],
      releases: [],
      supersessions: [],
    })

    expectRefusal(outcome, 'target_policy_not_satisfied')
  })

  it('refuses a second current release for one target', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = validationSet(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, validations, approval)

    const otherRevision = revisionFixture({ documentSha256: OTHER_DOCUMENT_SHA256 })
    const otherCandidate = candidateFixture(otherRevision)
    const otherValidations = validationSet(otherCandidate)
    const otherApproval = approvalFixture(otherCandidate)
    const otherRelease = releaseFixture(
      otherRevision,
      otherCandidate,
      otherValidations,
      otherApproval,
    )

    const outcome = applyTransition({
      action: 'record-release',
      actor: otherRelease.producer,
      now: NOW,
      revision: otherRevision,
      candidate: otherCandidate,
      release: otherRelease,
      validations: otherValidations,
      approvals: [otherApproval],
      releases: [release],
      supersessions: [],
    })

    expectRefusal(outcome, 'target_already_released')
  })

  it('refuses to supersede a release that is already superseded', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = validationSet(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, validations, approval)
    const first = supersessionFixture(release)
    const second = supersessionFixture(release, { reason: 'correction' })

    const outcome = applyTransition({
      action: 'supersede-release',
      actor: second.actor,
      now: NOW,
      release,
      supersession: second,
      releases: [release],
      supersessions: [first],
    })

    expectRefusal(outcome, 'release_not_current')
  })

  it('refuses a record whose id is not derived from its content', () => {
    const revision = revisionFixture()
    const forged: EditorialRevision = {
      ...revision,
      id: `urn:editorial:revision:${'0'.repeat(64)}`,
    }

    const outcome = applyTransition({
      action: 'propose-revision',
      actor: revision.author,
      now: NOW,
      revision: forged,
    })

    expectRefusal(outcome, 'record_id_mismatch')
  })

  it('refuses a record that is not of the kind the action appends', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const decision = decisionFixture(revision)

    const outcome = applyTransition({
      action: 'record-decision',
      actor: decision.actor,
      now: NOW,
      revision,
      decision: candidate as unknown as EditorialDecision,
      decisions: [],
    })

    expectRefusal(outcome, 'record_kind_mismatch')
  })

  it('refuses a record that does not satisfy its own schema', () => {
    const revision = revisionFixture()
    const malformed = {
      ...revision,
      unexpected: 'field',
    } as unknown as EditorialRevision

    const outcome = applyTransition({
      action: 'propose-revision',
      actor: revision.author,
      now: NOW,
      revision: malformed,
    })

    expectRefusal(outcome, 'record_schema_invalid')
  })

  it('refuses a record written in the future', () => {
    const revision = revisionFixture({ created: MUCH_LATER })

    const outcome = applyTransition({
      action: 'propose-revision',
      actor: revision.author,
      now: NOW,
      revision,
    })

    expectRefusal(outcome, 'record_timestamp_in_future')
  })

  it('refuses a validation of a candidate that was already released', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = validationSet(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, validations, approval)
    const late = validationFixture(candidate, { check: 'epubcheck' })

    const outcome = applyTransition({
      action: 'record-validation',
      actor: late.actor,
      now: MUCH_LATER,
      candidate,
      validation: late,
      validations: [...validations, late],
      approvals: [approval],
      releases: [release],
    })

    expectRefusal(outcome, 'wrong_state')
  })

  it('refuses a release of a candidate that was never approved', () => {
    const revision = revisionFixture()
    const decision = decisionFixture(revision)
    const candidate = candidateFixture(revision)
    const validations = validationSet(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, validations, approval)

    const outcome = applyTransition({
      action: 'record-release',
      actor: release.producer,
      now: NOW,
      revision,
      candidate,
      release,
      validations,
      approvals: [],
      releases: [],
      supersessions: [],
    })

    expectRefusal(outcome, 'wrong_state')
  })

  it('refuses a release whose candidate names another revision', () => {
    const revision = revisionFixture()
    const otherRevision = revisionFixture({
      documentSha256: OTHER_DOCUMENT_SHA256,
    })
    const candidate = candidateFixture(revision)
    const validations = validationSet(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, validations, approval)
    const mismatched = releaseFixture(
      revision,
      candidate,
      validations,
      approval,
      { revisionId: otherRevision.id },
    )

    const outcome = applyTransition({
      action: 'record-release',
      actor: release.producer,
      now: NOW,
      revision,
      candidate,
      release: mismatched,
      validations,
      approvals: [approval],
      releases: [],
      supersessions: [],
    })

    expectRefusal(outcome, 'digest_mismatch')
  })
})
