import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import {
  scorePdfFidelityPredictions,
  validatePdfFidelityPredictions,
} from './pdf-fidelity-eval.mjs'
import { runPdfTargetFreeCandidateAcquisition } from './pdf-target-free-candidate-run.mjs'
import {
  normalizeTargetFreePredictions,
  validateTargetFreeDocumentObservations,
} from './pdf-target-free-predictions.mjs'

const cliPath = fileURLToPath(
  new URL('./pdf-target-free-predictions.mjs', import.meta.url),
)
const observationsSchemaPath = fileURLToPath(
  new URL(
    '../docs/schemas/pdf-target-free-document-observations.schema.json',
    import.meta.url,
  ),
)
const manifestPrivacy =
  'public-document-identities-only-no-source-content-layout-targets-or-gold'
const source = Buffer.from('%PDF-1.7\ntarget-free fixture\n%%EOF\n')
const sourceSha256 = createHash('sha256').update(source).digest('hex')
const acquisitionAdapterSha256 = 'a'.repeat(64)
const bridgeSourceSha256 = 'b'.repeat(64)

function evalSet() {
  return {
    schemaVersion: '1.0.0',
    id: 'target-free-bridge-eval',
    annotationSchemaVersion: '1.0.0',
    privacy: 'public-identities-normalized-geometry-no-source-content',
    scoring: {
      detectionIouThreshold: 0.8,
      minimumOverallScore: 0.9,
      requireAllCriticalCases: true,
    },
    strata: [
      { id: 'heading-role', task: 'classification', critical: true },
      { id: 'table-boundary', task: 'detection', critical: true },
      { id: 'page-order', task: 'reading-order', critical: true },
      { id: 'caption-owner', task: 'relationship', critical: true },
    ],
    documents: [
      {
        id: 'paper-1',
        fileName: 'paper-1.pdf',
        byteLength: source.byteLength,
        sha256: sourceSha256,
        pageCount: 2,
      },
    ],
    cases: [
      {
        id: 'paper-1.heading',
        documentId: 'paper-1',
        page: 1,
        stratum: 'heading-role',
        task: 'classification',
        critical: true,
        targets: [
          {
            id: 'heading-target',
            kind: 'heading',
            box: [0.1, 0.1, 0.3, 0.05],
          },
        ],
        expected: {
          labels: [{ targetId: 'heading-target', label: 'heading' }],
        },
      },
      {
        id: 'paper-1.table',
        documentId: 'paper-1',
        page: 1,
        stratum: 'table-boundary',
        task: 'detection',
        critical: true,
        targets: [
          {
            id: 'table-target',
            kind: 'table',
            box: [0.1, 0.2, 0.6, 0.2],
          },
        ],
        expected: {
          objects: [
            {
              id: 'table-gold',
              label: 'table',
              box: [0.1, 0.2, 0.6, 0.2],
            },
          ],
        },
      },
      {
        id: 'paper-1.order',
        documentId: 'paper-1',
        page: 2,
        stratum: 'page-order',
        task: 'reading-order',
        critical: true,
        targets: [
          {
            id: 'second-target',
            kind: 'prose',
            box: [0.55, 0.1, 0.35, 0.2],
          },
          {
            id: 'first-target',
            kind: 'prose',
            box: [0.1, 0.1, 0.35, 0.2],
          },
        ],
        expected: { order: ['first-target', 'second-target'] },
      },
      {
        id: 'paper-1.caption',
        documentId: 'paper-1',
        page: 1,
        stratum: 'caption-owner',
        task: 'relationship',
        critical: true,
        targets: [
          {
            id: 'figure-target',
            kind: 'figure',
            box: [0.1, 0.5, 0.4, 0.2],
          },
          {
            id: 'caption-target',
            kind: 'caption',
            box: [0.1, 0.72, 0.4, 0.08],
          },
        ],
        expected: {
          relationships: [
            {
              type: 'caption-of',
              sourceId: 'caption-target',
              targetId: 'figure-target',
            },
          ],
        },
      },
    ],
  }
}

