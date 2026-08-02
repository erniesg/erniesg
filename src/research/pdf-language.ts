import type { PdfPageAnalysis } from './import-types'

const MINIMUM_WORDS = 200
const MINIMUM_LATIN_RATIO = 0.98
const MINIMUM_ENGLISH_MARKERS = 10
const MINIMUM_ENGLISH_DENSITY = 0.075
const MINIMUM_LANGUAGE_MARGIN = 3

const LANGUAGE_MARKERS = {
  en: new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'by',
    'for',
    'from',
    'has',
    'in',
    'is',
    'it',
    'of',
    'on',
    'or',
    'our',
    'that',
    'the',
    'their',
    'this',
    'to',
    'was',
    'we',
    'were',
    'which',
    'with',
  ]),
  de: new Set([
    'aber',
    'auf',
    'das',
    'dem',
    'den',
    'der',
    'die',
    'ein',
    'eine',
    'für',
    'ist',
    'mit',
    'nicht',
    'und',
    'von',
    'zu',
  ]),
  es: new Set([
    'como',
    'con',
    'del',
    'el',
    'en',
    'es',
    'esta',
    'la',
    'las',
    'los',
    'para',
    'por',
    'que',
    'se',
    'un',
    'una',
    'y',
  ]),
  fr: new Set([
    'avec',
    'ce',
    'ces',
    'dans',
    'de',
    'des',
    'du',
    'est',
    'et',
    'la',
    'le',
    'les',
    'nous',
    'par',
    'pour',
    'que',
    'qui',
    'une',
  ]),
  it: new Set([
    'che',
    'con',
    'da',
    'del',
    'della',
    'è',
    'gli',
    'il',
    'in',
    'la',
    'le',
    'per',
    'sono',
    'un',
    'una',
    'e',
  ]),
  pt: new Set([
    'as',
    'com',
    'da',
    'das',
    'de',
    'do',
    'dos',
    'em',
    'é',
    'no',
    'os',
    'para',
    'por',
    'que',
    'uma',
    'um',
    'e',
  ]),
} as const

export type PdfTextLanguageInference = {
  tag: 'en'
  wordCount: number
  markerCount: number
  markerDensity: number
  latinLetterRatio: number
  competingMarkerCount: number
  evidence: string
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function inferEnglishFromNormalizedText(
  text: string,
  evidenceTag: 'pdf-text-language' | 'pdf-text-language-nfkc',
): PdfTextLanguageInference | null {
  const letters = text.match(/\p{Letter}/gu) ?? []
  if (letters.length === 0) return null
  const latinLetterRatio =
    letters.filter((letter) => /\p{Script=Latin}/u.test(letter)).length /
    letters.length
  if (latinLetterRatio < MINIMUM_LATIN_RATIO) return null

  const words = (text.toLocaleLowerCase().match(/\p{Letter}+/gu) ?? []).filter(
    (word) => word.length > 0,
  )
  if (words.length < MINIMUM_WORDS) return null
  const counts = Object.fromEntries(
    Object.entries(LANGUAGE_MARKERS).map(([tag, markers]) => [
      tag,
      words.filter((word) => markers.has(word as never)).length,
    ]),
  ) as Record<keyof typeof LANGUAGE_MARKERS, number>
  const distinctEnglishMarkers = new Set(
    words.filter((word) => LANGUAGE_MARKERS.en.has(word)),
  ).size
  const markerDensity = counts.en / words.length
  const competingMarkerCount = Math.max(
    counts.de,
    counts.es,
    counts.fr,
    counts.it,
    counts.pt,
  )
  if (
    distinctEnglishMarkers < MINIMUM_ENGLISH_MARKERS ||
    markerDensity < MINIMUM_ENGLISH_DENSITY ||
    counts.en < competingMarkerCount * MINIMUM_LANGUAGE_MARGIN
  ) {
    return null
  }
  const result = {
    tag: 'en' as const,
    wordCount: words.length,
    markerCount: counts.en,
    markerDensity: rounded(markerDensity),
    latinLetterRatio: rounded(latinLetterRatio),
    competingMarkerCount,
  }
  return {
    ...result,
    evidence: `${evidenceTag}:en:words=${result.wordCount}:markers=${result.markerCount}:density=${result.markerDensity}:latin=${result.latinLetterRatio}:competitor=${result.competingMarkerCount}`,
  }
}

/**
 * Conservatively proves only overwhelmingly English born-digital text. This
 * is not a general language detector: unsupported, short, mixed, or close
 * Latin-language candidates deliberately remain `und`.
 */
export function inferPublicationLanguageFromPdfText(
  pages: readonly PdfPageAnalysis[],
): PdfTextLanguageInference | null {
  const sourceText = pages
    .flatMap((page) => page.runs)
    .map((run) => run.text)
    .join(' ')
  const nfcText = sourceText.normalize('NFC')
  const nfcInference = inferEnglishFromNormalizedText(
    nfcText,
    'pdf-text-language',
  )
  if (nfcInference) return nfcInference

  const nfkcText = sourceText.normalize('NFKC')
  return nfkcText === nfcText
    ? null
    : inferEnglishFromNormalizedText(nfkcText, 'pdf-text-language-nfkc')
}
