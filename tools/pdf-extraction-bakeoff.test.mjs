import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import {
  EXTRACTION_BAKEOFF_STRATA,
  runExtractionBakeoff,
} from '../src/research/extraction-bakeoff.ts'
import { structuredExtractionHash } from '../src/research/structured-extraction.ts'
import {
  validateSyntheticBakeoffReport,
  withScoreLedger,
} from './pdf-extraction-bakeoff.mjs'

const ARM_IDS = ['geometric-baseline', 'llm-authored', 'llm-grounded']

function committedReport() {
  return JSON.parse(
    readFileSync('benchmarks/pdf/extraction-bakeoff-report-v1.json', 'utf8'),
  )
}

function compileReportSchema() {
  return new Ajv2020({ strict: false }).compile(
    JSON.parse(
      readFileSync(
        'docs/schemas/extraction-bakeoff-report.schema.json',
        'utf8',
      ),
    ),
  )
}

/** Apply `mutate` to a copy of `report` and recompute its report hash. */
function rehashed(report, mutate) {
  const { reportSha256: _reportSha256, ...withoutHash } = report
  const mutated = structuredClone(withoutHash)
  mutate(mutated)
  return { ...mutated, reportSha256: structuredExtractionHash(mutated) }
}

/** Both the schema and the CLI validator must refuse `forged`. */
function expectRejected(validate, forged, label) {
  expect(validate(forged), label).toBe(false)
  expect(() => validateSyntheticBakeoffReport(forged), label).toThrow(
    'INVALID_SYNTHETIC_BAKEOFF_REPORT_SCHEMA',
  )
}

