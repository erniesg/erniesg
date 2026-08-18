import {
  hashTraceValue,
  parseCanonicalObservationPayloadBytes,
  parseReconstructionAttemptTrace,
  SOURCE_EPUB_OBSERVATION_CHECK_IDS,
  type ReconstructionAttemptTrace,
} from './reconstruction-attempt-trace'
import { compareSourceToRenderedEpub } from './source-epub-comparator'
import { sha256HexSync } from './sha256-sync'
import {
  buildSourceEvidenceGraph,
  readSourceEvidenceGraph,
  type SourceEvidenceGraph,
  type SourceEvidenceGraphInput,
} from './source-evidence-graph'

export const RECONSTRUCTION_DEVELOPMENT_EVALUATION_SCHEMA_VERSION =
  '2.0.0' as const

const SHA256 = /^[a-f0-9]{64}$/u
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
const MAX_PACKET_BYTES = 512 * 1024 * 1024

export type OwnerLocalEvaluationArtifact = {
  sha256: string
  byteLength: number
  resolverId: string
  opaqueId: string
}

export type ReconstructionDevelopmentEvaluationDocument = {
  idSha256: string
  status: 'passed' | 'failed'
  sourcePdfSha256: string
  graphSha256: string
  candidateSetSha256: string
  sourcePdf: OwnerLocalEvaluationArtifact
  sourceEvidenceGraph: OwnerLocalEvaluationArtifact
  expectedObservationPayloads: Array<{
    check: (typeof SOURCE_EPUB_OBSERVATION_CHECK_IDS)[number]
    artifact: OwnerLocalEvaluationArtifact
  }>
  localCodexPriorTrace: OwnerLocalEvaluationArtifact
  localCodexReceipt: OwnerLocalEvaluationArtifact
  materializationReceipt: OwnerLocalEvaluationArtifact
  epub: OwnerLocalEvaluationArtifact
  epubCheckReport: OwnerLocalEvaluationArtifact
  finalAttemptTrace: OwnerLocalEvaluationArtifact
}

export type ReconstructionDevelopmentEvaluationPacket = {
  schemaVersion: typeof RECONSTRUCTION_DEVELOPMENT_EVALUATION_SCHEMA_VERSION
  policy: ReconstructionDevelopmentEvaluationPolicy
  documents: ReconstructionDevelopmentEvaluationDocument[]
}

export type OwnerLocalEvaluationArtifactResolver = (
  artifact: OwnerLocalEvaluationArtifact,
) => Promise<Uint8Array>

export type ReconstructionDevelopmentVerificationContext = Readonly<{
  document: ReconstructionDevelopmentEvaluationDocument
  sourcePdfBytes: Uint8Array
  graph: SourceEvidenceGraph
  expectedObservationPayloadBytes: ReadonlyMap<string, Uint8Array>
  priorTrace: ReconstructionAttemptTrace
  localCodexReceiptBytes: Uint8Array
  materializationReceiptBytes: Uint8Array
  epubBytes: Uint8Array
  epubCheckReportBytes: Uint8Array
  finalTrace: ReconstructionAttemptTrace
}>

export const RECONSTRUCTION_DEVELOPMENT_VERIFICATION_STAGES = [
  'owner-local-codex',
  'grounded-materialization',
  'rendered-epub',
  'epubcheck',
] as const

export type ReconstructionDevelopmentVerificationStage =
  (typeof RECONSTRUCTION_DEVELOPMENT_VERIFICATION_STAGES)[number]

export type ReconstructionDevelopmentVerifierIdentity = Readonly<{
  id: string
  version: string
  configurationSha256: string
  executableSha256: string
}>

export type ReconstructionDevelopmentStageVerificationReceipt = Readonly<{
  schemaVersion: '1.0.0'
  stage: ReconstructionDevelopmentVerificationStage
  verifierIdentity: ReconstructionDevelopmentVerifierIdentity
  verifierIdentitySha256: string
  requestSha256: string
  status: 'succeeded'
  receiptSha256: string
}>

export type ReconstructionDevelopmentVerifierAuthority = Readonly<{
  identity: ReconstructionDevelopmentVerifierIdentity
  verify: (
    context: ReconstructionDevelopmentVerificationContext,
  ) => Promise<unknown>
}>

