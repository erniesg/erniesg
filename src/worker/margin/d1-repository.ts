import { textAnnotationSchema } from '../../annotations/annotations'
import type { D1Database } from './d1'
import {
  countRepliesQuery,
  deleteAnnotationQuery,
  findAnnotationQuery,
  findIdempotencyReceiptQuery,
  getPrefsQuery,
  insertAnnotationQuery,
  insertIdempotencyReceiptQuery,
  listAnnotationsQuery,
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
  type AnnotationPatch,
  type IdempotencyReceipt,
  type ListOptions,
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
}

type PrefsRow = {
  creator: string
  default_visibility: string
  created: string
  modified: string
}

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

  return {
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

export class D1MarginRepository implements MarginRepository {
  constructor(private readonly database: D1Database) {}

  private statement({ sql, params }: Query) {
    const prepared = this.database.prepare(sql)
    return params.length > 0 ? prepared.bind(...params) : prepared
  }

  async listAnnotations(
    scope: TenantScope,
    viewer: ViewerKey,
    options: ListOptions = {},
  ): Promise<MarginAnnotationRecord[]> {
    const { results } = await this.statement(
      listAnnotationsQuery(scope, viewer, options),
    ).all<AnnotationRow>()
    return results.map(rowToRecord)
  }

  async findAnnotation(
    scope: TenantScope,
    id: string,
    viewer: ViewerKey,
  ): Promise<MarginAnnotationRecord | null> {
    const row = await this.statement(
      findAnnotationQuery(scope, id, viewer),
    ).first<AnnotationRow>()
    return row ? rowToRecord(row) : null
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
