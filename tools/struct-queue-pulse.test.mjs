import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  accountActiveSlots,
  buildCheckpoint,
  createWorkerReceipt,
  evaluateQueueHealth,
  parseCheckpoint,
  RETRY_COMMAND,
  retryExhausted,
  resolveDrainTarget,
  writeAtomicJson,
} from './struct-queue-pulse.mjs'

const now = Date.parse('2026-08-01T12:00:00.000Z')
const healthyState = {
  timer: {
    LoadState: 'loaded',
    UnitFileState: 'enabled',
    ActiveState: 'active',
    SubState: 'waiting',
    NextElapseUSecRealtime: String((now + 60_000) * 1_000),
  },
  service: {
    LoadState: 'loaded',
    TimeoutStartUSec: '30min',
    TimeoutStopUSec: '5min',
  },
  target: { LoadState: 'loaded', ActiveState: 'inactive', Result: 'success' },
}

function queueState(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: 'erniesg/erniesg',
    observedAt: '2026-08-01T11:59:00.000Z',
    sessions: [],
    leases: [],
    issues: [],
    ...overrides,
  }
}

describe('STRUCT queue timer health', () => {
  it('accepts only a loaded, enabled, active timer with a future fire and exact timeouts', () => {
    expect(evaluateQueueHealth({ ...healthyState, now })).toMatchObject({
      healthy: true,
    })
  })

  it.each([
    ['masked', { timer: { ...healthyState.timer, LoadState: 'masked' } }],
    ['failed', { target: { ...healthyState.target, ActiveState: 'failed' } }],
    ['missing', { timer: { ...healthyState.timer, UnitFileState: '' } }],
    [
      'past',
      {
        timer: {
          ...healthyState.timer,
          NextElapseUSecRealtime: String((now - 1) * 1_000),
        },
      },
    ],
  ])('rejects %s state as queue-health failure', (_name, replacement) => {
    expect(
      evaluateQueueHealth({ ...healthyState, ...replacement, now }).healthy,
    ).toBe(false)
  })
})

describe('cross-pulse active-slot accounting', () => {
  const live = {
    issue: 113,
    status: 'running',
    expiresAt: '2026-08-01T12:30:00.000Z',
  }

  it('launches nothing when one exact live session and lease consume capacity one', () => {
    const result = accountActiveSlots(
      queueState({ sessions: [live], leases: [{ ...live, status: 'active' }] }),
      { now },
    )
    expect(result).toMatchObject({
      ok: true,
      active: 1,
      available: 0,
      liveIssues: [113],
    })
  })

  it('frees exactly one slot after both session and lease expire', () => {
    const expired = { ...live, expiresAt: '2026-08-01T11:30:00.000Z' }
    expect(
      accountActiveSlots(
        queueState({ sessions: [expired], leases: [expired] }),
        { now },
      ),
    ).toMatchObject({
      ok: true,
      active: 0,
      available: 1,
    })
  })

  it.each([
    ['missing lease', queueState({ sessions: [live] })],
    [
      'malformed lease',
      queueState({ sessions: [live], leases: [{ ...live, expiresAt: null }] }),
    ],
    ['stale state', queueState({ observedAt: '2026-08-01T10:00:00.000Z' })],
  ])('fails closed for %s', (_name, state) => {
    expect(accountActiveSlots(state, { now })).toMatchObject({
      ok: false,
      failClosed: true,
      available: 0,
    })
  })

  it('records human-blocked issues so dispatch can never select them', () => {
    const result = accountActiveSlots(
      queueState({
        issues: [{ issue: 115, labels: ['rucksack-needs-human'] }],
      }),
      { now },
    )
    expect(result.blockedIssues).toEqual([115])
  })
})

describe('stable target and skill receipt', () => {
  it('resolves a validated installer-owned target without a repo-hard-coded version', () => {
    const state = resolveDrainTarget(
      JSON.stringify({
        schemaVersion: 1,
        repository: 'erniesg/erniesg',
        managedBy: 'rucksack-installer',
        serviceUnit: 'rucksack-autopilot-v9-generated-drain.service',
        structTypesetSkillPath: '/opt/rucksack/skills/struct-typeset/SKILL.md',
        structTypesetSkillSha256: 'a'.repeat(64),
      }),
    )
    expect(state.serviceUnit).toBe(
      'rucksack-autopilot-v9-generated-drain.service',
    )
  })

  it('rejects malformed target state instead of guessing a generated unit', () => {
    expect(() => resolveDrainTarget('{"serviceUnit":"../../unsafe"}')).toThrow()
  })

  it('records the exact installed skill digest and future worker profile', () => {
    const directory = mkdtempSync(join(tmpdir(), 'struct-skill-'))
    const skillPath = join(directory, 'SKILL.md')
    writeFileSync(skillPath, 'pinned skill\n')
    chmodSync(skillPath, 0o444)
    const receipt = createWorkerReceipt({
      structTypesetSkillPath: skillPath,
      structTypesetSkillSha256:
        '85661e90d3000eea4550a205e9d7ceac44f54676a3985d2b2fd411313eb58c1b',
    })
    expect(receipt).toEqual({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      structTypesetSkillSha256:
        '85661e90d3000eea4550a205e9d7ceac44f54676a3985d2b2fd411313eb58c1b',
    })
  })
})

describe('atomic resumable checkpoints', () => {
  it.each([
    ['interrupted', 'worker-interrupted'],
    ['completed', null],
    ['provider-blocked', 'provider'],
  ])('round-trips an explicit %s worker outcome', (status, failureClass) => {
    const checkpoint = buildCheckpoint({
      status,
      issue: 115,
      branch: 'codex/issue-115-rucksack',
      sourceSha: 'd'.repeat(40),
      evidenceManifest: '.agent/evidence/run/manifest.json',
      tests: [{ command: 'npm test', status: 'passed' }],
      visualArtifacts: {
        source: ['source-page-3.png'],
        output: ['render-page-3.png'],
      },
      nextIssue: 115,
      nextAction: 'resume page 3 source comparison',
      nextCommand:
        'systemctl --user start erniesg-struct-typeset-queue.service',
      failureClass,
      failureMessage: failureClass ? 'actionable failure' : null,
    })
    expect(parseCheckpoint(JSON.stringify(checkpoint))).toMatchObject({
      status,
      issue: 115,
    })
  })

  it('replaces the checkpoint atomically with one parseable document', () => {
    const directory = mkdtempSync(join(tmpdir(), 'struct-checkpoint-'))
    const path = join(directory, 'checkpoint.json')
    const checkpoint = buildCheckpoint({
      status: 'completed',
      nextAction: 'run next issue',
      nextCommand: 'resume',
    })
    writeAtomicJson(path, checkpoint)
    expect(parseCheckpoint(readFileSync(path, 'utf8')).status).toBe('completed')
  })

  it('stops automatic retries after the configured two actionable failures', () => {
    const checkpoint = buildCheckpoint({
      status: 'provider-blocked',
      attempt: 2,
      nextAction: 'human gate: restore provider login',
      nextCommand: RETRY_COMMAND,
      failureClass: 'provider',
      failureMessage: 'provider login expired',
    })
    expect(retryExhausted(checkpoint)).toBe(true)
    expect(retryExhausted({ ...checkpoint, attempt: 1 })).toBe(false)
  })
})
