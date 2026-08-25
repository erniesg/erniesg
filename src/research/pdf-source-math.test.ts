import { describe, expect, it } from 'vitest'
import type { PdfSourceRun } from './import-types'
import {
  proseDominantPdfMathSource,
  sourceInlineFractionPairs,
} from './pdf-source-math'

function run(
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize: number,
): PdfSourceRun {
  return {
    page: 1,
    text,
    x,
    y,
    width,
    height: 0.014,
    rotation: 0,
    method: 'pdf-text',
    fontName: 'Synthetic-CMMI7',
    fontSize,
    confidence: 1,
  }
}

describe('PDF source math', () => {
  it('retains a geometrically stacked numerator and denominator pair', () => {
    const base = {
      ...run('a', 0.1, 0.5, 0.01, 10),
      fontName: 'Synthetic-CMMI10',
    }
    const numerator = run('x', 0.111, 0.494, 0.006, 7)
    const denominator = run('y', 0.111, 0.507, 0.006, 7)

    expect(
      sourceInlineFractionPairs({
        id: 'stacked-pair',
        page: 1,
        text: 'xy',
        x: 0.111,
        y: 0.494,
        width: 0.006,
        height: 0.022,
        fontSize: 7,
        column: 'single',
        runs: [base, numerator, denominator],
      }),
    ).toEqual([[numerator, denominator]])
  })

  it('keeps ordinary long-form prose out of math classification', () => {
    const prose = run(
      'This sentence describes the geometry without an equation.',
      0.1,
      0.2,
      0.6,
      10,
    )

    expect(
      proseDominantPdfMathSource({
        text: prose.text,
        width: prose.width,
        runs: [{ ...prose, fontName: 'Synthetic-Serif' }],
      }),
    ).toBe(true)
  })
})
