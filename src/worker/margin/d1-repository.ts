import { textAnnotationSchema } from '../../annotations/annotations'
import { z } from 'zod'
import { isFullCommitId, parseHunks } from '../../annotations/criticmarkup'
import { principalSchema, type Principal } from '../principal'
import { PRINCIPAL_IRI_PREFIX, principalKey } from './identity'
import type { D1Database } from './d1'
import {
  countRepliesQuery,
  reviewMutationQuery,
  reviewTargetQuery,
  deleteAnnotationQuery,
  findAnnotationQuery,
  findIdempotencyReceiptQuery,
  getPrefsQuery,
  insertAnnotationQuery,
  insertIdempotencyReceiptQuery,
  listAnnotationsQuery,
  listOwnAnnotationsQuery,
  listReviewProposalsQuery,
  ANNOTATION_COLUMNS,
  listProgressQuery,
  mergeProgressQuery,
  tombstoneAnnotationQuery,
  withdrawProposalQuery,
  updateAnnotationQuery,
  upsertPrefsQuery,
  type Query,
} from './queries'
import type { ProgressItem, ProgressRow, ProgressScope } from './progress'
import {
  DEFAULT_VISIBILITY,
  PROPOSAL_STATES,
  type ProposalReview,
  type ReviewMutationResult,
  MAX_PAGE_SIZE,
  type AnnotationPatch,
  type IdempotencyReceipt,
  type ListOptions,
  type OwnListOptions,
  type ReviewListOptions,
  type ReviewListResult,
  type MarginPrefs,
  type MarginRepository,
  type TenantScope,
  type ViewerKey,
} from './repository'
import {
  DEFAULT_HIGHLIGHT_COLOR,
  kindForMotivation,
  motivationForKind,
  TOMBSTONE_BODY,
  isRepoRelativePath,
  splitSource,
  maxBodyLength,
  MAX_QUOTE_LENGTH,
  MAX_CONTEXT_LENGTH,
  type MarginAnnotationRecord,
  type MarginVisibility,
  type Motivation,
} from './web-annotation'

/**
 * The D1 implementation of `MarginRepository`.
 *
 * It is the only file in `src/worker/` that touches a database. Every method
 * delegates its SQL to `queries.ts`, so the statements this class runs are the
 * statements the visibility proof runs.
 */

type AnnotationRow = {
  id: string
  site: string
  document: string
  creator: string
  visibility: string
  motivation: string
  parent_id: string | null
  struct_id: string | null
  node_id: string
  position_start: number
  position_end: number
  position_unit: 'utf16' | 'codepoint'
  quote_exact: string
  quote_prefix: string
  quote_suffix: string
  body: string | null
  color: string | null
  created: string
  modified: string
  base_commit: string | null
  source_path: string | null
  revision: number | null
  withdrawn_at: string | null
  proposal_state?: string | null
  approved_revision?: number | null
}

type PrefsRow = {
  creator: string
  default_visibility: string
  created: string
  modified: string
}

const reviewSite = z.string().refine(value => {
  const scope = splitSource(value)
  return scope?.site === value && scope.document === '/'
})
const reviewKey = z.object({ created: z.string().datetime({ offset: true }), id: z.string().min(1).max(2048) }).strict()
const reviewOptions = z.object({
  site: reviewSite.optional(),
  document: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE + 1),
  after: reviewKey.optional(),
  state: z.enum(['pending', ...PROPOSAL_STATES]).optional(),
}).strict().refine(value => {
  if (value.document === undefined) return true
  if (value.site === undefined || !value.document.startsWith('/')) return false
  const scope = splitSource(value.site + value.document)
  return scope?.site === value.site && scope.document === value.document
})
const reviewAuthority = z.object({
  review_identity_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  review_role: z.enum(['admin', 'writer']).nullable(),
  review_site: reviewSite.nullable(),
}).strict()

function isStoredPrincipalKey(value: string): boolean {
  if (!value.startsWith(PRINCIPAL_IRI_PREFIX)) return false
  try {
    const parts = value.slice(PRINCIPAL_IRI_PREFIX.length).split(':').map(decodeURIComponent)
    if (parts.length !== 3 || parts.some(part => !part)) return false
    return principalKey({ provider: parts[0], issuer: parts[1], subject: parts[2] }) === value
  } catch {
    return false
  }
}

