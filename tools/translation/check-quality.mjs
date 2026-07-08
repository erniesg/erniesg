import { fileURLToPath } from 'node:url'
import {
  canWriteExistingTarget,
  getManifestTarget,
  hasOwnership,
  listTargetSidecars,
  loadManifest,
  parseArgs,
  readMdxFile,
  sha256,
} from './content.mjs'
import { auditMdxText } from './audit.mjs'

export async function checkTranslationQuality({ strictPublish = false } = {}) {
  const manifest = await loadManifest()
  const files = await listTargetSidecars(['zh', 'ko', 'ja'])
  const errors = []
  const warnings = []

  for (const filePath of files) {
    const file = await readMdxFile(filePath)
    const target = getManifestTarget(manifest, filePath)
    const status = file.frontmatter.translationStatus
    const source = file.frontmatter.translationSource
    if (!hasOwnership(file.frontmatter)) {
      errors.push(`${filePath}: missing translationStatus/translationSource`)
      continue
    }

    const audit = auditMdxText(file.raw, {
      path: filePath,
      locale: file.frontmatter.lang,
    })
    errors.push(...audit.errors)
    warnings.push(...audit.warnings)

    if (status === 'machine') {
      if (!target) {
        errors.push(`${filePath}: machine translation missing manifest target`)
      } else if (!canWriteExistingTarget({ frontmatter: file.frontmatter, manifestTarget: target, currentText: file.raw })) {
        errors.push(`${filePath}: machine target hash drifted from manifest`)
      } else if (target.targetSha256 !== sha256(file.raw)) {
        errors.push(`${filePath}: manifest targetSha256 mismatch`)
      }

      if (strictPublish) {
        if (target?.qualityStatus !== 'passed') {
          errors.push(`${filePath}: machine translation has not passed native review`)
        }
        if ((target?.unresolvedResearch ?? []).length > 0) {
          errors.push(`${filePath}: unresolved translation research remains`)
        }
      } else if (target?.qualityStatus !== 'passed') {
        warnings.push(`${filePath}: machine translation is mechanically checked but still needs native review`)
      }
    }

    if ((status === 'edited' || status === 'final') && target?.targetSha256 && target.targetSha256 !== sha256(file.raw)) {
      warnings.push(`${filePath}: human-owned translation changed after manifest snapshot`)
    }

    if (status === 'final' && source === 'imported-legacy') {
      if (target?.qualityStatus !== 'human-final') {
        warnings.push(`${filePath}: imported legacy translation should be marked human-final in manifest`)
      }
    }
  }

  return { errors, warnings, checked: files.length }
}

async function main() {
  const args = parseArgs()
  const result = await checkTranslationQuality({
    strictPublish: Boolean(args.strict_publish),
  })
  for (const warning of result.warnings) console.warn(`warning: ${warning}`)
  for (const error of result.errors) console.error(`error: ${error}`)
  console.log(
    `Checked ${result.checked} translations: ${result.errors.length} errors, ${result.warnings.length} warnings.`,
  )
  if (result.errors.length > 0) process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
