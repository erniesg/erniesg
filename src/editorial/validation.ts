/**
 * The cross-record rules of the durable editorial contract.
 *
 * These are the rules that make the record set mean something. Every one of
 * them is a pure function over records: no store, no clock, no I/O, so a
 * reader can check a claim about the record set without trusting the writer
 * that made it.
 *
 * The shape of the rules:
 *
 *  - a **decision** authorizes exactly one revision, by its id *and* its
 *    content hash. A decision about a different cut of the content is a
 *    decision about a different thing.
 *  - a **validation** satisfies exactly one candidate, by every digest the
 *    candidate carries. A validation of other bytes is evidence about other
 *    bytes.
 *  - an **approval** authorizes exactly one candidate, the same way.
 *  - only a candidate with the complete mandatory validation set and a fresh
 *    authenticated approval may be released.
 *  - a **release** is current until a supersession names it. A superseded
 *    release is never the current one, and never is offered as one.
 */
import type {
  EditorialApproval,
  EditorialCandidate,
  EditorialCandidateSubject,
  EditorialDecision,
  EditorialRelease,
  EditorialRevision,
  EditorialRevisionSubject,
  EditorialSupersession,
  EditorialValidation,
  EditorialValidationCheck,
} from './records'

/** Every state the editorial pipeline can hold. */
export const EDITORIAL_STATES = [
  'revision-proposed',
  'revision-approved',
  'revision-rejected',
  'revision-changes-requested',
  'candidate-assembled',
  'candidate-validated',
  'candidate-approved-for-release',
  'candidate-released',
  'release-released',
  'release-superseded',
  'release-withdrawn',
] as const
export type EditorialState = (typeof EDITORIAL_STATES)[number]

/** The states a revision can hold. */
export const REVISION_STATES = [
  'revision-proposed',
  'revision-approved',
  'revision-rejected',
  'revision-changes-requested',
] as const
export type RevisionState = (typeof REVISION_STATES)[number]

/** The states a candidate can hold. */
export const CANDIDATE_STATES = [
  'candidate-assembled',
  'candidate-validated',
  'candidate-approved-for-release',
  'candidate-released',
] as const
export type CandidateState = (typeof CANDIDATE_STATES)[number]

/** The states a release can hold. */
export const RELEASE_STATES = [
  'release-released',
  'release-superseded',
  'release-withdrawn',
] as const
export type ReleaseState = (typeof RELEASE_STATES)[number]

/** Which mandatory checks a candidate is still missing, and which failed. */
export type MandatoryValidationStatus = {
  /** Required checks with no passing validation of the candidate's digests. */
  missing: EditorialValidationCheck[]
  /** Required checks with a validation that failed. */
  failed: EditorialValidationCheck[]
  /** Whether every required check has a passing validation. */
  satisfied: boolean
}

/**
 * Whether a subject names exactly this revision.
 *
 * The id alone is not enough: the content hash is what says the decision was
 * taken about *these* bytes, and the bundle digest says it was taken about
 * the bundle those bytes produced.
 */
export function subjectMatchesRevision(
  subject: EditorialRevisionSubject,
  revision: EditorialRevision,
): boolean {
  return (
    subject.revisionId === revision.id &&
    subject.contentHash === revision.contentHash &&
    subject.documentSha256 === revision.documentSha256 &&
    (subject.bundleSha256 ?? null) === (revision.bundleSha256 ?? null)
  )
}

/** Whether a subject names exactly this candidate. */
export function subjectMatchesCandidate(
  subject: EditorialCandidateSubject,
  candidate: EditorialCandidate,
): boolean {
  return (
    subject.candidateId === candidate.id &&
    subject.revisionId === candidate.revisionId &&
    subject.contentHash === candidate.contentHash &&
    subject.documentSha256 === candidate.documentSha256 &&
    (subject.bundleSha256 ?? null) === (candidate.bundleSha256 ?? null) &&
    subject.targetId === candidate.target.id &&
    subject.artifactSetSha256 === candidate.artifactSetSha256
  )
}

