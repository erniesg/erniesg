import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const STATIC_BUILD_DIRECTORY = process.env.SRT_STATIC_BUILD_DIR
  ? resolve(process.env.SRT_STATIC_BUILD_DIR)
  : null
const WORKERS_DEV_BASE_URL = process.env.SRT_WORKERS_DEV_BASE_URL

if (STATIC_BUILD_DIRECTORY && WORKERS_DEV_BASE_URL) {
  throw new Error(
    'SRT_STATIC_BUILD_DIR and SRT_WORKERS_DEV_BASE_URL are mutually exclusive',
  )
}

const STATIC_ROUTE_ORIGIN = 'https://srt-evaluation.test'

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

function staticPath(pathname: string) {
  if (!STATIC_BUILD_DIRECTORY) {
    throw new Error('Static build mode is not enabled')
  }
  const candidate = resolve(
    STATIC_BUILD_DIRECTORY,
    decodeURIComponent(pathname).replace(/^\/+/, ''),
  )
  if (
    candidate !== STATIC_BUILD_DIRECTORY &&
    !candidate.startsWith(`${STATIC_BUILD_DIRECTORY}${sep}`)
  ) {
    throw new Error('Static route escaped the build directory')
  }
  return candidate
}

async function staticFile(pathname: string) {
  let candidate = staticPath(pathname)
  try {
    if ((await stat(candidate)).isDirectory()) {
      candidate = resolve(candidate, 'index.html')
    }
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT' &&
      extname(candidate) === ''
    ) {
      candidate = resolve(candidate, 'index.html')
    } else {
      throw error
    }
  }
  return {
    body: await readFile(candidate),
    contentType:
      STATIC_CONTENT_TYPES[extname(candidate).toLocaleLowerCase()] ??
      'application/octet-stream',
  }
}

export async function installStaticRoutes(page: Page) {
  if (!STATIC_BUILD_DIRECTORY) return
  await page.route(`${STATIC_ROUTE_ORIGIN}/**`, async (route) => {
    try {
      const file = await staticFile(new URL(route.request().url()).pathname)
      await route.fulfill({
        status: 200,
        body: file.body,
        contentType: file.contentType,
      })
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        await route.fulfill({ status: 404, body: 'Not found' })
        return
      }
      throw error
    }
  })
}

export async function jsonFixture<T>(
  request: APIRequestContext,
  pathname: string,
) {
  if (STATIC_BUILD_DIRECTORY) {
    const file = await staticFile(pathname)
    return JSON.parse(file.body.toString()) as T
  }
  const response = await request.get(pathname)
  expect(response.ok()).toBe(true)
  return (await response.json()) as T
}
