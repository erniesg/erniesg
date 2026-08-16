#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  DISPOSABLE_PDF_FIXTURE_PIN,
  createSanitizedReceipt,
  parseDisposablePdfWorkerArguments,
  resolveCloudflareCredentials,
  validateBrowserReceipt,
  validateDeployOutput,
  validateTeardownProof,
} from './disposable-pdf-worker-lib.mjs'

const WRANGLER_VERSION = '4.113.0'
const COMPATIBILITY_DATE = '2026-07-11'
const CONTRACT_PATH = 'tests/fixtures/pdf/pdf-to-epub-fidelity.contract.json'
const CONTRACT_SHA256 =
  'db531134a4274520c1dfdc694de2e1b1fd2c51876392871494260c680c275953'
const MANIFEST_PATH = 'tests/fixtures/pdf/manifest.json'
const MANIFEST_SHA256 =
  '7d308b80909a7bb718f7feb2cabc5abc36bb3527be09dbe7354f59ba379455b5'
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
const MAX_ASSET_FILES = 25_000
const MAX_ASSET_FILE_BYTES = 25 * 1024 * 1024
const MAX_ASSET_TOTAL_BYTES = 100 * 1024 * 1024
const NOT_FOUND_CODES = new Set([10007, 10090])
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

class CliFailure extends Error {
  constructor(code, exitCode = 1) {
    super('Disposable Worker validation failed.')
    this.name = 'CliFailure'
    this.code = code
    this.exitCode = exitCode
  }
}

function fail(code, exitCode = 1) {
  throw new CliFailure(code, exitCode)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

function stageFailure(stage) {
  return {
    stage,
    code: `${stage.replaceAll('-', '_').toUpperCase()}_FAILED`,
  }
}

function parseCliArguments(argv) {
  const values = {}
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    if (typeof raw !== 'string' || !raw.startsWith('--')) {
      fail('INVALID_ARGUMENTS')
    }
    const equals = raw.indexOf('=')
    const flag = equals === -1 ? raw : raw.slice(0, equals)
    const key =
      flag === '--expected-head'
        ? 'expectedHead'
        : flag === '--receipt'
          ? 'receipt'
          : null
    if (!key || seen.has(key)) fail('INVALID_ARGUMENTS')
    const inline = equals === -1 ? undefined : raw.slice(equals + 1)
    const value = inline ?? argv[index + 1]
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      (inline === undefined && value.startsWith('--'))
    ) {
      fail('INVALID_ARGUMENTS')
    }
    values[key] = value
    seen.add(key)
    if (inline === undefined) index += 1
  }
  if (!seen.has('expectedHead') || !seen.has('receipt')) {
    fail('INVALID_ARGUMENTS')
  }

  const nonce = randomBytes(12).toString('hex')
  const context = parseDisposablePdfWorkerArguments([
    '--expected-head',
    values.expectedHead,
    '--nonce',
    nonce,
  ])
  return { ...context, receiptArgument: values.receipt }
}

async function canonicalProspectivePath(candidate) {
  const suffix = []
  let cursor = path.resolve(candidate)
  while (true) {
    try {
      const metadata = await lstat(cursor)
      if (metadata.isSymbolicLink()) fail('INVALID_ARGUMENTS')
      const base = await realpath(cursor)
      return path.resolve(base, ...suffix.reverse())
    } catch (error) {
      if (error instanceof CliFailure) throw error
      if (error?.code !== 'ENOENT') fail('INVALID_ARGUMENTS')
      const parent = path.dirname(cursor)
      if (parent === cursor) fail('INVALID_ARGUMENTS')
      suffix.push(path.basename(cursor))
      cursor = parent
    }
  }
}

async function validateReceiptDestination(receiptArgument) {
  const repositoryRoot = await realpath(REPOSITORY_ROOT)
  const evidenceRoot = await canonicalProspectivePath(
    path.join(repositoryRoot, '.agent', 'evidence'),
  )
  const receiptPath = await canonicalProspectivePath(
    path.resolve(process.cwd(), receiptArgument),
  )
  if (
    receiptPath === repositoryRoot ||
    receiptPath === evidenceRoot ||
    (isWithin(repositoryRoot, receiptPath) &&
      !isWithin(evidenceRoot, receiptPath))
  ) {
    fail('INVALID_ARGUMENTS')
  }

  let existing
  try {
    existing = await lstat(receiptPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') fail('INVALID_ARGUMENTS')
  }
  if (existing) fail('INVALID_ARGUMENTS')
  const parent = await stat(path.dirname(receiptPath)).catch(() => null)
  if (!parent?.isDirectory()) fail('INVALID_ARGUMENTS')
  return receiptPath
}

async function safeTemporaryBase() {
  const repositoryRoot = await realpath(REPOSITORY_ROOT)
  const temporaryBase = await realpath(tmpdir()).catch(() => null)
  const metadata = temporaryBase
    ? await stat(temporaryBase).catch(() => null)
    : null
  if (!temporaryBase || !metadata?.isDirectory()) fail('PREFLIGHT_FAILED')
  if (isWithin(repositoryRoot, temporaryBase)) fail('PREFLIGHT_FAILED')
  return temporaryBase
}

let activeChild = null
let interrupted = false

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = true
    activeChild?.kill('SIGTERM')
  })
}

