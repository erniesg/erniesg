import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  classifyRepositorySessions,
  evaluateDiskCapacity,
  parseTargetUnit,
  selectSafeCleanupCandidates,
} from './struct-queue-pulse.mjs'

const servicePath = new URL(
  '../infra/vm/systemd/erniesg-struct-typeset-queue.service',
  import.meta.url,
)
const service = readFileSync(servicePath, 'utf8')

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
      ledger: { schema_version: '1', sessions: [session()] },
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
        sessions: [
          session({ lease_expires_at: '2026-08-01T10:00:00Z' }),
        ],
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
        sessions: [
          session({ lease_expires_at: '2026-08-01T10:00:00Z' }),
        ],
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
