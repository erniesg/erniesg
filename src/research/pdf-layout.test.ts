import { strFromU8 } from 'fflate'
import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildEpub,
  buildReadableEpub,
  inspectEpub,
  renderPublicationXhtml,
} from './epub'
import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfCanonicalHyphenBoundaryDecision,
  PdfNoteRelationship,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfScholarlyCrossReferenceRelationship,
  PdfSourceSemanticFlowBoundaryDecision,
  PdfSourceRun,
  ReconstructionDiagnostic,
} from './import-types'
import {
  captionProvenanceEnvelope,
  canonicalHyperlinkOccurrencesForTable,
  canonicalTableWithApprovedHyperlinks,
  canonicalVisualSourceTranscript,
  mergeProseContinuations,
  orderCanonicalVisualPairs,
  placeMatchedCanonicalNotes,
  reconstructPageAnalyses,
  retainUniqueMonotoneSourceRunAssignment,
  retainUniqueSourceRunAssignmentWithAliases,
  residualPdfRegionAfterLineConsumption,
  residualPdfRegionFragmentsAfterLineConsumption,
  sourceProvenRunFragmentToSpanBoundary,
  synthesizeRecoveredBibliographyClassifications,
} from './pdf-layout'
import { PDF_HYPHEN_LEXICAL_MODEL } from './pdf-hyphenation'
import { reconstructPdf } from './pdf'
import { pdfBodySourceOrderExtremaByPage } from './pdf-regions'
import { assessPdfCompleteness } from './pdf-quality'
import {
  canonicalTextIntegrityIssues,
  internalReferenceIntegrityIssues,
} from './publication-integrity'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import {
  canonicalTableFromLines,
  createSourcePageCropAsset,
} from './visual-assets'
import type { ResearchNode } from './schema'

function placementNote(id: string): ResearchNode {
  return {
    id,
    type: 'footnote',
    kind: 'footnote',
    label: id,
    text: `Source note ${id}.`,
    relationships: { backlinks: [] },
    source: 'pdf:test#page=1',
  }
}

function matchedNotePlacement(
  id: string,
  ownerId: string,
  targetNoteId: string,
): PdfNoteRelationship {
  return {
    id,
    label: id,
    referenceRegionId: `region-${id}`,
    referenceStart: 0,
    referenceEnd: 1,
    targetNoteId,
    status: 'matched',
    canonicalAnchor: {
      kind: 'node',
      nodeId: ownerId,
      start: 0,
      end: 1,
    },
    confidence: 1,
    threshold: 0.72,
    evidence: ['test'],
    candidates: [],
    sourceBoxes: [],
  }
}

describe('matched canonical note placement', () => {
  it('preserves a self-referencing note at its source position', () => {
    const nodes: ResearchNode[] = [
      visualOrderParagraph('before', 'Before.'),
      placementNote('note-self'),
      visualOrderParagraph('after', 'After.'),
    ]

    placeMatchedCanonicalNotes(nodes, [
      matchedNotePlacement('reference-self', 'note-self', 'note-self'),
    ])

    expect(nodes.map((node) => node.id)).toEqual([
      'before',
      'note-self',
      'after',
    ])
  })

  it('preserves cyclic notes in physical source order', () => {
    const nodes: ResearchNode[] = [
      visualOrderParagraph('before', 'Before.'),
      placementNote('note-b'),
      visualOrderParagraph('between', 'Between.'),
      placementNote('note-a'),
      visualOrderParagraph('after', 'After.'),
    ]

    placeMatchedCanonicalNotes(nodes, [
      matchedNotePlacement('reference-a-to-b', 'note-a', 'note-b'),
      matchedNotePlacement('reference-b-to-a', 'note-b', 'note-a'),
    ])

    expect(nodes.map((node) => node.id)).toEqual([
      'before',
      'note-b',
      'between',
      'note-a',
      'after',
    ])
  })

  it('rejects a matched self-reference inside a canonical note', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Self-referencing note', 0.1, 0.08, 0.5, 18),
          run(1, 'Abstract', 0.1, 0.22, 0.2, 16),
          run(1, 'Ordinary body prose.', 0.1, 0.3, 0.5, 10),
          run(1, '1 First note body; see note 1.', 0.1, 0.82, 0.4, 7),
        ]),
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'self-referencing-note.pdf',
      byteLength: 4096,
    })

    const footnotes = result.paper.nodes.filter(
      (node) => node.type === 'footnote',
    )
    const rejected = result.noteRelationships.filter((relationship) =>
      relationship.evidence.includes('cyclic-note-reference-rejected'),
    )
    expect(footnotes).toHaveLength(1)
    expect(rejected).toEqual([
      expect.objectContaining({ status: 'unresolved', targetNoteId: null }),
    ])
    expect(rejected[0].canonicalAnchor).toMatchObject({
      kind: 'node',
      nodeId: footnotes[0].id,
    })
    expect(footnotes[0].relationships.backlinks).not.toContain(rejected[0].id)
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_NOTE_REFERENCE',
          relationshipId: rejected[0].id,
          message: expect.stringContaining('cyclic note relationship'),
        }),
      ]),
    )
  })

  it('demotes a matched note cycle without dropping either source note', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Cyclic nested notes', 0.1, 0.08, 0.5, 18),
          run(1, 'Abstract', 0.1, 0.22, 0.2, 16),
          run(1, 'Ordinary body prose.', 0.1, 0.3, 0.5, 10),
          run(1, '1 First note body; see note 2.', 0.1, 0.82, 0.34, 7),
          run(1, '2 Second note body; see note 1.', 0.1, 0.89, 0.35, 7),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'cyclic-nested-notes.pdf',
      byteLength: 4096,
    })

    const footnotes = result.paper.nodes.filter(
      (node) => node.type === 'footnote',
    )
    const footnoteIds = new Set(footnotes.map((node) => node.id))
    const rejected = result.noteRelationships.filter((relationship) =>
      relationship.evidence.includes('cyclic-note-reference-rejected'),
    )
    expect(footnotes).toHaveLength(2)
    expect(
      footnotes
        .map((node) => node.text)
        .filter((text) => /(?:First|Second) note body/u.test(text)),
    ).toHaveLength(2)
    expect(rejected).toHaveLength(2)
    expect(
      rejected.every(
        (relationship) =>
          relationship.status === 'unresolved' &&
          relationship.targetNoteId === null &&
          relationship.canonicalAnchor?.kind === 'node' &&
          footnoteIds.has(relationship.canonicalAnchor.nodeId),
      ),
    ).toBe(true)
    expect(
      footnotes.flatMap((note) => note.relationships.backlinks),
    ).not.toEqual(expect.arrayContaining(rejected.map((item) => item.id)))
    expect(result.readiness.ready).toBe(false)
  })
})

