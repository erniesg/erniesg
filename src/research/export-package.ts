import { createHash } from 'node:crypto'
import { strFromU8 } from 'fflate'
import { z } from 'zod'
import {
  resolveTextAnchor,
  textAnnotationSchema,
  type TextAnnotation,
} from './annotations'
import {
  buildEpub,
  inspectEpub,
  renderPublicationXhtml,
  type EpubExport,
} from './epub'
import {
  buildPaginatedPdf,
  inspectPaginatedPdf,
  normalizePdfText,
} from './export-pdf'
import {
  buildLayoutManifest,
  ManifestInvariantError,
  serializeLayoutManifest,
  validateLayoutManifest,
} from './manifest'
import {
  targetOverrideDigest,
  validateTargetOverrides,
  type TargetOverride,
} from './overrides'
import {
  canonicalContentHash,
  researchPaperSchema,
  type ResearchPaper,
} from './schema'
import {
  getTargetProfile,
  TARGET_PROFILE_IDS,
  type TargetProfile,
  type TargetProfileId,
} from './targets'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const PAYLOAD_PATHS = [
  'source.json',
  'layout-manifest.json',
  'annotations.json',
  'reflowable.html',
  'publication.epub',
  'publication-paperpro.epub',
  'publication-papermove.epub',
  'print.pdf',
] as const

export const EXPORT_PACKAGE_PATHS = [
  ...PAYLOAD_PATHS,
  'export-manifest.json',
  'checksums.sha256',
] as const

export type ExportPackagePath = (typeof EXPORT_PACKAGE_PATHS)[number]

export type ExportFile = {
  path: ExportPackagePath
  mediaType: string
  bytes: Uint8Array
}

export type ExportPackage = {
  files: ExportFile[]
}

export type ExportVerificationIssue = {
  code: string
  message: string
}

