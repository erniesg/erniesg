import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { XMLValidator } from 'fast-xml-parser'
import JSZip from 'jszip'
import { parse } from 'parse5'
import { PDFDocument } from 'pdf-lib'
import { chromium } from 'playwright'
import { renderPublicationXhtml } from '@erniesg/struct/renderers/xhtml'
import {
  assertStructEpubArchiveByteLength,
  buildStructEpub,
} from '@erniesg/struct/renderers/epub'
import type { StructDocument } from '@erniesg/struct/document'
import { serializeAssetBundle } from '../asset-bundle'
import type { AssetBundle, AssetDescriptor } from '../asset-bundle'
import {
  preparePublicationPlaywrightRuntime,
  preparePublicationPuppeteerRuntime,
} from '../browser-runtime'
export {
  publicationBrowserVersionMatches,
  publicationPlaywrightExecutableCandidates,
} from '../browser-runtime'
import { PUBLICATION_OUTPUT_POLICY_VERSIONS } from '../output-contract'
import type {
  PublicationGraph,
  PublicationInlineRun,
  PublicationNode,
} from '../schema'
import { serializePublicationGraph } from '../schema'
import type { PublicationSourceBinding } from '../source-binding'
import {
  structBundleWire,
  structDocumentJson,
  type StructBundleWire,
} from '../struct-source-binding'
import type {
  PublicationBundle,
  PublicationRenderer,
} from '../adapter-registry'
import {
  PUBLICATION_TOOLCHAIN,
  publicationPdfRendererForRuntime,
  publicationToolchainForRuntime,
  verifyPublicationToolchain,
  type PublicationBrowserRuntimeEvidence,
} from '../toolchain'

export const PUBLICATION_PROFILES = [
  'phone-webpub',
  'eink-epub',
  'a5-pdf',
  'a4-pdf',
] as const
export type PublicationProfile = (typeof PUBLICATION_PROFILES)[number]

const FIXED_DATE = new Date('2000-01-01T00:00:00.000Z')
// Every file this renderer creates is opened with O_EXCL semantics so a
// pre-existing entry (symlink, hard link, FIFO, or regular file) is never
// followed, truncated, or blocked on — creation fails closed instead.
const EXCLUSIVE_WRITE = { flag: 'wx' } as const
const PROFILE_DETAILS = {
  'phone-webpub': {
    dimensions: '390px x continuous',
    margins: '16px',
    typeScale: '16px/1.55',
    measure: '42rem',
    figurePlacement: 'in-flow',
  },
  'eink-epub': {
    dimensions: 'reader-controlled',
    margins: 'reader-controlled',
    typeScale: '1rem/1.5',
    measure: 'reader-controlled',
    figurePlacement: 'in-flow-monochrome',
  },
  'a5-pdf': {
    dimensions: '148mm x 210mm',
    margins: '22mm 18mm 24mm',
    typeScale: '11.5pt/1.55',
    measure: '112mm',
    figurePlacement: 'full-width-in-flow',
  },
  'a4-pdf': {
    dimensions: '210mm x 297mm',
    margins: '22mm 24mm 25mm',
    typeScale: '10.5pt/1.5',
    measure: '162mm',
    figurePlacement: 'in-flow',
  },
} as const

type ArtifactReceipt = {
  profile: PublicationProfile
  path: string
  sha256: string
  byteLength: number
  renderer: ArtifactRenderer
  files?: ArtifactFile[]
  pageCount?: number
  geometry?: { widthPoints: number; heightPoints: number }
}

type ArtifactRenderer =
  'semantic-html' | 'jszip' | 'vivliostyle-cli' | 'playwright-chromium'

type ArtifactFile = {
  path: string
  sha256: string
  byteLength: number
}

export type PublicationReceipt = {
  version: '1.0.0'
  /**
   * Diagnostic back-compat digests. They are never the source identity:
   * every one of them is optional, and the source identity of a publication
   * is the Struct binding plus the bundle wire bytes it was rendered from.
   */
  source?: {
    graphSha256?: string
    assetBundleSha256?: string
    canonicalSubsetSha256?: string
  }
  /**
   * The source identity. It is carried from the source result and is never
   * re-derived here, so a receipt can only claim a Struct binding whose
   * digests were computed from the bytes this invocation produced.
   */
  sourceBinding?: PublicationSourceBinding
  profiles: typeof PROFILE_DETAILS
  policyVersions: typeof PUBLICATION_OUTPUT_POLICY_VERSIONS
  toolchain: ReturnType<typeof publicationToolchainForRuntime>
  repository: { commit: string; dirty: boolean }
  artifacts: ArtifactReceipt[]
}

