import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import * as epubcheck from 'epubcheck-static'
import { strFromU8, unzipSync } from 'fflate'
import { MAX_LOCAL_PDF_BYTES } from '../../src/research/import-types'
import {
  bindExecutable,
  verifyExecutable,
} from '../../tools/deployment/disposable-pdf-worker-runtime.mjs'
import { installStaticRoutes } from './static-build'

type FidelityContract = {
  fixture: string
  byteLength: number
  sourceSha256: string
  title: string
  canonicalSpans: Array<{ kind: string; text: string }>
  headings: Array<{ text: string; level: number }>
  listItems: Array<{ text: string; level: number; ordered: boolean }>
  inlineSemantics: Array<{
    text: string
    bold?: boolean
    italic?: boolean
    href?: string
    verticalAlign?: 'superscript' | 'subscript'
    relationship?: 'footnote'
  }>
  note: { label: string; text: string }
  references: string[]
  visuals: Array<{
    kind: string
    caption: string
    rows?: string[][]
    sourceText?: string
  }>
  profiles: Array<{
    id: 'mobile' | 'paperProMove' | 'paperPro'
    version: string
    width: number
    height: number | null
    unit: 'css-px' | 'device-px'
    pixelsPerInch: number | null
    previewWidthCssPx: number
    margins: { top: number; right: number; bottom: number; left: number }
  }>
}

const contract = JSON.parse(
  await readFile(
    new URL(
      '../fixtures/pdf/pdf-to-epub-fidelity.contract.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as FidelityContract
const fixture = path.resolve('tests', 'fixtures', 'pdf', contract.fixture)
const fixtureBytes = await readFile(fixture)
const scannedFixture = path.resolve(
  'tests',
  'fixtures',
  'pdf',
  'scanned-page.pdf',
)
const noteCitationAssociationsFixture = path.resolve(
  'tests',
  'fixtures',
  'pdf',
  'note-citation-associations.pdf',
)
const scanVariantFixtures = [
  { name: 'rotated scan', fileName: 'rotated-scan.pdf', pages: [1] },
  { name: 'two-page spread scan', fileName: 'two-page-scan.pdf', pages: [1] },
  {
    name: 'true two-physical-page scan',
    fileName: 'two-physical-page-scan.pdf',
    pages: [1, 2],
  },
  {
    name: 'tiled multi-image scan',
    fileName: 'tiled-multi-image-scan.pdf',
    pages: [1],
  },
  {
    name: 'mixed digital and scan document',
    fileName: 'mixed-digital-scan.pdf',
    pages: [2],
    expectedText: 'Readable digital introduction',
  },
  {
    name: 'mixed raster page',
    fileName: 'mixed-page.pdf',
    pages: [1],
    expectedText: 'Mixed page with sparse embedded text',
  },
  {
    name: 'sparse embedded-text page',
    fileName: 'sparse-embedded-text.pdf',
    pages: [1],
    expectedText: 'Section divider',
  },
  {
    name: 'multilingual scan',
    fileName: 'multilingual-scan.pdf',
    pages: [1],
  },
] satisfies Array<{
  name: string
  fileName: string
  pages: number[]
  expectedText?: string
}>
if (fixtureBytes.byteLength !== contract.byteLength) {
  throw new Error(
    `Fidelity fixture byte length changed: expected ${contract.byteLength}, received ${fixtureBytes.byteLength}`,
  )
}
const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex')
if (fixtureSha256 !== contract.sourceSha256) {
  throw new Error(
    `Fidelity fixture SHA-256 changed: expected ${contract.sourceSha256}, received ${fixtureSha256}`,
  )
}
const execFileAsync = promisify(execFile)
const EPUBCHECK_VERSION = 'v5.3.0'
const EPUBCHECK_JAR_SHA256 =
  'f7f96617c929371821609b88c8484d6dc9f24fe916499863c46094c5fb778a65'
if (epubcheck.version !== EPUBCHECK_VERSION) {
  throw new Error(`Unexpected EPUBCheck version: ${epubcheck.version}`)
}
const epubcheckJarSha256 = createHash('sha256')
  .update(await readFile(epubcheck.path))
  .digest('hex')
if (epubcheckJarSha256 !== EPUBCHECK_JAR_SHA256) {
  throw new Error('The pinned EPUBCheck JAR changed')
}

type BrowserProofContext = {
  exactHead: string
  workerName: string
  workerVersionId: string
  runNonce: string
  origin: string
}

function isWithin(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

async function externalExclusiveReceiptPath(value: string | undefined) {
  if (!value) return undefined
  const resolved = path.resolve(value)
  const parentPath = path.dirname(resolved)
  const parentMetadata = await lstat(parentPath)
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error('SRT_BROWSER_RECEIPT_PATH parent must be a real directory')
  }
  const [repositoryRoot, resolvedParent] = await Promise.all([
    realpath(path.resolve('.')),
    realpath(parentPath),
  ])
  if (!path.isAbsolute(value) || isWithin(repositoryRoot, resolvedParent)) {
    throw new Error(
      'SRT_BROWSER_RECEIPT_PATH must be an absolute path outside the repository',
    )
  }
  const canonicalTarget = path.join(resolvedParent, path.basename(resolved))
  const existing = await lstat(canonicalTarget).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    },
  )
  if (existing) {
    throw new Error('SRT_BROWSER_RECEIPT_PATH must not already exist')
  }
  return canonicalTarget
}

function readBrowserProofContext(value: string | undefined) {
  if (!value) return undefined
  let context: BrowserProofContext
  try {
    context = JSON.parse(value) as BrowserProofContext
  } catch {
    throw new Error('SRT_BROWSER_PROOF_CONTEXT must be valid JSON')
  }
  const keys = Object.keys(context).sort()
  const expectedKeys = [
    'exactHead',
    'origin',
    'runNonce',
    'workerName',
    'workerVersionId',
  ]
  const origin = new URL(context.origin)
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    !/^[a-f0-9]{40}$/u.test(context.exactHead) ||
    !/^erniesg-i171-[a-f0-9]{12}-[a-f0-9]{24}$/u.test(context.workerName) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      context.workerVersionId,
    ) ||
    !/^[a-f0-9]{24}$/u.test(context.runNonce) ||
    origin.origin !== context.origin ||
    origin.protocol !== 'https:' ||
    origin.hostname.split('.').length !== 4 ||
    !origin.hostname.startsWith(`${context.workerName}.`) ||
    !origin.hostname.endsWith('.workers.dev')
  ) {
    throw new Error('SRT_BROWSER_PROOF_CONTEXT is not an owned Worker run')
  }
  return context
}

const browserReceiptPath = await externalExclusiveReceiptPath(
  process.env.SRT_BROWSER_RECEIPT_PATH,
)
const browserProofContext = readBrowserProofContext(
  process.env.SRT_BROWSER_PROOF_CONTEXT,
)
if (browserReceiptPath && !browserProofContext) {
  throw new Error(
    'SRT_BROWSER_PROOF_CONTEXT is required when emitting a browser receipt',
  )
}
if (
  browserProofContext &&
  process.env.SRT_WORKERS_DEV_BASE_URL !== browserProofContext.origin
) {
  throw new Error('Browser proof origin does not match the configured Worker')
}
const epubcheckJavaBinding = (await bindExecutable(
  process.env.SRT_EPUBCHECK_JAVA_BIN ??
    (process.platform === 'win32' ? '' : '/usr/bin/java'),
)) as Awaited<ReturnType<typeof bindExecutable>> & {
  path: string
  sha256: string
}
const expectedJavaSha256 = process.env.SRT_EPUBCHECK_JAVA_SHA256
if (
  (browserProofContext && !expectedJavaSha256) ||
  (expectedJavaSha256 !== undefined &&
    expectedJavaSha256 !== epubcheckJavaBinding.sha256)
) {
  throw new Error(
    'EPUBCheck Java executable does not match its trusted binding',
  )
}
const profileUi = {
  mobile: { label: 'Mobile', download: 'Download Mobile EPUB' },
  paperProMove: {
    label: 'Paper Pro Move',
    download: 'Download Paper Pro Move EPUB',
  },
  paperPro: { label: 'Paper Pro', download: 'Download Paper Pro EPUB' },
} as const

