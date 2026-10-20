/**
 * The D1 implementation of the editorial store.
 *
 * It is the only module in `src/editorial/` that talks to a database. Every
 * statement it runs comes from `queries.ts`, so the statements the tests run
 * are the statements the writer runs.
 *
 * ## What it guarantees
 *
 * - **A write is one transaction.** `append` puts the record, the
 *   aggregate's state change and the idempotency receipt into one `batch()`.
 *   A reader never sees a record without its receipt, or a receipt without
 *   its record.
 * - **A refused write writes nothing.** The compare-and-swap guard lives in
 *   the insert statement itself, so a lost race inserts nothing, updates
 *   nothing and receipts nothing.
 * - **A row is read back through its own schema.** Every read parses the
 *   row with the zod schema of its kind, so a row that does not satisfy the
 *   record contract is a hard failure rather than a shrug.
 */
import { canonicalRecordValue } from './ids'
import {
  EDITORIAL_INITIAL_STATES,
  EDITORIAL_RECORD_TABLES,
  insertRecordQuery,
  insertReceiptQuery,
  selectAggregateStateQuery,
  selectBackfillProgressQuery,
  selectRecordQuery,
  selectRecordsQuery,
  selectReceiptQuery,
  selectSwitchStateQuery,
  updateAggregateStateQuery,
  upsertBackfillProgressQuery,
  upsertSwitchStateQuery,
  type Query,
} from './queries'
import {
  editorialApprovalSchema,
  editorialCandidateSchema,
  editorialDecisionSchema,
  editorialRecordSchema,
  editorialReleaseSchema,
  editorialRevisionSchema,
  editorialSupersessionSchema,
  editorialValidationSchema,
  type EditorialRecord,
  type EditorialRecordKind,
} from './records'
import {
  INITIAL_SWITCH_STATE,
  type EditorialAggregateTransition,
  type EditorialAppendInput,
  type EditorialAppendOutcome,
  type EditorialReceipt,
  type EditorialRepository,
  type EditorialRequestKey,
  type EditorialSwitchState,
} from './repository'
import type { D1Database, D1PreparedStatement } from './d1'
import type { EditorialAggregateKind } from './queries'

/* ---------------------------------------------------------------- row types */

type Row = Record<string, unknown>

function text(row: Row, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') {
    throw new Error(`the editorial store row is missing its ${column}`)
  }
  return value
}

function optionalText(row: Row, column: string): string | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new Error(`the editorial store row has a malformed ${column}`)
  }
  return value
}

function json<T>(row: Row, column: string): T {
  return JSON.parse(text(row, column)) as T
}

/** The JSON of a value, in the repository's own canonical form. */
function encode(value: unknown): string {
  return JSON.stringify(canonicalRecordValue(value))
}

/* ------------------------------------------------------------------ mapping */

function rowToRevision(row: Row) {
  return editorialRevisionSchema.parse({
    kind: 'revision',
    version: text(row, 'version'),
    id: text(row, 'id'),
    contentHash: text(row, 'content_hash'),
    documentSha256: text(row, 'document_sha256'),
    ...(optionalText(row, 'bundle_sha256') === null
      ? {}
      : { bundleSha256: optionalText(row, 'bundle_sha256') }),
    ...(optionalText(row, 'semantic_receipt_sha256') === null
      ? {}
      : { semanticReceiptSha256: optionalText(row, 'semantic_receipt_sha256') }),
    sourceBinding: json(row, 'source_binding'),
    schemaVersions: json(row, 'schema_versions'),
    rendering: json(row, 'rendering'),
    author: json(row, 'author'),
    created: text(row, 'created'),
  })
}

function rowToDecision(row: Row) {
  return editorialDecisionSchema.parse({
    kind: 'decision',
    version: text(row, 'version'),
    id: text(row, 'id'),
    subject: {
      revisionId: text(row, 'revision_id'),
      contentHash: text(row, 'content_hash'),
      documentSha256: text(row, 'document_sha256'),
      ...(optionalText(row, 'bundle_sha256') === null
        ? {}
        : { bundleSha256: optionalText(row, 'bundle_sha256') }),
    },
    outcome: text(row, 'outcome'),
    actor: json(row, 'actor'),
    ...(optionalText(row, 'rationale') === null
      ? {}
      : { rationale: optionalText(row, 'rationale') }),
    decidedAt: text(row, 'decided_at'),
  })
}

function rowToCandidate(row: Row) {
  return editorialCandidateSchema.parse({
    kind: 'candidate',
    version: text(row, 'version'),
    id: text(row, 'id'),
    revisionId: text(row, 'revision_id'),
    contentHash: text(row, 'content_hash'),
    documentSha256: text(row, 'document_sha256'),
    ...(optionalText(row, 'bundle_sha256') === null
      ? {}
      : { bundleSha256: optionalText(row, 'bundle_sha256') }),
    target: json(row, 'target'),
    artifacts: json(row, 'artifacts'),
    artifactSetSha256: text(row, 'artifact_set_sha256'),
    requiredValidationChecks: json(row, 'required_validation_checks'),
    author: json(row, 'author'),
    created: text(row, 'created'),
  })
}