async function runProcess(
  command,
  args,
  { cwd, env, timeoutMs, captureStdout = false, allowInterrupted = false },
) {
  if (interrupted && !allowInterrupted) fail('LIFECYCLE_FAILED')
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'ignore'],
    })
    activeChild = child
    const chunks = []
    let capturedBytes = 0
    let captureExceeded = false
    child.stdout?.on('data', (chunk) => {
      capturedBytes += chunk.length
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        captureExceeded = true
        child.kill('SIGTERM')
        return
      }
      chunks.push(chunk)
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }, timeoutMs)
    timer.unref()
    child.once('error', () => {
      clearTimeout(timer)
      if (activeChild === child) activeChild = null
      rejectPromise(new CliFailure('PROCESS_FAILED', 2))
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      if (activeChild === child) activeChild = null
      resolvePromise({
        ok: exitCode === 0 && signal === null && !captureExceeded,
        stdout: captureStdout ? Buffer.concat(chunks).toString('utf8') : '',
      })
    })
  })
}

function basicEnvironment(home) {
  const environment = Object.fromEntries(
    ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'NODE_EXTRA_CA_CERTS']
      .filter((key) => typeof process.env[key] === 'string')
      .map((key) => [key, process.env[key]]),
  )
  return {
    ...environment,
    HOME: home,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CI: '1',
    NO_COLOR: '1',
  }
}

async function runChecked(command, args, options, code, exitCode = 1) {
  const result = await runProcess(command, args, options)
  if (!result.ok) fail(code, exitCode)
  return result.stdout
}

async function gitOutput(args) {
  return await runChecked(
    'git',
    args,
    {
      cwd: REPOSITORY_ROOT,
      env: basicEnvironment(REPOSITORY_ROOT),
      timeoutMs: 30_000,
      captureStdout: true,
    },
    'INVALID_REVIEWED_HEAD',
    4,
  )
}

async function requireExactCleanCheckout(expectedHead) {
  const [repositoryRoot, head, statusOutput] = await Promise.all([
    gitOutput(['rev-parse', '--show-toplevel']),
    gitOutput(['rev-parse', '--verify', 'HEAD']),
    gitOutput([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ]),
  ])
  if (
    (await realpath(repositoryRoot.trim())) !==
      (await realpath(REPOSITORY_ROOT)) ||
    head.trim() !== expectedHead ||
    statusOutput !== ''
  ) {
    fail('INVALID_REVIEWED_HEAD', 4)
  }
}

async function readPinnedFile(relativePath, maximumBytes) {
  const absolutePath = path.join(REPOSITORY_ROOT, relativePath)
  const metadata = await lstat(absolutePath).catch(() => null)
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maximumBytes
  ) {
    fail('FIXTURE_PIN_MISMATCH')
  }
  return await readFile(absolutePath)
}

async function verifyRepositoryPins() {
  const [fixture, contractBytes, manifestBytes, lockfileBytes] =
    await Promise.all([
      readPinnedFile(
        DISPOSABLE_PDF_FIXTURE_PIN.path,
        DISPOSABLE_PDF_FIXTURE_PIN.byteLength,
      ),
      readPinnedFile(CONTRACT_PATH, 1024 * 1024),
      readPinnedFile(MANIFEST_PATH, 2 * 1024 * 1024),
      readPinnedFile('package-lock.json', 4 * 1024 * 1024),
    ])
  if (
    fixture.byteLength !== DISPOSABLE_PDF_FIXTURE_PIN.byteLength ||
    sha256(fixture) !== DISPOSABLE_PDF_FIXTURE_PIN.sha256 ||
    sha256(contractBytes) !== CONTRACT_SHA256 ||
    sha256(manifestBytes) !== MANIFEST_SHA256
  ) {
    fail('FIXTURE_PIN_MISMATCH')
  }

  let contract
  let manifest
  try {
    contract = JSON.parse(contractBytes.toString('utf8'))
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    fail('FIXTURE_PIN_MISMATCH')
  }
  const entries = Array.isArray(manifest?.fixtures)
    ? manifest.fixtures.filter(
        (candidate) =>
          candidate?.file === path.basename(DISPOSABLE_PDF_FIXTURE_PIN.path),
      )
    : []
  if (
    contract?.fixture !== path.basename(DISPOSABLE_PDF_FIXTURE_PIN.path) ||
    contract?.license !== DISPOSABLE_PDF_FIXTURE_PIN.license ||
    contract?.byteLength !== DISPOSABLE_PDF_FIXTURE_PIN.byteLength ||
    contract?.sourceSha256 !== DISPOSABLE_PDF_FIXTURE_PIN.sha256 ||
    manifest?.license !== DISPOSABLE_PDF_FIXTURE_PIN.license ||
    entries.length !== 1 ||
    entries[0].contract !== path.basename(CONTRACT_PATH) ||
    entries[0].contractSha256 !== CONTRACT_SHA256 ||
    entries[0].byteLength !== DISPOSABLE_PDF_FIXTURE_PIN.byteLength ||
    entries[0].sha256 !== DISPOSABLE_PDF_FIXTURE_PIN.sha256
  ) {
    fail('FIXTURE_PIN_MISMATCH')
  }
  return { lockfileSha256: sha256(lockfileBytes) }
}

