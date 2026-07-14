import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('local PDF corpus audit', () => {
  it('reports only stable document identifiers and quality results', () => {
    const result = spawnSync(
      process.execPath,
      [
        'tools/pdf-corpus-audit.mjs',
        '--report-only',
        'tests/fixtures/pdf/born-digital.pdf',
        'tests/fixtures/pdf/structured-scientific.pdf',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    )

    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({
      schemaVersion: '1.0.0',
      privacy: 'basenames-hashes-metrics-diagnostics-only',
      summary: { documents: 2, ready: 1, reviewRequired: 1, failed: 0 },
    })
    expect(report.documents.map((document) => document.basename)).toEqual([
      'born-digital.pdf',
      'structured-scientific.pdf',
    ])
    expect(report.documents.every((document) => document.sha256)).toBe(true)
    expect(result.stdout).not.toContain(resolve('.'))
    expect(result.stdout).not.toContain(
      'Synthetic semantic completeness fixture',
    )
  })
})
