const token = document.querySelector('meta[name="book-token"]').content

const elements = {
  articleEdition: document.querySelector('#article-edition'),
  badgeCount: document.querySelector('#badge-count'),
  bookContents: document.querySelector('#book-contents'),
  chapterContent: document.querySelector('#chapter-content'),
  chapterDeck: document.querySelector('#chapter-deck'),
  chapterList: document.querySelector('#chapter-list'),
  chapterNumber: document.querySelector('#chapter-number'),
  chapterPart: document.querySelector('#chapter-part'),
  chapterTitle: document.querySelector('#chapter-title'),
  codeEditor: document.querySelector('#code-editor'),
  consoleOutput: document.querySelector('#console-output'),
  contentsAuthor: document.querySelector('#contents-author'),
  contentsButton: document.querySelector('#contents-button'),
  contentsDescription: document.querySelector('#contents-description'),
  contentsDrawer: document.querySelector('#contents-drawer'),
  contentsTitle: document.querySelector('#contents-title'),
  editionLabel: document.querySelector('#edition-label'),
  nextChapter: document.querySelector('#next-chapter'),
  previousChapter: document.querySelector('#previous-chapter'),
  readProgress: document.querySelector('#read-progress'),
  readingPane: document.querySelector('#reading-pane'),
  readingTime: document.querySelector('#reading-time'),
  resetButton: document.querySelector('#reset-button'),
  resultList: document.querySelector('#result-list'),
  runButton: document.querySelector('#run-button'),
  runStatus: document.querySelector('#run-status'),
  saveState: document.querySelector('#save-state'),
  sectionList: document.querySelector('#section-list'),
  sourcePath: document.querySelector('#source-path'),
  streakCount: document.querySelector('#streak-count'),
  tierList: document.querySelector('#tier-list'),
  xpCount: document.querySelector('#xp-count'),
}

const state = {
  book: null,
  chapters: [],
  current: null,
  running: false,
}

function renderBookContents() {
  if (!state.book) return
  elements.contentsTitle.textContent = state.book.title
  elements.contentsDescription.textContent = state.book.description
  elements.contentsAuthor.textContent = state.book.author
  elements.editionLabel.textContent = state.book.edition
  elements.articleEdition.textContent = state.book.edition
  const frontMatter = `<section class="contents-part contents-frontmatter">
    <div><span>Front matter</span><h3>Before you begin</h3><p>Reading order, exercise loop, and edition notes.</p></div>
    <ol><li><button type="button" data-preface><span>00</span><strong>How to read this book</strong><small>3 min</small></button></li></ol>
  </section>`
  elements.bookContents.innerHTML = frontMatter + state.book.parts
    .map((part) => {
      const chapters = state.chapters.filter((chapter) => chapter.part === part.number || !chapter.part)
      return `<section class="contents-part">
        <div><span>Part ${escapeHtml(part.number)}</span><h3>${escapeHtml(part.title)}</h3><p>${escapeHtml(part.description)}</p></div>
        <ol>${chapters.map((chapter) => `<li><button type="button" data-content-chapter="${chapter.id}"><span>${String(chapter.number).padStart(2, '0')}</span><strong>${escapeHtml(chapter.title)}</strong><small>${chapter.complete ? 'Complete' : 'Runnable'}</small></button></li>`).join('')}</ol>
      </section>`
    })
    .join('')
  elements.bookContents.querySelectorAll('[data-content-chapter]').forEach((button) => {
    button.addEventListener('click', () => {
      elements.contentsDrawer.hidden = true
      navigate(button.dataset.contentChapter)
    })
  })
  elements.bookContents.querySelector('[data-preface]')?.addEventListener('click', () => {
    elements.contentsDrawer.hidden = true
    navigate('preface')
  })
}

