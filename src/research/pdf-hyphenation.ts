import enUsAffixSource from './lexicons/en-US/scowl-2020.12.07.aff?raw'
import enUsDictionarySource from './lexicons/en-US/scowl-2020.12.07.dic?raw'
import enUsHyphenationSource from './lexicons/en-US/ushyphmax-2005-05-30.tex?raw'

export const PDF_HYPHEN_LEXICAL_MODEL = {
  id: 'scowl-2020.12.07+ushyphmax-2005-05-30',
  language: 'en-US',
  dictionarySha256:
    '829a043cf078d1e80e886289a13823454977f442a239a859d2133ea61944aa60',
  affixSha256:
    '70fe5778717d097ce2f3326baaa5c1e4d2206d81a5a81d3ea8e11c4770806dd5',
  hyphenationSha256:
    'f4ffcd96c5cbc886bdad23f95dcae8edc3cd3620eae62f7946eceda97c4e68f8',
} as const

export const PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE = {
  kind: 'prefix',
  value: 're',
  affixClass: 'PFX',
  flag: 'A',
  crossProduct: true,
  affixSha256: PDF_HYPHEN_LEXICAL_MODEL.affixSha256,
} as const

export const PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE = Object.freeze([
  'source-proven-wrapped-line-boundary',
  `lexical-model:${PDF_HYPHEN_LEXICAL_MODEL.id}`,
  'joined-form-valid:pinned-lexicon',
  'split-point-valid:pinned-hyphenation-pattern',
  'same-document-unhyphenated-word',
  'hard-hyphen-form-not-proved',
])

export const PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE = Object.freeze(
  [
    'source-proven-wrapped-line-boundary',
    `lexical-model:${PDF_HYPHEN_LEXICAL_MODEL.id}`,
    'joined-form-valid:same-document-derived-affix',
    'split-point-valid:pinned-hyphenation-pattern',
    'productive-prefix-valid:pinned-affix-model',
    'base-form-valid:pinned-lexicon',
    'same-document-unhyphenated-base-word',
    'hard-hyphen-form-not-proved',
  ],
)

export const PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE = Object.freeze([
  'unproven-wrapped-line-boundary',
  'unsupported-or-unproven-hyphenation-language',
  'joined-form-not-proved',
  'split-point-not-proved',
  'hard-hyphen-form-valid:same-document',
])

type AffixRule = {
  strip: string
  add: string
  condition: RegExp
}

type AffixClass = {
  type: 'PFX' | 'SFX'
  flag: string
  crossProduct: boolean
  rules: AffixRule[]
}

type HyphenationPattern = {
  letters: string
  weights: number[]
}

export type PdfHyphenBoundaryProof = {
  verdict: 'remove' | 'preserve' | 'ambiguous' | 'unresolved'
  joinedForm: string
  hardHyphenForm: string
  sourceBoundaryProven: boolean
  sourceSequenceProven: boolean
  pinnedJoinedFormValid: boolean
  sameDocumentJoinedFormValid: boolean
  joinedFormValid: boolean
  splitPointValid: boolean
  hardHyphenFormValid: boolean
  pinnedFragmentPairValid: boolean
  model: typeof PDF_HYPHEN_LEXICAL_MODEL | null
  lexicalProof:
    | {
        tier: 'exact-same-document'
        pinnedWord: string
        pinnedJoinedFormValid: true
        exactSameDocumentJoinedForm: string
        sameDocumentJoinedFormValid: true
      }
    | {
        tier: 'source-sequence-pinned-lexicon'
        pinnedWord: string
        pinnedJoinedFormValid: true
        sourceSequenceProven: true
      }
    | {
        tier: 'source-sequence-same-document-title-case'
        exactSameDocumentJoinedForm: string
        sameDocumentJoinedFormValid: true
        sourceSequenceProven: true
      }
    | {
        tier: 'source-sequence-bibliography-surname'
        joinedSurname: string
        sourceSequenceProven: true
        bibliographySurnameContextProven: true
      }
    | {
        tier: 'same-document-derived-affix'
        derivedWord: string
        productivePrefix: typeof PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE
        baseWord: string
        pinnedBaseWordValid: true
        exactSameDocumentBaseWord: string
        sameDocumentBaseWordValid: true
      }
    | null
  evidence: string[]
}

