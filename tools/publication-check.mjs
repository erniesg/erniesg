import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, open, readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as epubcheck from 'epubcheck-static'
import JSZip from 'jszip'
import { parse } from 'parse5'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  STRUCT_BUNDLE_LIMITS_PROFILE,
  decodeStructBundle,
} from '@erniesg/struct/bundle'
import { decodeStructDocument } from '@erniesg/struct/document'
import { structReceiptDigest } from '@erniesg/struct/receipt'
import {
  PUBLICATION_PROFILES,
  publicationAssetFileExtension,
} from '../src/publication/renderers/vivliostyle.ts'
import {
  createAssetBundle,
  serializeAssetBundle,
} from '../src/publication/asset-bundle.ts'
import { publicationBrowserRuntimeEvidenceForCurrentPlatform } from '../src/publication/browser-runtime.ts'
import { PUBLICATION_OUTPUT_POLICY_VERSIONS } from '../src/publication/output-contract.ts'
import {
  publicationPdfRendererForRuntime,
  publicationPlatformKey,
  publicationBrowserRuntimeEvidenceForPlatform,
} from '../src/publication/toolchain.ts'
import {
  assertPublicationPlanSourceBinding,
  canonicalRouteBodyFingerprint,
  decodePersistedStructDocument,
  publicationPlanExpectations,
  publicationPlanFromStructDocument,
} from '../src/publication/publishing-facade.ts'
import { readStructPackagePin } from '../src/publication/struct-package-pin.ts'
import { structDocumentSha256 } from '../src/publication/struct-source-binding.ts'
import { publicationRepositoryForCurrentCheckout } from './publication-build.mjs'

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

export function publicationReceiptRequiresCanonicalRouteParity(
  receipt,
  options = {},
) {
  const source = receipt?.source
  const adapterId = source?.adapterId
  const sourceType = source?.sourceType
  const policy = source?.routeParity
  if (typeof adapterId !== 'string' || typeof sourceType !== 'string')
    throw new Error('Publication receipt has no recognized source identity')

  const isAstro = adapterId === 'astro'
  if (isAstro !== (sourceType === 'astro'))
    throw new Error('Publication receipt has an inconsistent Astro source identity')

  if (policy === 'adapter-conformance') {
    if (options.context !== 'adapter-conformance')
      throw new Error(
        'Publication receipt uses the internal adapter-conformance route-parity policy outside its checker context',
      )
    return false
  }
  if (options.context === 'adapter-conformance')
    throw new Error(
      'Adapter conformance checks require the internal adapter-conformance route-parity policy',
    )
  if (isAstro) {
    if (policy !== 'astro-canonical-route')
      throw new Error('Astro publication receipt must require canonical route parity')
    return true
  }
  if (policy !== 'not-applicable')
    throw new Error('Non-Astro publication receipt has no recognized route-parity policy')
  return false
}

export function publicationReceiptRelaxesRepositoryCleanliness(
  receipt,
  options = {},
) {
  const policy = receipt?.source?.routeParity
  if (policy === 'adapter-conformance') {
    if (options.context !== 'adapter-conformance')
      throw new Error(
        'Publication receipt uses the internal adapter-conformance cleanliness policy outside its checker context',
      )
    return true
  }
  if (options.context === 'adapter-conformance')
    throw new Error(
      'Adapter conformance checks require the internal adapter-conformance cleanliness policy',
    )
  return false
}

export function assertPublicationReceiptRepositoryBinding(
  receipt,
  currentRepository,
  options = {},
) {
  const relaxesCleanliness = publicationReceiptRelaxesRepositoryCleanliness(
    receipt,
    options,
  )
  assert(
    receipt?.repository?.commit === currentRepository.commit,
    'Publication receipt is bound to a different checked-out commit',
  )
  if (relaxesCleanliness) {
    // Adapter conformance asks whether two adapters agree, and publishes
    // nothing durable. An unrelated dirty file answers nothing about that, so
    // the receipt records what it observed without being bound to it.
    assert(
      typeof receipt.repository.dirty === 'boolean',
      'Publication receipt does not record its observed repository cleanliness',
    )
    return relaxesCleanliness
  }
  assert(
    receipt.repository.dirty === false && !currentRepository.dirty,
    'Publication receipt is not bound to a clean checked-out repository',
  )
  return relaxesCleanliness
}

