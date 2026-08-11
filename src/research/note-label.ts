const UNICODE_DECIMAL_ZERO_CODE_POINTS = [
  0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66,
  0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040,
  0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0,
  0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0,
  0xff10, 0x104a0, 0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0,
  0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730,
  0x118e0, 0x11950, 0x11bf0, 0x11c50, 0x11d50, 0x11da0, 0x11de0, 0x11f50,
  0x16130, 0x16a60, 0x16ac0, 0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8,
  0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950,
  0x1fbf0,
] as const

function normalizedDecimalDigit(character: string) {
  const codePoint = character.codePointAt(0)!
  for (const zero of UNICODE_DECIMAL_ZERO_CODE_POINTS) {
    if (codePoint >= zero && codePoint <= zero + 9) {
      return String(codePoint - zero)
    }
  }
  return character
}

export function normalizedNoteLabel(value: string) {
  const superscripts: Record<string, string> = {
    '⁰': '0',
    '¹': '1',
    '²': '2',
    '³': '3',
    '⁴': '4',
    '⁵': '5',
    '⁶': '6',
    '⁷': '7',
    '⁸': '8',
    '⁹': '9',
    '∗': '*',
  }
  return [...value]
    .map(
      (character) =>
        superscripts[character] ?? normalizedDecimalDigit(character),
    )
    .join('')
    .trim()
}

const NOTE_TOKEN_SOURCE = String.raw`(?:\p{Nd}{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*∗†‡§])`
const NOTE_SEPARATOR_SOURCE = String.raw`\s*(?:[,;˒]|[–—-])\s*`
const NOTE_MARKER_BODY_SOURCE = String.raw`${NOTE_TOKEN_SOURCE}(?:${NOTE_SEPARATOR_SOURCE}${NOTE_TOKEN_SOURCE})*`
const BOUNDED_NOTE_MARKER_PATTERN = new RegExp(
  String.raw`^(?:\s*${NOTE_MARKER_BODY_SOURCE}\s*|\s*\[\s*${NOTE_MARKER_BODY_SOURCE}\s*\]\s*)$`,
  'u',
)
const MAX_EXPANDED_NOTE_RANGE = 100

export function noteLabelsFromMarkerText(value: string) {
  const labels: string[] = []
  const pattern = new RegExp(
    `(${NOTE_TOKEN_SOURCE})(?:\\s*[–—-]\\s*(${NOTE_TOKEN_SOURCE}))?`,
    'gu',
  )
  const add = (label: string) => {
    if (label && !labels.includes(label)) labels.push(label)
  }
  for (const match of value.matchAll(pattern)) {
    const first = normalizedNoteLabel(match[1])
    const last = match[2] ? normalizedNoteLabel(match[2]) : null
    const firstOrdinal = /^\d+$/.test(first) ? Number(first) : null
    const lastOrdinal = last && /^\d+$/.test(last) ? Number(last) : null
    if (
      firstOrdinal !== null &&
      lastOrdinal !== null &&
      lastOrdinal >= firstOrdinal &&
      lastOrdinal - firstOrdinal <= MAX_EXPANDED_NOTE_RANGE
    ) {
      for (let ordinal = firstOrdinal; ordinal <= lastOrdinal; ordinal += 1) {
        add(String(ordinal))
      }
      continue
    }
    add(first)
    if (last) add(last)
  }
  return labels
}

export function noteLabelsFromBoundedMarkerText(value: string) {
  if (!BOUNDED_NOTE_MARKER_PATTERN.test(value)) return null
  const labels = noteLabelsFromMarkerText(value)
  return labels.length > 0 ? labels : null
}
