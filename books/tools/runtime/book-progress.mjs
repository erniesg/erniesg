/**
 * Progress on a page: record what the reader solved and what they typed, show
 * it, and hand it to whatever keeps it.
 *
 * The keeping is the host's business. `backend` is two async functions:
 *
 *   load()          -> progress                  (never throws; empty when unknown)
 *   save(progress)  -> progress | null           (the stored copy, if the store merged in more)
 *
 * plus an optional `describe()` for the status line. The preview's backend
 * posts to its own `/api/progress`; the site's keeps browser storage and, for
 * a signed-in reader, the margin service. This file knows neither.
 *
 * The page opts in by markup, so a page without a control simply has none:
 *
 *   [data-progress-items="id id"]  gets `data-progress-done` once every id is solved
 *   [data-progress-count]          reads "3/55 exercises · 1/30 challenges solved",
 *                                  from `data-exercise-ids` and `data-challenge-ids`
 *   [data-progress-solved]         reads "1/30 solved", from `data-challenge-ids`
 *   [data-progress-status]         says where progress is kept
 *   [data-progress-export]         downloads the progress file
 *   [data-progress-import]         opens `[data-progress-import-file]`, then merges it
 */
import { wireExercises } from './exercises.mjs'
import { acknowledge, counts, emptyProgress, markSolved, merge, normalize, setDraft } from './progress.mjs'

const DRAFT_SAVE_DELAY_MS = 800

const words = (value) => (value || '').split(/\s+/).filter(Boolean)

function exerciseId(section) {
  return (section.id || '').replace(/^ex-/, '')
}

/**
 * Every editor whose code is kept, by the id progress keys it under: an
 * inline exercise by its id, a graded challenge (the local preview's desk) by
 * its node id.
 */
function trackedEditors(root) {
  const found = []
  root.querySelectorAll('.exercise').forEach((section) => {
    const editor = section.querySelector('.editor')
    const id = exerciseId(section)
    if (editor && id) found.push({ id, editor })
  })
  root.querySelectorAll('.desk[data-node]').forEach((desk) => {
    const editor = desk.querySelector('.editor')
    if (editor && desk.dataset.node) found.push({ id: desk.dataset.node, editor })
  })
  return found
}

function paintSolved(root, progress) {
  const solved = new Set(progress.solved)
  root.querySelectorAll('.exercise').forEach((section) => {
    section.classList.toggle('solved', solved.has(exerciseId(section)))
  })
  root.querySelectorAll('[data-progress-items]').forEach((element) => {
    const ids = words(element.dataset.progressItems)
    const done = ids.length > 0 && ids.every((id) => solved.has(id))
    element.toggleAttribute('data-progress-done', done)
  })
  root.querySelectorAll('[data-progress-count]').forEach((element) => {
    const tally = counts(progress, {
      exercises: words(element.dataset.exerciseIds),
      challenges: words(element.dataset.challengeIds),
    })
    const parts = []
    if (tally.exercises.total) parts.push(`${tally.exercises.solved}/${tally.exercises.total} exercises`)
    if (tally.challenges.total) parts.push(`${tally.challenges.solved}/${tally.challenges.total} challenges`)
    element.textContent = parts.length ? `${parts.join(' · ')} solved` : ''
  })
  // The bars' short count, as the preview's top bar reads: challenges only.
  root.querySelectorAll('[data-progress-solved]').forEach((element) => {
    const tally = counts(progress, { challenges: words(element.dataset.challengeIds) })
    element.textContent = `${tally.challenges.solved}/${tally.challenges.total} solved`
  })
}

/**
 * Put saved code back, but only into an editor the reader has not typed in on
 * this page: progress can arrive after they have started, and their keystrokes
 * win. Code this page put there itself (an earlier restore) is not theirs, so a
 * newer draft from an import still replaces it.
 */