function rowToValidation(row: Row) {
  return editorialValidationSchema.parse({
    kind: 'validation',
    version: text(row, 'version'),
    id: text(row, 'id'),
    check: text(row, 'check_name'),
    subject: {
      candidateId: text(row, 'candidate_id'),
      revisionId: text(row, 'revision_id'),
      contentHash: text(row, 'content_hash'),
      documentSha256: text(row, 'document_sha256'),
      ...(optionalText(row, 'bundle_sha256') === null
        ? {}
        : { bundleSha256: optionalText(row, 'bundle_sha256') }),
      targetId: text(row, 'target_id'),
      artifactSetSha256: text(row, 'artifact_set_sha256'),
    },
    outcome: text(row, 'outcome'),
    evidence: json(row, 'evidence'),
    actor: json(row, 'actor'),
    validatedAt: text(row, 'validated_at'),
  })
}

function rowToApproval(row: Row) {
  return editorialApprovalSchema.parse({
    kind: 'approval',
    version: text(row, 'version'),
    id: text(row, 'id'),
    candidateId: text(row, 'candidate_id'),
    subject: {
      candidateId: text(row, 'candidate_id'),
      revisionId: text(row, 'revision_id'),
      contentHash: text(row, 'content_hash'),
      documentSha256: text(row, 'document_sha256'),
      ...(optionalText(row, 'bundle_sha256') === null
        ? {}
        : { bundleSha256: optionalText(row, 'bundle_sha256') }),
      targetId: text(row, 'target_id'),
      artifactSetSha256: text(row, 'artifact_set_sha256'),
    },
    actor: json(row, 'actor'),
    approvedAt: text(row, 'approved_at'),
  })
}

function rowToRelease(row: Row) {
  return editorialReleaseSchema.parse({
    kind: 'release',
    version: text(row, 'version'),
    id: text(row, 'id'),
    candidateId: text(row, 'candidate_id'),
    revisionId: text(row, 'revision_id'),
    contentHash: text(row, 'content_hash'),
    sourceBinding: json(row, 'source_binding'),
    schemaVersions: json(row, 'schema_versions'),
    rendering: json(row, 'rendering'),
    validations: json(row, 'validations'),
    approval: json(row, 'approval'),
    target: json(row, 'target'),
    artifacts: json(row, 'artifacts'),
    artifactSetSha256: text(row, 'artifact_set_sha256'),
    producer: json(row, 'producer'),
    releasedAt: text(row, 'released_at'),
  })
}

function rowToSupersession(row: Row) {
  return editorialSupersessionSchema.parse({
    kind: 'supersession',
    version: text(row, 'version'),
    id: text(row, 'id'),
    subjectReleaseId: text(row, 'subject_release_id'),
    supersedingReleaseId: optionalText(row, 'superseding_release_id'),
    reason: text(row, 'reason'),
    actor: json(row, 'actor'),
    at: text(row, 'at'),
  })
}

const ROW_READERS = {
  revision: rowToRevision,
  decision: rowToDecision,
  candidate: rowToCandidate,
  validation: rowToValidation,
  approval: rowToApproval,
  release: rowToRelease,
  supersession: rowToSupersession,
} as const

/** The columns of each kind's row, in the order the insert uses. */
const ROW_COLUMNS = {
  revision: [
    'id',
    'kind',
    'version',
    'content_hash',
    'document_sha256',
    'bundle_sha256',
    'semantic_receipt_sha256',
    'source_binding',
    'schema_versions',
    'rendering',
    'author',
    'state',
    'created',
  ],
  decision: [
    'id',
    'kind',
    'version',
    'revision_id',
    'content_hash',
    'document_sha256',
    'bundle_sha256',
    'outcome',
    'actor',
    'rationale',
    'decided_at',
  ],
  candidate: [
    'id',
    'kind',
    'version',
    'revision_id',
    'content_hash',
    'document_sha256',
    'bundle_sha256',
    'target_id',
    'target',
    'artifacts',
    'artifact_set_sha256',
    'required_validation_checks',
    'author',
    'state',
    'created',
  ],
  validation: [
    'id',
    'kind',
    'version',
    'check_name',
    'candidate_id',
    'revision_id',
    'content_hash',
    'document_sha256',
    'bundle_sha256',
    'target_id',
    'artifact_set_sha256',
    'outcome',
    'evidence',
    'actor',
    'validated_at',
  ],
  approval: [
    'id',
    'kind',
    'version',
    'candidate_id',
    'revision_id',
    'content_hash',
    'document_sha256',
    'bundle_sha256',
    'target_id',
    'artifact_set_sha256',
    'actor',
    'approved_at',
  ],
  release: [
    'id',
    'kind',
    'version',
    'candidate_id',
    'revision_id',
    'content_hash',
    'source_binding',
    'schema_versions',
    'rendering',
    'validations',
    'approval',
    'target_id',
    'target',
    'artifacts',
    'artifact_set_sha256',
    'producer',
    'state',
    'released_at',
  ],
  supersession: [
    'id',
    'kind',
    'version',
    'subject_release_id',
    'superseding_release_id',
    'reason',
    'actor',
    'at',
  ],
} as const

