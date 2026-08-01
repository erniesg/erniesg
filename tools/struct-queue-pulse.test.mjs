import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  classifyRepositorySessions,
  classifyVmSessions,
  evaluateDiskCapacity,
  evaluateTimerHealth,
  parseTargetUnit,
  selectSafeCleanupCandidates,
} from './struct-queue-pulse.mjs'

const servicePath = new URL(
  '../infra/vm/systemd/erniesg-struct-typeset-queue.service',
  import.meta.url,
)
const service = readFileSync(servicePath, 'utf8')
const issueSpec = readFileSync(
  new URL(
    '../docs/issues/048-vm-drain-persistence-and-checkpoints.md',
    import.meta.url,
  ),
  'utf8',
)
const pulsePath = fileURLToPath(
  new URL('./struct-queue-pulse.mjs', import.meta.url),
)
const fakeSystemctlPath = new URL(
  '../tests/fixtures/struct-queue-systemctl.mjs',
  import.meta.url,
)

const now = Date.parse('2026-08-01T12:00:00Z')

const session = (overrides = {}) => ({
  session_id: 'rucksack-erniesg-erniesg-issue-119-deadbeef',
  issue_number: '119',
  repo: 'erniesg/erniesg',
  provider: 'vm-codex',
  branch: 'codex/issue-119-rucksack',
  tmux_session: 'rucksack-erniesg-erniesg-issue-119-deadbeef',
  local_checkout_path: '/srv/worktrees/erniesg/issue-119-vm-codex',
  log_path: '/srv/worktrees/erniesg/issue-119-vm-codex/run.log',
  heartbeat_at: '2026-08-01T11:55:00Z',
  lease_expires_at: '2026-08-01T23:55:00Z',
  ...overrides,
})

