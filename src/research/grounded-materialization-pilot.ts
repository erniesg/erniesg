import {
  PINNED_EPUBCHECK_JAR_SHA256,
  PINNED_EPUBCHECK_TOOL_VERSION,
  verifyActualProfiledEpubRender,
  verifyEpubCheckReceipt,
  type ActualProfiledEpubRender,
  type EpubCheckReceipt,
} from './actual-profiled-epub'
import {
  compareGroundedProfiledEpub,
  type GroundedProfiledEpubComparison,
} from './grounded-epub-comparison'
import {
  verifyGroundedCoreMaterializationBinding,
  type GroundedStructMaterialization,
} from './grounded-struct-materializer'
import {
  CLOSED_RECONSTRUCTION_PROFILE_IDS,
  createClosedThreeProfileReconstructionReceipt,
  type ClosedThreeProfileReconstructionReceipt,
  type ProfiledStructEpubArtifact,
} from './reconstruction-materialization'
import {
  canonicalTraceJson,
  hashTraceValue,
  parseReconstructionAttemptTrace,
  type ReconstructionAttemptTrace,
} from './reconstruction-attempt-trace'
import { sha256HexSync } from './sha256-sync'
import {
  createSourceEvidenceContract,
  serializeSourceEvidenceContractAudit,
  type SourceEvidenceContract,
} from './source-evidence-contract'
import type { LocalCodexReconciliationResult } from './local-codex-reconciliation'
import {
  verifyGroundedThreeProfileRefinementResult,
  type GroundedThreeProfileRefinementResult,
} from './grounded-reconstruction-refinement'
import {
  buildSourceEvidenceGraph,
  readSourceEvidenceGraph,
  type PdfEvidenceBundle,
} from './source-evidence-graph'
import {
  inspectMineruSourceEvidence,
  type MineruArtifactManifest,
} from './mineru-source-evidence'

export const GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION = '1.0.0' as const
const SHA256 = /^[a-f0-9]{64}$/u
export const GROUNDED_MATERIALIZATION_PINNED_EPUBCHECK = {
  toolVersion: PINNED_EPUBCHECK_TOOL_VERSION,
  jarSha256: PINNED_EPUBCHECK_JAR_SHA256,
} as const

export const GROUNDED_MATERIALIZATION_PILOT_CASES = [
  'prose-hierarchy',
  'semantic-table-spans',
  'formula-text',
  'source-backed-figure',
  'link-destinations',
] as const

