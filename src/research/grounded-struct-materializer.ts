import { structDigest, structId } from '../struct/ids'
import {
  STRUCT_SCHEMA_VERSION,
  type StructAsset,
  type StructBlock,
  type StructBlockKind,
  type StructDocument,
  type StructEvidence,
  type StructInline,
  type StructRelationship,
  type StructTable,
} from '../struct/types'
import {
  canonicalTraceJson,
  hashTraceValue,
  type HashedArtifact,
} from './reconstruction-attempt-trace'
import type {
  EvidenceCandidateResolutionReceipt,
  GroundedVerifierIdentity,
  StructEvidencePatchOperation,
} from './reconstruction-refinement'
import { sha256HexSync } from './sha256-sync'
import {
  createSourceEvidenceContract,
  type SourceEvidenceContract,
} from './source-evidence-contract'
import {
  readSourceEvidenceGraph,
  type PdfEvidenceBox,
  type PdfEvidenceCandidate,
  type PdfEvidenceJsonValue,
  type SourceEvidenceGraph,
} from './source-evidence-graph'
import {
  verifyStructuredExtractionOrThrow,
  type StructuredExtractionContext,
  type StructuredExtractionNodeType,
  type StructuredExtractionProposal,
  type StructuredProvenArtifact,
  type StructuredSourceAsset,
  type StructuredSourceLink,
  type StructuredSourceRun,
  type VerifiedStructuredExtraction,
  type VerifiedStructuredExtractionNode,
} from './structured-extraction'

export const GROUNDED_STRUCT_MATERIALIZATION_SCHEMA_VERSION = '1.0.0' as const

export type GroundedStructCandidateSelection = StructEvidencePatchOperation & {
  bindingSha256: string
}

export type GroundedStructMaterializationReceipt = {
  schemaVersion: typeof GROUNDED_STRUCT_MATERIALIZATION_SCHEMA_VERSION
  documentId: string
  sourcePdfSha256: string
  sourceEvidenceGraphSha256: string
  structuredContextSha256: string
  structuredProposalSha256: string
  verifiedExtractionSha256: string
  selectionSetSha256: string
  selections: Array<{
    targetKind: GroundedStructCandidateSelection['targetKind']
    targetId: string
    candidateReferenceSha256: string
    bindingSha256: string
    resolutionReceiptSha256: string
  }>
  obligationBindings: Array<{
    obligationId: string
    outputBlockId: string
    sourceAnchorIds: string[]
    observationCategories: string[]
    candidateReferenceSha256: string[]
  }>
  repairCore: HashedArtifact
  canonicalStruct: HashedArtifact
  coreToDocumentBindingSha256: string
  status: 'publication-ready' | 'review-required'
  reviewReasons: Array<
    'table-visual-crop' | 'formula-visual-crop' | 'source-fallback'
  >
  receiptSha256: string
}

export type GroundedStructMaterialization = {
  document: StructDocument
  repairCoreBytes: Uint8Array
  canonicalStructBytes: Uint8Array
  receipt: GroundedStructMaterializationReceipt
}

export type GroundedStructMaterializationInput = {
  graph: SourceEvidenceGraph
  context: StructuredExtractionContext
  proposal: StructuredExtractionProposal
  verifierIdentity: GroundedVerifierIdentity
  selections: readonly GroundedStructCandidateSelection[]
  sourceFileName: string
  assetBytes?: Readonly<Record<string, Uint8Array>>
}

type ResolvedSelection = {
  selection: GroundedStructCandidateSelection
  candidate: PdfEvidenceCandidate
  resolutionReceiptSha256: string
  consumed: boolean
}

const SHA256 = /^[a-f0-9]{64}$/u
const EPUB_ANCHOR_ID = /^[A-Za-z_][A-Za-z0-9_.:-]*$/u
const BOX_EPSILON = 1e-9

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(code: string): never {
  throw new Error(code)
}

function artifact(bytes: Uint8Array): HashedArtifact {
  return { sha256: sha256HexSync(bytes), byteLength: bytes.byteLength }
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  )
}

function candidateForReference(
  contract: SourceEvidenceContract,
  referenceSha256: string,
) {
  const reference = contract.candidateReferences.find(
    (candidate) => candidate.referenceSha256 === referenceSha256,
  )
  if (!reference) invalid('UNKNOWN_GROUNDED_CANDIDATE_REFERENCE')
  const candidate = readSourceEvidenceGraph(contract.graph).candidate(
    reference.candidateId,
  )
  if (!candidate) invalid('UNKNOWN_GROUNDED_CANDIDATE_REFERENCE')
  return { reference, candidate }
}

