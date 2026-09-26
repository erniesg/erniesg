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
import { publisherVerdict } from './agent-evidence-publisher-verdict.mjs'

/**
 * The shared lane budget in `scripts/agent-evidence`, exercised against the
 * real producer.
 *
 * A run the budget cuts short still produces a manifest the production
 * validator accepts. The validator is not re-implemented: it is extracted
 * from `.github/workflows/agent-evidence.yml` and run as the workflow runs it,
 * so any check it makes (the association lane must pass or be skipped,
 * `lanes_run` must equal the lanes that ran, `required_failures` must match,
 * a skipped required lane blocks rather than fails) applies here too.
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

function runEvidence({ cwd, only, budgetMs, head, nodeOptions }) {
  const env = {
    ...process.env,
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
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
    /\[agent-evidence\] (?:passed|failed|blocked): (.+\/manifest\.json)\s*$/u,
  )
  return { evidence, manifestPath: match ? resolve(cwd, match[1]) : null }
}

/** Exactly what the validator derives from `lanes`, restated for a readable failure. */
function expectManifestConsistent(manifest) {
  expect(manifest.lanes_run).toEqual(
    manifest.lanes.filter((lane) => lane.status !== 'skipped').map((lane) => lane.id),
  )
  expect(manifest.required_failures).toEqual(
    manifest.lanes
      .filter((lane) => lane.required && lane.status !== 'passed')
      .map((lane) => lane.id),
  )
  for (const lane of manifest.lanes.filter(({ status }) => status === 'skipped')) {
    expect(lane.exit_code, `${lane.id} never ran, so it has no exit code`).toBeNull()
    expect(lane.duration_ms).toBe(0)
  }
}

function evidenceRuns(cwd) {
  const root = resolve(cwd, '.agent/evidence')
  return existsSync(root) ? new Set(readdirSync(root)) : new Set()
}

/** The start time a producer run directory is named after (`YYYYMMDDTHHMMSSmmmZ`). */
function stampTime(run) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/u.exec(run)
  if (!match) return null
  const [, y, mo, d, h, mi, sec, ms] = match
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, +ms)
}

/**
 * The run directory this call's producer created, and no other.
 *
 * The printed manifest path names it exactly. If the producer died before
 * printing, the one new directory whose stamp falls inside this call is
 * taken as ours. If there is more than one, another run was going on in the
 * same checkout, so nothing is deleted and the leftovers are named instead.
 */
function ownRunDirectory(cwd, before, manifestPath, startedAt, endedAt) {
  const root = resolve(cwd, '.agent/evidence')
  if (manifestPath !== null && dirname(dirname(manifestPath)) === root) {
    return { own: dirname(manifestPath), ambiguous: [] }
  }
  const candidates = [...evidenceRuns(cwd)].filter((run) => {
    const at = stampTime(run)
    return !before.has(run) && at !== null && at >= startedAt - 1_000 && at <= endedAt
  })
  if (candidates.length === 1) return { own: resolve(root, candidates[0]), ambiguous: [] }
  return { own: null, ambiguous: candidates }
}

