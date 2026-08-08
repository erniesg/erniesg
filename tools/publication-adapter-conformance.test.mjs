import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePublicationAdapterConformanceArgs } from './publication-adapter-conformance.mjs'

describe('publication adapter output conformance CLI', () => {
  it('requires one explicit new output directory', () => {
    expect(
      parsePublicationAdapterConformanceArgs(['--output', '/tmp/conformance']),
    ).toEqual({ output: '/tmp/conformance' })
    expect(() => parsePublicationAdapterConformanceArgs([])).toThrow(/Usage/)
    expect(() =>
      parsePublicationAdapterConformanceArgs(['--input', '/tmp/conformance']),
    ).toThrow(/Usage/)
  })

  it('runs its CLI entry point instead of silently exiting', () => {
    const result = spawnSync(
      process.execPath,
      ['--import=tsx', resolve('tools/publication-adapter-conformance.mjs')],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/Usage: publication-adapter-conformance/)
  })

  it('stages the complete Astro fixture through the real CLI matrix', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-adapter-conformance-cli-'),
    )
    const output = resolve(temporaryRoot, 'output')
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--import=tsx',
          resolve('tools/publication-adapter-conformance.mjs'),
          '--output',
          output,
        ],
        { encoding: 'utf8', timeout: 120_000 },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain(
        `Astro/Payload publication output receipts conform at ${output} (4 artifacts each)`,
      )
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
