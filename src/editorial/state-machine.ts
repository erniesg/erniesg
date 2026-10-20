/**
 * The editorial state machine.
 *
 * One pipeline, from a cut of the content to a retired release:
 *
 * ```
 *   revision ──record-decision──▶ revision-approved
 *      │                              │
 *      │                        (one decision per revision;
 *      │                         a changed mind is a new revision)
 *      ▼
 *   assemble-candidate ──▶ candidate-assembled
 *                              │
 *                        record-validation ×4
 *                              ▼
 *                        candidate-validated
 *                              │
 *                         record-approval
 *                              ▼
 *                     candidate-approved-for-release
 *                              │
 *                          record-release
 *                              ▼
 *                        release-released ──supersede-release──▶ superseded
 * ```
 *
 * The function is pure: it takes the records the caller has read and the
 * record it wants to append, and it answers "may this happen, and what is
 * the state afterwards". It never touches a store, a clock or a network, so
 * the whole contract can be exercised in isolation — which is what the tests
 * do.
 *
 * A record is never edited. The state of a candidate or a release is a
 * projection over the record set (`validation.ts`), and the append that
 * changes the projection is what this module authorises. That is what lets
 * an id be a digest of a record's own content (`ids.ts`).
 */
import {
  editorialApprovalSchema,
  editorialCandidateSchema,
  editorialDecisionSchema,
  editorialRecordSchema,
  editorialReleaseSchema,
  editorialRevisionSchema,
  editorialSupersessionSchema,
  editorialValidationSchema,
  type EditorialActor,
  type EditorialActorKind,
  type EditorialApproval,
  type EditorialCandidate,
  type EditorialDecision,
  type EditorialRecord,
  type EditorialRecordKind,
  type EditorialRelease,
  type EditorialRevision,
  type EditorialSupersession,
  type EditorialValidation,
} from './records'
import {
  EDITORIAL_TIMESTAMP_FIELD_BY_KIND,
  editorialDigest,
  editorialRecordIdMatches,
} from './ids'
import {
  approvalIsFresh,
  approvalSatisfiesCandidate,
  currentReleasesForTarget,
  decidingDecisionFor,
  mandatoryValidationStatus,
  projectCandidateState,
  projectReleaseState,
  projectRevisionState,
  releaseIsCurrent,
  subjectMatchesCandidate,
  subjectMatchesRevision,
  targetPolicyIsSatisfied,
  type EditorialState,
} from './validation'

/** Every action the editorial pipeline can perform. */
export const EDITORIAL_ACTIONS = [
  'propose-revision',
  'record-decision',
  'assemble-candidate',
  'record-validation',
  'record-approval',
  'record-release',
  'supersede-release',
] as const
export type EditorialAction = (typeof EDITORIAL_ACTIONS)[number]

/** Every way a transition can be refused. */
export const EDITORIAL_REFUSAL_CODES = [
  'action_not_permitted',
  'actor_not_permitted',
  'record_kind_mismatch',
  'record_schema_invalid',
  'record_id_mismatch',
  'record_timestamp_in_future',
  'wrong_state',
  'revision_not_approved',
  'stale_decision',
  'digest_mismatch',
  'mandatory_validation_missing',
  'validation_not_passed',
  'approval_missing',
  'target_policy_not_satisfied',
  'release_not_current',
  'target_already_released',
] as const
export type EditorialRefusalCode = (typeof EDITORIAL_REFUSAL_CODES)[number]

/** A refusal, with a code a caller can branch on. */
export type EditorialRefusal = {
  code: EditorialRefusalCode
  message: string
}

/** One row of the transition table. */
export type EditorialTransitionRule = {
  action: EditorialAction
  /** The states the aggregate may be in; `null` means it does not exist yet. */
  from: readonly EditorialState[] | null
  /** The actor kinds that may perform the action. */
  actor: readonly EditorialActorKind[]
  /** The record kind the action appends. */
  appends: EditorialRecordKind
  /** The state the aggregate holds after the action. */
  to: EditorialState
}

