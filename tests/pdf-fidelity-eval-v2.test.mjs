import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  goldStripAdapterCases,
  scorePdfFidelityPredictions,
  validatePdfFidelityEvalReceipt,
  validatePdfFidelityEvalSet,
} from '../tools/pdf-fidelity-eval.mjs'
import { createDeterministicPredictions } from '../tools/pdf-deterministic-eval-adapter.mjs'
import { normalizeMineruPredictions } from '../tools/pdf-fidelity-mineru-adapter.mjs'

const paths = {
  v1: 'benchmarks/pdf/fidelity-eval-v1.json',
  v2: 'benchmarks/pdf/fidelity-eval-v2.json',
  v2Schema: 'docs/schemas/pdf-fidelity-eval-set-v2.schema.json',
  observations: 'benchmarks/pdf/fidelity-eval-observations-v2.json',
  observationsSchema:
    'docs/schemas/pdf-fidelity-eval-observations-v2.schema.json',
  receiptSchema: 'docs/schemas/pdf-fidelity-eval-receipt.schema.json',
  contract: 'benchmarks/pdf/reconstruction-eval-contract-v2.json',
  contractSchema:
    'docs/schemas/pdf-reconstruction-eval-contract-v2.schema.json',
}

const frozenV1FileSha256 =
  '35d6d3f80eb646470afccaec9fd96b7e2a4c8405d33bcd5db62fcca425989002'
const frozenV1EvalSetSha256 =
  'e7072984f8afb438086780b1544eb38ce8be42b10f8f87e7659ed9bd3d6cb2aa'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function fileSha256(path) {
  return sha256(await readFile(path))
}

function predictionsFor(evalSet, cases) {
  const identity = validatePdfFidelityEvalSet(evalSet)
  return {
    schemaVersion: '1.0.0',
    evalSetId: evalSet.id,
    evalSetSha256: identity.evalSetSha256,
    candidate: {
      id: 'v2-test-candidate',
      version: '1.0.0',
      format: 'srt-eval-predictions',
      formatVersion: '1.0.0',
      adapterSha256: null,
      runtimeIdentity: {
        status: 'not-applicable',
        tool: null,
        model: null,
      },
    },
    cases,
  }
}

