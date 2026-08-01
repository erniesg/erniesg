#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHECKPOINT_SCHEMA_VERSION = 1
export const TARGET_SCHEMA_VERSION = 1
export const QUEUE_STATE_SCHEMA_VERSION = 1
export const REPOSITORY = 'erniesg/erniesg'
export const PULSE_TIMER = 'erniesg-struct-typeset-queue.timer'
export const PULSE_SERVICE = 'erniesg-struct-typeset-queue.service'
export const WORKER_MODEL = 'gpt-5.6-sol'
export const WORKER_REASONING = 'high'
export const RETRY_COMMAND =
  'node ~/code/erniesg/erniesg/tools/struct-queue-pulse.mjs --acknowledge-retry'

const UNIT_PATTERN = /^[A-Za-z0-9_.@:-]+\.service$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const LIVE_STATES = new Set(['active', 'acquired', 'running', 'starting'])
const FINISHED_STATES = new Set(['completed', 'expired', 'failed', 'released'])
const HUMAN_LABELS = new Set([
  'rucksack-blocked',
  'rucksack-needs-human',
  'rucksack-needs-clarification',
  'rucksack-needs-decision',
])

export function parseSystemdShow(text) {
  const properties = {}
  for (const line of text.trim().split(/\r?\n/u)) {
    const separator = line.indexOf('=')
    if (separator > 0) {
      properties[line.slice(0, separator)] = line.slice(separator + 1)
    }
  }
  return properties
}

function parseSystemdDuration(value) {
  if (/^\d+$/u.test(value ?? '')) return Number(value)
  const match = /^(\d+(?:\.\d+)?)(us|ms|s|min|h)$/u.exec(value ?? '')
  if (!match) return Number.NaN
  const factors = {
    us: 1,
    ms: 1_000,
    s: 1_000_000,
    min: 60_000_000,
    h: 3_600_000_000,
  }
  return Number(match[1]) * factors[match[2]]
}

function parseSystemdTimestamp(value) {
  if (/^\d+$/u.test(value ?? '')) {
    const numeric = Number(value)
    return numeric > 10_000_000_000_000 ? numeric / 1_000 : numeric
  }
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

export function evaluateQueueHealth({
  timer,
  service,
  target,
  now = Date.now(),
}) {
  const failures = []
  if (timer.LoadState !== 'loaded')
    failures.push(`timer load state is ${timer.LoadState || 'missing'}`)
  if (!['enabled', 'enabled-runtime'].includes(timer.UnitFileState)) {
    failures.push(
      `timer unit-file state is ${timer.UnitFileState || 'missing'}`,
    )
  }
  if (timer.ActiveState !== 'active')
    failures.push(`timer active state is ${timer.ActiveState || 'missing'}`)
  if (timer.SubState !== 'waiting')
    failures.push(`timer substate is ${timer.SubState || 'missing'}`)

  const nextFire = parseSystemdTimestamp(timer.NextElapseUSecRealtime)
  if (!Number.isFinite(nextFire) || nextFire <= now)
    failures.push('timer has no future fire')

  if (service.LoadState !== 'loaded')
    failures.push(`service load state is ${service.LoadState || 'missing'}`)
  if (parseSystemdDuration(service.TimeoutStartUSec) !== 30 * 60 * 1_000_000) {
    failures.push('service start timeout is not 30m')
  }
  if (parseSystemdDuration(service.TimeoutStopUSec) !== 5 * 60 * 1_000_000) {
    failures.push('service stop timeout is not 5m')
  }
  if (target.LoadState !== 'loaded')
    failures.push(`drain load state is ${target.LoadState || 'missing'}`)
  if (['failed', 'masked', 'not-found', 'error'].includes(target.LoadState)) {
    failures.push(`drain is ${target.LoadState}`)
  }
  if (target.ActiveState === 'failed' || target.Result === 'failed')
    failures.push('drain is failed')

  return { healthy: failures.length === 0, failures, nextFire }
}

function requirePlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value
}