/** Frozen production trust boundaries; none accepts a self-attested receipt. */
export type ReconstructionDevelopmentVerifierAuthorities = Readonly<{
  localCodex: ReconstructionDevelopmentVerifierAuthority
  groundedMaterialization: ReconstructionDevelopmentVerifierAuthority
  renderedEpub: ReconstructionDevelopmentVerifierAuthority
  epubCheck: ReconstructionDevelopmentVerifierAuthority
}>

export type ReconstructionDevelopmentEvaluationPolicy = Readonly<{
  schemaVersion: '1.0.0'
  verifierIdentities: Readonly<{
    localCodex: ReconstructionDevelopmentVerifierIdentity
    groundedMaterialization: ReconstructionDevelopmentVerifierIdentity
    renderedEpub: ReconstructionDevelopmentVerifierIdentity
    epubCheck: ReconstructionDevelopmentVerifierIdentity
  }>
  policySha256: string
}>

function invalid(code: string): never {
  throw new Error(code)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

function artifact(value: unknown): OwnerLocalEvaluationArtifact {
  if (
    !record(value) ||
    !exactKeys(value, ['sha256', 'byteLength', 'resolverId', 'opaqueId']) ||
    !SHA256.test(String(value.sha256)) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0 ||
    (value.byteLength as number) > MAX_ARTIFACT_BYTES ||
    !OPAQUE_ID.test(String(value.resolverId)) ||
    !OPAQUE_ID.test(String(value.opaqueId))
  ) {
    invalid('INVALID_DEVELOPMENT_EVALUATION_ARTIFACT')
  }
  return {
    sha256: value.sha256 as string,
    byteLength: value.byteLength as number,
    resolverId: value.resolverId as string,
    opaqueId: value.opaqueId as string,
  }
}

function parseJson(bytes: Uint8Array, code: string) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    invalid(code)
  }
}

async function reopen(
  reference: OwnerLocalEvaluationArtifact,
  resolver: OwnerLocalEvaluationArtifactResolver,
) {
  const bytes = await resolver(reference)
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== reference.byteLength ||
    sha256HexSync(bytes) !== reference.sha256
  ) {
    invalid('DEVELOPMENT_EVALUATION_ARTIFACT_IDENTITY_MISMATCH')
  }
  return bytes
}

function parseCodexReceipt(
  value: unknown,
  context: {
    graphSha256: string
    candidateSetSha256: string
    priorTraceSha256: string
  },
) {
  if (
    !record(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'status',
      'documentIdSha256',
      'attemptIdSha256',
      'isolatedSessionSha256',
      'graphSha256',
      'candidateSetSha256',
      'requestSha256',
      'responseSha256',
      'selectionSetSha256',
      'comparisonEvidenceSha256',
      'cropEvidenceSha256',
      'threadSha256',
      'turnSha256',
      'identities',
      'counts',
    ]) ||
    value.schemaVersion !== '1.0.0' ||
    value.status !== 'accepted' ||
    value.graphSha256 !== context.graphSha256 ||
    value.candidateSetSha256 !== context.candidateSetSha256 ||
    value.comparisonEvidenceSha256 !== context.priorTraceSha256 ||
    [
      value.documentIdSha256,
      value.attemptIdSha256,
      value.isolatedSessionSha256,
      value.requestSha256,
      value.responseSha256,
      value.selectionSetSha256,
      value.cropEvidenceSha256,
      value.threadSha256,
      value.turnSha256,
    ].some((digest) => !SHA256.test(String(digest))) ||
    !record(value.identities) ||
    !exactKeys(value.identities, [
      'endpointSha256',
      'serverSha256',
      'toolSha256',
      'modelSha256',
      'promptSha256',
      'renderArtifactResolverSha256',
      'observedModelSha256',
    ]) ||
    Object.values(value.identities).some(
      (digest) => !SHA256.test(String(digest)),
    ) ||
    !record(value.counts) ||
    !exactKeys(value.counts, [
      'decisionCount',
      'candidateCount',
      'renderCount',
      'sourceCropCount',
      'epubCropCount',
    ]) ||
    Object.values(value.counts).some(
      (count) => !Number.isSafeInteger(count) || Number(count) < 1,
    )
  ) {
    invalid('DEVELOPMENT_EVALUATION_CODEX_BINDING_MISMATCH')
  }
}

function recompare(trace: ReconstructionAttemptTrace) {
  return compareSourceToRenderedEpub({
    sourcePdfSha256: trace.sourcePdf.artifact.sha256,
    sourceEvidence: trace.sourceEvidence,
    structure: trace.structure,
    epub: trace.epub,
    renderedEpub: trace.renderedEpub,
    sourceRegions: trace.comparisonEvidence.sourceRegions,
    mappings: trace.mappings,
    observations: trace.comparisonEvidence.observations,
  })
}

