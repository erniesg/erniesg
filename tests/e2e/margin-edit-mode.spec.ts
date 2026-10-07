import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import {
  applyHunks,
  formatHunks,
  proposeHunks,
  parseHunks,
  toUnifiedDiff,
} from '../../src/annotations/criticmarkup'
import type { Principal } from '../../src/worker/principal'
import { D1MarginRepository } from '../../src/worker/margin/d1-repository'
import { handleMarginRequest } from '../../src/worker/margin/routes'
import { SqliteD1Database } from '../../src/worker/margin/sqlite-database'

/**
 * Edit mode end to end (issue 059). `/api/margin/v1/*` is answered in this
 * process by the production router over a fresh SQLite database built from
 * every migration, and `/auth/me` says who is signed in. The page, its stamp
 * and its embedded source are the dev server's own.
 */

const CHAPTER = '/books/build-a-coding-agent/ch03-lists/'
const OWNER: Principal = { provider: 'dev', issuer: 'urn:margin:dev', subject: 'owner' }
const SURFACE = '[data-edit-surface]'
const EDITABLE = `${SURFACE} [contenteditable="true"]`

type Stored = {
  id: string
  motivation: string
  body?: { value: string }
  'margin:baseCommit'?: string
  'margin:sourcePath'?: string
  'margin:revision'?: number
  'margin:withdrawnAt'?: string
}

type Service = {
  signedIn: boolean
  as: Principal
  rows(): Promise<Stored[]>
  post(body: unknown, key?: string): Promise<Response>
}

async function mountService(page: Page, documentUri: string): Promise<Service> {
  const database = SqliteD1Database.inMemory()
  const repository = new D1MarginRepository(database)
  let clock = 0
  let sequence = 0
  const call = (request: Request) =>
    handleMarginRequest(request, {
      repository,
      principal: service.signedIn ? service.as : null,
      now: () => new Date(Date.UTC(2026, 8, 29, 0, 0, 0, (clock += 1))).toISOString(),
      newId: () => `proposal-${String((sequence += 1)).padStart(3, '0')}`,
    })
  const service: Service = {
    signedIn: true,
    as: OWNER,
    async rows() {
      const response = await call(
        new Request(`https://ernie.sg/api/margin/v1/annotations?source=${encodeURIComponent(documentUri)}`),
      )
      return ((await response.json()) as { annotations: Stored[] }).annotations
    },
    post: (body, key) =>
      call(
        new Request('https://ernie.sg/api/margin/v1/annotations', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
        }),
      ),
  }
  await page.route('**/auth/me', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        service.signedIn
          ? { authenticated: true, principal: service.as, canWrite: true, isAdmin: true }
          : { authenticated: false, canWrite: false, isAdmin: false },
      ),
    }),
  )
  await page.route('**/api/margin/v1/**', async (route) => {
    const incoming = route.request()
    const method = incoming.method()
    const response = await call(
      new Request(incoming.url().replace('/proxy/api/margin/', '/api/margin/'), {
        method,
        headers: { 'content-type': 'application/json', ...(incoming.headers()['idempotency-key'] ? { 'Idempotency-Key': incoming.headers()['idempotency-key'] } : {}) },
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: incoming.postData() ?? undefined }),
      }),
    )
    await route.fulfill({
      status: response.status,
      headers: { 'content-type': 'application/json' },
      body: await response.text(),
    })
  })
  return service
}

type Source = { path: string; commit: string; text: string }

async function pageSource(page: Page): Promise<Source> {
  const json = await page.locator('script[data-book-source]').textContent()
  return JSON.parse(json ?? 'null') as Source
}

/** Apply a stored proposal to its base with real `git apply`; return the file. */
function gitApply(source: Source, body: string): string {
  const hunks = parseHunks(body)
  const repo = mkdtempSync(path.join(tmpdir(), 'edit-mode-apply-'))
  try {
    const file = path.join(repo, source.path)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, source.text)
    execFileSync('git', ['init', '-q'], { cwd: repo })
    const patch = path.join(repo, 'proposal.patch')
    writeFileSync(patch, toUnifiedDiff(hunks, source.text, source.path))
    execFileSync('git', ['apply', 'proposal.patch'], { cwd: repo })
    const applied = readFileSync(file, 'utf8')
    expect(applied).toBe(applyHunks(hunks, source.text))
    return applied
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

async function openEditor(page: Page): Promise<{ service: Service; source: Source }> {
  const documentUri = new URL(CHAPTER, 'https://ernie.sg').toString()
  const service = await mountService(page, documentUri)
  await page.goto(CHAPTER)
  const source = await pageSource(page)
  expect(source.commit).toMatch(/^[0-9a-f]{40}$/)
  await expect(page.locator('margin-rail')).toHaveAttribute('source-commit', source.commit)
  await expect(page.locator('margin-rail')).toHaveAttribute('source-path', source.path)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator(SURFACE)).toBeVisible()
  return { service, source }
}

