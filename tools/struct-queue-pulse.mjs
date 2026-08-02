#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const TARGET_PATTERN =
  /^rucksack-autopilot-v[0-9]+-[A-Za-z0-9_.@-]+-drain\.service$/
const SOURCE_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const DEFAULT_REPO = 'erniesg/erniesg'
const DEFAULT_TIMER = 'erniesg-struct-typeset-queue.timer'
const DEFAULT_SERVICE = 'erniesg-struct-typeset-queue.service'
const DEFAULT_HIGH_WATER_PERCENT = 90
const DEFAULT_MINIMUM_FREE_BYTES = 5 * 1024 * 1024 * 1024

const asObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : null

const parseTime = (value) => {
  if (typeof value !== 'string' || value.length === 0) return Number.NaN
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

const isNonEmptyString = (value) =>
  typeof value === 'string' && value.trim().length > 0

const pathIsInside = (root, candidate) => {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  const relation = relative(normalizedRoot, normalizedCandidate)
  return (
    relation.length > 0 &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  )
}

const pathsOverlap = (left, right) => {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return (
    normalizedLeft === normalizedRight ||
    pathIsInside(normalizedLeft, normalizedRight) ||
    pathIsInside(normalizedRight, normalizedLeft)
  )
}

const commandContainsTmuxSession = (command, tmuxSession) => {
  if (!isNonEmptyString(command) || !command.includes('tmux')) return false
  const escaped = tmuxSession.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)(?:-s|-t)(?:=|\\s+)=?${escaped}(?:\\s|$)`).test(
    command,
  )
}

const issueTmuxSessionsInProcess = (command) => {
  if (!isNonEmptyString(command) || !command.includes('tmux')) return []
  const matches = command.matchAll(
    /(?:^|\s)(?:-s|-t)(?:=|\s+)=?(rucksack-[A-Za-z0-9_.-]+-issue-[1-9][0-9]*-[A-Za-z0-9]+)(?=\s|$)/gu,
  )
  return [...matches].map((match) => match[1])
}

export const parseTargetUnit = (raw) => {
  if (typeof raw !== 'string') {
    throw new Error('drain target state is missing')
  }
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length !== 1) {
    throw new Error('drain target state must contain exactly one unit')
  }
  if (!TARGET_PATTERN.test(lines[0])) {
    throw new Error('drain target is not an installer-owned versioned unit')
  }
  return lines[0]
}

const blockedSessionState = (reason, detail) => ({
  status: 'blocked',
  reason,
  detail,
  live: [],
  completed: [],
  expired: [],
  availableSlots: 0,
})

const classifySessions = ({
  ledger,
  repo = null,
  now = Date.now(),
  processArgs = [],
  maxWorkers = 1,
}) => {
  const parsedLedger = asObject(ledger)
  if (
    !parsedLedger ||
    String(parsedLedger.schema_version) !== '1' ||
    !Array.isArray(parsedLedger.sessions)
  ) {
    return blockedSessionState(
      'session-ledger-invalid',
      'The VM session ledger is missing or does not match schema version 1.',
    )
  }
  if (
    (repo !== null && !isNonEmptyString(repo)) ||
    !Number.isInteger(maxWorkers) ||
    maxWorkers < 1
  ) {
    return blockedSessionState(
      'session-policy-invalid',
      'The repository session policy is invalid.',
    )
  }

  const relevant = []
  const seenSessionIds = new Set()
  for (const rawSession of parsedLedger.sessions) {
    const item = asObject(rawSession)
    if (!item || !isNonEmptyString(item.repo)) {
      return blockedSessionState(
        'session-ledger-ambiguous',
        'A session record cannot be assigned to a repository.',
      )
    }
    if (repo !== null && item.repo !== repo) continue

    const issueNumber = String(item.issue_number ?? '')
    const heartbeatAt = parseTime(item.heartbeat_at)
    const leaseExpiresAt = parseTime(item.lease_expires_at)
    const valid =
      isNonEmptyString(item.session_id) &&
      !seenSessionIds.has(item.session_id) &&
      /^[1-9][0-9]*$/u.test(issueNumber) &&
      isNonEmptyString(item.provider) &&
      isNonEmptyString(item.branch) &&
      isNonEmptyString(item.tmux_session) &&
      isNonEmptyString(item.local_checkout_path) &&
      isAbsolute(item.local_checkout_path) &&
      isNonEmptyString(item.log_path) &&
      Number.isFinite(heartbeatAt) &&
      Number.isFinite(leaseExpiresAt)
    if (!valid) {
      return blockedSessionState(
        'session-ledger-malformed',
        `Session state for issue ${issueNumber || 'unknown'} is malformed.`,
      )
    }
    seenSessionIds.add(item.session_id)
    relevant.push({ ...item, heartbeatAt, leaseExpiresAt })
  }

  if (repo === null) {
    const knownTmuxSessions = new Set(relevant.map((item) => item.tmux_session))
    const unmatchedProcessSession = processArgs
      .flatMap(issueTmuxSessionsInProcess)
      .find((tmuxSession) => !knownTmuxSessions.has(tmuxSession))
    if (unmatchedProcessSession) {
      return blockedSessionState(
        'session-ledger-conflict',
        `Live session ${unmatchedProcessSession} is missing from the VM ledger.`,
      )
    }
  }

  const live = []
  const completed = []
  const expired = []
  for (const item of relevant) {
    const processIsLive = processArgs.some((command) =>
      commandContainsTmuxSession(command, item.tmux_session),
    )
    if (processIsLive) {
      live.push(item)
    } else if (item.leaseExpiresAt <= now) {
      expired.push(item)
    } else {
      completed.push(item)
    }
  }

  return {
    status: 'ok',
    reason: null,
    detail: null,
    live,
    completed,
    expired,
    availableSlots: Math.max(0, maxWorkers - live.length),
  }
}

export const classifyRepositorySessions = (options) => classifySessions(options)

export const classifyVmSessions = (options) =>
  classifySessions({ ...options, repo: null })

export const evaluateDiskCapacity = ({
  totalBytes,
  freeBytes,
  highWaterPercent = DEFAULT_HIGH_WATER_PERCENT,
  minimumFreeBytes = DEFAULT_MINIMUM_FREE_BYTES,
}) => {
  if (
    !Number.isFinite(totalBytes) ||
    !Number.isFinite(freeBytes) ||
    totalBytes <= 0 ||
    freeBytes < 0 ||
    freeBytes > totalBytes ||
    !Number.isFinite(highWaterPercent) ||
    highWaterPercent <= 0 ||
    highWaterPercent >= 100 ||
    !Number.isFinite(minimumFreeBytes) ||
    minimumFreeBytes < 0
  ) {
    return {
      blocked: true,
      reason: 'disk-state-invalid',
      usedPercent: null,
      totalBytes,
      freeBytes,
    }
  }
  const usedPercent = ((totalBytes - freeBytes) / totalBytes) * 100
  if (usedPercent >= highWaterPercent) {
    return {
      blocked: true,
      reason: 'disk-high-water',
      usedPercent,
      totalBytes,
      freeBytes,
    }
  }
  if (freeBytes < minimumFreeBytes) {
    return {
      blocked: true,
      reason: 'disk-free-space-low',
      usedPercent,
      totalBytes,
      freeBytes,
    }
  }
  return {
    blocked: false,
    reason: null,
    usedPercent,
    totalBytes,
    freeBytes,
  }
}

const terminalSessionMap = (sessionState) => {
  const terminal = new Map()
  for (const item of sessionState.completed ?? []) {
    terminal.set(item.session_id, { item, status: 'completed' })
  }
  for (const item of sessionState.expired ?? []) {
    terminal.set(item.session_id, { item, status: 'expired' })
  }
  return terminal
}

export const selectSafeCleanupCandidates = ({
  candidates,
  repo,
  sessionState,
  worktreeRoot,
  reproducibleCacheRoot,
  protectedRoots = [],
  protectedPaths = [],
}) => {
  const allowed = []
  const rejected = []
  const livePaths = (sessionState.live ?? [])
    .map((item) => item.local_checkout_path)
    .filter(isNonEmptyString)
  const terminalSessions = terminalSessionMap(sessionState)
  const allProtected = [
    ...protectedRoots,
    ...protectedPaths,
    ...livePaths,
  ].filter(isNonEmptyString)

  for (const rawCandidate of Array.isArray(candidates) ? candidates : []) {
    const candidate = asObject(rawCandidate)
    const reject = (reason) => {
      rejected.push({ candidate: rawCandidate, reason })
    }
    if (
      !candidate ||
      !isNonEmptyString(candidate.path) ||
      !isAbsolute(candidate.path)
    ) {
      reject('candidate-path-invalid')
      continue
    }
    if (allProtected.some((item) => pathsOverlap(item, candidate.path))) {
      reject('candidate-protected')
      continue
    }

    if (candidate.kind === 'worktree') {
      if (!pathIsInside(worktreeRoot, candidate.path)) {
        reject('worktree-outside-root')
        continue
      }
      const terminal = terminalSessions.get(candidate.session_id)
      const checkpoint = asObject(candidate.checkpoint)
      const validCheckpoint =
        terminal &&
        resolve(terminal.item.local_checkout_path) ===
          resolve(candidate.path) &&
        checkpoint?.schema_version === '1' &&
        checkpoint.repo === repo &&
        checkpoint.session_id === candidate.session_id &&
        resolve(String(checkpoint.worktree ?? '')) ===
          resolve(candidate.path) &&
        checkpoint.cleanup_eligible === true &&
        checkpoint.status === terminal.status &&
        SOURCE_SHA_PATTERN.test(String(checkpoint.source_sha ?? ''))
      if (!validCheckpoint) {
        reject('worktree-checkpoint-invalid')
        continue
      }
      const requiredReferences = [terminal.item.log_path].filter((path) =>
        pathIsInside(candidate.path, path),
      )
      const preservedArtifacts = Array.isArray(checkpoint.preserved_artifacts)
        ? checkpoint.preserved_artifacts
        : []
      const referencesPreserved = requiredReferences.every((sourcePath) =>
        preservedArtifacts.some(
          (artifact) =>
            asObject(artifact) &&
            resolve(String(artifact.source_path ?? '')) ===
              resolve(sourcePath) &&
            isNonEmptyString(artifact.durable_path) &&
            isAbsolute(artifact.durable_path) &&
            !pathsOverlap(candidate.path, artifact.durable_path) &&
            /^(?:[0-9a-f]{64})$/iu.test(String(artifact.sha256 ?? '')),
        ),
      )
      if (!referencesPreserved) {
        reject('worktree-references-not-preserved')
        continue
      }
      allowed.push(candidate)
      continue
    }

    if (candidate.kind === 'reproducible-cache') {
      if (
        candidate.reproducible !== true ||
        !pathIsInside(reproducibleCacheRoot, candidate.path)
      ) {
        reject('cache-not-proven-reproducible')
        continue
      }
      allowed.push(candidate)
      continue
    }

    reject('candidate-kind-invalid')
  }

  return { allowed, rejected }
}

const parseProperties = (raw) => {
  const properties = {}
  for (const line of String(raw ?? '').split(/\r?\n/u)) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    properties[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return properties
}

export const evaluateTimerHealth = ({
  timerProperties,
  timerList,
  serviceProperties,
  timerName = DEFAULT_TIMER,
}) => {
  const timer = parseProperties(timerProperties)
  const service = parseProperties(serviceProperties)
  const futureFire =
    String(timerList ?? '').includes(timerName) &&
    !/^\s*n\/a\s+n\/a\b/iu.test(String(timerList ?? ''))
  const healthy =
    timer.LoadState === 'loaded' &&
    timer.UnitFileState === 'enabled' &&
    timer.ActiveState === 'active' &&
    timer.SubState === 'waiting' &&
    futureFire &&
    ['30min', '30m', '1800s'].includes(service.TimeoutStartUSec) &&
    ['5min', '5m', '300s'].includes(service.TimeoutStopUSec)
  return {
    healthy,
    timer,
    service,
    futureFire,
    reason: healthy ? null : 'scheduler-health-invalid',
  }
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const run = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })

const systemctl = (args) =>
  run(process.env.STRUCT_QUEUE_SYSTEMCTL ?? 'systemctl', ['--user', ...args])

const diskUsage = (path) => {
  const fixture = process.env.STRUCT_QUEUE_DISK_STATE_FILE
  if (fixture) return readJson(fixture)
  const stats = statfsSync(path, { bigint: true })
  const totalBytes = Number(stats.blocks * stats.bsize)
  const freeBytes = Number(stats.bavail * stats.bsize)
  return { totalBytes, freeBytes }
}

const processSnapshot = () => {
  const fixture = process.env.STRUCT_QUEUE_PROCESS_SNAPSHOT_FILE
  const raw = fixture
    ? readFileSync(fixture, 'utf8')
    : run('ps', ['-eo', 'args='])
  return raw.split(/\r?\n/u).filter(Boolean)
}

const writeAtomicCheckpoint = (path, value) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

const directCodexExec = /(?:^|\s)(?:\S*\/)?codex\s+.*\bexec\b/u
const trustedCoordinatorIdentity = /\btrusted\s+VM\s+coordinator\b/iu

const directCodexWorkerIsLive = (processArgs) =>
  processArgs.some(
    (command) =>
      directCodexExec.test(command) && !trustedCoordinatorIdentity.test(command),
  )

const loadCleanupManifest = (path, stateRoot) => {
  if (!existsSync(path)) return []
  const manifest = readJson(path)
  if (
    !asObject(manifest) ||
    String(manifest.schema_version) !== '1' ||
    !Array.isArray(manifest.candidates)
  ) {
    throw new Error('cleanup manifest is malformed')
  }
  return manifest.candidates.map((raw) => {
    const candidate = { ...raw }
    delete candidate.checkpoint
    if (candidate.kind !== 'worktree') return candidate
    if (
      !isNonEmptyString(candidate.checkpoint_path) ||
      !isAbsolute(candidate.checkpoint_path) ||
      !pathIsInside(stateRoot, candidate.checkpoint_path)
    ) {
      return candidate
    }
    candidate.checkpoint = readJson(candidate.checkpoint_path)
    return candidate
  })
}

const removeCleanupCandidate = ({ candidate, repoRoot }) => {
  if (!existsSync(candidate.path))
    return { path: candidate.path, status: 'absent' }
  if (candidate.kind === 'worktree') {
    if (existsSync(resolve(candidate.path, '.agent/evidence'))) {
      throw new Error('worktree contains evidence')
    }
    const dirty = run('git', [
      '-C',
      candidate.path,
      'status',
      '--porcelain',
    ]).trim()
    if (dirty) throw new Error('worktree is dirty')
    for (const artifact of candidate.checkpoint.preserved_artifacts ?? []) {
      if (!existsSync(artifact.durable_path)) {
        throw new Error('preserved artifact is missing')
      }
      const digest = createHash('sha256')
        .update(readFileSync(artifact.durable_path))
        .digest('hex')
      if (digest !== String(artifact.sha256).toLowerCase()) {
        throw new Error('preserved artifact checksum does not match')
      }
    }
    run('git', ['-C', repoRoot, 'worktree', 'remove', candidate.path])
    run('git', ['-C', repoRoot, 'worktree', 'prune'])
    return { path: candidate.path, status: 'removed', kind: candidate.kind }
  }
  rmSync(candidate.path, { recursive: true, force: false })
  return { path: candidate.path, status: 'removed', kind: candidate.kind }
}

const queueConfig = () => {
  const home = homedir()
  const repoRoot =
    process.env.STRUCT_QUEUE_REPO_ROOT ??
    resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const stateRoot =
    process.env.STRUCT_QUEUE_STATE_ROOT ??
    resolve(home, '.local/state/rucksack')
  const overnightRoot =
    process.env.STRUCT_QUEUE_OVERNIGHT_ROOT ??
    resolve(home, '.config/rucksack/overnight')
  return {
    repo: process.env.STRUCT_QUEUE_REPO ?? DEFAULT_REPO,
    repoRoot,
    stateRoot,
    overnightRoot,
    timerName: process.env.STRUCT_QUEUE_TIMER ?? DEFAULT_TIMER,
    serviceName: process.env.STRUCT_QUEUE_SERVICE ?? DEFAULT_SERVICE,
    holdFile: resolve(overnightRoot, 'erniesg-erniesg.hold'),
    targetFile:
      process.env.STRUCT_QUEUE_TARGET_FILE ??
      resolve(overnightRoot, 'erniesg-erniesg.target'),
    sessionFile:
      process.env.STRUCT_QUEUE_SESSION_FILE ??
      resolve(stateRoot, 'vm-sessions.json'),
    checkpointFile:
      process.env.STRUCT_QUEUE_CHECKPOINT_FILE ??
      resolve(stateRoot, 'queue-checkpoints/erniesg-erniesg/latest.json'),
    cleanupManifestFile:
      process.env.STRUCT_QUEUE_CLEANUP_MANIFEST_FILE ??
      resolve(overnightRoot, 'erniesg-erniesg.cleanup.json'),
    worktreeRoot:
      process.env.STRUCT_QUEUE_WORKTREE_ROOT ??
      resolve(home, 'code/erniesg/.rucksack-worktrees/erniesg'),
    reproducibleCacheRoot:
      process.env.STRUCT_QUEUE_REPRODUCIBLE_CACHE_ROOT ??
      resolve(home, '.cache/rucksack/reproducible'),
    handoffRoot:
      process.env.STRUCT_QUEUE_HANDOFF_ROOT ?? resolve(home, '.codex/handoffs'),
    diskPath: process.env.STRUCT_QUEUE_DISK_PATH ?? home,
    highWaterPercent: Number(
      process.env.STRUCT_QUEUE_DISK_HIGH_WATER_PERCENT ??
        DEFAULT_HIGH_WATER_PERCENT,
    ),
    minimumFreeBytes: Number(
      process.env.STRUCT_QUEUE_MINIMUM_FREE_BYTES ?? DEFAULT_MINIMUM_FREE_BYTES,
    ),
  }
}

const queueCheckpoint = ({ config, outcome, targetUnit, details = {} }) => ({
  schema_version: '1',
  repo: config.repo,
  recorded_at: new Date().toISOString(),
  outcome,
  target_unit: targetUnit ?? null,
  ...details,
})

export const runQueuePulse = () => {
  const config = queueConfig()
  let targetUnit = null
  const finish = (outcome, exitCode, details = {}) => {
    const checkpoint = queueCheckpoint({
      config,
      outcome,
      targetUnit,
      details,
    })
    writeAtomicCheckpoint(config.checkpointFile, checkpoint)
    process.stdout.write(`${JSON.stringify(checkpoint)}\n`)
    return exitCode
  }

  try {
    if (existsSync(config.holdFile)) {
      return finish('operator-held', 0, {
        failure_class: null,
        next_action: 'Remove the explicit hold and start the queue timer.',
      })
    }

    targetUnit = parseTargetUnit(readFileSync(config.targetFile, 'utf8'))
    const timerProperties = systemctl([
      'show',
      config.timerName,
      '-p',
      'LoadState',
      '-p',
      'UnitFileState',
      '-p',
      'ActiveState',
      '-p',
      'SubState',
      '--no-pager',
    ])
    const timerList = systemctl([
      'list-timers',
      '--all',
      '--no-legend',
      config.timerName,
    ])
    const serviceProperties = systemctl([
      'show',
      config.serviceName,
      '-p',
      'TimeoutStartUSec',
      '-p',
      'TimeoutStopUSec',
      '--no-pager',
    ])
    const timerHealth = evaluateTimerHealth({
      timerProperties,
      timerList,
      serviceProperties,
      timerName: config.timerName,
    })
    if (!timerHealth.healthy) {
      return finish('queue-health-blocked', 2, {
        failure_class: timerHealth.reason,
        timer_health: timerHealth,
        next_action: `Repair and re-enable ${config.timerName}; do not dispatch a worker yet.`,
      })
    }

    const targetProperties = parseProperties(
      systemctl([
        'show',
        targetUnit,
        '-p',
        'LoadState',
        '-p',
        'ActiveState',
        '-p',
        'SubState',
        '--no-pager',
      ]),
    )
    if (['active', 'activating'].includes(targetProperties.ActiveState)) {
      return finish('drain-active', 0, {
        failure_class: null,
        timer_health: timerHealth,
        next_action:
          'Let the active drain finish; the next pulse will reconcile it.',
      })
    }
    if (targetProperties.LoadState !== 'loaded') {
      return finish('queue-health-blocked', 2, {
        failure_class: 'drain-target-unavailable',
        timer_health: timerHealth,
        target_state: targetProperties,
        next_action:
          'Repair the installer-owned drain target; do not unmask it automatically.',
      })
    }

    const processArgs = processSnapshot()
    const ledger = readJson(config.sessionFile)
    const vmSessionState = classifyVmSessions({
      ledger,
      processArgs,
      maxWorkers: 1,
    })
    const sessionState = classifyRepositorySessions({
      ledger,
      repo: config.repo,
      processArgs,
      maxWorkers: 1,
    })
    if (vmSessionState.status !== 'ok' || sessionState.status !== 'ok') {
      const blockedState =
        vmSessionState.status !== 'ok' ? vmSessionState : sessionState
      return finish('queue-health-blocked', 2, {
        failure_class: blockedState.reason,
        session_state: blockedState,
        timer_health: timerHealth,
        next_action:
          'Run the exact Rucksack session recovery command before dispatch.',
      })
    }
    if (vmSessionState.live.length > 0 || directCodexWorkerIsLive(processArgs)) {
      // Process names alone do not establish an issue worker. The VM session
      // ledger paired with exact tmux-process matching is authoritative;
      // coordinators, reviewers, and other repo lanes also run Codex exec.
      return finish('worker-active', 0, {
        failure_class: null,
        live_sessions: vmSessionState.live.map((item) => ({
          repo: item.repo,
          issue: item.issue_number,
          session_id: item.session_id,
          branch: item.branch,
          worktree: item.local_checkout_path,
          heartbeat_at: item.heartbeat_at,
          lease_expires_at: item.lease_expires_at,
        })),
        timer_health: timerHealth,
        next_action:
          'Preserve the active worker and let the next pulse reconcile it.',
      })
    }

    let capacity = evaluateDiskCapacity({
      ...diskUsage(config.diskPath),
      highWaterPercent: config.highWaterPercent,
      minimumFreeBytes: config.minimumFreeBytes,
    })
    const cleanup = { attempted: [], rejected: [] }
    if (capacity.blocked) {
      const candidates = loadCleanupManifest(
        config.cleanupManifestFile,
        config.stateRoot,
      )
      const selection = selectSafeCleanupCandidates({
        candidates,
        repo: config.repo,
        sessionState,
        worktreeRoot: config.worktreeRoot,
        reproducibleCacheRoot: config.reproducibleCacheRoot,
        protectedRoots: [
          config.stateRoot,
          config.handoffRoot,
          resolve(config.repoRoot, '.agent/evidence'),
        ],
        protectedPaths: sessionState.live.flatMap((item) => [
          item.local_checkout_path,
          item.log_path,
        ]),
      })
      cleanup.rejected = selection.rejected.map(({ candidate, reason }) => ({
        path: candidate?.path ?? null,
        reason,
      }))
      for (const candidate of selection.allowed) {
        try {
          cleanup.attempted.push(
            removeCleanupCandidate({ candidate, repoRoot: config.repoRoot }),
          )
        } catch (error) {
          cleanup.attempted.push({
            path: candidate.path,
            status: 'preserved',
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
      capacity = evaluateDiskCapacity({
        ...diskUsage(config.diskPath),
        highWaterPercent: config.highWaterPercent,
        minimumFreeBytes: config.minimumFreeBytes,
      })
    }
    if (capacity.blocked) {
      return finish('queue-health-blocked', 2, {
        failure_class: capacity.reason,
        disk: capacity,
        cleanup,
        timer_health: timerHealth,
        next_action:
          'Restore disk headroom without removing active worktrees, handoffs, receipts, evidence, or referenced artifacts.',
      })
    }

    systemctl(['start', '--no-block', targetUnit])
    return finish('dispatch-requested', 0, {
      failure_class: null,
      disk: capacity,
      cleanup,
      timer_health: timerHealth,
      completed_sessions: sessionState.completed.map((item) => item.session_id),
      expired_sessions: sessionState.expired.map((item) => item.session_id),
      next_action: `Reconcile ${targetUnit} and the exact VM session on the next pulse.`,
    })
  } catch (error) {
    return finish('queue-health-blocked', 2, {
      failure_class: 'queue-pulse-error',
      error: error instanceof Error ? error.message : String(error),
      next_action:
        'Inspect the atomic checkpoint and repair the named queue-health failure.',
    })
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) process.exitCode = runQueuePulse()
