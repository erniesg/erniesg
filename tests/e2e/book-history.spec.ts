import { createHash } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { installStaticRoutes } from './static-build'
import { safeHistoryHtml } from '../../src/lib/book-history-safe-html'

// Execution is separately admitted against a fresh strict build. These tests
// distinguish actual public assets from synthetic controls; screenshots still
// require independent human visual review.
const PATH = '/books/build-a-coding-agent/ch03-lists/'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const json = (v: unknown) => JSON.stringify(v) + '\n'
async function setup(page: Page, baseURL: string) {
  await installStaticRoutes(page)
  const denied: string[] = [],
    mutations: string[] = []
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    if (!['GET', 'HEAD'].includes(request.method())) {
      mutations.push(request.method() + ' ' + url.pathname)
      await route.abort()
      return
    }
    if (url.origin !== new URL(baseURL).origin) {
      denied.push(url.origin)
      await route.abort()
      return
    }
    await route.fallback()
  })
  await page.goto(PATH)
  return { denied, mutations, panel: page.locator('[data-book-history]') }
}
function assets(identity: any, unsafe = false) {
  const commits = ['a'.repeat(40), 'b'.repeat(40)],
    deleted = 'c'.repeat(40),
    css = '.history-content p { color:var(--ink); }'
  const versions = commits.map((commit, i) => ({
    commit,
    author: 'Public fixture',
    date: '2026-10-07T00:00:00+00:00',
    message: 'Literal <fixture> ' + i,
    path: i ? 'books/chapters/old-name.md' : identity.sourcePath,
    change: 'M',
    deleted: false,
    content: 'source ' + i,
  }))
  const raw = {
    schemaVersion: 1,
    site: identity.site,
    document: identity.document,
    book: identity.book,
    node: identity.node,
    buildCommit: identity.buildCommit,
    sourcePath: identity.sourcePath,
    versions: [
      ...versions,
      {
        commit: deleted,
        author: 'Public fixture',
        date: '2026-10-08T00:00:00+00:00',
        message: 'Deleted',
        path: identity.sourcePath,
        change: 'D',
        deleted: true,
        content: null,
      },
    ],
  }
  const common = {
    schemaVersion: 1,
    profile: 'book-history-safe-html-v1',
    site: identity.site,
    document: identity.document,
    book: identity.book,
    node: identity.node,
    buildCommit: identity.buildCommit,
    rendererProfile: 'node-content-readonly-v1',
    rendererFingerprint: 'd'.repeat(64),
    publicationFingerprint: 'e'.repeat(64),
    rawHistorySha256: sha(json(raw)),
    contentCssSha256: sha(css),
    scopedCssSha256: sha(css),
  }
  const output: Record<string, string> = { [PATH + 'history.json']: json(raw) }
  const rows = versions.map((v, i) => {
    const safe = safeHistoryHtml(
      `<p>Shared <strong>${i ? 'old' : 'new'}</strong> text. <a href="https://example.invalid/">Inert link</a></p>`,
      'h-fixture',
    )
    const html = unsafe
      ? '<img src="https://example.invalid/private">'
      : safe.html
    const body = json({
      kind: 'rendered-history-version',
      ...common,
      commit: v.commit,
      sourcePath: v.path,
      sourceOID: 'f'.repeat(40),
      sourceSha256: sha(v.content),
      treeOID: '0'.repeat(40),
      renderSha256: '1'.repeat(64),
      safeHtml: html,
      safeHtmlSha256: sha(html),
      blocks: safe.blocks,
    })
    const pathname = PATH + `history-rendered/${v.commit}.json`
    output[pathname] = body
    return {
      commit: v.commit,
      deleted: false,
      pathname,
      sha256: sha(body),
      bytes: Buffer.byteLength(body),
    }
  })
  output[PATH + 'history-rendered/index.json'] = json({
    kind: 'rendered-history-index',
    ...common,
    scopedCss: css,
    versions: [...rows, { commit: deleted, deleted: true }],
  })
  return output
}

