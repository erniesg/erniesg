import { describe, expect, it } from 'vitest'
import {
  applySegmentTranslations,
  assertLockedRegionsPreserved,
  extractSegments,
} from './segments.mjs'

describe('MDX translation segmenter', () => {
  it('extracts title, description, prose, link text, and reader-facing attributes', () => {
    const mdx = [
      '---',
      'title: "A.I. for Humans"',
      'description: "A short description"',
      'date: 2026-07-09',
      'authors: ["erniesg"]',
      '---',
      '',
      "import Demo from './Demo.astro'",
      '',
      '# Translate this heading',
      '',
      '<Demo data-id="keep-this" title="Translate this title for readers" />',
      '',
      '![Translate image alt](./image.png)',
      '',
      '[Translate this link text](https://example.com)',
    ].join('\n')

    const segments = extractSegments(mdx)
    expect(
      segments.some((segment) => segment.kind === 'frontmatter-title'),
    ).toBe(true)
    expect(
      segments.some((segment) => segment.kind === 'frontmatter-description'),
    ).toBe(true)
    expect(
      segments.some(
        (segment) => segment.sourceText === 'Translate this heading',
      ),
    ).toBe(true)
    expect(
      segments.some(
        (segment) => segment.sourceText === 'Translate this title for readers',
      ),
    ).toBe(true)
    expect(
      segments.some((segment) =>
        segment.sourceText.includes('Translate image alt'),
      ),
    ).toBe(true)
    expect(
      segments.some((segment) =>
        segment.sourceText.includes('Translate this link text'),
      ),
    ).toBe(true)
  })

  it('does not translate inline code, code fences, URLs, imports, or fixed HTML vocabulary', () => {
    const mdx = [
      '---',
      'title: "Code Post"',
      'description: "A post with code"',
      'date: 2026-07-09',
      'authors: ["erniesg"]',
      '---',
      '',
      'Translate this sentence.',
      '',
      'Do not translate `npm run build`.',
      '',
      '```ts',
      'const preload = "metadata"',
      'console.log(preload)',
      '```',
      '',
      '[Translate this link text](https://example.com/path?x=metadata)',
    ].join('\n')

    const segments = extractSegments(mdx)
    expect(
      segments.some((segment) => segment.sourceText.includes('npm run build')),
    ).toBe(false)
    expect(
      segments.some((segment) => segment.sourceText.includes('const preload')),
    ).toBe(false)
    expect(
      segments.some((segment) =>
        segment.sourceText.includes('https://example.com'),
      ),
    ).toBe(false)
  })

  it('keeps tag slugs and author ids out of translation segments', () => {
    const mdx = [
      '---',
      'title: "Localized title"',
      'description: "Localized description"',
      'tags:',
      '  - sinking markets',
      '  - microdramas',
      'authors:',
      '  - erniesg',
      '---',
      '',
      'Translate the body.',
    ].join('\n')

    const sourceTexts = extractSegments(mdx).map(
      (segment) => segment.sourceText,
    )

    expect(sourceTexts).not.toContain('sinking markets')
    expect(sourceTexts).not.toContain('microdramas')
    expect(sourceTexts).not.toContain('erniesg')
    expect(sourceTexts).toContain('Translate the body.')
  })

  it('extracts reader-facing prose around inline links, code, and HTML tags', () => {
    const mdx = [
      'Before [reader-facing link](https://example.com) after.',
      '',
      'Run `npm run build` after translating the prose.',
      '',
      '- Explain the `inline code` to readers.',
      '',
      '<strong>Reader-facing prose</strong>',
    ].join('\n')

    const segments = extractSegments(mdx)
    const sourceTexts = segments.map((segment) => segment.sourceText)

    expect(
      sourceTexts.some((text) =>
        text.includes('Before [reader-facing link](⟪LOCKED_0001⟫) after.'),
      ),
    ).toBe(true)
    expect(
      sourceTexts.some((text) =>
        text.includes('Run ⟪LOCKED_0001⟫ after translating the prose.'),
      ),
    ).toBe(true)
    expect(
      sourceTexts.some((text) =>
        text.includes('Explain the ⟪LOCKED_0001⟫ to readers.'),
      ),
    ).toBe(true)
    expect(sourceTexts).toContain('Reader-facing prose')
    expect(sourceTexts.some((text) => text.includes('npm run build'))).toBe(
      false,
    )
    expect(
      sourceTexts.some((text) => text.includes('https://example.com')),
    ).toBe(false)
  })

  it('patches prose around inline code without modifying the code', () => {
    const mdx = 'Run `npm run build` after translating the prose.'
    const segments = extractSegments(mdx)
    const sentence = segments.find(
      (segment) => segment.kind === 'markdown-paragraph',
    )
    const token = sentence.protectedTokens[0].token

    const output = applySegmentTranslations(mdx, {
      [sentence.id]: `运行 ${token} 后再继续。`,
    })

    expect(output).toBe('运行 `npm run build` 后再继续。')
  })

  it('rejects a translation that drops a protected placeholder', () => {
    const mdx = 'Push to `main` and redeploy.'
    const [sentence] = extractSegments(mdx)

    expect(() =>
      applySegmentTranslations(mdx, {
        [sentence.id]: '推送后重新部署。',
      }),
    ).toThrow('must preserve placeholder')
  })

  it('serializes translated frontmatter as a safe quoted YAML scalar', () => {
    const mdx = [
      '---',
      'title: "Source: it\'s complicated"',
      'description: "Quoted source with \\"magic\\" inside"',
      '---',
    ].join('\n')
    const segments = extractSegments(mdx)
    const title = segments.find((segment) => segment.frontmatterKey === 'title')
    const description = segments.find(
      (segment) => segment.frontmatterKey === 'description',
    )

    const output = applySegmentTranslations(mdx, {
      [title.id]: '标题：带冒号',
      [description.id]: '他说“可以”',
    })

    expect(output).toContain('title: "标题：带冒号"')
    expect(output).toContain('description: "他说“可以”"')
  })

  it('replaces the complete folded frontmatter scalar', () => {
    const mdx = [
      '---',
      'title: Folded description',
      'description: >-',
      '  First source line',
      '  and the second source line.',
      'date: 2026-07-10',
      '---',
      '',
      'Body copy.',
    ].join('\n')
    const segments = extractSegments(mdx)
    const description = segments.find(
      (segment) => segment.frontmatterKey === 'description',
    )

    const output = applySegmentTranslations(mdx, {
      [segments.find((segment) => segment.frontmatterKey === 'title').id]:
        '折叠标题',
      [description.id]: '完整替换后的简介',
      [segments.find((segment) => segment.sourceText === 'Body copy.').id]:
        '正文。',
    })

    expect(description.sourceText).toBe(
      'First source line and the second source line.',
    )
    expect(output).toContain('description: "完整替换后的简介"\ndate:')
    expect(output).not.toContain('First source line')
    expect(output).not.toContain('second source line')
  })

  it('patches only approved source ranges and preserves locked regions', () => {
    const mdx = [
      '---',
      'title: "Code Post"',
      'description: "A post with code"',
      'date: 2026-07-09',
      'authors: ["erniesg"]',
      '---',
      '',
      'Translate this sentence.',
      '',
      '<audio controls="true" preload="metadata" src="./file.mp3"></audio>',
      '',
    ].join('\n')
    const segments = extractSegments(mdx)
    const sentence = segments.find(
      (segment) => segment.sourceText === 'Translate this sentence.',
    )
    expect(sentence).toBeTruthy()
    const output = applySegmentTranslations(mdx, {
      [sentence.id]: '翻译这一句。',
    })
    expect(output).toContain('翻译这一句。')
    expect(output).toContain(
      '<audio controls="true" preload="metadata" src="./file.mp3"></audio>',
    )
    expect(output).not.toContain('Translate this sentence.')
    expect(() => assertLockedRegionsPreserved(mdx, output)).not.toThrow()
  })
})