function normalizedEnglishWord(value: string) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US')
  return /^[a-z]+$/u.test(normalized) ? normalized : null
}

function parseAffixClasses(source: string) {
  const classes = new Map<string, AffixClass>()
  for (const rawLine of source.split(/\r?\n/u)) {
    const fields = rawLine.trim().split(/\s+/u)
    if ((fields[0] !== 'PFX' && fields[0] !== 'SFX') || fields.length < 4) {
      continue
    }
    const key = `${fields[0]}:${fields[1]}`
    if (fields.length === 4 && /^\d+$/u.test(fields[3])) {
      classes.set(key, {
        type: fields[0],
        flag: fields[1],
        crossProduct: fields[2] === 'Y',
        rules: [],
      })
      continue
    }
    const affixClass = classes.get(key)
    if (!affixClass || fields.length < 5) continue
    const add = fields[3].split('/')[0]
    affixClass.rules.push({
      strip: fields[2] === '0' ? '' : fields[2],
      add: add === '0' ? '' : add,
      condition: new RegExp(
        affixClass.type === 'PFX' ? `^${fields[4]}` : `${fields[4]}$`,
        'u',
      ),
    })
  }
  const parsed = [...classes.values()]
  if (
    parsed.length !== 23 ||
    parsed.reduce((count, affixClass) => count + affixClass.rules.length, 0) !==
      50
  ) {
    throw new Error('Pinned en-US Hunspell affix model failed validation.')
  }
  return parsed
}

