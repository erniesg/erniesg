import {
  decodeCompatibleStructDocument,
  type StructDocument,
} from '@erniesg/struct'
import {
  buildStructEpub,
  type StructEpubExport,
  type StructEpubProfile,
} from '@erniesg/struct/renderers/epub'
import { renderPublicationXhtml } from '@erniesg/struct/renderers/xhtml'
import { strFromU8, unzipSync } from 'fflate'
import { XMLValidator } from 'fast-xml-parser'
import bundledStructArtifact from '../../vendor/erniesg-struct-0.0.0.tgz?url&inline'
import { buildStructDocument } from '../struct/from-reconstruction'
import type {
  DocumentImportProgress,
  DocumentReconstruction,
} from './import-types'
import { MAX_LOCAL_PDF_BYTES, PdfImportError } from './import-types'
import { sha256HexSync } from './sha256-sync'

export const PRIVATE_PDF_EPUB_STRUCT_ARTIFACT = Object.freeze({
  packageName: '@erniesg/struct' as const,
  packageVersion: '0.0.0' as const,
  gitCommit: '47666f14e696f3c8037c0a1172b30c177dc53f6f' as const,
  packedArtifactSha256:
    'ea7a9abc1d69616a0d5c4b400b6e0131b3e76909564c6b57bd0c7805f55bcc0e' as const,
})

export const PRIVATE_PDF_EPUB_FILE_NAME = 'private-publication.epub' as const
const PRIVATE_PDF_ANONYMOUS_FILE_NAME = 'local-document.pdf'
const PRIVATE_PDF_EPUB_PROFILE_VERSION = '1.0.0'
const PRIVATE_PDF_EPUB_PROFILE_CSS = `body { font-family: serif; line-height: 1.5; margin: 5%; }
img { display: block; height: auto; max-width: 100%; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid currentColor; padding: 0.25rem; }
figure { break-inside: avoid; margin-block: 1.5rem; }
`

export const PRIVATE_PDF_EPUB_ERROR_CODES = [
  'INVALID_PDF',
  'MALFORMED_PDF',
  'ENCRYPTED_PDF',
  'UNSAFE_PDF',
  'OVERSIZED_PDF',
  'OCR_REQUIRED',
  'REVIEW_REQUIRED',
  'IMPORT_CANCELLED',
  'STRUCT_ARTIFACT_MISMATCH',
  'INVALID_BRIDGE_DOCUMENT',
  'STRUCT_RENDERER_REFUSED',
  'EPUB_CONFORMANCE_FAILED',
  'NONDETERMINISTIC_OUTPUT',
  'INTERNAL_FAILURE',
] as const

export type PrivatePdfEpubErrorCode =
  (typeof PRIVATE_PDF_EPUB_ERROR_CODES)[number]

const PRIVATE_PDF_EPUB_ERROR_MESSAGES: Record<PrivatePdfEpubErrorCode, string> =
  {
    INVALID_PDF:
      'This file is not an accepted PDF. It was not saved or uploaded.',
    MALFORMED_PDF:
      'This PDF is malformed or incomplete. It was not saved or uploaded.',
    ENCRYPTED_PDF:
      'Password-protected PDFs are not supported. The file was not saved or uploaded.',
    UNSAFE_PDF:
      'This PDF contains unsupported active or embedded content. It was not saved or uploaded.',
    OVERSIZED_PDF:
      'This PDF exceeds the local size limit. It was not saved or uploaded.',
    OCR_REQUIRED:
      'This PDF needs local text recovery before safe EPUB export. It was not saved or uploaded.',
    REVIEW_REQUIRED:
      'This PDF needs review before safe EPUB export. It was not saved or uploaded.',
    IMPORT_CANCELLED:
      'The local conversion was cancelled. The file was not saved or uploaded.',
    STRUCT_ARTIFACT_MISMATCH:
      'The pinned Struct artifact did not match. The file was not saved or uploaded.',
    INVALID_BRIDGE_DOCUMENT:
      'The reconstructed document failed the safe Struct boundary. It was not saved or uploaded.',
    STRUCT_RENDERER_REFUSED:
      'Struct safely refused this document. It was not saved or uploaded.',
    EPUB_CONFORMANCE_FAILED:
      'The generated package failed local EPUB validation. It was not saved or uploaded.',
    NONDETERMINISTIC_OUTPUT:
      'The two local conversions did not match. The output was not saved or uploaded.',
    INTERNAL_FAILURE:
      'The local conversion stopped safely. Nothing was saved or uploaded.',
  }