export class ExportVerificationError extends Error {
  constructor(public readonly issues: ExportVerificationIssue[]) {
    super(issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n'))
    this.name = 'ExportVerificationError'
  }
}

const exportManifestSchema = z
  .object({
    schemaVersion: z.literal('1.1.0'),
    document: z
      .object({
        id: z.string().min(1),
        version: z.string().min(1),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    configuration: z
      .object({
        targets: z.array(z.enum(TARGET_PROFILE_IDS)),
        overrideDigest: z.string().regex(/^[a-f0-9]{64}$/),
        overrides: z.array(z.unknown()),
        deviceEpubs: z.array(
          z
            .object({
              artifact: z.enum([
                'publication-paperpro.epub',
                'publication-papermove.epub',
              ]),
              profileId: z.enum(['paperPro', 'paperProMove']),
              profileVersion: z.string().min(1),
              compositionPolicy: z
                .object({
                  id: z.string().min(1),
                  version: z.string().min(1),
                })
                .passthrough(),
              exportPolicy: z
                .object({
                  id: z.literal('profile-tuned-reflowable'),
                  version: z.string().min(1),
                })
                .strict(),
            })
            .strict(),
        ),
      })
      .strict(),
    determinism: z
      .object({
        guarantee: z.string().min(1),
        limits: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    verification: z
      .object({
        mode: z.literal('fail-closed-before-return'),
        checks: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    files: z.array(
      z
        .object({
          path: z.enum(PAYLOAD_PATHS),
          mediaType: z.string().min(1),
          byteLength: z.number().int().nonnegative(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    checksumFile: z.literal('checksums.sha256'),
  })
  .strict()

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonBytes(value: unknown) {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`)
}

function file(
  path: ExportPackagePath,
  mediaType: string,
  bytes: Uint8Array,
): ExportFile {
  return { path, mediaType, bytes }
}

function fail(code: string, message: string): never {
  throw new ExportVerificationError([{ code, message }])
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

const DEVICE_EPUB_TARGETS = [
  'paperPro',
  'paperProMove',
] as const satisfies readonly TargetProfileId[]

function deviceEpubMetadata(epub: EpubExport) {
  if (!epub.profile) {
    throw new Error(`${epub.fileName} is missing target-profile metadata`)
  }
  return {
    artifact: epub.fileName as
      | 'publication-paperpro.epub'
      | 'publication-papermove.epub',
    profileId: epub.profile.id as 'paperPro' | 'paperProMove',
    profileVersion: epub.profile.version,
    compositionPolicy: epub.profile.compositionPolicy,
    exportPolicy: epub.profile.exportPolicy,
  }
}

function canonicalIdsFromXhtml(value: string) {
  return [...value.matchAll(/data-canonical-id="([^"]+)"/g)].map(
    (match) => match[1],
  )
}

function xmlText(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function verifyXhtmlContent(
  value: string,
  paper: ResearchPaper,
  format: 'HTML' | 'EPUB',
) {
  const metadata = [
    paper.title,
    paper.subtitle,
    paper.abstract,
    ...paper.authors,
  ]
  for (const expected of metadata) {
    if (!value.includes(xmlText(expected))) {
      fail(
        `${format}_CONTENT_MISMATCH`,
        `${format} omitted canonical publication metadata`,
      )
    }
  }
  for (const node of paper.nodes) {
    const expected = node.type === 'figure' ? node.title : node.text
    if (!value.includes(xmlText(expected))) {
      fail(
        `${format}_CONTENT_MISMATCH`,
        `${format} omitted canonical content for ${node.id}`,
      )
    }
  }
}

function verifyXhtmlRelationships(
  value: string,
  paper: ResearchPaper,
  format: 'HTML' | 'EPUB',
) {
  for (const node of paper.nodes) {
    if (
      node.type === 'figure' &&
      !value.includes(`data-caption-id="${node.relationships.caption}"`)
    ) {
      fail(
        `${format}_RELATIONSHIP_MISMATCH`,
        `Figure ${node.id} lost caption ${node.relationships.caption}`,
      )
    }
  }
}

function normalizedText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

async function inspectPdfContent(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    useSystemFonts: true,
  })
  let document: Awaited<typeof loadingTask.promise> | undefined
  try {
    document = await loadingTask.promise
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push(
        content.items.map((item) => ('str' in item ? item.str : '')).join(' '),
      )
    }
    return {
      pageCount: document.numPages,
      text: normalizedText(normalizePdfText(pages.join(' '))),
    }
  } finally {
    await document?.destroy()
  }
}

function verifyPdfContent(value: string, paper: ResearchPaper) {
  const expectedValues = [
    { label: 'title', value: paper.title },
    { label: 'subtitle', value: paper.subtitle },
    { label: 'abstract', value: paper.abstract },
    ...paper.authors.map((author, index) => ({
      label: `author ${index + 1}`,
      value: author,
    })),
    ...paper.nodes.map((node) => ({
      label: `node ${node.id}`,
      value: node.type === 'figure' ? node.title : node.text,
    })),
  ]
  for (const expected of expectedValues) {
    if (!value.includes(normalizedText(normalizePdfText(expected.value)))) {
      fail(
        'PDF_CONTENT_MISMATCH',
        `PDF text extraction omitted canonical ${expected.label}`,
      )
    }
  }
}

export function getExportFile(exportPackage: ExportPackage, path: string) {
  const result = exportPackage.files.find(
    (candidate) => candidate.path === path,
  )
  if (!result) throw new Error(`Export package is missing ${path}`)
  return result
}

export async function buildExportPackage(
  paper: ResearchPaper,
  annotationInput: readonly TextAnnotation[],
  overrideInput: readonly TargetOverride[] = [],
): Promise<ExportPackage> {
  const annotations = z.array(textAnnotationSchema).parse(annotationInput)
  const overrides = validateTargetOverrides(overrideInput, paper)
  const layout = buildLayoutManifest(paper, TARGET_PROFILE_IDS, overrides)
  const xhtml = renderPublicationXhtml(paper, { embedStyles: true })
  const [epub, ...deviceEpubs] = await Promise.all([
    buildEpub(paper),
    ...DEVICE_EPUB_TARGETS.map((target) =>
      buildEpub(paper, getTargetProfile(target)),
    ),
  ])
  const pdf = buildPaginatedPdf(paper, layout)
  const payloads: ExportFile[] = [
    file('source.json', 'application/json', jsonBytes(paper)),
    file(
      'layout-manifest.json',
      'application/json',
      encoder.encode(serializeLayoutManifest(layout)),
    ),
    file('annotations.json', 'application/json', jsonBytes(annotations)),
    file('reflowable.html', 'text/html; charset=utf-8', encoder.encode(xhtml)),
    file('publication.epub', epub.mediaType, epub.bytes),
    ...deviceEpubs.map((deviceEpub) =>
      file(
        deviceEpub.fileName as ExportPackagePath,
        deviceEpub.mediaType,
        deviceEpub.bytes,
      ),
    ),
    file('print.pdf', pdf.mediaType, pdf.bytes),
  ]
  const exportManifest = exportManifestSchema.parse({
    schemaVersion: '1.1.0',
    document: {
      id: paper.id,
      version: paper.version,
      contentHash: canonicalContentHash(paper),
    },
    configuration: {
      targets: TARGET_PROFILE_IDS,
      overrideDigest: targetOverrideDigest(overrides),
      overrides,
      deviceEpubs: deviceEpubs.map(deviceEpubMetadata),
    },
    determinism: {
      guarantee:
        'Byte-identical output for identical canonical content, annotations, overrides, policy versions, dependency versions, and compatible runtimes.',
      limits: [
        'The PDF uses deterministic estimated pagination and built-in font metrics; HTML and EPUB are the reflowable text-fidelity reference.',
        'EPUB archive timestamps and PDF metadata dates are derived from canonical input rather than the wall clock.',
        'Changes to compression libraries, layout policies, or runtime text encoding may intentionally change checksums.',
      ],
    },
    verification: {
      mode: 'fail-closed-before-return',
      checks: [
        'stable-identities',
        'complete-content',
        'relationships',
        'device-epubs',
        'annotation-targets',
        'paginated-pdf',
        'checksums',
      ],
    },
    files: payloads.map((payload) => ({
      path: payload.path,
      mediaType: payload.mediaType,
      byteLength: payload.bytes.byteLength,
      sha256: sha256(payload.bytes),
    })),
    checksumFile: 'checksums.sha256',
  })
  const manifestFile = file(
    'export-manifest.json',
    'application/json',
    jsonBytes(exportManifest),
  )
  const checksums = [...payloads, manifestFile]
    .map((payload) => `${sha256(payload.bytes)}  ${payload.path}`)
    .join('\n')
  const checksumFile = file(
    'checksums.sha256',
    'text/plain; charset=utf-8',
    encoder.encode(`${checksums}\n`),
  )

  const exportPackage = {
    files: [...payloads, manifestFile, checksumFile],
  }
  await verifyExportPackage(exportPackage, paper, annotations, overrides)
  return exportPackage
}

export async function verifyExportPackage(
  exportPackage: ExportPackage,
  paper: ResearchPaper,
  expectedAnnotations: readonly TextAnnotation[],
  overrideInput: readonly TargetOverride[] = [],
) {
  const paths = exportPackage.files.map((candidate) => candidate.path)
  if (
    new Set(paths).size !== paths.length ||
    !sameValue(paths, EXPORT_PACKAGE_PATHS)
  ) {
    fail(
      'PACKAGE_FILE_SET_MISMATCH',
      `Expected ${EXPORT_PACKAGE_PATHS.join(', ')}, received ${paths.join(', ')}`,
    )
  }

  let source: ResearchPaper
  try {
    source = researchPaperSchema.parse(
      JSON.parse(
        decoder.decode(getExportFile(exportPackage, 'source.json').bytes),
      ),
    )
  } catch (error) {
    fail(
      'SOURCE_GRAPH_INVALID',
      error instanceof Error ? error.message : 'Source graph is invalid',
    )
  }
  const expectedNodeIds = paper.nodes.map((node) => node.id)
  if (
    !sameValue(
      source.nodes.map((node) => node.id),
      expectedNodeIds,
    )
  ) {
    fail(
      'SOURCE_NODE_IDS_MISMATCH',
      'The exported source graph does not contain every canonical node in order',
    )
  }
  if (canonicalContentHash(source) !== canonicalContentHash(paper)) {
    fail(
      'SOURCE_CONTENT_MISMATCH',
      'The exported source graph differs from canonical content',
    )
  }

  const overrides = validateTargetOverrides(overrideInput, paper)
  let layout
  try {
    layout = validateLayoutManifest(
      JSON.parse(
        decoder.decode(
          getExportFile(exportPackage, 'layout-manifest.json').bytes,
        ),
      ),
      paper,
      TARGET_PROFILE_IDS,
      overrides,
    )
  } catch (error) {
    if (error instanceof ManifestInvariantError) {
      throw new ExportVerificationError(error.issues)
    }
    fail(
      'LAYOUT_MANIFEST_INVALID',
      error instanceof Error ? error.message : 'Layout manifest is invalid',
    )
  }

  let annotations: TextAnnotation[]
  try {
    annotations = z
      .array(textAnnotationSchema)
      .parse(
        JSON.parse(
          decoder.decode(
            getExportFile(exportPackage, 'annotations.json').bytes,
          ),
        ),
      )
  } catch (error) {
    fail(
      'ANNOTATIONS_INVALID',
      error instanceof Error ? error.message : 'Annotations are invalid',
    )
  }
  for (const annotation of annotations) {
    const resolution = resolveTextAnchor(annotation.target, paper.nodes)
    if (resolution.status !== 'resolved') {
      fail(
        'ANNOTATION_TARGET_UNRESOLVED',
        `Annotation ${annotation.id} resolved as ${resolution.status}`,
      )
    }
  }
  if (!sameValue(annotations, expectedAnnotations)) {
    fail(
      'ANNOTATION_SET_MISMATCH',
      'The exported annotations differ from the requested annotations',
    )
  }

  const html = decoder.decode(
    getExportFile(exportPackage, 'reflowable.html').bytes,
  )
  if (!sameValue(canonicalIdsFromXhtml(html), expectedNodeIds)) {
    fail(
      'HTML_NODE_IDS_MISMATCH',
      'Reflowable HTML does not preserve every canonical node ID in order',
    )
  }
  verifyXhtmlContent(html, paper, 'HTML')
  verifyXhtmlRelationships(html, paper, 'HTML')

  const deviceConfigurations: Array<{
    artifact: 'publication-paperpro.epub' | 'publication-papermove.epub'
    profileId: 'paperPro' | 'paperProMove'
    profileVersion: string
    compositionPolicy: unknown
    exportPolicy: unknown
  }> = []
  const epubArtifacts: Array<{
    path:
      | 'publication.epub'
      | 'publication-paperpro.epub'
      | 'publication-papermove.epub'
    profile?: TargetProfile
  }> = [
    { path: 'publication.epub' },
    ...DEVICE_EPUB_TARGETS.map((target) => ({
      path: getTargetProfile(target).epub.fileName as
        | 'publication-paperpro.epub'
        | 'publication-papermove.epub',
      profile: getTargetProfile(target),
    })),
  ]
  for (const artifact of epubArtifacts) {
    let epubContent: string
    try {
      const epub = inspectEpub(
        getExportFile(exportPackage, artifact.path).bytes,
        artifact.profile,
      )
      epubContent = strFromU8(epub.files['EPUB/content.xhtml'])
      if (artifact.profile) {
        const embedded = epub.manifest as {
          profile?: {
            id: 'paperPro' | 'paperProMove'
            version: string
            compositionPolicy: unknown
            exportPolicy: unknown
          }
        }
        if (!embedded.profile) {
          fail(
            'EPUB_PROFILE_MISSING',
            `${artifact.path} has no embedded target profile`,
          )
        }
        deviceConfigurations.push({
          artifact: artifact.profile.epub.fileName as
            | 'publication-paperpro.epub'
            | 'publication-papermove.epub',
          profileId: embedded.profile.id,
          profileVersion: embedded.profile.version,
          compositionPolicy: embedded.profile.compositionPolicy,
          exportPolicy: embedded.profile.exportPolicy,
        })
      }
    } catch (error) {
      fail(
        'EPUB_INVALID',
        `${artifact.path}: ${error instanceof Error ? error.message : 'EPUB is invalid'}`,
      )
    }
    if (!sameValue(canonicalIdsFromXhtml(epubContent), expectedNodeIds)) {
      fail(
        'EPUB_NODE_IDS_MISMATCH',
        `${artifact.path} does not preserve every canonical node ID in order`,
      )
    }
    verifyXhtmlContent(epubContent, paper, 'EPUB')
    verifyXhtmlRelationships(epubContent, paper, 'EPUB')
  }

  const print = layout.renditions.find(
    (rendition) => rendition.target === 'print',
  )
  if (!print || print.pagination.finalPageCount === null) {
    fail(
      'PRINT_LAYOUT_MISSING',
      'Layout manifest has no finite print rendition',
    )
  }
  let pdfInspection
  let parsedPdf
  try {
    const pdfBytes = getExportFile(exportPackage, 'print.pdf').bytes
    pdfInspection = inspectPaginatedPdf(pdfBytes)
    parsedPdf = await inspectPdfContent(pdfBytes)
  } catch (error) {
    fail(
      'PDF_INVALID',
      error instanceof Error ? error.message : 'PDF is invalid',
    )
  }
  if (
    pdfInspection.pageCount !== print.pagination.finalPageCount ||
    pdfInspection.declaredPageCount !== print.pagination.finalPageCount ||
    parsedPdf.pageCount !== print.pagination.finalPageCount
  ) {
    fail(
      'PDF_PAGE_COUNT_MISMATCH',
      `PDF pages do not match layout page count ${print.pagination.finalPageCount}`,
    )
  }
  for (const id of expectedNodeIds) {
    if (!parsedPdf.text.includes(`[${id}]`)) {
      fail('PDF_NODE_ID_MISSING', `PDF does not expose canonical node ${id}`)
    }
  }
  verifyPdfContent(parsedPdf.text, paper)

  let exportManifest: z.infer<typeof exportManifestSchema>
  try {
    exportManifest = exportManifestSchema.parse(
      JSON.parse(
        decoder.decode(
          getExportFile(exportPackage, 'export-manifest.json').bytes,
        ),
      ),
    )
  } catch (error) {
    fail(
      'EXPORT_MANIFEST_INVALID',
      error instanceof Error ? error.message : 'Export manifest is invalid',
    )
  }
  if (
    exportManifest.document.id !== paper.id ||
    exportManifest.document.version !== paper.version ||
    exportManifest.document.contentHash !== canonicalContentHash(paper)
  ) {
    fail(
      'EXPORT_DOCUMENT_MISMATCH',
      'Export manifest document identity does not match canonical content',
    )
  }
  if (
    exportManifest.configuration.overrideDigest !==
      targetOverrideDigest(overrides) ||
    !sameValue(exportManifest.configuration.overrides, overrides) ||
    !sameValue(exportManifest.configuration.deviceEpubs, deviceConfigurations)
  ) {
    fail(
      'EXPORT_CONFIGURATION_MISMATCH',
      'Export manifest profile or override configuration does not match the request',
    )
  }

  const payloads = exportPackage.files.filter((candidate) =>
    PAYLOAD_PATHS.includes(candidate.path as (typeof PAYLOAD_PATHS)[number]),
  )
  if (
    !sameValue(
      exportManifest.files.map((metadata) => metadata.path),
      PAYLOAD_PATHS,
    )
  ) {
    fail(
      'EXPORT_FILE_SET_MISMATCH',
      'Export manifest does not describe every payload exactly once',
    )
  }
  for (const metadata of exportManifest.files) {
    const payload = payloads.find(
      (candidate) => candidate.path === metadata.path,
    )
    if (
      !payload ||
      payload.mediaType !== metadata.mediaType ||
      payload.bytes.byteLength !== metadata.byteLength ||
      sha256(payload.bytes) !== metadata.sha256
    ) {
      fail(
        'FILE_CHECKSUM_MISMATCH',
        `Export manifest metadata does not match ${metadata.path}`,
      )
    }
  }

  const manifestFile = getExportFile(exportPackage, 'export-manifest.json')
  const expectedChecksums = [...payloads, manifestFile]
    .map((payload) => `${sha256(payload.bytes)}  ${payload.path}`)
    .join('\n')
  const actualChecksums = decoder
    .decode(getExportFile(exportPackage, 'checksums.sha256').bytes)
    .trimEnd()
  if (actualChecksums !== expectedChecksums) {
    fail(
      'CHECKSUM_FILE_MISMATCH',
      'checksums.sha256 does not match the packaged files',
    )
  }

  return {
    status: 'passed' as const,
    checks: [
      'stable-identities',
      'complete-content',
      'relationships',
      'device-epubs',
      'annotation-targets',
      'paginated-pdf',
      'checksums',
    ] as const,
    files: EXPORT_PACKAGE_PATHS.length,
  }
}
