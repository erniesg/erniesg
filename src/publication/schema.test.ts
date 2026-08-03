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
      'encoded local source path',
      (value: any) => {
        value.nodes[0].provenance.sourceId = '%2Ftmp%2Fsource.docx'
      },
    ],
    [
      'credential-bearing source URL',
      (value: any) => {
        value.nodes[0].provenance.sourceId =
          'https://user:password@example.com/source'
      },
    ],
    [
      'secret-bearing source evidence',
      (value: any) => {
        value.nodes[0].provenance.evidence = ['api_key=do-not-store']
      },
    ],
    [
      'invalid range',
      (value: any) => {
        value.nodes[1].inlineRuns = [{ start: 0, end: 100 }]
      },
    ],
    [
      'duplicate table cell id',
      (value: any) => {
        value.nodes[8].rows[0].cells = [
          {
            id: 'cell',
            text: 'One',
            headerScope: 'column',
            columnSpan: 1,
            rowSpan: 1,
          },
          {
            id: 'cell',
            text: 'Two',
            headerScope: null,
            columnSpan: 1,
            rowSpan: 1,
          },
        ]
      },
    ],
    [
      'dangling table header relationship',
      (value: any) => {
        value.nodes[8].rows[0].cells[0].headerIds = ['missing-header']
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const value = graphFixture()
    mutate(value)
    expect(publicationGraphSchema.safeParse(value).success).toBe(false)
  })

  it('rejects cyclic nested lists and multiply-owned child lists', () => {
    const cyclic = graphFixture() as any
    cyclic.nodes.push(
      {
        ...common,
        id: 'nested-list',
        type: 'list',
        ordered: false,
        itemIds: ['nested-item'],
      },
      {
        ...common,
        id: 'nested-item',
        type: 'list-item',
        parentListId: 'nested-list',
        childListIds: ['list'],
        text: 'Nested item',
      },
    )
    cyclic.nodes.find((node: any) => node.id === 'item').childListIds = [
      'nested-list',
    ]
    expect(publicationGraphSchema.safeParse(cyclic).success).toBe(false)

    const multiplyOwned = graphFixture() as any
    multiplyOwned.nodes.push(
      {
        ...common,
        id: 'second-list-item',
        type: 'list-item',
        parentListId: 'list',
        childListIds: ['list'],
        text: 'Second owner',
      },
    )
    multiplyOwned.nodes.find((node: any) => node.id === 'list').itemIds.push(
      'second-list-item',
    )
    expect(publicationGraphSchema.safeParse(multiplyOwned).success).toBe(false)
  })
})