/** Exact retained packet identities authorized for the five #200 cases. */
export const GROUNDED_MATERIALIZATION_RETAINED_PACKETS = {
  'prose-hierarchy': {
    observationFilePrefix: 'expected-',
    contractLayout: 'expected-observations-first',
    source: {
      sha256:
        '50874645b2cec033726018c86974241db2048ac46291e02fcb25d3cb7fbaa907',
      byteLength: 909,
      pageCount: 1,
    },
    manifestSha256:
      '8d1d273c53f884ce1459f02940076526dad89430e2c5cd248ddb5cbc6a571583',
    producerReceiptSha256:
      'dfcb4a838450f85f33a731773f378509e4bcd4d7c294a06398115f0876c3a786',
    artifactSetSha256:
      '666e549ac5b20897a92849ce949fe7e1b712cde502348f7bfb94f949e4493ac3',
    graph: {
      sha256:
        'e1a3003d3aba37376e022be00bd898fa6ee6d1da6a78610266ee27f0e51cfeed',
      byteLength: 94_488,
    },
    contract: {
      sha256:
        '2d104940c4b4440b258e6348dc6595d5a5b1c1190bddcd927d8749b5c9a40f2e',
      byteLength: 40_135,
      sourceEvidenceReceiptSha256:
        '2795404e7fafb8e8e2e3dbcc690ab3e78c76c525faccfcaed421c7b7d73878c3',
    },
  },
  'semantic-table-spans': {
    observationFilePrefix: 'expected-',
    contractLayout: 'expected-observations-first',
    source: {
      sha256:
        '7a75163906224b0dbf78e28975f6e16ec0e3b7485532995f9a1226b3f1928500',
      byteLength: 6_075,
      pageCount: 1,
    },
    manifestSha256:
      '17fc3326619a1d2fe74a45d3d4d97e3fb6db0b6b4427556b90da540aba891327',
    producerReceiptSha256:
      '4e6622c80b1cdd2ff6cb42165e2ef6da77671d34382b68a15f1da02bc921b59b',
    artifactSetSha256:
      'f841e05f4568358f4d4c0227c1074efb1c0d6142a98f708d57305411a37edac0',
    graph: {
      sha256:
        'd0d90647db91a713ed6c72f5f4a64884ca53d1432bd2919561140bb6cffc16ac',
      byteLength: 276_759,
    },
    contract: {
      sha256:
        'f1abb6037652d033c6026631bf4957f8c9f70f42ca3b80ac5943f91bd3b70f33',
      byteLength: 110_294,
      sourceEvidenceReceiptSha256:
        '80eae024af58e23b44fb5ac9939a0b34679a38505371a1069fce825a9fa7cb59',
    },
  },
  'formula-text': {
    observationFilePrefix: '',
    contractLayout: 'candidate-references-first',
    source: {
      sha256:
        '17921375594e87b1377e86d304f9f151c393255eb94b8e0f523179f6b9e07cea',
      byteLength: 16_759,
      pageCount: 3,
    },
    manifestSha256:
      'f7b3c3f4c6d6d650e66dbbc290566a0ba2479895952fbc222f8b21bd403ff60a',
    producerReceiptSha256:
      '96d546550d15a9f995108b8ceb57f5843b6077570576e0916a5668b8ea68e6c0',
    artifactSetSha256:
      'f51d12baa239ada8322675a72b464c222a76e1e98246c17c5d307ae31af31efc',
    graph: {
      sha256:
        'd595cf6935deeda4236e88b2fedd9d615cfb286b7abdcf96ffb92060e2bae009',
      byteLength: 459_445,
    },
    contract: {
      sha256:
        'f1ae75866807064187cb22017e9d821fd59847cf42b627c5f1cc2e2154e604d4',
      byteLength: 181_853,
      sourceEvidenceReceiptSha256:
        '8eaca4458ba1d5f5d1be72fe0fbf3df34a2e3db15b2394a9d7a89e06f6705079',
    },
  },
  'source-backed-figure': {
    observationFilePrefix: 'expected-',
    contractLayout: 'expected-observations-first',
    source: {
      sha256:
        '3812a7ef7b1de172ad2dab7367c5bdc1c7ca085e30c25a5ef8a72debdff92d2f',
      byteLength: 56_301,
      pageCount: 4,
    },
    manifestSha256:
      'bde77bfd3e95cbf20ad4b711d9dccd214231c613e581a6d83ca8c0309ceb1bb2',
    producerReceiptSha256:
      'f1ce8464fa00f77ce8e6dc187e8ee732a2c4fc426d278440749bac30ba7eaaf1',
    artifactSetSha256:
      '1048ce36a62a73e983e0b0f8872bdd42a1f1cc065590759f74709a24c6f8e6d2',
    graph: {
      sha256:
        '849f71dece39865b644c7c7feade175578b6829eaf4d239d509d5239049d616e',
      byteLength: 632_737,
    },
    contract: {
      sha256:
        '5e5f664dff119797e883f958617fff5ae4c4afed6d028c62546101fa0e7e3a0c',
      byteLength: 233_078,
      sourceEvidenceReceiptSha256:
        'af574b6a96b28efcbfef9d8f9548b55b392b1f38139f13aff2113b9659454a7b',
    },
  },
  'link-destinations': {
    observationFilePrefix: '',
    contractLayout: 'candidate-references-first',
    source: {
      sha256:
        '2bf82220bb559f9b39d388aa99c5a4011b6788da85a513a6edd62a42b365c56d',
      byteLength: 1_414,
      pageCount: 2,
    },
    manifestSha256:
      '1e34ba4c901dea1a637bbb91e941211881ecf4b8db97ac886ae0eebee7ad55df',
    producerReceiptSha256:
      '2036cd37ed8f12bd51c9d52024fcba463508d376c56525e52e56c7efda129eb1',
    artifactSetSha256:
      'b63c6e929c951ba93738a18bc93c8ad7c7718d979efb1befbd51a7698cbc0f4f',
    graph: {
      sha256:
        '5ebe4cea992eb7ea8019b3898d8ac6529aeb90e1de0f7ae852882f02606af258',
      byteLength: 115_462,
    },
    contract: {
      sha256:
        '48bab76a99ce87ce1274c1dc5316b858d6871457371f389caf0428883ed0a688',
      byteLength: 54_292,
      sourceEvidenceReceiptSha256:
        '2d01c5d71193011f7393e318b347049d61d1731b4d2fd5356e08ef123da7cd56',
    },
  },
} as const satisfies Record<
  (typeof GROUNDED_MATERIALIZATION_PILOT_CASES)[number],
  unknown
