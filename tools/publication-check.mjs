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
  publicationAssetFileExtension,
  publicationNodeForProfile,
} from '../src/publication/renderers/vivliostyle.ts'
import { serializeAssetBundle } from '../src/publication/asset-bundle.ts'
import { publicationGraphSchema } from '../src/publication/schema.ts'
import { serializePublicationGraph } from '../src/publication/schema.ts'
import { publicationPdfRendererForArchitecture } from '../src/publication/toolchain.ts'
import {
  canonicalRouteBodyFingerprint,
  publicationGraphBodyFingerprint,
} from './publication-build.mjs'

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

export function normalizePdfVerificationText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\s\p{Z}\p{C}]+/gu, '')
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
  let titleHeadingHeaderPending = true
  for (const node of graph.nodes) {
    const selected = publicationNodeForProfile(node, profile)
    if (
      selected.type === 'heading' &&
      selected.level === 1 &&
      selected.text === graph.metadata.title
    )
      if (titleHeadingHeaderPending) {
        titleHeadingHeaderPending = false
        continue
      }
    if ('text' in selected) add(selected.text)
    switch (selected.type) {
      case 'quote':
        add(selected.attribution)
        break
      case 'code':
        add(selected.code)
        break
      case 'figure':
        add(selected.title)
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
      case 'media':
        if (!selected.accessibility.decorative)
          add(selected.accessibility.transcript)
        break
      default:
        break
    }
  }
  return required
}

export function publicationPdfWidowOrphanRequirements(
  graph,
  profile = 'a5-pdf',
) {
  const required = []
  for (const node of graph.nodes) {
    const selected = publicationNodeForProfile(node, profile)
    if (selected.requirement === 'optional') continue
    if (
      selected.type === 'paragraph' ||
      selected.type === 'list-item' ||
      selected.type === 'quote' ||
      selected.type === 'aside'
    )
      if (selected.text.trim()) required.push(selected.text)
  }
  return required
}

export function assertPdfSearchableTextRequirements(
  searchableText,
  requiredTexts,
) {
  const normalizedSearchableText = normalizePdfVerificationText(searchableText)
  let cursor = 0
  for (const requiredText of requiredTexts ?? []) {
    const searchableExpected = normalizePdfVerificationText(requiredText)
    if (!searchableExpected) continue
    const index = normalizedSearchableText.indexOf(searchableExpected, cursor)
    assert(
      index >= 0,
      `PDF does not preserve selectable body text: ${requiredText}`,
    )
    cursor = index + searchableExpected.length
  }
}

export function assertPdfTextItemGeometry(item, crop, expected) {
  const value = String(item?.str ?? '')
  if (!value.trim()) return
  const transform = Array.isArray(item?.transform) ? item.transform : undefined
  if (!transform || transform.length < 6) return
  const [a, b, c, d, e, f] = transform.map(Number)
  const width = Math.abs(Number(item.width) || 0)
  const height = Math.abs(
    Number(item.height) || Math.hypot(a, b) || Math.hypot(c, d) || 0,
  )
  const xScale = Math.hypot(a, b) || 1
  const yScale = Math.hypot(c, d) || 1
  const ux = [a / xScale, b / xScale]
  const uy = [c / yScale, d / yScale]
  const points = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([x, y]) => [ux[0] * x + uy[0] * y + e, ux[1] * x + uy[1] * y + f])
  const minX = Math.min(...points.map(([x]) => x))
  const maxX = Math.max(...points.map(([x]) => x))
  const minY = Math.min(...points.map(([, y]) => y))
  const maxY = Math.max(...points.map(([, y]) => y))
  const epsilon = 1.5
  assert(
    minX >= crop.x - epsilon &&
      minY >= crop.y - epsilon &&
      maxX <= crop.x + crop.width + epsilon &&
      maxY <= crop.y + crop.height + epsilon,
    `${expected} text item is outside visible page bounds: ${value}`,
  )
}