let ordinary = null
/** One real run of the real association audit, shared by both cases. */
function ordinaryRun() {
  if (ordinary) return ordinary
  const cwd = resolve('.')
  const head = gitHead(cwd)
  const before = evidenceRuns(cwd)
  const startedAt = Date.now()
  const { evidence, manifestPath } = runEvidence({ cwd, only: 'association-audit', head })
  const endedAt = Date.now()
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
    // Only this call's own run directory: never a concurrent run's evidence.
    const { own, ambiguous } = ownRunDirectory(cwd, before, manifestPath, startedAt, endedAt)
    if (own) rmSync(own, { recursive: true, force: true })
    if (ambiguous.length > 0) {
      console.warn(`[agent-evidence-budget] left unowned run directories: ${ambiguous.join(', ')}`)
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
const HUNG_UNIT_LANE = (pidFile) =>
  `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n` +
  'setTimeout(() => {}, 60_000)\n'

function budgetFixture(receipt, unitLane = HUNG_UNIT_LANE, auditLane = null) {
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
    (auditLane ?? '') +
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(receipt)}\n`)})\n`,
  )
  const pidFile = join(root, 'hung-lane.pid')
  // Plain JavaScript is valid input to --experimental-strip-types. It exits on
  // its own after a minute in case the reaper below never runs.
  writeFileSync(join(root, 'tools/model-consultation-evidence.ts'), unitLane(pidFile))
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

  it('records a killed lane as failed and the lane after it as skipped, in a manifest the production validator accepts', () => {
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

      // Skipped: in `lanes`, not only in caveats, marked as never started, with
      // no exit code, and not in `lanes_run`.
      expect(byId.build.status).toBe('skipped')
      expect(byId.build.exit_code).toBeNull()
      expect(byId.build.duration_ms).toBe(0)
      expect(manifest.lanes_run).not.toContain('build')
      expect(readFileSync(resolve(root, byId.build.log_path), 'utf8')).toContain('never started')
      expect(manifest.caveats.join('\n')).toContain('lane not run: build')

      // unit ran and was killed, so the run failed; build did not pass either.
      expect(manifest.required_failures).toEqual(['unit', 'build'])
    } finally {
      reap(pidFile)
      rmSync(root, { recursive: true, force: true })
    }
  }, 190_000)

  /**
   * A lane that finishes just as the budget runs out leaves the next lane
   * skipped with no lane killed. That boundary is a race on a real clock, so
   * the test moves the producer's clock instead: a `--require` preload shifts
   * `Date.now()` past any budget once the replayed audit lane has written a
   * sentinel file. Only the producer's deadline arithmetic reads `Date.now()`;
   * the lane timeout itself is libuv's, so the audit lane still passes.
   */
  function budgetRunsOutAfterAudit(only) {
    const { manifest: real } = ordinaryRun()
    const scratch = mkdtempSync(join(tmpdir(), 'agent-evidence-clock-'))
    const sentinel = join(scratch, 'budget-spent')
    const clock = join(scratch, 'clock.cjs')
    writeFileSync(
      clock,
      `const { existsSync } = require('node:fs')\n` +
        `const realNow = Date.now\n` +
        `Date.now = () => realNow() + (existsSync(${JSON.stringify(sentinel)}) ? 86_400_000 : 0)\n`,
    )
    // The replayed audit is an ES module, so no `require` here.
    const audit = `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(sentinel)}, '')\n`
    const { root, pidFile } = budgetFixture(real.association_audit, HUNG_UNIT_LANE, audit)
    try {
      const head = gitHead(root)
      const { evidence, manifestPath } = runEvidence({
        cwd: root,
        only,
        budgetMs: 600_000,
        head,
        nodeOptions: `--require ${clock}`,
      })
      expect(manifestPath, evidence.stdout || evidence.stderr).not.toBeNull()
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const verdict = validate({
        cwd: root,
        manifestPath: relative(root, manifestPath),
        status: evidence.status,
        head,
      })
      return { evidence, manifest, verdict }
    } finally {
      reap(pidFile)
      rmSync(root, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  it('blocks, never fails or passes, a run whose only unpassed required lane was skipped', () => {
    const { evidence, manifest, verdict } = budgetRunsOutAfterAudit('association-audit,build')
    expect(verdict.status, verdict.stderr).toBe(0)
    expectManifestConsistent(manifest)

    const byId = Object.fromEntries(manifest.lanes.map((lane) => [lane.id, lane]))
    expect(byId['association-audit'].status).toBe('passed')
    expect(byId.build.status).toBe('skipped')
    expect(manifest.lanes_run).toEqual(['association-audit'])
    expect(manifest.required_failures).toEqual(['build'])

    // Could not be evaluated: blocked on the machine's time, exit 2, not a
    // test failure (1) and never a pass (0), with a reason that names the lane.
    expect(manifest.result).toBe('blocked')
    expect(evidence.status).toBe(2)
    expect(manifest.blocked_class).toBe('blocked-environment')
    expect(manifest.blocked_reason).toContain('evidence budget ran out before these required lanes started: build')
    expect(manifest.blocked_reason).toContain('the association-audit lane consumed it')
  }, 190_000)

  it('keeps a passed run passed when only an optional lane was skipped', () => {
    const { evidence, manifest, verdict } = budgetRunsOutAfterAudit('association-audit,e2e')
    expect(verdict.status, verdict.stderr).toBe(0)
    expectManifestConsistent(manifest)

    const byId = Object.fromEntries(manifest.lanes.map((lane) => [lane.id, lane]))
    expect(byId.e2e.required).toBe(false)
    expect(byId.e2e.status).toBe('skipped')
    expect(manifest.caveats.join('\n')).toContain('lane not run: e2e')
    expect(manifest.result).toBe('passed')
    expect(manifest.required_failures).toEqual([])
    expect(evidence.status).toBe(0)

    // CI is green, so publication must accept the same manifest: its only
    // caveat is the producer's note naming the skipped optional lane.
    expect(manifest.caveats).toEqual([expect.stringMatching(/^lane not run: e2e; /u)])
    const published = publisherVerdict(manifest, {
      repository: REPOSITORY,
      branch: BRANCH,
      head: manifest.commit,
    })
    expect(published.accepted, published.reason).toBe(true)
  }, 190_000)

  it('treats a lane that exits 124 on its own, before the deadline, as an ordinary failure', () => {
    // GNU `timeout` inside a lane's own script exits 124 too. With the budget
    // barely spent, that must not be blamed on the budget or skip later lanes.
    const { manifest: real } = ordinaryRun()
    const { root, pidFile } = budgetFixture(real.association_audit, () => 'process.exit(124)\n')
    try {
      const head = gitHead(root)
      const { evidence, manifestPath } = runEvidence({
        cwd: root,
        only: 'association-audit,model-consultation,build',
        budgetMs: 120_000,
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

      const byId = Object.fromEntries(manifest.lanes.map((lane) => [lane.id, lane]))
      expect(byId.unit.exit_code).toBe(124)
      expect(readFileSync(resolve(root, byId.unit.log_path), 'utf8')).not.toContain(
        'lane timed out against the shared',
      )
      // build still ran: it was not skipped as "never started".
      expect(readFileSync(resolve(root, byId.build.log_path), 'utf8')).not.toContain(
        'never started',
      )
      expect((manifest.caveats ?? []).join('\n')).not.toContain('lane not run')
    } finally {
      reap(pidFile)
      rmSync(root, { recursive: true, force: true })
    }
  }, 190_000)
})