>

export type GroundedMaterializationPilotCase =
  (typeof GROUNDED_MATERIALIZATION_PILOT_CASES)[number]

export type GroundedMaterializationPilotProfile = {
  build: ProfiledStructEpubArtifact
  render: ActualProfiledEpubRender
  epubCheck: EpubCheckReceipt
  comparison: GroundedProfiledEpubComparison
  trace: ReconstructionAttemptTrace
}

export type GroundedMaterializationPilotDocument = {
  caseId: GroundedMaterializationPilotCase
  sourcePdfBytes: Uint8Array
  sourceExecution: {
    kind: 'retained-real-provider-packet'
    artifactRoot: string
    manifestBytes: Uint8Array
    sourceEvidenceGraphBytes: Uint8Array
    sourceEvidenceContractBytes: Uint8Array
    expectedObservationPayloads: Array<{
      check: SourceEvidenceContract['expectedObservationSets'][number]['check']
      payloadBytes: Uint8Array
    }>
  }
  materialization: GroundedStructMaterialization
  sourceContract: SourceEvidenceContract
  priorTrace: ReconstructionAttemptTrace
  localCodexResult: LocalCodexReconciliationResult
  refinement: GroundedThreeProfileRefinementResult
  profiles: GroundedMaterializationPilotProfile[]
  outerReceipt: ClosedThreeProfileReconstructionReceipt
}

export type GroundedMaterializationPilotPacket = {
  schemaVersion: typeof GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION
  documents: GroundedMaterializationPilotDocument[]
  negativeControls: Array<{
    id: 'malformed-source-evidence'
    status: 'rejected'
    reason: string
  }>
}

export type GroundedMaterializationPilotReceipt = {
  schemaVersion: typeof GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION
  caseIds: typeof GROUNDED_MATERIALIZATION_PILOT_CASES
  documentCount: 5
  profileCount: 15
  documents: Array<{
    caseId: GroundedMaterializationPilotCase
    sourcePdfSha256: string
    mineruManifestSha256: string
    mineruProducerReceiptSha256: string
    mineruArtifactSetSha256: string
    retainedSourceGraphSha256: string
    retainedContractSha256: string
    retainedObservationSetSha256: string
    materializationReceiptSha256: string
    outerReceiptSha256: string
    localCodexReceiptSha256: string
    refinementReceiptSha256: string
    codexRepairEvidenceSha256s: string[]
    profiles: Array<{
      profileId: ProfiledStructEpubArtifact['profileId']
      epubSha256: string
      renderReceiptSha256: string
      epubCheckReceiptSha256: string
      comparisonReceiptSha256: string
      traceSha256: string
    }>
  }>
  negativeControlReceiptSha256: string
  status: 'passed'
  receiptSha256: string
}

function invalid(code: string): never {
  throw new Error(code)
}

export function verifyGroundedMaterializationPilotEpubCheckAuthority(
  receipt: EpubCheckReceipt,
) {
  verifyEpubCheckReceipt(receipt)
  if (
    receipt.authority !== 'pinned-java-jar' ||
    receipt.toolVersion !==
      GROUNDED_MATERIALIZATION_PINNED_EPUBCHECK.toolVersion ||
    receipt.executableSha256 !==
      GROUNDED_MATERIALIZATION_PINNED_EPUBCHECK.jarSha256
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_REAL_EPUBCHECK_REQUIRED')
  }
}

export function verifyGroundedMaterializationPilotRetainedSource(
  caseId: GroundedMaterializationPilotCase,
  source: { sha256: string; byteLength: number; pageCount: number },
) {
  const expected = GROUNDED_MATERIALIZATION_RETAINED_PACKETS[caseId].source
  if (hashTraceValue(source) !== hashTraceValue(expected)) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_UNRETAINED_SOURCE')
  }
}

