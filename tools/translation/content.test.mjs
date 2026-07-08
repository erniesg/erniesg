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
        frontmatter: { translationStatus: 'machine' },
        manifestTarget: { targetSha256: sha256('old') },
        currentText: 'human changed',
      }),
    ).toBe(false)
  })

  it('allows matching machine hash', () => {
    expect(
      canWriteExistingTarget({
        filePath: 'src/content/blog/x/zh.mdx',
        frontmatter: { translationStatus: 'machine' },
        manifestTarget: { targetSha256: sha256('old') },
        currentText: 'old',
      }),
    ).toBe(true)
  })
})