export function resolveDrainTarget(text, expectedRepository = REPOSITORY) {
  let state
  try {
    state = JSON.parse(text)
  } catch {
    throw new Error('drain target state is not valid JSON')
  }
  requirePlainObject(state, 'drain target state')
  if (state.schemaVersion !== TARGET_SCHEMA_VERSION)
    throw new Error('unsupported drain target schema')
  if (state.repository !== expectedRepository)
    throw new Error('drain target repository does not match')
  if (state.managedBy !== 'rucksack-installer')
    throw new Error('drain target state is not installer-owned')
  if (!UNIT_PATTERN.test(state.serviceUnit ?? ''))
    throw new Error('drain target service unit is invalid')
  if (state.serviceUnit === PULSE_SERVICE)
    throw new Error('drain target cannot be the pulse service')
  if (!SHA256_PATTERN.test(state.structTypesetSkillSha256 ?? '')) {
    throw new Error('installed struct-typeset skill digest is invalid')
  }
  if (
    typeof state.structTypesetSkillPath !== 'string' ||
    !state.structTypesetSkillPath.startsWith('/')
  ) {
    throw new Error('installed struct-typeset skill path is invalid')
  }
  return Object.freeze({ ...state })
}

function parseIssue(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${field} must be a positive issue number`)
  return value
}

function parseExpiry(value, field) {
  const expiry = Date.parse(value ?? '')
  if (!Number.isFinite(expiry))
    throw new Error(`${field} has a missing or malformed expiry`)
  return expiry
}

function classifyRecords(records, kind, now) {
  if (!Array.isArray(records))
    throw new Error(`${kind} state is missing or malformed`)
  const live = new Map()
  for (const [index, recordValue] of records.entries()) {
    const record = requirePlainObject(recordValue, `${kind}[${index}]`)
    const issue = parseIssue(record.issue, `${kind}[${index}].issue`)
    if (
      !LIVE_STATES.has(record.status) &&
      !FINISHED_STATES.has(record.status)
    ) {
      throw new Error(`${kind}[${index}] has an unknown status`)
    }
    const expiry = parseExpiry(record.expiresAt, `${kind}[${index}]`)
    if (LIVE_STATES.has(record.status) && expiry > now) {
      if (live.has(issue))
        throw new Error(`${kind} contains a duplicate live issue ${issue}`)
      live.set(issue, record)
    }
  }
  return live
}

export function accountActiveSlots(
  stateValue,
  { capacity = 1, now = Date.now() } = {},
) {
  try {
    const state =
      typeof stateValue === 'string' ? JSON.parse(stateValue) : stateValue
    requirePlainObject(state, 'queue state')
    if (state.schemaVersion !== QUEUE_STATE_SCHEMA_VERSION)
      throw new Error('unsupported queue state schema')
    if (state.repository !== REPOSITORY)
      throw new Error('queue state repository does not match')
    if (!Number.isSafeInteger(capacity) || capacity !== 1)
      throw new Error('repository capacity must remain one')

    const observedAt = Date.parse(state.observedAt ?? '')
    if (
      !Number.isFinite(observedAt) ||
      observedAt > now + 60_000 ||
      now - observedAt > 5 * 60_000
    ) {
      throw new Error('queue state is missing, future-dated, or stale')
    }
    const sessions = classifyRecords(state.sessions, 'session', now)
    const leases = classifyRecords(state.leases, 'lease', now)
    const liveIssues = new Set([...sessions.keys(), ...leases.keys()])
    for (const issue of liveIssues) {
      if (!sessions.has(issue) || !leases.has(issue)) {
        throw new Error(
          `issue ${issue} does not have an exact live session and lease pair`,
        )
      }
    }

    const blockedIssues = new Set()
    if (!Array.isArray(state.issues))
      throw new Error('issue label state is missing or malformed')
    for (const [index, issueValue] of state.issues.entries()) {
      const issue = requirePlainObject(issueValue, `issues[${index}]`)
      const number = parseIssue(issue.issue, `issues[${index}].issue`)
      if (
        !Array.isArray(issue.labels) ||
        issue.labels.some((label) => typeof label !== 'string')
      ) {
        throw new Error(`issues[${index}].labels is malformed`)
      }
      if (issue.labels.some((label) => HUMAN_LABELS.has(label)))
        blockedIssues.add(number)
    }

    const active = liveIssues.size
    return {
      ok: true,
      failClosed: false,
      active,
      available: Math.max(0, capacity - active),
      liveIssues: [...liveIssues].sort((a, b) => a - b),
      blockedIssues: [...blockedIssues].sort((a, b) => a - b),
    }
  } catch (error) {
    return {
      ok: false,
      failClosed: true,
      active: capacity,
      available: 0,
      liveIssues: [],
      blockedIssues: [],
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function createWorkerReceipt(target) {
  if ((statSync(target.structTypesetSkillPath).mode & 0o222) !== 0) {
    throw new Error('installed struct-typeset skill is not read-only')
  }
  const digest = sha256File(target.structTypesetSkillPath)
  if (digest !== target.structTypesetSkillSha256) {
    throw new Error(
      'installed struct-typeset skill digest does not match pinned target state',
    )
  }
  return {
    model: WORKER_MODEL,
    reasoningEffort: WORKER_REASONING,
    structTypesetSkillSha256: digest,
  }
}

const CHECKPOINT_STATUSES = new Set([
  'capacity-held',
  'completed',
  'interrupted',
  'provider-blocked',
  'queue-health-failure',
])

export function parseCheckpoint(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('checkpoint is not valid JSON')
  }
  requirePlainObject(value, 'checkpoint')
  if (value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION)
    throw new Error('unsupported checkpoint schema')
  if (value.repository !== REPOSITORY)
    throw new Error('checkpoint repository does not match')
  if (!CHECKPOINT_STATUSES.has(value.status))
    throw new Error('checkpoint status is invalid')
  if (
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 0 ||
    value.attempt > 2
  ) {
    throw new Error('checkpoint attempt is invalid')
  }
  if (
    !value.next ||
    typeof value.next.action !== 'string' ||
    typeof value.next.command !== 'string'
  ) {
    throw new Error('checkpoint next action is missing')
  }
  for (const field of [
    'evidenceManifest',
    'tests',
    'visualArtifacts',
    'failure',
  ]) {
    if (!(field in value)) throw new Error(`checkpoint ${field} is missing`)
  }
  return value
}

export function retryExhausted(checkpointValue) {
  const checkpoint =
    typeof checkpointValue === 'string'
      ? parseCheckpoint(checkpointValue)
      : checkpointValue
  return checkpoint.attempt >= 2 && checkpoint.failure !== null
}

export function writeAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    const directory = openSync(dirname(path), 'r')
    fsyncSync(directory)
    closeSync(directory)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function buildCheckpoint({
  status,
  attempt = 0,
  issue = null,
  branch = null,
  pullRequest = null,
  sourceSha = null,
  evidenceManifest = null,
  tests = [],
  visualArtifacts = { source: [], output: [] },
  nextIssue = null,
  nextAction,
  nextCommand,
  failureClass = null,
  failureMessage = null,
  worker,
  writtenAt = new Date().toISOString(),
}) {
  const checkpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    repository: REPOSITORY,
    writtenAt,
    status,
    attempt,
    issue,
    branch,
    pullRequest,
    sourceSha,
    evidenceManifest,
    tests,
    visualArtifacts,
    worker,
    next: { issue: nextIssue, action: nextAction, command: nextCommand },
    failure: failureClass
      ? { class: failureClass, message: failureMessage }
      : null,
  }
  parseCheckpoint(JSON.stringify(checkpoint))
  return checkpoint
}

function systemctlShow(unit, properties) {
  const output = execFileSync(
    'systemctl',
    [
      '--user',
      'show',
      unit,
      ...properties.flatMap((property) => ['--property', property]),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return parseSystemdShow(output)
}

function checkpointContext(repoRoot) {
  let branch = null
  let sourceSha = null
  try {
    branch =
      execFileSync('git', ['-C', repoRoot, 'branch', '--show-current'], {
        encoding: 'utf8',
      }).trim() || null
    sourceSha =
      execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim() || null
  } catch {
    // A missing checkout is recorded as null rather than hiding the pulse result.
  }
  return { branch, sourceSha }
}

function runPulse() {
  const home = process.env.HOME
  if (!home) throw new Error('HOME is required')
  const repoRoot =
    process.env.RUCKSACK_REPO_ROOT ?? join(home, 'code', 'erniesg', 'erniesg')
  const targetPath =
    process.env.RUCKSACK_DRAIN_TARGET_FILE ??
    join(
      home,
      '.config',
      'rucksack',
      'autopilot',
      'erniesg-erniesg-drain-target.json',
    )
  const queueStatePath =
    process.env.RUCKSACK_QUEUE_STATE_FILE ??
    join(
      home,
      '.local',
      'state',
      'rucksack',
      'erniesg-erniesg',
      'queue-state.json',
    )
  const checkpointPath =
    process.env.RUCKSACK_CHECKPOINT_FILE ??
    join(
      home,
      '.local',
      'state',
      'rucksack',
      'erniesg-erniesg',
      'checkpoint.json',
    )
  const resumeCommand = `systemctl --user start ${PULSE_SERVICE}`
  const context = checkpointContext(repoRoot)
  let worker = null
  let checkpointWritten = false

  const save = (values) => {
    const checkpoint = buildCheckpoint({ ...context, worker, ...values })
    writeAtomicJson(checkpointPath, checkpoint)
    checkpointWritten = true
  }

  const saveFailure = (values) => {
    let attempt = 1
    try {
      const previous = parseCheckpoint(readFileSync(checkpointPath, 'utf8'))
      if (previous.failure?.class === values.failureClass)
        attempt = Math.min(2, previous.attempt + 1)
    } catch {
      // A missing or unrelated prior checkpoint starts the bounded counter.
    }
    const atHumanGate = attempt >= 2
    save({
      ...values,
      attempt,
      nextAction: atHumanGate
        ? `human gate: ${values.nextAction}`
        : values.nextAction,
      nextCommand: atHumanGate ? RETRY_COMMAND : values.nextCommand,
    })
  }

  try {
    if (existsSync(checkpointPath)) {
      const previous = parseCheckpoint(readFileSync(checkpointPath, 'utf8'))
      if (retryExhausted(previous)) {
        process.exitCode = 4
        return
      }
    }
    const target = resolveDrainTarget(readFileSync(targetPath, 'utf8'))
    worker = createWorkerReceipt(target)
    const queue = accountActiveSlots(readFileSync(queueStatePath, 'utf8'))
    if (!queue.ok) {
      saveFailure({
        status: 'queue-health-failure',
        nextAction:
          'repair or refresh the exact lease/session state, then retry the pulse',
        nextCommand: resumeCommand,
        failureClass: 'lease-state',
        failureMessage: queue.reason,
      })
      process.exitCode = 1
      return
    }

    const timer = systemctlShow(PULSE_TIMER, [
      'LoadState',
      'UnitFileState',
      'ActiveState',
      'SubState',
      'NextElapseUSecRealtime',
    ])
    const service = systemctlShow(PULSE_SERVICE, [
      'LoadState',
      'TimeoutStartUSec',
      'TimeoutStopUSec',
    ])
    const drain = systemctlShow(target.serviceUnit, [
      'LoadState',
      'ActiveState',
      'SubState',
      'Result',
    ])
    const health = evaluateQueueHealth({ timer, service, target: drain })
    if (!health.healthy) {
      saveFailure({
        status: 'queue-health-failure',
        nextAction:
          'restore the selected timer or drain through the installer and verify a future fire',
        nextCommand: resumeCommand,
        failureClass: 'timer-state',
        failureMessage: health.failures.join('; '),
      })
      process.exitCode = 1
      return
    }

    if (
      queue.available === 0 ||
      ['active', 'activating'].includes(drain.ActiveState)
    ) {
      save({
        status: 'capacity-held',
        issue: queue.liveIssues[0] ?? null,
        nextIssue: queue.liveIssues[0] ?? null,
        nextAction:
          'resume the existing exact issue lease; do not dispatch a duplicate',
        nextCommand: resumeCommand,
      })
      return
    }

    const result = spawnSync(
      'systemctl',
      ['--user', 'start', '--wait', target.serviceUnit],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const afterTimer = systemctlShow(PULSE_TIMER, [
      'LoadState',
      'UnitFileState',
      'ActiveState',
      'SubState',
      'NextElapseUSecRealtime',
    ])
    const afterService = systemctlShow(PULSE_SERVICE, [
      'LoadState',
      'TimeoutStartUSec',
      'TimeoutStopUSec',
    ])
    const afterDrain = systemctlShow(target.serviceUnit, [
      'LoadState',
      'ActiveState',
      'SubState',
      'Result',
    ])
    const afterHealth = evaluateQueueHealth({
      timer: afterTimer,
      service: afterService,
      target: afterDrain,
    })
    if (!afterHealth.healthy) {
      saveFailure({
        status: 'queue-health-failure',
        nextAction:
          'repair the selected scheduler state and retry this exact pass',
        nextCommand: resumeCommand,
        failureClass: 'timer-state',
        failureMessage: afterHealth.failures.join('; '),
      })
      process.exitCode = 1
      return
    }

    if (result.status !== 0) {
      const providerBlocked = result.status === 3
      saveFailure({
        status: providerBlocked ? 'provider-blocked' : 'interrupted',
        nextAction: providerBlocked
          ? 'restore the named provider gate, then resume this exact pass'
          : 'inspect the drain receipt and resume this exact pass',
        nextCommand: resumeCommand,
        failureClass: providerBlocked ? 'provider' : 'worker-interrupted',
        failureMessage: `generated drain exited with status ${result.status ?? 'unknown'}`,
      })
      process.exitCode = result.status || 1
      return
    }

    save({
      status: 'completed',
      nextAction: 'reconcile labels and leases, then run the next ready issue',
      nextCommand: resumeCommand,
    })
  } catch (error) {
    if (!checkpointWritten) {
      saveFailure({
        status: 'queue-health-failure',
        nextAction: 'repair the named local scheduler state and retry',
        nextCommand: resumeCommand,
        failureClass: 'pulse-runtime',
        failureMessage: error instanceof Error ? error.message : String(error),
      })
    }
    process.exitCode = 1
  }
}

function acknowledgeRetry() {
  const home = process.env.HOME
  if (!home) throw new Error('HOME is required')
  const checkpointPath =
    process.env.RUCKSACK_CHECKPOINT_FILE ??
    join(
      home,
      '.local',
      'state',
      'rucksack',
      'erniesg-erniesg',
      'checkpoint.json',
    )
  const checkpoint = parseCheckpoint(readFileSync(checkpointPath, 'utf8'))
  if (!retryExhausted(checkpoint)) {
    throw new Error('checkpoint is not waiting at the bounded human retry gate')
  }
  const acknowledgedPath = `${checkpointPath}.human-acknowledged-${Date.now()}.json`
  renameSync(checkpointPath, acknowledgedPath)
  const directory = openSync(dirname(checkpointPath), 'r')
  fsyncSync(directory)
  closeSync(directory)
  execFileSync('systemctl', ['--user', 'start', PULSE_SERVICE], {
    stdio: 'inherit',
  })
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  if (process.argv[2] === '--acknowledge-retry') acknowledgeRetry()
  else runPulse()
}
