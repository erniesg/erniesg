import { strToU8, zipSync, type Zippable, type ZipOptions } from 'fflate'
import { sha256HexSync } from './sha256'
import { renderPublicationXhtml } from './xhtml'
import type { StructDocument } from './types'

const EPUB_MIMETYPE = 'application/epub+zip' as const
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0)
const EPUB_CSS = `body { font-family: serif; line-height: 1.5; margin: 5%; }
img { display: block; height: auto; max-width: 100%; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid currentColor; padding: 0.25rem; }
figure { break-inside: avoid; margin: 1.5rem 0; }`

function text(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function attribute(value: string) {
  return text(value).replace(/"/g, '&quot;')
}

function entry(value: string, level: 0 | 6 = 6): [Uint8Array, ZipOptions] {
  return [strToU8(value), { level, mtime: ZIP_MTIME }]
}

function binaryEntry(value: Uint8Array): [Uint8Array, ZipOptions] {
  return [value, { level: 6, mtime: ZIP_MTIME }]
}

function slug(value: string) {
  return (
    value
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'publication'
  )
}

/** Assemble a deterministic EPUB using only the canonical STRUCT contract. */
export async function buildStructEpub(document: StructDocument) {
  const identifier = `urn:sha256:${document.receipt.generatedSha256}`
  const language = document.metadata.language ?? 'und'
  const modified = (
    document.metadata.artifactModifiedAt ??
    `${document.metadata.updated ?? '1970-01-01'}T00:00:00Z`
  ).replace(/\.\d{3}Z$/, 'Z')
  const assets = document.assets.map((asset) => {
    if (!asset.bytes) {
      throw new Error(`STRUCT asset ${asset.id} has no packaged bytes.`)
    }
    return asset as typeof asset & { bytes: Uint8Array }
  })
  const assetItems = assets
    .map(
      (asset) =>
        `<item id="${attribute(asset.id)}" href="${attribute(asset.href)}" media-type="${attribute(asset.mediaType)}" />`,
    )
    .join('\n    ')
  const packageDocument = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id" xml:lang="${attribute(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="publication-id">${identifier}</dc:identifier>
    <dc:title>${text(document.metadata.title)}</dc:title>
    <dc:language>${text(language)}</dc:language>
    ${document.metadata.authors.map((author) => `<dc:creator>${text(author)}</dc:creator>`).join('\n    ')}
    <meta property="dcterms:modified">${text(modified)}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml" />
    <item id="styles" href="styles.css" media-type="text/css" />
    <item id="struct" href="struct.json" media-type="application/json" />
    ${assetItems}
  </manifest>
  <spine><itemref idref="content" /></spine>
</package>
`
  const headings = document.blocks.filter((block) => block.kind === 'heading')
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${attribute(language)}"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="content.xhtml">${text(document.metadata.title)}</a></li>${headings.map((block) => `<li><a href="content.xhtml#${attribute(block.id)}">${text(block.text)}</a></li>`).join('')}</ol></nav></body></html>
`
  const archive: Zippable = {
    mimetype: entry(EPUB_MIMETYPE, 0),
    'META-INF/container.xml': entry(
      '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>',
    ),
    'EPUB/package.opf': entry(packageDocument),
    'EPUB/nav.xhtml': entry(nav),
    'EPUB/content.xhtml': entry(renderPublicationXhtml(document)),
    'EPUB/styles.css': entry(EPUB_CSS),
    'EPUB/struct.json': entry(
      `${JSON.stringify({
        schemaVersion: document.schemaVersion,
        source: document.source,
        receipt: document.receipt,
      })}\n`,
    ),
    ...Object.fromEntries(
      assets.map((asset) => [`EPUB/${asset.href}`, binaryEntry(asset.bytes)]),
    ),
  }
  const bytes = zipSync(archive)
  return {
    bytes,
    fileName: `${slug(document.metadata.title)}-${document.receipt.generatedSha256.slice(0, 12)}.epub`,
    mediaType: EPUB_MIMETYPE,
    sha256: sha256HexSync(bytes),
    identifier,
    entries: Object.keys(archive),
    mode: 'publication' as const,
  }
}
