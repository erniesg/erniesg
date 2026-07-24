import { expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderGraph,
  PdfSourceRun,
} from './import-types'
import {
  sourceMathAtomCompactionRanges,
  unprovedInlineScriptNodeIds,
} from './pdf-inline-script-integrity'
import { assessPdfCompleteness } from './pdf-quality'
import type { ResearchPaper } from './schema'

function box(
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

function sourceRun(
  text: string,
  sourceBox: NormalizedSourceBox,
  fontName: string,
  fontSize: number,
): PdfSourceRun {
  return {
    ...sourceBox,
    text,
    fontName,
    fontSize,
    confidence: 1,
  }
}

function assessInlineScript(
  scriptText: string,
  compactMathAtom = false,
  options: {
    fontName?: string
    verticalAlign?: 'superscript' | 'subscript' | null
  } = {},
) {
  const verticalAlign =
    options.verticalAlign === undefined ? 'superscript' : options.verticalAlign
  const prefix = 'The plot score is C'
  const suffix = '.'
  const text = `${prefix}${scriptText}${suffix}`
  const proseRun = sourceRun(
    'The plot score is ',
    box(0.1, 0.2, 0.18, 0.018),
    'Synthetic-Serif',
    10,
  )
  const baseRun = sourceRun(
    'C',
    box(0.282, 0.2, 0.012, 0.018),
    'Synthetic-CMMI10',
    10,
  )
  const scriptRun = sourceRun(
    scriptText,
    box(
      0.294,
      verticalAlign === 'superscript' ? 0.194 : 0.2,
      0.04,
      verticalAlign === 'superscript' ? 0.011 : 0.018,
    ),
    options.fontName ?? 'Synthetic-CMMI8',
    verticalAlign === 'superscript' ? 8 : 10,
  )
  const punctuationRun = sourceRun(
    suffix,
    box(0.336, 0.2, 0.006, 0.018),
    'Synthetic-Serif',
    10,
  )
  const regionBox = box(0.1, 0.194, 0.242, 0.024)
  const region = {
    id: 'inline-script-region',
    page: 1,
    kind: 'body',
    column: 'single',
    text,
    confidence: 1,
    box: regionBox,
    lines: [
      {
        id: 'inline-script-line',
        text,
        fontSize: 10,
        box: regionBox,
        runs: [proseRun, baseRun, scriptRun, punctuationRun],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const scriptStart = prefix.length
  const nodeId = 'inline-script-paragraph'
  const paper = {
    id: 'paper',
    version: '1.0.0',
    status: 'working',
    title: 'Inline script source proof',
    subtitle: 'Regression',
    authors: ['Test Author'],
    updated: '2026-07-24',
    abstract: 'Regression fixture.',
    nodes: [
      {
        id: nodeId,
        type: 'paragraph',
        text,
        inlineRuns: [
          {
            start: scriptStart,
            end: scriptStart + scriptText.length,
            italic: true,
            ...(verticalAlign ? { verticalAlign } : {}),
            ...(compactMathAtom ? { compactMathAtom: true } : {}),
          },
        ],
        source: 'test',
      },
    ],
  } satisfies ResearchPaper
  const provenance = {
    [nodeId]: {
      confidence: 1,
      pages: [1],
      regionIds: [region.id],
      boxes: [region.box],
      links: [],
    },
  } satisfies Record<string, NodeSourceEvidence>
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
  const page = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: text.length,
    imageCount: 0,
    runs: region.lines[0].runs,
  } satisfies PdfPageAnalysis

  const quality = assessPdfCompleteness({
    pages: [page],
    paper,
    diagnostics: [],
    readingOrder,
    regions: [region],
    provenance,
  })
  return { paper, provenance, quality, region }
}

it('keeps delimiter spacing outside a proved math-atom repair range', () => {
  expect(
    sourceMathAtomCompactionRanges(', RInf o.', 'Synthetic-CMMI10'),
  ).toEqual([{ start: 2, end: 9 }])
  expect(
    sourceMathAtomCompactionRanges(
      'ordinary italic prose',
      'Synthetic-NimbusRomNo9L-ReguItal',
    ),
  ).toEqual([])
  expect(
    sourceMathAtomCompactionRanges(
      'an entire prose sentence in a synthetic face',
      'Synthetic-CMMI10',
    ),
  ).toEqual([])
})

it('fails closed when a source-backed inline script atom contains an unproved token break', () => {
  const fixture = assessInlineScript('P lot')

  expect(
    unprovedInlineScriptNodeIds({
      paper: fixture.paper,
      provenance: fixture.provenance,
      regions: [fixture.region],
    }),
  ).toEqual(['inline-script-paragraph'])
  expect(fixture.quality.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'CANONICAL_FLOW_ORDER_VIOLATION',
        severity: 'error',
      }),
    ]),
  )
  expect(fixture.quality.readiness.blockingDiagnosticCodes).toContain(
    'CANONICAL_FLOW_ORDER_VIOLATION',
  )
})

