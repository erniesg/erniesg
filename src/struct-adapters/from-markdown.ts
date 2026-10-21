import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import matter from 'gray-matter'
import GithubSlugger from 'github-slugger'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import {
  STRUCT_SCHEMA_VERSION,
  decodeStructDocument,
  type StructAsset,
  type StructBlock,
  type StructBlockKind,
  type StructDocument,
  type StructEvidence,
  type StructInline,
  type StructMetadata,
  type StructRelationship,
} from '@erniesg/struct/document'
import { structDigest, structId } from '@erniesg/struct/identity'

/**
 * The app-owned MDX ingress conversion.
 *
 * The app owns source ingress, extraction and editorial responsibility
 * (ADR-0001); the pinned Struct package owns the neutral document core. This
 * module is therefore the app's own emitter: it re-targets the MDX walk the
 * Astro publication adapter already performs onto a `StructDocument` the
 * package's own validators accept. It is not a second parser and it is not a
 * portable duplicate of the package: it imports only the package's public
 * subpaths.
 */

export type AstroSourceLocator = {
  entryId: string
  contentRoot?: string
}

export type MarkdownConversionSeverity = 'info' | 'warning' | 'error'

/**
 * An app-owned conversion diagnostic. It is deliberately shaped like the
 * publication adapter diagnostic so the publication layer can carry it into
 * the receipt without re-authoring it.
 */
export type MarkdownConversionDiagnostic = {
  severity: MarkdownConversionSeverity
  code: string
  message: string
  nodeId?: string
}

export type AstroStructConversion = {
  /** The Struct document the pinned package accepts. */
  document: StructDocument
  /** The conversion diagnostics, including every recorded style loss. */
  diagnostics: MarkdownConversionDiagnostic[]
  /** The app-owned source identity of the conversion. */
  sourceId: string
  /** The SHA-256 of the exact MDX bytes that produced the document. */
  sourceRevision: string
}

type MdastNode = {
  type: string
  value?: string
  depth?: number
  ordered?: boolean
  start?: number | null
  checked?: boolean | null
  url?: string
  alt?: string
  title?: string
  lang?: string
  identifier?: string
  name?: string
  children?: MdastNode[]
  position?: {
    start: { line: number; column: number }
    end: { line: number; column: number }
  }
}

type InlineStyle = {
  bold?: boolean
  italic?: boolean
  verticalAlign?: 'superscript' | 'subscript'
  compactMathAtom?: boolean
  href?: string
  relationshipId?: string
  targetIds?: string[]
  semanticRole?: 'note-reference'
}

type BlockDraft = {
  kind: StructBlockKind
  id: string
  text: string
  label?: string
  attributes?: Record<string, string | number | boolean>
  inline?: StructInline[]
  fallbackAssetIds?: string[]
}

const MEDIA_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

/**
 * The CSS default replaced-element size. It is the size a browser gives an
 * SVG document that declares neither an intrinsic size nor a view box.
 */
const SVG_DEFAULT_WIDTH = 300
const SVG_DEFAULT_HEIGHT = 150

function digest(value: Uint8Array | string) {
  return createHash('sha256').update(value).digest('hex')
}

function sourceLocation(sourceId: string, node: MdastNode) {
  const point = node.position?.start
  return `${sourceId}:${point?.line ?? '?'}:${point?.column ?? '?'}`
}

function unsupported(sourceId: string, node: MdastNode): never {
  const component =
    node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement'
      ? (node.name ?? 'anonymous')
      : node.type
  throw new Error(
    `Unsupported MDX node ${component} (${node.type}) at ${sourceLocation(sourceId, node)}`,
  )
}

function safeEntryId(entryId: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entryId))
    throw new Error(`Invalid Astro blog entry id: ${entryId}`)
  return entryId
}

function inside(root: string, candidate: string) {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep)
}

function readUInt32BE(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

function readUInt32LE(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset + 3] ?? 0) * 0x1000000 +
      ((bytes[offset + 2] ?? 0) << 16) +
      ((bytes[offset + 1] ?? 0) << 8) +
      (bytes[offset] ?? 0)) >>>
    0
  )
}

