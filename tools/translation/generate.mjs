import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertCanWriteExistingTarget,
  ensureFamily,
  familyKeyFromPath,
  getManifestTarget,
  loadConfig,
  loadManifest,
  localeFromPath,
  nowIso,
  parseArgs,
  readMdxFile,
  saveManifest,
  setFrontmatterFields,
  sha256,
  targetPathForLocale,
  toPosixPath,
} from './content.mjs'
import { extractSegments, applySegmentTranslations } from './segments.mjs'
import { lockedRegionHash } from './locked-regions.mjs'
import { buildResearchReport } from './research.mjs'
import { buildTranslationPrompt, loadStyleContext, translationJsonSchema } from './prompts.mjs'
import { createStructuredTranslation, providerConfigFor } from './providers.mjs'
import { auditMdxText } from './audit.mjs'

export async function generateTranslation({
  sourcePath,
  targetLocale,
  write = false,
}) {
  const config = await loadConfig()
  const manifest = await loadManifest()
  const normalizedSourcePath = toPosixPath(sourcePath)
  const source = await readMdxFile(normalizedSourcePath)
  const sourceLocale = source.frontmatter.lang ?? localeFromPath(normalizedSourcePath)
  const targetPath = targetPathForLocale(normalizedSourcePath, targetLocale)
  const familyKey = familyKeyFromPath(normalizedSourcePath)
  const segments = extractSegments(source.raw)
  const styleContext = await loadStyleContext(targetLocale)
  const researchReport = await buildResearchReport({
    sourcePath: normalizedSourcePath,
    sourceLocale,
    targetLocale,
  })
  const providerConfig = providerConfigFor(config, 'translate', targetLocale)
  const prompt = buildTranslationPrompt({
    sourceLocale,
    targetLocale,
    sourcePath: normalizedSourcePath,
    styleContext,
    researchReport,
  })
  const result = await createStructuredTranslation({
    config,
    providerConfig,
    systemPrompt: prompt,
    segments,
    schema: translationJsonSchema(segments.map((segment) => segment.id)),
  })

  let targetRaw = applySegmentTranslations(source.raw, result.translations)
  targetRaw = setFrontmatterFields(targetRaw, {
    lang: targetLocale,
    translationKey: familyKey,
    translationStatus: 'machine',
    translationSource: 'codex',
  })
  const audit = auditMdxText(targetRaw, { path: targetPath, locale: targetLocale })
  if (audit.errors.length > 0) {
    throw new Error(`Generated translation failed audit:\n${audit.errors.join('\n')}`)
  }

  try {
    const existing = await readMdxFile(targetPath)
    assertCanWriteExistingTarget({
      filePath: targetPath,
      frontmatter: existing.frontmatter,
      manifestTarget: getManifestTarget(manifest, targetPath),
      currentText: existing.raw,
    })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const family = ensureFamily(manifest, familyKey)
  family.sourcePath = normalizedSourcePath
  family.sourceLocale = sourceLocale
  family.targets[targetLocale] = {
    path: targetPath,
    status: 'machine',
    sourcePath: normalizedSourcePath,
    sourceLocale,
    targetLocale,
    sourceSha256: sha256(source.raw),
    targetSha256: sha256(targetRaw),
    lockedRegionSha256: lockedRegionHash(source.raw),
    provider: providerConfig.provider,
    model: providerConfig.model,
    promptVersion: config.promptVersion,
    styleGuideSha256: styleContext.styleGuideSha256,
    rubricSha256: styleContext.rubricSha256,
    generatedAt: nowIso(),
    qualityStatus: 'mechanical-passed',
    reviewScore: null,
    researchNotes: researchReport.candidates,
    unresolvedResearch: result.unresolvedResearch ?? [],
  }

  if (write) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, targetRaw)
    await saveManifest(manifest)
  }

  return { targetPath, targetLocale, wrote: write, unresolvedResearch: result.unresolvedResearch ?? [] }
}

async function main() {
  const args = parseArgs()
  const [sourcePath] = args._
  if (!sourcePath || !args.target) {
    throw new Error('Usage: npm run translate:generate -- <source.mdx> --target zh --write')
  }
  const result = await generateTranslation({
    sourcePath,
    targetLocale: args.target,
    write: Boolean(args.write),
  })
  console.log(`${result.wrote ? 'Wrote' : 'Generated'} ${result.targetPath}`)
  if (!result.wrote) console.log('Dry run only. Re-run with --write to save the translation.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
