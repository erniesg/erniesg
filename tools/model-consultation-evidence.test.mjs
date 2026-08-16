import { readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  validModelConsultationEvidence,
} = require('./model-consultation-evidence-receipt.cjs')

const evidenceCommand = [
  '--experimental-strip-types',
  '--disable-warning=ExperimentalWarning',
  'tools/model-consultation-evidence.ts',
]

function runEvidence() {
  return spawnSync(process.execPath, evidenceCommand, {
    cwd: resolve('.'),
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: '1' },
  })
}

function evidenceReceipt() {
  const result = runEvidence()
  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(result.stderr).toBe('')
  return JSON.parse(result.stdout)
}

describe('model-consultation evidence', () => {
  it('reopens actual EPUB receipts and emits exact per-document, per-class aggregates', () => {
    const receipt = evidenceReceipt()

    expect(validModelConsultationEvidence(receipt)).toBe(true)
    expect(receipt).toEqual({
      records: [
        {
          documentIdSha256:
            '1e92f266d26de96f009bc28e0ee1b269d22624b19422e69f2384655a41d9bd66',
          decisionClass: 'candidate-ambiguous-caption-association',
          decisionCount: 1,
          consultationCount: 1,
          consultationRate: 1,
          providerCallCount: 1,
          retired: false,
        },
        {
          documentIdSha256:
            '1e92f266d26de96f009bc28e0ee1b269d22624b19422e69f2384655a41d9bd66',
          decisionClass: 'candidate-ambiguous-caption-association',
          decisionCount: 1,
          consultationCount: 0,
          consultationRate: 0,
          providerCallCount: 0,
          retired: true,
        },
        {
          documentIdSha256:
            '5388133662ab0137d2ad08d6b9ad8ea75a3a4b8ee1720691fa57d44b46361133',
          decisionClass: 'ambiguous-note-marker-match',
          decisionCount: 2,
          consultationCount: 2,
          consultationRate: 1,
          providerCallCount: 2,
          retired: false,
        },
        {
          documentIdSha256:
            '5388133662ab0137d2ad08d6b9ad8ea75a3a4b8ee1720691fa57d44b46361133',
          decisionClass: 'reading-order-tie',
          decisionCount: 1,
          consultationCount: 1,
          consultationRate: 1,
          providerCallCount: 1,
          retired: false,
        },
      ],
    })
    expect(JSON.stringify(receipt)).not.toMatch(
      /\.pdf|sourceText|rawText|inputs|candidates|modelIdentity|providerId|modelId|credential|apiKey|accessToken|refreshToken|secret/iu,
    )
  }, 30_000)

  it('is byte-deterministic', () => {
    const first = runEvidence()
    const second = runEvidence()

    expect(first.status, first.stderr || first.stdout).toBe(0)
    expect(second.status, second.stderr || second.stdout).toBe(0)
    expect(second.stdout).toBe(first.stdout)
    expect(second.stderr).toBe('')
  }, 30_000)

  it('rejects unknown fields, arbitrary strings, arithmetic drift, and forged retirement', () => {
    const receipt = evidenceReceipt()
    const mutate = (change) => {
      const candidate = structuredClone(receipt)
      change(candidate)
      expect(validModelConsultationEvidence(candidate)).toBe(false)
    }

    mutate((candidate) => {
      candidate.extra = true
    })
    mutate((candidate) => {
      candidate.records[0].extra = 0
    })
    mutate((candidate) => {
      candidate.records[0].documentIdSha256 = 'a'.repeat(64)
    })
    mutate((candidate) => {
      candidate.records[0].decisionClass = 'arbitrary-decision-class'
    })
    mutate((candidate) => {
      candidate.records[2].decisionCount = 3
    })
    mutate((candidate) => {
      candidate.records[2].consultationCount = 1
    })
    mutate((candidate) => {
      candidate.records[2].consultationRate = 0.5
    })
    mutate((candidate) => {
      candidate.records[2].providerCallCount = 1
    })
    mutate((candidate) => {
      candidate.records[0].retired = true
    })
    mutate((candidate) => {
      candidate.records.reverse()
    })
  }, 30_000)

  it('is a required agent-evidence lane with a validated aggregate artifact', () => {
    const evidence = spawnSync(
      'scripts/agent-evidence',
      ['--only', 'model-consultation'],
      {
        cwd: resolve('.'),
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, NO_COLOR: '1' },
      },
    )

    // This lane writes a real manifest under `.agent/evidence/`. Asserting
    // before the cleanup is armed leaves that manifest behind on failure, and
    // the workflow then fails with "found 2 manifests" instead of the actual
    // reason, skipping manifest validation entirely. Arm the cleanup on
    // anything this run may have written, then assert inside it.
    const manifestMatch = evidence.stdout.match(
      /\[agent-evidence\] passed: (.+\/manifest\.json)\s*$/u,
    )
    const evidenceRoot = resolve('.agent/evidence')
    const manifestPath = manifestMatch ? resolve(manifestMatch[1]) : null
    const evidenceDirectory = manifestPath ? dirname(manifestPath) : null
    const removable =
      evidenceDirectory !== null && dirname(evidenceDirectory) === evidenceRoot
    try {
      expect(evidence.status, evidence.stderr || evidence.stdout).toBe(0)
      expect(manifestMatch).not.toBeNull()
      expect(removable).toBe(true)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      expect(manifest.lanes_run).toEqual(['association-audit', 'unit'])
      expect(manifest.lanes).toEqual([
        {
          id: 'association-audit',
          command: 'node tools/pdf-association-fixture-audit.mjs',
          required: true,
          status: 'passed',
          exit_code: 0,
          duration_ms: expect.any(Number),
          log_path: expect.any(String),
        },
        {
          id: 'unit',
          command:
            'node --experimental-strip-types --disable-warning=ExperimentalWarning tools/model-consultation-evidence.ts',
          required: true,
          status: 'passed',
          exit_code: 0,
          duration_ms: expect.any(Number),
          log_path: expect.any(String),
        },
      ])
      expect(manifest.association_audit).toMatchObject({
        schemaVersion: '1.0.0',
        status: 'passed',
      })
      expect(manifest).not.toHaveProperty('model_consultation')
      const artifacts = manifest.artifacts.filter(
        ({ kind }) => kind === 'model-consultation-evidence',
      )
      expect(artifacts).toHaveLength(1)
      const unitLane = manifest.lanes.find(({ id }) => id === 'unit')
      expect(unitLane).toBeDefined()
      expect(artifacts[0]).toEqual({
        kind: 'model-consultation-evidence',
        path: unitLane.log_path,
      })
      const artifactText = readFileSync(resolve(artifacts[0].path), 'utf8')
      expect(validModelConsultationEvidence(JSON.parse(artifactText))).toBe(
        true,
      )
      expect(artifactText).not.toMatch(
        /\.pdf|sourceText|rawText|inputs|candidates|modelIdentity|providerId|modelId|credential|apiKey|accessToken|refreshToken|secret/iu,
      )
    } finally {
      if (removable) rmSync(evidenceDirectory, { recursive: true, force: true })
    }
  }, 30_000)
})
