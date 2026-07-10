import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  canWriteExistingTarget,
  getManifestTarget,
  listTargetSidecars,
  loadConfig,
  loadManifest,
  parseArgs,
  readMdxFile,
  saveManifest,
  sha256,
} from './content.mjs'
import { generateTranslation } from './generate.mjs'
import { isCodexUsageLimitError } from './codex-cli.mjs'

export function revisionCandidateIssue({ config, file, target, report }) {
  if (file.frontmatter.translationStatus !== 'machine') return 'human-owned'
  if (!target) return 'missing-manifest-target'
  if (target.qualityStatus !== 'review-failed') return 'review-not-failed'
  if (
    !canWriteExistingTarget({
      frontmatter: file.frontmatter,
      manifestTarget: target,
      currentText: file.raw,
    })
  )
    return 'target-hash-drift'
  if (!report) return 'missing-quality-report'
  if (report.targetSha256 !== sha256(file.raw)) return 'stale-quality-report'
  if (
    report.reviewPromptVersion !==
    (config.reviewPromptVersion ?? config.promptVersion)
  )
    return 'stale-review-prompt'
  return null
}

function revisionFeedback(report) {
  return {
    sourcePath: report.sourcePath,
    targetPath: report.targetPath,
    reviews: (report.reviews ?? []).map((review) => ({
      passed: review.passed,
      score: review.score,
      issues: review.issues ?? [],
      unresolvedResearch: review.unresolvedResearch ?? [],
      notes: review.notes ?? '',
    })),
  }
}

export async function reviseFailedTranslations({
  write = false,
  slug = null,
  locale = null,
} = {}) {
  const config = await loadConfig()
  const manifest = await loadManifest()
  const paths = (await listTargetSidecars(['zh', 'ko', 'ja'])).filter(
    (filePath) => {
      if (locale && !filePath.endsWith(`/${locale}.mdx`)) return false
      if (slug && !filePath.startsWith(`src/content/blog/${slug}/`))
        return false
      return true
    },
  )
  const candidates = []
  const results = []

  for (const filePath of paths) {
    const file = await readMdxFile(filePath)
    const target = getManifestTarget(manifest, filePath)
    let report = null
    if (target?.qualityReportPath) {
      try {
        report = JSON.parse(await fs.readFile(target.qualityReportPath, 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    const issue = revisionCandidateIssue({ config, file, target, report })
    if (issue) {
      results.push({ filePath, action: 'skipped', reason: issue })
      continue
    }
    candidates.push({ filePath, file, target, report })
  }

  if (!write) {
    results.push(
      ...candidates.map((candidate) => ({
        filePath: candidate.filePath,
        action: 'would-revise',
      })),
    )
    return results
  }

  const requestedConcurrency = Number.parseInt(
    process.env.CODEX_TRANSLATION_REVISION_CONCURRENCY ?? '',
    10,
  )
  const concurrency =
    Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
      ? requestedConcurrency
      : 2
  let nextIndex = 0
  let providerStopReason = null
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, candidates.length) },
      async () => {
        while (nextIndex < candidates.length && !providerStopReason) {
          const candidate = candidates[nextIndex]
          nextIndex += 1
          console.log(`Revising ${candidate.filePath}`)
          try {
            const generated = await generateTranslation({
              sourcePath: candidate.target.sourcePath,
              targetLocale: candidate.file.frontmatter.lang,
              write,
              manifest,
              saveManifestAfterWrite: false,
              revisionContext: revisionFeedback(candidate.report),
            })
            results.push({
              filePath: candidate.filePath,
              action: write ? 'revised' : 'would-revise',
              ...generated,
            })
          } catch (error) {
            const providerStopped = isCodexUsageLimitError(error)
            if (providerStopped) providerStopReason = error.message
            results.push({
              filePath: candidate.filePath,
              action: providerStopped ? 'deferred' : 'failed',
              error: error.message,
            })
          }
        }
      },
    ),
  )

  if (providerStopReason) {
    for (; nextIndex < candidates.length; nextIndex += 1) {
      results.push({
        filePath: candidates[nextIndex].filePath,
        action: 'deferred',
        error: providerStopReason,
      })
    }
  }

  if (write) {
    manifest.promptVersion = config.promptVersion
    await saveManifest(manifest)
  }
  return results
}

async function main() {
  const args = parseArgs()
  const results = await reviseFailedTranslations({
    write: Boolean(args.write),
    slug: args.slug ?? null,
    locale: args.locale ?? null,
  })
  const counts = results.reduce((summary, result) => {
    summary[result.action] = (summary[result.action] ?? 0) + 1
    return summary
  }, {})
  for (const [action, count] of Object.entries(counts))
    console.log(`${action}: ${count}`)
  for (const result of results.filter((item) =>
    ['failed', 'deferred'].includes(item.action),
  ))
    console.error(`${result.filePath}: ${result.error}`)
  if (results.some((result) => ['failed', 'deferred'].includes(result.action)))
    process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
