import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import rawLettersPaper from '../research/papers/if-letters-home-could-sing.json'
import { researchPaperSchema, type ResearchNode } from '../research/schema'
import { createDefaultPublicationAdapterRegistry } from './adapter-registry'
import * as researchPaperAdapter from './research-paper-adapter'
import {
  RESEARCH_PAPER_ADAPTER_ID,
  adaptResearchPaper,
  researchPaperToPublicationGraph,
} from './research-paper-adapter'
import { serializePublicationGraph, type PublicationNode } from './schema'
import { legacyResearchPaperSourceBinding } from './source-binding'

const adapterModulePath = fileURLToPath(
  new URL('./research-paper-adapter.ts', import.meta.url),
)

/**
 * The text a research node carries. A figure carries a source transcript
 * instead of a body text, so it is read from `sourceText` on both sides of the
 * projection.
 */
function researchNodeText(node: ResearchNode): string | undefined {
  if (node.type === 'figure') return node.sourceText
  return node.text
}

/**
 * The text a projected publication node carries, read the same way as the
 * research node it was projected from.
 */
function publicationNodeText(node: PublicationNode): string | undefined {
  if (node.type === 'figure') return node.sourceText
  if (
    node.type === 'heading' ||
    node.type === 'paragraph' ||
    node.type === 'quote' ||
    node.type === 'caption' ||
    node.type === 'note'
  ) {
    return node.text
  }
  return undefined
}

describe('ResearchPaper compatibility adapter', () => {
  it('exports no reverse writer that could author ResearchPaper text or semantic ids', () => {
    const exportNames = Object.keys(researchPaperAdapter)
    expect(exportNames).not.toContain('publicationGraphToResearchPaper')
    expect(
      exportNames.filter((name) => /graphToResearchPaper/i.test(name)),
    ).toEqual([])
    expect(readFileSync(adapterModulePath, 'utf8')).not.toMatch(
      /publicationGraphToResearchPaper/,
    )
  })

  it.each([rawPaper, rawLettersPaper])(
    'projects golden paper $id forward without changing its text or semantic ids',
    (raw) => {
      const paper = researchPaperSchema.parse(raw)
      const graph = researchPaperToPublicationGraph(paper)
      expect(graph.nodes.map((node) => node.id)).toEqual(
        paper.nodes.map((node) => node.id),
      )
      expect(graph.nodes.map(publicationNodeText)).toEqual(
        paper.nodes.map(researchNodeText),
      )
    },
  )

  it.each([rawPaper, rawLettersPaper])(
    'serializes the projected graph of golden paper $id deterministically',
    (raw) => {
      const paper = researchPaperSchema.parse(raw)
      const graph = researchPaperToPublicationGraph(paper)
      expect(serializePublicationGraph(graph)).toBe(
        serializePublicationGraph(researchPaperToPublicationGraph(paper)),
      )
    },
  )

  it('binds the legacy ResearchPaper source to the legacy variant with no Struct fields', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const result = adaptResearchPaper(paper)
    expect(result.sourceBinding).toEqual(legacyResearchPaperSourceBinding())
    expect(Object.keys(result.sourceBinding ?? {})).toEqual(['kind'])
    expect(result.sourceBinding).not.toHaveProperty('documentSha256')
    expect(result.sourceBinding).not.toHaveProperty('packageSourceCommit')
  })

  it('stays unregistered in the default publication adapter registry', async () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const registry = createDefaultPublicationAdapterRegistry()
    await expect(
      registry.resolve(RESEARCH_PAPER_ADAPTER_ID, paper),
    ).rejects.toThrow(/Unknown publication source adapter: research-paper/)
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

    const paragraph = paper.nodes.find((node) => node.type === 'paragraph')!
    expect(() =>
      researchPaperToPublicationGraph({
        ...paper,
        nodes: paper.nodes.map((node) =>
          node.id === paragraph.id
            ? {
                ...node,
                inlineRuns: [
                  {
                    start: 0,
                    end: 1,
                    relationshipId: 'ambiguous-note',
                    semanticRole: 'note-reference' as const,
                  },
                ],
              }
            : node,
        ),
      }),
    ).toThrow(/unsupported embedded note references/)
  })
})
