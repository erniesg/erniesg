import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The shared lane budget in `scripts/agent-evidence`, exercised against the
 * real producer.
 *
 * A run the budget cuts short still produces a manifest the production
 * validator accepts. The validator is not re-implemented: it is extracted
 * from `.github/workflows/agent-evidence.yml` and run as the workflow runs it,
 * so any check it makes (the association lane must pass, `lanes_run` must
 * equal `lanes`, `required_failures` must match) applies here too.
 *
 * This file runs the producer, so it is excluded from `npm run test`, which is
 * itself the evidence `test` lane: running the producer from inside it would
 * spend the budget it is testing and could leave a nested `.agent/evidence`
 * run in the candidate tree. Run it with `npm run test:agent-evidence`. The
 * static rules about the budget live in `agent-evidence-budget-rule.test.mjs`,
 * which the ordinary test run does include.
 */

const REPOSITORY = 'erniesg/erniesg'
const BRANCH = 'evidence-budget-test'
const PRODUCER = 'scripts/agent-evidence'
const WORKFLOW = '.github/workflows/agent-evidence.yml'

/** The validator heredoc from the workflow, dedented, exactly as it runs. */
function productionValidator() {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const opener = "<<'RUCKSACK_VALIDATE_MANIFEST'\n"
  const start = workflow.indexOf(opener)
  expect(start, 'the workflow validator heredoc').toBeGreaterThan(-1)
  const body = workflow.slice(start + opener.length)
  const end = body.search(/^\s*RUCKSACK_VALIDATE_MANIFEST$/mu)
  expect(end).toBeGreaterThan(0)
  const lines = body.slice(0, end).split('\n')
  const indent = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.match(/^ */u)[0].length),
  )
  return lines.map((line) => line.slice(indent)).join('\n')
}

