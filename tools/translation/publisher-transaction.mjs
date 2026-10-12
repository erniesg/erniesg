import crypto from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const TRANSACTION_RELATIVE = 'generated/tmp/.translation-transaction'
const LOCK_RELATIVE = 'generated/tmp/.translation-publisher.lock'
const ACTIVE = 'active'
const JOURNAL = 'journal.json'
const PREPARATION = /^prepare-[0-9a-f-]+$/
const CLEANUP = /^cleanup-[0-9a-f-]+$/
const PRIVATE_FILE = /^(?:before|after)-[0-9]+\.bin$/
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
    if (!state) await fs.mkdir(current)
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

async function restore(root, active, entry) {
  const current = await publicationTarget(root, entry.relative)
  if (entry.beforeHash === null) {
    if (current.bytes === null) return
    if (digest(current.bytes) !== entry.afterHash)
      throw new Error(
        `Publisher recovery found changed target: ${entry.relative}`,
      )
    await fs.unlink(current.target)
    await syncDirectory(path.dirname(current.target))
    return
  }
  if (current.bytes !== null && digest(current.bytes) === entry.beforeHash)
    return
  if (current.bytes === null || digest(current.bytes) !== entry.afterHash)
    throw new Error(
      `Publisher recovery found changed target: ${entry.relative}`,
    )
  const backup = path.join(active, entry.beforeFile)
  const state = await lstatOrNull(backup)
  if (!state?.isFile() || state.isSymbolicLink())
    throw new Error('Publisher recovery backup is invalid')
  const bytes = await fs.readFile(backup)
  if (digest(bytes) !== entry.beforeHash)
    throw new Error('Publisher recovery backup digest does not match')
  const temporary = `${current.target}.translation-restore-${crypto.randomUUID()}`
  await durableWrite(temporary, bytes, true)
  await fs.rename(temporary, current.target)
  await syncDirectory(path.dirname(current.target))
}

async function verifiedAfterBytes(active, entry) {
  const prepared = path.join(active, entry.afterFile)
  const state = await lstatOrNull(prepared)
  if (!state?.isFile() || state.isSymbolicLink())
    throw new Error('Publisher prepared artifact is unsafe')
  const bytes = await fs.readFile(prepared)
  if (digest(bytes) !== entry.afterHash)
    throw new Error('Publisher prepared artifact digest does not match')
  return bytes
}

async function installVerifiedAfter(root, active, entry) {
  const current = await publicationTarget(root, entry.relative)
  const currentHash = current.bytes === null ? null : digest(current.bytes)
  if (currentHash !== entry.beforeHash)
    throw new Error(
      `Publisher target changed immediately before publish: ${entry.relative}`,
    )
  const bytes = await verifiedAfterBytes(active, entry)
  const temporary = `${current.target}.translation-publish-${crypto.randomUUID()}`
  await durableWrite(temporary, bytes, true)
  await fs.rename(temporary, current.target)
  await syncDirectory(path.dirname(current.target))
  const published = await publicationTarget(root, entry.relative)
  if (published.bytes === null || digest(published.bytes) !== entry.afterHash)
    throw new Error(
      `Publisher target changed during publish: ${entry.relative}`,
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

async function moveToCleanup(active) {
  const cleanup = path.join(
    path.dirname(active),
    `cleanup-${crypto.randomUUID()}`,
  )
  await fs.rename(active, cleanup)
  await syncDirectory(path.dirname(active))
  return cleanup
}

async function cleanupUniform(cleanup, journal, onCleanupStep) {
  for (const entry of journal.entries)
    for (const name of [entry.beforeFile, entry.afterFile].filter(Boolean)) {
      const file = path.join(cleanup, name)
      const state = await lstatOrNull(file)
      if (state) {
        if (!state.isFile() || state.isSymbolicLink())
          throw new Error('Publisher private transaction artifact is unsafe')
        await fs.unlink(file)
        if (onCleanupStep)
          await onCleanupStep({ phase: 'artifact', file: name })
      }
    }
  await syncDirectory(cleanup)
  const journalPath = path.join(cleanup, JOURNAL)
  const journalState = await lstatOrNull(journalPath)
  if (journalState) {
    if (!journalState.isFile() || journalState.isSymbolicLink())
      throw new Error('Publisher transaction journal is unsafe')
    await fs.unlink(journalPath)
    await syncDirectory(cleanup)
    if (onCleanupStep) await onCleanupStep({ phase: 'journal' })
  }
  await fs.rmdir(cleanup).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  await syncDirectory(path.dirname(cleanup))
  if (onCleanupStep) await onCleanupStep({ phase: 'directory' })
}

async function recoverInactive(root) {
  const directory = await transactionRoot(root)
  for (const name of await fs.readdir(directory)) {
    if (!PREPARATION.test(name) && !CLEANUP.test(name)) continue
    const privateDirectory = path.join(directory, name)
    await safePrivateDirectory(privateDirectory, name)
    await removePrivateDirectory(privateDirectory, { allowJournal: true })
  }
  const unexpected = (await fs.readdir(directory)).filter(
    (name) => name !== ACTIVE,
  )
  if (unexpected.length)
    throw new Error('Publisher transaction directory contains unknown files')
  return directory
}

export async function recoverPublisherTransaction({
  repoRoot = process.cwd(),
  onCleanupStep,
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
        await restore(root, active, journal.entries[index])
  await assertUniformState(root, journal, allAfter ? 'afterHash' : 'beforeHash')
  const cleanup = await moveToCleanup(active)
  await cleanupUniform(cleanup, journal, onCleanupStep)
  return allAfter ? 'finalized' : 'rolled-back'
}

export async function commitPublisherTransaction({
  repoRoot = process.cwd(),
  entries,
  beforeCommit,
  onCommitStep,
  onPrepareStep,
  onJournalDurable,
  onCleanupStep,
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
      await installVerifiedAfter(root, active, entry)
      if (onCommitStep)
        await onCommitStep({
          index: index + 1,
          total: journal.entries.length,
          relative: entry.relative,
        })
    }
    await assertUniformState(root, journal, 'afterHash')
    const cleanup = await moveToCleanup(active)
    await cleanupUniform(cleanup, journal, onCleanupStep)
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
        fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        fs.readFile(`/proc/${pid}/stat`, 'utf8'),
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

export async function acquirePublisherLease({
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
