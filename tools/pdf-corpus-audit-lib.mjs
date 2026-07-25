import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createServer } from 'vite'
import { safeAuditDiagnostic } from './pdf-corpus-audit-safety.mjs'
import {
  createHeadlessOcrOptions,
  DEFAULT_DOCUMENT_VISIBILITY,
  DEFAULT_HEADLESS_OCR_ENGINE,
  normalizeHeadlessOcrEngine,
  resolveHeadlessOcrEngine,
} from './pdf-ocr-engines.mjs'

export const PDF_CORPUS_REPORT_SCHEMA_VERSION = '1.5.0'
export const PDF_CORPUS_REPORT_OCR_SCHEMA_VERSION = '1.6.0'
export const PDF_CORPUS_REPORT_SCHEMA_PATH =
  'docs/schemas/pdf-corpus-audit.schema.json'
export const PDF_CORPUS_REPORT_OCR_SCHEMA_PATH =
  'docs/schemas/pdf-corpus-audit-v1.6.schema.json'
export const PDF_CORPUS_REPORT_PROVENANCE_SCHEMA_VERSION = '1.7.0'
export const PDF_CORPUS_REPORT_PROVENANCE_SCHEMA_PATH =
  'docs/schemas/pdf-corpus-audit-v1.7.schema.json'
export const PDF_STRUCTURAL_RECEIPT_SCHEMA_VERSION = '1.4.0'

const MAX_DIAGNOSTIC_SAMPLES = 64
const MAX_DIAGNOSTIC_SAMPLES_PER_CODE = 3
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const execFileAsync = promisify(execFile)
const PROVENANCE_TOOL_IDS = new Set(['pdf-corpus-audit', 'pdf-export'])
const GIT_COMMIT_TIMESTAMP_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/
const GIT_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SEMANTIC_VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const PDF_CORPUS_EXECUTION_PROVENANCE_VERSION = '1.1.0'
const PDF_CORPUS_EXECUTION_CAPTURE_VERSION = '1.0.0'
const PDF_CORPUS_EXECUTION_VERIFICATION_METHOD = 'before-after-exact-match-v1'

const SAFE_FAILURE_MESSAGES = Object.freeze({
  INVALID_PDF: 'The file is not a valid PDF.',
  ENCRYPTED_PDF: 'The PDF is password-protected and was not opened.',
  OVERSIZED_PDF: 'The PDF exceeds the bounded local resource limit.',
  OCR_REQUIRED: 'The PDF requires local OCR before it can be audited.',
  EMPTY_PDF: 'The PDF contains no pages.',
  PDF_PARSE_FAILED:
    'The PDF parser could not open the document; local path and document details were suppressed.',
  IMPORT_CANCELLED: 'The local PDF audit was cancelled.',
  INCOMPLETE_RECONSTRUCTION:
    'The PDF reconstruction did not pass the completeness gate.',
  PDF_DOCUMENT_TIMEOUT:
    'The PDF exceeded the local per-document processing time limit.',
  PDF_DOCUMENT_WORKER_FAILED:
    'The PDF worker stopped without exposing local path or document details.',
  AUDIT_FAILED:
    'The PDF could not be audited; local path and document details were suppressed.',
})

export async function pdfPaths(paths) {
  const found = []

  async function visit(path) {
    const details = await stat(path)
    if (details.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true })
      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (entry.isSymbolicLink()) continue
        await visit(resolve(path, entry.name))
      }
      return
    }
    if (details.isFile() && extname(path).toLocaleLowerCase() === '.pdf') {
      found.push(path)
    }
  }

  for (const path of paths) await visit(resolve(path))
  return [...new Set(found)]
}

function safeError(error) {
  const candidate =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'AUDIT_FAILED'
  const code = Object.hasOwn(SAFE_FAILURE_MESSAGES, candidate)
    ? candidate
    : 'AUDIT_FAILED'
  return { code, message: SAFE_FAILURE_MESSAGES[code] }
}

export function createSafeAuditFailureDocument(path, code = 'AUDIT_FAILED') {
  const safeCode = Object.hasOwn(SAFE_FAILURE_MESSAGES, code)
    ? code
    : 'AUDIT_FAILED'
  return {
    basename: basename(path),
    sha256: null,
    code: safeCode,
    message: SAFE_FAILURE_MESSAGES[safeCode],
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function canonicalJsonHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export async function packageContentsIdentity(directory) {
  const canonicalRoot = resolve(directory)
  const rootDetails = await lstat(canonicalRoot)
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
  }
  const entries = []
  async function visit(currentDirectory, relativeDirectory) {
    const children = await readdir(currentDirectory, { withFileTypes: true })
    for (const child of children.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name
      const absolutePath = join(currentDirectory, child.name)
      if (child.isDirectory()) {
        await visit(absolutePath, relativePath)
        continue
      }
      if (!child.isFile()) {
        throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
      }
      const bytes = await readFile(absolutePath)
      entries.push({
        path: relativePath,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      })
    }
  }
  await visit(canonicalRoot, '')
  if (entries.length === 0) {
    throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
  }
  return {
    fileCount: entries.length,
    sha256: canonicalJsonHash(entries),
  }
}

async function gitRawOutput(arguments_, repositoryRoot = REPOSITORY_ROOT) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repositoryRoot, ...arguments_],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  )
  return stdout
}

async function gitRawBytes(arguments_, repositoryRoot = REPOSITORY_ROOT) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repositoryRoot, ...arguments_],
    {
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  )
  if (!Buffer.isBuffer(stdout)) {
    throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
  }
  return stdout
}

async function gitOutput(arguments_, repositoryRoot = REPOSITORY_ROOT) {
  return (await gitRawOutput(arguments_, repositoryRoot)).trim()
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function pathIsWithin(root, target) {
  const path = relative(root, target)
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  )
}

