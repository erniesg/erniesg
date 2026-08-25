import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { proseDominantPdfMathSource as compatibilityProseClassifier } from './pdf-regions'

describe('PDF region source-line analysis boundary', () => {
  it('owns prose-dominant math classification behind the compatibility export', async () => {
    const moduleUrl = new URL('./pdf-region-line-analysis.ts', import.meta.url)
    expect(existsSync(moduleUrl)).toBe(true)

    const extracted = await import(moduleUrl.href)
    const source = {
      text: 'This sentence explains the result clearly.',
      width: 0.72,
      runs: [
        {
          page: 1,
          text: 'This sentence explains the result clearly.',
          x: 0.1,
          y: 0.2,
          width: 0.72,
          height: 0.02,
          rotation: 0,
          method: 'pdf-text' as const,
          fontName: 'Times-Roman',
          fontSize: 10,
          confidence: 1,
        },
      ],
    }

    expect(extracted.proseDominantPdfMathSource(source)).toBe(true)
    expect(compatibilityProseClassifier).toBe(
      extracted.proseDominantPdfMathSource,
    )
  })
})
