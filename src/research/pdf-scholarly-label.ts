export type PdfScholarlyVisualKind = 'figure' | 'table' | 'equation'

export type ParsedPdfScholarlyVisualIdentifier = {
  identifier: string
  start: number
  end: number
  consumedEnd: number
}

export type ParsedPdfScholarlyVisualLabel = {
  status: 'parsed'
  kind: PdfScholarlyVisualKind
  identifier: string
  label: string
  plural: boolean
  identifierStart: number
  identifierEnd: number
  consumedEnd: number
}

export type UnparseablePdfScholarlyVisualLabel = {
  status: 'unparseable'
  kind: PdfScholarlyVisualKind
  identifier: string | null
  label: string
  plural: false
  identifierStart: number
  identifierEnd: number
  consumedEnd: number
}

export type PdfScholarlyVisualLabel =
  ParsedPdfScholarlyVisualLabel | UnparseablePdfScholarlyVisualLabel

const MAX_IDENTIFIER_SEGMENTS = 4
const MAX_IDENTIFIER_DIGITS_PER_SEGMENT = 4
const MAX_ROMAN_IDENTIFIER_CHARACTERS = 12
const MAX_RANGE_TARGETS = 32
const MAX_UNPARSEABLE_IDENTIFIER_CHARACTERS = 48
const CANONICAL_UPPER_ROMAN_IDENTIFIER = String.raw`(?=[IVXLCDM]{1,${MAX_ROMAN_IDENTIFIER_CHARACTERS}}(?![IVXLCDM]))M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})`

const PREFIX_PATTERN = /^(fig(?:ure)?|table|eq(?:uation)?)(s?)(?:\.\s*|\s+)/iu
const EXPLICIT_UNNUMBERED_PREFIX_PATTERN =
  /^(fig(?:ure)?|table|eq(?:uation)?)\.?\s*:\s*/iu

function kindForPrefix(value: string): PdfScholarlyVisualKind {
  if (/^fig/iu.test(value)) return 'figure'
  if (/^table/iu.test(value)) return 'table'
  return 'equation'
}

function kindName(kind: PdfScholarlyVisualKind) {
  return kind === 'figure' ? 'Figure' : kind === 'table' ? 'Table' : 'Equation'
}

function normalizedIdentifier(value: string) {
  if (/^[IVXLCDM]+$/u.test(value)) return value
  return /^[A-Za-z]/u.test(value)
    ? `${value[0].toUpperCase()}${value.slice(1)}`
    : value
}

function identifierPattern(allowAsciiHyphenCompound: boolean) {
  const separator = allowAsciiHyphenCompound ? String.raw`[.-]` : String.raw`\.`
  const digitSegment = String.raw`\d{1,${MAX_IDENTIFIER_DIGITS_PER_SEGMENT}}`
  const trailingSegments = String.raw`(?:${separator}${digitSegment}){0,${MAX_IDENTIFIER_SEGMENTS - 1}}`
  return new RegExp(
    String.raw`^(?:[A-Za-z](?:${digitSegment}|${separator}${digitSegment})${trailingSegments}|${digitSegment}${trailingSegments}[A-Za-z]?|${CANONICAL_UPPER_ROMAN_IDENTIFIER})(?![IVXLCDM])`,
    'u',
  )
}

export function parsePdfScholarlyVisualIdentifier(
  value: string,
  offset: number,
  options: {
    allowAsciiHyphenCompound: boolean
    allowParentheses?: boolean
  },
): ParsedPdfScholarlyVisualIdentifier | null {
  const source = value.slice(offset)
  const parenthesized =
    options.allowParentheses !== false && source.startsWith('(')
  const tokenOffset = parenthesized ? 1 : 0
  const match = source
    .slice(tokenOffset)
    .match(identifierPattern(options.allowAsciiHyphenCompound))
  if (!match) return null
  const rawIdentifier = match[0]
  const identifierEnd = offset + tokenOffset + rawIdentifier.length
  const closingParenthesis = parenthesized && value[identifierEnd] === ')'
  if (parenthesized && !closingParenthesis) return null
  const consumedEnd = identifierEnd + Number(closingParenthesis)
  const next = value.slice(consumedEnd)
  const truncatedCompound =
    next.startsWith('.') && /^[.\-][\p{L}\p{N}]/u.test(next)
  const truncatedHyphenCompound =
    options.allowAsciiHyphenCompound &&
    next.startsWith('-') &&
    /^[.\-][\p{L}\p{N}]/u.test(next)
  if (
    /^[\p{L}\p{N}]/u.test(next) ||
    truncatedCompound ||
    truncatedHyphenCompound
  ) {
    return null
  }
  return {
    identifier: normalizedIdentifier(rawIdentifier),
    start: offset + tokenOffset,
    end: identifierEnd,
    consumedEnd,
  }
}