async function untrackedWorktreeEntryIdentity(repositoryRoot, path) {
  const absolutePath = resolve(repositoryRoot, path)
  if (!pathIsWithin(repositoryRoot, absolutePath)) {
    throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
  }
  let details
  try {
    details = await lstat(absolutePath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
    }
    throw error
  }
  if (details.isFile()) {
    const bytes = await readFile(absolutePath)
    return {
      path,
      type: 'file',
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    }
  }
  if (details.isSymbolicLink()) {
    const target = await readlink(absolutePath)
    return {
      path,
      type: 'symbolic-link',
      targetByteLength: Buffer.byteLength(target),
      targetSha256: sha256(target),
    }
  }
  throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
}

function gitBlobObjectId(bytes, objectFormat) {
  return createHash(objectFormat)
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex')
}

async function trackedWorktreeState(repositoryRoot) {
  const [treeOutput, objectFormat] = await Promise.all([
    gitRawOutput(
      ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'],
      repositoryRoot,
    ),
    gitOutput(['rev-parse', '--show-object-format'], repositoryRoot),
  ])
  if (!['sha1', 'sha256'].includes(objectFormat)) {
    throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
  }
  const trackedEntries = []
  for (const record of treeOutput.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t')
    if (separator < 0) {
      throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
    }
    const [expectedMode, type, expectedObjectId, ...unexpected] = record
      .slice(0, separator)
      .split(' ')
    const path = record.slice(separator + 1)
    const absolutePath = resolve(repositoryRoot, path)
    if (
      unexpected.length > 0 ||
      type !== 'blob' ||
      !['100644', '100755', '120000'].includes(expectedMode) ||
      !GIT_OBJECT_ID_PATTERN.test(expectedObjectId ?? '') ||
      !pathIsWithin(repositoryRoot, absolutePath)
    ) {
      throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
    }
    let details
    try {
      details = await lstat(absolutePath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      trackedEntries.push({
        path,
        expectedMode,
        expectedObjectId,
        type: 'missing',
      })
      continue
    }
    let bytes
    let actualMode
    if (details.isSymbolicLink()) {
      bytes = await readlink(absolutePath, { encoding: 'buffer' })
      actualMode = '120000'
    } else if (details.isFile()) {
      bytes = await readFile(absolutePath)
      actualMode = (details.mode & 0o100) === 0 ? '100644' : '100755'
    } else {
      throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
    }
    trackedEntries.push({
      path,
      expectedMode,
      expectedObjectId,
      mode: actualMode,
      byteLength: bytes.byteLength,
      objectId: gitBlobObjectId(bytes, objectFormat),
      rawContentSha256: sha256(bytes),
    })
    const entry = trackedEntries.at(-1)
    entry.objectMatchesExpected =
      entry.objectId === expectedObjectId ||
      (actualMode !== '120000' &&
        bytes.equals(
          await gitRawBytes(
            ['cat-file', '--filters', `--path=${path}`, expectedObjectId],
            repositoryRoot,
          ),
        ))
  }
  const entries = trackedEntries.map((entry) => {
    if (entry.type === 'missing') {
      return { path: entry.path, type: entry.type }
    }
    return {
      path: entry.path,
      mode: entry.mode,
      byteLength: entry.byteLength,
      objectId: entry.objectId,
      objectMatchesExpected: entry.objectMatchesExpected,
      rawContentSha256: entry.rawContentSha256,
    }
  })
  const matchesHead = trackedEntries.every((entry) => {
    if (entry.type === 'missing') return false
    return entry.mode === entry.expectedMode && entry.objectMatchesExpected
  })
  return {
    matchesHead,
    identitySha256: canonicalJsonHash(entries),
  }
}

export async function pdfCorpusWorktreeStateSnapshot(
  repositoryRoot = REPOSITORY_ROOT,
) {
  const canonicalRoot = resolve(repositoryRoot)
  const [
    worktreeStatus,
    trackedDiff,
    untrackedPathsOutput,
    trackedIndexTags,
    trackedWorktree,
  ] = await Promise.all([
    gitRawOutput(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      canonicalRoot,
    ),
    gitRawOutput(
      ['diff', '--binary', '--no-ext-diff', '--full-index', 'HEAD', '--'],
      canonicalRoot,
    ),
    gitRawOutput(
      ['ls-files', '--others', '--exclude-standard', '-z'],
      canonicalRoot,
    ),
    gitRawOutput(['ls-files', '-v', '-z'], canonicalRoot),
    trackedWorktreeState(canonicalRoot),
  ])
  if (
    trackedIndexTags
      .split('\0')
      .filter(Boolean)
      .some((entry) => /^(?:S|[a-z]) /u.test(entry))
  ) {
    // `git status` and `git diff` deliberately trust assume-unchanged and
    // skip-worktree bits. Exact-head evidence must not inherit that blind
    // spot, so repositories using either bit are ineligible until it is
    // cleared.
    throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
  }
  const untrackedPaths = untrackedPathsOutput
    .split('\0')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
  const untrackedEntries = await Promise.all(
    untrackedPaths.map((path) =>
      untrackedWorktreeEntryIdentity(canonicalRoot, path),
    ),
  )
  const effectiveWorktreeStatus = trackedWorktree.matchesHead
    ? worktreeStatus
    : `${worktreeStatus}\0!! tracked-worktree-bytes-differ-from-head`
  return {
    worktreeStatus: effectiveWorktreeStatus,
    contentSha256: canonicalJsonHash({
      trackedDiffSha256: sha256(trackedDiff),
      trackedWorktreeIdentitySha256: trackedWorktree.identitySha256,
      untrackedEntries,
    }),
  }
}

async function pdfCorpusExecutionProvenanceSnapshot(toolId) {
  if (!PROVENANCE_TOOL_IDS.has(toolId)) {
    throw new Error('INVALID_PDF_CORPUS_PROVENANCE_TOOL')
  }
  const [
    commitLine,
    worktree,
    packageBytes,
    packageLockBytes,
    resolvedPdfjsPackageBytes,
    resolvedPdfjsPackageContents,
  ] = await Promise.all([
    gitOutput(['show', '-s', '--format=%H%n%cI', 'HEAD']),
    pdfCorpusWorktreeStateSnapshot(),
    readFile(new URL('../package.json', import.meta.url)),
    readFile(new URL('../package-lock.json', import.meta.url)),
    readFile(
      new URL('../node_modules/pdfjs-dist/package.json', import.meta.url),
    ),
    packageContentsIdentity(
      fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url)),
    ),
  ])
  const [gitCommit, gitCommitTimestamp, ...unexpectedCommitLines] =
    commitLine.split('\n')
  let packageMetadata
  let packageLockMetadata
  let resolvedPdfjsPackageMetadata
  try {
    packageMetadata = JSON.parse(packageBytes.toString('utf8'))
    packageLockMetadata = JSON.parse(packageLockBytes.toString('utf8'))
    resolvedPdfjsPackageMetadata = JSON.parse(
      resolvedPdfjsPackageBytes.toString('utf8'),
    )
  } catch {
    throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
  }
  const declaredPdfjsVersion =
    packageMetadata?.dependencies?.['pdfjs-dist'] ??
    packageMetadata?.devDependencies?.['pdfjs-dist']
  const lockedDeclaredPdfjsVersion =
    packageLockMetadata?.packages?.['']?.dependencies?.['pdfjs-dist'] ??
    packageLockMetadata?.packages?.['']?.devDependencies?.['pdfjs-dist']
  const lockedPdfjsVersion =
    packageLockMetadata?.packages?.['node_modules/pdfjs-dist']?.version
  const resolvedPdfjsVersion = resolvedPdfjsPackageMetadata?.version
  if (
    unexpectedCommitLines.length > 0 ||
    !GIT_OBJECT_ID_PATTERN.test(gitCommit ?? '') ||
    !gitCommitTimestamp ||
    !GIT_COMMIT_TIMESTAMP_PATTERN.test(gitCommitTimestamp) ||
    Number.isNaN(Date.parse(gitCommitTimestamp)) ||
    packageMetadata?.name !== 'astro-erudite' ||
    typeof packageMetadata?.version !== 'string' ||
    !SEMANTIC_VERSION_PATTERN.test(packageMetadata.version) ||
    !SEMANTIC_VERSION_PATTERN.test(declaredPdfjsVersion ?? '') ||
    lockedDeclaredPdfjsVersion !== declaredPdfjsVersion ||
    !SEMANTIC_VERSION_PATTERN.test(lockedPdfjsVersion ?? '') ||
    !SEMANTIC_VERSION_PATTERN.test(resolvedPdfjsVersion ?? '') ||
    resolvedPdfjsVersion !== lockedPdfjsVersion
  ) {
    throw new Error('PDF_CORPUS_PROVENANCE_UNAVAILABLE')
  }
  const worktreeState = worktree.worktreeStatus === '' ? 'clean' : 'dirty'
  const publicIdentity = {
    schemaVersion: PDF_CORPUS_EXECUTION_PROVENANCE_VERSION,
    implementation: {
      gitCommit,
      gitCommitTimestamp,
      worktreeState,
      exactHead: worktreeState === 'clean',
    },
    runtime: {
      name: 'node',
      version: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
    },
    tool: {
      id: toolId,
      packageName: packageMetadata.name,
      packageVersion: packageMetadata.version,
    },
    toolchain: {
      packageLockSha256: sha256(packageLockBytes),
      pdfjsDist: {
        declaredVersion: declaredPdfjsVersion,
        lockedVersion: lockedPdfjsVersion,
        resolvedVersion: resolvedPdfjsVersion,
        resolvedPackageJsonSha256: sha256(resolvedPdfjsPackageBytes),
        resolvedPackageContentsSha256: resolvedPdfjsPackageContents.sha256,
      },
    },
  }
  const stateIdentity = {
    publicIdentity,
    packageJsonSha256: sha256(packageBytes),
    worktreeStatusSha256: sha256(worktree.worktreeStatus),
    worktreeContentSha256: worktree.contentSha256,
  }
  return {
    publicIdentity,
    stateSha256: canonicalJsonHash(stateIdentity),
  }
}

