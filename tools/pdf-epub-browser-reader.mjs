#!/usr/bin/env node
import {
  readFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { unzipSync } from 'fflate'

const TOOL_VERSION = '1.2.0'
const MAX_EPUB_BYTES = 256 * 1024 * 1024
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024
const MAX_ENTRIES = 100_000

function smokeCoverage() {
  return {
    role: 'supplementary-only',
    included: ['chromium-spine-document-load-and-finite-layout-smoke'],
    excluded: [
      'webkit',
      'href-and-fragment-integrity',
      'reader-marker-scans',
      'responsiveness',
      'apple-books',
      'target-e-ink',
    ],
  }
}

function xmlValue(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function attribute(fragment, name) {
  const match = fragment.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'iu'),
  )
  return match ? xmlValue(match[2]) : null
}

function safeArchivePath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return null
  }
  const normalized = posix.normalize(value)
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    return null
  }
  return normalized
}

function decodedHref(value) {
  try {
    const withoutFragment = value.split('#', 1)[0].split('?', 1)[0]
    return decodeURIComponent(withoutFragment)
  } catch {
    return null
  }
}

function spinePaths(files) {
  const containerBytes = files.get('META-INF/container.xml')
  if (!containerBytes) throw new Error('EPUB_CONTAINER_MISSING')
  const container = Buffer.from(containerBytes).toString('utf8')
  const rootfile = container.match(
    /<(?:[A-Za-z0-9_.-]+:)?rootfile\b[^>]*\bfull-path\s*=\s*(["'])(.*?)\1/iu,
  )?.[2]
  const opfPath = safeArchivePath(xmlValue(rootfile ?? ''))
  if (!opfPath || !files.has(opfPath)) throw new Error('EPUB_PACKAGE_MISSING')
  const opf = Buffer.from(files.get(opfPath)).toString('utf8')
  const manifest = new Map()
  for (const match of opf.matchAll(
    /<(?:[A-Za-z0-9_.-]+:)?item\b([^>]*)\/?>/giu,
  )) {
    const id = attribute(match[1], 'id')
    const href = attribute(match[1], 'href')
    if (!id || !href || manifest.has(id)) {
      throw new Error('EPUB_MANIFEST_INVALID')
    }
    const decoded = decodedHref(href)
    const path = decoded
      ? safeArchivePath(posix.join(posix.dirname(opfPath), decoded))
      : null
    if (!path || !files.has(path)) throw new Error('EPUB_MANIFEST_INVALID')
    manifest.set(id, path)
  }
  const spine = []
  for (const match of opf.matchAll(
    /<(?:[A-Za-z0-9_.-]+:)?itemref\b([^>]*)\/?>/giu,
  )) {
    const id = attribute(match[1], 'idref')
    const path = id ? manifest.get(id) : null
    if (!path) throw new Error('EPUB_SPINE_INVALID')
    spine.push(path)
  }
  if (spine.length === 0) throw new Error('EPUB_SPINE_INVALID')
  return spine
}

async function unpackEpub(epubPath, outputRoot) {
  const details = await lstat(epubPath)
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size < 1 ||
    details.size > MAX_EPUB_BYTES
  ) {
    throw new Error('EPUB_INPUT_INVALID')
  }
  let declaredEntries = 0
  let declaredBytes = 0
  const archive = unzipSync(new Uint8Array(await readFile(epubPath)), {
    filter(entry) {
      declaredEntries += 1
      declaredBytes += entry.originalSize
      if (declaredEntries > MAX_ENTRIES || declaredBytes > MAX_UNPACKED_BYTES) {
        throw new Error('EPUB_ARCHIVE_TOO_LARGE')
      }
      return true
    },
  })
  const entries = Object.entries(archive)
  if (entries.length === 0 || entries.length > MAX_ENTRIES) {
    throw new Error('EPUB_ARCHIVE_INVALID')
  }
  const files = new Map()
  let totalBytes = 0
  for (const [rawPath, bytes] of entries) {
    const path = safeArchivePath(rawPath.replace(/\/$/u, ''))
    if (!path || rawPath.endsWith('/') || files.has(path)) {
      if (rawPath.endsWith('/') && path) continue
      throw new Error('EPUB_ARCHIVE_INVALID')
    }
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_UNPACKED_BYTES) {
      throw new Error('EPUB_ARCHIVE_TOO_LARGE')
    }
    files.set(path, bytes)
  }
  const spine = spinePaths(files)
  for (const [path, bytes] of files) {
    const destination = join(outputRoot, ...path.split('/'))
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(destination, bytes, { mode: 0o600 })
  }
  return spine
}

