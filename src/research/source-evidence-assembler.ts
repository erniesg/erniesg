import type { PdfReconstruction } from './import-types'
import {
  inspectMineruSourceEvidence,
  type MineruArtifactManifest,
} from './mineru-source-evidence'
import {
  runOwnerLocalMineru,
  type OwnerLocalMineruRun,
  type OwnerLocalMineruRunnerOptions,
} from './mineru-owner-local-runner'
import {
  pdfEvidenceBundlesFromReconstruction,
  type PdfDeterministicEvidenceOptions,
} from './pdf-source-evidence'
import { sha256HexSync } from './sha256-sync'
import {
  SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
  buildSourceEvidenceGraph,
  deterministicContextReceiptForBundle,
  type PdfEvidenceArmState,
  type PdfEvidenceBox,
  type PdfEvidenceBundle,
  type PdfEvidenceCandidate,
  type PdfEvidenceDisagreement,
  type PdfEvidenceObligation,
  type PdfEvidenceObservationCategory,
  type SourceEvidenceGraph,
} from './source-evidence-graph'

type CandidateCategory =
  | 'text'
  | 'reading-order'
  | 'table'
  | 'formula'
  | 'figure'
  | 'link'
  | 'page-render'
  | 'other'

const TEXT_KINDS = new Set([
  'text',
  'title',
  'paragraph',
  'heading',
  'code',
  'text-glyph-run',
  'ocr-word',
  'ocr-line',
])
const TABLE_KINDS = new Set(['table', 'table-body', 'table-caption'])
const FORMULA_KINDS = new Set([
  'formula',
  'equation',
  'interline-equation',
  'interline_equation',
])
const FIGURE_KINDS = new Set(['figure', 'image', 'chart'])
const LINK_KINDS = new Set([
  'annotation-link-destination',
  'link',
  'external-link',
  'internal-link',
])

function candidateObservationCategories(
  candidate: PdfEvidenceCandidate,
): PdfEvidenceObservationCategory[] {
  const classified = category(candidate.kind)
  switch (classified) {
    case 'text':
      return [
        'text-exactness',
        'reading-order',
        ...(candidate.kind === 'title' || candidate.kind === 'heading'
          ? (['hierarchy'] as const)
          : []),
        ...(candidate.kind === 'code' ? (['code-preformatted'] as const) : []),
        'clipping',
        'overflow',
      ]
    case 'reading-order':
      return ['reading-order', 'clipping', 'overflow']
    case 'table':
      return [
        'object-counts',
        'table-cells',
        'table-spans',
        'table-headers',
        'captions',
        'clipping',
        'overflow',
      ]
    case 'formula':
      return ['object-counts', 'formulas', 'clipping', 'overflow']
    case 'figure':
      return ['object-counts', 'figures', 'captions', 'clipping', 'overflow']
    case 'link':
      return ['links', 'clipping', 'overflow', 'dangling-targets']
    case 'page-render':
      return ['object-counts', 'asset-bytes', 'clipping', 'overflow']
    case 'other':
      return []
  }
}

export type SourceEvidenceAssemblerOptions = {
  reconstruction: PdfReconstruction
  deterministic: PdfDeterministicEvidenceOptions
  mineru: OwnerLocalMineruRunnerOptions
}

export type SourceEvidenceAssemblerResult = {
  graph: SourceEvidenceGraph
  mineruRun: OwnerLocalMineruRun
}

export type SourceEvidenceAssemblerDependencies = {
  runMineru?: (
    options: OwnerLocalMineruRunnerOptions,
  ) => Promise<OwnerLocalMineruRun>
}

function category(kind: string): CandidateCategory {
  if (TEXT_KINDS.has(kind)) return 'text'
  if (
    kind === 'reading-order' ||
    kind === 'reading-order-edge' ||
    kind === 'layout-region'
  ) {
    return 'reading-order'
  }
  if (TABLE_KINDS.has(kind)) return 'table'
  if (FORMULA_KINDS.has(kind)) return 'formula'
  if (FIGURE_KINDS.has(kind)) return 'figure'
  if (LINK_KINDS.has(kind)) return 'link'
  if (kind === 'full-page-render' || kind === 'page-render') {
    return 'page-render'
  }
  return 'other'
}

