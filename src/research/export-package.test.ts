import { describe, expect, it } from 'vitest'
import {
  createDemoAnnotations,
  createSemanticTextAnchor,
  textAnnotationSchema,
} from './annotations'
import {
  buildExportPackage,
  EXPORT_PACKAGE_PATHS,
  ExportVerificationError,
  getExportFile,
  verifyExportPackage,
  type ExportPackage,
} from './export-package'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import rawLettersPaper from './papers/if-letters-home-could-sing.json'
import { inspectEpub } from './epub'
import { researchPaperSchema } from './schema'
import { getTargetProfile } from './targets'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const paper = researchPaperSchema.parse(rawPaper)
const paragraph = paper.nodes.find(
  (node) => node.id === 'p-proposition-1' && node.type === 'paragraph',
)
if (!paragraph || paragraph.type !== 'paragraph') {
  throw new Error('Export fixture lost p-proposition-1')
}
const quote =
  'Once meaning becomes coordinates, every new screen or sheet becomes a repair job.'
const annotations = [
  textAnnotationSchema.parse({
    id: 'export-highlight',
    kind: 'highlight',
    target: createSemanticTextAnchor(paragraph.id, paragraph.text, quote),
    appearance: { color: 'amber' },
    geometryCache: [],
  }),
]
const printOverride = {
  id: 'print-pipeline-emphasis',
  version: '1.0.0',
  target: 'print' as const,
  canonicalId: 'fig-pipeline',
  patch: { chosenVariant: 'full-span-emphasized' },
  provenance: {
    source: 'docs/issues/007-srt-target-overrides-and-exports.md',
    reason: 'Exercise one inspectable print-only presentation change.',
  },
}

function replaceFile(
  exportPackage: ExportPackage,
  path: string,
  replace: (bytes: Uint8Array) => Uint8Array,
): ExportPackage {
  return {
    files: exportPackage.files.map((file) =>
      file.path === path ? { ...file, bytes: replace(file.bytes) } : file,
    ),
  }
}

function verificationCodes(error: unknown) {
  if (!(error instanceof ExportVerificationError)) throw error
  return error.issues.map((issue) => issue.code)
}

