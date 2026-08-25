import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalJson,
  scorePdfFidelityPredictions,
  validatePdfFidelityEvalSet,
} from './pdf-fidelity-eval.mjs'
import {
  buildPdfFidelitySuiteReceipt,
  validatePdfFidelitySuiteReceipt,
} from './pdf-fidelity-suite.mjs'

vi.setConfig({ testTimeout: 180_000 })

const root = fileURLToPath(new URL('..', import.meta.url))
const toolPath = fileURLToPath(
  new URL('./pdf-fidelity-suite.mjs', import.meta.url),
)
const paths = {
  base: {
    contract: 'benchmarks/pdf/reconstruction-eval-contract-v1.json',
    evalSet: 'benchmarks/pdf/fidelity-eval-v1.json',
    observations: 'benchmarks/pdf/fidelity-eval-observations-v1.json',
  },
  additive: {
    contract: 'benchmarks/pdf/reconstruction-eval-contract-v2.json',
    evalSet: 'benchmarks/pdf/fidelity-eval-v2.json',
    observations: 'benchmarks/pdf/fidelity-eval-observations-v2.json',
  },
  comparatorContract: 'benchmarks/pdf/fidelity-comparator-contract-v2.json',
  runtimeContract: 'benchmarks/pdf/reconstruction-eval-contract-v4.json',
  runtimeContractSchema:
    'docs/schemas/pdf-reconstruction-eval-contract-v4.schema.json',
  robustnessContract: 'benchmarks/pdf/reconstruction-eval-contract-v3.json',
  robustnessContractSchema:
    'docs/schemas/pdf-reconstruction-eval-contract-v3.schema.json',
  schema: 'docs/schemas/pdf-fidelity-suite-receipt.schema.json',
}
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function rehash(receipt) {
  const value = Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'receiptSha256'),
  )
  receipt.receiptSha256 = digest(canonicalJson(value))
  return receipt
}

const baselineCandidate = {
  id: 'srt-deterministic',
  version: '4c0c164',
  format: 'srt-pdf-reconstruction',
  formatVersion: '1.1.0',
  adapterSha256: 'a'.repeat(64),
  runtimeIdentity: {
    status: 'not-applicable',
    tool: null,
    model: null,
  },
}

const modelCandidate = {
  id: 'future-layout-model',
  version: 'checkpoint-1',
  format: 'model-neutral-layout',
  formatVersion: '1.0.0',
  adapterSha256: 'b'.repeat(64),
  runtimeIdentity: {
    status: 'attested',
    tool: {
      id: 'local-layout-runtime',
      version: '1.0.0',
      executableSha256: 'c'.repeat(64),
      versionOutputSha256: 'd'.repeat(64),
    },
    model: {
      id: 'layout-checkpoint',
      sha256: 'e'.repeat(64),
    },
  },
}

function predictionCases(evalSet, mode) {
  const cases = evalSet.cases.map((item) => ({
    caseId: item.id,
    output: structuredClone(item.expected),
  }))
  if (mode === 'empty') return []
  if (mode === 'missing-first') return cases.slice(1)
  return cases
}

function predictionsFor(evalSet, candidate, mode) {
  const identity = validatePdfFidelityEvalSet(evalSet)
  return {
    schemaVersion: '1.0.0',
    evalSetId: evalSet.id,
    evalSetSha256: identity.evalSetSha256,
    candidate: structuredClone(candidate),
    cases: predictionCases(evalSet, mode),
  }
}

async function staticPart(name) {
  const locations = paths[name]
  const [contractArtifact, evalSetArtifact, observationsArtifact] =
    await Promise.all([
      readFile(join(root, locations.contract)),
      readFile(join(root, locations.evalSet)),
      readFile(join(root, locations.observations)),
    ])
  return {
    contractArtifact,
    evalSetArtifact,
    observationsArtifact,
    evalSet: JSON.parse(evalSetArtifact.toString('utf8')),
  }
}

