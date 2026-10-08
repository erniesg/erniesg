import { expect, test, type Page } from '@playwright/test'
import { formatHunks } from '../../src/annotations/criticmarkup'
import { installStaticRoutes } from './static-build'

// Synthetic browser contracts only. Root admits execution separately; these
// do not establish real-account usability or a human visual review.
const PATH = '/margin/review/'
const source = 'https://ernie.sg/books/chapter/'
const row = (id: string, extra = {}) => ({
  id,
  type: 'Annotation',
  motivation: 'editing',
  created: '2026-10-07T00:00:00.000Z',
  target: { source },
  'margin:revision': 2,
  'margin:visibility': 'private',
  body: {
    type: 'TextualBody',
    format: 'text/plain',
    value: formatHunks([
      {
        baseStartLine: 1,
        baseEndLine: 1,
        criticMarkup:
          'A {--old--}{++<img src=x onerror=alert(1)>++} {~~left~>right~~}',
      },
    ]),
  },
  ...extra,
})
async function service(
  page: Page,
  baseURL: string,
  reply: (
    url: URL,
  ) =>
    | { status: number; body: unknown }
    | Promise<{ status: number; body: unknown }>,
) {
  await installStaticRoutes(page)
  const calls: string[] = []
  const forbidden: string[] = []
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    if (url.origin !== new URL(baseURL).origin || request.method() !== 'GET') {
      forbidden.push(request.method() + ' ' + url.origin)
      await route.abort()
      return
    }
    if (url.pathname === '/api/margin/v1/proposals') {
      calls.push(url.pathname + url.search)
      const response = await reply(url)
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      })
      return
    }
    if (url.pathname === '/auth/me') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        // Identity only: these flags grant no queue authority. The tests below
        // still exercise the service's own401/403/unavailable distinctions.
        body: JSON.stringify({
          authenticated: true,
          principal: {
            provider: 'fixture',
            issuer: 'urn:test',
            subject: 'admin',
          },
          canWrite: false,
          isAdmin: false,
        }),
      })
      return
    }
    await route.fallback()
  })
  return { calls, forbidden }
}

test('marked current changes remain literal and clearly separate from approved content at three widths', async ({
  page,
  baseURL,
}) => {
  const s = await service(page, baseURL!, (url) => ({
    status: 200,
    body: {
      annotations:
        url.searchParams.get('state') === 'approved'
          ? [
              row('private-proposal', {
                'margin:proposalState': 'approved',
                'margin:approvedRevision': 1,
              }),
            ]
          : [],
    },
  }))
  await page.goto(PATH)
  await page.getByRole('combobox', { name: 'State', exact: true }).selectOption('approved')
  await page.getByRole('button', { name: 'Filter proposals' }).click()
  const article = page.locator('[data-review-rows] article')
  await expect(article).toContainText('Current revision 2')
  await expect(article).toContainText('Approved revision 1')
  await expect(article).toContainText('not the approved snapshot')
  await expect(article.locator('del')).toHaveText(['old', 'left'])
  await expect(article.locator('ins')).toHaveText([
    '<img src=x onerror=alert(1)>',
    'right',
  ])
  await expect(article.locator('img, script, iframe')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /^(save|apply|approve)$/i }),
  ).toHaveCount(0)
  for (const width of [390, 1280, 2560]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(article).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  expect(
    s.calls.every(
      (call) => new URL(call, baseURL).searchParams.get('scope') === 'review',
    ),
  ).toBe(true)
  expect(s.forbidden).toEqual([])
})

test('server denial, unavailable, malformed and empty results stay distinct and retry rechecks server', async ({
  page,
  baseURL,
}) => {
  let result = { status: 401, body: {} as unknown }
  const s = await service(page, baseURL!, () => result)
  await page.goto(PATH)
  await expect(page.getByRole('status')).toContainText('Sign in')
  await expect(page.locator('[data-review-sign-in]')).toBeVisible()
  for (const [status, body, message] of [
    [403, {}, 'does not have'],
    [503, {}, 'unavailable'],
    [200, {}, 'could not be read safely'],
    [200, { annotations: [] }, 'No proposals match'],
  ] as const) {
    result = { status, body }
    await page.getByRole('button', { name: 'Filter proposals' }).click()
    await expect(page.getByRole('status')).toContainText(message)
    await expect(page.locator('[data-review-rows] article')).toHaveCount(0)
    if (status === 503) {
      result = { status: 200, body: { annotations: [row('recovered')] } }
      await page.getByRole('button', { name: 'Try again' }).click()
      await expect(page.locator('[data-review-rows] article')).toHaveCount(1)
    }
  }
  expect(s.forbidden).toEqual([])
})