describe('generated continuous-prose PDF fixture', () => {
  let result: Awaited<ReturnType<typeof reconstructPdf>>

  beforeAll(async () => {
    const bytes = await readFile(
      new URL(
        '../../tests/fixtures/pdf/source-output-checkpoints.pdf',
        import.meta.url,
      ),
    )
    result = await reconstructPdf(
      new File([bytes], 'source-output-checkpoints.pdf', {
        type: 'application/pdf',
      }),
      undefined,
      { language: 'en-US' },
    )
  }, 30_000)

  const paragraphTexts = () =>
    result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' ? [node.text] : [],
    )
  const hasParagraphText = (expected: string) =>
    paragraphTexts().some((text) => text.includes(expected))

  it('proves the physical column and page joins in the semantic-flow ledger', () => {
    expect(
      hasParagraphText(
        'The result continues toward the right column with source proof.',
      ),
    ).toBe(true)
    expect(
      hasParagraphText(
        'A second result sentence runs off the bottom of this page and continues at the top of the next one without losing its clause.',
      ),
    ).toBe(true)
    expect(result.sourceSemanticFlowBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topology: 'same-page-column' }),
        expect.objectContaining({ topology: 'cross-page-column' }),
      ]),
    )
    expect(paragraphTexts().join(' ')).not.toContain(
      'page and Source/output checkpoint fixture continues',
    )
  })

  it('resolves only the source-attested discretionary hyphen', () => {
    expect(
      hasParagraphText('The high-resolution source photograph remains clear.'),
    ).toBe(true)
    expect(
      hasParagraphText('The source preserves the rare-fragment compound.'),
    ).toBe(true)
    expect(result.lineBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'removed-discretionary-hyphen',
          evidence: expect.arrayContaining(['same-document-unhyphenated-word']),
        }),
        expect.objectContaining({
          outcome: 'preserved-lexical-hyphen',
          evidence: expect.arrayContaining([
            'hard-hyphen-form-valid:same-document',
          ]),
        }),
      ]),
    )
  })

  it('keeps literal Markdown, placeholders, and ordered markers as prose', () => {
    const literal =
      '## Not a heading and **not bold** and {placeholder} stay literal.'
    const ordered = '1. Literal numbered syntax stays prose.'
    expect(hasParagraphText(literal)).toBe(true)
    expect(hasParagraphText(ordered)).toBe(true)
    expect(
      result.paper.nodes.filter(
        (node) =>
          'text' in node &&
          (node.text === literal || node.text === ordered) &&
          (node.type === 'heading' ||
            (node.type === 'paragraph' && node.list !== undefined)),
      ),
    ).toEqual([])
  })

  it('honors indentation and source continuity rather than raw gap size', () => {
    expect(
      hasParagraphText(
        'First indented paragraph begins and continues on its next line.',
      ),
    ).toBe(true)
    expect(
      hasParagraphText(
        'Second indented paragraph begins and continues independently.',
      ),
    ).toBe(true)
    expect(
      hasParagraphText(
        'A widely spaced source line begins and remains source-contiguous despite its spacing.',
      ),
    ).toBe(true)
  })

  it('keeps adjacent equation ownership out of canonical prose', () => {
    expect(result.visualRelationships).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'equation' })]),
    )
    expect(paragraphTexts()).toEqual(
      expect.arrayContaining([
        'Prose before the owned equation remains clean.',
        'Prose after the owned equation remains clean.',
      ]),
    )
    expect(paragraphTexts().join(' ')).not.toContain('E = m c 2 (1)')
  })
})

function visualOrderHeading(
  id: string,
  level: 1 | 2 | 3,
  text: string,
): ResearchNode {
  return {
    id,
    type: 'heading',
    level,
    text,
    source: 'pdf:test#page=1',
  }
}

function visualOrderParagraph(id: string, text: string): ResearchNode {
  return {
    id,
    type: 'paragraph',
    text,
    source: 'pdf:test#page=1',
  }
}

function visualOrderFigure(id: string, captionId: string): ResearchNode {
  return {
    id,
    type: 'figure',
    objectType: 'figure',
    title: 'Figure 21. Source-backed result.',
    relationships: {
      caption: captionId,
      assets: [`asset-${id}`],
    },
    source: 'pdf:test#page=4',
  }
}

function visualOrderCaption(
  id: string,
): Extract<ResearchNode, { type: 'caption' }> {
  return {
    id,
    type: 'caption',
    text: 'Figure 21. Source-backed result.',
    source: 'pdf:test#page=4',
  }
}

function matchedVisualOrderReference({
  id,
  anchorNodeId,
  referenceRegionId,
  visualNodeId,
  page,
  y,
}: {
  id: string
  anchorNodeId: string
  referenceRegionId: string
  visualNodeId: string
  page: number
  y: number
}): PdfScholarlyCrossReferenceRelationship {
  return {
    id,
    kind: 'figure',
    text: 'Figure 21',
    labels: ['Figure 21'],
    referenceRegionId,
    referenceStart: 0,
    referenceEnd: 9,
    targets: [
      {
        kind: 'figure',
        label: 'Figure 21',
        referenceStart: 0,
        referenceEnd: 9,
        status: 'matched',
        candidateNodeIds: [visualNodeId],
        targetNodeId: visualNodeId,
        evidence: ['canonical-label-unique'],
      },
    ],
    targetNodeIds: [visualNodeId],
    status: 'matched',
    canonicalAnchor: {
      nodeId: anchorNodeId,
      start: 0,
      end: 9,
    },
    confidence: 1,
    evidence: ['explicit-scholarly-cross-reference-syntax'],
    sourceBoxes: [
      {
        page,
        x: 0.1,
        y,
        width: 0.36,
        height: 0.04,
        rotation: 0,
        method: 'pdf-text',
      },
    ],
  }
}

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName: fontSize > 12 ? 'Heading' : 'Body',
    fontSize,
    confidence: 1,
  }
}

