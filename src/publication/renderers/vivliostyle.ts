import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { Browser, computeExecutablePath } from '@puppeteer/browsers'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { chromium } from 'playwright'
import { serializeAssetBundle } from '../asset-bundle'
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
  publicationToolchainForRuntime,
  publicationPdfRendererForArchitecture,
  verifyPublicationToolchain,
} from '../toolchain'

export const PUBLICATION_PROFILES = [
  'phone-webpub',
  'eink-epub',
  'a5-pdf',
  'a4-pdf',
] as const
export type PublicationProfile = (typeof PUBLICATION_PROFILES)[number]

const FIXED_DATE = new Date('2000-01-01T00:00:00.000Z')
const PUBLICATION_BROWSER_CACHE = resolve(
  'node_modules/.cache/publication-browsers',
)
const PLAYWRIGHT_BROWSER_CACHE = resolve(
  PUBLICATION_BROWSER_CACHE,
  'playwright',
)
const PUPPETEER_BROWSER_CACHE = resolve(PUBLICATION_BROWSER_CACHE, 'puppeteer')
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
  policyVersions: {
    renderer: '1.0.0'
    semanticHtml: '1.0.0'
    accessibility: '1.0.0'
  }
  toolchain: typeof PUBLICATION_TOOLCHAIN
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

