import { spawnSync } from 'node:child_process'
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
})
