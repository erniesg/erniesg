import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The shared-budget skip path, which had no coverage and produced an invalid
 * manifest because of it.
 *
 * `.github/workflows/agent-evidence.yml` requires `manifest.lanes_run` to equal
 * the ids in `manifest.lanes` exactly, and derives the expected
 * `required_failures` from `manifest.lanes`. A skipped lane named in
 * `required_failures` but absent from `lanes` made the two disagree, and the
 * validator discarded the whole manifest — losing the timeout evidence the
 * skip existed to record. These assert the invariants that validator checks,
 * against a real run.
 */
function runWithBudget(budgetMs, lanes) {
  const evidence = spawnSync('scripts/agent-evidence', ['--only', lanes], {
    cwd: resolve('.'),
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      AGENT_EVIDENCE_BUDGET_MS: String(budgetMs),
    },
  })
  const match = evidence.stdout.match(
    /\[agent-evidence\] (?:passed|failed): (.+\/manifest\.json)\s*$/u,
  )
  return { evidence, manifestPath: match ? resolve(match[1]) : null }
}

/** Exactly what the workflow validator derives, from the same source. */
function expectManifestConsistent(manifest) {
  expect(manifest.lanes_run).toEqual(manifest.lanes.map((lane) => lane.id))
  expect(manifest.required_failures).toEqual(
    manifest.lanes
      .filter((lane) => lane.required && lane.exit_code !== 0)
      .map((lane) => lane.id),
  )
  for (const lane of manifest.lanes) {
    expect(new Set(['passed', 'failed'])).toContain(lane.status)
    expect(lane.status === 'passed').toBe(lane.exit_code === 0)
  }
}

describe('the shared lane budget', () => {
  it('records a skipped required lane in a manifest the validator accepts', () => {
    // A one-millisecond budget kills the first lane, which marks the budget
    // spent, so the second is skipped before it starts. Both paths in one run:
    // the killed lane has a duration, the skipped one does not. (The
    // model-consultation lane's id is `unit`.)
    const { evidence, manifestPath } = runWithBudget(
      1,
      'association-audit,model-consultation',
    )
    const evidenceRoot = resolve('.agent/evidence')
    const removable =
      manifestPath !== null && dirname(dirname(manifestPath)) === evidenceRoot

    try {
      expect(manifestPath, evidence.stdout || evidence.stderr).not.toBeNull()
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

      expectManifestConsistent(manifest)
      expect(manifest.result).toBe('failed')
      expect(evidence.status).toBe(1)

      const killed = manifest.lanes.find((lane) => lane.id === 'association-audit')
      const skipped = manifest.lanes.find((lane) => lane.id === 'unit')
      expect(killed, 'the first lane must still be recorded').toBeDefined()
      expect(skipped, 'the skipped lane must be in lanes, not only in caveats')
        .toBeDefined()

      // Killed: it ran, so it has a duration.
      expect(killed.exit_code).toBe(124)
      expect(killed.status).toBe('failed')

      // Skipped: it never started, and that is what `duration_ms: 0` and the log
      // say — the schema has no `skipped` status to say it with (owner ask #337).
      expect(skipped.exit_code).toBe(124)
      expect(skipped.status).toBe('failed')
      expect(skipped.duration_ms).toBe(0)
      expect(readFileSync(skipped.log_path, 'utf8')).toContain('never started')
      expect(manifest.caveats.join('\n')).toContain('lane not run: unit')

      expect(manifest.required_failures).toEqual(['association-audit', 'unit'])
    } finally {
      if (removable && existsSync(dirname(manifestPath))) {
        rmSync(dirname(manifestPath), { recursive: true, force: true })
      }
    }
  }, 190_000)

  it('leaves an ordinary run consistent too', () => {
    const { evidence, manifestPath } = runWithBudget(180_000, 'association-audit')
    const evidenceRoot = resolve('.agent/evidence')
    const removable =
      manifestPath !== null && dirname(dirname(manifestPath)) === evidenceRoot

    try {
      expect(manifestPath, evidence.stdout || evidence.stderr).not.toBeNull()
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

      expectManifestConsistent(manifest)
      expect(manifest.result).toBe('passed')
      expect(manifest.required_failures).toEqual([])
    } finally {
      if (removable && existsSync(dirname(manifestPath))) {
        rmSync(dirname(manifestPath), { recursive: true, force: true })
      }
    }
  }, 190_000)
})
