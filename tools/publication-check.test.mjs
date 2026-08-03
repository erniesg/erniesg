import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  assertPdfPageGeometry,
  assertPdfCropBox,
  assertPdfSearchableTextRequirements,
  accessibilityLabel,
  checkWebPubReceipt,
  normalizePdfSearchableText,
  orderPdfTextRequirements,
  parsePublicationCheckArgs,
  publicationPdfTextRequirements,
  validateWebPubGraph,
  verifyArtifactReceipt,
} from './publication-check.mjs'

describe('publication:check CLI', () => {
  it('requires the exact four-output matrix', () => {
    expect(
      parsePublicationCheckArgs([
        '--input',
        '.agent/evidence/publication',
        '--matrix',
        'phone-webpub,eink-epub,a5-pdf,a4-pdf',
      ]).matrix,
    ).toHaveLength(4)
    expect(() =>
      parsePublicationCheckArgs([
        '--input',
        'output',
        '--matrix',
        'phone-webpub,eink-epub',
      ]),
    ).toThrow(/exactly/)
  })

  it('validates every PDF page against the selected profile geometry', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([419.528, 595.276])
    pdf.addPage([300, 400])
    expect(() => assertPdfPageGeometry(pdf, 'fixture', 'A5')).toThrow(
      /page 2 geometry is not A5/,
    )
  })

  it('rejects crop boxes whose far edge exceeds the media box', () => {
    expect(() =>
      assertPdfCropBox(
        {
          getMediaBox: () => ({ x: 0, y: 0, width: 419.528, height: 595.276 }),
          getCropBox: () => ({ x: 1, y: 1, width: 418, height: 594 }),
        },
        'fixture',
      ),
    ).not.toThrow()
    expect(() =>
      assertPdfCropBox(
        {
          getMediaBox: () => ({ x: 0, y: 0, width: 419.528, height: 595.276 }),
          getCropBox: () => ({ x: 1, y: 1, width: 419, height: 596 }),
        },
        'fixture',
      ),
    ).toThrow(/crop box outside/)
  })

  it('requires searchable text for the graph body, not only its title', () => {
    const graph = {
      metadata: {
        title: 'Publication title',
        abstract: 'Publication abstract',
        contributors: ['Author'],
      },
      nodes: [
        { type: 'paragraph', text: 'Body proof' },
        { type: 'code', code: 'const proof = true' },
        {
          type: 'table',
          rows: [{ cells: [{ text: 'Cell proof' }] }],
        },
      ],
    }
    expect(publicationPdfTextRequirements(graph)).toEqual(
      expect.arrayContaining([
        'Publication title',
        'Publication abstract',
        'Body proof',
        'const proof = true',
        'Cell proof',
      ]),
    )
    expect(normalizePdfSearchableText('Café proof')).toBe('cafeproof')
    expect(() =>
      assertPdfSearchableTextRequirements('publicationtitlebodyproof', [
        'Publication title',
        'Body proof',
      ]),
    ).not.toThrow()
    expect(() =>
      assertPdfSearchableTextRequirements('publicationtitle', [
        'Publication title',
        'Body proof',
      ]),
    ).toThrow(/Body proof/)
    expect(
      orderPdfTextRequirements(
        ['child item', 'parent item'],
        'parent item child item',
      ),
    ).toEqual(['parent item', 'child item'])
  })

  it('chooses the first non-empty accessibility alternative', () => {
    expect(
      accessibilityLabel({
        accessibility: {
          alternativeText: '',
          longDescription: 'Diagram description',
          transcript: 'Transcript',
        },
      }),
    ).toBe('Diagram description')
  })

  it('fails closed when an EPUB or PDF no longer matches its receipt bytes', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-receipt-'))
    try {
      const bytes = Buffer.from('exact publication artifact')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const artifact = {
        profile: 'eink-epub',
        sha256,
        byteLength: bytes.byteLength,
      }
      await writeFile(resolve(root, 'eink.epub'), bytes)
      await expect(
        verifyArtifactReceipt(root, artifact, 'eink.epub'),
      ).resolves.toEqual(new Uint8Array(bytes))
      await writeFile(
        resolve(root, 'eink.epub'),
        Buffer.alloc(bytes.length, 0x58),
      )
      await expect(
        verifyArtifactReceipt(root, artifact, 'eink.epub'),
      ).rejects.toThrow(/hash changed/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an unlisted WebPub file even when listed files still match', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-webpub-receipt-'))
    try {
      const webpub = resolve(root, 'phone-webpub')
      await mkdir(webpub, { recursive: true })
      const listed = Buffer.from('<main>ok</main>')
      const extra = Buffer.from('unexpected')
      const digest = (value) => createHash('sha256').update(value).digest('hex')
      await writeFile(resolve(webpub, 'index.html'), listed)
      await writeFile(resolve(webpub, 'extra.txt'), extra)
      const artifact = {
        profile: 'phone-webpub',
        sha256: digest(
          JSON.stringify([
            {
              path: 'index.html',
              sha256: digest(listed),
              byteLength: listed.byteLength,
            },
          ]),
        ),
        byteLength: listed.byteLength,
        files: [
          {
            path: 'index.html',
            sha256: digest(listed),
            byteLength: listed.byteLength,
          },
        ],
      }
      await expect(checkWebPubReceipt(root, artifact)).rejects.toThrow(
        /file set|unlisted|manifest/i,
      )
    } catch {
      throw new Error('WebPub receipt regression setup failed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('checks media kinds independently and preserves source figure fallbacks', () => {
    const common = {
      accessibility: { decorative: false },
    }
    const graph = {
      edition: { locale: 'en' },
      nodes: [
        { ...common, id: 'heading', type: 'heading', level: 1, text: 'Title' },
        {
          ...common,
          id: 'source-figure',
          type: 'figure',
          assetIds: [],
          sourceText: 'source fallback',
          accessibility: { decorative: false, longDescription: 'Diagram' },
        },
        {
          ...common,
          id: 'audio',
          type: 'media',
          mediaKind: 'audio',
          assetId: 'audio-asset',
          accessibility: { decorative: false, transcript: 'Audio transcript' },
        },
      ],
    }
    const html =
      '<html lang="en"><body><header><h1 id="heading">Title</h1></header><main>' +
      '<figure id="source-figure"><pre id="source-figure-source" class="figure-source">source fallback</pre></figure>' +
      '<figure id="audio"><audio aria-label="Audio transcript"></audio></figure>' +
      '</main></body></html>'
    expect(() => validateWebPubGraph(graph, html)).not.toThrow()
  })
})
