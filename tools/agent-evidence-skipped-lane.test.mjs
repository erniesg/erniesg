import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A lane the evidence budget never started is `skipped` (erniesg#337), and
 * both manifest validators agree on what that means:
 *
 * - it records `exit_code: null` (never 0, which reads as a pass) and
 *   `duration_ms: 0`, and it is not in `lanes_run`;
 * - a skipped required lane is a required failure that could not be
 *   evaluated: with no required lane that ran and failed, the run is
 *   `blocked` / `blocked-environment` / exit 2, never `failed` and never
 *   `passed`;
 * - a skipped optional lane changes nothing.
 *
 * The validators are extracted from the workflows and run as the workflows
 * run them. The producer side is exercised end to end by
 * `agent-evidence-budget.test.mjs`.
 */

const HEAD = 'a'.repeat(40)
const REPOSITORY = 'erniesg/erniesg'
const BRANCH = 'evidence-skipped-lane-test'
const MANIFEST = '.agent/evidence/run/manifest.json'
const EVIDENCE = '.github/workflows/agent-evidence.yml'
const PUBLISHER = '.github/workflows/agent-evidence-publisher.yml'

/** The validator heredoc from a workflow, dedented, exactly as it runs. */
function validatorFrom(workflowPath) {
  const workflow = readFileSync(workflowPath, 'utf8')
  const opener = "<<'RUCKSACK_VALIDATE_MANIFEST'\n"
  const start = workflow.indexOf(opener)
  expect(start, `${workflowPath} validator heredoc`).toBeGreaterThan(-1)
  expect(workflow.indexOf(opener, start + 1), `${workflowPath} has one validator`).toBe(-1)
  const body = workflow.slice(start + opener.length)
  const end = body.search(/^\s*RUCKSACK_VALIDATE_MANIFEST$/mu)
  const lines = body.slice(0, end).split('\n')
  const indent = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.match(/^ */u)[0].length),
  )
  return lines.map((line) => line.slice(indent)).join('\n')
}

function lane(id, { required = true, status }) {
  const ran = status !== 'skipped'
  return {
    id,
    command: `run ${id}`,
    required,
    status,
    exit_code: ran ? (status === 'passed' ? 0 : 1) : null,
    duration_ms: ran ? 1 : 0,
    log_path: `.agent/evidence/run/logs/${id}.log`,
  }
}

function manifest(lanes, extra = {}) {
  return {
    schema_version: '1',
    run_id: 'agent-evidence-run',
    repo: REPOSITORY,
    branch: BRANCH,
    commit: HEAD,
    dirty: false,
    started_at: '2026-09-24T00:00:00.000Z',
    ended_at: '2026-09-24T00:00:00.001Z',
    duration_ms: 1,
    agent_version: 'b'.repeat(64),
    invocation: { argv: [], npm_config_e2e: '', npm_config_only: '' },
    lanes_run: lanes.filter(({ status }) => status !== 'skipped').map(({ id }) => id),
    runner: { provider: 'local', os: 'linux', node: 'v22.0.0' },
    lanes,
    association_audit: null,
    artifacts: [{ kind: 'manifest', path: MANIFEST }],
    result: 'passed',
    required_failures: lanes
      .filter(({ required, status }) => required && status !== 'passed')
      .map(({ id }) => id),
    ...extra,
  }
}

