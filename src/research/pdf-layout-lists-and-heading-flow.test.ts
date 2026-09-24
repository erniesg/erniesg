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

describe('PDF semantic reconstruction', () => {
  it('uses repeated first-line indentation as paragraph-boundary evidence', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'First paragraph begins', 0.14, 0.2, 0.58),
          run(1, 'and continues on its next line.', 0.1, 0.222, 0.68),
          run(1, 'Second paragraph begins', 0.14, 0.244, 0.58),
          run(1, 'and continues independently.', 0.1, 0.266, 0.68),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'indented-paragraphs.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.map((node) => ('text' in node ? node.text : '')),
    ).toEqual([
      'First paragraph begins and continues on its next line.',
      'Second paragraph begins and continues independently.',
    ])
  })

  it('recognizes sequenced standalone numbered headings without English vocabulary', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '1 Überblick', 0.1, 0.18, 0.3),
          run(1, 'Erster Abschnittstext.', 0.1, 0.24, 0.7),
          run(1, '2 Methode', 0.1, 0.34, 0.3),
          run(1, 'Zweiter Abschnittstext.', 0.1, 0.4, 0.7),
        ]),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'numbered-headings.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes
        .filter((node) => node.type === 'heading')
        .map((node) => node.text),
    ).toEqual(['1 Überblick', '2 Methode'])
  })

  it('recognizes a numbered parent heading from its sequenced child headings', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'Ordinary body prose establishes the base size.',
            0.1,
            0.1,
            0.7,
          ),
          run(1, '3', 0.1, 0.18, 0.02, 12),
          {
            ...run(
              1,
              'USING PERSONA VECTORS TO CONTROL TRAITS',
              0.14,
              0.183,
              0.48,
              9.6,
            ),
            height: 0.012,
          },
          run(1, 'Parent section prose.', 0.1, 0.24, 0.7),
          run(1, '3.1 COMMON EXPERIMENTAL SETUP', 0.1, 0.34, 0.4),
          run(1, 'First subsection prose.', 0.1, 0.4, 0.7),
          run(1, '3.2 CONTROLLING TRAITS VIA STEERING', 0.1, 0.5, 0.45),
          run(1, 'Second subsection prose.', 0.1, 0.56, 0.7),
        ]),
      ],
      sourceHash: '3'.repeat(64),
      fileName: 'parent-child-headings.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes
        .filter((node) => node.type === 'heading')
        .map((node) => ({ text: node.text, level: node.level })),
    ).toEqual([
      { text: '3 USING PERSONA VECTORS TO CONTROL TRAITS', level: 1 },
      { text: '3.1 COMMON EXPERIMENTAL SETUP', level: 2 },
      { text: '3.2 CONTROLLING TRAITS VIA STEERING', level: 2 },
    ])
  })

  it('recognizes a styled numbered parent immediately followed by its child heading', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Adjacent hierarchy study', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Opening context.', 0.1, 0.3, 0.72, 10),
        ]),
        page(2, [
          run(
            2,
            'Ordinary body prose establishes the base size.',
            0.1,
            0.1,
            0.7,
            10,
          ),
          run(2, '4 Market–Maker Handbook', 0.1, 0.18, 0.45, 10),
          {
            ...run(
              2,
              '4.1 Greeks, Units, and Risk Buckets',
              0.1,
              0.22,
              0.5,
              10,
            ),
            fontName: 'NimbusRomNo9L-Medi',
          },
          run(2, 'Subsection prose follows.', 0.1, 0.28, 0.7, 10),
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'adjacent-parent-child-headings.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && node.text !== 'Abstract'
          ? [{ text: node.text, level: node.level }]
          : [],
      ),
    ).toEqual([
      { text: '4 Market–Maker Handbook', level: 1 },
      { text: '4.1 Greeks, Units, and Risk Buckets', level: 2 },
    ])
  })

  it('keeps sequenced decimal steps as list items when typography does not mark headings', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '3. MLPs 14-18 fit the b token', 0.1, 0.18, 0.55),
          run(
            1,
            'and retain the ordinary step explanation.',
            0.12,
            0.205,
            0.68,
          ),
          run(1, '4. MLPs 19-27 fit the a token', 0.1, 0.34, 0.55),
          run(
            1,
            'and retain the next ordinary step explanation.',
            0.12,
            0.365,
            0.7,
          ),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'numbered-list-steps.pdf',
      byteLength: 4096,
    })

    const steps = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' &&
      node.list?.numberingId.startsWith('pdf-list-')
        ? [node]
        : [],
    )
    expect(
      steps.map((node) => ({ text: node.text, ordinal: node.list?.ordinal })),
    ).toEqual([
      {
        text: 'MLPs 14-18 fit the b token and retain the ordinary step explanation.',
        ordinal: 3,
      },
      {
        text: 'MLPs 19-27 fit the a token and retain the next ordinary step explanation.',
        ordinal: 4,
      },
    ])
    expect(new Set(steps.map((node) => node.list!.numberingId)).size).toBe(1)
    expect(
      result.paper.nodes.filter((node) => node.type === 'heading'),
    ).toEqual([])
  })

  it('keeps markup-shaped body prose as literal text without independent evidence', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'Ordinary body prose establishes the source typography.',
            0.1,
            0.1,
            0.72,
          ),
          run(1, '# Literal heading syntax stays prose.', 0.1, 0.2, 0.72),
          run(1, '** Literal emphasis syntax stays prose. **', 0.1, 0.3, 0.72),
          run(1, '{placeholder}', 0.1, 0.4, 0.24),
          run(1, '1. Literal numbered syntax stays prose.', 0.1, 0.5, 0.72),
        ]),
      ],
      sourceHash: 'm'.repeat(64),
      fileName: 'literal-markup-prose.pdf',
      byteLength: 4096,
    })

    const prose = result.paper.nodes.filter(
      (node): node is Extract<ResearchNode, { type: 'paragraph' }> =>
        node.type === 'paragraph',
    )
    expect(result.paper.nodes.some((node) => node.type === 'heading')).toBe(
      false,
    )
    expect(prose.map((node) => node.text)).toEqual([
      'Ordinary body prose establishes the source typography.',
      '# Literal heading syntax stays prose.',
      '** Literal emphasis syntax stays prose. **',
      '{placeholder}',
      '1. Literal numbered syntax stays prose.',
    ])
    expect(prose.every((node) => node.list === undefined)).toBe(true)
  })

  it('preserves a singleton numbered item from its source hanging indent', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'Ordinary body prose establishes the source typography.',
            0.1,
            0.1,
            0.72,
          ),
          run(
            1,
            '1. Calibrate the source-backed threshold before export,',
            0.1,
            0.2,
            0.5,
          ),
          run(1, 'then verify the rendered checkpoint.', 0.128, 0.222, 0.44),
          run(
            1,
            'An independent paragraph follows the completed instruction.',
            0.1,
            0.31,
            0.72,
          ),
        ]),
      ],
      sourceHash: 'h'.repeat(64),
      fileName: 'singleton-hanging-indent-item.pdf',
      byteLength: 4096,
    })

    const item = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('Calibrate the source-backed threshold'),
    )
    expect(item).toMatchObject({
      text: 'Calibrate the source-backed threshold before export, then verify the rendered checkpoint.',
      list: {
        ordered: true,
        markerStyle: 'decimal',
        markerText: '1.',
        ordinal: 1,
      },
    })
  })

  it('does not promote a markup-shaped section phrase without source styling', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'Ordinary body prose establishes the source typography.',
            0.1,
            0.1,
            0.72,
          ),
          run(1, '1. Introduction', 0.1, 0.2, 0.72),
        ]),
      ],
      sourceHash: 'n'.repeat(64),
      fileName: 'literal-markup-section-prose.pdf',
      byteLength: 4096,
    })

    expect(result.paper.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'paragraph',
          text: '1. Introduction',
        }),
      ]),
    )
    expect(result.paper.nodes.some((node) => node.type === 'heading')).toBe(
      false,
    )
  })

  it('keeps a flowing parenthesized enumeration as prose when only a wrapped middle marker starts a region', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          {
            ...run(1, 'A Scholarly Paper', 0.1, 0.06, 0.72, 18),
            sourceSequenceIndex: 0,
          },
          {
            ...run(1, '1 INTRODUCTION', 0.1, 0.12, 0.3, 14),
            sourceSequenceIndex: 1,
          },
          {
            ...run(
              1,
              'We point out the following benefits: (1) exact scoring is available,',
              0.1,
              0.74,
              0.72,
            ),
            sourceSequenceIndex: 2,
          },
          {
            ...run(
              1,
              'the first claim is exact, while (2) diverse inputs are available,',
              0.1,
              0.76,
              0.72,
            ),
            sourceSequenceIndex: 3,
          },
          {
            ...run(1, '(3) contamination is unlikely,', 0.1, 0.78, 0.72),
            sourceSequenceIndex: 4,
          },
          {
            ...run(
              1,
              'and (4) the sequence length can increase',
              0.1,
              0.82,
              0.72,
            ),
            sourceSequenceIndex: 5,
          },
        ]),
        page(2, [
          {
            ...run(
              2,
              'without changing the task, and (5) strong baselines exist.',
              0.1,
              0.12,
              0.72,
            ),
            sourceSequenceIndex: 0,
          },
        ]),
      ],
      sourceHash: 'a'.repeat(64),
      fileName: 'flowing-parenthesized-enumeration.pdf',
      byteLength: 4096,
    })

    const paragraphs = result.paper.nodes.filter(
      (node) => node.type === 'paragraph',
    )
    const enumerationParagraphs = paragraphs.filter((node) =>
      /benefits|contamination|strong baselines/u.test(node.text),
    )

    expect(enumerationParagraphs).toHaveLength(1)
    expect(enumerationParagraphs[0].text).toBe(
      'We point out the following benefits: (1) exact scoring is available, the first claim is exact, while (2) diverse inputs are available, (3) contamination is unlikely, and (4) the sequence length can increase without changing the task, and (5) strong baselines exist.',
    )
    expect(
      paragraphs.some((node) => node.list?.numberingId.startsWith('pdf-list-')),
    ).toBe(false)
    expect(result.sourceSemanticFlowBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topology: 'cross-page-column' }),
      ]),
    )
  })

  it('keeps a source-flowing suffixed enumeration in prose when its second hypothesis starts a region', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Scholarly Paper', 0.1, 0.08, 0.72, 18),
          run(
            1,
            'We offer two hypotheses: 1) the first mechanism is flawed or',
            0.1,
            0.2,
            0.72,
          ),
          run(1, '2) the second mechanism is flawed.', 0.1, 0.238, 0.72),
        ]),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'flowing-suffixed-enumeration.pdf',
      byteLength: 4096,
    })
    const paragraphs = result.paper.nodes.filter(
      (node) => node.type === 'paragraph',
    )

    expect(paragraphs).toEqual([
      expect.objectContaining({
        text: 'We offer two hypotheses: 1) the first mechanism is flawed or 2) the second mechanism is flawed.',
      }),
    ])
    expect(paragraphs[0]).not.toHaveProperty('list')
  })

  it('retains a detached section number at a source-flow boundary instead of inventing a list', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Scholarly Paper', 0.1, 0.08, 0.72, 18),
          run(
            1,
            'The method follows the instantiation described in Section',
            0.1,
            0.82,
            0.72,
          ),
        ]),
        page(2, [
          run(
            2,
            '4. Rather, the implementation keeps the source order.',
            0.1,
            0.1,
            0.72,
          ),
        ]),
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'detached-section-reference.pdf',
      byteLength: 4096,
    })
    const paragraphs = result.paper.nodes.filter(
      (node) => node.type === 'paragraph',
    )

    expect(paragraphs).toEqual([
      expect.objectContaining({
        text: 'The method follows the instantiation described in Section 4. Rather, the implementation keeps the source order.',
      }),
    ])
    expect(paragraphs[0]).not.toHaveProperty('list')
  })

  it('retains a detached abbreviated figure number at a source-flow boundary instead of inventing a list', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Scholarly Paper', 0.1, 0.08, 0.72, 18),
          run(
            1,
            'We visualize the source-backed result in Fig.',
            0.1,
            0.2,
            0.72,
          ),
          run(
            1,
            '3. To do so, we calculate the bounded projection.',
            0.1,
            0.42,
            0.72,
          ),
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'detached-abbreviated-figure-reference.pdf',
      byteLength: 4096,
    })
    const paragraphs = result.paper.nodes.filter(
      (node) => node.type === 'paragraph',
    )

    expect(paragraphs).toEqual([
      expect.objectContaining({
        text: 'We visualize the source-backed result in Fig. 3. To do so, we calculate the bounded projection.',
      }),
    ])
    expect(paragraphs[0]).not.toHaveProperty('list')
  })

  it('joins a source-proven lexical hyphen continuation before interpreting its leading letter as a list marker', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'The GPT4-O baseline provides exact same-document token evidence.',
            0.1,
            0.12,
            0.72,
          ),
          run(
            1,
            'Tab. 9 presents repetitions for LLAMA-3.1-405B and GPT4-',
            0.1,
            0.68,
            0.72,
          ),
          run(
            1,
            'O. Fig. 13 presents the next source-backed example.',
            0.1,
            0.698,
            0.72,
          ),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'source-proven-lexical-hyphen-continuation.pdf',
      byteLength: 4096,
    })
    const paragraphs = result.paper.nodes.filter(
      (node) => node.type === 'paragraph',
    )
    const continuation = paragraphs.find((node) =>
      node.text.includes('Tab. 9 presents repetitions'),
    )

    expect(continuation).toMatchObject({
      text: 'Tab. 9 presents repetitions for LLAMA-3.1-405B and GPT4-O. Fig. 13 presents the next source-backed example.',
    })
    expect(continuation).not.toHaveProperty('list')
    expect(
      paragraphs.some(
        (node) =>
          node.list?.markerStyle === 'upper-alpha' &&
          node.list.markerText === 'O.',
      ),
    ).toBe(false)
    expect(result.lineBoundaryDecisions).toContainEqual(
      expect.objectContaining({
        outcome: 'preserved-lexical-hyphen',
        evidence: expect.arrayContaining([
          'source-proven-wrapped-line-boundary',
          'hard-hyphen-form-valid:same-document',
        ]),
      }),
    )
  })

  it('does not override a source list boundary when lexical token evidence lacks aligned wrap geometry', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'The GPT4-O baseline provides exact same-document token evidence.',
            0.1,
            0.12,
            0.72,
          ),
          run(1, 'The model label is GPT4-', 0.1, 0.68, 0.2),
          run(
            1,
            'O. Objective is a genuine source list item.',
            0.28,
            0.698,
            0.45,
          ),
        ]),
      ],
      sourceHash: 'f'.repeat(64),
      fileName: 'misaligned-lexical-hyphen-list-boundary.pdf',
      byteLength: 4096,
    })
    const paragraphs = result.paper.nodes.filter(
      (node) => node.type === 'paragraph',
    )

    expect(
      paragraphs.find((node) => node.text.startsWith('The model label')),
    ).toMatchObject({ text: 'The model label is GPT4-' })
    expect(
      paragraphs.find((node) => node.list?.markerText === 'O.'),
    ).toMatchObject({
      text: 'Objective is a genuine source list item.',
      list: {
        markerStyle: 'upper-alpha',
        markerText: 'O.',
        ordinal: 15,
      },
    })
  })

  it('preserves an isolated dash as prose continuation punctuation instead of inventing a list', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          {
            ...run(1, 'A Scholarly Paper', 0.1, 0.08, 0.72, 18),
            sourceSequenceIndex: 0,
          },
          {
            ...run(
              1,
              'Nothing about the relationship felt real, not even the way he looked at her',
              0.1,
              0.82,
              0.72,
            ),
            sourceSequenceIndex: 1,
          },
        ]),
        page(2, [
          {
            ...run(
              2,
              '– nothing was real except the fact that he had left.',
              0.1,
              0.1,
              0.72,
            ),
            sourceSequenceIndex: 0,
          },
        ]),
      ],
      sourceHash: 'a'.repeat(64),
      fileName: 'dash-prose-continuation.pdf',
      byteLength: 4096,
    })
    const paragraphs = result.paper.nodes.filter(
      (node) => node.type === 'paragraph',
    )

    expect(paragraphs).toEqual([
      expect.objectContaining({
        text: 'Nothing about the relationship felt real, not even the way he looked at her – nothing was real except the fact that he had left.',
      }),
    ])
    expect(paragraphs[0]).not.toHaveProperty('list')
    expect(result.sourceSemanticFlowBoundaryDecisions).toEqual([
      expect.objectContaining({ topology: 'cross-page-column' }),
    ])
  })

  it('preserves an isolated dash-delimited scene divider instead of inventing a list', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Scholarly Paper', 0.1, 0.08, 0.72, 18),
          run(1, 'The preceding scene ends here.', 0.1, 0.24, 0.72),
          run(1, '- Chase -', 0.1, 0.36, 0.14),
          run(1, 'The next scene begins here.', 0.1, 0.48, 0.72),
        ]),
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'dash-scene-divider.pdf',
      byteLength: 4096,
    })
    const divider = result.paper.nodes.find(
      (node) => node.type === 'paragraph' && node.text.includes('Chase'),
    )

    expect(divider).toMatchObject({ text: '- Chase -' })
    expect(divider).not.toHaveProperty('list')
  })

  it('does not interpret an ordinary sentence ending in a Roman-letter word as a list marker', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'did.', 0.1, 0.2, 0.04),
          run(
            1,
            'She continued the paragraph in ordinary prose.',
            0.1,
            0.23,
            0.62,
          ),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'roman-letter-word-prose.pdf',
      byteLength: 4096,
    })
    const paragraph = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.includes('continued the paragraph'),
    )

    expect(paragraph).toMatchObject({
      text: 'did. She continued the paragraph in ordinary prose.',
    })
    expect(paragraph).not.toHaveProperty('list')
  })

  it('keeps a source-contiguous single-letter sentence boundary out of Roman list semantics', async () => {
    const bodyRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
    ) => ({
      ...run(1, text, x, y, width, 10.9091),
      height: 0.01296,
      fontName,
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Single-letter prose boundary', 0.1, 0.035, 0.8, 18),
          ...[0.2, 0.3, 0.4].flatMap((y, index) => [
            bodyRun(`Left-column context ${index + 1}.`, 0.09, y, 0.385),
            bodyRun(`Right-column context ${index + 1}.`, 0.515, y, 0.385),
          ]),
          bodyRun(
            'The hierarchical outline H = {R, D} is composed of',
            0.514,
            0.681,
            0.37,
          ),
          bodyRun(
            'a rough outline R and a detailed outline',
            0.514,
            0.697,
            0.367,
          ),
          bodyRun('D', 0.514, 0.713, 0.015, 'CMMI10'),
          bodyRun(
            '.Previous works have used higher-level attributes',
            0.53,
            0.713,
            0.351,
          ),
          bodyRun(
            'like plots to improve generated stories.',
            0.514,
            0.729,
            0.367,
          ),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'single-letter-prose-boundary.pdf',
      byteLength: 4096,
      metadata: { title: 'Single-letter prose boundary' },
    })
    const paragraph = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('The hierarchical outline'),
    )

    expect(paragraph).toMatchObject({
      text: 'The hierarchical outline H = {R, D} is composed of a rough outline R and a detailed outline D. Previous works have used higher-level attributes like plots to improve generated stories.',
    })
    expect(paragraph).not.toHaveProperty('list')
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' &&
          (node.list?.ordinal === 500 ||
            node.text.startsWith('Previous works have used')),
      ),
    ).toEqual([])
  })

  it('does not promote an isolated parenthesized Roman continuation after a display equation to a list', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '(i) Filter the observations.', 0.1, 0.16, 0.5),
          run(1, '(ii) Estimate the jump process.', 0.1, 0.24, 0.5),
          run(1, 'µ(t,x) = σ²(t) + λ(t)', 0.32, 0.34, 0.36, 12),
          run(
            1,
            '(iii) RN drift re-smoothing continues the surrounding prose.',
            0.1,
            0.46,
            0.72,
          ),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'formula-broken-parenthesized-steps.pdf',
      byteLength: 4096,
    })

    const preprocessingSteps = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list ? [node] : [],
    )
    expect(
      preprocessingSteps.map((node) => ({
        text: node.text,
        ordinal: node.list?.ordinal,
        numberingId: node.list?.numberingId,
      })),
    ).toEqual([
      {
        text: 'Filter the observations.',
        ordinal: 1,
        numberingId: expect.stringMatching(/^pdf-list-p001-/),
      },
      {
        text: 'Estimate the jump process.',
        ordinal: 2,
        numberingId: expect.stringMatching(/^pdf-list-p001-/),
      },
    ])
    expect(
      new Set(preprocessingSteps.map((node) => node.list!.numberingId)).size,
    ).toBe(1)
    const trailingProse = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('(iii) RN drift re-smoothing'),
    )
    expect(trailingProse).toBeDefined()
    expect(
      trailingProse?.type === 'paragraph' ? trailingProse.list : undefined,
    ).toBeUndefined()
  })

  it('keeps partially bold numbered instructions as list items rather than sections', async () => {
    const numberedInstruction = (
      ordinal: number,
      title: string,
      detail: string,
      y: number,
    ) => [
      {
        ...run(1, `${ordinal}.`, 0.1, y, 0.022),
        fontName: 'Synthetic-CMR12',
      },
      {
        ...run(1, title, 0.132, y, 0.16),
        fontName: 'Synthetic-CMBX12',
      },
      {
        ...run(1, detail, 0.3, y, 0.56),
        fontName: 'Synthetic-CMR12',
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'Ordinary prose establishes the body typography.',
            0.1,
            0.12,
            0.72,
          ),
          ...numberedInstruction(
            1,
            'Toxicity filter:',
            'when short-horizon order imbalance spikes, pause quoting.',
            0.24,
          ),
          ...numberedInstruction(
            2,
            'News guard:',
            'around scheduled announcements, increase risk aversion.',
            0.34,
          ),
          ...numberedInstruction(
            3,
            'Queue discipline:',
            'cancel and replace on adverse microstructure signals.',
            0.44,
          ),
        ]),
      ],
      sourceHash: 'l'.repeat(64),
      fileName: 'partially-bold-numbered-instructions.pdf',
      byteLength: 4096,
    })

    const instructions = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' &&
      /^(?:Toxicity filter|News guard|Queue discipline)/u.test(node.text)
        ? [node]
        : [],
    )
    expect(instructions).toHaveLength(3)
    expect(instructions.every((node) => node.list?.ordered)).toBe(true)
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'heading' &&
          /(?:Toxicity filter|News guard|Queue discipline)/u.test(node.text),
      ),
    ).toEqual([])
  })

  it('does not turn a dominant bold run-in label and sentence starter into a section', async () => {
    const promptItem = (
      ordinal: number,
      label: string,
      continuation: string,
      y: number,
    ) => [
      {
        ...run(1, `${ordinal}.`, 0.1, y, 0.025),
        fontName: 'Synthetic-Regu',
      },
      {
        ...run(1, label, 0.13, y, 0.39),
        fontName: 'Synthetic-Medi',
      },
      {
        ...run(1, 'This', 0.525, y, 0.045),
        fontName: 'Synthetic-Regu',
      },
      {
        ...run(1, continuation, 0.13, y + 0.02, 0.66),
        fontName: 'Synthetic-Regu',
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'Ordinary prose establishes the body typography.',
            0.1,
            0.08,
            0.72,
          ),
          ...promptItem(
            2,
            'Prompt for Role Choice Evaluation (Table 27):',
            'prompt focuses on identifying the correct dialogue role.',
            0.2,
          ),
          ...promptItem(
            3,
            'Prompt for Coherence Evaluation (Table 28):',
            'prompt examines the logical flow of the dialogue.',
            0.32,
          ),
        ]),
      ],
      sourceHash: 'n'.repeat(64),
      fileName: 'bold-run-in-prompt-items.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'heading' &&
          /Prompt for (?:Role Choice|Coherence) Evaluation/u.test(node.text),
      ),
    ).toEqual([])
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'paragraph' &&
        /Prompt for (?:Role Choice|Coherence) Evaluation/u.test(node.text)
          ? [node.list?.ordinal]
          : [],
      ),
    ).toEqual([2, 3])
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'paragraph' && node.list?.ordinal === 3
          ? [node.text]
          : [],
      ),
    ).toEqual([
      'Prompt for Coherence Evaluation (Table 28): This prompt examines the logical flow of the dialogue.',
    ])
  })

  it('preserves each wrapped bullet as a separate list item', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '• First contribution begins here', 0.12, 0.2, 0.62),
          run(1, 'and wraps onto a second line.', 0.14, 0.218, 0.6),
          run(1, '• Second contribution begins here', 0.12, 0.246, 0.62),
          run(1, 'and also wraps independently.', 0.14, 0.264, 0.6),
          run(1, '• Third contribution remains distinct.', 0.12, 0.292, 0.62),
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'wrapped-bullets.pdf',
      byteLength: 4096,
    })

    const items = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list ? [node] : [],
    )
    expect(items.map((node) => node.text)).toEqual([
      'First contribution begins here and wraps onto a second line.',
      'Second contribution begins here and also wraps independently.',
      'Third contribution remains distinct.',
    ])
    expect(items.map((node) => node.list?.markerStyle)).toEqual([
      'disc',
      'disc',
      'disc',
    ])
    expect(new Set(items.map((node) => node.list?.numberingId)).size).toBe(1)
  })

  it('separates source-styled section lines from merged prose while retaining the complete heading text', async () => {
    const mainHeading = run(
      2,
      '5. LLMs Use the Clock Algorithm to Compute Addition',
      0.1,
      0.12,
      0.72,
      12,
    )
    mainHeading.fontName = 'NimbusRomNo9L-Medi'
    const subsection = run(
      2,
      '5.2. Investigating Attention Heads',
      0.1,
      0.22,
      0.5,
    )
    subsection.fontName = 'NimbusRomNo9L-Medi'
    const nextSubsection = run(2, '5.3. Looking at MLPs', 0.1, 0.38, 0.4)
    nextSubsection.fontName = 'NimbusRomNo9L-Medi'
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Paper', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
          run(1, 'Introductory context.', 0.1, 0.24, 0.7),
        ]),
        page(2, [
          mainHeading,
          subsection,
          run(
            2,
            'In GPT-J, every attention layer is the sum of its heads.',
            0.1,
            0.243,
            0.7,
          ),
          nextSubsection,
          run(
            2,
            'GPT-J predominantly relies on the last token MLPs.',
            0.1,
            0.403,
            0.7,
          ),
          run(2, '5.4.1. MODELING NEURON PREACTIVATIONS', 0.1, 0.54, 0.58),
          run(
            2,
            'The first nested subsection remains ordinary prose.',
            0.1,
            0.563,
            0.7,
          ),
          run(2, '5.4.2. UNDERSTANDING MLP INPUTS', 0.1, 0.68, 0.56),
          run(
            2,
            'The second nested subsection remains ordinary prose.',
            0.1,
            0.703,
            0.7,
          ),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'styled-section-prefixes.pdf',
      byteLength: 4096,
    })

    const headings = result.paper.nodes.flatMap((node) =>
      node.type === 'heading' && node.text !== 'Abstract' ? [node] : [],
    )
    expect(headings.map((node) => node.text)).toEqual([
      '5. LLMs Use the Clock Algorithm to Compute Addition',
      '5.2. Investigating Attention Heads',
      '5.3. Looking at MLPs',
      '5.4.1. MODELING NEURON PREACTIVATIONS',
      '5.4.2. UNDERSTANDING MLP INPUTS',
    ])
    expect(
      result.paper.nodes.filter(
        (node) => node.type === 'paragraph' && node.list,
      ),
    ).toEqual([])
    expect(
      headings.map((node) => result.provenance[node.id].boxes.length),
    ).toEqual([1, 1, 1, 1, 1])
    expect(headings.map((node) => node.level)).toEqual([1, 2, 2, 3, 3])
  })

  it('keeps an indented emphasized wrap with its lettered section heading', async () => {
    const headingRun = (text: string, x: number, y: number, width: number) => ({
      ...run(2, text, x, y, width, 12),
      fontName: 'Synthetic-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Source-backed heading study', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Opening prose establishes body typography.', 0.1, 0.3, 0.72),
        ]),
        page(2, [
          headingRun('B Details on Additional Reranking', 0.1, 0.1, 0.34),
          headingRun('Heuristics', 0.135, 0.119, 0.09),
          run(
            2,
            'The left-column explanation remains ordinary prose.',
            0.1,
            0.16,
            0.34,
          ),
          headingRun(
            'C Details on Editing System Information',
            0.56,
            0.1,
            0.36,
          ),
          headingRun('Extraction', 0.595, 0.119, 0.09),
          run(
            2,
            'The right-column explanation remains ordinary prose.',
            0.56,
            0.16,
            0.34,
          ),
          run(2, 'Left-column continuation.', 0.1, 0.21, 0.34),
          run(2, 'Right-column continuation.', 0.56, 0.21, 0.34),
        ]),
      ],
      sourceHash: 'w'.repeat(64),
      fileName: 'wrapped-lettered-headings.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^[BC]\s/u.test(node.text)
          ? [{ text: node.text, level: node.level }]
          : [],
      ),
    ).toEqual([
      {
        text: 'B Details on Additional Reranking Heuristics',
        level: 1,
      },
      {
        text: 'C Details on Editing System Information Extraction',
        level: 1,
      },
    ])
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          /^(?:Heuristics|Extraction)\b/u.test(node.text),
      ),
    ).toBe(false)
  })

  it('reassembles a styled heading split across a detected gutter before its lower wrap', async () => {
    const headingRun = (text: string, x: number, y: number, width: number) => ({
      ...run(2, text, x, y, width, 12),
      fontName: 'Synthetic-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Cross-gutter heading study', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Opening prose establishes body typography.', 0.1, 0.3, 0.72),
        ]),
        page(2, [
          headingRun('3.3 Multi-Event Dependence:', 0.1, 0.1, 0.31),
          headingRun('Diffusive Correlation and Co-', 0.54, 0.1, 0.34),
          headingRun('Jumps', 0.135, 0.119, 0.08),
          run(2, 'Left-column body prose begins here.', 0.1, 0.17, 0.36),
          run(2, 'Right-column body prose begins here.', 0.54, 0.17, 0.36),
          run(
            2,
            'Left-column continuation establishes the gutter.',
            0.1,
            0.2,
            0.36,
          ),
          run(
            2,
            'Right-column continuation establishes the gutter.',
            0.54,
            0.2,
            0.36,
          ),
        ]),
      ],
      sourceHash: 'g'.repeat(64),
      fileName: 'cross-gutter-wrapped-heading.pdf',
      byteLength: 4096,
    })

    const headings = result.paper.nodes.flatMap((node) =>
      node.type === 'heading' &&
      /(?:Multi-Event|Diffusive Correlation|Jumps)/u.test(node.text)
        ? [node]
        : [],
    )
    expect(headings.map((node) => node.text)).toEqual([
      '3.3 Multi-Event Dependence: Diffusive Correlation and Co-Jumps',
    ])
    expect(result.provenance[headings[0].id].boxes).toHaveLength(3)
  })

  it('keeps a lowercase continuation after a discretionary heading hyphen', async () => {
    const headingRun = (text: string, x: number, y: number, width: number) => ({
      ...run(2, text, x, y, width, 12),
      fontName: 'Synthetic-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        withExplicitEnglishLanguage(
          page(1, [
            run(1, 'Hyphenated heading study', 0.1, 0.08, 0.72, 20),
            run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
            run(
              1,
              'Opening prose establishes body typography for corridor and belief instruments.',
              0.1,
              0.3,
              0.72,
            ),
          ]),
        ),
        page(2, [
          headingRun(
            '3.4 Prototype Derivatives (Belief–Variance, Correlation, Cor-',
            0.1,
            0.1,
            0.7,
          ),
          headingRun('ridor, and First-Passage Notes)', 0.135, 0.119, 0.36),
          run(2, 'The prototype explanation remains prose.', 0.1, 0.17, 0.7),
          headingRun(
            '5 Calibration: From Mid/Bid–Ask/Trades to a Be-',
            0.1,
            0.28,
            0.62,
          ),
          headingRun('lief–Vol Surface', 0.135, 0.299, 0.2),
          run(2, 'The calibration explanation remains prose.', 0.1, 0.35, 0.7),
        ]),
      ],
      sourceHash: 'h'.repeat(64),
      fileName: 'hyphenated-wrapped-heading.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^(?:3\.4|5 )/u.test(node.text)
          ? [node.text]
          : [],
      ),
    ).toEqual([
      '3.4 Prototype Derivatives (Belief–Variance, Correlation, Corridor, and First-Passage Notes)',
      '5 Calibration: From Mid/Bid–Ask/Trades to a Belief–Vol Surface',
    ])
  })

  it('keeps lowercase equation-shaped prose out of the heading hierarchy', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'Ordinary context establishes the experiment.',
            0.1,
            0.16,
            0.7,
          ),
          run(1, 'More ordinary context fixes the body size.', 0.1, 0.2, 0.7),
          run(
            1,
            'results hold when fitting the b token = stable',
            0.1,
            0.3,
            0.7,
            12,
          ),
          run(1, 'The explanation then continues as prose.', 0.1, 0.4, 0.7),
        ]),
      ],
      sourceHash: '5'.repeat(64),
      fileName: 'lowercase-equation-prose.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) =>
          'text' in node &&
          node.text === 'results hold when fitting the b token = stable',
      ),
    ).toMatchObject({ type: 'paragraph' })
  })

  it('reassembles a fully emphasized lowercase wrap without requiring a printed hyphen', async () => {
    const headingRun = (text: string, x: number, y: number, width: number) => ({
      ...run(2, text, x, y, width, 12),
      fontName: 'Synthetic-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Appendix heading wrap study', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Opening prose establishes body typography.', 0.1, 0.3, 0.72),
        ]),
        page(2, [
          headingRun('E.2 The example of provided relevant', 0.54, 0.1, 0.31),
          headingRun('information', 0.585, 0.119, 0.1),
          run(
            2,
            'The appendix explanation begins after the complete heading.',
            0.54,
            0.16,
            0.36,
          ),
          headingRun(
            'F The example of generated hierarchical',
            0.54,
            0.28,
            0.35,
          ),
          headingRun('outline in DHO', 0.585, 0.299, 0.14),
          run(
            2,
            'The next appendix explanation remains ordinary prose.',
            0.54,
            0.34,
            0.36,
          ),
        ]),
      ],
      sourceHash: 'i'.repeat(64),
      fileName: 'lowercase-wrapped-appendix-heading.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^(?:E\.2|F )/u.test(node.text)
          ? [node.text]
          : [],
      ),
    ).toEqual([
      'E.2 The example of provided relevant information',
      'F The example of generated hierarchical outline in DHO',
    ])
  })

  it('requires section syntax or boundary evidence instead of font size alone', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Title', 0.1, 0.02, 0.5, 22),
          run(1, 'Abstract', 0.1, 0.08, 0.25, 16),
          run(1, 'Short abstract.', 0.1, 0.14, 0.72),
          run(1, '1 Introduction', 0.1, 0.22, 0.35, 10),
          run(1, 'A large-font callout remains prose.', 0.1, 0.3, 0.72, 18),
          run(1, '2 Related Work', 0.1, 0.38, 0.35, 10),
          run(1, 'Section prose.', 0.1, 0.46, 0.72),
          run(1, 'Additional section prose.', 0.1, 0.54, 0.72),
          run(1, 'Final section prose.', 0.1, 0.62, 0.72),
        ]),
      ],
      sourceHash: '2'.repeat(64),
      fileName: 'heading-evidence.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) =>
          'text' in node && node.text === 'A large-font callout remains prose.',
      ),
    ).toMatchObject({ type: 'paragraph' })
    expect(
      result.paper.nodes.find(
        (node) => 'text' in node && node.text === '2 Related Work',
      ),
    ).toMatchObject({ type: 'heading' })
  })

  it('preserves ordered-list ordinals and cross-page continuation evidence', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '3. Third item', 0.1, 0.2, 0.4),
          run(1, '4. Fourth item', 0.1, 0.3, 0.4),
          run(1, '1', 0.48, 0.95, 0.02, 8),
        ]),
        page(2, [
          run(2, '5. Fifth item', 0.1, 0.12, 0.4),
          run(2, '2', 0.48, 0.95, 0.02, 8),
        ]),
      ],
      sourceHash: '3'.repeat(64),
      fileName: 'continued-list.pdf',
      byteLength: 4096,
    })

    const lists = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list ? [node.list] : [],
    )
    expect(lists).toEqual([
      expect.objectContaining({
        numberingId: expect.stringMatching(/^pdf-list-p001-/),
        markerStyle: 'decimal',
        ordinal: 3,
      }),
      expect.objectContaining({
        numberingId: expect.stringMatching(/^pdf-list-p001-/),
        markerStyle: 'decimal',
        ordinal: 4,
      }),
      expect.objectContaining({
        numberingId: expect.stringMatching(/^pdf-list-p001-/),
        markerStyle: 'decimal',
        ordinal: 5,
        continuedFromPreviousPage: true,
      }),
    ])
    expect(new Set(lists.map((list) => list.numberingId)).size).toBe(1)
  })

  it('keeps a flush source-contiguous wrapped line inside its proved ordered-list item', async () => {
    const storyRun = (text: string, x: number, y: number, width: number) => ({
      ...run(1, text, x, y, width, 8.9664),
      height: 0.0106503,
      fontName: 'Synthetic-Monospaced',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ordered list wrapping', 0.1, 0.04, 0.8, 18),
          ...[0.14, 0.18, 0.22].flatMap((y, index) => [
            storyRun(`Left-column context ${index + 1}.`, 0.1, y, 0.36),
            storyRun(`Right-column context ${index + 1}.`, 0.54, y, 0.36),
          ]),
          storyRun('1.', 0.12909, 0.51764, 0.01506),
          storyRun(
            'Lila, Katarina, and Oliver start',
            0.18488,
            0.51764,
            0.2908,
          ),
          storyRun(
            'a business together selling environmentally',
            0.12909,
            0.52948,
            0.34697,
          ),
          storyRun('friendly products.', 0.12909, 0.54131, 0.13556),
          storyRun('2. The business is a success.', 0.12909, 0.55314, 0.3466),
          storyRun(
            '3. Their friendship grows stronger.',
            0.12909,
            0.588,
            0.3466,
          ),
        ]),
      ],
      sourceHash: '0'.repeat(64),
      fileName: 'flush-wrapped-list-item.pdf',
      byteLength: 4096,
      metadata: { title: 'Ordered list wrapping' },
    })
    const listItems = result.paper.nodes.filter(
      (
        node,
      ): node is Extract<ResearchNode, { type: 'paragraph' }> & {
        list: NonNullable<Extract<ResearchNode, { type: 'paragraph' }>['list']>
      } => node.type === 'paragraph' && node.list !== undefined,
    )
    const first = listItems.find(
      (node) => node.type === 'paragraph' && node.list?.ordinal === 1,
    )

    expect(first).toMatchObject({
      type: 'paragraph',
      text: 'Lila, Katarina, and Oliver start a business together selling environmentally friendly products.',
      list: {
        ordinal: 1,
        markerText: '1.',
      },
    })
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' &&
          node.text.startsWith('a business together'),
      ),
    ).toEqual([])
    expect(listItems.map((node) => node.list?.ordinal)).toEqual([1, 2, 3])
    expect(new Set(listItems.map((node) => node.list?.numberingId)).size).toBe(
      1,
    )
    expect(result.provenance[first!.id]).toMatchObject({
      regionIds: expect.arrayContaining([
        expect.stringContaining('page-001-region-'),
      ]),
    })

    const epub = await buildReadableEpub(result.paper, result)
    const content = strFromU8(
      inspectEpub(epub.bytes).files['EPUB/content.xhtml'],
    )
    expect(content.match(/<ol(?:\s|>)/gu)).toHaveLength(1)
    expect(content).toMatch(
      /<li\b[^>]*>.*Lila, Katarina, and Oliver start a business together selling environmentally friendly products\.<\/li>/u,
    )
  })

  it('splits a source-deindented paragraph after a sentence-complete list item', async () => {
    const bodyRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Synthetic-Regular',
      fontSize = 10.9091,
    ) => ({
      ...run(1, text, x, y, width, fontSize),
      height: 0.01296,
      fontName,
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'List tail paragraph boundary', 0.1, 0.04, 0.8, 18),
          bodyRun('4.', 0.52883, 0.29338, 0.01374),
          bodyRun(
            'Humanlike. Judged to be human-written.',
            0.55094,
            0.29338,
            0.307,
          ),
          bodyRun(
            'We additionally track how often generated stories',
            0.53261,
            0.31599,
            0.351,
          ),
          bodyRun(
            'suffer from the following independent issues.',
            0.51429,
            0.33209,
            0.369,
          ),
          bodyRun(
            'A separate source paragraph follows the reconstructed boundary.',
            0.51429,
            0.37,
            0.369,
          ),
          bodyRun('5.', 0.52883, 0.45127, 0.01374),
          bodyRun(
            'Disfluent. Frequent grammatical errors.',
            0.55094,
            0.45127,
            0.29,
          ),
          bodyRun(
            'Binary indicators for these issues are summed',
            0.53261,
            0.47388,
            0.348,
          ),
          bodyRun(
            'and reported together in the following paragraph.',
            0.51429,
            0.48997,
            0.367,
          ),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'list-tail-paragraph.pdf',
      byteLength: 4096,
      metadata: { title: 'List tail paragraph boundary' },
    })

    expect(
      result.paper.nodes.find(
        (node) => node.type === 'paragraph' && node.list?.markerText === '4.',
      ),
    ).toMatchObject({
      text: 'Humanlike. Judged to be human-written.',
      list: { ordinal: 4, markerText: '4.' },
    })
    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' &&
          node.text.startsWith('We additionally track'),
      ),
    ).toMatchObject({
      text: 'We additionally track how often generated stories suffer from the following independent issues.',
    })
    expect(
      result.paper.nodes.find(
        (node) => node.type === 'paragraph' && node.list?.markerText === '5.',
      ),
    ).toMatchObject({
      text: 'Disfluent. Frequent grammatical errors.',
      list: { ordinal: 5, markerText: '5.' },
    })
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' &&
          node.text.startsWith('Binary indicators'),
      ),
    ).toEqual([
      expect.objectContaining({
        text: 'Binary indicators for these issues are summed and reported together in the following paragraph.',
      }),
    ])
    expect(result.completeness.unprovenancedRenderedUnitCount).toBe(0)
  })

  it('keeps a sentence-final math variable out of a false Roman-numeral list', async () => {
    const variable = {
      ...run(1, 'D', 0.1, 0.322, 0.015, 10.9091),
      fontName: 'Synthetic-CMMI10',
      height: 0.01296,
    }
    const continuation = {
      ...run(
        1,
        '.Previous works have used higher-level attributes.',
        0.1157,
        0.322,
        0.35,
        10.9091,
      ),
      height: 0.01296,
    }
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'False list boundary', 0.1, 0.04, 0.8, 18),
          run(1, '1 Method', 0.1, 0.12, 0.3, 14),
          run(
            1,
            'The hierarchical outline is composed of a detailed outline',
            0.1,
            0.3,
            0.72,
            10.9091,
          ),
          variable,
          continuation,
          run(
            1,
            'The following source line remains in the same paragraph.',
            0.1,
            0.344,
            0.72,
            10.9091,
          ),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'false-roman-list-boundary.pdf',
      byteLength: 4096,
      metadata: { title: 'False list boundary' },
    })

    const paragraphs = result.paper.nodes.filter(
      (node): node is Extract<ResearchNode, { type: 'paragraph' }> =>
        node.type === 'paragraph',
    )
    expect(paragraphs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'The hierarchical outline is composed of a detailed outline D. Previous works have used higher-level attributes. The following source line remains in the same paragraph.',
        }),
      ]),
    )
    expect(
      paragraphs.find((node) =>
        node.text.startsWith('The hierarchical outline is composed'),
      )?.list,
    ).toBeUndefined()
    expect(paragraphs.some((node) => node.list?.ordinal === 500)).toBe(false)
  })

  it('does not interpret a two-column list transition as deep nesting', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '1. Left item one', 0.08, 0.2, 0.34),
          run(1, '1. Right item one', 0.56, 0.2, 0.34),
          run(1, '2. Left item two', 0.08, 0.26, 0.34),
          run(1, '2. Right item two', 0.56, 0.26, 0.34),
          run(1, '3. Left item three', 0.08, 0.32, 0.34),
          run(1, '3. Right item three', 0.56, 0.32, 0.34),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'two-column-lists.pdf',
      byteLength: 4096,
    })

    const lists = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list ? [node.list] : [],
    )
    expect(lists).toHaveLength(6)
    expect(lists.map((list) => list.level)).toEqual([1, 1, 1, 1, 1, 1])
    expect(new Set(lists.map((list) => list.numberingId)).size).toBe(2)
  })

  it('preserves bracketed, parenthesized, and suffixed list markers with gaps', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '1) First item', 0.1, 0.2, 0.4),
          run(1, '(a) Nested alpha item', 0.14, 0.26, 0.4),
          run(1, '(1) Nested numeric item', 0.14, 0.32, 0.4),
          run(1, '3) Third item after a gap', 0.1, 0.38, 0.4),
        ]),
        page(2, [run(2, '4) Fourth item continues.', 0.1, 0.12, 0.5)]),
        page(3, [
          run(3, 'References', 0.1, 0.12, 0.3, 16),
          run(3, '[1] Bracketed reference.', 0.1, 0.22, 0.6),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'marker-fidelity.pdf',
      byteLength: 4096,
    })

    const listNodes = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list ? [node] : [],
    )
    expect(
      listNodes.map((node) => ({ text: node.text, list: node.list })),
    ).toEqual([
      expect.objectContaining({
        text: 'First item',
        list: expect.objectContaining({
          markerText: '1)',
          markerStyle: 'decimal',
          ordinal: 1,
        }),
      }),
      expect.objectContaining({
        text: 'Nested alpha item',
        list: expect.objectContaining({
          markerText: '(a)',
          markerStyle: 'lower-alpha',
          ordinal: 1,
        }),
      }),
      expect.objectContaining({
        text: 'Nested numeric item',
        list: expect.objectContaining({
          markerText: '(1)',
          markerStyle: 'decimal',
          ordinal: 1,
        }),
      }),
      expect.objectContaining({
        text: 'Third item after a gap',
        list: expect.objectContaining({
          markerText: '3)',
          markerStyle: 'decimal',
          ordinal: 3,
        }),
      }),
      expect.objectContaining({
        text: 'Fourth item continues.',
        list: expect.objectContaining({
          markerText: '4)',
          markerStyle: 'decimal',
          ordinal: 4,
          continuedFromPreviousPage: true,
        }),
      }),
      expect.objectContaining({
        text: 'Bracketed reference.',
        list: expect.objectContaining({
          markerText: '[1]',
          markerStyle: 'decimal',
          ordinal: 1,
          numberingId: 'references',
        }),
      }),
    ])
    const proseListIds = listNodes
      .filter((node) => node.list?.numberingId !== 'references')
      .map((node) => node.list!.numberingId)
    expect(new Set(proseListIds).size).toBe(1)
  })
})
