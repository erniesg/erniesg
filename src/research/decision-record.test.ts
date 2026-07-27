import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  applyHumanDecisionFile,
  createEquationTranscriptDecision,
  createHumanDecisionFile,
  createVisualMatchDecision,
  equationTranscriptDecisionBinding,
  humanDecisionFileSha256,
  MAX_EQUATION_TRANSCRIPT_LENGTH,
  MAX_HUMAN_DECISION_FILE_BYTES,
  parseHumanDecisionFile,
  readingOrderCandidates,
  serializeHumanDecisionFile,
  upsertHumanDecision,
} from './decision-record'
import { verifyEquationTranscriptAdjudication } from './equation-transcript-adjudication'
import {
  buildEpub,
  buildReadableEpub,
  inspectEpub,
  renderPublicationXhtml,
} from './epub'
import type {
  HumanAdjudicationRecord,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderGraph,
  PdfReconstruction,
  PdfSourceRun,
  PdfVisualMatchCandidate,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { pdfVisualMatchCandidateId } from './pdf-visuals'
import { reconstructPdf } from './pdf'
import { assessPdfCompleteness } from './pdf-quality'
import { internalReferenceIntegrityIssues } from './publication-integrity'
import { createSourcePageCropAsset } from './visual-assets'
import type { ResearchPaper } from './schema'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'

function run(
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
): PdfSourceRun {
  return {
    page: 1,
    text,
    x,
    y,
    width,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName: 'Body',
    fontSize,
    confidence: 1,
  }
}

function ambiguousReconstruction() {
  const runs = [
    run('Left candidate one.', 0.08, 0.2, 0.32),
    run('Right candidate one.', 0.55, 0.2, 0.32),
    run('Indented left candidate.', 0.18, 0.7, 0.22),
    run('Right candidate two.', 0.55, 0.7, 0.32),
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
  return reconstructPageAnalyses({
    pages: [page],
    sourceHash: 'a'.repeat(64),
    fileName: 'ambiguous.pdf',
    byteLength: 2048,
  })
}

async function unresolvedLineJoinReconstruction() {
  const runs = [
    run('This source contains a scenar-', 0.1, 0.2, 0.42),
    run('io that remains continuous prose.', 0.1, 0.225, 0.48),
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
  return reconstructPageAnalyses({
    pages: [page],
    sourceHash: '1'.repeat(64),
    fileName: 'unresolved-line-join.pdf',
    byteLength: 2048,
  })
}

function lineJoinDecision(
  base: Awaited<ReturnType<typeof unresolvedLineJoinReconstruction>>,
  outcome:
    'remove-wrap-hyphen' | 'preserve-authored-hyphen' | 'leave-unresolved',
) {
  const transition = base.lineBoundaryDecisions.find(
    (candidate) => candidate.outcome === 'unresolved',
  )!
  return {
    diagnosticCode: 'UNRESOLVED_CORRUPTING_JOIN',
    target: {
      regionIds: [transition.regionId],
      markerId: transition.id,
    },
    resolution: {
      type: 'resolve-line-join',
      transition: {
        id: transition.id,
        regionId: transition.regionId,
        fromLineId: transition.fromLineId,
        toLineId: transition.toLineId,
      },
      outcome,
      confidence: 1,
      evidence: ['bounded-source-context', 'owner-local-adjudication'],
    },
  } as unknown as HumanAdjudicationRecord
}

const SYNTHETIC_LATEX_TRANSCRIPT = String.raw`\operatorname{demo}(x^{2})<y \& z`

async function unresolvedEquationTranscriptReconstruction() {
  const base = await unresolvedLineJoinReconstruction()
  const captionRun = run(
    'Equation A. Synthetic adjudication fixture.',
    0.18,
    0.2,
    0.52,
  )
  const baseline = {
    ...run('x', 0.28, 0.3, 0.03, 14),
    fontName: 'Synthetic-Math-Regular',
  }
  const superscript = {
    ...run('2', 0.31, 0.288, 0.014, 8),
    height: 0.011,
    fontName: 'Synthetic-Math-Regular',
  }
  const remainder = {
    ...run(' = y', 0.33, 0.3, 0.08, 14),
    fontName: 'Synthetic-Math-Regular',
  }
  const captionRegion = {
    id: 'synthetic-equation-caption-region',
    page: 1,
    kind: 'caption',
    column: 'single',
    text: captionRun.text,
    confidence: 1,
    box: { ...captionRun },
    lines: [
      {
        id: 'synthetic-equation-caption-line',
        text: captionRun.text,
        fontSize: captionRun.fontSize,
        box: { ...captionRun },
        runs: [{ ...captionRun }],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const equationBox = {
    page: 1,
    x: 0.25,
    y: 0.275,
    width: 0.22,
    height: 0.075,
    rotation: 0,
    method: 'pdf-object' as const,
  }
  const syntheticEquationSourceObjectId = 'equation-source-p001-001'
  const equationRegion = {
    id: 'synthetic-equation-source-region',
    page: 1,
    kind: 'equation',
    column: 'single',
    text: 'x2 = y',
    confidence: 1,
    box: {
      page: 1,
      x: baseline.x,
      y: superscript.y,
      width: remainder.x + remainder.width - baseline.x,
      height: baseline.y + baseline.height - superscript.y,
      rotation: 0,
      method: 'pdf-text' as const,
    },
    lines: [
      {
        id: 'synthetic-equation-source-line',
        text: 'x2 = y',
        fontSize: baseline.fontSize,
        box: {
          page: 1,
          x: baseline.x,
          y: superscript.y,
          width: remainder.x + remainder.width - baseline.x,
          height: baseline.y + baseline.height - superscript.y,
          rotation: 0,
          method: 'pdf-text' as const,
        },
        runs: [baseline, superscript, remainder],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const cropBox = {
    page: 1,
    x: 0.2,
    y: 0.25,
    width: 0.36,
    height: 0.14,
    rotation: 0,
    method: 'pdf-object' as const,
  }
  const width = 32
  const height = 16
  const pixels = new Uint8Array(width * height * 4).fill(255)
  for (let y = 5; y < 11; y += 1) {
    for (let x = 7; x < 25; x += 1) {
      const index = (y * width + x) * 4
      pixels[index] = 0
      pixels[index + 1] = 0
      pixels[index + 2] = 0
    }
  }
  const asset = await createSourcePageCropAsset({
    kind: 'equation',
    cropBox,
    sourceObjectIds: [syntheticEquationSourceObjectId],
    sourceBoxes: [{ ...equationBox }],
    width,
    height,
    pixels,
    sourceExclusionMask: {
      algorithm: 'nearest-source-box-v1',
      expansionPixels: 2,
      ownedSourceBoxes: [{ ...equationBox }],
      excludedSourceBoxes: [
        {
          page: 1,
          x: 0.25,
          y: 0.244,
          width: 0.08,
          height: 0.004,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
    },
  })
  const relationship = {
    id: 'synthetic-equation-relationship',
    kind: 'equation',
    label: 'Equation A',
    captionRegionId: captionRegion.id,
    sourceRegionIds: [equationRegion.id],
    sourceLineIds: equationRegion.lines.map((line) => line.id),
    sourceObjectIds: [syntheticEquationSourceObjectId],
    assetIds: [asset.id],
    status: 'matched',
    confidence: 1,
    evidence: [
      'bounded-source-geometry',
      'source-page-crop-neighbor-bounded',
      'source-page-crop-unowned-text-masked',
      'source-page-crop',
      'source-text-transcript-unresolved',
    ],
    candidates: [],
    sourceBoxes: [{ ...captionRegion.box }, { ...equationBox }],
    sourceText: '',
    altText: captionRegion.text,
    altTextSource: 'caption',
    canonicalNodeId: 'synthetic-equation-node',
    captionNodeId: 'synthetic-equation-caption-node',
  } satisfies PdfVisualRelationship
  const paper: ResearchPaper = {
    ...base.paper,
    id: 'synthetic-equation-paper',
    title: 'Synthetic equation decision fixture',
    subtitle: 'Owner-local adjudication test',
    abstract: 'Synthetic test content.',
    nodes: [
      {
        id: relationship.canonicalNodeId,
        type: 'figure',
        objectType: 'equation',
        title: relationship.label,
        relationships: {
          caption: relationship.captionNodeId,
          assets: [asset.id],
        },
        source: 'synthetic-equation-fixture',
      },
      {
        id: relationship.captionNodeId,
        type: 'caption',
        text: captionRegion.text,
        source: 'synthetic-equation-fixture',
      },
    ],
  }
  const page = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters:
      captionRun.text.length +
      baseline.text.length +
      superscript.text.length +
      remainder.text.length,
    imageCount: 0,
    objects: [],
    assets: [asset],
    runs: [captionRun, baseline, superscript, remainder],
  } satisfies PdfPageAnalysis
  const regions = [captionRegion, equationRegion]
  const readingOrder = {
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
  } satisfies PdfReadingOrderGraph
  const provenance = {
    [relationship.canonicalNodeId]: {
      confidence: 1,
      pages: [1],
      regionIds: [...relationship.sourceRegionIds],
      boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
      links: [],
    },
    [relationship.captionNodeId]: {
      confidence: 1,
      pages: [1],
      regionIds: [captionRegion.id],
      boxes: [{ ...captionRegion.box }],
      links: [],
    },
  }
  const assessment = assessPdfCompleteness({
    pages: [page],
    sourceSha256: base.source.sha256,
    paper,
    diagnostics: [],
    readingOrder,
    regions,
    visualRelationships: [relationship],
    assets: [asset],
    citationRelationships: [],
    noteRelationships: [],
    provenance,
    lineBoundaryDecisions: [],
    unresolvedCorruptingJoinCount: 0,
    structurallyConsumedLineBoundaryCount: 0,
    policy: base.readiness.policy,
  })
  const diagnostics = assessment.diagnostics.map((diagnostic) =>
    diagnostic.code === 'UNRESOLVED_EQUATION_TRANSCRIPT' &&
    diagnostic.relationshipId === relationship.id
      ? {
          ...diagnostic,
          target: {
            regionIds: [...relationship.sourceRegionIds],
            markerId: relationship.id,
          },
        }
      : diagnostic,
  )
  return {
    ...base,
    paper,
    pages: [page],
    regions,
    lineBoundaryDecisions: [],
    unresolvedCorruptingJoinCount: 0,
    structurallyConsumedLineBoundaryCount: 0,
    readingOrder,
    noteRelationships: [],
    citationRelationships: [],
    crossReferenceRelationships: [],
    visualRelationships: [relationship],
    assets: [asset],
    provenance,
    diagnostics,
    semanticSignals: assessment.semanticSignals,
    completeness: assessment.completeness,
    readiness: assessment.readiness,
  }
}

async function ambiguousVisualReconstruction() {
  const base =
    (await unresolvedEquationTranscriptReconstruction()) as PdfReconstruction
  const relationship: PdfVisualRelationship = base.visualRelationships[0]
  const canonicalNodeId = relationship.canonicalNodeId!
  base.paper.nodes = base.paper.nodes.filter(
    (node) => node.id !== canonicalNodeId,
  )
  delete base.provenance[canonicalNodeId]
  relationship.canonicalNodeId = null
  relationship.status = 'ambiguous'
  relationship.sourceText = 'x2 = y'
  relationship.altTextSource = 'source-text'
  const candidate: PdfVisualMatchCandidate = {
    sourceRegionIds: [...relationship.sourceRegionIds],
    sourceObjectIds: [...relationship.sourceObjectIds],
    assetIds: [...relationship.assetIds],
    score: 0.91,
    evidence: ['bounded-source-geometry'],
    sourceBoxes: relationship.sourceBoxes.slice(1),
  }
  candidate.id = pdfVisualMatchCandidateId(relationship.id, candidate)
  relationship.candidates = [candidate]
  relationship.sourceRegionIds = []
  relationship.sourceObjectIds = []
  relationship.assetIds = []
  relationship.sourceBoxes = relationship.sourceBoxes.slice(0, 1)
  base.lineBoundaryDecisions = []
  base.unresolvedCorruptingJoinCount = 0
  base.structurallyConsumedLineBoundaryCount = 0
  base.diagnostics = [
    {
      code: 'AMBIGUOUS_VISUAL_MATCH',
      severity: 'error',
      page: 1,
      message: 'Synthetic visual requires one bounded owner choice.',
      sourceBoxes: [...relationship.sourceBoxes, ...candidate.sourceBoxes],
      target: {
        regionIds: [relationship.captionRegionId, ...candidate.sourceRegionIds],
        markerId: relationship.id,
      },
    },
  ]
  return base
}

function equationTranscriptDecision(
  reconstruction: Awaited<
    ReturnType<typeof unresolvedEquationTranscriptReconstruction>
  >,
) {
  const relationship = reconstruction.visualRelationships[0]
  const binding = equationTranscriptDecisionBinding(
    reconstruction,
    relationship.id,
  )
  if (!binding) throw new Error('Expected an exact synthetic equation binding')
  return createEquationTranscriptDecision(
    reconstruction,
    relationship.id,
    SYNTHETIC_LATEX_TRANSCRIPT,
  )
}

function targeted(
  diagnostic: ReconstructionDiagnostic,
): asserts diagnostic is ReconstructionDiagnostic & {
  target: NonNullable<ReconstructionDiagnostic['target']>
} {
  expect(diagnostic.target).toBeDefined()
}

const COMPLETENESS_DERIVED_DIAGNOSTIC_CODES = [
  'OCR_REQUIRED',
  'UNRESOLVED_EQUATION_TRANSCRIPT',
  'UNRESOLVED_ALGORITHM_TRANSCRIPT',
  'UNRESOLVED_PREFORMATTED_TRANSCRIPT',
  'EPUB_TEXT_SANITIZATION_LOSS',
  'DANGLING_EPUB_INTERNAL_REFERENCE',
  'INCOMPLETE_TEXT_COVERAGE',
  'DUPLICATE_CANONICAL_SPAN',
  'DUPLICATE_CANONICAL_ROLE',
  'CANONICAL_FLOW_ORDER_VIOLATION',
  'CANONICAL_VISUAL_ORDER_VIOLATION',
  'MISSING_SOURCE_REGION',
  'UNPROVENANCED_RENDERED_UNIT',
  'INCOMPLETE_INLINE_STYLE_COVERAGE',
  'UNRESOLVED_HYPERLINK',
  'INVALID_LINE_BOUNDARY_LEDGER',
  'UNRESOLVED_CORRUPTING_JOIN',
  'INCOMPLETE_ASSET_COVERAGE',
  'INCOMPLETE_RELATIONSHIP_COVERAGE',
  'INCOMPLETE_SEMANTIC_TABLE_COVERAGE',
  'UNRESOLVED_SEMANTIC_OBJECTS',
] as const satisfies readonly ReconstructionDiagnostic['code'][]

describe('human adjudication decision records', () => {
  it('emits current line-join decisions without serializing source text', async () => {
    const base = await unresolvedLineJoinReconstruction()
    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      lineJoinDecision(base, 'remove-wrap-hyphen'),
    )
    const json = serializeHumanDecisionFile(file)
    const parsed = JSON.parse(json)

    expect(parsed).toMatchObject({
      schemaVersion: '1.2.0',
      documentSha256: base.source.sha256,
      decisions: [
        {
          diagnosticCode: 'UNRESOLVED_CORRUPTING_JOIN',
          resolution: {
            type: 'resolve-line-join',
            outcome: 'remove-wrap-hyphen',
            confidence: 1,
            evidence: ['bounded-source-context', 'owner-local-adjudication'],
          },
        },
      ],
    })
    expect(json).not.toContain('This source contains')
    expect(json).not.toContain('continuous prose')
  })

  it('continues to parse and replay v1.1 line-join decision files', async () => {
    const base = await unresolvedLineJoinReconstruction()
    const parsed = parseHumanDecisionFile({
      schemaVersion: '1.1.0',
      documentSha256: base.source.sha256,
      decisions: [lineJoinDecision(base, 'remove-wrap-hyphen')],
    })
    const result = applyHumanDecisionFile(base, parsed)

    expect(parsed.schemaVersion).toBe('1.1.0')
    expect(result.humanAdjudications).toMatchObject({
      schemaVersion: '1.1.0',
      applied: [
        expect.objectContaining({
          resolution: expect.objectContaining({
            outcome: 'remove-wrap-hyphen',
          }),
        }),
      ],
      stale: [],
    })
    expect(result.regions[0].text).toContain('a scenario that')
  })

  it('continues to parse and replay v1.0 decision files', async () => {
    const base = await ambiguousReconstruction()
    const diagnostic = base.diagnostics.find(
      (item) => item.code === 'AMBIGUOUS_READING_ORDER',
    )!
    targeted(diagnostic)
    const legacy = {
      schemaVersion: '1.0.0',
      documentSha256: base.source.sha256,
      decisions: [
        {
          diagnosticCode: diagnostic.code,
          target: diagnostic.target,
          resolution: {
            type: 'accept-reading-order',
            regionIds: readingOrderCandidates(base, diagnostic)[0],
          },
        },
      ],
    }

    const parsed = parseHumanDecisionFile(JSON.stringify(legacy))
    expect(parsed.schemaVersion).toBe('1.0.0')
    expect(
      applyHumanDecisionFile(base, parsed).humanAdjudications,
    ).toMatchObject({
      schemaVersion: '1.0.0',
      countsByDiagnosticCode: { AMBIGUOUS_READING_ORDER: 1 },
    })
  })

  it('keeps an unresolved two-dimensional equation blocked without an owner decision', async () => {
    const base = await unresolvedEquationTranscriptReconstruction()
    const result = applyHumanDecisionFile(
      base,
      createHumanDecisionFile(base.source.sha256),
    )

    expect(base.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_EQUATION_TRANSCRIPT',
    )
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_EQUATION_TRANSCRIPT',
    )
    expect(result.humanAdjudications.applied).toEqual([])
    expect(result.visualRelationships[0]).not.toHaveProperty(
      'equationTranscriptAdjudication',
    )
  })

  it('applies a hash-bound owner-local LaTeX transcript without inventing MathML', async () => {
    const base = await unresolvedEquationTranscriptReconstruction()
    const decision = equationTranscriptDecision(base)
    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      decision,
    )
    const serialized = serializeHumanDecisionFile(file)
    const decisionSetSha256 = humanDecisionFileSha256(file)
    const result = applyHumanDecisionFile(base, file)
    const relationship = result.visualRelationships[0]
    const canonicalNode = result.paper.nodes.find(
      (node) => node.id === relationship.canonicalNodeId,
    )

    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: '1.2.0',
      decisions: [
        {
          diagnosticCode: 'UNRESOLVED_EQUATION_TRANSCRIPT',
          target: {
            markerId: relationship.id,
            regionIds: relationship.sourceRegionIds,
          },
          resolution: {
            type: 'accept-equation-transcript',
            format: 'latex',
            confidence: 1,
          },
        },
      ],
    })
    expect(serialized).not.toContain('sourceCropBox')
    expect(serialized).not.toContain('pixels')
    expect(decisionSetSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(humanDecisionFileSha256(parseHumanDecisionFile(serialized))).toBe(
      decisionSetSha256,
    )
    expect(result.humanAdjudications).toMatchObject({
      schemaVersion: '1.2.0',
      applied: [
        expect.objectContaining({
          diagnosticCode: 'UNRESOLVED_EQUATION_TRANSCRIPT',
        }),
      ],
      stale: [],
    })
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_EQUATION_TRANSCRIPT',
          relationshipId: relationship.id,
        }),
      ]),
    )
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'UNRESOLVED_EQUATION_TRANSCRIPT',
    )
    expect(result.completeness).toMatchObject({
      resolvedRelationshipCount: 1,
      unresolvedObjects: { equations: 0 },
    })
    expect(relationship).toMatchObject({
      sourceText: SYNTHETIC_LATEX_TRANSCRIPT,
      altText: 'Equation A. Synthetic adjudication fixture.',
      altTextSource: 'caption',
      equationTranscriptAdjudication: {
        schemaVersion: '1.0.0',
        format: 'latex',
        source: 'owner-local-adjudication',
        relationshipFingerprintSha256:
          decision.resolution.relationshipFingerprintSha256,
        sourceCropAssetId: decision.resolution.sourceCropAssetId,
        sourceCropAssetSha256: decision.resolution.sourceCropAssetSha256,
      },
      evidence: expect.arrayContaining([
        'owner-adjudicated-equation-transcript-v1',
        'equation-transcript-format-latex',
        'exact-source-page-crop',
        'owner-local-adjudication',
      ]),
    })
    expect(relationship.evidence).toContain('source-text-transcript-unresolved')
    expect(canonicalNode).toMatchObject({
      type: 'figure',
      sourceText: SYNTHETIC_LATEX_TRANSCRIPT,
    })
    expect(relationship).not.toHaveProperty('mathml')
    expect(relationship).not.toHaveProperty('mathMl')
    expect(verifyEquationTranscriptAdjudication(result, relationship.id)).toBe(
      true,
    )

    const xhtml = renderPublicationXhtml(result.paper, {
      reconstruction: result,
    })
    expect(xhtml).toContain(
      'alt="Equation image; owner-reviewed source transcript available." data-alt-source="owner-local-adjudication"',
    )
    const escapedTranscript = String.raw`\operatorname{demo}(x^{2})&lt;y \&amp; z`
    expect(xhtml.split(escapedTranscript)).toHaveLength(2)
    expect(xhtml).not.toContain(SYNTHETIC_LATEX_TRANSCRIPT)

    const epub = await buildReadableEpub(result.paper, result)
    const inspection = inspectEpub(epub.bytes)
    const packagedXhtml = new TextDecoder().decode(
      inspection.files['EPUB/content.xhtml'],
    )
    const adjudicationReceipt = JSON.stringify(
      inspection.manifest.humanAdjudications,
    )
    expect(packagedXhtml).toContain(
      'alt="Equation image; owner-reviewed source transcript available." data-alt-source="owner-local-adjudication"',
    )
    expect(packagedXhtml.split(escapedTranscript)).toHaveLength(2)
    expect(adjudicationReceipt).not.toContain(SYNTHETIC_LATEX_TRANSCRIPT)
    expect(adjudicationReceipt).toContain(
      relationship.equationTranscriptAdjudication!.transcriptSha256,
    )
  })

  it('makes the equation binding byte-stable and sensitive to exact lineage boxes', async () => {
    const first = await unresolvedEquationTranscriptReconstruction()
    const second = await unresolvedEquationTranscriptReconstruction()
    const firstBinding = equationTranscriptDecisionBinding(
      first,
      first.visualRelationships[0].id,
    )
    const secondBinding = equationTranscriptDecisionBinding(
      second,
      second.visualRelationships[0].id,
    )
    expect(firstBinding).toEqual(secondBinding)
    expect(firstBinding?.relationshipFingerprintSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    )

    second.regions[1].lines[0].box.x += Number.EPSILON
    const drifted = equationTranscriptDecisionBinding(
      second,
      second.visualRelationships[0].id,
    )
    expect(drifted?.relationshipFingerprintSha256).not.toBe(
      firstBinding?.relationshipFingerprintSha256,
    )
  })

  it('recomputes adjudication proof and rejects transcript, node, crop, or lineage tampering', async () => {
    const mutations = [
      (result: PdfReconstruction) => {
        result.visualRelationships[0].sourceText += ' drift'
      },
      (result: PdfReconstruction) => {
        const node = result.paper.nodes.find(
          (candidate) =>
            candidate.id === result.visualRelationships[0].canonicalNodeId,
        )
        if (node?.type !== 'figure') throw new Error('Expected equation node')
        node.sourceText = `${node.sourceText ?? ''} drift`
      },
      (result: PdfReconstruction) => {
        result.assets[0].bytes[0] ^= 0xff
      },
      (result: PdfReconstruction) => {
        result.assets[0].sourceExclusionMask!.excludedSourceBoxes[0].x +=
          Number.EPSILON
      },
      (result: PdfReconstruction) => {
        result.regions[1].lines[0].box.x += Number.EPSILON
      },
    ]

    for (const mutate of mutations) {
      const base = await unresolvedEquationTranscriptReconstruction()
      const result = applyHumanDecisionFile(
        base,
        upsertHumanDecision(
          createHumanDecisionFile(base.source.sha256),
          equationTranscriptDecision(base),
        ),
      )
      mutate(result)
      expect(
        verifyEquationTranscriptAdjudication(
          result,
          result.visualRelationships[0].id,
        ),
      ).toBe(false)
    }
  })

  it('fails equation replay closed on document, relationship, crop, or lineage drift', async () => {
    const cases = [
      {
        label: 'document',
        mutate: (
          reconstruction: Awaited<
            ReturnType<typeof unresolvedEquationTranscriptReconstruction>
          >,
          file: ReturnType<typeof createHumanDecisionFile>,
        ) => {
          void reconstruction
          file.documentSha256 = 'f'.repeat(64)
        },
        reason: 'document-sha256-mismatch',
      },
      {
        label: 'relationship',
        mutate: (
          reconstruction: Awaited<
            ReturnType<typeof unresolvedEquationTranscriptReconstruction>
          >,
          file: ReturnType<typeof createHumanDecisionFile>,
        ) => {
          void reconstruction
          const decision = file.decisions[0]
          if (decision.resolution.type !== 'accept-equation-transcript') {
            throw new Error('Expected equation resolution')
          }
          decision.resolution.relationshipId = 'missing-relationship'
          decision.target.markerId = 'missing-relationship'
        },
        reason: 'diagnostic-target-missing',
      },
      {
        label: 'crop',
        mutate: (
          reconstruction: Awaited<
            ReturnType<typeof unresolvedEquationTranscriptReconstruction>
          >,
          file: ReturnType<typeof createHumanDecisionFile>,
        ) => {
          void reconstruction
          const decision = file.decisions[0]
          if (decision.resolution.type !== 'accept-equation-transcript') {
            throw new Error('Expected equation resolution')
          }
          decision.resolution.sourceCropAssetSha256 = 'f'.repeat(64)
        },
        reason: 'resolution-no-longer-legal',
      },
      {
        label: 'lineage',
        mutate: (
          reconstruction: Awaited<
            ReturnType<typeof unresolvedEquationTranscriptReconstruction>
          >,
          file: ReturnType<typeof createHumanDecisionFile>,
        ) => {
          void file
          reconstruction.regions[1].lines[0].id = 'drifted-source-line'
        },
        reason: 'resolution-no-longer-legal',
      },
    ] as const

    for (const scenario of cases) {
      const reconstruction = await unresolvedEquationTranscriptReconstruction()
      const file = upsertHumanDecision(
        createHumanDecisionFile(reconstruction.source.sha256),
        equationTranscriptDecision(reconstruction),
      )
      scenario.mutate(reconstruction, file)
      const result = applyHumanDecisionFile(reconstruction, file)
      expect(result.humanAdjudications.stale, scenario.label).toEqual([
        expect.objectContaining({
          reason: scenario.reason,
        }),
      ])
      expect(
        result.readiness.blockingDiagnosticCodes,
        scenario.label,
      ).toContain('UNRESOLVED_EQUATION_TRANSCRIPT')
    }
  })

  it('does not let arbitrary pre-seeded transcript evidence bypass replay binding', async () => {
    const base = await unresolvedEquationTranscriptReconstruction()
    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      equationTranscriptDecision(base),
    )
    const relationship = base.visualRelationships[0]
    relationship.sourceText = SYNTHETIC_LATEX_TRANSCRIPT
    relationship.evidence.push('owner-adjudicated-equation-transcript-v1')
    const node = base.paper.nodes.find(
      (candidate) => candidate.id === relationship.canonicalNodeId,
    )
    if (node?.type !== 'figure') throw new Error('Expected equation node')
    node.sourceText = SYNTHETIC_LATEX_TRANSCRIPT

    const result = applyHumanDecisionFile(base, file)

    expect(result.humanAdjudications.applied).toEqual([])
    expect(result.humanAdjudications.stale).toEqual([
      expect.objectContaining({ reason: 'resolution-no-longer-legal' }),
    ])
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_EQUATION_TRANSCRIPT',
    )
    expect(result.visualRelationships[0]).not.toHaveProperty(
      'equationTranscriptAdjudication',
    )
    expect(
      verifyEquationTranscriptAdjudication(
        result,
        result.visualRelationships[0].id,
      ),
    ).toBe(false)
  })

  it('requires schema v1.2, exact target identity, and bounded equation text', async () => {
    const base = await unresolvedEquationTranscriptReconstruction()
    const decision = equationTranscriptDecision(base)

    expect(() =>
      parseHumanDecisionFile({
        schemaVersion: '1.1.0',
        documentSha256: base.source.sha256,
        decisions: [decision],
      }),
    ).toThrow(/v1\.2\.0/u)
    expect(() =>
      parseHumanDecisionFile({
        schemaVersion: '1.2.0',
        documentSha256: base.source.sha256,
        decisions: [
          {
            ...decision,
            target: { ...decision.target, markerId: 'wrong-relationship' },
          },
        ],
      }),
    ).toThrow(/exact visual relationship/u)
    expect(() =>
      parseHumanDecisionFile({
        schemaVersion: '1.2.0',
        documentSha256: base.source.sha256,
        decisions: [
          {
            ...decision,
            resolution: {
              ...decision.resolution,
              transcript: 'x'.repeat(MAX_EQUATION_TRANSCRIPT_LENGTH + 1),
            },
          },
        ],
      }),
    ).toThrow()
  })

  it.each([
    {
      choice: 'remove-wrap-hyphen' as const,
      expectedText:
        'This source contains a scenario that remains continuous prose.',
      expectedOutcome: 'removed-discretionary-hyphen',
    },
    {
      choice: 'preserve-authored-hyphen' as const,
      expectedText:
        'This source contains a scenar-io that remains continuous prose.',
      expectedOutcome: 'preserved-lexical-hyphen',
    },
  ])(
    'replays $choice deterministically before reassessing readiness',
    async ({ choice, expectedText, expectedOutcome }) => {
      const base = await unresolvedLineJoinReconstruction()
      const file = upsertHumanDecision(
        createHumanDecisionFile(base.source.sha256),
        lineJoinDecision(base, choice),
      )

      const first = applyHumanDecisionFile(base, file)
      const second = applyHumanDecisionFile(base, file)

      expect(first).toEqual(second)
      expect(first.regions[0].text).toBe(expectedText)
      expect(first.paper.nodes[0]).toMatchObject({ text: expectedText })
      expect(first.lineBoundaryDecisions[0]).toMatchObject({
        outcome: expectedOutcome,
        evidence: expect.arrayContaining([
          'bounded-source-context',
          'owner-local-adjudication',
        ]),
      })
      expect(first.unresolvedCorruptingJoinCount).toBe(0)
      expect(first.completeness.unresolvedCorruptingJoinCount).toBe(0)
      expect(first.readiness.blockingDiagnosticCodes).not.toContain(
        'UNRESOLVED_CORRUPTING_JOIN',
      )
    },
  )

  it('records leave-unresolved without silently clearing its gate', async () => {
    const base = await unresolvedLineJoinReconstruction()
    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      lineJoinDecision(base, 'leave-unresolved'),
    )
    const result = applyHumanDecisionFile(base, file)

    expect(result.regions[0].text).toBe(base.regions[0].text)
    expect(result.lineBoundaryDecisions[0]).toMatchObject({
      outcome: 'unresolved',
      evidence: expect.arrayContaining(['owner-local-adjudication']),
    })
    expect(result.unresolvedCorruptingJoinCount).toBe(1)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_CORRUPTING_JOIN',
    )
    expect(result.humanAdjudications.applied).toHaveLength(1)
  })

  it('removes the transition-selected occurrence when a boundary word repeats', async () => {
    const runs = [
      run('First dupli-', 0.1, 0.2, 0.2),
      run('cate token and second dupli-', 0.1, 0.225, 0.42),
      run('cate token.', 0.1, 0.25, 0.2),
    ]
    const base = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: runs.reduce(
            (total, item) => total + item.text.length,
            0,
          ),
          imageCount: 0,
          runs,
        },
      ],
      sourceHash: '2'.repeat(64),
      fileName: 'duplicate-boundary-word.pdf',
      byteLength: 2048,
    })
    const transitions = base.lineBoundaryDecisions.filter(
      (candidate) => candidate.outcome === 'unresolved',
    )
    expect(transitions).toHaveLength(2)
    const transition = transitions[1]
    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      {
        diagnosticCode: 'UNRESOLVED_CORRUPTING_JOIN',
        target: {
          regionIds: [transition.regionId],
          markerId: transition.id,
        },
        resolution: {
          type: 'resolve-line-join',
          transition: {
            id: transition.id,
            regionId: transition.regionId,
            fromLineId: transition.fromLineId,
            toLineId: transition.toLineId,
          },
          outcome: 'remove-wrap-hyphen',
          confidence: 1,
          evidence: ['bounded-source-context', 'owner-local-adjudication'],
        },
      },
    )

    const result = applyHumanDecisionFile(base, file)

    expect(result.regions[0].text).toBe(
      'First dupli-cate token and second duplicate token.',
    )
    expect(result.humanAdjudications).toMatchObject({
      applied: [
        expect.objectContaining({
          target: expect.objectContaining({ markerId: transition.id }),
        }),
      ],
      stale: [],
    })
    expect(result.unresolvedCorruptingJoinCount).toBe(1)
  })

  it('shifts canonical note anchors and citation offsets after removing a wrap hyphen', async () => {
    const base = await unresolvedLineJoinReconstruction()
    const region = base.regions[0]
    const paragraph = base.paper.nodes[0]
    if (paragraph.type !== 'paragraph') {
      throw new Error('Expected a paragraph fixture')
    }
    const noteStart = paragraph.text.indexOf('continuous')
    const citationStart = paragraph.text.indexOf('remains')
    expect(noteStart).toBeGreaterThan(0)
    expect(citationStart).toBeGreaterThan(0)

    paragraph.noteReferences = [
      {
        id: 'shifted-note-reference',
        label: '1',
        target: 'shifted-note',
        start: noteStart,
        end: noteStart + 1,
        confidence: 1,
      },
    ]
    base.paper.nodes.push({
      id: 'shifted-note',
      type: 'footnote',
      kind: 'footnote',
      label: '1',
      text: 'A source-backed note.',
      relationships: { backlinks: ['shifted-note-reference'] },
      source: 'synthetic-line-join-note',
    })
    base.noteRelationships = [
      {
        id: 'shifted-note-reference',
        label: '1',
        referenceRegionId: region.id,
        referenceStart: noteStart,
        referenceEnd: noteStart + 1,
        targetNoteId: 'shifted-note',
        status: 'matched',
        canonicalAnchor: {
          kind: 'node',
          nodeId: paragraph.id,
          start: noteStart,
          end: noteStart + 1,
        },
        confidence: 1,
        threshold: 0.72,
        evidence: ['synthetic-line-join-note'],
        candidates: [],
        sourceBoxes: [],
      },
    ]
    base.citationRelationships = [
      {
        id: 'shifted-citation',
        label: '[1]',
        labels: ['1'],
        referenceRegionId: region.id,
        referenceStart: citationStart,
        referenceEnd: citationStart + 1,
        taxonomy: 'bracketed-bibliography-citation',
        targetNodeIds: [],
        status: 'unresolved',
        canonicalAnchor: {
          nodeId: paragraph.id,
          start: citationStart,
          end: citationStart + 1,
        },
        confidence: 1,
        evidence: ['synthetic-line-join-citation'],
        sourceBoxes: [],
      },
    ]

    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      lineJoinDecision(base, 'remove-wrap-hyphen'),
    )
    const result = applyHumanDecisionFile(base, file)
    const shiftedParagraph = result.paper.nodes.find(
      (node) => node.id === paragraph.id,
    )

    expect(result.noteRelationships[0]).toMatchObject({
      referenceStart: noteStart - 1,
      referenceEnd: noteStart,
      canonicalAnchor: {
        kind: 'node',
        nodeId: paragraph.id,
        start: noteStart - 1,
        end: noteStart,
      },
    })
    expect(result.citationRelationships[0]).toMatchObject({
      referenceStart: citationStart - 1,
      referenceEnd: citationStart,
      canonicalAnchor: {
        nodeId: paragraph.id,
        start: citationStart - 1,
        end: citationStart,
      },
    })
    expect(shiftedParagraph).toMatchObject({
      noteReferences: [
        expect.objectContaining({
          id: 'shifted-note-reference',
          start: noteStart - 1,
          end: noteStart,
        }),
      ],
    })
    expect(
      internalReferenceIntegrityIssues(result.paper, result.noteRelationships),
    ).toEqual([])
  })

  it('fails closed when a saved line-transition identity drifts', async () => {
    const base = await unresolvedLineJoinReconstruction()
    const decision = lineJoinDecision(base, 'remove-wrap-hyphen')
    if (decision.resolution.type !== 'resolve-line-join') {
      throw new Error('Expected a line-join decision')
    }
    decision.resolution.transition.toLineId = 'page-001-line-missing'
    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      decision,
    )
    const result = applyHumanDecisionFile(base, file)

    expect(result.regions[0].text).toBe(base.regions[0].text)
    expect(result.unresolvedCorruptingJoinCount).toBe(1)
    expect(result.humanAdjudications.stale).toEqual([
      expect.objectContaining({ reason: 'resolution-no-longer-legal' }),
    ])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'STALE_HUMAN_DECISION' }),
      ]),
    )
  })

  it.each([
    ['reclassify-citation', 'citation'],
    ['reclassify-plain-text', 'plain-text'],
  ] as const)(
    'supports exact marker %s decisions',
    async (resolution, status) => {
      const claim = run(
        'A bibliography marker is deliberately written as note reference 3.',
        0.1,
        0.2,
        0.72,
      )
      const page: PdfPageAnalysis = {
        page: 1,
        kind: 'born-digital',
        width: 612,
        height: 792,
        rotation: 0,
        textCharacters: claim.text.length,
        imageCount: 0,
        runs: [claim],
      }
      const base = await reconstructPageAnalyses({
        pages: [page],
        sourceHash: 'c'.repeat(64),
        fileName: 'citation.pdf',
        byteLength: 1024,
      })
      const diagnostic = base.diagnostics.find(
        (item) => item.code === 'UNRESOLVED_NOTE_REFERENCE',
      )!
      targeted(diagnostic)
      const file = upsertHumanDecision(
        createHumanDecisionFile(base.source.sha256),
        {
          diagnosticCode: diagnostic.code,
          target: diagnostic.target,
          resolution: { type: resolution },
        },
      )

      const result = applyHumanDecisionFile(base, file)
      expect(result.noteRelationships[0].status).toBe(status)
      expect(result.readiness.ready).toBe(false)
      expect(result.readiness.blockingDiagnosticCodes).toContain(
        'UNPROVENANCED_RENDERED_UNIT',
      )
      if (resolution === 'reclassify-citation') {
        expect(result.citationRelationships).toEqual([
          expect.objectContaining({
            id: result.noteRelationships[0].id,
            status: 'unresolved',
          }),
        ])
        expect(
          result.paper.nodes.flatMap((node) =>
            'inlineRuns' in node ? (node.inlineRuns ?? []) : [],
          ),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ semanticRole: 'citation' }),
          ]),
        )
      }
      expect(result.humanAdjudications.applied).toHaveLength(1)
    },
  )

  it('adjudicates note matches and reading order and replays headlessly', async () => {
    const source = await fixtureFile('adjudication-required.pdf')
    const base = await reconstructPdf(source)
    expect(
      base.diagnostics.filter((item) => item.code === 'AMBIGUOUS_NOTE_MATCH'),
    ).toHaveLength(2)
    expect(base.diagnostics.map((item) => item.code)).toContain(
      'AMBIGUOUS_READING_ORDER',
    )
    const readingDiagnostic = base.diagnostics.find(
      (item) => item.code === 'AMBIGUOUS_READING_ORDER',
    )!
    targeted(readingDiagnostic)

    let file = createHumanDecisionFile(base.source.sha256)
    for (const [index, relationship] of base.noteRelationships.entries()) {
      const diagnostic = base.diagnostics.find(
        (item) => item.target?.markerId === relationship.id,
      )!
      targeted(diagnostic)
      const candidate = relationship.candidates[index]
      file = upsertHumanDecision(file, {
        diagnosticCode: diagnostic.code,
        target: diagnostic.target,
        resolution: {
          type: 'accept-note-match',
          targetNoteId: candidate.targetNoteId,
          targetRegionId: candidate.targetRegionId,
        },
      })
    }
    file = upsertHumanDecision(file, {
      diagnosticCode: readingDiagnostic.code,
      target: readingDiagnostic.target,
      resolution: {
        type: 'accept-reading-order',
        regionIds: readingOrderCandidates(base, readingDiagnostic)[0],
      },
    })

    const result = applyHumanDecisionFile(base, file)
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
    expect(result.noteRelationships.map((item) => item.status)).toEqual([
      'matched',
      'matched',
    ])
    expect(result.humanAdjudications.countsByDiagnosticCode).toEqual({
      AMBIGUOUS_NOTE_MATCH: 2,
      AMBIGUOUS_READING_ORDER: 1,
    })

    await expect(buildEpub(result.paper, result)).rejects.toThrow(
      /UNPROVENANCED_RENDERED_UNIT/u,
    )
    const replayed = await reconstructPdf(
      await fixtureFile('adjudication-required.pdf'),
      undefined,
      { decisionFile: file },
    )
    expect(replayed.paper).toEqual(result.paper)
    expect(replayed.readiness).toEqual(result.readiness)
    await expect(buildEpub(replayed.paper, replayed)).rejects.toThrow(
      /UNPROVENANCED_RENDERED_UNIT/u,
    )
  })

  it('preserves visual completeness when a sidecar is applied', async () => {
    const base = await reconstructPdf(
      await fixtureFile('structured-scientific.pdf'),
    )
    const result = applyHumanDecisionFile(
      base,
      createHumanDecisionFile(base.source.sha256),
    )

    expect(result.completeness).toEqual(base.completeness)
    expect(result.readiness).toEqual(base.readiness)
    expect(result.visualRelationships).toEqual(base.visualRelationships)
    expect(result.assets).toEqual(base.assets)
  })

  it('replaces completeness-derived diagnostics instead of accumulating them on reassessment', async () => {
    const base = await unresolvedLineJoinReconstruction()
    for (const code of COMPLETENESS_DERIVED_DIAGNOSTIC_CODES) {
      base.diagnostics.push({
        code,
        severity: 'error',
        message: `seeded-derived-diagnostic:${code}`,
      })
    }
    const file = createHumanDecisionFile(base.source.sha256)

    const first = applyHumanDecisionFile(base, file)
    const second = applyHumanDecisionFile(first, file)
    const derivedCounts = (diagnostics: ReconstructionDiagnostic[]) =>
      Object.fromEntries(
        COMPLETENESS_DERIVED_DIAGNOSTIC_CODES.map((code) => [
          code,
          diagnostics.filter((diagnostic) => diagnostic.code === code).length,
        ]),
      )

    for (const result of [first, second]) {
      expect(
        result.diagnostics.filter((diagnostic) =>
          diagnostic.message.startsWith('seeded-derived-diagnostic:'),
        ),
      ).toEqual([])
    }
    expect(derivedCounts(second.diagnostics)).toEqual(
      derivedCounts(first.diagnostics),
    )
  })

  it('replays an exact reading-order choice before the completeness gate', async () => {
    const base = await ambiguousReconstruction()
    const diagnostic = base.diagnostics.find(
      (item) => item.code === 'AMBIGUOUS_READING_ORDER',
    )!
    targeted(diagnostic)
    const candidates = readingOrderCandidates(base, diagnostic)
    expect(candidates).toHaveLength(2)

    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      {
        diagnosticCode: diagnostic.code,
        target: diagnostic.target,
        resolution: {
          type: 'accept-reading-order',
          regionIds: candidates[0],
        },
      },
    )
    const result = applyHumanDecisionFile(base, file)

    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
    expect(result.readiness.policy).toEqual(base.readiness.policy)
    expect(result.humanAdjudications).toMatchObject({
      applied: [expect.objectContaining({ diagnosticCode: diagnostic.code })],
      stale: [],
      countsByDiagnosticCode: { AMBIGUOUS_READING_ORDER: 1 },
    })
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_READING_ORDER' }),
      ]),
    )

    await expect(buildEpub(result.paper, result)).rejects.toThrow(
      /UNPROVENANCED_RENDERED_UNIT/u,
    )
  })

  it('contains identifiers and choices but no reconstructed document text', async () => {
    const base = await ambiguousReconstruction()
    const diagnostic = base.diagnostics.find(
      (item) => item.code === 'AMBIGUOUS_READING_ORDER',
    )!
    targeted(diagnostic)
    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      {
        diagnosticCode: diagnostic.code,
        target: diagnostic.target,
        resolution: {
          type: 'accept-reading-order',
          regionIds: readingOrderCandidates(base, diagnostic)[0],
        },
      },
    )
    const json = serializeHumanDecisionFile(file)

    expect(json).not.toContain('Left candidate one')
    expect(json).not.toContain('Right candidate one')
    expect(json).not.toContain('sourceBoxes')
  })

  it('applies one complete stable visual candidate and replays byte-identically', async () => {
    const base = await ambiguousVisualReconstruction()
    const relationship = base.visualRelationships[0]
    const candidate = relationship.candidates[0]
    const decision = createVisualMatchDecision(
      base,
      relationship.id,
      candidate.id!,
    )
    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      decision,
    )
    const serialized = serializeHumanDecisionFile(file)
    const first = applyHumanDecisionFile(base, file)
    const replay = applyHumanDecisionFile(
      base,
      parseHumanDecisionFile(serialized),
    )
    const resolved = first.visualRelationships[0]

    expect(JSON.parse(serialized)).toEqual({
      schemaVersion: '1.3.0',
      documentSha256: base.source.sha256,
      decisions: [
        {
          diagnosticCode: 'AMBIGUOUS_VISUAL_MATCH',
          target: decision.target,
          resolution: {
            type: 'accept-visual-match',
            relationshipId: relationship.id,
            candidateId: candidate.id,
          },
        },
      ],
    })
    expect(serialized).not.toMatch(
      /(?:sourceBoxes|bytes|href|transcript|local path)/iu,
    )
    expect(resolved).toMatchObject({
      status: 'matched',
      sourceRegionIds: candidate.sourceRegionIds,
      sourceObjectIds: candidate.sourceObjectIds,
      assetIds: candidate.assetIds,
      evidence: expect.arrayContaining(['human-adjudicated-visual-match']),
    })
    expect(resolved.canonicalNodeId).not.toBeNull()
    expect(first.paper.nodes).toContainEqual(
      expect.objectContaining({
        id: resolved.canonicalNodeId,
        type: 'figure',
        relationships: {
          caption: resolved.captionNodeId,
          assets: candidate.assetIds,
        },
      }),
    )
    expect(first.humanAdjudications.countsByDiagnosticCode).toEqual({
      AMBIGUOUS_VISUAL_MATCH: 1,
    })
    expect(first.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_VISUAL_MATCH' }),
      ]),
    )
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first))
  })

  it('keeps the named visual adjudication fixture review-required with both visual blockers', async () => {
    const source = await fixtureFile('visual-adjudication-required.pdf')
    const base = await reconstructPdf(source)
    expect(
      base.diagnostics
        .filter(
          (diagnostic) =>
            diagnostic.code === 'AMBIGUOUS_VISUAL_MATCH' ||
            diagnostic.code === 'UNRESOLVED_VISUAL_OBJECT',
        )
        .map((diagnostic) => diagnostic.code),
    ).toEqual(['AMBIGUOUS_VISUAL_MATCH', 'UNRESOLVED_VISUAL_OBJECT'])
    expect(base.readiness.ready).toBe(false)
    expect(
      base.visualRelationships
        .filter((relationship) => relationship.status !== 'matched')
        .every((relationship) =>
          relationship.candidates.every(
            (candidate) =>
              Boolean(candidate.id) &&
              candidate.assetIds.every((assetId) =>
                base.assets.some(
                  (asset) => asset.id === assetId && asset.bytes.byteLength > 0,
                ),
              ),
          ),
        ),
    ).toBe(true)

    const sidecar = parseHumanDecisionFile(
      await readFile(
        new URL(
          '../../tests/fixtures/pdf/visual-adjudication-required.decisions.json',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    const resolved = applyHumanDecisionFile(base, sidecar)
    const replay = applyHumanDecisionFile(base, sidecar)
    expect(resolved.humanAdjudications).toMatchObject({
      stale: [],
      countsByDiagnosticCode: {
        AMBIGUOUS_VISUAL_MATCH: 1,
        UNRESOLVED_VISUAL_OBJECT: 1,
      },
    })
    expect(resolved.readiness.blockingDiagnosticCodes).toEqual([])
    expect(resolved.readiness).toMatchObject({ ready: true, status: 'ready' })
    expect(resolved.visualRelationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'matched',
          evidence: expect.arrayContaining(['human-adjudicated-visual-match']),
        }),
      ]),
    )
    expect(JSON.stringify(replay)).toBe(JSON.stringify(resolved))
    const [firstEpub, replayEpub] = await Promise.all([
      buildEpub(resolved.paper, resolved),
      buildEpub(replay.paper, replay),
    ])
    expect(replayEpub.sha256).toBe(firstEpub.sha256)
    expect(replayEpub.bytes).toEqual(firstEpub.bytes)
  })

  it('reports changed and incomplete visual candidates as stale', async () => {
    const base = await ambiguousVisualReconstruction()
    const relationship = base.visualRelationships[0]
    const candidate = relationship.candidates[0]
    const decision = createVisualMatchDecision(
      base,
      relationship.id,
      candidate.id!,
    )
    const missing = applyHumanDecisionFile(
      base,
      upsertHumanDecision(createHumanDecisionFile(base.source.sha256), {
        ...decision,
        resolution: {
          ...decision.resolution,
          candidateId: `visual-candidate-${'0'.repeat(64)}`,
        },
      }),
    )
    expect(missing.humanAdjudications.stale[0].reason).toBe(
      'resolution-no-longer-legal',
    )

    const incompleteBase = structuredClone(base)
    incompleteBase.visualRelationships[0].candidates[0].assetIds = [
      'missing-complete-asset',
    ]
    incompleteBase.visualRelationships[0].candidates[0].id =
      pdfVisualMatchCandidateId(
        relationship.id,
        incompleteBase.visualRelationships[0].candidates[0],
      )
    const incompleteDecision = createVisualMatchDecision(
      incompleteBase,
      relationship.id,
      incompleteBase.visualRelationships[0].candidates[0].id!,
    )
    const incomplete = applyHumanDecisionFile(
      incompleteBase,
      upsertHumanDecision(
        createHumanDecisionFile(incompleteBase.source.sha256),
        incompleteDecision,
      ),
    )
    expect(incomplete.humanAdjudications.stale[0].reason).toBe(
      'resolution-no-longer-legal',
    )
    expect(incomplete.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'STALE_HUMAN_DECISION' }),
      ]),
    )
  })

  it('keeps visual decoration choices closed and records denominator provenance', async () => {
    const source = await fixtureFile('visual-adjudication-required.pdf')
    const base = await reconstructPdf(source)
    const relationship = base.visualRelationships.find(
      (candidate) => candidate.status === 'ambiguous',
    )!
    const diagnostic = base.diagnostics.find(
      (candidate) =>
        candidate.code === 'AMBIGUOUS_VISUAL_MATCH' &&
        candidate.target?.markerId === relationship.id,
    )!
    targeted(diagnostic)
    const sourceObjectIds = relationship.candidates.flatMap(
      (candidate) => candidate.sourceObjectIds,
    )
    const decision = {
      diagnosticCode: diagnostic.code,
      target: diagnostic.target,
      resolution: {
        type: 'classify-visual-decoration',
        relationshipId: relationship.id,
        sourceObjectIds,
        reason: 'decorative-ornament',
      },
    } satisfies HumanAdjudicationRecord
    const result = applyHumanDecisionFile(
      base,
      upsertHumanDecision(
        createHumanDecisionFile(base.source.sha256),
        decision,
      ),
    )
    expect(result.humanAdjudications.visualDecorationReceipts).toEqual([
      expect.objectContaining({
        relationshipId: relationship.id,
        sourceObjectIds,
        reason: 'decorative-ornament',
        oldExpectedObjectDenominator: base.completeness.sourceAssetCount,
        newExpectedObjectDenominator: expect.any(Number),
        resultingCoverage: expect.any(Number),
      }),
    ])
    expect(
      result.pages.flatMap((page) => page.objects ?? []).map((item) => item.id),
    ).not.toEqual(expect.arrayContaining(sourceObjectIds))

    expect(() =>
      parseHumanDecisionFile({
        schemaVersion: '1.3.0',
        documentSha256: base.source.sha256,
        decisions: [
          {
            ...decision,
            resolution: {
              ...decision.resolution,
              reason: 'looks-unimportant',
            },
          },
        ],
      }),
    ).toThrow()
  })

  it('reports identifier drift and document mismatches as stale', async () => {
    const base = await ambiguousReconstruction()
    const diagnostic = base.diagnostics.find(
      (item) => item.code === 'AMBIGUOUS_READING_ORDER',
    )!
    targeted(diagnostic)
    const candidates = readingOrderCandidates(base, diagnostic)
    const drifted = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      {
        diagnosticCode: diagnostic.code,
        target: {
          ...diagnostic.target,
          regionIds: [...diagnostic.target.regionIds, 'missing-region'],
        },
        resolution: {
          type: 'accept-reading-order',
          regionIds: candidates[0],
        },
      },
    )
    const stale = applyHumanDecisionFile(base, drifted)
    expect(stale.humanAdjudications.stale[0].reason).toBe(
      'diagnostic-target-missing',
    )
    expect(stale.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'STALE_HUMAN_DECISION' }),
      ]),
    )

    const mismatched = applyHumanDecisionFile(base, {
      ...drifted,
      documentSha256: 'b'.repeat(64),
    })
    expect(mismatched.humanAdjudications.stale[0].reason).toBe(
      'document-sha256-mismatch',
    )
  })

  it('rejects oversized sidecars before parsing JSON', () => {
    expect(() =>
      parseHumanDecisionFile(' '.repeat(MAX_HUMAN_DECISION_FILE_BYTES + 1)),
    ).toThrow(/exceeds/i)
  })
})
