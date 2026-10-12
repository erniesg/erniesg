import crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TRANSACTION_RELATIVE = 'generated/tmp/.translation-transaction'
const LOCK_RELATIVE = 'generated/tmp/.translation-publisher.lock'
const JOURNAL_FILE = 'journal.json'

const digest = (value) =>
  crypto.createHash('sha256').update(value).digest('hex')

const isPublicationArtifact = (relative) =>
  relative === '.translation/manifest.json' ||
  relative === '.translation/pages.json' ||
  /^\.translation\/reports\/[A-Za-z0-9._-]+\.json$/.test(relative) ||
  /^src\/content\/blog\/(?:[A-Za-z0-9._-]+\/)*(?:zh|ja|ko)\.mdx$/.test(
    relative,
  )

function failPath(relative) {
  throw new Error(`Not a permitted publication artifact: ${relative}`)
}

function assertRelative(relative) {
  if (
    typeof relative !== 'string' ||
    !isPublicationArtifact(relative) ||
    path.isAbsolute(relative) ||
    relative.split('/').some((component) => component === '' || component === '.' || component === '..')
  )
    failPath(relative)
  return relative
}

async function realRoot(repoRoot) {
  return fs.realpath(repoRoot)
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function ensureSafeParents(root, relative) {
  let current = root
  const components = relative.split('/')
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component)
    const state = await lstatOrNull(current)
    if (state?.isSymbolicLink())
      throw new Error(`Refusing symbolic-link publication path: ${relative}`)
    if (state && !state.isDirectory())
      throw new Error(`Publication parent is not a directory: ${relative}`)
    if (!state) await fs.mkdir(current)
  }
}

async function targetState(root, relative) {
  assertRelative(relative)
  await ensureSafeParents(root, relative)
  const target = path.join(root, relative)
  const state = await lstatOrNull(target)
  if (!state) return { target, bytes: null }
  if (state.isSymbolicLink())
    throw new Error(`Refusing symbolic-link publication path: ${relative}`)
  if (!state.isFile())
    throw new Error(`Publication target is not a regular file: ${relative}`)
  return { target, bytes: await fs.readFile(target) }
}

async function durableWrite(file, bytes, { exclusive = false } = {}) {
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

async function transactionPaths(root) {
  const directory = path.join(root, TRANSACTION_RELATIVE)
  const state = await lstatOrNull(directory)
  if (state?.isSymbolicLink() || (state && !state.isDirectory()))
    throw new Error('Publisher transaction directory is unsafe')
  if (!state) {
    await ensureSafeParents(root, TRANSACTION_RELATIVE)
    await fs.mkdir(directory)
  }
  return { directory, journal: path.join(directory, JOURNAL_FILE) }
}

async function assertEmptyTransactionDirectory(paths) {
  const names = await fs.readdir(paths.directory)
  if (names.length)
    throw new Error('Publisher transaction directory contains unrecoverable files')
}

function journalPayload(root, entries) {
  return {
    version: 1,
    repoRoot: root,
    transactionId: crypto.randomUUID(),
    entries,
  }
}

function validateJournal(journal, root) {
  if (!journal || journal.version !== 1 || journal.repoRoot !== root || !Array.isArray(journal.entries))
    throw new Error('Publisher transaction journal is invalid')
  const { journalHash, ...payload } = journal
  if (typeof journalHash !== 'string' || digest(JSON.stringify(payload)) !== journalHash)
    throw new Error('Publisher transaction journal integrity check failed')
  const seen = new Set()
  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index]
    assertRelative(entry.relative)
    if (seen.has(entry.relative)) throw new Error('Publisher transaction has duplicate targets')
    seen.add(entry.relative)
    if (
      entry.beforeHash !== null && typeof entry.beforeHash !== 'string' ||
      typeof entry.afterHash !== 'string' ||
      entry.beforeFile !== (entry.beforeHash === null ? null : `before-${index}.bin`) ||
      entry.afterFile !== `after-${index}.bin`
    )
      throw new Error('Publisher transaction journal entry is invalid')
  }
}

