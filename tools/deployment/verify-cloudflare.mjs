import { createHash } from 'node:crypto'

import { parse } from 'parse5'

const args = process.argv.slice(2)

function readOption(name) {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return value
}

function normalizeBase(value) {
  const url = new URL(value)
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.href.replace(/\/$/, '')
}

const base = normalizeBase(readOption('--base') ?? '')
const compareBaseValue = readOption('--compare')
const compareBase = compareBaseValue ? normalizeBase(compareBaseValue) : null
const expectedPlatform = readOption('--expect') ?? 'any'

if (!['any', 'pages', 'workers'].includes(expectedPlatform)) {
  throw new Error('--expect must be one of: any, pages, workers')
}

const failures = []
const results = []

function assert(condition, message) {
  if (!condition) failures.push(message)
}

function headerValue(headers, name) {
  return headers.get(name) ?? ''
}

function contentTypeEssence(headers) {
  return headerValue(headers, 'content-type').split(';')[0].trim()
}

async function fetchArtifact(targetBase, path) {
  const url = new URL(path, `${targetBase}/`)
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  return {
    url: url.href,
    path,
    status: response.status,
    headers: response.headers,
    body: bytes.toString('utf8'),
    digest: createHash('sha256').update(bytes).digest('hex'),
  }
}

function findElements(node, tagName, found = []) {
  if (node?.tagName === tagName) found.push(node)
  for (const child of node?.childNodes ?? [])
    findElements(child, tagName, found)
  return found
}

function getAttribute(node, name) {
  return (
    node?.attrs?.find((attribute) => attribute.name === name)?.value ?? null
  )
}

function documentText(node) {
  if (node?.nodeName === '#text') return node.value ?? ''
  return (node?.childNodes ?? []).map(documentText).join(' ')
}

function validateSharedHeaders(artifact, label) {
  assert(
    headerValue(artifact.headers, 'server') === 'cloudflare',
    `${label}: expected server: cloudflare`,
  )
  assert(
    headerValue(artifact.headers, 'x-content-type-options') === 'nosniff',
    `${label}: expected x-content-type-options: nosniff`,
  )

  if (
    expectedPlatform === 'workers' &&
    artifact.url.includes('.workers.dev/')
  ) {
    assert(
      headerValue(artifact.headers, 'x-robots-tag').includes('noindex'),
      `${label}: workers.dev preview is not marked noindex`,
    )
  }
}

function validateLocalizedPost(artifact, locale, authorName, tagLabels) {
  const label = `${artifact.path} (${locale})`
  assert(
    artifact.status === 200,
    `${label}: expected 200, got ${artifact.status}`,
  )
  assert(
    contentTypeEssence(artifact.headers) === 'text/html',
    `${label}: expected HTML content type`,
  )
  validateSharedHeaders(artifact, label)

  const document = parse(artifact.body)
  const html = findElements(document, 'html')[0]
  const expectedHtmlLang = {
    en: 'en',
    zh: 'zh-Hans',
    ko: 'ko',
    ja: 'ja',
  }[locale]
  assert(
    getAttribute(html, 'lang') === expectedHtmlLang,
    `${label}: expected html lang ${expectedHtmlLang}`,
  )

  const canonicalPath =
    locale === 'en'
      ? '/blog/moving-to-cloudflare-with-astro'
      : `/blog/moving-to-cloudflare-with-astro/${locale}`
  const links = findElements(document, 'link')
  const canonical = links.find(
    (link) => getAttribute(link, 'rel') === 'canonical',
  )
  assert(
    getAttribute(canonical, 'href') === `https://ernie.sg${canonicalPath}`,
    `${label}: canonical URL is incorrect`,
  )

  const alternates = new Map(
    links
      .filter((link) => getAttribute(link, 'rel') === 'alternate')
      .map((link) => [
        getAttribute(link, 'hreflang'),
        getAttribute(link, 'href'),
      ]),
  )
  for (const alternateLocale of ['en', 'zh', 'ko', 'ja', 'x-default']) {
    assert(
      alternates.has(alternateLocale),
      `${label}: missing hreflang ${alternateLocale}`,
    )
  }

  const text = documentText(document).replace(/\s+/g, ' ')
  assert(text.includes(authorName), `${label}: missing localized author name`)
  for (const tagLabel of tagLabels) {
    assert(text.includes(tagLabel), `${label}: missing tag label ${tagLabel}`)
  }
}

const postChecks = [
  {
    path: '/blog/moving-to-cloudflare-with-astro/',
    locale: 'en',
    authorName: 'Chen Enjiao (Ernie)',
    tagLabels: ['Hosting', 'Web development'],
  },
  {
    path: '/blog/moving-to-cloudflare-with-astro/zh/',
    locale: 'zh',
    authorName: '陈恩娇（Ernie）',
    tagLabels: ['托管', 'Web 开发'],
  },
  {
    path: '/blog/moving-to-cloudflare-with-astro/ko/',
    locale: 'ko',
    authorName: 'Chen Enjiao (Ernie)',
    tagLabels: ['호스팅', '웹 개발'],
  },
  {
    path: '/blog/moving-to-cloudflare-with-astro/ja/',
    locale: 'ja',
    authorName: 'Chen Enjiao (Ernie)',
    tagLabels: ['ホスティング', 'Web開発'],
  },
]