type BrowserProfileReceipt = {
  profileId: string
  profileVersion: string
  artifactSha256: string
  canonicalGraphSha256: string
  canonicalNodeCount: number
  assetIndexSha256: string
  assetCount: number
  visualRelationshipIndexSha256: string
  visualRelationshipCount: number
  internalValidation: 'passed'
  epubCheck: {
    status: 'passed'
    version: 'v5.3.0'
    jarSha256: string
    failOnWarnings: true
    warningCount: 0
    errorCount: 0
    skipCount: 0
  }
}

const browserProof: {
  deployment?: {
    exactHead: string
    workerName: string
    workerVersionId: string
    runNonce: string
    observedOrigin: string
  }
  profiles?: BrowserProfileReceipt[]
  semanticCompleteness?: {
    textCoverage: number
    prose: number
    sections: number
    lists: number
    notes: number
    referencesOrCitations: number
    figures: number
    captions: number
    tables: number
    equations: number
    unresolvedObjectCount: 0
    unresolvedObjects: {
      assets: number
      captions: number
      citations: number
      equations: number
      footnoteReferences: number
      footnotes: number
      tables: number
    }
    unresolvedObjectsSha256: string
    ocrRequiredPageCount: number
    readingOrderDiagnosticCount: number
    unresolvedCorruptingJoinCount: number
  }
  crossRequestIsolation?: 'passed'
  objectUrlCleanup?: 'passed'
  negativeInputs?: 'passed'
  sourceBearingRequestCount?: 0
  sourceBearingLogCount?: 0
  retainedSourceMarkerCount?: 0
} = {}

