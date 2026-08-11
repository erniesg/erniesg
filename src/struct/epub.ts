import {
  strFromU8,
  strToU8,
  zipSync,
  type Zippable,
  type ZipOptions,
} from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { sha256HexSync } from './sha256'
import { renderPublicationXhtml } from './xhtml'
import type { StructDocument } from './types'

const EPUB_MIMETYPE = 'application/epub+zip' as const
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0)
const EPUB_CSS = `body { font-family: serif; line-height: 1.5; margin: 5%; }
img { display: block; height: auto; max-width: 100%; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid currentColor; padding: 0.25rem; }
figure { break-inside: avoid; margin: 1.5rem 0; }
.visually-hidden, .additional-semantic-reference { clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }`

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

function xhtmlAttributeValues(value: string, name: string) {
  const values: string[] = []
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
  }).parse(value)
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      const attributeName = key.startsWith('@_') ? key.slice(2) : null
      if (attributeName === name || attributeName?.endsWith(`:${name}`)) {
        values.push(String(child))
      } else if (!key.startsWith('@_')) visit(child)
    }
  }
  visit(parsed)
  return values
}

function resolvedPackageHref(currentDocument: string, reference: string) {
  if (
    !reference ||
    reference.startsWith('/') ||
    reference.includes('\\') ||
    reference.includes('?') ||
    /[\u0000-\u001f\u007f]/u.test(reference)
  ) {
    return null
  }
  const base = currentDocument.split('/')
  base.pop()
  const resolved: string[] = []
  for (const segment of [...base, ...reference.split('/')]) {
    if (segment === '.') continue
    if (segment === '..') {
      if (resolved.length === 0) return null
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return resolved.join('/')
}

function assertXhtmlHrefIntegrity(
  documents: ReadonlyMap<string, string>,
  packagedHrefs: ReadonlySet<string>,
) {
  const idsByDocument = new Map(
    [...documents].map(([href, value]) => {
      if (XMLValidator.validate(value) !== true) {
        throw new Error(`STRUCT EPUB ${href} is not well-formed XHTML`)
      }
      const ids = xhtmlAttributeValues(value, 'id')
      if (new Set(ids).size !== ids.length) {
        throw new Error(`STRUCT EPUB ${href} contains duplicate ids`)
      }
      return [href, new Set(ids)]
    }),
  )
  for (const [documentHref, value] of documents) {
    for (const href of xhtmlAttributeValues(value, 'href')) {
      if (
        href !== href.trim() ||
        href.includes('\\') ||
        /[\u0000-\u001f\u007f]/u.test(href)
      ) {
        throw new Error(`STRUCT EPUB ${documentHref} has unsafe href ${href}`)
      }
      const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)?.[1]
      if (scheme) {
        if (!['http', 'https', 'mailto'].includes(scheme.toLowerCase())) {
          throw new Error(
            `STRUCT EPUB ${documentHref} has unsafe href scheme in ${href}`,
          )
        }
        continue
      }
      if (href.startsWith('//') || href.startsWith('/')) {
        throw new Error(`STRUCT EPUB ${documentHref} has unsafe href ${href}`)
      }
      const hashIndex = href.indexOf('#')
      const documentReference =
        hashIndex === -1 ? href : href.slice(0, hashIndex)
      const fragment = hashIndex === -1 ? null : href.slice(hashIndex + 1)
      const targetDocument = documentReference
        ? resolvedPackageHref(documentHref, documentReference)
        : documentHref
      if (!targetDocument) {
        throw new Error(`STRUCT EPUB ${documentHref} has unsafe href ${href}`)
      }
      if (!packagedHrefs.has(targetDocument)) {
        throw new Error(
          `STRUCT EPUB ${documentHref} has dangling internal reference ${href}`,
        )
      }
      if (
        fragment !== null &&
        (!fragment || !idsByDocument.get(targetDocument)?.has(fragment))
      ) {
        throw new Error(
          `STRUCT EPUB ${documentHref} has dangling internal reference ${href}`,
        )
      }
    }
  }
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
  const reservedIds = new Set([
    'publication-id',
    'nav',
    'content',
    'styles',
    'struct',
  ])
  const reservedHrefs = new Set([
    'package.opf',
    'nav.xhtml',
    'content.xhtml',
    'styles.css',
    'struct.json',
  ])
  const assetIds = new Set<string>()
  const assetHrefs = new Set<string>()
  for (const asset of assets) {
    if (
      reservedIds.has(asset.id) ||
      assetIds.has(asset.id) ||
      !/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(asset.id)
    ) {
      throw new Error(
        `STRUCT EPUB asset id is duplicate or reserved: ${asset.id}`,
      )
    }
    if (
      reservedHrefs.has(asset.href) ||
      assetHrefs.has(asset.href) ||
      asset.href !== asset.href.trim() ||
      /[\s#:]/u.test(asset.href) ||
      resolvedPackageHref('content.xhtml', asset.href) !== asset.href
    ) {
      throw new Error(
        `STRUCT EPUB asset href is duplicate, reserved, or unsafe: ${asset.href}`,
      )
    }
    assetIds.add(asset.id)
    assetHrefs.add(asset.href)
  }
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
  const content = renderPublicationXhtml(document)
  const archive: Zippable = {
    mimetype: entry(EPUB_MIMETYPE, 0),
    'META-INF/container.xml': entry(
      '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>',
    ),
    'EPUB/package.opf': entry(packageDocument),
    'EPUB/nav.xhtml': entry(nav),
    'EPUB/content.xhtml': entry(content),
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
  const xhtmlDocuments = new Map<string, string>([
    ['nav.xhtml', nav],
    ['content.xhtml', content],
  ])
  for (const asset of assets) {
    if (asset.mediaType === 'application/xhtml+xml') {
      xhtmlDocuments.set(asset.href, strFromU8(asset.bytes))
    }
  }
  assertXhtmlHrefIntegrity(
    xhtmlDocuments,
    new Set(
      Object.keys(archive)
        .filter((href) => href.startsWith('EPUB/'))
        .map((href) => href.slice('EPUB/'.length)),
    ),
  )
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
