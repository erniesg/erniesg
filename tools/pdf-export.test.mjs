import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPdfPipeline } from './pdf-corpus-audit-lib.mjs'

let pipeline
let exportModules

function runExport(arguments_, options = {}) {
  return spawnSync(process.execPath, ['tools/pdf-export.mjs', ...arguments_], {
    encoding: 'utf8',
    env: options.env ?? process.env,
    timeout: 120_000,
  })
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('headless PDF export', () => {
  beforeAll(async () => {
    pipeline = await createPdfPipeline()
    exportModules = await pipeline.loadExportModules()
  })

  afterAll(async () => {
    await pipeline?.close()
  })

  it('exports and verifies both device-profile EPUBs with deterministic manifests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-ready-'))
    const first = join(directory, 'first')
    const second = join(directory, 'second')
    const arguments_ = [
      'tests/fixtures/pdf/born-digital.pdf',
      '--target',
      'paperPro',
      '--target',
      'paperProMove',
    ]
    try {
      const firstResult = runExport([...arguments_, '--out', first])
      const secondResult = runExport([...arguments_, '--out', second])

      expect(firstResult.status, firstResult.stderr).toBe(0)
      expect(secondResult.status, secondResult.stderr).toBe(0)
      const report = JSON.parse(firstResult.stdout)
      expect(report).toMatchObject({
        schemaVersion: '1.4.0',
        summary: {
          documents: 1,
          ready: 1,
          reviewRequired: 0,
          failed: 0,
          passRate: 1,
          failureReasons: {},
        },
      })
      expect(report.documents[0].exports).toHaveLength(2)

      for (const target of ['paperPro', 'paperProMove']) {
        const profile = exportModules.getTargetProfile(target)
        const bytes = new Uint8Array(
          await readFile(join(first, profile.epub.fileName)),
        )
        expect(() => exportModules.inspectEpub(bytes, profile)).not.toThrow()
        const metadata = report.documents[0].exports.find(
          (candidate) => candidate.target === target,
        )
        expect(metadata).toMatchObject({
          basename: profile.epub.fileName,
          byteLength: bytes.byteLength,
          sha256: digest(bytes),
          structuralValidation: 'passed',
          epubCheck: {
            status: expect.stringMatching(/^(?:passed|skipped)$/),
          },
        })
      }

      const firstFiles = (await readdir(first)).sort()
      const secondFiles = (await readdir(second)).sort()
      expect(firstFiles).toEqual([
        'checksums.sha256',
        'corpus-audit.json',
        'export-manifest.json',
        'publication-papermove.epub',
        'publication-paperpro.epub',
      ])
      expect(secondFiles).toEqual(firstFiles)
      for (const file of firstFiles) {
        expect(await readFile(join(first, file))).toEqual(
          await readFile(join(second, file)),
        )
      }

      const checksums = await readFile(join(first, 'checksums.sha256'), 'utf8')
      for (const file of [
        'publication-paperpro.epub',
        'publication-papermove.epub',
        'export-manifest.json',
      ]) {
        expect(checksums).toContain(
          `${digest(await readFile(join(first, file)))}  ${file}`,
        )
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('treats EPUBCheck warnings as validation failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-epubcheck-'))
    const binaryDirectory = join(directory, 'bin')
    const argumentsLog = join(directory, 'epubcheck-arguments.jsonl')
    const output = join(directory, 'output')
    try {
      await mkdir(binaryDirectory)
      const fakeEpubCheck = join(binaryDirectory, 'epubcheck')
      await writeFile(
        fakeEpubCheck,
        `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv.includes('--version')) process.exit(0)
appendFileSync(process.env.EPUBCHECK_ARGUMENTS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
`,
      )
      await chmod(fakeEpubCheck, 0o755)

      const result = runExport(
        [
          'tests/fixtures/pdf/born-digital.pdf',
          '--target',
          'paperPro',
          '--out',
          output,
        ],
        {
          env: {
            ...process.env,
            EPUBCHECK_ARGUMENTS_LOG: argumentsLog,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
          },
        },
      )

      expect(result.status, result.stderr).toBe(0)
      const invocations = (await readFile(argumentsLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(invocations).toHaveLength(1)
      expect(invocations[0]).toEqual([
        '--failonwarnings',
        expect.stringMatching(/publication\.epub$/),
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed with a private corpus report and no partial EPUB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-scan-'))
    const output = join(directory, 'output')
    try {
      const result = runExport([
        'tests/fixtures/pdf/scanned-page.pdf',
        '--target',
        'paperPro',
        '--target',
        'paperProMove',
        '--out',
        output,
      ])

      expect(result.status, result.stderr).toBe(1)
      const report = JSON.parse(result.stdout)
      expect(report).toMatchObject({
        summary: {
          documents: 1,
          ready: 0,
          reviewRequired: 1,
          failed: 0,
          passRate: 0,
          failureReasons: { OCR_REQUIRED: 1 },
        },
        documents: [
          {
            basename: 'scanned-page.pdf',
            readiness: {
              ready: false,
              blockingDiagnosticCodes: expect.arrayContaining(['OCR_REQUIRED']),
            },
          },
        ],
      })
      expect(await readdir(output)).toEqual(['corpus-audit.json'])
      expect(result.stdout).not.toContain(resolve(directory))
      expect(result.stderr).not.toContain(resolve(directory))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('exports the structured born-digital fixture for both profiles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-structured-'))
    try {
      const result = runExport([
        'tests/fixtures/pdf/structured-scientific.pdf',
        '--out',
        directory,
      ])

      expect(result.status, result.stderr).toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report.summary).toMatchObject({
        documents: 1,
        ready: 1,
        passRate: 1,
      })
      for (const target of ['paperPro', 'paperProMove']) {
        const profile = exportModules.getTargetProfile(target)
        const bytes = new Uint8Array(
          await readFile(join(directory, profile.epub.fileName)),
        )
        expect(() => exportModules.inspectEpub(bytes, profile)).not.toThrow()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('benchmarks a directory and exports only gate-ready documents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-corpus-'))
    const corpus = join(directory, 'corpus')
    const output = join(directory, 'output')
    try {
      await mkdir(corpus)
      await Promise.all([
        copyFile(
          'tests/fixtures/pdf/born-digital.pdf',
          join(corpus, 'ready.pdf'),
        ),
        copyFile(
          'tests/fixtures/pdf/scanned-page.pdf',
          join(corpus, 'scan.pdf'),
        ),
      ])
      const result = runExport([corpus, '--out', output])

      expect(result.status, result.stderr).toBe(1)
      const report = JSON.parse(result.stdout)
      expect(report.summary).toMatchObject({
        documents: 2,
        ready: 1,
        reviewRequired: 1,
        failed: 0,
        passRate: 0.5,
        failureReasons: { OCR_REQUIRED: 1 },
      })
      const outputEntries = (await readdir(output)).sort()
      expect(outputEntries).toHaveLength(2)
      expect(outputEntries[0]).toMatch(/^corpus-audit\.json$/)
      expect(outputEntries[1]).toMatch(/^ready-[a-f0-9]{12}$/)
      expect((await readdir(join(output, outputEntries[1]))).sort()).toEqual([
        'checksums.sha256',
        'export-manifest.json',
        'publication-papermove.epub',
        'publication-paperpro.epub',
      ])
      expect(result.stdout).not.toContain(resolve(directory))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
