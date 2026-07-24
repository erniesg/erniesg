import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalJsonHash,
  createPdfLocalMacDoctorReceipt,
  inspectEpubCheckCapabilities,
  inspectJavaCapabilities,
  inspectLocalOcrCapabilities,
  inspectMineruCapabilities,
  inspectPdfLocalMacCapabilities,
  inspectVersionedExecutable,
  parseArguments,
  runDoctor,
} from './pdf-local-mac-doctor.mjs'

const doctorPath = fileURLToPath(
  new URL('./pdf-local-mac-doctor.mjs', import.meta.url),
)
const temporaryDirectories = []

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function unavailableTool(id) {
  return {
    id,
    available: false,
    reason: 'executable-unavailable',
    version: null,
    executableSha256: null,
    versionOutputSha256: null,
  }
}

function unavailableOcr() {
  return {
    ready: false,
    reason: 'local-assets-unavailable',
    offlineOnly: true,
    languages: ['eng'],
    engine: {
      id: 'tesseract.js',
      expectedVersion: '6.0.1',
      installedVersion: null,
      matches: false,
    },
    core: {
      id: 'tesseract.js-core',
      expectedVersion: '6.1.2',
      installedVersion: null,
      matches: false,
    },
    languagePackage: {
      id: '@tesseract.js-data/eng',
      expectedVersion: '1.0.0',
      installedVersion: null,
      matches: false,
    },
    rasterizer: {
      id: '@napi-rs/canvas',
      expectedVersion: '0.1.100',
      installedVersion: null,
      matches: false,
      nativeProbePassed: false,
    },
    model: {
      id: 'tessdata_best_int-eng',
      version: '4.0.0',
      sha256: null,
    },
    assets: {
      browserWorkerSha256: null,
      nodeWorkerSha256: null,
      coreLstmSha256: null,
      coreSimdLstmSha256: null,
    },
    browserReady: false,
    headlessReady: false,
  }
}

function unavailableEpubCheck() {
  return {
    id: 'epubcheck',
    available: false,
    reason: 'epubcheck-unavailable',
    mode: 'unavailable',
    version: null,
    executableSha256: null,
    jarSha256: null,
    versionOutputSha256: null,
    javaRequired: false,
  }
}