export async function capturePdfCorpusExecutionProvenance(toolId) {
  const snapshot = await pdfCorpusExecutionProvenanceSnapshot(toolId)
  return {
    schemaVersion: PDF_CORPUS_EXECUTION_CAPTURE_VERSION,
    toolId,
    publicIdentity: snapshot.publicIdentity,
    stateSha256: snapshot.stateSha256,
  }
}

export async function finalizePdfCorpusExecutionProvenance(capture) {
  if (
    !capture ||
    typeof capture !== 'object' ||
    Array.isArray(capture) ||
    capture.schemaVersion !== PDF_CORPUS_EXECUTION_CAPTURE_VERSION ||
    !PROVENANCE_TOOL_IDS.has(capture.toolId) ||
    !capture.publicIdentity ||
    typeof capture.publicIdentity !== 'object' ||
    !SHA256_PATTERN.test(capture.stateSha256 ?? '')
  ) {
    throw new Error('INVALID_PDF_CORPUS_PROVENANCE_CAPTURE')
  }
  const finalSnapshot = await pdfCorpusExecutionProvenanceSnapshot(
    capture.toolId,
  )
  if (
    capture.stateSha256 !== finalSnapshot.stateSha256 ||
    canonicalJson(capture.publicIdentity) !==
      canonicalJson(finalSnapshot.publicIdentity)
  ) {
    throw new Error('PDF_CORPUS_PROVENANCE_CHANGED_DURING_RUN')
  }
  return {
    ...finalSnapshot.publicIdentity,
    verification: {
      method: PDF_CORPUS_EXECUTION_VERIFICATION_METHOD,
      stateSha256: finalSnapshot.stateSha256,
    },
  }
}

