import { strToU8, type ZipOptions } from 'fflate'
import type { PublicationAsset } from './import-types'
import { attribute, comparableText, stableId, text } from './epub-semantic-text'
import type { ResearchNode, ResearchPaper } from './schema'
import { targetProfileSchema } from './target-schema'
import type { TargetProfile } from './targets'
import { downscalePngAsset } from './visual-assets'

export const EPUB_MIMETYPE = 'application/epub+zip'
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0)
export const EPUB_EXPORT_POLICY_VERSION = '1.2.0' as const
export type EpubExportMode = 'publication' | 'readable-fallback'
const COMPACT_RASTER_TABLE_SCROLL_MIN_SOURCE_WIDTH_PX = 1_000

export function isCompactScrollableTableImage({
  kind,
  mediaType,
  width,
  height,
}: Pick<PublicationAsset, 'kind' | 'mediaType' | 'width' | 'height'>) {
  return (
    kind === 'table' &&
    mediaType.startsWith('image/') &&
    (width / height >= 2 ||
      width >= COMPACT_RASTER_TABLE_SCROLL_MIN_SOURCE_WIDTH_PX)
  )
}

function publicationLanguage(paper: ResearchPaper) {
  return paper.language ?? 'und'
}

function publicationBaseDirection(paper: ResearchPaper) {
  return paper.baseDirection === 'ltr' || paper.baseDirection === 'rtl'
    ? paper.baseDirection
    : undefined
}

export function xhtmlLanguageAttributes(paper: ResearchPaper) {
  const language = attribute(publicationLanguage(paper))
  const direction = publicationBaseDirection(paper)
  return `xml:lang="${language}" lang="${language}"${direction ? ` dir="${direction}"` : ''}`
}

