import { sha256HexSync } from './sha256-sync'
import {
  SOURCE_EPUB_OBSERVATION_CHECK_IDS,
  canonicalTraceJson,
  encodeCanonicalObservationPayload,
  hashSourceEvidenceReceipt,
  hashSourceExpectedObservationSet,
  hashTraceValue,
  type CanonicalObservationPayload,
  type EvidenceCandidateReference,
  type SourceRegionObligation,
  type SourceEvidenceReceiptBinding,
  type SourceExpectedObservationSet,
} from './reconstruction-attempt-trace'
import type {
  EvidenceCandidateResolutionReceipt,
  GroundedVerifierIdentity,
  SourceEvidenceVerificationReceipt,
  SourceEvidenceVerifier,
} from './reconstruction-refinement'
import {
  readSourceEvidenceGraph,
  serializeSourceEvidenceGraph,
  PDF_EVIDENCE_OBSERVATION_CATEGORIES,
  type PdfEvidenceCandidate,
  type PdfEvidenceObligation,
  type SourceEvidenceGraph,
} from './source-evidence-graph'

export const SOURCE_EVIDENCE_CONTRACT_SCHEMA_VERSION = '1.0.0' as const

export type SourceEvidenceCandidateReference = {
  candidateId: string
  referenceSha256: string
  bindingSha256: string
  payload: { sha256: string; byteLength: number }
  payloadBytes: Uint8Array
}

export type VerifiedExpectedObservationSet = SourceExpectedObservationSet & {
  payloadBytes: Uint8Array
}

export type SourceEvidenceContract = {
  schemaVersion: typeof SOURCE_EVIDENCE_CONTRACT_SCHEMA_VERSION
  graph: SourceEvidenceGraph
  graphArtifact: { sha256: string; byteLength: number }
  graphBytes: Uint8Array
  sourceEvidenceReceipt: SourceEvidenceReceiptBinding
  sourceRegions: SourceRegionObligation[]
  evidenceCandidates: EvidenceCandidateReference[]
  expectedObservationSets: VerifiedExpectedObservationSet[]
  candidateReferences: SourceEvidenceCandidateReference[]
  verifier: SourceEvidenceVerifier
}

function sourceObligationProjection(obligations: PdfEvidenceObligation[]) {
  return obligations.map((obligation) => ({
    id: obligation.id,
    kind: obligation.kind,
    ...(obligation.page === undefined ? {} : { page: obligation.page }),
    sourceIds: [...obligation.sourceIds].sort(),
    artifactIds: [...obligation.artifactIds].sort(),
    candidateIds: [...obligation.candidateIds].sort(),
    observationCategories: [...obligation.observationCategories].sort(),
    required: obligation.required,
    semantic: obligation.semantic,
  }))
}

function outputRequiredSemanticObligations(graph: SourceEvidenceGraph) {
  return graph.obligations.filter(
    ({ required, semantic }) => required && semantic,
  )
}

function sourceRegions(graph: SourceEvidenceGraph): SourceRegionObligation[] {
  const reader = readSourceEvidenceGraph(graph)
  return outputRequiredSemanticObligations(graph)
    .map((obligation) => {
      const boxes = [
        ...obligation.sourceIds.flatMap((id) => {
          const box = reader.sourceItem(id)!.box
          return box ? [box] : []
        }),
        ...obligation.candidateIds.flatMap(
          (id) => reader.candidate(id)!.boxes ?? [],
        ),
        ...obligation.artifactIds.flatMap((id) => {
          const box = reader.artifact(id)!.box
          return box ? [box] : []
        }),
      ].filter(
        (box, index, all) =>
          all.findIndex(
            (candidate) =>
              canonicalTraceJson(candidate) === canonicalTraceJson(box),
          ) === index,
      )
      const page =
        obligation.page ??
        boxes[0]?.page ??
        graph.bundles[0]?.pages[0]?.page ??
        1
      return {
        id: obligation.id,
        source: {
          page,
          boxes: boxes
            .filter((box) => box.page === page)
            .map(({ page: boxPage, x, y, width, height, rotation }) => ({
              page: boxPage,
              x,
              y,
              width,
              height,
              rotation,
            })),
          sourceRegionIds: [obligation.id],
        },
      }
    })
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
}

