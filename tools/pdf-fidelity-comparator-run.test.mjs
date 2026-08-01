import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createPdfFidelityComparatorRunReceipt,
  validatePdfFidelityComparatorRunReceipt,
} from './pdf-fidelity-comparator-run.mjs'
import {
  scorePdfFidelityPredictions,
  validatePdfFidelityEvalSet,
} from './pdf-fidelity-eval.mjs'

const contractPath = 'benchmarks/pdf/fidelity-comparator-contract-v2.json'
const evalSetPath = 'benchmarks/pdf/fidelity-eval-v1.json'
const additiveEvalSetPath = 'benchmarks/pdf/fidelity-eval-v2.json'
const cliPath = fileURLToPath(
  new URL('./pdf-fidelity-comparator-run.mjs', import.meta.url),
)
const adapterSha256 = 'a'.repeat(64)
const promptArtifactBytes = Buffer.from('exact prompt artifact')
const configArtifactBytes = Buffer.from('exact config artifact')
const seedArtifactBytes = Buffer.from('exact seed artifact')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const promptSha256 = hash(promptArtifactBytes)
const configSha256 = hash(configArtifactBytes)
const seedSha256 = hash(seedArtifactBytes)

function expectedOutput(item) {
  if (item.task === 'classification') {
    return { labels: structuredClone(item.expected.labels) }
  }
  if (item.task === 'detection') {
    return { objects: structuredClone(item.expected.objects) }
  }
  if (item.task === 'reading-order') {
    return { order: structuredClone(item.expected.order) }
  }
  return { relationships: structuredClone(item.expected.relationships) }
}

function createPredictions(evalSet) {
  const identity = validatePdfFidelityEvalSet(evalSet)
  return {
    schemaVersion: '1.0.0',
    evalSetId: evalSet.id,
    evalSetSha256: identity.evalSetSha256,
    candidate: {
      id: 'test-deterministic-parser',
      version: 'exact-revision-1',
      format: 'test-reconstruction',
      formatVersion: '1.0.0',
      adapterSha256,
      runtimeIdentity: {
        status: 'not-applicable',
        tool: null,
        model: null,
      },
    },
    cases: evalSet.cases.map((item) => ({
      caseId: item.id,
      output: expectedOutput(item),
    })),
  }
}

function createRun(predictions, documentCount) {
  return {
    schemaVersion: '2.0.0',
    candidate: {
      id: predictions.candidate.id,
      version: predictions.candidate.version,
      provider: {
        id: 'local-provider',
        version: 'runner-1',
        artifactSha256: null,
        identityAuthority: 'run-spec-self-asserted',
        boundArtifactSha256: null,
      },
      model: {
        id: 'deterministic-parser',
        version: 'model-not-applicable',
        artifactSha256: null,
        identityAuthority: 'run-spec-self-asserted',
        boundArtifactSha256: null,
      },
      adapter: {
        id: 'test-adapter',
        version: 'adapter-1',
        sourceSha256: adapterSha256,
        identityAuthority: 'predictions-self-reported',
      },
      promptSha256,
      configSha256,
      seedSha256,
    },
    execution: {
      lane: 'public-development-calibration',
      platform: 'darwin',
      architecture: 'arm64',
      accelerator: null,
      networkIsolation: {
        status: 'cooperative-offline-flags',
        authority: 'run-spec-self-asserted',
        boundArtifactSha256: null,
      },
      repeatCount: 2,
      warmupCount: 1,
    },
    latency: {
      scope: 'adapter-end-to-end-per-document',
      samplesMs: Array.from(
        { length: documentCount * 2 },
        (_, index) => (index + 1) * 10,
      ),
      evidenceAuthority: 'run-spec-self-asserted',
      evidenceSha256: null,
    },
    cost: {
      currency: 'USD',
      amount: 0,
      basis: 'local-marginal-zero-hardware-excluded',
      inputTokens: null,
      outputTokens: null,
      evidenceAuthority: 'run-spec-self-asserted',
      evidenceSha256: null,
    },
  }
}

