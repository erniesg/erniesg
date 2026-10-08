/** Offline supplied-data preview pilots. No Git, provider or real proposal reads. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { applyHunks, formatHunks, parseHunks } from '../../src/annotations/criticmarkup'
vi.mock('../../src/lib/book-history-safe-html', async original => {
  const actual = await original<typeof import('../../src/lib/book-history-safe-html')>()
  return { ...actual, safeHistoryHtml: vi.fn(actual.safeHistoryHtml) }
})
import { safeHistoryHtml } from '../../src/lib/book-history-safe-html'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const sourcePath = 'books/chapters/one.md', head = 'a'.repeat(40)
const document = (body: string, kind = 'concept') => `+++\nid = "one"\nkind = "${kind}"\ntitle = "Preview fixture"\n+++\n${body}`
function input(body = 'Old public prose.\n') {
  const content = document(body)
  return {
    expectedHead: head,
    snapshot: { site: 'https://ernie.sg', document: 'https://ernie.sg/books/test/one/', revision: 2, baseCommit: head, sourcePath, body: formatHunks([{ baseStartLine: 6, baseEndLine: 6, criticMarkup: '{~~Old~>New~~} public prose.\n' }]) },
    mapping: { site: 'https://ernie.sg', head, documents: [{ document: 'https://ernie.sg/books/test/one/', sourcePath }] },
    tree: { commit: head, files: [{ path: sourcePath, mode: '100644', sha256: sha(content), content }], occupied: ['books', 'books/chapters', sourcePath] },
  }
}
async function api() {
  const url = new URL('./proposal-preview.ts', import.meta.url)
  const module = existsSync(url) ? await import(/* @vite-ignore */ url.href) : {}
  expect(module.previewCurrentProposal, 'the local preview adapter must exist').toBeTypeOf('function')
  return module.previewCurrentProposal as (value: unknown) => any
}
describe('current proposal preview supplied data', () => {
  it('renders the exact canonical patched source while preserving all caller data', async () => {
    const preview = await api(), data = input(), original = JSON.stringify(data)
    const result = preview(data)
    expect(result).toMatchObject({ status: 'previewed', provenance: 'unverified-input-provenance', revision: 2, staleBase: false })
    const proposed = applyHunks(parseHunks(data.snapshot.body), data.tree.files[0].content)
    expect(result.baseSha256).toBe(data.tree.files[0].sha256)
    expect(result.proposedSha256).toBe(sha(proposed))
    expect(result.safeHtml).toContain('New public prose.')
    expect(result.safeHtml).not.toContain('Old public prose.')
    expect(JSON.stringify(data)).toBe(original)
    expect(result).not.toHaveProperty('approved')
    expect(result).not.toHaveProperty('sourceOID')
  })
  it('uses supplied figure data and refuses an introduced dependency missing from that base', async () => {
    const preview = await api(), data = input()
    data.snapshot.body = formatHunks([{ baseStartLine: 6, baseEndLine: 6, criticMarkup: '{~~Old~>New~~} public prose.\n{++:::figure{id="cells"}\n:::\n++}' }])
    const figure = JSON.stringify({ type: 'cells', values: [1, 2], caption: 'Supplied base figure' })
    data.tree.files.push({ path: 'books/figures/cells.json', mode: '100644', sha256: sha(figure), content: figure })
    data.tree.occupied.push('books/figures', 'books/figures/cells.json')
    const good = preview(data)
    expect(good.status).toBe('previewed')
    expect(good.safeHtml).toContain('Supplied base figure')
    data.tree.files.pop(); data.tree.occupied.splice(-2)
    expect(preview(data).status).toBe('not_evaluated')
  })
  it('refuses mismatched commit/document/stamps and forged map bytes without render output', async () => {
    const preview = await api()
    const variants = [
      (d: ReturnType<typeof input>) => { d.tree.commit = 'b'.repeat(40) },
      (d: ReturnType<typeof input>) => { d.snapshot.sourcePath = 'books/chapters/other.md' },
      (d: ReturnType<typeof input>) => { d.snapshot.revision = 0 },
      (d: ReturnType<typeof input>) => { d.tree.files[0].content += 'unbound' },
    ]
    for (const change of variants) {
      const data = input(); change(data)
      const result = preview(data)
      expect(result.status).toBe('refused')
      expect(result).not.toHaveProperty('safeHtml')
    }
  })
  it('does not treat an occupied implicit starter, including an empty tree, as absent', async () => {
    const preview = await api(), data = input('Old public prose.\n:::run\n:::\n')
    const source = 'books/challenges/one/challenge.md'
    data.snapshot.sourcePath = data.mapping.documents[0].sourcePath = data.tree.files[0].path = source
    data.tree.files[0].content = document('Old public prose.\n:::run\n:::\n', 'challenge')
    data.tree.files[0].sha256 = sha(data.tree.files[0].content)
    data.tree.occupied = ['books', 'books/challenges', 'books/challenges/one', source]
    expect(preview(data).status).toBe('previewed')
    data.tree.occupied.push('books/challenges/one/starter.py')
    expect(preview(data).status).toBe('not_evaluated')
  })
  it('reports resource refusal and stale-base preview without asserting rebase or approval', async () => {
    const preview = await api(), data = input()
    data.expectedHead = data.mapping.head = 'b'.repeat(40)
    expect(preview(data)).toMatchObject({ status: 'previewed', staleBase: true, provenance: 'unverified-input-provenance' })
    data.snapshot.body = 'x'.repeat(64 * 1024 + 1)
    expect(preview(data)).toMatchObject({ status: 'not_evaluated' })
  })
})


