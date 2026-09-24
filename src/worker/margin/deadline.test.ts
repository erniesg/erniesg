import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settleWithin, timeoutSignal } from './deadline'

/**
 * The rule: no auth test waits on a real timeout.
 *
 * Every bound in the worker runs on `setTimeout`, which a test can make
 * virtual. `AbortSignal.timeout` runs on a clock a test cannot drive, so it is
 * not used. Any test file that shortens a provider or key-set bound drives it
 * with fake timers, so a loaded CI machine cannot push a test past a bound it
 * did not mean to cross.
 */
function sources(dir: string, test: boolean): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sources(full, test))
    else if (
      entry.name.endsWith('.ts') &&
      entry.name.endsWith('.test.ts') === test
    ) {
      found.push(full)
    }
  }
  return found
}

const worker = resolve('src/worker')

describe('no auth test waits on a real timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('bounds nothing in the worker with AbortSignal.timeout', () => {
    const offenders = sources(worker, false).filter((file) =>
      readFileSync(file, 'utf8').includes('AbortSignal.timeout('),
    )
    expect(offenders).toEqual([])
  })

  it('drives every shortened bound in a test with fake timers', () => {
    const offenders = sources(worker, true).filter((file) => {
      const text = readFileSync(file, 'utf8')
      return (
        /\b(?:providerTimeoutMs|fetchTimeoutMs)\s*:/u.test(text) &&
        !text.includes('vi.useFakeTimers(')
      )
    })
    expect(offenders).toEqual([])
  })

  it('fires timeoutSignal and settleWithin on virtual time only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const signal = timeoutSignal(5_000)
    const waited = settleWithin(new Promise(() => {}), 5_000)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signal.aborted).toBe(true)
    await expect(waited).resolves.toEqual({ settled: false })
  })
})
