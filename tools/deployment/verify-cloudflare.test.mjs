import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const verifier = fileURLToPath(
  new URL('./verify-cloudflare.mjs', import.meta.url),
)
const temporaryDirectories = []

function fixtureModule({ cleanUrlStatus, deploymentMarker, noindex }) {
  return `
const cleanUrlStatus = ${JSON.stringify(cleanUrlStatus)}
const deploymentMarker = ${JSON.stringify(deploymentMarker)}
const noindex = ${JSON.stringify(noindex)}

function html(locale, author, labels, canonicalPath) {
  const alternates = ['en', 'zh', 'ko', 'ja', 'x-default']
    .map((value) => \`<link rel="alternate" hreflang="\${value}" href="https://ernie.sg/\${value}" />\`)
    .join('')
  return \`<!doctype html><html lang="\${locale}"><head><link rel="canonical" href="https://ernie.sg\${canonicalPath}" />\${alternates}</head><body>\${author} \${labels.join(' ')}</body></html>\`
}

const localized = new Map([
  ['/blog/moving-to-cloudflare-with-astro/', html('en', 'Chen Enjiao (Ernie)', ['Hosting', 'Web development'], '/blog/moving-to-cloudflare-with-astro')],
  ['/blog/moving-to-cloudflare-with-astro/zh/', html('zh-Hans', '陈恩娇（Ernie）', ['托管', 'Web 开发'], '/blog/moving-to-cloudflare-with-astro/zh')],
  ['/blog/moving-to-cloudflare-with-astro/ko/', html('ko', 'Chen Enjiao (Ernie)', ['호스팅', '웹 개발'], '/blog/moving-to-cloudflare-with-astro/ko')],
  ['/blog/moving-to-cloudflare-with-astro/ja/', html('ja', 'Chen Enjiao (Ernie)', ['ホスティング', 'Web開発'], '/blog/moving-to-cloudflare-with-astro/ja')],
])

globalThis.fetch = async (input) => {
  const url = new URL(input)
  const headers = new Headers({
    server: 'cloudflare',
    'x-content-type-options': 'nosniff',
  })
  if (deploymentMarker) headers.set('x-ernie-deployment', deploymentMarker)
  if (noindex) headers.set('x-robots-tag', 'noindex')

  if (url.pathname === '/blog/161hmmds') {
    headers.set('location', '/blog/161hmmds/')
    return new Response(null, { status: cleanUrlStatus, headers })
  }
  if (url.pathname === '/blog/161hmmds/') {
    headers.set('content-type', 'text/html')
    return new Response('https://ernie.sg/blog/a-i-for-humans-building-a-i-native-products-and-treating-data', { status: 200, headers })
  }
  if (url.pathname === '/migration-404-proof') {
    headers.set('content-type', 'text/html')
    return new Response('404: Page not found', { status: 404, headers })
  }
  if (url.pathname === '/static/logo.svg') {
    headers.set('content-type', 'image/svg+xml')
    return new Response('<svg></svg>', { status: 200, headers })
  }
  if (url.pathname === '/robots.txt') {
    headers.set('content-type', 'text/plain')
    return new Response('Sitemap: https://ernie.sg/sitemap-index.xml', { status: 200, headers })
  }
  if (url.pathname === '/sitemap-index.xml') {
    headers.set('content-type', 'application/xml')
    return new Response('<sitemapindex></sitemapindex>', { status: 200, headers })
  }
  if (url.pathname === '/rss.xml') {
    headers.set('content-type', 'application/xml')
    return new Response('<rss>https://ernie.sg/</rss>', { status: 200, headers })
  }
  if (localized.has(url.pathname)) {
    headers.set('content-type', 'text/html')
    return new Response(localized.get(url.pathname), { status: 200, headers })
  }
  headers.set('content-type', 'text/html')
  return new Response('Essays and experiments', { status: 200, headers })
}
`
}

async function runVerifier({
  platform,
  cleanUrlStatus,
  deploymentMarker = null,
  noindex = false,
}) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudflare-verifier-'))
  temporaryDirectories.push(directory)
  const fixture = join(directory, 'fixture-fetch.mjs')
  await writeFile(
    fixture,
    fixtureModule({ cleanUrlStatus, deploymentMarker, noindex }),
  )
  const hostname =
    platform === 'workers' ? 'fixture.workers.dev' : 'fixture.pages.dev'
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        fixture,
        verifier,
        '--base',
        `https://${hostname}`,
        '--expect',
        platform,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('Cloudflare serving-platform verification', () => {
  it('accepts platform-neutral shared content headers on Pages', async () => {
    const result = await runVerifier({
      platform: 'pages',
      cleanUrlStatus: 308,
      deploymentMarker: 'workers-static-assets',
    })

    expect(result).toMatchObject({ code: 0, stderr: '' })
  })

  it('identifies Workers from 307 behavior without a content marker', async () => {
    const result = await runVerifier({
      platform: 'workers',
      cleanUrlStatus: 307,
      noindex: true,
    })

    expect(result).toMatchObject({ code: 0, stderr: '' })
  })

  it('rejects Pages redirect behavior when Workers is expected', async () => {
    const result = await runVerifier({
      platform: 'workers',
      cleanUrlStatus: 308,
      noindex: true,
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('unexpected clean-URL status 308')
  })

  it('still requires noindex on a workers.dev preview', async () => {
    const result = await runVerifier({
      platform: 'workers',
      cleanUrlStatus: 307,
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('workers.dev preview is not marked noindex')
  })
})
