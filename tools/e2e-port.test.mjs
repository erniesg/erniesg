import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { LOCK_DIRECTORY_NAME, PortLockError, claimPort, lockedPort } from './e2e-port.mjs'

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e-port.mjs')
const scratch = []

function scratchDir() {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-port-'))
  scratch.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    try {
      chmodSync(directory, 0o755)
    } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A PID that is certainly not running: a child that has already exited. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])
  return Number(child.stdout.toString())
}

function runHelper(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HELPER], { env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('claimPort', () => {
  it('claims a free port and records the owner', () => {
    const directory = scratchDir()
    expect(claimPort(4100, directory, process.pid)).toBe(true)
    expect(readFileSync(path.join(directory, '4100.lock'), 'utf8').trim()).toBe(String(process.pid))
  })

  it('leaves a port held by a live process alone', () => {
    const directory = scratchDir()
    writeFileSync(path.join(directory, '4101.lock'), `${process.pid}\n`)
    expect(claimPort(4101, directory, 999_999)).toBe(false)
  })

  it('reclaims a lock whose owner has exited', () => {
    const directory = scratchDir()
    writeFileSync(path.join(directory, '4102.lock'), `${deadPid()}\n`)
    expect(claimPort(4102, directory, process.pid)).toBe(true)
    expect(readFileSync(path.join(directory, '4102.lock'), 'utf8').trim()).toBe(String(process.pid))
  })

  it('lets only one of two reclaimers that saw the same dead owner win the port', () => {
    const directory = scratchDir()
    const lock = path.join(directory, '4104.lock')
    writeFileSync(lock, `${deadPid()}\n`)
    // The slow reclaimer has read the dead owner and is about to reclaim. At
    // that moment the fast one reclaims the port completely.
    let fast = null
    const slow = claimPort(4104, directory, 999_998, {
      beforeReclaim: () => {
        fast = claimPort(4104, directory, process.pid)
      },
    })
    expect(fast).toBe(true)
    expect(slow).toBe(false)
    expect(readFileSync(lock, 'utf8').trim()).toBe(String(process.pid))
  })

  it('stands down while another reclaimer holds the port, and clears a stale mutex', () => {
    const directory = scratchDir()
    writeFileSync(path.join(directory, '4105.lock'), `${deadPid()}\n`)
    mkdirSync(path.join(directory, '4105.reclaim'))
    expect(claimPort(4105, directory, process.pid)).toBe(false)
    const old = new Date(Date.now() - 60_000)
    utimesSync(path.join(directory, '4105.reclaim'), old, old)
    expect(claimPort(4105, directory, process.pid)).toBe(false)
    expect(claimPort(4105, directory, process.pid)).toBe(true)
  })

  it('refuses a corrupt lock rather than guessing', () => {
    const directory = scratchDir()
    writeFileSync(path.join(directory, '4103.lock'), 'not a pid')
    expect(() => claimPort(4103, directory, process.pid)).toThrow(PortLockError)
  })
})

describe('lockedPort', () => {
  it('asks again when the kernel names a port a live run holds', async () => {
    const directory = scratchDir()
    writeFileSync(path.join(directory, '5000.lock'), `${process.pid}\n`)
    const offers = [5000, 5001]
    const port = await lockedPort({ directory, owner: 1, nextPort: async () => offers.shift() })
    expect(port).toBe(5001)
  })
})

describe('the command', () => {
  it('prints distinct ports for two concurrent calls sharing one lock directory', async () => {
    const tmp = scratchDir()
    const [first, second] = await Promise.all([
      runHelper({ TMPDIR: tmp }),
      runHelper({ TMPDIR: tmp }),
    ])
    expect(first.code).toBe(0)
    expect(second.code).toBe(0)
    const ports = [first.stdout.trim(), second.stdout.trim()]
    for (const port of ports) expect(port).toMatch(/^[1-9][0-9]*$/)
    expect(new Set(ports).size).toBe(2)
    for (const port of ports) {
      expect(readFileSync(path.join(tmp, LOCK_DIRECTORY_NAME, `${port}.lock`), 'utf8').trim()).toMatch(
        /^[1-9][0-9]*$/,
      )
    }
  })

  it('exits non-zero with nothing on stdout when the lock directory is unwritable', async () => {
    if (process.getuid && process.getuid() === 0) return // root writes anywhere
    const tmp = scratchDir()
    chmodSync(tmp, 0o500)
    const result = await runHelper({ TMPDIR: tmp })
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/e2e-port:/)
  })
})
