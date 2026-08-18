import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  validatePdfEvidenceBundle,
  type PdfEvidenceBundle,
  type PdfEvidenceJsonValue,
} from './source-evidence-graph.ts'

export const MINERU_SOURCE_EVIDENCE_SCHEMA_VERSION =
  PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION
export const MINERU_ARTIFACT_MANIFEST_SCHEMA_VERSION = '1.0.0' as const

export const MINERU_PRODUCTION_VERSION = '3.4.4' as const
export const MINERU_PRODUCTION_WHEEL_SHA256 =
  'd4d678539782a7683d998e2914a52d96b5720676ce65658b29666b1f4d9dfd13' as const
export const MINERU_PRODUCTION_MODEL_ID =
  'opendatalab/MinerU2.5-Pro-2605-1.2B' as const
export const MINERU_PRODUCTION_MODEL_REVISION =
  'bff20d4ae2bf202df9f45284b4d43681555a97ed' as const
export const MINERU_PRODUCTION_MODEL_LICENSE = 'Apache-2.0' as const
export const MINERU_PRODUCTION_MODEL_ARCHITECTURE =
  'Qwen2VLForConditionalGeneration' as const
export const MINERU_PRODUCTION_MODEL_TYPE = 'qwen2_vl' as const
export const MINERU_PRODUCTION_MODEL_FILE = 'model.safetensors' as const
export const MINERU_PRODUCTION_MODEL_BYTE_LENGTH = 2_312_126_640 as const
export const MINERU_PRODUCTION_MODEL_SHA256 =
  'abf8681ca63b8dec7b67de257af47b821f179442f72998d0696ae2ed9232a5f0' as const
export const MINERU_PRODUCTION_BACKEND = 'vlm-engine' as const

export const MINERU_PRODUCTION_CONFIGURATION = Object.freeze({
  formula: true,
  table: true,
  imageAnalysis: true,
})

export const MINERU_PRODUCTION_BINDING = Object.freeze({
  provider: Object.freeze({
    id: 'mineru',
    version: MINERU_PRODUCTION_VERSION,
    wheelSha256: MINERU_PRODUCTION_WHEEL_SHA256,
  }),
  model: Object.freeze({
    id: MINERU_PRODUCTION_MODEL_ID,
    revision: MINERU_PRODUCTION_MODEL_REVISION,
    license: MINERU_PRODUCTION_MODEL_LICENSE,
    architecture: MINERU_PRODUCTION_MODEL_ARCHITECTURE,
    modelType: MINERU_PRODUCTION_MODEL_TYPE,
    file: MINERU_PRODUCTION_MODEL_FILE,
    byteLength: MINERU_PRODUCTION_MODEL_BYTE_LENGTH,
    sha256: MINERU_PRODUCTION_MODEL_SHA256,
  }),
  backend: MINERU_PRODUCTION_BACKEND,
  configuration: MINERU_PRODUCTION_CONFIGURATION,
})

export const MINERU_MAX_ARTIFACT_COUNT = 100_000
export const MINERU_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
export const MINERU_MAX_TEXTUAL_ARTIFACT_BYTES = 64 * 1024 * 1024
export const MINERU_MAX_RETAINED_ARTIFACT_BYTES = 1024 * 1024 * 1024
export const MINERU_MAX_RAW_OUTPUT_BYTES = 1024 * 1024 * 1024
export const MINERU_MAX_OWNER_CACHE_BYTES = 8 * 1024 * 1024 * 1024

export const MINERU_ARTIFACT_KINDS = Object.freeze([
  'markdown',
  'content-list-v1',
  'content-list-v2',
  'middle-json',
  'layout-json',
  'model-json',
  'ocr',
  'table',
  'formula',
  'figure',
  'image',
  'reading-order',
  'page-geometry',
  'layout-pdf',
  'raw-output',
] as const)

export type MineruArtifactKind = (typeof MINERU_ARTIFACT_KINDS)[number]

export type MineruArtifactDescriptor = {
  id: string
  kind: MineruArtifactKind
  relativePath: string
  mediaType: string
  byteLength: number
  sha256: string
  pageScope: 'document' | number[]
}

export type MineruArtifactManifest = {
  schemaVersion: typeof MINERU_ARTIFACT_MANIFEST_SCHEMA_VERSION
  document: {
    id: string
    sha256: string
    byteLength: number
    pageCount: number
  }
  binding: typeof MINERU_PRODUCTION_BINDING
  execution: {
    hostClass: 'owner-laptop' | 'trusted-vm'
    operatingSystem: string
    architecture: 'arm64'
    runtime: 'python-3.12'
    backend: 'mlx-vlm' | 'torch-cpu'
    backendVersion: string
    runtimeSha256: string
    backendSha256: string
    packageSetSha256: string
    cacheNamespaceSha256: string
    networkIsolation:
      | 'macos-sandbox-exec-deny-network-v1'
      | 'linux-user-netns-loopback-only-v1'
    networkIsolationSha256: string
  }
  cache: {
    scope: 'owner-local'
    rootRef: string
    namespace: string
    maximumBytes: number
    retainedBytes: number
    artifactCount: number
  }
  artifacts: MineruArtifactDescriptor[]
  producerReceipt: MineruProducerReceipt
}

