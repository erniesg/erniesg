#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { semanticTableFromHtml } from '../src/research/semantic-table.ts'
import { assertAdapterSourceIdentity } from './adapter-source-identity.mjs'

const ADAPTER_FORMAT_VERSION = 'content-list-v1-v2-adapter-1.1.0'
const TARGET_FREE_FORMAT = 'pdf-document-observations'
const TARGET_FREE_FORMAT_VERSION = '1.0.0'
const TARGET_FREE_OUTPUT_SCHEMA_VERSION = '1.0.0'
const TARGET_FREE_REQUEST_KEYS = ['documentId', 'path', 'byteLength', 'sha256']
const RUNNER_CANDIDATE_EXECUTABLE_ENV = 'SRT_PDF_RUNNER_CANDIDATE_EXECUTABLE'
const RUNNER_MODEL_CACHE_HOME_ENV = 'SRT_PDF_RUNNER_MODEL_CACHE_HOME'
const REQUEST_PRIVACY = 'owner-local-paths-present-ephemeral-delete-after-run'
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_NATIVE_JSON_BYTES = 64 * 1024 * 1024
const CACHE_SCHEMA_VERSION = '1.1.0'
const CACHE_NAMESPACE = 'mineru-content-list-cache-v3'
const MINERU_CONFIGURATION = Object.freeze({
  formula: true,
  table: true,
  imageAnalysis: true,
})
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ADAPTER_PATH = fileURLToPath(import.meta.url)

function validRuntimeToolIdentity(value) {
  return (
    exactKeys(value, [
      'id',
      'version',
      'executableSha256',
      'versionOutputSha256',
    ]) &&
    SAFE_ID.test(value.id) &&
    SAFE_ID.test(value.version) &&
    SHA256.test(value.executableSha256) &&
    SHA256.test(value.versionOutputSha256)
  )
}

function validRuntimeModelIdentity(value) {
  return (
    exactKeys(value, ['id', 'sha256']) &&
    SAFE_ID.test(value.id) &&
    SHA256.test(value.sha256)
  )
}

function validRuntimeIdentity(value) {
  if (!exactKeys(value, ['status', 'tool', 'model'])) return false
  if (value.status === 'unattested') {
    return (
      (value.tool === null || validRuntimeToolIdentity(value.tool)) &&
      value.model === null
    )
  }
  return (
    value.status === 'attested' &&
    validRuntimeToolIdentity(value.tool) &&
    validRuntimeModelIdentity(value.model)
  )
}

function invalid(code) {
  throw new Error(code)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
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

function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

async function resolveMineruExecutable(command, environment) {
  if (typeof command !== 'string' || command.length === 0) {
    invalid('MINERU_EXECUTABLE_NOT_FOUND')
  }
  const candidates =
    isAbsolute(command) || command.includes(sep)
      ? [resolve(command)]
      : String(environment.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(directory, command))
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate)
      const details = await lstat(path)
      await access(path, constants.X_OK)
      if (details.isFile() && !details.isSymbolicLink()) return path
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error?.code)) throw error
    }
  }
  invalid('MINERU_EXECUTABLE_NOT_FOUND')
}

async function resolveRunnerModelCacheHome(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    invalid('INVALID_MINERU_RUNNER_RUNTIME_CONFIGURATION')
  }
  try {
    const supplied = await lstat(path)
    const canonicalPath = await realpath(path)
    const canonical = await lstat(canonicalPath)
    if (
      !supplied.isDirectory() ||
      supplied.isSymbolicLink() ||
      !canonical.isDirectory() ||
      canonical.isSymbolicLink() ||
      canonicalPath !== path
    ) {
      invalid('INVALID_MINERU_RUNNER_RUNTIME_CONFIGURATION')
    }
    return canonicalPath
  } catch (error) {
    if (error?.message === 'INVALID_MINERU_RUNNER_RUNTIME_CONFIGURATION') {
      throw error
    }
    invalid('INVALID_MINERU_RUNNER_RUNTIME_CONFIGURATION')
  }
}

async function targetFreeRunnerRuntime(parsed, environment = process.env) {
  const executable = environment[RUNNER_CANDIDATE_EXECUTABLE_ENV]
  const modelCacheHome = environment[RUNNER_MODEL_CACHE_HOME_ENV]
  if (executable === undefined && modelCacheHome === undefined) {
    return {
      mineruBin: parsed.mineruBin,
      mineruEnvironment: environment,
    }
  }
  if (
    typeof executable !== 'string' ||
    executable.length === 0 ||
    typeof modelCacheHome !== 'string' ||
    modelCacheHome.length === 0 ||
    !isAbsolute(executable) ||
    resolve(executable) !== executable
  ) {
    invalid('INVALID_MINERU_RUNNER_RUNTIME_CONFIGURATION')
  }
  const resolvedExecutable = await resolveMineruExecutable(
    executable,
    environment,
  )
  if (resolvedExecutable !== executable) {
    invalid('INVALID_MINERU_RUNNER_RUNTIME_CONFIGURATION')
  }
  const resolvedModelCacheHome =
    await resolveRunnerModelCacheHome(modelCacheHome)
  const allowedEnvironment = {}
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'SRT_PDF_TARGET_FREE_OFFLINE',
    'HF_HUB_OFFLINE',
    'TRANSFORMERS_OFFLINE',
    'NO_PROXY',
    'no_proxy',
  ]) {
    if (typeof environment[key] === 'string') {
      allowedEnvironment[key] = environment[key]
    }
  }
  return {
    mineruBin: resolvedExecutable,
    mineruEnvironment: {
      ...allowedEnvironment,
      SRT_PDF_EVAL_OFFLINE: '1',
      HF_HOME: resolvedModelCacheHome,
      HUGGINGFACE_HUB_CACHE: join(resolvedModelCacheHome, 'hub'),
    },
  }
}

