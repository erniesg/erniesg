import { strFromU8, unzipSync } from 'fflate'
import {
  defaultTreeAdapter,
  html,
  parse,
  serializeOuter,
  type DefaultTreeAdapterTypes,
} from 'parse5'
import {
  MAX_EPUB_ASSETS_PER_BOOK,
  MAX_EPUB_ASSET_BYTES_PER_BOOK,
  type EpubExport,
} from './epub'

export const EPUB_PREVIEW_CSP =
  "default-src 'none'; script-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; font-src 'none'; object-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'"

export const EPUB_PREVIEW_DEFAULT_LIMITS = {
  archiveBytes: 160 * 1024 * 1024,
  entryCount: MAX_EPUB_ASSETS_PER_BOOK + 32,
  inflatedBytes: 168 * 1024 * 1024,
  documentBytes: 32 * 1024 * 1024,
  stylesheetBytes: 4 * 1024 * 1024,
  assetCount: MAX_EPUB_ASSETS_PER_BOOK,
  assetBytes: MAX_EPUB_ASSET_BYTES_PER_BOOK,
  documentNodes: 200_000,
  documentDepth: 128,
  embeddedObjectReferences: 128,
  embeddedObjectDepth: 8,
} as const

export type EpubPreviewLimits = {
  [Key in keyof typeof EPUB_PREVIEW_DEFAULT_LIMITS]: number
}

export type EpubPreviewAsset = {
  href: string
  mediaType: string
  bytes: Uint8Array
}

export type EpubPreviewTemplate = {
  segments: string[]
  assetIndices: number[]
}

export type EpubPreviewPayload = {
  template: EpubPreviewTemplate
  assets: EpubPreviewAsset[]
}

export type PreviewableEpubExport = EpubExport & {
  preview: EpubPreviewPayload
}

type PreviewDocument = DefaultTreeAdapterTypes.Document
type PreviewParent = DefaultTreeAdapterTypes.ParentNode
type PreviewChild = DefaultTreeAdapterTypes.ChildNode
type PreviewElement = DefaultTreeAdapterTypes.Element

const blockedElements = new Set([
  'script',
  'iframe',
  'frame',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'base',
  'style',
  'template',
])

const HTML_NAMESPACE = html.NS.HTML
const CONTENT_PATH = 'EPUB/content.xhtml'
const STYLESHEET_PATH = 'EPUB/styles.css'
const ASSET_PREFIX = 'EPUB/assets/'

export function safePreviewCss(value: string) {
  return value
    .replace(/@import[\s\S]*?(?:;|$)/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none')
    .replace(/<\s*\/?\s*style/gi, '')
}

export function buildExternalLinkReceipt(href: string, accessibleName: string) {
  const label = accessibleName.trim() || href
  return {
    role: 'link',
    tabIndex: 0,
    originalHref: href,
    ariaLabel: `${label} (link disabled in preview)`,
  }
}

export function composePreviewCss(epubCss: string) {
  return `${safePreviewCss(epubCss)}
html { color-scheme: light; background: #fff; }
body { margin: 0; }
.epub-embedded-table { overflow-x: auto; }
img { max-width: 100%; height: auto; }
[data-review-navigation-target="true"] {
  outline: 0.15rem solid #b45309;
  outline-offset: 0.18rem;
  background: #fff7ed;
  scroll-margin-block-start: 1rem;
}`
}

function resourceLimitError(resource: string, actual: number, maximum: number) {
  return new Error(
    `EPUB preview resource limit exceeded: ${resource} is ${actual}; maximum is ${maximum}.`,
  )
}

function assertBounded(resource: string, actual: number, maximum: number) {
  if (!Number.isSafeInteger(actual) || actual < 0 || actual > maximum) {
    throw resourceLimitError(resource, actual, maximum)
  }
}

function resolvedLimits(
  limits: Partial<EpubPreviewLimits> | undefined,
): EpubPreviewLimits {
  const resolved = { ...EPUB_PREVIEW_DEFAULT_LIMITS, ...limits }
  for (const [resource, maximum] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) {
      throw new Error(
        `EPUB preview resource limit is invalid: ${resource} must be a non-negative safe integer.`,
      )
    }
  }
  return resolved
}

function safeAssetHref(value: string) {
  if (
    !value.startsWith('assets/') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null
  }
  const segments = value.split('/')
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z0-9._-]+$/.test(segment),
    )
  ) {
    return null
  }
  return value
}