export type MineruProducerReceipt = {
  schemaVersion: '1.0.0'
  sourcePdfSha256: string
  sourceByteLength: number
  sourcePageCount: number
  sourcePageGeometrySha256: string
  mineruExecutableSha256: string
  mineruConfigSha256: string
  runtimeSha256: string
  runtimeInventorySha256: string
  runtimeTreeByteLength: number
  packageSetSha256: string
  backendSha256: string
  modelSha256: string
  modelConfigSha256: string
  cacheInventorySha256: string
  cacheByteLength: number
  privateSnapshotAllocatedByteLength: number
  rawOutputInventorySha256: string
  rawOutputByteLength: number
  networkIsolation: MineruArtifactManifest['execution']['networkIsolation']
  networkIsolationSha256: string
  artifactSetSha256: string
  offline: true
  runDirectoryMode: '0700'
  receiptSha256: string
}

export const MINERU_OFFLINE_RECEIPT_ARTIFACT_KINDS = [
  'markdown',
  'content-list-v1',
  'content-list-v2',
  'middle-json',
  'model-json',
  'layout-pdf',
] as const

export type MineruOfflineRunReceipt = {
  schemaVersion: '1.0.0'
  sourceSha256: string
  execution: MineruArtifactManifest['execution']
  bindingSha256: string
  artifacts: Array<{
    kind: (typeof MINERU_OFFLINE_RECEIPT_ARTIFACT_KINDS)[number]
    sha256: string
  }>
  receiptSha256: string
}

type VerifiedArtifact = MineruArtifactDescriptor & {
  json: unknown | null
  text: string | null
}

type NormalizedBox = {
  page: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
  method: 'pdf-object'
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/iu
const JSON_ARTIFACT_KINDS = new Set<MineruArtifactKind>([
  'content-list-v1',
  'content-list-v2',
  'middle-json',
  'layout-json',
  'model-json',
  'ocr',
  'reading-order',
  'page-geometry',
])
const DOCUMENT_COMPLETE_ARTIFACT_KINDS = new Set<MineruArtifactKind>([
  'content-list-v1',
  'content-list-v2',
  'middle-json',
  'layout-json',
  'model-json',
  'reading-order',
  'page-geometry',
])

function invalid(code: string): never {
  throw new Error(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  )
}

function canonicalJson(value: unknown): string {
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

function validExecutionIdentity(
  value: unknown,
): value is MineruArtifactManifest['execution'] {
  if (
    !exactKeys(value, [
      'hostClass',
      'operatingSystem',
      'architecture',
      'runtime',
      'backend',
      'backendVersion',
      'runtimeSha256',
      'backendSha256',
      'packageSetSha256',
      'cacheNamespaceSha256',
      'networkIsolation',
      'networkIsolationSha256',
    ]) ||
    typeof value.operatingSystem !== 'string' ||
    value.operatingSystem.length < 1 ||
    value.architecture !== 'arm64' ||
    value.runtime !== 'python-3.12' ||
    !SHA256.test(String(value.runtimeSha256)) ||
    !SHA256.test(String(value.networkIsolationSha256)) ||
    ![
      'macos-sandbox-exec-deny-network-v1',
      'linux-user-netns-loopback-only-v1',
    ].includes(String(value.networkIsolation)) ||
    !SHA256.test(String(value.backendSha256)) ||
    !SHA256.test(String(value.packageSetSha256)) ||
    !SHA256.test(String(value.cacheNamespaceSha256))
  ) {
    return false
  }
  return (
    (value.hostClass === 'owner-laptop' &&
      value.backend === 'mlx-vlm' &&
      value.backendVersion === 'mlx-vlm-0.3.12+mlx-0.31.1') ||
    (value.hostClass === 'trusted-vm' &&
      value.backend === 'torch-cpu' &&
      value.backendVersion === 'torch-2.13.0+cpu')
  )
}

function sha256(value: Uint8Array | string) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalHash(value: unknown) {
  return sha256(canonicalJson(value))
}

function safePositiveInteger(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  return (
    Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum
  )
}

function validPageScope(value: unknown, pageCount: number) {
  return (
    value === 'document' ||
    (Array.isArray(value) &&
      value.length > 0 &&
      new Set(value).size === value.length &&
      value.every(
        (page) => Number.isSafeInteger(page) && page >= 1 && page <= pageCount,
      ))
  )
}

function validRelativeArtifactPath(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2_048 ||
    value.includes('\0') ||
    value.includes('\\') ||
    isAbsolute(value)
  ) {
    return false
  }
  const segments = value.split('/')
  return segments.every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
  )
}