function observations() {
  return {
    schemaVersion: '1.0.0',
    objects: [
      {
        id: 'heading-1',
        page: 1,
        kind: 'heading',
        label: 'heading',
        box: [0.1, 0.1, 0.3, 0.05],
      },
      {
        id: 'table-1',
        page: 1,
        kind: 'table',
        label: 'semantic-table',
        box: [0.1, 0.2, 0.6, 0.2],
      },
      {
        id: 'figure-1',
        page: 1,
        kind: 'figure',
        label: 'figure',
        box: [0.1, 0.5, 0.4, 0.2],
      },
      {
        id: 'caption-1',
        page: 1,
        kind: 'caption',
        label: 'caption',
        box: [0.1, 0.72, 0.4, 0.08],
      },
      {
        id: 'right-prose',
        page: 2,
        kind: 'prose',
        label: 'prose',
        box: [0.55, 0.1, 0.35, 0.2],
      },
      {
        id: 'left-prose',
        page: 2,
        kind: 'prose',
        label: 'prose',
        box: [0.1, 0.1, 0.35, 0.2],
      },
    ],
    readingOrder: [
      'heading-1',
      'table-1',
      'figure-1',
      'caption-1',
      'left-prose',
      'right-prose',
    ],
    relationships: [
      {
        type: 'caption-of',
        sourceId: 'caption-1',
        targetId: 'figure-1',
      },
    ],
  }
}

function receipt() {
  return {
    candidate: {
      id: 'fixture-layout',
      version: '1',
      format: 'pdf-document-observations',
      formatVersion: '1.0.0',
      adapterSource: { sha256: acquisitionAdapterSha256 },
      runtimeIdentity: {
        status: 'unattested',
        tool: null,
        model: null,
      },
    },
    documents: [
      {
        id: 'paper-1',
        byteLength: source.byteLength,
        sourceSha256,
      },
    ],
  }
}

function rawOutput(adapterSha256 = acquisitionAdapterSha256) {
  return {
    schemaVersion: '1.0.0',
    documentId: 'paper-1',
    sourceSha256,
    candidate: {
      id: 'fixture-layout',
      version: '1',
      format: 'pdf-document-observations',
      formatVersion: '1.0.0',
      adapterSourceSha256: adapterSha256,
    },
    runtimeIdentity: {
      status: 'unattested',
      tool: null,
      model: null,
    },
    output: observations(),
  }
}

function normalize(overrides = {}) {
  return normalizeTargetFreePredictions(
    overrides.evalSet ?? evalSet(),
    overrides.receipt ?? receipt(),
    overrides.rawOutputs ??
      new Map([['paper-1', overrides.rawOutput ?? rawOutput()]]),
    overrides.bridgeSourceSha256 ?? bridgeSourceSha256,
  )
}

function fixtureAdapterSource() {
  return `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
const values = {}
for (let index = 2; index < process.argv.length; index += 2) {
  values[process.argv[index].replace(/^--/, '')] = process.argv[index + 1]
}
const request = JSON.parse(await readFile(values.request, 'utf8'))
const response = {
  schemaVersion: '1.0.0',
  documentId: request.documentId,
  sourceSha256: request.sha256,
  candidate: {
    id: process.env.SRT_PDF_CANDIDATE_ID,
    version: process.env.SRT_PDF_CANDIDATE_VERSION,
    format: 'pdf-document-observations',
    formatVersion: '1.0.0',
    adapterSourceSha256: process.env.SRT_PDF_ADAPTER_SOURCE_SHA256,
  },
  runtimeIdentity: { status: 'unattested', tool: null, model: null },
  output: ${JSON.stringify(observations())},
}
await writeFile(values.output, JSON.stringify(response), { flag: 'wx' })
`
}

