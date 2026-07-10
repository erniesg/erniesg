import { describe, expect, it } from 'vitest'
import { sha256 } from './content.mjs'
import { revisionCandidateIssue } from './revise.mjs'

const raw = [
  '---',
  'lang: ja',
  'translationStatus: machine',
  'translationSource: codex',
  '---',
  '',
  '翻訳',
].join('\n')

function candidate(overrides = {}) {
  return {
    config: {
      promptVersion: '2026-07-10.3',
      reviewPromptVersion: '2026-07-10.2',
    },
    file: {
      raw,
      frontmatter: {
        lang: 'ja',
        translationStatus: 'machine',
        translationSource: 'codex',
      },
    },
    target: {
      status: 'machine',
      targetSha256: sha256(raw),
      qualityStatus: 'review-failed',
    },
    report: {
      targetSha256: sha256(raw),
      reviewPromptVersion: '2026-07-10.2',
    },
    ...overrides,
  }
}

describe('review-driven machine translation revision', () => {
  it('accepts only a current rejected machine target and report', () => {
    expect(revisionCandidateIssue(candidate())).toBeNull()
  })

  it('protects human-owned translations', () => {
    const value = candidate()
    value.file.frontmatter.translationStatus = 'final'
    expect(revisionCandidateIssue(value)).toBe('human-owned')
  })

  it('rejects a stale review report', () => {
    const value = candidate()
    value.report.targetSha256 = 'old-hash'
    expect(revisionCandidateIssue(value)).toBe('stale-quality-report')
  })
})
