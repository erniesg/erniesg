#!/usr/bin/env node
import { fork, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants, rmSync } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  auditPdfPath,
  canonicalJson,
  createSafeAuditFailureDocument,
  createCorpusReport,
  createPdfPipeline,
  PDF_CORPUS_REPORT_OCR_SCHEMA_PATH,
  PDF_CORPUS_REPORT_OCR_SCHEMA_VERSION,
  PDF_CORPUS_REPORT_SCHEMA_PATH,
  PDF_CORPUS_REPORT_SCHEMA_VERSION,
  pdfPaths,
  serializeCorpusReport,
} from './pdf-corpus-audit-lib.mjs'
import { safeAuditDiagnostic } from './pdf-corpus-audit-safety.mjs'
import { bindCorpusContractPaths } from './pdf-corpus-contract.mjs'
import {
  DEFAULT_HEADLESS_OCR_ENGINE,
  normalizeHeadlessOcrEngine,
} from './pdf-ocr-node.mjs'

const DEFAULT_TARGETS = ['paperPro', 'paperProMove']
export const DEFAULT_DOCUMENT_TIMEOUT_SECONDS = 900
export const MAX_STAGED_EPUB_BYTES = 256 * 1024 * 1024
export const MAX_STAGED_DOCUMENT_BYTES = 512 * 1024 * 1024
export const MAX_STAGED_MANIFEST_BYTES = 1024 * 1024
export const MAX_STAGED_CHECKSUM_BYTES = 64 * 1024
const STAGED_COPY_CHUNK_BYTES = 1024 * 1024
const MAX_DOCUMENT_TIMEOUT_SECONDS = 86_400
const DOCUMENT_WORKER_ARGUMENT = '--internal-pdf-export-document-worker'
const DOCUMENT_WORKER_RESULT = 'pdf-export-document-result-v1'
const DOCUMENT_WORKER_FATAL = 'pdf-export-document-fatal-v1'
const PDF_DOCUMENT_TIMEOUT = 'PDF_DOCUMENT_TIMEOUT'
const PDF_DOCUMENT_WORKER_FAILED = 'PDF_DOCUMENT_WORKER_FAILED'
const SAFE_SYMBOLIC_EXPORT_FAILURE_CODES = new Set([
  'EPUBCHECK_FAILED',
  'EPUBCHECK_REQUIRED',
  'EXPORT_STAGING_INVALID',
  'INVALID_PDF_CORPUS_REPORT',
  'OUTPUT_DIRECTORY_NOT_EMPTY',
  'OUTPUT_DIRECTORY_MUST_BE_ABSENT',
  'PDF_CORPUS_CONTRACT_MISMATCH',
  'UNKNOWN_PROFILE',
])
const encoder = new TextEncoder()
const activeWorkerProcesses = new Set()
const activeWorkspaces = new Set()
let temporaryFileSequence = 0
let failureStage = 'startup'

function safeFailureCode(error) {
  const message = error instanceof Error ? error.message : ''
  const symbolicCode = message.match(/^([A-Z][A-Z0-9_]+)(?::|$)/)?.[1]
  if (symbolicCode && SAFE_SYMBOLIC_EXPORT_FAILURE_CODES.has(symbolicCode)) {
    return symbolicCode
  }
  if (message.includes('canonical node ids must be globally unique')) {
    return 'EPUB_DUPLICATE_CANONICAL_NODE_ID'
  }
  if (message.includes('well-formed XML')) return 'EPUB_XML_INVALID'
  if (message.includes('dangling')) return 'EPUB_DANGLING_REFERENCE'
  if (message.includes('unsafe')) return 'EPUB_UNSAFE_REFERENCE'
  if (message.includes('missing selected asset')) {
    return 'EPUB_MISSING_SELECTED_ASSET'
  }
  if (message.includes('bytes do not match')) {
    return 'EPUB_ASSET_MEDIA_TYPE_MISMATCH'
  }
  return 'UNCLASSIFIED_EXPORT_FAILURE'
}

function recordDocumentExportFailure(document, error) {
  const code = safeFailureCode(error)
  const diagnostic = safeAuditDiagnostic({
    code,
    severity: 'error',
  })
  const diagnostics = [...(document.diagnostics ?? [])]
  let truncated = document.diagnosticSamplesTruncated ?? 0
  if (diagnostics.length < 64) {
    diagnostics.push(diagnostic)
    diagnostics.sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        left.severity.localeCompare(right.severity) ||
        (left.page ?? Number.MAX_SAFE_INTEGER) -
          (right.page ?? Number.MAX_SAFE_INTEGER) ||
        left.message.localeCompare(right.message),
    )
  } else {
    truncated += 1
  }
  document.diagnosticCounts = {
    ...(document.diagnosticCounts ?? {}),
    [code]: (document.diagnosticCounts?.[code] ?? 0) + 1,
  }
  document.diagnosticCounts = Object.fromEntries(
    Object.entries(document.diagnosticCounts).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  )
  document.diagnostics = diagnostics
  document.diagnosticSamplesTruncated = truncated
  document.exports = []
  document.readiness = {
    ...document.readiness,
    status: 'review-required',
    ready: false,
    blockingDiagnosticCodes: [
      ...new Set([...document.readiness.blockingDiagnosticCodes, code]),
    ].sort(),
  }
}