function restoreDrafts(editors, progress, typed, guard) {
  editors.forEach(({ id, editor }) => {
    const draft = progress.drafts[id]
    if (!draft || typed.has(editor) || draft.code === editor.value) return
    guard(() => {
      editor.value = draft.code
      // The highlighter and line numbers repaint on input.
      editor.dispatchEvent(new Event('input'))
    })
  })
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function startProgress({
  root = document,
  book,
  backend,
  now = () => new Date().toISOString(),
}) {
  // Exercises are wired before progress arrives, so a reader who clicks Check
  // straight away is never ignored; what loads later is merged in.
  let progress = emptyProgress(book)
  let restoring = false
  const editors = trackedEditors(root)
  // Editors the reader has typed in on this page.
  const typed = new WeakSet()
  let timer = null
  const statusLines = [...root.querySelectorAll('[data-progress-status]')]
  const describe = () => backend.describe?.() ?? ''
  // What just happened ("Imported: 2 newly solved."), shown beside where
  // progress is kept until the reader does something else.
  let note = ''
  const show = () => {
    const text = [note, describe()].filter(Boolean).join(' ')
    statusLines.forEach((line) => { line.textContent = text })
  }

  const guard = (change) => {
    restoring = true
    try { change() } finally { restoring = false }
  }

  async function persist() {
    timer = null
    const stored = await backend.save(progress)
    if (stored) {
      progress = acknowledge(progress, normalize(stored, book))
      paintSolved(root, progress)
      restoreDrafts(editors, progress, typed, guard)
    }
    show()
  }

  // A save waiting on its short delay is written now, before the page goes:
  // a reload, a closed tab or a link followed straight after typing.
  const listening = new AbortController()
  function flush() {
    if (!timer) return
    clearTimeout(timer)
    void persist()
  }
  window.addEventListener('pagehide', flush, { signal: listening.signal })
  document.addEventListener(
    'visibilitychange',
    () => { if (document.visibilityState === 'hidden') flush() },
    { signal: listening.signal },
  )

  function update(next, { soon = false } = {}) {
    if (next === progress) return
    progress = next
    paintSolved(root, progress)
    if (timer) clearTimeout(timer)
    timer = setTimeout(persist, soon ? 0 : DRAFT_SAVE_DELAY_MS)
  }

  wireExercises(root, {
    onResult: ({ id, allOk }) => {
      note = ''
      if (allOk) update(markSolved(progress, id, now()), { soon: true })
    },
  })
  // A challenge whose four tiers went green, from whichever grader the host
  // runs (the preview's server, or Python in the site's browser).
  root.addEventListener('book:challenge-graded', (event) => {
    const { id, ok } = event.detail || {}
    note = ''
    if (ok && id) update(markSolved(progress, id, now()), { soon: true })
  }, { signal: listening.signal })
  editors.forEach(({ id, editor }) => {
    editor.addEventListener('input', () => {
      if (restoring) return
      typed.add(editor)
      note = ''
      update(setDraft(progress, id, editor.value, now()))
    })
  })

  root.querySelectorAll('[data-progress-export]').forEach((button) => {
    button.addEventListener('click', () => {
      download(`book-progress-${book}.json`, `${JSON.stringify(progress, null, 2)}\n`)
    })
  })
  root.querySelectorAll('[data-progress-import]').forEach((button) => {
    const input = button.parentElement?.querySelector('[data-progress-import-file]')
    if (!input) return
    button.addEventListener('click', () => input.click())
    input.addEventListener('change', async () => {
      const [file] = input.files || []
      input.value = ''
      if (!file) return
      let raw
      try {
        raw = JSON.parse(await file.text())
      } catch {
        note = 'That file is not a progress file.'
        show()
        return
      }
      // A file that names another book is refused, not re-keyed: ids can
      // overlap between books. A file naming no book (the preview's older
      // format) is taken as this one's.
      if (raw && typeof raw.book === 'string' && raw.book && raw.book !== book) {
        note = `That file is progress for another book (${raw.book}).`
        show()
        return
      }
      const imported = normalize(raw, book)
      const before = progress.solved.length
      const next = merge(progress, imported)
      update(next, { soon: true })
      restoreDrafts(editors, progress, typed, guard)
      note = `Imported: ${progress.solved.length - before} newly solved.`
      show()
    })
  })

  // Loaded first, merged after: whatever was solved while the load was in
  // flight is in `progress` by then, and must not be merged away.
  const stored = normalize(await backend.load(), book)
  progress = merge(progress, stored)
  paintSolved(root, progress)
  restoreDrafts(editors, progress, typed, guard)
  show()

  return {
    current: () => progress,
    /** Write any pending save now; for hosts that change page without unloading. */
    flush,
    /** Flush, then stop listening; the page is being replaced. */
    stop() {
      flush()
      listening.abort()
    },
  }
}
