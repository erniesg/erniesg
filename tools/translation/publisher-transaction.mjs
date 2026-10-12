import crypto from 'node:crypto'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import * as nativeFs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

// All repository I/O is descriptor-relative in the POSIX helper. The context
// spans nested recovery calls and user test hooks without global fs mutation.
const sessions = new AsyncLocalStorage()
const leases = new Map()
const fs = new Proxy(
  {},
  {
    get:
      (_, name) =>
      (...args) => {
        const session = sessions.getStore()
        return session ? session.fs[name](...args) : nativeFs[name](...args)
      },
  },
)

function createSession(root) {
  const child = spawn(
    'python3',
    [
      '-u',
      fileURLToPath(new URL('./publisher-posix.py', import.meta.url)),
      root,
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let sequence = 0
  const pending = new Map()
  let diagnostics = ''
  child.stderr.on('data', (chunk) => {
    diagnostics += chunk.toString()
  })
  child.stdin.on('error', (error) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const result = JSON.parse(line)
    const waiter = pending.get(result.id)
    if (!waiter) return
    pending.delete(result.id)
    if (result.error)
      waiter.reject(
        Object.assign(new Error(result.error), { code: result.code }),
      )
    else waiter.resolve(result.result)
  })
  const exited = new Promise((resolve) => {
    child.on('error', (error) => {
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear()
    })
    child.on('close', (code) => {
      for (const waiter of pending.values())
        waiter.reject(
          new Error(`Publisher POSIX helper exited (${code}): ${diagnostics}`),
        )
      pending.clear()
      resolve()
    })
  })
  const rpc = (op, values = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      child.stdin.write(
        `${JSON.stringify({ id, op, ...values })}\n`,
        (error) => {
          if (error) {
            pending.delete(id)
            reject(error)
          }
        },
      )
    })
  const api = {
    realpath: nativeFs.realpath,
    async lstat(file) {
      const state = await rpc('stat', { path: file })
      return {
        ...state,
        isDirectory: () => (state.mode & 0o170000) === 0o040000,
        isFile: () => (state.mode & 0o170000) === 0o100000,
        isSymbolicLink: () => (state.mode & 0o170000) === 0o120000,
      }
    },
    async readFile(file, encoding) {
      const bytes = Buffer.from(await rpc('read', { path: file }), 'base64')
      return encoding ? bytes.toString(encoding) : bytes
    },
    mkdir: (file, options) => rpc('mkdir', { path: file, mode: options?.mode }),
    readdir: (file) => rpc('list', { path: file }),
    unlink: (file) => rpc('unlink', { path: file }),
    rmdir: (file) => rpc('rmdir', { path: file }),
    rename: (file, to) => rpc('rename', { path: file, to }),
    async open(file, flags, mode) {
      const handle = await rpc('open', { path: file, flags, mode })
      return {
        writeFile: (bytes) =>
          rpc('writeHandle', {
            handle,
            data: Buffer.from(bytes).toString('base64'),
          }),
        sync: () => rpc('syncHandle', { handle }),
        close: () => rpc('closeHandle', { handle }),
      }
    },
  }
  return {
    root,
    rpc,
    fs: api,
    close: async () => {
      child.stdin.end()
      await exited
    },
  }
}

async function inSession(options, action) {
  if (sessions.getStore()) return action()
  const root = await rootPath(options?.repoRoot ?? process.cwd())
  const lease = leases.get(root)
  if (lease) {
    if (lease.busy)
      throw new Error('Translation publish already running locally.')
    lease.busy = true
    try {
      return await sessions.run(lease, action)
    } finally {
      lease.busy = false
    }
  }
  const session = createSession(root)
  try {
    return await sessions.run(session, async () => {
      await ensureParents(root, LOCK_RELATIVE)
      try {
        await session.rpc('guard')
      } catch (error) {
        if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')
          throw new Error('Translation publish already running locally.')
        throw error
      }
      return action()
    })
  } finally {
    await session.close()
  }
}

