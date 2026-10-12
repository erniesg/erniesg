import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import fg from 'fast-glob'
import { parse, serialize } from 'parse5'
import { runCodexStructuredJson } from './codex-cli.mjs'

export const PAGE_CATALOG_VERSION = 1
export const PAGE_LOCALES = ['zh', 'ja', 'ko']

const HTML_LANG = { en: 'en', zh: 'zh-Hans', ja: 'ja', ko: 'ko' }
const PROTECTED_TAGS = new Set([
  'script',
  'style',
  'code',
  'pre',
  'kbd',
  'samp',
  'textarea',
  'svg',
  'math',
  'template',
  'iframe',
  'object',
  'embed',
  'canvas',
])
const READER_ATTRIBUTES = new Set(['alt', 'title', 'aria-label', 'placeholder'])

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function pageSourceHash(segments) {
  return sha256(
    JSON.stringify(
      Object.entries(segments).map(([id, segment]) => [
        id,
        segment.kind,
        segment.attribute ?? null,
        segment.sourceText,
        Boolean(segment.preserveOriginal),
      ]),
    ),
  )
}

function getAttr(node, name) {
  return node.attrs?.find((attribute) => attribute.name === name)?.value
}

function setAttr(node, name, value) {
  const attribute = node.attrs?.find((item) => item.name === name)
  if (attribute) attribute.value = value
  else ((node.attrs ??= []), node.attrs.push({ name, value }))
}

function walk(node, visit, ancestors = []) {
  visit(node, ancestors)
  for (const child of node.childNodes ?? [])
    walk(child, visit, [...ancestors, node])
}

function elementPath(ancestors, node) {
  return [...ancestors, node]
    .filter((item) => item.tagName)
    .map((item) => item.tagName)
    .join(' > ')
}

function isOwnedPage(route, document) {
  // Listing pages are site chrome; individual posts have native sidecars and
  // remain owned by the blog translation pipeline.
  if (route.startsWith('/blog/') && !/^\/blog\/(?:\d+\/)?$/u.test(route))
    return false
  // Generated paper exports are reader assets, not site-owned page chrome.
  if (route.includes('/exports/')) return false
  // Demo sample papers are original external research assets. Translate the
  // surrounding demo interface, never their standalone reader documents.
  if (route.startsWith('/research/struct/samples/')) return false
  if (
    document.includes('http-equiv="refresh"') ||
    document.includes("http-equiv='refresh'")
  )
    return false
  return true
}

function isGeneratedLocaleRoute(route) {
  const segment = route.split('/').filter(Boolean).at(-1)
  return PAGE_LOCALES.includes(segment)
}

function routeForHtmlFile(filePath, distDir) {
  const relative = path.relative(distDir, filePath).split(path.sep).join('/')
  if (relative === 'index.html') return '/'
  if (relative.endsWith('/index.html'))
    return `/${relative.slice(0, -'index.html'.length)}`
  return `/${relative.replace(/\.html$/u, '/')}`
}