export const EDITORIAL_TRANSITIONS: readonly EditorialTransitionRule[] = [
  {
    action: 'propose-revision',
    from: null,
    actor: ['editor'],
    appends: 'revision',
    to: 'revision-proposed',
  },
  {
    action: 'record-decision',
    from: ['revision-proposed'],
    actor: ['reviewer'],
    appends: 'decision',
    to: 'revision-approved',
  },
  {
    action: 'assemble-candidate',
    from: null,
    actor: ['editor'],
    appends: 'candidate',
    to: 'candidate-assembled',
  },
  {
    action: 'record-validation',
    from: ['candidate-assembled', 'candidate-validated'],
    actor: ['tool', 'reviewer'],
    appends: 'validation',
    to: 'candidate-validated',
  },
  {
    action: 'record-approval',
    from: ['candidate-validated'],
    actor: ['approver'],
    appends: 'approval',
    to: 'candidate-approved-for-release',
  },
  {
    action: 'record-release',
    from: ['candidate-approved-for-release'],
    actor: ['producer'],
    appends: 'release',
    to: 'release-released',
  },
  {
    action: 'supersede-release',
    from: ['release-released'],
    actor: ['producer', 'approver'],
    appends: 'supersession',
    to: 'release-superseded',
  },
]

/** The input of one transition. */
export type TransitionInput =
  | {
      action: 'propose-revision'
      actor: EditorialActor
      now: string
      revision: EditorialRevision
    }
  | {
      action: 'record-decision'
      actor: EditorialActor
      now: string
      revision: EditorialRevision
      decision: EditorialDecision
      decisions: readonly EditorialDecision[]
    }
  | {
      action: 'assemble-candidate'
      actor: EditorialActor
      now: string
      revision: EditorialRevision
      candidate: EditorialCandidate
      decisions: readonly EditorialDecision[]
    }
  | {
      action: 'record-validation'
      actor: EditorialActor
      now: string
      candidate: EditorialCandidate
      validation: EditorialValidation
      validations: readonly EditorialValidation[]
      approvals: readonly EditorialApproval[]
      releases: readonly EditorialRelease[]
    }
  | {
      action: 'record-approval'
      actor: EditorialActor
      now: string
      candidate: EditorialCandidate
      approval: EditorialApproval
      validations: readonly EditorialValidation[]
      approvals: readonly EditorialApproval[]
    }
  | {
      action: 'record-release'
      actor: EditorialActor
      now: string
      revision: EditorialRevision
      candidate: EditorialCandidate
      release: EditorialRelease
      validations: readonly EditorialValidation[]
      approvals: readonly EditorialApproval[]
      releases: readonly EditorialRelease[]
      supersessions: readonly EditorialSupersession[]
    }
  | {
      action: 'supersede-release'
      actor: EditorialActor
      now: string
      release: EditorialRelease
      supersession: EditorialSupersession
      releases: readonly EditorialRelease[]
      supersessions: readonly EditorialSupersession[]
    }

/** The outcome of one transition. */
export type TransitionOutcome =
  | {
      ok: true
      action: EditorialAction
      from: EditorialState | null
      to: EditorialState
      record: EditorialRecord
    }
  | {
      ok: false
      action: EditorialAction
      refusal: EditorialRefusal
    }

const RECORD_SCHEMAS = {
  revision: editorialRevisionSchema,
  decision: editorialDecisionSchema,
  candidate: editorialCandidateSchema,
  validation: editorialValidationSchema,
  approval: editorialApprovalSchema,
  release: editorialReleaseSchema,
  supersession: editorialSupersessionSchema,
} as const

/** The record the action appends. */
function appendedRecord(input: TransitionInput): EditorialRecord {
  switch (input.action) {
    case 'propose-revision':
      return input.revision
    case 'record-decision':
      return input.decision
    case 'assemble-candidate':
      return input.candidate
    case 'record-validation':
      return input.validation
    case 'record-approval':
      return input.approval
    case 'record-release':
      return input.release
    case 'supersede-release':
      return input.supersession
  }
}