function mediaTypeForImage(href: string) {
  const lowerHref = href.toLowerCase()
  if (lowerHref.endsWith('.svg')) return 'image/svg+xml'
  if (lowerHref.endsWith('.png')) return 'image/png'
  if (lowerHref.endsWith('.gif')) return 'image/gif'
  if (lowerHref.endsWith('.webp')) return 'image/webp'
  if (lowerHref.endsWith('.jpg') || lowerHref.endsWith('.jpeg')) {
    return 'image/jpeg'
  }
  return null
}

function isElement(node: PreviewChild): node is PreviewElement {
  return defaultTreeAdapter.isElementNode(node)
}

function attribute(element: PreviewElement, name: string) {
  return element.attrs.find(
    (candidate) => candidate.name.toLowerCase() === name,
  )?.value
}

function removeAttribute(element: PreviewElement, name: string) {
  element.attrs = element.attrs.filter(
    (candidate) => candidate.name.toLowerCase() !== name,
  )
}

function setAttribute(element: PreviewElement, name: string, value: string) {
  removeAttribute(element, name)
  element.attrs.push({ name, value })
}

function textContent(node: PreviewParent | PreviewChild): string {
  if (defaultTreeAdapter.isTextNode(node)) return node.value
  if (!('childNodes' in node)) return ''
  return node.childNodes.map((child) => textContent(child)).join('')
}

function replaceChild(
  parent: PreviewParent,
  index: number,
  replacements: PreviewChild[],
) {
  const removed = parent.childNodes[index]
  if (removed && 'parentNode' in removed) removed.parentNode = null
  for (const replacement of replacements) {
    if ('parentNode' in replacement) replacement.parentNode = parent
  }
  parent.childNodes.splice(index, 1, ...replacements)
}

function createElement(
  tagName: string,
  attrs: Array<{ name: string; value: string }> = [],
) {
  return defaultTreeAdapter.createElement(tagName, HTML_NAMESPACE, attrs)
}

function appendChild(parent: PreviewParent, child: PreviewChild) {
  defaultTreeAdapter.appendChild(parent, child)
}

function findElement(
  node: PreviewParent | PreviewChild,
  tagName: string,
): PreviewElement | undefined {
  if (defaultTreeAdapter.isElementNode(node) && node.tagName === tagName) {
    return node
  }
  if (!('childNodes' in node)) return undefined
  for (const child of node.childNodes) {
    const match = findElement(child, tagName)
    if (match) return match
  }
  return undefined
}

function sanitizedMarkerNamespace(
  sourceStrings: readonly string[],
  markerNonce: string | undefined,
) {
  const nonce = (markerNonce ?? 'preview')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 96)
  let markerNamespace = `__EPUB_PREVIEW_ASSET_${nonce || 'preview'}_`
  while (sourceStrings.some((source) => source.includes(markerNamespace))) {
    markerNamespace += '_'
  }
  return markerNamespace
}

function splitAssetMarkers(
  serialized: string,
  markerNamespace: string,
  markerCount: number,
): EpubPreviewTemplate {
  if (markerCount === 0) {
    return { segments: [serialized], assetIndices: [] }
  }
  const markerPattern = new RegExp(
    `${markerNamespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)__`,
    'g',
  )
  const segments: string[] = []
  const assetIndices: number[] = []
  let cursor = 0
  for (const match of serialized.matchAll(markerPattern)) {
    const offset = match.index
    const assetIndex = Number(match[1])
    if (
      !Number.isSafeInteger(assetIndex) ||
      assetIndex < 0 ||
      assetIndex >= markerCount
    ) {
      throw new Error('EPUB preview compiler produced an invalid asset marker.')
    }
    segments.push(serialized.slice(cursor, offset))
    assetIndices.push(assetIndex)
    cursor = offset + match[0].length
  }
  segments.push(serialized.slice(cursor))
  return { segments, assetIndices }
}

