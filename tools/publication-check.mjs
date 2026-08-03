import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as epubcheck from 'epubcheck-static'
import JSZip from 'jszip'
import { parse } from 'parse5'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  PUBLICATION_PROFILES,
  publicationNodeForProfile,
} from '../src/publication/renderers/vivliostyle.ts'
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

export function normalizePdfSearchableText(value) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase()
}

export function publicationPdfTextRequirements(graph, profile = 'a5-pdf') {
  const required = []
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) required.push(value)
  }
  add(graph.metadata.title)
  add(graph.metadata.subtitle)
  add(graph.metadata.abstract)
  for (const contributor of graph.metadata.contributors ?? []) add(contributor)
  for (const node of graph.nodes) {
    const selected = publicationNodeForProfile(node, profile)
    if ('text' in selected) add(selected.text)
    switch (selected.type) {
      case 'quote':
        add(selected.attribution)
        break
      case 'code':
        add(selected.code)
        break
      case 'figure':
        add(selected.sourceText)
        break
      case 'table':
        for (const row of selected.rows)
          for (const cell of row.cells) add(cell.text)
        break
      case 'equation':
        add(selected.source)
        add(selected.label)
        break
      case 'note':
        add(selected.label)
        break
      default:
        break
    }
  }
  return required
}

export function assertPdfSearchableTextRequirements(
  searchableText,
  requiredTexts,
) {
  let cursor = 0
  for (const requiredText of requiredTexts ?? []) {
    const searchableExpected = normalizePdfSearchableText(requiredText)
    if (!searchableExpected) continue
    const index = searchableText.indexOf(searchableExpected, cursor)
    assert(
      index >= 0,
      `PDF does not preserve selectable body text: ${requiredText}`,
    )
    cursor = index + searchableExpected.length
  }
}

export function orderPdfTextRequirements(requiredTexts, renderedText) {
  const renderedTextWithCollapsedWhitespace = String(renderedText ?? '').replace(
    /\s+/gu,
    ' ',
  )
  let searchableRenderedText = ''
  const searchablePositions = []
  for (let index = 0; index < renderedTextWithCollapsedWhitespace.length; ) {
    const codePoint = renderedTextWithCollapsedWhitespace[index]
    const normalized = normalizePdfSearchableText(codePoint)
    if (normalized) {
      searchableRenderedText += normalized
      searchablePositions.push(
        ...[...normalized].map(() => index),
      )
    }
    index += codePoint.length
  }
  const renderedTextPosition = (value) => {
    const expected = String(value ?? '').trim().replace(/\s+/gu, ' ')
    const exactIndex = expected
      ? renderedTextWithCollapsedWhitespace.indexOf(expected)
      : -1
    if (exactIndex >= 0) return exactIndex
    const searchableExpected = normalizePdfSearchableText(value)
    const normalizedIndex = searchableExpected
      ? searchableRenderedText.indexOf(searchableExpected)
      : -1
    return normalizedIndex < 0
      ? Number.MAX_SAFE_INTEGER
      : searchablePositions[normalizedIndex] ?? Number.MAX_SAFE_INTEGER
  }
  return [...(requiredTexts ?? [])].sort((left, right) => {
    return renderedTextPosition(left) - renderedTextPosition(right)
  })
}

export function publicationPdfLinkRequirements(graph) {
  return publicationPdfLinkRequirementsForProfile(graph, 'a5-pdf')
}

export function publicationPdfLinkRequirementsForProfile(
  graph,
  profile = 'a5-pdf',
) {
  const links = []
  for (const node of graph.nodes) {
    const selected = publicationNodeForProfile(node, profile)
    for (const run of selected.inlineRuns ?? [])
      if (run.href) links.push(run.href)
    if (selected.type === 'reference' && selected.href)
      links.push(selected.href)
  }
  return links
}

export function assertPdfLinkAnnotations(annotations, requiredLinks) {
  const expected = [...(requiredLinks ?? [])]
  if (expected.length === 0) return
  const available = [...(annotations ?? [])]
  assert(
    available.length >= expected.length,
    `PDF contains ${available.length} link annotations but requires ${expected.length}`,
  )
  const remaining = [...available]
  for (const required of expected) {
    const index = remaining.findIndex((annotation) => {
      if (!annotation || typeof annotation !== 'object') return false
      const target = pdfAnnotationTarget(annotation)
      return target === required
    })
    assert(
      index >= 0,
      `PDF is missing a link annotation for ${required}`,
    )
    remaining.splice(index, 1)
  }
}

