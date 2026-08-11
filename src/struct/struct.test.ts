import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildStructDocument } from './from-reconstruction'
import { buildStructEpub } from './epub'
import { renderPublicationXhtml } from './xhtml'
import { orderBlocksByLayout } from './reading-order'
import {
  diagnosticCopy,
  hasActionableRecovery,
  recoverySummary,
} from './recovery'
import type { PdfReconstruction } from '../research/import-types'
import type { StructBlock } from './types'
import { reconstructDocx } from '../research/docx-import'
import {
  buildEpub as buildPublicEpub,
  renderPublicationXhtml as renderPublicXhtml,
} from '../research/epub'
import { reconstructPageAnalyses } from '../research/pdf-layout'
import { ambiguousNoteMarkerFixture } from '../../tests/fixtures/note-marker-fixtures'

async function structuredDocx() {
  const bytes = await readFile(
    new URL(
      '../../tests/fixtures/docx/structured-manuscript.docx',
      import.meta.url,
    ),
  )
  return reconstructDocx(
    new File([bytes], 'structured-manuscript.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
  )
}

describe('STRUCT canonical document graph', () => {
  it('adapts a structured DOCX without exposing source-specific node types', async () => {
    const reconstruction = await structuredDocx()
    const graph = buildStructDocument(reconstruction)
    const sourceAnnotationCount = reconstruction.paper.nodes.reduce(
      (count, node) =>
        count + (reconstruction.provenance?.[node.id]?.links.length ?? 0),
      0,
    )
    const sourceRelationshipCount =
      reconstruction.visualRelationships.length +
      reconstruction.noteRelationships.length +
      sourceAnnotationCount

    expect(graph.schemaVersion).toBe('0.1.0')
    expect(graph.source.format).toBe('docx')
    expect(graph.source.localOnly).toBe(true)
    expect(graph.blocks.some((block) => block.kind === 'heading')).toBe(true)
    expect(graph.blocks.some((block) => block.kind === 'table')).toBe(true)
    expect(graph.assets.some((asset) => asset.kind === 'table')).toBe(true)
    expect(
      graph.relationships.some(
        (relationship) => relationship.kind === 'footnote',
      ),
    ).toBe(true)
    expect(
      graph.relationships.some(
        (relationship) => relationship.kind === 'hyperlink',
      ),
    ).toBe(true)
    expect(graph.receipt).toMatchObject({
      sourceSha256: reconstruction.source.sha256,
      blockCount: graph.blocks.length,
      assetCount: graph.assets.length,
      textCharacterCount: graph.blocks.reduce(
        (count, block) => count + block.text.length,
        0,
      ),
    })
    expect(graph.receipt.conservation).toMatchObject({
      sourceNodeCount: reconstruction.paper.nodes.length,
      accountedSourceNodeCount: reconstruction.paper.nodes.length,
      sourceAssetCount: reconstruction.assets.length,
      accountedSourceAssetCount: reconstruction.assets.length,
      sourceRegionCount: 0,
      accountedSourceRegionCount: 0,
      sourceRelationshipCount,
      accountedSourceRelationshipCount: sourceRelationshipCount,
      sourceDiagnosticCount: reconstruction.diagnostics.length,
      accountedSourceDiagnosticCount: reconstruction.diagnostics.length,
      sourceTextCharacterCount: graph.receipt.textCharacterCount,
      structBlockCount: graph.blocks.length,
      structAssetCount: graph.assets.length,
      structRelationshipCount: graph.relationships.length,
      structDiagnosticCount: graph.diagnostics.length,
      structTextCharacterCount: graph.receipt.textCharacterCount,
    })
  })

  it('is deterministic for the same source graph', async () => {
    const first = buildStructDocument(await structuredDocx())
    const second = buildStructDocument(await structuredDocx())
    expect(first.receipt.generatedSha256).toBe(second.receipt.generatedSha256)
    expect(first.blocks.map(({ id }) => id)).toEqual(
      second.blocks.map(({ id }) => id),
    )
    expect(first.assets.map(({ id }) => id)).toEqual(
      second.assets.map(({ id }) => id),
    )
  })

  it('uses only graph node, asset, or external destinations in relationships', async () => {
    const graph = buildStructDocument(await structuredDocx())
    const localIds = new Set([
      ...graph.blocks.map(({ id }) => id),
      ...graph.assets.map(({ id }) => id),
    ])
    for (const relationship of graph.relationships) {
      expect(localIds.has(relationship.from)).toBe(true)
      for (const target of relationship.to) {
        expect(
          localIds.has(target) ||
            target.startsWith('#') ||
            /^[a-z][a-z0-9+.-]*:/i.test(target),
        ).toBe(true)
      }
    }
  })

  it('addresses packaged assets by digest instead of hashing their bytes twice', async () => {
    const reconstruction = await structuredDocx()
    const first = buildStructDocument(reconstruction)
    const second = buildStructDocument({
      ...reconstruction,
      assets: reconstruction.assets.map((asset) => ({
        ...asset,
        bytes: new Uint8Array(asset.bytes.length).fill(17),
      })),
    })
    expect(second.receipt.generatedSha256).toBe(first.receipt.generatedSha256)
  })

  it('pins the structured DOCX receipt', async () => {
    const graph = buildStructDocument(await structuredDocx())
    expect(graph.receipt.generatedSha256).toBe(
      '7756fff21303bee4c87652126a403d89c450e2139ba9cc6ad62e61b8325baca7',
    )
  })

  it('renders XHTML directly from the source-agnostic graph', async () => {
    const graph = buildStructDocument(await structuredDocx())
    const xhtml = renderPublicationXhtml(graph)
    expect(xhtml).toContain(`<title>${graph.metadata.title}</title>`)
    expect(xhtml).toContain(`data-struct-id="${graph.blocks[0].id}"`)
    expect(xhtml).not.toContain('sourceNodeId')
  })

  it('renders a STRUCT internal target as a fragment link', async () => {
    const graph = buildStructDocument(await structuredDocx())
    const target = graph.blocks[1]
    graph.blocks[0] = {
      ...graph.blocks[0],
      text: 'See target',
      inline: [{ start: 0, end: 10, targetIds: [target.id] }],
    }
    expect(renderPublicationXhtml(graph)).toContain(`href="#${target.id}"`)
  })

  it('preserves semantic inline targets without a relationship entry', async () => {
    const graph = buildStructDocument(await structuredDocx())
    const source = graph.blocks[0]
    const target = graph.blocks[1]
    source.text = 'See target'
    source.inline = [
      {
        start: 4,
        end: source.text.length,
        relationshipId: 'detached-cross-reference',
        semanticRole: 'cross-reference',
        targetIds: [target.id],
      },
    ]

    expect(renderPublicationXhtml(graph)).toContain(
      `<a id="detached-cross-reference" href="#${target.id}" data-semantic-role="cross-reference" data-relationship-id="detached-cross-reference" data-target-ids="${target.id}">target</a>`,
    )
  })

  it('round-trips matched footnotes and endnotes with typed links and backlinks', async () => {
    const graph = buildStructDocument(await structuredDocx())
    const noteRelationships = graph.relationships.filter(
      (relationship) =>
        relationship.kind === 'footnote' || relationship.kind === 'endnote',
    )
    const noteRuns = graph.blocks.flatMap((block) =>
      block.inline.filter((inline) => inline.semanticRole === 'note-reference'),
    )

    expect(noteRelationships.map((relationship) => relationship.kind)).toEqual(
      expect.arrayContaining(['footnote', 'endnote']),
    )
    expect(noteRuns).toHaveLength(2)
    expect(
      noteRuns.every((run) =>
        noteRelationships.some(
          (relationship) => relationship.id === run.relationshipId,
        ),
      ),
    ).toBe(true)

    const xhtml = renderPublicationXhtml(graph)
    for (const relationship of noteRelationships) {
      expect(xhtml).toContain(
        `id="${relationship.id}" href="#${relationship.to[0]}" epub:type="noteref" role="doc-noteref"`,
      )
      expect(xhtml).toContain(
        `href="#${relationship.id}" class="note-backlink"`,
      )
    }
    expect(xhtml).toContain('role="doc-footnote"')
    expect(xhtml).toContain('role="doc-endnote"')
  })

  it('retains every ambiguous note candidate without creating a false link', async () => {
    const reconstruction = await reconstructPageAnalyses({
      pages: ambiguousNoteMarkerFixture.pages,
      sourceHash: 'a'.repeat(64),
      fileName: 'ambiguous-note-marker.pdf',
      byteLength: 4096,
      metadata: {},
    })
    const sourceRelationship = reconstruction.noteRelationships.find(
      (candidate) => candidate.status === 'ambiguous',
    )!

    const graph = buildStructDocument(reconstruction)
    const ambiguous = graph.relationships.find(
      (candidate) =>
        candidate.status === 'ambiguous' && candidate.kind === 'footnote',
    )!
    expect(ambiguous.to).toEqual([])
    expect(ambiguous.candidates).toHaveLength(2)
    expect(ambiguous.candidates?.map((candidate) => candidate.target)).toEqual(
      expect.arrayContaining(
        sourceRelationship.candidates.map(
          (candidate) =>
            graph.blocks.find((block) =>
              block.evidence.sourceIds.includes(candidate.targetNoteId),
            )!.id,
        ),
      ),
    )
    expect(
      ambiguous.candidates?.every(
        (candidate) =>
          candidate.evidence.signals?.includes('label-exact') === true &&
          candidate.evidence.boxes.length >= 2 &&
          candidate.evidence.sourceIds.length >= 3,
      ),
    ).toBe(true)

    const owner = graph.blocks.find((block) => block.id === ambiguous.from)!
    expect(
      graph.blocks.filter((block) => block.id === ambiguous.from),
    ).toHaveLength(1)
    const marker = owner.inline.find(
      (inline) => inline.relationshipId === ambiguous.id,
    )!
    expect(marker).toMatchObject({
      semanticRole: 'note-reference',
    })
    expect(marker.targetIds ?? []).toEqual([])
    expect(owner.text.slice(marker.start, marker.end)).toBe(ambiguous.label)

    const xhtml = renderPublicationXhtml(graph)
    expect(xhtml).toContain(
      `<span id="${ambiguous.id}" data-semantic-role="note-reference"`,
    )
    expect(xhtml).not.toContain(`<a id="${ambiguous.id}"`)
    for (const candidate of ambiguous.candidates ?? []) {
      expect(xhtml).not.toContain(`href="#${candidate.target}"`)
    }
  })

  it('anchors every target represented by a grouped STRUCT citation', async () => {
    const graph = buildStructDocument(await structuredDocx())
    const source = graph.blocks[1]
    const targets = graph.blocks.slice(2, 5).map((block) => block.id)
    const relationshipId = 'struct-relationship-grouped-citation'
    source.text = '[1–3]'
    source.inline = [
      {
        start: 0,
        end: source.text.length,
        relationshipId,
        semanticRole: 'citation',
        targetIds: targets,
      },
    ]
    graph.relationships.push({
      id: relationshipId,
      kind: 'citation',
      from: source.id,
      to: targets,
      label: '1,2,3',
      status: 'matched',
      confidence: 1,
      evidence: { confidence: 1, pages: [], boxes: [], sourceIds: [] },
    })

    const xhtml = renderPublicationXhtml(graph)
    for (const target of targets) {
      expect(xhtml).toContain(`href="#${target}"`)
    }
    expect(xhtml).toContain(
      `[<a href="#${targets[0]}" epub:type="biblioref" role="doc-biblioref">1</a>–<a href="#${targets[2]}" epub:type="biblioref" role="doc-biblioref">3</a>]`,
    )
    expect(xhtml).not.toContain(`href="#${targets[0]}">[1–3]</a>`)
    expect(xhtml).toContain('epub:type="biblioref" role="doc-biblioref"')
  })

  it('keeps styled Unicode ranges and author-year groups visibly linked', async () => {
    const unicodeGraph = buildStructDocument(await structuredDocx())
    const unicodeSource = unicodeGraph.blocks[1]
    const unicodeTargets = unicodeGraph.blocks.slice(2, 5).map(({ id }) => id)
    unicodeSource.text = '[١–٣]'
    unicodeSource.inline = [
      {
        start: 0,
        end: unicodeSource.text.length,
        relationshipId: 'styled-unicode-range',
        semanticRole: 'citation',
        targetIds: unicodeTargets,
      },
      { start: 1, end: 2, bold: true },
    ]
    unicodeGraph.relationships.push({
      id: 'styled-unicode-range',
      kind: 'citation',
      from: unicodeSource.id,
      to: unicodeTargets,
      label: '1,2,3',
      status: 'matched',
      confidence: 1,
      evidence: { confidence: 1, pages: [], boxes: [], sourceIds: [] },
    })
    const unicodeXhtml = renderPublicationXhtml(unicodeGraph)
    expect(unicodeXhtml).toContain(
      `<strong><a href="#${unicodeTargets[0]}" epub:type="biblioref" role="doc-biblioref">١</a></strong>`,
    )
    expect(unicodeXhtml).toContain(
      `href="#${unicodeTargets[2]}" epub:type="biblioref" role="doc-biblioref">٣</a>`,
    )
    expect(unicodeXhtml).toContain(
      `href="#${unicodeTargets[1]}" epub:type="biblioref" role="doc-biblioref" class="additional-semantic-reference"`,
    )

    const authorYearGraph = buildStructDocument(await structuredDocx())
    const authorYearSource = authorYearGraph.blocks[1]
    const authorYearTargets = authorYearGraph.blocks
      .slice(2, 4)
      .map(({ id }) => id)
    authorYearSource.text = '(Smith et al., 2020; Jones, 2021)'
    const styledAuthorStart = authorYearSource.text.indexOf('et al.')
    authorYearSource.inline = [
      {
        start: 0,
        end: authorYearSource.text.length,
        relationshipId: 'author-year-group',
        semanticRole: 'citation',
        targetIds: authorYearTargets,
      },
      {
        start: styledAuthorStart,
        end: styledAuthorStart + 'et al.'.length,
        italic: true,
      },
    ]
    authorYearGraph.relationships.push({
      id: 'author-year-group',
      kind: 'citation',
      from: authorYearSource.id,
      to: authorYearTargets,
      label: 'smith:2020,jones:2021',
      status: 'matched',
      confidence: 1,
      evidence: { confidence: 1, pages: [], boxes: [], sourceIds: [] },
    })
    const authorYearXhtml = renderPublicationXhtml(authorYearGraph)
    expect(authorYearXhtml).toContain(
      `href="#${authorYearTargets[0]}" epub:type="biblioref" role="doc-biblioref">2020</a>`,
    )
    expect(authorYearXhtml).toContain(
      `href="#${authorYearTargets[1]}" epub:type="biblioref" role="doc-biblioref">2021</a>`,
    )
    expect(authorYearXhtml).toContain('<em>et al.</em>')
    expect(authorYearXhtml).not.toContain('Additional citation target')
  })

  it('preserves typed bibliography and table-cell relationship metadata', async () => {
    const reconstruction = await structuredDocx()
    const listNode = reconstruction.paper.nodes.find(
      (node) => node.type === 'paragraph' && node.list,
    )
    if (!listNode || listNode.type !== 'paragraph' || !listNode.list) {
      throw new Error('The structured DOCX fixture must contain a list item')
    }
    listNode.list.numberingId = 'references'
    const tableNode = reconstruction.paper.nodes.find(
      (node) => node.type === 'figure' && node.table,
    )
    if (!tableNode || tableNode.type !== 'figure' || !tableNode.table) {
      throw new Error('The structured DOCX fixture must contain a table')
    }
    const cell = tableNode.table.rows[0].cells[0]
    cell.inlineRuns = [
      {
        start: 0,
        end: Math.min(1, cell.text.length),
        relationshipId: 'cell-citation',
        semanticRole: 'citation',
        targetIds: [listNode.id],
      },
    ]

    const graph = buildStructDocument(reconstruction)
    expect(
      graph.blocks.find((block) =>
        block.evidence.sourceIds.includes(listNode.id),
      )?.attributes,
    ).toMatchObject({ bibliographyEntry: true })
    expect(
      graph.blocks.find((block) => block.kind === 'table')?.table?.cells[0]
        .inline[0],
    ).toMatchObject({
      relationshipId: 'cell-citation',
      semanticRole: 'citation',
      targetIds: [
        graph.blocks.find((block) =>
          block.evidence.sourceIds.includes(listNode.id),
        )!.id,
      ],
    })
  })

  it('keeps delimiter-bearing table-cell note identities distinct', async () => {
    const reconstruction = await structuredDocx()
    const tableNode = reconstruction.paper.nodes.find(
      (node) => node.type === 'figure' && node.table,
    )
    const noteTemplate = reconstruction.noteRelationships.find(
      (relationship) =>
        relationship.status === 'matched' && relationship.targetNoteId,
    )
    if (!tableNode || tableNode.type !== 'figure' || !tableNode.table) {
      throw new Error('The structured DOCX fixture must contain a table')
    }
    if (!noteTemplate?.targetNoteId) {
      throw new Error('The structured DOCX fixture must contain a matched note')
    }

    const tableCellNotes = [
      {
        row: 1,
        column: 0,
        id: 'table-cell-note-one',
        cellId: 'x',
        text: '6:xy',
        start: 0,
        end: 4,
        label: '6:xy',
      },
      {
        row: 2,
        column: 0,
        id: 'table-cell-note-two',
        cellId: 'x:0',
        text: '....xy',
        start: 4,
        end: 6,
        label: 'xy',
      },
    ].map(({ row, column, id, cellId, text, start, end, label }) => {
      const cell = tableNode.table!.rows[row].cells[column]
      cell.id = cellId
      cell.text = text
      cell.noteReferences = [
        {
          id,
          label,
          target: noteTemplate.targetNoteId!,
          start,
          end,
          confidence: 1,
        },
      ]
      return {
        ...noteTemplate,
        id,
        label,
        referenceStart: start,
        referenceEnd: end,
        canonicalAnchor: {
          kind: 'node' as const,
          nodeId: `${tableNode.id}:table:${cellId}`,
          start,
          end,
        },
      }
    })
    reconstruction.noteRelationships.push(...tableCellNotes)

    const graph = buildStructDocument(reconstruction)
    const tableBlock = graph.blocks.find((block) => block.kind === 'table')!
    const relationshipIds = tableBlock
      .table!.cells.filter(
        (cell) => cell.column === 0 && (cell.row === 1 || cell.row === 2),
      )
      .map(
        (cell) =>
          cell.inline.find((run) => run.semanticRole === 'note-reference')!
            .relationshipId!,
      )

    expect(new Set(relationshipIds).size).toBe(2)
    const cellRelationships = graph.relationships.filter((relationship) =>
      relationshipIds.includes(relationship.id),
    )
    expect(cellRelationships).toHaveLength(2)
    expect(
      cellRelationships.every(
        (relationship) => relationship.from === tableBlock.id,
      ),
    ).toBe(true)
    const xhtml = renderPublicationXhtml(graph)
    for (const relationshipId of relationshipIds) {
      expect(xhtml.split(` id="${relationshipId}"`)).toHaveLength(2)
    }
  })

  it.each(['citation', 'cross-reference'] as const)(
    'keeps delimiter-bearing table-cell %s identities distinct',
    async (kind) => {
      const reconstruction =
        (await structuredDocx()) as unknown as PdfReconstruction
      delete (reconstruction.source as { format?: string }).format
      reconstruction.citationRelationships = []
      reconstruction.crossReferenceRelationships = []
      const tableNode = reconstruction.paper.nodes.find(
        (node) => node.type === 'figure' && node.table,
      )
      const targetNode = reconstruction.paper.nodes.find(
        (node) => node.type === 'heading',
      )
      if (!tableNode || tableNode.type !== 'figure' || !tableNode.table) {
        throw new Error('The structured DOCX fixture must contain a table')
      }
      if (!targetNode) {
        throw new Error('The structured DOCX fixture must contain a heading')
      }

      const relationships = [
        {
          row: 1,
          column: 0,
          id: `table-cell-${kind}-one`,
          cellId: 'x',
          text: '6:xy',
          start: 0,
          end: 4,
          marker: '6:xy',
        },
        {
          row: 2,
          column: 0,
          id: `table-cell-${kind}-two`,
          cellId: 'x:0',
          text: '....xy',
          start: 4,
          end: 6,
          marker: 'xy',
        },
      ].map(({ row, column, id, cellId, text, start, end, marker }) => {
        const cell = tableNode.table!.rows[row].cells[column]
        cell.id = cellId
        const cellAnchorId = `${tableNode.id}:table:${cellId}`
        cell.text = text
        cell.inlineRuns = [
          {
            start,
            end,
            relationshipId: id,
            semanticRole: kind,
            targetIds: [targetNode.id],
          },
        ]
        return {
          id,
          cellAnchorId,
          marker,
          start,
          end,
          sourceBox: {
            page: 1,
            x: 0.1,
            y: 0.1 + row * 0.1,
            width: 0.1,
            height: 0.02,
            rotation: 0,
            method: 'pdf-text' as const,
          },
        }
      })
      if (kind === 'citation') {
        reconstruction.citationRelationships = relationships.map(
          ({ id, cellAnchorId, marker, start, end, sourceBox }) => ({
            id,
            label: marker,
            labels: [marker],
            referenceRegionId: `${id}-region`,
            referenceStart: start,
            referenceEnd: end,
            taxonomy: 'bracketed-bibliography-citation',
            targetNodeIds: [targetNode.id],
            status: 'matched',
            canonicalAnchor: {
              nodeId: cellAnchorId,
              start,
              end,
            },
            confidence: 1,
            evidence: ['fixture'],
            sourceBoxes: [sourceBox],
          }),
        )
      } else {
        reconstruction.crossReferenceRelationships = relationships.map(
          ({ id, cellAnchorId, marker, start, end, sourceBox }) => ({
            id,
            kind: 'section',
            text: marker,
            labels: [marker],
            referenceRegionId: `${id}-region`,
            referenceStart: start,
            referenceEnd: end,
            targets: [
              {
                kind: 'section',
                label: marker,
                referenceStart: start,
                referenceEnd: end,
                status: 'matched',
                candidateNodeIds: [targetNode.id],
                targetNodeId: targetNode.id,
                evidence: ['fixture'],
              },
            ],
            targetNodeIds: [targetNode.id],
            status: 'matched',
            canonicalAnchor: {
              nodeId: cellAnchorId,
              start,
              end,
            },
            confidence: 1,
            evidence: ['fixture'],
            sourceBoxes: [sourceBox],
          }),
        )
      }

      const graph = buildStructDocument(reconstruction)
      const tableBlock = graph.blocks.find((block) => block.kind === 'table')!
      const relationshipIds = tableBlock
        .table!.cells.filter(
          (cell) => cell.column === 0 && (cell.row === 1 || cell.row === 2),
        )
        .map(
          (cell) =>
            cell.inline.find((run) => run.semanticRole === kind)!
              .relationshipId!,
        )

      expect(new Set(relationshipIds).size).toBe(2)
      expect(
        graph.relationships
          .filter((relationship) => relationshipIds.includes(relationship.id))
          .every((relationship) => relationship.from === tableBlock.id),
      ).toBe(true)
      const xhtml = renderPublicationXhtml(graph)
      for (const relationshipId of relationshipIds) {
        expect(xhtml.split(` id="${relationshipId}"`)).toHaveLength(2)
      }
      await expect(buildStructEpub(graph)).resolves.toMatchObject({
        mediaType: 'application/epub+zip',
      })
    },
  )

  it('translates STRUCT fragment targets without rewriting explicit external links', async () => {
    const graph = buildStructDocument(await structuredDocx())
    const target = graph.blocks[1]
    graph.blocks[0] = {
      ...graph.blocks[0],
      text: 'Local External',
      inline: [
        { start: 0, end: 5, href: '#source-node', targetIds: [target.id] },
        {
          start: 6,
          end: 14,
          href: 'https://example.com',
          targetIds: [target.id],
        },
      ],
    }
    const xhtml = renderPublicationXhtml(graph)
    expect(xhtml).toContain(`href="#${target.id}"`)
    expect(xhtml).toContain('href="https://example.com"')
    expect(xhtml).not.toContain('href="#source-node"')
  })

  it('round-trips the graph into a deterministic EPUB package', async () => {
    const graph = buildStructDocument(await structuredDocx())
    const first = await buildStructEpub(graph)
    const second = await buildStructEpub(graph)
    expect(first.sha256).toBe(second.sha256)
    expect(first.identifier).toContain(graph.receipt.generatedSha256)
    expect(first.entries).toEqual(
      expect.arrayContaining([
        'mimetype',
        'EPUB/content.xhtml',
        'EPUB/struct.json',
      ]),
    )
  })

  it('exposes STRUCT at the existing renderer and EPUB entry points', async () => {
    const graph = buildStructDocument(await structuredDocx())
    expect(renderPublicXhtml(graph)).toBe(renderPublicationXhtml(graph))
    expect((await buildPublicEpub(graph)).sha256).toBe(
      (await buildStructEpub(graph)).sha256,
    )
  })

  it('keeps the renderer side of STRUCT independent from research modules', async () => {
    for (const file of ['types.ts', 'ids.ts', 'reading-order.ts', 'xhtml.ts']) {
      const source = await readFile(new URL(file, import.meta.url), 'utf8')
      expect(source).not.toMatch(/from ['"]\.\.\/research\//)
      expect(source).not.toContain('ResearchPaper')
      expect(source).not.toContain('Astro')
    }
  })
})

describe('STRUCT recovery language', () => {
  it('turns internal diagnostic codes into user-facing recovery guidance', () => {
    expect(diagnosticCopy('UNRESOLVED_VISUAL_OBJECT')).toMatchObject({
      category: 'visuals',
      title: 'A figure or diagram is missing from the readable export',
    })
    const summary = recoverySummary({
      ready: false,
      blockingCodes: ['UNRESOLVED_VISUAL_OBJECT', 'UNRESOLVED_HYPERLINK'],
      textCoverage: 1,
      assetCoverage: 0.8,
      relationshipCoverage: 0.9,
      diagnostics: [
        {
          code: 'UNRESOLVED_VISUAL_OBJECT',
          severity: 'error',
          message: 'internal message',
          automaticRecovery: true,
        },
        {
          code: 'UNRESOLVED_HYPERLINK',
          severity: 'error',
          message: 'internal message',
          automaticRecovery: true,
        },
      ],
    })
    expect(summary.title).toBe('Your EPUB is ready to read.')
    expect(summary.issues).toEqual([])
    expect(summary.summary).not.toContain('UNRESOLVED_')
    expect(summary.userAction).toBeUndefined()
    expect(hasActionableRecovery(summary)).toBe(false)
  })

  it('shows only deduplicated pages for diagnostics that require human action', () => {
    const summary = recoverySummary({
      ready: false,
      blockingCodes: ['LOW_CONFIDENCE_OCR', 'UNRESOLVED_VISUAL_OBJECT'],
      textCoverage: 0.98,
      assetCoverage: 1,
      relationshipCoverage: 1,
      diagnostics: [
        {
          code: 'LOW_CONFIDENCE_OCR',
          severity: 'warning',
          message: 'internal message',
          page: 4,
        },
        {
          code: 'LOW_CONFIDENCE_OCR',
          severity: 'warning',
          message: 'duplicate internal message',
          page: 4,
        },
        {
          code: 'LOW_CONFIDENCE_OCR',
          severity: 'warning',
          message: 'internal message',
          page: 9,
        },
        {
          code: 'UNRESOLVED_VISUAL_OBJECT',
          severity: 'error',
          message: 'source-preserved fallback',
          page: 9,
          automaticRecovery: true,
        },
      ],
    })

    expect(summary.issues).toEqual([
      expect.objectContaining({
        category: 'text',
        count: 2,
        pages: [4, 9],
        action: expect.stringContaining('Compare'),
      }),
    ])
    expect(summary.userAction).toContain('page 4, page 9')
    expect(hasActionableRecovery(summary)).toBe(true)
  })

  it('fails closed for missing visuals and unknown blockers', () => {
    const summary = recoverySummary({
      ready: false,
      blockingCodes: ['UNRESOLVED_VISUAL_OBJECT', 'FUTURE_BLOCKER'],
      textCoverage: 1,
      assetCoverage: 0.5,
      relationshipCoverage: 1,
      diagnostics: [
        {
          code: 'UNRESOLVED_VISUAL_OBJECT',
          severity: 'error',
          message: 'No packaged visual exists.',
          page: 3,
        },
        {
          code: 'FUTURE_BLOCKER',
          severity: 'error',
          message: 'An unknown invariant failed.',
          page: 8,
        },
      ],
    })

    expect(hasActionableRecovery(summary)).toBe(true)
    expect(summary.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'visuals', pages: [3] }),
        expect.objectContaining({ category: 'source', pages: [8] }),
      ]),
    )
    expect(summary.issues.every((issue) => Boolean(issue.action))).toBe(true)
  })

  it('does not merge different actions merely because they share a category', () => {
    const summary = recoverySummary({
      ready: false,
      blockingCodes: ['LOW_CONFIDENCE_OCR', 'INCOMPLETE_TEXT_COVERAGE'],
      textCoverage: 0.9,
      assetCoverage: 1,
      relationshipCoverage: 1,
      diagnostics: [
        {
          code: 'LOW_CONFIDENCE_OCR',
          severity: 'warning',
          message: 'ocr',
          pages: [2, 3],
        },
        {
          code: 'INCOMPLETE_TEXT_COVERAGE',
          severity: 'error',
          message: 'coverage',
          page: 7,
        },
      ],
    })

    expect(summary.issues).toHaveLength(2)
    expect(summary.issues.map((issue) => issue.pages)).toEqual([[2, 3], [7]])
    expect(new Set(summary.issues.map((issue) => issue.action)).size).toBe(2)
  })

  it('does not hide an unrecoverable file merely because no diagnostic was emitted', () => {
    const summary = recoverySummary({
      ready: false,
      textCoverage: 0,
      assetCoverage: 0,
      relationshipCoverage: 0,
      diagnostics: [],
    })

    expect(hasActionableRecovery(summary)).toBe(true)
    expect(summary.issues).toEqual([
      expect.objectContaining({
        category: 'source',
        action: expect.stringContaining('clearer original file'),
      }),
    ])
  })
})

describe('STRUCT geometry ordering', () => {
  function block(
    id: string,
    page: number,
    x: number,
    y: number,
    column: StructBlock['column'],
  ): StructBlock {
    return {
      id,
      kind: 'paragraph',
      text: id,
      page,
      order: 0,
      column,
      inline: [],
      evidence: {
        confidence: 1,
        pages: [page],
        boxes: [{ page, x, y, width: 100, height: 10, rotation: 0 }],
        sourceIds: [id],
      },
    }
  }

  it('reads each column top-to-bottom before moving to the next column', () => {
    const ordered = orderBlocksByLayout([
      block('right-1', 1, 300, 10, 'right'),
      block('left-2', 1, 10, 30, 'left'),
      block('left-1', 1, 10, 10, 'left'),
      block('right-2', 1, 300, 30, 'right'),
    ])
    expect(ordered.map(({ id }) => id)).toEqual([
      'left-1',
      'left-2',
      'right-1',
      'right-2',
    ])
  })
})
