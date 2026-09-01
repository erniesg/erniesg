import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { structuredExtractionHash } from '../src/research/structured-extraction.ts'
import { withScoreLedger } from './pdf-extraction-bakeoff.mjs'

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
})
