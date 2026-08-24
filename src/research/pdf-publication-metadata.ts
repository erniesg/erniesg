import type { ResearchPaper } from './schema'
import type { PdfPageAnalysis } from './import-types'
import { inferPublicationLanguageFromPdfText } from './pdf-language'

export type PdfDocumentMetadata = {
  title?: string
  author?: string
  subject?: string
  language?: string
  modified?: string
  modifiedSource?: 'pdf-info-mod-date' | 'file-last-modified'
}

export function validDate(value?: string) {
  if (!value) return '1970-01-01'
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf())
    ? '1970-01-01'
    : parsed.toISOString().slice(0, 10)
}

function validArtifactModifiedAt(value?: string) {
  if (!value) return '1970-01-01T00:00:00.000Z'
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf())
    ? '1970-01-01T00:00:00.000Z'
    : parsed.toISOString()
}

const OCR_LANGUAGE_TAGS: Readonly<Record<string, string>> = {
  ara: 'ar',
  ben: 'bn',
  ces: 'cs',
  chi_sim: 'zh-Hans',
  chi_tra: 'zh-Hant',
  cze: 'cs',
  deu: 'de',
  div: 'dv',
  dut: 'nl',
  ell: 'el',
  eng: 'en',
  fas: 'fa',
  fra: 'fr',
  fre: 'fr',
  ger: 'de',
  gre: 'el',
  heb: 'he',
  hin: 'hi',
  ind: 'id',
  ita: 'it',
  jpn: 'ja',
  kor: 'ko',
  may: 'ms',
  msa: 'ms',
  nld: 'nl',
  per: 'fa',
  pol: 'pl',
  por: 'pt',
  pus: 'ps',
  rus: 'ru',
  snd: 'sd',
  spa: 'es',
  syr: 'syr',
  tam: 'ta',
  tel: 'te',
  tha: 'th',
  tur: 'tr',
  uig: 'ug',
  ukr: 'uk',
  urd: 'ur',
  vie: 'vi',
  yid: 'yi',
  zho: 'zh',
}

function canonicalOcrLanguageTag(value: string) {
  const normalized = value.trim().replace(/_/g, '_').toLocaleLowerCase()
  const mapped = OCR_LANGUAGE_TAGS[normalized]
  if (mapped) return mapped
  if (
    normalized !== 'und' &&
    !/^[a-z]{2}(?:-[a-z0-9]{2,8})*$/i.test(value.trim())
  ) {
    return null
  }
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? null
  } catch {
    return null
  }
}

export function rtlLanguage(tag: string) {
  const locale = new Intl.Locale(tag)
  const script = locale.script
  if (
    script &&
    ['Arab', 'Hebr', 'Syrc', 'Thaa', 'Nkoo', 'Adlm'].includes(script)
  ) {
    return true
  }
  return [
    'ar',
    'dv',
    'fa',
    'he',
    'ks',
    'ku',
    'ps',
    'sd',
    'syr',
    'ug',
    'ur',
    'yi',
  ].includes(locale.language)
}

const RTL_STRONG_SCRIPT =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u

function strongScriptDirection(pages: readonly PdfPageAnalysis[]) {
  const letters = pages
    .flatMap((page) => page.runs)
    .flatMap((run) => run.text.match(/\p{Letter}/gu) ?? [])
  const rtlCount = letters.filter((character) =>
    RTL_STRONG_SCRIPT.test(character),
  ).length
  const otherStrongCount = letters.length - rtlCount
  return {
    value:
      rtlCount > 0 && otherStrongCount === 0
        ? ('rtl' as const)
        : ('unknown' as const),
    observedDirection:
      rtlCount > 0 && otherStrongCount === 0
        ? ('rtl' as const)
        : otherStrongCount > 0 && rtlCount === 0
          ? ('ltr' as const)
          : ('unknown' as const),
    rtlCount,
    otherStrongCount,
  }
}

export function pdfPublicationMetadata(
  pages: readonly PdfPageAnalysis[],
  metadata: PdfDocumentMetadata,
): Pick<
  ResearchPaper,
  'language' | 'baseDirection' | 'artifactModifiedAt' | 'metadataLineage'