export class PrivatePdfEpubBridgeError extends Error {
  public readonly code: PrivatePdfEpubErrorCode

  constructor(code: PrivatePdfEpubErrorCode) {
    super(PRIVATE_PDF_EPUB_ERROR_MESSAGES[code])
    this.code = code
    this.name = 'PrivatePdfEpubBridgeError'
  }
}

let bundledStructArtifactVerified = false

export function verifyBundledPrivatePdfEpubStructArtifact() {
  if (bundledStructArtifactVerified) return

  let bytes: Uint8Array | undefined
  try {
    const separator = bundledStructArtifact.indexOf(',')
    const header = bundledStructArtifact.slice(0, separator)
    if (
      separator < 1 ||
      !header.startsWith('data:') ||
      !header.endsWith(';base64')
    )
      throw new Error('INVALID_INLINE_ARTIFACT')
    const binary = atob(bundledStructArtifact.slice(separator + 1))
    bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1)
      bytes[index] = binary.charCodeAt(index)
    verifyPrivatePdfEpubStructArtifact(bytes)
    bundledStructArtifactVerified = true
  } catch {
    throw new PrivatePdfEpubBridgeError('STRUCT_ARTIFACT_MISMATCH')
  } finally {
    bytes?.fill(0)
  }
}

export function safePrivatePdfEpubError(error: unknown) {
  let candidate: unknown
  try {
    if (error instanceof PrivatePdfEpubBridgeError) candidate = error.code
  } catch {
    candidate = undefined
  }
  const code: PrivatePdfEpubErrorCode =
    typeof candidate === 'string' &&
    PRIVATE_PDF_EPUB_ERROR_CODES.includes(candidate as PrivatePdfEpubErrorCode)
      ? (candidate as PrivatePdfEpubErrorCode)
      : 'INTERNAL_FAILURE'
  return {
    code,
    message: PRIVATE_PDF_EPUB_ERROR_MESSAGES[code],
  }
}

const PRIVATE_PDF_EPUB_PROGRESS_MESSAGES: Record<
  DocumentImportProgress['phase'],
  string
> = {
  opening: 'Opening the document locally…',
  extracting: 'Reading document structure locally…',
  ocr: 'Recovering document text locally…',
  segmenting: 'Segmenting document content locally…',
  'reading-order': 'Resolving reading order locally…',
  'semantic-promotion': 'Checking document semantics locally…',
  'asset-packaging': 'Packaging document assets locally…',
  reconstructing: 'Reconstructing the document locally…',
  assembling: 'Assembling the document locally…',
  paginating: 'Paginating the document locally…',
  validating: 'Validating the document locally…',
}

export function safePrivatePdfEpubProgress(progress: DocumentImportProgress) {
  return (
    PRIVATE_PDF_EPUB_PROGRESS_MESSAGES[progress.phase] ??
    'Converting the document locally…'
  )
}

export function verifyPrivatePdfEpubStructArtifact(bytes: Uint8Array) {
  if (
    sha256HexSync(bytes) !==
    PRIVATE_PDF_EPUB_STRUCT_ARTIFACT.packedArtifactSha256
  )
    throw new PrivatePdfEpubBridgeError('STRUCT_ARTIFACT_MISMATCH')
}