function observedVersion(output) {
  const match = output.match(
    /(?:^|[^A-Za-z0-9])([0-9]+(?:\.[0-9]+)+(?:[-+][A-Za-z0-9._-]+)?)(?:$|[^A-Za-z0-9])/m,
  )
  if (match && SAFE_ID.test(match[1])) return match[1]
  invalid('MINERU_VERSION_UNATTESTED')
}

async function observeMineruRuntime(command, environment = process.env) {
  const resolvedPath = await resolveMineruExecutable(command, environment)
  const bytes = await readFile(resolvedPath)
  if (bytes.length === 0) invalid('MINERU_EXECUTABLE_NOT_FOUND')
  const result = spawnSync(resolvedPath, ['--version'], {
    encoding: 'utf8',
    env: {
      ...environment,
      SRT_PDF_EVAL_OFFLINE: '1',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    },
    timeout: 10_000,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) invalid('MINERU_VERSION_UNATTESTED')
  const versionOutput = `${result.stdout ?? ''}\0${result.stderr ?? ''}`
  const identity = {
    id: 'mineru',
    version: observedVersion(versionOutput),
    executableSha256: createHash('sha256').update(bytes).digest('hex'),
    versionOutputSha256: createHash('sha256')
      .update(versionOutput)
      .digest('hex'),
  }
  if (!validRuntimeToolIdentity(identity)) invalid('MINERU_VERSION_UNATTESTED')
  return { resolvedPath, identity }
}

export async function observeMineruExecutable(
  command,
  environment = process.env,
) {
  return (await observeMineruRuntime(command, environment)).identity
}

function mineruModelIdentity(environment = process.env) {
  const id = environment.SRT_MINERU_MODEL_ID
  const sha256 = environment.SRT_MINERU_MODEL_SHA256
  if (id === undefined && sha256 === undefined) return null
  const identity = { id, sha256 }
  if (!validRuntimeModelIdentity(identity)) {
    invalid('INVALID_MINERU_MODEL_IDENTITY')
  }
  return identity
}

function containsKey(value, key) {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key))
  if (!isRecord(value)) return false
  return (
    Object.hasOwn(value, key) ||
    Object.values(value).some((item) => containsKey(item, key))
  )
}

function normalizedBox(value) {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(
      (coordinate) =>
        typeof coordinate === 'number' &&
        Number.isFinite(coordinate) &&
        coordinate >= 0 &&
        coordinate <= 1,
    ) &&
    value[2] > 0 &&
    value[3] > 0 &&
    value[0] + value[2] <= 1.000001 &&
    value[1] + value[3] <= 1.000001
  )
}

function validateRequest(request) {
  if (containsKey(request, 'expected') || containsKey(request, 'critical')) {
    invalid('MINERU_ADAPTER_REQUEST_CONTAINS_GOLD')
  }
  if (
    !isRecord(request) ||
    !['1.1.0', '1.2.0'].includes(request.schemaVersion) ||
    request.privacy !== REQUEST_PRIVACY ||
    !isRecord(request.evalSet) ||
    !SAFE_ID.test(request.evalSet.id ?? '') ||
    !SHA256.test(request.evalSet.sha256 ?? '') ||
    !isRecord(request.candidate) ||
    !SAFE_ID.test(request.candidate.id ?? '') ||
    !SAFE_ID.test(request.candidate.version ?? '') ||
    !SHA256.test(request.candidate.adapterSha256 ?? '') ||
    !Array.isArray(request.documents) ||
    request.documents.length === 0 ||
    !Array.isArray(request.cases)
  ) {
    invalid('INVALID_MINERU_ADAPTER_REQUEST')
  }
  const documents = new Map()
  for (const document of request.documents) {
    if (
      !isRecord(document) ||
      !SAFE_ID.test(document.id ?? '') ||
      typeof document.path !== 'string' ||
      !isAbsolute(document.path) ||
      !Number.isSafeInteger(document.byteLength) ||
      document.byteLength <= 0 ||
      !SHA256.test(document.sha256 ?? '') ||
      !Number.isSafeInteger(document.pageCount) ||
      document.pageCount <= 0 ||
      documents.has(document.id)
    ) {
      invalid('INVALID_MINERU_ADAPTER_REQUEST')
    }
    documents.set(document.id, document)
  }
  const caseIds = new Set()
  for (const item of request.cases) {
    const document = documents.get(item?.documentId)
    if (
      !isRecord(item) ||
      !SAFE_ID.test(item.id ?? '') ||
      caseIds.has(item.id) ||
      !document ||
      !Number.isSafeInteger(item.page) ||
      item.page < 1 ||
      item.page > document.pageCount ||
      ![
        'classification',
        'detection',
        'reading-order',
        'relationship',
      ].includes(item.task)
    ) {
      invalid('INVALID_MINERU_ADAPTER_REQUEST')
    }
    caseIds.add(item.id)
    if (
      !Array.isArray(item.targets) ||
      (item.task === 'detection' && item.targets.length !== 0) ||
      (item.task !== 'detection' && item.targets.length === 0) ||
      item.targets.some((target) => {
        const expectedKeys =
          request.schemaVersion === '1.2.0'
            ? ['id', 'kind', 'sourcePage', 'box']
            : ['id', 'kind', 'box']
        return (
          !isRecord(target) ||
          !exactKeys(target, expectedKeys) ||
          !SAFE_ID.test(target.id ?? '') ||
          target.kind !== 'candidate' ||
          (request.schemaVersion === '1.2.0' &&
            (!Number.isSafeInteger(target.sourcePage) ||
              target.sourcePage < 1 ||
              target.sourcePage > document.pageCount)) ||
          (target.box !== null && !normalizedBox(target.box))
        )
      })
    ) {
      invalid('INVALID_MINERU_ADAPTER_REQUEST')
    }
  }
  return documents
}

