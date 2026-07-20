import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DocumentReconstruction } from '../../research/import-types'
import type { ResearchPaper } from '../../research/schema'
import ResearchStudio from './ResearchStudio'

const paper: ResearchPaper = {
  id: 'imported-paper',
  version: '1.0.0',
  status: 'review',
  title: 'Imported manuscript',
  subtitle: 'A source-backed preview',
  authors: ['Local author'],
  updated: '2026-07-20',
  abstract: 'The reconstructed abstract.',
  nodes: [
    {
      id: 'section-one',
      type: 'heading',
      level: 1,
      source: 'word/document.xml',
      text: 'Known semantics',
    },
    {
      id: 'rich-paragraph',
      type: 'paragraph',
      source: 'word/document.xml',
      text: 'Bold italic linked 1',
      inlineRuns: [
        { start: 0, end: 4, bold: true },
        { start: 5, end: 11, italic: true },
        { start: 12, end: 18, href: 'https://example.com/source' },
      ],
      noteReferences: [
        {
          id: 'note-reference-1',
          label: '1',
          target: 'note-1',
          start: 19,
          end: 20,
          confidence: 1,
        },
      ],
    },
    {
      id: 'unsafe-link',
      type: 'paragraph',
      source: 'word/document.xml',
      text: 'Unsafe',
      inlineRuns: [{ start: 0, end: 6, href: 'javascript:alert(1)' }],
    },
    {
      id: 'list-one',
      type: 'paragraph',
      source: 'word/document.xml',
      text: 'First item',
      list: { level: 1, ordered: true, numberingId: '7' },
    },
    {
      id: 'list-two',
      type: 'paragraph',
      source: 'word/document.xml',
      text: 'Nested item',
      list: { level: 2, ordered: false, numberingId: '7' },
    },
    {
      id: 'table-one',
      type: 'figure',
      source: 'word/document.xml',
      title: 'Table 1',
      objectType: 'table',
      table: {
        rows: [
          {
            cells: [
              {
                text: 'Measure',
                header: true,
                columnSpan: 1,
                rowSpan: 1,
              },
              {
                text: 'Value',
                header: true,
                columnSpan: 1,
                rowSpan: 1,
              },
            ],
          },
          {
            cells: [
              {
                text: 'Accuracy',
                header: false,
                columnSpan: 1,
                rowSpan: 1,
              },
              {
                text: '98%',
                header: false,
                columnSpan: 1,
                rowSpan: 1,
              },
            ],
          },
        ],
      },
      relationships: { caption: 'table-caption', assets: ['table-asset'] },
    },
    {
      id: 'table-caption',
      type: 'caption',
      source: 'word/document.xml',
      text: 'Table 1. Complete accepted caption.',
    },
    {
      id: 'note-1',
      type: 'footnote',
      kind: 'footnote',
      label: '1',
      text: 'Typed note body.',
      source: 'word/footnotes.xml',
      relationships: { backlinks: ['note-reference-1'] },
    },
  ],
}

const hostileXhtml =
  '<script>globalThis.pwned=true</script><img src="https://tracker.invalid/pixel" />'

