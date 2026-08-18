import { describe, expect, it, vi } from 'vitest'
import {
  createReconstructionAttemptTrace,
  hashEpubBytes,
  hashRenderedActualObservationSet,
  hashRenderedEpubEvidence,
  hashTraceValue,
  SOURCE_EPUB_OBSERVATION_CHECK_IDS,
} from './reconstruction-attempt-trace'
import {
  compareSourceToRenderedEpub,
  createDeterministicObservationReceipt,
} from './source-epub-comparator'
import { sha256HexSync } from './sha256-sync'
import {
  PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
  buildSourceEvidenceGraph,
  deterministicContextReceiptForBundle,
  serializeSourceEvidenceGraph,
  type SourceEvidenceGraph,
  type SourceEvidenceGraphInput,
} from './source-evidence-graph'
import { createSourceEvidenceContract } from './source-evidence-contract'
import {
  RECONSTRUCTION_DEVELOPMENT_EVALUATION_SCHEMA_VERSION,
  createReconstructionDevelopmentEvaluationPolicy,
  createReconstructionDevelopmentStageVerificationReceipt,
  verifyReconstructionDevelopmentEvaluationPacket,
  type OwnerLocalEvaluationArtifact,
  type ReconstructionDevelopmentEvaluationDocument,
  type ReconstructionDevelopmentVerificationContext,
  type ReconstructionDevelopmentVerifierAuthorities,
} from './reconstruction-development-evaluation'

const encoder = new TextEncoder()
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value))

function graphFor(sourceBytes: Uint8Array, index: number) {
  const source = {
    documentId: `development-document-${index}`,
    sha256: sha256HexSync(sourceBytes),
    byteLength: sourceBytes.byteLength,
    pageCount: 1,
  }
  const box = {
    page: 1,
    x: 0.1,
    y: 0.1,
    width: 0.5,
    height: 0.05,
    rotation: 0,
    method: 'pdf-text' as const,
  }
  const providers = [
    {
      armId: 'deterministic',
      id: `pdfjs-provider-${index}`,
      kind: 'pdfjs' as const,
      artifactSha256: 'a'.repeat(64),
    },
    {
      armId: 'mineru',
      id: `mineru-provider-${index}`,
      kind: 'mineru' as const,
      artifactSha256: 'b'.repeat(64),
    },
  ]
  const graphInput: Omit<
    SourceEvidenceGraphInput,
    'deterministicContext'
  > = {
    schemaVersion: SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
    source,
    arms: providers.map((provider) => ({
      id: provider.armId,
      requirement: 'required' as const,
      status: 'enabled' as const,
      frozen: true as const,
      providerId: provider.id,
    })),
    bundles: providers.map((provider) => ({
      schemaVersion: PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
      id: `${provider.armId}-bundle-${index}`,
      armId: provider.armId,
      source,
      provider: {
        id: provider.id,
        kind: provider.kind,
        name: provider.kind === 'mineru' ? 'MinerU' : 'pdfjs-dist',
        version: provider.kind === 'mineru' ? '3.4.4' : '5.4.624',
      },
      pages: [{ page: 1, width: 612, height: 792, rotation: 0 }],
      artifacts: [
        {
          id: `${provider.armId}-artifact-${index}`,
          providerId: provider.id,
          kind: 'source-evidence',
          mediaType: 'application/json',
          sha256: provider.artifactSha256,
          byteLength: 32,
          page: 1,
          box,
          sourceIds: [`${provider.armId}-source-${index}`],
        },
      ],
      sources: [
        {
          id: `${provider.armId}-source-${index}`,
          providerId: provider.id,
          kind: 'text',
          page: 1,
          box,
          artifactIds: [`${provider.armId}-artifact-${index}`],
          payload: { text: `development source ${index}` },
        },
      ],
      candidates: [
        {
          id: `${provider.armId}-candidate-${index}`,
          providerId: provider.id,
          kind: 'text',
          page: 1,
          boxes: [box],
          sourceIds: [`${provider.armId}-source-${index}`],
          artifactIds: [`${provider.armId}-artifact-${index}`],
          payload: { text: `development source ${index}`, grounded: true },
        },
      ],
    })),
    obligations: [
      {
        id: `source-obligation-${index}`,
        kind: 'source-text',
        page: 1,
        sourceIds: providers.map(
          ({ armId }) => `${armId}-source-${index}`,
        ),
        artifactIds: providers.map(
          ({ armId }) => `${armId}-artifact-${index}`,
        ),
        candidateIds: providers.map(
          ({ armId }) => `${armId}-candidate-${index}`,
        ),
        observationCategories: ['text-exactness'],
        required: true,
        semantic: true,
      },
    ],
    disagreements: [],
  }
  return buildSourceEvidenceGraph({
    ...graphInput,
    deterministicContext: deterministicContextReceiptForBundle(
      graphInput.bundles[0]!,
    ),
  })
}

