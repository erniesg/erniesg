/** The approved revision is copied at the service boundary and cannot be edited by an adapter. */
export interface SourceReference {
  readonly documentId: string
  /** Opaque to Margin; interpreted only by the site that owns the adapter. */
  readonly location: string
}

export interface ApprovedSnapshot {
  readonly proposalId: string
  readonly revision: number
  readonly baseRevision: string
  /** Canonical proposal body from the service's existing proposal codec. */
  readonly canonicalBody: string
  readonly sourceReference: Readonly<SourceReference>
}

/** Results describe source progress without prescribing a transport or repository. */
export type ApplyOutcome =
  | { readonly state: 'submitted'; readonly reference: string; readonly revision?: string }
  | { readonly state: 'conflict'; readonly reason: string }
  | { readonly state: 'completed'; readonly revision: string }
  | { readonly state: 'closed'; readonly reason?: string }
  | { readonly state: 'failed'; readonly reason: string; readonly retryable: boolean }

export interface SourceAdapter {
  resolveDocument(documentId: string): SourceReference | Promise<SourceReference>
  applyApproved(snapshot: ApprovedSnapshot): Promise<ApplyOutcome>
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  const found = Object.keys(record)
  if (found.length !== keys.length || found.some((key) => !keys.includes(key))) {
    throw new TypeError(`${label} has unexpected or missing fields`)
  }
  return record
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a nonempty string`)
  }
  return value
}

/** Reject extra fields, including credentials, and detach the approved values from later edits. */
export function createApprovedSnapshot(value: unknown): ApprovedSnapshot {
  const input = exactRecord(
    value,
    ['proposalId', 'revision', 'baseRevision', 'canonicalBody', 'sourceReference'],
    'approved snapshot',
  )
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) {
    throw new TypeError('revision must be a positive integer')
  }
  const source = exactRecord(input.sourceReference, ['documentId', 'location'], 'source reference')
  const sourceReference = Object.freeze({
    documentId: nonempty(source.documentId, 'documentId'),
    location: nonempty(source.location, 'location'),
  })
  return Object.freeze({
    proposalId: nonempty(input.proposalId, 'proposalId'),
    revision: input.revision as number,
    baseRevision: nonempty(input.baseRevision, 'baseRevision'),
    canonicalBody: nonempty(input.canonicalBody, 'canonicalBody'),
    sourceReference,
  })
}
