import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureFamily,
  familyKeyFromPath,
  loadConfig,
  loadManifest,
  localeFromPath,
  nowIso,
  parseArgs,
  saveManifest,
  setFrontmatterFields,
  sha256,
  sourcePathForTarget,
  toPosixPath,
} from './content.mjs'

function canonicalPathForLegacyDir(legacyDir) {
  const slug = path.basename(legacyDir).replace(/-zh$/, '')
  return `src/content/blog/${slug}/zh.mdx`
}

export async function reconcileLegacyChinese({ apply = false } = {}) {
  const config = await loadConfig()
  const manifest = await loadManifest()
  const results = []

  for (const legacyDir of config.protectedLegacyDirs ?? []) {
    const legacyPath = `${toPosixPath(legacyDir)}/index.mdx`
    const targetPath = canonicalPathForLegacyDir(legacyDir)
    const familyKey = familyKeyFromPath(targetPath)
    const legacyRaw = await fs.readFile(legacyPath, 'utf8')
    const targetRaw = setFrontmatterFields(legacyRaw, {
      lang: 'zh',
      translationKey: familyKey,
      translationStatus: 'final',
      translationSource: 'imported-legacy',
    })
    const canonicalSourcePath = sourcePathForTarget(targetPath)
    const canonicalSourceRaw = await fs.readFile(canonicalSourcePath, 'utf8')
    const family = ensureFamily(manifest, familyKey)
    family.sourcePath = canonicalSourcePath
    family.sourceLocale = localeFromPath(canonicalSourcePath)
    family.targets.zh = {
      path: targetPath,
      status: 'final',
      source: 'imported-legacy',
      sourcePath: legacyPath,
      sourceLocale: 'zh',
      targetLocale: 'zh',
      canonicalSourcePath,
      canonicalSourceSha256: sha256(canonicalSourceRaw),
      sourceSha256: sha256(legacyRaw),
      targetSha256: sha256(targetRaw),
      provider: 'human',
      model: null,
      promptVersion: config.promptVersion,
      classifiedAt: nowIso(),
      qualityStatus: 'human-final',
      reviewScore: 1,
      researchNotes: ['protected legacy Chinese import'],
      unresolvedResearch: [],
    }

    if (apply) {
      await fs.writeFile(targetPath, targetRaw)
    }
    results.push({
      legacyPath,
      targetPath,
      action: apply ? 'reconciled' : 'would-reconcile',
    })
  }

  if (apply) await saveManifest(manifest)
  return results
}

async function main() {
  const args = parseArgs()
  const results = await reconcileLegacyChinese({ apply: Boolean(args.apply) })
  for (const result of results) {
    console.log(
      `${result.action}: ${result.legacyPath} -> ${result.targetPath}`,
    )
  }
  if (!args.apply)
    console.log(
      'Dry run only. Re-run with --apply to copy and protect legacy Chinese sidecars.',
    )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