function sha256Json(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function writeBrowserReceipt() {
  if (!browserReceiptPath) return
  if (
    !browserProof.deployment ||
    !browserProof.profiles ||
    !browserProof.semanticCompleteness ||
    browserProof.crossRequestIsolation !== 'passed' ||
    browserProof.objectUrlCleanup !== 'passed' ||
    browserProof.negativeInputs !== 'passed' ||
    browserProof.sourceBearingRequestCount !== 0 ||
    browserProof.sourceBearingLogCount !== 0 ||
    browserProof.retainedSourceMarkerCount !== 0
  ) {
    throw new Error('Browser proof is incomplete; refusing to write a receipt')
  }
  const serialized = `${JSON.stringify(
    {
      schemaVersion: '1.0.0',
      deployment: browserProof.deployment,
      source: {
        byteLength: contract.byteLength,
        sha256: contract.sourceSha256,
      },
      profiles: browserProof.profiles,
      semanticCompleteness: browserProof.semanticCompleteness,
      isolation: {
        crossRequest: browserProof.crossRequestIsolation,
        objectUrlCleanup: browserProof.objectUrlCleanup,
      },
      negativeInputs: browserProof.negativeInputs,
      privacy: {
        sourceBearingRequestCount: browserProof.sourceBearingRequestCount,
        sourceBearingLogCount: browserProof.sourceBearingLogCount,
        retainedSourceMarkerCount: browserProof.retainedSourceMarkerCount,
      },
    },
    null,
    2,
  )}\n`
  const receiptHandle = await open(
    browserReceiptPath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  )
  try {
    await receiptHandle.writeFile(serialized, 'utf8')
  } finally {
    await receiptHandle.close()
  }
}

test.describe.configure({ timeout: 120_000 })
test.beforeEach(async ({ page }) => installStaticRoutes(page))

async function waitForImporter(page: Page) {
  await expect(page.locator('#publication-pdf')).toBeEnabled({
    timeout: 30_000,
  })
}

async function waitForMaterializedEpub(page: Page) {
  await expect(page.locator('.epub-rendition-preview')).toHaveAttribute(
    'data-artifact-sha256',
    /^[a-f0-9]{64}$/u,
    { timeout: 90_000 },
  )
}

function sourceEvidenceMarkers(additionalMarkers: string[] = []) {
  return [
    '%PDF',
    contract.fixture,
    contract.sourceSha256,
    contract.title,
    ...contract.canonicalSpans.map(({ text }) => text),
    contract.note.text,
    ...contract.references,
    ...contract.visuals.flatMap(({ caption, sourceText }) => [
      caption,
      ...(sourceText ? [sourceText] : []),
    ]),
    ...additionalMarkers,
  ].filter((marker) => marker.length >= 4)
}

function expectedBrowserOrigin() {
  return new URL(
    process.env.SRT_WORKERS_DEV_BASE_URL ??
      (process.env.SRT_STATIC_BUILD_DIR
        ? 'https://srt-evaluation.test'
        : `http://127.0.0.1:${process.env.SRT_E2E_PORT ?? '1234'}`),
  ).origin
}

function isLocalDevBrowser() {
  return (
    process.env.SRT_WORKERS_DEV_BASE_URL === undefined &&
    process.env.SRT_STATIC_BUILD_DIR === undefined
  )
}

function studioPath() {
  return browserProofContext
    ? `/research/studio/?rucksack-run=${browserProofContext.runNonce}`
    : '/research/studio'
}

function fullyDecoded(value: string) {
  let decoded = value
  for (let index = 0; index < 4; index += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  return decoded
}

function validateFrozenPaths(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 25_000 ||
    !value.every(
      (candidate) =>
        typeof candidate === 'string' &&
        candidate.startsWith('/') &&
        candidate.length <= 2_048 &&
        new URL(candidate, expectedBrowserOrigin()).pathname === candidate &&
        !candidate.includes('?') &&
        !candidate.includes('#'),
    )
  ) {
    throw new Error('Browser asset allowlist is malformed')
  }
  const sorted = [...new Set(value)].sort((left, right) =>
    left.localeCompare(right, 'en'),
  )
  if (JSON.stringify(sorted) !== JSON.stringify(value)) {
    throw new Error('Browser asset allowlist must be unique and sorted')
  }
  return new Set(sorted)
}

async function staticBuildPaths(rootArgument: string) {
  const root = await realpath(path.resolve(rootArgument))
  const paths: string[] = []
  async function visit(directory: string, relativeDirectory: string) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink()) {
        throw new Error('Static browser asset allowlist contains a symlink')
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath, relativePath)
      } else if (metadata.isFile()) {
        paths.push(
          `/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
        )
      } else {
        throw new Error(
          'Static browser asset allowlist contains a special file',
        )
      }
      if (paths.length > 25_000) {
        throw new Error('Static browser asset allowlist is unbounded')
      }
    }
  }
  await visit(root, '')
  return validateFrozenPaths(
    paths.sort((left, right) => left.localeCompare(right, 'en')),
  )
}

async function frozenBrowserAssetPaths() {
  const manifestPath = process.env.SRT_BROWSER_ASSET_MANIFEST_PATH
  const expectedSha256 = process.env.SRT_BROWSER_ASSET_MANIFEST_SHA256
  if (browserProofContext) {
    if (!manifestPath || !path.isAbsolute(manifestPath) || !expectedSha256) {
      throw new Error('Workers browser proof requires a bound asset allowlist')
    }
    const metadata = await lstat(manifestPath)
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 2 * 1024 * 1024
    ) {
      throw new Error('Workers browser asset allowlist is not a bounded file')
    }
    const bytes = await readFile(manifestPath)
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
      throw new Error('Workers browser asset allowlist changed')
    }
    const parsed = JSON.parse(bytes.toString('utf8')) as { paths?: unknown }
    return validateFrozenPaths(parsed.paths)
  }
  return process.env.SRT_STATIC_BUILD_DIR
    ? await staticBuildPaths(process.env.SRT_STATIC_BUILD_DIR)
    : null
}

const frozenAssetPaths = await frozenBrowserAssetPaths()

function allowedRequestTarget(url: URL) {
  if (url.origin !== expectedBrowserOrigin()) return false
  // Vite serves source modules and opens an HMR socket in the local Playwright
  // lane. The production build and workers.dev proof retain the strict route
  // allowlist below; local traffic is still rejected when it carries source
  // evidence, a request body, or a non-read method.
  if (isLocalDevBrowser()) return true
  const routeAllowed =
    url.pathname === '/' ||
    url.pathname === '/research/studio' ||
    url.pathname === '/research/studio/'
  const assetAllowed = frozenAssetPaths?.has(url.pathname) === true
  if (!routeAllowed && !assetAllowed) return false
  if (!url.search) return true
  return (
    browserProofContext !== undefined &&
    routeAllowed &&
    (url.pathname === '/research/studio' ||
      url.pathname === '/research/studio/') &&
    url.searchParams.size === 1 &&
    url.searchParams.get('rucksack-run') === browserProofContext.runNonce
  )
}

function observeSourceBearingRequests(
  page: Page,
  additionalMarkers: string[] = [],
) {
  const markers = sourceEvidenceMarkers(additionalMarkers)
  const requests: Array<{ method: string; origin: string }> = []
  page.on('request', (request) => {
    const rawUrl = request.url()
    const url = new URL(rawUrl)
    const decodedUrl = fullyDecoded(rawUrl)
    const headers = Object.values(request.headers()).join('\n')
    const hasSourceMarker = markers.some(
      (marker) =>
        rawUrl.includes(marker) ||
        decodedUrl.includes(marker) ||
        headers.includes(marker),
    )
    const methodAllowed = ['GET', 'HEAD'].includes(request.method())
    const bodyAbsent = !request.postDataBuffer()?.byteLength
    const targetAllowed =
      url.protocol === 'blob:'
        ? url.origin === expectedBrowserOrigin()
        : ['http:', 'https:'].includes(url.protocol) &&
          allowedRequestTarget(url)
    if (!targetAllowed || !methodAllowed || !bodyAbsent || hasSourceMarker) {
      requests.push({
        method: request.method(),
        origin: url.origin,
      })
    }
  })
  page.on('websocket', (socket) => {
    const socketUrl = new URL(socket.url())
    const expectedOrigin = new URL(expectedBrowserOrigin())
    if (
      isLocalDevBrowser() &&
      socketUrl.hostname === expectedOrigin.hostname &&
      socketUrl.port === expectedOrigin.port
    ) {
      return
    }
    requests.push({
      method: 'WEBSOCKET',
      origin: socketUrl.origin,
    })
  })
  return requests
}

async function forbidPostUploadNetwork(page: Page) {
  const requests: Array<{ method: string; origin: string }> = []
  if (isLocalDevBrowser()) return requests
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  await page.route(/^https?:\/\//u, async (route) => {
    const request = route.request()
    requests.push({
      method: request.method(),
      origin: new URL(request.url()).origin,
    })
    await route.abort('blockedbyclient')
  })
  return requests
}

function observeSourceBearingLogs(
  page: Page,
  additionalMarkers: string[] = [],
) {
  const markers = sourceEvidenceMarkers(additionalMarkers)
  const matches: string[] = []
  page.on('console', (message) => {
    if (markers.some((marker) => message.text().includes(marker))) {
      matches.push(message.type())
    }
  })
  return matches
}

async function downloadBytes(page: Page, linkName: string) {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: linkName, exact: true }).click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  if (!downloadPath) throw new Error('Browser did not retain the EPUB download')
  try {
    return new Uint8Array(await readFile(downloadPath))
  } finally {
    await download.delete()
  }
}

async function requireEpubCheckPass(bytes: Uint8Array, profileId: string) {
  const directory = await mkdtemp(join(tmpdir(), 'srt-browser-epubcheck-'))
  const epubPath = join(directory, `${profileId}.epub`)
  try {
    await writeFile(epubPath, bytes, { mode: 0o600 })
    await verifyExecutable(epubcheckJavaBinding)
    await execFileAsync(
      epubcheckJavaBinding.path,
      ['-jar', epubcheck.path, '--failonwarnings', epubPath],
      { timeout: 120_000 },
    )
    await verifyExecutable(epubcheckJavaBinding)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function browserPersistenceState(page: Page) {
  const [browserState, cookies] = await Promise.all([
    page.evaluate(async () => {
      const databaseFactory = indexedDB as IDBFactory & {
        databases?: () => Promise<Array<{ name?: string }>>
      }
      const databaseEnumerationSupported =
        typeof databaseFactory.databases === 'function'
      const databaseNames = databaseEnumerationSupported
        ? (await databaseFactory.databases!()).map(({ name }) => name ?? '')
        : []
      const localStorageEntries = Array.from(
        { length: localStorage.length },
        (_, index) => {
          const key = localStorage.key(index) ?? ''
          return { key, value: localStorage.getItem(key) ?? '' }
        },
      )
      const invalidLocalStorageEntryCount = localStorageEntries.filter(
        ({ key, value }) =>
          !(
            (key === 'theme' &&
              ['theme-light', 'dark', 'system'].includes(value)) ||
            (key === 'siteLang' && ['en', 'zh', 'ko', 'ja'].includes(value))
          ),
      ).length
      return {
        cacheNames: 'caches' in window ? await caches.keys() : [],
        databaseEnumerationSupported,
        databaseNames,
        invalidLocalStorageEntryCount,
        serviceWorkerScopes:
          'serviceWorker' in navigator
            ? (await navigator.serviceWorker.getRegistrations()).map(
                ({ scope }) => scope,
              )
            : [],
        sessionStorageLength: sessionStorage.length,
      }
    }),
    page.context().cookies(),
  ])
  const markers = sourceEvidenceMarkers()
  return {
    ...browserState,
    cookieCount: cookies.length,
    sourceBearingCookieCount: cookies.filter(({ name, value }) =>
      markers.some((marker) => name.includes(marker) || value.includes(marker)),
    ).length,
  }
}

const emptyBrowserPersistence = {
  cacheNames: [],
  cookieCount: 0,
  databaseEnumerationSupported: true,
  databaseNames: [],
  invalidLocalStorageEntryCount: 0,
  serviceWorkerScopes: [],
  sourceBearingCookieCount: 0,
  sessionStorageLength: 0,
}

test('blocks encoded source bytes sent to an allowlisted static asset', async ({
  page,
}) => {
  test.skip(
    isLocalDevBrowser(),
    'Local Vite requests are intentionally dynamic',
  )
  await page.goto(studioPath())
  await waitForImporter(page)
  const allowedAsset = [...(frozenAssetPaths ?? [])].find((candidate) =>
    candidate.startsWith('/_astro/'),
  )
  expect(allowedAsset).toBeDefined()
  const violations = await forbidPostUploadNetwork(page)
  const encoded = fixtureBytes.subarray(0, 18).toString('base64url')
  await page.evaluate(
    async ({ pathname, source }) => {
      await fetch(pathname, { headers: { 'X-Leak': source } }).catch(
        () => undefined,
      )
    },
    { pathname: allowedAsset!, source: encoded },
  )
  await expect.poll(() => violations.length).toBe(1)
  expect(violations[0]).toEqual({
    method: 'GET',
    origin: expectedBrowserOrigin(),
  })
})

test('uploads once and previews the matching Mobile, Move, and Pro EPUB artifacts without overflow', async ({
  page,
}) => {
  let downloadCount = 0
  page.on('download', () => {
    downloadCount += 1
  })

  await page.goto(studioPath())
  if (browserProofContext) {
    const observed = new URL(page.url())
    expect(observed.origin).toBe(browserProofContext.origin)
    expect(observed.searchParams.get('rucksack-run')).toBe(
      browserProofContext.runNonce,
    )
    browserProof.deployment = {
      exactHead: browserProofContext.exactHead,
      workerName: browserProofContext.workerName,
      workerVersionId: browserProofContext.workerVersionId,
      runNonce: browserProofContext.runNonce,
      observedOrigin: observed.origin,
    }
  }
  await waitForImporter(page)
  const sourceBearingRequests = observeSourceBearingRequests(page)
  const sourceBearingLogs = observeSourceBearingLogs(page)
  const postUploadRequests = await forbidPostUploadNetwork(page)
  await page.locator('#publication-pdf').setInputFiles(fixture)
  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  })
  await expect(page.getByText('Review required', { exact: true })).toHaveCount(
    0,
  )
  await waitForMaterializedEpub(page)

  const downloaded: Array<{
    profileId: string
    hash: string
    manifest: {
      canonicalContentSha256: string
      canonicalNodeIds: string[]
      sourcePdfSha256: string
      sourceCompleteness: {
        textCoverage: number
        assetCoverage: number
        relationshipCoverage: number
        expectedRelationshipCount: number
        resolvedRelationshipCount: number
        expectedSemanticTableCount: number
        resolvedSemanticTableCount: number
        semanticTableCoverage: number
        unresolvedObjectCount: number
        unresolvedObjects: {
          assets: number
          captions: number
          citations: number
          equations: number
          footnoteReferences: number
          footnotes: number
          tables: number
        }
        ocrRequiredPages: number[]
        readingOrderDiagnostics: number
        unresolvedCorruptingJoinCount: number
      }
      sourceReadiness: {
        status: 'ready' | 'review-required'
        ready: boolean
        blockingDiagnosticCodes: string[]
      }
      visualRelationships: Array<{
        kind: string
        canonicalNodeId: string
        captionNodeId: string
      }>
      assets: Array<{ id: string; href: string; sha256: string }>
      profile: { id: string; version: string }
    }
  }> = []
  let previousPreviewHash: string | null = null

  for (const expected of contract.profiles) {
    const ui = profileUi[expected.id as keyof typeof profileUi]
    const switcher = page.locator('.epub-device-switcher')
    const button = switcher.getByText(ui.label, { exact: true }).locator('..')
    const downloadsBeforeSwitch = downloadCount
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(button).toHaveAttribute('data-profile-id', expected.id)
    await expect(button).toHaveAttribute(
      'data-profile-version',
      expected.version,
    )
    expect(downloadCount).toBe(downloadsBeforeSwitch)

    const preview = page.locator('.epub-rendition-preview')
    await expect(preview).toHaveAttribute('data-profile-id', expected.id)
    await expect(preview).toHaveAttribute(
      'data-profile-version',
      expected.version,
    )
    await expect(preview).toHaveAttribute(
      'data-artifact-sha256',
      /^[a-f0-9]{64}$/,
      { timeout: 90_000 },
    )
    const previewHash = await preview.getAttribute('data-artifact-sha256')
    expect(previewHash).toMatch(/^[a-f0-9]{64}$/)
    if (previousPreviewHash) expect(previewHash).not.toBe(previousPreviewHash)
    previousPreviewHash = previewHash
    const receipt = page.getByLabel('Selected EPUB artifact receipt')
    await expect(receipt).toContainText(`${expected.id}@${expected.version}`)
    await expect(
      receipt.locator('[data-truth-authority="authoritative"]'),
    ).toHaveCount(expected.id === 'mobile' ? 1 : 2)
    await expect(
      receipt.locator('[data-truth-authority="advisory"]'),
    ).toHaveCount(expected.id === 'mobile' ? 2 : 1)
    await expect(
      receipt.locator('[data-truth-authority="reader-controlled"]'),
    ).toHaveCount(2)

    const device = page.locator(
      `.epub-preview-device[data-device="${expected.id}"]`,
    )
    await expect(device).toBeVisible()
    const deviceBox = await device.boundingBox()
    expect(deviceBox).not.toBeNull()
    if (expected.height !== null && deviceBox) {
      expect(deviceBox.width / deviceBox.height).toBeCloseTo(
        expected.width / expected.height,
        2,
      )
      expect(deviceBox.width).toBeLessThanOrEqual(
        expected.previewWidthCssPx + 1,
      )
    }
    expect(
      await device.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true)

    const frame = page
      .getByTitle(`Generated EPUB rendition on ${ui.label}`)
      .contentFrame()
    await expect(frame.locator('main')).toBeVisible()
    const geometry = await frame.locator('main').evaluate((main) => {
      const style = getComputedStyle(main)
      return {
        viewportWidth: document.documentElement.clientWidth,
        mainWidth: main.getBoundingClientRect().width,
        bodyPadding: getComputedStyle(document.body).padding,
        paddingTop: Number.parseFloat(style.paddingTop),
        paddingRight: Number.parseFloat(style.paddingRight),
        paddingBottom: Number.parseFloat(style.paddingBottom),
        paddingLeft: Number.parseFloat(style.paddingLeft),
      }
    })
    expect(geometry.mainWidth).toBeCloseTo(geometry.viewportWidth, 0)
    expect(geometry.bodyPadding).toBe('0px')
    expect(geometry.paddingTop / geometry.viewportWidth).toBeCloseTo(
      expected.margins.top / expected.width,
      3,
    )
    expect(geometry.paddingRight / geometry.viewportWidth).toBeCloseTo(
      expected.margins.right / expected.width,
      3,
    )
    expect(geometry.paddingBottom / geometry.viewportWidth).toBeCloseTo(
      expected.margins.bottom / expected.width,
      3,
    )
    expect(geometry.paddingLeft / geometry.viewportWidth).toBeCloseTo(
      expected.margins.left / expected.width,
      3,
    )
    await expect(frame.getByText(contract.title, { exact: true })).toHaveCount(
      1,
    )
    for (const span of contract.canonicalSpans) {
      await expect(frame.getByText(span.text, { exact: true })).toHaveCount(1)
    }
    for (const heading of contract.headings) {
      const renderedLevel = Math.min(3, heading.level + 1)
      await expect(
        frame.locator(`h${renderedLevel}`, {
          hasText: new RegExp(
            `^${heading.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          ),
        }),
      ).toHaveCount(1)
    }
    const previewListItems = await frame
      .locator('.publication-list-item')
      .evaluateAll((items) =>
        items.map((item) => ({
          text: [...item.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent ?? '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
          level: Number(item.getAttribute('data-list-level')),
          ordered: item.parentElement?.tagName === 'OL',
        })),
      )
    expect(previewListItems).toEqual([
      ...contract.listItems.map(({ text, level, ordered }) => ({
        text,
        level,
        ordered,
      })),
      ...contract.references.map((text) => ({
        text,
        level: 1,
        ordered: true,
      })),
    ])
    await expect(frame.locator('strong', { hasText: /^bold$/ })).toHaveCount(1)
    await expect(frame.locator('em', { hasText: /^italic$/ })).toHaveCount(1)
    await expect(
      frame.locator('strong > em', { hasText: /^combined$/ }),
    ).toHaveCount(1)
    const expectedSafeLink = contract.inlineSemantics.find(
      (semantic) => semantic.href,
    )
    if (!expectedSafeLink?.href) {
      throw new Error('Safe-link contract is incomplete')
    }
    const safeLink = frame.locator(
      `a[role="link"][data-original-href="${expectedSafeLink.href}"] > em`,
      { hasText: /^safe link$/ },
    )
    await expect(safeLink).toHaveCount(1)
    await expect(safeLink.locator('..')).not.toHaveAttribute('href')
    await expect(safeLink.locator('..')).toHaveAttribute('tabindex', '0')
    await expect(frame.locator('sub', { hasText: /^2$/ })).toHaveCount(1)
    await expect(
      frame.locator('a[epub\\:type="noteref"] > sup', { hasText: /^1$/ }),
    ).toHaveCount(1)
    const note = frame.locator('aside[role="doc-footnote"]')
    await expect(note).toContainText(contract.note.text)
    const noteBacklink = note.locator('.note-backlink')
    await expect(noteBacklink).toHaveAttribute('href', /^#.+/)
    for (const visual of contract.visuals) {
      await expect(
        frame.locator(`figure[data-object-type="${visual.kind}"]`),
      ).toHaveCount(1)
      await expect(
        frame.getByText(visual.caption, { exact: true }),
      ).toHaveCount(1)
    }
    await expect(frame.locator('.figure-placeholder')).toHaveCount(0)
    const tableContract = contract.visuals.find(
      (visual) => visual.kind === 'table',
    )
    if (!tableContract?.rows) throw new Error('Table contract is incomplete')
    const table = frame.locator('table')
    await expect(table).toHaveCount(1)
    await expect(table.locator('thead tr')).toHaveCount(1)
    await expect(table.locator('tbody tr')).toHaveCount(
      tableContract.rows.length - 1,
    )
    expect(
      await table
        .locator('tr')
        .evaluateAll((rows) =>
          rows.map((row) =>
            [...row.querySelectorAll('th, td')].map(
              (cell) => cell.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            ),
          ),
        ),
    ).toEqual(tableContract.rows)
    expect(
      await table.locator('thead th').evaluateAll((cells) =>
        cells.map((cell) => ({
          text: cell.textContent?.trim(),
          scope: cell.getAttribute('scope'),
        })),
      ),
    ).toEqual(tableContract.rows[0].map((text) => ({ text, scope: 'col' })))
    await expect(table.locator('tbody th')).toHaveCount(0)
    await expect(frame.locator('img')).not.toHaveCount(0)
    expect(
      await frame.locator('img').evaluateAll((images) =>
        images.every((image) => {
          const imageBox = image.getBoundingClientRect()
          const containerBox =
            image.parentElement?.getBoundingClientRect() ??
            image.closest('main')?.getBoundingClientRect()
          return (
            imageBox.width > 0 &&
            imageBox.height > 0 &&
            (!containerBox || imageBox.width <= containerBox.width + 1)
          )
        }),
      ),
    ).toBe(true)
    const previewImageSources = await frame
      .locator('img')
      .evaluateAll((images) =>
        images.map((image) => {
          if (!(image instanceof HTMLImageElement)) {
            throw new Error('Preview image is not an HTML image element')
          }
          return image.currentSrc || image.src
        }),
      )
    expect(
      previewImageSources.every((source) => source.startsWith('blob:')),
    ).toBe(true)
    const previewImageSha256s = await page.evaluate(
      async (sources: string[]) =>
        await Promise.all(
          sources.map(async (source) => {
            const response = await fetch(source)
            if (!response.ok) throw new Error('Preview image bytes unavailable')
            const digest = await crypto.subtle.digest(
              'SHA-256',
              await response.arrayBuffer(),
            )
            return [...new Uint8Array(digest)]
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join('')
          }),
        ),
      previewImageSources,
    )
    expect(
      await frame
        .locator('[data-wide-source-visual="true"]')
        .evaluateAll((visuals) =>
          visuals.every(
            (visual) => visual.scrollWidth <= visual.clientWidth + 1,
          ),
        ),
    ).toBe(true)
    await expect(frame.locator('main')).not.toContainText('discre-tionary')
    await expect(
      frame.locator('main p').filter({ hasText: /^\s*[A-Za-z]\s*$/ }),
    ).toHaveCount(0)
    expect(
      await frame
        .locator('html')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true)
    expect(
      await frame.locator('main').evaluate((main) => {
        const probe = document.createElement('h3')
        probe.textContent = 'W'.repeat(256)
        main.append(probe)
        const fits =
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1
        probe.remove()
        return fits
      }),
    ).toBe(true)

    const previewCanonicalIds = await frame
      .locator('[data-canonical-id]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-canonical-id')),
      )
    expect(new Set(previewCanonicalIds).size).toBe(previewCanonicalIds.length)

    const link = page.getByRole('link', { name: ui.download, exact: true })
    await expect(link).toHaveAttribute('data-profile-id', expected.id)
    await expect(link).toHaveAttribute('data-profile-version', expected.version)
    await expect(link).toHaveAttribute('data-artifact-sha256', previewHash!)
    const bytes = await downloadBytes(page, ui.download)
    const downloadedHash = createHash('sha256').update(bytes).digest('hex')
    expect(downloadedHash).toBe(previewHash)
    await requireEpubCheckPass(bytes, expected.id)
    const files = unzipSync(bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toContain('class="semantic-table-wrapper"')
    expect(content).toContain('<thead>')
    expect(content).toContain('<tbody>')
    const downloadedTable = await page.evaluate((xhtml) => {
      const document = new DOMParser().parseFromString(
        xhtml,
        'application/xhtml+xml',
      )
      const parserError = document.querySelector('parsererror')
      if (parserError) throw new Error(parserError.textContent ?? 'Invalid XML')
      const table = document.querySelector('table')
      if (!table) throw new Error('Downloaded EPUB has no semantic table')
      return {
        headers: [...table.querySelectorAll('thead th')].map((cell) => ({
          scope: cell.getAttribute('scope'),
          text: cell.textContent,
        })),
        rows: [...table.querySelectorAll('tbody tr')].map((row) =>
          [...row.querySelectorAll('td')].map((cell) => cell.textContent),
        ),
      }
    }, content)
    expect(downloadedTable.headers).toEqual(
      tableContract.rows[0].map((cell) => ({ scope: 'col', text: cell })),
    )
    expect(downloadedTable.rows).toEqual(tableContract.rows.slice(1))
    expect(content).toContain('<strong>bold</strong>')
    expect(content).toContain('<em>italic</em>')
    expect(content).toContain('<strong><em>combined</em></strong>')
    expect(content).toContain(
      '<a href="https://example.com/fidelity-evidence"><em>safe link</em></a>',
    )
    expect(content).toContain('<sub>2</sub>')
    expect(content).toMatch(
      /<a\b[^>]*epub:type="noteref"[^>]*><sup>1<\/sup><\/a>/,
    )
    expect(content).not.toContain('<object')
    const manifest = JSON.parse(
      strFromU8(files['EPUB/export.json']),
    ) as (typeof downloaded)[number]['manifest']
    expect(manifest.profile).toMatchObject({
      id: expected.id,
      version: expected.version,
    })
    expect(manifest.sourcePdfSha256).toBe(contract.sourceSha256)
    expect(manifest.sourceReadiness).toMatchObject({
      status: 'ready',
      ready: true,
      blockingDiagnosticCodes: [],
    })
    expect(manifest.sourceCompleteness).toMatchObject({
      assetCoverage: 1,
      relationshipCoverage: 1,
      semanticTableCoverage: 1,
      unresolvedObjectCount: 0,
      unresolvedObjects: {
        assets: 0,
        captions: 0,
        citations: 0,
        equations: 0,
        footnoteReferences: 0,
        footnotes: 0,
        tables: 0,
      },
      ocrRequiredPages: [],
      readingOrderDiagnostics: 0,
      unresolvedCorruptingJoinCount: 0,
    })
    expect(manifest.sourceCompleteness.textCoverage).toBeGreaterThan(0.99)
    expect(manifest.sourceCompleteness.expectedRelationshipCount).toBe(
      manifest.sourceCompleteness.resolvedRelationshipCount,
    )
    expect(
      manifest.sourceCompleteness.expectedRelationshipCount,
    ).toBeGreaterThan(contract.visuals.length)
    expect(manifest.sourceCompleteness.expectedSemanticTableCount).toBe(1)
    expect(manifest.sourceCompleteness.resolvedSemanticTableCount).toBe(1)
    expect(previewCanonicalIds).toEqual(manifest.canonicalNodeIds)
    const verifiedAssetHashes = manifest.assets.map((asset) => {
      const assetBytes = files[`EPUB/${asset.href}`]
      expect(assetBytes).toBeTruthy()
      const computed = createHash('sha256').update(assetBytes).digest('hex')
      expect(computed).toBe(asset.sha256)
      return computed
    })
    expect(new Set(previewImageSha256s).size).toBe(previewImageSha256s.length)
    for (const previewImageSha256 of previewImageSha256s) {
      expect(verifiedAssetHashes).toContain(previewImageSha256)
    }
    downloaded.push({
      profileId: expected.id,
      hash: downloadedHash,
      manifest,
    })
  }

  expect(downloadCount).toBe(contract.profiles.length)
  expect(new Set(downloaded.map(({ hash }) => hash)).size).toBe(
    contract.profiles.length,
  )
  const canonicalGraphs = downloaded.map(({ manifest }) => ({
    canonicalContentSha256: manifest.canonicalContentSha256,
    canonicalNodeIds: manifest.canonicalNodeIds,
    visualRelationships: manifest.visualRelationships.map(
      ({ kind, canonicalNodeId, captionNodeId }) => ({
        kind,
        canonicalNodeId,
        captionNodeId,
      }),
    ),
  }))
  expect(canonicalGraphs).toEqual([
    canonicalGraphs[0],
    canonicalGraphs[0],
    canonicalGraphs[0],
  ])
  browserProof.profiles = downloaded.map(({ hash, manifest, profileId }) => ({
    profileId,
    profileVersion: manifest.profile.version,
    artifactSha256: hash,
    canonicalGraphSha256: sha256Json({
      canonicalContentSha256: manifest.canonicalContentSha256,
      canonicalNodeIds: manifest.canonicalNodeIds,
    }),
    canonicalNodeCount: manifest.canonicalNodeIds.length,
    assetIndexSha256: sha256Json(manifest.assets),
    assetCount: manifest.assets.length,
    visualRelationshipIndexSha256: sha256Json(manifest.visualRelationships),
    visualRelationshipCount: manifest.visualRelationships.length,
    internalValidation: 'passed',
    epubCheck: {
      status: 'passed',
      version: EPUBCHECK_VERSION,
      jarSha256: EPUBCHECK_JAR_SHA256,
      failOnWarnings: true,
      warningCount: 0,
      errorCount: 0,
      skipCount: 0,
    },
  }))
  const completeness = downloaded[0].manifest.sourceCompleteness
  browserProof.semanticCompleteness = {
    textCoverage: completeness.textCoverage,
    prose: contract.canonicalSpans.length,
    sections: contract.headings.length,
    lists: contract.listItems.length,
    notes: 1,
    referencesOrCitations: contract.references.length,
    figures: contract.visuals.filter(({ kind }) => kind === 'figure').length,
    captions: contract.visuals.length,
    tables: contract.visuals.filter(({ kind }) => kind === 'table').length,
    equations: contract.visuals.filter(({ kind }) => kind === 'equation')
      .length,
    unresolvedObjectCount: 0,
    unresolvedObjects: completeness.unresolvedObjects,
    unresolvedObjectsSha256: sha256Json(completeness.unresolvedObjects),
    ocrRequiredPageCount: completeness.ocrRequiredPages.length,
    readingOrderDiagnosticCount: completeness.readingOrderDiagnostics,
    unresolvedCorruptingJoinCount: completeness.unresolvedCorruptingJoinCount,
  }

  // Keep both e-ink frames on one physical scale even when the viewport is
  // narrower than Paper Pro. The stage may scroll; the page itself may not.
  await page.setViewportSize({ width: 360, height: 900 })
  const moveProfile = contract.profiles.find(
    (profile) => profile.id === 'paperProMove',
  )!
  const proProfile = contract.profiles.find(
    (profile) => profile.id === 'paperPro',
  )!
  const frameWidths: Record<'paperProMove' | 'paperPro', number> = {
    paperProMove: 0,
    paperPro: 0,
  }
  for (const profileId of ['paperProMove', 'paperPro'] as const) {
    const ui = profileUi[profileId]
    await page
      .locator('.epub-device-switcher')
      .getByText(ui.label, { exact: true })
      .locator('..')
      .click()
    const device = page.locator(
      `.epub-preview-device[data-device="${profileId}"]`,
    )
    const box = await device.boundingBox()
    expect(box).not.toBeNull()
    frameWidths[profileId] = box!.width
    expect(box!.width).toBeCloseTo(
      contract.profiles.find((profile) => profile.id === profileId)!
        .previewWidthCssPx,
      0,
    )
  }
  expect(frameWidths.paperProMove / frameWidths.paperPro).toBeCloseTo(
    moveProfile.width /
      moveProfile.pixelsPerInch! /
      (proProfile.width / proProfile.pixelsPerInch!),
    2,
  )
  const narrowStage = page.locator('.epub-preview-stage')
  await expect(narrowStage).toHaveAttribute('tabindex', '0')
  await expect(narrowStage).toHaveAccessibleName(
    'Scrollable Paper Pro EPUB viewport',
  )
  const [stageBox, proBox] = await Promise.all([
    narrowStage.boundingBox(),
    page.locator('.epub-preview-device[data-device="paperPro"]').boundingBox(),
  ])
  expect(stageBox).not.toBeNull()
  expect(proBox).not.toBeNull()
  expect(proBox!.x).toBeGreaterThanOrEqual(stageBox!.x - 1)
  expect(
    await narrowStage.evaluate(
      (stage) => stage.scrollWidth > stage.clientWidth,
    ),
  ).toBe(true)
  expect(
    await page
      .locator('html')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true)
  expect(sourceBearingRequests).toEqual([])
  expect(sourceBearingLogs).toEqual([])
  expect(postUploadRequests).toEqual([])
  browserProof.sourceBearingRequestCount = 0
  browserProof.sourceBearingLogCount = 0
})