function manifestArtifact(value: unknown, pageCount: number) {
  if (
    !exactKeys(value, [
      'id',
      'kind',
      'relativePath',
      'mediaType',
      'byteLength',
      'sha256',
      'pageScope',
    ]) ||
    typeof value.id !== 'string' ||
    !SAFE_ID.test(value.id) ||
    typeof value.kind !== 'string' ||
    !MINERU_ARTIFACT_KINDS.includes(value.kind as MineruArtifactKind) ||
    !validRelativeArtifactPath(value.relativePath) ||
    typeof value.mediaType !== 'string' ||
    !MEDIA_TYPE.test(value.mediaType) ||
    !safePositiveInteger(value.byteLength, MINERU_MAX_ARTIFACT_BYTES) ||
    typeof value.sha256 !== 'string' ||
    !SHA256.test(value.sha256) ||
    !validPageScope(value.pageScope, pageCount)
  ) {
    invalid('INVALID_MINERU_ARTIFACT_DESCRIPTOR')
  }
  const artifact = value as MineruArtifactDescriptor
  if (artifact.kind === 'markdown' && artifact.mediaType !== 'text/markdown') {
    invalid('INVALID_MINERU_ARTIFACT_MEDIA_TYPE')
  }
  if (
    JSON_ARTIFACT_KINDS.has(artifact.kind) &&
    artifact.mediaType !== 'application/json'
  ) {
    invalid('INVALID_MINERU_ARTIFACT_MEDIA_TYPE')
  }
  if (
    (artifact.mediaType === 'application/json' ||
      artifact.kind === 'markdown') &&
    artifact.byteLength > MINERU_MAX_TEXTUAL_ARTIFACT_BYTES
  ) {
    invalid('MINERU_TEXTUAL_ARTIFACT_TOO_LARGE')
  }
  if (
    DOCUMENT_COMPLETE_ARTIFACT_KINDS.has(artifact.kind) &&
    artifact.pageScope !== 'document'
  ) {
    invalid('INCOMPLETE_MINERU_ARTIFACT_PAGE_SCOPE')
  }
  return artifact
}

