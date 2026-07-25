#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { createAdapterSourceIdentity } from './adapter-source-identity.mjs'

export const PDF_TARGET_FREE_MANIFEST_SCHEMA_VERSION = '1.0.0'
export const PDF_TARGET_FREE_ADAPTER_OUTPUT_SCHEMA_VERSION = '1.0.0'
export const PDF_TARGET_FREE_RECEIPT_SCHEMA_VERSION = '1.1.0'
export const PDF_TARGET_FREE_CONFIGURED_RUNTIME_RECEIPT_SCHEMA_VERSION = '1.2.0'

const MANIFEST_PRIVACY =
  'public-document-identities-only-no-source-content-layout-targets-or-gold'
const RECEIPT_PRIVACY =
  'public-document-identities-adapter-runtime-and-raw-output-hashes-no-source-content-or-local-paths'
const MAX_JSON_BYTES = 128 * 1024 * 1024
const RETAINED_OUTPUT_DIRECTORY_MODE = 0o700
const RETAINED_OUTPUT_FILE_MODE = 0o600
const CANDIDATE_VERSION_TIMEOUT_MS = 10_000
const CANDIDATE_VERSION_MAX_BUFFER = 1024 * 1024
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const PUBLIC_ADAPTER_HEX_DOMAIN = 'pdf-target-free-public-adapter-hex-value-v1'
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCHEMA_PATHS = {
  manifest: 'docs/schemas/pdf-target-free-candidate-manifest.schema.json',
  adapterOutput:
    'docs/schemas/pdf-target-free-candidate-adapter-output.schema.json',
  receiptV1_1: 'docs/schemas/pdf-target-free-candidate-receipt.schema.json',
  receiptV1_2:
    'docs/schemas/pdf-target-free-candidate-receipt-v1.2.schema.json',
}
const REQUEST_KEYS = ['documentId', 'path', 'byteLength', 'sha256']
const ORACLE_KEYS = new Set([
  'task',
  'tasks',
  'stratum',
  'strata',
  'target',
  'targetId',
  'targetIds',
  'targets',
  'page',
  'pages',
  'sourcePage',
  'box',
  'boxes',
  'gold',
  'expected',
  'label',
  'labels',
  'reviewer',
  'reviewers',
  'review',
])

function invalid(code = 'INVALID_PDF_TARGET_FREE_CANDIDATE_RUN') {
  throw new Error(code)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  )
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalHash(value) {
  return sha256(canonicalJson(value))
}

export function publicAdapterIdentifier(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    invalid('INVALID_PDF_TARGET_FREE_PUBLIC_ADAPTER_IDENTIFIER')
  }
  return `sha256:${sha256(value)}`
}

function publicAdapterHexValue(field, value) {
  if (
    !SAFE_ID.test(field) ||
    typeof value !== 'string' ||
    !SHA256.test(value)
  ) {
    invalid('INVALID_PDF_TARGET_FREE_PUBLIC_ADAPTER_IDENTIFIER')
  }
  return sha256(`${PUBLIC_ADAPTER_HEX_DOMAIN}\0${field}\0${value}`)
}

export function sanitizeAdapterRuntimeIdentity(
  runtimeIdentity,
  verifiedRunnerExecutableIdentity = null,
) {
  if (
    !isRecord(runtimeIdentity) ||
    !exactKeys(runtimeIdentity, ['status', 'tool', 'model']) ||
    (runtimeIdentity.tool !== null && !isRecord(runtimeIdentity.tool)) ||
    (runtimeIdentity.model !== null && !isRecord(runtimeIdentity.model))
  ) {
    invalid('INVALID_PDF_TARGET_FREE_PUBLIC_ADAPTER_IDENTIFIER')
  }
  const toolExecutableWasVerified =
    runtimeIdentity.tool !== null &&
    isRecord(verifiedRunnerExecutableIdentity) &&
    runtimeIdentity.tool.executableSha256 ===
      verifiedRunnerExecutableIdentity.sha256
  const toolVersionOutputWasVerified =
    toolExecutableWasVerified &&
    verifiedRunnerExecutableIdentity.versionAttestation === 'observed' &&
    runtimeIdentity.tool.versionOutputSha256 ===
      verifiedRunnerExecutableIdentity.versionOutputSha256
  return {
    status: runtimeIdentity.status,
    tool:
      runtimeIdentity.tool === null
        ? null
        : {
            id: publicAdapterIdentifier(runtimeIdentity.tool.id),
            version: publicAdapterIdentifier(runtimeIdentity.tool.version),
            executableSha256: toolExecutableWasVerified
              ? runtimeIdentity.tool.executableSha256
              : publicAdapterHexValue(
                  'tool-executable-sha256',
                  runtimeIdentity.tool.executableSha256,
                ),
            versionOutputSha256: toolVersionOutputWasVerified
              ? runtimeIdentity.tool.versionOutputSha256
              : publicAdapterHexValue(
                  'tool-version-output-sha256',
                  runtimeIdentity.tool.versionOutputSha256,
                ),
          },
    model:
      runtimeIdentity.model === null
        ? null
        : {
            id: publicAdapterIdentifier(runtimeIdentity.model.id),
            sha256: publicAdapterHexValue(
              'model-sha256',
              runtimeIdentity.model.sha256,
            ),
          },
  }
}

function parseJsonArtifact(bytes) {
  const value =
    typeof bytes === 'string'
      ? Buffer.from(bytes)
      : bytes instanceof Uint8Array
        ? Buffer.from(bytes)
        : null
  if (!value || value.byteLength === 0 || value.byteLength > MAX_JSON_BYTES) {
    invalid()
  }
  try {
    return {
      value: JSON.parse(value.toString('utf8')),
      fileSha256: sha256(value),
      byteLength: value.byteLength,
    }
  } catch {
    invalid()
  }
}

