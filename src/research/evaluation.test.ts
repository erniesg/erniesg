import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import { createDemoAnnotations } from './annotations'
import {
  evaluateSrt,
  type CompositionTiming,
  type GeometryEvidence,
} from './evaluation'
import { buildLayoutManifest } from './manifest'
import { researchPaperSchema, type ResearchPaper } from './schema'
import { TARGET_PROFILE_IDS, type TargetProfileId } from './targets'

const paper = researchPaperSchema.parse(rawPaper)
const manifest = buildLayoutManifest(paper)

const timings = Object.fromEntries(
  TARGET_PROFILE_IDS.map((target, index) => [
    target,
    {
      coldMs: index + 1,
      warmIterations: 50,
      warmMedianMs: index + 0.25,
      warmP95Ms: index + 0.5,
    } satisfies CompositionTiming,
  ]),
) as Record<TargetProfileId, CompositionTiming>

function geometry(): GeometryEvidence {
  return {
    schemaVersion: '1.0.0',
    runtime: {
      browserName: 'chromium',
      browserVersion: 'test',
      viewport: { width: 1440, height: 1200 },
      deviceScaleFactor: 1,
    },
    tolerances: { geometryCssPx: 0.5, overflowCssPx: 1 },
    targets: TARGET_PROFILE_IDS.map((target) => ({
      target,
      missingNodes: [],
      invalidFragmentLineage: [],
      textLoss: [],
      clippedContent: [],
      overlaps: [],
      orphanedCaptions: [],
      horizontalOverflow: [],
      missingAnnotations: [],
      unstableAnchors: [],
    })),
  }
}

function evaluatePaper(
  paperInput: ResearchPaper,
  manifestInput = buildLayoutManifest(paperInput),
  geometryEvidence = geometry(),
) {
  return evaluateSrt({
    paper: paperInput,
    manifest: manifestInput,
    annotations: createDemoAnnotations(paperInput),
    geometry: geometryEvidence,
    timings,
    runtime: {
      generatedAt: '2026-07-18T00:00:00.000Z',
      node: 'v22.0.0',
      v8: 'test',
      platform: 'linux',
      architecture: 'x64',
      osRelease: 'test',
      cpuModel: 'test',
      logicalCpuCount: 1,
      totalMemoryMiB: 1024,
    },
    fixedPdf: {
      pageCount: 2,
      byteLength: 1024,
      sha256: 'a'.repeat(64),
    },
  })
}

function evaluate(geometryEvidence = geometry()) {
  return evaluatePaper(paper, manifest, geometryEvidence)
}

function paperWithTableCellNote() {
  const withNote = structuredClone(paper)
  const figure = withNote.nodes.find((node) => node.type === 'figure')
  if (!figure || figure.type !== 'figure') {
    throw new Error('Fixture lacks a figure node')
  }
  figure.objectType = 'table'
  figure.table = {
    rows: [
      {
        cells: [
          {
            id: 'cell-metric',
            text: 'Metric1',
            headerScope: null,
            columnSpan: 1,
            rowSpan: 1,
            noteReferences: [
              {
                id: 'cell-note-reference',
                label: '1',
                target: 'cell-note',
                start: 6,
                end: 7,
                confidence: 1,
              },
            ],
          },
        ],
      },
    ],
  }
  withNote.nodes.push({
    id: 'cell-note',
    type: 'footnote',
    kind: 'footnote',
    label: '1',
    text: 'Source-backed table note.',
    relationships: { backlinks: ['cell-note-reference'] },
    source: 'fixture:table-note',
  })
  return researchPaperSchema.parse(withNote)
}

