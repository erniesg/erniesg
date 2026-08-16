import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import {
  DISPOSABLE_PDF_EPUBCHECK_JAR_SHA256,
  DISPOSABLE_PDF_EPUBCHECK_VERSION,
  DISPOSABLE_PDF_FIXTURE_PIN,
  DISPOSABLE_PDF_PROFILE_IDS,
  DISPOSABLE_PDF_UNRESOLVED_OBJECT_KINDS,
  DisposablePdfWorkerLifecycleError,
  createOwnedWorkerName,
  createSanitizedReceipt,
  parseDisposablePdfWorkerArguments,
  resolveCloudflareCredentials,
  runDisposablePdfWorkerLifecycle,
  validateBrowserReceipt,
  validateDeployOutput,
  validateFixturePin,
  validateOwnedWorkerName,
  validateTeardownProof,
} from './disposable-pdf-worker-lib.mjs'

const head = 'a'.repeat(40)
const nonce = 'b'.repeat(24)
const ownership = { expectedHead: head, nonce }
const workerName = createOwnedWorkerName(ownership)
const versionId = '123e4567-e89b-12d3-a456-426614174000'
const origin = `https://${workerName}.fixture.workers.dev`
const hash = (character) => character.repeat(64)
const cliPath = fileURLToPath(
  new URL('./disposable-pdf-worker.mjs', import.meta.url),
)

function deployOutput(overrides = {}) {
  return {
    workerName,
    versionId,
    head,
    url: origin,
    ...overrides,
  }
}

function profile(id, ordinal) {
  const artifact = hash(String(ordinal + 1))
  return {
    profileId: id,
    profileVersion: '1.1.0',
    artifactSha256: artifact,
    canonicalGraphSha256: hash('d'),
    canonicalNodeCount: 24,
    assetIndexSha256: hash(String(ordinal + 4)),
    assetCount: 3,
    visualRelationshipIndexSha256: hash('e'),
    visualRelationshipCount: 3,
    internalValidation: 'passed',
    epubCheck: {
      status: 'passed',
      version: DISPOSABLE_PDF_EPUBCHECK_VERSION,
      jarSha256: DISPOSABLE_PDF_EPUBCHECK_JAR_SHA256,
      failOnWarnings: true,
      warningCount: 0,
      errorCount: 0,
      skipCount: 0,
    },
  }
}

function browserReceipt(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    deployment: {
      exactHead: head,
      workerName,
      workerVersionId: versionId,
      runNonce: nonce,
      observedOrigin: origin,
    },
    source: {
      byteLength: DISPOSABLE_PDF_FIXTURE_PIN.byteLength,
      sha256: DISPOSABLE_PDF_FIXTURE_PIN.sha256,
    },
    profiles: DISPOSABLE_PDF_PROFILE_IDS.map(profile),
    semanticCompleteness: {
      textCoverage: 0.995,
      prose: 6,
      sections: 6,
      lists: 3,
      notes: 1,
      referencesOrCitations: 2,
      figures: 1,
      captions: 3,
      tables: 1,
      equations: 1,
      unresolvedObjectCount: 0,
      unresolvedObjects: Object.fromEntries(
        DISPOSABLE_PDF_UNRESOLVED_OBJECT_KINDS.map((key) => [key, 0]),
      ),
      unresolvedObjectsSha256: hash('f'),
      ocrRequiredPageCount: 0,
      readingOrderDiagnosticCount: 0,
      unresolvedCorruptingJoinCount: 0,
    },
    isolation: { crossRequest: 'passed', objectUrlCleanup: 'passed' },
    negativeInputs: 'passed',
    privacy: {
      sourceBearingRequestCount: 0,
      sourceBearingLogCount: 0,
      retainedSourceMarkerCount: 0,
    },
    ...overrides,
  }
}

function lifecycle(overrides = {}) {
  return {
    preflight: vi.fn(async () => undefined),
    build: vi.fn(async () => undefined),
    deploy: vi.fn(async () => deployOutput()),
    browser: vi.fn(async () => browserReceipt()),
    cleanup: vi.fn(async () => ({
      deleteAttempted: true,
      deploymentsAbsent: true,
      versionsAbsent: true,
      customDomains: [],
      remainingResources: [],
      urlUnavailable: true,
    })),
    ...overrides,
  }
}