test('downloads a source-preserved scan fallback without post-upload network access', async ({
  page,
}) => {
  await page.goto(studioPath())
  await waitForImporter(page)
  const postUploadRequests = await forbidPostUploadNetwork(page)

  await page.locator('#publication-pdf').setInputFiles(scannedFixture)
  await expect(
    page.locator(
      '.publication-importer[data-conversion-status="review-required"]',
    ),
  ).toBeVisible({ timeout: 90_000 })
  await waitForMaterializedEpub(page)
  const bytes = await downloadBytes(
    page,
    'Download Mobile EPUB review artifact (not publication-ready)',
  )
  const files = unzipSync(bytes)
  const manifest = JSON.parse(strFromU8(files['EPUB/export.json']!)) as {
    exportMode: string
    publicationGrade: boolean
    sourceCompleteness: { ocrRequiredPages: number[] }
    assets: unknown[]
    visualRelationships: Array<{ evidence: string[] }>
  }

  expect(manifest).toMatchObject({
    exportMode: 'readable-fallback',
    publicationGrade: false,
    sourceCompleteness: { ocrRequiredPages: [1] },
  })
  expect(manifest.assets).toHaveLength(1)
  expect(manifest.visualRelationships).toHaveLength(1)
  expect(manifest.visualRelationships[0]!.evidence).toContain(
    'source-preserved-unresolved-page-fallback',
  )
  await requireEpubCheckPass(bytes, 'source-preserved-scan-fallback')
  expect(postUploadRequests).toEqual([])
})

