import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { chromium, type Browser } from 'playwright'
import {
  CLOSED_RECONSTRUCTION_PROFILE_IDS,
  type ClosedReconstructionProfileId,
  type ProfiledStructEpubArtifact,
} from './reconstruction-materialization'
import {
  hashTraceValue,
  type HashedArtifact,
} from './reconstruction-attempt-trace'
import { sha256HexSync } from './sha256-sync'
import { resolveTargetProfile } from './targets'

export const ACTUAL_PROFILED_EPUB_SCHEMA_VERSION = '1.0.0' as const
export const PINNED_EPUBCHECK_TOOL_VERSION = '5.3.0' as const
export const PINNED_EPUBCHECK_JAR_SHA256 =
  'f7f96617c929371821609b88c8484d6dc9f24fe916499863c46094c5fb778a65' as const

export type ActualProfiledEpubRender = {
  schemaVersion: typeof ACTUAL_PROFILED_EPUB_SCHEMA_VERSION
  profileId: ClosedReconstructionProfileId
  epub: HashedArtifact
  renderer: {
    id: 'playwright-chromium'
    packageVersion: string
    browserVersion: string
    executableSha256: string
  }
  viewport: { width: number; height: number; deviceScaleFactor: number }
  dom: HashedArtifact
  domBytes: Uint8Array
  anchors: string[]
  screenshot: HashedArtifact
  screenshotBytes: Uint8Array
  screenshotDimensions: { width: number; height: number }
  locators: Array<{
    anchorId: string
    rect: { x: number; y: number; width: number; height: number }
  }>
  metrics: {
    scrollWidth: number
    clientWidth: number
    scrollHeight: number
    clientHeight: number
    clippedElementCount: number
    horizontalOverflow: boolean
  }
  blockFacts: Array<{
    blockId: string
    tagName: string
    text: string
    cells: Array<{
      id: string
      tagName: string
      text: string
      rowSpan: number
      columnSpan: number
      scope: string | null
    }>
    images: Array<{
      src: string
      complete: boolean
      naturalWidth: number
      naturalHeight: number
    }>
    links: Array<{ href: string }>
  }>
  status: 'rendered'
  receiptSha256: string
}

export type EpubCheckExecution = {
  toolId: 'epubcheck'
  toolVersion: string
  authority: 'pinned-java-jar' | 'test-only-injected'
  javaExecutableSha256: string | null
  executableSha256: string
  exitCode: number
  reportBytes: Uint8Array
  errorCount: number
  warningCount: number
}

export type EpubCheckReceipt = {
  schemaVersion: typeof ACTUAL_PROFILED_EPUB_SCHEMA_VERSION
  epub: HashedArtifact
  toolId: 'epubcheck'
  toolVersion: string
  authority: 'pinned-java-jar' | 'test-only-injected'
  javaExecutableSha256: string | null
  executableSha256: string
  report: HashedArtifact
  errorCount: 0
  warningCount: 0
  status: 'passed'
  receiptSha256: string
}

function artifact(bytes: Uint8Array): HashedArtifact {
  return { sha256: sha256HexSync(bytes), byteLength: bytes.byteLength }
}