describe('disposable Worker arguments and ownership', () => {
  it('parses split and inline arguments into one exact owned name', () => {
    expect(
      parseDisposablePdfWorkerArguments([
        '--expected-head',
        head,
        `--nonce=${nonce}`,
      ]),
    ).toEqual({
      expectedHead: head,
      nonce,
      workerName,
      fixture: { ...DISPOSABLE_PDF_FIXTURE_PIN },
    })
  })

  it.each([
    [],
    ['--expected-head', head],
    ['--expected-head', 'short', '--nonce', nonce],
    ['--expected-head', head, '--nonce', 'not-random'],
    ['--expected-head', head, '--nonce', nonce, '--unknown', 'value'],
    ['--expected-head', head, '--expected-head', head, '--nonce', nonce],
  ])(
    'rejects incomplete, malformed, duplicate, or unknown arguments',
    (argv) => {
      expect(() => parseDisposablePdfWorkerArguments(argv)).toThrowError(
        expect.objectContaining({ code: expect.any(String) }),
      )
    },
  )

  it('accepts only the exact name derived for this run', () => {
    expect(validateOwnedWorkerName(workerName, ownership)).toBe(workerName)
    for (const unsafe of [
      'erniesg-workers',
      'erniesg-workers-preview',
      `${workerName}-other`,
      workerName.replace(/b$/u, 'c'),
      '*',
    ]) {
      expect(() => validateOwnedWorkerName(unsafe, ownership)).toThrowError(
        expect.objectContaining({ code: 'UNOWNED_WORKER_NAME' }),
      )
    }
  })
})

describe('fixture and deployment pins', () => {
  it('accepts only the exact public fixture pin', () => {
    expect(validateFixturePin({ ...DISPOSABLE_PDF_FIXTURE_PIN })).toEqual(
      DISPOSABLE_PDF_FIXTURE_PIN,
    )
    for (const changed of [
      { path: '../private.pdf' },
      { byteLength: DISPOSABLE_PDF_FIXTURE_PIN.byteLength + 1 },
      { sha256: hash('f') },
      { license: 'private' },
    ]) {
      expect(() =>
        validateFixturePin({ ...DISPOSABLE_PDF_FIXTURE_PIN, ...changed }),
      ).toThrowError(expect.objectContaining({ code: 'FIXTURE_PIN_MISMATCH' }))
    }
  })

  it('validates the exact Worker, reviewed head, version, and workers.dev URL', () => {
    expect(
      validateDeployOutput(JSON.stringify(deployOutput()), ownership),
    ).toEqual(deployOutput())
  })

  it.each([
    { workerName: 'erniesg-workers' },
    { head: 'c'.repeat(40) },
    { versionId: 'short' },
    { url: 'https://ernie.sg' },
    { url: `https://${workerName}.fixture.workers.dev/?token=secret` },
  ])('rejects unbound or unsafe deploy output', (changed) => {
    expect(() =>
      validateDeployOutput(deployOutput(changed), ownership),
    ).toThrowError(expect.objectContaining({ code: expect.any(String) }))
  })
})

describe('Cloudflare authentication selection', () => {
  const token = 'oauth-token-for-deterministic-tests'
  const accountId = '1'.repeat(32)
  const whoami = {
    loggedIn: true,
    accounts: [{ id: accountId, name: 'fixture' }],
  }

  it('uses one authenticated OAuth account without copying stored auth files', () => {
    expect(
      resolveCloudflareCredentials({
        authTokenOutput: JSON.stringify({ type: 'oauth', token }),
        whoamiOutput: JSON.stringify(whoami),
      }),
    ).toEqual({ apiToken: token, accountId })
  })

  it('binds explicit token and account inputs to Wrangler identity', () => {
    expect(
      resolveCloudflareCredentials({
        apiToken: token,
        accountId: accountId.toUpperCase(),
        authTokenOutput: { type: 'api_token', token },
        whoamiOutput: whoami,
      }),
    ).toEqual({ apiToken: token, accountId })
  })

  it.each([
    {
      authTokenOutput: { type: 'oauth', token: 'short' },
      whoamiOutput: whoami,
    },
    {
      authTokenOutput: { type: 'oauth', token },
      whoamiOutput: {
        loggedIn: true,
        accounts: [{ id: accountId }, { id: '2'.repeat(32) }],
      },
    },
    {
      apiToken: `${token}-different`,
      authTokenOutput: { type: 'api_token', token },
      whoamiOutput: whoami,
    },
    {
      accountId: '2'.repeat(32),
      authTokenOutput: { type: 'oauth', token },
      whoamiOutput: whoami,
    },
  ])('rejects ambiguous or mismatched authentication', (candidate) => {
    expect(() => resolveCloudflareCredentials(candidate)).toThrowError(
      expect.objectContaining({ code: 'PREFLIGHT_FAILED' }),
    )
  })
})