function fileForRoute(distDir, route) {
  if (route === '/') return path.join(distDir, 'index.html')
  return path.join(distDir, route.replace(/^\//u, ''), 'index.html')
}

function normalizedRoute(value) {
  if (!value || !value.startsWith('/')) return null
  const url = new URL(value, 'https://ernie.sg')
  const pathname =
    url.pathname === '/' ? '/' : `${url.pathname.replace(/\/+$/u, '')}/`
  return { pathname, suffix: `${url.search}${url.hash}` }
}

/** Append the locale at the final route segment: /research/struct/ -> /research/struct/zh/. */
export function pagePathForLocale(route, locale) {
  const normalized =
    route === '/' ? '/' : `/${route.replace(/^\/+|\/+$/gu, '')}/`
  return normalized === '/' ? `/${locale}/` : `${normalized}${locale}/`
}

/** Rewrites only a route explicitly known to have a locale sibling. */
export function localizedInternalHref(href, locale, localizedRoutes) {
  const parsed = normalizedRoute(href)
  if (!parsed) return href
  const target = localizedRoutes.get(parsed.pathname)
  return target?.[locale] ? `${target[locale]}${parsed.suffix}` : href
}

export function localizedSitemapPaths(catalog, locales = PAGE_LOCALES) {
  return Object.keys(catalog.pages ?? {}).flatMap((route) =>
    locales.map((locale) => pagePathForLocale(route, locale)),
  )
}

function textIsTranslatable(value) {
  return Boolean(value?.trim()) && /[\p{L}\p{N}]/u.test(value)
}

function isReaderAttribute(node, attribute) {
  if (READER_ATTRIBUTES.has(attribute.name)) return true
  if (node.tagName !== 'meta' || attribute.name !== 'content') return false
  const name = getAttr(node, 'name')
  const property = getAttr(node, 'property')
  return (
    ['title', 'description', 'twitter:title', 'twitter:description'].includes(
      name,
    ) || ['og:title', 'og:description'].includes(property)
  )
}

function hasProtectedAncestor(ancestors) {
  return ancestors.some(
    (node) =>
      PROTECTED_TAGS.has(node.tagName) ||
      getAttr(node, 'data-i18n-card') !== undefined,
  )
}

function isPreservedReferenceText(ancestors) {
  return (
    ancestors.some(
      (node) =>
        node.tagName === 'section' &&
        getAttr(node, 'aria-labelledby') === 'references',
    ) &&
    ancestors.some((node) => node.tagName === 'p' || node.tagName === 'cite')
  )
}

export function extractPageSegments(html) {
  const document = parse(html)
  const segments = {}
  let index = 0
  walk(document, (node, ancestors) => {
    if (hasProtectedAncestor(ancestors)) return
    if (node.nodeName === '#text' && textIsTranslatable(node.value)) {
      const id = `s${String(++index).padStart(4, '0')}`
      segments[id] = {
        kind: 'text',
        sourceText: node.value,
        context: elementPath(ancestors, node.parentNode),
        ...(isPreservedReferenceText(ancestors)
          ? { preserveOriginal: true }
          : {}),
      }
      return
    }
    if (
      !node.tagName ||
      PROTECTED_TAGS.has(node.tagName) ||
      getAttr(node, 'data-i18n-card') !== undefined
    )
      return
    for (const attribute of node.attrs ?? []) {
      if (
        !isReaderAttribute(node, attribute) ||
        !textIsTranslatable(attribute.value)
      )
        continue
      const id = `s${String(++index).padStart(4, '0')}`
      segments[id] = {
        kind: 'attribute',
        attribute: attribute.name,
        sourceText: attribute.value,
        context: elementPath(ancestors, node),
      }
    }
  })
  return segments
}

export async function extractPageCatalog({
  distDir = 'dist',
  outputPath,
} = {}) {
  const pages = {}
  const previous = outputPath
    ? await fs
        .readFile(outputPath, 'utf8')
        .then(JSON.parse)
        .catch(() => null)
    : null
  const strings = { ...(previous?.strings ?? {}) }
  for (const relative of (
    await fg('**/*.html', { cwd: distDir, onlyFiles: true })
  ).sort()) {
    const filePath = path.join(distDir, relative)
    const html = await fs.readFile(filePath, 'utf8')
    const route = routeForHtmlFile(filePath, distDir)
    if (!isOwnedPage(route, html)) continue
    const segments = extractPageSegments(html)
    for (const segment of Object.values(segments)) {
      const translationKey = sha256(segment.sourceText)
      segment.translationKey = translationKey
      strings[translationKey] ??= {
        sourceText: segment.sourceText,
        sourceHash: sha256(segment.sourceText),
      }
    }
    const priorLocales = previous?.pages?.[route]?.locales ?? {}
    pages[route] = {
      sourcePath: relative.split(path.sep).join('/'),
      sourceHash: pageSourceHash(segments),
      segments,
      // Preserve every non-machine state verbatim. Unknown states deliberately
      // remain blocking: dropping them would let a future generator overwrite
      // content whose ownership this tool does not understand.
      locales: Object.fromEntries(
        Object.entries(priorLocales).filter(
          ([, entry]) => entry?.status !== 'machine',
        ),
      ),
    }
  }
  // `strings` is the global, content-addressed translation memory. Page
  // entries retain only structural bindings, so identical site copy is sent to
  // a provider once even when it appears in the title, chrome, and body.
  const catalog = {
    version: PAGE_CATALOG_VERSION,
    strings,
    translations: previous?.translations ?? {},
    pages,
  }
  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`)
  }
  return catalog
}

function translationFor(catalog, page, entry, locale, id) {
  if (page.segments[id].preserveOriginal) return page.segments[id].sourceText
  return (
    entry.translations?.[id] ??
    catalog.translations?.[locale]?.[page.segments[id].translationKey]?.text
  )
}

function problemsForLocale(catalog, page, route, locale) {
  const entry = page.locales?.[locale]
  if (!entry) return [`${route}: missing ${locale} translation`]
  if (!['machine', 'native', 'edited', 'final'].includes(entry.status))
    return [`${route}: ${locale} has invalid status`]
  if (entry.sourceHash !== page.sourceHash) {
    return [`${route}: ${locale} source hash is stale`]
  }
  const missing = Object.keys(page.segments).filter((id) => {
    const value = translationFor(catalog, page, entry, locale, id)
    return typeof value !== 'string' || value === ''
  })
  return missing.map((id) => `${route}: ${locale} missing ${id}`)
}

export async function checkPageCatalog({
  distDir = 'dist',
  catalog,
  catalogPath,
  locales = PAGE_LOCALES,
} = {}) {
  const loaded = catalog ?? JSON.parse(await fs.readFile(catalogPath, 'utf8'))
  const problems = []
  const sourcePaths = new Set(
    Object.values(loaded.pages ?? {}).map((page) => page.sourcePath),
  )
  // Compare the catalog to the current build first: catalog-only iteration
  // would silently omit a newly added public page.
  for (const relative of await fg('**/*.html', {
    cwd: distDir,
    onlyFiles: true,
  })) {
    const filePath = path.join(distDir, relative)
    const html = await fs.readFile(filePath, 'utf8')
    const route = routeForHtmlFile(filePath, distDir)
    if (
      isOwnedPage(route, html) &&
      !isGeneratedLocaleRoute(route) &&
      !sourcePaths.has(relative.split(path.sep).join('/'))
    ) {
      problems.push(`${route}: missing from page catalog`)
    }
  }
  for (const [route, page] of Object.entries(loaded.pages ?? {})) {
    const sourcePath = String(page.sourcePath ?? '')
    const resolved = path.resolve(distDir, sourcePath)
    if (
      !sourcePath ||
      path.isAbsolute(sourcePath) ||
      !resolved.startsWith(`${path.resolve(distDir)}${path.sep}`)
    ) {
      problems.push(`${route}: source path is outside dist`)
      continue
    }
    const html = await fs.readFile(resolved, 'utf8').catch(() => null)
    if (!html) {
      problems.push(`${route}: source HTML is missing`)
      continue
    }
    if (
      routeForHtmlFile(resolved, distDir) !== route ||
      !isOwnedPage(route, html)
    ) {
      problems.push(
        `${route}: source path does not match an owned canonical route`,
      )
      continue
    }
    if (pageSourceHash(extractPageSegments(html)) !== page.sourceHash) {
      problems.push(`${route}: source HTML changed; extract a new catalog`)
      continue
    }
    for (const locale of locales)
      problems.push(...problemsForLocale(loaded, page, route, locale))
  }
  return problems
}

function segmentNodes(html) {
  const document = parse(html)
  const found = []
  walk(document, (node, ancestors) => {
    if (hasProtectedAncestor(ancestors)) return
    if (node.nodeName === '#text' && textIsTranslatable(node.value))
      found.push({ node, kind: 'text' })
    if (
      !node.tagName ||
      PROTECTED_TAGS.has(node.tagName) ||
      getAttr(node, 'data-i18n-card') !== undefined
    )
      return
    for (const attribute of node.attrs ?? []) {
      if (
        isReaderAttribute(node, attribute) &&
        textIsTranslatable(attribute.value)
      )
        found.push({ node, kind: 'attribute', attribute: attribute.name })
    }
  })
  return { document, found }
}

function replaceHeadMetadata(document, { locale, localizedPath, alternates }) {
  let htmlNode
  let head
  walk(document, (node) => {
    if (node.tagName === 'html') htmlNode = node
    if (node.tagName === 'head') head = node
  })
  setAttr(htmlNode, 'lang', HTML_LANG[locale])
  const canonical = (head.childNodes ?? []).find(
    (node) => node.tagName === 'link' && getAttr(node, 'rel') === 'canonical',
  )
  const canonicalHref = getAttr(canonical, 'href')
  const origin = canonicalHref?.startsWith('http')
    ? new URL(canonicalHref).origin
    : null
  const toAbsoluteHref = (value) =>
    origin ? new URL(value, origin).toString() : value
  const remove = new Set(['canonical', 'alternate'])
  head.childNodes = (head.childNodes ?? [])
    .filter((node) => {
      if (node.tagName !== 'link') return true
      return !remove.has(getAttr(node, 'rel'))
    })
    .filter(
      (node) =>
        (node.nodeName !== 'script' ||
          getAttr(node, 'id') !== 'site-locale-paths') &&
        !(
          node.tagName === 'meta' &&
          getAttr(node, 'property') === 'og:locale:alternate'
        ),
    )
  for (const node of head.childNodes ?? []) {
    if (node.tagName === 'meta' && getAttr(node, 'property') === 'og:locale') {
      setAttr(
        node,
        'content',
        { en: 'en_US', zh: 'zh_CN', ja: 'ja_JP', ko: 'ko_KR' }[locale],
      )
    }
    if (node.tagName === 'meta' && getAttr(node, 'property') === 'og:url')
      setAttr(node, 'content', toAbsoluteHref(localizedPath))
    if (
      node.tagName === 'meta' &&
      getAttr(node, 'name') === 'site-document-locale'
    )
      setAttr(node, 'content', locale)
  }
  const nodes = [
    {
      nodeName: 'link',
      tagName: 'link',
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      attrs: [
        { name: 'rel', value: 'canonical' },
        { name: 'href', value: toAbsoluteHref(localizedPath) },
      ],
      childNodes: [],
    },
    ...Object.entries(alternates).flatMap(([name, linkUrl]) => [
      {
        nodeName: 'link',
        tagName: 'link',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        attrs: [
          { name: 'rel', value: 'alternate' },
          { name: 'hreflang', value: name },
          { name: 'href', value: toAbsoluteHref(linkUrl) },
        ],
        childNodes: [],
      },
    ]),
    {
      nodeName: 'link',
      tagName: 'link',
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      attrs: [
        { name: 'rel', value: 'alternate' },
        { name: 'hreflang', value: 'x-default' },
        { name: 'href', value: toAbsoluteHref(alternates.en) },
      ],
      childNodes: [],
    },
    {
      nodeName: 'script',
      tagName: 'script',
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      attrs: [
        { name: 'id', value: 'site-locale-paths' },
        { name: 'type', value: 'application/json' },
      ],
      childNodes: [{ nodeName: '#text', value: JSON.stringify(alternates) }],
    },
    ...Object.keys(alternates)
      .filter((name) => name !== locale)
      .map((name) => ({
        nodeName: 'meta',
        tagName: 'meta',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        attrs: [
          { name: 'property', value: 'og:locale:alternate' },
          {
            name: 'content',
            value: { en: 'en_US', zh: 'zh_CN', ja: 'ja_JP', ko: 'ko_KR' }[name],
          },
        ],
        childNodes: [],
      })),
  ]
  head.childNodes.push(...nodes)
}

function localeMapFromDocument(document) {
  let raw = null
  walk(document, (node) => {
    if (
      node.tagName === 'script' &&
      getAttr(node, 'id') === 'site-locale-paths'
    ) {
      raw =
        node.childNodes?.find((child) => child.nodeName === '#text')?.value ??
        null
    }
  })
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

async function knownLocalizedRoutes(distDir, catalog, locales) {
  const routes = new Map(
    Object.keys(catalog.pages).map((route) => [
      route,
      {
        en: route,
        ...Object.fromEntries(
          locales.map((locale) => [locale, pagePathForLocale(route, locale)]),
        ),
      },
    ]),
  )
  for (const relative of await fg('blog/**/*.html', {
    cwd: distDir,
    onlyFiles: true,
  })) {
    const document = parse(
      await fs.readFile(path.join(distDir, relative), 'utf8'),
    )
    const paths = localeMapFromDocument(document)
    if (!paths) continue
    for (const href of Object.values(paths)) {
      const parsed = normalizedRoute(href)
      if (parsed) routes.set(parsed.pathname, paths)
    }
  }
  return routes
}

function rewriteLocalizedLinks(document, locale, routes) {
  walk(document, (node) => {
    if (node.tagName !== 'a') return
    const href = getAttr(node, 'href')
    if (href) setAttr(node, 'href', localizedInternalHref(href, locale, routes))
  })
}

function replaceElementText(node, value) {
  const text = node.childNodes?.find((child) => child.nodeName === '#text')
  if (text) text.value = value
}

// Blog cards already carry native post metadata. Use it for SSR locale pages
// instead of asking the page translator to recreate titles or summaries.
function applyNativeBlogCards(document, locale) {
  walk(document, (card) => {
    if (getAttr(card, 'data-i18n-card') === undefined) return
    try {
      const content = JSON.parse(getAttr(card, 'data-localizations'))?.[locale]
      if (!content) return
      let tagIndex = 0
      walk(card, (node) => {
        if (getAttr(node, 'data-i18n-card-link') !== undefined)
          setAttr(node, 'href', content.url)
        if (
          getAttr(node, 'data-i18n-card-image') !== undefined &&
          content.imageAlt
        )
          setAttr(node, 'alt', content.imageAlt)
        if (getAttr(node, 'data-i18n-card-title') !== undefined)
          replaceElementText(node, content.title)
        if (getAttr(node, 'data-i18n-card-description') !== undefined)
          replaceElementText(node, content.description)
        if (getAttr(node, 'data-i18n-card-date') !== undefined)
          replaceElementText(node, content.date)
        if (getAttr(node, 'data-i18n-card-read-time') !== undefined)
          replaceElementText(node, content.readTime)
        if (getAttr(node, 'data-i18n-card-tag-label') !== undefined) {
          const tag = content.tags?.[tagIndex]
          tagIndex += 1
          if (tag) replaceElementText(node, tag)
        }
      })
    } catch {
      // A malformed card remains source HTML; it is not a translation target.
    }
  })
}

export async function applyPageCatalog({
  distDir = 'dist',
  catalog,
  catalogPath,
  locales = PAGE_LOCALES,
} = {}) {
  const loaded = catalog ?? JSON.parse(await fs.readFile(catalogPath, 'utf8'))
  const problems = await checkPageCatalog({ distDir, catalog: loaded, locales })
  if (problems.length)
    throw new Error(
      `Page localization catalog is incomplete:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    )
  const routes = await knownLocalizedRoutes(distDir, loaded, locales)
  for (const [route, page] of Object.entries(loaded.pages)) {
    const source = await fs.readFile(
      path.join(distDir, page.sourcePath),
      'utf8',
    )
    const alternates = {
      en: route,
      ...Object.fromEntries(
        locales.map((locale) => [locale, pagePathForLocale(route, locale)]),
      ),
    }
    // The canonical English document is also published, so it needs the same
    // route map as its localized siblings before the language control hydrates.
    const english = parse(source)
    replaceHeadMetadata(english, {
      locale: 'en',
      localizedPath: route,
      alternates,
    })
    await fs.writeFile(path.join(distDir, page.sourcePath), serialize(english))
    for (const locale of locales) {
      const { document, found } = segmentNodes(source)
      const entry = page.locales[locale]
      const ids = Object.keys(page.segments)
      if (found.length !== ids.length)
        throw new Error(`${route}: segment structure changed since extraction`)
      found.forEach((item, index) => {
        const value = translationFor(loaded, page, entry, locale, ids[index])
        if (item.kind === 'text') item.node.value = value
        else setAttr(item.node, item.attribute, value)
      })
      const localizedPath = alternates[locale]
      replaceHeadMetadata(document, { locale, localizedPath, alternates })
      rewriteLocalizedLinks(document, locale, routes)
      applyNativeBlogCards(document, locale)
      const outputPath = fileForRoute(distDir, localizedPath)
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, serialize(document))
    }
  }
}