test('bounded pagination and document/state reset preserve literal cursor without document fetches', async ({
  page,
  baseURL,
}) => {
  const s = await service(page, baseURL!, (url) => ({
    status: 200,
    body: url.searchParams.has('document')
      ? { annotations: [] }
      : url.searchParams.has('cursor')
        ? { annotations: [row('second')] }
        : { annotations: [row('first')], nextCursor: 'opaque cursor' },
  }))
  await page.goto(PATH)
  await page.getByRole('button', { name: 'Load more proposals' }).click()
  await expect(page.locator('[data-review-rows] article')).toHaveCount(2)
  expect(new URL(s.calls[1], baseURL).searchParams.get('cursor')).toBe(
    'opaque cursor',
  )
  await page
    .getByLabel('Document path')
    .fill('/books/elsewhere/?edition=one#point')
  await page.getByRole('button', { name: 'Filter proposals' }).click()
  await expect(page.getByRole('status')).toContainText('No proposals match')
  expect(new URL(s.calls.at(-1)!, baseURL).searchParams.has('cursor')).toBe(
    false,
  )
  expect(s.forbidden).toEqual([])
})

test('late response from old filters cannot repaint private rows after a new empty result', async ({
  page,
  baseURL,
}) => {
  let release!: () => void
  let waiting = false
  await service(page, baseURL!, async (url) => {
    if (url.searchParams.get('state') === 'pending') {
      waiting = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { status: 200, body: { annotations: [row('stale-private')] } }
    }
    return { status: 200, body: { annotations: [] } }
  })
  await page.goto(PATH, { waitUntil: 'domcontentloaded' })
  await expect.poll(() => waiting).toBe(true)
  await page.getByRole('combobox', { name: 'State', exact: true }).selectOption('merged')
  await page.getByRole('button', { name: 'Filter proposals' }).click()
  await expect(page.getByRole('status')).toContainText('No proposals match')
  release()
  await expect(page.locator('[data-review-rows] article')).toHaveCount(0)
})

async function savingService(
  page: Page,
  baseURL: string,
  mode: 'success' | 'lost' | 'conflict' = 'success',
) {
  await installStaticRoutes(page)
  const principal = {
    provider: 'fixture',
    issuer: 'urn:test',
    subject: 'admin',
  }
  let identity: unknown = {
    authenticated: true,
    principal,
    canWrite: false,
    isAdmin: false,
  }
  const proposal = row('urn:margin:annotation:save-target', {
    'margin:baseCommit': 'a'.repeat(40),
    'margin:sourcePath': 'books/chapter.md',
  })
  let savedReview: unknown = null
  const writes: unknown[] = [],
    forbidden: string[] = []
  let readbacks = 0
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    if (url.origin !== new URL(baseURL).origin) {
      forbidden.push('external')
      await route.abort()
      return
    }
    const reply = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    if (url.pathname === '/auth/me' && request.method() === 'GET') {
      await reply(identity)
      return
    }
    if (
      url.pathname === '/api/margin/v1/proposals' &&
      request.method() === 'GET'
    ) {
      await reply({ annotations: [proposal] })
      return
    }
    if (
      url.pathname === '/api/margin/v1/proposals/save-target/review' &&
      url.searchParams.get('source') === source
    ) {
      if (request.method() === 'GET') {
        readbacks++
        await reply({ annotation: proposal, savedReview })
        return
      }
      if (request.method() === 'POST') {
        const body = request.postDataJSON()
        writes.push(body)
        if (mode !== 'conflict')
          savedReview = {
            ...body,
            reviewer: 'urn:margin:principal:fixture:urn%3Atest:admin',
            at: '2026-10-08T00:00:00.000Z',
          }
        await reply(
          mode === 'success' ? proposal : {},
          mode === 'success' ? 200 : mode === 'lost' ? 503 : 409,
        )
        return
      }
    }
    if (request.method() !== 'GET' || url.pathname.startsWith('/api/margin/')) {
      forbidden.push(request.method() + ' ' + url.pathname)
      await route.abort()
      return
    }
    await route.fallback()
  })
  return {
    writes,
    forbidden,
    readbacks: () => readbacks,
    switchPrincipal: () => {
      identity = {
        authenticated: true,
        principal: { ...principal, subject: 'other' },
      }
    },
  }
}