function sha256(value: Uint8Array | string) {
  return createHash('sha256').update(value).digest('hex')
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

type InlineHtmlSegment = {
  value: string
  link?: PublicationInlineRun
}

function inlineRunProducesLink(run: PublicationInlineRun) {
  return (
    Boolean(run.href) ||
    ((run.semanticRole === 'citation' ||
      run.semanticRole === 'cross-reference') &&
      Boolean(run.targetIds?.length))
  )
}

function inlineLinkHref(link: PublicationInlineRun) {
  return link.href ?? `#${link.targetIds?.[0] ?? ''}`
}

function inlineHtmlSegments(
  text: string,
  runs: PublicationInlineRun[] = [],
) {
  for (const run of runs) {
    if (!run.hardBreak) continue
    if (
      run.start < 0 ||
      run.end !== run.start + 1 ||
      run.end > text.length ||
      text.slice(run.start, run.end) !== '\n'
    )
      throw new Error(
        `Malformed hard-break inline run ${run.start}:${run.end}; it must cover exactly one newline`,
      )
  }
  const boundaries = new Set([0, text.length])
  for (const run of runs) {
    boundaries.add(run.start)
    boundaries.add(run.end)
  }
  const points = [...boundaries].sort((a, b) => a - b)
  const segments = points
    .slice(0, -1)
    .map((start, index) => {
      const end = points[index + 1]
      const active = runs.filter((run) => run.start <= start && run.end >= end)
      let value = escapeHtml(text.slice(start, end))
      const hardBreak = active.some((run) => run.hardBreak)
      if (hardBreak) value = value.replaceAll('\n', '<br>')
      if (!value) return undefined
      if (active.some((run) => run.compactMathAtom))
        value = `<span class="math">${value}</span>`
      if (active.some((run) => run.inlineCode)) value = `<code>${value}</code>`
      if (active.some((run) => run.italic)) value = `<em>${value}</em>`
      if (active.some((run) => run.bold)) value = `<strong>${value}</strong>`
      if (active.some((run) => run.underline)) value = `<u>${value}</u>`
      if (active.some((run) => run.strikethrough)) value = `<del>${value}</del>`
      const verticalAlign = active.find((run) => run.verticalAlign)
      if (verticalAlign?.verticalAlign === 'superscript')
        value = `<sup>${value}</sup>`
      else if (verticalAlign?.verticalAlign === 'subscript')
        value = `<sub>${value}</sub>`
      const link = hardBreak
        ? undefined
        : active.find((run) => inlineRunProducesLink(run))
      return { value, link }
    })
    .filter(Boolean) as InlineHtmlSegment[]
  return segments
}

function groupedInlineHtmlSegments(segments: InlineHtmlSegment[]) {
  const groups: InlineHtmlSegment[] = []
  for (let index = 0; index < segments.length;) {
    const segment = segments[index]!
    if (!segment.link) {
      groups.push(segment)
      index += 1
      continue
    }
    let value = segment.value
    let end = index + 1
    while (end < segments.length && segments[end]!.link === segment.link) {
      value += segments[end]!.value
      end += 1
    }
    groups.push({ value, link: segment.link })
    index = end
  }
  return groups
}

export function publicationInlineLinkTargets(
  text: string,
  runs: PublicationInlineRun[] = [],
) {
  return groupedInlineHtmlSegments(inlineHtmlSegments(text, runs)).flatMap(
    (segment) => (segment.link ? [inlineLinkHref(segment.link)] : []),
  )
}

function inlineHtml(
  text: string,
  runs: PublicationInlineRun[] = [],
  targetNodes?: Map<string, PublicationNode>,
) {
  const linkAttributes = (
    link: PublicationInlineRun,
    includeRelationshipId: boolean,
  ) =>
    [
      `href="${escapeHtml(inlineLinkHref(link))}"`,
      ...(includeRelationshipId && link.relationshipId
        ? [`id="${escapeHtml(link.relationshipId)}"`]
        : []),
      ...(link.semanticRole === 'cross-reference' &&
      link.targetIds?.some((targetId) => targetNodes?.get(targetId)?.type === 'note')
        ? ['role="doc-noteref"']
        : []),
      ...(link.semanticRole === 'citation'
        ? ['role="doc-biblioref"', 'data-semantic-role="citation"']
        : []),
      ...(link.targetIds?.[0]
        ? [`aria-describedby="${escapeHtml(link.targetIds[0])}"`]
        : []),
      ...(link.targetIds?.length
        ? [`data-target-ids="${escapeHtml(link.targetIds.join(' '))}"`]
        : []),
    ].join(' ')
  let html = ''
  const renderedLinks = new Set<PublicationInlineRun>()
  for (const segment of groupedInlineHtmlSegments(inlineHtmlSegments(text, runs))) {
    if (!segment.link) {
      html += segment.value
      continue
    }
    html += `<a ${linkAttributes(segment.link, !renderedLinks.has(segment.link))}>${segment.value}</a>`
    renderedLinks.add(segment.link)
  }
  return html
}

export function publicationVariantKindForProfile(profile: PublicationProfile) {
  switch (profile) {
    case 'eink-epub':
      return 'monochrome' as const
    case 'a5-pdf':
    case 'a4-pdf':
      return 'compact' as const
    case 'phone-webpub':
      return 'static' as const
  }
}

export function publicationNodeForProfile(
  node: PublicationNode,
  profile: PublicationProfile,
) {
  const variant = node.variants?.find(
    (candidate) =>
      candidate.reviewed &&
      candidate.kind === publicationVariantKindForProfile(profile),
  )
  if (!variant) return node
  if (variant.assetId && node.type === 'figure')
    return { ...node, assetIds: [variant.assetId] }
  if (variant.assetId && node.type === 'media')
    return { ...node, assetId: variant.assetId }
  if (variant.text !== undefined && 'text' in node)
    return { ...node, text: variant.text, inlineRuns: [] }
  if (variant.text !== undefined && node.type === 'figure')
    return { ...node, sourceText: variant.text }
  return node
}

function nodeAttributes(
  node: PublicationNode,
  edition: PublicationGraph['edition'],
  extra: string[] = [],
) {
  const attributes = [`id="${escapeHtml(node.id)}"`, ...extra.filter(Boolean)]
  if (node.locale !== edition.locale)
    attributes.push(`lang="${escapeHtml(node.locale)}"`)
  if (node.direction !== edition.direction)
    attributes.push(`dir="${escapeHtml(node.direction)}"`)
  return attributes.join(' ')
}

function renderNode(
  node: PublicationNode,
  byId: Map<string, PublicationNode>,
  assetPaths: Map<string, string>,
  profile: PublicationProfile,
  edition: PublicationGraph['edition'],
  listStack = new Set<string>(),
): string {
  node = publicationNodeForProfile(node, profile)
  const text = 'text' in node ? inlineHtml(node.text, node.inlineRuns, byId) : ''
  switch (node.type) {
    case 'heading':
      return `<h${node.level} ${nodeAttributes(node, edition)}>${text}</h${node.level}>`
    case 'paragraph':
      return `<p ${nodeAttributes(node, edition)}>${text}</p>`
    case 'list': {
      if (listStack.has(node.id))
        throw new Error(`Cyclic nested list relationship at ${node.id}`)
      const nextListStack = new Set(listStack).add(node.id)
      const tag = node.ordered ? 'ol' : 'ul'
      const start =
        node.ordered && node.start !== undefined ? ` start="${node.start}"` : ''
      const items: string = node.itemIds
        .map((id) => byId.get(id))
        .filter(
          (item): item is Extract<PublicationNode, { type: 'list-item' }> =>
            Boolean(item?.type === 'list-item'),
        )
        .map((item) => {
          const nested: string = item.childListIds
            .map((childId) => byId.get(childId))
            .filter(
              (child): child is Extract<PublicationNode, { type: 'list' }> =>
                child?.type === 'list',
            )
            .map((child) =>
              renderNode(child, byId, assetPaths, profile, edition, nextListStack),
            )
            .join('')
          const renderedItem = publicationNodeForProfile(item, profile) as Extract<
            PublicationNode,
            { type: 'list-item' }
          >
          return `<li ${nodeAttributes(renderedItem, edition)}>${inlineHtml(renderedItem.text, renderedItem.inlineRuns, byId)}${nested}</li>`
        })
        .join('')
      return `<${tag} ${nodeAttributes(node, edition, start ? [start] : [])}>${items}</${tag}>`
    }
    case 'list-item':
    case 'caption':
      return ''
    case 'quote':
      return `<blockquote ${nodeAttributes(node, edition)}><p>${text}</p>${node.attribution ? `<cite>${escapeHtml(node.attribution)}</cite>` : ''}</blockquote>`
    case 'code':
      return `<pre ${nodeAttributes(node, edition)}><code${node.language ? ` class="language-${escapeHtml(node.language)}"` : ''}>${escapeHtml(node.code)}</code></pre>`
    case 'equation':
      if (node.format === 'mathml')
        throw new Error('MathML equation rendering is unsupported')
      {
        const caption = node.captionId ? byId.get(node.captionId) : undefined
        const renderedCaption = caption
          ? publicationNodeForProfile(caption, profile)
          : undefined
        const label = node.label
          ? `<span class="equation-label">${escapeHtml(node.label)}</span>`
          : ''
        return `<div ${nodeAttributes(node, edition, ['class="equation"', 'role="math"', `data-format="${node.format}"`])}>${escapeHtml(node.source)}${label}${renderedCaption?.type === 'caption' ? `<div class="caption" ${nodeAttributes(renderedCaption, edition)}>${inlineHtml(renderedCaption.text, renderedCaption.inlineRuns, byId)}</div>` : ''}</div>`
      }
    case 'note':
      {
        const role =
          node.noteKind === 'footnote' || node.noteKind === 'endnote'
            ? 'doc-footnote'
            : 'note'
        const epubType =
          node.noteKind === 'footnote' || node.noteKind === 'endnote'
            ? `epub:type="${node.noteKind}"`
            : ''
        return `<aside ${nodeAttributes(node, edition, [epubType, `role="${role}"`, `data-note-kind="${node.noteKind}"`])}><span class="note-label">${escapeHtml(node.label)}</span> ${text}${node.backlinkIds.map((id) => `<a class="backlink" href="#${id}" aria-label="Back to reference">↩</a>`).join('')}</aside>`
      }
    case 'figure': {
      const caption = node.captionId ? byId.get(node.captionId) : undefined
      const alternativeText = accessibilityLabel(node)
      if (node.accessibility.decorative !== true && !alternativeText)
        throw new Error(
          `Figure ${node.id} requires alternative text or a long description`,
        )
      const assets = node.assetIds
        .map((assetId) => {
          const path = assetPaths.get(assetId)
          if (!path)
            throw new Error(`Figure ${node.id} references an unavailable asset ${assetId}`)
          return `<img src="${escapeHtml(path)}" alt="${escapeHtml(alternativeText)}">`
        })
        .join('')
      const source = node.sourceText
        ? `<pre id="${node.id}-source" class="figure-source"${alternativeText ? ` aria-label="${escapeHtml(alternativeText)}"` : ''}>${escapeHtml(node.sourceText)}</pre>`
        : ''
      if (!assets && !source)
        throw new Error(
          `Figure ${node.id} has no renderable asset or source text`,
        )
      const renderedCaption = caption
        ? publicationNodeForProfile(caption, profile)
        : undefined
      return `<figure ${nodeAttributes(node, edition)}><div class="figure-title">${escapeHtml(node.title)}</div>${assets}${source}${renderedCaption?.type === 'caption' ? `<figcaption ${nodeAttributes(renderedCaption, edition)}>${inlineHtml(renderedCaption.text, renderedCaption.inlineRuns, byId)}</figcaption>` : ''}</figure>`
    }
    case 'reference':
      return `<p ${nodeAttributes(node, edition, ['role="doc-biblioentry"'])}>${node.href ? `<a href="${escapeHtml(node.href)}">${text}</a>` : node.targetIds[0] ? `<a href="#${escapeHtml(node.targetIds[0])}" role="doc-biblioref">${text}</a>` : text}</p>`
    case 'aside':
      return `<aside ${nodeAttributes(node, edition)}>${text}</aside>`
    case 'media': {
      const assetPath = assetPaths.get(node.assetId)
      if (!assetPath)
        throw new Error(`Media ${node.id} references an unavailable asset ${node.assetId}`)
      const source = escapeHtml(assetPath)
      const label = accessibilityLabel(node)
      if (node.accessibility.decorative !== true && !label)
        throw new Error(
          `Media ${node.id} requires alternative text, a long description, or a transcript`,
        )
      const alternativeText = escapeHtml(label)
      const media =
        node.mediaKind === 'image'
          ? `<img src="${source}" alt="${alternativeText}"${node.accessibility.decorative ? ' aria-hidden="true"' : ''}>`
          : node.mediaKind === 'audio'
            ? node.accessibility.decorative
              ? `<audio src="${source}" aria-hidden="true"></audio>`
              : `<audio controls="controls" src="${source}" aria-label="${alternativeText}"></audio>`
            : node.mediaKind === 'video'
              ? node.accessibility.decorative
                ? `<video src="${source}" aria-hidden="true"></video>`
                : `<video controls="controls" src="${source}" aria-label="${alternativeText}"></video>`
              : node.accessibility.decorative
                ? `<span class="decorative-media" aria-hidden="true"></span>`
                : `<a href="${source}" aria-label="${alternativeText}">${alternativeText}</a>`
      const printedTranscript =
        !node.accessibility.decorative &&
        (profile === 'a5-pdf' || profile === 'a4-pdf') &&
        node.accessibility.transcript?.trim()
          ? `<p id="${escapeHtml(node.id)}-transcript" class="media-transcript">${escapeHtml(node.accessibility.transcript)}</p>`
          : ''
      const caption = node.captionId ? byId.get(node.captionId) : undefined
      const renderedCaption = caption
        ? publicationNodeForProfile(caption, profile)
        : undefined
      return `<figure ${nodeAttributes(node, edition)}>${media}${printedTranscript}${renderedCaption?.type === 'caption' ? `<figcaption ${nodeAttributes(renderedCaption, edition)}>${inlineHtml(renderedCaption.text, renderedCaption.inlineRuns, byId)}</figcaption>` : ''}</figure>`
    }
    case 'table': {
      const caption = node.captionId ? byId.get(node.captionId) : undefined
      const rows = node.rows
        .map(
          (row) =>
            `<tr>${row.cells
              .map((cell) => {
                const tag = cell.headerScope ? 'th' : 'td'
                const attributes = [
                  ...(cell.id ? [`id="${escapeHtml(cell.id)}"`] : []),
                  ...(cell.headerScope ? [`scope="${cell.headerScope}"`] : []),
                  ...(cell.columnSpan > 1
                    ? [`colspan="${cell.columnSpan}"`]
                    : []),
                  ...(cell.rowSpan > 1 ? [`rowspan="${cell.rowSpan}"`] : []),
                  ...(cell.headerIds?.length
                    ? [`headers="${escapeHtml(cell.headerIds.join(' '))}"`]
                    : []),
                ].join(' ')
                return `<${tag}${attributes ? ` ${attributes}` : ''}>${escapeHtml(cell.text)}</${tag}>`
              })
              .join('')}</tr>`,
        )
        .join('')
      const renderedCaption = caption
        ? publicationNodeForProfile(caption, profile)
        : undefined
      return `<table ${nodeAttributes(node, edition)}>${renderedCaption?.type === 'caption' ? `<caption ${nodeAttributes(renderedCaption, edition)}>${inlineHtml(renderedCaption.text, renderedCaption.inlineRuns, byId)}</caption>` : ''}${rows}</table>`
    }
  }
}

function accessibilityLabel(node: PublicationNode) {
  return (
    [
      node.accessibility.alternativeText,
      node.accessibility.longDescription,
      node.accessibility.transcript,
    ].find((value) => typeof value === 'string' && value.trim()) ?? ''
  )
}

export function publicationGraphToHtml(
  graph: PublicationGraph,
  assetPaths: Map<string, string>,
  profile: PublicationProfile,
  stylesheet = 'publication.css',
) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  for (const node of graph.nodes) {
    if (node.type !== 'caption') continue
    const parent = byId.get(node.parentId)
    if (
      parent &&
      (!('captionId' in parent) || parent.captionId !== node.id)
    )
      throw new Error(
        `Caption ${node.id} has no reciprocal caption ownership from ${node.parentId}`,
      )
  }
  const nestedListIds = new Set(
    graph.nodes
      .filter(
        (node): node is Extract<PublicationNode, { type: 'list-item' }> =>
          node.type === 'list-item',
      )
      .flatMap((node) => node.childListIds),
  )
  const body = graph.nodes
    .filter((node) => !nestedListIds.has(node.id))
    .map((node) => renderNode(node, byId, assetPaths, profile, graph.edition))
    .join('\n')
  const direction = graph.edition.direction
  return `<!doctype html>
<html lang="${graph.edition.locale}" dir="${direction}" data-profile="${profile}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(graph.metadata.title)}</title><meta name="description" content="${escapeHtml(graph.metadata.abstract ?? '')}"><link rel="stylesheet" href="${stylesheet}"></head>
<body><header><h1>${escapeHtml(graph.metadata.title)}</h1>${graph.metadata.subtitle ? `<p class="subtitle">${escapeHtml(graph.metadata.subtitle)}</p>` : ''}${graph.metadata.abstract ? `<p class="dek">${escapeHtml(graph.metadata.abstract)}</p>` : ''}<p class="byline">${graph.metadata.contributors.map(escapeHtml).join(', ')}</p></header><main>${body}</main></body></html>
`
}

