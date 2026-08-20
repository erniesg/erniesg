import { structId } from '@erniesg/struct/ids'
import {
  canonicalTraceJson,
  hashTraceValue,
} from './reconstruction-attempt-trace'
import {
  createReconstructionCandidateBinding,
  createStructEvidencePatch,
  deriveStructRepairProjections,
  parseMaterializedRepairApplicationReceipt,
  validateReconstructionCandidate,
  type EvidenceCandidateResolutionReceipt,
  type GroundedVerifierReceipt,
  type MaterializationVerificationAuthorities,
  type MaterializedRepairApplicationReceipt,
  type ReconstructionCandidate,
  type ReconstructionCandidateContract,
  type SelectedGroundingVerificationRequest,
  type StructEvidencePatch,
  type StructEvidencePatchOperation,
  type UnchangedUnselectedProof,
} from './reconstruction-refinement'
import {
  materializeGroundedStruct,
  verifyGroundedCoreMaterializationBinding,
  type GroundedStructCandidateSelection,
  type GroundedStructMaterialization,
  type GroundedStructMaterializationInput,
} from './grounded-struct-materializer'
import { createSourceEvidenceContract } from './source-evidence-contract'
import type { StructuredExtractionProposal } from './structured-extraction'

export const GROUNDED_STRUCT_REPAIR_APPLICATION_SCHEMA_VERSION =
  '1.0.0' as const

export type GroundedStructRepairApplicationInput = {
  contract: ReconstructionCandidateContract
  beforeCandidate: ReconstructionCandidate
  beforeMaterialization: GroundedStructMaterialization
  materializationInput: GroundedStructMaterializationInput
  patch: StructEvidencePatch
  resultingProposal: StructuredExtractionProposal
  authorities: MaterializationVerificationAuthorities
}

export type GroundedStructRepairApplication = {
  materialization: GroundedStructMaterialization
  candidate: ReconstructionCandidate
  applicationReceipt: MaterializedRepairApplicationReceipt
  bridgeReceiptSha256: string
}

function invalid(code: string): never {
  throw new Error(code)
}

function samePatch(left: StructEvidencePatch, right: StructEvidencePatch) {
  return canonicalTraceJson(left) === canonicalTraceJson(right)
}

function targetSourceId(
  input: GroundedStructMaterializationInput,
  operation: StructEvidencePatchOperation,
) {
  if (operation.targetKind === 'block') {
    const node = input.proposal.nodes.find(
      (candidate) =>
        structId('block', `${input.context.sourceSha256}:${candidate.id}`) ===
        operation.targetId,
    )
    if (!node) invalid('UNKNOWN_GROUNDED_REPAIR_TARGET')
    return node.id
  }
  if (operation.targetKind === 'asset') {
    const asset = input.context.sourceAssets.find(
      (candidate) =>
        structId('asset', `${input.context.sourceSha256}:${candidate.id}`) ===
        operation.targetId,
    )
    if (!asset) invalid('UNKNOWN_GROUNDED_REPAIR_TARGET')
    return asset.id
  }
  const link = (input.context.sourceLinks ?? []).find(
    (candidate) =>
      structId('relationship', candidate.id) === operation.targetId,
  )
  if (link) return link.id
  const artifact = (input.context.provenArtifacts ?? []).find(
    (candidate) =>
      candidate.kind.endsWith('-relationship') &&
      structId('relationship', candidate.id) === operation.targetId,
  )
  if (!artifact) invalid('UNKNOWN_GROUNDED_REPAIR_TARGET')
  return artifact.id
}

function updatedSelections(
  input: GroundedStructMaterializationInput,
  patch: StructEvidencePatch,
) {
  const contract = createSourceEvidenceContract(
    input.graph,
    input.verifierIdentity,
  )
  const result = input.selections.map((selection) => structuredClone(selection))
  for (const operation of patch.operations) {
    const targetId = targetSourceId(input, operation)
    const index = result.findIndex(
      (selection) =>
        selection.targetKind === operation.targetKind &&
        selection.targetId === targetId,
    )
    if (index < 0) invalid('MISSING_GROUNDED_REPAIR_BASE_SELECTION')
    const reference = contract.candidateReferences.find(
      (candidate) =>
        candidate.referenceSha256 === operation.candidateReferenceSha256,
    )
    if (!reference) invalid('UNKNOWN_GROUNDED_REPAIR_CANDIDATE')
    const replacement: GroundedStructCandidateSelection = {
      ...operation,
      targetId,
      bindingSha256: reference.bindingSha256,
    }
    result.splice(index, 1, replacement)
  }
  return result
}

