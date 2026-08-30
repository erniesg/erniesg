#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'
import { XMLValidator } from 'fast-xml-parser'
import { createPdfPipeline } from './pdf-corpus-audit-lib.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifestPath = resolve(
  root,
  'tests/fixtures/pdf/study-pdf-epub-heldout-v1.json',
)
const fixtureRoot = dirname(manifestPath)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

function fail(message) {
  throw new Error(`Study PDF-to-EPUB holdout: ${message}`)
}

function inspectRequiredEpubInvariants(bytes, inspectEpub, profile) {
  inspectEpub(bytes, profile)
  const files = unzipSync(bytes)
  const required = [
    'META-INF/container.xml',
    'EPUB/package.opf',
    'EPUB/nav.xhtml',
    'EPUB/content.xhtml',
  ]
  for (const name of required) {
    if (!files[name]) fail(`generated EPUB is missing ${name}`)
    const source = strFromU8(files[name])
    if (XMLValidator.validate(source) !== true) {
      fail(`generated EPUB contains invalid XML in ${name}`)
    }
  }
  const container = strFromU8(files['META-INF/container.xml'])
  const opf = strFromU8(files['EPUB/package.opf'])
  const nav = strFromU8(files['EPUB/nav.xhtml'])
  const content = strFromU8(files['EPUB/content.xhtml'])
  if (!container.includes('EPUB/package.opf'))
    fail('container does not bind the OPF')
  if (!/properties=["'][^"']*nav/u.test(opf)) fail('OPF has no navigation item')
  if (!/<spine\b[\s\S]*?<itemref\b/u.test(opf))
    fail('OPF has no readable spine')
  if (!/<nav\b/u.test(nav) || !/<a\b[^>]*href=/u.test(nav))
    fail('navigation is empty')
  if (!/<body\b/u.test(content)) fail('content document has no body')
}

if (
  manifest.schemaVersion !== '1.0.0' ||
  manifest.corpusId !== 'study-pdf-epub-heldout-v1' ||
  !Array.isArray(manifest.cases) ||
  manifest.cases.length !== 12
) {
  fail('the immutable v1 manifest shape changed')
}
const requiredFeatures = new Set([
  'born-digital',
  'structured',
  'scan',
  'hybrid',
  'rotated',
  'multilingual',
  'sparse-text',
  'tables-citations',
  'figures-captions',
  'internal-navigation',
  'encrypted',
  'corrupt',
  'unsupported-container',
  'hostile-active-content',
])
for (const entry of manifest.cases) {
  for (const feature of entry.features) requiredFeatures.delete(feature)
}
if (requiredFeatures.size)
  fail(`manifest lacks: ${[...requiredFeatures].join(', ')}`)

const pipeline = await createPdfPipeline()
const results = []
try {
  const exports = await pipeline.loadExportModules()
  const profile = exports.getTargetProfile('mobile')
  for (const entry of manifest.cases) {
    const bytes = await readFile(resolve(fixtureRoot, entry.file))
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== entry.sha256) fail(`${entry.file} identity changed`)
    try {
      const reconstruction = await pipeline.reconstructPdf(
        new File([bytes], entry.file, {
          type: 'application/pdf',
          lastModified: 0,
        }),
        undefined,
        {
          standardFontDataUrl: pipeline.standardFontDataUrl,
          ocr: pipeline.ocr,
        },
      )
      if (entry.expect === 'reject')
        fail(`${entry.file} was accepted (expected ${entry.code})`)
      const epub = reconstruction.readiness.ready
        ? await exports.buildEpub(reconstruction.paper, reconstruction, profile)
        : await exports.buildReadableEpub(
            reconstruction.paper,
            reconstruction,
            profile,
          )
      inspectRequiredEpubInvariants(epub.bytes, exports.inspectEpub, profile)
      results.push({ file: entry.file, outcome: 'epub', mode: epub.mode })
    } catch (error) {
      if (entry.expect !== 'reject') throw error
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : null
      if (code !== entry.code)
        fail(
          `${entry.file} rejected as ${code ?? 'unknown'}, expected ${entry.code}`,
        )
      results.push({ file: entry.file, outcome: 'rejected', code })
    }
  }
} finally {
  await pipeline.close()
}

process.stdout.write(
  `${JSON.stringify({ corpusId: manifest.corpusId, cases: results }, null, 2)}\n`,
)
