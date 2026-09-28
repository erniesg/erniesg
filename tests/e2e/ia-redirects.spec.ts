import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { EXPORT_PACKAGE_PATHS } from '../../src/research/export-package-paths'
import {
  isFilePath,
  paperIdsOnDisk,
  parseRedirectsFile,
  redirectTable,
  sourceRouteManifest,
  stubPath,
} from '../../tools/ia-redirects.mjs'
import { WITHHELD_IN_PRODUCTION } from '../../tools/deployment/release-gate.mjs'
import { installStaticRoutes } from './static-build'

/**
 * Every URL ADR 010 moved still answers, with a permanent redirect.
 *
 * The legacy URLs are not listed here. They are enumerated from the route
 * files under `src/pages/papers` and `src/pages/library` — the old research
 * routes now live there — and from every asset under `public/papers`, which
 * used to be `public/research`. A page or an asset added to either tree is in
 * this test the moment it exists.
 *
 * On the dev server this checks the 301s themselves. Pointed at a build with
 * `SRT_STATIC_BUILD_DIR`, it checks what actually deploys: the `_redirects`
 * table and the HTML stubs, after the production release gate has run.
 */

const ROOT = process.cwd()
const STATIC_BUILD_DIRECTORY = process.env.SRT_STATIC_BUILD_DIR
  ? path.resolve(process.env.SRT_STATIC_BUILD_DIR)
  : null
const REMOTE = Boolean(process.env.SRT_WORKERS_DEV_BASE_URL)

const manifest = sourceRouteManifest(ROOT, {
  id: paperIdsOnDisk(ROOT),
  file: [...EXPORT_PACKAGE_PATHS],
})
const table = redirectTable(manifest)

test.beforeEach(async ({ page }) => {
  await installStaticRoutes(page)
})

test('enumerates the legacy routes and the legacy assets', () => {
  const froms = table.map(({ from }) => from)

  expect(froms).toEqual(
    expect.arrayContaining([
      '/research',
      '/research/studio',
      '/research/pdf-review',
      '/study/experiments/pdf-to-epub',
      '/research/if-letters-home-could-sing/if-letters-home-could-sing.pdf',
      '/research/if-letters-home-could-sing/if-letters-home-could-sing.epub',
      '/research/if-letters-home-could-sing/media/image1.png',
    ]),
  )
  for (const id of paperIdsOnDisk(ROOT)) {
    expect(froms).toContain(`/research/${id}`)
    expect(froms).toContain(`/research/${id}/manifest.json`)
  }
})

test.describe('on the dev server', () => {
  test.skip(
    Boolean(STATIC_BUILD_DIRECTORY) || REMOTE,
    'The 301s are answered by the dev server; a build is checked below.',
  )

  test('answers every legacy URL with a 301 to its new home', async ({
    request,
  }) => {
    for (const { from, to, kind } of table) {
      for (const url of kind === 'page' ? [from, `${from}/`] : [from]) {
        const response = await request.get(url, { maxRedirects: 0 })
        expect(response.status(), url).toBe(301)
        expect(response.headers().location, url).toBe(to)
      }
    }
  })

  test('keeps the query string across the redirect', async ({ request }) => {
    const response = await request.get('/research/studio/?from=bookmark', {
      maxRedirects: 0,
    })

    expect(response.status()).toBe(301)
    expect(response.headers().location).toBe('/library/?from=bookmark')
  })

  test('lands every page and asset redirect somewhere that answers', async ({
    request,
  }) => {
    // Export files are generated on request, one full export package per
    // paper; their destinations are covered by the route manifest itself.
    const targets = new Set(
      table
        .map(({ to }) => to)
        .filter((to) => !to.includes('/exports/')),
    )
    for (const to of targets) {
      const response = await request.get(to)
      expect(response.status(), to).toBe(200)
    }
  })

  test('takes a reader from the old importer to the library', async ({
    page,
  }) => {
    await page.goto('/research/studio')
    await expect(page).toHaveURL(/\/library\/$/u)
    await expect(
      page.getByRole('heading', { name: 'Library', exact: true }),
    ).toBeVisible()
  })
})

test.describe('in the built site, after the release gate', () => {
  test.skip(!STATIC_BUILD_DIRECTORY, 'Set SRT_STATIC_BUILD_DIR to a build.')

  test('keeps a 301 for every legacy URL and a stub for every legacy page', () => {
    const directory = STATIC_BUILD_DIRECTORY!
    const entries = parseRedirectsFile(
      readFileSync(path.join(directory, '_redirects'), 'utf8'),
    )
    const byFrom = new Map(entries.map((entry) => [entry.from, entry]))
    // A production artifact has had its withheld trees removed, and with them
    // every redirect into them: those legacy URLs are plain 404s by design.
    const gated = WITHHELD_IN_PRODUCTION.every(
      (withheld) => !existsSync(path.join(directory, withheld)),
    )
    const intoWithheld = (to: string) =>
      WITHHELD_IN_PRODUCTION.some(
        (withheld) => to === `/${withheld}/` || to.startsWith(`/${withheld}/`),
      )

    for (const { from, to, kind } of table) {
      if (gated && intoWithheld(to)) {
        expect(byFrom.has(from), from).toBe(false)
        if (kind === 'page') {
          expect(existsSync(stubPath(directory, from)), from).toBe(false)
        }
        continue
      }
      expect(byFrom.get(from), from).toEqual({ from, to, status: 301 })
      if (kind === 'page') {
        expect(byFrom.get(`${from}/`), `${from}/`).toEqual({
          from: `${from}/`,
          to,
          status: 301,
        })
        expect(existsSync(stubPath(directory, from)), from).toBe(true)
      } else {
        expect(isFilePath(from)).toBe(true)
      }
    }
  })

  test('sends a browser on from a legacy stub', async ({ page }) => {
    await page.goto('/research/studio/')
    await expect(page).toHaveURL(/\/library\/$/u)
  })
})
