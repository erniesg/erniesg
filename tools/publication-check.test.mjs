import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  assertPdfPageGeometry,
  assertPdfCropBox,
  assertPdfImageCount,
  assertPdfLinkAnnotations,
  assertPdfSearchableTextRequirements,
  assertPdfTextItemGeometry,
  assertPdfWidowOrphanRequirements,
  accessibilityLabel,
  checkWebPubReceipt,
  normalizePdfSearchableText,
  normalizePdfVerificationText,
  orderPdfTextRequirements,
  publicationPdfLinkRequirements,
  publicationPdfLinkRequirementsForProfile,
  parsePublicationCheckArgs,
  publicationPdfTextRequirements,
  pdfAnnotationTarget,
  validatePublicationGraphContent,
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
    expect(normalizePdfVerificationText('x + y = z')).toBe('x+y=z')
    expect(() =>
      assertPdfSearchableTextRequirements('x y z', ['x + y = z']),
    ).toThrow(/x \+ y = z/)
    expect(() =>
      assertPdfSearchableTextRequirements('x + y = z', ['x + y = z']),
    ).not.toThrow()
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
    expect(
      orderPdfTextRequirements(
        ['Why Astro?', 'Unlimited Bandwidth'],
        'An earlier paragraph mentions unlimited bandwidth. Why Astro? Unlimited Bandwidth',
      ),
    ).toEqual(['Why Astro?', 'Unlimited Bandwidth'])
    expect(
      orderPdfTextRequirements(
        ['After punctuation', 'Hard\nBreak'],
        'HardBreak. Earlier punctuation! After punctuation',
      ),
    ).toEqual(['Hard\nBreak', 'After punctuation'])
    expect(
      orderPdfTextRequirements(
        ['After punctuation', 'Hard\nBreak'],
        `${'!'.repeat(40)}After punctuation HardBreak`,
      ),
    ).toEqual(['After punctuation', 'Hard\nBreak'])
    expect(
      orderPdfTextRequirements(
        ['A\nB', 'X'],
        'a b c d e f g h i j AB X',
      ),
    ).toEqual(['A\nB', 'X'])
    expect(
      orderPdfTextRequirements(['𠀀\nA', 'X'], '𠀀A X'),
    ).toEqual(['𠀀\nA', 'X'])
    expect(orderPdfTextRequirements(['A', '𠀀'], '𠀀 A')).toEqual(['𠀀', 'A'])
  })

  it('rejects PDF text outside the visible crop and requires every image asset', () => {
    const crop = { x: 0, y: 0, width: 100, height: 100 }
    expect(() =>
      assertPdfTextItemGeometry(
        { str: 'inside', transform: [10, 0, 0, 10, 20, 20], width: 20, height: 10 },
        crop,
        'fixture',
      ),
    ).not.toThrow()
    expect(() =>
      assertPdfTextItemGeometry(
        { str: 'outside', transform: [10, 0, 0, 10, 95, 20], width: 20, height: 10 },
        crop,
        'fixture',
      ),
    ).toThrow(/outside visible page bounds/)
    expect(() => assertPdfImageCount('/Subtype /Image\n/Subtype /Image', 2, 'fixture')).not.toThrow()
    expect(() => assertPdfImageCount('/Subtype /Image', 2, 'fixture')).toThrow(
      /requires 2 image assets/,
    )
  })

  it('enforces widow and orphan line minimums for text spanning pages', () => {
    const completeLocations = [
      { page: 1, line: 1 },
      { page: 1, line: 2 },
      { page: 1, line: 3 },
      { page: 2, line: 1 },
      { page: 2, line: 2 },
      { page: 2, line: 3 },
    ]
    expect(() =>
      assertPdfWidowOrphanRequirements('abcdef', completeLocations, ['abcdef']),
    ).not.toThrow()
    expect(() =>
      assertPdfWidowOrphanRequirements(
        'abcdef',
        completeLocations.map((location, index) =>
          index < 3 ? location : { page: 2, line: 1 },
        ),
        ['abcdef'],
      ),
    ).toThrow(/widow\/orphan/)
  })

  it('follows rendered PDF order when nested list text is flattened', () => {
    const searchableText = 'parentitemchilditem'
    const locations = [...searchableText].map(() => ({ page: 1, line: 1 }))
    expect(() =>
      assertPdfWidowOrphanRequirements(
        searchableText,
        locations,
        ['child item', 'parent item'],
      ),
    ).not.toThrow()
  })

  it('requires every authored link to have a matching PDF annotation', () => {
    const graph = {
      nodes: [
        {
          inlineRuns: [{ href: 'https://example.com/' }],
        },
        { type: 'reference', href: '#target' },
      ],
    }
    const required = publicationPdfLinkRequirements(graph)
    expect(required).toEqual(['https://example.com/', '#target'])
    expect(() =>
      assertPdfLinkAnnotations(
        [{ target: 'https://example.com/' }, { target: '#target' }],
        required,
      ),
    ).not.toThrow()
    expect(() =>
      assertPdfLinkAnnotations([{ target: 'https://example.com/' }], required),
    ).toThrow(/requires 2/)
    expect(() =>
      assertPdfLinkAnnotations(
        [{ target: 'https://other.example/' }, { target: '#other' }],
        required,
      ),
    ).toThrow(/missing.*https:\/\/example\.com/)
    expect(pdfAnnotationTarget({ dest: 'target' })).toBe('#target')
    expect(pdfAnnotationTarget({ dest: ['target', { name: 'XYZ' }] })).toBe(
      '#target',
    )
    expect(() =>
      assertPdfLinkAnnotations([{ dest: 'target' }], ['#target']),
    ).not.toThrow()
  })

  it('requires target-only cross-references in PDF link requirements', () => {
    const graph = {
      nodes: [
        {
          inlineRuns: [
            {
              semanticRole: 'cross-reference',
              targetIds: ['target'],
            },
          ],
        },
      ],
    }
    expect(publicationPdfLinkRequirementsForProfile(graph, 'a5-pdf')).toEqual([
      '#target',
    ])
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

  it('accepts decorative audio without a textual accessibility label', () => {
    const graph = {
      edition: { locale: 'en' },
      nodes: [
        { id: 'heading', type: 'heading', level: 1, text: 'Title' },
        {
          id: 'decorative-audio',
          type: 'media',
          mediaKind: 'audio',
          assetId: 'audio-asset',
          accessibility: { decorative: true },
        },
      ],
    }
    const html =
      '<html lang="en"><body><h1 id="heading">Title</h1><main>' +
      '<figure id="decorative-audio"><audio aria-hidden="true"></audio></figure>' +
      '</main></body></html>'
    expect(() => validateWebPubGraph(graph, html)).not.toThrow()
  })

  it('requires figure titles in WebPub and PDF content requirements', () => {
    const graph = {
      edition: { locale: 'en', direction: 'ltr' },
      metadata: { title: 'Title', contributors: [] },
      nodes: [
        { id: 'heading', type: 'heading', level: 1, text: 'Title' },
        {
          id: 'figure',
          type: 'figure',
          title: 'Figure title',
          assetIds: [],
          sourceText: 'source fallback',
          accessibility: { decorative: false, longDescription: 'Diagram' },
        },
      ],
    }
    expect(publicationPdfTextRequirements(graph, 'a5-pdf')).toEqual(
      expect.arrayContaining(['Figure title', 'source fallback']),
    )
    const html =
      '<html lang="en"><body><h1 id="heading">Title</h1><main>' +
      '<figure id="figure"><pre id="figure-source" class="figure-source">source fallback</pre></figure>' +
      '</main></body></html>'
    expect(() => validateWebPubGraph(graph, html)).toThrow(
      /required node (?:content )?figure/,
    )
  })

  it('keeps profile-selected text and links distinct and preserves duplicate requirements', () => {
    const graph = {
      metadata: {
        title: 'Title',
        contributors: [],
      },
      nodes: [
        {
          id: 'body',
          type: 'paragraph',
          text: 'canonical text',
          variants: [
            { kind: 'compact', text: 'compact text', reviewed: true },
          ],
          inlineRuns: [{ href: '#canonical' }],
        },
        { id: 'duplicate', type: 'paragraph', text: 'repeat' },
        { id: 'duplicate-2', type: 'paragraph', text: 'repeat' },
      ],
    }
    expect(publicationPdfTextRequirements(graph, 'a5-pdf')).toEqual(
      expect.arrayContaining(['compact text', 'repeat', 'repeat']),
    )
    expect(publicationPdfTextRequirements(graph, 'a5-pdf')).not.toContain(
      'canonical text',
    )
    expect(publicationPdfLinkRequirementsForProfile(graph, 'a5-pdf')).toEqual(
      [],
    )
    expect(
      publicationPdfLinkRequirementsForProfile(graph, 'phone-webpub'),
    ).toEqual(['#canonical'])
  })

  it('does not count the metadata title and document H1 as separate PDF body requirements', () => {
    const graph = {
      metadata: { title: 'Title', contributors: [] },
      nodes: [
        { id: 'title', type: 'heading', level: 1, text: 'Title' },
        { id: 'title-2', type: 'heading', level: 1, text: 'Title' },
        { id: 'body', type: 'paragraph', text: 'Body text' },
        { id: 'repeat-a', type: 'paragraph', text: 'repeat' },
        { id: 'repeat-b', type: 'paragraph', text: 'repeat' },
      ],
    }
    expect(publicationPdfTextRequirements(graph, 'a5-pdf')).toEqual([
      'Title',
      'Title',
      'Body text',
      'repeat',
      'repeat',
    ])
  })

  it('omits intentionally hidden decorative transcripts from PDF requirements', () => {
    const graph = {
      metadata: { title: 'Title', contributors: [] },
      nodes: [
        {
          id: 'decorative-audio',
          type: 'media',
          mediaKind: 'audio',
          accessibility: {
            decorative: true,
            transcript: 'Hidden decorative transcript',
          },
        },
      ],
    }
    expect(publicationPdfTextRequirements(graph, 'a5-pdf')).toEqual(['Title'])
  })

  it('rejects a required body node dropped from a WebPub or EPUB profile', () => {
    const graph = {
      edition: { locale: 'en', direction: 'ltr' },
      metadata: { title: 'Title', contributors: [] },
      nodes: [
        { id: 'heading', type: 'heading', level: 1, text: 'Heading' },
        { id: 'body', type: 'paragraph', text: 'Required body' },
      ],
    }
    const html =
      '<html lang="en"><body><header><h1>Title</h1></header><main><h1 id="heading">Heading</h1></main></body></html>'
    expect(() => validatePublicationGraphContent(graph, html)).toThrow(
      /required node body/,
    )
  })

  it('rejects a reordered required node sequence', () => {
    const graph = {
      edition: { locale: 'en', direction: 'ltr' },
      metadata: { title: 'Title', contributors: [] },
      nodes: [
        { id: 'first', type: 'heading', level: 1, text: 'First' },
        { id: 'second', type: 'paragraph', text: 'Second' },
      ],
    }
    const html =
      '<html lang="en"><body><main><p id="second">Second</p><h1 id="first">First</h1></main></body></html>'
    expect(() => validatePublicationGraphContent(graph, html)).toThrow(
      /changed required node order/,
    )
  })

  it('accepts owned captions and nested lists in their rendered order', () => {
    const graph = {
      nodes: [
        { id: 'list', type: 'list', ordered: false, itemIds: ['item'] },
        {
          id: 'item',
          type: 'list-item',
          parentListId: 'list',
          childListIds: ['nested-list'],
          text: 'Parent item',
        },
        {
          id: 'nested-list',
          type: 'list',
          ordered: false,
          itemIds: ['nested-item'],
        },
        {
          id: 'nested-item',
          type: 'list-item',
          parentListId: 'nested-list',
          childListIds: [],
          text: 'Nested item',
        },
        {
          id: 'figure',
          type: 'figure',
          title: 'Figure title',
          assetIds: [],
          sourceText: 'Figure source',
          captionId: 'figure-caption',
        },
        {
          id: 'figure-caption',
          type: 'caption',
          parentId: 'figure',
          text: 'Figure caption',
        },
      ],
    }
    const html =
      '<main><ul id="list"><li id="item">Parent item<ul id="nested-list"><li id="nested-item">Nested item</li></ul></li></ul>' +
      '<figure id="figure"><div>Figure title</div><pre>Figure source</pre><figcaption id="figure-caption">Figure caption</figcaption></figure></main>'
    expect(() =>
      validatePublicationGraphContent(graph, html, 'a5-pdf'),
    ).not.toThrow()
  })

  it('binds each image to its owning node and asset path', () => {
    const graph = {
      nodes: [
        {
          id: 'first-image',
          type: 'media',
          mediaKind: 'image',
          assetId: 'first-asset',
          accessibility: { alternativeText: 'First image', decorative: false },
        },
        {
          id: 'second-image',
          type: 'media',
          mediaKind: 'image',
          assetId: 'second-asset',
          accessibility: { alternativeText: 'Second image', decorative: false },
        },
      ],
    }
    const swapped =
      '<main><figure id="first-image"><img src="assets/second.png" alt="First image"></figure>' +
      '<figure id="second-image"><img src="assets/first.png" alt="Second image"></figure></main>'
    const assetPaths = new Map([
      ['first-asset', 'assets/first.png'],
      ['second-asset', 'assets/second.png'],
    ])
    expect(() =>
      validatePublicationGraphContent(
        graph,
        swapped,
        'phone-webpub',
        assetPaths,
      ),
    ).toThrow(/changed image asset first-asset/)
  })

  it('checks required media assets in the reflowable EPUB profile', () => {
    const graph = {
      edition: { locale: 'en', direction: 'ltr' },
      metadata: { title: 'Title', contributors: [] },
      nodes: [
        { id: 'heading', type: 'heading', level: 1, text: 'Title' },
        {
          id: 'diagram',
          type: 'media',
          mediaKind: 'image',
          assetId: 'diagram-asset',
          accessibility: { alternativeText: 'Diagram', decorative: false },
        },
      ],
    }
    const html =
      '<html lang="en"><body><main><h1 id="heading">Title</h1><figure id="diagram"></figure></main></body></html>'
    expect(() =>
      validatePublicationGraphContent(graph, html, 'eink-epub'),
    ).toThrow(/eink-epub media diagram dropped image asset/)
  })

  it('binds non-image EPUB media elements to their owning nodes', () => {
    const cases = [
      {
        kind: 'audio',
        nodeId: 'audio-media',
        accessibility: { transcript: 'Audio transcript', decorative: false },
        element: '<audio controls="controls" aria-label="Audio transcript"></audio>',
      },
      {
        kind: 'video',
        nodeId: 'video-media',
        accessibility: { alternativeText: 'Video alternative', decorative: false },
        element: '<video controls="controls" aria-label="Video alternative"></video>',
      },
      {
        kind: 'interactive',
        nodeId: 'interactive-media',
        accessibility: {
          alternativeText: 'Interactive alternative',
          decorative: false,
        },
        element:
          '<a href="https://example.com/interactive" aria-label="Interactive alternative">Interactive alternative</a>',
      },
    ]
    for (const { kind, nodeId, accessibility, element } of cases) {
      const graph = {
        nodes: [
          {
            id: nodeId,
            type: 'media',
            mediaKind: kind,
            assetId: `${kind}-asset`,
            accessibility,
          },
        ],
      }
      const owned = `<main><figure id="${nodeId}">${element}</figure><figure id="other-${kind}"></figure></main>`
      const misplaced = `<main><figure id="${nodeId}"></figure><figure id="other-${kind}">${element}</figure></main>`

      expect(() =>
        validatePublicationGraphContent(graph, owned, 'eink-epub'),
      ).not.toThrow()
      expect(() =>
        validatePublicationGraphContent(graph, misplaced, 'eink-epub'),
      ).toThrow(`eink-epub dropped ${kind} media for ${nodeId}`)
    }
  })
})