async function verifyLocalTools() {
  const wranglerPackagePath = path.join(
    REPOSITORY_ROOT,
    'node_modules',
    'wrangler',
    'package.json',
  )
  const wranglerBin = path.join(
    REPOSITORY_ROOT,
    'node_modules',
    'wrangler',
    'bin',
    'wrangler.js',
  )
  const playwrightBin = path.join(
    REPOSITORY_ROOT,
    'node_modules',
    '@playwright',
    'test',
    'cli.js',
  )
  let wranglerPackage
  try {
    wranglerPackage = JSON.parse(await readFile(wranglerPackagePath, 'utf8'))
  } catch {
    fail('BUILD_FAILED', 2)
  }
  for (const executable of [wranglerBin, playwrightBin]) {
    const metadata = await lstat(executable).catch(() => null)
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      fail('BUILD_FAILED', 2)
    }
  }
  if (wranglerPackage.version !== WRANGLER_VERSION) {
    fail('BUILD_FAILED', 2)
  }
  return { wranglerBin, playwrightBin }
}

async function snapshotDirectory(sourceRoot, snapshotRoot) {
  const sourceMetadata = await lstat(sourceRoot).catch(() => null)
  if (!sourceMetadata?.isDirectory() || sourceMetadata.isSymbolicLink()) {
    fail('BUILD_FAILED')
  }
  await mkdir(snapshotRoot, { mode: 0o700 })
  const index = []
  let totalBytes = 0

  async function visit(sourceDirectory, targetDirectory, relativeDirectory) {
    const entries = await readdir(sourceDirectory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name
      const sourcePath = path.join(sourceDirectory, entry.name)
      const targetPath = path.join(targetDirectory, entry.name)
      const metadata = await lstat(sourcePath)
      if (metadata.isSymbolicLink()) fail('BUILD_FAILED')
      if (metadata.isDirectory()) {
        await mkdir(targetPath, { mode: 0o700 })
        await visit(sourcePath, targetPath, relativePath)
        continue
      }
      if (!metadata.isFile() || metadata.size > MAX_ASSET_FILE_BYTES) {
        fail('BUILD_FAILED')
      }
      if (index.length >= MAX_ASSET_FILES) fail('BUILD_FAILED')
      totalBytes += metadata.size
      if (totalBytes > MAX_ASSET_TOTAL_BYTES) fail('BUILD_FAILED')

      let sourceHandle
      let targetHandle
      try {
        sourceHandle = await open(
          sourcePath,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        )
        const opened = await sourceHandle.stat()
        if (!opened.isFile() || opened.size !== metadata.size) {
          fail('BUILD_FAILED')
        }
        const bytes = await sourceHandle.readFile()
        const afterRead = await sourceHandle.stat()
        if (
          afterRead.size !== opened.size ||
          afterRead.mtimeMs !== opened.mtimeMs ||
          afterRead.ino !== opened.ino ||
          bytes.byteLength !== opened.size
        ) {
          fail('BUILD_FAILED')
        }
        targetHandle = await open(
          targetPath,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_NOFOLLOW,
          0o600,
        )
        await targetHandle.writeFile(bytes)
        index.push({
          path: relativePath,
          byteLength: bytes.byteLength,
          sha256: sha256(bytes),
        })
      } finally {
        await sourceHandle?.close().catch(() => {})
        await targetHandle?.close().catch(() => {})
      }
    }
  }

  await visit(sourceRoot, snapshotRoot, '')
  if (index.length === 0) fail('BUILD_FAILED')
  index.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return sha256(Buffer.from(JSON.stringify(index)))
}