function unconfiguredMineru() {
  return {
    configured: false,
    toolReady: false,
    modelIdentityVerified: false,
    promotionAuthority: false,
    tool: {
      configured: false,
      ...unavailableTool('mineru'),
      reason: 'not-configured',
    },
    model: {
      configured: false,
      configurationValid: false,
      identityVerified: false,
      authority: 'not-configured',
      declaredIdSha256: null,
      declaredCheckpointSha256: null,
    },
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('owner-local Mac PDF capability doctor', () => {
  it('accepts only unique fail-closed requirement flags', () => {
    expect(parseArguments([])).toEqual({
      requireOcr: false,
      requireEpubCheck: false,
    })
    expect(parseArguments(['--require-ocr', '--require-epubcheck'])).toEqual({
      requireOcr: true,
      requireEpubCheck: true,
    })
    for (const arguments_ of [
      ['--unknown'],
      ['--require-ocr', '--require-ocr'],
      ['--require-epubcheck', '--require-epubcheck'],
    ]) {
      expect(() => parseArguments(arguments_)).toThrow('INVALID_USAGE')
    }
  })

  it('hashes the exact privacy-safe receipt and fails closed requirements', () => {
    const capabilities = {
      host: {
        platform: 'darwin',
        arch: 'arm64',
        macSupported: true,
      },
      node: {
        version: '24.14.1',
        required: '>=22.12.0',
        compatible: true,
      },
      ocr: unavailableOcr(),
      java: unavailableTool('java'),
      epubCheck: unavailableEpubCheck(),
      mineru: unconfiguredMineru(),
    }
    const receipt = createPdfLocalMacDoctorReceipt(capabilities, {
      requireOcr: true,
      requireEpubCheck: true,
    })
    const { receiptSha256, ...evidence } = receipt

    expect(receiptSha256).toBe(canonicalJsonHash(evidence))
    expect(receipt.requirements).toEqual({
      requireOcr: true,
      requireEpubCheck: true,
      satisfied: false,
      blockingReasons: ['local-headless-ocr-required', 'epubcheck-required'],
    })
    expect(receipt.lanes).toEqual({
      browser: { fullyLocal: false, networkRequired: false },
      headless: {
        fullyLocal: false,
        networkRequired: false,
        epubCheckAvailable: false,
      },
    })
  })

  it('reports exact pinned local OCR versions and content identities', async () => {
    const receipt = await inspectLocalOcrCapabilities()

    expect(receipt).toMatchObject({
      ready: true,
      reason: null,
      offlineOnly: true,
      languages: ['eng'],
      engine: {
        id: 'tesseract.js',
        expectedVersion: '6.0.1',
        installedVersion: '6.0.1',
        matches: true,
      },
      core: {
        expectedVersion: '6.1.2',
        installedVersion: '6.1.2',
        matches: true,
      },
      languagePackage: {
        expectedVersion: '1.0.0',
        installedVersion: '1.0.0',
        matches: true,
      },
      rasterizer: {
        expectedVersion: '0.1.100',
        installedVersion: '0.1.100',
        matches: true,
        nativeProbePassed: true,
      },
      model: {
        id: 'tessdata_best_int-eng',
        version: '4.0.0',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      browserReady: true,
      headlessReady: true,
    })
    expect(
      Object.values(receipt.assets).every((value) =>
        /^[a-f0-9]{64}$/u.test(value),
      ),
    ).toBe(true)

    const unavailable = await inspectLocalOcrCapabilities({
      resolveModule() {
        throw new Error('/Users/private-user/missing-asset')
      },
    })
    expect(unavailable).toMatchObject({
      ready: false,
      reason: 'local-assets-unavailable',
      browserReady: false,
      headlessReady: false,
    })
    expect(JSON.stringify(unavailable)).not.toContain('private-user')
  })

  it.runIf(process.platform !== 'win32')(
    'records command and jar validator versions without exposing local paths',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'pdf-local-mac-doctor-tools-'))
      temporaryDirectories.push(root)
      const binaryDirectory = join(root, 'Users', 'private-user', 'bin')
      await mkdir(binaryDirectory, { recursive: true })
      const javaPath = join(binaryDirectory, 'java')
      await writeFile(
        javaPath,
        [
          '#!/bin/sh',
          'if [ "$1" = "-version" ]; then',
          '  printf \'openjdk version "21.0.2"\\n\' >&2',
          '  exit 0',
          'fi',
          'if [ "$1" = "-jar" ]; then',
          '  printf "EPUBCheck v5.3.0\\n"',
          '  exit 0',
          'fi',
          'exit 91',
          '',
        ].join('\n'),
        { mode: 0o700 },
      )
      await chmod(javaPath, 0o700)
      const jarPath = join(root, 'Users', 'private-user', 'epubcheck.jar')
      await writeFile(jarPath, 'private-validator-bytes', { mode: 0o600 })
      const environment = {
        PATH: binaryDirectory,
        EPUBCHECK_JAR: jarPath,
      }
      const java = await inspectJavaCapabilities({ environment })
      const epubCheck = await inspectEpubCheckCapabilities({
        environment,
        javaObservation: java,
      })

      expect(java.capability).toMatchObject({
        available: true,
        version: '21.0.2',
        executableSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        versionOutputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      })
      expect(epubCheck).toEqual({
        id: 'epubcheck',
        available: true,
        reason: null,
        mode: 'jar',
        version: '5.3.0',
        executableSha256: null,
        jarSha256: hash('private-validator-bytes'),
        versionOutputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        javaRequired: true,
      })
      const serialized = JSON.stringify({ java: java.capability, epubCheck })
      expect(serialized).not.toContain(root)
      expect(serialized).not.toContain('private-user')
    },
  )

  it.runIf(process.platform !== 'win32')(
    'treats configured MinerU identity as owner evidence, not model authority',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'pdf-local-mac-doctor-mineru-'))
      temporaryDirectories.push(root)
      const mineruPath = join(root, 'private-user-mineru')
      await writeFile(
        mineruPath,
        '#!/bin/sh\nprintf "mineru, version 3.1.14\\n"\n',
        { mode: 0o700 },
      )
      await chmod(mineruPath, 0o700)
      const modelId = 'private-user-checkpoint'
      const checkpointSha256 = 'a'.repeat(64)
      const capability = await inspectMineruCapabilities({
        environment: {
          PATH: root,
          SRT_MINERU_BIN: mineruPath,
          SRT_MINERU_MODEL_ID: modelId,
          SRT_MINERU_MODEL_SHA256: checkpointSha256,
        },
      })

      expect(capability).toMatchObject({
        configured: true,
        toolReady: true,
        modelIdentityVerified: false,
        promotionAuthority: false,
        tool: {
          configured: true,
          available: true,
          version: '3.1.14',
          executableSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          versionOutputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        model: {
          configured: true,
          configurationValid: true,
          identityVerified: false,
          authority: 'owner-configured-unverified',
          declaredIdSha256: hash(modelId),
          declaredCheckpointSha256: checkpointSha256,
        },
      })
      expect(capability).not.toHaveProperty('ready')
      const serialized = JSON.stringify(capability)
      expect(serialized).not.toContain(root)
      expect(serialized).not.toContain(modelId)

      const invalid = await inspectMineruCapabilities({
        environment: {
          SRT_MINERU_MODEL_ID: '/Users/private-user/model',
          SRT_MINERU_MODEL_SHA256: 'not-a-checkpoint',
        },
      })
      expect(invalid).toMatchObject({
        configured: true,
        toolReady: false,
        modelIdentityVerified: false,
        promotionAuthority: false,
        model: {
          configured: true,
          configurationValid: false,
          identityVerified: false,
          authority: 'owner-configured-unverified',
          declaredCheckpointSha256: null,
        },
      })
      expect(JSON.stringify(invalid)).not.toContain('/Users/private-user')
    },
  )

  it('derives lane readiness and fail-closed exit status from inspected facts', async () => {
    const options = {
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: '24.14.1',
      inspectOcr: async () => unavailableOcr(),
      inspectJava: async () => ({
        capability: unavailableTool('java'),
        resolvedPath: null,
      }),
      inspectEpubCheck: async () => unavailableEpubCheck(),
      inspectMineru: async () => unconfiguredMineru(),
    }
    const optional = await runDoctor([], options)
    const required = await runDoctor(
      ['--require-ocr', '--require-epubcheck'],
      options,
    )

    expect(optional.exitCode).toBe(0)
    expect(optional.receipt.requirements.satisfied).toBe(true)
    expect(required.exitCode).toBe(1)
    expect(required.receipt.requirements).toMatchObject({
      satisfied: false,
      blockingReasons: ['local-headless-ocr-required', 'epubcheck-required'],
    })
  })

  it('emits byte-identical private receipts and CLI failures contain no paths', () => {
    const cleanEnvironment = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      LANG: process.env.LANG ?? 'C',
    }
    const run = (arguments_ = [], environment = cleanEnvironment) =>
      spawnSync(process.execPath, [doctorPath, ...arguments_], {
        encoding: 'utf8',
        env: environment,
        timeout: 30_000,
      })
    const first = run()
    const second = run()

    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    expect(first.stdout).toBe(second.stdout)
    const receipt = JSON.parse(first.stdout)
    const { receiptSha256, ...evidence } = receipt
    expect(receiptSha256).toBe(canonicalJsonHash(evidence))
    expect(receipt).toMatchObject({
      receiptKind: 'pdf-local-mac-capability',
      node: {
        version: process.versions.node,
        required: '>=22.12.0',
        compatible: true,
      },
      ocr: {
        ready: true,
        browserReady: true,
        headlessReady: true,
      },
      lanes: {
        browser: { networkRequired: false },
        headless: { networkRequired: false },
      },
    })
    expect(first.stdout).not.toContain(process.cwd())
    expect(first.stdout).not.toMatch(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)/u)

    const required = run(['--require-epubcheck'], {
      ...cleanEnvironment,
      PATH: '',
    })
    expect(required.status).toBe(1)
    expect(required.stderr).toBe('PDF_LOCAL_MAC_DOCTOR_REQUIREMENTS_UNMET\n')
    expect(JSON.parse(required.stdout).requirements).toMatchObject({
      requireEpubCheck: true,
      satisfied: false,
      blockingReasons: ['epubcheck-required'],
    })
    expect(required.stdout).not.toMatch(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)/u)

    const invalid = run(['--require-ocr', '--require-ocr'])
    expect(invalid.status).toBe(2)
    expect(invalid.stdout).toBe('')
    expect(invalid.stderr).toMatch(/^Usage:/u)
  })

  it('can assemble a complete inspected capability object without paths', async () => {
    const capabilities = await inspectPdfLocalMacCapabilities({
      environment: {
        PATH: process.env.PATH ?? '',
      },
    })
    const serialized = JSON.stringify(capabilities)

    expect(capabilities).toMatchObject({
      host: {
        platform: process.platform,
        arch: process.arch,
      },
      node: {
        version: process.versions.node,
        compatible: true,
      },
      ocr: {
        ready: true,
      },
      java: {
        id: 'java',
        available: expect.any(Boolean),
      },
      epubCheck: {
        id: 'epubcheck',
        available: expect.any(Boolean),
      },
      mineru: {
        configured: false,
        promotionAuthority: false,
      },
    })
    expect(serialized).not.toContain(process.cwd())
    expect(serialized).not.toMatch(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)/u)
  })

  it.runIf(process.platform !== 'win32')(
    'hashes an executable and its sanitized version observation',
    async () => {
      const root = await mkdtemp(
        join(tmpdir(), 'pdf-local-mac-doctor-command-'),
      )
      temporaryDirectories.push(root)
      const executable = join(root, 'local-tool')
      const bytes = '#!/bin/sh\nprintf "local-tool v7.8.9\\n"\n'
      await writeFile(executable, bytes, { mode: 0o700 })
      await chmod(executable, 0o700)
      const observed = await inspectVersionedExecutable(
        'local-tool',
        'local-tool',
        ['--version'],
        { environment: { PATH: root } },
      )

      expect(observed.capability).toMatchObject({
        id: 'local-tool',
        available: true,
        version: '7.8.9',
        executableSha256: hash(bytes),
        versionOutputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      })
      expect(JSON.stringify(observed.capability)).not.toContain(root)
      expect(await readFile(executable, 'utf8')).toBe(bytes)
    },
  )
})
