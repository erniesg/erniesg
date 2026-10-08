import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseFragment, serialize } from 'parse5'
import {
  safeHistoryHtml,
  readPublishedHistoryHtml,
} from './book-history-safe-html'
async function api() {
  const url = new URL('./book-history-diff.ts', import.meta.url)
  const module = existsSync(url)
    ? await import(/* @vite-ignore */ url.href)
    : {}
  expect(module.diffHistoryHtml).toBeTypeOf('function')
  return module as any
}
const safe = (html: string) => safeHistoryHtml(html, 'h-fixture').html
function text(html: string): string {
  const visit = (node: any): string =>
    node.nodeName === '#text'
      ? node.value
      : (node.childNodes ?? []).map(visit).join('')
  return visit(parseFragment(html))
}
function withoutMarks(html: string) {
  const tree: any = parseFragment(html)
  const visit = (node: any) => {
    for (const child of [...(node.childNodes ?? [])]) visit(child)
    node.childNodes = (node.childNodes ?? []).flatMap((child: any) =>
      ['del', 'ins'].includes(child.tagName) ? child.childNodes : [child],
    )
  }
  visit(tree)
  return serialize(tree)
}
describe('readonly history comparison RED families', () => {
  it('reconstructs Unicode edits across existing text leaves without changing structure', async () => {
    const { diffHistoryHtml } = await api()
    const before = safe('<p>café <strong>fox</strong> 🦊</p>'),
      after = safe('<p>café <strong>quick fox</strong> 🦊</p>')
    const result = diffHistoryHtml(before, after)
    expect(result.mode).toBe('detailed')
    expect(text(result.before)).toBe('café fox 🦊')
    expect(text(result.after)).toBe('café quick fox 🦊')
    expect(result.after).toContain(
      '<strong><ins class="history-diff-add">quick </ins>fox</strong>',
    )
    expect(withoutMarks(result.before)).toBe(
      readPublishedHistoryHtml(before, 'history-before').html,
    )
    expect(withoutMarks(result.after)).toBe(
      readPublishedHistoryHtml(after, 'history-after').html,
    )
  })
  it('reports derived-digest-only differences without inventing a visible change', async () => {
    const { diffHistoryHtml } = await api()
    const block = (digest: string) =>
      safe(
        `<div class="block" data-block-kind="prose" data-block-digest="${digest}" id="prose-1"><p>Same text.</p></div>`,
      )
    const result = diffHistoryHtml(block('012345abcdef'), block('fedcba543210'))
    expect(result.changed).toBe(false)
    expect(result.metadataChanged).toBe(true)
    expect(result.notice).toContain('rendered content unchanged')
    expect(result.before + result.after).not.toMatch(/<(?:ins|del|section)\b/)
  })
  it('keeps generated decorations outside the historical input grammar', async () => {
    const { diffHistoryHtml } = await api()
    const result = diffHistoryHtml(
      safe('<p>Shared old text.</p>'),
      safe('<p>Shared new text.</p>'),
    )
    expect(result.before).toContain(
      '<del class="history-diff-remove">old</del>',
    )
    expect(result.after).toContain('<ins class="history-diff-add">new</ins>')
    expect(() =>
      diffHistoryHtml(result.before, safe('<p>Other.</p>')),
    ).toThrow()
    expect(result.before + result.after).not.toMatch(/\s(?:href|style|on\w+)=/)
    for (const name of [
      'history-diff-remove',
      'history-diff-add',
      'history-diff-block',
      'history-diff-before',
      'history-diff-after',
      'history-diff-format',
    ]) {
      expect(() =>
        diffHistoryHtml(
          safe(
            `<section class="${name}"><p>Impersonated decoration</p></section>`,
          ),
          safe('<p>Other.</p>'),
        ),
      ).toThrow()
    }
  })
  it('splits a changed word across multiple styled leaves without dropping content', async () => {
    const { diffHistoryHtml } = await api()
    const before = safe('<p>hello <strong>ca</strong><em>fé</em> tail</p>'),
      after = safe('<p>hello <strong>ca</strong><em>fés</em> tail</p>')
    const r = diffHistoryHtml(before, after)
    expect(text(r.before)).toBe('hello café tail')
    expect(text(r.after)).toBe('hello cafés tail')
    expect(r.before).toContain(
      '<strong><del class="history-diff-remove">ca</del></strong><em><del class="history-diff-remove">fé</del></em>',
    )
    expect(withoutMarks(r.before)).toBe(
      readPublishedHistoryHtml(before, 'history-before').html,
    )
    expect(withoutMarks(r.after)).toBe(
      readPublishedHistoryHtml(after, 'history-after').html,
    )
  })
  it('keeps later blocks equal after early insertion and supports reverse order', async () => {
    const { diffHistoryHtml } = await api(),
      a = safe('<p>First.</p><p>Second.</p>'),
      b = safe('<p>New.</p><p>First.</p><p>Second.</p>')
    const r = diffHistoryHtml(a, b),
      reverse = diffHistoryHtml(b, a)
    expect(r.before).not.toContain('history-diff-')
    expect(r.after).toContain('history-diff-after')
    expect(reverse.after).not.toContain('history-diff-')
    expect(reverse.before).toContain('history-diff-before')
    expect(r.after).toMatch(/<p>First\.<\/p><p>Second\.<\/p>$/)
  })
  it('shows formatting and complex changes without removing either version', async () => {
    const { diffHistoryHtml } = await api()
    for (const [a, b] of [
      ['<p><em>Same words</em></p>', '<p><strong>Same words</strong></p>'],
      [
        '<p><a href="/a">Same words</a></p>',
        '<p><a href="/b">Same words</a></p>',
      ],
      [
        '<pre><code>old value</code></pre>',
        '<pre><code>new value</code></pre>',
      ],
    ]) {
      const r = diffHistoryHtml(safe(a), safe(b))
      expect(r.changed).toBe(true)
      expect(r.before).toContain('history-diff-before')
      expect(r.after).toContain('history-diff-after')
      expect(r.before).toContain('history-diff-format')
      expect(r.after).not.toContain('href=')
    }
  })
  it('refuses oversized matrices before allocation and preserves complete versions', async () => {
    const { diffHistoryHtml } = await api(),
      html = safe(
        Array.from({ length: 500 }, (_, i) => `<p>Row ${i}</p>`).join(''),
      )
    const r = diffHistoryHtml(html, html)
    expect(r.mode).toBe('coarse')
    expect(r.work.matrices).toBe(0)
    expect(r.changed).toBeNull()
    expect(text(r.before)).toBe(text(html))
    expect(text(r.after)).toBe(text(html))
    expect(r.notice).toContain('Both complete versions')
  })
  it('preserves detailed text at the aggregate budget and falls back completely above it', async () => {
    const { diffHistoryHtml } = await api()
    const words = (last: string, n: number) =>
      Array.from({ length: 500 }, (_, i) =>
        i === 498 ? 'part' + n : i === 499 ? last : 'shared',
      ).join(' ')
    const markup = (n: number, last: string) =>
      safe(
        Array.from({ length: n }, (_, i) => `<p>${words(last, i)}</p>`).join(
          '',
        ),
      )
    const exact = diffHistoryHtml(markup(4, 'old'), markup(4, 'new'))
    expect(exact.mode).toBe('detailed')
    expect(exact.work.wordCells).toBe(4_000_000)
    const over = diffHistoryHtml(markup(5, 'old'), markup(5, 'new'))
    expect(over.mode).toBe('coarse')
    expect(over.work.wordCells).toBe(4_000_000)
    expect(over.before + over.after).not.toContain('history-diff-')
    expect(text(over.before)).toBe(text(markup(5, 'old')))
  })
  it('normalizes only view IDs and local SVG references in repeated figures', async () => {
    const { diffHistoryHtml } = await api()
    const svg =
      '<svg viewBox="0 0 30 20" class="links" role="img"><defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#94a3b8"></path></marker></defs><line x1="0" y1="1" x2="10" y2="1" stroke="#94a3b8" marker-end="url(#arrow)"></line></svg>'
    const r = diffHistoryHtml(
      safe(svg + svg),
      safeHistoryHtml(svg + svg, 'h-other').html,
    )
    expect(r.changed).toBe(false)
    const ids = [...(r.before + r.after).matchAll(/ id="([^"]+)"/g)].map(
      (m) => m[1],
    )
    expect(new Set(ids).size).toBe(ids.length)
    expect(
      diffHistoryHtml(safe(svg), safe(svg.replace('x2="10"', 'x2="11"')))
        .changed,
    ).toBe(true)
  })
  it('names formatting changes using finite labels rather than an unspecified difference', async () => {
    const { diffHistoryHtml } = await api()
    for (const [a, b, label] of [
      [
        '<div><h2>Same words</h2></div>',
        '<div><h3>Same words</h3></div>',
        'Heading changed.',
      ],
      [
        '<p><em>Same words</em></p>',
        '<p><strong>Same words</strong></p>',
        'Emphasis changed.',
      ],
      [
        '<div><ul><li>Same words</li></ul></div>',
        '<div><ol><li>Same words</li></ol></div>',
        'List changed.',
      ],
      [
        '<p><a href="/old">Same words</a></p>',
        '<p><a href="/new">Same words</a></p>',
        'Link destination changed.',
      ],
    ])
      expect(diffHistoryHtml(safe(a), safe(b)).after).toContain(label)
  })
  it('validates both decoration namespaces before any detailed-resource fallback', async () => {
    const { diffHistoryHtml } = await api(),
      over = safe('<p>Bounded text.</p>'.repeat(513))
    for (const name of [
      'history-diff-remove',
      'history-diff-add',
      'history-diff-block',
      'history-diff-before',
      'history-diff-after',
      'history-diff-format',
    ]) {
      const impersonated = safe(`<section class="${name}">Source</section>`)
      expect(() => diffHistoryHtml(over, impersonated)).toThrow()
      expect(() => diffHistoryHtml(impersonated, over)).toThrow()
    }
  })
  it('labels whole-block additions and removals without relying on color', async () => {
    const { diffHistoryHtml } = await api()
    const r = diffHistoryHtml(
      safe('<p>Unrelated previous paragraph.</p>'),
      safe('<p>Entirely different replacement.</p>'),
    )
    expect(r.before).toContain('Removed block.')
    expect(r.after).toContain('Added block.')
  })
})