function candidatePayload(
  graph: SourceEvidenceGraph,
  candidate: PdfEvidenceCandidate,
  reader: ReturnType<typeof readSourceEvidenceGraph>,
) {
  const sources = candidate.sourceIds.map((id) => reader.sourceItem(id)!)
  const artifacts = (candidate.artifactIds ?? []).map((id) =>
    reader.artifact(id)!,
  )
  return {
    schemaVersion: SOURCE_EVIDENCE_CONTRACT_SCHEMA_VERSION,
    sourceEvidenceGraphSha256: graph.graphSha256,
    candidate,
    sources,
    artifacts,
  }
}

function candidateReferences(graph: SourceEvidenceGraph) {
  const reader = readSourceEvidenceGraph(graph)
  return reader
    .allCandidates()
    .map((candidate): SourceEvidenceCandidateReference => {
      const payloadBytes = new TextEncoder().encode(
        canonicalTraceJson(candidatePayload(graph, candidate, reader)),
      )
      const payload = {
        sha256: sha256HexSync(payloadBytes),
        byteLength: payloadBytes.byteLength,
      }
      const referenceSha256 = hashTraceValue({
        schemaVersion: SOURCE_EVIDENCE_CONTRACT_SCHEMA_VERSION,
        sourceEvidenceGraphSha256: graph.graphSha256,
        candidateId: candidate.id,
        payload,
      })
      return {
        candidateId: candidate.id,
        referenceSha256,
        bindingSha256: hashTraceValue({
          schemaVersion: SOURCE_EVIDENCE_CONTRACT_SCHEMA_VERSION,
          sourcePdfSha256: graph.source.sha256,
          sourceEvidenceGraphSha256: graph.graphSha256,
          referenceSha256,
          providerId: candidate.providerId,
          sourceIds: [...candidate.sourceIds].sort(),
          artifactIds: [...(candidate.artifactIds ?? [])].sort(),
          payload,
        }),
        payload,
        payloadBytes,
      }
    })
    .sort((left, right) =>
      left.referenceSha256 < right.referenceSha256 ? -1 : 1,
    )
}

