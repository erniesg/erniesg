import { describe, expect, it } from 'vitest'
import { repairText } from './repair.mjs'

describe('deterministic translation residue repair', () => {
  it('repairs ordinary Chinese prose without touching inline code or URLs', () => {
    const input =
      '把内容 chunk 成小段，再 query 一次。运行 `chunk --query`，参考 https://example.com/query。'
    const output = repairText(input, 'zh')

    expect(output).toContain('把内容 分块 成小段，再 查询 一次。')
    expect(output).toContain('`chunk --query`')
    expect(output).toContain('https://example.com/query')
  })

  it('escapes currency dollars in prose without changing frontmatter or code', () => {
    const input = [
      '---',
      'title: $1M ARR',
      '---',
      '',
      '目标是 $1M。',
      '',
      '```js',
      'const price = "$1"',
      '```',
    ].join('\n')
    const output = repairText(input, 'zh')

    expect(output).toContain('title: $1M ARR')
    expect(output).toContain('目标是 \\$1M。')
    expect(output).toContain('const price = "$1"')
  })
})