describe('STRUCT queue pulse contract', () => {
  it('runs the lease-aware pulse helper instead of embedding a brittle shell probe', () => {
    expect(service).toContain('tools/struct-queue-pulse.mjs')
    expect(service).not.toContain('pgrep -af')
    expect(service).not.toContain(
      'rucksack-autopilot-v1-ZXJuaWVzZy9lcm5pZXNn-drain.service',
    )
  })

  it('does not make the repo pulse own the drain or detached worker lifetime', () => {
    expect(service).not.toContain('start --wait')
    expect(service).toContain('TimeoutStartSec=30min')
    expect(service).toContain('TimeoutStopSec=5min')
  })

  it('accepts only one validated installer-owned drain target', () => {
    expect(
      parseTargetUnit(
        'rucksack-autopilot-v1-ZXJuaWVzZy9lcm5pZXNn-drain.service\n',
      ),
    ).toBe('rucksack-autopilot-v1-ZXJuaWVzZy9lcm5pZXNn-drain.service')

    expect(() => parseTargetUnit('rucksack-app.service')).toThrow(
      /drain target/,
    )
    expect(() =>
      parseTargetUnit(
        'rucksack-autopilot-safe-drain.service\nmalicious.service',
      ),
    ).toThrow(/exactly one/)
  })

  it('counts an exact live tmux session as the repository global slot', () => {
    const result = classifyRepositorySessions({
      ledger: { schema_version: 1, sessions: [session()] },
      repo: 'erniesg/erniesg',
      now,
      processArgs: [
        'tmux -L rucksack-0123 new-session -d -s rucksack-erniesg-erniesg-issue-119-deadbeef',
      ],
    })

    expect(result.status).toBe('ok')
    expect(result.live).toHaveLength(1)
    expect(result.availableSlots).toBe(0)
  })

  it('frees one slot after a completed or safely expired session', () => {
    const completed = classifyRepositorySessions({
      ledger: { schema_version: '1', sessions: [session()] },
      repo: 'erniesg/erniesg',
      now,
      processArgs: [],
    })
    const expired = classifyRepositorySessions({
      ledger: {
        schema_version: '1',
        sessions: [session({ lease_expires_at: '2026-08-01T10:00:00Z' })],
      },
      repo: 'erniesg/erniesg',
      now,
      processArgs: [],
    })

    expect(completed.completed).toHaveLength(1)
    expect(completed.availableSlots).toBe(1)
    expect(expired.expired).toHaveLength(1)
    expect(expired.availableSlots).toBe(1)
  })

  it('preserves a running worker even when its heartbeat lease expired', () => {
    const result = classifyRepositorySessions({
      ledger: {
        schema_version: '1',
        sessions: [session({ lease_expires_at: '2026-08-01T10:00:00Z' })],
      },
      repo: 'erniesg/erniesg',
      now,
      processArgs: [
        'tmux -L rucksack-0123 new-session -d -s rucksack-erniesg-erniesg-issue-119-deadbeef',
      ],
    })

    expect(result.live).toHaveLength(1)
    expect(result.availableSlots).toBe(0)
  })

  it('keeps the default host-wide cap at one until resource claims are proven', () => {
    const otherRepo = session({
      repo: 'erniesg/rucksack',
      issue_number: '349',
      session_id: 'rucksack-erniesg-rucksack-issue-349-feedface',
      tmux_session: 'rucksack-erniesg-rucksack-issue-349-feedface',
      branch: 'codex/issue-349-rucksack',
      local_checkout_path: '/srv/worktrees/rucksack/issue-349-vm-codex',
      log_path: '/srv/worktrees/rucksack/issue-349-vm-codex/run.log',
    })
    const result = classifyVmSessions({
      ledger: { schema_version: 1, sessions: [otherRepo] },
      now,
      processArgs: [
        `tmux -L rucksack-4567 new-session -d -s ${otherRepo.tmux_session}`,
      ],
    })

    expect(result.status).toBe('ok')
    expect(result.live).toMatchObject([
      { repo: 'erniesg/rucksack', issue_number: '349' },
    ])
    expect(result.availableSlots).toBe(0)
    expect(issueSpec).toContain('one parser-core worker plus one')
    expect(issueSpec).toContain('Rucksack issues `erniesg/rucksack#347`')
    expect(issueSpec).toContain('Unknown claims, overlapping scopes, or low')
  })

  it('fails closed when repository lease state is missing or malformed', () => {
    expect(
      classifyRepositorySessions({
        ledger: undefined,
        repo: 'erniesg/erniesg',
        now,
        processArgs: [],
      }),
    ).toMatchObject({ status: 'blocked', availableSlots: 0 })

    expect(
      classifyRepositorySessions({
        ledger: {
          schema_version: '1',
          sessions: [session({ lease_expires_at: 'not-a-time' })],
        },
        repo: 'erniesg/erniesg',
        now,
        processArgs: [],
      }),
    ).toMatchObject({ status: 'blocked', availableSlots: 0 })
  })

  it('blocks dispatch at either disk high-water threshold', () => {
    expect(
      evaluateDiskCapacity({
        totalBytes: 100,
        freeBytes: 10,
        highWaterPercent: 90,
        minimumFreeBytes: 5,
      }),
    ).toMatchObject({ blocked: true, reason: 'disk-high-water' })

    expect(
      evaluateDiskCapacity({
        totalBytes: 100,
        freeBytes: 20,
        highWaterPercent: 90,
        minimumFreeBytes: 25,
      }),
    ).toMatchObject({ blocked: true, reason: 'disk-free-space-low' })
  })

  it('requires the repo scheduler, future fire, and exact timeout policy', () => {
    const healthy = evaluateTimerHealth({
      timerProperties:
        'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nSubState=waiting\n',
      timerList:
        'Sat 2026-08-01 12:30:00 UTC 25min Sat 2026-08-01 12:00:00 UTC 5min ago erniesg-struct-typeset-queue.timer erniesg-struct-typeset-queue.service\n',
      serviceProperties: 'TimeoutStartUSec=30min\nTimeoutStopUSec=5min\n',
    })
    const masked = evaluateTimerHealth({
      timerProperties:
        'LoadState=masked\nUnitFileState=masked\nActiveState=inactive\nSubState=dead\n',
      timerList: 'n/a n/a n/a n/a erniesg-struct-typeset-queue.timer\n',
      serviceProperties: 'TimeoutStartUSec=30min\nTimeoutStopUSec=5min\n',
    })

    expect(healthy.healthy).toBe(true)
    expect(masked).toMatchObject({
      healthy: false,
      reason: 'scheduler-health-invalid',
    })
  })

  it('allows cleanup only for checkpointed terminal worktrees and reproducible caches', () => {
    const completedSession = session({
      session_id: 'completed-session',
      tmux_session: 'completed-session',
      local_checkout_path: '/srv/worktrees/erniesg/completed',
    })
    const liveSession = session({
      session_id: 'live-session',
      tmux_session: 'live-session',
      local_checkout_path: '/srv/worktrees/erniesg/live',
    })
    const sessionState = {
      status: 'ok',
      live: [liveSession],
      completed: [completedSession],
      expired: [],
    }
    const candidates = [
      {
        kind: 'worktree',
        path: '/srv/worktrees/erniesg/live',
        session_id: 'live-session',
        checkpoint: { cleanup_eligible: true, status: 'completed' },
      },
      {
        kind: 'worktree',
        path: '/srv/worktrees/erniesg/completed',
        session_id: 'completed-session',
        checkpoint: {
          schema_version: '1',
          repo: 'erniesg/erniesg',
          session_id: 'completed-session',
          worktree: '/srv/worktrees/erniesg/completed',
          cleanup_eligible: true,
          status: 'completed',
          source_sha: '0123456789abcdef0123456789abcdef01234567',
        },
      },
      {
        kind: 'reproducible-cache',
        path: '/srv/cache/reproducible/pdf-renders',
        reproducible: true,
      },
      {
        kind: 'reproducible-cache',
        path: '/srv/state/evidence',
        reproducible: true,
      },
    ]

    const result = selectSafeCleanupCandidates({
      candidates,
      repo: 'erniesg/erniesg',
      sessionState,
      worktreeRoot: '/srv/worktrees/erniesg',
      reproducibleCacheRoot: '/srv/cache/reproducible',
      protectedRoots: ['/srv/state', '/srv/handoffs'],
      protectedPaths: ['/srv/state/evidence/manifest.json'],
    })

    expect(result.allowed.map((candidate) => candidate.path)).toEqual([
      '/srv/worktrees/erniesg/completed',
      '/srv/cache/reproducible/pdf-renders',
    ])
    expect(result.rejected).toHaveLength(2)
  })
})

