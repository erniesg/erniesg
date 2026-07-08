import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import fg from 'fast-glob'
import matter from 'gray-matter'

export const BLOG_ROOT = 'src/content/blog'
export const CONFIG_PATH = '.translation/config.json'
export const MANIFEST_PATH = '.translation/manifest.json'

export const SUPPORTED_LOCALES = ['en', 'zh', 'ko', 'ja']
export const DEFAULT_LOCALE = 'en'
export const OWNERSHIP_STATUSES = ['machine', 'edited', 'final']

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/')
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== null) return fallback
    throw error
  }
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export async function loadConfig() {
  return readJson(CONFIG_PATH)
}

export async function loadManifest() {
  return readJson(MANIFEST_PATH, {
    version: 1,
    promptVersion: '2026-07-09',
    families: {},
  })
}

export async function saveManifest(manifest) {
  await writeJson(MANIFEST_PATH, manifest)
}

export async function readMdxFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  const parsed = matter(raw)
  return {
    filePath,
    raw,
    frontmatter: parsed.data ?? {},
    content: parsed.content,
    parsed,
  }
}

export async function writeMdxFile(filePath, raw) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, raw)
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      args._.push(arg)
      continue
    }
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2)
    const key = rawKey.replaceAll('-', '_')
    if (inlineValue !== undefined) {
      args[key] = inlineValue
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      index += 1
    } else {
      args[key] = true
    }
  }
  return args
}

export function isLocaleSidecarPath(filePath) {
  return /\/(?:en|zh|ko|ja)\.mdx?$/.test(toPosixPath(filePath))
}

export function localeFromPath(filePath) {
  const normalized = toPosixPath(filePath)
  const sidecarMatch = normalized.match(/\/(en|zh|ko|ja)\.mdx?$/)
  if (sidecarMatch) return sidecarMatch[1]

  const slug = path.basename(path.dirname(normalized))
  const suffixMatch = slug.match(/-(zh|ko|ja)$/)
  if (suffixMatch) return suffixMatch[1]
  return DEFAULT_LOCALE
}

export function familyKeyFromPath(filePath) {
  const normalized = toPosixPath(filePath)
  const dirname = path.dirname(normalized)
  const basename = path.basename(normalized)
  if (/^(?:index|en|zh|ko|ja)\.mdx?$/.test(basename)) {
    return dirname.replace(`${BLOG_ROOT}/`, '')
  }
  return dirname.replace(`${BLOG_ROOT}/`, '')
}

export function sourcePathForTarget(targetPath) {
  return `${path.dirname(toPosixPath(targetPath))}/index.mdx`
}

export function targetPathForLocale(sourcePath, locale) {
  const dir = path.dirname(toPosixPath(sourcePath))
  return locale === DEFAULT_LOCALE ? `${dir}/en.mdx` : `${dir}/${locale}.mdx`
}

export function ensureFamily(manifest, familyKey) {
  manifest.families ??= {}
  manifest.families[familyKey] ??= { sourcePath: `${BLOG_ROOT}/${familyKey}/index.mdx`, targets: {} }
  manifest.families[familyKey].targets ??= {}
  return manifest.families[familyKey]
}

export function getManifestTarget(manifest, filePath) {
  const normalized = toPosixPath(filePath)
  for (const family of Object.values(manifest.families ?? {})) {
    for (const target of Object.values(family.targets ?? {})) {
      if (target?.path === normalized) return target
    }
  }
  return null
}

export function canWriteExistingTarget({
  frontmatter,
  manifestTarget,
  currentText,
}) {
  if (frontmatter?.translationStatus !== 'machine') return false
  if (!manifestTarget?.targetSha256) return false
  return manifestTarget.targetSha256 === sha256(currentText)
}

export function assertCanWriteExistingTarget(input) {
  if (canWriteExistingTarget(input)) return
  const status = input.frontmatter?.translationStatus ?? 'missing'
  const pathLabel = input.filePath ? ` ${input.filePath}` : ''
  throw new Error(
    `Refusing to overwrite${pathLabel}: translationStatus=${status}, manifest hash missing, or target hash drifted.`,
  )
}

export async function listBlogMdxFiles(pattern = `${BLOG_ROOT}/**/*.mdx`) {
  return fg(pattern, {
    onlyFiles: true,
    dot: false,
    unique: true,
  }).then((files) => files.map(toPosixPath).sort())
}

export async function listTargetSidecars(locales = ['en', 'zh', 'ko', 'ja']) {
  const suffixes = locales.map((locale) => `${locale}.mdx`)
  const files = await listBlogMdxFiles(`${BLOG_ROOT}/*/{${suffixes.join(',')}}`)
  return files.filter(isLocaleSidecarPath)
}

export function stringifyMdxWithFrontmatter(raw, updates) {
  const parsed = matter(raw)
  const data = { ...(parsed.data ?? {}), ...updates }
  return matter.stringify(parsed.content, data)
}

export function setFrontmatterFields(raw, updates) {
  return stringifyMdxWithFrontmatter(raw, updates)
}

export async function updateFrontmatter(filePath, updates) {
  const raw = await fs.readFile(filePath, 'utf8')
  const next = setFrontmatterFields(raw, updates)
  await fs.writeFile(filePath, next)
  return next
}

export function nowIso() {
  return new Date().toISOString()
}

export function isProtectedPath(filePath, config) {
  const normalized = toPosixPath(filePath)
  return [
    ...(config.protectedLegacyDirs ?? []),
    ...(config.protectedHumanTranslations ?? []),
  ].some((protectedPath) => {
    const current = toPosixPath(protectedPath)
    return normalized === current || normalized.startsWith(`${current}/`)
  })
}

export function hasOwnership(frontmatter) {
  return (
    OWNERSHIP_STATUSES.includes(frontmatter.translationStatus) &&
    typeof frontmatter.translationSource === 'string'
  )
}