describe('additive PDF fidelity evaluation v2', () => {
  it('leaves frozen v1 byte-identical and binds v2 to its exact identity', async () => {
    const [v1, v2] = await Promise.all([
      readJson(paths.v1),
      readJson(paths.v2),
    ])
    const v1Identity = validatePdfFidelityEvalSet(v1)
    const v2Identity = validatePdfFidelityEvalSet(v2)

    expect(await fileSha256(paths.v1)).toBe(frozenV1FileSha256)
    expect(v1Identity.evalSetSha256).toBe(frozenV1EvalSetSha256)
    expect(v2.extends).toEqual({
      id: v1.id,
      schemaVersion: v1.schemaVersion,
      path: paths.v1,
      fileSha256: frozenV1FileSha256,
      evalSetSha256: frozenV1EvalSetSha256,
    })
    expect(v2Identity).toMatchObject({
      id: 'scholarly-pdf-fidelity-additions-2026-07-v2',
      schemaVersion: '2.0.0',
      documentCount: 2,
      caseCount: 3,
      stratumCount: 3,
      valid: true,
    })
  })

  it('validates every v2 target against its own source page and box', async () => {
    const [evalSet, schema] = await Promise.all([
      readJson(paths.v2),
      readJson(paths.v2Schema),
    ])
    const validateSchema = new Ajv2020({ strict: false }).compile(schema)
    expect(validateSchema(evalSet), validateSchema.errors).toBe(true)
    expect(() => validatePdfFidelityEvalSet(evalSet)).not.toThrow()

    const globalOrder = evalSet.cases.find(
      ({ stratum }) => stratum === 'document-figure-reading-order',
    )
    expect(globalOrder.page).toBe(16)
    expect(new Set(globalOrder.targets.map(({ sourcePage }) => sourcePage))).toEqual(
      new Set([16, 17, 18, 19, 20]),
    )
    expect(globalOrder.targets.map(({ id }) => id)).toEqual(
      globalOrder.expected.order,
    )
    expect(
      globalOrder.targets.every(
        ({ box }) =>
          box.length === 4 &&
          box.every(Number.isFinite) &&
          box[0] + box[2] <= 1 &&
          box[1] + box[3] <= 1,
      ),
    ).toBe(true)
    expect(
      evalSet.cases.find(
        ({ id }) => id === '2502.00873v1.p005.inline-stacked-fragment-role',
      ),
    ).toMatchObject({
      page: 5,
      targets: [
        {
          sourcePage: 5,
          box: [0.843753, 0.246373, 0.017811, 0.013503],
        },
      ],
      expected: {
        labels: [
          {
            targetId: 'inline-stacked-fragment',
            label: 'not-standalone-display-equation',
          },
        ],
      },
    })
    expect(
      evalSet.cases.find(
        ({ id }) => id === '2412.13575v1.p003.inline-script-contiguous-token',
      ),
    ).toMatchObject({
      page: 3,
      targets: [
        {
          sourcePage: 3,
          box: [0.852702, 0.730856, 0.027419, 0.008407],
        },
      ],
      expected: {
        labels: [
          {
            targetId: 'inline-superscript-token',
            label: 'contiguous-token',
          },
        ],
      },
    })

    const missingSourcePage = structuredClone(evalSet)
    delete missingSourcePage.cases[0].targets[0].sourcePage
    expect(() => validatePdfFidelityEvalSet(missingSourcePage)).toThrow(
      'INVALID_PDF_FIDELITY_EVAL_SET',
    )

    const outOfRange = structuredClone(evalSet)
    outOfRange.cases[0].targets[0].sourcePage = 25
    expect(() => validatePdfFidelityEvalSet(outOfRange)).toThrow(
      'INVALID_PDF_FIDELITY_EVAL_SET',
    )

    const wrongAnchorPage = structuredClone(evalSet)
    wrongAnchorPage.cases[0].page = 17
    expect(() => validatePdfFidelityEvalSet(wrongAnchorPage)).toThrow(
      'INVALID_PDF_FIDELITY_EVAL_SET',
    )

    const crossPageClassification = structuredClone(evalSet)
    crossPageClassification.cases[1].targets[0].sourcePage = 6
    expect(() => validatePdfFidelityEvalSet(crossPageClassification)).toThrow(
      'INVALID_PDF_FIDELITY_EVAL_SET',
    )
  })

  it('exposes opaque per-target source pages to adapters and catches the proven inversion', async () => {
    const [evalSet, receiptSchema] = await Promise.all([
      readJson(paths.v2),
      readJson(paths.receiptSchema),
    ])
    const stripped = goldStripAdapterCases(evalSet)
    const publicOrderCase = stripped.cases.find(
      ({ task }) => task === 'reading-order',
    )
    const serialized = JSON.stringify(stripped.cases)

    expect(publicOrderCase.targets.map(({ sourcePage }) => sourcePage)).toEqual([
      16, 17, 17, 18, 19, 20,
    ])
    expect(serialized).not.toContain('expected')
    expect(serialized).not.toContain('figure-21-caption-anchor')
    expect(serialized).not.toContain('not-standalone-display-equation')
    expect(serialized).not.toContain('contiguous-token')
    expect(
      stripped.cases
        .flatMap(({ targets }) => targets)
        .every(({ id, kind }) => id.startsWith('target-') && kind === 'candidate'),
    ).toBe(true)

    const perfectCases = evalSet.cases.map((item) => ({
      caseId: item.id,
      output: structuredClone(item.expected),
    }))
    const perfectPredictions = predictionsFor(evalSet, perfectCases)
    const perfectReceipt = scorePdfFidelityPredictions(
      evalSet,
      perfectPredictions,
    )
    expect(perfectReceipt.passed).toBe(true)
    const validateReceiptSchema = new Ajv2020({ strict: false }).compile(
      receiptSchema,
    )
    expect(
      validateReceiptSchema(perfectReceipt),
      validateReceiptSchema.errors,
    ).toBe(true)
    expect(
      validatePdfFidelityEvalReceipt(
        perfectReceipt,
        evalSet,
        perfectPredictions,
      ),
    ).toEqual({ valid: true })

    const invertedCases = structuredClone(perfectCases)
    const orderOutput = invertedCases.find(
      ({ caseId }) =>
        caseId === '2502.00873v1.p016-p020.figures-21-30-global-order',
    ).output.order
    orderOutput.splice(1, 0, orderOutput.splice(4, 1)[0])
    const invertedReceipt = scorePdfFidelityPredictions(
      evalSet,
      predictionsFor(evalSet, invertedCases),
    )
    const orderResult = invertedReceipt.cases.find(
      ({ task }) => task === 'reading-order',
    )
    expect(orderResult).toMatchObject({ passed: false })
    expect(orderResult.score).toBeLessThan(1)
    expect(invertedReceipt.passed).toBe(false)
  })

  it('lets both bundled local adapters consume request 1.2 cross-page targets', () => {
    const request = {
      schemaVersion: '1.2.0',
      privacy: 'owner-local-paths-present-ephemeral-delete-after-run',
      evalSet: { id: 'fixture-eval-v2', sha256: 'e'.repeat(64) },
      candidate: {
        id: 'local-adapter',
        version: '2.0.0',
        adapterSha256: 'a'.repeat(64),
      },
      documents: [
        {
          id: 'paper-v2',
          path: '/owner-only/paper-v2.pdf',
          byteLength: 42,
          sha256: 'd'.repeat(64),
          pageCount: 2,
        },
      ],
      cases: [
        {
          id: 'cross-page-order',
          documentId: 'paper-v2',
          page: 1,
          stratum: 'document-reading-order',
          task: 'reading-order',
          targets: [
            {
              id: 'target-first',
              kind: 'candidate',
              sourcePage: 1,
              box: [0.1, 0.1, 0.1, 0.04],
            },
            {
              id: 'target-second',
              kind: 'candidate',
              sourcePage: 2,
              box: [0.1, 0.1, 0.1, 0.04],
            },
          ],
        },
      ],
    }
    const reconstruction = {
      source: {
        sha256: 'd'.repeat(64),
        byteLength: 42,
        pageCount: 2,
      },
      paper: { title: 'Cross-page fixture', nodes: [] },
      regions: [
        {
          id: 'source-first',
          page: 1,
          kind: 'body',
          text: 'first',
          box: {
            page: 1,
            x: 0.1,
            y: 0.1,
            width: 0.1,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
        },
        {
          id: 'source-second',
          page: 2,
          kind: 'body',
          text: 'second',
          box: {
            page: 2,
            x: 0.1,
            y: 0.1,
            width: 0.1,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
        },
      ],
      readingOrder: { order: ['source-first', 'source-second'] },
      assets: [],
      noteRelationships: [],
      visualRelationships: [],
      citationRelationships: [],
      provenance: {},
    }
    expect(
      createDeterministicPredictions(
        request,
        new Map([['paper-v2', reconstruction]]),
      ).cases,
    ).toEqual([
      {
        caseId: 'cross-page-order',
        output: { order: ['target-first', 'target-second'] },
      },
    ])

    const contentByPage = new Map([
      [
        'paper-v2:1',
        {
          v1: [],
          v2: [
            {
              type: 'paragraph',
              bbox: [100, 100, 200, 140],
              content: {
                paragraph_content: [{ type: 'text', content: 'first' }],
              },
            },
          ],
        },
      ],
      [
        'paper-v2:2',
        {
          v1: [],
          v2: [
            {
              type: 'paragraph',
              bbox: [100, 100, 200, 140],
              content: {
                paragraph_content: [{ type: 'text', content: 'second' }],
              },
            },
          ],
        },
      ],
    ])
    expect(
      normalizeMineruPredictions(request, contentByPage).cases,
    ).toEqual([
      {
        caseId: 'cross-page-order',
        output: { order: ['target-first', 'target-second'] },
      },
    ])
  })

  it('binds complaint-driven observations and states the remaining eval gaps honestly', async () => {
    const [
      evalSet,
      observations,
      observationsSchema,
      contract,
      contractSchema,
    ] = await Promise.all([
      readJson(paths.v2),
      readJson(paths.observations),
      readJson(paths.observationsSchema),
      readJson(paths.contract),
      readJson(paths.contractSchema),
    ])
    const ajv = new Ajv2020({ strict: false })
    const validateObservations = ajv.compile(observationsSchema)
    const validateContract = ajv.compile(contractSchema)
    expect(
      validateObservations(observations),
      validateObservations.errors,
    ).toBe(true)
    expect(validateContract(contract), validateContract.errors).toBe(true)
    expect(observations.method).toMatchObject({
      candidateOutputConsulted: true,
      selectionStatus:
        'candidate-output-used-for-case-selection-source-pdf-used-for-label',
    })

    const cases = new Map(evalSet.cases.map((item) => [item.id, item]))
    const documents = new Map(
      evalSet.documents.map((document) => [document.id, document]),
    )
    expect(observations.observations).toHaveLength(cases.size)
    for (const observation of observations.observations) {
      const item = cases.get(observation.caseId)
      const expectedPages = [
        ...new Set(item.targets.map(({ sourcePage }) => sourcePage)),
      ].sort((left, right) => left - right)
      expect(observation.sourceArtifact).toMatchObject({
        documentId: item.documentId,
        sourcePdfSha256: documents.get(item.documentId).sha256,
        pages: expectedPages,
      })
    }

    const v2Identity = validatePdfFidelityEvalSet(evalSet)
    expect(contract.additiveFidelityEval.artifact.fileSha256).toBe(
      await fileSha256(contract.additiveFidelityEval.artifact.path),
    )
    expect(contract.additiveFidelityEval.schema.fileSha256).toBe(
      await fileSha256(contract.additiveFidelityEval.schema.path),
    )
    expect(contract.additiveFidelityEval).toMatchObject({
      id: v2Identity.id,
      evalSetSha256: v2Identity.evalSetSha256,
      documentIdentitySha256: v2Identity.documentIdentitySha256,
      caseIdentitySha256: v2Identity.caseIdentitySha256,
      documentCount: v2Identity.documentCount,
      caseCount: v2Identity.caseCount,
      stratumCount: v2Identity.stratumCount,
    })
    expect(contract.additiveObservations.artifact.fileSha256).toBe(
      await fileSha256(contract.additiveObservations.artifact.path),
    )
    expect(contract.additiveObservations.schema.fileSha256).toBe(
      await fileSha256(contract.additiveObservations.schema.path),
    )
    expect(contract.extends.fileSha256).toBe(
      await fileSha256(contract.extends.path),
    )
    expect(contract.aggregatePublicCalibration).toMatchObject({
      baseCaseCount: 29,
      additiveCaseCount: 3,
      totalCaseCount: 32,
      distinctDocumentCount: 4,
      labelsExposed: true,
    })
    expect(contract.aggregatePublicCalibration.identitySha256).toBe(
      sha256(
        [frozenV1EvalSetSha256, v2Identity.evalSetSha256].join('\0'),
      ),
    )
    expect(contract.splitStatus.blindHoldout).toBe('not-built')
    expect(contract.splitStatus.judgeTrain).toContain('not-built')
    expect(contract.splitStatus.judgeDev).toContain('not-built')
    expect(contract.splitStatus.judgeTest).toContain('not-built')
    expect(contract.taxonomySaturation).toMatchObject({
      status: 'not-saturated',
      labeledBoundedTraceCount: 32,
      observedFinalNoNewClassWindow: 0,
    })
    expect(contract.coverageGaps).toContainEqual(
      expect.objectContaining({
        id: 'profile-wide-visual-legibility',
        status: 'not-labelled',
        requiredEvidence: expect.arrayContaining([
          'exact-official-profile-version-and-viewport',
          'rendered-artifact-sha256',
          'scroll-width-and-client-width',
          'minimum-cell-inline-size',
          'clipping-and-overflow-assertion',
        ]),
      }),
    )
    expect(
      evalSet.strata.some(({ id }) => id === 'profile-wide-visual-legibility'),
    ).toBe(false)
  })

  it('contains no source prose, local paths, screenshots, or model payloads', async () => {
    const artifacts = await Promise.all([
      readJson(paths.v2),
      readJson(paths.observations),
      readJson(paths.contract),
    ])
    const forbiddenPrivateKeys = new Set([
      'formula',
      'html',
      'localPath',
      'pathToPdf',
      'pdfBytes',
      'rawModelPayload',
      'screenshot',
      'sourceText',
      'text',
    ])
    const visit = (value) => {
      if (value === null || typeof value !== 'object') return true
      if (Array.isArray(value)) return value.every(visit)
      return Object.entries(value).every(
        ([key, nested]) => !forbiddenPrivateKeys.has(key) && visit(nested),
      )
    }
    expect(artifacts.every(visit)).toBe(true)
    expect(canonicalJson(artifacts)).not.toContain('/Users/')
    expect(canonicalJson(artifacts)).not.toContain('/private/')
  })
})