function countsBy(values, keyFor) {
  const counts = new Map()
  for (const value of values) {
    const key = keyFor(value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function summarizeAuditDiagnostics(diagnostics) {
  const safeDiagnostics = diagnostics.map(safeAuditDiagnostic)
  const diagnosticCounts = countsBy(safeDiagnostics, ({ code }) => code)
  const sorted = [...safeDiagnostics].sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.severity.localeCompare(right.severity) ||
      (left.page ?? Number.MAX_SAFE_INTEGER) -
        (right.page ?? Number.MAX_SAFE_INTEGER) ||
      left.message.localeCompare(right.message),
  )
  const samples = []
  const samplesPerCode = new Map()
  const sampleKeys = new Set()

  for (const diagnostic of sorted) {
    if (samples.length >= MAX_DIAGNOSTIC_SAMPLES) break
    const codeSamples = samplesPerCode.get(diagnostic.code) ?? 0
    if (codeSamples >= MAX_DIAGNOSTIC_SAMPLES_PER_CODE) continue
    const sampleKey = canonicalJson(diagnostic)
    if (sampleKeys.has(sampleKey)) continue
    sampleKeys.add(sampleKey)
    samplesPerCode.set(diagnostic.code, codeSamples + 1)
    samples.push(diagnostic)
  }

  return {
    diagnosticCounts,
    diagnosticSampleLimit: {
      total: MAX_DIAGNOSTIC_SAMPLES,
      perCode: MAX_DIAGNOSTIC_SAMPLES_PER_CODE,
    },
    diagnosticSamplesTruncated: Math.max(
      0,
      safeDiagnostics.length - samples.length,
    ),
    diagnostics: samples,
  }
}

function safeOcrProvenance(pages) {
  return pages
    .flatMap((page) =>
      page.ocr
        ? [
            {
              page: page.page,
              engine: page.ocr.engine,
              engineVersion: page.ocr.engineVersion,
              model: page.ocr.model,
              modelVersion: page.ocr.modelVersion,
              languages: [...page.ocr.languages],
              languageMode: page.ocr.languageMode,
              rasterSha256: page.ocr.rasterSha256,
              confidence: page.ocr.confidence,
            },
          ]
        : [],
    )
    .sort((left, right) => left.page - right.page)
}

function normalizedSourceExclusionMask(mask) {
  if (!mask) return null
  const normalizedBox = (box) => ({
    page: box.page,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    rotation: box.rotation,
    method: box.method,
  })
  return {
    algorithm: mask.algorithm,
    expansionPixels: mask.expansionPixels,
    ownedSourceBoxes: (mask.ownedSourceBoxes ?? []).map(normalizedBox),
    excludedSourceBoxes: (mask.excludedSourceBoxes ?? []).map(normalizedBox),
  }
}

function normalizedAssetManifest(assets) {
  return assets.map((asset) => ({
    id: asset.id,
    kind: asset.kind,
    mediaType: asset.mediaType,
    rendition: asset.rendition,
    sha256: asset.sha256,
    width: asset.width ?? null,
    height: asset.height ?? null,
    sourceBoxes: asset.sourceBoxes ?? [],
    ...(asset.sourceCropBox ? { sourceCropBox: asset.sourceCropBox } : {}),
    ...(asset.sourceExclusionMask
      ? {
          sourceExclusionMask: normalizedSourceExclusionMask(
            asset.sourceExclusionMask,
          ),
        }
      : {}),
  }))
}

function normalizedVisualCandidate(candidate) {
  return {
    sourceRegionIds: candidate.sourceRegionIds ?? [],
    sourceObjectIds: candidate.sourceObjectIds ?? [],
    assetIds: candidate.assetIds ?? [],
    score: candidate.score ?? null,
    evidence: candidate.evidence ?? [],
    sourceBoxes: candidate.sourceBoxes ?? [],
  }
}

function selectedVisualCandidateSha256(relationship) {
  const selected = relationship.candidates?.[0]
  return relationship.status === 'matched' && selected
    ? canonicalJsonHash(normalizedVisualCandidate(selected))
    : null
}

function selectedVisualCropSha256(relationship, assetsById) {
  if (relationship.status !== 'matched') return null
  const crops = (relationship.assetIds ?? []).flatMap((assetId) => {
    const asset = assetsById.get(assetId)
    const sourceCropBox = asset?.sourceCropBox
    return sourceCropBox
      ? [
          {
            assetId: opaqueStructuralId('asset', assetId),
            sourceCropBox,
            ...(asset.sourceExclusionMask
              ? {
                  sourceExclusionMask: normalizedSourceExclusionMask(
                    asset.sourceExclusionMask,
                  ),
                }
              : {}),
          },
        ]
      : []
  })
  return crops.length > 0 ? canonicalJsonHash(crops) : null
}

function preformattedSourceSha256(relationship) {
  const source = relationship.preformatted
  if (!source) return null
  return canonicalJsonHash({
    status: source.status,
    evidence: source.evidence ?? [],
    lines: (source.lines ?? []).map((line) => ({
      textSha256: opaqueStructuralId('preformatted-line-text', line.text),
      sourceRegionId: opaqueStructuralId('region', line.sourceRegionId),
      sourceLineId: opaqueStructuralId('line', line.sourceLineId),
      sourceBox: line.sourceBox,
      sourceRunBoxes: line.sourceRunBoxes ?? [],
    })),
  })
}

function equationTranscriptSourceSha256(relationship) {
  return relationship.kind === 'equation' &&
    typeof relationship.sourceText === 'string' &&
    relationship.sourceText.length > 0
    ? opaqueStructuralId('equation-transcript-text', relationship.sourceText)
    : null
}

function equationTranscriptAdjudicationSha256(relationship) {
  return relationship.kind === 'equation' &&
    relationship.equationTranscriptAdjudication
    ? canonicalJsonHash(relationship.equationTranscriptAdjudication)
    : null
}

function normalizedVisualRelationships(relationships, assets) {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]))
  return relationships.map((relationship) => ({
    id: relationship.id,
    kind: relationship.kind,
    semanticKind: relationship.semanticKind ?? null,
    status: relationship.status,
    canonicalNodeId: relationship.canonicalNodeId ?? null,
    captionNodeId: relationship.captionNodeId ?? null,
    captionRegionId: relationship.captionRegionId ?? null,
    sourceRegionIds: relationship.sourceRegionIds ?? [],
    sourceObjectIds: relationship.sourceObjectIds ?? [],
    sourceLineIds: relationship.sourceLineIds ?? [],
    assetIds: relationship.assetIds ?? [],
    sourceBoxes: relationship.sourceBoxes ?? [],
    altTextSource: relationship.altTextSource ?? null,
    preformattedSourceSha256: preformattedSourceSha256(relationship),
    ...(relationship.kind === 'equation' &&
    ((typeof relationship.sourceText === 'string' &&
      relationship.sourceText.length > 0) ||
      relationship.equationTranscriptAdjudication)
      ? {
          equationTranscriptSourceSha256:
            equationTranscriptSourceSha256(relationship),
          equationTranscriptAdjudicationSha256:
            equationTranscriptAdjudicationSha256(relationship),
        }
      : {}),
    selectedCandidateSha256: selectedVisualCandidateSha256(relationship),
    selectedCropSha256: selectedVisualCropSha256(relationship, assetsById),
  }))
}