function translationSchema(ids) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['translations'],
    properties: {
      translations: {
        type: 'object',
        additionalProperties: false,
        required: ids,
        properties: Object.fromEntries(
          ids.map((id) => [id, { type: 'string', minLength: 1 }]),
        ),
      },
    },
  }
}

const LOCALE_SCRIPT = {
  zh: /\p{Script=Han}/u,
  ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  ko: /\p{Script=Hangul}/u,
}

export function assertPageTranslations({ segments, translations, locale }) {
  const ids = Object.keys(segments).filter(
    (id) => !segments[id].preserveOriginal,
  )
  const missing = ids.filter(
    (id) => typeof translations?.[id] !== 'string' || !translations[id].trim(),
  )
  if (missing.length)
    throw new Error(`Missing page translation segments: ${missing.join(', ')}`)
  // Brand names, handles, short navigation labels, and numerals legitimately
  // remain English. Echo detection is meaningful only for sentence-like prose.
  const prose = ids.filter((id) => {
    const source = segments[id].sourceText.trim()
    if (/^https?:\/\/\S+$/u.test(source)) return false
    const alphabeticWords = source.match(/\p{L}{3,}/gu) ?? []
    if (alphabeticWords.length < 2) return false
    const words = source.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []
    return (
      words.length >= 6 ||
      source.length >= 48 ||
      (words.length >= 4 && /[.!?;]/u.test(source))
    )
  })
  const unchanged = prose.filter(
    (id) => translations[id].trim() === segments[id].sourceText.trim(),
  )
  if (prose.length && unchanged.length > prose.length / 2) {
    throw new Error(`Page translation appears to echo English for ${locale}`)
  }
  const translatedProse = prose.filter(
    (id) => translations[id].trim() !== segments[id].sourceText.trim(),
  )
  if (
    translatedProse.length &&
    !translatedProse.some((id) => LOCALE_SCRIPT[locale]?.test(translations[id]))
  ) {
    throw new Error(
      `Page translation has no ${locale} script in translated prose`,
    )
  }
}

