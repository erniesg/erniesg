/**
 * Reading order and chapter progress, in the browser.
 *
 * `render.py` writes the markup (`reading_navigation`): the pager, and the
 * chapter progress indicator with one segment per section and per practice
 * challenge. This module is its behaviour, the same on the local preview and
 * on both looks of the published site:
 *
 *   [ and ]   previous and next page in reading order (clicks the page's own
 *             rel=prev / rel=next link, so the site's client router keeps the
 *             look, the theme and the split view)
 *   j and k   next and previous section heading on this page
 *   ?         the list of shortcuts
 *
 * `[` and `]` rather than Alt with the arrows: Alt+Left is the browser's Back
 * on Windows and Linux, and the margin's keyboard selection mode owns the
 * plain arrows. Brackets are printable, so every shortcut stands down while
 * the reader is typing: in a field, in the code editor, in a contenteditable,
 * inside the margin rail or its popup, or while the margin's keyboard
 * selection is running.
 *
 * Plain JavaScript with no imports, so the preview can inline it as-is and the
 * site can bundle it.
 */

export const SHORTCUTS = [
  ['[', 'Previous page'],
  [']', 'Next page'],
  ['j', 'Next section'],
  ['k', 'Previous section'],
  ['?', 'Show or hide these shortcuts'],
  ['Esc', 'Close this list'],
]

const TYPING =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .cm-editor, margin-rail, [data-margin-popup]'

/** The margin's keyboard selection marks the block it is walking with this. */
const MARGIN_KEYBOARD = '[data-margin-keyboard-cursor]'

/** What a key press asks for, or null when it is not ours to take. */
export function shortcutFor(event) {
  if (!event || event.defaultPrevented || event.isComposing) return null
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  switch (event.key) {
    case '[':
      return 'prev'
    case ']':
      return 'next'
    case 'j':
      return 'section-next'
    case 'k':
      return 'section-prev'
    case '?':
      return 'help'
    default:
      return null
  }
}

/** True while the reader is typing, or the margin is using the keyboard. */
export function isTypingContext(event, doc) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const node of path) {
    if (node && typeof node.matches === 'function' && node.matches(TYPING)) return true
  }
  let active = doc?.activeElement ?? null
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  if (active && typeof active.closest === 'function' && active.closest(TYPING)) return true
  if (active && active.isContentEditable) return true
  return Boolean(doc?.querySelector?.(MARGIN_KEYBOARD))
}

/** The indicator's words, the same ones `render.py`'s `nav_status` writes. */
export function statusText({ kind, section, sections, practice, total, solved }) {
  const parts = []
  if (kind === 'concept' && sections) parts.push(`Section ${section} of ${sections}`)
  if (kind === 'challenge') parts.push(`Practice ${practice} of ${total}`)
  if (total) {
    const lead = kind === 'concept' && sections ? 'practice ' : ''
    parts.push(`${lead}${solved}/${total} solved`)
  }
  return parts.join(' · ')
}

/**
 * Which section the reader is in: the last heading whose top has passed the
 * reading line. Before the first heading, the first; scrolled to the end, the
 * last, because a short final section never reaches the line.
 */
export function sectionIndex(tops, line, atEnd = false) {
  if (!tops.length) return -1
  if (atEnd) return tops.length - 1
  let index = 0
  tops.forEach((top, position) => {
    if (top <= line) index = position
  })
  return index
}

/**
 * The heading `j` or `k` moves to, or -1 at either end. `line` is the reading
 * line (`sectionIndex`'s); `pinned` is the bottom of whatever is pinned to the
 * top, where a heading scrolled into view comes to rest. `j` goes to the next
 * section. `k` goes back to the start of this one, or to the previous section
 * when the reader is already at this one's start.
 */
export function nextHeading(tops, line, direction, pinned = line) {
  if (!tops.length) return -1
  const current = tops[0] > line ? -1 : sectionIndex(tops, line)
  if (direction > 0) return current + 1 < tops.length ? current + 1 : -1
  if (current < 0) return -1
  const atStart = tops[current] >= pinned - 8
  const target = atStart ? current - 1 : current
  return target >= 0 ? target : -1
}