function verifierRequestSha256(
  stage: ReconstructionDevelopmentVerificationStage,
  context: ReconstructionDevelopmentVerificationContext,
) {
  return hashTraceValue({
    stage,
    documentIdSha256: context.document.idSha256,
    sourcePdfSha256: context.document.sourcePdfSha256,
    graphSha256: context.document.graphSha256,
    candidateSetSha256: context.document.candidateSetSha256,
    priorTraceSha256: context.priorTrace.traceSha256,
    localCodexReceiptSha256: context.document.localCodexReceipt.sha256,
    materializationReceiptSha256:
      context.document.materializationReceipt.sha256,
    epubSha256: context.document.epub.sha256,
    epubCheckReportSha256: context.document.epubCheckReport.sha256,
    finalTraceSha256: context.finalTrace.traceSha256,
  })
}

export function createReconstructionDevelopmentStageVerificationReceipt(
  stage: ReconstructionDevelopmentVerificationStage,
  identity: ReconstructionDevelopmentVerifierIdentity,
  context: ReconstructionDevelopmentVerificationContext,
): ReconstructionDevelopmentStageVerificationReceipt {
  const base = {
    schemaVersion: '1.0.0' as const,
    stage,
    verifierIdentity: structuredClone(identity),
    verifierIdentitySha256: hashTraceValue(identity),
    requestSha256: verifierRequestSha256(stage, context),
    status: 'succeeded' as const,
  }
  return Object.freeze({ ...base, receiptSha256: hashTraceValue(base) })
}

export function createReconstructionDevelopmentEvaluationPolicy(
  authorities: ReconstructionDevelopmentVerifierAuthorities,
): ReconstructionDevelopmentEvaluationPolicy {
  const base = {
    schemaVersion: '1.0.0' as const,
    verifierIdentities: {
      localCodex: structuredClone(authorities.localCodex.identity),
      groundedMaterialization: structuredClone(
        authorities.groundedMaterialization.identity,
      ),
      renderedEpub: structuredClone(authorities.renderedEpub.identity),
      epubCheck: structuredClone(authorities.epubCheck.identity),
    },
  }
  return Object.freeze({ ...base, policySha256: hashTraceValue(base) })
}

function parseEvaluationPolicy(
  value: unknown,
): ReconstructionDevelopmentEvaluationPolicy {
  if (
    !record(value) ||
    !exactKeys(value, ['schemaVersion', 'verifierIdentities', 'policySha256']) ||
    value.schemaVersion !== '1.0.0' ||
    !record(value.verifierIdentities) ||
    !exactKeys(value.verifierIdentities, [
      'localCodex',
      'groundedMaterialization',
      'renderedEpub',
      'epubCheck',
    ]) ||
    !SHA256.test(String(value.policySha256))
  ) {
    invalid('INVALID_DEVELOPMENT_EVALUATION_POLICY')
  }
  for (const identity of Object.values(value.verifierIdentities)) {
    if (
      !record(identity) ||
      !exactKeys(identity, [
        'id',
        'version',
        'configurationSha256',
        'executableSha256',
      ]) ||
      !OPAQUE_ID.test(String(identity.id)) ||
      !OPAQUE_ID.test(String(identity.version)) ||
      !SHA256.test(String(identity.configurationSha256)) ||
      !SHA256.test(String(identity.executableSha256))
    ) {
      invalid('INVALID_DEVELOPMENT_EVALUATION_POLICY')
    }
  }
  const { policySha256, ...base } = value
  if (policySha256 !== hashTraceValue(base)) {
    invalid('INVALID_DEVELOPMENT_EVALUATION_POLICY')
  }
  return structuredClone(value) as ReconstructionDevelopmentEvaluationPolicy
}

