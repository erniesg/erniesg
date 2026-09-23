import { describe, expect, it } from 'vitest'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import {
  cacheAnnotationGeometry,
  createDemoAnnotations,
  createLayoutVersion,
  createSemanticTextAnchor,
  FREEHAND_ATTACHMENT_POLICY,
  resolveTextAnchor,
  semanticTextAnchorSchema,
  textAnnotationSchema,
  type SemanticTextAnchor,
  type TextAnnotation,
} from './annotations'
import { COMPOSITION_POLICY_VERSION } from '../research/composition'
import { PAGINATION_POLICY_VERSION } from '../research/pagination'
import { researchPaperSchema, type ResearchPaper } from '../research/schema'
import {
  getPreviewMetrics,
  getTargetProfile,
  TARGET_PROFILE_IDS,
} from '../research/targets'

const paper = researchPaperSchema.parse(rawPaper)
const node = paper.nodes.find((candidate) => candidate.id === 'p-proposition-1')
if (!node || node.type !== 'paragraph') {
  throw new Error('Annotation fixture lost p-proposition-1')
}
const exact =
  'Once meaning becomes coordinates, every new screen or sheet becomes a repair job.'
const anchor = createSemanticTextAnchor(node.id, node.text, exact)

function createHighlight(target = anchor): TextAnnotation {
  return textAnnotationSchema.parse({
    id: 'highlight-reading-position',
    kind: 'highlight',
    target,
    appearance: { color: 'amber' },
    geometryCache: [],
  })
}

function paragraphFixture(text: string): ResearchPaper {
  return researchPaperSchema.parse({
    ...rawPaper,
    id: 'annotation-resolution-test',
    nodes: [
      {
        id: 'p-test',
        type: 'paragraph',
        text,
        source: 'test fixture',
      },
    ],
  })
}