function traceFor(input: {
  graph: SourceEvidenceGraph
  index: number
  epubBytes: Uint8Array
  epubCheckReportBytes: Uint8Array
  mismatch: boolean
}) {
  const { graph, index, epubBytes, epubCheckReportBytes, mismatch } = input
  const contract = createSourceEvidenceContract(graph, {
    id: 'source-evidence-verifier',
    version: '1.0.0',
    configurationSha256: 'c'.repeat(64),
    executableSha256: 'd'.repeat(64),
  })
  const actualObservationSets = contract.expectedObservationSets.map(
    ({ check, setSha256, itemCount, payload }) => {
      const changed = mismatch && check === 'reading-order'
      const changedPayload = {
        sha256: sha256HexSync('wrong-reading-order'),
        byteLength: 1,
      }
      const projection = {
        check,
        setSha256: changed ? changedPayload.sha256 : setSha256,
        itemCount,
        payload: changed ? changedPayload : payload,
      }
      return {
        ...projection,
        receiptSha256: hashRenderedActualObservationSet({
          ...projection,
          receiptSha256: '0'.repeat(64),
        }),
      }
    },
  )
  const epubSha256 = hashEpubBytes(epubBytes)
  const structSha256 = sha256HexSync(`struct-${index}`)
  const screenshotSha256 = sha256HexSync(`screenshot-${index}`)
  const domSha256 = sha256HexSync(`dom-${index}`)
  const viewport = { width: 100, height: 100, deviceScaleFactor: 1 }
  const renderedEpub = {
    epubSha256,
    download: {
      artifact: { sha256: epubSha256, byteLength: epubBytes.byteLength },
      verificationReceiptSha256: sha256HexSync(`download-${index}`),
    },
    sourceObligations: {
      sourcePdfSha256: graph.source.sha256,
      ...contract.sourceEvidenceReceipt.sourceObligations,
    },
    actualObservationSets,
    renderer: {
      id: 'owner-local-renderer',
      version: '1.0.0',
      executableSha256: sha256HexSync('renderer-executable'),
      configurationSha256: sha256HexSync('renderer-configuration'),
    },
    domSnapshots: [
      {
        spineHref: 'EPUB/content.xhtml',
        dom: { sha256: domSha256, byteLength: 10 },
        anchors: [`output-${index}`],
      },
    ],
    screenshots: [
      {
        id: `screenshot-${index}`,
        spineHref: 'EPUB/content.xhtml',
        domSha256,
        image: { sha256: screenshotSha256, byteLength: 20 },
        mediaType: 'image/png' as const,
        width: 100,
        height: 100,
        viewport,
        fullPage: true,
      },
    ],
    receiptSha256: '0'.repeat(64),
  }
  renderedEpub.receiptSha256 = hashRenderedEpubEvidence(renderedEpub)
  const mappings = contract.sourceRegions.map((region, mappingIndex) => ({
    id: `mapping-${index}-${mappingIndex}`,
    obligationId: region.id,
    source: region.source,
    output: [
      {
        spineHref: 'EPUB/content.xhtml',
        anchorId: `output-${index}`,
        rendered: {
          screenshotId: `screenshot-${index}`,
          viewport,
          rect: { x: 1, y: 1, width: 10, height: 10 },
        },
      },
    ],
    status: 'mapped' as const,
  }))
  const observations = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map((check) =>
    createDeterministicObservationReceipt({
      idSha256: sha256HexSync(`observation-${index}-${check}`),
      check,
      source: contract.sourceRegions[0]!.source,
      mappingIds: [mappings[0]!.id],
      expectedSetReceiptSha256: contract.expectedObservationSets.find(
        (set) => set.check === check,
      )!.receiptSha256,
      actualSetReceiptSha256: actualObservationSets.find(
        (set) => set.check === check,
      )!.receiptSha256,
    }),
  )
  const structure = {
    schemaVersion: '0.2.0',
    documentId: graph.source.documentId,
    sourcePdfSha256: graph.source.sha256,
    artifact: { sha256: structSha256, byteLength: 128 },
    generatedSha256: sha256HexSync(`generated-${index}`),
    assets: [],
  }
  const epub = {
    bytes: { sha256: epubSha256, byteLength: epubBytes.byteLength },
    mediaType: 'application/epub+zip' as const,
    structSha256,
    epubCheck: {
      toolId: 'epubcheck',
      toolVersion: '5.3.0',
      reportSha256: sha256HexSync(epubCheckReportBytes),
      status: 'passed' as const,
      errorCount: 0,
      warningCount: 0,
    },
  }
  const comparator = compareSourceToRenderedEpub({
    sourcePdfSha256: graph.source.sha256,
    sourceEvidence: contract.sourceEvidenceReceipt,
    structure,
    epub,
    renderedEpub,
    sourceRegions: contract.sourceRegions,
    mappings,
    observations,
  })
  const reconciliationInputSha256 = hashTraceValue({
    sourcePdfSha256: graph.source.sha256,
    evidenceGraphSha256: graph.graphSha256,
    candidateSetSha256: contract.sourceEvidenceReceipt.candidateSetSha256,
    structSha256,
    epubSha256,
    renderObservationReceiptSha256: renderedEpub.receiptSha256,
  })
  const codexIdentity = {
    server: {
      id: 'owner-local-codex-server',
      version: '1.0.0',
      transport: 'unix:///private/opaque/codex.sock',
      executableSha256: sha256HexSync('codex-server'),
    },
    model: {
      id: 'gpt-local-test',
      version: 'fixture-1',
      sha256: 'e'.repeat(64),
    },
    prompt: {
      id: 'source-grounded-reconciliation',
      version: '1.0.0',
      sha256: sha256HexSync('prompt'),
    },
    tool: { id: 'codex-cli', version: '0.146.0' },
  }
  return {
    contract,
    trace: createReconstructionAttemptTrace({
      schemaVersion: '1.0.0',
      attemptId: `attempt-${index}-${mismatch ? 'prior' : 'final'}`,
      lineage: {
        attemptIndex: 0,
        parentTraceSha256: null,
        immutablePriorTraceSha256: null,
        appliedRepair: null,
      },
      sourcePdf: {
        artifact: {
          sha256: graph.source.sha256,
          byteLength: graph.source.byteLength,
        },
        pageCount: 1,
        pageRenders: [
          {
            page: 1,
            sourcePdfSha256: graph.source.sha256,
            image: {
              sha256: sha256HexSync(`source-render-${index}`),
              byteLength: 20,
            },
            mediaType: 'image/png',
            width: 100,
            height: 100,
          },
        ],
      },
      evidenceGraph: {
        schemaVersion: contract.schemaVersion,
        artifact: contract.graphArtifact,
        sourcePdfSha256: graph.source.sha256,
      },
      sourceEvidence: contract.sourceEvidenceReceipt,
      evidenceCandidates: contract.evidenceCandidates,
      structure,
      epub,
      renderedEpub,
      mappings,
      comparisonEvidence: {
        sourceRegions: contract.sourceRegions,
        observations,
      },
      providerReceipts: [
        {
          id: 'source-evidence',
          role: 'source-evidence',
          required: true,
          enabledBeforeRun: true,
          providerId: 'source-evidence-contract',
          receiptSha256: sha256HexSync('source-receipt'),
          inputSha256: graph.source.sha256,
          outputSha256: contract.sourceEvidenceReceipt.receiptSha256,
          status: 'succeeded',
        },
        {
          id: 'actual-render',
          role: 'actual-render',
          required: true,
          enabledBeforeRun: true,
          providerId: 'owner-local-renderer',
          receiptSha256: sha256HexSync('render-receipt'),
          inputSha256: epubSha256,
          outputSha256: renderedEpub.receiptSha256,
          status: 'succeeded',
        },
        {
          id: 'codex-reconciliation',
          role: 'owner-local-codex-reconciliation',
          required: true,
          enabledBeforeRun: true,
          providerId: 'owner-local-codex-server',
          identitySha256: hashTraceValue(codexIdentity),
          receiptSha256: sha256HexSync('codex-receipt'),
          inputSha256: reconciliationInputSha256,
          outputSha256: hashTraceValue(comparator),
          ...codexIdentity,
          status: 'succeeded',
        },
      ],
      comparator,
      critiqueRepair: null,
      budget: {
        policy: {
          maxRefinements: 3,
          maxFreshTasks: 1,
          maxTokens: 24_000,
          maxDurationMs: 1_800_000,
          repairPolicySha256: sha256HexSync('repair-policy'),
        },
        usage: { refinements: 0, freshTasks: 0, tokens: 0, durationMs: 0 },
      },
      terminalState: mismatch ? 'failed' : 'publication-ready',
    }),
  }
}