describe('SRT export package', () => {
  it('exports every configured research paper with PDF text fidelity', async () => {
    const lettersPaper = researchPaperSchema.parse(rawLettersPaper)

    await expect(
      buildExportPackage(lettersPaper, createDemoAnnotations(lettersPaper)),
    ).resolves.toBeDefined()
  })

  it('builds deterministic print and reflowable artifacts with checksums', async () => {
    const first = await buildExportPackage(paper, annotations, [printOverride])
    const second = await buildExportPackage(paper, annotations, [printOverride])

    expect(first.files).toEqual(second.files)
    expect(first.files.map((file) => file.path)).toEqual(EXPORT_PACKAGE_PATHS)
    for (const target of ['paperPro', 'paperProMove'] as const) {
      const profile = getTargetProfile(target)
      const device = getExportFile(first, profile.epub.fileName)
      const inspection = inspectEpub(device.bytes, profile)
      expect(inspection.manifest).toMatchObject({
        profile: { id: target, version: profile.version },
      })
    }
    const pdf = decoder.decode(getExportFile(first, 'print.pdf').bytes)
    expect(pdf).toMatch(/^%PDF-1\.4/)
    expect(pdf).toContain(paper.subtitle)
    expect(pdf).toContain('Authors:')
    expect(pdf).toContain('Abstract')
    expect(pdf).toContain('Print presentation: full-span-emphasized')
    const html = decoder.decode(getExportFile(first, 'reflowable.html').bytes)
    expect(html).toContain(`data-canonical-id="${paragraph.id}"`)
    expect(html).toContain('<style type="text/css">')
    expect(html).not.toContain('href="styles.css"')
    expect(
      decoder.decode(getExportFile(first, 'checksums.sha256').bytes),
    ).toContain('  export-manifest.json')

    await expect(
      verifyExportPackage(first, paper, annotations, [printOverride]),
    ).resolves.toMatchObject({
      status: 'passed',
      checks: [
        'stable-identities',
        'complete-content',
        'relationships',
        'device-epubs',
        'annotation-targets',
        'paginated-pdf',
        'checksums',
      ],
    })
  })

  it('keeps the print override isolated while visibly changing the PDF', async () => {
    const baseline = await buildExportPackage(paper, annotations)
    const overridden = await buildExportPackage(paper, annotations, [
      printOverride,
    ])
    const baselinePdf = decoder.decode(
      getExportFile(baseline, 'print.pdf').bytes,
    )
    const overriddenPdf = decoder.decode(
      getExportFile(overridden, 'print.pdf').bytes,
    )

    expect(baselinePdf).not.toContain(
      'Print presentation: full-span-emphasized',
    )
    expect(overriddenPdf).toContain('Print presentation: full-span-emphasized')
    expect(getExportFile(baseline, 'reflowable.html').bytes).toEqual(
      getExportFile(overridden, 'reflowable.html').bytes,
    )
    expect(getExportFile(baseline, 'publication.epub').bytes).toEqual(
      getExportFile(overridden, 'publication.epub').bytes,
    )
    expect(getExportFile(baseline, 'publication-paperpro.epub').bytes).toEqual(
      getExportFile(overridden, 'publication-paperpro.epub').bytes,
    )
    expect(getExportFile(baseline, 'publication-papermove.epub').bytes).toEqual(
      getExportFile(overridden, 'publication-papermove.epub').bytes,
    )
    expect(getExportFile(baseline, 'source.json').bytes).toEqual(
      getExportFile(overridden, 'source.json').bytes,
    )
  })

  it('fails closed when canonical content or relationships are missing', async () => {
    const complete = await buildExportPackage(paper, annotations, [
      printOverride,
    ])
    const source = JSON.parse(
      decoder.decode(getExportFile(complete, 'source.json').bytes),
    )
    source.nodes.splice(1, 1)
    const missingNode = replaceFile(complete, 'source.json', () =>
      encoder.encode(`${JSON.stringify(source, null, 2)}\n`),
    )

    await expect(
      verifyExportPackage(missingNode, paper, annotations, [printOverride]),
    ).rejects.toSatisfy((error: unknown) =>
      verificationCodes(error).includes('SOURCE_NODE_IDS_MISMATCH'),
    )

    const layout = JSON.parse(
      decoder.decode(getExportFile(complete, 'layout-manifest.json').bytes),
    )
    const figure = layout.renditions[0].entries.find(
      (entry: { canonicalId: string }) => entry.canonicalId === 'fig-pipeline',
    )
    figure.relationships = {}
    const brokenRelationship = replaceFile(
      complete,
      'layout-manifest.json',
      () => encoder.encode(`${JSON.stringify(layout, null, 2)}\n`),
    )

    await expect(
      verifyExportPackage(brokenRelationship, paper, annotations, [
        printOverride,
      ]),
    ).rejects.toSatisfy((error: unknown) =>
      verificationCodes(error).includes('RELATIONSHIP_MISMATCH'),
    )
  })

  it('fails closed when reflowable rendition content is incomplete', async () => {
    const complete = await buildExportPackage(paper, annotations, [
      printOverride,
    ])
    const html = decoder.decode(
      getExportFile(complete, 'reflowable.html').bytes,
    )
    const incomplete = replaceFile(complete, 'reflowable.html', () =>
      encoder.encode(html.replace(quote, '[omitted]')),
    )

    await expect(
      verifyExportPackage(incomplete, paper, annotations, [printOverride]),
    ).rejects.toSatisfy((error: unknown) =>
      verificationCodes(error).includes('HTML_CONTENT_MISMATCH'),
    )
  })

  it('fails closed for unresolved annotation targets', async () => {
    const complete = await buildExportPackage(paper, annotations, [
      printOverride,
    ])
    const invalidAnnotations = structuredClone(annotations)
    invalidAnnotations[0].target.nodeId = 'missing-node'
    const broken = replaceFile(complete, 'annotations.json', () =>
      encoder.encode(`${JSON.stringify(invalidAnnotations, null, 2)}\n`),
    )

    await expect(
      verifyExportPackage(broken, paper, annotations, [printOverride]),
    ).rejects.toSatisfy((error: unknown) =>
      verificationCodes(error).includes('ANNOTATION_TARGET_UNRESOLVED'),
    )
  })

  it('detects altered checksums and PDF page counts', async () => {
    const complete = await buildExportPackage(paper, annotations, [
      printOverride,
    ])
    const checksumText = decoder.decode(
      getExportFile(complete, 'checksums.sha256').bytes,
    )
    const changedFirstCharacter = checksumText[0] === '0' ? '1' : '0'
    const alteredChecksums = replaceFile(complete, 'checksums.sha256', () =>
      encoder.encode(`${changedFirstCharacter}${checksumText.slice(1)}`),
    )

    await expect(
      verifyExportPackage(alteredChecksums, paper, annotations, [
        printOverride,
      ]),
    ).rejects.toSatisfy((error: unknown) =>
      verificationCodes(error).includes('CHECKSUM_FILE_MISMATCH'),
    )

    const pdfText = decoder.decode(getExportFile(complete, 'print.pdf').bytes)
    const alteredPdf = replaceFile(complete, 'print.pdf', () =>
      encoder.encode(
        pdfText.replace(
          /(\/Type \/Pages \/Count )\d+/,
          (_match, prefix: string) => `${prefix}99`,
        ),
      ),
    )

    await expect(
      verifyExportPackage(alteredPdf, paper, annotations, [printOverride]),
    ).rejects.toSatisfy((error: unknown) =>
      verificationCodes(error).includes('PDF_PAGE_COUNT_MISMATCH'),
    )
  })

  it('parses the PDF and fails closed for invalid structure or omitted text', async () => {
    const complete = await buildExportPackage(paper, annotations, [
      printOverride,
    ])
    const pdfText = decoder.decode(getExportFile(complete, 'print.pdf').bytes)
    const invalidPageTree = replaceFile(complete, 'print.pdf', () =>
      encoder.encode(pdfText.replace('/Pages 2 0 R', '/Pages 3 0 R')),
    )

    await expect(
      verifyExportPackage(invalidPageTree, paper, annotations, [printOverride]),
    ).rejects.toSatisfy((error: unknown) =>
      verificationCodes(error).includes('PDF_INVALID'),
    )

    const omittedSubtitle = replaceFile(complete, 'print.pdf', () =>
      encoder.encode(
        pdfText.replace(paper.subtitle, 'X'.repeat(paper.subtitle.length)),
      ),
    )

    await expect(
      verifyExportPackage(omittedSubtitle, paper, annotations, [printOverride]),
    ).rejects.toSatisfy((error: unknown) =>
      verificationCodes(error).includes('PDF_CONTENT_MISMATCH'),
    )
  })
})
