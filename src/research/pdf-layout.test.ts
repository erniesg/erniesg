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
  resolveCanonicalHyperlinkObligations,
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

function canonicalHyperlinkTestBlock(text = 'Open target') {
  const sourceRun = run(1, text, 0.1, 0.2, 0.3)
  const region = {
    id: 'internal-link-source-region',
    page: 1,
    kind: 'body',
    column: 'single',
    text,
    confidence: 1,
    box: { ...sourceRun },
    lines: [
      {
        id: 'internal-link-source-line',
        text,
        fontSize: sourceRun.fontSize,
        box: { ...sourceRun },
        runs: [sourceRun],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  return {
    block: {
      type: 'paragraph' as const,
      region,
      text,
      confidence: 1,
      nodeId: 'internal-link-source-node',
    },
    box: {
      page: 1,
      x: sourceRun.x,
      y: sourceRun.y,
      width: sourceRun.width,
      height: sourceRun.height,
      rotation: 0,
      method: 'pdf-link' as const,
    },
  }
}

function sourceSubstringBox(
  sourceRun: PdfSourceRun,
  start: number,
  end: number,
  method: NormalizedSourceBox['method'] = 'pdf-link',
): NormalizedSourceBox {
  return {
    page: sourceRun.page,
    x: sourceRun.x + sourceRun.width * (start / sourceRun.text.length),
    y: sourceRun.y,
    width: sourceRun.width * ((end - start) / sourceRun.text.length),
    height: sourceRun.height,
    rotation: sourceRun.rotation,
    method,
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

  it('maps a safe literal absolute URL when no PDF link annotation exists', async () => {
    const url = 'https://example.test/archive?q=one&lang=en'
    const literal = run(
      1,
      `Source evidence at ${url}, remains linked without an annotation.`,
      0.1,
      0.2,
      0.78,
    )
    const unsafe = run(
      1,
      'A javascript:alert(1) literal and /relative/path remain plain text.',
      0.1,
      0.24,
      0.78,
    )
    const result = await reconstructPageAnalyses({
      pages: [page(1, [literal, unsafe])],
      sourceHash: '1'.repeat(64),
      fileName: 'synthetic-literal-links.pdf',
      byteLength: 2048,
    })
    const node = result.paper.nodes.find(
      (candidate) => 'text' in candidate && candidate.text.includes(url),
    )

    expect(node && 'inlineRuns' in node ? node.inlineRuns : undefined).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          start: node && 'text' in node ? node.text.indexOf(url) : -1,
          end:
            node && 'text' in node ? node.text.indexOf(url) + url.length : -1,
          href: url,
        }),
      ]),
    )
    expect(
      result.paper.nodes.flatMap((candidate) =>
        'inlineRuns' in candidate
          ? (candidate.inlineRuns ?? []).flatMap((inline) =>
              inline.href ? [inline.href] : [],
            )
          : [],
      ),
    ).toEqual([url])
  })

  it('maps one complete literal URL across a source line boundary', async () => {
    const url = 'https://sample-domain.test/archive'
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Source evidence at https://sample-', 0.1, 0.2, 0.45),
          run(1, 'domain.test/archive remains readable.', 0.1, 0.222, 0.45),
        ]),
      ],
      sourceHash: '3'.repeat(64),
      fileName: 'synthetic-wrapped-literal-link.pdf',
      byteLength: 2048,
    })
    const node = result.paper.nodes.find(
      (candidate) => 'text' in candidate && candidate.text.includes(url),
    )

    expect(node && 'text' in node ? node.text : null).toContain(
      `${url} remains readable.`,
    )
    expect(node && 'inlineRuns' in node ? node.inlineRuns : undefined).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          start: node && 'text' in node ? node.text.indexOf(url) : -1,
          end:
            node && 'text' in node ? node.text.indexOf(url) + url.length : -1,
          href: url,
        }),
      ]),
    )
    expect(
      result.paper.nodes.flatMap((candidate) =>
        'inlineRuns' in candidate
          ? (candidate.inlineRuns ?? []).flatMap((inline) =>
              inline.href ? [inline.href] : [],
            )
          : [],
      ),
    ).toEqual([url])
  })

  it('does not infer a literal URL through an overlapping unresolved annotation', async () => {
    const url = 'https://example.test/annotated'
    const linked = page(1, [
      run(1, `Annotated literal ${url} remains readable.`, 0.1, 0.2, 0.78),
    ])
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'unresolved',
        target: url,
        reason: 'conflicting-targets',
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.78,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '2'.repeat(64),
      fileName: 'synthetic-annotated-literal-link.pdf',
      byteLength: 2048,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        'inlineRuns' in node
          ? (node.inlineRuns ?? []).filter((run) => run.href)
          : [],
      ),
    ).toEqual([])
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_HYPERLINK',
    )
  })

  it('keeps malformed embedded URLs as blocking source obligations', async () => {
    const linked = page(1, [
      run(1, 'Malformed link text remains readable.', 0.1, 0.2, 0.7),
    ])
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'unresolved',
        target: String.raw`https://example.test/archive\n\nor`,
        reason: 'unsafe-external-target',
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.7,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '2'.repeat(64),
      fileName: 'synthetic-malformed-link.pdf',
      byteLength: 2048,
    })
    const textNode = result.paper.nodes.find(
      (candidate) =>
        'text' in candidate && candidate.text.includes('Malformed link text'),
    )

    expect(textNode && 'text' in textNode ? textNode.text : '').toContain(
      'Malformed link text remains readable.',
    )
    expect(
      textNode && 'inlineRuns' in textNode
        ? (textNode.inlineRuns ?? []).flatMap((run) =>
            run.href ? [run.href] : [],
          )
        : [],
    ).toEqual([])
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 0,
      hyperlinkCoverage: 0,
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_HYPERLINK',
          severity: 'error',
          page: 1,
          relationshipId: 'pdf-link-p001-a0001',
          sourceBoxes: linked.links[0].box ? [linked.links[0].box] : undefined,
        }),
      ]),
    )
    expect(result.readiness.ready).toBe(false)
  })

  it('anchors explicit section and appendix references to unique canonical headings', async () => {
    const appendixHeading = {
      ...run(2, 'A Supplement', 0.1, 0.12, 0.36, 11),
      fontName: 'NimbusRomNo9L-Medi',
    }
    const secondAppendixHeading = {
      ...run(2, 'B Additional Results', 0.1, 0.5, 0.44, 11),
      fontName: 'NimbusRomNo9L-Medi',
    }
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Deterministic cross references', 0.1, 0.06, 0.74, 20),
          run(1, '1. Introduction', 0.1, 0.16, 0.36, 16),
          run(
            1,
            'See Section 6.1 and Appendix A for the full results.',
            0.1,
            0.22,
            0.78,
          ),
          run(1, '6.1 Evaluation', 0.1, 0.42, 0.36, 16),
          run(1, 'The evaluation is deterministic.', 0.1, 0.48, 0.7),
        ]),
        page(2, [
          appendixHeading,
          run(2, 'Supplementary evidence.', 0.1, 0.22, 0.6),
          secondAppendixHeading,
          run(2, 'Additional evidence.', 0.1, 0.6, 0.6),
        ]),
      ],
      sourceHash: '3'.repeat(64),
      fileName: 'synthetic-cross-references.pdf',
      byteLength: 2048,
    })

    expect(
      result.crossReferenceRelationships.map(
        (relationship) => relationship.text,
      ),
    ).toEqual(['Section 6.1', 'Appendix A'])
    for (const relationship of result.crossReferenceRelationships) {
      expect(relationship).toMatchObject({
        status: 'matched',
        targetNodeIds: [expect.any(String)],
        canonicalAnchor: {
          nodeId: expect.any(String),
          start: expect.any(Number),
          end: expect.any(Number),
        },
      })
      const owner = result.paper.nodes.find(
        (node) => node.id === relationship.canonicalAnchor?.nodeId,
      )
      expect(owner && 'text' in owner ? owner.text : '').toContain(
        relationship.text,
      )
      expect(
        result.paper.nodes.find(
          (node) => node.id === relationship.targetNodeIds[0],
        ),
      ).toMatchObject({ type: 'heading' })
    }
    expect(
      result.diagnostics.filter((diagnostic) =>
        diagnostic.code.includes('SCHOLARLY_CROSS_REFERENCE'),
      ),
    ).toEqual([])
  })

  it('retains internal destinations as blocking source-cited obligations', async () => {
    const linked = page(1, [
      run(1, 'See the internal destination.', 0.1, 0.2, 0.7),
    ])
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal',
        destination: 'methods',
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.7,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '3'.repeat(64),
      fileName: 'synthetic-internal-link.pdf',
      byteLength: 2048,
    })

    expect(Object.values(result.provenance)[0].links).toEqual(linked.links)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_HYPERLINK',
          relationshipId: 'pdf-link-p001-a0001',
          sourceBoxes: [linked.links[0].box],
        }),
      ]),
    )
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 0,
      hyperlinkCoverage: 0,
    })
    expect(result.readiness.ready).toBe(false)
  })

  it.each([
    ['section.4', 'section', 'Section 4', 'section-four'],
    ['appendix.M', 'appendix', 'Appendix M', 'appendix-m'],
    ['figure.caption.3', 'figure', 'Figure 3', 'figure-three'],
    ['table.caption.7', 'table', 'Table 7', 'table-seven'],
    ['equation.2.1', 'equation', 'Equation 2.1', 'equation-two-one'],
  ] as const)(
    'maps the exact internal destination %s to one unique canonical target',
    (destination, kind, label, targetNodeId) => {
      const { block, box } = canonicalHyperlinkTestBlock()
      const annotation = {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal',
        destination,
        box,
      } as const

      const resolution = resolveCanonicalHyperlinkObligations({
        blocks: [block],
        annotations: [annotation],
        canonicalTargets: [
          {
            kind,
            label,
            nodeId: targetNodeId,
          },
        ],
      })

      expect(resolution.mappings).toEqual([
        {
          annotationId: annotation.id,
          blockNodeId: block.nodeId,
          start: 0,
          end: block.text.length,
          href: `#${targetNodeId}`,
        },
      ])
      expect(resolution.diagnostics).toEqual([])
      expect(resolution.ledger).toEqual({ expected: 1, mapped: 1 })
    },
  )

  it('keeps duplicate canonical labels unresolved instead of selecting a destination', () => {
    const { block, box } = canonicalHyperlinkTestBlock()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'section.4',
      box,
    } as const
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        { kind: 'section', label: 'Section 4', nodeId: 'section-four-a' },
        { kind: 'section', label: 'Section 4', nodeId: 'section-four-b' },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        relationshipId: annotation.id,
        message: expect.stringMatching(/more than one canonical target/i),
      }),
    ])
  })

  it('keeps unsupported internal destination schemes unresolved', () => {
    const { block, box } = canonicalHyperlinkTestBlock()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'section*.4',
      box,
    } as const
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        { kind: 'section', label: 'Section 4', nodeId: 'section-four' },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        relationshipId: annotation.id,
        message: expect.stringMatching(/unsupported internal PDF destination/i),
      }),
    ])
  })

  it('emits a source-proved internal annotation href to an existing EPUB heading id', async () => {
    const linked = page(1, [
      run(1, 'Internal Destination Study', 0.2, 0.06, 0.6, 18),
      run(1, 'Ada Example', 0.4, 0.13, 0.2, 11),
      run(1, 'Abstract', 0.1, 0.2, 0.2, 14),
      run(
        1,
        'This abstract establishes a source-backed internal-link fixture.',
        0.1,
        0.25,
        0.78,
      ),
      run(1, 'Open the methods section.', 0.1, 0.38, 0.42),
      run(1, '4 Methods', 0.1, 0.56, 0.3, 16),
      run(1, 'The methods remain canonical prose.', 0.1, 0.62, 0.7),
    ])
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal',
        destination: 'section.4',
        box: {
          page: 1,
          x: 0.1,
          y: 0.38,
          width: 0.42,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '4'.repeat(64),
      fileName: 'source-proved-internal-link.pdf',
      byteLength: 2048,
    })
    const target = result.paper.nodes.find(
      (node) => node.type === 'heading' && node.text === '4 Methods',
    )
    const owner = result.paper.nodes.find(
      (node) =>
        'text' in node && node.text.includes('Open the methods section.'),
    )

    expect(target).toBeDefined()
    expect(
      owner && 'inlineRuns' in owner
        ? owner.inlineRuns?.filter(
            (run) => run.annotationId === 'pdf-link-p001-a0001',
          )
        : [],
    ).toEqual([
      expect.objectContaining({
        href: `#${target!.id}`,
        annotationId: 'pdf-link-p001-a0001',
      }),
    ])
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 1,
      hyperlinkCoverage: 1,
    })
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNRESOLVED_HYPERLINK',
      ),
    ).toEqual([])

    const epub = await buildEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toContain(`href="#${target!.id}"`)
    expect(content).toContain(`id="${target!.id}"`)
  })

  it('maps an exact numeric citation destination to its unique bibliography entry', async () => {
    const citationText = 'Prior work [1] establishes the baseline.'
    const citationStart = citationText.indexOf('[1]')
    const citationEnd = citationStart + '[1]'.length
    const linked = page(1, [
      run(1, 'Internal Citation Study', 0.1, 0.08, 0.7, 22),
      run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
      run(1, citationText, 0.1, 0.24, 0.72),
    ])
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal',
        destination: 'cite.1',
        box: {
          page: 1,
          x: 0.29,
          y: 0.24,
          width: 0.07,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        linked,
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[1] First source-backed reference.', 0.1, 0.82, 0.72, 7),
        ]),
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'source-proved-internal-citation.pdf',
      byteLength: 2048,
    })
    const reference = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.list?.numberingId === 'references' &&
        node.list.ordinal === 1,
    )
    const annotationRun = result.paper.nodes.flatMap((node) =>
      'inlineRuns' in node
        ? (node.inlineRuns ?? []).filter(
            (run) => run.annotationId === 'pdf-link-p001-a0001',
          )
        : [],
    )

    expect(reference).toBeDefined()
    expect(annotationRun).toEqual([
      expect.objectContaining({
        start: citationStart,
        end: citationEnd,
        href: `#${reference!.id}`,
        annotationId: 'pdf-link-p001-a0001',
        semanticRole: 'citation',
        targetIds: [reference!.id],
      }),
    ])
    expect(
      result.paper.nodes.some(
        (node) =>
          'inlineRuns' in node &&
          node.inlineRuns?.some(
            (run) =>
              run.annotationId === 'pdf-link-p001-a0001' &&
              'text' in node &&
              node.text.slice(run.start, run.end) !== '[1]',
          ),
      ),
    ).toBe(false)
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 1,
      hyperlinkCoverage: 1,
    })

    const epub = await buildReadableEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toMatch(
      /Prior work <a[^>]+epub:type="biblioref"[^>]*>\[1\]<\/a> establishes the baseline\./u,
    )
    expect(content).not.toMatch(/<a[^>]*>Prior work/u)
  })

  it('coalesces duplicate internal annotation fragments for one canonical range and target', () => {
    const { block } = canonicalHyperlinkTestBlock('[1]')
    const annotations = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal' as const,
        destination: 'cite.1',
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.14,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link' as const,
        },
      },
      {
        id: 'pdf-link-p001-a0002',
        page: 1,
        status: 'internal' as const,
        destination: 'cite.1',
        box: {
          page: 1,
          x: 0.25,
          y: 0.2,
          width: 0.15,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link' as const,
        },
      },
    ]
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations,
      canonicalTargets: [
        {
          kind: 'reference',
          label: 'Reference 1',
          nodeId: 'reference-one',
        },
      ],
      canonicalInternalSurfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: block.nodeId,
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.3,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
    })

    expect(resolution.mappings).toEqual([
      {
        annotationId: annotations[0].id,
        blockNodeId: block.nodeId,
        start: 0,
        end: 3,
        href: '#reference-one',
      },
    ])
    expect(resolution.approvedAnnotationIds).toEqual(
      new Set(annotations.map((annotation) => annotation.id)),
    )
    expect(resolution.ledger).toEqual({ expected: 2, mapped: 2 })
    expect(resolution.diagnostics).toEqual([])
  })

  it('rejects every conflicting internal target claimed by one canonical range independent of input order', () => {
    const { block } = canonicalHyperlinkTestBlock('[1]')
    const annotations = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal' as const,
        destination: 'cite.1',
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.14,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link' as const,
        },
      },
      {
        id: 'pdf-link-p001-a0002',
        page: 1,
        status: 'internal' as const,
        destination: 'cite.2',
        box: {
          page: 1,
          x: 0.25,
          y: 0.2,
          width: 0.15,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link' as const,
        },
      },
    ]
    const resolve = (orderedAnnotations: typeof annotations) =>
      resolveCanonicalHyperlinkObligations({
        blocks: [block],
        annotations: orderedAnnotations,
        canonicalTargets: [
          {
            kind: 'reference',
            label: 'Reference 1',
            nodeId: 'reference-one',
          },
          {
            kind: 'reference',
            label: 'Reference 2',
            nodeId: 'reference-two',
          },
        ],
        canonicalInternalSurfaces: [
          {
            targetNodeId: 'reference-one',
            blockNodeId: block.nodeId,
            start: 0,
            end: 3,
            sourceBoxes: [
              {
                page: 1,
                x: 0.1,
                y: 0.2,
                width: 0.14,
                height: 0.018,
                rotation: 0,
                method: 'pdf-text',
              },
            ],
          },
          {
            targetNodeId: 'reference-two',
            blockNodeId: block.nodeId,
            start: 0,
            end: 3,
            sourceBoxes: [
              {
                page: 1,
                x: 0.25,
                y: 0.2,
                width: 0.15,
                height: 0.018,
                rotation: 0,
                method: 'pdf-text',
              },
            ],
          },
        ],
      })

    const forward = resolve(annotations)
    const reversed = resolve([...annotations].reverse())

    for (const resolution of [forward, reversed]) {
      expect(resolution.mappings).toEqual([])
      expect(resolution.approvedAnnotationIds).toEqual(new Set())
      expect(resolution.ledger).toEqual({ expected: 2, mapped: 0 })
      expect(resolution.diagnostics).toEqual([
        expect.objectContaining({
          code: 'UNRESOLVED_HYPERLINK',
          relationshipId: annotations[0].id,
          message: expect.stringMatching(
            /canonical inline owner.*conflicting internal targets/iu,
          ),
        }),
        expect.objectContaining({
          code: 'UNRESOLVED_HYPERLINK',
          relationshipId: annotations[1].id,
          message: expect.stringMatching(
            /canonical inline owner.*conflicting internal targets/iu,
          ),
        }),
      ])
    }
    expect(reversed.mappings).toEqual(forward.mappings)
    expect(reversed.diagnostics).toEqual(forward.diagnostics)
  })

  it('maps three ordered citation labels to three exact annotation-owned targets', async () => {
    const citationText =
      'Although interpretation requires care [62, 63, 48], the evidence remains useful.'
    const citationRun = run(1, citationText, 0.1, 0.24, 0.78)
    const labels = ['62', '63', '48']
    const linked = page(1, [
      run(1, 'Ordered Citation Study', 0.1, 0.08, 0.7, 22),
      run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
      citationRun,
    ])
    linked.links = labels.map((label, index) => {
      const start = citationText.indexOf(label, index === 0 ? 0 : undefined)
      return {
        id: `pdf-link-p001-a${String(index + 1).padStart(4, '0')}`,
        page: 1,
        status: 'internal' as const,
        destination: `cite.${label}`,
        box: sourceSubstringBox(citationRun, start, start + label.length),
      }
    })
    const result = await reconstructPageAnalyses({
      pages: [
        linked,
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[62] First source-backed reference.', 0.1, 0.7, 0.72, 7),
          run(2, '[63] Second source-backed reference.', 0.1, 0.73, 0.72, 7),
          run(2, '[48] Third source-backed reference.', 0.1, 0.76, 0.72, 7),
        ]),
      ],
      sourceHash: 'a'.repeat(64),
      fileName: 'ordered-multi-citation-links.pdf',
      byteLength: 4096,
    })
    const references = new Map(
      result.paper.nodes.flatMap((node) =>
        node.type === 'paragraph' &&
        node.list?.numberingId === 'references' &&
        node.list.ordinal !== undefined
          ? [[String(node.list.ordinal), node.id] as const]
          : [],
      ),
    )
    const relationship = result.citationRelationships.find(
      (candidate) => candidate.labels.join(',') === labels.join(','),
    )
    const annotationRuns = result.paper.nodes
      .flatMap((node) =>
        'inlineRuns' in node
          ? (node.inlineRuns ?? []).flatMap((inline) =>
              inline.annotationId
                ? [{ nodeText: 'text' in node ? node.text : '', inline }]
                : [],
            )
          : [],
      )
      .sort((left, right) => left.inline.start - right.inline.start)

    expect(relationship).toMatchObject({
      status: 'matched',
      targetNodeIds: labels.map((label) => references.get(label)),
      targets: labels.map((label) =>
        expect.objectContaining({
          label,
          targetNodeId: references.get(label),
          referenceStart: expect.any(Number),
          referenceEnd: expect.any(Number),
          sourceBoxes: [expect.objectContaining({ method: 'pdf-text' })],
        }),
      ),
    })
    expect(
      annotationRuns.map(({ nodeText, inline }) => ({
        text: nodeText.slice(inline.start, inline.end),
        href: inline.href,
      })),
    ).toEqual(
      labels.map((label) => ({
        text: label,
        href: `#${references.get(label)}`,
      })),
    )
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 3,
      mappedHyperlinkCount: 3,
      hyperlinkCoverage: 1,
    })
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNRESOLVED_HYPERLINK',
      ),
    ).toEqual([])
  })

  it('preserves exact citation-link ownership when its paragraph continues on the next page', async () => {
    const citationText =
      'Source-backed systems combine distinct inputs [37, 222] before producing a result.'
    const citationRun = run(1, citationText, 0.1, 0.78, 0.78)
    citationRun.sourceSequenceIndex = 4
    const labels = ['37', '222']
    const linked = page(1, [
      {
        ...run(1, 'Cross-page Citation Link Study', 0.1, 0.04, 0.72, 22),
        sourceSequenceIndex: 0,
      },
      {
        ...run(1, '1 Introduction', 0.1, 0.14, 0.3, 16),
        sourceSequenceIndex: 1,
      },
      {
        ...run(
          1,
          'The opening sentence establishes ordinary body typography.',
          0.1,
          0.72,
          0.78,
        ),
        sourceSequenceIndex: 2,
      },
      {
        ...run(
          1,
          'The next sentence provides enough adjacent source flow.',
          0.1,
          0.75,
          0.78,
        ),
        sourceSequenceIndex: 3,
      },
      citationRun,
      { ...run(1, 'This', 0.1, 0.81, 0.78), sourceSequenceIndex: 5 },
    ])
    linked.links = labels.map((label, index) => {
      const start = citationText.indexOf(label)
      return {
        id: `pdf-link-p001-a${String(index + 1).padStart(4, '0')}`,
        page: 1,
        status: 'internal' as const,
        destination: `cite.${label}`,
        box: sourceSubstringBox(citationRun, start, start + label.length),
      }
    })
    const result = await reconstructPageAnalyses({
      pages: [
        linked,
        page(2, [
          {
            ...run(
              2,
              'continuation completes the paragraph with source-proven geometry.',
              0.1,
              0.08,
              0.78,
            ),
            sourceSequenceIndex: 0,
          },
        ]),
        page(3, [
          run(3, 'References', 0.1, 0.1, 0.3, 16),
          run(3, '[37] First source-backed reference.', 0.1, 0.7, 0.72, 7),
          run(3, '[222] Second source-backed reference.', 0.1, 0.73, 0.72, 7),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'cross-page-citation-links.pdf',
      byteLength: 4096,
    })
    const linkedRuns = result.paper.nodes.flatMap((node) =>
      'inlineRuns' in node && 'text' in node
        ? (node.inlineRuns ?? []).flatMap((inline) =>
            inline.annotationId
              ? [
                  {
                    text: node.text.slice(inline.start, inline.end),
                    href: inline.href,
                    ownerText: node.text,
                  },
                ]
              : [],
          )
        : [],
    )

    expect(linkedRuns).toHaveLength(2)
    expect(linkedRuns.map(({ text }) => text)).toEqual(labels)
    expect(
      linkedRuns.every(({ ownerText }) =>
        ownerText.endsWith(
          'This continuation completes the paragraph with source-proven geometry.',
        ),
      ),
    ).toBe(true)
    expect(new Set(linkedRuns.map(({ href }) => href)).size).toBe(2)
    expect(result.sourceSemanticFlowBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topology: 'cross-page-column' }),
      ]),
    )
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 2,
      mappedHyperlinkCount: 2,
      hyperlinkCoverage: 1,
    })
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNRESOLVED_HYPERLINK',
      ),
    ).toEqual([])
  })

  it('does not let adjacent citation annotations steal a neighboring singleton', async () => {
    const citationText =
      'Recent advances [37, 222] differ from the separate baseline [295].'
    const citationRun = run(1, citationText, 0.1, 0.24, 0.78)
    const labels = ['37', '222', '295']
    const linked = page(1, [
      run(1, 'Adjacent Citation Study', 0.1, 0.08, 0.7, 22),
      run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
      citationRun,
    ])
    linked.links = labels.map((label, index) => {
      const start = citationText.indexOf(label)
      return {
        id: `pdf-link-p001-a${String(index + 1).padStart(4, '0')}`,
        page: 1,
        status: 'internal' as const,
        destination: `cite.${label}`,
        box: sourceSubstringBox(citationRun, start, start + label.length),
      }
    })
    const result = await reconstructPageAnalyses({
      pages: [
        linked,
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[37] First source-backed reference.', 0.1, 0.7, 0.72, 7),
          run(2, '[222] Second source-backed reference.', 0.1, 0.73, 0.72, 7),
          run(2, '[295] Separate source-backed reference.', 0.1, 0.76, 0.72, 7),
        ]),
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'adjacent-multi-singleton-citations.pdf',
      byteLength: 4096,
    })
    const linkedTexts = result.paper.nodes.flatMap((node) =>
      'inlineRuns' in node && 'text' in node
        ? (node.inlineRuns ?? []).flatMap((inline) =>
            inline.annotationId
              ? [
                  {
                    text: node.text.slice(inline.start, inline.end),
                    href: inline.href,
                  },
                ]
              : [],
          )
        : [],
    )

    expect(linkedTexts.map(({ text }) => text)).toEqual(['37', '222', '[295]'])
    expect(new Set(linkedTexts.map(({ href }) => href)).size).toBe(3)
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNRESOLVED_HYPERLINK',
      ),
    ).toEqual([])
  })

  it('uses source offsets to distinguish repeated citations to one target', async () => {
    const citationText =
      'Prior work [1] establishes the baseline, while later work [1] confirms it.'
    const citationRun = run(1, citationText, 0.1, 0.24, 0.78)
    const first = citationText.indexOf('[1]')
    const second = citationText.indexOf('[1]', first + 1)
    const linked = page(1, [
      run(1, 'Repeated Citation Study', 0.1, 0.08, 0.7, 22),
      run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
      citationRun,
    ])
    linked.links = [first, second].map((start, index) => ({
      id: `pdf-link-p001-a${String(index + 1).padStart(4, '0')}`,
      page: 1,
      status: 'internal' as const,
      destination: 'cite.1',
      box: sourceSubstringBox(citationRun, start, start + 3),
    }))
    const result = await reconstructPageAnalyses({
      pages: [
        linked,
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[1] Shared source-backed reference.', 0.1, 0.82, 0.72, 7),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'repeated-citation-target.pdf',
      byteLength: 4096,
    })
    const annotationRanges = result.paper.nodes
      .flatMap((node) =>
        'inlineRuns' in node
          ? (node.inlineRuns ?? []).flatMap((inline) =>
              inline.annotationId
                ? [{ start: inline.start, end: inline.end, href: inline.href }]
                : [],
            )
          : [],
      )
      .sort((left, right) => left.start - right.start)

    expect(annotationRanges).toEqual([
      expect.objectContaining({ start: first, end: first + 3 }),
      expect.objectContaining({ start: second, end: second + 3 }),
    ])
    expect(annotationRanges[0].href).toBe(annotationRanges[1].href)
    expect(result.completeness.mappedHyperlinkCount).toBe(2)
  })

  it('maps a bounded shifted link rectangle only to its substantially overlapping citation surface', () => {
    const text = '[190, 228]'
    const { block } = canonicalHyperlinkTestBlock(text)
    const firstStart = text.indexOf('190')
    const secondStart = text.indexOf('228')
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal' as const,
      destination: 'cite.190',
      box: {
        page: 1,
        x: 0.355,
        y: 0.204,
        width: 0.1,
        height: 0.014,
        rotation: 0,
        method: 'pdf-link' as const,
      },
    }
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        {
          kind: 'reference',
          label: 'Reference 190',
          nodeId: 'reference-190',
        },
        {
          kind: 'reference',
          label: 'Reference 228',
          nodeId: 'reference-228',
        },
      ],
      canonicalInternalSurfaces: [
        {
          targetNodeId: 'reference-190',
          blockNodeId: block.nodeId,
          start: firstStart,
          end: firstStart + 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.3,
              y: 0.2,
              width: 0.1,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
        {
          targetNodeId: 'reference-228',
          blockNodeId: block.nodeId,
          start: secondStart,
          end: secondStart + 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.445,
              y: 0.2,
              width: 0.1,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
    })

    expect(resolution.mappings).toEqual([
      {
        annotationId: annotation.id,
        blockNodeId: block.nodeId,
        start: firstStart,
        end: firstStart + 3,
        href: '#reference-190',
      },
    ])
    expect(resolution.diagnostics).toEqual([])
  })

  it.each([
    {
      label: 'tiny edge contact',
      annotationBox: {
        page: 1,
        x: 0.1999,
        y: 0.2,
        width: 0.02,
        height: 0.018,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.14,
              y: 0.2,
              width: 0.06,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text' as const,
            },
          ],
        },
      ],
    },
    {
      label: 'substantial area with insufficient horizontal coverage',
      annotationBox: {
        page: 1,
        x: 0.17,
        y: 0.2,
        width: 0.1,
        height: 0.02,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.1,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text' as const,
            },
          ],
        },
      ],
    },
    {
      label: 'substantial area with insufficient vertical coverage',
      annotationBox: {
        page: 1,
        x: 0.13,
        y: 0.211,
        width: 0.1,
        height: 0.02,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.1,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text' as const,
            },
          ],
        },
      ],
    },
    {
      label: 'axis coverage with insufficient smaller-area overlap',
      annotationBox: {
        page: 1,
        x: 0.16,
        y: 0.209,
        width: 0.1,
        height: 0.02,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.1,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text' as const,
            },
          ],
        },
      ],
    },
    {
      label: 'rotation-mismatched geometry',
      annotationBox: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.1,
        height: 0.02,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.1,
              height: 0.02,
              rotation: 90,
              method: 'pdf-text' as const,
            },
          ],
        },
      ],
    },
    {
      label: 'ambiguous broad ownership',
      annotationBox: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.018,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.08,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text' as const,
            },
          ],
        },
        {
          targetNodeId: 'reference-two',
          blockNodeId: 'internal-link-source-node',
          start: 4,
          end: 7,
          sourceBoxes: [
            {
              page: 1,
              x: 0.22,
              y: 0.2,
              width: 0.08,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text' as const,
            },
          ],
        },
      ],
    },
    {
      label: 'missing source geometry',
      annotationBox: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.08,
        height: 0.018,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [],
        },
      ],
    },
  ])(
    'keeps $label citation ownership unresolved',
    ({ annotationBox, surfaces }) => {
      const { block } = canonicalHyperlinkTestBlock('[1] [2]')
      const annotation = {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal' as const,
        destination: 'cite.1',
        box: annotationBox,
      }
      const resolution = resolveCanonicalHyperlinkObligations({
        blocks: [block],
        annotations: [annotation],
        canonicalTargets: [
          {
            kind: 'reference',
            label: 'Reference 1',
            nodeId: 'reference-one',
          },
          {
            kind: 'reference',
            label: 'Reference 2',
            nodeId: 'reference-two',
          },
        ],
        canonicalInternalSurfaces: surfaces,
      })

      expect(resolution.mappings).toEqual([])
      expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
      expect(resolution.diagnostics).toEqual([
        expect.objectContaining({
          code: 'UNRESOLVED_HYPERLINK',
          message: expect.stringMatching(/no exact canonical inline owner/iu),
        }),
      ])
    },
  )

  it('maps vertically overlapping link rectangles when exact source anchors are on disjoint lines', () => {
    const firstText = 'https://example.test/first'
    const secondText = 'https://example.test/second'
    const firstRun = run(1, firstText, 0.1, 0.2, 0.34)
    const secondRun = run(1, secondText, 0.1, 0.212, 0.35)
    const blockFor = (id: string, text: string, sourceRun: PdfSourceRun) => ({
      type: 'paragraph' as const,
      region: {
        id: `${id}-region`,
        page: 1,
        kind: 'body' as const,
        column: 'single' as const,
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
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: true,
      },
      text,
      confidence: 1,
      nodeId: `${id}-node`,
    })
    const annotations = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external' as const,
        url: firstText,
        box: {
          ...firstRun,
          height: 0.014,
          method: 'pdf-link' as const,
        },
      },
      {
        id: 'pdf-link-p001-a0002',
        page: 1,
        status: 'external' as const,
        url: secondText,
        box: {
          ...secondRun,
          y: 0.211,
          height: 0.014,
          method: 'pdf-link' as const,
        },
      },
    ]

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [
        blockFor('first', firstText, firstRun),
        blockFor('second', secondText, secondRun),
      ],
      annotations,
    })

    expect(resolution.diagnostics).toEqual([])
    expect(resolution.mappings).toEqual([
      {
        annotationId: annotations[0].id,
        blockNodeId: 'first-node',
        start: 0,
        end: firstText.length,
        href: firstText,
      },
      {
        annotationId: annotations[1].id,
        blockNodeId: 'second-node',
        start: 0,
        end: secondText.length,
        href: secondText,
      },
    ])
    expect(resolution.approvedAnnotationIds).toEqual(
      new Set(annotations.map((annotation) => annotation.id)),
    )
    expect(resolution.ledger).toEqual({ expected: 2, mapped: 2 })
  })

  it('fails overlapping external annotations closed instead of choosing one target', async () => {
    const linked = page(1, [
      run(1, 'Ambiguous linked text remains readable.', 0.1, 0.2, 0.7),
    ])
    const sourceBox = {
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.018,
      rotation: 0,
      method: 'pdf-link' as const,
    }
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external',
        url: 'https://example.test/one',
        box: sourceBox,
      },
      {
        id: 'pdf-link-p001-a0002',
        page: 1,
        status: 'external',
        url: 'https://example.test/two',
        box: sourceBox,
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '4'.repeat(64),
      fileName: 'synthetic-overlapping-links.pdf',
      byteLength: 2048,
    })
    const textNode = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Ambiguous linked text'),
    )

    expect(
      textNode && 'inlineRuns' in textNode
        ? textNode.inlineRuns?.filter((run) => run.href)
        : [],
    ).toEqual([])
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNRESOLVED_HYPERLINK',
      ),
    ).toHaveLength(2)
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 2,
      mappedHyperlinkCount: 0,
      hyperlinkCoverage: 0,
    })
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

  it('removes a float-interrupted discretionary hyphen only with lexical and language proof', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        withExplicitEnglishLanguage(
          sourceOrderedPage(1, [
            run(1, 'Float-interrupted lexical prose', 0.12, 0.06, 0.68, 18),
            run(1, '1 Introduction', 0.12, 0.18, 0.3, 14),
            run(
              1,
              'Additionally, a separate sentence proves the unhyphenated token.',
              0.12,
              0.28,
              0.68,
            ),
            run(1, 'We observed frequent hallucination. ', 0.12, 0.82, 0.4),
            {
              ...run(1, 'Addition', 0.54, 0.82, 0.09),
              fontName: 'ABCDEF+NimbusRomNo9L-Medi',
            },
            {
              ...run(1, '-', 0.629, 0.82, 0.008),
              fontName: 'ABCDEF+NimbusRomNo9L-Medi',
            },
          ]),
        ),
        sourceOrderedPage(2, [
          run(2, 'Method', 0.12, 0.08, 0.12, 8),
          run(2, 'Score', 0.45, 0.08, 0.1, 8),
          run(2, 'DRAFT', 0.12, 0.105, 0.12, 8),
          run(2, '50.3', 0.45, 0.105, 0.1, 8),
          run(2, 'RE3', 0.12, 0.13, 0.12, 8),
          run(2, '59.7', 0.45, 0.13, 0.1, 8),
          run(2, 'Table 8: A source-authored prompt.', 0.12, 0.17, 0.68, 8),
          run(
            2,
            'ally, we filter out low-confidence attributes.',
            0.12,
            0.25,
            0.68,
          ),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'owned-float-discretionary-hyphen.pdf',
      byteLength: 4096,
      metadata: { title: 'Float-interrupted lexical prose' },
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
        node.text.startsWith('We observed frequent hallucination.'),
    )

    expect(joined).toMatchObject({
      text: 'We observed frequent hallucination. Additionally, we filter out low-confidence attributes.',
    })
    expect(result.provenance[joined!.id]).toMatchObject({
      pages: [1, 2],
      regionIds: expect.arrayContaining([
        expect.stringContaining('page-001-region-'),
        expect.stringContaining('page-002-region-'),
      ]),
    })
    expect(result.completeness.inlineSpanCoverage).toBe(1)
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 1,
      mappedInlineSpanCount: 1,
    })
    expect(result.sourceSemanticFlowBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topology: 'cross-page-column',
          outcome: 'discretionary-hyphen-delete',
        }),
      ]),
    )
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'CANONICAL_FLOW_ORDER_VIOLATION',
      ),
    ).toBe(false)
    expect(result.canonicalHyphenBoundaryDecisions).toEqual([
      expect.objectContaining({
        context: 'canonical-flow-continuation',
        outcome: 'removed-discretionary-hyphen',
        geometry: {
          from: expect.objectContaining({ page: 1, y: 0.82 }),
          to: expect.objectContaining({ page: 2, y: 0.25 }),
        },
        proof: expect.objectContaining({
          sourceBoundaryProven: true,
          pinnedWord: 'Additionally',
          pinnedJoinedFormValid: true,
          pinnedSplit: {
            left: 'Addition',
            right: 'ally',
            index: 8,
          },
          splitPointValid: true,
          exactSameDocumentJoinedForm: 'Additionally',
          sameDocumentJoinedFormValid: true,
          hardHyphenCounterproof: null,
          evidence: expect.arrayContaining([
            'same-document-unhyphenated-word',
            'hard-hyphen-form-not-proved',
          ]),
        }),
      }),
    ])
  })

  it('does not jump lowercase prose across an unowned caption-shaped interruption', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Unowned interruption', 0.12, 0.06, 0.68, 18),
          run(
            1,
            'Additionally, this line proves the complete token.',
            0.12,
            0.28,
            0.68,
          ),
          run(1, 'A sentence ends with Addition-', 0.12, 0.82, 0.68),
        ]),
        page(2, [
          run(
            2,
            'Table 8: No bounded source scope exists for this caption.',
            0.12,
            0.17,
            0.68,
            8,
          ),
          run(
            2,
            'ally, this is a separate source paragraph.',
            0.12,
            0.25,
            0.68,
          ),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'unowned-float-continuation.pdf',
      byteLength: 4096,
      metadata: { title: 'Unowned interruption' },
    })
    const paragraphs = result.paper.nodes.filter(
      (node) => node.type === 'paragraph',
    )

    expect(
      paragraphs.some((node) => node.text.includes('Addition- ally')),
    ).toBe(false)
    expect(paragraphs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'A sentence ends with Addition-' }),
        expect.objectContaining({
          text: 'ally, this is a separate source paragraph.',
        }),
      ]),
    )
  })

  it('joins a source-contiguous numeric continuation after an incomplete prose boundary', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Numeric prose continuity', 0.1, 0.04, 0.8, 18),
          run(1, '1 Introduction', 0.1, 0.14, 0.3, 14),
          run(
            1,
            'We evaluated the system on a challenge set of',
            0.1,
            0.28,
            0.39,
          ),
          run(
            1,
            '178 enterprise bugs and recorded the outcomes.',
            0.1,
            0.315,
            0.39,
          ),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'numeric-prose-continuation.pdf',
      byteLength: 4096,
      metadata: { title: 'Numeric prose continuity' },
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('We evaluated the system'),
    )

    expect(joined).toMatchObject({
      text: 'We evaluated the system on a challenge set of 178 enterprise bugs and recorded the outcomes.',
    })
  })

  it('fails closed on a lowercase hyphen continuation without source-boundary proof', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Unproved hyphen continuity', 0.12, 0.06, 0.68, 18),
          run(1, '1 Introduction', 0.12, 0.18, 0.3, 14),
          run(1, 'This paragraph contains an unproved frag-', 0.12, 0.4, 0.68),
        ]),
        page(2, [
          run(2, 'ment that begins a separate source block.', 0.12, 0.08, 0.68),
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'unproved-hyphen-continuation.pdf',
      byteLength: 4096,
      metadata: { title: 'Unproved hyphen continuity' },
    })
    const paragraphs = result.paper.nodes.filter(
      (node) => node.type === 'paragraph',
    )

    expect(paragraphs.some((node) => node.text.includes('frag- ment'))).toBe(
      false,
    )
    expect(paragraphs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'This paragraph contains an unproved frag-',
        }),
        expect.objectContaining({
          text: 'ment that begins a separate source block.',
        }),
      ]),
    )
    expect(result.canonicalHyphenBoundaryDecisions).toEqual([])
  })

  it('fails closed when source geometry exists but the hyphen form is unresolved', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Unresolved hyphen continuity', 0.12, 0.06, 0.68, 18),
          run(1, '1 Introduction', 0.12, 0.18, 0.3, 14),
          run(
            1,
            'Opening prose establishes the document body.',
            0.12,
            0.28,
            0.68,
          ),
          run(1, 'The source ends with an unresolved frag-', 0.12, 0.82, 0.68),
        ]),
        page(2, [
          run(2, 'ment that has no same-document proof.', 0.12, 0.08, 0.68),
        ]),
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'unresolved-hyphen-continuation.pdf',
      byteLength: 4096,
      metadata: { title: 'Unresolved hyphen continuity' },
    })
    const paragraphs = result.paper.nodes.filter(
      (node) => node.type === 'paragraph',
    )

    expect(paragraphs.some((node) => node.text.includes('frag-ment'))).toBe(
      false,
    )
    expect(paragraphs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'The source ends with an unresolved frag-',
        }),
        expect.objectContaining({
          text: 'ment that has no same-document proof.',
        }),
      ]),
    )
    expect(result.canonicalHyphenBoundaryDecisions).toEqual([])
  })

  it('preserves a source-proven hard hyphen without inventing cross-page whitespace', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        sourceOrderedPage(1, [
          run(1, 'Hard-hyphen continuity', 0.12, 0.06, 0.68, 18),
          run(
            1,
            'A long-form baseline proves the source-authored compound.',
            0.12,
            0.28,
            0.68,
          ),
          run(1, 'The source uses long-', 0.12, 0.82, 0.68),
        ]),
        sourceOrderedPage(2, [
          run(2, 'form examples throughout the evaluation.', 0.12, 0.08, 0.68),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'hard-hyphen-cross-page-continuation.pdf',
      byteLength: 4096,
      metadata: { title: 'Hard-hyphen continuity' },
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('The source uses long'),
    )

    expect(joined).toMatchObject({
      text: 'The source uses long-form examples throughout the evaluation.',
    })
    expect(result.provenance[joined!.id]).toMatchObject({
      pages: [1, 2],
    })
    expect(result.canonicalHyphenBoundaryDecisions).toEqual([])
    expect(result.sourceSemanticFlowBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topology: 'cross-page-column',
          outcome: 'hard-hyphen-retain',
        }),
      ]),
    )
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'CANONICAL_FLOW_ORDER_VIOLATION',
      ),
    ).toBe(false)
  })

  it('removes a source-proven wrap hyphen across adjacent same-page columns', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        withExplicitEnglishLanguage(
          page(1, [
            run(1, 'Column-boundary continuity', 0.1, 0.035, 0.8, 18),
            run(1, '1 Introduction', 0.09, 0.12, 0.3, 14),
            run(
              1,
              'A separate sentence proves interpretation as a complete token.',
              0.09,
              0.2,
              0.385,
            ),
            run(
              1,
              'Left-column body establishes the source reading geometry.',
              0.09,
              0.23,
              0.385,
            ),
            run(
              1,
              'A second left-column row confirms the stable gutter.',
              0.09,
              0.26,
              0.385,
            ),
            run(
              1,
              'A third left-column row completes the layout evidence.',
              0.09,
              0.29,
              0.385,
            ),
            run(
              1,
              'The final left-column sentence continues with inter-',
              0.09,
              0.8537,
              0.385,
            ),
            run(
              1,
              'pretation across the adjacent column boundary.',
              0.502,
              0.0847,
              0.385,
            ),
            run(
              1,
              'Right-column body continues after the repaired token.',
              0.502,
              0.1147,
              0.385,
            ),
            run(
              1,
              'A final right-column sentence closes the section.',
              0.502,
              0.1447,
              0.385,
            ),
            run(
              1,
              'An aligned right-column row confirms the stable gutter.',
              0.502,
              0.2,
              0.385,
            ),
            run(
              1,
              'Another right-column row keeps the source flow explicit.',
              0.502,
              0.23,
              0.385,
            ),
            run(
              1,
              'The last aligned right-column row completes the evidence.',
              0.502,
              0.26,
              0.385,
            ),
          ]),
        ),
      ],
      sourceHash: 'f'.repeat(64),
      fileName: 'same-page-column-wrap-hyphen.pdf',
      byteLength: 4096,
      metadata: { title: 'Column-boundary continuity' },
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.includes('final left-column sentence'),
    )
    expect(joined?.type).toBe('paragraph')
    if (!joined || joined.type !== 'paragraph') {
      throw new Error('Expected the source-proven column continuation.')
    }
    expect(joined).toMatchObject({
      text: expect.stringContaining(
        'continues with interpretation across the adjacent column boundary.',
      ),
    })
    expect(joined.text).not.toContain('inter- pretation')
    expect(result.provenance[joined.id]).toMatchObject({
      pages: [1],
      regionIds: expect.arrayContaining([
        expect.stringContaining('page-001-region-'),
      ]),
    })
  })

  it('repairs a left-to-right wrap hyphen when the proved continuation begins midway down the right column', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        withExplicitEnglishLanguage(
          page(1, [
            run(1, 'Mid-column continuity', 0.1, 0.035, 0.8, 18),
            run(1, '1 Introduction', 0.09, 0.12, 0.3, 14),
            run(
              1,
              'A complete operation proves the unhyphenated token.',
              0.09,
              0.2,
              0.385,
            ),
            run(
              1,
              'The left column establishes stable source geometry.',
              0.09,
              0.28,
              0.385,
            ),
            run(
              1,
              'Another left row keeps the source lane explicit.',
              0.09,
              0.36,
              0.385,
            ),
            run(
              1,
              'Aligned left prose begins below the upper-page content.',
              0.09,
              0.52,
              0.385,
            ),
            run(
              1,
              'A second aligned left row confirms the gutter.',
              0.09,
              0.58,
              0.385,
            ),
            run(
              1,
              'A third aligned left row completes the proof.',
              0.09,
              0.64,
              0.385,
            ),
            run(
              1,
              'The final left-column sentence completes the oper-',
              0.09,
              0.82,
              0.385,
            ),
            run(
              1,
              'ation before the right-column discussion continues.',
              0.515,
              0.52,
              0.385,
            ),
            run(
              1,
              'A second aligned right row confirms the gutter.',
              0.515,
              0.58,
              0.385,
            ),
            run(
              1,
              'A third aligned right row completes the proof.',
              0.515,
              0.64,
              0.385,
            ),
          ]),
        ),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'same-page-mid-column-wrap-hyphen.pdf',
      byteLength: 4096,
      metadata: { title: 'Mid-column continuity' },
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.includes('final left-column sentence'),
    )

    expect(joined).toMatchObject({
      text: expect.stringContaining(
        'completes the operation before the right-column discussion continues.',
      ),
    })
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'CANONICAL_FLOW_ORDER_VIOLATION',
      ),
    ).toBe(false)
  })

  it('does not absorb an unattested small-font block from deep in the right column', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Mid-column fail-closed continuity', 0.1, 0.035, 0.8, 18),
          run(1, '1 Introduction', 0.09, 0.12, 0.3, 14),
          run(
            1,
            'The left column establishes stable source geometry.',
            0.09,
            0.28,
            0.385,
          ),
          run(
            1,
            'Another left row keeps the source lane explicit.',
            0.09,
            0.36,
            0.385,
          ),
          run(
            1,
            'Aligned left prose begins below the upper-page content.',
            0.09,
            0.52,
            0.385,
          ),
          run(
            1,
            'A second aligned left row confirms the gutter.',
            0.09,
            0.58,
            0.385,
          ),
          run(
            1,
            'A third aligned left row completes the proof.',
            0.09,
            0.64,
            0.385,
          ),
          run(
            1,
            'The final left-column sentence ends with an unattested oper-',
            0.09,
            0.82,
            0.385,
          ),
          run(
            1,
            'ation belongs to a small unrelated annotation.',
            0.515,
            0.52,
            0.385,
            7,
          ),
          run(
            1,
            'A second aligned right row confirms the gutter.',
            0.515,
            0.58,
            0.385,
          ),
          run(
            1,
            'A third aligned right row completes the proof.',
            0.515,
            0.64,
            0.385,
          ),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'same-page-mid-column-unattested-hyphen.pdf',
      byteLength: 4096,
      metadata: { title: 'Mid-column fail-closed continuity' },
    })
    const canonicalText = result.paper.nodes
      .flatMap((node) => ('text' in node ? [node.text] : []))
      .join('\n')

    expect(canonicalText).not.toContain(
      'unattested operation belongs to a small unrelated annotation',
    )
    expect(canonicalText).toContain('unattested oper-')
    expect(
      result.regions.some((region) =>
        region.text.includes('ation belongs to a small unrelated annotation.'),
      ),
    ).toBe(true)
  })

  it('joins one paragraph across an owned figure at an adjacent-column boundary', async () => {
    const sourcePage = page(1, [
      run(1, 'Adjacent-column figure continuity', 0.1, 0.035, 0.8, 18),
      run(1, '1 Introduction', 0.09, 0.12, 0.3, 14),
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
        'Lower left-column prose keeps the first source lane active.',
        0.09,
        0.64,
        0.385,
      ),
      run(
        1,
        'Another lower left-column row preserves the stable gutter.',
        0.09,
        0.68,
        0.385,
      ),
      run(
        1,
        'The lower left-column discussion continues toward its boundary.',
        0.09,
        0.72,
        0.385,
      ),
      run(
        1,
        'A final lower left-column row retains the proved source flow.',
        0.09,
        0.76,
        0.385,
      ),
      run(
        1,
        'The method scales to longer samples with further',
        0.09,
        0.84,
        0.385,
      ),
      run(1, 'Input', 0.58, 0.2, 0.12, 8),
      run(1, 'Transform', 0.58, 0.24, 0.12, 8),
      run(1, 'Output', 0.58, 0.28, 0.12, 8),
      run(
        1,
        'Figure 12: Source-backed scaling overview.',
        0.515,
        0.61,
        0.385,
        8,
      ),
      run(
        1,
        'length increases limited only by evaluation.',
        0.515,
        0.67,
        0.385,
      ),
      run(
        1,
        'Right-column context continues after the repaired sentence.',
        0.515,
        0.72,
        0.385,
      ),
      run(
        1,
        'A second right-column row confirms the stable gutter.',
        0.515,
        0.76,
        0.385,
      ),
      run(
        1,
        'A third right-column row completes the layout evidence.',
        0.515,
        0.8,
        0.385,
      ),
    ])
    sourcePage.imageCount = 1
    sourcePage.objects = [
      {
        id: 'adjacent-column-figure-object',
        page: 1,
        kind: 'image',
        box: {
          page: 1,
          x: 0.54,
          y: 0.18,
          width: 0.33,
          height: 0.39,
          rotation: 0,
          method: 'pdf-object',
        },
        confidence: 1,
        assetId: null,
        role: 'semantic',
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: '6'.repeat(64),
      fileName: 'adjacent-column-owned-figure.pdf',
      byteLength: 4096,
      metadata: { title: 'Adjacent-column figure continuity' },
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
      (relationship) => relationship.label === 'Figure 12',
    )
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.includes('The method scales to longer samples'),
    )
    expect(visual).toMatchObject({
      status: 'matched',
      canonicalNodeId: expect.any(String),
    })
    expect(joined).toMatchObject({
      text: expect.stringContaining(
        'The method scales to longer samples with further length increases limited only by evaluation.',
      ),
    })
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' && node.text.startsWith('length increases'),
      ),
    ).toEqual([])
    expect(
      result.paper.nodes.findIndex((node) => node.id === joined?.id),
    ).toBeLessThan(
      result.paper.nodes.findIndex(
        (node) => node.id === visual?.canonicalNodeId,
      ),
    )
  })

  it('does not let an owned vertical float split two source-backed halves of one prose sentence', async () => {
    const sourcePage = page(1, [
      run(1, 'Vertical float sentence continuity', 0.1, 0.035, 0.8, 18),
      run(1, '1 Source-backed section', 0.12, 0.12, 0.4, 14),
      run(
        1,
        'Ordinary prose establishes the body typography.',
        0.12,
        0.19,
        0.68,
      ),
      run(1, 'The source-backed sentence continues with', 0.12, 0.25, 0.68),
      run(1, 'Figure 9: A bounded source-backed process.', 0.12, 0.57, 0.68, 8),
      run(1, 'a deterministic conclusion after the float.', 0.12, 0.63, 0.68),
      run(
        1,
        'A separate sentence follows the completed thought.',
        0.12,
        0.69,
        0.68,
      ),
    ])
    sourcePage.imageCount = 1
    sourcePage.objects = [
      {
        id: 'vertical-float-object',
        page: 1,
        kind: 'image',
        box: {
          page: 1,
          x: 0.18,
          y: 0.3,
          width: 0.64,
          height: 0.23,
          rotation: 0,
          method: 'pdf-object',
        },
        confidence: 1,
        assetId: null,
        role: 'semantic',
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: '1'.repeat(64),
      fileName: 'vertical-owned-float-sentence.pdf',
      byteLength: 4096,
      metadata: { title: 'Vertical float sentence continuity' },
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
      (relationship) => relationship.label === 'Figure 9',
    )
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('The source-backed sentence'),
    )

    expect(visual).toMatchObject({
      status: 'matched',
      canonicalNodeId: expect.any(String),
    })
    expect(joined).toMatchObject({
      text: 'The source-backed sentence continues with a deterministic conclusion after the float.',
    })
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' &&
          node.text.startsWith('a deterministic conclusion'),
      ),
    ).toEqual([])
  })

  it('joins one paragraph across an owned page-tail table before the next page', async () => {
    const firstPage = sourceOrderedPage(1, [
      run(1, 'Page-tail table continuity', 0.1, 0.035, 0.8, 18),
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
        0.24,
        0.385,
      ),
      run(
        1,
        'A third left-column row completes the layout evidence.',
        0.09,
        0.28,
        0.385,
      ),
      run(
        1,
        'Right-column context establishes the second source lane.',
        0.515,
        0.2,
        0.385,
      ),
      run(
        1,
        'A second right-column row confirms the stable gutter.',
        0.515,
        0.24,
        0.385,
      ),
      run(
        1,
        'A third right-column row completes the layout evidence.',
        0.515,
        0.28,
        0.385,
      ),
      run(1, 'The comparison proceeds according', 0.515, 0.69, 0.385),
      run(1, 'Method', 0.535, 0.75, 0.13, 8),
      run(1, 'Score', 0.75, 0.75, 0.1, 8),
      run(1, 'BASE', 0.535, 0.775, 0.13, 8),
      run(1, '40.0', 0.75, 0.775, 0.1, 8),
      run(1, 'SYSTEM', 0.535, 0.8, 0.13, 8),
      run(1, '60.0', 0.75, 0.8, 0.1, 8),
      run(
        1,
        'Table 6: Source-backed comparison scores.',
        0.515,
        0.845,
        0.385,
        8,
      ),
    ])
    const result = await reconstructPageAnalyses({
      pages: [
        firstPage,
        sourceOrderedPage(2, [
          run(
            2,
            'to the standard metric used for classification.',
            0.09,
            0.08,
            0.385,
          ),
        ]),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'page-tail-owned-table.pdf',
      byteLength: 4096,
      metadata: { title: 'Page-tail table continuity' },
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
      (relationship) => relationship.label === 'Table 6',
    )
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('The comparison proceeds according'),
    )

    expect(visual).toMatchObject({
      status: 'matched',
      canonicalNodeId: expect.any(String),
    })
    expect(joined).toMatchObject({
      text: 'The comparison proceeds according to the standard metric used for classification.',
    })
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' && node.text.startsWith('to the standard'),
      ),
    ).toEqual([])
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
        (node) => node.id === visual?.canonicalNodeId,
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
