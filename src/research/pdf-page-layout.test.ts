import { describe, expect, it } from 'vitest'
import { captionFontFamily } from './pdf-page-layout'

describe('PDF page layout', () => {
  it('normalizes caption font families without treating the face as semantic', () => {
    expect(captionFontFamily('Synthetic-NimbusRoman-BoldItalic')).toBe(
      'syntheticnimbus',
    )
    expect(captionFontFamily('LMRoman10-Regular')).toBe('lmroman')
  })
})