export function assertPdfImageCount(source, requiredCount, expected) {
  const actual = [...String(source ?? '').matchAll(/\/Subtype\s*\/Image\b/gu)]
    .length
  assert(
    actual >= requiredCount,
    `${expected} PDF contains ${actual} image assets but requires ${requiredCount} image assets`,
  )
}

export function assertPdfWidowOrphanRequirements(
  searchableText,
  locations,
  requiredTexts,
  minimumLines = 3,
) {
  const normalized = normalizePdfVerificationText(searchableText)
  const firstOccurrence = (requiredText) => {
    const expected = normalizePdfVerificationText(requiredText)
    if (!expected) return Number.MAX_SAFE_INTEGER
    const start = normalized.indexOf(expected)
    return start < 0 ? Number.MAX_SAFE_INTEGER : start
  }
  const orderedRequiredTexts = [...(requiredTexts ?? [])].sort(
    (left, right) => firstOccurrence(left) - firstOccurrence(right),
  )
  let cursor = 0
  for (const requiredText of orderedRequiredTexts) {
    const expected = normalizePdfVerificationText(requiredText)
    if (!expected) continue
    const start = normalized.indexOf(expected, cursor)
    assert(start >= 0, `PDF widow/orphan text is missing: ${requiredText}`)
    const end = start + expected.length
    const span = (locations ?? []).slice(start, end)
    const pages = [...new Set(span.map((location) => location?.page))].filter(
      (page) => page !== undefined,
    )
    if (pages.length > 1) {
      const firstPage = pages[0]
      const lastPage = pages.at(-1)
      for (const page of [firstPage, lastPage]) {
        const lines = new Set(
          span
            .filter((location) => location?.page === page)
            .map((location) => location?.line),
        )
        assert(
          lines.size >= minimumLines,
          `PDF widow/orphan constraint failed for ${requiredText}: page ${page} has ${lines.size} lines, requires ${minimumLines}`,
        )
      }
    }
    cursor = end
  }
}

