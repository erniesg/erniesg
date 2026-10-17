import { execFile } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const gate = new URL('./apply-release-gate.mjs', import.meta.url).pathname
const temporaryRoots = []

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-gate-'))
  temporaryRoots.push(root)
  for (const file of [
    'dist/research/index.html',
    'dist/study/experiments/pdf-to-epub/index.html',
    'dist/study/experiments/other/index.html',
    'dist/study/index.html',
    'dist/_astro/main.js',
  ]) {
    const target = path.join(root, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, file)
  }
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('production release gate', () => {
  it('removes research and the staged PDF experiment while preserving other study routes and assets', async () => {
    const root = await fixture()
    await run(process.execPath, [gate], {
      cwd: root,
      env: { ...process.env, PUBLIC_RESEARCH_RELEASE: 'production' },
    })
    for (const file of [
      'dist/research',
      'dist/study/experiments/pdf-to-epub',
    ]) {
      await expect(access(path.join(root, file))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
    for (const file of [
      'dist/study/experiments/other/index.html',
      'dist/study/index.html',
      'dist/_astro/main.js',
    ]) {
      expect(await readFile(path.join(root, file), 'utf8')).toBe(file)
    }
    // Reapplying the gate is safe.
    await run(process.execPath, [gate], {
      cwd: root,
      env: { ...process.env, PUBLIC_RESEARCH_RELEASE: 'production' },
    })
  })

  it('fails without the production environment before removing any files', async () => {
    const root = await fixture()
    for (const value of ['', 'preview']) {
      await expect(
        run(process.execPath, [gate], {
          cwd: root,
          env: { ...process.env, PUBLIC_RESEARCH_RELEASE: value },
        }),
      ).rejects.toThrow()
      for (const file of [
        'dist/research/index.html',
        'dist/study/experiments/pdf-to-epub/index.html',
      ]) {
        expect(await readFile(path.join(root, file), 'utf8')).toBe(file)
      }
    }
  })
})