async function writeAssets(
  bundle: PublicationBundle,
  directory: string,
  prefix = 'assets/',
) {
  await preparePublicationAssetDirectory(directory)
  const paths = new Map<string, string>()
  for (const descriptor of bundle.assetBundle.descriptor.assets) {
    const extension = publicationAssetFileExtension(
      descriptor.fileName,
      descriptor.mediaType,
    )
    const fileName = `${descriptor.id}${extension}`
    await writeFile(
      resolve(directory, fileName),
      await bundle.assetBundle.resolveBytes(descriptor),
      EXCLUSIVE_WRITE,
    )
    paths.set(descriptor.id, `${prefix}${fileName}`)
  }
  return paths
}

export function publicationAssetFileExtension(
  fileName: string | undefined,
  mediaType: string,
) {
  void fileName
  const normalizedMediaType = mediaType.split(';', 1)[0]!.toLocaleLowerCase()
  const canonicalExtensions: Record<string, string> = {
    'application/pdf': '.pdf',
    'audio/mpeg': '.mp3',
    'image/avif': '.avif',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
  }
  const canonical = canonicalExtensions[normalizedMediaType]
  if (canonical) return canonical
  const subtype = normalizedMediaType.split('/')[1]?.split('+', 1)[0] ?? ''
  return /^[a-z0-9]+$/iu.test(subtype)
    ? `.${subtype.toLocaleLowerCase()}`
    : '.bin'
}

export function publicationEpubManifestItemId(assetId: string, index: number) {
  const safeId = assetId.replace(/[^A-Za-z0-9_.-]+/gu, '-')
  return `asset-${index}-${safeId || 'item'}`
}

// ---------------------------------------------------------------------------
// The app-owned presentation of the pinned package renderers.
//
// The pinned package renders the canonical Struct document. The app owns the
// publication presentation around that rendering: the landmark, the profile
// attribute, the stylesheet, the asset locations and the fallback elements.
// Every value of the presentation is derived from the canonical document or
// from the verified asset bytes. The wrapper never reads the publication
// graph, never mints semantic text and never re-implements the package's
// block rendering: it only adds what the app owns around it, and it verifies
// what it added before the artifact is published.
// ---------------------------------------------------------------------------

/** The stylesheet the package XHTML references. */
const PACKAGE_STYLESHEET_HREF = 'styles.css'

/** The fonts the app publication ships. */
const PUBLICATION_FONTS = [
  'Geist-Regular.ttf',
  'Geist-Bold.ttf',
  'GeistMono-Regular.ttf',
] as const

/** The source fallback of an asset-less figure. */
export type PublicationFigureSource = {
  /** The canonical source text of the figure. */
  sourceText: string
  /** The canonical alternative text of the figure, when it carries one. */
  alternativeText?: string
}

/**
 * The app-owned presentation of one rendered profile.
 *
 * The asset paths are keyed by the canonical asset href, so the wrapper maps
 * a canonical asset to its published location without touching the canonical
 * document.
 */
export type PublicationPresentation = {
  /** The profile the artifact is rendered for. */
  profile: PublicationProfile
  /** The stylesheet the artifact references. */
  stylesheetHref: string
  /** The canonical asset href -> the app path the asset is published at. */
  assetPaths: ReadonlyMap<string, string>
  /** The canonical figure block id -> the source fallback of the figure. */
  figureSources: ReadonlyMap<string, PublicationFigureSource>
  /** The canonical table block ids, whose inspected element is the table. */
  tableIds: readonly string[]
  /** The canonical publication abstract, when the document carries one. */
  abstract?: string
}

/**
 * The app asset descriptor of every canonical asset, keyed by its href.
 *
 * The descriptors are matched to the canonical assets by their SHA-256, so
 * the app's published bytes are the verified bytes of the canonical asset.
 */
