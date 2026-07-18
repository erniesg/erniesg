import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import { canonicalContentHash } from './canonical-hash'
import { researchPaperSchema } from './schema'

type RawFigureNode = (typeof rawPaper.nodes)[number] & {
  type: 'figure'
  relationships: { caption: string }
}

type RawHeadingNode = (typeof rawPaper.nodes)[number] & {
  type: 'heading'
  level: number
}

function clonePaper() {
  return structuredClone(rawPaper)
}

describe('SRT canonical graph schema', () => {
  it('validates the golden paper fixture and freezes stable node ids', () => {
    const paper = researchPaperSchema.parse(rawPaper)

    expect(paper.nodes.map((node) => node.id)).toEqual([
      'sec-proposition',
      'p-proposition-1',
      'q-core',
      'sec-model',
      'p-model-1',
      'fig-pipeline',
      'cap-pipeline',
      'sec-gap',
      'p-gap-1',
      'sec-method',
      'p-method-1',
    ])
    expect(canonicalContentHash(paper)).toBe(
      'eb39feffbb23855457fdb5bba9021898aec721a3c308b8aae756c32df2f1d16e',
    )
  })

  it('requires every relationship target to exist', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const ids = new Set(paper.nodes.map((node) => node.id))

    for (const node of paper.nodes) {
      if (node.type === 'figure') {
        expect(ids.has(node.relationships.caption)).toBe(true)
      }
    }
  })

  it('rejects duplicate node ids', () => {
    const paper = clonePaper()
    paper.nodes[1].id = paper.nodes[0].id

    expect(researchPaperSchema.safeParse(paper).success).toBe(false)
  })

  it('rejects dangling relationships', () => {
    const paper = clonePaper()
    const figure = paper.nodes.find(
      (node): node is RawFigureNode => node.type === 'figure',
    )
    if (!figure) throw new Error('Fixture lost its figure node')

    figure.relationships.caption = 'missing-caption'

    expect(researchPaperSchema.safeParse(paper).success).toBe(false)
  })

  it('validates note targets, stable reference ids, and backlinks', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const withNote = {
      ...paper,
      nodes: [
        {
          id: 'p-note-source',
          type: 'paragraph' as const,
          text: 'A claim1',
          noteReferences: [
            {
              id: 'noteref-1',
              label: '1',
              target: 'fn-1',
              start: 7,
              end: 8,
              confidence: 0.95,
            },
          ],
          source: 'test',
        },
        {
          id: 'fn-1',
          type: 'footnote' as const,
          kind: 'footnote' as const,
          label: '1',
          text: 'A linked note.',
          relationships: { backlinks: ['noteref-1'] },
          source: 'test',
        },
      ],
    }

    expect(researchPaperSchema.safeParse(withNote).success).toBe(true)
    expect(
      researchPaperSchema.safeParse({
        ...withNote,
        nodes: [
          {
            ...withNote.nodes[0],
            noteReferences: [
              { ...withNote.nodes[0].noteReferences![0], target: 'missing' },
            ],
          },
          withNote.nodes[1],
        ],
      }).success,
    ).toBe(false)
  })

  it('rejects invalid heading levels', () => {
    const paper = clonePaper()
    const heading = paper.nodes.find(
      (node): node is RawHeadingNode => node.type === 'heading',
    )
    if (!heading) throw new Error('Fixture lost its heading node')

    heading.level = 0

    expect(researchPaperSchema.safeParse(paper).success).toBe(false)
  })

  it('rejects target coordinates in canonical content', () => {
    const paper = clonePaper()

    expect(
      researchPaperSchema.safeParse({
        ...paper,
        targetGeometry: { width: 390 },
      }).success,
    ).toBe(false)
    expect(
      researchPaperSchema.safeParse({
        ...paper,
        nodes: [{ ...paper.nodes[0], x: 10, y: 20 }, ...paper.nodes.slice(1)],
      }).success,
    ).toBe(false)
  })

  it('computes a deterministic hash that ignores rendition geometry', () => {
    const paper = researchPaperSchema.parse(rawPaper)

    expect(
      canonicalContentHash({
        ...paper,
        targetGeometry: { width: 390, height: 720 },
        nodes: [{ ...paper.nodes[0], x: 12, y: 24 }, ...paper.nodes.slice(1)],
      }),
    ).toBe(canonicalContentHash(paper))
  })
})