function resolveCandidatePayloads(input: GroundedStructRepairApplicationInput) {
  const references = [
    ...new Set(
      input.patch.operations.map(
        ({ candidateReferenceSha256 }) => candidateReferenceSha256,
      ),
    ),
  ].sort()
  return references.map((referenceSha256) => {
    const candidate = input.authorities.evidenceCandidates.find(
      (binding) => binding.referenceSha256 === referenceSha256,
    )
    if (!candidate) invalid('UNKNOWN_GROUNDED_REPAIR_CANDIDATE')
    return input.authorities.sourceEvidenceVerifier.resolveCandidate({
      schemaVersion: '1.0.0',
      sourceEvidenceGraphSha256: input.contract.sourceEvidenceGraph.sha256,
      referenceSha256,
      bindingSha256: candidate.bindingSha256,
    }) as EvidenceCandidateResolutionReceipt
  })
}

function applicationProjection(receipt: MaterializedRepairApplicationReceipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    proposalSha256: receipt.proposalSha256,
    operations: receipt.operations,
    beforeCanonicalStruct: receipt.beforeCanonicalStruct,
    beforeSelectedProjection: receipt.beforeSelectedProjection,
    beforeUnselectedProjection: receipt.beforeUnselectedProjection,
    resultingCanonicalStruct: receipt.resultingCanonicalStruct,
    resultingSelectedProjection: receipt.resultingSelectedProjection,
    resultingUnselectedProjection: receipt.resultingUnselectedProjection,
    groundedVerifier: receipt.groundedVerifier,
    unchangedUnselected: receipt.unchangedUnselected,
  }
}

/**
 * Apply a #199 patch to its receipt-free typed core, then independently bind
 * that core to the regenerated current-schema document and receipt.
 */