describe('disposable Worker CLI safety', () => {
  it('refuses to overwrite an existing receipt before any lifecycle work', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'disposable-worker-cli-test-'),
    )
    const receiptPath = path.join(directory, 'receipt.json')
    try {
      await writeFile(receiptPath, 'preserve-me', { mode: 0o600 })
      const result = spawnSync(
        process.execPath,
        [cliPath, '--expected-head', head, '--receipt', receiptPath],
        { cwd: process.cwd(), encoding: 'utf8' },
      )
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Usage: disposable-pdf-worker.mjs')
      expect(await readFile(receiptPath, 'utf8')).toBe('preserve-me')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('browser and teardown receipts', () => {
  const browserContext = { ...ownership, workerName, versionId, origin }

  it('accepts the emitted receipt shape with profile-specific asset indexes', () => {
    const validated = validateBrowserReceipt(
      JSON.stringify(browserReceipt()),
      browserContext,
    )
    expect(validated.profiles.map(({ profileId }) => profileId)).toEqual(
      DISPOSABLE_PDF_PROFILE_IDS,
    )
    expect(
      new Set(
        validated.profiles.map(({ assetIndexSha256 }) => assetIndexSha256),
      ).size,
    ).toBe(3)
    expect(validated.semanticCompleteness).toMatchObject({
      textCoverage: 0.995,
      referencesOrCitations: 2,
      unresolvedObjectCount: 0,
      unresolvedObjects: Object.fromEntries(
        DISPOSABLE_PDF_UNRESOLVED_OBJECT_KINDS.map((key) => [key, 0]),
      ),
      ocrRequiredPageCount: 0,
      readingOrderDiagnosticCount: 0,
      unresolvedCorruptingJoinCount: 0,
    })
    expect(validated).toMatchObject({
      deployment: {
        exactHead: head,
        workerName,
        workerVersionId: versionId,
        runNonce: nonce,
        originSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      isolation: { crossRequest: 'passed', objectUrlCleanup: 'passed' },
      negativeInputs: 'passed',
      privacy: {
        sourceBearingRequestCount: 0,
        sourceBearingLogCount: 0,
        retainedSourceMarkerCount: 0,
      },
    })
    expect(JSON.stringify(validated)).not.toContain(origin)
  })

  it.each([0.99, 1.001, Number.NaN])(
    'rejects invalid text coverage %s',
    (textCoverage) => {
      expect(() =>
        validateBrowserReceipt(
          {
            ...browserReceipt(),
            semanticCompleteness: {
              ...browserReceipt().semanticCompleteness,
              textCoverage,
            },
          },
          browserContext,
        ),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_BROWSER_RECEIPT' }),
      )
    },
  )

  it.each([
    { exactHead: 'c'.repeat(40) },
    { workerName: 'erniesg-workers' },
    { workerVersionId: '123e4567-e89b-12d3-a456-426614174001' },
    { runNonce: 'c'.repeat(24) },
    { observedOrigin: `${origin}/` },
    { observedOrigin: 'https://ernie.sg' },
  ])('rejects browser evidence with an unbound deployment field', (changed) => {
    expect(() =>
      validateBrowserReceipt(
        {
          ...browserReceipt(),
          deployment: { ...browserReceipt().deployment, ...changed },
        },
        browserContext,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_BROWSER_RECEIPT' }))
  })

  it('requires explicit browser-observed deployment evidence', () => {
    const receipt = browserReceipt()
    Reflect.deleteProperty(receipt, 'deployment')
    expect(() => validateBrowserReceipt(receipt, browserContext)).toThrowError(
      expect.objectContaining({ code: 'INVALID_BROWSER_RECEIPT' }),
    )
  })

  it.each([
    () => ({ profiles: browserReceipt().profiles.slice(0, 2) }),
    () => ({
      profiles: browserReceipt().profiles.map((candidate, index) =>
        index === 0
          ? { ...candidate, internalValidation: 'failed' }
          : candidate,
      ),
    }),
    () => ({
      profiles: browserReceipt().profiles.map((candidate, index) =>
        index === 0
          ? {
              ...candidate,
              epubCheck: { ...candidate.epubCheck, version: 'v5.2.1' },
            }
          : candidate,
      ),
    }),
    () => ({
      profiles: browserReceipt().profiles.map((candidate, index) =>
        index === 0
          ? {
              ...candidate,
              epubCheck: { ...candidate.epubCheck, jarSha256: hash('0') },
            }
          : candidate,
      ),
    }),
    () => ({
      profiles: browserReceipt().profiles.map((candidate, index) =>
        index === 0
          ? {
              ...candidate,
              epubCheck: { ...candidate.epubCheck, failOnWarnings: false },
            }
          : candidate,
      ),
    }),
    () => ({
      profiles: browserReceipt().profiles.map((candidate, index) =>
        index === 0
          ? {
              ...candidate,
              epubCheck: { ...candidate.epubCheck, warningCount: 1 },
            }
          : candidate,
      ),
    }),
    () => ({
      semanticCompleteness: {
        ...browserReceipt().semanticCompleteness,
        referencesOrCitations: 0,
      },
    }),
    () => {
      const unresolvedObjects = {
        ...browserReceipt().semanticCompleteness.unresolvedObjects,
      }
      Reflect.deleteProperty(unresolvedObjects, 'assets')
      return {
        semanticCompleteness: {
          ...browserReceipt().semanticCompleteness,
          unresolvedObjects,
        },
      }
    },
    () => ({
      semanticCompleteness: {
        ...browserReceipt().semanticCompleteness,
        unresolvedObjectCount: 1,
      },
    }),
    () => ({
      semanticCompleteness: {
        ...browserReceipt().semanticCompleteness,
        unresolvedObjects: {
          ...browserReceipt().semanticCompleteness.unresolvedObjects,
          tables: 1,
        },
      },
    }),
    () => ({
      semanticCompleteness: {
        ...browserReceipt().semanticCompleteness,
        unresolvedObjects: {
          ...browserReceipt().semanticCompleteness.unresolvedObjects,
          unknown: 0,
        },
      },
    }),
    () => ({
      semanticCompleteness: {
        ...browserReceipt().semanticCompleteness,
        ocrRequiredPageCount: 1,
      },
    }),
    () => ({
      semanticCompleteness: {
        ...browserReceipt().semanticCompleteness,
        readingOrderDiagnosticCount: 1,
      },
    }),
    () => ({
      semanticCompleteness: {
        ...browserReceipt().semanticCompleteness,
        unresolvedCorruptingJoinCount: 1,
      },
    }),
    () => ({
      privacy: { ...browserReceipt().privacy, sourceBearingRequestCount: 1 },
    }),
    () => ({
      privacy: { ...browserReceipt().privacy, sourceBearingLogCount: 1 },
    }),
  ])(
    'rejects incomplete, invalid, unresolved, or privacy-failing evidence',
    (change) => {
      expect(() =>
        validateBrowserReceipt(
          { ...browserReceipt(), ...change() },
          browserContext,
        ),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_BROWSER_RECEIPT' }),
      )
    },
  )

  it('requires explicit deployment, version, domain, and URL teardown proof', () => {
    const proof = {
      deleteAttempted: true,
      deploymentsAbsent: true,
      versionsAbsent: true,
      customDomains: [],
      remainingResources: [],
      urlUnavailable: true,
    }
    expect(validateTeardownProof(proof, ownership)).toEqual({
      ...proof,
      remainingResources: [],
      verified: true,
    })
    for (const changed of [
      { deleteAttempted: false },
      { deploymentsAbsent: false },
      { versionsAbsent: false },
      { customDomains: ['ernie.sg'] },
      { remainingResources: [workerName] },
      { urlUnavailable: false },
    ]) {
      expect(() =>
        validateTeardownProof({ ...proof, ...changed }, ownership),
      ).toThrowError(expect.objectContaining({ code: 'TEARDOWN_NOT_PROVEN' }))
    }
  })
})

describe('sanitized lifecycle receipts', () => {
  it('copies only allowlisted assertions and hashes', () => {
    const browser = validateBrowserReceipt(browserReceipt(), {
      ...ownership,
      workerName,
      versionId,
      origin,
    })
    const receipt = createSanitizedReceipt({
      expectedHead: head,
      nonce,
      workerName,
      fixture: { ...DISPOSABLE_PDF_FIXTURE_PIN },
      deploy: deployOutput({
        stdout: 'SECRET-canary',
        url: origin,
      }),
      deploymentVerified: true,
      browser: {
        ...browser,
        sourceBytes: '%PDF PRIVATE SOURCE CANARY',
        downloadPath: '/home/private/paper.epub',
      },
      teardown: {
        deleteAttempted: true,
        deploymentsAbsent: true,
        versionsAbsent: true,
        customDomains: [],
        remainingResources: [],
        urlUnavailable: true,
        verified: true,
      },
      lockfileSha256: hash('7'),
      buildSha256: hash('8'),
      failures: [],
      environment: { CLOUDFLARE_API_TOKEN: 'SECRET-canary' },
    })
    expect(receipt.result).toBe('passed')
    expect(receipt.profiles).toHaveLength(3)
    expect(receipt.reconstruction).toMatchObject({
      unresolved_required_objects: 0,
      text_coverage: 0.995,
      privacy: { sourceBearingLogCount: 0 },
      semantic_completeness: {
        referencesOrCitations: 2,
        equations: 1,
        unresolved_objects: Object.fromEntries(
          DISPOSABLE_PDF_UNRESOLVED_OBJECT_KINDS.map((key) => [key, 0]),
        ),
        ocr_required_page_count: 0,
        reading_order_diagnostic_count: 0,
        unresolved_corrupting_join_count: 0,
      },
    })
    expect(receipt.worker).toMatchObject({
      name: workerName,
      version_id: versionId,
      deployment_verified: true,
      run_nonce: nonce,
      origin_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(receipt.profiles[0].epubcheck).toMatchObject({
      version: DISPOSABLE_PDF_EPUBCHECK_VERSION,
      jar_sha256: DISPOSABLE_PDF_EPUBCHECK_JAR_SHA256,
    })
    const serialized = JSON.stringify(receipt)
    for (const forbidden of [
      'SECRET-canary',
      '%PDF',
      '/home/private',
      'sourceBytes',
      'downloadPath',
      'environment',
      origin,
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('normalizes arbitrary failures without copying their messages', () => {
    const receipt = createSanitizedReceipt({
      expectedHead: head,
      nonce,
      workerName,
      fixture: { ...DISPOSABLE_PDF_FIXTURE_PIN },
      failures: [
        {
          stage: '/home/private/paper.pdf',
          code: 'SECRET_CANARY',
          message: '%PDF private bytes',
        },
      ],
    })
    expect(receipt).toMatchObject({
      result: 'failed',
      failures: [{ stage: 'lifecycle', code: 'LIFECYCLE_FAILED' }],
    })
    expect(receipt).not.toHaveProperty('lockfile_sha256')
    expect(receipt).not.toHaveProperty('build_sha256')
    expect(JSON.stringify(receipt)).not.toMatch(/SECRET|%PDF|\/home\/private/u)
  })

  it.each([
    { lockfileSha256: undefined },
    { buildSha256: undefined },
    { deploymentVerified: false },
    { failures: undefined },
    { teardown: { deleteAttempted: false } },
    { teardown: { deploymentsAbsent: false } },
    { teardown: { versionsAbsent: false } },
    { teardown: { urlUnavailable: false } },
  ])(
    'never passes without every lifecycle binding and teardown fact',
    (change) => {
      const browser = validateBrowserReceipt(browserReceipt(), {
        ...ownership,
        workerName,
        versionId,
        origin,
      })
      const teardown = {
        deleteAttempted: true,
        deploymentsAbsent: true,
        versionsAbsent: true,
        customDomains: [],
        remainingResources: [],
        urlUnavailable: true,
        verified: true,
        ...change.teardown,
      }
      const receipt = createSanitizedReceipt({
        expectedHead: head,
        nonce,
        workerName,
        fixture: { ...DISPOSABLE_PDF_FIXTURE_PIN },
        deploy: deployOutput(),
        browser,
        teardown,
        lockfileSha256: hash('7'),
        buildSha256: hash('8'),
        deploymentVerified: true,
        failures: [],
        ...Object.fromEntries(
          Object.entries(change).filter(([key]) => key !== 'teardown'),
        ),
      })
      expect(receipt.result).toBe('failed')
    },
  )

  it('retains safe evidence that teardown arrays were nonempty', () => {
    const receipt = createSanitizedReceipt({
      expectedHead: head,
      nonce,
      workerName,
      fixture: { ...DISPOSABLE_PDF_FIXTURE_PIN },
      deploy: deployOutput(),
      browser: validateBrowserReceipt(browserReceipt(), {
        ...ownership,
        workerName,
        versionId,
        origin,
      }),
      teardown: {
        deleteAttempted: true,
        deploymentsAbsent: true,
        versionsAbsent: true,
        customDomains: ['private.example'],
        remainingResources: ['SECRET-resource-name'],
        urlUnavailable: true,
        verified: true,
      },
      lockfileSha256: hash('7'),
      buildSha256: hash('8'),
      deploymentVerified: true,
      failures: [],
    })
    expect(receipt).toMatchObject({
      result: 'failed',
      teardown: {
        custom_domains: ['present'],
        remaining_resources: ['present'],
      },
    })
    expect(JSON.stringify(receipt)).not.toMatch(/private\.example|SECRET/u)
  })
})

describe('cleanup-on-failure lifecycle', () => {
  const context = {
    expectedHead: head,
    nonce,
    fixture: { ...DISPOSABLE_PDF_FIXTURE_PIN },
  }

  it('runs the injected stages in order and returns verified teardown', async () => {
    const order = []
    const dependencies = lifecycle({
      preflight: vi.fn(async () => order.push('preflight')),
      build: vi.fn(async () => order.push('build')),
      deploy: vi.fn(async () => {
        order.push('deploy')
        return deployOutput()
      }),
      browser: vi.fn(async () => {
        order.push('browser')
        return browserReceipt()
      }),
      cleanup: vi.fn(async () => {
        order.push('cleanup')
        return {
          deleteAttempted: true,
          deploymentsAbsent: true,
          versionsAbsent: true,
          customDomains: [],
          remainingResources: [],
          urlUnavailable: true,
        }
      }),
    })
    const result = await runDisposablePdfWorkerLifecycle(context, dependencies)
    expect(order).toEqual([
      'preflight',
      'build',
      'deploy',
      'browser',
      'cleanup',
    ])
    expect(result.teardown.verified).toBe(true)
  })

  it.each(['preflight', 'build'])(
    'does not clean up before deploy at %s',
    async (stage) => {
      const dependencies = lifecycle({
        [stage]: vi.fn(async () => {
          throw new Error('SECRET primary error')
        }),
      })
      const error = await runDisposablePdfWorkerLifecycle(
        context,
        dependencies,
      ).catch((caught) => caught)
      expect(error).toBeInstanceOf(DisposablePdfWorkerLifecycleError)
      expect(error.cleanupAttempted).toBe(false)
      expect(error.failures).toEqual([
        { stage, code: `${stage.toUpperCase()}_FAILED` },
      ])
      expect(dependencies.cleanup).not.toHaveBeenCalled()
    },
  )

  it.each(['deploy', 'browser'])(
    'cleans up after failure at %s',
    async (stage) => {
      const dependencies = lifecycle({
        [stage]: vi.fn(async () => {
          throw new Error('SECRET primary error')
        }),
      })
      const error = await runDisposablePdfWorkerLifecycle(
        context,
        dependencies,
      ).catch((caught) => caught)
      expect(error).toBeInstanceOf(DisposablePdfWorkerLifecycleError)
      expect(error.cleanupAttempted).toBe(true)
      expect(error.failures).toEqual([
        { stage, code: `${stage.toUpperCase()}_FAILED` },
      ])
      expect(dependencies.cleanup).toHaveBeenCalledOnce()
      expect(dependencies.cleanup).toHaveBeenCalledWith(
        expect.objectContaining({ workerName }),
      )
      expect(JSON.stringify(error)).not.toContain('SECRET primary error')
    },
  )

  it('preserves a primary failure and a sanitized cleanup failure', async () => {
    const dependencies = lifecycle({
      browser: vi.fn(async () => {
        throw new Error('private source path')
      }),
      cleanup: vi.fn(async () => {
        throw new Error('SECRET cleanup output')
      }),
    })
    const error = await runDisposablePdfWorkerLifecycle(
      context,
      dependencies,
    ).catch((caught) => caught)
    expect(error).toBeInstanceOf(DisposablePdfWorkerLifecycleError)
    expect(error.failures).toEqual([
      { stage: 'browser', code: 'BROWSER_FAILED' },
      { stage: 'cleanup', code: 'CLEANUP_FAILED' },
    ])
    expect(JSON.stringify(error)).not.toMatch(/private source|SECRET/u)
  })
})