it('does not reject the same source-backed inline script when its token is contiguous', () => {
  const fixture = assessInlineScript('Plot')

  expect(
    unprovedInlineScriptNodeIds({
      paper: fixture.paper,
      provenance: fixture.provenance,
      regions: [fixture.region],
    }),
  ).toEqual([])
  expect(fixture.quality.diagnostics).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'CANONICAL_FLOW_ORDER_VIOLATION',
      }),
    ]),
  )
})

it('accepts a whitespace-bearing script only when its compact rendering is explicit', () => {
  const fixture = assessInlineScript('P lot', true)

  expect(
    unprovedInlineScriptNodeIds({
      paper: fixture.paper,
      provenance: fixture.provenance,
      regions: [fixture.region],
    }),
  ).toEqual([])
  expect(fixture.quality.readiness.blockingDiagnosticCodes).not.toContain(
    'CANONICAL_FLOW_ORDER_VIOLATION',
  )
})

it('rejects a compact-math claim without a whitespace-bearing source atom', () => {
  const fixture = assessInlineScript('Plot', true)

  expect(
    unprovedInlineScriptNodeIds({
      paper: fixture.paper,
      provenance: fixture.provenance,
      regions: [fixture.region],
    }),
  ).toEqual(['inline-script-paragraph'])
  expect(fixture.quality.readiness.blockingDiagnosticCodes).toContain(
    'CANONICAL_FLOW_ORDER_VIOLATION',
  )
})

it('accepts a compact baseline identifier proved by one math-font source run', () => {
  const fixture = assessInlineScript('RInf o.', true, {
    verticalAlign: null,
  })

  expect(
    unprovedInlineScriptNodeIds({
      paper: fixture.paper,
      provenance: fixture.provenance,
      regions: [fixture.region],
    }),
  ).toEqual([])
  expect(fixture.quality.readiness.blockingDiagnosticCodes).not.toContain(
    'CANONICAL_FLOW_ORDER_VIOLATION',
  )
})

it('fails closed when a baseline math atom omits proved compaction', () => {
  const fixture = assessInlineScript('DInf o.', false, {
    verticalAlign: null,
  })

  expect(
    unprovedInlineScriptNodeIds({
      paper: fixture.paper,
      provenance: fixture.provenance,
      regions: [fixture.region],
    }),
  ).toEqual(['inline-script-paragraph'])
  expect(fixture.quality.readiness.blockingDiagnosticCodes).toContain(
    'CANONICAL_FLOW_ORDER_VIOLATION',
  )
})

it('rejects baseline compaction for ordinary italic prose', () => {
  const fixture = assessInlineScript('regular prose', true, {
    fontName: 'Synthetic-NimbusRomNo9L-ReguItal',
    verticalAlign: null,
  })

  expect(
    unprovedInlineScriptNodeIds({
      paper: fixture.paper,
      provenance: fixture.provenance,
      regions: [fixture.region],
    }),
  ).toEqual(['inline-script-paragraph'])
  expect(fixture.quality.readiness.blockingDiagnosticCodes).toContain(
    'CANONICAL_FLOW_ORDER_VIOLATION',
  )
})
