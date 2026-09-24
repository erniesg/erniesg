import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import { buildEpub, renderPublicationXhtml } from './epub'
import { researchPaperSchema } from './schema'

const paper = researchPaperSchema.parse(rawPaper)

function numericCitationTarget(id: string, ordinal: number | null) {
  return ordinal === null
    ? {
        id,
        type: 'paragraph' as const,
        text: 'Bibliography entry without a recoverable numeric marker.',
        source: 'synthetic-semantic-alignment',
      }
    : {
        id,
        type: 'paragraph' as const,
        text: `Reference ${ordinal}.`,
        list: {
          level: 1,
          ordered: true,
          numberingId: 'references',
          markerStyle: 'decimal' as const,
          ordinal,
          markerText: `[${ordinal}]`,
        },
        source: 'synthetic-semantic-alignment',
      }
}

function numericCitationPaper({
  surface,
  targetIds,
  targets,
}: {
  surface: string
  targetIds: string[]
  targets: Array<[id: string, ordinal: number | null]>
}) {
  const candidate = structuredClone(paper)
  candidate.nodes = [
    {
      id: 'semantic-alignment-claim',
      type: 'paragraph',
      text: surface,
      inlineRuns: [
        {
          start: 0,
          end: surface.length,
          relationshipId: 'semantic-alignment-citation',
          semanticRole: 'citation',
          targetIds,
        },
      ],
      source: 'synthetic-semantic-alignment',
    },
    ...targets.map(([id, ordinal]) => numericCitationTarget(id, ordinal)),
  ]
  return candidate
}

function equationRangePaper({
  surface,
  targetIds,
  identifiers,
}: {
  surface: string
  targetIds: string[]
  identifiers: Array<[id: string, identifier: string | null]>
}) {
  const candidate = structuredClone(paper)
  candidate.nodes = [
    {
      id: 'semantic-equation-claim',
      type: 'paragraph',
      text: surface,
      inlineRuns: [
        {
          start: 0,
          end: surface.length,
          relationshipId: 'semantic-equation-range',
          semanticRole: 'cross-reference',
          targetIds,
        },
      ],
      source: 'synthetic-semantic-alignment',
    },
    ...identifiers.flatMap(([id, identifier]) => [
      {
        id,
        type: 'figure' as const,
        objectType: 'equation' as const,
        title: identifier ? `Equation ${identifier}` : 'Source equation',
        relationships: { caption: `${id}-caption` },
        source: 'synthetic-semantic-alignment',
      },
      {
        id: `${id}-caption`,
        type: 'caption' as const,
        text: identifier
          ? `Equation ${identifier}. Source equation.`
          : 'Source equation without a recoverable identifier.',
        source: 'synthetic-semantic-alignment',
      },
    ]),
  ]
  return candidate
}

