#!/usr/bin/env node
/**
 * A free TCP port for one e2e run, held until the run's shell exits (issue 059).
 *
 *   SRT_E2E_PORT=$(node tools/e2e-port.mjs) || exit 1; export SRT_E2E_PORT
 *
 * Asking the kernel for port 0 and closing the socket leaves a gap in which a
 * second worker on the same host can be handed the same port before
 * Playwright binds it. This closes the gap between workers: after the kernel
 * names a port, the port is claimed by creating
 * `$TMPDIR/srt-e2e-ports/<port>.lock` exclusively (`O_EXCL`), holding the PID
 * of the calling shell. A lock whose PID is alive belongs to another run, so
 * another port is asked for; a lock whose PID has exited is reclaimed. The
 * port is printed and the process exits; the lock lives as long as the shell
 * that ran it, which covers the server Playwright starts.
 *
 * Every failure exits non-zero with nothing on stdout — an unwritable lock
 * directory, a corrupt lock, no port after many tries — so a validation line
 * never proceeds on a port nobody holds.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const LOCK_DIRECTORY_NAME = 'srt-e2e-ports'
const MAX_ATTEMPTS = 64
/** A reclaim mutex older than this was left by a reclaimer that died holding it. */
const STALE_MUTEX_MS = 30_000

export class PortLockError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PortLockError'
  }
}

/** Is `pid` a live process? `EPERM` means alive but not ours. */
export function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && error.code === 'EPERM') return true
    if (error && error.code === 'ESRCH') return false
    throw error
  }
}

function readOwner(lockPath) {
  let text
  try {
    text = readFileSync(lockPath, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  const trimmed = text.trim()
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new PortLockError(`corrupt port lock ${lockPath}: ${JSON.stringify(text.slice(0, 40))}`)
  }
  return Number(trimmed)
}

function createExclusive(lockPath, owner) {
  let fd
  try {
    fd = openSync(lockPath, 'wx', 0o644)
  } catch (error) {
    if (error && error.code === 'EEXIST') return false
    throw error
  }
  try {
    writeSync(fd, `${owner}\n`)
  } finally {
    closeSync(fd)
  }
  return true
}

/**
 * Take the per-port reclaim mutex: an atomic `mkdir`. `false` when another
 * reclaimer holds it. A mutex a dead reclaimer left behind is cleared once it
 * is older than `STALE_MUTEX_MS`, so a port is never lost for good.
 */
function takeReclaimMutex(mutexPath) {
  try {
    mkdirSync(mutexPath)
    return true
  } catch (error) {
    if (!(error && error.code === 'EEXIST')) throw error
  }
  try {
    if (Date.now() - statSync(mutexPath).mtimeMs > STALE_MUTEX_MS) rmdirSync(mutexPath)
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) throw error
  }
  return false
}

/**
 * Claim `port` for `owner` in `directory`. `true` when claimed, `false` when a
 * live run holds it or another worker is reclaiming it. A dead owner's lock is
 * reclaimed; a corrupt lock throws.
 *
 * Reclaiming is serialized by a per-port mutex, and the lock is read again
 * inside it: two workers that both saw the same dead owner cannot both remove
 * a lock, because the second finds the first's live lock and stands down.
 */
export function claimPort(port, directory, owner, hooks = {}) {
  const lockPath = path.join(directory, `${port}.lock`)
  if (createExclusive(lockPath, owner)) return true
  const holder = readOwner(lockPath)
  if (holder === null) return createExclusive(lockPath, owner)
  if (holder === owner || processAlive(holder)) return false

  hooks.beforeReclaim?.()
  const mutexPath = path.join(directory, `${port}.reclaim`)
  if (!takeReclaimMutex(mutexPath)) return false
  try {
    const current = readOwner(lockPath)
    if (current !== null && (current === owner || processAlive(current))) return false
    try {
      unlinkSync(lockPath)
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error
    }
    return createExclusive(lockPath, owner)
  } finally {
    rmdirSync(mutexPath)
  }
}

/** A port the kernel says is free right now. */
export function kernelPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new PortLockError('the kernel named no port'))
      })
    })
  })
}

export async function lockedPort({
  directory = path.join(process.env.TMPDIR || tmpdir(), LOCK_DIRECTORY_NAME),
  owner = process.ppid,
  nextPort = kernelPort,
} = {}) {
  mkdirSync(directory, { recursive: true })
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const port = await nextPort()
    if (claimPort(port, directory, owner)) return port
  }
  throw new PortLockError(`no unclaimed port after ${MAX_ATTEMPTS} attempts`)
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  lockedPort()
    .then((port) => {
      process.stdout.write(`${port}\n`)
    })
    .catch((error) => {
      process.stderr.write(`e2e-port: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
