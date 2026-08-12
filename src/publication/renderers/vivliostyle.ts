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
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { chromium } from 'playwright'
import { canonicalPublicationSubsetSha256 } from '../adapter-conformance'
import { serializeAssetBundle } from '../asset-bundle'
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
  source: { graphSha256: string; assetBundleSha256: string }
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
          node.noteKind === 'footnote'
            ? 'doc-footnote'
            : node.noteKind === 'endnote'
              ? 'doc-endnote'
              : 'doc-annotation'
        return `<aside ${nodeAttributes(node, edition, [`role="${role}"`])}><span class="note-label">${escapeHtml(node.label)}</span> ${text}${node.backlinkIds.map((id) => `<a class="backlink" href="#${id}" aria-label="Back to reference">↩</a>`).join('')}</aside>`
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
) {
  const root = resolve(outputDirectory, 'phone-webpub')
  await prepareWebPubDirectory(root)
  const assetPaths = await writeAssets(bundle, resolve(root, 'assets'))
  await writeFile(resolve(root, 'publication.css'), css, EXCLUSIVE_WRITE)
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
    resolve(root, 'index.html'),
    publicationGraphToHtml(bundle.graph, assetPaths, 'phone-webpub'),
    EXCLUSIVE_WRITE,
  )
  await writeFile(
    resolve(root, 'publication.json'),
    `${JSON.stringify(
      {
        '@context': ['https://schema.org', 'https://www.w3.org/ns/pub-context'],
        type: 'Article',
        name: bundle.graph.metadata.title,
        inLanguage: bundle.graph.edition.locale,
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

export function publicationEpubAccessibilityMetadata(graph: PublicationGraph) {
  const accessModes = new Set<string>()
  const features = new Set<string>()
  const hasText = graph.nodes.some(
    (node) =>
      ('text' in node && Boolean(node.text.trim())) ||
      node.type === 'code' ||
      node.type === 'equation' ||
      node.type === 'table',
  )
  if (hasText || graph.metadata.title.trim()) accessModes.add('textual')
  for (const node of graph.nodes) {
    const accessibility = node.accessibility
    if (accessibility.alternativeText?.trim())
      features.add('alternativeText')
    if (accessibility.longDescription?.trim()) features.add('longDescription')
    if (accessibility.transcript?.trim()) features.add('transcript')
    if (node.type === 'figure' && node.assetIds.length > 0)
      accessModes.add('visual')
    if (node.type !== 'media') continue
    if (node.mediaKind === 'image' || node.mediaKind === 'video')
      accessModes.add('visual')
    if (node.mediaKind === 'audio' || node.mediaKind === 'video')
      accessModes.add('auditory')
    if (node.mediaKind === 'interactive') accessModes.add('visual')
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
      cleanup: () => Promise<void>
    }
  | {
      renderer: 'vivliostyle-cli'
      executablePath: string
      publicationBrowser: PublicationBrowserRuntimeEvidence
      assertUnchanged: () => Promise<void>
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

async function createEpub(
  bundle: PublicationBundle,
  outputPath: string,
  css: string,
) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', zipOptions('STORE'))
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    zipOptions(),
  )
  const assetPaths = new Map<string, string>()
  const assetItems: string[] = []
  for (const [
    index,
    descriptor,
  ] of bundle.assetBundle.descriptor.assets.entries()) {
    const extension = publicationAssetFileExtension(
      descriptor.fileName,
      descriptor.mediaType,
    )
    const file = `assets/${descriptor.id}${extension}`
    assetPaths.set(descriptor.id, file)
    zip.file(
      `EPUB/${file}`,
      await bundle.assetBundle.resolveBytes(descriptor),
      zipOptions(),
    )
    assetItems.push(
      `<item id="${publicationEpubManifestItemId(descriptor.id, index)}" href="${file}" media-type="${descriptor.mediaType}"/>`,
    )
  }
  for (const font of [
    'Geist-Regular.ttf',
    'Geist-Bold.ttf',
    'GeistMono-Regular.ttf',
  ]) {
    zip.file(
      `EPUB/fonts/${font}`,
      await readFile(resolve('public/fonts', font)),
      zipOptions(),
    )
  }
  zip.file(
    'EPUB/publication.css',
    css
      .slice(0, css.indexOf('@page a5'))
      .replaceAll("url('Geist-", "url('fonts/Geist-")
      .replace(
        "url('GeistMono-Regular.ttf')",
        "url('fonts/GeistMono-Regular.ttf')",
      ),
    zipOptions(),
  )
  const xhtml = publicationGraphToHtml(bundle.graph, assetPaths, 'eink-epub')
    .replace('<!doctype html>', '<?xml version="1.0" encoding="utf-8"?>')
    .replace('<html ', '<html xmlns="http://www.w3.org/1999/xhtml" ')
    .replaceAll(/<(meta|link|img|br)([^>]*?)(?<!\/)>/g, '<$1$2 />')
  zip.file('EPUB/content.xhtml', xhtml, zipOptions())
  const headings = publicationEpubTocHeadings(bundle.graph.nodes)
  const navigationLabels = publicationEpubNavigationLabels(
    bundle.graph.edition.locale,
  )
  const generatedLanguage =
    'languageOverride' in navigationLabels
      ? ` lang="${navigationLabels.languageOverride}"`
      : ''
  const accessibility = publicationEpubAccessibilityMetadata(bundle.graph)
  const accessModeMetadata = accessibility.accessModes
    .map((mode) => `<meta property="schema:accessMode">${mode}</meta>`)
    .join('')
  const accessModeSufficientMetadata = accessibility.accessModeSufficient
    .map(
      (mode) =>
        `<meta property="schema:accessModeSufficient">${mode}</meta>`,
    )
    .join('')
  const accessibilityFeatureMetadata = accessibility.accessibilityFeatures
    .map(
      (feature) =>
        `<meta property="schema:accessibilityFeature">${feature}</meta>`,
    )
    .join('')
  const contributorMetadata = bundle.graph.metadata.contributors
    .map((contributor) => `<dc:creator>${escapeHtml(contributor)}</dc:creator>`)
    .join('')
  zip.file(
    'EPUB/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${bundle.graph.edition.locale}"><head><title${generatedLanguage}>${escapeHtml(navigationLabels.title)}</title></head><body><nav epub:type="toc"${generatedLanguage} aria-label="${escapeHtml(navigationLabels.toc)}"><h1${generatedLanguage}>${escapeHtml(navigationLabels.contents)}</h1>${renderEpubToc(headings)}</nav><nav epub:type="landmarks" hidden=""><ol><li><a epub:type="bodymatter" href="content.xhtml"${generatedLanguage}>${escapeHtml(navigationLabels.article)}</a></li></ol></nav></body></html>`,
    zipOptions(),
  )
  const identifier = `urn:sha256:${canonicalPublicationSubsetSha256(bundle)}`
  zip.file(
    'EPUB/package.opf',
    `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${bundle.graph.edition.locale}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">${identifier}</dc:identifier><dc:title>${escapeHtml(bundle.graph.metadata.title)}</dc:title>${contributorMetadata}<dc:language>${bundle.graph.edition.locale}</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>${accessModeMetadata}${accessModeSufficientMetadata}${accessibilityFeatureMetadata}</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="content" href="content.xhtml" media-type="application/xhtml+xml"/><item id="css" href="publication.css" media-type="text/css"/><item id="font-sans" href="fonts/Geist-Regular.ttf" media-type="font/ttf"/><item id="font-sans-bold" href="fonts/Geist-Bold.ttf" media-type="font/ttf"/><item id="font-mono" href="fonts/GeistMono-Regular.ttf" media-type="font/ttf"/>${assetItems.join('')}</manifest><spine><itemref idref="content"/></spine></package>`,
    zipOptions(),
  )
  await writeFile(
    outputPath,
    await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
      platform: 'UNIX',
    }),
    EXCLUSIVE_WRITE,
  )
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
    await writeFile(
      resolve(output, 'publication-graph.json'),
      `${JSON.stringify(bundle.graph, null, 2)}\n`,
      EXCLUSIVE_WRITE,
    )
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
    const webpub = await createWebPub(bundle, output, css)
    const epub = resolve(output, 'eink.epub')
    await createEpub(bundle, epub, css)
    const layoutAssets = await writeAssets(
      bundle,
      resolve(output, 'layout-assets'),
      'layout-assets/',
    )
    for (const font of [
      'Geist-Regular.ttf',
      'Geist-Bold.ttf',
      'GeistMono-Regular.ttf',
    ])
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
        await writeFile(
          htmlPath,
          publicationGraphToHtml(bundle.graph, layoutAssets, profile),
          EXCLUSIVE_WRITE,
        )
        const path = resolve(output, `${profile}.pdf`)
        await createPdf(htmlPath, path, size, preparedPdfRenderer)
        await normalizePdf(
          path,
          bundle.graph.metadata.title,
          preparedPdfRenderer,
        )
        pdfArtifacts.push(
          await receiptFor(profile, path, pdfRenderer, `${profile}.pdf`),
        )
      }
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
      source: {
        graphSha256: sha256(serializePublicationGraph(bundle.graph)),
        assetBundleSha256: sha256(serializeAssetBundle(bundle.assetBundle)),
      },
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