function reducedMotion(view) {
  return Boolean(view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

function indicator(doc) {
  return doc.querySelector('[data-chapter-progress]')
}

/** The page's own headings for the indicator's sections, in page order. */
function pageHeadings(doc, progress) {
  if (!progress) return []
  return [...progress.querySelectorAll('[data-cp-section]')]
    .map((segment) => ({
      segment,
      heading: doc.getElementById(segment.getAttribute('data-cp-section') ?? ''),
    }))
    .filter((entry) => entry.heading && entry.segment.getAttribute('href')?.startsWith('#'))
}

/** The bottom of whatever is pinned to the top: the bar that carries the indicator. */
function pinnedBottom(doc) {
  const progress = indicator(doc)
  const bar = progress?.closest('[data-book-bar], header.top') ?? progress
  return bar ? Math.max(bar.getBoundingClientRect().bottom, 0) : 0
}

/**
 * The reading line: a little under the pinned bar. A heading brought into
 * view comes to rest just below the bar (`scroll-margin-top`), so it is the
 * current section as soon as it lands there, whether the reader scrolled or
 * pressed `j`.
 */
const LINE_BELOW_BAR = 48

function readingLine(doc) {
  return pinnedBottom(doc) + LINE_BELOW_BAR
}

function scrolledToEnd(heading, view) {
  let box = heading.parentElement
  while (box && box !== heading.ownerDocument.body) {
    const style = view.getComputedStyle(box)
    if (/(auto|scroll)/.test(style.overflowY) && box.scrollHeight > box.clientHeight + 2) {
      return box.scrollTop + box.clientHeight >= box.scrollHeight - 2
    }
    box = box.parentElement
  }
  const root = heading.ownerDocument.scrollingElement
  return root ? root.scrollTop + view.innerHeight >= root.scrollHeight - 2 : false
}

function paint(doc, view) {
  const progress = indicator(doc)
  if (!progress) return
  const kind = progress.getAttribute('data-kind') ?? 'none'
  const sections = [...progress.querySelectorAll('[data-cp-section]')]
  const practice = [...progress.querySelectorAll('[data-cp-practice]')]
  const solved = practice.filter((segment) => segment.hasAttribute('data-progress-done'))
  for (const segment of practice) {
    const note = segment.querySelector('[data-cp-solved-note]')
    if (note) note.textContent = segment.hasAttribute('data-progress-done') ? ' (solved)' : ''
  }

  let section = 1
  if (kind === 'concept') {
    const entries = pageHeadings(doc, progress)
    if (entries.length) {
      const line = readingLine(doc)
      const tops = entries.map((entry) => entry.heading.getBoundingClientRect().top)
      const last = entries[entries.length - 1].heading
      const current = sectionIndex(tops, line, scrolledToEnd(last, view))
      entries.forEach((entry, position) => {
        entry.segment.toggleAttribute('data-cp-read', position < current)
        if (position === current) entry.segment.setAttribute('aria-current', 'location')
        else entry.segment.removeAttribute('aria-current')
      })
      section = current + 1
    }
  }
  const here = practice.findIndex((segment) => segment.getAttribute('aria-current') === 'page')
  const status = progress.querySelector('[data-cp-status]')
  if (status) {
    const text = statusText({
      kind,
      section,
      sections: sections.length,
      practice: here + 1,
      total: practice.length,
      solved: solved.length,
    })
    if (status.textContent !== text) status.textContent = text
  }
}

/**
 * Keep this page's indicator true: the section in view, and the practice the
 * reader has solved (the progress runtime marks `[data-progress-items]`).
 * Returns a stop function; a client router calls it before the next page.
 */
export function trackChapterProgress(doc = document) {
  const view = doc.defaultView
  const progress = indicator(doc)
  if (!progress || !view) return () => {}
  let frame = 0
  const schedule = () => {
    if (frame) return
    frame = view.requestAnimationFrame(() => {
      frame = 0
      paint(doc, view)
    })
  }
  const stops = []
  const entries = pageHeadings(doc, progress)
  if (entries.length && 'IntersectionObserver' in view) {
    const observer = new view.IntersectionObserver(schedule, {
      threshold: [0, 1],
      rootMargin: '0px 0px -60% 0px',
    })
    entries.forEach((entry) => observer.observe(entry.heading))
    stops.push(() => observer.disconnect())
  }
  // Scroll events do not bubble, but they do pass through the capture phase,
  // so this also hears the split view's panes.
  doc.addEventListener('scroll', schedule, { capture: true, passive: true })
  view.addEventListener('resize', schedule, { passive: true })
  view.addEventListener('hashchange', schedule)
  stops.push(() => {
    doc.removeEventListener('scroll', schedule, { capture: true })
    view.removeEventListener('resize', schedule)
    view.removeEventListener('hashchange', schedule)
  })
  const solvedObserver = new view.MutationObserver(schedule)
  solvedObserver.observe(progress, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-progress-done'],
  })
  stops.push(() => solvedObserver.disconnect())
  paint(doc, view)
  return () => {
    if (frame) view.cancelAnimationFrame(frame)
    stops.forEach((stop) => stop())
  }
}

function helpSheet(doc) {
  let sheet = doc.querySelector('[data-book-keys]')
  if (sheet) return sheet
  sheet = doc.createElement('div')
  sheet.className = 'book-keys'
  sheet.setAttribute('data-book-keys', '')
  sheet.hidden = true
  const panel = doc.createElement('div')
  panel.className = 'book-keys-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-labelledby', 'book-keys-title')
  panel.tabIndex = -1
  const title = doc.createElement('h2')
  title.id = 'book-keys-title'
  title.textContent = 'Keyboard shortcuts'
  const list = doc.createElement('dl')
  for (const [key, action] of SHORTCUTS) {
    const term = doc.createElement('dt')
    const kbd = doc.createElement('kbd')
    kbd.textContent = key
    term.append(kbd)
    const description = doc.createElement('dd')
    description.textContent = action
    list.append(term, description)
  }
  const note = doc.createElement('p')
  note.textContent = 'They wait while you type in the editor or select text for the margin.'
  note.style.margin = '.7rem 0 0'
  note.style.opacity = '.75'
  const close = doc.createElement('button')
  close.type = 'button'
  close.textContent = 'Close'
  close.setAttribute('data-book-keys-close', '')
  panel.append(title, list, note, close)
  sheet.append(panel)
  doc.body.append(sheet)
  return sheet
}

