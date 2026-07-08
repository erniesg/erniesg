import { describe, expect, it } from 'vitest'
import { auditMdxText } from './audit.mjs'

describe('translation audit', () => {
  it('fails corrupted fixed HTML vocabulary', () => {
    const mdx =
      '<audio controls="true" preload="meta数据" src="./file.mp3"></audio>'
    const result = auditMdxText(mdx, {
      path: 'src/content/blog/x/zh.mdx',
      locale: 'zh',
    })
    expect(result.errors.some((error) => error.includes('preload'))).toBe(true)
  })

  it('fails direct translation residue', () => {
    const mdx =
      '这就是我如何把 items chunk 到 数据set 里，并 ingest 更多 数据源s。'
    const result = auditMdxText(mdx, {
      path: 'src/content/blog/x/zh.mdx',
      locale: 'zh',
    })
    expect(
      result.errors.some((error) => error.includes('direct translation')),
    ).toBe(true)
  })

  it('fails Korean and Japanese hybrid machine residue outside code', () => {
    const ko = auditMdxText('더 많은 데이터 소스s를 ingest할 필요가 있다.', {
      path: 'src/content/blog/x/ko.mdx',
      locale: 'ko',
    })
    const ja = auditMdxText(
      'もっと多くの データソースs を ingest する必要がある。',
      {
        path: 'src/content/blog/x/ja.mdx',
        locale: 'ja',
      },
    )
    expect(ko.errors.some((error) => error.includes('direct translation'))).toBe(
      true,
    )
    expect(ja.errors.some((error) => error.includes('direct translation'))).toBe(
      true,
    )
  })

  it('allows the same technical words inside code fences', () => {
    const mdx = '```py\nfor chunk in chunks:\n    ingest(chunk)\n```'
    const result = auditMdxText(mdx, {
      path: 'src/content/blog/x/zh.mdx',
      locale: 'zh',
    })
    expect(result.errors).toEqual([])
  })
})