function renderSectionList(sections) {
  elements.sectionList.innerHTML = sections.length
    ? `<ol>${sections.map((section) => `<li class="depth-${section.depth}"><a href="#section-${section.id}">${escapeHtml(section.label)}</a></li>`).join('')}</ol>`
    : '<p>This short chapter has no subsections.</p>'
  elements.sectionList.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault()
      document.querySelector(link.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth' })
    })
  })
  elements.chapterContent.querySelectorAll('h2, h3').forEach((heading) => {
    if (heading.id) heading.id = `section-${heading.id}`
  })
}

async function request(path, options = {}) {
  const response = await fetch(path, options)
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error(`The local reader returned ${response.status}.`)
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`)
  return data
}

async function post(path, body) {
  return request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Book-Token': token,
    },
    body: JSON.stringify(body),
  })
}

function chapterIdFromLocation() {
  const requested = location.hash.replace(/^#/, '')
  if (requested === 'preface') return requested
  return state.chapters.some((chapter) => chapter.id === requested)
    ? requested
    : state.chapters[0]?.id
}

function renderProgress(progress) {
  elements.xpCount.textContent = progress.xp
  elements.streakCount.textContent = progress.streak
  elements.badgeCount.textContent = progress.badges.length
    ? `${progress.badges.length} badge${progress.badges.length === 1 ? '' : 's'} earned`
    : 'No badges yet'
}

function tierDots(chapter) {
  return chapter.tiers
    .map((tier) => `<i class="${chapter.passed.includes(tier) ? 'passed' : ''}" title="${tier}"></i>`)
    .join('')
}

function renderChapterList() {
  elements.chapterList.innerHTML = state.chapters
    .map(
      (chapter) => `
        <li>
          <button
            class="chapter-link"
            type="button"
            data-chapter="${chapter.id}"
            ${chapter.id === state.current?.id ? 'aria-current="page"' : ''}
          >
            <span class="chapter-index">${String(chapter.number).padStart(2, '0')}</span>
            <span class="chapter-label">${escapeHtml(chapter.title)}</span>
            <span class="chapter-state" aria-label="${chapter.passed.length} of ${chapter.tiers.length} tiers passed">
              ${tierDots(chapter)}
            </span>
          </button>
        </li>`,
    )
    .join('')

  elements.chapterList.querySelectorAll('[data-chapter]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.chapter))
  })
}

function renderTiers(chapter, outcomes = {}) {
  elements.tierList.innerHTML = chapter.tiers
    .map((tier) => {
      const alreadyPassed = chapter.passed?.includes(tier.name)
      const outcome = outcomes[tier.name] || (alreadyPassed ? 'passed' : '')
      return `
        <div class="tier ${outcome}" data-tier="${tier.name}">
          <span class="tier-name"><i class="tier-dot ${alreadyPassed ? 'passed' : ''}"></i>${tier.name}</span>
          <small>${tier.description}</small>
        </div>`
    })
    .join('')
}

function draftKey(chapterId) {
  return `rucksack-book:draft:${chapterId}`
}

function updatePager() {
  const index = state.chapters.findIndex((chapter) => chapter.id === state.current?.id)
  elements.previousChapter.disabled = index <= 0
  elements.nextChapter.disabled = index < 0 || index >= state.chapters.length - 1
  elements.previousChapter.dataset.chapter = state.chapters[index - 1]?.id || ''
  elements.nextChapter.dataset.chapter = state.chapters[index + 1]?.id || ''
}

async function loadChapter(chapterId) {
  if (!chapterId || state.running) return
  if (chapterId === 'preface') {
    loadPreface()
    return
  }
  document.body.classList.remove('frontmatter')
  elements.chapterTitle.textContent = 'Opening chapter…'
  elements.chapterContent.setAttribute('aria-busy', 'true')
  try {
    const chapter = await request(`/api/chapters/${encodeURIComponent(chapterId)}`)
    state.current = chapter
    const summary = state.chapters.find((entry) => entry.id === chapter.id)
    const localDraft = localStorage.getItem(draftKey(chapter.id))

    elements.chapterNumber.textContent = String(summary.number).padStart(2, '0')
    elements.chapterPart.textContent = `Part ${chapter.part}`
    elements.chapterTitle.textContent = chapter.title
    elements.chapterDeck.textContent = 'Read the idea. Change the code. Make every tier turn green.'
    elements.readingTime.textContent = `${chapter.readingMinutes} min read`
    elements.editionLabel.textContent = chapter.edition
    elements.chapterContent.innerHTML = chapter.html
    renderSectionList(chapter.sections || [])
    elements.sourcePath.textContent = chapter.sourcePath
    elements.codeEditor.value = localDraft ?? chapter.source
    elements.saveState.textContent = localDraft ? 'Local draft' : 'Workspace'
    elements.consoleOutput.textContent = 'No run yet.'
    elements.resultList.innerHTML = ''
    elements.runStatus.className = 'run-status'
    elements.runStatus.textContent = 'Ready. The first run is supposed to be red.'
    renderTiers({ ...chapter, passed: summary.passed })
    renderChapterList()
    updatePager()
    window.scrollTo({ top: 0, behavior: 'smooth' })
    elements.readingPane.focus({ preventScroll: true })
    document.title = `${chapter.title} — Rucksack DSA`
  } catch (error) {
    elements.chapterTitle.textContent = 'Could not open this chapter'
    elements.chapterContent.innerHTML = `<p>${escapeHtml(error.message)}</p>`
  } finally {
    elements.chapterContent.removeAttribute('aria-busy')
  }
}

function loadPreface() {
  document.body.classList.add('frontmatter')
  state.current = { id: 'preface' }
  elements.chapterNumber.textContent = '00'
  elements.chapterPart.textContent = 'Front matter'
  elements.chapterTitle.textContent = 'How to read this book'
  elements.chapterDeck.textContent = 'The reading order, exercise loop, and what travels into the EPUB edition.'
  elements.readingTime.textContent = '3 min read'
  elements.chapterContent.innerHTML = state.book.prefaceHtml
  renderSectionList(state.book.prefaceSections || [])
  elements.previousChapter.disabled = true
  elements.nextChapter.disabled = false
  elements.nextChapter.dataset.chapter = state.chapters[0]?.id || ''
  elements.runStatus.className = 'run-status'
  elements.runStatus.textContent = 'Practice begins in Chapter 1.'
  renderChapterList()
  window.scrollTo({ top: 0, behavior: 'smooth' })
  elements.readingPane.focus({ preventScroll: true })
  document.title = `How to read this book — ${state.book.shortTitle}`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function navigate(chapterId) {
  if (!chapterId) return
  if (location.hash === `#${chapterId}`) loadChapter(chapterId)
  else location.hash = chapterId
}