async function createArtifacts(
  governancePath = contractPath,
  manifestPath = evalSetPath,
) {
  const [contractBytes, evalSetBytes] = await Promise.all([
    readFile(governancePath),
    readFile(manifestPath),
  ])
  const evalSet = JSON.parse(evalSetBytes)
  const predictions = createPredictions(evalSet)
  const accuracyReceipt = scorePdfFidelityPredictions(evalSet, predictions)
  const run = createRun(predictions, evalSet.documents.length)
  return {
    artifacts: {
      contractBytes,
      evalSetBytes,
      predictionsBytes: Buffer.from(JSON.stringify(predictions)),
      accuracyReceiptBytes: Buffer.from(JSON.stringify(accuracyReceipt)),
      runBytes: Buffer.from(JSON.stringify(run)),
      promptArtifactBytes,
      configArtifactBytes,
      seedArtifactBytes,
    },
    accuracyReceipt,
    evalSet,
    predictions,
    run,
  }
}

describe('PDF fidelity comparator run receipt', () => {
  it('derives exact identities and latency aggregates from raw samples', async () => {
    const { artifacts, accuracyReceipt } = await createArtifacts()
    const receipt = await createPdfFidelityComparatorRunReceipt(artifacts)

    expect(receipt).toMatchObject({
      schemaVersion: '2.0.0',
      contract: {
        id: 'scholarly-pdf-fidelity-comparator-governance-2026-07-v2',
      },
      candidate: {
        id: 'test-deterministic-parser',
        version: 'exact-revision-1',
        adapter: {
          sourceSha256: adapterSha256,
          identityAuthority: 'predictions-self-reported',
        },
        promptSha256,
        configSha256,
        seedSha256,
        runtimeIdentity: {
          status: 'not-applicable',
          tool: null,
          model: null,
        },
        runtimeIdentityAuthority: 'not-applicable',
      },
      execution: {
        lane: 'public-development-calibration',
        networkIsolation: {
          status: 'cooperative-offline-flags',
          authority: 'run-spec-self-asserted',
          boundArtifactSha256: null,
        },
        repeatCount: 2,
        warmupCount: 1,
      },
      latency: {
        scope: 'adapter-end-to-end-per-document',
        sampleCount: 8,
        p50Ms: 40,
        p95Ms: 80,
        meanMs: 45,
        totalMs: 360,
      },
      accuracyReceiptSha256: accuracyReceipt.receiptSha256,
      promotionEligible: false,
    })
    expect(receipt.execution.inputIdentitySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.receiptSha256).toMatch(/^[a-f0-9]{64}$/)

    await expect(
      validatePdfFidelityComparatorRunReceipt(
        Buffer.from(JSON.stringify(receipt)),
        artifacts,
      ),
    ).resolves.toEqual({
      valid: true,
      receiptSha256: receipt.receiptSha256,
    })
  })

  it('accepts the additive v2 contract only with its exact v2 eval set', async () => {
    const { artifacts } = await createArtifacts(
      contractPath,
      additiveEvalSetPath,
    )
    const receipt = await createPdfFidelityComparatorRunReceipt(artifacts)

    expect(receipt).toMatchObject({
      contract: {
        id: 'scholarly-pdf-fidelity-comparator-governance-2026-07-v2',
      },
      evalSet: {
        id: 'scholarly-pdf-fidelity-additions-2026-07-v2',
      },
      latency: {
        sampleCount: 4,
      },
      promotionEligible: false,
    })
  })

  it('fails closed when any exact evaluation input identity changes', async () => {
    const { artifacts, predictions, run } = await createArtifacts()

    const wrongEvalBytes = Buffer.concat([
      artifacts.evalSetBytes,
      Buffer.from('\n'),
    ])
    await expect(
      createPdfFidelityComparatorRunReceipt({
        ...artifacts,
        evalSetBytes: wrongEvalBytes,
      }),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')

    const wrongPredictions = structuredClone(predictions)
    wrongPredictions.candidate.version = 'different-revision'
    await expect(
      createPdfFidelityComparatorRunReceipt({
        ...artifacts,
        predictionsBytes: Buffer.from(JSON.stringify(wrongPredictions)),
      }),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')

    const wrongAccuracyReceipt = JSON.parse(artifacts.accuracyReceiptBytes)
    wrongAccuracyReceipt.receiptSha256 = 'b'.repeat(64)
    await expect(
      createPdfFidelityComparatorRunReceipt({
        ...artifacts,
        accuracyReceiptBytes: Buffer.from(JSON.stringify(wrongAccuracyReceipt)),
      }),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')

    const wrongContract = JSON.parse(artifacts.contractBytes)
    wrongContract.evaluationBindings[0].evalSet.evalSetSha256 = 'c'.repeat(64)
    await expect(
      createPdfFidelityComparatorRunReceipt({
        ...artifacts,
        contractBytes: Buffer.from(JSON.stringify(wrongContract)),
      }),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')

    const wrongRun = structuredClone(run)
    wrongRun.candidate.adapter.sourceSha256 = 'd'.repeat(64)
    await expect(
      createPdfFidelityComparatorRunReceipt({
        ...artifacts,
        runBytes: Buffer.from(JSON.stringify(wrongRun)),
      }),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')

    const changedPrompt = structuredClone(run)
    changedPrompt.candidate.promptSha256 = 'e'.repeat(64)
    await expect(
      validatePdfFidelityComparatorRunReceipt(
        Buffer.from(
          JSON.stringify(
            await createPdfFidelityComparatorRunReceipt(artifacts),
          ),
        ),
        {
          ...artifacts,
          runBytes: Buffer.from(JSON.stringify(changedPrompt)),
        },
      ),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')

    const missingSeed = structuredClone(run)
    delete missingSeed.candidate.seedSha256
    await expect(
      createPdfFidelityComparatorRunReceipt({
        ...artifacts,
        runBytes: Buffer.from(JSON.stringify(missingSeed)),
      }),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')
  })

  it('requires an attested runtime model to match the comparator model artifact', async () => {
    const { artifacts, evalSet, predictions } = await createArtifacts()
    const attestedPredictions = structuredClone(predictions)
    attestedPredictions.candidate.runtimeIdentity = {
      status: 'attested',
      tool: {
        id: 'layout-runner',
        version: '1.2.3',
        executableSha256: 'e'.repeat(64),
        versionOutputSha256: 'f'.repeat(64),
      },
      model: {
        id: 'layout-model',
        sha256: '1'.repeat(64),
      },
    }
    const accuracyReceipt = scorePdfFidelityPredictions(
      evalSet,
      attestedPredictions,
    )
    const run = createRun(attestedPredictions, evalSet.documents.length)
    run.candidate.model = {
      id: 'layout-model',
      version: 'checkpoint-1',
      artifactSha256: '1'.repeat(64),
      identityAuthority: 'run-spec-self-asserted',
      boundArtifactSha256: null,
    }
    const attestedArtifacts = {
      ...artifacts,
      predictionsBytes: Buffer.from(JSON.stringify(attestedPredictions)),
      accuracyReceiptBytes: Buffer.from(JSON.stringify(accuracyReceipt)),
      runBytes: Buffer.from(JSON.stringify(run)),
    }

    await expect(
      createPdfFidelityComparatorRunReceipt(attestedArtifacts),
    ).resolves.toMatchObject({
      candidate: {
        model: {
          id: 'layout-model',
          artifactSha256: '1'.repeat(64),
        },
        runtimeIdentity: attestedPredictions.candidate.runtimeIdentity,
        runtimeIdentityAuthority: 'predictions-self-reported',
      },
    })

    const injectedRuntime = structuredClone(run)
    injectedRuntime.candidate.runtimeIdentity =
      attestedPredictions.candidate.runtimeIdentity
    await expect(
      createPdfFidelityComparatorRunReceipt({
        ...attestedArtifacts,
        runBytes: Buffer.from(JSON.stringify(injectedRuntime)),
      }),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')

    run.candidate.model.artifactSha256 = '2'.repeat(64)
    await expect(
      createPdfFidelityComparatorRunReceipt({
        ...attestedArtifacts,
        runBytes: Buffer.from(JSON.stringify(run)),
      }),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')
  })

  it('labels caller claims as unverified even when their exact artifact bytes are bound', async () => {
    const { artifacts, run } = await createArtifacts()

    for (const mutate of [
      (candidate) => {
        candidate.candidate.provider.id = '../../local-provider'
      },
      (candidate) => {
        candidate.execution.lane = '/tmp/local-run'
      },
      (candidate) => {
        candidate.candidate.provider.identityAuthority =
          'caller-bound-unverified-artifact'
      },
      (candidate) => {
        candidate.candidate.provider.boundArtifactSha256 = 'e'.repeat(64)
      },
      (candidate) => {
        candidate.execution.networkIsolation.status =
          'caller-claimed-isolated-unverified'
      },
    ]) {
      const invalidRun = structuredClone(run)
      mutate(invalidRun)
      await expect(
        createPdfFidelityComparatorRunReceipt({
          ...artifacts,
          runBytes: Buffer.from(JSON.stringify(invalidRun)),
        }),
      ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')
    }

    const claimedRun = structuredClone(run)
    const providerIdentityArtifactBytes = Buffer.from(
      'caller-provided provider identity claim',
    )
    const networkClaimArtifactBytes = Buffer.from(
      'caller-provided network isolation claim',
    )
    claimedRun.candidate.provider.identityAuthority =
      'caller-bound-unverified-artifact'
    claimedRun.candidate.provider.boundArtifactSha256 = hash(
      providerIdentityArtifactBytes,
    )
    claimedRun.execution.networkIsolation = {
      status: 'caller-claimed-isolated-unverified',
      authority: 'caller-bound-unverified-artifact',
      boundArtifactSha256: hash(networkClaimArtifactBytes),
    }
    await expect(
      createPdfFidelityComparatorRunReceipt({
        ...artifacts,
        runBytes: Buffer.from(JSON.stringify(claimedRun)),
        providerIdentityArtifactBytes,
        networkClaimArtifactBytes,
      }),
    ).resolves.toMatchObject({
      candidate: {
        provider: {
          identityAuthority: 'caller-bound-unverified-artifact',
          boundArtifactSha256: hash(providerIdentityArtifactBytes),
        },
      },
      execution: {
        networkIsolation: {
          status: 'caller-claimed-isolated-unverified',
          authority: 'caller-bound-unverified-artifact',
          boundArtifactSha256: hash(networkClaimArtifactBytes),
        },
      },
    })

    await expect(
      createPdfFidelityComparatorRunReceipt({
        ...artifacts,
        runBytes: Buffer.from(JSON.stringify(claimedRun)),
        providerIdentityArtifactBytes: Buffer.from('fabricated replacement'),
        networkClaimArtifactBytes,
      }),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')
  })

  it('binds samples, repeats, and network isolation and rejects receipt tampering', async () => {
    const { artifacts, run } = await createArtifacts()
    const receipt = await createPdfFidelityComparatorRunReceipt(artifacts)

    const changedSamples = structuredClone(run)
    changedSamples.latency.samplesMs[0] = 11
    await expect(
      validatePdfFidelityComparatorRunReceipt(
        Buffer.from(JSON.stringify(receipt)),
        {
          ...artifacts,
          runBytes: Buffer.from(JSON.stringify(changedSamples)),
        },
      ),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')

    const wrongSampleCount = structuredClone(run)
    wrongSampleCount.latency.samplesMs.pop()
    await expect(
      createPdfFidelityComparatorRunReceipt({
        ...artifacts,
        runBytes: Buffer.from(JSON.stringify(wrongSampleCount)),
      }),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')

    const wrongIsolation = structuredClone(run)
    wrongIsolation.execution.networkIsolation.status =
      'caller-claimed-isolated-unverified'
    await expect(
      createPdfFidelityComparatorRunReceipt({
        ...artifacts,
        runBytes: Buffer.from(JSON.stringify(wrongIsolation)),
      }),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')

    const promoted = structuredClone(receipt)
    promoted.promotionEligible = true
    await expect(
      validatePdfFidelityComparatorRunReceipt(
        Buffer.from(JSON.stringify(promoted)),
        artifacts,
      ),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')

    const changedLatency = structuredClone(receipt)
    changedLatency.latency.p95Ms = 79
    await expect(
      validatePdfFidelityComparatorRunReceipt(
        Buffer.from(JSON.stringify(changedLatency)),
        artifacts,
      ),
    ).rejects.toThrow('INVALID_PDF_FIDELITY_COMPARATOR_RUN')

    const latencyEvidenceBytes = Buffer.from('raw latency measurement log')
    const costEvidenceBytes = Buffer.from('raw provider cost record')
    const evidencedRun = structuredClone(run)
    evidencedRun.latency.evidenceAuthority = 'caller-bound-unverified-artifact'
    evidencedRun.latency.evidenceSha256 = hash(latencyEvidenceBytes)
    evidencedRun.cost.evidenceAuthority = 'caller-bound-unverified-artifact'
    evidencedRun.cost.evidenceSha256 = hash(costEvidenceBytes)
    await expect(
      createPdfFidelityComparatorRunReceipt({
        ...artifacts,
        runBytes: Buffer.from(JSON.stringify(evidencedRun)),
        latencyEvidenceBytes,
        costEvidenceBytes,
      }),
    ).resolves.toMatchObject({
      latency: {
        evidenceAuthority: 'caller-bound-unverified-artifact',
        evidenceSha256: hash(latencyEvidenceBytes),
      },
      cost: {
        evidenceAuthority: 'caller-bound-unverified-artifact',
        evidenceSha256: hash(costEvidenceBytes),
      },
    })
  })

  it('builds and independently validates a receipt through the CLI', async () => {
    const { artifacts } = await createArtifacts()
    const directory = await mkdtemp(
      join(tmpdir(), 'pdf-fidelity-comparator-run-'),
    )
    try {
      const paths = {
        contract: join(directory, 'contract.json'),
        evalSet: join(directory, 'eval-set.json'),
        predictions: join(directory, 'predictions.json'),
        accuracyReceipt: join(directory, 'accuracy-receipt.json'),
        run: join(directory, 'run.json'),
        prompt: join(directory, 'prompt.txt'),
        config: join(directory, 'config.json'),
        seed: join(directory, 'seed.txt'),
        receipt: join(directory, 'receipt.json'),
        promptLink: join(directory, 'prompt-link.txt'),
        oversizedSeed: join(directory, 'oversized-seed.bin'),
        rejectedReceipt: join(directory, 'rejected-receipt.json'),
      }
      await Promise.all([
        writeFile(paths.contract, artifacts.contractBytes),
        writeFile(paths.evalSet, artifacts.evalSetBytes),
        writeFile(paths.predictions, artifacts.predictionsBytes),
        writeFile(paths.accuracyReceipt, artifacts.accuracyReceiptBytes),
        writeFile(paths.run, artifacts.runBytes),
        writeFile(paths.prompt, artifacts.promptArtifactBytes),
        writeFile(paths.config, artifacts.configArtifactBytes),
        writeFile(paths.seed, artifacts.seedArtifactBytes),
      ])
      const common = [
        '--contract',
        paths.contract,
        '--eval-set',
        paths.evalSet,
        '--predictions',
        paths.predictions,
        '--accuracy-receipt',
        paths.accuracyReceipt,
        '--run',
        paths.run,
        '--prompt-artifact',
        paths.prompt,
        '--config-artifact',
        paths.config,
        '--seed-artifact',
        paths.seed,
      ]
      const build = spawnSync(
        process.execPath,
        [cliPath, 'build', ...common, '--out', paths.receipt],
        { encoding: 'utf8' },
      )
      expect(build.status, build.stderr).toBe(0)
      expect(JSON.parse(build.stdout).promotionEligible).toBe(false)

      const validate = spawnSync(
        process.execPath,
        [cliPath, 'validate', ...common, '--receipt', paths.receipt],
        { encoding: 'utf8' },
      )
      expect(validate.status, validate.stderr).toBe(0)
      expect(JSON.parse(validate.stdout)).toMatchObject({ valid: true })

      await symlink(paths.prompt, paths.promptLink)
      const symlinkedArguments = [...common]
      symlinkedArguments[symlinkedArguments.indexOf('--prompt-artifact') + 1] =
        paths.promptLink
      const symlinked = spawnSync(
        process.execPath,
        [
          cliPath,
          'build',
          ...symlinkedArguments,
          '--out',
          paths.rejectedReceipt,
        ],
        { encoding: 'utf8' },
      )
      expect(symlinked.status).toBe(2)
      expect(symlinked.stderr).toContain('INVALID_PDF_FIDELITY_COMPARATOR_RUN')

      await writeFile(paths.oversizedSeed, 'x')
      await truncate(paths.oversizedSeed, 32 * 1024 * 1024 + 1)
      const oversizedArguments = [...common]
      oversizedArguments[oversizedArguments.indexOf('--seed-artifact') + 1] =
        paths.oversizedSeed
      const oversized = spawnSync(
        process.execPath,
        [
          cliPath,
          'build',
          ...oversizedArguments,
          '--out',
          paths.rejectedReceipt,
        ],
        { encoding: 'utf8' },
      )
      expect(oversized.status).toBe(2)
      expect(oversized.stderr).toContain('INVALID_PDF_FIDELITY_COMPARATOR_RUN')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
