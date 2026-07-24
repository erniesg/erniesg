import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { afterEach, describe, expect, it } from 'vitest'
import * as fidelityEval from './pdf-fidelity-eval.mjs'
import {
  canonicalJson,
  comparePdfFidelityEvalReceipts,
  goldStripAdapterCases,
  isNormalizedPdfBox,
  parseLocalEvalArguments,
  scorePdfFidelityPredictions,
  validatePdfFidelityEvalComparison,
  validatePdfFidelityEvalReceipt,
  validatePdfFidelityEvalSet,
  validatePdfFidelityPredictions,
} from './pdf-fidelity-eval.mjs'

const toolPath = fileURLToPath(
  new URL('./pdf-fidelity-eval.mjs', import.meta.url),
)
const seedPath = new URL(
  '../benchmarks/pdf/fidelity-eval-v1.json',
  import.meta.url,
)
const receiptSchemaPath = new URL(
  '../docs/schemas/pdf-fidelity-eval-receipt.schema.json',
  import.meta.url,
)
const comparisonSchemaPath = new URL(
  '../docs/schemas/pdf-fidelity-eval-comparison.schema.json',
  import.meta.url,
)
const evalSetSchemaPath = new URL(
  '../docs/schemas/pdf-fidelity-eval-set.schema.json',
  import.meta.url,
)
const predictionsSchemaPath = new URL(
  '../docs/schemas/pdf-fidelity-predictions.schema.json',
  import.meta.url,
)
const temporaryDirectories = []

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function rehashReceipt(receipt) {
  const value = Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'receiptSha256'),
  )
  receipt.receiptSha256 = digest(canonicalJson(value))
  return receipt
}

function rehashComparison(comparison) {
  const value = Object.fromEntries(
    Object.entries(comparison).filter(([key]) => key !== 'comparisonSha256'),
  )
  comparison.comparisonSha256 = digest(canonicalJson(value))
  return comparison
}

function smallEvalSet(bytes = Buffer.from('private-test-pdf')) {
  return {
    schemaVersion: '1.0.0',
    id: 'test-eval-v1',
    annotationSchemaVersion: '1.0.0',
    privacy: 'public-identities-normalized-geometry-no-source-content',
    scoring: {
      detectionIouThreshold: 0.5,
      minimumOverallScore: 1,
      requireAllCriticalCases: true,
    },
    strata: [
      { id: 'front-matter-role', task: 'classification', critical: true },
    ],
    documents: [
      {
        id: 'paper-v1',
        fileName: 'paper-v1.pdf',
        byteLength: bytes.byteLength,
        sha256: digest(bytes),
        pageCount: 1,
      },
    ],
    cases: [
      {
        id: 'paper-v1.p001.note-role',
        documentId: 'paper-v1',
        page: 1,
        stratum: 'front-matter-role',
        task: 'classification',
        critical: true,
        targets: [
          {
            id: 'page-note',
            kind: 'footnote',
            box: [0.1, 0.85, 0.5, 0.05],
          },
        ],
        expected: {
          labels: [{ targetId: 'page-note', label: 'footnote' }],
        },
      },
    ],
  }
}

function predictionsFor(
  evalSet,
  { perfect = true, adapterSha256 = null } = {},
) {
  const identity = validatePdfFidelityEvalSet(evalSet)
  return {
    schemaVersion: '1.0.0',
    evalSetId: evalSet.id,
    evalSetSha256: identity.evalSetSha256,
    candidate: {
      id: perfect ? 'candidate-good' : 'candidate-bad',
      version: '1.0.0',
      format: 'srt-eval-predictions',
      formatVersion: '1.0.0',
      adapterSha256,
      runtimeIdentity: {
        status: 'not-applicable',
        tool: null,
        model: null,
      },
    },
    cases: perfect
      ? evalSet.cases.map((item) => ({
          caseId: item.id,
          output: structuredClone(item.expected),
        }))
      : [],
  }
}

function attestedRuntimeIdentity() {
  return {
    status: 'attested',
    tool: {
      id: 'test-tool',
      version: '1.0.0',
      executableSha256: 'b'.repeat(64),
      versionOutputSha256: 'c'.repeat(64),
    },
    model: {
      id: 'test-model',
      sha256: 'd'.repeat(64),
    },
  }
}