export function verifyRetainedGroundedMaterializationSourceArtifacts(input: {
  caseId: GroundedMaterializationPilotCase
  sourceExecution: GroundedMaterializationPilotDocument['sourceExecution']
  sourceContract: SourceEvidenceContract
}) {
  const { sourceExecution, sourceContract } = input
  const expected = GROUNDED_MATERIALIZATION_RETAINED_PACKETS[input.caseId]
  if (
    sourceExecution.kind !== 'retained-real-provider-packet' ||
    !(sourceExecution.sourceEvidenceGraphBytes instanceof Uint8Array) ||
    !Array.isArray(sourceExecution.expectedObservationPayloads) ||
    !(sourceExecution.sourceEvidenceContractBytes instanceof Uint8Array) ||
    sha256HexSync(sourceExecution.sourceEvidenceGraphBytes) !==
      expected.graph.sha256 ||
    sourceExecution.sourceEvidenceGraphBytes.byteLength !==
      expected.graph.byteLength ||
    sha256HexSync(sourceExecution.sourceEvidenceContractBytes) !==
      expected.contract.sha256 ||
    sourceExecution.sourceEvidenceContractBytes.byteLength !==
      expected.contract.byteLength
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_RETAINED_GRAPH_MISMATCH')
  }
  let retainedGraphInput: unknown
  let retainedContractProjection: unknown
  try {
    retainedGraphInput = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        sourceExecution.sourceEvidenceGraphBytes,
      ),
    )
    retainedContractProjection = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        sourceExecution.sourceEvidenceContractBytes,
      ),
    )
  } catch {
    invalid('GROUNDED_MATERIALIZATION_PILOT_RETAINED_GRAPH_MISMATCH')
  }
  const reconstructedContract = createSourceEvidenceContract(
    buildSourceEvidenceGraph(
      retainedGraphInput as Parameters<typeof buildSourceEvidenceGraph>[0],
    ),
    sourceContract.verifier.identity,
  )
  const reconstructedContractBytes = serializeSourceEvidenceContractAudit(
    reconstructedContract,
    expected.contractLayout,
  )
  const callerContractBytes = serializeSourceEvidenceContractAudit(
    sourceContract,
    expected.contractLayout,
  )
  if (
    !Buffer.from(sourceExecution.sourceEvidenceContractBytes).equals(
      Buffer.from(reconstructedContractBytes),
    ) ||
    !Buffer.from(reconstructedContractBytes).equals(
      Buffer.from(callerContractBytes),
    ) ||
    canonicalTraceJson(retainedContractProjection) !==
      canonicalTraceJson(
        JSON.parse(new TextDecoder().decode(reconstructedContractBytes)),
      ) ||
    reconstructedContract.graphArtifact.sha256 !== expected.graph.sha256 ||
    reconstructedContract.sourceEvidenceReceipt.receiptSha256 !==
      expected.contract.sourceEvidenceReceiptSha256 ||
    !Buffer.from(sourceExecution.sourceEvidenceGraphBytes).equals(
      Buffer.from(reconstructedContract.graphBytes),
    )
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_RETAINED_CONTRACT_MISMATCH')
  }
  const retainedObservationPayloads = new Map(
    sourceExecution.expectedObservationPayloads.map((payload) => [
      payload.check,
      payload.payloadBytes,
    ]),
  )
  if (
    retainedObservationPayloads.size !==
      reconstructedContract.expectedObservationSets.length ||
    reconstructedContract.expectedObservationSets.some((observation) => {
      const bytes = retainedObservationPayloads.get(observation.check)
      return (
        !bytes ||
        sha256HexSync(bytes) !== observation.payload.sha256 ||
        bytes.byteLength !== observation.payload.byteLength ||
        !Buffer.from(bytes).equals(Buffer.from(observation.payloadBytes))
      )
    })
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_RETAINED_OBSERVATIONS_MISMATCH')
  }
  return {
    sourceGraphSha256: reconstructedContract.graphArtifact.sha256,
    contractSha256: expected.contract.sha256,
    observationSetSha256: hashTraceValue(
      sourceContract.expectedObservationSets.map(({ check, payload }) => ({
        check,
        payload,
      })),
    ),
  }
}

function assertCaseSemantics(document: GroundedMaterializationPilotDocument) {
  const { blocks, assets, relationships } = document.materialization.document
  switch (document.caseId) {
    case 'prose-hierarchy':
      if (blocks.filter(({ kind }) => kind === 'heading').length < 2)
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      return
    case 'semantic-table-spans':
      if (
        !blocks.some(
          ({ kind, table }) =>
            kind === 'table' &&
            table?.semantic === 'verified' &&
            table.cells.some(
              ({ rowSpan, columnSpan }) => rowSpan > 1 || columnSpan > 1,
            ),
        )
      ) {
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      }
      return
    case 'formula-text':
      if (
        !blocks.some(
          ({ kind, text }) => kind === 'equation' && text.trim().length > 0,
        ) ||
        document.materialization.receipt.reviewReasons.includes(
          'formula-visual-crop',
        )
      ) {
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      }
      return
    case 'source-backed-figure':
      if (
        !blocks.some(
          ({ kind, fallbackAssetIds }) =>
            kind === 'figure' &&
            (fallbackAssetIds ?? []).some((id) =>
              assets.some(
                (asset) =>
                  asset.id === id &&
                  (asset.kind === 'figure' || asset.kind === 'diagram') &&
                  asset.fallback === 'asset',
              ),
            ),
        )
      ) {
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      }
      return
    case 'link-destinations':
      if (
        !relationships.some(
          ({ kind, status, to }) =>
            kind === 'hyperlink' && status === 'matched' && to.length === 1,
        )
      ) {
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      }
  }
}