function existingCloudflareAuthEnvironment(apiToken, accountId) {
  const environment = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_RUNTIME_DIR',
      'DBUS_SESSION_BUS_ADDRESS',
      'LANG',
      'LC_ALL',
      'TZ',
      'TMPDIR',
      'NODE_EXTRA_CA_CERTS',
    ]
      .filter((key) => typeof process.env[key] === 'string')
      .map((key) => [key, process.env[key]]),
  )
  if (apiToken !== undefined) environment.CLOUDFLARE_API_TOKEN = apiToken
  if (accountId !== undefined) environment.CLOUDFLARE_ACCOUNT_ID = accountId
  return {
    ...environment,
    CI: '1',
    NO_COLOR: '1',
    WRANGLER_LOG_SANITIZE: 'true',
    WRANGLER_SEND_METRICS: 'false',
  }
}

async function readCredentials(wranglerBin) {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  delete process.env.CLOUDFLARE_API_TOKEN
  delete process.env.CLOUDFLARE_ACCOUNT_ID
  const environment = existingCloudflareAuthEnvironment(apiToken, accountId)
  const authToken = await runProcess(
    process.execPath,
    [wranglerBin, 'auth', 'token', '--json'],
    {
      cwd: REPOSITORY_ROOT,
      env: environment,
      timeoutMs: 30_000,
      captureStdout: true,
    },
  )
  if (!authToken.ok) {
    fail('PREFLIGHT_FAILED', 3)
  }
  const whoami = await runProcess(
    process.execPath,
    [wranglerBin, 'whoami', '--json'],
    {
      cwd: REPOSITORY_ROOT,
      env: environment,
      timeoutMs: 30_000,
      captureStdout: true,
    },
  )
  if (!whoami.ok) fail('PREFLIGHT_FAILED', 3)
  try {
    return resolveCloudflareCredentials({
      apiToken,
      accountId,
      authTokenOutput: authToken.stdout,
      whoamiOutput: whoami.stdout,
    })
  } catch {
    fail('PREFLIGHT_FAILED', 3)
  }
}

async function readResponseBody(response) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CAPTURE_BYTES) {
    await response.body?.cancel()
    fail('PREFLIGHT_FAILED')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_CAPTURE_BYTES) {
      await reader.cancel()
      fail('PREFLIGHT_FAILED')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function createCloudflareClient(credentials) {
  return async function cloudflareRequest(
    resource,
    { allowAbsent = false } = {},
  ) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    timeout.unref()
    let response
    let body
    try {
      response = await fetch(
        `https://api.cloudflare.com/client/v4${resource}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${credentials.apiToken}`,
          },
          redirect: 'error',
          signal: controller.signal,
        },
      )
      const text = await readResponseBody(response)
      body = JSON.parse(text)
    } catch {
      fail('PREFLIGHT_FAILED')
    } finally {
      clearTimeout(timeout)
    }
    const errorCodes = Array.isArray(body?.errors)
      ? body.errors.map(({ code }) => code)
      : []
    if (
      allowAbsent &&
      response.status === 404 &&
      errorCodes.some((code) => NOT_FOUND_CODES.has(code))
    ) {
      return { absent: true, result: null }
    }
    if (response.status === 401 || response.status === 403) {
      fail('PREFLIGHT_FAILED', 3)
    }
    if (!response.ok || body?.success !== true || !('result' in body)) {
      fail('PREFLIGHT_FAILED')
    }
    return { absent: false, result: body.result }
  }
}

function workerApiPaths(accountId, workerName) {
  const account = `/accounts/${encodeURIComponent(accountId)}`
  const script = `${account}/workers/scripts/${encodeURIComponent(workerName)}`
  const service = `${account}/workers/services/${encodeURIComponent(workerName)}/environments/production`
  return {
    account,
    deployments: `${script}/deployments`,
    versions: `${script}/versions?deployable=true`,
    version: (versionId) =>
      `${script}/versions/${encodeURIComponent(versionId)}`,
    settings: `${script}/settings`,
    subdomain: `${script}/subdomain`,
    routes: `${service}/routes?show_zonename=true`,
    bindings: `${service}/bindings`,
    customDomains: `${account}/workers/domains?service=${encodeURIComponent(workerName)}&environment=production`,
    accountSubdomain: `${account}/workers/subdomain`,
  }
}

function exactCustomDomains(result, workerName) {
  if (!Array.isArray(result)) fail('PREFLIGHT_FAILED')
  return result.filter(
    (domain) =>
      isRecord(domain) &&
      domain.service === workerName &&
      (domain.environment === undefined || domain.environment === 'production'),
  )
}

async function probeOwnedResources(client, paths, workerName) {
  const [deployments, versions, customDomains] = await Promise.all([
    client(paths.deployments, { allowAbsent: true }),
    client(paths.versions, { allowAbsent: true }),
    client(paths.customDomains),
  ])
  return {
    deployments,
    versions,
    customDomains: exactCustomDomains(customDomains.result, workerName),
  }
}