function packetFixture() {
  const store = new Map<string, Uint8Array>()
  let nextId = 0
  const retain = (bytes: Uint8Array): OwnerLocalEvaluationArtifact => {
    const opaqueId = `retained-artifact-${nextId++}`
    store.set(opaqueId, bytes.slice())
    return {
      sha256: sha256HexSync(bytes),
      byteLength: bytes.byteLength,
      resolverId: 'owner-local-development-resolver',
      opaqueId,
    }
  }
  const documents: ReconstructionDevelopmentEvaluationDocument[] = []
  for (let index = 1; index <= 4; index += 1) {
    const sourceBytes = encoder.encode(`%PDF-${index}\npublic development input`)
    const graph = graphFor(sourceBytes, index)
    const epubBytes = encoder.encode(`PK\u0003\u0004development-epub-${index}`)
    const epubCheckReportBytes = encoder.encode(
      `EPUBCheck 5.3.0 PASS document ${index}`,
    )
    const prior = traceFor({
      graph,
      index,
      epubBytes,
      epubCheckReportBytes,
      mismatch: true,
    })
    const final = traceFor({
      graph,
      index,
      epubBytes,
      epubCheckReportBytes,
      mismatch: false,
    })
    const codexReceipt = {
      schemaVersion: '1.0.0',
      status: 'accepted',
      documentIdSha256: '1'.repeat(64),
      attemptIdSha256: '2'.repeat(64),
      isolatedSessionSha256: '3'.repeat(64),
      graphSha256: graph.graphSha256,
      candidateSetSha256:
        prior.contract.sourceEvidenceReceipt.candidateSetSha256,
      requestSha256: '4'.repeat(64),
      responseSha256: '5'.repeat(64),
      selectionSetSha256: '6'.repeat(64),
      comparisonEvidenceSha256: prior.trace.traceSha256,
      cropEvidenceSha256: '8'.repeat(64),
      threadSha256: '9'.repeat(64),
      turnSha256: 'a'.repeat(64),
      identities: {
        endpointSha256: 'b'.repeat(64),
        serverSha256: 'c'.repeat(64),
        toolSha256: 'd'.repeat(64),
        modelSha256: 'e'.repeat(64),
        promptSha256: 'f'.repeat(64),
        renderArtifactResolverSha256: '1'.repeat(64),
        observedModelSha256: '2'.repeat(64),
      },
      counts: {
        decisionCount: 1,
        candidateCount: 2,
        renderCount: 2,
        sourceCropCount: 1,
        epubCropCount: 1,
      },
    }
    documents.push({
      idSha256: sha256HexSync(`development-document-${index}`),
      status: 'passed',
      sourcePdfSha256: graph.source.sha256,
      graphSha256: graph.graphSha256,
      candidateSetSha256:
        prior.contract.sourceEvidenceReceipt.candidateSetSha256,
      sourcePdf: retain(sourceBytes),
      sourceEvidenceGraph: retain(serializeSourceEvidenceGraph(graph)),
      expectedObservationPayloads: prior.contract.expectedObservationSets.map(
        ({ check, payloadBytes }) => ({ check, artifact: retain(payloadBytes) }),
      ),
      localCodexPriorTrace: retain(jsonBytes(prior.trace)),
      localCodexReceipt: retain(jsonBytes(codexReceipt)),
      materializationReceipt: retain(
        jsonBytes({ verifiedBy: 'exact-external-200-verifier', document: index }),
      ),
      epub: retain(epubBytes),
      epubCheckReport: retain(epubCheckReportBytes),
      finalAttemptTrace: retain(jsonBytes(final.trace)),
    })
  }
  const calls = {
    codex: vi.fn(),
    materialization: vi.fn(),
    rendered: vi.fn(),
    epubCheck: vi.fn(),
  }
  const authority = (
    stage:
      | 'owner-local-codex'
      | 'grounded-materialization'
      | 'rendered-epub'
      | 'epubcheck',
    spy: (context: ReconstructionDevelopmentVerificationContext) => unknown,
    predicate: (
      context: ReconstructionDevelopmentVerificationContext,
    ) => boolean,
  ) => {
    const identity = {
      id: `${stage}-verifier`,
      version: '1.0.0',
      configurationSha256: sha256HexSync(`${stage}-configuration`),
      executableSha256: sha256HexSync(`${stage}-executable`),
    }
    return {
      identity,
      verify: async (context: ReconstructionDevelopmentVerificationContext) => {
        spy(context)
        return predicate(context)
          ? createReconstructionDevelopmentStageVerificationReceipt(
              stage,
              identity,
              context,
            )
          : { status: 'failed' }
      },
    }
  }
  const authorities: ReconstructionDevelopmentVerifierAuthorities = {
    localCodex: authority('owner-local-codex', calls.codex, () => true),
    groundedMaterialization: authority(
      'grounded-materialization',
      calls.materialization,
      ({ materializationReceiptBytes }) =>
        new TextDecoder()
          .decode(materializationReceiptBytes)
          .includes('exact-external-200-verifier'),
    ),
    renderedEpub: authority(
      'rendered-epub',
      calls.rendered,
      ({ finalTrace }) => finalTrace.renderedEpub.screenshots.length > 0,
    ),
    epubCheck: authority(
      'epubcheck',
      calls.epubCheck,
      ({ epubCheckReportBytes }) =>
        new TextDecoder().decode(epubCheckReportBytes).includes('PASS'),
    ),
  }
  return {
    packet: {
      schemaVersion: RECONSTRUCTION_DEVELOPMENT_EVALUATION_SCHEMA_VERSION,
      policy: createReconstructionDevelopmentEvaluationPolicy(authorities),
      documents,
    },
    store,
    resolver: async (reference: OwnerLocalEvaluationArtifact) =>
      store.get(reference.opaqueId)?.slice() ?? new Uint8Array(),
    authorities,
    calls,
  }
}