async function pageStyleContext(locale) {
  const files = [
    'docs/translation/style/rubric.md',
    `docs/translation/style/${locale}.md`,
  ]
  const entries = await Promise.all(
    files.map(async (file) => ({
      file,
      text: await fs.readFile(file, 'utf8').catch(() => ''),
    })),
  )
  return entries
    .filter((entry) => entry.text)
    .map((entry) => entry.text)
    .join('\n\n')
}

function usableCachedTranslation(catalog, locale, key) {
  const entry = catalog.translations?.[locale]?.[key]
  if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return false
  // Native and author-owned wording is deliberately retained. Machine output
  // must carry the same provider provenance that the publish bridge accepts.
  if (entry.status !== 'machine') return true
  const source = catalog.strings?.[key]
  return Boolean(
    entry.provenance?.provider === 'codex-cli' &&
      source?.sourceHash === entry.sourceHash &&
      typeof source.sourceText === 'string' &&
      sha256(source.sourceText) === entry.sourceHash,
  )
}

function needsPageGeneration(catalog, locale, page) {
  const entry = page.locales?.[locale]
  if (!entry) return true
  if (entry.status !== 'machine') return false
  if (entry.sourceHash !== page.sourceHash) return true
  return Object.values(page.segments).some(
    (segment) =>
      !segment.preserveOriginal &&
      !usableCachedTranslation(catalog, locale, segment.translationKey),
  )
}