async function preflightCloudflare(client, paths, workerName) {
  const [probe, accountSubdomain] = await Promise.all([
    probeOwnedResources(client, paths, workerName),
    client(paths.accountSubdomain),
  ])
  if (
    !probe.deployments.absent ||
    !probe.versions.absent ||
    probe.customDomains.length !== 0 ||
    !isRecord(accountSubdomain.result) ||
    typeof accountSubdomain.result.subdomain !== 'string' ||
    !SUBDOMAIN_PATTERN.test(accountSubdomain.result.subdomain)
  ) {
    fail('PREFLIGHT_FAILED')
  }
  return accountSubdomain.result.subdomain
}

function wranglerEnvironment(credentials, home, outputPath) {
  return {
    ...basicEnvironment(home),
    CLOUDFLARE_API_TOKEN: credentials.apiToken,
    CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
    WRANGLER_OUTPUT_FILE_PATH: outputPath,
    WRANGLER_LOG_SANITIZE: 'true',
    WRANGLER_SEND_METRICS: 'false',
  }
}

async function parseWranglerOutput(outputPath) {
  const metadata = await lstat(outputPath).catch(() => null)
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_CAPTURE_BYTES
  ) {
    fail('INVALID_DEPLOY_OUTPUT')
  }
  const lines = (await readFile(outputPath, 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
  const entries = []
  try {
    for (const line of lines) entries.push(JSON.parse(line))
  } catch {
    fail('INVALID_DEPLOY_OUTPUT')
  }
  if (entries.some((entry) => entry?.type === 'command-failed')) {
    fail('DEPLOY_FAILED')
  }
  return entries
}

async function deployWorker({
  wranglerBin,
  configPath,
  tempRoot,
  tempHome,
  credentials,
  expectedHead,
  workerName,
  nonce,
  lockfileSha256,
  buildSha256,
  expectedUrl,
}) {
  const outputPath = path.join(tempRoot, 'wrangler-deploy.jsonl')
  const tag = `issue171-${expectedHead.slice(0, 12)}-${nonce}`
  const message = `issue=171;head=${expectedHead};lock=${lockfileSha256};build=${buildSha256}`
  const result = await runProcess(
    process.execPath,
    [
      wranglerBin,
      'deploy',
      '--config',
      configPath,
      '--cwd',
      tempRoot,
      '--name',
      workerName,
      '--strict',
      '--no-autoconfig',
      '--no-x-provision',
      '--no-x-auto-create',
      '--tag',
      tag,
      '--message',
      message,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: wranglerEnvironment(credentials, tempHome, outputPath),
      timeoutMs: 5 * 60_000,
      captureStdout: false,
    },
  )
  const entries = await parseWranglerOutput(outputPath).catch((error) => {
    if (!result.ok) fail('DEPLOY_FAILED')
    throw error
  })
  if (!result.ok) fail('DEPLOY_FAILED')
  const deployEntries = entries.filter((entry) => entry?.type === 'deploy')
  if (
    deployEntries.length !== 1 ||
    deployEntries[0].version !== 1 ||
    deployEntries[0].worker_name !== workerName ||
    deployEntries[0].worker_name_overridden !== false ||
    !Array.isArray(deployEntries[0].targets) ||
    deployEntries[0].targets.length !== 1 ||
    deployEntries[0].targets[0] !== expectedUrl
  ) {
    fail('INVALID_DEPLOY_OUTPUT')
  }
  const deploy = validateDeployOutput(
    {
      workerName,
      versionId: deployEntries[0].version_id,
      head: expectedHead,
      url: expectedUrl,
    },
    { expectedHead, nonce },
  )
  return { deploy, tag, message }
}

function requireEmptyCollection(value) {
  if (Array.isArray(value)) {
    if (value.length !== 0) fail('DEPLOY_FAILED')
    return
  }
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    fail('DEPLOY_FAILED')
  }
}

