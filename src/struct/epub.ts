import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
  type Zippable,
  type ZipOptions,
} from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  MAX_STRUCT_ASSETS,
  MAX_STRUCT_ASSET_BYTES_TOTAL,
} from './codec/parsers'
import { sha256HexSync } from './sha256'
import { legacyStructDigestMatches, structDigest } from './ids'
import { validateStructConsultationReceipt } from './consultation-receipt'
import { renderPublicationXhtml } from './xhtml'
import { isPackagedAssetId } from './emitted-ids'
import {
  LEGACY_STRUCT_SCHEMA_VERSION,
  STRUCT_SCHEMA_VERSION,
  type StructDocument,
} from './types'

const EPUB_MIMETYPE = 'application/epub+zip' as const
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0)
const EPUB_CSS = `body { font-family: serif; line-height: 1.5; margin: 5%; }
img { display: block; height: auto; max-width: 100%; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid currentColor; padding: 0.25rem; }
figure { break-inside: avoid; margin: 1.5rem 0; }
.visually-hidden, .additional-semantic-reference { clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }`
const MAX_STRUCT_EPUB_PROFILE_CSS_BYTES = 4 * 1024 * 1024
const MAX_STRUCT_EPUB_ARCHIVE_BYTES = 256 * 1024 * 1024

export type StructEpubProfile = {
  id: string
  version: string
  fileName: string
  pageProgressionDirection: 'ltr' | 'rtl'
  renditionFlow: 'paginated' | 'scrolled-continuous'
  configurationSha256: string
  css: string
}

export type StructEpubOptions = {
  profile?: StructEpubProfile
}

export type StructEpubExport = {
  bytes: Uint8Array
  fileName: string
  mediaType: typeof EPUB_MIMETYPE
  sha256: string
  identifier: string
  entries: string[]
  mode: 'publication'
  profile?: ReturnType<typeof profileReceipt>
}

export type UnprofiledStructEpubExport = Omit<StructEpubExport, 'profile'>

function validProfile(profile: StructEpubProfile) {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(profile.id) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(profile.version) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.epub$/u.test(profile.fileName) &&
    /^[a-f0-9]{64}$/u.test(profile.configurationSha256) &&
    profile.css.length > 0 &&
    utf8ByteLength(profile.css) <= MAX_STRUCT_EPUB_PROFILE_CSS_BYTES &&
    !/[\u0000]/u.test(profile.css)
  )
}

function profileReceipt(profile: StructEpubProfile) {
  return {
    schemaVersion: '1.0.0' as const,
    id: profile.id,
    version: profile.version,
    fileName: profile.fileName,
    pageProgressionDirection: profile.pageProgressionDirection,
    renditionFlow: profile.renditionFlow,
    configurationSha256: profile.configurationSha256,
    cssSha256: sha256HexSync(profile.css),
  }
}

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

function utf8ByteLength(value: string) {
  let length = 0
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!
    if (codePoint <= 0x7f) length += 1
    else if (codePoint <= 0x7ff) length += 2
    else if (codePoint <= 0xffff) length += 3
    else {
      length += 4
      index += 1
    }
  }
  return length
}

function artifactFileName(value: string) {
  return value.split(/[\\/]/u).at(-1) || 'source'
}

function assertRfc3339Date(value: string, field: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) throw new Error(`STRUCT EPUB ${field} must be an RFC-3339 date`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    throw new Error(`STRUCT EPUB ${field} must be a real calendar date`)
}

function assertBuilderScalars(document: StructDocument) {
  const { language, publicationDate, artifactModifiedAt, updated } = document.metadata
  if (language !== undefined && !/^(?:(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}|[A-Za-z]{4}|[A-Za-z]{5,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|\d{3}))?(?:-(?:[A-Za-z0-9]{5,8}|\d[A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-x(?:-[A-Za-z0-9]{1,8})+)?|x(?:-[A-Za-z0-9]{1,8})+)$/u.test(language))
    throw new Error('STRUCT EPUB language must be a BCP-47 tag')
  if (publicationDate !== undefined) assertRfc3339Date(publicationDate, 'publicationDate')
  if (updated !== undefined) assertRfc3339Date(updated, 'updated')
  if (artifactModifiedAt !== undefined && (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(artifactModifiedAt) || Number.isNaN(Date.parse(artifactModifiedAt))))
    throw new Error('STRUCT EPUB artifactModifiedAt must be RFC-3339')
  for (const asset of document.assets) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(asset.mediaType))
      throw new Error(`STRUCT EPUB asset ${asset.id} has an invalid MIME type`)
    if (asset.href.includes('%')) throw new Error(`STRUCT EPUB asset ${asset.id} has an ambiguous href`)
  }
}