export function publicationAssetDescriptors(
  document: StructDocument,
  assetBundle: AssetBundle,
): Map<string, AssetDescriptor> {
  const byDigest = new Map<string, AssetDescriptor>()
  for (const descriptor of assetBundle.descriptor.assets) {
    const prior = byDigest.get(descriptor.sha256)
    if (prior && prior.id !== descriptor.id)
      throw new Error(
        `The publication asset bundle carries two descriptors for one content digest: ${prior.id} and ${descriptor.id}`,
      )
    byDigest.set(descriptor.sha256, descriptor)
  }
  const byHref = new Map<string, AssetDescriptor>()
  for (const asset of document.assets) {
    const descriptor = byDigest.get(asset.sha256)
    if (!descriptor)
      throw new Error(
        `The publication asset bundle does not carry the canonical asset ${asset.id}`,
      )
    byHref.set(asset.href, descriptor)
  }
  return byHref
}

/**
 * The published location of every canonical asset, keyed by its href.
 *
 * The mapping is by verified content: the app's asset descriptor is matched
 * to the canonical asset by its SHA-256, so two canonical assets with the
 * same content publish at one app path, and a canonical asset the app does
 * not carry fails closed instead of being published at a guessed location.
 */
export function publicationAssetSources(
  document: StructDocument,
  assetBundle: AssetBundle,
  prefix = 'assets/',
): Map<string, string> {
  const descriptors = publicationAssetDescriptors(document, assetBundle)
  const sources = new Map<string, string>()
  for (const asset of document.assets) {
    const descriptor = descriptors.get(asset.href)
    if (!descriptor)
      throw new Error(
        `The publication asset bundle does not carry the canonical asset ${asset.id}`,
      )
    const path = `${prefix}${descriptor.id}${publicationAssetFileExtension(
      descriptor.fileName,
      descriptor.mediaType,
    )}`
    const prior = sources.get(asset.href)
    if (prior && prior !== path)
      throw new Error(
        `Two canonical assets claim one href with different content: ${asset.href}`,
      )
    sources.set(asset.href, path)
  }
  return sources
}

/**
 * The source fallbacks of the canonical figures that render no asset.
 *
 * A figure that references no packaged asset carries its canonical source
 * text instead. The fallback is only produced when the canonical document
 * provides that text; the wrapper never writes a figure source of its own.
 */
export function publicationFigureSources(
  document: StructDocument,
): Map<string, PublicationFigureSource> {
  const packagedAssetIds = new Set(
    document.assets.filter((asset) => asset.bytes).map((asset) => asset.id),
  )
  const sources = new Map<string, PublicationFigureSource>()
  for (const block of document.blocks) {
    if (block.kind !== 'figure') continue
    const assets = (block.fallbackAssetIds ?? []).filter((assetId) =>
      packagedAssetIds.has(assetId),
    )
    if (assets.length > 0) continue
    if (!block.text) continue
    const alternativeText = block.attributes?.alternativeText
    sources.set(block.id, {
      sourceText: block.text,
      ...(typeof alternativeText === 'string' && alternativeText.trim()
        ? { alternativeText }
        : {}),
    })
  }
  return sources
}

/** The canonical table block ids, whose inspected element is the table. */
export function publicationTableIds(document: StructDocument): string[] {
  return document.blocks
    .filter((block) => block.kind === 'table')
    .map((block) => block.id)
}

/**
 * The app-owned presentation of one profile, derived from the canonical
 * document and the app's verified asset bundle.
 */
export function publicationPresentation(
  bundle: PublicationBundle,
  profile: PublicationProfile,
  options: { stylesheetHref: string; assetPrefix?: string },
): PublicationPresentation {
  const document = bundle.structDocument
  if (!document)
    throw new Error('A publication presentation requires a Struct document')
  return {
    profile,
    stylesheetHref: options.stylesheetHref,
    assetPaths: publicationAssetSources(
      document,
      bundle.assetBundle,
      options.assetPrefix ?? 'assets/',
    ),
    figureSources: publicationFigureSources(document),
    tableIds: publicationTableIds(document),
    ...(document.metadata.abstract
      ? { abstract: document.metadata.abstract }
      : {}),
  }
}

function replaceLiteralOnce(
  source: string,
  needle: string,
  replacement: string,
  label: string,
): string {
  const index = source.indexOf(needle)
  if (index < 0)
    throw new Error(`The package XHTML carries no ${label}`)
  if (source.indexOf(needle, index + needle.length) >= 0)
    throw new Error(`The package XHTML carries more than one ${label}`)
  return (
    source.slice(0, index) + replacement + source.slice(index + needle.length)
  )
}

function withHtmlAttribute(
  source: string,
  name: string,
  value: string,
): string {
  const match = /<html\b[^>]*>/u.exec(source)
  if (!match) throw new Error('The package XHTML carries no html element')
  if (new RegExp(`\\s${name}=`, 'u').test(match[0]))
    throw new Error(`The package XHTML already carries a ${name} attribute`)
  const tag = match[0].replace(/>$/u, ` ${name}="${escapeHtml(value)}">`)
  return (
    source.slice(0, match.index) +
    tag +
    source.slice(match.index + match[0].length)
  )
}

/**
 * The app's landmark around the rendered body.
 *
 * The package renders the publication body without a main landmark, and the
 * publication contract requires one. The header stays outside the landmark,
 * exactly as the app's own publication markup places it.
 */
export function withMainLandmark(source: string): string {
  const headerEnd = source.indexOf('</header>')
  const bodyEnd = source.lastIndexOf('</body>')
  if (headerEnd < 0 || bodyEnd < 0 || bodyEnd <= headerEnd)
    throw new Error('The package XHTML carries no header and body')
  return (
    source.slice(0, headerEnd + '</header>'.length) +
    '\n<main>' +
    source.slice(headerEnd + '</header>'.length, bodyEnd) +
    '</main>\n' +
    source.slice(bodyEnd)
  )
}

/**
 * The inspected element of a table block is the table itself.
 *
 * The package wraps a table block in a figure, and the app's publication
 * contract inspects the table element. The wrapper therefore moves the
 * canonical block id onto the table and drops the figure wrapper, so the
 * table keeps the geometry the app's stylesheet gives a table.
 */
export function withTableCorrespondence(source: string, tableId: string): string {
  const figureStart = `<figure id="${tableId}" data-struct-id="${tableId}">`
  const figureIndex = source.indexOf(figureStart)
  if (figureIndex < 0)
    throw new Error(`The package XHTML carries no table block ${tableId}`)
  const rest = source.slice(figureIndex + figureStart.length)
  const tableIndex = rest.indexOf('<table>')
  const figureEnd = rest.indexOf('</figure>')
  if (tableIndex < 0 || figureEnd < 0 || tableIndex > figureEnd)
    throw new Error(`The package XHTML carries no table element for ${tableId}`)
  const body = rest
    .slice(0, figureEnd)
    .replace(
      '<table>',
      `<table id="${tableId}" data-struct-id="${tableId}">`,
    )
  return (
    source.slice(0, figureIndex) +
    body +
    rest.slice(figureEnd + '</figure>'.length)
  )
}

/**
 * The source fallback of an asset-less figure.
 *
 * The fallback carries the canonical source text of the figure, so the
 * publication still shows what the figure was when its asset is unavailable.
 */
export function withFigureSource(
  source: string,
  figureId: string,
  figure: PublicationFigureSource,
): string {
  const figureStart = `<figure id="${figureId}" data-struct-id="${figureId}">`
  const figureIndex = source.indexOf(figureStart)
  if (figureIndex < 0)
    throw new Error(`The package XHTML carries no figure block ${figureId}`)
  const figureEnd = source.indexOf('</figure>', figureIndex)
  if (figureEnd < 0)
    throw new Error(`The package XHTML carries no figure element for ${figureId}`)
  const caption = source.indexOf('<figcaption', figureIndex)
  const at = caption >= 0 && caption < figureEnd ? caption : figureEnd
  const fallback = `<pre id="${figureId}-source" class="figure-source"${
    figure.alternativeText
      ? ` aria-label="${escapeHtml(figure.alternativeText)}"`
      : ''
  }>${escapeHtml(figure.sourceText)}</pre>`
  return source.slice(0, at) + fallback + source.slice(at)
}

/**
 * The canonical abstract in the publication header.
 *
 * The package header carries the title, the subtitle and the authors; the
 * publication contract also carries the abstract. The abstract is the
 * canonical metadata of the document, never a text of the renderer's own.
 */
export function withCanonicalAbstract(
  source: string,
  abstract: string,
): string {
  const headerEnd = source.indexOf('</header>')
  if (headerEnd < 0)
    throw new Error('The package XHTML carries no header')
  const authors = source.indexOf('<p class="authors"')
  const at =
    authors >= 0 && authors < headerEnd ? authors : headerEnd
  return (
    source.slice(0, at) +
    `<p class="dek">${escapeHtml(abstract)}</p>` +
    source.slice(at)
  )
}