/** The column values of one record row. */
function recordValues(
  record: EditorialRecord,
  initialState?: string,
): unknown[] {
  switch (record.kind) {
    case 'revision':
      return [
        record.id,
        record.kind,
        record.version,
        record.contentHash,
        record.documentSha256,
        record.bundleSha256 ?? null,
        record.semanticReceiptSha256 ?? null,
        encode(record.sourceBinding),
        encode(record.schemaVersions),
        encode(record.rendering),
        encode(record.author),
        initialState ?? EDITORIAL_INITIAL_STATES.revision,
        record.created,
      ]
    case 'decision':
      return [
        record.id,
        record.kind,
        record.version,
        record.subject.revisionId,
        record.subject.contentHash,
        record.subject.documentSha256,
        record.subject.bundleSha256 ?? null,
        record.outcome,
        encode(record.actor),
        record.rationale ?? null,
        record.decidedAt,
      ]
    case 'candidate':
      return [
        record.id,
        record.kind,
        record.version,
        record.revisionId,
        record.contentHash,
        record.documentSha256,
        record.bundleSha256 ?? null,
        record.target.id,
        encode(record.target),
        encode(record.artifacts),
        record.artifactSetSha256,
        encode(record.requiredValidationChecks),
        encode(record.author),
        initialState ?? EDITORIAL_INITIAL_STATES.candidate,
        record.created,
      ]
    case 'validation':
      return [
        record.id,
        record.kind,
        record.version,
        record.check,
        record.subject.candidateId,
        record.subject.revisionId,
        record.subject.contentHash,
        record.subject.documentSha256,
        record.subject.bundleSha256 ?? null,
        record.subject.targetId,
        record.subject.artifactSetSha256,
        record.outcome,
        encode(record.evidence),
        encode(record.actor),
        record.validatedAt,
      ]
    case 'approval':
      return [
        record.id,
        record.kind,
        record.version,
        record.candidateId,
        record.subject.revisionId,
        record.subject.contentHash,
        record.subject.documentSha256,
        record.subject.bundleSha256 ?? null,
        record.subject.targetId,
        record.subject.artifactSetSha256,
        encode(record.actor),
        record.approvedAt,
      ]
    case 'release':
      return [
        record.id,
        record.kind,
        record.version,
        record.candidateId,
        record.revisionId,
        record.contentHash,
        encode(record.sourceBinding),
        encode(record.schemaVersions),
        encode(record.rendering),
        encode(record.validations),
        encode(record.approval),
        record.target.id,
        encode(record.target),
        encode(record.artifacts),
        record.artifactSetSha256,
        encode(record.producer),
        initialState ?? EDITORIAL_INITIAL_STATES.release,
        record.releasedAt,
      ]
    case 'supersession':
      return [
        record.id,
        record.kind,
        record.version,
        record.subjectReleaseId,
        record.supersedingReleaseId,
        record.reason,
        encode(record.actor),
        record.at,
      ]
  }
}

/* ------------------------------------------------------------- the repository */

/** The D1-backed editorial store. */
export class D1EditorialRepository implements EditorialRepository {
  constructor(private readonly database: D1Database) {}

  private statement({ sql, params }: Query): D1PreparedStatement {
    const prepared = this.database.prepare(sql)
    return params.length > 0 ? prepared.bind(...params) : prepared
  }

  async listRecords(kind: EditorialRecordKind): Promise<EditorialRecord[]> {
    const { results } = await this.statement(selectRecordsQuery(kind)).all<Row>()
    const reader = ROW_READERS[kind]
    return results.map((row) => reader(row) as EditorialRecord)
  }

  async findRecord(
    kind: EditorialRecordKind,
    id: string,
  ): Promise<EditorialRecord | null> {
    const row = await this.statement(selectRecordQuery(kind, id)).first<Row>()
    if (!row) return null
    return ROW_READERS[kind](row) as EditorialRecord
  }

  async readAggregateState(
    kind: EditorialAggregateKind,
    id: string,
  ): Promise<string | null> {
    const row = await this.statement(
      selectAggregateStateQuery(kind, id),
    ).first<{ state?: string }>()
    return row?.state ?? null
  }

