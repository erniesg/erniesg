import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
  PdfSourceExclusionMask,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import {
  equationRenderOnlySourceRunSha256,
  RENDER_ONLY_EQUATION_OWNERSHIP_EVIDENCE,
} from './equation-render-only-ownership'
import {
  createSourceGeometryScriptTranscript,
  SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
} from './equation-geometry-transcript'
import { pdfTextOperationRunPaintEnvelopes } from './pdf-page-crop'
import {
  normalizedPdfTextLedgerText,
  PDFJS_DISPLAY_OPERATOR_ADAPTER,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
  pdfTextLedgerSha256,
} from './pdf-text-paint'
import {
  collectMatchedPdfVisualRelationshipContradictions,
  validatedPdfVisualRelationships,
} from './pdf-visual-validation'
import type { ResearchPaper } from './schema'
import { sha256HexSync } from './sha256-sync'
import {
  createSourcePageCropAsset,
  pdfSourceExclusionMaskIdentity,
} from './visual-assets'

function textBox(
  x: number,
  y: number,
  width: number,
  height: number,
): NormalizedSourceBox {
  return {
    page: 1,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text',
  }
}

function line(
  id: string,
  text: string,
  box: NormalizedSourceBox,
  fontName = 'Synthetic-CMMI12',
): PdfPageRegion['lines'][number] {
  return {
    id,
    text,
    fontSize: 12,
    box,
    runs: [
      {
        ...box,
        text,
        fontName,
        fontSize: 12,
        confidence: 1,
      },
    ],
  }
}

