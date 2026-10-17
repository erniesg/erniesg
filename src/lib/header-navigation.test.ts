import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  SITE_LOCALE_CHANGE_EVENT,
  SITE_LOCALE_STORAGE_KEY,
} from './site-preferences'
import { getCurrentLocalePreference, useSiteLocale } from './use-site-locale'

const header = readFileSync(
  new URL('../components/Header.astro', import.meta.url),
  'utf8',
)

vi.mock('react', () => ({
  useState: () => ['en', vi.fn()],
  useEffect: (effect: () => void) => effect(),
}))

afterEach(() => vi.unstubAllGlobals())

describe('persisted header navigation', () => {
  it('persists one header without independently moving its controls', () => {
    expect(header.match(/transition:persist/g)).toHaveLength(1)
    expect(header).toContain('transition:persist="site-header"')
    expect(header).toContain('<LanguageToggle client:load />')
    expect(header).toContain('<ModeToggle client:load />')
  })

  it('prefers an article route locale to an older stored preference', () => {
    vi.stubGlobal('window', {
      location: { pathname: '/blog/loss-price-love/zh/' },
    })
    vi.stubGlobal('localStorage', { getItem: () => 'en' })
    expect(getCurrentLocalePreference()).toBe('zh')
    window.location.pathname = '/blog/'
    expect(getCurrentLocalePreference()).toBe('en')
  })

  it('publishes a first visitor browser preference to the rest of the toolbar', () => {
    const dispatchEvent = vi.fn()
    const setItem = vi.fn()
    vi.stubGlobal('navigator', { languages: ['zh-SG'], language: 'zh-SG' })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem })
    vi.stubGlobal(
      'CustomEvent',
      class {
        constructor(
          public type: string,
          public options: unknown,
        ) {}
      },
    )
    vi.stubGlobal('window', {
      location: { pathname: '/' },
      dispatchEvent,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    useSiteLocale()
    expect(setItem).toHaveBeenCalledWith(SITE_LOCALE_STORAGE_KEY, 'zh')
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SITE_LOCALE_CHANGE_EVENT,
        options: { detail: { locale: 'zh' } },
      }),
    )
  })

  it('can replay the inline script without redeclarations or duplicate listeners', () => {
    const listeners = new Map<string, Function[]>()
    const addEventListener = (name: string, listener: Function) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
    }
    const context = vm.createContext({
      window: {},
      document: { currentScript: { dataset: {} }, addEventListener },
      Set,
      JSON,
    })
    const script = header.slice(
      header.indexOf('>\n', header.indexOf('<script')) + 2,
      header.indexOf('</script>'),
    )
    vm.runInContext(script, context)
    vm.runInContext(script, context)
    expect(listeners.get('astro:page-load')).toHaveLength(1)
  })
})
