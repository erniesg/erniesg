/**
 * The cross-record rules of the durable editorial contract.
 *
 * RED PHASE. This file currently holds the *shape* of the rules and none of
 * their behaviour: every predicate is permissive, so a refusal test fails
 * here rather than passing vacuously. The implementation lands in the
 * following commit.
 */
import type {
  EditorialApproval,
  EditorialCandidate,
  EditorialDecision,
  EditorialRelease,
  EditorialRevision,
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
  missing: EditorialValidationCheck[]
  failed: EditorialValidationCheck[]
  satisfied: boolean
}

export function decisionAuthorizesRevision(
  _decision: EditorialDecision,
  _revision: EditorialRevision,
): boolean {
  return true
}

export function decisionAuthorizesCandidate(
  _decision: EditorialDecision,
  _candidate: EditorialCandidate,
): boolean {
  return true
}

export function approvingDecisionFor(
  _revision: EditorialRevision,
  _decisions: readonly EditorialDecision[],
): EditorialDecision | null {
  return null
}

export function revisionIsApproved(
  _revision: EditorialRevision,
  _decisions: readonly EditorialDecision[],
): boolean {
  return true
}

export function validationSatisfiesCandidate(
  _validation: EditorialValidation,
  _candidate: EditorialCandidate,
): boolean {
  return true
}

export function mandatoryValidationStatus(
  _candidate: EditorialCandidate,
  _validations: readonly EditorialValidation[],
): MandatoryValidationStatus {
  return { missing: [], failed: [], satisfied: true }
}

export function approvalSatisfiesCandidate(
  _approval: EditorialApproval,
  _candidate: EditorialCandidate,
): boolean {
  return true
}

export function approvalIsFresh(
  _approval: EditorialApproval,
  _now: Date,
  _maxAgeSeconds: number,
): boolean {
  return true
}

export function releaseIsCurrent(
  _release: EditorialRelease,
  _supersessions: readonly EditorialSupersession[],
): boolean {
  return true
}

export function currentReleaseForTarget(
  _releases: readonly EditorialRelease[],
  _supersessions: readonly EditorialSupersession[],
  _targetId: string,
): EditorialRelease | null {
  return null
}

export function targetPolicyIsSatisfied(_candidate: EditorialCandidate): boolean {
  return true
}

export function projectRevisionState(
  _revision: EditorialRevision,
  _decisions: readonly EditorialDecision[],
): RevisionState {
  return 'revision-approved'
}

export function projectCandidateState(
  _candidate: EditorialCandidate,
  _validations: readonly EditorialValidation[],
  _approvals: readonly EditorialApproval[],
  _releases: readonly EditorialRelease[],
): CandidateState {
  return 'candidate-approved-for-release'
}

export function projectReleaseState(
  _release: EditorialRelease,
  _supersessions: readonly EditorialSupersession[],
): ReleaseState {
  return 'release-released'
}
