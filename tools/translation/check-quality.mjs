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
import { createStructuredReview, providerConfigFor } from './providers.mjs'
import { isCodexUsageLimitError } from './codex-cli.mjs'

function reportPathFor(filePath) {
  return `.translation/reports/${filePath
    .replace(/^src\/content\/blog\//, '')
    .replaceAll('/', '.')
    .replace(/\.mdx$/, '')}.quality.json`
}

export function reviewMetadataIssues({
  config,
  target,
  currentTargetSha256,
  currentPromptVersion,
  currentStyleGuideSha256,
  currentRubricSha256,
}) {
  const issues = []
  if (target?.qualityStatus !== 'passed') {
    issues.push('machine translation has not passed native review')
  }
  if (target?.reviewedTargetSha256 !== currentTargetSha256) {
    issues.push('native review does not match current target hash')
  }
  if (target?.reviewPromptVersion !== currentPromptVersion) {
    issues.push('native review used an outdated review prompt')
  }
  if (target?.reviewStyleGuideSha256 !== currentStyleGuideSha256) {
    issues.push('native review used an outdated style guide')
  }
  if (target?.reviewRubricSha256 !== currentRubricSha256) {
    issues.push('native review used an outdated rubric')
  }

  const reviewPassCount =
    target?.reviewPassCount ?? target?.reviewProfile?.length ?? 0
  if (reviewPassCount < (config.requiredReviewerPasses ?? 1)) {
    issues.push('native review does not have enough reviewer passes')
  }

  const hasNumericScore = typeof target?.reviewScore === 'number'
  const isHashBoundLegacyReview =
    target?.reviewProvider === 'codex-parallel-agents' &&
    target?.reviewedTargetSha256 === currentTargetSha256
  if (hasNumericScore && target.reviewScore < (config.minReviewScore ?? 0)) {
    issues.push('native review score is below the publish threshold')
  } else if (!hasNumericScore && !isHashBoundLegacyReview) {
    issues.push('native review score is missing')
  }

  return issues
}

function isProtectedReviewIssue(issue) {
  const location = issue?.location ?? ''
  const problem = issue?.problem ?? ''
  const suggestion = issue?.suggestion ?? ''
  const text = `${location}\n${problem}\n${suggestion}`

  if (/translationStatus:\s*machine|translationStatus\b/i.test(text)) {
    return true
  }
  if (
    /frontmatter|YAML/i.test(text) &&
    /date|image|serialization|format|quote/i.test(text) &&
    /equivalent|normaliz|churn|metadata/i.test(text)
  ) {
    return true
  }
  if (
    /code (?:block|fence|comment)|comments? .* code/i.test(text) &&
    /English|untranslated|translat|remain/i.test(text)
  ) {
    return true
  }
  if (
    /(?:model|generated|RAGgaeton|Claude).*(?:output|excerpt|sample)|(?:output|excerpt|sample).*(?:model|generated|RAGgaeton|Claude)/i.test(
      text,
    ) &&
    /English|original language|untranslated|remain|left/i.test(text)
  ) {
    return true
  }
  return false
}

export function normalizeReviewResult(review, { minReviewScore }) {
  const ignoredIssues = (review.issues ?? []).filter(isProtectedReviewIssue)
  const issues = (review.issues ?? []).filter(
    (issue) => !isProtectedReviewIssue(issue),
  )
  const hasPublishIssue = issues.some(
    (issue) => issue.severity === 'major' || issue.severity === 'blocking',
  )
  const hasIgnoredPublishIssue = ignoredIssues.some(
    (issue) => issue.severity === 'major' || issue.severity === 'blocking',
  )
  const unresolvedResearch = review.unresolvedResearch ?? []
  const score =
    !hasPublishIssue && hasIgnoredPublishIssue
      ? Math.max(review.score, 0.9)
      : review.score
  const passed =
    !hasPublishIssue &&
    unresolvedResearch.length === 0 &&
    score >= minReviewScore

  return {
    ...review,
    rawPassed: review.passed,
    rawScore: review.score,
    passed,
    score,
    issues,
    ...(ignoredIssues.length > 0 ? { ignoredIssues } : {}),
  }
}

