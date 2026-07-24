import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createTargetFreeAdapterRequest,
  runPdfTargetFreeCandidateAcquisition,
  validatePdfTargetFreeCandidateReceipt,
  validatePdfTargetFreeCandidateRetainedOutputs,
} from './pdf-target-free-candidate-run.mjs'

const cliPath = fileURLToPath(
  new URL('./pdf-target-free-candidate-run.mjs', import.meta.url),
)
const readinessDocPath = fileURLToPath(
  new URL(
    '../docs/research/semantic-responsive-typesetting/pdf-benchmark-readiness.md',
    import.meta.url,
  ),
)
const receiptSchemaPath = fileURLToPath(
  new URL(
    '../docs/schemas/pdf-target-free-candidate-receipt.schema.json',
    import.meta.url,
  ),
)
const manifestPrivacy =
  'public-document-identities-only-no-source-content-layout-targets-or-gold'
const adapterEnvironmentKeys = [
  'HF_HUB_OFFLINE',
  'HOME',
  'LANG',
  'LC_ALL',
  'NO_PROXY',
  'PATH',
  'SRT_PDF_ADAPTER_SOURCE_SHA256',
  'SRT_PDF_CANDIDATE_ID',
  'SRT_PDF_CANDIDATE_VERSION',
  'SRT_PDF_TARGET_FREE_OFFLINE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TRANSFORMERS_OFFLINE',
  'no_proxy',
  ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : []),
].sort()
const sourceContents = [
  Buffer.from('%PDF-1.7\nowner local prose alpha\n%%EOF\n'),
  Buffer.from('%PDF-1.7\nowner local prose beta\n%%EOF\n'),
]

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function manifestFor(documents) {
  return {
    schemaVersion: '1.0.0',
    id: 'target-free-test-corpus',
    privacy: manifestPrivacy,
    documents,
  }
}

function fixtureAdapterSource(capturePath, { selfModify = false } = {}) {
  return `#!/usr/bin/env node
import { appendFile, readFile, realpath, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const values = {}
for (let index = 2; index < process.argv.length; index += 2) {
  values[process.argv[index].replace(/^--/, '')] = process.argv[index + 1]
}
const request = JSON.parse(await readFile(values.request, 'utf8'))
const source = await readFile(request.path)
const response = {
  schemaVersion: '1.0.0',
  documentId: request.documentId,
  sourceSha256: request.sha256,
  candidate: {
    id: process.env.SRT_PDF_CANDIDATE_ID,
    version: process.env.SRT_PDF_CANDIDATE_VERSION,
    format: 'fixture-document-graph',
    formatVersion: '1.0.0',
    adapterSourceSha256: process.env.SRT_PDF_ADAPTER_SOURCE_SHA256,
  },
  runtimeIdentity: {
    status: 'attested',
    tool: {
      id: 'fixture-layout-runner',
      version: '1.2.3',
      executableSha256: '${'a'.repeat(64)}',
      versionOutputSha256: '${'b'.repeat(64)}',
    },
    model: {
      id: 'fixture-layout-model',
      sha256: '${'c'.repeat(64)}',
    },
  },
  output: {
    observedByteLength: source.byteLength,
    sourceIdentity: request.sha256,
  },
}
const rawOutput = JSON.stringify(response)
await appendFile(
  ${JSON.stringify(capturePath)},
  JSON.stringify({
    request,
    rawOutput,
    offline: {
      srt: process.env.SRT_PDF_TARGET_FREE_OFFLINE,
      hf: process.env.HF_HUB_OFFLINE,
      transformers: process.env.TRANSFORMERS_OFFLINE,
      noProxy: process.env.NO_PROXY,
    },
    environment: {
      cwd: await realpath(process.cwd()),
      home: await realpath(process.env.HOME),
      tmpdir: await realpath(process.env.TMPDIR),
      tmp: await realpath(process.env.TMP),
      temp: await realpath(process.env.TEMP),
      path: process.env.PATH,
      ownerSecret: process.env.TARGET_FREE_OWNER_SECRET ?? null,
      keys: Object.keys(process.env).sort(),
    },
  }) + '\\n',
)
await writeFile(values.output, rawOutput, { flag: 'wx' })
${selfModify ? "await appendFile(fileURLToPath(import.meta.url), '\\n// source drift\\n')" : ''}
`
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'target-free-candidate-test-'))
  const inputRoot = join(directory, 'papers')
  const capturePath = join(directory, 'captured-requests.jsonl')
  const adapter = join(directory, 'fixture-adapter.mjs')
  const manifestPath = join(directory, 'manifest.json')
  const ownerHome = join(directory, 'owner-home')
  const ownerTemp = join(directory, 'owner-temp')
  const ownerPrivateBin = join(directory, 'owner-private-bin')
  await mkdir(inputRoot)
  await mkdir(ownerHome)
  await mkdir(ownerTemp)
  await mkdir(ownerPrivateBin)

  const documents = []
  for (let index = 0; index < sourceContents.length; index += 1) {
    const id = `paper-${index + 1}`
    const bytes = sourceContents[index]
    await writeFile(join(inputRoot, `${id}.pdf`), bytes)
    documents.push({
      id,
      byteLength: bytes.byteLength,
      sha256: digest(bytes),
    })
  }
  const manifest = manifestFor(documents)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(adapter, fixtureAdapterSource(capturePath), { mode: 0o700 })
  await chmod(adapter, 0o700)
  return {
    directory,
    inputRoot,
    capturePath,
    adapter,
    manifest,
    manifestPath,
    ownerHome,
    ownerTemp,
    ownerPrivateBin,
  }
}

