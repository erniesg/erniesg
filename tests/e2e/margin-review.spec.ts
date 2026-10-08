import { expect, test, type Page } from '@playwright/test'
import {
  formatHunks,
  parseHunks,
  acceptAll,
  rejectAll,
} from '../../src/annotations/criticmarkup'
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
  await page
    .getByRole('combobox', { name: 'State', exact: true })
    .selectOption('approved')
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
  await page
    .getByRole('combobox', { name: 'State', exact: true })
    .selectOption('merged')
  await page.getByRole('button', { name: 'Filter proposals' }).click()
  await expect(page.getByRole('status')).toContainText('No proposals match')
  release()
  await expect(page.locator('[data-review-rows] article')).toHaveCount(0)
})

async function savingService(
  page: Page,
  baseURL: string,
  mode: 'success' | 'lost' | 'conflict' = 'success',
  initialBody?: string,
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
  let proposal = row('urn:margin:annotation:save-target', {
    'margin:baseCommit': 'a'.repeat(40),
    'margin:sourcePath': 'books/chapter.md',
  })
  if (initialBody !== undefined)
    proposal = { ...proposal, body: { ...proposal.body, value: initialBody } }
  let savedReview: unknown = null
  let execution: any = null,
    readStatus = 200
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
        expect(url.searchParams.get('include')).toBe('execution')
        expect([...url.searchParams.keys()].sort()).toEqual([
          'include',
          'source',
        ])
        readbacks++
        await reply(
          { annotation: proposal, savedReview, execution },
          readStatus,
        )
        return
      }
      if (request.method() === 'POST') {
        expect([...url.searchParams.keys()]).toEqual(['source'])
        const body = request.postDataJSON()
        writes.push(body)
        if (mode !== 'conflict') {
          if (body.body !== undefined)
            proposal = {
              ...proposal,
              'margin:revision': proposal['margin:revision'] + 1,
              body: { ...proposal.body, value: body.body },
            }
          savedReview = {
            revision: proposal['margin:revision'],
            decision: body.decision,
            comments: body.comments,
            reviewer: 'urn:margin:principal:fixture:urn%3Atest:admin',
            at: '2026-10-08T00:00:00.000Z',
          }
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
    current: () => proposal,
    observe: (value: any, state = 'approved') => {
      execution = value
      proposal = {
        ...proposal,
        'margin:revision': 3,
        'margin:approvedRevision': 1,
        'margin:proposalState': state,
      } as typeof proposal
    },
    readStatus: (status: number) => {
      readStatus = status
    },
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

test('a revised pending proposal saves only its displayed marked draft and keeps source binding at three widths', async ({
  page,
  baseURL,
}) => {
  const s = await savingService(page, baseURL!)
  const original = parseHunks(s.current().body.value)[0]
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto(PATH)
  await page.getByRole('button', { name: 'Open review', exact: true }).click()
  await page.getByLabel('Review decision', { exact: true }).fill('revise')
  await page
    .getByRole('button', { name: /^Edit proposed text · base lines/ })
    .click()
  const input = page.getByRole('textbox', {
    name: /^Proposed text · base lines/,
  })
  const edited = 'Revised <img src=x onerror=alert(1)> text.'
  await input.fill(edited)
  const save = page.getByRole('button', { name: 'Save review', exact: true })
  await expect(save).toBeDisabled()
  expect(s.writes).toHaveLength(0)
  await page
    .getByRole('button', { name: 'Update marked changes', exact: true })
    .click()
  const panel = page.locator('[data-review-session]')
  await expect(panel.locator('[data-review-draft-status]')).toContainText(
    'Unsaved proposed changes',
  )
  await expect(panel.locator('img,script,iframe')).toHaveCount(0)
  await expect(save).toBeEnabled()
  await save.click()
  await expect(panel.locator('[data-review-session-status]')).toContainText(
    'Save acknowledged',
  )
  await expect(panel).toContainText('Current revision 3 · pending')
  await expect(panel).toContainText('Saved review for revision 3')
  expect(s.writes).toHaveLength(1)
  const write = s.writes[0] as {
    revision: number
    decision: string
    comments: string
    body: string
  }
  expect(Object.keys(write).sort()).toEqual([
    'body',
    'comments',
    'decision',
    'revision',
  ])
  expect(write.revision).toBe(2)
  const stored = parseHunks(write.body)[0]
  expect(rejectAll(stored.criticMarkup)).toBe(rejectAll(original.criticMarkup))
  expect(acceptAll(stored.criticMarkup)).toBe(edited)
  expect(stored.baseStartLine).toBe(original.baseStartLine)
  expect(stored.baseEndLine).toBe(original.baseEndLine)
  expect(s.current()).toMatchObject({
    'margin:baseCommit': 'a'.repeat(40),
    'margin:sourcePath': 'books/chapter.md',
  })
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

test('a real textarea character edit preserves CRLF and BOM in the submitted proposal', async ({
  page,
  baseURL,
}) => {
  const before = '\uFEFFFirst\r\nsecond\r\n'
  const initial = formatHunks([
    { baseStartLine: 2, baseEndLine: 3, criticMarkup: before },
  ])
  const s = await savingService(page, baseURL!, 'success', initial)
  await page.goto(PATH)
  await page.getByRole('button', { name: 'Open review', exact: true }).click()
  await page.getByLabel('Review decision', { exact: true }).fill('revise')
  await page
    .getByRole('button', { name: /^Edit proposed text · base lines/ })
    .click()
  const input = page.getByRole('textbox', {
    name: /^Proposed text · base lines/,
  })
  // Assert the actual browser normalization rather than feeding CRLF directly
  // into ReviewDraft. A keyboard edit must not rewrite untouched line endings.
  expect(await input.inputValue()).toBe('\uFEFFFirst\nsecond\n')
  await input.focus()
  await input.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(6, 6),
  )
  await page.keyboard.insertText('!')
  expect(await input.inputValue()).toBe('\uFEFFFirst!\nsecond\n')
  await page
    .getByRole('button', { name: 'Update marked changes', exact: true })
    .click()
  await page.getByRole('button', { name: 'Save review', exact: true }).click()
  await expect(page.locator('[data-review-session-status]')).toContainText(
    'Save acknowledged',
  )
  expect(s.writes).toHaveLength(1)
  const hunk = parseHunks((s.writes[0] as { body: string }).body)[0]
  expect(acceptAll(hunk.criticMarkup)).toBe('\uFEFFFirst!\r\nsecond\r\n')
  expect(rejectAll(hunk.criticMarkup)).toBe(before)
  expect([hunk.baseStartLine, hunk.baseEndLine]).toEqual([2, 3])
  expect(s.forbidden).toEqual([])
})

test('cancel and discard keep stored text while invalid unmaterialized input cannot Save', async ({
  page,
  baseURL,
}) => {
  const s = await savingService(page, baseURL!)
  const original = s.current().body.value
  await page.goto(PATH)
  await page.getByRole('button', { name: 'Open review', exact: true }).click()
  await page.getByLabel('Review decision', { exact: true }).fill('ready')
  const open = () =>
    page
      .getByRole('button', { name: /^Edit proposed text · base lines/ })
      .click()
  const input = page.getByRole('textbox', {
    name: /^Proposed text · base lines/,
  })
  await open()
  await input.fill('{~~old~>new~~}')
  await page
    .getByRole('button', { name: 'Update marked changes', exact: true })
    .click()
  await expect(page.locator('[data-review-draft-status]')).toContainText(
    'cannot be represented',
  )
  await expect(
    page.getByRole('button', { name: 'Save review', exact: true }),
  ).toBeDisabled()
  await page
    .getByRole('button', { name: 'Cancel this edit', exact: true })
    .click()
  await open()
  await input.fill('A saved later draft.')
  await page
    .getByRole('button', { name: 'Update marked changes', exact: true })
    .click()
  await expect(page.locator('[data-review-draft-status]')).toContainText(
    'Unsaved',
  )
  await page
    .getByRole('button', { name: 'Discard unsaved changes', exact: true })
    .click()
  await expect(page.locator('[data-review-draft-status]')).toHaveText(
    'Stored proposed changes.',
  )
  await page.getByRole('button', { name: 'Save review', exact: true }).click()
  await expect(page.locator('[data-review-session-status]')).toContainText(
    'Save acknowledged',
  )
  expect(s.writes).toEqual([{ revision: 2, decision: 'ready', comments: '' }])
  expect(s.current().body.value).toBe(original)
  expect(s.forbidden).toEqual([])
})

test('edited uncertain writes never replay and account changes clear the revised body', async ({
  page,
  baseURL,
}) => {
  const s = await savingService(page, baseURL!, 'lost')
  await page.goto(PATH)
  await page.getByRole('button', { name: 'Open review', exact: true }).click()
  await page.getByLabel('Review decision', { exact: true }).fill('revise')
  await page
    .getByRole('button', { name: /^Edit proposed text · base lines/ })
    .click()
  await page
    .getByRole('textbox', { name: /^Proposed text · base lines/ })
    .fill('Private revised fixture text')
  await page
    .getByRole('button', { name: 'Update marked changes', exact: true })
    .click()
  await page.getByRole('button', { name: 'Save review', exact: true }).click()
  await expect(page.locator('[data-review-session-status]')).toContainText(
    'Save outcome is uncertain',
  )
  await expect(
    page.getByRole('button', { name: 'Save review', exact: true }),
  ).toBeDisabled()
  expect(s.writes).toHaveLength(1)
  await page
    .getByRole('button', { name: 'Refresh selected review', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Save review', exact: true }),
  ).toBeEnabled()
  s.switchPrincipal()
  await page.getByRole('button', { name: 'Save review', exact: true }).click()
  await expect(page.locator('[data-review-rows] article')).toHaveCount(0)
  await expect(page.locator('[data-review-session]')).not.toContainText(
    'Private revised fixture text',
  )
  expect(await page.locator('[data-review-proposed-text]').inputValue()).toBe(
    '',
  )
  expect(s.writes).toHaveLength(1)
  expect(s.forbidden).toEqual([])
})

const reportedPR = {
  number: 7,
  url: 'http://example.test/pull/7',
  head: 'a'.repeat(64),
}
const approvedExecution = {
  approvedRevision: 1,
  state: 'approved',
  stateVersion: 0,
  failedApplyCount: 0,
  pr: null,
  checks: null,
  detail: null,
  mergeCommit: null,
  updatedAt: '2026-10-08T00:01:00.000Z',
}

test('private progress distinguishes pending, legacy unknown, and reported PR results at three widths', async ({
  page,
  baseURL,
}) => {
  const s = await savingService(page, baseURL!)
  await page.goto(PATH)
  await page.getByRole('button', { name: 'Open review', exact: true }).click()
  const panel = page.locator('[data-review-session]'),
    progress = panel.getByRole('region', {
      name: 'Execution progress',
      exact: true,
    })
  await expect(progress).toContainText('No approved execution record.')
  s.observe(null)
  await page
    .getByRole('button', { name: 'Refresh selected review', exact: true })
    .click()
  await expect(progress).toContainText(
    'Failure count and repository outcome are unknown.',
  )
  await expect(progress).not.toContainText('0 of 3')
  s.observe(approvedExecution)
  await page
    .getByRole('button', { name: 'Refresh selected review', exact: true })
    .click()
  await expect(progress).toContainText(
    'Approval recorded; no adapter result recorded.',
  )
  s.observe(
    {
      ...approvedExecution,
      state: 'pr_open',
      stateVersion: 2,
      pr: reportedPR,
      checks: 'passed',
    },
    'pr_open',
  )
  await page
    .getByRole('button', { name: 'Refresh selected review', exact: true })
    .click()
  await expect(progress).toContainText('Adapter-reported state: pr_open.')
  await expect(progress).toContainText(reportedPR.head)
  await expect(panel).toContainText('Current revision 3')
  await expect(panel).toContainText(
    'Approved revision 1. Showing current content, not the approved snapshot.',
  )
  await expect(
    page.getByRole('button', { name: 'Save review', exact: true }),
  ).toBeDisabled()
  const link = progress.getByRole('link', {
    name: 'Reported pull request #7',
    exact: true,
  })
  await expect(link).toHaveAttribute('href', reportedPR.url)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer')
  for (const width of [390, 1280, 2560]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(progress).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  expect(s.writes).toEqual([])
  expect(s.forbidden).toEqual([])
  expect(s.readbacks()).toBe(4)
})

test('reported conflict and terminal details stay literal and never imply verified policy or an Apply action', async ({
  page,
  baseURL,
}) => {
  const s = await savingService(page, baseURL!)
  const detail = '<img src=x onerror=alert(1)>\n  冲突 ' + 'é'.repeat(1000)
  s.observe(
    {
      ...approvedExecution,
      state: 'conflict',
      stateVersion: 2,
      pr: reportedPR,
      checks: 'not_evaluated',
      detail,
    },
    'conflict',
  )
  await page.goto(PATH)
  await page.getByRole('button', { name: 'Open review', exact: true }).click()
  const progress = page.getByRole('region', {
    name: 'Execution progress',
    exact: true,
  })
  await expect(progress).toContainText('Adapter-reported state: conflict.')
  expect(await progress.locator('pre').allTextContents()).toContain(
    'Adapter-reported detail: ' + detail,
  )
  await expect(progress.locator('img,script,iframe,button')).toHaveCount(0)
  for (const width of [390, 1280, 2560]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(progress).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  for (const [state, change] of [
    [
      'apply_failed',
      { failedApplyCount: 3, detail: 'Three recorded failures', pr: null },
    ],
    ['closed', { pr: reportedPR }],
    ['merged', { pr: reportedPR, mergeCommit: 'b'.repeat(64) }],
  ] as const) {
    s.observe(
      { ...approvedExecution, state, stateVersion: 3, ...change },
      state,
    )
    await page
      .getByRole('button', { name: 'Refresh selected review', exact: true })
      .click()
    await expect(progress).toContainText(
      'Adapter-reported state: ' + state + '.',
    )
    await expect(progress).toContainText(
      'Recorded results do not verify current repository policy or exclude unreported attempts.',
    )
  }
  await expect(
    page.getByRole('button', { name: /^(apply|approve|merge)$/i }),
  ).toHaveCount(0)
  expect(s.writes).toEqual([])
  expect(s.forbidden).toEqual([])
})

test('malformed or denied progress and observed account changes clear the private view without stale fallback', async ({
  page,
  baseURL,
}) => {
  const s = await savingService(page, baseURL!)
  s.observe(approvedExecution)
  await page.goto(PATH)
  await page.getByRole('button', { name: 'Open review', exact: true }).click()
  const panel = page.locator('[data-review-session]')
  await expect(
    panel.getByRole('region', { name: 'Execution progress' }),
  ).toBeVisible()
  s.observe({ ...approvedExecution, extra: 'not allowed' })
  await page
    .getByRole('button', { name: 'Refresh selected review', exact: true })
    .click()
  await expect(panel).toContainText('could not be read safely')
  await expect(
    panel.getByRole('region', { name: 'Execution progress' }),
  ).toHaveCount(0)
  s.observe(approvedExecution)
  await page
    .getByRole('button', { name: 'Refresh selected review', exact: true })
    .click()
  await expect(
    panel.getByRole('region', { name: 'Execution progress' }),
  ).toBeVisible()
  s.readStatus(403)
  await page
    .getByRole('button', { name: 'Refresh selected review', exact: true })
    .click()
  await expect(panel).toContainText('does not have site-admin review access')
  await expect(
    panel.getByRole('region', { name: 'Execution progress' }),
  ).toHaveCount(0)
  await expect(page.locator('[data-review-rows] article')).toHaveCount(0)
  s.readStatus(200)
  await page.reload()
  await page.getByRole('button', { name: 'Open review', exact: true }).click()
  await expect(
    panel.getByRole('region', { name: 'Execution progress' }),
  ).toBeVisible()
  s.switchPrincipal()
  await page
    .getByRole('button', { name: 'Refresh selected review', exact: true })
    .click()
  await expect(panel).toContainText(
    'The account changed. Private review data was cleared.',
  )
  await expect(
    panel.getByRole('region', { name: 'Execution progress' }),
  ).toHaveCount(0)
  await expect(page.locator('[data-review-rows] article')).toHaveCount(0)
  expect(s.writes).toEqual([])
  expect(s.forbidden).toEqual([])
})
