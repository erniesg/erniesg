import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it, vi } from 'vitest'
import { validateCorpusContract } from '../tools/pdf-corpus-contract.mjs'
import {
  deriveExecutablePackageClosure,
  verifyReconstructionEvaluatorImplementationBinding,
} from '../tools/pdf-benchmark-readiness.mjs'
import {
  canonicalJson,
  validatePdfFidelityEvalSet,
} from '../tools/pdf-fidelity-eval.mjs'

const paths = {
  contract: 'benchmarks/pdf/reconstruction-eval-contract-v1.json',
  contractSchema: 'docs/schemas/pdf-reconstruction-eval-contract.schema.json',
  additiveContract: 'benchmarks/pdf/reconstruction-eval-contract-v3.json',
  additiveContractSchema:
    'docs/schemas/pdf-reconstruction-eval-contract-v3.schema.json',
  corpus: 'benchmarks/pdf/corpus-contract-v1.json',
  additiveCorpus: 'benchmarks/pdf/corpus-contract-v2.json',
  evalSet: 'benchmarks/pdf/fidelity-eval-v1.json',
  observations: 'benchmarks/pdf/fidelity-eval-observations-v1.json',
  observationsSchema: 'docs/schemas/pdf-fidelity-eval-observations.schema.json',
  comparatorSchema:
    'docs/schemas/pdf-fidelity-comparator-run-receipt.schema.json',
}

vi.setConfig({ testTimeout: 120_000 })

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function fileSha256(path) {
  return sha256(await readFile(path))
}