/**
 * The app-owned presentation of the package XHTML.
 *
 * The transform is bounded and additive: it adds the app's landmark, the
 * app's profile attribute, the app's stylesheet reference, the app's asset
 * locations, the inspected element of a table and the source fallback of an
 * asset-less figure. It never rewrites publication text and never removes a
 * canonical element.
 */
export function wrapPublicationXhtml(
  xhtml: string,
  presentation: PublicationPresentation,
): string {
  let output = withHtmlAttribute(xhtml, 'data-profile', presentation.profile)
  output = withMainLandmark(output)
  if (presentation.stylesheetHref !== PACKAGE_STYLESHEET_HREF)
    output = replaceLiteralOnce(
      output,
      `href="${PACKAGE_STYLESHEET_HREF}"`,
      `href="${escapeHtml(presentation.stylesheetHref)}"`,
      'stylesheet reference',
    )
  for (const [href, path] of presentation.assetPaths)
    output = output.split(`src="${href}"`).join(`src="${path}"`)
  for (const tableId of presentation.tableIds)
    output = withTableCorrespondence(output, tableId)
  for (const [figureId, figure] of presentation.figureSources)
    output = withFigureSource(output, figureId, figure)
  if (presentation.abstract)
    output = withCanonicalAbstract(output, presentation.abstract)
  assertPublicationPresentation(output, presentation)
  return output
}

type PublicationHtmlElement = {
  tagName: string
  id: string | undefined
  src: string | undefined
  alt: string | undefined
  text: string
  attributes: Map<string, string>
}

function publicationHtmlElements(html: string): {
  root: PublicationHtmlElement | undefined
  elements: Map<string, PublicationHtmlElement>
  images: PublicationHtmlElement[]
  hasMain: boolean
} {
  const document = parse(html)
  const elements = new Map<string, PublicationHtmlElement>()
  const images: PublicationHtmlElement[] = []
  let root: PublicationHtmlElement | undefined
  let hasMain = false
  const attributeOf = (node: { attrs?: { name: string; value: string }[] }, name: string) =>
    node.attrs?.find((attribute) => attribute.name === name)?.value
  const textOf = (node: { childNodes?: { value?: string; childNodes?: unknown[] }[] }): string =>
    (node.childNodes ?? [])
      .map((child) => child.value ?? textOf(child as never))
      .join('')
  const visit = (node: unknown) => {
    const candidate = node as {
      tagName?: string
      attrs?: { name: string; value: string }[]
      childNodes?: unknown[]
    }
    if (candidate.tagName) {
      const element: PublicationHtmlElement = {
        tagName: candidate.tagName,
        id: attributeOf(candidate, 'id'),
        src: attributeOf(candidate, 'src'),
        alt: attributeOf(candidate, 'alt'),
        text: textOf(candidate as never),
        attributes: new Map(
          (candidate.attrs ?? []).map((attribute) => [
            attribute.name,
            attribute.value,
          ]),
        ),
      }
      if (element.tagName === 'html') root = element
      if (element.tagName === 'main') hasMain = true
      if (element.id && !elements.has(element.id)) elements.set(element.id, element)
      if (element.tagName === 'img') images.push(element)
    }
    for (const child of candidate.childNodes ?? []) visit(child)
  }
  visit(document)
  return { root, elements, images, hasMain }
}

/**
 * The verification of the app-owned presentation.
 *
 * The wrapper proves what it added before the artifact is published: the
 * landmark, the profile attribute, the published asset locations, the
 * inspected element of every table and the source fallback of every
 * asset-less figure. A package rendering that does not carry the expected
 * shape fails closed instead of publishing an artifact that lost content.
 */
export function assertPublicationPresentation(
  html: string,
  presentation: PublicationPresentation,
): void {
  const { root, elements, images, hasMain } = publicationHtmlElements(html)
  if (!root) throw new Error('The rendered XHTML carries no html element')
  if (root.attributes.get('data-profile') !== presentation.profile)
    throw new Error(
      `The rendered XHTML does not carry the ${presentation.profile} profile`,
    )
  if (!hasMain)
    throw new Error('The rendered XHTML carries no main landmark')
  const published = new Set(presentation.assetPaths.values())
  for (const image of images)
    if (!image.src || !published.has(image.src))
      throw new Error(
        `The rendered XHTML references an unpublished asset: ${image.src ?? ''}`,
      )
  for (const tableId of presentation.tableIds) {
    const table = elements.get(tableId)
    if (!table || table.tagName !== 'table')
      throw new Error(
        `The rendered XHTML does not carry the inspected table element ${tableId}`,
      )
  }
  for (const [figureId, figure] of presentation.figureSources) {
    const fallback = elements.get(`${figureId}-source`)
    if (!fallback || fallback.tagName !== 'pre')
      throw new Error(
        `The rendered XHTML does not carry the source fallback of figure ${figureId}`,
      )
    if (fallback.text !== figure.sourceText)
      throw new Error(
        `The source fallback of figure ${figureId} does not carry its canonical source text`,
      )
  }
}

/**
 * The well-formedness of an XHTML document.
 *
 * The EPUB content document is XML, so the app's packaging verifies it with
 * an XML validator before it is archived.
 */
export function assertWellFormedXhtml(xhtml: string, label: string): void {
  const result = XMLValidator.validate(xhtml)
  if (result !== true)
    throw new Error(`The ${label} is not well-formed XML: ${result.err.msg}`)
}

export async function prepareWebPubDirectory(directory: string) {
  await preparePublicationAssetDirectory(directory)
}

export async function preparePublicationAssetDirectory(directory: string) {
  // Exclusive creation: renders only ever write into directories this
  // invocation created itself, so a reused (possibly attacker-seeded) path
  // fails closed with EEXIST instead of being cleared and written into.
  await mkdir(directory)
}

async function createWebPub(
  bundle: PublicationBundle,
  outputDirectory: string,
  css: string,
  packageXhtml: string,
) {
  const root = resolve(outputDirectory, 'phone-webpub')
  await prepareWebPubDirectory(root)
  const assetPaths = await writeAssets(bundle, resolve(root, 'assets'))
  await writeFile(resolve(root, 'publication.css'), css, EXCLUSIVE_WRITE)
  const presentation = publicationPresentation(bundle, 'phone-webpub', {
    stylesheetHref: 'publication.css',
  })
  // The published asset locations are the ones the app wrote, so the
  // rendering and the asset directory can never disagree.
  for (const [href, path] of presentation.assetPaths)
    if (![...assetPaths.values()].includes(path))
      throw new Error(
        `The rendered WebPub references an asset the WebPub does not carry: ${path}`,
      )
  await writeFile(
    resolve(root, 'index.html'),
    wrapPublicationXhtml(packageXhtml, presentation),
    EXCLUSIVE_WRITE,
  )
  await copyFile(
    resolve('public/fonts/Geist-Regular.ttf'),
    resolve(root, 'Geist-Regular.ttf'),
    fsConstants.COPYFILE_EXCL,
  )
  await copyFile(
    resolve('public/fonts/Geist-Bold.ttf'),
    resolve(root, 'Geist-Bold.ttf'),
    fsConstants.COPYFILE_EXCL,
  )
  await copyFile(
    resolve('public/fonts/GeistMono-Regular.ttf'),
    resolve(root, 'GeistMono-Regular.ttf'),
    fsConstants.COPYFILE_EXCL,
  )
  await writeFile(
    resolve(root, 'publication.json'),
    `${JSON.stringify(
      {
        '@context': ['https://schema.org', 'https://www.w3.org/ns/pub-context'],
        type: 'Article',
        name: bundle.structDocument?.metadata.title ?? '',
        inLanguage: bundle.structDocument?.metadata.language ?? 'und',
        readingOrder: ['index.html'],
        resources: [
          'publication.css',
          'Geist-Regular.ttf',
          'Geist-Bold.ttf',
          'GeistMono-Regular.ttf',
          ...[...assetPaths.values()],
        ],
      },
      null,
      2,
    )}\n`,
    EXCLUSIVE_WRITE,
  )
  return root
}

function zipOptions(compression: 'STORE' | 'DEFLATE' = 'DEFLATE') {
  return { date: FIXED_DATE, compression, createFolders: false } as const
}

type EpubTocHeading = Pick<
  Extract<PublicationNode, { type: 'heading' }>,
  'id' | 'level' | 'locale' | 'text'
>

type EpubTocEntry = {
  heading: EpubTocHeading
  children: EpubTocEntry[]
}

export function publicationEpubTocHeadings(nodes: PublicationNode[]) {
  return nodes
    .map((node) => publicationNodeForProfile(node, 'eink-epub'))
    .filter(
      (node): node is Extract<PublicationNode, { type: 'heading' }> =>
        node.type === 'heading',
    )
}

