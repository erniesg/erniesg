import { describe, expect, it } from 'vitest'
import { clampPdfPage } from './SourcePdfPageViewer'

describe('source PDF page navigation', () => {
  it('keeps page navigation inside the loaded document', () => {
    expect(clampPdfPage(-4, 20)).toBe(1)
    expect(clampPdfPage(7.9, 20)).toBe(7)
    expect(clampPdfPage(99, 20)).toBe(20)
  })

  it('fails closed before a document reports its page count', () => {
    expect(clampPdfPage(Number.NaN, 0)).toBe(1)
    expect(clampPdfPage(8, 0)).toBe(1)
  })
})
