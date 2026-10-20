/**
 * The editorial state machine.
 *
 * RED PHASE. The transition table below is the final one; the guards that
 * enforce it are not implemented yet, so every transition is currently
 * allowed. The implementation lands in the following commit.
 */
import type {
  EditorialActor,
  EditorialActorKind,
  EditorialApproval,
  EditorialCandidate,
  EditorialDecision,
  EditorialRecord,
  EditorialRecordKind,
  EditorialRelease,
  EditorialRevision,
  EditorialSupersession,
  EditorialValidation,
} from './records'
import { EDITORIAL_STATES, type EditorialState } from './validation'

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
  /** The states the aggregate may hold after the action. */
  to: readonly EditorialState[]
}

export const EDITORIAL_TRANSITIONS: readonly EditorialTransitionRule[] = [
  {
    action: 'propose-revision',
    from: null,
    actor: ['editor'],
    appends: 'revision',
    to: ['revision-proposed'],
  },
  {
    action: 'record-decision',
    from: ['revision-proposed'],
    actor: ['reviewer'],
    appends: 'decision',
    to: [
      'revision-approved',
      'revision-rejected',
      'revision-changes-requested',
    ],
  },
  {
    action: 'assemble-candidate',
    from: null,
    actor: ['editor'],
    appends: 'candidate',
    to: ['candidate-assembled'],
  },
  {
    action: 'record-validation',
    from: ['candidate-assembled', 'candidate-validated'],
    actor: ['tool', 'reviewer'],
    appends: 'validation',
    to: ['candidate-assembled', 'candidate-validated'],
  },
  {
    action: 'record-approval',
    from: ['candidate-validated'],
    actor: ['approver'],
    appends: 'approval',
    to: ['candidate-approved-for-release'],
  },
  {
    action: 'record-release',
    from: ['candidate-approved-for-release'],
    actor: ['producer'],
    appends: 'release',
    to: ['candidate-released', 'release-released'],
  },
  {
    action: 'supersede-release',
    from: ['release-released'],
    actor: ['producer', 'approver'],
    appends: 'supersession',
    to: ['release-superseded', 'release-withdrawn'],
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

const STUB_TARGET: Record<EditorialAction, EditorialState> = {
  'propose-revision': 'revision-proposed',
  'record-decision': 'revision-approved',
  'assemble-candidate': 'candidate-assembled',
  'record-validation': 'candidate-validated',
  'record-approval': 'candidate-approved-for-release',
  'record-release': 'release-released',
  'supersede-release': 'release-superseded',
}

export function applyTransition(input: TransitionInput): TransitionOutcome {
  const record = appendedRecord(input)
  return {
    ok: true,
    action: input.action,
    from: null,
    to: STUB_TARGET[input.action],
    record,
  }
}

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

export { EDITORIAL_STATES }