export function assertPublicationPdfPageCountPolicy(
  a5Pages,
  a4Pages,
  requiresCanonicalRouteParity,
) {
  if (!requiresCanonicalRouteParity) return
  assert(
    a5Pages > a4Pages,
    `A5 profile must produce more pages than A4 (${a5Pages} vs ${a4Pages})`,
  )
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

function sameExactRecord(left, right) {
  if (
    !left ||
    typeof left !== 'object' ||
    Array.isArray(left) ||
    !right ||
    typeof right !== 'object' ||
    Array.isArray(right)
  )
    return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    JSON.stringify(leftKeys) === JSON.stringify(rightKeys) &&
    leftKeys.every((key) => left[key] === right[key])
  )
}

export function assertPublicationReceiptRuntime(
  receipt,
  currentPublicationBrowser,
  environment = {},
) {
  const platform = environment.platform ?? process.platform
  const architecture = environment.architecture ?? process.arch
  const node = environment.node ?? process.versions.node
  const expectedPdfRenderer = publicationPdfRendererForRuntime(
    platform,
    architecture,
  )
  const platformKey = publicationPlatformKey(platform, architecture)
  const runtime = receipt?.toolchain?.runtime
  assert(
    receipt?.toolchain?.node === node &&
      runtime?.node === node &&
      runtime?.platformKey === platformKey &&
      runtime?.pdfRenderer === expectedPdfRenderer,
    'Publication receipt runtime binding is missing or stale',
  )
  let normalizedReceiptBrowser
  try {
    const browser = runtime.publicationBrowser
    normalizedReceiptBrowser = publicationBrowserRuntimeEvidenceForPlatform(
      browser,
      platform,
      architecture,
    )
  } catch {
    throw new Error(
      'Publication receipt browser runtime binding is missing or stale',
    )
  }
  assert(
    sameExactRecord(runtime.publicationBrowser, normalizedReceiptBrowser) &&
      sameExactRecord(runtime.publicationBrowser, currentPublicationBrowser),
    'Publication receipt browser runtime binding is missing or stale',
  )
  return expectedPdfRenderer
}

export function assertPublicationReceiptPolicyVersions(receipt) {
  const actual = receipt?.policyVersions
  const expected = PUBLICATION_OUTPUT_POLICY_VERSIONS
  assert(
    receipt?.version === '1.0.0' &&
      actual &&
      typeof actual === 'object' &&
      Object.keys(actual).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => actual[key] === value),
    'Publication receipt has stale or incomplete policy versions',
  )
}

/**
 * The Payload publication path is retired (E-04 P-2): the adapter that
 * produced Payload-sourced receipts no longer exists, and the Payload mapping
 * policy version went with it. A receipt that still claims a Payload source is
 * therefore refused instead of version-checked, so a stale Payload receipt can
 * never pass the check as if it were current.
 */
export function assertPublicationReceiptRetiredPayloadSource(receipt) {
  const source = receipt?.source
  if (source?.sourceType !== 'payload' && source?.adapterId !== 'payload-lexical')
    return
  assert(
    false,
    'Publication receipt claims the retired Payload publication source',
  )
}

const PUBLICATION_SOURCE_TYPE_BY_ADAPTER = Object.freeze({
  astro: 'astro',
})