function validate(workflowPath, value, status) {
  const root = mkdtempSync(join(tmpdir(), 'agent-evidence-skipped-'))
  try {
    mkdirSync(join(root, '.agent/evidence/run'), { recursive: true })
    writeFileSync(join(root, MANIFEST), `${JSON.stringify(value)}\n`)
    const validator = join(root, 'validate.cjs')
    writeFileSync(validator, validatorFrom(workflowPath))
    return spawnSync(process.execPath, [validator, MANIFEST], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        EXPECTED_HEAD_SHA: HEAD,
        EXPECTED_REPOSITORY: REPOSITORY,
        EXPECTED_BRANCH: BRANCH,
        EVIDENCE_STATUS: String(status),
        CANONICAL_MANIFEST: join(root, 'canonical.json'),
      },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const BUDGET_BLOCK = {
  result: 'blocked',
  blocked_class: 'blocked-environment',
  blocked_reason: 'the shared evidence budget ran out before these required lanes started: build',
}

/**
 * The publisher validator is the generic one, so any lane id will do. The
 * evidence workflow validator also requires the association-audit lane and its
 * receipt; a skipped audit lane carries none, which is the one shape it can
 * validate without a real receipt.
 */
const auditSkipped = lane('association-audit', { status: 'skipped' })
auditSkipped.command = 'node tools/pdf-association-fixture-audit.mjs'

// [name, workflow, manifest, evidence exit status, accepted]
const CASES = [
  ['optional skipped keeps a passed run', PUBLISHER,
    manifest([lane('unit', { status: 'passed' }), lane('e2e', { required: false, status: 'skipped' })]), 0, true],
  ['required skipped is blocked in the budget class', PUBLISHER,
    manifest([lane('unit', { status: 'passed' }), lane('build', { status: 'skipped' })], BUDGET_BLOCK), 2, true],
  ['required skipped after a lane that ran and failed stays failed', PUBLISHER,
    manifest([lane('unit', { status: 'failed' }), lane('build', { status: 'skipped' })], { result: 'failed' }), 1, true],
  ['required skipped reported as a test failure', PUBLISHER,
    manifest([lane('unit', { status: 'passed' }), lane('build', { status: 'skipped' })], { result: 'failed' }), 1, false],
  ['required skipped reported as passed', PUBLISHER,
    manifest([lane('unit', { status: 'passed' }), lane('build', { status: 'skipped' })]), 0, false],
  ['required skipped blocked in a class that is not the budget\'s', PUBLISHER,
    manifest([lane('unit', { status: 'passed' }), lane('build', { status: 'skipped' })],
      { ...BUDGET_BLOCK, blocked_class: 'blocked-decision' }), 4, false],
  ['required skipped blocked without a reason', PUBLISHER,
    manifest([lane('unit', { status: 'passed' }), lane('build', { status: 'skipped' })],
      { result: 'blocked', blocked_class: 'blocked-environment' }), 2, false],
  ['skipped lane claiming exit 0', PUBLISHER,
    manifest([lane('unit', { status: 'passed' }), { ...lane('e2e', { required: false, status: 'skipped' }), exit_code: 0 }]), 0, false],
  ['skipped lane claiming the budget kill exit', PUBLISHER,
    manifest([lane('unit', { status: 'passed' }), { ...lane('e2e', { required: false, status: 'skipped' }), exit_code: 124 }]), 0, false],
  ['skipped lane listed in lanes_run', PUBLISHER,
    manifest([lane('unit', { status: 'passed' }), lane('e2e', { required: false, status: 'skipped' })],
      { lanes_run: ['unit', 'e2e'] }), 0, false],
  ['every lane skipped is blocked in the budget class', EVIDENCE,
    manifest([auditSkipped, lane('build', { status: 'skipped' })],
      { ...BUDGET_BLOCK, blocked_reason: 'the shared evidence budget ran out before these required lanes started: association-audit, build' }), 2, true],
  ['every lane skipped reported as a test failure', EVIDENCE,
    manifest([auditSkipped, lane('build', { status: 'skipped' })], { result: 'failed' }), 1, false],
  ['a skipped audit lane claiming exit 0', EVIDENCE,
    manifest([{ ...auditSkipped, exit_code: 0 }, lane('build', { status: 'skipped' })], BUDGET_BLOCK), 2, false],
  ['a skipped audit lane listed in lanes_run', EVIDENCE,
    manifest([auditSkipped, lane('build', { status: 'skipped' })],
      { ...BUDGET_BLOCK, lanes_run: ['association-audit'] }), 2, false],
]

describe('a lane the evidence budget never started', () => {
  it.each(CASES)('%s', (_name, workflowPath, value, status, accepted) => {
    const verdict = validate(workflowPath, value, status)
    expect(verdict.status === 0, verdict.stderr || verdict.stdout).toBe(accepted)
  })

  it('is judged by the same lines in both workflow validators', () => {
    // The skipped-lane rules, as each validator states them. The evidence
    // workflow's validator is repository-specific elsewhere (lane ids, the
    // association audit), so the rule is held line for line, not file for file.
    const rule = (source) => {
      const lines = source.split('\n')
      const from = lines.findIndex((line) => line.startsWith('  // "skipped": a lane the evidence budget'))
      const to = lines.findIndex((line, index) => index > from && line === '});')
      const lanesRun = lines.filter((line) => /ranLaneIds|lanes that ran/u.test(line))
      const failures = lines.filter((line) =>
        /ranRequiredFailures|budgetSkippedClass|required lanes that did not pass|lane\.status !== "passed"/u.test(line))
      return [...lines.slice(from, to), ...lanesRun, ...failures]
    }
    const evidence = rule(validatorFrom(EVIDENCE))
    expect(evidence.length).toBeGreaterThan(20)
    expect(evidence).toEqual(rule(validatorFrom(PUBLISHER)))
  })
})