function readUInt16BE(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function readUInt16LE(bytes: Uint8Array, offset: number) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function readUIntLE(bytes: Uint8Array, offset: number, length: number) {
  let value = 0
  for (let index = length - 1; index >= 0; index -= 1)
    value = value * 256 + (bytes[offset + index] ?? 0)
  return value
}

function measurePng(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24) return undefined
  if (signature.some((byte, index) => bytes[index] !== byte)) return undefined
  if (
    String.fromCharCode(
      bytes[12] ?? 0,
      bytes[13] ?? 0,
      bytes[14] ?? 0,
      bytes[15] ?? 0,
    ) !== 'IHDR'
  )
    return undefined
  const width = readUInt32BE(bytes, 16)
  const height = readUInt32BE(bytes, 20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

function measureJpeg(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return undefined
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    const length = readUInt16BE(bytes, offset + 2)
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      const height = readUInt16BE(bytes, offset + 5)
      const width = readUInt16BE(bytes, offset + 7)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    offset += 2 + length
  }
  return undefined
}

function measureGif(bytes: Uint8Array) {
  if (bytes.length < 10) return undefined
  if (
    String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0) !==
    'GIF8'
  )
    return undefined
  const width = readUInt16LE(bytes, 6)
  const height = readUInt16LE(bytes, 8)
  return width > 0 && height > 0 ? { width, height } : undefined
}

function measureWebp(bytes: Uint8Array) {
  if (bytes.length < 30) return undefined
  if (
    String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0) !==
      'RIFF' ||
    String.fromCharCode(
      bytes[8] ?? 0,
      bytes[9] ?? 0,
      bytes[10] ?? 0,
      bytes[11] ?? 0,
    ) !== 'WEBP'
  )
    return undefined
  const chunk = String.fromCharCode(
    bytes[12] ?? 0,
    bytes[13] ?? 0,
    bytes[14] ?? 0,
    bytes[15] ?? 0,
  )
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
      return undefined
    const width = readUInt16LE(bytes, 26) & 0x3fff
    const height = readUInt16LE(bytes, 28) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  if (chunk === 'VP8L') {
    const bits = readUInt32LE(bytes, 21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return { width, height }
  }
  if (chunk === 'VP8X') {
    return {
      width: readUIntLE(bytes, 24, 3) + 1,
      height: readUIntLE(bytes, 27, 3) + 1,
    }
  }
  return undefined
}

function measureSvg(bytes: Uint8Array) {
  const source = Buffer.from(bytes).toString('utf8')
  const tag = /<svg\b[^>]*>/i.exec(source)?.[0]
  if (!tag) return undefined
  const width = /\bwidth\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
  const height = /\bheight\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
  const numericWidth = width && /^\d+(?:\.\d+)?$/.test(width) ? Number(width) : undefined
  const numericHeight =
    height && /^\d+(?:\.\d+)?$/.test(height) ? Number(height) : undefined
  if (numericWidth && numericHeight)
    return { width: numericWidth, height: numericHeight }
  const viewBox = /\bviewBox\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
  if (viewBox) {
    const parts = viewBox
      .split(/[\s,]+/)
      .map((part) => Number(part))
      .filter((part) => Number.isFinite(part))
    if (parts.length === 4 && parts[2]! > 0 && parts[3]! > 0)
      return { width: parts[2]!, height: parts[3]! }
  }
  return { width: SVG_DEFAULT_WIDTH, height: SVG_DEFAULT_HEIGHT }
}

/**
 * Measure the intrinsic size of a publication image.
 *
 * The pinned Struct document requires a positive width and height on every
 * asset, so the size is measured from the bytes instead of being invented.
 * SVG documents that declare neither an intrinsic size nor a view box fall
 * back to the CSS default replaced-element size.
 */
function measureImage(bytes: Uint8Array, mediaType: string) {
  if (mediaType === 'image/png') return measurePng(bytes)
  if (mediaType === 'image/jpeg') return measureJpeg(bytes)
  if (mediaType === 'image/gif') return measureGif(bytes)
  if (mediaType === 'image/webp') return measureWebp(bytes)
  if (mediaType === 'image/svg+xml') return measureSvg(bytes)
  return undefined
}

