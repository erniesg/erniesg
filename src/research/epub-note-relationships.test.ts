import { strFromU8 } from 'fflate'
import { XMLValidator } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import { buildEpub, inspectEpub, renderPublicationXhtml } from './epub'
import type { PdfReconstruction, PublicationAsset } from './import-types'
import { researchPaperSchema } from './schema'

const paper = researchPaperSchema.parse(rawPaper)

describe('EPUB 3 export', () => {
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
      '<a id="note-reference-12" href="#note-12" epub:type="noteref" role="doc-noteref"><em>1</em><strong>2</strong></a>',
    )
  })

  it('emits footnote backlinks for rendered note-reference anchors', async () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Claim 2.',
        noteReferences: [
          {
            id: 'rendered-note-reference',
            label: '2',
            target: 'note-2',
            start: 6,
            end: 7,
            confidence: 1,
          },
        ],
        source: 'synthetic-orphan-backlink',
      },
      {
        id: 'note-2',
        type: 'footnote',
        kind: 'footnote',
        label: '2',
        text: 'The note remains readable at https://example.test/source.',
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
    expect(content).toContain('aria-label="Back to reference 2"')
    expect(content).toContain('The note remains readable at')
    expect(content).toContain(
      '<a href="https://example.test/source">https://example.test/source</a>.',
    )
  })

  it('emits footnote backlinks for note-reference anchors rendered inside associated captions', async () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'captioned-figure',
        type: 'figure',
        title: 'Captioned figure',
        relationships: { caption: 'caption-with-note' },
        source: 'synthetic-caption-note',
      },
      {
        id: 'caption-with-note',
        type: 'caption',
        text: 'Figure caption 6.',
        noteReferences: [
          {
            id: 'caption-note-reference-6',
            label: '6',
            target: 'caption-note-6',
            start: 15,
            end: 16,
            confidence: 1,
          },
        ],
        source: 'synthetic-caption-note',
      },
      {
        id: 'caption-note-6',
        type: 'footnote',
        kind: 'footnote',
        label: '6',
        text: 'A note referenced from the caption.',
        relationships: { backlinks: ['caption-note-reference-6'] },
        source: 'synthetic-caption-note',
      },
    ]

    const epub = await buildEpub(notePaper)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain(
      'id="caption-note-reference-6" href="#caption-note-6"',
    )
    expect(content).toContain('href="#caption-note-reference-6"')
  })

  it('omits a caption-note backlink when an unresolved visual suppresses its reference anchor', () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'unresolved-captioned-figure',
        type: 'figure',
        title: 'Unresolved captioned figure',
        relationships: { caption: 'unresolved-caption-with-note' },
        source: 'synthetic-unresolved-caption-note',
      },
      {
        id: 'unresolved-caption-with-note',
        type: 'caption',
        text: 'Figure caption 6.',
        noteReferences: [
          {
            id: 'suppressed-caption-note-reference-6',
            label: '6',
            target: 'suppressed-caption-note-6',
            start: 15,
            end: 16,
            confidence: 1,
          },
        ],
        source: 'synthetic-unresolved-caption-note',
      },
      {
        id: 'suppressed-caption-note-6',
        type: 'footnote',
        kind: 'footnote',
        label: '6',
        text: 'A note whose caption reference cannot render.',
        relationships: { backlinks: ['suppressed-caption-note-reference-6'] },
        source: 'synthetic-unresolved-caption-note',
      },
    ]

    const content = renderPublicationXhtml(notePaper, {
      reconstruction: {
        readiness: { ready: false },
        visualRelationships: [
          {
            id: 'unresolved-caption-visual',
            kind: 'figure',
            label: 'Figure 1',
            captionRegionId: 'source-caption-region',
            sourceRegionIds: [],
            sourceObjectIds: [],
            assetIds: [],
            status: 'unresolved',
            confidence: 1,
            evidence: ['unresolved-visual-text-owned'],
            candidates: [],
            sourceBoxes: [],
            sourceText: '',
            altText: 'Unresolved captioned figure',
            altTextSource: 'caption',
            canonicalNodeId: null,
            captionNodeId: 'unresolved-caption-with-note',
          },
        ],
        assets: [],
      } as unknown as PdfReconstruction,
    })

    expect(content).toContain(
      'id="unresolved-caption-with-note" data-canonical-id="unresolved-caption-with-note" hidden="hidden"',
    )
    expect(content).not.toContain('id="suppressed-caption-note-reference-6"')
    expect(content).not.toContain('href="#suppressed-caption-note-reference-6"')
  })

  it('scopes table-cell note relationships to rendered semantic tables', async () => {
    const notePaper = structuredClone(paper)
    notePaper.nodes = [
      {
        id: 'unresolved-table-with-note',
        type: 'figure',
        title: 'Unresolved table with note',
        objectType: 'table',
        table: {
          rows: [
            {
              cells: [
                {
                  id: 'cell-1',
                  text: 'Value6',
                  rowSpan: 1,
                  columnSpan: 1,
                  headerScope: null,
                  noteReferences: [
                    {
                      id: 'suppressed-table-cell-note-reference-6',
                      label: '6',
                      target: 'suppressed-table-cell-note-6',
                      start: 5,
                      end: 6,
                      confidence: 1,
                    },
                  ],
                },
              ],
            },
          ],
        },
        relationships: { caption: 'unresolved-table-caption' },
        source: 'synthetic-unresolved-table-note',
      },
      {
        id: 'unresolved-table-caption',
        type: 'caption',
        text: 'Table caption 6.',
        source: 'synthetic-unresolved-table-note',
      },
      {
        id: 'suppressed-table-cell-note-6',
        type: 'footnote',
        kind: 'footnote',
        label: '6',
        text: 'A note whose table-cell reference cannot render.',
        relationships: {
          backlinks: ['suppressed-table-cell-note-reference-6'],
        },
        source: 'synthetic-unresolved-table-note',
      },
    ]
    const semanticTableAsset = {
      id: 'semantic-table-asset',
      href: 'assets/semantic-table.xhtml',
      mediaType: 'application/xhtml+xml',
      kind: 'table',
      rendition: 'semantic-table',
      sha256: 'a'.repeat(64),
      bytes: new Uint8Array([1]),
      width: 100,
      height: 40,
      resolutionDpi: 96,
      sourceObjectIds: [],
      sourceBoxes: [],
    } satisfies PublicationAsset

    const omittedCrossReferencePaper = structuredClone(notePaper)
    const omittedTable = omittedCrossReferencePaper.nodes.find(
      (node) => node.id === 'unresolved-table-with-note',
    )
    if (omittedTable?.type !== 'figure' || !omittedTable.table) {
      throw new Error('Missing omitted-table fixture')
    }
    const omittedCell = omittedTable.table.rows[0].cells[0]
    delete omittedCell.noteReferences
    omittedCell.inlineRuns = [
      {
        start: 0,
        end: omittedCell.text.length,
        semanticRole: 'cross-reference',
        relationshipId: 'omitted-table-cell-cross-reference',
        targetIds: ['unresolved-table-caption'],
      },
    ]
    omittedCrossReferencePaper.nodes = omittedCrossReferencePaper.nodes.filter(
      (node) => node.id !== 'suppressed-table-cell-note-6',
    )
    const omittedCrossReferenceContent = renderPublicationXhtml(
      omittedCrossReferencePaper,
    )
    expect(omittedCrossReferenceContent).not.toContain(
      'omitted-table-cell-cross-reference',
    )
    await expect(buildEpub(omittedCrossReferencePaper)).resolves.toBeDefined()

    expect(() => renderPublicationXhtml(notePaper)).toThrow(
      /note-backlink.*suppressed-table-cell-note-reference-6/u,
    )
    expect(() =>
      renderPublicationXhtml(notePaper, {
        reconstruction: {
          readiness: { ready: false },
          visualRelationships: [
            {
              id: 'unresolved-table-visual',
              kind: 'table',
              label: 'Table 1',
              captionRegionId: 'source-table-caption-region',
              sourceRegionIds: [],
              sourceObjectIds: [],
              assetIds: [],
              status: 'unresolved',
              confidence: 1,
              evidence: ['unresolved-visual-text-owned'],
              candidates: [],
              sourceBoxes: [],
              sourceText: '',
              altText: 'Unresolved table with note',
              altTextSource: 'caption',
              canonicalNodeId: null,
              captionNodeId: 'unresolved-table-caption',
            },
          ],
          assets: [],
        } as unknown as PdfReconstruction,
      }),
    ).toThrow(/note-backlink.*suppressed-table-cell-note-reference-6/u)

    expect(() =>
      renderPublicationXhtml(notePaper, {
        reconstruction: {
          readiness: { ready: false },
          visualRelationships: [
            {
              id: 'preformatted-table-visual',
              kind: 'table',
              semanticKind: 'code',
              label: 'Table 1',
              captionRegionId: 'source-table-caption-region',
              sourceRegionIds: ['source-table-region'],
              sourceLineIds: ['source-table-line'],
              sourceObjectIds: [],
              assetIds: ['semantic-table-asset'],
              status: 'matched',
              confidence: 1,
              evidence: ['source-preformatted-block'],
              preformatted: {
                status: 'proved',
                evidence: ['exact-single-run-line-text'],
                lines: [
                  {
                    text: 'Value6',
                    sourceRegionId: 'source-table-region',
                    sourceLineId: 'source-table-line',
                    sourceBox: {
                      page: 1,
                      x: 0.1,
                      y: 0.1,
                      width: 0.2,
                      height: 0.02,
                      rotation: 0,
                      method: 'pdf-text',
                    },
                    sourceRunBoxes: [],
                  },
                ],
              },
              candidates: [],
              sourceBoxes: [],
              sourceText: 'Value6',
              altText: 'Unresolved table with note',
              altTextSource: 'caption',
              canonicalNodeId: 'unresolved-table-with-note',
              captionNodeId: 'unresolved-table-caption',
            },
          ],
          assets: [semanticTableAsset],
        } as unknown as PdfReconstruction,
      }),
    ).toThrow(/note-backlink.*suppressed-table-cell-note-reference-6/u)

    const semanticTableContent = renderPublicationXhtml(notePaper, {
      reconstruction: {
        readiness: { ready: true },
        visualRelationships: [
          {
            id: 'semantic-table-visual',
            kind: 'table',
            label: 'Table 1',
            captionRegionId: 'source-table-caption-region',
            sourceRegionIds: ['source-table-region'],
            sourceObjectIds: [],
            assetIds: [semanticTableAsset.id],
            status: 'matched',
            confidence: 1,
            evidence: ['source-semantic-table'],
            candidates: [],
            sourceBoxes: [],
            sourceText: 'Value6',
            altText: 'Semantic table with note',
            altTextSource: 'caption',
            canonicalNodeId: 'unresolved-table-with-note',
            captionNodeId: 'unresolved-table-caption',
          },
        ],
        assets: [semanticTableAsset],
      } as unknown as PdfReconstruction,
    })

    expect(semanticTableContent).toContain('class="semantic-table-wrapper"')
    expect(semanticTableContent).toContain(
      'id="suppressed-table-cell-note-reference-6"',
    )
    expect(semanticTableContent).toContain(
      'href="#suppressed-table-cell-note-reference-6"',
    )
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
    notePaper.authorAffiliations = [
      { author: 'Yeyong Yu', label: '1' },
      { author: 'Runsheng Yu', label: '2' },
    ]
    notePaper.affiliations = ['1 Example University,', '2 Example Laboratory']
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
      'Yeyong Yu<sup class="author-note-marker"><a id="author-noteref-1" href="#author-note-1" epub:type="noteref" role="doc-noteref">*</a></sup><sup class="author-affiliation-marker">1</sup>, Runsheng Yu<sup class="author-affiliation-marker">2</sup>',
    )
    expect(content).toContain(
      '<p class="affiliations"><span class="affiliation"><sup class="affiliation-marker">1</sup>Example University,</span><br /><span class="affiliation"><sup class="affiliation-marker">2</sup>Example Laboratory</span></p>',
    )
    expect(content).not.toContain('University,;')
    expect(content).toContain('href="#author-noteref-1"')
  })

  it('applies one shared numbered affiliation to every author when explicit author mappings are absent', () => {
    const sharedAffiliationPaper = structuredClone(paper)
    sharedAffiliationPaper.authors = ['Minyoung Huh', 'Brian Cheung']
    sharedAffiliationPaper.authorAffiliations = []
    sharedAffiliationPaper.affiliations = [
      '1 Massachusetts Institute of Technology',
    ]

    const content = renderPublicationXhtml(sharedAffiliationPaper)

    expect(content).toContain(
      'Minyoung Huh<sup class="author-affiliation-marker">1</sup>, Brian Cheung<sup class="author-affiliation-marker">1</sup>',
    )
  })

  it('recovers a shared affiliation marker embedded in a common symbolic author note', () => {
    const sharedNotePaper = structuredClone(paper)
    sharedNotePaper.authors = ['Minyoung Huh', 'Brian Cheung']
    sharedNotePaper.authorAffiliations = []
    sharedNotePaper.affiliations = []
    sharedNotePaper.authorNotes = sharedNotePaper.authors.map(
      (author, index) => ({
        id: `shared-note-reference-${index + 1}`,
        author,
        label: '*',
        target: 'shared-author-note',
      }),
    )
    const noteText = 'Equal contribution 1MIT. Correspondence to: Minyoung Huh.'
    const markerStart = noteText.indexOf('1')
    sharedNotePaper.nodes = [
      {
        id: 'shared-author-note',
        type: 'footnote',
        kind: 'footnote',
        label: '*',
        text: noteText,
        inlineRuns: [
          {
            start: markerStart,
            end: markerStart + 1,
            verticalAlign: 'superscript',
          },
        ],
        relationships: {
          backlinks: sharedNotePaper.authorNotes.map(
            (reference) => reference.id,
          ),
        },
        source: 'synthetic-shared-author-note',
      },
    ]

    const content = renderPublicationXhtml(sharedNotePaper)

    expect(content).toContain('Minyoung Huh<sup class="author-note-marker">')
    expect(content).toContain(
      '</a></sup><sup class="author-affiliation-marker">1</sup>',
    )
    expect(content).toContain('Brian Cheung<sup class="author-note-marker">')
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
        id: 'reconstructed-author-note-1',
        type: 'footnote',
        kind: 'footnote',
        label: '*',
        text: 'Work done during the internship.',
        relationships: { backlinks: ['reconstructed-author-noteref-1'] },
        source: 'pdf:synthetic#page=1',
      },
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
    ]
    const reconstruction = {
      readiness: { ready: true },
      visualRelationships: [],
      assets: [],
    } as unknown as PdfReconstruction

    const content = renderPublicationXhtml(notePaper, { reconstruction })

    expect(content).toContain(
      'Yeyong Yu<sup class="author-note-marker"><a id="reconstructed-author-noteref-1" href="#reconstructed-author-note-1" epub:type="noteref" role="doc-noteref">*</a></sup>, Runsheng Yu',
    )
    expect(content).toContain('href="#reconstructed-author-noteref-1"')
    expect(content.indexOf('id="canonical-title-node"')).toBeLessThan(
      content.indexOf('class="authors"'),
    )
    expect(content.indexOf('class="authors"')).toBeLessThan(
      content.indexOf('id="reconstructed-author-note-1"'),
    )
    expect(content.indexOf('id="reconstructed-author-note-1"')).toBeLessThan(
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
      '<span class="note-label" data-semantic-ledger-ignore="true">Footnote 1. </span>The exact source marker remains rendered.',
    )
  })
})
