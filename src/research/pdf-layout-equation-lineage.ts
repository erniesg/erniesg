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
})