function resolveSelections(
  contract: SourceEvidenceContract,
  selections: readonly GroundedStructCandidateSelection[],
) {
  const exactSelections = new Set<string>()
  return selections.map((selection): ResolvedSelection => {
    const key = canonicalTraceJson(selection)
    if (exactSelections.has(key))
      invalid('DUPLICATE_GROUNDED_CANDIDATE_SELECTION')
    exactSelections.add(key)
    const { reference, candidate } = candidateForReference(
      contract,
      selection.candidateReferenceSha256,
    )
    if (
      !SHA256.test(selection.bindingSha256) ||
      selection.bindingSha256 !== reference.bindingSha256
    ) {
      invalid('GROUNDED_CANDIDATE_BINDING_MISMATCH')
    }
    const resolution = contract.verifier.resolveCandidate({
      schemaVersion: '1.0.0',
      sourceEvidenceGraphSha256: contract.graph.graphSha256,
      referenceSha256: reference.referenceSha256,
      bindingSha256: reference.bindingSha256,
    }) as EvidenceCandidateResolutionReceipt
    return {
      selection: structuredClone(selection),
      candidate,
      resolutionReceiptSha256: resolution.receiptSha256,
      consumed: false,
    }
  })
}

function targetSelections(
  selections: ResolvedSelection[],
  targetKind: GroundedStructCandidateSelection['targetKind'],
  targetId: string,
) {
  return selections.filter(
    ({ selection }) =>
      selection.targetKind === targetKind && selection.targetId === targetId,
  )
}

function boxContains(candidate: PdfEvidenceBox, run: StructuredSourceRun) {
  const box = run.bounds
  return (
    box !== undefined &&
    candidate.page === run.page &&
    candidate.x <= box.x + BOX_EPSILON &&
    candidate.y <= box.y + BOX_EPSILON &&
    candidate.x + candidate.width + BOX_EPSILON >= box.x + box.width &&
    candidate.y + candidate.height + BOX_EPSILON >= box.y + box.height
  )
}

function payloadText(value: PdfEvidenceJsonValue | undefined) {
  if (!isRecord(value)) return []
  return ['text', 'sourceText', 'title', 'label'].flatMap((key) =>
    typeof value[key] === 'string' ? [value[key] as string] : [],
  )
}

function candidateCoversRun(
  contract: SourceEvidenceContract,
  candidate: PdfEvidenceCandidate,
  run: StructuredSourceRun,
  nodeText: string,
) {
  const reader = readSourceEvidenceGraph(contract.graph)
  const sources = candidate.sourceIds.map((id) => reader.sourceItem(id)!)
  const boxes = [
    ...(candidate.boxes ?? []),
    ...sources.flatMap((source) => (source.box ? [source.box] : [])),
  ]
  const texts = [
    ...payloadText(candidate.payload),
    ...sources.flatMap((source) => payloadText(source.payload)),
  ]
  return (
    boxes.some((box) => boxContains(box, run)) &&
    texts.some((text) => text === run.text || text === nodeText)
  )
}

function semanticTable(value: PdfEvidenceJsonValue | undefined) {
  if (!isRecord(value) || !isRecord(value.semanticTable)) return null
  const rows = value.semanticTable.rows
  if (!Array.isArray(rows)) return null
  const projection = rows.map((row) => {
    if (!isRecord(row) || !Array.isArray(row.cells)) return null
    const cells = row.cells.map((cell) => {
      if (!isRecord(cell) || typeof cell.text !== 'string') return null
      return {
        text: cell.text,
        rowSpan:
          typeof cell.rowSpan === 'number' && Number.isSafeInteger(cell.rowSpan)
            ? cell.rowSpan
            : 1,
        columnSpan:
          typeof cell.columnSpan === 'number' &&
          Number.isSafeInteger(cell.columnSpan)
            ? cell.columnSpan
            : 1,
        headerScope:
          typeof cell.headerScope === 'string' ? cell.headerScope : 'none',
      }
    })
    return cells.some((cell) => cell === null) ? null : { cells }
  })
  return projection.some((row) => row === null) ? null : { rows: projection }
}

function verifiedTableProjection(node: VerifiedStructuredExtractionNode) {
  return node.table
    ? {
        rows: node.table.rows.map((row) => ({
          cells: row.cells.map((cell) => ({
            text: cell.text,
            rowSpan: cell.rowSpan,
            columnSpan: cell.columnSpan,
            headerScope: cell.headerScope,
          })),
        })),
      }
    : null
}