describe('target-free prediction bridge', () => {
  it('keeps structural schema and cross-field graph validation explicit', async () => {
    const schema = JSON.parse(await readFile(observationsSchemaPath, 'utf8'))
    const validate = new Ajv2020({ strict: false }).compile(schema)
    const valid = observations()
    expect(validate(valid), validate.errors).toBe(true)
    expect(validateTargetFreeDocumentObservations(valid, 2)).toEqual({
      valid: true,
      objectCount: 6,
    })

    const dangling = observations()
    dangling.relationships[0].targetId = 'missing-object'
    expect(validate(dangling), validate.errors).toBe(true)
    expect(schema.$comment).toContain('known relationship endpoints')
    expect(() => validateTargetFreeDocumentObservations(dangling, 2)).toThrow(
      'INVALID_PDF_TARGET_FREE_DOCUMENT_OBSERVATIONS',
    )
  })

  it('converts document observations into canonical predictions and scores them', () => {
    const manifest = evalSet()
    const predictions = normalize()

    expect(predictions.cases).toEqual([
      {
        caseId: 'paper-1.heading',
        output: {
          labels: [{ targetId: 'heading-target', label: 'heading' }],
        },
      },
      {
        caseId: 'paper-1.table',
        output: {
          objects: [
            {
              id: 'heading-1',
              label: 'heading',
              box: [0.1, 0.1, 0.3, 0.05],
            },
            {
              id: 'table-1',
              label: 'table',
              box: [0.1, 0.2, 0.6, 0.2],
            },
            {
              id: 'figure-1',
              label: 'figure',
              box: [0.1, 0.5, 0.4, 0.2],
            },
            {
              id: 'caption-1',
              label: 'caption',
              box: [0.1, 0.72, 0.4, 0.08],
            },
          ],
        },
      },
      {
        caseId: 'paper-1.order',
        output: { order: ['first-target', 'second-target'] },
      },
      {
        caseId: 'paper-1.caption',
        output: {
          relationships: [
            {
              type: 'caption-of',
              sourceId: 'caption-target',
              targetId: 'figure-target',
            },
          ],
        },
      },
    ])
    expect(predictions.candidate.adapterSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(validatePdfFidelityPredictions(predictions, manifest)).toEqual({
      valid: true,
      predictionCount: 4,
    })
    expect(
      scorePdfFidelityPredictions(manifest, predictions).summary.overallScore,
    ).toBe(1)
  })

  it('does not use expected labels or relationship answers while normalizing', () => {
    const first = normalize()
    const changedGold = evalSet()
    changedGold.cases[0].expected.labels[0].label = 'prose'
    changedGold.cases[3].expected.relationships[0].type = 'unrelated-to'
    const second = normalize({ evalSet: changedGold })

    expect(second.cases).toEqual(first.cases)
    expect(second.evalSetSha256).not.toBe(first.evalSetSha256)
  })

  it('omits ambiguous equal and near-equal geometry bindings', () => {
    for (const box of [
      [0.1, 0.1, 0.3, 0.05],
      [0.102, 0.1, 0.3, 0.05],
    ]) {
      const raw = rawOutput()
      raw.output.objects.push({
        id: 'competing-heading',
        page: 1,
        kind: 'prose',
        label: 'prose',
        box,
      })
      raw.output.readingOrder.push('competing-heading')

      const predictions = normalize({ rawOutput: raw })
      expect(
        predictions.cases.find(({ caseId }) => caseId === 'paper-1.heading'),
      ).toEqual({
        caseId: 'paper-1.heading',
        output: { labels: [] },
      })
    }

    const collidingTargets = evalSet()
    collidingTargets.cases[3].targets[1].box = [0.1, 0.5, 0.4, 0.2]
    const collisionPredictions = normalize({ evalSet: collidingTargets })
    expect(
      collisionPredictions.cases.find(
        ({ caseId }) => caseId === 'paper-1.caption',
      ),
    ).toEqual({
      caseId: 'paper-1.caption',
      output: { relationships: [] },
    })
  })

  it('fails closed on malformed observation graphs and source drift', () => {
    const missingOrder = observations()
    missingOrder.readingOrder.pop()
    expect(() =>
      validateTargetFreeDocumentObservations(missingOrder, 2),
    ).toThrow('INVALID_PDF_TARGET_FREE_DOCUMENT_OBSERVATIONS')

    const danglingRelationship = observations()
    danglingRelationship.relationships[0].targetId = 'missing-object'
    expect(() =>
      validateTargetFreeDocumentObservations(danglingRelationship, 2),
    ).toThrow('INVALID_PDF_TARGET_FREE_DOCUMENT_OBSERVATIONS')

    expect(() => normalize({ rawOutput: rawOutput('c'.repeat(64)) })).toThrow(
      'INVALID_PDF_TARGET_FREE_OBSERVATION_OUTPUT',
    )

    const changedReceipt = receipt()
    changedReceipt.documents[0].sourceSha256 = 'd'.repeat(64)
    expect(() => normalize({ receipt: changedReceipt })).toThrow(
      'PDF_TARGET_FREE_EVAL_SOURCE_IDENTITY_MISMATCH',
    )
  })

  it('validates retained acquisition bytes before building predictions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'target-free-bridge-test-'))
    const inputRoot = join(directory, 'papers')
    const adapter = join(directory, 'adapter.mjs')
    const targetFreeManifestPath = join(directory, 'target-free.json')
    const evalManifestPath = join(directory, 'eval.json')
    const receiptPath = join(directory, 'receipt.json')
    const rawOutputDirectory = join(directory, 'raw')
    const predictionsPath = join(directory, 'predictions.json')
    await mkdir(inputRoot)
    try {
      await writeFile(join(inputRoot, 'paper-1.pdf'), source)
      const targetFreeManifest = {
        schemaVersion: '1.0.0',
        id: 'target-free-bridge-source',
        privacy: manifestPrivacy,
        documents: [
          {
            id: 'paper-1',
            byteLength: source.byteLength,
            sha256: sourceSha256,
          },
        ],
      }
      await writeFile(
        targetFreeManifestPath,
        `${JSON.stringify(targetFreeManifest)}\n`,
      )
      await writeFile(evalManifestPath, `${JSON.stringify(evalSet())}\n`)
      await writeFile(adapter, fixtureAdapterSource(), { mode: 0o700 })
      await chmod(adapter, 0o700)
      const acquisition = await runPdfTargetFreeCandidateAcquisition({
        manifest: targetFreeManifestPath,
        inputRoot,
        adapter,
        candidateId: 'fixture-layout',
        candidateVersion: '1',
        output: receiptPath,
        rawOutputDirectory,
        timeoutSeconds: 30,
      })
      await writeFile(receiptPath, `${JSON.stringify(acquisition)}\n`, {
        flag: 'wx',
      })

      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          'build',
          '--eval-manifest',
          evalManifestPath,
          '--target-free-manifest',
          targetFreeManifestPath,
          '--receipt',
          receiptPath,
          '--raw-output-dir-env',
          'TARGET_FREE_BRIDGE_RAW',
          '--out',
          predictionsPath,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TARGET_FREE_BRIDGE_RAW: rawOutputDirectory,
          },
        },
      )

      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      const predictions = JSON.parse(await readFile(predictionsPath, 'utf8'))
      expect(
        scorePdfFidelityPredictions(evalSet(), predictions).summary
          .overallScore,
      ).toBe(1)

      const repeated = spawnSync(
        process.execPath,
        [
          cliPath,
          'build',
          '--eval-manifest',
          evalManifestPath,
          '--target-free-manifest',
          targetFreeManifestPath,
          '--receipt',
          receiptPath,
          '--raw-output-dir-env',
          'TARGET_FREE_BRIDGE_RAW',
          '--out',
          predictionsPath,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TARGET_FREE_BRIDGE_RAW: rawOutputDirectory,
          },
        },
      )
      expect(repeated.status).toBe(1)
      expect(repeated.stderr).toBe('PDF_TARGET_FREE_BRIDGE_FAILED\n')
      expect(repeated.stderr).not.toContain(predictionsPath)
      expect(await readFile(predictionsPath, 'utf8')).toBe(
        `${JSON.stringify(predictions, null, 2)}\n`,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