export const PRIVATE_PDF_EPUB_CATEGORIES = [
  'paragraph',
  'hierarchy',
  'tables',
  'figures',
  'citations',
  'notes',
  'multicolumn',
  'rtl',
  'navigation',
  'assets',
  'metadata',
  'malformed',
  'bounds',
  'ambiguity',
] as const

export type PrivatePdfEpubCategory =
  (typeof PRIVATE_PDF_EPUB_CATEGORIES)[number]

export type PrivatePdfEpubExport = {
  bytes: Uint8Array
  fileName: typeof PRIVATE_PDF_EPUB_FILE_NAME
  mediaType: 'application/epub+zip'
  sha256: string
  identifier: string
  entries: readonly string[]
  categories: readonly PrivatePdfEpubCategory[]
  conservation: {
    neutralObligations: number
    conservedNeutralObligations: number
  }
  structArtifact: typeof PRIVATE_PDF_EPUB_STRUCT_ARTIFACT
}

type PrivatePdfEpubDependencies = {
  reconstruct: (
    file: File,
    onProgress?: (progress: DocumentImportProgress) => void,
    signal?: AbortSignal,
  ) => Promise<DocumentReconstruction>
  adapt: (reconstruction: DocumentReconstruction) => unknown
  decode: (document: unknown) => StructDocument
  render: (document: StructDocument) => string
  build: (
    document: StructDocument,
    options: { profile: StructEpubProfile },
  ) => Promise<StructEpubExport>
  inspectEpub: (epub: StructEpubExport) => void
}

export type PrivatePdfEpubBridgeOptions = {
  signal?: AbortSignal
  onProgress?: (progress: DocumentImportProgress) => void
  dependencies?: Partial<PrivatePdfEpubDependencies>
}

const PDF_NAME_DELIMITERS = new Set([
  0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x25, 0x28, 0x29, 0x2f, 0x3c, 0x3e, 0x5b,
  0x5d, 0x7b, 0x7d,
])

const FORBIDDEN_PDF_NAMES = new Set([
  'aa',
  'acroform',
  'collection',
  'embeddedfile',
  'embeddedfiles',
  'gotoe',
  'importdata',
  'javascript',
  'js',
  'launch',
  'rendition',
  'richmedia',
  'submitform',
  'xfa',
])

function hexNibble(value: number) {
  if (value >= 0x30 && value <= 0x39) return value - 0x30
  if (value >= 0x41 && value <= 0x46) return value - 0x41 + 10
  if (value >= 0x61 && value <= 0x66) return value - 0x61 + 10
  return -1
}

function pdfNameAt(bytes: Uint8Array, start: number) {
  const decoded: number[] = []
  let index = start
  while (
    index < bytes.byteLength &&
    !PDF_NAME_DELIMITERS.has(bytes[index]!) &&
    decoded.length <= 128
  ) {
    if (bytes[index] === 0x23 && index + 2 < bytes.byteLength) {
      const high = hexNibble(bytes[index + 1]!)
      const low = hexNibble(bytes[index + 2]!)
      if (high >= 0 && low >= 0) {
        decoded.push((high << 4) | low)
        index += 3
        continue
      }
    }
    decoded.push(bytes[index]!)
    index += 1
  }
  return {
    name: String.fromCharCode(...decoded).toLowerCase(),
    end: Math.max(index, start + 1),
  }
}

function inspectPdfSyntax(bytes: Uint8Array) {
  if (
    bytes.byteLength < 5 ||
    bytes[0] !== 0x25 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x44 ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 0x2d
  ) {
    throw new PrivatePdfEpubBridgeError('INVALID_PDF')
  }

  let encrypted = false
  let unsafe = false
  for (let index = 5; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x2f) continue
    const token = pdfNameAt(bytes, index + 1)
    index = token.end - 1
    if (token.name === 'encrypt') encrypted = true
    if (FORBIDDEN_PDF_NAMES.has(token.name)) unsafe = true
  }
  if (encrypted) throw new PrivatePdfEpubBridgeError('ENCRYPTED_PDF')
  if (unsafe) throw new PrivatePdfEpubBridgeError('UNSAFE_PDF')
}