async function invokeAuthority(
  stage: ReconstructionDevelopmentVerificationStage,
  authority: ReconstructionDevelopmentVerifierAuthority,
  pinnedIdentity: ReconstructionDevelopmentVerifierIdentity,
  context: ReconstructionDevelopmentVerificationContext,
) {
  if (
    !record(authority) ||
    !exactKeys(authority, ['identity', 'verify']) ||
    !record(authority.identity) ||
    !exactKeys(authority.identity, [
      'id',
      'version',
      'configurationSha256',
      'executableSha256',
    ]) ||
    !OPAQUE_ID.test(String(authority.identity.id)) ||
    !OPAQUE_ID.test(String(authority.identity.version)) ||
    !SHA256.test(String(authority.identity.configurationSha256)) ||
    !SHA256.test(String(authority.identity.executableSha256)) ||
    typeof authority.verify !== 'function' ||
    hashTraceValue(authority.identity) !== hashTraceValue(pinnedIdentity)
  ) {
    invalid('INVALID_DEVELOPMENT_EVALUATION_VERIFIER_AUTHORITY')
  }
  const receipt = await authority.verify(context)
  if (
    !record(receipt) ||
    !exactKeys(receipt, [
      'schemaVersion',
      'stage',
      'verifierIdentity',
      'verifierIdentitySha256',
      'requestSha256',
      'status',
      'receiptSha256',
    ]) ||
    receipt.schemaVersion !== '1.0.0' ||
    receipt.stage !== stage ||
    receipt.status !== 'succeeded' ||
    hashTraceValue(receipt.verifierIdentity) !==
      hashTraceValue(authority.identity) ||
    receipt.verifierIdentitySha256 !== hashTraceValue(authority.identity) ||
    receipt.requestSha256 !== verifierRequestSha256(stage, context)
  ) {
    invalid('DEVELOPMENT_EVALUATION_EXTERNAL_VERIFICATION_FAILED')
  }
  const { receiptSha256, ...base } = receipt
  if (
    !SHA256.test(String(receiptSha256)) ||
    receiptSha256 !== hashTraceValue(base)
  ) {
    invalid('DEVELOPMENT_EVALUATION_EXTERNAL_VERIFICATION_FAILED')
  }
}

