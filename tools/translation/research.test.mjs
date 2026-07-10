import { describe, expect, it } from 'vitest'
import { extractResearchCandidates } from './research.mjs'

describe('translation research candidates', () => {
  it('finds product, place, publication, and program names in prose', () => {
    const segments = [
      {
        id: 's1',
        kind: 'markdown-paragraph',
        sourceText:
          'TextFX helped me write about Fu Gai Mountain, Bilibili, and MITx DEDP.',
      },
    ]
    const candidates = extractResearchCandidates({
      sourceLocale: 'en',
      targetLocale: 'zh',
      segments,
      glossary: { terms: {} },
    }).map((candidate) => candidate.text)

    expect(candidates).toContain('TextFX')
    expect(candidates).toContain('Fu Gai Mountain')
    expect(candidates).toContain('Bilibili')
    expect(candidates).toContain('MITx DEDP')
  })

  it('ignores code-looking text and URLs', () => {
    const segments = [
      {
        id: 's1',
        kind: 'markdown-paragraph',
        sourceText:
          'Run `TextFX` or open https://example.com/TextFX before writing prose.',
      },
    ]
    const candidates = extractResearchCandidates({
      sourceLocale: 'en',
      targetLocale: 'zh',
      segments,
      glossary: { terms: {} },
    }).map((candidate) => candidate.text)

    expect(candidates).not.toContain('TextFX')
  })

  it('drops generic capitalized sentence fragments', () => {
    const segments = [
      {
        id: 's1',
        kind: 'markdown-paragraph',
        sourceText:
          'Recently I started writing. Then ChatGPT suggested Fu Gai Mountain.',
      },
    ]
    const candidates = extractResearchCandidates({
      segments,
      glossary: { terms: {} },
    }).map((candidate) => candidate.text)

    expect(candidates).not.toContain('Recently I')
    expect(candidates).toContain('ChatGPT')
    expect(candidates).toContain('Fu Gai Mountain')
  })

  it('bounds research hints so translation prompts stay concise', () => {
    const sourceText = Array.from(
      { length: 40 },
      (_, index) => `ProductX${index} appears here.`,
    ).join(' ')
    const candidates = extractResearchCandidates({
      segments: [{ id: 's1', kind: 'markdown-paragraph', sourceText }],
      glossary: { terms: {} },
    })

    expect(candidates).toHaveLength(24)
  })
})