function profileFor(document: StructDocument): StructEpubProfile {
  const pageProgressionDirection: 'ltr' | 'rtl' =
    document.metadata.baseDirection === 'rtl' ? 'rtl' : 'ltr'
  const configuration = {
    id: `private-local-${pageProgressionDirection}`,
    version: PRIVATE_PDF_EPUB_PROFILE_VERSION,
    fileName: PRIVATE_PDF_EPUB_FILE_NAME,
    pageProgressionDirection,
    renditionFlow: 'scrolled-continuous' as const,
    css: PRIVATE_PDF_EPUB_PROFILE_CSS,
  }
  return Object.freeze({
    ...configuration,
    configurationSha256: sha256HexSync(JSON.stringify(configuration)),
  })
}

function exactBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false
  return true
}

function exactStrings(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function firstZipEntry(bytes: Uint8Array) {
  if (bytes.byteLength < 30) throw new Error('EPUB_ZIP_HEADER')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x04034b50) throw new Error('EPUB_ZIP_HEADER')
  const flags = view.getUint16(6, true)
  const method = view.getUint16(8, true)
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  if (
    flags & 0x1 ||
    nameLength < 1 ||
    30 + nameLength + extraLength > bytes.byteLength
  )
    throw new Error('EPUB_ZIP_HEADER')
  return {
    method,
    name: strFromU8(bytes.subarray(30, 30 + nameLength)),
  }
}

function inspectBuiltEpub(epub: StructEpubExport) {
  if (
    epub.mediaType !== 'application/epub+zip' ||
    epub.fileName !== PRIVATE_PDF_EPUB_FILE_NAME ||
    epub.sha256 !== sha256HexSync(epub.bytes)
  )
    throw new Error('EPUB_EXPORT_RECEIPT')

  const first = firstZipEntry(epub.bytes)
  if (first.name !== 'mimetype' || first.method !== 0)
    throw new Error('EPUB_MIMETYPE_ORDER')

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(epub.bytes)
  } catch {
    throw new Error('EPUB_REOPEN')
  }
  if (!exactStrings(Object.keys(files), epub.entries))
    throw new Error('EPUB_ENTRY_RECEIPT')
  if (strFromU8(files.mimetype ?? new Uint8Array()) !== 'application/epub+zip')
    throw new Error('EPUB_MIMETYPE')

  const requiredXml = [
    'META-INF/container.xml',
    'EPUB/package.opf',
    'EPUB/nav.xhtml',
    'EPUB/content.xhtml',
  ] as const
  const xml = new Map<string, string>()
  for (const name of requiredXml) {
    const bytes = files[name]
    if (!bytes) throw new Error('EPUB_REQUIRED_ENTRY')
    const source = strFromU8(bytes)
    if (XMLValidator.validate(source) !== true)
      throw new Error('EPUB_XML_INVALID')
    xml.set(name, source)
  }
  if (!files['EPUB/styles.css']) throw new Error('EPUB_REQUIRED_ENTRY')
  if (!xml.get('META-INF/container.xml')!.includes('EPUB/package.opf'))
    throw new Error('EPUB_CONTAINER_BINDING')
  if (!/<spine\b[\s\S]*?<itemref\b/u.test(xml.get('EPUB/package.opf')!))
    throw new Error('EPUB_SPINE')
  if (!/<nav\b/u.test(xml.get('EPUB/nav.xhtml')!))
    throw new Error('EPUB_NAVIGATION')
  if (!/<body\b/u.test(xml.get('EPUB/content.xhtml')!))
    throw new Error('EPUB_CONTENT')
}