const runPulse = ({
  sessions = [],
  processArgs = [],
  disk = { totalBytes: 100, freeBytes: 40 },
  systemctlState = 'healthy',
} = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'struct-queue-pulse-'))
  const overnight = join(root, 'overnight')
  const state = join(root, 'state')
  const checkpoint = join(state, 'checkpoints/latest.json')
  const calls = join(root, 'systemctl-calls.jsonl')
  const processSnapshot = join(root, 'process-snapshot.txt')
  const diskState = join(root, 'disk-state.json')
  mkdirSync(overnight, { recursive: true })
  mkdirSync(state, { recursive: true })
  writeFileSync(
    join(overnight, 'erniesg-erniesg.target'),
    'rucksack-autopilot-v1-ZXJuaWVzZy9lcm5pZXNn-drain.service\n',
  )
  writeFileSync(
    join(state, 'vm-sessions.json'),
    `${JSON.stringify({ schema_version: 1, sessions })}\n`,
  )
  writeFileSync(processSnapshot, `${processArgs.join('\n')}\n`)
  writeFileSync(diskState, `${JSON.stringify(disk)}\n`)
  chmodSync(fakeSystemctlPath, 0o755)

  const result = spawnSync(process.execPath, [pulsePath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      STRUCT_QUEUE_REPO_ROOT: root,
      STRUCT_QUEUE_STATE_ROOT: state,
      STRUCT_QUEUE_OVERNIGHT_ROOT: overnight,
      STRUCT_QUEUE_CHECKPOINT_FILE: checkpoint,
      STRUCT_QUEUE_WORKTREE_ROOT: join(root, 'worktrees'),
      STRUCT_QUEUE_REPRODUCIBLE_CACHE_ROOT: join(root, 'cache/reproducible'),
      STRUCT_QUEUE_HANDOFF_ROOT: join(root, 'handoffs'),
      STRUCT_QUEUE_SYSTEMCTL: fileURLToPath(fakeSystemctlPath),
      STRUCT_QUEUE_PROCESS_SNAPSHOT_FILE: processSnapshot,
      STRUCT_QUEUE_DISK_STATE_FILE: diskState,
      STRUCT_QUEUE_MINIMUM_FREE_BYTES: '5',
      STRUCT_QUEUE_DISK_HIGH_WATER_PERCENT: '90',
      STRUCT_QUEUE_FAKE_SYSTEMCTL_STATE: systemctlState,
      STRUCT_QUEUE_FAKE_SYSTEMCTL_CALLS: calls,
    },
  })
  if (!existsSync(checkpoint)) {
    throw new Error(
      `queue pulse did not write a checkpoint: ${result.stderr || result.error || 'unknown failure'}`,
    )
  }
  const savedCheckpoint = JSON.parse(readFileSync(checkpoint, 'utf8'))
  const systemctlCalls = readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  rmSync(root, { recursive: true, force: true })
  return { result, checkpoint: savedCheckpoint, systemctlCalls }
}

