import { describe, expect, it } from 'vitest'
import { publicationGraphSchema, serializePublicationGraph } from './schema'

const common = {
  locale: 'en',
  direction: 'ltr',
  requirement: 'required',
  importance: 'essential',
  provenance: { adapterId: 'test', sourceId: 'fixture', evidence: [] },
  accessibility: { decorative: false },
  variants: [],
  permittedTransformationIds: [],
  edition: { editionId: 'edition-en' },
}

export function graphFixture() {
  return {
    version: '1.0.0',
    id: 'publication',
    metadata: {
      title: 'Publication',
      contributors: ['Author'],
      defaultLocale: 'en',
      defaultDirection: 'ltr',
      keywords: [],
    },
    edition: { id: 'edition-en', locale: 'en', direction: 'ltr' },
    nodes: [
      { ...common, id: 'heading', type: 'heading', level: 1, text: 'Heading' },
      { ...common, id: 'paragraph', type: 'paragraph', text: 'Paragraph' },
      {
        ...common,
        id: 'list',
        type: 'list',
        ordered: false,
        itemIds: ['item'],
      },
      {
        ...common,
        id: 'item',
        type: 'list-item',
        parentListId: 'list',
        text: 'Item',
      },
      { ...common, id: 'quote', type: 'quote', text: 'Quote' },
      {
        ...common,
        id: 'code',
        type: 'code',
        code: 'const value = 1',
        language: 'ts',
      },
      {
        ...common,
        id: 'figure',
        type: 'figure',
        title: 'Figure',
        assetIds: [],
        captionId: 'figure-caption',
      },
      {
        ...common,
        id: 'figure-caption',
        type: 'caption',
        parentId: 'figure',
        text: 'Figure caption',
      },
      {
        ...common,
        id: 'table',
        type: 'table',
        captionId: 'table-caption',
        rows: [
          {
            cells: [
              { text: 'Cell', headerScope: null, columnSpan: 1, rowSpan: 1 },
            ],
          },
        ],
      },
      {
        ...common,
        id: 'table-caption',
        type: 'caption',
        parentId: 'table',
        text: 'Table caption',
      },
      {
        ...common,
        id: 'equation',
        type: 'equation',
        source: 'x = 1',
        format: 'latex',
        captionId: 'equation-caption',
      },
      {
        ...common,
        id: 'equation-caption',
        type: 'caption',
        parentId: 'equation',
        text: 'Equation caption',
      },
      { ...common, id: 'aside', type: 'aside', text: 'Aside' },
      {
        ...common,
        id: 'note',
        type: 'note',
        noteKind: 'footnote',
        label: '1',
        backlinkIds: ['paragraph'],
        text: 'Note',
      },
      {
        ...common,
        id: 'reference',
        type: 'reference',
        targetIds: ['paragraph'],
        href: 'https://example.com',
        text: 'Reference',
      },
      {
        ...common,
        id: 'media',
        type: 'media',
        mediaKind: 'audio',
        assetId: 'audio-sha',
        captionId: 'media-caption',
      },
      {
        ...common,
        id: 'media-caption',
        type: 'caption',
        parentId: 'media',
        text: 'Transcript',
      },
    ],
  }
}

describe('PublicationGraph', () => {
  it('strictly represents the bounded universal node set deterministically', () => {
    const graph = publicationGraphSchema.parse(graphFixture())
    expect(graph.nodes.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list-item',
      'quote',
      'code',
      'figure',
      'caption',
      'table',
      'caption',
      'equation',
      'caption',
      'aside',
      'note',
      'reference',
      'media',
      'caption',
    ])
    expect(serializePublicationGraph(graph)).toBe(
      serializePublicationGraph(graph),
    )
  })

  it.each([
    [
      'unknown version',
      (value: any) => {
        value.version = '2.0.0'
      },
    ],
    [
      'extra field',
      (value: any) => {
        value.nodes[0].page = 1
      },
    ],
    [
      'duplicate id',
      (value: any) => {
        value.nodes[1].id = value.nodes[0].id
      },
    ],
    [
      'dangling relationship',
      (value: any) => {
        value.nodes[2].itemIds = ['missing']
      },
    ],
    [
      'unsafe URL',
      (value: any) => {
        value.nodes[14].href = 'file:///etc/passwd'
      },
    ],
    [
      'local source path',
      (value: any) => {
        value.nodes[0].provenance.sourceId = '/tmp/source.docx'
      },
    ],
    [
      'invalid range',
      (value: any) => {
        value.nodes[1].inlineRuns = [{ start: 0, end: 100 }]
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const value = graphFixture()
    mutate(value)
    expect(publicationGraphSchema.safeParse(value).success).toBe(false)
  })
})