/** The stored proposal columns shared by three different SQL result contracts. */
const proposalColumns = z.object({
  id: z.string().min(1).max(2048),
  site: reviewSite,
  document: z.string().min(1).max(2048),
  creator: z.string().refine(isStoredPrincipalKey),
  visibility: z.enum(['private', 'public']),
  motivation: z.literal('editing'),
  parent_id: z.null(),
  struct_id: z.string().min(1).max(256).nullable(),
  node_id: z.string().min(1).max(256),
  position_start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  position_end: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  position_unit: z.enum(['utf16', 'codepoint']),
  quote_exact: z.string().min(1).max(MAX_QUOTE_LENGTH),
  quote_prefix: z.string().max(MAX_CONTEXT_LENGTH),
  quote_suffix: z.string().max(MAX_CONTEXT_LENGTH),
  body: z.string().min(1).max(maxBodyLength('editing')),
  color: z.string().min(1).max(64).nullable(),
  created: reviewKey.shape.created,
  modified: reviewKey.shape.created,
  base_commit: z.string().refine(isFullCommitId).nullable(),
  source_path: z.string().min(1).max(512).refine(isRepoRelativePath).nullable(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  withdrawn_at: reviewKey.shape.created.nullable(),
})

function validProposalColumns(row: z.infer<typeof proposalColumns>): boolean {
  const scope = splitSource(row.site + row.document)
  const metadata = [row.base_commit, row.source_path, row.revision]
  return row.document.startsWith('/') && scope?.site === row.site && scope.document === row.document
    && row.position_end > row.position_start
    && (metadata.every(value => value === null) || metadata.every(value => value !== null))
}

// UPDATE RETURNING emits exactly stored columns and can only save pending,
// fully stamped proposals. Even null/undefined application columns are invalid.
const savedReviewAnnotation = proposalColumns.strict().refine(validProposalColumns).refine(row =>
  row.withdrawn_at === null && row.base_commit !== null && row.source_path !== null && row.revision !== null)

// Both privileged reads always project these two nullable columns together.
// Missing columns are malformed storage results, not an implicit pending state.
const reviewAnnotation = proposalColumns.extend({
  proposal_state: z.enum(PROPOSAL_STATES).nullable(),
  approved_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict().refine(validProposalColumns).refine(row =>
  (row.proposal_state === null) === (row.approved_revision === null))

export function rowToRecord(row: AnnotationRow): MarginAnnotationRecord {
  const kind = kindForMotivation(row.motivation as Motivation)
  const annotation = textAnnotationSchema.parse({
    id: row.id,
    kind,
    target: {
      nodeId: row.node_id,
      positionUnit: row.position_unit,
      position: { start: row.position_start, end: row.position_end },
      quote: {
        exact: row.quote_exact,
        prefix: row.quote_prefix,
        suffix: row.quote_suffix,
      },
    },
    geometryCache: [],
    ...(kind === 'highlight'
      ? { appearance: { color: row.color ?? DEFAULT_HIGHLIGHT_COLOR } }
      : {
          body: row.body,
          ...(kind === 'note' && row.color
            ? { appearance: { color: row.color } }
            : {}),
        }),
  })

  const state = row.proposal_state == null ? undefined : z.enum(PROPOSAL_STATES).parse(row.proposal_state)
  if (state && kind !== 'proposal') throw new Error('state on nonproposal')
  const approvedRevision = row.approved_revision == null ? undefined : z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(row.approved_revision)
  if (approvedRevision !== undefined && !state) throw new Error('approved revision without state')
  return {
    ...(state ? { proposalState: state } : {}),
    ...(approvedRevision !== undefined ? { approvedRevision } : {}),
    id: row.id,
    site: row.site,
    document: row.document,
    creator: row.creator,
    visibility: row.visibility as MarginVisibility,
    parentId: row.parent_id,
    structId: row.struct_id,
    color: row.color,
    annotation,
    created: row.created,
    modified: row.modified,
    // A proposal stored before migration 0003 has no base commit; it reads
    // back without proposal fields rather than with invented ones.
    ...(kind === 'proposal' && row.base_commit && row.source_path && row.revision
      ? {
          proposal: {
            baseCommit: row.base_commit,
            sourcePath: row.source_path,
            revision: Number(row.revision),
            withdrawnAt: row.withdrawn_at,
          },
        }
      : {}),
    ...(kind === 'proposal' ? { withdrawnAt: row.withdrawn_at } : {}),
  }
}

export function recordToRow(record: MarginAnnotationRecord) {
  const { annotation } = record
  return {
    id: record.id,
    site: record.site,
    document: record.document,
    creator: record.creator,
    visibility: record.visibility,
    motivation: motivationForKind(annotation.kind),
    parentId: record.parentId,
    structId: record.structId,
    nodeId: annotation.target.nodeId,
    positionStart: annotation.target.position.start,
    positionEnd: annotation.target.position.end,
    positionUnit: annotation.target.positionUnit ?? 'utf16',
    quoteExact: annotation.target.quote.exact,
    quotePrefix: annotation.target.quote.prefix,
    quoteSuffix: annotation.target.quote.suffix,
    body: annotation.kind === 'highlight' ? null : annotation.body,
    color: record.color,
    created: record.created,
    modified: record.modified,
    baseCommit: record.proposal?.baseCommit ?? null,
    sourcePath: record.proposal?.sourcePath ?? null,
    revision: record.proposal?.revision ?? null,
    withdrawnAt: record.proposal?.withdrawnAt ?? record.withdrawnAt ?? null,
  }
}

function projectedRows(result: unknown, limit?: number): MarginAnnotationRecord[] {
  const rows = z.object({ success: z.literal(true), results: z.array(z.record(z.unknown())) }).parse(result).results
  if (limit !== undefined && rows.length > limit) throw new Error('invalid projected result count')
  const columns = [...ANNOTATION_COLUMNS.split(', '), 'proposal_state']
  return rows.map(row => {
    if (Object.keys(row).length !== columns.length || columns.some(column => !(column in row))) throw new Error('invalid state projection columns')
    z.enum(PROPOSAL_STATES).nullable().parse(row.proposal_state)
    return rowToRecord(row as AnnotationRow)
  })
}

export class D1MarginRepository implements MarginRepository {
  constructor(private readonly database: D1Database) {}

  private statement({ sql, params }: Query) {
    const prepared = this.database.prepare(sql)
    return params.length > 0 ? prepared.bind(...params) : prepared
  }

  async reviewProposal(scope: TenantScope, id: string, principal: Principal,
    input: ProposalReview | { revision: number }, at: string, apply: boolean): Promise<ReviewMutationResult> {
    principalSchema.parse(principal)
    reviewSite.parse(scope.site)
    if (splitSource(scope.site + scope.document)?.document !== scope.document) throw new Error('invalid review document')
    reviewKey.shape.id.parse(id)
    reviewKey.shape.created.parse(at)
    const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1)
    const reviewInput = z.object({ revision, decision: z.string().trim().min(1).max(200), comments: z.string().max(8000),
      body: z.string().min(1).max(maxBodyLength('editing')).optional(), baseCommit: z.string().refine(isFullCommitId).optional() }).strict()
    input = apply ? z.object({ revision }).strict().parse(input) : reviewInput.parse(input)
    const inspect = async () => {
      const result = await this.statement(reviewTargetQuery(scope,id,principal)).all()
      const rows = z.object({ success: z.literal(true), results: z.array(z.object({
        authorized: z.union([z.literal(0),z.literal(1)]), annotation: z.string().nullable(),
      }).strict()).length(1) }).parse(result).results
      const row = rows[0]
      if (!row.authorized) {
        if (row.annotation !== null) throw new Error('unauthorized review target projection')
        return { status: 'forbidden' as const }
      }
      if (row.annotation === null) return { status: 'missing' as const }
      const record = reviewAnnotation.parse(JSON.parse(row.annotation))
      if (record.site !== scope.site || record.document !== scope.document || record.id !== id) throw new Error('invalid review target scope')
      return { status: 'found' as const, row: record }
    }
    const target = await inspect()
    if (target.status !== 'found') return target
    const current = target.row
    if (current.withdrawn_at || current.proposal_state || current.revision !== input.revision
        || !current.base_commit || !current.source_path) return { status: 'conflict' }
    parseHunks(current.body)
    const reviewBody = (input as ProposalReview).body
    if (!apply && reviewBody !== undefined) parseHunks(reviewBody)
    // One statement is the effect boundary. Any exception or malformed result
    // after this call is outcome-unknown; never retry or report a rollback here.
    const result = await this.statement(reviewMutationQuery(scope,id,principal,input,at,apply)).all()
    const rows = z.object({ success: z.literal(true), results: z.array(z.record(z.unknown())).max(1) }).parse(result).results
    if (rows.length === 0) {
      const diagnostic = await inspect()
      return diagnostic.status === 'found' ? { status: 'conflict' } : diagnostic
    }
    if (apply) {
      const approved = z.object({ proposal_id: reviewKey.shape.id, site: reviewSite, document: z.string(),
        creator: z.string().refine(isStoredPrincipalKey), visibility: z.enum(['private','public']),
        body: z.string().min(1).max(maxBodyLength('editing')), base_commit: z.string().refine(isFullCommitId),
        source_path: z.string().refine(isRepoRelativePath), revision,
        approved_by: z.string(), approved_at: reviewKey.shape.created, state: z.literal('approved'),
      }).strict().parse(rows[0])
      if (approved.proposal_id !== id || approved.site !== scope.site || approved.document !== scope.document
          || approved.revision !== input.revision || approved.approved_by !== principalKey(principal) || approved.approved_at !== at
          || approved.creator !== current.creator || approved.body !== current.body || approved.base_commit !== current.base_commit
          || approved.source_path !== current.source_path) throw new Error('invalid approval result binding')
      return { status: 'approved', approvedRevision: approved.revision }
    }
    const saved = savedReviewAnnotation.parse(rows[0])
    const review = input as ProposalReview
    const nextRevision = input.revision + Number(review.body !== undefined || review.baseCommit !== undefined)
    if (saved.id !== id || saved.site !== scope.site || saved.document !== scope.document || saved.creator !== current.creator
        || saved.revision !== nextRevision || saved.withdrawn_at !== null
        || saved.body !== (review.body ?? current.body) || saved.base_commit !== (review.baseCommit ?? current.base_commit)
        || saved.source_path !== current.source_path || saved.modified !== at) throw new Error('invalid saved result binding')
    return { status: 'saved', record: rowToRecord(saved) }
  }

  async listReviewProposals(principal: Principal, options: ReviewListOptions): Promise<ReviewListResult> {
    principalSchema.parse(principal)
    reviewOptions.parse(options)
    const result = await this.statement(listReviewProposalsQuery(principal, options)).all()
    const { results } = z.object({
      success: z.literal(true), results: z.array(z.record(z.unknown())),
    }).parse(result)
    const authorities: z.infer<typeof reviewAuthority>[] = []
    const rows: z.infer<typeof reviewAnnotation>[] = []
    for (const item of results) {
      const { review_kind, review_identity_id, review_role, review_site, ...row } = item
      if (review_kind === 'authority') {
        authorities.push(reviewAuthority.parse({ review_identity_id, review_role, review_site }))
        const columns = [...ANNOTATION_COLUMNS.split(', '), 'proposal_state', 'approved_revision']
        if (Object.keys(row).length !== columns.length || columns.some(column => row[column] !== null)) {
          throw new Error('invalid review authority projection')
        }
      } else if (review_kind === 'annotation') {
        if (review_identity_id !== null || review_role !== null || review_site !== null) {
          throw new Error('invalid review annotation projection')
        }
        rows.push(reviewAnnotation.parse(row))
      } else {
        throw new Error('invalid review result tag')
      }
    }
    const first = authorities[0]
    const seen = new Set<string | null>()
    for (const authority of authorities) {
      if (authority.review_identity_id !== first.review_identity_id || authority.review_role !== first.review_role
          || seen.has(authority.review_site)) throw new Error('inconsistent review authority')
      seen.add(authority.review_site)
    }
    if (seen.has(null) && seen.size > 1) throw new Error('inconsistent review mappings')
    const sites = new Set(authorities.filter(authority => authority.review_role === 'admin'
      && authority.review_site !== null
      && (options.site === undefined || options.site === authority.review_site)).map(authority => authority.review_site))
    if (rows.length > options.limit || rows.some(row => !sites.has(row.site)
        || (options.document !== undefined && row.document !== options.document)
        || row.withdrawn_at !== null
        || (row.proposal_state ?? 'pending') !== (options.state ?? 'pending')
        || ((row.proposal_state == null) !== (row.approved_revision == null)))) {
      throw new Error('invalid review page scope or bound')
    }
    return { authorized: sites.size > 0, records: rows.map(rowToRecord) }
  }

  async listAnnotations(
    scope: TenantScope,
    viewer: ViewerKey,
    options: ListOptions = {},
    principal?: Principal | null,
  ): Promise<MarginAnnotationRecord[]> {
    const result = await this.statement(listAnnotationsQuery(scope, viewer, options, principal)).all()
    return projectedRows(result, options.limit)
  }

  async listOwnAnnotations(
    site: string,
    prefix: string,
    owner: string,
    options: OwnListOptions,
  ): Promise<MarginAnnotationRecord[]> {
    const result = await this.statement(listOwnAnnotationsQuery(site, prefix, owner, options)).all()
    return projectedRows(result, options.limit)
  }

  async findAnnotation(
    scope: TenantScope,
    id: string,
    viewer: ViewerKey,
    principal?: Principal | null,
  ): Promise<MarginAnnotationRecord | null> {
    const result = await this.statement(findAnnotationQuery(scope, id, viewer, principal)).all()
    return projectedRows(result, 1)[0] ?? null
  }

  async insertAnnotation(record: MarginAnnotationRecord): Promise<void> {
    await this.statement(insertAnnotationQuery(recordToRow(record))).run()
  }

  async findIdempotencyReceipt(
    scope: TenantScope,
    owner: string,
    key: string,
  ): Promise<IdempotencyReceipt | null> {
    const row = await this.statement(
      findIdempotencyReceiptQuery(scope, owner, key),
    ).first<{ fingerprint: string; annotation_id: string }>()
    return row
      ? { fingerprint: row.fingerprint, annotationId: row.annotation_id }
      : null
  }

  async insertAnnotationWithReceipt(
    record: MarginAnnotationRecord,
    receipt: { key: string; fingerprint: string },
  ): Promise<void> {
    if (!this.database.batch) {
      throw new Error('MARGIN_DB does not support atomic D1 batches')
    }
    await this.database.batch([
      this.statement(insertAnnotationQuery(recordToRow(record))),
      this.statement(
        insertIdempotencyReceiptQuery({
          creator: record.creator,
          site: record.site,
          document: record.document,
          key: receipt.key,
          fingerprint: receipt.fingerprint,
          annotationId: record.id,
          created: record.created,
        }),
      ),
    ])
  }

  async updateAnnotation(
    scope: TenantScope,
    id: string,
    owner: string,
    patch: AnnotationPatch,
  ): Promise<MarginAnnotationRecord | null> {
    const result = await this.statement(
      updateAnnotationQuery(scope, id, owner, patch),
    ).run()
    if ((result.meta?.changes ?? 0) === 0) return null
    return this.findAnnotation(scope, id, owner)
  }

  async countReplies(scope: TenantScope, id: string): Promise<number> {
    const row = await this.statement(countRepliesQuery(scope, id)).first<{
      replies: number
    }>()
    return Number(row?.replies ?? 0)
  }

  async tombstoneAnnotation(
    scope: TenantScope,
    id: string,
    owner: string,
    modified: string,
  ): Promise<boolean> {
    const result = await this.statement(
      tombstoneAnnotationQuery(scope, id, owner, TOMBSTONE_BODY, modified),
    ).run()
    return (result.meta?.changes ?? 0) > 0
  }

  async withdrawProposal(
    scope: TenantScope,
    id: string,
    owner: string,
    at: string,
  ): Promise<boolean> {
    const result = await this.statement(
      withdrawProposalQuery(scope, id, owner, at),
    ).run()
    return (result.meta?.changes ?? 0) > 0
  }

  async deleteAnnotation(
    scope: TenantScope,
    id: string,
    owner: string,
  ): Promise<boolean> {
    const result = await this.statement(
      deleteAnnotationQuery(scope, id, owner),
    ).run()
    return (result.meta?.changes ?? 0) > 0
  }

  async getPrefs(owner: string): Promise<MarginPrefs> {
    const row = await this.statement(getPrefsQuery(owner)).first<PrefsRow>()
    if (!row) {
      return {
        creator: owner,
        defaultVisibility: DEFAULT_VISIBILITY,
        created: '',
        modified: '',
      }
    }
    return {
      creator: row.creator,
      defaultVisibility: row.default_visibility as MarginVisibility,
      created: row.created,
      modified: row.modified,
    }
  }

  async setDefaultVisibility(
    owner: string,
    defaultVisibility: MarginVisibility,
    now: string,
  ): Promise<MarginPrefs> {
    await this.statement(upsertPrefsQuery(owner, defaultVisibility, now)).run()
    return this.getPrefs(owner)
  }

  async listProgress(owner: string, scope: ProgressScope): Promise<ProgressRow[]> {
    const { results } = await this.statement(
      listProgressQuery(owner, scope.site, scope.book),
    ).all<ProgressDbRow>()
    return (results ?? []).map((row) => ({
      item: row.item,
      solved: row.solved === 1,
      solvedAt: row.solved_at,
      draft: row.draft,
      draftUpdated: row.draft_updated,
    }))
  }

  async mergeProgress(
    owner: string,
    scope: ProgressScope,
    items: ProgressItem[],
    now: string,
    cap: number,
  ): Promise<number> {
    // No batch on this binding's interface: one upsert per item. A client sends
    // only what changed, and the route caps a request at a few hundred.
    let refused = 0
    for (const item of items) {
      const result = await this.statement(
        mergeProgressQuery(owner, scope.site, scope.book, item, now, cap),
      ).run()
      if ((result.meta?.changes ?? 0) === 0) refused += 1
    }
    return refused
  }
}

type ProgressDbRow = {
  item: string
  solved: number
  solved_at: string | null
  draft: string | null
  draft_updated: string | null
}