test('actual built public history is readonly and usable at three widths', async ({
  page,
  baseURL,
}, testInfo) => {
  const s = await setup(page, baseURL!)
  await s.panel
    .getByRole('button', { name: 'Version history', exact: true })
    .click()
  await expect(s.panel.locator('[data-history-frame-before]')).toBeVisible()
  await expect(s.panel.locator('[data-history-frame-after]')).toBeVisible()
  await expect(s.panel.locator('[data-history-list] li').first()).toBeVisible()
  for (const width of [390, 1280, 2560]) {
    await page.setViewportSize({ width, height: 1000 })
    await s.panel.scrollIntoViewIfNeeded()
    await expect(
      s.panel.getByRole('combobox', { name: 'Before version', exact: true }),
    ).toBeVisible()
    await s.panel
      .getByRole('combobox', { name: 'Before version', exact: true })
      .focus()
    await expect(
      s.panel.getByRole('combobox', { name: 'Before version', exact: true }),
    ).toBeFocused()
    await page.screenshot({
      path: testInfo.outputPath(`actual-history-${width}.png`),
      fullPage: false,
    })
  }
  for (const frame of await s.panel.locator('iframe').all()) {
    await expect(frame).toHaveAttribute('sandbox', '')
    await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
  }
  expect(s.mutations).toEqual([])
  await testInfo.attach('external-deny-log', {
    body: JSON.stringify(s.denied),
    contentType: 'application/json',
  })
})

test('synthetic rendered differences preserve format, inert links, reverse selections and tombstones', async ({
  page,
  baseURL,
}) => {
  const s = await setup(page, baseURL!),
    identity = JSON.parse(
      (await s.panel.getAttribute('data-history-page')) ?? 'null',
    ),
    responses = assets(identity)
  await page.route('**/history*.json', (route) => route.fallback())
  await page.route('**/history-rendered/*.json', async (route) => {
    const body = responses[new URL(route.request().url()).pathname]
    body
      ? await route.fulfill({ contentType: 'application/json', body })
      : await route.abort()
  })
  await page.route('**/history.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: responses[PATH + 'history.json'],
    }),
  )
  await s.panel
    .getByRole('button', { name: 'Version history', exact: true })
    .click()
  await expect(s.panel.locator('[data-history-frame-after]')).toBeVisible()
  const before = page.frameLocator('[data-history-frame-before]'),
    after = page.frameLocator('[data-history-frame-after]')
  await expect(before.locator('del.history-diff-remove')).toHaveText('old')
  await expect(after.locator('ins.history-diff-add')).toHaveText('new')
  await expect(after.locator('a')).not.toHaveAttribute('href')
  await expect(s.panel.locator('[data-history-list]')).toContainText(
    'Deleted in this commit',
  )
  await expect(
    s.panel
      .getByRole('combobox', { name: 'Before version', exact: true })
      .locator('option'),
  ).toHaveCount(2)
  await s.panel
    .getByRole('combobox', { name: 'Before version', exact: true })
    .selectOption('a'.repeat(40))
  await expect(s.panel.locator('[data-history-status]')).toContainText(
    'No changes',
  )
  await s.panel
    .getByRole('combobox', { name: 'After version', exact: true })
    .selectOption('b'.repeat(40))
  await expect(before.locator('del.history-diff-remove')).toHaveText('new')
  expect(s.mutations).toEqual([])
})

test('stale build data is unavailable and never interpreted as empty history', async ({
  page,
  baseURL,
}) => {
  const s = await setup(page, baseURL!),
    identity = JSON.parse(
      (await s.panel.getAttribute('data-history-page')) ?? 'null',
    ),
    responses = assets({ ...identity, buildCommit: '9'.repeat(40) })
  await page.route('**/history.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: responses[PATH + 'history.json'],
    }),
  )
  await page.route('**/history-rendered/index.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: responses[PATH + 'history-rendered/index.json'],
    }),
  )
  await s.panel
    .getByRole('button', { name: 'Version history', exact: true })
    .click()
  await expect(s.panel.locator('[data-history-status]')).toContainText(
    'History unavailable',
  )
  await expect(
    s.panel.getByRole('button', { name: 'Retry history' }),
  ).toBeVisible()
  await expect(s.panel.locator('[data-history-frame-before]')).toBeHidden()
  expect(s.mutations).toEqual([])
})

test('unsupported historical resource markup never reaches either sandbox', async ({
  page,
  baseURL,
}) => {
  const s = await setup(page, baseURL!),
    identity = JSON.parse(
      (await s.panel.getAttribute('data-history-page')) ?? 'null',
    ),
    responses = assets(identity, true)
  await page.route('**/history.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: responses[PATH + 'history.json'],
    }),
  )
  await page.route('**/history-rendered/*.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: responses[new URL(route.request().url()).pathname],
    }),
  )
  await s.panel
    .getByRole('button', { name: 'Version history', exact: true })
    .click()
  await expect(s.panel.locator('[data-history-status]')).toContainText(
    'History unavailable',
  )
  await expect(s.panel.locator('[data-history-frame-after]')).toBeHidden()
  expect(s.mutations).toEqual([])
})
