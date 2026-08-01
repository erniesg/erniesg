import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildStructDocument } from './from-reconstruction'
import { buildStructEpub } from './epub'
import { renderPublicationXhtml } from './xhtml'
import { orderBlocksByLayout } from './reading-order'
import { diagnosticCopy, recoverySummary } from './recovery'
import type { StructBlock } from './types'
import { reconstructDocx } from '../research/docx-import'
import {
  buildEpub as buildPublicEpub,
  renderPublicationXhtml as renderPublicXhtml,
} from '../research/epub'

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
      '6d2a3caa10db878156972cdfef60a398aa6879a7dea36008fdcd3ea2b71ba971',
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
    expect(renderPublicationXhtml(graph)).toContain(
      `href="#${target.id}"`,
    )
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
      title: 'A figure or diagram was kept as source artwork',
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
        },
        {
          code: 'UNRESOLVED_HYPERLINK',
          severity: 'error',
          message: 'internal message',
        },
      ],
    })
    expect(summary.title).toBe('Your readable EPUB is ready for review.')
    expect(summary.issues.map(({ category }) => category)).toEqual([
      'visuals',
      'links',
    ])
    expect(summary.summary).not.toContain('UNRESOLVED_')
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
