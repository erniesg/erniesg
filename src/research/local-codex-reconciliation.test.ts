import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createLocalCodexReconciliationClient,
  createOwnerLocalUnixSocketTransport,
  validateLocalCodexEndpoint,
  type LocalCodexJsonRpcNotification,
  type LocalCodexJsonRpcRequest,
  type LocalCodexJsonRpcTransport,
  type LocalCodexReconciliationClientConfig,
  type LocalCodexReconciliationRequest,
} from './local-codex-reconciliation'
import {
  SOURCE_EPUB_OBSERVATION_CHECK_IDS,
  createReconstructionAttemptTrace,
  hashEpubBytes,
  hashRenderedActualObservationSet,
  hashRenderedEpubEvidence,
  hashTraceValue,
} from './reconstruction-attempt-trace'
import {
  compareSourceToRenderedEpub,
  createDeterministicObservationReceipt,
} from './source-epub-comparator'
import { createSourceEvidenceContract } from './source-evidence-contract'
import {
  buildSourceEvidenceGraph,
  deterministicContextReceiptForBundle,
  readSourceEvidenceGraph,
  type SourceEvidenceGraph,
  type SourceEvidenceGraphInput,
} from './source-evidence-graph'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SOURCE_TEXT = 'private source text must never enter the receipt'
const RAW_REASONING = 'private raw reasoning must be discarded'
const SOURCE_RENDER_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWP4z8DwnxjMMKrwP12DBwCSw8c5bHZncwAAAABJRU5ErkJggg==',
  'base64',
)
const SOURCE_CROP_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWP4z8DwH4QBEfcD/RSF9bkAAAAASUVORK5CYII=',
  'base64',
)
const EPUB_RENDER_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWNgYPj/nzjMMKrwPx2DBwDLfMc5JCCjZgAAAABJRU5ErkJggg==',
  'base64',
)
const EPUB_CROP_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWNgYPj/H4KhDAA/0gf5WPNCXwAAAABJRU5ErkJggg==',
  'base64',
)

function sha256(value: Uint8Array | string) {
  return createHash('sha256').update(value).digest('hex')
}

