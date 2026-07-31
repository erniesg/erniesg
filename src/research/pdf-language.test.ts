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

function mathematicalBold(value: string) {
  return [...value]
    .map((character) => {
      if (character >= 'A' && character <= 'Z') {
        return String.fromCodePoint(
          0x1d400 + character.codePointAt(0)! - 'A'.codePointAt(0)!,
        )
      }
      if (character >= 'a' && character <= 'z') {
        return String.fromCodePoint(
          0x1d41a + character.codePointAt(0)! - 'a'.codePointAt(0)!,
        )
      }
      return character
    })
    .join('')
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
    expect(result?.evidence).toBe(
      'pdf-text-language:en:words=810:markers=450:density=0.55556:latin=1:competitor=30',
    )
  })

  it('retries the same proof gates for NFKC-normalized mathematical Latin text', () => {
    const sentence = mathematicalBold(
      'In this paper, we show that the model is stable and that our method can be used for the analysis of data with a source-backed result.',
    )
    const result = inferPublicationLanguageFromPdfText([
      page(Array.from({ length: 30 }, () => sentence).join(' ')),
    ])

    expect(result).toMatchObject({
      tag: 'en',
      wordCount: 810,
      markerCount: 450,
      markerDensity: 0.55556,
      latinLetterRatio: 1,
      competingMarkerCount: 30,
    })
    expect(result?.evidence).toBe(
      'pdf-text-language-nfkc:en:words=810:markers=450:density=0.55556:latin=1:competitor=30',
    )
  })

  it('keeps the NFC proof when compatibility glyphs do not prevent it', () => {
    const sentence =
      'In this paper, we show that the model is stable and that our method can be used for the analysis of data with a source-backed result.'
    const result = inferPublicationLanguageFromPdfText([
      page(
        `${Array.from({ length: 30 }, () => sentence).join(' ')} ${mathematicalBold('model')}`,
      ),
    ])

    expect(result?.evidence).toBe(
      'pdf-text-language:en:words=811:markers=450:density=0.55487:latin=0.99842:competitor=30',
    )
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

  it.each([
    [
      'short',
      mathematicalBold(
        'This source is too short to prove its publication language.',
      ),
    ],
    [
      'French',
      mathematicalBold(
        Array.from(
          { length: 30 },
          () =>
            'Dans cet article, nous montrons que le modèle est stable et que les résultats sont utiles pour une analyse avec des données.',
        ).join(' '),
      ),
    ],
    [
      'mixed',
      mathematicalBold(
        `${Array.from({ length: 15 }, () => 'In this paper we analyze the model and the data with our method.').join(' ')} ${Array.from({ length: 15 }, () => 'Dans cet article nous analysons le modèle et les données avec notre méthode.').join(' ')}`,
      ),
    ],
  ])('leaves an NFKC-styled %s source unproven', (_label, text) => {
    expect(inferPublicationLanguageFromPdfText([page(text)])).toBeNull()
  })
})
