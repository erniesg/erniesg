import { describe, expect, it } from 'vitest'

import {
  isTypingContext,
  nextHeading,
  sectionIndex,
  shortcutFor,
  statusText,
} from './book-nav.mjs'

const key = (value, extra = {}) => ({ key: value, ...extra })

describe('shortcutFor', () => {
  it('maps the brackets, j/k and ? to their actions', () => {
    expect(shortcutFor(key('['))).toBe('prev')
    expect(shortcutFor(key(']'))).toBe('next')
    expect(shortcutFor(key('j'))).toBe('section-next')
    expect(shortcutFor(key('k'))).toBe('section-prev')
    expect(shortcutFor(key('?', { shiftKey: true }))).toBe('help')
  })

  it('stands down for chords, handled events and composition', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      expect(shortcutFor(key(']', { [modifier]: true }))).toBeNull()
    }
    expect(shortcutFor(key(']', { defaultPrevented: true }))).toBeNull()
    expect(shortcutFor(key(']', { isComposing: true }))).toBeNull()
    expect(shortcutFor(key('J'))).toBeNull()
    expect(shortcutFor(key('ArrowRight'))).toBeNull()
  })
})

describe('isTypingContext', () => {
  const element = (selector) => ({ matches: (s) => s.split(', ').includes(selector) })
  const doc = (cursor = false, active = null) => ({
    activeElement: active,
    querySelector: (s) => (cursor && s === '[data-margin-keyboard-cursor]' ? {} : null),
  })

  it('is true inside a field, the editor or the margin', () => {
    for (const selector of ['textarea', 'input', '.cm-editor', 'margin-rail']) {
      expect(isTypingContext({ composedPath: () => [element(selector)] }, doc())).toBe(true)
    }
  })

  it('is true while the margin walks the text with the keyboard', () => {
    expect(isTypingContext({ composedPath: () => [] }, doc(true))).toBe(true)
  })

  it('is false on the page itself', () => {
    expect(isTypingContext({ composedPath: () => [element('p')] }, doc())).toBe(false)
  })
})

describe('statusText', () => {
  it('matches the words render.py writes', () => {
    expect(
      statusText({ kind: 'concept', section: 3, sections: 8, practice: 0, total: 2, solved: 1 }),
    ).toBe('Section 3 of 8 · practice 1/2 solved')
    expect(
      statusText({ kind: 'challenge', section: 1, sections: 8, practice: 2, total: 2, solved: 1 }),
    ).toBe('Practice 2 of 2 · 1/2 solved')
    expect(
      statusText({ kind: 'concept', section: 1, sections: 4, practice: 0, total: 0, solved: 0 }),
    ).toBe('Section 1 of 4')
  })
})

describe('sectionIndex', () => {
  it('is the last heading past the reading line', () => {
    expect(sectionIndex([100, 500, 900], 50)).toBe(0)
    expect(sectionIndex([-400, 120, 900], 200)).toBe(1)
    expect(sectionIndex([-900, -400, -10], 200)).toBe(2)
  })

  it('is the last section at the end of the page', () => {
    expect(sectionIndex([-900, 100, 700], 200, true)).toBe(2)
  })

  it('is -1 with no headings', () => {
    expect(sectionIndex([], 200)).toBe(-1)
  })
})

describe('nextHeading', () => {
  // The bar ends at 112; a heading scrolled into view rests at 124; the
  // reading line is at 160.
  const line = 160
  const pinned = 112

  it('goes from the opening prose to the first heading', () => {
    expect(nextHeading([400, 900], line, 1, pinned)).toBe(0)
    expect(nextHeading([400, 900], line, -1, pinned)).toBe(-1)
  })

  it('goes to the next section, and back from the start of one', () => {
    // Resting on section 2 (index 1), even with section 3 just below it.
    const tops = [-300, 124, 150, 900]
    expect(nextHeading(tops, line, 1, pinned)).toBe(3)
    expect(nextHeading([-300, 124, 400], line, 1, pinned)).toBe(2)
    expect(nextHeading([-300, 124, 400], line, -1, pinned)).toBe(0)
  })

  it('k in the middle of a long section goes to its start first', () => {
    expect(nextHeading([-900, -400, 700], line, -1, pinned)).toBe(1)
  })

  it('stops at either end', () => {
    expect(nextHeading([-900, -400, 124], line, 1, pinned)).toBe(-1)
    expect(nextHeading([124, 700], line, -1, pinned)).toBe(-1)
    expect(nextHeading([], line, 1, pinned)).toBe(-1)
  })
})
