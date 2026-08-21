import { describe, expect, it } from 'vitest'
import { sha256HexSync } from './sha256-sync'
import {
  RECONSTRUCTION_ATTEMPT_TRACE_SCHEMA_VERSION,
  canonicalTraceJson,
  createReconstructionAttemptTrace,
  encodeCanonicalObservationPayload,
  hashAppliedRepairBinding,
  hashEpubBytes,
  hashReconstructionAttemptTrace,
  hashRenderedActualObservationSet,
  hashRenderedEpubEvidence,
  hashSourceEvidenceReceipt,
  hashSourceExpectedObservationSet,
  hashTraceValue,
  serializeReconstructionAttemptTrace,
  toRefinementTraceBinding,
  validateReconstructionAttemptTrace,
  validateReconstructionAttemptTraceLineage,
  verifyEpubArtifactBytes,
  type ReconstructionAttemptTraceCore,
  type RenderedEpubEvidence,
} from './reconstruction-attempt-trace'
import {
  SOURCE_EPUB_OBSERVATION_CHECK_IDS,
  compareSourceToRenderedEpub,
  createDeterministicObservationReceipt,
} from './source-epub-comparator'

const digest = (value: string | Uint8Array) => sha256HexSync(value)
const epubBytes = new TextEncoder().encode('exact downloadable epub bytes')
const viewport = { width: 800, height: 1_000, deviceScaleFactor: 1 }
const source = {
  page: 1,
  boxes: [{ page: 1, x: 10, y: 20, width: 100, height: 80, rotation: 0 }],
  sourceRegionIds: ['region-1'],
}
const source2 = {
  page: 1,
  boxes: [{ page: 1, x: 10, y: 140, width: 100, height: 80, rotation: 0 }],
  sourceRegionIds: ['region-2'],
}

function observationPayload(
  check: (typeof SOURCE_EPUB_OBSERVATION_CHECK_IDS)[number],
  labels: string[],
) {
  const bytes = encodeCanonicalObservationPayload({
    schemaVersion: '1.0.0',
    check,
    items: labels.map((label) => ({
      idSha256: digest(`item-${check}-${label}`),
      valueSha256: digest(`value-${check}-${label}`),
      anchorIds: ['struct-paragraph-1'],
    })),
  })
  return { sha256: digest(bytes), byteLength: bytes.byteLength }
}