function consumeBlockSelections(
  contract: SourceEvidenceContract,
  context: StructuredExtractionContext,
  node: VerifiedStructuredExtractionNode,
  selections: ResolvedSelection[],
) {
  const matches = targetSelections(selections, 'block', node.id)
  if (matches.length === 0) invalid('MISSING_GROUNDED_BLOCK_CANDIDATE')
  const runsById = new Map(context.sourceRuns.map((run) => [run.id, run]))
  const runIds = [
    ...node.sourceRunIds,
    ...(node.table
      ? node.table.rows.flatMap((row) =>
          row.cells.flatMap((cell) => cell.sourceRunIds),
        )
      : []),
  ]
  const runs = [...new Set(runIds)].map((id) => runsById.get(id)!)
  if (
    runs.some(
      (run) =>
        !run ||
        !matches.some(({ candidate }) =>
          candidateCoversRun(contract, candidate, run, node.text),
        ),
    )
  ) {
    invalid('UNGROUNDED_BLOCK_CANDIDATE')
  }
  if (node.type === 'table') {
    const expected = verifiedTableProjection(node)
    if (
      !matches.some(
        ({ candidate }) =>
          canonicalTraceJson(semanticTable(candidate.payload)) ===
          canonicalTraceJson(expected),
      )
    ) {
      invalid('UNGROUNDED_SEMANTIC_TABLE_CANDIDATE')
    }
  }
  if (
    node.level !== undefined &&
    !matches.some(
      ({ candidate }) =>
        isRecord(candidate.payload) && candidate.payload.level === node.level,
    )
  ) {
    invalid('UNGROUNDED_HEADING_LEVEL_CANDIDATE')
  }
  matches.forEach((selection) => {
    selection.consumed = true
  })
}

function nodeEvidence(
  node: VerifiedStructuredExtractionNode,
  context: StructuredExtractionContext,
): StructEvidence {
  const runsById = new Map(context.sourceRuns.map((run) => [run.id, run]))
  const runIds = [
    ...node.sourceRunIds,
    ...(node.table
      ? node.table.rows.flatMap((row) =>
          row.cells.flatMap((cell) => cell.sourceRunIds),
        )
      : []),
  ]
  const runs = [...new Set(runIds)].map((id) => runsById.get(id)!)
  return {
    confidence: 1,
    pages: [...new Set(runs.map(({ page }) => page))].sort((a, b) => a - b),
    boxes: runs.flatMap((run) =>
      run.bounds
        ? [
            {
              page: run.page,
              ...run.bounds,
              rotation: 0,
            },
          ]
        : [],
    ),
    sourceIds: [...new Set(runIds)],
    signals: ['source-evidence-candidate', 'verified-structured-extraction'],
  }
}

function blockKind(type: StructuredExtractionNodeType): StructBlockKind {
  switch (type) {
    case 'title':
    case 'heading':
      return 'heading'
    case 'code':
      return 'code'
    case 'table':
      return 'table'
    case 'figure':
      return 'figure'
    case 'equation':
      return 'equation'
    case 'footnote':
      return 'footnote'
    case 'reference':
      return 'endnote'
    case 'source-fallback':
      return 'unknown'
    default:
      return 'paragraph'
  }
}

function materializeTable(
  node: VerifiedStructuredExtractionNode,
  context: StructuredExtractionContext,
): StructTable | undefined {
  if (!node.table) return undefined
  const runs = new Map(context.sourceRuns.map((run) => [run.id, run]))
  const occupied = new Set<string>()
  const cells: StructTable['cells'] = []
  let columns = 0
  node.table.rows.forEach((row, rowIndex) => {
    let column = 0
    row.cells.forEach((cell, cellIndex) => {
      while (occupied.has(`${rowIndex}:${column}`)) column += 1
      for (let y = rowIndex; y < rowIndex + cell.rowSpan; y += 1) {
        for (let x = column; x < column + cell.columnSpan; x += 1) {
          const key = `${y}:${x}`
          if (occupied.has(key)) invalid('OVERLAPPING_GROUNDED_TABLE_SPAN')
          occupied.add(key)
        }
      }
      const evidenceRuns = cell.sourceRunIds.map((id) => runs.get(id)!)
      cells.push({
        id: structId('cell', `${node.id}:${rowIndex}:${cellIndex}`),
        text: cell.text,
        row: rowIndex,
        column,
        rowSpan: cell.rowSpan,
        columnSpan: cell.columnSpan,
        headerScope: cell.headerScope === 'none' ? null : cell.headerScope,
        inline: [],
        evidence: {
          confidence: 1,
          pages: [...new Set(evidenceRuns.map(({ page }) => page))],
          boxes: evidenceRuns.flatMap((run) =>
            run.bounds ? [{ page: run.page, ...run.bounds, rotation: 0 }] : [],
          ),
          sourceIds: [...cell.sourceRunIds],
          signals: ['candidate-grounded-table-cell'],
        },
      })
      column += cell.columnSpan
      columns = Math.max(columns, column)
    })
  })
  return {
    rows: node.table.rows.length,
    columns,
    cells,
    semantic: 'verified',
  }
}

function assetExtension(mediaType: string) {
  switch (mediaType) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/svg+xml':
      return 'svg'
    default:
      invalid('UNSUPPORTED_GROUNDED_ASSET_MEDIA_TYPE')
  }
}