function overlap(left: PdfEvidenceBox, right: PdfEvidenceBox) {
  if (left.page !== right.page) return 0
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  )
  const intersection = width * height
  if (intersection === 0) return 0
  return (
    intersection /
    Math.min(left.width * left.height, right.width * right.height)
  )
}

function compatible(
  obligation: PdfEvidenceObligation,
  deterministic: PdfEvidenceCandidate,
  mineru: PdfEvidenceCandidate,
) {
  const expected = category(deterministic.kind)
  if (expected === 'other' || category(mineru.kind) !== expected) return false
  if (obligation.page !== undefined && mineru.page !== obligation.page)
    return false
  if (expected === 'reading-order') return obligation.page === mineru.page
  const deterministicBoxes = deterministic.boxes ?? []
  const mineruBoxes = mineru.boxes ?? []
  return (
    deterministicBoxes.length > 0 &&
    mineruBoxes.length > 0 &&
    deterministicBoxes.some((left) =>
      mineruBoxes.some((right) => overlap(left, right) >= 0.25),
    )
  )
}

function payloadDigest(candidate: PdfEvidenceCandidate) {
  return sha256HexSync(JSON.stringify(candidate.payload ?? null))
}

function groundedCandidate(candidate: PdfEvidenceCandidate) {
  return (
    candidate.payload !== null &&
    typeof candidate.payload === 'object' &&
    !Array.isArray(candidate.payload) &&
    candidate.payload.grounded === true
  )
}

function attachMineruAlternatives(
  obligations: PdfEvidenceObligation[],
  disagreements: PdfEvidenceDisagreement[],
  allCandidates: PdfEvidenceCandidate[],
  mineruCandidates: PdfEvidenceCandidate[],
) {
  const byId = new Map(
    allCandidates.map((candidate) => [candidate.id, candidate]),
  )
  const claimedCandidates = new Set(
    obligations.flatMap(({ candidateIds }) => candidateIds),
  )
  for (const obligation of obligations) {
    const deterministic = obligation.candidateIds
      .map((id) => byId.get(id))
      .find((candidate) => candidate?.providerId.startsWith('pdfjs'))
    if (!deterministic) continue
    const alternatives = mineruCandidates.filter(
      (candidate) =>
        !claimedCandidates.has(candidate.id) &&
        compatible(obligation, deterministic, candidate),
    )
    for (const alternative of alternatives) {
      obligation.candidateIds.push(alternative.id)
      claimedCandidates.add(alternative.id)
      obligation.observationCategories = [
        ...new Set([
          ...obligation.observationCategories,
          ...candidateObservationCategories(alternative),
        ]),
      ]
    }
    const divergent = alternatives.filter(
      (candidate) => payloadDigest(candidate) !== payloadDigest(deterministic),
    )
    if (divergent.length === 0) continue
    const candidateIds = [deterministic.id, ...divergent.map(({ id }) => id)]
    const providerIds = [
      ...new Set(
        candidateIds.map((id) => byId.get(id)?.providerId).filter(Boolean),
      ),
    ] as string[]
    disagreements.push({
      id: `disagreement-cross-arm-${obligation.id}`,
      kind: `cross-arm-${category(deterministic.kind)}`,
      obligationIds: [obligation.id],
      candidateIds,
      providerIds,
      reason:
        'deterministic and MinerU candidates remain distinct until grounded reconciliation',
    })
  }
}

function mergeCategories(
  obligation: PdfEvidenceObligation,
  categories: readonly PdfEvidenceObservationCategory[],
) {
  obligation.observationCategories = [
    ...new Set([...obligation.observationCategories, ...categories]),
  ]
}

function genericObservationCategories(
  kind: string,
  includesArtifact: boolean,
): PdfEvidenceObservationCategory[] {
  const classified = category(kind)
  if (classified !== 'other') {
    const candidate = {
      kind,
      artifactIds: includesArtifact ? ['retained-artifact'] : undefined,
    } as PdfEvidenceCandidate
    return candidateObservationCategories(candidate)
  }
  return [
    'object-counts',
    ...(includesArtifact ? (['asset-bytes'] as const) : []),
    'clipping',
    'overflow',
  ]
}