function sourceFlowRegion({
  id,
  column,
  text,
  x,
  y,
  sourceSequenceIndex,
  whitespaceBefore,
}: {
  id: string
  column: 'left' | 'right'
  text: string
  x: number
  y: number
  sourceSequenceIndex: number
  whitespaceBefore?: number
}): PdfPageRegion {
  const sourceRun: PdfSourceRun =
    whitespaceBefore === undefined
      ? {
          ...run(1, text, x, y, 0.385),
          sourceSequenceIndex,
        }
      : {
          ...run(1, text, x, y, 0.385),
          sourceSequenceIndex,
          sourceWhitespaceBefore: 'pdf-text-item',
          sourceWhitespacePredecessorIndex: whitespaceBefore,
        }
  return {
    id,
    page: 1,
    kind: 'body',
    column,
    text,
    confidence: 1,
    box: { ...sourceRun },
    lines: [
      {
        id: `${id}-line`,
        text,
        fontSize: sourceRun.fontSize,
        box: { ...sourceRun },
        runs: [sourceRun],
        sourceFragmentLineage: {
          algorithm: 'source-run-fragment-v1',
          sourceLineId: `${id}-source-line`,
          fragment: 'whole',
          sourceSequenceIndexes: [sourceSequenceIndex],
        },
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function mathRun(
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize: number,
  fontName: string,
) {
  return {
    ...run(1, text, x, y, width, fontSize),
    height: fontSize < 9 ? 0.009 : 0.014,
    fontName,
  }
}

function splitInlineProseEquationRuns({
  afterText = '). The first term records the local drift [42].',
  extraRuns = [],
}: {
  afterText?: string
  extraRuns?: PdfSourceRun[]
} = {}) {
  const before = run(1, 'where', 0.1, 0.34, 0.05)
  const firstBase = mathRun('S', 0.16, 0.34, 0.012, 10, 'Synthetic-CMMI10')
  const firstSubscript = mathRun('k', 0.172, 0.347, 0.007, 7, 'Synthetic-CMMI7')
  const firstSuperscript = mathRun(
    '′',
    0.173,
    0.333,
    0.007,
    7,
    'Synthetic-CMSY7',
  )
  const relationAndSecondBase = mathRun(
    ' = S′(',
    0.184,
    0.34,
    0.052,
    10,
    'Synthetic-CMR10',
  )
  const argumentBase = mathRun('x', 0.236, 0.34, 0.012, 10, 'Synthetic-CMMI10')
  const argumentSuperscript = mathRun(
    'k',
    0.248,
    0.333,
    0.007,
    7,
    'Synthetic-CMMI7',
  )
  const argumentSubscript = mathRun(
    't',
    0.248,
    0.347,
    0.007,
    7,
    'Synthetic-CMMI7',
  )
  const after = run(1, afterText, 0.266, 0.34, 0.39)
  before.sourceSequenceIndex = 0
  Object.assign(firstBase, {
    sourceSequenceIndex: 2,
    sourceWhitespaceBefore: 'pdf-text-item' as const,
    sourceWhitespacePredecessorIndex: 0,
  })
  ;[
    firstSubscript,
    firstSuperscript,
    relationAndSecondBase,
    argumentBase,
    argumentSuperscript,
    argumentSubscript,
  ].forEach((sourceRun, index) => {
    sourceRun.sourceSequenceIndex = index + 3
  })
  Object.assign(after, {
    sourceSequenceIndex: 9,
    sourceWhitespaceBefore: 'pdf-text-item' as const,
    sourceWhitespacePredecessorIndex: 8,
  })
  return [
    before,
    firstBase,
    firstSubscript,
    firstSuperscript,
    relationAndSecondBase,
    argumentBase,
    argumentSuperscript,
    argumentSubscript,
    after,
    ...extraRuns,
  ]
}

function page(
  number: number,
  runs: PdfSourceRun[],
  kind: PdfPageAnalysis['kind'] = 'born-digital',
): PdfPageAnalysis {
  return {
    page: number,
    kind,
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: kind === 'born-digital' ? 0 : 1,
    runs,
  }
}

function sourceOrderedPage(
  number: number,
  runs: PdfSourceRun[],
  kind: PdfPageAnalysis['kind'] = 'born-digital',
) {
  return page(
    number,
    runs.map((sourceRun, sourceSequenceIndex) => ({
      ...sourceRun,
      sourceSequenceIndex,
    })),
    kind,
  )
}

function withExplicitEnglishLanguage(page: PdfPageAnalysis): PdfPageAnalysis {
  return {
    ...page,
    ocr: {
      engine: 'test-language-authority',
      engineVersion: '1',
      model: 'test-en',
      modelVersion: '1',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: '1'.repeat(64),
      rasterSha256: '2'.repeat(64),
      confidence: 1,
      words: [],
      lines: [],
    },
  }
}

function splitExternalHyperlinkTestBlock({
  text,
  continuation,
  target,
}: {
  text: string
  continuation: string
  target: string
}) {
  const scheme = run(1, 'https:', 0.7, 0.2, 0.06)
  const authority = run(1, continuation, 0.1, 0.22, 0.24)
  const region = {
    id: 'split-external-link-region',
    page: 1,
    kind: 'body',
    column: 'single',
    text,
    confidence: 1,
    box: {
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.66,
      height: 0.038,
      rotation: 0,
      method: 'pdf-text',
    },
    lines: [
      {
        id: 'split-external-link-line-1',
        text: scheme.text,
        fontSize: scheme.fontSize,
        box: { ...scheme },
        runs: [scheme],
      },
      {
        id: 'split-external-link-line-2',
        text: authority.text,
        fontSize: authority.fontSize,
        box: { ...authority },
        runs: [authority],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const annotations = [scheme, authority].map((sourceRun, index) => ({
    id: `pdf-link-p001-a${String(index + 1).padStart(4, '0')}`,
    page: 1,
    status: 'external' as const,
    url: index === 0 ? target.replace(/\/$/u, '') : target,
    box: { ...sourceRun, method: 'pdf-link' as const },
  }))
  return {
    block: {
      type: 'paragraph' as const,
      region,
      text,
      confidence: 1,
      nodeId: 'split-external-link-node',
    },
    annotations,
  }
}

function ocrPage(
  text: string,
  languages: string[],
  languageMode: 'explicit' | 'automatic-fallback' = 'explicit',
) {
  const sourceRun = {
    ...run(1, text, 0.1, 0.2, 0.75),
    method: 'ocr' as const,
  }
  const result = page(1, [sourceRun], 'ocr-complete')
  result.ocr = {
    engine: 'test-local-ocr',
    engineVersion: '1.0.0',
    model: 'test-language-model',
    modelVersion: '1.0.0',
    languages,
    languageMode,
    sourceSha256: 'a'.repeat(64),
    rasterSha256: 'b'.repeat(64),
    confidence: 1,
    words: [],
    lines: [
      {
        id: 'ocr-line-1',
        text,
        confidence: 1,
        box: sourceRun,
      },
    ],
  }
  return result
}

describe('PDF semantic reconstruction', () => {
  it('keeps a genuinely later-section float after its exact later-section reference', () => {
    const nodes: ResearchNode[] = [
      {
        id: 'appendix-c',
        type: 'heading',
        level: 1,
        text: 'C. Earlier evidence',
        source: 'pdf:test#page=1',
      },
      {
        id: 'early-preview',
        type: 'paragraph',
        text: 'Figure 8 previews evidence developed in a later section.',
        source: 'pdf:test#page=2',
      },
      {
        id: 'earlier-prose',
        type: 'paragraph',
        text: 'The earlier evidence remains ordinary prose.',
        source: 'pdf:test#page=1',
      },
      {
        id: 'appendix-d',
        type: 'heading',
        level: 1,
        text: 'D. Later evidence',
        source: 'pdf:test#page=2',
      },
      {
        id: 'later-reference',
        type: 'paragraph',
        text: 'The later evidence appears in Figure 8.',
        source: 'pdf:test#page=2',
      },
      {
        id: 'later-prose',
        type: 'paragraph',
        text: 'The later discussion continues.',
        source: 'pdf:test#page=2',
      },
      {
        id: 'visual-later',
        type: 'figure',
        objectType: 'figure',
        title: 'Figure 8. Later result.',
        relationships: {
          caption: 'caption-later',
          assets: ['asset-later'],
        },
        source: 'pdf:test#page=2',
      },
      {
        id: 'caption-later',
        type: 'caption',
        text: 'Figure 8. Later result.',
        source: 'pdf:test#page=2',
      },
    ]
    const crossReference: PdfScholarlyCrossReferenceRelationship = {
      id: 'cross-reference-figure-8',
      kind: 'figure',
      text: 'Figure 8',
      labels: ['Figure 8'],
      referenceRegionId: 'later-reference-region',
      referenceStart: 30,
      referenceEnd: 38,
      targets: [
        {
          kind: 'figure',
          label: 'Figure 8',
          referenceStart: 30,
          referenceEnd: 38,
          status: 'matched',
          candidateNodeIds: ['visual-later'],
          targetNodeId: 'visual-later',
          evidence: ['canonical-label-unique'],
        },
      ],
      targetNodeIds: ['visual-later'],
      status: 'matched',
      canonicalAnchor: {
        nodeId: 'later-reference',
        start: 30,
        end: 38,
      },
      confidence: 1,
      evidence: ['explicit-scholarly-cross-reference-syntax'],
      sourceBoxes: [
        {
          page: 2,
          x: 0.55,
          y: 0.2,
          width: 0.36,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
    }
    const previewReference: PdfScholarlyCrossReferenceRelationship = {
      ...crossReference,
      id: 'cross-reference-preview-figure-8',
      referenceRegionId: 'early-preview-region',
      referenceStart: 0,
      referenceEnd: 8,
      targets: crossReference.targets.map((target) => ({
        ...target,
        referenceStart: 0,
        referenceEnd: 8,
      })),
      canonicalAnchor: {
        nodeId: 'early-preview',
        start: 0,
        end: 8,
      },
      sourceBoxes: [
        {
          page: 2,
          x: 0.1,
          y: 0.6,
          width: 0.36,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
    }
    const expected = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 2,
          column: 'right',
          sourceBox: {
            page: 2,
            x: 0.55,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-later',
          captionNodeId: 'caption-later',
        },
      ],
      [previewReference, crossReference],
    )

    expect(nodes.map((node) => node.id)).toEqual(expected)
  })

  it('does not relocate unreferenced or ambiguously referenced visual pairs', () => {
    const visual = (
      id: string,
      captionId: string,
      title: string,
    ): ResearchNode => ({
      id,
      type: 'figure',
      objectType: 'figure',
      title,
      relationships: { caption: captionId, assets: [`asset-${id}`] },
      source: 'pdf:test#page=2',
    })
    const caption = (id: string, text: string): ResearchNode => ({
      id,
      type: 'caption',
      text,
      source: 'pdf:test#page=2',
    })
    const nodes: ResearchNode[] = [
      {
        id: 'appendix-a',
        type: 'heading',
        level: 1,
        text: 'A. Evidence',
        source: 'pdf:test#page=1',
      },
      {
        id: 'ambiguous-reference',
        type: 'paragraph',
        text: 'Figure 9 may refer to either source candidate.',
        source: 'pdf:test#page=1',
      },
      {
        id: 'appendix-b',
        type: 'heading',
        level: 1,
        text: 'B. Later evidence',
        source: 'pdf:test#page=2',
      },
      visual('visual-unreferenced', 'caption-unreferenced', 'Figure 10.'),
      caption('caption-unreferenced', 'Figure 10.'),
      visual('visual-ambiguous', 'caption-ambiguous', 'Figure 9.'),
      caption('caption-ambiguous', 'Figure 9.'),
    ]
    const ambiguousReference: PdfScholarlyCrossReferenceRelationship = {
      id: 'cross-reference-figure-9',
      kind: 'figure',
      text: 'Figure 9',
      labels: ['Figure 9'],
      referenceRegionId: 'ambiguous-reference-region',
      referenceStart: 0,
      referenceEnd: 8,
      targets: [
        {
          kind: 'figure',
          label: 'Figure 9',
          referenceStart: 0,
          referenceEnd: 8,
          status: 'ambiguous',
          candidateNodeIds: ['visual-ambiguous', 'visual-other'],
          targetNodeId: null,
          evidence: ['canonical-label-ambiguous'],
        },
      ],
      targetNodeIds: [],
      status: 'ambiguous',
      canonicalAnchor: null,
      confidence: 0.5,
      evidence: ['canonical-label-ambiguous'],
      sourceBoxes: [],
    }
    const expected = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 2,
          column: 'left',
          visualNodeId: 'visual-unreferenced',
          captionNodeId: 'caption-unreferenced',
        },
        {
          page: 2,
          column: 'left',
          visualNodeId: 'visual-ambiguous',
          captionNodeId: 'caption-ambiguous',
        },
      ],
      [ambiguousReference],
    )

    expect(nodes.map((node) => node.id)).toEqual(expected)
  })

  it('does not guess containment when a proved source box conflicts with a claimed visual column', () => {
    const nodes: ResearchNode[] = [
      {
        id: 'appendix-a',
        type: 'heading',
        level: 1,
        text: 'A. Evidence',
        source: 'pdf:test#page=1',
      },
      {
        id: 'a-reference',
        type: 'paragraph',
        text: 'Figure 11 contains the result.',
        source: 'pdf:test#page=1',
      },
      {
        id: 'appendix-b',
        type: 'heading',
        level: 1,
        text: 'B. Later evidence',
        source: 'pdf:test#page=2',
      },
      {
        id: 'visual-conflict',
        type: 'figure',
        objectType: 'figure',
        title: 'Figure 11. Conflicting lane evidence.',
        relationships: {
          caption: 'caption-conflict',
          assets: ['asset-conflict'],
        },
        source: 'pdf:test#page=2',
      },
      {
        id: 'caption-conflict',
        type: 'caption',
        text: 'Figure 11. Conflicting lane evidence.',
        source: 'pdf:test#page=2',
      },
    ]
    const crossReference: PdfScholarlyCrossReferenceRelationship = {
      id: 'cross-reference-figure-11',
      kind: 'figure',
      text: 'Figure 11',
      labels: ['Figure 11'],
      referenceRegionId: 'a-reference-region',
      referenceStart: 0,
      referenceEnd: 9,
      targets: [
        {
          kind: 'figure',
          label: 'Figure 11',
          referenceStart: 0,
          referenceEnd: 9,
          status: 'matched',
          candidateNodeIds: ['visual-conflict'],
          targetNodeId: 'visual-conflict',
          evidence: ['canonical-label-unique'],
        },
      ],
      targetNodeIds: ['visual-conflict'],
      status: 'matched',
      canonicalAnchor: {
        nodeId: 'a-reference',
        start: 0,
        end: 9,
      },
      confidence: 1,
      evidence: ['explicit-scholarly-cross-reference-syntax'],
      sourceBoxes: [
        {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.36,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
    }
    const expected = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 2,
          column: 'right',
          sourceBox: {
            page: 2,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-conflict',
          captionNodeId: 'caption-conflict',
        },
      ],
      [crossReference],
    )

    expect(nodes.map((node) => node.id)).toEqual(expected)
  })

  it('keeps visual-caption pairs in canonical column flow when discovery follows vertical geometry', async () => {
    const sourcePage = page(1, [
      run(1, 'Left column establishes its first line.', 0.119, 0.08, 0.37),
      run(1, 'Right column establishes its first line.', 0.514, 0.08, 0.37),
      run(1, 'Left column establishes its second line.', 0.119, 0.14, 0.37),
      run(1, 'Right column establishes its second line.', 0.514, 0.14, 0.37),
      run(1, 'Left column establishes its third line.', 0.119, 0.2, 0.37),
      run(1, 'Right column establishes its third line.', 0.514, 0.2, 0.37),
      run(1, '3.1 Plan Module', 0.119, 0.27, 0.18, 13),
      run(1, '3.2 Draft Module', 0.514, 0.27, 0.18, 13),
      run(1, 'Figure 3. Right-column draft diagram.', 0.514, 0.445, 0.37, 8),
      run(1, 'Figure 2. Left-column plan diagram.', 0.119, 0.715, 0.37, 8),
    ])
    sourcePage.imageCount = 2
    sourcePage.objects = [
      {
        id: 'image-plan-left',
        page: 1,
        kind: 'image',
        box: {
          page: 1,
          x: 0.119,
          y: 0.5,
          width: 0.37,
          height: 0.2,
          rotation: 0,
          method: 'pdf-object',
        },
        confidence: 0.99,
        assetId: null,
        role: 'semantic',
      },
      {
        id: 'image-draft-right',
        page: 1,
        kind: 'image',
        box: {
          page: 1,
          x: 0.514,
          y: 0.3,
          width: 0.37,
          height: 0.13,
          rotation: 0,
          method: 'pdf-object',
        },
        confidence: 0.99,
        assetId: null,
        role: 'semantic',
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: '7'.repeat(64),
      fileName: 'visual-column-discovery-order.pdf',
      byteLength: 4096,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 8,
          height: 8,
          pixels: new Uint8Array(8 * 8 * 4).fill(96),
        }),
    })
    const labelByNodeId = new Map(
      result.visualRelationships.map((relationship) => [
        relationship.canonicalNodeId,
        relationship.label,
      ]),
    )
    const canonicalSequence = result.paper.nodes.flatMap((node) => {
      if (node.type === 'heading') return [node.text]
      if (node.type === 'figure') return [labelByNodeId.get(node.id)]
      return []
    })

    expect(result.visualRelationships.map(({ label }) => label)).toEqual([
      'Figure 3',
      'Figure 2',
    ])
    expect(canonicalSequence).toEqual([
      '3.1 Plan Module',
      'Figure 2',
      '3.2 Draft Module',
      'Figure 3',
    ])
  })

  it('source-crops unresolved CMEX text while preserving adjacent prose', async () => {
    const replacement = run(1, '\ufffd', 0.312, 0.37798, 0.012, 11)
    replacement.height = 0.0142
    replacement.fontName = 'Synthetic-CMEX99'
    const left = run(1, 'N(a,b)', 0.25, 0.38948, 0.06, 11)
    left.height = 0.0142
    left.fontName = 'Synthetic-CMMI10'
    const right = run(1, 'cdefghijklmnop', 0.326, 0.38948, 0.18, 11)
    right.height = 0.0142
    right.fontName = 'Synthetic-CMMI10'
    const sourcePage = page(1, [
      run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.5),
      run(1, 'A second ordinary prose line remains intact.', 0.1, 0.23, 0.5),
      run(1, 'Preceding prose must remain accessible.', 0.12, 0.34, 0.42),
      left,
      replacement,
      right,
      run(1, 'Following prose must remain accessible.', 0.12, 0.42843, 0.42),
    ])
    const reconstruct = (cropAvailable: boolean) =>
      reconstructPageAnalyses({
        pages: [sourcePage],
        sourceHash: 'e'.repeat(64),
        fileName: 'unresolved-cmex-equation.pdf',
        byteLength: 2048,
        rasterizeFigure: async (input) => {
          if (!cropAvailable) throw new Error('source crop unavailable')
          return createSourcePageCropAsset({
            kind: input.kind === 'figure' ? 'raster' : input.kind,
            cropBox: input.sourceBox,
            sourceObjectIds: input.sourceObjectIds,
            sourceBoxes: input.sourceBoxes,
            width: 32,
            height: 8,
            pixels: new Uint8Array(32 * 8 * 4).fill(96),
          })
        },
      })

    const matched = await reconstruct(true)
    const relationship = matched.visualRelationships.find(
      (candidate) => candidate.kind === 'equation',
    )!
    expect(relationship).toMatchObject({
      status: 'matched',
      sourceText: '',
      altTextSource: 'caption',
      sourceRegionIds: [expect.any(String)],
      evidence: expect.arrayContaining([
        'source-page-crop',
        'source-text-transcript-unresolved',
      ]),
    })
    const matchedParagraphText = matched.paper.nodes
      .filter((node) => node.type === 'paragraph')
      .map((node) => node.text)
      .join(' ')
    expect(matchedParagraphText).toContain(
      'Preceding prose must remain accessible.',
    )
    expect(matchedParagraphText).toContain(
      'Following prose must remain accessible.',
    )
    expect(canonicalTextIntegrityIssues(matched.paper)).toEqual([])
    expect(matched.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EPUB_TEXT_SANITIZATION_LOSS' }),
      ]),
    )

    const unresolved = await reconstruct(false)
    expect(unresolved.visualRelationships).toEqual([
      expect.objectContaining({
        kind: 'equation',
        status: 'unresolved',
        sourceText: '',
        evidence: expect.arrayContaining(['source-rendition-unavailable']),
      }),
    ])
    expect(canonicalTextIntegrityIssues(unresolved.paper)).toEqual([
      expect.objectContaining({
        code: 'EPUB_TEXT_SANITIZATION_LOSS',
        replacementGlyphCount: 1,
      }),
    ])
    expect(unresolved.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EPUB_TEXT_SANITIZATION_LOSS' }),
      ]),
    )
  })

  it('assigns source-anchored unique canonical ids to repeated equation labels', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'E = m c 2 (1)', 0.28, 0.24, 0.3, 12),
          run(1, 'F = m a (1)', 0.28, 0.62, 0.3, 12),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'repeated-equation-labels.pdf',
      byteLength: 2048,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 8,
          height: 4,
          pixels: new Uint8Array(8 * 4 * 4).fill(96),
        }),
    })

    const relationships = result.visualRelationships.filter(
      (candidate) =>
        candidate.kind === 'equation' && candidate.status === 'matched',
    )
    const canonicalNodeIds = relationships.map(
      (relationship) => relationship.canonicalNodeId!,
    )

    expect(relationships).toHaveLength(2)
    expect(new Set(canonicalNodeIds).size).toBe(2)
    expect(canonicalNodeIds).toEqual([
      expect.stringContaining('equation-source-p001-001'),
      expect.stringContaining('equation-source-p001-002'),
    ])
    for (const relationship of relationships) {
      expect(
        result.paper.nodes.filter(
          (candidate) => candidate.id === relationship.canonicalNodeId,
        ),
      ).toHaveLength(1)
      expect(result.provenance[relationship.canonicalNodeId!].boxes).toEqual(
        relationship.sourceBoxes,
      )
    }
    expect(
      validatedPdfVisualRelationships({
        paper: result.paper,
        provenance: result.provenance,
        relationships: result.visualRelationships,
        assets: result.assets,
        regions: result.regions,
        pages: result.pages,
      }),
    ).toEqual(relationships)
  })

  it('rejects malformed or disjoint caption provenance envelopes', () => {
    const placeholder: NormalizedSourceBox = {
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.52,
      rotation: 0,
      method: 'pdf-text',
    }
    const box = (
      overrides: Partial<NormalizedSourceBox> = {},
    ): NormalizedSourceBox => ({
      page: 1,
      x: 0.12,
      y: 0.22,
      width: 0.24,
      height: 0.018,
      rotation: 0,
      method: 'pdf-text',
      ...overrides,
    })
    const evidence = (boxes: NormalizedSourceBox[], pages = [1]) => ({
      confidence: 1,
      pages,
      regionIds: ['caption-region'],
      boxes,
      links: [],
    })

    expect(
      captionProvenanceEnvelope(undefined, 'caption-region', placeholder),
    ).toBeNull()
    expect(
      captionProvenanceEnvelope(
        evidence([box(), box({ page: 2 })], [1, 2]),
        'caption-region',
        placeholder,
      ),
    ).toBeNull()
    expect(
      captionProvenanceEnvelope(
        evidence([box(), box({ x: 0.38, method: 'ocr' })]),
        'caption-region',
        placeholder,
      ),
    ).toBeNull()
    expect(
      captionProvenanceEnvelope(
        evidence([box(), box({ x: 0.38, rotation: 90 })]),
        'caption-region',
        placeholder,
      ),
    ).toBeNull()
    expect(
      captionProvenanceEnvelope(
        evidence([box(), box({ x: 0.75, y: 0.68, width: 0.1, height: 0.02 })]),
        'caption-region',
        placeholder,
      ),
    ).toBeNull()
  })

  it('allows a connected source-text equation envelope to expose exact script glyph bounds', () => {
    const placeholder: NormalizedSourceBox = {
      page: 1,
      x: 0.3,
      y: 0.28,
      width: 0.24,
      height: 0.018,
      rotation: 0,
      method: 'pdf-text',
    }
    const evidence: NodeSourceEvidence = {
      confidence: 1,
      pages: [1],
      regionIds: ['equation-region'],
      boxes: [
        { ...placeholder, width: 0.2 },
        {
          ...placeholder,
          x: 0.505,
          y: 0.294,
          width: 0.02,
          height: 0.0076,
        },
      ],
      links: [],
    }

    expect(
      captionProvenanceEnvelope(evidence, 'equation-region', placeholder),
    ).toBeNull()
    expect(
      captionProvenanceEnvelope(evidence, 'equation-region', placeholder, {
        allowExactRegionOverflow: true,
      }),
    ).toMatchObject({
      x: 0.3,
      y: 0.28,
      width: 0.225,
      height: 0.0216,
    })
  })

  it('does not treat vertically separate metadata and body as columns', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Metadata A', 0.7, 0.1, 0.2),
          run(1, 'Metadata B', 0.7, 0.14, 0.2),
          run(1, 'Body line one.', 0.1, 0.3, 0.2),
          run(1, 'Body line two.', 0.1, 0.34, 0.2),
        ]),
      ],
      sourceHash: 'f'.repeat(64),
      fileName: 'metadata-and-body.pdf',
      byteLength: 2048,
    })

    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_READING_ORDER' }),
      ]),
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
  })

  it('counts supplementary Unicode text by code point', async () => {
    const math = '𝑥'.repeat(30)
    const result = await reconstructPageAnalyses({
      pages: [page(1, [run(1, math, 0.1, 0.2, 0.5)])],
      sourceHash: '0'.repeat(64),
      fileName: 'unicode-math.pdf',
      byteLength: 2048,
    })

    expect(result.completeness).toMatchObject({
      sourceTextCharacters: 30,
      matchedTextCharacters: 30,
      unprovenancedRenderedUnitCount: 1,
    })
    expect(result.completeness.outputTextCharacters).toBeGreaterThan(30)
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
  })

  it('blocks publication when a line-boundary join remains unresolved', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'short-', 0.1, 0.2, 0.18),
          run(1, 'continuation', 0.1, 0.225, 0.24),
        ]),
      ],
      sourceHash: '1'.repeat(64),
      fileName: 'unresolved-line-join.pdf',
      byteLength: 2048,
    })

    expect(result.unresolvedCorruptingJoinCount).toBe(1)
    expect(result.structurallyConsumedLineBoundaryCount).toBe(0)
    expect(result.completeness).toMatchObject({
      lineBoundaryCount: 1,
      decidedLineBoundaryCount: 1,
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 0,
    })
    expect(
      result.lineBoundaryDecisions.filter((decision) =>
        ['unresolved', 'ambiguous', 'structural-boundary'].includes(
          decision.outcome,
        ),
      ),
    ).toHaveLength(
      result.unresolvedCorruptingJoinCount +
        result.structurallyConsumedLineBoundaryCount,
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNRESOLVED_CORRUPTING_JOIN',
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
  })

  it('keeps a validated semantic-table boundary aligned with the completeness ledger', async () => {
    const sourcePage = page(1, [
      run(1, 'Synthetic table boundary paper', 0.1, 0.05, 0.5, 18),
      run(1, 'Ordinary prose establishes font.', 0.1, 0.1, 0.5),
      run(1, 'Table 1. Source backed.', 0.1, 0.25, 0.4, 8),
      {
        ...run(1, 'Header', 0.1, 0.3, 0.18),
        bold: true,
        fontName: 'Table-Bold',
      },
      {
        ...run(1, 'Val-', 0.4, 0.3, 0.12),
        bold: true,
        fontName: 'Table-Bold',
      },
      run(1, 'alpha', 0.1, 0.325, 0.18),
      run(1, '1', 0.4, 0.325, 0.04),
      run(1, 'beta', 0.1, 0.35, 0.18),
      run(1, '2', 0.4, 0.35, 0.04),
    ])
    const result = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: 'a'.repeat(64),
      fileName: 'semantic-table-boundary.pdf',
      byteLength: 2048,
    })
    const tableRelationship = result.visualRelationships.find(
      (relationship) => relationship.kind === 'table',
    )

    expect(tableRelationship).toBeDefined()
    expect(
      validatedPdfVisualRelationships({
        paper: result.paper,
        provenance: result.provenance,
        relationships: result.visualRelationships,
        assets: result.assets,
        regions: result.regions,
      }),
    ).toContain(tableRelationship)
    expect(result.lineBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'structural-boundary',
          evidence: expect.arrayContaining(['strict-visual-only-region']),
        }),
      ]),
    )
    expect(result).toMatchObject({
      unresolvedCorruptingJoinCount: 0,
      structurallyConsumedLineBoundaryCount: 1,
      completeness: {
        unresolvedCorruptingJoinCount: 0,
        structurallyConsumedLineBoundaryCount: 1,
      },
    })
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INVALID_LINE_BOUNDARY_LEDGER' }),
      ]),
    )
  })

  it('emits stable OCR gates instead of silently exporting partial text', async () => {
    const pages = [page(1, [], 'ocr-required')]
    const input = {
      pages,
      sourceHash: 'c'.repeat(64),
      fileName: 'scan.pdf',
      byteLength: 8192,
    }
    const first = await reconstructPageAnalyses(input)
    const second = await reconstructPageAnalyses(input)

    expect(first).toEqual(second)
    expect(first.paper.nodes).toEqual([])
    expect(first.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OCR_REQUIRED', severity: 'error' }),
        expect.objectContaining({ code: 'NO_RECONSTRUCTABLE_TEXT' }),
      ]),
    )
    expect(first.completeness.ocrRequiredPages).toEqual([1])
    expect(first.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
  })

  it('clears the OCR gate for accepted scan text without counting the scan surface as a figure', async () => {
    const ocrRun: PdfSourceRun = {
      ...run(
        1,
        'Recovered locally from a scanned source page with enough text.',
        0.1,
        0.2,
        0.72,
      ),
      method: 'ocr',
      confidence: 0.96,
    }
    const scanned: PdfPageAnalysis = {
      ...page(1, [ocrRun], 'ocr-complete'),
      objects: [
        {
          id: 'image-p001-001',
          page: 1,
          kind: 'image',
          assetId: null,
          role: 'scan-source',
          confidence: 0.98,
          box: {
            page: 1,
            x: 0.05,
            y: 0.05,
            width: 0.9,
            height: 0.9,
            rotation: 0,
            method: 'pdf-object',
          },
        },
      ],
      ocr: {
        engine: 'tesseract.js',
        engineVersion: '6.0.1',
        model: 'tessdata_best_int',
        modelVersion: '4.0.0',
        languages: ['eng'],
        languageMode: 'automatic-fallback',
        sourceSha256: 'a'.repeat(64),
        rasterSha256: 'b'.repeat(64),
        confidence: 0.96,
        words: [
          {
            text: ocrRun.text,
            confidence: ocrRun.confidence,
            lineId: 'ocr-line-1',
            box: { ...ocrRun },
            mergeStatus: 'accepted',
          },
        ],
        lines: [
          {
            id: 'ocr-line-1',
            text: ocrRun.text,
            confidence: ocrRun.confidence,
            box: { ...ocrRun },
          },
        ],
      },
    }

    const result = await reconstructPageAnalyses({
      pages: [scanned],
      sourceHash: 'a'.repeat(64),
      fileName: 'scan.pdf',
      byteLength: 8192,
    })

    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OCR_REQUIRED' }),
      ]),
    )
    expect(result.completeness).toMatchObject({
      sourceAssetCount: 0,
      ocrRequiredPages: [],
    })
    expect(result.regions.some((region) => region.kind === 'figure')).toBe(
      false,
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
  })

  it('blocks low-confidence OCR and uncertain spread boundaries for review', async () => {
    const ocrRun: PdfSourceRun = {
      ...run(1, 'Uncertain recovered scan text.', 0.1, 0.2, 0.35),
      method: 'ocr',
      confidence: 0.61,
    }
    const scanned: PdfPageAnalysis = {
      ...page(1, [ocrRun], 'ocr-complete'),
      width: 1224,
      ocr: {
        engine: 'tesseract.js',
        engineVersion: '6.0.1',
        model: 'tessdata_best_int',
        modelVersion: '4.0.0',
        languages: ['eng'],
        languageMode: 'explicit',
        sourceSha256: 'a'.repeat(64),
        rasterSha256: 'b'.repeat(64),
        confidence: 0.61,
        words: [],
        lines: [],
      },
      spread: {
        status: 'uncertain',
        boundary: 0.5,
        confidence: 0.55,
        logicalRegions: [],
      },
    }

    const result = await reconstructPageAnalyses({
      pages: [scanned],
      sourceHash: 'a'.repeat(64),
      fileName: 'spread.pdf',
      byteLength: 8192,
    })

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'LOW_CONFIDENCE_OCR',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'UNCERTAIN_SPREAD_BOUNDARY',
          severity: 'error',
        }),
      ]),
    )
    expect(result.readiness.ready).toBe(false)
  })

  it('does not invent Appendix A from an ordinary A-prefixed body heading', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A paper with ordinary headings', 0.1, 0.06, 0.74, 20),
          run(1, '1 Introduction', 0.1, 0.16, 0.36, 16),
          run(
            1,
            'See Appendix A for material that is not present in this paper.',
            0.1,
            0.22,
            0.78,
          ),
          {
            ...run(1, 'A General Framework', 0.1, 0.42, 0.36, 20),
            fontName: 'NimbusRomNo9L-Medi',
          },
          run(1, 'This is an ordinary section heading.', 0.1, 0.48, 0.7),
        ]),
      ],
      sourceHash: '5'.repeat(64),
      fileName: 'ordinary-a-heading.pdf',
      byteLength: 2048,
    })

    expect(result.crossReferenceRelationships).toEqual([
      expect.objectContaining({
        text: 'Appendix A',
        status: 'unresolved',
        targetNodeIds: [],
      }),
    ])
    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'heading' && node.text === 'A General Framework',
      ),
    ).toBeDefined()
    expect(result.readiness.ready).toBe(false)
  })

  it.each(['Figure 1', 'Figure A.1'])(
    'anchors %s only to its proved canonical visual',
    async (figureLabel) => {
      const figureBox: NormalizedSourceBox = {
        page: 1,
        x: 0.2,
        y: 0.32,
        width: 0.6,
        height: 0.2,
        rotation: 0,
        method: 'pdf-object',
      }
      const sourcePage = page(1, [
        run(1, 'Visual cross references', 0.1, 0.05, 0.7, 20),
        run(1, 'Ada Researcher', 0.1, 0.11, 0.3, 11),
        run(1, 'Abstract', 0.1, 0.17, 0.24, 14),
        run(
          1,
          'This abstract establishes a complete source-backed visual fixture.',
          0.1,
          0.22,
          0.72,
        ),
        run(
          1,
          `${figureLabel}. Source-backed result; compare ${figureLabel}.`,
          0.18,
          0.55,
          0.64,
          8,
        ),
        run(1, `See ${figureLabel} for the result.`, 0.1, 0.64, 0.72),
      ])
      sourcePage.imageCount = 1
      sourcePage.objects = [
        {
          id: 'image-cross-reference',
          page: 1,
          kind: 'image',
          box: figureBox,
          confidence: 1,
          assetId: null,
          role: 'semantic',
        },
      ]

      const result = await reconstructPageAnalyses({
        pages: [sourcePage],
        sourceHash: '4'.repeat(64),
        fileName: 'synthetic-figure-cross-reference.pdf',
        byteLength: 4096,
        rasterizeFigure: async (input) =>
          createSourcePageCropAsset({
            kind: input.kind === 'figure' ? 'raster' : input.kind,
            cropBox: input.sourceBox,
            sourceObjectIds: input.sourceObjectIds,
            sourceBoxes: input.sourceBoxes,
            width: 12,
            height: 8,
            pixels: new Uint8Array(12 * 8 * 4).fill(96),
          }),
      })
      const visual = result.visualRelationships.find(
        (relationship) => relationship.label === figureLabel,
      )
      const crossReferences = result.crossReferenceRelationships.filter(
        (relationship) => relationship.text === figureLabel,
      )
      const crossReference = crossReferences.find(
        (relationship) =>
          result.regions.find(
            (region) => region.id === relationship.referenceRegionId,
          )?.kind === 'body',
      )
      const captionCrossReference = crossReferences.find(
        (relationship) =>
          result.regions.find(
            (region) => region.id === relationship.referenceRegionId,
          )?.kind === 'caption',
      )

      expect(result.crossReferenceRelationships).toHaveLength(2)
      expect(
        result.regions.find(
          (region) => region.id === crossReference?.referenceRegionId,
        )?.kind,
      ).toBe('body')

      expect(visual).toMatchObject({
        status: 'matched',
        canonicalNodeId: expect.any(String),
      })
      expect(crossReference).toMatchObject({
        status: 'matched',
        targetNodeIds: [visual?.canonicalNodeId],
        canonicalAnchor: {
          nodeId: expect.any(String),
          start: 4,
          end: 4 + figureLabel.length,
        },
      })
      expect(captionCrossReference).toMatchObject({
        status: 'matched',
        targetNodeIds: [visual?.canonicalNodeId],
        canonicalAnchor: {
          nodeId: visual?.captionNodeId,
          start: expect.any(Number),
          end: expect.any(Number),
        },
      })
      expect(captionCrossReference?.referenceStart).toBeGreaterThan(0)
      const owner = result.paper.nodes.find(
        (node) => node.id === crossReference?.canonicalAnchor?.nodeId,
      )
      expect(
        owner && 'inlineRuns' in owner ? owner.inlineRuns : undefined,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            start: 4,
            end: 4 + figureLabel.length,
            semanticRole: 'cross-reference',
            relationshipId: crossReference?.id,
            targetIds: [visual?.canonicalNodeId],
          }),
        ]),
      )
      await expect(buildEpub(result.paper, result)).resolves.toMatchObject({
        mode: 'publication',
      })
    },
  )

  it('joins an uppercase scholarly-label continuation only across an owned cross-page float', async () => {
    const secondPage = sourceOrderedPage(2, [
      run(2, 'Method', 0.12, 0.08, 0.12, 8),
      run(2, 'Score', 0.45, 0.08, 0.1, 8),
      run(2, 'DRAFT', 0.12, 0.105, 0.12, 8),
      run(2, '50.3', 0.45, 0.105, 0.1, 8),
      run(2, 'RE3', 0.12, 0.13, 0.12, 8),
      run(2, '59.7', 0.45, 0.13, 0.1, 8),
      run(
        2,
        'Table 4: Ablations on individual components.',
        0.12,
        0.17,
        0.68,
        8,
      ),
      run(
        2,
        'Table 3 illustrates this interesting capability.',
        0.12,
        0.25,
        0.68,
      ),
      run(
        2,
        'See Appendix J for additional complete, i.i.d.',
        0.145,
        0.275,
        0.62,
      ),
      run(2, 'examples of stories from both systems.', 0.12, 0.297, 0.5),
    ])
    const result = await reconstructPageAnalyses({
      pages: [
        sourceOrderedPage(1, [
          run(1, 'Float-interrupted prose', 0.12, 0.06, 0.68, 18),
          run(1, '1 Introduction', 0.12, 0.18, 0.3, 14),
          run(
            1,
            'Opening prose establishes body typography.',
            0.12,
            0.26,
            0.68,
          ),
          run(1, 'The latter part of the story in', 0.12, 0.82, 0.68),
        ]),
        secondPage,
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'owned-float-uppercase-continuation.pdf',
      byteLength: 4096,
      metadata: { title: 'Float-interrupted prose' },
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 8,
          pixels: new Uint8Array(12 * 8 * 4).fill(96),
        }),
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('The latter part of the story in'),
    )
    const table = result.visualRelationships.find(
      (relationship) => relationship.label === 'Table 4',
    )

    expect(table).toMatchObject({
      status: 'matched',
      canonicalNodeId: expect.any(String),
    })
    expect(joined).toMatchObject({
      text: 'The latter part of the story in Table 3 illustrates this interesting capability. See Appendix J for additional complete, i.i.d. examples of stories from both systems.',
    })
    expect(result.provenance[joined!.id]).toMatchObject({
      pages: [1, 2],
      regionIds: expect.arrayContaining([
        expect.stringContaining('page-001-region-'),
        expect.stringContaining('page-002-region-'),
      ]),
    })
    expect(result.sourceSemanticFlowBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topology: 'cross-page-column',
          outcome: 'space',
        }),
      ]),
    )
    expect(
      result.paper.nodes.findIndex((node) => node.id === joined?.id),
    ).toBeLessThan(
      result.paper.nodes.findIndex(
        (node) => node.id === table?.canonicalNodeId,
      ),
    )
  })

  it('joins a citation year split across adjacent source columns', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Adjacent-column citation continuity', 0.1, 0.035, 0.8, 18),
          run(1, '1 Related Work', 0.09, 0.12, 0.3, 14),
          run(
            1,
            'Left-column context establishes the source reading geometry.',
            0.09,
            0.2,
            0.385,
          ),
          run(
            1,
            'A second left-column row confirms the stable gutter.',
            0.09,
            0.23,
            0.385,
          ),
          run(
            1,
            'A third left-column row completes the layout evidence.',
            0.09,
            0.26,
            0.385,
          ),
          run(1, 'Prior evidence from Rivera et al.,', 0.09, 0.8537, 0.385),
          run(
            1,
            '2022) supports the source-backed result.',
            0.515,
            0.0847,
            0.385,
          ),
          run(
            1,
            'Right-column context establishes the second source lane.',
            0.515,
            0.1147,
            0.385,
          ),
          run(
            1,
            'A second right-column row confirms the stable gutter.',
            0.515,
            0.1447,
            0.385,
          ),
          run(
            1,
            'A third right-column row completes the layout evidence.',
            0.515,
            0.2,
            0.385,
          ),
          run(
            1,
            'Another right-column row keeps the source flow explicit.',
            0.515,
            0.23,
            0.385,
          ),
          run(
            1,
            'The final right-column row completes the evidence.',
            0.515,
            0.26,
            0.385,
          ),
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'adjacent-column-citation-year.pdf',
      byteLength: 4096,
      metadata: { title: 'Adjacent-column citation continuity' },
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('Prior evidence from Rivera'),
    )
    expect(joined).toMatchObject({
      text: expect.stringContaining(
        'Prior evidence from Rivera et al., 2022) supports the source-backed result.',
      ),
    })
    expect(
      result.paper.nodes.filter(
        (node) => node.type === 'paragraph' && node.text.startsWith('2022)'),
      ),
    ).toEqual([])
  })

  it('joins a citation year split across adjacent pages', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        sourceOrderedPage(1, [
          run(1, 'Cross-page citation continuity', 0.1, 0.035, 0.8, 18),
          run(1, '1 Related Work', 0.09, 0.12, 0.3, 14),
          run(
            1,
            'The discussion establishes ordinary body typography.',
            0.09,
            0.24,
            0.72,
          ),
          run(1, 'Prior evidence from Okafor et al.,', 0.09, 0.84, 0.72),
        ]),
        sourceOrderedPage(2, [
          run(2, '2022) supports the source-backed result.', 0.09, 0.08, 0.72),
        ]),
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'cross-page-citation-year.pdf',
      byteLength: 4096,
      metadata: { title: 'Cross-page citation continuity' },
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('Prior evidence from Okafor'),
    )

    expect(joined).toMatchObject({
      text: 'Prior evidence from Okafor et al., 2022) supports the source-backed result.',
    })
    expect(result.provenance[joined!.id]).toMatchObject({ pages: [1, 2] })
    expect(result.sourceSemanticFlowBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topology: 'cross-page-column',
          outcome: 'space',
        }),
      ]),
    )
  })

  it('joins a citation year split between adjacent same-column source regions', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Same-flow citation continuity', 0.1, 0.035, 0.8, 18),
          run(1, '1 Related Work', 0.1, 0.12, 0.3, 14),
          run(
            1,
            'Earlier context establishes ordinary body typography.',
            0.1,
            0.2,
            0.72,
          ),
          {
            ...run(
              1,
              'Prior datasets include WritingPrompts (Fan et al.,',
              0.125,
              0.3,
              0.68,
            ),
            sourceSequenceIndex: 500,
          },
          {
            ...run(
              1,
              '2018) and STORIUM for longer-form generation.',
              0.1,
              0.322,
              0.7,
            ),
            sourceSequenceIndex: 501,
            sourceWhitespaceBefore: 'pdf-text-item',
            sourceWhitespacePredecessorIndex: 500,
          },
          run(
            1,
            'A following complete paragraph remains separate.',
            0.125,
            0.39,
            0.68,
          ),
        ]),
      ],
      sourceHash: '1'.repeat(64),
      fileName: 'same-flow-citation-year.pdf',
      byteLength: 4096,
      metadata: { title: 'Same-flow citation continuity' },
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('Prior datasets include WritingPrompts'),
    )

    expect(joined).toMatchObject({
      text: 'Prior datasets include WritingPrompts (Fan et al., 2018) and STORIUM for longer-form generation.',
    })
    expect(
      result.paper.nodes.filter(
        (node) => node.type === 'paragraph' && node.text.startsWith('2018)'),
      ),
    ).toEqual([])
    expect(result.provenance[joined!.id]).toMatchObject({
      pages: [1],
      regionIds: expect.arrayContaining([
        expect.stringContaining('page-001-region-'),
      ]),
    })
  })

  it('joins sentence halves around one complete caption-bounded table unit', async () => {
    const source = page(1, [
      run(1, 'Caption-bounded table continuity', 0.1, 0.035, 0.8, 18),
      run(1, '1 Evaluation', 0.09, 0.12, 0.3, 14),
      run(
        1,
        'Left-column context establishes the source reading geometry.',
        0.09,
        0.2,
        0.385,
      ),
      run(
        1,
        'A second left-column row confirms the stable gutter.',
        0.09,
        0.3,
        0.385,
      ),
      run(
        1,
        'A third left-column row completes the layout evidence.',
        0.09,
        0.4,
        0.385,
      ),
      run(
        1,
        'There remain some confusing passages or contradictory',
        0.09,
        0.84,
        0.385,
      ),
      run(
        1,
        'PREMISE: A complete source-authored story setup.',
        0.515,
        0.2,
        0.385,
        9,
      ),
      run(1, 'GENERATED OUTLINE:', 0.515, 0.3, 0.3, 9),
      run(
        1,
        'The character follows the first outline point.',
        0.515,
        0.4,
        0.385,
        9,
      ),
      run(
        1,
        'Table 3: A complete caption for the bounded example.',
        0.515,
        0.56,
        0.385,
        8,
      ),
      run(
        1,
        'statements: for example, the character identity changes.',
        0.515,
        0.64,
        0.385,
      ),
      run(
        1,
        'However, the following complete paragraph remains separate.',
        0.515,
        0.7,
        0.385,
      ),
    ])
    const result = await reconstructPageAnalyses({
      pages: [source],
      sourceHash: '2'.repeat(64),
      fileName: 'caption-bounded-table-continuity.pdf',
      byteLength: 4096,
      metadata: { title: 'Caption-bounded table continuity' },
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('There remain some confusing passages'),
    )
    const tableCaption = result.paper.nodes.find(
      (node) => node.type === 'caption' && node.text.startsWith('Table 3:'),
    )

    expect(joined).toMatchObject({
      text: 'There remain some confusing passages or contradictory statements: for example, the character identity changes.',
    })
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' && node.text.startsWith('statements:'),
      ),
    ).toEqual([])
    expect(
      result.paper.nodes.findIndex((node) => node.id === joined?.id),
    ).toBeLessThan(
      result.paper.nodes.findIndex((node) => node.id === tableCaption?.id),
    )
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' &&
          /^(?:PREMISE|GENERATED OUTLINE|The character)/u.test(node.text),
      ),
    ).toHaveLength(3)
    expect(result.provenance[joined!.id]).toMatchObject({
      regionIds: expect.arrayContaining([
        expect.stringContaining('page-001-region-'),
      ]),
    })
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'CANONICAL_FLOW_ORDER_VIOLATION',
      ),
    ).toBe(false)
  })

  it('fails a plausible caption-bounded table interruption closed without a column-tail boundary', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ambiguous table interruption', 0.1, 0.035, 0.8, 18),
          run(1, '1 Evaluation', 0.09, 0.12, 0.3, 14),
          run(
            1,
            'Left-column context establishes the source reading geometry.',
            0.09,
            0.2,
            0.385,
          ),
          run(
            1,
            'A second left-column row confirms the stable gutter.',
            0.09,
            0.3,
            0.385,
          ),
          run(
            1,
            'A third left-column row completes the layout evidence.',
            0.09,
            0.4,
            0.385,
          ),
          run(1, 'The sentence may have an ambiguous', 0.09, 0.5, 0.385),
          run(
            1,
            'PREMISE: A source-authored story setup.',
            0.515,
            0.2,
            0.385,
            9,
          ),
          run(1, 'GENERATED OUTLINE: First point.', 0.515, 0.3, 0.385, 9),
          run(
            1,
            'GENERATED STORY: A bounded source example.',
            0.515,
            0.4,
            0.385,
            9,
          ),
          run(
            1,
            'Table 3: A caption for the bounded example.',
            0.515,
            0.56,
            0.385,
            8,
          ),
          run(
            1,
            'continuation after the table-shaped interruption.',
            0.515,
            0.64,
            0.385,
          ),
        ]),
      ],
      sourceHash: '3'.repeat(64),
      fileName: 'ambiguous-caption-bounded-table.pdf',
      byteLength: 4096,
      metadata: { title: 'Ambiguous table interruption' },
    })

    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' &&
          (node.text.startsWith('The sentence may') ||
            node.text.startsWith('continuation after')),
      ),
    ).toHaveLength(2)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'error',
          message: expect.stringContaining('caption-bounded table'),
        }),
      ]),
    )
  })

  it('keeps a source-earlier visual in its physical scope when only a later scope references it', () => {
    const visualNodeId = 'visual-before-later-reference'
    const captionNodeId = 'caption-before-later-reference'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 Earlier scope'),
      visualOrderParagraph('scope-a-prose', 'Earlier prose remains unchanged.'),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
      visualOrderHeading('scope-b', 2, 'A.2 Proved visual scope'),
      visualOrderParagraph(
        'later-reference',
        'The direct discussion uses Figure 21 here.',
      ),
      visualOrderParagraph(
        'scope-b-prose',
        'The proved visual scope continues.',
      ),
      visualOrderHeading('scope-c', 2, 'A.3 Following scope'),
    ]
    const laterReference = matchedVisualOrderReference({
      id: 'cross-reference-after-physical-visual',
      anchorNodeId: 'later-reference',
      referenceRegionId: 'later-reference-region',
      visualNodeId,
      page: 2,
      y: 0.3,
    })
    const diagnostics: ReconstructionDiagnostic[] = []
    const sourceOrder = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 1,
          column: 'left',
          sourceBox: {
            page: 1,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId,
          captionNodeId,
        },
      ],
      [laterReference],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          relationshipId: laterReference.id,
          severity: 'info',
        }),
      ]),
    )
  })

  it('keeps a source cluster safe when exact references surround it in different heading scopes', () => {
    const visualNodeId = 'visual-between-reference-scopes'
    const captionNodeId = 'caption-between-reference-scopes'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 Early scope'),
      visualOrderParagraph(
        'early-reference',
        'An early mention names Figure 21.',
      ),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
      visualOrderHeading('scope-b', 2, 'A.2 Direct discussion'),
      visualOrderParagraph(
        'later-reference',
        'The later direct discussion uses Figure 21.',
      ),
      visualOrderHeading('scope-c', 2, 'A.3 Following scope'),
    ]
    const earlyReference = matchedVisualOrderReference({
      id: 'cross-reference-before-physical-visual',
      anchorNodeId: 'early-reference',
      referenceRegionId: 'early-reference-region',
      visualNodeId,
      page: 1,
      y: 0.3,
    })
    const laterReference = matchedVisualOrderReference({
      id: 'cross-reference-after-physical-visual',
      anchorNodeId: 'later-reference',
      referenceRegionId: 'later-reference-region',
      visualNodeId,
      page: 2,
      y: 0.3,
    })
    const diagnostics: ReconstructionDiagnostic[] = []
    const sourceOrder = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 1,
          column: 'left',
          sourceBox: {
            page: 1,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId,
          captionNodeId,
        },
      ],
      [earlyReference, laterReference],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          severity: 'info',
          sourceBoxes: [
            earlyReference.sourceBoxes[0],
            laterReference.sourceBoxes[0],
          ],
        }),
      ]),
    )
  })
})