function parseDictionary(source: string) {
  const lines = source.split(/\r?\n/u)
  const declaredCount = Number(lines.shift())
  if (declaredCount !== 79_013) {
    throw new Error('Pinned en-US Hunspell dictionary failed validation.')
  }
  const entries = new Map<string, ReadonlySet<string>>()
  const lowercaseEntries = new Set<string>()
  for (const line of lines) {
    if (!line) continue
    const separator = line.indexOf('/')
    const sourceWord = (
      separator < 0 ? line : line.slice(0, separator)
    ).replace(/\\\//gu, '/')
    const word = sourceWord.toLocaleLowerCase('en-US')
    const flags = separator < 0 ? '' : line.slice(separator + 1)
    entries.set(word, new Set(flags))
    if (sourceWord === word) lowercaseEntries.add(word)
  }
  if (entries.size !== 76_741 || lowercaseEntries.size !== 62_439) {
    throw new Error('Pinned en-US Hunspell dictionary entries are incomplete.')
  }
  return { entries, lowercaseEntries }
}

function reverseAffix(word: string, affixClass: AffixClass) {
  const bases: string[] = []
  for (const rule of affixClass.rules) {
    if (affixClass.type === 'SFX') {
      if (!word.endsWith(rule.add)) continue
      const base = `${word.slice(0, word.length - rule.add.length)}${rule.strip}`
      if (rule.condition.test(base)) bases.push(base)
    } else {
      if (!word.startsWith(rule.add)) continue
      const base = `${rule.strip}${word.slice(rule.add.length)}`
      if (rule.condition.test(base)) bases.push(base)
    }
  }
  return bases
}

const enUsAffixClasses = parseAffixClasses(enUsAffixSource)
const enUsProductiveRePrefix = enUsAffixClasses.find(
  (affixClass) =>
    affixClass.type === PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.affixClass &&
    affixClass.flag === PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.flag &&
    affixClass.crossProduct ===
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.crossProduct &&
    affixClass.rules.some(
      (rule) =>
        rule.strip === '' &&
        rule.add === PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.value &&
        rule.condition.source === '^.',
    ),
)
if (!enUsProductiveRePrefix) {
  throw new Error('Pinned en-US productive re- prefix rule is unavailable.')
}
const { entries: enUsDictionary, lowercaseEntries: enUsLowercaseDictionary } =
  parseDictionary(enUsDictionarySource)
const spellingCache = new Map<string, boolean>()

function validEnUsWord(word: string) {
  const cached = spellingCache.get(word)
  if (cached !== undefined) return cached
  let valid = enUsLowercaseDictionary.has(word)
  if (!valid) {
    valid = enUsAffixClasses.some((affixClass) =>
      reverseAffix(word, affixClass).some(
        (base) =>
          enUsLowercaseDictionary.has(base) &&
          enUsDictionary.get(base)?.has(affixClass.flag),
      ),
    )
  }
  if (!valid) {
    const crossProductClasses = enUsAffixClasses.filter(
      (affixClass) => affixClass.crossProduct,
    )
    valid = crossProductClasses.some((outerClass) =>
      reverseAffix(word, outerClass).some((intermediate) =>
        crossProductClasses.some(
          (innerClass) =>
            innerClass.type !== outerClass.type &&
            reverseAffix(intermediate, innerClass).some((base) => {
              const flags = enUsDictionary.get(base)
              return (
                enUsLowercaseDictionary.has(base) &&
                flags?.has(outerClass.flag) &&
                flags.has(innerClass.flag)
              )
            }),
        ),
      ),
    )
  }
  spellingCache.set(word, valid)
  return valid
}

function parseHyphenationModel(source: string) {
  const patternsByFirstCharacter = new Map<string, HyphenationPattern[]>()
  let patternCount = 0
  for (const block of source.matchAll(/\\patterns\s*\{([\s\S]*?)\}/gu)) {
    const tokens = block[1]
      .replace(/%.*$/gmu, ' ')
      .split(/\s+/u)
      .filter(Boolean)
    for (const token of tokens) {
      const letters = token.replace(/\d/gu, '')
      const weights = [0]
      let letterIndex = 0
      for (const character of token) {
        if (/\d/u.test(character)) {
          weights[letterIndex] = Number(character)
        } else {
          letterIndex += 1
          weights[letterIndex] ??= 0
        }
      }
      const bucket = patternsByFirstCharacter.get(letters[0]) ?? []
      bucket.push({ letters, weights })
      patternsByFirstCharacter.set(letters[0], bucket)
      patternCount += 1
    }
  }
  const exceptions = new Map<string, ReadonlySet<number>>()
  for (const block of source.matchAll(/\\hyphenation\s*\{([\s\S]*?)\}/gu)) {
    const tokens = block[1]
      .replace(/%.*$/gmu, ' ')
      .split(/\s+/u)
      .filter(Boolean)
    for (const token of tokens) {
      const points = new Set<number>()
      let position = 0
      for (const character of token) {
        if (character === '-') points.add(position)
        else position += 1
      }
      exceptions.set(
        token.replace(/-/gu, '').toLocaleLowerCase('en-US'),
        points,
      )
    }
  }
  if (patternCount !== 4_938 || exceptions.size !== 14) {
    throw new Error('Pinned en-US hyphenation model failed validation.')
  }
  return { patternsByFirstCharacter, exceptions }
}

const enUsHyphenationModel = parseHyphenationModel(enUsHyphenationSource)
const hyphenationPointCache = new Map<string, ReadonlySet<number>>()

function enUsHyphenationPoints(word: string) {
  const cached = hyphenationPointCache.get(word)
  if (cached) return cached
  const exception = enUsHyphenationModel.exceptions.get(word)
  if (exception) {
    hyphenationPointCache.set(word, exception)
    return exception
  }
  const marked = `.${word}.`
  const weights = Array.from({ length: marked.length + 1 }, () => 0)
  for (let start = 0; start < marked.length; start += 1) {
    for (const pattern of enUsHyphenationModel.patternsByFirstCharacter.get(
      marked[start],
    ) ?? []) {
      if (!marked.startsWith(pattern.letters, start)) continue
      for (const [offset, weight] of pattern.weights.entries()) {
        weights[start + offset] = Math.max(weights[start + offset], weight)
      }
    }
  }
  const points = new Set<number>()
  for (let position = 2; position <= word.length - 3; position += 1) {
    if (weights[position + 1] % 2 === 1) points.add(position)
  }
  hyphenationPointCache.set(word, points)
  return points
}

function supportsEnUsModel(language: string | null | undefined) {
  if (!language) return false
  const normalized = language.replace(/_/gu, '-').toLocaleLowerCase('en-US')
  return normalized === 'en' || normalized === 'en-us'
}

export function resolvePdfHyphenBoundary({
  left,
  right,
  language,
  sourceProven,
  sourceSequenceProven = false,
  bibliographySurnameContextProven = false,
  hardHyphenLexicon = new Set<string>(),
  unhyphenatedLexicon = new Set<string>(),
}: {
  left: string
  right: string
  language?: string | null
  sourceProven: boolean
  sourceSequenceProven?: boolean
  bibliographySurnameContextProven?: boolean
  hardHyphenLexicon?: ReadonlySet<string>
  unhyphenatedLexicon?: ReadonlySet<string>
}): PdfHyphenBoundaryProof {
  const joinedForm = `${left}${right}`.normalize('NFKC')
  const hardHyphenForm = `${left}-${right}`.normalize('NFKC')
  const normalizedJoined = normalizedEnglishWord(joinedForm)
  const normalizedHard = hardHyphenForm.toLocaleLowerCase('en-US')
  const hardHyphenFormValid = hardHyphenLexicon.has(normalizedHard)
  const model = supportsEnUsModel(language) ? PDF_HYPHEN_LEXICAL_MODEL : null
  const pinnedJoinedForm = Boolean(
    model && normalizedJoined && validEnUsWord(normalizedJoined),
  )
  const sameDocumentJoinedForm = Boolean(
    normalizedJoined && unhyphenatedLexicon.has(normalizedJoined),
  )
  const normalizedLeft = normalizedEnglishWord(left)
  const normalizedRight = normalizedEnglishWord(right)
  const pinnedFragmentPair = Boolean(
    model &&
    sourceSequenceProven &&
    normalizedLeft &&
    normalizedRight &&
    enUsLowercaseDictionary.has(normalizedLeft) &&
    enUsLowercaseDictionary.has(normalizedRight),
  )
  const sameDocumentTitleCaseJoinedForm = Boolean(
    model &&
    sourceSequenceProven &&
    normalizedJoined &&
    sameDocumentJoinedForm &&
    /^\p{Lu}\p{Ll}+$/u.test(joinedForm),
  )
  const sourceSequenceBibliographySurname = Boolean(
    model &&
    sourceSequenceProven &&
    bibliographySurnameContextProven &&
    normalizedJoined &&
    normalizedLeft &&
    normalizedRight &&
    !pinnedFragmentPair &&
    /^\p{Lu}\p{Ll}+$/u.test(joinedForm),
  )
  const derivedBaseWord =
    model &&
    normalizedJoined?.startsWith(PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.value) &&
    normalizedJoined.length > PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.value.length
      ? normalizedJoined.slice(PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.value.length)
      : null
  const sameDocumentBaseWordValid = Boolean(
    derivedBaseWord && unhyphenatedLexicon.has(derivedBaseWord),
  )
  const pinnedBaseWordValid = Boolean(
    derivedBaseWord &&
    sameDocumentBaseWordValid &&
    validEnUsWord(derivedBaseWord),
  )
  const derivedSurfaceSplitInsideBase =
    left.normalize('NFKC').length >
    PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.value.length
  const lexicalProof: PdfHyphenBoundaryProof['lexicalProof'] =
    pinnedJoinedForm && sameDocumentJoinedForm
      ? {
          tier: 'exact-same-document',
          pinnedWord: normalizedJoined!,
          pinnedJoinedFormValid: true,
          exactSameDocumentJoinedForm: normalizedJoined!,
          sameDocumentJoinedFormValid: true,
        }
      : pinnedJoinedForm && sourceSequenceProven
        ? {
            tier: 'source-sequence-pinned-lexicon',
            pinnedWord: normalizedJoined!,
            pinnedJoinedFormValid: true,
            sourceSequenceProven: true,
          }
        : sameDocumentTitleCaseJoinedForm
          ? {
              tier: 'source-sequence-same-document-title-case',
              exactSameDocumentJoinedForm: normalizedJoined!,
              sameDocumentJoinedFormValid: true,
              sourceSequenceProven: true,
            }
          : sourceSequenceBibliographySurname
            ? {
                tier: 'source-sequence-bibliography-surname',
                joinedSurname: joinedForm,
                sourceSequenceProven: true,
                bibliographySurnameContextProven: true,
              }
            : model &&
                normalizedJoined &&
                derivedBaseWord &&
                pinnedBaseWordValid &&
                sameDocumentBaseWordValid &&
                derivedSurfaceSplitInsideBase
              ? {
                  tier: 'same-document-derived-affix',
                  derivedWord: normalizedJoined,
                  productivePrefix: PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE,
                  baseWord: derivedBaseWord,
                  pinnedBaseWordValid: true,
                  exactSameDocumentBaseWord: derivedBaseWord,
                  sameDocumentBaseWordValid: true,
                }
              : null
  const sourceBoundaryProven = sourceProven
  const joinedFormValid = lexicalProof !== null
  const splitPointValid = Boolean(
    model &&
    normalizedJoined &&
    enUsHyphenationPoints(normalizedJoined).has(left.normalize('NFKC').length),
  )
  const pinnedFragmentPairCounterproof =
    pinnedFragmentPair &&
    (lexicalProof === null ||
      lexicalProof.tier === 'source-sequence-pinned-lexicon')
  const evidence = [
    ...(sourceProven
      ? ['source-proven-wrapped-line-boundary']
      : ['unproven-wrapped-line-boundary']),
    ...(sourceSequenceProven
      ? ['source-sequence-attested-wrapped-line-boundary']
      : []),
    ...(model
      ? [
          `language-scope:${language}->${PDF_HYPHEN_LEXICAL_MODEL.language}`,
          `lexical-model:${PDF_HYPHEN_LEXICAL_MODEL.id}`,
        ]
      : ['unsupported-or-unproven-hyphenation-language']),
    ...(pinnedJoinedForm
      ? ['joined-form-valid:pinned-lexicon']
      : lexicalProof?.tier === 'source-sequence-bibliography-surname'
        ? ['joined-form-valid:source-proved-bibliography-surname']
        : lexicalProof?.tier === 'same-document-derived-affix'
          ? ['joined-form-valid:same-document-derived-affix']
          : ['joined-form-not-proved']),
    ...(splitPointValid
      ? ['split-point-valid:pinned-hyphenation-pattern']
      : ['split-point-not-proved']),
    ...(sameDocumentJoinedForm ? ['same-document-unhyphenated-word'] : []),
    ...(lexicalProof?.tier === 'source-sequence-bibliography-surname'
      ? ['bibliography-surname-context:source-reference-entry']
      : []),
    ...(derivedBaseWord ? ['productive-prefix-valid:pinned-affix-model'] : []),
    ...(sameDocumentBaseWordValid
      ? ['same-document-unhyphenated-base-word']
      : []),
    ...(sameDocumentBaseWordValid
      ? pinnedBaseWordValid
        ? ['base-form-valid:pinned-lexicon']
        : ['base-form-not-proved']
      : []),
    ...(hardHyphenFormValid
      ? ['hard-hyphen-form-valid:same-document']
      : pinnedFragmentPairCounterproof
        ? ['hard-hyphen-form-valid:pinned-fragment-pair']
        : ['hard-hyphen-form-not-proved']),
  ]

  const joinedProof = lexicalProof !== null && splitPointValid
  const fragmentPairConflictsWithModelOnlyJoin =
    joinedProof &&
    lexicalProof?.tier === 'source-sequence-pinned-lexicon' &&
    pinnedFragmentPairCounterproof
  const verdict: PdfHyphenBoundaryProof['verdict'] = !sourceBoundaryProven
    ? 'unresolved'
    : joinedProof &&
        (hardHyphenFormValid || fragmentPairConflictsWithModelOnlyJoin)
      ? 'ambiguous'
      : joinedProof
        ? 'remove'
        : hardHyphenFormValid || pinnedFragmentPairCounterproof
          ? 'preserve'
          : 'unresolved'
  return {
    verdict,
    joinedForm,
    hardHyphenForm,
    sourceBoundaryProven,
    sourceSequenceProven,
    pinnedJoinedFormValid: pinnedJoinedForm,
    sameDocumentJoinedFormValid: sameDocumentJoinedForm,
    joinedFormValid,
    splitPointValid,
    hardHyphenFormValid,
    pinnedFragmentPairValid: pinnedFragmentPair,
    model,
    lexicalProof,
    evidence,
  }
}