function coreFixture(
  status: 'publication-ready' | 'failed' = 'publication-ready',
): ReconstructionAttemptTraceCore {
  const sourcePdfSha256 = digest('source-pdf')
  const evidenceGraphSha256 = digest('evidence-graph')
  const structSha256 = digest('struct-artifact')
  const epubSha256 = hashEpubBytes(epubBytes)
  const evidenceCandidates = [
    {
      referenceSha256: digest('provider-neutral-candidate'),
      bindingSha256: digest('provider-neutral-candidate-binding'),
    },
  ]
  const sourceRegions = [
    { id: 'region-1', source },
    { id: 'region-2', source: source2 },
  ]
  const obligationProjection = {
    sourcePdfSha256,
    obligationsSha256: hashTraceValue(sourceRegions),
    obligationCount: sourceRegions.length,
  }
  const expectedObservationSets = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map(
    (check) => {
      const labels =
        check === 'figures' ? ['source-figure'] : [`value-${check}`]
      const payload = observationPayload(check, labels)
      const projection = {
        check,
        setSha256: payload.sha256,
        itemCount: 1,
        payload,
        sourceRegionIds: ['region-1', 'region-2'],
      }
      return {
        ...projection,
        receiptSha256: hashSourceExpectedObservationSet({
          ...projection,
          receiptSha256: digest('pending-expected-observation-set'),
        }),
      }
    },
  )
  const actualObservationSets = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map(
    (check) => {
      const labels =
        check === 'figures'
          ? status === 'failed'
            ? []
            : ['source-figure']
          : [`value-${check}`]
      const payload = observationPayload(check, labels)
      const projection = {
        check,
        setSha256: payload.sha256,
        itemCount: status === 'failed' && check === 'figures' ? 0 : 1,
        payload,
      }
      return {
        ...projection,
        receiptSha256: hashRenderedActualObservationSet({
          ...projection,
          receiptSha256: digest('pending-actual-observation-set'),
        }),
      }
    },
  )
  const sourceEvidenceWithoutReceipt = {
    schemaVersion: '198.1.0',
    sourcePdfSha256,
    evidenceGraphSha256,
    candidateSetSha256: hashTraceValue(evidenceCandidates),
    sourceObligations: {
      obligationsSha256: obligationProjection.obligationsSha256,
      obligationCount: obligationProjection.obligationCount,
      receiptSha256: hashTraceValue(obligationProjection),
    },
    expectedObservationSets,
  }
  const sourceEvidence = {
    ...sourceEvidenceWithoutReceipt,
    receiptSha256: hashSourceEvidenceReceipt({
      ...sourceEvidenceWithoutReceipt,
      receiptSha256: digest('pending-source-evidence'),
    }),
  }
  const renderedEpub: RenderedEpubEvidence = {
    epubSha256,
    download: {
      artifact: { sha256: epubSha256, byteLength: epubBytes.byteLength },
      verificationReceiptSha256: digest('download-verification'),
    },
    sourceObligations: {
      ...obligationProjection,
      receiptSha256: hashTraceValue(obligationProjection),
    },
    actualObservationSets,
    renderer: {
      id: 'chromium',
      version: '1.0.0',
      executableSha256: digest('chromium'),
      configurationSha256: digest('render-configuration'),
    },
    domSnapshots: [
      {
        spineHref: 'EPUB/content.xhtml',
        dom: { sha256: digest('rendered-dom'), byteLength: 200 },
        anchors: ['struct-paragraph-1', 'struct-paragraph-2'],
      },
    ],
    screenshots: [
      {
        id: 'screenshot-1',
        spineHref: 'EPUB/content.xhtml',
        domSha256: digest('rendered-dom'),
        image: { sha256: digest('screenshot'), byteLength: 400 },
        mediaType: 'image/png',
        width: 800,
        height: 1_000,
        viewport,
        fullPage: true,
      },
    ],
    receiptSha256: digest('pending-render-receipt'),
  }
  renderedEpub.receiptSha256 = hashRenderedEpubEvidence(renderedEpub)
  const mappings = [
    {
      id: 'mapping-1',
      obligationId: 'obligation-1',
      source,
      output: [
        {
          spineHref: 'EPUB/content.xhtml',
          anchorId: 'struct-paragraph-1',
          rendered: {
            screenshotId: 'screenshot-1',
            viewport,
            rect: { x: 10, y: 20, width: 100, height: 80 },
          },
        },
      ],
      status: 'mapped' as const,
    },
    {
      id: 'mapping-2',
      obligationId: 'obligation-2',
      source: source2,
      output: [
        {
          spineHref: 'EPUB/content.xhtml',
          anchorId: 'struct-paragraph-2',
          rendered: {
            screenshotId: 'screenshot-1',
            viewport,
            rect: { x: 10, y: 140, width: 100, height: 80 },
          },
        },
      ],
      status: 'mapped' as const,
    },
  ]
  const observations = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map((check) =>
    createDeterministicObservationReceipt({
      idSha256: digest(`observation-${check}`),
      check,
      source,
      mappingIds: ['mapping-1'],
      expectedSetReceiptSha256: expectedObservationSets.find(
        (set) => set.check === check,
      )!.receiptSha256,
      actualSetReceiptSha256: actualObservationSets.find(
        (set) => set.check === check,
      )!.receiptSha256,
    }),
  )
  const structure = {
    schemaVersion: '0.2.0',
    documentId: 'document-1',
    sourcePdfSha256,
    artifact: { sha256: structSha256, byteLength: 600 },
    generatedSha256: digest('generated-struct'),
    assets: [
      { id: 'asset-1', sha256: digest('asset-bytes'), byteLength: 100 },
    ],
  }
  const epub = {
    bytes: { sha256: epubSha256, byteLength: epubBytes.byteLength },
    mediaType: 'application/epub+zip' as const,
    structSha256,
    epubCheck: {
      toolId: 'epubcheck',
      toolVersion: '5.3.0',
      reportSha256: digest('epubcheck-report'),
      status: 'passed' as const,
      errorCount: 0,
      warningCount: 0,
    },
  }
  const comparator = compareSourceToRenderedEpub({
    sourcePdfSha256,
    sourceEvidence,
    structure,
    epub,
    renderedEpub,
    sourceRegions,
    mappings,
    observations,
  })
  const reconciliationInputSha256 = hashTraceValue({
    sourcePdfSha256,
    evidenceGraphSha256,
    candidateSetSha256: sourceEvidence.candidateSetSha256,
    structSha256,
    epubSha256,
    renderObservationReceiptSha256: renderedEpub.receiptSha256,
  })
  const codexIdentity = {
    server: {
      id: 'owner-local-codex-server',
      version: '1.0.0',
      transport: 'http://127.0.0.1:4500/v1',
      executableSha256: digest('codex-server'),
    },
    model: {
      id: 'gpt-5.6-sol',
      version: '2026.08.01',
      sha256: digest('codex-model'),
    },
    prompt: {
      id: 'reconstruction-reconciliation',
      version: '1.0.0',
      sha256: digest('codex-prompt'),
    },
    tool: { id: 'codex', version: '0.99.0' },
  }
  return {
    schemaVersion: RECONSTRUCTION_ATTEMPT_TRACE_SCHEMA_VERSION,
    attemptId: 'attempt-0',
    lineage: {
      attemptIndex: 0,
      parentTraceSha256: null,
      immutablePriorTraceSha256: null,
      appliedRepair: null,
    },
    sourcePdf: {
      artifact: { sha256: sourcePdfSha256, byteLength: 1_000 },
      pageCount: 1,
      pageRenders: [
        {
          page: 1,
          sourcePdfSha256,
          image: { sha256: digest('source-page-1'), byteLength: 500 },
          mediaType: 'image/png',
          width: 600,
          height: 800,
        },
      ],
    },
    evidenceGraph: {
      schemaVersion: '198.1.0',
      artifact: { sha256: evidenceGraphSha256, byteLength: 800 },
      sourcePdfSha256,
    },
    sourceEvidence,
    evidenceCandidates,
    structure,
    epub,
    renderedEpub,
    mappings,
    comparisonEvidence: { sourceRegions, observations },
    providerReceipts: [
      {
        id: 'provider-source-evidence',
        role: 'source-evidence',
        required: true,
        enabledBeforeRun: true,
        providerId: 'provider-neutral-source-evidence',
        receiptSha256: digest('provider-source-evidence-receipt'),
        inputSha256: sourcePdfSha256,
        outputSha256: sourceEvidence.receiptSha256,
        status: 'succeeded',
      },
      {
        id: 'provider-render',
        role: 'actual-render',
        required: true,
        enabledBeforeRun: true,
        providerId: 'owner-local-chromium',
        receiptSha256: digest('provider-render-receipt'),
        inputSha256: epubSha256,
        outputSha256: renderedEpub.receiptSha256,
        status: 'succeeded',
      },
      {
        id: 'provider-codex-reconciliation',
        role: 'owner-local-codex-reconciliation',
        required: true,
        enabledBeforeRun: true,
        providerId: 'owner-local-codex-server',
        identitySha256: hashTraceValue(codexIdentity),
        receiptSha256: digest('provider-codex-reconciliation-receipt'),
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
        repairPolicySha256: digest('repair-policy'),
      },
      usage: { refinements: 0, freshTasks: 0, tokens: 0, durationMs: 0 },
    },
    terminalState: status,
  }
}