function usage() {
  return 'Usage: npm run pdf:export -- <pdf-or-directory> [--target <profile>]... [--ocr-engine <none|tesseract>] [--readable-fallback] [--require-epubcheck] [--document-timeout-seconds <1-86400>] [--corpus-contract <contract.json> --corpus-set <frozen|seededRandom>] --out <directory>\n'
}

function parsePositiveInteger(value, maximum) {
  if (!/^[1-9][0-9]*$/.test(value ?? '')) throw new Error('INVALID_USAGE')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error('INVALID_USAGE')
  }
  return parsed
}

export function parseArguments(arguments_) {
  const inputs = []
  const targets = []
  let outputDirectory
  let readableFallback = false
  let requireEpubCheck = false
  let documentTimeoutSeconds = null
  let corpusContractPath = null
  let corpusSet = null
  let ocrEngine = null

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--target') {
      const value = arguments_[index + 1]
      if (!value || value.startsWith('--')) throw new Error('INVALID_USAGE')
      targets.push(value)
      index += 1
      continue
    }
    if (argument.startsWith('--target=')) {
      targets.push(argument.slice('--target='.length))
      continue
    }
    if (argument === '--out') {
      const value = arguments_[index + 1]
      if (!value || value.startsWith('--')) throw new Error('INVALID_USAGE')
      outputDirectory = value
      index += 1
      continue
    }
    if (argument.startsWith('--out=')) {
      outputDirectory = argument.slice('--out='.length)
      continue
    }
    if (argument === '--readable-fallback') {
      readableFallback = true
      continue
    }
    if (argument === '--require-epubcheck') {
      requireEpubCheck = true
      continue
    }
    if (argument === '--ocr-engine') {
      if (ocrEngine !== null) throw new Error('INVALID_USAGE')
      const value = arguments_[index + 1]
      if (!value || value.startsWith('--')) throw new Error('INVALID_USAGE')
      ocrEngine = value
      index += 1
      continue
    }
    if (argument.startsWith('--ocr-engine=')) {
      if (ocrEngine !== null) throw new Error('INVALID_USAGE')
      ocrEngine = argument.slice('--ocr-engine='.length)
      continue
    }
    if (argument === '--document-timeout-seconds') {
      if (documentTimeoutSeconds !== null) throw new Error('INVALID_USAGE')
      documentTimeoutSeconds = parsePositiveInteger(
        arguments_[index + 1],
        MAX_DOCUMENT_TIMEOUT_SECONDS,
      )
      index += 1
      continue
    }
    if (argument.startsWith('--document-timeout-seconds=')) {
      if (documentTimeoutSeconds !== null) throw new Error('INVALID_USAGE')
      documentTimeoutSeconds = parsePositiveInteger(
        argument.slice('--document-timeout-seconds='.length),
        MAX_DOCUMENT_TIMEOUT_SECONDS,
      )
      continue
    }
    if (argument === '--corpus-contract') {
      if (corpusContractPath !== null) throw new Error('INVALID_USAGE')
      const value = arguments_[index + 1]
      if (!value || value.startsWith('--')) throw new Error('INVALID_USAGE')
      corpusContractPath = value
      index += 1
      continue
    }
    if (argument.startsWith('--corpus-contract=')) {
      if (corpusContractPath !== null) throw new Error('INVALID_USAGE')
      corpusContractPath = argument.slice('--corpus-contract='.length)
      continue
    }
    if (argument === '--corpus-set') {
      if (corpusSet !== null) throw new Error('INVALID_USAGE')
      const value = arguments_[index + 1]
      if (!value || value.startsWith('--')) throw new Error('INVALID_USAGE')
      corpusSet = value
      index += 1
      continue
    }
    if (argument.startsWith('--corpus-set=')) {
      if (corpusSet !== null) throw new Error('INVALID_USAGE')
      corpusSet = argument.slice('--corpus-set='.length)
      continue
    }
    if (argument.startsWith('--')) throw new Error('INVALID_USAGE')
    inputs.push(argument)
  }

  if (
    inputs.length === 0 ||
    !outputDirectory ||
    corpusContractPath === '' ||
    (corpusContractPath === null) !== (corpusSet === null) ||
    (corpusSet !== null && !['frozen', 'seededRandom'].includes(corpusSet))
  ) {
    throw new Error('INVALID_USAGE')
  }
  return {
    inputs,
    outputDirectory: resolve(outputDirectory),
    readableFallback,
    requireEpubCheck,
    documentTimeoutSeconds:
      documentTimeoutSeconds ?? DEFAULT_DOCUMENT_TIMEOUT_SECONDS,
    corpusContractPath,
    corpusSet,
    ocrEngine: normalizeHeadlessOcrEngine(
      ocrEngine ?? DEFAULT_HEADLESS_OCR_ENGINE,
    ),
    targets: [...new Set(targets.length > 0 ? targets : DEFAULT_TARGETS)],
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonBytes(value) {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`)
}

function commandResult(command, arguments_, timeout = 10_000) {
  return spawnSync(command, arguments_, {
    stdio: 'ignore',
    timeout,
    windowsHide: true,
  })
}

async function epubCheckValidator() {
  const direct = commandResult('epubcheck', ['--version'])
  if (!direct.error && direct.status === 0) {
    return {
      kind: 'command',
      command: 'epubcheck',
      arguments: ['--failonwarnings'],
    }
  }

  const java = commandResult('java', ['-version'])
  if (java.error || java.status !== 0) {
    return { kind: 'skipped', reason: 'java-unavailable' }
  }

  const jarCandidates = [
    process.env.EPUBCHECK_JAR,
    resolve('tools/epubcheck/epubcheck.jar'),
    '/usr/share/java/epubcheck.jar',
    '/usr/local/share/java/epubcheck.jar',
  ].filter(Boolean)
  for (const jar of jarCandidates) {
    try {
      await access(jar)
      return {
        kind: 'command',
        command: 'java',
        arguments: ['-jar', jar, '--failonwarnings'],
      }
    } catch {
      // Missing local validators are reported without exposing their paths.
    }
  }
  return { kind: 'skipped', reason: 'epubcheck-unavailable' }
}

async function validateWithEpubCheck(bytes, validator, temporaryRoot) {
  if (validator.kind === 'skipped') {
    return { status: 'skipped', reason: validator.reason }
  }

  const directory = await mkdtemp(join(temporaryRoot, 'srt-epubcheck-'))
  const path = join(directory, 'publication.epub')
  try {
    await writeFile(path, bytes)
    const result = commandResult(
      validator.command,
      [...validator.arguments, path],
      120_000,
    )
    if (result.error || result.status !== 0) {
      throw new Error('EPUBCHECK_FAILED')
    }
    return { status: 'passed' }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function safeStem(value) {
  return (
    basename(value, extname(value))
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-|-$/g, '') || 'publication'
  )
}

function documentOutputDirectory(root, document, documentCount) {
  if (documentCount === 1) return root
  return join(
    root,
    `${safeStem(document.basename)}-${document.sha256.slice(0, 12)}`,
  )
}

async function writeAtomically(path, bytes) {
  await mkdir(dirname(path), { recursive: true })
  temporaryFileSequence += 1
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${temporaryFileSequence}.tmp`,
  )
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function createPdfCorpusReportValidator() {
  const [legacySchema, ocrSchema] = await Promise.all(
    [PDF_CORPUS_REPORT_SCHEMA_PATH, PDF_CORPUS_REPORT_OCR_SCHEMA_PATH].map(
      async (path) =>
        JSON.parse(
          await readFile(new URL(`../${path}`, import.meta.url), 'utf8'),
        ),
    ),
  )
  const ajv = new Ajv2020({ strict: false })
  const legacyValidator = ajv.compile(legacySchema)
  const ocrValidator = ajv.compile(ocrSchema)
  const validators = new Map([
    [
      `${PDF_CORPUS_REPORT_SCHEMA_VERSION}\0${PDF_CORPUS_REPORT_SCHEMA_PATH}`,
      legacyValidator,
    ],
    [
      `${PDF_CORPUS_REPORT_OCR_SCHEMA_VERSION}\0${PDF_CORPUS_REPORT_OCR_SCHEMA_PATH}`,
      ocrValidator,
    ],
  ])
  const validate = (report) => {
    const validator = validators.get(
      `${String(report?.schemaVersion)}\0${String(report?.reportSchema)}`,
    )
    const valid = validator ? validator(report) : false
    validate.errors = validator?.errors ?? null
    return valid
  }
  validate.errors = null
  return validate
}

function assertValidCorpusReport(report, reportValidator) {
  if (!reportValidator(report)) throw new Error('INVALID_PDF_CORPUS_REPORT')
}

function validWorkerDocument(document, path, policy, reportValidator) {
  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    document.basename !== basename(path) ||
    /[\\/]/u.test(document.basename)
  ) {
    return false
  }
  if (!Object.hasOwn(document, 'readiness')) {
    return (
      canonicalJson(document) ===
      canonicalJson(createSafeAuditFailureDocument(path, document.code))
    )
  }
  try {
    if (
      canonicalJson(document.readiness?.policy) !== canonicalJson(policy) ||
      !Array.isArray(document.diagnostics) ||
      document.diagnostics.some(
        (diagnostic) =>
          canonicalJson(diagnostic) !==
          canonicalJson(safeAuditDiagnostic(diagnostic)),
      )
    ) {
      return false
    }
    assertValidCorpusReport(
      createCorpusReport([document], policy),
      reportValidator,
    )
    return true
  } catch {
    return false
  }
}

