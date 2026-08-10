import { describe, expect, it } from 'vitest'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import { researchPaperSchema } from '../research/schema'
import {
  publicationGraphToResearchPaper,
  researchPaperToPublicationGraph,
} from './research-paper-adapter'
import { serializePublicationGraph } from './schema'

describe('ResearchPaper compatibility adapter', () => {
  it('round-trips the golden supported subset without changing canonical meaning', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const graph = researchPaperToPublicationGraph(paper)
    expect(publicationGraphToResearchPaper(graph)).toEqual(paper)
    expect(graph.nodes.map((node) => node.id)).toEqual(
      paper.nodes.map((node) => node.id),
    )
    expect(serializePublicationGraph(graph)).toBe(
      serializePublicationGraph(researchPaperToPublicationGraph(paper)),
    )
  })

  it('keeps page geometry out and fails explicitly for unsupported extensions', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    expect(
      serializePublicationGraph(researchPaperToPublicationGraph(paper)),
    ).not.toMatch(/"page"|"x"|"y"/)
    expect(() =>
      researchPaperToPublicationGraph({
        ...paper,
        affiliations: ['Example University'],
      }),
    ).toThrow(/does not support/)
  })
})