it('preflights oversized source strings before allocating a Buffer copy', async () => {
  const preview = await api(), data = input()
  const large = 'x'.repeat(2 * 1024 * 1024 + 1)
  data.tree.files[0].content = large
  const original = Buffer.from
  let copied = false
  const spy = vi.spyOn(Buffer, 'from').mockImplementation(((...args: any[]) => {
    if (args[0] === large) copied = true
    return (original as any)(...args)
  }) as any)
  try {
    expect(preview(data)).toMatchObject({ status: 'not_evaluated' })
    expect(copied).toBe(false)
  } finally { spy.mockRestore() }
})


it('bounds the complete preview result after finite-profile expansion', async () => {
  const preview = await api(), data = input()
  vi.mocked(safeHistoryHtml).mockReturnValueOnce({ html: 'x'.repeat(8 * 1024 * 1024), blocks: [] })
  const result = preview(data)
  expect(result).toMatchObject({ status: 'not_evaluated', reason: 'preview-result-limit' })
  expect(result).not.toHaveProperty('safeHtml')
})

it('keeps binding and complete-map failures closed over every row shape', async () => {
  const preview = await api()
  const changes: ((data: ReturnType<typeof input>) => void)[] = [
    d => { d.tree.files.push({ ...d.tree.files[0] }) },
    d => { d.tree.occupied.push(d.tree.occupied[0]) },
    d => { d.tree.occupied = d.tree.occupied.filter(name => name !== 'books/chapters') },
    d => { d.tree.occupied.push(sourcePath + '/child') },
    d => { d.tree.files[0].mode = '120000' },
    d => { d.tree.files[0].mode = '040000' },
    d => { Object.assign(d.tree.files[0], { extra: true }) },
    d => { Object.assign(d, { approved: true }) },
    d => { Object.assign(d.snapshot, { state: 'approved' }) },
    d => { d.tree.files[0].content += '\ud800' },
    d => { d.tree.occupied.push('../other') },
    d => { d.tree.files.push({ path: 'books/chapters/other.md', mode: '100644', content: 'foreign', sha256: 'b'.repeat(64) }); d.tree.occupied.push('books/chapters/other.md') },
  ]
  for (const change of changes) {
    const data = input(); change(data)
    expect(preview(data)).toMatchObject({ status: 'refused' })
  }
})

it('retains CRLF exact bytes, inert links and confidential local-only output', async () => {
  const preview = await api(), data = input()
  const source = document('Old [public](https://example.invalid/) prose.\n').replaceAll('\n', '\r\n')
  data.tree.files[0].content = source; data.tree.files[0].sha256 = sha(source)
  data.snapshot.body = formatHunks([{ baseStartLine: 6, baseEndLine: 6, criticMarkup: '{~~Old~>New~~} [public](https://example.invalid/) prose.\r\n' }])
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')]
  try {
    const result = preview(data)
    expect(result.status).toBe('previewed')
    expect(result.proposedSha256).toBe(sha(applyHunks(parseHunks(data.snapshot.body), source)))
    expect(result.safeHtml).toContain('data-history-link-destination="https://example.invalid/"')
    expect(result.safeHtml).not.toMatch(/ href=|<script|<button|<textarea/)
    expect(result.dependencies).toEqual([])
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  } finally { for (const log of logs) log.mockRestore() }
})


it('preserves a BOM and refuses visibly when the canonical renderer cannot parse that source', async () => {
  const preview = await api(), data = input()
  data.tree.files[0].content = '\ufeff' + data.tree.files[0].content
  data.tree.files[0].sha256 = sha(data.tree.files[0].content)
  const before = JSON.stringify(data)
  expect(preview(data)).toEqual({ status: 'not_evaluated', reason: 'renderer-unavailable' })
  expect(JSON.stringify(data)).toBe(before)
})