function killProcessTree(pid, fallbackKill) {
  if (!pid) return
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true,
    })
    if (!result.error && result.status === 0) return
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      // Fall through when the process group already exited or was unavailable.
    }
  }
  try {
    fallbackKill()
  } catch {
    // A worker that exited between the timeout and kill needs no more cleanup.
  }
}

function killWorkerProcessTree(child) {
  killProcessTree(child.pid, () => child.kill('SIGKILL'))
}

export function installPdfExportSignalHandlers() {
  const handlers = new Map()
  let handlingSignal = false
  const remove = () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler)
    }
    handlers.clear()
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      if (handlingSignal) return
      handlingSignal = true
      for (const child of activeWorkerProcesses) killWorkerProcessTree(child)
      for (const workspace of activeWorkspaces) {
        try {
          rmSync(workspace, { recursive: true, force: true })
        } catch {
          // The normal async cleanup may already have removed the workspace.
        }
      }
      remove()
      process.kill(process.pid, signal)
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  return remove
}

export function installPdfExportWorkerDisconnectGuard() {
  let armed = true
  const handler = () => {
    if (!armed) return
    killProcessTree(process.pid, () => process.kill(process.pid, 'SIGKILL'))
  }
  process.once('disconnect', handler)
  return () => {
    armed = false
    process.removeListener('disconnect', handler)
  }
}