/**
 * The provider adapters expose evidence facts, while this production assembler
 * makes their exact ownership explicit. This is intentionally not part of the
 * generic graph validator: callers cannot turn a partial graph into a complete
 * one by merely invoking validation.
 */
function completeEvidenceObligations(
  bundles: readonly PdfEvidenceBundle[],
  obligations: PdfEvidenceObligation[],
) {
  const sources = bundles.flatMap(({ sources }) => sources)
  const artifacts = bundles.flatMap(({ artifacts }) => artifacts)
  const candidates = bundles.flatMap(({ candidates }) => candidates)
  const byObligationId = new Map(
    obligations.map((obligation) => [obligation.id, obligation]),
  )
  const sourceOwners = new Map<string, string>()
  const artifactOwners = new Map<string, string>()
  const candidateOwners = new Map<string, string>()
  for (const obligation of obligations) {
    for (const id of obligation.sourceIds) sourceOwners.set(id, obligation.id)
    for (const id of obligation.artifactIds)
      artifactOwners.set(id, obligation.id)
    for (const id of obligation.candidateIds)
      candidateOwners.set(id, obligation.id)
  }

  const obligationFor = (id: string | undefined) =>
    id === undefined ? undefined : byObligationId.get(id)
  const firstOwner = (ids: readonly string[], owners: Map<string, string>) =>
    ids.map((id) => owners.get(id)).find((owner) => owner !== undefined)

  for (const candidate of candidates) {
    if (candidateOwners.has(candidate.id)) continue
    let obligation = obligationFor(
      firstOwner(candidate.sourceIds, sourceOwners) ??
        firstOwner(candidate.artifactIds ?? [], artifactOwners),
    )
    if (!obligation) {
      const sourceIds = candidate.sourceIds.filter(
        (sourceId) => !sourceOwners.has(sourceId),
      )
      if (sourceIds.length === 0) {
        throw new Error('EVIDENCE_CANDIDATE_SOURCE_OWNERSHIP_REQUIRED')
      }
      const candidateDigest = sha256HexSync(candidate.id).slice(0, 24)
      obligation = {
        id: `obligation-provider-candidate-${candidateDigest}`,
        kind: `provider-${category(candidate.kind)}-evidence`,
        ...(candidate.page === undefined ? {} : { page: candidate.page }),
        sourceIds,
        artifactIds: [],
        candidateIds: [],
        observationCategories: genericObservationCategories(
          candidate.kind,
          (candidate.artifactIds?.length ?? 0) > 0,
        ),
        required: groundedCandidate(candidate),
        semantic: groundedCandidate(candidate),
      }
      obligations.push(obligation)
      byObligationId.set(obligation.id, obligation)
      for (const sourceId of sourceIds) {
        sourceOwners.set(sourceId, obligation.id)
      }
    }
    obligation.candidateIds.push(candidate.id)
    candidateOwners.set(candidate.id, obligation.id)
    mergeCategories(
      obligation,
      genericObservationCategories(
        candidate.kind,
        (candidate.artifactIds?.length ?? 0) > 0,
      ),
    )
    if (groundedCandidate(candidate)) {
      obligation.required = true
      obligation.semantic = true
    }
  }

  for (const source of sources) {
    if (sourceOwners.has(source.id)) continue
    const candidateOwner = candidates
      .filter(({ sourceIds }) => sourceIds.includes(source.id))
      .map(({ id }) => candidateOwners.get(id))
      .find((owner) => owner !== undefined)
    const parentOwner = firstOwner(source.parentSourceIds ?? [], sourceOwners)
    const artifactOwner = firstOwner(source.artifactIds ?? [], artifactOwners)
    let obligation = obligationFor(candidateOwner ?? parentOwner ?? artifactOwner)
    if (!obligation) {
      const sourceDigest = sha256HexSync(source.id).slice(0, 24)
      obligation = {
        id: `obligation-provider-source-${sourceDigest}`,
        kind: 'provider-source-fact',
        ...(source.page === undefined ? {} : { page: source.page }),
        sourceIds: [],
        artifactIds: [],
        candidateIds: [],
        observationCategories: genericObservationCategories(
          source.kind,
          (source.artifactIds?.length ?? 0) > 0,
        ),
        required: false,
        semantic: false,
      }
      obligations.push(obligation)
      byObligationId.set(obligation.id, obligation)
    }
    obligation.sourceIds.push(source.id)
    sourceOwners.set(source.id, obligation.id)
    mergeCategories(
      obligation,
      genericObservationCategories(
        source.kind,
        (source.artifactIds?.length ?? 0) > 0,
      ),
    )
  }

  for (const artifact of artifacts) {
    if (artifactOwners.has(artifact.id)) continue
    const candidateOwner = candidates
      .filter(({ artifactIds }) => artifactIds?.includes(artifact.id))
      .map(({ id }) => candidateOwners.get(id))
      .find((owner) => owner !== undefined)
    const sourceOwner = sources
      .filter(
        (source) =>
          source.artifactIds?.includes(artifact.id) ||
          artifact.sourceIds?.includes(source.id),
      )
      .map(({ id }) => sourceOwners.get(id))
      .find((owner) => owner !== undefined)
    const providerOwner = sources
      .filter(({ providerId }) => providerId === artifact.providerId)
      .map(({ id }) => sourceOwners.get(id))
      .find((owner) => owner !== undefined)
    const obligation = obligationFor(
      candidateOwner ?? sourceOwner ?? providerOwner,
    )
    if (!obligation) throw new Error('EVIDENCE_ARTIFACT_OWNER_REQUIRED')
    obligation.artifactIds.push(artifact.id)
    artifactOwners.set(artifact.id, obligation.id)
    mergeCategories(obligation, ['asset-bytes', 'clipping', 'overflow'])
  }
}

