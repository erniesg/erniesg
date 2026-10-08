import type {
  MarginAnnotationRecord,
  MarginVisibility,
  Motivation,
} from './web-annotation'
import type { ProgressItem, ProgressRow, ProgressScope } from './progress'
import type { Principal } from '../principal'

/**
 * The storage seam. Route handlers depend on this interface and never on D1,
 * so moving margin to `margin-api.berlayar.ai` later is a matter of writing a
 * second implementation.
 *
 * Two rules are the interface's job, not the caller's:
 *
 * 1. Every read takes a `TenantScope`. There is no "all annotations" method.
 *    `listOwnAnnotations` is bounded by site/prefix and the caller's own rows.
 *    `listReviewProposals` is the explicit cross-document exception: SQL
 *    requires the authenticated identity's global admin role AND site mapping.
 * 2. Every read takes a `viewer` and filters on it. A method cannot return a
 *    row the viewer may not see, so a handler cannot forget to filter.
 */

export type TenantScope = {
  /** URL origin, e.g. `https://ernie.sg`. */
  site: string
  /** Path, query and fragment of the annotation target. */
  document: string
}

/** The stable key for a principal. `null` means an unauthenticated reader. */
export type ViewerKey = string | null

export type MarginPrefs = {
  creator: string
  defaultVisibility: MarginVisibility
  created: string
  modified: string
}

/** Durable result of a keyed create, retained after its annotation is deleted. */
export type IdempotencyReceipt = {
  fingerprint: string
  annotationId: string
}

export type AnnotationPatch = {
  body?: string
  visibility?: MarginVisibility
  color?: string
  /** A proposal's new base commit, when a revision moves it. */
  baseCommit?: string
  /** A pre-migration proposal's source path, set when a revision upgrades it. */
  sourcePath?: string
  /** Bump a proposal's revision: its body or base changed. */
  reviseProposal?: boolean
  modified: string
}

/** A page boundary: the `(created, id)` of the last row the caller received. */
export type ListCursor = { created: string; id: string }

export type ListOptions = {
  /** Restrict to one motivation. `GET /proposals` passes `editing`. */
  motivation?: Motivation
  /** At most this many rows. Callers always set it; the store never returns all. */
  limit?: number
  /** Resume strictly after this row, in the collection's own order. */
  after?: ListCursor
  /** Leave out withdrawn proposals: the review listing, not the thread view. */
  pendingOnly?: boolean
}

/** A page boundary in `(document, created, id)` order, for `GET /mine`. */
export type OwnListCursor = ListCursor & { document: string }

export type OwnListOptions = {
  /** At most this many rows. */
  limit: number
  /** Resume strictly after this row. */
  after?: OwnListCursor
}

export const PROPOSAL_STATES = ['approved', 'pr_open', 'conflict', 'merged', 'closed', 'apply_failed'] as const
export type ProposalState = typeof PROPOSAL_STATES[number]
export type ReviewFilters = { site?: string; document?: string; state?: 'pending' | ProposalState }
export type ProposalReview = { revision: number; decision: string; comments: string; body?: string; baseCommit?: string }
export type ReviewMutationResult =
  | { status: 'saved'; record: MarginAnnotationRecord }
  | { status: 'approved'; approvedRevision: number }
  | { status: 'forbidden' }
  | { status: 'missing' }
  | { status: 'conflict' }

/** Privileged saved-review metadata, never an ordinary annotation field. */
export type SavedProposalReview = { decision: string; comments: string; revision: number; reviewer: string; at: string }
export type ReviewReadResult =
  | { status: 'found'; record: MarginAnnotationRecord; savedReview: SavedProposalReview | null }
  | { status: 'forbidden' }
  | { status: 'missing' }

export type ReviewListOptions = ReviewFilters & { limit: number; after?: ListCursor }
export type ReviewListResult = { authorized: boolean; records: MarginAnnotationRecord[] }

/** The most rows one collection response may carry. */
export const MAX_PAGE_SIZE = 200

/** What a caller gets when it does not ask for a size. */
export const DEFAULT_PAGE_SIZE = 100

export interface MarginRepository {
  /** One snapshot binds current admin authority, current proposal and saved review. */
  readReviewProposal(scope: TenantScope, id: string, principal: Principal): Promise<ReviewReadResult>

  reviewProposal(scope: TenantScope, id: string, principal: Principal, input: ProposalReview | { revision: number }, at: string, apply: boolean): Promise<ReviewMutationResult>

  /**
   * Pending proposals on explicitly mapped sites only. Authorization and rows
   * come from one SQL snapshot; an empty queue is distinct from lost authority.
   * No viewer key, email, or caller-provided admin flag can authorize this read.
   */
  listReviewProposals(principal: Principal, options: ReviewListOptions): Promise<ReviewListResult>

  /** Rows in `scope` that `viewer` is allowed to read. Filtered in SQL. */
  listAnnotations(
    scope: TenantScope,
    viewer: ViewerKey,
    options?: ListOptions,
    principal?: Principal | null,
  ): Promise<MarginAnnotationRecord[]>

  /**
   * The owner's own rows on `site` under the path `prefix`, across documents,
   * in `(document, created, id)` order (issue 073). Owner-scoped in SQL: there
   * is no viewer parameter, because nobody else's row is ever a candidate.
   */
  listOwnAnnotations(
    site: string,
    prefix: string,
    owner: string,
    options: OwnListOptions,
  ): Promise<MarginAnnotationRecord[]>

