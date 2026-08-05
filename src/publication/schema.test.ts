import { describe, expect, it } from 'vitest'
import { publicationGraphSchema, serializePublicationGraph } from './schema'
import {
  PUBLICATION_PROFILES,
  publicationGraphToHtml,
} from './renderers/vivliostyle'

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
  return structuredClone({
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
      {
        ...common,
        id: 'paragraph',
        type: 'paragraph',
        text: 'Paragraph',
        inlineRuns: [
          {
            start: 0,
            end: 1,
            relationshipId: 'note-ref',
            semanticRole: 'cross-reference',
            targetIds: ['note'],
          },
        ],
      },
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
        backlinkIds: ['note-ref'],
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
  })
}

function moveNoteReference(graph: any, nodeId: string) {
  const paragraph = graph.nodes.find((node: any) => node.id === 'paragraph')
  const node = graph.nodes.find((candidate: any) => candidate.id === nodeId)
  const note = graph.nodes.find((candidate: any) => candidate.id === 'note')
  paragraph.inlineRuns = []
  if (node.type === 'figure') node.sourceText = 'Figure source'
  if (node.type === 'reference') {
    node.targetIds = []
    delete node.href
  }
  node.inlineRuns = [
    {
      start: 0,
      end: 1,
      relationshipId: 'note-ref',
      semanticRole: 'cross-reference',
      targetIds: ['note'],
    },
  ]
  note.backlinkIds = ['note-ref']
  return node
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
        value.nodes[0].provenance.sourceId = [
          'https://user',
          ':password@example.com/source',
        ].join('')
      },
    ],
    [
      'secret-bearing source evidence',
      (value: any) => {
        value.nodes[0].provenance.evidence = ['api', '_key=do-not-store'].join(
          '',
        )
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
    [
      'table header relationship to data cell',
      (value: any) => {
        value.nodes[8].rows[0].cells = [
          {
            id: 'header',
            text: 'Not a header',
            headerScope: null,
            columnSpan: 1,
            rowSpan: 1,
          },
          {
            id: 'cell',
            text: 'Cell',
            headerScope: null,
            columnSpan: 1,
            rowSpan: 1,
            headerIds: ['header'],
          },
        ]
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
    multiplyOwned.nodes.push({
      ...common,
      id: 'second-list-item',
      type: 'list-item',
      parentListId: 'list',
      childListIds: ['list'],
      text: 'Second owner',
    })
    multiplyOwned.nodes
      .find((node: any) => node.id === 'list')
      .itemIds.push('second-list-item')
    expect(publicationGraphSchema.safeParse(multiplyOwned).success).toBe(false)
  })

  it('rejects duplicate child-list relationships', () => {
    const duplicate = graphFixture() as any
    duplicate.nodes.push(
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
        childListIds: [],
        text: 'Nested item',
      },
    )
    duplicate.nodes.find((node: any) => node.id === 'item').childListIds = [
      'nested-list',
      'nested-list',
    ]
    expect(publicationGraphSchema.safeParse(duplicate).success).toBe(false)
  })

  it('rejects duplicate list-item relationships and empty reviewed text variants', () => {
    const duplicateItems = graphFixture() as any
    duplicateItems.nodes.find((node: any) => node.id === 'list').itemIds = [
      'item',
      'item',
    ]
    expect(publicationGraphSchema.safeParse(duplicateItems).success).toBe(false)

    const emptyVariant = graphFixture() as any
    emptyVariant.nodes.find((node: any) => node.id === 'paragraph').variants = [
      { kind: 'compact', text: '', reviewed: true },
    ]
    expect(publicationGraphSchema.safeParse(emptyVariant).success).toBe(false)
  })

  it('preserves reciprocal inline note references with matching explicit hrefs', () => {
    const graph = graphFixture() as any
    graph.nodes.find(
      (node: any) => node.id === 'paragraph',
    ).inlineRuns[0].href = '#note'
    expect(publicationGraphSchema.safeParse(graph).success).toBe(true)
  })

  it('rejects link overlaps that shadow or split rendered note anchors', () => {
    const shadowed = graphFixture() as any
    shadowed.nodes
      .find((node: any) => node.id === 'paragraph')
      .inlineRuns.unshift({
        start: 0,
        end: 1,
        href: 'https://example.com/shadow',
      })
    expect(publicationGraphSchema.safeParse(shadowed).success).toBe(false)

    const split = graphFixture() as any
    const paragraph = split.nodes.find((node: any) => node.id === 'paragraph')
    paragraph.inlineRuns[0].end = paragraph.text.length
    paragraph.inlineRuns.unshift({
      start: 3,
      end: 6,
      href: 'https://example.com/split',
    })
    expect(publicationGraphSchema.safeParse(split).success).toBe(false)
  })

  it('preserves non-link styling overlap around rendered note anchors', () => {
    const graph = graphFixture() as any
    graph.nodes
      .find((node: any) => node.id === 'paragraph')
      .inlineRuns.unshift({ start: 0, end: 1, bold: true })
    expect(publicationGraphSchema.safeParse(graph).success).toBe(true)
  })

  it.each([
    ['heading', [{ kind: 'static', text: 'Static', reviewed: true }]],
    ['paragraph', [{ kind: 'monochrome', text: 'Monochrome', reviewed: true }]],
    ['item', [{ kind: 'compact', text: 'Compact', reviewed: true }]],
    [
      'quote',
      [
        { kind: 'static', text: 'Static', reviewed: true },
        { kind: 'monochrome', text: 'Monochrome', reviewed: true },
        { kind: 'compact', text: 'Compact', reviewed: true },
      ],
    ],
    ['figure-caption', [{ kind: 'static', text: 'Static', reviewed: true }]],
    ['aside', [{ kind: 'monochrome', text: 'Monochrome', reviewed: true }]],
    [
      'note',
      [
        { kind: 'static', text: 'Static', reviewed: true },
        { kind: 'monochrome', text: 'Monochrome', reviewed: true },
        { kind: 'compact', text: 'Compact', reviewed: true },
      ],
    ],
    ['reference', [{ kind: 'compact', text: 'Compact', reviewed: true }]],
  ])(
    'rejects note anchors removed from a profile by reviewed variants on %s nodes',
    (nodeId, variants) => {
      const graph = graphFixture() as any
      const node = moveNoteReference(graph, nodeId)
      node.variants = variants
      expect(publicationGraphSchema.safeParse(graph).success).toBe(false)
    },
  )

  it('rejects figure inline note anchors because no profile renders figure runs', () => {
    const graph = graphFixture() as any
    moveNoteReference(graph, 'figure')
    expect(publicationGraphSchema.safeParse(graph).success).toBe(false)
  })

  it('mirrors first-reviewed-variant and text-node asset precedence', () => {
    const accepted = graphFixture() as any
    const acceptedHeading = moveNoteReference(accepted, 'heading')
    acceptedHeading.variants = [
      { kind: 'static', assetId: 'ignored-asset', reviewed: true },
      { kind: 'static', text: 'Ignored later variant', reviewed: true },
      { kind: 'compact', text: 'Unreviewed text', reviewed: false },
    ]
    expect(publicationGraphSchema.safeParse(accepted).success).toBe(true)
    accepted.nodes = accepted.nodes.filter((node: any) =>
      ['heading', 'note'].includes(node.id),
    )
    const parsedAccepted = publicationGraphSchema.parse(accepted)
    for (const profile of PUBLICATION_PROFILES) {
      const html = publicationGraphToHtml(parsedAccepted, new Map(), profile)
      expect(html.match(/id="note-ref"/g)).toHaveLength(1)
      expect(html.match(/href="#note-ref"/g)).toHaveLength(1)
    }

    const rejected = graphFixture() as any
    const rejectedHeading = moveNoteReference(rejected, 'heading')
    rejectedHeading.variants = [
      {
        kind: 'static',
        assetId: 'ignored-asset',
        text: 'Selected text',
        reviewed: true,
      },
    ]
    expect(publicationGraphSchema.safeParse(rejected).success).toBe(false)
  })

  it('rejects orphan list-items that can hide note anchors and nested lists', () => {
    const graph = graphFixture() as any
    graph.nodes.push(
      {
        ...common,
        id: 'orphan-item',
        type: 'list-item',
        parentListId: 'list',
        childListIds: ['hidden-list'],
        text: 'Orphan item',
      },
      {
        ...common,
        id: 'hidden-list',
        type: 'list',
        ordered: false,
        itemIds: ['hidden-item'],
      },
      {
        ...common,
        id: 'hidden-item',
        type: 'list-item',
        parentListId: 'hidden-list',
        childListIds: [],
        text: 'Hidden item',
      },
    )
    moveNoteReference(graph, 'orphan-item')
    expect(publicationGraphSchema.safeParse(graph).success).toBe(false)
  })

  it.each([
    [
      'href',
      (reference: any) => {
        reference.href = 'https://example.com/reference'
      },
    ],
    [
      'target',
      (reference: any) => {
        reference.targetIds = ['paragraph']
      },
    ],
  ])(
    'rejects link-producing inline runs nested in reference outer %s links',
    (_label, addOuterLink) => {
      const graph = graphFixture() as any
      const reference = moveNoteReference(graph, 'reference')
      addOuterLink(reference)
      expect(publicationGraphSchema.safeParse(graph).success).toBe(false)
    },
  )

  it('preserves styled outer references and linked plain references', () => {
    const styledOuter = graphFixture() as any
    styledOuter.nodes.find((node: any) => node.id === 'reference').inlineRuns =
      [{ start: 0, end: 1, bold: true }]
    expect(publicationGraphSchema.safeParse(styledOuter).success).toBe(true)

    const linkedPlain = graphFixture() as any
    moveNoteReference(linkedPlain, 'reference')
    expect(publicationGraphSchema.safeParse(linkedPlain).success).toBe(true)
  })

  it('renders each accepted owned-caption note anchor and backlink once in every profile', () => {
    const graph = graphFixture() as any
    moveNoteReference(graph, 'table-caption')
    graph.nodes = graph.nodes.filter((node: any) =>
      ['table', 'table-caption', 'note'].includes(node.id),
    )
    const parsed = publicationGraphSchema.parse(graph)
    for (const profile of PUBLICATION_PROFILES) {
      const html = publicationGraphToHtml(parsed, new Map(), profile)
      expect(html.match(/id="note-ref"/g)).toHaveLength(1)
      expect(html.match(/href="#note-ref"/g)).toHaveLength(1)
    }
  })

  it('claims generated figure source IDs only when a profile emits them', () => {
    const notEmitted = graphFixture() as any
    notEmitted.nodes.find(
      (node: any) => node.id === 'paragraph',
    ).inlineRuns[0].relationshipId = 'figure-source'
    notEmitted.nodes.find((node: any) => node.id === 'note').backlinkIds = [
      'figure-source',
    ]
    notEmitted.nodes.find((node: any) => node.id === 'figure').variants = [
      {
        kind: 'static',
        assetId: 'static-asset',
        text: 'Ignored source',
        reviewed: true,
      },
      { kind: 'static', text: 'Later source', reviewed: true },
    ]
    expect(publicationGraphSchema.safeParse(notEmitted).success).toBe(true)

    const emitted = structuredClone(notEmitted)
    emitted.nodes.find((node: any) => node.id === 'figure').variants[0] = {
      kind: 'static',
      text: 'Rendered source',
      reviewed: true,
    }
    expect(publicationGraphSchema.safeParse(emitted).success).toBe(false)
  })

  it.each([
    ['node ID', 'heading', (_graph: any) => {}],
    [
      'table-cell ID',
      'table-cell',
      (graph: any) => {
        graph.nodes.find(
          (node: any) => node.id === 'table',
        ).rows[0].cells[0].id = 'table-cell'
      },
    ],
    [
      'generated figure source ID',
      'figure-source',
      (graph: any) => {
        graph.nodes.find((node: any) => node.id === 'figure').sourceText =
          'Source'
      },
    ],
    [
      'generated media transcript ID',
      'media-transcript',
      (graph: any) => {
        graph.nodes.find(
          (node: any) => node.id === 'media',
        ).accessibility.transcript = 'Transcript'
      },
    ],
  ])(
    'rejects note relationship IDs colliding with a %s',
    (_label, id, mutate) => {
      const graph = graphFixture() as any
      mutate(graph)
      graph.nodes.find(
        (node: any) => node.id === 'paragraph',
      ).inlineRuns[0].relationshipId = id
      graph.nodes.find((node: any) => node.id === 'note').backlinkIds = [id]
      expect(publicationGraphSchema.safeParse(graph).success).toBe(false)
    },
  )

  it.each([
    [
      'unrelated references',
      (graph: any) => {
        graph.nodes.find(
          (node: any) => node.id === 'paragraph',
        ).inlineRuns[0].targetIds = ['reference']
      },
    ],
    [
      'note targets without cross-reference semantics',
      (graph: any) => {
        delete graph.nodes.find((node: any) => node.id === 'paragraph')
          .inlineRuns[0].semanticRole
      },
    ],
    [
      'note targets with mismatched explicit hrefs',
      (graph: any) => {
        graph.nodes.find(
          (node: any) => node.id === 'paragraph',
        ).inlineRuns[0].href = '#reference'
      },
    ],
    [
      'notes after the rendered target',
      (graph: any) => {
        graph.nodes.find(
          (node: any) => node.id === 'paragraph',
        ).inlineRuns[0].targetIds = ['reference', 'note']
      },
    ],
    [
      'missing relationship IDs',
      (graph: any) => {
        delete graph.nodes.find((node: any) => node.id === 'paragraph')
          .inlineRuns[0].relationshipId
      },
    ],
    [
      'missing backlinks',
      (graph: any) => {
        graph.nodes.find((node: any) => node.id === 'note').backlinkIds = []
      },
    ],
    [
      'duplicate rendered relationship IDs',
      (graph: any) => {
        graph.nodes.find((node: any) => node.id === 'heading').inlineRuns = [
          {
            start: 0,
            end: 1,
            relationshipId: 'note-ref',
            semanticRole: 'citation',
            targetIds: ['reference'],
          },
        ]
      },
    ],
    [
      'duplicate backlink IDs',
      (graph: any) => {
        graph.nodes.find((node: any) => node.id === 'note').backlinkIds = [
          'note-ref',
          'note-ref',
        ]
      },
    ],
  ])('rejects invalid note reciprocity: %s', (_label, mutate) => {
    const graph = graphFixture() as any
    mutate(graph)
    expect(publicationGraphSchema.safeParse(graph).success).toBe(false)
  })
})