function assertNoNegativeZero(value: unknown, seen = new WeakSet<object>()) {
  if (typeof value === 'number') {
    if (Object.is(value, -0)) throw new Error('STRUCT EPUB input contains negative zero')
    return
  }
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || seen.has(value)) return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('STRUCT EPUB input must contain data properties')
    assertNoNegativeZero(descriptor.value, seen)
  }
}

function assertNoSemanticZeroWidthRuns(document: StructDocument) {
  for (const block of document.blocks) {
    for (const runs of [block.inline, ...(block.table?.cells.map((cell) => cell.inline) ?? [])])
      for (const run of runs)
        if (run.start === run.end && Object.keys(run).some((key) => key !== 'start' && key !== 'end'))
          throw new Error('STRUCT EPUB input contains a semantic zero-width inline run')
  }
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

function assertStructReceiptIntegrity(document: StructDocument) {
  const receipt = document.receipt
  const hasLegacyDocumentBinding =
    document.documentId === undefined &&
    receipt.documentId === undefined &&
    receipt.modelConsultations === undefined
  const hasBoundDocumentId =
    typeof document.documentId === 'string' &&
    document.documentId.length > 0 &&
    receipt.documentId === document.documentId
  const hasLegacySchema =
    document.schemaVersion === LEGACY_STRUCT_SCHEMA_VERSION &&
    receipt.schemaVersion === LEGACY_STRUCT_SCHEMA_VERSION
  const hasCurrentSchema =
    document.schemaVersion === STRUCT_SCHEMA_VERSION &&
    receipt.schemaVersion === STRUCT_SCHEMA_VERSION
  if (
    (!(hasLegacySchema && hasLegacyDocumentBinding) && !hasBoundDocumentId) ||
    (!hasLegacySchema && !hasCurrentSchema) ||
    receipt.sourceSha256 !== document.source.sha256 ||
    receipt.blockCount !== document.blocks.length ||
    receipt.assetCount !== document.assets.length ||
    receipt.relationshipCount !== document.relationships.length ||
    receipt.diagnosticCount !== document.diagnostics.length ||
    receipt.textCharacterCount !== receipt.conservation.sourceTextCharacterCount
  ) {
    throw new Error('STRUCT_RECEIPT_BINDING_MISMATCH')
  }

  const modelConsultations = receipt.modelConsultations
  if (modelConsultations !== undefined) {
    if (!validateStructConsultationReceipt(modelConsultations)) {
      throw new Error('INVALID_MODEL_CONSULTATION_RECEIPT')
    }
    if (
      modelConsultations.sourceSha256 !== document.source.sha256
    ) {
      throw new Error('MODEL_CONSULTATION_SOURCE_MISMATCH')
    }
    if (modelConsultations.documentId !== document.documentId) {
      throw new Error('MODEL_CONSULTATION_DOCUMENT_MISMATCH')
    }
    if (
      modelConsultations.consultations.some(
        (consultation) => consultation.status === 'pending',
      )
    ) {
      throw new Error('EPUB_PENDING_MODEL_CONSULTATION_RECEIPT')
    }
  }

  const { receipt: _receipt, ...withoutReceipt } = document
  const digestInput = {
    ...withoutReceipt,
    conservation: receipt.conservation,
    ...(modelConsultations ? { modelConsultations } : {}),
    assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
  }
  const expectedGeneratedSha256 = structDigest(digestInput)
  if (
    expectedGeneratedSha256 !== receipt.generatedSha256 &&
    !(
      hasLegacySchema &&
      legacyStructDigestMatches(digestInput, receipt.generatedSha256)
    )
  ) {
    throw new Error('STRUCT_RECEIPT_DIGEST_MISMATCH')
  }
}

/** Assemble a deterministic EPUB using only the canonical STRUCT contract. */
export function buildStructEpub(
  document: StructDocument,
): Promise<UnprofiledStructEpubExport>
export function buildStructEpub(
  document: StructDocument,
  options: StructEpubOptions,
): Promise<StructEpubExport>
export async function buildStructEpub(
  document: StructDocument,
  options: StructEpubOptions = {},
): Promise<StructEpubExport> {
  assertBuilderScalars(document)
  assertNoSemanticZeroWidthRuns(document)
  assertStructReceiptIntegrity(document)
  assertNoNegativeZero(document)
  const profile = options.profile
  if (profile && !validProfile(profile)) {
    throw new Error('STRUCT_EPUB_PROFILE_INVALID')
  }
  const retainedProfile = profile ? profileReceipt(profile) : undefined
  const identifier = `urn:sha256:${document.receipt.generatedSha256}${retainedProfile ? `:${retainedProfile.id}:${retainedProfile.version}:${retainedProfile.configurationSha256.slice(0, 16)}` : ''}`
  const language = document.metadata.language ?? 'und'
  const modified = (
    document.metadata.artifactModifiedAt ??
    `${document.metadata.updated ?? '1970-01-01'}T00:00:00Z`
  ).replace(/\.\d{3}Z$/, 'Z')
  const assets = document.assets.map((asset) => {
    if (!asset.bytes) {
      throw new Error(`STRUCT asset ${asset.id} has no packaged bytes.`)
    }
    const bytes = new Uint8Array(asset.bytes)
    if (sha256HexSync(bytes) !== asset.sha256) {
      throw new Error(
        `STRUCT asset ${asset.id} bytes do not match declared SHA-256.`,
      )
    }
    return { ...asset, bytes }
  })
  const assetBytes = assets.reduce(
    (total, asset) => total + asset.bytes.byteLength,
    0,
  )
  if (
    assets.length > MAX_STRUCT_ASSETS ||
    assetBytes > MAX_STRUCT_ASSET_BYTES_TOTAL
  )
    throw new Error('STRUCT_EPUB_ASSET_RESOURCE_LIMIT')
  const reservedHrefs = new Set([
    'package.opf',
    'nav.xhtml',
    'content.xhtml',
    'styles.css',
    'struct.json',
    'profile.json',
  ])
  const assetIds = new Set<string>()
  const assetHrefs = new Set<string>()
  for (const asset of assets) {
    if (assetIds.has(asset.id) || !isPackagedAssetId(asset.id)) {
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
    ${retainedProfile ? `<meta property="rendition:flow">${retainedProfile.renditionFlow}</meta>` : ''}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml" />
    <item id="styles" href="styles.css" media-type="text/css" />
    <item id="struct" href="struct.json" media-type="application/json" />
    ${retainedProfile ? '<item id="profile" href="profile.json" media-type="application/json" />' : ''}
    ${assetItems}
  </manifest>
  <spine${retainedProfile ? ` page-progression-direction="${retainedProfile.pageProgressionDirection}"` : ''}><itemref idref="content" /></spine>
</package>
`
  const headings = document.blocks.filter((block) => block.kind === 'heading')
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${attribute(language)}"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="content.xhtml">${text(document.metadata.title)}</a></li>${headings.map((block) => `<li><a href="content.xhtml#${attribute(block.id)}">${text(block.text)}</a></li>`).join('')}</ol></nav></body></html>
`
  const content = renderPublicationXhtml(document)
  const structArtifact = {
    schemaVersion: document.schemaVersion,
    source: {
      ...document.source,
      fileName: artifactFileName(document.source.fileName),
    },
    receipt: document.receipt,
  }
  const serializedStructArtifact = `${JSON.stringify(structArtifact)}\n`
  const serializedProfile = retainedProfile
    ? `${JSON.stringify(retainedProfile)}\n`
    : undefined
  const container =
    '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>'
  const archiveBytes =
    utf8ByteLength(EPUB_MIMETYPE) +
    utf8ByteLength(container) +
    utf8ByteLength(packageDocument) +
    utf8ByteLength(nav) +
    utf8ByteLength(content) +
    utf8ByteLength(profile?.css ?? EPUB_CSS) +
    utf8ByteLength(serializedStructArtifact) +
    (serializedProfile ? utf8ByteLength(serializedProfile) : 0) +
    assetBytes
  if (archiveBytes > MAX_STRUCT_EPUB_ARCHIVE_BYTES)
    throw new Error('STRUCT_EPUB_ARCHIVE_RESOURCE_LIMIT')
  const archive: Zippable = {
    mimetype: entry(EPUB_MIMETYPE, 0),
    'META-INF/container.xml': entry(container),
    'EPUB/package.opf': entry(packageDocument),
    'EPUB/nav.xhtml': entry(nav),
    'EPUB/content.xhtml': entry(content),
    'EPUB/styles.css': entry(profile?.css ?? EPUB_CSS),
    'EPUB/struct.json': entry(serializedStructArtifact),
    ...(retainedProfile
      ? {
          'EPUB/profile.json': entry(serializedProfile!),
        }
      : {}),
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
  if (retainedProfile) {
    const reopened = unzipSync(bytes)
    const reopenedProfile = reopened['EPUB/profile.json']
    const reopenedCss = reopened['EPUB/styles.css']
    if (
      !reopenedProfile ||
      !reopenedCss ||
      strFromU8(reopenedProfile) !== serializedProfile ||
      sha256HexSync(reopenedCss) !== retainedProfile.cssSha256
    ) {
      throw new Error('STRUCT_EPUB_PROFILE_REOPEN_MISMATCH')
    }
  }
  return {
    bytes,
    fileName:
      retainedProfile?.fileName ??
      `${slug(document.metadata.title)}-${document.receipt.generatedSha256.slice(0, 12)}.epub`,
    mediaType: EPUB_MIMETYPE,
    sha256: sha256HexSync(bytes),
    identifier,
    entries: Object.keys(archive),
    mode: 'publication' as const,
    ...(retainedProfile ? { profile: retainedProfile } : {}),
  }
}
