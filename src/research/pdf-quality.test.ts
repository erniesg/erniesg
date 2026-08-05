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
  PDF_SOURCE_SEMANTIC_FLOW_NO_SPACE_EVIDENCE,
  pdfSourceSemanticFlowBoundaryDecisionId,
  pdfSourceSemanticFlowRunSha256,
} from './pdf-regions'
import { mergeProseContinuations } from './pdf-layout'

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

function run(
  text: string,
  x: number,
  y: number,
  fontSize = 10,
  width = 0.06,
  height = 0.018,
): PdfSourceRun {
  return {
    page: 1,
    text,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text',
    fontName: 'Body',
    fontSize,
    confidence: 1,
  }
}

function normalizedLength(value: string) {
  return [...value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')].length
}

function sourceBackedEquationFixture() {
  const captionRun = run('Equation 1. Source glyph.', 0.2, 0.2, 10, 0.4)
  const equationRun = run('q = r', 0.25, 0.3, 14, 0.12)
  const objectBox = {
    page: 1,
    x: equationRun.x,
    y: equationRun.y,
    width: equationRun.width,
    height: equationRun.height,
    rotation: 0,
    method: 'pdf-object' as const,
  }
  const bytes = new TextEncoder().encode('SOURCE-GLYPH')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const assetId = `asset-${sha256.slice(0, 24)}`
  const region = (
    id: string,
    kind: PdfPageRegion['kind'],
    sourceRun: PdfSourceRun,
    nativeObjectIds: string[] = [],
  ) =>
    ({
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
      nativeObjectIds,
      includedInReadingOrder: true,
    }) satisfies PdfPageRegion
  const captionRegion = region('caption-region', 'caption', captionRun)
  const equationRegion = region('equation-region', 'equation', equationRun, [
    'equation-object',
  ])
  const relationship = {
    id: 'relationship-1',
    kind: 'equation',
    label: 'Equation 1',
    captionRegionId: captionRegion.id,
    sourceRegionIds: [equationRegion.id],
    sourceLineIds: equationRegion.lines.map((line) => line.id),
    sourceObjectIds: ['equation-object'],
    assetIds: [assetId],
    status: 'matched',
    confidence: 1,
    evidence: ['source-glyph-raster'],
    candidates: [],
    sourceBoxes: [{ ...captionRegion.box }, { ...objectBox }],
    sourceText: equationRun.text,
    altText: captionRun.text,
    altTextSource: 'caption',
    canonicalNodeId: 'equation-1',
    captionNodeId: 'caption-1',
  } satisfies PdfVisualRelationship
  const asset = {
    id: assetId,
    href: `assets/${assetId}.png`,
    mediaType: 'image/png',
    kind: 'raster',
    rendition: 'source-preserved',
    sha256,
    bytes,
    width: 120,
    height: 30,
    resolutionDpi: null,
    sourceObjectIds: ['equation-object'],
    sourceBoxes: [{ ...objectBox }],
  } satisfies PdfVisualAsset
  const page = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: captionRun.text.length + equationRun.text.length,
    imageCount: 1,
    objects: [
      {
        id: 'equation-object',
        page: 1,
        kind: 'image',
        box: { ...objectBox },
        confidence: 1,
        assetId,
      },
    ],
    runs: [captionRun, equationRun],
  } satisfies PdfPageAnalysis
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
        id: 'equation-1',
        type: 'figure',
        objectType: 'equation',
        title: 'Equation 1',
        relationships: { caption: 'caption-1', assets: [assetId] },
        source: 'test',
      },
      {
        id: 'caption-1',
        type: 'caption',
        text: captionRun.text,
        source: 'test',
      },
    ],
  } satisfies ResearchPaper
  const provenance = {
    'equation-1': {
      confidence: 1,
      pages: [1],
      regionIds: [equationRegion.id],
      boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
      links: [],
    },
    'caption-1': {
      confidence: 1,
      pages: [1],
      regionIds: [captionRegion.id],
      boxes: [{ ...captionRegion.box }],
      links: [],
    },
  } satisfies Record<string, NodeSourceEvidence>
  const readingOrder = {
    schemaVersion: '1.0.0',
    regionIds: [captionRegion.id, equationRegion.id],
    order: [captionRegion.id, equationRegion.id],
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
    page,
    paper,
    relationship,
    asset,
    provenance,
    regions: [captionRegion, equationRegion],
    readingOrder,
  }
}

function assessSourceBackedEquation(
  fixture: ReturnType<typeof sourceBackedEquationFixture>,
  options: {
    asset?: PdfVisualAsset
    relationship?: Partial<PdfVisualRelationship>
    provenance?: Record<string, NodeSourceEvidence>
  } = {},
) {
  const asset = options.asset ?? fixture.asset
  const relationship = {
    ...fixture.relationship,
    assetIds: [asset.id],
    ...options.relationship,
  } satisfies PdfVisualRelationship
  const paper = {
    ...fixture.paper,
    nodes: fixture.paper.nodes.map((node) =>
      node.type === 'figure'
        ? {
            ...node,
            relationships: { ...node.relationships, assets: [asset.id] },
          }
        : node,
    ),
  } satisfies ResearchPaper
  const page = {
    ...fixture.page,
    objects: fixture.page.objects?.map((object) => ({
      ...object,
      assetId: asset.id,
    })),
  } satisfies PdfPageAnalysis
  return assessPdfCompleteness({
    pages: [page],
    paper,
    diagnostics: [],
    regions: fixture.regions,
    readingOrder: fixture.readingOrder,
    provenance: options.provenance ?? fixture.provenance,
    visualRelationships: [relationship],
    assets: [asset],
  })
}