function normalizedNoteCanonicalAnchor(anchor) {
  if (anchor?.kind === 'node') {
    return {
      kind: 'node',
      nodeId: opaqueStructuralId('node', anchor.nodeId),
      start: anchor.start,
      end: anchor.end,
    }
  }
  if (anchor?.kind === 'author') {
    return {
      kind: 'author',
      authorSha256: opaqueStructuralId('author', anchor.author),
    }
  }
  return null
}

function normalizedNoteRelationships(relationships) {
  return relationships.map((relationship) => ({
    id: relationship.id,
    status: relationship.status,
    referenceRegionId: relationship.referenceRegionId,
    targetNoteId: relationship.targetNoteId ?? null,
    label: relationship.label,
    canonicalAnchor: normalizedNoteCanonicalAnchor(
      relationship.canonicalAnchor,
    ),
    sourceBoxes: relationship.sourceBoxes ?? [],
  }))
}

function opaqueStructuralId(kind, value) {
  return createHash('sha256')
    .update(`${kind}\0${String(value ?? '')}`)
    .digest('hex')
}

function normalizedCitationRelationships(relationships) {
  return relationships.map((relationship) => ({
    id: opaqueStructuralId('citation-relationship', relationship.id),
    status: relationship.status,
    taxonomy: relationship.taxonomy,
    referenceRegionId: opaqueStructuralId(
      'region',
      relationship.referenceRegionId,
    ),
    referenceStart: relationship.referenceStart,
    referenceEnd: relationship.referenceEnd,
    labels: (relationship.labels ?? []).map((label) =>
      opaqueStructuralId('citation-label', label),
    ),
    targetNodeIds: (relationship.targetNodeIds ?? []).map((nodeId) =>
      opaqueStructuralId('node', nodeId),
    ),
    canonicalAnchor: relationship.canonicalAnchor
      ? {
          ...relationship.canonicalAnchor,
          nodeId: opaqueStructuralId(
            'node',
            relationship.canonicalAnchor.nodeId,
          ),
        }
      : null,
    sourceBoxes: (relationship.sourceBoxes ?? []).map((box) => ({ ...box })),
  }))
}

function normalizedCrossReferenceTarget(target) {
  return {
    kind: target.kind,
    labelSha256: opaqueStructuralId(
      'scholarly-cross-reference-label',
      target.label,
    ),
    referenceStart: target.referenceStart,
    referenceEnd: target.referenceEnd,
    status: target.status,
    candidateNodeIds: (target.candidateNodeIds ?? []).map((nodeId) =>
      opaqueStructuralId('node', nodeId),
    ),
    targetNodeId: target.targetNodeId
      ? opaqueStructuralId('node', target.targetNodeId)
      : null,
    evidenceSha256s: [...new Set(target.evidence ?? [])].map((evidence) =>
      opaqueStructuralId('scholarly-cross-reference-evidence', evidence),
    ),
  }
}

function normalizedCrossReferenceRelationships(relationships) {
  return relationships.map((relationship) => ({
    id: opaqueStructuralId(
      'scholarly-cross-reference-relationship',
      relationship.id,
    ),
    kind: relationship.kind,
    status: relationship.status,
    textSha256: opaqueStructuralId(
      'scholarly-cross-reference-text',
      relationship.text,
    ),
    referenceRegionId: opaqueStructuralId(
      'region',
      relationship.referenceRegionId,
    ),
    referenceStart: relationship.referenceStart,
    referenceEnd: relationship.referenceEnd,
    labels: (relationship.labels ?? []).map((label) =>
      opaqueStructuralId('scholarly-cross-reference-label', label),
    ),
    targets: (relationship.targets ?? []).map(normalizedCrossReferenceTarget),
    targetNodeIds: (relationship.targetNodeIds ?? []).map((nodeId) =>
      opaqueStructuralId('node', nodeId),
    ),
    canonicalAnchor: relationship.canonicalAnchor
      ? {
          ...relationship.canonicalAnchor,
          nodeId: opaqueStructuralId(
            'node',
            relationship.canonicalAnchor.nodeId,
          ),
        }
      : null,
    confidence: relationship.confidence,
    evidenceSha256s: [...new Set(relationship.evidence ?? [])].map((evidence) =>
      opaqueStructuralId('scholarly-cross-reference-evidence', evidence),
    ),
    sourceBoxes: (relationship.sourceBoxes ?? []).map((box) => ({ ...box })),
  }))
}

