import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildStructDocument } from './from-reconstruction'
import { orderBlocksByLayout } from './reading-order'
import { diagnosticCopy, recoverySummary } from './recovery'
import type { StructBlock } from './types'
import { reconstructDocx } from '../research/docx-import'

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
