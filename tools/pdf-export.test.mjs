import { fork, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  access,
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
import { basename, join, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPdfPipeline } from './pdf-corpus-audit-lib.mjs'
import {
  createPdfCorpusReportValidator,
  DEFAULT_DOCUMENT_TIMEOUT_SECONDS,
  MAX_STAGED_DOCUMENT_BYTES,
  MAX_STAGED_EPUB_BYTES,
  MAX_STAGED_MANIFEST_BYTES,
  MAX_STAGED_CHECKSUM_BYTES,
  assertPublishableOutput,
  directoryMatchesExpectedRegularFiles,
  parseArguments,
  processExportDocuments,
  runIsolatedPdfExportJob,
  runPdfExportWorkerJob,
} from './pdf-export.mjs'

let pipeline
let exportModules
let reportValidator

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

function exportProfile(id) {
  return exportModules.getEpubProfileMetadata(
    exportModules.getTargetProfile(id),
  )
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function waitForJson(path) {
  let value = null
  await expect
    .poll(
      async () => {
        try {
          value = JSON.parse(await readFile(path, 'utf8'))
          return true
        } catch {
          return false
        }
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return value
}

describe('headless PDF export', () => {
  beforeAll(async () => {
    pipeline = await createPdfPipeline()
    exportModules = await pipeline.loadExportModules()
    reportValidator = await createPdfCorpusReportValidator()
  })

  afterAll(async () => {
    await pipeline?.close()
  })

  it('defaults to a bounded 900-second document timeout and rejects unsafe values', () => {
    const base = ['paper.pdf', '--out', '/tmp/pdf-export-timeout-test']
    expect(parseArguments(base).documentTimeoutSeconds).toBe(
      DEFAULT_DOCUMENT_TIMEOUT_SECONDS,
    )
    expect(parseArguments(base).ocrEngine).toBe('none')
    expect(
      parseArguments([...base, '--ocr-engine', 'tesseract']).ocrEngine,
    ).toBe('tesseract')
    expect(parseArguments([...base, '--ocr-engine=none']).ocrEngine).toBe(
      'none',
    )
    for (const value of ['', 'remote', 'auto']) {
      expect(() => parseArguments([...base, `--ocr-engine=${value}`])).toThrow()
    }
    expect(
      parseArguments([...base, '--document-timeout-seconds', '42'])
        .documentTimeoutSeconds,
    ).toBe(42)
    for (const value of ['0', '1.5', '86401', 'nope']) {
      expect(() =>
        parseArguments([...base, `--document-timeout-seconds=${value}`]),
      ).toThrow('INVALID_USAGE')
    }
  })

  it('uses fixed parent-owned staged artifact and document byte caps', () => {
    expect(MAX_STAGED_EPUB_BYTES).toBe(256 * 1024 * 1024)
    expect(MAX_STAGED_DOCUMENT_BYTES).toBe(512 * 1024 * 1024)
    expect(MAX_STAGED_MANIFEST_BYTES).toBe(1024 * 1024)
    expect(MAX_STAGED_CHECKSUM_BYTES).toBe(64 * 1024)
    expect(MAX_STAGED_DOCUMENT_BYTES).toBeGreaterThan(MAX_STAGED_EPUB_BYTES)
  })

  it('stops staging enumeration at the first entry beyond the exact expected set', async () => {
    const entries = ['a.epub', 'export-manifest.json', 'checksums.sha256'].map(
      (name) => ({
        name,
        isFile: () => true,
        isSymbolicLink: () => false,
      }),
    )
    let reads = 0
    let closes = 0
    const openDirectory = async () => ({
      read: async () => {
        reads += 1
        if (reads <= entries.length) return entries[reads - 1]
        throw new Error('enumeration read beyond expected.length + 1')
      },
      close: async () => {
        closes += 1
      },
    })

    await expect(
      directoryMatchesExpectedRegularFiles(
        '/worker-controlled-stage',
        entries.slice(0, 2).map(({ name }) => name),
        openDirectory,
      ),
    ).resolves.toBe(false)
    expect(reads).toBe(3)
    expect(closes).toBe(1)
  })

  it('hard-kills a timed-out worker tree without putting private paths in argv', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-timeout-'))
    const stagingDirectory = join(directory, 'stage')
    const observationPath = join(directory, 'observation.json')
    const privatePath = join(directory, 'private paper title.pdf')
    try {
      const result = await runIsolatedPdfExportJob(
        { path: privatePath, stagingDirectory, observationPath },
        {
          timeoutMs: 1_000,
          workerModule: resolve('tests/fixtures/pdf-export-hanging-worker.mjs'),
        },
      )

      expect(result).toEqual({ status: 'timeout' })
      const observation = JSON.parse(await readFile(observationPath, 'utf8'))
      expect(observation.receivedPath).toBe(privatePath)
      expect(observation.argv.join('\n')).not.toContain(privatePath)
      expect(
        await readFile(join(stagingDirectory, 'partial.epub'), 'utf8'),
      ).toBe('partial')
      await expect
        .poll(() => processExists(observation.workerPid), { timeout: 2_000 })
        .toBe(false)
      await expect
        .poll(() => processExists(observation.grandchildPid), {
          timeout: 2_000,
        })
        .toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('kills the worker tree when its parent IPC channel disconnects unexpectedly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-disconnect-'))
    const stagingDirectory = join(directory, 'stage')
    const observationPath = join(directory, 'observation.json')
    await mkdir(stagingDirectory)
    const child = fork(
      resolve('tests/fixtures/pdf-export-scratch-worker.mjs'),
      [],
      {
        detached: process.platform !== 'win32',
        serialization: 'json',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      },
    )
    let observation = null
    try {
      child.send({ stagingDirectory, observationPath })
      observation = await waitForJson(observationPath)
      const exited = once(child, 'exit')
      child.disconnect()
      await exited

      await expect
        .poll(() => processExists(observation.workerPid), { timeout: 2_000 })
        .toBe(false)
      await expect
        .poll(() => processExists(observation.grandchildPid), {
          timeout: 2_000,
        })
        .toBe(false)
    } finally {
      if (child.connected) child.disconnect()
      if (processExists(child.pid)) child.kill('SIGKILL')
      if (
        observation?.grandchildPid &&
        processExists(observation.grandchildPid)
      ) {
        process.kill(observation.grandchildPid, 'SIGKILL')
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)

  it.runIf(process.platform !== 'win32')(
    'cleans active worker trees and private workspaces before preserving CLI signal semantics',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pdf-export-signal-'))
      const observationPath = join(directory, 'observation.json')
      const outputDirectory = join(directory, 'output')
      const parent = fork(
        resolve('tests/fixtures/pdf-export-signal-parent.mjs'),
        [],
        {
          serialization: 'json',
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      )
      let observation = null
      try {
        parent.send({
          inputPath: join(directory, 'private paper.pdf'),
          observationPath,
          outputDirectory,
        })
        observation = await waitForJson(observationPath)
        const closed = once(parent, 'close')
        parent.kill('SIGTERM')
        const [code, signal] = await closed

        expect(code).toBeNull()
        expect(signal).toBe('SIGTERM')
        await expect
          .poll(() => processExists(observation.workerPid), { timeout: 2_000 })
          .toBe(false)
        await expect
          .poll(() => processExists(observation.grandchildPid), {
            timeout: 2_000,
          })
          .toBe(false)
        await expect(
          access(observation.stagingDirectory),
        ).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(access(observation.cacheDirectory)).rejects.toMatchObject({
          code: 'ENOENT',
        })
        await expect(access(outputDirectory)).rejects.toMatchObject({
          code: 'ENOENT',
        })
      } finally {
        if (parent.connected) parent.disconnect()
        if (processExists(parent.pid)) parent.kill('SIGKILL')
        if (
          observation?.grandchildPid &&
          processExists(observation.grandchildPid)
        ) {
          process.kill(observation.grandchildPid, 'SIGKILL')
        }
        await rm(directory, { recursive: true, force: true })
      }
    },
    30_000,
  )

  it('keeps killed-worker Vite scratch inside the discarded document workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-scratch-'))
    const observationPath = join(directory, 'observation.json')
    const outputDirectory = join(directory, 'output')
    try {
      const { report } = await processExportDocuments({
        paths: [join(directory, 'private paper.pdf')],
        corpusContract: null,
        policy: pipeline.policy,
        reportValidator,
        targetProfiles: [exportProfile('paperPro')],
        readableFallback: false,
        validator: { kind: 'skipped', reason: 'java-unavailable' },
        outputDirectory,
        timeoutMs: 3_000,
        runWorker: (job, options) =>
          runIsolatedPdfExportJob(
            { ...job, observationPath },
            {
              ...options,
              workerModule: resolve(
                'tests/fixtures/pdf-export-scratch-worker.mjs',
              ),
            },
          ),
      })
      const observation = await waitForJson(observationPath)

      expect(report.summary).toMatchObject({
        documents: 1,
        ready: 0,
        reviewRequired: 0,
        failed: 1,
        failureReasons: { PDF_DOCUMENT_TIMEOUT: 1 },
      })
      expect(observation.cacheDirectory).toContain(observation.stagingDirectory)
      await expect(access(observation.stagingDirectory)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(access(observation.cacheDirectory)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(await readdir(outputDirectory)).toEqual(['corpus-audit.json'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects worker IPC envelopes with unexpected private fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-protocol-'))
    const privatePath = join(directory, 'private paper title.pdf')
    try {
      const result = await runIsolatedPdfExportJob(
        {
          path: privatePath,
          stagingDirectory: join(directory, 'stage'),
        },
        {
          timeoutMs: 2_000,
          workerModule: resolve('tests/fixtures/pdf-export-invalid-worker.mjs'),
        },
      )

      expect(result).toEqual({ status: 'failed' })
      expect(JSON.stringify(result)).not.toContain(privatePath)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('continues sequentially after timeout and emits deterministic private failure rows', async () => {
    const run = async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pdf-export-continue-'))
      const paths = [
        join(directory, 'z-timeout.pdf'),
        join(directory, 'a-parser-failure.pdf'),
      ]
      const stagingDirectories = []
      const calls = []
      let active = 0
      let maximumActive = 0
      try {
        const outputDirectory = join(directory, 'output')
        const result = await processExportDocuments({
          paths,
          corpusContract: null,
          policy: pipeline.policy,
          reportValidator,
          targetProfiles: [exportProfile('paperPro')],
          readableFallback: false,
          validator: { kind: 'skipped', reason: 'java-unavailable' },
          outputDirectory,
          timeoutMs: 1,
          runWorker: async (job) => {
            active += 1
            maximumActive = Math.max(maximumActive, active)
            calls.push(job.path)
            stagingDirectories.push(job.stagingDirectory)
            active -= 1
            if (job.path.endsWith('z-timeout.pdf')) {
              await writeFile(
                join(job.stagingDirectory, 'partial.epub'),
                'never publish',
              )
              return { status: 'timeout' }
            }
            return {
              status: 'completed',
              document: {
                basename: 'a-parser-failure.pdf',
                sha256: null,
                code: 'PDF_PARSE_FAILED',
                message:
                  'The PDF parser could not open the document; local path and document details were suppressed.',
              },
            }
          },
        })
        return {
          ...result,
          documents: result.report.documents,
          calls: calls.map((path) => basename(path)),
          maximumActive,
          stagingDirectories,
          directory,
          outputDirectory,
        }
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
    }

    const first = await run()
    const second = await run()
    try {
      expect(first.calls).toEqual(['z-timeout.pdf', 'a-parser-failure.pdf'])
      expect(first.maximumActive).toBe(1)
      expect(first.documents.map(({ basename }) => basename)).toEqual([
        'a-parser-failure.pdf',
        'z-timeout.pdf',
      ])
      expect(first.documents[1]).toEqual({
        basename: 'z-timeout.pdf',
        sha256: null,
        code: 'PDF_DOCUMENT_TIMEOUT',
        message:
          'The PDF exceeded the local per-document processing time limit.',
      })
      expect(first.documents).toEqual(second.documents)
      for (const stagingDirectory of first.stagingDirectories) {
        await expect(access(stagingDirectory)).rejects.toMatchObject({
          code: 'ENOENT',
        })
      }
      expect(await readdir(first.outputDirectory)).toEqual([
        'corpus-audit.json',
      ])

      const report = first.report
      const schema = JSON.parse(
        await readFile('docs/schemas/pdf-corpus-audit.schema.json', 'utf8'),
      )
      const validate = new Ajv2020({ strict: false }).compile(schema)
      expect(validate(report), validate.errors).toBe(true)
      expect(report.summary).toMatchObject({
        documents: 2,
        ready: 0,
        reviewRequired: 0,
        failed: 2,
        failureReasons: {
          PDF_DOCUMENT_TIMEOUT: 1,
          PDF_PARSE_FAILED: 1,
        },
      })
      expect(JSON.stringify(report)).not.toContain(first.directory)
    } finally {
      await Promise.all(
        [first.directory, second.directory].map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      )
    }
  })

  it('replaces arbitrary worker documents with schema-valid private failure rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-boundary-'))
    const outputDirectory = join(directory, 'output')
    const privateMarker = join(directory, 'must-not-escape')
    const failedPath = join(directory, 'failed.pdf')
    const auditedPath = resolve('tests/fixtures/pdf/born-digital.pdf')
    const diagnosticPath = join(directory, 'diagnostic.pdf')
    try {
      await copyFile(auditedPath, diagnosticPath)
      const { report, serialized } = await processExportDocuments({
        paths: [failedPath, auditedPath, diagnosticPath],
        corpusContract: null,
        policy: pipeline.policy,
        reportValidator,
        targetProfiles: [exportProfile('paperPro')],
        readableFallback: false,
        validator: { kind: 'skipped', reason: 'java-unavailable' },
        outputDirectory,
        timeoutMs: 30_000,
        runWorker: async (job) => {
          if (job.path === failedPath) {
            return {
              status: 'completed',
              document: {
                basename: basename(job.path),
                sha256: null,
                code: 'PDF_PARSE_FAILED',
                message: privateMarker,
                unexpectedPrivateValue: privateMarker,
              },
            }
          }
          const workerMessage = await runPdfExportWorkerJob(job)
          if (job.path === diagnosticPath) {
            workerMessage.document.diagnosticCounts = {
              PRIVATE_DIAGNOSTIC: 1,
            }
            workerMessage.document.diagnostics = [
              {
                code: 'PRIVATE_DIAGNOSTIC',
                severity: 'info',
                message: privateMarker,
              },
            ]
            return {
              status: 'completed',
              document: workerMessage.document,
            }
          }
          return {
            status: 'completed',
            document: {
              ...workerMessage.document,
              unexpectedPrivateValue: privateMarker,
            },
          }
        },
      })

      expect(report.summary).toMatchObject({
        documents: 3,
        ready: 0,
        reviewRequired: 0,
        failed: 3,
        failureReasons: { PDF_DOCUMENT_WORKER_FAILED: 3 },
      })
      expect(report.documents).toEqual([
        {
          basename: 'born-digital.pdf',
          sha256: null,
          code: 'PDF_DOCUMENT_WORKER_FAILED',
          message:
            'The PDF worker stopped without exposing local path or document details.',
        },
        {
          basename: 'diagnostic.pdf',
          sha256: null,
          code: 'PDF_DOCUMENT_WORKER_FAILED',
          message:
            'The PDF worker stopped without exposing local path or document details.',
        },
        {
          basename: 'failed.pdf',
          sha256: null,
          code: 'PDF_DOCUMENT_WORKER_FAILED',
          message:
            'The PDF worker stopped without exposing local path or document details.',
        },
      ])
      expect(serialized).not.toContain(privateMarker)
      expect(serialized).not.toContain(directory)
      expect(await readdir(outputDirectory)).toEqual(['corpus-audit.json'])
      expect(
        await readFile(join(outputDirectory, 'corpus-audit.json'), 'utf8'),
      ).toBe(serialized)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it.each([
    {
      name: 'artifact length above the parent cap',
      tamper: async ({ document }) => {
        document.exports[0].byteLength = MAX_STAGED_EPUB_BYTES + 1
      },
    },
    {
      name: 'missing ready artifact set',
      tamper: async ({ document, stagingDirectory }) => {
        document.exports = []
        await rm(stagingDirectory, { recursive: true, force: true })
        await mkdir(stagingDirectory)
      },
    },
    {
      name: 'one unexpected staging entry beyond the exact artifact set',
      tamper: async ({ stagingDirectory }) => {
        await writeFile(
          join(stagingDirectory, 'unexpected-worker-entry'),
          'must not be enumerated into parent memory',
        )
      },
    },
    {
      name: 'EPUB bytes',
      tamper: async ({ document, stagingDirectory }) => {
        await writeFile(
          join(stagingDirectory, document.exports[0].basename),
          'substituted EPUB bytes',
        )
      },
    },
    {
      name: 'non-canonical manifest bytes with valid recomputed checksums',
      tamper: async ({ document, stagingDirectory, privateMarker }) => {
        const manifestPath = join(stagingDirectory, 'export-manifest.json')
        const original = await readFile(manifestPath, 'utf8')
        const substituted = Buffer.from(
          original.replace(
            '{\n',
            `{\n  "privacy": ${JSON.stringify(privateMarker)},\n`,
          ),
        )
        await writeFile(manifestPath, substituted)
        await writeFile(
          join(stagingDirectory, 'checksums.sha256'),
          `${[
            ...document.exports.map(
              (artifact) => `${artifact.sha256}  ${artifact.basename}`,
            ),
            `${digest(substituted)}  export-manifest.json`,
          ].join('\n')}\n`,
        )
      },
    },
    {
      name: 'legacy export-manifest schema with valid recomputed checksums',
      tamper: async ({ document, stagingDirectory }) => {
        const manifestPath = join(stagingDirectory, 'export-manifest.json')
        const original = await readFile(manifestPath, 'utf8')
        const substituted = Buffer.from(
          original.replace(
            '"schemaVersion": "1.1.0"',
            '"schemaVersion": "1.0.0"',
          ),
        )
        expect(substituted.toString('utf8')).not.toBe(original)
        await writeFile(manifestPath, substituted)
        await writeFile(
          join(stagingDirectory, 'checksums.sha256'),
          `${[
            ...document.exports.map(
              (artifact) => `${artifact.sha256}  ${artifact.basename}`,
            ),
            `${digest(substituted)}  export-manifest.json`,
          ].join('\n')}\n`,
        )
      },
    },
    {
      name: 'checksum bytes',
      tamper: async ({ stagingDirectory }) => {
        await writeFile(
          join(stagingDirectory, 'checksums.sha256'),
          `${'0'.repeat(64)}  export-manifest.json\n`,
        )
      },
    },
  ])(
    'rejects substituted staged $name and publishes only the verified report',
    async ({ tamper }) => {
      const directory = await mkdtemp(join(tmpdir(), 'pdf-export-integrity-'))
      const outputDirectory = join(directory, 'output')
      const privateMarker = join(directory, 'manifest-private-marker')
      try {
        const { report, serialized } = await processExportDocuments({
          paths: [resolve('tests/fixtures/pdf/born-digital.pdf')],
          corpusContract: null,
          policy: pipeline.policy,
          reportValidator,
          targetProfiles: [exportProfile('paperPro')],
          readableFallback: false,
          validator: { kind: 'skipped', reason: 'java-unavailable' },
          outputDirectory,
          timeoutMs: 30_000,
          runWorker: async (job) => {
            const workerMessage = await runPdfExportWorkerJob(job)
            await tamper({
              document: workerMessage.document,
              stagingDirectory: job.stagingDirectory,
              privateMarker,
            })
            return {
              status: 'completed',
              document: workerMessage.document,
            }
          },
        })

        expect(report.summary).toMatchObject({
          documents: 1,
          ready: 0,
          reviewRequired: 1,
          failed: 0,
          failureReasons: { EXPORT_STAGING_INVALID: 1 },
        })
        expect(report.documents[0]).toMatchObject({
          basename: 'born-digital.pdf',
          exports: [],
          readiness: {
            ready: false,
            status: 'review-required',
            blockingDiagnosticCodes: expect.arrayContaining([
              'EXPORT_STAGING_INVALID',
            ]),
          },
          diagnosticCounts: { EXPORT_STAGING_INVALID: 1 },
          diagnostics: [
            expect.objectContaining({
              code: 'EXPORT_STAGING_INVALID',
              severity: 'error',
              message:
                'The audit produced a diagnostic whose document details were suppressed.',
            }),
          ],
        })
        expect(serialized).not.toContain(privateMarker)
        expect(serialized).not.toContain(directory)
        expect(await readdir(outputDirectory)).toEqual(['corpus-audit.json'])
        expect(
          await readFile(join(outputDirectory, 'corpus-audit.json'), 'utf8'),
        ).toBe(serialized)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    120_000,
  )

  it('rejects a non-empty output directory without modifying its contents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-nonempty-'))
    const outputDirectory = join(directory, 'output')
    const sentinelPath = join(outputDirectory, 'keep.txt')
    try {
      await mkdir(outputDirectory)
      await writeFile(sentinelPath, 'keep existing bytes')
      const result = runExport([
        'tests/fixtures/pdf/born-digital.pdf',
        '--target',
        'paperPro',
        '--out',
        outputDirectory,
      ])

      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Code: OUTPUT_DIRECTORY_NOT_EMPTY.')
      expect(await readdir(outputDirectory)).toEqual(['keep.txt'])
      expect(await readFile(sentinelPath, 'utf8')).toBe('keep existing bytes')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('requires an absent Windows output instead of a non-atomic empty-directory replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-windows-out-'))
    const missing = join(directory, 'missing')
    const empty = join(directory, 'empty')
    try {
      await mkdir(empty)
      await expect(assertPublishableOutput(missing, 'win32')).resolves.toBe(
        false,
      )
      await expect(assertPublishableOutput(empty, 'win32')).rejects.toThrow(
        'OUTPUT_DIRECTORY_MUST_BE_ABSENT',
      )
      await expect(assertPublishableOutput(empty, 'darwin')).resolves.toBe(true)
      expect(await readdir(empty)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('preserves absent and existing-empty outputs when a run fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-rollback-'))
    try {
      for (const existing of [false, true]) {
        const outputDirectory = join(
          directory,
          existing ? 'existing-empty' : 'absent',
        )
        if (existing) await mkdir(outputDirectory)

        await expect(
          processExportDocuments({
            paths: [join(directory, `${existing ? 'one' : 'two'}.pdf`)],
            corpusContract: null,
            policy: pipeline.policy,
            reportValidator,
            targetProfiles: [exportProfile('paperPro')],
            readableFallback: false,
            validator: { kind: 'skipped', reason: 'java-unavailable' },
            outputDirectory,
            timeoutMs: 1,
            runWorker: async () => ({
              status: 'fatal',
              code: 'PDF_CORPUS_CONTRACT_MISMATCH',
            }),
          }),
        ).rejects.toThrow('PDF_CORPUS_CONTRACT_MISMATCH')

        if (existing) {
          expect(await readdir(outputDirectory)).toEqual([])
        } else {
          await expect(access(outputDirectory)).rejects.toMatchObject({
            code: 'ENOENT',
          })
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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
        schemaVersion: '1.5.0',
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
        const metadata = report.documents[0].exports.find(
          (candidate) => candidate.target === target,
        )
        const bytes = new Uint8Array(
          await readFile(join(first, metadata.basename)),
        )
        expect(() => exportModules.inspectEpub(bytes, profile)).not.toThrow()
        const profileSlug = target
          .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
          .toLowerCase()
        expect(metadata).toMatchObject({
          byteLength: bytes.byteLength,
          sha256: digest(bytes),
          structuralValidation: 'passed',
          epubCheck: {
            status: expect.stringMatching(/^(?:passed|skipped)$/),
          },
        })
        expect(metadata.basename).toMatch(
          new RegExp(`^[a-z0-9-]+-${profileSlug}-[a-f0-9]{12}\\.epub$`),
        )
      }

      const firstFiles = (await readdir(first)).sort()
      const secondFiles = (await readdir(second)).sort()
      const artifactNames = report.documents[0].exports
        .map((artifact) => artifact.basename)
        .sort()
      expect(firstFiles).toEqual(
        [
          'checksums.sha256',
          'corpus-audit.json',
          'export-manifest.json',
          ...artifactNames,
        ].sort(),
      )
      expect(secondFiles).toEqual(firstFiles)
      for (const file of firstFiles) {
        expect(await readFile(join(first, file))).toEqual(
          await readFile(join(second, file)),
        )
      }

      const manifest = JSON.parse(
        await readFile(join(first, 'export-manifest.json'), 'utf8'),
      )
      expect(manifest.schemaVersion).toBe('1.1.0')
      const checksums = await readFile(join(first, 'checksums.sha256'), 'utf8')
      for (const file of [...artifactNames, 'export-manifest.json']) {
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
      expect(resolve(invocations[0][1])).toContain(resolve(directory))
      expect(invocations[0][1]).toMatch(
        /[/\\]workers[/\\][0-9]+[/\\]srt-epubcheck-/,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('fails before publishing artifacts when required EPUBCheck is unavailable', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'pdf-export-required-check-'),
    )
    const output = join(directory, 'output')
    try {
      const result = runExport(
        [
          'tests/fixtures/pdf/born-digital.pdf',
          '--target',
          'mobile',
          '--require-epubcheck',
          '--out',
          output,
        ],
        { env: { ...process.env, PATH: '' } },
      )

      expect(result.status).toBe(2)
      expect(result.stderr).toContain(
        'PDF export failed without publishing local path or document details.',
      )
      await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a substituted contract-bound corpus before creating output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-contract-'))
    const output = join(directory, 'output')
    try {
      const result = runExport([
        'tests/fixtures/pdf/born-digital.pdf',
        '--corpus-contract',
        'benchmarks/pdf/corpus-contract-v1.json',
        '--corpus-set',
        'seededRandom',
        '--out',
        output,
      ])

      expect(result.status).toBe(2)
      expect(result.stderr).toBe('PDF corpus contract binding failed.\n')
      expect(result.stdout).toBe('')
      await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' })
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
        schemaVersion: '1.5.0',
        reportSchema: 'docs/schemas/pdf-corpus-audit.schema.json',
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

  it('threads explicit local OCR through the isolated export worker without bypassing review', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-ocr-'))
    const output = join(directory, 'output')
    try {
      const result = runExport([
        'tests/fixtures/pdf/scanned-page.pdf',
        '--ocr-engine',
        'tesseract',
        '--target',
        'paperPro',
        '--out',
        output,
      ])

      expect(result.status, result.stderr).toBe(1)
      const report = JSON.parse(result.stdout)
      expect(report).toMatchObject({
        schemaVersion: '1.6.0',
        reportSchema: 'docs/schemas/pdf-corpus-audit-v1.6.schema.json',
        summary: {
          documents: 1,
          ready: 0,
          reviewRequired: 1,
          failed: 0,
          failureReasons: {
            LOW_CONFIDENCE_OCR: 1,
            OCR_REQUIRED: 1,
          },
        },
        documents: [
          {
            basename: 'scanned-page.pdf',
            ocr: [
              {
                page: 1,
                engine: 'tesseract.js',
                engineVersion: '6.0.1',
                model: 'tessdata_best_int',
                modelVersion: '4.0.0',
              },
            ],
            completeness: {
              sourceTextCharacters: expect.any(Number),
            },
            readiness: {
              ready: false,
              blockingDiagnosticCodes: expect.arrayContaining([
                'LOW_CONFIDENCE_OCR',
                'OCR_REQUIRED',
              ]),
            },
          },
        ],
      })
      expect(
        report.documents[0].completeness.sourceTextCharacters,
      ).toBeGreaterThan(0)
      expect(result.stdout).not.toContain('NO_RECONSTRUCTABLE_TEXT')
      expect(await readdir(output)).toEqual(['corpus-audit.json'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('exports an explicitly requested readable fallback with comparator-compatible artifact modes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-readable-'))
    const output = join(directory, 'output')
    try {
      const result = runExport([
        'tests/fixtures/pdf/adjudication-required.pdf',
        '--target',
        'mobile',
        '--target',
        'paperProMove',
        '--target',
        'paperPro',
        '--readable-fallback',
        '--out',
        output,
      ])

      expect(result.status, result.stderr).toBe(1)
      const report = JSON.parse(result.stdout)
      expect(report.summary).toMatchObject({
        documents: 1,
        ready: 0,
        reviewRequired: 1,
      })
      expect(report.documents[0].exports).toEqual([
        expect.objectContaining({
          target: 'mobile',
          basename: expect.stringMatching(
            /^adjudication-required-mobile-[a-f0-9]{12}-readable\.epub$/,
          ),
          mode: 'readable-fallback',
        }),
        expect.objectContaining({
          target: 'paperProMove',
          basename: expect.stringMatching(
            /^adjudication-required-paper-pro-move-[a-f0-9]{12}-readable\.epub$/,
          ),
          mode: 'readable-fallback',
        }),
        expect.objectContaining({
          target: 'paperPro',
          basename: expect.stringMatching(
            /^adjudication-required-paper-pro-[a-f0-9]{12}-readable\.epub$/,
          ),
          mode: 'readable-fallback',
        }),
      ])
      const schema = JSON.parse(
        await readFile('docs/schemas/pdf-corpus-audit.schema.json', 'utf8'),
      )
      const validate = new Ajv2020({ strict: false }).compile(schema)
      expect(validate(report), validate.errors).toBe(true)
      expect((await readdir(output)).sort()).toEqual(
        [
          'checksums.sha256',
          'corpus-audit.json',
          'export-manifest.json',
          ...report.documents[0].exports.map((artifact) => artifact.basename),
        ].sort(),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('emits ready artifact reports that the strict comparator accepts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-compare-'))
    const first = join(directory, 'first')
    const second = join(directory, 'second')
    const comparison = join(directory, 'comparison.json')
    try {
      for (const output of [first, second]) {
        const result = runExport([
          'tests/fixtures/pdf/born-digital.pdf',
          '--target',
          'mobile',
          '--target',
          'paperProMove',
          '--target',
          'paperPro',
          '--out',
          output,
        ])
        expect(result.status, result.stderr).toBe(0)
      }

      const compared = spawnSync(
        process.execPath,
        [
          'tools/pdf-benchmark-compare.mjs',
          join(first, 'corpus-audit.json'),
          join(second, 'corpus-audit.json'),
          '--out',
          comparison,
          '--require-identical-artifacts',
          '--require-identical-structure',
        ],
        { encoding: 'utf8', timeout: 120_000 },
      )

      expect(compared.status, compared.stderr).toBe(0)
      expect(
        JSON.parse(await readFile(comparison, 'utf8')).summary,
      ).toMatchObject({
        passed: true,
        regressed: 0,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('exports the structured born-digital fixture for both profiles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-export-structured-'))
    const output = join(directory, 'output')
    try {
      const result = runExport([
        'tests/fixtures/pdf/structured-scientific.pdf',
        '--out',
        output,
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
        const metadata = report.documents[0].exports.find(
          (candidate) => candidate.target === target,
        )
        const bytes = new Uint8Array(
          await readFile(join(output, metadata.basename)),
        )
        expect(() => exportModules.inspectEpub(bytes, profile)).not.toThrow()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

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
      const artifactFiles = (
        await readdir(join(output, outputEntries[1]))
      ).sort()
      expect(artifactFiles.filter((file) => !file.endsWith('.epub'))).toEqual([
        'checksums.sha256',
        'export-manifest.json',
      ])
      const epubFiles = artifactFiles.filter((file) => file.endsWith('.epub'))
      expect(epubFiles).toHaveLength(2)
      expect(epubFiles).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^[a-z0-9-]+-paper-pro-[a-f0-9]{12}\.epub$/),
          expect.stringMatching(
            /^[a-z0-9-]+-paper-pro-move-[a-f0-9]{12}\.epub$/,
          ),
        ]),
      )
      expect(result.stdout).not.toContain(resolve(directory))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