function validWorkerMessage(message) {
  if (
    message === null ||
    typeof message !== 'object' ||
    Array.isArray(message)
  ) {
    return false
  }
  if (message.type === DOCUMENT_WORKER_RESULT) {
    return (
      hasExactKeys(message, ['type', 'document']) &&
      message.document !== null &&
      typeof message.document === 'object' &&
      !Array.isArray(message.document)
    )
  }
  return (
    hasExactKeys(message, ['type', 'code']) &&
    message.type === DOCUMENT_WORKER_FATAL &&
    message.code === 'PDF_CORPUS_CONTRACT_MISMATCH'
  )
}

export function runIsolatedPdfExportJob(
  job,
  { timeoutMs, workerModule = fileURLToPath(import.meta.url) } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('INVALID_DOCUMENT_TIMEOUT')
  }

  return new Promise((resolveResult) => {
    const detached = process.platform !== 'win32'
    const child = fork(workerModule, [DOCUMENT_WORKER_ARGUMENT], {
      detached,
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    })
    activeWorkerProcesses.add(child)
    let response = null
    let protocolFailed = false
    let spawnFailed = false
    let timedOut = false
    let settled = false

    const timeout = setTimeout(() => {
      timedOut = true
      killWorkerProcessTree(child)
    }, timeoutMs)

    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveResult(result)
    }

    child.on('message', (message) => {
      if (response !== null || !validWorkerMessage(message)) {
        protocolFailed = true
        killWorkerProcessTree(child)
        return
      }
      response = message
    })
    child.once('error', () => {
      spawnFailed = true
    })
    child.once('close', (code) => {
      activeWorkerProcesses.delete(child)
      if (timedOut) {
        settle({ status: 'timeout' })
        return
      }
      if (spawnFailed || protocolFailed || code !== 0 || response === null) {
        settle({ status: 'failed' })
        return
      }
      if (response.type === DOCUMENT_WORKER_FATAL) {
        settle({ status: 'fatal', code: response.code })
        return
      }
      settle({ status: 'completed', document: response.document })
    })
    child.send(job, (error) => {
      if (!error) return
      spawnFailed = true
      killWorkerProcessTree(child)
    })
  })
}

async function exportDocument({
  record,
  profiles,
  exportModules,
  validator,
  outputDirectory,
  documentCount,
}) {
  const artifacts = []
  const canonicalPaper = record.reconstruction.readiness.ready
    ? record.reconstruction.paper
    : exportModules.projectReadableFallbackReconstruction(record.reconstruction)
        .paper
  for (const profile of profiles) {
    failureStage = 'epub-build'
    const epub = record.reconstruction.readiness.ready
      ? await exportModules.buildEpub(
          record.reconstruction.paper,
          record.reconstruction,
          profile,
        )
      : await exportModules.buildReadableEpub(
          record.reconstruction.paper,
          record.reconstruction,
          profile,
        )
    failureStage = 'epub-structural-validation'
    exportModules.inspectEpub(epub.bytes, profile, {
      canonicalPaper,
      sourceCanonicalPaper: record.reconstruction.paper,
      sourcePdfSha256: record.reconstruction.source.sha256,
    })
    failureStage = 'epubcheck-validation'
    artifacts.push({
      epub,
      metadata: {
        target: profile.id,
        basename: epub.fileName,
        byteLength: epub.bytes.byteLength,
        sha256: epub.sha256,
        mode: epub.mode,
        structuralValidation: 'passed',
        epubCheck: await validateWithEpubCheck(
          epub.bytes,
          validator,
          outputDirectory,
        ),
      },
    })
  }

  const manifest = {
    schemaVersion: '1.1.0',
    privacy: 'basename-hash-metrics-only',
    source: {
      basename: record.document.basename,
      sha256: record.document.sha256,
      byteLength: record.document.byteLength,
      pageCount: record.document.pageCount,
    },
    completeness: record.document.completeness,
    readiness: record.document.readiness,
    ...(record.document.ocr ? { ocr: record.document.ocr } : {}),
    exports: artifacts.map(({ epub, metadata }) => ({
      ...metadata,
      profile: epub.profile,
    })),
    determinism: {
      volatileFields: [],
      guarantee:
        'Identical inputs, profiles, policy versions, dependency versions, and compatible runtimes produce byte-identical artifacts and reports.',
    },
  }
  const manifestBytes = jsonBytes(manifest)
  const checksumLines = [
    ...artifacts.map(({ epub }) => `${epub.sha256}  ${epub.fileName}`),
    `${sha256(manifestBytes)}  export-manifest.json`,
  ]
  const checksums = encoder.encode(`${checksumLines.join('\n')}\n`)
  const destination = documentOutputDirectory(
    outputDirectory,
    record.document,
    documentCount,
  )

  // All gates and validators finish before any artifact for this document is
  // published to the caller's output directory.
  failureStage = 'artifact-publication'
  for (const { epub } of artifacts) {
    await writeAtomically(join(destination, epub.fileName), epub.bytes)
  }
  await writeAtomically(
    join(destination, 'export-manifest.json'),
    manifestBytes,
  )
  await writeAtomically(join(destination, 'checksums.sha256'), checksums)
  return artifacts.map(({ metadata }) => metadata)
}