test('exports EPUB 3.3-valid endnotes from the note and citation association fixture', async ({
  page,
}) => {
  await page.goto(studioPath())
  await waitForImporter(page)
  const postUploadRequests = await forbidPostUploadNetwork(page)

  await page
    .locator('#publication-pdf')
    .setInputFiles(noteCitationAssociationsFixture)
  await expect(
    page.locator(
      '.publication-importer[data-conversion-status="review-required"]',
    ),
  ).toBeVisible({ timeout: 90_000 })
  await waitForMaterializedEpub(page)
  const bytes = await downloadBytes(
    page,
    'Download Mobile EPUB review artifact (not publication-ready)',
  )
  const files = unzipSync(bytes)
  const content = strFromU8(files['EPUB/content.xhtml']!)
  const endnoteBodies =
    content.match(
      /<aside\b[^>]*data-note-kind="endnote"[^>]*>[\s\S]*?<\/aside>/gu,
    ) ?? []

  expect(endnoteBodies.length).toBeGreaterThan(0)
  expect(
    endnoteBodies.every(
      (body) =>
        body.includes('epub:type="endnote"') &&
        body.includes('role="doc-footnote"'),
    ),
  ).toBe(true)
  expect(
    endnoteBodies.some((body) => body.includes('class="note-backlink"')),
  ).toBe(true)
  expect(content).not.toContain('role="doc-endnote"')
  await requireEpubCheckPass(bytes, 'note-citation-associations-mobile')
  expect(postUploadRequests).toEqual([])
})

