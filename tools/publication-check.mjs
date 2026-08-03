import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as epubcheck from 'epubcheck-static'
import JSZip from 'jszip'
import { parse } from 'parse5'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PUBLICATION_PROFILES } from '../src/publication/renderers/vivliostyle.ts'
import { serializeAssetBundle } from '../src/publication/asset-bundle.ts'
import { publicationGraphSchema } from '../src/publication/schema.ts'
import { serializePublicationGraph } from '../src/publication/schema.ts'
import { publicationPdfRendererForArchitecture } from '../src/publication/toolchain.ts'

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

export async function verifyArtifactReceipt(root, artifact, relativePath) {
  assert(
    artifact && typeof artifact.sha256 === 'string',
    `Missing receipt for ${relativePath}`,
  )
  const bytes = new Uint8Array(await readFile(resolve(root, relativePath)))
  assert(
    artifact.byteLength === bytes.byteLength,
    `${relativePath} byte length changed from its receipt`,
  )
  assert(
    artifact.sha256 === sha256(bytes),
    `${relativePath} hash changed from its receipt`,
  )
  return bytes
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

function accessibilityLabel(node) {
  return (
    node.accessibility?.alternativeText ??
    node.accessibility?.longDescription ??
    node.accessibility?.transcript ??
    ''
  )
}

function elementById(html, id) {
  const root = parse(html)
  let result
  const visit = (node) => {
    if (result) return
    const idAttribute = node.attrs?.find((attribute) => attribute.name === 'id')
    if (idAttribute?.value === id) {
      result = node
      return
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(root)
  return result
}

function hasTag(node, tagName) {
  if (!node) return false
  if (node.tagName === tagName) return true
  return (node.childNodes ?? []).some((child) => hasTag(child, tagName))
}

function attribute(node, name) {
  return node?.attrs?.find((value) => value.name === name)?.value
}

function textContent(node) {
  if (!node) return ''
  if (node.nodeName === '#text') return node.value ?? ''
  return (node.childNodes ?? []).map(textContent).join('')
}

function assertWebPubNode(html, imageAlts, node) {
  if (node.type === 'heading') {
    assert(
      elementById(html, node.id)?.tagName === `h${node.level}`,
      `WebPub dropped heading ${node.id}`,
    )
    return
  }
  if (node.type === 'figure') {
    const figure = elementById(html, node.id)
    assert(figure?.tagName === 'figure', `WebPub dropped figure ${node.id}`)
    const label = accessibilityLabel(node)
    if (node.assetIds.length > 0)
      assert(
        imageAlts.includes(label),
        `WebPub dropped figure image alternative for ${node.id}`,
      )
    else
      assert(
        Boolean(node.sourceText) &&
          hasTag(figure, 'pre') &&
          textContent(elementById(html, `${node.id}-source`)) === node.sourceText,
        `WebPub dropped source fallback for figure ${node.id}`,
      )
    return
  }
  if (node.type !== 'media') return
  const mediaFigure = elementById(html, node.id)
  assert(mediaFigure?.tagName === 'figure', `WebPub dropped media ${node.id}`)
  const label = accessibilityLabel(node)
  if (node.mediaKind === 'image') {
    assert(
      imageAlts.includes(label),
      `WebPub dropped image alternative for ${node.id}`,
    )
    return
  }
  const expectedTag =
    node.mediaKind === 'audio'
      ? 'audio'
      : node.mediaKind === 'video'
        ? 'video'
        : 'a'
  const media = mediaFigure.childNodes?.find(
    (child) => child.tagName === expectedTag,
  )
  assert(media, `WebPub dropped ${node.mediaKind} media for ${node.id}`)
  assert(
    attribute(media, 'aria-label') === label,
    `WebPub dropped ${node.mediaKind} accessibility label for ${node.id}`,
  )
}

export function validateWebPubGraph(graph, html) {
  const imageAlts = imageAlternativeTexts(html)
  const root = parse(html)
  assert(
    html.includes(`lang="${graph.edition.locale}"`) &&
      html.includes('<main>') &&
      hasTag(root, 'h1'),
    'WebPub is missing language, landmarks, or headings',
  )
  for (const node of graph.nodes) assertWebPubNode(html, imageAlts, node)
}

async function publicationFiles(root, directory = root) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  )
  const files = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await publicationFiles(root, path)))
      continue
    }
    if (!entry.isFile()) continue
    files.push(relative(root, path).split(sep).join('/'))
  }
  return files.sort()
}