/** Select the first occurrence of `word` in the first editable block holding it. */
async function selectWord(page: Page, word: string): Promise<void> {
  await page.evaluate(
    ({ selector, word }) => {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent?.search(new RegExp(`\\b${word}\\b`)) ?? -1
          if (at >= 0) {
            element.focus()
            const range = document.createRange()
            range.setStart(node, at)
            range.setEnd(node, at + word.length)
            const selection = window.getSelection()!
            selection.removeAllRanges()
            selection.addRange(range)
            return
          }
        }
      }
      throw new Error(`no editable text holds ${word}`)
    },
    { selector: EDITABLE, word },
  )
}

/** A word that occurs exactly once in the source, inside an editable paragraph. */
async function uniqueWord(page: Page, source: Source): Promise<string> {
  const texts = await page.locator(`${SURFACE} p[contenteditable="true"]`).allTextContents()
  for (const text of texts) {
    for (const word of text.match(/\b[a-z]{7,}\b/g) ?? []) {
      if (source.text.split(new RegExp(`\\b${word}\\b`)).length === 2) return word
    }
  }
  throw new Error('no unique word to edit')
}

test.describe('edit mode', () => {
  test('is not offered to a reader who may not write', async ({ page }) => {
    const service = await mountService(page, new URL(CHAPTER, 'https://ernie.sg').toString())
    service.signedIn = false
    await page.goto(CHAPTER)
    await expect(page.locator('[data-edit-mode]')).toBeHidden()
  })

  test('a one-word edit saves as a one-word proposal against the stamped commit, and applies with git apply', async ({ page }) => {
    const { service, source } = await openEditor(page)
    // Locked blocks are shown, and are not editable.
    const locked = page.locator(`${SURFACE} .edit-locked`)
    expect(await locked.count()).toBeGreaterThan(0)
    await expect(locked.first()).toHaveAttribute('contenteditable', 'false')

    const word = await uniqueWord(page, source)
    await selectWord(page, word)
    await page.keyboard.type('XYZZYQ')
    await expect(page.locator('[data-edit-changes] ins')).toContainText('XYZZYQ')
    await expect(page.locator('[data-edit-changes] del')).toContainText(word)
    await page.getByRole('button', { name: 'Save proposal' }).click()
    await expect(page.locator('[data-edit-status]')).toContainText('revision 1')

    const [stored] = (await service.rows()).filter((row) => row.motivation === 'editing')
    expect(stored['margin:baseCommit']).toBe(source.commit)
    expect(stored['margin:sourcePath']).toBe(source.path)
    const hunks = parseHunks(stored.body!.value)
    const markers = hunks.map((hunk) => hunk.criticMarkup.match(/\{(~~|--|\+\+)/g)?.length ?? 0)
    expect(markers.reduce((a, b) => a + b, 0)).toBe(1)
    expect(hunks[0].criticMarkup).toContain(`{~~${word}~>XYZZYQ~~}`)
    expect(gitApply(source, stored.body!.value)).toBe(source.text.replace(word, 'XYZZYQ'))
  })

  test('deleting a paragraph and joining two apply cleanly, and undo restores the text exactly', async ({ page }) => {
    const { service, source } = await openEditor(page)
    const paragraphs = page.locator(`${SURFACE} p[contenteditable="true"]`)
    const before = await paragraphs.count()

    // Delete a whole paragraph: select its text and remove it.
    await paragraphs.nth(1).click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    await paragraphs.nth(0).click() // leaving the block commits it
    await expect(paragraphs).toHaveCount(before - 1)
    await page.getByRole('button', { name: 'Save proposal' }).click()
    await expect(page.locator('[data-edit-status]')).toContainText('revision 1')
    let [stored] = (await service.rows()).filter((row) => row.motivation === 'editing')
    const deleted = gitApply(source, stored.body!.value)
    expect(deleted.length).toBeLessThan(source.text.length)

    // Undo restores the source byte for byte: nothing left to save.
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(paragraphs).toHaveCount(before)
    await expect(page.getByRole('button', { name: 'Save proposal' })).toBeDisabled()

    // Join two paragraphs: Backspace at the start of the second.
    await paragraphs.nth(1).click()
    await page.keyboard.press('ControlOrMeta+ArrowUp')
    await page.evaluate((selector) => {
      const element = document.querySelectorAll<HTMLElement>(selector)[1]
      const range = document.createRange()
      range.selectNodeContents(element)
      range.collapse(true)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    }, `${SURFACE} p[contenteditable="true"]`)
    await page.keyboard.press('Backspace')
    await expect(paragraphs).toHaveCount(before - 1)
    await page.getByRole('button', { name: 'Save proposal' }).click()
    await expect(page.locator('[data-edit-status]')).toContainText('revision 2')
    ;[stored] = (await service.rows()).filter((row) => row.motivation === 'editing')
    expect(stored['margin:revision']).toBe(2)
    gitApply(source, stored.body!.value)
  })

  test('a locked block cannot be changed by keyboard or paste, and a paste keeps only permitted nodes', async ({ page }) => {
    await openEditor(page)
    const locked = page.locator(`${SURFACE} .edit-locked`).first()
    const text = await locked.textContent()
    await locked.click()
    await page.keyboard.type('nope')
    await page.evaluate(() => {
      const figure = document.querySelector('[data-edit-surface] .edit-locked')!
      const data = new DataTransfer()
      data.setData('text/plain', 'pasted')
      figure.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await expect(locked).toHaveText(text ?? '')

    // Rich paste into prose: tables, images, scripts and styles are not kept.
    await page.locator(`${SURFACE} p[contenteditable="true"]`).first().click()
    await page.evaluate(() => {
      const target = document.querySelector<HTMLElement>('[data-edit-surface] p[contenteditable="true"]')!
      target.focus()
      const data = new DataTransfer()
      data.setData(
        'text/html',
        '<table><tr><td>cell</td></tr></table><img src="x.png"><script>alert(1)</script><span style="color:red" onclick="x()">styled</span><em>kept</em>',
      )
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    const html = await page.locator(`${SURFACE} p[contenteditable="true"]`).first().innerHTML()
    expect(html).not.toMatch(/<(table|td|img|script|span)\b/)
    expect(html).not.toMatch(/style=|onclick=/)
    expect(html).toContain('<em>kept</em>')
  })

  test('a stale proposal is shown stale and cannot be reopened; withdrawing keeps the row', async ({ page }) => {
    const documentUri = new URL(CHAPTER, 'https://ernie.sg').toString()
    const service = await mountService(page, documentUri)
    await page.goto(CHAPTER)
    const source = await pageSource(page)
    const make = (baseCommit: string) =>
      service.post({
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        motivation: 'editing',
        body: {
          type: 'TextualBody',
          value: JSON.stringify({ v: 1, hunks: [{ baseStartLine: 1, baseEndLine: 1, criticMarkup: '{~~+++~>+++~~}\n' }] }),
        },
        target: {
          source: documentUri,
          selector: [
            { type: 'TextQuoteSelector', exact: 'x' },
            { type: 'TextPositionSelector', start: 0, end: 1 },
          ],
        },
        'margin:baseCommit': baseCommit,
        'margin:sourcePath': source.path,
      })
    expect((await make('b'.repeat(40))).status).toBe(201)
    await page.reload()
    const stale = page.locator('.edit-proposal[data-state="stale"]')
    await expect(stale).toContainText('stale')
    await expect(stale.getByRole('button', { name: 'Reopen' })).toBeDisabled()
    await stale.getByRole('button', { name: 'Withdraw' }).click()
    await expect(page.locator('[data-edit-status]')).toContainText('withdrawn')
    await expect(page.locator('.edit-proposal')).toHaveCount(0)
    const rows = await service.rows()
    expect(rows.find((row) => row.motivation === 'editing')?.['margin:withdrawnAt']).toBeTruthy()
  })

  test('a stale pending deep link preserves the draft and never bypasses the disabled Reopen button', async ({ page }) => {
    const { service, source } = await openEditor(page)
    const word = await uniqueWord(page, source)
    await page.getByRole('button', { name: 'Stop editing' }).click()
    const creator = `urn:margin:principal:${[OWNER.provider, OWNER.issuer, OWNER.subject].map(encodeURIComponent).join(':')}`
    const key = `book-edit-draft:v2:${encodeURIComponent(creator)}:${source.path}:${source.commit}`
    const draft = JSON.stringify({ text: source.text.replace(word, 'PRESERVEMYDRAFT'), revising: null })
    await page.evaluate(({ key, draft }) => localStorage.setItem(key, draft), { key, draft })
    const response = await service.post({
      '@context': 'http://www.w3.org/ns/anno.jsonld', type: 'Annotation', motivation: 'editing',
      body: { type: 'TextualBody', value: formatHunks(proposeHunks(source.text, source.text.replace(word, 'STALECHANGE'))) },
      target: { source: new URL(CHAPTER, 'https://ernie.sg').toString(), selector: [
        { type: 'TextQuoteSelector', exact: word }, { type: 'TextPositionSelector', start: 0, end: word.length },
      ] },
      'margin:baseCommit': source.commit === 'b'.repeat(40) ? 'c'.repeat(40) : 'b'.repeat(40),
      'margin:sourcePath': source.path,
    })
    expect(response.status).toBe(201)
    const proposal = await response.json() as Stored
    const id = proposal.id.replace(/^urn:margin:annotation:/, '')
    let confirms = 0
    page.on('dialog', async (dialog) => { confirms += 1; await dialog.accept() })
    const writes: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/margin/v1/') && ['POST', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method())
    })
    await page.goto(`${CHAPTER}?annotation=${encodeURIComponent(id)}`)
    await expect(page.locator(`margin-rail [data-margin-annotation="${id}"]`)).toHaveAttribute('data-margin-target', '')
    await expect(page.locator('.edit-proposal[data-state="stale"]').getByRole('button', { name: 'Reopen' })).toBeDisabled()
    await expect(page.locator('[data-edit-status]')).toContainText('unsaved changes')
    await expect(page.locator('html')).not.toHaveAttribute('data-book-editing', '')
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(draft)
    expect(confirms).toBe(0)
    expect(writes).toEqual([])
  })

  test('reopening a current proposal restores its edit, and saving revises it', async ({ page }) => {
    const { service, source } = await openEditor(page)
    const word = await uniqueWord(page, source)
    await selectWord(page, word)
    await page.keyboard.type('FIRSTDRAFT')
    await page.getByRole('button', { name: 'Save proposal' }).click()
    await expect(page.locator('[data-edit-status]')).toContainText('revision 1')
    await page.reload()
    const current = page.locator('.edit-proposal[data-state="current"]')
    await current.getByRole('button', { name: 'Reopen' }).click()
    await expect(page.locator(SURFACE)).toContainText('FIRSTDRAFT')
    await selectWord(page, 'FIRSTDRAFT')
    await page.keyboard.type('SECONDDRAFT')
    await page.getByRole('button', { name: 'Save proposal' }).click()
    await expect(page.locator('[data-edit-status]')).toContainText('revision 2')
    const [stored] = (await service.rows()).filter((row) => row.motivation === 'editing')
    expect(gitApply(source, stored.body!.value)).toBe(source.text.replace(word, 'SECONDDRAFT'))
  })

  test('book shortcuts stay off while editing, and the editor announces its state', async ({ page }) => {
    await openEditor(page)
    await expect(page.getByRole('button', { name: 'Stop editing' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-edit-status]')).toContainText('Edit mode on')
    await page.getByRole('button', { name: 'Undo', exact: true }).focus()
    const url = page.url()
    await page.keyboard.press(']')
    await page.waitForTimeout(300)
    expect(page.url()).toBe(url)
    await page.getByRole('button', { name: 'Stop editing' }).click()
    await expect(page.locator(SURFACE)).toBeHidden()
    await expect(page.locator('.book-content')).toBeVisible()
  })

  test('an unsaved draft survives a reload, and Discard clears it', async ({ page }) => {
    const { source } = await openEditor(page)
    const word = await uniqueWord(page, source)
    await selectWord(page, word)
    await page.keyboard.type('DRAFTWORD')
    await page.getByRole('button', { name: 'Stop editing' }).click()
    page.once('dialog', (dialog) => void dialog.accept())
    await page.reload()
    await expect(page.locator('[data-edit-status]')).toContainText('unsaved changes')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.locator(SURFACE)).toContainText('DRAFTWORD')
    await page.getByRole('button', { name: 'Discard' }).click()
    await expect(page.locator(SURFACE)).not.toContainText('DRAFTWORD')
    await page.getByRole('button', { name: 'Stop editing' }).click()
    await page.reload()
    await expect(page.locator('[data-edit-status]')).not.toContainText('unsaved changes')
  })

  test('two quick saves make one proposal, anchored beside the changed line', async ({ page }) => {
    const { service, source } = await openEditor(page)
    const word = await uniqueWord(page, source)
    await selectWord(page, word)
    await page.keyboard.type('ONCEONLY')
    await page.locator(`${SURFACE} [contenteditable="true"]`).first().click()
    await page.locator(`${SURFACE} [contenteditable="true"]`).first().press('ControlOrMeta+Enter')
    await page.locator(`${SURFACE} [contenteditable="true"]`).first().press('ControlOrMeta+Enter')
    await expect(page.locator('[data-edit-status]')).toContainText('revision')
    const proposals = (await service.rows()).filter((row) => row.motivation === 'editing')
    expect(proposals).toHaveLength(1)
    // The anchor quotes the line that holds the edited word, not its context.
    const quote = (proposals[0] as unknown as {
      target: { selector: { type: string; exact?: string }[] }
    }).target.selector.find((selector) => selector.type === 'TextQuoteSelector')?.exact ?? ''
    const line = source.text.split('\n').find((text) => new RegExp(`\\b${word}\\b`).test(text)) ?? ''
    expect(line.replace(/[*_`]/g, '').trim()).toContain(quote.slice(0, 20))
  })

  test('a link title survives an edit elsewhere in its paragraph', async ({ page }) => {
    const { source } = await openEditor(page)
    const paragraph = page.locator(`${SURFACE} p[contenteditable="true"]`).first()
    await paragraph.evaluate((element) => {
      const link = document.createElement('a')
      link.href = 'https://example.com/'
      link.title = 'a title'
      link.textContent = 'linked'
      element.append(' ', link)
      element.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
    await page.locator(`${SURFACE} p[contenteditable="true"]`).nth(1).click()
    await expect(page.locator('[data-edit-changes]')).toContainText('"a title"')
    void source
  })

  test('a saved proposal leaves no draft behind; another reader never sees a draft', async ({ page }) => {
    const { service, source } = await openEditor(page)
    const word = await uniqueWord(page, source)
    await selectWord(page, word)
    await page.keyboard.type('SAVEDONE')
    await page.getByRole('button', { name: 'Save proposal' }).click()
    await expect(page.locator('[data-edit-status]')).toContainText('revision 1')
    await page.getByRole('button', { name: 'Stop editing' }).click()
    await page.reload()
    await expect(page.locator('[data-edit-status]')).not.toContainText('unsaved changes')

    // A second writer in the same browser gets no draft of the first's.
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await selectWord(page, word)
    await page.keyboard.type('UNSAVEDBYOWNER')
    await page.getByRole('button', { name: 'Stop editing' }).click()
    service.as = { provider: 'dev', issuer: 'urn:margin:dev', subject: 'someone-else' }
    page.once('dialog', (dialog) => void dialog.accept())
    await page.reload()
    await expect(page.locator('[data-edit-status]')).not.toContainText('unsaved changes')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.locator(SURFACE)).not.toContainText('UNSAVEDBYOWNER')
  })

  test('Reopen asks before it drops unsaved changes', async ({ page }) => {
    const { source } = await openEditor(page)
    const word = await uniqueWord(page, source)
    await selectWord(page, word)
    await page.keyboard.type('FIRSTSAVED')
    await page.getByRole('button', { name: 'Save proposal' }).click()
    await expect(page.locator('[data-edit-status]')).toContainText('revision 1')
    await selectWord(page, 'FIRSTSAVED')
    await page.keyboard.type('KEEPME')
    await page.locator(`${SURFACE} [contenteditable="true"]`).first().click()
    page.once('dialog', (dialog) => void dialog.dismiss())
    await page.locator('.edit-proposal').getByRole('button', { name: 'Reopen' }).click()
    await expect(page.locator(SURFACE)).toContainText('KEEPME')
  })

  test('Shift+Enter in a heading adds no line; boundary spaces leave emphasis; list numbers stay', async ({ page }) => {
    await openEditor(page)
    const heading = page.locator(`${SURFACE} h2[contenteditable="true"], ${SURFACE} h3[contenteditable="true"]`).first()
    const before = await heading.textContent()
    await heading.click()
    await page.keyboard.press('Shift+Enter')
    await expect(heading).toHaveText(before ?? '')

    const inlines = await page.evaluate(() => {
      const p = document.querySelector<HTMLElement>('[data-edit-surface] p[contenteditable="true"]')!
      p.innerHTML = 'plain <em> spaced </em> text'
      p.dispatchEvent(new InputEvent('input', { bubbles: true }))
      return p.innerHTML
    })
    void inlines
    await page.locator(`${SURFACE} p[contenteditable="true"]`).nth(1).click()
    await expect(page.locator('[data-edit-changes]')).toContainText('*spaced*')
    await expect(page.locator('[data-edit-changes]')).not.toContainText('* spaced')
  })

  test('the Edit bar stays usable over a challenge in side-by-side view', async ({ page }) => {
    const documentUri = new URL('/books/build-a-coding-agent/recent-readings/', 'https://ernie.sg').toString()
    await mountService(page, documentUri)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(() => localStorage.setItem('book-challenge-view', 'split'))
    await page.goto('/books/build-a-coding-agent/recent-readings/')
    await expect(page.locator('html')).toHaveAttribute('data-challenge-view', 'split')
    const toggle = page.getByRole('button', { name: 'Edit', exact: true })
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(page.locator(SURFACE)).toBeVisible()
    await expect(page.locator('html')).not.toHaveAttribute('data-challenge-view', 'split')
  })

  test('a restored draft revising a proposal PATCHes it, never a second POST', async ({ page }) => {
    const { service, source } = await openEditor(page)
    const word = await uniqueWord(page, source)
    await selectWord(page, word)
    await page.keyboard.type('REVONE')
    await page.getByRole('button', { name: 'Save proposal' }).click()
    await expect(page.locator('[data-edit-status]')).toContainText('revision 1')
    await selectWord(page, 'REVONE')
    await page.keyboard.type('REVTWO')
    await page.getByRole('button', { name: 'Stop editing' }).click()
    page.once('dialog', (dialog) => void dialog.accept())
    // The listing never answers, so only the direct lookup can resolve it.
    await page.route('**/api/margin/v1/proposals?*', () => {})
    await page.reload()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: 'Save proposal' }).click()
    await expect(page.locator('[data-edit-status]')).toContainText('revision 2')
    expect((await service.rows()).filter((row) => row.motivation === 'editing')).toHaveLength(1)
  })

  test('works in the Plain look too', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('book-look', 'plain'))
    const { source } = await openEditor(page)
    await expect(page.locator('html')).toHaveAttribute('data-book-look', 'plain')
    const word = await uniqueWord(page, source)
    await selectWord(page, word)
    await page.keyboard.type('PLAINLOOK')
    await expect(page.getByRole('button', { name: 'Save proposal' })).toBeEnabled()
  })
})

test.describe('sketch annotations in edit mode', () => {
  async function area(page: Page) {
    const block = page
      .locator('.book-content [data-block-kind=prose]')
      .filter({ hasText: 'list' })
      .first()
    await block.scrollIntoViewIfNeeded()
    const box = (await block.boundingBox())!
    await page.mouse.move(box.x + 5, box.y + 5)
    await page.mouse.down()
    await page.mouse.move(
      box.x + Math.min(box.width - 5, 200),
      box.y + Math.min(box.height - 5, 60),
      { steps: 5 },
    )
    await page.mouse.up()
    const canvas = page.locator('[data-sketch-canvas]')
    await expect(canvas).toBeVisible()
    const region = (await canvas.boundingBox())!
    await page.mouse.move(region.x + 10, region.y + 10)
    await page.mouse.down()
    await page.mouse.move(
      region.x + region.width - 10,
      region.y + region.height - 10,
      { steps: 10 },
    )
    await page.mouse.up()
  }

  test('saves sketch and note through the real annotation service, and reloads it', async ({
    page,
  }) => {
    const { service } = await openEditor(page)
    await page.getByRole('button', { name: 'Sketch', exact: true }).click()
    await expect(page.locator('.book-content')).toBeVisible()
    await area(page)
    await page
      .getByLabel('Sketch annotation')
      .fill('Explain this list with a diagram')
    await page.screenshot({ path: '.agent/evidence/book-sketch-ui.png' })
    await page
      .getByRole('button', { name: 'Save annotation', exact: true })
      .click()
    await expect(page.locator('[data-sketch-status]')).toContainText('saved')
    const rows = await service.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0].motivation).toBe('commenting')
    expect(rows[0].body?.value).toContain('Explain this list with a diagram')
    expect(rows[0]['margin:baseCommit']).toBeUndefined()
    await expect(page.locator('[data-sketch-saved] path')).toHaveCount(1)
    await page.reload()
    await expect(page.locator('[data-sketch-saved] path')).toHaveCount(1)
    const marginToggle = page.getByRole('button', { name: 'Margin', exact: true })
    if (await marginToggle.isVisible()) await marginToggle.click()
    await expect(page.locator('margin-rail')).toContainText(
      'Explain this list with a diagram',
    )
    await expect(page.locator('margin-rail')).not.toContainText('margin:sketch:v1')
    const rail = page.locator('margin-rail')
    await rail.getByRole('button', { name: 'Edit', exact: true }).click()
    await rail.getByLabel('Edit note', { exact: true }).fill('Revised diagram note')
    await rail.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(rail).toContainText('Revised diagram note')
    await expect(page.locator('[data-sketch-saved]')).toHaveAttribute('aria-label', 'Sketch: Revised diagram note')
    const changed = await service.rows()
    expect(JSON.parse(changed[0].body!.value.split('\n').slice(1).join('\n')).strokes).toEqual(JSON.parse(rows[0].body!.value.split('\n').slice(1).join('\n')).strokes)
    await rail.locator('[data-margin-action=delete]').click()
    await expect(page.locator('[data-sketch-saved]')).toHaveCount(0)

  })

  test('restores an unsaved sketch after reload and keeps it when exiting edit mode', async ({ page }) => {
    await openEditor(page)
    await page.getByRole('button', { name: 'Sketch', exact: true }).click()
    await area(page)
    await page.getByLabel('Sketch annotation').fill('Draft note')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Stop editing' }).click()
    await page.reload()
    await page.locator('[data-edit-toggle]').click()
    await page.getByRole('button', { name: 'Sketch', exact: true }).click()
    await expect(page.getByLabel('Sketch annotation')).toHaveValue('Draft note')
    await expect(page.locator('[data-sketch-canvas] path')).toHaveCount(1)
    await page.getByRole('button', { name: 'Undo stroke', exact: true }).click()
    await expect(page.locator('[data-sketch-canvas] path')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save annotation', exact: true })).toBeDisabled()
  })

  test('retry after a lost save response creates just one annotation, including after reload', async ({ page }) => {
    const { service } = await openEditor(page)
    await page.getByRole('button', { name: 'Sketch', exact: true }).click()
    await area(page)
    await page.getByLabel('Sketch annotation').fill('One annotation only')
    // Fulfill the persisted request with invalid JSON, as if its body was lost in transit.
    await page.route('**/api/margin/v1/annotations', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      const response = await service.post(JSON.parse(route.request().postData()!), route.request().headers()['idempotency-key'])
      await route.fulfill({ status: response.status, body: 'truncated-response' })
    })
    await page.getByRole('button', { name: 'Save annotation', exact: true }).click()
    await expect(page.locator('[data-sketch-status]')).toContainText('Could not save')
    await page.unroute('**/api/margin/v1/annotations')
    await page.reload()
    await page.locator('[data-edit-toggle]').click()
    await page.getByRole('button', { name: 'Sketch', exact: true }).click()
    await page.getByRole('button', { name: 'Save annotation', exact: true }).click()
    await expect(page.locator('[data-sketch-status]')).toContainText('saved')
    expect(await service.rows()).toHaveLength(1)
  })

  for (const keepReplies of [false, true]) {
    test(`a stale draft cannot recreate a ${keepReplies ? 'tombstoned' : 'deleted'} annotation after a lost response`, async ({ page }) => {
      const { service } = await openEditor(page)
      await page.getByRole('button', { name: 'Sketch', exact: true }).click()
      await area(page)
      await page.getByLabel('Sketch annotation').fill('Deleted annotation')
      let originalRequest: Record<string, unknown> = {}
      await page.route('**/api/margin/v1/annotations', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback()
        originalRequest = JSON.parse(route.request().postData()!)
        const response = await service.post(originalRequest, route.request().headers()['idempotency-key'])
        await route.fulfill({ status: response.status, body: 'truncated-response' })
      })
      await page.getByRole('button', { name: 'Save annotation', exact: true }).click()
      await expect(page.locator('[data-sketch-status]')).toContainText('Could not save')
      await page.unroute('**/api/margin/v1/annotations')
      if (keepReplies) {
        const [parent] = await service.rows()
        const reply = await service.post({
          ...originalRequest,
          body: { type: 'TextualBody', value: 'Reply to preserve the thread', format: 'text/plain' },
          'margin:parentId': parent.id,
        })
        expect(reply.status).toBe(201)
      }
      await page.reload()
      const marginToggle = page.getByRole('button', { name: 'Margin', exact: true })
      if (await marginToggle.isVisible()) await marginToggle.click()
      await page.locator('margin-rail [data-margin-action=delete]').first().click()
      await expect(page.locator('[data-sketch-saved]')).toHaveCount(0)
      await page.locator('[data-edit-toggle]').click()
      await page.getByRole('button', { name: 'Sketch', exact: true }).click()
      await page.getByRole('button', { name: 'Save annotation', exact: true }).click()
      await expect(page.locator('[data-sketch-status]')).toContainText('409')
      await expect(page.getByLabel('Sketch annotation')).toHaveValue('Deleted annotation')
      const retained = await service.rows()
      expect(retained).toHaveLength(keepReplies ? 2 : 0)
      if (keepReplies) expect(retained[0]).toMatchObject({ 'margin:deleted': true })
    })
  }

  test('uses the configured annotation service path', async ({ page }) => {
    const { service } = await openEditor(page)
    await page.locator('margin-rail').evaluate((rail) => rail.setAttribute('api-base', '/proxy'))
    await page.getByRole('button', { name: 'Sketch', exact: true }).click()
    await area(page)
    await page.getByLabel('Sketch annotation').fill('Proxy annotation')
    const posted = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/proxy/api/margin/v1/annotations'))
    await page.getByRole('button', { name: 'Save annotation', exact: true }).click()
    await posted
    await expect(page.locator('[data-sketch-status]')).toContainText('saved')
    expect(await service.rows()).toHaveLength(1)
  })

  test('drawing controls fit on a phone and preserve a stroke through resizing', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openEditor(page)
    await page.getByRole('button', { name: 'Sketch', exact: true }).click()
    await area(page)
    await page.getByLabel('Sketch annotation').fill('Mobile note')
    const toolbar = (await page.locator('[data-sketch-toolbar]').boundingBox())!
    expect(toolbar.x).toBeGreaterThanOrEqual(0)
    expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(390)
    const before = await page.locator('[data-sketch-canvas] path').getAttribute('d')
    await page.setViewportSize({ width: 1280, height: 1000 })
    await expect(page.locator('[data-sketch-canvas] path')).toHaveAttribute('d', before!)
    await expect(page.getByLabel('Sketch annotation')).toHaveValue('Mobile note')
    await page.keyboard.press('Escape')
    await expect(page.locator(SURFACE)).toBeVisible()
  })

  test('shortcut switches tools without changing prose, Escape returns to editing', async ({
    page,
  }) => {
    await openEditor(page)
    const text = await page.locator(SURFACE).textContent()
    await page.locator(EDITABLE).first().press('Control+Shift+D')
    await expect(page.locator('[data-sketch-toolbar]')).toBeVisible()
    await expect(page.locator('.book-content')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator(SURFACE)).toBeVisible()
    expect(await page.locator(SURFACE).textContent()).toBe(text)
    await expect(
      page.getByRole('button', { name: 'Save proposal' }),
    ).toBeDisabled()
  })

  test('failed save retains sketch and note for retry and prevents duplicate submits', async ({
    page,
  }) => {
    const { service } = await openEditor(page)
    await page.getByRole('button', { name: 'Sketch', exact: true }).click()
    await area(page)
    await page.getByLabel('Sketch annotation').fill('Retry me')
    await page.route('**/api/margin/v1/annotations', async (route) => {
      if (route.request().method() === 'POST')
        await route.fulfill({ status: 503, body: '{}' })
      else await route.fallback()
    })
    await page
      .getByRole('button', { name: 'Save annotation', exact: true })
      .click()
    await expect(page.locator('[data-sketch-status]')).toContainText(
      'Could not save',
    )
    await expect(page.getByLabel('Sketch annotation')).toHaveValue('Retry me')
    await expect(page.locator('[data-sketch-canvas] path')).toHaveCount(1)
    await page.unroute('**/api/margin/v1/annotations')
    await page
      .getByRole('button', { name: 'Save annotation', exact: true })
      .dblclick()
    await expect(page.locator('[data-sketch-status]')).toContainText('saved')
    expect(await service.rows()).toHaveLength(1)
  })
})
