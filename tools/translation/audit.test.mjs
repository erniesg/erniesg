import { describe, expect, it } from 'vitest'
import { auditMdxText, structuralParityIssues } from './audit.mjs'

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
    expect(
      ko.errors.some((error) => error.includes('direct translation')),
    ).toBe(true)
    expect(
      ja.errors.some((error) => error.includes('direct translation')),
    ).toBe(true)
  })

  it('fails untranslated ordinary English nouns and phrases outside code', () => {
    const zh = auditMdxText('这里先做 Prompt “engineering”。', {
      path: 'src/content/blog/x/zh.mdx',
      locale: 'zh',
    })
    const ko = auditMdxText(
      'spare time에는 negative prompt를 계속 다듬었다.',
      {
        path: 'src/content/blog/x/ko.mdx',
        locale: 'ko',
      },
    )

    expect(
      zh.errors.some((error) => error.includes('direct translation')),
    ).toBe(true)
    expect(
      ko.errors.some((error) => error.includes('direct translation')),
    ).toBe(true)
  })

  it('rejects bare web domains used as Markdown destinations', () => {
    const result = auditMdxText('参考 [you.com](you.com)。', {
      path: 'src/content/blog/x/zh.mdx',
      locale: 'zh',
    })

    expect(
      result.errors.some((error) => error.includes('bare web domain')),
    ).toBe(true)
  })

  it('allows the same technical words inside code fences', () => {
    const mdx = '```py\nfor chunk in chunks:\n    ingest(chunk)\n```'
    const result = auditMdxText(mdx, {
      path: 'src/content/blog/x/zh.mdx',
      locale: 'zh',
    })
    expect(result.errors).toEqual([])
  })

  it('fails untranslated iframe alt text when the adjacent caption is localized', () => {
    const mdx = [
      '<iframe alt="MLX MoE Inference on M2 Max" src="https://www.youtube.com/embed/example"></iframe>',
      '',
      'M2 Max 上的 MLX MoE 推理演示',
    ].join('\n')
    const result = auditMdxText(mdx, {
      path: 'src/content/blog/x/zh.mdx',
      locale: 'zh',
    })

    expect(
      result.errors.some((error) =>
        error.includes('untranslated reader-facing alt text'),
      ),
    ).toBe(true)
  })

  it('allows a localized iframe alt and caption pair', () => {
    const mdx = [
      '<iframe alt="M2 Max 上的 MLX MoE 推理演示" src="https://www.youtube.com/embed/example"></iframe>',
      '',
      'M2 Max 上的 MLX MoE 推理演示',
    ].join('\n')
    const result = auditMdxText(mdx, {
      path: 'src/content/blog/x/zh.mdx',
      locale: 'zh',
    })

    expect(result.errors).toEqual([])
  })

  it('rejects unescaped currency dollars in prose but not frontmatter or code', () => {
    const broken = auditMdxText(
      ['---', 'title: $1M ARR', '---', '', '손에 현금 $1M이 있다.'].join('\n'),
      { path: 'src/content/blog/x/ko.mdx', locale: 'ko' },
    )
    const safe = auditMdxText(
      [
        '---',
        'title: $1M ARR',
        '---',
        '',
        '손에 현금 \\$1M이 있다.',
        '',
        '```js',
        'const price = "$1"',
        '```',
      ].join('\n'),
      { path: 'src/content/blog/x/ko.mdx', locale: 'ko' },
    )

    expect(
      broken.errors.some((error) => error.includes('currency dollar')),
    ).toBe(true)
    expect(safe.errors).toEqual([])
  })

  it('rejects underscore emphasis touching CJK text', () => {
    const broken = auditMdxText('物語がどう_感じさせるか_だ。', {
      path: 'src/content/blog/x/ja.mdx',
      locale: 'ja',
    })
    const safe = auditMdxText('物語がどう*感じさせるか*だ。', {
      path: 'src/content/blog/x/ja.mdx',
      locale: 'ja',
    })

    expect(
      broken.errors.some((error) => error.includes('underscore emphasis')),
    ).toBe(true)
    expect(safe.errors).toEqual([])
  })

  it('rejects blockquote markers without a following space', () => {
    const broken = auditMdxText('>引用文', {
      path: 'src/content/blog/x/zh.mdx',
      locale: 'zh',
    })
    const safe = auditMdxText('> 引用文', {
      path: 'src/content/blog/x/zh.mdx',
      locale: 'zh',
    })

    expect(
      broken.errors.some((error) => error.includes('blockquote marker')),
    ).toBe(true)
    expect(safe.errors).toEqual([])
  })
})

describe('translation structural parity', () => {
  it('rejects changed URLs, relative media paths, and footnote identifiers', () => {
    const source = [
      '[source](https://example.com/a)',
      '![image](./image.png)',
      '[^note]: Source note',
    ].join('\n')
    const target = [
      '[来源](https://example.com/b)',
      '![图片](./other.png)',
      '[^注]: 译文注释',
    ].join('\n')

    const issues = structuralParityIssues(source, target, {
      path: 'src/content/blog/x/zh.mdx',
    })

    expect(issues).toHaveLength(3)
    expect(issues.some((issue) => issue.includes('URL'))).toBe(true)
    expect(issues.some((issue) => issue.includes('Markdown destination'))).toBe(
      true,
    )
    expect(issues.some((issue) => issue.includes('footnote'))).toBe(true)
  })

  it('accepts translated labels when protected destinations are unchanged', () => {
    const source = [
      '[source](https://example.com/a)',
      '![image](./image.png)',
      '<iframe src="https://example.com/embed"></iframe>',
    ].join('\n')
    const target = [
      '[来源](https://example.com/a)',
      '![图片](./image.png)',
      '<iframe src="https://example.com/embed"></iframe>',
    ].join('\n')

    expect(structuralParityIssues(source, target)).toEqual([])
  })
})