export async function checkWebPubReceipt(root, artifact) {
  assert(
    artifact && Array.isArray(artifact.files) && artifact.files.length > 0,
    'WebPub receipt does not include a complete file manifest',
  )
  assert(
    artifact.sha256 === sha256(JSON.stringify(artifact.files)),
    'WebPub receipt manifest hash is invalid',
  )
  const webpubRoot = resolve(root, 'phone-webpub')
  const expectedPaths = artifact.files.map((file) =>
    String(file.path).replaceAll('\\', '/'),
  )
  assert(
    new Set(expectedPaths).size === expectedPaths.length,
    'WebPub receipt contains duplicate file paths',
  )
  const actualPaths = await publicationFiles(webpubRoot)
  assert(
    actualPaths.length === expectedPaths.length &&
      actualPaths.every((path) => expectedPaths.includes(path)),
    'WebPub artifact file set differs from its receipt',
  )
  let total = 0
  for (const file of artifact.files) {
    const normalizedPath = String(file.path).replaceAll('\\', '/')
    assert(
      typeof file.path === 'string' &&
        !isAbsolute(normalizedPath) &&
        !normalizedPath.split('/').includes('..'),
      'WebPub receipt contains an unsafe file path',
    )
    const path = resolve(webpubRoot, normalizedPath)
    const escaped = relative(webpubRoot, path).split(sep).join('/')
    assert(
      escaped === normalizedPath && !escaped.startsWith('../'),
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

export function assertPdfPageGeometry(pdf, expected, size) {
  const target =
    size === 'A5'
      ? { width: 419.528, height: 595.276 }
      : { width: 595.276, height: 841.89 }
  pdf.getPages().forEach((page, index) => {
    assert(
      Math.abs(page.getWidth() - target.width) < 1 &&
        Math.abs(page.getHeight() - target.height) < 1,
      `${expected} page ${index + 1} geometry is not ${size}`,
    )
  })
}

async function checkPdf(
  path,
  expected,
  size,
  { requireLinks = false, requireImages = false } = {},
) {
  const bytes = new Uint8Array(await readFile(path))
  const pdf = await PDFDocument.load(bytes)
  assert(pdf.getPageCount() > 0, `${expected} has no pages`)
  assertPdfPageGeometry(pdf, expected, size)
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
  if (requireLinks)
    assert(/\/Annots\b/.test(source), `${size} PDF has no link annotations`)
  if (requireImages)
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
  const assetBundle = JSON.parse(
    await readFile(resolve(root, 'asset-bundle.json'), 'utf8'),
  )
  assert(
    receipt.source?.graphSha256 === sha256(serializePublicationGraph(graph)),
    'Publication graph changed from its receipt',
  )
  assert(
    receipt.source?.assetBundleSha256 === sha256(serializeAssetBundle(assetBundle)),
    'Asset bundle changed from its receipt',
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
  validateWebPubGraph(graph, html)
  const epubPath = resolve(root, 'eink.epub')
  const epubArtifact = receipt.artifacts.find(
    (artifact) => artifact.profile === 'eink-epub',
  )
  const epubBytes = await verifyArtifactReceipt(
    root,
    epubArtifact,
    'eink.epub',
  )
  const epub = await JSZip.loadAsync(epubBytes)
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
  const pdfRequirements = {
    requireLinks: graph.nodes.some(
      (node) =>
        ('inlineRuns' in node && node.inlineRuns?.some((run) => run.href)) ||
        (node.type === 'reference' && Boolean(node.href)),
    ),
    requireImages: graph.nodes.some(
      (node) =>
        (node.type === 'figure' && node.assetIds.length > 0) ||
        (node.type === 'media' && node.mediaKind === 'image'),
    ),
  }
  const a5Artifact = receipt.artifacts.find(
    (artifact) => artifact.profile === 'a5-pdf',
  )
  const a4Artifact = receipt.artifacts.find(
    (artifact) => artifact.profile === 'a4-pdf',
  )
  await verifyArtifactReceipt(root, a5Artifact, 'a5-pdf.pdf')
  await verifyArtifactReceipt(root, a4Artifact, 'a4-pdf.pdf')
  const a5Pages = await checkPdf(
    resolve(root, 'a5-pdf.pdf'),
    graph.metadata.title,
    'A5',
    pdfRequirements,
  )
  const a4Pages = await checkPdf(
    resolve(root, 'a4-pdf.pdf'),
    graph.metadata.title,
    'A4',
    pdfRequirements,
  )
  assert(
    receipt.profiles['a5-pdf'].figurePlacement !==
      receipt.profiles['a4-pdf'].figurePlacement,
    'A5 and A4 figure placement policies must differ',
  )
  const expectedPdfRenderer = publicationPdfRendererForArchitecture()
  for (const profile of ['a5-pdf', 'a4-pdf'])
    assert(
      receipt.artifacts.find((artifact) => artifact.profile === profile)
        ?.renderer === expectedPdfRenderer,
      `${profile} receipt renderer does not match the ${process.arch} policy (${expectedPdfRenderer})`,
    )
  const parity = JSON.parse(
    await readFile(resolve(root, 'astro-route-parity.json'), 'utf8'),
  )
  const expectedHeadings = graph.nodes
    .filter((node) => node.type === 'heading')
    .map((node) => node.text)
  const expectedImageAlternatives = graph.nodes
    .filter(
      (node) =>
        (node.type === 'figure' && node.assetIds.length > 0) ||
        (node.type === 'media' && node.mediaKind === 'image'),
    )
    .map((node) => accessibilityLabel(node))
    .filter(Boolean)
  const expectedCanonicalRoute = `/blog/${graph.id.replace(/^publication-/, '')}`
  assert(
    parity.result === 'passed' && parity.version === '1.0.0',
    'Canonical Astro route parity did not pass',
  )
  assert(
    parity.canonicalRoute === expectedCanonicalRoute,
    'Canonical Astro route parity points at the wrong entry',
  )
  assert(
    JSON.stringify(parity.headingOrder) === JSON.stringify(expectedHeadings),
    'Canonical Astro route heading parity is stale',
  )
  assert(
    JSON.stringify(parity.localImageAlternatives) ===
      JSON.stringify(expectedImageAlternatives),
    'Canonical Astro route image alternative parity is stale',
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
