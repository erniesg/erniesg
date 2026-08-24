import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  acceptedBaselineSha256,
  fidelityReceipt,
  hash,
} from './pdf-private-fidelity.test-fixtures.mjs'
import {
  comparePrivateFidelityBaseline,
  comparePrivateFidelityReceipts,
  prepareOwnerOnlyDirectory,
  writeExclusive,
} from './pdf-private-fidelity.mjs'
import * as privateFidelity from './pdf-private-fidelity.mjs'

describe('private PDF fidelity runner', () => {
  it('rejects legacy private receipts that predate complete semantic evidence', () => {
    const legacy = fidelityReceipt()
    legacy.schemaVersion = '1.6.0'

    expect(() =>
      comparePrivateFidelityReceipts(
        legacy,
        fidelityReceipt(),
        acceptedBaselineSha256(legacy),
      ),
    ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')
  })

  it('rejects an invalid or locally unaccepted frozen receipt generically', () => {
    const invalidSchema = { ...fidelityReceipt(), schemaVersion: 'invalid' }
    const corruptHash = structuredClone(fidelityReceipt())
    corruptHash.runs[0].reconstructionReceiptSha256 = '0'.repeat(64)
    const locallyBlocked = fidelityReceipt({ ready: false })
    const emptyFallbackArtifact = fidelityReceipt({
      transformArtifact(value) {
        return {
          ...value,
          mode: 'readable-fallback',
          byteLength: 0,
          canonicalNodeCount: 0,
        }
      },
    })
    const invalidInlineCoverage = fidelityReceipt({
      transformReconstruction(source) {
        source.completeness.inlineSpanCoverage = 0.5
        return source
      },
    })
    const invalidCompletenessEvidence = [
      fidelityReceipt({
        transformReconstruction(source) {
          delete source.completeness.expectedHyperlinkCount
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.hyperlinkCoverage = 0.5
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.mappedHyperlinkCount = 2
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.textCoverage = 0.5
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.assetCoverage = 0.5
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.relationshipCoverage = 0.5
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.matchedTextCharacters = 101
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.exportedAssetCount = 2
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.resolvedRelationshipCount = 2
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.decidedLineBoundaryCount = 2
          return source
        },
      }),
    ]

    for (const baseline of [
      invalidSchema,
      corruptHash,
      locallyBlocked,
      emptyFallbackArtifact,
      invalidInlineCoverage,
      ...invalidCompletenessEvidence,
    ]) {
      expect(() =>
        comparePrivateFidelityReceipts(
          baseline,
          fidelityReceipt(),
          acceptedBaselineSha256(baseline),
        ),
      ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')
    }
  })

  it('rejects private readiness claims that contradict policy, completeness, diagnostics, or blockers', () => {
    const baseline = fidelityReceipt()
    const invalidCandidates = [
      fidelityReceipt({
        transformReconstruction(source) {
          source.readiness.blockingDiagnosticCodes = ['SOURCE_ERROR']
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.diagnostics.push({
            severity: 'error',
            code: 'SOURCE_ERROR',
          })
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.outputTextCharacters = 97
          source.completeness.matchedTextCharacters = 97
          source.completeness.textCoverage = 0.97
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.unresolvedObjectCount = 1
          source.completeness.unresolvedObjects.assets = 1
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.ocrRequiredPages = [1]
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.readingOrderDiagnostics = 1
          source.completeness.readingOrderEvaluation.unresolvedEdgeCount = 1
          source.completeness.readingOrderEvaluation.reviewRequired = true
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.readiness.ready = false
          source.readiness.status = 'review-required'
          return source
        },
      }),
    ]

    for (const candidate of invalidCandidates) {
      expect(() =>
        comparePrivateFidelityReceipts(
          baseline,
          candidate,
          acceptedBaselineSha256(baseline),
        ),
      ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')
    }
  })

  it('loads an external baseline without exposing its path or unexpected private fields', async () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-baseline-test-'),
    )
    const privatePath = join(
      temporaryDirectory,
      'operator frozen baseline private path.json',
    )
    const privateText = 'PRIVATE SOURCE TEXT MUST NEVER ESCAPE'
    try {
      const baseline = fidelityReceipt()
      const expectedBaselineSha256 = acceptedBaselineSha256(baseline)
      writeFileSync(privatePath, JSON.stringify(baseline))
      const comparison = await comparePrivateFidelityBaseline(
        privatePath,
        fidelityReceipt(),
        expectedBaselineSha256,
      )
      const serialized = JSON.stringify(comparison)
      expect(serialized).not.toContain(privatePath)
      expect(serialized).not.toContain('operator frozen baseline')

      writeFileSync(privatePath, JSON.stringify({ sourceText: privateText }))
      let failure
      try {
        await comparePrivateFidelityBaseline(
          privatePath,
          fidelityReceipt(),
          expectedBaselineSha256,
        )
      } catch (error) {
        failure = String(error)
      }
      expect(failure).toBe('Error: INVALID_PRIVATE_FIDELITY_BASELINE')
      expect(failure).not.toContain(privatePath)
      expect(failure).not.toContain(privateText)
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('requires a new external owner-only directory and exclusive artifact writes', async () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-output-test-'),
    )
    const output = join(temporaryDirectory, 'new-proof')
    const linkedOutput = join(temporaryDirectory, 'linked-proof')
    try {
      const created = await prepareOwnerOnlyDirectory(output)
      expect(statSync(created).mode & 0o077).toBe(0)
      await expect(prepareOwnerOnlyDirectory(created)).rejects.toThrow(
        'OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY',
      )
      symlinkSync(created, linkedOutput)
      await expect(prepareOwnerOnlyDirectory(linkedOutput)).rejects.toThrow(
        'OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY',
      )
      await expect(prepareOwnerOnlyDirectory('/')).rejects.toThrow(
        'OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY',
      )
      await expect(prepareOwnerOnlyDirectory(homedir())).rejects.toThrow(
        'OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY',
      )
      await expect(
        prepareOwnerOnlyDirectory(resolve('private-proof-inside-repository')),
      ).rejects.toThrow('OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY')

      const artifactPath = join(created, 'artifact.epub')
      await writeExclusive(artifactPath, new Uint8Array([1, 2, 3]))
      expect(statSync(artifactPath).mode & 0o077).toBe(0)
      await expect(
        writeExclusive(artifactPath, new Uint8Array([4, 5, 6])),
      ).rejects.toMatchObject({ code: 'EEXIST' })
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('does not expose an environment-sourced path when execution fails', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-fidelity-test-'),
    )
    const privatePath = join(temporaryDirectory, 'operator source.pdf')
    const outputDirectory = join(temporaryDirectory, 'proof')
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./pdf-private-fidelity.mjs', import.meta.url)),
          '--input-env',
          'SRT_PRIVATE_TEST_PDF',
          '--paper-id',
          'paper-v1',
          '--expected-size',
          '123',
          '--expected-sha256',
          hash,
          '--profiles',
          'mobile',
          '--repeat',
          '2',
          '--out',
          outputDirectory,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, SRT_PRIVATE_TEST_PDF: privatePath },
        },
      )
      const output = `${result.stdout}\n${result.stderr}`

      expect(result.status).toBe(2)
      expect(output).not.toContain(privatePath)
      expect(output).not.toContain('operator source.pdf')
      expect(output).toContain(
        'Private PDF fidelity validation failed without exposing local paths or source content.',
      )
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('emits only a safe error class, code, and message digest when diagnostic output is requested', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-fidelity-diagnostic-test-'),
    )
    const privatePath = join(temporaryDirectory, 'missing owner source.pdf')
    const outputDirectory = join(temporaryDirectory, 'proof')
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./pdf-private-fidelity.mjs', import.meta.url)),
          '--input-env',
          'SRT_PRIVATE_TEST_PDF',
          '--paper-id',
          'paper-v1',
          '--expected-size',
          '123',
          '--expected-sha256',
          hash,
          '--profiles',
          'mobile',
          '--repeat',
          '2',
          '--out',
          outputDirectory,
          '--safe-error-diagnostic',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, SRT_PRIVATE_TEST_PDF: privatePath },
        },
      )
      const output = `${result.stdout}\n${result.stderr}`
      const diagnosticLine = result.stderr
        .split('\n')
        .find((line) => line.startsWith('{'))

      expect(result.status).toBe(2)
      expect(diagnosticLine).toBeDefined()
      expect(JSON.parse(diagnosticLine)).toEqual({
        errorClass: 'Error',
        errorCode: 'ENOENT',
        messageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        stage: 'source-stat',
      })
      expect(output).not.toContain(privatePath)
      expect(output).not.toContain('missing owner source.pdf')
      expect(output).not.toContain('no such file')
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('does not reinterpret an arbitrary identifier-shaped error message as a diagnostic code', () => {
    expect(
      privateFidelity.safePrivateFailureDiagnostic(
        new Error('private-source.pdf'),
        'test-stage',
      ),
    ).toEqual({
      errorClass: 'Error',
      errorCode: 'UNCLASSIFIED',
      messageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      stage: 'test-stage',
    })
  })

  it('treats EPUBCheck warnings as a pre-publication failure in required mode', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-epubcheck-test-'),
    )
    const binaryDirectory = join(temporaryDirectory, 'bin')
    const argumentsLog = join(temporaryDirectory, 'epubcheck-arguments.jsonl')
    const outputDirectory = join(temporaryDirectory, 'proof')
    const inputPath = resolve('tests/fixtures/pdf/born-digital.pdf')
    const inputBytes = readFileSync(inputPath)
    const inputSha256 = createHash('sha256').update(inputBytes).digest('hex')
    try {
      mkdirSync(binaryDirectory)
      const fakeEpubCheck = join(binaryDirectory, 'epubcheck')
      writeFileSync(
        fakeEpubCheck,
        `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv.includes('--version')) process.exit(0)
appendFileSync(process.env.EPUBCHECK_ARGUMENTS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
process.exit(1)
`,
      )
      chmodSync(fakeEpubCheck, 0o755)

      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./pdf-private-fidelity.mjs', import.meta.url)),
          '--input-env',
          'SRT_PRIVATE_TEST_PDF',
          '--paper-id',
          'public-fixture',
          '--expected-size',
          String(inputBytes.byteLength),
          '--expected-sha256',
          inputSha256,
          '--profiles',
          'mobile',
          '--repeat',
          '2',
          '--out',
          outputDirectory,
          '--require-epubcheck',
          '--safe-error-diagnostic',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            EPUBCHECK_ARGUMENTS_LOG: argumentsLog,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
            SRT_PRIVATE_TEST_PDF: inputPath,
          },
          timeout: 120_000,
        },
      )
      const diagnostic = JSON.parse(
        result.stderr.split('\n').find((line) => line.startsWith('{')),
      )

      expect(result.status, result.stderr).toBe(2)
      expect(diagnostic).toMatchObject({
        errorClass: 'Error',
        errorCode: 'EPUBCHECK_FAILED',
        stage: 'epubcheck-validate',
      })
      expect(
        readFileSync(argumentsLog, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual([
        ['--failonwarnings', expect.stringMatching(/publication\.epub$/)],
      ])
      expect(readdirSync(outputDirectory)).toEqual([])
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(inputPath)
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }, 120_000)

  it('records every required EPUBCheck pass in the sanitized private receipt', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-epubcheck-pass-test-'),
    )
    const binaryDirectory = join(temporaryDirectory, 'bin')
    const argumentsLog = join(temporaryDirectory, 'epubcheck-arguments.jsonl')
    const outputDirectory = join(temporaryDirectory, 'proof')
    const inputPath = resolve('tests/fixtures/pdf/born-digital.pdf')
    const inputBytes = readFileSync(inputPath)
    const inputSha256 = createHash('sha256').update(inputBytes).digest('hex')
    try {
      mkdirSync(binaryDirectory)
      const fakeEpubCheck = join(binaryDirectory, 'epubcheck')
      writeFileSync(
        fakeEpubCheck,
        `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv.includes('--version')) process.exit(0)
appendFileSync(process.env.EPUBCHECK_ARGUMENTS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
`,
      )
      chmodSync(fakeEpubCheck, 0o755)

      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./pdf-private-fidelity.mjs', import.meta.url)),
          '--input-env',
          'SRT_PRIVATE_TEST_PDF',
          '--paper-id',
          'public-fixture',
          '--expected-size',
          String(inputBytes.byteLength),
          '--expected-sha256',
          inputSha256,
          '--profiles',
          'mobile',
          '--repeat',
          '2',
          '--out',
          outputDirectory,
          '--require-epubcheck',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            EPUBCHECK_ARGUMENTS_LOG: argumentsLog,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
            SRT_PRIVATE_TEST_PDF: inputPath,
          },
          timeout: 120_000,
        },
      )
      const receipt = JSON.parse(result.stdout)

      expect(result.status, result.stderr).toBe(1)
      expect(receipt).toMatchObject({
        schemaVersion: '1.9.0',
        execution: {
          epubCheckRequired: true,
          epubCheckPassedCount: 2,
          allEpubCheckPassed: true,
        },
      })
      expect(
        receipt.runs
          .flatMap((run) => run.artifacts)
          .map((artifact) => artifact.epubCheck),
      ).toEqual([{ status: 'passed' }, { status: 'passed' }])
      expect(readdirSync(outputDirectory).sort()).toEqual([
        'private-fidelity-receipt.json',
        'run-1-mobile.epub',
        'run-2-mobile.epub',
      ])
      expect(
        readFileSync(argumentsLog, 'utf8').trim().split('\n'),
      ).toHaveLength(2)
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }, 120_000)

  it('replays a hash-pinned empty decision set without exposing either local path', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-decisions-test-'),
    )
    const inputPath = resolve('tests/fixtures/pdf/born-digital.pdf')
    const inputBytes = readFileSync(inputPath)
    const inputSha256 = createHash('sha256').update(inputBytes).digest('hex')
    const decisionPath = join(temporaryDirectory, 'owner decisions.json')
    const decisionBytes = Buffer.from(
      `${JSON.stringify({
        schemaVersion: '1.1.0',
        documentSha256: inputSha256,
        decisions: [],
      })}\n`,
    )
    const decisionSha256 = createHash('sha256')
      .update(decisionBytes)
      .digest('hex')
    const outputDirectory = join(temporaryDirectory, 'proof')
    try {
      writeFileSync(decisionPath, decisionBytes, { mode: 0o600 })
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./pdf-private-fidelity.mjs', import.meta.url)),
          '--input-env',
          'SRT_PRIVATE_TEST_PDF',
          '--paper-id',
          'public-fixture',
          '--expected-size',
          String(inputBytes.byteLength),
          '--expected-sha256',
          inputSha256,
          '--profiles',
          'mobile',
          '--repeat',
          '2',
          '--out',
          outputDirectory,
          '--decisions-env',
          'SRT_PRIVATE_TEST_DECISIONS',
          '--expected-decisions-sha256',
          decisionSha256,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            SRT_PRIVATE_TEST_PDF: inputPath,
            SRT_PRIVATE_TEST_DECISIONS: decisionPath,
          },
          timeout: 120_000,
        },
      )
      const output = `${result.stdout}\n${result.stderr}`

      expect(result.status, result.stderr).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        decisionSetSha256: decisionSha256,
        execution: {
          reconstructionDeterministic: true,
          artifactsDeterministic: true,
          localValidationPassed: true,
        },
        baselineComparison: { status: 'not-configured', passed: false },
      })
      expect(output).not.toContain(inputPath)
      expect(output).not.toContain(decisionPath)
      expect(output).not.toContain('owner decisions.json')
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }, 120_000)
})
