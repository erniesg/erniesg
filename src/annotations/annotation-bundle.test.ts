import { describe, expect, it } from 'vitest'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import { createDemoAnnotations, textAnnotationSchema } from './annotations'
import { researchPaperSchema } from '../research/schema'
import {
  annotationBundleSchema,
  createAnnotationBundle,
  serializeAnnotationBundle,
} from './annotation-bundle'
import { researchPaperToPublicationGraph } from '../publication/research-paper-adapter'

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

  it('reads legacy highlights and notes but requires the new version for proposals and codepoint anchors', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const graph = researchPaperToPublicationGraph(paper)
    const annotations = createDemoAnnotations(paper)
    const current = createAnnotationBundle(graph, annotations)
    expect(
      annotationBundleSchema.safeParse({ ...current, version: '1.0.0' })
        .success,
    ).toBe(true)
    const proposal = textAnnotationSchema.parse({
      id: 'proposal',
      kind: 'proposal',
      target: annotations[0].target,
      body: 'replacement',
      geometryCache: [],
    })
    const withProposal = createAnnotationBundle(graph, [proposal])
    expect(
      annotationBundleSchema.safeParse({ ...withProposal, version: '1.0.0' })
        .success,
    ).toBe(false)
    const withCodepoint = {
      ...current,
      anchors: current.anchors.map((entry) => ({
        ...entry,
        anchor: { ...entry.anchor, positionUnit: 'codepoint' },
      })),
    }
    expect(
      annotationBundleSchema.safeParse({ ...withCodepoint, version: '1.0.0' })
        .success,
    ).toBe(false)
  })

  it('validates document-scoped codepoint positions against complete graph text', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const graph = researchPaperToPublicationGraph(paper)
    const node = graph.nodes.find((candidate) => candidate.type === 'paragraph')
    if (!node || node.type !== 'paragraph')
      throw new Error('Missing paragraph fixture')
    const changed = {
      ...graph,
      nodes: graph.nodes.map((candidate) =>
        candidate.id === node.id
          ? { ...node, text: `🌊 ${node.text}` }
          : candidate,
      ),
    }
    const fullText = changed.nodes
      .map((candidate) => ('text' in candidate ? candidate.text : ''))
      .join('')
    const needle = node.text.slice(0, 5)
    const start = fullText.indexOf(needle)
    const target = {
      nodeId: '@document',
      positionUnit: 'codepoint' as const,
      position: {
        start: [...fullText.slice(0, start)].length,
        end: [...fullText.slice(0, start + needle.length)].length,
      },
      quote: { exact: needle, prefix: '', suffix: '' },
    }
    const annotation = textAnnotationSchema.parse({
      id: 'document-proposal',
      kind: 'proposal',
      target,
      body: 'replacement',
      geometryCache: [],
    })
    expect(createAnnotationBundle(changed, [annotation]).annotations).toEqual([
      annotation,
    ])
    expect(() =>
      createAnnotationBundle(changed, [
        {
          ...annotation,
          target: {
            ...target,
            position: {
              start: target.position.start + 1,
              end: target.position.end + 1,
            },
          },
        },
      ]),
    ).toThrow(/does not match/)
  })
})