export async function verifyReconstructionDevelopmentEvaluationPacket(
  input: unknown,
  resolver: OwnerLocalEvaluationArtifactResolver,
  authorities: ReconstructionDevelopmentVerifierAuthorities,
) {
  if (
    !record(input) ||
    !exactKeys(input, ['schemaVersion', 'policy', 'documents']) ||
    input.schemaVersion !==
      RECONSTRUCTION_DEVELOPMENT_EVALUATION_SCHEMA_VERSION ||
    !Array.isArray(input.documents) ||
    input.documents.length !== 4 ||
    typeof resolver !== 'function' ||
    !record(authorities) ||
    !exactKeys(authorities, [
      'localCodex',
      'groundedMaterialization',
      'renderedEpub',
      'epubCheck',
    ])
  ) {
    invalid('INVALID_DEVELOPMENT_EVALUATION_PACKET')
  }
  const policy = parseEvaluationPolicy(input.policy)
  const parsed: ReconstructionDevelopmentEvaluationDocument[] =
    input.documents.map((value) => {
      if (
        !record(value) ||
        !exactKeys(value, [
          'idSha256',
          'status',
          'sourcePdfSha256',
          'graphSha256',
          'candidateSetSha256',
          'sourcePdf',
          'sourceEvidenceGraph',
          'expectedObservationPayloads',
          'localCodexPriorTrace',
          'localCodexReceipt',
          'materializationReceipt',
          'epub',
          'epubCheckReport',
          'finalAttemptTrace',
        ]) ||
        !SHA256.test(String(value.idSha256)) ||
        !['passed', 'failed'].includes(String(value.status)) ||
        !SHA256.test(String(value.sourcePdfSha256)) ||
        !SHA256.test(String(value.graphSha256)) ||
        !SHA256.test(String(value.candidateSetSha256)) ||
        !Array.isArray(value.expectedObservationPayloads) ||
        value.expectedObservationPayloads.length !==
          SOURCE_EPUB_OBSERVATION_CHECK_IDS.length
      ) {
        invalid('INVALID_DEVELOPMENT_EVALUATION_DOCUMENT')
      }
      const expectedObservationPayloads =
        value.expectedObservationPayloads.map((entry) => {
          if (
            !record(entry) ||
            !exactKeys(entry, ['check', 'artifact']) ||
            !SOURCE_EPUB_OBSERVATION_CHECK_IDS.includes(
              entry.check as (typeof SOURCE_EPUB_OBSERVATION_CHECK_IDS)[number],
            )
          ) {
            invalid('INVALID_DEVELOPMENT_EVALUATION_EXPECTED_SET')
          }
          return {
            check:
              entry.check as (typeof SOURCE_EPUB_OBSERVATION_CHECK_IDS)[number],
            artifact: artifact(entry.artifact),
          }
        })
      if (
        new Set(expectedObservationPayloads.map(({ check }) => check)).size !==
        SOURCE_EPUB_OBSERVATION_CHECK_IDS.length
      ) {
        invalid('INVALID_DEVELOPMENT_EVALUATION_EXPECTED_SET')
      }
      return {
        idSha256: value.idSha256 as string,
        status: value.status as 'passed' | 'failed',
        sourcePdfSha256: value.sourcePdfSha256 as string,
        graphSha256: value.graphSha256 as string,
        candidateSetSha256: value.candidateSetSha256 as string,
        sourcePdf: artifact(value.sourcePdf),
        sourceEvidenceGraph: artifact(value.sourceEvidenceGraph),
        expectedObservationPayloads,
        localCodexPriorTrace: artifact(value.localCodexPriorTrace),
        localCodexReceipt: artifact(value.localCodexReceipt),
        materializationReceipt: artifact(value.materializationReceipt),
        epub: artifact(value.epub),
        epubCheckReport: artifact(value.epubCheckReport),
        finalAttemptTrace: artifact(value.finalAttemptTrace),
      }
    })
  if (
    new Set(parsed.map(({ idSha256 }) => idSha256)).size !== 4 ||
    new Set(parsed.map(({ sourcePdfSha256 }) => sourcePdfSha256)).size !== 4
  ) {
    invalid('DEVELOPMENT_EVALUATION_REQUIRES_FOUR_UNIQUE_DOCUMENTS')
  }
  const totalBytes = parsed
    .flatMap((document) => [
      document.sourcePdf,
      document.sourceEvidenceGraph,
      ...document.expectedObservationPayloads.map(({ artifact }) => artifact),
      document.localCodexPriorTrace,
      document.localCodexReceipt,
      document.materializationReceipt,
      document.epub,
      document.epubCheckReport,
      document.finalAttemptTrace,
    ])
    .reduce((total, value) => total + value.byteLength, 0)
  if (totalBytes > MAX_PACKET_BYTES) {
    invalid('DEVELOPMENT_EVALUATION_PACKET_TOO_LARGE')
  }

  for (const document of parsed) {
    const sourcePdfBytes = await reopen(document.sourcePdf, resolver)
    if (
      sha256HexSync(sourcePdfBytes) !== document.sourcePdfSha256 ||
      new TextDecoder().decode(sourcePdfBytes.slice(0, 5)) !== '%PDF-'
    ) {
      invalid('DEVELOPMENT_EVALUATION_SOURCE_PDF_MISMATCH')
    }
    const graphBytes = await reopen(document.sourceEvidenceGraph, resolver)
    const graph = buildSourceEvidenceGraph(
      parseJson(graphBytes, 'INVALID_DEVELOPMENT_EVALUATION_GRAPH') as
        SourceEvidenceGraphInput,
    )
    const reader = readSourceEvidenceGraph(graph)
    if (
      reader.graphSha256 !== document.graphSha256 ||
      reader.source.sha256 !== document.sourcePdfSha256
    ) {
      invalid('DEVELOPMENT_EVALUATION_GRAPH_BINDING_MISMATCH')
    }
    const expectedObservationPayloadBytes = new Map<string, Uint8Array>()
    for (const expected of document.expectedObservationPayloads) {
      const bytes = await reopen(expected.artifact, resolver)
      const payload = parseCanonicalObservationPayloadBytes(bytes)
      if (payload.check !== expected.check) {
        invalid('DEVELOPMENT_EVALUATION_EXPECTED_SET_MISMATCH')
      }
      expectedObservationPayloadBytes.set(expected.check, bytes)
    }
    const priorTrace = parseReconstructionAttemptTrace(
      parseJson(
        await reopen(document.localCodexPriorTrace, resolver),
        'INVALID_DEVELOPMENT_EVALUATION_PRIOR_TRACE',
      ),
    )
    const finalTrace = parseReconstructionAttemptTrace(
      parseJson(
        await reopen(document.finalAttemptTrace, resolver),
        'INVALID_DEVELOPMENT_EVALUATION_FINAL_TRACE',
      ),
    )
    for (const trace of [priorTrace, finalTrace]) {
      if (trace.sourcePdf.artifact.sha256 !== document.sourcePdfSha256)
        invalid('DEVELOPMENT_EVALUATION_TRACE_SOURCE_MISMATCH')
      if (trace.evidenceGraph.sourcePdfSha256 !== document.sourcePdfSha256)
        invalid('DEVELOPMENT_EVALUATION_TRACE_GRAPH_SOURCE_MISMATCH')
      if (trace.sourceEvidence.evidenceGraphSha256 !== document.graphSha256)
        invalid('DEVELOPMENT_EVALUATION_TRACE_GRAPH_MISMATCH')
      if (
        trace.sourceEvidence.candidateSetSha256 !== document.candidateSetSha256
      )
        invalid('DEVELOPMENT_EVALUATION_TRACE_CANDIDATE_SET_MISMATCH')
      if (
        trace.evidenceGraph.artifact.sha256 !==
          document.graphSha256 ||
        trace.evidenceGraph.artifact.byteLength !== graphBytes.byteLength
      ) {
        invalid('DEVELOPMENT_EVALUATION_GRAPH_ARTIFACT_MISMATCH')
      }
      if (
        hashTraceValue(recompare(trace)) !== hashTraceValue(trace.comparator)
      ) {
        invalid('DEVELOPMENT_EVALUATION_COMPARATOR_REPLAY_MISMATCH')
      }
      for (const expected of trace.sourceEvidence.expectedObservationSets) {
        const payloadBytes = expectedObservationPayloadBytes.get(expected.check)
        if (
          !payloadBytes ||
          expected.payload.sha256 !== sha256HexSync(payloadBytes) ||
          expected.payload.byteLength !== payloadBytes.byteLength
        ) {
          invalid('DEVELOPMENT_EVALUATION_EXPECTED_SET_MISMATCH')
        }
      }
    }
    if (
      priorTrace.terminalState !== 'failed' ||
      priorTrace.comparator.status !== 'failed' ||
      finalTrace.epub.bytes.sha256 !== document.epub.sha256 ||
      finalTrace.epub.bytes.byteLength !== document.epub.byteLength ||
      finalTrace.epub.epubCheck.reportSha256 !==
        document.epubCheckReport.sha256 ||
      finalTrace.epub.epubCheck.status !== 'passed' ||
      (document.status === 'passed') !==
        (finalTrace.terminalState === 'publication-ready' &&
          finalTrace.comparator.status === 'publication-ready')
    ) {
      invalid('DEVELOPMENT_EVALUATION_FINAL_BINDING_MISMATCH')
    }
    const localCodexReceiptBytes = await reopen(
      document.localCodexReceipt,
      resolver,
    )
    parseCodexReceipt(
      parseJson(
        localCodexReceiptBytes,
        'INVALID_DEVELOPMENT_EVALUATION_CODEX_RECEIPT',
      ),
      {
        graphSha256: document.graphSha256,
        candidateSetSha256: document.candidateSetSha256,
        priorTraceSha256: priorTrace.traceSha256,
      },
    )
    const context: ReconstructionDevelopmentVerificationContext =
      Object.freeze({
        document,
        sourcePdfBytes,
        graph,
        expectedObservationPayloadBytes,
        priorTrace,
        localCodexReceiptBytes,
        materializationReceiptBytes: await reopen(
          document.materializationReceipt,
          resolver,
        ),
        epubBytes: await reopen(document.epub, resolver),
        epubCheckReportBytes: await reopen(document.epubCheckReport, resolver),
        finalTrace,
      })
    await invokeAuthority(
      'owner-local-codex',
      authorities.localCodex,
      policy.verifierIdentities.localCodex,
      context,
    )
    await invokeAuthority(
      'grounded-materialization',
      authorities.groundedMaterialization,
      policy.verifierIdentities.groundedMaterialization,
      context,
    )
    await invokeAuthority(
      'rendered-epub',
      authorities.renderedEpub,
      policy.verifierIdentities.renderedEpub,
      context,
    )
    await invokeAuthority(
      'epubcheck',
      authorities.epubCheck,
      policy.verifierIdentities.epubCheck,
      context,
    )
  }
  return Object.freeze({
    schemaVersion: RECONSTRUCTION_DEVELOPMENT_EVALUATION_SCHEMA_VERSION,
    status: parsed.every(({ status }) => status === 'passed')
      ? ('passed' as const)
      : ('failed' as const),
    documentCount: 4,
    policySha256: policy.policySha256,
    sourcePdfSha256s: Object.freeze(
      parsed.map(({ sourcePdfSha256 }) => sourcePdfSha256),
    ),
  })
}