describe('STRUCT queue pulse resumability', () => {
  it('starts the isolated drain without waiting and leaves an atomic checkpoint', () => {
    const { result, checkpoint, systemctlCalls } = runPulse()

    expect(result.status, JSON.stringify(checkpoint)).toBe(0)
    expect(checkpoint).toMatchObject({
      schema_version: '1',
      outcome: 'dispatch-requested',
      failure_class: null,
    })
    expect(systemctlCalls).toContainEqual([
      '--user',
      'start',
      '--no-block',
      'rucksack-autopilot-v1-ZXJuaWVzZy9lcm5pZXNn-drain.service',
    ])
  })

  it('records the exact live worker and does not dispatch a duplicate', () => {
    const active = session()
    const { result, checkpoint, systemctlCalls } = runPulse({
      sessions: [active],
      processArgs: [
        `tmux -L rucksack-0123 new-session -d -s ${active.tmux_session}`,
      ],
    })

    expect(result.status).toBe(0)
    expect(checkpoint).toMatchObject({
      outcome: 'worker-active',
      live_sessions: [{ issue: '119', session_id: active.session_id }],
    })
    expect(systemctlCalls.some((args) => args.includes('start'))).toBe(false)
  })

  it('recognizes a normal codex exec process and never clears containment masks', () => {
    const { result, checkpoint, systemctlCalls } = runPulse({
      processArgs: [
        '/home/ubuntu/.local/bin/codex exec --model gpt-5.6-sol resume',
      ],
    })

    expect(result.status).toBe(0)
    expect(checkpoint.outcome).toBe('worker-active')
    expect(systemctlCalls.some((args) => args.includes('start'))).toBe(false)
    expect(systemctlCalls.some((args) => args.includes('unmask'))).toBe(false)
  })

  it('fails closed at high water and records the recovery action', () => {
    const { result, checkpoint, systemctlCalls } = runPulse({
      disk: { totalBytes: 100, freeBytes: 10 },
    })

    expect(result.status).toBe(2)
    expect(checkpoint).toMatchObject({
      outcome: 'queue-health-blocked',
      failure_class: 'disk-high-water',
    })
    expect(checkpoint.next_action).toMatch(
      /active worktrees, handoffs, receipts/,
    )
    expect(systemctlCalls.some((args) => args.includes('start'))).toBe(false)
  })

  it('records a masked scheduler as a health failure', () => {
    const { result, checkpoint, systemctlCalls } = runPulse({
      systemctlState: 'masked-timer',
    })

    expect(result.status).toBe(2)
    expect(checkpoint).toMatchObject({
      outcome: 'queue-health-blocked',
      failure_class: 'scheduler-health-invalid',
    })
    expect(systemctlCalls.some((args) => args.includes('start'))).toBe(false)
  })

  it('does not unmask a generated drain held by Rucksack containment', () => {
    const { result, checkpoint, systemctlCalls } = runPulse({
      systemctlState: 'masked-target',
    })

    expect(result.status).toBe(2)
    expect(checkpoint).toMatchObject({
      outcome: 'queue-health-blocked',
      failure_class: 'drain-target-unavailable',
    })
    expect(systemctlCalls.some((args) => args.includes('unmask'))).toBe(false)
  })
})