function validateManifest(value: unknown): MineruArtifactManifest {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'document',
      'binding',
      'execution',
      'cache',
      'artifacts',
      'producerReceipt',
    ]) ||
    value.schemaVersion !== MINERU_ARTIFACT_MANIFEST_SCHEMA_VERSION ||
    !exactKeys(value.document, ['id', 'sha256', 'byteLength', 'pageCount']) ||
    typeof value.document.id !== 'string' ||
    !SAFE_ID.test(value.document.id) ||
    typeof value.document.sha256 !== 'string' ||
    !SHA256.test(value.document.sha256) ||
    !safePositiveInteger(value.document.byteLength) ||
    !safePositiveInteger(value.document.pageCount, 1_000_000) ||
    canonicalJson(value.binding) !== canonicalJson(MINERU_PRODUCTION_BINDING) ||
    !validExecutionIdentity(value.execution) ||
    !exactKeys(value.cache, [
      'scope',
      'rootRef',
      'namespace',
      'maximumBytes',
      'retainedBytes',
      'artifactCount',
    ]) ||
    value.cache.scope !== 'owner-local' ||
    typeof value.cache.rootRef !== 'string' ||
    !SAFE_ID.test(value.cache.rootRef) ||
    typeof value.cache.namespace !== 'string' ||
    !SAFE_ID.test(value.cache.namespace) ||
    !safePositiveInteger(
      value.cache.maximumBytes,
      MINERU_MAX_OWNER_CACHE_BYTES,
    ) ||
    !Number.isSafeInteger(value.cache.retainedBytes) ||
    Number(value.cache.retainedBytes) < 1 ||
    Number(value.cache.retainedBytes) > Number(value.cache.maximumBytes) ||
    !safePositiveInteger(
      value.cache.artifactCount,
      MINERU_MAX_ARTIFACT_COUNT,
    ) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > MINERU_MAX_ARTIFACT_COUNT ||
    !exactKeys(value.producerReceipt, [
      'schemaVersion',
      'sourcePdfSha256',
      'sourceByteLength',
      'sourcePageCount',
      'sourcePageGeometrySha256',
      'mineruExecutableSha256',
      'mineruConfigSha256',
      'runtimeSha256',
      'runtimeInventorySha256',
      'runtimeTreeByteLength',
      'packageSetSha256',
      'backendSha256',
      'modelSha256',
      'modelConfigSha256',
      'cacheInventorySha256',
      'cacheByteLength',
      'privateSnapshotAllocatedByteLength',
      'rawOutputInventorySha256',
      'rawOutputByteLength',
      'networkIsolation',
      'networkIsolationSha256',
      'artifactSetSha256',
      'offline',
      'runDirectoryMode',
      'receiptSha256',
    ])
  ) {
    if (
      isRecord(value) &&
      Object.hasOwn(value, 'binding') &&
      canonicalJson(value.binding) !== canonicalJson(MINERU_PRODUCTION_BINDING)
    ) {
      invalid('MINERU_PRODUCTION_BINDING_MISMATCH')
    }
    invalid('INVALID_MINERU_ARTIFACT_MANIFEST')
  }

  const pageCount = value.document.pageCount as number
  const artifacts = value.artifacts.map((artifact) =>
    manifestArtifact(artifact, pageCount),
  )
  if (
    new Set(artifacts.map(({ id }) => id)).size !== artifacts.length ||
    new Set(artifacts.map(({ relativePath }) => relativePath)).size !==
      artifacts.length
  ) {
    invalid('DUPLICATE_MINERU_ARTIFACT')
  }
  const actualKinds = new Set(artifacts.map(({ kind }) => kind))
  for (const kind of MINERU_ARTIFACT_KINDS) {
    if (!actualKinds.has(kind)) invalid('MISSING_MINERU_ARTIFACT_CLASS')
  }
  const totalBytes = artifacts.reduce(
    (total, artifact) => total + artifact.byteLength,
    0,
  )
  if (
    totalBytes > MINERU_MAX_RETAINED_ARTIFACT_BYTES ||
    value.cache.artifactCount !== artifacts.length ||
    value.cache.retainedBytes !== totalBytes
  ) {
    invalid('MINERU_CACHE_METADATA_MISMATCH')
  }
  const producerReceipt = value.producerReceipt as MineruProducerReceipt
  const { receiptSha256, ...producerProjection } = producerReceipt
  const rawOutputInventory = artifacts
    .filter(({ kind }) => kind === 'raw-output')
    .map(({ relativePath, byteLength, sha256 }) => ({
      relativePath,
      byteLength,
      sha256,
    }))
  const rawOutputByteLength = rawOutputInventory.reduce(
    (total, { byteLength }) => total + byteLength,
    0,
  )
  if (
    producerReceipt.schemaVersion !== '1.0.0' ||
    producerReceipt.sourcePdfSha256 !== value.document.sha256 ||
    producerReceipt.sourceByteLength !== value.document.byteLength ||
    producerReceipt.sourcePageCount !== value.document.pageCount ||
    !SHA256.test(producerReceipt.sourcePageGeometrySha256) ||
    !SHA256.test(producerReceipt.mineruExecutableSha256) ||
    !SHA256.test(producerReceipt.mineruConfigSha256) ||
    producerReceipt.runtimeSha256 !== value.execution.runtimeSha256 ||
    !SHA256.test(producerReceipt.runtimeInventorySha256) ||
    !Number.isSafeInteger(producerReceipt.runtimeTreeByteLength) ||
    producerReceipt.runtimeTreeByteLength < 1 ||
    producerReceipt.packageSetSha256 !== value.execution.packageSetSha256 ||
    producerReceipt.backendSha256 !== value.execution.backendSha256 ||
    producerReceipt.modelSha256 !== MINERU_PRODUCTION_MODEL_SHA256 ||
    !SHA256.test(producerReceipt.modelConfigSha256) ||
    !SHA256.test(producerReceipt.cacheInventorySha256) ||
    !Number.isSafeInteger(producerReceipt.cacheByteLength) ||
    producerReceipt.cacheByteLength < MINERU_PRODUCTION_MODEL_BYTE_LENGTH ||
    !Number.isSafeInteger(
      producerReceipt.privateSnapshotAllocatedByteLength,
    ) ||
    producerReceipt.privateSnapshotAllocatedByteLength < 0 ||
    !SHA256.test(producerReceipt.rawOutputInventorySha256) ||
    !Number.isSafeInteger(producerReceipt.rawOutputByteLength) ||
    producerReceipt.rawOutputByteLength < 1 ||
    producerReceipt.rawOutputByteLength > MINERU_MAX_RAW_OUTPUT_BYTES ||
    producerReceipt.rawOutputByteLength !== rawOutputByteLength ||
    producerReceipt.rawOutputInventorySha256 !==
      canonicalHash(rawOutputInventory) ||
    producerReceipt.networkIsolation !== value.execution.networkIsolation ||
    producerReceipt.networkIsolationSha256 !==
      value.execution.networkIsolationSha256 ||
    producerReceipt.cacheByteLength +
      producerReceipt.privateSnapshotAllocatedByteLength +
      value.cache.retainedBytes >
      Number(value.cache.maximumBytes) ||
    producerReceipt.artifactSetSha256 !== canonicalHash(artifacts) ||
    producerReceipt.offline !== true ||
    producerReceipt.runDirectoryMode !== '0700' ||
    receiptSha256 !== canonicalHash(producerProjection)
  ) {
    invalid('INVALID_MINERU_PRODUCER_RECEIPT')
  }
  if (
    value.execution.cacheNamespaceSha256 !==
    canonicalHash({
      rootRef: value.cache.rootRef,
      namespace: value.cache.namespace,
    })
  ) {
    invalid('MINERU_CACHE_IDENTITY_MISMATCH')
  }
  return value as MineruArtifactManifest
}