async function verifyDeployment({
  client,
  paths,
  workerName,
  deploy,
  tag,
  message,
}) {
  const [
    deployments,
    versions,
    version,
    subdomain,
    settings,
    routes,
    bindings,
  ] = await Promise.all([
    client(paths.deployments),
    client(paths.versions),
    client(paths.version(deploy.versionId)),
    client(paths.subdomain),
    client(paths.settings),
    client(paths.routes),
    client(paths.bindings),
  ])
  const deploymentList = deployments.result?.deployments
  const versionList = versions.result?.items
  if (
    !Array.isArray(deploymentList) ||
    deploymentList.length !== 1 ||
    !Array.isArray(deploymentList[0]?.versions) ||
    deploymentList[0].versions.length !== 1 ||
    deploymentList[0].versions[0].version_id !== deploy.versionId ||
    deploymentList[0].versions[0].percentage !== 100 ||
    !Array.isArray(versionList) ||
    versionList.length !== 1 ||
    versionList[0]?.id !== deploy.versionId ||
    version.result?.id !== deploy.versionId ||
    version.result?.annotations?.['workers/tag'] !== tag ||
    version.result?.annotations?.['workers/message'] !== message ||
    subdomain.result?.enabled !== true ||
    subdomain.result?.previews_enabled !== false ||
    settings.result?.compatibility_date !== COMPATIBILITY_DATE
  ) {
    fail('DEPLOY_FAILED')
  }
  requireEmptyCollection(settings.result?.bindings ?? [])
  requireEmptyCollection(routes.result)
  requireEmptyCollection(bindings.result)
  const domainProbe = await client(paths.customDomains)
  if (exactCustomDomains(domainProbe.result, workerName).length !== 0) {
    fail('DEPLOY_FAILED')
  }
}

async function probeUrl(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  timeout.unref()
  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-store, max-age=0' },
      redirect: 'manual',
      signal: controller.signal,
    })
    await response.body?.cancel()
    return response.status >= 200 && response.status < 400
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForUrlAvailable(origin, nonce) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const available = await probeUrl(
      `${origin}/research/studio/?rucksack-disposable=${nonce}-${attempt}`,
    )
    if (available) return
    await delay(2_000)
  }
  fail('DEPLOY_FAILED')
}

function browserEnvironment(
  tempRoot,
  tempHome,
  origin,
  receiptPath,
  proofContext,
) {
  const environment = basicEnvironment(tempHome)
  return {
    ...environment,
    PLAYWRIGHT_BROWSERS_PATH: path.join(
      REPOSITORY_ROOT,
      'node_modules',
      '.cache',
      'publication-browsers',
      'playwright',
    ),
    SRT_E2E_BROWSER: 'chromium',
    SRT_WORKERS_DEV_BASE_URL: origin,
    SRT_BROWSER_RECEIPT_PATH: receiptPath,
    SRT_BROWSER_PROOF_CONTEXT: JSON.stringify(proofContext),
    AGENT_EVIDENCE_DIR: path.join(tempRoot, 'browser-evidence'),
  }
}

async function runBrowserValidation({
  playwrightBin,
  tempRoot,
  tempHome,
  deploy,
  expectedHead,
  nonce,
  workerName,
}) {
  const browserReceiptPath = path.join(tempRoot, 'browser-receipt.json')
  const outputPath = path.join(tempRoot, 'playwright-output')
  const proofContext = {
    exactHead: expectedHead,
    workerName,
    workerVersionId: deploy.versionId,
    runNonce: nonce,
    origin: deploy.url,
  }
  await runChecked(
    process.execPath,
    [
      playwrightBin,
      'test',
      'tests/e2e/pdf-to-epub-fidelity.spec.ts',
      '--config',
      'playwright.config.ts',
      '--workers=1',
      '--retries=0',
      '--forbid-only',
      '--trace=off',
      '--reporter=line',
      `--output=${outputPath}`,
      '--global-timeout=900000',
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: browserEnvironment(
        tempRoot,
        tempHome,
        deploy.url,
        browserReceiptPath,
        proofContext,
      ),
      timeoutMs: 16 * 60_000,
      captureStdout: false,
    },
    'BROWSER_FAILED',
  )
  const receiptBytes = await readPinnedExternalFile(
    browserReceiptPath,
    MAX_CAPTURE_BYTES,
  )
  return validateBrowserReceipt(receiptBytes.toString('utf8'), {
    expectedHead,
    nonce,
    workerName,
    versionId: deploy.versionId,
    origin: deploy.url,
  })
}

async function readPinnedExternalFile(filePath, maximumBytes) {
  const metadata = await lstat(filePath).catch(() => null)
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maximumBytes
  ) {
    fail('BROWSER_FAILED')
  }
  return await readFile(filePath)
}

async function deleteWorker({
  wranglerBin,
  configPath,
  tempRoot,
  tempHome,
  credentials,
  workerName,
}) {
  const outputPath = path.join(tempRoot, 'wrangler-delete.jsonl')
  try {
    await runProcess(
      process.execPath,
      [
        wranglerBin,
        'delete',
        workerName,
        '--config',
        configPath,
        '--cwd',
        tempRoot,
        '--force',
        '--no-x-provision',
        '--no-x-auto-create',
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: wranglerEnvironment(credentials, tempHome, outputPath),
        timeoutMs: 2 * 60_000,
        captureStdout: false,
        allowInterrupted: true,
      },
    )
    const metadata = await lstat(outputPath).catch(() => null)
    if (metadata) {
      await parseWranglerOutput(outputPath)
    }
  } catch {
    // Teardown success is determined only by the bounded remote postconditions
    // below. A partial deploy may leave no structured Wrangler record at all.
  }
}

