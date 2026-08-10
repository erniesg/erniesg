import { describe, expect, it } from 'vitest'
import {
  canonicalPublicationJson,
  findForbiddenCanonicalKeys,
  hasControlCharacters,
  isSafePublicationUrl,
  isSafeSourceReference,
  parsePublicationGraph,
  publicationDigest,
  publicationGraphSchema,
  publicationNodeText,
  PUBLICATION_GRAPH_VERSION,
  PUBLICATION_LIMITS,
  PUBLICATION_NODE_TYPES,
  serializePublicationGraph,
  UnsupportedPublicationVersionError,
} from './schema'

const EDITION_ID = 'fixture.1-0-0'

function baseNode(id: string) {
  return {
    id,
    locale: 'en',
    direction: 'ltr',
    requirement: 'required',
    importance: 'primary',
    provenance: { source: 'Fixture PRD §1', method: 'authored' },
    accessibility: { alternatives: [] },
    authoredVariants: {},
    permittedTransformations: [],
    reviewedVariants: [],
    edition: { editionId: EDITION_ID },
    relationships: [],
    assetRefs: [],
  }
}

const ALL_NODE_FIXTURES = [
  { ...baseNode('n-heading'), type: 'heading', level: 1, text: '1. Heading' },
  { ...baseNode('n-paragraph'), type: 'paragraph', text: 'A paragraph.' },
  {
    ...baseNode('n-list'),
    type: 'list',
    text: 'A list item.',
    list: { level: 1, ordered: true, numberingId: 'num-1' },
  },
  { ...baseNode('n-quote'), type: 'quote', text: 'A quotation.' },
  { ...baseNode('n-code'), type: 'code', text: 'const a = 1', language: 'ts' },
  {
    ...baseNode('n-figure'),
    type: 'figure',
    title: 'Composition pipeline',
    relationships: [{ role: 'caption', targetId: 'n-caption' }],
  },
  { ...baseNode('n-caption'), type: 'caption', text: 'A caption.' },
  {
    ...baseNode('n-table'),
    type: 'table',
    title: 'Results',
    table: {
      rows: [
        {
          cells: [
            { text: 'Target', headerScope: 'column', columnSpan: 1, rowSpan: 1 },
          ],
        },
      ],
    },
  },
  { ...baseNode('n-equation'), type: 'equation', title: 'E = mc^2' },
  { ...baseNode('n-aside'), type: 'aside', kind: 'sidebar', text: 'An aside.' },
  {
    ...baseNode('n-note'),
    type: 'note',
    kind: 'footnote',
    label: '1',
    text: 'A footnote.',
    backlinks: ['ref-1'],
  },
  {
    ...baseNode('n-reference'),
    type: 'reference',
    label: '[1]',
    text: 'Author, Title, 2026.',
    identifiers: { url: 'https://example.org/paper' },
  },
  {
    ...baseNode('n-media'),
    type: 'media',
    mediaKind: 'audio',
    title: 'Heartbeat recording',
  },
]

function graphFixture(overrides: Record<string, unknown> = {}) {
  return {
    version: PUBLICATION_GRAPH_VERSION,
    metadata: {
      id: 'fixture',
      version: '1.0.0',
      status: 'working',
      title: 'Fixture publication',
      subtitle: 'One graph, many renditions',
      authors: ['Chen Enjiao (Ernie)'],
      abstract: 'A bounded fixture used to prove the codec boundaries.',
      updated: '2026-07-13',
      language: 'en',
      baseDirection: 'ltr',
    },
    editions: [
      {
        id: EDITION_ID,
        kind: 'primary',
        locale: 'en',
        direction: 'ltr',
        label: 'Primary edition',
      },
    ],
    nodes: [
      {
        ...baseNode('p-1'),
        type: 'paragraph',
        text: 'Meaning first, geometry later.',
        noteReferences: [
          {
            id: 'ref-1',
            label: '1',
            targetId: 'n-1',
            start: 0,
            end: 7,
            confidence: 1,
          },
        ],
      },
      {
        ...baseNode('n-1'),
        type: 'note',
        kind: 'footnote',
        label: '1',
        text: 'The note body.',
        backlinks: ['ref-1'],
      },
    ],
    ...overrides,
  }
}