function validate({ cwd, manifestPath, status, head }) {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-evidence-validator-'))
  try {
    const validator = join(scratch, 'validate.cjs')
    writeFileSync(validator, productionValidator())
    return spawnSync(process.execPath, [validator, manifestPath], {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        EXPECTED_HEAD_SHA: head,
        EXPECTED_REPOSITORY: REPOSITORY,
        EXPECTED_BRANCH: BRANCH,
        EVIDENCE_STATUS: String(status),
        CANONICAL_MANIFEST: join(scratch, 'canonical.json'),
      },
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function gitHead(cwd) {
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8' })
  expect(head.status).toBe(0)
  return head.stdout.trim()
}

function runEvidence({ cwd, only, budgetMs, head }) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    GITHUB_HEAD_SHA: head,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_HEAD_REF: BRANCH,
    GITHUB_REF_NAME: '',
  }
  if (budgetMs === undefined) delete env.AGENT_EVIDENCE_BUDGET_MS
  else env.AGENT_EVIDENCE_BUDGET_MS = String(budgetMs)
  const evidence = spawnSync('sh', [resolve(cwd, PRODUCER), '--only', only], {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    env,
  })
  const match = evidence.stdout.match(
    /\[agent-evidence\] (?:passed|failed): (.+\/manifest\.json)\s*$/u,
  )
  return { evidence, manifestPath: match ? resolve(cwd, match[1]) : null }
}

/** Exactly what the validator derives from `lanes`, restated for a readable failure. */
function expectManifestConsistent(manifest) {
  expect(manifest.lanes_run).toEqual(manifest.lanes.map((lane) => lane.id))
  expect(manifest.required_failures).toEqual(
    manifest.lanes
      .filter((lane) => lane.required && lane.exit_code !== 0)
      .map((lane) => lane.id),
  )
}

function evidenceRuns(cwd) {
  const root = resolve(cwd, '.agent/evidence')
  return existsSync(root) ? new Set(readdirSync(root)) : new Set()
}

let ordinary = null
/** One real run of the real association audit, shared by both cases. */
function ordinaryRun() {
  if (ordinary) return ordinary
  const cwd = resolve('.')
  const head = gitHead(cwd)
  const before = evidenceRuns(cwd)
  const { evidence, manifestPath } = runEvidence({ cwd, only: 'association-audit', head })
  try {
    expect(manifestPath, evidence.stdout || evidence.stderr).not.toBeNull()
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const verdict = validate({
      cwd,
      manifestPath: relative(cwd, manifestPath),
      status: evidence.status,
      head,
    })
    ordinary = { evidence, manifest, verdict }
    return ordinary
  } finally {
    // Every run directory this call created, whether or not the producer got
    // far enough to print its manifest path.
    for (const run of evidenceRuns(cwd)) {
      if (!before.has(run)) {
        rmSync(resolve(cwd, '.agent/evidence', run), { recursive: true, force: true })
      }
    }
  }
}

/**
 * A throwaway repository holding the real producer and receipt checks, with
 * two lane commands replaced: the association audit replays the receipt the
 * real audit just produced, and the unit lane hangs. The budget then expires
 * in a lane the test controls and can reap, never in the real audit, whose
 * Vite grandchild a shell-level kill would leave running.
 */
function budgetFixture(receipt) {
  const root = mkdtempSync(join(tmpdir(), 'agent-evidence-budget-'))
  for (const file of [
    PRODUCER,
    'tools/association-audit-receipt.cjs',
    'tools/model-consultation-evidence-receipt.cjs',
    'tests/fixtures/pdf/note-citation-associations.pdf',
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    copyFileSync(file, join(root, file))
  }
  writeFileSync(
    join(root, 'tools/pdf-association-fixture-audit.mjs'),
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(receipt)}\n`)})\n`,
  )
  const pidFile = join(root, 'hung-lane.pid')
  // Plain JavaScript is valid input to --experimental-strip-types. It exits on
  // its own after a minute in case the reaper below never runs.
  writeFileSync(
    join(root, 'tools/model-consultation-evidence.ts'),
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n` +
      'setTimeout(() => {}, 60_000)\n',
  )
  for (const args of [
    ['init', '-q'],
    ['add', '-A'],
    ['-c', 'user.name=test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'fixture'],
  ]) {
    expect(spawnSync('git', args, { cwd: root }).status).toBe(0)
  }
  return { root, pidFile }
}

function reap(pidFile) {
  if (!existsSync(pidFile)) return
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

describe('the shared lane budget', () => {
  it('leaves an ordinary run valid under the production validator', () => {
    const { manifest, verdict } = ordinaryRun()
    expect(verdict.status, verdict.stderr).toBe(0)
    expectManifestConsistent(manifest)
    expect(manifest.result).toBe('passed')
    expect(manifest.required_failures).toEqual([])
  }, 190_000)

  it('records a killed and a skipped required lane in a manifest the production validator accepts', () => {
    const { manifest: real } = ordinaryRun()
    expect(real.association_audit, 'the real audit receipt').not.toBeNull()
    const { root, pidFile } = budgetFixture(real.association_audit)
    try {
      const head = gitHead(root)
      // Enough for the replayed audit to pass; the hung unit lane then spends
      // the rest, and build is skipped before it starts.
      const { evidence, manifestPath } = runEvidence({
        cwd: root,
        only: 'association-audit,model-consultation,build',
        budgetMs: 10_000,
        head,
      })
      expect(manifestPath, evidence.stdout || evidence.stderr).not.toBeNull()
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

      const verdict = validate({
        cwd: root,
        manifestPath: relative(root, manifestPath),
        status: evidence.status,
        head,
      })
      expect(verdict.status, verdict.stderr).toBe(0)
      expectManifestConsistent(manifest)
      expect(manifest.result).toBe('failed')
      expect(evidence.status).toBe(1)

      const byId = Object.fromEntries(manifest.lanes.map((lane) => [lane.id, lane]))
      expect(byId['association-audit'].status).toBe('passed')

      // Killed: it ran until the budget ran out.
      expect(byId.unit.exit_code).toBe(124)
      expect(byId.unit.duration_ms).toBeGreaterThan(0)
      expect(readFileSync(resolve(root, byId.unit.log_path), 'utf8')).toContain(
        'lane timed out against the shared',
      )

      // Skipped: in `lanes`, not only in caveats, and marked as never started.
      expect(byId.build.exit_code).toBe(124)
      expect(byId.build.status).toBe('failed')
      expect(byId.build.duration_ms).toBe(0)
      expect(readFileSync(resolve(root, byId.build.log_path), 'utf8')).toContain('never started')
      expect(manifest.caveats.join('\n')).toContain('lane not run: build')

      expect(manifest.required_failures).toEqual(['unit', 'build'])
    } finally {
      reap(pidFile)
      rmSync(root, { recursive: true, force: true })
    }
  }, 190_000)
})