describe('extraction bake-off CLI', () => {
  it('runs the privacy-safe synthetic held-out smoke benchmark', () => {
    const directory = mkdtempSync(join(tmpdir(), 'extraction-bakeoff-'))
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'tools/pdf-extraction-bakeoff.mjs',
        '--self-test',
        '--score-ledger',
        join(directory, 'score-ledger.json'),
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )
    expect(result.status, result.stderr).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.report.heldOutScoredOnce).toBe(true)
    expect(payload.report.comparison).toHaveLength(16)
    expect(payload.report.authority).toEqual({
      kind: 'synthetic-contract-self-test',
      realProviderCalls: 0,
      realProviderAuthority: false,
      promotionEligible: false,
    })
    expect(
      payload.report.candidateIdentities['llm-grounded'].promptHash,
    ).toMatch(/^[a-f0-9]{64}$/u)
    expect(payload.decision.owner).toBe('pending')
    expect(payload.decision.humanDecisionRequired).toBe(true)
    expect(payload.report).not.toHaveProperty('sourceText')
    rmSync(directory, { recursive: true, force: true })
  })

  it('reproduces the committed synthetic report and pending decision', () => {
    const directory = mkdtempSync(join(tmpdir(), 'extraction-bakeoff-'))
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'tools/pdf-extraction-bakeoff.mjs',
        '--self-test',
        '--score-ledger',
        join(directory, 'score-ledger.json'),
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )
    expect(result.status, result.stderr).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.report).toEqual(
      JSON.parse(
        readFileSync(
          'benchmarks/pdf/extraction-bakeoff-report-v1.json',
          'utf8',
        ),
      ),
    )
    expect(payload.decision).toEqual(
      JSON.parse(
        readFileSync(
          'docs/research/semantic-responsive-typesetting/extraction-architecture-decision-v1.json',
          'utf8',
        ),
      ),
    )
    rmSync(directory, { recursive: true, force: true })
  })

  it.each([
    ['promotion eligibility', { promotionEligible: true }],
    ['real-provider authority', { realProviderAuthority: true }],
  ])('rejects a synthetic report claiming %s', (_claim, override) => {
    const directory = mkdtempSync(join(tmpdir(), 'extraction-bakeoff-'))
    const report = JSON.parse(
      readFileSync('benchmarks/pdf/extraction-bakeoff-report-v1.json', 'utf8'),
    )
    const reportPath = join(directory, 'forged-report.json')
    writeFileSync(
      reportPath,
      `${JSON.stringify({
        ...report,
        authority: {
          kind: 'synthetic-contract-self-test',
          realProviderCalls: 0,
          realProviderAuthority: false,
          promotionEligible: false,
          ...override,
        },
      })}\n`,
    )

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'tools/pdf-extraction-bakeoff.mjs',
        '--validate-report',
        reportPath,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('INVALID_SYNTHETIC_BAKEOFF_AUTHORITY')
    rmSync(directory, { recursive: true, force: true })
  })

  it('accepts the committed synthetic report only with its authority block', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'tools/pdf-extraction-bakeoff.mjs',
        '--validate-report',
        'benchmarks/pdf/extraction-bakeoff-report-v1.json',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )
    expect(result.status, result.stderr).toBe(0)
  })

  it.each([
    ['--validate-report', 'oversized'],
    ['--stamp-report', 'oversized'],
    ['--validate-report', 'FIFO'],
    ['--stamp-report', 'FIFO'],
  ])('rejects a %s input that is %s before parsing', (command, kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'extraction-bakeoff-'))
    const inputPath = join(directory, 'untrusted-report.json')
    const outputPath = join(directory, 'stamped-report.json')
    if (kind === 'oversized') {
      writeFileSync(inputPath, '{}')
      truncateSync(inputPath, 16 * 1024 * 1024 + 1)
    } else {
      const fifo = spawnSync('mkfifo', [inputPath], { encoding: 'utf8' })
      expect(fifo.status, fifo.stderr).toBe(0)
    }

    const args = [
      '--experimental-strip-types',
      'tools/pdf-extraction-bakeoff.mjs',
      command,
      inputPath,
    ]
    if (command === '--stamp-report') args.push('--report-out', outputPath)
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 1_000,
    })

    expect(result.status, result.stderr).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.stderr).toContain('INVALID_SYNTHETIC_BAKEOFF_REPORT')
    expect(existsSync(outputPath)).toBe(false)
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps the synthetic CLI validator closed to owner-local provider authority', () => {
    const directory = mkdtempSync(join(tmpdir(), 'extraction-bakeoff-'))
    const report = JSON.parse(
      readFileSync('benchmarks/pdf/extraction-bakeoff-report-v1.json', 'utf8'),
    )
    const { reportSha256: _reportSha256, ...withoutHash } = report
    const realReport = {
      ...withoutHash,
      authority: {
        kind: 'owner-local-real-provider-evidence',
        realProviderCalls: 1,
        realProviderAuthority: true,
        promotionEligible: false,
        providerExecutionReceiptSha256: 'c'.repeat(64),
      },
    }
    const reportPath = join(directory, 'owner-local-real-report.json')
    writeFileSync(
      reportPath,
      `${JSON.stringify({
        ...realReport,
        reportSha256: structuredExtractionHash(realReport),
      })}\n`,
    )

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'tools/pdf-extraction-bakeoff.mjs',
        '--validate-report',
        reportPath,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('INVALID_SYNTHETIC_BAKEOFF_AUTHORITY')
    rmSync(directory, { recursive: true, force: true })
  })

  it('accepts raw reports and a privacy-safe owner-local real-provider receipt', () => {
    const schema = JSON.parse(
      readFileSync(
        'docs/schemas/extraction-bakeoff-report.schema.json',
        'utf8',
      ),
    )
    const report = JSON.parse(
      readFileSync('benchmarks/pdf/extraction-bakeoff-report-v1.json', 'utf8'),
    )
    const validate = new Ajv2020({ strict: false }).compile(schema)

    expect(validate(report), JSON.stringify(validate.errors)).toBe(true)
    const { authority: _authority, reportSha256: _reportSha256, ...raw } = report
    const rawReport = {
      ...raw,
      reportSha256: structuredExtractionHash(raw),
    }
    expect(validate(rawReport), JSON.stringify(validate.errors)).toBe(true)
    const realAuthorityReport = {
      ...raw,
      authority: {
        kind: 'owner-local-real-provider-evidence',
        realProviderCalls: 1,
        realProviderAuthority: true,
        promotionEligible: false,
        providerExecutionReceiptSha256: 'c'.repeat(64),
      },
    }
    expect(
      validate({
        ...realAuthorityReport,
        reportSha256: structuredExtractionHash(realAuthorityReport),
      }),
      JSON.stringify(validate.errors),
    ).toBe(true)
    const { providerExecutionReceiptSha256: _receipt, ...unboundAuthority } =
      realAuthorityReport.authority
    const unboundRealReport = {
      ...raw,
      authority: unboundAuthority,
    }
    expect(
      validate({
        ...unboundRealReport,
        reportSha256: structuredExtractionHash(unboundRealReport),
      }),
    ).toBe(false)

    for (const authority of [
      { ...report.authority, promotionEligible: true },
      { ...report.authority, realProviderAuthority: true },
      { ...report.authority, realProviderCalls: 1 },
      { ...report.authority, unverifiedClaim: false },
    ]) {
      expect(validate({ ...report, authority })).toBe(false)
    }
    expect(
      validate({
        ...report,
        authority: {
          kind: 'real-provider-promotion-evidence',
          realProviderCalls: Number.MAX_SAFE_INTEGER + 1,
          realProviderAuthority: true,
          promotionEligible: true,
        },
      }),
    ).toBe(false)
  })

  it('rejects a report whose case structure hash was deleted even after recomputing its report hash', () => {
    const schema = JSON.parse(
      readFileSync(
        'docs/schemas/extraction-bakeoff-report.schema.json',
        'utf8',
      ),
    )
    const report = JSON.parse(
      readFileSync('benchmarks/pdf/extraction-bakeoff-report-v1.json', 'utf8'),
    )
    const validate = new Ajv2020({ strict: false }).compile(schema)
    const { reportSha256: _reportSha256, ...withoutHash } = report
    const mutated = structuredClone(withoutHash)
    delete mutated.arms['geometric-baseline'].documents[0].caseScores[0]
      .structureHash
    const forged = {
      ...mutated,
      reportSha256: structuredExtractionHash(mutated),
    }

    expect(validate(forged)).toBe(false)
    expect(JSON.stringify(validate.errors)).toContain('structureHash')
  })

  it('rejects a passed case whose structure hash is null even after recomputing its report hash', () => {
    const schema = JSON.parse(
      readFileSync(
        'docs/schemas/extraction-bakeoff-report.schema.json',
        'utf8',
      ),
    )
    const report = JSON.parse(
      readFileSync('benchmarks/pdf/extraction-bakeoff-report-v1.json', 'utf8'),
    )
    const validate = new Ajv2020({ strict: false }).compile(schema)
    const { reportSha256: _reportSha256, ...withoutHash } = report
    const mutated = structuredClone(withoutHash)
    mutated.arms['llm-grounded'].documents[0].caseScores[0].structureHash =
      null
    const forged = {
      ...mutated,
      reportSha256: structuredExtractionHash(mutated),
    }

    expect(validate(forged)).toBe(false)
    expect(JSON.stringify(validate.errors)).toContain('structureHash')
  })

  it('refuses to stamp an authority-absent report', () => {
    const directory = mkdtempSync(join(tmpdir(), 'extraction-bakeoff-'))
    const source = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'tools/pdf-extraction-bakeoff.mjs',
        '--self-test',
        '--score-ledger',
        join(directory, 'score-ledger.json'),
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )
    expect(source.status, source.stderr).toBe(0)
    const markedReport = JSON.parse(source.stdout).report
    const { authority: _authority, ...unmarkedReport } = markedReport
    const inputPath = join(directory, 'unmarked-report.json')
    const outputPath = join(directory, 'stamped-report.json')
    writeFileSync(inputPath, `${JSON.stringify(unmarkedReport)}\n`)

    const stamped = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'tools/pdf-extraction-bakeoff.mjs',
        '--stamp-report',
        inputPath,
        '--report-out',
        outputPath,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )
    expect(stamped.status).toBe(1)
    expect(stamped.stderr).toContain('INVALID_SYNTHETIC_BAKEOFF_AUTHORITY')
    expect(existsSync(outputPath)).toBe(false)
    rmSync(directory, { recursive: true, force: true })
  })

  it('refuses to stamp a report with a forged authority claim', () => {
    const directory = mkdtempSync(join(tmpdir(), 'extraction-bakeoff-'))
    const report = JSON.parse(
      readFileSync('benchmarks/pdf/extraction-bakeoff-report-v1.json', 'utf8'),
    )
    const inputPath = join(directory, 'forged-report.json')
    const outputPath = join(directory, 'stamped-report.json')
    writeFileSync(
      inputPath,
      `${JSON.stringify({
        ...report,
        authority: { ...report.authority, promotionEligible: true },
      })}\n`,
    )

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'tools/pdf-extraction-bakeoff.mjs',
        '--stamp-report',
        inputPath,
        '--report-out',
        outputPath,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('INVALID_SYNTHETIC_BAKEOFF_AUTHORITY')
    expect(existsSync(outputPath)).toBe(false)
    rmSync(directory, { recursive: true, force: true })
  })

  it('refuses to stamp a schema-invalid report even when its hash matches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'extraction-bakeoff-'))
    const authority = {
      kind: 'synthetic-contract-self-test',
      realProviderCalls: 0,
      realProviderAuthority: false,
      promotionEligible: false,
    }
    const report = { authority }
    const inputPath = join(directory, 'minimal-report.json')
    const outputPath = join(directory, 'stamped-report.json')
    writeFileSync(
      inputPath,
      `${JSON.stringify({
        ...report,
        reportSha256: structuredExtractionHash(report),
      })}\n`,
    )

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'tools/pdf-extraction-bakeoff.mjs',
        '--stamp-report',
        inputPath,
        '--report-out',
        outputPath,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('INVALID_SYNTHETIC_BAKEOFF_REPORT_SCHEMA')
    expect(existsSync(outputPath)).toBe(false)
    rmSync(directory, { recursive: true, force: true })
  })

  it('persists score-once receipts across CLI processes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'extraction-bakeoff-'))
    const ledger = join(directory, 'score-ledger.json')
    const run = () =>
      spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          'tools/pdf-extraction-bakeoff.mjs',
          '--self-test',
          '--score-ledger',
          ledger,
        ],
        { encoding: 'utf8', timeout: 30_000 },
      )

    const first = run()
    const second = run()

    expect(first.status, first.stderr).toBe(0)
    expect(second.status).toBe(1)
    expect(second.stderr).toContain('HELD_OUT_SCORED_MORE_THAN_ONCE')
    rmSync(directory, { recursive: true, force: true })
  })

  it('fails closed without stranding the active lock when persistence fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'extraction-bakeoff-'))
    const ledger = join(directory, 'score-ledger.json')

    await expect(
      withScoreLedger(
        ledger,
        async (scoredHeldOutKeys) => scoredHeldOutKeys.add('scored-key'),
        async () => {
          throw new Error('simulated persistence failure')
        },
      ),
    ).rejects.toThrow('simulated persistence failure')
    expect(existsSync(`${ledger}.lock`)).toBe(false)
    expect(existsSync(`${ledger}.failed`)).toBe(true)

    let replayed = false
    await expect(
      withScoreLedger(ledger, async () => {
        replayed = true
      }),
    ).rejects.toThrow('EXTRACTION_SCORE_LEDGER_RECOVERY_REQUIRED')
    expect(replayed).toBe(false)
    rmSync(directory, { recursive: true, force: true })
  })

  it('requires exactly the three arm keys in every arm-keyed object, even after recomputing the report hash', () => {
    const report = committedReport()
    const validate = compileReportSchema()
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true)
    // Every object in the report that is keyed by arm id. A new arm-keyed
    // field belongs in this list; the schema must close it the same way.
    const armKeyedObjects = [
      ['candidateIdentities', (value) => value.candidateIdentities],
      ['arms', (value) => value.arms],
      ...report.comparison.map((_row, index) => [
        `comparison[${index}].scores`,
        (value) => value.comparison[index].scores,
      ]),
    ]
    expect(report.comparison.length).toBeGreaterThan(0)
    for (const [label, select] of armKeyedObjects) {
      for (const arm of ARM_IDS) {
        expectRejected(
          validate,
          rehashed(report, (value) => {
            delete select(value)[arm]
          }),
          `${label} without ${arm}`,
        )
      }
      expectRejected(
        validate,
        rehashed(report, (value) => {
          const target = select(value)
          for (const arm of ARM_IDS) delete target[arm]
        }),
        `${label} without any arm`,
      )
      expectRejected(
        validate,
        rehashed(report, (value) => {
          const target = select(value)
          target['llm-unlisted'] = target['llm-grounded']
        }),
        `${label} with an unlisted arm`,
      )
    }
  })

  it('binds every passed or failed verdict to its evidence, even after recomputing the report hash', () => {
    const report = committedReport()
    const validate = compileReportSchema()
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true)
    const sha = 'c'.repeat(64)
    const forgeries = []
    const documentStatuses = new Set()
    for (const arm of ARM_IDS) {
      report.arms[arm].documents.forEach((document, index) => {
        const at = `${arm}.documents[${index}]`
        const edit = (label, change) =>
          forgeries.push([
            `${at} (${document.status}) ${label}`,
            (value) => change(value.arms[arm].documents[index]),
          ])
        documentStatuses.add(document.status)
        if (document.status === 'passed') {
          // A passed document keeps the evidence that made it pass.
          edit('outputHash null', (d) => (d.outputHash = null))
          edit('byteStable false', (d) => (d.byteStable = false))
          edit('verification failed', (d) => {
            d.verification = {
              status: 'failed',
              issueCodes: ['byte-instability'],
              issueCount: 1,
            }
          })
          edit('latency null', (d) => (d.latencyMsPerPage = null))
          edit('cost null', (d) => (d.costUsdPerPage = null))
        } else {
          // Nothing but a passed document may carry success evidence.
          edit('outputHash set', (d) => (d.outputHash = sha))
          edit('byteStable true', (d) => (d.byteStable = true))
          edit('verification passed', (d) => {
            d.verification = { status: 'passed', issueCodes: [], issueCount: 0 }
          })
          edit('relabelled passed', (d) => (d.status = 'passed'))
          edit('relabelled disqualified with output', (d) => {
            d.status = 'disqualified'
            d.outputHash = sha
          })
        }
        edit('document verification passed with issues', (d) => {
          d.verification = {
            status: 'passed',
            issueCodes: ['invalid-output'],
            issueCount: 1,
          }
        })
        document.caseScores.forEach((score, caseIndex) => {
          const caseEdit = (label, change) =>
            edit(`caseScores[${caseIndex}] ${label}`, (d) =>
              change(d.caseScores[caseIndex]),
            )
          if (score.verification.status === 'passed') {
            caseEdit('passed with issue count', (s) => {
              s.verification.issueCount = 1
            })
            caseEdit('passed with issue codes', (s) => {
              s.verification.issueCodes = ['invalid-output']
            })
          } else {
            caseEdit('failed with structure hash', (s) => {
              s.structureHash = sha
            })
            caseEdit('failed with a nonzero score', (s) => {
              s.score = 0.5
            })
            caseEdit('failed with no issues', (s) => {
              s.verification = { status: 'failed', issueCodes: [], issueCount: 0 }
            })
          }
        })
      })
    }
    expect([...documentStatuses].sort()).toEqual(['failed', 'passed'])
    for (const [label, mutate] of forgeries)
      expectRejected(validate, rehashed(report, mutate), label)
  })

  it('accepts every report shape the runtime emits, including optional score fields and every document status', async () => {
    // One corpus that drives every optional field and every status the
    // runtime can emit: a sectioning case with expected heading levels
    // (headingLevelRecall), a passing arm, a failing arm and a byte-unstable
    // arm (disqualified). A field the runtime emits but the schema forbids,
    // or a conditional the runtime does not satisfy, fails here.
    const documents = [
      ['development-one', 'development', 'one-column'],
      ['heldout-one', 'held-out', 'one-column'],
      ['heldout-two', 'held-out', 'two-column'],
    ].map(([id, split, layout]) => ({
      id,
      split,
      layout,
      context: {
        documentId: id,
        sourceSha256: (split === 'development' ? 'a' : 'b').repeat(64),
        split,
        layout,
        sourceRuns: [
          { id: `${id}-title`, text: 'Synthetic title', page: 1, order: 1 },
          { id: `${id}-body`, text: 'Synthetic paragraph.', page: 1, order: 2 },
          { id: `${id}-heading`, text: 'Section', page: 1, order: 3 },
        ],
        sourceAssets: [],
      },
      cases: EXTRACTION_BAKEOFF_STRATA.map((stratum) => ({
        id: `${id}-${stratum}`,
        documentId: id,
        stratum,
        layout,
        expectedNodeTypes: ['title', 'paragraph', 'heading'],
        expectedSourceRunIds: [`${id}-title`, `${id}-body`, `${id}-heading`],
        ...(stratum === 'sectioning' ? { expectedHeadingLevels: [2] } : {}),
      })),
    }))
    const nodes = (documentId, headingId = `${documentId}-heading`) => [
      {
        id: `${documentId}-title`,
        type: 'title',
        sourceRunIds: [`${documentId}-title`],
      },
      {
        id: `${documentId}-body`,
        type: 'paragraph',
        sourceRunIds: [`${documentId}-body`],
      },
      {
        id: headingId,
        type: 'heading',
        level: 2,
        sourceRunIds: [`${documentId}-heading`],
      },
    ]
    let unstableCall = 0
    const outputs = {
      'geometric-baseline': (input) => nodes(input.documentId),
      'llm-authored': (input) =>
        nodes(input.documentId).map((node) =>
          node.type === 'paragraph'
            ? { ...node, text: 'Model-authored text that cannot be verified.' }
            : node,
        ),
      'llm-grounded': (input) =>
        nodes(input.documentId, `${input.documentId}-heading-${unstableCall++}`),
    }
    const report = await runExtractionBakeoff({
      corpus: {
        id: 'runtime-shape-bakeoff',
        development: documents.filter(({ split }) => split === 'development'),
        heldOut: documents.filter(({ split }) => split === 'held-out'),
      },
      arms: ARM_IDS.map((id) => ({
        id,
        identity: {
          providerId: id,
          modelId: `${id}-model`,
          modelVersion: 'fixture-1.0.0',
          modelDigest: 'a'.repeat(64),
          promptHash: 'b'.repeat(64),
        },
        tunedOn: ['development'],
        run: async (input) => ({
          proposal: { schemaVersion: '1.0.0', nodes: outputs[id](input) },
          metrics: { latencyMs: 1, costUsd: 0 },
        }),
      })),
      scoredHeldOutKeys: new Set(),
    })
    const statuses = Object.fromEntries(
      ARM_IDS.map((id) => [
        id,
        [...new Set(report.arms[id].documents.map(({ status }) => status))],
      ]),
    )
    expect(statuses).toEqual({
      'geometric-baseline': ['passed'],
      'llm-authored': ['failed'],
      'llm-grounded': ['disqualified'],
    })
    expect(
      report.arms['geometric-baseline'].documents.some(({ caseScores }) =>
        caseScores.some(
          (score) => typeof score.headingLevelRecall === 'number',
        ),
      ),
    ).toBe(true)

    const validate = compileReportSchema()
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true)
    const { reportSha256: _reportSha256, ...raw } = report
    const synthetic = {
      ...raw,
      authority: {
        kind: 'synthetic-contract-self-test',
        realProviderCalls: 0,
        realProviderAuthority: false,
        promotionEligible: false,
      },
    }
    expect(() =>
      validateSyntheticBakeoffReport({
        ...synthetic,
        reportSha256: structuredExtractionHash(synthetic),
      }),
    ).not.toThrow()
  })
})
