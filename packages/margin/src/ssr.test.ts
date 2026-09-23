import { describe, expect, it } from 'vitest'

/**
 * `react.tsx` imports `./element` statically, so an SSR build evaluates that
 * module in Node — where `HTMLElement` does not exist. The class declaration threw
 * a `ReferenceError` at import time, before React reached a `useEffect`, which
 * made the optional React entry unusable in every SSR framework.
 *
 * This file runs in Node with no DOM, which is exactly the failing environment.
 */
describe('importing the package without a DOM', () => {
  it('has no HTMLElement to extend, which is the case under test', () => {
    expect((globalThis as { HTMLElement?: unknown }).HTMLElement).toBeUndefined()
  })

  it('imports the element module without throwing', async () => {
    const module = await import('./element')

    expect(module.MARGIN_RAIL_TAG).toBe('margin-rail')
    expect(typeof module.MarginRailElement).toBe('function')
  })

  it('imports the React entry without throwing', async () => {
    const module = await import('./react')

    expect(typeof module.MarginRail).toBe('function')
  })

  it('defines nothing without a custom element registry', async () => {
    const { defineMarginElements } = await import('./element')

    // The server condition: no registry, so nothing is registered and nothing is
    // constructed. It must not throw either.
    expect(() => defineMarginElements(undefined)).not.toThrow()
  })
})