test('Save records only decision/comments and displays literal authoritative metadata at three widths', async ({
  page,
  baseURL,
}) => {
  const s = await savingService(page, baseURL!)
  await page.goto(PATH)
  await page.getByRole('button', { name: 'Open review', exact: true }).click()
  const panel = page.locator('[data-review-session]')
  await expect(panel).toContainText('No saved review')
  await page.getByLabel('Review decision', { exact: true }).fill(' ready ')
  await page
    .getByLabel('Review comments', { exact: true })
    .fill('<img src=x onerror=alert(1)>')
  await page.getByRole('button', { name: 'Save review', exact: true }).click()
  await expect(panel).toContainText('Save acknowledged')
  await expect(panel).toContainText('<img src=x onerror=alert(1)>')
  await expect(panel.locator('img, script, iframe')).toHaveCount(0)
  expect(s.writes).toEqual([
    {
      revision: 2,
      decision: 'ready',
      comments: '<img src=x onerror=alert(1)>',
    },
  ])
  expect(s.readbacks()).toBe(2)
  await expect(
    page.getByRole('button', { name: /^(apply|approve)$/i }),
  ).toHaveCount(0)
  for (const width of [390, 1280, 2560]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(panel).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  expect(s.forbidden).toEqual([])
})

test('uncertain Save shows current values without replay and deliberate refresh restores eligibility', async ({
  page,
  baseURL,
}) => {
  const s = await savingService(page, baseURL!, 'lost')
  await page.goto(PATH)
  await page.getByRole('button', { name: 'Open review', exact: true }).click()
  await page.getByLabel('Review decision', { exact: true }).fill('ready')
  await page
    .getByLabel('Review comments', { exact: true })
    .fill('retained draft')
  await page.getByRole('button', { name: 'Save review', exact: true }).click()
  const panel = page.locator('[data-review-session]')
  await expect(panel).toContainText('Save outcome is uncertain')
  await expect(panel).toContainText('matching values do not identify')
  await expect(
    page.getByRole('button', { name: 'Save review', exact: true }),
  ).toBeDisabled()
  expect(s.writes).toHaveLength(1)
  expect(s.readbacks()).toBe(2)
  await page.getByRole('button', { name: 'Refresh selected review' }).click()
  await expect(
    page.getByRole('button', { name: 'Save review', exact: true }),
  ).toBeEnabled()
  expect(s.writes).toHaveLength(1)
  await page.getByRole('button', { name: 'Close selected review' }).click()
  await expect(panel).toBeHidden()
  expect(await page.locator('[name=comments]').inputValue()).toBe('')
  expect(s.forbidden).toEqual([])
})

test('observed identity switch before Save clears queue and private draft with zero writes', async ({
  page,
  baseURL,
}) => {
  const s = await savingService(page, baseURL!)
  await page.goto(PATH)
  await page.getByRole('button', { name: 'Open review', exact: true }).click()
  await page.getByLabel('Review decision', { exact: true }).fill('ready')
  await page
    .getByLabel('Review comments', { exact: true })
    .fill('private draft')
  s.switchPrincipal()
  await page.getByRole('button', { name: 'Save review', exact: true }).click()
  await expect(page.locator('[data-review-rows] article')).toHaveCount(0)
  await expect(page.locator('[data-review-session]')).toContainText(
    'account changed',
  )
  expect(await page.locator('[name=comments]').inputValue()).toBe('')
  expect(s.writes).toHaveLength(0)
  expect(s.forbidden).toEqual([])
})