async function verifyTeardown(client, paths, workerName, origin, nonce) {
  let consecutive = 0
  let lastProbe = null
  let urlUnavailable = false
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      lastProbe = await probeOwnedResources(client, paths, workerName)
      urlUnavailable = !(await probeUrl(
        `${origin}/research/studio/?rucksack-teardown=${nonce}-${attempt}`,
      ))
      const absent =
        lastProbe.deployments.absent &&
        lastProbe.versions.absent &&
        lastProbe.customDomains.length === 0 &&
        urlUnavailable
      consecutive = absent ? consecutive + 1 : 0
      if (consecutive >= 2) {
        return validateTeardownProof(
          {
            deleteAttempted: true,
            deploymentsAbsent: true,
            versionsAbsent: true,
            customDomains: [],
            remainingResources: [],
            urlUnavailable: true,
          },
          { expectedHead: paths.expectedHead, nonce },
        )
      }
    } catch {
      consecutive = 0
    }
    await delay(2_000)
  }
  fail('CLEANUP_FAILED')
}

async function cleanupDeployment({
  client,
  paths,
  expectedHead,
  nonce,
  origin,
  wranglerBin,
  configPath,
  tempRoot,
  tempHome,
  credentials,
  workerName,
  cleanupProgress,
}) {
  cleanupProgress.deleteAttempted = true
  await deleteWorker({
    wranglerBin,
    configPath,
    tempRoot,
    tempHome,
    credentials,
    workerName,
  })
  return await verifyTeardown(
    client,
    { ...paths, expectedHead },
    workerName,
    origin,
    nonce,
  )
}