const reconstruction = {
  source: {
    fileName: 'structured-manuscript.docx',
    byteLength: 2048,
    sha256: 'a'.repeat(64),
    pageCount: 0,
    localOnly: true,
    format: 'docx',
    packageParts: ['word/document.xml'],
    importerVersion: '1.0.0',
  },
  paper,
  pages: [],
  regions: [],
  readingOrder: {
    schemaVersion: '1.0.0',
    algorithm: 'explicit-ooxml-v1',
    mode: 'explicit-structure',
    regionIds: [],
    order: [],
    edges: [],
    resolutions: [],
    acyclic: true,
    evaluation: {
      schemaVersion: '1.0.0',
      algorithm: 'explicit-ooxml-v1',
      mode: 'explicit-structure',
      regionCount: 0,
      acceptedEdgeCount: 0,
      unresolvedEdgeCount: 0,
      cycleRate: 0,
      orderAccuracy: 1,
      provider: null,
      modelVersion: null,
      latencyMs: 0,
      costUsd: 0,
      reviewRequired: false,
    },
  },
  noteRelationships: [],
  visualRelationships: [
    {
      id: 'table-relationship',
      kind: 'table',
      label: 'Table 1',
      captionRegionId: 'table-caption',
      sourceRegionIds: [],
      sourceObjectIds: ['table-object'],
      assetIds: ['table-asset'],
      status: 'matched',
      confidence: 1,
      evidence: ['ooxml-explicit-table'],
      candidates: [],
      sourceBoxes: [],
      sourceText: 'Measure Value Accuracy 98%',
      altText: 'Table 1. Complete accepted caption.',
      altTextSource: 'caption',
      canonicalNodeId: 'table-one',
      captionNodeId: 'table-caption',
    },
  ],
  assets: [
    {
      id: 'table-asset',
      href: 'assets/hostile.xhtml',
      mediaType: 'application/xhtml+xml',
      kind: 'table',
      rendition: 'semantic-table',
      sha256: 'b'.repeat(64),
      bytes: new TextEncoder().encode(hostileXhtml),
      width: 2,
      height: 2,
      resolutionDpi: null,
      sourceObjectIds: ['table-object'],
      sourceBoxes: [],
    },
  ],
  provenance: {},
  diagnostics: [],
  semanticSignals: {
    captions: 1,
    tables: 1,
    equations: 0,
    footnoteReferences: 1,
    footnotes: 1,
  },
  completeness: {
    textCoverage: 1,
    assetCoverage: 1,
    relationshipCoverage: 1,
  },
  readiness: {
    status: 'ready',
    ready: true,
    policy: {},
    blockingDiagnosticCodes: [],
  },
} as unknown as DocumentReconstruction

describe('imported publication preview', () => {
  it('renders canonical semantics without executing or embedding XHTML assets', () => {
    const markup = renderToStaticMarkup(
      <ResearchStudio reconstruction={reconstruction} />,
    )

    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('data-target-profile="mobile"')
    expect(markup).not.toContain('Paper Pro')
    expect(markup).not.toContain('Print / PDF')
    expect(markup).toContain('<strong>Bold</strong>')
    expect(markup).toContain('<em>italic</em>')
    expect(markup).toContain('href="https://example.com/source"')
    expect(markup).not.toContain('href="javascript:')
    expect(markup).toContain('role="doc-noteref"')
    expect(markup).toContain('role="doc-footnote"')
    expect(markup).toContain('href="#note-reference-1"')
    expect(markup).toContain('<ol')
    expect(markup).toContain('<ul')
    expect(markup).toContain('<table')
    expect(markup).toContain('<th')
    expect(markup).toContain('Complete accepted caption.')
    expect(markup).not.toContain(hostileXhtml)
    expect(markup).not.toContain('tracker.invalid')
    expect(markup).not.toMatch(
      /<script|<object|<iframe|dangerouslySetInnerHTML/i,
    )
    expect(markup).not.toContain('Semantic composition pipeline')
    expect(markup).not.toContain('srt-annotations')
  })

  it('preserves repeated asset occurrences and fails XHTML closed without a canonical table', () => {
    const repeated = {
      ...reconstruction,
      visualRelationships: reconstruction.visualRelationships.map(
        (relationship) => ({
          ...relationship,
          assetIds: ['table-asset', 'table-asset'],
        }),
      ),
    } as DocumentReconstruction
    const repeatedMarkup = renderToStaticMarkup(
      <ResearchStudio reconstruction={repeated} />,
    )
    expect(repeatedMarkup.match(/data-semantic-table="true"/g)).toHaveLength(2)
    expect(repeatedMarkup).toContain('data-asset-occurrence="0"')
    expect(repeatedMarkup).toContain('data-asset-occurrence="1"')

    const withoutCanonicalTable = {
      ...reconstruction,
      paper: {
        ...paper,
        nodes: paper.nodes.map((node) =>
          node.id === 'table-one'
            ? ({ ...node, table: undefined } as unknown as typeof node)
            : node,
        ),
      },
    } as DocumentReconstruction
    const unresolvedMarkup = renderToStaticMarkup(
      <ResearchStudio reconstruction={withoutCanonicalTable} />,
    )
    expect(unresolvedMarkup).toContain('srt-visual-unresolved')
    expect(unresolvedMarkup).not.toContain('<table')
    expect(unresolvedMarkup).not.toMatch(/<object|<iframe|tracker.invalid/i)
  })
})