function inlineHtml(text: string, runs: PublicationInlineRun[] = []) {
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
      let value = active.some((run) => run.hardBreak)
        ? '<br>'
        : escapeHtml(text.slice(start, end))
      if (!value) return undefined
      if (active.some((run) => run.compactMathAtom))
        value = `<span class="math">${value}</span>`
      if (active.some((run) => run.inlineCode)) value = `<code>${value}</code>`
      if (active.some((run) => run.italic)) value = `<em>${value}</em>`
      if (active.some((run) => run.bold)) value = `<strong>${value}</strong>`
      if (active.some((run) => run.strikethrough)) value = `<del>${value}</del>`
      const verticalAlign = active.find((run) => run.verticalAlign)
      if (verticalAlign?.verticalAlign === 'superscript')
        value = `<sup>${value}</sup>`
      else if (verticalAlign?.verticalAlign === 'subscript')
        value = `<sub>${value}</sub>`
      const link = active.find(
        (run) =>
          Boolean(run.href) ||
          (run.semanticRole === 'citation' && Boolean(run.targetIds?.length)),
      )
      return { value, link }
    })
    .filter(Boolean) as Array<{
    value: string
    link?: PublicationInlineRun
  }>
  const linkHref = (link: PublicationInlineRun) =>
    link.href ?? `#${link.targetIds?.[0] ?? ''}`
  const linkKey = (link?: PublicationInlineRun) =>
    link
      ? JSON.stringify([
          linkHref(link),
          link.relationshipId,
          link.semanticRole,
          link.targetIds,
        ])
      : ''
  const linkAttributes = (link: PublicationInlineRun) =>
    [
      `href="${escapeHtml(linkHref(link))}"`,
      ...(link.relationshipId
        ? [`id="${escapeHtml(link.relationshipId)}"`]
        : []),
      ...(link.semanticRole === 'cross-reference' &&
      link.relationshipId?.startsWith('ref-')
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
  for (let index = 0; index < segments.length; ) {
    const segment = segments[index]!
    if (!segment.link) {
      html += segment.value
      index += 1
      continue
    }
    const key = linkKey(segment.link)
    let value = segment.value
    let end = index + 1
    while (end < segments.length && linkKey(segments[end]!.link) === key) {
      value += segments[end]!.value
      end += 1
    }
    html += `<a ${linkAttributes(segment.link)}>${value}</a>`
    index = end
  }
  return html
}

function renderNode(
  node: PublicationNode,
  byId: Map<string, PublicationNode>,
  assetPaths: Map<string, string>,
  listStack = new Set<string>(),
): string {
  const text = 'text' in node ? inlineHtml(node.text, node.inlineRuns) : ''
  switch (node.type) {
    case 'heading':
      return `<h${node.level} id="${node.id}">${text}</h${node.level}>`
    case 'paragraph':
      return `<p id="${node.id}">${text}</p>`
    case 'list': {
      if (listStack.has(node.id))
        throw new Error(`Cyclic nested list relationship at ${node.id}`)
      const nextListStack = new Set(listStack).add(node.id)
      const tag = node.ordered ? 'ol' : 'ul'
      const start =
        node.ordered && node.start !== undefined
          ? ` start="${node.start}"`
          : ''
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
            .map((child) => renderNode(child, byId, assetPaths, nextListStack))
            .join('')
          return `<li id="${item.id}">${inlineHtml(item.text, item.inlineRuns)}${nested}</li>`
        })
        .join('')
      return `<${tag} id="${node.id}"${start}>${items}</${tag}>`
    }
    case 'list-item':
    case 'caption':
      return ''
    case 'quote':
      return `<blockquote id="${node.id}"><p>${text}</p>${node.attribution ? `<cite>${escapeHtml(node.attribution)}</cite>` : ''}</blockquote>`
    case 'code':
      return `<pre id="${node.id}"><code${node.language ? ` class="language-${escapeHtml(node.language)}"` : ''}>${escapeHtml(node.code)}</code></pre>`
    case 'equation':
      if (node.format === 'mathml')
        throw new Error('MathML equation rendering is unsupported')
      {
        const caption = node.captionId ? byId.get(node.captionId) : undefined
        return `<div id="${node.id}" class="equation" role="math" data-format="${node.format}">${escapeHtml(node.source)}${caption?.type === 'caption' ? `<div class="caption" id="${caption.id}">${inlineHtml(caption.text, caption.inlineRuns)}</div>` : ''}</div>`
      }
    case 'note':
      return `<aside id="${node.id}" role="doc-footnote"><span class="note-label">${escapeHtml(node.label)}</span> ${text}${node.backlinkIds.map((id) => `<a class="backlink" href="#${id}" aria-label="Back to reference">↩</a>`).join('')}</aside>`
    case 'figure': {
      const caption = node.captionId ? byId.get(node.captionId) : undefined
      const alternativeText = accessibilityLabel(node)
      if (!node.accessibility.decorative && !alternativeText)
        throw new Error(
          `Figure ${node.id} requires alternative text or a long description`,
        )
      const assets = node.assetIds
        .map(
          (assetId) =>
            `<img src="${escapeHtml(assetPaths.get(assetId) ?? '')}" alt="${escapeHtml(alternativeText)}">`,
        )
        .join('')
      const source = node.sourceText
        ? `<pre id="${node.id}-source" class="figure-source"${alternativeText ? ` aria-label="${escapeHtml(alternativeText)}"` : ''}>${escapeHtml(node.sourceText)}</pre>`
        : ''
      if (!assets && !source)
        throw new Error(
          `Figure ${node.id} has no renderable asset or source text`,
        )
      return `<figure id="${node.id}">${assets}${source}${caption?.type === 'caption' ? `<figcaption id="${caption.id}">${inlineHtml(caption.text, caption.inlineRuns)}</figcaption>` : ''}</figure>`
    }
    case 'reference':
      return `<p id="${node.id}" role="doc-biblioentry">${node.href ? `<a href="${escapeHtml(node.href)}">${text}</a>` : node.targetIds[0] ? `<a href="#${escapeHtml(node.targetIds[0])}" role="doc-biblioref">${text}</a>` : text}</p>`
    case 'aside':
      return `<aside id="${node.id}">${text}</aside>`
    case 'media':
      {
        const source = escapeHtml(assetPaths.get(node.assetId) ?? '')
        const label = accessibilityLabel(node)
        if (!node.accessibility.decorative && !label)
          throw new Error(
            `Media ${node.id} requires alternative text, a long description, or a transcript`,
          )
        const alternativeText = escapeHtml(label)
        const media =
          node.mediaKind === 'image'
            ? `<img src="${source}" alt="${alternativeText}">`
            : node.mediaKind === 'audio'
              ? `<audio controls src="${source}" aria-label="${alternativeText}"></audio>`
              : node.mediaKind === 'video'
                ? `<video controls src="${source}" aria-label="${alternativeText}"></video>`
                : `<a href="${source}" aria-label="${alternativeText}">${alternativeText}</a>`
        const caption = node.captionId ? byId.get(node.captionId) : undefined
        return `<figure id="${node.id}">${media}${caption?.type === 'caption' ? `<figcaption id="${caption.id}">${inlineHtml(caption.text, caption.inlineRuns)}</figcaption>` : ''}</figure>`
      }
    case 'table':
      {
        const caption = node.captionId ? byId.get(node.captionId) : undefined
        const rows = node.rows
          .map(
            (row) =>
              `<tr>${row.cells
                .map((cell) => {
                  const tag = cell.headerScope ? 'th' : 'td'
                  const attributes = [
                    ...(cell.id ? [`id="${escapeHtml(cell.id)}"`] : []),
                    ...(cell.headerScope
                      ? [`scope="${cell.headerScope}"`]
                      : []),
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
        return `<table id="${node.id}">${caption?.type === 'caption' ? `<caption id="${caption.id}">${inlineHtml(caption.text, caption.inlineRuns)}</caption>` : ''}${rows}</table>`
      }
  }
}

function accessibilityLabel(node: PublicationNode) {
  return (
    node.accessibility.alternativeText ??
    node.accessibility.longDescription ??
    node.accessibility.transcript ??
    ''
  )
}

export function publicationGraphToHtml(
  graph: PublicationGraph,
  assetPaths: Map<string, string>,
  profile: PublicationProfile,
  stylesheet = 'publication.css',
) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
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
    .map((node) => renderNode(node, byId, assetPaths))
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
  await mkdir(directory, { recursive: true })
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
    )
    paths.set(descriptor.id, `${prefix}${fileName}`)
  }
  return paths
}

export function publicationAssetFileExtension(
  fileName: string | undefined,
  mediaType: string,
) {
  const candidate = extname(fileName ?? '').toLocaleLowerCase()
  if (/^\.[a-z0-9]+$/u.test(candidate)) return candidate
  const subtype = mediaType.split('/')[1]?.split(/[+;]/u)[0] ?? ''
  return /^[a-z0-9]+$/iu.test(subtype)
    ? `.${subtype.toLocaleLowerCase()}`
    : '.bin'
}

export async function prepareWebPubDirectory(directory: string) {
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
}

async function createWebPub(
  bundle: PublicationBundle,
  outputDirectory: string,
  css: string,
) {
  const root = resolve(outputDirectory, 'phone-webpub')
  await prepareWebPubDirectory(root)
  const assetPaths = await writeAssets(bundle, resolve(root, 'assets'))
  await writeFile(resolve(root, 'publication.css'), css)
  await copyFile(
    resolve('public/fonts/Geist-Regular.ttf'),
    resolve(root, 'Geist-Regular.ttf'),
  )
  await copyFile(
    resolve('public/fonts/Geist-Bold.ttf'),
    resolve(root, 'Geist-Bold.ttf'),
  )
  await copyFile(
    resolve('public/fonts/GeistMono-Regular.ttf'),
    resolve(root, 'GeistMono-Regular.ttf'),
  )
  await writeFile(
    resolve(root, 'index.html'),
    publicationGraphToHtml(bundle.graph, assetPaths, 'phone-webpub'),
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
  )
  return root
}

function zipOptions(compression: 'STORE' | 'DEFLATE' = 'DEFLATE') {
  return { date: FIXED_DATE, compression, createFolders: false } as const
}

type EpubTocHeading = Pick<
  Extract<PublicationNode, { type: 'heading' }>,
  'id' | 'level' | 'text'
>

type EpubTocEntry = {
  heading: EpubTocHeading
  children: EpubTocEntry[]
}

export function renderEpubToc(headings: EpubTocHeading[]) {
  const roots: EpubTocEntry[] = []
  const stack: Array<{ level: number; entries: EpubTocEntry[] }> = [
    { level: 0, entries: roots },
  ]
  const firstHeadingLevel = headings.length
    ? Math.max(1, Math.trunc(headings[0].level))
    : 1
  for (const heading of headings) {
    let level = Math.max(
      1,
      Math.trunc(heading.level) - firstHeadingLevel + 1,
    )
    if (roots.length === 0) {
      level = 1
      stack[0].level = level
    } else {
      while (stack.length > 1 && level < stack.at(-1)!.level)
        stack.pop()
      if (level > stack.at(-1)!.level) {
        const parent = stack.at(-1)!.entries.at(-1)
        if (parent) stack.push({ level, entries: parent.children })
        else level = stack.at(-1)!.level
      }
    }
    stack.at(-1)!.entries.push({ heading, children: [] })
  }
  const render = (entries: EpubTocEntry[]): string =>
    `<ol>${entries
      .map(
        ({ heading, children }) =>
          `<li><a href="content.xhtml#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>${children.length ? render(children) : ''}</li>`,
      )
      .join('')}</ol>`
  return render(roots)
}

export function publicationPlaywrightExecutableCandidates(
  revision: string,
  platform = process.platform,
  architecture = process.arch,
) {
  const platformKey =
    platform === 'darwin'
      ? `mac-${architecture === 'arm64' ? 'arm64' : 'x64'}`
      : platform === 'win32'
        ? 'win-x64'
        : `linux-${architecture === 'arm64' ? 'arm64' : 'x64'}`
  const chromiumPaths: Record<string, string[]> = {
    'linux-x64': ['chrome-linux64', 'chrome'],
    'linux-arm64': ['chrome-linux', 'chrome'],
    'mac-x64': [
      'chrome-mac-x64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ],
    'mac-arm64': [
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ],
    'win-x64': ['chrome-win64', 'chrome.exe'],
  }
  const headlessPaths: Record<string, string[]> = {
    'linux-x64': ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    'linux-arm64': ['chrome-linux', 'headless_shell'],
    'mac-x64': ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
    'mac-arm64': ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
    'win-x64': ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
  }
  return [
    resolve(
      PLAYWRIGHT_BROWSER_CACHE,
      `chromium-${revision}`,
      ...chromiumPaths[platformKey],
    ),
    resolve(
      PLAYWRIGHT_BROWSER_CACHE,
      `chromium_headless_shell-${revision}`,
      ...headlessPaths[platformKey],
    ),
  ]
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
  for (const descriptor of bundle.assetBundle.descriptor.assets) {
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
      `<item id="${descriptor.id}" href="${file}" media-type="${descriptor.mediaType}"/>`,
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
  const headings = bundle.graph.nodes.filter(
    (node): node is Extract<PublicationNode, { type: 'heading' }> =>
      node.type === 'heading',
  )
  zip.file(
    'EPUB/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${bundle.graph.edition.locale}"><head><title>Navigation</title></head><body><nav epub:type="toc" aria-label="Table of contents"><h1>Contents</h1>${renderEpubToc(headings)}</nav><nav epub:type="landmarks" hidden=""><ol><li><a epub:type="bodymatter" href="content.xhtml">Article</a></li></ol></nav></body></html>`,
    zipOptions(),
  )
  const identifier = `urn:sha256:${sha256(serializePublicationGraph(bundle.graph))}`
  zip.file(
    'EPUB/package.opf',
    `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${bundle.graph.edition.locale}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">${identifier}</dc:identifier><dc:title>${escapeHtml(bundle.graph.metadata.title)}</dc:title><dc:language>${bundle.graph.edition.locale}</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta><meta property="schema:accessMode">textual</meta><meta property="schema:accessModeSufficient">textual</meta><meta property="schema:accessibilityFeature">alternativeText</meta><meta property="schema:accessibilityHazard">none</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="content" href="content.xhtml" media-type="application/xhtml+xml"/><item id="css" href="publication.css" media-type="text/css"/><item id="font-sans" href="fonts/Geist-Regular.ttf" media-type="font/ttf"/><item id="font-sans-bold" href="fonts/Geist-Bold.ttf" media-type="font/ttf"/><item id="font-mono" href="fonts/GeistMono-Regular.ttf" media-type="font/ttf"/>${assetItems.join('')}</manifest><spine><itemref idref="content"/></spine></package>`,
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

type PdfRenderer = Extract<
  ArtifactRenderer,
  'vivliostyle-cli' | 'playwright-chromium'
>

async function normalizePdf(
  path: string,
  title: string,
  renderer: PdfRenderer,
) {
  const pdf = await PDFDocument.load(await readFile(path))
  pdf.setTitle(title)
  pdf.setAuthor('')
  pdf.setCreator('ernie.sg publication compiler')
  pdf.setProducer(
    renderer === 'vivliostyle-cli'
      ? `Vivliostyle CLI ${PUBLICATION_TOOLCHAIN.vivliostyleCli.version}`
      : `Playwright Chromium ${PUBLICATION_TOOLCHAIN.browser.compatibility.arm64BrowserVersion}`,
  )
  pdf.setCreationDate(FIXED_DATE)
  pdf.setModificationDate(FIXED_DATE)
  await writeFile(path, await pdf.save({ useObjectStreams: false }))
}

async function createPdf(
  htmlPath: string,
  outputPath: string,
  size: 'A4' | 'A5',
): Promise<PdfRenderer> {
  const renderer = publicationPdfRendererForArchitecture()
  if (renderer === 'playwright-chromium') {
    const revision = PUBLICATION_TOOLCHAIN.browser.compatibility.arm64Revision
    const candidates = publicationPlaywrightExecutableCandidates(revision)
    const executablePath = await candidates.reduce<Promise<string>>(
      async (previous, candidate) => {
        const found = await previous
        if (found) return found
        try {
          await access(candidate)
          return candidate
        } catch {
          return ''
        }
      },
      Promise.resolve(''),
    )
    if (!executablePath)
      throw new Error(
        'Pinned Playwright Chromium is not installed in the repository-local publication browser cache. Run `npm ci` before disabling network access.',
      )
    const browser = await chromium.launch({ executablePath, headless: true })
    try {
      const page = await browser.newPage()
      await page.emulateMedia({ media: 'print' })
      await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' })
      await page.pdf({
        path: outputPath,
        format: size,
        printBackground: true,
        tagged: true,
        outline: true,
      })
    } finally {
      await browser.close()
    }
    return 'playwright-chromium'
  }
  if (renderer !== 'vivliostyle-cli')
    throw new Error(`Unsupported PDF renderer policy: ${renderer}`)
  let browserPath: string
  try {
    browserPath = computeExecutablePath({
      browser: Browser.CHROME,
      buildId: PUBLICATION_TOOLCHAIN.browser.revision,
      cacheDir: PUPPETEER_BROWSER_CACHE,
    })
    await chmod(browserPath, 0o755)
  } catch {
    throw new Error(
      'Pinned Chromium is not installed in the repository-local publication browser cache. Run `npm ci` before disabling network access.',
    )
  }
  const cli = resolve('node_modules/.bin/vivliostyle')
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
      browserPath,
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
  return 'vivliostyle-cli'
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
    await mkdir(output, { recursive: true })
    await writeFile(
      resolve(output, 'publication-graph.json'),
      `${JSON.stringify(bundle.graph, null, 2)}\n`,
    )
    await writeFile(
      resolve(output, 'asset-bundle.json'),
      `${JSON.stringify(bundle.assetBundle.descriptor, null, 2)}\n`,
    )
    const css = await readFile(
      resolve('src/styles/publication/publication.css'),
      'utf8',
    )
    await writeFile(resolve(output, 'publication.css'), css)
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
      await copyFile(resolve('public/fonts', font), resolve(output, font))
    const pdfArtifacts: ArtifactReceipt[] = []
    for (const [profile, size] of [
      ['a5-pdf', 'A5'],
      ['a4-pdf', 'A4'],
    ] as const) {
      const htmlPath = resolve(output, `${profile}.html`)
      await writeFile(
        htmlPath,
        publicationGraphToHtml(bundle.graph, layoutAssets, profile),
      )
      const path = resolve(output, `${profile}.pdf`)
      const renderer = await createPdf(htmlPath, path, size)
      await normalizePdf(path, bundle.graph.metadata.title, renderer)
      pdfArtifacts.push(
        await receiptFor(profile, path, renderer, `${profile}.pdf`),
      )
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
      policyVersions: {
        renderer: '1.0.0',
        semanticHtml: '1.0.0',
        accessibility: '1.0.0',
      },
      toolchain: publicationToolchainForRuntime(),
      repository,
      artifacts,
    }
    await writeFile(
      resolve(output, 'publication-receipt.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
    )
    return receipt
  },
}