function isTargetFreeRequest(request) {
  return exactKeys(request, TARGET_FREE_REQUEST_KEYS)
}

function validateTargetFreeRequest(request) {
  if (
    !isTargetFreeRequest(request) ||
    !SAFE_ID.test(request.documentId ?? '') ||
    typeof request.path !== 'string' ||
    !isAbsolute(request.path) ||
    resolve(request.path) !== request.path ||
    !Number.isSafeInteger(request.byteLength) ||
    request.byteLength < 1 ||
    !SHA256.test(request.sha256 ?? '')
  ) {
    invalid('INVALID_MINERU_TARGET_FREE_REQUEST')
  }
}

function targetFreeCandidate(environment = process.env) {
  const candidate = {
    id: environment.SRT_PDF_CANDIDATE_ID,
    version: environment.SRT_PDF_CANDIDATE_VERSION,
    adapterSha256: environment.SRT_PDF_ADAPTER_SOURCE_SHA256,
  }
  if (
    !SAFE_ID.test(candidate.id ?? '') ||
    !SAFE_ID.test(candidate.version ?? '') ||
    !SHA256.test(candidate.adapterSha256 ?? '')
  ) {
    invalid('INVALID_MINERU_TARGET_FREE_ENVIRONMENT')
  }
  return candidate
}

async function pdfPageCount(bytes) {
  let loadingTask
  let document
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: true,
    })
    document = await loadingTask.promise
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) {
      invalid('INVALID_MINERU_PDF_SOURCE')
    }
    return document.numPages
  } catch (error) {
    if (error?.message === 'INVALID_MINERU_PDF_SOURCE') throw error
    invalid('INVALID_MINERU_PDF_SOURCE')
  } finally {
    try {
      await document?.destroy()
    } catch {
      // Cleanup cannot turn a successfully validated source into a failure.
    }
    try {
      await loadingTask?.destroy()
    } catch {
      // PDF.js versions differ on whether document.destroy also closes loading.
    }
  }
}

async function verifiedTargetFreeDocument(request) {
  validateTargetFreeRequest(request)
  try {
    const before = await lstat(request.path)
    const canonicalPath = await realpath(request.path)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      canonicalPath !== request.path
    ) {
      invalid('MINERU_TARGET_FREE_SOURCE_IDENTITY_MISMATCH')
    }
    const canonicalBefore = await lstat(canonicalPath)
    if (
      !canonicalBefore.isFile() ||
      canonicalBefore.isSymbolicLink() ||
      canonicalBefore.size !== request.byteLength
    ) {
      invalid('MINERU_TARGET_FREE_SOURCE_IDENTITY_MISMATCH')
    }
    const bytes = await readFile(canonicalPath)
    const after = await lstat(canonicalPath)
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== canonicalBefore.dev ||
      after.ino !== canonicalBefore.ino ||
      after.size !== canonicalBefore.size ||
      bytes.byteLength !== request.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== request.sha256
    ) {
      invalid('MINERU_TARGET_FREE_SOURCE_IDENTITY_MISMATCH')
    }
    return {
      id: request.documentId,
      path: canonicalPath,
      byteLength: request.byteLength,
      sha256: request.sha256,
      pageCount: await pdfPageCount(bytes),
    }
  } catch (error) {
    if (
      [
        'INVALID_MINERU_TARGET_FREE_REQUEST',
        'INVALID_MINERU_PDF_SOURCE',
        'MINERU_TARGET_FREE_SOURCE_IDENTITY_MISMATCH',
      ].includes(error?.message)
    ) {
      throw error
    }
    invalid('MINERU_TARGET_FREE_SOURCE_IDENTITY_MISMATCH')
  }
}

function round(value) {
  return Number(value.toFixed(6))
}

function nativeBox(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some(
      (coordinate) =>
        typeof coordinate !== 'number' ||
        !Number.isFinite(coordinate) ||
        coordinate < 0 ||
        coordinate > 1000,
    ) ||
    value[2] <= value[0] ||
    value[3] <= value[1]
  ) {
    return null
  }
  return [
    round(value[0] / 1000),
    round(value[1] / 1000),
    round((value[2] - value[0]) / 1000),
    round((value[3] - value[1]) / 1000),
  ]
}

function flattenStrings(value, strings = []) {
  if (typeof value === 'string') {
    strings.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, strings)
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (!['path', 'image_source'].includes(key)) flattenStrings(item, strings)
    }
  }
  return strings
}

function kindForType(type) {
  if (['image', 'chart'].includes(type)) return 'figure'
  if (['equation', 'equation_interline'].includes(type)) return 'equation'
  if (type === 'table') return 'table'
  if (type === 'page_footnote') return 'footnote'
  if (type === 'title') return 'heading'
  if (['text', 'paragraph', 'list'].includes(type)) return 'prose'
  if (['aside_text', 'page_aside_text'].includes(type)) return 'aside'
  return null
}