function contentType(path: string) {
  if (path.endsWith('.xhtml')) return 'application/xhtml+xml; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}

async function withEpubServer<T>(
  files: Record<string, Uint8Array>,
  run: (origin: string) => Promise<T>,
) {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(
      (request.url ?? '/').split('?')[0]!,
    ).replace(/^\/+/, '')
    const bytes = files[path]
    if (!bytes || path.includes('..') || path.includes('\\')) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'content-type': contentType(path),
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(bytes)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('EPUB_RENDER_LOOPBACK_SERVER_FAILED')
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

function renderProjection(
  render: Omit<
    ActualProfiledEpubRender,
    'domBytes' | 'screenshotBytes' | 'receiptSha256'
  >,
) {
  return render
}

export function verifyActualProfiledEpubRender(
  render: ActualProfiledEpubRender,
) {
  const { domBytes, screenshotBytes, receiptSha256, ...projection } = render
  const dimensions =
    screenshotBytes.byteLength >= 24
      ? {
          width: Buffer.from(screenshotBytes).readUInt32BE(16),
          height: Buffer.from(screenshotBytes).readUInt32BE(20),
        }
      : null
  if (
    hashTraceValue(render.dom) !== hashTraceValue(artifact(domBytes)) ||
    hashTraceValue(render.screenshot) !==
      hashTraceValue(artifact(screenshotBytes)) ||
    !dimensions ||
    hashTraceValue(dimensions) !==
      hashTraceValue(render.screenshotDimensions) ||
    receiptSha256 !== hashTraceValue(projection) ||
    new Set(render.anchors).size !== render.anchors.length ||
    hashTraceValue(render.anchors) !==
      hashTraceValue([...render.anchors].sort())
  ) {
    throw new Error('INVALID_ACTUAL_PROFILED_EPUB_RENDER_RECEIPT')
  }
}

async function renderOne(browser: Browser, build: ProfiledStructEpubArtifact) {
  const profile = resolveTargetProfile(build.profileId)
  const width = profile.preview.widthCssPx
  const height =
    profile.preview.heightCssPx ?? profile.preview.continuousWindowHeightCssPx
  if (!height) throw new Error('INVALID_PROFILE_RENDER_VIEWPORT')
  const viewport = { width, height, deviceScaleFactor: 1 }
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(build.bytes)
  } catch {
    throw new Error('PROFILED_EPUB_REOPEN_FAILED')
  }
  const content = files['EPUB/content.xhtml']
  if (!content) throw new Error('PROFILED_EPUB_CONTENT_MISSING')
  return withEpubServer(files, async (origin) => {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
    const failures: string[] = []
    page.on('requestfailed', (request) =>
      failures.push(
        `${request.url()}:${request.failure()?.errorText ?? 'failed'}`,
      ),
    )
    try {
      const response = await page.goto(`${origin}/EPUB/content.xhtml`, {
        waitUntil: 'networkidle',
      })
      if (!response?.ok() || failures.length > 0) {
        throw new Error('PROFILED_EPUB_RENDER_RESOURCE_FAILURE')
      }
      await page.evaluate(() => document.fonts.ready)
      const captured = await page.evaluate(() => {
        const root = document.documentElement
        const anchors = [...document.querySelectorAll<HTMLElement>('[id]')]
          .map(({ id }) => id)
          .filter(Boolean)
          .sort()
        const locators = anchors.flatMap((anchorId) => {
          const element = document.getElementById(anchorId)
          if (!element) return []
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
            ? [
                {
                  anchorId,
                  rect: {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                  },
                },
              ]
            : []
        })
        const clippedElementCount = [
          ...document.body.querySelectorAll('*'),
        ].filter((element) => {
          const html = element as HTMLElement
          const style = getComputedStyle(html)
          return (
            !html.classList.contains('visually-hidden') &&
            ((['hidden', 'clip'].includes(style.overflowX) &&
              html.scrollWidth > html.clientWidth + 1) ||
              (['hidden', 'clip'].includes(style.overflowY) &&
                html.scrollHeight > html.clientHeight + 1))
          )
        }).length
        return {
          dom: new XMLSerializer().serializeToString(document),
          anchors,
          locators,
          blockFacts: [
            ...document.querySelectorAll<HTMLElement>('[data-struct-id]'),
          ].map((element) => ({
            blockId: element.dataset.structId!,
            tagName: element.tagName.toLowerCase(),
            text: element.textContent ?? '',
            cells: [
              ...element.querySelectorAll<HTMLTableCellElement>('th,td'),
            ].map((cell) => ({
              id: cell.id,
              tagName: cell.tagName.toLowerCase(),
              text: cell.textContent ?? '',
              rowSpan: cell.rowSpan,
              columnSpan: cell.colSpan,
              scope: cell.getAttribute('scope'),
            })),
            images: [...element.querySelectorAll<HTMLImageElement>('img')].map(
              (image) => ({
                src: image.getAttribute('src') ?? '',
                complete: image.complete,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
              }),
            ),
            links: [...element.querySelectorAll<HTMLAnchorElement>('a')].map(
              (link) => ({ href: link.getAttribute('href') ?? '' }),
            ),
          })),
          metrics: {
            scrollWidth: root.scrollWidth,
            clientWidth: root.clientWidth,
            scrollHeight: root.scrollHeight,
            clientHeight: root.clientHeight,
            clippedElementCount,
            horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
          },
        }
      })
      const domBytes = new TextEncoder().encode(captured.dom)
      const screenshotBytes = await page.screenshot({
        type: 'png',
        fullPage: true,
        animations: 'disabled',
      })
      const screenshotDimensions = {
        width: screenshotBytes.readUInt32BE(16),
        height: screenshotBytes.readUInt32BE(20),
      }
      const executableBytes = await readFile(chromium.executablePath())
      const projection = renderProjection({
        schemaVersion: ACTUAL_PROFILED_EPUB_SCHEMA_VERSION,
        profileId: build.profileId,
        epub: build.epub,
        renderer: {
          id: 'playwright-chromium',
          packageVersion: '1.61.1',
          browserVersion: browser.version(),
          executableSha256: sha256HexSync(executableBytes),
        },
        viewport,
        dom: artifact(domBytes),
        anchors: captured.anchors,
        screenshot: artifact(screenshotBytes),
        screenshotDimensions,
        locators: captured.locators,
        metrics: captured.metrics,
        blockFacts: captured.blockFacts,
        status: 'rendered',
      })
      return {
        ...projection,
        domBytes,
        screenshotBytes,
        receiptSha256: hashTraceValue(projection),
      }
    } finally {
      await page.close()
    }
  })
}

/** Render the exact three profile EPUB bytes in one pinned Chromium process. */
export async function renderExactThreeProfileEpubs(
  builds: readonly ProfiledStructEpubArtifact[],
) {
  if (
    builds.length !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length ||
    CLOSED_RECONSTRUCTION_PROFILE_IDS.some(
      (profileId) =>
        builds.filter((candidate) => candidate.profileId === profileId)
          .length !== 1,
    )
  ) {
    throw new Error('INCOMPLETE_RECONSTRUCTION_PROFILE_SET')
  }
  const browser = await chromium.launch({ headless: true })
  try {
    const results: ActualProfiledEpubRender[] = []
    for (const profileId of CLOSED_RECONSTRUCTION_PROFILE_IDS) {
      results.push(
        await renderOne(
          browser,
          builds.find((candidate) => candidate.profileId === profileId)!,
        ),
      )
    }
    return results
  } finally {
    await browser.close()
  }
}

function epubCheckProjection(receipt: Omit<EpubCheckReceipt, 'receiptSha256'>) {
  return receipt
}

export function verifyEpubCheckReceipt(receipt: EpubCheckReceipt) {
  const { receiptSha256, ...projection } = receipt
  if (
    receipt.status !== 'passed' ||
    receipt.errorCount !== 0 ||
    receipt.warningCount !== 0 ||
    receipt.report.byteLength === 0 ||
    (receipt.authority === 'pinned-java-jar'
      ? !receipt.javaExecutableSha256 ||
        !/^[a-f0-9]{64}$/u.test(receipt.javaExecutableSha256)
      : receipt.javaExecutableSha256 !== null) ||
    !/^[a-f0-9]{64}$/u.test(receipt.executableSha256) ||
    receiptSha256 !== hashTraceValue(projection)
  ) {
    throw new Error('INVALID_EPUBCHECK_RECEIPT')
  }
}

function epubCheckFailureCode(reportBytes: Uint8Array) {
  try {
    const report = JSON.parse(strFromU8(reportBytes)) as {
      messages?: Array<{ ID?: unknown; id?: unknown }>
    }
    const first = report.messages?.[0]
    const value = first?.ID ?? first?.id
    return typeof value === 'string' && /^[A-Z]+-[0-9]+$/u.test(value)
      ? value
      : 'UNCLASSIFIED'
  } catch {
    return 'INVALID_REPORT'
  }
}

/** Accept no warning downgrade: nonzero exit, error, or warning all fail. */
export async function runEpubCheckWarningsFatal(
  build: ProfiledStructEpubArtifact,
  execute: (epubBytes: Uint8Array) => Promise<EpubCheckExecution>,
): Promise<EpubCheckReceipt> {
  const execution = await execute(build.bytes.slice())
  if (
    execution.toolId !== 'epubcheck' ||
    execution.exitCode !== 0 ||
    execution.errorCount !== 0 ||
    execution.warningCount !== 0 ||
    execution.reportBytes.byteLength === 0 ||
    (execution.authority === 'pinned-java-jar'
      ? !execution.javaExecutableSha256 ||
        !/^[a-f0-9]{64}$/u.test(execution.javaExecutableSha256)
      : execution.authority !== 'test-only-injected' ||
        execution.javaExecutableSha256 !== null) ||
    !/^[a-f0-9]{64}$/u.test(execution.executableSha256)
  ) {
    throw new Error(
      `EPUBCHECK_WARNINGS_FATAL:${execution.exitCode}:${execution.errorCount}:${execution.warningCount}:${epubCheckFailureCode(execution.reportBytes)}`,
    )
  }
  const projection = epubCheckProjection({
    schemaVersion: ACTUAL_PROFILED_EPUB_SCHEMA_VERSION,
    epub: build.epub,
    toolId: 'epubcheck',
    toolVersion: execution.toolVersion,
    authority: execution.authority,
    javaExecutableSha256: execution.javaExecutableSha256,
    executableSha256: execution.executableSha256,
    report: artifact(execution.reportBytes),
    errorCount: 0,
    warningCount: 0,
    status: 'passed',
  })
  return { ...projection, receiptSha256: hashTraceValue(projection) }
}

function runProcess(command: string, args: string[]) {
  return new Promise<{
    exitCode: number
    stdout: Uint8Array
    stderr: Uint8Array
  }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) =>
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    )
  })
}