/** Whether two actors are the same identity in the same role. */
export function sameActor(
  left: EditorialActor,
  right: EditorialActor,
): boolean {
  if (left.kind !== right.kind) return false
  if ('principal' in left && 'principal' in right) {
    return (
      left.principal === right.principal &&
      left.provider === right.provider &&
      left.issuer === right.issuer &&
      left.subject === right.subject
    )
  }
  if ('toolId' in left && 'toolId' in right) {
    return left.toolId === right.toolId && left.toolVersion === right.toolVersion
  }
  if ('keyId' in left && 'keyId' in right) {
    return left.keyId === right.keyId && left.policyEpoch === right.policyEpoch
  }
  return false
}

/** Whether two values are the same content, whatever their key order. */
function sameValue(left: unknown, right: unknown): boolean {
  return editorialDigest(left) === editorialDigest(right)
}

type Guard = { ok: true; from: EditorialState | null; to: EditorialState }
type GuardRefusal = { ok: false; code: EditorialRefusalCode; message: string }

function refuse(
  code: EditorialRefusalCode,
  message: string,
): GuardRefusal {
  return { ok: false, code, message }
}

/**
 * Whether a transition may happen, and what the state is afterwards.
 *
 * The order of the checks is the order of the refusals a reader cares about:
 * who is asking, then what they are appending, then whether the aggregate
 * is in a state that allows it, then the rule that is specific to the
 * action.
 */
export function applyTransition(input: TransitionInput): TransitionOutcome {
  const rule = EDITORIAL_TRANSITIONS.find(
    (candidate) => candidate.action === input.action,
  )
  if (!rule) {
    return {
      ok: false,
      action: input.action,
      refusal: {
        code: 'action_not_permitted',
        message: `no transition is defined for ${input.action}`,
      },
    }
  }

  if (!rule.actor.includes(input.actor.kind)) {
    return {
      ok: false,
      action: input.action,
      refusal: {
        code: 'actor_not_permitted',
        message: `a ${input.actor.kind} may not perform ${input.action}`,
      },
    }
  }

  const record = appendedRecord(input)
  if (record.kind !== rule.appends) {
    return {
      ok: false,
      action: input.action,
      refusal: {
        code: 'record_kind_mismatch',
        message: `${input.action} appends a ${rule.appends}, not a ${record.kind}`,
      },
    }
  }

  const schema = RECORD_SCHEMAS[record.kind]
  if (!schema.safeParse(record).success) {
    return {
      ok: false,
      action: input.action,
      refusal: {
        code: 'record_schema_invalid',
        message: `the ${record.kind} does not satisfy its own schema`,
      },
    }
  }

  if (!editorialRecordIdMatches(record)) {
    return {
      ok: false,
      action: input.action,
      refusal: {
        code: 'record_id_mismatch',
        message: `the ${record.kind} carries an id its content does not derive`,
      },
    }
  }

  const timestampField = EDITORIAL_TIMESTAMP_FIELD_BY_KIND[record.kind]
  const written = Date.parse(
    (record as unknown as Record<string, string>)[timestampField],
  )
  const now = Date.parse(input.now)
  if (!Number.isNaN(written) && !Number.isNaN(now) && written > now) {
    return {
      ok: false,
      action: input.action,
      refusal: {
        code: 'record_timestamp_in_future',
        message: `the ${record.kind} is stamped after the transition`,
      },
    }
  }

  const guard = guardFor(input)
  if (!guard.ok) {
    return {
      ok: false,
      action: input.action,
      refusal: { code: guard.code, message: guard.message },
    }
  }
  return {
    ok: true,
    action: input.action,
    from: guard.from,
    to: guard.to,
    record,
  }
}

function guardFor(input: TransitionInput): Guard | GuardRefusal {
  switch (input.action) {
    case 'propose-revision':
      return guardProposeRevision(input)
    case 'record-decision':
      return guardRecordDecision(input)
    case 'assemble-candidate':
      return guardAssembleCandidate(input)
    case 'record-validation':
      return guardRecordValidation(input)
    case 'record-approval':
      return guardRecordApproval(input)
    case 'record-release':
      return guardRecordRelease(input)
    case 'supersede-release':
      return guardSupersedeRelease(input)
  }
}