describe('durable four-document reconstruction development evaluation', () => {
  it('validates the synthetic verifier-authority contract without claiming tool execution', async () => {
    const fixture = packetFixture()
    await expect(
      verifyReconstructionDevelopmentEvaluationPacket(
        fixture.packet,
        fixture.resolver,
        fixture.authorities,
      ),
    ).resolves.toMatchObject({
      schemaVersion: '2.0.0',
      status: 'passed',
      documentCount: 4,
    })
    expect(fixture.calls.codex).toHaveBeenCalledTimes(4)
    expect(fixture.calls.materialization).toHaveBeenCalledTimes(4)
    expect(fixture.calls.rendered).toHaveBeenCalledTimes(4)
    expect(fixture.calls.epubCheck).toHaveBeenCalledTimes(4)
  })

  it('rejects evaluator authority identity drift from the frozen packet policy', async () => {
    const fixture = packetFixture()
    const mutableIdentity = fixture.authorities.renderedEpub.identity as {
      configurationSha256: string
    }
    mutableIdentity.configurationSha256 = sha256HexSync(
      'drifted-renderer-configuration',
    )
    await expect(
      verifyReconstructionDevelopmentEvaluationPacket(
        fixture.packet,
        fixture.resolver,
        fixture.authorities,
      ),
    ).rejects.toThrow('INVALID_DEVELOPMENT_EVALUATION_VERIFIER_AUTHORITY')
  })

  it('rejects fabricated #200 materialization despite self-consistent PDF and EPUB shapes', async () => {
    const fixture = packetFixture()
    const reference = fixture.packet.documents[0]!.materializationReceipt
    const fabricated = jsonBytes({
      schemaVersion: '1.0.0',
      readyForStruct: true,
      claim: 'self-hashed but never verified',
    })
    reference.sha256 = sha256HexSync(fabricated)
    reference.byteLength = fabricated.byteLength
    fixture.store.set(reference.opaqueId, fabricated)
    await expect(
      verifyReconstructionDevelopmentEvaluationPacket(
        fixture.packet,
        fixture.resolver,
        fixture.authorities,
      ),
    ).rejects.toThrow('EXTERNAL_VERIFICATION_FAILED')
  })

  it('rejects a tampered comparator trace even when the retained hash is updated', async () => {
    const fixture = packetFixture()
    const reference = fixture.packet.documents[0]!.finalAttemptTrace
    const trace = JSON.parse(
      new TextDecoder().decode(fixture.store.get(reference.opaqueId)!),
    )
    trace.comparator.status = 'failed'
    const tampered = jsonBytes(trace)
    reference.sha256 = sha256HexSync(tampered)
    reference.byteLength = tampered.byteLength
    fixture.store.set(reference.opaqueId, tampered)
    await expect(
      verifyReconstructionDevelopmentEvaluationPacket(
        fixture.packet,
        fixture.resolver,
        fixture.authorities,
      ),
    ).rejects.toThrow()
  })

  it('rejects a provider-only packet and retained source tampering', async () => {
    const fixture = packetFixture()
    await expect(
      verifyReconstructionDevelopmentEvaluationPacket(
        {
          schemaVersion: '2.0.0',
          policy: fixture.packet.policy,
          documents: fixture.packet.documents.map((document) => ({
            idSha256: document.idSha256,
            mineruManifest: document.sourceEvidenceGraph,
          })),
        },
        fixture.resolver,
        fixture.authorities,
      ),
    ).rejects.toThrow('INVALID_DEVELOPMENT_EVALUATION_DOCUMENT')

    const source = fixture.packet.documents[0]!.sourcePdf
    fixture.store.set(source.opaqueId, encoder.encode('%PDF-tampered'))
    await expect(
      verifyReconstructionDevelopmentEvaluationPacket(
        fixture.packet,
        fixture.resolver,
        fixture.authorities,
      ),
    ).rejects.toThrow('ARTIFACT_IDENTITY_MISMATCH')
  })
})