function equationAssetWithPayload(
  fixture: ReturnType<typeof sourceBackedEquationFixture>,
  input: {
    bytes: Uint8Array
    mediaType: PdfVisualAsset['mediaType']
    kind: PdfVisualAsset['kind']
    rendition: PdfVisualAsset['rendition']
  },
) {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const id = `asset-${sha256.slice(0, 24)}`
  const extension =
    input.mediaType === 'image/svg+xml'
      ? 'svg'
      : input.mediaType === 'application/xhtml+xml'
        ? 'xhtml'
        : 'png'
  return {
    ...fixture.asset,
    ...input,
    id,
    href: `assets/${id}.${extension}`,
    sha256,
  } satisfies PdfVisualAsset
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

  it('conserves validated visual text locally without treating other non-reading regions as prose', () => {
    const fixture = sourceBackedEquationFixture()
    const titleRun = run('Paper', 0.1, 0.1, 12, 0.2)
    const authorRun = run('Test', 0.1, 0.13, 10, 0.12)
    const titleRegion = {
      id: 'title-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: titleRun.text,
      confidence: 1,
      box: { ...titleRun },
      lines: [
        {
          id: 'title-line',
          text: titleRun.text,
          fontSize: titleRun.fontSize,
          box: { ...titleRun },
          runs: [{ ...titleRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const authorRegion = {
      id: 'author-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: authorRun.text,
      confidence: 1,
      box: { ...authorRun },
      lines: [
        {
          id: 'author-line',
          text: authorRun.text,
          fontSize: authorRun.fontSize,
          box: { ...authorRun },
          runs: [{ ...authorRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const captionRegion = fixture.regions.find(
      (region) => region.id === 'caption-region',
    )!
    const equationRegion = fixture.regions.find(
      (region) => region.id === 'equation-region',
    )!
    const nonReadingEquationRegion = {
      ...equationRegion,
      includedInReadingOrder: false,
    } satisfies PdfPageRegion
    const readingOrder = {
      ...fixture.readingOrder,
      regionIds: [titleRegion.id, authorRegion.id, captionRegion.id],
      order: [titleRegion.id, authorRegion.id, captionRegion.id],
      evaluation: {
        ...fixture.readingOrder.evaluation,
        regionCount: 3,
      },
    } satisfies PdfReadingOrderGraph
    const page = {
      ...fixture.page,
      textCharacters:
        fixture.page.textCharacters +
        titleRun.text.length +
        authorRun.text.length,
      runs: [titleRun, authorRun, ...fixture.page.runs],
    } satisfies PdfPageAnalysis
    const titleEvidence = {
      confidence: 1,
      pages: [1],
      regionIds: [titleRegion.id],
      boxes: [{ ...titleRegion.box }],
      links: [],
    } satisfies NodeSourceEvidence
    const regions = [
      titleRegion,
      authorRegion,
      captionRegion,
      nonReadingEquationRegion,
    ]
    const paperFor = (
      objectType: 'figure' | 'table' | 'equation',
    ): ResearchPaper => ({
      ...fixture.paper,
      nodes: [
        {
          id: 'title-node',
          type: 'paragraph',
          text: fixture.paper.title,
          source: 'test',
        },
        ...fixture.paper.nodes.map((node) =>
          node.type === 'figure'
            ? {
                ...node,
                objectType,
                ...(objectType === 'table'
                  ? {
                      table: {
                        rows: [
                          {
                            cells: [
                              {
                                text: 'q',
                                headerScope: 'column' as const,
                                columnSpan: 1,
                                rowSpan: 1,
                              },
                              {
                                text: '=',
                                headerScope: 'column' as const,
                                columnSpan: 1,
                                rowSpan: 1,
                              },
                            ],
                          },
                          {
                            cells: [
                              {
                                text: 'r',
                                headerScope: null,
                                columnSpan: 1,
                                rowSpan: 1,
                              },
                              {
                                text: '.',
                                headerScope: null,
                                columnSpan: 1,
                                rowSpan: 1,
                              },
                            ],
                          },
                        ],
                      },
                    }
                  : {}),
              }
            : node,
        ),
      ],
    })
    const provenance = {
      ...fixture.provenance,
      'title-node': titleEvidence,
    } satisfies Record<string, NodeSourceEvidence>
    const semanticTableBytes = new TextEncoder().encode(
      '<table><tr><th>q</th><th>=</th></tr><tr><td>r</td><td>.</td></tr></table>',
    )
    const semanticTableSha256 = createHash('sha256')
      .update(semanticTableBytes)
      .digest('hex')
    const semanticTableAsset = {
      ...fixture.asset,
      id: `asset-${semanticTableSha256.slice(0, 24)}`,
      href: `assets/asset-${semanticTableSha256.slice(0, 24)}.xhtml`,
      mediaType: 'application/xhtml+xml',
      kind: 'table',
      rendition: 'semantic-table',
      sha256: semanticTableSha256,
      bytes: semanticTableBytes,
    } satisfies PdfVisualAsset

    // This fixture has one equation source run, so treating it as a fabricated
    // 2×2 semantic table must no longer count as source conservation. Genuine
    // source-run-backed tables are covered by semantic-table-source.test.ts.
    for (const objectType of ['figure', 'equation'] as const) {
      const selectedAsset = fixture.asset
      const selectedPaper = paperFor(objectType)
      const visualNode = selectedPaper.nodes.find(
        (node) => node.type === 'figure',
      )
      if (visualNode?.type !== 'figure') throw new Error('missing visual node')
      visualNode.relationships.assets = [selectedAsset.id]
      const result = assessPdfCompleteness({
        pages: [page],
        paper: selectedPaper,
        diagnostics: [],
        regions,
        readingOrder,
        provenance,
        visualRelationships: [
          {
            ...fixture.relationship,
            kind: objectType,
            assetIds: [selectedAsset.id],
          },
        ],
        assets: [selectedAsset],
      })

      expect(result.completeness, objectType).toMatchObject({
        sourceTextCharacters:
          normalizedLength(titleRegion.text) +
          normalizedLength(authorRegion.text) +
          normalizedLength(captionRegion.text) +
          normalizedLength(nonReadingEquationRegion.text),
        outputTextCharacters:
          normalizedLength(titleRegion.text) +
          normalizedLength(authorRegion.text) +
          normalizedLength(captionRegion.text) +
          normalizedLength(nonReadingEquationRegion.text),
        matchedTextCharacters:
          normalizedLength(titleRegion.text) +
          normalizedLength(authorRegion.text) +
          normalizedLength(captionRegion.text) +
          normalizedLength(nonReadingEquationRegion.text),
        textCoverage: 1,
        missingSourceRegionCount: 0,
        unprovenancedRenderedUnitCount: 0,
      })
    }

    const invalidRelationship = {
      ...fixture.relationship,
      sourceRegionIds: ['absent-visual-region'],
    } satisfies PdfVisualRelationship
    const invalid = assessPdfCompleteness({
      pages: [page],
      paper: paperFor('equation'),
      diagnostics: [],
      regions,
      readingOrder,
      provenance: {
        ...provenance,
        'equation-1': {
          ...fixture.provenance['equation-1'],
          regionIds: ['absent-visual-region'],
        },
      },
      visualRelationships: [invalidRelationship],
      assets: [fixture.asset],
    })
    expect(invalid.completeness.unprovenancedRenderedUnitCount).toBe(1)
    expect(invalid.completeness.textCoverage).toBeLessThan(1)

    const paragraphPaper = {
      ...fixture.paper,
      nodes: [
        {
          id: 'title-node',
          type: 'paragraph',
          text: fixture.paper.title,
          source: 'test',
        },
        {
          id: 'non-reading-paragraph',
          type: 'paragraph',
          text: equationRegion.text,
          source: 'test',
        },
        fixture.paper.nodes.find((node) => node.type === 'caption')!,
      ],
    } satisfies ResearchPaper
    const paragraph = assessPdfCompleteness({
      pages: [page],
      paper: paragraphPaper,
      diagnostics: [],
      regions,
      readingOrder,
      provenance: {
        'title-node': titleEvidence,
        'non-reading-paragraph': fixture.provenance['equation-1'],
        'caption-1': fixture.provenance['caption-1'],
      },
    })
    expect(paragraph.completeness.unprovenancedRenderedUnitCount).toBe(0)
    expect(paragraph.completeness.outputTextCharacters).toBeGreaterThan(
      paragraph.completeness.sourceTextCharacters,
    )
    expect(paragraph.completeness.textCoverage).toBeLessThan(1)
  })

  it('conserves reordered text only for an exclusive strict positional visual', () => {
    const captionRun = run('Figure 1. Positional labels.', 0.2, 0.5, 10, 0.45)
    const alphaRun = run('alpha', 0.2, 0.25, 10, 0.08)
    const betaRun = run('beta', 0.55, 0.25, 10, 0.07)
    const region = (
      id: string,
      kind: PdfPageRegion['kind'],
      sourceRun: PdfSourceRun,
    ) =>
      ({
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
      }) satisfies PdfPageRegion
    const alphaRegion = region('alpha-region', 'body', alphaRun)
    const betaRegion = {
      ...region('beta-region', 'body', betaRun),
      includedInReadingOrder: false,
    } satisfies PdfPageRegion
    const captionRegion = region('caption-region', 'caption', captionRun)
    const objectBox = {
      page: 1,
      x: 0.18,
      y: 0.2,
      width: 0.5,
      height: 0.22,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const bytes = new TextEncoder().encode('POSITIONAL-SOURCE')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const asset = {
      id: `asset-${sha256.slice(0, 24)}`,
      href: `assets/asset-${sha256.slice(0, 24)}.png`,
      mediaType: 'image/png',
      kind: 'raster',
      rendition: 'source-preserved',
      sha256,
      bytes,
      width: 200,
      height: 100,
      resolutionDpi: null,
      sourceObjectIds: ['image-object'],
      sourceBoxes: [{ ...objectBox }],
    } satisfies PdfVisualAsset
    const relationship = {
      id: 'relationship-1',
      kind: 'figure',
      label: 'Figure 1',
      captionRegionId: captionRegion.id,
      sourceRegionIds: [alphaRegion.id, betaRegion.id],
      sourceObjectIds: ['image-object'],
      assetIds: [asset.id],
      status: 'matched',
      confidence: 1,
      evidence: ['source-preserved'],
      candidates: [],
      sourceBoxes: [{ ...captionRegion.box }, { ...objectBox }],
      sourceText: 'beta alpha',
      altText: captionRegion.text,
      altTextSource: 'caption',
      canonicalNodeId: 'figure-1',
      captionNodeId: 'caption-1',
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
          id: 'figure-1',
          type: 'figure',
          objectType: 'figure',
          title: 'Figure 1',
          relationships: { caption: 'caption-1', assets: [asset.id] },
          source: 'test',
        },
        {
          id: 'caption-1',
          type: 'caption',
          text: captionRegion.text,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const page = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters:
        alphaRun.text.length + betaRun.text.length + captionRun.text.length,
      imageCount: 1,
      objects: [
        {
          id: 'image-object',
          page: 1,
          kind: 'image',
          box: { ...objectBox },
          confidence: 1,
          assetId: asset.id,
        },
      ],
      runs: [alphaRun, betaRun, captionRun],
    } satisfies PdfPageAnalysis
    const readingOrder = {
      schemaVersion: '1.0.0',
      regionIds: [alphaRegion.id, captionRegion.id],
      order: [alphaRegion.id, captionRegion.id],
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
    const provenance = {
      'figure-1': {
        confidence: 1,
        pages: [1],
        regionIds: [...relationship.sourceRegionIds],
        boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
        links: [],
      },
      'caption-1': {
        confidence: 1,
        pages: [1],
        regionIds: [captionRegion.id],
        boxes: [{ ...captionRegion.box }],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>
    const assess = (sourceText: string) =>
      assessPdfCompleteness({
        pages: [page],
        paper,
        diagnostics: [],
        regions: [alphaRegion, betaRegion, captionRegion],
        readingOrder,
        provenance,
        visualRelationships: [{ ...relationship, sourceText }],
        assets: [asset],
      })

    const reordered = assess('beta alpha')
    expect(reordered.completeness).toMatchObject({
      matchedTextCharacters: reordered.completeness.sourceTextCharacters,
      outputTextCharacters: reordered.completeness.sourceTextCharacters,
      textCoverage: 1,
    })
    for (const lossy of [
      assess('beta alph'),
      assess('beta alphaa'),
      assess('beta alphx'),
    ]) {
      expect(lossy.completeness.textCoverage).toBeLessThan(1)
    }

    const semanticBytes = new TextEncoder().encode(
      '<table><tr><th>beta</th><th>.</th></tr><tr><td>alpha</td><td>.</td></tr></table>',
    )
    const semanticSha256 = createHash('sha256')
      .update(semanticBytes)
      .digest('hex')
    const semanticAsset = {
      ...asset,
      id: `asset-${semanticSha256.slice(0, 24)}`,
      href: `assets/asset-${semanticSha256.slice(0, 24)}.xhtml`,
      mediaType: 'application/xhtml+xml',
      kind: 'table',
      rendition: 'semantic-table',
      sha256: semanticSha256,
      bytes: semanticBytes,
    } satisfies PdfVisualAsset
    const semanticRelationship = {
      ...relationship,
      kind: 'table',
      label: 'Table 1',
      assetIds: [semanticAsset.id],
    } satisfies PdfVisualRelationship
    const semanticPaper = {
      ...paper,
      nodes: paper.nodes.map((node) =>
        node.type === 'figure'
          ? {
              ...node,
              objectType: 'table' as const,
              table: {
                rows: [
                  {
                    cells: [
                      {
                        text: 'beta',
                        headerScope: 'column',
                        columnSpan: 1,
                        rowSpan: 1,
                      },
                      {
                        text: '.',
                        headerScope: 'column',
                        columnSpan: 1,
                        rowSpan: 1,
                      },
                    ],
                  },
                  {
                    cells: [
                      {
                        text: 'alpha',
                        headerScope: null,
                        columnSpan: 1,
                        rowSpan: 1,
                      },
                      {
                        text: '.',
                        headerScope: null,
                        columnSpan: 1,
                        rowSpan: 1,
                      },
                    ],
                  },
                ],
              },
              relationships: {
                ...node.relationships,
                assets: [semanticAsset.id],
              },
            }
          : node,
      ),
    } satisfies ResearchPaper
    expect(
      validatedPdfVisualRelationships({
        paper: semanticPaper,
        provenance,
        relationships: [semanticRelationship],
        assets: [semanticAsset],
        regions: [alphaRegion, betaRegion, captionRegion],
      }),
    ).toEqual([])
    const semanticResult = assessPdfCompleteness({
      pages: [page],
      paper: semanticPaper,
      diagnostics: [],
      regions: [alphaRegion, betaRegion, captionRegion],
      readingOrder,
      provenance,
      visualRelationships: [semanticRelationship],
      assets: [semanticAsset],
    })
    expect(semanticResult.completeness.textCoverage).toBeLessThan(1)
  })

  it('accounts a strict source-text equation only through its self-caption', () => {
    const fixture = sourceBackedEquationFixture()
    const equationRegion = fixture.regions.find(
      (region) => region.id === 'equation-region',
    )!
    const relationship = {
      ...fixture.relationship,
      captionRegionId: equationRegion.id,
      sourceRegionIds: [equationRegion.id],
      sourceBoxes: [
        { ...equationRegion.box },
        { ...fixture.asset.sourceBoxes[0] },
      ],
      altText: equationRegion.text,
      altTextSource: 'source-text',
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      title: '',
      authors: [],
      nodes: [
        fixture.paper.nodes.find((node) => node.type === 'figure')!,
        {
          id: 'caption-1',
          type: 'caption',
          text: equationRegion.text,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const provenance = {
      'equation-1': {
        confidence: 1,
        pages: [1],
        regionIds: [equationRegion.id],
        boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
        links: [],
      },
      'caption-1': {
        confidence: 1,
        pages: [1],
        regionIds: [equationRegion.id],
        boxes: [{ ...equationRegion.box }],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>
    const readingOrder = {
      ...fixture.readingOrder,
      regionIds: [equationRegion.id],
      order: [equationRegion.id],
      evaluation: {
        ...fixture.readingOrder.evaluation,
        regionCount: 1,
      },
    } satisfies PdfReadingOrderGraph
    const page = {
      ...fixture.page,
      textCharacters: equationRegion.text.length,
      runs: equationRegion.lines.flatMap((line) => line.runs),
    } satisfies PdfPageAnalysis

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: [equationRegion],
      readingOrder,
      provenance,
      visualRelationships: [relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness).toMatchObject({
      sourceTextCharacters: normalizedLength(equationRegion.text),
      outputTextCharacters: normalizedLength(equationRegion.text),
      matchedTextCharacters: normalizedLength(equationRegion.text),
      textCoverage: 1,
    })
  })

  it('does not compare a typed generated equation label with source glyph prose', () => {
    const fixture = sourceBackedEquationFixture()
    const equationRegion = fixture.regions.find(
      (region) => region.id === 'equation-region',
    )!
    const generatedLabel = 'Display equation p001-001'
    const relationship = {
      ...fixture.relationship,
      label: generatedLabel,
      captionRegionId: equationRegion.id,
      sourceRegionIds: [equationRegion.id],
      sourceBoxes: [
        { ...equationRegion.box },
        { ...fixture.asset.sourceBoxes[0] },
      ],
      altText: equationRegion.text,
      altTextSource: 'source-text',
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      title: '',
      authors: [],
      nodes: fixture.paper.nodes.map((node) =>
        node.id === relationship.captionNodeId
          ? { ...node, text: generatedLabel }
          : node.id === relationship.canonicalNodeId && node.type === 'figure'
            ? { ...node, title: generatedLabel }
            : node,
      ),
    } satisfies ResearchPaper
    const provenance = {
      ...fixture.provenance,
      'caption-1': {
        confidence: 1,
        pages: [1],
        regionIds: [equationRegion.id],
        boxes: [{ ...equationRegion.box }],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>
    const readingOrder = {
      ...fixture.readingOrder,
      regionIds: [equationRegion.id],
      order: [equationRegion.id],
      evaluation: {
        ...fixture.readingOrder.evaluation,
        regionCount: 1,
      },
    } satisfies PdfReadingOrderGraph
    const page = {
      ...fixture.page,
      textCharacters: equationRegion.text.length,
      runs: equationRegion.lines.flatMap((line) => line.runs),
    } satisfies PdfPageAnalysis

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: [equationRegion],
      readingOrder,
      provenance,
      visualRelationships: [relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness).toMatchObject({
      sourceTextCharacters: normalizedLength(equationRegion.text),
      outputTextCharacters: 0,
      matchedTextCharacters: 0,
      missingSourceRegionCount: 1,
      textCoverage: 0,
    })
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
  })

  it('connects every source region represented by a strict self-captioned equation', () => {
    const fixture = sourceBackedEquationFixture()
    const equationRegion = fixture.regions.find(
      (region) => region.id === 'equation-region',
    )!
    const scriptRun = run('2', 0.375, 0.292, 8, 0.012, 0.011)
    const scriptRegion = {
      id: 'equation-script-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: scriptRun.text,
      confidence: 1,
      box: { ...scriptRun },
      lines: [
        {
          id: 'equation-script-line',
          text: scriptRun.text,
          fontSize: scriptRun.fontSize,
          box: { ...scriptRun },
          runs: [{ ...scriptRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const sourceText = `${equationRegion.text} ${scriptRegion.text}`
    const relationship = {
      ...fixture.relationship,
      captionRegionId: equationRegion.id,
      sourceRegionIds: [equationRegion.id, scriptRegion.id],
      sourceBoxes: [
        { ...equationRegion.box },
        { ...fixture.asset.sourceBoxes[0] },
      ],
      sourceText,
      altText: sourceText,
      altTextSource: 'source-text',
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      title: '',
      authors: [],
      nodes: [
        fixture.paper.nodes.find((node) => node.type === 'figure')!,
        {
          id: 'caption-1',
          type: 'caption',
          text: sourceText,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const provenance = {
      'equation-1': {
        confidence: 1,
        pages: [1],
        regionIds: [equationRegion.id, scriptRegion.id],
        boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
        links: [],
      },
      'caption-1': {
        confidence: 1,
        pages: [1],
        regionIds: [equationRegion.id],
        boxes: [{ ...equationRegion.box }],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>
    const readingOrder = {
      ...fixture.readingOrder,
      regionIds: [equationRegion.id, scriptRegion.id],
      order: [equationRegion.id, scriptRegion.id],
      evaluation: {
        ...fixture.readingOrder.evaluation,
        regionCount: 2,
      },
    } satisfies PdfReadingOrderGraph
    const page = {
      ...fixture.page,
      textCharacters: equationRegion.text.length + scriptRegion.text.length,
      runs: [...equationRegion.lines.flatMap((line) => line.runs), scriptRun],
    } satisfies PdfPageAnalysis

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: [equationRegion, scriptRegion],
      readingOrder,
      provenance,
      visualRelationships: [relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness).toMatchObject({
      sourceTextCharacters: normalizedLength(sourceText),
      outputTextCharacters: normalizedLength(sourceText),
      matchedTextCharacters: normalizedLength(sourceText),
      textCoverage: 1,
      missingSourceRegionCount: 0,
    })
  })

  it('counts typed semantic-table cells as represented source text', () => {
    const runs = [
      run('Profile', 0.1, 0.26, 9, 0.12),
      run('Nodes', 0.3, 0.26, 9, 0.08),
      run('Mobile', 0.1, 0.3, 9, 0.12),
      run('12', 0.3, 0.3, 9, 0.04),
      run('Table 1. Synthetic values.', 0.1, 0.2, 10, 0.42),
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
          id: 'table-1',
          type: 'figure',
          objectType: 'table',
          title: 'Table 1',
          table: {
            rows: [
              {
                cells: [
                  {
                    text: 'Profile',
                    headerScope: 'column',
                    columnSpan: 1,
                    rowSpan: 1,
                  },
                  {
                    text: 'Nodes',
                    headerScope: 'column',
                    columnSpan: 1,
                    rowSpan: 1,
                  },
                ],
              },
              {
                cells: [
                  {
                    text: 'Mobile',
                    headerScope: null,
                    columnSpan: 1,
                    rowSpan: 1,
                  },
                  {
                    text: '12',
                    headerScope: null,
                    columnSpan: 1,
                    rowSpan: 1,
                  },
                ],
              },
            ],
          },
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
        {
          id: 'caption-1',
          type: 'caption',
          text: 'Table 1. Synthetic values.',
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
      matchedTextCharacters: result.completeness.sourceTextCharacters,
      textCoverage: 1,
    })
  })

  it('rejects WRONG visual bytes even when asset metadata and lineage still claim a match', () => {
    const fixture = sourceBackedEquationFixture()
    const input = {
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
    }
    const valid = assessPdfCompleteness({
      ...input,
      assets: [fixture.asset],
    })
    const tampered = assessPdfCompleteness({
      ...input,
      assets: [
        {
          ...fixture.asset,
          bytes: new TextEncoder().encode('WRONG'),
        },
      ],
    })

    expect(valid.completeness).toMatchObject({
      assetCoverage: 1,
      relationshipCoverage: 1,
      unresolvedObjectCount: 0,
    })
    expect(tampered.completeness.textCoverage).toBeLessThan(
      valid.completeness.textCoverage,
    )
    expect(tampered.completeness).toMatchObject({
      assetCoverage: 0,
      relationshipCoverage: 0,
    })
    expect(tampered.readiness.ready).toBe(false)
  })

  it('does not resolve a matched equation crop whose semantic transcript is unresolved or empty', () => {
    const fixture = sourceBackedEquationFixture()
    const unresolvedEvidence = assessSourceBackedEquation(fixture, {
      relationship: {
        evidence: [
          ...fixture.relationship.evidence,
          'source-text-transcript-unresolved',
        ],
      },
    })
    const emptyTranscript = assessSourceBackedEquation(fixture, {
      relationship: {
        sourceText: '',
        altText: fixture.relationship.label,
        altTextSource: 'caption',
      },
    })

    for (const result of [unresolvedEvidence, emptyTranscript]) {
      expect(result.completeness).toMatchObject({
        assetCoverage: 1,
        missingSourceRegionCount: 0,
        resolvedRelationshipCount: 0,
        relationshipCoverage: 0,
        unresolvedObjects: { equations: 1 },
      })
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'UNRESOLVED_EQUATION_TRANSCRIPT',
            severity: 'error',
            relationshipId: fixture.relationship.id,
          }),
        ]),
      )
      expect(result.readiness).toMatchObject({
        ready: false,
        blockingDiagnosticCodes: expect.arrayContaining([
          'UNRESOLVED_EQUATION_TRANSCRIPT',
        ]),
      })
    }
  })

  it('counts a verified script-only geometry transcript without accepting flat source text', async () => {
    const fixture = sourceBackedEquationFixture()
    const equationRegion = fixture.regions[1]
    const regionBox = {
      ...equationRegion.box,
      x: 0.25,
      y: 0.29,
      width: 0.14,
      height: 0.045,
    }
    const runs = [
      {
        ...regionBox,
        text: 'q',
        x: 0.27,
        y: 0.305,
        width: 0.01,
        height: 0.014,
        fontName: 'Synthetic-CMMI10',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...regionBox,
        text: '2',
        x: 0.281,
        y: 0.296,
        width: 0.006,
        height: 0.007,
        fontName: 'Synthetic-CMMI8',
        fontSize: 7,
        confidence: 1,
      },
      {
        ...regionBox,
        text: '=',
        x: 0.292,
        y: 0.305,
        width: 0.008,
        height: 0.014,
        fontName: 'Synthetic-CMSY10',
        fontSize: 10,
        confidence: 1,
      },
      {
        ...regionBox,
        text: 'r',
        x: 0.306,
        y: 0.305,
        width: 0.01,
        height: 0.014,
        fontName: 'Synthetic-CMMI10',
        fontSize: 10,
        confidence: 1,
      },
    ] satisfies PdfSourceRun[]
    equationRegion.text = 'q2=r'
    equationRegion.box = regionBox
    equationRegion.lines = [
      {
        id: 'equation-region-line',
        text: equationRegion.text,
        fontSize: 10,
        box: { ...regionBox },
        runs,
      },
    ]
    const objectBox = { ...regionBox, method: 'pdf-object' as const }
    const asset = await createSourcePageCropAsset({
      kind: 'equation',
      cropBox: {
        page: 1,
        x: 0.23,
        y: 0.27,
        width: 0.2,
        height: 0.09,
        rotation: 0,
        method: 'pdf-object',
      },
      sourceObjectIds: ['equation-object'],
      sourceBoxes: [objectBox],
      width: 80,
      height: 32,
      pixels: new Uint8Array(80 * 32 * 4).fill(72),
    })
    const relationship: PdfVisualRelationship = {
      ...fixture.relationship,
      sourceRegionIds: [equationRegion.id],
      sourceLineIds: [equationRegion.lines[0].id],
      sourceObjectIds: ['equation-object'],
      assetIds: [asset.id],
      evidence: [
        'source-page-crop',
        SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
      ],
      sourceBoxes: [{ ...fixture.regions[0].box }, objectBox],
      sourceText: '',
      altTextSource: 'caption',
    }
    relationship.equationGeometryTranscript =
      createSourceGeometryScriptTranscript({
        sourceRegionIds: relationship.sourceRegionIds,
        sourceLineIds: relationship.sourceLineIds!,
        sourceObjectIds: relationship.sourceObjectIds,
        regions: fixture.regions,
        sourceCropAsset: asset,
      })!
    fixture.paper.nodes = fixture.paper.nodes.map((node) =>
      node.type === 'figure'
        ? {
            ...node,
            relationships: {
              ...node.relationships,
              assets: [asset.id],
            },
          }
        : node,
    )
    fixture.page.runs = [fixture.regions[0].lines[0].runs[0], ...runs]
    fixture.page.textCharacters = fixture.page.runs.reduce(
      (total, item) => total + item.text.length,
      0,
    )
    fixture.page.objects![0] = {
      ...fixture.page.objects![0],
      box: objectBox,
      assetId: asset.id,
    }
    fixture.provenance['equation-1'] = {
      ...fixture.provenance['equation-1'],
      boxes: [{ ...fixture.regions[0].box }, { ...objectBox }],
    }

    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [relationship],
      assets: [asset],
    })

    expect(relationship.sourceText).toBe('')
    expect(relationship.equationGeometryTranscript).not.toBeNull()
    expect(result.completeness).toMatchObject({
      resolvedRelationshipCount: 1,
      relationshipCoverage: 1,
      unresolvedObjects: { equations: 0 },
    })
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'UNRESOLVED_EQUATION_TRANSCRIPT',
    )
  })

  it('blocks readiness when an exact algorithm crop has no proved semantic line transcript', () => {
    const fixture = sourceBackedEquationFixture()
    fixture.regions[0].text = 'Algorithm 1 Deterministic Search'
    fixture.regions[0].lines[0].text = fixture.regions[0].text
    fixture.regions[0].lines[0].runs[0].text = fixture.regions[0].text
    fixture.regions[1].kind = 'body'
    fixture.regions[1].text =
      'Require: graph G 1: Initialize queue. 2: Visit node. 3: return result.'
    fixture.regions[1].lines[0].text = fixture.regions[1].text
    fixture.regions[1].lines[0].runs[0].text = fixture.regions[1].text
    const relationship = {
      ...fixture.relationship,
      kind: 'figure',
      semanticKind: 'algorithm',
      label: 'Algorithm 1',
      sourceText: '',
      evidence: [
        'source-algorithm-block',
        'source-page-crop',
        'source-text-transcript-unresolved',
      ],
      altText: fixture.regions[0].text,
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      nodes: fixture.paper.nodes.map((node) =>
        node.type === 'figure'
          ? {
              ...node,
              objectType: 'figure' as const,
              title: relationship.altText,
            }
          : node.type === 'caption'
            ? { ...node, text: relationship.altText }
            : node,
      ),
    } satisfies ResearchPaper
    const page = {
      ...fixture.page,
      textCharacters: fixture.regions.reduce(
        (total, region) => total + region.text.length,
        0,
      ),
      runs: fixture.regions.flatMap((region) =>
        region.lines.flatMap((line) => line.runs),
      ),
    } satisfies PdfPageAnalysis

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness).toMatchObject({
      assetCoverage: 1,
      missingSourceRegionCount: 0,
      relationshipCoverage: 1,
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_ALGORITHM_TRANSCRIPT',
          severity: 'error',
          relationshipId: relationship.id,
          target: expect.objectContaining({
            regionIds: relationship.sourceRegionIds,
          }),
        }),
      ]),
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNRESOLVED_ALGORITHM_TRANSCRIPT',
      ]),
    })
  })

  it('blocks readiness when a preformatted crop has no exact ordered-line transcript', () => {
    const fixture = sourceBackedEquationFixture()
    fixture.regions[0].text = 'Theorems and Tactics'
    fixture.regions[0].lines[0].text = fixture.regions[0].text
    fixture.regions[0].lines[0].runs[0].text = fixture.regions[0].text
    fixture.regions[1].kind = 'body'
    fixture.regions[1].text = '" state_after " : " 2 goals \\ n⊢ -π < π / 2 "'
    fixture.regions[1].lines[0].text = fixture.regions[1].text
    fixture.regions[1].lines[0].runs[0].text = fixture.regions[1].text
    const relationship = {
      ...fixture.relationship,
      kind: 'figure',
      semanticKind: 'code',
      label: 'Code block p001-001',
      sourceText: '',
      preformatted: {
        status: 'unresolved',
        lines: [],
        evidence: [
          'deterministic-source-line-order',
          'source-text-exactness-unresolved',
        ],
      },
      evidence: [
        'source-preformatted-block',
        'source-page-crop',
        'source-text-transcript-unresolved',
      ],
      altText: 'Source code block',
    } as unknown as PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      nodes: fixture.paper.nodes.map((node) =>
        node.type === 'figure'
          ? {
              ...node,
              objectType: 'figure' as const,
              title: relationship.altText,
            }
          : node.type === 'caption'
            ? { ...node, text: relationship.altText }
            : node,
      ),
    } satisfies ResearchPaper
    const page = {
      ...fixture.page,
      textCharacters: fixture.regions.reduce(
        (total, region) => total + region.text.length,
        0,
      ),
      runs: fixture.regions.flatMap((region) =>
        region.lines.flatMap((line) => line.runs),
      ),
    } satisfies PdfPageAnalysis

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness).toMatchObject({
      assetCoverage: 1,
      missingSourceRegionCount: 0,
      relationshipCoverage: 1,
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_PREFORMATTED_TRANSCRIPT',
          severity: 'error',
          relationshipId: relationship.id,
          target: expect.objectContaining({
            regionIds: relationship.sourceRegionIds,
          }),
        }),
      ]),
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNRESOLVED_PREFORMATTED_TRANSCRIPT',
      ]),
    })
  })

  it('counts every detected equation relationship whose transcript remains unresolved', () => {
    const fixture = sourceBackedEquationFixture()
    const relationships = Array.from({ length: 3 }, (_, index) => ({
      ...fixture.relationship,
      id: `relationship-${index + 1}`,
      label: `Equation ${index + 1}`,
      evidence: [
        ...fixture.relationship.evidence,
        'source-text-transcript-unresolved',
      ],
    })) satisfies PdfVisualRelationship[]

    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: relationships,
      assets: [fixture.asset],
    })

    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNRESOLVED_EQUATION_TRANSCRIPT',
      ),
    ).toHaveLength(3)
    expect(result.semanticSignals.equations).toBe(3)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 3,
      resolvedRelationshipCount: 0,
      unresolvedObjects: { equations: 3 },
    })
  })

  it('uses unique atomic equation relationships instead of prose Eq references when the graph is defined', () => {
    const fixture = sourceBackedEquationFixture()
    const references = [
      run('See Eq. 1 for the source relationship.', 0.1, 0.5),
      run('Equation 1 is referenced again in prose.', 0.1, 0.55),
    ]
    fixture.page.runs.push(...references)
    fixture.page.textCharacters += references.reduce(
      (total, sourceRun) => total + sourceRun.text.length,
      0,
    )

    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(result.semanticSignals.equations).toBe(1)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 1,
      resolvedRelationshipCount: 1,
      unresolvedObjects: { equations: 0 },
    })
  })

  it('keeps source-proved display equations that a partial visual graph missed', () => {
    const fixture = sourceBackedEquationFixture()
    const sourceRegion = fixture.regions.find(
      (region) => region.kind === 'equation',
    )
    expect(sourceRegion).toBeDefined()
    if (!sourceRegion) throw new Error('missing source equation region')
    const missedRegions = [2, 3].map((number, index) => {
      const sourceLine = sourceRegion.lines[0]
      const text = `q${number} = r`
      const box = {
        ...sourceRegion.box,
        y: sourceRegion.box.y + (index + 1) * 0.08,
      }
      return {
        ...sourceRegion,
        id: `missed-equation-region-${number}`,
        text,
        box,
        lines: [
          {
            ...sourceLine,
            id: `missed-equation-line-${number}`,
            text,
            box,
            runs: [{ ...sourceLine.runs[0], ...box, text }],
          },
        ],
        nativeObjectIds: [],
      } satisfies PdfPageRegion
    })

    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: [...fixture.regions, ...missedRegions],
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(result.semanticSignals.equations).toBe(3)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 3,
      resolvedRelationshipCount: 1,
      unresolvedObjects: { equations: 2 },
    })
    expect(result.readiness.ready).toBe(false)
  })

  it('retains raw equation-reference detection when no visual graph is defined', () => {
    const fixture = sourceBackedEquationFixture()
    const references = [
      run('See Eq. 1 for the source relationship.', 0.1, 0.5),
      run('Equation 1 is referenced again in prose.', 0.1, 0.55),
    ]
    fixture.page.runs.push(...references)
    fixture.page.textCharacters += references.reduce(
      (total, sourceRun) => total + sourceRun.text.length,
      0,
    )

    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
    })

    expect(result.semanticSignals.equations).toBe(3)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 3,
      resolvedRelationshipCount: 0,
      unresolvedObjects: { equations: 3 },
    })
  })

  it('retains raw equation obligations when production supplies an empty visual graph', () => {
    const fixture = sourceBackedEquationFixture()
    const references = [
      run('See Eq. 1 for the source relationship.', 0.1, 0.5),
      run('Equation 1 is referenced again in prose.', 0.1, 0.55),
    ]
    fixture.page.runs.push(...references)
    fixture.page.textCharacters += references.reduce(
      (total, sourceRun) => total + sourceRun.text.length,
      0,
    )

    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [],
      assets: [],
    })

    expect(result.semanticSignals.equations).toBe(3)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 3,
      resolvedRelationshipCount: 0,
      unresolvedObjects: { equations: 3 },
    })
    expect(result.readiness.ready).toBe(false)
  })

  it('does not resolve a nonempty equation transcript that omits a selected source line', () => {
    const fixture = sourceBackedEquationFixture()
    const continuationRun = run('+ s', 0.25, 0.325, 14, 0.06)
    const equationRegion = fixture.regions[1]
    equationRegion.text = `${equationRegion.text} ${continuationRun.text}`
    equationRegion.lines.push({
      id: 'equation-region-line-continuation',
      text: continuationRun.text,
      fontSize: continuationRun.fontSize,
      box: { ...continuationRun },
      runs: [{ ...continuationRun }],
    })
    fixture.page.runs.push(continuationRun)
    fixture.page.textCharacters += continuationRun.text.length

    const partialTranscript = assessSourceBackedEquation(fixture, {
      relationship: {
        sourceLineIds: equationRegion.lines.map((line) => line.id),
        sourceText: 'q = r',
      },
    })

    expect(partialTranscript.completeness).toMatchObject({
      resolvedRelationshipCount: 0,
      relationshipCoverage: 0,
      unresolvedObjects: { equations: 1 },
    })
    expect(partialTranscript.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_EQUATION_TRANSCRIPT',
          severity: 'error',
          relationshipId: fixture.relationship.id,
        }),
      ]),
    )
  })

  it('does not accept a producer-declared subset of a multi-line equation region', () => {
    const fixture = sourceBackedEquationFixture()
    const continuationRun = run('+ s', 0.25, 0.325, 14, 0.06)
    const equationRegion = fixture.regions[1]
    equationRegion.text = `${equationRegion.text} ${continuationRun.text}`
    equationRegion.lines.push({
      id: 'equation-region-line-continuation',
      text: continuationRun.text,
      fontSize: continuationRun.fontSize,
      box: { ...continuationRun },
      runs: [{ ...continuationRun }],
    })
    fixture.page.runs.push(continuationRun)
    fixture.page.textCharacters += continuationRun.text.length

    const producerSubset = assessSourceBackedEquation(fixture, {
      relationship: {
        sourceLineIds: [equationRegion.lines[0].id],
        sourceText: equationRegion.lines[0].text,
      },
    })

    expect(producerSubset.completeness).toMatchObject({
      resolvedRelationshipCount: 0,
      relationshipCoverage: 0,
      unresolvedObjects: { equations: 1 },
    })
    expect(producerSubset.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_EQUATION_TRANSCRIPT',
    )
  })

  it('does not accept a transcript that omits an adjacent equation source region', () => {
    const fixture = sourceBackedEquationFixture()
    const omittedRun = run('+ s', 0.25, 0.325, 14, 0.06)
    const omittedRegion = {
      id: 'omitted-equation-region',
      page: 1,
      kind: 'equation',
      column: 'single',
      text: omittedRun.text,
      confidence: 1,
      box: { ...omittedRun },
      lines: [
        {
          id: 'omitted-equation-line',
          text: omittedRun.text,
          fontSize: omittedRun.fontSize,
          box: { ...omittedRun },
          runs: [{ ...omittedRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    fixture.regions.push(omittedRegion)
    fixture.page.runs.push(omittedRun)
    fixture.page.textCharacters += omittedRun.text.length

    const missingAssociatedRegion = assessSourceBackedEquation(fixture)

    expect(missingAssociatedRegion.completeness.resolvedRelationshipCount).toBe(
      0,
    )
    expect(missingAssociatedRegion.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_EQUATION_TRANSCRIPT',
    )
  })

  it('rejects a flattened transcript for unproved two-dimensional script geometry', () => {
    const fixture = sourceBackedEquationFixture()
    const equationRegion = fixture.regions[1]
    const baseline = run('q', 0.25, 0.3, 14, 0.03, 0.018)
    baseline.fontName = 'Synthetic-Math-Regular'
    const superscript = run('2', 0.28, 0.291, 8, 0.012, 0.01)
    superscript.fontName = 'Synthetic-Math-Regular'
    const remainder = run(' = r', 0.298, 0.3, 14, 0.07, 0.018)
    remainder.fontName = 'Synthetic-Math-Regular'
    equationRegion.text = 'q2 = r'
    equationRegion.lines[0] = {
      ...equationRegion.lines[0],
      text: equationRegion.text,
      runs: [baseline, superscript, remainder],
    }
    fixture.page.runs = [
      ...fixture.regions[0].lines[0].runs,
      baseline,
      superscript,
      remainder,
    ]
    fixture.page.textCharacters =
      fixture.regions[0].text.length + equationRegion.text.length

    const result = assessSourceBackedEquation(fixture, {
      relationship: {
        sourceText: equationRegion.text,
        altText: equationRegion.text,
        altTextSource: 'source-text',
      },
    })

    expect(result.completeness).toMatchObject({
      resolvedRelationshipCount: 0,
      relationshipCoverage: 0,
      unresolvedObjects: { equations: 1 },
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_EQUATION_TRANSCRIPT',
          severity: 'error',
          relationshipId: fixture.relationship.id,
        }),
      ]),
    )
  })

  it('does not accept a transcript that omits an overlapping equation object', () => {
    const fixture = sourceBackedEquationFixture()
    const equationRegion = fixture.regions[1]
    const objectBox = {
      ...equationRegion.box,
      method: 'pdf-object' as const,
    }
    fixture.regions.push({
      id: 'omitted-equation-object-region',
      page: 1,
      kind: 'figure',
      column: 'single',
      text: '',
      confidence: 1,
      box: objectBox,
      lines: [],
      nativeObjectIds: ['omitted-equation-object'],
      includedInReadingOrder: true,
    })
    fixture.page.objects ??= []
    fixture.page.objects.push({
      id: 'omitted-equation-object',
      page: 1,
      kind: 'image',
      box: objectBox,
      confidence: 1,
      assetId: 'omitted-equation-object-asset',
    })
    fixture.page.imageCount += 1

    const missingAssociatedObject = assessSourceBackedEquation(fixture)

    expect(missingAssociatedObject.completeness.resolvedRelationshipCount).toBe(
      0,
    )
    expect(missingAssociatedObject.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_EQUATION_TRANSCRIPT',
    )
  })

  it('fails equation transcript completeness closed without an exact source-line ledger', () => {
    const fixture = sourceBackedEquationFixture()
    const missingLineLedger = assessSourceBackedEquation(fixture, {
      relationship: { sourceLineIds: undefined },
    })
    const unknownLine = assessSourceBackedEquation(fixture, {
      relationship: { sourceLineIds: ['missing-equation-source-line'] },
    })

    for (const result of [missingLineLedger, unknownLine]) {
      expect(result.completeness).toMatchObject({
        resolvedRelationshipCount: 0,
        relationshipCoverage: 0,
        unresolvedObjects: { equations: 1 },
      })
      expect(result.readiness).toMatchObject({
        ready: false,
        blockingDiagnosticCodes: expect.arrayContaining([
          'UNRESOLVED_EQUATION_TRANSCRIPT',
        ]),
      })
    }
  })

  it('requires OCR evidence for a mixed raster page with only sparse embedded text', () => {
    const fixture = sourceBackedEquationFixture()
    const result = assessPdfCompleteness({
      pages: [
        {
          ...fixture.page,
          kind: 'mixed',
          imageCount: fixture.page.imageCount + 1,
          ocr: undefined,
        },
      ],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness.ocrRequiredPages).toEqual([1])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'OCR_REQUIRED',
          severity: 'error',
          page: 1,
        }),
      ]),
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
      blockingDiagnosticCodes: expect.arrayContaining(['OCR_REQUIRED']),
    })
  })

  it('requires substantive internally valid OCR evidence for mixed and OCR-complete pages', () => {
    const fixture = sourceBackedEquationFixture()
    const evidence = {
      engine: 'local-engine',
      engineVersion: '1.0.0',
      model: 'local-model',
      modelVersion: '1.0.0',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: 'a'.repeat(64),
      rasterSha256: 'b'.repeat(64),
      confidence: 1,
      words: [],
      lines: [],
    } satisfies NonNullable<PdfPageAnalysis['ocr']>
    const invalidPages: PdfPageAnalysis[] = [
      {
        ...fixture.page,
        kind: 'mixed',
        imageCount: fixture.page.imageCount + 1,
        ocr: evidence,
      },
      {
        ...fixture.page,
        kind: 'ocr-complete',
        imageCount: fixture.page.imageCount + 1,
        ocr: undefined,
      },
      {
        ...fixture.page,
        kind: 'mixed',
        imageCount: fixture.page.imageCount + 1,
        ocr: { ...evidence, sourceSha256: 'not-a-sha256' },
      },
      {
        ...fixture.page,
        kind: 'mixed',
        imageCount: fixture.page.imageCount + 1,
        ocr: { ...evidence, sourceSha256: 'c'.repeat(64) },
      },
    ]

    for (const page of invalidPages) {
      const result = assessPdfCompleteness({
        pages: [page],
        paper: fixture.paper,
        diagnostics: [],
        regions: fixture.regions,
        readingOrder: fixture.readingOrder,
        provenance: fixture.provenance,
        visualRelationships: [fixture.relationship],
        assets: [fixture.asset],
        sourceSha256: 'a'.repeat(64),
      })

      expect(result.completeness.ocrRequiredPages).toEqual([1])
      expect(result.readiness.blockingDiagnosticCodes).toContain('OCR_REQUIRED')
    }
  })

  it('accepts page-bound recovered OCR content with matching source identity', () => {
    const fixture = sourceBackedEquationFixture()
    const acceptedRun = {
      ...run('Recovered', 0.2, 0.5, 10, 0.2),
      method: 'ocr' as const,
      fontName: 'OCR',
    }
    const ocr = {
      engine: 'local-engine',
      engineVersion: '1.0.0',
      model: 'local-model',
      modelVersion: '1.0.0',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: 'a'.repeat(64),
      rasterSha256: 'b'.repeat(64),
      confidence: 1,
      words: [
        {
          text: acceptedRun.text,
          confidence: 1,
          lineId: 'ocr-line-1',
          box: { ...acceptedRun },
          mergeStatus: 'accepted',
        },
      ],
      lines: [
        {
          id: 'ocr-line-1',
          text: acceptedRun.text,
          confidence: 1,
          box: { ...acceptedRun },
        },
      ],
    } satisfies NonNullable<PdfPageAnalysis['ocr']>
    const result = assessPdfCompleteness({
      pages: [
        {
          ...fixture.page,
          kind: 'mixed',
          imageCount: fixture.page.imageCount + 1,
          runs: [...fixture.page.runs, acceptedRun],
          ocr,
        },
      ],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
      sourceSha256: 'a'.repeat(64),
    })

    expect(result.completeness.ocrRequiredPages).toEqual([])
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'OCR_REQUIRED',
    )
  })

  it('accepts source-matched duplicate-only OCR confirmation for an embedded-only sparse page', () => {
    const fixture = sourceBackedEquationFixture()
    const embeddedRun = fixture.page.runs[0]
    const duplicateBox = {
      page: embeddedRun.page,
      x: embeddedRun.x,
      y: embeddedRun.y,
      width: embeddedRun.width,
      height: embeddedRun.height,
      rotation: embeddedRun.rotation,
      method: 'ocr' as const,
    }
    const result = assessPdfCompleteness({
      pages: [
        {
          ...fixture.page,
          kind: 'ocr-complete',
          imageCount: 0,
          objects: [],
          textCharacters: embeddedRun.text.replace(/\s/gu, '').length,
          runs: [embeddedRun],
          ocr: {
            engine: 'local-engine',
            engineVersion: '1.0.0',
            model: 'local-model',
            modelVersion: '1.0.0',
            languages: ['eng'],
            languageMode: 'explicit',
            sourceSha256: 'a'.repeat(64),
            rasterSha256: 'b'.repeat(64),
            confidence: 0.99,
            words: [
              {
                text: embeddedRun.text,
                confidence: 0.99,
                lineId: 'ocr-line-1',
                box: duplicateBox,
                mergeStatus: 'duplicate',
              },
            ],
            lines: [],
          },
        },
      ],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
      sourceSha256: 'a'.repeat(64),
    })

    expect(result.completeness.ocrRequiredPages).toEqual([])
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'OCR_REQUIRED',
    )
  })

  it('rejects duplicate-only OCR evidence that is not embedded-only and source-matched', () => {
    const fixture = sourceBackedEquationFixture()
    const embeddedRun = fixture.page.runs[0]
    const duplicateEvidence = {
      engine: 'local-engine',
      engineVersion: '1.0.0',
      model: 'local-model',
      modelVersion: '1.0.0',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: 'a'.repeat(64),
      rasterSha256: 'b'.repeat(64),
      confidence: 0.99,
      words: [
        {
          text: embeddedRun.text,
          confidence: 0.99,
          lineId: 'ocr-line-1',
          box: {
            page: embeddedRun.page,
            x: embeddedRun.x,
            y: embeddedRun.y,
            width: embeddedRun.width,
            height: embeddedRun.height,
            rotation: embeddedRun.rotation,
            method: 'ocr' as const,
          },
          mergeStatus: 'duplicate' as const,
        },
      ],
      lines: [],
    } satisfies NonNullable<PdfPageAnalysis['ocr']>
    const basePage = {
      ...fixture.page,
      kind: 'ocr-complete',
      imageCount: 0,
      objects: [],
      textCharacters: embeddedRun.text.replace(/\s/gu, '').length,
      runs: [embeddedRun],
      ocr: duplicateEvidence,
    } satisfies PdfPageAnalysis
    const invalidPages: PdfPageAnalysis[] = [
      {
        ...basePage,
        imageCount: 1,
        objects: fixture.page.objects,
      },
      {
        ...basePage,
        ocr: {
          ...duplicateEvidence,
          words: [
            {
              ...duplicateEvidence.words[0],
              text: 'Fabricated text',
            },
          ],
        },
      },
      {
        ...basePage,
        ocr: {
          ...duplicateEvidence,
          words: [
            {
              ...duplicateEvidence.words[0],
              box: {
                ...duplicateEvidence.words[0].box,
                x: 0.75,
              },
            },
          ],
        },
      },
      {
        ...basePage,
        ocr: {
          ...duplicateEvidence,
          sourceSha256: 'c'.repeat(64),
        },
      },
    ]

    for (const page of invalidPages) {
      const result = assessPdfCompleteness({
        pages: [page],
        paper: fixture.paper,
        diagnostics: [],
        regions: fixture.regions,
        readingOrder: fixture.readingOrder,
        provenance: fixture.provenance,
        visualRelationships: [fixture.relationship],
        assets: [fixture.asset],
        sourceSha256: 'a'.repeat(64),
      })

      expect(result.completeness.ocrRequiredPages).toEqual([1])
      expect(result.readiness.blockingDiagnosticCodes).toContain('OCR_REQUIRED')
    }
  })

  it('requires accepted OCR words to be page-bound and present in recovered runs', () => {
    const fixture = sourceBackedEquationFixture()
    const acceptedBox = {
      page: 1,
      x: 0.2,
      y: 0.5,
      width: 0.2,
      height: 0.02,
      rotation: 0,
      method: 'ocr' as const,
    }
    const evidence = {
      engine: 'local-engine',
      engineVersion: '1.0.0',
      model: 'local-model',
      modelVersion: '1.0.0',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: 'a'.repeat(64),
      rasterSha256: 'b'.repeat(64),
      confidence: 1,
      words: [
        {
          text: 'Recovered',
          confidence: 1,
          lineId: 'ocr-line-1',
          box: acceptedBox,
          mergeStatus: 'accepted',
        },
      ],
      lines: [
        {
          id: 'ocr-line-1',
          text: 'Recovered',
          confidence: 1,
          box: acceptedBox,
        },
      ],
    } satisfies NonNullable<PdfPageAnalysis['ocr']>
    const missingRecoveredRun = {
      ...fixture.page,
      kind: 'mixed',
      imageCount: fixture.page.imageCount + 1,
      ocr: evidence,
    } satisfies PdfPageAnalysis
    const outOfBounds = {
      ...fixture.page,
      kind: 'mixed',
      imageCount: fixture.page.imageCount + 1,
      runs: [
        ...fixture.page.runs,
        {
          ...fixture.page.runs[0],
          text: 'Recovered',
          method: 'ocr',
          x: 1.1,
          y: 0.5,
          width: 0.2,
          height: 0.02,
        },
      ],
      ocr: {
        ...evidence,
        words: [
          {
            ...evidence.words[0],
            box: { ...acceptedBox, x: 1.1 },
          },
        ],
        lines: [
          {
            ...evidence.lines[0],
            box: { ...acceptedBox, x: 1.1 },
          },
        ],
      },
    } satisfies PdfPageAnalysis

    for (const page of [missingRecoveredRun, outOfBounds]) {
      const result = assessPdfCompleteness({
        pages: [page],
        paper: fixture.paper,
        diagnostics: [],
        regions: fixture.regions,
        readingOrder: fixture.readingOrder,
        provenance: fixture.provenance,
        visualRelationships: [fixture.relationship],
        assets: [fixture.asset],
      })

      expect(result.completeness.ocrRequiredPages).toEqual([1])
      expect(result.readiness.blockingDiagnosticCodes).toContain('OCR_REQUIRED')
    }
  })

  it('does not require OCR when every mixed-page object is a validated semantic visual', () => {
    const fixture = sourceBackedEquationFixture()
    const result = assessPdfCompleteness({
      pages: [{ ...fixture.page, kind: 'mixed', ocr: undefined }],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness.ocrRequiredPages).toEqual([])
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'OCR_REQUIRED',
    )
  })

  it('counts hundreds of native primitives in one claimed visual as one semantic obligation', async () => {
    const fixture = sourceBackedEquationFixture()
    const sourceObjectIds = Array.from(
      { length: 400 },
      (_, index) => `figure-fragment-${index + 1}`,
    )
    const sourceBoxes = sourceObjectIds.map((_, index) => ({
      page: 1,
      x: 0.2 + (index % 20) * 0.012,
      y: 0.3 + Math.floor(index / 20) * 0.005,
      width: 0.012,
      height: 0.005,
      rotation: 0,
      method: 'pdf-object' as const,
    }))
    const cropBox = {
      page: 1,
      x: 0.19,
      y: 0.29,
      width: 0.26,
      height: 0.12,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const pixels = new Uint8Array(8 * 8 * 4).fill(255)
    for (const pixel of [9, 18, 27, 36]) {
      pixels.fill(0, pixel * 4, pixel * 4 + 3)
      pixels[pixel * 4 + 3] = 255
    }
    const asset = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox,
      sourceObjectIds,
      sourceBoxes,
      width: 8,
      height: 8,
      pixels,
    })
    const captionNode = fixture.paper.nodes.find(
      (node) => node.type === 'caption',
    )!
    const paper = {
      ...fixture.paper,
      nodes: [
        {
          id: 'figure-1',
          type: 'figure',
          objectType: 'figure',
          title: 'Figure 1',
          relationships: { caption: captionNode.id, assets: [asset.id] },
          source: 'test',
        },
        captionNode,
      ],
    } satisfies ResearchPaper
    const relationship = {
      ...fixture.relationship,
      kind: 'figure',
      label: 'Figure 1',
      sourceRegionIds: ['figure-region'],
      sourceObjectIds,
      assetIds: [asset.id],
      sourceBoxes: [fixture.relationship.sourceBoxes[0], ...sourceBoxes],
      sourceText: '',
      canonicalNodeId: 'figure-1',
    } satisfies PdfVisualRelationship
    const page = {
      ...fixture.page,
      imageCount: 0,
      objects: sourceObjectIds.map((id, index) => ({
        id,
        page: 1,
        kind: 'vector' as const,
        box: sourceBoxes[index],
        confidence: 1,
        assetId: asset.id,
      })),
    } satisfies PdfPageAnalysis
    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: {
        ...fixture.provenance,
        'figure-1': {
          confidence: 1,
          pages: [1],
          regionIds: ['figure-region'],
          boxes: relationship.sourceBoxes,
          links: [],
        },
      },
      visualRelationships: [relationship],
      assets: [asset],
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 1,
      exportedAssetCount: 1,
      assetCoverage: 1,
    })
  })

  it('counts multi-asset relationship components separately from unique validated assets', () => {
    const fixture = sourceBackedEquationFixture()
    const secondBytes = new TextEncoder().encode('SECOND-SOURCE-FRAGMENT')
    const secondSha256 = createHash('sha256').update(secondBytes).digest('hex')
    const secondAssetId = `asset-${secondSha256.slice(0, 24)}`
    const secondBox = {
      page: 1,
      x: 0.39,
      y: 0.3,
      width: 0.12,
      height: 0.018,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const secondAsset = {
      ...fixture.asset,
      id: secondAssetId,
      href: `assets/${secondAssetId}.png`,
      sha256: secondSha256,
      bytes: secondBytes,
      sourceObjectIds: ['equation-object-2'],
      sourceBoxes: [secondBox],
    } satisfies PdfVisualAsset
    const relationship = {
      ...fixture.relationship,
      kind: 'figure',
      sourceObjectIds: ['equation-object', 'equation-object-2'],
      assetIds: [fixture.asset.id, secondAsset.id],
      sourceBoxes: [
        fixture.relationship.sourceBoxes[0],
        fixture.asset.sourceBoxes[0],
        secondBox,
      ],
      sourceText: '',
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      nodes: fixture.paper.nodes.map((node) =>
        node.type === 'figure'
          ? {
              ...node,
              objectType: 'figure' as const,
              relationships: {
                ...node.relationships,
                assets: [fixture.asset.id, secondAsset.id],
              },
            }
          : node,
      ),
    } satisfies ResearchPaper
    const result = assessPdfCompleteness({
      pages: [
        {
          ...fixture.page,
          objects: [
            ...fixture.page.objects!,
            {
              id: 'equation-object-2',
              page: 1,
              kind: 'image',
              box: secondBox,
              confidence: 1,
              assetId: secondAsset.id,
            },
          ],
        },
      ],
      paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: {
        ...fixture.provenance,
        'equation-1': {
          ...fixture.provenance['equation-1'],
          boxes: relationship.sourceBoxes,
        },
      },
      visualRelationships: [relationship],
      assets: [fixture.asset, secondAsset],
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 2,
      exportedAssetCount: 2,
      assetCoverage: 1,
    })
  })

  it('counts a shared content-addressed asset once for each validated relationship component', () => {
    const fixture = sourceBackedEquationFixture()
    const firstCaptionRegion = fixture.regions[0]
    const secondCaptionRun = run(
      'Figure 2. Reused source glyph.',
      0.2,
      0.4,
      10,
      0.4,
    )
    const secondCaptionRegion = {
      ...firstCaptionRegion,
      id: 'caption-region-2',
      text: secondCaptionRun.text,
      box: { ...secondCaptionRun },
      lines: [
        {
          ...firstCaptionRegion.lines[0],
          id: 'caption-region-2-line',
          text: secondCaptionRun.text,
          box: { ...secondCaptionRun },
          runs: [{ ...secondCaptionRun }],
        },
      ],
    } satisfies PdfPageRegion
    const firstRelationship = {
      ...fixture.relationship,
      kind: 'figure',
      label: 'Figure 1',
      sourceRegionIds: [],
      sourceLineIds: [],
      canonicalNodeId: 'figure-1',
    } satisfies PdfVisualRelationship
    const secondRelationship = {
      ...firstRelationship,
      id: 'relationship-2',
      label: 'Figure 2',
      captionRegionId: secondCaptionRegion.id,
      sourceBoxes: [
        { ...secondCaptionRegion.box },
        { ...fixture.asset.sourceBoxes[0] },
      ],
      canonicalNodeId: 'figure-2',
      captionNodeId: 'caption-2',
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      nodes: [
        {
          id: 'figure-1',
          type: 'figure',
          objectType: 'figure',
          title: 'Figure 1',
          relationships: {
            caption: 'caption-1',
            assets: [fixture.asset.id],
          },
          source: 'test',
        },
        fixture.paper.nodes.find((node) => node.id === 'caption-1')!,
        {
          id: 'figure-2',
          type: 'figure',
          objectType: 'figure',
          title: 'Figure 2',
          relationships: {
            caption: 'caption-2',
            assets: [fixture.asset.id],
          },
          source: 'test',
        },
        {
          id: 'caption-2',
          type: 'caption',
          text: secondCaptionRun.text,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const provenance = {
      'figure-1': {
        confidence: 1,
        pages: [1],
        regionIds: [],
        boxes: firstRelationship.sourceBoxes.map((box) => ({ ...box })),
        links: [],
      },
      'caption-1': fixture.provenance['caption-1'],
      'figure-2': {
        confidence: 1,
        pages: [1],
        regionIds: [],
        boxes: secondRelationship.sourceBoxes.map((box) => ({ ...box })),
        links: [],
      },
      'caption-2': {
        confidence: 1,
        pages: [1],
        regionIds: [secondCaptionRegion.id],
        boxes: [{ ...secondCaptionRegion.box }],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>
    const relationships = [firstRelationship, secondRelationship]

    expect(
      validatedPdfVisualRelationships({
        paper,
        provenance,
        relationships,
        assets: [fixture.asset],
        regions: [firstCaptionRegion, secondCaptionRegion],
      }),
    ).toHaveLength(2)

    const result = assessPdfCompleteness({
      pages: [
        {
          ...fixture.page,
          textCharacters:
            firstCaptionRegion.text.length + secondCaptionRegion.text.length,
          runs: [
            ...firstCaptionRegion.lines[0].runs,
            ...secondCaptionRegion.lines[0].runs,
          ],
        },
      ],
      paper,
      diagnostics: [],
      regions: [firstCaptionRegion, secondCaptionRegion],
      provenance,
      visualRelationships: relationships,
      assets: [fixture.asset],
      canonicalHyphenBoundaryDecisions: [],
      canonicalHyphenBoundaryDecisionCount: 0,
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 2,
      exportedAssetCount: 2,
      assetCoverage: 1,
    })
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'INCOMPLETE_ASSET_COVERAGE',
    )
  })

  it('keeps every authoritative unresolved or ambiguous visual relationship blocking', () => {
    const fixture = sourceBackedEquationFixture()

    for (const status of ['unresolved', 'ambiguous'] as const) {
      const result = assessPdfCompleteness({
        pages: [fixture.page],
        paper: fixture.paper,
        diagnostics: [],
        regions: fixture.regions,
        readingOrder: fixture.readingOrder,
        provenance: fixture.provenance,
        visualRelationships: [{ ...fixture.relationship, status }],
        assets: [fixture.asset],
      })

      expect(result.completeness).toMatchObject({
        sourceAssetCount: 1,
        exportedAssetCount: 0,
        assetCoverage: 0,
      })
      expect(result.readiness.ready).toBe(false)
      expect(result.readiness.blockingDiagnosticCodes).toContain(
        'INCOMPLETE_ASSET_COVERAGE',
      )
    }
  })

  it('keeps raw unreferenced PDF object inventory out of semantic obligation counts', () => {
    const boxes = [
      { x: 0.2, y: 0.2, width: 0.08, height: 0.08 },
      { x: 0.28, y: 0.2, width: 0.08, height: 0.08 },
      { x: 0.2, y: 0.28, width: 0.08, height: 0.08 },
      { x: 0.28, y: 0.28, width: 0.08, height: 0.08 },
      { x: 0.7, y: 0.7, width: 0.08, height: 0.08 },
    ].map((box) => ({
      page: 1,
      ...box,
      rotation: 0,
      method: 'pdf-object' as const,
    }))
    const page = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 0,
      imageCount: 0,
      objects: boxes.map((box, index) => ({
        id: `vector-${index + 1}`,
        page: 1,
        kind: 'vector' as const,
        box,
        confidence: 1,
        assetId: null,
      })),
      runs: [],
    } satisfies PdfPageAnalysis
    const paper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [],
    } satisfies ResearchPaper

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: boxes.map((box) => ({
        code: 'UNREFERENCED_VISUAL_ASSET' as const,
        severity: 'error' as const,
        page: 1,
        message: 'Unreferenced source visual.',
        sourceBoxes: [box],
        target: { regionIds: [], markerId: null },
      })),
      visualRelationships: [],
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 0,
      exportedAssetCount: 0,
      assetCoverage: 1,
    })
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNREFERENCED_VISUAL_ASSET',
    )
  })

  it('rejects a coordinated asset id that is not bound to its content digest', () => {
    const fixture = sourceBackedEquationFixture()
    const id = `asset-${'f'.repeat(24)}`
    const asset = {
      ...fixture.asset,
      id,
      href: `assets/${id}.png`,
    } satisfies PdfVisualAsset

    const result = assessSourceBackedEquation(fixture, { asset })

    expect(result.completeness.assetCoverage).toBeLessThan(1)
    expect(result.completeness.relationshipCoverage).toBe(0)
  })

  it('rejects bounded fallbacks and invalid raster/vector media pairs', () => {
    const fixture = sourceBackedEquationFixture()
    const svgBytes = new TextEncoder().encode('<svg><text>q = r</text></svg>')
    const invalidPair = equationAssetWithPayload(fixture, {
      bytes: svgBytes,
      mediaType: 'image/svg+xml',
      kind: 'raster',
      rendition: 'source-preserved',
    })
    const boundedFallback = equationAssetWithPayload(fixture, {
      bytes: svgBytes,
      mediaType: 'image/svg+xml',
      kind: 'equation',
      rendition: 'bounded-svg-fallback',
    })

    for (const asset of [invalidPair, boundedFallback]) {
      const result = assessSourceBackedEquation(fixture, { asset })
      expect(result.completeness.assetCoverage).toBeLessThan(1)
      expect(result.completeness.relationshipCoverage).toBe(0)
    }
  })

  it('rejects coordinated source-region and caption-provenance contradictions', () => {
    const fixture = sourceBackedEquationFixture()
    const emptySourceRegions = assessSourceBackedEquation(fixture, {
      relationship: { sourceRegionIds: [] },
      provenance: {
        ...fixture.provenance,
        'equation-1': {
          ...fixture.provenance['equation-1'],
          regionIds: [],
        },
      },
    })
    const wrongCaptionPage = assessSourceBackedEquation(fixture, {
      provenance: {
        ...fixture.provenance,
        'caption-1': {
          ...fixture.provenance['caption-1'],
          pages: [2],
        },
      },
    })

    for (const result of [emptySourceRegions, wrongCaptionPage]) {
      expect(result.completeness.assetCoverage).toBeLessThan(1)
      expect(result.completeness.relationshipCoverage).toBe(0)
    }
  })

  it('rejects visual source regions already rendered as canonical prose', () => {
    const fixture = sourceBackedEquationFixture()
    const paper = {
      ...fixture.paper,
      nodes: [
        ...fixture.paper.nodes,
        {
          id: 'duplicate-prose',
          type: 'paragraph',
          text: fixture.relationship.sourceText,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const result = assessPdfCompleteness({
      pages: [fixture.page],
      paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: {
        ...fixture.provenance,
        'duplicate-prose': {
          confidence: 1,
          pages: [1],
          regionIds: [...fixture.relationship.sourceRegionIds],
          boxes: [fixture.relationship.sourceBoxes[1]],
          links: [],
        },
      },
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 1,
      exportedAssetCount: 0,
      assetCoverage: 0,
      resolvedRelationshipCount: 0,
    })
    expect(result.readiness.ready).toBe(false)
  })

  it('does not count a text-derived bounded SVG as source-backed visual text', () => {
    const runs = [run('q = r', 0.25, 0.3, 14, 0.12)]
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
          id: 'equation-1',
          type: 'figure',
          objectType: 'equation',
          title: 'Equation 1',
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
      ],
    }
    const relationship = {
      id: 'relationship-1',
      kind: 'equation',
      label: 'Equation 1',
      captionRegionId: 'caption-region',
      sourceRegionIds: ['equation-region'],
      sourceObjectIds: ['equation-object'],
      assetIds: ['equation-asset'],
      status: 'matched',
      confidence: 1,
      evidence: ['source-equation-region'],
      candidates: [],
      sourceBoxes: [
        {
          page: 1,
          x: 0.25,
          y: 0.3,
          width: 0.12,
          height: 0.018,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      sourceText: 'q = r',
      altText: 'Equation 1. Synthetic fallback.',
      altTextSource: 'caption',
      canonicalNodeId: 'equation-1',
      captionNodeId: null,
    } satisfies PdfVisualRelationship

    const metadataOnly = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      visualRelationships: [relationship],
    })
    const asset = {
      id: 'equation-asset',
      href: 'assets/equation.svg',
      mediaType: 'image/svg+xml',
      kind: 'equation',
      rendition: 'bounded-svg-fallback',
      sha256: 'a'.repeat(64),
      bytes: new TextEncoder().encode('<svg><text>q = r</text></svg>'),
      width: 120,
      height: 30,
      resolutionDpi: null,
      sourceObjectIds: ['equation-object'],
      sourceBoxes: [relationship.sourceBoxes[0]],
    } satisfies PdfVisualAsset
    const matched = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      visualRelationships: [relationship],
      assets: [asset],
    })
    const unresolved = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      visualRelationships: [
        {
          ...relationship,
          status: 'unresolved',
          sourceRegionIds: [],
          sourceObjectIds: [],
          assetIds: [],
          canonicalNodeId: null,
        },
      ],
    })

    expect(metadataOnly.completeness.textCoverage).toBeLessThan(1)
    expect(matched.completeness.textCoverage).toBe(
      metadataOnly.completeness.textCoverage,
    )
    expect(matched.completeness.assetCoverage).toBe(0)
    expect(matched.completeness.relationshipCoverage).toBe(0)
    expect(unresolved.completeness.textCoverage).toBeLessThan(1)
  })

  it('does not count a repeated glyph from a bounded SVG approximation', () => {
    const runs = [
      run('Visible z.', 0.1, 0.2, 10, 0.18),
      run('z', 0.3, 0.3, 14, 0.02),
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
          text: 'Visible z.',
          source: 'test',
        },
        {
          id: 'visual-1',
          type: 'figure',
          objectType: 'equation',
          title: 'Formula 1',
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
      ],
    }
    const relationship = {
      id: 'relationship-1',
      kind: 'equation',
      label: 'Formula 1',
      captionRegionId: 'caption-region',
      sourceRegionIds: ['equation-region'],
      sourceObjectIds: ['equation-object'],
      assetIds: ['equation-asset'],
      status: 'matched',
      confidence: 1,
      evidence: ['source-equation-region'],
      candidates: [],
      sourceBoxes: [
        {
          page: 1,
          x: 0.3,
          y: 0.3,
          width: 0.02,
          height: 0.018,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      sourceText: 'z',
      altText: 'Formula 1.',
      altTextSource: 'caption',
      canonicalNodeId: 'visual-1',
      captionNodeId: null,
    } satisfies PdfVisualRelationship

    const asset = {
      id: 'equation-asset',
      href: 'assets/repeated-glyph.svg',
      mediaType: 'image/svg+xml',
      kind: 'equation',
      rendition: 'bounded-svg-fallback',
      sha256: 'b'.repeat(64),
      bytes: new TextEncoder().encode('<svg><text>z</text></svg>'),
      width: 20,
      height: 20,
      resolutionDpi: null,
      sourceObjectIds: ['equation-object'],
      sourceBoxes: [relationship.sourceBoxes[0]],
    } satisfies PdfVisualAsset

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      visualRelationships: [relationship],
      assets: [asset],
    })

    expect(result.completeness.textCoverage).toBeLessThan(1)
  })

  it('does not infer a semantic obligation from raw image-operator counts alone', () => {
    const runs = [
      run('Recovered text remains incomplete without its image.', 0.1, 0.2),
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs[0].text.length,
      imageCount: 1,
      objects: [],
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
          text: runs[0].text,
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      canonicalHyphenBoundaryDecisions: [],
      canonicalHyphenBoundaryDecisionCount: 0,
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 0,
      exportedAssetCount: 0,
      assetCoverage: 1,
    })
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNREFERENCED_VISUAL_ASSET',
    )
  })

  it('joins visually aligned runs in source order before matching signals', () => {
    const runs = [
      run('1. Split caption text', 0.165, 0.2015),
      run('Figure', 0.1, 0.2),
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
      imageCount: 1,
      runs,
    }

    expect(detectPdfSemanticSignals([page])).toMatchObject({ captions: 1 })
  })

  it('counts figure obligations only from proven caption regions when regions are supplied', () => {
    const figureCaption = run('Figure 1. Proven caption.', 0.1, 0.2, 9, 0.4)
    const incidentalText = run(
      'Figure: is used as body prose here.',
      0.1,
      0.3,
      10,
      0.5,
    )
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: figureCaption.text.length + incidentalText.text.length,
      imageCount: 1,
      runs: [figureCaption, incidentalText],
    }
    const captionRegion: PdfPageRegion = {
      id: 'figure-caption',
      page: 1,
      kind: 'caption',
      column: 'single',
      text: figureCaption.text,
      confidence: 1,
      box: { ...figureCaption },
      lines: [
        {
          id: 'figure-caption-line',
          text: figureCaption.text,
          fontSize: figureCaption.fontSize,
          box: { ...figureCaption },
          runs: [{ ...figureCaption }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }
    const bodyRegion: PdfPageRegion = {
      ...captionRegion,
      id: 'incidental-body',
      kind: 'body',
      text: incidentalText.text,
      box: { ...incidentalText },
      lines: [
        {
          id: 'incidental-body-line',
          text: incidentalText.text,
          fontSize: incidentalText.fontSize,
          box: { ...incidentalText },
          runs: [{ ...incidentalText }],
        },
      ],
    }

    expect(
      detectPdfSemanticSignals([page], [captionRegion, bodyRegion]),
    ).toMatchObject({
      captions: 1,
    })
  })

  it('keeps a proven caption-region obligation when the printed label is unparseable', () => {
    const sourceRun = run(
      'Figure: Explicit caption with unresolved numbering.',
      0.1,
      0.2,
      9,
      0.5,
    )
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: sourceRun.text.length,
      imageCount: 1,
      runs: [sourceRun],
    }
    const captionRegion: PdfPageRegion = {
      id: 'unparseable-figure-caption',
      page: 1,
      kind: 'caption',
      column: 'single',
      text: sourceRun.text,
      confidence: 1,
      box: { ...sourceRun },
      lines: [
        {
          id: 'unparseable-figure-caption-line',
          text: sourceRun.text,
          fontSize: sourceRun.fontSize,
          box: { ...sourceRun },
          runs: [{ ...sourceRun }],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }

    expect(detectPdfSemanticSignals([page], [captionRegion])).toMatchObject({
      captions: 1,
    })
  })

  it('does not count table cross-references in ordinary body regions as table obligations', () => {
    const runs = [
      run('Table 1 shows the primary result.', 0.1, 0.2, 10, 0.5),
      run('Table 2 compares the ablations.', 0.1, 0.24, 10, 0.5),
      run('Table III reports the error bands.', 0.1, 0.28, 10, 0.5),
      run('Table IV summarizes prior work.', 0.1, 0.32, 10, 0.5),
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
    const regions = runs.map(
      (sourceRun, index) =>
        ({
          id: `body-${index + 1}`,
          page: 1,
          kind: 'body',
          column: 'single',
          text: sourceRun.text,
          confidence: 1,
          box: { ...sourceRun },
          lines: [
            {
              id: `body-line-${index + 1}`,
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

    expect(detectPdfSemanticSignals([page], regions)).toMatchObject({
      tables: 0,
    })
  })

  it('counts ordinary, supplementary, and compound table captions only with caption-region proof', () => {
    const runs = [
      run('Table 5. Numeric source caption.', 0.1, 0.2, 9, 0.5),
      run('Table VI. Roman source caption.', 0.1, 0.3, 9, 0.5),
      run('Table S2. Supplementary source caption.', 0.1, 0.4, 9, 0.5),
      run('Table A.1. Dotted source caption.', 0.1, 0.5, 9, 0.5),
      run('Table B-2. Hyphenated source caption.', 0.1, 0.6, 9, 0.5),
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
    const regions = runs.map(
      (sourceRun, index) =>
        ({
          id: `caption-${index + 1}`,
          page: 1,
          kind: 'caption',
          column: 'single',
          text: sourceRun.text,
          confidence: 1,
          box: { ...sourceRun },
          lines: [
            {
              id: `caption-line-${index + 1}`,
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

    expect(detectPdfSemanticSignals([page], regions)).toMatchObject({
      tables: 5,
    })
  })

  it('does not count duplicate links to one caption as separate relationships', () => {
    const runs = [run('Figure 1. Shared caption', 0.1, 0.2)]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs[0].text.length,
      imageCount: 2,
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
          id: 'caption-1',
          type: 'caption',
          text: 'Figure 1. Shared caption',
          source: 'test',
        },
        {
          id: 'figure-1',
          type: 'figure',
          title: 'First image',
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
        {
          id: 'figure-2',
          type: 'figure',
          title: 'Second image',
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
      ],
    }

    expect(
      assessPdfCompleteness({ pages: [page], paper, diagnostics: [] })
        .completeness,
    ).toMatchObject({
      expectedRelationshipCount: 1,
      resolvedRelationshipCount: 1,
      relationshipCoverage: 1,
    })
  })

  it('keeps a genuinely unclaimed captioned image as a blocking semantic obligation', () => {
    const runs = [run('Figure 1. Source image', 0.1, 0.2)]
    const imageBox = {
      page: 1,
      x: 0.2,
      y: 0.3,
      width: 0.4,
      height: 0.3,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs[0].text.length,
      imageCount: 1,
      objects: [
        {
          id: 'unclaimed-captioned-image',
          page: 1,
          kind: 'image',
          box: imageBox,
          confidence: 1,
          assetId: null,
        },
      ],
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
          id: 'caption-1',
          type: 'caption',
          text: 'Figure 1. Source image',
          source: 'test',
        },
        {
          id: 'figure-1',
          type: 'figure',
          title: 'Placeholder only',
          relationships: { caption: 'caption-1' },
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
      sourceAssetCount: 1,
      exportedAssetCount: 0,
      assetCoverage: 0,
    })
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'INCOMPLETE_ASSET_COVERAGE',
    )
  })

  it('fails closed on Roman-numeral table captions', () => {
    const runs = [run('TABLE IV. Comparative results', 0.1, 0.2)]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs[0].text.length,
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
          text: runs[0].text,
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.semanticSignals.tables).toBe(1)
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_SEMANTIC_OBJECTS',
    )
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
