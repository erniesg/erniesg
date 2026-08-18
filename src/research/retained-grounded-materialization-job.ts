import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  GROUNDED_MATERIALIZATION_RETAINED_PACKETS,
  verifyGroundedMaterializationPilotMineruExecution,
  verifyGroundedMaterializationPilotRetainedSource,
  type GroundedMaterializationPilotCase,
  type GroundedMaterializationPilotDocument,
} from './grounded-materialization-pilot'
import {
  runOwnerLocalGroundedRefinement,
  type OwnerLocalGroundedRefinementInput,
} from './grounded-refinement-codex-client'
import {
  SOURCE_EPUB_OBSERVATION_CHECK_IDS,
  hashTraceValue,
} from './reconstruction-attempt-trace'
import type { GroundedVerifierIdentity } from './reconstruction-refinement'
import {
  createSourceEvidenceContract,
  type SourceEvidenceContract,
} from './source-evidence-contract'
import { buildSourceEvidenceGraph } from './source-evidence-graph'
import { sha256HexSync } from './sha256-sync'

export const RETAINED_GROUNDED_MATERIALIZATION_JOB_SCHEMA_VERSION =
  '1.0.0' as const

export type RetainedGroundedMaterializationPacketPaths = {
  caseId: GroundedMaterializationPilotCase
  sourcePdfPath: string
  artifactRoot: string
  packetDirectory: string
}

export type LoadedRetainedGroundedMaterializationPacket = {
  caseId: GroundedMaterializationPilotCase
  sourcePdfBytes: Uint8Array
  sourceExecution: GroundedMaterializationPilotDocument['sourceExecution']
  sourceContract: SourceEvidenceContract
  receipt: {
    schemaVersion: typeof RETAINED_GROUNDED_MATERIALIZATION_JOB_SCHEMA_VERSION
    caseId: GroundedMaterializationPilotCase
    sourcePdfSha256: string
    sourceGraphSha256: string
    retainedContractSha256: string
    manifestSha256: string
    producerReceiptSha256: string
    artifactSetSha256: string
    observationSetSha256: string
    receiptSha256: string
  }
}

export type RetainedOwnerLocalGroundedRefinementInput = Omit<
  OwnerLocalGroundedRefinementInput,
  'sourceContract'
> & {
  retainedPacket: RetainedGroundedMaterializationPacketPaths
}

function invalid(code: string): never {
  throw new Error(code)
}

async function exactBytes(path: string) {
  return new Uint8Array(await readFile(path))
}

/**
 * Load one exact #198 retained packet and replay graph -> contract before any
 * Codex, EPUB rendering, or Java boundary can run.
 */
export async function loadRetainedGroundedMaterializationPacket(
  input: RetainedGroundedMaterializationPacketPaths,
): Promise<LoadedRetainedGroundedMaterializationPacket> {
  const retained = GROUNDED_MATERIALIZATION_RETAINED_PACKETS[input.caseId]
  const [sourcePdfBytes, manifestBytes, graphBytes, contractBytes] =
    await Promise.all([
      exactBytes(input.sourcePdfPath),
      exactBytes(join(input.artifactRoot, 'manifest.json')),
      exactBytes(join(input.packetDirectory, 'source-evidence-graph.json')),
      exactBytes(join(input.packetDirectory, 'source-evidence-contract.json')),
    ])
  const expectedObservationPayloads = await Promise.all(
    SOURCE_EPUB_OBSERVATION_CHECK_IDS.map(async (check) => ({
      check,
      payloadBytes: await exactBytes(
        join(
          input.packetDirectory,
          retained.observationFilePrefix === '' ? 'observations' : '',
          `${retained.observationFilePrefix}${check}.json`,
        ),
      ),
    })),
  )
  let graphInput: Parameters<typeof buildSourceEvidenceGraph>[0]
  let retainedContract: { verifier?: GroundedVerifierIdentity }
  try {
    graphInput = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(graphBytes),
    )
    retainedContract = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(contractBytes),
    )
  } catch {
    invalid('INVALID_RETAINED_GROUNDED_MATERIALIZATION_PACKET_JSON')
  }
  if (!retainedContract.verifier) {
    invalid('INVALID_RETAINED_GROUNDED_MATERIALIZATION_VERIFIER')
  }
  const sourceContract = createSourceEvidenceContract(
    buildSourceEvidenceGraph(graphInput),
    retainedContract.verifier,
  )
  verifyGroundedMaterializationPilotRetainedSource(input.caseId, {
    sha256: sha256HexSync(sourcePdfBytes),
    byteLength: sourcePdfBytes.byteLength,
    pageCount: sourceContract.graph.source.pageCount,
  })
  const sourceExecution = {
    kind: 'retained-real-provider-packet' as const,
    artifactRoot: input.artifactRoot,
    manifestBytes,
    sourceEvidenceGraphBytes: graphBytes,
    sourceEvidenceContractBytes: contractBytes,
    expectedObservationPayloads,
  }
  const verified = await verifyGroundedMaterializationPilotMineruExecution({
    caseId: input.caseId,
    sourceExecution,
    sourcePdfSha256: sha256HexSync(sourcePdfBytes),
    sourceContract,
  })
  const projection = {
    schemaVersion: RETAINED_GROUNDED_MATERIALIZATION_JOB_SCHEMA_VERSION,
    caseId: input.caseId,
    sourcePdfSha256: sha256HexSync(sourcePdfBytes),
    sourceGraphSha256: verified.sourceGraphSha256,
    retainedContractSha256: verified.contractSha256,
    manifestSha256: verified.manifestSha256,
    producerReceiptSha256: verified.producerReceiptSha256,
    artifactSetSha256: verified.artifactSetSha256,
    observationSetSha256: verified.observationSetSha256,
  }
  return {
    caseId: input.caseId,
    sourcePdfBytes,
    sourceExecution,
    sourceContract,
    receipt: { ...projection, receiptSha256: hashTraceValue(projection) },
  }
}

/** Production #200 job composition over an exact retained packet. */
export async function runRetainedOwnerLocalGroundedRefinement(
  input: RetainedOwnerLocalGroundedRefinementInput,
) {
  const { retainedPacket, ...refinement } = input
  const packet = await loadRetainedGroundedMaterializationPacket(retainedPacket)
  if (
    refinement.sourcePdf.artifact.sha256 !== packet.receipt.sourcePdfSha256 ||
    refinement.sourcePdf.artifact.byteLength !==
      packet.sourcePdfBytes.byteLength ||
    refinement.sourcePdf.pageCount !==
      packet.sourceContract.graph.source.pageCount ||
    refinement.contract.sourcePdfSha256 !== packet.receipt.sourcePdfSha256 ||
    refinement.contract.sourceEvidenceGraph.sha256 !==
      packet.sourceContract.graphArtifact.sha256 ||
    refinement.initialMaterialization.receipt.sourcePdfSha256 !==
      packet.receipt.sourcePdfSha256 ||
    refinement.initialMaterialization.receipt.sourceEvidenceGraphSha256 !==
      packet.sourceContract.graphArtifact.sha256
  ) {
    invalid('RETAINED_GROUNDED_MATERIALIZATION_JOB_INPUT_MISMATCH')
  }
  const result = await runOwnerLocalGroundedRefinement({
    ...refinement,
    sourceContract: packet.sourceContract,
  })
  return { packet, result }
}