describe('EPUB 3 export', () => {
  it('links canonical citation spans to their bibliography targets', () => {
    const citationPaper = structuredClone(paper)
    citationPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [1].',
        inlineRuns: [
          {
            start: 11,
            end: 14,
            relationshipId: 'citation-1',
            semanticRole: 'citation',
            targetIds: ['reference-1'],
          },
        ],
        source: 'synthetic-citation-test',
      },
      {
        id: 'reference-1',
        type: 'paragraph',
        text: '[1] Reference entry.',
        list: { level: 1, ordered: true, numberingId: 'references' },
        source: 'synthetic-citation-test',
      },
    ]

    const content = renderPublicationXhtml(citationPaper)

    expect(content).toContain(
      '<a id="citation-1" href="#reference-1" epub:type="biblioref" role="doc-biblioref" data-semantic-role="citation" data-relationship-id="citation-1" data-target-ids="reference-1">[1]</a>',
    )
  })

  it('renders a citation range once without hidden canonical-text copies', () => {
    const citationPaper = structuredClone(paper)
    citationPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [1–3].',
        inlineRuns: [
          {
            start: 11,
            end: 16,
            relationshipId: 'citation-range',
            semanticRole: 'citation',
            targetIds: ['reference-1', 'reference-2', 'reference-3'],
          },
          { start: 12, end: 15, italic: true },
        ],
        source: 'synthetic-citation-range',
      },
      ...[1, 2, 3].map((ordinal) => ({
        id: `reference-${ordinal}`,
        type: 'paragraph' as const,
        text: `Reference ${ordinal}.`,
        list: {
          level: 1,
          ordered: true,
          numberingId: 'references',
          markerStyle: 'decimal' as const,
          ordinal,
          markerText: `[${ordinal}]`,
        },
        source: 'synthetic-citation-range',
      })),
    ]

    const content = renderPublicationXhtml(citationPaper)

    expect(content).toContain('href="#reference-1"')
    expect(content).toContain('href="#reference-2"')
    expect(content).toContain('href="#reference-3"')
    expect(content).toContain(
      'data-target-ids="reference-1 reference-2 reference-3"',
    )
    expect(content.match(/\sid="citation-range"/g)).toHaveLength(1)
    expect(content).toContain(
      '[<em><a href="#reference-1" epub:type="biblioref" role="doc-biblioref">1</a>–<a href="#reference-3" epub:type="biblioref" role="doc-biblioref">3</a></em>]',
    )
    expect(content.match(/>1<\/a>–<a[^>]*>3<\/a>/g)).toHaveLength(1)
    expect(content).toContain('class="additional-biblioref"')
  })

  it('maps mixed singleton and numeric-range citation labels without inventing visible text', () => {
    const citationPaper = structuredClone(paper)
    citationPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [16, 38–40].',
        inlineRuns: [
          {
            start: 11,
            end: 22,
            relationshipId: 'citation-mixed-range',
            semanticRole: 'citation',
            targetIds: [
              'reference-16',
              'reference-38',
              'reference-39',
              'reference-40',
            ],
          },
        ],
        source: 'synthetic-mixed-citation-range',
      },
      ...[16, 38, 39, 40].map((ordinal) => ({
        id: `reference-${ordinal}`,
        type: 'paragraph' as const,
        text: `Reference ${ordinal}.`,
        list: {
          level: 1,
          ordered: true,
          numberingId: 'references',
          markerStyle: 'decimal' as const,
          ordinal,
          markerText: `[${ordinal}]`,
        },
        source: 'synthetic-mixed-citation-range',
      })),
    ]

    const content = renderPublicationXhtml(citationPaper)

    expect(content).toContain('href="#reference-16"')
    expect(content).toContain('href="#reference-38"')
    expect(content).toContain('href="#reference-39"')
    expect(content).toContain('href="#reference-40"')
    expect(content).toContain(
      'data-target-ids="reference-16 reference-38 reference-39 reference-40"',
    )
    expect(content).toContain(
      '[<a href="#reference-16" epub:type="biblioref" role="doc-biblioref">16</a>, <a href="#reference-38" epub:type="biblioref" role="doc-biblioref">38</a>–<a href="#reference-40" epub:type="biblioref" role="doc-biblioref">40</a>]',
    )
    expect(content).toContain('class="additional-biblioref"')
  })

  it('fails closed when a mixed numeric citation range cannot account for every target', () => {
    const citationPaper = structuredClone(paper)
    citationPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [16, 38–40].',
        inlineRuns: [
          {
            start: 11,
            end: 22,
            relationshipId: 'citation-mixed-range-mismatch',
            semanticRole: 'citation',
            targetIds: [
              'reference-16',
              'reference-38',
              'reference-39',
              'reference-40',
              'reference-41',
            ],
          },
        ],
        source: 'synthetic-mixed-citation-range-mismatch',
      },
      ...[16, 38, 39, 40, 41].map((ordinal) => ({
        id: `reference-${ordinal}`,
        type: 'paragraph' as const,
        text: `Reference ${ordinal}.`,
        list: {
          level: 1,
          ordered: true,
          numberingId: 'references',
          markerStyle: 'decimal' as const,
          ordinal,
          markerText: `[${ordinal}]`,
        },
        source: 'synthetic-mixed-citation-range-mismatch',
      })),
    ]

    expect(() => renderPublicationXhtml(citationPaper)).toThrow(
      /EPUB_SEMANTIC_LINK_ALIGNMENT/u,
    )
  })

  it.each([
    {
      name: 'omits an implicit range member',
      surface: '[16, 38–40]',
      targetIds: ['reference-16', 'reference-38', 'reference-40'],
      targets: [
        ['reference-16', 16],
        ['reference-38', 38],
        ['reference-40', 40],
      ],
    },
    {
      name: 'reorders canonical targets',
      surface: '[16, 38–40]',
      targetIds: [
        'reference-16',
        'reference-39',
        'reference-38',
        'reference-40',
      ],
      targets: [
        ['reference-16', 16],
        ['reference-38', 38],
        ['reference-39', 39],
        ['reference-40', 40],
      ],
    },
    {
      name: 'duplicates a canonical target',
      surface: '[16, 38–40]',
      targetIds: [
        'reference-16',
        'reference-38',
        'reference-38',
        'reference-40',
      ],
      targets: [
        ['reference-16', 16],
        ['reference-38', 38],
        ['reference-40', 40],
      ],
    },
    {
      name: 'contains an unknown canonical target identity',
      surface: '[16, 38–40]',
      targetIds: [
        'reference-16',
        'reference-38',
        'reference-unknown',
        'reference-40',
      ],
      targets: [
        ['reference-16', 16],
        ['reference-38', 38],
        ['reference-unknown', null],
        ['reference-40', 40],
      ],
    },
    {
      name: 'uses whitespace instead of citation punctuation',
      surface: '[16 38–40]',
      targetIds: [
        'reference-16',
        'reference-38',
        'reference-39',
        'reference-40',
      ],
      targets: [
        ['reference-16', 16],
        ['reference-38', 38],
        ['reference-39', 39],
        ['reference-40', 40],
      ],
    },
    {
      name: 'absorbs prose between explicit identifiers',
      surface: '[16] prose [38]',
      targetIds: ['reference-16', 'reference-38'],
      targets: [
        ['reference-16', 16],
        ['reference-38', 38],
      ],
    },
  ] as const)(
    'fails closed when a citation surface $name',
    ({ surface, targetIds, targets }) => {
      expect(() =>
        renderPublicationXhtml(
          numericCitationPaper({
            surface,
            targetIds: [...targetIds],
            targets: targets.map(([id, ordinal]) => [id, ordinal]),
          }),
        ),
      ).toThrow(/EPUB_SEMANTIC_LINK_ALIGNMENT/u)
    },
  )

  it.each(['-', '–', '—'] as const)(
    'validates every compact dotted-equation target before linking %s endpoints',
    (connector) => {
      const surface = `Eqs. (4.17${connector}4.19)`
      const content = renderPublicationXhtml(
        equationRangePaper({
          surface,
          targetIds: ['equation-4.17', 'equation-4.18', 'equation-4.19'],
          identifiers: [
            ['equation-4.17', '4.17'],
            ['equation-4.18', '4.18'],
            ['equation-4.19', '4.19'],
          ],
        }),
      )

      expect(content).toContain('href="#equation-4.17"')
      expect(content).toContain('href="#equation-4.19"')
      expect(content).toContain(
        'href="#equation-4.18" class="additional-cross-reference"',
      )
      expect(content).toContain(
        'data-target-ids="equation-4.17 equation-4.18 equation-4.19"',
      )
      expect(content).toContain(
        `Eqs. (<a href="#equation-4.17">4.17</a>${connector}<a href="#equation-4.19">4.19</a>)`,
      )
    },
  )

  it.each(['−', '‑', '‒'] as const)(
    'fails closed on unsupported Unicode range connector %s',
    (connector) => {
      const surface = `Eqs. (4.17${connector}4.19)`
      expect(() =>
        renderPublicationXhtml(
          equationRangePaper({
            surface,
            targetIds: ['equation-4.17', 'equation-4.18', 'equation-4.19'],
            identifiers: [
              ['equation-4.17', '4.17'],
              ['equation-4.18', '4.18'],
              ['equation-4.19', '4.19'],
            ],
          }),
        ),
      ).toThrow(
        /DANGLING_EPUB_INTERNAL_REFERENCE|EPUB_SEMANTIC_LINK_ALIGNMENT/u,
      )
    },
  )

  it.each([
    {
      name: 'descends',
      surface: 'Eqs. (4.19-4.17)',
      targetIds: ['equation-4.17', 'equation-4.18', 'equation-4.19'],
      identifiers: [
        ['equation-4.17', '4.17'],
        ['equation-4.18', '4.18'],
        ['equation-4.19', '4.19'],
      ],
    },
    {
      name: 'omits an interior target',
      surface: 'Eqs. (4.17-4.19)',
      targetIds: ['equation-4.17', 'equation-4.19'],
      identifiers: [
        ['equation-4.17', '4.17'],
        ['equation-4.19', '4.19'],
      ],
    },
    {
      name: 'reorders targets',
      surface: 'Eqs. (4.17-4.19)',
      targetIds: ['equation-4.17', 'equation-4.19', 'equation-4.18'],
      identifiers: [
        ['equation-4.17', '4.17'],
        ['equation-4.18', '4.18'],
        ['equation-4.19', '4.19'],
      ],
    },
    {
      name: 'duplicates a target',
      surface: 'Eqs. (4.17-4.19)',
      targetIds: ['equation-4.17', 'equation-4.18', 'equation-4.18'],
      identifiers: [
        ['equation-4.17', '4.17'],
        ['equation-4.18', '4.18'],
      ],
    },
    {
      name: 'contains an unknown target identity',
      surface: 'Eqs. (4.17-4.19)',
      targetIds: ['equation-4.17', 'equation-unknown', 'equation-4.19'],
      identifiers: [
        ['equation-4.17', '4.17'],
        ['equation-unknown', null],
        ['equation-4.19', '4.19'],
      ],
    },
  ] as const)(
    'fails closed when a compact dotted equation range $name',
    ({ surface, targetIds, identifiers }) => {
      expect(() =>
        renderPublicationXhtml(
          equationRangePaper({
            surface,
            targetIds: [...targetIds],
            identifiers: identifiers.map(([id, identifier]) => [
              id,
              identifier,
            ]),
          }),
        ),
      ).toThrow(/EPUB_SEMANTIC_LINK_ALIGNMENT/u)
    },
  )

  it('links every explicit citation label exactly once to its matching target', () => {
    const citationPaper = structuredClone(paper)
    citationPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [62, 63, 48].',
        inlineRuns: [
          {
            start: 11,
            end: 23,
            relationshipId: 'citation-list',
            semanticRole: 'citation',
            targetIds: ['reference-62', 'reference-63', 'reference-48'],
          },
        ],
        source: 'synthetic-citation-list',
      },
      ...[62, 63, 48].map((ordinal) => ({
        id: `reference-${ordinal}`,
        type: 'paragraph' as const,
        text: `Reference ${ordinal}.`,
        list: {
          level: 1,
          ordered: true,
          numberingId: 'references',
          markerStyle: 'decimal' as const,
          ordinal,
          markerText: `[${ordinal}]`,
        },
        source: 'synthetic-citation-list',
      })),
    ]

    const content = renderPublicationXhtml(citationPaper)

    for (const ordinal of [62, 63, 48]) {
      expect(content).toContain(
        `<a href="#reference-${ordinal}" epub:type="biblioref" role="doc-biblioref">${ordinal}</a>`,
      )
      expect(content.match(new RegExp(`>${ordinal}<`, 'g'))).toHaveLength(1)
    }
    expect(content).not.toContain('additional-biblioref')
    expect(content).not.toContain(
      '<span class="visually-hidden">[62, 63, 48]</span>',
    )
  })

  it('renders resolved scholarly cross references as semantic internal links', () => {
    const crossReferencePaper = structuredClone(paper)
    crossReferencePaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Figures 4 and 5.',
        inlineRuns: [
          {
            start: 0,
            end: 15,
            relationshipId: 'cross-reference-figures-4-5',
            semanticRole: 'cross-reference',
            targetIds: ['figure-4', 'figure-5'],
          },
        ],
        source: 'synthetic-cross-reference',
      },
      ...[4, 5].map((ordinal) => ({
        id: `figure-${ordinal}`,
        type: 'figure' as const,
        title: `Figure ${ordinal}`,
        objectType: 'figure' as const,
        relationships: { caption: `caption-${ordinal}` },
        source: 'synthetic-cross-reference',
      })),
      ...[4, 5].map((ordinal) => ({
        id: `caption-${ordinal}`,
        type: 'caption' as const,
        text: `Figure ${ordinal}.`,
        source: 'synthetic-cross-reference',
      })),
    ]

    const content = renderPublicationXhtml(crossReferencePaper)

    expect(content).toContain('href="#figure-4"')
    expect(content).toContain('href="#figure-5"')
    expect(content.match(/\sid="cross-reference-figures-4-5"/gu)).toHaveLength(
      1,
    )
    expect(content).toContain('data-semantic-role="cross-reference"')
    expect(content).toContain(
      'data-relationship-id="cross-reference-figures-4-5"',
    )
  })

  it.each([
    {
      semanticRole: 'citation' as const,
      relationshipId: 'overlapping-citation',
      targetId: 'overlapping-reference-target',
    },
    {
      semanticRole: 'cross-reference' as const,
      relationshipId: 'overlapping-cross-reference',
      targetId: 'overlapping-section-target',
    },
  ])(
    'preserves an internal $semanticRole target when an external PDF link overlaps it',
    ({ semanticRole, relationshipId, targetId }) => {
      const overlapPaper = structuredClone(paper)
      const marker = semanticRole === 'citation' ? '[1]' : 'Section 2'
      const externalHref = 'https://example.test/source-annotation'
      overlapPaper.nodes = [
        {
          id: 'overlapping-link-claim',
          type: 'paragraph',
          text: marker,
          inlineRuns: [
            {
              start: 0,
              end: marker.length,
              href: externalHref,
            },
            {
              start: 0,
              end: marker.length,
              relationshipId,
              semanticRole,
              targetIds: [targetId],
            },
          ],
          source: 'synthetic-overlapping-pdf-link',
        },
        {
          id: targetId,
          type: 'paragraph',
          text: 'Canonical internal target.',
          source: 'synthetic-overlapping-pdf-link',
        },
      ]

      const content = renderPublicationXhtml(overlapPaper)

      expect(content).toContain(`href="#${targetId}"`)
      expect(content).toContain(`data-relationship-id="${relationshipId}"`)
      expect(content).not.toContain(externalHref)
    },
  )

  it('narrows a broad PDF destination run to the exact scholarly marker', () => {
    const linkedPaper = structuredClone(paper)
    linkedPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'The drift is given by (3). Basket claims follow.',
        inlineRuns: [
          {
            start: 13,
            end: 46,
            href: '#equation-3',
            annotationId: 'pdf-link-equation-3',
          },
        ],
        source: 'synthetic-broad-pdf-link',
      },
      {
        id: 'equation-3',
        type: 'figure',
        objectType: 'equation',
        title: 'Equation 3',
        relationships: { caption: 'equation-3-caption' },
        source: 'synthetic-broad-pdf-link',
      },
      {
        id: 'equation-3-caption',
        type: 'caption',
        text: 'Equation 3.',
        source: 'synthetic-broad-pdf-link',
      },
    ]

    const content = renderPublicationXhtml(linkedPaper)

    expect(content).toContain(
      'The drift is given by <a href="#equation-3" data-source-annotation-id="pdf-link-equation-3">(3)</a>. Basket claims follow.',
    )
    expect(content).not.toContain(
      '<a href="#equation-3">given by (3). Basket claims follow</a>',
    )
  })

  it('keeps a multi-character Roman scholarly label bounded when the PDF destination and semantic run coincide', async () => {
    const linkedPaper = structuredClone(paper)
    linkedPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'The filters are summarized in Table II.',
        inlineRuns: [
          {
            start: 30,
            end: 38,
            href: '#table-ii',
            annotationId: 'pdf-link-table-ii',
            relationshipId: 'cross-reference-table-ii',
            semanticRole: 'cross-reference',
            targetIds: ['table-ii'],
          },
        ],
        source: 'synthetic-roman-cross-reference',
      },
      {
        id: 'table-ii',
        type: 'figure',
        objectType: 'table',
        title: 'Table II',
        relationships: { caption: 'table-ii-caption' },
        source: 'synthetic-roman-cross-reference',
      },
      {
        id: 'table-ii-caption',
        type: 'caption',
        text: 'Table II. Phase filters.',
        source: 'synthetic-roman-cross-reference',
      },
    ]

    const content = renderPublicationXhtml(linkedPaper)

    expect(content).toContain(
      '<a id="cross-reference-table-ii" href="#table-ii" data-semantic-role="cross-reference" data-relationship-id="cross-reference-table-ii" data-target-ids="table-ii">Table II</a>',
    )
    expect(content).not.toContain(
      'data-relationship-id="cross-reference-table-ii">II</a>',
    )
    await expect(buildEpub(linkedPaper)).resolves.toMatchObject({
      mode: 'publication',
    })
  })

  it('narrows a broad caption annotation to its exact table label', () => {
    const linkedPaper = structuredClone(paper)
    const caption =
      'Table 6. Thus if e.g., a name already appears in the premise, it can be easily copied. After each name, more prose follows.'
    linkedPaper.nodes = [
      {
        id: 'annotated-caption',
        type: 'caption',
        text: caption,
        inlineRuns: [
          {
            start: 0,
            end: caption.indexOf('more prose'),
            href: '#table-6',
            annotationId: 'pdf-link-table-6',
          },
        ],
        source: 'synthetic-broad-caption-link',
      },
      {
        id: 'table-6',
        type: 'figure',
        objectType: 'table',
        title: 'Table 6',
        relationships: { caption: 'table-6-caption' },
        source: 'synthetic-broad-caption-link',
      },
      {
        id: 'table-6-caption',
        type: 'caption',
        text: 'Table 6. The canonical visual caption.',
        source: 'synthetic-broad-caption-link',
      },
    ]

    const content = renderPublicationXhtml(linkedPaper)

    expect(content).toContain(
      '<a href="#table-6" data-source-annotation-id="pdf-link-table-6">Table 6</a>. Thus if e.g.',
    )
    expect(content).not.toContain(
      '<a href="#table-6" data-source-annotation-id="pdf-link-table-6">Table 6. Thus',
    )
  })

  it('drops a coarse PDF destination when its scholarly kind conflicts with the visible marker', () => {
    const linkedPaper = structuredClone(paper)
    const claim = 'The prompt is shown in Table 22.'
    const semanticStart = claim.indexOf('Table 22')
    const annotationStart = claim.indexOf('shown')
    linkedPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: claim,
        inlineRuns: [
          {
            start: annotationStart,
            end: claim.length - 1,
            href: '#figure-22',
            annotationId: 'pdf-link-figure-22',
          },
          {
            start: semanticStart,
            end: semanticStart + 'Table 22'.length,
            relationshipId: 'unresolved-table-22-reference',
            semanticRole: 'cross-reference',
            targetIds: [],
          },
        ],
        source: 'synthetic-conflicting-pdf-link',
      },
      {
        id: 'figure-22',
        type: 'figure',
        objectType: 'figure',
        title: 'Figure 22',
        relationships: { caption: 'figure-22-caption' },
        source: 'synthetic-conflicting-pdf-link',
      },
      {
        id: 'figure-22-caption',
        type: 'caption',
        text: 'Figure 22. An unrelated visual destination.',
        source: 'synthetic-conflicting-pdf-link',
      },
    ]

    const content = renderPublicationXhtml(linkedPaper)

    expect(content).toContain(
      'shown in <span id="unresolved-table-22-reference" data-semantic-role="cross-reference" data-relationship-id="unresolved-table-22-reference">Table 22</span>.',
    )
    expect(content.match(/Table 22/gu)).toHaveLength(1)
    expect(content).not.toContain('href="#figure-22"')
    expect(content).not.toContain('pdf-link-figure-22')
  })

  it('keeps one semantic wrapper when a PDF destination resolves one label in an unresolved scholarly group', () => {
    const linkedPaper = structuredClone(paper)
    const claim = 'See Tables 54, 55, 56 for the generated stories.'
    const semanticStart = claim.indexOf('Tables 54')
    const annotationStart = claim.indexOf('54')
    linkedPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: claim,
        inlineRuns: [
          {
            start: annotationStart,
            end: claim.length,
            href: '#table-55',
            annotationId: 'pdf-link-table-55',
          },
          {
            start: semanticStart,
            end: semanticStart + 'Tables 54, 55, 56'.length,
            relationshipId: 'partially-resolved-table-group',
            semanticRole: 'cross-reference',
            targetIds: [],
          },
        ],
        source: 'synthetic-partially-resolved-cross-reference',
      },
      {
        id: 'table-55',
        type: 'figure',
        objectType: 'table',
        title: 'Table 55',
        relationships: { caption: 'table-55-caption' },
        source: 'synthetic-partially-resolved-cross-reference',
      },
      {
        id: 'table-55-caption',
        type: 'caption',
        text: 'Table 55. The matched member of a partially resolved group.',
        source: 'synthetic-partially-resolved-cross-reference',
      },
    ]

    const content = renderPublicationXhtml(linkedPaper)

    expect(content).toContain(
      '<span id="partially-resolved-table-group" data-semantic-role="cross-reference" data-relationship-id="partially-resolved-table-group">Tables 54, <a href="#table-55" data-source-annotation-id="pdf-link-table-55">55</a>, 56</span>',
    )
    expect(content.match(/Tables 54, /gu)).toHaveLength(1)
    expect(content.match(/href="#table-55"/gu)).toHaveLength(1)
  })
})