export async function verifyGroundedMaterializationPilotMineruExecution(input: {
  caseId: GroundedMaterializationPilotCase
  sourceExecution: GroundedMaterializationPilotDocument['sourceExecution']
  sourcePdfSha256: string
  sourceContract: SourceEvidenceContract
}) {
  if (
    !input.sourceExecution ||
    input.sourceExecution.kind !== 'retained-real-provider-packet' ||
    typeof input.sourceExecution.artifactRoot !== 'string' ||
    input.sourceExecution.artifactRoot.length === 0 ||
    !(input.sourceExecution.manifestBytes instanceof Uint8Array) ||
    !(input.sourceExecution.sourceEvidenceGraphBytes instanceof Uint8Array) ||
    !(
      input.sourceExecution.sourceEvidenceContractBytes instanceof Uint8Array
    ) ||
    !Array.isArray(input.sourceExecution.expectedObservationPayloads)
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_MINERU_EXECUTION_REQUIRED')
  }
  let manifest: MineruArtifactManifest
  try {
    manifest = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        input.sourceExecution.manifestBytes,
      ),
    ) as MineruArtifactManifest
  } catch {
    invalid('INVALID_GROUNDED_MATERIALIZATION_PILOT_MINERU_MANIFEST')
  }
  const inspected = await inspectMineruSourceEvidence({
    artifactRoot: input.sourceExecution.artifactRoot,
    manifest,
  })
  const retainedArtifacts =
    verifyRetainedGroundedMaterializationSourceArtifacts({
      caseId: input.caseId,
      sourceExecution: input.sourceExecution,
      sourceContract: input.sourceContract,
    })
  const retained = input.sourceContract.graph.bundles.filter(
    ({ armId }) => armId === 'mineru',
  )
  const expected = GROUNDED_MATERIALIZATION_RETAINED_PACKETS[input.caseId]
  if (
    sha256HexSync(input.sourceExecution.manifestBytes) !==
      expected.manifestSha256 ||
    manifest.producerReceipt.receiptSha256 !== expected.producerReceiptSha256 ||
    manifest.producerReceipt.artifactSetSha256 !== expected.artifactSetSha256
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_MINERU_MANIFEST_MISMATCH')
  }
  if (
    retained.length !== 1 ||
    manifest.document.sha256 !== input.sourcePdfSha256
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_MINERU_GRAPH_MISMATCH')
  }
  const comparableMineruBundle = (bundle: PdfEvidenceBundle) => ({
    schemaVersion: bundle.schemaVersion,
    id: bundle.id,
    armId: bundle.armId,
    source: {
      sha256: bundle.source.sha256,
      byteLength: bundle.source.byteLength,
      pageCount: bundle.source.pageCount,
    },
    provider: bundle.provider,
    pages: [...bundle.pages].sort((left, right) => left.page - right.page),
    artifacts: [...bundle.artifacts].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    sources: [...bundle.sources].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    candidates: [...bundle.candidates].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  })
  if (
    hashTraceValue(comparableMineruBundle(retained[0]!)) !==
    hashTraceValue(comparableMineruBundle(inspected))
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_MINERU_REPLAY_MISMATCH')
  }
  return {
    manifestSha256: sha256HexSync(input.sourceExecution.manifestBytes),
    producerReceiptSha256: manifest.producerReceipt.receiptSha256,
    artifactSetSha256: manifest.producerReceipt.artifactSetSha256,
    ...retainedArtifacts,
  }
}