function normalizedNodeProvenance(nodes, provenance) {
  return nodes.map((node) => {
    const evidence = provenance?.[node.id]
    const provenanceSha256 = evidence
      ? canonicalJsonHash({
          confidence: evidence.confidence ?? null,
          pages: evidence.pages ?? [],
          regionIds: (evidence.regionIds ?? []).map((regionId) =>
            opaqueStructuralId('region', regionId),
          ),
          boxes: (evidence.boxes ?? []).map((box) =>
            typeof box.fontName === 'string'
              ? {
                  ...box,
                  fontName: box.fontName.replace(/^g_d\d+_/u, 'g_d*_'),
                }
              : { ...box },
          ),
          links: (evidence.links ?? []).map((link) =>
            canonicalJsonHash({ kind: 'node-source-link', link }),
          ),
          part:
            evidence.part === undefined
              ? null
              : opaqueStructuralId('provenance-part', evidence.part),
          relationshipIds: (evidence.relationshipIds ?? []).map(
            (relationshipId) =>
              opaqueStructuralId('relationship', relationshipId),
          ),
        })
      : null
    return {
      nodeId: opaqueStructuralId('node', node.id),
      provenanceSha256,
    }
  })
}

function lineTransitionLedger(reconstruction) {
  for (const key of [
    'lineBoundaryDecisions',
    'lineTransitions',
    'transitionDecisions',
    'lineJoinDecisions',
  ]) {
    if (Array.isArray(reconstruction[key])) {
      return { available: true, decisions: reconstruction[key] }
    }
  }
  return { available: false, decisions: [] }
}

const LINE_TRANSITION_OUTCOMES = new Set([
  'space',
  'no-space',
  'preserved-lexical-hyphen',
  'removed-discretionary-hyphen',
  'structural-boundary',
  'unresolved',
  'unresolved-corrupting-join',
])

function lineTransitionOutcome(decision) {
  const outcome = String(
    decision.outcome ?? decision.decision ?? decision.kind ?? '',
  )
  if (!LINE_TRANSITION_OUTCOMES.has(outcome)) {
    throw new Error('Line transition decision outcome is invalid.')
  }
  return outcome
}

function lineTransitionCounts(reconstruction, ledger) {
  if (!ledger.available) {
    return {
      unresolvedCorruptingJoinCount: null,
      structurallyConsumedLineBoundaryCount: null,
    }
  }
  let unresolvedCorruptingJoinCount = 0
  let structurallyConsumedLineBoundaryCount = 0
  for (const decision of ledger.decisions) {
    const outcome = lineTransitionOutcome(decision)
    if (outcome === 'structural-boundary') {
      structurallyConsumedLineBoundaryCount += 1
    } else if (
      outcome === 'unresolved' ||
      outcome === 'unresolved-corrupting-join'
    ) {
      unresolvedCorruptingJoinCount += 1
    }
  }
  const reportedUnresolved = reconstruction.unresolvedCorruptingJoinCount
  const reportedStructurallyConsumed =
    reconstruction.structurallyConsumedLineBoundaryCount
  if (
    (reportedUnresolved !== undefined &&
      (!Number.isInteger(reportedUnresolved) ||
        reportedUnresolved < 0 ||
        reportedUnresolved !== unresolvedCorruptingJoinCount)) ||
    (reportedStructurallyConsumed !== undefined &&
      (!Number.isInteger(reportedStructurallyConsumed) ||
        reportedStructurallyConsumed < 0 ||
        reportedStructurallyConsumed !==
          structurallyConsumedLineBoundaryCount)) ||
    unresolvedCorruptingJoinCount + structurallyConsumedLineBoundaryCount >
      ledger.decisions.length
  ) {
    throw new Error('Line transition counts do not match the decision ledger.')
  }
  return {
    unresolvedCorruptingJoinCount,
    structurallyConsumedLineBoundaryCount,
  }
}

