import { describe, expect, it } from 'vitest'
import {
  createSemanticTextAnchor,
  textAnnotationSchema,
} from '../research/annotations'
import { papers } from '../research/papers'
import {
  annotationBundleMatchesGraph,
  annotationBundleSchema,
  ANNOTATION_BUNDLE_VERSION,
  createAnnotationBundle,
  parseAnnotationBundle,
  resolveAnnotationBundle,
  resolveGraphTextAnchor,
  serializeAnnotationBundle,
} from './annotation-bundle'
import { researchPaperToPublicationGraph } from './research-paper-adapter'
import { UnsupportedPublicationVersionError } from './schema'

const QUOTE =
  'Once meaning becomes coordinates, every new screen or sheet becomes a repair job.'

function fixture() {
  const { graph } = researchPaperToPublicationGraph(papers[1])
  const node = graph.nodes.find((candidate) => candidate.id === 'p-proposition-1')
  if (!node || !('text' in node)) {
    throw new Error('The golden paper must contain the anchored paragraph')
  }
  const target = createSemanticTextAnchor(node.id, node.text, QUOTE)
  const bundle = createAnnotationBundle({
    graph,
    anchors: [{ id: 'reading-position', kind: 'reading-position', target }],
    annotations: [
      textAnnotationSchema.parse({
        id: 'highlight-1',
        kind: 'highlight',
        target,
        appearance: { color: 'amber' },
        geometryCache: [],
      }),
      textAnnotationSchema.parse({
        id: 'note-1',
        kind: 'note',
        target,
        body: 'Geometry may change; this note stays on the sentence.',
        geometryCache: [],
      }),
    ],
  })
  return { graph, bundle, target }
}

describe('annotation bundle', () => {
  it('travels beside the graph as its own versioned contract', () => {
    const { graph, bundle } = fixture()

    expect(bundle.version).toBe(ANNOTATION_BUNDLE_VERSION)
    expect(bundle.graphId).toBe(graph.metadata.id)
    expect(bundle.graphVersion).toBe(graph.metadata.version)
    expect(annotationBundleMatchesGraph(bundle, graph)).toBe(true)
    expect(annotationBundleMatchesGraph(bundle, {
      ...graph,
      metadata: { ...graph.metadata, version: '9.9.9' },
    })).toBe(false)

    // The graph itself never gains annotation fields.
    for (const node of graph.nodes) {
      expect(Object.keys(node)).not.toContain('annotations')
      expect(Object.keys(node)).not.toContain('anchors')
    }
  })

  it('round trips deterministically', () => {
    const { bundle } = fixture()
    const serialized = serializeAnnotationBundle(bundle)

    expect(parseAnnotationBundle(JSON.parse(serialized))).toEqual(bundle)
    expect(
      serializeAnnotationBundle(parseAnnotationBundle(JSON.parse(serialized))),
    ).toBe(serialized)
    expect(serializeAnnotationBundle(fixture().bundle)).toBe(serialized)
  })

  it('resolves anchors against graph text through the existing resolver', () => {
    const { graph, bundle } = fixture()
    const resolutions = resolveAnnotationBundle(bundle, graph)

    expect(resolutions.map((entry) => entry.id)).toEqual([
      'reading-position',
      'highlight-1',
      'note-1',
    ])
    for (const entry of resolutions) {
      expect(entry.resolution.status).toBe('resolved')
    }
  })

  it('reports missing and non-text targets instead of guessing', () => {
    const { graph, target } = fixture()

    expect(
      resolveGraphTextAnchor({ ...target, nodeId: 'not-a-node' }, graph),
    ).toMatchObject({ status: 'unresolved', reason: 'missing-node' })
    expect(
      resolveGraphTextAnchor({ ...target, nodeId: 'fig-pipeline' }, graph),
    ).toMatchObject({ status: 'unresolved', reason: 'non-text-node' })

    const edited = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === 'p-proposition-1' && 'text' in node
          ? { ...node, text: 'Something else entirely.' }
          : node,
      ),
    }
    expect(resolveGraphTextAnchor(target, edited)).toMatchObject({
      status: 'unresolved',
      reason: 'quote-not-found',
    })
  })

  it('rejects unknown versions, extra fields, and duplicate ids', () => {
    const { bundle } = fixture()

    expect(() => parseAnnotationBundle({ ...bundle, version: '2.0.0' })).toThrow(
      UnsupportedPublicationVersionError,
    )
    expect(() =>
      annotationBundleSchema.parse({ ...bundle, graph: {} }),
    ).toThrow()
    expect(() =>
      annotationBundleSchema.parse({
        ...bundle,
        anchors: [bundle.anchors[0], bundle.anchors[0]],
      }),
    ).toThrow(/Duplicate anchor id/)
    expect(() =>
      annotationBundleSchema.parse({
        ...bundle,
        annotations: [bundle.annotations[0], bundle.annotations[0]],
      }),
    ).toThrow(/Duplicate annotation id/)
  })
})