/**
 * The plain text of an MDX node, used to key content-addressed block ids
 * before the inline runs are resolved.
 */
function plainText(node: MdastNode): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'inlineMath':
      return node.value ?? ''
    case 'break':
      return '\n'
    case 'footnoteReference':
      return `[${node.identifier}]`
    case 'image':
      return node.alt ?? ''
    default:
      return (node.children ?? []).map(plainText).join('')
  }
}

/**
 * Build the app-owned Struct document for one MDX entry.
 *
 * The conversion keeps every construct the Astro publication adapter
 * supported. The constructs the pinned Struct document cannot express are
 * reported as `lossy-inline-style` diagnostics; they are never dropped
 * silently.
 */
export async function buildAstroStructDocument(
  locator: AstroSourceLocator,
): Promise<AstroStructConversion> {
  const entryId = safeEntryId(locator.entryId)
  const contentRoot = resolve(locator.contentRoot ?? 'src/content/blog')
  let contentRealRoot: string
  try {
    contentRealRoot = await realpath(contentRoot)
  } catch {
    throw new Error(`Unknown Astro blog collection: ${contentRoot}`)
  }
  const entryDirectory = resolve(contentRoot, entryId)
  if (!inside(contentRoot, entryDirectory))
    throw new Error(`Astro entry escapes the blog collection: ${entryId}`)
  let entryRealDirectory: string
  try {
    entryRealDirectory = await realpath(entryDirectory)
  } catch {
    throw new Error(`Unknown Astro blog entry: ${entryId}`)
  }
  if (!inside(contentRealRoot, entryRealDirectory))
    throw new Error(`Astro entry escapes the blog collection: ${entryId}`)
  const sourcePath = resolve(entryDirectory, 'index.mdx')
  let sourceRealPath: string
  try {
    sourceRealPath = await realpath(sourcePath)
  } catch {
    throw new Error(`Unknown Astro blog entry: ${entryId}`)
  }
  if (!inside(entryRealDirectory, sourceRealPath))
    throw new Error(`Astro entry source escapes the blog collection: ${entryId}`)
  let sourceBytes: Uint8Array
  try {
    sourceBytes = new Uint8Array(await readFile(sourceRealPath))
  } catch {
    throw new Error(`Unknown Astro blog entry: ${entryId}`)
  }
  const source = Buffer.from(sourceBytes).toString('utf8')
  const parsed = matter(source)
  const sourceId = `blog:${entryId}`
  const sourceRevision = digest(sourceBytes)
  const locale = String(parsed.data.lang ?? 'en')
  if (!parsed.data.title || !parsed.data.description || !parsed.data.date)
    throw new Error(`Astro entry ${entryId} is missing required frontmatter`)
  if (parsed.data.image && !parsed.data.imageAlt)
    throw new Error(
      `Astro entry ${entryId} hero image requires authored imageAlt text`,
    )

  const tree = unified()
    .use(remarkParse)
    .use(remarkMdx)
    .use(remarkGfm)
    .use(remarkMath)
    .parse(parsed.content) as MdastNode

  const diagnostics: MarkdownConversionDiagnostic[] = []
  const assets: StructAsset[] = []
  const relationships: StructRelationship[] = []
  const blocks: StructBlock[] = []
  const assetIdsByHash = new Map<string, string>()
  const evidence = (): StructEvidence => ({
    confidence: 1,
    pages: [],
    boxes: [],
    sourceIds: [sourceId],
  })

  const blockIdOccurrences = new Map<string, number>()
  const mintBlockId = (kind: string, key: string) => {
    const occurrenceKey = `${kind}:${key}`
    const occurrence = blockIdOccurrences.get(occurrenceKey) ?? 0
    blockIdOccurrences.set(occurrenceKey, occurrence + 1)
    return structId('block', `${occurrenceKey}:${occurrence}`)
  }

  const relationshipIdOccurrences = new Map<string, number>()
  const mintRelationshipId = (kind: string, from: string, to: string[]) => {
    const key = `${kind}:${from}:${to.join(',')}`
    const occurrence = relationshipIdOccurrences.get(key) ?? 0
    relationshipIdOccurrences.set(key, occurrence + 1)
    return structId('relationship', `${key}:${occurrence}`)
  }

  const addAsset = async (rawPath: string, alt: string) => {
    if (/^[a-z]+:/i.test(rawPath) || rawPath.startsWith('/'))
      throw new Error(`Astro publication assets must be local: ${rawPath}`)
    const path = resolve(entryDirectory, rawPath)
    if (!inside(entryDirectory, path))
      throw new Error(`Astro publication asset escapes its entry: ${rawPath}`)
    let realPath: string
    try {
      realPath = await realpath(path)
    } catch {
      throw new Error(`Astro publication asset is unavailable: ${rawPath}`)
    }
    if (!inside(entryRealDirectory, realPath))
      throw new Error(`Astro publication asset escapes its entry: ${rawPath}`)
    const bytes = new Uint8Array(await readFile(realPath))
    const hash = digest(bytes)
    const existing = assetIdsByHash.get(hash)
    if (existing) return existing
    const extension = extname(path).toLowerCase()
    const mediaType = MEDIA_TYPES[extension]
    if (!mediaType)
      throw new Error(`Unsupported publication image type: ${extension}`)
    const href = relative(entryRealDirectory, realPath).split(sep).join('/')
    if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(href))
      throw new Error(
        `Astro publication asset path is not a canonical EPUB path: ${rawPath}`,
      )
    const measured = measureImage(bytes, mediaType)
    const dimensions = measured ?? { width: 1, height: 1 }
    if (!measured)
      diagnostics.push({
        severity: 'warning',
        code: 'lossy-asset-dimensions',
        message: `Publication asset ${rawPath} (${mediaType}) has no measurable intrinsic size; the pinned Struct document requires one, so 1x1 was recorded.`,
      })
    const id = structId('asset', hash)
    assets.push({
      id,
      kind: 'figure',
      href,
      mediaType,
      sha256: hash,
      width: dimensions.width,
      height: dimensions.height,
      bytes,
      sourceObjectIds: [sourceId],
      evidence: evidence(),
      fallback: 'asset',
    })
    assetIdsByHash.set(hash, id)
    return id
  }

  // Footnote definitions are resolved before their references so every
  // reference can name the footnote block it points at.
  const footnoteDefinitions = new Map<string, MdastNode>()
  for (const block of tree.children ?? [])
    if (block.type === 'footnoteDefinition' && block.identifier)
      footnoteDefinitions.set(block.identifier, block)
  const footnoteBlockIds = new Map<string, string>()
  for (const identifier of footnoteDefinitions.keys())
    footnoteBlockIds.set(identifier, mintBlockId('footnote', identifier))

  // Heading slugs are the authored anchors of the entry. They are resolved
  // before the content is walked so an internal link can name the Struct
  // block it points at.
  const headingSlugger = new GithubSlugger()
  const headingBlockIds = new Map<MdastNode, string>()
  const headingTargets = new Map<string, string>()
  for (const block of tree.children ?? []) {
    if (block.type !== 'heading') continue
    const slug = headingSlugger
      .slug(plainText(block))
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\x00-\x7F]/g, '')
      .replace(/[^A-Za-z0-9._:-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    const id = mintBlockId('heading', plainText(block))
    headingBlockIds.set(block, id)
    if (slug && !headingTargets.has(slug)) headingTargets.set(slug, id)
  }

  const referencedFootnotes = new Set<string>()
  const buildInline = (ownerId: string, children: MdastNode[]) => {
    let text = ''
    const inline: StructInline[] = []
    const append = (value: string, style: InlineStyle = {}) => {
      if (!value) return
      const start = text.length
      text += value
      // The Struct inline model carries the meaningful spans only, exactly
      // like the app's other Struct ingress: plain text is not a run.
      if (Object.keys(style).length) inline.push({ start, end: text.length, ...style })
    }
    const lossy = (style: string) => {
      diagnostics.push({
        severity: 'warning',
        code: 'lossy-inline-style',
        message: `The pinned Struct document has no ${style} style; the ${style} span was reduced to plain text.`,
        nodeId: ownerId,
      })
    }
    const visit = (node: MdastNode, style: InlineStyle = {}) => {
      switch (node.type) {
        case 'text':
          append(node.value ?? '', style)
          break
        case 'strong':
          node.children?.forEach((child) =>
            visit(child, { ...style, bold: true }),
          )
          break
        case 'emphasis':
          node.children?.forEach((child) =>
            visit(child, { ...style, italic: true }),
          )
          break
        case 'delete':
          lossy('strikethrough')
          node.children?.forEach((child) => visit(child, style))
          break
        case 'link': {
          const url = node.url ?? ''
          if (url.startsWith('#')) {
            const target = headingTargets.get(url.slice(1))
            if (target) {
              const relationshipId = mintRelationshipId(
                'hyperlink',
                ownerId,
                [target],
              )
              relationships.push({
                id: relationshipId,
                kind: 'hyperlink',
                from: ownerId,
                to: [target],
                status: 'matched',
                confidence: 1,
                evidence: evidence(),
              })
              node.children?.forEach((child) =>
                visit(child, {
                  ...style,
                  href: `#${target}`,
                  relationshipId,
                  targetIds: [target],
                }),
              )
              break
            }
            diagnostics.push({
              severity: 'warning',
              code: 'unresolved-link-target',
              message: `The link ${url} does not name a heading in this entry; its destination was dropped.`,
              nodeId: ownerId,
            })
            node.children?.forEach((child) => visit(child, style))
            break
          }
          node.children?.forEach((child) => visit(child, { ...style, href: url }))
          break
        }
        case 'inlineCode':
          lossy('inline code')
          append(node.value ?? '', style)
          break
        case 'inlineMath':
          append(node.value ?? '', { ...style, compactMathAtom: true })
          break
        case 'break':
          lossy('hard break')
          append('\n', style)
          break
        case 'footnoteReference': {
          const identifier = node.identifier ?? 'unknown'
          const target = footnoteBlockIds.get(identifier)
          if (!target) {
            // A reference without a definition cannot be represented: the
            // pinned Struct document rejects a dangling note target. The
            // adapter failed on this construct before the re-target as well.
            throw new Error(
              `Unsupported footnote reference [${identifier}] without a definition at ${sourceLocation(sourceId, node)}`,
            )
          }
          referencedFootnotes.add(identifier)
          const relationshipId = mintRelationshipId('footnote', ownerId, [target])
          relationships.push({
            id: relationshipId,
            kind: 'footnote',
            from: ownerId,
            to: [target],
            status: 'matched',
            confidence: 1,
            evidence: evidence(),
          })
          append(`[${node.identifier}]`, {
            ...style,
            relationshipId,
            targetIds: [target],
            semanticRole: 'note-reference',
            verticalAlign: 'superscript',
          })
          break
        }
        case 'image':
          unsupported(sourceId, node)
        default:
          unsupported(sourceId, node)
      }
    }
    children.forEach((child) => visit(child))
    return { text, inline }
  }

  const emit = (draft: BlockDraft) => {
    blocks.push({
      id: draft.id,
      kind: draft.kind,
      text: draft.text,
      ...(draft.label === undefined ? {} : { label: draft.label }),
      page: null,
      order: blocks.length,
      column: null,
      inline: draft.inline ?? [],
      evidence: evidence(),
      ...(draft.attributes ? { attributes: draft.attributes } : {}),
      ...(draft.fallbackAssetIds
        ? { fallbackAssetIds: draft.fallbackAssetIds }
        : {}),
    })
  }

  const emitList = (list: MdastNode, level: number) => {
    const items = list.children ?? []
    const ordered = Boolean(list.ordered)
    const start = typeof list.start === 'number' ? list.start : 1
    items.forEach((item, index) => {
      if (item.checked !== undefined && item.checked !== null)
        throw new Error(
          `Unsupported task-list item at ${sourceLocation(sourceId, item)}`,
        )
      const children = item.children ?? []
      const paragraph = children[0]
      if (!paragraph || paragraph.type !== 'paragraph')
        unsupported(sourceId, item)
      const id = mintBlockId('list-item', plainText(item))
      const { text, inline } = buildInline(id, paragraph.children ?? [])
      emit({
        kind: 'list-item',
        id,
        text,
        inline,
        attributes: {
          listLevel: level,
          listOrdered: ordered,
          listOrdinal: start + index,
        },
      })
      for (const child of children.slice(1)) {
        if (child.type !== 'list') unsupported(sourceId, child)
        emitList(child, level + 1)
      }
    })
  }

  if (parsed.data.image) {
    const alt = String(parsed.data.imageAlt)
    const assetId = await addAsset(String(parsed.data.image), alt)
    const id = mintBlockId('figure', alt)
    emit({
      kind: 'figure',
      id,
      text: '',
      label: alt,
      attributes: { alternativeText: alt },
      fallbackAssetIds: [assetId],
    })
    relationships.push({
      id: mintRelationshipId('figure', id, [assetId]),
      kind: 'figure',
      from: id,
      to: [assetId],
      status: 'matched',
      confidence: 1,
      evidence: evidence(),
    })
  }

  for (const block of tree.children ?? []) {
    if (block.type.startsWith('mdx') || block.type === 'html')
      unsupported(sourceId, block)
    if (block.type === 'heading') {
      const id =
        headingBlockIds.get(block) ??
        mintBlockId('heading', plainText(block))
      const { text, inline } = buildInline(id, block.children ?? [])
      emit({
        kind: 'heading',
        id,
        text,
        inline,
        attributes: { level: block.depth ?? 2 },
      })
    } else if (block.type === 'paragraph') {
      const image = block.children?.length === 1 ? block.children[0] : undefined
      if (image?.type === 'image') {
        if (!image.alt)
          throw new Error(
            `Image missing alt text at ${sourceLocation(sourceId, image)}`,
          )
        const alt = String(image.alt)
        const assetId = await addAsset(image.url ?? '', alt)
        const id = mintBlockId('figure', alt)
        emit({
          kind: 'figure',
          id,
          text: image.title ?? '',
          label: alt,
          attributes: { alternativeText: alt },
          fallbackAssetIds: [assetId],
        })
        relationships.push({
          id: mintRelationshipId('figure', id, [assetId]),
          kind: 'figure',
          from: id,
          to: [assetId],
          status: 'matched',
          confidence: 1,
          evidence: evidence(),
        })
        if (image.title) {
          const captionId = mintBlockId('caption', String(image.title))
          emit({
            kind: 'caption',
            id: captionId,
            text: String(image.title),
          })
          relationships.push({
            id: mintRelationshipId('caption', id, [captionId]),
            kind: 'caption',
            from: id,
            to: [captionId],
            status: 'matched',
            confidence: 1,
            evidence: evidence(),
          })
        }
      } else {
        const id = mintBlockId('paragraph', plainText(block))
        const { text, inline } = buildInline(id, block.children ?? [])
        if (!text) continue
        emit({ kind: 'paragraph', id, text, inline })
      }
    } else if (block.type === 'list') {
      emitList(block, 0)
    } else if (block.type === 'blockquote') {
      const paragraphs = block.children ?? []
      if (
        paragraphs.length !== 1 ||
        paragraphs.some((child) => child.type !== 'paragraph')
      )
        unsupported(sourceId, block)
      const id = mintBlockId('quote', plainText(block))
      const { text, inline } = buildInline(id, paragraphs[0].children ?? [])
      emit({ kind: 'quote', id, text, inline })
    } else if (block.type === 'code') {
      const id = mintBlockId('code', block.value ?? '')
      emit({
        kind: 'code',
        id,
        text: block.value ?? '',
        ...(block.lang ? { attributes: { language: block.lang } } : {}),
      })
    } else if (block.type === 'math') {
      const id = mintBlockId('equation', block.value ?? '')
      emit({
        kind: 'equation',
        id,
        text: block.value ?? '',
        attributes: { equationFormat: 'latex' },
      })
    } else if (block.type === 'footnoteDefinition') {
      continue
    } else if (block.type === 'thematicBreak') {
      unsupported(sourceId, block)
    } else {
      unsupported(sourceId, block)
    }
  }

  for (const [identifier, definition] of footnoteDefinitions) {
    const paragraphs = definition.children ?? []
    if (
      !referencedFootnotes.has(identifier) ||
      paragraphs.length !== 1 ||
      paragraphs[0]?.type !== 'paragraph'
    )
      unsupported(sourceId, definition)
    const id = footnoteBlockIds.get(identifier)!
    const { text, inline } = buildInline(id, paragraphs[0].children ?? [])
    emit({ kind: 'footnote', id, text, label: identifier, inline })
  }

  const metadata: StructMetadata = {
    title: String(parsed.data.title),
    subtitle: '',
    authors: (parsed.data.authors ?? []).map((author: unknown) => String(author)),
    abstract: String(parsed.data.description),
    ...(locale ? { language: locale } : {}),
    ...(publicationDate(parsed.data.date)
      ? { publicationDate: publicationDate(parsed.data.date)! }
      : {}),
    ...(publicationDate(parsed.data.updated)
      ? { updated: publicationDate(parsed.data.updated)! }
      : {}),
  }

  const documentId = `publication-${entryId}`
  const sourceDescriptor = {
    format: 'html' as const,
    fileName: `${entryId}/index.mdx`,
    sha256: sourceRevision,
    byteLength: sourceBytes.byteLength,
    pageCount: 0,
    localOnly: true,
  }
  const textCharacterCount = blocks.reduce(
    (count, block) => count + block.text.length,
    0,
  )
  const conservation = {
    sourceNodeCount: blocks.length,
    accountedSourceNodeCount: blocks.length,
    sourceRegionCount: 0,
    accountedSourceRegionCount: 0,
    sourceAnnotationCount: 0,
    accountedSourceAnnotationCount: 0,
    sourceAssetCount: assets.length,
    accountedSourceAssetCount: assets.length,
    sourceRelationshipCount: relationships.length,
    accountedSourceRelationshipCount: relationships.length,
    sourceDiagnosticCount: 0,
    accountedSourceDiagnosticCount: 0,
    sourceTextCharacterCount: textCharacterCount,
    structBlockCount: blocks.length,
    structAssetCount: assets.length,
    structRelationshipCount: relationships.length,
    structDiagnosticCount: 0,
    structTextCharacterCount: textCharacterCount,
  }
  const withoutReceipt = {
    schemaVersion: STRUCT_SCHEMA_VERSION,
    documentId,
    source: sourceDescriptor,
    metadata,
    blocks,
    assets,
    relationships,
    pages: [],
    diagnostics: [],
    recovery: {
      status: 'ready' as const,
      title: 'The MDX entry converted without unresolved content.',
      summary: `The app-owned MDX ingress converted ${blocks.length} blocks, ${assets.length} assets and ${relationships.length} relationships.`,
      issues: [],
    },
  }
  const generatedSha256 = structDigest({
    ...withoutReceipt,
    conservation,
    assets: assets.map(({ bytes: _bytes, ...asset }) => asset),
  })
  const document: StructDocument = {
    ...withoutReceipt,
    receipt: {
      schemaVersion: STRUCT_SCHEMA_VERSION,
      documentId,
      sourceSha256: sourceRevision,
      blockCount: blocks.length,
      assetCount: assets.length,
      relationshipCount: relationships.length,
      diagnosticCount: 0,
      textCharacterCount,
      conservation,
      generatedSha256,
    },
  }
  // The pinned package's own validators are the authority: a document the
  // package cannot decode is a bug, not a style choice.
  decodeStructDocument(document)
  return { document, diagnostics, sourceId, sourceRevision }
}

/**
 * The publication date of an entry, as the RFC 3339 full date the pinned
 * Struct document requires. A value that is not a calendar date is omitted
 * rather than guessed.
 */
function publicationDate(value: unknown): string | undefined {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined
    return value.toISOString().slice(0, 10)
  }
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  if (month < 1 || month > 12 || day < 1 || day > (daysInMonth[month - 1] ?? 0))
    return undefined
  return value
}