export async function assembleProductionSourceEvidence(
  options: SourceEvidenceAssemblerOptions,
  dependencies: SourceEvidenceAssemblerDependencies = {},
): Promise<SourceEvidenceAssemblerResult> {
  const deterministic = pdfEvidenceBundlesFromReconstruction(
    options.reconstruction,
    options.deterministic,
  )
  const deterministicBundle = deterministic.bundles.find(
    ({ armId }) => armId === 'deterministic',
  )
  if (!deterministicBundle) throw new Error('DETERMINISTIC_EVIDENCE_REQUIRED')
  const mineruRun = await (dependencies.runMineru ?? runOwnerLocalMineru)(
    options.mineru,
  )
  if (
    mineruRun.manifest.document.sha256 !== deterministicBundle.source.sha256 ||
    mineruRun.manifest.document.byteLength !==
      deterministicBundle.source.byteLength ||
    mineruRun.manifest.document.pageCount !==
      deterministicBundle.source.pageCount
  ) {
    throw new Error('MINERU_DETERMINISTIC_SOURCE_IDENTITY_MISMATCH')
  }
  const inspectedMineru = await inspectMineruSourceEvidence({
    artifactRoot: mineruRun.runDirectory,
    manifest: mineruRun.manifest,
  })
  const mineruBundle = {
    ...inspectedMineru,
    source: structuredClone(deterministicBundle.source),
  }
  const bundles = [...deterministic.bundles, mineruBundle]
  const obligations = structuredClone(deterministic.obligations)
  const disagreements = structuredClone(deterministic.disagreements)
  const candidates = bundles.flatMap((bundle) => bundle.candidates)
  attachMineruAlternatives(
    obligations,
    disagreements,
    candidates,
    mineruBundle.candidates,
  )
  completeEvidenceObligations(bundles, obligations)
  const arms: PdfEvidenceArmState[] = bundles.map((bundle) => ({
    id: bundle.armId,
    requirement:
      bundle.armId === 'deterministic' || bundle.armId === 'mineru'
        ? 'required'
        : 'optional',
    status: 'enabled',
    frozen: true,
    providerId: bundle.provider.id,
  }))
  const graph = buildSourceEvidenceGraph({
    schemaVersion: SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
    source: structuredClone(deterministicBundle.source),
    deterministicContext:
      deterministicContextReceiptForBundle(deterministicBundle),
    arms,
    bundles,
    obligations,
    disagreements,
  })
  return { graph, mineruRun }
}

export type { MineruArtifactManifest }