async function readSchema(path) {
  return parseJsonArtifact(await readFile(resolve(REPOSITORY_ROOT, path))).value
}

async function compileSchemas() {
  try {
    const [manifest, adapterOutput, receiptV1_1, receiptV1_2] =
      await Promise.all([
        readSchema(SCHEMA_PATHS.manifest),
        readSchema(SCHEMA_PATHS.adapterOutput),
        readSchema(SCHEMA_PATHS.receiptV1_1),
        readSchema(SCHEMA_PATHS.receiptV1_2),
      ])
    return {
      manifest: new Ajv2020({ strict: false }).compile(manifest),
      adapterOutput: new Ajv2020({ strict: false }).compile(adapterOutput),
      receiptV1_1: new Ajv2020({ strict: false }).compile(receiptV1_1),
      receiptV1_2: new Ajv2020({ strict: false }).compile(receiptV1_2),
    }
  } catch {
    invalid()
  }
}

function assertUniqueManifestDocuments(documents) {
  const ids = new Set()
  const hashes = new Set()
  for (const document of documents) {
    if (ids.has(document.id) || hashes.has(document.sha256)) invalid()
    ids.add(document.id)
    hashes.add(document.sha256)
  }
}

function validateManifestArtifact(manifestArtifact, validateSchema) {
  if (
    !validateSchema(manifestArtifact.value) ||
    manifestArtifact.value.schemaVersion !==
      PDF_TARGET_FREE_MANIFEST_SCHEMA_VERSION ||
    manifestArtifact.value.privacy !== MANIFEST_PRIVACY
  ) {
    invalid()
  }
  assertUniqueManifestDocuments(manifestArtifact.value.documents)
  return {
    id: manifestArtifact.value.id,
    fileSha256: manifestArtifact.fileSha256,
    documentIdentitySha256: canonicalHash(manifestArtifact.value.documents),
    documentCount: manifestArtifact.value.documents.length,
  }
}

function within(root, target) {
  const path = relative(root, target)
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  )
}

async function resolveRegularFile(path, code) {
  try {
    const suppliedDetails = await lstat(path)
    if (!suppliedDetails.isFile() || suppliedDetails.isSymbolicLink()) {
      invalid(code)
    }
    const canonicalPath = await realpath(path)
    const canonicalDetails = await lstat(canonicalPath)
    if (!canonicalDetails.isFile() || canonicalDetails.isSymbolicLink()) {
      invalid(code)
    }
    return { path: canonicalPath, details: canonicalDetails }
  } catch (error) {
    if (error?.message === code) throw error
    invalid(code)
  }
}

async function resolveInputRoot(path) {
  try {
    const suppliedDetails = await lstat(path)
    if (!suppliedDetails.isDirectory() || suppliedDetails.isSymbolicLink()) {
      invalid('INVALID_PDF_TARGET_FREE_INPUT_ROOT')
    }
    const canonicalPath = await realpath(path)
    const canonicalDetails = await lstat(canonicalPath)
    if (!canonicalDetails.isDirectory() || canonicalDetails.isSymbolicLink()) {
      invalid('INVALID_PDF_TARGET_FREE_INPUT_ROOT')
    }
    return canonicalPath
  } catch (error) {
    if (error?.message === 'INVALID_PDF_TARGET_FREE_INPUT_ROOT') throw error
    invalid('INVALID_PDF_TARGET_FREE_INPUT_ROOT')
  }
}

async function resolveRegularDirectory(path, code) {
  try {
    const suppliedDetails = await lstat(path)
    if (!suppliedDetails.isDirectory() || suppliedDetails.isSymbolicLink()) {
      invalid(code)
    }
    const canonicalPath = await realpath(path)
    const canonicalDetails = await lstat(canonicalPath)
    if (!canonicalDetails.isDirectory() || canonicalDetails.isSymbolicLink()) {
      invalid(code)
    }
    return canonicalPath
  } catch (error) {
    if (error?.message === code) throw error
    invalid(code)
  }
}

async function assertPathAbsent(path, code) {
  try {
    await lstat(path)
    invalid(code)
  } catch (error) {
    if (error?.message === code) throw error
    if (error?.code !== 'ENOENT') invalid(code)
  }
}

function retainedOutputFilename(index) {
  return `raw-output-${String(index + 1).padStart(6, '0')}.json`
}

async function createRetainedOutputDirectory(path, inputRoot, receiptPath) {
  const suppliedPath = resolve(path)
  const parent = await resolveInputRoot(dirname(suppliedPath))
  const canonicalPath = join(parent, basename(suppliedPath))
  if (
    canonicalPath === inputRoot ||
    within(inputRoot, canonicalPath) ||
    receiptPath === canonicalPath ||
    within(canonicalPath, receiptPath)
  ) {
    invalid('INVALID_PDF_TARGET_FREE_RAW_OUTPUT_DIRECTORY')
  }
  try {
    await mkdir(canonicalPath, {
      mode: RETAINED_OUTPUT_DIRECTORY_MODE,
      recursive: false,
    })
    await chmod(canonicalPath, RETAINED_OUTPUT_DIRECTORY_MODE)
  } catch {
    invalid('PDF_TARGET_FREE_RAW_OUTPUT_DIRECTORY_EXISTS_OR_INVALID')
  }
  return canonicalPath
}