describe('PDF reconstruction evaluation governance contract', () => {
  it('binds the frozen corpus, public calibration seed, and observed cases', async () => {
    const [
      contract,
      contractSchema,
      corpus,
      evalSet,
      observations,
      observationsSchema,
    ] = await Promise.all([
      readJson(paths.contract),
      readJson(paths.contractSchema),
      readJson(paths.corpus),
      readJson(paths.evalSet),
      readJson(paths.observations),
      readJson(paths.observationsSchema),
    ])
    const ajv = new Ajv2020({ strict: false })
    const validateContract = ajv.compile(contractSchema)
    const validateObservations = ajv.compile(observationsSchema)

    expect(validateContract(contract), validateContract.errors).toBe(true)
    expect(
      validateObservations(observations),
      validateObservations.errors,
    ).toBe(true)

    const profileArtifactValidity = contract.objectiveEvaluators.find(
      (evaluator) => evaluator.id === 'profile-artifact-validity',
    )
    expect(profileArtifactValidity.implementationComponents).toHaveLength(60)
    for (const component of profileArtifactValidity.implementationComponents)
      expect(component.fileSha256).toBe(await fileSha256(component.path))
    const packageClosure = await deriveExecutablePackageClosure(
      profileArtifactValidity.implementation[0],
    )
    expect(profileArtifactValidity.implementationPackageLock).toEqual(
      packageClosure.packageLock,
    )
    expect(
      profileArtifactValidity.implementationPackages
        .filter(
          (package_) =>
            !package_.platforms ||
            package_.platforms.includes(packageClosure.platform),
        )
        .map((package_) =>
          package_.platforms
            ? { ...package_, platforms: [packageClosure.platform] }
            : package_,
        ),
    ).toEqual(packageClosure.packages)
    expect(profileArtifactValidity.implementationPlatforms).toContain(
      packageClosure.platform,
    )
    expect(profileArtifactValidity.implementationSha256).toBe(
      sha256(
        canonicalJson({
          kind: 'pdf-benchmark-metric-implementation-v3',
          entrypoint: profileArtifactValidity.implementation[0],
          components: profileArtifactValidity.implementationComponents
            .map(({ path, fileSha256 }) => ({ path, fileSha256 }))
            .sort((left, right) => left.path.localeCompare(right.path)),
          packageLock: profileArtifactValidity.implementationPackageLock,
          platforms: [
            ...profileArtifactValidity.implementationPlatforms,
          ].sort(),
          packages: profileArtifactValidity.implementationPackages,
        }),
      ),
    )
    await expect(
      verifyReconstructionEvaluatorImplementationBinding(contract),
    ).resolves.toBeUndefined()
    const tampered = structuredClone(contract)
    tampered.objectiveEvaluators.find(
      (evaluator) => evaluator.id === 'profile-artifact-validity',
    ).implementationPackages[0].treeSha256 = '0'.repeat(64)
    expect(validateContract(tampered), validateContract.errors).toBe(true)
    await expect(
      verifyReconstructionEvaluatorImplementationBinding(tampered),
    ).rejects.toThrow('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    expect(
      tampered.objectiveEvaluators.find(
        (evaluator) => evaluator.id === 'profile-artifact-validity',
      ).implementationPackages[0].treeSha256,
    ).not.toBe(profileArtifactValidity.implementationPackages[0].treeSha256)
    expect(
      sha256(
        canonicalJson({
          kind: 'pdf-benchmark-metric-implementation-v3',
          entrypoint: profileArtifactValidity.implementation[0],
          components: tampered.objectiveEvaluators
            .find((evaluator) => evaluator.id === 'profile-artifact-validity')
            .implementationComponents.map(({ path, fileSha256 }) => ({
              path,
              fileSha256,
            }))
            .sort((left, right) => left.path.localeCompare(right.path)),
          packageLock: profileArtifactValidity.implementationPackageLock,
          platforms: [
            ...profileArtifactValidity.implementationPlatforms,
          ].sort(),
          packages: tampered.objectiveEvaluators.find(
            (evaluator) => evaluator.id === 'profile-artifact-validity',
          ).implementationPackages,
        }),
      ),
    ).not.toBe(profileArtifactValidity.implementationSha256)

    const corpusIdentity = validateCorpusContract(corpus)
    const evalIdentity = validatePdfFidelityEvalSet(evalSet)
    expect(contract.corpus.artifact.fileSha256).toBe(
      await fileSha256(contract.corpus.artifact.path),
    )
    expect(contract.corpus.canonicalContractSha256).toBe(
      corpusIdentity.contractSha256,
    )
    expect(contract.fidelityEval.artifact.fileSha256).toBe(
      await fileSha256(contract.fidelityEval.artifact.path),
    )
    expect(contract.fidelityEval).toMatchObject({
      id: evalIdentity.id,
      evalSetSha256: evalIdentity.evalSetSha256,
      documentIdentitySha256: evalIdentity.documentIdentitySha256,
      caseIdentitySha256: evalIdentity.caseIdentitySha256,
      documentCount: evalIdentity.documentCount,
      caseCount: evalIdentity.caseCount,
      stratumCount: evalIdentity.stratumCount,
    })
    expect(contract.observations.artifact.fileSha256).toBe(
      await fileSha256(contract.observations.artifact.path),
    )
    expect(contract.observations.schema.fileSha256).toBe(
      await fileSha256(contract.observations.schema.path),
    )
    expect(contract.comparatorReceipt.schema.fileSha256).toBe(
      await fileSha256(contract.comparatorReceipt.schema.path),
    )
    expect(contract.comparatorReceipt.authority).toBe(
      'performance-provenance-sidecar-never-promotion-authority',
    )

    const expectedEvaluatorByTask = {
      classification: 'exact-classification',
      detection: 'complete-label-scoped-detection-iou',
      'reading-order': 'all-pairs-reading-order',
      relationship: 'exact-typed-relationship',
    }
    const documents = new Map(evalSet.documents.map((item) => [item.id, item]))
    const cases = new Map(evalSet.cases.map((item) => [item.id, item]))
    expect(observations.observations).toHaveLength(cases.size)
    expect(
      new Set(observations.observations.map(({ caseId }) => caseId)),
    ).toEqual(new Set(cases.keys()))

    for (const observation of observations.observations) {
      const item = cases.get(observation.caseId)
      const document = documents.get(item.documentId)
      expect(observation.sourceArtifact).toMatchObject({
        documentId: item.documentId,
        sourcePdfSha256: document.sha256,
        page: item.page,
      })
      expect(observation.evaluator).toEqual({
        id: expectedEvaluatorByTask[item.task],
        kind: 'code',
        outcome: 'binary-pass-fail',
      })
    }
  })

  it('states the real split sizes and does not call twenty runs twenty unique papers', async () => {
    const [contract, corpus] = await Promise.all([
      readJson(paths.contract),
      readJson(paths.corpus),
    ])
    const frozenIds = new Set(corpus.frozen.documents.map(({ id }) => id))
    const randomIds = new Set(corpus.seededRandom.documents.map(({ id }) => id))
    const overlap = [...frozenIds].filter((id) => randomIds.has(id)).sort()
    const distinct = new Set([...frozenIds, ...randomIds])

    expect(contract.corpus).toMatchObject({
      runCount: 20,
      distinctDocumentCount: distinct.size,
    })
    expect([...contract.corpus.overlapDocumentIds].sort()).toEqual(overlap)
    expect(distinct.size).toBe(18)
    expect(contract.taxonomySaturation).toMatchObject({
      status: 'not-saturated',
      labeledBoundedTraceCount: 29,
      targetApproximateTraceCount: 100,
      requiredFinalNoNewClassWindow: 20,
      observedFinalNoNewClassWindow: 0,
    })
    expect(contract.splits.blindHoldout.status).toBe('not-built')
    expect(contract.splits.judgeTrain.caseCount).toBe(0)
    expect(contract.splits.judgeDev.caseCount).toBe(0)
    expect(contract.splits.judgeTest.caseCount).toBe(0)
  })

  it('adds a set-disjoint robustness corpus without rewriting frozen governance', async () => {
    const [contract, schema, corpus] = await Promise.all([
      readJson(paths.additiveContract),
      readJson(paths.additiveContractSchema),
      readJson(paths.additiveCorpus),
    ])
    const validate = new Ajv2020({ strict: false }).compile(schema)

    expect(validate(contract), validate.errors).toBe(true)
    expect(contract.extends.fileSha256).toBe(
      await fileSha256(contract.extends.path),
    )
    expect(contract.extends.fileSha256).toBe(
      'e7d238375e0efa34d5b68e89e8613ed0fbfa057e6b43fbf9fa00af4f93825a91',
    )
    expect(contract.robustnessCorpus.artifact.fileSha256).toBe(
      await fileSha256(contract.robustnessCorpus.artifact.path),
    )

    const corpusIdentity = validateCorpusContract(corpus)
    expect(contract.robustnessCorpus.canonicalContractSha256).toBe(
      corpusIdentity.contractSha256,
    )
    const frozenIds = new Set(corpus.frozen.documents.map(({ id }) => id))
    const randomIds = new Set(corpus.seededRandom.documents.map(({ id }) => id))
    expect([...randomIds].filter((id) => frozenIds.has(id))).toEqual([])
    expect(new Set([...frozenIds, ...randomIds]).size).toBe(20)
    expect(contract.robustnessCorpus).toMatchObject({
      runCount: 20,
      distinctDocumentCount: 20,
      overlapDocumentIds: [],
      selectionPolicy: 'sha256-rank-without-replacement-excluding-frozen-v1',
    })
    expect(contract.authority.promotionAuthority).toBe(
      'none-objective-gates-and-independent-blind-evidence-remain-required',
    )
  })

  it('requires provider, model version, latency, and cost in future comparator sidecars', async () => {
    const schema = await readJson(paths.comparatorSchema)
    const validate = new Ajv2020({ strict: false }).compile(schema)
    const digest = 'a'.repeat(64)
    const receipt = {
      schemaVersion: '1.0.0',
      privacy:
        'public-identities-hashes-performance-aggregates-no-source-content-or-local-paths',
      contract: {
        id: 'scholarly-pdf-reconstruction-eval-governance-2026-07-v1',
        sha256: digest,
      },
      evalSet: {
        id: 'scholarly-pdf-fidelity-seed-2026-07-v1',
        sha256: digest,
        documentIdentitySha256: digest,
        caseIdentitySha256: digest,
      },
      candidate: {
        id: 'future-layout-model',
        version: 'candidate-1',
        provider: {
          id: 'local-provider',
          version: 'runner-1',
          artifactSha256: digest,
        },
        model: {
          id: 'layout-model',
          version: 'checkpoint-1',
          artifactSha256: digest,
        },
        adapter: {
          id: 'layout-adapter',
          version: 'adapter-1',
          sourceSha256: digest,
        },
      },
      execution: {
        lane: 'local-mac',
        platform: 'darwin',
        architecture: 'arm64',
        accelerator: 'apple-m-series',
        networkIsolation: 'independently-enforced',
        inputIdentitySha256: digest,
        repeatCount: 3,
        warmupCount: 1,
      },
      latency: {
        scope: 'adapter-end-to-end-per-document',
        sampleCount: 12,
        p50Ms: 100,
        p95Ms: 150,
        meanMs: 110,
        totalMs: 1320,
      },
      cost: {
        currency: 'USD',
        amount: 0,
        basis: 'local-marginal-zero-hardware-excluded',
        inputTokens: null,
        outputTokens: null,
      },
      accuracyReceiptSha256: digest,
      promotionEligible: false,
      receiptSha256: digest,
    }

    expect(validate(receipt), validate.errors).toBe(true)

    for (const mutate of [
      (value) => delete value.candidate.provider,
      (value) => delete value.candidate.model.version,
      (value) => delete value.latency,
      (value) => delete value.cost,
    ]) {
      const candidate = structuredClone(receipt)
      mutate(candidate)
      expect(validate(candidate)).toBe(false)
    }
  })
})