export function pdfAnnotationTarget(annotation) {
  if (typeof annotation?.target === 'string') return annotation.target
  if (typeof annotation?.url === 'string') return annotation.url
  if (typeof annotation?.unsafeUrl === 'string') return annotation.unsafeUrl
  const destination = annotation?.dest
  if (typeof destination === 'string')
    return destination.startsWith('#') ? destination : `#${destination}`
  if (Array.isArray(destination)) {
    const named = destination.find(
      (value) =>
        typeof value === 'string' ||
        (value && typeof value === 'object' && typeof value.name === 'string'),
    )
    if (typeof named === 'string')
      return named.startsWith('#') ? named : `#${named}`
    if (named && typeof named === 'object' && typeof named.name === 'string')
      return named.name.startsWith('#') ? named.name : `#${named.name}`
  }
  return ''
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

export function accessibilityLabel(node) {
  return (
    [
      node.accessibility?.alternativeText,
      node.accessibility?.longDescription,
      node.accessibility?.transcript,
    ].find((value) => typeof value === 'string' && value.trim()) ?? ''
  )
}

function canonicalRouteElements(html) {
  const result = { headings: [], images: [] }
  const visit = (node) => {
    if (node.tagName && /^h[1-6]$/u.test(node.tagName))
      result.headings.push(textContent(node).trim())
    if (node.tagName === 'img')
      result.images.push({
        src: attribute(node, 'src'),
        alt: attribute(node, 'alt'),
      })
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(parse(html))
  return result
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
          textContent(elementById(html, `${node.id}-source`)) ===
            node.sourceText,
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
  validatePublicationGraphContent(graph, html, 'phone-webpub', imageAlts)
}

function comparableHtmlText(value) {
  return normalizePdfSearchableText(String(value ?? ''))
}

function requiredNodeText(node) {
  switch (node.type) {
    case 'heading':
    case 'paragraph':
    case 'list-item':
    case 'quote':
    case 'caption':
    case 'aside':
    case 'reference':
    case 'note':
      return node.text ? [node.text] : []
    case 'code':
      return [node.code]
    case 'figure':
      return node.sourceText ? [node.sourceText] : []
    case 'table':
      return node.rows.flatMap((row) => row.cells.map((cell) => cell.text))
    case 'equation':
      return [node.source, node.label]
    default:
      return []
  }
}

export function validatePublicationGraphContent(
  graph,
  html,
  profile = 'phone-webpub',
  imageAlts = imageAlternativeTexts(html),
) {
  for (const original of graph.nodes) {
    if (original.requirement === 'optional') continue
    const node = publicationNodeForProfile(original, profile)
    if (node.type === 'caption') continue
    if (profile === 'phone-webpub') assertWebPubNode(html, imageAlts, node)
    const element = elementById(html, node.id)
    assert(element, `${profile} dropped required node ${node.id}`)
    if (node.type === 'heading')
      assert(
        element.tagName === `h${node.level}`,
        `${profile} changed required heading ${node.id}`,
      )
    for (const expected of requiredNodeText(node)) {
      if (!expected?.trim()) continue
      assert(
        comparableHtmlText(textContent(element)).includes(
          comparableHtmlText(expected),
        ),
        `${profile} dropped required node content ${node.id}: ${expected}`,
      )
    }
  }
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

export function assertPdfCropBox(page, expected) {
  const media = page.getMediaBox()
  const crop = page.getCropBox()
  const epsilon = 0.01
  assert(
    crop.x >= media.x - epsilon &&
      crop.y >= media.y - epsilon &&
      crop.x + crop.width <= media.x + media.width + epsilon &&
      crop.y + crop.height <= media.y + media.height + epsilon,
    `${expected} has a crop box outside its media box`,
  )
}

export async function checkPdf(
  path,
  expected,
  size,
  {
    requireLinks = false,
    requireImages = false,
    requiredTexts,
    requiredLinks = [],
  } = {},
) {
  const bytes = new Uint8Array(await readFile(path))
  const pdf = await PDFDocument.load(bytes)
  assert(pdf.getPageCount() > 0, `${expected} has no pages`)
  assertPdfPageGeometry(pdf, expected, size)
  for (const page of pdf.getPages()) assertPdfCropBox(page, expected)
  const source = Buffer.from(bytes).toString('latin1')
  const document = await getDocument({
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise
  let text = ''
  const annotations = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const content = await page.getTextContent()
    text += content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
    for (const annotation of await page.getAnnotations({ intent: 'display' }))
      if (annotation.subtype === 'Link')
        annotations.push({
          target:
            typeof annotation.url === 'string'
              ? annotation.url
              : typeof annotation.unsafeUrl === 'string'
                ? annotation.unsafeUrl
                : undefined,
        })
  }
  await document.destroy()
  const searchableText = normalizePdfSearchableText(text)
  assert(
    Array.isArray(requiredTexts) && requiredTexts.length > 0,
    `${size} PDF body text requirements are missing`,
  )
  assertPdfSearchableTextRequirements(
    searchableText,
    requiredTexts,
  )
  assert(
    /\/FontFile(?:2|3)?\b/.test(source),
    `${size} PDF has no embedded font`,
  )
  if (requireLinks) {
    assert(/\/Annots\b/.test(source), `${size} PDF has no link annotations`)
    assertPdfLinkAnnotations(annotations, requiredLinks)
  }
  if (requireImages)
    assert(
      /\/Subtype\s*\/Image\b/.test(source),
      `${size} PDF has no image asset`,
    )
  return pdf.getPageCount()
}

export async function publicationCheck(argv = process.argv.slice(2)) {
  const options = parsePublicationCheckArgs(argv)
  const root = resolve(options.input)
  const graph = publicationGraphSchema.parse(
    JSON.parse(await readFile(resolve(root, 'publication-graph.json'), 'utf8')),
  )
  const receiptBytes = await readFile(resolve(root, 'publication-receipt.json'))
  const receipt = JSON.parse(receiptBytes.toString('utf8'))
  const assetBundle = JSON.parse(
    await readFile(resolve(root, 'asset-bundle.json'), 'utf8'),
  )
  assert(
    receipt.source?.graphSha256 === sha256(serializePublicationGraph(graph)),
    'Publication graph changed from its receipt',
  )
  assert(
    receipt.source?.assetBundleSha256 ===
      sha256(serializeAssetBundle(assetBundle)),
    'Asset bundle changed from its receipt',
  )
  const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  const currentDirty =
    execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim()
      .length > 0
  assert(
    receipt.repository?.commit === currentCommit,
    'Publication receipt is bound to a different checked-out commit',
  )
  assert(
    receipt.repository?.dirty === false && !currentDirty,
    'Publication receipt is not bound to a clean checked-out repository',
  )
  assert(
    receipt.toolchain?.node === process.versions.node,
    'Publication receipt does not record the current Node runtime',
  )
  assert(
    receipt.toolchain?.runtime?.node === process.versions.node,
    'Publication receipt runtime binding is missing or stale',
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
  const epubBytes = await verifyArtifactReceipt(root, epubArtifact, 'eink.epub')
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
  validatePublicationGraphContent(
    graph,
    content ?? '',
    'eink-epub',
    imageAlternativeTexts(content ?? ''),
  )
  await run('java', ['-jar', epubcheck.path, epubPath])
  const pdfNodes = graph.nodes.map((node) =>
    publicationNodeForProfile(node, 'a5-pdf'),
  )
  const pdfRequirements = {
    requireLinks: pdfNodes.some(
      (node) =>
        ('inlineRuns' in node && node.inlineRuns?.some((run) => run.href)) ||
        (node.type === 'reference' && Boolean(node.href)),
    ),
    requiredLinks: publicationPdfLinkRequirementsForProfile(graph, 'a5-pdf'),
    requireImages: pdfNodes.some(
      (node) =>
        (node.type === 'figure' && node.assetIds.length > 0) ||
        (node.type === 'media' && node.mediaKind === 'image'),
    ),
    requiredTexts: publicationPdfTextRequirements(graph, 'a5-pdf'),
  }
  const renderedPdfText = textContent(
    parse(await readFile(resolve(root, 'a5-pdf.html'), 'utf8')),
  )
  pdfRequirements.requiredTexts = orderPdfTextRequirements(
    pdfRequirements.requiredTexts,
    renderedPdfText,
  )
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
    Number.isInteger(a5Artifact.pageCount) && a5Artifact.pageCount === a5Pages,
    'A5 receipt pageCount does not match the checked PDF',
  )
  assert(
    Number.isInteger(a4Artifact.pageCount) && a4Artifact.pageCount === a4Pages,
    'A4 receipt pageCount does not match the checked PDF',
  )
  assert(
    a5Pages > a4Pages,
    `A5 profile must produce more pages than A4 (${a5Pages} vs ${a4Pages})`,
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
  assert(
    parity.graphSha256 === sha256(serializePublicationGraph(graph)),
    'Canonical Astro route parity graph binding is stale',
  )
  assert(
    parity.assetBundleSha256 === sha256(serializeAssetBundle(assetBundle)),
    'Canonical Astro route parity asset binding is stale',
  )
  assert(
    parity.repositoryCommit === currentCommit && parity.repositoryDirty === false,
    'Canonical Astro route parity is bound to a stale or dirty repository',
  )
  assert(
    parity.publicationReceiptSha256 === sha256(receiptBytes),
    'Canonical Astro route parity receipt binding is stale',
  )
  assert(
    /^[a-f0-9]{64}$/u.test(String(parity.routeHtmlSha256 ?? '')),
    'Canonical Astro route parity is missing its route digest',
  )
  const routeParts = String(parity.canonicalRoute ?? '')
    .split('/')
    .filter(Boolean)
  assert(
    routeParts[0] === 'blog' &&
      routeParts.length >= 2 &&
      routeParts.every((part) => /^[A-Za-z0-9._-]+$/u.test(part)),
    'Canonical Astro route parity has an unsafe route path',
  )
  const routePath = resolve('dist', ...routeParts, 'index.html')
  let canonicalRouteHtml
  try {
    canonicalRouteHtml = await readFile(routePath, 'utf8')
  } catch {
    throw new Error(`Canonical Astro route is unavailable at ${routePath}`)
  }
  assert(
    sha256(canonicalRouteHtml) === parity.routeHtmlSha256,
    'Canonical Astro route parity is bound to a stale route artifact',
  )
  const canonicalRoute = canonicalRouteElements(canonicalRouteHtml)
  let headingCursor = 0
  for (const heading of expectedHeadings) {
    const index = canonicalRoute.headings.indexOf(heading, headingCursor)
    assert(
      index >= 0,
      `Canonical Astro route is missing publication heading: ${heading}`,
    )
    headingCursor = index + 1
  }
  const expectedImageNodes = graph.nodes.filter(
    (node) =>
      (node.type === 'figure' && node.assetIds.length > 0) ||
      (node.type === 'media' && node.mediaKind === 'image'),
  )
  assert(
    Array.isArray(parity.imageBindings) &&
      parity.imageBindings.length === expectedImageNodes.length,
    'Canonical Astro route image asset bindings are incomplete',
  )
  const assetById = new Map(
    assetBundle.assets.map((asset) => [asset.id, asset]),
  )
  parity.imageBindings.forEach((binding, index) => {
    const node = expectedImageNodes[index]
    const assetId = node.type === 'figure' ? node.assetIds[0] : node.assetId
    const descriptor = assetById.get(assetId)
    const alternativeText = accessibilityLabel(node)
    assert(
      descriptor &&
        binding.assetId === assetId &&
        binding.fileName === descriptor.fileName &&
        binding.sha256 === descriptor.sha256 &&
        binding.alternativeText === alternativeText,
      `Canonical Astro route image asset binding is stale for ${assetId}`,
    )
    const routeSrc = String(binding.routeSrc ?? '')
    assert(
      routeSrc && !/^[a-z][a-z\d+.-]*:/iu.test(routeSrc),
      `Canonical Astro route image binding is not local for ${assetId}`,
    )
    const sourceStem = String(descriptor.fileName ?? '')
      .replace(/\.[^.]*$/u, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '')
    const routeStem = routeSrc
      .replace(/\.[^.]*$/u, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '')
    assert(
      !sourceStem || routeStem.includes(sourceStem),
      `Canonical Astro route image binding does not identify source asset ${assetId}`,
    )
    assert(
      canonicalRoute.images.some(
        (image) => image.src === routeSrc && image.alt === alternativeText,
      ),
      `Canonical Astro route image binding is not present in the current route for ${assetId}`,
    )
  })
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