/** Generate only missing or stale machine entries; final/native/edited entries are never rewritten. */
export async function generatePageTranslations({
  catalog,
  locale,
  batchLimit = 5,
  write = false,
  onPage,
  onPartial,
  runStructuredJson = runCodexStructuredJson,
} = {}) {
  if (!PAGE_LOCALES.includes(locale))
    throw new Error(`Unsupported page locale: ${locale}`)
  const result = structuredClone(catalog)
  result.translations ??= {}
  result.translations[locale] ??= {}
  const styleContext = await pageStyleContext(locale)
  const candidates = Object.entries(result.pages)
    .filter(([, page]) => needsPageGeneration(result, locale, page))
    .slice(0, batchLimit)
  for (const [route, page] of candidates) {
    const ids = Object.keys(page.segments)
    const missingIds = ids.filter(
      (id) =>
        !page.segments[id].preserveOriginal &&
        !usableCachedTranslation(
          result,
          locale,
          page.segments[id].translationKey,
        ),
    )
    if (missingIds.length) {
      const translations = {}
      let outstanding = missingIds
      for (let attempt = 0; attempt < 2 && outstanding.length; attempt += 1) {
        const response = await runStructuredJson({
          systemPrompt: `Translate reader-facing website copy from English to ${locale}. Write idiomatic native web prose, not sentence-fragment literal translation; retain proper nouns, code, URLs, IDs, and claimed results exactly. For research and scientific statements, preserve uncertainty and do not invent findings, evidence, or outcomes. Return each requested id exactly once. Standalone fragments are required output: never drop, merge, or omit them.`,
          userPayload: {
            route,
            locale,
            pagePlainText: ids.map((id) => page.segments[id].sourceText).join('\n'),
            houseStyle: styleContext,
            segments: outstanding.map((id) => ({ id, ...page.segments[id] })),
          },
          schema: translationSchema(outstanding),
        })
        for (const id of outstanding) {
          const value = response.translations?.[id]
          if (typeof value !== 'string' || !value.trim()) continue
          try {
            assertPageTranslations({
              segments: { [id]: page.segments[id] },
              translations: { [id]: value },
              locale,
            })
          } catch {
            // Do not cache malformed, echoed, or wrong-script fragments.
            continue
          }
          translations[id] = value
          const key = page.segments[id].translationKey
          result.translations[locale][key] = {
            text: value,
            status: 'machine',
            sourceHash: result.strings?.[key]?.sourceHash ?? sha256(page.segments[id].sourceText),
            provenance: { provider: 'codex-cli', generatedAt: new Date().toISOString() },
          }
        }
        outstanding = outstanding.filter((id) => !translations[id])
        if (Object.keys(translations).length) await onPartial?.(result, route)
      }
      if (outstanding.length)
        throw new Error(`${route}: provider omitted required segments after retry: ${outstanding.join(', ')}`)
      assertPageTranslations({
        segments: Object.fromEntries(
          missingIds.map((id) => [id, page.segments[id]]),
        ),
        translations,
        locale,
      })
    }
    const effectiveTranslations = Object.fromEntries(
      ids.map((id) => [
        id,
        page.segments[id].preserveOriginal
          ? page.segments[id].sourceText
          : result.translations[locale][page.segments[id].translationKey]
              ?.text,
      ]),
    )
    assertPageTranslations({
      segments: page.segments,
      translations: effectiveTranslations,
      locale,
    })
    page.locales ??= {}
    page.locales[locale] = {
      status: 'machine',
      sourceHash: page.sourceHash,
      translationKeys: Object.fromEntries(
        ids.map((id) => [id, page.segments[id].translationKey]),
      ),
    }
    await onPage?.(result, route)
  }
  if (write) return result
  return {
    catalog: result,
    generatedRoutes: candidates.map(([route]) => route),
  }
}