export function renderEpubToc(headings: EpubTocHeading[]) {
  const roots: EpubTocEntry[] = []
  const firstHeadingLevel = headings.length
    ? Math.max(1, Math.trunc(headings[0].level))
    : 1
  const stack: Array<{ level: number; entry: EpubTocEntry }> = []
  for (const heading of headings) {
    const level = Math.max(1, Math.trunc(heading.level) - firstHeadingLevel + 1)
    const entry: EpubTocEntry = { heading, children: [] }
    while (stack.length && stack.at(-1)!.level >= level) stack.pop()
    if (stack.length) stack.at(-1)!.entry.children.push(entry)
    else roots.push(entry)
    stack.push({ level, entry })
  }
  const render = (entries: EpubTocEntry[]): string =>
    `<ol>${entries
      .map(
        ({ heading, children }) =>
          `<li><a href="content.xhtml#${escapeHtml(heading.id)}" lang="${escapeHtml(heading.locale)}">${escapeHtml(heading.text)}</a>${children.length ? render(children) : ''}</li>`,
      )
      .join('')}</ol>`
  return render(roots)
}

export function publicationEpubNavigationLabels(locale: string) {
  const language = String(locale).toLocaleLowerCase().split('-')[0]
  const labels = {
    title: 'Navigation',
    toc: 'Table of contents',
    contents: 'Contents',
    article: 'Article',
  }
  return language === 'en'
    ? labels
    : { ...labels, languageOverride: 'en' as const }
}

/**
 * The accessibility metadata of the EPUB package.
 *
 * The modes and the features are derived from the canonical document: the
 * text it carries, the assets it packages and the alternative texts it binds.
 * The block is app-owned packaging metadata; it never carries publication
 * text and it never reads the publication graph.
 */
export function publicationEpubAccessibilityMetadata(document: StructDocument) {
  const accessModes = new Set<string>()
  const features = new Set<string>()
  const packagedAssetIds = new Set(
    document.assets.filter((asset) => asset.bytes).map((asset) => asset.id),
  )
  const hasText = document.blocks.some(
    (block) =>
      Boolean(block.text?.trim()) ||
      block.kind === 'code' ||
      block.kind === 'equation' ||
      block.kind === 'table',
  )
  if (hasText || document.metadata.title.trim()) accessModes.add('textual')
  for (const block of document.blocks) {
    const attributes = block.attributes ?? {}
    if (
      typeof attributes.alternativeText === 'string' &&
      attributes.alternativeText.trim()
    )
      features.add('alternativeText')
    if (
      typeof attributes.longDescription === 'string' &&
      attributes.longDescription.trim()
    )
      features.add('longDescription')
    if (
      typeof attributes.transcript === 'string' &&
      attributes.transcript.trim()
    )
      features.add('transcript')
    if (
      block.kind === 'figure' &&
      (block.fallbackAssetIds ?? []).some((assetId) =>
        packagedAssetIds.has(assetId),
      )
    )
      accessModes.add('visual')
  }
  if (accessModes.size === 0) accessModes.add('textual')
  const orderedModes = ['textual', 'visual', 'auditory'].filter((mode) =>
    accessModes.has(mode),
  )
  const sufficient = hasText ? ['textual'] : orderedModes
  return {
    accessModes: orderedModes,
    accessModeSufficient: sufficient,
    accessibilityFeatures: [...features].sort(),
  }
}

type PreparedPdfRenderer =
  | {
      renderer: 'playwright-chromium'
      executablePath: string
      publicationBrowser: PublicationBrowserRuntimeEvidence
      assertUnchanged: () => Promise<void>
      verifyUnchanged: () => Promise<void>
      cleanup: () => Promise<void>
    }
  | {
      renderer: 'vivliostyle-cli'
      executablePath: string
      publicationBrowser: PublicationBrowserRuntimeEvidence
      assertUnchanged: () => Promise<void>
      verifyUnchanged: () => Promise<void>
      cleanup: () => Promise<void>
    }

async function preparePdfRenderer(): Promise<PreparedPdfRenderer> {
  const renderer = publicationPdfRendererForRuntime()
  if (renderer === 'playwright-chromium')
    return {
      renderer,
      ...(await preparePublicationPlaywrightRuntime()),
    }
  return {
    renderer: 'vivliostyle-cli',
    ...(await preparePublicationPuppeteerRuntime()),
  }
}

/**
 * The app-owned EPUB packaging of the pinned package builder output.
 *
 * The archive starts from the bytes the pinned package's EPUB builder
 * produced for the canonical document: its content document, its navigation
 * document, its package document and its packaged asset bytes. The app then
 * owns the packaging around it: the app stylesheet and fonts, the app
 * accessibility metadata, the app navigation landmarks and the app asset
 * locations. The package's own limits are preserved, and the app re-asserts
 * the archive size limit and the resource bindings before the archive is
 * written.
 */
export async function createPublicationEpub(
  bundle: PublicationBundle,
  outputPath: string,
  css: string,
) {
  const document = bundle.structDocument
  if (!document)
    throw new Error('The EPUB requires a Struct document')
  const built = await buildStructEpub(document)
  const zip = await JSZip.loadAsync(built.bytes)
  const presentation = publicationPresentation(bundle, 'eink-epub', {
    stylesheetHref: PACKAGE_STYLESHEET_HREF,
  })
  const content = await zip.file('EPUB/content.xhtml')?.async('string')
  if (!content)
    throw new Error('The package EPUB carries no content document')
  const wrapped = wrapPublicationXhtml(content, presentation)
  assertWellFormedXhtml(wrapped, 'EPUB/content.xhtml')
  zip.file('EPUB/content.xhtml', wrapped, zipOptions())
  const navigation = await zip.file('EPUB/nav.xhtml')?.async('string')
  if (!navigation)
    throw new Error('The package EPUB carries no navigation document')
  const labels = publicationEpubNavigationLabels(
    document.metadata.language ?? 'und',
  )
  const withLandmarks = withEpubLandmarks(navigation, labels)
  assertWellFormedXhtml(withLandmarks, 'EPUB/nav.xhtml')
  zip.file('EPUB/nav.xhtml', withLandmarks, zipOptions())
  zip.file('EPUB/styles.css', publicationEpubStylesheet(css), zipOptions())
  for (const font of PUBLICATION_FONTS)
    zip.file(
      `EPUB/fonts/${font}`,
      await readFile(resolve('public/fonts', font)),
      zipOptions(),
    )
  const assets = await publicationEpubAssets(
    document,
    bundle,
    zip,
    presentation,
  )
  const packageDocument = await zip.file('EPUB/package.opf')?.async('string')
  if (!packageDocument)
    throw new Error('The package EPUB carries no package document')
  zip.file(
    'EPUB/package.opf',
    publicationEpubPackageDocument(packageDocument, {
      assets,
      canonicalHrefs: [...presentation.assetPaths.keys()],
      accessibility: publicationEpubAccessibilityMetadata(document),
    }),
    zipOptions(),
  )
  // The mimetype is the first entry of an EPUB archive and it is stored
  // uncompressed. The package archive already carries it; it is written again
  // with the stored method so the repackaged archive keeps that contract.
  zip.file('mimetype', 'application/epub+zip', zipOptions('STORE'))
  const bytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  })
  assertStructEpubArchiveByteLength(bytes)
  assertPublicationEpubBindings(zip, bytes)
  await writeFile(outputPath, bytes, EXCLUSIVE_WRITE)
}

/**
 * The app stylesheet as the EPUB carries it.
 *
 * The paged rules belong to the PDF profiles, and the font references are
 * relative to the stylesheet inside the archive.
 */
export function publicationEpubStylesheet(css: string): string {
  const pagedRules = css.indexOf('@page a5')
  const base = pagedRules < 0 ? css : css.slice(0, pagedRules)
  return base
    .replaceAll("url('Geist-", "url('fonts/Geist-")
    .replace(
      "url('GeistMono-Regular.ttf')",
      "url('fonts/GeistMono-Regular.ttf')",
    )
}

/**
 * The app navigation landmarks of the package navigation document.
 *
 * The package navigation document carries the table of contents of the
 * canonical document. The app adds the landmarks its own navigation contract
 * requires; the labels are app-owned navigation labels.
 */
export function withEpubLandmarks(
  navigation: string,
  labels: ReturnType<typeof publicationEpubNavigationLabels>,
): string {
  const bodyEnd = navigation.lastIndexOf('</body>')
  if (bodyEnd < 0)
    throw new Error('The package navigation document carries no body')
  const generatedLanguage =
    'languageOverride' in labels ? ` lang="${labels.languageOverride}"` : ''
  const landmarks = `<nav epub:type="landmarks" hidden=""><ol><li><a epub:type="bodymatter" href="content.xhtml"${generatedLanguage}>${escapeHtml(labels.article)}</a></li></ol></nav>`
  return navigation.slice(0, bodyEnd) + landmarks + navigation.slice(bodyEnd)
}