describe('SRT semantic reading anchors and annotations', () => {
  it('creates deterministic demo annotation targets for export and studio use', () => {
    const first = createDemoAnnotations(paper)
    const second = createDemoAnnotations(paper)

    expect(first).toEqual(second)
    expect(first.map((annotation) => annotation.kind)).toEqual([
      'highlight',
      'note',
    ])
    for (const annotation of first) {
      expect(resolveTextAnchor(annotation.target, paper.nodes)).toMatchObject({
        status: 'resolved',
        nodeId: 'p-proposition-1',
      })
    }
  })

  it('stores a reading anchor as semantic text selectors without page geometry', () => {
    expect(anchor).toEqual({
      nodeId: 'p-proposition-1',
      position: {
        start: node.text.indexOf(exact),
        end: node.text.indexOf(exact) + exact.length,
      },
      quote: {
        exact,
        prefix: expect.any(String),
        suffix: expect.any(String),
      },
    })
    expect(anchor.quote.prefix).not.toBe('')
    expect(anchor.quote.suffix).not.toBe('')
    expect(anchor).not.toHaveProperty('page')
    expect(anchor).not.toHaveProperty('geometry')
    expect(semanticTextAnchorSchema.parse(anchor)).toEqual(anchor)
  })

  it('keeps exact quote, offsets, context, appearance, and versioned geometry cache', () => {
    const annotation = cacheAnnotationGeometry(createHighlight(), 'layout-v1', [
      { page: 2, x: 12, y: 24, width: 180, height: 20 },
    ])
    const nextLayout = cacheAnnotationGeometry(annotation, 'layout-v2', [
      { page: 3, x: 18, y: 30, width: 140, height: 40 },
    ])

    expect(nextLayout.target).toEqual(anchor)
    expect(nextLayout.geometryCache).toEqual([
      {
        layoutVersion: 'layout-v1',
        rectangles: [{ page: 2, x: 12, y: 24, width: 180, height: 20 }],
      },
      {
        layoutVersion: 'layout-v2',
        rectangles: [{ page: 3, x: 18, y: 30, width: 140, height: 40 }],
      },
    ])
  })

  it('re-resolves highlights and notes for all targets and layout changes', () => {
    const annotations = [
      createHighlight(),
      textAnnotationSchema.parse({
        id: 'note-reading-position',
        kind: 'note',
        target: anchor,
        body: 'The note remains attached to this semantic sentence.',
        geometryCache: [],
      }),
    ]
    const versions = TARGET_PROFILE_IDS.flatMap((target) => {
      const profile = getTargetProfile(target)
      const preview = getPreviewMetrics(profile)
      return [
        createLayoutVersion({
          documentId: paper.id,
          documentVersion: paper.version,
          target,
          widthCssPx: preview.widthCssPx,
          heightCssPx: preview.minHeightCssPx ?? null,
          fontScale: 1,
          compositionPolicyVersion: COMPOSITION_POLICY_VERSION,
          paginationPolicyVersion: PAGINATION_POLICY_VERSION,
        }),
        createLayoutVersion({
          documentId: paper.id,
          documentVersion: paper.version,
          target,
          widthCssPx: preview.widthCssPx * 0.86,
          heightCssPx: preview.minHeightCssPx ?? null,
          fontScale: 1.12,
          compositionPolicyVersion: COMPOSITION_POLICY_VERSION,
          paginationPolicyVersion: PAGINATION_POLICY_VERSION,
        }),
      ]
    })

    expect(new Set(versions)).toHaveLength(TARGET_PROFILE_IDS.length * 2)
    for (const annotation of annotations) {
      for (const layoutVersion of versions) {
        expect(resolveTextAnchor(annotation.target, paper.nodes)).toMatchObject(
          {
            status: 'resolved',
            nodeId: node.id,
            start: anchor.position.start,
            end: anchor.position.end,
          },
        )
        expect(layoutVersion).not.toContain('page=')
      }
    }
  })

  it('uses quote context after offsets drift', () => {
    const changed = researchPaperSchema.parse({
      ...rawPaper,
      nodes: paper.nodes.map((candidate) =>
        candidate.id === node.id && candidate.type === 'paragraph'
          ? { ...candidate, text: `Earlier material. ${candidate.text}` }
          : candidate,
      ),
    })

    expect(resolveTextAnchor(anchor, changed.nodes)).toMatchObject({
      status: 'resolved',
      matchedBy: 'quote-and-context',
      start: anchor.position.start + 'Earlier material. '.length,
    })
  })

  it('surfaces ambiguous and failed resolution without choosing a match', () => {
    const duplicatePaper = paragraphFixture('repeat gap repeat')
    const ambiguous: SemanticTextAnchor = semanticTextAnchorSchema.parse({
      nodeId: 'p-test',
      position: { start: 2, end: 8 },
      quote: { exact: 'repeat', prefix: 'missing', suffix: 'context' },
    })
    const missingQuote: SemanticTextAnchor = semanticTextAnchorSchema.parse({
      nodeId: 'p-test',
      position: { start: 0, end: 6 },
      quote: { exact: 'absent', prefix: '', suffix: '' },
    })

    expect(resolveTextAnchor(ambiguous, duplicatePaper.nodes)).toEqual({
      status: 'ambiguous',
      nodeId: 'p-test',
      reason:
        'Multiple exact quotes remain and the stored context does not identify one safely.',
      candidates: [
        { start: 0, end: 6, prefixMatches: false, suffixMatches: false },
        { start: 11, end: 17, prefixMatches: false, suffixMatches: false },
      ],
    })
    expect(resolveTextAnchor(missingQuote, duplicatePaper.nodes)).toEqual({
      status: 'unresolved',
      nodeId: 'p-test',
      reason: 'quote-not-found',
    })
    expect(
      resolveTextAnchor(
        { ...missingQuote, nodeId: 'missing' },
        duplicatePaper.nodes,
      ),
    ).toEqual({
      status: 'unresolved',
      nodeId: 'missing',
      reason: 'missing-node',
    })
    expect(() =>
      createSemanticTextAnchor('p-test', 'repeat gap repeat', 'repeat'),
    ).toThrow(/createSemanticTextAnchorFromRange/)
  })

  it('defers freehand attachment to explicit user choice', () => {
    expect(FREEHAND_ATTACHMENT_POLICY).toMatchObject({
      status: 'deferred',
      resolution: 'explicit-user-choice-required',
    })
  })
})

it('resolves a document-scoped anchor to its unique matching node', () => {
  const documentPaper = paragraphFixture('before 🌊 target after')
  const resolution = resolveTextAnchor(
    {
      nodeId: '@document',
      positionUnit: 'codepoint',
      position: { start: 7, end: 13 },
      quote: { exact: 'target', prefix: 'before 🌊 ', suffix: ' after' },
    },
    documentPaper.nodes,
  )
  expect(resolution).toMatchObject({
    status: 'resolved',
    nodeId: 'p-test',
    start: 10,
    end: 16,
  })
})

it('converts W3C code-point offsets while resolving a structural anchor', () => {
  const emojiPaper = paragraphFixture('🌊 x x')
  const resolution = resolveTextAnchor(
    {
      nodeId: 'p-test',
      positionUnit: 'codepoint',
      position: { start: 4, end: 5 },
      quote: { exact: 'x', prefix: '🌊 x ', suffix: '' },
    },
    emojiPaper.nodes,
  )
  expect(resolution).toMatchObject({
    status: 'resolved',
    start: 5,
    end: 6,
    matchedBy: 'position-and-context',
  })
})