describe('publication graph schema', () => {
  it('represents every declared node type with stable ids and relationships', () => {
    const graph = parsePublicationGraph(
      graphFixture({
        nodes: [
          ...ALL_NODE_FIXTURES,
          {
            ...baseNode('p-1'),
            type: 'paragraph',
            text: 'Meaning first.',
            noteReferences: [
              {
                id: 'ref-1',
                label: '1',
                targetId: 'n-note',
                start: 0,
                end: 7,
                confidence: 1,
              },
            ],
          },
        ],
      }),
    )

    expect(graph.nodes.map((node) => node.type)).toEqual(
      expect.arrayContaining([...PUBLICATION_NODE_TYPES]),
    )
    expect(new Set(graph.nodes.map((node) => node.type)).size).toBe(
      PUBLICATION_NODE_TYPES.length,
    )
    for (const node of graph.nodes) {
      expect(node.locale).toBe('en')
      expect(node.direction).toBe('ltr')
      expect(node.requirement).toBe('required')
      expect(node.importance).toBe('primary')
      expect(node.provenance.method).toBe('authored')
      expect(node.accessibility.alternatives).toEqual([])
      expect(node.permittedTransformations).toEqual([])
      expect(node.edition.editionId).toBe(EDITION_ID)
    }
    expect(publicationNodeText(graph.nodes[0])).toBe('1. Heading')
    expect(publicationNodeText(graph.nodes[5])).toBeNull()
  })

  it('rejects unknown contract versions before schema parsing', () => {
    expect(() => parsePublicationGraph(graphFixture({ version: '2.0.0' }))).toThrow(
      UnsupportedPublicationVersionError,
    )
    expect(() => parsePublicationGraph(graphFixture({ version: undefined }))).toThrow(
      UnsupportedPublicationVersionError,
    )
  })

  it('rejects extra fields instead of silently ignoring them', () => {
    expect(() =>
      parsePublicationGraph(graphFixture({ renderer: 'chromium' })),
    ).toThrow()
    const nodes = graphFixture().nodes
    expect(() =>
      parsePublicationGraph(
        graphFixture({
          nodes: [{ ...nodes[0], cssClass: 'lead' }, nodes[1]],
        }),
      ),
    ).toThrow()
  })

  it('rejects duplicate ids and dangling relationships', () => {
    const nodes = graphFixture().nodes
    expect(() =>
      parsePublicationGraph(graphFixture({ nodes: [nodes[0], nodes[0]] })),
    ).toThrow(/Duplicate canonical node id/)

    expect(() =>
      parsePublicationGraph(
        graphFixture({
          nodes: [
            { ...nodes[0], relationships: [{ role: 'caption', targetId: 'nope' }] },
            nodes[1],
          ],
        }),
      ),
    ).toThrow(/Dangling relationship/)

    expect(() =>
      parsePublicationGraph(
        graphFixture({
          nodes: [
            {
              ...nodes[0],
              noteReferences: [
                {
                  id: 'ref-1',
                  label: '1',
                  targetId: 'missing-note',
                  start: 0,
                  end: 7,
                  confidence: 1,
                },
              ],
            },
            nodes[1],
          ],
        }),
      ),
    ).toThrow(/Dangling note relationship/)
  })

  it('rejects dangling and duplicated edition linkage', () => {
    expect(() =>
      parsePublicationGraph(
        graphFixture({
          nodes: graphFixture().nodes.map((node) => ({
            ...node,
            edition: { editionId: 'other-edition' },
          })),
        }),
      ),
    ).toThrow(/Dangling edition linkage/)

    expect(() =>
      parsePublicationGraph(
        graphFixture({
          editions: [
            {
              id: EDITION_ID,
              kind: 'translation',
              locale: 'zh-Hans',
              direction: 'ltr',
              label: 'Simplified Chinese edition',
              translationOf: 'not-an-edition',
            },
          ],
        }),
      ),
    ).toThrow()
  })

  it('links Astro translations and Payload locales through explicit editions', () => {
    const graph = parsePublicationGraph(
      graphFixture({
        editions: [
          {
            id: EDITION_ID,
            kind: 'primary',
            locale: 'en',
            direction: 'ltr',
            label: 'Primary edition',
          },
          {
            id: 'fixture.zh',
            kind: 'translation',
            locale: 'zh-Hans',
            direction: 'ltr',
            label: 'Simplified Chinese edition',
            translationOf: EDITION_ID,
          },
        ],
      }),
    )
    expect(graph.editions[1].translationOf).toBe(EDITION_ID)
    expect(graph.editions.filter((edition) => edition.kind === 'primary')).toHaveLength(1)
  })

  it('rejects unsafe URLs and permits only https, mailto, and fragments', () => {
    expect(isSafePublicationUrl('https://example.org/a')).toBe(true)
    expect(isSafePublicationUrl('mailto:hello@example.org')).toBe(true)
    expect(isSafePublicationUrl('#figure-1')).toBe(true)
    for (const unsafe of [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'file:///Users/someone/secret.pdf',
      'http://example.org/a',
      '../../etc/passwd',
    ]) {
      expect(isSafePublicationUrl(unsafe)).toBe(false)
    }

    const nodes = graphFixture().nodes
    expect(() =>
      parsePublicationGraph(
        graphFixture({
          nodes: [
            {
              ...nodes[0],
              inlineRuns: [{ start: 0, end: 7, href: 'javascript:alert(1)' }],
            },
            nodes[1],
          ],
        }),
      ),
    ).toThrow()
  })

  it('rejects secret and local-path material in source references', () => {
    expect(isSafeSourceReference('PRD §3, §11')).toBe(true)
    for (const unsafe of [
      '/Users/ernie/Documents/paper.pdf',
      'C:\\Users\\ernie\\paper.docx',
      'file:///tmp/paper.pdf',
      'token=abcdef0123456789',
      '-----BEGIN RSA PRIVATE KEY-----',
    ]) {
      expect(isSafeSourceReference(unsafe)).toBe(false)
    }

    const nodes = graphFixture().nodes
    expect(() =>
      parsePublicationGraph(
        graphFixture({
          nodes: [
            {
              ...nodes[0],
              provenance: {
                source: '/Users/ernie/Documents/paper.pdf',
                method: 'imported',
              },
            },
            nodes[1],
          ],
        }),
      ),
    ).toThrow()
  })

  it('rejects unbounded text and collections', () => {
    const nodes = graphFixture().nodes
    expect(() =>
      parsePublicationGraph(
        graphFixture({
          nodes: [
            { ...nodes[0], text: 'x'.repeat(PUBLICATION_LIMITS.bodyText + 1) },
            nodes[1],
          ],
        }),
      ),
    ).toThrow()
    expect(() =>
      parsePublicationGraph(
        graphFixture({
          metadata: {
            ...graphFixture().metadata,
            authors: Array.from(
              { length: PUBLICATION_LIMITS.authors + 1 },
              (_, index) => `Author ${index}`,
            ),
          },
        }),
      ),
    ).toThrow()
    expect(hasControlCharacters('clean text')).toBe(false)
    expect(hasControlCharacters(`bell${String.fromCharCode(7)}`)).toBe(true)
    expect(hasControlCharacters('tabs\tand\nnewlines')).toBe(false)
  })

  it('rejects invalid inline and note ranges', () => {
    const nodes = graphFixture().nodes
    expect(() =>
      parsePublicationGraph(
        graphFixture({
          nodes: [{ ...nodes[0], inlineRuns: [{ start: 5, end: 5 }] }, nodes[1]],
        }),
      ),
    ).toThrow(/Invalid inline run text range/)
    expect(() =>
      parsePublicationGraph(
        graphFixture({
          nodes: [
            { ...nodes[0], inlineRuns: [{ start: 0, end: 9_999 }] },
            nodes[1],
          ],
        }),
      ),
    ).toThrow(/Invalid inline run text range/)
  })

  it('forbids target coordinates anywhere in canonical content', () => {
    expect(
      findForbiddenCanonicalKeys({
        nodes: [{ id: 'a', bbox: { x: 1, y: 2 }, page: 3 }],
      }),
    ).toEqual(
      expect.arrayContaining([
        '$.nodes[0].bbox',
        '$.nodes[0].bbox.x',
        '$.nodes[0].bbox.y',
        '$.nodes[0].page',
      ]),
    )
    expect(findForbiddenCanonicalKeys(graphFixture().nodes)).toEqual([])

    const nodes = graphFixture().nodes
    expect(() =>
      parsePublicationGraph(
        graphFixture({ nodes: [{ ...nodes[0], page: 3 }, nodes[1]] }),
      ),
    ).toThrow()
  })

  it('round trips deterministically', () => {
    const graph = parsePublicationGraph(graphFixture())
    const serialized = serializePublicationGraph(graph)

    expect(serializePublicationGraph(parsePublicationGraph(JSON.parse(serialized)))).toBe(
      serialized,
    )
    expect(publicationDigest(graph)).toBe(
      publicationDigest(parsePublicationGraph(JSON.parse(serialized))),
    )
    expect(publicationDigest(graph)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(canonicalPublicationJson({ b: 1, a: 2 })).toBe(
      canonicalPublicationJson({ a: 2, b: 1 }),
    )
    expect(publicationGraphSchema.parse(graph)).toEqual(graph)
  })
})