/**
 * The published assets of the EPUB archive.
 *
 * The package archive carries every canonical asset under its canonical
 * href. The app publishes them at its own asset paths, deduplicated by
 * content, and the packaged bytes are verified against the app's asset
 * digest before they are published.
 */
async function publicationEpubAssets(
  document: StructDocument,
  bundle: PublicationBundle,
  zip: JSZip,
  presentation: PublicationPresentation,
): Promise<{ id: string; href: string; mediaType: string }[]> {
  const descriptors = publicationAssetDescriptors(document, bundle.assetBundle)
  const items: { id: string; href: string; mediaType: string }[] = []
  const published = new Set<string>()
  for (const asset of document.assets) {
    const appPath = presentation.assetPaths.get(asset.href)
    const descriptor = descriptors.get(asset.href)
    if (!appPath || !descriptor)
      throw new Error(
        `The EPUB does not publish the canonical asset ${asset.id}`,
      )
    const entry = zip.file(`EPUB/${asset.href}`)
    if (!entry)
      throw new Error(
        `The package EPUB carries no packaged asset ${asset.id}`,
      )
    const bytes = await entry.async('uint8array')
    if (sha256(bytes) !== descriptor.sha256)
      throw new Error(
        `The packaged asset bytes of ${asset.id} do not match the app asset digest`,
      )
    if (!published.has(appPath)) {
      published.add(appPath)
      zip.file(`EPUB/${appPath}`, bytes, zipOptions())
      items.push({
        id: publicationEpubManifestItemId(descriptor.id, items.length),
        href: appPath,
        mediaType: descriptor.mediaType,
      })
    }
    if (`EPUB/${asset.href}` !== `EPUB/${appPath}`)
      zip.remove(`EPUB/${asset.href}`)
  }
  return items
}

/**
 * The package document of the app-owned EPUB packaging.
 *
 * The package's own package document keeps its identifier, its title, its
 * language, its creators and its modification date. The app owns the
 * accessibility metadata and the manifest of the resources it ships.
 */
export function publicationEpubPackageDocument(
  packageDocument: string,
  options: {
    assets: { id: string; href: string; mediaType: string }[]
    canonicalHrefs: readonly string[]
    accessibility: ReturnType<typeof publicationEpubAccessibilityMetadata>
  },
): string {
  const canonicalHrefs = new Set(options.canonicalHrefs)
  let output = packageDocument.replace(/<item\b[^>]*\/>/gu, (item) => {
    const href = /href="([^"]*)"/u.exec(item)?.[1]
    return href && canonicalHrefs.has(href) ? '' : item
  })
  const fontItems = PUBLICATION_FONTS.map(
    (font, index) =>
      `<item id="${['font-sans', 'font-sans-bold', 'font-mono'][index]}" href="fonts/${font}" media-type="font/ttf"/>`,
  ).join('')
  const assetItems = options.assets
    .map(
      (asset) =>
        `<item id="${asset.id}" href="${asset.href}" media-type="${asset.mediaType}"/>`,
    )
    .join('')
  output = replaceLiteralOnce(
    output,
    '</manifest>',
    `${fontItems}${assetItems}</manifest>`,
    'manifest end',
  )
  const accessibility = options.accessibility
  const metadata = [
    ...accessibility.accessModes.map(
      (mode) => `<meta property="schema:accessMode">${mode}</meta>`,
    ),
    ...accessibility.accessModeSufficient.map(
      (mode) =>
        `<meta property="schema:accessModeSufficient">${mode}</meta>`,
    ),
    ...accessibility.accessibilityFeatures.map(
      (feature) =>
        `<meta property="schema:accessibilityFeature">${feature}</meta>`,
    ),
  ].join('')
  return replaceLiteralOnce(
    output,
    '</metadata>',
    `${metadata}</metadata>`,
    'metadata end',
  )
}

/**
 * The resource bindings of the packaged EPUB.
 *
 * Every stylesheet and every packaged resource the shipped XHTML references
 * has to be present in the archive, and every archive entry has to be
 * declared in the package manifest. The packaging proves that before the
 * archive is published.
 */
export async function assertPublicationEpubBindings(
  zip: JSZip,
  bytes: Uint8Array,
): Promise<void> {
  const packageDocument = await zip.file('EPUB/package.opf')?.async('string')
  if (!packageDocument)
    throw new Error('The packaged EPUB carries no package document')
  const declared = new Set<string>()
  for (const match of packageDocument.matchAll(/<item\b[^>]*\/>/gu)) {
    const href = /href="([^"]*)"/u.exec(match[0])?.[1]
    if (href) declared.add(href)
  }
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    const name = entry.name
    if (
      name === 'mimetype' ||
      name.startsWith('META-INF/') ||
      name === 'EPUB/package.opf'
    )
      continue
    const href = name.startsWith('EPUB/') ? name.slice('EPUB/'.length) : name
    if (!declared.has(href))
      throw new Error(
        `The packaged EPUB ships ${name}, which the package manifest does not declare`,
      )
  }
  for (const name of ['EPUB/content.xhtml', 'EPUB/nav.xhtml']) {
    const document = await zip.file(name)?.async('string')
    if (!document)
      throw new Error(`The packaged EPUB carries no ${name}`)
    for (const match of document.matchAll(/(?:href|src)="([^"]+)"/gu)) {
      const reference = match[1]!
      if (/^[a-z][a-z0-9+.-]*:/iu.test(reference)) continue
      if (reference.startsWith('#')) continue
      const [path] = reference.split('#')
      if (!path) continue
      if (!zip.file(`EPUB/${path}`))
        throw new Error(
          `The packaged EPUB references ${path}, which the archive does not carry`,
        )
    }
  }
  assertStructEpubArchiveByteLength(bytes)
}

async function run(command: string, args: string[], environment = process.env) {
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: environment,
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? accept()
        : reject(new Error(`${basename(command)} exited with status ${code}`)),
    )
  })
}

// PDF bytes are first written by the pinned browser or Vivliostyle CLI, which
// cannot take O_EXCL flags; both only ever target paths inside the fresh
// invocation-owned render directory created above, and this normalization
// rewrites that same invocation-created file in place.
async function normalizePdf(
  path: string,
  title: string,
  prepared: PreparedPdfRenderer,
) {
  const pdf = await PDFDocument.load(await readFile(path))
  pdf.setTitle(title)
  pdf.setAuthor('')
  pdf.setCreator('ernie.sg publication compiler')
  pdf.setProducer(
    prepared.renderer === 'vivliostyle-cli'
      ? `Vivliostyle CLI ${PUBLICATION_TOOLCHAIN.vivliostyleCli.version}`
      : `Playwright Chromium ${prepared.publicationBrowser.expectedVersion}`,
  )
  pdf.setCreationDate(FIXED_DATE)
  pdf.setModificationDate(FIXED_DATE)
  await writeFile(path, await pdf.save({ useObjectStreams: false }))
}

async function createPdf(
  htmlPath: string,
  outputPath: string,
  size: 'A4' | 'A5',
  prepared: PreparedPdfRenderer,
): Promise<void> {
  if (prepared.renderer === 'playwright-chromium') {
    await prepared.assertUnchanged()
    const browser = await chromium.launch({
      executablePath: prepared.executablePath,
      headless: true,
    })
    try {
      const page = await browser.newPage()
      await page.emulateMedia({ media: 'print' })
      await page.goto(pathToFileURL(htmlPath).href, {
        waitUntil: 'networkidle',
      })
      await page.pdf({
        path: outputPath,
        format: size,
        printBackground: true,
        tagged: true,
        outline: true,
      })
    } finally {
      await browser.close()
      await prepared.assertUnchanged()
    }
    return
  }
  const cli = resolve('node_modules/.bin/vivliostyle')
  await prepared.assertUnchanged()
  try {
    await run(
      cli,
      [
        'build',
        htmlPath,
        '--single-doc',
        '--output',
        outputPath,
        '--format',
        'pdf',
        '--size',
        size,
        '--executable-browser',
        prepared.executablePath,
        '--viewer-param',
        'allowScripts=false',
        '--no-vite-config-file',
        '--no-enable-static-serve',
        '--log-level',
        'silent',
      ],
      {
        ...process.env,
        NO_PROXY: '*',
        no_proxy: '*',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      },
    )
  } finally {
    await prepared.assertUnchanged()
  }
}

async function receiptFor(
  profile: PublicationProfile,
  path: string,
  renderer: ArtifactRenderer,
  receiptPath: string = profile,
): Promise<ArtifactReceipt> {
  const bytes = new Uint8Array(await readFile(path))
  const receipt: ArtifactReceipt = {
    profile,
    path: receiptPath,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    renderer,
  }
  if (profile.endsWith('-pdf')) {
    const pdf = await PDFDocument.load(bytes)
    receipt.pageCount = pdf.getPageCount()
    const page = pdf.getPage(0)
    receipt.geometry = {
      widthPoints: Number(page.getWidth().toFixed(3)),
      heightPoints: Number(page.getHeight().toFixed(3)),
    }
  }
  return receipt
}

