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

    expect(evidence.status, evidence.stderr || evidence.stdout).toBe(0)
    const manifestMatch = evidence.stdout.match(
      /\[agent-evidence\] passed: (.+\/manifest\.json)\s*$/u,
    )
    expect(manifestMatch).not.toBeNull()
    const manifestPath = resolve(manifestMatch[1])
    const evidenceDirectory = dirname(manifestPath)
    const evidenceRoot = resolve('.agent/evidence')
    const removable = dirname(evidenceDirectory) === evidenceRoot
    try {
      expect(removable).toBe(true)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      expect(manifest.lanes_run).toEqual(['model-consultation'])
      expect(manifest.lanes).toEqual([
        expect.objectContaining({
          id: 'model-consultation',
          required: true,
          status: 'passed',
        }),
      ])
      expect(validModelConsultationEvidence(manifest.model_consultation)).toBe(
        true,
      )
      const artifact = manifest.artifacts.find(
        ({ kind }) => kind === 'model-consultation-evidence',
      )
      expect(artifact).toEqual({
        kind: 'model-consultation-evidence',
        path: manifest.lanes[0].log_path,
      })
      expect(JSON.parse(readFileSync(resolve(artifact.path), 'utf8'))).toEqual(
        manifest.model_consultation,
      )
    } finally {
      if (removable) rmSync(evidenceDirectory, { recursive: true, force: true })
    }
  }, 30_000)
})