function normalizeNativeItem(item, nativeOrder, sourceVersion) {
  if (!isRecord(item)) return null
  const box = nativeBox(item.bbox)
  const kind =
    sourceVersion === 'v1' &&
    item.type === 'text' &&
    Number.isSafeInteger(item.text_level) &&
    item.text_level >= 1
      ? 'heading'
      : kindForType(item.type)
  if (!box || !kind) return null
  const content = sourceVersion === 'v2' ? item.content : item
  const text =
    sourceVersion === 'v1'
      ? typeof item.text === 'string'
        ? item.text
        : ''
      : flattenStrings(content).join(' ')
  const captionValue =
    sourceVersion === 'v1'
      ? (item.image_caption ?? item.table_caption ?? [])
      : (item.content?.image_caption ?? item.content?.table_caption ?? [])
  const captionText = flattenStrings(captionValue).join(' ')
  const tableHtml =
    sourceVersion === 'v1'
      ? item.table_body
      : (item.content?.html ?? item.content?.table_body)
  return {
    nativeOrder,
    kind,
    box,
    text,
    captionText,
    semanticTable:
      kind === 'table' && semanticTableFromHtml(tableHtml) !== null,
    sourceVersion,
  }
}

function intersectionArea(left, right) {
  const x0 = Math.max(left[0], right[0])
  const y0 = Math.max(left[1], right[1])
  const x1 = Math.min(left[0] + left[2], right[0] + right[2])
  const y1 = Math.min(left[1] + left[3], right[1] + right[3])
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
}

function targetCoverage(itemBox, targetBox) {
  return intersectionArea(itemBox, targetBox) / (targetBox[2] * targetBox[3])
}

function itemCoverage(itemBox, targetBox) {
  return intersectionArea(itemBox, targetBox) / (itemBox[2] * itemBox[3])
}

function horizontalOverlapRatio(left, right) {
  const overlap = Math.max(
    0,
    Math.min(left[0] + left[2], right[0] + right[2]) -
      Math.max(left[0], right[0]),
  )
  return overlap / Math.min(left[2], right[2])
}

function unionBox(boxes) {
  const x0 = Math.min(...boxes.map((box) => box[0]))
  const y0 = Math.min(...boxes.map((box) => box[1]))
  const x1 = Math.max(...boxes.map((box) => box[0] + box[2]))
  const y1 = Math.max(...boxes.map((box) => box[1] + box[3]))
  return [round(x0), round(y0), round(x1 - x0), round(y1 - y0)]
}

function hasGlobalFigureCaption(item) {
  return /\b(?:figure|fig\.)\s*\d+/i.test(item.captionText)
}

function hasSubpanelCaption(item) {
  return /(?:^|\s)\([a-z]\)(?:\s|$)/i.test(item.captionText)
}

function groupFigures(figures) {
  const groups = []
  for (const figure of figures) {
    const previous = groups.at(-1)
    const previousBottom = previous
      ? previous.box[1] + previous.box[3]
      : Number.NEGATIVE_INFINITY
    const verticalGap = figure.box[1] - previousBottom
    const relatedCaptions =
      previous &&
      (hasGlobalFigureCaption(previous) || hasGlobalFigureCaption(figure)) &&
      (hasSubpanelCaption(previous) || hasSubpanelCaption(figure))
    if (
      previous &&
      verticalGap >= -0.002 &&
      verticalGap <= 0.02 &&
      horizontalOverlapRatio(previous.box, figure.box) >= 0.7 &&
      relatedCaptions
    ) {
      previous.members.push(figure)
      previous.box = unionBox(previous.members.map(({ box }) => box))
      previous.captionText += ` ${figure.captionText}`
      continue
    }
    groups.push({ ...figure, members: [figure] })
  }
  return groups
}