function childCoreFixture(
  parent: ReturnType<typeof createReconstructionAttemptTrace>,
) {
  const child = coreFixture('publication-ready')
  const resultingStructSha256 = digest('struct-artifact-child')
  child.attemptId = 'attempt-1'
  child.structure.artifact = {
    sha256: resultingStructSha256,
    byteLength: 620,
  }
  child.epub.structSha256 = resultingStructSha256
  child.comparator = compareSourceToRenderedEpub({
    sourcePdfSha256: child.sourcePdf.artifact.sha256,
    sourceEvidence: child.sourceEvidence,
    structure: child.structure,
    epub: child.epub,
    renderedEpub: child.renderedEpub,
    sourceRegions: child.comparisonEvidence.sourceRegions,
    mappings: child.mappings,
    observations: child.comparisonEvidence.observations,
  })
  const proposalProjection = {
    schemaVersion: '1.0.0' as const,
    documentId: child.structure.documentId,
    sourcePdfSha256: child.sourcePdf.artifact.sha256,
    sourceEvidenceGraphSha256: child.evidenceGraph.artifact.sha256,
    baseStructSha256: parent.structure.artifact.sha256,
    priorTraceSha256: parent.traceSha256,
    taskIdSha256: digest('fresh-task'),
    operations: [
      {
        op: 'select-evidence-candidate' as const,
        targetKind: 'relationship' as const,
        targetId: 'figure-relationship-1',
        candidateReferenceSha256:
          child.evidenceCandidates[0]!.referenceSha256,
      },
    ],
  }
  const proposal = {
    ...proposalProjection,
    proposalSha256: hashTraceValue(proposalProjection),
  }
  const applicationProjection = {
    proposalSha256: proposal.proposalSha256,
    baseStructSha256: parent.structure.artifact.sha256,
    resultingStructSha256,
    applicationReceiptSha256: digest('materialized-application-receipt'),
    groundedVerifierReceiptSha256: digest('grounded-verifier-receipt'),
  }
  child.lineage = {
    attemptIndex: 1,
    parentTraceSha256: parent.traceSha256,
    immutablePriorTraceSha256: parent.traceSha256,
    appliedRepair: {
      ...applicationProjection,
      applicationSha256: hashAppliedRepairBinding(applicationProjection),
    },
  }
  child.critiqueRepair = {
    providerReceiptId: 'provider-codex-repair',
    priorComparatorSha256: hashTraceValue(parent.comparator),
    priorFirstCauseFailureId: parent.comparator.firstCauseFailureId!,
    critiqueSha256: digest('critique'),
    proposal,
    disposition: 'verified',
  }
  const reconciliation = child.providerReceipts.find(
    ({ role }) => role === 'owner-local-codex-reconciliation',
  )!
  reconciliation.inputSha256 = hashTraceValue({
    sourcePdfSha256: child.sourcePdf.artifact.sha256,
    evidenceGraphSha256: child.evidenceGraph.artifact.sha256,
    candidateSetSha256: child.sourceEvidence.candidateSetSha256,
    structSha256: child.structure.artifact.sha256,
    epubSha256: child.epub.bytes.sha256,
    renderObservationReceiptSha256: child.renderedEpub.receiptSha256,
  })
  reconciliation.outputSha256 = hashTraceValue(child.comparator)
  child.providerReceipts.push({
    ...reconciliation,
    id: 'provider-codex-repair',
    role: 'owner-local-codex-repair',
    receiptSha256: digest('provider-codex-repair-receipt'),
    inputSha256: hashTraceValue(parent.comparator),
    outputSha256: proposal.proposalSha256,
  })
  child.budget.usage = {
    refinements: 1,
    freshTasks: 1,
    tokens: 100,
    durationMs: 10,
  }
  return child
}