async function verifyDocument(document: GroundedMaterializationPilotDocument) {
  if (
    document.materialization.document.schemaVersion !== '0.2.0' ||
    document.materialization.receipt.status !== 'publication-ready' ||
    document.materialization.receipt.reviewReasons.length !== 0 ||
    new TextDecoder().decode(document.sourcePdfBytes.slice(0, 5)) !== '%PDF-' ||
    sha256HexSync(document.sourcePdfBytes) !==
      document.materialization.receipt.sourcePdfSha256 ||
    document.sourceContract.graphArtifact.sha256 !==
      document.materialization.receipt.sourceEvidenceGraphSha256 ||
    document.profiles.length !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length
  ) {
    invalid('INVALID_GROUNDED_MATERIALIZATION_PILOT_DOCUMENT')
  }
  verifyGroundedMaterializationPilotRetainedSource(document.caseId, {
    sha256: document.materialization.receipt.sourcePdfSha256,
    byteLength: document.sourcePdfBytes.byteLength,
    pageCount: document.materialization.document.source.pageCount,
  })
  verifyGroundedCoreMaterializationBinding(document.materialization)
  const mineru = await verifyGroundedMaterializationPilotMineruExecution({
    caseId: document.caseId,
    sourceExecution: document.sourceExecution,
    sourcePdfSha256: document.materialization.receipt.sourcePdfSha256,
    sourceContract: document.sourceContract,
  })
  assertCaseSemantics(document)
  const priorTrace = parseReconstructionAttemptTrace(document.priorTrace)
  const selectedCandidateIdByReference = new Map(
    document.sourceContract.candidateReferences.map((reference) => [
      reference.referenceSha256,
      reference.candidateId,
    ]),
  )
  const expectedDecisions =
    document.materialization.receipt.obligationBindings.map((binding) => ({
      decisionId: binding.obligationId,
      candidateIds: [
        ...new Set(
          binding.candidateReferenceSha256.map((reference) => {
            const candidateId = selectedCandidateIdByReference.get(reference)
            if (!candidateId) invalid('PILOT_LOCAL_CODEX_SELECTION_MISMATCH')
            return candidateId
          }),
        ),
      ].sort(),
    }))
  const candidateIds = [
    ...new Set(expectedDecisions.flatMap(({ candidateIds: ids }) => ids)),
  ]
  const localReceipt = document.localCodexResult.receipt
  const graphReader = readSourceEvidenceGraph(document.sourceContract.graph)
  const selectionByDecision = new Map<string, string>()
  for (const selection of document.localCodexResult.selections) {
    if (
      !('candidateId' in selection) ||
      selectionByDecision.has(selection.decisionId)
    ) {
      invalid('PILOT_LOCAL_CODEX_SELECTION_MISMATCH')
    }
    selectionByDecision.set(selection.decisionId, selection.candidateId)
  }
  const receiptHashes = [
    localReceipt.isolatedSessionSha256,
    localReceipt.requestSha256,
    localReceipt.responseSha256,
    localReceipt.cropEvidenceSha256,
    localReceipt.threadSha256,
    localReceipt.turnSha256,
    ...Object.values(localReceipt.identities),
  ]
  if (
    priorTrace.terminalState !== 'failed' ||
    priorTrace.comparator.status !== 'failed' ||
    localReceipt.status !== 'accepted' ||
    localReceipt.documentIdSha256 !==
      sha256HexSync(document.materialization.receipt.documentId) ||
    localReceipt.attemptIdSha256 !== sha256HexSync(priorTrace.attemptId) ||
    localReceipt.graphSha256 !== document.sourceContract.graph.graphSha256 ||
    localReceipt.candidateSetSha256 !==
      graphReader.candidateSetSha256(candidateIds) ||
    localReceipt.comparisonEvidenceSha256 !== priorTrace.traceSha256 ||
    localReceipt.selectionSetSha256 !==
      hashTraceValue(document.localCodexResult.selections) ||
    localReceipt.counts.decisionCount !== expectedDecisions.length ||
    localReceipt.counts.candidateCount !== candidateIds.length ||
    localReceipt.counts.renderCount !==
      localReceipt.counts.sourceCropCount + localReceipt.counts.epubCropCount ||
    localReceipt.counts.sourceCropCount < 1 ||
    localReceipt.counts.epubCropCount < 1 ||
    localReceipt.usage.totalTokens < 1 ||
    localReceipt.usage.inputTokens < 1 ||
    localReceipt.usage.outputTokens < 1 ||
    localReceipt.usage.durationMs < 1 ||
    receiptHashes.some((value) => !SHA256.test(value)) ||
    document.localCodexResult.selections.length !== expectedDecisions.length ||
    expectedDecisions.some(({ decisionId, candidateIds: allowed }) => {
      const selected = selectionByDecision.get(decisionId)
      return selected === undefined || !allowed.includes(selected)
    })
  ) {
    invalid('PILOT_LOCAL_CODEX_SELECTION_MISMATCH')
  }
  const repairEvidence = document.refinement?.codexRepairEvidence
  const lastRepair = repairEvidence?.at(-1)
  const finalEvaluation = document.refinement?.evaluations.at(-1)
  const traceCodexProvider =
    finalEvaluation?.coordinatorTrace.providerReceipts.find(
      ({ role }) => role === 'owner-local-codex-reconciliation',
    )
  if (
    document.refinement?.receipt.status !== 'publication-ready' ||
    !document.refinement.closedReceipt ||
    !repairEvidence ||
    repairEvidence.length < 1 ||
    !lastRepair ||
    !finalEvaluation ||
    !traceCodexProvider ||
    !traceCodexProvider.server ||
    !traceCodexProvider.model ||
    !traceCodexProvider.prompt ||
    !traceCodexProvider.tool
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_REFINEMENT_MISMATCH')
  }
  if (
    canonicalTraceJson(
      document.refinement.initialEvidence.failedEvaluation.coordinatorTrace,
    ) !== canonicalTraceJson(priorTrace) ||
    canonicalTraceJson(document.refinement.initialEvidence.codexResult) !==
      canonicalTraceJson(document.localCodexResult) ||
    canonicalTraceJson(lastRepair.result) !==
      canonicalTraceJson(finalEvaluation.codexResult) ||
    traceCodexProvider.receiptSha256 !==
      hashTraceValue(finalEvaluation.codexResult.receipt) ||
    finalEvaluation.materialization.receipt.receiptSha256 !==
      document.materialization.receipt.receiptSha256 ||
    canonicalTraceJson(document.refinement.closedReceipt) !==
      canonicalTraceJson(document.outerReceipt) ||
    !verifyGroundedThreeProfileRefinementResult({
      result: document.refinement,
      sourcePdf: finalEvaluation.coordinatorTrace.sourcePdf,
      sourceContract: document.sourceContract,
      codexIdentity: {
        server: traceCodexProvider.server,
        model: traceCodexProvider.model,
        prompt: traceCodexProvider.prompt,
        tool: traceCodexProvider.tool,
      },
    })
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_REFINEMENT_MISMATCH')
  }
  const operationCandidateIds = new Set(
    document.refinement.refinement.privateEvidence.traces
      .slice(1)
      .flatMap((trace) => trace.critiqueRepair?.proposal.operations ?? [])
      .map(({ candidateReferenceSha256 }) => {
        const candidate = document.sourceContract.candidateReferences.find(
          ({ referenceSha256 }) => referenceSha256 === candidateReferenceSha256,
        )
        if (!candidate) invalid('PILOT_LOCAL_CODEX_SELECTION_MISMATCH')
        return candidate.candidateId
      }),
  )
  const selectedRepairCandidateIds = new Set(
    repairEvidence.flatMap(({ result }) =>
      result.selections.flatMap((selection) =>
        'candidateId' in selection ? [selection.candidateId] : [],
      ),
    ),
  )
  if (
    operationCandidateIds.size !== selectedRepairCandidateIds.size ||
    [...operationCandidateIds].some(
      (candidateId) => !selectedRepairCandidateIds.has(candidateId),
    )
  ) {
    invalid('PILOT_LOCAL_CODEX_REPAIR_APPLICATION_MISMATCH')
  }
  const byProfile = new Map(
    document.profiles.map((profile) => [profile.build.profileId, profile]),
  )
  if (
    byProfile.size !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length ||
    CLOSED_RECONSTRUCTION_PROFILE_IDS.some((id) => !byProfile.has(id))
  ) {
    invalid('INCOMPLETE_GROUNDED_MATERIALIZATION_PILOT_PROFILE_SET')
  }
  for (const profileId of CLOSED_RECONSTRUCTION_PROFILE_IDS) {
    const profile = byProfile.get(profileId)!
    verifyActualProfiledEpubRender(profile.render)
    verifyGroundedMaterializationPilotEpubCheckAuthority(profile.epubCheck)
    const replayed = compareGroundedProfiledEpub({
      materialization: document.materialization,
      sourceContract: document.sourceContract,
      build: profile.build,
      render: profile.render,
      epubCheck: profile.epubCheck,
    })
    const trace = parseReconstructionAttemptTrace(profile.trace)
    if (
      replayed.receiptSha256 !== profile.comparison.receiptSha256 ||
      trace.comparator.status !== 'publication-ready' ||
      trace.comparator.failed !== 0 ||
      trace.epub.bytes.sha256 !== profile.build.epub.sha256 ||
      hashTraceValue(trace.comparator) !==
        hashTraceValue(profile.comparison.comparator)
    ) {
      invalid('GROUNDED_MATERIALIZATION_PILOT_REPLAY_MISMATCH')
    }
  }
  const traces = Object.fromEntries(
    CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) => [
      profileId,
      byProfile.get(profileId)!.trace,
    ]),
  ) as Record<
    ProfiledStructEpubArtifact['profileId'],
    ReconstructionAttemptTrace
  >
  const builds = CLOSED_RECONSTRUCTION_PROFILE_IDS.map(
    (profileId) => byProfile.get(profileId)!.build,
  )
  const reopenedOuter = createClosedThreeProfileReconstructionReceipt({
    attempts: [
      {
        coordinatorProfileId: 'mobile',
        canonicalStructSha256:
          document.materialization.receipt.repairCore.sha256,
        materializationReceipt: document.materialization.receipt,
        traces,
        builds,
      },
    ],
  })
  if (
    canonicalTraceJson(reopenedOuter) !==
    canonicalTraceJson(document.outerReceipt)
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_OUTER_RECEIPT_MISMATCH')
  }
  return { byProfile, builds, mineru }
}