function captionDelimiterAt(value: string, offset: number) {
  return /^(?:\s*(?:[.:–—-](?:\s|$)|$))/u.test(value.slice(offset))
}

function unparseableCaptionLabel(
  value: string,
  prefix: RegExpMatchArray,
): UnparseablePdfScholarlyVisualLabel | null {
  const kind = kindForPrefix(prefix[1])
  const identifierStart = prefix[0].length
  const source = value.slice(identifierStart)
  const token = source.match(
    new RegExp(
      String.raw`^(\S{1,${MAX_UNPARSEABLE_IDENTIFIER_CHARACTERS}}?)(?=\s*[.:–—-](?:\s|$))`,
      'u',
    ),
  )?.[1]
  if (!token || (!/[\d?.-]/u.test(token) && !/^[A-Z]{1,3}$/u.test(token))) {
    return null
  }
  return {
    status: 'unparseable',
    kind,
    identifier: token,
    label: `${kindName(kind)} ${token}`,
    plural: false,
    identifierStart,
    identifierEnd: identifierStart + token.length,
    consumedEnd: identifierStart + token.length,
  }
}

export function parsePdfScholarlyVisualLabel(
  value: string,
  options: { context: 'caption' | 'reference' },
): PdfScholarlyVisualLabel | null {
  const trimmedStart = value.length - value.trimStart().length
  const source = value.slice(trimmedStart)
  const explicitUnnumbered =
    options.context === 'caption'
      ? source.match(EXPLICIT_UNNUMBERED_PREFIX_PATTERN)
      : null
  if (explicitUnnumbered) {
    const kind = kindForPrefix(explicitUnnumbered[1])
    const consumedEnd = trimmedStart + explicitUnnumbered[0].length
    return {
      status: 'unparseable',
      kind,
      identifier: null,
      label: `${kindName(kind)} ?`,
      plural: false,
      identifierStart: consumedEnd,
      identifierEnd: consumedEnd,
      consumedEnd,
    }
  }

  const prefix = source.match(PREFIX_PATTERN)
  if (!prefix) return null
  const plural = Boolean(prefix[2])
  if (options.context === 'caption' && plural) return null
  const identifier = parsePdfScholarlyVisualIdentifier(
    source,
    prefix[0].length,
    {
      allowAsciiHyphenCompound: !plural,
      allowParentheses: true,
    },
  )
  if (!identifier) {
    if (options.context !== 'caption') return null
    const unparseable = unparseableCaptionLabel(source, prefix)
    return unparseable
      ? {
          ...unparseable,
          identifierStart: unparseable.identifierStart + trimmedStart,
          identifierEnd: unparseable.identifierEnd + trimmedStart,
          consumedEnd: unparseable.consumedEnd + trimmedStart,
        }
      : null
  }
  if (
    options.context === 'caption' &&
    !captionDelimiterAt(source, identifier.consumedEnd)
  ) {
    return null
  }
  const kind = kindForPrefix(prefix[1])
  return {
    status: 'parsed',
    kind,
    identifier: identifier.identifier,
    label: `${kindName(kind)} ${identifier.identifier}`,
    plural,
    identifierStart: trimmedStart + identifier.start,
    identifierEnd: trimmedStart + identifier.end,
    consumedEnd: trimmedStart + identifier.consumedEnd,
  }
}

export function expandPdfScholarlyVisualIdentifierRange(
  first: string,
  last: string,
): string[] | null {
  const firstMatch = first.match(/^(.*?)(\d{1,4})$/u)
  const lastMatch = last.match(/^(.*?)(\d{1,4})$/u)
  if (
    !firstMatch ||
    !lastMatch ||
    firstMatch[1].toLowerCase() !== lastMatch[1].toLowerCase()
  ) {
    return null
  }
  const start = Number(firstMatch[2])
  const end = Number(lastMatch[2])
  const count = end - start + 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    count < 2 ||
    count > MAX_RANGE_TARGETS
  ) {
    return null
  }
  const pad =
    firstMatch[2].length === lastMatch[2].length ? firstMatch[2].length : 0
  return Array.from({ length: count }, (_, index) => {
    const ordinal = String(start + index)
    return `${firstMatch[1]}${pad ? ordinal.padStart(pad, '0') : ordinal}`
  })
}
