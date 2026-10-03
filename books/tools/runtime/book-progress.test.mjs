import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startProgress } from './book-progress.mjs'

// The least of a page startProgress needs: a root it queries and listens on,
// and the window and document it listens to for unloads.
function fakeRoot() {
  const root = new EventTarget()
  root.querySelectorAll = () => []
  return root
}

beforeEach(() => {
  globalThis.window = new EventTarget()
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
})
afterEach(() => {
  delete globalThis.window
  delete globalThis.document
})

describe('startProgress', () => {
  it('keeps a challenge solved while progress was still loading', async () => {
    let release
    const loaded = new Promise((resolve) => { release = resolve })
    const saves = []
    const root = fakeRoot()
    const started = startProgress({
      root,
      book: 'build-a-coding-agent',
      now: () => '2026-09-29T00:00:00.000Z',
      backend: {
        load: () => loaded,
        save: async (progress) => { saves.push(progress); return null },
      },
    })
    // The grade finishes before the account answers.
    root.dispatchEvent(new CustomEvent('book:challenge-graded', { detail: { id: 'pool-ticket-price', ok: true } }))
    release({})
    const running = await started
    expect(running.current().solved).toContain('pool-ticket-price')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(saves.at(-1).solved).toContain('pool-ticket-price')
    running.stop()
  })

  it('fills the bars\' short count from the challenges solved', async () => {
    const count = { dataset: { challengeIds: 'pool-ticket-price recent-readings' }, textContent: '' }
    const root = fakeRoot()
    root.querySelectorAll = (selector) => (selector === '[data-progress-solved]' ? [count] : [])
    const running = await startProgress({
      root,
      book: 'build-a-coding-agent',
      now: () => '2026-09-29T00:00:00.000Z',
      backend: {
        load: async () => ({ solved: ['pool-ticket-price', 'some-exercise'] }),
        save: async () => null,
      },
    })
    expect(count.textContent).toBe('1/2 solved')
    running.stop()
  })
})