/** Production adapter for the exact pinned EPUBCheck jar. */
export async function executePinnedEpubCheck(input: {
  epubBytes: Uint8Array
  javaPath: string
  expectedJavaExecutableSha256: string
  epubCheckJarPath: string
  toolVersion: string
}): Promise<EpubCheckExecution> {
  if (!/^[a-f0-9]{64}$/u.test(input.expectedJavaExecutableSha256)) {
    throw new Error('EPUBCHECK_JAVA_IDENTITY_REQUIRED')
  }
  const beforeJavaSha256 = sha256HexSync(await readFile(input.javaPath))
  const beforeJarSha256 = sha256HexSync(await readFile(input.epubCheckJarPath))
  if (
    input.toolVersion !== PINNED_EPUBCHECK_TOOL_VERSION ||
    beforeJavaSha256 !== input.expectedJavaExecutableSha256 ||
    beforeJarSha256 !== PINNED_EPUBCHECK_JAR_SHA256
  ) {
    throw new Error('EPUBCHECK_PINNED_EXECUTABLE_IDENTITY_MISMATCH')
  }
  const directory = await mkdtemp(join(tmpdir(), 'rucksack-epubcheck-'))
  try {
    const epubPath = join(directory, 'publication.epub')
    const reportPath = join(directory, 'report.json')
    await writeFile(epubPath, input.epubBytes, { flag: 'wx' })
    const executed = await runProcess(input.javaPath, [
      '-jar',
      input.epubCheckJarPath,
      '-j',
      reportPath,
      epubPath,
    ])
    const reportBytes = await readFile(reportPath).catch(() =>
      Buffer.concat([executed.stdout, executed.stderr]),
    )
    let report: unknown
    try {
      report = JSON.parse(strFromU8(reportBytes))
    } catch {
      report = null
    }
    const messages =
      report && typeof report === 'object' && 'messages' in report
        ? (report as { messages?: unknown }).messages
        : null
    const list = Array.isArray(messages) ? messages : []
    const severity = (message: unknown) =>
      message && typeof message === 'object' && 'severity' in message
        ? String((message as { severity: unknown }).severity).toUpperCase()
        : ''
    const afterJavaSha256 = sha256HexSync(await readFile(input.javaPath))
    const afterJarSha256 = sha256HexSync(await readFile(input.epubCheckJarPath))
    if (
      afterJavaSha256 !== beforeJavaSha256 ||
      afterJarSha256 !== beforeJarSha256
    ) {
      throw new Error('EPUBCHECK_EXECUTABLE_CHANGED_DURING_RUN')
    }
    return {
      toolId: 'epubcheck',
      toolVersion: input.toolVersion,
      authority: 'pinned-java-jar',
      javaExecutableSha256: beforeJavaSha256,
      executableSha256: beforeJarSha256,
      exitCode: executed.exitCode,
      reportBytes,
      errorCount: list.filter((message) =>
        ['ERROR', 'FATAL'].includes(severity(message)),
      ).length,
      warningCount: list.filter((message) => severity(message) === 'WARNING')
        .length,
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