function guardProposeRevision(
  input: Extract<TransitionInput, { action: 'propose-revision' }>,
): Guard | GuardRefusal {
  if (input.revision.author.kind !== 'editor') {
    return refuse('actor_not_permitted', 'a revision is cut by an editor')
  }
  if (!sameActor(input.revision.author, input.actor)) {
    return refuse(
      'actor_not_permitted',
      'the revision is cut by somebody other than the actor',
    )
  }
  return { ok: true, from: null, to: 'revision-proposed' }
}

function guardRecordDecision(
  input: Extract<TransitionInput, { action: 'record-decision' }>,
): Guard | GuardRefusal {
  if (input.decision.actor.kind !== 'reviewer') {
    return refuse('actor_not_permitted', 'a decision is taken by a reviewer')
  }
  if (!sameActor(input.decision.actor, input.actor)) {
    return refuse(
      'actor_not_permitted',
      'the decision is attributed to somebody other than the actor',
    )
  }
  const state = projectRevisionState(input.revision, input.decisions)
  if (state !== 'revision-proposed') {
    return refuse(
      'wrong_state',
      `a revision that is already ${state} takes no further decision`,
    )
  }
  if (!subjectMatchesRevision(input.decision.subject, input.revision)) {
    return refuse(
      'stale_decision',
      'the decision does not bind the exact revision and content hashes',
    )
  }
  const to: EditorialState =
    input.decision.outcome === 'approved'
      ? 'revision-approved'
      : input.decision.outcome === 'rejected'
        ? 'revision-rejected'
        : 'revision-changes-requested'
  return { ok: true, from: state, to }
}

function guardAssembleCandidate(
  input: Extract<TransitionInput, { action: 'assemble-candidate' }>,
): Guard | GuardRefusal {
  if (input.candidate.author.kind !== 'editor') {
    return refuse('actor_not_permitted', 'a candidate is assembled by an editor')
  }
  if (!sameActor(input.candidate.author, input.actor)) {
    return refuse(
      'actor_not_permitted',
      'the candidate is assembled by somebody other than the actor',
    )
  }
  if (
    input.candidate.revisionId !== input.revision.id ||
    input.candidate.contentHash !== input.revision.contentHash ||
    input.candidate.documentSha256 !== input.revision.documentSha256 ||
    (input.candidate.bundleSha256 ?? null) !==
      (input.revision.bundleSha256 ?? null)
  ) {
    return refuse(
      'digest_mismatch',
      'the candidate does not name the revision it was assembled from',
    )
  }

  const onRevision = input.decisions.filter(
    (decision) => decision.subject.revisionId === input.revision.id,
  )
  const exact = onRevision.filter((decision) =>
    subjectMatchesRevision(decision.subject, input.revision),
  )
  if (exact.length === 0) {
    if (onRevision.length > 0) {
      return refuse(
        'stale_decision',
        'the only decision on this revision binds different content hashes',
      )
    }
    return refuse(
      'revision_not_approved',
      'only an approved revision can produce a release candidate',
    )
  }
  const deciding = decidingDecisionFor(input.revision, exact)
  if (!deciding || deciding.outcome !== 'approved') {
    return refuse(
      'revision_not_approved',
      'only an approved revision can produce a release candidate',
    )
  }
  if (!targetPolicyIsSatisfied(input.candidate)) {
    return refuse(
      'target_policy_not_satisfied',
      'the candidate does not cover the checks its target requires',
    )
  }
  return { ok: true, from: null, to: 'candidate-assembled' }
}

function guardRecordValidation(
  input: Extract<TransitionInput, { action: 'record-validation' }>,
): Guard | GuardRefusal {
  const check = input.validation.check
  const required = check === 'human-review' ? 'reviewer' : 'tool'
  if (input.validation.actor.kind !== required) {
    return refuse(
      'actor_not_permitted',
      `a ${check} validation is recorded by a ${required}`,
    )
  }
  if (!sameActor(input.validation.actor, input.actor)) {
    return refuse(
      'actor_not_permitted',
      'the validation is attributed to somebody other than the actor',
    )
  }
  const state = projectCandidateState(
    input.candidate,
    input.validations,
    input.approvals,
    input.releases,
  )
  if (state !== 'candidate-assembled' && state !== 'candidate-validated') {
    return refuse(
      'wrong_state',
      `a candidate that is already ${state} takes no further validation`,
    )
  }
  if (!subjectMatchesCandidate(input.validation.subject, input.candidate)) {
    return refuse(
      'digest_mismatch',
      'the validation does not bind the exact digests of the candidate',
    )
  }
  if (!input.candidate.requiredValidationChecks.includes(check)) {
    return refuse(
      'mandatory_validation_missing',
      `the candidate does not require the ${check} check`,
    )
  }
  const after = [
    ...input.validations.filter(
      (validation) => validation.id !== input.validation.id,
    ),
    input.validation,
  ]
  const status = mandatoryValidationStatus(input.candidate, after)
  return {
    ok: true,
    from: state,
    to: status.satisfied ? 'candidate-validated' : 'candidate-assembled',
  }
}