const TRANSACTION_RELATIVE = 'generated/tmp/.translation-transaction'
const LOCK_RELATIVE = 'generated/tmp/.translation-publisher.lock'
const ACTIVE = 'active'
const JOURNAL = 'journal.json'
const PREPARATION = /^prepare-[0-9a-f-]+$/
const CLEANUP = /^cleanup-[0-9a-f-]+$/
const PRIVATE_FILE =
  /^(?:(?:before|after)-[0-9]+\.bin|(?:displaced|replacement|conflict)-[0-9a-f]+\.bin|operation-[0-9a-f]+\.json(?:\.next)?|cleanup-state\.json(?:\.next)?)$/
const execFile = promisify(execFileCallback)
const digest = (value) =>
  crypto.createHash('sha256').update(value).digest('hex')

const allowed = (relative) =>
  relative === '.translation/manifest.json' ||
  relative === '.translation/pages.json' ||
  /^\.translation\/reports\/[A-Za-z0-9._-]+\.json$/.test(relative) ||
  /^src\/content\/blog\/(?:[A-Za-z0-9._-]+\/)*(?:zh|ja|ko)\.mdx$/.test(relative)

function assertRelative(relative) {
  if (
    typeof relative !== 'string' ||
    !allowed(relative) ||
    path.isAbsolute(relative) ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Not a permitted publication artifact: ${relative}`)
  return relative
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function rootPath(repoRoot) {
  return fs.realpath(repoRoot)
}

async function ensureParents(root, relative) {
  let current = root
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part)
    const state = await lstatOrNull(current)
    if (state?.isSymbolicLink())
      throw new Error(`Refusing symbolic-link publication path: ${relative}`)
    if (state && !state.isDirectory())
      throw new Error(`Publication parent is not a directory: ${relative}`)
    if (!state) {
      await fs.mkdir(current).catch((error) => {
        if (error.code !== 'EEXIST') throw error
      })
      await syncDirectory(path.dirname(current))
    }
  }
}

async function publicationTarget(root, relative) {
  assertRelative(relative)
  await ensureParents(root, relative)
  const target = path.join(root, relative)
  const state = await lstatOrNull(target)
  if (!state) return { target, bytes: null }
  if (state.isSymbolicLink())
    throw new Error(`Refusing symbolic-link publication path: ${relative}`)
  if (!state.isFile())
    throw new Error(`Publication target is not a regular file: ${relative}`)
  return { target, bytes: await fs.readFile(target) }
}

async function durableWrite(file, bytes, exclusive = false) {
  const handle = await fs.open(file, exclusive ? 'wx' : 'w', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(directory) {
  const session = sessions.getStore()
  if (session) return session.rpc('sync', { path: directory })
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function transactionRoot(root) {
  const directory = path.join(root, TRANSACTION_RELATIVE)
  const state = await lstatOrNull(directory)
  if (state?.isSymbolicLink() || (state && !state.isDirectory()))
    throw new Error('Publisher transaction directory is unsafe')
  if (!state) {
    await ensureParents(root, TRANSACTION_RELATIVE)
    await fs.mkdir(directory)
  }
  return directory
}

async function safePrivateDirectory(directory, expectedName) {
  const state = await lstatOrNull(directory)
  if (!state?.isDirectory() || state.isSymbolicLink())
    throw new Error('Publisher private transaction directory is unsafe')
  if (state.mode & 0o077)
    throw new Error('Publisher private transaction directory is not private')
  if (path.basename(directory) !== expectedName)
    throw new Error('Publisher private transaction directory is invalid')
}

async function removePrivateDirectory(
  directory,
  { allowJournal = false } = {},
) {
  const names = await fs.readdir(directory)
  for (const name of names) {
    if (!PRIVATE_FILE.test(name) && !(allowJournal && name === JOURNAL))
      throw new Error(
        'Publisher private transaction directory contains unknown files',
      )
    const state = await lstatOrNull(path.join(directory, name))
    if (!state?.isFile() || state.isSymbolicLink())
      throw new Error('Publisher private transaction artifact is unsafe')
  }
  for (const name of names) await fs.unlink(path.join(directory, name))
  await syncDirectory(directory)
  await fs.rmdir(directory)
  await syncDirectory(path.dirname(directory))
}

function entryFor(index, input, current) {
  const before =
    input.beforeBytes === null ? null : Buffer.from(input.beforeBytes)
  if (
    (current.bytes === null) !== (before === null) ||
    (current.bytes && !current.bytes.equals(before))
  )
    throw new Error(
      `Publisher target changed before prepare: ${input.relative}`,
    )
  const bytes = Buffer.from(input.bytes)
  return {
    relative: input.relative,
    beforeHash: before === null ? null : digest(before),
    afterHash: digest(bytes),
    beforeFile: before === null ? null : `before-${index}.bin`,
    afterFile: `after-${index}.bin`,
    before,
    bytes,
  }
}

function journalFor(root, entries) {
  const payload = {
    version: 2,
    repoRoot: root,
    transactionId: crypto.randomUUID(),
    entries: entries.map(({ before, bytes, ...entry }) => entry),
  }
  return { ...payload, journalHash: digest(JSON.stringify(payload)) }
}

function validateJournal(journal, root) {
  if (
    !journal ||
    journal.version !== 2 ||
    journal.repoRoot !== root ||
    !Array.isArray(journal.entries)
  )
    throw new Error('Publisher transaction journal is invalid')
  const { journalHash, ...payload } = journal
  if (
    typeof journalHash !== 'string' ||
    digest(JSON.stringify(payload)) !== journalHash
  )
    throw new Error('Publisher transaction journal integrity check failed')
  const seen = new Set()
  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index]
    assertRelative(entry.relative)
    if (seen.has(entry.relative))
      throw new Error('Publisher transaction has duplicate targets')
    seen.add(entry.relative)
    if (
      (entry.beforeHash !== null && typeof entry.beforeHash !== 'string') ||
      typeof entry.afterHash !== 'string' ||
      entry.beforeFile !==
        (entry.beforeHash === null ? null : `before-${index}.bin`) ||
      entry.afterFile !== `after-${index}.bin`
    )
      throw new Error('Publisher transaction journal entry is invalid')
  }
}

async function readJournal(active, root) {
  const journalPath = path.join(active, JOURNAL)
  const state = await lstatOrNull(journalPath)
  if (!state) return null
  if (!state.isFile() || state.isSymbolicLink())
    throw new Error('Publisher transaction journal is unsafe')
  let journal
  try {
    journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
  } catch {
    throw new Error('Publisher transaction journal is unreadable')
  }
  validateJournal(journal, root)
  return journal
}

async function conditionalReplace(
  root,
  active,
  entry,
  expected,
  replacement,
  source,
  onTransactionStep,
  phase,
) {
  const session = sessions.getStore()
  const token = await session.rpc('replaceStart', {
    target: path.join(root, entry.relative),
    active,
    expected,
    replacement,
    source,
  })
  if (onTransactionStep)
    await onTransactionStep({
      phase,
      boundary: 'prepared',
      relative: entry.relative,
    })
  await session.rpc('replaceQuarantine', { token })
  if (onTransactionStep)
    await onTransactionStep({
      phase,
      boundary: 'quarantined',
      relative: entry.relative,
    })
  await session.rpc('replaceInstall', { token })
  if (onTransactionStep)
    await onTransactionStep({
      phase,
      boundary: 'installed',
      relative: entry.relative,
    })
  await session.rpc('replaceFinish', { token })
}

async function restore(root, active, entry, onTransactionStep) {
  const current = await publicationTarget(root, entry.relative)
  const currentHash = current.bytes === null ? null : digest(current.bytes)
  if (currentHash === entry.beforeHash) return
  if (currentHash !== entry.afterHash)
    throw new Error(
      `Publisher recovery found changed target: ${entry.relative}`,
    )
  await conditionalReplace(
    root,
    active,
    entry,
    entry.afterHash,
    entry.beforeHash,
    entry.beforeFile,
    onTransactionStep,
    'restore',
  )
}

async function installVerifiedAfter(root, active, entry, onTransactionStep) {
  const current = await publicationTarget(root, entry.relative)
  const currentHash = current.bytes === null ? null : digest(current.bytes)
  if (currentHash !== entry.beforeHash)
    throw new Error(
      `Publisher target changed immediately before publish: ${entry.relative}`,
    )
  await conditionalReplace(
    root,
    active,
    entry,
    entry.beforeHash,
    entry.afterHash,
    entry.afterFile,
    onTransactionStep,
    'install',
  )
}

async function assertUniformState(root, journal, field) {
  for (const entry of journal.entries) {
    const current = await publicationTarget(root, entry.relative)
    const hash = current.bytes === null ? null : digest(current.bytes)
    if (hash !== entry[field])
      throw new Error(
        `Publisher target changed before cleanup: ${entry.relative}`,
      )
  }
}

async function moveToCleanup(active, journal, field) {
  return sessions.getStore().rpc('cleanupBegin', {
    path: active,
    journal,
    field,
    destination: `cleanup-${crypto.randomUUID()}`,
  })
}

async function cleanupUniform(cleanup, onCleanupStep) {
  const rpc = sessions.getStore().rpc
  for (const name of cleanup.names) {
    if (name === JOURNAL || name === 'cleanup-state.json') continue
    await rpc('cleanupRemove', { token: cleanup.token, name })
    if (onCleanupStep) await onCleanupStep({ phase: 'artifact', file: name })
    await rpc('cleanupCheck', { token: cleanup.token })
  }
  if (cleanup.names.includes(JOURNAL)) {
    await rpc('cleanupRemove', { token: cleanup.token, name: JOURNAL })
    if (onCleanupStep) await onCleanupStep({ phase: 'journal' })
    await rpc('cleanupCheck', { token: cleanup.token })
  }
  // Keep the identity sentinel until after the final caller boundary.
  if (onCleanupStep) await onCleanupStep({ phase: 'directory' })
  await rpc('cleanupCheck', { token: cleanup.token })
  await rpc('cleanupFinish', { token: cleanup.token })
}

async function recoverInactive(root) {
  const directory = await transactionRoot(root)
  for (const name of await fs.readdir(directory)) {
    if (!PREPARATION.test(name) && !CLEANUP.test(name)) continue
    const privateDirectory = path.join(directory, name)
    await safePrivateDirectory(privateDirectory, name)
    if (CLEANUP.test(name)) {
      const cleanup = await sessions
        .getStore()
        .rpc('cleanupBegin', { path: privateDirectory, resume: true })
      await cleanupUniform(cleanup)
    } else
      await removePrivateDirectory(privateDirectory, { allowJournal: true })
  }
  const unexpected = (await fs.readdir(directory)).filter(
    (name) => name !== ACTIVE,
  )
  if (unexpected.length)
    throw new Error('Publisher transaction directory contains unknown files')
  return directory
}

async function recoverTransaction({
  repoRoot = process.cwd(),
  onCleanupStep,
  onTransactionStep,
} = {}) {
  const root = await rootPath(repoRoot)
  const directory = await recoverInactive(root)
  const active = path.join(directory, ACTIVE)
  const state = await lstatOrNull(active)
  if (!state) return false
  await safePrivateDirectory(active, ACTIVE)
  const journal = await readJournal(active, root)
  if (!journal)
    throw new Error('Publisher active transaction is missing its journal')
  await sessions
    .getStore()
    .rpc('recoverOperations', { path: active, entries: journal.entries })
  const states = []
  for (const entry of journal.entries) {
    const current = await publicationTarget(root, entry.relative)
    const hash = current.bytes === null ? null : digest(current.bytes)
    if (hash !== entry.beforeHash && hash !== entry.afterHash)
      throw new Error(
        `Publisher recovery found changed target: ${entry.relative}`,
      )
    states.push({ after: hash === entry.afterHash })
  }
  const allAfter = states.every((state) => state.after)
  if (!allAfter)
    for (let index = 0; index < journal.entries.length; index += 1)
      if (states[index].after)
        await restore(root, active, journal.entries[index], onTransactionStep)
  await sessions
    .getStore()
    .rpc('recoverOperations', { path: active, entries: journal.entries })
  await assertUniformState(root, journal, allAfter ? 'afterHash' : 'beforeHash')
  const cleanup = await moveToCleanup(
    active,
    journal,
    allAfter ? 'afterHash' : 'beforeHash',
  )
  await cleanupUniform(cleanup, onCleanupStep)
  return allAfter ? 'finalized' : 'rolled-back'
}

async function commitTransaction({
  repoRoot = process.cwd(),
  entries,
  beforeCommit,
  onCommitStep,
  onPrepareStep,
  onJournalDurable,
  onCleanupStep,
  onTransactionStep,
} = {}) {
  const root = await rootPath(repoRoot)
  if (!Array.isArray(entries) || !entries.length)
    throw new Error('Publisher transaction requires artifacts')
  for (const entry of entries) {
    assertRelative(entry.relative)
    if (!(entry.bytes instanceof Uint8Array))
      throw new Error(
        `Publisher artifact bytes are required: ${entry.relative}`,
      )
    if (
      entry.beforeBytes !== null &&
      !(entry.beforeBytes instanceof Uint8Array)
    )
      throw new Error(
        `Publisher artifact beforeBytes are invalid: ${entry.relative}`,
      )
  }
  if (new Set(entries.map((entry) => entry.relative)).size !== entries.length)
    throw new Error('Publisher transaction has duplicate targets')
  await recoverPublisherTransaction({ repoRoot: root })
  const directory = await recoverInactive(root)
  const preparation = path.join(directory, `prepare-${crypto.randomUUID()}`)
  await fs.mkdir(preparation, { mode: 0o700 })
  await syncDirectory(directory)
  let promoted = false
  try {
    const records = []
    for (let index = 0; index < entries.length; index += 1) {
      const current = await publicationTarget(root, entries[index].relative)
      const record = entryFor(index, entries[index], current)
      if (record.before)
        await durableWrite(
          path.join(preparation, record.beforeFile),
          record.before,
          true,
        )
      await durableWrite(
        path.join(preparation, record.afterFile),
        record.bytes,
        true,
      )
      records.push(record)
      if (onPrepareStep)
        await onPrepareStep({
          index: index + 1,
          total: entries.length,
          relative: record.relative,
        })
    }
    await syncDirectory(preparation)
    const journal = journalFor(root, records)
    await durableWrite(
      path.join(preparation, JOURNAL),
      `${JSON.stringify(journal)}\n`,
      true,
    )
    await syncDirectory(preparation)
    if (onJournalDurable) await onJournalDurable()
    const active = path.join(directory, ACTIVE)
    if (await lstatOrNull(active))
      throw new Error('Publisher transaction is already active')
    await fs.rename(preparation, active)
    promoted = true
    await syncDirectory(directory)
    if (beforeCommit) await beforeCommit()
    for (const input of entries) {
      const current = await publicationTarget(root, input.relative)
      const expected =
        input.beforeBytes === null ? null : Buffer.from(input.beforeBytes)
      if (
        (current.bytes === null) !== (expected === null) ||
        (current.bytes && !current.bytes.equals(expected))
      )
        throw new Error(
          `Publisher target changed before commit: ${input.relative}`,
        )
    }
    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index]
      await installVerifiedAfter(root, active, entry, onTransactionStep)
      if (onCommitStep)
        await onCommitStep({
          index: index + 1,
          total: journal.entries.length,
          relative: entry.relative,
        })
    }
    await sessions
      .getStore()
      .rpc('recoverOperations', { path: active, entries: journal.entries })
    await assertUniformState(root, journal, 'afterHash')
    const cleanup = await moveToCleanup(active, journal, 'afterHash')
    await cleanupUniform(cleanup, onCleanupStep)
    return entries.map(({ relative }) => relative)
  } catch (error) {
    if (!promoted)
      await recoverInactive(root).catch((recoveryError) => {
        error.recoveryError = recoveryError
      })
    else
      await recoverPublisherTransaction({ repoRoot: root }).catch(
        (recoveryError) => {
          error.recoveryError = recoveryError
        },
      )
    throw error
  }
}

async function processIdentity(pid) {
  if (process.platform === 'linux') {
    try {
      const [bootId, stat] = await Promise.all([
        nativeFs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        nativeFs.readFile(`/proc/${pid}/stat`, 'utf8'),
      ])
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/)
      return { bootId: bootId.trim(), processStart: fields[19] ?? null }
    } catch {
      throw new Error('Publisher lease identity is unavailable on Linux')
    }
  }
  if (process.platform === 'darwin') {
    try {
      const options = {
        env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C' },
      }
      const [{ stdout: bootTime }, { stdout: started }] = await Promise.all([
        execFile('/usr/sbin/sysctl', ['-n', 'kern.boottime'], options),
        execFile('/bin/ps', ['-p', String(pid), '-o', 'lstart='], options),
      ])
      const boot = bootTime.match(
        /\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/,
      )
      const processStart = started.trim()
      if (
        !boot ||
        !/^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(
          processStart,
        )
      )
        throw new Error('invalid Darwin publisher lease identity')
      return {
        bootId: `darwin:${boot[1]}:${boot[2]}`,
        processStart,
      }
    } catch {
      throw new Error('Publisher lease identity is unavailable on Darwin')
    }
  }
  throw new Error(
    `Publisher lease identity is unsupported on ${process.platform}`,
  )
}

async function ownerIsLive(owner, identityProvider) {
  if (
    !owner ||
    owner.hostname !== os.hostname() ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0
  )
    return true
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    return error.code !== 'ESRCH'
  }
  if (!owner.bootId || !owner.processStart) return true
  const current = await identityProvider(owner.pid)
  return (
    current.bootId === owner.bootId &&
    current.processStart === owner.processStart
  )
}

async function acquireLease({
  repoRoot = process.cwd(),
  identityProvider = processIdentity,
} = {}) {
  const root = await rootPath(repoRoot)
  await ensureParents(root, LOCK_RELATIVE)
  const lock = path.join(root, LOCK_RELATIVE)
  const identity = await identityProvider(process.pid)
  const owner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    repoRoot: root,
    bootId: identity.bootId,
    processStart: identity.processStart,
  }
  const bytes = Buffer.from(`${JSON.stringify(owner)}\n`)
  for (;;) {
    const state = await lstatOrNull(lock)
    if (state?.isSymbolicLink() || (state && !state.isFile()))
      throw new Error('Publisher lease is unsafe')
    try {
      await durableWrite(lock, bytes, true)
      await syncDirectory(path.dirname(lock))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = await fs
        .readFile(lock)
        .catch((readError) =>
          readError.code === 'ENOENT' ? null : Promise.reject(readError),
        )
      if (!existing) continue
      let previous
      try {
        previous = JSON.parse(existing.toString('utf8'))
      } catch {
        throw new Error('Translation publish already running locally.')
      }
      if (await ownerIsLive(previous, identityProvider))
        throw new Error('Translation publish already running locally.')
      await recoverPublisherTransaction({ repoRoot: root })
      const current = await fs.readFile(lock).catch(() => null)
      if (!current || !current.equals(existing)) continue
      await fs.unlink(lock)
      await syncDirectory(path.dirname(lock))
    }
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    const current = await fs.readFile(lock).catch(() => null)
    if (current?.equals(bytes)) {
      await fs.unlink(lock)
      await syncDirectory(path.dirname(lock))
    }
  }
}

export function commitPublisherTransaction(options = {}) {
  return inSession(options, () => commitTransaction(options))
}

export function recoverPublisherTransaction(options = {}) {
  return inSession(options, () => recoverTransaction(options))
}

export async function acquirePublisherLease(options = {}) {
  const root = await rootPath(options.repoRoot ?? process.cwd())
  const session = createSession(root)
  try {
    const release = await sessions.run(session, async () => {
      await ensureParents(root, LOCK_RELATIVE)
      try {
        await session.rpc('guard')
      } catch (error) {
        if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')
          throw new Error('Translation publish already running locally.')
        throw error
      }
      return acquireLease(options)
    })
    leases.set(root, session)
    let released = false
    return async () => {
      if (released) return
      released = true
      try {
        await sessions.run(session, release)
      } finally {
        if (leases.get(root) === session) leases.delete(root)
        await session.close()
      }
    }
  } catch (error) {
    await session.close()
    throw error
  }
}
