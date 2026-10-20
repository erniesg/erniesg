import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { structId } from '@erniesg/struct/identity'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import { createSemanticTextAnchor, resolveTextAnchor } from './annotations'
import { researchPaperSchema } from '../research/schema'
import { buildStructDocument } from '../struct-adapters/from-reconstruction'
import type { DocumentReconstruction } from '../research/import-types'
import {
  annotationBundleSchema,
  createAnnotationBundle,
  createLegacyAnnotationAnchorMap,
  serializeAnnotationBundle,
  type AnnotationAnchorSource,
} from './annotation-bundle'

/**
 * A Struct block id for a fixture block.
 *
 * The id is minted by the package's own identity function — the primitive the
 * app's Struct ingress uses for every block it derives — so a fixture can
 * never end up addressing a graph node id, and no id is invented here.
 */
function structFixtureBlock(input: {
  key: string
  type: string
  text: string
}) {
  return {
    id: structId(
      'block',
      `annotation-fixture:${input.type}:${input.key}:${input.text}`,
    ),
    type: input.type,
    text: input.text,
  }
}

/** A fixture anchor source, carrying a Struct-minted document id. */
function structFixtureSource(input: {
  key: string
  nodes: readonly { id: string; type: string; text: string }[]
}): AnnotationAnchorSource {
  return {
    id: structId('document', `annotation-fixture:${input.key}`),
    nodes: input.nodes,
  }
}

