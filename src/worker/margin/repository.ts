import type {
  MarginAnnotationRecord,
  MarginVisibility,
  Motivation,
} from './web-annotation'

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
  modified: string
}

export type ListOptions = {
  /** Restrict to one motivation. `GET /proposals` passes `editing`. */
  motivation?: Motivation
}

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
}

/** Applied when a user has never set a preference. */
export const DEFAULT_VISIBILITY: MarginVisibility = 'private'