async function removeKnownTransactionFiles(paths, journal) {
  const files = [paths.journal]
  for (const entry of journal.entries) {
    if (entry.beforeFile) files.push(path.join(paths.directory, entry.beforeFile))
    files.push(path.join(paths.directory, entry.afterFile))
  }
  for (const file of files) await fs.rm(file, { force: true })
  await fs.rmdir(paths.directory).catch((error) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
  })
}

async function removePreparedFiles(paths, files) {
  for (const file of files) await fs.rm(file, { force: true })
  await fs.rmdir(paths.directory).catch((error) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
  })
}

async function replaceDurably(from, target) {
  await fs.rename(from, target)
  await syncDirectory(path.dirname(target))
}

async function restoreEntry(root, directory, entry, index) {
  const current = await targetState(root, entry.relative)
  if (entry.beforeHash === null) {
    if (current.bytes === null) return
    if (digest(current.bytes) !== entry.afterHash)
      throw new Error(`Publisher recovery found changed target: ${entry.relative}`)
    await fs.rm(current.target)
    await syncDirectory(path.dirname(current.target))
    return
  }
  if (current.bytes !== null && digest(current.bytes) === entry.beforeHash) return
  if (current.bytes === null || digest(current.bytes) !== entry.afterHash)
    throw new Error(`Publisher recovery found changed target: ${entry.relative}`)
  const backup = path.join(directory, entry.beforeFile)
  const backupState = await lstatOrNull(backup)
  if (!backupState?.isFile() || backupState.isSymbolicLink())
    throw new Error('Publisher recovery backup is invalid')
  const bytes = await fs.readFile(backup)
  if (digest(bytes) !== entry.beforeHash)
    throw new Error('Publisher recovery backup digest does not match')
  const temporary = `${current.target}.translation-restore-${crypto.randomUUID()}`
  await durableWrite(temporary, bytes, { exclusive: true })
  await replaceDurably(temporary, current.target)
}

export async function recoverPublisherTransaction({ repoRoot = process.cwd() } = {}) {
  const root = await realRoot(repoRoot)
  const paths = await transactionPaths(root)
  const journalState = await lstatOrNull(paths.journal)
  if (!journalState) return false
  if (journalState.isSymbolicLink() || !journalState.isFile())
    throw new Error('Publisher transaction journal is unsafe')
  let journal
  try {
    journal = JSON.parse(await fs.readFile(paths.journal, 'utf8'))
  } catch {
    throw new Error('Publisher transaction journal is unreadable')
  }
  validateJournal(journal, root)
  const states = []
  for (const entry of journal.entries) {
    const current = await targetState(root, entry.relative)
    const hash = current.bytes === null ? null : digest(current.bytes)
    const before = hash === entry.beforeHash
    const after = hash === entry.afterHash
    if (!before && !after)
      throw new Error(`Publisher recovery found changed target: ${entry.relative}`)
    states.push({ before, after })
  }
  if (states.every((state) => state.after)) {
    await removeKnownTransactionFiles(paths, journal)
    return 'finalized'
  }
  for (let index = 0; index < journal.entries.length; index += 1)
    if (states[index].after)
      await restoreEntry(root, paths.directory, journal.entries[index], index)
  await removeKnownTransactionFiles(paths, journal)
  return 'rolled-back'
}