function within(parent: string, child: string) {
  const path = relative(parent, child)
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  )
}

function parseJson(bytes: Uint8Array) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    invalid('INVALID_MINERU_JSON_ARTIFACT')
  }
}

async function streamFileSha256(path: string, expectedBytes: number) {
  const digest = createHash('sha256')
  let byteLength = 0
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Uint8Array
    byteLength += bytes.byteLength
    if (byteLength > expectedBytes) {
      invalid('MINERU_ARTIFACT_IDENTITY_MISMATCH')
    }
    digest.update(bytes)
  }
  return { byteLength, sha256: digest.digest('hex') }
}

function fileIdentity(details: Awaited<ReturnType<typeof lstat>>) {
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeMs: details.mtimeMs,
    ctimeMs: details.ctimeMs,
  }
}

function sameFileIdentity(
  left: ReturnType<typeof fileIdentity>,
  right: ReturnType<typeof fileIdentity>,
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

async function verifyArtifactRoot(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) {
    invalid('INVALID_MINERU_ARTIFACT_ROOT')
  }
  try {
    const supplied = await lstat(path)
    const canonical = await realpath(path)
    const canonicalDetails = await lstat(canonical)
    if (
      !supplied.isDirectory() ||
      supplied.isSymbolicLink() ||
      canonical !== path ||
      !canonicalDetails.isDirectory() ||
      canonicalDetails.isSymbolicLink() ||
      (process.platform !== 'win32' && (canonicalDetails.mode & 0o077) !== 0)
    ) {
      invalid('INVALID_MINERU_ARTIFACT_ROOT')
    }
    return canonical
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'INVALID_MINERU_ARTIFACT_ROOT'
    )
      throw error
    invalid('INVALID_MINERU_ARTIFACT_ROOT')
  }
}

async function verifyArtifact(
  root: string,
  descriptor: MineruArtifactDescriptor,
): Promise<VerifiedArtifact> {
  const path = resolve(root, ...descriptor.relativePath.split('/'))
  if (!within(root, path)) invalid('MINERU_ARTIFACT_PATH_ESCAPE')
  try {
    const supplied = await lstat(path)
    const canonical = await realpath(path)
    const details = await lstat(canonical)
    await access(canonical, constants.R_OK)
    if (
      !supplied.isFile() ||
      supplied.isSymbolicLink() ||
      canonical !== path ||
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size !== descriptor.byteLength
    ) {
      invalid('MINERU_ARTIFACT_IDENTITY_MISMATCH')
    }
    const before = fileIdentity(details)
    const streamed = await streamFileSha256(canonical, descriptor.byteLength)
    if (
      streamed.byteLength !== descriptor.byteLength ||
      streamed.sha256 !== descriptor.sha256
    ) {
      invalid('MINERU_ARTIFACT_IDENTITY_MISMATCH')
    }

    const textual =
      descriptor.mediaType === 'application/json' ||
      descriptor.kind === 'markdown'
    if (textual && descriptor.byteLength > MINERU_MAX_TEXTUAL_ARTIFACT_BYTES) {
      invalid('MINERU_TEXTUAL_ARTIFACT_TOO_LARGE')
    }
    const bytes = textual ? new Uint8Array(await readFile(canonical)) : null
    if (
      bytes &&
      (bytes.byteLength !== descriptor.byteLength ||
        sha256(bytes) !== descriptor.sha256)
    ) {
      invalid('MINERU_ARTIFACT_IDENTITY_MISMATCH')
    }
    const after = await lstat(canonical)
    if (
      !sameFileIdentity(before, fileIdentity(after)) ||
      (await realpath(path)) !== canonical
    ) {
      invalid('MINERU_ARTIFACT_IDENTITY_MISMATCH')
    }
    const json =
      descriptor.mediaType === 'application/json' ? parseJson(bytes!) : null
    let text: string | null = null
    if (descriptor.kind === 'markdown' && bytes) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        invalid('INVALID_MINERU_MARKDOWN_ARTIFACT')
      }
    }
    return { ...descriptor, json, text }
  } catch (error) {
    if (
      error instanceof Error &&
      /^[A-Z0-9_]*MINERU[A-Z0-9_]*$/u.test(error.message)
    ) {
      throw error
    }
    invalid('MINERU_ARTIFACT_IDENTITY_MISMATCH')
  }
}