for (const scanVariant of scanVariantFixtures) {
  test(`downloads complete rendered source pages for a ${scanVariant.name}`, async ({
    page,
  }) => {
    await page.goto(studioPath())
    await waitForImporter(page)
    const postUploadRequests = await forbidPostUploadNetwork(page)

    await page
      .locator('#publication-pdf')
      .setInputFiles(
        path.resolve('tests', 'fixtures', 'pdf', scanVariant.fileName),
      )
    await expect(
      page.locator(
        '.publication-importer[data-conversion-status="review-required"]',
      ),
    ).toBeVisible({ timeout: 90_000 })
    await waitForMaterializedEpub(page)
    const bytes = await downloadBytes(
      page,
      'Download Mobile EPUB review artifact (not publication-ready)',
    )
    const files = unzipSync(bytes)
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json']!)) as {
      sourceCompleteness: { ocrRequiredPages: number[] }
      assets: unknown[]
      visualRelationships: Array<{ evidence: string[] }>
    }

    expect(manifest.sourceCompleteness.ocrRequiredPages).toEqual(
      scanVariant.pages,
    )
    expect(manifest.assets.length).toBeGreaterThanOrEqual(
      scanVariant.pages.length,
    )
    const sourcePageRelationships = manifest.visualRelationships.filter(
      (relationship) =>
        relationship.evidence.includes(
          'source-preserved-unresolved-page-fallback',
        ),
    )
    expect(sourcePageRelationships).toHaveLength(scanVariant.pages.length)
    for (const relationship of sourcePageRelationships) {
      expect(relationship.evidence).toContain('pdfjs-complete-page-render-v1')
    }
    if (scanVariant.expectedText) {
      expect(strFromU8(files['EPUB/content.xhtml']!)).toContain(
        scanVariant.expectedText,
      )
    }
    await requireEpubCheckPass(
      bytes,
      scanVariant.fileName.replace(/\.pdf$/u, ''),
    )
    expect(postUploadRequests).toEqual([])
  })
}

