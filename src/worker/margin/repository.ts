import type {
  MarginAnnotationRecord,
  MarginVisibility,
  Motivation,
} from './web-annotation'
import type { ProgressItem, ProgressRow, ProgressScope } from './progress'

/**
 * The storage seam. Route handlers depend on this interface and never on D1,
 * so moving margin to `margin-api.berlayar.ai` later is a matter of writing a
 * second implementation.
 *
 * Two rules are the interface's job, not the caller's:
 *
 * 1. Every read takes a `TenantScope`. There is no "all annotations" method.
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

export type AnnotationPatch = {
  body?: string
  visibility?: MarginVisibility
  color?: string
  /** A proposal's new base commit, when a revision moves it. */
  baseCommit?: string
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

/** The most rows one collection response may carry. */
export const MAX_PAGE_SIZE = 200

/** What a caller gets when it does not ask for a size. */
export const DEFAULT_PAGE_SIZE = 100

export interface MarginRepository {
  /** Rows in `scope` that `viewer` is allowed to read. Filtered in SQL. */
  listAnnotations(
    scope: TenantScope,
    viewer: ViewerKey,
    options?: ListOptions,
  ): Promise<MarginAnnotationRecord[]>

  /** One row in `scope`, or `null` when it is absent or not readable. */
  findAnnotation(
    scope: TenantScope,
    id: string,
    viewer: ViewerKey,
  ): Promise<MarginAnnotationRecord | null>

  insertAnnotation(record: MarginAnnotationRecord): Promise<void>

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