function materializeAssets(
  input: GroundedStructMaterializationInput,
  contract: SourceEvidenceContract,
  output: VerifiedStructuredExtraction,
  selections: ResolvedSelection[],
) {
  const reader = readSourceEvidenceGraph(contract.graph)
  const sourceAssets = new Map(
    input.context.sourceAssets.map((asset) => [asset.id, asset]),
  )
  const reviewReasons = new Set<
    GroundedStructMaterializationReceipt['reviewReasons'][number]
  >()
  const assets = output.assetIds.map((assetId): StructAsset => {
    const sourceAsset = sourceAssets.get(assetId)
    if (!sourceAsset) invalid('UNKNOWN_GROUNDED_SOURCE_ASSET')
    const matches = targetSelections(selections, 'asset', assetId)
    if (matches.length === 0) invalid('MISSING_GROUNDED_ASSET_CANDIDATE')
    const graphArtifacts = matches.flatMap(({ candidate }) =>
      (candidate.artifactIds ?? []).map((id) => reader.artifact(id)!),
    )
    const graphArtifact = graphArtifacts.find(
      (candidate) => candidate.sha256 === sourceAsset.bytesSha256,
    )
    if (!graphArtifact) invalid('UNGROUNDED_ASSET_CANDIDATE')
    const bytes = input.assetBytes?.[assetId]
    if (
      !bytes ||
      bytes.byteLength !== graphArtifact.byteLength ||
      sha256HexSync(bytes) !== graphArtifact.sha256
    ) {
      invalid('GROUNDED_ASSET_BYTES_IDENTITY_MISMATCH')
    }
    if (sourceAsset.kind === 'table') reviewReasons.add('table-visual-crop')
    if (sourceAsset.kind === 'equation')
      reviewReasons.add('formula-visual-crop')
    if (sourceAsset.kind === 'source-fallback')
      reviewReasons.add('source-fallback')
    matches.forEach((selection) => {
      selection.consumed = true
    })
    const page = contract.graph.bundles[0]!.pages.find(
      (candidate) => candidate.page === sourceAsset.page,
    )
    return {
      id: structId('asset', `${input.context.sourceSha256}:${assetId}`),
      kind:
        sourceAsset.kind === 'source-fallback'
          ? 'page-region'
          : sourceAsset.kind,
      href: `asset-${graphArtifact.sha256.slice(0, 24)}.${assetExtension(graphArtifact.mediaType)}`,
      mediaType: graphArtifact.mediaType,
      sha256: graphArtifact.sha256,
      width: Math.max(
        1,
        Math.round((page?.width ?? 1) * sourceAsset.bounds.width),
      ),
      height: Math.max(
        1,
        Math.round((page?.height ?? 1) * sourceAsset.bounds.height),
      ),
      bytes: bytes.slice(),
      sourceObjectIds: [...sourceAsset.sourceObjectIds],
      evidence: assetEvidence(sourceAsset),
      fallback:
        sourceAsset.kind === 'source-fallback' ? 'source-region' : 'asset',
    }
  })
  return { assets, reviewReasons }
}

function assetEvidence(asset: StructuredSourceAsset): StructEvidence {
  return {
    confidence: 1,
    pages: [asset.page],
    boxes: [{ page: asset.page, ...asset.bounds, rotation: 0 }],
    sourceIds: [asset.id, ...asset.sourceObjectIds],
    signals: ['source-evidence-artifact-identity'],
  }
}

function linkCandidateMatches(
  candidate: PdfEvidenceCandidate,
  link: StructuredSourceLink,
) {
  if (!isRecord(candidate.payload)) return false
  if (link.destination.kind === 'external') {
    return candidate.payload.url === link.destination.url
  }
  if (link.destination.kind === 'internal') {
    return candidate.payload.destination === link.destination.targetId
  }
  return candidate.payload.reason === link.destination.reason
}

function materializeLinks(
  output: VerifiedStructuredExtraction,
  context: StructuredExtractionContext,
  blocksByNodeId: ReadonlyMap<string, StructBlock>,
  selections: ResolvedSelection[],
) {
  const links = new Map(
    (context.sourceLinks ?? []).map((link) => [link.id, link]),
  )
  const relationships: StructRelationship[] = []
  for (const verifiedLink of output.links) {
    const link = links.get(verifiedLink.sourceLinkId)!
    const block = blocksByNodeId.get(verifiedLink.sourceNodeId)!
    const matches = targetSelections(selections, 'relationship', link.id)
    if (
      matches.length === 0 ||
      !matches.some(({ candidate }) => linkCandidateMatches(candidate, link))
    ) {
      invalid('UNGROUNDED_LINK_CANDIDATE')
    }
    const target =
      link.destination.kind === 'internal'
        ? blocksByNodeId.get(link.destination.targetId)?.id
        : undefined
    if (link.destination.kind === 'internal' && !target) {
      invalid('DANGLING_GROUNDED_LINK_TARGET')
    }
    const relationshipId = structId('relationship', link.id)
    const inline: StructInline = {
      start: 0,
      end: block.text.length,
      annotationId: link.id,
      relationshipId,
      ...(link.destination.kind === 'external'
        ? { href: link.destination.url }
        : target
          ? { href: `#${target}`, targetIds: [target] }
          : {}),
    }
    block.inline.push(inline)
    relationships.push({
      id: relationshipId,
      kind: 'hyperlink',
      from: block.id,
      to:
        link.destination.kind === 'external'
          ? [link.destination.url]
          : target
            ? [target]
            : [],
      status: link.destination.kind === 'unresolved' ? 'unresolved' : 'matched',
      confidence: 1,
      evidence: {
        confidence: 1,
        pages: [link.page],
        boxes: [{ page: link.page, ...link.box, rotation: 0 }],
        sourceIds: [link.id],
        signals: ['source-evidence-link-destination'],
      },
    })
    matches.forEach((selection) => {
      selection.consumed = true
    })
  }
  return relationships
}

