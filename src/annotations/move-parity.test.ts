import { describe, expect, it } from 'vitest'
import { researchPaperToPublicationGraph } from '../publication/research-paper-adapter'
import * as legacyAnnotations from '../research/annotations'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import { researchPaperSchema } from '../research/schema'
import {
  ANNOTATION_BUNDLE_VERSION,
  annotationBundleSchema,
  createAnnotationBundle,
  serializeAnnotationBundle,
} from './annotation-bundle'
import * as movedAnnotations from './annotations'
import {
  createDemoAnnotations,
  createSemanticTextAnchor,
  semanticTextAnchorSchema,
  textAnnotationSchema,
} from './annotations'

// The anchor these literals describe is the one the pre-move module produced
// for `p-proposition-1`. They are derived from the fixture text rather than
// snapshotted from the moved code, so a silent behaviour change during the
// relocation cannot make this test agree with itself.
const FIXTURE_QUOTE =
  'Once meaning becomes coordinates, every new screen or sheet becomes a repair job.'
const FIXTURE_ANCHOR = {
  nodeId: 'p-proposition-1',
  position: { start: 54, end: 135 },
  quote: {
    exact: FIXTURE_QUOTE,
    prefix: 'flattened into pages too early. ',
    suffix: ' Semantic Responsive Typesetting',
  },
}

const paper = researchPaperSchema.parse(rawPaper)

describe('annotations module relocation', () => {
  it('parses the shipped research fixture into the pre-move anchor', () => {
    const node = paper.nodes.find(
      (candidate) => candidate.id === 'p-proposition-1',
    )
    if (!node || node.type !== 'paragraph') {
      throw new Error('Annotation fixture lost p-proposition-1')
    }

    const anchor = createSemanticTextAnchor(node.id, node.text, FIXTURE_QUOTE)

    expect(anchor).toEqual(FIXTURE_ANCHOR)
    expect(semanticTextAnchorSchema.parse(anchor)).toEqual(FIXTURE_ANCHOR)
    expect(node.text.slice(anchor.position.start, anchor.position.end)).toBe(
      FIXTURE_QUOTE,
    )
  })

  it('produces the pre-move demo annotations for that fixture', () => {
    expect(createDemoAnnotations(paper)).toEqual([
      {
        id: 'highlight-reading-position',
        kind: 'highlight',
        target: FIXTURE_ANCHOR,
        appearance: { color: 'amber' },
        geometryCache: [],
      },
      {
        id: 'note-reading-position',
        kind: 'note',
        target: FIXTURE_ANCHOR,
        body: 'Geometry may change; this note remains attached to the semantic sentence.',
        geometryCache: [],
      },
    ])
  })

  it('bundles those annotations at the unchanged bundle version', () => {
    const bundle = createAnnotationBundle(
      researchPaperToPublicationGraph(paper),
      createDemoAnnotations(paper),
    )

    expect(ANNOTATION_BUNDLE_VERSION).toBe('1.0.0')
    expect(bundle.version).toBe('1.0.0')
    expect(bundle.graphId).toBe('semantic-responsive-typesetting')
    expect(bundle.anchors).toEqual([
      { id: 'highlight-reading-position:target', anchor: FIXTURE_ANCHOR },
      { id: 'note-reading-position:target', anchor: FIXTURE_ANCHOR },
    ])
    expect(
      annotationBundleSchema.parse(
        JSON.parse(serializeAnnotationBundle(bundle)),
      ),
    ).toEqual(bundle)
  })

  it('still rejects the shapes the pre-move schemas rejected', () => {
    expect(() =>
      semanticTextAnchorSchema.parse({
        ...FIXTURE_ANCHOR,
        position: { start: 54, end: 136 },
      }),
    ).toThrow(/Text offsets must span the stored exact quote/)
    expect(() =>
      textAnnotationSchema.parse({
        id: 'unknown-kind',
        kind: 'freehand',
        target: FIXTURE_ANCHOR,
        geometryCache: [],
      }),
    ).toThrow()
  })

  it('keeps the legacy research path re-exporting the moved bindings', () => {
    const moved = movedAnnotations as Record<string, unknown>
    const legacy = legacyAnnotations as Record<string, unknown>
    const keys = Object.keys(moved).sort()

    expect(keys.length).toBeGreaterThan(0)
    expect(Object.keys(legacy).sort()).toEqual(keys)
    for (const key of keys) expect(legacy[key]).toBe(moved[key])
  })
})
