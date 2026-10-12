import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentStructDemoCopy } from '../research/struct-demo-copy'

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