describe('reconstruction attempt trace', () => {
  it('canonically hashes, serializes, and verifies exact EPUB bytes', () => {
    const trace = createReconstructionAttemptTrace(coreFixture())

    expect(validateReconstructionAttemptTrace(trace)).toEqual([])
    expect(trace.traceSha256).toBe(hashReconstructionAttemptTrace(trace))
    expect(JSON.parse(serializeReconstructionAttemptTrace(trace))).toEqual(trace)
    expect(verifyEpubArtifactBytes(trace.epub.bytes, epubBytes)).toBe(true)
    expect(
      verifyEpubArtifactBytes(
        trace.epub.bytes,
        new TextEncoder().encode('different epub'),
      ),
    ).toBe(false)
  })

  it('rejects hidden or noncanonical array properties and unsupported values', () => {
    const hidden = [1]
    Object.defineProperty(hidden, 'privateSource', { value: 'secret' })
    expect(() => canonicalTraceJson(hidden)).toThrow(/noncanonical/iu)

    const enumerable = [1] as number[] & { extra?: number }
    enumerable.extra = 2
    expect(() => canonicalTraceJson(enumerable)).toThrow(/noncanonical/iu)
    expect(() => canonicalTraceJson({ missing: undefined })).toThrow()
    expect(() => canonicalTraceJson(new Date())).toThrow()
  })

  it('rejects stale renderer, missing reconciliation, warnings, and bad locators', () => {
    const stale = coreFixture()
    stale.renderedEpub.epubSha256 = digest('stale-epub')
    expect(() => createReconstructionAttemptTrace(stale)).toThrow(
      /exact EPUB bytes/u,
    )

    const missing = coreFixture()
    missing.providerReceipts = missing.providerReceipts.filter(
      ({ role }) => role !== 'owner-local-codex-reconciliation',
    )
    expect(() => createReconstructionAttemptTrace(missing)).toThrow(
      /owner-local-codex-reconciliation/u,
    )

    const warning = coreFixture()
    warning.epub.epubCheck.warningCount = 1
    expect(() => createReconstructionAttemptTrace(warning)).toThrow(
      /Publication-ready/u,
    )

    const missingAnchor = coreFixture()
    missingAnchor.mappings[0]!.output[0]!.anchorId = 'not-rendered'
    expect(() => createReconstructionAttemptTrace(missingAnchor)).toThrow(
      /anchor/u,
    )
  })

  it('fails closed on uncalibrated judge input and unavailable reconciliation', () => {
    const judge = coreFixture()
    judge.comparator.judgeResults.push({ id: 'untrusted-judge' } as never)
    expect(() => createReconstructionAttemptTrace(judge)).toThrow()

    const unavailable = coreFixture()
    unavailable.providerReceipts.find(
      ({ role }) => role === 'owner-local-codex-reconciliation',
    )!.status = 'available'
    expect(() => createReconstructionAttemptTrace(unavailable)).toThrow(
      /reconciliation must succeed/iu,
    )
  })

  it('exports only opaque allowlisted non-promotion bindings', () => {
    const trace = createReconstructionAttemptTrace(coreFixture('failed'))
    const binding = toRefinementTraceBinding(trace)

    expect(Object.keys(binding).sort()).toEqual(
      [
        'attemptIndex',
        'canonicalStructSha256',
        'evidenceCandidateReferences',
        'firstCause',
        'parentTraceSha256',
        'policy',
        'sourceEvidenceGraphSha256',
        'sourcePdfSha256',
        'terminalStatus',
        'traceSha256',
        'usage',
      ].sort(),
    )
    expect(binding.firstCause?.failureReferenceSha256).toBe(
      hashTraceValue({
        kind: 'first-cause',
        failureId: trace.comparator.firstCauseFailureId!,
      }),
    )
    expect(JSON.stringify(binding)).not.toMatch(
      /failure-missing|providerReceipts|mappings|pageRenders|source-figure/u,
    )
  })

  it('validates private lineage and rejects hash tampering', () => {
    const trace = createReconstructionAttemptTrace(coreFixture())

    expect(validateReconstructionAttemptTraceLineage([trace])).toEqual([])
    expect(toRefinementTraceBinding(trace)).toMatchObject({
      traceSha256: trace.traceSha256,
      terminalStatus: 'publication-ready',
      firstCause: null,
      evidenceCandidateReferences: [digest('provider-neutral-candidate')],
    })
    expect(() =>
      toRefinementTraceBinding({ ...trace, attemptId: 'tampered' }),
    ).toThrow(/Trace hash/u)
  })

  it('rejects a child that shrinks the frozen source-obligation sets', () => {
    const parent = createReconstructionAttemptTrace(coreFixture('failed'))
    const child = createReconstructionAttemptTrace(childCoreFixture(parent))

    expect(validateReconstructionAttemptTraceLineage([parent, child])).toEqual(
      [],
    )

    const shrunkCore = childCoreFixture(parent)
    shrunkCore.comparisonEvidence.sourceRegions =
      shrunkCore.comparisonEvidence.sourceRegions.slice(0, 1)
    shrunkCore.mappings = shrunkCore.mappings.slice(0, 1)
    const obligationProjection = {
      sourcePdfSha256: shrunkCore.sourcePdf.artifact.sha256,
      obligationsSha256: hashTraceValue(
        shrunkCore.comparisonEvidence.sourceRegions,
      ),
      obligationCount: 1,
    }
    shrunkCore.sourceEvidence.sourceObligations = {
      obligationsSha256: obligationProjection.obligationsSha256,
      obligationCount: obligationProjection.obligationCount,
      receiptSha256: hashTraceValue(obligationProjection),
    }
    shrunkCore.sourceEvidence.expectedObservationSets =
      shrunkCore.sourceEvidence.expectedObservationSets.map((set) => {
        const projection = { ...set, sourceRegionIds: ['region-1'] }
        return {
          ...projection,
          receiptSha256: hashSourceExpectedObservationSet(projection),
        }
      })
    shrunkCore.sourceEvidence.receiptSha256 = hashSourceEvidenceReceipt({
      ...shrunkCore.sourceEvidence,
      receiptSha256: digest('pending-shrunk-source-evidence'),
    })
    shrunkCore.renderedEpub.sourceObligations = {
      ...obligationProjection,
      receiptSha256: hashTraceValue(obligationProjection),
    }
    shrunkCore.renderedEpub.receiptSha256 = hashRenderedEpubEvidence(
      shrunkCore.renderedEpub,
    )
    shrunkCore.comparisonEvidence.observations =
      shrunkCore.comparisonEvidence.observations.map((observation) =>
        createDeterministicObservationReceipt({
          idSha256: observation.idSha256,
          check: observation.check,
          source: observation.source,
          mappingIds: observation.mappingIds,
          expectedSetReceiptSha256:
            shrunkCore.sourceEvidence.expectedObservationSets.find(
              (set) => set.check === observation.check,
            )!.receiptSha256,
          actualSetReceiptSha256: observation.actualSetReceiptSha256,
        }),
      )
    shrunkCore.comparator = compareSourceToRenderedEpub({
      sourcePdfSha256: shrunkCore.sourcePdf.artifact.sha256,
      sourceEvidence: shrunkCore.sourceEvidence,
      structure: shrunkCore.structure,
      epub: shrunkCore.epub,
      renderedEpub: shrunkCore.renderedEpub,
      sourceRegions: shrunkCore.comparisonEvidence.sourceRegions,
      mappings: shrunkCore.mappings,
      observations: shrunkCore.comparisonEvidence.observations,
    })
    const sourceReceipt = shrunkCore.providerReceipts.find(
      ({ role }) => role === 'source-evidence',
    )!
    sourceReceipt.outputSha256 = shrunkCore.sourceEvidence.receiptSha256
    const renderReceipt = shrunkCore.providerReceipts.find(
      ({ role }) => role === 'actual-render',
    )!
    renderReceipt.outputSha256 = shrunkCore.renderedEpub.receiptSha256
    const reconciliation = shrunkCore.providerReceipts.find(
      ({ role }) => role === 'owner-local-codex-reconciliation',
    )!
    reconciliation.inputSha256 = hashTraceValue({
      sourcePdfSha256: shrunkCore.sourcePdf.artifact.sha256,
      evidenceGraphSha256: shrunkCore.evidenceGraph.artifact.sha256,
      candidateSetSha256: shrunkCore.sourceEvidence.candidateSetSha256,
      structSha256: shrunkCore.structure.artifact.sha256,
      epubSha256: shrunkCore.epub.bytes.sha256,
      renderObservationReceiptSha256: shrunkCore.renderedEpub.receiptSha256,
    })
    reconciliation.outputSha256 = hashTraceValue(shrunkCore.comparator)
    const shrunk = createReconstructionAttemptTrace(shrunkCore)

    expect(
      validateReconstructionAttemptTraceLineage([parent, shrunk]).some(
        ({ path }) => path.includes('evidenceGraph'),
      ),
    ).toBe(true)
  })

  it('rejects repair identity drift from the frozen reconciliation identity', () => {
    const parent = createReconstructionAttemptTrace(coreFixture('failed'))
    const child = childCoreFixture(parent)
    const repairReceipt = child.providerReceipts.find(
      ({ role }) => role === 'owner-local-codex-repair',
    )!
    repairReceipt.model = {
      ...repairReceipt.model!,
      version: '2026.08.02',
    }
    repairReceipt.identitySha256 = hashTraceValue({
      server: repairReceipt.server,
      model: repairReceipt.model,
      prompt: repairReceipt.prompt,
      tool: repairReceipt.tool,
    })

    expect(() => createReconstructionAttemptTrace(child)).toThrow(
      /driver-compatible Codex patch/iu,
    )
  })
})
