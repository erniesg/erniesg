import { textAnnotationSchema } from '../../annotations/annotations'
import type { D1Database } from './d1'
import {
  countRepliesQuery,
  deleteAnnotationQuery,
  findAnnotationQuery,
  getPrefsQuery,
  insertAnnotationQuery,
  listAnnotationsQuery,
  updateAnnotationQuery,
  upsertPrefsQuery,
  type Query,
} from './queries'
import {
  DEFAULT_VISIBILITY,
  type AnnotationPatch,
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
      : { body: row.body }),
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
}
