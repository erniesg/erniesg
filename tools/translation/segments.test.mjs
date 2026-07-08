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
    expect(segments.some((segment) => segment.kind === 'frontmatter-title')).toBe(
      true,
    )
    expect(
      segments.some((segment) => segment.kind === 'frontmatter-description'),
    ).toBe(true)
    expect(
      segments.some((segment) => segment.sourceText === 'Translate this heading'),
    ).toBe(true)
    expect(
      segments.some(
        (segment) => segment.sourceText === 'Translate this title for readers',
      ),
    ).toBe(true)
    expect(
      segments.some((segment) => segment.sourceText === 'Translate image alt'),
    ).toBe(true)
    expect(
      segments.some((segment) => segment.sourceText === 'Translate this link text'),
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
      segments.some((segment) => segment.sourceText.includes('https://example.com')),
    ).toBe(false)
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
