import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentStructDemoCopy } from '../research/struct-demo-copy'
import { loadStructDemoEpubPreview } from './struct-demo-client'
import { strToU8, zipSync } from 'fflate'

afterEach(() => vi.unstubAllGlobals())

describe('demo message locale', () => {
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
    )

    expect(fetcher).toHaveBeenCalledWith(
      '/api/struct-demo/jobs/job-1/files/paper.epub',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.detail).toMatchObject({
      title: 'Ready preview',
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
      '/private.epub',
      'paper.epub',
      undefined,
      fetcher,
    )

    expect(events.map((event) => event.detail)).toEqual([
      { error: 'preview-unavailable' },
    ])
  })
})