/** Whether a decision authorizes exactly this revision. */
export function decisionAuthorizesRevision(
  decision: EditorialDecision,
  revision: EditorialRevision,
): boolean {
  return subjectMatchesRevision(decision.subject, revision)
}

/**
 * Whether a decision authorizes exactly this candidate.
 *
 * The decision binds the revision and the content; the candidate carries
 * both. A candidate built from a different revision, or from a different
 * content hash under the same revision id, is not authorized by it.
 */
export function decisionAuthorizesCandidate(
  decision: EditorialDecision,
  candidate: EditorialCandidate,
): boolean {
  return (
    decision.subject.revisionId === candidate.revisionId &&
    decision.subject.contentHash === candidate.contentHash &&
    decision.subject.documentSha256 === candidate.documentSha256 &&
    (decision.subject.bundleSha256 ?? null) ===
      (candidate.bundleSha256 ?? null)
  )
}

/** The latest of two records, by their timestamp and then by their id. */
function latestBy<T extends { id: string }>(
  left: T,
  right: T,
  timestamp: (record: T) => string,
): T {
  if (timestamp(left) === timestamp(right)) {
    return left.id < right.id ? right : left
  }
  return timestamp(left) < timestamp(right) ? right : left
}

/**
 * The decision that decides this revision.
 *
 * Only decisions whose subject matches the revision exactly are considered.
 * The latest one wins, so a record set can hold more than one decision and
 * still have one answer.
 */
export function decidingDecisionFor(
  revision: EditorialRevision,
  decisions: readonly EditorialDecision[],
): EditorialDecision | null {
  const exact = decisions.filter((decision) =>
    subjectMatchesRevision(decision.subject, revision),
  )
  if (exact.length === 0) return null
  return exact.reduce((latest, decision) =>
    latestBy(latest, decision, (record) => record.decidedAt),
  )
}

/** The decision that approves this revision, when there is one. */
export function approvingDecisionFor(
  revision: EditorialRevision,
  decisions: readonly EditorialDecision[],
): EditorialDecision | null {
  const deciding = decidingDecisionFor(revision, decisions)
  if (!deciding || deciding.outcome !== 'approved') return null
  return deciding
}

/** Whether a revision carries an exact approving decision. */
export function revisionIsApproved(
  revision: EditorialRevision,
  decisions: readonly EditorialDecision[],
): boolean {
  return approvingDecisionFor(revision, decisions) !== null
}

/**
 * Whether a validation was run against exactly this candidate.
 *
 * The subject carries every digest the candidate has, so a validation of a
 * different artifact set, a different bundle, a different target or a
 * different candidate is not evidence about this one.
 */
export function validationSatisfiesCandidate(
  validation: EditorialValidation,
  candidate: EditorialCandidate,
): boolean {
  return subjectMatchesCandidate(validation.subject, candidate)
}

/**
 * Which of the candidate's required checks are missing, and which failed.
 *
 * A check is missing when no validation of the candidate's exact digests
 * passed for it, and failed when one did and it did not pass. A check can be
 * both: a failed validation is still a validation of the right bytes.
 */
export function mandatoryValidationStatus(
  candidate: EditorialCandidate,
  validations: readonly EditorialValidation[],
): MandatoryValidationStatus {
  const relevant = validations.filter((validation) =>
    validationSatisfiesCandidate(validation, candidate),
  )
  const passing = new Set(
    relevant
      .filter((validation) => validation.outcome === 'passed')
      .map((validation) => validation.check),
  )
  const failing = new Set(
    relevant
      .filter((validation) => validation.outcome === 'failed')
      .map((validation) => validation.check),
  )
  const required = candidate.requiredValidationChecks
  return {
    missing: required.filter((check) => !passing.has(check)),
    failed: required.filter((check) => failing.has(check)),
    satisfied: required.every((check) => passing.has(check)),
  }
}