export function applyGroundedStructRepair(
  input: GroundedStructRepairApplicationInput,
): GroundedStructRepairApplication {
  const beforeBridge = verifyGroundedCoreMaterializationBinding(
    input.beforeMaterialization,
  )
  if (
    !validateReconstructionCandidate(input.beforeCandidate, input.contract) ||
    input.beforeCandidate.binding.canonicalStruct.sha256 !==
      beforeBridge.repairCore.sha256 ||
    input.beforeCandidate.binding.canonicalStruct.byteLength !==
      beforeBridge.repairCore.byteLength ||
    input.beforeCandidate.binding.sourcePdfSha256 !==
      input.beforeMaterialization.receipt.sourcePdfSha256 ||
    input.beforeCandidate.binding.sourceEvidenceGraphSha256 !==
      input.beforeMaterialization.receipt.sourceEvidenceGraphSha256
  ) {
    invalid('INVALID_GROUNDED_REPAIR_BASE')
  }
  const parsedPatch = createStructEvidencePatch({
    schemaVersion: input.patch.schemaVersion,
    documentId: input.patch.documentId,
    sourcePdfSha256: input.patch.sourcePdfSha256,
    sourceEvidenceGraphSha256: input.patch.sourceEvidenceGraphSha256,
    baseStructSha256: input.patch.baseStructSha256,
    priorTraceSha256: input.patch.priorTraceSha256,
    taskIdSha256: input.patch.taskIdSha256,
    operations: input.patch.operations,
  })
  if (
    !samePatch(parsedPatch, input.patch) ||
    input.patch.baseStructSha256 !== beforeBridge.repairCore.sha256 ||
    input.patch.sourcePdfSha256 !== input.contract.sourcePdfSha256 ||
    input.patch.sourceEvidenceGraphSha256 !==
      input.contract.sourceEvidenceGraph.sha256
  ) {
    invalid('INVALID_GROUNDED_REPAIR_PATCH')
  }
  const selections = updatedSelections(input.materializationInput, input.patch)
  const materialization = materializeGroundedStruct({
    ...input.materializationInput,
    proposal: input.resultingProposal,
    selections,
  })
  const resultingBridge =
    verifyGroundedCoreMaterializationBinding(materialization)
  if (
    resultingBridge.repairCore.sha256 === beforeBridge.repairCore.sha256 ||
    materialization.receipt.status !== 'publication-ready'
  ) {
    invalid('GROUNDED_REPAIR_DID_NOT_IMPROVE_CORE')
  }
  const beforeProjections = deriveStructRepairProjections(
    input.beforeMaterialization.repairCoreBytes,
    input.patch.operations,
  )
  const resultingProjections = deriveStructRepairProjections(
    materialization.repairCoreBytes,
    input.patch.operations,
  )
  if (
    beforeProjections.unselected.sha256 !==
      resultingProjections.unselected.sha256 ||
    beforeProjections.unselected.byteLength !==
      resultingProjections.unselected.byteLength
  ) {
    invalid('GROUNDED_REPAIR_CHANGED_UNSELECTED_CORE')
  }
  const candidatePayloads = resolveCandidatePayloads(input)
  const groundingRequest: SelectedGroundingVerificationRequest = {
    schemaVersion: '1.0.0',
    sourceEvidenceGraphSha256: input.contract.sourceEvidenceGraph.sha256,
    proposalSha256: input.patch.proposalSha256,
    operations: input.patch.operations,
    beforeCanonicalStruct: beforeBridge.repairCore,
    beforeCanonicalStructBytes: input.beforeMaterialization.repairCoreBytes,
    resultingCanonicalStruct: resultingBridge.repairCore,
    resultingCanonicalStructBytes: materialization.repairCoreBytes,
    beforeSelectedProjection: beforeProjections.selected,
    beforeSelectedProjectionBytes: beforeProjections.selectedBytes,
    resultingSelectedProjection: resultingProjections.selected,
    resultingSelectedProjectionBytes: resultingProjections.selectedBytes,
    candidatePayloads,
  }
  const executed = input.authorities.groundedVerifier.verifySelected(
    structuredClone(groundingRequest),
  ) as GroundedVerifierReceipt
  const unchangedProjection = {
    schemaVersion: '1.0.0' as const,
    beforeSha256: beforeProjections.unselected.sha256,
    afterSha256: resultingProjections.unselected.sha256,
  }
  const unchangedUnselected: UnchangedUnselectedProof = {
    ...unchangedProjection,
    receiptSha256: hashTraceValue(unchangedProjection),
  }
  const provisional: MaterializedRepairApplicationReceipt = {
    schemaVersion: '1.0.0',
    proposalSha256: input.patch.proposalSha256,
    operations: structuredClone(input.patch.operations),
    beforeCanonicalStruct: beforeBridge.repairCore,
    beforeCanonicalStructBytes:
      input.beforeMaterialization.repairCoreBytes.slice(),
    beforeSelectedProjection: beforeProjections.selected,
    beforeUnselectedProjection: beforeProjections.unselected,
    resultingCanonicalStruct: resultingBridge.repairCore,
    resultingCanonicalStructBytes: materialization.repairCoreBytes.slice(),
    resultingSelectedProjection: resultingProjections.selected,
    resultingUnselectedProjection: resultingProjections.unselected,
    groundedVerifier: executed,
    unchangedUnselected,
    receiptSha256: '',
  }
  provisional.receiptSha256 = hashTraceValue(applicationProjection(provisional))
  const verified = parseMaterializedRepairApplicationReceipt(
    provisional,
    input.beforeCandidate,
    input.patch,
    input.contract,
    input.authorities,
  )
  const patchedTargets = new Set(
    input.patch.operations.map(
      ({ targetKind, targetId }) => `${targetKind}:${targetId}`,
    ),
  )
  const candidate: ReconstructionCandidate = {
    binding: createReconstructionCandidateBinding({
      schemaVersion: '1.0.0',
      sourcePdfSha256: input.beforeCandidate.binding.sourcePdfSha256,
      sourceEvidenceGraphSha256:
        input.beforeCandidate.binding.sourceEvidenceGraphSha256,
      canonicalStruct: resultingBridge.repairCore,
      selections: [
        ...input.beforeCandidate.binding.selections.filter(
          ({ targetKind, targetId }) =>
            !patchedTargets.has(`${targetKind}:${targetId}`),
        ),
        ...input.patch.operations,
      ],
    }),
    canonicalStructBytes: materialization.repairCoreBytes.slice(),
  }
  const bridgeReceiptSha256 = hashTraceValue({
    schemaVersion: GROUNDED_STRUCT_REPAIR_APPLICATION_SCHEMA_VERSION,
    applicationReceiptSha256: verified.receiptSha256,
    beforeCoreToDocumentBindingSha256: beforeBridge.bindingSha256,
    resultingCoreToDocumentBindingSha256: resultingBridge.bindingSha256,
    resultingMaterializationReceiptSha256:
      materialization.receipt.receiptSha256,
    resultingGeneratedSha256: materialization.document.receipt.generatedSha256,
  })
  if (!validateReconstructionCandidate(candidate, input.contract)) {
    invalid('INVALID_GROUNDED_REPAIR_RESULT')
  }
  return {
    materialization,
    candidate,
    applicationReceipt: verified,
    bridgeReceiptSha256,
  }
}