test('invalidates preview receipts and object URLs before reusing a filename', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const trackedWindow = window as unknown as Window & {
      __createdFidelityUrls: Array<{ url: string; type: string }>
      __revokedFidelityUrls: string[]
      __createdPublicationWorkers: number
      __terminatedPublicationWorkers: number
    }
    trackedWindow.__createdFidelityUrls = []
    trackedWindow.__revokedFidelityUrls = []
    trackedWindow.__createdPublicationWorkers = 0
    trackedWindow.__terminatedPublicationWorkers = 0
    const createObjectUrl = URL.createObjectURL.bind(URL)
    const revokeObjectUrl = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (object) => {
      const url = createObjectUrl(object)
      trackedWindow.__createdFidelityUrls.push({
        url,
        type: object instanceof Blob ? object.type : '',
      })
      return url
    }
    URL.revokeObjectURL = (url) => {
      trackedWindow.__revokedFidelityUrls.push(url)
      revokeObjectUrl(url)
    }
    const NativeWorker = window.Worker
    const nativeTerminate = NativeWorker.prototype.terminate
    NativeWorker.prototype.terminate = function () {
      trackedWindow.__terminatedPublicationWorkers += 1
      nativeTerminate.call(this)
    }
    window.Worker = new Proxy(NativeWorker, {
      construct(target, argumentsList) {
        trackedWindow.__createdPublicationWorkers += 1
        return Reflect.construct(target, argumentsList)
      },
    })
  })

  const first = await readFile(fixture)
  const second = await readFile(
    path.resolve('tests', 'fixtures', 'pdf', 'born-digital.pdf'),
  )
  const equalLength = Math.max(first.byteLength, second.byteLength)
  const padded = (bytes: Buffer) => {
    const result = Buffer.alloc(equalLength, 0x20)
    bytes.copy(result)
    return result
  }
  const upload = (buffer: Buffer) => ({
    name: 'same-paper.pdf',
    mimeType: 'application/pdf',
    buffer: padded(buffer),
  })

  await page.goto(studioPath())
  await waitForImporter(page)
  const crossRequestMarkers = [
    'same-paper.pdf',
    'A Reconstructed Research Paper',
    'This paragraph contains enough embedded text to prove local PDF extraction.',
    'Bounding boxes remain source evidence while the publication becomes reflowable.',
  ]
  const sourceBearingRequests = observeSourceBearingRequests(
    page,
    crossRequestMarkers,
  )
  const sourceBearingLogs = observeSourceBearingLogs(page, crossRequestMarkers)
  const postUploadRequests = await forbidPostUploadNetwork(page)
  await page.locator('#publication-pdf').setInputFiles(upload(first))
  await expect(page.getByText('EPUB ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  })
  await expect(page.getByText('Review required', { exact: true })).toHaveCount(
    0,
  )
  await waitForMaterializedEpub(page)
  const firstWorkerCounts = await page.evaluate(() => ({
    created: (window as unknown as { __createdPublicationWorkers: number })
      .__createdPublicationWorkers,
    terminated: (
      window as unknown as { __terminatedPublicationWorkers: number }
    ).__terminatedPublicationWorkers,
  }))
  expect(firstWorkerCounts.created).toBeGreaterThan(0)
  expect(firstWorkerCounts.terminated).toBe(firstWorkerCounts.created)

  const firstPreview = page.locator('.epub-rendition-preview')
  const firstHash = await firstPreview.getAttribute('data-artifact-sha256')
  const firstHref = await page
    .getByRole('link', { name: 'Download Mobile EPUB', exact: true })
    .getAttribute('href')
  expect(firstHash).toMatch(/^[a-f0-9]{64}$/)
  expect(firstHref).toMatch(/^blob:/)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tracker = window as Window & {
          __createdFidelityUrls?: Array<{ url: string; type: string }>
        }
        const entries = tracker.__createdFidelityUrls ?? []
        return {
          epub: entries.filter(({ type }) => type === 'application/epub+zip')
            .length,
          images: entries.filter(({ type }) => type.startsWith('image/'))
            .length,
        }
      }),
    )
    .toEqual({
      epub: 1,
      images: contract.visuals.filter((visual) => visual.kind !== 'table')
        .length,
    })
  const firstUrls = await page.evaluate(() =>
    (
      window as Window & {
        __createdFidelityUrls?: Array<{ url: string; type: string }>
      }
    ).__createdFidelityUrls?.map(({ url }) => url),
  )
  expect(firstUrls).toBeDefined()
  expect(firstUrls!.length).toBeGreaterThan(1)

  await page.getByRole('button', { name: 'New paper' }).click()
  await expect(firstPreview).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Download Mobile EPUB', exact: true }),
  ).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(
        (oldHref) =>
          (
            window as Window & {
              __revokedFidelityUrls?: string[]
            }
          ).__revokedFidelityUrls?.filter((url) => url === oldHref).length ?? 0,
        firstHref,
      ),
    )
    .toBe(1)
  await expect
    .poll(() =>
      page.evaluate(
        (urls) =>
          urls.map(
            (url) =>
              (
                window as Window & {
                  __revokedFidelityUrls?: string[]
                }
              ).__revokedFidelityUrls?.filter((candidate) => candidate === url)
                .length ?? 0,
          ),
        firstUrls!,
      ),
    )
    .toEqual(firstUrls!.map(() => 1))

  await page.locator('#publication-pdf').setInputFiles(upload(second))
  await waitForMaterializedEpub(page)
  await expect(page.locator('.publication-result-bar strong')).toHaveText(
    'same-paper.pdf',
  )
  const secondPreview = page.locator('.epub-rendition-preview')
  const secondHash = await secondPreview.getAttribute('data-artifact-sha256')
  const secondHref = await page
    .getByRole('link', { name: 'Download Mobile EPUB', exact: true })
    .getAttribute('href')
  expect(secondHash).toMatch(/^[a-f0-9]{64}$/)
  expect(secondHash).not.toBe(firstHash)
  expect(secondHref).toMatch(/^blob:/)
  expect(secondHref).not.toBe(firstHref)
  expect(
    await page.evaluate(
      (oldHref) =>
        (
          window as Window & { __revokedFidelityUrls?: string[] }
        ).__revokedFidelityUrls?.filter((url) => url === oldHref).length ?? 0,
      firstHref,
    ),
  ).toBe(1)
  const secondBytes = await downloadBytes(page, 'Download Mobile EPUB')
  expect(createHash('sha256').update(secondBytes).digest('hex')).toBe(
    secondHash,
  )
  const secondFiles = unzipSync(secondBytes)
  const secondManifest = JSON.parse(
    strFromU8(secondFiles['EPUB/export.json']),
  ) as { sourcePdfSha256: string; profile: { id: string; version: string } }
  expect(secondManifest).toMatchObject({
    sourcePdfSha256: createHash('sha256').update(padded(second)).digest('hex'),
    profile: {
      id: 'mobile',
      version: contract.profiles.find(({ id }) => id === 'mobile')!.version,
    },
  })
  const secondContent = strFromU8(secondFiles['EPUB/content.xhtml'])
  expect(secondContent).not.toContain(contract.title)
  const secondWorkerCounts = await page.evaluate(() => ({
    created: (window as unknown as { __createdPublicationWorkers: number })
      .__createdPublicationWorkers,
    terminated: (
      window as unknown as { __terminatedPublicationWorkers: number }
    ).__terminatedPublicationWorkers,
  }))
  expect(secondWorkerCounts.created).toBeGreaterThan(firstWorkerCounts.created)
  expect(secondWorkerCounts.terminated).toBe(secondWorkerCounts.created)
  const allUrls = await page.evaluate(() =>
    (
      window as Window & {
        __createdFidelityUrls?: Array<{ url: string; type: string }>
      }
    ).__createdFidelityUrls?.map(({ url }) => url),
  )
  expect(allUrls).toBeDefined()
  await page.getByRole('button', { name: 'New paper' }).click()
  await expect
    .poll(() =>
      page.evaluate(
        (urls) =>
          urls.map(
            (url) =>
              (
                window as Window & { __revokedFidelityUrls?: string[] }
              ).__revokedFidelityUrls?.filter((candidate) => candidate === url)
                .length ?? 0,
          ),
        allUrls!,
      ),
    )
    .toEqual(allUrls!.map(() => 1))
  expect(await browserPersistenceState(page)).toEqual(emptyBrowserPersistence)
  browserProof.crossRequestIsolation = 'passed'
  browserProof.objectUrlCleanup = 'passed'
  browserProof.retainedSourceMarkerCount = 0
  expect(sourceBearingRequests).toEqual([])
  expect(sourceBearingLogs).toEqual([])
  expect(postUploadRequests).toEqual([])
  await expect(
    page
      .getByTitle('Generated EPUB rendition on Mobile')
      .contentFrame()
      .getByText(contract.title, { exact: true }),
  ).toHaveCount(0)
})

