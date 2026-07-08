import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import fg from 'fast-glob'
import {
  BLOG_ROOT,
  DEFAULT_LOCALE,
  getManifestTarget,
  isProtectedPath,
  loadConfig,
  loadManifest,
  localeFromPath,
  parseArgs,
  readMdxFile,
  sha256,
  targetPathForLocale,
  toPosixPath,
} from './content.mjs'
import { generateTranslation } from './generate.mjs'

async function sourcePosts(config) {
  const files = await fg(`${BLOG_ROOT}/*/index.mdx`, { onlyFiles: true })
  return files
    .map(toPosixPath)
    .filter((filePath) => !isProtectedPath(filePath, config))
    .sort()
}

export async function syncTranslations({ write = false, all = false } = {}) {
  const config = await loadConfig()
  const manifest = await loadManifest()
  const results = []

  for (const sourcePath of await sourcePosts(config)) {
    const source = await readMdxFile(sourcePath)
    const sourceLocale = source.frontmatter.lang ?? DEFAULT_LOCALE
    for (const targetLocale of config.requiredPublishLocales ?? ['en', 'zh', 'ko', 'ja']) {
      if (targetLocale === sourceLocale) continue
      const targetPath = targetPathForLocale(sourcePath, targetLocale)
      const target = getManifestTarget(manifest, targetPath)
      const exists = await fs
        .access(targetPath)
        .then(() => true)
        .catch(() => false)
      const stale = Boolean(target && target.sourceSha256 !== sha256(source.raw))
      if (!exists || stale || all) {
        results.push(
          await generateTranslation({
            sourcePath,
            targetLocale,
            write,
          }),
        )
      }
    }
  }

  return results
}

async function main() {
  const args = parseArgs()
  const results = await syncTranslations({
    write: Boolean(args.write),
    all: Boolean(args.all),
  })
  if (results.length === 0) {
    console.log('All required translations are present and source hashes match manifest.')
    return
  }
  for (const result of results) {
    console.log(`${result.wrote ? 'wrote' : 'would-write'}: ${result.targetPath}`)
  }
  if (!args.write) console.log('Dry run only. Re-run with --write to save generated translations.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
