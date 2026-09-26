/**
 * Making a selection without a pointer.
 *
 * Shift+arrow extends a selection only in editable content — or in prose when
 * the browser's caret browsing is on, which most readers have never heard of
 * and which Chromium cannot switch on from a page. So a reader with only a
 * keyboard had no way to select a sentence in a book at all, and everything
 * the margin does starts with a selection.
 *
 * This is the missing path. It moves a caret block by block and extends the
 * selection with `Selection.modify` — the call the browser's own shift+arrow
 * handler makes, and the one a screen reader makes — so the selection it
 * produces is an ordinary document selection. The margin's `selectionchange`
 * watcher sees it exactly as it sees a mouse drag; nothing downstream knows
 * the difference.
 */
import type { AnchorableBlock } from './blocks.js'

type ModifiableSelection = Selection & {
  modify?: (alter: string, direction: string, granularity: string) => void
}

export type KeyboardSelectionOptions = {
  blocks: () => readonly AnchorableBlock[]
  /** Fired when the reader asks for the selection to be annotated. */
  onCommit: () => void
  /** Fired when the reader leaves the mode. */
  onExit: () => void
}

export type KeyboardSelection = {
  /** The block the caret is in. */
  current(): AnchorableBlock | null
  stop(options?: { keepFocus?: boolean }): void
}

const CURSOR_ATTRIBUTE = 'data-margin-keyboard-cursor'

/**
 * A focus ring for the block the caret is in. It is an attribute for the time
 * the mode is on and removed after, so the book's markup is only ever changed
 * while a reader is actively selecting in it.
 */
function ensureCursorStyle(doc: Document) {
  if (doc.querySelector('style[data-margin-keyboard-style]')) return
  const style = doc.createElement('style')
  style.dataset.marginKeyboardStyle = ''
  style.textContent = `[${CURSOR_ATTRIBUTE}] { outline: 2px solid currentColor; outline-offset: 4px; }`
  doc.head.append(style)
}

function firstVisible(blocks: readonly AnchorableBlock[]): number {
  const index = blocks.findIndex((block) => {
    const rect = block.element.getBoundingClientRect()
    return rect.bottom > 0 && rect.height > 0
  })
  return index === -1 ? 0 : index
}

export function startKeyboardSelection(
  options: KeyboardSelectionOptions,
): KeyboardSelection | null {
  const blocks = options.blocks().filter((block) => block.text.trim())
  if (blocks.length === 0) return null
  const doc = blocks[0].element.ownerDocument
  ensureCursorStyle(doc)

  let index = firstVisible(blocks)
  let addedTabIndex: Element | null = null
  let stopped = false

  const place = (next: number) => {
    const previous = blocks[index]
    previous.element.removeAttribute(CURSOR_ATTRIBUTE)
    if (addedTabIndex) {
      addedTabIndex.removeAttribute('tabindex')
      addedTabIndex = null
    }
    index = Math.max(0, Math.min(blocks.length - 1, next))
    const block = blocks[index]
    block.element.setAttribute(CURSOR_ATTRIBUTE, '')
    if (!block.element.hasAttribute('tabindex')) {
      block.element.setAttribute('tabindex', '-1')
      addedTabIndex = block.element
    }
    ;(block.element as HTMLElement).focus({ preventScroll: true })
    block.element.scrollIntoView({ block: 'nearest' })
    const first = block.index.segments[0]
    const selection = doc.getSelection()
    if (first && selection) selection.collapse(first.node, 0)
  }

  const extend = (direction: 'forward' | 'backward', granularity: string) => {
    const selection = doc.getSelection() as ModifiableSelection | null
    if (!selection || typeof selection.modify !== 'function') return
    selection.modify('extend', direction, granularity)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // Only while the reader is in the text. Keys typed into the margin's own
    // controls — the popup, the search box — are theirs.
    if (!blocks[index].element.contains(doc.activeElement)) return
    const word = event.altKey || event.ctrlKey
    let handled = true
    if (event.key === 'Escape') {
      options.onExit()
    } else if (event.key === 'Enter') {
      options.onCommit()
    } else if (event.shiftKey && event.key === 'ArrowRight') {
      extend('forward', word ? 'word' : 'character')
    } else if (event.shiftKey && event.key === 'ArrowLeft') {
      extend('backward', word ? 'word' : 'character')
    } else if (event.shiftKey && event.key === 'ArrowDown') {
      extend('forward', 'line')
    } else if (event.shiftKey && event.key === 'ArrowUp') {
      extend('backward', 'line')
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const selection = doc.getSelection() as ModifiableSelection | null
      selection?.modify?.(
        'move',
        event.key === 'ArrowRight' ? 'forward' : 'backward',
        word ? 'word' : 'character',
      )
    } else if (event.key === 'ArrowDown') {
      place(index + 1)
    } else if (event.key === 'ArrowUp') {
      place(index - 1)
    } else {
      handled = false
    }
    if (handled) event.preventDefault()
  }

  doc.addEventListener('keydown', onKeyDown, true)
  place(index)

  return {
    current: () => (stopped ? null : blocks[index]),
    stop({ keepFocus = false } = {}) {
      if (stopped) return
      stopped = true
      doc.removeEventListener('keydown', onKeyDown, true)
      blocks[index].element.removeAttribute(CURSOR_ATTRIBUTE)
      if (addedTabIndex && !keepFocus) {
        addedTabIndex.removeAttribute('tabindex')
        addedTabIndex = null
      }
    },
  }
}

/**
 * Put the reader back where they were in the text: a caret at the end of what
 * they selected, and focus on the block that holds it, so their next Tab or
 * arrow continues from there rather than from the top of the page.
 *
 * The block needs a `tabindex` to take focus; one added here is removed again
 * as soon as focus leaves, so the markup is not left changed.
 */
export function returnFocusToText(block: Element, range: Range | null) {
  const doc = block.ownerDocument
  const added = !block.hasAttribute('tabindex')
  if (added) block.setAttribute('tabindex', '-1')
  ;(block as HTMLElement).focus({ preventScroll: true })
  if (range) {
    const selection = doc.getSelection()
    selection?.collapse(range.endContainer, range.endOffset)
  }
  if (added) {
    block.addEventListener('blur', () => block.removeAttribute('tabindex'), {
      once: true,
    })
  }
}