test('rejects oversized and malformed browser uploads without sending or retaining source bytes', async ({
  page,
}) => {
  const negativeSourceMarkers = [
    'This is not a PDF.',
    'oversized-input.pdf',
    'malformed.pdf',
    'corrupt-header.pdf',
  ]
  await page.goto(studioPath())
  await waitForImporter(page)
  const sourceBearingRequests = observeSourceBearingRequests(
    page,
    negativeSourceMarkers,
  )
  const sourceBearingLogs = observeSourceBearingLogs(
    page,
    negativeSourceMarkers,
  )
  const postUploadRequests = await forbidPostUploadNetwork(page)
  await page.evaluate((maximumBytes) => {
    const trackedWindow = window as unknown as Window & {
      __oversizedPdfReadCount: number
    }
    trackedWindow.__oversizedPdfReadCount = 0
    const file = new File(['%PDF-1.4\n'], 'oversized-input.pdf', {
      type: 'application/pdf',
      lastModified: 0,
    })
    Object.defineProperty(file, 'size', {
      configurable: true,
      value: maximumBytes + 1,
    })
    file.arrayBuffer = async () => {
      trackedWindow.__oversizedPdfReadCount += 1
      throw new Error('Oversized source bytes were read')
    }
    const input = document.querySelector<HTMLInputElement>('#publication-pdf')
    if (!input) throw new Error('PDF input is unavailable')
    const transfer = new DataTransfer()
    transfer.items.add(file)
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, MAX_LOCAL_PDF_BYTES)

  const oversizedAlert = page.getByRole('alert')
  await expect(oversizedAlert).toContainText('OVERSIZED PDF')
  await expect(oversizedAlert).toContainText('No document bytes were read')
  expect(
    await page.evaluate(
      () =>
        (window as unknown as Window & { __oversizedPdfReadCount: number })
          .__oversizedPdfReadCount,
    ),
  ).toBe(0)

  await page.getByRole('button', { name: 'Choose another paper' }).click()
  await page.locator('#publication-pdf').setInputFiles({
    name: 'malformed.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('This is not a PDF.'),
  })
  const malformedAlert = page.getByRole('alert')
  await expect(malformedAlert).toContainText('INVALID PDF')
  await expect(malformedAlert).toContainText('not a PDF')

  await page.getByRole('button', { name: 'Choose another paper' }).click()
  await page.locator('#publication-pdf').setInputFiles({
    name: 'corrupt-header.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(
      '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
    ),
  })
  const corruptAlert = page.getByRole('alert')
  await expect(corruptAlert).toContainText(
    /INVALID PDF|EMPTY PDF|PDF PARSE FAILED/u,
    { timeout: 30_000 },
  )
  await expect(page.getByText('EPUB ready', { exact: true })).toHaveCount(0)
  expect(sourceBearingRequests).toEqual([])
  expect(sourceBearingLogs).toEqual([])
  expect(postUploadRequests).toEqual([])
  expect(await browserPersistenceState(page)).toEqual(emptyBrowserPersistence)
  browserProof.negativeInputs = 'passed'
  browserProof.retainedSourceMarkerCount = 0
  await writeBrowserReceipt()
})
