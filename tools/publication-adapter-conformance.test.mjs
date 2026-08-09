import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { vivliostyleRenderer } from '../src/publication/renderers/vivliostyle.ts'
import {
  parsePublicationAdapterConformanceArgs,
  publicationAdapterConformance,
} from './publication-adapter-conformance.mjs'

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

  it('passes canonical graphs to the renderer after semantic comparison', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-adapter-conformance-boundary-'),
    )
    const output = resolve(temporaryRoot, 'output')
    const renderedNodeIds = []
    const originalRender = vivliostyleRenderer.render
    vivliostyleRenderer.render = async (bundle) => {
      renderedNodeIds.push(bundle.graph.nodes.map((node) => node.id))
      if (renderedNodeIds.length === 2) throw new Error('render-boundary-captured')
      return undefined
    }
    try {
      await expect(
        publicationAdapterConformance(['--output', output]),
      ).rejects.toThrow('render-boundary-captured')
      expect(renderedNodeIds).toHaveLength(2)
      expect(renderedNodeIds[0][0]).toBe('node-1')
      expect(renderedNodeIds[1][0]).toBe('node-1')
    } finally {
      vivliostyleRenderer.render = originalRender
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('rejects an unignored repository output before staging but allows ignored evidence', async () => {
    // Unique test-owned names: nothing pre-existing can live at these paths,
    // so the test only ever removes what it created itself.
    const unique = randomBytes(6).toString('hex')
    const output = resolve(`.publication-conformance-unignored-${unique}`)
    const ignoredOutput = resolve(
      `.agent/evidence/publication-conformance-output-policy-${unique}`,
    )
    const originalRender = vivliostyleRenderer.render
    const renderedOutputs = []
    vivliostyleRenderer.render = async (_bundle, request) => {
      renderedOutputs.push(resolve(request.outputDirectory))
      throw new Error('render-boundary-captured')
    }
    try {
      await expect(
        publicationAdapterConformance(['--output', output]),
      ).rejects.toThrow(/repository-local publication output.*ignored/i)
      expect(renderedOutputs).toEqual([])
      await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' })

      await expect(
        publicationAdapterConformance(['--output', ignoredOutput]),
      ).rejects.toThrow('render-boundary-captured')
      expect(renderedOutputs).toHaveLength(1)
      // The render targeted an invocation-owned staging directory next to
      // the authorized output, and the failed run published nothing and
      // cleaned up both staging and its empty reservation.
      const stagingRoot = dirname(renderedOutputs[0])
      expect(basename(stagingRoot)).toMatch(/^\.publication-staging-/)
      expect(dirname(stagingRoot)).toBe(dirname(ignoredOutput))
      await expect(access(stagingRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(access(ignoredOutput)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      vivliostyleRenderer.render = originalRender
      await rm(output, { recursive: true, force: true })
      await rm(ignoredOutput, { recursive: true, force: true })
    }
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
