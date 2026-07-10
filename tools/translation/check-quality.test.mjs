import { describe, expect, it } from 'vitest'
import {
  normalizeReviewResult,
  reviewMetadataIssues,
} from './check-quality.mjs'
import { buildReviewPrompt, buildTranslationPrompt } from './prompts.mjs'

const config = {
  promptVersion: '2026-07-10.3',
  reviewPromptVersion: '2026-07-10.2',
  minReviewScore: 0.88,
  requiredReviewerPasses: 2,
}

const currentReviewContext = {
  currentPromptVersion: '2026-07-10.2',
  currentStyleGuideSha256: 'style-hash',
  currentRubricSha256: 'rubric-hash',
}

function currentReviewMetadata(overrides = {}) {
  return {
    qualityStatus: 'passed',
    reviewedTargetSha256: 'current-hash',
    reviewScore: 0.94,
    reviewPassCount: 2,
    reviewPromptVersion: '2026-07-10.2',
    reviewStyleGuideSha256: 'style-hash',
    reviewRubricSha256: 'rubric-hash',
    ...overrides,
  }
}

describe('strict native-review metadata', () => {
  it('rejects a passed review when it belongs to an older target hash', () => {
    const issues = reviewMetadataIssues({
      config,
      target: currentReviewMetadata({
        reviewedTargetSha256: 'old-hash',
      }),
      currentTargetSha256: 'new-hash',
      ...currentReviewContext,
    })

    expect(issues).toContain('native review does not match current target hash')
  })

  it('accepts a current structured review that meets score and pass policy', () => {
    const issues = reviewMetadataIssues({
      config,
      target: currentReviewMetadata(),
      currentTargetSha256: 'current-hash',
      ...currentReviewContext,
    })

    expect(issues).toEqual([])
  })

  it('supports hash-bound legacy parallel reviews without inventing a score', () => {
    const issues = reviewMetadataIssues({
      config,
      target: currentReviewMetadata({
        reviewScore: null,
        reviewProvider: 'codex-parallel-agents',
        reviewProfile: [
          'native-editor-reviewer',
          'adversarial-direct-translation-reviewer',
        ],
      }),
      currentTargetSha256: 'current-hash',
      ...currentReviewContext,
    })

    expect(issues).toEqual([])
  })

  it('rejects review approval produced under an older prompt or rubric', () => {
    const issues = reviewMetadataIssues({
      config,
      target: currentReviewMetadata({
        reviewPromptVersion: '2026-07-09',
        reviewRubricSha256: 'old-rubric-hash',
      }),
      currentTargetSha256: 'current-hash',
      ...currentReviewContext,
    })

    expect(issues).toContain('native review used an outdated review prompt')
    expect(issues).toContain('native review used an outdated rubric')
  })
})

describe('review prompt policy', () => {
  it('requires human-facing quotations to be translated', () => {
    const prompt = buildReviewPrompt({
      sourceLocale: 'en',
      targetLocale: 'ja',
      sourcePath: 'src/content/blog/x/index.mdx',
      targetPath: 'src/content/blog/x/ja.mdx',
      reviewerProfile: 'native-editor-reviewer',
      styleContext: {
        style: 'Native Japanese.',
        rubric: 'Reject direct translation.',
        glossary: { terms: {} },
        corpus: '',
      },
    })

    expect(prompt).toContain('Translate human-facing quotations')
    expect(prompt).not.toContain(
      'Accept deliberate preservation of product names, code terms, quoted English',
    )
    expect(prompt).toContain(
      'translationStatus: machine is intentional ownership metadata',
    )
    expect(prompt).toContain(
      'Minor polish notes alone must still return passed=true',
    )
  })

  it('feeds independent rejection details into a revision prompt', () => {
    const prompt = buildTranslationPrompt({
      sourceLocale: 'en',
      targetLocale: 'zh',
      sourcePath: 'src/content/blog/x/index.mdx',
      styleContext: {
        style: 'Native Chinese.',
        rubric: 'Reject direct translation.',
        glossary: { terms: {} },
        corpus: '',
      },
      researchReport: { candidates: [] },
      revisionContext: {
        reviews: [
          {
            issues: [
              {
                problem: 'English-shaped sentence order.',
                suggestion: 'Rewrite with native cadence.',
              },
            ],
          },
        ],
      },
    })

    expect(prompt).toContain('Independent native reviewers rejected')
    expect(prompt).toContain('English-shaped sentence order.')
    expect(prompt).toContain(
      'scan the entire revision for untranslated ordinary English prose',
    )
  })
})

describe('review result normalization', () => {
  it('does not let a request to translate protected code comments block publishing', () => {
    const normalized = normalizeReviewResult(
      {
        passed: false,
        score: 0.86,
        issues: [
          {
            severity: 'major',
            location: 'Python code block',
            problem: 'The explanatory code comments remain in English.',
            suggestion: 'Translate the comments.',
          },
        ],
        unresolvedResearch: [],
        notes: 'Otherwise native.',
      },
      { minReviewScore: 0.88 },
    )

    expect(normalized.passed).toBe(true)
    expect(normalized.score).toBe(0.9)
    expect(normalized.issues).toEqual([])
    expect(normalized.ignoredIssues).toHaveLength(1)
  })

  it('keeps genuine reader-facing meaning drift as a publish blocker', () => {
    const normalized = normalizeReviewResult(
      {
        passed: false,
        score: 0.86,
        issues: [
          {
            severity: 'major',
            location: 'opening paragraph',
            problem: 'The translation reverses the meaning.',
            suggestion: 'Restore the source meaning.',
          },
        ],
        unresolvedResearch: [],
        notes: 'Meaning drift remains.',
      },
      { minReviewScore: 0.88 },
    )

    expect(normalized.passed).toBe(false)
    expect(normalized.issues).toHaveLength(1)
    expect(normalized.ignoredIssues).toBeUndefined()
  })
})