export function createPdfStructuralReceipt(reconstruction) {
  const nodes = reconstruction.paper?.nodes ?? []
  const sourceAssets = reconstruction.assets ?? []
  const visualRelationships = normalizedVisualRelationships(
    reconstruction.visualRelationships ?? [],
    sourceAssets,
  )
  const noteRelationships = normalizedNoteRelationships(
    reconstruction.noteRelationships ?? [],
  )
  const citationRelationships = normalizedCitationRelationships(
    reconstruction.citationRelationships ?? [],
  )
  const crossReferenceRelationships = normalizedCrossReferenceRelationships(
    reconstruction.crossReferenceRelationships ?? [],
  )
  const assets = normalizedAssetManifest(sourceAssets)
  const nodeProvenance = normalizedNodeProvenance(
    nodes,
    reconstruction.provenance,
  )
  const transitionLedger = lineTransitionLedger(reconstruction)
  const transitions = transitionLedger.decisions
  const transitionCounts = lineTransitionCounts(
    reconstruction,
    transitionLedger,
  )
  return {
    schemaVersion: PDF_STRUCTURAL_RECEIPT_SCHEMA_VERSION,
    canonicalNodeCount: nodes.length,
    canonicalNodeSequenceSha256: canonicalJsonHash(
      nodes.map((node) => node.id),
    ),
    canonicalNodeTypeSequenceSha256: canonicalJsonHash(
      nodes.map((node) => node.type),
    ),
    canonicalContentSha256: canonicalJsonHash(
      reconstruction.paper ?? { nodes },
    ),
    canonicalNodeProvenanceSha256: canonicalJsonHash(nodeProvenance),
    readingOrderGraphSha256: canonicalJsonHash(
      reconstruction.readingOrder ?? null,
    ),
    nodeCounts: countsBy(nodes, (node) => node.type),
    visualRelationshipCount: visualRelationships.length,
    visualRelationshipCounts: countsBy(
      visualRelationships,
      (relationship) => `${relationship.kind}:${relationship.status}`,
    ),
    visualRelationshipGraphSha256: canonicalJsonHash(visualRelationships),
    noteRelationshipCount: noteRelationships.length,
    noteRelationshipCounts: countsBy(
      noteRelationships,
      (relationship) => relationship.status,
    ),
    noteRelationshipGraphSha256: canonicalJsonHash(noteRelationships),
    citationRelationshipCount: citationRelationships.length,
    citationRelationshipCounts: countsBy(
      citationRelationships,
      (relationship) => relationship.status,
    ),
    citationRelationshipGraph: citationRelationships,
    citationRelationshipGraphSha256: canonicalJsonHash(citationRelationships),
    crossReferenceRelationshipCount: crossReferenceRelationships.length,
    crossReferenceRelationshipCounts: countsBy(
      crossReferenceRelationships,
      (relationship) => `${relationship.kind}:${relationship.status}`,
    ),
    crossReferenceRelationshipGraph: crossReferenceRelationships,
    crossReferenceRelationshipGraphSha256: canonicalJsonHash(
      crossReferenceRelationships,
    ),
    assetCount: assets.length,
    assetCounts: countsBy(assets, (asset) => asset.kind),
    assetManifestSha256: canonicalJsonHash(assets),
    lineTransitionLedgerAvailable: transitionLedger.available,
    lineTransitionCount: transitions.length,
    lineTransitionLedgerSha256: transitionLedger.available
      ? canonicalJsonHash(transitions)
      : null,
    ...transitionCounts,
  }
}