function groupEquations(equations) {
  const groups = []
  for (const equation of equations) {
    const previous = groups.at(-1)
    const previousBottom = previous
      ? previous.box[1] + previous.box[3]
      : Number.NEGATIVE_INFINITY
    const verticalGap = equation.box[1] - previousBottom
    const aligned =
      previous && horizontalOverlapRatio(previous.box, equation.box) >= 0.2
    const tagged =
      previous && /\\tag\s*\{?\d+/i.test(`${previous.text} ${equation.text}`)
    if (
      previous &&
      verticalGap >= -0.002 &&
      verticalGap <= 0.008 &&
      aligned &&
      tagged
    ) {
      previous.members.push(equation)
      previous.box = unionBox(previous.members.map(({ box }) => box))
      previous.text += ` ${equation.text}`
      continue
    }
    groups.push({ ...equation, members: [equation] })
  }
  return groups
}

function normalizePage(source) {
  const v1 = Array.isArray(source?.v1)
    ? source.v1
        .map((item, index) => normalizeNativeItem(item, index, 'v1'))
        .filter(Boolean)
    : []
  const v2 = Array.isArray(source?.v2)
    ? source.v2
        .map((item, index) => normalizeNativeItem(item, index, 'v2'))
        .filter(Boolean)
    : []
  const primary = v1.length > 0 ? v1 : v2
  const figures = groupFigures(primary.filter(({ kind }) => kind === 'figure'))
  const equations = groupEquations(
    primary.filter(({ kind }) => kind === 'equation'),
  )
  const detection = [
    ...figures,
    ...equations,
    ...primary.filter(({ kind }) => ['table', 'footnote'].includes(kind)),
  ].sort((left, right) => left.nativeOrder - right.nativeOrder)
  const titleItems = v2.filter(({ kind }) => kind === 'heading')
  const semantic = [...primary, ...titleItems]
  return {
    detection,
    semantic,
    order: v2.length > 0 ? v2 : v1,
    targetFreeOrder: primary,
  }
}

export function mineruContentToTargetFreeObservations(contentByPage) {
  if (
    !(contentByPage instanceof Map) ||
    [...contentByPage].some(([page]) => !Number.isSafeInteger(page) || page < 1)
  ) {
    invalid('INVALID_MINERU_PAGE_CONTENT')
  }
  const objects = []
  const orderedIds = []
  for (const [page, source] of [...contentByPage].sort(
    ([left], [right]) => left - right,
  )) {
    const normalized = normalizePage(source)
    const candidates = [
      ...normalized.detection,
      ...normalized.targetFreeOrder.filter(
        ({ kind }) =>
          !['figure', 'equation', 'table', 'footnote'].includes(kind),
      ),
    ].sort((left, right) => left.nativeOrder - right.nativeOrder)
    const counters = new Map()
    for (const item of candidates) {
      const count = (counters.get(item.kind) ?? 0) + 1
      counters.set(item.kind, count)
      const id = `mineru-${item.kind}-p${String(page).padStart(3, '0')}-${String(count).padStart(3, '0')}`
      objects.push({
        id,
        page,
        kind: item.kind,
        label:
          item.kind === 'table'
            ? item.semanticTable
              ? 'semantic-table'
              : 'table-image'
            : item.kind,
        box: [...item.box],
      })
      orderedIds.push(id)
    }
  }
  return {
    schemaVersion: '1.0.0',
    objects,
    readingOrder: orderedIds,
    relationships: [],
  }
}

function targetKind(target) {
  return target.kind ?? target.role ?? null
}

function compatibleKind(itemKind, wanted) {
  if (!wanted || wanted === 'candidate') return true
  if (wanted === 'caption') return false
  if (wanted === 'note-reference') return itemKind === 'prose'
  return itemKind === wanted
}

function bestMatch(items, target, used = new Set(), minimumItemCoverage = 0) {
  if (!normalizedBox(target?.box)) return null
  return (
    items
      .filter(
        (item) =>
          !used.has(item) && compatibleKind(item.kind, targetKind(target)),
      )
      .map((item) => ({
        item,
        coverage: targetCoverage(item.box, target.box),
        itemCoverage: itemCoverage(item.box, target.box),
      }))
      .filter(
        ({ coverage, itemCoverage: candidateCoverage }) =>
          coverage >= 0.15 && candidateCoverage >= minimumItemCoverage,
      )
      .sort(
        (left, right) =>
          right.coverage - left.coverage ||
          left.item.nativeOrder - right.item.nativeOrder,
      )[0]?.item ?? null
  )
}

function detectionOutput(page, pageNumber) {
  const counters = new Map()
  return {
    objects: page.detection.map((item) => {
      const count = (counters.get(item.kind) ?? 0) + 1
      counters.set(item.kind, count)
      return {
        id: `mineru-${item.kind}-p${String(pageNumber).padStart(3, '0')}-${String(count).padStart(3, '0')}`,
        label: item.kind,
        box: item.box,
      }
    }),
  }
}

function classificationOutput(item, page) {
  const labels = []
  for (const target of item.targets ?? []) {
    const match = bestMatch(page.semantic, target, new Set(), 0.5)
    if (!match) continue
    let label = match.kind
    if (match.kind === 'table') {
      label = match.semanticTable ? 'semantic-table' : 'table-image'
    }
    labels.push({ targetId: target.id, label })
  }
  return labels.length > 0 ? { labels } : null
}

function markerFromFootnote(text) {
  const match = text.match(
    /^\s*(?:\$?\s*\^\s*\{\s*)?(\\dagger|\\ast|\*|\d{1,3})(?:\s*\}\s*\$?)?/,
  )
  if (!match) return null
  return match[1].replace(/^\\/, '')
}

function mentionsMarker(text, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `(?:\\^\\s*\\{\\s*\\\\?${escaped}\\s*\\}|[⁰¹²³⁴⁵⁶⁷⁸⁹${escaped}])`,
    'u',
  ).test(text)
}

function relationshipOutput(item, page) {
  const relationships = []
  const targets = item.targets ?? []
  const figures = page.detection.filter(({ kind }) => kind === 'figure')
  const figureMatches = targets
    .map((target) => ({ target, native: bestMatch(figures, target) }))
    .filter(({ native }) => native && hasGlobalFigureCaption(native))
  if (targets.length === 2 && figureMatches.length === 1) {
    const figure = figureMatches[0]
    const caption = targets.find(({ id }) => id !== figure.target.id)
    if (caption) {
      relationships.push({
        type: 'caption-of',
        sourceId: caption.id,
        targetId: figure.target.id,
      })
    }
  }
  const footnotes = page.semantic.filter(({ kind }) => kind === 'footnote')
  const footnoteMatches = targets
    .map((target) => ({ target, native: bestMatch(footnotes, target) }))
    .filter(({ native }) => native)
  if (targets.length === 2 && footnoteMatches.length === 1) {
    const footnote = footnoteMatches[0]
    const reference = targets.find(({ id }) => id !== footnote.target.id)
    const marker = markerFromFootnote(footnote.native.text)
    const referenceItems = page.semantic.filter(
      ({ kind }) => kind !== 'footnote',
    )
    const referenceContainer = reference
      ? bestMatch(referenceItems, reference)
      : null
    if (
      marker &&
      reference &&
      referenceContainer &&
      mentionsMarker(referenceContainer.text, marker)
    ) {
      relationships.push({
        type: 'note-body-of',
        sourceId: footnote.target.id,
        targetId: reference.id,
      })
    }
  }
  return relationships.length > 0 ? { relationships } : null
}