async function refreshIndex() {
  const data = await request('/api/book')
  state.book = { ...data.book, prefaceHtml: data.prefaceHtml, prefaceSections: data.prefaceSections }
  state.chapters = data.chapters
  renderProgress(data.progress)
  renderChapterList()
  renderBookContents()
  return data
}

async function runCode() {
  if (!state.current || state.running) return
  state.running = true
  elements.runButton.disabled = true
  elements.runButton.querySelector('span').textContent = 'Grading…'
  elements.runStatus.className = 'run-status'
  elements.runStatus.textContent = 'Running public → edge → stress → perf. The first failure stops the run.'
  elements.resultList.innerHTML = ''
  elements.consoleOutput.textContent = 'Starting isolated Python subprocesses…'
  renderTiers({ ...state.current, passed: [] }, { public: 'running' })

  try {
    const result = await post('/api/grade', {
      chapter: state.current.id,
      source: elements.codeEditor.value,
    })
    localStorage.removeItem(draftKey(state.current.id))
    elements.saveState.textContent = 'Saved to workspace'

    const outcomes = Object.fromEntries(
      result.results.map((entry) => [entry.tier, entry.outcome === 'pass' ? 'passed' : 'failed']),
    )
    renderTiers({ ...state.current, passed: [] }, outcomes)
    elements.resultList.innerHTML = result.results
      .map(
        (entry) => `
          <div class="result-row ${entry.outcome}">
            <span>${entry.tier}</span>
            <strong>${entry.outcome === 'pass' ? `pass · +${entry.xp} XP` : entry.outcome}</strong>
          </div>`,
      )
      .join('')
    const last = result.results.at(-1)
    elements.consoleOutput.textContent = last?.output || 'No grader output.'
    elements.runStatus.className = `run-status ${result.ok ? 'success' : 'failure'}`
    elements.runStatus.textContent = result.ok
      ? `Chapter green. ${result.earnedBadges.length ? `New badge: ${result.earnedBadges.join(', ')}.` : 'All four tiers passed.'}`
      : `${last.tier} is still red. Edit the code and run again.`
    await refreshIndex()
  } catch (error) {
    elements.runStatus.className = 'run-status failure'
    elements.runStatus.textContent = error.message
    elements.consoleOutput.textContent = error.stack || error.message
  } finally {
    state.running = false
    elements.runButton.disabled = false
    elements.runButton.querySelector('span').textContent = 'Run all tiers'
  }
}