async function verifyDocuments(manifest, inputRoot) {
  const documents = []
  for (const document of manifest.documents) {
    const candidate = resolve(inputRoot, `${document.id}.pdf`)
    if (!within(inputRoot, candidate)) {
      invalid('PDF_TARGET_FREE_SOURCE_IDENTITY_MISMATCH')
    }
    const source = await resolveRegularFile(
      candidate,
      'PDF_TARGET_FREE_SOURCE_IDENTITY_MISMATCH',
    )
    if (
      !within(inputRoot, source.path) ||
      source.details.size !== document.byteLength
    ) {
      invalid('PDF_TARGET_FREE_SOURCE_IDENTITY_MISMATCH')
    }
    const bytes = await readFile(source.path)
    if (sha256(bytes) !== document.sha256) {
      invalid('PDF_TARGET_FREE_SOURCE_IDENTITY_MISMATCH')
    }
    documents.push({
      id: document.id,
      path: source.path,
      byteLength: document.byteLength,
      sha256: document.sha256,
    })
  }
  return documents
}

async function assertDocumentStillVerified(document) {
  const source = await resolveRegularFile(
    document.path,
    'PDF_TARGET_FREE_SOURCE_IDENTITY_MISMATCH',
  )
  if (
    source.path !== document.path ||
    source.details.size !== document.byteLength ||
    sha256(await readFile(source.path)) !== document.sha256
  ) {
    invalid('PDF_TARGET_FREE_SOURCE_IDENTITY_MISMATCH')
  }
}

function containsOracleKey(value) {
  if (Array.isArray(value)) return value.some(containsOracleKey)
  if (!isRecord(value)) return false
  return Object.entries(value).some(
    ([key, item]) => ORACLE_KEYS.has(key) || containsOracleKey(item),
  )
}

export function createTargetFreeAdapterRequest(document) {
  const request = {
    documentId: document.id,
    path: document.path,
    byteLength: document.byteLength,
    sha256: document.sha256,
  }
  if (
    !exactKeys(request, REQUEST_KEYS) ||
    !SAFE_ID.test(request.documentId) ||
    typeof request.path !== 'string' ||
    !isAbsolute(request.path) ||
    !Number.isSafeInteger(request.byteLength) ||
    request.byteLength < 1 ||
    !/^[a-f0-9]{64}$/.test(request.sha256) ||
    containsOracleKey(request)
  ) {
    invalid('INVALID_PDF_TARGET_FREE_ADAPTER_REQUEST')
  }
  return request
}

function minimalAdapterPath() {
  const directories = [dirname(process.execPath)]
  if (platform() === 'win32') {
    if (typeof process.env.SystemRoot === 'string') {
      directories.push(join(process.env.SystemRoot, 'System32'))
    }
  } else {
    directories.push('/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin')
  }
  return [...new Set(directories)].join(delimiter)
}

function candidateVersion(output) {
  const match = output.match(
    /(?:^|[^A-Za-z0-9])([0-9]+(?:\.[0-9]+)+(?:[-+][A-Za-z0-9._-]+)?)(?:$|[^A-Za-z0-9])/m,
  )
  return match && SAFE_ID.test(match[1]) ? match[1] : null
}

async function observeCandidateExecutable(path) {
  try {
    const supplied = await lstat(path)
    if (!supplied.isFile() && !supplied.isSymbolicLink()) {
      invalid('INVALID_PDF_TARGET_FREE_CANDIDATE_EXECUTABLE')
    }
    const canonicalPath = await realpath(path)
    const canonical = await lstat(canonicalPath)
    if (!canonical.isFile() || canonical.isSymbolicLink()) {
      invalid('INVALID_PDF_TARGET_FREE_CANDIDATE_EXECUTABLE')
    }
    await access(canonicalPath, constants.X_OK)
    path = canonicalPath
  } catch (error) {
    if (error?.message === 'INVALID_PDF_TARGET_FREE_CANDIDATE_EXECUTABLE') {
      throw error
    }
    invalid('INVALID_PDF_TARGET_FREE_CANDIDATE_EXECUTABLE')
  }
  const bytes = await readFile(path)
  if (bytes.byteLength < 1) {
    invalid('INVALID_PDF_TARGET_FREE_CANDIDATE_EXECUTABLE')
  }
  const beforeIdentity = {
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  }
  const versionDirectory = await mkdtemp(
    join(tmpdir(), 'pdf-target-free-candidate-version-'),
  )
  try {
    const result = spawnSync(path, ['--version'], {
      cwd: versionDirectory,
      encoding: 'utf8',
      env: {
        PATH: minimalAdapterPath(),
        HOME: versionDirectory,
        TMPDIR: versionDirectory,
        TMP: versionDirectory,
        TEMP: versionDirectory,
        LANG: 'C',
        LC_ALL: 'C',
        SRT_PDF_TARGET_FREE_OFFLINE: '1',
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        NO_PROXY: '*',
        no_proxy: '*',
      },
      timeout: CANDIDATE_VERSION_TIMEOUT_MS,
      maxBuffer: CANDIDATE_VERSION_MAX_BUFFER,
      windowsHide: true,
    })
    const versionOutput =
      !result.error && result.status === 0
        ? `${result.stdout ?? ''}\0${result.stderr ?? ''}`
        : null
    const version =
      versionOutput === null ? null : candidateVersion(versionOutput)
    await assertCandidateExecutableStillVerified({
      path,
      identity: {
        ...beforeIdentity,
        versionAttestation: version === null ? 'unavailable' : 'observed',
        version,
        versionOutputSha256: version === null ? null : sha256(versionOutput),
      },
    })
    return {
      path,
      identity: {
        ...beforeIdentity,
        versionAttestation: version === null ? 'unavailable' : 'observed',
        version,
        versionOutputSha256: version === null ? null : sha256(versionOutput),
      },
    }
  } finally {
    await rm(versionDirectory, { recursive: true, force: true })
  }
}

export async function observePdfTargetFreeCandidateExecutableIdentity(path) {
  return (await observeCandidateExecutable(path)).identity
}

