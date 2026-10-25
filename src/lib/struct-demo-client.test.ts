import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentStructDemoCopy } from '../research/struct-demo-copy'
import { loadStructDemoEpubPreview } from './struct-demo-client'
import { strToU8, zipSync } from 'fflate'

afterEach(() => vi.unstubAllGlobals())

describe('demo message locale', () => {
  it('uses compact daily quota labels in every supported locale', () => {
    const cases = [
      ['en', '3/3 today'],
      ['zh-Hans', '3/3（今日）'],
      ['ja-JP', '3/3（今日）'],
      ['ko-KR', '3/3 (오늘)'],
    ] as const

    for (const [locale, expected] of cases) {
      vi.stubGlobal('document', { documentElement: { lang: locale } })
      expect(currentStructDemoCopy().remaining(3, 3)).toBe(expected)
    }
  })

  it('uses the rendered Japanese document ahead of a stale Chinese preference', () => {
    vi.stubGlobal('document', { documentElement: { lang: 'ja-JP' } })
    vi.stubGlobal('localStorage', { getItem: () => 'zh' })
    expect(currentStructDemoCopy().download('original.epub')).toBe(
      'original.epub をダウンロード',
    )
  })

  it('keeps Korean errors available when browser storage is blocked', () => {
    vi.stubGlobal('document', { documentElement: { lang: 'ko' } })
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('Blocked')
      },
    })
    expect(currentStructDemoCopy().choose).toBe('먼저 PDF를 선택해 주세요.')
  })

  it('normalizes the simplified Chinese HTML language', () => {
    vi.stubGlobal('document', { documentElement: { lang: 'zh-Hans' } })
    expect(currentStructDemoCopy().download('original.epub')).toBe(
      '下载 original.epub',
    )
  })

  it('falls back to usable English messages for unsupported stored values', () => {
    vi.stubGlobal('document', { documentElement: { lang: 'en' } })
    vi.stubGlobal('localStorage', { getItem: () => '__proto__' })
    expect(currentStructDemoCopy().choose).toBe('Choose a PDF first.')
  })
})

describe('completed demo EPUB preview', () => {
  it('dispatches safe preview HTML from the completed file without a second conversion', async () => {
    const root = new EventTarget()
    const events: CustomEvent[] = []
    root.addEventListener('struct:preview-ready', (event) =>
      events.push(event as CustomEvent),
    )
    const epub = zipSync({
      'META-INF/container.xml': strToU8(
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      ),
      'book.opf': strToU8(
        '<package><metadata><dc:title>Ready preview</dc:title></metadata><manifest><item id="chapter" href="chapter.xhtml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
      ),
      'chapter.xhtml': strToU8('<html><body><h1>Read me</h1></body></html>'),
    })
    const fetcher = vi.fn().mockResolvedValue(
      new Response(epub, {
        headers: { 'content-length': String(epub.byteLength) },
      }),
    )

    await loadStructDemoEpubPreview(
      root,
      '/api/struct-demo/jobs/job-1/files/paper.epub',
      'paper.epub',
      undefined,
      fetcher,
      'preview-1',
    )

    expect(fetcher).toHaveBeenCalledWith(
      '/api/struct-demo/jobs/job-1/files/paper.epub',
      expect.objectContaining({
        credentials: 'same-origin',
        redirect: 'error',
      }),
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.detail).toMatchObject({
      title: 'Ready preview',
      requestId: 'preview-1',
      html: expect.stringContaining('<h1>Read me</h1>'),
    })
  })

  it('reports an unavailable preview when the download exceeds the local cap', async () => {
    const root = new EventTarget()
    const events: CustomEvent[] = []
    root.addEventListener('struct:preview-ready', (event) =>
      events.push(event as CustomEvent),
    )
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(1), {
        headers: { 'content-length': String(32 * 1024 * 1024 + 1) },
      }),
    )

    await loadStructDemoEpubPreview(
      root,
      '/api/struct-demo/jobs/job-1/files/paper.epub',
      'paper.epub',
      undefined,
      fetcher,
      'preview-2',
    )

    expect(events.map((event) => event.detail)).toEqual([
      { error: 'preview-unavailable', requestId: 'preview-2' },
    ])
  })

  it('rejects off-contract and redirected download responses before parsing', async () => {
    const root = new EventTarget()
    const events: CustomEvent[] = []
    root.addEventListener('struct:preview-ready', (event) =>
      events.push(event as CustomEvent),
    )
    const fetcher = vi.fn()

    await loadStructDemoEpubPreview(
      root,
      'https://example.test/book.epub',
      'paper.epub',
      undefined,
      fetcher,
      'preview-3',
    )

    expect(fetcher).not.toHaveBeenCalled()
    expect(events.map((event) => event.detail)).toEqual([
      { error: 'preview-unavailable', requestId: 'preview-3' },
    ])

    const redirected = new Response(new Uint8Array([80, 75]))
    Object.defineProperty(redirected, 'redirected', { value: true })
    fetcher.mockResolvedValueOnce(redirected)
    await loadStructDemoEpubPreview(
      root,
      '/api/struct-demo/jobs/job-1/files/paper.epub',
      'paper.epub',
      undefined,
      fetcher,
      'preview-4',
    )
    expect(events.at(-1)?.detail).toEqual({
      error: 'preview-unavailable',
      requestId: 'preview-4',
    })
  })
})