async function resetCode() {
  if (!state.current || state.running) return
  const confirmed = window.confirm('Replace this chapter’s workspace code with the pristine starter?')
  if (!confirmed) return
  try {
    const result = await post('/api/reset', { chapter: state.current.id })
    elements.codeEditor.value = result.source
    localStorage.removeItem(draftKey(state.current.id))
    elements.saveState.textContent = 'Starter restored'
    elements.runStatus.className = 'run-status'
    elements.runStatus.textContent = 'Starter restored. Run it once to prove the grader begins red.'
    elements.resultList.innerHTML = ''
    elements.consoleOutput.textContent = 'No run yet.'
  } catch (error) {
    elements.runStatus.className = 'run-status failure'
    elements.runStatus.textContent = error.message
  }
}

elements.codeEditor.addEventListener('input', () => {
  if (!state.current) return
  localStorage.setItem(draftKey(state.current.id), elements.codeEditor.value)
  elements.saveState.textContent = 'Unsaved draft'
})

elements.codeEditor.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault()
    const start = event.currentTarget.selectionStart
    const end = event.currentTarget.selectionEnd
    event.currentTarget.setRangeText('    ', start, end, 'end')
    event.currentTarget.dispatchEvent(new Event('input'))
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    runCode()
  }
})

elements.runButton.addEventListener('click', runCode)
elements.resetButton.addEventListener('click', resetCode)
elements.contentsButton.addEventListener('click', () => {
  elements.contentsDrawer.hidden = !elements.contentsDrawer.hidden
  elements.contentsButton.setAttribute('aria-expanded', String(!elements.contentsDrawer.hidden))
})
elements.previousChapter.addEventListener('click', (event) => navigate(event.currentTarget.dataset.chapter))
elements.nextChapter.addEventListener('click', (event) => navigate(event.currentTarget.dataset.chapter))
window.addEventListener('hashchange', () => loadChapter(chapterIdFromLocation()))
window.addEventListener(
  'scroll',
  () => {
    const available = document.documentElement.scrollHeight - window.innerHeight
    const progress = available > 0 ? Math.min(1, window.scrollY / available) : 0
    elements.readProgress.style.width = `${progress * 100}%`
  },
  { passive: true },
)

async function start() {
  try {
    await refreshIndex()
    await loadChapter(chapterIdFromLocation())
  } catch (error) {
    elements.chapterTitle.textContent = 'The reader did not start'
    elements.chapterContent.innerHTML = `<p>${escapeHtml(error.message)}</p>`
  }
}

start()