export function navXhtml(paper: ResearchPaper) {
  const canonicalTitleNode = paper.nodes.find(
    (node): node is Extract<ResearchNode, { type: 'heading' | 'paragraph' }> =>
      (node.type === 'heading' || node.type === 'paragraph') &&
      comparableText(node.text) === comparableText(paper.title),
  )
  const headings = paper.nodes.filter(
    (node): node is Extract<ResearchNode, { type: 'heading' }> =>
      node.type === 'heading' && node.id !== canonicalTitleNode?.id,
  )
  const titleHref = canonicalTitleNode
    ? `content.xhtml#${attribute(stableId(canonicalTitleNode.id))}`
    : 'content.xhtml#publication-title'
  type NavigationItem = {
    node: (typeof headings)[number]
    children: NavigationItem[]
  }
  const roots: NavigationItem[] = []
  const ancestors: Array<{
    level: number
    item: NavigationItem
  }> = []
  for (const node of headings) {
    while (
      ancestors.length > 0 &&
      ancestors[ancestors.length - 1].level >= node.level
    ) {
      ancestors.pop()
    }
    const item = { node, children: [] }
    const parent = ancestors.at(-1)?.item
    if (parent) parent.children.push(item)
    else roots.push(item)
    ancestors.push({ level: node.level, item })
  }
  const renderNavigationItem = (item: NavigationItem): string =>
    `<li><a href="content.xhtml#${attribute(stableId(item.node.id))}">${text(item.node.text)}</a>${item.children.length > 0 ? `<ol>${item.children.map(renderNavigationItem).join('')}</ol>` : ''}</li>`
  const items = [
    `<li><a href="${titleHref}">${text(paper.title)}</a></li>`,
    ...roots.map(renderNavigationItem),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" ${xhtmlLanguageAttributes(paper)}>
<head><meta charset="UTF-8" /><title>Contents</title></head>
<body>
  <nav epub:type="toc" role="doc-toc" id="toc" aria-label="Table of contents">
    <h1>Contents</h1>
    <ol>${items.join('\n')}</ol>
  </nav>
</body>
</html>
`
}

export const EPUB_CSS = `
:root { color-scheme: light; }
*, *::before, *::after { box-sizing: border-box; }
html { font-size: 100%; max-width: 100%; }
body { margin: 0; max-width: 100%; color: #111; background: #fff; font-family: Georgia, "Times New Roman", serif; line-height: 1.62; }
main { box-sizing: border-box; width: 100%; max-width: 42rem; margin: 0 auto; padding: 5%; }
.publication-header { border-bottom: 0.08rem solid currentColor; margin-bottom: 2.5rem; padding-bottom: 2rem; }
.reconstructed-header { margin-bottom: 2rem; }
.reconstruction-status { border: 0.12rem solid currentColor; margin: 0 0 2rem; padding: 0.9rem 1rem; }
.reconstruction-status > p { font-family: sans-serif; font-size: 0.8rem; margin: 0; }
.reconstruction-status > p:first-child { font-weight: 700; }
.reconstruction-status > p + p { margin-top: 0.35rem; }
.status, .authors { font-family: sans-serif; font-size: 0.78rem; letter-spacing: 0.04em; }
.affiliation-marker, .author-affiliation-marker, .author-note-marker { margin-inline-start: 0.08em; line-height: 0; vertical-align: super; }
.note-backlink ~ .note-backlink { display: none; }
h1 { font-size: 2.2rem; line-height: 1.05; margin: 0.5rem 0 0.75rem; }
h2 { font-size: 1.45rem; margin: 2.4rem 0 0.6rem; break-after: avoid; }
h3 { font-size: 1.15rem; margin: 2rem 0 0.5rem; break-after: avoid; }
h4 { font-size: 1rem; margin: 1.7rem 0 0.45rem; break-after: avoid; }
p { margin: 0.8rem 0; orphans: 3; widows: 3; }
h1, h2, h3, h4, p, figcaption, .orphan-caption, .publication-note, .publication-list, .publication-list-item { overflow-wrap: break-word; word-break: normal; }
a, code, pre { overflow-wrap: anywhere; word-break: break-word; }
.subtitle { font-size: 1.15rem; font-style: italic; }
.abstract { margin-top: 1.8rem; }
.abstract h2 { font-family: sans-serif; font-size: 0.86rem; letter-spacing: 0.08em; text-transform: uppercase; }
blockquote { border-inline-start: 0.16rem solid currentColor; margin: 1.5rem 0; padding-inline-start: 1rem; font-style: italic; }
figure { break-inside: avoid; margin: 2rem 0; }
.figure-placeholder { border: 0.08rem solid currentColor; padding: 2rem 1rem; text-align: center; }
figcaption, .orphan-caption { font-size: 0.86rem; margin-top: 0.6rem; }
.equation-source-text { border: 0; clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; margin: -1px; overflow: hidden; padding: 0; position: absolute; white-space: nowrap; width: 1px; }
.omitted-visual { border: 0.08rem dashed currentColor; margin: 2rem 0; padding: 1rem; }
.omitted-visual > p:first-child { font-family: sans-serif; font-size: 0.8rem; font-style: italic; }
.omitted-visual-caption { font-size: 0.86rem; }
.omitted-visual-transcript, .omitted-table-transcript { border-top: 0.06rem solid currentColor; margin-top: 0.75rem; padding-top: 0.75rem; }
.omitted-visual-transcript > p:first-child, .omitted-table-transcript > p:first-child { font-family: sans-serif; font-size: 0.76rem; font-weight: 700; }
.omitted-table-transcript-source { max-width: 100%; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.omitted-algorithm-transcript { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.78rem; line-height: 1.45; overflow-wrap: anywhere; white-space: pre-wrap; }
.source-code { box-sizing: border-box; max-width: 100%; margin: 0; overflow-x: auto; overflow-y: hidden; overflow-wrap: normal; padding: 0.8rem; border: 0.06rem solid currentColor; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.78rem; line-height: 1.45; white-space: pre; word-break: normal; }
.source-code code { display: block; font: inherit; white-space: inherit; }
.source-code-line { display: inline; }
.source-code[data-transcript-status="unresolved"] { border-style: dashed; }
.source-code-image-comparison { margin-block-start: 0.55rem; font-size: 0.72rem; }
.source-code-image-comparison summary { cursor: pointer; font-family: ui-sans-serif, system-ui, sans-serif; }
.source-code-image-comparison img { margin-block-start: 0.55rem; }
${Array.from(
  { length: 17 },
  (_, indent) =>
    `.source-code-indent-${indent} { padding-inline-start: ${indent}ch; }`,
).join('\n')}
.omitted-code-transcript { max-width: 100%; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.78rem; line-height: 1.45; white-space: pre-wrap; }
.publication-note { border-top: 0.06rem solid currentColor; font-size: 0.84rem; margin-top: 1rem; padding-top: 0.5rem; }
.note-label { font-weight: bold; }
.note-backlink { margin-inline-start: 0.35rem; }
.publication-list { max-width: 100%; min-width: 0; margin: 0.8rem 0; padding-inline-start: 1.5rem; }
.publication-list.markerless-list { list-style-type: none; padding-inline-start: 0; }
.publication-list .publication-list { margin: 0.35rem 0 0; }
.publication-list-item { margin: 0.35rem 0; }
.publication-list-item.has-preserved-marker { list-style-type: none; }
.publication-list-marker { display: inline-block; margin-inline-end: 0.4em; }
.visually-hidden, .additional-biblioref, .additional-cross-reference { position: absolute; inline-size: 1px; block-size: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.semantic-table-wrapper { max-width: 100%; overflow-x: auto; }
.semantic-table-figure, .semantic-table-wrapper, .semantic-table-wrapper table { break-inside: auto; }
.semantic-table-wrapper table { border-collapse: collapse; font-size: 0.86rem; line-height: 1.35; min-width: 0; table-layout: fixed; width: 100%; }
.semantic-table-wrapper[data-wide-table="true"] table { min-width: 100%; table-layout: auto; width: auto; }
.semantic-table-wrapper thead { display: table-header-group; }
.semantic-table-figure > figcaption { break-before: avoid; }
.semantic-table-wrapper tr { break-inside: avoid; }
.semantic-table-wrapper th, .semantic-table-wrapper td { border: 0.06rem solid currentColor; padding: 0.3rem 0.4rem; text-align: start; vertical-align: top; }
.semantic-table-wrapper th, .semantic-table-wrapper td { overflow-wrap: anywhere; word-break: break-word; }
.semantic-table-wrapper[data-wide-table="true"] th, .semantic-table-wrapper[data-wide-table="true"] td { min-width: 3.5rem; overflow-wrap: break-word; word-break: normal; }
.semantic-table-wrapper th { font-weight: bold; }
.wide-source-visual-frame { max-width: 100%; overflow: visible; }
img, svg { display: block; height: auto; max-width: 100%; }
object { border: 0; display: block; min-height: 8rem; width: 100%; }
a { color: inherit; text-decoration-line: underline; text-decoration-thickness: 0.06em; text-underline-offset: 0.14em; }
@media (max-width: 30rem) {
  main { padding: 7%; }
  h1 { font-size: 1.8rem; }
}
`

function percentage(value: number, whole: number) {
  return `${Math.round((value / whole) * 100_000) / 1000}%`
}

export function profileEpubCss(profileInput: TargetProfile) {
  const profile = targetProfileSchema.parse(profileInput)
  const width = profile.dimensions.width
  const bodySize = profile.typography.bodySizeCssPx
  const fourthOrderHeadingSize = Math.max(
    bodySize + 1,
    Math.round(profile.typography.headingSizeCssPx * 0.8),
  )
  const thirdOrderHeadingSize = Math.max(
    fourthOrderHeadingSize + 1,
    Math.round(profile.typography.headingSizeCssPx * 0.9),
  )
  const secondOrderHeadingSize = Math.max(
    thirdOrderHeadingSize + 1,
    profile.typography.headingSizeCssPx,
  )
  return `${EPUB_CSS}
/* Profile values are derived from src/research/targets.ts (${profile.id}@${profile.version}). */
html { font-size: ${profile.typography.bodySizeCssPx}px; }
body { font-family: ${profile.typography.fontFamily}; line-height: ${profile.typography.lineHeight}; }
main { max-width: none; padding: ${percentage(profile.margins.top, width)} ${percentage(profile.margins.right, width)} ${percentage(profile.margins.bottom, width)} ${percentage(profile.margins.left, width)}; }
h1 { font-size: ${profile.typography.titleSizeCssPx}px; }
h2 { font-size: ${secondOrderHeadingSize}px; }
h3 { font-size: ${thirdOrderHeadingSize}px; }
h4 { font-size: ${fourthOrderHeadingSize}px; }
blockquote { font-size: ${profile.typography.quoteSizeCssPx}px; }
@page { margin: 0; }
`
}

export type PackagedAsset = {
  source: PublicationAsset
  asset: PublicationAsset
  policy: {
    id:
      'fit-device-content-width-no-upscale' | 'preserve-scrollable-table-source'
    version: typeof EPUB_EXPORT_POLICY_VERSION
    action: 'preserved' | 'downscaled' | 'scalable-source'
    sourceWidth: number
    sourceHeight: number
    packagedWidth: number
    packagedHeight: number
    maximumWidth: number | null
    targetPixelsPerInch: number | null
    sourcePixelsPerInch: number | null
    resampling: 'none' | 'nearest-neighbor-rgba'
    neverUpscaled: true
  }
}

export async function packageVisualAssets(
  assets: readonly PublicationAsset[],
  profile?: TargetProfile,
) {
  const maximumWidth =
    profile?.dimensions.unit === 'device-px'
      ? profile.dimensions.width - profile.margins.left - profile.margins.right
      : null
  const packaged: PackagedAsset[] = []
  for (const source of assets) {
    const preserveScrollableTableSource =
      profile?.id === 'paperProMove' && isCompactScrollableTableImage(source)
    const asset =
      !preserveScrollableTableSource &&
      maximumWidth !== null &&
      profile?.pixelsPerInch !== null &&
      profile?.pixelsPerInch !== undefined
        ? await downscalePngAsset(source, maximumWidth, profile.pixelsPerInch)
        : source
    packaged.push({
      source,
      asset,
      policy: {
        id: preserveScrollableTableSource
          ? 'preserve-scrollable-table-source'
          : 'fit-device-content-width-no-upscale',
        version: EPUB_EXPORT_POLICY_VERSION,
        action:
          source.mediaType === 'image/svg+xml'
            ? 'scalable-source'
            : source.mediaType !== 'image/png' || asset.sha256 === source.sha256
              ? 'preserved'
              : 'downscaled',
        sourceWidth: source.width,
        sourceHeight: source.height,
        packagedWidth: asset.width,
        packagedHeight: asset.height,
        maximumWidth: preserveScrollableTableSource ? null : maximumWidth,
        targetPixelsPerInch: profile?.pixelsPerInch ?? null,
        sourcePixelsPerInch: source.resolutionDpi,
        resampling:
          asset.sha256 === source.sha256 ? 'none' : 'nearest-neighbor-rgba',
        neverUpscaled: true,
      },
    })
  }
  return packaged
}

export function uniqueAssets(packaged: readonly PackagedAsset[]) {
  return [...new Map(packaged.map(({ asset }) => [asset.id, asset])).values()]
}

export function containerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
`
}

export function packageOpf(
  paper: ResearchPaper,
  identifier: string,
  modified: string,
  assets: PublicationAsset[] = [],
  profile?: TargetProfile,
) {
  const assetItems = assets
    .map(
      (visualAsset) =>
        `<item id="${attribute(stableId(visualAsset.id))}" href="${attribute(visualAsset.href)}" media-type="${attribute(visualAsset.mediaType)}" />`,
    )
    .join('\n    ')
  const language = publicationLanguage(paper)
  const direction = publicationBaseDirection(paper)
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id" xml:lang="${attribute(language)}" prefix="schema: http://schema.org/">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="publication-id">${text(identifier)}</dc:identifier>
    <dc:title>${text(paper.title)}</dc:title>
    <dc:language>${text(language)}</dc:language>
    ${paper.authors.map((author) => `<dc:creator>${text(author)}</dc:creator>`).join('\n    ')}
    ${paper.publicationDate ? `<dc:date>${text(paper.publicationDate)}</dc:date>` : ''}
    <meta property="dcterms:modified">${text(modified)}</meta>
    <meta property="schema:accessMode">textual</meta>
    ${assets.length > 0 ? '<meta property="schema:accessMode">visual</meta>' : ''}
    <meta property="schema:accessibilityFeature">structuralNavigation</meta>
    <meta property="schema:accessibilityFeature">tableOfContents</meta>
    ${assets.length > 0 ? '<meta property="schema:accessibilityFeature">alternativeText</meta>' : ''}
    <meta property="schema:accessibilityHazard">none</meta>
    <meta property="schema:accessModeSufficient">${assets.length > 0 ? 'textual,visual' : 'textual'}</meta>
    <meta property="schema:accessibilitySummary">This reflowable publication provides structural navigation${assets.length > 0 ? ' and text alternatives for packaged visual content' : ''}.</meta>
    ${
      profile
        ? `<meta property="rendition:layout">reflowable</meta>
    <meta property="rendition:flow">${profile.epub.renditionFlow}</meta>
    <meta property="rendition:spread">none</meta>`
        : ''
    }
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml" />
    <item id="styles" href="styles.css" media-type="text/css" />
    <item id="export-manifest" href="export.json" media-type="application/json" />
    ${assetItems}
  </manifest>
  <spine${direction ? ` page-progression-direction="${direction}"` : ''}>
    <itemref idref="content" />
  </spine>
</package>
`
}

export function epubArtifactModifiedAt(paper: ResearchPaper) {
  const candidate = paper.artifactModifiedAt ?? `${paper.updated}T00:00:00.000Z`
  const parsed = new Date(candidate)
  const normalized = Number.isNaN(parsed.valueOf())
    ? `${paper.updated}T00:00:00.000Z`
    : parsed.toISOString()
  return normalized.replace(/\.\d{3}Z$/, 'Z')
}

export function entry(
  value: string,
  level: 0 | 6 = 6,
): [Uint8Array, ZipOptions] {
  return [strToU8(value), { level, mtime: ZIP_MTIME }]
}

export function binaryEntry(value: Uint8Array): [Uint8Array, ZipOptions] {
  return [value, { level: 6, mtime: ZIP_MTIME }]
}
