import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
  type Zippable,
  type ZipOptions,
} from 'fflate'
import { PdfImportError, type PdfReconstruction } from './import-types'
import type { ResearchNode, ResearchPaper } from './schema'

const EPUB_MIMETYPE = 'application/epub+zip'
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0)

export type EpubExport = {
  bytes: Uint8Array
  fileName: string
  mediaType: typeof EPUB_MIMETYPE
  sha256: string
  identifier: string
  entries: string[]
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
    return `<figure id="${id}" data-canonical-id="${id}" data-caption-id="${captionId}" role="group"><div class="figure-placeholder" role="img" aria-label="${attribute(node.title)}">${text(node.title)}</div>${caption ? `<figcaption id="${captionId}" data-canonical-id="${captionId}">${text(caption.text)}</figcaption>` : ''}</figure>`
  }
  return ''
}

export function renderPublicationXhtml(
  paper: ResearchPaper,
  options: { embedStyles?: boolean } = {},
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
  const body = paper.nodes
    .filter(
      (node) => node.type !== 'caption' || !associatedCaptions.has(node.id),
    )
    .map((node) =>
      node.type === 'caption'
        ? `<aside id="${attribute(stableId(node.id))}" data-canonical-id="${attribute(stableId(node.id))}" class="orphan-caption">${text(node.text)}</aside>`
        : renderNode(node, captions),
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${text(paper.title)}</title>
  ${options.embedStyles ? `<style type="text/css">${EPUB_CSS}</style>` : '<link rel="stylesheet" type="text/css" href="styles.css" />'}
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
) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="publication-id">${text(identifier)}</dc:identifier>
    <dc:title>${text(paper.title)}</dc:title>
    <dc:language>en</dc:language>
    ${paper.authors.map((author) => `<dc:creator>${text(author)}</dc:creator>`).join('\n    ')}
    <dc:date>${text(paper.updated)}</dc:date>
    <meta property="dcterms:modified">${text(modified)}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml" />
    <item id="styles" href="styles.css" media-type="text/css" />
    <item id="export-manifest" href="export.json" media-type="application/json" />
  </manifest>
  <spine>
    <itemref idref="content" />
  </spine>
</package>
`
}

function entry(value: string, level: 0 | 6 = 6): [Uint8Array, ZipOptions] {
  return [strToU8(value), { level, mtime: ZIP_MTIME }]
}

export function inspectEpub(bytes: Uint8Array) {
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
  return { files, entries: Object.keys(files) }
}

export async function buildEpub(
  paper: ResearchPaper,
  reconstruction?: PdfReconstruction,
): Promise<EpubExport> {
  if (reconstruction && !reconstruction.readiness.ready) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      `EPUB export is blocked until these completeness diagnostics are cleared: ${reconstruction.readiness.blockingDiagnosticCodes.join(', ')}.`,
    )
  }
  const canonicalHash = await sha256(JSON.stringify(paper))
  const identifier = `urn:srt:${stableId(paper.id)}:${canonicalHash.slice(0, 24)}`
  const modified = `${paper.updated}T00:00:00Z`
  const exportManifest = {
    schemaVersion: '1.0.0',
    identifier,
    canonicalContentSha256: canonicalHash,
    sourcePdfSha256: reconstruction?.source.sha256,
    canonicalNodeIds: paper.nodes.map((node) => node.id),
    sourceProvenanceIncluded: Boolean(reconstruction),
    sourceCompleteness: reconstruction?.completeness,
    sourceReadiness: reconstruction?.readiness,
    humanAdjudications: reconstruction
      ? {
          schemaVersion: reconstruction.humanAdjudications.schemaVersion,
          appliedCount: reconstruction.humanAdjudications.applied.length,
          staleCount: reconstruction.humanAdjudications.stale.length,
          countsByDiagnosticCode:
            reconstruction.humanAdjudications.countsByDiagnosticCode,
          applied: reconstruction.humanAdjudications.applied,
        }
      : undefined,
    rendition: 'reflowable-epub',
  }
  const archive: Zippable = {
    mimetype: entry(EPUB_MIMETYPE, 0),
    'META-INF/container.xml': entry(containerXml()),
    'EPUB/package.opf': entry(packageOpf(paper, identifier, modified)),
    'EPUB/nav.xhtml': entry(navXhtml(paper)),
    'EPUB/content.xhtml': entry(renderPublicationXhtml(paper)),
    'EPUB/styles.css': entry(EPUB_CSS),
    'EPUB/export.json': entry(`${JSON.stringify(exportManifest, null, 2)}\n`),
  }
  const bytes = zipSync(archive)
  const { entries } = inspectEpub(bytes)
  return {
    bytes,
    fileName: `${slug(paper.title)}.epub`,
    mediaType: EPUB_MIMETYPE,
    sha256: await sha256(bytes),
    identifier,
    entries,
  }
}
