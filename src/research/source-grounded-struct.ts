import {
  verifyStructuredExtraction,
  type StructuredExtractionContext,
  type StructuredExtractionProposal,
  type VerifiedStructuredExtraction,
} from './structured-extraction'
import { sha256HexSync } from './sha256-sync'
import {
  readSourceEvidenceGraph,
  sourceEvidenceCandidateSetSha256,
  validateSourceEvidenceGraph,
  type PdfEvidenceCandidate,
  type PdfEvidenceObligation,
  type SourceEvidenceGraph,
} from './source-evidence-graph'

export const SOURCE_GROUNDED_STRUCT_SCHEMA_VERSION = '1.0.0' as const

export const GROUNDED_RECONCILIATION_DECISIONS = [
  'reading-order',
  'semantic-type',
  'join',
  'caption-asset-association',
  'table-structure',
  'formula-representation',
  'note-association',
  'citation-association',
  'link-destination',
  'boilerplate-classification',
  'preserve-source',
] as const

export type GroundedReconciliationDecision =
  (typeof GROUNDED_RECONCILIATION_DECISIONS)[number]

export type GroundedEvidenceSelection = {
  obligationId: string
  candidateId: string
  decision: GroundedReconciliationDecision
  disposition: 'accepted' | 'excluded-boilerplate' | 'failed'
}

export type GroundedObligationMaterialization = {
  obligationId: string
  candidateId: string
  sourceIds: string[]
  targets: Array<
    | { kind: 'node'; id: string }
    | { kind: 'asset'; id: string }
    | { kind: 'link'; id: string }
    | { kind: 'relationship'; id: string }
    | { kind: 'excluded-boilerplate'; id: string }
  >
}

export type SourceGroundedStructProposal = {
  schemaVersion: typeof SOURCE_GROUNDED_STRUCT_SCHEMA_VERSION
  evidenceGraphSha256: string
  candidateSetSha256: string
  selections: GroundedEvidenceSelection[]
  materializations: GroundedObligationMaterialization[]
  /** Semantic proposal only; the verifier rematerializes source text/assets. */
  structuredExtraction: StructuredExtractionProposal
}

export type SourceGroundingIssueCode =
  | 'invalid-proposal'
  | 'stale-evidence-graph'
  | 'stale-candidate-set'
  | 'unknown-obligation'
  | 'unknown-candidate'
  | 'candidate-does-not-support-obligation'
  | 'duplicate-obligation'
  | 'missing-obligation'
  | 'illegal-boilerplate-exclusion'
  | 'full-page-raster-as-semantics'
  | 'unresolved-table-semantics'
  | 'unresolved-formula-semantics'
  | 'failed-candidate'
  | 'missing-materialization'
  | 'duplicate-materialization'
  | 'duplicate-materialization-target'
  | 'invalid-materialization'
  | 'invalid-source-crosswalk'
  | 'semantic-role-mismatch'
  | 'invalid-source-fallback'
  | 'structured-verification-failed'

export type SourceGroundingIssue = {
  code: SourceGroundingIssueCode
  message: string
  obligationId?: string
  candidateId?: string
}

export type VerifiedSourceGroundedStructCandidate = {
  schemaVersion: typeof SOURCE_GROUNDED_STRUCT_SCHEMA_VERSION
  evidenceGraphSha256: string
  candidateSetSha256: string
  obligationLedgerSha256: string
  sourceOwnershipCrosswalkSha256: string
  providerSourceOwnershipCrosswalks: Array<{
    providerId: string
    sourceCount: number
    crosswalkSha256: string
  }>
  selections: Array<
    GroundedEvidenceSelection & {
      providerId: string
      sourceIds: string[]
    }
  >
  materializations: GroundedObligationMaterialization[]
  structuredExtraction: VerifiedStructuredExtraction
  readyForStruct: true
}

type SourceOwnership = {
  providerId: string
  sourceId: string
  kind: 'node' | 'asset' | 'link' | 'relationship'
  targetIds: string[]
}

export type SourceGroundedStructVerification =
  | {
      status: 'passed'
      output: VerifiedSourceGroundedStructCandidate
      issues: []
    }
  | { status: 'failed'; output: null; issues: SourceGroundingIssue[] }