function validWorkerJob(job) {
  return (
    job !== null &&
    typeof job === 'object' &&
    typeof job.path === 'string' &&
    job.path.length > 0 &&
    Array.isArray(job.targets) &&
    job.targets.length > 0 &&
    job.targets.every((target) => typeof target === 'string') &&
    typeof job.readableFallback === 'boolean' &&
    ['none', 'tesseract'].includes(job.ocrEngine) &&
    job.validator !== null &&
    typeof job.validator === 'object' &&
    typeof job.stagingDirectory === 'string' &&
    job.stagingDirectory.length > 0
  )
}

export async function runPdfExportWorkerJob(job) {
  if (!validWorkerJob(job)) throw new Error('INVALID_DOCUMENT_WORKER_JOB')
  failureStage = 'pipeline-initialization'
  const pipeline = await createPdfPipeline({
    temporaryRoot: job.stagingDirectory,
    ocrEngine: job.ocrEngine,
  })
  try {
    failureStage = 'pdf-audit'
    const record = await auditPdfPath(job.path, pipeline, {
      expectedSource: job.expectedSource,
    })
    if (!record.reconstruction) {
      return { type: DOCUMENT_WORKER_RESULT, document: record.document }
    }

    failureStage = 'export-module-load'
    const exportModules = await pipeline.loadExportModules()
    if (
      job.targets.some(
        (target) => !exportModules.targetProfileIds.includes(target),
      )
    ) {
      throw new Error('UNKNOWN_PROFILE')
    }
    if (!record.reconstruction.readiness.ready) {
      if (!job.readableFallback) {
        return { type: DOCUMENT_WORKER_RESULT, document: record.document }
      }
      if (
        record.reconstruction.completeness.ocrRequiredPages.length > 0 ||
        record.reconstruction.paper.nodes.length === 0
      ) {
        return { type: DOCUMENT_WORKER_RESULT, document: record.document }
      }
    }

    try {
      record.document.exports = await exportDocument({
        record,
        profiles: job.targets.map(exportModules.getTargetProfile),
        exportModules,
        validator: job.validator,
        outputDirectory: job.stagingDirectory,
        documentCount: 1,
      })
    } catch (error) {
      recordDocumentExportFailure(record.document, error)
    }
    return { type: DOCUMENT_WORKER_RESULT, document: record.document }
  } finally {
    await pipeline.close()
  }
}

function expectedArtifactNames(document) {
  if (!Array.isArray(document.exports) || document.exports.length === 0) {
    return []
  }
  const artifactNames = document.exports.map((artifact) => artifact?.basename)
  if (
    artifactNames.some(
      (name) =>
        typeof name !== 'string' ||
        name.length === 0 ||
        basename(name) !== name ||
        name === '.' ||
        name === '..',
    ) ||
    new Set(artifactNames).size !== artifactNames.length
  ) {
    return null
  }
  return [...artifactNames, 'checksums.sha256', 'export-manifest.json'].sort()
}

function hasExactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

