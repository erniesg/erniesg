import fs from 'node:fs/promises'
import matter from 'gray-matter'
import { describe, expect, it } from 'vitest'
import { canWriteExistingTarget, sha256 } from './content.mjs'

describe('author supplied Chinese loss original', () => {
  it('preserves the exact title and complete body and denies automatic rewriting', async () => {
    const filePath = 'src/content/blog/loss-price-love/zh.mdx'
    const raw = await fs.readFile(filePath, 'utf8')
    const original = await fs.readFile(
      'docs/translation/originals/loss-price-love.zh.txt',
      'utf8',
    )
    const { data, content } = matter(raw)
    const config = JSON.parse(
      await fs.readFile('.translation/config.json', 'utf8'),
    )
    const manifest = JSON.parse(
      await fs.readFile('.translation/manifest.json', 'utf8'),
    )
    const target = manifest.families['loss-price-love'].targets.zh
    expect(data.title).toBe('失去是挚爱付出的代价')
    const image = (
      await fs.readFile(
        'docs/translation/originals/loss-price-love.zh.image.mdx',
        'utf8',
      )
    ).trimEnd()
    const anchor = '回荡的是悔意的递归，在缓刑的幻境中鸣响。\n\n'
    expect(content).toBe(
      '\n' + original.replace(anchor, anchor + image + '\n\n'),
    )
    expect(content.replace(image + '\n\n', '')).toBe('\n' + original)
    expect(target.authorBodySha256).toBe(sha256(original))
    expect(target.targetSha256).toBe(sha256(raw))
    expect(
      canWriteExistingTarget({
        filePath,
        config,
        frontmatter: data,
        manifestTarget: target,
        currentText: raw,
      }),
    ).toBe(false)
  })
})