async function writeSanitizedReceipt(receiptPath, receipt, credentials) {
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`
  if (
    (credentials.apiToken && serialized.includes(credentials.apiToken)) ||
    (credentials.accountId && serialized.includes(credentials.accountId)) ||
    serialized.includes('%PDF') ||
    serialized.includes('.workers.dev') ||
    serialized.includes('http://') ||
    serialized.includes('https://')
  ) {
    fail('RECEIPT_FAILED')
  }
  const temporaryPath = `${receiptPath}.tmp-${randomBytes(12).toString('hex')}`
  try {
    await writeFile(temporaryPath, serialized, { flag: 'wx', mode: 0o600 })
    await link(temporaryPath, receiptPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function main() {
  let parsed
  let receiptPath
  try {
    parsed = parseCliArguments(process.argv.slice(2))
    receiptPath = await validateReceiptDestination(parsed.receiptArgument)
  } catch {
    process.stderr.write(
      'Usage: disposable-pdf-worker.mjs --expected-head <40-hex> --receipt <safe-path>\n',
    )
    process.exitCode = 1
    return
  }

  const state = {
    ...parsed,
    failures: [],
    fixture: { ...DISPOSABLE_PDF_FIXTURE_PIN },
  }
  let credentials
  let tempRoot
  let stage = 'preflight'
  let exitCode = 1
  let deploymentAttempted = false
  let tools
  let client
  let paths
  let origin
  const cleanupProgress = { deleteAttempted: false }

  try {
    await requireExactCleanCheckout(parsed.expectedHead)
    const pins = await verifyRepositoryPins()
    state.lockfileSha256 = pins.lockfileSha256
    tools = await verifyLocalTools()
    credentials = await readCredentials(tools.wranglerBin)

    tempRoot = await mkdtemp(
      path.join(await safeTemporaryBase(), 'erniesg-issue171-'),
    )
    await chmod(tempRoot, 0o700)
    const tempHome = path.join(tempRoot, 'home')
    await mkdir(tempHome, { mode: 0o700 })

    client = createCloudflareClient(credentials)
    paths = workerApiPaths(credentials.accountId, parsed.workerName)
    const accountSubdomain = await preflightCloudflare(
      client,
      paths,
      parsed.workerName,
    )
    origin = `https://${parsed.workerName}.${accountSubdomain}.workers.dev`

    stage = 'build'
    const buildEnvironment = basicEnvironment(tempHome)
    await runChecked(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['ci'],
      {
        cwd: REPOSITORY_ROOT,
        env: buildEnvironment,
        timeoutMs: 15 * 60_000,
        captureStdout: false,
      },
      'BUILD_FAILED',
      2,
    )
    tools = await verifyLocalTools()
    await requireExactCleanCheckout(parsed.expectedHead)
    const afterInstallPins = await verifyRepositoryPins()
    if (afterInstallPins.lockfileSha256 !== state.lockfileSha256) {
      fail('BUILD_FAILED')
    }
    await runChecked(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'build:staging'],
      {
        cwd: REPOSITORY_ROOT,
        env: buildEnvironment,
        timeoutMs: 15 * 60_000,
        captureStdout: false,
      },
      'BUILD_FAILED',
    )
    await requireExactCleanCheckout(parsed.expectedHead)
    const afterBuildPins = await verifyRepositoryPins()
    if (afterBuildPins.lockfileSha256 !== state.lockfileSha256) {
      fail('BUILD_FAILED')
    }
    const assetsPath = path.join(tempRoot, 'assets')
    state.buildSha256 = await snapshotDirectory(
      path.join(REPOSITORY_ROOT, 'dist'),
      assetsPath,
    )
    const configPath = path.join(tempRoot, 'wrangler.json')
    const config = {
      name: parsed.workerName,
      account_id: credentials.accountId,
      compatibility_date: COMPATIBILITY_DATE,
      workers_dev: true,
      preview_urls: false,
      send_metrics: false,
      assets: {
        directory: './assets',
        not_found_handling: '404-page',
        html_handling: 'auto-trailing-slash',
      },
    }
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    await preflightCloudflare(client, paths, parsed.workerName)

    stage = 'deploy'
    deploymentAttempted = true
    const deployed = await deployWorker({
      ...tools,
      configPath,
      tempRoot,
      tempHome,
      credentials,
      expectedHead: parsed.expectedHead,
      workerName: parsed.workerName,
      nonce: parsed.nonce,
      lockfileSha256: state.lockfileSha256,
      buildSha256: state.buildSha256,
      expectedUrl: origin,
    })
    state.deploy = deployed.deploy
    await verifyDeployment({
      client,
      paths,
      workerName: parsed.workerName,
      ...deployed,
    })
    state.deploymentVerified = true
    await waitForUrlAvailable(origin, parsed.nonce)
    await requireExactCleanCheckout(parsed.expectedHead)

    stage = 'browser'
    state.browser = await runBrowserValidation({
      ...tools,
      tempRoot,
      tempHome,
      deploy: state.deploy,
      expectedHead: parsed.expectedHead,
      nonce: parsed.nonce,
      workerName: parsed.workerName,
    })
  } catch (error) {
    state.failures.push(stageFailure(stage))
    exitCode = error instanceof CliFailure ? error.exitCode : 1
  } finally {
    if (deploymentAttempted && client && paths && tempRoot && tools) {
      try {
        stage = 'cleanup'
        const tempHome = path.join(tempRoot, 'home')
        const configPath = path.join(tempRoot, 'wrangler.json')
        if (!origin) fail('CLEANUP_FAILED')
        state.teardown = await cleanupDeployment({
          client,
          paths,
          expectedHead: parsed.expectedHead,
          nonce: parsed.nonce,
          origin,
          ...tools,
          configPath,
          tempRoot,
          tempHome,
          credentials,
          workerName: parsed.workerName,
          cleanupProgress,
        })
      } catch {
        state.failures.push(stageFailure('cleanup'))
        state.teardown ??= {
          deleteAttempted: cleanupProgress.deleteAttempted,
          deploymentsAbsent: false,
          versionsAbsent: false,
          customDomains: ['unverified'],
          remainingResources: [parsed.workerName],
          urlUnavailable: false,
          verified: false,
        }
        exitCode = 1
      }
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {
        state.failures.push(stageFailure('cleanup'))
        exitCode = 1
      })
    }
  }

  if (
    interrupted &&
    !state.failures.some(({ stage: value }) => value === 'lifecycle')
  ) {
    state.failures.push(stageFailure('lifecycle'))
  }

  try {
    const receipt = createSanitizedReceipt(state)
    receipt.contract_sha256 = CONTRACT_SHA256
    receipt.fixture_manifest_sha256 = MANIFEST_SHA256
    if (state.deploymentVerified) {
      receipt.deployment_assertions = {
        workers_dev: true,
        preview_urls: false,
        routes: 0,
        custom_domains: 0,
        bindings: 0,
        traffic_percent: 100,
      }
    }
    await writeSanitizedReceipt(
      receiptPath,
      receipt,
      credentials ?? {
        apiToken: '',
        accountId: '',
      },
    )
    if (receipt.result === 'passed') {
      process.stdout.write('Disposable Worker validation passed.\n')
      process.exitCode = 0
      return
    }
  } catch {
    if (!state.failures.some(({ stage: value }) => value === 'receipt')) {
      state.failures.push(stageFailure('receipt'))
    }
    exitCode = 1
  }
  process.stderr.write(
    `Disposable Worker validation failed: ${state.failures
      .map(({ code }) => code)
      .join(',')}\n`,
  )
  process.exitCode = exitCode
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main()
}
