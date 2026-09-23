import { describe, expect, it } from 'vitest'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import { createDemoAnnotations, resolveTextAnchor } from './annotations'
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
})

it('validates code-point and document-scoped anchors', () => {
  const paper = researchPaperSchema.parse({
    ...rawPaper,
    id: 'emoji-bundle',
    nodes: [
      { id: 'p-1', type: 'paragraph', source: 'test', text: '🌊 target' },
    ],
  })
  const graph = researchPaperToPublicationGraph(paper)
  const codepoint = {
    id: 'codepoint',
    kind: 'note' as const,
    body: 'body',
    geometryCache: [],
    target: {
      nodeId: 'p-1',
      positionUnit: 'codepoint' as const,
      position: { start: 2, end: 8 },
      quote: { exact: 'target', prefix: '🌊 ', suffix: '' },
    },
  }
  const document = {
    ...codepoint,
    id: 'document',
    target: { ...codepoint.target, nodeId: '@document' },
  }
  expect(() =>
    createAnnotationBundle(graph, [codepoint, document]),
  ).not.toThrow()
})

it('resolves a document anchor at a later quote occurrence', () => {
  const paper = researchPaperSchema.parse({
    ...rawPaper,
    id: 'later-document-anchor',
    nodes: [
      {
        id: 'p-1',
        type: 'paragraph',
        source: 'test',
        text: 'first target then second target',
      },
    ],
  })
  const annotation = {
    id: 'later',
    kind: 'note' as const,
    body: 'body',
    geometryCache: [],
    target: {
      nodeId: '@document',
      positionUnit: 'codepoint' as const,
      position: { start: 24, end: 30 },
      quote: { exact: 'target', prefix: 'then second ', suffix: '' },
    },
  }
  expect(() =>
    createAnnotationBundle(researchPaperToPublicationGraph(paper), [
      annotation,
    ]),
  ).not.toThrow()
})

it('accepts a document position that disambiguates repeated quotes', () => {
  const paper = researchPaperSchema.parse({
    ...rawPaper,
    id: 'repeated-document-anchor',
    nodes: [{ id: 'p-1', type: 'paragraph', source: 'test', text: 'x x' }],
  })
  const annotation = {
    id: 'repeated',
    kind: 'note' as const,
    body: 'body',
    geometryCache: [],
    target: {
      nodeId: '@document',
      position: { start: 0, end: 1 },
      quote: { exact: 'x', prefix: '', suffix: '' },
    },
  }

  expect(() =>
    createAnnotationBundle(researchPaperToPublicationGraph(paper), [
      annotation,
    ]),
  ).not.toThrow()
})

it('accepts document context across graph-node boundaries', () => {
  const paper = researchPaperSchema.parse({
    ...rawPaper,
    id: 'bundle-cross-node-context-test',
    nodes: [
      { id: 'p-prefix', type: 'paragraph', source: 'test', text: 'a' },
      { id: 'p-target', type: 'paragraph', source: 'test', text: 'x' },
    ],
  })
  const annotation = {
    id: 'cross-node-context',
    kind: 'note' as const,
    body: 'body',
    geometryCache: [],
    target: {
      nodeId: '@document',
      position: { start: 1, end: 2 },
      quote: { exact: 'x', prefix: 'a', suffix: '' },
    },
  }

  expect(() =>
    createAnnotationBundle(researchPaperToPublicationGraph(paper), [
      annotation,
    ]),
  ).not.toThrow()
})

it('keeps document positions aligned with resolver text projection', () => {
  const figure = rawPaper.nodes.find((node) => node.type === 'figure')
  const caption = rawPaper.nodes.find(
    (node) => node.id === figure?.relationships.caption,
  )
  if (!figure || !caption) throw new Error('Annotation fixture lost its figure')

  const paper = researchPaperSchema.parse({
    ...rawPaper,
    id: 'figure-document-position-test',
    nodes: [
      { ...figure, sourceText: '🌊 ' },
      { id: 'p-target', type: 'paragraph', source: 'test', text: 'x x' },
      caption,
    ],
  })
  const target = {
    nodeId: '@document',
    positionUnit: 'codepoint' as const,
    position: { start: 2, end: 3 },
    quote: { exact: 'x', prefix: 'x ', suffix: '' },
  }
  const annotation = {
    id: 'figure-document-position',
    kind: 'note' as const,
    body: 'body',
    geometryCache: [],
    target,
  }

  expect(resolveTextAnchor(target, paper.nodes)).toEqual({
    status: 'resolved',
    nodeId: 'p-target',
    start: 2,
    end: 3,
    matchedBy: 'position-and-context',
  })
  expect(() =>
    createAnnotationBundle(researchPaperToPublicationGraph(paper), [
      annotation,
    ]),
  ).not.toThrow()
})
