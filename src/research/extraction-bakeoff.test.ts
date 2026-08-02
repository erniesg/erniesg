import { describe, expect, it } from 'vitest'
import {
  assertNoHeldOutContamination,
  createExtractionArchitectureDecision,
  EXTRACTION_BAKEOFF_STRATA,
  runExtractionBakeoff,
  type ExtractionBakeoffArm,
  type ExtractionBakeoffCorpus,
} from './extraction-bakeoff'
import type {
  StructuredExtractionContext,
  StructuredExtractionNodeType,
  StructuredExtractionProposal,
} from './structured-extraction'

const hashA = 'a'.repeat(64)
const hashB = 'b'.repeat(64)

function context(
  id: string,
  split: 'development' | 'held-out',
  layout: 'one-column' | 'two-column',
): StructuredExtractionContext {
  return {
    documentId: id,
    sourceSha256: id === 'dev-paper' ? hashA : hashB,
    split,
    layout,
    sourceRuns: [
      { id: `${id}-title`, text: 'Title', page: 1, order: 1 },
      { id: `${id}-body`, text: 'Body text.', page: 1, order: 2 },
    ],
    sourceAssets: [],
  }
}

function proposal(
  input: StructuredExtractionContext,
): StructuredExtractionProposal {
  return {
    schemaVersion: '1.0.0',
    nodes: [
      {
        id: `${input.documentId}-title`,
        type: 'title',
        sourceRunIds: [`${input.documentId}-title`],
        text: 'Title',
      },
      {
        id: `${input.documentId}-body`,
        type: 'paragraph',
        sourceRunIds: [`${input.documentId}-body`],
        text: 'Body text.',
      },
    ],
  }
}

function corpus(): ExtractionBakeoffCorpus {
  const developmentContext = context('dev-paper', 'development', 'one-column')
  const heldOutOneColumn = context('heldout-one', 'held-out', 'one-column')
  const heldOutTwoColumn = context('heldout-two', 'held-out', 'two-column')
  const cases = (input: StructuredExtractionContext) =>
    EXTRACTION_BAKEOFF_STRATA.map((stratum) => ({
      id: `${input.documentId}-${stratum}`,
      documentId: input.documentId,
      stratum,
      layout: input.layout,
      expectedNodeTypes: [
        'title',
        'paragraph',
      ] as StructuredExtractionNodeType[],
      expectedSourceRunIds: [
        `${input.documentId}-title`,
        `${input.documentId}-body`,
      ],
    }))
  return {
    id: 'synthetic-bakeoff',
    development: [
      {
        id: 'dev-paper',
        split: 'development',
        layout: 'one-column',
        context: developmentContext,
        cases: cases(developmentContext),
      },
    ],
    heldOut: [
      {
        id: 'heldout-one',
        split: 'held-out',
        layout: 'one-column',
        context: heldOutOneColumn,
        cases: cases(heldOutOneColumn),
      },
      {
        id: 'heldout-two',
        split: 'held-out',
        layout: 'two-column',
        context: heldOutTwoColumn,
        cases: cases(heldOutTwoColumn),
      },
    ],
  }
}

function arm(
  id: ExtractionBakeoffArm['id'],
  run = (input: StructuredExtractionContext) => proposal(input),
): ExtractionBakeoffArm {
  return {
    id,
    identity: {
      providerId: id,
      modelId: `${id}-model`,
      modelVersion: '1.0.0',
      modelDigest: hashA,
      promptHash: hashB,
    },
    tunedOn: ['development'],
    run: (input) => ({
      proposal: run(input),
      metrics: { latencyMs: 12, costUsd: 0.02 },
    }),
  }
}

describe('extraction architecture bake-off', () => {
  it('scores both arms and the geometric baseline once on a layout-balanced held-out split', async () => {
    const report = await runExtractionBakeoff({
      corpus: corpus(),
      arms: [
        arm('geometric-baseline'),
        arm('llm-authored'),
        arm('llm-grounded'),
      ],
    })

    expect(report.heldOutScoredOnce).toBe(true)
    expect(report.arms['llm-grounded'].documents).toHaveLength(2)
    expect(report.arms['llm-grounded'].documents[0]!.latencyMsPerPage).toBe(12)
    expect(report.comparison).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stratum: 'sectioning',
          layout: 'one-column',
        }),
        expect.objectContaining({
          stratum: 'sectioning',
          layout: 'two-column',
        }),
      ]),
    )
    expect(report.reportSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(createExtractionArchitectureDecision({ report }).reportSha256).toBe(
      report.reportSha256,
    )
  })

  it('disqualifies a byte-unstable candidate rather than publishing the first result', async () => {
    let invocation = 0
    const unstable = arm('llm-authored', (input) => {
      invocation += 1
      const output = proposal(input)
      if (invocation % 2 === 0) output.nodes.reverse()
      return output
    })
    const report = await runExtractionBakeoff({
      corpus: corpus(),
      arms: [arm('geometric-baseline'), unstable, arm('llm-grounded')],
    })
    expect(
      report.arms['llm-authored'].documents.every(
        ({ status }) => status === 'disqualified',
      ),
    ).toBe(true)
    expect(
      report.arms['llm-authored'].documents.every(
        ({ outputHash }) => outputHash === null,
      ),
    ).toBe(true)
  })

  it('rejects held-out tuning and candidate payloads that carry labels', () => {
    const contaminated = arm('llm-grounded')
    contaminated.usedHeldOutForTuning = true
    expect(() =>
      assertNoHeldOutContamination(
        contaminated,
        proposal(context('heldout-one', 'held-out', 'one-column')),
        'held-out',
      ),
    ).toThrow('HELD_OUT_CONTAMINATION')

    const withLabel = {
      ...proposal(context('heldout-one', 'held-out', 'one-column')),
      expected: ['title'],
    }
    const clean = arm('llm-authored')
    expect(() =>
      assertNoHeldOutContamination(clean, withLabel, 'held-out'),
    ).toThrow('HELD_OUT_CONTAMINATION')
  })
})
