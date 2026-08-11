import { describe, expect, it } from 'vitest'
import publication from '../../../tests/fixtures/payload/publication.json'
import mapping from '../../../tests/fixtures/payload/mapping.json'
import { publicationGraphToHtml } from '../renderers/vivliostyle'
import { adaptPayloadLexical, adaptPayloadLexicalEditions, payloadMappingPolicySchema } from './payload-lexical'

function strictFixture(children: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 'strict-fixture',
    title: 'Strict fixture',
    locale: 'en',
    ...extra,
    content: { root: { type: 'root', children } },
  }
}

function capturedError(callback: () => unknown) {
  try {
    callback()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('Payload Lexical publication adapter', () => {
  it('maps typed Lexical content, marks, blocks, relationships, and assets', async () => {
    const result = adaptPayloadLexical(publication, mapping)
    expect(result.provenance).toMatchObject({
      adapterId: 'payload-lexical',
      sourceType: 'payload',
      sourceId: expect.stringMatching(
        /^payload:document-[a-f0-9]{64}:en$/,
      ),
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
      ...Array(30).fill('paragraph'),
      'reference',
    ])
    const paragraph = result.graph.nodes.find((node) => node.type === 'paragraph')
    expect(paragraph?.inlineRuns).toEqual(
      expect.arrayContaining([expect.objectContaining({ bold: true }), expect.objectContaining({ italic: true }), expect.objectContaining({ href: 'https://example.com' })]),
    )
    expect(result.assetBundle.descriptor.assets[0]).toMatchObject({
      mediaType: 'image/png',
      width: 24,
      height: 24,
      focalPoint: { x: 0.5, y: 0.5 },
      crop: { x: 0, y: 0, width: 24, height: 24, unit: 'px' },
    })
    const figure = result.graph.nodes.find((node) => node.type === 'figure')
    expect(figure).toMatchObject({
      accessibility: {
        decorative: false,
        alternativeText: 'A small blue publication mark',
      },
    })
    await expect(result.assetBundle.resolveBytes(result.assetBundle.descriptor.assets[0])).resolves.toBeInstanceOf(Uint8Array)
  })

  it('derives deterministic ids and records their origin', () => {
    const input = {
      id: 'derived-fixture',
      title: 'Derived',
      locale: 'en',
      content: {
        root: {
          children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Stable' }] }],
        },
      },
    }
    const first = adaptPayloadLexical(input)
    const second = adaptPayloadLexical(input)
    expect(first.graph.nodes.map((node) => node.id)).toEqual(second.graph.nodes.map((node) => node.id))
    expect(first.graph.nodes[0].provenance.idOrigin).toBe('derived')
    expect(first.graph.nodes[0].provenance.evidence[0]).toContain('content.root.children[0]')

    const inserted = adaptPayloadLexical({
      ...input,
      content: {
        root: {
          children: [{ type: 'heading', children: [{ type: 'text', text: 'Inserted' }] }, input.content.root.children[0]],
        },
      },
    })
    expect(inserted.graph.nodes[1].id).not.toBe(first.graph.nodes[0].id)
  })

  it('keeps sanitized document identities collision-resistant', () => {
    const identities = ['a/b', 'a b', '!!!'].map((id) => {
      const result = adaptPayloadLexical({
        id,
        title: 'Collision-resistant identity',
        content: {
          root: {
            children: [
              {
                type: 'paragraph',
                children: [{ type: 'text', text: 'Body' }],
              },
            ],
          },
        },
      })
      return {
        graphId: result.graph.id,
        sourceId: result.provenance.sourceId,
        nodeId: result.graph.nodes[0].id,
      }
    })
    expect(new Set(identities.map(({ graphId }) => graphId)).size).toBe(3)
    expect(new Set(identities.map(({ sourceId }) => sourceId)).size).toBe(3)
    expect(new Set(identities.map(({ nodeId }) => nodeId)).size).toBe(3)
    expect(
      identities.every(({ graphId }) =>
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(graphId),
      ),
    ).toBe(true)
  })

  it('makes every string document id opaque before output and diagnostic construction', () => {
    const credentialShapedIds = [
      ['github', '_pat_', 'A'.repeat(24)].join(''),
      ['gh', 'p_', 'B'.repeat(24)].join(''),
      ['s', 'k-', 'C'.repeat(24)].join(''),
      ['s', 'k_live_', 'D'.repeat(20)].join(''),
      ['gl', 'pat-', 'E'.repeat(24)].join(''),
      ['npm', '_', 'F'.repeat(24)].join(''),
      ['xo', 'xb-', 'G'.repeat(24)].join(''),
      ['AK', 'IA', '1'.repeat(16)].join(''),
      [
        'https://hooks.',
        'slack.com/services/',
        'A'.repeat(8),
        '/',
        'B'.repeat(8),
        '/',
        'C'.repeat(24),
      ].join(''),
      [
        'https://discord',
        '.com/api/webhooks/',
        '1'.repeat(10),
        '/',
        'D'.repeat(24),
      ].join(''),
      ['article?', 'to', 'ken=', 'synthetic-secret-marker'].join(''),
    ]

    for (const rawId of credentialShapedIds) {
      const result = adaptPayloadLexical({
        document: strictFixture(
          [
            {
              type: 'paragraph',
              children: [{ type: 'text', text: 'Body' }],
            },
          ],
          { id: rawId, locale: 'en' },
        ),
        locale: 'fr',
        mapping: { fallbackLocale: 'en' },
      })

      const serialized = JSON.stringify({
        graph: result.graph,
        provenance: result.provenance,
        diagnostics: result.diagnostics,
      })
      expect(serialized).not.toContain(rawId)
      expect(result.graph.id).toMatch(/^document-[a-f0-9]{64}$/)
      expect(result.provenance.sourceId).toMatch(
        /^payload:document-[a-f0-9]{64}:en$/,
      )
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          sourceId: expect.stringMatching(
            /^payload:document-[a-f0-9]{64}:en$/,
          ),
        }),
      ])

      const thrown = (() => {
        try {
          adaptPayloadLexical(
            strictFixture([{ type: 'unsupported-review-node' }], {
              id: rawId,
            }),
          )
          return undefined
        } catch (error) {
          return error
        }
      })()
      expect(thrown).toBeInstanceOf(Error)
      expect(
        JSON.stringify({
          name: (thrown as Error).name,
          message: (thrown as Error).message,
          cause: (thrown as Error & { cause?: unknown }).cause,
        }),
      ).not.toContain(rawId)
    }
  })

  it('does not reinterpret an ordinary object-valued document field as an adapter wrapper', () => {
    const result = adaptPayloadLexical({
      id: 'ordinary-document-field',
      title: 'Ordinary document field',
      locale: 'en',
      document: { relationTo: 'legal-documents', value: 'terms' },
      content: {
        root: {
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'text', text: 'Body remains authoritative.' }],
            },
          ],
        },
      },
    })
    expect(result.graph).toMatchObject({
      id: expect.stringMatching(/^document-[a-f0-9]{64}$/),
      metadata: { title: 'Ordinary document field' },
      nodes: [
        expect.objectContaining({
          type: 'paragraph',
          text: 'Body remains authoritative.',
        }),
      ],
    })
  })

  it('distinguishes the documented wrapper from ordinary document, data, and doc fields', () => {
    const body = {
      root: {
        children: [
          {
            type: 'paragraph',
            children: [{ type: 'text', text: 'Mapped body.' }],
          },
        ],
      },
    }
    const fieldMapping = {
      fields: {
        id: 'metadata.identifier',
        title: 'metadata.heading',
        content: 'richTextValue',
      },
    }
    const ordinary = (alias: 'document' | 'data' | 'doc') => ({
      metadata: {
        identifier: `ordinary-${alias}`,
        heading: `Ordinary ${alias}`,
      },
      richTextValue: body,
      [alias]: { id: 'related-record', title: 'Related record' },
    })

    for (const alias of ['document', 'data', 'doc'] as const) {
      const result = adaptPayloadLexical(ordinary(alias), fieldMapping)
      expect(result.graph).toMatchObject({
        id: expect.stringMatching(/^document-[a-f0-9]{64}$/),
        metadata: { title: `Ordinary ${alias}` },
        nodes: [
          expect.objectContaining({
            type: 'paragraph',
            text: 'Mapped body.',
          }),
        ],
      })
    }

    const wrapped = adaptPayloadLexical({
      document: ordinary('data'),
      mapping: fieldMapping,
      locale: 'en',
    })
    expect(wrapped.graph).toMatchObject({
      id: expect.stringMatching(/^document-[a-f0-9]{64}$/),
      metadata: { title: 'Ordinary data' },
    })
  })

  it('records Payload draft state as working publication metadata', () => {
    const result = adaptPayloadLexical({
      id: 'draft-publication',
      title: 'Draft publication',
      status: 'draft',
      content: {
        root: {
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'text', text: 'Draft body' }],
            },
          ],
        },
      },
    })
    expect(result.graph.metadata.status).toBe('working')
    expect(result.provenance).toMatchObject({
      adapterId: 'payload-lexical',
      sourceType: 'payload',
    })
  })

  it('accepts redundant author name fields whose trimmed values agree', () => {
    const body = [
      {
        type: 'paragraph',
        children: [{ type: 'text', text: 'Author body' }],
      },
    ]
    const agreed = adaptPayloadLexical(
      strictFixture(body, {
        authors: [{ name: 'Ada', displayName: ' Ada ', fullName: 'Ada' }],
      }),
    )
    expect(agreed.graph.metadata.contributors).toEqual(['Ada'])
    for (const conflicting of [
      { name: 'Ada', displayName: 'Grace' },
      { name: 'Ada', fullName: 'Ada', displayName: '   ' },
      { name: 'Ada', fullName: 42 },
      { displayName: '' },
    ]) {
      expect(() =>
        adaptPayloadLexical(strictFixture(body, { authors: [conflicting] })),
      ).toThrow(/Payload author must be a non-empty string or named author object at authors\[0\]/)
    }
  })

  it('preserves quote attribution', () => {
    const result = adaptPayloadLexical({
      id: 'attributed-quote',
      title: 'Attributed quote',
      content: {
        root: {
          children: [
            {
              type: 'quote',
              fields: { attribution: 'Ada Lovelace' },
              children: [{ type: 'text', text: 'That brain of mine.' }],
            },
          ],
        },
      },
    })
    expect(result.graph.nodes[0]).toMatchObject({
      type: 'quote',
      text: 'That brain of mine.',
      attribution: 'Ada Lovelace',
    })
  })

  it('preserves every supported Lexical inline mark and hard break by source offset', () => {
    const result = adaptPayloadLexical({
      id: 'inline-marks',
      title: 'Inline marks',
      locale: 'en',
      content: {
        root: {
          children: [
            {
              type: 'paragraph',
              children: [
                { type: 'text', text: 'b', format: 1 },
                { type: 'text', text: 'i', format: 2 },
                { type: 'text', text: 's', format: 4 },
                { type: 'text', text: 'u', format: 8 },
                { type: 'text', text: 'c', format: 16 },
                { type: 'text', text: 'd', format: 32 },
                { type: 'text', text: 'p', format: 64 },
                { type: 'linebreak' },
              ],
            },
          ],
        },
      },
    })
    expect(result.graph.nodes[0]).toMatchObject({
      type: 'paragraph',
      text: 'bisucdp\n',
      inlineRuns: [
        { start: 0, end: 1, bold: true },
        { start: 1, end: 2, italic: true },
        { start: 2, end: 3, strikethrough: true },
        { start: 3, end: 4, underline: true },
        { start: 4, end: 5, inlineCode: true },
        { start: 5, end: 6, verticalAlign: 'subscript' },
        { start: 6, end: 7, verticalAlign: 'superscript' },
        { start: 7, end: 8, hardBreak: true },
      ],
    })
  })

  it('accepts and ignores Lexical default start on unordered lists', () => {
    const result = adaptPayloadLexical(
      strictFixture([
        {
          type: 'list',
          listType: 'bullet',
          start: 1,
          children: [
            {
              type: 'listitem',
              children: [{ type: 'text', text: 'Bullet item' }],
            },
          ],
        },
      ]),
    )
    expect(result.graph.nodes[0]).toMatchObject({ type: 'list', ordered: false })
    expect(result.graph.nodes[0]).not.toHaveProperty('start')
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
      adaptPayloadLexical({
        id: 'unsupported-inline',
        title: 'Unsupported inline',
        content: {
          root: {
            children: [
              {
                type: 'paragraph',
                children: [
                  {
                    type: 'highlight',
                    children: [{ type: 'text', text: 'Lost mark' }],
                  },
                ],
              },
            ],
          },
        },
      }),
    ).toThrow(/Unsupported Lexical inline node highlight.*children\[0\]/)
    expect(() =>
      adaptPayloadLexical({
        id: 'invalid-list-child',
        title: 'Invalid list child',
        content: {
          root: {
            children: [
              {
                type: 'list',
                children: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Wrong' }],
                  },
                ],
              },
            ],
          },
        },
      }),
    ).toThrow(/Payload list child paragraph must be listitem.*children\[0\]/)
    expect(() =>
      adaptPayloadLexical({
        id: 'invalid-inline-list',
        title: 'Invalid inline list',
        content: {
          root: {
            children: [
              {
                type: 'paragraph',
                children: [
                  { type: 'text', text: 'before' },
                  {
                    type: 'list',
                    children: [
                      {
                        type: 'listitem',
                        children: [{ type: 'text', text: 'must not disappear' }],
                      },
                    ],
                  },
                  { type: 'text', text: 'after' },
                ],
              },
            ],
          },
        },
      }),
    ).toThrow(/Unsupported Lexical inline node list.*children\[1\]/)
    for (const type of ['upload', 'image', 'media']) {
      expect(() =>
        adaptPayloadLexical({
          id: `invalid-inline-${type}`,
          title: `Invalid inline ${type}`,
          content: {
            root: {
              children: [
                {
                  type: 'paragraph',
                  children: [
                    { type: 'text', text: 'before' },
                    { type, value: 'must-not-disappear' },
                    { type: 'text', text: 'after' },
                  ],
                },
              ],
            },
          },
        }),
      ).toThrow(new RegExp(`Unsupported Lexical inline node ${type}.*children\\[1\\]`))
    }
    for (const type of ['paragraph', 'listitem']) {
      expect(() =>
        adaptPayloadLexical({
          id: `invalid-inline-${type}`,
          title: `Invalid inline ${type}`,
          content: {
            root: {
              children: [
                {
                  type: 'paragraph',
                  children: [
                    {
                      type,
                      children: [{ type: 'text', text: 'must not flatten' }],
                    },
                  ],
                },
              ],
            },
          },
        }),
      ).toThrow(new RegExp(`Unsupported Lexical inline node ${type}.*children\\[0\\]`))
    }
    expect(() =>
      adaptPayloadLexical({
        id: 'invalid-untyped-inline',
        title: 'Invalid untyped inline',
        content: {
          root: {
            children: [
              {
                type: 'paragraph',
                children: [{ type: 'text', text: 'before' }, { text: 'must not disappear' }, { type: 'text', text: 'after' }],
              },
            ],
          },
        },
      }),
    ).toThrow(/Unsupported Lexical inline node unknown.*children\[1\]/)
    expect(() =>
      adaptPayloadLexical({
        id: 'empty-inline-link',
        title: 'Empty inline link',
        content: {
          root: {
            children: [
              {
                type: 'paragraph',
                children: [
                  { type: 'text', text: 'before' },
                  { type: 'link', url: 'https://example.com', children: [] },
                  { type: 'text', text: 'after' },
                ],
              },
            ],
          },
        },
      }),
    ).toThrow(/Payload link is empty.*children\[1\]/)
    expect(() =>
      adaptPayloadLexical({
        id: 'empty-list-item',
        title: 'Empty list item',
        content: {
          root: {
            children: [{ type: 'list', children: [{ type: 'listitem', children: [] }] }],
          },
        },
      }),
    ).toThrow(/Payload listitem is empty.*children\[0\]\.children\[0\]/)
    const nestedListOnly = adaptPayloadLexical({
      id: 'nested-list-only',
      title: 'Nested list only',
      content: {
        root: {
          children: [
            {
              type: 'list',
              children: [
                {
                  type: 'listitem',
                  children: [
                    {
                      type: 'list',
                      children: [
                        {
                          type: 'listitem',
                          children: [{ type: 'text', text: 'Nested item' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    })
    expect(nestedListOnly.graph.nodes.find((node) => node.type === 'list-item' && node.text === ' ')).toMatchObject({ type: 'list-item', childListIds: [expect.any(String)] })
    for (const format of [128, 'highlight', 'bold|unknown-mark']) {
      expect(() =>
        adaptPayloadLexical({
          id: 'unsupported-text-format',
          title: 'Unsupported text format',
          content: {
            root: {
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'text', text: 'Marked', format }],
                },
              ],
            },
          },
        }),
      ).toThrow(/Unsupported Lexical text format.*children\[0\]\.children\[0\]/)
    }
    for (const textNode of [{ type: 'text' }, { type: 'text', text: 42 }, { type: 'text', text: '' }]) {
      expect(() =>
        adaptPayloadLexical({
          id: 'invalid-text-node',
          title: 'Invalid text node',
          content: {
            root: {
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'text', text: 'before' }, textNode, { type: 'text', text: 'after' }],
                },
              ],
            },
          },
        }),
      ).toThrow(/Payload text node requires non-empty string text.*children\[1\]/)
    }
    for (const heading of [
      { type: 'heading', tag: 'h7' },
      { type: 'heading', level: 0 },
      { type: 'heading', tag: 'aside' },
    ]) {
      expect(() =>
        adaptPayloadLexical({
          id: 'invalid-heading-level',
          title: 'Invalid heading level',
          content: {
            root: {
              children: [
                {
                  ...heading,
                  children: [{ type: 'text', text: 'Heading' }],
                },
              ],
            },
          },
        }),
      ).toThrow(/Payload heading has invalid level or tag.*children\[0\]/)
    }
    for (const list of [
      { listType: 'check', ordered: false },
      { listType: 'bullet', ordered: 'false' },
    ]) {
      expect(() =>
        adaptPayloadLexical({
          id: 'invalid-list-semantics',
          title: 'Invalid list semantics',
          content: {
            root: {
              children: [
                {
                  type: 'list',
                  ...list,
                  children: [
                    {
                      type: 'listitem',
                      checked: list.listType === 'check',
                      children: [{ type: 'text', text: 'Item' }],
                    },
                  ],
                },
              ],
            },
          },
        }),
      ).toThrow(/Payload list (?:type check is unsupported|ordered must be boolean).*children\[0\]/)
    }
    for (const format of ['asciimath', 'mathml']) {
      expect(() =>
        adaptPayloadLexical(
          {
            id: 'invalid-equation-format',
            title: 'Invalid equation format',
            content: {
              root: {
                children: [{ type: 'equation', source: 'x + y', format }],
              },
            },
          },
          { blocks: { equation: 'equation' } },
        ),
      ).toThrow(new RegExp(`Payload equation has unsupported format ${format}.*children\\[0\\]`))
    }
    expect(() =>
      adaptPayloadLexical({
        id: 'invalid-media-kind',
        title: 'Invalid media kind',
        content: {
          root: {
            children: [
              {
                type: 'media',
                kind: 'photo',
                value: {
                  id: 'photo',
                  filename: 'photo.png',
                  mimeType: 'image/png',
                  data: 'AQIDBA==',
                  alt: 'Photo',
                },
              },
            ],
          },
        },
      }),
    ).toThrow(/Payload media has unsupported kind photo.*children\[0\]/)
    expect(() =>
      adaptPayloadLexical({
        id: 'invalid-crop-unit',
        title: 'Invalid crop unit',
        content: {
          root: {
            children: [{ type: 'upload', value: 'cropped' }],
          },
        },
        uploads: [
          {
            id: 'cropped',
            filename: 'cropped.png',
            mimeType: 'image/png',
            data: 'AQIDBA==',
            alt: 'Cropped image',
            crop: { x: 0, y: 0, width: 1, height: 1, unit: 'em' },
          },
        ],
      }),
    ).toThrow(/Payload upload crop has unsupported unit em.*children\[0\]/)
    expect(() =>
      adaptPayloadLexical(
        {
          id: 'invalid-wrapped-children',
          title: 'Invalid wrapped children',
          content: {
            root: {
              children: [
                {
                  type: 'callout',
                  fields: {
                    content: {
                      root: {
                        children: [{ type: 'text', text: 'A' }, 'must not disappear', { type: 'text', text: 'B' }],
                      },
                    },
                  },
                },
              ],
            },
          },
        },
        { blocks: { callout: 'aside' } },
      ),
    ).toThrow(/Payload Lexical children must be a bounded array of objects.*children\[0\]/)
    for (const nodes of [
      [
        {
          type: 'paragraph',
          id: 'bad id',
          children: [{ type: 'text', text: 'Invalid id' }],
        },
      ],
      [
        {
          type: 'paragraph',
          id: 'same',
          children: [{ type: 'text', text: 'First' }],
        },
        {
          type: 'paragraph',
          id: 'same',
          children: [{ type: 'text', text: 'Second' }],
        },
      ],
    ]) {
      expect(() =>
        adaptPayloadLexical({
          id: 'invalid-source-node-id',
          title: 'Invalid source node id',
          content: { root: { children: nodes } },
        }),
      ).toThrow(/Payload source node id (?:is invalid|is duplicated).*children\[/)
    }
    expect(() =>
      adaptPayloadLexical(
        {
          id: 'invalid-relationship-target',
          title: 'Invalid relationship target',
          content: {
            root: {
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'citation', value: 'a b', label: 'Ambiguous' }],
                },
              ],
            },
          },
        },
        {
          relationships: {
            citation: { role: 'citation' },
          },
        },
      ),
    ).toThrow(/Payload relationship target \(sha256:[0-9a-f]{16}\) is not a graph-safe id.*children\[0\]/)
    expect(() =>
      adaptPayloadLexical({
        id: 'interleaved-nested-list',
        title: 'Interleaved nested list',
        content: {
          root: {
            children: [
              {
                type: 'list',
                children: [
                  {
                    type: 'listitem',
                    children: [
                      { type: 'text', text: 'A' },
                      {
                        type: 'list',
                        children: [
                          {
                            type: 'listitem',
                            children: [{ type: 'text', text: 'B' }],
                          },
                        ],
                      },
                      { type: 'text', text: 'C' },
                    ],
                  },
                ],
              },
            ],
          },
        },
      }),
    ).toThrow(/Payload listitem content after a nested list is unsupported.*children\[0\]\.children\[0\]\.children\[2\]/)
    expect(() =>
      payloadMappingPolicySchema.parse({
        hooks: 'run-this',
      }),
    ).toThrow()
    expect(() => payloadMappingPolicySchema.parse({ version: '2.0.0' })).toThrow(/version/i)
    expect(() =>
      adaptPayloadLexical({
        id: 'unsafe',
        title: 'Unsafe',
        content: { root: { children: [] } },
        mapping: { fields: { title: () => 'executed' } },
      }),
    ).toThrow(/executable/)
  })

  it('allows harmless JSON-authored keys while retaining value and prototype safety', () => {
    const plainBody = [
      {
        type: 'paragraph',
        children: [{ type: 'text', text: 'Plain authored JSON.' }],
      },
    ]
    const body = [
      {
        type: 'paragraph',
        hooks: 'narrative hooks',
        resolver: 'story resolution',
        callback: 'a callback in quoted prose',
        function: 'mathematical function',
        execute: 'an authored command name',
        children: [{ type: 'text', text: 'Harmless authored JSON.' }],
      },
    ]
    const harmlessError = capturedError(() =>
      adaptPayloadLexical(
        strictFixture(body, {
          hooks: ['setup', 'payoff'],
          resolver: { description: 'ordinary export metadata' },
          callback: 'quoted source material',
          function: 'f(x)',
          execute: false,
        }),
      ),
    )
    const executableErrors = [
      () => 'run',
      Symbol('unsafe'),
      1n,
    ].map((value) =>
      capturedError(() =>
        adaptPayloadLexical(
          strictFixture(plainBody, { authoredMetadata: { value } }),
        ),
      ),
    )
    const unsafePrototype = strictFixture(plainBody)
    Object.defineProperty(unsafePrototype, '__proto__', {
      enumerable: true,
      value: 'must remain forbidden',
    })

    expect({
      harmlessError,
      executableErrors,
      prototypeError: capturedError(() =>
        adaptPayloadLexical(unsafePrototype),
      ),
      strictMappingError: capturedError(() =>
        adaptPayloadLexical(strictFixture(plainBody), { hooks: 'run-this' }),
      ),
    }).toEqual({
      harmlessError: undefined,
      executableErrors: [
        expect.stringMatching(/executable value/i),
        expect.stringMatching(/executable value/i),
        expect.stringMatching(/executable value/i),
      ],
      prototypeError: expect.stringMatching(/unsafe key __proto__/i),
      strictMappingError: expect.stringMatching(/hooks/i),
    })
  })

  it('links each list item only to its direct child list', () => {
    const result = adaptPayloadLexical(
      strictFixture([
        {
          type: 'list',
          id: 'list-1',
          children: [
            {
              type: 'listitem',
              id: 'item-1',
              children: [
                { type: 'text', text: 'Level one' },
                {
                  type: 'list',
                  id: 'list-2',
                  children: [
                    {
                      type: 'listitem',
                      id: 'item-2',
                      children: [
                        { type: 'text', text: 'Level two' },
                        {
                          type: 'list',
                          id: 'list-3',
                          children: [
                            {
                              type: 'listitem',
                              id: 'item-3',
                              children: [
                                { type: 'text', text: 'Level three' },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    )
    const item = (id: string) =>
      result.graph.nodes.find(
        (node) => node.type === 'list-item' && node.id === id,
      )
    expect(item('item-1')).toMatchObject({ childListIds: ['list-2'] })
    expect(item('item-2')).toMatchObject({ childListIds: ['list-3'] })
    expect(item('item-3')).toMatchObject({ childListIds: [] })

    const html = publicationGraphToHtml(
      result.graph,
      new Map(),
      'phone-webpub',
    )
    const renderedIds = [...html.matchAll(/\sid="([^"]+)"/gu)].map(
      (match) => match[1],
    )
    expect(new Set(renderedIds).size).toBe(renderedIds.length)
  })

  it('validates mapping and upload collections before adapting content', () => {
    const document = strictFixture([{ type: 'paragraph', children: [{ type: 'text', text: 'Body' }] }])
    for (const version of [1, '1', '1.0', '1.0.0']) {
      expect(adaptPayloadLexical({ document, mapping: { version } }).provenance.mappingVersion).toBe('1.0.0')
    }
    expect(() => adaptPayloadLexical({ document, mapping: 'bad' })).toThrow(/Payload mapping policy must be an object/)
    for (const invalidMapping of [{ typo: true }, { lexical: { typo: true } }]) {
      expect(() => adaptPayloadLexical({ document, mapping: invalidMapping })).toThrow(/unrecognized|typo/i)
    }
    expect(() =>
      adaptPayloadLexical({
        ...document,
        uploads: ['not-an-upload'],
      }),
    ).toThrow(/Payload upload at uploads\[0\] must be an object/)
    expect(() =>
      adaptPayloadLexical({
        ...document,
        uploads: [
          { id: 'same', filename: 'one.png' },
          { id: 'same', filename: 'two.png' },
        ],
      }),
    ).toThrow(/Payload upload id same is duplicated at uploads\[1\]/)
  })

  it('rejects aggregate decoded upload bytes above the export byte bound', () => {
    const first = Buffer.alloc(50_000_001, 1).toString('base64')
    const second = Buffer.alloc(50_000_000, 2).toString('base64')
    expect(() =>
      adaptPayloadLexical(
        strictFixture(
          [
            { type: 'upload', value: 'first' },
            { type: 'upload', value: 'second' },
          ],
          {
            uploads: [
              {
                id: 'first',
                filename: 'first.png',
                mimeType: 'image/png',
                alt: 'First image',
                data: first,
              },
              {
                id: 'second',
                filename: 'second.png',
                mimeType: 'image/png',
                alt: 'Second image',
                data: second,
              },
            ],
          },
        ),
      ),
    ).toThrow(/Payload export exceeds cumulative byte bound.*children\[1\]/i)
  })

  it('rejects oversized encoded uploads before invoking the base64 decoder', () => {
    const encoded = 'A'.repeat(133_333_336)
    const originalFrom = Buffer.from
    let decoderCalled = false
    Buffer.from = ((value: unknown, ...args: unknown[]) => {
      if (value === encoded) {
        decoderCalled = true
        throw new Error('base64 decoder was invoked')
      }
      return originalFrom(value as never, ...(args as never[]))
    }) as typeof Buffer.from
    try {
      expect(() =>
        adaptPayloadLexical(
          strictFixture([{ type: 'upload', value: 'oversized' }], {
            uploads: [
              {
                id: 'oversized',
                filename: 'oversized.png',
                mimeType: 'image/png',
                alt: 'Oversized image',
                data: encoded,
              },
            ],
          }),
        ),
      ).toThrow(/Payload upload exceeds encoded byte bound.*children\[0\]/i)
      expect(decoderCalled).toBe(false)
    } finally {
      Buffer.from = originalFrom
    }
  })

  it('never enumerates typed upload bytes and hashes only their exact slice for revisions', () => {
    const adaptBytes = (backing: Uint8Array) =>
      adaptPayloadLexical(
        strictFixture([{ type: 'upload', value: 'typed' }], {
          uploads: [
            {
              id: 'typed',
              filename: 'typed.png',
              mimeType: 'image/png',
              alt: 'Typed bytes',
              bytes: new Uint8Array(
                backing.buffer,
                backing.byteOffset + 1,
                4,
              ),
            },
          ],
        }),
      )
    const originalKeys = Object.keys
    Object.keys = ((value: object) => {
      if (ArrayBuffer.isView(value))
        throw new Error('typed-array properties must not be enumerated')
      return originalKeys(value)
    }) as typeof Object.keys

    try {
      const first = adaptBytes(new Uint8Array([9, 1, 2, 3, 4, 9]))
      const sameSlice = adaptBytes(new Uint8Array([7, 1, 2, 3, 4, 8]))
      const changedSlice = adaptBytes(new Uint8Array([7, 1, 2, 3, 5, 8]))

      expect(first.assetBundle.descriptor.assets[0]).toMatchObject({
        byteLength: 4,
        mediaType: 'image/png',
      })
      expect(sameSlice.provenance.sourceRevision).toBe(
        first.provenance.sourceRevision,
      )
      expect(changedSlice.provenance.sourceRevision).not.toBe(
        first.provenance.sourceRevision,
      )
    } finally {
      Object.keys = originalKeys
    }
  })

  it('rejects unsupported ArrayBuffer view types before revision serialization', () => {
    expect(() =>
      adaptPayloadLexical(
        strictFixture([{ type: 'upload', value: 'typed' }], {
          uploads: [
            {
              id: 'typed',
              filename: 'typed.png',
              mimeType: 'image/png',
              alt: 'Typed bytes',
              bytes: new Uint16Array([1, 2, 3, 4]),
            },
          ],
        }),
      ),
    ).toThrow(/unsupported byte view type.*uploads\[0\]\.bytes/i)
  })

  it('validates intrinsic upload metadata before missing-byte and same-hash shortcuts', () => {
    const completeUpload = {
      id: 'asset',
      filename: 'asset.png',
      mimeType: 'image/png',
      data: 'AQIDBA==',
      alt: 'Asset alternative',
    }
    const adaptUpload = (upload: Record<string, unknown>) =>
      adaptPayloadLexical(
        strictFixture([{ type: 'upload', value: 'asset' }], {
          uploads: [upload],
        }),
      )

    for (const [override, error] of [
      [{ mimeType: 'not/mime?' }, /invalid media type.*children\[0\]/i],
      [{ width: '24' }, /width must be a positive integer.*children\[0\]/i],
      [{ focalPoint: { x: 0.5 } }, /invalid focal point.*children\[0\]/i],
    ] as const) {
      expect(() => adaptUpload({ ...completeUpload, ...override })).toThrow(error)
    }
    expect(() =>
      adaptUpload({
        ...completeUpload,
        data: undefined,
        crop: { x: 0, y: 0, width: 1, height: 1, unit: 'em' },
      }),
    ).toThrow(/unsupported unit em.*children\[0\]/i)

    const zeroBytes = adaptUpload({
      ...completeUpload,
      data: undefined,
      bytes: [],
    })
    expect(zeroBytes.assetBundle.descriptor.assets).toEqual([])
    expect(zeroBytes.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing-asset' })]))

    expect(() =>
      adaptPayloadLexical(
        strictFixture(
          [
            { type: 'upload', value: 'one' },
            { type: 'upload', value: 'two' },
          ],
          {
            uploads: [
              { ...completeUpload, id: 'one', mimeType: 'image/png' },
              { ...completeUpload, id: 'two', mimeType: 'image/webp' },
            ],
          },
        ),
      ),
    ).toThrow(/uploads at .*children\[0\].* and .*children\[1\].*share bytes but disagree on intrinsic metadata/i)
  })

  it('deduplicates renamed copies of identical bytes with a deterministic filename', () => {
    const adaptNames = (names: [string, string]) =>
      adaptPayloadLexical(
        strictFixture(
          [
            { type: 'upload', value: 'first' },
            { type: 'upload', value: 'second' },
          ],
          {
            uploads: names.map((filename, index) => ({
              id: index === 0 ? 'first' : 'second',
              filename,
              mimeType: 'image/png',
              data: 'AQIDBA==',
              alt: 'Shared image',
            })),
          },
        ),
      )

    const forward = adaptNames(['z-copy.png', 'a-original.png'])
    const reverse = adaptNames(['a-original.png', 'z-copy.png'])
    expect(forward.assetBundle.descriptor.assets).toHaveLength(1)
    expect(reverse.assetBundle.descriptor.assets).toHaveLength(1)
    expect(forward.assetBundle.descriptor.assets[0].fileName).toBe(
      'a-original.png',
    )
    expect(reverse.assetBundle.descriptor.assets[0].fileName).toBe(
      'a-original.png',
    )
  })

  it('requires accessible, renderer-compatible upload and media semantics', () => {
    const bytes = 'AQIDBA=='
    expect(() =>
      adaptPayloadLexical(
        strictFixture([{ type: 'upload', value: 'pic' }], {
          uploads: [
            {
              id: 'pic',
              filename: 'pic.png',
              mimeType: 'image/png',
              data: bytes,
            },
          ],
        }),
      ),
    ).toThrow(/Payload upload requires non-empty alternative text.*children\[0\]/)
    expect(() =>
      adaptPayloadLexical(
        strictFixture([{ type: 'media', value: 'clip' }], {
          uploads: [
            {
              id: 'clip',
              filename: 'clip.mp4',
              mimeType: 'video/mp4',
              data: bytes,
            },
          ],
        }),
      ),
    ).toThrow(/Payload media requires non-empty alternative text.*children\[0\]/)

    const inferredVideo = adaptPayloadLexical(
      strictFixture([{ type: 'media', value: 'clip' }], {
        uploads: [
          {
            id: 'clip',
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
            data: bytes,
            alt: 'Demonstration video',
          },
        ],
      }),
    )
    expect(inferredVideo.graph.nodes[0]).toMatchObject({
      type: 'media',
      mediaKind: 'video',
    })
    expect(() =>
      adaptPayloadLexical(
        strictFixture([{ type: 'media', kind: 'audio', value: 'clip' }], {
          uploads: [
            {
              id: 'clip',
              filename: 'clip.mp4',
              mimeType: 'video/mp4',
              data: bytes,
              alt: 'Contradictory media',
            },
          ],
        }),
      ),
    ).toThrow(/media kind audio contradicts video\/mp4.*children\[0\]/i)
    expect(() =>
      adaptPayloadLexical(
        strictFixture([{ type: 'upload', value: 'clip' }], {
          uploads: [
            {
              id: 'clip',
              filename: 'clip.mp4',
              mimeType: 'video/mp4',
              data: bytes,
              alt: 'Not a figure',
            },
          ],
        }),
      ),
    ).toThrow(/Payload figure requires image media.*children\[0\]/)

    expect(() =>
      adaptPayloadLexical(
        strictFixture([{ type: 'media', kind: 'video', value: 'document' }], {
          uploads: [
            {
              id: 'document',
              filename: 'document.pdf',
              mimeType: 'application/pdf',
              data: bytes,
              alt: 'Not a video',
            },
          ],
        }),
      ),
    ).toThrow(/media kind video contradicts application\/pdf.*children\[0\]/i)
  })

  it.each(['audio', 'video'] as const)(
    'fails closed when %s media has no embedded bytes',
    (mediaKind) => {
      expect(() =>
        adaptPayloadLexical(
          strictFixture([{ type: 'media', kind: mediaKind, value: 'remote' }], {
            uploads: [
              {
                id: 'remote',
                filename: mediaKind === 'audio' ? 'remote.mp3' : 'remote.mp4',
                mimeType: mediaKind === 'audio' ? 'audio/mpeg' : 'video/mp4',
                alt: `Remote ${mediaKind}`,
              },
            ],
          }),
        ),
      ).toThrow(
        new RegExp(
          `Payload ${mediaKind} media has no embedded bytes.*children\\[0\\]`,
        ),
      )
    },
  )

  it('fails closed on missing interactive bytes while retaining image fallback', () => {
    const missingUploads = [
      {
        id: 'interactive',
        fileName: 'interactive.html',
        mediaType: 'text/html',
        alt: 'Interactive explainer',
      },
      {
        id: 'image',
        fileName: 'image.png',
        mediaType: 'image/png',
        alt: 'Static image fallback',
      },
    ]
    expect(() =>
      adaptPayloadLexical(
        strictFixture(
          [{ type: 'media', kind: 'interactive', value: 'interactive' }],
          { uploads: missingUploads },
        ),
      ),
    ).toThrow(/Payload interactive media has no embedded bytes/i)

    const image = adaptPayloadLexical(
      strictFixture([{ type: 'media', kind: 'image', value: 'image' }], {
        uploads: missingUploads,
      }),
    )
    expect(image.graph.nodes[0]).toMatchObject({
      type: 'figure',
      assetIds: [],
      sourceText: 'Missing local asset: Static image fallback',
    })
    expect(image.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing-asset' }),
      ]),
    )
  })

  it('uses the missing-upload title as an accessible source fallback', () => {
    const result = adaptPayloadLexical(
      strictFixture([{ type: 'upload', value: 'remote' }], {
        uploads: [
          {
            id: 'remote',
            filename: 'remote.png',
            mimeType: 'image/png',
          },
        ],
      }),
    )
    expect(result.graph.nodes[0]).toMatchObject({
      type: 'figure',
      sourceText: 'Missing local asset: remote.png',
      accessibility: {
        decorative: false,
        alternativeText: 'remote.png',
      },
    })
    expect(publicationGraphToHtml(result.graph, new Map(), 'phone-webpub')).toContain(
      'aria-label="remote.png"',
    )
  })

  it('preserves scalar configured prose and object-map upload identity without precedence loss', () => {
    const scalarBlock = adaptPayloadLexical(
      strictFixture([
        {
          type: 'block',
          fields: { blockType: 'notice', content: 'Scalar notice' },
        },
      ]),
      { blocks: { notice: 'aside' } },
    )
    expect(scalarBlock.graph.nodes[0]).toMatchObject({
      type: 'aside',
      text: 'Scalar notice',
    })
    expect(() =>
      adaptPayloadLexical(
        strictFixture([
          {
            type: 'block',
            fields: {
              blockType: 'notice',
              content: 'Direct notice',
              children: [{ type: 'text', text: 'Inline notice' }],
            },
          },
        ]),
        { blocks: { notice: 'aside' } },
      ),
    ).toThrow(/Payload aside has conflicting inline and direct text.*children\[0\]/)

    const mappedUpload = adaptPayloadLexical(
      strictFixture([{ type: 'upload', value: 'pic' }], {
        uploads: {
          pic: {
            filename: 'pic.png',
            mimeType: 'image/png',
            data: 'AQIDBA==',
            alt: 'Mapped picture',
          },
        },
      }),
    )
    expect(mappedUpload.graph.nodes[0]).toMatchObject({
      type: 'figure',
      assetIds: [expect.any(String)],
      accessibility: { alternativeText: 'Mapped picture' },
    })
  })

  it('fails closed for table and relationship semantics the graph cannot preserve', () => {
    const tableDocument = (cell: Record<string, unknown>) =>
      strictFixture([
        {
          type: 'block',
          fields: { blockType: 'grid', rows: [{ cells: [cell] }] },
        },
      ])
    for (const cell of [
      { text: 'Cell', headerScope: 'sideways' },
      { text: 'Cell', header: 'yes' },
      { text: 'Cell', header: true, isHeader: false },
      { text: 'Cell', colSpan: 0 },
      { text: 'Cell', rowSpan: '2' },
      { text: 'Cell', headerIds: 'heading' },
      { text: 'Cell', headerIds: ['bad id'] },
      { text: 42 },
    ]) {
      expect(() => adaptPayloadLexical(tableDocument(cell), { blocks: { grid: 'table' } })).toThrow(/Payload table cell.*content\.root\.children\[0\].*rows\[0\]\.cells\[0\]/)
    }

    const relationshipMapping = {
      relationships: { citation: { role: 'citation' as const } },
    }
    expect(() =>
      adaptPayloadLexical(
        strictFixture([
          {
            type: 'paragraph',
            children: [{ type: 'citation', value: 'target-1', label: '' }],
          },
        ]),
        relationshipMapping,
      ),
    ).toThrow(/Payload relationship label is empty.*children\[0\]\.children\[0\]/)
    expect(() =>
      adaptPayloadLexical(
        strictFixture([
          {
            type: 'paragraph',
            children: [
              {
                type: 'citation',
                value: 'target-1',
                label: 'Citation',
                children: [{ type: 'text', text: 'Ignored label' }],
              },
            ],
          },
        ]),
        relationshipMapping,
      ),
    ).toThrow(/Payload relationship children are unsupported.*children\[0\]\.children\[0\]/)
    expect(() => adaptPayloadLexical(strictFixture([{ type: 'citation', value: 'target-1', label: 'Citation' }]), relationshipMapping)).toThrow(
      /Payload block relationship role citation is unsupported.*children\[0\]/,
    )

    for (const nested of [
      {
        type: 'link',
        url: 'https://nested.example',
        children: [{ type: 'text', text: 'Nested link' }],
      },
      { type: 'citation', value: 'target-1', label: 'Nested citation' },
    ]) {
      expect(() =>
        adaptPayloadLexical(
          strictFixture([
            {
              type: 'paragraph',
              children: [
                {
                  type: 'link',
                  url: 'https://outer.example',
                  children: [nested],
                },
              ],
            },
          ]),
          relationshipMapping,
        ),
      ).toThrow(/Payload link-producing node .* cannot be nested inside a link.*children\[0\]\.children\[0\]/)
    }

    expect(() =>
      adaptPayloadLexical({
        document: strictFixture([
          { type: 'citation', value: 'target-1', label: 'Ambiguous mapping' },
        ]),
        mapping: {
          blocks: { citation: 'aside' },
          relationships: { citation: { role: 'cross-reference' } },
        },
      }),
    ).toThrow(/Payload mapping key citation cannot be both a block and relationship/)
  })

  it('rejects a relationship collection name without a target record', () => {
    expect(() =>
      adaptPayloadLexical(
        strictFixture([
          {
            type: 'paragraph',
            children: [
              {
                type: 'relationship',
                relationTo: 'posts',
                label: 'Missing post',
              },
            ],
          },
        ]),
      ),
    ).toThrow(/Payload relationship is missing target.*children\[0\]\.children\[0\]/)
  })

  it('redacts unsafe relationship targets from thrown diagnostics', () => {
    const sentinel = 'unsafe-target?credential=redact-me'
    const message = capturedError(() =>
      adaptPayloadLexical(
        {
          id: 'unsafe-relationship-target',
          title: 'Unsafe relationship target',
          content: {
            root: {
              children: [
                {
                  type: 'paragraph',
                  children: [
                    { type: 'citation', value: sentinel, label: 'Sentinel' },
                  ],
                },
              ],
            },
          },
        },
        { relationships: { citation: { role: 'citation' } } },
      ),
    )
    expect(message).toMatch(
      /Payload relationship target \(sha256:[0-9a-f]{16}\) is not a graph-safe id.*children\[0\]\.children\[0\]/,
    )
    expect(message).not.toContain(sentinel)
    expect(message).not.toContain('credential')
    expect(message).not.toContain('redact-me')
    expect(message).not.toContain('unsafe-target')
  })

  it('requires typed metadata, roots, prose fields, and supported mark combinations', () => {
    const body = [{ type: 'paragraph', children: [{ type: 'text', text: 'Body' }] }]
    for (const extra of [{ title: 42 }, { description: false }, { authors: [true] }, { version: { label: 'v1' } }, { keywords: 'one, two' }, { createdAt: '2024-02-31' }]) {
      expect(() => adaptPayloadLexical(strictFixture(body, extra))).toThrow(/Payload (?:title|description|author|version|keywords|created).*?(?:string|array|valid date)/i)
    }
    expect(() =>
      adaptPayloadLexical({
        ...strictFixture(body),
        content: { root: { type: 'mystery', children: body } },
      }),
    ).toThrow(/Payload rich text root type mystery is unsupported/)
    expect(() =>
      adaptPayloadLexical(
        strictFixture([
          {
            type: 'block',
            fields: {
              blockType: 'notice',
              content: {
                root: {
                  type: 'mystery',
                  children: [{ type: 'text', text: 'Hidden' }],
                },
              },
            },
          },
        ]),
        { blocks: { notice: 'aside' } },
      ),
    ).toThrow(/Payload rich text root type mystery is unsupported.*children\[0\]/)
    expect(() => adaptPayloadLexical(strictFixture([]))).toThrow(/Payload Lexical content is empty.*root/)
    for (const format of [96, 'subscript|superscript', ['subscript', 'superscript']]) {
      expect(() =>
        adaptPayloadLexical(
          strictFixture([
            {
              type: 'paragraph',
              children: [{ type: 'text', text: 'Conflict', format }],
            },
          ]),
        ),
      ).toThrow(/subscript and superscript.*children\[0\]\.children\[0\]/i)
    }
    expect(() => adaptPayloadLexical(strictFixture([{ type: 'code', code: 42 }]))).toThrow(/Payload code must be a non-empty string.*children\[0\]/)
    expect(() => adaptPayloadLexical(strictFixture([{ type: 'code', code: 'print(1)', language: 42 }]))).toThrow(/Payload code language must be a non-empty string.*children\[0\]/)
    expect(() =>
      adaptPayloadLexical(
        strictFixture([{ type: 'upload', value: 'pic', title: 42 }], {
          uploads: [
            {
              id: 'pic',
              filename: 'pic.png',
              mimeType: 'image/png',
              data: 'AQIDBA==',
              alt: 'Alternative',
            },
          ],
        }),
      ),
    ).toThrow(/Payload upload title must be a non-empty string.*children\[0\]/)
    expect(() => adaptPayloadLexical(strictFixture([{ type: 'paragraph', text: 42 }]))).toThrow(/Payload paragraph text must be a non-empty string.*children\[0\]/)
    expect(() => adaptPayloadLexical(strictFixture([{ type: 'equation', source: 'x', label: 42 }]), { blocks: { equation: 'equation' } })).toThrow(
      /Payload equation label must be a non-empty string.*children\[0\]/,
    )
    expect(() =>
      adaptPayloadLexical(
        strictFixture([{ type: 'upload', value: 'pic', alt: 42 }], {
          uploads: [
            {
              id: 'pic',
              filename: 'pic.png',
              mimeType: 'image/png',
              data: 'AQIDBA==',
            },
          ],
        }),
      ),
    ).toThrow(/Payload upload alternative text must be a non-empty string.*children\[0\]/)
    for (const extra of [{ id: true }, { status: { label: 'published' } }, { locale: { name: 'en' } }]) {
      expect(() => adaptPayloadLexical(strictFixture(body, extra))).toThrow(/Payload (?:publication id|status|publication has invalid locale)/i)
    }
    expect(() => adaptPayloadLexical({ document: strictFixture(body), locale: 42 })).toThrow(/Payload requested locale must be a non-empty string/)
    expect(() =>
      adaptPayloadLexical(
        strictFixture([
          {
            type: 'paragraph',
            children: [
              {
                type: 'link',
                url: { value: 'https://example.com' },
                children: [{ type: 'text', text: 'Link' }],
              },
            ],
          },
        ]),
      ),
    ).toThrow(/Payload link href must be a non-empty string.*children\[0\]/)
    expect(() =>
      adaptPayloadLexical(
        strictFixture([
          {
            type: { name: 'paragraph' },
            children: [{ type: 'text', text: 'Not typed' }],
          },
        ]),
      ),
    ).toThrow(/Unsupported Lexical node unknown.*children\[0\]/)
    expect(() =>
      adaptPayloadLexical(
        strictFixture([
          {
            type: 'block',
            fields: { blockType: { name: 'notice' }, text: 'Notice' },
          },
        ]),
        { blocks: { notice: 'aside' } },
      ),
    ).toThrow(/Payload configured block type must be a non-empty string.*children\[0\]/)
    expect(() =>
      adaptPayloadLexical(
        strictFixture([
          {
            type: 'relationship',
            value: 'target-1',
            relationshipType: { name: 'post' },
          },
        ]),
      ),
    ).toThrow(/Payload relationship type must be a non-empty string.*children\[0\]/)
    for (const node of [
      {
        type: 'paragraph',
        text: 'Direct',
        children: [{ type: 'text', text: 'Inline' }],
      },
      {
        type: 'list',
        children: [
          {
            type: 'listitem',
            text: 'Direct',
            children: [{ type: 'text', text: 'Inline' }],
          },
        ],
      },
      {
        type: 'list',
        children: [{ type: 'listitem', text: true, children: [] }],
      },
    ]) {
      expect(() => adaptPayloadLexical(strictFixture([node]))).toThrow(/Payload (?:paragraph|listitem) (?:has conflicting inline and direct text|text must be a non-empty string).*children\[0\]/)
    }
    const configuredHeading = adaptPayloadLexical(
      strictFixture([
        {
          type: 'block',
          fields: {
            blockType: 'section',
            tag: 'h3',
            text: 'Configured heading',
          },
        },
      ]),
      { blocks: { section: 'heading' } },
    )
    expect(configuredHeading.graph.nodes[0]).toMatchObject({
      type: 'heading',
      level: 3,
    })
    expect(() =>
      adaptPayloadLexical(
        strictFixture([
          {
            type: 'block',
            fields: {
              blockType: 'section',
              level: 7,
              text: 'Invalid heading',
            },
          },
        ]),
        { blocks: { section: 'heading' } },
      ),
    ).toThrow(/Payload heading has invalid level or tag.*children\[0\]/)
  })

  it('skips blank Lexical paragraphs before reserving ids without weakening node validation', () => {
    let retainedNodes: unknown
    try {
      retainedNodes = adaptPayloadLexical(
        strictFixture([
          { type: 'paragraph', id: 'body', children: [] },
          {
            type: 'paragraph',
            id: 'body',
            children: [{ type: 'text', text: 'Retained body.' }],
          },
          { type: 'paragraph', children: [{ type: 'linebreak' }] },
          { type: 'paragraph', children: [] },
        ]),
      ).graph.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        text: node.type === 'paragraph' ? node.text : undefined,
      }))
    } catch (error) {
      retainedNodes = error instanceof Error ? error.message : String(error)
    }

    expect({
      retainedNodes,
      allBlankError: capturedError(() =>
        adaptPayloadLexical(
          strictFixture([
            { type: 'paragraph', children: [] },
            { type: 'paragraph', children: [{ type: 'linebreak' }] },
          ]),
        ),
      ),
      emptyHeadingError: capturedError(() =>
        adaptPayloadLexical(strictFixture([{ type: 'heading', children: [] }])),
      ),
      emptyQuoteError: capturedError(() =>
        adaptPayloadLexical(strictFixture([{ type: 'quote', children: [] }])),
      ),
      emptyListItemError: capturedError(() =>
        adaptPayloadLexical(
          strictFixture([
            {
              type: 'list',
              children: [{ type: 'listitem', children: [] }],
            },
          ]),
        ),
      ),
      emptyMappedParagraphError: capturedError(() =>
        adaptPayloadLexical(
          strictFixture([
            {
              type: 'block',
              fields: { blockType: 'notice', children: [] },
            },
          ]),
          { blocks: { notice: 'paragraph' } },
        ),
      ),
      malformedTextError: capturedError(() =>
        adaptPayloadLexical(
          strictFixture([
            {
              type: 'paragraph',
              children: [{ type: 'text', text: '' }],
            },
          ]),
        ),
      ),
    }).toEqual({
      retainedNodes: [
        { id: 'body', type: 'paragraph', text: 'Retained body.' },
      ],
      allBlankError: expect.stringMatching(/Payload Lexical content is empty/i),
      emptyHeadingError: expect.stringMatching(/Payload heading is empty/i),
      emptyQuoteError: expect.stringMatching(/Payload quote is empty/i),
      emptyListItemError: expect.stringMatching(/Payload listitem is empty/i),
      emptyMappedParagraphError: expect.stringMatching(
        /Payload paragraph is empty/i,
      ),
      malformedTextError: expect.stringMatching(
        /Payload text node requires non-empty string text/i,
      ),
    })
  })

  it('collects standard Lexical code text children and line breaks', () => {
    const result = adaptPayloadLexical(
      strictFixture([
        {
          type: 'code',
          language: 'typescript',
          children: [
            { type: 'code-highlight', text: 'const answer = 42' },
            { type: 'linebreak' },
            { type: 'text', text: 'return answer' },
          ],
        },
      ]),
    )
    expect(result.graph.nodes[0]).toMatchObject({
      type: 'code',
      language: 'typescript',
      code: 'const answer = 42\nreturn answer',
    })
  })

  it('keeps localized contributor prose separate and validates locale declarations', () => {
    const localizedDocument = {
      ...strictFixture(
        [
          {
            type: 'paragraph',
            children: [{ type: 'text', text: 'English body' }],
          },
        ],
        { authors: ['English author'] },
      ),
      localeVariants: {
        fr: {
          title: 'Titre français',
          content: {
            root: {
              type: 'root',
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'text', text: 'Corps français' }],
                },
              ],
            },
          },
        },
      },
    }
    const french = adaptPayloadLexical({
      document: localizedDocument,
      locale: 'fr',
    })
    expect(french.graph.metadata.contributors).toEqual([])
    expect(() =>
      adaptPayloadLexicalEditions({
        ...localizedDocument,
        localeVariants: {
          fr: {
            ...localizedDocument.localeVariants.fr,
            locale: 'de',
          },
        },
      }),
    ).toThrow(/Payload locale variant.*declares de.*map key fr/i)

    const nestedMetadata = adaptPayloadLexical({
      document: {
        ...strictFixture(
          [
            {
              type: 'paragraph',
              children: [{ type: 'text', text: 'English body' }],
            },
          ],
          {
            meta: {
              status: 'published',
              version: 'v1',
              created: '2024-01-02',
              modified: '2024-02-03',
            },
          },
        ),
        localeVariants: {
          fr: {
            title: 'Titre imbriqué',
            meta: { version: 'v2' },
            content: {
              root: {
                type: 'root',
                children: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Corps imbriqué' }],
                  },
                ],
              },
            },
          },
        },
      },
      mapping: {
        fields: {
          status: 'meta.status',
          version: 'meta.version',
          created: 'meta.created',
          modified: 'meta.modified',
        },
      },
      locale: 'fr',
    })
    expect(nestedMetadata.graph.metadata).toMatchObject({
      status: 'published',
      sourceDocumentVersion: 'v2',
      created: '2024-01-02',
      modified: '2024-02-03',
    })
  })

  it('fails closed instead of silently inheriting base-language content in a partial locale variant', () => {
    expect(() =>
      adaptPayloadLexical({
        document: {
          id: 'partial-locale',
          title: 'English title',
          locale: 'en',
          content: {
            root: {
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'text', text: 'English body' }],
                },
              ],
            },
          },
          localeVariants: {
            fr: { title: 'Titre français' },
          },
        },
        locale: 'fr',
      }),
    ).toThrow(/Payload locale fr is missing mapped Lexical content/)

    const localized = adaptPayloadLexical({
      document: {
        id: 'localized-metadata',
        title: 'English title',
        description: 'English description',
        keywords: ['English keyword'],
        locale: 'en',
        content: {
          root: {
            children: [
              {
                type: 'paragraph',
                children: [{ type: 'text', text: 'English body' }],
              },
            ],
          },
        },
        localeVariants: {
          fr: {
            title: 'Titre français',
            content: {
              root: {
                children: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Corps français' }],
                  },
                ],
              },
            },
          },
        },
      },
      locale: 'fr',
    })
    expect(localized.graph.metadata.abstract).toBeUndefined()
    expect(localized.graph.metadata.keywords).toEqual([])

    const localizedUploadDocument = {
      id: 'localized-upload',
      title: 'English title',
      locale: 'en',
      uploads: [
        {
          id: 'pic',
          filename: 'pic.png',
          mimeType: 'image/png',
          data: 'AQIDBA==',
          alt: 'English alternative',
        },
      ],
      content: {
        root: {
          children: [{ type: 'upload', value: 'pic' }],
        },
      },
      localeVariants: {
        fr: {
          title: 'Titre français',
          content: {
            root: {
              children: [{ type: 'upload', value: 'pic' }],
            },
          },
        },
      },
    }
    expect(() => adaptPayloadLexical({ document: localizedUploadDocument, locale: 'fr' })).toThrow(/Payload locale fr upload pic is missing localized alternative text.*children\[0\]/)

    const localizedUpload = adaptPayloadLexical({
      document: {
        ...localizedUploadDocument,
        localeVariants: {
          fr: {
            title: 'Titre français',
            content: {
              root: {
                children: [
                  {
                    type: 'upload',
                    value: 'pic',
                    title: 'Image française',
                    alt: 'Alternative française',
                  },
                ],
              },
            },
          },
        },
      },
      locale: 'fr',
    })
    expect(localizedUpload.graph.nodes[0]).toMatchObject({
      type: 'figure',
      title: 'Image française',
      accessibility: { alternativeText: 'Alternative française' },
    })
    expect(localizedUpload.assetBundle.descriptor.assets[0].accessibilityLabel).toBe('Alternative française')
  })

  it('maps explicitly configured Payload blocks and relationships without executing them', () => {
    const result = adaptPayloadLexical(
      {
        id: 'configured-blocks',
        title: 'Configured blocks',
        content: {
          root: {
            children: [
              {
                type: 'block',
                fields: { blockType: 'notice', text: 'Notice' },
              },
              {
                type: 'block',
                fields: {
                  blockType: 'grid',
                  rows: [
                    {
                      cells: [{ text: 'Header', header: true }, { text: 'Value' }],
                    },
                  ],
                },
              },
              { type: 'citation', value: 'target-1', label: 'A citation' },
            ],
          },
        },
      },
      {
        blocks: { notice: 'aside', grid: 'table' },
        relationships: { citation: { role: 'cross-reference' } },
      },
    )
    expect(result.graph.nodes.map((node) => node.type)).toEqual(['aside', 'table', 'reference', 'reference'])
    expect(result.graph.nodes.find((node) => node.type === 'reference')).toMatchObject({ href: '#target-1' })
  })

  it('maps Payload LinkFeature document targets before requiring an external URL', () => {
    const result = adaptPayloadLexical(
      strictFixture([
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              fields: {
                doc: { relationTo: 'posts', value: 'target-post' },
                linkType: 'internal',
              },
              children: [
                { type: 'text', text: 'Read ' },
                { type: 'text', text: 'the post', format: 'bold' },
              ],
            },
          ],
        },
      ]),
      {
        relationships: {
          link: {
            target: 'fields.doc.value',
            role: 'cross-reference',
          },
        },
      },
    )
    const paragraph = result.graph.nodes.find(
      (node) => node.type === 'paragraph',
    )
    expect(paragraph).toMatchObject({
      type: 'paragraph',
      text: 'Read the post',
      inlineRuns: expect.arrayContaining([
        expect.objectContaining({
          start: 5,
          end: 13,
          bold: true,
        }),
        expect.objectContaining({
          start: 0,
          end: 13,
          href: '#target-post',
          semanticRole: 'cross-reference',
          targetIds: ['target-post'],
        }),
      ]),
    })
    expect(result.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'target-post', type: 'reference' }),
      ]),
    )
  })

  it('prefers internal LinkFeature targets when URL fields are null or blank', () => {
    const internalHrefs = [null, '', '   '].map((url) => {
      try {
        const result = adaptPayloadLexical(
          strictFixture([
            {
              type: 'paragraph',
              children: [
                {
                  type: 'link',
                  fields: {
                    doc: { relationTo: 'posts', value: 'target-post' },
                    linkType: 'internal',
                    url,
                  },
                  children: [{ type: 'text', text: 'Internal post' }],
                },
              ],
            },
          ]),
          {
            relationships: {
              link: {
                target: 'fields.doc.value',
                role: 'cross-reference',
              },
            },
          },
        )
        const paragraph = result.graph.nodes.find(
          (node) => node.type === 'paragraph',
        )
        return paragraph?.type === 'paragraph'
          ? paragraph.inlineRuns?.find((run) => run.targetIds?.[0] === 'target-post')
              ?.href
          : undefined
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    const malformedExternalErrors = ['', '   ', { href: '/not-a-string' }].map(
      (url) =>
        capturedError(() =>
          adaptPayloadLexical(
            strictFixture([
              {
                type: 'paragraph',
                children: [
                  {
                    type: 'link',
                    fields: { url },
                    children: [{ type: 'text', text: 'External link' }],
                  },
                ],
              },
            ]),
          ),
        ),
    )

    expect({ internalHrefs, malformedExternalErrors }).toEqual({
      internalHrefs: ['#target-post', '#target-post', '#target-post'],
      malformedExternalErrors: [
        expect.stringMatching(/link is missing href/i),
        expect.stringMatching(/link is missing href/i),
        expect.stringMatching(/link href must be a non-empty string/i),
      ],
    })
  })

  it('keeps external links when a link relationship mapping is configured', () => {
    const result = adaptPayloadLexical(
      strictFixture([
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: 'https://example.com/external',
              children: [{ type: 'text', text: 'External link' }],
            },
          ],
        },
      ]),
      {
        relationships: {
          link: {
            target: 'fields.doc.value',
            role: 'cross-reference',
          },
        },
      },
    )
    expect(result.graph.nodes[0]).toMatchObject({
      type: 'paragraph',
      inlineRuns: [
        expect.objectContaining({ href: 'https://example.com/external' }),
      ],
    })
  })

  it('emits one external-link range around formatted Lexical child runs', () => {
    const result = adaptPayloadLexical(
      strictFixture([
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: 'https://example.com/formatted',
              children: [
                { type: 'text', text: 'Read ' },
                { type: 'text', text: 'more', format: 'bold' },
              ],
            },
          ],
        },
      ]),
    )
    const paragraph = result.graph.nodes.find(
      (node) => node.type === 'paragraph',
    )
    expect(paragraph).toMatchObject({
      type: 'paragraph',
      text: 'Read more',
      inlineRuns: [
        { start: 5, end: 9, bold: true },
        {
          start: 0,
          end: 9,
          href: 'https://example.com/formatted',
        },
      ],
    })
  })

  it('rejects nested link producers inside mapped Payload document links', () => {
    expect(() =>
      adaptPayloadLexical(
        strictFixture([
          {
            type: 'paragraph',
            children: [
              {
                type: 'link',
                fields: { doc: { value: 'target-post' } },
                children: [
                  {
                    type: 'citation',
                    value: 'nested-target',
                    label: 'Nested citation',
                  },
                ],
              },
            ],
          },
        ]),
        {
          relationships: {
            link: {
              target: 'fields.doc.value',
              role: 'cross-reference',
            },
            citation: { role: 'citation' },
          },
        },
      ),
    ).toThrow(
      /Payload link-producing node citation cannot be nested inside a link.*children\[0\]\.children\[0\]/,
    )
  })

  it('keeps inline relationship anchors distinct from their target node ids', () => {
    const result = adaptPayloadLexical(
      {
        id: 'inline-relationships',
        title: 'Inline relationships',
        content: {
          root: {
            children: [
              {
                type: 'paragraph',
                children: [
                  {
                    type: 'citation',
                    value: 'target-1',
                    label: 'First citation',
                  },
                  { type: 'text', text: ' and ' },
                  {
                    type: 'citation',
                    value: 'target-1',
                    label: 'Second citation',
                  },
                ],
              },
            ],
          },
        },
      },
      { relationships: { citation: { role: 'citation' } } },
    )
    const paragraph = result.graph.nodes.find((node) => node.type === 'paragraph')
    const runs = paragraph?.type === 'paragraph' ? (paragraph.inlineRuns?.filter((run) => run.semanticRole === 'citation') ?? []) : []
    expect(result.graph.nodes.some((node) => node.id === 'target-1')).toBe(true)
    expect(runs).toHaveLength(2)
    expect(new Set(runs.map((run) => run.relationshipId)).size).toBe(2)
    expect(runs.every((run) => run.relationshipId !== run.targetIds?.[0])).toBe(true)
  })

  it('declares missing uploads and keeps locales as separate editions', () => {
    const missing = adaptPayloadLexical({
      id: 'missing',
      title: 'Missing',
      content: {
        root: {
          children: [{ type: 'upload', id: 'missing-upload', value: 'not-present' }],
        },
      },
      uploads: [{ id: 'not-present', filename: 'missing.png', mimeType: 'image/png' }],
    })
    expect(missing.diagnostics.map((diagnostic) => diagnostic.code)).toContain('missing-asset')
    expect(missing.graph.nodes[0]).toMatchObject({
      type: 'figure',
      assetIds: [],
    })
    const remoteOnly = adaptPayloadLexical({
      id: 'remote-only',
      title: 'Remote only',
      content: {
        root: {
          children: [{ type: 'upload', value: 'remote-upload' }],
        },
      },
      uploads: [
        {
          id: 'remote-upload',
          filename: 'remote.png',
          mimeType: 'image/png',
          url: 'https://example.com/remote.png',
        },
      ],
    })
    expect(remoteOnly.assetBundle.descriptor.assets).toEqual([])
    expect(remoteOnly.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing-asset' })]))
    const editions = adaptPayloadLexicalEditions(publication, mapping)
    expect(editions.map((edition) => edition.graph.edition.locale)).toEqual(['en', 'fr'])
    expect(editions[1].graph.metadata.title).toBe('Fixture de parité Payload')
    expect(editions[1].graph.nodes.map((node) => ('text' in node ? node.text : ''))).toContain('Une édition française distincte.')
    expect(editions[1].graph.nodes.map((node) => ('text' in node ? node.text : ''))).not.toContain('Meaning survives a source change.')
    expect(editions[1].graph.nodes[0].edition.equivalentNodeId).toBeUndefined()

    const linkedDocument = {
      id: 'linked-editions',
      title: 'Linked editions',
      locale: 'en',
      content: {
        root: {
          children: [
            {
              type: 'paragraph',
              id: 'shared-paragraph',
              children: [{ type: 'text', text: 'English' }],
            },
          ],
        },
      },
      localeVariants: {
        fr: {
          title: 'Éditions liées',
          content: {
            root: {
              children: [
                {
                  type: 'paragraph',
                  id: 'shared-paragraph',
                  children: [{ type: 'text', text: 'Français' }],
                },
              ],
            },
          },
        },
      },
    }
    const linked = adaptPayloadLexicalEditions(linkedDocument)
    expect(linked[1].graph.nodes[0].edition.equivalentNodeId).toBe('shared-paragraph')
    expect(
      adaptPayloadLexicalEditions({
        document: linkedDocument,
        locale: 'fr',
      }).map((edition) => edition.graph.edition.locale),
    ).toEqual(['en', 'fr'])
    const canonicalBaseRequest = adaptPayloadLexical({
      document: linkedDocument,
      locale: 'EN',
    })
    expect(canonicalBaseRequest.graph.edition.locale).toBe('en')
    expect(canonicalBaseRequest.diagnostics).toEqual([])
    expect(() =>
      adaptPayloadLexicalEditions({
        ...linkedDocument,
        localeVariants: [
          {
            locale: 'fr',
            title: 'Édition française',
            content: {
              root: {
                children: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Un' }],
                  },
                ],
              },
            },
          },
          {
            locale: 'FR',
            title: 'Édition française bis',
            content: {
              root: {
                children: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Deux' }],
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow(/duplicate Payload locale variant fr/)
    expect(() =>
      adaptPayloadLexicalEditions({
        ...linkedDocument,
        localeVariants: ['invalid'],
      }),
    ).toThrow(/Payload locale variant.*must be an object/)
    expect(
      adaptPayloadLexicalEditions({
        ...linkedDocument,
        localeVariants: [
          {
            code: 'fr',
            title: 'Édition française codée',
            content: {
              root: {
                children: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Français codé' }],
                  },
                ],
              },
            },
          },
        ],
      }).map((edition) => edition.graph.edition.locale),
    ).toEqual(['en', 'fr'])
    const fallback = adaptPayloadLexical({
      document: publication,
      mapping: { ...mapping, fallbackLocale: 'en' },
      locale: 'de',
    })
    expect(fallback.graph.edition.locale).toBe('en')
    expect(fallback.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'locale-fallback' })]))
    expect(fallback.graph.nodes[0].provenance.evidence).toContain('locale-fallback:de->en')
  })

  it('keeps authored base locale separate from requested mapping locale', () => {
    const localized = {
      metadata: { locale: 'en' },
      id: 'requested-locale',
      title: 'English title',
      richText: {
        root: {
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'text', text: 'English body' }],
            },
          ],
        },
      },
      translations: {
        items: [
          {
            metadata: { locale: 'fr' },
            title: 'Titre français',
            richText: {
              root: {
                children: [
                  {
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Corps français' }],
                  },
                ],
              },
            },
          },
        ],
      },
    }
    const localizedMapping = {
      fields: {
        locale: 'metadata.locale',
        content: 'richText',
        locales: 'translations.items',
      },
      locale: 'fr',
      fallbackLocale: 'en',
    }

    const requested = adaptPayloadLexical(localized, localizedMapping)
    expect(requested.graph.edition.locale).toBe('fr')
    expect(requested.graph.metadata.title).toBe('Titre français')
    expect(requested.graph.nodes[0]).toMatchObject({
      locale: 'fr',
      type: 'paragraph',
      text: 'Corps français',
    })
    expect(
      adaptPayloadLexicalEditions(localized, localizedMapping).map(
        (edition) => edition.graph.edition.locale,
      ),
    ).toEqual(['en', 'fr'])

    const fallback = adaptPayloadLexical({
      document: localized,
      mapping: localizedMapping,
      locale: 'de',
    })
    expect(fallback.graph.edition.locale).toBe('en')
    expect(fallback.graph.nodes[0]).toMatchObject({
      locale: 'en',
      type: 'paragraph',
      text: 'English body',
    })
    expect(fallback.graph.nodes[0].provenance.evidence).toContain(
      'locale-fallback:de->en',
    )
  })
})
