import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { XMLValidator } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import {
  buildEpub,
  buildReadableEpub,
  inspectEpub,
  renderPublicationXhtml,
} from './epub'
import type {
  PdfPageAnalysis,
  PdfReconstruction,
  PdfSourceRun,
  PublicationAsset,
  PublicationVisualRelationship,
} from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { assessPdfCompleteness } from './pdf-quality'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import { researchPaperSchema } from './schema'
import { getTargetProfile } from './targets'
import { createSourcePageCropAsset } from './visual-assets'

const paper = researchPaperSchema.parse(rawPaper)

function rezipEpub(files: Record<string, Uint8Array>) {
  return zipSync({
    mimetype: [files.mimetype, { level: 0 }],
    ...Object.fromEntries(
      Object.entries(files)
        .filter(([name]) => name !== 'mimetype')
        .map(([name, bytes]) => [name, [bytes, { level: 6 }]]),
    ),
  })
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

describe('EPUB 3 export', () => {
  it('renders emphasis, vertical alignment, and safe links as semantic XHTML', () => {
    const inlinePaper = structuredClone(paper)
    const value = 'emphasis raised lowered https://example.test/evidence'
    const range = (expected: string) => ({
      start: value.indexOf(expected),
      end: value.indexOf(expected) + expected.length,
    })
    inlinePaper.nodes = [
      {
        id: 'synthetic-inline-node',
        type: 'paragraph',
        text: value,
        inlineRuns: [
          { ...range('emphasis'), italic: true },
          { ...range('raised'), verticalAlign: 'superscript' },
          { ...range('lowered'), verticalAlign: 'subscript' },
          {
            ...range('https://example.test/evidence'),
            href: 'https://example.test/evidence',
          },
        ],
        source: 'synthetic-inline-test',
      },
    ]

    const content = renderPublicationXhtml(inlinePaper)

    expect(content).toContain('<em>emphasis</em>')
    expect(content).toContain('<sup>raised</sup>')
    expect(content).toContain('<sub>lowered</sub>')
    expect(content).toContain(
      '<a href="https://example.test/evidence">https://example.test/evidence</a>',
    )
  })

  it('preserves inline mathematical styling in complete figure captions', () => {
    const captionPaper = structuredClone(paper)
    const captionText = 'Figure 1. Terms h2 and R2 remain semantic.'
    const hStart = captionText.indexOf('h2')
    const rStart = captionText.indexOf('R2')
    captionPaper.nodes = [
      {
        id: 'styled-caption-figure',
        type: 'figure',
        objectType: 'figure',
        title: captionText,
        relationships: { caption: 'styled-caption' },
        source: 'synthetic-caption-style',
      },
      {
        id: 'styled-caption',
        type: 'caption',
        text: captionText,
        inlineRuns: [
          { start: hStart, end: hStart + 1, italic: true },
          {
            start: hStart + 1,
            end: hStart + 2,
            verticalAlign: 'subscript',
          },
          {
            start: rStart + 1,
            end: rStart + 2,
            verticalAlign: 'superscript',
          },
        ],
        source: 'synthetic-caption-style',
      },
    ]

    const content = renderPublicationXhtml(captionPaper)

    expect(content).toContain(
      '<figcaption id="styled-caption" data-canonical-id="styled-caption">Figure 1. Terms <em>h</em><sub>2</sub> and R<sup>2</sup> remain semantic.</figcaption>',
    )
  })

  it('percent-encodes RFC-unwise external-link characters for EPUB readers', async () => {
    const linkPaper = structuredClone(paper)
    const value = 'Open the reviewed paper.'
    linkPaper.nodes = [
      {
        id: 'encoded-external-link',
        type: 'paragraph',
        text: value,
        inlineRuns: [
          {
            start: 0,
            end: 23,
            href: 'https://example.test/forum?referrer=%5Bprofile%5D(%2Fid%3D{~}Author1)',
          },
        ],
        source: 'synthetic-rfc-unwise-link',
      },
    ]

    const content = renderPublicationXhtml(linkPaper)
    expect(content).toContain(
      'href="https://example.test/forum?referrer=%5Bprofile%5D(%2Fid%3D%7B~%7DAuthor1)"',
    )
    expect(content).not.toContain('{~}')
    const epub = await buildEpub(linkPaper)
    expect(() => inspectEpub(epub.bytes)).not.toThrow()
  })

  it('renders malformed external-link text without an invalid XHTML href', () => {
    const inlinePaper = structuredClone(paper)
    const value = 'Malformed link text remains readable.'
    inlinePaper.nodes = [
      {
        id: 'synthetic-malformed-link-node',
        type: 'paragraph',
        text: value,
        inlineRuns: [
          {
            start: 0,
            end: value.length,
            href: String.raw`https://example.test/archive\n\nor`,
          },
        ],
        source: 'synthetic-malformed-link-test',
      },
    ]

    const content = renderPublicationXhtml(inlinePaper)

    expect(content).toContain(value)
    expect(content).not.toContain('<a href=')
    expect(content).not.toContain(String.raw`archive\n\nor`)
  })

  it('composes every active overlapping inline annotation', () => {
    const inlinePaper = structuredClone(paper)
    inlinePaper.nodes = [
      {
        id: 'overlapping-inline-node',
        type: 'paragraph',
        text: 'linked emphasis',
        inlineRuns: [
          { start: 0, end: 15, italic: true },
          { start: 7, end: 15, bold: true },
          { start: 0, end: 6, href: 'https://example.test/linked' },
        ],
        source: 'synthetic-inline-overlap',
      },
    ]

    const content = renderPublicationXhtml(inlinePaper)

    expect(content).toContain(
      '<a href="https://example.test/linked"><em>linked</em></a><em> </em><strong><em>emphasis</em></strong>',
    )
  })

  it('preserves a zero-target semantic relationship under a fully overlapping external link', () => {
    const inlinePaper = structuredClone(paper)
    const value = 'https://example.test/reference'
    inlinePaper.nodes = [
      {
        id: 'linked-bibliography-entry',
        type: 'paragraph',
        text: value,
        inlineRuns: [
          { start: 0, end: value.length, href: value },
          {
            start: 0,
            end: value.length,
            relationshipId: 'bibliography-entry-1',
            semanticRole: 'bibliography-entry',
          },
        ],
        source: 'synthetic-overlapping-relationship',
      },
    ]

    const content = renderPublicationXhtml(inlinePaper)

    expect(content).toContain(
      '<span id="bibliography-entry-1" data-semantic-role="bibliography-entry" data-relationship-id="bibliography-entry-1"><a href="https://example.test/reference">https://example.test/reference</a></span>',
    )
  })

  it('nests ordered and unordered list levels without changing surrounding node order', () => {
    const listPaper = structuredClone(paper)
    listPaper.nodes = [
      {
        id: 'before-list',
        type: 'paragraph',
        text: 'Before list.',
        source: 'synthetic-list-test',
      },
      {
        id: 'ordered-root',
        type: 'paragraph',
        text: 'Ordered root',
        list: { level: 1, ordered: true, numberingId: 'outline' },
        source: 'synthetic-list-test',
      },
      {
        id: 'unordered-child',
        type: 'paragraph',
        text: 'Unordered child',
        list: { level: 2, ordered: false, numberingId: 'outline' },
        source: 'synthetic-list-test',
      },
      {
        id: 'ordered-child',
        type: 'paragraph',
        text: 'Ordered child',
        list: { level: 2, ordered: true, numberingId: 'outline' },
        source: 'synthetic-list-test',
      },
      {
        id: 'ordered-peer',
        type: 'paragraph',
        text: 'Ordered peer',
        list: { level: 1, ordered: true, numberingId: 'outline' },
        source: 'synthetic-list-test',
      },
      {
        id: 'after-list',
        type: 'paragraph',
        text: 'After list.',
        source: 'synthetic-list-test',
      },
    ]

    const content = renderPublicationXhtml(listPaper)

    expect(content).toContain(
      '<ol class="publication-list" data-list-level="1" data-numbering-id="outline" data-marker-style="decimal"><li id="ordered-root" data-canonical-id="ordered-root" class="publication-list-item" data-list-level="1">Ordered root<ul class="publication-list" data-list-level="2" data-numbering-id="outline" data-marker-style="disc"><li id="unordered-child" data-canonical-id="unordered-child" class="publication-list-item" data-list-level="2">Unordered child</li></ul><ol class="publication-list" data-list-level="2" data-numbering-id="outline" data-marker-style="decimal"><li id="ordered-child" data-canonical-id="ordered-child" class="publication-list-item" data-list-level="2">Ordered child</li></ol></li><li id="ordered-peer" data-canonical-id="ordered-peer" class="publication-list-item" data-list-level="1">Ordered peer</li></ol>',
    )
    expect(content.indexOf('id="before-list"')).toBeLessThan(
      content.indexOf('id="ordered-root"'),
    )
    expect(content.indexOf('id="ordered-peer"')).toBeLessThan(
      content.indexOf('id="after-list"'),
    )
  })

  it('starts a new list when the numbering sequence changes', () => {
    const listPaper = structuredClone(paper)
    listPaper.nodes = [
      {
        id: 'sequence-a-one',
        type: 'paragraph',
        text: 'Sequence A one',
        list: { level: 1, ordered: true, numberingId: 'sequence-a' },
        source: 'synthetic-list-test',
      },
      {
        id: 'sequence-a-two',
        type: 'paragraph',
        text: 'Sequence A two',
        list: { level: 1, ordered: true, numberingId: 'sequence-a' },
        source: 'synthetic-list-test',
      },
      {
        id: 'sequence-b-one',
        type: 'paragraph',
        text: 'Sequence B one',
        list: { level: 1, ordered: true, numberingId: 'sequence-b' },
        source: 'synthetic-list-test',
      },
    ]

    const content = renderPublicationXhtml(listPaper)

    expect(content.match(/<ol class="publication-list"/g)).toHaveLength(2)
    expect(content).toContain(
      'Sequence A two</li></ol>\n<ol class="publication-list" data-list-level="1" data-numbering-id="sequence-b" data-marker-style="decimal">',
    )
  })

  it('preserves inline formatting, links, and note references inside list items', () => {
    const listPaper = structuredClone(paper)
    const value = 'Bold 1 link'
    listPaper.nodes = [
      {
        id: 'inline-list-item',
        type: 'paragraph',
        text: value,
        list: { level: 1, ordered: false, numberingId: 'inline-list' },
        inlineRuns: [
          { start: 0, end: 4, bold: true },
          { start: 5, end: 6, verticalAlign: 'superscript' },
          { start: 7, end: 11, href: 'https://example.test/list' },
        ],
        noteReferences: [
          {
            id: 'inline-note-reference',
            label: '1',
            target: 'inline-note',
            start: 5,
            end: 6,
            confidence: 1,
          },
        ],
        source: 'synthetic-list-test',
      },
      {
        id: 'inline-note',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        text: 'Inline list note.',
        relationships: { backlinks: ['inline-note-reference'] },
        source: 'synthetic-list-test',
      },
    ]

    const content = renderPublicationXhtml(listPaper)

    expect(content).toContain(
      '<li id="inline-list-item" data-canonical-id="inline-list-item" class="publication-list-item" data-list-level="1"><strong>Bold</strong> <a id="inline-note-reference" href="#inline-note" epub:type="noteref"><sup>1</sup></a> <a href="https://example.test/list">link</a></li>',
    )
  })

  it('links canonical citation spans to their bibliography targets', () => {
    const citationPaper = structuredClone(paper)
    citationPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [1].',
        inlineRuns: [
          {
            start: 11,
            end: 14,
            relationshipId: 'citation-1',
            semanticRole: 'citation',
            targetIds: ['reference-1'],
          },
        ],
        source: 'synthetic-citation-test',
      },
      {
        id: 'reference-1',
        type: 'paragraph',
        text: '[1] Reference entry.',
        list: { level: 1, ordered: true, numberingId: 'references' },
        source: 'synthetic-citation-test',
      },
    ]

    const content = renderPublicationXhtml(citationPaper)

    expect(content).toContain(
      '<a id="citation-1" href="#reference-1" epub:type="biblioref" data-relationship-id="citation-1">[1]</a>',
    )
  })

  it('renders every target in a citation range as a navigable biblioref', () => {
    const citationPaper = structuredClone(paper)
    citationPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [1–3].',
        inlineRuns: [
          {
            start: 11,
            end: 16,
            relationshipId: 'citation-range',
            semanticRole: 'citation',
            targetIds: ['reference-1', 'reference-2', 'reference-3'],
          },
          { start: 12, end: 15, italic: true },
        ],
        source: 'synthetic-citation-range',
      },
      ...[1, 2, 3].map((ordinal) => ({
        id: `reference-${ordinal}`,
        type: 'paragraph' as const,
        text: `Reference ${ordinal}.`,
        list: {
          level: 1,
          ordered: true,
          numberingId: 'references',
          markerStyle: 'decimal' as const,
          ordinal,
          markerText: `[${ordinal}]`,
        },
        source: 'synthetic-citation-range',
      })),
    ]

    const content = renderPublicationXhtml(citationPaper)

    for (const ordinal of [1, 2, 3]) {
      expect(content).toContain(`href="#reference-${ordinal}"`)
    }
    expect(content.match(/\sid="citation-range"/g)).toHaveLength(1)
    expect(content).toContain('<em>1–3</em>')
  })

  it('emits one note-reference id when inline styling splits the marker', () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Claim 12.',
        noteReferences: [
          {
            id: 'note-reference-12',
            label: '12',
            target: 'note-12',
            start: 6,
            end: 8,
            confidence: 1,
          },
        ],
        inlineRuns: [
          { start: 6, end: 7, italic: true },
          { start: 7, end: 8, bold: true },
        ],
        source: 'synthetic-split-note',
      },
      {
        id: 'note-12',
        type: 'footnote',
        kind: 'footnote',
        label: '12',
        text: 'Split marker note.',
        relationships: { backlinks: ['note-reference-12'] },
        source: 'synthetic-split-note',
      },
    ]

    const content = renderPublicationXhtml(notePaper)

    expect(content.match(/id="note-reference-12"/g)).toHaveLength(1)
    expect(content).toContain(
      '<a id="note-reference-12" href="#note-12" epub:type="noteref"><em>1</em><strong>2</strong></a>',
    )
  })

  it('emits footnote backlinks for rendered note-reference anchors', async () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Claim 1.',
        noteReferences: [
          {
            id: 'rendered-note-reference',
            label: '1',
            target: 'note-1',
            start: 6,
            end: 7,
            confidence: 1,
          },
        ],
        source: 'synthetic-orphan-backlink',
      },
      {
        id: 'note-1',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        text: 'The note remains readable.',
        relationships: {
          backlinks: ['rendered-note-reference'],
        },
        source: 'synthetic-orphan-backlink',
      },
    ]

    const epub = await buildEpub(notePaper)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain('href="#rendered-note-reference"')
    expect(content).toContain('The note remains readable.')
  })

  it('rejects a canonical note backlink with no rendered reference anchor', async () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'orphan-note',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        text: 'An affiliation note with an orphan source-region backlink.',
        relationships: { backlinks: ['page-001-author-region'] },
        source: 'synthetic-orphan-author-note',
      },
    ]

    await expect(buildEpub(notePaper)).rejects.toThrow(
      /DANGLING_EPUB_INTERNAL_REFERENCE/u,
    )
  })

  it('renders title-page author annotations as linked EPUB notes', () => {
    const notePaper = structuredClone(paper)
    notePaper.authors = ['Yeyong Yu', 'Runsheng Yu']
    notePaper.authorNotes = [
      {
        id: 'author-noteref-1',
        author: 'Yeyong Yu',
        label: '*',
        target: 'author-note-1',
      },
    ]
    notePaper.nodes = [
      {
        id: 'author-note-1',
        type: 'footnote',
        kind: 'footnote',
        label: '*',
        text: 'Work done during the internship.',
        relationships: { backlinks: ['author-noteref-1'] },
        source: 'synthetic-author-note',
      },
    ]

    const content = renderPublicationXhtml(notePaper)

    expect(content).toContain(
      'Yeyong Yu<a id="author-noteref-1" href="#author-note-1" epub:type="noteref">*</a>, Runsheng Yu',
    )
    expect(content).toContain('href="#author-noteref-1"')
  })

  it('renders a reconstructed byline immediately after its canonical title so author-note backlinks resolve', () => {
    const notePaper = structuredClone(paper)
    notePaper.title = 'Canonical reconstructed title'
    notePaper.authors = ['Yeyong Yu', 'Runsheng Yu']
    notePaper.authorNotes = [
      {
        id: 'reconstructed-author-noteref-1',
        author: 'Yeyong Yu',
        label: '*',
        target: 'reconstructed-author-note-1',
      },
    ]
    notePaper.nodes = [
      {
        id: 'canonical-title-node',
        type: 'heading',
        level: 1,
        text: notePaper.title,
        source: 'pdf:synthetic#page=1',
      },
      {
        id: 'first-body-node',
        type: 'paragraph',
        text: 'The body follows the source byline.',
        source: 'pdf:synthetic#page=1',
      },
      {
        id: 'reconstructed-author-note-1',
        type: 'footnote',
        kind: 'footnote',
        label: '*',
        text: 'Work done during the internship.',
        relationships: { backlinks: ['reconstructed-author-noteref-1'] },
        source: 'pdf:synthetic#page=1',
      },
    ]
    const reconstruction = {
      readiness: { ready: true },
      visualRelationships: [],
      assets: [],
    } as unknown as PdfReconstruction

    const content = renderPublicationXhtml(notePaper, { reconstruction })

    expect(content).toContain(
      'Yeyong Yu<a id="reconstructed-author-noteref-1" href="#reconstructed-author-note-1" epub:type="noteref">*</a>, Runsheng Yu',
    )
    expect(content).toContain('href="#reconstructed-author-noteref-1"')
    expect(content.indexOf('id="canonical-title-node"')).toBeLessThan(
      content.indexOf('class="authors"'),
    )
    expect(content.indexOf('class="authors"')).toBeLessThan(
      content.indexOf('id="first-body-node"'),
    )
    expect(XMLValidator.validate(content)).toBe(true)
  })

  it('renders an explicit source note marker instead of discarding its note-kind text', () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'note-1',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        markerText: 'Footnote 1.',
        text: 'The exact source marker remains rendered.',
        relationships: { backlinks: [] },
        source: 'synthetic-explicit-note-marker',
      },
    ]

    expect(renderPublicationXhtml(notePaper)).toContain(
      '<span class="note-label">Footnote 1.</span> The exact source marker remains rendered.',
    )
  })

  it('rejects an EPUB whose canonical inline href has no internal target', async () => {
    const danglingPaper = structuredClone(paper)
    danglingPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [9].',
        inlineRuns: [
          {
            start: 11,
            end: 14,
            relationshipId: 'citation-9',
            semanticRole: 'citation',
            targetIds: ['missing-reference-9'],
          },
        ],
        source: 'synthetic-dangling-citation',
      },
    ]

    await expect(buildEpub(danglingPaper)).rejects.toThrow(
      /dangling internal reference/i,
    )
  })

  it.each([
    { label: 'forbidden C0 control', text: '\u0012' },
    { label: 'Unicode replacement glyph', text: 'term \ufffd value' },
  ])('rejects lossy canonical text containing a $label', async ({ text }) => {
    const corruptPaper = structuredClone(paper)
    corruptPaper.nodes = [
      {
        id: 'corrupt-canonical-node',
        type: 'paragraph',
        text,
        source: 'synthetic-corrupt-text',
      },
    ]

    await expect(buildEpub(corruptPaper)).rejects.toThrow(
      /EPUB_TEXT_SANITIZATION_LOSS/u,
    )
  })

  it('preserves ordered-list marker style and starting ordinal', () => {
    const listPaper = structuredClone(paper)
    listPaper.nodes = [
      {
        id: 'roman-three',
        type: 'paragraph',
        text: 'Third item',
        list: {
          level: 1,
          ordered: true,
          numberingId: 'roman-list',
          markerStyle: 'lower-roman',
          ordinal: 3,
        },
        source: 'synthetic-list-test',
      },
      {
        id: 'roman-five',
        type: 'paragraph',
        text: 'Fifth item after an intentional gap',
        list: {
          level: 1,
          ordered: true,
          numberingId: 'roman-list',
          markerStyle: 'lower-roman',
          ordinal: 5,
        },
        source: 'synthetic-list-test',
      },
    ]

    const content = renderPublicationXhtml(listPaper)

    expect(content).toContain(
      '<ol class="publication-list" data-list-level="1" data-numbering-id="roman-list" data-marker-style="lower-roman" type="i" start="3">',
    )
    expect(content).toContain('id="roman-five"')
    expect(content).toContain('data-list-level="1" value="5"')
  })

  it('renders exact source list markers, ordinal gaps, and continuation evidence', () => {
    const listPaper = structuredClone(paper)
    const item = (
      id: string,
      markerText: string,
      ordinal: number,
      markerStyle: 'decimal' | 'lower-alpha',
      extra: { level?: number; continuedFromPreviousPage?: boolean } = {},
    ) => ({
      id,
      type: 'paragraph' as const,
      text: `${id} text`,
      list: {
        level: extra.level ?? 1,
        ordered: true,
        numberingId: 'source-markers',
        markerStyle,
        ordinal,
        markerText,
        ...(extra.continuedFromPreviousPage
          ? { continuedFromPreviousPage: true }
          : {}),
      },
      source: 'synthetic-source-marker-test',
    })
    listPaper.nodes = [
      item('one-suffix', '1)', 1, 'decimal'),
      item('alpha-parenthesized', '(a)', 1, 'lower-alpha', { level: 2 }),
      item('numeric-parenthesized', '(1)', 1, 'decimal', { level: 2 }),
      item('three-gap', '3)', 3, 'decimal'),
      item('four-continuation', '4)', 4, 'decimal', {
        continuedFromPreviousPage: true,
      }),
      {
        ...item('bracketed-reference', '[1]', 1, 'decimal'),
        list: {
          ...item('bracketed-reference', '[1]', 1, 'decimal').list,
          numberingId: 'references',
        },
      },
    ]

    const content = renderPublicationXhtml(listPaper)

    for (const marker of ['1)', '(a)', '(1)', '3)', '4)', '[1]']) {
      expect(content).toContain(
        `<span class="publication-list-marker" aria-hidden="true">${marker}</span>`,
      )
    }
    expect(content).toContain(
      'id="three-gap" data-canonical-id="three-gap" class="publication-list-item has-preserved-marker" data-list-level="1" value="3"',
    )
    expect(content).toContain(
      'id="four-continuation" data-canonical-id="four-continuation" class="publication-list-item has-preserved-marker" data-list-level="1" value="4" data-continued-from-previous-page="true"',
    )
  })

  it('emits well-formed ordered bibliography markup without naked listitem roles', () => {
    const referencePaper = structuredClone(paper)
    referencePaper.nodes = [
      {
        id: 'reference-one',
        type: 'paragraph',
        text: 'First reference.',
        list: { level: 1, ordered: false, numberingId: 'references' },
        source: 'synthetic-list-test',
      },
      {
        id: 'reference-two',
        type: 'paragraph',
        text: 'Second reference.',
        list: { level: 1, ordered: false, numberingId: 'references' },
        source: 'synthetic-list-test',
      },
    ]

    const content = renderPublicationXhtml(referencePaper)

    expect(XMLValidator.validate(content)).toBe(true)
    expect(content).toContain(
      '<ol class="publication-list" data-list-level="1" data-numbering-id="references" data-marker-style="decimal">',
    )
    expect(content).not.toContain(
      '<ul class="publication-list" data-list-level="1" data-numbering-id="references" data-marker-style="decimal">',
    )
    expect(content.match(/<li\b/g)).toHaveLength(2)
    expect(content).not.toContain('role="listitem"')
  })

  it('builds a deterministic reflowable container with stored first mimetype', async () => {
    const first = await buildEpub(paper)
    const second = await buildEpub(paper)
    const { files, entries } = inspectEpub(first.bytes)

    expect(first.bytes).toEqual(second.bytes)
    expect(first.sha256).toBe(second.sha256)
    expect(first.fileName).toMatch(/\.epub$/)
    expect(entries[0]).toBe('mimetype')
    expect(first.bytes[8] | (first.bytes[9] << 8)).toBe(0)
    expect(strFromU8(files['META-INF/container.xml'])).toContain(
      'EPUB/package.opf',
    )
    expect(strFromU8(files['EPUB/package.opf'])).toContain('version="3.0"')
    expect(strFromU8(files['EPUB/package.opf'])).toContain('properties="nav"')
  })

  it('rejects malformed package graphs and asset bytes that do not match their manifest receipt', async () => {
    const epub = await buildEpub(paper)
    const original = unzipSync(epub.bytes)
    const manifest = JSON.parse(strFromU8(original['EPUB/export.json']))
    manifest.assets = [
      {
        id: 'tampered-asset',
        href: 'assets/tampered.png',
        mediaType: 'image/png',
        kind: 'raster',
        rendition: 'source-preserved',
        sha256: '0'.repeat(64),
      },
    ]
    const withAsset = {
      ...original,
      'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
      'EPUB/package.opf': strToU8(
        strFromU8(original['EPUB/package.opf']).replace(
          '</manifest>',
          '<item id="tampered-asset" href="assets/tampered.png" media-type="image/png" /></manifest>',
        ),
      ),
      'EPUB/content.xhtml': strToU8(
        strFromU8(original['EPUB/content.xhtml']).replace(
          '</main>',
          '<img src="assets/tampered.png" alt="tampered" /></main>',
        ),
      ),
      'EPUB/assets/tampered.png': new Uint8Array([1, 2, 3]),
    }

    expect(() => inspectEpub(rezipEpub(withAsset))).toThrow(/SHA-256/i)

    const duplicateOpf = {
      ...original,
      'EPUB/package.opf': strToU8(
        strFromU8(original['EPUB/package.opf']).replace(
          '</manifest>',
          '<item id="content" href="content.xhtml" media-type="application/xhtml+xml" /></manifest>',
        ),
      ),
    }
    expect(() => inspectEpub(rezipEpub(duplicateOpf))).toThrow(
      /duplicate manifest id/i,
    )

    const danglingSpine = {
      ...original,
      'EPUB/package.opf': strToU8(
        strFromU8(original['EPUB/package.opf']).replace(
          'idref="content"',
          'idref="missing"',
        ),
      ),
    }
    expect(() => inspectEpub(rezipEpub(danglingSpine))).toThrow(
      /spine.*missing/i,
    )

    const malformed = {
      ...original,
      'EPUB/content.xhtml': strToU8(
        strFromU8(original['EPUB/content.xhtml']).replace('</main>', ''),
      ),
    }
    expect(() => inspectEpub(rezipEpub(malformed))).toThrow(/well-formed/i)
  })

  it('rejects receipt-backed raster signatures without complete image structure', async () => {
    const epub = await buildEpub(paper)
    const original = unzipSync(epub.bytes)
    const cases = [
      {
        id: 'truncated-png',
        href: 'assets/truncated.png',
        mediaType: 'image/png',
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
      {
        id: 'truncated-jpeg',
        href: 'assets/truncated.jpg',
        mediaType: 'image/jpeg',
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      },
      {
        id: 'truncated-gif',
        href: 'assets/truncated.gif',
        mediaType: 'image/gif',
        bytes: strToU8('GIF89a'),
      },
    ] as const

    for (const candidate of cases) {
      const manifest = JSON.parse(strFromU8(original['EPUB/export.json']))
      manifest.assets.push({
        id: candidate.id,
        href: candidate.href,
        mediaType: candidate.mediaType,
        sha256: await sha256Hex(candidate.bytes),
      })
      const tampered = {
        ...original,
        'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
        'EPUB/package.opf': strToU8(
          strFromU8(original['EPUB/package.opf']).replace(
            '</manifest>',
            `<item id="${candidate.id}" href="${candidate.href}" media-type="${candidate.mediaType}" /></manifest>`,
          ),
        ),
        'EPUB/content.xhtml': strToU8(
          strFromU8(original['EPUB/content.xhtml']).replace(
            '</main>',
            `<img src="${candidate.href}" alt="truncated" /></main>`,
          ),
        ),
        [`EPUB/${candidate.href}`]: candidate.bytes,
      }

      expect(() => inspectEpub(rezipEpub(tampered))).toThrow(
        new RegExp(`bytes do not match ${candidate.mediaType}`),
      )
    }
  })

  it('rejects a receipt-backed alternate XHTML document swapped into the OPF spine', async () => {
    const epub = await buildEpub(paper, getTargetProfile('paperPro'))
    const files = unzipSync(epub.bytes)
    const alternate = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Alternate</title></head><body><main>Alternate spine content.</main></body></html>`)
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json']))
    manifest.assets.push({
      id: 'alternate-content',
      href: 'alternate.xhtml',
      mediaType: 'application/xhtml+xml',
      sha256: await sha256Hex(alternate),
    })
    const swapped = {
      ...files,
      'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
      'EPUB/package.opf': strToU8(
        strFromU8(files['EPUB/package.opf'])
          .replace(
            '</manifest>',
            '<item id="alternate-content" href="alternate.xhtml" media-type="application/xhtml+xml" /></manifest>',
          )
          .replace('idref="content"', 'idref="alternate-content"'),
      ),
      'EPUB/alternate.xhtml': alternate,
    }

    expect(() =>
      inspectEpub(rezipEpub(swapped), getTargetProfile('paperPro')),
    ).toThrow(/spine.*content\.xhtml|content\.xhtml.*spine/i)
  })

  it('rejects single-quoted dangling href, src, and data attributes', async () => {
    const epub = await buildEpub(paper)
    const files = unzipSync(epub.bytes)
    const cases = [
      {
        markup: "<a href='#missing-fragment'>missing</a>",
        expected: /dangling internal reference #missing-fragment/i,
      },
      {
        markup:
          "<a href='missing-document.xhtml#missing-fragment'>missing document</a>",
        expected: /dangling internal reference missing-document\.xhtml/i,
      },
      {
        markup: "<img src='assets/missing.png' alt='missing' />",
        expected: /dangling asset reference assets\/missing\.png/i,
      },
      {
        markup:
          "<object data='assets/missing.xhtml' type='application/xhtml+xml' />",
        expected: /dangling asset reference assets\/missing\.xhtml/i,
      },
    ]

    for (const candidate of cases) {
      const tampered = {
        ...files,
        'EPUB/content.xhtml': strToU8(
          strFromU8(files['EPUB/content.xhtml']).replace(
            '</main>',
            `${candidate.markup}</main>`,
          ),
        ),
      }

      expect(() => inspectEpub(rezipEpub(tampered))).toThrow(candidate.expected)
    }
  })

  it('preserves canonical reading order and addressable node IDs in XHTML', async () => {
    const epub = await buildEpub(paper)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json']))

    expect(manifest.canonicalNodeIds).toEqual(
      paper.nodes.map((node) => node.id),
    )
    for (const node of paper.nodes) {
      expect(content).toContain(`id="${node.id}"`)
    }
    expect(content.indexOf(paper.nodes[0].id)).toBeLessThan(
      content.indexOf(paper.nodes.at(-1)!.id),
    )
  })

  it('fails before XHTML generation when canonical node ids are not globally unique', async () => {
    const duplicateIds = structuredClone(paper)
    duplicateIds.nodes[1].id = duplicateIds.nodes[0].id

    await expect(buildEpub(duplicateIds)).rejects.toThrow(
      /canonical node ids must be globally unique/i,
    )
  })

  it('requires a typed, non-empty canonicalNodeIds integrity receipt', async () => {
    const epub = await buildEpub(paper)
    const files = unzipSync(epub.bytes)
    const originalManifest = JSON.parse(
      strFromU8(files['EPUB/export.json']),
    ) as Record<string, unknown>
    const invalidReceipts: unknown[] = [undefined, [], ['valid-id', 7]]

    for (const canonicalNodeIds of invalidReceipts) {
      const manifest = { ...originalManifest }
      if (canonicalNodeIds === undefined) delete manifest.canonicalNodeIds
      else manifest.canonicalNodeIds = canonicalNodeIds
      const tampered = {
        ...files,
        'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
      }

      expect(() => inspectEpub(rezipEpub(tampered))).toThrow(
        /canonicalNodeIds.*non-empty strings/i,
      )
    }
  })

  it('escapes publication metadata rather than emitting invalid XHTML', async () => {
    const escaped = structuredClone(paper)
    escaped.title = 'Evidence & <meaning>'
    escaped.authors = ['A. "Reader" & Co.']
    const epub = await buildEpub(escaped)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain('Evidence &amp; &lt;meaning&gt;')
    expect(content).not.toContain('Evidence & <meaning>')
  })

  it('derives deterministic device CSS and progression metadata from profiles', async () => {
    const paperPro = getTargetProfile('paperPro')
    const paperMove = getTargetProfile('paperProMove')
    const [first, second, move] = await Promise.all([
      buildEpub(paper, paperPro),
      buildEpub(paper, undefined, paperPro),
      buildEpub(paper, paperMove),
    ])

    expect(first.bytes).toEqual(second.bytes)
    expect(first.fileName).toBe('publication-paperpro.epub')
    expect(move.fileName).toBe('publication-papermove.epub')
    expect(first.bytes).not.toEqual(move.bytes)

    const { files, manifest } = inspectEpub(first.bytes, paperPro)
    const css = strFromU8(files['EPUB/styles.css'])
    const opf = strFromU8(files['EPUB/package.opf'])
    expect(css).toContain(`font-family: ${paperPro.typography.fontFamily}`)
    expect(css).toContain(`font-size: ${paperPro.typography.bodySizeCssPx}px`)
    expect(css).not.toMatch(/(^|[;{]\s*)direction\s*:/m)
    expect(css).toContain('8.951% 8.025% 8.951% 8.025%')
    expect(css.match(/8\.951% 8\.025% 8\.951% 8\.025%/g)).toHaveLength(1)
    expect(css).toContain('@page { margin: 0; }')
    expect(css).toContain('main { max-width: none; padding:')
    expect(css).toContain('overflow-wrap: anywhere')
    expect(css).toContain(
      'h1, h2, h3, p, figcaption, .orphan-caption, .publication-note, .publication-list, .publication-list-item { overflow-wrap: anywhere; word-break: break-word; }',
    )
    expect(css).toContain(
      '.publication-list { max-width: 100%; min-width: 0; margin: 0.8rem 0; padding-inline-start: 1.5rem; }',
    )
    expect(css).toContain('*, *::before, *::after { box-sizing: border-box; }')
    expect(css).toContain('main { box-sizing: border-box; width: 100%;')
    expect(css).toContain(
      '.semantic-table-wrapper { max-width: 100%; overflow-x: auto; }',
    )
    expect(css).toContain(
      '.semantic-table-figure, .semantic-table-wrapper, .semantic-table-wrapper table { break-inside: auto; }',
    )
    expect(css).toContain(
      '.semantic-table-wrapper thead { display: table-header-group; }',
    )
    expect(css).toContain(
      '.semantic-table-figure > figcaption { break-before: avoid; }',
    )
    expect(css).toContain('table-layout: fixed')
    expect(opf).toContain(
      `page-progression-direction="${paperPro.epub.pageProgressionDirection}"`,
    )
    expect(opf).toContain(
      `<meta property="rendition:flow">${paperPro.epub.renditionFlow}</meta>`,
    )
    expect(manifest).toMatchObject({
      schemaVersion: '1.1.0',
      rendition: 'profile-tuned-reflowable-epub',
      profile: {
        id: 'paperPro',
        version: paperPro.version,
        dimensions: paperPro.dimensions,
        manufacturerDisplay: paperPro.manufacturerDisplay,
        preview: paperPro.preview,
        pixelsPerInch: paperPro.pixelsPerInch,
        compositionPolicy: { id: 'large-eink', version: '1.1.0' },
        exportPolicy: {
          id: 'profile-tuned-reflowable',
          version: '1.1.0',
        },
        truth: {
          geometry: 'authoritative',
          typography: 'advisory',
          pagination: 'reader-controlled',
          orientation: 'reader-controlled',
        },
      },
    })
  })

  it('rejects profiled EPUB styles that do not match the selected profile', async () => {
    const profile = getTargetProfile('paperPro')
    const epub = await buildEpub(paper, profile)
    const files = unzipSync(epub.bytes)
    const tampered = {
      ...files,
      'EPUB/styles.css': strToU8(
        strFromU8(files['EPUB/styles.css'])
          .replace(
            `html { font-size: ${profile.typography.bodySizeCssPx}px;`,
            'html { font-size: 1px;',
          )
          .replace(
            /main \{ max-width: none; padding: [^;]+;/,
            'main { max-width: none; padding: 0;',
          ),
      ),
    }

    expect(() => inspectEpub(rezipEpub(tampered), profile)).toThrow(
      /profile.*styles|styles.*profile/i,
    )
  })

  it('rejects stale profiled export schema, rendition, and policy metadata', async () => {
    const profile = getTargetProfile('paperProMove')
    const epub = await buildEpub(paper, profile)
    const files = unzipSync(epub.bytes)
    const originalManifest = JSON.parse(
      strFromU8(files['EPUB/export.json']),
    ) as Record<string, any>
    const mutations = [
      (manifest: Record<string, any>) => {
        manifest.schemaVersion = '0.0.0'
      },
      (manifest: Record<string, any>) => {
        manifest.rendition = 'reflowable-epub'
      },
      (manifest: Record<string, any>) => {
        manifest.profile.exportPolicy.id = 'stale-policy'
      },
      (manifest: Record<string, any>) => {
        manifest.profile.exportPolicy.version = '0.0.0'
      },
      (manifest: Record<string, any>) => {
        manifest.profile.typography.bodySizeCssPx = 1
      },
    ]

    for (const mutate of mutations) {
      const manifest = structuredClone(originalManifest)
      mutate(manifest)
      const tampered = {
        ...files,
        'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
      }

      expect(() => inspectEpub(rezipEpub(tampered), profile)).toThrow(
        /profiled export manifest contract/i,
      )
    }
  })

  it('renders validated canonical tables inline without a clipped nested document', () => {
    const tablePaper = structuredClone(paper)
    tablePaper.nodes = [
      {
        id: 'table-node',
        type: 'figure',
        title: 'Synthetic semantic table',
        objectType: 'table',
        table: {
          rows: [
            {
              cells: [
                {
                  text: 'Profile & target',
                  headerScope: 'column',
                  columnSpan: 2,
                  rowSpan: 1,
                },
              ],
            },
            {
              cells: [
                {
                  text: 'Mobile',
                  headerScope: 'row',
                  columnSpan: 1,
                  rowSpan: 1,
                },
                {
                  text: '<12>',
                  headerScope: null,
                  columnSpan: 1,
                  rowSpan: 1,
                },
              ],
            },
          ],
        },
        relationships: { caption: 'table-caption', assets: ['table-asset'] },
        source: 'synthetic-table-test',
      },
      {
        id: 'table-caption',
        type: 'caption',
        text: 'Table 1. Synthetic values.',
        source: 'synthetic-table-test',
      },
    ]
    const sourceBox = {
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.3,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const asset = {
      id: 'table-asset',
      href: 'assets/table-asset.xhtml',
      mediaType: 'application/xhtml+xml',
      kind: 'table',
      rendition: 'semantic-table',
      sha256: 'a'.repeat(64),
      bytes: new TextEncoder().encode('<html><body><table /></body></html>'),
      width: 400,
      height: 160,
      resolutionDpi: null,
      sourceObjectIds: ['table-source'],
      sourceBoxes: [sourceBox],
    } satisfies PublicationAsset
    const relationship = {
      id: 'table-relationship',
      kind: 'table',
      label: 'Table 1',
      captionRegionId: 'table-caption-region',
      sourceRegionIds: ['table-region'],
      sourceObjectIds: ['table-source'],
      assetIds: [asset.id],
      status: 'matched',
      confidence: 1,
      evidence: ['synthetic-table-test'],
      candidates: [],
      sourceBoxes: [sourceBox],
      sourceText: '',
      altText: 'Synthetic semantic table',
      altTextSource: 'caption',
      canonicalNodeId: 'table-node',
      captionNodeId: 'table-caption',
    } satisfies PublicationVisualRelationship
    const reconstruction = {
      readiness: { ready: true },
      visualRelationships: [relationship],
      assets: [asset],
    } as unknown as PdfReconstruction

    const content = renderPublicationXhtml(tablePaper, {
      reconstruction,
      visualAssets: new Map([[asset.id, asset]]),
    })

    expect(content).toContain('class="semantic-table-wrapper"')
    expect(content).toContain('class="semantic-table-figure"')
    expect(content).toContain('data-asset-id="table-asset"')
    expect(content).toContain('<table aria-describedby="table-caption"><thead>')
    expect(content).toContain('<th scope="col" colspan="2">')
    expect(content).toContain('<th scope="row">Mobile</th>')
    expect(content).toContain('Profile &amp; target')
    expect(content).toContain('&lt;12&gt;')
    expect(content).toContain('<tbody>')
    expect(content).not.toContain('<object')
  })

  it('builds an explicitly non-publication-grade readable fallback without weakening the strict gate', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Readable text must still flow when a decorative image is unresolved.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: run.text.length,
      imageCount: 1,
      objects: [],
      runs: [run],
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [page],
      sourceHash: 'a'.repeat(64),
      fileName: 'readable-fallback.pdf',
      byteLength: 1024,
    })
    reconstruction.paper.title = run.text

    expect(reconstruction.readiness.ready).toBe(false)
    await expect(
      buildEpub(reconstruction.paper, reconstruction),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_RECONSTRUCTION' })

    const fallback = await buildReadableEpub(
      reconstruction.paper,
      reconstruction,
    )
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(fallback.mode).toBe('readable-fallback')
    expect(fallback.fileName).toMatch(/-readable\.epub$/)
    expect(content).toContain('Readable text must still flow')
    expect(content).toContain('<title>Publication</title>')
    expect(content.match(/Readable text must still flow/g)).toHaveLength(1)
    expect(content).not.toContain('class="publication-header"')
    expect(content).not.toContain('class="reconstructed-header"')
    expect(content).not.toContain('class="reconstructed-header"')
    expect(content).not.toContain('working · 1970-01-01')
    expect(manifest).toMatchObject({
      exportMode: 'readable-fallback',
      publicationGrade: false,
      sourceReadiness: { ready: false },
    })
  })

  it('projects readable-fallback note backlinks onto anchors that can actually render', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'A claim with note 1.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: run.text.length,
          imageCount: 1,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'readable-note-projection.pdf',
      byteLength: 1024,
    })
    const paragraph = reconstruction.paper.nodes.find(
      (node) => node.type === 'paragraph' && node.text === run.text,
    )
    expect(paragraph?.type).toBe('paragraph')
    if (paragraph?.type !== 'paragraph') throw new Error('missing paragraph')
    paragraph.noteReferences = [
      {
        id: 'rendered-reference',
        label: '1',
        target: 'rendered-note',
        start: run.text.indexOf('1'),
        end: run.text.indexOf('1') + 1,
        confidence: 1,
      },
    ]
    reconstruction.paper.nodes.push(
      {
        id: 'rendered-note',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        text: 'A source-backed note.',
        relationships: {
          backlinks: ['rendered-reference', 'orphan-source-marker'],
        },
        source: 'pdf:synthetic#page=1',
      },
      {
        id: 'orphan-note',
        type: 'footnote',
        kind: 'footnote',
        label: '2',
        text: 'A note whose extracted marker cannot render.',
        relationships: { backlinks: ['another-orphan-source-marker'] },
        source: 'pdf:synthetic#page=1',
      },
    )

    const fallback = await buildReadableEpub(
      reconstruction.paper,
      reconstruction,
    )
    const { files } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain('id="rendered-reference"')
    expect(content).toContain('href="#rendered-reference"')
    expect(content).not.toContain('orphan-source-marker')
    expect(content).not.toContain('another-orphan-source-marker')
    expect(content).toContain('A note whose extracted marker cannot render.')
  })

  it('keeps owned text from an unresolved diagram with its orphan caption', () => {
    const paper = {
      id: 'unresolved-diagram-paper',
      version: '1.0.0',
      status: 'working' as const,
      title: 'Unresolved diagram transcript',
      subtitle: 'Source-backed fallback',
      authors: ['Test Author'],
      updated: '2026-07-23',
      abstract: 'A bounded unresolved diagram.',
      nodes: [
        {
          id: 'caption-figure-1',
          type: 'caption' as const,
          text: 'Figure 1. A bounded unresolved diagram.',
          source: 'pdf:test#page=1',
        },
      ],
    }
    const content = renderPublicationXhtml(paper, {
      reconstruction: {
        visualRelationships: [
          {
            id: 'visual-relationship-1',
            kind: 'figure',
            label: 'Figure 1',
            captionRegionId: 'page-001-caption',
            sourceRegionIds: [],
            sourceObjectIds: [],
            assetIds: [],
            status: 'unresolved',
            confidence: 1,
            evidence: ['unresolved-visual-text-owned'],
            candidates: [],
            sourceBoxes: [],
            sourceText: 'Step 1: embed inputs. Step 2: create the output.',
            altText: 'Figure 1. A bounded unresolved diagram.',
            altTextSource: 'caption',
            canonicalNodeId: null,
            captionNodeId: 'caption-figure-1',
          },
        ],
        assets: [],
        readiness: { ready: false },
      } as unknown as PdfReconstruction,
    })

    expect(content).toContain('class="orphan-caption omitted-visual"')
    expect(content).toContain('Recovered text inside the unresolved visual:')
    expect(content).toContain(
      'Step 1: embed inputs. Step 2: create the output.',
    )
    expect(content.match(/Step 1: embed inputs/g)).toHaveLength(1)
  })

  it('excludes prose-overlap false visuals and their canonical caption nodes from readable fallbacks', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Canonical prose owns this source region.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: run.text.length,
          imageCount: 1,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'prose-overlap.pdf',
      byteLength: 1024,
    })
    const proseNode = reconstruction.paper.nodes.find(
      (node) => 'text' in node && node.text === run.text,
    )!
    const proseRegionId = reconstruction.provenance[proseNode.id].regionIds[0]
    const visualBox = {
      page: 1,
      x: 0.15,
      y: 0.35,
      width: 0.7,
      height: 0.25,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const captionBox = {
      page: 1,
      x: 0.15,
      y: 0.62,
      width: 0.7,
      height: 0.03,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const crop = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox: visualBox,
      sourceObjectIds: ['false-visual-source'],
      sourceBoxes: [visualBox],
      width: 20,
      height: 10,
      pixels: new Uint8Array(20 * 10 * 4).fill(96),
    })
    const figureNode = {
      id: 'false-visual-node',
      type: 'figure' as const,
      objectType: 'figure' as const,
      title: 'False visual duplicate',
      relationships: {
        caption: 'false-visual-caption',
        assets: [crop.id],
      },
      source: 'synthetic-prose-overlap',
    }
    const captionNode = {
      id: 'false-visual-caption',
      type: 'caption' as const,
      text: 'Figure 1. False visual duplicate.',
      source: 'synthetic-prose-overlap',
    }
    const relationship = {
      id: 'false-visual-relationship',
      kind: 'figure' as const,
      label: 'Figure 1',
      captionRegionId: 'false-caption-region',
      sourceRegionIds: [proseRegionId],
      sourceObjectIds: ['false-visual-source'],
      assetIds: [crop.id],
      status: 'matched' as const,
      confidence: 1,
      evidence: ['synthetic-prose-overlap'],
      candidates: [],
      sourceBoxes: [visualBox, captionBox],
      sourceText: '',
      altText: captionNode.text,
      altTextSource: 'caption' as const,
      canonicalNodeId: figureNode.id,
      captionNodeId: captionNode.id,
    }
    const falseMatch = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: [...reconstruction.paper.nodes, figureNode, captionNode],
      },
      provenance: {
        ...reconstruction.provenance,
        [figureNode.id]: {
          confidence: 1,
          pages: [1],
          regionIds: [proseRegionId],
          boxes: relationship.sourceBoxes,
          links: [],
        },
        [captionNode.id]: {
          confidence: 1,
          pages: [1],
          regionIds: [relationship.captionRegionId],
          boxes: [captionBox],
          links: [],
        },
      },
      assets: [crop],
      visualRelationships: [relationship],
    } satisfies PdfReconstruction

    expect(
      validatedPdfVisualRelationships({
        paper: falseMatch.paper,
        provenance: falseMatch.provenance,
        relationships: falseMatch.visualRelationships,
        assets: falseMatch.assets,
      }),
    ).toEqual([])

    const fallback = await buildReadableEpub(falseMatch.paper, falseMatch)
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(
      content.match(/Canonical prose owns this source region\./g),
    ).toHaveLength(1)
    expect(content).not.toContain('False visual duplicate')
    expect(content).not.toContain('false-visual-node')
    expect(content).not.toContain('false-visual-caption')
    expect(content).not.toContain('omitted-visual')
    expect(content).not.toContain('orphan-caption')
    expect(manifest.visualRelationships).toEqual([])
    expect(manifest.assets).toEqual([])
    expect(manifest.canonicalNodeIds).toEqual(
      reconstruction.paper.nodes.map((node) => node.id),
    )
  })

  it('prunes unvalidated fragment visuals without leaving fallback placeholders', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Readable fallback body.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: run.text.length,
          imageCount: 17,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'fragmented-fallback.pdf',
      byteLength: 1024,
    })
    const sourceBox = {
      page: 1,
      x: 0.1,
      y: 0.3,
      width: 0.8,
      height: 0.4,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const assetIds = Array.from({ length: 17 }, (_, index) => `asset-${index}`)
    const crowded = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: [
          ...reconstruction.paper.nodes,
          {
            id: 'figure-node',
            type: 'figure' as const,
            title: 'Fragmented source visual',
            relationships: {
              caption: 'figure-caption',
              assets: assetIds,
            },
            source: 'test',
          },
          {
            id: 'figure-caption',
            type: 'caption' as const,
            text: 'Figure 1. Fragmented source visual.',
            source: 'test',
          },
        ],
      },
      assets: assetIds.map((id) => ({
        id,
        href: `assets/${id}.svg`,
        mediaType: 'image/svg+xml' as const,
        kind: 'vector' as const,
        rendition: 'source-preserved' as const,
        sha256: 'c'.repeat(64),
        bytes: new TextEncoder().encode(
          '<svg xmlns="http://www.w3.org/2000/svg"/>',
        ),
        width: 10,
        height: 10,
        resolutionDpi: null,
        sourceObjectIds: [id],
        sourceBoxes: [sourceBox],
      })),
      visualRelationships: [
        {
          id: 'visual-relationship',
          kind: 'figure' as const,
          label: 'Figure 1',
          captionRegionId: 'caption-region',
          sourceRegionIds: ['figure-region'],
          sourceObjectIds: assetIds,
          assetIds,
          status: 'matched' as const,
          confidence: 1,
          evidence: ['test'],
          candidates: [],
          sourceBoxes: [sourceBox],
          sourceText: '',
          altText: 'Fragmented source visual',
          altTextSource: 'caption' as const,
          canonicalNodeId: 'figure-node',
          captionNodeId: 'figure-caption',
        },
      ],
    } satisfies PdfReconstruction

    const fallback = await buildReadableEpub(crowded.paper, crowded)
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).not.toContain('<img')
    expect(content).not.toContain('figure-placeholder')
    expect(content).not.toContain('omitted-visual')
    expect(content).not.toContain('orphan-caption')
    expect(content).not.toContain('figure-node')
    expect(content).not.toContain('figure-caption')
    expect(manifest.assets).toEqual([])
    expect(manifest.visualRelationships).toEqual([])
    expect(manifest.canonicalNodeIds).toEqual(
      reconstruction.paper.nodes.map((node) => node.id),
    )
    expect(manifest.excludedCanonicalNodeIds).toEqual([
      'figure-node',
      'figure-caption',
    ])
  })

  it('does not partially package an unvalidated visual asset bundle', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Readable fallback body.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: run.text.length,
          imageCount: 2,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'solid-fill-fragment.pdf',
      byteLength: 1024,
    })
    const sourceBox = {
      page: 1,
      x: 0.2,
      y: 0.3,
      width: 0.6,
      height: 0.3,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const raster = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox: sourceBox,
      sourceObjectIds: ['image-p001-001'],
      sourceBoxes: [sourceBox],
      width: 2,
      height: 2,
      pixels: new Uint8Array(2 * 2 * 4).fill(96),
    })
    const rasterId = raster.id
    const solidId = 'asset-solid-fill'
    const withVisual = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: [
          ...reconstruction.paper.nodes,
          {
            id: 'figure-node',
            type: 'figure' as const,
            title: 'Bounded source figure',
            relationships: {
              caption: 'figure-caption',
              assets: [rasterId, solidId],
            },
            source: 'test',
          },
          {
            id: 'figure-caption',
            type: 'caption' as const,
            text: 'Figure 1. Bounded source figure.',
            source: 'test',
          },
        ],
      },
      assets: [
        raster,
        {
          id: solidId,
          href: `assets/${solidId}.svg`,
          mediaType: 'image/svg+xml' as const,
          kind: 'vector' as const,
          rendition: 'source-preserved' as const,
          sha256: 'f'.repeat(64),
          bytes: new TextEncoder().encode(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300"><path d="M 0 0 L 600 0 L 600 300 L 0 300 Z" fill="#000" stroke="none" /></svg>',
          ),
          width: 600,
          height: 300,
          resolutionDpi: null,
          sourceObjectIds: ['vector-p001-001'],
          sourceBoxes: [sourceBox],
        },
      ],
      visualRelationships: [
        {
          id: 'visual-relationship',
          kind: 'figure' as const,
          label: 'Figure 1',
          captionRegionId: 'caption-region',
          sourceRegionIds: ['figure-region'],
          sourceObjectIds: ['image-p001-001', 'vector-p001-001'],
          assetIds: [rasterId, solidId],
          status: 'matched' as const,
          confidence: 1,
          evidence: ['test'],
          candidates: [],
          sourceBoxes: [sourceBox],
          sourceText: '',
          altText: 'Bounded source figure',
          altTextSource: 'caption' as const,
          canonicalNodeId: 'figure-node',
          captionNodeId: 'figure-caption',
        },
      ],
    } satisfies PdfReconstruction

    const fallback = await buildReadableEpub(withVisual.paper, withVisual)
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).not.toContain('<img')
    expect(content).not.toContain(rasterId)
    expect(content).not.toContain(solidId)
    expect(content).not.toContain('omitted-visual')
    expect(content).not.toContain('orphan-caption')
    expect(manifest.assets).toEqual([])
    expect(manifest.visualRelationships).toEqual([])
    expect(manifest.excludedCanonicalNodeIds).toEqual([
      'figure-node',
      'figure-caption',
    ])
  })

  it('packages and renders a bounded source-page crop with its provenance', async () => {
    const titleRun: PdfSourceRun = {
      page: 1,
      text: 'Source page crop',
      x: 0.2,
      y: 0.08,
      width: 0.6,
      height: 0.035,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Heading',
      fontSize: 18,
      confidence: 1,
    }
    const bodyRun: PdfSourceRun = {
      page: 1,
      text: 'Readable source-crop body.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const captionRun: PdfSourceRun = {
      page: 1,
      text: 'Figure 1. Bounded source-page crop.',
      x: 0.15,
      y: 0.68,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Caption',
      fontSize: 9,
      confidence: 1,
    }
    const sourceRuns = [titleRun, bodyRun, captionRun]
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: sourceRuns.reduce(
            (total, sourceRun) => total + sourceRun.text.length,
            0,
          ),
          imageCount: 0,
          objects: [],
          runs: sourceRuns,
        },
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'source-page-crop.pdf',
      byteLength: 1024,
    })
    const sourceBox = {
      page: 1,
      x: 0.15,
      y: 0.35,
      width: 0.7,
      height: 0.3,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const crop = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox: sourceBox,
      sourceObjectIds: ['figure-source-region'],
      sourceBoxes: [sourceBox],
      width: 20,
      height: 10,
      pixels: new Uint8Array(20 * 10 * 4).fill(64),
    })
    const captionNode = reconstruction.paper.nodes.find(
      (node) => node.type === 'caption' && node.text === captionRun.text,
    )!
    const captionRegion = reconstruction.regions.find(
      (region) => region.kind === 'caption' && region.text === captionRun.text,
    )!
    const captionEvidence = reconstruction.provenance[captionNode.id]
    const figureNode = {
      id: 'source-crop-figure',
      type: 'figure' as const,
      objectType: 'figure' as const,
      title: 'Bounded source-page crop',
      relationships: {
        caption: captionNode.id,
        assets: [crop.id],
      },
      source: 'test',
    }
    const relationshipBoxes = [sourceBox, ...captionEvidence.boxes]
    const cropCandidate = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: reconstruction.paper.nodes.flatMap((node) =>
          node.id === captionNode.id ? [figureNode, node] : [node],
        ),
      },
      provenance: {
        ...reconstruction.provenance,
        [figureNode.id]: {
          confidence: 1,
          pages: [1],
          regionIds: [captionRegion.id],
          boxes: relationshipBoxes,
          links: [],
        },
      },
      assets: [crop],
      visualRelationships: [
        {
          id: 'source-crop-relationship',
          kind: 'figure' as const,
          label: 'Figure 1',
          captionRegionId: captionRegion.id,
          sourceRegionIds: [captionRegion.id],
          sourceObjectIds: ['figure-source-region'],
          assetIds: [crop.id],
          status: 'matched' as const,
          confidence: 1,
          evidence: ['source-page-crop'],
          candidates: [],
          sourceBoxes: relationshipBoxes,
          sourceText: '',
          altText: captionRun.text,
          altTextSource: 'caption' as const,
          canonicalNodeId: figureNode.id,
          captionNodeId: captionNode.id,
        },
      ],
    } satisfies PdfReconstruction
    const cropAssessment = assessPdfCompleteness({
      pages: cropCandidate.pages,
      paper: cropCandidate.paper,
      diagnostics: cropCandidate.diagnostics.filter(
        (diagnostic) => diagnostic.severity !== 'error',
      ),
      readingOrder: cropCandidate.readingOrder,
      regions: cropCandidate.regions,
      visualRelationships: cropCandidate.visualRelationships,
      assets: cropCandidate.assets,
      citationRelationships: cropCandidate.citationRelationships,
      provenance: cropCandidate.provenance,
      lineBoundaryDecisions: cropCandidate.lineBoundaryDecisions,
      unresolvedCorruptingJoinCount:
        cropCandidate.unresolvedCorruptingJoinCount,
      structurallyConsumedLineBoundaryCount:
        cropCandidate.structurallyConsumedLineBoundaryCount,
      inlineSpanLedger: {
        expected: cropCandidate.completeness.expectedInlineSpanCount,
        mapped: cropCandidate.completeness.mappedInlineSpanCount,
      },
      policy: cropCandidate.readiness.policy,
    })
    const withCrop = {
      ...cropCandidate,
      semanticSignals: cropAssessment.semanticSignals,
      completeness: cropAssessment.completeness,
      diagnostics: cropAssessment.diagnostics,
      readiness: cropAssessment.readiness,
    } satisfies PdfReconstruction

    const epub = await buildReadableEpub(
      withCrop.paper,
      withCrop,
      getTargetProfile('paperPro'),
    )
    const { files, manifest } = inspectEpub(
      epub.bytes,
      getTargetProfile('paperPro'),
    )
    const content = strFromU8(files['EPUB/content.xhtml'])
    const packaged = (
      manifest.assets as Array<Record<string, unknown>> | undefined
    )?.find((asset) => asset.sourceAssetId === crop.id)

    expect(content).toContain(`<img src="${crop.href}"`)
    expect(files[`EPUB/${crop.href}`]).toEqual(crop.bytes)
    expect(packaged).toMatchObject({
      rendition: 'source-page-crop',
      sourceCropBox: sourceBox,
      sourceAssetId: crop.id,
    })
  })
})