export async function verifyGroundedMaterializationPilotPacket(
  packet: GroundedMaterializationPilotPacket,
): Promise<GroundedMaterializationPilotReceipt> {
  if (
    packet.schemaVersion !== GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION ||
    packet.documents.length !== GROUNDED_MATERIALIZATION_PILOT_CASES.length ||
    packet.negativeControls.length !== 1 ||
    packet.negativeControls[0]?.id !== 'malformed-source-evidence' ||
    packet.negativeControls[0].status !== 'rejected' ||
    packet.negativeControls[0].reason.trim().length === 0
  ) {
    invalid('INVALID_GROUNDED_MATERIALIZATION_PILOT_PACKET')
  }
  const byCase = new Map(
    packet.documents.map((document) => [document.caseId, document]),
  )
  if (
    byCase.size !== GROUNDED_MATERIALIZATION_PILOT_CASES.length ||
    GROUNDED_MATERIALIZATION_PILOT_CASES.some((id) => !byCase.has(id)) ||
    new Set(
      packet.documents.map(
        ({ materialization }) => materialization.receipt.sourcePdfSha256,
      ),
    ).size !== GROUNDED_MATERIALIZATION_PILOT_CASES.length
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_REQUIRES_FIVE_UNIQUE_SUCCESSES')
  }
  const documents = [] as GroundedMaterializationPilotReceipt['documents']
  for (const caseId of GROUNDED_MATERIALIZATION_PILOT_CASES) {
    const document = byCase.get(caseId)!
    const { byProfile, mineru } = await verifyDocument(document)
    documents.push({
      caseId,
      sourcePdfSha256: document.materialization.receipt.sourcePdfSha256,
      mineruManifestSha256: mineru.manifestSha256,
      mineruProducerReceiptSha256: mineru.producerReceiptSha256,
      mineruArtifactSetSha256: mineru.artifactSetSha256,
      retainedSourceGraphSha256: mineru.sourceGraphSha256,
      retainedContractSha256: mineru.contractSha256,
      retainedObservationSetSha256: mineru.observationSetSha256,
      materializationReceiptSha256:
        document.materialization.receipt.receiptSha256,
      outerReceiptSha256: document.outerReceipt.receiptSha256,
      localCodexReceiptSha256: hashTraceValue(
        document.localCodexResult.receipt,
      ),
      refinementReceiptSha256: document.refinement.receipt.receiptSha256,
      codexRepairEvidenceSha256s: document.refinement.codexRepairEvidence.map(
        ({ evidenceSha256 }) => evidenceSha256,
      ),
      profiles: CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) => {
        const profile = byProfile.get(profileId)!
        return {
          profileId,
          epubSha256: profile.build.epub.sha256,
          renderReceiptSha256: profile.render.receiptSha256,
          epubCheckReceiptSha256: profile.epubCheck.receiptSha256,
          comparisonReceiptSha256: profile.comparison.receiptSha256,
          traceSha256: profile.trace.traceSha256,
        }
      }),
    })
  }
  const projection = {
    schemaVersion: GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION,
    caseIds: GROUNDED_MATERIALIZATION_PILOT_CASES,
    documentCount: 5 as const,
    profileCount: 15 as const,
    documents,
    negativeControlReceiptSha256: hashTraceValue(packet.negativeControls[0]),
    status: 'passed' as const,
  }
  return { ...projection, receiptSha256: hashTraceValue(projection) }
}
