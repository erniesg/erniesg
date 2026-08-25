import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createSourceGeometryScriptTranscript,
  SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
} from './equation-geometry-transcript'
import type {
  NodeSourceEvidence,
  PdfCanonicalHyphenBoundaryDecision,
  PdfLineBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderGraph,
  PdfSourceSemanticFlowBoundaryDecision,
  PdfSourceRun,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import type { ResearchPaper } from './schema'
import {
  assessPdfCompleteness,
  classifyStructuralLineBoundaryDecisions,
  detectPdfSemanticSignals,
  hasValidCanonicalHyphenBoundaryLedger,
  hasValidSourceSemanticFlowBoundaryLedgerCount,
  provenanceTextConservation,
  sourceSemanticFlowHyphenVerdict,
} from './pdf-quality'
import {
  PDF_HYPHEN_LEXICAL_MODEL,
  resolvePdfHyphenBoundary,
} from './pdf-hyphenation'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import {
  canonicalTableFromLines,
  createSourcePageCropAsset,
} from './visual-assets'
import {
  PDF_SOURCE_SEMANTIC_FLOW_BASE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_COLUMN_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_CROSS_PAGE_EVIDENCE,
  PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE,
  pdfSourceSemanticFlowBoundaryDecisionId,
  pdfSourceSemanticFlowRunSha256,
} from './pdf-regions'
import { mergeProseContinuations } from './pdf-layout'
import {
  assessSourceBackedEquation,
  equationAssetWithPayload,
  normalizedLength,
  run,
  sourceBackedEquationFixture,
} from './pdf-quality.test-helpers'

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

function strictTableBoundaryFixture() {
  const captionRun = run('Table 1. Source-backed values.', 0.2, 0.18, 10, 0.4)
  const headerLabelRun = run('Header', 0.2, 0.3, 10, 0.18)
  const headerValueRun = run('Value', 0.45, 0.3, 10, 0.12)
  const bodyLabelRun = run('inter-national', 0.2, 0.325, 10, 0.18)
  const bodyValueRun = run('1', 0.45, 0.325, 10, 0.04)
  const captionRegion = {
    id: 'table-caption-region',
    page: 1,
    kind: 'caption',
    column: 'single',
    text: captionRun.text,
    confidence: 1,
    box: { ...captionRun },
    lines: [
      {
        id: 'table-caption-line',
        text: captionRun.text,
        fontSize: captionRun.fontSize,
        box: { ...captionRun },
        runs: [{ ...captionRun }],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const tableBox = {
    page: 1,
    x: 0.18,
    y: 0.27,
    width: 0.5,
    height: 0.12,
    rotation: 0,
    method: 'pdf-object' as const,
  }
  const tableRegion = {
    id: 'table-source-region',
    page: 1,
    kind: 'body',
    column: 'single',
    text: 'Header Value inter-national 1',
    confidence: 1,
    box: {
      page: 1,
      x: 0.2,
      y: 0.3,
      width: 0.14,
      height: 0.043,
      rotation: 0,
      method: 'pdf-text' as const,
    },
    lines: [
      {
        id: 'table-line-1',
        text: `${headerLabelRun.text} ${headerValueRun.text}`,
        fontSize: headerLabelRun.fontSize,
        box: {
          ...headerLabelRun,
          width: headerValueRun.x + headerValueRun.width - headerLabelRun.x,
        },
        runs: [{ ...headerLabelRun }, { ...headerValueRun }],
      },
      {
        id: 'table-line-2',
        text: `${bodyLabelRun.text} ${bodyValueRun.text}`,
        fontSize: bodyLabelRun.fontSize,
        box: {
          ...bodyLabelRun,
          width: bodyValueRun.x + bodyValueRun.width - bodyLabelRun.x,
        },
        runs: [{ ...bodyLabelRun }, { ...bodyValueRun }],
      },
    ],
    nativeObjectIds: ['table-object'],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const table = canonicalTableFromLines(tableRegion.lines, {
    sourceHeaderLineIds: ['table-line-1'],
    sourceRegions: [tableRegion],
  })
  if (!table) throw new Error('expected source-verifiable table fixture')
  const bytes = new TextEncoder().encode(
    '<table><tr><th>Header</th><th>Value</th></tr><tr><td>international</td><td>1</td></tr></table>',
  )
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const asset = {
    id: `asset-${sha256.slice(0, 24)}`,
    href: `assets/asset-${sha256.slice(0, 24)}.xhtml`,
    mediaType: 'application/xhtml+xml',
    kind: 'table',
    rendition: 'semantic-table',
    sha256,
    bytes,
    width: 1,
    height: 1,
    resolutionDpi: null,
    sourceObjectIds: ['table-object'],
    sourceBoxes: [{ ...tableBox }],
  } satisfies PdfVisualAsset
  const relationship = {
    id: 'table-relationship',
    kind: 'table',
    label: 'Table 1',
    captionRegionId: captionRegion.id,
    sourceRegionIds: [tableRegion.id],
    sourceLineIds: tableRegion.lines.map((line) => line.id),
    sourceObjectIds: ['table-object'],
    assetIds: [asset.id],
    status: 'matched',
    confidence: 1,
    evidence: ['semantic-table'],
    candidates: [],
    sourceBoxes: [{ ...captionRegion.box }, { ...tableBox }],
    sourceText: tableRegion.text,
    altText: captionRegion.text,
    altTextSource: 'caption',
    canonicalNodeId: 'table-1',
    captionNodeId: 'table-caption-1',
  } satisfies PdfVisualRelationship
  const paper = {
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
        id: 'table-1',
        type: 'figure',
        objectType: 'table',
        title: 'Table 1',
        sourceText: tableRegion.text,
        table,
        relationships: {
          caption: 'table-caption-1',
          assets: [asset.id],
        },
        source: 'test',
      },
      {
        id: 'table-caption-1',
        type: 'caption',
        text: captionRegion.text,
        source: 'test',
      },
    ],
  } satisfies ResearchPaper
  const provenance = {
    'table-1': {
      confidence: 1,
      pages: [1],
      regionIds: [tableRegion.id],
      boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
      links: [],
    },
    'table-caption-1': {
      confidence: 1,
      pages: [1],
      regionIds: [captionRegion.id],
      boxes: [{ ...captionRegion.box }],
      links: [],
    },
  } satisfies Record<string, NodeSourceEvidence>
  const decision = {
    id: 'table-boundary',
    page: 1,
    regionId: tableRegion.id,
    fromLineId: tableRegion.lines[0].id,
    toLineId: tableRegion.lines[1].id,
    outcome: 'unresolved',
    evidence: ['insufficient-hyphen-evidence', 'source-form-preserved'],
  } satisfies PdfLineBoundaryDecision
  const page = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters:
      captionRun.text.length +
      headerLabelRun.text.length +
      headerValueRun.text.length +
      bodyLabelRun.text.length +
      bodyValueRun.text.length,
    imageCount: 0,
    objects: [],
    runs: [
      captionRun,
      headerLabelRun,
      headerValueRun,
      bodyLabelRun,
      bodyValueRun,
    ],
  } satisfies PdfPageAnalysis
  const readingOrder = {
    schemaVersion: '1.0.0',
    regionIds: [captionRegion.id, tableRegion.id],
    order: [captionRegion.id, tableRegion.id],
    edges: [],
    resolutions: [],
    acyclic: true,
    evaluation: {
      schemaVersion: '1.0.0',
      algorithm: 'deterministic-geometry-v1',
      mode: 'deterministic-only',
      regionCount: 2,
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
  return {
    paper,
    provenance,
    relationship,
    asset,
    decision,
    page,
    regions: [captionRegion, tableRegion],
    readingOrder,
  }
}

describe('PDF semantic signal detection', () => {
  it('validates exact and derived canonical deletion proof fail-closed with normalized production lexicon parity', () => {
    const box = (page: number, y: number) => ({
      page,
      x: 0.1,
      y,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text' as const,
    })
    const region = (id: string, text: string, page: number, y: number) =>
      ({
        id,
        page,
        kind: 'body',
        column: 'single',
        text,
        confidence: 1,
        box: box(page, y),
        lines: [
          {
            id: `${id}-line`,
            text,
            fontSize: 10,
            box: box(page, y),
            runs: [],
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: false,
      }) satisfies PdfPageRegion
    const from = region('representation-from', 'Repre-', 1, 0.8)
    const to = region('representation-to', 'sentation continues.', 2, 0.1)
    const proof = region(
      'representation-proof',
      'Representation is present in source.',
      2,
      0.2,
    )
    const decision = {
      id: `canonical-hyphen-boundary:canonical-flow-continuation:${from.id}:${from.lines[0].id}->${to.id}:${to.lines[0].id}`,
      context: 'canonical-flow-continuation',
      outcome: 'removed-discretionary-hyphen',
      fromRegionId: from.id,
      fromLineId: from.lines[0].id,
      toRegionId: to.id,
      toLineId: to.lines[0].id,
      geometry: {
        from: { ...from.lines[0].box },
        to: { ...to.lines[0].box },
      },
      proof: {
        tier: 'exact-same-document',
        sourceBoundaryProven: true,
        pinnedWord: 'representation',
        pinnedJoinedFormValid: true,
        pinnedSplit: { left: 'repre', right: 'sentation', index: 5 },
        splitPointValid: true,
        exactSameDocumentJoinedForm: 'Representation',
        sameDocumentJoinedFormValid: true,
        hardHyphenForm: 'repre-sentation',
        hardHyphenCounterproof: null,
        model: { ...PDF_HYPHEN_LEXICAL_MODEL },
        evidence: [
          'source-proven-wrapped-line-boundary',
          'lexical-model:scowl-2020.12.07+ushyphmax-2005-05-30',
          'joined-form-valid:pinned-lexicon',
          'split-point-valid:pinned-hyphenation-pattern',
          'same-document-unhyphenated-word',
          'hard-hyphen-form-not-proved',
          'language-scope:en-US->en-US',
        ],
      },
    } satisfies PdfCanonicalHyphenBoundaryDecision
    const input = {
      decisions: [decision],
      expectedCount: 1,
      regions: [from, to, proof],
    }

    expect(hasValidCanonicalHyphenBoundaryLedger(input)).toBe(true)
    const unchecked = structuredClone(input) as {
      decisions: unknown
      expectedCount: unknown
      regions: PdfPageRegion[]
    }
    ;(
      unchecked.decisions as Array<{
        proof: { pinnedWord: unknown }
      }>
    )[0].proof.pinnedWord = { normalize: 'not-callable' }
    expect(() => hasValidCanonicalHyphenBoundaryLedger(unchecked)).not.toThrow()
    expect(hasValidCanonicalHyphenBoundaryLedger(unchecked)).toBe(false)

    const wrongModel = structuredClone(input) as {
      decisions: Array<{ proof: { model: { id: string } } }>
      expectedCount: unknown
      regions: PdfPageRegion[]
    }
    wrongModel.decisions[0].proof.model.id = 'fake-compatible-shape'
    expect(hasValidCanonicalHyphenBoundaryLedger(wrongModel)).toBe(false)

    const missingMandatoryEvidence = structuredClone(input)
    missingMandatoryEvidence.decisions[0].proof.evidence =
      missingMandatoryEvidence.decisions[0].proof.evidence.filter(
        (evidence) => evidence !== 'joined-form-valid:pinned-lexicon',
      )
    expect(
      hasValidCanonicalHyphenBoundaryLedger(missingMandatoryEvidence),
    ).toBe(false)

    const forbiddenCounterproof = structuredClone(input)
    forbiddenCounterproof.decisions[0].proof.evidence.push(
      'hard-hyphen-form-valid:same-document',
    )
    expect(hasValidCanonicalHyphenBoundaryLedger(forbiddenCounterproof)).toBe(
      false,
    )

    const collision = region(
      'representation-hard-hyphen',
      'REPRE-sentation is also present.',
      2,
      0.3,
    )
    expect(
      hasValidCanonicalHyphenBoundaryLedger({
        ...input,
        regions: [...input.regions, collision],
      }),
    ).toBe(false)

    const derivedFrom = region('reparameterized-from', 'Reparameter-', 1, 0.7)
    const derivedTo = region(
      'reparameterized-to',
      'ized models continue.',
      2,
      0.1,
    )
    const derivedBase = region(
      'reparameterized-base',
      'Parameterized models are present in source.',
      2,
      0.2,
    )
    const derivedDecision = {
      id: `canonical-hyphen-boundary:canonical-flow-continuation:${derivedFrom.id}:${derivedFrom.lines[0].id}->${derivedTo.id}:${derivedTo.lines[0].id}`,
      context: 'canonical-flow-continuation',
      outcome: 'removed-discretionary-hyphen',
      fromRegionId: derivedFrom.id,
      fromLineId: derivedFrom.lines[0].id,
      toRegionId: derivedTo.id,
      toLineId: derivedTo.lines[0].id,
      geometry: {
        from: { ...derivedFrom.lines[0].box },
        to: { ...derivedTo.lines[0].box },
      },
      proof: {
        tier: 'same-document-derived-affix',
        sourceBoundaryProven: true,
        derivedWord: 'reparameterized',
        productivePrefix: {
          kind: 'prefix',
          value: 're',
          affixClass: 'PFX',
          flag: 'A',
          crossProduct: true,
          affixSha256: PDF_HYPHEN_LEXICAL_MODEL.affixSha256,
        },
        baseWord: 'parameterized',
        pinnedBaseWordValid: true,
        pinnedSplit: { left: 'reparameter', right: 'ized', index: 11 },
        splitPointValid: true,
        exactSameDocumentBaseWord: 'Parameterized',
        sameDocumentBaseWordValid: true,
        hardHyphenForm: 'reparameter-ized',
        hardHyphenCounterproof: null,
        model: { ...PDF_HYPHEN_LEXICAL_MODEL },
        evidence: [
          'source-proven-wrapped-line-boundary',
          'lexical-model:scowl-2020.12.07+ushyphmax-2005-05-30',
          'joined-form-valid:same-document-derived-affix',
          'split-point-valid:pinned-hyphenation-pattern',
          'productive-prefix-valid:pinned-affix-model',
          'base-form-valid:pinned-lexicon',
          'same-document-unhyphenated-base-word',
          'hard-hyphen-form-not-proved',
          'language-scope:en-US->en-US',
        ],
      },
    } satisfies PdfCanonicalHyphenBoundaryDecision
    const derivedInput = {
      decisions: [derivedDecision],
      expectedCount: 1,
      regions: [derivedFrom, derivedTo, derivedBase],
    }

    expect(hasValidCanonicalHyphenBoundaryLedger(derivedInput)).toBe(true)
    for (const mutate of [
      (candidate: typeof derivedDecision) => {
        candidate.proof.productivePrefix.flag = 'Z' as 'A'
      },
      (candidate: typeof derivedDecision) => {
        candidate.proof.exactSameDocumentBaseWord = 'parameters'
      },
      (candidate: typeof derivedDecision) => {
        candidate.proof.evidence = candidate.proof.evidence.filter(
          (entry) => entry !== 'base-form-valid:pinned-lexicon',
        )
      },
    ]) {
      const tampered = structuredClone(derivedDecision)
      mutate(tampered)
      expect(
        hasValidCanonicalHyphenBoundaryLedger({
          ...derivedInput,
          decisions: [tampered],
        }),
      ).toBe(false)
    }
  })

  it('distinguishes an explicitly empty canonical deletion ledger from missing current fields', () => {
    const sourceRun = run('Complete source text.', 0.1, 0.2)
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
    const sourcePaper: ResearchPaper = {
      id: 'canonical-ledger-presence',
      version: '1.0.0',
      status: 'working',
      title: 'Complete source text.',
      subtitle: '',
      authors: [],
      updated: '2026-07-28',
      abstract: '',
      nodes: [],
    }
    const missing = assessPdfCompleteness({
      pages: [page],
      paper: sourcePaper,
      diagnostics: [],
    })
    const empty = assessPdfCompleteness({
      pages: [page],
      paper: sourcePaper,
      diagnostics: [],
      canonicalHyphenBoundaryDecisions: [],
      canonicalHyphenBoundaryDecisionCount: 0,
    })

    expect(missing.readiness.blockingDiagnosticCodes).toContain(
      'INVALID_CANONICAL_HYPHEN_BOUNDARY_LEDGER',
    )
    expect(empty.readiness.blockingDiagnosticCodes).not.toContain(
      'INVALID_CANONICAL_HYPHEN_BOUNDARY_LEDGER',
    )
  })

  it('accepts only a complete semantic-flow ledger count contract', () => {
    expect(
      hasValidSourceSemanticFlowBoundaryLedgerCount({
        decisions: undefined,
        expectedCount: undefined,
      }),
    ).toBe(false)
    expect(
      hasValidSourceSemanticFlowBoundaryLedgerCount({
        decisions: [],
        expectedCount: 0,
      }),
    ).toBe(true)
    expect(
      hasValidSourceSemanticFlowBoundaryLedgerCount({
        decisions: [],
        expectedCount: undefined,
      }),
    ).toBe(false)
    expect(
      hasValidSourceSemanticFlowBoundaryLedgerCount({
        decisions: undefined,
        expectedCount: 0,
      }),
    ).toBe(false)
    expect(
      hasValidSourceSemanticFlowBoundaryLedgerCount({
        decisions: [],
        expectedCount: 1,
      }),
    ).toBe(false)
    expect(
      hasValidSourceSemanticFlowBoundaryLedgerCount({
        decisions: [null],
        expectedCount: 1,
      }),
    ).toBe(false)
  })

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

  it('aggregates canonical-flow ambiguity into reading-order review truth', () => {
    const sourceRun = run('A source-backed paragraph.', 0.1, 0.2)
    const { region, readingOrder, evidence } = singleRegionEvidence(sourceRun)
    const paper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-23',
      abstract: 'Test',
      nodes: [
        {
          id: 'paragraph-1',
          type: 'paragraph',
          text: sourceRun.text,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const assessed = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: sourceRun.text.length,
          imageCount: 0,
          runs: [sourceRun],
        },
      ],
      paper,
      diagnostics: [
        {
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'warning',
          page: 1,
          message:
            'A canonical visual has exact references in multiple heading scopes.',
        },
      ],
      readingOrder,
      regions: [region],
      provenance: { 'paragraph-1': evidence },
    })

    expect(assessed.completeness.readingOrderDiagnostics).toBe(1)
    expect(assessed.completeness.readingOrderEvaluation).toMatchObject({
      regionCount: 1,
      unresolvedEdgeCount: 0,
      reviewRequired: true,
    })
    expect(assessed.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
  })

  it('fails a configured hyperlink obligation ledger closed', () => {
    const sourceRun = run('A source-backed link owner.', 0.1, 0.2)
    const { region, readingOrder, evidence } = singleRegionEvidence(sourceRun)
    const paper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-23',
      abstract: 'Test',
      nodes: [
        {
          id: 'paragraph-1',
          type: 'paragraph',
          text: sourceRun.text,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const assessed = assessPdfCompleteness({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: sourceRun.text.length,
          imageCount: 0,
          runs: [sourceRun],
        },
      ],
      paper,
      diagnostics: [],
      readingOrder,
      regions: [region],
      provenance: { 'paragraph-1': evidence },
      hyperlinkLedger: { expected: 1, mapped: 0 },
    })

    expect(assessed.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 0,
      hyperlinkCoverage: 0,
    })
    expect(assessed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_HYPERLINK',
          severity: 'error',
        }),
      ]),
    )
    expect(assessed.readiness.ready).toBe(false)
  })

  it('classifies an unresolved strict table-only transition as structural', () => {
    const fixture = strictTableBoundaryFixture()
    expect(
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [fixture.relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
      }),
    ).toEqual([fixture.relationship])

    const classified = classifyStructuralLineBoundaryDecisions({
      decisions: [fixture.decision],
      paper: fixture.paper,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
      regions: fixture.regions,
    })
    expect(classified).toMatchObject({
      unresolvedCorruptingJoinCount: 0,
      structurallyConsumedLineBoundaryCount: 1,
      decisions: [
        {
          outcome: 'structural-boundary',
          evidence: [
            'insufficient-hyphen-evidence',
            'source-form-preserved',
            'strict-visual-only-region',
          ],
        },
      ],
    })

    const assessed = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
      lineBoundaryDecisions: [fixture.decision],
    })
    expect(assessed.completeness).toMatchObject({
      lineBoundaryCount: 1,
      decidedLineBoundaryCount: 1,
      unresolvedCorruptingJoinCount: 0,
      structurallyConsumedLineBoundaryCount: 1,
    })
    expect(assessed.readiness.blockingDiagnosticCodes).not.toContain(
      'UNRESOLVED_CORRUPTING_JOIN',
    )
  })

  it('resolves an exact bounded table crop while reporting that no semantic grid exists', async () => {
    const fixture = strictTableBoundaryFixture()
    const width = 12
    const height = 8
    const pixels = new Uint8Array(width * height * 4).fill(255)
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 10; x += 1) {
        const offset = (y * width + x) * 4
        pixels.set([0, 0, 0, 255], offset)
      }
    }
    const crop = await createSourcePageCropAsset({
      kind: 'table',
      cropBox: fixture.asset.sourceBoxes[0],
      sourceObjectIds: fixture.asset.sourceObjectIds,
      sourceBoxes: fixture.asset.sourceBoxes,
      width,
      height,
      pixels,
    })
    const relationship = {
      ...fixture.relationship,
      assetIds: [crop.id],
      sourceLineIds: fixture.regions[1].lines.map((line) => line.id),
      evidence: [
        'bounded-table-scope',
        'non-semantic-source-scope',
        'source-page-crop',
      ],
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      nodes: fixture.paper.nodes.map((node) =>
        node.type === 'figure'
          ? {
              ...node,
              table: undefined,
              sourceText: fixture.relationship.sourceText,
              relationships: { ...node.relationships, assets: [crop.id] },
            }
          : node,
      ),
    } satisfies ResearchPaper

    expect(
      validatedPdfVisualRelationships({
        paper,
        provenance: fixture.provenance,
        relationships: [relationship],
        assets: [crop],
      }),
    ).toEqual([relationship])
    expect(
      validatedPdfVisualRelationships({
        paper,
        provenance: fixture.provenance,
        relationships: [{ ...relationship, sourceLineIds: [] }],
        assets: [crop],
      }),
    ).toEqual([])
    expect(
      validatedPdfVisualRelationships({
        paper,
        provenance: fixture.provenance,
        relationships: [
          {
            ...relationship,
            evidence: relationship.evidence.filter(
              (item) => item !== 'source-page-crop',
            ),
          },
        ],
        assets: [crop],
      }),
    ).toEqual([])
    expect(
      validatedPdfVisualRelationships({
        paper: {
          ...paper,
          nodes: paper.nodes.map((node) =>
            node.type === 'figure'
              ? { ...node, sourceText: `${node.sourceText} missing` }
              : node,
          ),
        },
        provenance: fixture.provenance,
        relationships: [relationship],
        assets: [crop],
      }),
    ).toEqual([])

    const clippedCrop = await createSourcePageCropAsset({
      kind: 'table',
      cropBox: {
        ...fixture.asset.sourceBoxes[0],
        width: fixture.asset.sourceBoxes[0].width / 2,
        height: fixture.asset.sourceBoxes[0].height / 2,
      },
      sourceObjectIds: fixture.asset.sourceObjectIds,
      sourceBoxes: fixture.asset.sourceBoxes,
      width,
      height,
      pixels,
    })
    expect(
      validatedPdfVisualRelationships({
        paper: {
          ...paper,
          nodes: paper.nodes.map((node) =>
            node.type === 'figure'
              ? {
                  ...node,
                  relationships: {
                    ...node.relationships,
                    assets: [clippedCrop.id],
                  },
                }
              : node,
          ),
        },
        provenance: fixture.provenance,
        relationships: [{ ...relationship, assetIds: [clippedCrop.id] }],
        assets: [clippedCrop],
      }),
    ).toEqual([])

    const assessed = assessPdfCompleteness({
      pages: [fixture.page],
      paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [relationship],
      assets: [crop],
      lineBoundaryDecisions: [fixture.decision],
    })

    expect(assessed.completeness.assetCoverage).toBe(1)
    expect(assessed.completeness.relationshipCoverage).toBe(1)
    expect(assessed.completeness.unresolvedObjects.tables).toBe(0)
    expect(assessed.completeness).toMatchObject({
      expectedSemanticTableCount: 1,
      resolvedSemanticTableCount: 0,
      semanticTableCoverage: 0,
    })
    expect(assessed.readiness.blockingDiagnosticCodes).not.toContain(
      'UNRESOLVED_SEMANTIC_OBJECTS',
    )
    expect(assessed.readiness.blockingDiagnosticCodes).toContain(
      'INCOMPLETE_SEMANTIC_TABLE_COVERAGE',
    )
  })

  it('does not resolve empty, one-cell, or headerless semantic-table claims', () => {
    const fixture = strictTableBoundaryFixture()
    const cell = (text: string, headerScope: 'column' | null) => ({
      text,
      headerScope,
      columnSpan: 1,
      rowSpan: 1,
    })
    const invalidTables: Array<
      NonNullable<
        Extract<ResearchPaper['nodes'][number], { type: 'figure' }>['table']
      >
    > = [
      { rows: [] },
      { rows: [{ cells: [cell('Only', 'column')] }] },
      {
        rows: [
          { cells: [cell('A', null), cell('B', null)] },
          { cells: [cell('1', null), cell('2', null)] },
        ],
      },
    ]

    for (const table of invalidTables) {
      const paper: ResearchPaper = structuredClone(fixture.paper)
      const node = paper.nodes.find((candidate) => candidate.type === 'figure')
      if (!node || node.type !== 'figure') throw new Error('missing table node')
      node.table = table
      const assessed = assessPdfCompleteness({
        pages: [fixture.page],
        paper,
        diagnostics: [],
        regions: fixture.regions,
        readingOrder: fixture.readingOrder,
        provenance: fixture.provenance,
        visualRelationships: [fixture.relationship],
        assets: [fixture.asset],
        lineBoundaryDecisions: [fixture.decision],
      })

      expect(assessed.completeness.relationshipCoverage).toBe(0)
      expect(assessed.completeness.unresolvedObjects.tables).toBe(1)
      expect(assessed.readiness.blockingDiagnosticCodes).toContain(
        'UNRESOLVED_SEMANTIC_OBJECTS',
      )
    }
  })

  it('keeps an unresolved rejected table transition corrupting', () => {
    const fixture = strictTableBoundaryFixture()
    const rejected = {
      ...fixture.relationship,
      status: 'unresolved',
    } satisfies PdfVisualRelationship

    const classified = classifyStructuralLineBoundaryDecisions({
      decisions: [fixture.decision],
      paper: fixture.paper,
      provenance: fixture.provenance,
      visualRelationships: [rejected],
      assets: [fixture.asset],
    })

    expect(classified).toMatchObject({
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 0,
      decisions: [{ outcome: 'unresolved' }],
    })
  })

  it('keeps an ambiguous rejected table transition explicit and corrupting', () => {
    const fixture = strictTableBoundaryFixture()
    const rejected = {
      ...fixture.relationship,
      status: 'unresolved',
    } satisfies PdfVisualRelationship
    const ambiguousDecision = {
      ...fixture.decision,
      outcome: 'ambiguous',
      evidence: [
        'ambiguous-joined-and-hard-hyphen-forms',
        'source-form-preserved',
      ],
    } satisfies PdfLineBoundaryDecision

    const classified = classifyStructuralLineBoundaryDecisions({
      decisions: [ambiguousDecision],
      paper: fixture.paper,
      provenance: fixture.provenance,
      visualRelationships: [rejected],
      assets: [fixture.asset],
    })

    expect(classified).toMatchObject({
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 0,
      decisions: [
        {
          outcome: 'ambiguous',
          evidence: [
            'ambiguous-joined-and-hard-hyphen-forms',
            'source-form-preserved',
          ],
        },
      ],
    })
  })

  it('reverts a stale structural boundary when strict ownership no longer holds', () => {
    const fixture = strictTableBoundaryFixture()
    const rejected = {
      ...fixture.relationship,
      status: 'unresolved',
    } satisfies PdfVisualRelationship
    const staleDecision = {
      ...fixture.decision,
      outcome: 'structural-boundary',
      evidence: [...fixture.decision.evidence, 'strict-visual-only-region'],
    } satisfies PdfLineBoundaryDecision

    const classified = classifyStructuralLineBoundaryDecisions({
      decisions: [staleDecision],
      paper: fixture.paper,
      provenance: fixture.provenance,
      visualRelationships: [rejected],
      assets: [fixture.asset],
    })

    expect(classified).toMatchObject({
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 0,
      decisions: [
        {
          outcome: 'unresolved',
          evidence: ['insufficient-hyphen-evidence', 'source-form-preserved'],
        },
      ],
    })
  })

  it('keeps a mixed prose-and-table transition corrupting', () => {
    const fixture = strictTableBoundaryFixture()
    const paper = {
      ...fixture.paper,
      nodes: [
        ...fixture.paper.nodes,
        {
          id: 'shared-prose',
          type: 'paragraph',
          text: 'inter-national',
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const provenance = {
      ...fixture.provenance,
      'shared-prose': {
        confidence: 1,
        pages: [1],
        regionIds: [fixture.decision.regionId],
        boxes: [
          {
            page: 1,
            x: 0.2,
            y: 0.3,
            width: 0.14,
            height: 0.043,
            rotation: 0,
            method: 'pdf-text',
          },
        ],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>

    const classified = classifyStructuralLineBoundaryDecisions({
      decisions: [fixture.decision],
      paper,
      provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(classified).toMatchObject({
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 0,
      decisions: [{ outcome: 'unresolved' }],
    })
  })

  it('keeps partial table transitions corrupting when the selected cells do not replay their source lines', () => {
    const fixture = strictTableBoundaryFixture()
    const tableRegion = fixture.regions.find(
      (region) => region.id === fixture.decision.regionId,
    )!
    const sourceRun = tableRegion.lines[0].runs[0]
    tableRegion.lines = [
      { ...tableRegion.lines[0], id: 'prose-line-1', text: 'retained-' },
      { ...tableRegion.lines[1], id: 'prose-line-2', text: 'prose-' },
      { ...tableRegion.lines[0], id: 'table-line-1', text: 'header-' },
      { ...tableRegion.lines[1], id: 'table-line-2', text: 'value' },
    ]
    tableRegion.text = 'retained-prose-header-value'
    const relationship: PdfVisualRelationship = {
      ...fixture.relationship,
      sourceLineIds: ['table-line-1', 'table-line-2'],
    }
    const paper: ResearchPaper = {
      ...fixture.paper,
      nodes: [
        ...fixture.paper.nodes,
        {
          id: 'retained-prose',
          type: 'paragraph',
          text: 'retained-prose-',
          source: 'test',
        },
      ],
    }
    const provenance: Record<string, NodeSourceEvidence> = {
      ...fixture.provenance,
      'retained-prose': {
        confidence: 1,
        pages: [1],
        regionIds: [tableRegion.id],
        boxes: [{ ...sourceRun }],
        links: [],
      },
    }
    const decisions = tableRegion.lines.slice(1).map((line, index) => ({
      id: `partial-boundary-${index + 1}`,
      page: 1,
      regionId: tableRegion.id,
      fromLineId: tableRegion.lines[index].id,
      toLineId: line.id,
      outcome: 'unresolved' as const,
      evidence: ['insufficient-hyphen-evidence', 'source-form-preserved'],
    }))

    const classified = classifyStructuralLineBoundaryDecisions({
      decisions,
      paper,
      provenance,
      visualRelationships: [relationship],
      assets: [fixture.asset],
    })

    expect(classified).toMatchObject({
      unresolvedCorruptingJoinCount: 3,
      structurallyConsumedLineBoundaryCount: 0,
      decisions: [
        {
          fromLineId: 'prose-line-1',
          toLineId: 'prose-line-2',
          outcome: 'unresolved',
        },
        {
          fromLineId: 'prose-line-2',
          toLineId: 'table-line-1',
          outcome: 'unresolved',
        },
        {
          fromLineId: 'table-line-1',
          toLineId: 'table-line-2',
          outcome: 'unresolved',
        },
      ],
    })
  })

  it('fails closed when canonical prose preserves characters but changes their order', () => {
    const sourceRun = run('abc', 0.1, 0.2)
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
          text: 'cba',
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.completeness.textCoverage).toBeLessThan(1)
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'INCOMPLETE_TEXT_COVERAGE',
    )
  })

  it('keeps an exact ordered match above the large-component threshold', () => {
    const sourceText = Array.from({ length: 1_001 }, (_, index) =>
      String.fromCodePoint(0x4e00 + index),
    ).join('')
    const outputText = `${sourceText.slice(0, 500)}a${sourceText.slice(500)}`
    const sourceRun = run(sourceText, 0.1, 0.2, 10, 0.8)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceText.length,
      imageCount: 0,
      runs: [sourceRun],
    }
    const paper: ResearchPaper = {
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
          id: 'paragraph-1',
          type: 'paragraph',
          text: outputText,
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.completeness).toMatchObject({
      sourceTextCharacters: 1_001,
      outputTextCharacters: 1_002,
      matchedTextCharacters: 1_001,
    })
    expect(result.completeness.textCoverage).toBeLessThan(1)
  })

  it('still rejects large reordered prose above the exact-LCS threshold', () => {
    const sourceText = `${'a'.repeat(600)}${'b'.repeat(600)}`
    const outputText = `${'b'.repeat(600)}${'a'.repeat(600)}`
    const sourceRun = run(sourceText, 0.1, 0.2, 10, 0.8)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceText.length,
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
          text: outputText,
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.completeness.matchedTextCharacters).toBe(600)
    expect(result.completeness.textCoverage).toBe(0.5)
    expect(result.readiness.ready).toBe(false)
  })

  it('does not misclassify one reordered canonical span as a duplicate', () => {
    const sourceRun = run(
      'Gamma delta precedes alpha beta in the source.',
      0.1,
      0.2,
      10,
      0.6,
    )
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
          text: 'Alpha beta follows gamma delta in the source.',
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.completeness.textCoverage).toBeLessThan(1)
    expect(result.completeness.duplicateCanonicalSpanCount).toBe(0)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'INCOMPLETE_TEXT_COVERAGE',
    )
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'DUPLICATE_CANONICAL_SPAN',
    )
  })

  it('fails closed when a canonical span is duplicated', () => {
    const value = 'Alpha beta gamma delta.'
    const sourceRun = run(value, 0.1, 0.2, 10, 0.5)
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
    const paragraph = (id: string) => ({
      id,
      type: 'paragraph' as const,
      text: value,
      source: 'test',
    })
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [paragraph('paragraph-1'), paragraph('paragraph-2')],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.completeness.duplicateCanonicalSpanCount).toBe(1)
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'DUPLICATE_CANONICAL_SPAN',
    )
  })

  it('fails closed when metadata titles or adjacent headings repeat as canonical roles', () => {
    const titleRun = run('Paper Title', 0.1, 0.1, 16, 0.3)
    const firstMethodRun = run('Method', 0.1, 0.2, 14, 0.2)
    const secondMethodRun = run('Method', 0.1, 0.3, 14, 0.2)
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters:
        titleRun.text.length +
        firstMethodRun.text.length +
        secondMethodRun.text.length,
      imageCount: 0,
      runs: [titleRun, firstMethodRun, secondMethodRun],
    }
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper Title',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [
        {
          id: 'title-heading',
          type: 'heading',
          level: 1,
          text: 'Paper Title',
          source: 'test',
        },
        {
          id: 'method-one',
          type: 'heading',
          level: 2,
          text: 'Method',
          source: 'test',
        },
        {
          id: 'method-two',
          type: 'heading',
          level: 2,
          text: 'Method',
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'DUPLICATE_CANONICAL_ROLE',
    )
  })

  it('allows one source-backed canonical node to carry the publication title role', () => {
    const titleRun = run('Paper Title', 0.1, 0.1, 16, 0.3)
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: titleRun.text,
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [
        {
          id: 'title-heading',
          type: 'heading',
          level: 1,
          text: titleRun.text,
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
          textCharacters: titleRun.text.length,
          imageCount: 0,
          runs: [titleRun],
        },
      ],
      paper,
      diagnostics: [],
    })

    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'DUPLICATE_CANONICAL_ROLE',
    )
  })

  it('fails closed when canonical prose reverses source reading-order intervals', () => {
    const firstRun = run('First source paragraph.', 0.1, 0.2, 10, 0.6)
    const secondRun = run('Second source paragraph.', 0.1, 0.3, 10, 0.6)
    const sourceRegion = (id: string, sourceRun: PdfSourceRun) => ({
      id,
      page: 1,
      kind: 'body' as const,
      column: 'single' as const,
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
    const firstRegion = sourceRegion('first-region', firstRun)
    const secondRegion = sourceRegion('second-region', secondRun)
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
          id: 'second-node',
          type: 'paragraph',
          text: secondRun.text,
          source: 'test',
        },
        {
          id: 'first-node',
          type: 'paragraph',
          text: firstRun.text,
          source: 'test',
        },
      ],
    }
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
    }
    const readingOrder: PdfReadingOrderGraph = {
      schemaVersion: '1.0.0',
      regionIds: [firstRegion.id, secondRegion.id],
      order: [firstRegion.id, secondRegion.id],
      edges: [],
      resolutions: [],
      acyclic: true,
      evaluation: {
        schemaVersion: '1.0.0',
        algorithm: 'deterministic-geometry-v1',
        mode: 'deterministic-only',
        regionCount: 2,
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
          textCharacters: firstRun.text.length + secondRun.text.length,
          imageCount: 0,
          runs: [firstRun, secondRun],
        },
      ],
      paper,
      diagnostics: [],
      regions: [firstRegion, secondRegion],
      readingOrder,
      provenance,
    })

    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
    expect(result.completeness.readingOrderDiagnostics).toBe(1)
    expect(result.completeness.readingOrderEvaluation).toMatchObject({
      regionCount: 2,
      unresolvedEdgeCount: 0,
      reviewRequired: true,
    })
  })

  it('does not reinterpret resolved hyphen forms inside a reconstructed region', () => {
    const preservedRun = run('Reputation affects sustain- ability.', 0.1, 0.2)
    const lexiconRun = run('Sustainability matters.', 0.1, 0.3)
    const sourceRegion = (
      id: string,
      sourceRun: PdfSourceRun,
    ): PdfPageRegion => ({
      id,
      page: 1,
      kind: 'body',
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
    const preservedRegion = sourceRegion('preserved-region', preservedRun)
    const lexiconRegion = sourceRegion('lexicon-region', lexiconRun)
    const paper: ResearchPaper = {
      id: 'preserved-hyphen-paper',
      version: '1.0.0',
      status: 'working',
      title: '',
      subtitle: 'Test',
      authors: [],
      updated: '2026-07-28',
      abstract: 'Test',
      nodes: [
        {
          id: 'preserved-node',
          type: 'paragraph',
          text: preservedRun.text,
          source: 'test',
        },
      ],
    }
    const provenance: Record<string, NodeSourceEvidence> = {
      'preserved-node': {
        confidence: 1,
        pages: [1],
        regionIds: [preservedRegion.id],
        boxes: [{ ...preservedRegion.box }],
        links: [],
      },
    }

    expect(
      provenanceTextConservation({
        allRegions: [preservedRegion, lexiconRegion],
        orderedRegions: [preservedRegion, lexiconRegion],
        paper,
        provenance,
        lineBoundaryDecisions: [],
      }).semanticTextViolationNodeIds,
    ).toEqual([])
  })

  it('conserves a literal URL split across source regions', () => {
    const firstRun = run('URL https://openreview.', 0.1, 0.2)
    const secondRun = run('net/forum?id=proof.', 0.1, 0.3)
    const sourceRegion = (
      id: string,
      sourceRun: PdfSourceRun,
    ): PdfPageRegion => ({
      id,
      page: 1,
      kind: 'body',
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
    const firstRegion = sourceRegion('url-first-region', firstRun)
    const secondRegion = sourceRegion('url-second-region', secondRun)
    const paper: ResearchPaper = {
      id: 'split-url-paper',
      version: '1.0.0',
      status: 'working',
      title: '',
      subtitle: 'Test',
      authors: [],
      updated: '2026-07-28',
      abstract: 'Test',
      nodes: [
        {
          id: 'url-node',
          type: 'paragraph',
          text: 'URL https://openreview.net/forum?id=proof.',
          source: 'test',
        },
      ],
    }
    const provenance: Record<string, NodeSourceEvidence> = {
      'url-node': {
        confidence: 1,
        pages: [1],
        regionIds: [firstRegion.id, secondRegion.id],
        boxes: [{ ...firstRegion.box }, { ...secondRegion.box }],
        links: [],
      },
    }

    expect(
      provenanceTextConservation({
        allRegions: [firstRegion, secondRegion],
        orderedRegions: [firstRegion, secondRegion],
        paper,
        provenance,
        lineBoundaryDecisions: [],
      }).semanticTextViolationNodeIds,
    ).toEqual([])
  })

  it('replays default space and proved no-space around formula punctuation', () => {
    const texts = ['where', 'f(x)', ', which closes the expression.']
    const sourceRuns: PdfSourceRun[] = texts.map((text, index) => {
      const base = {
        ...run(text, 0.1 + index * 0.15, 0.2, 10, 0.14),
        fontName: index === 1 ? 'Synthetic-Math' : 'Body',
        sourceSequenceIndex: index,
      }
      return index > 0
        ? {
            ...base,
            sourceWhitespaceBefore: 'pdf-text-item',
            sourceWhitespacePredecessorIndex: index - 1,
          }
        : base
    })
    const regions = sourceRuns.map(
      (sourceRun, index) =>
        ({
          id: `semantic-flow-region-${index + 1}`,
          page: 1,
          kind: index === 1 ? 'equation' : 'body',
          column: 'single',
          text: sourceRun.text,
          confidence: 1,
          box: { ...sourceRun },
          lines: [
            {
              id: `page-001-inline-stacked-0001-${
                index === 0 ? 'before' : index === 1 ? 'formula' : 'after'
              }`,
              text: sourceRun.text,
              fontSize: sourceRun.fontSize,
              box: { ...sourceRun },
              runs: [{ ...sourceRun }],
              sourceFragmentLineage: {
                algorithm: 'source-run-fragment-v1',
                sourceLineId: 'semantic-flow-stacked-source-line',
                fragment:
                  index === 0
                    ? 'inline-stacked-before'
                    : index === 1
                      ? 'inline-stacked-formula'
                      : 'inline-stacked-after',
                sourceSequenceIndexes: [index],
              },
            },
          ],
          nativeObjectIds: [],
          includedInReadingOrder: true,
        }) as PdfPageRegion,
    )
    const paper: ResearchPaper = {
      id: 'semantic-flow-paper',
      version: '1.0.0',
      status: 'working',
      title: '',
      subtitle: 'Test',
      authors: [],
      updated: '2026-07-30',
      abstract: 'Test',
      nodes: [
        {
          id: 'semantic-flow-node',
          type: 'paragraph',
          text: 'where f(x), which closes the expression.',
          source: 'test',
        },
      ],
    }
    const provenance: Record<string, NodeSourceEvidence> = {
      'semantic-flow-node': {
        confidence: 1,
        pages: [1],
        regionIds: regions.map((region) => region.id),
        boxes: regions.map((region) => ({ ...region.box })),
        links: [],
      },
    }
    const runSha256 = (sourceRun: PdfSourceRun) =>
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
        .digest('hex')
    const endpoint = (index: number) => ({
      regionId: regions[index].id,
      lineId: regions[index].lines[0].id,
      runIndex: 0,
      sourceSequenceIndex: index,
      sourceRunSha256: runSha256(sourceRuns[index]),
      sourceFragmentId: `semantic-flow-stacked-source-line:${
        index === 0
          ? 'inline-stacked-before'
          : index === 1
            ? 'inline-stacked-formula'
            : 'inline-stacked-after'
      }`,
    })
    const decisions = [
      sourceSemanticFlowDecision({
        page: 1,
        rotation: 0,
        method: 'pdf-text',
        topology: 'inline-stacked-fragment',
        outcome: 'no-space',
        from: endpoint(1),
        to: endpoint(2),
        evidence: [...PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE],
      }),
    ]
    const visualRelationship: PdfVisualRelationship = {
      id: 'semantic-flow-inline-equation',
      kind: 'equation',
      label: 'Inline equation',
      captionRegionId: regions[1].id,
      sourceRegionIds: [regions[1].id],
      sourceLineIds: [regions[1].lines[0].id],
      sourceObjectIds: [],
      assetIds: [],
      status: 'unresolved',
      confidence: 1,
      evidence: ['source-text-transcript-unresolved'],
      candidates: [],
      sourceBoxes: [{ ...regions[1].box }],
      sourceText: sourceRuns[1].text,
      altText: sourceRuns[1].text,
      altTextSource: 'source-text',
      canonicalNodeId: null,
      captionNodeId: null,
    }

    const result = provenanceTextConservation({
      allRegions: regions,
      orderedRegions: regions,
      paper,
      provenance,
      visualRelationships: [visualRelationship],
      lineBoundaryDecisions: [],
      sourceSemanticFlowBoundaryDecisions: decisions,
    } as Parameters<typeof provenanceTextConservation>[0] & {
      sourceSemanticFlowBoundaryDecisions: typeof decisions
    })

    expect(result.semanticTextViolationNodeIds).toEqual([])
  })

  describe('cross-page-column ledger verification', () => {
    const crossPageFixture = ({
      runningHeadIsFurniture,
    }: {
      runningHeadIsFurniture: boolean
    }) => {
      const tailRun = {
        ...run(
          'The measured drift therefore continues toward the',
          0.515,
          0.82,
          10,
          0.385,
        ),
        sourceSequenceIndex: 40,
      }
      const headRun = {
        ...run('Continuous prose reconstruction', 0.09, 0.03, 10, 0.385),
        page: 2,
        sourceSequenceIndex: 0,
      }
      const continuationRun = {
        ...run(
          'stationary regime described in the next section.',
          0.09,
          0.1,
          10,
          0.385,
        ),
        page: 2,
        sourceSequenceIndex: 1,
      }
      const region = (
        id: string,
        sourceRun: PdfSourceRun,
        column: PdfPageRegion['column'],
        furniture = false,
      ): PdfPageRegion => ({
        id,
        page: sourceRun.page,
        kind: 'body',
        column,
        text: sourceRun.text,
        confidence: 1,
        box: { ...sourceRun },
        lines: [
          {
            id: `${id}-line`,
            text: sourceRun.text,
            fontSize: sourceRun.fontSize,
            box: { ...sourceRun },
            runs: [sourceRun],
            sourceFragmentLineage: {
              algorithm: 'source-run-fragment-v1',
              sourceLineId: `${id}-source-line`,
              fragment: 'whole',
              sourceSequenceIndexes: [sourceRun.sourceSequenceIndex!],
            },
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: !furniture,
        ...(furniture
          ? {
              furniture: {
                classification: 'repeated-text' as const,
                band: 'top' as const,
                pages: [1, 2],
                boxes: [{ ...sourceRun }],
                evidence: ['repeated-normalized-text'],
              },
            }
          : {}),
      })
      const tail = region('cross-page-tail', tailRun, 'right')
      const head = region(
        'cross-page-running-head',
        headRun,
        runningHeadIsFurniture ? 'span' : 'left',
        runningHeadIsFurniture,
      )
      const continuation = region(
        'cross-page-continuation',
        continuationRun,
        'left',
      )
      const endpoint = (target: PdfPageRegion, sourceRun: PdfSourceRun) => ({
        regionId: target.id,
        lineId: target.lines[0].id,
        runIndex: 0,
        sourceSequenceIndex: sourceRun.sourceSequenceIndex!,
        sourceRunSha256: pdfSourceSemanticFlowRunSha256(sourceRun),
        sourceFragmentId: `${target.id}-source-line:whole`,
      })
      const decision = sourceSemanticFlowDecision({
        page: 1,
        rotation: 0,
        method: 'pdf-text',
        topology: 'cross-page-column',
        outcome: 'space',
        from: endpoint(tail, tailRun),
        to: endpoint(continuation, continuationRun),
        evidence: [...PDF_SOURCE_SEMANTIC_FLOW_CROSS_PAGE_EVIDENCE],
      })
      const canonicalText = `${tailRun.text} ${continuationRun.text}`
      const paper: ResearchPaper = {
        id: 'cross-page-paper',
        version: '1.0.0',
        status: 'working',
        title: '',
        subtitle: 'Test',
        authors: [],
        updated: '2026-07-30',
        abstract: 'Test',
        nodes: [
          {
            id: 'cross-page-node',
            type: 'paragraph',
            text: canonicalText,
            source: 'test',
          },
        ],
      }
      const orderedRegions = [tail, continuation]
      const provenance: Record<string, NodeSourceEvidence> = {
        'cross-page-node': {
          confidence: 1,
          pages: [1, 2],
          regionIds: orderedRegions.map((target) => target.id),
          boxes: orderedRegions.map((target) => ({ ...target.box })),
          links: [],
        },
      }
      return { decision, paper, provenance, orderedRegions, head }
    }

    it('accepts a page-break join whose only intervening source is furniture', () => {
      const { decision, paper, provenance, orderedRegions, head } =
        crossPageFixture({ runningHeadIsFurniture: true })

      const result = provenanceTextConservation({
        allRegions: [orderedRegions[0], head, orderedRegions[1]],
        orderedRegions,
        paper,
        provenance,
        lineBoundaryDecisions: [],
        sourceSemanticFlowBoundaryDecisions: [decision],
      })

      expect(result.semanticFlowBoundaryLedgerValid).toBe(true)
      expect(result.semanticTextViolationNodeIds).toEqual([])
    })

    it('rejects a page-break join that skips unaccounted body source', () => {
      // Identical ledger entry, but the intervening page-two text carries no
      // furniture evidence. The audit re-derives the page extrema itself, so a
      // forged cross-page proof cannot survive without issue 042's evidence.
      const { decision, paper, provenance, orderedRegions, head } =
        crossPageFixture({ runningHeadIsFurniture: false })

      const result = provenanceTextConservation({
        allRegions: [orderedRegions[0], head, orderedRegions[1]],
        orderedRegions,
        paper,
        provenance,
        lineBoundaryDecisions: [],
        sourceSemanticFlowBoundaryDecisions: [decision],
      })

      expect(result.semanticFlowBoundaryLedgerValid).toBe(false)
    })

    it('does not let an unvalidated matched visual hide intervening body source', () => {
      const { decision, paper, provenance, orderedRegions, head } =
        crossPageFixture({ runningHeadIsFurniture: false })
      const forgedRelationship: PdfVisualRelationship = {
        id: 'forged-cross-page-table',
        kind: 'table',
        label: 'Table 99',
        captionRegionId: head.id,
        sourceRegionIds: [head.id],
        sourceLineIds: [head.lines[0].id],
        sourceObjectIds: [],
        assetIds: [],
        status: 'matched',
        confidence: 1,
        evidence: ['forged-test-relationship'],
        candidates: [],
        sourceBoxes: [{ ...head.box }],
        sourceText: head.text,
        altText: 'Forged table',
        altTextSource: 'caption',
        canonicalNodeId: null,
        captionNodeId: null,
      }

      const result = provenanceTextConservation({
        allRegions: [orderedRegions[0], head, orderedRegions[1]],
        orderedRegions,
        paper,
        provenance,
        visualRelationships: [forgedRelationship],
        validatedVisualRelationships: [],
        lineBoundaryDecisions: [],
        sourceSemanticFlowBoundaryDecisions: [decision],
      })

      expect(result.semanticFlowBoundaryLedgerValid).toBe(false)
    })

    it('rejects a canonical cross-page paragraph with no boundary decision', () => {
      const { paper, provenance, orderedRegions } = crossPageFixture({
        runningHeadIsFurniture: true,
      })

      const result = provenanceTextConservation({
        allRegions: orderedRegions,
        orderedRegions,
        paper,
        provenance,
        lineBoundaryDecisions: [],
        sourceSemanticFlowBoundaryDecisions: [],
      })

      expect(result.semanticFlowBoundaryLedgerValid).toBe(false)
      expect(result.semanticTextViolationNodeIds).toContain('cross-page-node')
    })
  })

  it('validates uncased-script same-page-column decisions from layout', () => {
    const sourceRuns = [
      {
        ...run('البيانات تستمر نحو', 0.515, 0.82, 10, 0.385),
        sourceSequenceIndex: 200,
      },
      {
        ...run('العلمية في العمود التالي', 0.09, 0.1, 10, 0.385),
        sourceSequenceIndex: 201,
        sourceWhitespaceBefore: 'pdf-text-item' as const,
        sourceWhitespacePredecessorIndex: 200,
      },
    ]
    const regions = sourceRuns.map((sourceRun, index): PdfPageRegion => ({
      id: `uncased-column-region-${index + 1}`,
      page: 1,
      kind: 'body',
      column: index === 0 ? 'right' : 'left',
      text: sourceRun.text,
      confidence: 1,
      box: { ...sourceRun },
      lines: [
        {
          id: `uncased-column-line-${index + 1}`,
          text: sourceRun.text,
          fontSize: sourceRun.fontSize,
          box: { ...sourceRun },
          runs: [sourceRun],
          sourceFragmentLineage: {
            algorithm: 'source-run-fragment-v1',
            sourceLineId: `uncased-column-source-line-${index + 1}`,
            fragment: 'whole',
            sourceSequenceIndexes: [sourceRun.sourceSequenceIndex],
          },
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }))
    const endpoint = (index: number) => ({
      regionId: regions[index].id,
      lineId: regions[index].lines[0].id,
      runIndex: 0,
      sourceSequenceIndex: sourceRuns[index].sourceSequenceIndex!,
      sourceRunSha256: pdfSourceSemanticFlowRunSha256(sourceRuns[index]),
      sourceFragmentId: `uncased-column-source-line-${index + 1}:whole`,
    })
    const decision = sourceSemanticFlowDecision({
      page: 1,
      rotation: 0,
      method: 'pdf-text',
      topology: 'same-page-column',
      outcome: 'space',
      from: endpoint(0),
      to: endpoint(1),
      evidence: [...PDF_SOURCE_SEMANTIC_FLOW_COLUMN_EVIDENCE],
    })
    const paper: ResearchPaper = {
      id: 'uncased-column-paper',
      version: '1.0.0',
      status: 'working',
      title: '',
      subtitle: 'Test',
      authors: [],
      updated: '2026-07-30',
      abstract: 'Test',
      language: 'ar',
      baseDirection: 'rtl',
      nodes: [
        {
          id: 'uncased-column-node',
          type: 'paragraph',
          text: 'البيانات تستمر نحو العلمية في العمود التالي',
          source: 'test',
        },
      ],
    }
    const provenance: Record<string, NodeSourceEvidence> = {
      'uncased-column-node': {
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
      sourceSemanticFlowBoundaryDecisions: [decision],
    })

    expect(result.semanticFlowBoundaryLedgerValid).toBe(true)
    expect(result.semanticTextViolationNodeIds).toEqual([])
  })

  it('validates no-space Chinese same-page-column decisions from layout', () => {
    const sourceRuns = [
      {
        ...run('研究结果继续', 0.09, 0.82, 10, 0.385),
        sourceSequenceIndex: 500,
      },
      {
        ...run('在下一栏完成', 0.515, 0.1, 10, 0.385),
        sourceSequenceIndex: 501,
      },
    ]
    const regions = sourceRuns.map((sourceRun, index): PdfPageRegion => ({
      id: `cjk-column-region-${index + 1}`,
      page: 1,
      kind: 'body',
      column: index === 0 ? 'left' : 'right',
      text: sourceRun.text,
      confidence: 1,
      box: { ...sourceRun },
      lines: [
        {
          id: `cjk-column-line-${index + 1}`,
          text: sourceRun.text,
          fontSize: sourceRun.fontSize,
          box: { ...sourceRun },
          runs: [sourceRun],
          sourceFragmentLineage: {
            algorithm: 'source-run-fragment-v1',
            sourceLineId: `cjk-column-source-line-${index + 1}`,
            fragment: 'whole',
            sourceSequenceIndexes: [sourceRun.sourceSequenceIndex],
          },
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }))
    const endpoint = (index: number) => ({
      regionId: regions[index].id,
      lineId: regions[index].lines[0].id,
      runIndex: 0,
      sourceSequenceIndex: sourceRuns[index].sourceSequenceIndex!,
      sourceRunSha256: pdfSourceSemanticFlowRunSha256(sourceRuns[index]),
      sourceFragmentId: `cjk-column-source-line-${index + 1}:whole`,
    })
    const decision = sourceSemanticFlowDecision({
      page: 1,
      rotation: 0,
      method: 'pdf-text',
      topology: 'same-page-column',
      outcome: 'no-space',
      from: endpoint(0),
      to: endpoint(1),
      evidence: [...PDF_SOURCE_SEMANTIC_FLOW_COLUMN_EVIDENCE],
    })
    const paper: ResearchPaper = {
      id: 'cjk-column-paper',
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
          id: 'cjk-column-node',
          type: 'paragraph',
          text: '研究结果继续在下一栏完成',
          source: 'test',
        },
      ],
    }
    const provenance: Record<string, NodeSourceEvidence> = {
      'cjk-column-node': {
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
      sourceSemanticFlowBoundaryDecisions: [decision],
    })

    expect(result.semanticFlowBoundaryLedgerValid).toBe(true)
    expect(result.semanticTextViolationNodeIds).toEqual([])
  })

  it('validates numeric CJK same-page-column decisions from layout', () => {
    const sourceRuns = [
      {
        ...run('研究结果继续', 0.09, 0.82, 10, 0.385),
        sourceSequenceIndex: 510,
      },
      {
        ...run('2024年的结果', 0.515, 0.1, 10, 0.385),
        sourceSequenceIndex: 511,
      },
    ]
    const regions = sourceRuns.map((sourceRun, index): PdfPageRegion => ({
      id: `numeric-cjk-column-region-${index + 1}`,
      page: 1,
      kind: 'body',
      column: index === 0 ? 'left' : 'right',
      text: sourceRun.text,
      confidence: 1,
      box: { ...sourceRun },
      lines: [
        {
          id: `numeric-cjk-column-line-${index + 1}`,
          text: sourceRun.text,
          fontSize: sourceRun.fontSize,
          box: { ...sourceRun },
          runs: [sourceRun],
          sourceFragmentLineage: {
            algorithm: 'source-run-fragment-v1',
            sourceLineId: `numeric-cjk-column-source-line-${index + 1}`,
            fragment: 'whole',
            sourceSequenceIndexes: [sourceRun.sourceSequenceIndex],
          },
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }))
    const endpoint = (index: number) => ({
      regionId: regions[index].id,
      lineId: regions[index].lines[0].id,
      runIndex: 0,
      sourceSequenceIndex: sourceRuns[index].sourceSequenceIndex!,
      sourceRunSha256: pdfSourceSemanticFlowRunSha256(sourceRuns[index]),
      sourceFragmentId: `numeric-cjk-column-source-line-${index + 1}:whole`,
    })
    const decision = sourceSemanticFlowDecision({
      page: 1,
      rotation: 0,
      method: 'pdf-text',
      topology: 'same-page-column',
      outcome: 'no-space',
      from: endpoint(0),
      to: endpoint(1),
      evidence: [...PDF_SOURCE_SEMANTIC_FLOW_COLUMN_EVIDENCE],
    })
    const paper: ResearchPaper = {
      id: 'numeric-cjk-column-paper',
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
          id: 'numeric-cjk-column-node',
          type: 'paragraph',
          text: '研究结果继续2024年的结果',
          source: 'test',
        },
      ],
    }
    const provenance: Record<string, NodeSourceEvidence> = {
      'numeric-cjk-column-node': {
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
      sourceSemanticFlowBoundaryDecisions: [decision],
    })

    expect(result.semanticFlowBoundaryLedgerValid).toBe(true)
    expect(result.semanticTextViolationNodeIds).toEqual([])
  })

  it('fails closed on a rendered superscript marker and bottom footnote', () => {
    const runs = [
      run('Body text', 0.1, 0.2, 10, 0.16),
      run('1', 0.262, 0.196, 6, 0.008, 0.009),
      run('1. Note text', 0.1, 0.82, 7, 0.3, 0.012),
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
      imageCount: 0,
      runs,
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
          id: 'p-1',
          type: 'paragraph',
          text: 'Body text 1 1. Note text',
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.semanticSignals).toMatchObject({
      footnoteReferences: 1,
      footnotes: 1,
    })
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toEqual(
      expect.arrayContaining([
        'INCOMPLETE_RELATIONSHIP_COVERAGE',
        'UNRESOLVED_SEMANTIC_OBJECTS',
      ]),
    )
  })

  it('uses canonical note links only when relationship evidence is absent', () => {
    const runs = [
      run('Body text', 0.1, 0.2, 10, 0.16),
      run('1', 0.262, 0.196, 6, 0.008, 0.009),
      run('1. Note text', 0.1, 0.82, 7, 0.3, 0.012),
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
      imageCount: 0,
      runs,
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
          id: 'p-1',
          type: 'paragraph',
          text: 'Body text1',
          noteReferences: [
            {
              id: 'note-reference-1',
              label: '1',
              target: 'note-1',
              start: 9,
              end: 10,
              confidence: 1,
            },
          ],
          source: 'test',
        },
        {
          id: 'note-1',
          type: 'footnote',
          kind: 'footnote',
          label: '1',
          text: 'Note text',
          relationships: { backlinks: ['note-reference-1'] },
          source: 'test',
        },
      ],
    }

    const canonicalOnly = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })
    const explicitEmptyGraph = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      noteRelationships: [],
    })

    expect(canonicalOnly.semanticSignals).toMatchObject({
      footnoteReferences: 1,
      footnotes: 1,
    })
    expect(canonicalOnly.completeness).toMatchObject({
      expectedRelationshipCount: 1,
      resolvedRelationshipCount: 1,
      relationshipCoverage: 1,
      unresolvedObjects: {
        footnoteReferences: 0,
        footnotes: 0,
      },
    })
    expect(explicitEmptyGraph.completeness).toMatchObject({
      expectedRelationshipCount: 1,
      resolvedRelationshipCount: 0,
      relationshipCoverage: 0,
      unresolvedObjects: {
        footnoteReferences: 1,
        footnotes: 1,
      },
    })
  })

  it.each([
    { label: 'forbidden C0 control', text: '\u0012' },
    { label: 'Unicode replacement glyph', text: 'term \ufffd value' },
  ])('blocks canonical text containing a $label', ({ text }) => {
    const sourceRun = run(text, 0.1, 0.2)
    const sourcePage: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: text.length,
      imageCount: 0,
      runs: [sourceRun],
    }
    const corruptPaper: ResearchPaper = {
      id: 'corrupt-text-paper',
      version: '1.0.0',
      status: 'working',
      title: 'Corrupt text',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-23',
      abstract: 'Test',
      nodes: [
        {
          id: 'corrupt-node',
          type: 'paragraph',
          text,
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [sourcePage],
      paper: corruptPaper,
      diagnostics: [],
    })

    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'EPUB_TEXT_SANITIZATION_LOSS',
    )
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'EPUB_TEXT_SANITIZATION_LOSS',
        severity: 'error',
      }),
    )
  })

  it('conserves a classified footnote marker as note semantics instead of prose', () => {
    const sourceRun = run('∗note@example.com', 0.1, 0.82)
    const sourceRegion = {
      id: 'footnote-region',
      page: 1,
      kind: 'footnote',
      column: 'single',
      text: sourceRun.text,
      confidence: 1,
      box: { ...sourceRun },
      lines: [
        {
          id: 'footnote-line',
          text: sourceRun.text,
          fontSize: sourceRun.fontSize,
          box: { ...sourceRun },
          runs: [{ ...sourceRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const sourcePage = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceRun.text.length,
      imageCount: 0,
      runs: [sourceRun],
    } satisfies PdfPageAnalysis
    const notePaper = {
      id: 'classified-note-paper',
      version: '1.0.0',
      status: 'working',
      title: '',
      subtitle: 'Test',
      authors: [],
      updated: '2026-07-23',
      abstract: 'Test',
      nodes: [
        {
          id: 'classified-note',
          type: 'footnote',
          kind: 'footnote',
          label: '*',
          markerText: '∗',
          text: 'note@example.com',
          relationships: { backlinks: [] },
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const provenance = {
      'classified-note': {
        confidence: 1,
        pages: [1],
        regionIds: [sourceRegion.id],
        boxes: [{ ...sourceRegion.box }],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>
    const readingOrder = {
      schemaVersion: '1.0.0',
      regionIds: [sourceRegion.id],
      order: [sourceRegion.id],
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

    const result = assessPdfCompleteness({
      pages: [sourcePage],
      paper: notePaper,
      diagnostics: [],
      regions: [sourceRegion],
      readingOrder,
      provenance,
    })
    const conservation = provenanceTextConservation({
      allRegions: [sourceRegion],
      orderedRegions: [sourceRegion],
      paper: notePaper,
      provenance,
      lineBoundaryDecisions: [],
    })

    expect(result.completeness.textCoverage).toBe(1)
    expect(conservation).toMatchObject({
      sameRegionFlowViolationNodeIds: [],
      semanticTextViolationNodeIds: [],
    })
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
  })

  it('blocks an orphan canonical note backlink before EPUB rendering', () => {
    const sourceRun = run('Affiliation note', 0.1, 0.82)
    const sourcePage: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceRun.text.length,
      imageCount: 0,
      runs: [sourceRun],
    }
    const notePaper: ResearchPaper = {
      id: 'orphan-note-paper',
      version: '1.0.0',
      status: 'working',
      title: 'Orphan note',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-23',
      abstract: 'Test',
      nodes: [
        {
          id: 'orphan-note',
          type: 'footnote',
          kind: 'footnote',
          label: '1',
          text: sourceRun.text,
          relationships: { backlinks: ['page-001-author-region'] },
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [sourcePage],
      paper: notePaper,
      diagnostics: [],
    })

    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'DANGLING_EPUB_INTERNAL_REFERENCE',
    )
  })
})