function expectedSets(
  graph: SourceEvidenceGraph,
  references: SourceEvidenceCandidateReference[],
) {
  const reader = readSourceEvidenceGraph(graph)
  const referenceByCandidate = new Map(
    references.map((reference) => [reference.candidateId, reference]),
  )
  return SOURCE_EPUB_OBSERVATION_CHECK_IDS.map(
    (check): VerifiedExpectedObservationSet => {
      const applicable = outputRequiredSemanticObligations(graph).filter(
        (obligation) => obligation.observationCategories.includes(check),
      )
      const payload: CanonicalObservationPayload = {
        schemaVersion: '1.0.0',
        check,
        items: applicable
          .map((obligation) => {
            const candidates = obligation.candidateIds.map((id) =>
              reader.candidate(id)!,
            )
            const sourceIds = [
              ...new Set([
                ...obligation.sourceIds,
                ...candidates.flatMap(({ sourceIds }) => sourceIds),
              ]),
            ].sort()
            const artifacts = [
              ...new Set(
                candidates.flatMap(({ artifactIds }) => artifactIds ?? []),
              ),
            ]
              .sort()
              .map((id) => reader.artifact(id)!)
            return {
              idSha256: hashTraceValue({ check, obligationId: obligation.id }),
              valueSha256: hashTraceValue({
                schemaVersion: SOURCE_EVIDENCE_CONTRACT_SCHEMA_VERSION,
                sourcePdfSha256: graph.source.sha256,
                check,
                obligation: sourceObligationProjection([obligation])[0],
                sourceAnchors: sourceIds.map((id) => {
                  const source = reader.sourceItem(id)!
                  return {
                    id: source.id,
                    kind: source.kind,
                    page: source.page ?? null,
                    box: source.box ?? null,
                    payload: source.payload ?? null,
                  }
                }),
                candidates: candidates.map((candidate) => ({
                  id: candidate.id,
                  kind: candidate.kind,
                  page: candidate.page ?? null,
                  boxes: candidate.boxes ?? [],
                  sourceIds: [...candidate.sourceIds].sort(),
                  artifactIds: [...(candidate.artifactIds ?? [])].sort(),
                  payload: candidate.payload ?? null,
                  referenceSha256: referenceByCandidate.get(candidate.id)!
                    .referenceSha256,
                })),
                artifacts: artifacts.map((artifact) => ({
                  id: artifact.id,
                  kind: artifact.kind,
                  mediaType: artifact.mediaType,
                  sha256: artifact.sha256,
                  byteLength: artifact.byteLength,
                  page: artifact.page ?? null,
                  box: artifact.box ?? null,
                })),
              }),
              anchorIds: sourceIds,
            }
          })
          .sort((left, right) => (left.idSha256 < right.idSha256 ? -1 : 1)),
      }
      const payloadBytes = encodeCanonicalObservationPayload(payload)
      const base = {
        check,
        setSha256: sha256HexSync(payloadBytes),
        itemCount: payload.items.length,
        payload: {
          sha256: sha256HexSync(payloadBytes),
          byteLength: payloadBytes.byteLength,
        },
        sourceRegionIds: [
          ...new Set(applicable.map(({ id }) => id)),
        ].sort(),
      }
      const set: SourceExpectedObservationSet = {
        ...base,
        receiptSha256: hashSourceExpectedObservationSet({
          ...base,
          receiptSha256: '0'.repeat(64),
        }),
      }
      return { ...set, payloadBytes }
    },
  )
}

function identitySha256(identity: GroundedVerifierIdentity) {
  return hashTraceValue(identity)
}

function verificationProjection(receipt: SourceEvidenceVerificationReceipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    verifierIdentity: receipt.verifierIdentity,
    verifierIdentitySha256: receipt.verifierIdentitySha256,
    requestSha256: receipt.requestSha256,
    evidenceGraph: receipt.evidenceGraph,
    expectedObservationSets: receipt.expectedObservationSets.map(
      ({ payloadBytes: _payloadBytes, ...set }) => set,
    ),
    status: receipt.status,
  }
}

function candidateResolutionProjection(
  receipt: EvidenceCandidateResolutionReceipt,
) {
  const {
    payloadBytes: _payloadBytes,
    receiptSha256: _receiptSha256,
    ...projection
  } = receipt
  return projection
}