const SHA256 = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort().join('\0')
  return actual === [...keys].sort().join('\0')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
  }
  return value
}

function parseProposal(value: unknown): SourceGroundedStructProposal | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'evidenceGraphSha256',
      'candidateSetSha256',
      'selections',
      'materializations',
      'structuredExtraction',
    ]) ||
    value.schemaVersion !== SOURCE_GROUNDED_STRUCT_SCHEMA_VERSION ||
    !SHA256.test(String(value.evidenceGraphSha256 ?? '')) ||
    !SHA256.test(String(value.candidateSetSha256 ?? '')) ||
    !Array.isArray(value.selections) ||
    !value.selections.every(
      (selection) =>
        isRecord(selection) &&
        exactKeys(selection, [
          'obligationId',
          'candidateId',
          'decision',
          'disposition',
        ]) &&
        ID.test(String(selection.obligationId ?? '')) &&
        ID.test(String(selection.candidateId ?? '')) &&
        (GROUNDED_RECONCILIATION_DECISIONS as readonly unknown[]).includes(
          selection.decision,
        ) &&
        ['accepted', 'excluded-boilerplate', 'failed'].includes(
          String(selection.disposition),
        ),
    ) ||
    !Array.isArray(value.materializations) ||
    !value.materializations.every(
      (materialization) =>
        isRecord(materialization) &&
        exactKeys(materialization, [
          'obligationId',
          'candidateId',
          'sourceIds',
          'targets',
        ]) &&
        ID.test(String(materialization.obligationId ?? '')) &&
        ID.test(String(materialization.candidateId ?? '')) &&
        Array.isArray(materialization.sourceIds) &&
        materialization.sourceIds.length > 0 &&
        materialization.sourceIds.every((sourceId) =>
          ID.test(String(sourceId)),
        ) &&
        Array.isArray(materialization.targets) &&
        materialization.targets.length > 0 &&
        materialization.targets.every(
          (target) =>
            isRecord(target) &&
            exactKeys(target, ['kind', 'id']) &&
            [
              'node',
              'asset',
              'link',
              'relationship',
              'excluded-boilerplate',
            ].includes(String(target.kind)) &&
            ID.test(String(target.id ?? '')),
        ),
    )
  ) {
    return null
  }
  return structuredClone(value) as SourceGroundedStructProposal
}

function issue(
  code: SourceGroundingIssueCode,
  message: string,
  details: Pick<SourceGroundingIssue, 'obligationId' | 'candidateId'> = {},
): SourceGroundingIssue {
  return { code, message, ...details }
}

function isFullPageRaster(candidate: PdfEvidenceCandidate) {
  return (
    candidate.kind === 'full-page-render' ||
    (isRecord(candidate.payload) &&
      candidate.payload.completePageRaster === true)
  )
}

function isSemanticStructure(candidate: PdfEvidenceCandidate) {
  if (
    /semantic|structure|cells?|latex|mathml|transcript/u.test(candidate.kind)
  ) {
    return true
  }
  return (
    isRecord(candidate.payload) &&
    (candidate.payload.semantic === true ||
      Array.isArray(candidate.payload.cells) ||
      typeof candidate.payload.latex === 'string' ||
      typeof candidate.payload.mathml === 'string')
  )
}

function boilerplateObligation(kind: string) {
  return /boilerplate|furniture|header|footer|page-number/u.test(kind)
}

function allowedMaterializationKinds(
  obligation: PdfEvidenceObligation | undefined,
  candidate: PdfEvidenceCandidate | undefined,
) {
  if (!obligation) return new Set<string>()
  switch (obligation.kind) {
    case 'source-text':
    case 'layout-region':
      return new Set(['node'])
    case 'ocr-text':
      return candidate !== undefined && isFullPageRaster(candidate)
        ? new Set(['asset'])
        : new Set(['node'])
    case 'source-object':
      return new Set(['asset'])
    case 'source-preserved-page':
      return candidate !== undefined && isFullPageRaster(candidate)
        ? new Set(['asset'])
        : new Set()
    case 'annotation-destination':
      return new Set(['link'])
    case 'reading-order':
      return new Set(['relationship'])
    case 'note-relationship':
    case 'citation-relationship':
    case 'cross-reference-relationship':
    case 'figure-relationship':
    case 'table-relationship':
    case 'equation-relationship':
      return new Set(['relationship'])
    default:
      return new Set()
  }
}