function pageGeometry(value: unknown, pageCount: number) {
  if (
    !exactKeys(value, ['schemaVersion', 'pages']) ||
    value.schemaVersion !== '1.0.0' ||
    !Array.isArray(value.pages) ||
    value.pages.length !== pageCount
  ) {
    invalid('INVALID_MINERU_PAGE_GEOMETRY')
  }
  const pages = value.pages.map((page) => {
    if (
      !exactKeys(page, ['page', 'width', 'height', 'rotation']) ||
      !safePositiveInteger(page.page, pageCount) ||
      typeof page.width !== 'number' ||
      !Number.isFinite(page.width) ||
      page.width <= 0 ||
      typeof page.height !== 'number' ||
      !Number.isFinite(page.height) ||
      page.height <= 0 ||
      ![0, 90, 180, 270].includes(page.rotation as number)
    ) {
      invalid('INVALID_MINERU_PAGE_GEOMETRY')
    }
    return {
      page: page.page as number,
      width: page.width,
      height: page.height,
      rotation: page.rotation as number,
    }
  })
  if (
    new Set(pages.map(({ page }) => page)).size !== pageCount ||
    pages.some(({ page }, index) => page !== index + 1)
  ) {
    invalid('INVALID_MINERU_PAGE_GEOMETRY')
  }
  return pages
}

function validateReadingOrder(value: unknown, pageCount: number) {
  if (
    !exactKeys(value, ['schemaVersion', 'pages']) ||
    value.schemaVersion !== '1.0.0' ||
    !Array.isArray(value.pages) ||
    value.pages.length !== pageCount ||
    value.pages.some(
      (page, index) =>
        !exactKeys(page, ['page', 'order']) ||
        page.page !== index + 1 ||
        !Array.isArray(page.order) ||
        page.order.some(
          (entry: unknown) =>
            !(
              typeof entry === 'string' ||
              (Number.isSafeInteger(entry) && Number(entry) >= 0)
            ),
        ),
    )
  ) {
    invalid('INVALID_MINERU_READING_ORDER')
  }
}

type ContentListRecord = {
  record: Record<string, unknown>
  pointer: string
  fallbackPage: number | null
}

function contentListRecords(value: unknown): ContentListRecord[] {
  if (!Array.isArray(value)) invalid('INVALID_MINERU_CONTENT_LIST')
  const records: ContentListRecord[] = []
  for (const [index, item] of value.entries()) {
    if (Array.isArray(item)) {
      for (const [nestedIndex, nested] of item.entries()) {
        if (!isRecord(nested)) invalid('INVALID_MINERU_CONTENT_LIST')
        records.push({
          record: nested,
          pointer: `/${index}/${nestedIndex}`,
          fallbackPage: index + 1,
        })
      }
      continue
    }
    if (!isRecord(item)) invalid('INVALID_MINERU_CONTENT_LIST')
    records.push({ record: item, pointer: `/${index}`, fallbackPage: null })
  }
  return records
}

function candidateBox(
  record: Record<string, unknown>,
  fallbackPage: number | null,
  pageCount: number,
): NormalizedBox {
  const pageIndex = record.page_idx
  const page = Number.isSafeInteger(pageIndex)
    ? Number(pageIndex) + 1
    : fallbackPage
  const bbox = record.bbox
  if (
    page === null ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > pageCount ||
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    bbox.some(
      (coordinate) =>
        typeof coordinate !== 'number' ||
        !Number.isFinite(coordinate) ||
        coordinate < 0 ||
        coordinate > 1000,
    ) ||
    bbox[2] <= bbox[0] ||
    bbox[3] <= bbox[1]
  ) {
    invalid('INVALID_MINERU_CONTENT_LIST_GEOMETRY')
  }
  return {
    page,
    x: bbox[0] / 1000,
    y: bbox[1] / 1000,
    width: (bbox[2] - bbox[0]) / 1000,
    height: (bbox[3] - bbox[1]) / 1000,
    rotation: 0,
    method: 'pdf-object',
  }
}

function candidateKind(record: Record<string, unknown>) {
  const type = record.type
  return typeof type === 'string' && SAFE_ID.test(type) ? type : 'unknown'
}

function opaqueReference(id: string) {
  return `owner-local:mineru-artifact:${id}`
}

/**
 * Inspect a runner-authored artifact manifest and normalize the exact retained
 * MinerU evidence into the provider-neutral graph arm. Paths are used only for
 * local verification; the returned bundle contains hashes and opaque refs.
 */
