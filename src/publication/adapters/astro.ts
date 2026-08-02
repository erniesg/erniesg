import { createHash } from 'node:crypto'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { basename, extname, relative, resolve, sep } from 'node:path'
import matter from 'gray-matter'
import GithubSlugger from 'github-slugger'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { createAssetBundle, type AssetDescriptor } from '../asset-bundle'
import {
  PUBLICATION_GRAPH_VERSION,
  publicationGraphSchema,
  type PublicationInlineRun,
  type PublicationNode,
} from '../schema'
import {
  PUBLICATION_SOURCE_ADAPTER_VERSION,
  validatePublicationSourceResult,
  type PublicationSourceAdapter,
  type PublicationSourceResult,
} from '../source-adapter'

export type AstroSourceLocator = {
  entryId: string
  contentRoot?: string
}

type MdastNode = {
  type: string
  value?: string
  depth?: number
  ordered?: boolean
  start?: number
  url?: string
  alt?: string
  title?: string
  lang?: string
  identifier?: string
  children?: MdastNode[]
  position?: {
    start: { line: number; column: number }
    end: { line: number; column: number }
  }
}

type InlineResult = { text: string; inlineRuns: PublicationInlineRun[] }

const MEDIA_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

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
      ? ((node as MdastNode & { name?: string }).name ?? 'anonymous')
      : node.type
  throw new Error(
    `Unsupported MDX node ${component} (${node.type}) at ${sourceLocation(sourceId, node)}`,
  )
}

