import { describe, expect, it } from 'vitest'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import { createDemoAnnotations } from './annotations'
import { researchPaperSchema } from '../research/schema'
import {
  annotationBundleSchema,
  createAnnotationBundle,
  serializeAnnotationBundle,
} from './annotation-bundle'
import { researchPaperToPublicationGraph } from '../publication/research-paper-adapter'

it('accepts codepoint and document-scoped anchors against ordered text', () => {
  const paper = researchPaperSchema.parse(rawPaper)
  const graph = researchPaperToPublicationGraph(paper)
  const first = graph.nodes.find(
    (node) =>
      'text' in node && node.text.includes('meaning becomes coordinates'),
  )
  if (!first || !('text' in first)) throw new Error('fixture text missing')
  const quote = 'meaning becomes coordinates'
  const position = [...first.text.slice(0, first.text.indexOf(quote))].length
  const target = {
    nodeId: first.id,
    positionUnit: 'codepoint' as const,
    position: { start: position, end: position + [...quote].length },
    quote: {
      exact: quote,
      prefix: first.text.slice(0, first.text.indexOf(quote)),
      suffix: '',
    },
  }
  const annotation = {
    id: 'wire',
    kind: 'proposal' as const,
    body: 'replacement',
    target,
    geometryCache: [],
  }
  expect(() => createAnnotationBundle(graph, [annotation])).not.toThrow()
  expect(() =>
    createAnnotationBundle(graph, [
      { ...annotation, target: { ...target, nodeId: '@document' } },
    ]),
  ).not.toThrow()
})

describe('AnnotationBundle', () => {
  it('round-trips typed annotations and semantic anchors beside the graph', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const annotations = createDemoAnnotations(paper)
    const bundle = createAnnotationBundle(
      researchPaperToPublicationGraph(paper),
      annotations,
    )
    expect(
      annotationBundleSchema.parse(
        JSON.parse(serializeAnnotationBundle(bundle)),
      ),
    ).toEqual(bundle)
    expect(bundle.annotations).toEqual(annotations)
    expect(serializeAnnotationBundle(bundle)).not.toContain('"graph":')
  })

  it('rejects anchors to missing graph nodes', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const annotations = createDemoAnnotations(paper)
    annotations[0].target.nodeId = 'missing'
    expect(() =>
      createAnnotationBundle(
        researchPaperToPublicationGraph(paper),
        annotations,
      ),
    ).toThrow(/missing/)
  })

  it('rejects stale anchor text even when the graph node still exists', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const annotations = createDemoAnnotations(paper)
    annotations[0].target.quote.exact = 'x'.repeat(
      annotations[0].target.quote.exact.length,
    )
    expect(() =>
      createAnnotationBundle(
        researchPaperToPublicationGraph(paper),
        annotations,
      ),
    ).toThrow(/does not match/)
  })
})