/** Whether an approval authorizes exactly this candidate. */
export function approvalSatisfiesCandidate(
  approval: EditorialApproval,
  candidate: EditorialCandidate,
): boolean {
  return (
    approval.candidateId === candidate.id &&
    subjectMatchesCandidate(approval.subject, candidate)
  )
}

/**
 * Whether an approval is still young enough to authorize a release.
 *
 * The bound is exclusive: an approval that has *reached* the maximum age is
 * already too old. An approval stamped in the future is never fresh.
 */
export function approvalIsFresh(
  approval: EditorialApproval,
  now: Date,
  maxAgeSeconds: number,
): boolean {
  const approved = Date.parse(approval.approvedAt)
  if (Number.isNaN(approved)) return false
  const age = now.getTime() - approved
  if (age < 0) return false
  return age < maxAgeSeconds * 1000
}

/** Whether a release is still current. */
export function releaseIsCurrent(
  release: EditorialRelease,
  supersessions: readonly EditorialSupersession[],
): boolean {
  return !supersessions.some(
    (supersession) => supersession.subjectReleaseId === release.id,
  )
}

/**
 * Every current release of one target.
 *
 * More than one is an invariant violation, not a choice: the pipeline
 * publishes one artifact set per target at a time. The array is returned
 * whole so the caller can refuse rather than pick.
 */
export function currentReleasesForTarget(
  releases: readonly EditorialRelease[],
  supersessions: readonly EditorialSupersession[],
  targetId: string,
): EditorialRelease[] {
  return releases.filter(
    (release) =>
      release.target.id === targetId && releaseIsCurrent(release, supersessions),
  )
}

/**
 * The current release of one target, when there is exactly one.
 *
 * `null` when there is none, and `null` when there is more than one: an
 * ambiguous answer is not an answer.
 */
export function currentReleaseForTarget(
  releases: readonly EditorialRelease[],
  supersessions: readonly EditorialSupersession[],
  targetId: string,
): EditorialRelease | null {
  const current = currentReleasesForTarget(releases, supersessions, targetId)
  return current.length === 1 ? current[0] : null
}

/**
 * Whether the candidate covers its target's policy.
 *
 * The target's required checks must all be required by the candidate. A
 * candidate may require more than the target does, never less.
 */
export function targetPolicyIsSatisfied(candidate: EditorialCandidate): boolean {
  return candidate.target.policy.requiredValidationChecks.every((check) =>
    candidate.requiredValidationChecks.includes(check),
  )
}

/** The state a revision is in, from the decisions on it. */
export function projectRevisionState(
  revision: EditorialRevision,
  decisions: readonly EditorialDecision[],
): RevisionState {
  const deciding = decidingDecisionFor(revision, decisions)
  if (!deciding) return 'revision-proposed'
  switch (deciding.outcome) {
    case 'approved':
      return 'revision-approved'
    case 'rejected':
      return 'revision-rejected'
    case 'changes-requested':
      return 'revision-changes-requested'
  }
}

/** The state a candidate is in, from the records on it. */
export function projectCandidateState(
  candidate: EditorialCandidate,
  validations: readonly EditorialValidation[],
  approvals: readonly EditorialApproval[],
  releases: readonly EditorialRelease[],
): CandidateState {
  if (releases.some((release) => release.candidateId === candidate.id)) {
    return 'candidate-released'
  }
  if (
    approvals.some((approval) => approvalSatisfiesCandidate(approval, candidate))
  ) {
    return 'candidate-approved-for-release'
  }
  if (mandatoryValidationStatus(candidate, validations).satisfied) {
    return 'candidate-validated'
  }
  return 'candidate-assembled'
}

/** The state a release is in, from the supersessions on it. */
export function projectReleaseState(
  release: EditorialRelease,
  supersessions: readonly EditorialSupersession[],
): ReleaseState {
  const supersession = supersessions.find(
    (candidate) => candidate.subjectReleaseId === release.id,
  )
  if (!supersession) return 'release-released'
  return supersession.reason === 'withdrawn' || supersession.reason === 'revocation'
    ? 'release-withdrawn'
    : 'release-superseded'
}