function semanticNodeType(candidate: PdfEvidenceCandidate) {
  const direct = [
    'title',
    'author',
    'affiliation',
    'abstract',
    'heading',
    'code',
    'table',
    'figure',
    'equation',
    'footnote',
    'reference',
  ].includes(candidate.kind)
    ? candidate.kind
    : null
  if (direct) return direct
  if (!isRecord(candidate.payload)) return null
  const declared = [candidate.payload.type, candidate.payload.role].find(
    (value) => typeof value === 'string',
  )
  return typeof declared === 'string' &&
    [
      'title',
      'author',
      'affiliation',
      'abstract',
      'heading',
      'code',
      'table',
      'figure',
      'equation',
      'footnote',
      'reference',
    ].includes(declared)
    ? declared
    : null
}

function sameBounds(
  left:
    | { x: number; y: number; width: number; height: number }
    | undefined,
  right:
    | { x: number; y: number; width: number; height: number }
    | undefined,
) {
  if (!left || !right) return false
  return (['x', 'y', 'width', 'height'] as const).every(
    (key) => Math.abs(left[key] - right[key]) <= 1e-9,
  )
}

function payloadId(payload: unknown) {
  if (!isRecord(payload)) return undefined
  return [
    payload.id,
    payload.objectId,
    payload.regionId,
    payload.relationshipId,
  ].find((value): value is string => typeof value === 'string')
}

/**
 * Resolve deterministic graph sources back to the exact immutable extraction
 * owners. The resulting projection is hashed into the verified output; model
 * materialization receipts never get to declare this ownership themselves.
 */
function deterministicSourceOwnership(
  graph: SourceEvidenceGraph,
  context: StructuredExtractionContext,
): SourceOwnership[] {
  return graph.bundles
    .flatMap(({ provider, sources }) =>
      sources.map((source) => ({ providerId: provider.id, source })),
    )
    .flatMap(({ providerId, source }): SourceOwnership[] => {
      if (source.kind === 'text-glyph-run' || source.kind === 'ocr-word') {
        const text = isRecord(source.payload) ? source.payload.text : undefined
        const matches = context.sourceRuns.filter(
          (run) =>
            run.page === source.page &&
            run.text === text &&
            sameBounds(run.bounds, source.box),
        )
        return matches.length === 1
          ? [
              {
                providerId,
                sourceId: source.id,
                kind: 'node',
                targetIds: [matches[0]!.id],
              },
            ]
          : []
      }
      if (source.kind === 'mineru-native-record') {
        const record = isRecord(source.payload) ? source.payload.record : null
        const text = isRecord(record)
          ? [record.text, record.content].find(
              (value): value is string => typeof value === 'string',
            )
          : undefined
        const matches = context.sourceRuns.filter(
          (run) =>
            run.page === source.page &&
            run.text === text &&
            sameBounds(run.bounds, source.box),
        )
        return matches.length === 1
          ? [
              {
                providerId,
                sourceId: source.id,
                kind: 'node',
                targetIds: [matches[0]!.id],
              },
            ]
          : []
      }
      if (source.kind === 'layout-region') {
        const id = payloadId(source.payload)
        const targetIds = context.sourceRuns
          .filter(({ regionId }) => regionId === id)
          .map(({ id: runId }) => runId)
          .sort()
        return targetIds.length > 0
          ? [{ providerId, sourceId: source.id, kind: 'node', targetIds }]
          : []
      }
      if (source.kind.endsWith('-object')) {
        const objectId = payloadId(source.payload)
        const matches = context.sourceAssets.filter(({ sourceObjectIds }) =>
          objectId === undefined ? false : sourceObjectIds.includes(objectId),
        )
        return matches.length === 1
          ? [
              {
                providerId,
                sourceId: source.id,
                kind: 'asset',
                targetIds: [matches[0]!.id],
              },
            ]
          : []
      }
      if (source.kind === 'page-geometry') {
        const matches = context.sourceAssets.filter(
          (asset) =>
            asset.kind === 'source-fallback' &&
            asset.page === source.page &&
            asset.bounds.x === 0 &&
            asset.bounds.y === 0 &&
            asset.bounds.width === 1 &&
            asset.bounds.height === 1,
        )
        return matches.length === 1
          ? [
              {
                providerId,
                sourceId: source.id,
                kind: 'asset',
                targetIds: [matches[0]!.id],
              },
            ]
          : []
      }
      if (source.kind === 'annotation-link-destination') {
        const id = payloadId(source.payload)
        const matches = (context.sourceLinks ?? []).filter(
          (link) =>
            (id !== undefined && link.id === id) ||
            (id === undefined &&
              link.page === source.page &&
              sameBounds(link.box, source.box)),
        )
        return matches.length === 1
          ? [
              {
                providerId,
                sourceId: source.id,
                kind: 'link',
                targetIds: [matches[0]!.id],
              },
            ]
          : []
      }
      if (
        source.kind === 'reading-order-edge' ||
        source.kind.endsWith('-relationship')
      ) {
        const id = payloadId(source.payload)
        const matches = (context.provenArtifacts ?? []).filter(
          (artifact) => artifact.id === id,
        )
        return matches.length === 1
          ? [
              {
                providerId,
                sourceId: source.id,
                kind: 'relationship',
                targetIds: [matches[0]!.id],
              },
            ]
          : []
      }
      return []
    })
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
}

