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
  it('fails closed when a singleton OCR language conflicts with unambiguous strong-script evidence', async () => {
    const result = await reconstructPageAnalyses({
      pages: [ocrPage('بحث عربي موثوق', ['eng'])],
      sourceHash: '6'.repeat(64),
      fileName: 'conflicting-language.pdf',
      byteLength: 2048,
    })

    expect(result.paper).toMatchObject({
      language: 'und',
      baseDirection: 'unknown',
      metadataLineage: {
        language: {
          status: 'unresolved',
          evidence: ['ocr-language-script-conflict:en:rtl'],
        },
        baseDirection: { status: 'unresolved' },
      },
    })
  })

  it('infers only unambiguous RTL strong-script direction without inventing a language', async () => {
    const rtl = await reconstructPageAnalyses({
      pages: [page(1, [run(1, 'מחקר מקומי אמין', 0.1, 0.2, 0.75)])],
      sourceHash: '3'.repeat(64),
      fileName: 'hebrew-unknown-language.pdf',
      byteLength: 2048,
    })
    const mixed = await reconstructPageAnalyses({
      pages: [page(1, [run(1, 'מחקר local mixed text', 0.1, 0.2, 0.75)])],
      sourceHash: '4'.repeat(64),
      fileName: 'mixed-direction.pdf',
      byteLength: 2048,
    })

    expect(rtl.paper).toMatchObject({
      language: 'und',
      baseDirection: 'rtl',
      metadataLineage: {
        baseDirection: {
          status: 'proven',
          source: 'pdf-strong-script',
        },
      },
    })
    expect(mixed.paper).toMatchObject({
      language: 'und',
      baseDirection: 'unknown',
      metadataLineage: {
        baseDirection: { status: 'unresolved' },
      },
    })
  })

  it('keeps PDF artifact modification time separate from unresolved publication date', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'Artifact metadata is not a publication date.',
            0.1,
            0.2,
            0.75,
          ),
        ]),
      ],
      sourceHash: '5'.repeat(64),
      fileName: 'artifact-date.pdf',
      byteLength: 2048,
      metadata: { modified: '2026-07-23T00:42:00Z' },
    })

    expect(result.paper).toMatchObject({
      artifactModifiedAt: '2026-07-23T00:42:00.000Z',
      metadataLineage: {
        publicationDate: {
          status: 'unresolved',
          source: 'pdf-xmp-not-extracted',
          evidence: ['pdf-xmp-metadata-not-extracted'],
        },
        artifactModifiedAt: {
          status: 'proven',
          source: 'pdf-info-mod-date',
        },
      },
    })
    expect(result.paper).not.toHaveProperty('publicationDate')
  })

  it('replays retained prose boundaries after consuming an exact table line suffix', () => {
    const proseRuns = [
      run(1, 'This method is deter-', 0.1, 0.2, 0.65),
      run(1, 'ministic.', 0.1, 0.225, 0.2),
    ]
    const tableRuns = [
      run(1, 'Metric Baseline Proposed', 0.1, 0.5, 0.7),
      run(1, 'Accuracy 71.2 84.6', 0.1, 0.53, 0.7),
      run(1, 'Recall 68.4 82.1', 0.1, 0.56, 0.7),
    ]
    const lines = [...proseRuns, ...tableRuns].map((sourceRun, index) => ({
      id: `mixed-line-${index + 1}`,
      text: sourceRun.text,
      fontSize: sourceRun.fontSize,
      box: { ...sourceRun },
      runs: [{ ...sourceRun }],
    }))
    const region = {
      id: 'mixed-prose-table-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'This method is deterministic. Metric Baseline Proposed Accuracy 71.2 84.6 Recall 68.4 82.1',
      confidence: 1,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.378,
        rotation: 0,
        method: 'pdf-text',
      },
      lines,
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies import('./import-types').PdfPageRegion
    const decisions = lines.slice(1).map((line, index) => ({
      id: `mixed-boundary-${index + 1}`,
      page: 1,
      regionId: region.id,
      fromLineId: lines[index].id,
      toLineId: line.id,
      outcome:
        index === 0
          ? ('removed-discretionary-hyphen' as const)
          : ('space' as const),
      evidence: index === 0 ? ['same-document-unhyphenated-word'] : [],
    }))

    const residual = residualPdfRegionAfterLineConsumption(
      region,
      new Set(tableRuns.map((_, index) => `mixed-line-${index + 3}`)),
      decisions,
    )

    expect(residual).toMatchObject({
      id: region.id,
      text: 'This method is deterministic.',
      box: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.65,
        height: 0.043,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [{ id: 'mixed-line-1' }, { id: 'mixed-line-2' }],
    })
  })

  it('splits noncontiguous residual lines without inventing a source boundary', () => {
    const lines = ['Alpha', 'Table row', 'Omega'].map((text, index) => ({
      id: `interleaved-line-${index + 1}`,
      text,
      fontSize: 10,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2 + index * 0.02,
        width: 0.7,
        height: 0.018,
        rotation: 0,
        method: 'pdf-text' as const,
      },
      runs: [],
    }))
    const region = {
      id: 'interleaved-prose-table-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'Alpha Table row Omega',
      confidence: 1,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.058,
        rotation: 0,
        method: 'pdf-text',
      },
      lines,
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies import('./import-types').PdfPageRegion
    const decisions = lines.slice(1).map((line, index) => ({
      id: `interleaved-boundary-${index + 1}`,
      page: 1,
      regionId: region.id,
      fromLineId: lines[index].id,
      toLineId: line.id,
      outcome: 'space' as const,
      evidence: ['ordinary-wrap'],
    }))

    const fragments = residualPdfRegionFragmentsAfterLineConsumption(
      region,
      new Set(['interleaved-line-2']),
      decisions,
    )

    expect(
      fragments.map(({ region: fragment, sourceStart, sourceEnd }) => ({
        text: fragment.text,
        lineIds: fragment.lines.map((line) => line.id),
        sourceStart,
        sourceEnd,
      })),
    ).toEqual([
      {
        text: 'Alpha',
        lineIds: ['interleaved-line-1'],
        sourceStart: 0,
        sourceEnd: 5,
      },
      {
        text: 'Omega',
        lineIds: ['interleaved-line-3'],
        sourceStart: 16,
        sourceEnd: 21,
      },
    ])
  })

  it('separates title-page metadata and abstract from continuous body nodes', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Semantic Paper', 0.1, 0.08, 0.7, 22),
          run(1, 'Ada Example; Ben Reader', 0.1, 0.15, 0.6, 11),
          run(
            1,
            'Department of Evidence, Example University',
            0.1,
            0.2,
            0.7,
            9,
          ),
          run(1, 'Abstract', 0.1, 0.3, 0.25, 16),
          run(
            1,
            'This abstract belongs in document metadata.',
            0.1,
            0.36,
            0.72,
          ),
          run(1, '1 Introduction', 0.1, 0.5, 0.35, 10),
          run(1, 'Continuous body prose starts here.', 0.1, 0.56, 0.72),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'semantic-front-matter.pdf',
      byteLength: 4096,
    })

    expect(result.paper).toMatchObject({
      title: 'A Semantic Paper',
      authors: ['Ada Example', 'Ben Reader'],
      affiliations: ['Department of Evidence, Example University'],
      abstract: 'This abstract belongs in document metadata.',
    })
    expect(
      result.paper.nodes.map((node) => ('text' in node ? node.text : '')),
    ).toEqual([
      'Abstract',
      'This abstract belongs in document metadata.',
      '1 Introduction',
      'Continuous body prose starts here.',
    ])
    expect(result.paper.nodes[2]).toMatchObject({
      type: 'heading',
      level: 1,
    })
    expect(result.completeness.textCoverage).toBe(1)
  })

  it('separates adjacent section headings before semantic classification', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '1 Introduction', 0.1, 0.22, 0.35, 10),
          run(
            1,
            'Continuous body prose starts immediately below.',
            0.1,
            0.239,
            0.72,
          ),
        ]),
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'adjacent-heading.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.map((node) =>
        'text' in node ? { type: node.type, text: node.text } : null,
      ),
    ).toEqual([
      { type: 'heading', text: '1 Introduction' },
      {
        type: 'paragraph',
        text: 'Continuous body prose starts immediately below.',
      },
    ])
  })

  it('recognizes same-size medium-face hierarchical section headings', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Previous body paragraph ends here.', 0.1, 0.1, 0.72, 10),
          {
            ...run(1, '3.2 Draft Module', 0.52, 0.2, 0.25, 10),
            fontName: 'NimbusRomNo9L-Medi',
          },
          run(1, 'Following body prose.', 0.52, 0.25, 0.35, 10),
        ]),
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'medium-face-heading.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) => node.type === 'heading' && node.text === '3.2 Draft Module',
      ),
    ).toMatchObject({ type: 'heading', level: 2 })
  })

  it('recognizes source-small-caps headings under any ordinal numeral system', async () => {
    // Faux small caps reduced from an observed IEEE-style paper: one line
    // alternating full capitals with reduced small capitals in the same
    // regular font, at body nominal size and never bold. Roman ordinals past
    // one character carry no less evidence than arabic or single-letter ones.
    // Capitals sit at body nominal size, so no size-contrast rule can fire;
    // the only typographic evidence is the internal cap/small-cap alternation.
    const smallCapsHeading = (text: string, y: number) => {
      const boundary = text.indexOf(' ') + 2
      return [
        run(2, text.slice(0, boundary), 0.1, y, 0.04, 10),
        run(2, text.slice(boundary), 0.14, y + 0.0025, 0.24, 8),
      ]
    }
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ordinal numeral system study', 0.1, 0.08, 0.72, 20),
          run(
            1,
            'Opening prose establishes ordinary body typography.',
            0.1,
            0.22,
            0.72,
          ),
        ]),
        page(2, [
          ...smallCapsHeading('II. COLLECTING AN EVALUATION SET', 0.12),
          run(
            2,
            'The source-backed collection method follows its roman heading.',
            0.1,
            0.155,
            0.72,
          ),
          ...smallCapsHeading('III. AN AGENT-BASED REPAIR SYSTEM', 0.3),
          run(
            2,
            'The source-backed system description follows its roman heading.',
            0.1,
            0.335,
            0.72,
          ),
          ...smallCapsHeading('IV. EVALUATING GENERATED REPAIRS', 0.5),
          run(
            2,
            'The source-backed evaluation summary follows its roman heading.',
            0.1,
            0.535,
            0.72,
          ),
        ]),
      ],
      sourceHash: 'i'.repeat(64),
      fileName: 'roman-ordinal-headings.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^(?:II|III|IV)\./u.test(node.text)
          ? [node.text]
          : [],
      ),
    ).toEqual([
      'II. COLLECTING AN EVALUATION SET',
      'III. AN AGENT-BASED REPAIR SYSTEM',
      'IV. EVALUATING GENERATED REPAIRS',
    ])
  })

  it('recognizes source-small-caps named headings from standalone section geometry', async () => {
    const smallCapsHeading = (text: string, y: number) => [
      run(2, text[0], 0.1, y, 0.018, 12),
      run(2, text.slice(1), 0.118, y + 0.0025, 0.27, 9.6),
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Small-caps section study', 0.1, 0.08, 0.72, 20),
          run(
            1,
            'Opening prose establishes ordinary body typography.',
            0.1,
            0.22,
            0.72,
          ),
        ]),
        page(2, [
          ...smallCapsHeading('REPRODUCIBILITY', 0.12),
          run(
            2,
            'The source-backed reproducibility statement follows the heading.',
            0.1,
            0.155,
            0.72,
          ),
          ...smallCapsHeading('AUTHOR CONTRIBUTIONS', 0.3),
          run(
            2,
            'The source-backed contribution statement follows the heading.',
            0.1,
            0.335,
            0.72,
          ),
        ]),
        page(3, [
          ...smallCapsHeading('J.7 CASE STUDY', 0.12),
          run(
            3,
            'The appendix case-study overview follows its ordinal heading.',
            0.1,
            0.155,
            0.72,
          ),
          ...smallCapsHeading('J.7.1 PREVENTATIVE STEERING', 0.3),
          run(
            3,
            'The nested appendix detail follows its deeper ordinal heading.',
            0.1,
            0.335,
            0.72,
          ),
        ]),
      ],
      sourceHash: 'h'.repeat(64),
      fileName: 'small-caps-named-headings.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' &&
        ['REPRODUCIBILITY', 'AUTHOR CONTRIBUTIONS'].includes(node.text)
          ? [{ text: node.text, level: node.level }]
          : [],
      ),
    ).toEqual([
      { text: 'REPRODUCIBILITY', level: 1 },
      { text: 'AUTHOR CONTRIBUTIONS', level: 1 },
    ])
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^J\.7/u.test(node.text)
          ? [{ text: node.text, level: node.level }]
          : [],
      ),
    ).toEqual([
      { text: 'J.7 CASE STUDY', level: 2 },
      { text: 'J.7.1 PREVENTATIVE STEERING', level: 3 },
    ])
  })

  it('does not promote emphasized run-ins, tabular headers, or chart labels as named headings', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Named-heading guard study', 0.1, 0.08, 0.72, 20),
          run(
            1,
            'Ordinary prose establishes the body typography.',
            0.1,
            0.18,
            0.72,
          ),
          {
            ...run(1, 'LIMITATION:', 0.1, 0.3, 0.12, 10),
            fontName: 'NimbusRomNo9L-Medi',
          },
          run(
            1,
            'This run-in explanation remains part of ordinary prose.',
            0.225,
            0.3,
            0.55,
          ),
          {
            ...run(1, 'METHOD', 0.1, 0.46, 0.11, 10),
            fontName: 'NimbusRomNo9L-Medi',
          },
          {
            ...run(1, 'SCORE', 0.35, 0.46, 0.1, 10),
            fontName: 'NimbusRomNo9L-Medi',
          },
          {
            ...run(1, 'DATASET', 0.6, 0.46, 0.12, 10),
            fontName: 'NimbusRomNo9L-Medi',
          },
          {
            ...run(1, 'ACCURACY', 0.72, 0.68, 0.08, 7),
            fontName: 'Helvetica-Bold',
          },
          run(1, '0.8', 0.72, 0.71, 0.04, 7),
          run(1, '0.6', 0.72, 0.74, 0.04, 7),
        ]),
      ],
      sourceHash: 'g'.repeat(64),
      fileName: 'named-heading-guards.pdf',
      byteLength: 4096,
    })

    const guarded = new Set([
      'LIMITATION:',
      'METHOD',
      'SCORE',
      'DATASET',
      'ACCURACY',
    ])
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && guarded.has(node.text) ? [node.text] : [],
      ),
    ).toEqual([])
  })

  it('does not consume a sequenced structural heading overlapped by a figure boundary', async () => {
    const section = (text: string, y: number) => ({
      ...run(2, text, 0.1, y, 0.25, 10),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const secondPage: PdfPageAnalysis = {
      ...page(2, [
        run(2, 'Diagram-internal label', 0.18, 0.12, 0.18, 8),
        run(
          2,
          'Figure 6: Scalability results for the evaluated systems.',
          0.1,
          0.21,
          0.4,
          9,
        ),
        section('5.2 Ablation studies', 0.265),
        run(2, 'The ablation explanation remains prose.', 0.1, 0.31, 0.36),
        section('5.3 Scalability', 0.5),
        run(2, 'The scalability explanation remains prose.', 0.1, 0.55, 0.36),
      ]),
      objects: [
        {
          id: 'image-p002-wide-figure',
          page: 2,
          kind: 'image',
          assetId: null,
          confidence: 0.99,
          box: {
            page: 2,
            x: 0.05,
            y: 0.05,
            width: 0.68,
            height: 0.24,
            rotation: 0,
            method: 'pdf-object',
          },
        },
      ],
    }
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Visual overlap study', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Opening prose establishes body typography.', 0.1, 0.3, 0.72),
          {
            ...run(1, '5.1 Comparison experiments', 0.1, 0.5, 0.3, 10),
            fontName: 'NimbusRomNo9L-Medi',
          },
        ]),
        secondPage,
      ],
      sourceHash: 'o'.repeat(64),
      fileName: 'figure-overlapped-structural-heading.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^5\.[123]\s/u.test(node.text)
          ? [node.text]
          : [],
      ),
    ).toEqual([
      '5.1 Comparison experiments',
      '5.2 Ablation studies',
      '5.3 Scalability',
    ])
  })

  it('separates strongly styled numbered headings that contain scholarly punctuation', async () => {
    const styled = (
      text: string,
      y: number,
      fontName: string,
      width = 0.58,
    ) => ({
      ...run(2, text, 0.1, y, width, 10),
      fontName,
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Punctuated scholarly headings', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Opening context.', 0.1, 0.3, 0.72, 10),
        ]),
        page(2, [
          run(
            2,
            'Ordinary body prose establishes the base typography.',
            0.1,
            0.08,
            0.72,
          ),
          styled('3 CHALLENGE 1: REPRESENTATION', 0.16, 'Subset+LinBiolinumTB'),
          run(
            2,
            'The main-section explanation remains prose.',
            0.1,
            0.181,
            0.7,
          ),
          styled(
            '3.1 Subchallenge 1a: Representation Fusion',
            0.28,
            'Subset+LinBiolinumTB',
          ),
          run(2, 'The subsection explanation remains prose.', 0.1, 0.301, 0.7),
          styled(
            '2.1 Prediction markets and mechanisms.',
            0.4,
            'Subset+CMBX12',
          ),
          run(
            2,
            'The terminal-dot heading has its own prose.',
            0.1,
            0.421,
            0.7,
          ),
          styled('3.3. Training Objective', 0.52, 'Subset+CMBX12'),
          run(
            2,
            'Training Recurrent Models through Unrolling. To ensure convergence, the explanation continues.',
            0.1,
            0.541,
            0.76,
          ),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'punctuated-styled-headings.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && node.text !== 'Abstract'
          ? [{ text: node.text, level: node.level }]
          : [],
      ),
    ).toEqual([
      { text: '3 CHALLENGE 1: REPRESENTATION', level: 1 },
      { text: '3.1 Subchallenge 1a: Representation Fusion', level: 2 },
      { text: '2.1 Prediction markets and mechanisms.', level: 2 },
      { text: '3.3. Training Objective', level: 2 },
    ])
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph')
        .map((node) => node.text),
    ).toEqual(
      expect.arrayContaining([
        'The main-section explanation remains prose.',
        'The subsection explanation remains prose.',
        'The terminal-dot heading has its own prose.',
        'Training Recurrent Models through Unrolling. To ensure convergence, the explanation continues.',
      ]),
    )
  })

  it('does not promote sequenced machine-identifier table rows to headings', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'API corpus table', 0.1, 0.08, 0.72, 20),
          run(
            1,
            'Ordinary prose establishes the body typography.',
            0.1,
            0.18,
            0.72,
          ),
          run(
            1,
            '27 get_administrative_case_company_list Query Administrative cases',
            0.1,
            0.3,
            0.76,
          ),
          run(1, 'CompanyInfo Query Results', 0.18, 0.33, 0.5),
          run(
            1,
            '28 get_administrative_case_court_list Query Court cases',
            0.1,
            0.4,
            0.72,
          ),
          run(1, 'CourtInfo Query Results', 0.18, 0.43, 0.5),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'numbered-api-table-rows.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'heading' && /get_administrative_case/u.test(node.text),
      ),
    ).toEqual([])
  })

  it('does not promote a mixed-size chart label from one oversized glyph', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Small-chart typography study', 0.1, 0.08, 0.72, 18),
          run(1, 'Body calibration one.', 0.1, 0.18, 0.5, 6),
          run(1, 'Body calibration two.', 0.1, 0.22, 0.5, 6),
          run(1, 'Body calibration three.', 0.1, 0.26, 0.5, 6),
          {
            ...run(1, 'Epoch', 0.1, 0.4, 0.045, 4.2),
            fontName: 'Helvetica-Bold',
          },
          {
            ...run(1, 'inference', 0.148, 0.4, 0.065, 6.14),
            fontName: 'Helvetica',
          },
          {
            ...run(1, '!', 0.216, 0.4, 0.008, 9.55),
            fontName: 'CambriaMath',
          },
          run(1, 'Body calibration four.', 0.1, 0.52, 0.5, 6),
          run(1, 'Body calibration five.', 0.1, 0.56, 0.5, 6),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'mixed-size-chart-label.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) => 'text' in node && node.text === 'Epoch inference!',
      ),
    ).not.toMatchObject({ type: 'heading' })
  })

  it('recognizes adjacent author names separated by affiliation markers', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Marker-aware authors', 0.1, 0.08, 0.72, 18),
          run(1, 'Ada Example2 Ben Reader1', 0.1, 0.15, 0.6, 11),
          run(1, '1 Example University', 0.1, 0.21, 0.7, 9),
          run(1, 'Abstract', 0.1, 0.3, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.36, 0.72),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'marker-aware-authors.pdf',
      byteLength: 4096,
    })

    expect(result.paper.authors).toEqual(['Ada Example', 'Ben Reader'])
  })

  it('splits run-backed prose accidentally merged across a proven column gutter', async () => {
    const medium = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontSize = 10,
    ) => ({
      ...run(2, text, x, y, width, fontSize),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Two-column section ordering', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Opening context.', 0.1, 0.3, 0.72, 10),
        ]),
        page(2, [
          run(2, 'First left-column evidence.', 0.1, 0.1, 0.38),
          run(2, 'First right-column evidence.', 0.54, 0.1, 0.36),
          run(2, 'Second left-column evidence.', 0.1, 0.15, 0.38),
          run(2, 'Second right-column evidence.', 0.54, 0.15, 0.36),
          run(2, 'Third left-column evidence.', 0.1, 0.2, 0.38),
          run(2, 'Third right-column evidence.', 0.54, 0.2, 0.36),
          medium('4.1.2 Metrics', 0.54, 0.27, 0.18),
          run(
            2,
            'Table 2 presents the detailed statistics of the tasks.',
            0.1,
            0.3,
            0.39,
          ),
          run(
            2,
            'We apply three evaluation metrics, Success Rate.',
            0.514,
            0.3,
            0.37,
          ),
          medium('4 Experiment', 0.1, 0.4, 0.2),
          medium('4.1 Experiment Setup', 0.1, 0.45, 0.28),
          medium('4.1.1 Baselines', 0.1, 0.5, 0.2),
          run(2, 'Baseline prose remains in the left column.', 0.1, 0.54, 0.38),
          run(
            2,
            'Metrics prose remains in the right column.',
            0.54,
            0.34,
            0.36,
          ),
        ]),
      ],
      sourceHash: 'a'.repeat(64),
      fileName: 'cross-gutter-prose-line.pdf',
      byteLength: 4096,
    })

    expect(
      result.regions.some(
        (region) =>
          region.text.includes('Table 2 presents') &&
          region.text.includes('We apply three evaluation metrics'),
      ),
    ).toBe(false)
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^4/u.test(node.text) ? [node.text] : [],
      ),
    ).toEqual([
      '4 Experiment',
      '4.1 Experiment Setup',
      '4.1.1 Baselines',
      '4.1.2 Metrics',
    ])
  })

  it('keeps a near-gutter hanging heading in its proved right-column flow', async () => {
    const medium = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontSize = 10,
    ) => ({
      ...run(2, text, x, y, width, fontSize),
      fontName: 'NimbusRomNo9L-Medi',
      bold: true,
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Hanging right-column heading', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Opening context.', 0.1, 0.3, 0.72, 10),
        ]),
        page(2, [
          run(2, 'First left-column evidence.', 0.1, 0.1, 0.39),
          run(2, 'First right-column evidence.', 0.54, 0.1, 0.36),
          run(2, 'Second left-column evidence.', 0.1, 0.15, 0.39),
          run(2, 'Second right-column evidence.', 0.54, 0.15, 0.36),
          run(2, 'Third left-column evidence.', 0.1, 0.2, 0.39),
          run(2, 'Third right-column evidence.', 0.54, 0.2, 0.36),
          medium('6. Recurrent Depth simplifies LLMs', 0.502, 0.797, 0.31, 16),
          medium(
            '5.4. Improvements through Weight Averaging',
            0.1,
            0.801,
            0.34,
            16,
          ),
          run(
            2,
            'The left subsection explanation remains here.',
            0.1,
            0.83,
            0.39,
          ),
          run(
            2,
            'The right main-section explanation remains here.',
            0.502,
            0.83,
            0.385,
          ),
        ]),
      ],
      sourceHash: 'k'.repeat(64),
      fileName: 'hanging-right-column-heading.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^(?:5\.4|6\.)/u.test(node.text)
          ? [node.text]
          : [],
      ),
    ).toEqual([
      '5.4. Improvements through Weight Averaging',
      '6. Recurrent Depth simplifies LLMs',
    ])
  })

  it('treats institution acronyms as affiliations without a US-centric allowlist', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'International institution metadata', 0.1, 0.08, 0.72, 18),
          run(1, 'Ada Example; Ben Reader', 0.1, 0.15, 0.6, 11),
          run(1, 'INRIA Paris', 0.1, 0.21, 0.7, 9),
          run(1, 'Abstract', 0.1, 0.3, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.36, 0.72),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'international-affiliation.pdf',
      byteLength: 4096,
    })

    expect(result.paper.authors).toEqual(['Ada Example', 'Ben Reader'])
    expect(result.paper.affiliations).toEqual(['INRIA Paris'])
  })

  it('does not promote repeated tabular metric headers to section headings', async () => {
    const metricHeader =
      'Method Narration ↓ Inconsistent ↓ Confusing ↓ Repetitive ↓ Disfluent ↓ Misc. Problems ↓'
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'G Full Metrics for Miscellaneous', 0.1, 0.08, 0.5, 16),
          run(1, 'Ordinary prose establishes body typography.', 0.1, 0.16, 0.7),
          run(1, metricHeader, 0.12, 0.28, 0.76, 9),
          run(1, 'Intervening explanatory prose.', 0.1, 0.36, 0.7),
          run(1, metricHeader, 0.12, 0.42, 0.76, 9),
        ]),
      ],
      sourceHash: 'f'.repeat(64),
      fileName: 'metric-table-headers.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        'text' in node && node.text.includes('Narration ↓')
          ? [{ type: node.type, text: node.text }]
          : [],
      ),
    ).toEqual([
      { type: 'paragraph', text: metricHeader },
      { type: 'paragraph', text: metricHeader },
    ])
  })

  it('owns exact title-page note markers through canonical author references', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Source-backed author notes', 0.1, 0.08, 0.72, 18),
          run(1, 'Subhash Kantamneni', 0.24, 0.15, 0.2, 11),
          {
            ...run(1, '1', 0.441, 0.146, 0.008, 6),
            height: 0.009,
          },
          run(1, 'Max Tegmark', 0.46, 0.15, 0.13, 11),
          {
            ...run(1, '1', 0.591, 0.146, 0.008, 6),
            height: 0.009,
          },
          run(1, 'Abstract', 0.1, 0.28, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.34, 0.72),
          run(
            1,
            '1 Massachusetts Institute of Technology. Correspondence to: Subhash Kantamneni <subhashk@mit.edu>.',
            0.1,
            0.86,
            0.72,
            7,
          ),
        ]),
      ],
      sourceHash: '1'.repeat(64),
      fileName: 'numeric-author-note.pdf',
      byteLength: 4096,
    })

    const note = result.paper.nodes.find((node) => node.type === 'footnote')
    expect(note).toBeDefined()
    expect(result.paper.authorNotes).toEqual([
      {
        id: expect.any(String),
        author: 'Subhash Kantamneni',
        label: '1',
        target: note!.id,
      },
      {
        id: expect.any(String),
        author: 'Max Tegmark',
        label: '1',
        target: note!.id,
      },
    ])
    expect(note).toMatchObject({
      relationships: {
        backlinks: result.paper.authorNotes!.map((reference) => reference.id),
      },
    })
    expect(internalReferenceIntegrityIssues(result.paper)).toEqual([])
  })

  it('keeps a TeX-asterisk correspondence note out of cross-page introduction prose', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'Toward Black Scholes for Prediction Markets',
            0.2,
            0.08,
            0.6,
            18,
          ),
          run(1, 'Shaw Dalen', 0.42, 0.15, 0.12, 11),
          {
            ...run(1, '1,2', 0.541, 0.146, 0.024, 6),
            height: 0.009,
          },
          {
            ...run(1, '∗', 0.566, 0.146, 0.008, 6),
            height: 0.009,
          },
          run(1, 'Daedalus Research Team', 0.36, 0.21, 0.28, 9),
          run(1, 'Abstract', 0.44, 0.28, 0.12, 16),
          run(1, 'The abstract remains canonical prose.', 0.18, 0.34, 0.64),
          run(1, '1 Introduction', 0.18, 0.55, 0.24, 14),
          run(
            1,
            'Observed prices are interpretable as probabilities of',
            0.18,
            0.62,
            0.62,
          ),
          {
            ...run(1, '∗', 0.18, 0.856, 0.008, 6),
            height: 0.009,
          },
          run(1, 'daedalusrsch@gmail.com', 0.189, 0.86, 0.24, 9.5),
        ]),
        page(2, [
          run(
            2,
            'the event. Empirically, these prices track average beliefs.',
            0.18,
            0.12,
            0.62,
          ),
        ]),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'tex-asterisk-correspondence.pdf',
      byteLength: 4096,
      metadata: {
        title: 'Toward Black Scholes for Prediction Markets',
        author: 'Shaw Dalen',
      },
    })

    const correspondence = result.paper.nodes.find(
      (node) =>
        node.type === 'footnote' && node.text === 'daedalusrsch@gmail.com',
    )
    expect(correspondence).toMatchObject({
      label: '*',
      relationships: { backlinks: [expect.any(String)] },
    })
    expect(result.paper.authorNotes).toEqual([
      {
        id: expect.any(String),
        author: 'Shaw Dalen',
        label: '*',
        target: correspondence?.id,
      },
    ])
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph')
        .map((node) => node.text)
        .join(' '),
    ).toBe(
      'The abstract remains canonical prose. Observed prices are interpretable as probabilities of the event. Empirically, these prices track average beliefs.',
    )
    expect(result.paper.nodes[0]?.id).toBe(correspondence?.id)
    expect(result.provenance[correspondence!.id].boxes).toEqual([
      expect.objectContaining({
        page: 1,
        text: '∗',
      }),
      expect.objectContaining({
        page: 1,
        text: 'daedalusrsch@gmail.com',
      }),
    ])
  })

  it('places matched notes after their exact semantic owners without crossing headings', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Semantic note placement', 0.2, 0.08, 0.6, 18),
          run(1, 'Ada Example', 0.3, 0.15, 0.13, 11),
          {
            ...run(1, '*', 0.431, 0.146, 0.008, 6),
            height: 0.009,
          },
          run(1, 'Abstract', 0.1, 0.28, 0.25, 16),
          run(1, 'The abstract has source-backed detail', 0.1, 0.34, 0.46),
          {
            ...run(1, '§', 0.561, 0.337, 0.008, 6),
            height: 0.009,
          },
          run(1, '1 Introduction', 0.1, 0.48, 0.3, 16),
          run(1, 'Introduction prose remains separate.', 0.1, 0.55, 0.7),
          run(1, '* Lead author.', 0.1, 0.84, 0.2, 7),
          run(1, '§ Code and data are available.', 0.1, 0.87, 0.3, 7),
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'semantic-note-placement.pdf',
      byteLength: 4096,
    })

    const abstract = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text === 'The abstract has source-backed detail§',
    )
    const authorNote = result.paper.nodes.find(
      (node) => node.type === 'footnote' && node.label === '*',
    )
    const abstractNote = result.paper.nodes.find(
      (node) => node.type === 'footnote' && node.label === '§',
    )
    const introduction = result.paper.nodes.find(
      (node) => node.type === 'heading' && node.text === '1 Introduction',
    )
    const positions = new Map(
      result.paper.nodes.map((node, index) => [node.id, index]),
    )

    expect(authorNote).toBeDefined()
    expect(abstract).toBeDefined()
    expect(abstractNote).toBeDefined()
    expect(introduction).toBeDefined()
    expect(positions.get(authorNote!.id)).toBe(0)
    expect(positions.get(abstractNote!.id)).toBe(
      positions.get(abstract!.id)! + 1,
    )
    expect(positions.get(introduction!.id)).toBe(
      positions.get(abstractNote!.id)! + 1,
    )
    expect(internalReferenceIntegrityIssues(result.paper)).toEqual([])
  })

  it('owns symbolic notes when compact author markers also contain affiliations', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Compact mixed author markers', 0.1, 0.08, 0.72, 18),
          run(1, 'Runjin Chen', 0.1, 0.15, 0.09, 11),
          {
            ...run(1, '*‡1,2', 0.191, 0.146, 0.025, 6),
            height: 0.009,
          },
          run(1, 'Andy Arditi', 0.22, 0.15, 0.09, 11),
          {
            ...run(1, '†1', 0.312, 0.146, 0.012, 6),
            height: 0.009,
          },
          run(1, 'Henry Sleight', 0.33, 0.15, 0.1, 11),
          {
            ...run(1, '3', 0.432, 0.146, 0.006, 6),
            height: 0.009,
          },
          run(1, 'Owain Evans', 0.45, 0.15, 0.09, 11),
          {
            ...run(1, '4,5', 0.542, 0.146, 0.016, 6),
            height: 0.009,
          },
          run(1, 'Jack Lindsey', 0.57, 0.15, 0.09, 11),
          {
            ...run(1, '†‡6', 0.662, 0.146, 0.018, 6),
            height: 0.009,
          },
          run(1, '1 Anthropic Fellows Program', 0.1, 0.21, 0.3, 9),
          run(1, '2 UT Austin', 0.42, 0.21, 0.15, 9),
          run(1, '3 Constellation', 0.1, 0.235, 0.18, 9),
          run(1, '4 Truthful AI', 0.3, 0.235, 0.16, 9),
          run(1, '5 UC Berkeley', 0.48, 0.235, 0.17, 9),
          run(1, '6 Anthropic', 0.67, 0.235, 0.13, 9),
          run(1, 'Abstract', 0.1, 0.31, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.37, 0.72),
          run(1, '* Lead author.', 0.1, 0.82, 0.2, 7),
          run(1, '† Core contributor.', 0.1, 0.85, 0.22, 7),
          run(1, '‡ Correspondence.', 0.1, 0.88, 0.2, 7),
        ]),
      ],
      sourceHash: 'a'.repeat(64),
      fileName: 'compact-mixed-author-markers.pdf',
      byteLength: 4096,
    })

    expect(result.paper.authors).toEqual([
      'Runjin Chen',
      'Andy Arditi',
      'Henry Sleight',
      'Owain Evans',
      'Jack Lindsey',
    ])
    expect(
      result.diagnostics.flatMap((diagnostic) => {
        const classification = diagnostic.noteMarkerClassification
        return classification?.accepted &&
          classification.disposition === 'note-reference' &&
          classification.sourceBox.page === 1 &&
          classification.sourceBox.y < 0.2
          ? [classification.label]
          : []
      }),
    ).toEqual(['*', '‡', '†', '†', '‡'])
    expect(
      result.paper.authorNotes?.map(({ author, label }) => ({ author, label })),
    ).toEqual(
      expect.arrayContaining([
        { author: 'Runjin Chen', label: '*' },
        { author: 'Runjin Chen', label: '‡' },
        { author: 'Andy Arditi', label: '†' },
        { author: 'Jack Lindsey', label: '†' },
        { author: 'Jack Lindsey', label: '‡' },
      ]),
    )
    expect(
      result.paper.authorNotes?.some(({ label }) => /^\d+$/u.test(label)),
    ).toBe(false)
    expect(internalReferenceIntegrityIssues(result.paper)).toEqual([])
  })

  it('leaves a title-page note unowned when intervening prose makes author ownership ambiguous', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ambiguous author note', 0.1, 0.08, 0.72, 18),
          run(1, 'Ada Example and corresponding author', 0.2, 0.15, 0.38, 11),
          {
            ...run(1, '1', 0.581, 0.146, 0.008, 6),
            height: 0.009,
          },
          run(1, 'Abstract', 0.1, 0.28, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.34, 0.72),
          run(
            1,
            '1 A source-backed note whose author owner is not explicit.',
            0.1,
            0.86,
            0.72,
            7,
          ),
        ]),
      ],
      sourceHash: '2'.repeat(64),
      fileName: 'ambiguous-author-note.pdf',
      byteLength: 4096,
    })

    const note = result.paper.nodes.find((node) => node.type === 'footnote')
    expect(result.paper.authorNotes).toBeUndefined()
    expect(note).toMatchObject({ relationships: { backlinks: [] } })
    expect(internalReferenceIntegrityIssues(result.paper)).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNREFERENCED_NOTE' }),
      ]),
    )
  })

  it('keeps space-separated affiliation markers out of the publication title', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper Title', 0.22, 0.08, 0.56, 18),
          run(1, 'Ada Example 1 Ben Reader 1', 0.34, 0.15, 0.32, 11),
          run(1, '1 Example University', 0.1, 0.21, 0.7, 9),
          run(1, 'Abstract', 0.1, 0.3, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.36, 0.72),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'spaced-affiliation-markers.pdf',
      byteLength: 4096,
    })

    expect(result.paper.title).toBe('A Source-Backed Paper Title')
    expect(result.paper.authors).toEqual(['Ada Example', 'Ben Reader'])
  })

  it('splits a dense author line with repeated space-separated markers', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Multi-Institution Paper', 0.2, 0.08, 0.6, 18),
          run(
            1,
            'Qianyue Wang 1 2* Jinwu Hu 1 2* Zhengping Li 1 Yufeng Wang 1 3 Daiyuan Li 1 Yu Hu 4 Mingkui Tan 1 †',
            0.16,
            0.15,
            0.68,
            11,
          ),
          run(
            1,
            '1 Example University, 2 Example Laboratory',
            0.2,
            0.21,
            0.6,
            9,
          ),
          run(1, 'Abstract', 0.1, 0.3, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.36, 0.72),
        ]),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'dense-author-markers.pdf',
      byteLength: 4096,
    })

    expect(result.paper.authors).toEqual([
      'Qianyue Wang',
      'Jinwu Hu',
      'Zhengping Li',
      'Yufeng Wang',
      'Daiyuan Li',
      'Yu Hu',
      'Mingkui Tan',
    ])
  })

  it('recovers every superscript-numbered affiliation as a distinct entry', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Persona Vectors for Reliable Models', 0.2, 0.08, 0.6, 18),
          run(1, 'Ada Example1 Ben Reader2', 0.28, 0.15, 0.44, 11),
          run(1, '1', 0.18, 0.205, 0.008, 6),
          run(1, 'Anthropic Fellows Program', 0.19, 0.208, 0.19, 9),
          run(1, '2', 0.4, 0.205, 0.008, 6),
          run(1, 'UT Austin', 0.41, 0.208, 0.08, 9),
          run(1, '3', 0.18, 0.23, 0.008, 6),
          run(1, 'Constellation', 0.19, 0.233, 0.1, 9),
          run(1, '4', 0.31, 0.23, 0.008, 6),
          run(1, 'Truthful AI', 0.32, 0.233, 0.09, 9),
          run(1, '5', 0.43, 0.23, 0.008, 6),
          run(1, 'UC Berkeley', 0.44, 0.233, 0.1, 9),
          run(1, '6', 0.56, 0.23, 0.008, 6),
          run(1, 'Anthropic', 0.57, 0.233, 0.08, 9),
          run(1, 'Abstract', 0.1, 0.3, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.36, 0.72),
        ]),
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'numbered-affiliations.pdf',
      byteLength: 4096,
    })

    expect(result.paper.affiliations).toEqual([
      '1 Anthropic Fellows Program',
      '2 UT Austin',
      '3 Constellation',
      '4 Truthful AI',
      '5 UC Berkeley',
      '6 Anthropic',
    ])
    expect(result.completeness.inlineSpanCoverage).toBe(1)
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 0,
      mappedInlineSpanCount: 0,
    })
  })

  it('does not append a company affiliation to the title', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper Title', 0.22, 0.08, 0.56, 18),
          run(1, 'Ada Example1, Ben Reader2', 0.3, 0.15, 0.4, 11),
          run(1, '1 Example University', 0.33, 0.2, 0.34, 9),
          run(1, '2 LightSpeed Studios, Example Company', 0.28, 0.23, 0.44, 9),
          run(1, 'Abstract', 0.1, 0.3, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.36, 0.72),
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'company-affiliation.pdf',
      byteLength: 4096,
    })

    expect(result.paper.title).toBe('A Source-Backed Paper Title')
    expect(result.paper.authors).toEqual(['Ada Example', 'Ben Reader'])
    expect(result.paper.affiliations).toEqual(
      expect.arrayContaining([expect.stringContaining('LightSpeed Studios')]),
    )
  })

  it('collects right-side authors above an abstract despite column-major order', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Four-Author Paper', 0.16, 0.08, 0.68, 18),
          run(1, 'Kevin Yang1 Yuandong Tian2', 0.16, 0.15, 0.31, 11),
          run(1, 'Nanyun Peng3 Dan Klein1', 0.54, 0.15, 0.3, 11),
          run(1, '1UC Berkeley, 2Meta AI, 3UCLA', 0.16, 0.19, 0.31, 9),
          run(1, 'Research Group', 0.54, 0.19, 0.3, 9),
          run(1, 'Abstract', 0.16, 0.27, 0.31, 16),
          run(1, 'Visual summary', 0.54, 0.27, 0.3, 9),
          run(1, 'The abstract remains canonical prose.', 0.16, 0.33, 0.31),
          run(1, 'Diagram evidence', 0.54, 0.33, 0.3, 9),
        ]),
      ],
      sourceHash: 'a'.repeat(64),
      fileName: 'column-major-authors.pdf',
      byteLength: 4096,
    })

    expect(result.paper.authors).toEqual([
      'Kevin Yang',
      'Yuandong Tian',
      'Nanyun Peng',
      'Dan Klein',
    ])
  })

  it('proves shared author markers from stripped source while retaining a raw affiliation marker', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Shared affiliation study', 0.1, 0.08, 0.72, 18),
          run(1, 'Ada Example', 0.1, 0.18, 0.18, 11),
          run(1, '1', 0.2805, 0.176, 0.008, 6),
          run(1, ', Ben Reader', 0.29, 0.18, 0.2, 11),
          run(1, '1', 0.4905, 0.176, 0.008, 6),
          run(1, '1', 0.1, 0.246, 0.008, 6),
          run(1, 'Example University', 0.112, 0.25, 0.4, 9),
          run(1, 'Abstract', 0.1, 0.36, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.42, 0.7),
        ]),
      ],
      sourceHash: '5'.repeat(64),
      fileName: 'shared-affiliation-markers.pdf',
      byteLength: 4096,
    })

    expect(result.paper).toMatchObject({
      authors: ['Ada Example', 'Ben Reader'],
      affiliations: ['1 Example University'],
    })
    expect(result.completeness.unprovenancedRenderedUnitCount).toBe(0)
    expect(result.completeness.textCoverage).toBeGreaterThanOrEqual(0.98)

    const invented = assessPdfCompleteness({
      pages: result.pages,
      paper: {
        ...result.paper,
        affiliations: [
          ...(result.paper.affiliations ?? []),
          'Invented Metadata Institute',
        ],
      },
      diagnostics: [],
      regions: result.regions,
      readingOrder: result.readingOrder,
      provenance: result.provenance,
      visualRelationships: result.visualRelationships,
      assets: result.assets,
      citationRelationships: result.citationRelationships,
    })
    expect(invented.completeness.unprovenancedRenderedUnitCount).toBe(1)
    expect(invented.completeness.textCoverage).toBeLessThan(
      result.completeness.textCoverage,
    )
  })

  it('proves adjacent numbered affiliations when PDF extraction attaches later markers', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Attached affiliation study', 0.1, 0.08, 0.72, 18),
          run(1, 'Ada Example', 0.1, 0.18, 0.18, 11),
          run(1, '1 2 3', 0.2805, 0.176, 0.03, 6),
          run(1, '1', 0.1, 0.246, 0.008, 6),
          run(1, 'Alpha University,', 0.112, 0.25, 0.2, 9),
          run(1, '2', 0.312, 0.247, 0.008, 6),
          run(1, 'Beta Laboratory,', 0.32, 0.25, 0.2, 9),
          run(1, '3', 0.52, 0.247, 0.008, 6),
          run(1, 'Gamma Institute', 0.528, 0.25, 0.2, 9),
          run(1, 'Abstract', 0.1, 0.36, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.42, 0.7),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'attached-affiliation-markers.pdf',
      byteLength: 4096,
    })

    expect(result.paper.affiliations).toEqual([
      '1 Alpha University,',
      '2 Beta Laboratory,',
      '3 Gamma Institute',
    ])
    expect(result.completeness.unprovenancedRenderedUnitCount).toBe(0)
    expect(result.completeness.textCoverage).toBeGreaterThanOrEqual(0.97)
  })

  it('separates a raised near-body-size numeric affiliation marker from its institution', async () => {
    const marker = {
      ...run(1, '4', 0.3903, 0.2012, 0.0067, 7.9701),
      height: 0.00947,
    }
    const institution = {
      ...run(
        1,
        'Hong Kong Polytechnic University',
        0.39785,
        0.20517,
        0.21183,
        8.9664,
      ),
      height: 0.01065,
    }
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Affiliation marker geometry', 0.1, 0.08, 0.72, 18),
          run(1, 'Ada Example1 4', 0.3, 0.15, 0.2, 11),
          run(1, '1', 0.23, 0.18, 0.008, 6),
          run(1, 'Example University,', 0.24, 0.184, 0.15, 9),
          marker,
          institution,
          run(1, 'Abstract', 0.1, 0.3, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.36, 0.72),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'raised-affiliation-marker.pdf',
      byteLength: 4096,
    })

    expect(result.paper.affiliations).toEqual([
      '1 Example University,',
      '4 Hong Kong Polytechnic University',
    ])
  })

  it('recognizes a long inline abstract before affiliation keyword matching', async () => {
    const abstract =
      'This long inline abstract describes a scholarly workflow in continuous prose, cites a University-hosted corpus, and records a public https://example.org/project resource without turning the abstract into institutional metadata.'
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Inline Abstract Study', 0.1, 0.08, 0.7, 22),
          run(1, 'Ada Example; Ben Reader', 0.1, 0.15, 0.6, 11),
          run(
            1,
            'Department of Evidence, Example University',
            0.1,
            0.21,
            0.7,
            9,
          ),
          run(1, `Abstract ${abstract}`, 0.1, 0.29, 0.8),
          run(1, '1 Introduction', 0.1, 0.56, 0.35, 10),
          run(1, 'Continuous body prose starts here.', 0.1, 0.62, 0.72),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'inline-abstract-boundary.pdf',
      byteLength: 4096,
    })

    expect(result.paper).toMatchObject({
      title: 'Inline Abstract Study',
      authors: ['Ada Example', 'Ben Reader'],
      affiliations: ['Department of Evidence, Example University'],
      abstract,
    })
    expect(result.paper.affiliations).not.toContain(
      expect.stringContaining('example.org'),
    )
  })

  it('combines ordered multiline title-role blocks into one metadata title', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Semantic Framework for', 0.1, 0.07, 0.72, 22),
          run(1, 'faithful scholarly reading', 0.1, 0.13, 0.72, 17),
          run(1, 'Ada Example; Ben Reader', 0.1, 0.2, 0.6, 11),
          run(1, 'Example University', 0.1, 0.25, 0.5, 9),
          run(1, 'Abstract', 0.1, 0.34, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.4, 0.7),
        ]),
      ],
      sourceHash: '5'.repeat(64),
      fileName: 'multiline-title.pdf',
      byteLength: 4096,
    })

    expect(result.paper.title).toBe(
      'A Semantic Framework for faithful scholarly reading',
    )
    expect(
      result.paper.nodes.filter(
        (node) =>
          'text' in node &&
          /Semantic Framework|faithful scholarly reading/.test(node.text),
      ),
    ).toEqual([])
  })
})