let returnFocus = null

/** While the sheet is open everything else on the page is inert, so it is a real modal. */
function setBackgroundInert(doc, sheet, inert) {
  for (const element of doc.body.children) {
    if (element === sheet) continue
    if (inert) {
      if (element.hasAttribute('inert')) continue
      element.setAttribute('inert', '')
      element.setAttribute('data-book-keys-inert', '')
    } else if (element.hasAttribute('data-book-keys-inert')) {
      element.removeAttribute('inert')
      element.removeAttribute('data-book-keys-inert')
    }
  }
}

function setHelp(doc, open) {
  const sheet = helpSheet(doc)
  if (open === !sheet.hidden) return
  if (open) {
    returnFocus = doc.activeElement
    sheet.hidden = false
    setBackgroundInert(doc, sheet, true)
    sheet.querySelector('[data-book-keys-close]')?.focus()
  } else {
    sheet.hidden = true
    setBackgroundInert(doc, sheet, false)
    if (returnFocus && typeof returnFocus.focus === 'function' && returnFocus.isConnected) {
      returnFocus.focus()
    }
    returnFocus = null
  }
}

/**
 * The heading the last `j` or `k` went to, while its smooth scroll may still
 * be moving: a quick second press steps on from there rather than re-reading
 * positions in mid-flight, which would land on the same heading again.
 */
let lastMove = null
const SETTLE_MS = 1000

function moveSection(doc, direction) {
  const view = doc.defaultView
  const scope =
    doc.querySelector('[data-reading-column="text"]') ?? doc.querySelector('main article') ?? doc
  const headings = [...scope.querySelectorAll('h2[id]')].filter(
    (heading) => heading.getClientRects().length > 0,
  )
  if (!headings.length) return false
  const recent =
    lastMove && Date.now() - lastMove.at < SETTLE_MS ? headings.indexOf(lastMove.heading) : -1
  let index
  if (recent >= 0) {
    index = recent + direction
    if (index < 0 || index >= headings.length) return false
  } else {
    const tops = headings.map((heading) => heading.getBoundingClientRect().top)
    index = nextHeading(tops, readingLine(doc), direction, pinnedBottom(doc))
    if (index < 0) return false
  }
  const heading = headings[index]
  lastMove = { heading, at: Date.now() }
  heading.scrollIntoView({ block: 'start', behavior: reducedMotion(view) ? 'auto' : 'smooth' })
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
  heading.focus({ preventScroll: true })
  return true
}

function follow(doc, rel) {
  const link =
    doc.querySelector(`a[data-book-${rel}]`) ?? doc.querySelector(`a[rel="${rel}"][href]`)
  if (!link) return false
  link.click()
  return true
}

/**
 * The shortcuts, installed once per document. They read the page at the
 * moment of the key press, so a client router swapping the page needs no
 * reinstall.
 */
export function installBookKeys(doc = document) {
  if (doc.documentElement.hasAttribute('data-book-keys-installed')) return
  doc.documentElement.setAttribute('data-book-keys-installed', '')
  doc.addEventListener('keydown', (event) => {
    const sheet = doc.querySelector('[data-book-keys]')
    if (sheet && !sheet.hidden) {
      if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault()
        setHelp(doc, false)
      } else if (event.key === 'Tab') {
        // One control inside: focus stays on it.
        event.preventDefault()
        sheet.querySelector('[data-book-keys-close]')?.focus()
      }
      return
    }
    // The listener outlives a client-router swap to a page that is not the
    // book; there, it is not ours to take any key.
    if (!doc.querySelector('[data-chapter-progress]')) return
    const action = shortcutFor(event)
    if (!action) return
    if (isTypingContext(event, doc)) return
    let handled = false
    if (action === 'prev' || action === 'next') handled = follow(doc, action)
    else if (action === 'section-next') handled = moveSection(doc, 1)
    else if (action === 'section-prev') handled = moveSection(doc, -1)
    else if (action === 'help') {
      setHelp(doc, Boolean(doc.querySelector('[data-book-keys]')?.hidden ?? true))
      handled = true
    }
    if (handled) event.preventDefault()
  })
  doc.addEventListener('click', (event) => {
    const target = event.target
    if (!(target && typeof target.closest === 'function')) return
    if (target.closest('[data-book-keys-toggle]')) {
      const sheet = doc.querySelector('[data-book-keys]')
      setHelp(doc, !sheet || sheet.hidden)
    } else if (target.closest('[data-book-keys-close]')) {
      setHelp(doc, false)
    } else if (target.matches?.('[data-book-keys]')) {
      setHelp(doc, false)
    }
  })
}