  /** One row in `scope`, or `null` when it is absent or not readable. */
  findAnnotation(
    scope: TenantScope,
    id: string,
    viewer: ViewerKey,
    principal?: Principal | null,
  ): Promise<MarginAnnotationRecord | null>

  insertAnnotation(record: MarginAnnotationRecord): Promise<void>

  /** Owner- and tenant-scoped; never exposes a different caller's receipt. */
  findIdempotencyReceipt(
    scope: TenantScope,
    owner: string,
    key: string,
  ): Promise<IdempotencyReceipt | null>

  /** Atomically records a keyed result with its newly-created annotation. */
  insertAnnotationWithReceipt(
    record: MarginAnnotationRecord,
    receipt: { key: string; fingerprint: string },
  ): Promise<void>

  /** Owner-scoped. Returns `null` when no row matched, which is a 404. */
  updateAnnotation(
    scope: TenantScope,
    id: string,
    owner: string,
    patch: AnnotationPatch,
  ): Promise<MarginAnnotationRecord | null>

  /**
   * How many annotations name this one as their parent, whoever wrote them.
   *
   * Not owner-scoped on purpose: the caller is asking whether a delete would
   * take somebody else's annotation with it, so a reply they cannot see counts.
   */
  countReplies(scope: TenantScope, id: string): Promise<number>

  /**
   * Owner-scoped. Keeps a `commenting` row that has replies and replaces its
   * body with the tombstone. `false` when no row matched.
   */
  tombstoneAnnotation(
    scope: TenantScope,
    id: string,
    owner: string,
    modified: string,
  ): Promise<boolean>

  /**
   * Owner-scoped. Withdraws a pending `editing` row from review, keeping the
   * row and its replies. `false` when no pending proposal of the owner's
   * matched.
   */
  withdrawProposal(
    scope: TenantScope,
    id: string,
    owner: string,
    at: string,
  ): Promise<boolean>

  /** Owner-scoped. `false` when no row matched. */
  deleteAnnotation(
    scope: TenantScope,
    id: string,
    owner: string,
  ): Promise<boolean>

  /** Never null: an unset preference is the documented default. */
  getPrefs(owner: string): Promise<MarginPrefs>

  setDefaultVisibility(
    owner: string,
    defaultVisibility: MarginVisibility,
    now: string,
  ): Promise<MarginPrefs>

  /** The owner's own progress in one book. Nobody else's is reachable. */
  listProgress(owner: string, scope: ProgressScope): Promise<ProgressRow[]>

  /**
   * Merge items into the owner's progress; never removes or un-solves. A new
   * item is refused once the book holds `cap` items, atomically. Returns how
   * many items were refused.
   */
  mergeProgress(
    owner: string,
    scope: ProgressScope,
    items: ProgressItem[],
    now: string,
    cap: number,
  ): Promise<number>
}

/** Applied when a user has never set a preference. */
export const DEFAULT_VISIBILITY: MarginVisibility = 'private'

/** Separate service capability: never a human Principal or MarginRepository grant. */
export type AdapterCredential = {
  tokenId: string
  site: string
  adapter: string
  tokenSha256: string
  capability: string
  createdAt: string
  revokedAt: string | null
  enabled: boolean
  registrationCreatedAt: string
}
export type ApprovedFeedItem = {
  proposalId: string
  site: string
  document: string
  source: string
  approvedRevision: number
  body: string
  baseCommit: string
  sourcePath: string
  visibility: MarginVisibility
  approvedAt: string
}
export type ApprovedFeedCursor = { approvedAt: string; proposalId: string }
export type ApprovedFeedOptions = { limit: number; after?: ApprovedFeedCursor }
export interface AdapterFeedRepository {
  findAdapterCredential(tokenId: string): Promise<AdapterCredential | null>
  /** Authority and rows from one snapshot, rechecking the verified credential. */
  listApprovedFeed(
    credential: AdapterCredential,
    options: ApprovedFeedOptions,
  ): Promise<{
    authorized: boolean
    items: ApprovedFeedItem[]
  }>
}


/** Private adapter assertions, not proof of provider work or merge authority. */
export type AdapterReportPR = { number: number; url: string; head: string }
export type AdapterReportOutcome =
  | {
      state: 'pr_open'
      pr: AdapterReportPR
      checks: 'pending' | 'passed' | 'failed' | 'not_evaluated'
      detail: string | null
    }
  | { state: 'conflict' | 'apply_failed'; detail: string }
  | { state: 'merged'; pr: AdapterReportPR; mergeCommit: string }
  | { state: 'closed'; pr: AdapterReportPR }
export type AdapterExecutionReport = {
  eventId: string
  proposalId: string
  approvedRevision: number
  expectedStateVersion: number
  outcome: AdapterReportOutcome
}
export type AdapterReportAck = {
  eventId: string
  proposalId: string
  approvedRevision: number
  stateVersion: number
  failedApplyCount: number
  state: AdapterReportOutcome['state']
  acceptedAt: string
}
export type AdapterReportResult =
  | { status: 'accepted'; ack: AdapterReportAck }
  | { status: 'forbidden' | 'conflict' | 'not_evaluated' | 'missing' }
export interface AdapterReportRepository {
  /** Caller authenticates; SQL rechecks current token-specific report authority.
   * A thrown/uncertain result requires receipt reconciliation, never blind retry. */
  reportProposalExecution(
    credential: AdapterCredential,
    report: AdapterExecutionReport,
    at: string,
  ): Promise<AdapterReportResult>
  readAdapterReportReceipt(
    credential: AdapterCredential,
    eventId: string,
  ): Promise<AdapterReportResult>
}