const reconstruction = JSON.parse(
  await readFile(
    new URL(
      '../../tests/fixtures/struct-adapter-parity/reconstructions/ordinary-pdf.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as DocumentReconstruction

/**
 * The Struct document the app's own ingress derives from a real
 * reconstruction. Its block ids are the canonical anchor ids: the graph no
 * longer names a block, the Struct document does.
 */
const structDocument = buildStructDocument(reconstruction)

const structDocumentId = structDocument.documentId
if (!structDocumentId) {
  throw new Error('The Struct fixture lost its document id')
}

const structSource: AnnotationAnchorSource = {
  id: structDocumentId,
  nodes: structDocument.blocks.map((block) => ({
    id: block.id,
    type: block.kind,
    text: block.text,
  })),
}

/** The paragraph of the Struct fixture an anchor can address. */
function structFixtureParagraph() {
  const paragraph = structDocument.blocks.find(
    (block) =>
      block.kind === 'paragraph' && block.text.includes('local PDF extraction'),
  )
  if (!paragraph) throw new Error('The Struct fixture lost its paragraph')
  return paragraph
}

/** A bundle written against the Struct-derived source. */
function structBundleFixture() {
  const paragraph = structFixtureParagraph()
  const annotation = {
    id: 'struct-anchor',
    kind: 'note' as const,
    body: 'Anchored on a Struct block id, not on a graph node id.',
    target: createSemanticTextAnchor(
      paragraph.id,
      paragraph.text,
      'local PDF extraction',
    ),
    geometryCache: [],
  }
  return {
    paragraph,
    bundle: createAnnotationBundle(structSource, [annotation]),
  }
}

it('accepts codepoint and document-scoped anchors against ordered text', () => {
  const first = structFixtureBlock({
    key: 'first',
    type: 'paragraph',
    text: 'a paragraph in which meaning becomes coordinates',
  })
  const second = structFixtureBlock({
    key: 'second',
    type: 'paragraph',
    text: 'a second paragraph',
  })
  const source = structFixtureSource({
    key: 'ordered-text',
    nodes: [first, second],
  })
  const quote = 'meaning becomes coordinates'
  const offset = first.text.indexOf(quote)
  const position = [...first.text.slice(0, offset)].length
  const target = {
    nodeId: first.id,
    positionUnit: 'codepoint' as const,
    position: { start: position, end: position + [...quote].length },
    quote: {
      exact: quote,
      prefix: first.text.slice(0, offset),
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
  expect(() => createAnnotationBundle(source, [annotation])).not.toThrow()
  expect(() =>
    createAnnotationBundle(source, [
      { ...annotation, target: { ...target, nodeId: '@document' } },
    ]),
  ).not.toThrow()
})

describe('AnnotationBundle', () => {
  it('reads a saved 1.0 bundle while writing new bundles as 1.2', () => {
    const saved = JSON.parse(
      '{"version":"1.0.0","graphId":"legacy-graph","anchors":[{"id":"note:target","anchor":{"nodeId":"n","position":{"start":0,"end":4},"quote":{"exact":"text","prefix":"","suffix":""}}}],"annotations":[{"id":"note","kind":"note","target":{"nodeId":"n","position":{"start":0,"end":4},"quote":{"exact":"text","prefix":"","suffix":""}},"body":"saved body","geometryCache":[]}]}',
    )
    const read = annotationBundleSchema.parse(saved)
    expect(read.version).toBe('1.0.0')
    expect(read.annotations[0]).toMatchObject({
      kind: 'note',
      body: 'saved body',
    })
    expect(serializeAnnotationBundle(read)).toContain('"version":"1.0.0"')
    expect(
      annotationBundleSchema.safeParse({ ...saved, version: '0.9.0' }).success,
    ).toBe(false)

    const paragraph = structFixtureParagraph()
    const written = createAnnotationBundle(structSource, [
      {
        id: 'written',
        kind: 'note',
        body: 'written body',
        target: createSemanticTextAnchor(
          paragraph.id,
          paragraph.text,
          'local PDF extraction',
        ),
        geometryCache: [],
      },
    ])
    expect(written.version).toBe('1.2.0')
    expect(written.sourceId).toBe(structDocumentId)
    expect(written.graphId).toBeUndefined()
  })

  it('binds a Struct-derived anchor source and never carries a graph id', () => {
    const { paragraph, bundle } = structBundleFixture()

    expect(bundle.version).toBe('1.2.0')
    expect(bundle.anchors[0].anchor.nodeId).toBe(paragraph.id)
    expect(bundle.anchors[0].anchor.nodeId).toMatch(/^struct-block-/)
  })

  it('binds the bundle to the Struct source id', () => {
    const { bundle } = structBundleFixture()

    expect(bundle.sourceId).toBe(structDocumentId)
    expect(bundle.sourceId).toBe('pdf-50874645b2cec033')
  })

  it('never carries a graph id', () => {
    const { bundle } = structBundleFixture()

    expect(bundle.graphId).toBeUndefined()
    expect(bundle).not.toHaveProperty('graphId')
    expect(serializeAnnotationBundle(bundle)).not.toContain('"graphId"')
  })

  it('refuses a 1.2.0 bundle that still carries a graph id', () => {
    const result = annotationBundleSchema.safeParse({
      version: '1.2.0',
      sourceId: structDocumentId,
      graphId: 'legacy-graph',
      anchors: [],
      annotations: [],
    })

    expect(result.success).toBe(false)
    const messages = result.error?.issues.map((issue) => issue.message) ?? []
    expect(messages.join(' ')).toMatch(/graphId/)
    expect(messages.join(' ')).toMatch(/1\.2\.0/)

    expect(
      annotationBundleSchema.safeParse({
        version: '1.2.0',
        sourceId: structDocumentId,
        anchors: [],
        annotations: [],
      }).success,
    ).toBe(true)
  })

  it('refuses a legacy bundle that lost its graph id or gained a source id', () => {
    const withoutGraphId = annotationBundleSchema.safeParse({
      version: '1.1.0',
      anchors: [],
      annotations: [],
    })
    expect(withoutGraphId.success).toBe(false)
    expect(
      withoutGraphId.error?.issues.map((issue) => issue.message).join(' '),
    ).toMatch(/graphId/)

    const withSourceId = annotationBundleSchema.safeParse({
      version: '1.1.0',
      graphId: 'legacy-graph',
      sourceId: structDocumentId,
      anchors: [],
      annotations: [],
    })
    expect(withSourceId.success).toBe(false)
    expect(
      withSourceId.error?.issues.map((issue) => issue.message).join(' '),
    ).toMatch(/sourceId/)
  })

  it('still parses a legacy 1.1.0 bundle and resolves its graph anchors', () => {
    const legacyAnchor = {
      nodeId: 'paragraph-1',
      position: { start: 4, end: 10 },
      quote: { exact: 'legacy', prefix: 'the ', suffix: ' paragraph text' },
    }
    const legacy = annotationBundleSchema.parse({
      version: '1.1.0',
      graphId: 'legacy-graph',
      anchors: [{ id: 'note:target', anchor: legacyAnchor }],
      annotations: [
        {
          id: 'note',
          kind: 'note',
          target: legacyAnchor,
          body: 'saved body',
          geometryCache: [],
        },
      ],
    })

    expect(legacy.version).toBe('1.1.0')
    expect(legacy.graphId).toBe('legacy-graph')
    expect(legacy.sourceId).toBeUndefined()

    const legacyMap = createLegacyAnnotationAnchorMap({
      id: 'legacy-graph',
      nodes: [
        {
          id: 'paragraph-1',
          type: 'paragraph',
          text: 'the legacy paragraph text',
        },
        { id: 'code-1', type: 'code', code: 'const legacy = true' },
      ],
    })

    expect(legacyMap.id).toBe('legacy-graph')
    expect(legacyMap.nodes).toEqual([
      {
        id: 'paragraph-1',
        type: 'paragraph',
        text: 'the legacy paragraph text',
      },
      { id: 'code-1', type: 'code', text: 'const legacy = true' },
    ])

    expect(
      resolveTextAnchor(legacy.anchors[0].anchor, legacyMap.nodes),
    ).toEqual({
      status: 'resolved',
      nodeId: 'paragraph-1',
      start: 4,
      end: 10,
      matchedBy: 'position-and-context',
    })

    expect(() => createAnnotationBundle(legacyMap, legacy.annotations)).toThrow(
      /read-only/,
    )
  })

  it('round-trips typed annotations and semantic anchors beside the Struct source', () => {
    const paragraph = structFixtureParagraph()
    const annotations = [
      {
        id: 'round-trip',
        kind: 'note' as const,
        body: 'round trip body',
        target: createSemanticTextAnchor(
          paragraph.id,
          paragraph.text,
          'local PDF extraction',
        ),
        geometryCache: [],
      },
    ]
    const bundle = createAnnotationBundle(structSource, annotations)
    expect(
      annotationBundleSchema.parse(
        JSON.parse(serializeAnnotationBundle(bundle)),
      ),
    ).toEqual(bundle)
    expect(bundle.annotations).toEqual(annotations)
    expect(serializeAnnotationBundle(bundle)).not.toContain('"graph":')
    expect(serializeAnnotationBundle(bundle)).not.toContain('"graphId"')
  })

  it('rejects anchors to missing source nodes', () => {
    const paragraph = structFixtureParagraph()
    const target = createSemanticTextAnchor(
      paragraph.id,
      paragraph.text,
      'local PDF extraction',
    )
    const annotations = [
      {
        id: 'missing-node',
        kind: 'note' as const,
        body: 'body',
        target: { ...target, nodeId: 'missing' },
        geometryCache: [],
      },
    ]
    expect(() => createAnnotationBundle(structSource, annotations)).toThrow(
      /missing/,
    )
  })

  it('rejects stale anchor text even when the source node still exists', () => {
    const paragraph = structFixtureParagraph()
    const target = createSemanticTextAnchor(
      paragraph.id,
      paragraph.text,
      'local PDF extraction',
    )
    const annotations = [
      {
        id: 'stale-text',
        kind: 'note' as const,
        body: 'body',
        target: {
          ...target,
          quote: {
            ...target.quote,
            exact: 'x'.repeat(target.quote.exact.length),
          },
        },
        geometryCache: [],
      },
    ]
    expect(() => createAnnotationBundle(structSource, annotations)).toThrow(
      /does not match/,
    )
  })
})

it('validates code-point and document-scoped anchors', () => {
  const paragraph = structFixtureBlock({
    key: 'p-1',
    type: 'paragraph',
    text: '🌊 target',
  })
  const source = structFixtureSource({
    key: 'codepoint-anchors',
    nodes: [paragraph],
  })
  const codepoint = {
    id: 'codepoint',
    kind: 'note' as const,
    body: 'body',
    geometryCache: [],
    target: {
      nodeId: paragraph.id,
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
    createAnnotationBundle(source, [codepoint, document]),
  ).not.toThrow()
})

it('resolves a document anchor at a later quote occurrence', () => {
  const paragraph = structFixtureBlock({
    key: 'p-1',
    type: 'paragraph',
    text: 'first target then second target',
  })
  const source = structFixtureSource({
    key: 'later-document-anchor',
    nodes: [paragraph],
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
  expect(() => createAnnotationBundle(source, [annotation])).not.toThrow()
})

it('accepts a document position that disambiguates repeated quotes', () => {
  const paragraph = structFixtureBlock({
    key: 'p-1',
    type: 'paragraph',
    text: 'x x',
  })
  const source = structFixtureSource({
    key: 'repeated-document-anchor',
    nodes: [paragraph],
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

  expect(() => createAnnotationBundle(source, [annotation])).not.toThrow()
})

it('accepts document context across source-node boundaries', () => {
  const prefix = structFixtureBlock({
    key: 'p-prefix',
    type: 'paragraph',
    text: 'a',
  })
  const target = structFixtureBlock({
    key: 'p-target',
    type: 'paragraph',
    text: 'x',
  })
  const source = structFixtureSource({
    key: 'cross-node-context',
    nodes: [prefix, target],
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

  expect(() => createAnnotationBundle(source, [annotation])).not.toThrow()
})

it('keeps document positions aligned with resolver text projection', () => {
  const figure = rawPaper.nodes.find((node) => node.type === 'figure')
  if (!figure?.relationships?.caption) {
    throw new Error('Annotation fixture lost its figure caption')
  }
  const rawCaption = rawPaper.nodes.find(
    (node) => node.id === figure.relationships.caption,
  )
  if (!rawCaption) throw new Error('Annotation fixture lost its figure caption')

  const paper = researchPaperSchema.parse({
    ...rawPaper,
    id: 'figure-document-position-test',
    nodes: [
      { ...figure, sourceText: '🌊 ' },
      { id: 'p-target', type: 'paragraph', source: 'test', text: 'x x' },
      rawCaption,
    ],
  })
  const caption = paper.nodes.find(
    (node) => node.id === figure.relationships.caption,
  )
  if (!caption || caption.type !== 'caption') {
    throw new Error('Annotation fixture lost its caption text')
  }
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

  const figureBlock = structFixtureBlock({
    key: 'figure',
    type: 'figure',
    text: '🌊 ',
  })
  const paragraphBlock = structFixtureBlock({
    key: 'paragraph',
    type: 'paragraph',
    text: 'x x',
  })
  const captionBlock = structFixtureBlock({
    key: 'caption',
    type: 'caption',
    text: caption.text,
  })
  const source = structFixtureSource({
    key: 'figure-document-position',
    nodes: [figureBlock, paragraphBlock, captionBlock],
  })

  expect(() => createAnnotationBundle(source, [annotation])).not.toThrow()
})

it('resolves document anchors in code and equation nodes', () => {
  const code = structFixtureBlock({
    key: 'code-1',
    type: 'code',
    text: 'x x',
  })
  const equation = structFixtureBlock({
    key: 'equation-1',
    type: 'equation',
    text: 'target',
  })
  const source = structFixtureSource({
    key: 'code-and-equation',
    nodes: [code, equation],
  })

  const codeAnnotation = {
    id: 'code-document-position',
    kind: 'note' as const,
    body: 'body',
    geometryCache: [],
    target: {
      nodeId: '@document',
      position: { start: 0, end: 1 },
      quote: { exact: 'x', prefix: '', suffix: '' },
    },
  }
  const equationAnnotation = {
    id: 'equation-document-fallback',
    kind: 'note' as const,
    body: 'body',
    geometryCache: [],
    target: {
      nodeId: '@document',
      position: { start: 0, end: 6 },
      quote: { exact: 'target', prefix: 'x x', suffix: '' },
    },
  }

  expect(() =>
    createAnnotationBundle(source, [codeAnnotation, equationAnnotation]),
  ).not.toThrow()
})

it('accepts a unique document quote after position and context drift', () => {
  const paragraph = structFixtureBlock({
    key: 'p-1',
    type: 'paragraph',
    text: 'revised opening target revised ending',
  })
  const source = structFixtureSource({
    key: 'unique-document-fallback',
    nodes: [paragraph],
  })
  const annotation = {
    id: 'unique-document-fallback',
    kind: 'note' as const,
    body: 'body',
    geometryCache: [],
    target: {
      nodeId: '@document',
      position: { start: 0, end: 6 },
      quote: { exact: 'target', prefix: 'old ', suffix: ' old' },
    },
  }

  expect(() => createAnnotationBundle(source, [annotation])).not.toThrow()
})

it('rejects a document quote when stale context leaves multiple matches', () => {
  const first = structFixtureBlock({
    key: 'p-1',
    type: 'paragraph',
    text: 'target one',
  })
  const second = structFixtureBlock({
    key: 'p-2',
    type: 'paragraph',
    text: 'two target',
  })
  const source = structFixtureSource({
    key: 'ambiguous-document-fallback',
    nodes: [first, second],
  })
  const annotation = {
    id: 'ambiguous-document-fallback',
    kind: 'note' as const,
    body: 'body',
    geometryCache: [],
    target: {
      nodeId: '@document',
      position: { start: 1, end: 7 },
      quote: { exact: 'target', prefix: 'old', suffix: 'old' },
    },
  }

  expect(() => createAnnotationBundle(source, [annotation])).toThrow(
    /does not resolve to one source node/,
  )
})