export async function commitPublisherTransaction({
  repoRoot = process.cwd(),
  entries,
  beforeCommit,
  onCommitStep,
} = {}) {
  const root = await realRoot(repoRoot)
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error('Publisher transaction requires artifacts')
  for (const entry of entries) {
    assertRelative(entry.relative)
    if (!(entry.bytes instanceof Uint8Array))
      throw new Error(`Publisher artifact bytes are required: ${entry.relative}`)
    if (entry.beforeBytes !== null && !(entry.beforeBytes instanceof Uint8Array))
      throw new Error(`Publisher artifact beforeBytes are invalid: ${entry.relative}`)
  }
  if (new Set(entries.map((entry) => entry.relative)).size !== entries.length)
    throw new Error('Publisher transaction has duplicate targets')
  await recoverPublisherTransaction({ repoRoot: root })
  const paths = await transactionPaths(root)
  await assertEmptyTransactionDirectory(paths)
  const records = []
  const preparedFiles = []
  let journal = null
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const input = entries[index]
      const current = await targetState(root, input.relative)
      const expected = input.beforeBytes === null ? null : Buffer.from(input.beforeBytes)
      if (
        (current.bytes === null) !== (expected === null) ||
        (current.bytes && !current.bytes.equals(expected))
      )
        throw new Error(`Publisher target changed before prepare: ${input.relative}`)
      const beforeHash = expected === null ? null : digest(expected)
      const bytes = Buffer.from(input.bytes)
      const afterHash = digest(bytes)
      const beforeFile = beforeHash === null ? null : `before-${index}.bin`
      const afterFile = `after-${index}.bin`
      if (expected) {
        const backup = path.join(paths.directory, beforeFile)
        await durableWrite(backup, expected, { exclusive: true })
        preparedFiles.push(backup)
      }
      const temporary = path.join(paths.directory, afterFile)
      await durableWrite(temporary, bytes, { exclusive: true })
      preparedFiles.push(temporary)
      records.push({ relative: input.relative, beforeHash, afterHash, beforeFile, afterFile })
    }
    await syncDirectory(paths.directory)
    const payload = journalPayload(root, records)
    journal = { ...payload, journalHash: digest(JSON.stringify(payload)) }
    await durableWrite(paths.journal, `${JSON.stringify(journal)}\n`, { exclusive: true })
    await syncDirectory(paths.directory)
    if (beforeCommit) await beforeCommit()
    for (const input of entries) {
      const current = await targetState(root, input.relative)
      const expected = input.beforeBytes === null ? null : Buffer.from(input.beforeBytes)
      if ((current.bytes === null) !== (expected === null) || (current.bytes && !current.bytes.equals(expected)))
        throw new Error(`Publisher target changed before commit: ${input.relative}`)
    }
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]
      const current = await targetState(root, record.relative)
      await replaceDurably(path.join(paths.directory, record.afterFile), current.target)
      if (onCommitStep) await onCommitStep({ index: index + 1, total: records.length, relative: record.relative })
    }
    await removeKnownTransactionFiles(paths, journal)
    return entries.map(({ relative }) => relative)
  } catch (error) {
    const recover = journal
      ? recoverPublisherTransaction({ repoRoot: root })
      : removePreparedFiles(paths, preparedFiles)
    await recover.catch((recoveryError) => {
      error.recoveryError = recoveryError
    })
    throw error
  }
}

function isDeadLocalOwner(owner) {
  if (!owner || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0)
    return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

export async function acquirePublisherLease({ repoRoot = process.cwd() } = {}) {
  const root = await realRoot(repoRoot)
  const lock = path.join(root, LOCK_RELATIVE)
  await ensureSafeParents(root, LOCK_RELATIVE)
  const owner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    repoRoot: root,
  }
  const ownerBytes = Buffer.from(`${JSON.stringify(owner)}\n`)
  for (;;) {
    const state = await lstatOrNull(lock)
    if (state?.isSymbolicLink() || (state && !state.isFile()))
      throw new Error('Publisher lease is unsafe')
    try {
      await durableWrite(lock, ownerBytes, { exclusive: true })
      await syncDirectory(path.dirname(lock))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = await fs.readFile(lock).catch((readError) => {
        if (readError.code === 'ENOENT') return null
        throw readError
      })
      if (!existing) continue
      let previous
      try {
        previous = JSON.parse(existing.toString('utf8'))
      } catch {
        throw new Error('Translation publish already running locally.')
      }
      if (!isDeadLocalOwner(previous))
        throw new Error('Translation publish already running locally.')
      await recoverPublisherTransaction({ repoRoot: root })
      const current = await fs.readFile(lock).catch(() => null)
      if (!current || !current.equals(existing)) continue
      await fs.rm(lock)
      await syncDirectory(path.dirname(lock))
    }
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    const current = await fs.readFile(lock).catch(() => null)
    if (current?.equals(ownerBytes)) {
      await fs.rm(lock)
      await syncDirectory(path.dirname(lock))
    }
  }
}