async function publicationFiles(
  root: string,
  directory = root,
): Promise<ArtifactFile[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  )
  const files: ArtifactFile[] = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await publicationFiles(root, path)))
      continue
    }
    if (!entry.isFile()) continue
    const bytes = new Uint8Array(await readFile(path))
    files.push({
      path: relative(root, path).split(sep).join('/'),
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
    })
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function receiptForDirectory(
  profile: PublicationProfile,
  directory: string,
  renderer: ArtifactRenderer,
  receiptPath: string = profile,
): Promise<ArtifactReceipt> {
  const files = await publicationFiles(directory)
  return {
    profile,
    path: receiptPath,
    sha256: sha256(JSON.stringify(files)),
    byteLength: files.reduce((total, file) => total + file.byteLength, 0),
    renderer,
    files,
  }
}

/**
 * The Struct binding of one render, verified against the bundle wire.
 *
 * A source may hand over a binding that names the canonical document without
 * naming a bundle, because the bundle only exists once it is encoded. The
 * render binds the receipt to the wire bytes it produced, so a receipt never
 * claims a bundle it did not encode, and a binding that names another
 * document, another bundle or another semantic receipt is refused.
 */
export function publicationSourceBindingFor(
  binding: PublicationSourceBinding | undefined,
  wire: StructBundleWire,
): PublicationSourceBinding {
  if (!binding || binding.kind !== 'struct-cutover')
    throw new Error(
      'A publication render requires a Struct-cutover source binding',
    )
  if (binding.documentSha256 !== wire.documentSha256)
    throw new Error(
      'The source binding names another Struct document than the rendered one',
    )
  if (binding.bundleSha256 && binding.bundleSha256 !== wire.bundleSha256)
    throw new Error(
      'The source binding names another Struct bundle than the rendered one',
    )
  if (
    binding.semanticReceiptSha256 &&
    binding.semanticReceiptSha256 !== wire.semanticReceiptSha256
  )
    throw new Error(
      'The source binding names another semantic receipt than the rendered one',
    )
  return {
    ...binding,
    bundleSha256: wire.bundleSha256,
    semanticReceiptSha256: wire.semanticReceiptSha256,
  }
}

/**
 * Persist the semantic artifacts of a render.
 *
 * The publication graph is an ephemeral renderer plan and is never written
 * out. The persisted semantic artifacts are the canonical serialized Struct
 * document, the Struct bundle descriptor and the exact bundle wire bytes the
 * render was bound to, and they exist only when the render was given a Struct
 * document to derive them from. The asset bytes stay in the render output's
 * asset directory; they are not duplicated into the descriptor.
 */
export async function writePublicationSemanticArtifacts(
  output: string,
  bundle: PublicationBundle,
  wire?: StructBundleWire,
): Promise<StructBundleWire | undefined> {
  const document = bundle.structDocument
  if (!document) return undefined
  const bundleWire = wire ?? structBundleWire(document)
  await writeFile(
    resolve(output, 'struct-document.json'),
    structDocumentJson(document),
    EXCLUSIVE_WRITE,
  )
  await writeFile(
    resolve(output, 'struct-bundle.json'),
    `${JSON.stringify(bundleWire.descriptor, null, 2)}\n`,
    EXCLUSIVE_WRITE,
  )
  await writeFile(
    resolve(output, 'struct-bundle.bin'),
    bundleWire.bytes,
    EXCLUSIVE_WRITE,
  )
  return bundleWire
}

export const vivliostyleRenderer: PublicationRenderer = {
  id: 'vivliostyle',
  async render(bundle, request) {
    await verifyPublicationToolchain()
    const profiles = request.profiles as PublicationProfile[]
    if (
      profiles.length !== PUBLICATION_PROFILES.length ||
      PUBLICATION_PROFILES.some((profile) => !profiles.includes(profile))
    )
      throw new Error(
        `Publication output matrix must be exactly: ${PUBLICATION_PROFILES.join(',')}`,
      )
    const document = bundle.structDocument
    if (!document)
      throw new Error(
        'A publication render requires the canonical Struct document',
      )
    const output = resolve(request.outputDirectory)
    await mkdir(dirname(output), { recursive: true })
    try {
      // Exclusive creation: the render target must be a fresh directory this
      // invocation owns. Builds stage into a private directory and publish
      // atomically, so a reused target is always a policy violation.
      await mkdir(output)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST')
        throw new Error(
          `Publication render target already exists: ${output}; renders only write into a fresh invocation-owned directory`,
        )
      throw error
    }
    // The graph is an ephemeral renderer plan. It is never persisted: the
    // semantic artifacts of a render are the canonical Struct document, the
    // Struct bundle descriptor and the exact bundle wire bytes.
    const wire = structBundleWire(document)
    const sourceBinding = publicationSourceBindingFor(bundle.sourceBinding, wire)
    await writePublicationSemanticArtifacts(output, bundle, wire)
    await writeFile(
      resolve(output, 'asset-bundle.json'),
      `${JSON.stringify(bundle.assetBundle.descriptor, null, 2)}\n`,
      EXCLUSIVE_WRITE,
    )
    const css = await readFile(
      resolve('src/styles/publication/publication.css'),
      'utf8',
    )
    await writeFile(resolve(output, 'publication.css'), css, EXCLUSIVE_WRITE)
    // The semantic rendering of the publication is the pinned package's own
    // rendering of the canonical document. The app owns the presentation
    // around it.
    const packageXhtml = renderPublicationXhtml(document)
    const webpub = await createWebPub(bundle, output, css, packageXhtml)
    const epub = resolve(output, 'eink.epub')
    await createPublicationEpub(bundle, epub, css)
    const layoutAssets = await writeAssets(
      bundle,
      resolve(output, 'layout-assets'),
      'layout-assets/',
    )
    for (const font of PUBLICATION_FONTS)
      await copyFile(
        resolve('public/fonts', font),
        resolve(output, font),
        fsConstants.COPYFILE_EXCL,
      )
    const pdfArtifacts: ArtifactReceipt[] = []
    const preparedPdfRenderer = await preparePdfRenderer()
    const pdfRenderer = preparedPdfRenderer.renderer
    const publicationBrowser = preparedPdfRenderer.publicationBrowser
    try {
      for (const [profile, size] of [
        ['a5-pdf', 'A5'],
        ['a4-pdf', 'A4'],
      ] as const) {
        const htmlPath = resolve(output, `${profile}.html`)
        const presentation = publicationPresentation(bundle, profile, {
          stylesheetHref: 'publication.css',
          assetPrefix: 'layout-assets/',
        })
        for (const path of presentation.assetPaths.values())
          if (![...layoutAssets.values()].includes(path))
            throw new Error(
              `The rendered ${profile} references an asset the layout does not carry: ${path}`,
            )
        await writeFile(
          htmlPath,
          wrapPublicationXhtml(packageXhtml, presentation),
          EXCLUSIVE_WRITE,
        )
        const path = resolve(output, `${profile}.pdf`)
        await createPdf(htmlPath, path, size, preparedPdfRenderer)
        await normalizePdf(
          path,
          document.metadata.title,
          preparedPdfRenderer,
        )
        pdfArtifacts.push(
          await receiptFor(profile, path, pdfRenderer, `${profile}.pdf`),
        )
      }
      await preparedPdfRenderer.verifyUnchanged()
    } finally {
      await preparedPdfRenderer.cleanup()
    }
    const artifacts = [
      await receiptForDirectory(
        'phone-webpub',
        webpub,
        'semantic-html',
        'phone-webpub',
      ),
      await receiptFor('eink-epub', epub, 'jszip', 'eink.epub'),
      ...pdfArtifacts,
    ]
    const { execFileSync } = await import('node:child_process')
    const repository = {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      dirty:
        execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim()
          .length > 0,
    }
    const receipt: PublicationReceipt = {
      version: '1.0.0',
      // Diagnostic back-compat digests. They are never the source identity:
      // the source identity of this publication is the Struct binding and the
      // bundle wire bytes it was rendered from.
      source: {
        graphSha256: sha256(serializePublicationGraph(bundle.graph)),
        assetBundleSha256: sha256(serializeAssetBundle(bundle.assetBundle)),
      },
      sourceBinding,
      profiles: PROFILE_DETAILS,
      policyVersions: PUBLICATION_OUTPUT_POLICY_VERSIONS,
      toolchain: publicationToolchainForRuntime(publicationBrowser),
      repository,
      artifacts,
    }
    await writeFile(
      resolve(output, 'publication-receipt.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
      EXCLUSIVE_WRITE,
    )
    return receipt
  },
}
