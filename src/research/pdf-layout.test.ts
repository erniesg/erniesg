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
  it('does not turn a parenthesized citation year into a numbered list', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Zhou et al.', 0.1, 0.3, 0.7),
          run(
            1,
            '(2024) analyze a fine-tuned model and report results.',
            0.1,
            0.34,
            0.7,
          ),
        ]),
      ],
      sourceHash: 'f'.repeat(64),
      fileName: 'citation-year.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.filter(
        (node) => node.type === 'paragraph' && node.list,
      ),
    ).toEqual([])
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph')
        .map((node) => node.text)
        .join(' '),
    ).toContain('(2024) analyze a fine-tuned model')
  })

  it('retains a typographic section heading phrased as a question', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Introductory prose line one', 0.1, 0.24, 0.7),
          run(1, 'continues on line two', 0.1, 0.27, 0.7),
          run(1, 'and continues on line three', 0.1, 0.3, 0.7),
          run(1, 'before ending on line four.', 0.1, 0.33, 0.7),
          run(1, 'E. Why Use This Algorithm at All?', 0.1, 0.4, 0.5, 16),
          run(1, 'The appendix answer remains prose.', 0.1, 0.48, 0.7),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'question-heading.pdf',
      byteLength: 4096,
    })

    expect(result.paper.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'heading',
          text: 'E. Why Use This Algorithm at All?',
        }),
      ]),
    )
  })

  it('preserves medium-face lettered appendix hierarchy without a terminal dot', async () => {
    const appendixHeading = {
      ...run(2, 'A Datasets Details', 0.1, 0.1, 0.35, 11),
      fontName: 'NimbusRomNo9L-Medi',
    }
    const appendixSubheading = {
      ...run(2, 'B.1 Prompt Details', 0.1, 0.46, 0.32, 11),
      fontName: 'NimbusRomNo9L-Medi',
    }
    const secondAppendixHeading = {
      ...run(2, 'B Prompt Details', 0.1, 0.32, 0.32, 11),
      fontName: 'NimbusRomNo9L-Medi',
    }
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Introductory body establishes the prose size.',
            0.1,
            0.3,
            0.7,
          ),
        ]),
        page(2, [
          appendixHeading,
          run(2, 'Appendix body remains ordinary prose.', 0.1, 0.18, 0.7),
          secondAppendixHeading,
          appendixSubheading,
          run(2, 'Nested appendix prose remains ordinary.', 0.1, 0.56, 0.7),
        ]),
      ],
      sourceHash: 'j'.repeat(64),
      fileName: 'lettered-appendix.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' &&
        [
          'A Datasets Details',
          'B Prompt Details',
          'B.1 Prompt Details',
        ].includes(node.text)
          ? [{ text: node.text, level: node.level }]
          : [],
      ),
    ).toEqual([
      { text: 'A Datasets Details', level: 1 },
      { text: 'B Prompt Details', level: 1 },
      { text: 'B.1 Prompt Details', level: 2 },
    ])
  })

  it('keeps sequenced split appendix headings out of digit-normalized running furniture', async () => {
    const medium = (
      pageNumber: number,
      text: string,
      x: number,
      y: number,
      width: number,
      fontSize = 11,
    ) => ({
      ...run(pageNumber, text, x, y, width, fontSize),
      fontName: 'SyntheticSerif-Medi',
    })
    const runningHeader = (pageNumber: number) =>
      run(pageNumber, 'Proceedings of Synthetic Studies', 0.12, 0.02, 0.42, 8)
    const childPage = (pageNumber: number, ordinal: number) =>
      page(pageNumber, [
        runningHeader(pageNumber),
        medium(pageNumber, `Q.${ordinal}`, 0.12, 0.084, 0.025),
        medium(pageNumber, `Cases for Scenario ${ordinal}`, 0.16, 0.084, 0.185),
        run(
          pageNumber,
          `Canonical appendix prose for scenario ${ordinal}.`,
          0.12,
          0.15,
          0.72,
          9,
        ),
      ])
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Synthetic hierarchy study', 0.16, 0.07, 0.68, 20),
          run(1, 'Abstract', 0.12, 0.18, 0.24, 14),
          run(
            1,
            'The abstract establishes source-backed publication structure.',
            0.12,
            0.24,
            0.72,
            9,
          ),
          medium(1, '1 Introduction', 0.12, 0.34, 0.28, 12),
          run(
            1,
            'See Appendix Q.2 for the selected scenario.',
            0.12,
            0.4,
            0.72,
            9,
          ),
        ]),
        page(2, [
          runningHeader(2),
          medium(2, 'Q Example Collections', 0.12, 0.18, 0.34, 12),
          run(
            2,
            'The appendix parent introduces the sequenced examples.',
            0.12,
            0.24,
            0.72,
            9,
          ),
        ]),
        childPage(3, 1),
        childPage(4, 2),
        childPage(5, 3),
      ],
      sourceHash: 'a'.repeat(64),
      fileName: 'split-repeated-appendix-headings.pdf',
      byteLength: 4096,
    })

    const appendixParent = result.paper.nodes.find(
      (node) =>
        node.type === 'heading' && node.text === 'Q Example Collections',
    )
    const appendixChildren = result.paper.nodes.flatMap((node) =>
      node.type === 'heading' && /^Q\.\d+\s/u.test(node.text) ? [node] : [],
    )
    expect(appendixParent).toMatchObject({ type: 'heading', level: 1 })
    expect(
      appendixChildren.map((node) => ({
        text: node.text,
        level: node.level,
        sourceBoxCount: result.provenance[node.id].boxes.length,
        sourceRuns: result.regions
          .filter((region) =>
            result.provenance[node.id].regionIds.includes(region.id),
          )
          .flatMap((region) =>
            region.lines.flatMap((line) => line.runs.map((run) => run.text)),
          ),
      })),
    ).toEqual([
      {
        text: 'Q.1 Cases for Scenario 1',
        level: 2,
        sourceBoxCount: 2,
        sourceRuns: ['Q.1', 'Cases for Scenario 1'],
      },
      {
        text: 'Q.2 Cases for Scenario 2',
        level: 2,
        sourceBoxCount: 2,
        sourceRuns: ['Q.2', 'Cases for Scenario 2'],
      },
      {
        text: 'Q.3 Cases for Scenario 3',
        level: 2,
        sourceBoxCount: 2,
        sourceRuns: ['Q.3', 'Cases for Scenario 3'],
      },
    ])
    expect(
      result.paper.nodes.filter(
        (node) =>
          'text' in node &&
          (/^Q\.\d+$/u.test(node.text) ||
            /^Cases for Scenario \d+$/u.test(node.text)),
      ),
    ).toEqual([])
    expect(
      result.regions
        .filter((region) => region.text === 'Proceedings of Synthetic Studies')
        .every(
          (region) =>
            region.kind === 'header' && region.includedInReadingOrder === false,
        ),
    ).toBe(true)
    expect(
      result.paper.nodes.some(
        (node) =>
          'text' in node &&
          node.text.includes('Proceedings of Synthetic Studies'),
      ),
    ).toBe(false)
    expect(
      result.crossReferenceRelationships.find(
        (relationship) => relationship.text === 'Appendix Q.2',
      ),
    ).toMatchObject({
      status: 'matched',
      targetNodeIds: [appendixChildren[1]?.id],
    })

    const epub = await buildReadableEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const navigation = strFromU8(files['EPUB/nav.xhtml'])
    expect(navigation).toMatch(
      /Q Example Collections<\/a><ol><li><a[^>]+>Q\.1 Cases for Scenario 1<\/a><\/li><li><a[^>]+>Q\.2 Cases for Scenario 2<\/a><\/li><li><a[^>]+>Q\.3 Cases for Scenario 3<\/a><\/li><\/ol><\/li>/u,
    )
  })

  it('recognizes a styled plain-letter appendix parent from its direct child', async () => {
    const medium = (text: string, y: number, width = 0.36) => ({
      ...run(2, text, 0.1, y, width, 10),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Direct appendix hierarchy', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Opening context establishes typography; see Appendix A for discussion.',
            0.1,
            0.3,
            0.72,
          ),
        ]),
        page(2, [
          medium('A Discussion', 0.1),
          run(2, 'Appendix overview remains ordinary prose.', 0.1, 0.16, 0.7),
          medium('A.1 Limitation', 0.24),
          run(2, 'The limitation remains ordinary prose.', 0.1, 0.3, 0.7),
        ]),
      ],
      sourceHash: 'q'.repeat(64),
      fileName: 'direct-lettered-parent.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^A(?:\s|\.)/u.test(node.text)
          ? [{ text: node.text, level: node.level }]
          : [],
      ),
    ).toEqual([
      { text: 'A Discussion', level: 1 },
      { text: 'A.1 Limitation', level: 2 },
    ])
    expect(result.crossReferenceRelationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Appendix A',
          status: 'matched',
          targetNodeIds: [expect.any(String)],
        }),
      ]),
    )
  })

  it('does not promote appendix-contents entries into the canonical heading hierarchy', async () => {
    const contentsHeading = (pageNumber: number, text: string, y: number) => ({
      ...run(pageNumber, text, 0.1, y, 0.58, 10),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const appendixContentsPage = page(2, [
      run(2, 'Appendix', 0.1, 0.1, 0.35, 12),
      contentsHeading(2, 'A Direction extraction pipeline', 0.18),
      run(2, '23', 0.82, 0.18, 0.025),
      run(2, 'A.1 Prompts . . . . . . . . . . . . . . . . 23', 0.14, 0.22, 0.7),
      contentsHeading(2, 'B LLM-based trait expression score', 0.28),
      run(2, '28', 0.82, 0.28, 0.025),
      run(
        2,
        'B.1 Evaluation scoring details . . . . . . . . . . 28',
        0.14,
        0.32,
        0.7,
      ),
    ])
    appendixContentsPage.links = [
      {
        id: 'pdf-link-p002-a0001',
        page: 2,
        status: 'internal',
        destination: 'appendix.A',
        box: {
          page: 2,
          x: 0.1,
          y: 0.18,
          width: 0.58,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Introductory body establishes the prose size.',
            0.1,
            0.3,
            0.7,
          ),
        ]),
        appendixContentsPage,
        page(3, [
          run(
            3,
            'J.2 Comparison with prompting . . . . . . . . . . 45',
            0.14,
            0.1,
            0.7,
          ),
          contentsHeading(3, 'K Sample-wise filtering', 0.18),
          run(3, '53', 0.82, 0.18, 0.025),
          contentsHeading(
            3,
            'M Decomposing persona vectors using sparse autoencoders',
            0.28,
          ),
          run(3, '59', 0.82, 0.28, 0.025),
          run(
            3,
            'M.1 SAE training details . . . . . . . . . . . . 59',
            0.14,
            0.32,
            0.7,
          ),
        ]),
        page(4, [
          run(4, 'A Direction extraction pipeline', 0.1, 0.12, 0.58, 14),
          run(
            4,
            'The actual appendix section remains canonical prose.',
            0.1,
            0.18,
            0.7,
          ),
          run(4, 'A.1 Prompts', 0.1, 0.28, 0.3, 12),
          run(
            4,
            'The actual appendix subsection also remains canonical prose.',
            0.1,
            0.34,
            0.7,
          ),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'appendix-contents.pdf',
      byteLength: 4096,
    })

    const contentsEntries = new Set([
      'A Direction extraction pipeline',
      'B LLM-based trait expression score',
      'K Sample-wise filtering',
      'M Decomposing persona vectors using sparse autoencoders',
    ])
    const contentsEntryNodes = result.paper.nodes.filter(
      (node) =>
        'text' in node &&
        contentsEntries.has(node.text) &&
        result.provenance[node.id].pages.some((pageNumber) =>
          [2, 3].includes(pageNumber),
        ),
    )
    expect(
      contentsEntryNodes.flatMap((node) =>
        node.type === 'heading' ? [node.text] : [],
      ),
    ).toEqual([])
    expect(contentsEntryNodes).toHaveLength(contentsEntries.size)

    const actualAppendixHeading = result.paper.nodes.find(
      (node) =>
        node.type === 'heading' &&
        node.text === 'A Direction extraction pipeline' &&
        result.provenance[node.id].pages.includes(4),
    )
    const linkedContentsEntry = contentsEntryNodes.find(
      (node) =>
        'text' in node && node.text === 'A Direction extraction pipeline',
    )
    expect(actualAppendixHeading).toBeDefined()
    expect(
      linkedContentsEntry && 'inlineRuns' in linkedContentsEntry
        ? linkedContentsEntry.inlineRuns?.filter(
            (inlineRun) => inlineRun.annotationId === 'pdf-link-p002-a0001',
          )
        : [],
    ).toEqual([
      expect.objectContaining({ href: `#${actualAppendixHeading!.id}` }),
    ])
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 1,
      hyperlinkCoverage: 1,
    })

    const epub = await buildReadableEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const navigation = strFromU8(files['EPUB/nav.xhtml'])
    expect(navigation.match(/A Direction extraction pipeline/gu)).toHaveLength(
      1,
    )
  })

  it('does not treat a plain Appendix title as a contents page without contents geometry', async () => {
    const sourceHeading = (text: string, y: number, width: number) => ({
      ...run(2, text, 0.1, y, width, 12),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
          run(1, 'Ada Example', 0.36, 0.14, 0.28, 11),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Introductory body establishes the prose size.',
            0.1,
            0.3,
            0.7,
          ),
        ]),
        page(2, [
          run(2, 'Appendix', 0.1, 0.08, 0.3, 16),
          sourceHeading('A Actual appendix section', 0.16, 0.5),
          run(
            2,
            'This is prose, not a trailing contents-page number.',
            0.1,
            0.22,
            0.7,
          ),
          sourceHeading('A.1 Actual subsection', 0.3, 0.42),
          run(
            2,
            'The subsection prose remains in canonical reading order.',
            0.1,
            0.36,
            0.7,
          ),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'plain-appendix-title.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^A(?:\s|\.)/u.test(node.text)
          ? [{ text: node.text, level: node.level }]
          : [],
      ),
    ).toEqual([
      { text: 'A Actual appendix section', level: 1 },
      { text: 'A.1 Actual subsection', level: 2 },
    ])
  })

  it('recovers source-styled small-cap appendix subsections and splits them from prose', async () => {
    const smallCapsHeading = (
      pageNumber: number,
      ordinal: string,
      initial: string,
      smallCapsTail: string,
      y: number,
    ) => [
      run(pageNumber, ordinal, 0.1, y, 0.045, 10),
      run(pageNumber, initial, 0.16, y, 0.012, 10),
      run(pageNumber, smallCapsTail, 0.172, y + 0.0025, 0.42, 8),
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Introductory body establishes the prose size.',
            0.1,
            0.3,
            0.7,
          ),
        ]),
        page(2, [
          ...smallCapsHeading(2, 'A.1', 'P', 'ROMPTS', 0.12),
          run(2, 'The prompt details remain ordinary prose.', 0.1, 0.145, 0.7),
          ...smallCapsHeading(2, 'B.1', 'E', 'VALUATION SCORING DETAILS', 0.24),
          run(2, 'The scoring details remain ordinary prose.', 0.1, 0.265, 0.7),
        ]),
        page(3, [
          ...smallCapsHeading(3, 'J.7', 'C', 'ASE STUDY', 0.12),
          ...smallCapsHeading(3, 'J.7.1', 'P', 'REVENTATIVE STEERING', 0.145),
          run(
            3,
            'The case-study explanation remains ordinary prose.',
            0.1,
            0.17,
            0.7,
          ),
        ]),
      ],
      sourceHash: 's'.repeat(64),
      fileName: 'small-cap-appendix-headings.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' ? [{ text: node.text, level: node.level }] : [],
      ),
    ).toEqual([
      { text: 'Abstract', level: 1 },
      { text: 'A.1 PROMPTS', level: 2 },
      { text: 'B.1 EVALUATION SCORING DETAILS', level: 2 },
      { text: 'J.7 CASE STUDY', level: 2 },
      { text: 'J.7.1 PREVENTATIVE STEERING', level: 3 },
    ])
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'paragraph' && /ordinary prose/u.test(node.text)
          ? [node.text]
          : [],
      ),
    ).toEqual([
      'The prompt details remain ordinary prose.',
      'The scoring details remain ordinary prose.',
      'The case-study explanation remains ordinary prose.',
    ])
  })

  it('keeps a named table-column header such as Method out of the heading hierarchy', async () => {
    const medium = (text: string, x: number, width: number) => ({
      ...run(2, text, x, 0.3, width),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Introductory body establishes the prose size.',
            0.1,
            0.3,
            0.7,
          ),
        ]),
        page(2, [
          run(2, 'Table 2: Correlation analysis.', 0.1, 0.24, 0.5),
          medium('Trait', 0.1, 0.08),
          medium('Method', 0.3, 0.1),
          medium('Overall correlation', 0.5, 0.22),
          run(2, 'Evil', 0.1, 0.34, 0.08),
          run(2, 'System prompting', 0.3, 0.34, 0.16),
          run(2, '0.747', 0.58, 0.34, 0.06),
        ]),
      ],
      sourceHash: 'm'.repeat(64),
      fileName: 'named-table-header.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) => 'text' in node && node.text === 'Method',
      ),
    ).toMatchObject({ type: 'paragraph' })
  })

  it.each(['Table 8', 'Table S2'])(
    'keeps a two-fragment styled table header out of prose and the heading hierarchy after %s',
    async (tableLabel) => {
      const medium = (text: string, x: number, width: number) => ({
        ...run(2, text, x, 0.3, width, 12),
        fontName: 'NimbusRomNo9L-Medi',
      })
      const result = await reconstructPageAnalyses({
        pages: [
          page(1, [
            run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
            run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
            run(
              1,
              'Introductory body establishes the prose size.',
              0.1,
              0.3,
              0.7,
            ),
          ]),
          page(2, [
            run(
              2,
              `${tableLabel}: Datasets used for model pre-training.`,
              0.1,
              0.22,
              0.7,
            ),
            medium('Dataset Address License Category', 0.1, 0.52),
            medium('W MG Citation', 0.65, 0.23),
            run(2, 'WebInstruct chargoddard apache generic', 0.1, 0.34, 0.52),
            run(2, '1.0 ✓ Kim et al.', 0.65, 0.34, 0.23),
            run(2, 'OpenMath nvidia-license math-instruct', 0.1, 0.38, 0.52),
            run(2, '1.0 ✓ Toshniwal et al.', 0.65, 0.38, 0.23),
          ]),
        ],
        sourceHash: 't'.repeat(64),
        fileName: 'two-fragment-table-header.pdf',
        byteLength: 4096,
      })

      const retainedHeaderFragments = result.paper.nodes.flatMap((node) =>
        'text' in node &&
        ['Dataset Address License Category', 'W MG Citation'].includes(
          node.text,
        )
          ? [{ type: node.type, text: node.text }]
          : [],
      )
      expect(
        retainedHeaderFragments.every(({ type }) => type !== 'heading'),
      ).toBe(true)
      if (tableLabel === 'Table 8') {
        expect(retainedHeaderFragments).toEqual([])
        expect(result.visualRelationships[0]).toMatchObject({
          kind: 'table',
          status: 'unresolved',
          evidence: expect.arrayContaining([
            'bounded-table-scope',
            'unresolved-bounded-table-text-owned',
          ]),
        })
      }
    },
  )

  it('keeps paired structural appendix headings even when they follow a table caption', async () => {
    const appendixHeading = (
      text: string,
      x: number,
      y: number,
      width: number,
    ) => ({
      ...run(2, text, x, y, width, 12),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Appendix hierarchy study', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Opening prose establishes body typography.', 0.1, 0.3, 0.72),
        ]),
        page(2, [
          run(
            2,
            'Table 6: Full metrics reported above the appendix sections.',
            0.1,
            0.14,
            0.75,
          ),
          appendixHeading(
            'F Length vs. Story Quality Analysis',
            0.1,
            0.22,
            0.34,
          ),
          appendixHeading('G Full Metrics for Miscellaneous', 0.54, 0.22, 0.34),
          appendixHeading('Writing Problems', 0.575, 0.239, 0.17),
          run(2, 'Left-column appendix prose.', 0.1, 0.29, 0.36),
          run(2, 'Right-column appendix prose.', 0.54, 0.29, 0.36),
          run(2, 'Left-column continuation.', 0.1, 0.32, 0.36),
          run(2, 'Right-column continuation.', 0.54, 0.32, 0.36),
        ]),
      ],
      sourceHash: 'v'.repeat(64),
      fileName: 'paired-appendix-headings-after-table.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^[FG]\s/u.test(node.text)
          ? [node.text]
          : [],
      ),
    ).toEqual([
      'F Length vs. Story Quality Analysis',
      'G Full Metrics for Miscellaneous Writing Problems',
    ])
  })

  it('keeps enlarged example-story titles out of an explicit section hierarchy', async () => {
    const structural = (text: string, y: number) => ({
      ...run(2, text, 0.1, y, 0.55, 12),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Structured appendix examples', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          structural('1 Introduction', 0.3),
          run(
            1,
            'The paper establishes an explicit hierarchy.',
            0.1,
            0.35,
            0.7,
          ),
        ]),
        page(2, [
          structural('F Example generated outline', 0.1),
          run(2, 'The outline begins with ordinary content.', 0.1, 0.16, 0.7),
          structural('A New Color in the Canvas', 0.3),
          run(
            2,
            'The story event remains ordinary example content.',
            0.1,
            0.35,
            0.7,
          ),
          structural('A New Beginning', 0.48),
          run(
            2,
            'Another story event remains example content.',
            0.1,
            0.53,
            0.7,
          ),
          structural('G Example generated story', 0.7),
          run(2, 'The next appendix section begins here.', 0.1, 0.75, 0.7),
        ]),
      ],
      sourceHash: 'y'.repeat(64),
      fileName: 'example-story-titles.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'heading' &&
          /^(?:A New Color in the Canvas|A New Beginning)$/u.test(node.text),
      ),
    ).toEqual([])
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^[FG]\s/u.test(node.text)
          ? [node.text]
          : [],
      ),
    ).toEqual(['F Example generated outline', 'G Example generated story'])
  })

  it('uses excluded same-row table labels to reject a surviving styled header fragment', async () => {
    const medium = (text: string, x: number, width: number) => ({
      ...run(2, text, x, 0.31, width, 7),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const survivingMedium = (text: string, x: number, width: number) => ({
      ...run(2, text, x, 0.31, width, 9),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Introductory body establishes the prose size.',
            0.1,
            0.3,
            0.7,
          ),
        ]),
        page(2, [
          run(2, 'The retained left prose establishes', 0.08, 0.08, 0.38, 10),
          run(2, 'The paired right prose establishes', 0.54, 0.08, 0.38, 10),
          run(2, 'a stable scholarly text column.', 0.08, 0.105, 0.38, 10),
          run(2, 'a second stable scholarly column.', 0.54, 0.105, 0.38, 10),
          run(
            2,
            'A third left line keeps labels subordinate.',
            0.08,
            0.13,
            0.38,
            10,
          ),
          run(2, 'A third right line proves the gutter.', 0.54, 0.13, 0.38, 10),
          run(
            2,
            'Table 8: Datasets used for model pre-training (Part 2: Instruction Data)',
            0.08,
            0.209,
            0.7,
            7,
          ),
          medium('Dataset', 0.08, 0.08),
          medium('Address', 0.22, 0.08),
          medium('License', 0.38, 0.08),
          medium('Category', 0.52, 0.09),
          survivingMedium('W MG Citation', 0.655, 0.113),
          run(2, 'WebInstruct', 0.08, 0.35, 0.08, 7),
          run(2, 'example.org/data', 0.22, 0.35, 0.12, 7),
          run(2, 'Apache-2.0', 0.38, 0.35, 0.09, 7),
          run(2, 'Generic', 0.52, 0.35, 0.08, 7),
          run(2, '1.0 ✓ Kim et al.', 0.655, 0.35, 0.113, 7),
        ]),
      ],
      sourceHash: 'u'.repeat(64),
      fileName: 'fragmented-table-header.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) => 'text' in node && node.text === 'W MG Citation',
      ),
    ).toMatchObject({ type: 'paragraph' })
  })

  it('removes repeated margins and retains normalized source-box provenance', async () => {
    const pages = [
      page(1, [
        run(1, 'Journal 2026', 0.1, 0.02, 0.2, 8),
        run(1, 'A Semantic Paper', 0.1, 0.15, 0.7, 22),
        run(1, 'This is the first reconstructed paragraph.', 0.1, 0.24, 0.72),
      ]),
      page(2, [
        run(2, 'Journal 2026', 0.1, 0.02, 0.2, 8),
        run(2, 'Methods', 0.1, 0.16, 0.25, 17),
        run(2, 'The second page remains in reading order.', 0.1, 0.24, 0.7),
      ]),
    ]
    const result = await reconstructPageAnalyses({
      pages,
      sourceHash: 'a'.repeat(64),
      fileName: 'paper.pdf',
      byteLength: 2048,
      metadata: { author: 'Ada Example', modified: '2026-07-13' },
    })

    expect(result.paper.title).toBe('A Semantic Paper')
    expect(result.paper.authors).toEqual(['Ada Example'])
    expect(
      result.paper.nodes.map((node) => 'text' in node && node.text),
    ).not.toContain('Journal 2026')
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'REPEATED_MARGIN_TEXT' }),
      ]),
    )
    const first = result.paper.nodes[0]
    expect(result.provenance[first.id]).toMatchObject({
      confidence: 0.9,
      pages: [1],
    })
    expect(result.provenance[first.id].boxes[0]).toMatchObject({
      page: 1,
      method: 'pdf-text',
      x: 0.1,
      y: 0.15,
    })
  })

  it('retains embedded links alongside reconstructed node provenance', async () => {
    const linked = page(1, [
      run(1, 'Linked embedded text remains source evidence.', 0.1, 0.2, 0.7),
    ])
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external',
        url: 'https://example.test/evidence',
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
      sourceHash: 'e'.repeat(64),
      fileName: 'linked.pdf',
      byteLength: 2048,
    })

    expect(Object.values(result.provenance)[0].links).toEqual(linked.links)
    const linkedNode = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Linked embedded text'),
    )
    expect(
      linkedNode && 'inlineRuns' in linkedNode
        ? linkedNode.inlineRuns
        : undefined,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: 'https://example.test/evidence',
          annotationId: 'pdf-link-p001-a0001',
        }),
      ]),
    )
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 1,
      hyperlinkCoverage: 1,
    })
  })

  it('maps styles and internal links from exact line ranges after a cross-run accent repair', async () => {
    const source = withExplicitEnglishLanguage(
      page(1, [
        run(1, 'Uncomputable Lineage', 0.1, 0.05, 0.34, 18),
        {
          ...run(1, 'Earlier Vit´', 0.1, 0.2, 0.08),
          height: 0.0125,
        },
        {
          ...run(
            1,
            'anyi text (see §2 for a detailed background). Complexity is',
            0.18,
            0.2,
            0.48,
          ),
          height: 0.0125,
        },
        {
          ...run(1, 'un-', 0.665, 0.2, 0.03),
          height: 0.0125,
          fontName: 'Body-Italic',
          italic: true,
        },
        {
          ...run(1, 'computable', 0.1, 0.214, 0.08),
          height: 0.0125,
          fontName: 'Body-Italic',
          italic: true,
        },
        {
          ...run(
            1,
            'as it reduces to a finite source-backed proof.',
            0.185,
            0.214,
            0.5,
          ),
          height: 0.0125,
        },
      ]),
    )
    source.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal',
        destination: 'section.2',
        destinationEvidence: {
          source: 'pdfjs-named-destination',
          destination: 'section.2',
          view: 'XYZ',
          page: 2,
          point: {
            page: 2,
            x: 0.1,
            y: 0.2,
            rotation: 0,
            method: 'pdf-destination',
          },
          box: null,
        },
        box: {
          page: 1,
          x: 0.34,
          y: 0.2,
          width: 0.02,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [source, page(2, [run(2, '2 BACKGROUND', 0.1, 0.2, 0.34, 16)])],
      sourceHash: 'a'.repeat(64),
      fileName: 'line-range-inline-lineage.pdf',
      byteLength: 2048,
      metadata: { author: 'Ada Example' },
    })
    const paragraph = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Earlier Vitányi'),
    )

    expect(paragraph).toBeDefined()
    if (!paragraph || !('text' in paragraph) || !('inlineRuns' in paragraph)) {
      throw new Error('missing reconstructed inline paragraph')
    }
    const italicRuns = (paragraph.inlineRuns ?? []).filter(
      (candidate) => candidate.italic,
    )
    const italicText = italicRuns
      .map((candidate) => paragraph.text.slice(candidate.start, candidate.end))
      .join('')
    const italicCharacterIndexes = italicRuns.flatMap((candidate) =>
      Array.from(
        { length: candidate.end - candidate.start },
        (_value, index) => candidate.start + index,
      ),
    )
    const uncomputableStart = paragraph.text.indexOf('un-computable')
    const sectionLink = (paragraph.inlineRuns ?? []).find(
      (candidate) => candidate.annotationId === 'pdf-link-p001-a0001',
    )

    expect(italicText).toBe('un-computable')
    expect(italicCharacterIndexes).toEqual(
      Array.from(
        { length: 'un-computable'.length },
        (_value, index) => uncomputableStart + index,
      ),
    )
    expect(result.lineBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'unresolved',
          evidence: expect.arrayContaining([
            'source-proven-wrapped-line-boundary',
            'same-document-unhyphenated-word',
          ]),
        }),
      ]),
    )
    expect(sectionLink).toMatchObject({
      href: expect.stringMatching(/^#sec-/u),
      annotationId: 'pdf-link-p001-a0001',
    })
    expect(
      sectionLink
        ? paragraph.text.slice(sectionLink.start, sectionLink.end)
        : null,
    ).toBe('§2')

    const epub = await buildReadableEpub(result.paper, result)
    const content = strFromU8(
      inspectEpub(epub.bytes).files['EPUB/content.xhtml'],
    )
    expect(content).toContain(
      `<a href="${sectionLink!.href}" data-source-annotation-id="pdf-link-p001-a0001">§2</a>`,
    )
    expect(content).toContain('<em>un-computable</em>')
  })

  it('keeps positioned-accent provenance and exact inline mapping through EPUB reconstruction', async () => {
    const prefix = {
      ...run(1, 'A source cites Kram', 0.1, 0.2, 0.23281),
      height: 0.012579,
      fontSize: 9.9626,
      fontName: 'Body',
    }
    const accent = {
      ...run(1, '´', 0.33371, 0.1999369, 0.00542),
      height: 0.012579,
      fontSize: 9.9626,
      fontName: 'Body-Italic',
      italic: true,
    }
    const linkedPeer = {
      ...run(1, 'ar method', 0.33281, 0.2, 0.068),
      height: 0.012579,
      fontSize: 9.9626,
      fontName: 'Body-Italic',
      italic: true,
    }
    const suffix = {
      ...run(1, 'and continues.', 0.405, 0.2, 0.11),
      height: 0.012579,
      fontSize: 9.9626,
      fontName: 'Body',
    }
    const source = page(1, [prefix, accent, linkedPeer, suffix])
    source.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external',
        url: 'https://example.test/accented-source',
        box: {
          page: 1,
          x: linkedPeer.x,
          y: linkedPeer.y,
          width: linkedPeer.width,
          height: linkedPeer.height,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [source],
      sourceHash: 'c'.repeat(64),
      fileName: 'positioned-accent-lineage.pdf',
      byteLength: 2048,
      metadata: { author: 'Ada Example' },
    })
    const paragraph = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Kramár method'),
    )

    expect(paragraph).toBeDefined()
    if (!paragraph || !('text' in paragraph) || !('inlineRuns' in paragraph)) {
      throw new Error('missing positioned-accent paragraph')
    }
    const linked = (paragraph.inlineRuns ?? []).find(
      (candidate) => candidate.annotationId === 'pdf-link-p001-a0001',
    )
    expect(linked).toMatchObject({
      href: 'https://example.test/accented-source',
      annotationId: 'pdf-link-p001-a0001',
      italic: true,
    })
    expect(linked ? paragraph.text.slice(linked.start, linked.end) : null).toBe(
      'ár method',
    )

    const paragraphEvidence = result.provenance[paragraph.id]
    expect(paragraphEvidence.boxes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          page: 1,
          x: accent.x,
          y: 0.19994,
          width: accent.width,
          height: 0.01258,
        }),
      ]),
    )

    const epub = await buildReadableEpub(result.paper, result)
    const content = strFromU8(
      inspectEpub(epub.bytes).files['EPUB/content.xhtml'],
    )
    expect(content).toContain(
      '<a href="https://example.test/accented-source"><em>ár method</em></a>',
    )
  })

  it('counts one source-verified semantic-table link annotation exactly once', () => {
    const sourceBox = (x: number, y: number, width = 0.08, height = 0.018) =>
      ({
        page: 1,
        x,
        y,
        width,
        height,
        rotation: 0,
        method: 'pdf-text',
      }) as const
    const headerRuns = [
      {
        ...run(1, 'Method', 0.1, 0.2, 0.08),
        bold: true,
        fontName: 'Table-Bold',
      },
      {
        ...run(1, 'Score', 0.5, 0.2, 0.08),
        bold: true,
        fontName: 'Table-Bold',
      },
    ]
    const bodyRuns = [
      {
        ...run(1, 'Ours', 0.1, 0.25, 0.08),
        italic: true,
        fontName: 'Table-Italic',
      },
      run(1, '91.0', 0.5, 0.25, 0.08),
    ]
    const lines: PdfPageRegion['lines'] = [
      {
        id: 'table-header',
        text: 'Method Score',
        fontSize: 10,
        box: sourceBox(0.1, 0.2, 0.48),
        runs: headerRuns,
      },
      {
        id: 'table-body',
        text: 'Ours 91.0',
        fontSize: 10,
        box: sourceBox(0.1, 0.25, 0.48),
        runs: bodyRuns,
      },
    ]
    const region = {
      id: 'table-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'Method Score Ours 91.0',
      confidence: 1,
      box: sourceBox(0.1, 0.2, 0.48, 0.068),
      lines,
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'external',
      url: 'https://example.test/table-method',
      box: { ...sourceBox(0.1, 0.25), method: 'pdf-link' as const },
    } as const
    const table = canonicalTableFromLines(lines, {
      sourceRegions: [region],
      links: [annotation],
    })

    expect(table).not.toBeNull()
    const occurrences = canonicalHyperlinkOccurrencesForTable(table!)
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [],
      annotations: [annotation],
      canonicalOccurrences: occurrences,
    })
    const approved = canonicalTableWithApprovedHyperlinks(
      table!,
      resolution.approvedAnnotationIds,
    )
    const linkedCell = approved.rows
      .flatMap((row) => row.cells)
      .find((cell) => cell.text === 'Ours')

    expect(occurrences).toEqual([
      {
        annotationId: annotation.id,
        url: annotation.url,
      },
    ])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 1 })
    expect(resolution.diagnostics).toEqual([])
    expect(linkedCell?.inlineRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: annotation.url,
          annotationId: annotation.id,
        }),
      ]),
    )
  })

  it('does not project a link annotation onto matching geometry on another page', async () => {
    const first = page(1, [
      run(1, 'Linked text on the annotated page.', 0.1, 0.2, 0.7),
    ])
    first.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external',
        url: 'https://example.test/page-one',
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
    const second = page(2, [
      run(2, 'Plain text at matching coordinates.', 0.1, 0.2, 0.7),
    ])

    const result = await reconstructPageAnalyses({
      pages: [first, second],
      sourceHash: 'd'.repeat(64),
      fileName: 'page-scoped-link.pdf',
      byteLength: 2048,
    })
    const linked = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Linked text'),
    )
    const plain = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Plain text'),
    )

    expect(
      linked && 'inlineRuns' in linked
        ? linked.inlineRuns?.some(
            (inline) => inline.href === 'https://example.test/page-one',
          )
        : false,
    ).toBe(true)
    expect(
      plain && 'inlineRuns' in plain
        ? plain.inlineRuns?.some((inline) => inline.href)
        : false,
    ).toBe(false)
  })

  it('orders detected columns left before right without storing target geometry', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left one.', 0.08, 0.2, 0.32),
          run(1, 'Left two.', 0.08, 0.24, 0.32),
          run(1, 'Left three.', 0.08, 0.28, 0.32),
          run(1, 'Right one.', 0.55, 0.2, 0.32),
          run(1, 'Right two.', 0.55, 0.24, 0.32),
          run(1, 'Right three.', 0.55, 0.28, 0.32),
        ]),
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'columns.pdf',
      byteLength: 4096,
    })
    const text = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')
    expect(text.indexOf('Left one')).toBeLessThan(text.indexOf('Right one'))
    expect(result.paper).not.toHaveProperty('geometry')
    expect(result.paper).not.toHaveProperty('pages')
  })

  it('preserves narrow-gutter columns instead of interleaving their rows', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left one.', 0.08, 0.2, 0.43),
          run(1, 'Right one.', 0.53, 0.2, 0.39),
          run(1, 'Left two.', 0.08, 0.24, 0.43),
          run(1, 'Right two.', 0.53, 0.24, 0.39),
          run(1, 'Left three.', 0.08, 0.28, 0.43),
          run(1, 'Right three.', 0.53, 0.28, 0.39),
        ]),
      ],
      sourceHash: '1'.repeat(64),
      fileName: 'narrow-gutter-columns.pdf',
      byteLength: 2048,
    })

    const text = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')
    expect(text.indexOf('Left three')).toBeLessThan(text.indexOf('Right one'))
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
  })

  it('keeps complete section and list subtrees in column flow when a compact grid has a denser internal gap', async () => {
    const section = (text: string, x: number, y: number, width: number) => ({
      ...run(2, text, x, y, width),
      fontName: 'NimbusRomNo9L-Medi',
      bold: true,
    })
    const compactGrid = Array.from({ length: 6 }, (_, index) => {
      const y = 0.08 + index * 0.024
      return [
        run(2, `Metric ${index + 1}`, 0.08, y, 0.32, 8),
        run(2, `Score ${String.fromCharCode(65 + index)}`, 0.44, y, 0.04),
      ]
    }).flat()
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Column subtree ordering', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Opening context remains single-column prose.',
            0.1,
            0.3,
            0.72,
          ),
        ]),
        page(2, [
          ...compactGrid,
          run(2, 'Left gutter evidence one.', 0.08, 0.25, 0.4),
          run(2, 'Right gutter evidence one.', 0.54, 0.25, 0.36),
          run(2, 'Left gutter evidence two.', 0.08, 0.28, 0.4),
          run(2, 'Right gutter evidence two.', 0.54, 0.28, 0.36),
          run(2, 'Left gutter evidence three.', 0.08, 0.31, 0.4),
          run(2, 'Right gutter evidence three.', 0.54, 0.31, 0.36),
          section('4.5. Left-column study', 0.08, 0.39, 0.29),
          section('5. Right-column method', 0.54, 0.34, 0.31),
          section('5.1. Right-column details', 0.54, 0.365, 0.29),
          run(
            2,
            'Left introduction explains the complete study.',
            0.08,
            0.43,
            0.4,
          ),
          run(
            2,
            'Right introduction explains the complete method.',
            0.54,
            0.455,
            0.36,
          ),
          run(2, '1. Left method one.', 0.1, 0.48, 0.36),
          run(2, '1. Right clock one.', 0.56, 0.505, 0.32),
          run(2, '2. Left method two.', 0.1, 0.53, 0.36),
          run(2, '2. Right clock two.', 0.56, 0.555, 0.32),
          run(2, '3. Left method three.', 0.1, 0.58, 0.36),
          run(
            2,
            'Left conclusion completes the study subtree.',
            0.08,
            0.64,
            0.4,
          ),
          run(
            2,
            'Right conclusion completes the method subtree.',
            0.54,
            0.61,
            0.36,
          ),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'compact-grid-column-subtrees.pdf',
      byteLength: 4096,
    })

    const subtreeText = result.paper.nodes.flatMap((node) =>
      'text' in node &&
      /^(?:4\.5\.|5\.|Left introduction|Left method|Left conclusion|Right introduction|Right clock|Right conclusion)/u.test(
        node.text,
      )
        ? [node.text]
        : [],
    )
    expect(subtreeText).toEqual([
      '4.5. Left-column study',
      'Left introduction explains the complete study.',
      'Left method one.',
      'Left method two.',
      'Left method three.',
      'Left conclusion completes the study subtree.',
      '5. Right-column method',
      '5.1. Right-column details',
      'Right introduction explains the complete method.',
      'Right clock one.',
      'Right clock two.',
      'Right conclusion completes the method subtree.',
    ])
    expect(
      result.readingOrder.resolutions.find(
        (resolution) =>
          resolution.page === 2 && resolution.status === 'resolved',
      ),
    ).toMatchObject({
      evidence: expect.arrayContaining([
        expect.objectContaining({
          code: 'column-gutter',
          detail: expect.stringMatching(/0 candidate lines cross/iu),
        }),
      ]),
    })
    expect(
      result.regions.filter(
        (region) =>
          region.page === 2 &&
          /^(?:Left introduction|Left method|Left conclusion)/u.test(
            region.text,
          ) &&
          region.column === 'span',
      ),
    ).toHaveLength(0)
    expect(result.completeness.readingOrderDiagnostics).toBe(0)
  })

  it('retains a true page-spanning source line as a column-flow boundary', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left above one.', 0.08, 0.2, 0.36),
          run(1, 'Right above one.', 0.56, 0.2, 0.36),
          run(1, 'Left above two.', 0.08, 0.24, 0.36),
          run(1, 'Right above two.', 0.56, 0.24, 0.36),
          run(1, 'Left above three.', 0.08, 0.28, 0.36),
          run(1, 'Right above three.', 0.56, 0.28, 0.36),
          run(
            1,
            'A page-spanning transition remains a boundary.',
            0.1,
            0.42,
            0.8,
          ),
          run(1, 'Left below one.', 0.08, 0.52, 0.36),
          run(1, 'Right below one.', 0.56, 0.52, 0.36),
          run(1, 'Left below two.', 0.08, 0.56, 0.36),
          run(1, 'Right below two.', 0.56, 0.56, 0.36),
        ]),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'true-spanning-column-boundary.pdf',
      byteLength: 2048,
    })

    const text = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')
    const spanning = result.regions.find((region) =>
      region.text.includes('page-spanning transition'),
    )
    expect(spanning).toMatchObject({ kind: 'spanning', column: 'span' })
    expect(text.indexOf('Right above three')).toBeLessThan(
      text.indexOf('page-spanning transition'),
    )
    expect(text.indexOf('page-spanning transition')).toBeLessThan(
      text.indexOf('Left below one'),
    )
  })

  it('fails closed when a short two-column page cannot be ordered safely', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left one.', 0.08, 0.2, 0.32),
          run(1, 'Right one.', 0.55, 0.2, 0.32),
          run(1, 'Indented left two.', 0.18, 0.7, 0.22),
          run(1, 'Right two.', 0.55, 0.7, 0.32),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'short-columns.pdf',
      byteLength: 2048,
    })

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'error',
        }),
      ]),
    )
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'SOURCE_ORDER_FLOAT_FALLBACK',
      ),
    ).toEqual([])
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
  })

  it('uses visual line grouping to detect split, out-of-order captions', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '1. A split caption', 0.2, 0.398, 0.32, 8),
          run(1, 'Figure', 0.1, 0.4, 0.08, 8),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'split-caption.pdf',
      byteLength: 2048,
    })

    expect(result.semanticSignals.captions).toBe(1)
    expect(result.completeness.unresolvedObjects.captions).toBe(1)
    expect(result.readiness.ready).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INCOMPLETE_RELATIONSHIP_COVERAGE',
          severity: 'error',
        }),
      ]),
    )
  })

  it('reconciles a multi-run caption envelope with strict visual provenance', async () => {
    const figureBox: NormalizedSourceBox = {
      page: 1,
      x: 0.25,
      y: 0.14,
      width: 0.3,
      height: 0.2,
      rotation: 0,
      method: 'pdf-object',
    }
    const sourcePage = page(1, [
      run(
        1,
        'Figure 1. A multi-run',
        0.20004503944386193,
        0.4,
        0.20003758366009416,
        8,
      ),
      run(
        1,
        'caption envelope.',
        0.42003177397559277,
        0.4,
        0.2000623840055811,
        8,
      ),
    ])
    sourcePage.imageCount = 1
    sourcePage.objects = [
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image',
        box: figureBox,
        confidence: 0.99,
        assetId: null,
        role: 'semantic',
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: 'a'.repeat(64),
      fileName: 'multi-run-caption.pdf',
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

    const relationship = result.visualRelationships.find(
      (candidate) => candidate.status === 'matched',
    )!
    const captionEvidence = result.provenance[relationship.captionNodeId!]
    const visualEvidence = result.provenance[relationship.canonicalNodeId!]
    expect(captionEvidence.boxes).toHaveLength(2)
    expect(relationship.sourceBoxes[0]).toMatchObject({
      page: 1,
      x: 0.20005,
      y: 0.4,
      width: 0.42004,
      height: 0.018,
      rotation: 0,
      method: 'pdf-text',
    })
    expect(visualEvidence.boxes).toEqual(relationship.sourceBoxes)
    expect(
      validatedPdfVisualRelationships({
        paper: result.paper,
        provenance: result.provenance,
        relationships: result.visualRelationships,
        assets: result.assets,
        regions: result.regions,
        pages: result.pages,
      }),
    ).toEqual([relationship])
  })

  it('retains a source transcript for a matched table when semantic token spacing differs from raw line joins', () => {
    const semanticTranscript =
      'Method Score ROLLING 45.7 RE 3 60.0 ROLLING - FT 48.7'
    const rawLineJoin = 'Method Score 45.7 ROLLING RE3 60.0 48.7 ROLLING-FT'

    expect(rawLineJoin).not.toBe(semanticTranscript)
    expect(
      canonicalVisualSourceTranscript(
        {
          kind: 'table',
          status: 'matched',
          sourceText: semanticTranscript,
        },
        rawLineJoin,
      ),
    ).toBe(semanticTranscript)
  })

  it('orders canonical figure-caption pairs by the verified visual column flow', async () => {
    const figureBoxes: NormalizedSourceBox[] = [
      {
        page: 1,
        x: 0.09,
        y: 0.09,
        width: 0.38,
        height: 0.15,
        rotation: 0,
        method: 'pdf-object',
      },
      {
        page: 1,
        x: 0.09,
        y: 0.32,
        width: 0.38,
        height: 0.14,
        rotation: 0,
        method: 'pdf-object',
      },
      {
        page: 1,
        x: 0.09,
        y: 0.58,
        width: 0.38,
        height: 0.23,
        rotation: 0,
        method: 'pdf-object',
      },
      {
        page: 1,
        x: 0.502,
        y: 0.27,
        width: 0.38,
        height: 0.36,
        rotation: 0,
        method: 'pdf-object',
      },
    ]
    const sourcePage = page(1, [
      run(1, 'Figure 15. First left-column figure.', 0.09, 0.255, 0.38, 8),
      run(1, 'Figure 16. Second left-column figure.', 0.09, 0.47, 0.38, 8),
      run(1, 'Figure 17. Third left-column figure.', 0.09, 0.827, 0.38, 8),
      run(1, 'Figure 18. Right-column figure.', 0.502, 0.652, 0.38, 8),
    ])
    sourcePage.imageCount = figureBoxes.length
    sourcePage.objects = figureBoxes.map((box, index) => ({
      id: `image-visual-column-${index + 1}`,
      page: 1,
      kind: 'image',
      box,
      confidence: 0.98,
      assetId: null,
      role: 'semantic',
    }))

    const result = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: 'f'.repeat(64),
      fileName: 'visual-column-order.pdf',
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
    expect(result.visualRelationships.map(({ label }) => label)).toEqual([
      'Figure 15',
      'Figure 16',
      'Figure 17',
      'Figure 18',
    ])
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'figure' ? [labelByNodeId.get(node.id)] : [],
      ),
    ).toEqual(['Figure 15', 'Figure 16', 'Figure 17', 'Figure 18'])
  })

  it('keeps single-column visual pairs at their source caption slots when discovery order is reversed', () => {
    const paragraph = (id: string, text: string): ResearchNode => ({
      id,
      type: 'paragraph',
      text,
      source: 'pdf:test#page=1',
    })
    const heading = (id: string, text: string): ResearchNode => ({
      id,
      type: 'heading',
      level: 2,
      text,
      source: 'pdf:test#page=1',
    })
    const figure = (id: string, caption: string): ResearchNode => ({
      id,
      type: 'figure',
      objectType: 'figure',
      title: id,
      relationships: { caption, assets: [`asset-${id}`] },
      source: 'pdf:test#page=1',
    })
    const nodes: ResearchNode[] = [
      figure('visual-screenshot', 'caption-screenshot'),
      paragraph('caption-screenshot', 'Figure 3. Screenshot.'),
      heading('appendix', 'A Appendix'),
      heading('prompt-section', 'A.2 Prompts for the agent system'),
      figure('visual-prompt', 'caption-prompt'),
      paragraph('caption-prompt', 'Here is the specific prompt used:'),
    ]

    orderCanonicalVisualPairs(nodes, [
      {
        page: 1,
        column: 'single',
        visualNodeId: 'visual-prompt',
        captionNodeId: 'caption-prompt',
      },
      {
        page: 1,
        column: 'single',
        visualNodeId: 'visual-screenshot',
        captionNodeId: 'caption-screenshot',
      },
    ])

    expect(nodes.map((node) => node.id)).toEqual([
      'visual-screenshot',
      'caption-screenshot',
      'appendix',
      'prompt-section',
      'visual-prompt',
      'caption-prompt',
    ])
  })

  it('restores proved left-before-right visual flow even when canonical discovery starts in the right column', () => {
    const pair = (
      id: string,
      captionId: string,
      label: string,
    ): [ResearchNode, ResearchNode] => [
      {
        id,
        type: 'figure',
        objectType: 'figure',
        title: label,
        relationships: { caption: captionId, assets: [`asset-${id}`] },
        source: 'pdf:test#page=1',
      },
      {
        id: captionId,
        type: 'caption',
        text: label,
        source: 'pdf:test#page=1',
      },
    ]
    const nodes: ResearchNode[] = [
      ...pair('right-visual', 'right-caption', 'Figure 3. Right column.'),
      ...pair('left-visual-1', 'left-caption-1', 'Figure 1. Left column.'),
      ...pair('left-visual-2', 'left-caption-2', 'Figure 2. Left column.'),
    ]

    orderCanonicalVisualPairs(nodes, [
      {
        page: 1,
        column: 'right',
        sourceBox: {
          page: 1,
          x: 0.55,
          y: 0.1,
          width: 0.35,
          height: 0.15,
          rotation: 0,
          method: 'pdf-object',
        },
        visualNodeId: 'right-visual',
        captionNodeId: 'right-caption',
      },
      {
        page: 1,
        column: 'left',
        sourceBox: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.35,
          height: 0.15,
          rotation: 0,
          method: 'pdf-object',
        },
        visualNodeId: 'left-visual-1',
        captionNodeId: 'left-caption-1',
      },
      {
        page: 1,
        column: 'left',
        sourceBox: {
          page: 1,
          x: 0.1,
          y: 0.5,
          width: 0.35,
          height: 0.15,
          rotation: 0,
          method: 'pdf-object',
        },
        visualNodeId: 'left-visual-2',
        captionNodeId: 'left-caption-2',
      },
    ])

    expect(nodes.map((node) => node.id)).toEqual([
      'left-visual-1',
      'left-caption-1',
      'left-visual-2',
      'left-caption-2',
      'right-visual',
      'right-caption',
    ])
  })

  it('keeps mixed span and column visual pairs at their caption anchors when a later column pair is materialized', () => {
    const pair = (
      id: string,
      captionId: string,
      label: string,
    ): [ResearchNode, ResearchNode] => [
      {
        id,
        type: 'figure',
        objectType: 'equation',
        title: label,
        relationships: { caption: captionId, assets: [`asset-${id}`] },
        source: 'pdf:test#page=1',
      },
      {
        id: captionId,
        type: 'caption',
        text: label,
        source: 'pdf:test#page=1',
      },
    ]
    const nodes: ResearchNode[] = [
      visualOrderParagraph('opening-prose', 'Opening source prose.'),
      ...pair('span-visual-early', 'span-caption-early', 'Equation 2'),
      visualOrderParagraph('bridge-prose', 'The source continues.'),
      ...pair('left-visual', 'left-caption', 'Equation 3'),
      visualOrderParagraph('equation-discussion', 'Equation discussion.'),
      visualOrderHeading('later-scope', 3, 'Later source scope'),
      visualOrderParagraph('later-introduction', 'Later source prose.'),
      ...pair(
        'span-visual-late',
        'span-caption-late',
        'Display equation p001-003',
      ),
      visualOrderParagraph('following-prose', 'Following source prose.'),
      ...pair('right-visual', 'right-caption', 'Equation 4'),
    ]

    orderCanonicalVisualPairs(nodes, [
      {
        page: 1,
        column: 'span',
        sourceBox: {
          page: 1,
          x: 0.45,
          y: 0.2,
          width: 0.1,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
        visualNodeId: 'span-visual-early',
        captionNodeId: 'span-caption-early',
      },
      {
        page: 1,
        column: 'left',
        sourceBox: {
          page: 1,
          x: 0.3,
          y: 0.3,
          width: 0.18,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
        visualNodeId: 'left-visual',
        captionNodeId: 'left-caption',
      },
      {
        page: 1,
        column: 'span',
        sourceBox: {
          page: 1,
          x: 0.35,
          y: 0.68,
          width: 0.3,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
        visualNodeId: 'span-visual-late',
        captionNodeId: 'span-caption-late',
      },
      {
        page: 1,
        column: 'right',
        sourceBox: {
          page: 1,
          x: 0.56,
          y: 0.77,
          width: 0.1,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
        visualNodeId: 'right-visual',
        captionNodeId: 'right-caption',
      },
    ])

    expect(nodes.map((node) => node.id)).toEqual([
      'opening-prose',
      'span-visual-early',
      'span-caption-early',
      'bridge-prose',
      'left-visual',
      'left-caption',
      'equation-discussion',
      'later-scope',
      'later-introduction',
      'span-visual-late',
      'span-caption-late',
      'following-prose',
      'right-visual',
      'right-caption',
    ])
  })

  it('keeps a float in its sole physical heading scope when an earlier section cross-references it', () => {
    const visualNodeId = 'visual-physical-scope'
    const captionNodeId = 'caption-physical-scope'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 Earlier discussion'),
      visualOrderParagraph(
        'earlier-reference',
        'Figure 21 previews the later physical result.',
      ),
      visualOrderHeading('scope-b', 2, 'A.2 Physical figure scope'),
      visualOrderParagraph(
        'physical-prose',
        'The source-backed result is developed here.',
      ),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
      visualOrderHeading('scope-c', 2, 'A.3 Following discussion'),
    ]
    const earlierReference = matchedVisualOrderReference({
      id: 'cross-reference-earlier-physical-scope',
      anchorNodeId: 'earlier-reference',
      referenceRegionId: 'earlier-reference-region',
      visualNodeId,
      page: 1,
      y: 0.3,
    })
    const sourceOrder = nodes.map((node) => node.id)
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 2,
          column: 'left',
          sourceBox: {
            page: 2,
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
      [earlierReference],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          severity: 'info',
          relationshipId: earlierReference.id,
        }),
      ]),
    )
  })

  it('keeps a top-of-page float in the preceding-page physical heading scope when a later section references it', () => {
    const visualNodeId = 'visual-previous-page-scope'
    const captionNodeId = 'caption-previous-page-scope'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 Physical scope'),
      visualOrderParagraph(
        'scope-a-prose',
        'The section continues across the page boundary.',
      ),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
      visualOrderHeading('scope-b', 2, 'A.2 Later reference scope'),
      visualOrderParagraph(
        'later-reference',
        'The later section revisits Figure 21.',
      ),
      visualOrderHeading('scope-c', 2, 'A.3 Following scope'),
    ]
    const laterReference = matchedVisualOrderReference({
      id: 'cross-reference-later-previous-page-scope',
      anchorNodeId: 'later-reference',
      referenceRegionId: 'later-reference-region',
      visualNodeId,
      page: 2,
      y: 0.5,
    })
    const sourceEvidence = (
      pageNumber: number,
      x: number,
      y: number,
      width = 0.36,
    ): NodeSourceEvidence => ({
      confidence: 1,
      pages: [pageNumber],
      regionIds: [`region-${pageNumber}-${x}-${y}`],
      boxes: [
        {
          page: pageNumber,
          x,
          y,
          width,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })
    const sourceOrder = nodes.map((node) => node.id)
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 2,
          column: 'left',
          sourceBox: {
            page: 2,
            x: 0.1,
            y: 0.08,
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
      {
        'scope-a': sourceEvidence(1, 0.08, 0.72, 0.84),
        'scope-b': sourceEvidence(2, 0.08, 0.4, 0.84),
        'scope-c': sourceEvidence(3, 0.08, 0.1, 0.84),
      },
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          severity: 'info',
          relationshipId: laterReference.id,
        }),
      ]),
    )
  })

  it('restores a deferred multi-appendix float run to its source-proved heading scopes', () => {
    const figure = (
      ordinal: number,
    ): Extract<ResearchNode, { type: 'figure' }> => ({
      id: `visual-${ordinal}`,
      type: 'figure',
      objectType: 'figure',
      title: `Figure ${ordinal}. Deferred appendix result.`,
      relationships: {
        caption: `caption-${ordinal}`,
        assets: [`asset-${ordinal}`],
      },
      source: `pdf:test#page=${ordinal}`,
    })
    const caption = (
      ordinal: number,
    ): Extract<ResearchNode, { type: 'caption' }> => ({
      id: `caption-${ordinal}`,
      type: 'caption',
      text: `Figure ${ordinal}. Deferred appendix result.`,
      source: `pdf:test#page=${ordinal}`,
    })
    const nodes: ResearchNode[] = [
      visualOrderHeading('appendix-b', 1, 'B Prompt details'),
      visualOrderHeading('appendix-b-4', 2, 'B.4 Experiment prompts'),
      visualOrderParagraph(
        'appendix-b-reference',
        'The complete prompt appears in Figure 22.',
      ),
      visualOrderHeading('appendix-c', 1, 'C Human evaluation'),
      visualOrderParagraph(
        'appendix-c-reference',
        'The evaluation interface appears in Figure 23.',
      ),
      visualOrderHeading('appendix-d', 1, 'D Grouping rules'),
      visualOrderParagraph(
        'appendix-d-reference',
        'The grouping rules appear in Figure 26.',
      ),
      visualOrderHeading('appendix-f', 1, 'F Generated outline'),
      visualOrderParagraph(
        'appendix-f-reference',
        'The generated outline appears in Figure 30.',
      ),
      figure(22),
      caption(22),
      figure(23),
      caption(23),
      figure(26),
      caption(26),
      figure(30),
      caption(30),
      visualOrderHeading('appendix-g', 1, 'G Generated story'),
    ]
    const relationship = (ordinal: number, anchorNodeId: string, y: number) => {
      const result = matchedVisualOrderReference({
        id: `cross-reference-figure-${ordinal}`,
        anchorNodeId,
        referenceRegionId: `${anchorNodeId}-region`,
        visualNodeId: `visual-${ordinal}`,
        page: 16,
        y,
      })
      return {
        ...result,
        text: `Figure ${ordinal}`,
        labels: [`Figure ${ordinal}`],
        targets: result.targets.map((target) => ({
          ...target,
          label: `Figure ${ordinal}`,
        })),
      } satisfies PdfScholarlyCrossReferenceRelationship
    }
    const sourceEvidence = (
      pageNumber: number,
      x: number,
      y: number,
      width = 0.36,
    ): NodeSourceEvidence => ({
      confidence: 1,
      pages: [pageNumber],
      regionIds: [`region-${pageNumber}-${x}-${y}`],
      boxes: [
        {
          page: pageNumber,
          x,
          y,
          width,
          height: 0.02,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })
    const provenance: Record<string, NodeSourceEvidence> = {
      'appendix-b': sourceEvidence(15, 0.55, 0.7),
      'appendix-b-4': sourceEvidence(16, 0.1, 0.2),
      'appendix-b-reference': sourceEvidence(16, 0.1, 0.24),
      'appendix-c': sourceEvidence(16, 0.1, 0.32),
      'appendix-c-reference': sourceEvidence(16, 0.1, 0.36),
      'appendix-d': sourceEvidence(16, 0.1, 0.7),
      'appendix-d-reference': sourceEvidence(16, 0.1, 0.74),
      'appendix-f': sourceEvidence(16, 0.55, 0.5),
      'appendix-f-reference': sourceEvidence(16, 0.55, 0.54),
      'visual-22': sourceEvidence(22, 0.1, 0.5, 0.8),
      'caption-22': sourceEvidence(22, 0.1, 0.82, 0.8),
      'visual-23': sourceEvidence(23, 0.1, 0.1, 0.8),
      'caption-23': sourceEvidence(23, 0.1, 0.46, 0.8),
      'visual-26': sourceEvidence(24, 0.1, 0.52, 0.8),
      'caption-26': sourceEvidence(24, 0.1, 0.89, 0.8),
      'visual-30': sourceEvidence(28, 0.1, 0.2, 0.8),
      'caption-30': sourceEvidence(28, 0.1, 0.78, 0.8),
      'appendix-g': sourceEvidence(32, 0.1, 0.18),
    }
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [22, 23, 26, 30].map((ordinal) => ({
        page: provenance[`caption-${ordinal}`].pages[0],
        column: 'single' as const,
        sourceBox: provenance[`caption-${ordinal}`].boxes[0],
        visualNodeId: `visual-${ordinal}`,
        captionNodeId: `caption-${ordinal}`,
      })),
      [
        relationship(22, 'appendix-b-reference', 0.24),
        relationship(23, 'appendix-c-reference', 0.36),
        relationship(26, 'appendix-d-reference', 0.74),
        relationship(30, 'appendix-f-reference', 0.54),
      ],
      diagnostics,
      provenance,
    )

    expect(nodes.map((node) => node.id)).toEqual([
      'appendix-b',
      'appendix-b-4',
      'appendix-b-reference',
      'visual-22',
      'caption-22',
      'appendix-c',
      'appendix-c-reference',
      'visual-23',
      'caption-23',
      'appendix-d',
      'appendix-d-reference',
      'visual-26',
      'caption-26',
      'appendix-f',
      'appendix-f-reference',
      'visual-30',
      'caption-30',
      'appendix-g',
    ])
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'AMBIGUOUS_READING_ORDER',
      ),
    ).toEqual([])
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'RESOLVED_READING_ORDER',
      ),
    ).toHaveLength(3)
  })

  it('falls back to atomic source order when a reference-scope move would invert a deferred float run', () => {
    const figure = (ordinal: number): ResearchNode => ({
      id: `source-ordered-visual-${ordinal}`,
      type: 'figure',
      objectType: 'figure',
      title: `Figure ${ordinal}. Deferred source result.`,
      relationships: {
        caption: `source-ordered-caption-${ordinal}`,
        assets: [`source-ordered-asset-${ordinal}`],
      },
      source: `pdf:test#page=${ordinal + 2}`,
    })
    const caption = (ordinal: number): ResearchNode => ({
      id: `source-ordered-caption-${ordinal}`,
      type: 'caption',
      text: `Figure ${ordinal}. Deferred source result.`,
      source: `pdf:test#page=${ordinal + 2}`,
    })
    const nodes: ResearchNode[] = [
      visualOrderHeading('source-scope-a', 2, 'A Earlier scope'),
      visualOrderParagraph(
        'source-scope-a-reference',
        'Figure 2 is discussed in the earlier scope.',
      ),
      visualOrderHeading('source-scope-b', 2, 'B Later scope'),
      visualOrderParagraph(
        'source-scope-b-reference',
        'Figure 1 is discussed in the later scope.',
      ),
      figure(1),
      caption(1),
      figure(2),
      caption(2),
      visualOrderHeading('source-scope-c', 2, 'C Following scope'),
    ]
    const sourceEvidence = (
      pageNumber: number,
      y: number,
    ): NodeSourceEvidence => ({
      confidence: 1,
      pages: [pageNumber],
      regionIds: [`source-region-${pageNumber}-${y}`],
      boxes: [
        {
          page: pageNumber,
          x: 0.1,
          y,
          width: 0.8,
          height: 0.03,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })
    const diagnostics: ReconstructionDiagnostic[] = []
    const sourceOrder = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [1, 2].map((ordinal) => ({
        page: ordinal + 2,
        column: 'single' as const,
        sourceBox: {
          page: ordinal + 2,
          x: 0.1,
          y: 0.2,
          width: 0.8,
          height: 0.2,
          rotation: 0,
          method: 'pdf-object' as const,
        },
        visualNodeId: `source-ordered-visual-${ordinal}`,
        captionNodeId: `source-ordered-caption-${ordinal}`,
      })),
      [
        matchedVisualOrderReference({
          id: 'source-order-reference-figure-1',
          anchorNodeId: 'source-scope-b-reference',
          referenceRegionId: 'source-scope-b-reference-region',
          visualNodeId: 'source-ordered-visual-1',
          page: 1,
          y: 0.42,
        }),
        matchedVisualOrderReference({
          id: 'source-order-reference-figure-2',
          anchorNodeId: 'source-scope-a-reference',
          referenceRegionId: 'source-scope-a-reference-region',
          visualNodeId: 'source-ordered-visual-2',
          page: 1,
          y: 0.18,
        }),
      ],
      diagnostics,
      {
        'source-scope-a': sourceEvidence(1, 0.1),
        'source-scope-a-reference': sourceEvidence(1, 0.18),
        'source-scope-b': sourceEvidence(1, 0.34),
        'source-scope-b-reference': sourceEvidence(1, 0.42),
        'source-ordered-visual-1': sourceEvidence(3, 0.2),
        'source-ordered-caption-1': sourceEvidence(3, 0.42),
        'source-ordered-visual-2': sourceEvidence(4, 0.2),
        'source-ordered-caption-2': sourceEvidence(4, 0.42),
        'source-scope-c': sourceEvidence(5, 0.1),
      },
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(
      nodes.flatMap((node, index) =>
        node.type === 'figure'
          ? [[node.id, nodes[index + 1]?.id] as const]
          : [],
      ),
    ).toEqual([
      ['source-ordered-visual-1', 'source-ordered-caption-1'],
      ['source-ordered-visual-2', 'source-ordered-caption-2'],
    ])
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          severity: 'info',
          message: expect.stringContaining(
            'reverse source-proved visual-caption pair order',
          ),
        }),
      ]),
    )
  })

  it('fails closed when a float fallback encounters a pre-existing reversed atomic pair order', () => {
    const nodes: ResearchNode[] = [
      visualOrderHeading('reversed-scope-a', 2, 'A. Earlier scope'),
      visualOrderParagraph(
        'reversed-scope-a-reference',
        'Figure 21 is discussed in the earlier scope.',
      ),
      visualOrderHeading('reversed-scope-b', 2, 'B. Later scope'),
      visualOrderParagraph(
        'reversed-scope-b-reference',
        'Figure 21 is also discussed in the later scope.',
      ),
      visualOrderFigure('reversed-visual-2', 'reversed-caption-2'),
      visualOrderCaption('reversed-caption-2'),
      visualOrderFigure('reversed-visual-1', 'reversed-caption-1'),
      visualOrderCaption('reversed-caption-1'),
    ]
    const sourceOrder = nodes.map((node) => node.id)
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 3,
          column: 'single',
          sourceBox: {
            page: 3,
            x: 0.1,
            y: 0.2,
            width: 0.8,
            height: 0.2,
            rotation: 0,
            method: 'pdf-object',
          },
          visualNodeId: 'reversed-visual-1',
          captionNodeId: 'reversed-caption-1',
        },
        {
          page: 4,
          column: 'single',
          sourceBox: {
            page: 4,
            x: 0.1,
            y: 0.2,
            width: 0.8,
            height: 0.2,
            rotation: 0,
            method: 'pdf-object',
          },
          visualNodeId: 'reversed-visual-2',
          captionNodeId: 'reversed-caption-2',
        },
      ],
      [
        matchedVisualOrderReference({
          id: 'reversed-scope-a-reference-relationship',
          anchorNodeId: 'reversed-scope-a-reference',
          referenceRegionId: 'reversed-scope-a-reference-region',
          visualNodeId: 'reversed-visual-1',
          page: 1,
          y: 0.2,
        }),
        matchedVisualOrderReference({
          id: 'reversed-scope-b-reference-relationship',
          anchorNodeId: 'reversed-scope-b-reference',
          referenceRegionId: 'reversed-scope-b-reference-region',
          visualNodeId: 'reversed-visual-1',
          page: 2,
          y: 0.2,
        }),
      ],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'error',
          message: expect.stringContaining(
            'source-proved atomic visual-caption order is not intact',
          ),
        }),
      ]),
    )
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'SOURCE_ORDER_FLOAT_FALLBACK',
      ),
    ).toEqual([])
  })

  it('uses physical source order rather than numeric labels for a safe float fallback', () => {
    const firstFigure = visualOrderFigure(
      'physical-visual-1',
      'physical-caption-1',
    ) as Extract<ResearchNode, { type: 'figure' }>
    firstFigure.title = 'Figure 1. First numbered result.'
    const firstCaption = {
      ...visualOrderCaption('physical-caption-1'),
      text: 'Figure 1. First numbered result.',
    } satisfies ResearchNode
    const secondFigure = visualOrderFigure(
      'physical-visual-2',
      'physical-caption-2',
    ) as Extract<ResearchNode, { type: 'figure' }>
    secondFigure.title = 'Figure 2. Second numbered result.'
    const secondCaption = {
      ...visualOrderCaption('physical-caption-2'),
      text: 'Figure 2. Second numbered result.',
    } satisfies ResearchNode
    const nodes: ResearchNode[] = [
      visualOrderHeading('physical-scope-a', 2, 'A. Earlier scope'),
      visualOrderParagraph(
        'physical-scope-a-reference',
        'Figure 1 is discussed in the earlier scope.',
      ),
      visualOrderHeading('physical-scope-b', 2, 'B. Later scope'),
      visualOrderParagraph(
        'physical-scope-b-reference',
        'Figure 1 is also discussed in the later scope.',
      ),
      secondFigure,
      secondCaption,
      firstFigure,
      firstCaption,
    ]
    const sourceOrder = nodes.map((node) => node.id)
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 4,
          column: 'single',
          sourceBox: {
            page: 4,
            x: 0.1,
            y: 0.2,
            width: 0.8,
            height: 0.2,
            rotation: 0,
            method: 'pdf-object',
          },
          visualNodeId: firstFigure.id,
          captionNodeId: firstCaption.id,
        },
        {
          page: 3,
          column: 'single',
          sourceBox: {
            page: 3,
            x: 0.1,
            y: 0.2,
            width: 0.8,
            height: 0.2,
            rotation: 0,
            method: 'pdf-object',
          },
          visualNodeId: secondFigure.id,
          captionNodeId: secondCaption.id,
        },
      ],
      [
        matchedVisualOrderReference({
          id: 'physical-scope-a-reference-relationship',
          anchorNodeId: 'physical-scope-a-reference',
          referenceRegionId: 'physical-scope-a-reference-region',
          visualNodeId: firstFigure.id,
          page: 1,
          y: 0.2,
        }),
        matchedVisualOrderReference({
          id: 'physical-scope-b-reference-relationship',
          anchorNodeId: 'physical-scope-b-reference',
          referenceRegionId: 'physical-scope-b-reference-region',
          visualNodeId: firstFigure.id,
          page: 2,
          y: 0.2,
        }),
      ],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          severity: 'info',
        }),
      ]),
    )
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'AMBIGUOUS_READING_ORDER',
      ),
    ).toEqual([])
  })

  it('atomically places adjacent unreferenced deferred floats in the unique slot bounded by proved appendix scopes', () => {
    const figure = (ordinal: number): ResearchNode => ({
      id: `bounded-visual-${ordinal}`,
      type: 'figure',
      objectType: 'figure',
      title: `Figure ${ordinal}. Deferred prompt.`,
      relationships: {
        caption: `bounded-caption-${ordinal}`,
        assets: [`bounded-asset-${ordinal}`],
      },
      source: `pdf:test#page=${ordinal}`,
    })
    const caption = (ordinal: number): ResearchNode => ({
      id: `bounded-caption-${ordinal}`,
      type: 'caption',
      text: `Figure ${ordinal}. Deferred prompt.`,
      source: `pdf:test#page=${ordinal}`,
    })
    const nodes: ResearchNode[] = [
      visualOrderHeading('bounded-b-3', 2, 'B.3 Analyzer prompts'),
      visualOrderParagraph(
        'bounded-b-3-reference',
        'The analyzer prompt appears in Figure 21.',
      ),
      visualOrderHeading('bounded-b-4', 2, 'B.4 Experiment prompts'),
      visualOrderParagraph(
        'bounded-b-4-prose',
        'The next source prompt is described here.',
      ),
      visualOrderHeading('bounded-c', 1, 'C Human evaluation'),
      visualOrderParagraph(
        'bounded-c-reference',
        'The interface appears in Figure 24.',
      ),
      figure(21),
      caption(21),
      figure(22),
      caption(22),
      figure(23),
      caption(23),
      figure(24),
      caption(24),
      visualOrderHeading('bounded-g', 1, 'G Generated story'),
    ]
    const evidence = (
      pageNumber: number,
      x: number,
      y: number,
      width = 0.36,
    ): NodeSourceEvidence => ({
      confidence: 1,
      pages: [pageNumber],
      regionIds: [`bounded-region-${pageNumber}-${x}-${y}`],
      boxes: [
        {
          page: pageNumber,
          x,
          y,
          width,
          height: 0.02,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })
    const provenance: Record<string, NodeSourceEvidence> = {
      'bounded-b-3': evidence(15, 0.55, 0.7),
      'bounded-b-3-reference': evidence(16, 0.1, 0.08),
      'bounded-b-4': evidence(16, 0.1, 0.2),
      'bounded-b-4-prose': evidence(16, 0.1, 0.24),
      'bounded-c': evidence(16, 0.1, 0.32),
      'bounded-c-reference': evidence(16, 0.1, 0.36),
      'bounded-visual-21': evidence(21, 0.1, 0.1, 0.8),
      'bounded-caption-21': evidence(21, 0.1, 0.45, 0.8),
      'bounded-visual-22': evidence(22, 0.1, 0.1, 0.8),
      'bounded-caption-22': evidence(22, 0.1, 0.45, 0.8),
      'bounded-visual-23': evidence(23, 0.1, 0.1, 0.8),
      'bounded-caption-23': evidence(23, 0.1, 0.45, 0.8),
      'bounded-visual-24': evidence(24, 0.1, 0.1, 0.8),
      'bounded-caption-24': evidence(24, 0.1, 0.45, 0.8),
      'bounded-g': evidence(32, 0.1, 0.18),
    }
    const reference = (ordinal: number, anchorNodeId: string, y: number) => {
      const result = matchedVisualOrderReference({
        id: `bounded-reference-${ordinal}`,
        anchorNodeId,
        referenceRegionId: `${anchorNodeId}-region`,
        visualNodeId: `bounded-visual-${ordinal}`,
        page: 16,
        y,
      })
      return {
        ...result,
        text: `Figure ${ordinal}`,
        labels: [`Figure ${ordinal}`],
        targets: result.targets.map((target) => ({
          ...target,
          label: `Figure ${ordinal}`,
        })),
      } satisfies PdfScholarlyCrossReferenceRelationship
    }
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [21, 22, 23, 24].map((ordinal) => ({
        page: ordinal,
        column: 'single' as const,
        sourceBox: provenance[`bounded-caption-${ordinal}`].boxes[0],
        visualNodeId: `bounded-visual-${ordinal}`,
        captionNodeId: `bounded-caption-${ordinal}`,
      })),
      [
        reference(21, 'bounded-b-3-reference', 0.08),
        reference(24, 'bounded-c-reference', 0.36),
      ],
      diagnostics,
      provenance,
    )

    expect(nodes.map((node) => node.id)).toEqual([
      'bounded-b-3',
      'bounded-b-3-reference',
      'bounded-visual-21',
      'bounded-caption-21',
      'bounded-b-4',
      'bounded-b-4-prose',
      'bounded-visual-22',
      'bounded-caption-22',
      'bounded-visual-23',
      'bounded-caption-23',
      'bounded-c',
      'bounded-c-reference',
      'bounded-visual-24',
      'bounded-caption-24',
      'bounded-g',
    ])
    expect(diagnostics).toEqual(
      expect.arrayContaining(
        [22, 23].map((pageNumber) =>
          expect.objectContaining({
            code: 'RESOLVED_READING_ORDER',
            severity: 'info',
            page: pageNumber,
            sourceBoxes: [provenance[`bounded-caption-${pageNumber}`].boxes[0]],
          }),
        ),
      ),
    )
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'AMBIGUOUS_READING_ORDER',
      ),
    ).toEqual([])

    const rollbackNodes: ResearchNode[] = [
      visualOrderHeading('bounded-b-3', 2, 'B.3 Analyzer prompts'),
      visualOrderParagraph(
        'bounded-b-3-reference',
        'The analyzer prompt appears in Figure 21.',
      ),
      visualOrderHeading('bounded-b-4', 2, 'B.4 Experiment prompts'),
      visualOrderParagraph(
        'bounded-b-4-prose',
        'The next source prompt is described here.',
      ),
      visualOrderHeading('bounded-c', 1, 'C Human evaluation'),
      visualOrderParagraph(
        'bounded-c-reference',
        'The interface appears in Figure 24.',
      ),
      figure(21),
      caption(21),
      figure(23),
      caption(23),
      figure(22),
      caption(22),
      figure(24),
      caption(24),
      visualOrderHeading('bounded-g', 1, 'G Generated story'),
    ]
    const rollbackProvenance: Record<string, NodeSourceEvidence> = {
      ...provenance,
      'bounded-visual-22': evidence(23, 0.1, 0.1, 0.8),
      'bounded-caption-22': evidence(23, 0.1, 0.45, 0.8),
      'bounded-visual-23': evidence(22, 0.1, 0.1, 0.8),
      'bounded-caption-23': evidence(22, 0.1, 0.45, 0.8),
    }
    const rollbackDiagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      rollbackNodes,
      [21, 22, 23, 24].map((ordinal) => ({
        page: rollbackProvenance[`bounded-caption-${ordinal}`].boxes[0].page,
        column: 'single' as const,
        sourceBox: rollbackProvenance[`bounded-caption-${ordinal}`].boxes[0],
        visualNodeId: `bounded-visual-${ordinal}`,
        captionNodeId: `bounded-caption-${ordinal}`,
      })),
      [
        reference(21, 'bounded-b-3-reference', 0.08),
        reference(24, 'bounded-c-reference', 0.36),
      ],
      rollbackDiagnostics,
      rollbackProvenance,
    )

    const rollbackOrder = rollbackNodes.map((node) => node.id)
    expect(rollbackOrder).toEqual([
      'bounded-b-3',
      'bounded-b-3-reference',
      'bounded-b-4',
      'bounded-b-4-prose',
      'bounded-c',
      'bounded-c-reference',
      'bounded-visual-21',
      'bounded-caption-21',
      'bounded-visual-23',
      'bounded-caption-23',
      'bounded-visual-22',
      'bounded-caption-22',
      'bounded-visual-24',
      'bounded-caption-24',
      'bounded-g',
    ])
    expect(
      rollbackDiagnostics.filter(
        (diagnostic) =>
          diagnostic.code === 'RESOLVED_READING_ORDER' &&
          (diagnostic.page === 22 || diagnostic.page === 23),
      ),
    ).toEqual([])
    expect(
      rollbackDiagnostics.filter(
        (diagnostic) =>
          diagnostic.code === 'SOURCE_ORDER_FLOAT_FALLBACK' &&
          (diagnostic.page === 22 || diagnostic.page === 23),
      ),
    ).toHaveLength(2)
  })

  it('does not relocate a physical float into a later cross-reference scope', () => {
    const visualNodeId = 'visual-before-later-reference'
    const captionNodeId = 'caption-before-later-reference'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 Physical figure scope'),
      visualOrderParagraph('scope-a-prose', 'Earlier prose remains unchanged.'),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
      visualOrderHeading('scope-b', 2, 'A.2 Later discussion'),
      visualOrderParagraph(
        'later-reference',
        'The later discussion cross-references Figure 21.',
      ),
      visualOrderHeading('scope-c', 2, 'A.3 Following discussion'),
    ]
    const laterReference = matchedVisualOrderReference({
      id: 'cross-reference-later-physical-scope',
      anchorNodeId: 'later-reference',
      referenceRegionId: 'later-reference-region',
      visualNodeId,
      page: 2,
      y: 0.3,
    })
    const sourceOrder = nodes.map((node) => node.id)
    const diagnostics: ReconstructionDiagnostic[] = []

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
          severity: 'info',
          relationshipId: laterReference.id,
        }),
      ]),
    )
  })

  it('preserves sequential figure labels when a later section references the earlier float', () => {
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 First physical scope'),
      visualOrderFigure('visual-five', 'caption-five'),
      {
        ...visualOrderCaption('caption-five'),
        text: 'Figure 5. First source-backed result.',
      },
      visualOrderHeading('scope-b', 2, 'A.2 Second physical scope'),
      visualOrderParagraph(
        'later-reference',
        'The second discussion revisits Figure 21.',
      ),
      visualOrderFigure('visual-six', 'caption-six'),
      {
        ...visualOrderCaption('caption-six'),
        text: 'Figure 6. Second source-backed result.',
      },
    ]
    const laterReference = matchedVisualOrderReference({
      id: 'cross-reference-later-sequential-float',
      anchorNodeId: 'later-reference',
      referenceRegionId: 'later-reference-region',
      visualNodeId: 'visual-five',
      page: 2,
      y: 0.3,
    })

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
          visualNodeId: 'visual-five',
          captionNodeId: 'caption-five',
        },
        {
          page: 2,
          column: 'left',
          sourceBox: {
            page: 2,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-six',
          captionNodeId: 'caption-six',
        },
      ],
      [laterReference],
    )

    expect(
      nodes.flatMap((node) =>
        node.type === 'caption' ? [node.text.match(/^Figure \d+/u)?.[0]] : [],
      ),
    ).toEqual(['Figure 5', 'Figure 6'])
  })

  it('inserts an earlier unscoped float before a later physical float already in the target scope', () => {
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-four', 2, '4. Earlier scope'),
      visualOrderFigure('visual-five', 'caption-five'),
      {
        ...visualOrderCaption('caption-five'),
        text: 'Figure 5. Earlier source float.',
      },
      visualOrderHeading('scope-five', 2, '5. Target scope'),
      visualOrderParagraph(
        'figure-five-reference',
        'The target scope begins by discussing Figure 21.',
      ),
      visualOrderFigure('visual-six', 'caption-six'),
      {
        ...visualOrderCaption('caption-six'),
        text: 'Figure 6. Later physical float.',
      },
      visualOrderHeading('scope-five-two', 2, '5.2 Following scope'),
    ]
    const figureFiveReference = matchedVisualOrderReference({
      id: 'cross-reference-target-scope-figure-five',
      anchorNodeId: 'figure-five-reference',
      referenceRegionId: 'figure-five-reference-region',
      visualNodeId: 'visual-five',
      page: 5,
      y: 0.7,
    })
    const evidence = (
      pageNumber: number,
      x: number,
      y: number,
    ): NodeSourceEvidence => ({
      confidence: 1,
      pages: [pageNumber],
      regionIds: [`region-${pageNumber}-${x}-${y}`],
      boxes: [
        {
          page: pageNumber,
          x,
          y,
          width: 0.36,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 5,
          column: 'right',
          sourceBox: {
            page: 5,
            x: 0.55,
            y: 0.2,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-five',
          captionNodeId: 'caption-five',
        },
        {
          page: 6,
          column: 'left',
          sourceBox: {
            page: 6,
            x: 0.1,
            y: 0.4,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-six',
          captionNodeId: 'caption-six',
        },
      ],
      [figureFiveReference],
      [],
      {
        'scope-four': evidence(4, 0.1, 0.7),
        'scope-five': evidence(5, 0.1, 0.3),
        'scope-five-two': evidence(6, 0.1, 0.7),
      },
    )

    expect(
      nodes.flatMap((node) =>
        node.type === 'caption' ? [node.text.match(/^Figure \d+/u)?.[0]] : [],
      ),
    ).toEqual(['Figure 5', 'Figure 6'])
  })

  it('orders integer-labeled floats sequentially when several resolve to the same scope', () => {
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-c', 1, 'C. Earlier appendix'),
      visualOrderFigure('visual-eighteen', 'caption-eighteen'),
      {
        ...visualOrderCaption('caption-eighteen'),
        text: 'Figure 18. Later numbered result.',
      },
      visualOrderFigure('visual-seventeen', 'caption-seventeen'),
      {
        ...visualOrderCaption('caption-seventeen'),
        text: 'Figure 17. Earlier numbered result.',
      },
      visualOrderHeading('scope-d', 1, 'D. Target appendix'),
      visualOrderParagraph(
        'figure-eighteen-reference',
        'Figure 21 is discussed in this appendix.',
      ),
      visualOrderParagraph(
        'figure-seventeen-reference',
        'Figure 21 is also discussed in this appendix.',
      ),
      visualOrderHeading('scope-e', 1, 'E. Following appendix'),
    ]
    const evidence = (
      pageNumber: number,
      x: number,
      y: number,
    ): NodeSourceEvidence => ({
      confidence: 1,
      pages: [pageNumber],
      regionIds: [`region-${pageNumber}-${x}-${y}`],
      boxes: [
        {
          page: pageNumber,
          x,
          y,
          width: 0.36,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 6,
          column: 'left',
          sourceBox: {
            page: 6,
            x: 0.1,
            y: 0.2,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-eighteen',
          captionNodeId: 'caption-eighteen',
        },
        {
          page: 6,
          column: 'right',
          sourceBox: {
            page: 6,
            x: 0.55,
            y: 0.2,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: 'visual-seventeen',
          captionNodeId: 'caption-seventeen',
        },
      ],
      [
        matchedVisualOrderReference({
          id: 'target-scope-figure-eighteen',
          anchorNodeId: 'figure-eighteen-reference',
          referenceRegionId: 'figure-eighteen-reference-region',
          visualNodeId: 'visual-eighteen',
          page: 5,
          y: 0.3,
        }),
        matchedVisualOrderReference({
          id: 'target-scope-figure-seventeen',
          anchorNodeId: 'figure-seventeen-reference',
          referenceRegionId: 'figure-seventeen-reference-region',
          visualNodeId: 'visual-seventeen',
          page: 5,
          y: 0.4,
        }),
      ],
      [],
      {
        'scope-c': evidence(4, 0.1, 0.2),
        'scope-d': evidence(5, 0.1, 0.2),
        'scope-e': evidence(7, 0.1, 0.2),
      },
    )

    expect(
      nodes.flatMap((node) =>
        node.type === 'caption' ? [node.text.match(/^Figure \d+/u)?.[0]] : [],
      ),
    ).toEqual(['Figure 17', 'Figure 18'])
  })

  it('uses the unique nearest reference scope only when no same-column physical heading scopes the float', () => {
    const visualNodeId = 'visual-unscoped-float'
    const captionNodeId = 'caption-unscoped-float'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-b', 1, 'B. Earlier appendix'),
      visualOrderParagraph(
        'scope-b-reference',
        'Figure 21 is mentioned in the earlier appendix.',
      ),
      visualOrderHeading('scope-d', 1, 'D. Direct appendix'),
      visualOrderParagraph(
        'scope-d-reference',
        'Figure 21 is discussed immediately before its float page.',
      ),
      visualOrderHeading('scope-e-right', 1, 'E. Right-column prose'),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
      visualOrderHeading('scope-f', 1, 'F. Following appendix'),
    ]
    const earlierReference = matchedVisualOrderReference({
      id: 'cross-reference-earlier-unscoped-float',
      anchorNodeId: 'scope-b-reference',
      referenceRegionId: 'scope-b-reference-region',
      visualNodeId,
      page: 1,
      y: 0.3,
    })
    const directReference = matchedVisualOrderReference({
      id: 'cross-reference-direct-unscoped-float',
      anchorNodeId: 'scope-d-reference',
      referenceRegionId: 'scope-d-reference-region',
      visualNodeId,
      page: 2,
      y: 0.7,
    })
    directReference.sourceBoxes = [
      directReference.sourceBoxes[0],
      {
        ...directReference.sourceBoxes[0],
        y: 0.74,
      },
    ]
    const sourceEvidence = (
      pageNumber: number,
      x: number,
      y: number,
    ): NodeSourceEvidence => ({
      confidence: 1,
      pages: [pageNumber],
      regionIds: [`region-${pageNumber}-${x}-${y}`],
      boxes: [
        {
          page: pageNumber,
          x,
          y,
          width: 0.36,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      links: [],
    })
    const diagnostics: ReconstructionDiagnostic[] = []

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 3,
          column: 'left',
          sourceBox: {
            page: 3,
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
      [earlierReference, directReference],
      diagnostics,
      {
        'scope-b': sourceEvidence(1, 0.55, 0.1),
        'scope-d': sourceEvidence(2, 0.55, 0.1),
        'scope-e-right': sourceEvidence(3, 0.55, 0.2),
        'scope-f': sourceEvidence(4, 0.1, 0.1),
      },
    )

    expect(nodes.map((node) => node.id)).toEqual([
      'scope-b',
      'scope-b-reference',
      'scope-d',
      'scope-d-reference',
      visualNodeId,
      captionNodeId,
      'scope-e-right',
      'scope-f',
    ])
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RESOLVED_READING_ORDER',
          relationshipId: directReference.id,
          severity: 'info',
        }),
      ]),
    )
  })

  it('keeps a source-proved visual cluster when exact references span sibling sections', () => {
    const heading = (
      id: string,
      level: 1 | 2 | 3,
      text: string,
    ): ResearchNode => ({
      id,
      type: 'heading',
      level,
      text,
      source: 'pdf:test#page=1',
    })
    const paragraph = (id: string, text: string): ResearchNode => ({
      id,
      type: 'paragraph',
      text,
      source: 'pdf:test#page=1',
    })
    const figure: ResearchNode = {
      id: 'visual-result',
      type: 'figure',
      objectType: 'figure',
      title: 'Figure 7. Source-backed result.',
      relationships: {
        caption: 'caption-result',
        assets: ['asset-result'],
      },
      source: 'pdf:test#page=2',
    }
    const caption: ResearchNode = {
      id: 'caption-result',
      type: 'caption',
      text: 'Figure 7. Source-backed result.',
      source: 'pdf:test#page=2',
    }
    const nodes: ResearchNode[] = [
      heading('appendix-c', 1, 'C. Evidence'),
      heading('appendix-c-2', 2, 'C.2. Replication evidence'),
      paragraph('c-reference', 'The complete result appears in Figure 7.'),
      paragraph('c-conclusion', 'The evidence remains source-backed.'),
      heading('appendix-d', 1, 'D. Later analysis'),
      paragraph(
        'd-reference',
        'Figure 7 is mentioned again in later analysis.',
      ),
      heading('appendix-d-1', 2, 'D.1. Unrelated method'),
      paragraph('d-prose', 'The later analysis remains ordinary prose.'),
      figure,
      caption,
    ]
    const crossReference: PdfScholarlyCrossReferenceRelationship = {
      id: 'cross-reference-figure-7',
      kind: 'figure',
      text: 'Figure 7',
      labels: ['Figure 7'],
      referenceRegionId: 'c-reference-region',
      referenceStart: 31,
      referenceEnd: 39,
      targets: [
        {
          kind: 'figure',
          label: 'Figure 7',
          referenceStart: 31,
          referenceEnd: 39,
          status: 'matched',
          candidateNodeIds: ['visual-result'],
          targetNodeId: 'visual-result',
          evidence: ['canonical-label-unique'],
        },
      ],
      targetNodeIds: ['visual-result'],
      status: 'matched',
      canonicalAnchor: {
        nodeId: 'c-reference',
        start: 31,
        end: 39,
      },
      confidence: 1,
      evidence: ['explicit-scholarly-cross-reference-syntax'],
      sourceBoxes: [
        {
          page: 1,
          x: 0.1,
          y: 0.3,
          width: 0.7,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
    }
    const laterCrossReference: PdfScholarlyCrossReferenceRelationship = {
      ...crossReference,
      id: 'cross-reference-later-figure-7',
      referenceRegionId: 'd-reference-region',
      referenceStart: 0,
      referenceEnd: 8,
      targets: crossReference.targets.map((target) => ({
        ...target,
        referenceStart: 0,
        referenceEnd: 8,
      })),
      canonicalAnchor: {
        nodeId: 'd-reference',
        start: 0,
        end: 8,
      },
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
    const diagnostics: ReconstructionDiagnostic[] = []
    const sourceOrder = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 2,
          column: 'single',
          sourceBox: {
            page: 2,
            x: 0.1,
            y: 0.7,
            width: 0.36,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
          visualNodeId: figure.id,
          captionNodeId: caption.id,
        },
      ],
      [crossReference, laterCrossReference],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          severity: 'info',
          sourceBoxes: [
            crossReference.sourceBoxes[0],
            laterCrossReference.sourceBoxes[0],
          ],
        }),
      ]),
    )
  })

  it('retains physical source order when all exact references belong to another heading scope', () => {
    const visualNodeId = 'visual-same-scope'
    const captionNodeId = 'caption-same-scope'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 Shared scope'),
      visualOrderParagraph(
        'early-reference',
        'Figure 21 first appears in this scope.',
      ),
      visualOrderParagraph('scope-prose', 'The scoped discussion continues.'),
      visualOrderParagraph(
        'later-reference',
        'Figure 21 appears again in this same scope.',
      ),
      visualOrderHeading('deeper-scope', 3, 'A.1.1 Deeper detail'),
      visualOrderParagraph(
        'deeper-prose',
        'A deeper heading does not close the containing level-two scope.',
      ),
      visualOrderHeading('scope-b', 2, 'A.2 Equal sibling'),
      visualOrderParagraph(
        'sibling-prose',
        'The sibling discussion is unrelated.',
      ),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
    ]
    const earlyReference = matchedVisualOrderReference({
      id: 'cross-reference-early-figure-21',
      anchorNodeId: 'early-reference',
      referenceRegionId: 'early-reference-region',
      visualNodeId,
      page: 1,
      y: 0.3,
    })
    const laterReference = matchedVisualOrderReference({
      id: 'cross-reference-later-figure-21',
      anchorNodeId: 'later-reference',
      referenceRegionId: 'later-reference-region',
      visualNodeId,
      page: 2,
      y: 0.2,
    })
    const diagnostics: ReconstructionDiagnostic[] = []
    const sourceOrder = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 3,
          column: 'left',
          sourceBox: {
            page: 3,
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
      [laterReference, earlyReference],
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

  it('keeps a visual at source order and records ambiguity when exact references span heading scopes', () => {
    const visualNodeId = 'visual-multi-scope'
    const captionNodeId = 'caption-multi-scope'
    const nodes: ResearchNode[] = [
      visualOrderHeading('scope-a', 2, 'A.1 First scope'),
      visualOrderParagraph(
        'scope-a-reference',
        'Figure 21 appears in the first scope.',
      ),
      visualOrderHeading('scope-b', 2, 'A.2 Second scope'),
      visualOrderParagraph(
        'scope-b-reference',
        'Figure 21 also appears in the second scope.',
      ),
      visualOrderHeading('scope-c', 2, 'A.3 Source visual location'),
      visualOrderParagraph(
        'source-location-prose',
        'The source flow remains unchanged when placement is ambiguous.',
      ),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
    ]
    const firstScopeReference = matchedVisualOrderReference({
      id: 'cross-reference-first-scope-figure-21',
      anchorNodeId: 'scope-a-reference',
      referenceRegionId: 'scope-a-reference-region',
      visualNodeId,
      page: 1,
      y: 0.3,
    })
    const secondScopeReference = matchedVisualOrderReference({
      id: 'cross-reference-second-scope-figure-21',
      anchorNodeId: 'scope-b-reference',
      referenceRegionId: 'scope-b-reference-region',
      visualNodeId,
      page: 2,
      y: 0.2,
    })
    const diagnostics: ReconstructionDiagnostic[] = []
    const sourceOrder = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 3,
          column: 'left',
          sourceBox: {
            page: 3,
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
      [firstScopeReference, secondScopeReference],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_ORDER_FLOAT_FALLBACK',
          severity: 'info',
          sourceBoxes: [
            firstScopeReference.sourceBoxes[0],
            secondScopeReference.sourceBoxes[0],
          ],
          target: {
            regionIds: [
              firstScopeReference.referenceRegionId,
              secondScopeReference.referenceRegionId,
            ],
            markerId: null,
          },
        }),
      ]),
    )
  })

  it('keeps a visual at source order when exact references span the document root and a heading scope', () => {
    const visualNodeId = 'visual-root-and-heading-scope'
    const captionNodeId = 'caption-root-and-heading-scope'
    const nodes: ResearchNode[] = [
      visualOrderParagraph(
        'root-reference',
        'Figure 21 is previewed before any heading.',
      ),
      visualOrderHeading('scope-a', 1, 'A. Scoped evidence'),
      visualOrderParagraph(
        'scoped-reference',
        'Figure 21 also appears in this heading scope.',
      ),
      visualOrderHeading('scope-b', 1, 'B. Source visual location'),
      visualOrderFigure(visualNodeId, captionNodeId),
      visualOrderCaption(captionNodeId),
    ]
    const rootReference = matchedVisualOrderReference({
      id: 'cross-reference-root-figure-21',
      anchorNodeId: 'root-reference',
      referenceRegionId: 'root-reference-region',
      visualNodeId,
      page: 1,
      y: 0.2,
    })
    const scopedReference = matchedVisualOrderReference({
      id: 'cross-reference-scoped-figure-21',
      anchorNodeId: 'scoped-reference',
      referenceRegionId: 'scoped-reference-region',
      visualNodeId,
      page: 2,
      y: 0.2,
    })
    const diagnostics: ReconstructionDiagnostic[] = []
    const sourceOrder = nodes.map((node) => node.id)

    orderCanonicalVisualPairs(
      nodes,
      [
        {
          page: 3,
          column: 'left',
          sourceBox: {
            page: 3,
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
      [rootReference, scopedReference],
      diagnostics,
    )

    expect(nodes.map((node) => node.id)).toEqual(sourceOrder)
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'AMBIGUOUS_READING_ORDER',
      ),
    ).toEqual([])
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'SOURCE_ORDER_FLOAT_FALLBACK',
      ),
    ).toEqual([
      expect.objectContaining({
        severity: 'info',
        sourceBoxes: [
          rootReference.sourceBoxes[0],
          scopedReference.sourceBoxes[0],
        ],
        target: {
          regionIds: [
            rootReference.referenceRegionId,
            scopedReference.referenceRegionId,
          ],
          markerId: null,
        },
      }),
    ])
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === 'RESOLVED_READING_ORDER',
      ),
    ).toEqual([])
  })

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

  it('retains source-text equation lineage when the equation is its own caption', async () => {
    const equationRun = run(1, 'E = m c 2', 0.3, 0.28, 0.24, 12)
    const result = await reconstructPageAnalyses({
      pages: [page(1, [equationRun])],
      sourceHash: 'b'.repeat(64),
      fileName: 'source-text-equation.pdf',
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

    const relationship = result.visualRelationships.find(
      (candidate) => candidate.kind === 'equation',
    )!
    const asset = result.assets.find(
      (candidate) => candidate.id === relationship.assetIds[0],
    )!

    expect(relationship).toMatchObject({
      status: 'matched',
      altTextSource: 'source-text',
      captionRegionId: relationship.sourceRegionIds[0],
      sourceObjectIds: [expect.stringMatching(/^equation-source-/)],
      canonicalNodeId: expect.any(String),
      captionNodeId: expect.any(String),
    })
    expect(relationship.sourceBoxes).toHaveLength(2)
    expect(relationship.sourceBoxes[0]).toEqual(relationship.sourceBoxes[1])
    expect(relationship.sourceBoxes[1]).toEqual(asset.sourceBoxes[0])
    expect(result.provenance[relationship.canonicalNodeId!].boxes).toEqual(
      relationship.sourceBoxes,
    )
    expect(
      validatedPdfVisualRelationships({
        paper: result.paper,
        provenance: result.provenance,
        relationships: result.visualRelationships,
        assets: result.assets,
        regions: result.regions,
        pages: result.pages,
      }),
    ).toEqual([relationship])
  })

  it('keeps a generated numbered-equation label plain while retaining source lineage', async () => {
    const base = {
      ...run(1, 'd', 0.3, 0.28, 0.012, 12),
      fontName: 'Synthetic-CMMI10',
    }
    const unencodedSubscript = {
      ...run(1, 'i', 0.312, 0.287, 0.008, 7),
      height: 0.009,
      fontName: 'Synthetic-CMMI7',
    }
    const formulaTail = {
      ...run(1, ' = Model(x), (2)', 0.322, 0.28, 0.3, 12),
      fontName: 'Synthetic-CMR10',
    }
    const result = await reconstructPageAnalyses({
      pages: [page(1, [base, unencodedSubscript, formulaTail])],
      sourceHash: '2'.repeat(64),
      fileName: 'generated-equation-label.pdf',
      byteLength: 2048,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 16,
          height: 6,
          pixels: new Uint8Array(16 * 6 * 4).fill(96),
        }),
    })

    const relationship = result.visualRelationships.find(
      (candidate) => candidate.kind === 'equation',
    )!
    const caption = result.paper.nodes.find(
      (node) => node.id === relationship.captionNodeId,
    )
    expect(relationship).toMatchObject({
      label: 'Equation 2',
      status: 'matched',
      sourceText: '',
      altText: 'Equation 2',
      altTextSource: 'caption',
    })
    expect(caption).toMatchObject({
      type: 'caption',
      text: 'Equation 2',
    })
    expect(caption).not.toHaveProperty('inlineRuns')
    expect(result.provenance[relationship.captionNodeId!]).toMatchObject({
      regionIds: [relationship.captionRegionId],
      boxes: expect.any(Array),
    })

    const epub = await buildReadableEpub(result.paper, result)
    const content = strFromU8(
      inspectEpub(epub.bytes).files['EPUB/content.xhtml'],
    )
    expect(content).toContain(
      `<figcaption id="${relationship.captionNodeId}" data-canonical-id="${relationship.captionNodeId}" class="equation-number-caption visually-hidden">Equation 2</figcaption>`,
    )
  })

  it('keeps an inline display equation between the prose that introduces and explains it', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'We steer the residual stream at each decoding step:',
            0.12,
            0.2,
            0.65,
            10,
          ),
          run(1, 'hℓ ← hℓ + α · vℓ,', 0.34, 0.3, 0.32, 12),
          run(1, '* Supporting detail.', 0.12, 0.88, 0.24, 8),
        ]),
        page(2, [
          run(
            2,
            'where α is a scalar steering coefficient.',
            0.12,
            0.12,
            0.5,
            10,
          ),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'equation-prose-order.pdf',
      byteLength: 2048,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 16,
          height: 6,
          pixels: new Uint8Array(16 * 6 * 4).fill(96),
        }),
    })
    const relationship = result.visualRelationships.find(
      (candidate) => candidate.kind === 'equation',
    )!
    const introducingIndex = result.paper.nodes.findIndex(
      (node) =>
        node.type === 'paragraph' &&
        node.text === 'We steer the residual stream at each decoding step:',
    )
    const equationIndex = result.paper.nodes.findIndex(
      (node) => node.id === relationship.canonicalNodeId,
    )
    const captionIndex = result.paper.nodes.findIndex(
      (node) => node.id === relationship.captionNodeId,
    )
    const explanationIndex = result.paper.nodes.findIndex(
      (node) =>
        node.type === 'paragraph' &&
        node.text === 'where α is a scalar steering coefficient.',
    )
    const footnoteIndex = result.paper.nodes.findIndex(
      (node) => node.type === 'footnote' && node.text === 'Supporting detail.',
    )

    expect(relationship).toMatchObject({
      status: 'matched',
      sourceText: 'hℓ ← hℓ + α · vℓ,',
    })
    expect([
      introducingIndex,
      equationIndex,
      captionIndex,
      explanationIndex,
      footnoteIndex,
    ]).toEqual([
      expect.any(Number),
      introducingIndex + 1,
      equationIndex + 1,
      captionIndex + 1,
      explanationIndex + 1,
    ])
    expect(introducingIndex).toBeGreaterThan(-1)
  })

  it('uses a source equation label without publishing an unsafe glyph transcript', async () => {
    const opening = run(1, '\u0012', 0.81, 0.09, 0.012, 10)
    opening.fontName = 'Synthetic-CMEX10'
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ordinary prose establishes the body font.', 0.1, 0.3, 0.36),
          run(1, 'Another ordinary prose line.', 0.1, 0.33, 0.3),
          opening,
          run(1, 'N(a,b) = c + d', 0.5, 0.115, 0.35, 12),
          run(1, 'd(a,b) = e', 0.52, 0.135, 0.3, 12),
          run(1, '(3)', 0.87, 0.155, 0.02, 10),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'unsafe-source-equation.pdf',
      byteLength: 2048,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 16,
          height: 6,
          pixels: new Uint8Array(16 * 6 * 4).fill(96),
        }),
    })

    const relationship = result.visualRelationships.find(
      (candidate) => candidate.kind === 'equation',
    )!
    expect(relationship).toMatchObject({
      status: 'matched',
      label: 'Equation 3',
      sourceText: '',
      altText: 'Equation 3',
      altTextSource: 'caption',
      canonicalNodeId: expect.any(String),
      captionNodeId: expect.any(String),
      evidence: expect.arrayContaining(['source-text-transcript-unresolved']),
    })
    expect(
      result.paper.nodes.find((node) => node.id === relationship.captionNodeId),
    ).toMatchObject({ type: 'caption', text: 'Equation 3' })
    expect(
      result.paper.nodes.some(
        (node) =>
          'text' in node &&
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(node.text),
      ),
    ).toBe(false)
  })

  it('keeps a proved split inline formula inside one prose paragraph without resolving its two-dimensional obligation', async () => {
    const continuedAfter = run(
      1,
      'and cites the source-backed reference [42].',
      0.266,
      0.365,
      0.34,
    )
    Object.assign(continuedAfter, {
      sourceSequenceIndex: 10,
      sourceWhitespaceBefore: 'pdf-text-item' as const,
      sourceWhitespacePredecessorIndex: 9,
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.42),
          run(
            1,
            'A second ordinary prose line remains intact.',
            0.1,
            0.23,
            0.44,
          ),
          ...splitInlineProseEquationRuns({
            afterText: '). The first term records the local drift',
            extraRuns: [continuedAfter],
          }),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[42] Source-backed reference.', 0.1, 0.72, 0.72, 7),
        ]),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'split-inline-prose-equation.pdf',
      byteLength: 4096,
      rasterizeFigure: async () => {
        throw new Error('source crop unavailable')
      },
    })

    const relationship = result.visualRelationships.find(
      (candidate) =>
        candidate.kind === 'equation' &&
        candidate.status === 'unresolved' &&
        candidate.evidence.includes('source-text-transcript-unresolved'),
    )
    expect(relationship).toBeDefined()
    const formulaLineIds =
      relationship?.sourceLineIds?.filter((lineId) =>
        lineId.endsWith('-formula'),
      ) ?? []
    expect(formulaLineIds).toHaveLength(1)
    const ownedParagraphs = result.paper.nodes.filter(
      (
        node,
      ): node is Extract<
        (typeof result.paper.nodes)[number],
        { type: 'paragraph' }
      > =>
        node.type === 'paragraph' &&
        (node.text === 'where' ||
          node.text.includes(
            'The first term records the local drift and cites the source-backed reference [42].',
          ) ||
          result.provenance[node.id]?.regionIds.some((regionId) =>
            relationship!.sourceRegionIds.includes(regionId),
          )),
    )
    expect(ownedParagraphs).toHaveLength(1)
    expect(ownedParagraphs[0].text).toBe(
      'where Sk′ = S′(xkt). The first term records the local drift and cites the source-backed reference [42].',
    )
    expect(result.provenance[ownedParagraphs[0].id]?.regionIds).toHaveLength(3)
    expect(
      ownedParagraphs[0].inlineRuns?.map((inline) => ({
        text: ownedParagraphs[0].text.slice(inline.start, inline.end),
        verticalAlign: inline.verticalAlign,
        semanticRole: inline.semanticRole,
      })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'k', verticalAlign: 'subscript' }),
        expect.objectContaining({ text: '′', verticalAlign: 'superscript' }),
        expect.objectContaining({ text: 'k', verticalAlign: 'superscript' }),
        expect.objectContaining({ text: 't', verticalAlign: 'subscript' }),
        expect.objectContaining({
          text: '[42]',
          semanticRole: 'citation',
        }),
      ]),
    )
    expect(result.visualRelationships).toContain(relationship)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_VISUAL_OBJECT',
          target: expect.objectContaining({
            markerId: relationship?.id,
          }),
        }),
      ]),
    )
    expect(result.completeness.unresolvedObjects.equations).toBeGreaterThan(0)
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNRESOLVED_VISUAL_OBJECT',
      ]),
    })
    expect(
      result.sourceSemanticFlowBoundaryDecisions.map(
        (decision) => decision.outcome,
      ),
    ).toEqual(['no-space'])
    expect(result.sourceSemanticFlowBoundaryDecisionCount).toBe(1)
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'CANONICAL_FLOW_ORDER_VIOLATION',
      ),
    ).toBe(false)
  })

  it('uses one exact unresolved candidate lineage when a prose suffix is held by a spanning container', async () => {
    const columnEvidence = [0.12, 0.15, 0.18].flatMap((y, index) => [
      run(
        1,
        `Left column evidence ${index + 1} remains readable.`,
        0.1,
        y,
        0.34,
      ),
      run(
        1,
        `Right column evidence ${index + 1} remains readable.`,
        0.55,
        y,
        0.34,
      ),
    ])
    const inlineRuns = splitInlineProseEquationRuns()
    const after = inlineRuns.find((sourceRun) =>
      sourceRun.text.startsWith('). The first term'),
    )!
    after.width = 0.61

    const result = await reconstructPageAnalyses({
      pages: [page(1, [...columnEvidence, ...inlineRuns])],
      sourceHash: '9'.repeat(64),
      fileName: 'split-inline-spanning-candidate.pdf',
      byteLength: 4096,
      rasterizeFigure: async () => {
        throw new Error('source crop unavailable')
      },
    })
    const relationship = result.visualRelationships.find(
      (candidate) =>
        candidate.kind === 'equation' &&
        candidate.status === 'unresolved' &&
        candidate.candidates.some((match) =>
          match.sourceRegionIds.some((regionId) =>
            result.regions
              .find((region) => region.id === regionId)
              ?.lines.some((line) => line.id.endsWith('-formula')),
          ),
        ),
    )
    expect(relationship).toBeDefined()
    expect(relationship).toMatchObject({
      sourceRegionIds: [],
      sourceLineIds: [],
      evidence: expect.arrayContaining([
        'source-text-transcript-unresolved',
        'incomplete-equation-source-scope',
      ]),
    })
    const formulaRegionId = relationship!.candidates[0].sourceRegionIds[0]
    const formulaRegion = result.regions.find(
      (region) => region.id === formulaRegionId,
    )!
    const afterBaseId = formulaRegion.lines[0].id.replace(/-formula$/u, '')
    expect(
      result.regions.find((region) =>
        region.lines.some((line) => line.id === `${afterBaseId}-after`),
      ),
    ).toMatchObject({ kind: 'spanning' })
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' &&
          (node.text === 'where' ||
            result.provenance[node.id]?.regionIds.includes(formulaRegionId) ||
            node.text.startsWith('). The first term')),
      ),
    ).toEqual([
      expect.objectContaining({
        text: 'where Sk′ = S′(xkt). The first term records the local drift [42].',
      }),
    ])
    expect(result.visualRelationships).toContain(relationship)
    expect(result.readiness.ready).toBe(false)
  })

  it('does not coalesce a split inline formula through an unresolved extra-line boundary', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.42),
          run(
            1,
            'A second ordinary prose line remains intact.',
            0.1,
            0.23,
            0.44,
          ),
          ...splitInlineProseEquationRuns({
            afterText: '). The first term preserves quux-',
            extraRuns: [run(1, 'blorp remains separate.', 0.266, 0.365, 0.2)],
          }),
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'split-inline-unresolved-extra-line.pdf',
      byteLength: 4096,
      rasterizeFigure: async () => {
        throw new Error('source crop unavailable')
      },
    })

    const relationship = result.visualRelationships.find(
      (candidate) =>
        candidate.kind === 'equation' &&
        candidate.status === 'unresolved' &&
        candidate.sourceLineIds?.some((lineId) => lineId.endsWith('-formula')),
    )
    expect(relationship).toBeDefined()
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text.startsWith('where ') &&
          node.text.includes('blorp remains separate.'),
      ),
    ).toBe(false)
  })

  it.each([
    {
      name: 'the source whitespace predecessor is missing',
      runs: () => {
        const runs = splitInlineProseEquationRuns()
        const formulaStart = runs.find((sourceRun) => sourceRun.text === 'S')!
        Object.assign(formulaStart, {
          sourceWhitespaceBefore: undefined,
          sourceWhitespacePredecessorIndex: undefined,
        })
        return runs
      },
    },
    {
      name: 'the prose suffix has no leading closing punctuation',
      runs: () =>
        splitInlineProseEquationRuns({
          afterText: 'The first term records the local drift [42].',
        }),
    },
  ])('fails closed when $name', async ({ runs }) => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.42),
          run(
            1,
            'A second ordinary prose line remains intact.',
            0.1,
            0.23,
            0.44,
          ),
          ...runs(),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[42] Source-backed reference.', 0.1, 0.72, 0.72, 7),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'split-inline-fail-closed.pdf',
      byteLength: 4096,
      rasterizeFigure: async () => {
        throw new Error('source crop unavailable')
      },
    })
    const relationship = result.visualRelationships.find(
      (candidate) =>
        candidate.kind === 'equation' &&
        candidate.status === 'unresolved' &&
        candidate.sourceLineIds?.some((lineId) => lineId.endsWith('-formula')),
    )
    expect(relationship).toBeDefined()
    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' &&
          result.provenance[node.id]?.regionIds.includes(
            relationship!.sourceRegionIds[0],
          ),
      ),
    ).toSatisfy(
      (owner: Extract<ResearchNode, { type: 'paragraph' }> | undefined) =>
        Boolean(owner) && result.provenance[owner!.id].regionIds.length < 3,
    )
    expect(result.completeness.unresolvedObjects.equations).toBeGreaterThan(0)
    expect(result.readiness.ready).toBe(false)
  })

  it('does not coalesce a split inline formula that is owned by a matched equation relationship', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.42),
          run(
            1,
            'A second ordinary prose line remains intact.',
            0.1,
            0.23,
            0.44,
          ),
          ...splitInlineProseEquationRuns(),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[42] Source-backed reference.', 0.1, 0.72, 0.72, 7),
        ]),
      ],
      sourceHash: '5'.repeat(64),
      fileName: 'split-inline-matched-equation.pdf',
      byteLength: 4096,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 20,
          height: 8,
          pixels: new Uint8Array(20 * 8 * 4).fill(96),
        }),
    })
    const relationship = result.visualRelationships.find(
      (candidate) =>
        candidate.kind === 'equation' &&
        candidate.sourceLineIds?.some((lineId) => lineId.endsWith('-formula')),
    )
    expect(relationship).toMatchObject({
      status: 'matched',
      canonicalNodeId: expect.any(String),
    })
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text ===
            'where Sk′ = S′(xkt). The first term records the local drift [42].',
      ),
    ).toBe(false)
  })

  it.each([
    {
      name: 'a superscript-before-base formula',
      fileName: 'unresolved-inline-script.pdf',
      corruptTranscript: /qla\s*=\s*R\(x\)/u,
      runs: [
        run(
          1,
          'The recovered paragraph introduces a fitted transform:',
          0.1,
          0.3,
          0.42,
        ),
        mathRun('q', 0.2, 0.34, 0.012, 10, 'Synthetic-CMMI10'),
        mathRun('l', 0.212, 0.333, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('a', 0.212, 0.348, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun(' = R(x)', 0.225, 0.34, 0.09, 10, 'Synthetic-CMR10'),
        run(1, 'The following sentence remains readable.', 0.1, 0.38, 0.36),
      ],
    },
    {
      name: 'a reordered summation formula',
      fileName: 'unresolved-inline-summation.pdf',
      corruptTranscript: /L1\s*∑l\s*LDal/u,
      runs: [
        run(
          1,
          'The recovered paragraph selects a spectral basis:',
          0.1,
          0.3,
          0.4,
        ),
        mathRun('L', 0.2, 0.34, 0.012, 10, 'Synthetic-CMMI10'),
        mathRun('1', 0.212, 0.348, 0.007, 7, 'Synthetic-CMR7'),
        mathRun('∑', 0.225, 0.34, 0.02, 10, 'Synthetic-CMSY10'),
        mathRun('l', 0.239, 0.348, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('LD', 0.252, 0.34, 0.025, 10, 'Synthetic-CMMI10'),
        mathRun('a', 0.277, 0.348, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('l', 0.277, 0.333, 0.007, 7, 'Synthetic-CMMI7'),
        run(1, 'as the stable basis for evaluation.', 0.3, 0.34, 0.27),
      ],
    },
    {
      name: 'a split formula shard',
      fileName: 'unresolved-split-inline-formula.pdf',
      corruptTranscript: /hl=\s*=\s*f\(a,\s*b\)/u,
      runs: [
        run(
          1,
          'The recovered paragraph says the state is modeled by',
          0.1,
          0.34,
          0.36,
        ),
        mathRun('h', 0.47, 0.34, 0.012, 10, 'Synthetic-CMMI10'),
        mathRun('l', 0.482, 0.333, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('=', 0.482, 0.348, 0.009, 7, 'Synthetic-CMR7'),
        mathRun(
          '= f(a, b), where the mapping remains stable.',
          0.502,
          0.34,
          0.34,
          10,
          'Synthetic-CMR10',
        ),
      ],
    },
    {
      name: 'a mixed variable fraction without a relation operator',
      fileName: 'unresolved-mixed-variable-fraction.pdf',
      corruptTranscript: /2xy/u,
      runs: [
        run(1, 'The recovered ratio is', 0.1, 0.34, 0.16),
        mathRun('2', 0.261, 0.34, 0.012, 10, 'Synthetic-CMR10'),
        mathRun('x', 0.274, 0.333, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('y', 0.274, 0.348, 0.007, 7, 'Synthetic-CMMI7'),
        run(1, 'for each observed sample.', 0.283, 0.34, 0.2),
      ],
    },
    {
      name: 'a three-run variable fraction',
      fileName: 'unresolved-three-run-variable-fraction.pdf',
      corruptTranscript: /2xy/u,
      runs: [
        mathRun('2', 0.261, 0.34, 0.012, 10, 'Synthetic-CMR10'),
        mathRun('x', 0.274, 0.333, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('y', 0.274, 0.348, 0.007, 7, 'Synthetic-CMMI7'),
      ],
    },
    {
      name: 'a four-run line-start variable fraction',
      fileName: 'unresolved-line-start-variable-fraction.pdf',
      corruptTranscript: /2xy\s*defines the observed ratio/u,
      runs: [
        mathRun('2', 0.1, 0.34, 0.012, 10, 'Synthetic-CMR10'),
        mathRun('x', 0.113, 0.333, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('y', 0.113, 0.348, 0.007, 7, 'Synthetic-CMMI7'),
        run(1, 'defines the observed ratio.', 0.122, 0.34, 0.22),
      ],
    },
    {
      name: 'a non-Computer-Modern variable fraction',
      fileName: 'unresolved-non-cm-variable-fraction.pdf',
      corruptTranscript: /2xy\s*defines the observed ratio/u,
      runs: [
        mathRun('2', 0.1, 0.34, 0.012, 10, 'Synthetic-Math-Regular'),
        mathRun('x', 0.113, 0.333, 0.007, 7, 'Synthetic-Math-Regular'),
        mathRun('y', 0.113, 0.348, 0.007, 7, 'Synthetic-Math-Regular'),
        run(1, 'defines the observed ratio.', 0.122, 0.34, 0.22),
      ],
    },
  ])(
    'preserves $name and blocks publication when its two-dimensional semantics remain unresolved',
    async ({ fileName, runs }) => {
      const result = await reconstructPageAnalyses({
        pages: [
          page(1, [
            run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.42),
            run(
              1,
              'A second ordinary prose line remains intact.',
              0.1,
              0.23,
              0.44,
            ),
            ...runs,
          ]),
        ],
        sourceHash: '9'.repeat(64),
        fileName,
        byteLength: 2048,
        rasterizeFigure: async () => {
          throw new Error('source crop unavailable')
        },
      })

      const relationship = result.visualRelationships.find(
        (candidate) =>
          candidate.kind === 'equation' &&
          candidate.status === 'unresolved' &&
          candidate.evidence.includes('source-text-transcript-unresolved'),
      )
      expect(relationship).toMatchObject({
        kind: 'equation',
        status: 'unresolved',
        sourceText: '',
        altTextSource: 'caption',
        evidence: expect.arrayContaining([
          'source-proved-atomic-equation-component',
          'source-rendition-unavailable',
        ]),
      })
      expect(relationship!.sourceRegionIds).toContain(
        relationship!.captionRegionId,
      )
      const sourceNodes = result.paper.nodes.filter(
        (
          node,
        ): node is Extract<
          (typeof result.paper.nodes)[number],
          { text: string }
        > => 'text' in node,
      )
      const canonicalText = sourceNodes.map((node) => node.text).join(' ')
      const preservedEquationNodes = sourceNodes.filter((node) =>
        result.provenance[node.id]?.regionIds.some((regionId) =>
          relationship!.sourceRegionIds.includes(regionId),
        ),
      )
      expect(preservedEquationNodes.length).toBeGreaterThan(0)
      expect(preservedEquationNodes).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: relationship!.altText }),
        ]),
      )
      expect(
        preservedEquationNodes.every(
          (node) => result.provenance[node.id]?.boxes.length > 0,
        ),
      ).toBe(true)
      if (fileName === 'unresolved-split-inline-formula.pdf') {
        expect(canonicalText).toContain('where the mapping remains stable.')
      }
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'UNRESOLVED_VISUAL_OBJECT',
            severity: 'error',
          }),
        ]),
      )
      expect(result.completeness.unresolvedObjects.equations).toBeGreaterThan(0)
      expect(result.completeness.expectedInlineSpanCount).toBeGreaterThan(0)
      expect(result.readiness).toMatchObject({
        ready: false,
        status: 'review-required',
        blockingDiagnosticCodes: expect.arrayContaining([
          'UNRESOLVED_VISUAL_OBJECT',
        ]),
      })

      const epub = await buildReadableEpub(result.paper, result)
      const content = strFromU8(
        inspectEpub(epub.bytes).files['EPUB/content.xhtml'],
      )
      for (const node of preservedEquationNodes) {
        expect(content).toContain(`data-canonical-id="${node.id}"`)
      }
      expect(content).not.toContain('orphan-caption omitted-visual')
      expect(content).not.toContain(`>${relationship!.altText}<`)
    },
  )

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

  it('maps only explicit academic font-style conventions', async () => {
    const syntheticRuns = [
      {
        text: 'A Nimbus medium face remains bold.',
        y: 0.16,
        fontName: 'ABCDEF+NimbusRomNo9L-Medi',
      },
      {
        text: 'A Nimbus regular face remains plain.',
        y: 0.18,
        fontName: 'ABCDEF+NimbusRomNo9L-Regu',
      },
      {
        text: 'A Helvetica medium face remains plain.',
        y: 0.185,
        fontName: 'ABCDEF+HelveticaNeue-Medium',
      },
      {
        text: 'A Styrene medium italic face is italic but not bold.',
        y: 0.19,
        fontName: 'ABCDEF+StyreneBLC-MediumItalic',
      },
      {
        text: 'A conventional math-italic family remains emphasized.',
        y: 0.2,
        fontName: 'ABCDEF+CMMI12',
      },
      {
        text: 'A second math-italic convention remains emphasized.',
        y: 0.24,
        fontName: 'ABCDEF+MTMI',
      },
      {
        text: 'A PostScript italic suffix remains emphasized.',
        y: 0.28,
        fontName: 'ABCDEF+ScholarlySerif-ReguItal',
      },
      {
        text: 'A merely similar family name remains plain.',
        y: 0.32,
        fontName: 'ABCDEF+SyntheticObliqueness',
      },
    ].map(({ text, y, fontName }) => ({
      ...run(1, text, 0.1, y, 0.75),
      fontName,
    }))
    const result = await reconstructPageAnalyses({
      pages: [page(1, syntheticRuns)],
      sourceHash: 'f'.repeat(64),
      fileName: 'synthetic-inline-fonts.pdf',
      byteLength: 2048,
    })
    const textNodes = result.paper.nodes.filter(
      (node) => 'text' in node && 'inlineRuns' in node,
    )
    const styleFor = (expected: string) => {
      const node = textNodes.find(
        (candidate) => 'text' in candidate && candidate.text.includes(expected),
      )
      if (!node || !('text' in node) || !('inlineRuns' in node))
        return undefined
      const start = node.text.indexOf(expected)
      return node.inlineRuns?.find(
        (candidate) =>
          candidate.start <= start && candidate.end >= start + expected.length,
      )
    }

    expect(styleFor('A Nimbus medium face remains bold.')?.bold).toBe(true)
    expect(styleFor('A Nimbus regular face remains plain.')?.bold).not.toBe(
      true,
    )
    expect(styleFor('A Helvetica medium face remains plain.')?.bold).not.toBe(
      true,
    )
    expect(
      styleFor('A Styrene medium italic face is italic but not bold.')?.bold,
    ).not.toBe(true)
    expect(
      styleFor('A Styrene medium italic face is italic but not bold.')?.italic,
    ).toBe(true)
    expect(
      styleFor('A conventional math-italic family remains emphasized.')?.italic,
    ).toBe(true)
    expect(
      styleFor('A second math-italic convention remains emphasized.')?.italic,
    ).toBe(true)
    expect(
      styleFor('A PostScript italic suffix remains emphasized.')?.italic,
    ).toBe(true)
    expect(
      styleFor('A merely similar family name remains plain.')?.italic,
    ).not.toBe(true)
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 5,
      mappedInlineSpanCount: 5,
      inlineSpanCoverage: 1,
    })
  })

  it('maps repeated styled source atoms only through their unique monotone line order', async () => {
    const repeatedAtoms = [
      {
        ...run(1, 'x', 0.2, 0.4, 0.02),
        fontName: 'ABCDEF+CMMI10',
      },
      run(1, ' + ', 0.221, 0.4, 0.03),
      {
        ...run(1, 'x', 0.252, 0.4, 0.02),
        fontName: 'ABCDEF+CMMI10',
      },
      run(1, ' = ', 0.273, 0.4, 0.03),
      {
        ...run(1, 'x', 0.304, 0.4, 0.02),
        fontName: 'ABCDEF+CMMI10',
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Repeated source atom study', 0.2, 0.08, 0.5, 18),
          run(
            1,
            'Ordinary prose establishes the document body typography.',
            0.1,
            0.24,
            0.72,
          ),
          ...repeatedAtoms,
        ]),
      ],
      sourceHash: '1'.repeat(64),
      fileName: 'repeated-styled-source-atoms.pdf',
      byteLength: 2048,
    })
    const node = result.paper.nodes.find(
      (candidate) => 'text' in candidate && candidate.text === 'x+x=x',
    )
    if (!node || !('text' in node) || !('inlineRuns' in node)) {
      throw new Error('missing canonical repeated-atom node')
    }
    const italicTexts = (node.inlineRuns ?? [])
      .filter((candidate) => candidate.italic)
      .map((candidate) => node.text.slice(candidate.start, candidate.end))

    expect(italicTexts).toEqual(['x', 'x', 'x'])
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 3,
      mappedInlineSpanCount: 3,
      inlineSpanCoverage: 1,
    })
  })

  it('keeps a whole repeated-run sequence fail-closed when two complete monotone assignments exist', () => {
    const firstRun = run(1, 'x', 0.1, 0.2, 0.02)
    const fixedRun = run(1, 'y', 0.2, 0.2, 0.02)
    const candidates = [
      {
        run: firstRun,
        text: 'x',
        occurrences: [
          { start: 0, end: 1 },
          { start: 2, end: 3 },
        ],
      },
      {
        run: fixedRun,
        text: 'y',
        occurrences: [{ start: 4, end: 5 }],
      },
    ]

    expect(retainUniqueMonotoneSourceRunAssignment(candidates)).toBe(false)
    expect(candidates.map((candidate) => candidate.occurrences)).toEqual([
      [],
      [],
    ])
  })

  it('keeps an accent alias and its whole line fail-closed when repeated assignments remain', () => {
    const accent = run(1, '´', 0.1, 0.2, 0.01)
    const target = run(1, 'a', 0.11, 0.2, 0.02)
    const fixed = run(1, 'y', 0.2, 0.2, 0.02)
    const repeatedAccentOccurrences = [
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]
    const candidates = [
      {
        run: accent,
        text: 'á',
        occurrences: [...repeatedAccentOccurrences],
      },
      {
        run: target,
        text: 'á',
        occurrences: [...repeatedAccentOccurrences],
      },
      {
        run: fixed,
        text: 'y',
        occurrences: [{ start: 4, end: 5 }],
      },
    ]

    expect(
      retainUniqueSourceRunAssignmentWithAliases(
        candidates,
        new Map([
          [accent, target],
          [target, accent],
        ]),
      ),
    ).toBe(false)
    expect(candidates.map((candidate) => candidate.occurrences)).toEqual([
      [],
      [],
      [],
    ])
  })

  it('keeps overlapping singleton accent and prose intervals fail-closed', () => {
    const accent = run(1, '´', 0.1, 0.2, 0.01)
    const target = run(1, 'ar method', 0.11, 0.2, 0.08)
    const overlapping = run(1, 'method', 0.2, 0.2, 0.05)
    const candidates = [
      {
        run: accent,
        text: 'ár method',
        occurrences: [{ start: 0, end: 9 }],
      },
      {
        run: target,
        text: 'ár method',
        occurrences: [{ start: 0, end: 9 }],
      },
      {
        run: overlapping,
        text: 'method',
        occurrences: [{ start: 3, end: 9 }],
      },
    ]

    expect(
      retainUniqueSourceRunAssignmentWithAliases(
        candidates,
        new Map([
          [accent, target],
          [target, accent],
        ]),
      ),
    ).toBe(false)
    expect(candidates.map((candidate) => candidate.occurrences)).toEqual([
      [],
      [],
      [],
    ])
  })

  it('marks only source-atomic academic math runs for lexical compaction', async () => {
    const mathRuns = [
      run(1, 'C', 0.1, 0.4, 0.02, 12),
      {
        ...run(1, 'P lot', 0.121, 0.396, 0.05, 6),
        height: 0.009,
        fontName: 'ABCDEF+CMMI10',
      },
      run(1, ' → R', 0.172, 0.4, 0.05, 12),
      {
        ...run(1, 'Inf o.', 0.223, 0.396, 0.06, 6),
        height: 0.009,
        fontName: 'ABCDEF+CMSY10',
      },
      run(1, '; ', 0.284, 0.4, 0.015, 12),
      {
        ...run(1, 'W T', 0.3, 0.4, 0.035, 12),
        fontName: 'ABCDEF+CMMI10',
      },
      run(1, '; ', 0.336, 0.4, 0.015, 12),
      {
        ...run(1, 'see note', 0.352, 0.396, 0.07, 6),
        height: 0.009,
        fontName: 'Synthetic-Regular',
      },
      run(1, '; ', 0.423, 0.4, 0.015, 12),
      {
        ...run(1, 'DInf o.', 0.439, 0.4, 0.065, 12),
        fontName: 'ABCDEF+CMMI10',
      },
      run(1, '; ', 0.505, 0.4, 0.015, 12),
      {
        ...run(1, 'ordinary italic prose', 0.521, 0.4, 0.16, 12),
        fontName: 'ABCDEF+NimbusRomNo9L-ReguItal',
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Compact math semantics', 0.2, 0.08, 0.4, 18),
          run(1, 'Ada Example', 0.4, 0.16, 0.2, 11),
          run(1, 'Abstract', 0.1, 0.24, 0.2, 14),
          run(
            1,
            'This source establishes a complete ordinary prose baseline.',
            0.1,
            0.3,
            0.72,
          ),
          ...mathRuns,
        ]),
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'source-backed-compact-math.pdf',
      byteLength: 2048,
    })
    const node = result.paper.nodes.find(
      (candidate) =>
        'text' in candidate &&
        candidate.text.includes('P lot') &&
        candidate.text.includes('Inf o.'),
    )

    expect(node && 'text' in node ? node.text : '').toContain('CP lot')
    expect(node && 'text' in node ? node.text : '').toContain('RInf o.')
    if (!node || !('text' in node) || !('inlineRuns' in node)) {
      throw new Error('missing canonical compact-math node')
    }
    const styleFor = (value: string) => {
      const start = node.text.indexOf(value)
      return node.inlineRuns?.find(
        (candidate) =>
          candidate.start <= start && candidate.end >= start + value.length,
      )
    }

    expect(styleFor('P lot')).toMatchObject({
      italic: true,
      verticalAlign: 'superscript',
      compactMathAtom: true,
    })
    expect(styleFor('Inf o.')).toMatchObject({
      verticalAlign: 'superscript',
      compactMathAtom: true,
    })
    expect(styleFor('W T')).toMatchObject({ italic: true })
    expect(styleFor('W T')?.verticalAlign).toBeUndefined()
    expect(styleFor('W T')?.compactMathAtom).toBe(true)
    expect(styleFor('see note')).toMatchObject({
      verticalAlign: 'superscript',
    })
    expect(styleFor('see note')?.compactMathAtom).toBeUndefined()
    expect(styleFor('DInf o.')).toMatchObject({
      italic: true,
      compactMathAtom: true,
    })
    expect(styleFor('DInf o.')?.verticalAlign).toBeUndefined()
    expect(styleFor('ordinary italic prose')).toMatchObject({
      italic: true,
    })
    expect(styleFor('ordinary italic prose')?.compactMathAtom).toBeUndefined()
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 11,
      mappedInlineSpanCount: 11,
      inlineSpanCoverage: 1,
    })

    const content = renderPublicationXhtml(result.paper, {
      reconstruction: result,
    })
    expect(content).toContain('C<sup><em>Plot</em></sup>')
    expect(content).toContain('R<sup>Info.</sup>')
    expect(content).toContain('<em>WT</em>')
    expect(content).toContain('<sup>see note</sup>')
    expect(content).toContain('<em>DInfo.</em>')
    expect(content).toContain('<em>ordinary italic prose</em>')
  })

  it('retains raised caption glyphs as canonical caption inline semantics', async () => {
    const captionRuns = [
      {
        ...run(1, 'Figure 1. Score R', 0.1, 0.65, 0.25, 9),
        fontName: 'Caption',
      },
      {
        ...run(1, '2', 0.351, 0.646, 0.012, 6),
        height: 0.009,
        fontName: 'Caption',
      },
      {
        ...run(1, ' remains stable.', 0.372, 0.65, 0.16, 9),
        fontName: 'Caption',
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [page(1, captionRuns)],
      sourceHash: '7'.repeat(64),
      fileName: 'synthetic-caption-inline.pdf',
      byteLength: 2048,
    })
    const caption = result.paper.nodes.find(
      (node) => node.type === 'caption' && node.text.includes('Score'),
    )

    expect(caption?.type).toBe('caption')
    if (caption?.type !== 'caption') throw new Error('missing caption')
    expect(caption.text).toBe('Figure 1. Score R2 remains stable.')
    const superscriptStart = caption.text.indexOf('2')
    expect(caption.inlineRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          start: superscriptStart,
          end: superscriptStart + 1,
          verticalAlign: 'superscript',
        }),
      ]),
    )
  })

  it('retains source-backed scripts in the canonical publication title and footnote', async () => {
    const titleRuns = [
      run(1, 'Re', 0.2, 0.08, 0.045, 18),
      {
        ...run(1, '3', 0.246, 0.076, 0.012, 7),
        height: 0.009,
        fontName: 'Synthetic-Regular',
      },
      run(1, ': Source-backed title', 0.26, 0.08, 0.34, 18),
    ]
    const noteRuns = [
      run(1, '5 Footnote preserves Re', 0.1, 0.88, 0.27, 8),
      {
        ...run(1, '3', 0.371, 0.876, 0.01, 5),
        height: 0.008,
        fontName: 'Synthetic-Regular',
      },
      run(1, ' semantics.', 0.383, 0.88, 0.12, 8),
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          ...titleRuns,
          run(1, 'Ada Example', 0.4, 0.17, 0.2, 11),
          run(1, 'Abstract', 0.1, 0.26, 0.2, 14),
          run(
            1,
            'The source abstract establishes ordinary body typography.',
            0.1,
            0.32,
            0.72,
          ),
          ...noteRuns,
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'source-backed-title-note-scripts.pdf',
      byteLength: 2048,
    })
    const title = result.paper.nodes.find(
      (node) => node.type === 'heading' && node.text === result.paper.title,
    )
    const note = result.paper.nodes.find(
      (node) =>
        node.type === 'footnote' &&
        node.text === 'Footnote preserves Re3 semantics.',
    )

    expect(title?.type).toBe('heading')
    expect(note?.type).toBe('footnote')
    if (title?.type !== 'heading' || note?.type !== 'footnote') {
      throw new Error('missing canonical scripted title or footnote')
    }
    const titleScript = title.text.indexOf('3')
    const noteScript = note.text.indexOf('3')
    expect(title.inlineRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          start: titleScript,
          end: titleScript + 1,
          verticalAlign: 'superscript',
        }),
      ]),
    )
    expect(note.inlineRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          start: noteScript,
          end: noteScript + 1,
          verticalAlign: 'superscript',
        }),
      ]),
    )
    expect(result.provenance[title.id]).toMatchObject({
      pages: [1],
      boxes: expect.arrayContaining([
        expect.objectContaining({ text: '3', fontSize: 7 }),
      ]),
    })
    expect(result.provenance[note.id]).toMatchObject({
      pages: [1],
      boxes: expect.arrayContaining([
        expect.objectContaining({ text: '3', fontSize: 5 }),
      ]),
    })
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 2,
      mappedInlineSpanCount: 2,
      inlineSpanCoverage: 1,
    })

    const content = renderPublicationXhtml(result.paper, {
      reconstruction: result,
    })
    expect(content).toContain(
      '<h1 id="' +
        title.id +
        '" data-canonical-id="' +
        title.id +
        '">Re<sup>3</sup>: Source-backed title</h1>',
    )
    expect(content).toContain('Footnote preserves Re<sup>3</sup> semantics.')
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