function readingOrderAcrossPages(item, contentByPage, normalizedPages) {
  const matches = []
  for (const target of item.targets ?? []) {
    const sourcePage = target.sourcePage ?? item.page
    const key = `${item.documentId}:${sourcePage}`
    const source = contentByPage.get(key)
    if (!source) continue
    if (!normalizedPages.has(key)) {
      normalizedPages.set(key, normalizePage(source))
    }
    const page = normalizedPages.get(key)
    const match = bestMatch(page.order, target)
    if (!match) continue
    matches.push({
      targetId: target.id,
      sourcePage,
      nativeOrder: match.nativeOrder,
    })
  }
  if (matches.length < 2) return null
  matches.sort(
    (left, right) =>
      left.sourcePage - right.sourcePage ||
      left.nativeOrder - right.nativeOrder ||
      left.targetId.localeCompare(right.targetId),
  )
  return { order: matches.map(({ targetId }) => targetId) }
}

export function normalizeMineruPredictions(
  request,
  contentByPage,
  runtimeIdentity = { status: 'unattested', tool: null, model: null },
) {
  validateRequest(request)
  if (!(contentByPage instanceof Map)) invalid('INVALID_MINERU_PAGE_CONTENT')
  if (!validRuntimeIdentity(runtimeIdentity)) {
    invalid('INVALID_MINERU_RUNTIME_IDENTITY')
  }
  const normalizedPages = new Map()
  const cases = []
  for (const item of request.cases) {
    if (item.task === 'reading-order') {
      const output = readingOrderAcrossPages(
        item,
        contentByPage,
        normalizedPages,
      )
      if (output) cases.push({ caseId: item.id, output })
      continue
    }
    const key = `${item.documentId}:${item.page}`
    const source = contentByPage.get(key)
    if (!source) continue
    if (!normalizedPages.has(key))
      normalizedPages.set(key, normalizePage(source))
    const page = normalizedPages.get(key)
    let output = null
    if (item.task === 'detection') output = detectionOutput(page, item.page)
    if (item.task === 'classification') {
      output = classificationOutput(item, page)
    }
    if (item.task === 'relationship') output = relationshipOutput(item, page)
    if (output) cases.push({ caseId: item.id, output })
  }
  return {
    schemaVersion: '1.0.0',
    evalSetId: request.evalSet.id,
    evalSetSha256: request.evalSet.sha256,
    candidate: {
      id: request.candidate.id,
      version: request.candidate.version,
      format: 'mineru-content-list',
      formatVersion: ADAPTER_FORMAT_VERSION,
      adapterSha256: request.candidate.adapterSha256,
      runtimeIdentity: structuredClone(runtimeIdentity),
    },
    cases,
  }
}

function validMineruCacheIdentity(identity) {
  return (
    exactKeys(identity, [
      'schemaVersion',
      'declaredCandidate',
      'tool',
      'model',
      'attestationStatus',
      'adapterSha256',
      'adapterFormatVersion',
      'backend',
      'configuration',
    ]) &&
    identity.schemaVersion === CACHE_SCHEMA_VERSION &&
    exactKeys(identity.declaredCandidate, ['id', 'version']) &&
    SAFE_ID.test(identity.declaredCandidate.id) &&
    SAFE_ID.test(identity.declaredCandidate.version) &&
    validRuntimeToolIdentity(identity.tool) &&
    (identity.model === null || validRuntimeModelIdentity(identity.model)) &&
    identity.attestationStatus ===
      (identity.model === null ? 'unattested' : 'attested') &&
    SHA256.test(identity.adapterSha256) &&
    identity.adapterFormatVersion === ADAPTER_FORMAT_VERSION &&
    SAFE_ID.test(identity.backend) &&
    exactKeys(identity.configuration, ['formula', 'table', 'imageAnalysis']) &&
    ['formula', 'table', 'imageAnalysis'].every(
      (key) => typeof identity.configuration[key] === 'boolean',
    )
  )
}

function createMineruCacheIdentityForCandidate(
  candidate,
  adapterSha256,
  options = {},
) {
  const backend = options.backend ?? 'vlm-auto-engine'
  const executableIdentity = options.executableIdentity
  const modelIdentity = options.modelIdentity ?? null
  const identity = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    declaredCandidate: {
      id: candidate.id,
      version: candidate.version,
    },
    tool: executableIdentity,
    model: modelIdentity,
    attestationStatus: modelIdentity === null ? 'unattested' : 'attested',
    adapterSha256,
    adapterFormatVersion: ADAPTER_FORMAT_VERSION,
    backend,
    configuration: { ...MINERU_CONFIGURATION },
  }
  if (!validMineruCacheIdentity(identity)) invalid('INVALID_MINERU_CACHE_KEY')
  return identity
}

export function createMineruCacheIdentity(request, options = {}) {
  validateRequest(request)
  return createMineruCacheIdentityForCandidate(
    request.candidate,
    request.candidate.adapterSha256,
    options,
  )
}

function runtimeIdentityFromCacheIdentity(identity) {
  if (!validMineruCacheIdentity(identity)) invalid('INVALID_MINERU_CACHE_KEY')
  return {
    status: identity.attestationStatus,
    tool: structuredClone(identity.tool),
    model: structuredClone(identity.model),
  }
}

export function createMineruCacheMetadata(identity, document, page) {
  if (
    !validMineruCacheIdentity(identity) ||
    !SAFE_ID.test(document?.id ?? '') ||
    !SHA256.test(document?.sha256 ?? '') ||
    !Number.isSafeInteger(page) ||
    page < 1
  ) {
    invalid('INVALID_MINERU_CACHE_KEY')
  }
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    identity: structuredClone(identity),
    identitySha256: canonicalHash(identity),
    documentId: document.id,
    documentSha256: document.sha256,
    page,
  }
}