function guardRecordApproval(
  input: Extract<TransitionInput, { action: 'record-approval' }>,
): Guard | GuardRefusal {
  if (input.approval.actor.kind !== 'approver') {
    return refuse('actor_not_permitted', 'an approval is given by an approver')
  }
  if (!sameActor(input.approval.actor, input.actor)) {
    return refuse(
      'actor_not_permitted',
      'the approval is attributed to somebody other than the actor',
    )
  }
  const state = projectCandidateState(
    input.candidate,
    input.validations,
    input.approvals,
    [],
  )
  if (state !== 'candidate-validated') {
    const status = mandatoryValidationStatus(input.candidate, input.validations)
    if (!status.satisfied) {
      return refuse(
        'mandatory_validation_missing',
        `the candidate is missing ${status.missing.join(', ')}`,
      )
    }
    return refuse(
      'wrong_state',
      `a candidate that is already ${state} takes no further approval`,
    )
  }
  if (!subjectMatchesCandidate(input.approval.subject, input.candidate)) {
    return refuse(
      'digest_mismatch',
      'the approval does not bind the exact digests of the candidate',
    )
  }
  return { ok: true, from: state, to: 'candidate-approved-for-release' }
}

function guardRecordRelease(
  input: Extract<TransitionInput, { action: 'record-release' }>,
): Guard | GuardRefusal {
  if (!sameActor(input.release.producer, input.actor)) {
    return refuse(
      'actor_not_permitted',
      'the release is attributed to a producer other than the actor',
    )
  }
  const state = projectCandidateState(
    input.candidate,
    input.validations,
    input.approvals,
    input.releases,
  )
  if (state !== 'candidate-approved-for-release') {
    return refuse(
      'wrong_state',
      `a candidate that is already ${state} is not released`,
    )
  }
  if (
    input.release.candidateId !== input.candidate.id ||
    input.release.revisionId !== input.revision.id ||
    input.release.revisionId !== input.candidate.revisionId ||
    input.release.contentHash !== input.candidate.contentHash ||
    input.release.contentHash !== input.revision.contentHash
  ) {
    return refuse(
      'digest_mismatch',
      'the release does not name the candidate and revision it publishes',
    )
  }
  if (
    (input.release.sourceBinding.documentSha256 ?? null) !==
    (input.revision.documentSha256 ?? null)
  ) {
    return refuse(
      'digest_mismatch',
      'the release binds a different document than the revision',
    )
  }
  if (
    (input.release.sourceBinding.bundleSha256 ?? null) !==
    (input.candidate.bundleSha256 ?? null)
  ) {
    return refuse(
      'digest_mismatch',
      'the release binds a different bundle than the candidate',
    )
  }
  if (!sameValue(input.release.sourceBinding, input.revision.sourceBinding)) {
    return refuse(
      'digest_mismatch',
      'the release binds a different package pin than the revision',
    )
  }
  if (!sameValue(input.release.schemaVersions, input.revision.schemaVersions)) {
    return refuse(
      'digest_mismatch',
      'the release binds different schema versions than the revision',
    )
  }
  if (!sameValue(input.release.rendering, input.revision.rendering)) {
    return refuse(
      'digest_mismatch',
      'the release binds a different renderer or profile than the revision',
    )
  }
  if (!sameValue(input.release.target, input.candidate.target)) {
    return refuse(
      'digest_mismatch',
      'the release binds a different target than the candidate',
    )
  }
  if (
    !sameValue(input.release.artifacts, input.candidate.artifacts) ||
    input.release.artifactSetSha256 !== input.candidate.artifactSetSha256
  ) {
    return refuse(
      'digest_mismatch',
      'the release binds different artifact bytes than the candidate',
    )
  }

  const byId = new Map(
    input.validations.map((validation) => [validation.id, validation]),
  )
  for (const reference of input.release.validations) {
    const validation = byId.get(reference.id)
    if (!validation) {
      return refuse(
        'mandatory_validation_missing',
        `the release binds a validation that does not exist: ${reference.id}`,
      )
    }
    if (validation.outcome !== 'passed') {
      return refuse(
        'validation_not_passed',
        `the release binds a validation that did not pass: ${reference.id}`,
      )
    }
    if (!subjectMatchesCandidate(validation.subject, input.candidate)) {
      return refuse(
        'digest_mismatch',
        `the release binds a validation of different digests: ${reference.id}`,
      )
    }
  }
  const bound = new Set(
    input.release.validations.map((reference) => reference.id),
  )
  const status = mandatoryValidationStatus(
    input.candidate,
    input.validations.filter((validation) => bound.has(validation.id)),
  )
  if (!status.satisfied) {
    return refuse(
      'mandatory_validation_missing',
      `the release does not bind a passing check for ${status.missing.join(', ')}`,
    )
  }

  const approval = input.approvals.find(
    (candidate) => candidate.id === input.release.approval.id,
  )
  if (!approval) {
    return refuse(
      'approval_missing',
      `the release binds an approval that does not exist: ${input.release.approval.id}`,
    )
  }
  if (!approvalSatisfiesCandidate(approval, input.candidate)) {
    return refuse(
      'digest_mismatch',
      'the approval does not bind the exact digests of the candidate',
    )
  }
  if (
    !approvalIsFresh(
      approval,
      new Date(input.now),
      input.candidate.target.policy.maxApprovalAgeSeconds,
    )
  ) {
    return refuse(
      'target_policy_not_satisfied',
      'the approval is older than the target allows',
    )
  }
  if (!targetPolicyIsSatisfied(input.candidate)) {
    return refuse(
      'target_policy_not_satisfied',
      'the candidate does not cover the checks its target requires',
    )
  }

  const current = currentReleasesForTarget(
    input.releases,
    input.supersessions,
    input.release.target.id,
  )
  if (current.length > 0) {
    return refuse(
      'target_already_released',
      'the target already has a current release',
    )
  }
  return { ok: true, from: state, to: 'release-released' }
}