function runOptions(fixture, overrides = {}) {
  return {
    manifest: fixture.manifestPath,
    inputRoot: fixture.inputRoot,
    adapter: fixture.adapter,
    candidateId: 'fixture-candidate',
    candidateVersion: 'exact-revision-1',
    output: join(fixture.directory, 'receipt.json'),
    rawOutputDirectory: join(fixture.directory, 'retained-raw-outputs'),
    timeoutSeconds: 30,
    ...overrides,
  }
}

function runCli(fixture, output, rawOutputDirectory = `${output}.raw`) {
  return spawnSync(
    process.execPath,
    [
      cliPath,
      'run',
      '--manifest',
      fixture.manifestPath,
      '--input-root-env',
      'TARGET_FREE_TEST_ROOT',
      '--adapter-env',
      'TARGET_FREE_TEST_ADAPTER',
      '--raw-output-dir-env',
      'TARGET_FREE_TEST_RAW_OUTPUTS',
      '--candidate-id',
      'fixture-candidate',
      '--candidate-version',
      'exact-revision-1',
      '--out',
      output,
      '--timeout-seconds',
      '30',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fixture.ownerHome,
        TMPDIR: fixture.ownerTemp,
        TMP: fixture.ownerTemp,
        TEMP: fixture.ownerTemp,
        PATH: [
          dirname(process.execPath),
          fixture.ownerPrivateBin,
          process.env.PATH,
        ].join(delimiter),
        TARGET_FREE_OWNER_SECRET: 'must-not-cross-adapter-boundary',
        TARGET_FREE_TEST_ROOT: fixture.inputRoot,
        TARGET_FREE_TEST_ADAPTER: fixture.adapter,
        TARGET_FREE_TEST_RAW_OUTPUTS: rawOutputDirectory,
      },
    },
  )
}