function relationshipKind(artifact: StructuredProvenArtifact) {
  switch (artifact.kind) {
    case 'note-relationship':
      return 'footnote' as const
    case 'citation-relationship':
      return 'citation' as const
    case 'cross-reference-relationship':
      return 'cross-reference' as const
    case 'visual-relationship':
      return 'figure' as const
    case 'reading-order-relationship':
      return 'reading-order' as const
    default:
      return null
  }
}

function materializeProvenRelationships(
  context: StructuredExtractionContext,
  output: VerifiedStructuredExtraction,
  blocksByNodeId: ReadonlyMap<string, StructBlock>,
  selections: ResolvedSelection[],
) {
  const nodes = output.nodes
  const blockForRuns = (runIds: readonly string[]) =>
    nodes.find((node) => runIds.some((id) => node.sourceRunIds.includes(id)))
  return (context.provenArtifacts ?? []).flatMap((artifact) => {
    const kind = relationshipKind(artifact)
    if (!kind) return []
    const matches = targetSelections(selections, 'relationship', artifact.id)
    if (
      matches.length === 0 ||
      !matches.some(({ candidate }) =>
        candidate.kind.startsWith(artifact.kind.replace('-relationship', '')),
      )
    ) {
      invalid('UNGROUNDED_RELATIONSHIP_CANDIDATE')
    }
    const owners = nodes.filter((node) =>
      artifact.sourceRunIds.some((id) => node.sourceRunIds.includes(id)),
    )
    const fromNode = owners[0]
    const from = fromNode ? blocksByNodeId.get(fromNode.id) : undefined
    const targetNodes = (artifact.targetSourceRunIdGroups ?? [])
      .map(blockForRuns)
      .filter(
        (node): node is VerifiedStructuredExtractionNode => node !== undefined,
      )
    const to =
      targetNodes.length > 0
        ? targetNodes.map((node) => blocksByNodeId.get(node.id)!.id)
        : owners.slice(1).map((node) => blocksByNodeId.get(node.id)!.id)
    if (!from || to.length === 0)
      invalid('UNMATERIALIZABLE_GROUNDED_RELATIONSHIP')
    matches.forEach((selection) => {
      selection.consumed = true
    })
    return [
      {
        id: structId('relationship', artifact.id),
        kind,
        from: from.id,
        to,
        status: 'matched' as const,
        confidence: 1,
        evidence: {
          confidence: 1,
          pages: from.evidence.pages,
          boxes: from.evidence.boxes,
          sourceIds: [artifact.id, ...artifact.sourceRunIds],
          signals: ['candidate-grounded-relationship'],
        },
      },
    ]
  })
}

function selectionOwnerNodeId(
  selection: ResolvedSelection,
  context: StructuredExtractionContext,
  output: VerifiedStructuredExtraction,
) {
  if (selection.selection.targetKind === 'block') {
    return output.nodes.some(({ id }) => id === selection.selection.targetId)
      ? selection.selection.targetId
      : null
  }
  if (selection.selection.targetKind === 'asset') {
    return (
      output.nodes.find(
        ({ assetId }) => assetId === selection.selection.targetId,
      )?.id ?? null
    )
  }
  const link = output.links.find(
    ({ sourceLinkId }) => sourceLinkId === selection.selection.targetId,
  )
  if (link) return link.sourceNodeId
  const artifact = (context.provenArtifacts ?? []).find(
    ({ id }) => id === selection.selection.targetId,
  )
  return artifact
    ? (output.nodes.find((node) =>
        artifact.sourceRunIds.some((id) => node.sourceRunIds.includes(id)),
      )?.id ?? null)
    : null
}