function extractBoundedArchive(archive: Uint8Array, limits: EpubPreviewLimits) {
  assertBounded('archive bytes', archive.byteLength, limits.archiveBytes)
  let entryCount = 0
  let inflatedBytes = 0
  let assetCount = 0
  let assetBytes = 0
  return unzipSync(archive, {
    filter(file) {
      entryCount += 1
      assertBounded('entry count', entryCount, limits.entryCount)
      inflatedBytes += file.originalSize
      assertBounded(
        'inflated archive bytes',
        inflatedBytes,
        limits.inflatedBytes,
      )
      if (file.name === CONTENT_PATH) {
        assertBounded(
          'spine document bytes',
          file.originalSize,
          limits.documentBytes,
        )
        return true
      }
      if (file.name === STYLESHEET_PATH) {
        assertBounded(
          'stylesheet bytes',
          file.originalSize,
          limits.stylesheetBytes,
        )
        return true
      }
      if (file.name.startsWith(ASSET_PREFIX)) {
        assetCount += 1
        assetBytes += file.originalSize
        assertBounded('asset count', assetCount, limits.assetCount)
        assertBounded('asset bytes', assetBytes, limits.assetBytes)
        if (file.name.toLowerCase().endsWith('.xhtml')) {
          assertBounded(
            'embedded document bytes',
            file.originalSize,
            limits.documentBytes,
          )
        }
        return true
      }
      return false
    },
  })
}

type PreviewSanitizationState = {
  limits: EpubPreviewLimits
  documentNodes: number
  embeddedObjectReferences: number
}

function accountDocumentTree(
  document: PreviewDocument,
  state: PreviewSanitizationState,
) {
  const pending: Array<{
    node: PreviewParent | PreviewChild
    depth: number
  }> = [{ node: document, depth: 0 }]
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!
    state.documentNodes += 1
    assertBounded(
      'document nodes',
      state.documentNodes,
      state.limits.documentNodes,
    )
    assertBounded('document depth', depth, state.limits.documentDepth)
    if (!('childNodes' in node)) continue
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      pending.push({ node: node.childNodes[index], depth: depth + 1 })
    }
  }
}

function sanitizeDocument({
  document,
  files,
  limits,
}: {
  document: PreviewDocument
  files: Record<string, Uint8Array>
  limits: EpubPreviewLimits
}) {
  const assets: EpubPreviewAsset[] = []
  const assetIndices = new Map<string, number>()
  const references: Array<{ element: PreviewElement; assetIndex: number }> = []
  const state: PreviewSanitizationState = {
    limits,
    documentNodes: 0,
    embeddedObjectReferences: 0,
  }
  accountDocumentTree(document, state)

  const assetIndex = (href: string, mediaType: string, bytes: Uint8Array) => {
    let index = assetIndices.get(href)
    if (index === undefined) {
      index = assets.length
      assetIndices.set(href, index)
      assets.push({
        href,
        mediaType,
        bytes,
      })
    }
    return index
  }

  const sanitizeChildren = (
    parent: PreviewParent,
    embeddedStack: readonly string[],
  ) => {
    let childIndex = 0
    while (childIndex < parent.childNodes.length) {
      const child = parent.childNodes[childIndex]
      if (!isElement(child)) {
        childIndex += 1
        continue
      }
      const tagName = child.tagName.toLowerCase()
      if (blockedElements.has(tagName)) {
        replaceChild(parent, childIndex, [])
        continue
      }
      if (tagName === 'meta' && attribute(child, 'http-equiv') !== undefined) {
        replaceChild(parent, childIndex, [])
        continue
      }
      if (
        tagName === 'link' &&
        (attribute(child, 'rel') ?? '')
          .toLowerCase()
          .split(/\s+/)
          .includes('stylesheet')
      ) {
        replaceChild(parent, childIndex, [])
        continue
      }
      for (const candidate of [...child.attrs]) {
        const name = candidate.name.toLowerCase()
        if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
          removeAttribute(child, candidate.name)
        }
      }
      if (
        (tagName === 'a' || tagName === 'area') &&
        attribute(child, 'href') !== undefined
      ) {
        const href = attribute(child, 'href') ?? ''
        if (!href.startsWith('#')) {
          const receipt = buildExternalLinkReceipt(
            href,
            attribute(child, 'aria-label') ?? textContent(child),
          )
          removeAttribute(child, 'href')
          setAttribute(child, 'role', receipt.role)
          setAttribute(child, 'tabindex', String(receipt.tabIndex))
          setAttribute(child, 'data-original-href', receipt.originalHref)
          setAttribute(child, 'aria-label', receipt.ariaLabel)
        }
      }
      if (tagName === 'img' && attribute(child, 'src') !== undefined) {
        const href = safeAssetHref(attribute(child, 'src') ?? '')
        const bytes = href ? files[`EPUB/${href}`] : undefined
        const mediaType = href ? mediaTypeForImage(href) : null
        if (!href || !bytes || !mediaType) {
          removeAttribute(child, 'src')
        } else {
          removeAttribute(child, 'src')
          references.push({
            element: child,
            assetIndex: assetIndex(href, mediaType, bytes),
          })
        }
      }
      if (tagName === 'object') {
        const fallback = defaultTreeAdapter.createTextNode(textContent(child))
        const href = safeAssetHref(attribute(child, 'data') ?? '')
        const embedded = href ? files[`EPUB/${href}`] : undefined
        if (
          !href ||
          !embedded ||
          (attribute(child, 'type') ?? '').toLowerCase() !==
            'application/xhtml+xml'
        ) {
          replaceChild(parent, childIndex, [fallback])
          childIndex += 1
          continue
        }
        if (embeddedStack.includes(href)) {
          replaceChild(parent, childIndex, [fallback])
          childIndex += 1
          continue
        }
        state.embeddedObjectReferences += 1
        assertBounded(
          'embedded object references',
          state.embeddedObjectReferences,
          limits.embeddedObjectReferences,
        )
        const embeddedDepth = embeddedStack.length + 1
        assertBounded(
          'embedded object depth',
          embeddedDepth,
          limits.embeddedObjectDepth,
        )
        const embeddedDocument = parse(strFromU8(embedded))
        accountDocumentTree(embeddedDocument, state)
        const table = findElement(embeddedDocument, 'table')
        if (!table) {
          replaceChild(parent, childIndex, [fallback])
          childIndex += 1
          continue
        }
        if (table.parentNode) {
          const tableIndex = table.parentNode.childNodes.indexOf(table)
          if (tableIndex >= 0) table.parentNode.childNodes.splice(tableIndex, 1)
        }
        const wrapper = createElement('div', [
          { name: 'class', value: 'epub-embedded-table' },
        ])
        appendChild(wrapper, table)
        replaceChild(parent, childIndex, [wrapper])
        sanitizeChildren(wrapper, [...embeddedStack, href])
        childIndex += 1
        continue
      }
      sanitizeChildren(child, embeddedStack)
      childIndex += 1
    }
  }

  sanitizeChildren(document, [])
  return { assets, references }
}

