import { describe, expect, it } from 'vitest'
import publication from '../../../tests/fixtures/payload/publication.json'
import mapping from '../../../tests/fixtures/payload/mapping.json'
import {
  adaptPayloadLexical,
  adaptPayloadLexicalEditions,
  payloadMappingPolicySchema,
} from './payload-lexical'

describe('Payload Lexical publication adapter', () => {
  it('maps typed Lexical content, marks, blocks, relationships, and assets', async () => {
    const result = adaptPayloadLexical(publication, mapping)
    expect(result.provenance).toMatchObject({
      adapterId: 'payload-lexical',
      sourceType: 'payload',
      sourceId: 'payload:payload-equivalent:en',
      mappingVersion: '1.0.0',
    })
    expect(result.graph.metadata).toMatchObject({
      title: 'Payload parity fixture',
      abstract: expect.stringContaining('deterministic'),
      contributors: ['Ada Lovelace'],
      defaultLocale: 'en',
      status: 'published',
    })
    expect(result.graph.nodes.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'quote',
      'list',
      'list-item',
      'list-item',
      'figure',
      'reference',
      'aside',
      'reference',
    ])
    const paragraph = result.graph.nodes.find((node) => node.type === 'paragraph')
    expect(paragraph?.inlineRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bold: true }),
        expect.objectContaining({ italic: true }),
        expect.objectContaining({ href: 'https://example.com' }),
      ]),
    )
    expect(result.assetBundle.descriptor.assets[0]).toMatchObject({
      mediaType: 'image/svg+xml',
      width: 24,
      height: 24,
      focalPoint: { x: 0.5, y: 0.5 },
    })
    await expect(
      result.assetBundle.resolveBytes(result.assetBundle.descriptor.assets[0]),
    ).resolves.toBeInstanceOf(Uint8Array)
  })

  it('derives deterministic ids and records their origin', () => {
    const input = {
      id: 'derived-fixture',
      title: 'Derived',
      locale: 'en',
      content: { root: { children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Stable' }] }] } },
    }
    const first = adaptPayloadLexical(input)
    const second = adaptPayloadLexical(input)
    expect(first.graph.nodes.map((node) => node.id)).toEqual(second.graph.nodes.map((node) => node.id))
    expect(first.graph.nodes[0].provenance.idOrigin).toBe('derived')
    expect(first.graph.nodes[0].provenance.evidence[0]).toContain('content.root.children[0]')
  })

  it('fails closed for unknown nodes and executable mapping data', () => {
    expect(() =>
      adaptPayloadLexical({
        id: 'unsupported',
        title: 'Unsupported',
        content: { root: { children: [{ type: 'mystery', children: [] }] } },
      }),
    ).toThrow(/Unsupported Lexical node mystery.*content\.root\.children\[0\]/)
    expect(() =>
      payloadMappingPolicySchema.parse({
        hooks: 'run-this',
      }),
    ).toThrow()
    expect(() =>
      adaptPayloadLexical({
        id: 'unsafe',
        title: 'Unsafe',
        content: { root: { children: [] } },
        mapping: { fields: { title: () => 'executed' } },
      }),
    ).toThrow(/executable/)
  })

  it('maps explicitly configured Payload blocks and relationships without executing them', () => {
    const result = adaptPayloadLexical(
      {
        id: 'configured-blocks',
        title: 'Configured blocks',
        content: {
          root: {
            children: [
              { type: 'block', fields: { blockType: 'notice', text: 'Notice' } },
              {
                type: 'block',
                fields: {
                  blockType: 'grid',
                  rows: [{ cells: [{ text: 'Header', header: true }, { text: 'Value' }] }],
                },
              },
              { type: 'citation', value: 'target-1', label: 'A citation' },
            ],
          },
        },
      },
      { blocks: { notice: 'aside', grid: 'table' }, relationships: { citation: { role: 'citation' } } },
    )
    expect(result.graph.nodes.map((node) => node.type)).toEqual(['aside', 'table', 'reference', 'reference'])
    expect(result.graph.nodes.find((node) => node.type === 'reference')).toMatchObject({ href: '#target-1' })
  })

  it('declares missing uploads and keeps locales as separate editions', () => {
    const missing = adaptPayloadLexical({
      id: 'missing',
      title: 'Missing',
      content: { root: { children: [{ type: 'upload', id: 'missing-upload', value: 'not-present' }] } },
      uploads: [{ id: 'not-present', filename: 'missing.png', mimeType: 'image/png' }],
    })
    expect(missing.diagnostics.map((diagnostic) => diagnostic.code)).toContain('missing-asset')
    expect(missing.graph.nodes[0]).toMatchObject({ type: 'figure', assetIds: [] })
    const editions = adaptPayloadLexicalEditions(publication, mapping)
    expect(editions.map((edition) => edition.graph.edition.locale)).toEqual(['en', 'fr'])
    expect(editions[1].graph.metadata.title).toBe('Fixture de parité Payload')
    const fallback = adaptPayloadLexical({
      document: publication,
      mapping: { ...mapping, fallbackLocale: 'en' },
      locale: 'de',
    })
    expect(fallback.graph.edition.locale).toBe('en')
    expect(fallback.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'locale-fallback' })]))
    expect(fallback.graph.nodes[0].provenance.evidence).toContain('locale-fallback:de->en')
  })
})