function stagedReadFlags() {
  return (
    fsConstants.O_RDONLY |
    (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
  )
}

function expectedExportManifestBytes(document, profilesById) {
  const selectedTargets = [...profilesById.keys()]
  if (
    document.exports.length !== selectedTargets.length ||
    document.exports.some(
      (artifact, index) => artifact.target !== selectedTargets[index],
    )
  ) {
    return null
  }
  const exports = document.exports.map((artifact) => ({
    target: artifact.target,
    basename: artifact.basename,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    mode: artifact.mode,
    structuralValidation: artifact.structuralValidation,
    epubCheck: {
      status: artifact.epubCheck.status,
      ...(artifact.epubCheck.reason === undefined
        ? {}
        : { reason: artifact.epubCheck.reason }),
    },
    profile: profilesById.get(artifact.target),
  }))
  if (exports.some((artifact) => artifact.profile === undefined)) return null
  return jsonBytes({
    schemaVersion: '1.1.0',
    privacy: 'basename-hash-metrics-only',
    source: {
      basename: document.basename,
      sha256: document.sha256,
      byteLength: document.byteLength,
      pageCount: document.pageCount,
    },
    completeness: document.completeness,
    readiness: document.readiness,
    ...(document.ocr ? { ocr: document.ocr } : {}),
    exports,
    determinism: {
      volatileFields: [],
      guarantee:
        'Identical inputs, profiles, policy versions, dependency versions, and compatible runtimes produce byte-identical artifacts and reports.',
    },
  })
}

function expectedChecksumBytes(document, manifestBytes) {
  return encoder.encode(
    `${[
      ...document.exports.map(
        (artifact) => `${artifact.sha256}  ${artifact.basename}`,
      ),
      `${sha256(manifestBytes)}  export-manifest.json`,
    ].join('\n')}\n`,
  )
}

function stagedDocumentExpectations(document, profilesById) {
  let totalBytes = 0
  for (const artifact of document.exports) {
    if (
      !Number.isSafeInteger(artifact.byteLength) ||
      artifact.byteLength < 1 ||
      artifact.byteLength > MAX_STAGED_EPUB_BYTES ||
      totalBytes > MAX_STAGED_DOCUMENT_BYTES - artifact.byteLength
    ) {
      return null
    }
    totalBytes += artifact.byteLength
  }

  const manifestBytes = expectedExportManifestBytes(document, profilesById)
  if (
    manifestBytes === null ||
    manifestBytes.byteLength > MAX_STAGED_MANIFEST_BYTES
  ) {
    return null
  }
  const checksumBytes = expectedChecksumBytes(document, manifestBytes)
  if (
    checksumBytes.byteLength > MAX_STAGED_CHECKSUM_BYTES ||
    totalBytes >
      MAX_STAGED_DOCUMENT_BYTES -
        manifestBytes.byteLength -
        checksumBytes.byteLength
  ) {
    return null
  }
  return { manifestBytes, checksumBytes }
}

async function stagedControlFileMatches(path, expectedBytes, maximumBytes) {
  if (expectedBytes.byteLength > maximumBytes) return false
  const handle = await open(path, stagedReadFlags())
  try {
    const before = await handle.stat()
    if (
      !before.isFile() ||
      before.size !== expectedBytes.byteLength ||
      before.size > maximumBytes
    ) {
      return false
    }
    const actual = Buffer.allocUnsafe(expectedBytes.byteLength)
    let offset = 0
    while (offset < actual.byteLength) {
      const { bytesRead } = await handle.read(
        actual,
        offset,
        actual.byteLength - offset,
        offset,
      )
      if (bytesRead === 0) return false
      offset += bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) return false
    const after = await handle.stat()
    return (
      after.isFile() &&
      after.size === expectedBytes.byteLength &&
      actual.equals(Buffer.from(expectedBytes))
    )
  } finally {
    await handle.close()
  }
}

async function copyVerifiedStagedArtifact(
  sourcePath,
  destinationPath,
  expectedLength,
  expectedSha256,
) {
  await mkdir(dirname(destinationPath), { recursive: true })
  temporaryFileSequence += 1
  const temporaryPath = join(
    dirname(destinationPath),
    `.${basename(destinationPath)}.${process.pid}.${temporaryFileSequence}.tmp`,
  )
  const source = await open(sourcePath, stagedReadFlags())
  let destination = null
  let valid = false
  try {
    const before = await source.stat()
    if (
      !before.isFile() ||
      before.size !== expectedLength ||
      before.size > MAX_STAGED_EPUB_BYTES
    ) {
      throw new Error('INVALID_STAGED_FILE')
    }
    destination = await open(temporaryPath, 'wx', 0o600)
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(
      Math.min(STAGED_COPY_CHUNK_BYTES, expectedLength),
    )
    let sourceOffset = 0
    while (sourceOffset < expectedLength) {
      const requested = Math.min(
        chunk.byteLength,
        expectedLength - sourceOffset,
      )
      const { bytesRead } = await source.read(chunk, 0, requested, sourceOffset)
      if (bytesRead === 0) throw new Error('INVALID_STAGED_FILE')
      hash.update(chunk.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(
          chunk,
          written,
          bytesRead - written,
          sourceOffset + written,
        )
        if (result.bytesWritten === 0) {
          throw new Error('INVALID_VERIFIED_FILE')
        }
        written += result.bytesWritten
      }
      sourceOffset += bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await source.read(extra, 0, 1, sourceOffset)).bytesRead !== 0) {
      throw new Error('INVALID_STAGED_FILE')
    }
    const after = await source.stat()
    valid =
      after.isFile() &&
      after.size === expectedLength &&
      hash.digest('hex') === expectedSha256
  } catch {
    valid = false
  } finally {
    await source.close()
    await destination?.close()
  }
  if (!valid) {
    await rm(temporaryPath, { force: true })
    return false
  }
  try {
    await rename(temporaryPath, destinationPath)
    return true
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function directoryMatchesExpectedRegularFiles(
  path,
  expectedNames,
  openDirectory = opendir,
) {
  const remaining = new Set(expectedNames)
  if (remaining.size !== expectedNames.length) return false

  const directory = await openDirectory(path)
  let entriesRead = 0
  try {
    while (true) {
      const entry = await directory.read()
      if (entry === null) {
        return entriesRead === expectedNames.length && remaining.size === 0
      }
      entriesRead += 1
      if (
        entriesRead > expectedNames.length ||
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !remaining.delete(entry.name)
      ) {
        return false
      }
    }
  } finally {
    await directory.close()
  }
}

async function verifyDocumentStaging(
  document,
  stagingDirectory,
  verifiedDirectory,
  profilesById,
) {
  const expected = expectedArtifactNames(document)
  if (expected === null) return null
  if (expected.length === 0 && document.readiness?.ready) return null
  try {
    if (
      !(await directoryMatchesExpectedRegularFiles(stagingDirectory, expected))
    ) {
      return null
    }
  } catch {
    return null
  }
  if (expected.length === 0) return []

  const expectations = stagedDocumentExpectations(document, profilesById)
  if (expectations === null) return null
  let verified = false
  try {
    if (
      !(await stagedControlFileMatches(
        join(stagingDirectory, 'export-manifest.json'),
        expectations.manifestBytes,
        MAX_STAGED_MANIFEST_BYTES,
      )) ||
      !(await stagedControlFileMatches(
        join(stagingDirectory, 'checksums.sha256'),
        expectations.checksumBytes,
        MAX_STAGED_CHECKSUM_BYTES,
      ))
    ) {
      return null
    }
    await mkdir(verifiedDirectory, { mode: 0o700 })
    for (const artifact of document.exports) {
      if (
        !(await copyVerifiedStagedArtifact(
          join(stagingDirectory, artifact.basename),
          join(verifiedDirectory, artifact.basename),
          artifact.byteLength,
          artifact.sha256,
        ))
      ) {
        return null
      }
    }
    await Promise.all([
      writeAtomically(
        join(verifiedDirectory, 'export-manifest.json'),
        expectations.manifestBytes,
      ),
      writeAtomically(
        join(verifiedDirectory, 'checksums.sha256'),
        expectations.checksumBytes,
      ),
    ])
    verified = true
    return expected
  } catch {
    return null
  } finally {
    if (!verified) {
      await rm(verifiedDirectory, { recursive: true, force: true })
    }
  }
}

async function promoteVerifiedFiles(
  verifiedDirectory,
  destinationDirectory,
  names,
) {
  await mkdir(destinationDirectory, { recursive: true })
  for (const name of names) {
    await rename(
      join(verifiedDirectory, name),
      join(destinationDirectory, name),
    )
  }
  await rm(verifiedDirectory, { recursive: true, force: true })
}

export async function assertPublishableOutput(
  path,
  platform = process.platform,
) {
  try {
    const details = await lstat(path)
    if (
      !details.isDirectory() ||
      !(await directoryMatchesExpectedRegularFiles(path, []))
    ) {
      throw new Error('OUTPUT_DIRECTORY_NOT_EMPTY')
    }
    if (platform === 'win32') {
      throw new Error('OUTPUT_DIRECTORY_MUST_BE_ABSENT')
    }
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function publishRunDirectory(runDirectory, outputDirectory) {
  await assertPublishableOutput(outputDirectory)
  await rename(runDirectory, outputDirectory)
}

export async function processExportDocuments({
  paths,
  corpusContract,
  policy,
  reportValidator,
  targetProfiles,
  ocrEngine = DEFAULT_HEADLESS_OCR_ENGINE,
  readableFallback,
  validator,
  outputDirectory,
  timeoutMs,
  runWorker = runIsolatedPdfExportJob,
  workerModule,
}) {
  const documents = []
  const expectedById = new Map(
    (corpusContract?.documents ?? []).map((document) => [
      document.id,
      document,
    ]),
  )
  const profilesById = new Map(
    targetProfiles.map((profile) => [profile.id, profile]),
  )
  await assertPublishableOutput(outputDirectory)
  await mkdir(dirname(outputDirectory), { recursive: true })
  const workspace = await mkdtemp(
    join(dirname(outputDirectory), `.${safeStem(basename(outputDirectory))}-`),
  )
  activeWorkspaces.add(workspace)
  const runDirectory = join(workspace, 'publication')
  const workerDirectory = join(workspace, 'workers')
  const verificationDirectory = join(workspace, 'verified')

  try {
    await Promise.all([
      mkdir(runDirectory, { mode: 0o700 }),
      mkdir(workerDirectory, { mode: 0o700 }),
      mkdir(verificationDirectory, { mode: 0o700 }),
    ])
    for (const [index, path] of paths.entries()) {
      const expectedSource =
        expectedById.get(basename(path, extname(path))) ?? null
      if (corpusContract && !expectedSource) {
        throw new Error('PDF_CORPUS_CONTRACT_MISMATCH')
      }
      const stagingDirectory = join(
        workerDirectory,
        String(index + 1).padStart(6, '0'),
      )
      const verifiedDirectory = join(
        verificationDirectory,
        String(index + 1).padStart(6, '0'),
      )
      await mkdir(stagingDirectory, { mode: 0o700 })
      const result = await runWorker(
        {
          path,
          expectedSource,
          targets: targetProfiles.map((profile) => profile.id),
          ocrEngine,
          readableFallback,
          validator,
          stagingDirectory,
        },
        { timeoutMs, workerModule },
      )

      if (result.status === 'fatal') throw new Error(result.code)
      if (result.status === 'timeout') {
        documents.push(
          createSafeAuditFailureDocument(path, PDF_DOCUMENT_TIMEOUT),
        )
        await rm(stagingDirectory, { recursive: true, force: true })
        continue
      }
      if (
        result.status !== 'completed' ||
        !validWorkerDocument(result.document, path, policy, reportValidator)
      ) {
        documents.push(
          createSafeAuditFailureDocument(path, PDF_DOCUMENT_WORKER_FAILED),
        )
        await rm(stagingDirectory, { recursive: true, force: true })
        continue
      }

      const verifiedFiles = await verifyDocumentStaging(
        result.document,
        stagingDirectory,
        verifiedDirectory,
        profilesById,
      )
      if (verifiedFiles === null) {
        if (result.document.readiness) {
          recordDocumentExportFailure(
            result.document,
            new Error('EXPORT_STAGING_INVALID'),
          )
        } else {
          result.document = createSafeAuditFailureDocument(
            path,
            PDF_DOCUMENT_WORKER_FAILED,
          )
        }
      } else if (verifiedFiles.length > 0) {
        const destination = documentOutputDirectory(
          runDirectory,
          result.document,
          paths.length,
        )
        await promoteVerifiedFiles(
          verifiedDirectory,
          destination,
          verifiedFiles,
        )
      }
      await rm(stagingDirectory, { recursive: true, force: true })
      documents.push(result.document)
    }

    documents.sort(
      (left, right) =>
        left.basename.localeCompare(right.basename) ||
        String(left.sha256).localeCompare(String(right.sha256)),
    )
    const report = createCorpusReport(documents, policy, { corpusContract })
    assertValidCorpusReport(report, reportValidator)
    const serialized = serializeCorpusReport(report)
    await writeAtomically(
      join(runDirectory, 'corpus-audit.json'),
      encoder.encode(serialized),
    )
    await publishRunDirectory(runDirectory, outputDirectory)
    return { report, serialized }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    activeWorkspaces.delete(workspace)
  }
}

function receiveWorkerJob() {
  return new Promise((resolveJob, rejectJob) => {
    if (typeof process.send !== 'function') {
      rejectJob(new Error('DOCUMENT_WORKER_IPC_REQUIRED'))
      return
    }
    process.once('message', resolveJob)
    process.once('disconnect', () => {
      rejectJob(new Error('DOCUMENT_WORKER_IPC_DISCONNECTED'))
    })
  })
}

async function sendWorkerMessage(message, disarmDisconnectGuard) {
  if (typeof process.send !== 'function' || !process.connected) {
    throw new Error('DOCUMENT_WORKER_IPC_DISCONNECTED')
  }
  await new Promise((resolveSend, rejectSend) => {
    process.send(message, (error) => {
      if (error) rejectSend(error)
      else resolveSend()
    })
  })
  disarmDisconnectGuard()
  process.disconnect()
}

async function documentWorkerMain() {
  const disarmDisconnectGuard = installPdfExportWorkerDisconnectGuard()
  const job = await receiveWorkerJob()
  try {
    await sendWorkerMessage(
      await runPdfExportWorkerJob(job),
      disarmDisconnectGuard,
    )
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'PDF_CORPUS_CONTRACT_MISMATCH'
    ) {
      await sendWorkerMessage(
        {
          type: DOCUMENT_WORKER_FATAL,
          code: 'PDF_CORPUS_CONTRACT_MISMATCH',
        },
        disarmDisconnectGuard,
      )
      return
    }
    throw error
  }
}

async function main() {
  failureStage = 'argument-validation'
  let parsed
  try {
    parsed = parseArguments(process.argv.slice(2))
  } catch {
    process.stderr.write(usage())
    process.exitCode = 2
    return
  }

  failureStage = 'pdf-discovery'
  let paths
  try {
    paths = await pdfPaths(parsed.inputs)
  } catch {
    process.stderr.write('No local PDF inputs were found.\n')
    process.exitCode = 2
    return
  }
  if (paths.length === 0) {
    process.stderr.write('No local PDF inputs were found.\n')
    process.exitCode = 2
    return
  }

  let corpusContract = null
  if (parsed.corpusContractPath) {
    failureStage = 'corpus-contract-binding'
    try {
      corpusContract = await bindCorpusContractPaths(
        parsed.corpusContractPath,
        parsed.corpusSet,
        paths,
      )
    } catch {
      process.stderr.write('PDF corpus contract binding failed.\n')
      process.exitCode = 2
      return
    }
  }

  failureStage = 'pipeline-initialization'
  const pipeline = await createPdfPipeline()
  let policy
  let targetProfiles
  try {
    failureStage = 'export-module-load'
    const exportModules = await pipeline.loadExportModules()
    const unknownTarget = parsed.targets.find(
      (target) => !exportModules.targetProfileIds.includes(target),
    )
    if (unknownTarget) {
      process.stderr.write('An unknown local export target was requested.\n')
      process.exitCode = 2
      return
    }
    policy = pipeline.policy
    targetProfiles = parsed.targets.map((target) =>
      exportModules.getEpubProfileMetadata(
        exportModules.getTargetProfile(target),
      ),
    )
  } finally {
    await pipeline.close()
  }

  failureStage = 'epubcheck-resolution'
  const validator = await epubCheckValidator()
  if (parsed.requireEpubCheck && validator.kind === 'skipped') {
    throw new Error('EPUBCHECK_REQUIRED')
  }

  failureStage = 'report-schema-load'
  const reportValidator = await createPdfCorpusReportValidator()
  failureStage = 'document-processing'
  const { report, serialized } = await processExportDocuments({
    paths,
    corpusContract,
    policy,
    reportValidator,
    targetProfiles,
    ocrEngine: parsed.ocrEngine,
    readableFallback: parsed.readableFallback,
    validator,
    outputDirectory: parsed.outputDirectory,
    timeoutMs: parsed.documentTimeoutSeconds * 1000,
  })

  process.stdout.write(serialized)
  if (report.summary.reviewRequired > 0 || report.summary.failed > 0) {
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (
    process.argv.length === 3 &&
    process.argv[2] === DOCUMENT_WORKER_ARGUMENT
  ) {
    documentWorkerMain().catch(() => {
      process.exitCode = 2
      if (process.connected) process.disconnect()
    })
  } else {
    const removeSignalHandlers = installPdfExportSignalHandlers()
    main()
      .catch((error) => {
        process.stderr.write(
          `PDF export failed without publishing local path or document details. Stage: ${failureStage}. Code: ${safeFailureCode(error)}.\n`,
        )
        process.exitCode = 2
      })
      .finally(removeSignalHandlers)
  }
}