export function cachePageDirectory(cacheRoot, document, page, identity) {
  if (
    typeof cacheRoot !== 'string' ||
    !isAbsolute(resolve(cacheRoot)) ||
    !SAFE_ID.test(document?.id ?? '') ||
    !SHA256.test(document?.sha256 ?? '') ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !validMineruCacheIdentity(identity)
  ) {
    invalid('INVALID_MINERU_CACHE_KEY')
  }
  return join(
    resolve(cacheRoot),
    CACHE_NAMESPACE,
    canonicalHash(identity),
    document.sha256,
    `p${String(page).padStart(6, '0')}`,
  )
}

function within(parent, child) {
  const path = relative(parent, child)
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  )
}

async function readNativeJson(path) {
  const details = await lstat(path)
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size <= 0 ||
    details.size > MAX_NATIVE_JSON_BYTES
  ) {
    invalid('INVALID_MINERU_CONTENT_LIST')
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    invalid('INVALID_MINERU_CONTENT_LIST')
  }
}

async function existingContent(
  pageDirectory,
  document,
  expectedMetadata = null,
) {
  if (expectedMetadata) {
    let metadata
    try {
      metadata = await readNativeJson(
        join(pageDirectory, 'cache-identity.json'),
      )
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    if (canonicalJson(metadata) !== canonicalJson(expectedMetadata)) {
      invalid('MINERU_CACHE_IDENTITY_MISMATCH')
    }
  }
  const nativeDirectory = join(pageDirectory, document.id, 'vlm')
  const v1Path = join(nativeDirectory, `${document.id}_content_list.json`)
  const v2Path = join(nativeDirectory, `${document.id}_content_list_v2.json`)
  let v1
  try {
    v1 = await readNativeJson(v1Path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (
    !Array.isArray(v1) ||
    v1.some(
      (item) =>
        !isRecord(item) || (item.page_idx !== undefined && item.page_idx !== 0),
    )
  ) {
    invalid('INVALID_MINERU_CONTENT_LIST')
  }
  let v2 = []
  try {
    const rawV2 = await readNativeJson(v2Path)
    if (!Array.isArray(rawV2)) invalid('INVALID_MINERU_CONTENT_LIST')
    v2 = Array.isArray(rawV2[0]) ? rawV2[0] : rawV2
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return { v1, v2 }
}

async function loadOrRunPage({
  cacheRoot,
  document,
  page,
  mineruBin,
  mineruEnvironment = process.env,
  backend,
  cacheIdentity,
}) {
  const pageDirectory = cachePageDirectory(
    cacheRoot,
    document,
    page,
    cacheIdentity,
  )
  const cacheMetadata = createMineruCacheMetadata(cacheIdentity, document, page)
  const cached = await existingContent(pageDirectory, document, cacheMetadata)
  if (cached) return cached
  await mkdir(dirname(pageDirectory), { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(
    join(dirname(pageDirectory), `.p${String(page).padStart(6, '0')}-`),
  )
  try {
    const result = spawnSync(
      mineruBin,
      [
        '-p',
        document.path,
        '-o',
        staging,
        '-b',
        backend,
        '-s',
        String(page - 1),
        '-e',
        String(page - 1),
        '--formula',
        'true',
        '--table',
        'true',
        '--image-analysis',
        'true',
      ],
      {
        env: {
          ...mineruEnvironment,
          SRT_PDF_EVAL_OFFLINE: '1',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
        },
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    if (result.error || result.status !== 0) invalid('MINERU_EXECUTION_FAILED')
    const generated = await existingContent(staging, document)
    if (!generated) invalid('MINERU_OUTPUT_MISSING')
    await writeFile(
      join(staging, 'cache-identity.json'),
      `${JSON.stringify(cacheMetadata, null, 2)}\n`,
      { mode: 0o600 },
    )
    try {
      await rename(staging, pageDirectory)
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error
    }
    return (
      (await existingContent(pageDirectory, document, cacheMetadata)) ??
      generated
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

function parseArguments(arguments_) {
  const values = {}
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (!argument.startsWith('--')) invalid('INVALID_USAGE')
    const key = argument.slice(2)
    const value = arguments_[index + 1]
    if (!value || value.startsWith('--') || Object.hasOwn(values, key)) {
      invalid('INVALID_USAGE')
    }
    values[key] = value
    index += 1
  }
  const allowed = new Set([
    'request',
    'output',
    'cache-root',
    'mineru-bin',
    'backend',
  ])
  if (Object.keys(values).some((key) => !allowed.has(key)) || !values.output) {
    invalid('INVALID_USAGE')
  }
  return {
    request: values.request ? resolve(values.request) : null,
    output: resolve(values.output),
    cacheRoot: resolve(
      values['cache-root'] ??
        process.env.SRT_MINERU_CACHE_ROOT ??
        join(homedir(), 'Library', 'Caches', 'ernie-sg', 'mineru-content-list'),
    ),
    mineruBin: values['mineru-bin'] ?? process.env.SRT_MINERU_BIN ?? 'mineru',
    backend:
      values.backend ?? process.env.SRT_MINERU_BACKEND ?? 'vlm-auto-engine',
  }
}

async function readRequest(path) {
  const bytes = path ? await readFile(path) : await readStandardInput()
  if (bytes.length <= 0 || bytes.length > 32 * 1024 * 1024) {
    invalid('INVALID_MINERU_ADAPTER_REQUEST')
  }
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    invalid('INVALID_MINERU_ADAPTER_REQUEST')
  }
}

async function readStandardInput() {
  const chunks = []
  let byteLength = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.length
    if (byteLength > 32 * 1024 * 1024) {
      invalid('INVALID_MINERU_ADAPTER_REQUEST')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

async function writeExclusive(path, value) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(value)
  } finally {
    await handle.close()
  }
}

function requireOfflineMode(targetFree) {
  const modeFlag = targetFree
    ? process.env.SRT_PDF_TARGET_FREE_OFFLINE
    : process.env.SRT_PDF_EVAL_OFFLINE
  if (
    modeFlag !== '1' ||
    process.env.HF_HUB_OFFLINE !== '1' ||
    process.env.TRANSFORMERS_OFFLINE !== '1'
  ) {
    invalid('MINERU_ADAPTER_OFFLINE_REQUIRED')
  }
}

async function canonicalCacheRoot(parsed) {
  if (within(REPOSITORY_ROOT, parsed.cacheRoot)) {
    invalid('MINERU_CACHE_MUST_BE_EXTERNAL')
  }
  await mkdir(parsed.cacheRoot, { recursive: true, mode: 0o700 })
  const cacheRoot = await realpath(parsed.cacheRoot)
  if (within(REPOSITORY_ROOT, cacheRoot)) {
    invalid('MINERU_CACHE_MUST_BE_EXTERNAL')
  }
  return cacheRoot
}

async function runTargetFreeMode(parsed, request) {
  const candidate = targetFreeCandidate()
  const runnerRuntime = await targetFreeRunnerRuntime(parsed)
  const document = await verifiedTargetFreeDocument(request)
  await assertAdapterSourceIdentity(
    ADAPTER_PATH,
    candidate.adapterSha256,
    'MINERU_ADAPTER_IDENTITY_MISMATCH',
  )
  const observedExecutable = await observeMineruRuntime(
    runnerRuntime.mineruBin,
    runnerRuntime.mineruEnvironment,
  )
  const modelIdentity = mineruModelIdentity()
  const cacheIdentity = createMineruCacheIdentityForCandidate(
    candidate,
    candidate.adapterSha256,
    {
      backend: parsed.backend,
      executableIdentity: observedExecutable.identity,
      modelIdentity,
    },
  )
  const cacheRoot = await canonicalCacheRoot(parsed)
  const contentByPage = new Map()
  for (let page = 1; page <= document.pageCount; page += 1) {
    contentByPage.set(
      page,
      await loadOrRunPage({
        cacheRoot,
        document,
        page,
        mineruBin: observedExecutable.resolvedPath,
        mineruEnvironment: runnerRuntime.mineruEnvironment,
        backend: parsed.backend,
        cacheIdentity,
      }),
    )
  }
  const observations = mineruContentToTargetFreeObservations(contentByPage)
  const verifiedAfterRun = await verifiedTargetFreeDocument(request)
  if (verifiedAfterRun.pageCount !== document.pageCount) {
    invalid('MINERU_TARGET_FREE_SOURCE_IDENTITY_MISMATCH')
  }
  const output = {
    schemaVersion: TARGET_FREE_OUTPUT_SCHEMA_VERSION,
    documentId: document.id,
    sourceSha256: document.sha256,
    candidate: {
      id: candidate.id,
      version: candidate.version,
      format: TARGET_FREE_FORMAT,
      formatVersion: TARGET_FREE_FORMAT_VERSION,
      adapterSourceSha256: candidate.adapterSha256,
    },
    runtimeIdentity: runtimeIdentityFromCacheIdentity(cacheIdentity),
    output: observations,
  }
  if (JSON.stringify(output).includes(document.path)) {
    invalid('MINERU_TARGET_FREE_OUTPUT_LEAKED_SOURCE_PATH')
  }
  await writeExclusive(parsed.output, `${JSON.stringify(output, null, 2)}\n`)
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2))
  if (within(REPOSITORY_ROOT, parsed.cacheRoot)) {
    invalid('MINERU_CACHE_MUST_BE_EXTERNAL')
  }
  const request = await readRequest(parsed.request)
  if (isTargetFreeRequest(request)) {
    validateTargetFreeRequest(request)
    requireOfflineMode(true)
    await runTargetFreeMode(parsed, request)
    return
  }
  const documents = validateRequest(request)
  requireOfflineMode(false)
  await assertAdapterSourceIdentity(
    ADAPTER_PATH,
    request.candidate.adapterSha256,
    'MINERU_ADAPTER_IDENTITY_MISMATCH',
  )
  const observedExecutable = await observeMineruRuntime(parsed.mineruBin)
  const modelIdentity = mineruModelIdentity()
  const cacheIdentity = createMineruCacheIdentity(request, {
    backend: parsed.backend,
    executableIdentity: observedExecutable.identity,
    modelIdentity,
  })
  const cacheRoot = await canonicalCacheRoot(parsed)
  const requiredPages = new Map()
  for (const item of request.cases) {
    const pages = new Set([
      item.page,
      ...(item.targets ?? []).flatMap(({ sourcePage }) =>
        Number.isSafeInteger(sourcePage) ? [sourcePage] : [],
      ),
    ])
    for (const page of pages) {
      requiredPages.set(`${item.documentId}:${page}`, {
        document: documents.get(item.documentId),
        page,
      })
    }
  }
  const contentByPage = new Map()
  for (const [key, value] of [...requiredPages].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    contentByPage.set(
      key,
      await loadOrRunPage({
        cacheRoot,
        document: value.document,
        page: value.page,
        mineruBin: observedExecutable.resolvedPath,
        backend: parsed.backend,
        cacheIdentity,
      }),
    )
  }
  const predictions = normalizeMineruPredictions(
    request,
    contentByPage,
    runtimeIdentityFromCacheIdentity(cacheIdentity),
  )
  await writeExclusive(
    parsed.output,
    `${JSON.stringify(predictions, null, 2)}\n`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const code = SAFE_ID.test(error?.message ?? '')
      ? error.message
      : 'MINERU_ADAPTER_FAILED'
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`)
    process.exitCode = 2
  })
}