function bindSourceObservationObligations(
  contract: SourceEvidenceContract,
  context: StructuredExtractionContext,
  output: VerifiedStructuredExtraction,
  selections: ResolvedSelection[],
  blocksByNodeId: ReadonlyMap<string, StructBlock>,
) {
  const reader = readSourceEvidenceGraph(contract.graph)
  const blockIds = new Set([...blocksByNodeId.values()].map(({ id }) => id))
  const bindings = contract.graph.obligations
    .filter(({ required, semantic }) => required && semantic)
    .map((obligation) => {
      const selected = selections.filter(({ candidate }) =>
        obligation.candidateIds.includes(candidate.id),
      )
      const ownerNodeIds = new Set(
        selected.flatMap((selection) => {
          const owner = selectionOwnerNodeId(selection, context, output)
          return owner ? [owner] : []
        }),
      )
      if (selected.length === 0 || ownerNodeIds.size !== 1) {
        invalid('UNCLOSED_SOURCE_OBSERVATION_OBLIGATION')
      }
      const outputBlock = blocksByNodeId.get([...ownerNodeIds][0]!)
      if (!outputBlock) invalid('UNCLOSED_SOURCE_OBSERVATION_OBLIGATION')
      const sourceAnchorIds = [
        ...new Set([
          ...obligation.sourceIds,
          ...obligation.candidateIds.flatMap(
            (candidateId) => reader.candidate(candidateId)!.sourceIds,
          ),
        ]),
      ].sort()
      if (
        sourceAnchorIds.length === 0 ||
        sourceAnchorIds.some(
          (id) => !EPUB_ANCHOR_ID.test(id) || blockIds.has(id),
        )
      ) {
        invalid('UNRENDERABLE_SOURCE_OBSERVATION_ANCHOR')
      }
      outputBlock.sourceObservationAnchorIds = [
        ...new Set([
          ...(outputBlock.sourceObservationAnchorIds ?? []),
          ...sourceAnchorIds,
        ]),
      ].sort()
      return {
        obligationId: obligation.id,
        outputBlockId: outputBlock.id,
        sourceAnchorIds,
        observationCategories: [...obligation.observationCategories].sort(),
        candidateReferenceSha256: selected
          .map(({ selection }) => selection.candidateReferenceSha256)
          .sort(),
      }
    })
    .sort((left, right) => left.obligationId.localeCompare(right.obligationId))
  const anchorOwners = new Map<string, string>()
  for (const binding of bindings) {
    for (const anchorId of binding.sourceAnchorIds) {
      const owner = anchorOwners.get(anchorId)
      if (owner && owner !== binding.outputBlockId) {
        invalid('AMBIGUOUS_SOURCE_OBSERVATION_ANCHOR')
      }
      anchorOwners.set(anchorId, binding.outputBlockId)
    }
  }
  return bindings
}

function receiptProjection(
  receipt: Omit<GroundedStructMaterializationReceipt, 'receiptSha256'>,
) {
  return receipt
}

function repairCore(document: StructDocument) {
  return {
    schemaVersion: GROUNDED_STRUCT_MATERIALIZATION_SCHEMA_VERSION,
    documentId: document.documentId,
    sourcePdfSha256: document.source.sha256,
    blocks: document.blocks,
    assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
    relationships: document.relationships,
  }
}

export function verifyGroundedCoreMaterializationBinding(
  materialization: GroundedStructMaterialization,
) {
  const computedCoreBytes = new TextEncoder().encode(
    canonicalTraceJson(repairCore(materialization.document)),
  )
  const canonicalDocument = {
    ...materialization.document,
    assets: materialization.document.assets.map(
      ({ bytes: _bytes, ...asset }) => asset,
    ),
  }
  const computedCanonicalBytes = new TextEncoder().encode(
    canonicalTraceJson(canonicalDocument),
  )
  const { receiptSha256, ...receipt } = materialization.receipt
  const { receipt: documentReceipt, ...withoutReceipt } =
    materialization.document
  const expectedGeneratedSha256 = structDigest({
    ...withoutReceipt,
    conservation: documentReceipt.conservation,
    assets: materialization.document.assets.map(
      ({ bytes: _bytes, ...asset }) => asset,
    ),
  })
  const core = artifact(computedCoreBytes)
  const canonicalStruct = artifact(computedCanonicalBytes)
  const binding = hashTraceValue({
    schemaVersion: GROUNDED_STRUCT_MATERIALIZATION_SCHEMA_VERSION,
    repairCore: core,
    canonicalStruct,
    generatedSha256: documentReceipt.generatedSha256,
  })
  if (
    !sameBytes(materialization.repairCoreBytes, computedCoreBytes) ||
    !sameBytes(materialization.canonicalStructBytes, computedCanonicalBytes) ||
    hashTraceValue(materialization.receipt.repairCore) !==
      hashTraceValue(core) ||
    hashTraceValue(materialization.receipt.canonicalStruct) !==
      hashTraceValue(canonicalStruct) ||
    materialization.receipt.coreToDocumentBindingSha256 !== binding ||
    documentReceipt.generatedSha256 !== expectedGeneratedSha256 ||
    receiptSha256 !== hashTraceValue(receipt)
  ) {
    invalid('INVALID_GROUNDED_CORE_MATERIALIZATION_BINDING')
  }
  return { repairCore: core, canonicalStruct, bindingSha256: binding }
}

/**
 * Close a verified structured proposal over exact #198 candidate resolutions
 * and package bytes. No proposed text, geometry, destinations, or bytes enter
 * the resulting STRUCT without a deterministic source owner.
 */
