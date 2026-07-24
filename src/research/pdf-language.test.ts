import { describe, expect, it } from 'vitest'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { inferPublicationLanguageFromPdfText } from './pdf-language'

function page(text: string): PdfPageAnalysis {
  const run: PdfSourceRun = {
    page: 1,
    text,
    x: 0.1,
    y: 0.1,
    width: 0.8,
    height: 0.02,
    rotation: 0,
    method: 'pdf-text',
    fontName: 'Body',
    fontSize: 10,
    confidence: 1,
  }
  return {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: text.length,
    imageCount: 0,
    runs: [run],
  }
}

describe('PDF text language inference', () => {
  it('proves a long overwhelmingly English source with bounded evidence', () => {
    const sentence =
      'In this paper, we show that the model is stable and that our method can be used for the analysis of data with a source-backed result.'
    const result = inferPublicationLanguageFromPdfText([
      page(Array.from({ length: 30 }, () => sentence).join(' ')),
    ])

    expect(result).toMatchObject({
      tag: 'en',
      wordCount: expect.any(Number),
      markerCount: expect.any(Number),
      competingMarkerCount: expect.any(Number),
    })
    expect(result?.evidence).toMatch(/^pdf-text-language:en:/u)
  })

  it.each([
    ['short', 'This source is too short to prove its publication language.'],
    [
      'French',
      Array.from(
        { length: 30 },
        () =>
          'Dans cet article, nous montrons que le modèle est stable et que les résultats sont utiles pour une analyse avec des données.',
      ).join(' '),
    ],
    [
      'mixed',
      `${Array.from({ length: 15 }, () => 'In this paper we analyze the model and the data with our method.').join(' ')} ${Array.from({ length: 15 }, () => 'Dans cet article nous analysons le modèle et les données avec notre méthode.').join(' ')}`,
    ],
  ])('leaves a %s source unproven', (_label, text) => {
    expect(inferPublicationLanguageFromPdfText([page(text)])).toBeNull()
  })
})