async function main() {
  const { values: args, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      dist: { type: 'string' },
      catalog: { type: 'string' },
      locale: { type: 'string' },
      'batch-limit': { type: 'string' },
    },
  })
  const [command] = positionals
  const distDir = args.dist ?? 'dist'
  const catalogPath = args.catalog ?? '.translation/pages.json'
  if (command === 'extract')
    await extractPageCatalog({ distDir, outputPath: catalogPath })
  else if (command === 'check') {
    const problems = await checkPageCatalog({ distDir, catalogPath })
    if (problems.length) throw new Error(problems.join('\n'))
  } else if (command === 'apply')
    await applyPageCatalog({ distDir, catalogPath })
  else if (command === 'generate') {
    const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
    const save = async (nextCatalog) => {
      const temporaryPath = `${catalogPath}.tmp`
      await fs.writeFile(
        temporaryPath,
        `${JSON.stringify(nextCatalog, null, 2)}\n`,
      )
      await fs.rename(temporaryPath, catalogPath)
    }
    const generated = await generatePageTranslations({
      catalog,
      locale: args.locale,
      batchLimit: Number(args['batch-limit'] ?? 5),
      write: true,
      onPage: save,
      onPartial: save,
    })
    await save(generated)
  } else
    throw new Error(
      'Usage: pages.mjs <extract|generate|check|apply> [--dist dist] [--catalog .translation/pages.json]',
    )
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
