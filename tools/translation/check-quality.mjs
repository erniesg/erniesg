import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import {
  canWriteExistingTarget,
  getManifestTarget,
  hasOwnership,
  listTargetSidecars,
  loadManifest,
  loadConfig,
  parseArgs,
  readMdxFile,
  saveManifest,
  sha256,
} from './content.mjs'
import { auditMdxText } from './audit.mjs'
import {
  buildReviewPrompt,
  loadStyleContext,
  reviewJsonSchema,
} from './prompts.mjs'
import { createStructuredReview } from './providers.mjs'

function reportPathFor(filePath) {
  return `.translation/reports/${filePath
    .replace(/^src\/content\/blog\//, '')
    .replaceAll('/', '.')
    .replace(/\.mdx$/, '')}.quality.json`
}

async function refreshNativeReview({
  config,
  manifest,
  filePath,
  file,
  target,
}) {
  const source = await readMdxFile(target.sourcePath)
  const styleContext = await loadStyleContext(file.frontmatter.lang)
  const passes = [
    config.providers?.review?.pass1?.[file.frontmatter.lang],
    config.providers?.review?.pass2?.[file.frontmatter.lang],
  ].filter(Boolean)
  const reviews = []

  for (const passConfig of passes) {
    const prompt = buildReviewPrompt({
      sourceLocale: target.sourceLocale,
      targetLocale: file.frontmatter.lang,
      sourcePath: target.sourcePath,
      targetPath: filePath,
      styleContext,
      reviewerProfile: passConfig.profile ?? 'native-editor-reviewer',
    })
    reviews.push(
      await createStructuredReview({
        config,
        providerConfig: passConfig,
        systemPrompt: prompt,
        sourceText: source.raw,
        targetText: file.raw,
        schema: reviewJsonSchema(),
      }),
    )
  }

  const minScore = Math.min(...reviews.map((review) => review.score))
  const unresolvedResearch = reviews.flatMap(
    (review) => review.unresolvedResearch ?? [],
  )
  const blockingIssues = reviews.flatMap((review) =>
    (review.issues ?? []).filter((issue) => issue.severity === 'blocking'),
  )
  const passed =
    reviews.every((review) => review.passed) &&
    minScore >= config.minReviewScore &&
    unresolvedResearch.length === 0 &&
    blockingIssues.length === 0
  const reportPath = reportPathFor(filePath)
  const report = {
    sourcePath: target.sourcePath,
    targetPath: filePath,
    sourceSha256: target.sourceSha256,
    targetSha256: sha256(file.raw),
    promptVersion: config.promptVersion,
    styleGuideSha256: target.styleGuideSha256 ?? null,
    rubricSha256: target.rubricSha256 ?? null,
    reviewProvider: 'openai',
    reviewerModel: process.env.OPENAI_REVIEW_MODEL ?? passes[0]?.model ?? null,
    reviewProfile: passes.map((pass) => pass.profile),
    passed,
    score: minScore,
    reviews,
  }
  await fs.mkdir('.translation/reports', { recursive: true })
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  target.qualityStatus = passed ? 'passed' : 'review-failed'
  target.reviewScore = minScore
  target.reviewProvider = 'openai'
  target.reviewerModel = report.reviewerModel
  target.qualityReportPath = reportPath
  target.unresolvedResearch = unresolvedResearch
  if (passed) target.reviewedAt = new Date().toISOString()
  manifest.families ??= {}
  return report
}

export async function checkTranslationQuality({
  strictPublish = false,
  refreshReview = false,
} = {}) {
  const config = await loadConfig()
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
      } else if (
        !canWriteExistingTarget({
          frontmatter: file.frontmatter,
          manifestTarget: target,
          currentText: file.raw,
        })
      ) {
        errors.push(`${filePath}: machine target hash drifted from manifest`)
      } else if (target.targetSha256 !== sha256(file.raw)) {
        errors.push(`${filePath}: manifest targetSha256 mismatch`)
      }

      if (target && refreshReview && errors.length === 0) {
        try {
          await refreshNativeReview({
            config,
            manifest,
            filePath,
            file,
            target,
          })
        } catch (error) {
          errors.push(
            `${filePath}: native review failed to run: ${error.message}`,
          )
        }
      }

      if (strictPublish) {
        if (target?.qualityStatus !== 'passed') {
          errors.push(
            `${filePath}: machine translation has not passed native review`,
          )
        }
        if ((target?.unresolvedResearch ?? []).length > 0) {
          errors.push(`${filePath}: unresolved translation research remains`)
        }
      } else if (target?.qualityStatus !== 'passed') {
        warnings.push(
          `${filePath}: machine translation is mechanically checked but still needs native review`,
        )
      }
    }

    if (
      (status === 'edited' || status === 'final') &&
      target?.targetSha256 &&
      target.targetSha256 !== sha256(file.raw)
    ) {
      warnings.push(
        `${filePath}: human-owned translation changed after manifest snapshot`,
      )
    }

    if (status === 'final' && source === 'imported-legacy') {
      if (target?.qualityStatus !== 'human-final') {
        warnings.push(
          `${filePath}: imported legacy translation should be marked human-final in manifest`,
        )
      }
    }
  }

  if (refreshReview) await saveManifest(manifest)
  return { errors, warnings, checked: files.length }
}

async function main() {
  const args = parseArgs()
  const result = await checkTranslationQuality({
    strictPublish: Boolean(args.strict_publish),
    refreshReview: Boolean(args.refresh_review),
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