> {
  const explicitTokens = pages.flatMap((page) =>
    page.ocr?.languageMode === 'explicit'
      ? page.ocr.languages.flatMap((language) =>
          language
            .split('+')
            .map((candidate) => candidate.trim())
            .filter(Boolean),
        )
      : [],
  )
  const publicationLanguageToken = metadata.language?.trim() ?? ''
  const normalizedTokens = explicitTokens.map((token) => ({
    token,
    tag: canonicalOcrLanguageTag(token),
  }))
  const normalizedPublicationLanguage = publicationLanguageToken
    ? {
        token: publicationLanguageToken,
        tag: canonicalOcrLanguageTag(publicationLanguageToken),
      }
    : null
  const authoritativeTokens = [
    ...(normalizedPublicationLanguage ? [normalizedPublicationLanguage] : []),
    ...normalizedTokens,
  ]
  const invalidTokens = authoritativeTokens.filter(({ tag }) => tag === null)
  const languageCandidates = [
    ...new Set(
      authoritativeTokens.flatMap(({ tag }) =>
        tag && tag !== 'und' ? [tag] : [],
      ),
    ),
  ]
  const candidateBaseLanguages = new Set(
    languageCandidates.map((tag) => new Intl.Locale(tag).language),
  )
  const languageCandidatesAgree = candidateBaseLanguages.size <= 1
  const preferredLanguageCandidate =
    normalizedPublicationLanguage?.tag &&
    normalizedPublicationLanguage.tag !== 'und'
      ? normalizedPublicationLanguage.tag
      : languageCandidates[0]
  const textLanguageInference =
    authoritativeTokens.length === 0
      ? inferPublicationLanguageFromPdfText(pages)
      : null
  const candidateLanguage =
    authoritativeTokens.length > 0 &&
    invalidTokens.length === 0 &&
    languageCandidates.length > 0 &&
    languageCandidatesAgree
      ? (preferredLanguageCandidate ?? 'und')
      : authoritativeTokens.length === 0 && textLanguageInference
        ? textLanguageInference.tag
        : 'und'
  const scriptDirection = strongScriptDirection(pages)
  const languageScriptConflict =
    candidateLanguage !== 'und' &&
    scriptDirection.observedDirection !== 'unknown' &&
    (rtlLanguage(candidateLanguage) ? 'rtl' : 'ltr') !==
      scriptDirection.observedDirection
  const language = languageScriptConflict ? 'und' : candidateLanguage
  const languageProven = language !== 'und'
  const hasAutomaticOcr = pages.some(
    (page) => page.ocr?.languageMode === 'automatic-fallback',
  )
  const languageEvidence = languageScriptConflict
    ? [
        `${normalizedPublicationLanguage ? 'publication' : 'ocr'}-language-script-conflict:${candidateLanguage}:${scriptDirection.observedDirection}`,
      ]
    : languageProven
      ? authoritativeTokens.length > 0
        ? [
            ...(normalizedPublicationLanguage
              ? [
                  `publication-language:${normalizedPublicationLanguage.token}->${normalizedPublicationLanguage.tag}`,
                ]
              : []),
            ...new Set(
              normalizedTokens.map(
                ({ token, tag }) => `ocr-language:${token}->${tag}`,
              ),
            ),
          ]
        : [textLanguageInference!.evidence]
      : invalidTokens.length > 0
        ? invalidTokens.map(({ token }) =>
            token === publicationLanguageToken
              ? `invalid-publication-language-candidate:${token}`
              : `invalid-ocr-language-candidate:${token}`,
          )
        : !languageCandidatesAgree
          ? [
              `${normalizedPublicationLanguage ? 'mixed-or-conflicting-publication' : 'mixed-or-conflicting-ocr'}-language-candidates:${languageCandidates.join(',')}`,
            ]
          : hasAutomaticOcr
            ? ['automatic-ocr-language-is-not-publication-authority']
            : ['no-authoritative-publication-language']

  const explicitLanguageConflict =
    authoritativeTokens.length > 0 && !languageProven
  const baseDirection = languageProven
    ? rtlLanguage(language)
      ? ('rtl' as const)
      : ('ltr' as const)
    : !explicitLanguageConflict && scriptDirection.value === 'rtl'
      ? ('rtl' as const)
      : ('unknown' as const)
  const directionProven = baseDirection !== 'unknown'
  const artifactModifiedAt = validArtifactModifiedAt(metadata.modified)
  const artifactSource =
    metadata.modifiedSource ??
    (metadata.modified ? 'pdf-info-mod-date' : 'unproven')
  const artifactProven = artifactSource !== 'unproven'

  return {
    language,
    baseDirection,
    artifactModifiedAt,
    metadataLineage: {
      language: {
        status: languageProven ? 'proven' : 'unresolved',
        source: languageProven
          ? authoritativeTokens.length > 0
            ? normalizedPublicationLanguage
              ? 'publication-language'
              : 'pdf-ocr-explicit'
            : 'pdf-text-language-inference'
          : 'unproven',
        evidence: languageEvidence,
      },
      baseDirection: {
        status: directionProven ? 'proven' : 'unresolved',
        source: languageProven
          ? 'publication-language'
          : directionProven
            ? 'pdf-strong-script'
            : 'unproven',
        evidence: languageProven
          ? [`language:${language}`]
          : directionProven
            ? [`strong-rtl-script-only:${scriptDirection.rtlCount}`]
            : explicitLanguageConflict
              ? ['mixed-or-invalid-explicit-ocr-language']
              : scriptDirection.rtlCount > 0 &&
                  scriptDirection.otherStrongCount > 0
                ? [
                    `mixed-strong-script-directions:rtl=${scriptDirection.rtlCount},other=${scriptDirection.otherStrongCount}`,
                  ]
                : ['no-authoritative-base-direction'],
      },
      publicationDate: {
        status: 'unresolved',
        source: 'pdf-xmp-not-extracted',
        evidence: ['pdf-xmp-metadata-not-extracted'],
      },
      artifactModifiedAt: {
        status: artifactProven ? 'proven' : 'unresolved',
        source: artifactSource,
        evidence: [
          artifactSource === 'pdf-info-mod-date'
            ? 'pdf-info:ModDate'
            : artifactSource === 'file-last-modified'
              ? 'file:lastModified'
              : 'artifact-modified-time-unavailable',
        ],
      },
    },
  }
}
