import { describe, expect, it } from 'vitest'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import rawLettersPaper from '../research/papers/if-letters-home-could-sing.json'
import { researchPaperSchema } from '../research/schema'
import {
  publicationGraphToResearchPaper,
  researchPaperToPublicationGraph,
} from './research-paper-adapter'
import { serializePublicationGraph } from './schema'

describe('ResearchPaper compatibility adapter', () => {
  it.each([rawPaper, rawLettersPaper])(
    'round-trips golden paper $id without changing canonical meaning',
    (raw) => {
      const paper = researchPaperSchema.parse(raw)
      const graph = researchPaperToPublicationGraph(paper)
      expect(publicationGraphToResearchPaper(graph)).toEqual(paper)
      expect(graph.nodes.map((node) => node.id)).toEqual(
        paper.nodes.map((node) => node.id),
      )
      expect(serializePublicationGraph(graph)).toBe(
        serializePublicationGraph(researchPaperToPublicationGraph(paper)),
      )
    },
  )

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
