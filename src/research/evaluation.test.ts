import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import { createDemoAnnotations } from './annotations'
import {
  evaluateSrt,
  type CompositionTiming,
  type GeometryEvidence,
} from './evaluation'
import { buildLayoutManifest } from './manifest'
import { researchPaperSchema } from './schema'
import { TARGET_PROFILE_IDS, type TargetProfileId } from './targets'

const paper = researchPaperSchema.parse(rawPaper)
const annotations = createDemoAnnotations(paper)
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
    })),
  }
}

function evaluate(geometryEvidence = geometry()) {
  return evaluateSrt({
    paper,
    manifest,
    annotations,
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

  it('reports measured browser failures rather than hiding them', () => {
    const evidence = geometry()
    evidence.targets[0].clippedContent.push('p-proposition-1#fragment-1')
    evidence.targets[0].overlaps.push('sec-proposition::p-proposition-1')
    evidence.targets[0].horizontalOverflow.push({
      element: 'page-1',
      amount: 4,
    })

    expect(evaluate(evidence).targets[0].browserGeometry).toEqual({
      status: 'measured',
      clippedElements: 1,
      overlapPairs: 1,
      horizontalOverflows: 1,
      orphanedCaptions: 0,
      missingNodes: 0,
      textLosses: 0,
      invalidFragmentLineages: 0,
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
