import { describe, expect, it } from 'vitest'
import { canWriteExistingTarget, sha256 } from './content.mjs'

describe('translation write safety', () => {
  it('blocks missing ownership metadata', () => {
    expect(
      canWriteExistingTarget({
        filePath: 'src/content/blog/x/zh.mdx',
        frontmatter: {},
        manifestTarget: null,
        currentText: 'x',
      }),
    ).toBe(false)
  })

  it('blocks edited and final targets', () => {
    expect(
      canWriteExistingTarget({
        filePath: 'src/content/blog/x/zh.mdx',
        frontmatter: { translationStatus: 'edited' },
        manifestTarget: null,
        currentText: 'x',
      }),
    ).toBe(false)
    expect(
      canWriteExistingTarget({
        filePath: 'src/content/blog/x/zh.mdx',
        frontmatter: { translationStatus: 'final' },
        manifestTarget: null,
        currentText: 'x',
      }),
    ).toBe(false)
  })

  it('blocks hash drift for machine targets', () => {
    expect(
      canWriteExistingTarget({
        filePath: 'src/content/blog/x/zh.mdx',
        frontmatter: {
          translationStatus: 'machine',
          translationSource: 'codex',
        },
        manifestTarget: {
          status: 'machine',
          provider: 'codex-cli',
          targetSha256: sha256('old'),
        },
        currentText: 'human changed',
      }),
    ).toBe(false)
  })

  it('allows matching machine hash', () => {
    expect(
      canWriteExistingTarget({
        filePath: 'src/content/blog/x/zh.mdx',
        frontmatter: {
          translationStatus: 'machine',
          translationSource: 'codex',
        },
        manifestTarget: {
          status: 'machine',
          provider: 'codex-cli',
          targetSha256: sha256('old'),
        },
        currentText: 'old',
      }),
    ).toBe(true)
  })
  it('blocks human or imported provenance even with a matching hash', () => {
    const input = {
      frontmatter: { translationStatus: 'machine', translationSource: 'codex' },
      manifestTarget: {
        status: 'machine',
        provider: 'codex-cli',
        targetSha256: sha256('old'),
      },
      currentText: 'old',
    }
    expect(
      canWriteExistingTarget({
        ...input,
        manifestTarget: { ...input.manifestTarget, status: 'final' },
      }),
    ).toBe(false)
    for (const provider of ['human', 'imported', undefined]) {
      expect(
        canWriteExistingTarget({
          ...input,
          manifestTarget: { ...input.manifestTarget, provider },
        }),
      ).toBe(false)
    }
    expect(
      canWriteExistingTarget({
        ...input,
        manifestTarget: {
          ...input.manifestTarget,
          model: 'preexisting-machine-translation',
        },
      }),
    ).toBe(false)
    expect(
      canWriteExistingTarget({
        ...input,
        frontmatter: { ...input.frontmatter, translationSource: 'human' },
      }),
    ).toBe(false)
  })

  it('blocks protected files and directories despite machine labels and matching hashes', () => {
    const input = {
      filePath: 'src/content/blog/x/zh.mdx',
      frontmatter: { translationStatus: 'machine', translationSource: 'codex' },
      manifestTarget: {
        status: 'machine',
        provider: 'codex-cli',
        targetSha256: sha256('old'),
      },
      currentText: 'old',
    }
    for (const config of [
      { protectedHumanTranslations: [input.filePath] },
      { protectedLegacyDirs: ['src/content/blog/x'] },
    ])
      expect(canWriteExistingTarget({ ...input, config })).toBe(false)
  })
})