it('uses document context when the same quote repeats in one node', () => {
  const documentPaper = paragraphFixture('first target then second target')
  const resolution = resolveTextAnchor(
    {
      nodeId: '@document',
      positionUnit: 'codepoint',
      position: { start: 24, end: 30 },
      quote: { exact: 'target', prefix: 'then second ', suffix: '' },
    },
    documentPaper.nodes,
  )
  expect(resolution).toMatchObject({
    status: 'resolved',
    nodeId: 'p-test',
    start: 25,
    end: 31,
  })
})
it('uses document-wide position to disambiguate a repeated quote', () => {
  const documentPaper = paragraphFixture('x x')
  const resolution = resolveTextAnchor(
    {
      nodeId: '@document',
      position: { start: 0, end: 1 },
      quote: { exact: 'x', prefix: '', suffix: '' },
    },
    documentPaper.nodes,
  )

  expect(resolution).toEqual({
    status: 'resolved',
    nodeId: 'p-test',
    start: 0,
    end: 1,
    matchedBy: 'position-and-context',
  })
})

it('uses quote context when a document-wide position becomes stale', () => {
  const documentPaper = paragraphFixture('drift before x after x')
  const resolution = resolveTextAnchor(
    {
      nodeId: '@document',
      position: { start: 7, end: 8 },
      quote: { exact: 'x', prefix: 'before ', suffix: ' after' },
    },
    documentPaper.nodes,
  )

  expect(resolution).toEqual({
    status: 'resolved',
    nodeId: 'p-test',
    start: 13,
    end: 14,
    matchedBy: 'quote-and-context',
  })
})
it('maps code-point document positions across graph nodes', () => {
  const documentPaper = researchPaperSchema.parse({
    ...rawPaper,
    id: 'annotation-document-position-test',
    nodes: [
      {
        id: 'p-prefix',
        type: 'paragraph',
        text: '🌊 ',
        source: 'test fixture',
      },
      {
        id: 'p-target',
        type: 'paragraph',
        text: 'x x',
        source: 'test fixture',
      },
    ],
  })

  expect(
    resolveTextAnchor(
      {
        nodeId: '@document',
        positionUnit: 'codepoint',
        position: { start: 2, end: 3 },
        quote: { exact: 'x', prefix: '', suffix: '' },
      },
      documentPaper.nodes,
    ),
  ).toEqual({
    status: 'resolved',
    nodeId: 'p-target',
    start: 0,
    end: 1,
    matchedBy: 'position-and-context',
  })
})

it('uses document context across graph-node boundaries', () => {
  const documentPaper = researchPaperSchema.parse({
    ...rawPaper,
    id: 'annotation-cross-node-context-test',
    nodes: [
      { id: 'p-prefix', type: 'paragraph', text: 'a', source: 'test fixture' },
      { id: 'p-target', type: 'paragraph', text: 'x', source: 'test fixture' },
    ],
  })

  expect(
    resolveTextAnchor(
      {
        nodeId: '@document',
        position: { start: 1, end: 2 },
        quote: { exact: 'x', prefix: 'a', suffix: '' },
      },
      documentPaper.nodes,
    ),
  ).toEqual({
    status: 'resolved',
    nodeId: 'p-target',
    start: 0,
    end: 1,
    matchedBy: 'position-and-context',
  })
})

it('recovers a unique document quote after both position and context drift', () => {
  const documentPaper = paragraphFixture(
    'revised opening target revised ending',
  )
  const resolution = resolveTextAnchor(
    {
      nodeId: '@document',
      position: { start: 0, end: 6 },
      quote: { exact: 'target', prefix: 'old ', suffix: ' old' },
    },
    documentPaper.nodes,
  )

  expect(resolution).toEqual({
    status: 'resolved',
    nodeId: 'p-test',
    start: 16,
    end: 22,
    matchedBy: 'unique-quote',
  })
})

it('surfaces document match locations when stale context leaves a repeated quote ambiguous', () => {
  const documentPaper = researchPaperSchema.parse({
    ...rawPaper,
    id: 'annotation-document-ambiguous-test',
    nodes: [
      {
        id: 'p-first',
        type: 'paragraph',
        text: 'target one',
        source: 'test fixture',
      },
      {
        id: 'p-second',
        type: 'paragraph',
        text: 'two target',
        source: 'test fixture',
      },
    ],
  })

  expect(
    resolveTextAnchor(
      {
        nodeId: '@document',
        position: { start: 1, end: 7 },
        quote: { exact: 'target', prefix: 'old', suffix: 'old' },
      },
      documentPaper.nodes,
    ),
  ).toEqual({
    status: 'ambiguous',
    nodeId: '@document',
    reason:
      'Multiple exact quotes remain and the stored context does not identify one safely.',
    candidates: [
      {
        nodeId: 'p-first',
        start: 0,
        end: 6,
        prefixMatches: false,
        suffixMatches: false,
      },
      {
        nodeId: 'p-second',
        start: 4,
        end: 10,
        prefixMatches: false,
        suffixMatches: false,
      },
    ],
  })
})