export async function createPdfPipeline({
  temporaryRoot = tmpdir(),
  ocrEngine = DEFAULT_HEADLESS_OCR_ENGINE,
  ocrRemoteOptIn = false,
  documentVisibility = DEFAULT_DOCUMENT_VISIBILITY,
} = {}) {
  const resolvedOcrEngine = normalizeHeadlessOcrEngine(ocrEngine)
  const engineContext = { remoteOptIn: ocrRemoteOptIn, documentVisibility }
  const ocrResolution = resolveHeadlessOcrEngine(
    resolvedOcrEngine,
    engineContext,
  )
  // Resolve the engine before the reconstruction server starts so an
  // unavailable engine fails with its named diagnostic and no held resources.
  const ocr = await createHeadlessOcrOptions(resolvedOcrEngine, engineContext)
  const cacheDir = await mkdtemp(join(temporaryRoot, 'srt-pdf-vite-'))
  const vite = await createServer({
    appType: 'custom',
    cacheDir,
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  const standardFontDataUrl = new URL(
    '../node_modules/pdfjs-dist/standard_fonts/',
    import.meta.url,
  ).href
  const [pdf, quality, importTypes] = await Promise.all([
    vite.ssrLoadModule('/src/research/pdf.ts'),
    vite.ssrLoadModule('/src/research/pdf-quality.ts'),
    vite.ssrLoadModule('/src/research/import-types.ts'),
  ])
  let exportModules
  let diagnosticModules
  let decisionModules
  let validationModules

  return {
    reconstructPdf: pdf.reconstructPdf,
    policy: quality.DEFAULT_PDF_COMPLETENESS_POLICY,
    maximumBytes: importTypes.MAX_LOCAL_PDF_BYTES,
    standardFontDataUrl,
    ocrEngine: resolvedOcrEngine,
    ocrResolution,
    ocr,
    async loadExportModules() {
      exportModules ??= Promise.all([
        vite.ssrLoadModule('/src/research/epub.ts'),
        vite.ssrLoadModule('/src/research/targets.ts'),
      ]).then(([epub, targets]) => ({
        buildEpub: epub.buildEpub,
        buildReadableEpub: epub.buildReadableEpub,
        getEpubProfileMetadata: epub.getEpubProfileMetadata,
        projectReadableFallbackReconstruction:
          epub.projectReadableFallbackReconstruction,
        inspectEpub: epub.inspectEpub,
        getTargetProfile: targets.getTargetProfile,
        targetProfileIds: targets.TARGET_PROFILE_IDS,
      }))
      return exportModules
    },
    async loadDiagnosticModules() {
      diagnosticModules ??= vite
        .ssrLoadModule('/src/research/diagnostic-overlays.ts')
        .then((overlays) => ({
          renderDiagnosticEvidenceHtml: overlays.renderDiagnosticEvidenceHtml,
        }))
      return diagnosticModules
    },
    async loadDecisionModules() {
      decisionModules ??= vite
        .ssrLoadModule('/src/research/decision-record.ts')
        .then((decisions) => ({
          applyHumanDecisionFile: decisions.applyHumanDecisionFile,
          createEquationTranscriptDecision:
            decisions.createEquationTranscriptDecision,
          humanDecisionFileSha256: decisions.humanDecisionFileSha256,
          parseHumanDecisionFile: decisions.parseHumanDecisionFile,
          serializeHumanDecisionFile: decisions.serializeHumanDecisionFile,
          upsertHumanDecision: decisions.upsertHumanDecision,
          maximumBytes: decisions.MAX_HUMAN_DECISION_FILE_BYTES,
        }))
      return decisionModules
    },
    async loadValidationModules() {
      validationModules ??= vite
        .ssrLoadModule('/src/research/pdf-visual-validation.ts')
        .then((visualValidation) => ({
          validatedPdfVisualRelationships:
            visualValidation.validatedPdfVisualRelationships,
        }))
      return validationModules
    },
    async close() {
      try {
        await vite.close()
      } finally {
        await rm(cacheDir, { recursive: true, force: true })
      }
    },
  }
}

export async function auditPdfPath(
  path,
  pipeline,
  { expectedSource = null } = {},
) {
  const stableBasename = basename(path)
  try {
    if (
      expectedSource &&
      basename(stableBasename, extname(stableBasename)) !== expectedSource.id
    ) {
      throw new Error('PDF_CORPUS_CONTRACT_MISMATCH')
    }
    const details = await stat(path)
    if (expectedSource && details.size !== expectedSource.byteLength) {
      throw new Error('PDF_CORPUS_CONTRACT_MISMATCH')
    }
    if (details.size > pipeline.maximumBytes) {
      return {
        document: {
          basename: stableBasename,
          sha256: null,
          code: 'OVERSIZED_PDF',
          message: SAFE_FAILURE_MESSAGES.OVERSIZED_PDF,
        },
      }
    }
    const bytes = await readFile(path)
    if (
      expectedSource &&
      (bytes.byteLength !== expectedSource.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !==
          expectedSource.sha256)
    ) {
      throw new Error('PDF_CORPUS_CONTRACT_MISMATCH')
    }
    const reconstruction = await pipeline.reconstructPdf(
      new File([bytes], stableBasename, {
        type: 'application/pdf',
        lastModified: 0,
      }),
      undefined,
      {
        standardFontDataUrl: pipeline.standardFontDataUrl,
        ocr: pipeline.ocr,
      },
    )
    const ocr = safeOcrProvenance(reconstruction.pages)
    return {
      reconstruction,
      document: {
        basename: stableBasename,
        sha256: reconstruction.source.sha256,
        byteLength: reconstruction.source.byteLength,
        pageCount: reconstruction.source.pageCount,
        completeness: reconstruction.completeness,
        readiness: reconstruction.readiness,
        structure: createPdfStructuralReceipt(reconstruction),
        ...(ocr.length > 0 ? { ocr } : {}),
        ...summarizeAuditDiagnostics(reconstruction.diagnostics),
      },
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'PDF_CORPUS_CONTRACT_MISMATCH'
    ) {
      throw error
    }
    return {
      document: createSafeAuditFailureDocument(
        stableBasename,
        safeError(error).code,
      ),
    }
  }
}

export async function auditPdfInputs(
  inputs,
  pipeline,
  { corpusContract = null } = {},
) {
  const records = []
  const expectedById = new Map(
    (corpusContract?.documents ?? []).map((document) => [
      document.id,
      document,
    ]),
  )
  for (const path of await pdfPaths(inputs)) {
    const id = basename(path, extname(path))
    const expectedSource = expectedById.get(id) ?? null
    if (corpusContract && !expectedSource) {
      throw new Error('PDF_CORPUS_CONTRACT_MISMATCH')
    }
    records.push({
      path,
      ...(await auditPdfPath(path, pipeline, {
        expectedSource,
      })),
    })
  }
  if (corpusContract && records.length !== corpusContract.documents.length) {
    throw new Error('PDF_CORPUS_CONTRACT_MISMATCH')
  }
  records.sort(
    (left, right) =>
      left.document.basename.localeCompare(right.document.basename) ||
      String(left.document.sha256).localeCompare(String(right.document.sha256)),
  )
  return records
}

export function canonicalPassRate(numerator, denominator) {
  if (denominator === 0) return 0
  return Math.round((numerator / denominator) * 100_000) / 100_000
}

function failureReasons(documents) {
  const buckets = new Map()
  for (const document of documents) {
    const codes = document.readiness
      ? document.readiness.ready
        ? []
        : document.readiness.blockingDiagnosticCodes
      : [document.code]
    for (const code of new Set(codes)) {
      buckets.set(code, (buckets.get(code) ?? 0) + 1)
    }
  }
  return Object.fromEntries(
    [...buckets].sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function createCorpusReport(
  documents,
  policy,
  { corpusContract = null, executionProvenance = null } = {},
) {
  const hasOcrProvenance = documents.some(
    (document) => Array.isArray(document.ocr) && document.ocr.length > 0,
  )
  const summary = {
    documents: documents.length,
    ready: documents.filter((document) => document.readiness?.ready).length,
    reviewRequired: documents.filter(
      (document) => document.readiness && !document.readiness.ready,
    ).length,
    failed: documents.filter((document) => !document.readiness).length,
  }
  return {
    schemaVersion: executionProvenance
      ? PDF_CORPUS_REPORT_PROVENANCE_SCHEMA_VERSION
      : hasOcrProvenance
        ? PDF_CORPUS_REPORT_OCR_SCHEMA_VERSION
        : PDF_CORPUS_REPORT_SCHEMA_VERSION,
    reportSchema: executionProvenance
      ? PDF_CORPUS_REPORT_PROVENANCE_SCHEMA_PATH
      : hasOcrProvenance
        ? PDF_CORPUS_REPORT_OCR_SCHEMA_PATH
        : PDF_CORPUS_REPORT_SCHEMA_PATH,
    privacy: 'basenames-hashes-metrics-diagnostics-only',
    ...(executionProvenance ? { executionProvenance } : {}),
    policy,
    ...(corpusContract ? { corpusContract } : {}),
    summary: {
      ...summary,
      passRate: canonicalPassRate(summary.ready, summary.documents),
      failureReasons: failureReasons(documents),
    },
    documents,
  }
}

export function serializeCorpusReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}