export function materializeGroundedStruct(
  input: GroundedStructMaterializationInput,
): GroundedStructMaterialization {
  if (
    input.context.sourceSha256 !== input.graph.source.sha256 ||
    input.context.documentId !== input.graph.source.documentId ||
    input.sourceFileName.trim().length === 0
  ) {
    invalid('GROUNDED_MATERIALIZATION_SOURCE_MISMATCH')
  }
  const output = verifyStructuredExtractionOrThrow(
    input.context,
    input.proposal,
  )
  const contract = createSourceEvidenceContract(
    input.graph,
    input.verifierIdentity,
  )
  const selections = resolveSelections(contract, input.selections)
  output.nodes.forEach((node) =>
    consumeBlockSelections(contract, input.context, node, selections),
  )

  const nodeIds = new Map(
    output.nodes.map((node) => [
      node.id,
      structId('block', `${input.context.sourceSha256}:${node.id}`),
    ]),
  )
  const runsById = new Map(input.context.sourceRuns.map((run) => [run.id, run]))
  const assetsBySourceId = new Map(
    input.context.sourceAssets.map((asset) => [
      asset.id,
      structId('asset', `${input.context.sourceSha256}:${asset.id}`),
    ]),
  )
  const blocks: StructBlock[] = output.nodes.map((node) => {
    const evidence = nodeEvidence(node, input.context)
    const firstRun = [...node.sourceRunIds]
      .map((id) => runsById.get(id))
      .find((run) => run !== undefined)
    return {
      id: nodeIds.get(node.id)!,
      kind: blockKind(node.type),
      text: node.text,
      page: firstRun?.page ?? evidence.pages[0] ?? null,
      order: firstRun?.order ?? Number.MAX_SAFE_INTEGER,
      column: 'single',
      inline: [],
      evidence,
      ...(node.table ? { table: materializeTable(node, input.context) } : {}),
      ...(node.level ? { attributes: { level: node.level } } : {}),
      ...(node.assetId
        ? { fallbackAssetIds: [assetsBySourceId.get(node.assetId)!] }
        : {}),
    }
  })
  blocks.sort(
    (left, right) =>
      left.order - right.order || left.id.localeCompare(right.id),
  )
  blocks.forEach((block, index) => {
    block.order = index
  })
  const blocksByNodeId = new Map(
    output.nodes.map((node) => [
      node.id,
      blocks.find((block) => block.id === nodeIds.get(node.id))!,
    ]),
  )
  const { assets, reviewReasons } = materializeAssets(
    input,
    contract,
    output,
    selections,
  )
  const relationships = [
    ...materializeLinks(output, input.context, blocksByNodeId, selections),
    ...materializeProvenRelationships(
      input.context,
      output,
      blocksByNodeId,
      selections,
    ),
  ].sort((left, right) => left.id.localeCompare(right.id))
  const obligationBindings = bindSourceObservationObligations(
    contract,
    input.context,
    output,
    selections,
    blocksByNodeId,
  )
  if (output.nodes.some(({ type }) => type === 'source-fallback')) {
    reviewReasons.add('source-fallback')
  }
  if (selections.some(({ consumed }) => !consumed)) {
    invalid('UNUSED_GROUNDED_CANDIDATE_SELECTION')
  }
  const titleNodes = output.nodes.filter(({ type }) => type === 'title')
  if (titleNodes.length !== 1) invalid('EXACT_GROUNDED_TITLE_REQUIRED')
  const authors = output.nodes
    .filter(({ type }) => type === 'author')
    .map(({ text }) => text)
  const affiliations = output.nodes
    .filter(({ type }) => type === 'affiliation')
    .map(({ text }) => text)
  const abstract = output.nodes
    .filter(({ type }) => type === 'abstract')
    .map(({ text }) => text)
    .join('\n')
  const pages = input.graph.bundles[0]!.pages.map((page) => {
    const pageBlocks = blocks.filter((block) => block.page === page.page)
    return {
      page: page.page,
      width: page.width,
      height: page.height,
      rotation: page.rotation,
      blocks: pageBlocks.map(({ id }) => id),
      columns: [
        {
          id: `page-${page.page}`,
          side: 'single' as const,
          blockIds: pageBlocks.map(({ id }) => id),
        },
      ],
    }
  })
  const diagnostics = [...reviewReasons].map((reason, index) => ({
    id: `grounded-review-${index + 1}`,
    severity: 'warning' as const,
    category:
      reason === 'formula-visual-crop'
        ? ('equations' as const)
        : reason === 'table-visual-crop'
          ? ('tables' as const)
          : ('source' as const),
    title: 'Source visual requires review',
    message: reason,
    action: 'Review the exact source crop before publication.',
    pages: [],
    sourceIds: [],
  }))
  const sourceTextCharacterCount = input.context.sourceRuns.reduce(
    (total, { text }) => total + text.length,
    0,
  )
  const structTextCharacterCount = blocks.reduce(
    (total, { text }) => total + text.length,
    0,
  )
  const conservation = {
    sourceNodeCount: output.nodes.length,
    accountedSourceNodeCount: blocks.length,
    sourceRegionCount: input.context.sourceRuns.length,
    accountedSourceRegionCount: output.accountedSourceRunIds.length,
    sourceAnnotationCount: input.context.sourceLinks?.length ?? 0,
    accountedSourceAnnotationCount: output.links.length,
    sourceAssetCount: input.context.sourceAssets.length,
    accountedSourceAssetCount: assets.length,
    sourceRelationshipCount:
      output.relationshipIds.length + output.links.length,
    accountedSourceRelationshipCount: relationships.length,
    sourceDiagnosticCount: diagnostics.length,
    accountedSourceDiagnosticCount: diagnostics.length,
    sourceTextCharacterCount,
    structBlockCount: blocks.length,
    structAssetCount: assets.length,
    structRelationshipCount: relationships.length,
    structDiagnosticCount: diagnostics.length,
    structTextCharacterCount,
  }
  const withoutReceipt = {
    schemaVersion: STRUCT_SCHEMA_VERSION,
    documentId: output.documentId,
    source: {
      format: 'pdf' as const,
      fileName: input.sourceFileName,
      sha256: input.graph.source.sha256,
      byteLength: input.graph.source.byteLength,
      pageCount: input.graph.source.pageCount,
      localOnly: true,
    },
    metadata: {
      title: titleNodes[0]!.text,
      subtitle: '',
      authors,
      abstract,
      updated: '1970-01-01',
      ...(affiliations.length > 0 ? { affiliations } : {}),
    },
    blocks,
    assets,
    relationships,
    pages,
    diagnostics,
    recovery:
      reviewReasons.size === 0
        ? {
            status: 'ready' as const,
            title: 'Ready',
            summary: 'All source-grounded materialization checks passed.',
            issues: [],
          }
        : {
            status: 'review-required' as const,
            title: 'Review required',
            summary: 'A source visual crop cannot be auto-published.',
            issues: diagnostics.map((diagnostic) => ({
              category: diagnostic.category,
              title: diagnostic.title,
              count: 1,
              pages: diagnostic.pages,
              action: diagnostic.action,
            })),
            userAction: 'Review the exact source visual crop.',
          },
  }
  const receipt = {
    schemaVersion: STRUCT_SCHEMA_VERSION,
    documentId: output.documentId,
    sourceSha256: input.graph.source.sha256,
    blockCount: blocks.length,
    assetCount: assets.length,
    relationshipCount: relationships.length,
    diagnosticCount: diagnostics.length,
    textCharacterCount: sourceTextCharacterCount,
    conservation,
    generatedSha256: structDigest({
      ...withoutReceipt,
      conservation,
      assets: assets.map(({ bytes: _bytes, ...asset }) => asset),
    }),
  }
  const document: StructDocument = { ...withoutReceipt, receipt }
  const canonicalDocument = {
    ...document,
    assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
  }
  const canonicalStructBytes = new TextEncoder().encode(
    canonicalTraceJson(canonicalDocument),
  )
  const repairCoreBytes = new TextEncoder().encode(
    canonicalTraceJson(repairCore(document)),
  )
  const repairCoreArtifact = artifact(repairCoreBytes)
  const canonicalStruct = artifact(canonicalStructBytes)
  const coreToDocumentBindingSha256 = hashTraceValue({
    schemaVersion: GROUNDED_STRUCT_MATERIALIZATION_SCHEMA_VERSION,
    repairCore: repairCoreArtifact,
    canonicalStruct,
    generatedSha256: document.receipt.generatedSha256,
  })
  const selectionReceipts = selections
    .map(({ selection, resolutionReceiptSha256 }) => ({
      targetKind: selection.targetKind,
      targetId: selection.targetId,
      candidateReferenceSha256: selection.candidateReferenceSha256,
      bindingSha256: selection.bindingSha256,
      resolutionReceiptSha256,
    }))
    .sort((left, right) =>
      canonicalTraceJson(left).localeCompare(canonicalTraceJson(right)),
    )
  const projection = receiptProjection({
    schemaVersion: GROUNDED_STRUCT_MATERIALIZATION_SCHEMA_VERSION,
    documentId: output.documentId,
    sourcePdfSha256: input.graph.source.sha256,
    sourceEvidenceGraphSha256: input.graph.graphSha256,
    structuredContextSha256: hashTraceValue(input.context),
    structuredProposalSha256: hashTraceValue(input.proposal),
    verifiedExtractionSha256: hashTraceValue(output),
    selectionSetSha256: hashTraceValue(selectionReceipts),
    selections: selectionReceipts,
    obligationBindings,
    repairCore: repairCoreArtifact,
    canonicalStruct,
    coreToDocumentBindingSha256,
    status: reviewReasons.size === 0 ? 'publication-ready' : 'review-required',
    reviewReasons: [...reviewReasons].sort(),
  })
  return {
    document,
    repairCoreBytes,
    canonicalStructBytes,
    receipt: { ...projection, receiptSha256: hashTraceValue(projection) },
  }
}