  async findReceipt(
    key: EditorialRequestKey,
  ): Promise<EditorialReceipt | null> {
    const row = await this.statement(
      selectReceiptQuery({
        actor: key.actor,
        recordKind: key.recordKind,
        requestKey: key.requestKey,
      }),
    ).first<{ fingerprint?: string; record_id?: string; created?: string }>()
    if (!row) return null
    return {
      fingerprint: row.fingerprint ?? '',
      recordId: row.record_id ?? '',
      created: row.created ?? '',
    }
  }

  async append(input: EditorialAppendInput): Promise<EditorialAppendOutcome> {
    const batch = this.database.batch
    if (!batch) {
      return {
        ok: false,
        refusal: {
          code: 'editorial_store_unavailable',
          message: 'the editorial store does not support atomic batches',
        },
      }
    }

    const kind = input.record.kind
    const table = EDITORIAL_RECORD_TABLES[kind]
    const columns = ROW_COLUMNS[kind]
    const values = recordValues(input.record, input.initialState)
    if (columns.length !== values.length) {
      // A row whose columns and values disagree would be written with the
      // values shifted, and the store would hold a record that is not the
      // record. It is a bug in this module, not a refusal.
      throw new Error(
        `the editorial store row for a ${kind} has ${columns.length} columns and ${values.length} values`,
      )
    }
    const transition: EditorialAggregateTransition | undefined = input.transition

    const statements: D1PreparedStatement[] = [
      this.statement(
        insertRecordQuery({
          table,
          columns,
          values,
          ...(transition
            ? {
                guard: {
                  kind: transition.kind,
                  id: transition.id,
                  expected: transition.expected,
                },
              }
            : {}),
        }),
      ),
    ]
    if (transition) {
      statements.push(this.statement(updateAggregateStateQuery(transition)))
    }
    if (input.receipt) {
      statements.push(
        this.statement(
          insertReceiptQuery({
            actor: input.receipt.actor,
            recordKind: input.receipt.recordKind,
            requestKey: input.receipt.requestKey,
            fingerprint: input.receipt.fingerprint,
            recordId: input.record.id,
            created: input.receipt.created,
            table,
          }),
        ),
      )
    }

    let results
    try {
      results = await batch.call(this.database, statements)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The partial unique index on `editorial_releases (target_id) WHERE
      // state = 'release-released'` is the storage-level "one current
      // release per target" rule. It fires when two writers both believed
      // they were first.
      if (message.includes('editorial_releases.target_id')) {
        return {
          ok: false,
          refusal: {
            code: 'target_already_released',
            message: `the store refused the write: ${message}`,
          },
        }
      }
      if (/UNIQUE constraint failed/i.test(message)) {
        return {
          ok: false,
          refusal: {
            code: 'record_already_exists',
            message: `the store refused the write: ${message}`,
          },
        }
      }
      return {
        ok: false,
        refusal: {
          code: 'editorial_store_unavailable',
          message: `the store refused the write: ${message}`,
        },
      }
    }

    const written = (results[0]?.meta?.changes ?? 0) > 0
    if (!written) {
      return {
        ok: false,
        refusal: {
          code: 'cas_conflict',
          message:
            'the aggregate moved between the read and the write: nothing was written',
        },
      }
    }
    return { ok: true, written: true }
  }

  async readSwitchState(): Promise<EditorialSwitchState> {
    const row = await this.statement(selectSwitchStateQuery()).first<{
      switched_at?: string | null
      rolled_back_at?: string | null
    }>()
    if (!row) return INITIAL_SWITCH_STATE
    return {
      switchedAt: row.switched_at ?? null,
      rolledBackAt: row.rolled_back_at ?? null,
    }
  }

  async writeSwitchState(state: EditorialSwitchState): Promise<void> {
    await this.statement(
      upsertSwitchStateQuery({
        switchedAt: state.switchedAt,
        rolledBackAt: state.rolledBackAt,
      }),
    ).run()
  }

  async readBackfillProgress(name: string): Promise<string | null> {
    const row = await this.statement(
      selectBackfillProgressQuery(name),
    ).first<{ cursor?: string | null }>()
    return row?.cursor ?? null
  }

  async writeBackfillProgress(
    name: string,
    cursor: string | null,
  ): Promise<void> {
    await this.statement(
      upsertBackfillProgressQuery({ name, cursor }),
    ).run()
  }
}

/**
 * Whether a stored row is a record this repository can read.
 *
 * It is the round-trip check: a row that came back as a record must parse
 * under the union schema, which every kind's own schema refines.
 */
export function isReadableRecord(value: unknown): value is EditorialRecord {
  return editorialRecordSchema.safeParse(value).success
}
