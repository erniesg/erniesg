import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_LOCALE,
  ensureFamily,
  familyKeyFromPath,
  hasOwnership,
  isProtectedPath,
  listTargetSidecars,
  loadConfig,
  loadManifest,
  localeFromPath,
  nowIso,
  parseArgs,
  readMdxFile,
  saveManifest,
  setFrontmatterFields,
  sha256,
  sourcePathForTarget,
  toPosixPath,
} from './content.mjs'

async function classifyFile(filePath, { config, manifest, apply }) {
  const normalized = toPosixPath(filePath)
  if (isProtectedPath(normalized, config)) {
    return { filePath: normalized, action: 'skipped-protected' }
  }

  const target = await readMdxFile(normalized)
  if (hasOwnership(target.frontmatter)) {
    return { filePath: normalized, action: 'skipped-owned' }
  }

  const locale = target.frontmatter.lang ?? localeFromPath(normalized)
  const sourcePath = sourcePathForTarget(normalized)
  const sourceRaw = await fs.readFile(sourcePath, 'utf8')
  const source = await readMdxFile(sourcePath)
  const sourceLocale = source.frontmatter.lang ?? DEFAULT_LOCALE
  const familyKey = familyKeyFromPath(normalized)
  const translationKey = target.frontmatter.translationKey ?? familyKey
  const updatedRaw = setFrontmatterFields(target.raw, {
    lang: locale,
    translationKey,
    translationStatus: 'machine',
    translationSource: 'codex',
  })

  const family = ensureFamily(manifest, familyKey)
  family.sourcePath = sourcePath
  family.sourceLocale = sourceLocale
  family.targets[locale] = {
    path: normalized,
    status: 'machine',
    sourcePath,
    sourceLocale,
    targetLocale: locale,
    sourceSha256: sha256(sourceRaw),
    targetSha256: sha256(updatedRaw),
    provider: 'codex',
    model: 'preexisting-machine-translation',
    promptVersion: config.promptVersion,
    classifiedAt: nowIso(),
    qualityStatus: 'unreviewed',
    reviewScore: null,
    researchNotes: [],
    unresolvedResearch: ['classified-existing-machine-translation-needs-review'],
  }

  if (apply) {
    await fs.writeFile(normalized, updatedRaw)
  }

  return { filePath: normalized, locale, action: apply ? 'classified' : 'would-classify' }
}

export async function classifyExistingTranslations({ apply = false } = {}) {
  const config = await loadConfig()
  const manifest = await loadManifest()
  const files = await listTargetSidecars(['en', 'zh', 'ko', 'ja'])
  const results = []
  for (const filePath of files) {
    results.push(await classifyFile(filePath, { config, manifest, apply }))
  }
  if (apply) await saveManifest(manifest)
  return results
}

async function main() {
  const args = parseArgs()
  const apply = Boolean(args.apply)
  const results = await classifyExistingTranslations({ apply })
  const counts = results.reduce((acc, result) => {
    acc[result.action] = (acc[result.action] ?? 0) + 1
    return acc
  }, {})
  for (const [action, count] of Object.entries(counts)) {
    console.log(`${action}: ${count}`)
  }
  if (!apply) console.log('Dry run only. Re-run with --apply to write metadata and manifest records.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
