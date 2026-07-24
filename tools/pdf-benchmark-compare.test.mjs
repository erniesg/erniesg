import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { comparePdfBenchmarkReports } from './pdf-benchmark-compare.mjs'
import {
  canonicalJsonHash,
  canonicalPassRate,
  createCorpusReport,
} from './pdf-corpus-audit-lib.mjs'

const policy = {
  minimumTextCoverage: 0.98,
  minimumAssetCoverage: 0.98,
  minimumRelationshipCoverage: 0.98,
  maximumUnresolvedObjects: 0,
  maximumOcrRequiredPages: 0,
  maximumReadingOrderDiagnostics: 0,
}

function document({
  basename = 'synthetic.pdf',
  hash = 'a'.repeat(64),
  byteLength = 4096,
  text = 1,
  assets = 1,
  relationships = 1,
  unresolved = 0,
  readingOrder = 0,
  ready = false,
  artifactHash = 'b'.repeat(64),
  structureHash = 'c'.repeat(64),
  blockingCodes = ready ? [] : ['INCOMPLETE_TEXT_COVERAGE'],
  ledgerAvailable = true,
  unresolvedJoins = 0,
  structurallyConsumedLineBoundaries = 0,
  duplicateCanonicalSpans = 0,
  missingSourceRegions = 0,
  unprovenancedRenderedUnits = 0,
  expectedInlineSpans = 1,
  mappedInlineSpans = 1,
  expectedHyperlinks = 1,
  mappedHyperlinks = 1,
} = {}) {
  const diagnostics = blockingCodes.map((code) => ({
    code,
    severity: 'error',
    message: `${code} blocks publication readiness.`,
  }))
  const diagnosticCounts = Object.fromEntries(
    blockingCodes.map((code) => [code, 1]),
  )
  const citationRelationshipGraph = [
    {
      id: '1'.repeat(64),
      status: 'matched',
      taxonomy: 'bracketed-bibliography-citation',
      referenceRegionId: '2'.repeat(64),
      referenceStart: 4,
      referenceEnd: 7,
      labels: ['3'.repeat(64)],
      targetNodeIds: ['4'.repeat(64)],
      canonicalAnchor: { nodeId: '5'.repeat(64), start: 4, end: 7 },
      sourceBoxes: [
        {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.1,
          height: 0.02,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
    },
  ]
  const crossReferenceRelationshipGraph = [
    {
      id: '6'.repeat(64),
      kind: 'figure',
      status: 'matched',
      textSha256: '7'.repeat(64),
      referenceRegionId: '8'.repeat(64),
      referenceStart: 8,
      referenceEnd: 23,
      labels: ['9'.repeat(64), 'a'.repeat(64)],
      targets: [
        {
          kind: 'figure',
          labelSha256: '9'.repeat(64),
          referenceStart: 16,
          referenceEnd: 17,
          status: 'matched',
          candidateNodeIds: ['b'.repeat(64)],
          targetNodeId: 'b'.repeat(64),
          evidenceSha256s: ['c'.repeat(64)],
        },
        {
          kind: 'figure',
          labelSha256: 'a'.repeat(64),
          referenceStart: 22,
          referenceEnd: 23,
          status: 'matched',
          candidateNodeIds: ['d'.repeat(64)],
          targetNodeId: 'd'.repeat(64),
          evidenceSha256s: ['c'.repeat(64)],
        },
      ],
      targetNodeIds: ['b'.repeat(64), 'd'.repeat(64)],
      canonicalAnchor: { nodeId: 'e'.repeat(64), start: 8, end: 23 },
      confidence: 0.99,
      evidenceSha256s: ['f'.repeat(64)],
      sourceBoxes: [
        {
          page: 1,
          x: 0.2,
          y: 0.3,
          width: 0.2,
          height: 0.02,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
    },
  ]
  return {
    basename,
    sha256: hash,
    byteLength,
    pageCount: 2,
    completeness: {
      sourceTextCharacters: 100,
      outputTextCharacters: Math.round(text * 100),
      matchedTextCharacters: Math.round(text * 100),
      textCoverage: text,
      missingSourceRegionCount: missingSourceRegions,
      unprovenancedRenderedUnitCount: unprovenancedRenderedUnits,
      expectedInlineSpanCount: expectedInlineSpans,
      mappedInlineSpanCount: mappedInlineSpans,
      inlineSpanCoverage:
        expectedInlineSpans === 0 ? 1 : mappedInlineSpans / expectedInlineSpans,
      expectedHyperlinkCount: expectedHyperlinks,
      mappedHyperlinkCount: mappedHyperlinks,
      hyperlinkCoverage:
        expectedHyperlinks === 0 ? 1 : mappedHyperlinks / expectedHyperlinks,
      duplicateCanonicalSpanCount: duplicateCanonicalSpans,
      lineBoundaryCount: ledgerAvailable ? 3 : 0,
      decidedLineBoundaryCount: ledgerAvailable ? 3 : 0,
      unresolvedCorruptingJoinCount: ledgerAvailable ? unresolvedJoins : 0,
      structurallyConsumedLineBoundaryCount: ledgerAvailable
        ? structurallyConsumedLineBoundaries
        : 0,
      sourceAssetCount: 10,
      exportedAssetCount: Math.round(assets * 10),
      assetCoverage: assets,
      expectedRelationshipCount: 10,
      resolvedRelationshipCount: Math.round(relationships * 10),
      relationshipCoverage: relationships,
      unresolvedObjectCount: unresolved,
      unresolvedObjects: {
        assets: unresolved,
        captions: 0,
        tables: 0,
        equations: 0,
        citations: 0,
        footnoteReferences: 0,
        footnotes: 0,
      },
      ocrRequiredPages: [],
      readingOrderDiagnostics: readingOrder,
      readingOrderEvaluation: {
        schemaVersion: '1.0.0',
        algorithm: 'deterministic-geometry-v1',
        mode: 'deterministic-only',
        regionCount: 4,
        acceptedEdgeCount: 3,
        unresolvedEdgeCount: readingOrder,
        cycleRate: 0,
        orderAccuracy: null,
        provider: null,
        modelVersion: null,
        latencyMs: 0,
        costUsd: 0,
        reviewRequired: readingOrder > 0,
      },
    },
    readiness: {
      status: ready ? 'ready' : 'review-required',
      ready,
      policy,
      blockingDiagnosticCodes: blockingCodes,
    },
    structure: {
      schemaVersion: '1.3.0',
      canonicalNodeCount: 4,
      canonicalNodeSequenceSha256: structureHash,
      canonicalNodeTypeSequenceSha256: structureHash,
      canonicalContentSha256: structureHash,
      canonicalNodeProvenanceSha256: structureHash,
      readingOrderGraphSha256: structureHash,
      nodeCounts: { caption: 1, figure: 1, heading: 1, paragraph: 1 },
      visualRelationshipCount: 1,
      visualRelationshipCounts: { 'figure:matched': 1 },
      visualRelationshipGraphSha256: structureHash,
      noteRelationshipCount: 0,
      noteRelationshipCounts: {},
      noteRelationshipGraphSha256: structureHash,
      citationRelationshipCount: 1,
      citationRelationshipCounts: { matched: 1 },
      citationRelationshipGraph: citationRelationshipGraph,
      citationRelationshipGraphSha256: canonicalJsonHash(
        citationRelationshipGraph,
      ),
      crossReferenceRelationshipCount: 1,
      crossReferenceRelationshipCounts: { 'figure:matched': 1 },
      crossReferenceRelationshipGraph,
      crossReferenceRelationshipGraphSha256: canonicalJsonHash(
        crossReferenceRelationshipGraph,
      ),
      assetCount: 1,
      assetCounts: { figure: 1 },
      assetManifestSha256: structureHash,
      lineTransitionLedgerAvailable: ledgerAvailable,
      lineTransitionCount: ledgerAvailable ? 3 : 0,
      lineTransitionLedgerSha256: ledgerAvailable ? structureHash : null,
      unresolvedCorruptingJoinCount: ledgerAvailable ? unresolvedJoins : null,
      structurallyConsumedLineBoundaryCount: ledgerAvailable
        ? structurallyConsumedLineBoundaries
        : null,
    },
    diagnosticCounts,
    diagnosticSampleLimit: { total: 64, perCode: 3 },
    diagnosticSamplesTruncated: 0,
    diagnostics,
    exports: [
      {
        target: 'paperPro',
        basename: `synthetic-paper-pro-${artifactHash.slice(0, 12)}${
          ready ? '' : '-readable'
        }.epub`,
        mode: ready ? 'publication' : 'readable-fallback',
        structuralValidation: 'passed',
        epubCheck: { status: 'skipped', reason: 'epubcheck-unavailable' },
        byteLength: 2048,
        sha256: artifactHash,
      },
    ],
  }
}

function report(documents) {
  const ready = documents.filter((document) => document.readiness?.ready).length
  const reviewRequired = documents.filter(
    (document) => document.readiness && !document.readiness.ready,
  ).length
  const failed = documents.filter((document) => !document.readiness).length
  return {
    schemaVersion: '1.5.0',
    reportSchema: 'docs/schemas/pdf-corpus-audit.schema.json',
    privacy: 'basenames-hashes-metrics-diagnostics-only',
    policy,
    summary: {
      documents: documents.length,
      ready,
      reviewRequired,
      failed,
      passRate: canonicalPassRate(ready, documents.length),
      failureReasons: {},
    },
    documents,
  }
}

function corpusContractBinding(salt = 'a') {
  const documents = Array.from({ length: 10 }, (_, index) => ({
    id: `paper-${index + 1}`,
    byteLength: 1000 + index,
    sha256: `${salt}${String(index).padStart(63, '0')}`,
  }))
  return {
    schemaVersion: '1.0.0',
    setKey: 'frozen',
    setId: `frozen-ten-${salt}`,
    contractSha256: salt.repeat(64),
    documentIdentitySha256: canonicalJsonHash(documents),
    documents,
  }
}

function reportForCorpusContract(binding, { failedIds = [] } = {}) {
  const failed = new Set(failedIds)
  const documents = binding.documents.map((source) =>
    failed.has(source.id)
      ? failedDocument(`${source.id}.pdf`)
      : document({
          basename: `${source.id}.pdf`,
          hash: source.sha256,
          byteLength: source.byteLength,
        }),
  )
  return {
    ...report(documents),
    corpusContract: binding,
  }
}

function failedDocument(basename = 'synthetic.pdf') {
  return {
    basename,
    sha256: null,
    code: 'PDF_PARSE_FAILED',
    message: 'The parser failed without exposing source details.',
  }
}

describe('deterministic PDF benchmark comparison', () => {
  it('round-trips the canonical five-decimal pass rate for one ready document out of three', () => {
    const corpus = createCorpusReport(
      [
        document({ hash: '1'.repeat(64), ready: true }),
        document({ hash: '2'.repeat(64) }),
        document({ hash: '3'.repeat(64) }),
      ],
      policy,
    )

    expect(corpus.summary.passRate).toBe(0.33333)
    expect(comparePdfBenchmarkReports(corpus, corpus).summary.passed).toBe(true)
  })

  it('rejects a noncanonical raw one-third pass-rate tamper', () => {
    const corpus = createCorpusReport(
      [
        document({ hash: '1'.repeat(64), ready: true }),
        document({ hash: '2'.repeat(64) }),
        document({ hash: '3'.repeat(64) }),
      ],
      policy,
    )
    const tampered = structuredClone(corpus)
    tampered.summary.passRate = 1 / 3

    expect(() => comparePdfBenchmarkReports(tampered, corpus)).toThrow(
      'INVALID_BENCHMARK_REPORT',
    )
  })

  it('accepts only the exact current corpus receipt schema', () => {
    const current = report([document()])
    const legacy = {
      ...current,
      schemaVersion: '1.2.0',
      documents: current.documents.map(
        ({
          diagnosticCounts: _diagnosticCounts,
          diagnosticSampleLimit: _diagnosticSampleLimit,
          diagnosticSamplesTruncated: _diagnosticSamplesTruncated,
          ...candidate
        }) => candidate,
      ),
    }

    const extraTopLevel = { ...current, privatePath: '/private/input.pdf' }
    const extraDocument = structuredClone(current)
    extraDocument.documents[0].sourceText = 'private source text'
    const invalidTarget = structuredClone(current)
    invalidTarget.documents[0].exports[0].target = 'arbitrary-device'
    const legacyStructure = structuredClone(current)
    legacyStructure.documents[0].structure.schemaVersion = '1.2.0'
    delete legacyStructure.documents[0].structure.canonicalNodeProvenanceSha256
    const leakingCountKey = structuredClone(current)
    leakingCountKey.documents[0].structure.nodeCounts[
      '/Users/alice/private-paper-title'
    ] = 1
    leakingCountKey.documents[0].structure.canonicalNodeCount += 1

    for (const invalid of [
      legacy,
      extraTopLevel,
      extraDocument,
      invalidTarget,
      legacyStructure,
      leakingCountKey,
    ]) {
      expect(() => comparePdfBenchmarkReports(invalid, current)).toThrow(
        'INVALID_BENCHMARK_REPORT',
      )
    }
  })

  it('carries an identical corpus-contract binding into frozen-set proof', () => {
    const binding = corpusContractBinding()
    const baseline = reportForCorpusContract(binding)
    const comparison = comparePdfBenchmarkReports(
      baseline,
      structuredClone(baseline),
    )

    expect(comparison.summary.passed).toBe(true)
    expect(comparison.corpusContract).toEqual(binding)
  })

  it('refuses one-sided, mismatched, or internally tampered corpus bindings', () => {
    const bound = reportForCorpusContract(corpusContractBinding())
    const unbound = structuredClone(bound)
    delete unbound.corpusContract
    const mismatched = reportForCorpusContract(corpusContractBinding('b'))
    const tampered = structuredClone(bound)
    tampered.corpusContract.documents.reverse()
    const nullBinding = { ...structuredClone(unbound), corpusContract: null }

    expect(() => comparePdfBenchmarkReports(bound, unbound)).toThrow(
      'PDF_CORPUS_CONTRACT_BINDING_MISMATCH',
    )
    expect(() => comparePdfBenchmarkReports(unbound, bound)).toThrow(
      'PDF_CORPUS_CONTRACT_BINDING_MISMATCH',
    )
    expect(() => comparePdfBenchmarkReports(bound, mismatched)).toThrow(
      'PDF_CORPUS_CONTRACT_BINDING_MISMATCH',
    )
    expect(() => comparePdfBenchmarkReports(tampered, tampered)).toThrow(
      'INVALID_BENCHMARK_REPORT',
    )
    expect(() => comparePdfBenchmarkReports(nullBinding, nullBinding)).toThrow(
      'INVALID_BENCHMARK_REPORT',
    )
  })

  it('rejects swapped or replaced basename identities in a bound report', () => {
    const valid = reportForCorpusContract(corpusContractBinding())
    const swapped = structuredClone(valid)
    ;[swapped.documents[0].basename, swapped.documents[1].basename] = [
      swapped.documents[1].basename,
      swapped.documents[0].basename,
    ]
    const replaced = structuredClone(valid)
    replaced.documents[0].basename = 'paper-1v2.pdf'

    for (const invalid of [swapped, replaced]) {
      expect(() => comparePdfBenchmarkReports(invalid, valid)).toThrow(
        'INVALID_BENCHMARK_REPORT',
      )
    }
  })

  it('rejects wrong audited hashes or byte lengths in a bound report', () => {
    const valid = reportForCorpusContract(corpusContractBinding())
    const wrongHash = structuredClone(valid)
    wrongHash.documents[0].sha256 = 'f'.repeat(64)
    const wrongLength = structuredClone(valid)
    wrongLength.documents[0].byteLength += 1

    for (const invalid of [wrongHash, wrongLength]) {
      expect(() => comparePdfBenchmarkReports(invalid, valid)).toThrow(
        'INVALID_BENCHMARK_REPORT',
      )
    }
  })

  it('rejects missing or extra rows in a bound report', () => {
    const binding = corpusContractBinding()
    const valid = reportForCorpusContract(binding)
    const missing = {
      ...report(valid.documents.slice(1)),
      corpusContract: binding,
    }
    const extraDocument = document({
      basename: 'paper-11.pdf',
      hash: 'f'.repeat(64),
      byteLength: 1011,
    })
    const extra = {
      ...report([...valid.documents, extraDocument]),
      corpusContract: binding,
    }

    for (const invalid of [missing, extra]) {
      expect(() => comparePdfBenchmarkReports(invalid, valid)).toThrow(
        'INVALID_BENCHMARK_REPORT',
      )
    }
  })

  it('accepts parser failures only when their basename identifies a bound document', () => {
    const binding = corpusContractBinding()
    const valid = reportForCorpusContract(binding, {
      failedIds: [binding.documents[0].id],
    })
    const wrongId = structuredClone(valid)
    wrongId.documents[0].basename = 'paper-1v2.pdf'

    expect(comparePdfBenchmarkReports(valid, valid).summary.passed).toBe(true)
    expect(() => comparePdfBenchmarkReports(wrongId, valid)).toThrow(
      'INVALID_BENCHMARK_REPORT',
    )
  })

  it('rejects unsafe, unhashed, or mode-inconsistent EPUB basenames', () => {
    const valid = report([document({ ready: true })])
    for (const basename of [
      'publication-paperpro.epub',
      '../synthetic-paper-pro-aaaaaaaaaaaa.epub',
      'synthetic-paper-pro-not-a-hash.epub',
      'synthetic-paper-pro-aaaaaaaaaaaa-readable.epub',
      'synthetic-title---paper-pro-aaaaaaaaaaaa.epub',
    ]) {
      const invalid = structuredClone(valid)
      invalid.documents[0].exports[0].basename = basename
      expect(() => comparePdfBenchmarkReports(invalid, valid)).toThrow(
        'INVALID_BENCHMARK_REPORT',
      )
    }
  })

  it('accepts a producer slug truncated on the final profile-boundary hyphen', () => {
    const valid = report([document()])
    valid.documents[0].exports[0].basename =
      'synthetic-truncated-title--paper-pro-bbbbbbbbbbbb-readable.epub'

    expect(
      comparePdfBenchmarkReports(valid, structuredClone(valid), {
        requireIdenticalArtifacts: true,
      }).summary.passed,
    ).toBe(true)
  })

  it('rejects schema 1.3 receipts that widen the bounded diagnostic sample contract', () => {
    const widened = report([document()])
    widened.documents[0].diagnosticSampleLimit.total = 65

    expect(() => comparePdfBenchmarkReports(widened, widened)).toThrow(
      'INVALID_BENCHMARK_REPORT',
    )

    const excessivePerCode = report([document()])
    excessivePerCode.documents[0].diagnosticCounts = { SOURCE_OK: 4 }
    excessivePerCode.documents[0].diagnostics = Array.from(
      { length: 4 },
      () => ({ code: 'SOURCE_OK', severity: 'info', message: 'Source ready.' }),
    )

    expect(() =>
      comparePdfBenchmarkReports(excessivePerCode, excessivePerCode),
    ).toThrow('INVALID_BENCHMARK_REPORT')
  })

  it('reports task-level improvements without requiring identical artifacts', () => {
    const comparison = comparePdfBenchmarkReports(
      report([
        document({
          text: 0.9,
          assets: 0.8,
          relationships: 0.7,
          unresolved: 3,
          readingOrder: 1,
        }),
      ]),
      report([
        document({
          text: 0.95,
          assets: 0.9,
          relationships: 0.8,
          unresolved: 2,
          readingOrder: 0,
          artifactHash: 'c'.repeat(64),
        }),
      ]),
    )

    expect(comparison.summary).toMatchObject({
      comparedDocuments: 1,
      improved: 1,
      regressed: 0,
      passed: true,
    })
    expect(comparison.documents[0].metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'textCoverage', change: 'improved' }),
        expect.objectContaining({
          key: 'unresolvedObjectCount',
          change: 'improved',
        }),
      ]),
    )
  })

  it('reports recovered hyperlink obligations and coverage as explicit metric deltas', () => {
    const comparison = comparePdfBenchmarkReports(
      report([
        document({
          expectedHyperlinks: 1,
          mappedHyperlinks: 0,
        }),
      ]),
      report([
        document({
          expectedHyperlinks: 2,
          mappedHyperlinks: 2,
        }),
      ]),
    )

    expect(comparison.documents[0].metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'expectedHyperlinkCount',
          baseline: 1,
          candidate: 2,
          delta: 1,
          change: 'improved',
        }),
        expect.objectContaining({
          key: 'mappedHyperlinkCount',
          baseline: 0,
          candidate: 2,
          delta: 2,
          change: 'improved',
        }),
        expect.objectContaining({
          key: 'hyperlinkCoverage',
          baseline: 0,
          candidate: 1,
          delta: 1,
          change: 'improved',
        }),
      ]),
    )
  })

  it('fails promotion on metric, readiness, artifact, or sample regressions', () => {
    const baseline = report([
      document({ ready: true }),
      document({ hash: 'd'.repeat(64) }),
    ])
    const candidate = report([
      {
        ...document({ text: 0.85, ready: false }),
        exports: [],
      },
    ])
    const comparison = comparePdfBenchmarkReports(baseline, candidate)

    expect(comparison.summary).toMatchObject({ regressed: 2, passed: false })
    expect(comparison.documents[0]).toMatchObject({ verdict: 'regressed' })
    expect(comparison.documents[1]).toMatchObject({
      verdict: 'regressed',
      reason: 'missing-candidate-document',
    })
  })

  it('gates duplicate canonical spans and unresolved corrupting joins directly', () => {
    const baseline = report([document({ ready: true })])
    const duplicate = report([
      document({
        ready: false,
        blockingCodes: ['DUPLICATE_CANONICAL_SPAN'],
        duplicateCanonicalSpans: 1,
      }),
    ])
    const unresolvedJoin = report([
      document({
        ready: false,
        blockingCodes: ['UNRESOLVED_CORRUPTING_JOIN'],
        unresolvedJoins: 1,
      }),
    ])

    for (const candidate of [duplicate, unresolvedJoin]) {
      const comparison = comparePdfBenchmarkReports(baseline, candidate)
      expect(comparison.summary.passed).toBe(false)
      expect(comparison.documents[0].metrics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ change: 'regressed' }),
        ]),
      )
    }
  })

  it('gates missing source provenance and incomplete inline semantic mapping', () => {
    const baseline = report([document({ ready: true })])
    const candidates = [
      report([
        document({
          ready: false,
          blockingCodes: ['MISSING_SOURCE_REGION'],
          missingSourceRegions: 1,
        }),
      ]),
      report([
        document({
          ready: false,
          blockingCodes: ['UNPROVENANCED_RENDERED_UNIT'],
          unprovenancedRenderedUnits: 1,
        }),
      ]),
      report([
        document({
          ready: false,
          blockingCodes: ['INCOMPLETE_INLINE_STYLE_COVERAGE'],
          expectedInlineSpans: 2,
          mappedInlineSpans: 1,
        }),
      ]),
    ]

    for (const candidate of candidates) {
      const comparison = comparePdfBenchmarkReports(baseline, candidate)
      expect(comparison.summary.passed).toBe(false)
      expect(comparison.documents[0].metrics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ change: 'regressed' }),
        ]),
      )
    }
  })

  it('keeps a fully mapped inline denominator collapse fail-closed', () => {
    const comparison = comparePdfBenchmarkReports(
      report([
        document({
          expectedInlineSpans: 2,
          mappedInlineSpans: 2,
        }),
      ]),
      report([
        document({
          expectedInlineSpans: 1,
          mappedInlineSpans: 1,
        }),
      ]),
    )

    expect(comparison.summary).toMatchObject({
      regressed: 1,
      passed: false,
    })
    expect(comparison.documents[0].metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'expectedInlineSpanCount',
          change: 'regressed',
        }),
        expect.objectContaining({
          key: 'mappedInlineSpanCount',
          change: 'regressed',
        }),
        expect.objectContaining({
          key: 'inlineSpanCoverage',
          change: 'unchanged',
        }),
      ]),
    )
  })

  it('gates failed EPUBCheck and permits only explicitly allowlisted skips', () => {
    const baseline = report([document({ ready: true })])
    const failedCheck = structuredClone(baseline)
    failedCheck.documents[0].exports[0].epubCheck = { status: 'failed' }
    const passedToSkipped = structuredClone(baseline)
    baseline.documents[0].exports[0].epubCheck = { status: 'passed' }
    const publicationToFallback = structuredClone(baseline)
    publicationToFallback.documents[0].exports[0].mode = 'readable-fallback'
    publicationToFallback.documents[0].exports[0].basename =
      publicationToFallback.documents[0].exports[0].basename.replace(
        /\.epub$/u,
        '-readable.epub',
      )

    const failed = comparePdfBenchmarkReports(baseline, failedCheck)
    const skipped = comparePdfBenchmarkReports(baseline, passedToSkipped)
    const fallback = comparePdfBenchmarkReports(baseline, publicationToFallback)

    expect(failed.summary.passed).toBe(false)
    expect(failed.documents[0].artifacts.invalid).toBe(true)
    expect(skipped.summary.passed).toBe(false)
    expect(skipped.documents[0].artifacts.invalid).toBe(true)
    expect(fallback.summary.passed).toBe(false)
    expect(fallback.documents[0].artifacts.invalid).toBe(true)

    for (const epubCheck of [
      { status: 'skipped' },
      { status: 'skipped', reason: 'operator-choice' },
      { status: 'passed', reason: 'epubcheck-unavailable' },
    ]) {
      const malformed = report([document()])
      malformed.documents[0].exports[0].epubCheck = epubCheck
      expect(() => comparePdfBenchmarkReports(malformed, malformed)).toThrow(
        'INVALID_BENCHMARK_REPORT',
      )
    }
  })

  it('gates failed EPUBCheck on candidate-only documents', () => {
    const baseline = report([document({ ready: true })])
    const added = document({ hash: 'd'.repeat(64), ready: true })
    added.basename = 'added.pdf'
    added.exports[0].epubCheck = { status: 'failed' }
    const candidate = report([structuredClone(baseline.documents[0]), added])

    const comparison = comparePdfBenchmarkReports(baseline, candidate)

    expect(comparison.summary.added).toBe(1)
    expect(comparison.summary.failedEpubChecks).toBe(1)
    expect(comparison.summary.passed).toBe(false)
  })

  it('fails promotion when a candidate-only document failed or still requires review', () => {
    const baseline = report([document({ ready: true })])
    const reviewRequired = document({ hash: 'd'.repeat(64) })
    reviewRequired.basename = 'review-required.pdf'

    for (const added of [failedDocument('failed.pdf'), reviewRequired]) {
      const comparison = comparePdfBenchmarkReports(
        baseline,
        report([structuredClone(baseline.documents[0]), added]),
      )

      expect(comparison.summary.added).toBe(1)
      expect(comparison.summary.passed).toBe(false)
      expect(comparison.addedDocuments[0]).toMatchObject({
        basename: added.basename,
        status: added.readiness ? 'review-required' : 'failed',
        passed: false,
      })
    }
  })

  it('requires candidate-only ready documents to include every checked baseline artifact target', () => {
    const baseline = report([document({ ready: true })])
    const addedWithoutArtifacts = document({
      hash: 'd'.repeat(64),
      ready: true,
    })
    addedWithoutArtifacts.basename = 'added.pdf'
    addedWithoutArtifacts.exports = []
    const missing = comparePdfBenchmarkReports(
      baseline,
      report([structuredClone(baseline.documents[0]), addedWithoutArtifacts]),
    )

    expect(missing.summary.passed).toBe(false)
    expect(missing.addedDocuments[0]).toMatchObject({
      status: 'ready',
      passed: false,
      artifacts: {
        expectedTargets: ['paperPro'],
        missingTargets: ['paperPro'],
        invalid: false,
      },
    })

    const addedWithArtifacts = document({
      hash: 'd'.repeat(64),
      ready: true,
    })
    addedWithArtifacts.basename = 'added.pdf'
    const complete = comparePdfBenchmarkReports(
      baseline,
      report([structuredClone(baseline.documents[0]), addedWithArtifacts]),
    )

    expect(complete.summary.passed).toBe(true)
    expect(complete.addedDocuments[0]).toMatchObject({
      status: 'ready',
      passed: true,
      artifacts: {
        expectedTargets: ['paperPro'],
        missingTargets: [],
        invalid: false,
      },
    })
  })

  it('rejects readable fallback artifacts for candidate-only ready documents', () => {
    const baseline = report([document({ ready: true })])
    const added = document({ hash: 'd'.repeat(64), ready: true })
    added.basename = 'added.pdf'
    added.exports[0].mode = 'readable-fallback'
    added.exports[0].basename = added.exports[0].basename.replace(
      /\.epub$/u,
      '-readable.epub',
    )

    const comparison = comparePdfBenchmarkReports(
      baseline,
      report([structuredClone(baseline.documents[0]), added]),
    )

    expect(comparison.summary.passed).toBe(false)
    expect(comparison.addedDocuments[0].artifacts.invalid).toBe(true)
  })

  it('requires candidate-only artifacts to preserve a baseline EPUBCheck pass', () => {
    const baselineDocument = document({ ready: true })
    baselineDocument.exports[0].epubCheck = { status: 'passed' }
    const baseline = report([baselineDocument])
    const added = document({ hash: 'd'.repeat(64), ready: true })
    added.basename = 'added.pdf'

    const comparison = comparePdfBenchmarkReports(
      baseline,
      report([structuredClone(baselineDocument), added]),
    )

    expect(comparison.summary.passed).toBe(false)
    expect(comparison.addedDocuments[0].artifacts.invalid).toBe(true)
  })

  it('does not expose mutable references to internal comparison policy', () => {
    const valid = report([document()])
    const first = comparePdfBenchmarkReports(valid, valid)
    first.policy.epubCheck.skipped.allowedReasons.push('operator-choice')
    first.policy.metrics.push({
      key: 'privateMetric',
      direction: 'higher',
      tolerance: 0,
    })

    const invalidSkip = report([document()])
    invalidSkip.documents[0].exports[0].epubCheck = {
      status: 'skipped',
      reason: 'operator-choice',
    }
    expect(() => comparePdfBenchmarkReports(invalidSkip, invalidSkip)).toThrow(
      'INVALID_BENCHMARK_REPORT',
    )
    expect(() =>
      comparePdfBenchmarkReports(valid, valid, {
        tolerances: { privateMetric: 0 },
      }),
    ).toThrow('INVALID_TOLERANCE')
  })

  it('fails on increases in each diagnostic code instead of sampled messages', () => {
    const baselineDocument = document({ ready: true })
    baselineDocument.diagnosticCounts = { LAYOUT_WARNING: 1 }
    baselineDocument.diagnostics = [
      {
        code: 'LAYOUT_WARNING',
        severity: 'warning',
        message: 'Bounded sanitized diagnostic.',
      },
    ]
    const candidateDocument = structuredClone(baselineDocument)
    candidateDocument.diagnosticCounts = {
      LAYOUT_WARNING: 2,
      NEW_WARNING: 1,
    }
    candidateDocument.diagnostics = [
      ...baselineDocument.diagnostics,
      {
        code: 'LAYOUT_WARNING',
        severity: 'warning',
        message: 'Second bounded sanitized diagnostic.',
      },
      {
        code: 'NEW_WARNING',
        severity: 'warning',
        message: 'New bounded sanitized diagnostic.',
      },
    ]

    const comparison = comparePdfBenchmarkReports(
      report([baselineDocument]),
      report([candidateDocument]),
    )

    expect(comparison.summary.passed).toBe(false)
    expect(comparison.documents[0].diagnostics).toEqual({
      available: true,
      regressed: true,
      changes: [
        {
          code: 'LAYOUT_WARNING',
          baseline: 1,
          candidate: 2,
          delta: 1,
          change: 'regressed',
        },
        {
          code: 'NEW_WARNING',
          baseline: 0,
          candidate: 1,
          delta: 1,
          change: 'regressed',
        },
      ],
    })
  })

  it('emits only the comparison allowlist and suppresses artifact basenames and messages', () => {
    const baselineDocument = document({ ready: true })
    baselineDocument.diagnosticCounts = { SAFE_CODE: 1 }
    baselineDocument.diagnostics = [
      {
        code: 'SAFE_CODE',
        severity: 'warning',
        message: 'Private diagnostic detail must not be copied.',
      },
    ]
    const comparison = comparePdfBenchmarkReports(
      report([baselineDocument]),
      report([structuredClone(baselineDocument)]),
    )
    const serialized = JSON.stringify(comparison)

    expect(Object.keys(comparison).sort()).toEqual(
      [
        'schemaVersion',
        'privacy',
        'policy',
        'summary',
        'documents',
        'addedDocuments',
      ].sort(),
    )
    expect(serialized).not.toContain(
      'synthetic-paper-pro-bbbbbbbbbbbb-readable.epub',
    )
    expect(serialized).not.toContain('Private diagnostic detail')
  })

  it('supports explicit tolerances and same-engine determinism checks', () => {
    const baseline = report([document({ text: 0.9 })])
    const candidate = report([
      document({ text: 0.89, artifactHash: 'c'.repeat(64) }),
    ])
    const tolerated = comparePdfBenchmarkReports(baseline, candidate, {
      tolerances: { textCoverage: 0.011 },
    })
    const deterministic = comparePdfBenchmarkReports(baseline, candidate, {
      tolerances: { textCoverage: 0.011 },
      requireIdenticalArtifacts: true,
    })

    expect(tolerated.summary.passed).toBe(true)
    expect(deterministic.summary.passed).toBe(false)
    expect(deterministic.documents[0].artifacts.nondeterministic).toBe(true)
  })

  it('rejects weakened audit policy as a promotion comparison', () => {
    const baseline = report([document({ ready: true })])
    const candidate = structuredClone(baseline)
    candidate.policy.minimumTextCoverage = 0.5
    candidate.documents[0].readiness.policy.minimumTextCoverage = 0.5

    const comparison = comparePdfBenchmarkReports(baseline, candidate)

    expect(comparison.policy.auditPolicy.identical).toBe(false)
    expect(comparison.summary.passed).toBe(false)
  })

  it('fails strict repeatability when canonical structure changes', () => {
    const baseline = report([document()])
    const changed = report([
      document({ artifactHash: 'b'.repeat(64), structureHash: 'd'.repeat(64) }),
    ])
    const changedComparison = comparePdfBenchmarkReports(baseline, changed, {
      requireIdenticalStructure: true,
    })

    expect(changedComparison.summary.passed).toBe(false)
    expect(changedComparison.documents[0].structure).toMatchObject({
      available: true,
      identical: false,
      nondeterministic: true,
    })
  })

  it('fails strict repeatability when only a citation anchor or target changes', () => {
    const baseline = report([document()])
    for (const mutate of [
      (graph) => {
        graph[0].canonicalAnchor.nodeId = '6'.repeat(64)
      },
      (graph) => {
        graph[0].targetNodeIds = ['7'.repeat(64)]
      },
    ]) {
      const candidate = structuredClone(baseline)
      const graph = candidate.documents[0].structure.citationRelationshipGraph
      mutate(graph)
      candidate.documents[0].structure.citationRelationshipGraphSha256 =
        canonicalJsonHash(graph)

      const comparison = comparePdfBenchmarkReports(baseline, candidate, {
        requireIdenticalStructure: true,
      })
      expect(comparison.summary.passed).toBe(false)
      expect(comparison.documents[0].structure).toMatchObject({
        identical: false,
        nondeterministic: true,
      })
    }
  })

  it('fails strict repeatability when only a scholarly cross-reference anchor or target changes', () => {
    const baseline = report([document()])
    for (const mutate of [
      (graph) => {
        graph[0].canonicalAnchor.nodeId = '0'.repeat(64)
      },
      (graph) => {
        graph[0].targets[0].candidateNodeIds = ['1'.repeat(64)]
        graph[0].targets[0].targetNodeId = '1'.repeat(64)
        graph[0].targetNodeIds = ['1'.repeat(64), 'd'.repeat(64)]
      },
    ]) {
      const candidate = structuredClone(baseline)
      const graph =
        candidate.documents[0].structure.crossReferenceRelationshipGraph
      mutate(graph)
      candidate.documents[0].structure.crossReferenceRelationshipGraphSha256 =
        canonicalJsonHash(graph)

      const comparison = comparePdfBenchmarkReports(baseline, candidate, {
        requireIdenticalStructure: true,
      })
      expect(comparison.summary.passed).toBe(false)
      expect(comparison.documents[0].structure).toMatchObject({
        identical: false,
        nondeterministic: true,
      })
    }
  })

  it('accepts author-year citation relationships in benchmark evidence', () => {
    const baseline = report([document()])
    const graph = baseline.documents[0].structure.citationRelationshipGraph
    graph[0].taxonomy = 'author-year-bibliography-citation'
    baseline.documents[0].structure.citationRelationshipGraphSha256 =
      canonicalJsonHash(graph)

    expect(() =>
      comparePdfBenchmarkReports(baseline, structuredClone(baseline)),
    ).not.toThrow()
  })

  it('rejects missing, malformed, stale, or inconsistent citation graph evidence', () => {
    const baseline = report([document()])
    const missing = structuredClone(baseline)
    delete missing.documents[0].structure.citationRelationshipGraph
    const malformed = structuredClone(baseline)
    malformed.documents[0].structure.citationRelationshipGraph[0].canonicalAnchor =
      { nodeId: '', start: 7, end: 4 }
    const staleHash = structuredClone(baseline)
    staleHash.documents[0].structure.citationRelationshipGraphSha256 =
      'f'.repeat(64)
    const inconsistentCount = structuredClone(baseline)
    inconsistentCount.documents[0].structure.citationRelationshipCount = 2

    for (const invalid of [missing, malformed, staleHash, inconsistentCount]) {
      expect(() => comparePdfBenchmarkReports(invalid, baseline)).toThrow(
        'INVALID_BENCHMARK_REPORT',
      )
    }
  })

  it('rejects missing, malformed, stale, or inconsistent scholarly cross-reference graph evidence', () => {
    const baseline = report([document()])
    const missing = structuredClone(baseline)
    delete missing.documents[0].structure.crossReferenceRelationshipGraph
    const malformed = structuredClone(baseline)
    malformed.documents[0].structure.crossReferenceRelationshipGraph[0].targets[0] =
      {
        ...malformed.documents[0].structure.crossReferenceRelationshipGraph[0]
          .targets[0],
        status: 'ambiguous',
        targetNodeId: 'b'.repeat(64),
      }
    malformed.documents[0].structure.crossReferenceRelationshipGraphSha256 =
      canonicalJsonHash(
        malformed.documents[0].structure.crossReferenceRelationshipGraph,
      )
    const staleHash = structuredClone(baseline)
    staleHash.documents[0].structure.crossReferenceRelationshipGraphSha256 =
      '0'.repeat(64)
    const inconsistentCount = structuredClone(baseline)
    inconsistentCount.documents[0].structure.crossReferenceRelationshipCount = 2

    for (const invalid of [missing, malformed, staleHash, inconsistentCount]) {
      expect(() => comparePdfBenchmarkReports(invalid, baseline)).toThrow(
        'INVALID_BENCHMARK_REPORT',
      )
    }
  })

  it('accepts exact shared spans for compressed multi-target references but rejects partial overlap', () => {
    const sharedSpan = report([document()])
    const sharedGraph =
      sharedSpan.documents[0].structure.crossReferenceRelationshipGraph
    sharedGraph[0].targets[1].referenceStart =
      sharedGraph[0].targets[0].referenceStart
    sharedGraph[0].targets[1].referenceEnd =
      sharedGraph[0].targets[0].referenceEnd
    sharedSpan.documents[0].structure.crossReferenceRelationshipGraphSha256 =
      canonicalJsonHash(sharedGraph)

    expect(
      comparePdfBenchmarkReports(sharedSpan, structuredClone(sharedSpan), {
        requireIdenticalStructure: true,
      }).summary.passed,
    ).toBe(true)

    const partialOverlap = structuredClone(sharedSpan)
    const partialGraph =
      partialOverlap.documents[0].structure.crossReferenceRelationshipGraph
    partialGraph[0].targets[1].referenceEnd += 1
    partialOverlap.documents[0].structure.crossReferenceRelationshipGraphSha256 =
      canonicalJsonHash(partialGraph)

    expect(() =>
      comparePdfBenchmarkReports(partialOverlap, partialOverlap, {
        requireIdenticalStructure: true,
      }),
    ).toThrow('INVALID_BENCHMARK_REPORT')
  })

  it('requires a valid transition ledger in strict mode without generically requiring zero unresolved joins', () => {
    const absent = report([document({ ledgerAvailable: false })])
    const repeatedUnresolved = report([document({ unresolvedJoins: 1 })])

    const missingLedger = comparePdfBenchmarkReports(absent, absent, {
      requireIdenticalStructure: true,
    })
    const deterministicReviewState = comparePdfBenchmarkReports(
      repeatedUnresolved,
      repeatedUnresolved,
      { requireIdenticalStructure: true },
    )

    expect(missingLedger.summary.passed).toBe(false)
    expect(missingLedger.documents[0].structure.ledger).toEqual({
      baseline: { available: false, valid: false },
      candidate: { available: false, valid: false },
    })
    expect(deterministicReviewState.summary.passed).toBe(true)
  })

  it('requires an exact non-negative structurally consumed line-boundary count', () => {
    const valid = report([document()])
    const missing = structuredClone(valid)
    delete missing.documents[0].completeness
      .structurallyConsumedLineBoundaryCount
    const negative = structuredClone(valid)
    negative.documents[0].completeness.structurallyConsumedLineBoundaryCount =
      -1
    const fractional = structuredClone(valid)
    fractional.documents[0].completeness.structurallyConsumedLineBoundaryCount = 0.5
    const missingStructure = structuredClone(valid)
    delete missingStructure.documents[0].structure
      .structurallyConsumedLineBoundaryCount
    const negativeStructure = structuredClone(valid)
    negativeStructure.documents[0].structure.structurallyConsumedLineBoundaryCount =
      -1
    const mismatch = structuredClone(valid)
    mismatch.documents[0].structure.structurallyConsumedLineBoundaryCount = 1

    for (const invalid of [
      missing,
      negative,
      fractional,
      missingStructure,
      negativeStructure,
      mismatch,
    ]) {
      expect(() => comparePdfBenchmarkReports(invalid, valid)).toThrow(
        'INVALID_BENCHMARK_REPORT',
      )
    }
  })

  it('rejects line-boundary receipts whose unresolved and structural decisions exceed decided transitions', () => {
    const invalid = report([
      document({
        unresolvedJoins: 1,
        structurallyConsumedLineBoundaries: 3,
      }),
    ])

    expect(() => comparePdfBenchmarkReports(invalid, invalid)).toThrow(
      'INVALID_BENCHMARK_REPORT',
    )
  })

  it('keeps structurally consumed line boundaries neutral in directional comparisons', () => {
    const baseline = report([
      document({ structurallyConsumedLineBoundaries: 0 }),
    ])
    const candidate = report([
      document({ structurallyConsumedLineBoundaries: 2 }),
    ])

    const comparison = comparePdfBenchmarkReports(baseline, candidate)

    expect(comparison.schemaVersion).toBe('1.5.0')
    expect(comparison.summary).toMatchObject({
      unchanged: 1,
      improved: 0,
      regressed: 0,
      passed: true,
    })
    expect(comparison.documents[0]).toMatchObject({ verdict: 'unchanged' })
    expect(comparison.documents[0].metrics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'structurallyConsumedLineBoundaryCount',
        }),
      ]),
    )
  })

  it('fails audited-to-failed transitions and newly added blockers', () => {
    const baseline = report([
      document({ blockingCodes: ['INCOMPLETE_TEXT_COVERAGE'] }),
    ])
    const failed = comparePdfBenchmarkReports(
      baseline,
      report([failedDocument()]),
    )
    const newBlocker = comparePdfBenchmarkReports(
      baseline,
      report([
        document({
          blockingCodes: [
            'INCOMPLETE_TEXT_COVERAGE',
            'UNRESOLVED_SEMANTIC_OBJECTS',
          ],
        }),
      ]),
    )

    expect(failed.summary.passed).toBe(false)
    expect(failed.documents[0].status.candidate).toBe('failed')
    expect(newBlocker.summary.passed).toBe(false)
    expect(newBlocker.documents[0].blockingDiagnostics.added).toEqual([
      'UNRESOLVED_SEMANTIC_OBJECTS',
    ])
  })

  it('keeps informational diagnostic volume neutral without weakening error-count regressions', () => {
    const baselineInfo = document({ ready: true })
    baselineInfo.diagnosticCounts = { RESOLVED_READING_ORDER: 2 }
    baselineInfo.diagnosticSamplesTruncated = 1
    baselineInfo.diagnostics = [
      {
        code: 'RESOLVED_READING_ORDER',
        severity: 'info',
        page: 1,
        message:
          'A reading-order region was resolved from deterministic geometry.',
      },
    ]
    const candidateInfo = structuredClone(baselineInfo)
    candidateInfo.diagnosticCounts.RESOLVED_READING_ORDER = 3
    candidateInfo.diagnosticSamplesTruncated = 2

    const informational = comparePdfBenchmarkReports(
      report([baselineInfo]),
      report([candidateInfo]),
    )

    expect(informational.summary).toMatchObject({
      unchanged: 1,
      improved: 0,
      regressed: 0,
      passed: true,
    })
    expect(informational.documents[0].diagnostics).toMatchObject({
      regressed: false,
      changes: [
        {
          code: 'RESOLVED_READING_ORDER',
          baseline: 2,
          candidate: 3,
          delta: 1,
          change: 'unchanged',
        },
      ],
    })

    const baselineError = document({
      blockingCodes: ['LOW_CONFIDENCE_OCR'],
    })
    baselineError.diagnosticCounts = { LOW_CONFIDENCE_OCR: 1 }
    baselineError.diagnostics = [
      {
        code: 'LOW_CONFIDENCE_OCR',
        severity: 'error',
        page: 1,
        message:
          'The audit produced a diagnostic whose document details were suppressed.',
      },
    ]
    const candidateError = structuredClone(baselineError)
    candidateError.diagnosticCounts.LOW_CONFIDENCE_OCR = 2
    candidateError.diagnosticSamplesTruncated = 1

    const errorIncrease = comparePdfBenchmarkReports(
      report([baselineError]),
      report([candidateError]),
    )

    expect(errorIncrease.summary).toMatchObject({
      regressed: 1,
      passed: false,
    })
    expect(errorIncrease.documents[0].diagnostics.regressed).toBe(true)
  })

  it('rejects non-finite tolerances, missing required data, and duplicate documents or targets', () => {
    const valid = report([document()])
    const duplicateDocument = report([document(), document()])
    const duplicateTargetDocument = document()
    duplicateTargetDocument.exports.push({
      ...duplicateTargetDocument.exports[0],
    })
    const missingMetricDocument = document()
    delete missingMetricDocument.completeness.textCoverage
    const invalidInlineCoverageDocument = document()
    invalidInlineCoverageDocument.completeness.inlineSpanCoverage = 0.5

    expect(() =>
      comparePdfBenchmarkReports(valid, valid, {
        tolerances: { textCoverage: Number.POSITIVE_INFINITY },
      }),
    ).toThrow('INVALID_TOLERANCE')
    expect(() =>
      comparePdfBenchmarkReports(valid, report([missingMetricDocument])),
    ).toThrow('INVALID_BENCHMARK_REPORT')
    expect(() =>
      comparePdfBenchmarkReports(
        valid,
        report([invalidInlineCoverageDocument]),
      ),
    ).toThrow('INVALID_BENCHMARK_REPORT')
    expect(() => comparePdfBenchmarkReports(duplicateDocument, valid)).toThrow(
      'INVALID_BENCHMARK_REPORT',
    )
    expect(() =>
      comparePdfBenchmarkReports(valid, report([duplicateTargetDocument])),
    ).toThrow('INVALID_BENCHMARK_REPORT')
  })

  it('rejects missing or arithmetically inconsistent completeness evidence', () => {
    const invalidDocuments = [
      (() => {
        const candidate = document()
        delete candidate.completeness.expectedHyperlinkCount
        return candidate
      })(),
      (() => {
        const candidate = document()
        candidate.completeness.textCoverage = 0.5
        return candidate
      })(),
      (() => {
        const candidate = document()
        candidate.completeness.assetCoverage = 0.5
        return candidate
      })(),
      (() => {
        const candidate = document()
        candidate.completeness.relationshipCoverage = 0.5
        return candidate
      })(),
      (() => {
        const candidate = document()
        candidate.completeness.hyperlinkCoverage = 0.5
        return candidate
      })(),
      (() => {
        const candidate = document()
        candidate.completeness.mappedHyperlinkCount = 2
        return candidate
      })(),
      (() => {
        const candidate = document()
        candidate.completeness.matchedTextCharacters = 101
        return candidate
      })(),
      (() => {
        const candidate = document()
        candidate.completeness.exportedAssetCount = 11
        return candidate
      })(),
      (() => {
        const candidate = document()
        candidate.completeness.resolvedRelationshipCount = 11
        return candidate
      })(),
      (() => {
        const candidate = document()
        candidate.completeness.decidedLineBoundaryCount = 4
        return candidate
      })(),
    ]

    for (const candidate of invalidDocuments) {
      expect(() =>
        comparePdfBenchmarkReports(report([candidate]), report([candidate])),
      ).toThrow('INVALID_BENCHMARK_REPORT')
    }
  })

  it('rejects readiness claims that contradict policy, completeness, diagnostics, or blockers', () => {
    const invalidDocuments = [
      (() => {
        const candidate = document({ ready: true })
        candidate.readiness.blockingDiagnosticCodes = ['SOURCE_ERROR']
        return candidate
      })(),
      (() => {
        const candidate = document({ ready: true })
        candidate.diagnosticCounts = { SOURCE_ERROR: 1 }
        candidate.diagnostics = [
          {
            code: 'SOURCE_ERROR',
            severity: 'error',
            message: 'Source evidence is incomplete.',
          },
        ]
        return candidate
      })(),
      (() => {
        const candidate = document({ ready: true })
        candidate.completeness.outputTextCharacters = 97
        candidate.completeness.matchedTextCharacters = 97
        candidate.completeness.textCoverage = 0.97
        return candidate
      })(),
      (() => {
        const candidate = document({ ready: true })
        candidate.completeness.unresolvedObjectCount = 1
        candidate.completeness.unresolvedObjects.assets = 1
        return candidate
      })(),
      (() => {
        const candidate = document({ ready: true })
        candidate.completeness.ocrRequiredPages = [1]
        return candidate
      })(),
      (() => {
        const candidate = document({ ready: true })
        candidate.completeness.readingOrderDiagnostics = 1
        candidate.completeness.readingOrderEvaluation.unresolvedEdgeCount = 1
        candidate.completeness.readingOrderEvaluation.reviewRequired = true
        return candidate
      })(),
      (() => {
        const candidate = document({ ready: true })
        candidate.readiness = {
          ...candidate.readiness,
          ready: false,
          status: 'review-required',
        }
        candidate.exports[0].mode = 'readable-fallback'
        return candidate
      })(),
    ]

    for (const candidate of invalidDocuments) {
      delete candidate.exports
      expect(() =>
        comparePdfBenchmarkReports(report([candidate]), report([candidate])),
      ).toThrow('INVALID_BENCHMARK_REPORT')
    }
  })

  it('fails CLI parsing before reading reports when tolerance or output arguments are incomplete', () => {
    const executable = fileURLToPath(
      new URL('./pdf-benchmark-compare.mjs', import.meta.url),
    )
    for (const arguments_ of [
      [
        'baseline.json',
        'candidate.json',
        '--tolerance',
        'textCoverage=Infinity',
      ],
      ['baseline.json', 'candidate.json', '--out'],
    ]) {
      const result = spawnSync(process.execPath, [executable, ...arguments_], {
        encoding: 'utf8',
      })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain(
        'Usage: node tools/pdf-benchmark-compare.mjs',
      )
    }
  })
})