async function assertCandidateExecutableStillVerified(candidateExecutable) {
  try {
    const current = await resolveRegularFile(
      candidateExecutable.path,
      'PDF_TARGET_FREE_CANDIDATE_EXECUTABLE_DRIFT',
    )
    await access(current.path, constants.X_OK)
    const bytes = await readFile(current.path)
    if (
      current.path !== candidateExecutable.path ||
      bytes.byteLength !== candidateExecutable.identity.byteLength ||
      sha256(bytes) !== candidateExecutable.identity.sha256
    ) {
      invalid('PDF_TARGET_FREE_CANDIDATE_EXECUTABLE_DRIFT')
    }
  } catch (error) {
    if (error?.message === 'PDF_TARGET_FREE_CANDIDATE_EXECUTABLE_DRIFT') {
      throw error
    }
    invalid('PDF_TARGET_FREE_CANDIDATE_EXECUTABLE_DRIFT')
  }
}

async function assertCandidateModelCacheHomeStillVerified(
  candidateModelCacheHome,
) {
  try {
    const current = await resolveRegularDirectory(
      candidateModelCacheHome,
      'PDF_TARGET_FREE_CANDIDATE_MODEL_CACHE_HOME_DRIFT',
    )
    if (current !== candidateModelCacheHome) {
      invalid('PDF_TARGET_FREE_CANDIDATE_MODEL_CACHE_HOME_DRIFT')
    }
  } catch (error) {
    if (error?.message === 'PDF_TARGET_FREE_CANDIDATE_MODEL_CACHE_HOME_DRIFT') {
      throw error
    }
    invalid('PDF_TARGET_FREE_CANDIDATE_MODEL_CACHE_HOME_DRIFT')
  }
}

function safeAdapterEnvironment(
  candidate,
  adapterSourceSha256,
  invocationDirectory,
  configuredRuntime,
) {
  return {
    PATH: minimalAdapterPath(),
    HOME: invocationDirectory,
    TMPDIR: invocationDirectory,
    TMP: invocationDirectory,
    TEMP: invocationDirectory,
    LANG: 'C',
    LC_ALL: 'C',
    SRT_PDF_TARGET_FREE_OFFLINE: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    NO_PROXY: '*',
    no_proxy: '*',
    SRT_PDF_CANDIDATE_ID: candidate.id,
    SRT_PDF_CANDIDATE_VERSION: candidate.version,
    SRT_PDF_ADAPTER_SOURCE_SHA256: adapterSourceSha256,
    ...(configuredRuntime
      ? {
          SRT_PDF_RUNNER_CANDIDATE_EXECUTABLE:
            configuredRuntime.executable.path,
          SRT_PDF_RUNNER_MODEL_CACHE_HOME: configuredRuntime.modelCacheHome,
        }
      : {}),
  }
}

async function resolveAdapter(path) {
  const adapter = await resolveRegularFile(
    path,
    'INVALID_PDF_TARGET_FREE_ADAPTER',
  )
  try {
    await access(adapter.path, constants.X_OK)
  } catch {
    invalid('INVALID_PDF_TARGET_FREE_ADAPTER')
  }
  return adapter.path
}

async function resolveConfiguredRuntime(options, inputRoot) {
  const executableConfigured =
    typeof options.candidateExecutable === 'string' &&
    options.candidateExecutable.length > 0
  const modelCacheConfigured =
    typeof options.candidateModelCacheHome === 'string' &&
    options.candidateModelCacheHome.length > 0
  if (!executableConfigured && !modelCacheConfigured) return null
  if (!executableConfigured || !modelCacheConfigured) {
    invalid('INVALID_PDF_TARGET_FREE_CANDIDATE_RUNTIME_CONFIGURATION')
  }
  const executable = await observeCandidateExecutable(
    options.candidateExecutable,
  )
  const modelCacheHome = await resolveRegularDirectory(
    options.candidateModelCacheHome,
    'INVALID_PDF_TARGET_FREE_CANDIDATE_MODEL_CACHE_HOME',
  )
  if (modelCacheHome === inputRoot || within(inputRoot, modelCacheHome)) {
    invalid('INVALID_PDF_TARGET_FREE_CANDIDATE_MODEL_CACHE_HOME')
  }
  return { executable, modelCacheHome }
}

async function readAdapterOutput(path) {
  const output = await resolveRegularFile(
    path,
    'INVALID_PDF_TARGET_FREE_ADAPTER_OUTPUT',
  )
  if (output.details.size < 1 || output.details.size > MAX_JSON_BYTES) {
    invalid('INVALID_PDF_TARGET_FREE_ADAPTER_OUTPUT')
  }
  const bytes = await readFile(output.path)
  return {
    ...parseJsonArtifact(bytes),
    bytes,
  }
}

function validateAdapterOutput(
  outputArtifact,
  validateSchema,
  document,
  candidate,
  adapterSourceSha256,
) {
  const output = outputArtifact.value
  if (
    !validateSchema(output) ||
    output.schemaVersion !== PDF_TARGET_FREE_ADAPTER_OUTPUT_SCHEMA_VERSION ||
    output.documentId !== document.id ||
    output.sourceSha256 !== document.sha256 ||
    output.candidate.id !== candidate.id ||
    output.candidate.version !== candidate.version ||
    output.candidate.adapterSourceSha256 !== adapterSourceSha256
  ) {
    invalid('INVALID_PDF_TARGET_FREE_ADAPTER_OUTPUT')
  }
  return output
}

function sameCandidateEvidence(left, right) {
  return (
    left.format === right.format &&
    left.formatVersion === right.formatVersion &&
    canonicalJson(left.runtimeIdentity) === canonicalJson(right.runtimeIdentity)
  )
}