async function browserVersion() {
  const browser = await chromium.launch({ headless: true })
  try {
    return browser.version()
  } finally {
    await browser.close()
  }
}

async function safeScratchRoot(requestedRoot) {
  const requestedDetails = await lstat(requestedRoot)
  if (!requestedDetails.isDirectory() || requestedDetails.isSymbolicLink()) {
    throw new Error('INVALID_SCRATCH_ROOT')
  }
  const root = await realpath(requestedRoot)
  const details = await lstat(root)
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('INVALID_SCRATCH_ROOT')
  }
  return root
}

async function validateInBrowser(epubPath, parentScratchRoot = null) {
  const scratchPrefix =
    parentScratchRoot === null
      ? join(tmpdir(), 'epub-chromium-spine-smoke-')
      : join(await safeScratchRoot(parentScratchRoot), 'epub-unpacked-')
  const scratch = await mkdtemp(scratchPrefix)
  let browser
  try {
    const spine = await unpackEpub(epubPath, scratch)
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: 'block',
    })
    await context.route('**/*', async (route) => {
      const url = route.request().url()
      if (/^(?:file|data|about):/u.test(url)) await route.continue()
      else await route.abort('blockedbyclient')
    })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.name))
    for (const path of spine) {
      await page.goto(pathToFileURL(join(scratch, ...path.split('/'))).href, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      })
      const result = await page.evaluate(() => {
        const root = document.documentElement
        const body = document.body
        return {
          hasRoot: Boolean(root),
          hasBody: Boolean(body),
          parserErrors: document.querySelectorAll('parsererror').length,
          finiteLayout:
            Boolean(root) &&
            [root.scrollWidth, root.scrollHeight].every(
              (value) => Number.isFinite(value) && value >= 0,
            ),
        }
      })
      if (
        !result.hasRoot ||
        !result.hasBody ||
        result.parserErrors > 0 ||
        !result.finiteLayout ||
        pageErrors.length > 0
      ) {
        throw new Error('EPUB_BROWSER_RENDER_FAILED')
      }
    }
    await context.close()
    return {
      schemaVersion: TOOL_VERSION,
      kind: 'supplementary-chromium-spine-smoke',
      status: 'passed',
      spineItems: spine.length,
      renderedItems: spine.length,
      reader: {
        name: 'chromium',
        version: browser.version(),
        javaScript: 'disabled',
        network: 'blocked',
      },
      coverage: smokeCoverage(),
    }
  } finally {
    await browser?.close()
    await rm(scratch, { recursive: true, force: true })
  }
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--version') {
    process.stdout.write(
      `${JSON.stringify({
        tool: 'pdf-epub-chromium-spine-smoke',
        version: TOOL_VERSION,
        browser: { name: 'chromium', version: await browserVersion() },
        coverage: smokeCoverage(),
      })}\n`,
    )
    return
  }
  const arguments_ = process.argv.slice(2)
  const epubPath = arguments_[0]
  const parentScratchRoot =
    arguments_.length === 3 && arguments_[1] === '--scratch-root'
      ? arguments_[2]
      : null
  if (
    !epubPath ||
    !(
      arguments_.length === 1 ||
      (arguments_.length === 3 && parentScratchRoot !== null)
    )
  ) {
    process.stderr.write(
      'Usage: node tools/pdf-epub-browser-reader.mjs <publication.epub> [--scratch-root <parent-owned-directory>] # supplementary Chromium spine smoke only\n',
    )
    process.exitCode = 2
    return
  }
  const receipt = await validateInBrowser(epubPath, parentScratchRoot)
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

main().catch(() => {
  process.stderr.write('Supplementary Chromium spine smoke failed.\n')
  process.exitCode = 1
})
