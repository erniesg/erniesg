import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
  type Zippable,
  type ZipOptions,
} from 'fflate'
import {
  PdfImportError,
  type PdfReconstruction,
  type PdfVisualAsset,
  type PdfVisualRelationship,
} from './import-types'
import { getCompositionPolicy } from './composition'
import type { ResearchNode, ResearchPaper } from './schema'
import {
  getTargetProfile,
  type TargetProfile,
  type TargetProfileId,
} from './targets'
import { targetProfileSchema } from './target-schema'
import { downscalePngAsset } from './visual-assets'

const EPUB_MIMETYPE = 'application/epub+zip'
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0)
export const EPUB_EXPORT_POLICY_VERSION = '1.0.0' as const

export type EpubProfileMetadata = {
  id: TargetProfileId
  version: string
  compositionPolicy: ReturnType<typeof getCompositionPolicy>
  exportPolicy: {
    id: 'profile-tuned-reflowable'
    version: typeof EPUB_EXPORT_POLICY_VERSION
  }
}

export type EpubExport = {
  bytes: Uint8Array
  fileName: string
  mediaType: typeof EPUB_MIMETYPE
  sha256: string
  identifier: string
  entries: string[]
  profile?: EpubProfileMetadata
}

function cleanXml(value: string) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

function text(value: string) {
  return cleanXml(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function attribute(value: string) {
  return text(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function stableId(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, '-')
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n-${cleaned}`
}

function slug(value: string) {
  return (
    value
      .toLocaleLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'research-publication'
  )
}

function renderTextWithNoteReferences(
  value: string,
  references?: Array<{
    id: string
    target: string
    start: number
    end: number
  }>,
) {
  if (!references?.length) return text(value)
  let cursor = 0
  let rendered = ''
  for (const reference of [...references].sort(
    (left, right) => left.start - right.start,
  )) {
    if (
      reference.start < cursor ||
      reference.end > value.length ||
      reference.start >= reference.end
    ) {
      continue
    }
    rendered += text(value.slice(cursor, reference.start))
    rendered += `<a id="${attribute(stableId(reference.id))}" href="#${attribute(stableId(reference.target))}" epub:type="noteref">${text(value.slice(reference.start, reference.end))}</a>`
    cursor = reference.end
  }
  return `${rendered}${text(value.slice(cursor))}`
}

async function sha256(value: Uint8Array | string) {
  const bytes = typeof value === 'string' ? strToU8(value) : value
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function renderNode(
  node: ResearchNode,
  captions: Map<string, Extract<ResearchNode, { type: 'caption' }>>,
  visualRelationships: Map<string, PdfVisualRelationship>,
  assets: Map<string, PdfVisualAsset>,
) {
  const id = attribute(stableId(node.id))
  if (node.type === 'heading') {
    const level = Math.min(3, Math.max(2, node.level + 1))
    return `<h${level} id="${id}" data-canonical-id="${id}">${renderTextWithNoteReferences(node.text, node.noteReferences)}</h${level}>`
  }
  if (node.type === 'paragraph') {
    return `<p id="${id}" data-canonical-id="${id}">${renderTextWithNoteReferences(node.text, node.noteReferences)}</p>`
  }
  if (node.type === 'quote') {
    return `<blockquote id="${id}" data-canonical-id="${id}"><p>${renderTextWithNoteReferences(node.text, node.noteReferences)}</p></blockquote>`
  }
  if (node.type === 'footnote') {
    const backlinks = node.relationships.backlinks
      .map(
        (backlink, index) =>
          `<a href="#${attribute(stableId(backlink))}" class="note-backlink" aria-label="Back to reference ${index + 1}">↩</a>`,
      )
      .join(' ')
    return `<aside id="${id}" data-canonical-id="${id}" epub:type="footnote" role="doc-${node.kind}" data-note-kind="${node.kind}" class="publication-note"><span class="note-label">${text(node.label)}</span> ${text(node.text)}${backlinks ? ` ${backlinks}` : ''}</aside>`
  }
  if (node.type === 'figure') {
    const caption = captions.get(node.relationships.caption)
    const captionId = attribute(stableId(node.relationships.caption))
    const visual = visualRelationships.get(node.id)
    if (visual) {
      const renderedAssets = visual.assetIds
        .map((assetId) => assets.get(assetId))
        .filter((visualAsset): visualAsset is PdfVisualAsset =>
          Boolean(visualAsset),
        )
        .map((visualAsset) => {
          const href = attribute(visualAsset.href)
          const alt = attribute(visual.altText)
          if (visualAsset.mediaType === 'application/xhtml+xml') {
            return `<object data="${href}" type="application/xhtml+xml" aria-label="${alt}" data-alt-source="${visual.altTextSource}"><p>${text(visual.altText)}</p></object>`
          }
          return `<img src="${href}" alt="${alt}" data-alt-source="${visual.altTextSource}" data-asset-id="${attribute(visualAsset.id)}" />`
        })
        .join('')
      return `<figure id="${id}" data-canonical-id="${id}" data-caption-id="${captionId}" data-object-type="${visual.kind}" role="group">${renderedAssets}${caption ? `<figcaption id="${captionId}" data-canonical-id="${captionId}">${text(caption.text)}</figcaption>` : ''}</figure>`
    }
    return `<figure id="${id}" data-canonical-id="${id}" data-caption-id="${captionId}" role="group"><div class="figure-placeholder" role="img" aria-label="${attribute(node.title)}">${text(node.title)}</div>${caption ? `<figcaption id="${captionId}" data-canonical-id="${captionId}">${text(caption.text)}</figcaption>` : ''}</figure>`
  }
  return ''
}

export function renderPublicationXhtml(
  paper: ResearchPaper,
  options: {
    embedStyles?: boolean
    reconstruction?: PdfReconstruction
    styles?: string
    visualAssets?: Map<string, PdfVisualAsset>
  } = {},
) {
  const captions = new Map(
    paper.nodes
      .filter(
        (node): node is Extract<ResearchNode, { type: 'caption' }> =>
          node.type === 'caption',
      )
      .map((node) => [node.id, node]),
  )
  const associatedCaptions = new Set(
    paper.nodes
      .filter(
        (node): node is Extract<ResearchNode, { type: 'figure' }> =>
          node.type === 'figure',
      )
      .map((node) => node.relationships.caption),
  )
  const visualRelationships = new Map(
    (options.reconstruction?.visualRelationships ?? [])
      .filter(
        (relationship) =>
          relationship.status === 'matched' && relationship.canonicalNodeId,
      )
      .map((relationship) => [relationship.canonicalNodeId!, relationship]),
  )
  const assets =
    options.visualAssets ??
    new Map(
      (options.reconstruction?.assets ?? []).map((visualAsset) => [
        visualAsset.id,
        visualAsset,
      ]),
    )
  const body = paper.nodes
    .filter(
      (node) => node.type !== 'caption' || !associatedCaptions.has(node.id),
    )
    .map((node) =>
      node.type === 'caption'
        ? `<aside id="${attribute(stableId(node.id))}" data-canonical-id="${attribute(stableId(node.id))}" class="orphan-caption">${text(node.text)}</aside>`
        : renderNode(node, captions, visualRelationships, assets),
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${text(paper.title)}</title>
  ${options.embedStyles ? `<style type="text/css">${options.styles ?? EPUB_CSS}</style>` : '<link rel="stylesheet" type="text/css" href="styles.css" />'}
</head>
<body>
  <main epub:type="bodymatter" xmlns:epub="http://www.idpf.org/2007/ops">
    <header class="publication-header">
      <p class="status">${text(paper.status)} · ${text(paper.updated)}</p>
      <h1 id="publication-title">${text(paper.title)}</h1>
      <p class="subtitle">${text(paper.subtitle)}</p>
      <p class="authors">${paper.authors.map(text).join(', ')}</p>
      <section class="abstract" aria-labelledby="abstract-title">
        <h2 id="abstract-title">Abstract</h2>
        <p>${text(paper.abstract)}</p>
      </section>
    </header>
    ${body}
  </main>
</body>
</html>
`
}

function navXhtml(paper: ResearchPaper) {
  const headings = paper.nodes.filter(
    (node): node is Extract<ResearchNode, { type: 'heading' }> =>
      node.type === 'heading',
  )
  const items = [
    `<li><a href="content.xhtml#publication-title">${text(paper.title)}</a></li>`,
    ...headings.map(
      (node) =>
        `<li><a href="content.xhtml#${attribute(stableId(node.id))}">${text(node.text)}</a></li>`,
    ),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="UTF-8" /><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc" aria-label="Table of contents">
    <h1>Contents</h1>
    <ol>${items.join('\n')}</ol>
  </nav>
</body>
</html>
`
}

const EPUB_CSS = `
:root { color-scheme: light; }
html { font-size: 100%; }
body { margin: 0; color: #111; background: #fff; font-family: Georgia, "Times New Roman", serif; line-height: 1.62; }
main { max-width: 42rem; margin: 0 auto; padding: 5%; }
.publication-header { border-bottom: 0.08rem solid currentColor; margin-bottom: 2.5rem; padding-bottom: 2rem; }
.status, .authors { font-family: sans-serif; font-size: 0.78rem; letter-spacing: 0.04em; }
h1 { font-size: 2.2rem; line-height: 1.05; margin: 0.5rem 0 0.75rem; }
h2 { font-size: 1.45rem; margin: 2.4rem 0 0.6rem; break-after: avoid; }
h3 { font-size: 1.15rem; margin: 2rem 0 0.5rem; break-after: avoid; }
p { margin: 0.8rem 0; orphans: 3; widows: 3; }
.subtitle { font-size: 1.15rem; font-style: italic; }
.abstract { margin-top: 1.8rem; }
.abstract h2 { font-family: sans-serif; font-size: 0.86rem; letter-spacing: 0.08em; text-transform: uppercase; }
blockquote { border-inline-start: 0.16rem solid currentColor; margin: 1.5rem 0; padding-inline-start: 1rem; font-style: italic; }
figure { break-inside: avoid; margin: 2rem 0; }
.figure-placeholder { border: 0.08rem solid currentColor; padding: 2rem 1rem; text-align: center; }
figcaption, .orphan-caption { font-size: 0.86rem; margin-top: 0.6rem; }
.publication-note { border-top: 0.06rem solid currentColor; font-size: 0.84rem; margin-top: 1rem; padding-top: 0.5rem; }
.note-label { font-weight: bold; }
.note-backlink { margin-inline-start: 0.35rem; }
img, svg { display: block; height: auto; max-width: 100%; }
a { color: inherit; text-decoration: underline; }
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
  const height = profile.dimensions.height ?? width
  const contentWidth = width - profile.margins.left - profile.margins.right
  return `${EPUB_CSS}
/* Profile values are derived from src/research/targets.ts (${profile.id}@${profile.version}). */
html { font-size: ${profile.typography.bodySizeCssPx}px; direction: ${profile.epub.pageProgressionDirection}; }
body { font-family: ${profile.typography.fontFamily}; line-height: ${profile.typography.lineHeight}; }
main { max-width: ${Math.round((contentWidth / profile.typography.bodySizeCssPx) * 1000) / 1000}rem; padding: ${percentage(profile.margins.top, height)} ${percentage(profile.margins.right, width)} ${percentage(profile.margins.bottom, height)} ${percentage(profile.margins.left, width)}; }
h1 { font-size: ${profile.typography.titleSizeCssPx}px; }
h2, h3 { font-size: ${profile.typography.headingSizeCssPx}px; }
blockquote { font-size: ${profile.typography.quoteSizeCssPx}px; }
@page { margin: ${percentage(profile.margins.top, height)} ${percentage(profile.margins.right, width)} ${percentage(profile.margins.bottom, height)} ${percentage(profile.margins.left, width)}; }
`
}

type PackagedAsset = {
  source: PdfVisualAsset
  asset: PdfVisualAsset
  policy: {
    id: 'fit-device-content-width-no-upscale'
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

async function packageVisualAssets(
  assets: readonly PdfVisualAsset[],
  profile?: TargetProfile,
) {
  const maximumWidth =
    profile?.dimensions.unit === 'device-px'
      ? profile.dimensions.width - profile.margins.left - profile.margins.right
      : null
  return Promise.all(
    assets.map(async (source): Promise<PackagedAsset> => {
      const asset =
        maximumWidth !== null &&
        profile?.pixelsPerInch !== null &&
        profile?.pixelsPerInch !== undefined
          ? await downscalePngAsset(source, maximumWidth, profile.pixelsPerInch)
          : source
      return {
        source,
        asset,
        policy: {
          id: 'fit-device-content-width-no-upscale',
          version: EPUB_EXPORT_POLICY_VERSION,
          action:
            source.mediaType === 'image/svg+xml'
              ? 'scalable-source'
              : source.mediaType !== 'image/png' ||
                  asset.sha256 === source.sha256
                ? 'preserved'
                : 'downscaled',
          sourceWidth: source.width,
          sourceHeight: source.height,
          packagedWidth: asset.width,
          packagedHeight: asset.height,
          maximumWidth,
          targetPixelsPerInch: profile?.pixelsPerInch ?? null,
          sourcePixelsPerInch: source.resolutionDpi,
          resampling:
            asset.sha256 === source.sha256 ? 'none' : 'nearest-neighbor-rgba',
          neverUpscaled: true,
        },
      }
    }),
  )
}

function uniqueAssets(packaged: readonly PackagedAsset[]) {
  return [...new Map(packaged.map(({ asset }) => [asset.id, asset])).values()]
}

function containerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
`
}

function packageOpf(
  paper: ResearchPaper,
  identifier: string,
  modified: string,
  assets: PdfVisualAsset[] = [],
  profile?: TargetProfile,
) {
  const assetItems = assets
    .map(
      (visualAsset) =>
        `<item id="${attribute(stableId(visualAsset.id))}" href="${attribute(visualAsset.href)}" media-type="${attribute(visualAsset.mediaType)}" />`,
    )
    .join('\n    ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="publication-id">${text(identifier)}</dc:identifier>
    <dc:title>${text(paper.title)}</dc:title>
    <dc:language>en</dc:language>
    ${paper.authors.map((author) => `<dc:creator>${text(author)}</dc:creator>`).join('\n    ')}
    <dc:date>${text(paper.updated)}</dc:date>
    <meta property="dcterms:modified">${text(modified)}</meta>
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
  <spine${profile ? ` page-progression-direction="${profile.epub.pageProgressionDirection}"` : ''}>
    <itemref idref="content" />
  </spine>
</package>
`
}

function entry(value: string, level: 0 | 6 = 6): [Uint8Array, ZipOptions] {
  return [strToU8(value), { level, mtime: ZIP_MTIME }]
}

function binaryEntry(value: Uint8Array): [Uint8Array, ZipOptions] {
  return [value, { level: 6, mtime: ZIP_MTIME }]
}

export function inspectEpub(
  bytes: Uint8Array,
  expectedProfile?: TargetProfile,
) {
  if (
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    throw new Error('EPUB does not begin with a ZIP local-file header')
  }
  const compressionMethod = bytes[8] | (bytes[9] << 8)
  const fileNameLength = bytes[26] | (bytes[27] << 8)
  const firstName = strFromU8(bytes.subarray(30, 30 + fileNameLength))
  if (firstName !== 'mimetype' || compressionMethod !== 0) {
    throw new Error('EPUB mimetype must be the first uncompressed ZIP entry')
  }
  const files = unzipSync(bytes)
  const required = [
    'mimetype',
    'META-INF/container.xml',
    'EPUB/package.opf',
    'EPUB/nav.xhtml',
    'EPUB/content.xhtml',
    'EPUB/styles.css',
    'EPUB/export.json',
  ]
  for (const name of required) {
    if (!files[name]) throw new Error(`EPUB is missing ${name}`)
  }
  if (strFromU8(files.mimetype) !== EPUB_MIMETYPE) {
    throw new Error('EPUB mimetype content is invalid')
  }
  const opf = strFromU8(files['EPUB/package.opf'])
  const content = strFromU8(files['EPUB/content.xhtml'])
  const manifest = JSON.parse(strFromU8(files['EPUB/export.json'])) as {
    canonicalNodeIds?: string[]
    profile?: { id?: string; version?: string }
  }
  const declaredHrefs = new Set(
    [...opf.matchAll(/<item\b[^>]*\shref="([^"]+)"[^>]*>/g)].map(
      (match) => match[1],
    ),
  )
  for (const href of declaredHrefs) {
    if (!files[`EPUB/${href}`]) {
      throw new Error(`EPUB manifest has dangling reference ${href}`)
    }
  }
  for (const match of content.matchAll(/(?:src|data)="([^"]+)"/g)) {
    const href = match[1]
    if (!declaredHrefs.has(href) || !files[`EPUB/${href}`]) {
      throw new Error(`EPUB content has dangling asset reference ${href}`)
    }
  }
  if (manifest.canonicalNodeIds) {
    const canonicalIds = [
      ...content.matchAll(/data-canonical-id="([^"]+)"/g),
    ].map((match) => match[1])
    const expectedIds = manifest.canonicalNodeIds.map(stableId)
    if (
      new Set(canonicalIds).size !== canonicalIds.length ||
      JSON.stringify(canonicalIds) !== JSON.stringify(expectedIds)
    ) {
      throw new Error(
        'EPUB canonical nodes must appear exactly once in source order',
      )
    }
    for (const match of content.matchAll(/data-caption-id="([^"]+)"/g)) {
      if (!canonicalIds.includes(match[1])) {
        throw new Error(`EPUB figure has dangling caption ${match[1]}`)
      }
    }
  }
  if (
    expectedProfile &&
    (manifest.profile?.id !== expectedProfile.id ||
      manifest.profile.version !== expectedProfile.version)
  ) {
    throw new Error(
      `EPUB profile metadata does not match ${expectedProfile.id}`,
    )
  }
  return {
    files,
    entries: Object.keys(files),
    manifest,
  }
}

export function buildEpub(
  paper: ResearchPaper,
  profile: TargetProfile,
): Promise<EpubExport>
export function buildEpub(
  paper: ResearchPaper,
  reconstruction?: PdfReconstruction,
  profile?: TargetProfile,
): Promise<EpubExport>
export async function buildEpub(
  paper: ResearchPaper,
  reconstructionOrProfile?: PdfReconstruction | TargetProfile,
  profileInput?: TargetProfile,
): Promise<EpubExport> {
  const secondIsProfile =
    reconstructionOrProfile !== undefined &&
    targetProfileSchema.safeParse(reconstructionOrProfile).success
  const reconstruction = secondIsProfile
    ? undefined
    : (reconstructionOrProfile as PdfReconstruction | undefined)
  const profileCandidate = secondIsProfile
    ? reconstructionOrProfile
    : profileInput
  const profile = profileCandidate
    ? targetProfileSchema.parse(profileCandidate)
    : undefined
  if (
    profile &&
    JSON.stringify(profile) !== JSON.stringify(getTargetProfile(profile.id))
  ) {
    throw new Error(
      `EPUB target profile ${profile.id} must come from src/research/targets.ts`,
    )
  }
  if (reconstruction && !reconstruction.readiness.ready) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      `EPUB export is blocked until these completeness diagnostics are cleared: ${reconstruction.readiness.blockingDiagnosticCodes.join(', ')}.`,
    )
  }
  if (reconstruction) {
    const assetIds = new Set(reconstruction.assets.map((asset) => asset.id))
    const invalid = reconstruction.visualRelationships.find(
      (relationship) =>
        relationship.status !== 'matched' ||
        !relationship.canonicalNodeId ||
        relationship.assetIds.length === 0 ||
        relationship.assetIds.some((assetId) => !assetIds.has(assetId)),
    )
    if (invalid) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `EPUB export is blocked by visual relationship ${invalid.id}.`,
      )
    }
  }
  const packaged = await packageVisualAssets(
    reconstruction?.assets ?? [],
    profile,
  )
  const visualAssets = uniqueAssets(packaged)
  const packagedBySourceId = new Map(
    packaged.map(({ source, asset }) => [source.id, asset]),
  )
  const packagedRelationships = reconstruction?.visualRelationships.map(
    (relationship) => ({
      ...relationship,
      assetIds: relationship.assetIds.map(
        (assetId) => packagedBySourceId.get(assetId)?.id ?? assetId,
      ),
    }),
  )
  const canonicalHash = await sha256(JSON.stringify(paper))
  const identifier = `urn:srt:${stableId(paper.id)}:${canonicalHash.slice(0, 24)}${profile ? `:${profile.id}:${profile.version}:${EPUB_EXPORT_POLICY_VERSION}` : ''}`
  const modified = `${paper.updated}T00:00:00Z`
  const profileMetadata: EpubProfileMetadata | undefined = profile
    ? {
        id: profile.id,
        version: profile.version,
        compositionPolicy: getCompositionPolicy(profile.id),
        exportPolicy: {
          id: 'profile-tuned-reflowable',
          version: EPUB_EXPORT_POLICY_VERSION,
        },
      }
    : undefined
  const exportManifest = {
    schemaVersion: '1.1.0',
    identifier,
    canonicalContentSha256: canonicalHash,
    sourcePdfSha256: reconstruction?.source.sha256,
    canonicalNodeIds: paper.nodes.map((node) => node.id),
    sourceProvenanceIncluded: Boolean(reconstruction),
    sourceCompleteness: reconstruction?.completeness,
    sourceReadiness: reconstruction?.readiness,
    assets: packaged.map(({ source, asset, policy }) => {
      const { bytes: _bytes, ...metadata } = asset
      return { ...metadata, sourceAssetId: source.id, policy }
    }),
    visualRelationships: packagedRelationships,
    profile: profile
      ? {
          ...profileMetadata,
          typography: profile.typography,
          margins: profile.margins,
          pageProgression: profile.epub,
          pixelsPerInch: profile.pixelsPerInch,
        }
      : undefined,
    rendition: profile ? 'profile-tuned-reflowable-epub' : 'reflowable-epub',
  }
  const styles = profile ? profileEpubCss(profile) : EPUB_CSS
  const archive: Zippable = {
    mimetype: entry(EPUB_MIMETYPE, 0),
    'META-INF/container.xml': entry(containerXml()),
    'EPUB/package.opf': entry(
      packageOpf(paper, identifier, modified, visualAssets, profile),
    ),
    'EPUB/nav.xhtml': entry(navXhtml(paper)),
    'EPUB/content.xhtml': entry(
      renderPublicationXhtml(paper, {
        reconstruction,
        visualAssets: packagedBySourceId,
      }),
    ),
    'EPUB/styles.css': entry(styles),
    'EPUB/export.json': entry(`${JSON.stringify(exportManifest, null, 2)}\n`),
    ...Object.fromEntries(
      visualAssets.map((visualAsset) => [
        `EPUB/${visualAsset.href}`,
        binaryEntry(visualAsset.bytes),
      ]),
    ),
  }
  const bytes = zipSync(archive)
  const { files, entries } = inspectEpub(bytes, profile)
  if (reconstruction) {
    const content = strFromU8(files['EPUB/content.xhtml'])
    const opf = strFromU8(files['EPUB/package.opf'])
    if (/figure-placeholder|placeholder only/i.test(content)) {
      throw new Error('Imported EPUB contains placeholder visual markup')
    }
    for (const visualAsset of visualAssets) {
      if (!files[`EPUB/${visualAsset.href}`]) {
        throw new Error(`EPUB is missing selected asset ${visualAsset.href}`)
      }
      if (!opf.includes(`href="${visualAsset.href}"`)) {
        throw new Error(
          `EPUB manifest omits selected asset ${visualAsset.href}`,
        )
      }
    }
    for (const match of content.matchAll(/(?:src|data)="(assets\/[^"]+)"/g)) {
      if (!files[`EPUB/${match[1]}`]) {
        throw new Error(`EPUB content has dangling asset reference ${match[1]}`)
      }
    }
  }
  return {
    bytes,
    fileName: profile?.epub.fileName ?? `${slug(paper.title)}.epub`,
    mediaType: EPUB_MIMETYPE,
    sha256: await sha256(bytes),
    identifier,
    entries,
    profile: profileMetadata,
  }
}
