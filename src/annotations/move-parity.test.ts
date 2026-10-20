import { describe, expect, it } from 'vitest'
import { structId } from '@erniesg/struct/identity'
import * as legacyAnnotations from '../research/annotations'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import { researchPaperSchema } from '../research/schema'
import {
  ANNOTATION_BUNDLE_VERSION,
  annotationBundleSchema,
  createAnnotationBundle,
  serializeAnnotationBundle,
  type AnnotationAnchorSource,
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

const proposition = paper.nodes.find(
  (candidate) => candidate.id === 'p-proposition-1',
)
if (!proposition || proposition.type !== 'paragraph') {
  throw new Error('Annotation fixture lost p-proposition-1')
}

/**
 * The Struct block id of the same paragraph.
 *
 * The Struct document is the anchor authority now, so the fixture addresses
 * its block by the Struct id. The id is minted by the package's own identity
 * function — the primitive the app's Struct ingress uses — so it is a Struct
 * block id and not a graph node id.
 */
const STRUCT_BLOCK_ID = structId(
  'block',
  `move-parity:paragraph:p-proposition-1:${proposition.text}`,
)

/**
 * The Struct-derived anchor source for the fixture document. Its source id is
 * the document's own id, the same value the app's Struct ingress records as
 * the Struct document id.
 */
const structSource: AnnotationAnchorSource = {
  id: paper.id,
  nodes: [{ id: STRUCT_BLOCK_ID, type: 'paragraph', text: proposition.text }],
}

/** The same anchor, addressed by the Struct block id instead of the paper id. */
const STRUCT_FIXTURE_ANCHOR = { ...FIXTURE_ANCHOR, nodeId: STRUCT_BLOCK_ID }

/** The demo annotations, addressed by the Struct block id. */
function structAddressedDemoAnnotations() {
  return createDemoAnnotations(paper).map((annotation) => ({
    ...annotation,
    target: { ...annotation.target, nodeId: STRUCT_BLOCK_ID },
  }))
}

/** The bundle those annotations produce against the Struct source. */
function structAnchoredBundle() {
  return createAnnotationBundle(
    structSource,
    structAddressedDemoAnnotations(),
  )
}

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

  it('moves the same anchor onto the Struct block id', () => {
    const anchor = createSemanticTextAnchor(
      STRUCT_BLOCK_ID,
      proposition.text,
      FIXTURE_QUOTE,
    )

    expect(anchor).toEqual(STRUCT_FIXTURE_ANCHOR)
    expect(semanticTextAnchorSchema.parse(anchor)).toEqual(
      STRUCT_FIXTURE_ANCHOR,
    )
    expect(anchor.position).toEqual(FIXTURE_ANCHOR.position)
    expect(anchor.quote).toEqual(FIXTURE_ANCHOR.quote)
  })

  it('bundles those annotations at the current bundle version', () => {
    const bundle = structAnchoredBundle()

    expect(ANNOTATION_BUNDLE_VERSION).toBe('1.2.0')
    expect(bundle.version).toBe('1.2.0')
    expect(bundle.anchors).toEqual([
      { id: 'highlight-reading-position:target', anchor: STRUCT_FIXTURE_ANCHOR },
      { id: 'note-reading-position:target', anchor: STRUCT_FIXTURE_ANCHOR },
    ])
    expect(
      annotationBundleSchema.parse(
        JSON.parse(serializeAnnotationBundle(bundle)),
      ),
    ).toEqual(bundle)
  })

  it('binds those annotations to the Struct source id', () => {
    const bundle = structAnchoredBundle()

    expect(bundle.sourceId).toBe(paper.id)
  })

  it('never carries a graph id', () => {
    const bundle = structAnchoredBundle()

    expect(bundle.graphId).toBeUndefined()
    expect(bundle).not.toHaveProperty('graphId')
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
