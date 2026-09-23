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
  it('is unchanged for a single rail', () => {
    expect(registrySuffix(undefined)).toBe('')
    expect(highlightRegistryName('amber')).toBe(
      `${HIGHLIGHT_REGISTRY_PREFIX}amber`,
    )
  })

  it('separates two rails on one page', () => {
    const first = highlightRegistryName('amber', 'rail-1')
    const second = highlightRegistryName('amber', 'rail-2')

    expect(first).not.toBe(second)
    expect(first).toBe(`${HIGHLIGHT_REGISTRY_PREFIX}amber-rail-1`)
  })

  it('stays a usable CSS identifier whatever the namespace is', () => {
    // A document URI is the obvious thing a host will reach for.
    const name = highlightRegistryName(
      'amber',
      'https://ernie.sg/books/a/b#frag?q=1',
    )

    expect(name.startsWith(`${HIGHLIGHT_REGISTRY_PREFIX}amber-`)).toBe(true)
    expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
  })

  it('falls back to no suffix rather than a trailing dash', () => {
    // Everything sanitised away would otherwise leave `…amber-` — a different
    // key from `…amber`, and a silently separate registry entry.
    expect(registrySuffix('')).toBe('')
    expect(highlightRegistryName('amber', '   ')).toBe(
      `${HIGHLIGHT_REGISTRY_PREFIX}amber----`,
    )
  })
})
