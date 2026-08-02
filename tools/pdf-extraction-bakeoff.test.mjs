import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('extraction bake-off CLI', () => {
  it('runs the privacy-safe synthetic held-out smoke benchmark', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'tools/pdf-extraction-bakeoff.mjs',
        '--self-test',
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
  })
})