function categoriesFor(document: StructDocument) {
  const categories = new Set<PrivatePdfEpubCategory>()
  if (
    document.blocks.some((block) =>
      ['paragraph', 'quote', 'list-item', 'code'].includes(block.kind),
    )
  )
    categories.add('paragraph')
  if (document.blocks.some((block) => block.kind === 'heading')) {
    categories.add('hierarchy')
    categories.add('navigation')
  }
  if (document.blocks.some((block) => block.kind === 'table'))
    categories.add('tables')
  if (
    document.blocks.some((block) =>
      ['figure', 'equation', 'caption'].includes(block.kind),
    )
  )
    categories.add('figures')
  if (document.relationships.some((value) => value.kind === 'citation'))
    categories.add('citations')
  if (
    document.relationships.some((value) =>
      ['footnote', 'endnote'].includes(value.kind),
    )
  )
    categories.add('notes')
  if (
    document.blocks.some(
      (block) => block.column === 'left' || block.column === 'right',
    )
  )
    categories.add('multicolumn')
  if (document.metadata.baseDirection === 'rtl') categories.add('rtl')
  if (document.assets.length > 0) categories.add('assets')
  if (document.metadata.title.trim()) categories.add('metadata')
  if (
    document.relationships.some(
      (value) => value.status === 'ambiguous' || value.status === 'unresolved',
    )
  )
    categories.add('ambiguity')
  return PRIVATE_PDF_EPUB_CATEGORIES.filter((category) =>
    categories.has(category),
  )
}

function conservationFor(document: StructDocument) {
  const source = document.receipt.conservation
  const neutralObligations =
    source.sourceNodeCount +
    source.sourceRegionCount +
    source.sourceAnnotationCount +
    source.sourceAssetCount +
    source.sourceRelationshipCount +
    source.sourceDiagnosticCount
  const conservedNeutralObligations =
    source.accountedSourceNodeCount +
    source.accountedSourceRegionCount +
    source.accountedSourceAnnotationCount +
    source.accountedSourceAssetCount +
    source.accountedSourceRelationshipCount +
    source.accountedSourceDiagnosticCount
  return {
    neutralObligations,
    conservedNeutralObligations,
  }
}

function reconstructionFailure(error: unknown): PrivatePdfEpubBridgeError {
  if (!(error instanceof PdfImportError))
    return new PrivatePdfEpubBridgeError('INTERNAL_FAILURE')
  switch (error.code) {
    case 'INVALID_PDF':
      return new PrivatePdfEpubBridgeError('INVALID_PDF')
    case 'ENCRYPTED_PDF':
      return new PrivatePdfEpubBridgeError('ENCRYPTED_PDF')
    case 'OVERSIZED_PDF':
      return new PrivatePdfEpubBridgeError('OVERSIZED_PDF')
    case 'OCR_REQUIRED':
    case 'OCR_LANGUAGE_UNAVAILABLE':
    case 'OCR_NETWORK_FORBIDDEN':
      return new PrivatePdfEpubBridgeError('OCR_REQUIRED')
    case 'INCOMPLETE_RECONSTRUCTION':
      return new PrivatePdfEpubBridgeError('REVIEW_REQUIRED')
    case 'IMPORT_CANCELLED':
      return new PrivatePdfEpubBridgeError('IMPORT_CANCELLED')
    case 'EMPTY_PDF':
    case 'PDF_PARSE_FAILED':
    case 'CONVERSION_STALLED':
    case 'INVALID_PDF_URL':
    case 'PDF_DOWNLOAD_FAILED':
      return new PrivatePdfEpubBridgeError('MALFORMED_PDF')
  }
}

const DEFAULT_DEPENDENCIES: PrivatePdfEpubDependencies = {
  reconstruct: async (file, onProgress, signal) => {
    const { reconstructPdfInWorker } =
      await import('./publication-worker-client')
    return reconstructPdfInWorker(file, onProgress, {
      signal,
      privacyBoundary: 'content-free',
    })
  },
  adapt: buildStructDocument,
  decode: decodeCompatibleStructDocument,
  render: renderPublicationXhtml,
  build: (document, options) => buildStructEpub(document, options),
  inspectEpub: inspectBuiltEpub,
}