describe('SRT engineering evaluation', () => {
  it('aggregates every required metric across all four targets', () => {
    const result = evaluate()

    expect(result.targets.map((target) => target.target)).toEqual(
      TARGET_PROFILE_IDS,
    )
    for (const target of result.targets) {
      expect(target.structuralCoverage.ratio).toBe(1)
      expect(target.relationshipPreservation.ratio).toBe(1)
      expect(target.annotationSurvival.ratio).toBe(1)
      expect(target.anchorStability.ratio).toBe(1)
      expect(target.browserGeometry).toMatchObject({
        status: 'measured',
        clippedElements: 0,
        overlapPairs: 0,
      })
      expect(target.compositionTime.warmIterations).toBe(50)
    }

    expect(
      result.targets.find((target) => target.target === 'paperProMove')
        ?.fallbacks,
    ).toMatchObject({ composition: 1, pagination: 0, total: 1 })
  })

  it('counts nested table-cell note edges in relationship preservation', () => {
    const baseline = evaluate()
    const result = evaluatePaper(paperWithTableCellNote())

    expect(result.subject.canonicalRelationships).toBe(
      baseline.subject.canonicalRelationships + 2,
    )
    for (const [index, target] of result.targets.entries()) {
      expect(target.relationshipPreservation).toEqual({
        preserved:
          baseline.targets[index].relationshipPreservation.preserved + 2,
        expected: baseline.targets[index].relationshipPreservation.expected + 2,
        ratio: 1,
      })
    }
  })

  it('preserves repeated table-cell note edges to the same target', () => {
    const repeated = structuredClone(paperWithTableCellNote())
    const figure = repeated.nodes.find((node) => node.type === 'figure')
    const note = repeated.nodes.find((node) => node.id === 'cell-note')
    if (
      !figure ||
      figure.type !== 'figure' ||
      !figure.table ||
      !note ||
      note.type !== 'footnote'
    ) {
      throw new Error('Fixture lacks a table-cell note topology')
    }
    figure.table.rows[0].cells.push({
      id: 'cell-metric-repeat',
      text: 'Repeat1',
      headerScope: null,
      columnSpan: 1,
      rowSpan: 1,
      noteReferences: [
        {
          id: 'cell-note-reference-repeat',
          label: '1',
          target: note.id,
          start: 6,
          end: 7,
          confidence: 1,
        },
      ],
    })
    note.relationships.backlinks.push('cell-note-reference-repeat')
    const repeatedPaper = researchPaperSchema.parse(repeated)
    const repeatedManifest = buildLayoutManifest(repeatedPaper)
    const baseline = evaluate()
    const result = evaluatePaper(repeatedPaper, repeatedManifest)

    for (const rendition of repeatedManifest.renditions) {
      expect(
        rendition.entries.find((entry) => entry.canonicalId === figure.id)
          ?.relationships.noteTargets,
      ).toEqual([note.id, note.id])
    }
    expect(result.subject.canonicalRelationships).toBe(
      baseline.subject.canonicalRelationships + 4,
    )
    for (const [index, target] of result.targets.entries()) {
      expect(target.relationshipPreservation).toEqual({
        preserved:
          baseline.targets[index].relationshipPreservation.preserved + 4,
        expected: baseline.targets[index].relationshipPreservation.expected + 4,
        ratio: 1,
      })
    }
  })

  it('reports measured browser failures rather than hiding them', () => {
    const evidence = geometry()
    evidence.targets[0].clippedContent.push('p-proposition-1#fragment-1')
    evidence.targets[0].overlaps.push('sec-proposition::p-proposition-1')
    evidence.targets[0].missingAnnotations.push('highlight-reading-position')
    evidence.targets[0].unstableAnchors.push('note-reading-position')
    evidence.targets[0].horizontalOverflow.push({
      element: 'page-1',
      amount: 4,
    })

    const target = evaluate(evidence).targets[0]
    expect(target.browserGeometry).toEqual({
      status: 'measured',
      clippedElements: 1,
      overlapPairs: 1,
      horizontalOverflows: 1,
      orphanedCaptions: 0,
      missingNodes: 0,
      textLosses: 0,
      invalidFragmentLineages: 0,
    })
    expect(target.annotationSurvival).toMatchObject({
      preserved: 1,
      expected: 2,
      ratio: 0.5,
    })
    expect(target.anchorStability).toMatchObject({
      stable: 0,
      expected: 2,
      ratio: 0,
    })
  })

  it('marks the absent geometric baseline and qualifies novelty', () => {
    const result = evaluate()

    expect(result.baselines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'fixed-pdf',
          availability: 'available',
          comparison: 'limited',
          independence: 'same-semantic-source',
        }),
        expect.objectContaining({
          id: 'geometric-reflow',
          availability: 'unavailable',
          comparison: 'not-run',
        }),
      ]),
    )
    expect(result.novelty.qualification).toBe('to our knowledge')
    expect(result.novelty.claim).not.toMatch(/systematic review evidence/i)
  })

  it('refuses a partial four-target geometry report', () => {
    const evidence = geometry()
    evidence.targets.pop()

    expect(() => evaluate(evidence)).toThrow(/each SRT target exactly once/)
  })
})