export function compileEpubPreviewArchive(
  archive: Uint8Array,
  {
    markerNonce,
    limits: limitOverrides,
  }: {
    markerNonce?: string
    limits?: Partial<EpubPreviewLimits>
  } = {},
): EpubPreviewPayload {
  const limits = resolvedLimits(limitOverrides)
  const files = extractBoundedArchive(archive, limits)
  const content = files[CONTENT_PATH]
  if (!content) throw new Error('EPUB spine content is missing.')
  const stylesheet = files[STYLESHEET_PATH]
  const contentSource = strFromU8(content)
  const stylesheetSource = stylesheet ? strFromU8(stylesheet) : ''
  const document = parse(contentSource)
  const { assets, references } = sanitizeDocument({
    document,
    files,
    limits,
  })
  const html = findElement(document, 'html')
  const head = findElement(document, 'head')
  if (!html || !head) {
    throw new Error('EPUB preview document does not contain an HTML root.')
  }
  const policy = createElement('meta', [
    { name: 'http-equiv', value: 'Content-Security-Policy' },
    { name: 'content', value: EPUB_PREVIEW_CSP },
  ])
  policy.parentNode = head
  head.childNodes.unshift(policy)
  const style = createElement('style')
  appendChild(
    style,
    defaultTreeAdapter.createTextNode(composePreviewCss(stylesheetSource)),
  )
  appendChild(head, style)
  const collisionProbe = `<!DOCTYPE html>${serializeOuter(html)}`
  const markerNamespace = sanitizedMarkerNamespace(
    [collisionProbe],
    markerNonce,
  )
  for (const reference of references) {
    setAttribute(
      reference.element,
      'src',
      `${markerNamespace}${reference.assetIndex}__`,
    )
  }
  const serialized = `<!DOCTYPE html>${serializeOuter(html)}`
  const template = splitAssetMarkers(serialized, markerNamespace, assets.length)
  return { template, assets }
}

export function epubPreviewPayload(
  epub: EpubExport,
): EpubPreviewPayload | undefined {
  return (epub as Partial<PreviewableEpubExport>).preview
}

export function withEpubPreviewPayload(
  epub: EpubExport,
  preview: EpubPreviewPayload,
): PreviewableEpubExport {
  return { ...epub, preview }
}