function graphFixture(documentId = 'document-private-id'): SourceEvidenceGraph {
  const source = {
    documentId,
    sha256: SHA_A,
    byteLength: 128,
    pageCount: 1,
  }
  const provider = {
    id: 'provider-1',
    kind: 'pdfjs' as const,
    name: 'pdfjs-dist',
    version: '5.4.624',
    implementationSha256: SHA_B,
  }
  const box = {
    page: 1,
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.05,
    rotation: 0,
    method: 'pdf-text' as const,
  }
  const graphInput: Omit<
    SourceEvidenceGraphInput,
    'deterministicContext'
  > = {
    schemaVersion: '1.0.0',
    source,
    arms: [
      {
        id: 'deterministic',
        requirement: 'required',
        status: 'enabled',
        frozen: true,
        providerId: provider.id,
      },
      {
        id: 'mineru',
        requirement: 'required',
        status: 'enabled',
        frozen: true,
        providerId: 'mineru-provider',
      },
    ],
    bundles: [
      {
        schemaVersion: '1.0.0',
        id: 'bundle-1',
        armId: 'deterministic',
        source,
        provider,
        pages: [{ page: 1, width: 612, height: 792, rotation: 0 }],
        artifacts: [
          {
            id: 'artifact-1',
            providerId: provider.id,
            kind: 'source-run-evidence',
            mediaType: 'application/json',
            sha256: SHA_B,
            byteLength: 32,
            page: 1,
            box,
            sourceIds: ['source-1'],
          },
        ],
        sources: [
          {
            id: 'source-1',
            providerId: provider.id,
            kind: 'text-run',
            page: 1,
            box,
            artifactIds: ['artifact-1'],
            parentSourceIds: [],
            payload: { text: SOURCE_TEXT, localPath: '/private/paper.pdf' },
          },
        ],
        candidates: [
          {
            id: 'candidate-1',
            providerId: provider.id,
            kind: 'text',
            page: 1,
            boxes: [box],
            sourceIds: ['source-1'],
            artifactIds: ['artifact-1'],
            payload: { interpretation: 'first' },
          },
          {
            id: 'candidate-2',
            providerId: provider.id,
            kind: 'text',
            page: 1,
            boxes: [box],
            sourceIds: ['source-1'],
            artifactIds: ['artifact-1'],
            payload: { interpretation: 'second' },
          },
        ],
      },
      {
        schemaVersion: '1.0.0',
        id: 'mineru-bundle',
        armId: 'mineru',
        source,
        provider: {
          id: 'mineru-provider',
          kind: 'mineru',
          name: 'MinerU',
          version: '3.4.4',
        },
        pages: [{ page: 1, width: 612, height: 792, rotation: 0 }],
        artifacts: [
          {
            id: 'mineru-artifact',
            providerId: 'mineru-provider',
            kind: 'content-list-v2',
            mediaType: 'application/json',
            sha256: 'c'.repeat(64),
            byteLength: 32,
            page: 1,
            box,
            sourceIds: ['mineru-source'],
          },
        ],
        sources: [
          {
            id: 'mineru-source',
            providerId: 'mineru-provider',
            kind: 'provider-record',
            page: 1,
            box,
            artifactIds: ['mineru-artifact'],
          },
        ],
        candidates: [
          {
            id: 'mineru-candidate',
            providerId: 'mineru-provider',
            kind: 'provider-record',
            page: 1,
            boxes: [box],
            sourceIds: ['mineru-source'],
            artifactIds: ['mineru-artifact'],
            payload: { grounded: false },
          },
        ],
      },
    ],
    obligations: [
      {
        id: 'decision-obligation',
        kind: 'source-text',
        page: 1,
        sourceIds: ['source-1'],
        artifactIds: ['artifact-1'],
        candidateIds: ['candidate-1', 'candidate-2'],
        observationCategories: ['text-exactness'],
        required: true,
        semantic: true,
      },
      {
        id: 'mineru-discovery-obligation',
        kind: 'provider-source-fact',
        page: 1,
        sourceIds: ['mineru-source'],
        artifactIds: ['mineru-artifact'],
        candidateIds: ['mineru-candidate'],
        observationCategories: ['object-counts', 'asset-bytes'],
        required: false,
        semantic: false,
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

function failedTraceFixture(graph: SourceEvidenceGraph) {
  const contract = createSourceEvidenceContract(graph, {
    id: 'fixture-source-evidence-verifier',
    version: '1.0.0',
    configurationSha256: sha256('source-evidence-config'),
    executableSha256: sha256('source-evidence-executable'),
  })
  const epubBytes = Buffer.from('PK\u0003\u0004 exact EPUB fixture')
  const epubSha256 = hashEpubBytes(epubBytes)
  const structSha256 = sha256('STRUCT fixture')
  const domSha256 = sha256('fixture DOM')
  const viewport = { width: 10, height: 10, deviceScaleFactor: 1 }
  const actualObservationSets = contract.expectedObservationSets.map(
    ({ check, setSha256, itemCount, payload }) => {
      const mismatched = check === 'reading-order'
      const mismatchedPayload = {
        sha256: sha256('wrong reading order payload'),
        byteLength: 1,
      }
      const projection = {
        check,
        setSha256: mismatched ? mismatchedPayload.sha256 : setSha256,
        itemCount,
        payload: mismatched ? mismatchedPayload : payload,
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
  const renderedEpub = {
    epubSha256,
    download: {
      artifact: { sha256: epubSha256, byteLength: epubBytes.byteLength },
      verificationReceiptSha256: sha256('download receipt'),
    },
    sourceObligations: {
      sourcePdfSha256: graph.source.sha256,
      ...contract.sourceEvidenceReceipt.sourceObligations,
    },
    actualObservationSets,
    renderer: {
      id: 'fixture-renderer',
      version: '1.0.0',
      executableSha256: sha256('fixture renderer executable'),
      configurationSha256: sha256('fixture renderer config'),
    },
    domSnapshots: [
      {
        spineHref: 'EPUB/content.xhtml',
        dom: { sha256: domSha256, byteLength: 11 },
        anchors: ['candidate-output-1'],
      },
    ],
    screenshots: [
      {
        id: 'fixture-screenshot',
        spineHref: 'EPUB/content.xhtml',
        domSha256,
        image: {
          sha256: sha256(EPUB_RENDER_BYTES),
          byteLength: EPUB_RENDER_BYTES.byteLength,
        },
        mediaType: 'image/png' as const,
        width: 10,
        height: 10,
        viewport,
        fullPage: true,
      },
    ],
    receiptSha256: '0'.repeat(64),
  }
  renderedEpub.receiptSha256 = hashRenderedEpubEvidence(renderedEpub)
  const mappings = contract.sourceRegions.map((region, index) => ({
    id: `mapping-${index + 1}`,
    obligationId: region.id,
    source: region.source,
    output: [
      {
        spineHref: 'EPUB/content.xhtml',
        anchorId: 'candidate-output-1',
        rendered: {
          screenshotId: 'fixture-screenshot',
          viewport,
          rect: { x: 1, y: 1, width: 2, height: 2 },
        },
      },
    ],
    status: 'mapped' as const,
  }))
  const observations = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map((check) =>
    createDeterministicObservationReceipt({
      idSha256: sha256(`observation-${check}`),
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
    generatedSha256: sha256('generated STRUCT'),
    assets: [],
  }
  const epub = {
    bytes: { sha256: epubSha256, byteLength: epubBytes.byteLength },
    mediaType: 'application/epub+zip' as const,
    structSha256,
    epubCheck: {
      toolId: 'epubcheck',
      toolVersion: '5.3.0',
      reportSha256: sha256('EPUBCheck report'),
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
      transport: 'http://127.0.0.1:4500/v1',
      executableSha256: sha256('codex server'),
    },
    model: {
      id: 'gpt-local-test',
      version: 'fixture-1',
      sha256: SHA_B,
    },
    prompt: {
      id: 'source-grounded-reconciliation',
      version: '1.0.0',
      sha256: sha256('prompt'),
    },
    tool: { id: 'codex-cli', version: '0.146.0' },
  }
  return createReconstructionAttemptTrace({
    schemaVersion: '1.0.0',
    attemptId: 'prior-attempt',
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
            sha256: sha256(SOURCE_RENDER_BYTES),
            byteLength: SOURCE_RENDER_BYTES.byteLength,
          },
          mediaType: 'image/png',
          width: 10,
          height: 10,
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
        receiptSha256: sha256('source receipt'),
        inputSha256: graph.source.sha256,
        outputSha256: contract.sourceEvidenceReceipt.receiptSha256,
        status: 'succeeded',
      },
      {
        id: 'actual-render',
        role: 'actual-render',
        required: true,
        enabledBeforeRun: true,
        providerId: 'fixture-renderer',
        receiptSha256: sha256('render receipt'),
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
        receiptSha256: sha256('codex receipt'),
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
        repairPolicySha256: sha256('repair policy'),
      },
      usage: { refinements: 0, freshTasks: 0, tokens: 0, durationMs: 0 },
    },
    terminalState: 'failed',
  })
}

function reconciliationRequest(
  graph = graphFixture(),
): LocalCodexReconciliationRequest {
  const candidateIds = ['candidate-1', 'candidate-2']
  const reader = readSourceEvidenceGraph(graph)
  const priorTrace = failedTraceFixture(graph)
  const failure = priorTrace.comparator.failures.find(
    ({ check }) => check === 'reading-order',
  )!
  return {
    documentId: graph.source.documentId,
    attemptId: 'attempt-1',
    evidenceGraph: graph,
    graphSha256: graph.graphSha256,
    candidateSetSha256: reader.candidateSetSha256(candidateIds),
    decisions: [{ decisionId: 'reading-order', candidateIds }],
    comparisonEvidence: priorTrace,
    renders: [
      {
        id: 'source-crop-1',
        mimeType: 'image/png',
        dataBase64: SOURCE_CROP_BYTES.toString('base64'),
        sha256: sha256(SOURCE_CROP_BYTES),
        page: 1,
        box: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
        candidateIds,
        provenance: {
          kind: 'source-pdf',
          sourcePdfSha256: graph.source.sha256,
          sourcePageRenderSha256: sha256(SOURCE_RENDER_BYTES),
          failureId: failure.id,
        },
      },
      {
        id: 'epub-crop-1',
        mimeType: 'image/png',
        dataBase64: EPUB_CROP_BYTES.toString('base64'),
        sha256: sha256(EPUB_CROP_BYTES),
        page: 1,
        box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        candidateIds,
        provenance: {
          kind: 'rendered-epub',
          epubSha256: priorTrace.epub.bytes.sha256,
          renderReceiptSha256: priorTrace.renderedEpub.receiptSha256,
          spineHref: 'EPUB/content.xhtml',
          anchorId: 'candidate-output-1',
          domSha256: priorTrace.renderedEpub.domSnapshots[0]!.dom.sha256,
          screenshotSha256: sha256(EPUB_RENDER_BYTES),
          screenshotId: 'fixture-screenshot',
          failureId: failure.id,
        },
      },
    ],
  }
}

function validOutput(request: LocalCodexReconciliationRequest) {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    graphSha256: request.graphSha256,
    candidateSetSha256: request.candidateSetSha256,
    decisions: [
      {
        decisionId: request.decisions[0]!.decisionId,
        candidateId: 'candidate-1',
      },
    ],
  })
}

type FakeTransportOptions = {
  endpoint?: string
  finalEndpoint?: string
  redirected?: boolean
  output: string
  threadId?: string
  turnId?: string
  stall?: boolean
  modelId?: string
  providerId?: string
}

class FakeTransport implements LocalCodexJsonRpcTransport {
  readonly endpoint: string
  readonly finalEndpoint?: string
  readonly redirected?: boolean
  readonly requests: LocalCodexJsonRpcRequest[] = []
  readonly notifications: LocalCodexJsonRpcNotification[] = []
  readonly events: unknown[] = []
  readonly output: string
  readonly threadId: string
  readonly turnId: string
  readonly stall: boolean
  readonly modelId: string
  readonly providerId: string
  interrupted = 0
  closed = 0

  constructor(options: FakeTransportOptions) {
    this.endpoint = options.endpoint ?? 'ws://127.0.0.1:4500'
    this.finalEndpoint = options.finalEndpoint
    this.redirected = options.redirected
    this.output = options.output
    this.threadId = options.threadId ?? 'thread-1'
    this.turnId = options.turnId ?? 'turn-1'
    this.stall = options.stall ?? false
    this.modelId = options.modelId ?? 'gpt-local-test'
    this.providerId = options.providerId ?? 'codex-subscription'
  }

  async request(message: LocalCodexJsonRpcRequest) {
    this.requests.push(structuredClone(message))
    if (message.method === 'initialize') {
      return {
        userAgent: 'codex-cli/0.146.0',
        platformFamily: 'unix',
        platformOs: 'linux',
      }
    }
    if (message.method === 'thread/start') {
      return {
        thread: {
          id: this.threadId,
          sessionId: this.threadId,
          ephemeral: true,
        },
        model: this.modelId,
        modelProvider: this.providerId,
      }
    }
    if (message.method === 'turn/start') {
      this.events.push(
        {
          method: 'item/completed',
          params: {
            threadId: this.threadId,
            turnId: this.turnId,
            item: {
              type: 'reasoning',
              summary: [],
              content: [RAW_REASONING],
            },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: this.threadId,
            turnId: this.turnId,
            item: {
              type: 'agentMessage',
              phase: 'final_answer',
              text: this.output,
            },
          },
        },
        {
          method: 'turn/completed',
          params: {
            threadId: this.threadId,
            turn: {
              id: this.turnId,
              status: 'completed',
              items: [],
              error: null,
            },
          },
        },
      )
      return {
        turn: {
          id: this.turnId,
          status: 'inProgress',
          items: [],
          error: null,
        },
      }
    }
    if (message.method === 'turn/interrupt') {
      this.interrupted += 1
      return {}
    }
    throw new Error(`Unexpected method ${message.method}`)
  }

  notify(message: LocalCodexJsonRpcNotification) {
    this.notifications.push(structuredClone(message))
  }

  nextMessage({ signal }: { signal: AbortSignal }): Promise<unknown> {
    if (!this.stall && this.events.length > 0) {
      return Promise.resolve(this.events.shift())
    }
    return new Promise((_, reject) => {
      const abort = () => reject(new Error('aborted'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }

  close() {
    this.closed += 1
  }
}

function config(
  transportFactory: LocalCodexReconciliationClientConfig['transportFactory'],
  overrides: Partial<LocalCodexReconciliationClientConfig> = {},
): LocalCodexReconciliationClientConfig {
  return {
    endpoint: 'ws://127.0.0.1:4500',
    transportFactory,
    timeoutMs: 1_000,
    interruptTimeoutMs: 50,
    toolIdentity: {
      id: 'codex-cli',
      version: '0.146.0',
      executableSha256: SHA_A,
    },
    modelIdentity: {
      providerId: 'codex-subscription',
      modelId: 'gpt-local-test',
      modelVersion: 'fixture-1',
      modelDigest: SHA_B,
      reasoningEffort: 'high',
    },
    promptIdentity: {
      id: 'source-grounded-reconciliation',
      version: '1.0.0',
      instructions: 'Choose only a source-grounded candidate reference.',
    },
    renderArtifactResolver: {
      identity: {
        id: 'fixture-owner-local-render-resolver',
        version: '1.0.0',
        configurationSha256: sha256('fixture render resolver config'),
      },
      resolve: ({ artifact }) => {
        if (artifact.sha256 === sha256(SOURCE_RENDER_BYTES)) {
          return new Uint8Array(SOURCE_RENDER_BYTES)
        }
        if (artifact.sha256 === sha256(EPUB_RENDER_BYTES)) {
          return new Uint8Array(EPUB_RENDER_BYTES)
        }
        throw new Error('unexpected fixture artifact')
      },
    },
    ...overrides,
  }
}

describe('local Codex endpoint boundary', () => {
  it.each([
    ['ws://127.0.0.1:4500', 'loopback-websocket'],
    ['ws://127.20.30.40:4500', 'loopback-websocket'],
    ['ws://[::1]:4500', 'loopback-websocket'],
    ['ws://localhost:4500', 'loopback-websocket'],
    ['unix:///tmp/codex-app-server.sock', 'unix-socket'],
  ] as const)('accepts only a local endpoint: %s', (endpoint, kind) => {
    expect(validateLocalCodexEndpoint(endpoint)).toMatchObject({ kind })
  })

  it.each([
    'http://127.0.0.1:4500',
    'https://127.0.0.1:4500',
    'wss://127.0.0.1:4500',
    'ws://example.test:4500',
    'ws://10.0.0.1:4500',
    'ws://user@127.0.0.1:4500',
    'ws://127.0.0.1:4500/path',
    'ws://127.0.0.1:4500?token=value',
    'ws://127.0.0.1:4500#fragment',
    'unix://relative/socket',
    'unix:///tmp/../private/socket',
    'unix:///tmp/socket?redirect=1',
    'unix:///tmp/%73ocket',
  ])(
    'rejects remote, DNS, credential, and ambiguous endpoint %s',
    (endpoint) => {
      expect(() => validateLocalCodexEndpoint(endpoint)).toThrow(
        'LOCAL_CODEX_ENDPOINT_FORBIDDEN',
      )
    },
  )

  it('rejects redirecting transports before initialization', async () => {
    const request = reconciliationRequest()
    for (const transport of [
      new FakeTransport({ output: validOutput(request), redirected: true }),
      new FakeTransport({
        output: validOutput(request),
        finalEndpoint: 'ws://127.0.0.2:4500',
      }),
    ]) {
      const client = createLocalCodexReconciliationClient(
        config(() => transport),
      )
      await expect(client.reconcile(request)).rejects.toThrow(
        'LOCAL_CODEX_REDIRECT_FORBIDDEN',
      )
      expect(transport.requests).toEqual([])
    }
  })

  it('rejects API-key and redirect-shaped configuration', () => {
    const transport = new FakeTransport({ output: '{}' })
    for (const unsafe of [
      { apiKey: 'sk-proj-abcdefghijk' },
      { authorization: 'Bearer credential-value' },
      { followRedirects: true },
      { nested: { accessToken: 'not-even-needed' } },
    ]) {
      expect(() =>
        createLocalCodexReconciliationClient({
          ...config(() => transport),
          ...unsafe,
        } as LocalCodexReconciliationClientConfig),
      ).toThrow(/LOCAL_CODEX_(?:API_KEY|REDIRECT)_FORBIDDEN/u)
    }
  })
})

describe('local Codex reconciliation contract', () => {
  it('runs JSON-RPC over a real owner-only Unix WebSocket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'erniesg-codex-socket-'))
    const socketPath = join(root, 'app-server.sock')
    const request = reconciliationRequest()
    const server = createServer((socket) => {
      let buffered = Buffer.alloc(0)
      let upgraded = false
      const send = (value: unknown) => {
        const payload = Buffer.from(JSON.stringify(value), 'utf8')
        const header =
          payload.byteLength < 126
            ? Buffer.from([0x81, payload.byteLength])
            : Buffer.from([
                0x81,
                126,
                (payload.byteLength >> 8) & 0xff,
                payload.byteLength & 0xff,
              ])
        socket.write(Buffer.concat([header, payload]))
      }
      socket.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk])
        if (!upgraded) {
          const boundary = buffered.indexOf('\r\n\r\n')
          if (boundary < 0) return
          const requestHeaders = buffered
            .subarray(0, boundary)
            .toString('ascii')
          const key = requestHeaders.match(/^Sec-WebSocket-Key: (.+)$/imu)?.[1]
          if (!key) throw new Error('missing WebSocket key')
          const accept = createHash('sha1')
            .update(`${key.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64')
          socket.write(
            [
              'HTTP/1.1 101 Switching Protocols',
              'Upgrade: websocket',
              'Connection: Upgrade',
              `Sec-WebSocket-Accept: ${accept}`,
              '',
              '',
            ].join('\r\n'),
          )
          buffered = buffered.subarray(boundary + 4)
          upgraded = true
        }
        for (;;) {
          if (buffered.byteLength < 6) break
          const encodedLength = buffered[1]! & 0x7f
          const extendedLength = encodedLength === 126 ? 2 : 0
          if (encodedLength === 127)
            throw new Error('fixture frame unexpectedly large')
          const payloadLength =
            extendedLength === 0 ? encodedLength : buffered.readUInt16BE(2)
          const headerLength = 2 + extendedLength + 4
          if (buffered.byteLength < headerLength + payloadLength) break
          const mask = buffered.subarray(
            2 + extendedLength,
            headerLength,
          )
          const payload = Buffer.alloc(payloadLength)
          for (let index = 0; index < payloadLength; index += 1) {
            payload[index] =
              buffered[headerLength + index]! ^ mask[index % 4]!
          }
          buffered = buffered.subarray(headerLength + payloadLength)
          const message = JSON.parse(
            payload.toString('utf8'),
          ) as LocalCodexJsonRpcRequest
          if (message.method === 'initialize') {
            send({
              id: message.id,
              result: {
                userAgent: 'codex-cli/0.146.0',
                platformFamily: 'unix',
                platformOs: 'darwin',
              },
            })
          } else if (message.method === 'thread/start') {
            send({
              id: message.id,
              result: {
                thread: {
                  id: 'unix-thread-1',
                  sessionId: 'unix-thread-1',
                  ephemeral: true,
                },
                model: 'gpt-local-test',
                modelProvider: 'codex-subscription',
              },
            })
          } else if (message.method === 'turn/start') {
            send({
              id: message.id,
              result: { turn: { id: 'unix-turn-1', status: 'inProgress' } },
            })
            send({
              method: 'item/completed',
              params: {
                threadId: 'unix-thread-1',
                turnId: 'unix-turn-1',
                item: {
                  type: 'agentMessage',
                  phase: 'final_answer',
                  text: validOutput(request),
                },
              },
            })
            send({
              method: 'turn/completed',
              params: {
                threadId: 'unix-thread-1',
                turn: {
                  id: 'unix-turn-1',
                  status: 'completed',
                  items: [],
                  error: null,
                },
              },
            })
          }
        }
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      await chmod(socketPath, 0o600)
      const client = createLocalCodexReconciliationClient(
        config(createOwnerLocalUnixSocketTransport, {
          endpoint: `unix://${socketPath}`,
        }),
      )
      await expect(client.reconcile(request)).resolves.toMatchObject({
        selections: [
          { decisionId: 'reading-order', candidateId: 'candidate-1' },
        ],
        receipt: {
          status: 'accepted',
          threadSha256: sha256('unix-thread-1'),
          turnSha256: sha256('unix-turn-1'),
        },
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses the exact app-server handshake, isolated ephemeral thread, and read-only turn fields', async () => {
    const request = reconciliationRequest()
    const transport = new FakeTransport({ output: validOutput(request) })
    const client = createLocalCodexReconciliationClient(config(() => transport))

    await expect(client.reconcile(request)).resolves.toMatchObject({
      selections: [{ decisionId: 'reading-order', candidateId: 'candidate-1' }],
    })

    expect(transport.requests.map(({ method }) => method)).toEqual([
      'initialize',
      'thread/start',
      'turn/start',
    ])
    expect(transport.notifications).toEqual([
      { method: 'initialized', params: {} },
    ])
    expect(transport.requests[0]!.params).toMatchObject({
      clientInfo: {
        name: 'erniesg_struct_reconciliation',
        title: 'Ernie SG STRUCT Reconciliation',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: expect.arrayContaining([
          'item/reasoning/textDelta',
          'item/agentMessage/delta',
        ]),
      },
    })
    expect(transport.requests[1]!.params).toEqual({
      model: 'gpt-local-test',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      serviceName: 'erniesg_struct_reconciliation',
    })
    const turn = transport.requests[2]!.params!
    expect(turn).toMatchObject({
      threadId: 'thread-1',
      model: 'gpt-local-test',
      effort: 'high',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
    expect(turn.sandboxPolicy).toEqual({
      type: 'readOnly',
      networkAccess: false,
    })
    expect((turn.input as unknown[])[0]).toMatchObject({
      type: 'text',
      text_elements: [],
    })
    expect((turn.input as unknown[])[1]).toMatchObject({
      type: 'image',
      url: expect.stringMatching(/^data:image\/png;base64,/u),
    })
    expect(turn.outputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        graphSha256: { type: 'string', const: request.graphSha256 },
        candidateSetSha256: {
          type: 'string',
          const: request.candidateSetSha256,
        },
      },
    })
    expect(transport.closed).toBe(1)
  })

  it('binds the validated source graph and exact candidate set', async () => {
    const valid = reconciliationRequest()
    const make = (request: LocalCodexReconciliationRequest) =>
      createLocalCodexReconciliationClient(
        config(() => new FakeTransport({ output: validOutput(request) })),
      )

    await expect(
      make({ ...valid, graphSha256: SHA_B }).reconcile({
        ...valid,
        graphSha256: SHA_B,
      }),
    ).rejects.toThrow('LOCAL_CODEX_GRAPH_HASH_MISMATCH')
    await expect(
      make({ ...valid, candidateSetSha256: SHA_B }).reconcile({
        ...valid,
        candidateSetSha256: SHA_B,
      }),
    ).rejects.toThrow('LOCAL_CODEX_CANDIDATE_SET_HASH_MISMATCH')
    await expect(
      make(valid).reconcile({
        ...valid,
        decisions: [
          { decisionId: 'reading-order', candidateIds: ['not-in-graph'] },
        ],
      }),
    ).rejects.toThrow('LOCAL_CODEX_INVALID_CANDIDATE_SET')
  })

  it('rejects independently observed model or provider identity drift', async () => {
    const request = reconciliationRequest()
    for (const transport of [
      new FakeTransport({
        output: validOutput(request),
        modelId: 'rerouted-model',
      }),
      new FakeTransport({
        output: validOutput(request),
        providerId: 'hosted-provider',
      }),
    ]) {
      const client = createLocalCodexReconciliationClient(
        config(() => transport),
      )
      await expect(client.reconcile(request)).rejects.toThrow(
        'LOCAL_CODEX_MODEL_IDENTITY_MISMATCH',
      )
    }
  })

  it('requires a failed prior comparator receipt and matched source/EPUB crop provenance', async () => {
    const request = reconciliationRequest()
    const make = () =>
      createLocalCodexReconciliationClient(
        config(() => new FakeTransport({ output: validOutput(request) })),
      )
    const { comparisonEvidence: _comparisonEvidence, ...withoutComparison } =
      request
    await expect(
      make().reconcile(withoutComparison as LocalCodexReconciliationRequest),
    ).rejects.toThrow('LOCAL_CODEX_INVALID_COMPARISON_EVIDENCE')
    await expect(
      make().reconcile({
        ...request,
        comparisonEvidence: {
          ...request.comparisonEvidence,
          traceSha256: '0'.repeat(64),
        },
      }),
    ).rejects.toThrow('LOCAL_CODEX_INVALID_COMPARISON_EVIDENCE')
    await expect(
      make().reconcile({
        ...request,
        renders: request.renders.filter(
          ({ provenance }) => provenance.kind === 'source-pdf',
        ),
      }),
    ).rejects.toThrow('LOCAL_CODEX_SOURCE_EPUB_CROPS_REQUIRED')
  })

  it('rejects mismatched source/EPUB crop bytes, boxes, and artifact provenance', async () => {
    const request = reconciliationRequest()
    const attempts = [
      {
        ...request,
        renders: request.renders.map((render, index) =>
          index === 0
            ? {
                ...render,
                dataBase64: Buffer.from('invented-crop').toString('base64'),
                sha256: sha256(Buffer.from('invented-crop')),
              }
            : render,
        ),
      },
      {
        ...request,
        attemptId: 'attempt-altered-crop-box',
        renders: request.renders.map((render, index) =>
          index === 0
            ? { ...render, box: { ...render.box, width: 0.3 } }
            : render,
        ),
      },
      {
        ...request,
        attemptId: 'attempt-altered-render-provenance',
        renders: request.renders.map((render, index) =>
          index === 1 && render.provenance.kind === 'rendered-epub'
            ? {
                ...render,
                provenance: {
                  ...render.provenance,
                  screenshotSha256: SHA_B,
                },
              }
            : render,
        ),
      },
    ]
    for (const attempt of attempts) {
      const client = createLocalCodexReconciliationClient(
        config(
          () =>
            new FakeTransport({
              output: validOutput(attempt),
            }),
        ),
      )
      await expect(
        client.reconcile(attempt as LocalCodexReconciliationRequest),
      ).rejects.toThrow(/LOCAL_CODEX_(?:RENDER_CROP_MISMATCH|INVALID_RENDER_EVIDENCE)/u)
    }
  })

  it('replays an identical attempt without another transport call and rejects drift', async () => {
    const request = reconciliationRequest()
    const transports: FakeTransport[] = []
    const client = createLocalCodexReconciliationClient(
      config(() => {
        const transport = new FakeTransport({ output: validOutput(request) })
        transports.push(transport)
        return transport
      }),
    )
    const first = client.reconcile(request)
    const replay = client.reconcile(request)
    expect(replay).toBe(first)
    await expect(first).resolves.toEqual(await replay)
    expect(transports).toHaveLength(1)

    await expect(
      client.reconcile({
        ...request,
        decisions: [
          {
            decisionId: 'caption-association',
            candidateIds: ['candidate-1', 'candidate-2'],
          },
        ],
      }),
    ).rejects.toThrow('LOCAL_CODEX_IDEMPOTENCY_CONFLICT')
    expect(transports).toHaveLength(1)
  })

  it('creates a distinct transport and thread for every document-attempt session', async () => {
    const request = reconciliationRequest()
    const transports: FakeTransport[] = []
    const client = createLocalCodexReconciliationClient(
      config((_endpoint, sessionSha256) => {
        const transport = new FakeTransport({
          output: validOutput(request),
          threadId: `thread-${sessionSha256.slice(0, 12)}`,
          turnId: `turn-${transports.length + 1}`,
        })
        transports.push(transport)
        return transport
      }),
    )
    await client.reconcile(request)
    const second = { ...request, attemptId: 'attempt-2' }
    await client.reconcile(second)
    expect(transports).toHaveLength(2)
    expect(new Set(transports.map(({ threadId }) => threadId)).size).toBe(
      transports.length,
    )
  })

  it('rejects reuse of one transport across separate attempts', async () => {
    const request = reconciliationRequest()
    const transport = new FakeTransport({ output: validOutput(request) })
    const client = createLocalCodexReconciliationClient(config(() => transport))
    await client.reconcile(request)
    await expect(
      client.reconcile({ ...request, attemptId: 'attempt-2' }),
    ).rejects.toThrow('LOCAL_CODEX_SESSION_NOT_ISOLATED')
  })

  it('interrupts an in-flight turn on timeout and closes the transport', async () => {
    const request = reconciliationRequest()
    const transport = new FakeTransport({
      output: validOutput(request),
      stall: true,
    })
    const client = createLocalCodexReconciliationClient(
      config(() => transport, { timeoutMs: 15 }),
    )

    await expect(client.reconcile(request)).rejects.toThrow(
      'LOCAL_CODEX_TIMEOUT',
    )
    expect(transport.interrupted).toBe(1)
    expect(transport.requests.at(-1)).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    })
    expect(transport.closed).toBe(1)
  })

  it.each([
    {
      name: 'unlisted candidate',
      mutate: (value: Record<string, unknown>) => {
        ;(value.decisions as Record<string, unknown>[])[0]!.candidateId =
          'invented-candidate'
      },
    },
    {
      name: 'invented explanation',
      mutate: (value: Record<string, unknown>) => {
        value.explanation = 'invented source claim'
      },
    },
    {
      name: 'stale graph hash',
      mutate: (value: Record<string, unknown>) => {
        value.graphSha256 = SHA_B
      },
    },
    {
      name: 'duplicate decision',
      mutate: (value: Record<string, unknown>) => {
        value.decisions = [
          ...(value.decisions as unknown[]),
          ...(value.decisions as unknown[]),
        ]
      },
    },
  ])(
    'rejects candidate-reference response violation: $name',
    async ({ mutate }) => {
      const request = reconciliationRequest()
      const response = JSON.parse(validOutput(request)) as Record<
        string,
        unknown
      >
      mutate(response)
      const client = createLocalCodexReconciliationClient(
        config(() => new FakeTransport({ output: JSON.stringify(response) })),
      )
      await expect(client.reconcile(request)).rejects.toThrow(
        'LOCAL_CODEX_INVALID_RESPONSE',
      )
    },
  )

  it('returns a redacted deterministic receipt with only identity hashes', async () => {
    const graph = graphFixture('private-document-name.pdf')
    const base = reconciliationRequest(graph)
    const request: LocalCodexReconciliationRequest = {
      ...base,
      attemptId: 'private-attempt-name',
      renders: [
        {
          id: 'page-render-1',
          mimeType: 'image/png',
          dataBase64: SOURCE_CROP_BYTES.toString('base64'),
          sha256: sha256(SOURCE_CROP_BYTES),
          page: 1,
          box: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
          candidateIds: ['candidate-1', 'candidate-2'],
          provenance: {
            kind: 'source-pdf',
            sourcePdfSha256: graph.source.sha256,
            sourcePageRenderSha256: sha256(SOURCE_RENDER_BYTES),
            failureId: base.comparisonEvidence.comparator.failures[0]!.id,
          },
        },
        base.renders.find(
          ({ provenance }) => provenance.kind === 'rendered-epub',
        )!,
      ],
    }
    const transport = new FakeTransport({
      output: validOutput(request),
      threadId: 'private-thread-id',
      turnId: 'private-turn-id',
    })
    const client = createLocalCodexReconciliationClient(config(() => transport))
    const result = await client.reconcile(request)
    const receipt = JSON.stringify(result.receipt)
    const turnPayload = JSON.stringify(
      transport.requests.find(({ method }) => method === 'turn/start')?.params,
    )

    expect(result.receipt.identities).toEqual({
      endpointSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      serverSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      toolSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      modelSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      renderArtifactResolverSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      observedModelSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(result.receipt).toMatchObject({
      comparisonEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      cropEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      counts: {
        decisionCount: 1,
        candidateCount: 2,
        renderCount: 2,
        sourceCropCount: 1,
        epubCropCount: 1,
      },
    })
    for (const forbidden of [
      SOURCE_TEXT,
      RAW_REASONING,
      '/private/paper.pdf',
      request.documentId,
      request.attemptId,
      request.renders![0]!.dataBase64,
      'ws://127.0.0.1:4500',
      'gpt-local-test',
      'private-thread-id',
      'private-turn-id',
      'Choose only a source-grounded candidate reference.',
      'credential',
      'apiKey',
    ]) {
      expect(receipt).not.toContain(forbidden)
    }
    for (const forbidden of [
      '/private/paper.pdf',
      request.documentId,
      request.attemptId,
    ]) {
      expect(turnPayload).not.toContain(forbidden)
    }
    expect(turnPayload).toContain(SOURCE_TEXT)
    expect(turnPayload).toContain(request.renders![0]!.dataBase64)
    expect(turnPayload).toContain('candidate-1')
    expect(turnPayload).toContain(request.renders![0]!.sha256)
    expect(receipt).not.toMatch(
      /(?:sourceText|rawText|reasoning|image|path|credential|apiKey|token)/iu,
    )
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.receipt)).toBe(true)
  })

  it('permits a schema-bound abstention without accepting invented content', async () => {
    const request = reconciliationRequest()
    const output = JSON.stringify({
      schemaVersion: '1.0.0',
      graphSha256: request.graphSha256,
      candidateSetSha256: request.candidateSetSha256,
      decisions: [{ decisionId: 'reading-order', abstain: true }],
    })
    const client = createLocalCodexReconciliationClient(
      config(() => new FakeTransport({ output })),
    )
    await expect(client.reconcile(request)).resolves.toMatchObject({
      selections: [{ decisionId: 'reading-order', abstain: true }],
    })
  })

  it('rejects oversized or whole-page evidence instead of widening the local trace', async () => {
    const graph = graphFixture()
    const request = reconciliationRequest(graph)
    const large = Buffer.alloc(512 * 1024 + 1, 1)
    const client = createLocalCodexReconciliationClient(
      config(() => new FakeTransport({ output: validOutput(request) })),
    )
    await expect(
      client.reconcile({
        ...request,
        renders: [
          {
            id: 'oversized-crop',
            mimeType: 'image/png',
            dataBase64: large.toString('base64'),
            sha256: sha256(large),
            page: 1,
            box: { x: 0, y: 0, width: 0.2, height: 0.2 },
            candidateIds: ['candidate-1'],
            provenance: {
              kind: 'source-pdf',
              sourcePdfSha256: graph.source.sha256,
              sourcePageRenderSha256: sha256(SOURCE_RENDER_BYTES),
              failureId:
                request.comparisonEvidence.comparator.failures[0]!.id,
            },
          },
        ],
      }),
    ).rejects.toThrow('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')

    const small = Buffer.from('crop')
    await expect(
      client.reconcile({
        ...request,
        attemptId: 'attempt-whole-page',
        renders: [
          {
            id: 'whole-page',
            mimeType: 'image/png',
            dataBase64: small.toString('base64'),
            sha256: sha256(small),
            page: 1,
            box: { x: 0, y: 0, width: 1, height: 1 },
            candidateIds: ['candidate-1'],
            provenance: {
              kind: 'source-pdf',
              sourcePdfSha256: graph.source.sha256,
              sourcePageRenderSha256: sha256(SOURCE_RENDER_BYTES),
              failureId:
                request.comparisonEvidence.comparator.failures[0]!.id,
            },
          },
        ],
      }),
    ).rejects.toThrow('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
  })
})