export async function inspectMineruSourceEvidence({
  artifactRoot,
  manifest: manifestInput,
}: {
  artifactRoot: string
  manifest: unknown
}): Promise<PdfEvidenceBundle> {
  const manifest = validateManifest(manifestInput)
  const root = await verifyArtifactRoot(artifactRoot)
  const verified: VerifiedArtifact[] = []
  for (const descriptor of manifest.artifacts) {
    verified.push(await verifyArtifact(root, descriptor))
  }

  const geometryArtifacts = verified.filter(
    ({ kind }) => kind === 'page-geometry',
  )
  const readingOrderArtifacts = verified.filter(
    ({ kind }) => kind === 'reading-order',
  )
  if (geometryArtifacts.length !== 1 || readingOrderArtifacts.length !== 1) {
    invalid('AMBIGUOUS_MINERU_DOCUMENT_EVIDENCE')
  }
  const pages = pageGeometry(
    geometryArtifacts[0].json,
    manifest.document.pageCount,
  )
  if (
    canonicalHash(pages) !== manifest.producerReceipt.sourcePageGeometrySha256
  ) {
    invalid('MINERU_SOURCE_GEOMETRY_RECEIPT_MISMATCH')
  }
  validateReadingOrder(
    readingOrderArtifacts[0].json,
    manifest.document.pageCount,
  )

  const providerId = `mineru:${MINERU_PRODUCTION_VERSION}:${canonicalHash({
    binding: MINERU_PRODUCTION_BINDING,
    execution: manifest.execution,
  })}`
  const artifactId = (id: string) => `${providerId}:artifact:${id}`
  const artifactSourceId = (id: string) => `${providerId}:source:${id}`
  const scopedPage = (artifact: VerifiedArtifact) =>
    Array.isArray(artifact.pageScope) && artifact.pageScope.length === 1
      ? artifact.pageScope[0]
      : undefined
  const artifacts: PdfEvidenceBundle['artifacts'] = verified.map(
    (artifact) => ({
      id: artifactId(artifact.id),
      providerId,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      ...(scopedPage(artifact) === undefined
        ? {}
        : { page: scopedPage(artifact) }),
    }),
  )
  const sources: PdfEvidenceBundle['sources'] = verified.map((artifact) => ({
    id: artifactSourceId(artifact.id),
    providerId,
    kind: artifact.kind,
    artifactIds: [artifactId(artifact.id)],
    ...(scopedPage(artifact) === undefined
      ? {}
      : { page: scopedPage(artifact) }),
    payload: {
      retention: 'owner-local-opaque-reference',
      reference: opaqueReference(artifact.id),
      pageScope: artifact.pageScope,
      ...(artifact.kind === 'markdown'
        ? {
            representation: 'complete-inspectable-markdown',
            complete: true,
            inspectable: true,
            canonical: false,
            markdown: artifact.text ?? '',
          }
        : artifact.json !== null
          ? {
              representation: 'complete-provider-native-json',
              complete: true,
              inspectable: true,
              content: artifact.json as PdfEvidenceJsonValue,
            }
          : {
              representation: 'complete-byte-preserved-artifact',
              complete: true,
              inspectable: false,
            }),
    },
  }))
  const candidates: PdfEvidenceBundle['candidates'] = verified.map(
    (artifact) => ({
      id: `${providerId}:candidate:artifact:${artifact.id}`,
      providerId,
      kind: artifact.kind,
      sourceIds: [artifactSourceId(artifact.id)],
      artifactIds: [artifactId(artifact.id)],
      ...(scopedPage(artifact) === undefined
        ? {}
        : { page: scopedPage(artifact) }),
      payload: {
        evidenceClass: artifact.kind,
        representation:
          artifact.kind === 'markdown'
            ? 'complete-inspectable-markdown'
            : 'retained-provider-artifact',
        complete: true,
        inspectable: artifact.text !== null || artifact.json !== null,
        canonical: artifact.kind === 'markdown' ? false : null,
        grounded: false,
        semanticObligationEligible: false,
        sha256: artifact.sha256,
      },
    }),
  )
  for (const artifact of verified.filter(({ kind }) =>
    ['content-list-v1', 'content-list-v2'].includes(kind),
  )) {
    const representation = artifact.kind
    const records = contentListRecords(artifact.json)
    for (const [
      recordIndex,
      { record, pointer, fallbackPage },
    ] of records.entries()) {
      const box = candidateBox(
        record,
        fallbackPage,
        manifest.document.pageCount,
      )
      const recordSha256 = canonicalHash(record)
      const recordSourceId = `${artifactSourceId(artifact.id)}:record:${recordIndex}`
      sources.push({
        id: recordSourceId,
        providerId,
        kind: 'mineru-native-record',
        page: box.page,
        box,
        artifactIds: [artifactId(artifact.id)],
        parentSourceIds: [artifactSourceId(artifact.id)],
        payload: {
          representation,
          jsonPointer: pointer,
          recordSha256,
          reference: opaqueReference(artifact.id),
          record: record as PdfEvidenceJsonValue,
        },
      })
      candidates.push({
        id: `${providerId}:candidate:${representation}:${artifact.id}:${recordIndex}`,
        providerId,
        kind: candidateKind(record),
        page: box.page,
        boxes: [box],
        sourceIds: [recordSourceId],
        artifactIds: [artifactId(artifact.id)],
        payload: {
          representation,
          jsonPointer: pointer,
          recordSha256,
          nativeType: typeof record.type === 'string' ? record.type : 'unknown',
          grounded: true,
          mergePolicy: 'preserve-without-overwrite',
        },
      })
    }
  }

  const bundle = {
    schemaVersion: MINERU_SOURCE_EVIDENCE_SCHEMA_VERSION,
    id: `${providerId}:bundle:${manifest.document.id}`,
    armId: 'mineru',
    source: {
      documentId: manifest.document.id,
      sha256: manifest.document.sha256,
      byteLength: manifest.document.byteLength,
      pageCount: manifest.document.pageCount,
    },
    provider: {
      id: providerId,
      kind: 'mineru',
      name: 'MinerU',
      version: MINERU_PRODUCTION_VERSION,
      implementationSha256: MINERU_PRODUCTION_WHEEL_SHA256,
      model: {
        id: MINERU_PRODUCTION_MODEL_ID,
        revision: MINERU_PRODUCTION_MODEL_REVISION,
        digestSha256: MINERU_PRODUCTION_MODEL_SHA256,
        license: MINERU_PRODUCTION_MODEL_LICENSE,
        architecture: MINERU_PRODUCTION_MODEL_ARCHITECTURE,
      },
      execution: { ...manifest.execution },
    },
    pages,
    artifacts,
    sources: [
      ...sources,
      {
        id: `${providerId}:source:production-binding`,
        providerId,
        kind: 'provider-binding',
        payload: {
          binding: MINERU_PRODUCTION_BINDING,
          bindingSha256: canonicalHash({
            binding: MINERU_PRODUCTION_BINDING,
            execution: manifest.execution,
          }),
          cache: {
            scope: manifest.cache.scope,
            rootRef: manifest.cache.rootRef,
            namespace: manifest.cache.namespace,
            maximumBytes: manifest.cache.maximumBytes,
            retainedBytes: manifest.cache.retainedBytes,
            artifactCount: manifest.cache.artifactCount,
          },
          candidateSetPolicy:
            'content-list-v1-and-v2-remain-independent-and-unmerged',
          markdownAuthority: 'inspectable-candidate-noncanonical',
        },
      },
    ],
    candidates,
  }
  validatePdfEvidenceBundle(bundle)
  return bundle as PdfEvidenceBundle
}