async function capturedRequests(path) {
  const value = await readFile(path, 'utf8')
  return value
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

describe('target-free PDF candidate acquisition', () => {
  it('constructs the exact four-key request without oracle metadata', () => {
    const request = createTargetFreeAdapterRequest({
      id: 'paper-1',
      path: '/owner-local/paper-1.pdf',
      byteLength: 123,
      sha256: 'd'.repeat(64),
    })

    expect(Object.keys(request).sort()).toEqual(
      ['documentId', 'path', 'byteLength', 'sha256'].sort(),
    )
    for (const forbidden of [
      'task',
      'stratum',
      'targetId',
      'page',
      'box',
      'gold',
      'expected',
      'reviewer',
    ]) {
      expect(JSON.stringify(request)).not.toContain(`"${forbidden}"`)
    }
  })

  it('runs once per document, binds provenance, and is byte-deterministic', async () => {
    const fixture = await createFixture()
    try {
      const firstPath = join(fixture.directory, 'receipt-first.json')
      const secondPath = join(fixture.directory, 'receipt-second.json')
      const firstRawOutputDirectory = join(fixture.directory, 'raw-first')
      const secondRawOutputDirectory = join(fixture.directory, 'raw-second')
      const firstRun = runCli(fixture, firstPath, firstRawOutputDirectory)
      expect(firstRun.status, firstRun.stderr).toBe(0)
      const firstReceipt = JSON.parse(await readFile(firstPath, 'utf8'))

      const firstCapture = await capturedRequests(fixture.capturePath)
      expect(firstCapture).toHaveLength(fixture.manifest.documents.length)
      for (const [index, captured] of firstCapture.entries()) {
        expect(Object.keys(captured.request).sort()).toEqual(
          ['documentId', 'path', 'byteLength', 'sha256'].sort(),
        )
        expect(captured.request).toMatchObject({
          documentId: fixture.manifest.documents[index].id,
          byteLength: fixture.manifest.documents[index].byteLength,
          sha256: fixture.manifest.documents[index].sha256,
        })
        expect(captured.offline).toEqual({
          srt: '1',
          hf: '1',
          transformers: '1',
          noProxy: '*',
        })
        expect(captured.environment).toMatchObject({
          home: captured.environment.cwd,
          tmpdir: captured.environment.cwd,
          tmp: captured.environment.cwd,
          temp: captured.environment.cwd,
          ownerSecret: null,
        })
        expect(captured.environment.home).not.toBe(fixture.ownerHome)
        expect(captured.environment.tmpdir).not.toBe(fixture.ownerTemp)
        expect(captured.environment.path).not.toContain(fixture.ownerPrivateBin)
        expect(captured.environment.keys).not.toContain(
          'TARGET_FREE_OWNER_SECRET',
        )
        expect(captured.environment.keys).toEqual(adapterEnvironmentKeys)
        expect(digest(Buffer.from(captured.rawOutput))).toBe(
          firstReceipt.documents[index].rawOutputSha256,
        )
        expect(Buffer.byteLength(captured.rawOutput)).toBe(
          firstReceipt.documents[index].rawOutputByteLength,
        )
        const retainedBytes = await readFile(
          join(
            firstRawOutputDirectory,
            `raw-output-${String(index + 1).padStart(6, '0')}.json`,
          ),
        )
        expect(retainedBytes).toEqual(Buffer.from(captured.rawOutput))
      }
      expect((await lstat(firstRawOutputDirectory)).mode & 0o777).toBe(0o700)
      expect(await readdir(firstRawOutputDirectory)).toEqual([
        'raw-output-000001.json',
        'raw-output-000002.json',
      ])
      for (const filename of await readdir(firstRawOutputDirectory)) {
        expect(
          (await lstat(join(firstRawOutputDirectory, filename))).mode & 0o777,
        ).toBe(0o600)
      }

      const secondRun = runCli(fixture, secondPath, secondRawOutputDirectory)
      expect(secondRun.status, secondRun.stderr).toBe(0)
      const secondReceipt = JSON.parse(await readFile(secondPath, 'utf8'))
      expect(secondReceipt).toEqual(firstReceipt)
      expect(await capturedRequests(fixture.capturePath)).toHaveLength(
        fixture.manifest.documents.length * 2,
      )

      expect(firstReceipt).toMatchObject({
        schemaVersion: '1.1.0',
        manifest: {
          id: fixture.manifest.id,
          documentCount: fixture.manifest.documents.length,
        },
        candidate: {
          id: 'fixture-candidate',
          version: 'exact-revision-1',
          format: 'fixture-document-graph',
          formatVersion: '1.0.0',
          adapterSource: {
            schemaVersion: '1.1.0',
            moduleCount: 1,
            packageFileCount: 0,
          },
          runtimeIdentity: {
            status: 'attested',
            tool: {
              id: 'fixture-layout-runner',
              version: '1.2.3',
              executableSha256: 'a'.repeat(64),
              versionOutputSha256: 'b'.repeat(64),
            },
            model: {
              id: 'fixture-layout-model',
              sha256: 'c'.repeat(64),
            },
          },
        },
        execution: {
          lane: 'owner-local-target-free-candidate-acquisition',
          environmentContract: 'minimal-env-scratch-cwd-home-temp',
          filesystemIsolation: 'not-sandboxed-host-filesystem-visible',
          networkIsolation: 'cooperative-offline-flags-not-enforced',
          isolationAttestation: 'absent',
          requestContract: 'document-id-path-byte-length-sha256-only',
          adapterInvocationCount: fixture.manifest.documents.length,
          allInputsVerified: true,
          runtimeIdentityAuthority: 'adapter-self-reported',
          rawOutputRetention:
            'owner-local-explicit-directory-0700-files-0600-no-overwrite',
        },
        promotionEligible: false,
      })
      expect(firstReceipt.documents).toHaveLength(
        fixture.manifest.documents.length,
      )
      expect(
        firstReceipt.documents.every(
          (item) =>
            /^[a-f0-9]{64}$/.test(item.rawOutputSha256) &&
            item.rawOutputByteLength > 0,
        ),
      ).toBe(true)
      const serialized = JSON.stringify(firstReceipt)
      expect(serialized).not.toContain(fixture.inputRoot)
      expect(serialized).not.toContain(fixture.capturePath)
      expect(serialized).not.toContain(firstRawOutputDirectory)
      expect(serialized).not.toContain('owner local prose')
      expect(serialized).not.toContain('must-not-cross-adapter-boundary')
      expect(firstRun.stdout).not.toContain(fixture.inputRoot)
      expect(firstRun.stdout).not.toContain(firstRawOutputDirectory)
      expect(firstRun.stdout).not.toContain('owner local prose')

      const validate = spawnSync(
        process.execPath,
        [
          cliPath,
          'validate',
          '--manifest',
          fixture.manifestPath,
          '--adapter-env',
          'TARGET_FREE_TEST_ADAPTER',
          '--raw-output-dir-env',
          'TARGET_FREE_TEST_RAW_OUTPUTS',
          '--receipt',
          firstPath,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TARGET_FREE_TEST_ADAPTER: fixture.adapter,
            TARGET_FREE_TEST_RAW_OUTPUTS: firstRawOutputDirectory,
          },
        },
      )
      expect(validate.status, validate.stderr).toBe(0)
      expect(JSON.parse(validate.stdout)).toEqual({
        valid: true,
        receiptSha256: firstReceipt.receiptSha256,
      })
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('fails closed instead of overwriting a retained-output directory or receipt', async () => {
    const fixture = await createFixture()
    try {
      const receiptPath = join(fixture.directory, 'no-overwrite-receipt.json')
      const rawOutputDirectory = join(fixture.directory, 'existing-raw')
      const sentinelPath = join(rawOutputDirectory, 'owner-sentinel')
      await mkdir(rawOutputDirectory, { mode: 0o700 })
      await writeFile(sentinelPath, 'keep-owner-bytes', { mode: 0o600 })

      const blocked = runCli(fixture, receiptPath, rawOutputDirectory)
      expect(blocked.status).toBe(2)
      expect(JSON.parse(blocked.stderr)).toEqual({
        status: 'failed',
        code: 'PDF_TARGET_FREE_RAW_OUTPUT_DIRECTORY_EXISTS_OR_INVALID',
      })
      expect(await readFile(sentinelPath, 'utf8')).toBe('keep-owner-bytes')
      await expect(lstat(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(fixture.capturePath)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(blocked.stderr).not.toContain(rawOutputDirectory)
      expect(blocked.stderr).not.toContain(fixture.inputRoot)
      expect(blocked.stderr).not.toContain('owner local prose')

      const firstRawOutputDirectory = join(fixture.directory, 'raw-complete')
      const first = runCli(fixture, receiptPath, firstRawOutputDirectory)
      expect(first.status, first.stderr).toBe(0)
      const retryRawOutputDirectory = join(fixture.directory, 'raw-retry')
      const blockedReceipt = runCli(
        fixture,
        receiptPath,
        retryRawOutputDirectory,
      )
      expect(blockedReceipt.status).toBe(2)
      expect(JSON.parse(blockedReceipt.stderr)).toEqual({
        status: 'failed',
        code: 'PDF_TARGET_FREE_RECEIPT_ALREADY_EXISTS',
      })
      await expect(lstat(retryRawOutputDirectory)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('replays retained bytes against receipt hashes and rejects mutation', async () => {
    const fixture = await createFixture()
    try {
      const receiptPath = join(fixture.directory, 'replay-receipt.json')
      const rawOutputDirectory = join(fixture.directory, 'replay-raw')
      const run = runCli(fixture, receiptPath, rawOutputDirectory)
      expect(run.status, run.stderr).toBe(0)
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))

      await expect(
        validatePdfTargetFreeCandidateRetainedOutputs(
          receipt,
          rawOutputDirectory,
        ),
      ).resolves.toEqual({
        valid: true,
        rawOutputIdentitySha256: receipt.execution.rawOutputIdentitySha256,
      })

      await writeFile(
        join(rawOutputDirectory, 'raw-output-000001.json'),
        '{"mutated":true}',
        { mode: 0o600 },
      )
      await expect(
        validatePdfTargetFreeCandidateRetainedOutputs(
          receipt,
          rawOutputDirectory,
        ),
      ).rejects.toThrow('INVALID_PDF_TARGET_FREE_RETAINED_OUTPUTS')

      const validate = spawnSync(
        process.execPath,
        [
          cliPath,
          'validate',
          '--manifest',
          fixture.manifestPath,
          '--adapter-env',
          'TARGET_FREE_TEST_ADAPTER',
          '--raw-output-dir-env',
          'TARGET_FREE_TEST_RAW_OUTPUTS',
          '--receipt',
          receiptPath,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TARGET_FREE_TEST_ADAPTER: fixture.adapter,
            TARGET_FREE_TEST_RAW_OUTPUTS: rawOutputDirectory,
          },
        },
      )
      expect(validate.status).toBe(2)
      expect(JSON.parse(validate.stderr)).toEqual({
        status: 'failed',
        code: 'INVALID_PDF_TARGET_FREE_RETAINED_OUTPUTS',
      })
      expect(validate.stderr).not.toContain(rawOutputDirectory)
      expect(validate.stderr).not.toContain(fixture.inputRoot)
      expect(validate.stderr).not.toContain('owner local prose')
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects a self-modifying adapter before binding its raw output', async () => {
    const fixture = await createFixture()
    try {
      await writeFile(
        fixture.adapter,
        fixtureAdapterSource(fixture.capturePath, { selfModify: true }),
        { mode: 0o700 },
      )
      await chmod(fixture.adapter, 0o700)
      const receiptPath = join(fixture.directory, 'drift-receipt.json')
      const rawOutputDirectory = join(fixture.directory, 'drift-raw')
      const run = runCli(fixture, receiptPath, rawOutputDirectory)

      expect(run.status).toBe(2)
      expect(JSON.parse(run.stderr)).toEqual({
        status: 'failed',
        code: 'PDF_TARGET_FREE_ADAPTER_SOURCE_DRIFT',
      })
      expect(await readdir(rawOutputDirectory)).toEqual([])
      await expect(lstat(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await capturedRequests(fixture.capturePath)).toHaveLength(1)
      expect(run.stderr).not.toContain(fixture.adapter)
      expect(run.stderr).not.toContain(fixture.inputRoot)
      expect(run.stderr).not.toContain('owner local prose')
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('fails closed on source hash, duplicate identity, and symlink escapes', async () => {
    const fixture = await createFixture()
    try {
      const wrongHash = structuredClone(fixture.manifest)
      wrongHash.documents[0].sha256 = 'e'.repeat(64)
      const wrongHashPath = join(fixture.directory, 'wrong-hash.json')
      await writeFile(wrongHashPath, JSON.stringify(wrongHash))
      await expect(
        runPdfTargetFreeCandidateAcquisition(
          runOptions(fixture, { manifest: wrongHashPath }),
        ),
      ).rejects.toThrow('PDF_TARGET_FREE_SOURCE_IDENTITY_MISMATCH')

      const duplicate = structuredClone(fixture.manifest)
      duplicate.documents[1].sha256 = duplicate.documents[0].sha256
      const duplicatePath = join(fixture.directory, 'duplicate.json')
      await writeFile(duplicatePath, JSON.stringify(duplicate))
      await expect(
        runPdfTargetFreeCandidateAcquisition(
          runOptions(fixture, { manifest: duplicatePath }),
        ),
      ).rejects.toThrow('INVALID_PDF_TARGET_FREE_CANDIDATE_RUN')

      const duplicateId = structuredClone(fixture.manifest)
      duplicateId.documents[1].id = duplicateId.documents[0].id
      const duplicateIdPath = join(fixture.directory, 'duplicate-id.json')
      await writeFile(duplicateIdPath, JSON.stringify(duplicateId))
      await expect(
        runPdfTargetFreeCandidateAcquisition(
          runOptions(fixture, { manifest: duplicateIdPath }),
        ),
      ).rejects.toThrow('INVALID_PDF_TARGET_FREE_CANDIDATE_RUN')

      const outside = join(fixture.directory, 'outside.pdf')
      await writeFile(outside, sourceContents[0])
      const linkedId = 'linked-paper'
      const linkedPath = join(fixture.inputRoot, `${linkedId}.pdf`)
      await symlink(outside, linkedPath)
      const linkedManifest = manifestFor([
        {
          id: linkedId,
          byteLength: sourceContents[0].byteLength,
          sha256: digest(sourceContents[0]),
        },
      ])
      const linkedManifestPath = join(fixture.directory, 'linked.json')
      await writeFile(linkedManifestPath, JSON.stringify(linkedManifest))
      await expect(
        runPdfTargetFreeCandidateAcquisition(
          runOptions(fixture, { manifest: linkedManifestPath }),
        ),
      ).rejects.toThrow('PDF_TARGET_FREE_SOURCE_IDENTITY_MISMATCH')

      await expect(lstat(fixture.capturePath)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects oracle-bearing manifests and any promotion-authority claim', async () => {
    const fixture = await createFixture()
    try {
      const oracleManifest = structuredClone(fixture.manifest)
      oracleManifest.documents[0].page = 1
      const oracleManifestPath = join(fixture.directory, 'oracle.json')
      await writeFile(oracleManifestPath, JSON.stringify(oracleManifest))
      await expect(
        runPdfTargetFreeCandidateAcquisition(
          runOptions(fixture, { manifest: oracleManifestPath }),
        ),
      ).rejects.toThrow('INVALID_PDF_TARGET_FREE_CANDIDATE_RUN')

      const receipt = await runPdfTargetFreeCandidateAcquisition(
        runOptions(fixture),
      )
      const promoted = structuredClone(receipt)
      promoted.promotionEligible = true
      await expect(
        validatePdfTargetFreeCandidateReceipt(
          promoted,
          await readFile(fixture.manifestPath),
        ),
      ).rejects.toThrow('INVALID_PDF_TARGET_FREE_CANDIDATE_RECEIPT')

      const scoringClaim = structuredClone(receipt)
      scoringClaim.passed = true
      await expect(
        validatePdfTargetFreeCandidateReceipt(
          scoringClaim,
          await readFile(fixture.manifestPath),
        ),
      ).rejects.toThrow('INVALID_PDF_TARGET_FREE_CANDIDATE_RECEIPT')
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('does not claim independent filesystem or network isolation', async () => {
    const fixture = await createFixture()
    try {
      const receipt = await runPdfTargetFreeCandidateAcquisition(
        runOptions(fixture),
      )
      expect(receipt.execution).toMatchObject({
        filesystemIsolation: 'not-sandboxed-host-filesystem-visible',
        networkIsolation: 'cooperative-offline-flags-not-enforced',
        isolationAttestation: 'absent',
      })
      expect(receipt.promotionEligible).toBe(false)

      const documentation = await readFile(readinessDocPath, 'utf8')
      expect(documentation).toContain(
        'Those process-hygiene measures are not a filesystem sandbox.',
      )
      expect(documentation).toContain(
        'offline environment flags do not enforce network denial',
      )
      expect(documentation).toContain('must supply and verify an external')
      expect(documentation).toContain('sandbox/network attestation')

      const receiptSchema = JSON.parse(
        await readFile(receiptSchemaPath, 'utf8'),
      )
      expect(receiptSchema.properties.schemaVersion.const).toBe('1.1.0')
      expect(
        receiptSchema.$defs.execution.properties.filesystemIsolation.const,
      ).toBe('not-sandboxed-host-filesystem-visible')
      expect(
        receiptSchema.$defs.execution.properties.networkIsolation.const,
      ).toBe('cooperative-offline-flags-not-enforced')
      expect(
        receiptSchema.$defs.execution.properties.isolationAttestation.const,
      ).toBe('absent')
      expect(
        receiptSchema.$defs.execution.properties.rawOutputRetention.const,
      ).toBe('owner-local-explicit-directory-0700-files-0600-no-overwrite')
    } finally {
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })
})
