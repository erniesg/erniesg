import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderGraph,
  PdfSourceSemanticFlowBoundaryDecision,
  PdfSourceRun,
} from './import-types'
import type { ResearchPaper } from './schema'
import {
  assessPdfCompleteness,
  provenanceTextConservation,
  sourceSemanticFlowHyphenVerdict,
} from './pdf-quality'
import { resolvePdfHyphenBoundary } from './pdf-hyphenation'
import { mergeProseContinuations } from './pdf-layout'
import {
  PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE,
  pdfSourceSemanticFlowBoundaryDecisionId,
} from './pdf-regions'
import { run } from './pdf-quality.test-helpers'

function sourceSemanticFlowDecision(
  decision: Omit<PdfSourceSemanticFlowBoundaryDecision, 'id'>,
): PdfSourceSemanticFlowBoundaryDecision {
  return {
    id: pdfSourceSemanticFlowBoundaryDecisionId(decision),
    ...decision,
  }
}

function recanonicalizedSourceSemanticFlowDecision(
  candidate: Record<string, unknown>,
) {
  const { id: _id, ...decision } = candidate
  return sourceSemanticFlowDecision(
    decision as Omit<PdfSourceSemanticFlowBoundaryDecision, 'id'>,
  ) as unknown as Record<string, unknown>
}