/**
 * Close the graph ledger before materializing the existing structured
 * extraction contract. A failed or merely visual semantic obligation returns
 * no candidate, so downstream STRUCT code cannot mistake review evidence for
 * publication-ready semantics.
 */
export function verifySourceGroundedStructCandidate(
  graphInput: SourceEvidenceGraph,
  context: StructuredExtractionContext,
  proposalInput: unknown,
): SourceGroundedStructVerification {
  let graph: SourceEvidenceGraph
  try {
    validateSourceEvidenceGraph(graphInput)
    graph = graphInput
  } catch {
    return {
      status: 'failed',
      output: null,
      issues: [
        issue('invalid-proposal', 'The source evidence graph is invalid.'),
      ],
    }
  }
  const proposal = parseProposal(proposalInput)
  if (!proposal) {
    return {
      status: 'failed',
      output: null,
      issues: [issue('invalid-proposal', 'The grounded proposal is invalid.')],
    }
  }
  const issues: SourceGroundingIssue[] = []
  if (
    proposal.evidenceGraphSha256 !== graph.graphSha256 ||
    context.sourceSha256 !== graph.source.sha256 ||
    context.documentId !== graph.source.documentId
  ) {
    issues.push(
      issue(
        'stale-evidence-graph',
        'The proposal, deterministic context, and graph source are not the same frozen evidence state.',
      ),
    )
  }
  const expectedCandidateSetSha256 = sourceEvidenceCandidateSetSha256(graph)
  if (proposal.candidateSetSha256 !== expectedCandidateSetSha256) {
    issues.push(
      issue(
        'stale-candidate-set',
        'The proposal candidate set is stale or incomplete.',
      ),
    )
  }

  const reader = readSourceEvidenceGraph(graph)
  const sourceOwnership = deterministicSourceOwnership(graph, context)
  const sourceOwnershipById = new Map(
    sourceOwnership.map((entry) => [entry.sourceId, entry]),
  )
  const claimed = new Set<string>()
  const materializedSelections: VerifiedSourceGroundedStructCandidate['selections'] =
    []
  for (const selection of proposal.selections) {
    const obligation = reader.obligation(selection.obligationId)
    const candidate = reader.candidate(selection.candidateId)
    if (!obligation) {
      issues.push(
        issue(
          'unknown-obligation',
          'The selection names an unknown obligation.',
          {
            obligationId: selection.obligationId,
            candidateId: selection.candidateId,
          },
        ),
      )
      continue
    }
    if (!candidate) {
      issues.push(
        issue(
          'unknown-candidate',
          'The selection names an unknown candidate.',
          {
            obligationId: selection.obligationId,
            candidateId: selection.candidateId,
          },
        ),
      )
      continue
    }
    if (claimed.has(obligation.id)) {
      issues.push(
        issue(
          'duplicate-obligation',
          'A source obligation is conserved more than once.',
          {
            obligationId: obligation.id,
            candidateId: candidate.id,
          },
        ),
      )
      continue
    }
    claimed.add(obligation.id)
    if (!obligation.candidateIds.includes(candidate.id)) {
      issues.push(
        issue(
          'candidate-does-not-support-obligation',
          'The candidate was not frozen as evidence for this obligation.',
          { obligationId: obligation.id, candidateId: candidate.id },
        ),
      )
    }
    if (
      selection.disposition === 'excluded-boilerplate' &&
      (!boilerplateObligation(obligation.kind) ||
        selection.decision !== 'boilerplate-classification')
    ) {
      issues.push(
        issue(
          'illegal-boilerplate-exclusion',
          'Only a source-backed boilerplate obligation may leave body flow.',
          { obligationId: obligation.id, candidateId: candidate.id },
        ),
      )
    }
    if (
      obligation.semantic &&
      selection.disposition === 'accepted' &&
      isFullPageRaster(candidate) &&
      obligation.kind !== 'source-preserved-page'
    ) {
      issues.push(
        issue(
          'full-page-raster-as-semantics',
          'A full-page raster cannot satisfy reconstructed semantics.',
          { obligationId: obligation.id, candidateId: candidate.id },
        ),
      )
    }
    if (
      obligation.semantic &&
      /table/u.test(obligation.kind) &&
      !isSemanticStructure(candidate)
    ) {
      issues.push(
        issue(
          'unresolved-table-semantics',
          'A bounded table image preserves loss but does not close table structure.',
          { obligationId: obligation.id, candidateId: candidate.id },
        ),
      )
    }
    if (
      obligation.semantic &&
      /formula|equation/u.test(obligation.kind) &&
      !isSemanticStructure(candidate)
    ) {
      issues.push(
        issue(
          'unresolved-formula-semantics',
          'A bounded formula image preserves loss but does not close formula representation.',
          { obligationId: obligation.id, candidateId: candidate.id },
        ),
      )
    }
    if (selection.disposition === 'failed') {
      issues.push(
        issue(
          'failed-candidate',
          'An ungrounded disagreement remains a failed candidate.',
          { obligationId: obligation.id, candidateId: candidate.id },
        ),
      )
    }
    materializedSelections.push({
      ...selection,
      providerId: candidate.providerId,
      sourceIds: [...candidate.sourceIds],
    })
  }

  for (const obligation of graph.obligations) {
    if (obligation.required && !claimed.has(obligation.id)) {
      issues.push(
        issue(
          'missing-obligation',
          'A required source obligation was not conserved.',
          { obligationId: obligation.id },
        ),
      )
    }
  }

  const selectionByObligation = new Map(
    proposal.selections.map((selection) => [selection.obligationId, selection]),
  )
  const materializationByObligation = new Map<
    string,
    GroundedObligationMaterialization
  >()
  const targetOwners = new Map<string, string>()
  for (const materialization of proposal.materializations) {
    if (materializationByObligation.has(materialization.obligationId)) {
      issues.push(
        issue(
          'duplicate-materialization',
          'A selected source obligation has more than one materialization receipt.',
          {
            obligationId: materialization.obligationId,
            candidateId: materialization.candidateId,
          },
        ),
      )
      continue
    }
    materializationByObligation.set(
      materialization.obligationId,
      materialization,
    )
    for (const target of materialization.targets) {
      const key = `${target.kind}:${target.id}`
      const owner = targetOwners.get(key)
      if (owner !== undefined) {
        issues.push(
          issue(
            'duplicate-materialization-target',
            `Materialization target ${key} is already owned by ${owner}.`,
            {
              obligationId: materialization.obligationId,
              candidateId: materialization.candidateId,
            },
          ),
        )
      } else {
        targetOwners.set(key, materialization.obligationId)
      }
    }
    const selection = selectionByObligation.get(materialization.obligationId)
    const obligation = reader.obligation(materialization.obligationId)
    if (
      !selection ||
      !obligation ||
      selection.candidateId !== materialization.candidateId ||
      canonicalJson([...materialization.sourceIds].sort()) !==
        canonicalJson([...obligation.sourceIds].sort()) ||
      new Set(materialization.sourceIds).size !==
        materialization.sourceIds.length
    ) {
      issues.push(
        issue(
          'invalid-materialization',
          'The materialization receipt must bind the exact selected candidate and source-obligation IDs.',
          {
            obligationId: materialization.obligationId,
            candidateId: materialization.candidateId,
          },
        ),
      )
    }
  }
  for (const selection of proposal.selections) {
    if (
      selection.disposition !== 'failed' &&
      !materializationByObligation.has(selection.obligationId)
    ) {
      issues.push(
        issue(
          'missing-materialization',
          'Selecting an obligation is not conservation; an exact materialization receipt is required.',
          {
            obligationId: selection.obligationId,
            candidateId: selection.candidateId,
          },
        ),
      )
    }
  }

  const structured = verifyStructuredExtraction(
    context,
    proposal.structuredExtraction,
  )
  if (structured.status === 'failed') {
    issues.push(
      ...structured.issues.map((entry) =>
        issue(
          'structured-verification-failed',
          `${entry.code}: ${entry.message}`,
        ),
      ),
    )
  } else {
    const nodeIds = new Set(structured.output.nodes.map(({ id }) => id))
    const assetIds = new Set(structured.output.assetIds)
    const linkIds = new Set(
      structured.output.links.map(({ sourceLinkId }) => sourceLinkId),
    )
    const relationshipIds = new Set(structured.output.relationshipIds)
    const excludedIds = new Set(structured.output.excludedBoilerplateRunIds)
    const nodesById = new Map(
      structured.output.nodes.map((node) => [node.id, node]),
    )
    const sourceAssetsById = new Map(
      context.sourceAssets.map((asset) => [asset.id, asset]),
    )
    for (const materialization of proposal.materializations) {
      const selection = selectionByObligation.get(materialization.obligationId)
      const obligation = reader.obligation(materialization.obligationId)
      const candidate = reader.candidate(materialization.candidateId)
      const allowedKinds = allowedMaterializationKinds(obligation, candidate)
      const ownership = materialization.sourceIds.map((sourceId) =>
        sourceOwnershipById.get(sourceId),
      )
      if (ownership.some((entry) => entry === undefined)) {
        issues.push(
          issue(
            'invalid-source-crosswalk',
            'Every materialized graph source must reopen to an exact deterministic STRUCT owner.',
            {
              obligationId: materialization.obligationId,
              candidateId: materialization.candidateId,
            },
          ),
        )
      }
      for (const target of materialization.targets) {
        const exists =
          (target.kind === 'node' && nodeIds.has(target.id)) ||
          (target.kind === 'asset' && assetIds.has(target.id)) ||
          (target.kind === 'link' && linkIds.has(target.id)) ||
          (target.kind === 'relationship' && relationshipIds.has(target.id)) ||
          (target.kind === 'excluded-boilerplate' && excludedIds.has(target.id))
        if (
          !exists ||
          (target.kind !== 'excluded-boilerplate' &&
            !allowedKinds.has(target.kind)) ||
          (selection?.disposition === 'excluded-boilerplate') !==
            (target.kind === 'excluded-boilerplate')
        ) {
          issues.push(
            issue(
              'invalid-materialization',
              'A materialization target must exist in the verified STRUCT output and match its disposition.',
              {
                obligationId: materialization.obligationId,
                candidateId: materialization.candidateId,
              },
            ),
          )
        }
        const expectedOwnerKind =
          target.kind === 'excluded-boilerplate' ? 'node' : target.kind
        const expectedOwnerIds = [
          ...new Set(
            ownership
              .filter(
                (entry): entry is SourceOwnership =>
                  entry !== undefined && entry.kind === expectedOwnerKind,
              )
              .flatMap(({ targetIds }) => targetIds),
          ),
        ].sort()
        const actualOwnerIds =
          target.kind === 'node'
            ? [
                ...new Set(
                  nodesById.get(target.id)?.provenance.sourceRunIds ?? [],
                ),
              ].sort()
            : [target.id]
        if (
          expectedOwnerIds.length === 0 ||
          canonicalJson(actualOwnerIds) !== canonicalJson(expectedOwnerIds)
        ) {
          issues.push(
            issue(
              'invalid-source-crosswalk',
              'The selected target does not own the exact deterministic projection of its graph sources.',
              {
                obligationId: materialization.obligationId,
                candidateId: materialization.candidateId,
              },
            ),
          )
        }
        if (target.kind === 'node' && candidate) {
          const expectedType = semanticNodeType(candidate)
          const node = nodesById.get(target.id)
          if (expectedType && node?.type !== expectedType) {
            issues.push(
              issue(
                'semantic-role-mismatch',
                `Candidate semantic role ${expectedType} cannot materialize as ${node?.type ?? 'missing'}.`,
                {
                  obligationId: materialization.obligationId,
                  candidateId: materialization.candidateId,
                },
              ),
            )
          }
        }
        if (
          obligation?.kind === 'source-preserved-page' &&
          target.kind === 'asset'
        ) {
          const sourceAsset = sourceAssetsById.get(target.id)
          const artifacts = (candidate?.artifactIds ?? [])
            .map((id) => reader.artifact(id))
            .filter((artifact) => artifact !== undefined)
          const coherent =
            candidate !== undefined &&
            isFullPageRaster(candidate) &&
            sourceAsset?.kind === 'source-fallback' &&
            sourceAsset.page === obligation.page &&
            sourceAsset.bounds.x === 0 &&
            sourceAsset.bounds.y === 0 &&
            sourceAsset.bounds.width === 1 &&
            sourceAsset.bounds.height === 1 &&
            artifacts.some(
              (artifact) =>
                artifact.kind === 'full-page-render' &&
                artifact.page === obligation.page &&
                artifact.sha256 === sourceAsset.bytesSha256 &&
                artifact.box?.x === 0 &&
                artifact.box.y === 0 &&
                artifact.box.width === 1 &&
                artifact.box.height === 1,
            )
          if (!coherent) {
            issues.push(
              issue(
                'invalid-source-fallback',
                'A source-preserved page must own the exact complete-page deterministic render.',
                {
                  obligationId: materialization.obligationId,
                  candidateId: materialization.candidateId,
                },
              ),
            )
          }
        }
      }
    }
  }
  if (issues.length > 0 || structured.status === 'failed') {
    return { status: 'failed', output: null, issues }
  }

  const selections = materializedSelections.sort((left, right) =>
    left.obligationId.localeCompare(right.obligationId),
  )
  const providerSourceOwnershipCrosswalks = [
    ...new Set(sourceOwnership.map(({ providerId }) => providerId)),
  ]
    .sort()
    .map((providerId) => {
      const entries = sourceOwnership.filter(
        (entry) => entry.providerId === providerId,
      )
      return {
        providerId,
        sourceCount: entries.length,
        crosswalkSha256: sha256HexSync(canonicalJson(entries)),
      }
    })
  const output: VerifiedSourceGroundedStructCandidate = {
    schemaVersion: SOURCE_GROUNDED_STRUCT_SCHEMA_VERSION,
    evidenceGraphSha256: graph.graphSha256,
    candidateSetSha256: expectedCandidateSetSha256,
    obligationLedgerSha256: sha256HexSync(
      canonicalJson({
        selections,
        materializations: proposal.materializations,
      }),
    ),
    sourceOwnershipCrosswalkSha256: sha256HexSync(
      canonicalJson(sourceOwnership),
    ),
    providerSourceOwnershipCrosswalks,
    selections,
    materializations: structuredClone(proposal.materializations).sort(
      (left, right) => left.obligationId.localeCompare(right.obligationId),
    ),
    structuredExtraction: structured.output,
    readyForStruct: true,
  }
  return { status: 'passed', output: deepFreeze(output), issues: [] }
}

export function verifySourceGroundedStructCandidateOrThrow(
  graph: SourceEvidenceGraph,
  context: StructuredExtractionContext,
  proposal: unknown,
) {
  const result = verifySourceGroundedStructCandidate(graph, context, proposal)
  if (result.status === 'failed') {
    throw new Error(
      result.issues
        .map(({ code, message }) => `${code}: ${message}`)
        .join('\n'),
    )
  }
  return result.output
}