function region(
  id: string,
  kind: PdfPageRegion['kind'],
  lines: PdfPageRegion['lines'],
): PdfPageRegion {
  const left = Math.min(...lines.map((item) => item.box.x))
  const top = Math.min(...lines.map((item) => item.box.y))
  const right = Math.max(...lines.map((item) => item.box.x + item.box.width))
  const bottom = Math.max(...lines.map((item) => item.box.y + item.box.height))
  return {
    id,
    page: 1,
    kind,
    column: 'single',
    text: lines.map((item) => item.text).join(' '),
    confidence: 1,
    box: textBox(left, top, right - left, bottom - top),
    lines,
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function unionBox(boxes: NormalizedSourceBox[]): NormalizedSourceBox {
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return textBox(left, top, right - left, bottom - top)
}

function replayPages(regions: PdfPageRegion[] | undefined) {
  if (!regions) return undefined
  return [...new Set(regions.map((region) => region.page))]
    .sort((left, right) => left - right)
    .map((pageNumber): PdfPageAnalysis => {
      const pageRegions = regions.filter((region) => region.page === pageNumber)
      const runs = pageRegions.flatMap((region) =>
        region.lines.flatMap((line) => line.runs),
      )
      return {
        page: pageNumber,
        kind: 'born-digital',
        width: 612,
        height: 792,
        rotation: pageRegions[0]?.box.rotation ?? 0,
        textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
        imageCount: 0,
        runs,
        renderVisibleTextRuns: runs,
      }
    })
}

function sourceBoxIdentity(box: NormalizedSourceBox) {
  return [
    box.page,
    box.x,
    box.y,
    box.width,
    box.height,
    box.rotation,
    box.method,
  ]
}

function reidentifyPersistedSourcePageCrop(asset: PdfVisualAsset) {
  const contentSha256 = sha256HexSync(asset.bytes)
  const sourceExclusionMask = pdfSourceExclusionMaskIdentity(
    asset.sourceExclusionMask,
    asset.sourceCropBox,
  )
  const identitySha256 = sha256HexSync(
    `${contentSha256}\n${JSON.stringify({
      kind: asset.kind,
      cropBox: sourceBoxIdentity(asset.sourceCropBox!),
      lineage: asset.sourceObjectIds.map((sourceObjectId, index) => [
        sourceObjectId,
        sourceBoxIdentity(asset.sourceBoxes[index]),
      ]),
      ...(sourceExclusionMask ? { sourceExclusionMask } : {}),
    })}`,
  )
  asset.sha256 = contentSha256
  asset.id = `asset-${identitySha256.slice(0, 24)}`
  asset.href = `assets/${asset.id}.png`
  return asset
}

async function partialEquationFixture(
  sourceExclusionMask?: PdfSourceExclusionMask,
) {
  const numeratorLine = line(
    'equation-numerator-line',
    'dS_t = σ dW_t (under Q),',
    textBox(0.39, 0.49, 0.23, 0.018),
  )
  const denominatorLine = line(
    'equation-denominator-line',
    'S_t',
    textBox(0.49, 0.505, 0.025, 0.014),
  )
  const proseLine = line(
    'retained-prose-line',
    'Conceptually, this ratio gives the return process.',
    textBox(0.12, 0.55, 0.72, 0.018),
    'Synthetic-CMR12',
  )
  const equationRegion = region('equation-region', 'equation', [numeratorLine])
  const sharedBodyRegion = region('shared-body-region', 'body', [
    denominatorLine,
    proseLine,
  ])
  const visualSourceBox = unionBox([numeratorLine.box, denominatorLine.box])
  const pixels = new Uint8Array(32 * 16 * 4).fill(255)
  for (let y = 4; y < 12; y += 1) {
    for (let x = 4; x < 28; x += 1) {
      const offset = (y * 32 + x) * 4
      pixels.set([0, 0, 0, 255], offset)
    }
  }
  const asset = await createSourcePageCropAsset({
    kind: 'equation',
    cropBox: visualSourceBox,
    sourceObjectIds: ['equation-source-object'],
    sourceBoxes: [visualSourceBox],
    width: 32,
    height: 16,
    pixels,
    sourceExclusionMask,
  })
  const relationship: PdfVisualRelationship = {
    id: 'equation-relationship',
    kind: 'equation',
    label: 'Equation 1',
    captionRegionId: equationRegion.id,
    sourceRegionIds: [equationRegion.id, sharedBodyRegion.id],
    sourceLineIds: [numeratorLine.id, denominatorLine.id],
    sourceObjectIds: ['equation-source-object'],
    assetIds: [asset.id],
    status: 'matched',
    confidence: 1,
    evidence: [
      'source-equation-region',
      'bounded-source-geometry',
      'source-page-crop',
      'source-text-transcript-unresolved',
      ...(sourceExclusionMask ? ['source-page-crop-unowned-text-masked'] : []),
    ],
    candidates: [],
    sourceBoxes: [numeratorLine.box, visualSourceBox],
    sourceText: '',
    altText: 'Equation 1',
    altTextSource: 'caption',
    canonicalNodeId: 'equation-node',
    captionNodeId: 'equation-caption',
  }
  const paper = {
    id: 'partial-equation-paper',
    version: '1.0.0',
    status: 'working',
    title: 'Partial equation ownership',
    subtitle: '',
    authors: ['Test Author'],
    updated: '2026-07-23',
    abstract: 'A source-provenance fixture.',
    nodes: [
      {
        id: 'equation-node',
        type: 'figure',
        objectType: 'equation',
        title: relationship.altText,
        relationships: {
          caption: 'equation-caption',
          assets: [asset.id],
        },
        source: 'test',
      },
      {
        id: 'equation-caption',
        type: 'caption',
        text: relationship.altText,
        source: 'test',
      },
      {
        id: 'retained-prose',
        type: 'paragraph',
        text: proseLine.text,
        source: 'test',
      },
    ],
  } satisfies ResearchPaper
  const provenance = {
    'equation-node': {
      confidence: 1,
      pages: [1],
      regionIds: [...relationship.sourceRegionIds],
      boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
      links: [],
    },
    'equation-caption': {
      confidence: 1,
      pages: [1],
      regionIds: [equationRegion.id],
      boxes: [{ ...numeratorLine.box }],
      links: [],
    },
    'retained-prose': {
      confidence: 1,
      pages: [1],
      regionIds: [sharedBodyRegion.id],
      boxes: [{ ...proseLine.box }],
      links: [],
    },
  } satisfies Record<string, NodeSourceEvidence>
  return {
    asset,
    denominatorLine,
    equationRegion,
    numeratorLine,
    paper,
    pixels,
    proseLine,
    provenance,
    relationship,
    regions: [equationRegion, sharedBodyRegion],
    sharedBodyRegion,
  }
}

async function renderOnlyEquationReplayFixture() {
  const fixture = await partialEquationFixture()
  const sourceRun = (
    text: string,
    x: number,
    width: number,
    fontName: string,
    sourceSequenceIndex: number,
  ): PdfSourceRun => ({
    ...fixture.numeratorLine.box,
    text,
    x,
    y: 0.49,
    width,
    height: 0.018,
    fontName,
    fontSize: 12,
    sourceSequenceIndex,
    confidence: 1,
  })
  const prefix = sourceRun('q = (', 0.39, 0.05, 'Synthetic-CMMI12', 12)
  const preceding = sourceRun(')', 0.44, 0.01, 'Synthetic-CMEX10', 13)
  const marker = {
    ...sourceRun('\ufffd', 0.45, 0.005, 'Synthetic-CMEX10', 14),
    sourceSemanticAdmission: {
      algorithm: 'pdf-text-item-semantic-admission-v1' as const,
      status: 'unresolved-extension-glyph' as const,
    },
  }
  const following = sourceRun('ν', 0.455, 0.01, 'Synthetic-CMMI12', 15)
  fixture.numeratorLine.runs = [prefix, preceding, following]
  const ownership = {
    algorithm: 'equation-bracketed-render-only-extension-glyph-v1' as const,
    page: 1,
    sourceLineId: fixture.numeratorLine.id,
    sourceSequenceIndex: 14,
    precedingSourceSequenceIndex: 13,
    followingSourceSequenceIndex: 15,
    sourceRunSha256: equationRenderOnlySourceRunSha256(marker),
    precedingSourceRunSha256: equationRenderOnlySourceRunSha256(preceding),
    followingSourceRunSha256: equationRenderOnlySourceRunSha256(following),
  }
  const relationship: PdfVisualRelationship = {
    ...fixture.relationship,
    evidence: [
      ...fixture.relationship.evidence,
      RENDER_ONLY_EQUATION_OWNERSHIP_EVIDENCE,
    ],
    renderOnlySourceRunOwnerships: [ownership],
  }
  const pages: PdfPageAnalysis[] = [
    {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: 16,
      imageCount: 0,
      runs: [prefix, preceding, following],
      renderVisibleTextRuns: [prefix, preceding, marker, following],
    },
  ]
  const validate = (
    candidate: PdfVisualRelationship,
    candidatePages: PdfPageAnalysis[] | null = pages,
    candidateRegions: PdfPageRegion[] | null = fixture.regions,
  ) =>
    validatedPdfVisualRelationships({
      paper: fixture.paper,
      provenance: fixture.provenance,
      relationships: [candidate],
      assets: [fixture.asset],
      regions: candidateRegions ?? undefined,
      pages: candidatePages ?? undefined,
    })
  return {
    fixture,
    following,
    marker,
    ownership,
    pages,
    preceding,
    relationship,
    validate,
  }
}

async function textOperationFilterEquationFixture() {
  const fixture = await partialEquationFixture()
  const excludedText = 'p'
  const numeratorText = normalizedPdfTextLedgerText(fixture.numeratorLine.text)
  const denominatorText = normalizedPdfTextLedgerText(
    fixture.denominatorLine.text,
  )
  const sourceTextLedgerSha256 = pdfTextLedgerSha256(
    `${excludedText}${numeratorText}${denominatorText}`,
  )
  const operatorLedgerSha256 = 'a'.repeat(64)
  const numeratorSpan = {
    start: excludedText.length,
    end: excludedText.length + numeratorText.length,
  }
  const denominatorSpan = {
    start: numeratorSpan.end,
    end: numeratorSpan.end + denominatorText.length,
  }
  fixture.numeratorLine.runs[0].sourceSequenceIndex = 1
  fixture.numeratorLine.runs[0].sourceTextPaint = {
    algorithm: 'pdfjs-text-paint-run-v1',
    textLedgerSha256: sourceTextLedgerSha256,
    normalizedTextStart: numeratorSpan.start,
    normalizedTextEnd: numeratorSpan.end,
    operatorLedgerSha256,
    operationIndexes: [2],
    filterableOperationIndexes: [2],
  }
  fixture.denominatorLine.runs[0].sourceSequenceIndex = 2
  fixture.denominatorLine.runs[0].sourceTextPaint = {
    algorithm: 'pdfjs-text-paint-run-v1',
    textLedgerSha256: sourceTextLedgerSha256,
    normalizedTextStart: denominatorSpan.start,
    normalizedTextEnd: denominatorSpan.end,
    operatorLedgerSha256,
    operationIndexes: [3],
    filterableOperationIndexes: [3],
  }
  const excludedSourceBox = {
    ...fixture.numeratorLine.box,
    x: fixture.numeratorLine.box.x + 0.01,
    y: fixture.numeratorLine.box.y + 0.002,
    width: 0.02,
    height: 0.005,
  }
  const excludedRunPaintEnvelopes = pdfTextOperationRunPaintEnvelopes({
    sourceBox: fixture.asset.sourceCropBox!,
    excludedSourceBoxes: [excludedSourceBox],
    width: fixture.asset.width,
    height: fixture.asset.height,
  })
  const sourceExclusionMask = {
    algorithm: 'pdfjs-display-text-operation-filter-v2' as const,
    expansionPixels: 0 as const,
    pdfjsVersion: PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
    pdfjsBuild: PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
    displayOperatorAdapter: PDFJS_DISPLAY_OPERATOR_ADAPTER,
    renderIntent: 'display' as const,
    annotationMode: 'enable' as const,
    sourceTextLedgerSha256,
    displayTextLedgerSha256: sourceTextLedgerSha256,
    ownedTextLedgerSpans: [numeratorSpan, denominatorSpan],
    excludedTextLedgerSpans: [{ start: 0, end: 1 }],
    operatorLedgerSha256,
    ownedOperationIndexes: [2, 3],
    excludedOperationIndexes: [1],
    ownedOnlyExcludedOperationIndexes: [1],
    ownedSourceBoxes: [fixture.numeratorLine.box, fixture.denominatorLine.box],
    excludedSourceBoxes: [excludedSourceBox],
    baselineRgbaSha256: 'b'.repeat(64),
    filteredRgbaSha256: sha256HexSync(fixture.pixels),
    ownedOnlyRgbaSha256: sha256HexSync(fixture.pixels),
    changedPixelCount: 1,
    normalizedDiffBox: { ...excludedRunPaintEnvelopes[0] },
    excludedRunPaintEnvelopes,
  } satisfies PdfSourceExclusionMask
  const asset = reidentifyPersistedSourcePageCrop({
    ...structuredClone(fixture.asset),
    sourceExclusionMask,
  })
  const relationship = {
    ...fixture.relationship,
    assetIds: [asset.id],
    evidence: [
      ...fixture.relationship.evidence,
      'source-page-crop-text-operation-filter-attested',
    ],
  }
  const paper = structuredClone(fixture.paper)
  const equationNode = paper.nodes.find(
    (node) => node.id === relationship.canonicalNodeId,
  )
  if (equationNode?.type !== 'figure') {
    throw new Error('Equation fixture is missing its canonical figure node')
  }
  equationNode.relationships.assets = [asset.id]
  return { ...fixture, asset, paper, relationship }
}

async function unionSpanningTextOperationFilterEquationFixture() {
  const fixture = await textOperationFilterEquationFixture()
  const unionOperationIndex = 9
  for (const run of [
    fixture.numeratorLine.runs[0],
    fixture.denominatorLine.runs[0],
  ]) {
    run.sourceTextPaint!.operationIndexes = [unionOperationIndex]
    run.sourceTextPaint!.filterableOperationIndexes = []
  }
  const asset = structuredClone(fixture.asset)
  if (
    asset.sourceExclusionMask?.algorithm !==
    'pdfjs-display-text-operation-filter-v2'
  ) {
    throw new Error('Equation fixture is missing its v2 exclusion mask')
  }
  asset.sourceExclusionMask.ownedOperationIndexes = [unionOperationIndex]
  reidentifyPersistedSourcePageCrop(asset)
  const relationship = {
    ...fixture.relationship,
    assetIds: [asset.id],
  }
  const paper = structuredClone(fixture.paper)
  const equationNode = paper.nodes.find(
    (node) => node.id === relationship.canonicalNodeId,
  )
  if (equationNode?.type !== 'figure') {
    throw new Error('Equation fixture is missing its canonical figure node')
  }
  equationNode.relationships.assets = [asset.id]
  return {
    ...fixture,
    asset,
    paper,
    relationship,
    unionOperationIndex,
  }
}

async function geometryTranscriptEquationFixture() {
  const fixture = await partialEquationFixture()
  const runs = [
    {
      ...fixture.numeratorLine.runs[0],
      text: 'x',
      x: 0.41,
      y: 0.498,
      width: 0.01,
      height: 0.008,
      fontName: 'Synthetic-CMMI10',
      fontSize: 10,
      sourceSequenceIndex: 0,
    },
    {
      ...fixture.numeratorLine.runs[0],
      text: '2',
      x: 0.421,
      y: 0.493,
      width: 0.005,
      height: 0.004,
      fontName: 'Synthetic-CMMI10',
      fontSize: 7,
      sourceSequenceIndex: 1,
    },
    {
      ...fixture.numeratorLine.runs[0],
      text: '=',
      x: 0.43,
      y: 0.498,
      width: 0.008,
      height: 0.008,
      fontName: 'Synthetic-CMSY10',
      fontSize: 10,
      sourceSequenceIndex: 2,
    },
    {
      ...fixture.numeratorLine.runs[0],
      text: 'y',
      x: 0.445,
      y: 0.498,
      width: 0.01,
      height: 0.008,
      fontName: 'Synthetic-CMMI10',
      fontSize: 10,
      sourceSequenceIndex: 3,
    },
  ]
  const formulaBox = textBox(0.41, 0.493, 0.045, 0.013)
  fixture.numeratorLine.text = 'x2=y'
  fixture.numeratorLine.fontSize = 10
  fixture.numeratorLine.box = formulaBox
  fixture.numeratorLine.runs = runs
  fixture.equationRegion.text = fixture.numeratorLine.text
  fixture.equationRegion.box = formulaBox
  fixture.equationRegion.lines = [fixture.numeratorLine]
  fixture.relationship.sourceRegionIds = [fixture.equationRegion.id]
  fixture.relationship.sourceLineIds = [fixture.numeratorLine.id]
  fixture.relationship.sourceBoxes = [formulaBox, fixture.asset.sourceBoxes[0]]
  fixture.relationship.evidence = [
    'source-equation-region',
    'bounded-source-geometry',
    'source-page-crop',
    SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
  ]
  fixture.provenance['equation-node'].regionIds = [fixture.equationRegion.id]
  fixture.provenance['equation-node'].boxes =
    fixture.relationship.sourceBoxes.map((box) => ({ ...box }))
  fixture.provenance['equation-caption'].boxes = [{ ...formulaBox }]
  fixture.relationship.equationGeometryTranscript =
    createSourceGeometryScriptTranscript({
      sourceRegionIds: fixture.relationship.sourceRegionIds,
      sourceLineIds: fixture.relationship.sourceLineIds,
      sourceObjectIds: fixture.relationship.sourceObjectIds,
      regions: fixture.regions,
      sourceCropAsset: fixture.asset,
    })!
  if (!fixture.relationship.equationGeometryTranscript) {
    throw new Error('Expected an exact source-geometry transcript fixture')
  }
  return fixture
}

function withAdditionalMaskedAsset(
  fixture: {
    asset: PdfVisualAsset
    paper: ResearchPaper
    provenance: Record<string, NodeSourceEvidence>
    relationship: PdfVisualRelationship
  },
  additionalAsset: PdfVisualAsset,
  evidence: string[],
) {
  const relationship = {
    ...fixture.relationship,
    sourceObjectIds: [
      ...fixture.relationship.sourceObjectIds,
      ...additionalAsset.sourceObjectIds,
    ],
    assetIds: [...fixture.relationship.assetIds, additionalAsset.id],
    sourceBoxes: [
      ...fixture.relationship.sourceBoxes,
      ...additionalAsset.sourceBoxes,
    ],
    evidence,
  }
  const paper = structuredClone(fixture.paper)
  const equationNode = paper.nodes.find(
    (node) => node.id === relationship.canonicalNodeId,
  )
  if (equationNode?.type !== 'figure') {
    throw new Error('Equation fixture is missing its canonical figure node')
  }
  equationNode.relationships.assets = [...relationship.assetIds]
  const provenance = structuredClone(fixture.provenance)
  provenance['equation-node'].boxes = relationship.sourceBoxes.map((box) => ({
    ...box,
  }))
  return { paper, provenance, relationship }
}

describe('PDF visual relationship line-scoped ownership', () => {
  it('rejects deletion of render-only proof, marker inventory, or replay inputs', async () => {
    const source = await renderOnlyEquationReplayFixture()
    const strippedRelationship = {
      ...source.relationship,
      evidence: source.relationship.evidence.filter(
        (item) => item !== RENDER_ONLY_EQUATION_OWNERSHIP_EVIDENCE,
      ),
      renderOnlySourceRunOwnerships: undefined,
    }
    const markerDeletedPages = structuredClone(source.pages)
    markerDeletedPages[0].renderVisibleTextRuns =
      markerDeletedPages[0].renderVisibleTextRuns!.filter(
        (run) => run.sourceSequenceIndex !== source.marker.sourceSequenceIndex,
      )
    const inventoryDeletedPages = structuredClone(source.pages)
    delete inventoryDeletedPages[0].renderVisibleTextRuns
    const duplicateAfterDeletion = [
      ...markerDeletedPages,
      {
        ...structuredClone(markerDeletedPages[0]),
        runs: [],
        renderVisibleTextRuns: [],
      },
    ]

    expect
      .soft(source.validate(strippedRelationship, markerDeletedPages))
      .toEqual([])
    expect
      .soft(source.validate(strippedRelationship, inventoryDeletedPages))
      .toEqual([])
    expect.soft(source.validate(strippedRelationship, [])).toEqual([])
    expect.soft(source.validate(strippedRelationship, null)).toEqual([])
    expect
      .soft(source.validate(strippedRelationship, source.pages, null))
      .toEqual([])
    expect
      .soft(source.validate(strippedRelationship, duplicateAfterDeletion))
      .toEqual([])
  })

  it('accepts a no-marker source-page-crop equation with complete replay', async () => {
    const fixture = await partialEquationFixture()
    const semanticRuns = fixture.regions.flatMap((region) =>
      region.lines.flatMap((line) => line.runs),
    )
    const pages: PdfPageAnalysis[] = [
      {
        page: 1,
        kind: 'born-digital',
        width: 612,
        height: 792,
        rotation: 0,
        textCharacters: semanticRuns.reduce(
          (total, run) => total + run.text.length,
          0,
        ),
        imageCount: 0,
        runs: semanticRuns,
        renderVisibleTextRuns: semanticRuns,
      },
    ]

    expect(
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [fixture.relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
        pages,
      }),
    ).toEqual([fixture.relationship])
  })

  it('accepts a uniquely recomposed caption box within one persisted source-coordinate quantum', async () => {
    const fixture = await partialEquationFixture()
    fixture.provenance['equation-caption'].boxes = [
      textBox(0.39, 0.49, 0.1, 0.018),
      textBox(0.49, 0.49, 0.129994, 0.018),
    ]

    expect(
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [fixture.relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
        pages: replayPages(fixture.regions),
      }),
    ).toEqual([fixture.relationship])
  })

  it('rejects a recomposed caption box beyond one persisted source-coordinate quantum', async () => {
    const fixture = await partialEquationFixture()
    fixture.provenance['equation-caption'].boxes = [
      textBox(0.39, 0.49, 0.1, 0.018),
      textBox(0.49, 0.49, 0.129984, 0.018),
    ]

    expect(
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [fixture.relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
        pages: replayPages(fixture.regions),
      }),
    ).toEqual([])
  })

  it('replays render-only equation ownership and rejects a drifted source-item binding', async () => {
    const fixture = await partialEquationFixture()
    const sourceRun = (
      text: string,
      x: number,
      width: number,
      fontName: string,
      sourceSequenceIndex: number,
    ): PdfSourceRun => ({
      ...fixture.numeratorLine.box,
      text,
      x,
      y: 0.49,
      width,
      height: 0.018,
      fontName,
      fontSize: 12,
      sourceSequenceIndex,
      confidence: 1,
    })
    const prefix = sourceRun('q = (', 0.39, 0.05, 'Synthetic-CMMI12', 12)
    const preceding = sourceRun(')', 0.44, 0.01, 'Synthetic-CMEX10', 13)
    const marker = {
      ...sourceRun('\ufffd', 0.45, 0.005, 'Synthetic-CMEX10', 14),
      sourceSemanticAdmission: {
        algorithm: 'pdf-text-item-semantic-admission-v1' as const,
        status: 'unresolved-extension-glyph' as const,
      },
    }
    const following = sourceRun('ν', 0.455, 0.01, 'Synthetic-CMMI12', 15)
    fixture.numeratorLine.runs = [prefix, preceding, following]
    const ownership = {
      algorithm: 'equation-bracketed-render-only-extension-glyph-v1' as const,
      page: 1,
      sourceLineId: fixture.numeratorLine.id,
      sourceSequenceIndex: 14,
      precedingSourceSequenceIndex: 13,
      followingSourceSequenceIndex: 15,
      sourceRunSha256: equationRenderOnlySourceRunSha256(marker),
      precedingSourceRunSha256: equationRenderOnlySourceRunSha256(preceding),
      followingSourceRunSha256: equationRenderOnlySourceRunSha256(following),
    }
    const relationship: PdfVisualRelationship = {
      ...fixture.relationship,
      evidence: [
        ...fixture.relationship.evidence,
        RENDER_ONLY_EQUATION_OWNERSHIP_EVIDENCE,
      ],
      renderOnlySourceRunOwnerships: [ownership],
    }
    const pages: PdfPageAnalysis[] = [
      {
        page: 1,
        kind: 'born-digital',
        width: 612,
        height: 792,
        rotation: 0,
        textCharacters: 16,
        imageCount: 0,
        runs: [prefix, preceding, following],
        renderVisibleTextRuns: [prefix, preceding, marker, following],
      },
    ]
    const validate = (
      candidate: PdfVisualRelationship,
      candidatePages: PdfPageAnalysis[] = pages,
    ) =>
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [candidate],
        assets: [fixture.asset],
        regions: fixture.regions,
        pages: candidatePages,
      } as Parameters<typeof validatedPdfVisualRelationships>[0] & {
        pages: PdfPageAnalysis[]
      })

    expect(validate(relationship)).toEqual([relationship])
    expect(
      validate({
        ...relationship,
        renderOnlySourceRunOwnerships: undefined,
      }),
    ).toEqual([])
    expect(
      validate({
        ...relationship,
        evidence: relationship.evidence.filter(
          (item) => item !== RENDER_ONLY_EQUATION_OWNERSHIP_EVIDENCE,
        ),
      }),
    ).toEqual([])
    const strippedRelationship = {
      ...relationship,
      evidence: relationship.evidence.filter(
        (item) => item !== RENDER_ONLY_EQUATION_OWNERSHIP_EVIDENCE,
      ),
      renderOnlySourceRunOwnerships: undefined,
    }
    expect(validate(strippedRelationship)).toEqual([])
    const strippedAdmissionPages = structuredClone(pages)
    delete strippedAdmissionPages[0].renderVisibleTextRuns![2]
      .sourceSemanticAdmission
    expect(validate(strippedRelationship, strippedAdmissionPages)).toEqual([])
    for (const drift of [
      { sourceRunSha256: 'f'.repeat(64) },
      { precedingSourceRunSha256: 'e'.repeat(64) },
      { followingSourceRunSha256: 'd'.repeat(64) },
      { sourceLineId: 'drifted-equation-line' },
      { sourceSequenceIndex: 114 },
      { page: 2 },
    ]) {
      expect(
        validate({
          ...relationship,
          renderOnlySourceRunOwnerships: [
            {
              ...ownership,
              ...drift,
            },
          ],
        }),
      ).toEqual([])
    }
    const driftedPages = structuredClone(pages)
    driftedPages[0].renderVisibleTextRuns![2].x += 0.000_01
    expect(validate(relationship, driftedPages)).toEqual([])
  })

  it('rejects a persisted v2 crop when same-size PNG pixels are swapped and its content identity is recomputed', async () => {
    const fixture = await textOperationFilterEquationFixture()
    const persistedAsset = fixture.asset
    const relationship = fixture.relationship
    const paper = fixture.paper
    const validate = (
      candidateAsset: PdfVisualAsset,
      candidateRelationship = relationship,
      candidatePaper = paper,
    ) =>
      validatedPdfVisualRelationships({
        paper: candidatePaper,
        provenance: fixture.provenance,
        relationships: [candidateRelationship],
        assets: [candidateAsset],
        regions: fixture.regions,
        pages: replayPages(fixture.regions),
      })

    expect(validate(persistedAsset)).toEqual([relationship])

    const alternatePixels = fixture.pixels.slice()
    alternatePixels[0] = 254
    const alternateAsset = await createSourcePageCropAsset({
      kind: 'equation',
      cropBox: persistedAsset.sourceCropBox!,
      sourceObjectIds: [...persistedAsset.sourceObjectIds],
      sourceBoxes: persistedAsset.sourceBoxes.map((box) => ({ ...box })),
      width: persistedAsset.width,
      height: persistedAsset.height,
      pixels: alternatePixels,
    })
    const swappedAsset = reidentifyPersistedSourcePageCrop({
      ...structuredClone(persistedAsset),
      bytes: alternateAsset.bytes,
    })
    const swappedRelationship = {
      ...relationship,
      assetIds: [swappedAsset.id],
    }
    const swappedPaper = structuredClone(paper)
    const swappedEquationNode = swappedPaper.nodes.find(
      (node) => node.id === swappedRelationship.canonicalNodeId,
    )
    if (swappedEquationNode?.type !== 'figure') {
      throw new Error('Equation fixture is missing its canonical figure node')
    }
    swappedEquationNode.relationships.assets = [swappedAsset.id]

    expect(validate(swappedAsset, swappedRelationship, swappedPaper)).toEqual(
      [],
    )
  })

  it('requires exactly one v2 text-operation-filter claim for a v2 mask', async () => {
    const fixture = await textOperationFilterEquationFixture()
    const validate = (relationship: PdfVisualRelationship) =>
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
        pages: replayPages(fixture.regions),
      })
    const evidenceWithoutMaskClaims = fixture.relationship.evidence.filter(
      (item) =>
        item !== 'source-page-crop-unowned-text-masked' &&
        item !== 'source-page-crop-text-operation-filter-attested',
    )

    expect(validate(fixture.relationship)).toEqual([fixture.relationship])
    for (const evidence of [
      evidenceWithoutMaskClaims,
      [...evidenceWithoutMaskClaims, 'source-page-crop-unowned-text-masked'],
      [
        ...evidenceWithoutMaskClaims,
        'source-page-crop-unowned-text-masked',
        'source-page-crop-text-operation-filter-attested',
      ],
      [
        ...evidenceWithoutMaskClaims,
        'source-page-crop-text-operation-filter-attested',
        'source-page-crop-text-operation-filter-attested',
      ],
    ]) {
      expect(
        validate({
          ...fixture.relationship,
          evidence,
        }),
      ).toEqual([])
    }
  })

  it('rejects a persisted v2 crop when its owned source-paint provenance is stale', async () => {
    const fixture = await textOperationFilterEquationFixture()
    const validate = (regions: PdfPageRegion[] | undefined) =>
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [fixture.relationship],
        assets: [fixture.asset],
        regions,
        pages: replayPages(regions),
      })

    expect(validate(fixture.regions)).toEqual([fixture.relationship])

    const mutations: Array<(regions: PdfPageRegion[]) => void> = [
      (regions) => {
        regions[0].lines[0].runs[0].sourceTextPaint!.textLedgerSha256 =
          'd'.repeat(64)
      },
      (regions) => {
        regions[0].lines[0].runs[0].sourceTextPaint!.operatorLedgerSha256 =
          'd'.repeat(64)
      },
      (regions) => {
        regions[0].lines[0].runs[0].sourceTextPaint!.normalizedTextStart += 1
      },
      (regions) => {
        regions[0].lines[0].runs[0].sourceTextPaint!.filterableOperationIndexes =
          [7]
      },
      (regions) => {
        regions[0].lines[0].runs[0].x += 0.001
      },
      (regions) => {
        delete regions[0].lines[0].runs[0].sourceTextPaint
      },
    ]
    for (const mutate of mutations) {
      const staleRegions = structuredClone(fixture.regions)
      mutate(staleRegions)
      expect(validate(staleRegions)).toEqual([])
    }
    expect(validate(undefined)).toEqual([])
  })

  it('accepts one display operation exactly contained by the union of adjacent owned runs', async () => {
    const fixture = await unionSpanningTextOperationFilterEquationFixture()

    expect(
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [fixture.relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
        pages: replayPages(fixture.regions),
      }),
    ).toEqual([fixture.relationship])
    expect(
      fixture.regions.flatMap((candidateRegion) =>
        candidateRegion.lines.flatMap((candidateLine) =>
          candidateLine.runs.flatMap(
            (candidateRun) =>
              candidateRun.sourceTextPaint?.filterableOperationIndexes ?? [],
          ),
        ),
      ),
    ).toEqual([])
  })

  it.each([
    {
      name: 'partially unowned operation span',
      mutate: (
        fixture: Awaited<
          ReturnType<typeof unionSpanningTextOperationFilterEquationFixture>
        >,
        regions: PdfPageRegion[],
      ) => {
        const proseRun = regions[1].lines[1].runs[0]
        proseRun.text = 'p'
        proseRun.sourceTextPaint = {
          ...structuredClone(fixture.numeratorLine.runs[0].sourceTextPaint!),
          normalizedTextStart: 0,
          normalizedTextEnd: 1,
          operationIndexes: [fixture.unionOperationIndex],
          filterableOperationIndexes: [],
        }
      },
    },
    {
      name: 'cross-equation operation reuse',
      mutate: (
        fixture: Awaited<
          ReturnType<typeof unionSpanningTextOperationFilterEquationFixture>
        >,
        regions: PdfPageRegion[],
      ) => {
        const decoyLine = structuredClone(fixture.denominatorLine)
        decoyLine.id = 'unowned-equation-decoy-line'
        decoyLine.runs[0].text = 'z'
        decoyLine.runs[0].sourceSequenceIndex = 99
        decoyLine.runs[0].sourceTextPaint = {
          ...structuredClone(fixture.denominatorLine.runs[0].sourceTextPaint!),
          operationIndexes: [fixture.unionOperationIndex],
          filterableOperationIndexes: [],
        }
        regions.push(region('unowned-equation-decoy', 'equation', [decoyLine]))
      },
    },
    {
      name: 'cross-page owned union',
      mutate: (
        _fixture: Awaited<
          ReturnType<typeof unionSpanningTextOperationFilterEquationFixture>
        >,
        regions: PdfPageRegion[],
      ) => {
        regions[1].lines[0].runs[0].page = 2
      },
    },
    {
      name: 'ambiguous duplicate paint ownership',
      mutate: (
        fixture: Awaited<
          ReturnType<typeof unionSpanningTextOperationFilterEquationFixture>
        >,
        regions: PdfPageRegion[],
      ) => {
        const duplicateLine = structuredClone(fixture.numeratorLine)
        duplicateLine.id = 'ambiguous-duplicate-paint-line'
        regions.push(
          region('ambiguous-duplicate-paint-region', 'body', [duplicateLine]),
        )
      },
    },
  ])(
    'rejects union-spanning text-operation proof with $name',
    async ({ mutate }) => {
      const fixture = await unionSpanningTextOperationFilterEquationFixture()
      const regions = structuredClone(fixture.regions)
      mutate(fixture, regions)

      expect(
        validatedPdfVisualRelationships({
          paper: fixture.paper,
          provenance: fixture.provenance,
          relationships: [fixture.relationship],
          assets: [fixture.asset],
          regions,
          pages: replayPages(regions),
        }),
      ).toEqual([])
    },
  )

  it('accepts full-precision PDF run boxes when their rounded ownership identity is unchanged', async () => {
    const fixture = await textOperationFilterEquationFixture()
    const regions = structuredClone(fixture.regions)
    const numeratorRun = regions[0].lines[0].runs[0]
    const denominatorRun = regions[1].lines[0].runs[0]
    Object.assign(numeratorRun, {
      x: 0.390123456789,
      y: 0.490123456789,
      width: 0.229654321987,
      height: 0.017654321987,
    })
    Object.assign(denominatorRun, {
      x: 0.490123456789,
      y: 0.505123456789,
      width: 0.024654321987,
      height: 0.013654321987,
    })
    const ownedSourceBoxes = [numeratorRun, denominatorRun].map((run) =>
      textBox(run.x, run.y, run.width, run.height),
    )
    const asset = reidentifyPersistedSourcePageCrop(
      structuredClone(fixture.asset),
    )
    if (
      asset.sourceExclusionMask?.algorithm !==
      'pdfjs-display-text-operation-filter-v2'
    ) {
      throw new Error('Equation fixture is missing its v2 exclusion mask')
    }
    asset.sourceExclusionMask.ownedSourceBoxes = ownedSourceBoxes
    reidentifyPersistedSourcePageCrop(asset)
    const relationship = {
      ...fixture.relationship,
      assetIds: [asset.id],
    }
    const paper = structuredClone(fixture.paper)
    const equationNode = paper.nodes.find(
      (node) => node.id === relationship.canonicalNodeId,
    )
    if (equationNode?.type !== 'figure') {
      throw new Error('Equation fixture is missing its canonical figure node')
    }
    equationNode.relationships.assets = [asset.id]

    expect(
      validatedPdfVisualRelationships({
        paper,
        provenance: fixture.provenance,
        relationships: [relationship],
        assets: [asset],
        regions,
        pages: replayPages(regions),
      }),
    ).toEqual([relationship])
  })

  it('requires source-geometry transcript evidence and payload to match exactly once', async () => {
    const fixture = await geometryTranscriptEquationFixture()
    const validate = (relationship: PdfVisualRelationship) =>
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
        pages: replayPages(fixture.regions),
      })
    const evidenceWithoutTranscript = fixture.relationship.evidence.filter(
      (item) => item !== SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
    )

    expect(validate(fixture.relationship)).toEqual([fixture.relationship])
    for (const relationship of [
      {
        ...fixture.relationship,
        evidence: evidenceWithoutTranscript,
      },
      {
        ...fixture.relationship,
        evidence: [
          ...evidenceWithoutTranscript,
          SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
          SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
        ],
      },
      {
        ...fixture.relationship,
        equationGeometryTranscript: undefined,
      },
      {
        ...fixture.relationship,
        evidence: [
          ...evidenceWithoutTranscript,
          SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
          SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
        ],
        equationGeometryTranscript: undefined,
      },
    ]) {
      expect(validate(relationship)).toEqual([])
    }
  })

  it('requires exactly one v1 unowned-text-mask claim for a v1 mask', async () => {
    const fixture = await partialEquationFixture({
      algorithm: 'nearest-source-box-v1',
      expansionPixels: 2,
      ownedSourceBoxes: [
        textBox(0.39, 0.49, 0.23, 0.018),
        textBox(0.49, 0.505, 0.025, 0.014),
      ],
      excludedSourceBoxes: [textBox(0.39, 0.486, 0.05, 0.004)],
    })
    const validate = (relationship: PdfVisualRelationship) =>
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
        pages: replayPages(fixture.regions),
      })
    const evidenceWithoutMaskClaims = fixture.relationship.evidence.filter(
      (item) =>
        item !== 'source-page-crop-unowned-text-masked' &&
        item !== 'source-page-crop-text-operation-filter-attested',
    )

    expect(validate(fixture.relationship)).toEqual([fixture.relationship])
    for (const evidence of [
      evidenceWithoutMaskClaims,
      [
        ...evidenceWithoutMaskClaims,
        'source-page-crop-text-operation-filter-attested',
      ],
      [
        ...evidenceWithoutMaskClaims,
        'source-page-crop-unowned-text-masked',
        'source-page-crop-text-operation-filter-attested',
      ],
      [
        ...evidenceWithoutMaskClaims,
        'source-page-crop-unowned-text-masked',
        'source-page-crop-unowned-text-masked',
      ],
    ]) {
      expect(
        validate({
          ...fixture.relationship,
          evidence,
        }),
      ).toEqual([])
    }
  })

  it('rejects duplicate or mixed exclusion masks even when their asset lineage is unique', async () => {
    const v1Fixture = await partialEquationFixture({
      algorithm: 'nearest-source-box-v1',
      expansionPixels: 2,
      ownedSourceBoxes: [
        textBox(0.39, 0.49, 0.23, 0.018),
        textBox(0.49, 0.505, 0.025, 0.014),
      ],
      excludedSourceBoxes: [textBox(0.39, 0.486, 0.05, 0.004)],
    })
    const duplicateV1Asset = reidentifyPersistedSourcePageCrop({
      ...structuredClone(v1Fixture.asset),
      sourceObjectIds: ['duplicate-v1-source-object'],
    })
    const duplicateV1 = withAdditionalMaskedAsset(v1Fixture, duplicateV1Asset, [
      ...v1Fixture.relationship.evidence,
    ])
    expect(
      validatedPdfVisualRelationships({
        paper: duplicateV1.paper,
        provenance: duplicateV1.provenance,
        relationships: [duplicateV1.relationship],
        assets: [v1Fixture.asset, duplicateV1Asset],
        regions: v1Fixture.regions,
        pages: replayPages(v1Fixture.regions),
      }),
    ).toEqual([])

    const v2Fixture = await textOperationFilterEquationFixture()
    const v1Asset = await createSourcePageCropAsset({
      kind: 'equation',
      cropBox: v2Fixture.asset.sourceCropBox!,
      sourceObjectIds: ['mixed-v1-source-object'],
      sourceBoxes: v2Fixture.asset.sourceBoxes.map((box) => ({ ...box })),
      width: v2Fixture.asset.width,
      height: v2Fixture.asset.height,
      pixels: v2Fixture.pixels,
      sourceExclusionMask: {
        algorithm: 'nearest-source-box-v1',
        expansionPixels: 2,
        ownedSourceBoxes: [
          v2Fixture.numeratorLine.box,
          v2Fixture.denominatorLine.box,
        ],
        excludedSourceBoxes: [textBox(0.39, 0.486, 0.05, 0.004)],
      },
    })
    const mixed = withAdditionalMaskedAsset(v2Fixture, v1Asset, [
      ...v2Fixture.relationship.evidence,
      'source-page-crop-unowned-text-masked',
    ])
    expect(
      validatedPdfVisualRelationships({
        paper: mixed.paper,
        provenance: mixed.provenance,
        relationships: [mixed.relationship],
        assets: [v2Fixture.asset, v1Asset],
        regions: v2Fixture.regions,
        pages: replayPages(v2Fixture.regions),
      }),
    ).toEqual([])
  })

  it('rejects a source crop when its exact exclusion-mask proof is mutated or dropped', async () => {
    const ownedNumerator = textBox(0.39, 0.49, 0.23, 0.018)
    const ownedDenominator = textBox(0.49, 0.505, 0.025, 0.014)
    const fixture = await partialEquationFixture({
      algorithm: 'nearest-source-box-v1',
      expansionPixels: 2,
      ownedSourceBoxes: [ownedNumerator, ownedDenominator],
      excludedSourceBoxes: [textBox(0.39, 0.486, 0.05, 0.004)],
    })
    const validate = (asset: typeof fixture.asset) =>
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [fixture.relationship],
        assets: [asset],
        regions: fixture.regions,
        pages: replayPages(fixture.regions),
      })

    expect(validate(fixture.asset)).toEqual([fixture.relationship])

    const mutated = structuredClone(fixture.asset)
    mutated.sourceExclusionMask!.excludedSourceBoxes[0].x += Number.EPSILON
    expect(validate(mutated)).toEqual([])

    const dropped = structuredClone(fixture.asset)
    delete dropped.sourceExclusionMask
    expect(validate(dropped)).toEqual([])
  })

  it('retains an exact equation crop when only selected lines share a prose region', async () => {
    const fixture = await partialEquationFixture()

    expect(
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [fixture.relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
        pages: replayPages(fixture.regions),
      }),
    ).toEqual([fixture.relationship])
  })

  it.each([
    {
      name: 'distinct source-sequence identities',
      proseSourceSequenceIndex: 2,
      inventoryMutation: 'none',
      valid: true,
    },
    {
      name: 'a duplicate selected source-sequence identity',
      proseSourceSequenceIndex: 1,
      inventoryMutation: 'none',
      valid: false,
    },
    {
      name: 'no source-sequence identity',
      proseSourceSequenceIndex: undefined,
      inventoryMutation: 'none',
      valid: false,
    },
    {
      name: 'a negative source-sequence identity',
      proseSourceSequenceIndex: -1,
      inventoryMutation: 'none',
      valid: false,
    },
    {
      name: 'no render-visible source ledger',
      proseSourceSequenceIndex: 2,
      inventoryMutation: 'remove-visible-ledger',
      valid: false,
    },
    {
      name: 'an owner omitted from the render-visible source ledger',
      proseSourceSequenceIndex: 2,
      inventoryMutation: 'omit-visible-owner',
      valid: false,
    },
    {
      name: 'a duplicate owner identity in the raw source ledger',
      proseSourceSequenceIndex: 2,
      inventoryMutation: 'duplicate-raw-owner',
      valid: false,
    },
    {
      name: 'stale owner data in the raw source ledger',
      proseSourceSequenceIndex: 2,
      inventoryMutation: 'mutate-raw-owner',
      valid: false,
    },
    {
      name: 'a duplicate owner identity in the render-visible source ledger',
      proseSourceSequenceIndex: 2,
      inventoryMutation: 'duplicate-visible-owner',
      valid: false,
    },
    {
      name: 'stale owner data in the render-visible source ledger',
      proseSourceSequenceIndex: 2,
      inventoryMutation: 'mutate-visible-owner',
      valid: false,
    },
  ])(
    'treats geometric run overlap as safe only with $name',
    async ({ proseSourceSequenceIndex, inventoryMutation, valid }) => {
      const fixture = await partialEquationFixture()
      fixture.numeratorLine.runs[0].sourceSequenceIndex = 0
      fixture.denominatorLine.runs[0].sourceSequenceIndex = 1
      fixture.proseLine.box.y = 0.5155
      fixture.proseLine.runs[0].y = 0.5155
      fixture.proseLine.runs[0].sourceSequenceIndex =
        proseSourceSequenceIndex
      fixture.provenance['retained-prose'].boxes = [
        { ...fixture.proseLine.runs[0] },
      ]
      const pages = replayPages(fixture.regions)
      const page = pages?.[0]
      if (!page?.renderVisibleTextRuns) {
        throw new Error('Expected a replay page with visible source runs.')
      }
      page.runs = page.runs.map((run) => ({ ...run }))
      page.renderVisibleTextRuns = page.renderVisibleTextRuns.map((run) => ({
        ...run,
      }))
      if (inventoryMutation === 'remove-visible-ledger') {
        page.renderVisibleTextRuns = undefined
      } else if (inventoryMutation === 'omit-visible-owner') {
        page.renderVisibleTextRuns = page.renderVisibleTextRuns.filter(
          (run) => run.sourceSequenceIndex !== proseSourceSequenceIndex,
        )
      } else if (inventoryMutation === 'duplicate-raw-owner') {
        page.runs.push({ ...fixture.proseLine.runs[0] })
      } else if (inventoryMutation === 'mutate-raw-owner') {
        page.runs = page.runs.map((run) =>
          run.sourceSequenceIndex === proseSourceSequenceIndex
            ? { ...run, fontName: `${run.fontName}-stale` }
            : run,
        )
      } else if (inventoryMutation === 'duplicate-visible-owner') {
        page.renderVisibleTextRuns.push({ ...fixture.proseLine.runs[0] })
      } else if (inventoryMutation === 'mutate-visible-owner') {
        page.renderVisibleTextRuns = page.renderVisibleTextRuns.map((run) =>
          run.sourceSequenceIndex === proseSourceSequenceIndex
            ? { ...run, fontName: `${run.fontName}-stale` }
            : run,
        )
      }
      const input = {
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [fixture.relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
        pages,
      }

      expect(validatedPdfVisualRelationships(input)).toEqual(
        valid ? [fixture.relationship] : [],
      )
      expect(
        collectMatchedPdfVisualRelationshipContradictions(input),
      ).toEqual(
        valid
          ? []
          : [
              expect.objectContaining({
                relationshipId: fixture.relationship.id,
                code: 'competing-canonical-owner-scope',
              }),
            ],
      )
    },
  )

  it('rejects duplicate canonical or caption relationship ownership', async () => {
    const fixture = await partialEquationFixture()
    for (const duplicate of [
      {
        ...fixture.relationship,
        id: 'duplicate-canonical-owner',
        captionNodeId: 'independent-caption-node',
      },
      {
        ...fixture.relationship,
        id: 'duplicate-caption-owner',
        canonicalNodeId: 'independent-canonical-node',
      },
    ]) {
      expect(
        validatedPdfVisualRelationships({
          paper: fixture.paper,
          provenance: fixture.provenance,
          relationships: [fixture.relationship, duplicate],
          assets: [fixture.asset],
          regions: fixture.regions,
          pages: replayPages(fixture.regions),
        }),
      ).toEqual([])
    }
  })

  it('rejects a line-scoped equation when a competing canonical owner overlaps the selected line', async () => {
    const fixture = await partialEquationFixture()
    const provenance = {
      ...fixture.provenance,
      'retained-prose': {
        ...fixture.provenance['retained-prose'],
        boxes: [
          fixture.proseLine.box,
          {
            ...fixture.denominatorLine.box,
          },
        ],
      },
    }

    expect(
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance,
        relationships: [fixture.relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
        pages: replayPages(fixture.regions),
      }),
    ).toEqual([])
  })

  it('collects every matched relationship and asset contradiction without weakening fail-closed validation', async () => {
    const fixture = await partialEquationFixture()
    const provenance = {
      ...fixture.provenance,
      'retained-prose': {
        ...fixture.provenance['retained-prose'],
        boxes: [
          fixture.proseLine.box,
          {
            ...fixture.denominatorLine.box,
          },
        ],
      },
    }
    const asset = {
      ...structuredClone(fixture.asset),
      sha256: '0'.repeat(64),
    }
    const relationship = {
      ...fixture.relationship,
      sourceObjectIds: ['different-source-object'],
    }
    const input = {
      paper: fixture.paper,
      provenance,
      relationships: [relationship],
      assets: [asset],
      regions: fixture.regions,
      pages: replayPages(fixture.regions),
    }

    expect(
      collectMatchedPdfVisualRelationshipContradictions({
        ...input,
        provenance: fixture.provenance,
        relationships: [fixture.relationship],
        assets: [fixture.asset],
      }),
    ).toEqual([])
    expect(
      collectMatchedPdfVisualRelationshipContradictions(input),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relationshipId: relationship.id,
          code: 'competing-canonical-owner-scope',
        }),
        expect.objectContaining({
          relationshipId: relationship.id,
          assetId: asset.id,
          code: 'asset-content',
        }),
        expect.objectContaining({
          relationshipId: relationship.id,
          code: 'asset-object-lineage',
        }),
      ]),
    )
    expect(validatedPdfVisualRelationships(input)).toEqual([])
  })

  it('rejects missing, forged, or non-unique equation line scope', async () => {
    const fixture = await partialEquationFixture()
    const duplicateLineRegion = region('duplicate-line-region', 'body', [
      line(
        fixture.denominatorLine.id,
        'forged duplicate',
        textBox(0.15, 0.72, 0.2, 0.018),
      ),
    ])
    const cases: Array<{
      sourceLineIds: string[]
      regions: PdfPageRegion[]
    }> = [
      {
        sourceLineIds: [
          fixture.numeratorLine.id,
          'missing-equation-source-line',
        ],
        regions: fixture.regions,
      },
      {
        sourceLineIds: [fixture.numeratorLine.id, fixture.proseLine.id],
        regions: fixture.regions,
      },
      {
        sourceLineIds: [fixture.numeratorLine.id, fixture.denominatorLine.id],
        regions: [...fixture.regions, duplicateLineRegion],
      },
    ]

    for (const testCase of cases) {
      expect(
        validatedPdfVisualRelationships({
          paper: fixture.paper,
          provenance: fixture.provenance,
          relationships: [
            {
              ...fixture.relationship,
              sourceLineIds: testCase.sourceLineIds,
            },
          ],
          assets: [fixture.asset],
          regions: testCase.regions,
          pages: replayPages(testCase.regions),
        }),
      ).toEqual([])
    }
  })

  it('rejects a matched equation that owns only the formula fragment of an inline stacked line', async () => {
    const fixture = await partialEquationFixture()
    const fragmentBaseId = 'page-001-inline-stacked-0001'
    const formulaLineId = `${fragmentBaseId}-formula`
    fixture.numeratorLine.id = formulaLineId
    const captionFragments = region('inline-caption-fragments', 'caption', [
      line(
        `${fragmentBaseId}-before`,
        'Caption text before',
        textBox(0.12, 0.49, 0.25, 0.018),
        'Synthetic-CMR12',
      ),
      line(
        `${fragmentBaseId}-after`,
        'and after',
        textBox(0.64, 0.49, 0.12, 0.018),
        'Synthetic-CMR12',
      ),
    ])

    expect(
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [
          {
            ...fixture.relationship,
            sourceLineIds: [formulaLineId, fixture.denominatorLine.id],
          },
        ],
        assets: [fixture.asset],
        regions: [...fixture.regions, captionFragments],
        pages: replayPages([...fixture.regions, captionFragments]),
      }),
    ).toEqual([])
  })
})