async function suiteInput(options = {}) {
  const baselineMode = options.baselineMode ?? 'empty'
  const candidateMode = options.candidateMode ?? 'perfect'
  const [baseStatic, additiveStatic] = await Promise.all([
    staticPart('base'),
    staticPart('additive'),
  ])
  const part = (value) => {
    const baselinePredictions = predictionsFor(
      value.evalSet,
      baselineCandidate,
      baselineMode,
    )
    const candidatePredictions = predictionsFor(
      value.evalSet,
      modelCandidate,
      candidateMode,
    )
    return {
      contractArtifact: value.contractArtifact,
      evalSetArtifact: value.evalSetArtifact,
      observationsArtifact: value.observationsArtifact,
      baselinePredictions,
      baselineReceipt: scorePdfFidelityPredictions(
        value.evalSet,
        baselinePredictions,
      ),
      candidatePredictions,
      candidateReceipt: scorePdfFidelityPredictions(
        value.evalSet,
        candidatePredictions,
      ),
    }
  }
  return {
    base: part(baseStatic),
    additive: part(additiveStatic),
  }
}

describe('aggregate PDF fidelity calibration suite', () => {
  it('keeps immutable governance separate from the current runtime binding', async () => {
    const [
      baseContract,
      additiveContract,
      comparatorContract,
      runtimeContract,
      runtimeContractSchema,
      robustnessContract,
      robustnessContractSchema,
    ] =
      await Promise.all(
        [
          paths.base.contract,
          paths.additive.contract,
          paths.comparatorContract,
          paths.runtimeContract,
          paths.runtimeContractSchema,
          paths.robustnessContract,
          paths.robustnessContractSchema,
        ].map(async (path) => readFile(join(root, path))),
      )
    const baseContractSha256 = digest(baseContract)
    const additive = JSON.parse(additiveContract.toString('utf8'))
    const comparator = JSON.parse(comparatorContract.toString('utf8'))
    const runtime = JSON.parse(runtimeContract.toString('utf8'))
    const robustness = JSON.parse(robustnessContract.toString('utf8'))
    const baseBinding = comparator.evaluationBindings.find(
      (binding) => binding.id === 'public-calibration-v1',
    )
    const additiveBinding = comparator.evaluationBindings.find(
      (binding) => binding.id === 'public-calibration-v2-additions',
    )

    expect(baseContractSha256).toBe(
      'ff0caa0976df9321e271d9069f316ce12dfb12e7eb27b984f41f54dfcd989c8c',
    )
    expect(digest(additiveContract)).toBe(
      '5e0076b3f2e973af3af85ab867c4fadd1b9d26a0f24413f4e8d9327e0eb46144',
    )
    expect(additive.extends.fileSha256).toBe(baseContractSha256)
    expect(runtime.extends.fileSha256).toBe(baseContractSha256)
    expect(baseBinding.governance.fileSha256).toBe(baseContractSha256)
    expect(additiveBinding.governance.fileSha256).toBe(digest(additiveContract))
    expect(comparator.runtimeBinding.fileSha256).toBe(digest(runtimeContract))
    const validateRuntime = new Ajv2020({ strict: false }).compile(
      JSON.parse(runtimeContractSchema.toString('utf8')),
    )
    expect(validateRuntime(runtime), validateRuntime.errors).toBe(true)
    expect(robustness.extends.fileSha256).toBe(digest(additiveContract))
    const validateRobustness = new Ajv2020({ strict: false }).compile(
      JSON.parse(robustnessContractSchema.toString('utf8')),
    )
    expect(
      validateRobustness(robustness),
      validateRobustness.errors,
    ).toBe(true)
    await expect(buildPdfFidelitySuiteReceipt(await suiteInput())).resolves.toBeDefined()
  })

  it('binds both eval generations and reports binary outcomes by failure mode', async () => {
    const input = await suiteInput()
    const receipt = await buildPdfFidelitySuiteReceipt(input)
    const schema = JSON.parse(await readFile(join(root, paths.schema), 'utf8'))
    const validateSchema = new Ajv2020({ strict: true }).compile(schema)

    expect(validateSchema(receipt), validateSchema.errors).toBe(true)
    await expect(
      validatePdfFidelitySuiteReceipt(receipt, input),
    ).resolves.toEqual({
      valid: true,
    })
    expect(receipt).toMatchObject({
      suite: {
        split: 'public-development-calibration',
        blindHoldout: false,
        caseCount: 32,
        failureModeCount: 13,
      },
      candidate: {
        candidate: modelCandidate,
      },
      accuracyPassed: true,
      nonRegressionPassed: true,
      promotionEligible: false,
    })
    expect(receipt.suite.parts.map(({ role }) => role)).toEqual([
      'base',
      'additive',
    ])
    expect(receipt.cases).toHaveLength(32)
    expect(receipt.cases.every(({ passed }) => passed)).toBe(true)
    expect(
      receipt.cases.find(
        ({ caseId }) =>
          caseId === '2412.13575v1.p003.inline-script-contiguous-token',
      ),
    ).toMatchObject({
      failureMode: 'lexical-and-operator-loss',
      baselinePassed: false,
      passed: true,
      change: 'improved',
    })
    expect(
      receipt.failureModes.find(
        ({ failureMode }) => failureMode === 'semantic-type-confusion',
      ),
    ).toMatchObject({
      cases: 7,
      baselinePassed: 0,
      passed: 7,
      failed: 0,
      passRate: 1,
      regressions: 0,
    })
  })

  it('separates objective accuracy and non-regression from promotion', async () => {
    const input = await suiteInput({
      baselineMode: 'perfect',
      candidateMode: 'missing-first',
    })
    const receipt = await buildPdfFidelitySuiteReceipt(input)

    expect(receipt.accuracyPassed).toBe(false)
    expect(receipt.nonRegressionPassed).toBe(false)
    expect(receipt.promotionEligible).toBe(false)
    expect(
      receipt.cases.filter(({ change }) => change === 'regressed'),
    ).toHaveLength(2)
    expect(receipt.cases.filter(({ passed }) => !passed)).toHaveLength(2)
  })

  it('rejects receipt tampering even when the attacker recomputes the hash', async () => {
    const input = await suiteInput()
    const receipt = await buildPdfFidelitySuiteReceipt(input)
    const scenarios = [
      (value) => {
        value.cases[0].failureMode = 'invented-failure-mode'
      },
      (value) => {
        value.cases[0].passed = false
      },
      (value) => {
        value.failureModes[0].passed -= 1
      },
      (value) => {
        value.candidate.execution.offlineRequested = true
      },
      (value) => {
        value.promotionEligible = true
      },
    ]

    for (const mutate of scenarios) {
      const forged = structuredClone(receipt)
      mutate(forged)
      rehash(forged)
      await expect(
        validatePdfFidelitySuiteReceipt(forged, input),
      ).rejects.toThrow('INVALID_PDF_FIDELITY_SUITE_RECEIPT')
    }

    const staleHash = structuredClone(receipt)
    staleHash.receiptSha256 = 'f'.repeat(64)
    await expect(
      validatePdfFidelitySuiteReceipt(staleHash, input),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_SUITE_RECEIPT')
  })

  it('rejects tampered static observations and mismatched cross-version runs', async () => {
    const observationTamper = await suiteInput()
    const observations = JSON.parse(
      observationTamper.base.observationsArtifact.toString('utf8'),
    )
    observations.observations[0].firstFailureClass = 'invented-failure-mode'
    observationTamper.base.observationsArtifact = Buffer.from(
      `${JSON.stringify(observations)}\n`,
    )
    await expect(
      buildPdfFidelitySuiteReceipt(observationTamper),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_SUITE_FROZEN_ARTIFACT')

    const runMismatch = await suiteInput()
    const evalSet = JSON.parse(runMismatch.additive.evalSetArtifact.toString())
    const predictions = structuredClone(
      runMismatch.additive.candidatePredictions,
    )
    predictions.candidate.version = 'different-checkpoint'
    runMismatch.additive.candidatePredictions = predictions
    runMismatch.additive.candidateReceipt = scorePdfFidelityPredictions(
      evalSet,
      predictions,
    )
    await expect(buildPdfFidelitySuiteReceipt(runMismatch)).rejects.toThrow(
      'PDF_FIDELITY_SUITE_RUN_IDENTITY_MISMATCH',
    )
  })

  it('rejects a coordinated rewrite of the frozen observation contracts', async () => {
    const input = await suiteInput()
    const observations = JSON.parse(
      input.base.observationsArtifact.toString('utf8'),
    )
    observations.observations[0].firstFailureClass = 'invented-failure-mode'
    input.base.observationsArtifact = Buffer.from(
      `${JSON.stringify(observations)}\n`,
    )

    const baseContract = JSON.parse(
      input.base.contractArtifact.toString('utf8'),
    )
    baseContract.observations.artifact.fileSha256 = digest(
      input.base.observationsArtifact,
    )
    input.base.contractArtifact = Buffer.from(
      `${JSON.stringify(baseContract)}\n`,
    )

    const additiveContract = JSON.parse(
      input.additive.contractArtifact.toString('utf8'),
    )
    additiveContract.extends.fileSha256 = digest(input.base.contractArtifact)
    input.additive.contractArtifact = Buffer.from(
      `${JSON.stringify(additiveContract)}\n`,
    )

    await expect(buildPdfFidelitySuiteReceipt(input)).rejects.toThrow(
      'INVALID_PDF_FIDELITY_SUITE_FROZEN_ARTIFACT',
    )
  })

  it('runs the public-calibration suite CLI and writes a validated receipt', async () => {
    const input = await suiteInput()
    const directory = await mkdtemp(join(tmpdir(), 'pdf-fidelity-suite-'))
    temporaryDirectories.push(directory)
    const arguments_ = []
    for (const [part, version] of [
      [input.base, 'v1'],
      [input.additive, 'v2'],
    ]) {
      for (const role of ['baseline', 'candidate']) {
        for (const kind of ['Receipt', 'Predictions']) {
          const name = `${role}-${version}-${kind.toLowerCase()}.json`
          const path = join(directory, name)
          await writeFile(path, `${JSON.stringify(part[`${role}${kind}`])}\n`)
          arguments_.push(`--${role}-${version}-${kind.toLowerCase()}`, path)
        }
      }
    }
    const output = join(directory, 'suite-receipt.json')
    const result = spawnSync(
      process.execPath,
      [toolPath, 'build', ...arguments_, '--out', output],
      {
        cwd: root,
        encoding: 'utf8',
      },
    )

    expect(result.status, result.stderr).toBe(0)
    const receipt = JSON.parse(await readFile(output, 'utf8'))
    await expect(
      validatePdfFidelitySuiteReceipt(receipt, input),
    ).resolves.toEqual({
      valid: true,
    })
    expect(receipt).toMatchObject({
      accuracyPassed: true,
      nonRegressionPassed: true,
      promotionEligible: false,
    })
  })

  it('keeps the suite schema strict at nested boundaries', async () => {
    const input = await suiteInput()
    const receipt = await buildPdfFidelitySuiteReceipt(input)
    const schema = JSON.parse(await readFile(join(root, paths.schema), 'utf8'))
    const validateSchema = new Ajv2020({ strict: true }).compile(schema)
    const nestedExtra = structuredClone(receipt)
    nestedExtra.failureModes[0].untrusted = true
    expect(validateSchema(nestedExtra)).toBe(false)
  })
})