function inlineContent(
  sourceId: string,
  children: MdastNode[] = [],
): InlineResult {
  let text = ''
  const inlineRuns: PublicationInlineRun[] = []
  const append = (
    value: string,
    style?: Omit<PublicationInlineRun, 'start' | 'end'>,
  ) => {
    if (!value) return
    const start = text.length
    text += value
    if (style) inlineRuns.push({ start, end: text.length, ...style })
  }
  const visit = (
    node: MdastNode,
    style: Omit<PublicationInlineRun, 'start' | 'end'> = {},
  ) => {
    switch (node.type) {
      case 'text':
        append(node.value ?? '', Object.keys(style).length ? style : undefined)
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
        node.children?.forEach((child) => visit(child, style))
        break
      case 'link':
        node.children?.forEach((child) =>
          visit(child, { ...style, href: node.url }),
        )
        break
      case 'inlineCode':
        append(node.value ?? '', { ...style, inlineCode: true })
        break
      case 'inlineMath':
        append(node.value ?? '', { ...style, compactMathAtom: true })
        break
      case 'break':
        append('\n')
        break
      case 'footnoteReference': {
        const id = `note-${node.identifier}`
        append(`[${node.identifier}]`, {
          ...style,
          relationshipId: `ref-${node.identifier}`,
          semanticRole: 'cross-reference',
          targetIds: [id],
          verticalAlign: 'superscript',
          href: `#${id}`,
        })
        break
      }
      case 'image':
        unsupported(sourceId, node)
      default:
        if (node.type.startsWith('mdx') || node.type === 'html')
          unsupported(sourceId, node)
        unsupported(sourceId, node)
    }
  }
  children.forEach((child) => visit(child))
  return { text, inlineRuns }
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

function baseNode(
  id: string,
  sourceId: string,
  locale: string,
  sourceRevision: string,
) {
  return {
    id,
    locale,
    direction: 'auto' as const,
    requirement: 'required' as const,
    importance: 'essential' as const,
    provenance: {
      adapterId: 'astro',
      sourceId,
      sourceRevision,
      evidence: [sourceId],
    },
    accessibility: { decorative: false },
    variants: [],
    permittedTransformationIds: [],
    edition: { editionId: `edition-${locale}`, sourceLocaleKey: sourceId },
  }
}

export async function adaptAstroBlogEntry(
  locator: AstroSourceLocator,
): Promise<PublicationSourceResult> {
  const entryId = safeEntryId(locator.entryId)
  const contentRoot = resolve(locator.contentRoot ?? 'src/content/blog')
  const entryDirectory = resolve(contentRoot, entryId)
  if (!inside(contentRoot, entryDirectory))
    throw new Error(`Astro entry escapes the blog collection: ${entryId}`)
  const sourcePath = resolve(entryDirectory, 'index.mdx')
  let source: string
  try {
    source = await readFile(sourcePath, 'utf8')
  } catch {
    throw new Error(`Unknown Astro blog entry: ${entryId}`)
  }
  const parsed = matter(source)
  const sourceId = `blog:${entryId}`
  const sourceRevision = digest(source)
  const locale = parsed.data.lang ?? 'en'
  const translationKey = parsed.data.translationKey ?? entryId
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
  const nodes: PublicationNode[] = []
  const assetBytes = new Map<string, Uint8Array>()
  const assets: AssetDescriptor[] = []
  let nodeSequence = 0
  const usedNodeIds = new Set<string>()
  const headingSlugger = new GithubSlugger()
  const nextId = (kind: string) => {
    const id = `${kind}-${++nodeSequence}`
    usedNodeIds.add(id)
    return id
  }
  const nextHeadingId = (text: string) => {
    let id = headingSlugger.slug(text)
    if (!id) return nextId('heading')
    while (usedNodeIds.has(id)) id = headingSlugger.slug(text)
    usedNodeIds.add(id)
    return id
  }
  let entryRealDirectory: string
  try {
    entryRealDirectory = await realpath(entryDirectory)
  } catch {
    throw new Error(`Unknown Astro blog entry: ${entryId}`)
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
    const existing = assets.find((asset) => asset.sha256 === hash)
    if (existing) return existing.id
    const extension = extname(path).toLowerCase()
    const mediaType = MEDIA_TYPES[extension]
    if (!mediaType)
      throw new Error(`Unsupported publication image type: ${extension}`)
    const id = `asset-${hash.slice(0, 16)}`
    const descriptor: AssetDescriptor = {
      id,
      sha256: hash,
      byteLength: bytes.byteLength,
      mediaType,
      fileName: basename(path),
      accessibilityLabel: alt,
    }
    assets.push(descriptor)
    assetBytes.set(id, bytes)
    return id
  }

  if (parsed.data.image) {
    const assetId = await addAsset(parsed.data.image, parsed.data.imageAlt)
    nodes.push({
      ...baseNode('hero-figure', sourceId, locale, sourceRevision),
      type: 'figure',
      title: parsed.data.imageAlt,
      assetIds: [assetId],
      accessibility: {
        decorative: false,
        alternativeText: parsed.data.imageAlt,
      },
    })
  }

  const addList = (block: MdastNode): string => {
    const listId = nextId('list')
    const items = block.children ?? []
    const itemIds = items.map(() => nextId('item'))
    nodes.push({
      ...baseNode(listId, sourceId, locale, sourceRevision),
      type: 'list',
      ordered: Boolean(block.ordered),
      ...(block.start ? { start: block.start } : {}),
      itemIds,
    })
    items.forEach((item, index) => {
      const children = item.children ?? []
      const paragraph = children[0]
      if (!paragraph || paragraph.type !== 'paragraph')
        unsupported(sourceId, item)
      const childListIds = children.slice(1).map((child) => {
        if (child.type !== 'list') unsupported(sourceId, child)
        return addList(child)
      })
      nodes.push({
        ...baseNode(itemIds[index], sourceId, locale, sourceRevision),
        type: 'list-item',
        parentListId: listId,
        childListIds,
        ...inlineContent(sourceId, paragraph.children),
      })
    })
    return listId
  }

  const pendingFootnotes: Array<{ node: MdastNode; backlinkId: string }> = []
  for (const block of tree.children ?? []) {
    if (block.type.startsWith('mdx') || block.type === 'html')
      unsupported(sourceId, block)
    if (block.type === 'heading') {
      const inline = inlineContent(sourceId, block.children)
      nodes.push({
        ...baseNode(
          nextHeadingId(inline.text),
          sourceId,
          locale,
          sourceRevision,
        ),
        type: 'heading',
        level: block.depth ?? 2,
        ...inline,
      })
    } else if (block.type === 'paragraph') {
      const image = block.children?.length === 1 ? block.children[0] : undefined
      if (image?.type === 'image') {
        if (!image.alt)
          throw new Error(
            `Image missing alt text at ${sourceLocation(sourceId, image)}`,
          )
        const figureId = nextId('figure')
        const captionId = image.title ? nextId('caption') : undefined
        const assetId = await addAsset(image.url ?? '', image.alt)
        nodes.push({
          ...baseNode(figureId, sourceId, locale, sourceRevision),
          type: 'figure',
          title: image.title ?? image.alt,
          assetIds: [assetId],
          captionId,
          accessibility: {
            decorative: false,
            alternativeText: image.alt,
          },
        })
        if (captionId)
          nodes.push({
            ...baseNode(captionId, sourceId, locale, sourceRevision),
            type: 'caption',
            parentId: figureId,
            text: image.title!,
            inlineRuns: [],
          })
      } else {
        const id = nextId('paragraph')
        const inline = inlineContent(sourceId, block.children)
        if (!inline.text) continue
        nodes.push({
          ...baseNode(id, sourceId, locale, sourceRevision),
          type: 'paragraph',
          ...inline,
        })
        for (const child of block.children ?? [])
          if (child.type === 'footnoteReference')
            pendingFootnotes.push({ node: child, backlinkId: id })
      }
    } else if (block.type === 'list') {
      addList(block)
    } else if (block.type === 'blockquote') {
      const paragraphs = block.children ?? []
      if (paragraphs.some((child) => child.type !== 'paragraph'))
        unsupported(sourceId, block)
      const inline = inlineContent(
        sourceId,
        paragraphs.flatMap((child, index) => [
          ...(index ? [{ type: 'text', value: '\n' } as MdastNode] : []),
          ...(child.children ?? []),
        ]),
      )
      nodes.push({
        ...baseNode(nextId('quote'), sourceId, locale, sourceRevision),
        type: 'quote',
        ...inline,
      })
    } else if (block.type === 'code') {
      nodes.push({
        ...baseNode(nextId('code'), sourceId, locale, sourceRevision),
        type: 'code',
        code: block.value ?? '',
        ...(block.lang ? { language: block.lang } : {}),
      })
    } else if (block.type === 'math') {
      nodes.push({
        ...baseNode(nextId('equation'), sourceId, locale, sourceRevision),
        type: 'equation',
        source: block.value ?? '',
        format: 'latex',
      })
    } else if (block.type === 'footnoteDefinition') {
      const ref = pendingFootnotes.find(
        (item) => item.node.identifier === block.identifier,
      )
      const paragraphs = block.children ?? []
      if (!ref || paragraphs.some((child) => child.type !== 'paragraph'))
        unsupported(sourceId, block)
      const inline = inlineContent(
        sourceId,
        paragraphs.flatMap((child) => child.children ?? []),
      )
      nodes.push({
        ...baseNode(
          `note-${block.identifier}`,
          sourceId,
          locale,
          sourceRevision,
        ),
        type: 'note',
        noteKind: 'footnote',
        label: block.identifier ?? '',
        backlinkIds: [ref.backlinkId],
        ...inline,
      })
    } else if (block.type !== 'thematicBreak') {
      unsupported(sourceId, block)
    }
  }

  const translations = (await readdir(entryDirectory))
    .filter((name) => /^(?:zh|ko|ja)\.mdx$/.test(name))
    .sort()
  const graph = publicationGraphSchema.parse({
    version: PUBLICATION_GRAPH_VERSION,
    id: `publication-${entryId}`,
    metadata: {
      title: parsed.data.title,
      abstract: parsed.data.description,
      contributors: parsed.data.authors ?? [],
      status: parsed.data.draft ? 'working' : 'published',
      sourceDocumentVersion: translationKey,
      created: new Date(parsed.data.date).toISOString().slice(0, 10),
      defaultLocale: locale,
      defaultDirection: 'auto',
      keywords: parsed.data.tags ?? [],
    },
    edition: { id: `edition-${locale}`, locale, direction: 'auto' },
    nodes,
  })
  return validatePublicationSourceResult({
    graph,
    assetBundle: createAssetBundle(
      { version: '1.0.0', assets },
      async (descriptor) => assetBytes.get(descriptor.id)!,
    ),
    diagnostics: translations.map((name) => ({
      severity: 'info' as const,
      code: 'translation-sibling',
      message: `Resolved local translation sibling ${name}`,
      sourceId,
    })),
    provenance: {
      adapterId: 'astro',
      adapterVersion: PUBLICATION_SOURCE_ADAPTER_VERSION,
      sourceType: 'astro',
      sourceId,
      sourceRevision,
    },
  })
}

export const astroPublicationAdapter: PublicationSourceAdapter<AstroSourceLocator> =
  {
    id: 'astro',
    version: PUBLICATION_SOURCE_ADAPTER_VERSION,
    adapt: adaptAstroBlogEntry,
  }