async function refreshNativeReview({
  config,
  manifest,
  filePath,
  file,
  target,
  styleContext,
}) {
  const reviewPromptVersion = config.reviewPromptVersion ?? config.promptVersion
  const source = await readMdxFile(target.sourcePath)
  const passes = [
    config.providers?.review?.pass1?.[file.frontmatter.lang],
    config.providers?.review?.pass2?.[file.frontmatter.lang],
  ]
    .filter(Boolean)
    .map((passConfig) =>
      providerConfigFor(config, 'review', file.frontmatter.lang, passConfig),
    )
  const rawReviews = await Promise.all(
    passes.map(async (passConfig) => {
      const prompt = buildReviewPrompt({
        sourceLocale: target.sourceLocale,
        targetLocale: file.frontmatter.lang,
        sourcePath: target.sourcePath,
        targetPath: filePath,
        styleContext,
        reviewerProfile: passConfig.profile ?? 'native-editor-reviewer',
      })
      return createStructuredReview({
        config,
        providerConfig: passConfig,
        systemPrompt: prompt,
        sourceText: source.raw,
        targetText: file.raw,
        schema: reviewJsonSchema(),
      })
    }),
  )
  const reviews = rawReviews.map((review) =>
    normalizeReviewResult(review, {
      minReviewScore: config.minReviewScore,
    }),
  )

  const minScore = Math.min(...reviews.map((review) => review.score))
  const targetSha256 = sha256(file.raw)
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
    targetSha256,
    reviewPromptVersion,
    reviewStyleGuideSha256: styleContext.styleGuideSha256,
    reviewRubricSha256: styleContext.rubricSha256,
    reviewProvider: passes[0]?.provider ?? null,
    reviewerModel:
      process.env.OPENAI_REVIEW_MODEL ??
      process.env.CODEX_TRANSLATION_MODEL ??
      passes[0]?.model ??
      null,
    reviewProfile: passes.map((pass) => pass.profile),
    passed,
    score: minScore,
    reviews,
  }
  await fs.mkdir('.translation/reports', { recursive: true })
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  target.qualityStatus = passed ? 'passed' : 'review-failed'
  target.reviewScore = minScore
  target.reviewedTargetSha256 = targetSha256
  target.reviewPassCount = reviews.length
  target.reviewPromptVersion = reviewPromptVersion
  target.reviewStyleGuideSha256 = styleContext.styleGuideSha256
  target.reviewRubricSha256 = styleContext.rubricSha256
  target.reviewProvider = report.reviewProvider
  target.reviewerModel = report.reviewerModel
  target.reviewProfile = passes.map((pass) => pass.profile)
  target.qualityReportPath = reportPath
  target.unresolvedResearch = unresolvedResearch
  if (passed) target.reviewedAt = new Date().toISOString()
  manifest.families ??= {}
  return report
}

export async function checkTranslationQuality({
  strictPublish = false,
  refreshReview = false,
  refreshAllReviews = false,
  slug = null,
  locale = null,
} = {}) {
  const config = await loadConfig()
  const reviewPromptVersion = config.reviewPromptVersion ?? config.promptVersion
  const manifest = await loadManifest()
  const files = (await listTargetSidecars(['zh', 'ko', 'ja'])).filter(
    (filePath) => {
      if (locale && !filePath.endsWith(`/${locale}.mdx`)) return false
      if (slug && !filePath.startsWith(`src/content/blog/${slug}/`))
        return false
      return true
    },
  )
  const styleContexts = new Map()
  let providerStopReason = null

  async function styleContextFor(locale) {
    if (!styleContexts.has(locale)) {
      styleContexts.set(locale, loadStyleContext(locale))
    }
    return await styleContexts.get(locale)
  }

  async function checkFile(filePath) {
    const errors = []
    const warnings = []
    const file = await readMdxFile(filePath)
    const target = getManifestTarget(manifest, filePath)
    const status = file.frontmatter.translationStatus
    const source = file.frontmatter.translationSource
    if (!hasOwnership(file.frontmatter)) {
      errors.push(`${filePath}: missing translationStatus/translationSource`)
      return { errors, warnings }
    }

    const audit = auditMdxText(file.raw, {
      path: filePath,
      locale: file.frontmatter.lang,
    })
    errors.push(...audit.errors)
    warnings.push(...audit.warnings)

    if (status === 'machine') {
      const styleContext = await styleContextFor(file.frontmatter.lang)
      const reviewContext = {
        currentPromptVersion: reviewPromptVersion,
        currentStyleGuideSha256: styleContext.styleGuideSha256,
        currentRubricSha256: styleContext.rubricSha256,
      }
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

      const needsReview = Boolean(
        target &&
          (refreshAllReviews ||
            reviewMetadataIssues({
              config,
              target,
              currentTargetSha256: sha256(file.raw),
              ...reviewContext,
            }).length > 0 ||
            (target.unresolvedResearch ?? []).length > 0),
      )

      if (target && refreshReview && needsReview && errors.length === 0) {
        if (providerStopReason) {
          errors.push(
            `${filePath}: native review deferred after provider usage limit`,
          )
        } else
          try {
            console.log(`Reviewing ${filePath}`)
            await refreshNativeReview({
              config,
              manifest,
              filePath,
              file,
              target,
              styleContext,
            })
          } catch (error) {
            if (isCodexUsageLimitError(error))
              providerStopReason = error.message
            errors.push(
              `${filePath}: native review failed to run: ${error.message}`,
            )
          }
      }

      if (strictPublish) {
        errors.push(
          ...reviewMetadataIssues({
            config,
            target,
            currentTargetSha256: sha256(file.raw),
            ...reviewContext,
          }).map((issue) => `${filePath}: ${issue}`),
        )
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
    return { errors, warnings }
  }

  const requestedConcurrency = Number.parseInt(
    process.env.CODEX_TRANSLATION_REVIEW_CONCURRENCY ?? '',
    10,
  )
  const concurrency = refreshReview
    ? Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
      ? requestedConcurrency
      : 2
    : 8
  const results = new Array(files.length)
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, async () => {
      while (nextIndex < files.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await checkFile(files[index])
      }
    }),
  )
  const errors = results.flatMap((result) => result.errors)
  const warnings = results.flatMap((result) => result.warnings)

  if (refreshReview) {
    manifest.promptVersion = config.promptVersion
    await saveManifest(manifest)
  }
  return { errors, warnings, checked: files.length }
}

async function main() {
  const args = parseArgs()
  const result = await checkTranslationQuality({
    strictPublish: Boolean(args.strict_publish),
    refreshReview: Boolean(args.refresh_review),
    refreshAllReviews: Boolean(args.refresh_all_reviews),
    slug: args.slug ?? null,
    locale: args.locale ?? null,
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