function receiptWithoutHash(receipt) {
  return Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'receiptSha256'),
  )
}

function configuredRuntimeReceiptIsValid(receipt, expectedIdentity = null) {
  const identity = receipt?.candidate?.runnerExecutableIdentity
  const modelCacheAttestation = receipt?.execution?.modelCacheAttestation
  if (receipt?.schemaVersion === PDF_TARGET_FREE_RECEIPT_SCHEMA_VERSION) {
    return (
      identity === undefined &&
      modelCacheAttestation === undefined &&
      expectedIdentity === null
    )
  }
  if (
    receipt?.schemaVersion !==
    PDF_TARGET_FREE_CONFIGURED_RUNTIME_RECEIPT_SCHEMA_VERSION
  ) {
    return false
  }
  if (
    !isRecord(identity) ||
    !exactKeys(identity, [
      'byteLength',
      'sha256',
      'versionAttestation',
      'version',
      'versionOutputSha256',
    ]) ||
    !Number.isSafeInteger(identity.byteLength) ||
    identity.byteLength < 1 ||
    !/^[a-f0-9]{64}$/.test(identity.sha256) ||
    !['observed', 'unavailable'].includes(identity.versionAttestation) ||
    (identity.versionAttestation === 'observed'
      ? !SAFE_ID.test(identity.version ?? '') ||
        !/^[a-f0-9]{64}$/.test(identity.versionOutputSha256 ?? '')
      : identity.version !== null || identity.versionOutputSha256 !== null) ||
    modelCacheAttestation !==
      'directory-path-validated-model-contents-unattested'
  ) {
    return false
  }
  const tool = receipt?.candidate?.runtimeIdentity?.tool
  if (
    !isRecord(tool) ||
    tool.executableSha256 !== identity.sha256 ||
    (identity.versionAttestation === 'observed' &&
      (tool.version !== publicAdapterIdentifier(identity.version) ||
        tool.versionOutputSha256 !== identity.versionOutputSha256))
  ) {
    return false
  }
  return (
    expectedIdentity === null ||
    canonicalJson(identity) === canonicalJson(expectedIdentity)
  )
}

export async function validatePdfTargetFreeCandidateReceipt(
  receipt,
  manifestBytes,
  expectedAdapterSource = null,
  expectedRunnerExecutableIdentity = null,
) {
  try {
    const schemas = await compileSchemas()
    const manifestArtifact = parseJsonArtifact(manifestBytes)
    const manifestIdentity = validateManifestArtifact(
      manifestArtifact,
      schemas.manifest,
    )
    const validateReceiptSchema =
      receipt?.schemaVersion === PDF_TARGET_FREE_RECEIPT_SCHEMA_VERSION
        ? schemas.receiptV1_1
        : receipt?.schemaVersion ===
            PDF_TARGET_FREE_CONFIGURED_RUNTIME_RECEIPT_SCHEMA_VERSION
          ? schemas.receiptV1_2
          : null
    if (
      !validateReceiptSchema ||
      !validateReceiptSchema(receipt) ||
      receipt.privacy !== RECEIPT_PRIVACY ||
      canonicalJson(receipt.manifest) !== canonicalJson(manifestIdentity) ||
      receipt.documents.length !== manifestIdentity.documentCount ||
      receipt.execution.adapterInvocationCount !==
        manifestIdentity.documentCount ||
      receipt.execution.rawOutputIdentitySha256 !==
        canonicalHash(receipt.documents) ||
      receipt.documents.some((result, index) => {
        const source = manifestArtifact.value.documents[index]
        return (
          result.id !== source.id ||
          result.byteLength !== source.byteLength ||
          result.sourceSha256 !== source.sha256
        )
      }) ||
      receipt.promotionEligible !== false ||
      receipt.receiptSha256 !== canonicalHash(receiptWithoutHash(receipt)) ||
      !configuredRuntimeReceiptIsValid(
        receipt,
        expectedRunnerExecutableIdentity,
      ) ||
      (expectedAdapterSource &&
        canonicalJson(receipt.candidate.adapterSource) !==
          canonicalJson(expectedAdapterSource))
    ) {
      invalid('INVALID_PDF_TARGET_FREE_CANDIDATE_RECEIPT')
    }
    return { valid: true, receiptSha256: receipt.receiptSha256 }
  } catch {
    invalid('INVALID_PDF_TARGET_FREE_CANDIDATE_RECEIPT')
  }
}

export async function validatePdfTargetFreeCandidateRetainedOutputs(
  receipt,
  rawOutputDirectory,
) {
  try {
    const directory = await resolveInputRoot(rawOutputDirectory)
    const directoryDetails = await lstat(directory)
    if (
      platform() !== 'win32' &&
      (directoryDetails.mode & 0o777) !== RETAINED_OUTPUT_DIRECTORY_MODE
    ) {
      invalid('INVALID_PDF_TARGET_FREE_RETAINED_OUTPUTS')
    }
    const expectedNames = receipt.documents.map((_, index) =>
      retainedOutputFilename(index),
    )
    const actualNames = (await readdir(directory)).sort()
    if (
      actualNames.length !== expectedNames.length ||
      actualNames.some((name, index) => name !== expectedNames[index])
    ) {
      invalid('INVALID_PDF_TARGET_FREE_RETAINED_OUTPUTS')
    }
    const replayedDocuments = []
    for (const [index, document] of receipt.documents.entries()) {
      const output = await resolveRegularFile(
        join(directory, retainedOutputFilename(index)),
        'INVALID_PDF_TARGET_FREE_RETAINED_OUTPUTS',
      )
      if (
        !within(directory, output.path) ||
        (platform() !== 'win32' &&
          (output.details.mode & 0o777) !== RETAINED_OUTPUT_FILE_MODE)
      ) {
        invalid('INVALID_PDF_TARGET_FREE_RETAINED_OUTPUTS')
      }
      const bytes = await readFile(output.path)
      if (
        bytes.byteLength !== document.rawOutputByteLength ||
        sha256(bytes) !== document.rawOutputSha256
      ) {
        invalid('INVALID_PDF_TARGET_FREE_RETAINED_OUTPUTS')
      }
      replayedDocuments.push(document)
    }
    if (
      receipt.execution.rawOutputIdentitySha256 !==
      canonicalHash(replayedDocuments)
    ) {
      invalid('INVALID_PDF_TARGET_FREE_RETAINED_OUTPUTS')
    }
    return {
      valid: true,
      rawOutputIdentitySha256: receipt.execution.rawOutputIdentitySha256,
    }
  } catch {
    invalid('INVALID_PDF_TARGET_FREE_RETAINED_OUTPUTS')
  }
}

