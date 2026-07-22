import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { comparePdfBenchmarkReports } from './pdf-benchmark-compare.mjs'
import { canonicalJsonHash } from './pdf-corpus-audit-lib.mjs'

const policy = {
  minimumTextCoverage: 0.98,
  minimumAssetCoverage: 0.98,
  minimumRelationshipCoverage: 0.98,
  maximumUnresolvedObjects: 0,
  maximumOcrRequiredPages: 0,
  maximumReadingOrderDiagnostics: 0,
}

function document({
  hash = 'a'.repeat(64),
  text = 0.9,
  assets = 0.8,
  relationships = 0.7,
  unresolved = 3,
  readingOrder = 1,
  ready = false,
  artifactHash = 'b'.repeat(64),
  structureHash = 'c'.repeat(64),
  blockingCodes = ready ? [] : ['INCOMPLETE_TEXT_COVERAGE'],
  ledgerAvailable = true,
  unresolvedJoins = 0,
  structurallyConsumedLineBoundaries = 0,
  missingSourceRegions = 0,
  unprovenancedRenderedUnits = 0,
  expectedInlineSpans = 1,
  mappedInlineSpans = 1,
} = {}) {
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
  return {
    basename: 'synthetic.pdf',
    sha256: hash,
    byteLength: 4096,
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
      duplicateCanonicalSpanCount: 0,
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
      schemaVersion: '1.2.0',
      canonicalNodeCount: 4,
      canonicalNodeSequenceSha256: structureHash,
      canonicalNodeTypeSequenceSha256: structureHash,
      canonicalContentSha256: structureHash,
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
    diagnosticCounts: {},
    diagnosticSampleLimit: { total: 64, perCode: 3 },
    diagnosticSamplesTruncated: 0,
    diagnostics: [],
    exports: [
      {
        target: 'paperPro',
        basename: 'publication-paperpro.epub',
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
    schemaVersion: '1.4.0',
    reportSchema: 'docs/schemas/pdf-corpus-audit.schema.json',
    privacy: 'basenames-hashes-metrics-diagnostics-only',
    policy,
    summary: {
      documents: documents.length,
      ready,
      reviewRequired,
      failed,
      passRate: documents.length === 0 ? 0 : ready / documents.length,
      failureReasons: {},
    },
    documents,
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
      leakingCountKey,
    ]) {
      expect(() => comparePdfBenchmarkReports(invalid, current)).toThrow(
        'INVALID_BENCHMARK_REPORT',
      )
    }
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
      report([document()]),
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
    const duplicate = structuredClone(baseline)
    duplicate.documents[0].completeness.duplicateCanonicalSpanCount = 1
    const unresolvedJoin = structuredClone(baseline)
    unresolvedJoin.documents[0].completeness.unresolvedCorruptingJoinCount = 1
    unresolvedJoin.documents[0].structure.unresolvedCorruptingJoinCount = 1

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
      report([document({ ready: true, missingSourceRegions: 1 })]),
      report([document({ ready: true, unprovenancedRenderedUnits: 1 })]),
      report([
        document({
          ready: true,
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

  it('gates failed EPUBCheck and permits only explicitly allowlisted skips', () => {
    const baseline = report([document({ ready: true })])
    const failedCheck = structuredClone(baseline)
    failedCheck.documents[0].exports[0].epubCheck = { status: 'failed' }
    const passedToSkipped = structuredClone(baseline)
    baseline.documents[0].exports[0].epubCheck = { status: 'passed' }
    const publicationToFallback = structuredClone(baseline)
    publicationToFallback.documents[0].exports[0].mode = 'readable-fallback'

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
    const baselineDocument = document()
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
    expect(serialized).not.toContain('publication-paperpro.epub')
    expect(serialized).not.toContain('Private diagnostic detail')
  })

  it('supports explicit tolerances and same-engine determinism checks', () => {
    const baseline = report([document()])
    const candidate = report([
      document({ text: 0.8995, artifactHash: 'c'.repeat(64) }),
    ])
    const tolerated = comparePdfBenchmarkReports(baseline, candidate, {
      tolerances: { textCoverage: 0.001 },
    })
    const deterministic = comparePdfBenchmarkReports(baseline, candidate, {
      tolerances: { textCoverage: 0.001 },
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

    expect(comparison.schemaVersion).toBe('1.4.0')
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
