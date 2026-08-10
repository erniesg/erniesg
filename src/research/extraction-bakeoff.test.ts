import { describe, expect, it } from 'vitest'
import {
  assertNoHeldOutContamination,
  createExtractionArchitectureDecision,
  EXTRACTION_BAKEOFF_STRATA,
  runExtractionBakeoff,
  validateExtractionBakeoffCorpus,
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

  it('scores expected heading levels as part of sectioning quality', async () => {
    const inputCorpus = corpus()
    for (const document of [
      ...inputCorpus.development,
      ...inputCorpus.heldOut,
    ]) {
      const sectioningCase = document.cases.find(
        ({ stratum }) => stratum === 'sectioning',
      )!
      sectioningCase.expectedNodeTypes = ['heading', 'paragraph']
      sectioningCase.expectedHeadingLevels = [2]
    }

    const withHeadingLevel =
      (level: number) => (input: StructuredExtractionContext) => {
        const output = proposal(input)
        output.nodes[0] = {
          ...output.nodes[0]!,
          type: 'heading',
          level,
        }
        return output
      }
    const correctHeadingLevel = arm('geometric-baseline', withHeadingLevel(2))
    const wrongHeadingLevel = arm('llm-authored', withHeadingLevel(1))
    const report = await runExtractionBakeoff({
      corpus: inputCorpus,
      arms: [correctHeadingLevel, wrongHeadingLevel, arm('llm-grounded')],
    })
    const sectionScore = report.arms[
      'llm-authored'
    ].documents[0]!.caseScores.find(({ stratum }) => stratum === 'sectioning')!
    const correctScore = report.arms[
      'geometric-baseline'
    ].documents[0]!.caseScores.find(({ stratum }) => stratum === 'sectioning')!

    expect(sectionScore.headingLevelRecall).toBe(0)
    expect(sectionScore.score).toBeLessThan(correctScore.score)
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

    for (const key of [
      'goldLabel',
      'ground_truth',
      'reviewer-label',
      'target_box',
    ]) {
      expect(() =>
        assertNoHeldOutContamination(
          clean,
          {
            ...proposal(context('heldout-one', 'held-out', 'one-column')),
            [key]: true,
          },
          'held-out',
        ),
      ).toThrow('HELD_OUT_CONTAMINATION')
    }
  })

  it('disqualifies a contaminated arm without aborting the other arms', async () => {
    const contaminated = arm('llm-authored')
    contaminated.usedHeldOutForTuning = true

    const report = await runExtractionBakeoff({
      corpus: corpus(),
      arms: [arm('geometric-baseline'), contaminated, arm('llm-grounded')],
    })

    expect(report.arms['llm-authored'].disqualified).toBe(true)
    expect(
      report.arms['llm-authored'].documents.every(
        ({ status, outputHash }) =>
          status === 'disqualified' && outputHash === null,
      ),
    ).toBe(true)
    expect(
      report.arms['geometric-baseline'].documents.every(
        ({ status }) => status === 'passed',
      ),
    ).toBe(true)
    expect(
      report.arms['llm-grounded'].documents.every(
        ({ status }) => status === 'passed',
      ),
    ).toBe(true)
  })

  it('reports deterministic verifier failures as failed, not byte instability', async () => {
    const invalid = arm('llm-authored', (input) => {
      const output = proposal(input)
      output.nodes[0]!.text = 'not source-backed'
      return output
    })

    const report = await runExtractionBakeoff({
      corpus: corpus(),
      arms: [arm('geometric-baseline'), invalid, arm('llm-grounded')],
    })
    const result = report.arms['llm-authored'].documents[0]!

    expect(result.status).toBe('failed')
    expect(result.byteStable).toBe(false)
    expect(result.verification.status).toBe('failed')
    expect(result.verification.issueCodes).toContain('source-text-mismatch')
    expect(result.verification.issueCodes).not.toContain('byte-instability')
    expect(result.outputHash).toBeNull()
  })

  it('keeps development-only rows out of held-out comparisons', async () => {
    const developmentWeak = arm('geometric-baseline', (input) =>
      input.split === 'development'
        ? {
            schemaVersion: '1.0.0',
            nodes: [],
          }
        : proposal(input),
    )
    const report = await runExtractionBakeoff({
      corpus: corpus(),
      arms: [developmentWeak, arm('llm-authored'), arm('llm-grounded')],
      includeDevelopment: true,
    })
    const row = report.comparison.find(
      ({ stratum, layout }) =>
        stratum === 'sectioning' && layout === 'one-column',
    )!

    expect(row.scores['geometric-baseline']).toBe(1)
  })

  it('binds the held-out identity to its labels as well as its documents', async () => {
    const original = corpus()
    const changed = corpus()
    changed.heldOut[0]!.cases[0]!.expectedNodeTypes = ['paragraph']

    const arms = [
      arm('geometric-baseline'),
      arm('llm-authored'),
      arm('llm-grounded'),
    ]
    const first = await runExtractionBakeoff({ corpus: original, arms })
    const second = await runExtractionBakeoff({
      corpus: changed,
      arms: [
        arm('geometric-baseline'),
        arm('llm-authored'),
        arm('llm-grounded'),
      ],
    })

    expect(second.heldOutIdentitySha256).not.toBe(first.heldOutIdentitySha256)
  })

  it('requires a human decision when any stratum is unresolved', async () => {
    const report = await runExtractionBakeoff({
      corpus: corpus(),
      arms: [
        arm('geometric-baseline'),
        arm('llm-authored'),
        arm('llm-grounded'),
      ],
    })
    const mixed = structuredClone(report)
    mixed.comparison[0]!.winner = 'tie'

    const decision = createExtractionArchitectureDecision({ report: mixed })

    expect(decision.owner).toBe('pending')
    expect(decision.humanDecisionRequired).toBe(true)
  })

  it('scopes disagreements to the active stratum instead of whole documents', async () => {
    const inputCorpus = corpus()
    for (const document of [
      ...inputCorpus.development,
      ...inputCorpus.heldOut,
    ]) {
      const sectioningCase = document.cases.find(
        ({ stratum }) => stratum === 'sectioning',
      )!
      sectioningCase.expectedNodeTypes = ['paragraph']
      sectioningCase.expectedSourceRunIds = [`${document.id}-body`]
    }
    const alternateTitleType = arm('llm-authored', (input) => {
      const output = proposal(input)
      output.nodes[0] = { ...output.nodes[0]!, type: 'author' }
      return output
    })
    const report = await runExtractionBakeoff({
      corpus: inputCorpus,
      arms: [
        arm('geometric-baseline'),
        alternateTitleType,
        arm('llm-grounded'),
      ],
    })
    const sectioning = report.comparison.find(
      ({ stratum, layout }) =>
        stratum === 'sectioning' && layout === 'one-column',
    )!
    const prose = report.comparison.find(
      ({ stratum, layout }) =>
        stratum === 'prose-continuity' && layout === 'one-column',
    )!

    expect(sectioning.disagreementDocumentIds).not.toContain('heldout-one')
    expect(prose.disagreementDocumentIds).toContain('heldout-one')
  })

  it('binds documents to the split array and validates case references', () => {
    const mismatchedSplit = corpus()
    mismatchedSplit.heldOut[0]!.split = 'development'
    expect(() => validateExtractionBakeoffCorpus(mismatchedSplit)).toThrow(
      'EXTRACTION_BAKEOFF_SPLIT_MISMATCH',
    )

    const unknownLabel = corpus()
    unknownLabel.heldOut[0]!.cases[0]!.expectedSourceRunIds = ['missing-run']
    expect(() => validateExtractionBakeoffCorpus(unknownLabel)).toThrow(
      'INVALID_EXTRACTION_BAKEOFF_CASE',
    )
  })

  it('rejects a mutated report before deriving an architecture decision', async () => {
    const report = await runExtractionBakeoff({
      corpus: corpus(),
      arms: [
        arm('geometric-baseline'),
        arm('llm-authored'),
        arm('llm-grounded'),
      ],
    })
    const mutated = structuredClone(report)
    mutated.comparison[0]!.scores['llm-authored'] = 0
    expect(() =>
      createExtractionArchitectureDecision({ report: mutated }),
    ).toThrow('INVALID_EXTRACTION_BAKEOFF_REPORT_HASH')
  })

  it('uses a caller-persisted score-once store and benchmark page denominator', async () => {
    const inputCorpus = corpus()
    const scoreOnceStore = new Set<string>()
    const arms = [
      arm('geometric-baseline'),
      arm('llm-authored'),
      arm('llm-grounded'),
    ]
    await runExtractionBakeoff({
      corpus: inputCorpus,
      arms,
      scoreOnceStore,
    })
    await expect(
      runExtractionBakeoff({
        corpus: inputCorpus,
        arms,
        scoreOnceStore,
      }),
    ).rejects.toThrow('HELD_OUT_SCORED_MORE_THAN_ONCE')

    const badMetrics = arm('llm-authored')
    badMetrics.run = (input) => ({
      proposal: proposal(input),
      metrics: { latencyMs: 12, costUsd: 0.02, pageCount: 99 },
    })
    const report = await runExtractionBakeoff({
      corpus: corpus(),
      arms: [arm('geometric-baseline'), badMetrics, arm('llm-grounded')],
    })
    expect(report.arms['llm-authored'].documents[0]!.status).toBe('failed')
    expect(
      report.arms['llm-authored'].documents[0]!.verification.issueCodes,
    ).toContain('invalid-run-metrics')

    const benchmarkContextCorpus = corpus()
    Object.assign(benchmarkContextCorpus.heldOut[0]!.context, {
      pageCount: 3,
    })
    const benchmarkPages = arm('llm-authored')
    benchmarkPages.run = (input) => ({
      proposal: proposal(input),
      metrics: { latencyMs: 12, costUsd: 0.02, pageCount: 3 },
    })
    const benchmarkReport = await runExtractionBakeoff({
      corpus: benchmarkContextCorpus,
      arms: [arm('geometric-baseline'), benchmarkPages, arm('llm-grounded')],
    })
    expect(
      benchmarkReport.arms['llm-authored'].documents[0]!.latencyMsPerPage,
    ).toBe(4)
  })

  it('isolates adapter failures and stops a contaminated arm', async () => {
    const throwing = arm('llm-authored')
    throwing.run = () => {
      throw new Error('provider timeout')
    }
    const failureReport = await runExtractionBakeoff({
      corpus: corpus(),
      arms: [arm('geometric-baseline'), throwing, arm('llm-grounded')],
    })
    expect(
      failureReport.arms['llm-authored'].documents.every(
        ({ status }) => status === 'failed',
      ),
    ).toBe(true)
    expect(
      failureReport.arms['geometric-baseline'].documents.every(
        ({ status }) => status === 'passed',
      ),
    ).toBe(true)

    const contaminated = arm('llm-authored')
    let invocations = 0
    contaminated.run = (input) => {
      invocations += 1
      return {
        proposal: {
          ...proposal(input),
          expected: ['held-out-label'],
        },
        metrics: { latencyMs: 12, costUsd: 0.02 },
      }
    }
    const contaminationReport = await runExtractionBakeoff({
      corpus: corpus(),
      arms: [arm('geometric-baseline'), contaminated, arm('llm-grounded')],
    })
    expect(invocations).toBe(1)
    expect(
      contaminationReport.arms['llm-authored'].documents.every(
        ({ status }) => status === 'disqualified',
      ),
    ).toBe(true)
  })
})