export function assertPublicationReceiptSourceBinding(receipt, plan) {
  const source = receipt?.source
  const expectedSourceType =
    PUBLICATION_SOURCE_TYPE_BY_ADAPTER[source?.adapterId]
  assert(
    typeof expectedSourceType === 'string' &&
      source?.sourceType === expectedSourceType,
    'Publication receipt source type does not match its registered adapter',
  )
  assert(
    typeof source.sourceId === 'string' && source.sourceId.length > 0,
    'Publication source id binding is missing or inconsistent',
  )
  // The source revision is the digest of the source bytes the plan was
  // derived from, so the receipt and the persisted Struct document have to
  // name the same source revision.
  assert(
    source.sourceRevision === plan.provenance.sourceRevision,
    'Publication source revision binding is missing or inconsistent',
  )
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
    .replace(/ς/gu, 'σ')
}

export function normalizePdfVerificationText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\s\p{Z}\p{C}]+/gu, '')
    .toLowerCase()
    .replace(/ς/gu, 'σ')
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
  const orderedRequiredTexts = orderPdfTextRequirements(
    requiredTexts,
    searchableText,
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
  const renderedTextPosition = (value, minimumNormalizedOffset = 0) => {
    const rawValue = String(value ?? '').trim()
    const rawExpected = rawValue.replace(/\s+/gu, ' ')
    const rawExpectedWithoutLineBreaks = rawValue
      .replace(/[\r\n]+/gu, '')
      .replace(/\s+/gu, ' ')
    let exactPosition = Number.MAX_SAFE_INTEGER
    for (const exactExpected of new Set([
      rawExpected,
      rawExpectedWithoutLineBreaks,
    ])) {
      let exactIndex = exactExpected
        ? renderedTextWithCollapsedWhitespace.indexOf(exactExpected)
        : -1
      while (exactIndex >= 0) {
        const normalizedIndex =
          normalizedOffsetByRawIndex[exactIndex] ?? Number.MAX_SAFE_INTEGER
        if (normalizedIndex >= minimumNormalizedOffset) {
          exactPosition = Math.min(exactPosition, normalizedIndex)
          break
        }
        exactIndex = renderedTextWithCollapsedWhitespace.indexOf(
          exactExpected,
          exactIndex + 1,
        )
      }
    }
    if (exactPosition < Number.MAX_SAFE_INTEGER) return exactPosition
    const expected = normalizePdfVerificationText(value)
    const normalizedIndex = expected
      ? normalizedRenderedText.indexOf(expected, minimumNormalizedOffset)
      : -1
    return normalizedIndex < 0 ? Number.MAX_SAFE_INTEGER : normalizedIndex
  }
  const nextNormalizedOffset = new Map()
  return [...(requiredTexts ?? [])]
    .map((value, index) => {
      const key = normalizePdfVerificationText(value)
      const position = renderedTextPosition(
        value,
        nextNormalizedOffset.get(key) ?? 0,
      )
      if (position < Number.MAX_SAFE_INTEGER)
        nextNormalizedOffset.set(key, position + key.length)
      return { value, index, position }
    })
    .sort((left, right) =>
      left.position === right.position
        ? left.index - right.index
        : left.position - right.position,
    )
    .map(({ value }) => value)
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
      if (target === required) return true
      try {
        return new URL(target).href === new URL(required).href
      } catch {
        return false
      }
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

/**
 * The accessibility label of a rendered node.
 *
 * The label is derived from the plan, so the checker never needs the
 * accessibility record of a graph node.
 */
export function accessibilityLabel(node) {
  return (
    [
      node?.alternativeText,
      node?.longDescription,
      node?.transcript,
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

function assertWebPubExpectation(node, profile, elements, assetPaths) {
  const label = profile === 'eink-epub' ? 'eink-epub' : 'WebPub'
  if (node.tag && /^h[1-6]$/u.test(node.tag)) {
    assert(
      elements.get(node.id)?.tagName === node.tag,
      `${label} dropped heading ${node.id}`,
    )
    return
  }
  if (node.mediaKind === undefined) {
    if (node.tag !== 'figure') return
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
  const mediaFigure = elements.get(node.id)
  assert(mediaFigure?.tagName === 'figure', `${label} dropped media ${node.id}`)
  const alternative = accessibilityLabel(node)
  if (node.mediaKind === 'image') {
    assertNodeImages(
      mediaFigure,
      node.assetIds,
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
        : node.mediaKind === 'interactive' && node.decorative === true
          ? 'span'
          : 'a'
  const media = mediaFigure.childNodes?.find(
    (child) => child.tagName === expectedTag,
  )
  assert(media, `${label} dropped ${node.mediaKind} media for ${node.id}`)
  if (node.decorative === true) {
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

export function validateWebPubExpectations(expectations, html, assetPaths) {
  const index = publicationHtmlIndex(html)
  assert(
    html.includes(`lang="${expectations.locale}"`) &&
      html.includes('<main>') &&
      hasTag(index.root, 'h1'),
    'WebPub is missing language, landmarks, or headings',
  )
  validatePublicationProfileContent(
    expectations.profiles['phone-webpub'],
    html,
    'phone-webpub',
    assetPaths,
    index,
  )
}

function comparableHtmlText(value) {
  return normalizePdfSearchableText(String(value ?? ''))
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

export function validatePublicationProfileContent(
  profile,
  html,
  profileName = 'phone-webpub',
  assetPaths,
  index = publicationHtmlIndex(html),
) {
  const requiredIds = new Set(profile.nodes.map((node) => node.id))
  const { elements } = index
  const renderedIds = index.renderedIds.filter((id) => requiredIds.has(id))
  const expectedIds = profile.nodeOrder
  for (const node of profile.nodes) {
    if (profileName === 'phone-webpub' || profileName === 'eink-epub')
      assertWebPubExpectation(node, profileName, elements, assetPaths)
    const element = elements.get(node.id)
    assert(element, `${profileName} dropped required node ${node.id}`)
    if (node.tag && /^h[1-6]$/u.test(node.tag))
      assert(
        element.tagName === node.tag,
        `${profileName} changed required heading ${node.id}`,
      )
    for (const expected of node.texts) {
      if (!expected?.trim()) continue
      assert(
        comparableHtmlText(textContent(element)).includes(
          comparableHtmlText(expected),
        ),
        `${profileName} dropped required node content ${node.id}: ${expected}`,
      )
    }
  }
  assert(
    renderedIds.length === expectedIds.length &&
      renderedIds.every((id, index) => id === expectedIds[index]),
    `${profileName} changed required node order: expected ${expectedIds.join(',')} but rendered ${renderedIds.join(',')}`,
  )
}

/**
 * The canonical list item a list-container pseudo id belongs to.
 *
 * The projection mints the container of a list group as the id of the first
 * item of that group with a `-list` suffix, and the pinned projection
 * uniquifies that id when it collides with another node id. The base is
 * therefore always a canonical list item, and nothing else may leave the
 * required-node set.
 */
function listContainerBaseId(id, listItemIds) {
  const match = /^(.*)-list(?:-\d+)?$/u.exec(id)
  if (!match) return undefined
  return listItemIds.has(match[1]) ? match[1] : undefined
}

/**
 * The required-node expectations of the checked profiles, derived from the
 * canonical Struct document the receipt is bound to.
 *
 * The requirement set of the release check is a property of the CANONICAL
 * document: a required node is a canonical block of the document the receipt
 * is bound to. The graph projection additionally mints structural
 * list-container nodes (`<list-item id>-list`) that carry no canonical block,
 * and the pinned package renderer publishes the canonical list structure
 * without an identifier for them. Requiring one of those ids would demand an
 * app-authored identifier the E-04 contract forbids, so a list container is
 * not a required node. Every list ITEM is a canonical block, so it keeps its
 * id, its text and its place in the order, and the nesting itself stays the
 * renderer's own responsibility.
 *
 * The derivation cannot excuse content:
 *
 *  - every canonical block the plan carries stays required, with its
 *    canonical text and its place in the canonical order;
 *  - every canonical block the plan does NOT carry must be reported by the
 *    projection as omitted, so a canonical block can never leave the
 *    requirement set silently;
 *  - every expectation that is not a canonical block must be the container
 *    pseudo id of a canonical list item, so no other node can be quietly
 *    excused.
 */
export function canonicalRequiredNodeExpectations(
  expectations,
  structDocument,
  diagnostics = [],
) {
  const canonicalBlocks = structDocument?.blocks ?? []
  const canonicalIds = new Set(canonicalBlocks.map((block) => block.id))
  const listItemIds = new Set(
    canonicalBlocks
      .filter((block) => block.kind === 'list-item')
      .map((block) => block.id),
  )
  const reported = new Set(
    diagnostics.map((diagnostic) => diagnostic?.nodeId).filter(Boolean),
  )
  const profiles = {}
  for (const [name, profile] of Object.entries(expectations.profiles ?? {})) {
    const nodes = []
    for (const node of profile.nodes ?? []) {
      if (canonicalIds.has(node.id)) {
        nodes.push(node)
        continue
      }
      assert(
        listContainerBaseId(node.id, listItemIds),
        `${name} requires a node that is not canonical content: ${node.id}`,
      )
    }
    const requiredIds = new Set(nodes.map((node) => node.id))
    for (const block of canonicalBlocks) {
      if (requiredIds.has(block.id)) continue
      assert(
        reported.has(block.id),
        `${name} does not require the canonical block ${block.id} and the projection reported no reason for omitting it`,
      )
    }
    const nodeOrder = (profile.nodeOrder ?? []).filter((id) =>
      requiredIds.has(id),
    )
    assert(
      nodeOrder.length === nodes.length,
      `${name} required node order does not cover its required nodes`,
    )
    profiles[name] = { ...profile, nodes, nodeOrder }
  }
  return { ...expectations, profiles }
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

/**
 * Reject a persisted publication graph.
 *
 * The publication graph is never persisted: it is the ephemeral renderer plan
 * between the one projection and the renderer. A `publication-graph.json` in
 * the checked output is a stale artifact of an earlier pipeline, and the
 * checker rejects it instead of reading it. The file is never opened: only
 * its presence is observed.
 */
export async function assertNoPersistedPublicationGraph(root) {
  const path = resolve(root, 'publication-graph.json')
  let present = true
  try {
    await access(path)
  } catch {
    present = false
  }
  if (present)
    throw new Error(
      `Publication output contains a persisted publication graph at ${path}; the publication graph is never persisted and publication:check rejects it`,
    )
}

/**
 * The receipt-bound Struct bundle artifact of one checked output.
 *
 * The artifact is required input for the struct variant, not an optional
 * extra. The read is bounded by the pinned package's own published resource
 * profile: the size is checked BEFORE the bytes are read, and the read
 * itself never allocates more than one byte above that limit, so a file
 * that grew after the size check is refused instead of allocated.
 */
export async function readPublicationStructBundleBytes(root) {
  const path = resolve(root, 'struct-bundle.bin')
  const limit = STRUCT_BUNDLE_LIMITS_PROFILE.maxRawBytes
  let stats
  try {
    stats = await stat(path)
  } catch {
    throw new Error(
      `Publication output is missing its receipt-bound Struct bundle artifact at ${path}; the struct variant requires struct-bundle.bin`,
    )
  }
  if (!stats.isFile())
    throw new Error(
      `Publication output has no Struct bundle artifact file at ${path}`,
    )
  if (stats.size === 0)
    throw new Error(
      `Publication output has an empty Struct bundle artifact at ${path}`,
    )
  if (stats.size > limit)
    throw new Error(
      `Publication Struct bundle artifact exceeds the pinned resource limit at ${path}`,
    )
  const handle = await open(path, 'r')
  try {
    const buffer = new Uint8Array(limit + 1)
    let read = 0
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        read,
        buffer.length - read,
        read,
      )
      if (bytesRead === 0) break
      read += bytesRead
    }
    if (read > limit)
      throw new Error(
        `Publication Struct bundle artifact exceeds the pinned resource limit at ${path}`,
      )
    return buffer.slice(0, read)
  } finally {
    await handle.close()
  }
}

/**
 * The decoded document of a verified bundle handle.
 *
 * The bundle handle carries the byte-free document and the verified asset
 * bytes. Rehydrating the asset bytes and decoding the result with the
 * package's own document codec is what makes the app-style document digest -
 * the digest over the document WITH its asset bytes - comparable with the
 * digest the receipt claims.
 */
function rehydrateStructDocument(handle) {
  const snapshot = handle.documentSnapshot()
  const assets = snapshot.assets.map((asset) => {
    const bytes = handle.assetBytes(asset.id)
    if (!bytes)
      throw new Error(
        `Struct bundle is missing the verified asset bytes of ${asset.id}`,
      )
    return { ...asset, bytes }
  })
  return decodeStructDocument({ ...snapshot, assets })
}

/**
 * Compare every package-identity field of a receipt against the pinned
 * Struct provenance.
 *
 * The provenance file is the only pin authority, and the comparison never
 * reads a path or a pin out of the receipt itself. A mismatch on any of the
 * five fields is a rejection, not a warning.
 */
export async function assertPublicationPackageIdentity(binding) {
  const pin = await readStructPackagePin()
  const expected = {
    packageSourceCommit: pin.sourceCommit,
    packageArtifact: pin.artifact,
    packageArtifactSha256: pin.artifactSha256,
    packageIntegrity: pin.integrity,
    packageVersion: pin.packageVersion,
  }
  for (const [field, value] of Object.entries(expected))
    if (binding[field] !== value)
      throw new Error(
        `Publication receipt package identity does not match the pinned Struct provenance: ${field}`,
      )
  return pin
}

/**
 * The Struct admission of one publication receipt.
 *
 * The source identity of a publication is the Struct binding, so the release
 * check proves it against the receipt-bound wire bytes and not against the
 * receipt's own claim:
 *
 *  - the receipt must be bound to the struct variant, and the strict schema
 *    refuses an unknown field, a malformed digest or a missing digest;
 *  - the bundle digest is required at admission, because the receipt-bound
 *    bundle artifact is;
 *  - the artifact is read with a bounded read and decoded through the
 *    bytes-only ingress with the digest the receipt claims, so a corrupt or
 *    mismatched artifact is refused instead of decoded;
 *  - the decoded document is rehydrated with the verified asset bytes and
 *    compared with the app-style document digest the receipt claims, and
 *    with the package's semantic receipt digest;
 *  - every package-identity field is compared against the pinned provenance.
 *
 * There is no downgrade anywhere on this path: a missing, unreadable,
 * oversized, corrupt, mismatched or forged input is a rejection.
 */
export async function assertPublicationStructAdmission(root, receipt, plan) {
  const binding = assertPublicationPlanSourceBinding(receipt, plan)
  assert(
    typeof binding.bundleSha256 === 'string',
    'Publication receipt is not bound to its Struct bundle wire bytes',
  )
  const bytes = await readPublicationStructBundleBytes(root)
  let handle
  try {
    handle = await decodeStructBundle(bytes, {
      expectedBundleSha256: binding.bundleSha256,
    })
  } catch (error) {
    throw new Error(
      'Publication receipt-bound Struct bundle did not decode into the bundle the receipt names',
      { cause: error },
    )
  }
  const decodedDocument = rehydrateStructDocument(handle)
  assert(
    structDocumentSha256(decodedDocument) === binding.documentSha256,
    'Publication receipt is bound to a different Struct document than the decoded bundle carries',
  )
  assert(
    structReceiptDigest(decodedDocument) === binding.semanticReceiptSha256,
    'Publication receipt is bound to a different Struct semantic receipt than the decoded bundle carries',
  )
  await assertPublicationPackageIdentity(binding)
  return binding
}

export async function publicationCheck(
  argv = process.argv.slice(2),
  execution = {},
) {
  const options = parsePublicationCheckArgs(argv)
  const root = resolve(options.input)
  await assertNoPersistedPublicationGraph(root)
  const structDocument = decodePersistedStructDocument(
    JSON.parse(await readFile(resolve(root, 'struct-document.json'), 'utf8')),
  )
  const structBundle = JSON.parse(
    await readFile(resolve(root, 'struct-bundle.json'), 'utf8'),
  )
  const assetBundleDescriptor = JSON.parse(
    await readFile(resolve(root, 'asset-bundle.json'), 'utf8'),
  )
  const assetBundle = createAssetBundle(assetBundleDescriptor, async () => {
    throw new Error(
      'The persisted asset descriptor carries no asset bytes; the checker never needs them',
    )
  })
  const plan = await publicationPlanFromStructDocument(
    structDocument,
    assetBundle,
  )
  assert(
    structBundle.documentSha256 === plan.structDocumentSha256,
    'Persisted Struct bundle is bound to a different Struct document',
  )
  assert(
    structBundle.bundleSha256 === plan.structBundleSha256,
    'Persisted Struct bundle digest does not match the Struct document',
  )
  const expectations = publicationPlanExpectations(plan)
  const receiptBytes = await readFile(resolve(root, 'publication-receipt.json'))
  const receipt = JSON.parse(receiptBytes.toString('utf8'))
  assertPublicationReceiptPolicyVersions(receipt)
  const requiresCanonicalRouteParity =
    publicationReceiptRequiresCanonicalRouteParity(receipt, execution)
  const publicationAssetPaths = new Map(
    assetBundle.descriptor.assets.map((asset) => [
      asset.id,
      `assets/${asset.id}${publicationAssetFileExtension(asset.fileName, asset.mediaType)}`,
    ]),
  )
  // The graph, asset and canonical-subset digests are diagnostic fields of
  // the receipt: they describe what the render saw, and they are never the
  // source identity. The Struct binding is. An omitted or changed diagnostic
  // therefore never replaces the identity, and a present one still has to be
  // a well-formed digest.
  for (const diagnostic of [
    'graphSha256',
    'assetBundleSha256',
    'canonicalSubsetSha256',
  ]) {
    const value = receipt.source?.[diagnostic]
    if (value === undefined) continue
    assert(
      typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value),
      `Publication receipt diagnostic ${diagnostic} is not a well-formed digest`,
    )
  }
  // The source identity of the publication is the Struct binding: the receipt
  // has to name the very Struct document, bundle and semantic receipt the
  // checked plan was rebuilt from, and the receipt-bound wire bytes have to
  // carry exactly that bundle.
  await assertPublicationStructAdmission(root, receipt, plan)
  assertPublicationReceiptSourceBinding(receipt, plan)
  assert(
    receipt.source?.adapterVersion === '1.0.0' &&
      typeof receipt.source?.sourceId === 'string',
    'Publication source provenance is missing from its receipt',
  )
  assertPublicationReceiptRetiredPayloadSource(receipt)
  const currentRepository = publicationRepositoryForCurrentCheckout(
    execution.cleanlinessExclusions,
  )
  const currentCommit = currentRepository.commit
  assertPublicationReceiptRepositoryBinding(
    receipt,
    currentRepository,
    execution,
  )
  const expectedPdfRenderer = publicationPdfRendererForRuntime()
  const currentPublicationBrowser =
    await publicationBrowserRuntimeEvidenceForCurrentPlatform()
  assertPublicationReceiptRuntime(receipt, currentPublicationBrowser)
  assert(
    receipt.artifacts.length === 4,
    'Publication receipt matrix is incomplete',
  )
  const webpubArtifact = receipt.artifacts.find(
    (artifact) => artifact.profile === 'phone-webpub',
  )
  await checkWebPubReceipt(root, webpubArtifact)
  // The required-node set is derived from the canonical Struct document the
  // receipt is bound to: the document read above is the one the receipt's
  // binding names and the one the receipt-bound wire bytes carry, so the
  // requirement set never depends on a graph projection's synthetic nodes.
  const requiredExpectations = canonicalRequiredNodeExpectations(
    expectations,
    structDocument,
    plan.diagnostics,
  )
  const html = await readFile(resolve(root, 'phone-webpub/index.html'), 'utf8')
  validateWebPubExpectations(
    requiredExpectations,
    html,
    publicationAssetPaths,
  )
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
  validatePublicationProfileContent(
    requiredExpectations.profiles['eink-epub'],
    content ?? '',
    'eink-epub',
    publicationAssetPaths,
  )
  await run('java', ['-jar', epubcheck.path, epubPath])
  const a5Expectations = requiredExpectations.profiles['a5-pdf']
  const pdfRequirements = {
    requireLinks: a5Expectations.pdfRequiresLinks,
    requiredLinks: a5Expectations.pdfLinkRequirements,
    requiredImageCount: a5Expectations.pdfImageAssetIds.length,
    requiredTexts: a5Expectations.pdfTextRequirements,
    widowOrphanTexts: a5Expectations.pdfWidowOrphanTexts,
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
    expectations.title,
    'A5',
    pdfRequirements,
  )
  const a4Pages = await checkPdf(
    resolve(root, 'a4-pdf.pdf'),
    expectations.title,
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
  assertPublicationPdfPageCountPolicy(
    a5Pages,
    a4Pages,
    requiresCanonicalRouteParity,
  )
  assert(
    receipt.profiles['a5-pdf'].figurePlacement !==
      receipt.profiles['a4-pdf'].figurePlacement,
    'A5 and A4 figure placement policies must differ',
  )
  for (const profile of ['a5-pdf', 'a4-pdf'])
    assert(
      receipt.artifacts.find((artifact) => artifact.profile === profile)
        ?.renderer === expectedPdfRenderer,
      `${profile} receipt renderer does not match the ${process.platform}-${process.arch} policy (${expectedPdfRenderer})`,
    )
  if (!requiresCanonicalRouteParity) {
    process.stdout.write(
      `Publication matrix passed structural, accessibility, EPUBCheck, and PDF checks at ${root}\n`,
    )
    return { a5Pages, a4Pages }
  }
  const parity = JSON.parse(
    await readFile(resolve(root, 'astro-route-parity.json'), 'utf8'),
  )
  const expectedHeadings = expectations.headingOrder
  const expectedImageAlternatives = expectations.localImageAlternatives
  // The canonical route is the Astro entry the receipt's source identity
  // names. The route's content is proven by the body and heading parity
  // below, which are specific to the entry.
  const expectedCanonicalRoute = receipt.source?.sourceType === 'astro'
    ? `/blog/${String(receipt.source?.sourceId ?? '').replace(/^blog:/, '')}`
    : undefined
  assert(
    parity.result === 'passed' && parity.version === '1.0.0',
    'Canonical Astro route parity did not pass',
  )
  if (expectedCanonicalRoute)
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
      JSON.stringify(expectations.bodyOrder),
    'Canonical Astro route body parity is stale',
  )
  assert(
    JSON.stringify(parity.localImageAlternatives) ===
      JSON.stringify(expectedImageAlternatives),
    'Canonical Astro route image alternative parity is stale',
  )
  assert(
    parity.structDocumentSha256 === plan.structDocumentSha256,
    'Canonical Astro route parity Struct binding is stale',
  )
  assert(
    parity.sourceBinding?.documentSha256 === plan.structDocumentSha256,
    'Canonical Astro route parity source binding is stale',
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
      JSON.stringify(expectations.bodyOrder),
    'Canonical Astro route body semantics differ from the publication plan',
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
  const expectedImageBindings = expectations.imageBindings
  assert(
    Array.isArray(parity.imageBindings) &&
      parity.imageBindings.length === expectedImageBindings.length,
    'Canonical Astro route image asset bindings are incomplete',
  )
  const assetById = new Map(
    assetBundle.descriptor.assets.map((asset) => [asset.id, asset]),
  )
  for (const [index, binding] of parity.imageBindings.entries()) {
    const expected = expectedImageBindings[index]
    const assetId = expected?.assetId
    const descriptor = assetById.get(assetId)
    const alternativeText = expected?.alternativeText ?? ''
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