export async function convertPrivatePdfToEpub(
  file: File,
  options: PrivatePdfEpubBridgeOptions = {},
): Promise<PrivatePdfEpubExport> {
  // Verify the exact repository-owned pack before reading any private input.
  verifyBundledPrivatePdfEpubStructArtifact()
  if (options.signal?.aborted)
    throw new PrivatePdfEpubBridgeError('IMPORT_CANCELLED')
  if (file.size > MAX_LOCAL_PDF_BYTES)
    throw new PrivatePdfEpubBridgeError('OVERSIZED_PDF')

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    throw new PrivatePdfEpubBridgeError('MALFORMED_PDF')
  }
  inspectPdfSyntax(bytes)
  const anonymousFile = new File([bytes], PRIVATE_PDF_ANONYMOUS_FILE_NAME, {
    type: 'application/pdf',
    lastModified: 0,
  })
  const dependencies: PrivatePdfEpubDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...options.dependencies,
  }

  let reconstruction: DocumentReconstruction
  try {
    reconstruction = await dependencies.reconstruct(
      anonymousFile,
      options.onProgress,
      options.signal,
    )
  } catch (error) {
    throw reconstructionFailure(error)
  }
  if (!reconstruction.readiness.ready)
    throw new PrivatePdfEpubBridgeError(
      reconstruction.completeness.ocrRequiredPages.length > 0
        ? 'OCR_REQUIRED'
        : 'REVIEW_REQUIRED',
    )

  let bridgeDocument: unknown
  try {
    bridgeDocument = dependencies.adapt(reconstruction)
  } catch {
    throw new PrivatePdfEpubBridgeError('INVALID_BRIDGE_DOCUMENT')
  }

  let firstDocument: StructDocument
  let secondDocument: StructDocument
  try {
    firstDocument = dependencies.decode(bridgeDocument)
    secondDocument = dependencies.decode(bridgeDocument)
  } catch {
    throw new PrivatePdfEpubBridgeError('INVALID_BRIDGE_DOCUMENT')
  }

  const firstProfile = profileFor(firstDocument)
  const secondProfile = profileFor(secondDocument)
  let firstXhtml: string
  let secondXhtml: string
  let firstEpub: StructEpubExport
  let secondEpub: StructEpubExport
  try {
    firstXhtml = dependencies.render(firstDocument)
    firstEpub = await dependencies.build(firstDocument, {
      profile: firstProfile,
    })
    secondXhtml = dependencies.render(secondDocument)
    secondEpub = await dependencies.build(secondDocument, {
      profile: secondProfile,
    })
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'STRUCT_EPUB_RECOVERY_REVIEW_REQUIRED'
    )
      throw new PrivatePdfEpubBridgeError('REVIEW_REQUIRED')
    throw new PrivatePdfEpubBridgeError('STRUCT_RENDERER_REFUSED')
  }

  if (
    firstXhtml !== secondXhtml ||
    !exactBytes(firstEpub.bytes, secondEpub.bytes) ||
    firstEpub.sha256 !== secondEpub.sha256 ||
    firstEpub.identifier !== secondEpub.identifier ||
    firstEpub.fileName !== secondEpub.fileName ||
    !exactStrings(firstEpub.entries, secondEpub.entries)
  )
    throw new PrivatePdfEpubBridgeError('NONDETERMINISTIC_OUTPUT')

  try {
    dependencies.inspectEpub(firstEpub)
    dependencies.inspectEpub(secondEpub)
  } catch {
    throw new PrivatePdfEpubBridgeError('EPUB_CONFORMANCE_FAILED')
  }

  return {
    bytes: firstEpub.bytes.slice(),
    fileName: PRIVATE_PDF_EPUB_FILE_NAME,
    mediaType: 'application/epub+zip',
    sha256: firstEpub.sha256,
    identifier: firstEpub.identifier,
    entries: [...firstEpub.entries],
    categories: categoriesFor(firstDocument),
    conservation: conservationFor(firstDocument),
    structArtifact: PRIVATE_PDF_EPUB_STRUCT_ARTIFACT,
  }
}