function guardSupersedeRelease(
  input: Extract<TransitionInput, { action: 'supersede-release' }>,
): Guard | GuardRefusal {
  if (!sameActor(input.supersession.actor, input.actor)) {
    return refuse(
      'actor_not_permitted',
      'the supersession is attributed to somebody other than the actor',
    )
  }
  const state = projectReleaseState(input.release, input.supersessions)
  if (state !== 'release-released') {
    return refuse(
      'release_not_current',
      `the release is already ${state}`,
    )
  }
  if (input.supersession.subjectReleaseId !== input.release.id) {
    return refuse(
      'digest_mismatch',
      'the supersession does not name the release it retires',
    )
  }
  if (input.supersession.supersedingReleaseId !== null) {
    // The replacement may be released in the same transaction, so it is not
    // always in the reader's set. When it is, it must publish to the same
    // target: a release cannot be retired in favour of one that goes
    // somewhere else.
    const successor = input.releases.find(
      (release) => release.id === input.supersession.supersedingReleaseId,
    )
    if (successor && successor.target.id !== input.release.target.id) {
      return refuse(
        'digest_mismatch',
        'the superseding release publishes to another target',
      )
    }
  }
  if (!releaseIsCurrent(input.release, input.supersessions)) {
    return refuse('release_not_current', 'the release is not current')
  }
  return {
    ok: true,
    from: state,
    to:
      input.supersession.reason === 'withdrawn' ||
      input.supersession.reason === 'revocation'
        ? 'release-withdrawn'
        : 'release-superseded',
  }
}
