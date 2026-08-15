import { describe, expect, it } from 'vitest'
import {
  assertNoHeldOutContamination,
  createExtractionArchitectureDecision,
  EXTRACTION_BAKEOFF_SCHEMA_VERSION,
  EXTRACTION_BAKEOFF_STRATA,
  runExtractionBakeoff as runExtractionBakeoffWithLedger,
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

type BakeoffOptions = Omit<
  Parameters<typeof runExtractionBakeoffWithLedger>[0],
  'scoredHeldOutKeys'
> & {
  scoredHeldOutKeys?: Set<string>
}

function runExtractionBakeoff(options: BakeoffOptions) {
  return runExtractionBakeoffWithLedger({
    ...options,
    scoredHeldOutKeys: options.scoredHeldOutKeys ?? new Set<string>(),
  })
}

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
    // Vary an identifier rather than the node order: reversing the nodes now
    // fails verification outright on the cross-node source-order check, which
    // reports `failed` and would no longer exercise byte-instability at all.
    const unstable = arm('llm-authored', (input) => {
      invocation += 1
      const output = proposal(input)
      if (invocation % 2 === 0) {
        for (const node of output.nodes) node.id = `${node.id}-alt`
      }
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

  it('rejects a document whose split disagrees with the array holding it', () => {
    // A development-tagged entry under `heldOut` still contributes to the
    // held-out identity and layout checks but bypasses the contamination
    // guards and drops out of held-out comparisons.
    const mislabelled = corpus()
    const stowaway = context('heldout-two', 'development', 'two-column')
    mislabelled.heldOut[1] = {
      id: 'heldout-two',
      split: 'development',
      layout: 'two-column',
      context: stowaway,
      cases: mislabelled.heldOut[1]!.cases,
    }

    expect(() => validateExtractionBakeoffCorpus(mislabelled)).toThrow(
      'INVALID_EXTRACTION_BAKEOFF_DOCUMENT:heldout-two',
    )
  })

  it('rejects case labels that do not belong to the document context', () => {
    for (const mutate of [
      (input: ExtractionBakeoffCorpus) => {
        input.heldOut[0]!.cases[0]!.expectedSourceRunIds = ['missing-run']
      },
      (input: ExtractionBakeoffCorpus) => {
        input.heldOut[0]!.cases[0]!.expectedAssetIds = ['missing-asset']
      },
      (input: ExtractionBakeoffCorpus) => {
        input.heldOut[0]!.cases[0]!.expectedExcludedBoilerplateRunIds = [
          'missing-boilerplate',
        ]
      },
    ]) {
      const invalid = corpus()
      mutate(invalid)
      expect(() => validateExtractionBakeoffCorpus(invalid)).toThrow(
        'INVALID_EXTRACTION_BAKEOFF_CASE',
      )
    }
  })

  it('scores the expected heading levels a case declares', async () => {
    // A candidate that emits every heading at the wrong depth publishes a
    // broken hierarchy; without reading the labels it scores identically to
    // one that gets the hierarchy right.
    const levelled = corpus()
    for (const document of levelled.heldOut) {
      document.context.sourceRuns.push({
        id: `${document.id}-heading`,
        text: 'Section',
        page: 1,
        order: 3,
      })
      for (const caseInput of document.cases) {
        caseInput.expectedNodeTypes = ['title', 'paragraph', 'heading']
        caseInput.expectedHeadingLevels = [2]
        caseInput.expectedSourceRunIds = [
          `${document.id}-title`,
          `${document.id}-body`,
          `${document.id}-heading`,
        ]
      }
    }
    const withLevel =
      (level: number) => (input: StructuredExtractionContext) => {
        const output = proposal(input)
        output.nodes.push({
          id: `${input.documentId}-heading`,
          type: 'heading',
          level,
          sourceRunIds: [`${input.documentId}-heading`],
          text: 'Section',
        })
        return output
      }

    const report = await runExtractionBakeoff({
      corpus: levelled,
      arms: [
        arm('geometric-baseline', withLevel(2)),
        arm('llm-authored', withLevel(5)),
        arm('llm-grounded', withLevel(2)),
      ],
    })
    const row = report.comparison.find(
      ({ stratum, layout }) =>
        stratum === 'sectioning' && layout === 'one-column',
    )!

    expect(row.scores['llm-authored']).toBeLessThan(
      row.scores['geometric-baseline']!,
    )
  })

  it('refuses to derive a decision from a report whose hash no longer binds it', () => {
    const report = {
      schemaVersion: EXTRACTION_BAKEOFF_SCHEMA_VERSION,
      corpusId: 'synthetic-bakeoff',
      heldOutIdentitySha256: hashA,
      candidateIdentities: {},
      heldOutScoredOnce: true,
      arms: {},
      comparison: [
        {
          stratum: 'sectioning',
          layout: 'one-column',
          scores: {
            'geometric-baseline': 0.1,
            'llm-authored': 1,
            'llm-grounded': 0.1,
          },
          winner: 'llm-authored',
          disagreementDocumentIds: [],
        },
      ],
      disagreements: [],
      reportSha256: hashB,
    } as unknown as Parameters<
      typeof createExtractionArchitectureDecision
    >[0]['report']

    expect(() => createExtractionArchitectureDecision({ report })).toThrow(
      'EXTRACTION_BAKEOFF_REPORT_HASH_MISMATCH',
    )
  })

  it('derives per-page metrics from the document, not from the arm', async () => {
    // An arm that reports an enormous page count drives its own latency and
    // cost per page toward zero and wins the operating-profile comparison.
    const inflated = arm('llm-authored')
    inflated.run = (input) => ({
      proposal: proposal(input),
      metrics: { latencyMs: 12, costUsd: 0.02, pageCount: 100_000 },
    })

    const report = await runExtractionBakeoff({
      corpus: corpus(),
      arms: [arm('geometric-baseline'), inflated, arm('llm-grounded')],
    })

    expect(report.arms['llm-authored'].documents[0]!.latencyMsPerPage).toBe(
      report.arms['llm-grounded'].documents[0]!.latencyMsPerPage,
    )
  })

  it('stops invoking a contaminated arm for the rest of the held-out split', async () => {
    // Advancing only to the next document keeps handing held-out papers to an
    // arm already known to be leaking, widening the leak it was disqualified
    // for.
    const seen: string[] = []
    const leaking = arm('llm-authored', (input) => {
      seen.push(input.documentId)
      return { ...proposal(input), goldLabel: ['title'] } as never
    })

    const report = await runExtractionBakeoff({
      corpus: corpus(),
      arms: [arm('geometric-baseline'), leaking, arm('llm-grounded')],
    })

    expect(report.arms['llm-authored'].disqualified).toBe(true)
    expect(new Set(seen).size).toBe(1)
    expect(
      report.arms['llm-authored'].documents.every(
        ({ status, outputHash }) =>
          status === 'disqualified' && outputHash === null,
      ),
    ).toBe(true)
  })

  it('records an adapter failure instead of aborting the whole bake-off', async () => {
    // A provider error on one document currently rejects the entire run, so no
    // side-by-side report exists even though the other arms are healthy.
    const flaky = arm('llm-authored', (input) => {
      if (input.documentId === 'heldout-one')
        throw new Error('provider timed out')
      return proposal(input)
    })

    const report = await runExtractionBakeoff({
      corpus: corpus(),
      arms: [arm('geometric-baseline'), flaky, arm('llm-grounded')],
    })
    const failed = report.arms['llm-authored'].documents.find(
      ({ documentId }) => documentId === 'heldout-one',
    )!

    expect(failed.status).toBe('failed')
    expect(failed.outputHash).toBeNull()
    expect(failed.verification.issueCodes).toContain('adapter-failure')
    expect(
      report.arms['llm-grounded'].documents.every(
        ({ status }) => status === 'passed',
      ),
    ).toBe(true)
  })

  it.each([
    ['null result', () => null],
    [
      'missing metrics',
      (input: StructuredExtractionContext) => ({ proposal: proposal(input) }),
    ],
    [
      'invalid metrics',
      (input: StructuredExtractionContext) => ({
        proposal: proposal(input),
        metrics: { latencyMs: Number.NaN, costUsd: 0.02 },
      }),
    ],
  ])(
    'isolates an adapter %s instead of aborting the whole bake-off',
    async (_name, invalidResult) => {
      const invalid = arm('llm-authored')
      invalid.run = async (input) =>
        input.documentId === 'heldout-one'
          ? (invalidResult(input) as never)
          : {
              proposal: proposal(input),
              metrics: { latencyMs: 12, costUsd: 0.02 },
            }

      const report = await runExtractionBakeoff({
        corpus: corpus(),
        arms: [arm('geometric-baseline'), invalid, arm('llm-grounded')],
      })
      const failed = report.arms['llm-authored'].documents.find(
        ({ documentId }) => documentId === 'heldout-one',
      )!

      expect(failed.status).toBe('failed')
      expect(failed.outputHash).toBeNull()
      expect(failed.verification.issueCodes).toContain('adapter-failure')
    },
  )

  it('scopes disagreement detection to the stratum the rows describe', async () => {
    // Comparing whole-document output hashes marks a document as a
    // disagreement for every stratum it appears in, so the report can no
    // longer say where the architectures actually diverge.
    const inputCorpus = corpus()
    for (const document of inputCorpus.heldOut) {
      document.context.sourceRuns.push({
        id: `${document.id}-heading`,
        text: 'Section',
        page: 1,
        order: 3,
      })
      const sectioning = document.cases.find(
        ({ stratum }) => stratum === 'sectioning',
      )!
      sectioning.expectedNodeTypes = ['title', 'paragraph', 'heading']
      sectioning.expectedHeadingLevels = [2]
      sectioning.expectedSourceRunIds = [
        `${document.id}-title`,
        `${document.id}-body`,
        `${document.id}-heading`,
      ]
    }
    const withHeading =
      (level: number) => (input: StructuredExtractionContext) => {
        const output = proposal(input)
        output.nodes.push({
          id: `${input.documentId}-heading`,
          type: 'heading',
          level,
          sourceRunIds: [`${input.documentId}-heading`],
          text: 'Section',
        })
        return output
      }

    const report = await runExtractionBakeoff({
      corpus: inputCorpus,
      arms: [
        arm('geometric-baseline', withHeading(2)),
        arm('llm-authored', withHeading(3)),
        arm('llm-grounded', withHeading(2)),
      ],
    })
    const rows = report.comparison.filter(
      ({ layout }) => layout === 'one-column',
    )

    expect(
      rows.some(
        ({ disagreementDocumentIds }) => disagreementDocumentIds.length > 0,
      ),
    ).toBe(true)
    expect(
      rows.every(
        ({ disagreementDocumentIds }) => disagreementDocumentIds.length > 0,
      ),
    ).toBe(false)
    expect(
      report.disagreements
        .filter(({ layout }) => layout === 'one-column')
        .map(({ stratum }) => stratum),
    ).toEqual(['sectioning'])
  })

  it('detects stratum-local structure changes even when scores are equal', async () => {
    const inputCorpus = corpus()
    for (const document of inputCorpus.heldOut) {
      document.context.sourceRuns.push(
        {
          id: `${document.id}-table-anchor`,
          text: 'Measure',
          page: 1,
          order: 3,
        },
        {
          id: `${document.id}-table-cell`,
          text: '42',
          page: 1,
          order: 4,
        },
      )
      const tableCase = document.cases.find(
        ({ stratum }) => stratum === 'tables',
      )!
      tableCase.expectedNodeTypes = ['title', 'paragraph', 'table']
      tableCase.expectedSourceRunIds = [
        `${document.id}-title`,
        `${document.id}-body`,
        `${document.id}-table-anchor`,
        `${document.id}-table-cell`,
      ]
    }
    const withScope =
      (headerScope: 'column' | 'none') =>
      (input: StructuredExtractionContext) => {
        const output = proposal(input)
        output.nodes.push({
          id: `${input.documentId}-table`,
          type: 'table',
          sourceRunIds: [`${input.documentId}-table-anchor`],
          table: {
            rows: [
              {
                cells: [
                  {
                    sourceRunIds: [`${input.documentId}-table-cell`],
                    headerScope,
                  },
                ],
              },
            ],
          },
        })
        return output
      }

    const report = await runExtractionBakeoff({
      corpus: inputCorpus,
      arms: [
        arm('geometric-baseline', withScope('column')),
        arm('llm-authored', withScope('none')),
        arm('llm-grounded', withScope('column')),
      ],
    })

    expect(
      report.disagreements
        .filter(({ layout }) => layout === 'one-column')
        .map(({ stratum }) => stratum),
    ).toEqual(['tables'])
  })

  it('does not certify score-once when the same identity is rerun', async () => {
    // Receipts for one held-out identity must reject a replay without
    // colliding with a genuinely changed held-out split that reuses doc IDs.
    const arms = () => [
      arm('geometric-baseline'),
      arm('llm-authored'),
      arm('llm-grounded'),
    ]
    const inputCorpus = corpus()
    const ledger = new Set<string>()

    const first = await runExtractionBakeoff({
      corpus: inputCorpus,
      arms: arms(),
      scoredHeldOutKeys: ledger,
    })
    expect(first.heldOutScoredOnce).toBe(true)

    const changed = corpus()
    changed.heldOut[0]!.cases[0]!.expectedNodeTypes = ['paragraph']
    await expect(
      runExtractionBakeoff({
        corpus: changed,
        arms: arms(),
        scoredHeldOutKeys: ledger,
      }),
    ).resolves.toMatchObject({ heldOutScoredOnce: true })

    await expect(
      runExtractionBakeoff({
        corpus: structuredClone(inputCorpus),
        arms: arms(),
        scoredHeldOutKeys: ledger,
      }),
    ).rejects.toThrow('HELD_OUT_SCORED_MORE_THAN_ONCE')
  })
})
