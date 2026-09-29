import { describe, expect, it } from 'vitest'
import { proposeHunks, toUnifiedDiff } from './criticmarkup'
import {
  isEditable,
  parseMarkdown,
  replaceText,
  retypeBlock,
  schemaViolations,
  serializeMarkdown,
  splitParagraph,
} from './prose-schema'

const roundTrip = (source: string) => serializeMarkdown(parseMarkdown(source))

describe('edits never create structure (PR #395 review)', () => {
  it('retyped text with a leading indent stays a paragraph, not indented code', () => {
    for (const lead of ['    ', '\t', '      ']) {
      const edited = serializeMarkdown(retypeBlock(parseMarkdown('Old text.\n'), 0, `${lead}prose`))
      const reread = parseMarkdown(edited)
      expect(reread.blocks.every(isEditable)).toBe(true)
      expect(reread.blocks[0]).toMatchObject({ type: 'paragraph' })
    }
  })

  it('a suffix moved to a line start by a deletion is escaped', () => {
    const doc = parseMarkdown('prefix # title\n')
    const edited = serializeMarkdown(replaceText(doc, 0, 'prefix ', ''))
    const reread = parseMarkdown(edited)
    expect(reread.blocks[0]).toMatchObject({ type: 'paragraph' })
  })

  it('a suffix moved to a line start by an inserted newline is escaped', () => {
    const doc = parseMarkdown('one - two\n')
    const edited = serializeMarkdown(replaceText(doc, 0, 'one ', 'one\n'))
    const reread = parseMarkdown(edited)
    expect(reread.blocks).toHaveLength(1)
    expect(reread.blocks[0]).toMatchObject({ type: 'paragraph' })
  })

  it('deleting all of an emphasis, strong or link removes the wrapper', () => {
    for (const [source, word] of [
      ['a *word* b\n', 'word'],
      ['a **word** b\n', 'word'],
      ['a [word](https://x.test) b\n', 'word'],
    ] as const) {
      const edited = serializeMarkdown(replaceText(parseMarkdown(source), 0, word, ''))
      expect(edited).not.toMatch(/\*\*|\[\]|\(\s*https/)
      expect(edited.replace(/\s+/g, ' ').trim()).toBe('a b')
    }
  })

  it('splits a paragraph inside emphasis, keeping the mark on each side', () => {
    const doc = splitParagraph(parseMarkdown('Before *formatted text* after\n'), 0, 'text')
    expect(serializeMarkdown(doc)).toBe('Before *formatted*\n\n*text* after\n')
  })
})

describe('schemaViolations validates structure, not only content (PR #395 review)', () => {
  const para = (extra: Record<string, unknown>) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: 'hi' }],
    after: '\n',
    ...extra,
  })

  it('rejects a link whose scheme the editor would not permit', () => {
    const link = { type: 'link', href: 'javascript:void0', content: [{ type: 'text', text: 'x' }] }
    expect(schemaViolations(link)).not.toEqual([])
  })

  it('rejects structure smuggled through after, prefix, level, marker and indent', () => {
    expect(schemaViolations(para({ after: '\n:::solution\nx\n:::\n' }))).not.toEqual([])
    const heading = { type: 'heading', level: 2, prefix: ':::solution\n## ', content: [{ type: 'text', text: 'h' }], after: '\n' }
    expect(schemaViolations(heading)).not.toEqual([])
    expect(schemaViolations({ ...heading, prefix: '## ', level: 9 })).not.toEqual([])
    expect(schemaViolations({ ...heading, prefix: '### ', level: 2 })).not.toEqual([])
    const item = { type: 'list_item', marker: '- ', indent: '  ', content: [{ type: 'text', text: 'i' }] }
    expect(schemaViolations(item)).toEqual([])
    expect(schemaViolations({ ...item, marker: ':::x\n- ' })).not.toEqual([])
    expect(schemaViolations({ ...item, indent: 'x' })).not.toEqual([])
    expect(schemaViolations({ type: 'em', marker: '`', content: [{ type: 'text', text: 'e' }] })).not.toEqual([])
    expect(schemaViolations({ type: 'strong', marker: '*', content: [{ type: 'text', text: 's' }] })).not.toEqual([])
  })

  it('accepts every parsed book block', () => {
    const doc = parseMarkdown('# Title\n\nA *b* [c](https://x.test "t").\n\n- one\n- two\n')
    expect(schemaViolations(doc)).toEqual([])
  })
})

describe('directive blocks close exactly as the renderer does (PR #395 review)', () => {
  it('a line of four colons inside a directive does not close it', () => {
    const source = ':::statement\nIntro\n::::\nStill inside.\n:::\n\nAfter.\n'
    const doc = parseMarkdown(source)
    expect(serializeMarkdown(doc)).toBe(source)
    const editable = doc.blocks.filter(isEditable).map((b) => serializeMarkdown({ ...doc, leading: '', blocks: [b] }))
    expect(editable.join('')).not.toContain('Still inside')
    expect(roundTrip(source)).toBe(source)
  })
})

describe('proposals next to literal CriticMarkup (PR #395 review)', () => {
  it('proposes an edit whose context lines contain CriticMarkup syntax', () => {
    const base = 'Keep this line.\n```\n{~~a~>b~~}\n```\nChange me here.\nTail.\n'
    const edited = base.replace('Change me here.', 'Changed it here.')
    const hunks = proposeHunks(base, edited)
    expect(hunks.length).toBeGreaterThan(0)
    const diff = toUnifiedDiff(hunks, base, 'x.md')
    expect(diff).toContain('+Changed it here.')
  })
})