function sanitizedAdapterSource(identity) {
  return {
    schemaVersion: identity.schemaVersion,
    sha256: identity.sha256,
    moduleCount: identity.modules.length,
    packageFileCount: identity.packageFiles.length,
  }
}

async function assertAdapterSourceStillVerified(adapter, expectedIdentity) {
  try {
    const currentIdentity = await createAdapterSourceIdentity(adapter)
    if (canonicalJson(currentIdentity) !== canonicalJson(expectedIdentity)) {
      invalid('PDF_TARGET_FREE_ADAPTER_SOURCE_DRIFT')
    }
  } catch (error) {
    if (error?.message === 'PDF_TARGET_FREE_ADAPTER_SOURCE_DRIFT') throw error
    invalid('PDF_TARGET_FREE_ADAPTER_SOURCE_DRIFT')
  }
}

function assertRunOptions(options) {
  const configuredRuntimeValues = [
    options?.candidateExecutable,
    options?.candidateModelCacheHome,
  ]
  const configuredRuntimeCount = configuredRuntimeValues.filter(
    (value) => value !== undefined,
  ).length
  if (
    !isRecord(options) ||
    !['manifest', 'inputRoot', 'adapter', 'output', 'rawOutputDirectory'].every(
      (key) => typeof options[key] === 'string' && options[key].length > 0,
    ) ||
    !SAFE_ID.test(options.candidateId ?? '') ||
    !SAFE_ID.test(options.candidateVersion ?? '') ||
    !Number.isSafeInteger(options.timeoutSeconds) ||
    options.timeoutSeconds < 1 ||
    options.timeoutSeconds > 86_400 ||
    ![0, 2].includes(configuredRuntimeCount) ||
    (configuredRuntimeCount === 2 &&
      configuredRuntimeValues.some(
        (value) => typeof value !== 'string' || value.length === 0,
      ))
  ) {
    invalid('INVALID_USAGE')
  }
}