export function orderPdfTextRequirements(requiredTexts, renderedText) {
  const renderedTextWithCollapsedWhitespace = String(
    renderedText ?? '',
  ).replace(/\s+/gu, ' ')
  const normalizedRenderedText = normalizePdfVerificationText(
    renderedTextWithCollapsedWhitespace,
  )
  const normalizedOffsetByRawIndex = []
  let normalizedOffset = 0
  let rawIndex = 0
  for (const codePoint of renderedTextWithCollapsedWhitespace) {
    const normalized = normalizePdfVerificationText(codePoint)
    for (let offset = 0; offset < codePoint.length; offset += 1)
      normalizedOffsetByRawIndex[rawIndex + offset] = normalizedOffset
    if (normalized) {
      normalizedOffset += normalized.length
    }
    rawIndex += codePoint.length
  }
  normalizedOffsetByRawIndex[renderedTextWithCollapsedWhitespace.length] =
    normalizedOffset
  const renderedTextPosition = (value) => {
    const rawValue = String(value ?? '').trim()
    const rawExpected = rawValue.replace(/\s+/gu, ' ')
    const rawExpectedWithoutLineBreaks = rawValue
      .replace(/[\r\n]+/gu, '')
      .replace(/\s+/gu, ' ')
    for (const exactExpected of new Set([
      rawExpected,
      rawExpectedWithoutLineBreaks,
    ])) {
      const exactIndex = exactExpected
        ? renderedTextWithCollapsedWhitespace.indexOf(exactExpected)
        : -1
      if (exactIndex >= 0)
        return normalizedOffsetByRawIndex[exactIndex] ?? Number.MAX_SAFE_INTEGER
    }
    const expected = normalizePdfVerificationText(value)
    const normalizedIndex = expected
      ? normalizedRenderedText.indexOf(expected)
      : -1
    return normalizedIndex < 0 ? Number.MAX_SAFE_INTEGER : normalizedIndex
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
    for (const run of selected.inlineRuns ?? []) {
      if (run.href) links.push(run.href)
      else if (
        (run.semanticRole === 'citation' ||
          run.semanticRole === 'cross-reference') &&
        run.targetIds?.length
      )
        links.push(`#${run.targetIds[0]}`)
    }
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
    assert(index >= 0, `PDF is missing a link annotation for ${required}`)
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

function imageElementsInNode(node) {
  const images = []
  const visit = (candidate) => {
    if (candidate?.tagName === 'img') images.push(candidate)
    for (const child of candidate?.childNodes ?? []) visit(child)
  }
  visit(node)
  return images
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

function assertNodeImages(element, assetIds, alternative, label, assetPaths) {
  const images = imageElementsInNode(element)
  assert(images.length === assetIds.length, `${label} dropped image asset`)
  assetIds.forEach((assetId, index) => {
    const image = images[index]
    const expectedPath = assetPaths?.get(assetId)
    if (assetPaths)
      assert(
        expectedPath,
        `${label} references an unknown image asset ${assetId}`,
      )
    assert(
      attribute(image, 'alt') === alternative &&
        (!expectedPath || attribute(image, 'src') === expectedPath),
      `${label} changed image asset ${assetId}`,
    )
  })
}

function assertWebPubNode(node, profile, elements, assetPaths) {
  const label = profile === 'eink-epub' ? 'eink-epub' : 'WebPub'
  if (node.type === 'heading') {
    assert(
      elements.get(node.id)?.tagName === `h${node.level}`,
      `${label} dropped heading ${node.id}`,
    )
    return
  }
  if (node.type === 'figure') {
    const figure = elements.get(node.id)
    assert(figure?.tagName === 'figure', `${label} dropped figure ${node.id}`)
    const alternative = accessibilityLabel(node)
    if (node.assetIds.length > 0)
      assertNodeImages(
        figure,
        node.assetIds,
        alternative,
        `${label} figure ${node.id}`,
        assetPaths,
      )
    else
      assert(
        Boolean(node.sourceText) &&
          hasTag(figure, 'pre') &&
          textContent(elements.get(`${node.id}-source`)) === node.sourceText,
        `${label} dropped source fallback for figure ${node.id}`,
      )
    return
  }
  if (node.type !== 'media') return
  const mediaFigure = elements.get(node.id)
  assert(mediaFigure?.tagName === 'figure', `${label} dropped media ${node.id}`)
  const alternative = accessibilityLabel(node)
  if (node.mediaKind === 'image') {
    assertNodeImages(
      mediaFigure,
      [node.assetId],
      alternative,
      `${label} media ${node.id}`,
      assetPaths,
    )
    return
  }
  const expectedTag =
    node.mediaKind === 'audio'
      ? 'audio'
      : node.mediaKind === 'video'
        ? 'video'
        : node.mediaKind === 'interactive' && node.accessibility?.decorative
          ? 'span'
          : 'a'
  const media = mediaFigure.childNodes?.find(
    (child) => child.tagName === expectedTag,
  )
  assert(media, `${label} dropped ${node.mediaKind} media for ${node.id}`)
  if (node.accessibility?.decorative === true) {
    assert(
      attribute(media, 'aria-hidden') === 'true',
      `${label} dropped decorative ${node.mediaKind} semantics for ${node.id}`,
    )
    return
  }
  assert(
    attribute(media, 'aria-label') === alternative,
    `${label} dropped ${node.mediaKind} accessibility label for ${node.id}`,
  )
}

export function validateWebPubGraph(graph, html, assetPaths) {
  const index = publicationHtmlIndex(html)
  assert(
    html.includes(`lang="${graph.edition.locale}"`) &&
      html.includes('<main>') &&
      hasTag(index.root, 'h1'),
    'WebPub is missing language, landmarks, or headings',
  )
  validatePublicationGraphContent(
    graph,
    html,
    'phone-webpub',
    assetPaths,
    index,
  )
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
      return [node.title, node.sourceText]
    case 'table':
      return node.rows.flatMap((row) => row.cells.map((cell) => cell.text))
    case 'equation':
      return [node.source, node.label]
    default:
      return []
  }
}

function requiredGraphNodeOrder(graph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const required = (node) => node && node.requirement !== 'optional'
  const nestedListIds = new Set(
    graph.nodes
      .filter((node) => node.type === 'list-item')
      .flatMap((node) => node.childListIds ?? []),
  )
  const result = []
  const visited = new Set()
  const append = (node) => {
    if (!node || visited.has(node.id)) return
    visited.add(node.id)
    if (required(node)) result.push(node.id)
    if ('captionId' in node && node.captionId) append(byId.get(node.captionId))
    if (node.type !== 'list') return
    for (const itemId of node.itemIds ?? []) {
      const item = byId.get(itemId)
      append(item)
      for (const childListId of item?.childListIds ?? [])
        append(byId.get(childListId))
    }
  }
  for (const node of graph.nodes) {
    if (visited.has(node.id)) continue
    if (node.type === 'caption') {
      const parent = byId.get(node.parentId)
      if (parent && parent.captionId === node.id) continue
    }
    if (node.type === 'list' && nestedListIds.has(node.id)) continue
    if (
      node.type === 'list-item' &&
      byId.get(node.parentListId)?.type === 'list'
    )
      continue
    append(node)
  }
  return result
}

function publicationHtmlIndex(html) {
  const root = parse(html)
  const elements = new Map()
  const renderedIds = []
  const visit = (candidate) => {
    const id = attribute(candidate, 'id')
    if (id) {
      if (!elements.has(id)) elements.set(id, candidate)
      renderedIds.push(id)
    }
    for (const child of candidate.childNodes ?? []) visit(child)
  }
  visit(root)
  return { root, elements, renderedIds }
}

export function validatePublicationGraphContent(
  graph,
  html,
  profile = 'phone-webpub',
  assetPaths,
  index = publicationHtmlIndex(html),
) {
  const requiredIds = new Set(
    graph.nodes
      .filter((node) => node.requirement !== 'optional')
      .map((node) => node.id),
  )
  const { elements } = index
  const renderedIds = index.renderedIds.filter((id) => requiredIds.has(id))
  const expectedIds = requiredGraphNodeOrder(graph)
  for (const original of graph.nodes) {
    if (original.requirement === 'optional') continue
    const node = publicationNodeForProfile(original, profile)
    if (profile === 'phone-webpub' || profile === 'eink-epub')
      assertWebPubNode(node, profile, elements, assetPaths)
    const element = elements.get(node.id)
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
  assert(
    renderedIds.length === expectedIds.length &&
      renderedIds.every((id, index) => id === expectedIds[index]),
    `${profile} changed required node order: expected ${expectedIds.join(',')} but rendered ${renderedIds.join(',')}`,
  )
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
    requiredImageCount = requireImages ? 1 : 0,
    requiredTexts,
    requiredLinks = [],
    widowOrphanTexts = [],
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
  const locations = []
  const annotations = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const content = await page.getTextContent()
    const crop = pdf.getPages()[pageNumber - 1].getCropBox()
    for (const item of content.items) {
      if (!('str' in item)) continue
      assertPdfTextItemGeometry(item, crop, `${expected} page ${pageNumber}`)
      const normalizedItem = normalizePdfVerificationText(item.str)
      text += normalizedItem
      const line = Math.round(Number(item.transform?.[5] ?? 0) * 10) / 10
      for (const _character of normalizedItem)
        locations.push({ page: pageNumber, line })
    }
    for (const annotation of await page.getAnnotations({ intent: 'display' }))
      if (annotation.subtype === 'Link') annotations.push(annotation)
  }
  await document.destroy()
  assert(
    Array.isArray(requiredTexts) && requiredTexts.length > 0,
    `${size} PDF body text requirements are missing`,
  )
  assertPdfSearchableTextRequirements(text, requiredTexts)
  if (widowOrphanTexts.length)
    assertPdfWidowOrphanRequirements(text, locations, widowOrphanTexts)
  assert(
    /\/FontFile(?:2|3)?\b/.test(source),
    `${size} PDF has no embedded font`,
  )
  if (requireLinks) {
    assert(/\/Annots\b/.test(source), `${size} PDF has no link annotations`)
    assertPdfLinkAnnotations(annotations, requiredLinks)
  }
  if (requiredImageCount > 0)
    assertPdfImageCount(source, requiredImageCount, size)
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
  const publicationAssetPaths = new Map(
    assetBundle.assets.map((asset) => [
      asset.id,
      `assets/${asset.id}${publicationAssetFileExtension(asset.fileName, asset.mediaType)}`,
    ]),
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
  validateWebPubGraph(graph, html, publicationAssetPaths)
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
    publicationAssetPaths,
  )
  await run('java', ['-jar', epubcheck.path, epubPath])
  const pdfNodes = graph.nodes.map((node) =>
    publicationNodeForProfile(node, 'a5-pdf'),
  )
  const pdfRequirements = {
    requireLinks: pdfNodes.some(
      (node) =>
        ('inlineRuns' in node &&
          node.inlineRuns?.some(
            (run) =>
              Boolean(run.href) ||
              ((run.semanticRole === 'citation' ||
                run.semanticRole === 'cross-reference') &&
                Boolean(run.targetIds?.length)),
          )) ||
        (node.type === 'reference' && Boolean(node.href)),
    ),
    requiredLinks: publicationPdfLinkRequirementsForProfile(graph, 'a5-pdf'),
    requiredImageCount: pdfNodes
      .filter((node) => node.requirement !== 'optional')
      .filter(
        (node) =>
          (node.type === 'figure' && node.assetIds.length > 0) ||
          (node.type === 'media' && node.mediaKind === 'image'),
      ).length,
    requiredTexts: publicationPdfTextRequirements(graph, 'a5-pdf'),
    widowOrphanTexts: publicationPdfWidowOrphanRequirements(graph, 'a5-pdf'),
  }
  pdfRequirements.requireImages = pdfRequirements.requiredImageCount > 0
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
    JSON.stringify(parity.bodyOrder) ===
      JSON.stringify(publicationGraphBodyFingerprint(graph)),
    'Canonical Astro route body parity is stale',
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
    parity.repositoryCommit === currentCommit &&
      parity.repositoryDirty === false,
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
  assert(
    JSON.stringify(canonicalRouteBodyFingerprint(canonicalRouteHtml)) ===
      JSON.stringify(publicationGraphBodyFingerprint(graph)),
    'Canonical Astro route body semantics differ from the publication graph',
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
  for (const [index, binding] of parity.imageBindings.entries()) {
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
    const rawRouteSrc = routeSrc.split(/[?#]/u)[0]
    const routeRoot = resolve('dist')
    const routeAssetPath = isAbsolute(rawRouteSrc)
      ? resolve(routeRoot, rawRouteSrc.replace(/^[/\\]+/u, ''))
      : resolve(routePath, '..', rawRouteSrc)
    const escapedRouteAsset = relative(routeRoot, routeAssetPath)
      .split(sep)
      .join('/')
    assert(
      !escapedRouteAsset.startsWith('../') && !isAbsolute(escapedRouteAsset),
      `Canonical Astro route image binding escapes dist for ${assetId}`,
    )
    assert(
      /^[a-f0-9]{64}$/u.test(String(binding.routeSha256 ?? '')) &&
        binding.routeSha256 === sha256(await readFile(routeAssetPath)),
      `Canonical Astro route image bytes are stale for ${assetId}`,
    )
  }
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
