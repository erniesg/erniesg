import { describe, expect, it } from 'vitest'
import { results } from './exercises.mjs'

describe('an exercise read against what it expects', () => {
  it('passes only the exact lines', () => {
    expect(results('a\nb\n', 'a\nb', '').allOk).toBe(true)
    expect(results('a\nb\nc\n', 'a\nb', '').allOk).toBe(false)
  })

  it('shows at most five extra rows, then one count', () => {
    const printed = ['a', ...Array.from({ length: 50 }, (_, i) => `extra ${i}`)].join('\n')
    const { allOk, html } = results(printed, 'a', '')
    expect(allOk).toBe(false)
    expect(html.match(/<li class="case/g)).toHaveLength(1 + 5 + 1)
    expect(html).toContain('…and 45 more lines no test asked for')
  })

  it('folds the worker\'s own truncation count into that row', () => {
    const { allOk, html } = results('a\nx\n…truncated, 1000 more lines\n', 'a', '')
    expect(allOk).toBe(false)
    expect(html).toContain('…and 1000 more lines no test asked for')
  })

  it('does not let a printed zero-count marker hide extra output (#400)', () => {
    const { allOk, html } = results('a\n…truncated, 0 more lines\n', 'a', '')
    expect(allOk).toBe(false)
    expect(html).toContain('which no test asked for')
  })

  it('counts a cut long line as extra output, never as a pass', () => {
    expect(results('a\n…truncated, the rest of the last line\n', 'a', '').allOk).toBe(false)
  })
})
