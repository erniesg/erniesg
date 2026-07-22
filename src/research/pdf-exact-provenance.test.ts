import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderGraph,
  PdfSourceRun,
} from './import-types'
import { assessPdfCompleteness } from './pdf-quality'
import type { ResearchPaper } from './schema'

function sourceRun(text: string, y: number): PdfSourceRun {
  return {
    page: 1,
    text,
    x: 0.1,
    y,
    width: 0.75,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName: 'Body',
    fontSize: 10,
    confidence: 1,
  }
}

function sourceTruth(values: string[]) {
  const runs = values.map((value, index) =>
    sourceRun(value, 0.2 + index * 0.05),
  )
  const regions = runs.map(
    (run, index) =>
      ({
        id: `region-${index + 1}`,
        page: 1,
        kind: 'body',
        column: 'single',
        text: run.text,
        confidence: 1,
        box: { ...run },
        lines: [
          {
            id: `line-${index + 1}`,
            text: run.text,
            fontSize: run.fontSize,
            box: { ...run },
            runs: [{ ...run }],
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: true,
      }) satisfies PdfPageRegion,
  )
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
  const page = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
    imageCount: 0,
    runs,
  } satisfies PdfPageAnalysis
  return { page, regions, readingOrder }
}

function paper(
  nodes: ResearchPaper['nodes'],
  title = 'Source title',
): ResearchPaper {
  return {
    id: 'paper',
    version: '1.0.0',
    status: 'working',
    title,
    subtitle: 'Test',
    authors: ['Imported locally'],
    updated: '2026-07-21',
    abstract: 'Test',
    nodes,
  }
}

function evidence(region: PdfPageRegion): NodeSourceEvidence {
  return {
    confidence: 1,
    pages: [region.page],
    regionIds: [region.id],
    boxes: [{ ...region.box }],
    links: [],
  }
}

describe('exact PDF provenance gates', () => {
  it('blocks one omitted source region even when aggregate coverage exceeds 0.98', () => {
    const represented = 'a'.repeat(1_000)
    const omitted = 'b'.repeat(10)
    const truth = sourceTruth([represented, omitted])
    const result = assessPdfCompleteness({
      pages: [truth.page],
      paper: paper(
        [
          {
            id: 'represented',
            type: 'paragraph',
            text: represented,
            source: 'test',
          },
        ],
        represented,
      ),
      diagnostics: [],
      regions: truth.regions,
      readingOrder: truth.readingOrder,
      provenance: { represented: evidence(truth.regions[0]) },
    })

    expect(result.completeness.textCoverage).toBeGreaterThan(0.98)
    expect(result.completeness.missingSourceRegionCount).toBe(1)
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'MISSING_SOURCE_REGION',
    )
  })

  it('blocks invented reconstructed-header metadata even when body text is exact', () => {
    const truth = sourceTruth(['Exact source-backed body text.'])
    const result = assessPdfCompleteness({
      pages: [truth.page],
      paper: paper(
        [
          {
            id: 'body',
            type: 'paragraph',
            text: truth.regions[0].text,
            source: 'test',
          },
        ],
        'invented-filename-title',
      ),
      diagnostics: [],
      regions: truth.regions,
      readingOrder: truth.readingOrder,
      provenance: { body: evidence(truth.regions[0]) },
    })

    expect(result.completeness.unprovenancedRenderedUnitCount).toBeGreaterThan(
      0,
    )
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNPROVENANCED_RENDERED_UNIT',
    )
  })

  it('accepts only classifier-backed author affiliation markers', () => {
    const truth = sourceTruth([
      'Source title',
      'Ada Example¹',
      'Introduction',
      'Exact source-backed body text that makes the marker accounting explicit.',
    ])
    const nodes = [
      {
        id: 'introduction',
        type: 'heading' as const,
        level: 2 as const,
        text: truth.regions[2].text,
        source: 'test',
      },
      {
        id: 'body',
        type: 'paragraph' as const,
        text: truth.regions[3].text,
        source: 'test',
      },
    ]
    const baseInput = {
      pages: [truth.page],
      diagnostics: [],
      regions: truth.regions,
      readingOrder: truth.readingOrder,
      provenance: {
        introduction: evidence(truth.regions[2]),
        body: evidence(truth.regions[3]),
      },
    }
    const accepted = assessPdfCompleteness({
      ...baseInput,
      paper: {
        ...paper(nodes),
        authors: ['Ada Example'],
      },
    })
    const invented = assessPdfCompleteness({
      ...baseInput,
      paper: {
        ...paper(nodes),
        authors: ['Invented Author'],
      },
    })

    expect(accepted.completeness.unprovenancedRenderedUnitCount).toBe(0)
    expect(accepted.readiness.blockingDiagnosticCodes).not.toContain(
      'UNPROVENANCED_RENDERED_UNIT',
    )
    expect(invented.completeness.unprovenancedRenderedUnitCount).toBe(1)
    expect(invented.readiness.blockingDiagnosticCodes).toContain(
      'UNPROVENANCED_RENDERED_UNIT',
    )
  })

  it('blocks any supported inline source span missing from canonical mapping', () => {
    const truth = sourceTruth(['Exact styled text.'])
    const result = assessPdfCompleteness({
      pages: [truth.page],
      paper: paper(
        [
          {
            id: 'body',
            type: 'paragraph',
            text: truth.regions[0].text,
            source: 'test',
          },
        ],
        truth.regions[0].text,
      ),
      diagnostics: [],
      regions: truth.regions,
      readingOrder: truth.readingOrder,
      provenance: { body: evidence(truth.regions[0]) },
      inlineSpanLedger: { expected: 1, mapped: 0 },
    })

    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 1,
      mappedInlineSpanCount: 0,
      inlineSpanCoverage: 0,
    })
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'INCOMPLETE_INLINE_STYLE_COVERAGE',
    )
  })
})