export const mineruPdfEvidenceBundleFromManifest = inspectMineruSourceEvidence
export const normalizeMineruSourceEvidence = inspectMineruSourceEvidence

export function createMineruOfflineRunReceipt(
  input: Omit<MineruOfflineRunReceipt, 'bindingSha256' | 'receiptSha256'>,
): MineruOfflineRunReceipt {
  if (
    input.schemaVersion !== '1.0.0' ||
    !SHA256.test(input.sourceSha256) ||
    !validExecutionIdentity(input.execution) ||
    !Array.isArray(input.artifacts) ||
    input.artifacts.length !== MINERU_OFFLINE_RECEIPT_ARTIFACT_KINDS.length ||
    input.artifacts.some(
      (artifact) =>
        !exactKeys(artifact, ['kind', 'sha256']) ||
        !MINERU_OFFLINE_RECEIPT_ARTIFACT_KINDS.includes(artifact.kind) ||
        !SHA256.test(artifact.sha256),
    ) ||
    new Set(input.artifacts.map(({ kind }) => kind)).size !==
      MINERU_OFFLINE_RECEIPT_ARTIFACT_KINDS.length
  ) {
    invalid('INVALID_MINERU_OFFLINE_RUN_RECEIPT')
  }
  const orderedArtifacts = MINERU_OFFLINE_RECEIPT_ARTIFACT_KINDS.map((kind) =>
    input.artifacts.find((artifact) => artifact.kind === kind)!,
  )
  const base = {
    schemaVersion: '1.0.0' as const,
    sourceSha256: input.sourceSha256,
    execution: structuredClone(input.execution),
    bindingSha256: canonicalHash({
      binding: MINERU_PRODUCTION_BINDING,
      execution: input.execution,
    }),
    artifacts: orderedArtifacts,
  }
  return Object.freeze({
    ...base,
    receiptSha256: canonicalHash(base),
  })
}