export function createSourceEvidenceContract(
  graph: SourceEvidenceGraph,
  verifierIdentity: GroundedVerifierIdentity,
): SourceEvidenceContract {
  if (
    hashTraceValue(PDF_EVIDENCE_OBSERVATION_CATEGORIES) !==
    hashTraceValue(SOURCE_EPUB_OBSERVATION_CHECK_IDS)
  ) {
    throw new TypeError('SOURCE_OBSERVATION_CATEGORY_CONTRACT_MISMATCH')
  }
  const graphBytes = serializeSourceEvidenceGraph(graph)
  const graphArtifact = {
    sha256: graph.graphSha256,
    byteLength: graphBytes.byteLength,
  }
  const references = candidateReferences(graph)
  const evidenceCandidates: EvidenceCandidateReference[] = references.map(
    ({ referenceSha256, bindingSha256 }) => ({
      referenceSha256,
      bindingSha256,
    }),
  )
  const sets = expectedSets(graph, references)
  const regions = sourceRegions(graph)
  const obligationProjection = regions
  if (obligationProjection.length === 0) {
    throw new TypeError('SOURCE_EVIDENCE_OBLIGATIONS_REQUIRED')
  }
  const sourceObligationBase = {
    obligationsSha256: hashTraceValue(obligationProjection),
    obligationCount: obligationProjection.length,
  }
  const sourceObligations = {
    ...sourceObligationBase,
    receiptSha256: hashTraceValue({
      sourcePdfSha256: graph.source.sha256,
      ...sourceObligationBase,
    }),
  }
  const receiptBase = {
    schemaVersion: SOURCE_EVIDENCE_CONTRACT_SCHEMA_VERSION,
    sourcePdfSha256: graph.source.sha256,
    evidenceGraphSha256: graph.graphSha256,
    candidateSetSha256: hashTraceValue(evidenceCandidates),
    sourceObligations,
    expectedObservationSets: sets.map(
      ({ payloadBytes: _payloadBytes, ...set }) => set,
    ),
  }
  const sourceEvidenceReceipt: SourceEvidenceReceiptBinding = {
    ...receiptBase,
    receiptSha256: hashSourceEvidenceReceipt({
      ...receiptBase,
      receiptSha256: '0'.repeat(64),
    }),
  }
  const identityHash = identitySha256(verifierIdentity)
  const referenceByHash = new Map(
    references.map((reference) => [reference.referenceSha256, reference]),
  )
  const verifier: SourceEvidenceVerifier = {
    identity: structuredClone(verifierIdentity),
    verifyExpected(request): SourceEvidenceVerificationReceipt {
      if (
        request.schemaVersion !== '1.0.0' ||
        request.sourcePdfSha256 !== graph.source.sha256 ||
        request.evidenceGraph.sha256 !== graphArtifact.sha256 ||
        request.evidenceGraph.byteLength !== graphArtifact.byteLength ||
        request.sourceObligationsSha256 !== sourceObligations.obligationsSha256
      ) {
        throw new TypeError('SOURCE_EVIDENCE_VERIFICATION_REQUEST_MISMATCH')
      }
      const base = {
        schemaVersion: '1.0.0' as const,
        verifierIdentity: structuredClone(verifierIdentity),
        verifierIdentitySha256: identityHash,
        requestSha256: hashTraceValue(request),
        evidenceGraph: graphArtifact,
        evidenceGraphBytes: graphBytes.slice(),
        expectedObservationSets: sets.map((set) => ({
          ...set,
          payloadBytes: set.payloadBytes.slice(),
        })),
        status: 'succeeded' as const,
      }
      return {
        ...base,
        receiptSha256: hashTraceValue(
          verificationProjection({
            ...base,
            receiptSha256: '0'.repeat(64),
          }),
        ),
      }
    },
    resolveCandidate(request): EvidenceCandidateResolutionReceipt {
      const reference = referenceByHash.get(request.referenceSha256)
      if (
        request.schemaVersion !== '1.0.0' ||
        request.sourceEvidenceGraphSha256 !== graph.graphSha256 ||
        !reference ||
        request.bindingSha256 !== reference.bindingSha256
      ) {
        throw new TypeError('SOURCE_EVIDENCE_CANDIDATE_REQUEST_MISMATCH')
      }
      const base = {
        schemaVersion: '1.0.0' as const,
        verifierIdentity: structuredClone(verifierIdentity),
        verifierIdentitySha256: identityHash,
        requestSha256: hashTraceValue(request),
        referenceSha256: reference.referenceSha256,
        bindingSha256: reference.bindingSha256,
        payload: reference.payload,
        payloadBytes: reference.payloadBytes.slice(),
        status: 'succeeded' as const,
      }
      return {
        ...base,
        receiptSha256: hashTraceValue(
          candidateResolutionProjection({
            ...base,
            receiptSha256: '0'.repeat(64),
          }),
        ),
      }
    },
  }
  return Object.freeze({
    schemaVersion: SOURCE_EVIDENCE_CONTRACT_SCHEMA_VERSION,
    graph,
    graphArtifact,
    graphBytes,
    sourceEvidenceReceipt,
    sourceRegions: regions,
    evidenceCandidates,
    expectedObservationSets: sets,
    candidateReferences: references,
    verifier,
  })
}
