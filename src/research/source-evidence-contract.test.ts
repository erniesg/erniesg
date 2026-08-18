import { describe, expect, it } from 'vitest'
import { sha256HexSync } from './sha256-sync'
import {
  SOURCE_EPUB_OBSERVATION_CHECK_IDS,
  hashEpubBytes,
  hashRenderedActualObservationSet,
  hashRenderedEpubEvidence,
  hashTraceValue,
  parseCanonicalObservationPayloadBytes,
  sourceRegionObligationSchema,
} from './reconstruction-attempt-trace'
import {
  compareSourceToRenderedEpub,
  createDeterministicObservationReceipt,
} from './source-epub-comparator'
import {
  PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
  buildSourceEvidenceGraph,
  deterministicContextReceiptForBundle,
  type PdfEvidenceBundle,
  type SourceEvidenceGraphInput,
} from './source-evidence-graph'
import { createSourceEvidenceContract } from './source-evidence-contract'

const source = {
  documentId: 'ordinary-input',
  sha256: '1'.repeat(64),
  byteLength: 4_096,
  pageCount: 1,
}

function graphInput(): SourceEvidenceGraphInput {
  const box = {
    page: 1,
    x: 0.1,
    y: 0.1,
    width: 0.7,
    height: 0.1,
    rotation: 0,
    method: 'pdf-text' as const,
  }
  const bundles: PdfEvidenceBundle[] = [
      {
        schemaVersion: PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
        id: 'pdfjs-bundle',
        armId: 'deterministic',
        source,
        provider: {
          id: 'pdfjs-provider',
          kind: 'pdfjs',
          name: 'pdfjs-dist',
          version: '5.4.624',
        },
        pages: [{ page: 1, width: 612, height: 792, rotation: 0 }],
        artifacts: [
          {
            id: 'page-render',
            providerId: 'pdfjs-provider',
            kind: 'full-page-render',
            mediaType: 'image/png',
            sha256: '2'.repeat(64),
            byteLength: 128,
            page: 1,
            box: { ...box, x: 0, y: 0, width: 1, height: 1 },
            sourceIds: ['text-source'],
          },
        ],
        sources: [
          {
            id: 'text-source',
            providerId: 'pdfjs-provider',
            kind: 'text-run',
            page: 1,
            box,
            artifactIds: ['page-render'],
            payload: { text: 'Any incoming PDF text.' },
          },
          {
            id: 'page-geometry-source',
            providerId: 'pdfjs-provider',
            kind: 'page-geometry',
            page: 1,
            payload: { width: 612, height: 792, rotation: 0 },
          },
          {
            id: 'font-source',
            providerId: 'pdfjs-provider',
            kind: 'font',
            page: 1,
            payload: { family: 'Fixture Serif' },
          },
          {
            id: 'excluded-decoration-source',
            providerId: 'pdfjs-provider',
            kind: 'excluded-decoration',
            page: 1,
            box: { ...box, y: 0.95, height: 0.02 },
            payload: { text: 'Running footer' },
          },
        ],
        candidates: [
          {
            id: 'text-candidate',
            providerId: 'pdfjs-provider',
            kind: 'text-run',
            page: 1,
            boxes: [box],
            sourceIds: ['text-source'],
            artifactIds: ['page-render'],
            payload: { text: 'Any incoming PDF text.' },
          },
        ],
      },
      {
        schemaVersion: PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
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
            sha256: '5'.repeat(64),
            byteLength: 64,
            page: 1,
            box,
            sourceIds: ['mineru-source'],
          },
        ],
        sources: [
          {
            id: 'mineru-source',
            providerId: 'mineru-provider',
            kind: 'title',
            page: 1,
            box,
            artifactIds: ['mineru-artifact'],
            payload: { text: 'Any incoming PDF text.' },
          },
        ],
        candidates: [
          {
            id: 'mineru-candidate',
            providerId: 'mineru-provider',
            kind: 'title',
            page: 1,
            boxes: [box],
            sourceIds: ['mineru-source'],
            artifactIds: ['mineru-artifact'],
            payload: { text: 'Any incoming PDF text.', grounded: true },
          },
        ],
      },
    ]
  return {
    schemaVersion: SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
    source,
    deterministicContext: deterministicContextReceiptForBundle(bundles[0]!),
    arms: [
      {
        id: 'deterministic',
        requirement: 'required',
        status: 'enabled',
        frozen: true,
        providerId: 'pdfjs-provider',
      },
      {
        id: 'mineru',
        requirement: 'required',
        status: 'enabled',
        frozen: true,
        providerId: 'mineru-provider',
      },
    ],
    bundles,
    obligations: [
      {
        id: 'text-obligation',
        kind: 'text',
        page: 1,
        sourceIds: ['text-source', 'mineru-source'],
        artifactIds: ['page-render', 'mineru-artifact'],
        candidateIds: ['text-candidate', 'mineru-candidate'],
        observationCategories: [
          'text-exactness',
          'object-counts',
          'clipping',
          'overflow',
        ],
        required: true,
        semantic: true,
      },
      {
        id: 'page-geometry-context',
        kind: 'page-geometry',
        page: 1,
        sourceIds: ['page-geometry-source'],
        artifactIds: [],
        candidateIds: [],
        observationCategories: ['clipping', 'overflow'],
        required: true,
        semantic: false,
      },
      {
        id: 'font-context',
        kind: 'font-context',
        page: 1,
        sourceIds: ['font-source'],
        artifactIds: [],
        candidateIds: [],
        observationCategories: ['text-exactness'],
        required: true,
        semantic: false,
      },
      {
        id: 'excluded-decoration-context',
        kind: 'excluded-decoration',
        page: 1,
        sourceIds: ['excluded-decoration-source'],
        artifactIds: [],
        candidateIds: [],
        observationCategories: ['object-counts'],
        required: false,
        semantic: false,
      },
    ],
    disagreements: [],
  }
}

