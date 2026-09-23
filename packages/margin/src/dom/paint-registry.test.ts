import { describe, expect, it } from 'vitest'
import {
  HIGHLIGHT_REGISTRY_PREFIX,
  highlightRegistryName,
  registrySuffix,
} from './paint'

/**
 * `CSS.highlights` is per document, so two rails on one page — two embedded
 * documents, or a rail beside a preview — wrote the same key. Rendering the
 * second replaced the first's ranges, and clearing either deleted the other's
 * highlight.
 *
 * The DOM wiring is covered by `tests/e2e/margin-anchoring.spec.ts`, because this
 * repository has no DOM test environment. The naming is covered here, because
 * that is the part a future edit is most likely to break.
 */
describe('the highlight registry key', () => {
  it('uses a stable name for a single rail', () => {
    expect(registrySuffix(undefined)).toBe('')
    expect(highlightRegistryName('amber')).toBe(highlightRegistryName('amber'))
    expect(highlightRegistryName('amber')).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
  })

  it('separates two rails on one page', () => {
    const first = highlightRegistryName('amber', 'rail-1')
    const second = highlightRegistryName('amber', 'rail-2')

    expect(first).not.toBe(second)
    expect(first.startsWith(HIGHLIGHT_REGISTRY_PREFIX)).toBe(true)
  })

  it('stays a usable CSS identifier whatever the namespace is', () => {
    // A document URI is the obvious thing a host will reach for.
    const name = highlightRegistryName(
      'amber',
      'https://ernie.sg/books/a/b#frag?q=1',
    )

    expect(name.startsWith(HIGHLIGHT_REGISTRY_PREFIX)).toBe(true)
    expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
  })

  it('uses no suffix for an empty namespace', () => {
    expect(registrySuffix('')).toBe('')
    expect(highlightRegistryName('amber', '')).toBe(highlightRegistryName('amber'))
  })

  it('encodes arbitrary palette keys and namespaces without collisions', () => {
    const pairs: [string, string | undefined][] = [
      ['brand.yellow', 'rail'],
      ['brand yellow', 'rail'],
      ['brand-yellow', 'rail'],
      ['soft amber', 'rail'],
      ['色', 'rail'],
      ['amber', 'brand.yellow'],
      ['amber', 'brand yellow'],
      ['amber', 'brand-yellow'],
      ['amber-rail', undefined],
      ['amber', 'rail'],
      ['a-b', 'c'],
      ['a', 'b-c'],
    ]
    const names = pairs.map(([color, namespace]) =>
      highlightRegistryName(color, namespace),
    )
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
    }
  })
})
