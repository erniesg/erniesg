import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as epubcheck from 'epubcheck-static'
import JSZip from 'jszip'
import { parse } from 'parse5'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PUBLICATION_PROFILES } from '../src/publication/renderers/vivliostyle.ts'
import { publicationGraphSchema } from '../src/publication/schema.ts'

export function parsePublicationCheckArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (!['--input', '--matrix'].includes(option))
      throw new Error(`Unknown publication:check option: ${option}`)
    const value = argv[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${option}`)
    options[option.slice(2)] = value
  }
  if (!options.input || !options.matrix)
    throw new Error(
      'Usage: publication:check --input <directory> --matrix phone-webpub,eink-epub,a5-pdf,a4-pdf',
    )
  const matrix = options.matrix.split(',').filter(Boolean)
  if (
    matrix.length !== PUBLICATION_PROFILES.length ||
    PUBLICATION_PROFILES.some((profile) => !matrix.includes(profile))
  )
    throw new Error(
      `Publication check matrix must be exactly: ${PUBLICATION_PROFILES.join(',')}`,
    )
  return { input: options.input, matrix }
}

async function run(command, args) {
  let stdout = ''
  let stderr = ''
  const status = await new Promise((accept, reject) => {
    const child = spawn(command, args, { env: process.env })
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('exit', accept)
  })
  if (status !== 0)
    throw new Error(
      `EPUBCheck failed with status ${status}:\n${stdout}${stderr}`,
    )
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function imageAlternativeTexts(html) {
  const alternatives = []
  const visit = (node) => {
    if (node.tagName === 'img') {
      const alt = node.attrs?.find((attribute) => attribute.name === 'alt')
      if (alt) alternatives.push(alt.value)
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(parse(html))
  return alternatives
}

async function checkWebPubReceipt(root, artifact) {
  assert(
    artifact && Array.isArray(artifact.files) && artifact.files.length > 0,
    'WebPub receipt does not include a complete file manifest',
  )
  assert(
    artifact.sha256 === sha256(JSON.stringify(artifact.files)),
    'WebPub receipt manifest hash is invalid',
  )
  const webpubRoot = resolve(root, 'phone-webpub')
  let total = 0
  for (const file of artifact.files) {
    assert(
      typeof file.path === 'string' &&
        !isAbsolute(file.path) &&
        !file.path.split('/').includes('..'),
      'WebPub receipt contains an unsafe file path',
    )
    const path = resolve(webpubRoot, file.path)
    const escaped = relative(webpubRoot, path)
    assert(
      escaped === file.path && !escaped.startsWith('../'),
      'WebPub receipt file escapes its artifact directory',
    )
    const bytes = new Uint8Array(await readFile(path))
    assert(
      file.byteLength === bytes.byteLength,
      `WebPub file length changed: ${file.path}`,
    )
    assert(
      file.sha256 === sha256(bytes),
      `WebPub file hash changed: ${file.path}`,
    )
    total += bytes.byteLength
  }
  assert(total === artifact.byteLength, 'WebPub receipt byte length is invalid')
}

async function checkPdf(path, expected, size) {
  const bytes = new Uint8Array(await readFile(path))
  const pdf = await PDFDocument.load(bytes)
  assert(pdf.getPageCount() > 0, `${expected} has no pages`)
  const first = pdf.getPage(0)
  const target =
    size === 'A5'
      ? { width: 419.528, height: 595.276 }
      : { width: 595.276, height: 841.89 }
  assert(
    Math.abs(first.getWidth() - target.width) < 1 &&
      Math.abs(first.getHeight() - target.height) < 1,
    `${expected} page geometry is not ${size}`,
  )
  for (const page of pdf.getPages()) {
    const media = page.getMediaBox()
    const crop = page.getCropBox()
    assert(
      crop.x >= media.x &&
        crop.y >= media.y &&
        crop.width <= media.width &&
        crop.height <= media.height,
      `${expected} has a crop box outside its media box`,
    )
  }
  const source = Buffer.from(bytes).toString('latin1')
  const document = await getDocument({
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise
  let text = ''
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const content = await page.getTextContent()
    text += content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
  }
  await document.destroy()
  const searchableText = text.replace(/[^\p{L}\p{N}]+/gu, '')
  const searchableExpected = expected.replace(/[^\p{L}\p{N}]+/gu, '')
  assert(
    searchableText.includes(searchableExpected),
    `${size} PDF does not preserve selectable title text`,
  )
  assert(
    /\/FontFile(?:2|3)?\b/.test(source),
    `${size} PDF has no embedded font`,
  )
  assert(/\/Annots\b/.test(source), `${size} PDF has no link annotations`)
  assert(/\/Subtype\s*\/Image\b/.test(source), `${size} PDF has no image asset`)
  return pdf.getPageCount()
}

export async function publicationCheck(argv = process.argv.slice(2)) {
  const options = parsePublicationCheckArgs(argv)
  const root = resolve(options.input)
  const graph = publicationGraphSchema.parse(
    JSON.parse(await readFile(resolve(root, 'publication-graph.json'), 'utf8')),
  )
  const receipt = JSON.parse(
    await readFile(resolve(root, 'publication-receipt.json'), 'utf8'),
  )
  assert(
    receipt.artifacts.length === 4,
    'Publication receipt matrix is incomplete',
  )
  const webpubArtifact = receipt.artifacts.find(
    (artifact) => artifact.profile === 'phone-webpub',
  )
  await checkWebPubReceipt(root, webpubArtifact)
  const html = await readFile(resolve(root, 'phone-webpub/index.html'), 'utf8')
  const imageAlts = imageAlternativeTexts(html)
  assert(
    html.includes(`lang="${graph.edition.locale}"`) &&
      html.includes('<main>') &&
      html.includes('<h1>'),
    'WebPub is missing language, landmarks, or headings',
  )
  for (const node of graph.nodes) {
    if (node.type === 'heading')
      assert(
        html.includes(`id="${node.id}"`),
        `WebPub dropped heading ${node.id}`,
      )
    if (node.type === 'figure' || node.type === 'media')
      assert(
        imageAlts.includes(node.accessibility.alternativeText ?? ''),
        `WebPub dropped image alternative for ${node.id}`,
      )
  }
  const epubPath = resolve(root, 'eink.epub')
  const epub = await JSZip.loadAsync(await readFile(epubPath))
  const packageDocument = await epub.file('EPUB/package.opf')?.async('string')
  const navigation = await epub.file('EPUB/nav.xhtml')?.async('string')
  const content = await epub.file('EPUB/content.xhtml')?.async('string')
  assert(
    packageDocument?.includes('schema:accessMode') &&
      packageDocument.includes('<spine>'),
    'EPUB is missing accessibility metadata or reading order',
  )
  assert(
    navigation?.includes('epub:type="toc"') &&
      navigation.includes('epub:type="landmarks"'),
    'EPUB is missing navigation or landmarks',
  )
  for (const node of graph.nodes)
    if (node.type === 'heading')
      assert(
        content?.includes(`id="${node.id}"`),
        `EPUB dropped heading ${node.id}`,
      )
  await run('java', ['-jar', epubcheck.path, epubPath])
  const a5Pages = await checkPdf(
    resolve(root, 'a5-pdf.pdf'),
    graph.metadata.title,
    'A5',
  )
  const a4Pages = await checkPdf(
    resolve(root, 'a4-pdf.pdf'),
    graph.metadata.title,
    'A4',
  )
  assert(a5Pages !== a4Pages, 'A5 and A4 PDF page counts must differ')
  assert(
    receipt.profiles['a5-pdf'].figurePlacement !==
      receipt.profiles['a4-pdf'].figurePlacement,
    'A5 and A4 figure placement policies must differ',
  )
  for (const profile of ['a5-pdf', 'a4-pdf'])
    assert(
      ['vivliostyle-cli', 'playwright-chromium'].includes(
        receipt.artifacts.find((artifact) => artifact.profile === profile)
          ?.renderer,
      ),
      `${profile} receipt does not identify its PDF renderer`,
    )
  const parity = JSON.parse(
    await readFile(resolve(root, 'astro-route-parity.json'), 'utf8'),
  )
  assert(
    parity.result === 'passed',
    'Canonical Astro route parity did not pass',
  )
  process.stdout.write(
    `Publication matrix passed structural, accessibility, EPUBCheck, and PDF checks at ${root}\n`,
  )
  return { a5Pages, a4Pages }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  publicationCheck().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  })
}
