import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
    expect(
      payload.report.candidateIdentities['llm-grounded'].promptHash,
    ).toMatch(/^[a-f0-9]{64}$/u)
    expect(payload.decision.owner).toBe('llm-grounded')
    expect(payload.report).not.toHaveProperty('sourceText')
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

  it('releases the score-ledger lock when persistence fails', async () => {
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
    rmSync(directory, { recursive: true, force: true })
  })
})
