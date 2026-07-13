import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import {
  getPaginationConstraints,
  NODE_PAGINATION_POLICIES,
  paginateResearchPaper,
} from './pagination'
import { researchPaperSchema, type ResearchPaper } from './schema'

const paper = researchPaperSchema.parse(rawPaper)

function paperWithLongParagraph(): ResearchPaper {
  return researchPaperSchema.parse({
    ...rawPaper,
    id: 'pagination-fragment-test',
    title: 'Pagination test',
    subtitle: 'Independent finite-height composition',
    abstract: 'A compact fixture for deterministic paragraph fragmentation.',
    nodes: [
      {
        id: 'sec-test',
        type: 'heading',
        level: 1,
        text: 'Fragmentation',
        source: 'test fixture',
      },
      {
        id: 'p-test',
        type: 'paragraph',
        text: Array.from(
          { length: 80 },
          (_, index) => `measured sentence ${index + 1}`,
        ).join(' '),
        source: 'test fixture',
      },
    ],
  })
}

describe('SRT finite-height pagination', () => {
  it('treats width and finite height as independent constraints', () => {
    const original = getPaginationConstraints(paper, 'paperPro')
    const narrow = getPaginationConstraints(paper, 'paperPro', {
      widthCssPx: original.widthCssPx - 120,
    })
    const short = getPaginationConstraints(paper, 'paperPro', {
      heightCssPx: (original.heightCssPx ?? 0) - 120,
    })

    expect(narrow.contentWidthCssPx).toBeLessThan(original.contentWidthCssPx)
    expect(narrow.contentHeightCssPx).toBe(original.contentHeightCssPx)
    expect(short.contentWidthCssPx).toBe(original.contentWidthCssPx)
    expect(short.contentHeightCssPx).toBeLessThan(
      original.contentHeightCssPx ?? 0,
    )

    const narrowLayout = paginateResearchPaper(paper, 'paperPro', {
      widthCssPx: narrow.widthCssPx,
    })
    const shortLayout = paginateResearchPaper(paper, 'paperPro', {
      heightCssPx: short.heightCssPx,
    })
    expect(narrowLayout.finalPageCount).toBeTypeOf('number')
    expect(shortLayout.finalPageCount).toBeTypeOf('number')
  })

  it('declares split and keep behavior for every supported node type', () => {
    expect(NODE_PAGINATION_POLICIES).toEqual({
      heading: { fragmentation: 'atomic', keep: 'with-next' },
      paragraph: {
        fragmentation: 'line',
        keep: 'none',
        minimumStartLines: 2,
        minimumEndLines: 2,
      },
      quote: { fragmentation: 'atomic', keep: 'none' },
      figure: { fragmentation: 'atomic', keep: 'with-related' },
      caption: { fragmentation: 'atomic', keep: 'with-previous' },
    })
  })

  it('fragments paragraphs at source ranges without losing prose', () => {
    const fixture = paperWithLongParagraph()
    const layout = paginateResearchPaper(fixture, 'paperProMove', {
      heightCssPx: 360,
    })
    const paragraph = layout.nodes.find((node) => node.canonicalId === 'p-test')
    const source = fixture.nodes.find((node) => node.id === 'p-test')
    if (!paragraph || source?.type !== 'paragraph') {
      throw new Error('Fragment fixture lost its paragraph')
    }

    expect(paragraph.fragments.length).toBeGreaterThan(1)
    expect(paragraph.fragments.map((fragment) => fragment.index)).toEqual(
      paragraph.fragments.map((_, index) => index),
    )
    expect(
      paragraph.fragments
        .map((fragment) => {
          const range = fragment.textRange
          if (!range) throw new Error('Paragraph fragment lacks a text range')
          return source.text.slice(range.start, range.end)
        })
        .join(''),
    ).toBe(source.text)
    expect(
      paragraph.fragments.every((fragment) => fragment.violations.length === 0),
    ).toBe(true)
  })

  it('keeps headings with following content and captions with atomic figures', () => {
    const layout = paginateResearchPaper(paper, 'paperProMove')
    const heading = layout.nodes.find(
      (node) => node.canonicalId === 'sec-model',
    )
    const following = layout.nodes.find(
      (node) => node.canonicalId === 'p-model-1',
    )
    const figure = layout.nodes.find(
      (node) => node.canonicalId === 'fig-pipeline',
    )
    const caption = layout.nodes.find(
      (node) => node.canonicalId === 'cap-pipeline',
    )

    expect(heading?.fragments).toHaveLength(1)
    expect(heading?.fragments[0]).toMatchObject({
      page: following?.fragments[0].page,
      region: following?.fragments[0].region,
      decision: { outcome: 'kept-with-next' },
    })
    expect(figure?.fragments).toHaveLength(1)
    expect(caption?.fragments).toHaveLength(1)
    expect(caption?.fragments[0]).toMatchObject({
      page: figure?.fragments[0].page,
      region: figure?.fragments[0].region,
      decision: { outcome: 'kept-with-related' },
    })
  })

  it('records an explicit fallback and violation for an impossible atomic object', () => {
    const fixture = researchPaperSchema.parse({
      ...paperWithLongParagraph(),
      id: 'pagination-atomic-test',
      nodes: [
        {
          id: 'q-test',
          type: 'quote',
          text: Array.from({ length: 120 }, () => 'atomic quotation').join(' '),
          source: 'test fixture',
        },
      ],
    })
    const layout = paginateResearchPaper(fixture, 'paperProMove', {
      heightCssPx: 240,
    })
    const quote = layout.nodes[0]

    expect(quote.fallback).toMatchObject({ code: 'scale-atomic-object' })
    expect(quote.fallback?.reason).toBeTruthy()
    expect(quote.violations).toEqual([
      expect.objectContaining({ code: 'atomic-object-too-tall' }),
    ])
    expect(layout.violations).toEqual(quote.violations)
  })

  it('reports current-region stability separately from final page count', () => {
    const layout = paginateResearchPaper(paper, 'print')

    expect(layout.pageCountStatus).toBe('final')
    expect(layout.finalPageCount).toBeGreaterThan(1)
    expect(layout.currentRegionStability).toMatchObject({
      metric: 'deterministic-fragment-prefix',
      stable: true,
    })
    expect(layout.currentRegionStability.comparedFragmentCount).toBeGreaterThan(
      0,
    )
    expect(layout.currentRegionStability.stableFragmentCount).toBe(
      layout.currentRegionStability.comparedFragmentCount,
    )
    expect(layout.currentRegionStability).not.toHaveProperty('pageCount')
  })
})