const home = await fetchArtifact(base, '/')
assert(home.status === 200, `/: expected 200, got ${home.status}`)
assert(
  home.body.includes('Essays and experiments'),
  '/: homepage copy is missing',
)
validateSharedHeaders(home, '/')
results.push(home)

for (const check of postChecks) {
  const artifact = await fetchArtifact(base, check.path)
  validateLocalizedPost(
    artifact,
    check.locale,
    check.authorName,
    check.tagLabels,
  )
  results.push(artifact)
}

const asset = await fetchArtifact(base, '/static/logo.svg')
assert(
  asset.status === 200,
  `/static/logo.svg: expected 200, got ${asset.status}`,
)
assert(
  contentTypeEssence(asset.headers) === 'image/svg+xml',
  '/static/logo.svg: incorrect content type',
)
assert(asset.body.includes('<svg'), '/static/logo.svg: SVG body is missing')
results.push(asset)

const redirectWithoutSlash = await fetchArtifact(base, '/blog/161hmmds')
const expectedCleanUrlStatus =
  expectedPlatform === 'workers'
    ? 307
    : expectedPlatform === 'pages'
      ? 308
      : null
assert(
  expectedCleanUrlStatus
    ? redirectWithoutSlash.status === expectedCleanUrlStatus
    : [307, 308].includes(redirectWithoutSlash.status),
  `/blog/161hmmds: unexpected clean-URL status ${redirectWithoutSlash.status}`,
)
assert(
  headerValue(redirectWithoutSlash.headers, 'location') === '/blog/161hmmds/',
  '/blog/161hmmds: trailing-slash redirect is incorrect',
)
results.push(redirectWithoutSlash)

const redirectPage = await fetchArtifact(base, '/blog/161hmmds/')
assert(redirectPage.status === 200, '/blog/161hmmds/: expected redirect page')
assert(
  redirectPage.body.includes(
    'https://ernie.sg/blog/a-i-for-humans-building-a-i-native-products-and-treating-data',
  ),
  '/blog/161hmmds/: legacy redirect target is incorrect',
)
results.push(redirectPage)

const notFound = await fetchArtifact(base, '/migration-404-proof')
assert(
  notFound.status === 404,
  `404 probe: expected 404, got ${notFound.status}`,
)
assert(
  notFound.body.includes('404: Page not found'),
  '404 probe: custom page is missing',
)
validateSharedHeaders(notFound, '/migration-404-proof')
results.push(notFound)

const robots = await fetchArtifact(base, '/robots.txt')
assert(robots.status === 200, `robots.txt: expected 200, got ${robots.status}`)
assert(
  robots.body.includes('Sitemap: https://ernie.sg/sitemap-index.xml'),
  'robots.txt: sitemap declaration is missing',
)
results.push(robots)

const sitemap = await fetchArtifact(base, '/sitemap-index.xml')
assert(sitemap.status === 200, `sitemap: expected 200, got ${sitemap.status}`)
assert(sitemap.body.includes('<sitemapindex'), 'sitemap: invalid index')
results.push(sitemap)

const rss = await fetchArtifact(base, '/rss.xml')
assert(rss.status === 200, `RSS: expected 200, got ${rss.status}`)
assert(rss.body.includes('<rss'), 'RSS: invalid feed')
assert(
  rss.body.includes('https://ernie.sg/'),
  'RSS: production links are missing',
)
results.push(rss)

if (compareBase) {
  for (const result of results) {
    const comparison = await fetchArtifact(compareBase, result.path)
    const equivalentCleanUrlRedirect =
      result.path === '/blog/161hmmds' &&
      [307, 308].includes(result.status) &&
      [307, 308].includes(comparison.status)
    assert(
      comparison.status === result.status || equivalentCleanUrlRedirect,
      `${result.path}: ${base} returned ${result.status}, ${compareBase} returned ${comparison.status}`,
    )
    assert(
      contentTypeEssence(comparison.headers) ===
        contentTypeEssence(result.headers),
      `${result.path}: content types differ between deployment targets`,
    )
    if (result.status >= 300 && result.status < 400) {
      assert(
        headerValue(comparison.headers, 'location') ===
          headerValue(result.headers, 'location'),
        `${result.path}: redirect locations differ between deployment targets`,
      )
    }
    if (['/static/logo.svg', '/robots.txt'].includes(result.path)) {
      assert(
        comparison.digest === result.digest,
        `${result.path}: content differs from the comparison deployment`,
      )
    }
  }
}

for (const result of results) {
  console.log(
    `${result.status} ${result.path} ${contentTypeEssence(result.headers) || '-'}`,
  )
}

if (failures.length > 0) {
  console.error(`\nVerification failed with ${failures.length} error(s):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(
    `\nVerified ${base}${compareBase ? ` against ${compareBase}` : ''}.`,
  )
}