const verifierIdentity = {
  id: 'source-evidence-verifier',
  version: '1.0.0',
  configurationSha256: '3'.repeat(64),
  executableSha256: '4'.repeat(64),
}

describe('source evidence contract for #199', () => {
  it('commits all 19 source-derived expected sets and reopens exact graph bytes', () => {
    const graph = buildSourceEvidenceGraph(graphInput())
    const contract = createSourceEvidenceContract(graph, verifierIdentity)

    expect(contract.sourceEvidenceReceipt.expectedObservationSets).toHaveLength(
      19,
    )
    expect(
      contract.sourceEvidenceReceipt.expectedObservationSets.map(
        ({ check }) => check,
      ),
    ).toEqual(SOURCE_EPUB_OBSERVATION_CHECK_IDS)
    expect(
      contract.sourceEvidenceReceipt.expectedObservationSets.find(
        ({ check }) => check === 'text-exactness',
      )?.itemCount,
    ).toBe(1)
    expect(contract.sourceRegions).toEqual([
      expect.objectContaining({
        id: 'text-obligation',
        source: expect.objectContaining({
          page: 1,
          sourceRegionIds: ['text-obligation'],
        }),
      }),
    ])
    expect(
      contract.graph.bundles
        .flatMap(({ sources }) => sources)
        .filter(({ id }) =>
          [
            'page-geometry-source',
            'font-source',
            'excluded-decoration-source',
          ].includes(id),
        )
        .map(({ kind }) => kind)
        .sort(),
    ).toEqual(['excluded-decoration', 'font', 'page-geometry'])
    expect(
      contract.expectedObservationSets
        .flatMap(({ sourceRegionIds }) => sourceRegionIds)
        .every((id) => id === 'text-obligation'),
    ).toBe(true)
    expect(contract.evidenceCandidates).toEqual(
      contract.candidateReferences.map(
        ({ referenceSha256, bindingSha256 }) => ({
          referenceSha256,
          bindingSha256,
        }),
      ),
    )
    expect(contract.sourceEvidenceReceipt.candidateSetSha256).toBe(
      hashTraceValue(contract.evidenceCandidates),
    )
    expect(contract.sourceEvidenceReceipt.sourceObligations).toEqual({
      obligationsSha256: hashTraceValue(contract.sourceRegions),
      obligationCount: contract.sourceRegions.length,
      receiptSha256: hashTraceValue({
        sourcePdfSha256: graph.source.sha256,
        obligationsSha256: hashTraceValue(contract.sourceRegions),
        obligationCount: contract.sourceRegions.length,
      }),
    })
    const regionIds = new Set(
      contract.sourceRegions.map((region) => {
        expect(() => sourceRegionObligationSchema.parse(region)).not.toThrow()
        return region.id
      }),
    )
    for (const set of contract.expectedObservationSets) {
      for (const regionId of set.sourceRegionIds) {
        expect(regionIds.has(regionId)).toBe(true)
      }
    }
    expect(
      contract.sourceEvidenceReceipt.expectedObservationSets.find(
        ({ check }) => check === 'object-counts',
      )?.itemCount,
    ).toBe(1)

    const request = {
      schemaVersion: '1.0.0' as const,
      sourcePdfSha256: graph.source.sha256,
      evidenceGraph: contract.graphArtifact,
      sourceObligationsSha256:
        contract.sourceEvidenceReceipt.sourceObligations.obligationsSha256,
    }
    const receipt = contract.verifier.verifyExpected(request)
    expect(receipt).toMatchObject({
      status: 'succeeded',
      requestSha256: hashTraceValue(request),
      evidenceGraph: contract.graphArtifact,
    })
    const typed = receipt as ReturnType<
      typeof contract.verifier.verifyExpected
    > & {
      evidenceGraphBytes: Uint8Array
      expectedObservationSets: Array<{ payloadBytes: Uint8Array }>
    }
    expect(sha256HexSync(typed.evidenceGraphBytes)).toBe(graph.graphSha256)
    for (const [index, set] of typed.expectedObservationSets.entries()) {
      const payload = parseCanonicalObservationPayloadBytes(set.payloadBytes)
      expect(payload.check).toBe(SOURCE_EPUB_OBSERVATION_CHECK_IDS[index])
      if (payload.check === 'text-exactness') {
        expect(payload.items).toEqual([
          expect.objectContaining({
            anchorIds: ['mineru-source', 'text-source'],
          }),
        ])
      }
    }
  })

  it('authenticates context-only evidence without inventing output-region obligations', () => {
    const graph = buildSourceEvidenceGraph(graphInput())
    const contract = createSourceEvidenceContract(graph, verifierIdentity)

    expect(contract.graphArtifact.sha256).toBe(graph.graphSha256)
    expect(
      contract.graph.bundles
        .flatMap(({ sources }) => sources)
        .filter(({ id }) =>
          [
            'page-geometry-source',
            'font-source',
            'excluded-decoration-source',
          ].includes(id),
        )
        .map(({ kind }) => kind)
        .sort(),
    ).toEqual(['excluded-decoration', 'font', 'page-geometry'])
    expect(contract.sourceRegions.map(({ id }) => id)).toEqual([
      'text-obligation',
    ])
    expect(
      contract.expectedObservationSets
        .flatMap(({ sourceRegionIds }) => sourceRegionIds)
        .every((id) => id === 'text-obligation'),
    ).toBe(true)

    const alteredInput = graphInput()
    const deterministicBundle = alteredInput.bundles.find(
      ({ armId }) => armId === 'deterministic',
    )!
    deterministicBundle.sources.find(
      ({ id }) => id === 'font-source',
    )!.payload = { family: 'Changed fixture font' }
    alteredInput.deterministicContext =
      deterministicContextReceiptForBundle(deterministicBundle)
    expect(buildSourceEvidenceGraph(alteredInput).graphSha256).not.toBe(
      graph.graphSha256,
    )

    const noOutputObligation = graphInput()
    noOutputObligation.obligations.find(
      ({ id }) => id === 'text-obligation',
    )!.required = false
    expect(() =>
      createSourceEvidenceContract(
        buildSourceEvidenceGraph(noOutputObligation),
        verifierIdentity,
      ),
    ).toThrow('SOURCE_EVIDENCE_OBLIGATIONS_REQUIRED')
  })

  it('returns only a hash-bound source-backed candidate payload and rejects drift', () => {
    const graph = buildSourceEvidenceGraph(graphInput())
    const contract = createSourceEvidenceContract(graph, verifierIdentity)
    const reference = contract.candidateReferences[0]!
    const request = {
      schemaVersion: '1.0.0' as const,
      sourceEvidenceGraphSha256: graph.graphSha256,
      referenceSha256: reference.referenceSha256,
      bindingSha256: reference.bindingSha256,
    }
    const receipt = contract.verifier.resolveCandidate(request) as {
      status: string
      payload: { sha256: string; byteLength: number }
      payloadBytes: Uint8Array
    }
    expect(receipt.status).toBe('succeeded')
    expect(sha256HexSync(receipt.payloadBytes)).toBe(receipt.payload.sha256)
    expect(new TextDecoder().decode(receipt.payloadBytes)).toContain(
      'Any incoming PDF text.',
    )
    expect(() =>
      contract.verifier.resolveCandidate({
        ...request,
        bindingSha256: 'f'.repeat(64),
      }),
    ).toThrow(/SOURCE_EVIDENCE_CANDIDATE_REQUEST_MISMATCH/u)
  })

  it('feeds canonical #198 candidates and source regions into the exact #203 comparator', () => {
    const graph = buildSourceEvidenceGraph(graphInput())
    const contract = createSourceEvidenceContract(graph, verifierIdentity)
    const epubBytes = new TextEncoder().encode('exact synthetic EPUB bytes')
    const epubSha256 = hashEpubBytes(epubBytes)
    const structSha256 = sha256HexSync('exact synthetic STRUCT bytes')
    const viewport = { width: 800, height: 1_000, deviceScaleFactor: 1 }
    const actualObservationSets = contract.expectedObservationSets.map(
      ({ check, setSha256, itemCount, payload }) => {
        const projection = { check, setSha256, itemCount, payload }
        return {
          ...projection,
          receiptSha256: hashRenderedActualObservationSet({
            ...projection,
            receiptSha256: '0'.repeat(64),
          }),
        }
      },
    )
    const sourceObligations = {
      sourcePdfSha256: graph.source.sha256,
      ...contract.sourceEvidenceReceipt.sourceObligations,
    }
    const renderedEpub = {
      epubSha256,
      download: {
        artifact: { sha256: epubSha256, byteLength: epubBytes.byteLength },
        verificationReceiptSha256: sha256HexSync('download verification'),
      },
      sourceObligations,
      actualObservationSets,
      renderer: {
        id: 'fixture-renderer',
        version: '1.0.0',
        executableSha256: sha256HexSync('fixture renderer'),
        configurationSha256: sha256HexSync('fixture render configuration'),
      },
      domSnapshots: [
        {
          spineHref: 'EPUB/content.xhtml',
          dom: { sha256: sha256HexSync('fixture DOM'), byteLength: 11 },
          anchors: ['fixture-anchor'],
        },
      ],
      screenshots: [
        {
          id: 'fixture-screenshot',
          spineHref: 'EPUB/content.xhtml',
          domSha256: sha256HexSync('fixture DOM'),
          image: { sha256: sha256HexSync('fixture screenshot'), byteLength: 19 },
          mediaType: 'image/png' as const,
          width: viewport.width,
          height: viewport.height,
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
          anchorId: 'fixture-anchor',
          rendered: {
            screenshotId: 'fixture-screenshot',
            viewport,
            rect: { x: 10, y: 10 + index * 20, width: 100, height: 10 },
          },
        },
      ],
      status: 'mapped' as const,
    }))
    const observations = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map((check) =>
      createDeterministicObservationReceipt({
        idSha256: sha256HexSync(`observation-${check}`),
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
    const comparator = compareSourceToRenderedEpub({
      sourcePdfSha256: graph.source.sha256,
      sourceEvidence: contract.sourceEvidenceReceipt,
      structure: {
        schemaVersion: '0.2.0',
        documentId: graph.source.documentId,
        sourcePdfSha256: graph.source.sha256,
        artifact: { sha256: structSha256, byteLength: 128 },
        generatedSha256: sha256HexSync('generated STRUCT'),
        assets: [],
      },
      epub: {
        bytes: { sha256: epubSha256, byteLength: epubBytes.byteLength },
        mediaType: 'application/epub+zip',
        structSha256,
        epubCheck: {
          toolId: 'epubcheck',
          toolVersion: '5.3.0',
          reportSha256: sha256HexSync('EPUBCheck report'),
          status: 'passed',
          errorCount: 0,
          warningCount: 0,
        },
      },
      renderedEpub,
      sourceRegions: contract.sourceRegions,
      mappings,
      observations,
    })
    expect(comparator.status).toBe('publication-ready')
    expect(contract.sourceEvidenceReceipt.candidateSetSha256).toBe(
      hashTraceValue(contract.evidenceCandidates),
    )
  })
})