async function invokeAdapter({
  adapter,
  candidate,
  document,
  adapterSourceIdentity,
  retainedOutputDirectory,
  scratch,
  index,
  timeoutSeconds,
  validateOutputSchema,
  configuredRuntime,
}) {
  const invocationDirectory = await mkdtemp(join(scratch, `document-${index}-`))
  const requestPath = join(invocationDirectory, 'request.json')
  const outputPath = join(invocationDirectory, 'output.json')
  const request = createTargetFreeAdapterRequest(document)
  await assertDocumentStillVerified(document)
  await writeFile(requestPath, `${JSON.stringify(request)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  await assertAdapterSourceStillVerified(adapter, adapterSourceIdentity)
  if (configuredRuntime) {
    await Promise.all([
      assertCandidateExecutableStillVerified(configuredRuntime.executable),
      assertCandidateModelCacheHomeStillVerified(
        configuredRuntime.modelCacheHome,
      ),
    ])
  }
  const result = spawnSync(
    adapter,
    ['--request', requestPath, '--output', outputPath],
    {
      env: safeAdapterEnvironment(
        candidate,
        adapterSourceIdentity.sha256,
        invocationDirectory,
        configuredRuntime,
      ),
      cwd: invocationDirectory,
      stdio: 'ignore',
      timeout: timeoutSeconds * 1000,
      windowsHide: true,
    },
  )
  if (result.error || result.status !== 0) {
    invalid('PDF_TARGET_FREE_ADAPTER_FAILED')
  }
  await assertAdapterSourceStillVerified(adapter, adapterSourceIdentity)
  if (configuredRuntime) {
    await Promise.all([
      assertCandidateExecutableStillVerified(configuredRuntime.executable),
      assertCandidateModelCacheHomeStillVerified(
        configuredRuntime.modelCacheHome,
      ),
    ])
  }
  await assertDocumentStillVerified(document)
  const outputArtifact = await readAdapterOutput(outputPath)
  const output = validateAdapterOutput(
    outputArtifact,
    validateOutputSchema,
    document,
    candidate,
    adapterSourceIdentity.sha256,
  )
  if (
    configuredRuntime &&
    (!isRecord(output.runtimeIdentity?.tool) ||
      output.runtimeIdentity.tool.executableSha256 !==
        configuredRuntime.executable.identity.sha256 ||
      (configuredRuntime.executable.identity.versionAttestation ===
        'observed' &&
        (output.runtimeIdentity.tool.version !==
          configuredRuntime.executable.identity.version ||
          output.runtimeIdentity.tool.versionOutputSha256 !==
            configuredRuntime.executable.identity.versionOutputSha256)))
  ) {
    invalid('PDF_TARGET_FREE_CANDIDATE_RUNTIME_IDENTITY_MISMATCH')
  }
  const retainedOutputPath = join(
    retainedOutputDirectory,
    retainedOutputFilename(index),
  )
  try {
    await writeFile(retainedOutputPath, outputArtifact.bytes, {
      flag: 'wx',
      mode: RETAINED_OUTPUT_FILE_MODE,
    })
    await chmod(retainedOutputPath, RETAINED_OUTPUT_FILE_MODE)
  } catch {
    invalid('PDF_TARGET_FREE_RAW_OUTPUT_WRITE_FAILED')
  }
  const retainedOutputArtifact = await readAdapterOutput(retainedOutputPath)
  if (
    retainedOutputArtifact.byteLength !== outputArtifact.byteLength ||
    retainedOutputArtifact.fileSha256 !== outputArtifact.fileSha256
  ) {
    invalid('PDF_TARGET_FREE_RAW_OUTPUT_IDENTITY_MISMATCH')
  }
  return {
    candidateEvidence: {
      format: output.candidate.format,
      formatVersion: output.candidate.formatVersion,
      runtimeIdentity: structuredClone(output.runtimeIdentity),
    },
    documentResult: {
      id: document.id,
      byteLength: document.byteLength,
      sourceSha256: document.sha256,
      rawOutputByteLength: retainedOutputArtifact.byteLength,
      rawOutputSha256: retainedOutputArtifact.fileSha256,
    },
  }
}

export async function runPdfTargetFreeCandidateAcquisition(options) {
  assertRunOptions(options)
  const schemas = await compileSchemas()
  const manifestBytes = await readFile(options.manifest)
  const manifestArtifact = parseJsonArtifact(manifestBytes)
  const manifestIdentity = validateManifestArtifact(
    manifestArtifact,
    schemas.manifest,
  )
  const inputRoot = await resolveInputRoot(options.inputRoot)
  const output = resolve(options.output)
  if (output === inputRoot || within(inputRoot, output)) {
    invalid('PDF_TARGET_FREE_OUTPUT_MUST_NOT_BE_IN_INPUT_ROOT')
  }
  await assertPathAbsent(output, 'PDF_TARGET_FREE_RECEIPT_ALREADY_EXISTS')
  const configuredRuntime = await resolveConfiguredRuntime(options, inputRoot)
  const adapter = await resolveAdapter(options.adapter)
  const adapterSourceIdentity = await createAdapterSourceIdentity(adapter)
  const safeAdapterSource = sanitizedAdapterSource(adapterSourceIdentity)
  const documents = await verifyDocuments(manifestArtifact.value, inputRoot)
  const candidate = {
    id: options.candidateId,
    version: options.candidateVersion,
  }
  const retainedOutputDirectory = await createRetainedOutputDirectory(
    options.rawOutputDirectory,
    inputRoot,
    output,
  )
  const scratch = await mkdtemp(join(tmpdir(), 'pdf-target-free-candidate-'))
  try {
    const documentResults = []
    let candidateEvidence = null
    for (let index = 0; index < documents.length; index += 1) {
      const result = await invokeAdapter({
        adapter,
        candidate,
        document: documents[index],
        adapterSourceIdentity,
        retainedOutputDirectory,
        scratch,
        index,
        timeoutSeconds: options.timeoutSeconds,
        validateOutputSchema: schemas.adapterOutput,
        configuredRuntime,
      })
      if (
        candidateEvidence &&
        !sameCandidateEvidence(candidateEvidence, result.candidateEvidence)
      ) {
        invalid('PDF_TARGET_FREE_ADAPTER_RUNTIME_DRIFT')
      }
      candidateEvidence ??= result.candidateEvidence
      documentResults.push(result.documentResult)
    }

    const receiptBase = {
      schemaVersion: configuredRuntime
        ? PDF_TARGET_FREE_CONFIGURED_RUNTIME_RECEIPT_SCHEMA_VERSION
        : PDF_TARGET_FREE_RECEIPT_SCHEMA_VERSION,
      privacy: RECEIPT_PRIVACY,
      manifest: manifestIdentity,
      candidate: {
        id: candidate.id,
        version: candidate.version,
        format: publicAdapterIdentifier(candidateEvidence.format),
        formatVersion: publicAdapterIdentifier(candidateEvidence.formatVersion),
        adapterSource: safeAdapterSource,
        runtimeIdentity: sanitizeAdapterRuntimeIdentity(
          candidateEvidence.runtimeIdentity,
          configuredRuntime?.executable.identity ?? null,
        ),
        ...(configuredRuntime
          ? {
              runnerExecutableIdentity: structuredClone(
                configuredRuntime.executable.identity,
              ),
            }
          : {}),
      },
      execution: {
        lane: 'owner-local-target-free-candidate-acquisition',
        platform: platform(),
        architecture: arch(),
        environmentContract: 'minimal-env-scratch-cwd-home-temp',
        filesystemIsolation: 'not-sandboxed-host-filesystem-visible',
        networkIsolation: 'cooperative-offline-flags-not-enforced',
        isolationAttestation: 'absent',
        requestContract: 'document-id-path-byte-length-sha256-only',
        adapterInvocationCount: documentResults.length,
        allInputsVerified: true,
        runtimeIdentityAuthority: 'adapter-self-reported',
        ...(configuredRuntime
          ? {
              modelCacheAttestation:
                'directory-path-validated-model-contents-unattested',
            }
          : {}),
        rawOutputRetention:
          'owner-local-explicit-directory-0700-files-0600-no-overwrite',
        rawOutputIdentitySha256: canonicalHash(documentResults),
      },
      documents: documentResults,
      promotionEligible: false,
    }
    const receipt = {
      ...receiptBase,
      receiptSha256: canonicalHash(receiptBase),
    }
    await validatePdfTargetFreeCandidateReceipt(
      receipt,
      manifestBytes,
      safeAdapterSource,
      configuredRuntime?.executable.identity ?? null,
    )
    await validatePdfTargetFreeCandidateRetainedOutputs(
      receipt,
      retainedOutputDirectory,
    )
    return receipt
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

function valueAfter(arguments_, index) {
  const value = arguments_[index + 1]
  if (!value || value.startsWith('--')) invalid('INVALID_USAGE')
  return value
}

function parseNamedArguments(arguments_) {
  const values = {}
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (!argument.startsWith('--')) invalid('INVALID_USAGE')
    const equals = argument.indexOf('=')
    const key = argument.slice(2, equals < 0 ? undefined : equals)
    const value =
      equals < 0 ? valueAfter(arguments_, index) : argument.slice(equals + 1)
    if (equals < 0) index += 1
    if (!key || !value || Object.hasOwn(values, key)) {
      invalid('INVALID_USAGE')
    }
    values[key] = value
  }
  return values
}

function assertArgumentKeys(values, required, optional = []) {
  const keys = Object.keys(values)
  if (
    required.some((key) => !values[key]) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    invalid('INVALID_USAGE')
  }
}

function environmentPath(values, key, environment) {
  const name = values[key]
  if (
    !SAFE_ENVIRONMENT_NAME.test(name ?? '') ||
    typeof environment[name] !== 'string' ||
    environment[name].length === 0
  ) {
    invalid('INVALID_USAGE')
  }
  return resolve(environment[name])
}

export function parseTargetFreeRunArguments(
  arguments_,
  environment = process.env,
) {
  const values = parseNamedArguments(arguments_)
  assertArgumentKeys(
    values,
    [
      'manifest',
      'input-root-env',
      'adapter-env',
      'raw-output-dir-env',
      'candidate-id',
      'candidate-version',
      'out',
    ],
    [
      'timeout-seconds',
      'candidate-executable-env',
      'candidate-model-cache-home-env',
    ],
  )
  const timeoutSeconds = Number(values['timeout-seconds'] ?? 7200)
  if (
    !SAFE_ID.test(values['candidate-id']) ||
    !SAFE_ID.test(values['candidate-version']) ||
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 86_400
  ) {
    invalid('INVALID_USAGE')
  }
  const configuredRuntimeNames = [
    values['candidate-executable-env'],
    values['candidate-model-cache-home-env'],
  ]
  if (
    configuredRuntimeNames.filter((value) => value !== undefined).length === 1
  ) {
    invalid('INVALID_USAGE')
  }
  return {
    manifest: resolve(values.manifest),
    inputRoot: environmentPath(values, 'input-root-env', environment),
    adapter: environmentPath(values, 'adapter-env', environment),
    rawOutputDirectory: environmentPath(
      values,
      'raw-output-dir-env',
      environment,
    ),
    candidateId: values['candidate-id'],
    candidateVersion: values['candidate-version'],
    output: resolve(values.out),
    timeoutSeconds,
    ...(configuredRuntimeNames[0] && configuredRuntimeNames[1]
      ? {
          candidateExecutable: environmentPath(
            values,
            'candidate-executable-env',
            environment,
          ),
          candidateModelCacheHome: environmentPath(
            values,
            'candidate-model-cache-home-env',
            environment,
          ),
        }
      : {}),
  }
}

async function runCommand(arguments_) {
  const options = parseTargetFreeRunArguments(arguments_)
  const receipt = await runPdfTargetFreeCandidateAcquisition(options)
  await writeFile(options.output, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

async function validateCommand(arguments_) {
  const values = parseNamedArguments(arguments_)
  assertArgumentKeys(
    values,
    ['manifest', 'adapter-env', 'raw-output-dir-env', 'receipt'],
    ['candidate-executable-env'],
  )
  const adapter = await resolveAdapter(
    environmentPath(values, 'adapter-env', process.env),
  )
  const adapterSource = sanitizedAdapterSource(
    await createAdapterSourceIdentity(adapter),
  )
  const [manifestBytes, receiptBytes] = await Promise.all([
    readFile(resolve(values.manifest)),
    readFile(resolve(values.receipt)),
  ])
  const receipt = parseJsonArtifact(receiptBytes).value
  const expectedRunnerExecutableIdentity = values['candidate-executable-env']
    ? await observePdfTargetFreeCandidateExecutableIdentity(
        environmentPath(values, 'candidate-executable-env', process.env),
      )
    : null
  const result = await validatePdfTargetFreeCandidateReceipt(
    receipt,
    manifestBytes,
    adapterSource,
    expectedRunnerExecutableIdentity,
  )
  await validatePdfTargetFreeCandidateRetainedOutputs(
    receipt,
    environmentPath(values, 'raw-output-dir-env', process.env),
  )
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function usage() {
  return (
    [
      'Usage:',
      '  node tools/pdf-target-free-candidate-run.mjs run --manifest <manifest.json> --input-root-env <ENV> --adapter-env <ENV> --raw-output-dir-env <ENV> --candidate-id <id> --candidate-version <version> --out <new-sanitized-receipt.json> [--timeout-seconds <seconds>] [--candidate-executable-env <ENV> --candidate-model-cache-home-env <ENV>]',
      '  node tools/pdf-target-free-candidate-run.mjs validate --manifest <manifest.json> --adapter-env <ENV> --raw-output-dir-env <ENV> --receipt <sanitized-receipt.json> [--candidate-executable-env <ENV>]',
    ].join('\n') + '\n'
  )
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2)
  if (command === 'run') return runCommand(arguments_)
  if (command === 'validate') return validateCommand(arguments_)
  process.stderr.write(usage())
  process.exitCode = 2
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const code = /^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message ?? '')
      ? error.message
      : 'PDF_TARGET_FREE_CANDIDATE_RUN_FAILED'
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`)
    process.exitCode = 2
  })
}
