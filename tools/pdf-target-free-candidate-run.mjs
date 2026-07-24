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

const MANIFEST_PRIVACY =
  'public-document-identities-only-no-source-content-layout-targets-or-gold'
const RECEIPT_PRIVACY =
  'public-document-identities-adapter-runtime-and-raw-output-hashes-no-source-content-or-local-paths'
const MAX_JSON_BYTES = 128 * 1024 * 1024
const RETAINED_OUTPUT_DIRECTORY_MODE = 0o700
const RETAINED_OUTPUT_FILE_MODE = 0o600
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCHEMA_PATHS = {
  manifest: 'docs/schemas/pdf-target-free-candidate-manifest.schema.json',
  adapterOutput:
    'docs/schemas/pdf-target-free-candidate-adapter-output.schema.json',
  receipt: 'docs/schemas/pdf-target-free-candidate-receipt.schema.json',
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
    const [manifest, adapterOutput, receipt] = await Promise.all([
      readSchema(SCHEMA_PATHS.manifest),
      readSchema(SCHEMA_PATHS.adapterOutput),
      readSchema(SCHEMA_PATHS.receipt),
    ])
    return {
      manifest: new Ajv2020({ strict: false }).compile(manifest),
      adapterOutput: new Ajv2020({ strict: false }).compile(adapterOutput),
      receipt: new Ajv2020({ strict: false }).compile(receipt),
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

function safeAdapterEnvironment(
  candidate,
  adapterSourceSha256,
  invocationDirectory,
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

export async function validatePdfTargetFreeCandidateReceipt(
  receipt,
  manifestBytes,
  expectedAdapterSource = null,
) {
  try {
    const schemas = await compileSchemas()
    const manifestArtifact = parseJsonArtifact(manifestBytes)
    const manifestIdentity = validateManifestArtifact(
      manifestArtifact,
      schemas.manifest,
    )
    if (
      !schemas.receipt(receipt) ||
      receipt.schemaVersion !== PDF_TARGET_FREE_RECEIPT_SCHEMA_VERSION ||
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
  if (
    !isRecord(options) ||
    !['manifest', 'inputRoot', 'adapter', 'output', 'rawOutputDirectory'].every(
      (key) => typeof options[key] === 'string' && options[key].length > 0,
    ) ||
    !SAFE_ID.test(options.candidateId ?? '') ||
    !SAFE_ID.test(options.candidateVersion ?? '') ||
    !Number.isSafeInteger(options.timeoutSeconds) ||
    options.timeoutSeconds < 1 ||
    options.timeoutSeconds > 86_400
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
  const result = spawnSync(
    adapter,
    ['--request', requestPath, '--output', outputPath],
    {
      env: safeAdapterEnvironment(
        candidate,
        adapterSourceIdentity.sha256,
        invocationDirectory,
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
  await assertDocumentStillVerified(document)
  const outputArtifact = await readAdapterOutput(outputPath)
  const output = validateAdapterOutput(
    outputArtifact,
    validateOutputSchema,
    document,
    candidate,
    adapterSourceIdentity.sha256,
  )
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
      schemaVersion: PDF_TARGET_FREE_RECEIPT_SCHEMA_VERSION,
      privacy: RECEIPT_PRIVACY,
      manifest: manifestIdentity,
      candidate: {
        id: candidate.id,
        version: candidate.version,
        format: candidateEvidence.format,
        formatVersion: candidateEvidence.formatVersion,
        adapterSource: safeAdapterSource,
        runtimeIdentity: candidateEvidence.runtimeIdentity,
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
    ['timeout-seconds'],
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
  assertArgumentKeys(values, [
    'manifest',
    'adapter-env',
    'raw-output-dir-env',
    'receipt',
  ])
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
  const result = await validatePdfTargetFreeCandidateReceipt(
    receipt,
    manifestBytes,
    adapterSource,
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
      '  node tools/pdf-target-free-candidate-run.mjs run --manifest <manifest.json> --input-root-env <ENV> --adapter-env <ENV> --raw-output-dir-env <ENV> --candidate-id <id> --candidate-version <version> --out <new-sanitized-receipt.json> [--timeout-seconds <seconds>]',
      '  node tools/pdf-target-free-candidate-run.mjs validate --manifest <manifest.json> --adapter-env <ENV> --raw-output-dir-env <ENV> --receipt <sanitized-receipt.json>',
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