function singleRegionEvidence(sourceRun: PdfSourceRun) {
  const region = {
    id: 'region-1',
    page: sourceRun.page,
    kind: 'body',
    column: 'single',
    text: sourceRun.text,
    confidence: 1,
    box: { ...sourceRun },
    lines: [
      {
        id: 'line-1',
        text: sourceRun.text,
        fontSize: sourceRun.fontSize,
        box: { ...sourceRun },
        runs: [{ ...sourceRun }],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const readingOrder = {
    schemaVersion: '1.0.0',
    regionIds: [region.id],
    order: [region.id],
    edges: [],
    resolutions: [],
    acyclic: true,
    evaluation: {
      schemaVersion: '1.0.0',
      algorithm: 'deterministic-geometry-v1',
      mode: 'deterministic-only',
      regionCount: 1,
      acceptedEdgeCount: 0,
      unresolvedEdgeCount: 0,
      cycleRate: 0,
      orderAccuracy: null,
      provider: null,
      modelVersion: null,
      latencyMs: 0,
      costUsd: 0,
      reviewRequired: false,
    },
  } satisfies PdfReadingOrderGraph
  const evidence = {
    confidence: 1,
    pages: [sourceRun.page],
    regionIds: [region.id],
    boxes: [{ ...sourceRun }],
    links: [],
  } satisfies NodeSourceEvidence
  return { region, readingOrder, evidence }
}

describe('PDF semantic signal detection', () => {
  it('verifies the producer-selected minimum run across reordered column whitespace', async () => {
    const targetRun = {
      ...run('研究结果见', 0.09, 0.82, 10, 0.385),
      sourceSequenceIndex: 520,
    }
    const firstGeometricContinuationRun = {
      ...run('2024', 0.515, 0.1, 10, 0.08),
      sourceSequenceIndex: 522,
      sourceWhitespaceBefore: 'pdf-text-item' as const,
      sourceWhitespacePredecessorIndex: 520,
    }
    const minimumSequenceContinuationRun = {
      ...run('年的结果', 0.595, 0.1, 10, 0.12),
      sourceSequenceIndex: 521,
    }
    const regions: PdfPageRegion[] = [
      {
        id: 'verified-minimum-run-target-region',
        page: 1,
        kind: 'body',
        column: 'left',
        text: targetRun.text,
        confidence: 1,
        box: { ...targetRun },
        lines: [
          {
            id: 'verified-minimum-run-target-line',
            text: targetRun.text,
            fontSize: targetRun.fontSize,
            box: { ...targetRun },
            runs: [targetRun],
            sourceFragmentLineage: {
              algorithm: 'source-run-fragment-v1',
              sourceLineId: 'verified-minimum-run-target-source-line',
              fragment: 'whole',
              sourceSequenceIndexes: [520],
            },
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: true,
      },
      {
        id: 'verified-minimum-run-continuation-region',
        page: 1,
        kind: 'body',
        column: 'right',
        text: '2024年的结果',
        confidence: 1,
        box: {
          ...minimumSequenceContinuationRun,
          x: 0.515,
          width: 0.2,
        },
        lines: [
          {
            id: 'verified-minimum-run-continuation-line',
            text: '2024年的结果',
            fontSize: minimumSequenceContinuationRun.fontSize,
            box: {
              ...minimumSequenceContinuationRun,
              x: 0.515,
              width: 0.2,
            },
            runs: [
              firstGeometricContinuationRun,
              minimumSequenceContinuationRun,
            ],
            sourceFragmentLineage: {
              algorithm: 'source-run-fragment-v1',
              sourceLineId: 'verified-minimum-run-continuation-source-line',
              fragment: 'whole',
              sourceSequenceIndexes: [522, 521],
            },
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: true,
      },
    ]
    const blocks = regions.map((region) => ({
      type: 'paragraph' as const,
      region,
      text: region.text,
      confidence: 1,
    }))
    const decisions: PdfSourceSemanticFlowBoundaryDecision[] = []

    await mergeProseContinuations(blocks, {
      language: 'zh',
      sourceSemanticFlowBoundaryDecisions: decisions,
    })

    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('研究结果见2024年的结果')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      outcome: 'no-space',
      to: { runIndex: 1, sourceSequenceIndex: 521 },
    })
    const paper: ResearchPaper = {
      id: 'verified-minimum-run-paper',
      version: '1.0.0',
      status: 'working',
      title: '',
      subtitle: 'Test',
      authors: [],
      updated: '2026-07-30',
      abstract: 'Test',
      language: 'zh',
      baseDirection: 'ltr',
      nodes: [
        {
          id: 'verified-minimum-run-node',
          type: 'paragraph',
          text: blocks[0].text,
          source: 'test',
        },
      ],
    }
    const provenance: Record<string, NodeSourceEvidence> = {
      'verified-minimum-run-node': {
        confidence: 1,
        pages: [1],
        regionIds: regions.map((region) => region.id),
        boxes: regions.map((region) => ({ ...region.box })),
        links: [],
      },
    }
    const result = provenanceTextConservation({
      allRegions: regions,
      orderedRegions: regions,
      paper,
      provenance,
      lineBoundaryDecisions: [],
      sourceSemanticFlowBoundaryDecisions: decisions,
    })

    expect(result.semanticFlowBoundaryLedgerValid).toBe(true)
    expect(result.semanticTextViolationNodeIds).toEqual([])
  })

  it.each([
    {
      name: 'missing',
      mutate: (decisions: Array<Record<string, unknown>>) => decisions.slice(1),
    },
    {
      name: 'stale sequence',
      mutate: (decisions: Array<Record<string, unknown>>) => [
        recanonicalizedSourceSemanticFlowDecision({
          ...decisions[0],
          to: {
            ...(decisions[0].to as Record<string, unknown>),
            sourceSequenceIndex: 91,
          },
        }),
      ],
    },
    {
      name: 'mutated source digest',
      mutate: (decisions: Array<Record<string, unknown>>) => [
        recanonicalizedSourceSemanticFlowDecision({
          ...decisions[0],
          to: {
            ...(decisions[0].to as Record<string, unknown>),
            sourceRunSha256: '0'.repeat(64),
          },
        }),
      ],
    },
    {
      name: 'ambiguous duplicate',
      mutate: (decisions: Array<Record<string, unknown>>) => [
        ...decisions,
        recanonicalizedSourceSemanticFlowDecision({
          ...decisions[0],
          outcome: 'space',
        }),
      ],
    },
    {
      name: 'forged identifier',
      mutate: (decisions: Array<Record<string, unknown>>) => [
        {
          ...decisions[0],
          id: 'forged-semantic-flow-id',
        },
      ],
    },
    {
      name: 'forged evidence',
      mutate: (decisions: Array<Record<string, unknown>>) => [
        recanonicalizedSourceSemanticFlowDecision({
          ...decisions[0],
          evidence: (decisions[0].evidence as string[]).filter(
            (evidence) => evidence !== 'continuation-punctuation',
          ),
        }),
      ],
    },
    {
      name: 'unused ghost entry',
      mutate: (decisions: Array<Record<string, unknown>>) => [
        ...decisions,
        recanonicalizedSourceSemanticFlowDecision({
          ...decisions[0],
          from: {
            ...(decisions[0].from as Record<string, unknown>),
            regionId: 'unused-from-region',
            lineId: 'unused-from-line',
          },
          to: {
            ...(decisions[0].to as Record<string, unknown>),
            regionId: 'unused-to-region',
            lineId: 'unused-to-line',
          },
        }),
      ],
    },
    {
      name: 'forged no-space outcome',
      texts: ['alpha', 'beta'],
      canonicalText: 'alphabeta',
      mutate: (decisions: Array<Record<string, unknown>>) => decisions,
    },
    {
      name: 'unproved inline-stacked relationship ownership',
      texts: ['x', ', which continues the sentence.'],
      canonicalText: 'x, which continues the sentence.',
      mutate: (decisions: Array<Record<string, unknown>>) => decisions,
    },
    {
      name: 'incomplete inline-stacked before-to-formula scope',
      texts: ['where', 'f(x)'],
      canonicalText: 'where f(x)',
      outcome: 'space' as const,
      evidence: [...PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE],
      fragmentParts: [
        'inline-stacked-before',
        'inline-stacked-formula',
      ] as const,
      mutate: (decisions: Array<Record<string, unknown>>) => decisions,
    },
    {
      name: 'cross-gutter fragments mislabeled as inline-stacked',
      texts: ['left fragment', 'right fragment'],
      canonicalText: 'left fragment right fragment',
      outcome: 'space' as const,
      evidence: [...PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE],
      columns: ['left', 'right'] as const,
      fragmentParts: ['cross-gutter-left', 'cross-gutter-right'] as const,
      mutate: (decisions: Array<Record<string, unknown>>) => decisions,
    },
    {
      name: 'forged space topology across unrelated whole lines',
      texts: [
        'copyright 2026',
        'this paragraph starts a distinct legal notice.',
      ],
      canonicalText:
        'copyright 2026 this paragraph starts a distinct legal notice.',
      outcome: 'space' as const,
      topology: 'inline-stacked-fragment' as const,
      evidence: [...PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE],
      wholeLineage: true,
      mutate: (decisions: Array<Record<string, unknown>>) => decisions,
    },
    {
      name: 'forged cross-column citation-year geometry',
      texts: ['Fan et al.,', '2018) separate discussion.'],
      canonicalText: 'Fan et al., 2018) separate discussion.',
      outcome: 'space' as const,
      topology: 'cross-column-citation-year' as const,
      evidence: [...PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE],
      wholeLineage: true,
      columns: ['left', 'right'] as const,
      mutate: (decisions: Array<Record<string, unknown>>) => decisions,
    },
    {
      name: 'forged aligned enumeration with mismatched fonts',
      texts: [
        'Options include (1) the first case,',
        '(2) the second case, and (3) the third case.',
      ],
      canonicalText:
        'Options include (1) the first case, (2) the second case, and (3) the third case.',
      outcome: 'space' as const,
      topology: 'aligned-enumeration' as const,
      evidence: [...PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE],
      wholeLineage: true,
      xPositions: [0.1, 0.1],
      yPositions: [0.2, 0.23],
      fontSizes: [10, 14],
      mutate: (decisions: Array<Record<string, unknown>>) => decisions,
    },
    {
      name: 'forged bibliography hanging indent outside source scope',
      texts: ['[1] Completed citation.', 'Separate legal notice.'],
      canonicalText: '[1] Completed citation. Separate legal notice.',
      outcome: 'space' as const,
      topology: 'bibliography-hanging-indent' as const,
      evidence: [...PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE],
      wholeLineage: true,
      xPositions: [0.1, 0.12],
      yPositions: [0.2, 0.23],
      mutate: (decisions: Array<Record<string, unknown>>) => decisions,
    },
    {
      name: 'forged same-baseline bibliography outside source scope',
      texts: ['[2] Completed citation.', 'Separate inline legal notice.'],
      canonicalText: '[2] Completed citation. Separate inline legal notice.',
      outcome: 'space' as const,
      topology: 'bibliography-same-baseline' as const,
      evidence: [...PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE],
      wholeLineage: true,
      xPositions: [0.1, 0.4],
      yPositions: [0.2, 0.2],
      mutate: (decisions: Array<Record<string, unknown>>) => decisions,
    },
    {
      name: 'bibliography hanging indent across an author-year reset',
      texts: [
        '[1] A. Author. Completed citation.',
        'Smith, J. 2024. Separate bibliography entry.',
      ],
      canonicalText:
        '[1] A. Author. Completed citation. Smith, J. 2024. Separate bibliography entry.',
      outcome: 'space' as const,
      topology: 'bibliography-hanging-indent' as const,
      evidence: [...PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE],
      wholeLineage: true,
      xPositions: [0.1, 0.12],
      yPositions: [0.2, 0.23],
      bibliographyScope: true,
      mutate: (decisions: Array<Record<string, unknown>>) => decisions,
    },
  ])(
    'keeps a $name semantic-flow ledger as a canonical semantic violation',
    ({
      mutate,
      texts = ['where f(x)', ', which closes the expression.'],
      canonicalText = 'where f(x), which closes the expression.',
      outcome = 'no-space',
      topology = 'inline-stacked-fragment',
      evidence = [...PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE],
      wholeLineage = false,
      columns = ['single', 'single'],
      xPositions = [0.1, 0.4],
      yPositions = [0.2, 0.2],
      fontSizes = [10, 10],
      fragmentParts = [
        'inline-stacked-formula',
        'inline-stacked-after',
      ] as const,
      bibliographyScope = false,
    }) => {
      const sourceRuns = texts.map((text, index) => ({
        ...run(
          text,
          xPositions[index],
          yPositions[index],
          fontSizes[index],
          0.28,
        ),
        sourceSequenceIndex: index,
      }))
      const regions = sourceRuns.map(
        (sourceRun, index) =>
          ({
            id: `fail-closed-flow-region-${index + 1}`,
            page: 1,
            kind: 'body',
            column: columns[index],
            text: sourceRun.text,
            confidence: 1,
            box: { ...sourceRun },
            lines: [
              {
                id: `fail-closed-flow-line-${index + 1}`,
                text: sourceRun.text,
                fontSize: sourceRun.fontSize,
                box: { ...sourceRun },
                runs: [{ ...sourceRun }],
                sourceFragmentLineage: {
                  algorithm: 'source-run-fragment-v1',
                  sourceLineId: wholeLineage
                    ? `fail-closed-whole-source-line-${index + 1}`
                    : 'fail-closed-stacked-source-line',
                  fragment: wholeLineage ? 'whole' : fragmentParts[index],
                  sourceSequenceIndexes: [index],
                },
              },
            ],
            nativeObjectIds: [],
            includedInReadingOrder: true,
          }) as PdfPageRegion,
      )
      const sourceRunSha256 = sourceRuns.map((sourceRun) =>
        createHash('sha256')
          .update(
            JSON.stringify([
              sourceRun.page,
              sourceRun.rotation,
              sourceRun.method,
              sourceRun.x,
              sourceRun.y,
              sourceRun.width,
              sourceRun.height,
              sourceRun.text.normalize('NFC'),
              sourceRun.fontName,
              sourceRun.fontSize,
              sourceRun.sourceSequenceIndex ?? null,
              sourceRun.sourceWhitespaceBefore ?? null,
              sourceRun.sourceWhitespacePredecessorIndex ?? null,
            ]),
          )
          .digest('hex'),
      )
      const decision = sourceSemanticFlowDecision({
        page: 1,
        rotation: 0,
        method: 'pdf-text',
        topology: topology as PdfSourceSemanticFlowBoundaryDecision['topology'],
        outcome: outcome as PdfSourceSemanticFlowBoundaryDecision['outcome'],
        from: {
          regionId: regions[0].id,
          lineId: regions[0].lines[0].id,
          runIndex: 0,
          sourceSequenceIndex: 0,
          sourceRunSha256: sourceRunSha256[0],
          sourceFragmentId: wholeLineage
            ? 'fail-closed-whole-source-line-1:whole'
            : `fail-closed-stacked-source-line:${fragmentParts[0]}`,
        },
        to: {
          regionId: regions[1].id,
          lineId: regions[1].lines[0].id,
          runIndex: 0,
          sourceSequenceIndex: 1,
          sourceRunSha256: sourceRunSha256[1],
          sourceFragmentId: wholeLineage
            ? 'fail-closed-whole-source-line-2:whole'
            : `fail-closed-stacked-source-line:${fragmentParts[1]}`,
        },
        evidence,
      })
      const paper: ResearchPaper = {
        id: 'fail-closed-semantic-flow-paper',
        version: '1.0.0',
        status: 'working',
        title: '',
        subtitle: 'Test',
        authors: [],
        updated: '2026-07-30',
        abstract: 'Test',
        nodes: [
          {
            id: 'fail-closed-semantic-flow-node',
            type: 'paragraph',
            text: canonicalText,
            source: 'test',
          },
        ],
      }
      const provenance: Record<string, NodeSourceEvidence> = {
        'fail-closed-semantic-flow-node': {
          confidence: 1,
          pages: [1],
          regionIds: regions.map((region) => region.id),
          boxes: regions.map((region) => ({ ...region.box })),
          links: [],
        },
      }
      const decisions = mutate([decision as unknown as Record<string, unknown>])
      const bibliographyHeadingRun = run('References', 0.1, 0.1, 16, 0.2)
      const bibliographyHeading: PdfPageRegion = {
        id: 'fail-closed-bibliography-heading',
        page: 1,
        kind: 'body',
        column: 'single',
        text: bibliographyHeadingRun.text,
        confidence: 1,
        box: { ...bibliographyHeadingRun },
        lines: [
          {
            id: 'fail-closed-bibliography-heading-line',
            text: bibliographyHeadingRun.text,
            fontSize: bibliographyHeadingRun.fontSize,
            box: { ...bibliographyHeadingRun },
            runs: [{ ...bibliographyHeadingRun }],
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: false,
      }

      const result = provenanceTextConservation({
        allRegions: bibliographyScope
          ? [bibliographyHeading, ...regions]
          : regions,
        orderedRegions: regions,
        paper,
        provenance,
        lineBoundaryDecisions: [],
        sourceSemanticFlowBoundaryDecisions: decisions,
      } as unknown as Parameters<typeof provenanceTextConservation>[0] & {
        sourceSemanticFlowBoundaryDecisions: Array<Record<string, unknown>>
      })

      expect(result.semanticTextViolationNodeIds).toContain(
        'fail-closed-semantic-flow-node',
      )
    },
  )

  it.each([
    {
      name: 'source-proven hard hyphen',
      outcome: 'hard-hyphen-retain' as const,
      lexiconText: 'A long-form example supplies same-document evidence.',
      expectedViolations: [],
    },
    {
      name: 'unresolved hyphen form',
      outcome: 'unresolved' as const,
      lexiconText: 'No compound evidence is available here.',
      expectedViolations: ['hyphen-flow-node'],
    },
  ])(
    'replays a $name through the semantic-flow lexicon',
    ({ outcome, lexiconText, expectedViolations }) => {
      const sourceRuns = [
        {
          ...run('The source retains long-', 0.1, 0.2, 10, 0.3),
          sourceSequenceIndex: 0,
        },
        {
          ...run('form examples.', 0.1, 0.23, 10, 0.3),
          sourceSequenceIndex: 1,
          sourceWhitespaceBefore: 'pdf-text-item' as const,
          sourceWhitespacePredecessorIndex: 0,
        },
      ]
      const regions = sourceRuns.map((sourceRun, index): PdfPageRegion => ({
        id: `hyphen-flow-region-${index + 1}`,
        page: 1,
        kind: 'body',
        column: 'single',
        text: sourceRun.text,
        confidence: 1,
        box: { ...sourceRun },
        lines: [
          {
            id: `hyphen-flow-line-${index + 1}`,
            text: sourceRun.text,
            fontSize: sourceRun.fontSize,
            box: { ...sourceRun },
            runs: [{ ...sourceRun }],
            sourceFragmentLineage: {
              algorithm: 'source-run-fragment-v1',
              sourceLineId: `hyphen-flow-source-line-${index + 1}`,
              fragment: 'whole',
              sourceSequenceIndexes: [index],
            },
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: true,
      }))
      const lexiconRun = run(lexiconText, 0.1, 0.3, 10, 0.7)
      const lexiconRegion: PdfPageRegion = {
        id: 'hyphen-lexicon-region',
        page: 1,
        kind: 'body',
        column: 'single',
        text: lexiconText,
        confidence: 1,
        box: { ...lexiconRun },
        lines: [
          {
            id: 'hyphen-lexicon-line',
            text: lexiconText,
            fontSize: lexiconRun.fontSize,
            box: { ...lexiconRun },
            runs: [{ ...lexiconRun }],
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: false,
      }
      const sourceRunSha256 = sourceRuns.map((sourceRun) =>
        createHash('sha256')
          .update(
            JSON.stringify([
              sourceRun.page,
              sourceRun.rotation,
              sourceRun.method,
              sourceRun.x,
              sourceRun.y,
              sourceRun.width,
              sourceRun.height,
              sourceRun.text.normalize('NFC'),
              sourceRun.fontName,
              sourceRun.fontSize,
              sourceRun.sourceSequenceIndex ?? null,
              sourceRun.sourceWhitespaceBefore ?? null,
              sourceRun.sourceWhitespacePredecessorIndex ?? null,
            ]),
          )
          .digest('hex'),
      )
      const decision = sourceSemanticFlowDecision({
        page: 1,
        rotation: 0,
        method: 'pdf-text',
        topology: 'lexical-hyphen',
        outcome: outcome as PdfSourceSemanticFlowBoundaryDecision['outcome'],
        from: {
          regionId: regions[0].id,
          lineId: regions[0].lines[0].id,
          runIndex: 0,
          sourceSequenceIndex: 0,
          sourceRunSha256: sourceRunSha256[0],
          sourceFragmentId: 'hyphen-flow-source-line-1:whole',
        },
        to: {
          regionId: regions[1].id,
          lineId: regions[1].lines[0].id,
          runIndex: 0,
          sourceSequenceIndex: 1,
          sourceRunSha256: sourceRunSha256[1],
          sourceFragmentId: 'hyphen-flow-source-line-2:whole',
        },
        evidence: [...PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE],
      })
      const paper: ResearchPaper = {
        id: 'hyphen-flow-paper',
        version: '1.0.0',
        status: 'working',
        title: '',
        subtitle: 'Test',
        authors: [],
        updated: '2026-07-30',
        abstract: 'Test',
        language: 'en-US',
        nodes: [
          {
            id: 'hyphen-flow-node',
            type: 'paragraph',
            text: 'The source retains long-form examples.',
            source: 'test',
          },
        ],
      }
      const provenance: Record<string, NodeSourceEvidence> = {
        'hyphen-flow-node': {
          confidence: 1,
          pages: [1],
          regionIds: regions.map((region) => region.id),
          boxes: regions.map((region) => ({ ...region.box })),
          links: [],
        },
      }

      expect(
        provenanceTextConservation({
          allRegions: [...regions, lexiconRegion],
          orderedRegions: regions,
          paper,
          provenance,
          lineBoundaryDecisions: [],
          sourceSemanticFlowBoundaryDecisions: [decision],
        }).semanticTextViolationNodeIds,
      ).toEqual(expectedViolations)
    },
  )

  it('resolves pinned discretionary hyphen evidence only when every semantic-flow lexical guard holds', () => {
    const pinned = resolvePdfHyphenBoundary({
      left: 'simulta',
      right: 'neous',
      language: 'en',
      sourceProven: true,
      hardHyphenLexicon: new Set(),
      unhyphenatedLexicon: new Set(),
    })

    expect(pinned.verdict).toBe('unresolved')
    expect(sourceSemanticFlowHyphenVerdict(pinned)).toBe('remove')
    expect(
      sourceSemanticFlowHyphenVerdict({
        ...pinned,
        splitPointValid: false,
      }),
    ).toBe('unresolved')
    expect(
      sourceSemanticFlowHyphenVerdict({
        ...pinned,
        hardHyphenFormValid: true,
        evidence: [...pinned.evidence, 'hard-hyphen-form-valid:same-document'],
      }),
    ).toBe('unresolved')

    const hardHyphen = resolvePdfHyphenBoundary({
      left: 'long',
      right: 'form',
      language: 'en',
      sourceProven: true,
      hardHyphenLexicon: new Set(['long-form']),
      unhyphenatedLexicon: new Set(),
    })
    expect(sourceSemanticFlowHyphenVerdict(hardHyphen)).toBe('preserve')
  })

  it('fails closed on a small same-region line reversal above the coverage threshold', () => {
    const sourceRuns = [
      run('a'.repeat(700), 0.1, 0.2, 10, 0.6),
      run('second marker', 0.1, 0.23, 10, 0.3),
      run('third marker', 0.1, 0.26, 10, 0.3),
      run('z'.repeat(700), 0.1, 0.29, 10, 0.6),
    ]
    const region: PdfPageRegion = {
      id: 'shared-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: sourceRuns.map((sourceRun) => sourceRun.text).join(' '),
      confidence: 1,
      box: {
        ...sourceRuns[0],
        height:
          sourceRuns.at(-1)!.y + sourceRuns.at(-1)!.height - sourceRuns[0].y,
      },
      lines: sourceRuns.map((sourceRun, index) => ({
        id: `shared-line-${index + 1}`,
        text: sourceRun.text,
        fontSize: sourceRun.fontSize,
        box: { ...sourceRun },
        runs: [{ ...sourceRun }],
      })),
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }
    const nodeOrder = [0, 2, 1, 3]
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: nodeOrder.map((sourceIndex) => ({
        id: `node-${sourceIndex + 1}`,
        type: 'paragraph' as const,
        text: sourceRuns[sourceIndex].text,
        source: 'test',
      })),
    }
    const provenance: Record<string, NodeSourceEvidence> = Object.fromEntries(
      sourceRuns.map(
        (sourceRun, index) =>
          [
            `node-${index + 1}`,
            {
              confidence: 1,
              pages: [1],
              regionIds: [region.id],
              boxes: [{ ...sourceRun }],
              links: [],
            },
          ] satisfies [string, NodeSourceEvidence],
      ),
    )
    const result = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: sourceRuns.reduce(
            (total, sourceRun) => total + sourceRun.text.length,
            0,
          ),
          imageCount: 0,
          runs: sourceRuns,
        },
      ],
      paper,
      diagnostics: [],
      regions: [region],
      readingOrder: {
        schemaVersion: '1.0.0',
        regionIds: [region.id],
        order: [region.id],
        edges: [],
        resolutions: [],
        acyclic: true,
        evaluation: {
          schemaVersion: '1.0.0',
          algorithm: 'deterministic-geometry-v1',
          mode: 'deterministic-only',
          regionCount: 1,
          acceptedEdgeCount: 0,
          unresolvedEdgeCount: 0,
          cycleRate: 0,
          orderAccuracy: null,
          provider: null,
          modelVersion: null,
          latencyMs: 0,
          costUsd: 0,
          reviewRequired: false,
        },
      },
      provenance,
    })

    expect(result.completeness.textCoverage).toBeGreaterThan(0.98)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
  })

  it('fails closed on a small same-region omission above the coverage threshold', () => {
    const retainedRun = run('a'.repeat(1_000), 0.1, 0.2, 10, 0.6)
    const omittedRun = run('omitted marker', 0.1, 0.23, 10, 0.3)
    const region: PdfPageRegion = {
      id: 'partially-rendered-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: `${retainedRun.text} ${omittedRun.text}`,
      confidence: 1,
      box: {
        ...retainedRun,
        height: omittedRun.y + omittedRun.height - retainedRun.y,
      },
      lines: [retainedRun, omittedRun].map((sourceRun, index) => ({
        id: `partial-line-${index + 1}`,
        text: sourceRun.text,
        fontSize: sourceRun.fontSize,
        box: { ...sourceRun },
        runs: [{ ...sourceRun }],
      })),
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [
        {
          id: 'retained-node',
          type: 'paragraph',
          text: retainedRun.text,
          source: 'test',
        },
      ],
    }
    const result = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: retainedRun.text.length + omittedRun.text.length,
          imageCount: 0,
          runs: [retainedRun, omittedRun],
        },
      ],
      paper,
      diagnostics: [],
      regions: [region],
      readingOrder: {
        schemaVersion: '1.0.0',
        regionIds: [region.id],
        order: [region.id],
        edges: [],
        resolutions: [],
        acyclic: true,
        evaluation: {
          schemaVersion: '1.0.0',
          algorithm: 'deterministic-geometry-v1',
          mode: 'deterministic-only',
          regionCount: 1,
          acceptedEdgeCount: 0,
          unresolvedEdgeCount: 0,
          cycleRate: 0,
          orderAccuracy: null,
          provider: null,
          modelVersion: null,
          latencyMs: 0,
          costUsd: 0,
          reviewRequired: false,
        },
      },
      provenance: {
        'retained-node': {
          confidence: 1,
          pages: [1],
          regionIds: [region.id],
          boxes: [{ ...retainedRun }],
          links: [],
        },
      },
    })

    expect(result.completeness.textCoverage).toBeGreaterThan(0.98)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
  })

  it.each([
    {
      name: 'numeric page range',
      source: ['Conference proceedings, pp. 36–', '49. IEEE Press.'],
      output: 'Conference proceedings, pp. 36–49. IEEE Press.',
    },
    {
      name: 'hyphenated identifier',
      source: ['ISBN 979-8-4007-0103-', '0. ACM Press.'],
      output: 'ISBN 979-8-4007-0103-0. ACM Press.',
    },
    {
      name: 'four-digit year',
      source: ['Example venue, 202', '0. doi: 10.1000/example.'],
      output: 'Example venue, 2020. doi: 10.1000/example.',
    },
  ])(
    'accepts a source-proven numeric fragment join across regions for $name',
    ({ source, output }) => {
      const sourceRuns = source.map((text, index) =>
        run(text, index === 0 ? 0.1 : 0.12, 0.2 + index * 0.05, 10, 0.7),
      )
      const regions = sourceRuns.map(
        (sourceRun, index) =>
          ({
            id: `numeric-fragment-region-${index + 1}`,
            page: 1,
            kind: 'body',
            column: 'single',
            text: sourceRun.text,
            confidence: 1,
            box: { ...sourceRun },
            lines: [
              {
                id: `numeric-fragment-line-${index + 1}`,
                text: sourceRun.text,
                fontSize: sourceRun.fontSize,
                box: { ...sourceRun },
                runs: [{ ...sourceRun }],
              },
            ],
            nativeObjectIds: [],
            includedInReadingOrder: true,
          }) satisfies PdfPageRegion,
      )
      const paper: ResearchPaper = {
        id: 'paper',
        version: '1.0.0',
        status: 'working',
        title: output,
        subtitle: 'Test',
        authors: ['Test'],
        updated: '2026-07-14',
        abstract: 'Test',
        nodes: [
          {
            id: 'numeric-fragment-node',
            type: 'paragraph',
            text: output,
            source: 'test',
          },
        ],
      }
      const result = assessPdfCompleteness({
        pages: [
          {
            page: 1,
            kind: 'born-digital',
            width: 612,
            height: 792,
            rotation: 0,
            textCharacters: source.reduce(
              (total, text) => total + text.length,
              0,
            ),
            imageCount: 0,
            runs: sourceRuns,
          },
        ],
        paper,
        diagnostics: [],
        regions,
        readingOrder: {
          schemaVersion: '1.0.0',
          regionIds: regions.map((region) => region.id),
          order: regions.map((region) => region.id),
          edges: [],
          resolutions: [],
          acyclic: true,
          evaluation: {
            schemaVersion: '1.0.0',
            algorithm: 'deterministic-geometry-v1',
            mode: 'deterministic-only',
            regionCount: regions.length,
            acceptedEdgeCount: 0,
            unresolvedEdgeCount: 0,
            cycleRate: 0,
            orderAccuracy: null,
            provider: null,
            modelVersion: null,
            latencyMs: 0,
            costUsd: 0,
            reviewRequired: false,
          },
        },
        provenance: {
          'numeric-fragment-node': {
            confidence: 1,
            pages: [1],
            regionIds: regions.map((region) => region.id),
            boxes: sourceRuns.map((sourceRun) => ({ ...sourceRun })),
            links: [],
          },
        },
        sourceSemanticFlowBoundaryDecisions: [],
        sourceSemanticFlowBoundaryDecisionCount: 0,
      })

      expect(result.readiness.blockingDiagnosticCodes).not.toContain(
        'CANONICAL_FLOW_ORDER_VIOLATION',
      )
    },
  )

  it.each([
    {
      name: 'scientific operators and signs',
      source: 'The estimate is −0.5 ≤ p < 0.01.',
      output: 'The estimate is 0.5 p 0.01.',
    },
    {
      name: 'word boundaries',
      source: 'The model is robust.',
      output: 'Themodel is robust.',
    },
  ])(
    'fails closed when normalized character coverage hides changed $name',
    ({ source, output }) => {
      const sourceRun = run(source, 0.1, 0.2, 10, 0.7)
      const region: PdfPageRegion = {
        id: 'semantic-text-region',
        page: 1,
        kind: 'body',
        column: 'single',
        text: source,
        confidence: 1,
        box: { ...sourceRun },
        lines: [
          {
            id: 'semantic-text-line',
            text: source,
            fontSize: sourceRun.fontSize,
            box: { ...sourceRun },
            runs: [{ ...sourceRun }],
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: true,
      }
      const result = assessPdfCompleteness({
        pages: [
          {
            page: 1,
            kind: 'born-digital',
            width: 612,
            height: 792,
            rotation: 0,
            textCharacters: source.length,
            imageCount: 0,
            runs: [sourceRun],
          },
        ],
        paper: {
          id: 'paper',
          version: '1.0.0',
          status: 'working',
          title: '',
          subtitle: 'Test',
          authors: [],
          updated: '2026-07-14',
          abstract: 'Test',
          nodes: [
            {
              id: 'semantic-text-node',
              type: 'paragraph',
              text: output,
              source: 'test',
            },
          ],
        },
        diagnostics: [],
        regions: [region],
        readingOrder: {
          schemaVersion: '1.0.0',
          regionIds: [region.id],
          order: [region.id],
          edges: [],
          resolutions: [],
          acyclic: true,
          evaluation: {
            schemaVersion: '1.0.0',
            algorithm: 'deterministic-geometry-v1',
            mode: 'deterministic-only',
            regionCount: 1,
            acceptedEdgeCount: 0,
            unresolvedEdgeCount: 0,
            cycleRate: 0,
            orderAccuracy: null,
            provider: null,
            modelVersion: null,
            latencyMs: 0,
            costUsd: 0,
            reviewRequired: false,
          },
        },
        provenance: {
          'semantic-text-node': {
            confidence: 1,
            pages: [1],
            regionIds: [region.id],
            boxes: [{ ...sourceRun }],
            links: [],
          },
        },
      })

      expect(result.completeness.textCoverage).toBe(1)
      expect(result.readiness.blockingDiagnosticCodes).toContain(
        'CANONICAL_FLOW_ORDER_VIOLATION',
      )
    },
  )

  it('allows complete ordered canonical fragments from one styled source line', () => {
    const headingRun = run('Background', 0.1, 0.2, 12, 0.16)
    const paragraphRun = run('This is the complete prose.', 0.27, 0.2, 10, 0.43)
    const region: PdfPageRegion = {
      id: 'styled-line-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: `${headingRun.text} ${paragraphRun.text}`,
      confidence: 1,
      box: {
        ...headingRun,
        width: paragraphRun.x + paragraphRun.width - headingRun.x,
      },
      lines: [
        {
          id: 'styled-line',
          text: `${headingRun.text} ${paragraphRun.text}`,
          fontSize: headingRun.fontSize,
          box: {
            ...headingRun,
            width: paragraphRun.x + paragraphRun.width - headingRun.x,
          },
          runs: [{ ...headingRun }, { ...paragraphRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [
        {
          id: 'background-heading',
          type: 'heading',
          level: 2,
          text: headingRun.text,
          source: 'test',
        },
        {
          id: 'background-paragraph',
          type: 'paragraph',
          text: paragraphRun.text,
          source: 'test',
        },
      ],
    }
    const provenance: Record<string, NodeSourceEvidence> = {
      'background-heading': {
        confidence: 1,
        pages: [1],
        regionIds: [region.id],
        boxes: [{ ...headingRun }],
        links: [],
      },
      'background-paragraph': {
        confidence: 1,
        pages: [1],
        regionIds: [region.id],
        boxes: [{ ...paragraphRun }],
        links: [],
      },
    }
    const result = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: headingRun.text.length + paragraphRun.text.length,
          imageCount: 0,
          runs: [headingRun, paragraphRun],
        },
      ],
      paper,
      diagnostics: [],
      regions: [region],
      readingOrder: {
        schemaVersion: '1.0.0',
        regionIds: [region.id],
        order: [region.id],
        edges: [],
        resolutions: [],
        acyclic: true,
        evaluation: {
          schemaVersion: '1.0.0',
          algorithm: 'deterministic-geometry-v1',
          mode: 'deterministic-only',
          regionCount: 1,
          acceptedEdgeCount: 0,
          unresolvedEdgeCount: 0,
          cycleRate: 0,
          orderAccuracy: null,
          provider: null,
          modelVersion: null,
          latencyMs: 0,
          costUsd: 0,
          reviewRequired: false,
        },
      },
      provenance,
    })

    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
  })

  it('does not treat floating visual provenance as canonical prose flow', () => {
    const firstRun = run('First source paragraph.', 0.1, 0.2, 10, 0.6)
    const secondRun = run('Second source paragraph.', 0.1, 0.3, 10, 0.6)
    const visualRun = run('Figure artwork.', 0.1, 0.7, 10, 0.6)
    const sourceRegion = (
      id: string,
      sourceRun: PdfSourceRun,
      kind: PdfPageRegion['kind'],
    ): PdfPageRegion => ({
      id,
      page: 1,
      kind,
      column: 'single',
      text: sourceRun.text,
      confidence: 1,
      box: { ...sourceRun },
      lines: [
        {
          id: `${id}-line`,
          text: sourceRun.text,
          fontSize: sourceRun.fontSize,
          box: { ...sourceRun },
          runs: [{ ...sourceRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const firstRegion = sourceRegion('first-region', firstRun, 'body')
    const secondRegion = sourceRegion('second-region', secondRun, 'body')
    const visualRegion = sourceRegion('visual-region', visualRun, 'figure')
    const paper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [
        {
          id: 'first-node',
          type: 'paragraph',
          text: firstRun.text,
          source: 'test',
        },
        {
          id: 'figure-1',
          type: 'figure',
          objectType: 'figure',
          title: 'Figure 1',
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
        {
          id: 'second-node',
          type: 'paragraph',
          text: secondRun.text,
          source: 'test',
        },
        {
          id: 'caption-1',
          type: 'caption',
          text: 'Figure 1. Synthetic visual.',
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const provenance: Record<string, NodeSourceEvidence> = {
      'first-node': {
        confidence: 1,
        pages: [1],
        regionIds: [firstRegion.id],
        boxes: [{ ...firstRegion.box }],
        links: [],
      },
      'second-node': {
        confidence: 1,
        pages: [1],
        regionIds: [secondRegion.id],
        boxes: [{ ...secondRegion.box }],
        links: [],
      },
      'figure-1': {
        confidence: 1,
        pages: [1],
        regionIds: [visualRegion.id],
        boxes: [{ ...visualRegion.box }],
        links: [],
      },
    }
    const readingOrder: PdfReadingOrderGraph = {
      schemaVersion: '1.0.0',
      regionIds: [firstRegion.id, secondRegion.id, visualRegion.id],
      order: [firstRegion.id, secondRegion.id, visualRegion.id],
      edges: [],
      resolutions: [],
      acyclic: true,
      evaluation: {
        schemaVersion: '1.0.0',
        algorithm: 'deterministic-geometry-v1',
        mode: 'deterministic-only',
        regionCount: 3,
        acceptedEdgeCount: 0,
        unresolvedEdgeCount: 0,
        cycleRate: 0,
        orderAccuracy: null,
        provider: null,
        modelVersion: null,
        latencyMs: 0,
        costUsd: 0,
        reviewRequired: false,
      },
    }

    const result = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters:
            firstRun.text.length +
            secondRun.text.length +
            visualRun.text.length,
          imageCount: 1,
          runs: [firstRun, secondRun, visualRun],
        },
      ],
      paper,
      diagnostics: [],
      regions: [firstRegion, secondRegion, visualRegion],
      readingOrder,
      provenance,
    })

    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
  })

  it('fails closed when provenance omits an extra rendered canonical node', () => {
    const sourceRun = run('Source-backed canonical prose.', 0.1, 0.2, 10, 0.5)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceRun.text.length,
      imageCount: 0,
      runs: [sourceRun],
    }
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [
        {
          id: 'paragraph-1',
          type: 'paragraph',
          text: sourceRun.text,
          source: 'test',
        },
        {
          id: 'invented-extra',
          type: 'paragraph',
          text: 'Invented rendered prose.',
          source: 'test',
        },
      ],
    }
    const { region, readingOrder, evidence } = singleRegionEvidence(sourceRun)

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: [region],
      readingOrder,
      provenance: { 'paragraph-1': evidence },
    })

    expect(result.completeness.outputTextCharacters).toBeGreaterThan(
      result.completeness.sourceTextCharacters,
    )
    expect(result.completeness.textCoverage).toBeLessThan(1)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'INCOMPLETE_TEXT_COVERAGE',
    )
  })

  it('fails closed when separately provenanced nodes duplicate a partial source overlap', () => {
    const sourceRun = run('Alpha beta gamma delta.', 0.1, 0.2, 10, 0.5)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceRun.text.length,
      imageCount: 0,
      runs: [sourceRun],
    }
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [
        {
          id: 'first-overlap',
          type: 'paragraph',
          text: 'Alpha beta gamma',
          source: 'test',
        },
        {
          id: 'second-overlap',
          type: 'paragraph',
          text: 'beta gamma delta.',
          source: 'test',
        },
      ],
    }
    const { region, readingOrder, evidence } = singleRegionEvidence(sourceRun)

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: [region],
      readingOrder,
      provenance: {
        'first-overlap': evidence,
        'second-overlap': evidence,
      },
    })

    expect(result.completeness.matchedTextCharacters).toBe(
      result.completeness.sourceTextCharacters,
    )
    expect(result.completeness.outputTextCharacters).toBeGreaterThan(
      result.completeness.sourceTextCharacters,
    )
    expect(result.completeness.textCoverage).toBeLessThan(1)
    expect(result.readiness.ready).toBe(false)
  })
})
