import { describe, expect, it } from 'vitest'

import {
  approvalIsFresh,
  approvalSatisfiesCandidate,
  approvingDecisionFor,
  currentReleaseForTarget,
  decisionAuthorizesCandidate,
  decisionAuthorizesRevision,
  mandatoryValidationStatus,
  projectCandidateState,
  projectReleaseState,
  projectRevisionState,
  releaseIsCurrent,
  revisionIsApproved,
  targetPolicyIsSatisfied,
  validationSatisfiesCandidate,
} from './validation'
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
  targetFixture,
  validationFixture,
} from './fixtures'

describe('editorial cross-record rules', () => {
  it('lets a decision authorize exactly the revision it names', () => {
    const revision = revisionFixture()
    const decision = decisionFixture(revision)

    expect(decisionAuthorizesRevision(decision, revision)).toBe(true)
  })

  it('refuses a decision that names a different content hash', () => {
    const revision = revisionFixture()
    const stale = decisionFixture(revision, { contentHash: OTHER_DOCUMENT_SHA256 })

    expect(decisionAuthorizesRevision(stale, revision)).toBe(false)
  })

  it('refuses a decision that names a different revision', () => {
    const revision = revisionFixture()
    const other = revisionFixture({ documentSha256: OTHER_DOCUMENT_SHA256 })
    const decision = decisionFixture(revision)

    expect(decisionAuthorizesRevision(decision, other)).toBe(false)
  })

  it('refuses a stale decision to authorize a changed candidate', () => {
    const revision = revisionFixture()
    const decision = decisionFixture(revision)
    const changed = revisionFixture({ documentSha256: OTHER_DOCUMENT_SHA256 })
    const changedCandidate = candidateFixture(changed)

    expect(decisionAuthorizesCandidate(decision, changedCandidate)).toBe(false)
    expect(decisionAuthorizesCandidate(decision, candidateFixture(revision))).toBe(
      true,
    )
  })

  it('approves a revision only through an exact approving decision', () => {
    const revision = revisionFixture()
    const approving = decisionFixture(revision, { outcome: 'approved' })
    const rejecting = decisionFixture(revision, { outcome: 'rejected' })
    const stale = decisionFixture(revision, { contentHash: OTHER_DOCUMENT_SHA256 })

    expect(revisionIsApproved(revision, [approving])).toBe(true)
    expect(revisionIsApproved(revision, [rejecting])).toBe(false)
    expect(revisionIsApproved(revision, [stale])).toBe(false)
    expect(revisionIsApproved(revision, [])).toBe(false)
    expect(approvingDecisionFor(revision, [stale, approving])?.id).toBe(
      approving.id,
    )
  })

  it('lets a validation satisfy only the candidate it names', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validation = validationFixture(candidate)

    expect(validationSatisfiesCandidate(validation, candidate)).toBe(true)
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

    expect(validationSatisfiesCandidate(validation, candidate)).toBe(false)
  })

  it('refuses a validation of a different candidate', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const other = candidateFixture(revision, {
      artifacts: [{ ...candidate.artifacts[0], sha256: 'c'.repeat(64) }, candidate.artifacts[1]],
    })
    const validation = validationFixture(candidate)

    expect(validationSatisfiesCandidate(validation, other)).toBe(false)
  })

  it('reports the mandatory checks a candidate is still missing', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)

    const empty = mandatoryValidationStatus(candidate, [])
    expect(empty.satisfied).toBe(false)
    expect(empty.missing).toEqual([
      'bundle-verification',
      'epubcheck',
      'ace',
      'human-review',
    ])

    const partial = mandatoryValidationStatus(candidate, [
      validationFixture(candidate, { check: 'bundle-verification' }),
    ])
    expect(partial.satisfied).toBe(false)
    expect(partial.missing).toEqual(['epubcheck', 'ace', 'human-review'])
  })

  it('reports a mandatory check that failed', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = [
      validationFixture(candidate, { check: 'bundle-verification' }),
      validationFixture(candidate, { check: 'epubcheck' }),
      validationFixture(candidate, { check: 'ace' }),
      validationFixture(candidate, {
        check: 'human-review',
        outcome: 'failed',
      }),
    ]

    const status = mandatoryValidationStatus(candidate, validations)
    expect(status.satisfied).toBe(false)
    expect(status.failed).toEqual(['human-review'])
  })

  it('is satisfied only by a complete set of passing checks', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = [
      validationFixture(candidate, { check: 'bundle-verification' }),
      validationFixture(candidate, { check: 'epubcheck' }),
      validationFixture(candidate, { check: 'ace' }),
      validationFixture(candidate, {
        check: 'human-review',
        actor: REVIEWER,
      }),
    ]

    expect(mandatoryValidationStatus(candidate, validations).satisfied).toBe(true)
  })

  it('lets an approval satisfy only the candidate it names', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const approval = approvalFixture(candidate)
    const changed = candidateFixture(revision, {
      artifacts: [
        { ...candidate.artifacts[0], sha256: 'd'.repeat(64) },
        candidate.artifacts[1],
      ],
    })

    expect(approvalSatisfiesCandidate(approval, candidate)).toBe(true)
    expect(approvalSatisfiesCandidate(approval, changed)).toBe(false)
  })

  it('expires an approval that is older than the target allows', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const approval = approvalFixture(candidate, { approvedAt: LATER })

    expect(approvalIsFresh(approval, new Date(LATER), 86_400)).toBe(true)
    expect(approvalIsFresh(approval, new Date(MUCH_LATER), 86_400)).toBe(false)
    expect(approvalIsFresh(approval, new Date(MUCH_LATER), 604_800)).toBe(true)
  })

  it('holds a release current until it is superseded', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validation = validationFixture(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, [validation], approval)

    expect(releaseIsCurrent(release, [])).toBe(true)
    expect(
      releaseIsCurrent(release, [supersessionFixture(release)]),
    ).toBe(false)
  })

  it('never offers a superseded release as the current one', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validation = validationFixture(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, [validation], approval)
    const supersession = supersessionFixture(release)

    expect(
      currentReleaseForTarget([release], [supersession], candidate.target.id),
    ).toBeNull()
    expect(currentReleaseForTarget([release], [], candidate.target.id)?.id).toBe(
      release.id,
    )
  })

  it('does not offer a release of another target', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validation = validationFixture(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, [validation], approval)

    expect(
      currentReleaseForTarget([release], [], 'another-target'),
    ).toBeNull()
  })

  it('holds a target policy satisfied only when the candidate covers it', () => {
    const revision = revisionFixture()
    const target = targetFixture()
    const candidate = candidateFixture(revision, { target })

    expect(targetPolicyIsSatisfied(candidate)).toBe(true)
    expect(
      targetPolicyIsSatisfied(
        candidateFixture(revision, {
          target: {
            ...target,
            policy: {
              ...target.policy,
              requiredValidationChecks: [
                ...target.policy.requiredValidationChecks,
                'ace',
              ],
            },
          },
        }),
      ),
    ).toBe(false)
  })

  it('projects the revision state from the decisions on it', () => {
    const revision = revisionFixture()

    expect(projectRevisionState(revision, [])).toBe('revision-proposed')
    expect(
      projectRevisionState(revision, [
        decisionFixture(revision, { outcome: 'approved' }),
      ]),
    ).toBe('revision-approved')
    expect(
      projectRevisionState(revision, [
        decisionFixture(revision, { outcome: 'rejected' }),
      ]),
    ).toBe('revision-rejected')
    expect(
      projectRevisionState(revision, [
        decisionFixture(revision, { outcome: 'changes-requested' }),
      ]),
    ).toBe('revision-changes-requested')
  })

  it('projects the candidate state from the records on it', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validations = [
      validationFixture(candidate, { check: 'bundle-verification' }),
      validationFixture(candidate, { check: 'epubcheck' }),
      validationFixture(candidate, { check: 'ace' }),
      validationFixture(candidate, {
        check: 'human-review',
        actor: REVIEWER,
      }),
    ]
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, validations, approval)

    expect(
      projectCandidateState(candidate, [], [], []),
    ).toBe('candidate-assembled')
    expect(
      projectCandidateState(candidate, validations, [], []),
    ).toBe('candidate-validated')
    expect(
      projectCandidateState(candidate, validations, [approval], []),
    ).toBe('candidate-approved-for-release')
    expect(
      projectCandidateState(candidate, validations, [approval], [release]),
    ).toBe('candidate-released')
  })

  it('projects the release state from the supersessions on it', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const validation = validationFixture(candidate)
    const approval = approvalFixture(candidate)
    const release = releaseFixture(revision, candidate, [validation], approval)

    expect(projectReleaseState(release, [])).toBe('release-released')
    expect(
      projectReleaseState(release, [supersessionFixture(release)]),
    ).toBe('release-superseded')
    expect(
      projectReleaseState(
        release,
        [supersessionFixture(release, { reason: 'withdrawn' })],
      ),
    ).toBe('release-withdrawn')
  })
})