function localExecution(overrides = {}) {
  return {
    lane: 'local-mac',
    platform: 'darwin',
    architecture: 'arm64',
    offlineRequested: true,
    allInputsVerified: true,
    runtimeIdentityAuthority: 'adapter-self-reported',
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('model-neutral PDF fidelity evaluation', () => {
  it('validates the versioned, stratified public-identity seed without PDF bytes', async () => {
    const evalSet = JSON.parse(await readFile(seedPath, 'utf8'))
    const receipt = validatePdfFidelityEvalSet(evalSet)

    expect(receipt).toMatchObject({
      schemaVersion: '1.0.0',
      documentCount: 4,
      caseCount: 29,
      stratumCount: 15,
      valid: true,
    })
    expect(evalSet.cases.every(({ expected }) => !('text' in expected))).toBe(
      true,
    )
    expect(new Set(evalSet.cases.map(({ documentId }) => documentId))).toEqual(
      new Set(['2408.10903v5', '2412.13575v1', '2210.06774v3', '2502.00873v1']),
    )
    expect(evalSet.strata.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        'caption-boundary',
        'equation-number-ownership',
        'figure-content-ownership',
        'reference-scope',
        'table-boundary',
      ]),
    )
    expect(evalSet.cases.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        '2408.10903v5.p003.table-1-header-complete-boundary',
        '2412.13575v1.p006.equation-4-number-ownership',
        '2502.00873v1.p001.figure-1-internal-text-ownership',
        '2502.00873v1.p005.numbered-task-list-not-equation',
        '2502.00873v1.p012.appendix-exits-reference-scope',
        '2502.00873v1.p013.decimal-chart-tick-not-footnote',
        '2502.00873v1.p014.figures-15-18-column-isolated-boundaries',
        '2502.00873v1.p014.figure-captions-15-18-complete-boundaries',
        '2502.00873v1.p005.section-and-numbered-list-role',
        '2502.00873v1.p012.lowercase-continuation-not-heading',
        '2502.00873v1.p014.figure-column-reading-order',
        '2502.00873v1.p007.equation-3-complete-group',
        '2502.00873v1.p015.figure-19-complete-caption-boundary',
      ]),
    )
    expect(
      evalSet.cases.find(
        ({ id }) => id === '2210.06774v3.p003.section-3-2-heading-role',
      ),
    ).toMatchObject({
      page: 3,
      targets: [
        {
          id: 'section-3-2',
          kind: 'heading',
          box: [0.514286, 0.32349, 0.148625, 0.011649],
        },
      ],
      expected: {
        labels: [{ targetId: 'section-3-2', label: 'heading' }],
      },
    })
    const pageFourteenDetectionCases = evalSet.cases.filter(
      ({ documentId, page, task }) =>
        documentId === '2502.00873v1' && page === 14 && task === 'detection',
    )
    expect(pageFourteenDetectionCases).toHaveLength(2)
    expect(
      pageFourteenDetectionCases.every(
        ({ targets, expected }) =>
          targets.length === 4 &&
          expected.objects.length === 4 &&
          new Set(expected.objects.map(({ label }) => label)).size === 1,
      ),
    ).toBe(true)
    const forbiddenPrivateKeys = new Set([
      'formula',
      'html',
      'localPath',
      'path',
      'pdfBytes',
      'sourceText',
      'text',
    ])
    const visit = (value) => {
      if (!value || typeof value !== 'object') return true
      if (Array.isArray(value)) return value.every(visit)
      return Object.entries(value).every(
        ([key, nested]) => !forbiddenPrivateKeys.has(key) && visit(nested),
      )
    }
    expect(visit(evalSet)).toBe(true)
    const perfect = scorePdfFidelityPredictions(
      evalSet,
      predictionsFor(evalSet),
    )
    expect(perfect.passed).toBe(true)
    expect(Object.keys(perfect.summary.taskScores).sort()).toEqual([
      'classification',
      'detection',
      'reading-order',
      'relationship',
    ])
  })

  it('scores bounded task decisions and fails closed on a missing critical case', () => {
    const evalSet = smallEvalSet()
    const perfectPredictions = predictionsFor(evalSet)
    const missingPredictions = predictionsFor(evalSet, { perfect: false })
    const perfect = scorePdfFidelityPredictions(evalSet, perfectPredictions)
    const missing = scorePdfFidelityPredictions(evalSet, missingPredictions)

    expect(perfect).toMatchObject({
      passed: true,
      summary: {
        cases: 1,
        present: 1,
        overallScore: 1,
        criticalPassRate: 1,
      },
    })
    expect(
      validatePdfFidelityEvalReceipt(perfect, evalSet, perfectPredictions),
    ).toEqual({ valid: true })
    expect(missing).toMatchObject({
      passed: false,
      summary: {
        present: 0,
        overallScore: 0,
        criticalPassRate: 0,
      },
    })
    expect(missing.cases[0]).toMatchObject({ present: false, passed: false })

    const mineruPredictions = predictionsFor(evalSet)
    mineruPredictions.candidate = {
      id: 'mineru',
      version: '3.1.14-MinerU2.5-Pro-2604-1.2B',
      format: 'mineru-content-list',
      formatVersion: '3.1-content-list-v1',
      adapterSha256: 'a'.repeat(64),
      runtimeIdentity: {
        status: 'unattested',
        tool: null,
        model: null,
      },
    }
    const mineru = scorePdfFidelityPredictions(evalSet, mineruPredictions)
    expect(mineru.candidate).toEqual(mineruPredictions.candidate)
    expect(mineru).toMatchObject({
      passed: true,
      promotionEligible: false,
      execution: { lane: 'external-predictions' },
    })
    expect(
      validatePdfFidelityEvalReceipt(mineru, evalSet, mineruPredictions),
    ).toEqual({ valid: true })
  })

  it('keeps imported and adapter-reported local calibration non-promotable', () => {
    const evalSet = smallEvalSet()
    const importedPredictions = predictionsFor(evalSet)
    const imported = scorePdfFidelityPredictions(evalSet, importedPredictions)

    expect(imported).toMatchObject({
      schemaVersion: '1.2.0',
      passed: true,
      promotionEligible: false,
      execution: {
        lane: 'external-predictions',
        runtimeIdentityAuthority: 'not-applicable',
      },
    })

    const localPredictions = predictionsFor(evalSet, {
      adapterSha256: 'a'.repeat(64),
    })
    localPredictions.candidate.runtimeIdentity = attestedRuntimeIdentity()
    const local = scorePdfFidelityPredictions(
      evalSet,
      localPredictions,
      localExecution(),
    )

    expect(local).toMatchObject({
      passed: false,
      promotionEligible: false,
      execution: {
        lane: 'local-mac',
        allInputsVerified: true,
        runtimeIdentityAuthority: 'adapter-self-reported',
      },
    })
  })

  it('fails local promotion when any required provenance is absent', () => {
    const evalSet = smallEvalSet()
    const cases = [
      {
        name: 'unverified inputs',
        execution: localExecution({ allInputsVerified: false }),
      },
      {
        name: 'unknown execution lane',
        execution: localExecution({ lane: 'local-typo' }),
      },
      {
        name: 'non-Mac execution',
        execution: localExecution({ platform: 'linux' }),
      },
      {
        name: 'unsupported claimed runner verification',
        execution: localExecution({
          runtimeIdentityAuthority: 'runner-verified',
        }),
      },
      {
        name: 'missing adapter identity',
        execution: localExecution(),
        adapterSha256: null,
      },
      {
        name: 'non-model runtime',
        execution: localExecution(),
        runtimeIdentity: {
          status: 'not-applicable',
          tool: null,
          model: null,
        },
      },
      {
        name: 'unattested runtime',
        execution: localExecution(),
        runtimeIdentity: { status: 'unattested', tool: null, model: null },
      },
    ]

    for (const item of cases) {
      const predictions = predictionsFor(evalSet, {
        adapterSha256:
          item.adapterSha256 === undefined
            ? 'a'.repeat(64)
            : item.adapterSha256,
      })
      predictions.candidate.runtimeIdentity =
        item.runtimeIdentity ?? attestedRuntimeIdentity()
      const receipt = scorePdfFidelityPredictions(
        evalSet,
        predictions,
        item.execution,
      )
      expect(receipt, item.name).toMatchObject({
        passed: false,
        promotionEligible: false,
      })
    }
  })

  it('keeps eval-set and prediction box schemas aligned with runtime geometry', async () => {
    const evalSet = smallEvalSet()
    const predictions = predictionsFor(evalSet)
    const ajv = new Ajv2020({ strict: false })
    ajv.addKeyword({
      keyword: 'normalizedPdfBox',
      type: 'array',
      schemaType: 'boolean',
      validate: (enabled, value) => !enabled || isNormalizedPdfBox(value),
    })
    const evalSetValidator = ajv.compile(
      JSON.parse(await readFile(evalSetSchemaPath, 'utf8')),
    )
    const predictionsValidator = ajv.compile(
      JSON.parse(await readFile(predictionsSchemaPath, 'utf8')),
    )
    expect(evalSetValidator(evalSet), evalSetValidator.errors).toBe(true)
    expect(predictionsValidator(predictions), predictionsValidator.errors).toBe(
      true,
    )

    for (const invalidBox of [
      [0.1, 0.1, 0, 0.2],
      [0.9, 0.1, 0.2, 0.2],
      [0.1, 0.95, 0.2, 0.1],
    ]) {
      const invalidEvalSet = structuredClone(evalSet)
      invalidEvalSet.cases[0].targets[0].box = invalidBox
      expect(evalSetValidator(invalidEvalSet)).toBe(false)
      expect(() => validatePdfFidelityEvalSet(invalidEvalSet)).toThrow(
        'INVALID_PDF_FIDELITY_EVAL_SET',
      )

      const detectionEvalSet = structuredClone(evalSet)
      detectionEvalSet.strata = [
        { id: 'detection', task: 'detection', critical: true },
      ]
      detectionEvalSet.cases = [
        {
          id: 'paper-v1.p001.detection',
          documentId: 'paper-v1',
          page: 1,
          stratum: 'detection',
          task: 'detection',
          critical: true,
          targets: [
            { id: 'source-area', kind: 'candidate', box: [0.1, 0.1, 0.2, 0.2] },
          ],
          expected: {
            objects: [
              { id: 'object-1', label: 'figure', box: [0.1, 0.1, 0.2, 0.2] },
            ],
          },
        },
      ]
      const invalidPredictions = predictionsFor(detectionEvalSet)
      invalidPredictions.cases[0].output.objects[0].box = invalidBox
      expect(predictionsValidator(invalidPredictions)).toBe(false)
      expect(() =>
        validatePdfFidelityPredictions(invalidPredictions, detectionEvalSet),
      ).toThrow('INVALID_PDF_FIDELITY_PREDICTIONS')
    }
  })

  it('penalizes extra classification targets and reading-order items', () => {
    const classification = smallEvalSet()
    const classificationPredictions = predictionsFor(classification)
    classificationPredictions.cases[0].output.labels.push({
      targetId: 'invented-target',
      label: 'footnote',
    })
    expect(
      scorePdfFidelityPredictions(classification, classificationPredictions),
    ).toMatchObject({ passed: false, summary: { overallScore: 0.66666667 } })

    const readingOrder = structuredClone(classification)
    readingOrder.strata = [
      { id: 'column-order', task: 'reading-order', critical: true },
    ]
    readingOrder.cases = [
      {
        id: 'paper-v1.p001.order',
        documentId: 'paper-v1',
        page: 1,
        stratum: 'column-order',
        task: 'reading-order',
        critical: true,
        targets: ['a', 'b', 'c'].map((id, index) => ({
          id,
          kind: 'candidate',
          box: [0.1, 0.1 + index * 0.1, 0.4, 0.05],
        })),
        expected: { order: ['a', 'b', 'c'] },
      },
    ]
    const readingPredictions = predictionsFor(readingOrder)
    readingPredictions.cases[0].output.order.push('invented-target')
    expect(
      scorePdfFidelityPredictions(readingOrder, readingPredictions),
    ).toMatchObject({ passed: false, summary: { overallScore: 0.66666667 } })
  })

  it('scores detection by evaluated label without penalizing unrelated page objects', () => {
    const evalSet = smallEvalSet()
    evalSet.strata = [
      { id: 'visual-boundary', task: 'detection', critical: true },
    ]
    evalSet.cases = [
      {
        id: 'paper-v1.p001.figure-boundary',
        documentId: 'paper-v1',
        page: 1,
        stratum: 'visual-boundary',
        task: 'detection',
        critical: true,
        targets: [
          {
            id: 'source-area',
            kind: 'candidate',
            box: [0.1, 0.1, 0.4, 0.4],
          },
        ],
        expected: {
          objects: [
            {
              id: 'figure-1',
              label: 'figure',
              box: [0.1, 0.1, 0.4, 0.4],
            },
          ],
        },
      },
    ]
    const predictions = predictionsFor(evalSet)
    predictions.cases[0].output.objects.push({
      id: 'page-footnote',
      label: 'footnote',
      box: [0.1, 0.85, 0.4, 0.05],
    })

    expect(scorePdfFidelityPredictions(evalSet, predictions)).toMatchObject({
      passed: true,
      summary: { overallScore: 1 },
    })
  })

  it('compares candidates only on the same frozen eval identity', () => {
    const evalSet = smallEvalSet()
    const baselinePredictions = predictionsFor(evalSet, { perfect: false })
    const candidatePredictions = predictionsFor(evalSet, {
      adapterSha256: 'a'.repeat(64),
    })
    candidatePredictions.candidate.runtimeIdentity = attestedRuntimeIdentity()
    const baseline = scorePdfFidelityPredictions(evalSet, baselinePredictions)
    const candidate = scorePdfFidelityPredictions(
      evalSet,
      candidatePredictions,
      localExecution(),
    )
    const comparison = comparePdfFidelityEvalReceipts(
      baseline,
      candidate,
      evalSet,
      baselinePredictions,
      candidatePredictions,
    )

    expect(comparison).toMatchObject({
      passed: false,
      overallScoreDelta: 1,
      criticalRegressionCount: 0,
    })
    expect(comparison.cases[0].change).toBe('improved')

    const changed = structuredClone(candidate)
    changed.evalSet.sha256 = '0'.repeat(64)
    changed.receiptSha256 = digest(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(changed).filter(([key]) => key !== 'receiptSha256'),
        ),
      ),
    )
    expect(() =>
      comparePdfFidelityEvalReceipts(
        baseline,
        changed,
        evalSet,
        baselinePredictions,
        candidatePredictions,
      ),
    ).toThrow('INVALID_PDF_FIDELITY_EVAL_RECEIPT')
  })

  it('keeps imported comparison evaluation-only', () => {
    const evalSet = smallEvalSet()
    const baselinePredictions = predictionsFor(evalSet, { perfect: false })
    const candidatePredictions = predictionsFor(evalSet)
    const baseline = scorePdfFidelityPredictions(evalSet, baselinePredictions)
    const candidate = scorePdfFidelityPredictions(evalSet, candidatePredictions)
    const comparison = comparePdfFidelityEvalReceipts(
      baseline,
      candidate,
      evalSet,
      baselinePredictions,
      candidatePredictions,
    )

    expect(candidate).toMatchObject({
      passed: true,
      promotionEligible: false,
    })
    expect(comparison).toMatchObject({
      overallScoreDelta: 1,
      criticalRegressionCount: 0,
      passed: false,
    })
  })

  it('rejects pre-1.2 receipts from promotion comparison with a clear upgrade error', () => {
    const evalSet = smallEvalSet()
    const predictions = predictionsFor(evalSet)
    const current = scorePdfFidelityPredictions(evalSet, predictions)
    const legacy = structuredClone(current)
    legacy.schemaVersion = '1.0.0'
    delete legacy.promotionEligible
    rehashReceipt(legacy)

    expect(() =>
      comparePdfFidelityEvalReceipts(
        current,
        legacy,
        evalSet,
        predictions,
        predictions,
      ),
    ).toThrow('PDF_FIDELITY_PROMOTION_RECEIPT_V1_2_REQUIRED')
  })

  it('rejects a self-rehashed receipt whose scores or policy result were forged', () => {
    const evalSet = smallEvalSet()
    const predictions = predictionsFor(evalSet)
    const receipt = scorePdfFidelityPredictions(evalSet, predictions)
    const forgedScore = structuredClone(receipt)
    Object.assign(forgedScore.cases[0], { score: 0.5, passed: false })
    Object.assign(forgedScore.summary, {
      passed: 0,
      failed: 1,
      passRate: 0,
      overallScore: 0.5,
      criticalPassed: 0,
      criticalPassRate: 0,
      taskScores: {
        'front-matter-role': { cases: 1, passed: 0, score: 0.5 },
      },
      stratumScores: {
        'front-matter-role': { cases: 1, passed: 0, score: 0.5 },
      },
    })
    forgedScore.passed = false
    rehashReceipt(forgedScore)

    expect(() =>
      validatePdfFidelityEvalReceipt(forgedScore, evalSet, predictions),
    ).toThrow('INVALID_PDF_FIDELITY_EVAL_RECEIPT')

    const forgedPolicy = structuredClone(receipt)
    forgedPolicy.passed = false
    rehashReceipt(forgedPolicy)
    expect(() =>
      validatePdfFidelityEvalReceipt(forgedPolicy, evalSet, predictions),
    ).toThrow('INVALID_PDF_FIDELITY_EVAL_RECEIPT')

    const forgedEligibility = structuredClone(receipt)
    forgedEligibility.promotionEligible = true
    rehashReceipt(forgedEligibility)
    expect(() =>
      validatePdfFidelityEvalReceipt(forgedEligibility, evalSet, predictions),
    ).toThrow('INVALID_PDF_FIDELITY_EVAL_RECEIPT')

    const forgedMetadata = structuredClone(receipt)
    forgedMetadata.cases[0].documentId = 'different-paper'
    rehashReceipt(forgedMetadata)
    expect(() =>
      validatePdfFidelityEvalReceipt(forgedMetadata, evalSet, predictions),
    ).toThrow('INVALID_PDF_FIDELITY_EVAL_RECEIPT')
  })

  it('rejects coherently forged passing stats when the bound predictions fail', () => {
    const evalSet = smallEvalSet()
    const failingPredictions = predictionsFor(evalSet, { perfect: false })
    const inventedPassingPredictions = predictionsFor(evalSet)
    inventedPassingPredictions.candidate = structuredClone(
      failingPredictions.candidate,
    )
    const forged = scorePdfFidelityPredictions(
      evalSet,
      inventedPassingPredictions,
    )
    forged.predictionSha256 = digest(canonicalJson(failingPredictions))
    rehashReceipt(forged)

    expect(() =>
      validatePdfFidelityEvalReceipt(forged, evalSet, failingPredictions),
    ).toThrow('INVALID_PDF_FIDELITY_EVAL_RECEIPT')

    const honestFailing = scorePdfFidelityPredictions(
      evalSet,
      failingPredictions,
    )
    expect(() =>
      comparePdfFidelityEvalReceipts(
        honestFailing,
        forged,
        evalSet,
        failingPredictions,
        failingPredictions,
      ),
    ).toThrow('INVALID_PDF_FIDELITY_EVAL_RECEIPT')
  })

  it('validates comparisons against both receipts and the frozen manifest', () => {
    const evalSet = smallEvalSet()
    const baselinePredictions = predictionsFor(evalSet, { perfect: false })
    const candidatePredictions = predictionsFor(evalSet)
    const baseline = scorePdfFidelityPredictions(evalSet, baselinePredictions)
    const candidate = scorePdfFidelityPredictions(evalSet, candidatePredictions)
    const comparison = comparePdfFidelityEvalReceipts(
      baseline,
      candidate,
      evalSet,
      baselinePredictions,
      candidatePredictions,
    )

    expect(
      validatePdfFidelityEvalComparison(
        comparison,
        baseline,
        candidate,
        evalSet,
        baselinePredictions,
        candidatePredictions,
      ),
    ).toEqual({ valid: true })

    const forged = structuredClone(comparison)
    forged.overallScoreDelta = 0
    rehashComparison(forged)
    expect(() =>
      validatePdfFidelityEvalComparison(
        forged,
        baseline,
        candidate,
        evalSet,
        baselinePredictions,
        candidatePredictions,
      ),
    ).toThrow('INVALID_PDF_FIDELITY_EVAL_COMPARISON')
  })

  it('enforces strict nested receipt and comparison JSON schemas', async () => {
    const evalSet = smallEvalSet()
    const baselinePredictions = predictionsFor(evalSet, { perfect: false })
    const candidatePredictions = predictionsFor(evalSet)
    const baseline = scorePdfFidelityPredictions(evalSet, baselinePredictions)
    const candidate = scorePdfFidelityPredictions(evalSet, candidatePredictions)
    const comparison = comparePdfFidelityEvalReceipts(
      baseline,
      candidate,
      evalSet,
      baselinePredictions,
      candidatePredictions,
    )
    const ajv = new Ajv2020({ strict: false })
    const receiptValidator = ajv.compile(
      JSON.parse(await readFile(receiptSchemaPath, 'utf8')),
    )
    const comparisonValidator = ajv.compile(
      JSON.parse(await readFile(comparisonSchemaPath, 'utf8')),
    )

    expect(receiptValidator(candidate), receiptValidator.errors).toBe(true)
    expect(comparisonValidator(comparison), comparisonValidator.errors).toBe(
      true,
    )

    const receiptWithNestedExtra = structuredClone(candidate)
    receiptWithNestedExtra.summary.untrusted = true
    expect(receiptValidator(receiptWithNestedExtra)).toBe(false)

    const comparisonWithNestedExtra = structuredClone(comparison)
    comparisonWithNestedExtra.cases[0].untrusted = true
    expect(comparisonValidator(comparisonWithNestedExtra)).toBe(false)
  })

  it('rejects annotation tampering and extra receipt payloads', () => {
    const evalSet = smallEvalSet()
    const tampered = structuredClone(evalSet)
    tampered.cases[0].expected.labels[0].targetId = 'not-a-target'
    expect(() => validatePdfFidelityEvalSet(tampered)).toThrow(
      'INVALID_PDF_FIDELITY_EVAL_SET',
    )

    const predictions = predictionsFor(evalSet)
    const receipt = scorePdfFidelityPredictions(evalSet, predictions)
    receipt.cases[0].sourceText = 'must never enter a receipt'
    expect(() =>
      validatePdfFidelityEvalReceipt(receipt, evalSet, predictions),
    ).toThrow('INVALID_PDF_FIDELITY_EVAL_RECEIPT')
  })

  it('uses environment indirection for private roots and local adapters', () => {
    const parsed = parseLocalEvalArguments(
      [
        '--manifest',
        'benchmarks/pdf/fidelity-eval-v1.json',
        '--input-root-env',
        'PRIVATE_ROOT',
        '--adapter-env',
        'LOCAL_ADAPTER',
        '--candidate-id',
        'mineru',
        '--candidate-version',
        '3.1.14',
        '--out',
        '/tmp/srt-eval-output',
      ],
      {
        PRIVATE_ROOT: '/private/papers',
        LOCAL_ADAPTER: '/private/adapters/mineru-wrapper',
      },
    )

    expect(parsed).toMatchObject({
      candidateId: 'mineru',
      candidateVersion: '3.1.14',
      inputRoot: '/private/papers',
      adapter: '/private/adapters/mineru-wrapper',
      timeoutSeconds: 7200,
    })
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE_ROOT')
  })

  it('strips gold fields and semantic identifiers from public adapter requests', async () => {
    const evalSet = JSON.parse(await readFile(seedPath, 'utf8'))
    const stripped = goldStripAdapterCases(evalSet)
    const serialized = JSON.stringify(stripped.cases)

    expect(serialized).not.toContain('expected')
    expect(serialized).not.toContain('critical')
    expect(serialized).not.toContain('affiliation-footnote')
    expect(serialized).not.toContain('figure-1-source-area')
    expect(serialized).not.toContain('semantic-table')
    expect(serialized).not.toContain('chart-axis-tick')
    expect(serialized).not.toContain('equation-number-of')
    expect(serialized).not.toContain('figure-internal-text-of')
    expect(serialized).not.toContain('ordered-list-item')
    expect(serialized).not.toContain('appendix-exits-reference-scope')
    expect(
      stripped.cases
        .filter(({ task }) => task === 'detection')
        .every(({ targets }) => targets.length === 0),
    ).toBe(true)
    expect(
      stripped.cases
        .filter(({ task }) => task !== 'detection')
        .flatMap(({ targets }) => targets)
        .every(
          ({ id, kind }) => id.startsWith('target-') && kind === 'candidate',
        ),
    ).toBe(true)
  })

  it('hashes static, dynamic, and Vite-loaded local transitive adapter modules canonically', async () => {
    expect(typeof fidelityEval.createAdapterSourceIdentity).toBe('function')
    const root = await mkdtemp(join(tmpdir(), 'pdf-adapter-identity-test-'))
    temporaryDirectories.push(root)
    const toolsDirectory = join(root, 'tools')
    const sourceDirectory = join(root, 'src')
    await mkdir(toolsDirectory, { recursive: true })
    await mkdir(sourceDirectory, { recursive: true })
    await writeFile(join(root, 'package.json'), '{}\n')
    const adapterPath = join(toolsDirectory, 'adapter.mjs')
    await writeFile(
      adapterPath,
      [
        "import './direct.mjs'",
        "await import('./dynamic.mjs')",
        "vite.ssrLoadModule('/src/loaded.ts')",
        '',
      ].join('\n'),
    )
    await writeFile(
      join(toolsDirectory, 'direct.mjs'),
      "export { nested } from '../src/nested.ts'\n",
    )
    await writeFile(join(toolsDirectory, 'dynamic.mjs'), 'export const n = 1\n')
    await writeFile(
      join(sourceDirectory, 'loaded.ts'),
      "import { nested } from './nested'\nvoid nested\n",
    )
    const nestedPath = join(sourceDirectory, 'nested.ts')
    await writeFile(nestedPath, "export const nested = 'first'\n")

    const first = await fidelityEval.createAdapterSourceIdentity(adapterPath)
    const repeated = await fidelityEval.createAdapterSourceIdentity(adapterPath)
    await writeFile(nestedPath, "export const nested = 'second'\n")
    const changed = await fidelityEval.createAdapterSourceIdentity(adapterPath)

    expect(first).toEqual(repeated)
    expect(first.schemaVersion).toBe('1.0.0')
    expect(first.modules.map(({ path }) => path)).toEqual([
      '../src/loaded.ts',
      '../src/nested.ts',
      'adapter.mjs',
      'direct.mjs',
      'dynamic.mjs',
    ])
    expect(changed.sha256).not.toBe(first.sha256)
    expect(
      changed.modules.find(({ path }) => path === 'adapter.mjs').sha256,
    ).toBe(first.modules.find(({ path }) => path === 'adapter.mjs').sha256)
    expect(typeof fidelityEval.assertAdapterSourceIdentity).toBe('function')
    await expect(
      fidelityEval.assertAdapterSourceIdentity(
        adapterPath,
        first.sha256,
        'TEST_ADAPTER_IDENTITY_MISMATCH',
      ),
    ).rejects.toThrow('TEST_ADAPTER_IDENTITY_MISMATCH')
  })

  it('changes the receipt adapter identity when only an imported module changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-adapter-receipt-test-'))
    temporaryDirectories.push(root)
    const inputRoot = join(root, 'inputs')
    const firstOutput = join(root, 'first-output')
    const secondOutput = join(root, 'second-output')
    const manifestPath = join(root, 'eval-set.json')
    const adapterPath = join(root, 'adapter.mjs')
    const dependencyPath = join(root, 'adapter-dependency.mjs')
    const bytes = Buffer.from('private-test-pdf')
    await mkdir(inputRoot, { mode: 0o700 })
    await writeFile(join(inputRoot, 'paper-v1.pdf'), bytes, { mode: 0o600 })
    await writeFile(manifestPath, `${JSON.stringify(smallEvalSet(bytes))}\n`, {
      mode: 0o600,
    })
    await writeFile(dependencyPath, "export const value = 'first'\n")
    await writeFile(
      adapterPath,
      `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { value } from './adapter-dependency.mjs'
void value
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
  return pairs
}, []))
const request = JSON.parse(await readFile(args.request, 'utf8'))
const targetId = request.cases[0].targets[0].id
await writeFile(args.output, JSON.stringify({
  schemaVersion: '1.0.0',
  evalSetId: request.evalSet.id,
  evalSetSha256: request.evalSet.sha256,
  candidate: {
    id: request.candidate.id,
    version: request.candidate.version,
    format: 'test-adapter',
    formatVersion: '1.0.0',
    adapterSha256: request.candidate.adapterSha256,
    runtimeIdentity: {
      status: 'attested',
      tool: {
        id: 'test-tool',
        version: '1.0.0',
        executableSha256: 'b'.repeat(64),
        versionOutputSha256: 'c'.repeat(64),
      },
      model: { id: 'test-model', sha256: 'd'.repeat(64) },
    },
  },
  cases: [{ caseId: request.cases[0].id, output: { labels: [{ targetId, label: 'footnote' }] } }],
}))
`,
      { mode: 0o700 },
    )
    await chmod(adapterPath, 0o700)
    const run = (output) =>
      spawnSync(
        process.execPath,
        [
          toolPath,
          'local',
          '--manifest',
          manifestPath,
          '--input-root-env',
          'PRIVATE_ROOT',
          '--adapter-env',
          'LOCAL_ADAPTER',
          '--candidate-id',
          'test-candidate',
          '--candidate-version',
          '1.0.0',
          '--out',
          output,
          '--allow-non-darwin',
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env: {
            ...process.env,
            PRIVATE_ROOT: inputRoot,
            LOCAL_ADAPTER: adapterPath,
          },
          encoding: 'utf8',
        },
      )

    const firstRun = run(firstOutput)
    expect(firstRun.status, firstRun.stderr).toBe(1)
    const firstReceipt = JSON.parse(
      await readFile(join(firstOutput, 'eval-receipt.json'), 'utf8'),
    )
    await writeFile(dependencyPath, "export const value = 'second'\n")
    const secondRun = run(secondOutput)
    expect(secondRun.status, secondRun.stderr).toBe(1)
    const secondReceipt = JSON.parse(
      await readFile(join(secondOutput, 'eval-receipt.json'), 'utf8'),
    )

    expect(secondReceipt.candidate.adapterSha256).not.toBe(
      firstReceipt.candidate.adapterSha256,
    )
  })

  it('runs an offline local-Mac adapter and publishes only normalized predictions plus a sanitized receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-fidelity-eval-test-'))
    temporaryDirectories.push(root)
    const inputRoot = join(root, 'inputs')
    const output = join(root, 'output')
    const manifestPath = join(root, 'eval-set.json')
    const adapterPath = join(root, 'adapter.mjs')
    const bytes = Buffer.from('private-test-pdf')
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(inputRoot, { mode: 0o700 }),
    )
    await writeFile(join(inputRoot, 'paper-v1.pdf'), bytes, { mode: 0o600 })
    await writeFile(manifestPath, `${JSON.stringify(smallEvalSet(bytes))}\n`, {
      mode: 0o600,
    })
    await writeFile(
      adapterPath,
      `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
  return pairs
}, []))
const request = JSON.parse(await readFile(args.request, 'utf8'))
if (request.schemaVersion !== '1.1.0' || request.cases[0].targets[0].kind !== 'candidate') process.exit(9)
const targetId = request.cases[0].targets[0].id
const predictions = {
  schemaVersion: '1.0.0',
  evalSetId: request.evalSet.id,
  evalSetSha256: request.evalSet.sha256,
  candidate: {
    id: request.candidate.id,
    version: request.candidate.version,
    format: 'test-adapter',
    formatVersion: '1.0.0',
    adapterSha256: request.candidate.adapterSha256,
    runtimeIdentity: {
      status: 'attested',
      tool: {
        id: 'test-tool',
        version: '1.0.0',
        executableSha256: 'b'.repeat(64),
        versionOutputSha256: 'c'.repeat(64),
      },
      model: { id: 'test-model', sha256: 'd'.repeat(64) },
    },
  },
  cases: [{ caseId: request.cases[0].id, output: { labels: [{ targetId, label: 'footnote' }] } }],
}
await writeFile(args.output, JSON.stringify(predictions))
`,
      { mode: 0o700 },
    )
    await chmod(adapterPath, 0o700)

    const result = spawnSync(
      process.execPath,
      [
        toolPath,
        'local',
        '--manifest',
        manifestPath,
        '--input-root-env',
        'PRIVATE_ROOT',
        '--adapter-env',
        'LOCAL_ADAPTER',
        '--candidate-id',
        'test-candidate',
        '--candidate-version',
        '1.0.0',
        '--out',
        output,
        '--allow-non-darwin',
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          ...process.env,
          PRIVATE_ROOT: inputRoot,
          LOCAL_ADAPTER: adapterPath,
        },
        encoding: 'utf8',
      },
    )

    expect(result.status, result.stderr).toBe(1)
    const receiptText = await readFile(
      join(output, 'eval-receipt.json'),
      'utf8',
    )
    const receipt = JSON.parse(receiptText)
    const normalizedPredictions = JSON.parse(
      await readFile(join(output, 'predictions.json'), 'utf8'),
    )
    expect(receipt).toMatchObject({
      schemaVersion: '1.2.0',
      passed: false,
      promotionEligible: false,
      execution: {
        lane: 'local-mac',
        platform: platform(),
        offlineRequested: true,
        allInputsVerified: true,
        runtimeIdentityAuthority: 'adapter-self-reported',
      },
      candidate: {
        id: 'test-candidate',
        version: '1.0.0',
        format: 'test-adapter',
        runtimeIdentity: { status: 'attested' },
      },
    })
    expect(
      validatePdfFidelityEvalReceipt(
        receipt,
        smallEvalSet(bytes),
        normalizedPredictions,
      ),
    ).toEqual({
      valid: true,
    })
    expect(receiptText).not.toContain(inputRoot)
    expect(receiptText).not.toContain(adapterPath)
    expect(receiptText).not.toContain('private-test-pdf')
  })
})
