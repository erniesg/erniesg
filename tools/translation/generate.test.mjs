import { describe, expect, it } from 'vitest'
import { applyHumanApprovedTranslations } from './generate.mjs'

describe('human-approved segment translations', () => {
  it('preserves approved wording while leaving other machine segments intact', () => {
    const targetPath = 'src/content/blog/example/zh.mdx'
    const translations = applyHumanApprovedTranslations({
      config: {
        humanApprovedTranslations: {
          [targetPath]: {
            'English title': '人工确认标题',
          },
        },
      },
      targetPath,
      segments: [
        { id: 's0001', sourceText: 'English title' },
        { id: 's0002', sourceText: 'Other prose' },
      ],
      translations: {
        s0001: '机器标题',
        s0002: '机器正文',
      },
    })

    expect(translations).toEqual({
      s0001: '人工确认标题',
      s0002: '机器正文',
    })
  })
})
