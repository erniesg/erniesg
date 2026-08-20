import {
  LEGACY_STRUCT_SCHEMA_VERSION,
  STRUCT_SCHEMA_VERSION,
  type StructAsset,
  type StructBlock,
  type StructBox,
  type StructDiagnostic,
  type StructDocument,
  type StructEvidence,
  type StructFurnitureEvidence,
  type StructFurnitureReview,
  type StructInline,
  type StructMetadata,
  type StructPageLayout,
  type StructReceipt,
  type StructRecovery,
  type StructRelationship,
  type StructRelationshipCandidate,
  type StructSource,
  type StructTable,
  type StructTableCell,
} from './types'
import {
  SAFE_ID,
  validateModelConsultationReceipt,
} from './model-consultation-receipt'

/** JSON-safe wire representation of a STRUCT document. */
export type StructDocumentJson = Omit<StructDocument, 'assets'> & {
  assets: Array<Omit<StructAsset, 'bytes'> & { bytes?: string }>
}

const ID = SAFE_ID
const HASH = /^[a-f0-9]{64}$/u
// JSON strings may legitimately contain tabs and line breaks (for example in
// extracted code or preformatted text). Reject the remaining C0 controls and
// DEL without normalizing the accepted whitespace.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const URL_CONTROL = /[\u0000-\u001f\u007f]/u

const SOURCE_FORMATS = ['pdf', 'docx', 'html', 'image', 'unknown'] as const
const BLOCK_KINDS = [
  'heading',
  'paragraph',
  'quote',
  'list-item',
  'figure',
  'table',
  'equation',
  'caption',
  'footnote',
  'endnote',
  'code',
  'furniture',
  'unknown',
] as const
const FURNITURE_CLASSIFICATIONS = [
  'repeated-text',
  'incrementing-numeral',
  'rotated-margin',
  'separator-rule',
  'explicit-paratext',
] as const
const BANDS = ['top', 'bottom', 'left', 'right'] as const
const VERTICAL_ALIGNS = ['superscript', 'subscript'] as const
const SEMANTIC_ROLES = [
  'citation',
  'cross-reference',
  'note-reference',
  'affiliation-marker',
  'bibliography-entry',
] as const
const BASE_DIRECTIONS = ['ltr', 'rtl', 'unknown'] as const
const HEADER_SCOPES = ['column', 'row', 'colgroup', 'rowgroup'] as const
const TABLE_SEMANTICS = ['verified', 'source-preserved', 'unresolved'] as const
const ASSET_KINDS = [
  'figure',
  'diagram',
  'table',
  'equation',
  'page-region',
  'unknown',
] as const
const ASSET_FALLBACKS = ['asset', 'source-region', 'text'] as const
const RELATIONSHIP_KINDS = [
  'caption',
  'figure',
  'table',
  'equation',
  'footnote',
  'endnote',
  'citation',
  'cross-reference',
  'hyperlink',
  'reading-order',
] as const
const RELATIONSHIP_STATUSES = [
  'matched',
  'ambiguous',
  'unresolved',
  'source-preserved',
] as const
const DIAGNOSTIC_SEVERITIES = ['info', 'warning', 'error'] as const
const DIAGNOSTIC_CATEGORIES = [
  'text',
  'layout',
  'visuals',
  'tables',
  'equations',
  'links',
  'notes',
  'source',
] as const
const COLUMN_SIDES = ['single', 'left', 'right', 'span'] as const
const RECOVERY_STATUSES = ['ready', 'review-required'] as const

type DataObject = Record<string, unknown>
type EnumValue<T extends readonly string[]> = T[number]

export class StructCodecError extends TypeError {
  readonly code: string
  readonly path: string

  constructor(code: string, path: string, message: string) {
    super(`STRUCT_CODEC_${code} at ${path}: ${message}`)
    this.name = 'StructCodecError'
    this.code = code
    this.path = path
  }
}

function fail(code: string, path: string, message: string): never {
  throw new StructCodecError(code, path, message)
}

function ownDataKeys(value: unknown, path: string): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('TYPE', path, 'expected an object')
  let prototype: object | null
  let keys: (string | symbol)[]
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    fail('OBJECT', path, 'object cannot be inspected safely')
  }
  if (prototype !== Object.prototype && prototype !== null)
    fail('OBJECT', path, 'expected a plain object')
  if (keys.some((key) => typeof key !== 'string'))
    fail('FIELD', path, 'symbol fields are not permitted')
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      fail(
        'FIELD',
        `${path}.${key}`,
        'accessor and non-enumerable fields are not permitted',
      )
  }
  return keys as string[]
}

function object(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): DataObject {
  const keys = ownDataKeys(value, path)
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(value as object, key))
      fail('REQUIRED', `${path}.${key}`, 'field is required')
  }
  for (const key of keys) {
    if (!allowed.has(key))
      fail('UNKNOWN_FIELD', `${path}.${key}`, 'unknown field is not declared')
  }
  return value as DataObject
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail('TYPE', path, 'expected an array')
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== value.length + 1 ||
    !keys.includes('length') ||
    keys.some(
      (key) =>
        typeof key !== 'string' || (key !== 'length' && !/^\d+$/u.test(key)),
    )
  )
    fail('ARRAY', path, 'array must contain only indexed values')
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      fail('ARRAY', `${path}[${index}]`, 'array item is not a data value')
  }
  return value
}

function has(value: DataObject, key: string) {
  return Object.hasOwn(value, key)
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') fail('TYPE', path, 'expected a string')
  if (CONTROL.test(value))
    fail('STRING', path, 'control characters are not permitted')
  return value
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number') fail('TYPE', path, 'expected a number')
  if (!Number.isFinite(value))
    fail('NON_FINITE_NUMBER', path, 'number must be finite')
  return value
}

function integer(value: unknown, path: string, minimum?: number): number {
  const parsed = finiteNumber(value, path)
  if (!Number.isSafeInteger(parsed))
    fail('NUMBER', path, 'number must be a safe integer')
  if (minimum !== undefined && parsed < minimum)
    fail('NUMBER', path, `number must be at least ${minimum}`)
  return parsed
}

function nonNegativeInteger(value: unknown, path: string) {
  return integer(value, path, 0)
}

function unitInterval(value: unknown, path: string) {
  const parsed = finiteNumber(value, path)
  if (parsed < 0 || parsed > 1)
    fail('RANGE', path, 'number must be between 0 and 1')
  return parsed
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('TYPE', path, 'expected a boolean')
  return value
}

function nullable<T>(
  value: unknown,
  path: string,
  parser: (value: unknown, path: string) => T,
) {
  return value === null ? null : parser(value, path)
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  path: string,
  allowed: T,
): EnumValue<T> {
  const parsed = stringValue(value, path)
  if (!allowed.includes(parsed))
    fail('ENUM', path, `unexpected value ${JSON.stringify(parsed)}`)
  return parsed as EnumValue<T>
}

function identifier(value: unknown, path: string): string {
  const parsed = stringValue(value, path)
  if (!ID.test(parsed)) fail('IDENTIFIER', path, 'identifier is not canonical')
  return parsed
}

function identifierList(
  value: unknown,
  path: string,
  allowEmpty = true,
): string[] {
  const values = array(value, path).map((entry, index) =>
    identifier(entry, `${path}[${index}]`),
  )
  if (!allowEmpty && values.length === 0)
    fail('ARRAY', path, 'list cannot be empty')
  unique(values, path, 'identifier')
  return values
}

function reference(value: unknown, path: string): string {
  const parsed = stringValue(value, path)
  if (URL_CONTROL.test(parsed))
    fail('REFERENCE', path, 'reference must not contain control characters')
  if (ID.test(parsed)) return parsed
  if (/^#[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(parsed)) return parsed
  try {
    const url = new URL(parsed)
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol))
      throw new Error()
    if (url.username || url.password) throw new Error()
    return parsed
  } catch {
    fail(
      'REFERENCE',
      path,
      'reference must be a canonical id, fragment, or safe URL',
    )
  }
}

function referenceList(value: unknown, path: string): string[] {
  const values = array(value, path).map((entry, index) =>
    reference(entry, `${path}[${index}]`),
  )
  unique(values, path, 'reference')
  return values
}

function hash(value: unknown, path: string): string {
  const parsed = stringValue(value, path)
  if (!HASH.test(parsed))
    fail('HASH', path, 'expected a lowercase SHA-256 digest')
  return parsed
}

function unique(values: readonly string[], path: string, label: string) {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value))
      fail('DUPLICATE_IDENTIFIER', path, `duplicate ${label} ${value}`)
    seen.add(value)
  }
}

function copyRecord(entries: readonly [string, unknown][]) {
  const target: DataObject = {}
  for (const [key, value] of entries) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }
  return target
}

function copyCanonicalJson(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (typeof value === 'number') return finiteNumber(value, path)
  if (Array.isArray(value))
    return array(value, path).map((entry, index) =>
      copyCanonicalJson(entry, `${path}[${index}]`),
    )
  const keys = ownDataKeys(value, path).sort()
  return copyRecord(
    keys.map((key) => [
      key,
      copyCanonicalJson((value as DataObject)[key], `${path}.${key}`),
    ]),
  )
}

function parseBytes(value: unknown, path: string): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (Array.isArray(value)) {
    const bytes = array(value, path).map((entry, index) => {
      const byte = integer(entry, `${path}[${index}]`, 0)
      if (byte > 255)
        fail('BYTES', `${path}[${index}]`, 'byte must be between 0 and 255')
      return byte
    })
    return new Uint8Array(bytes)
  }
  const encoded = stringValue(value, path)
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  )
    fail('BYTES', path, 'bytes must use canonical base64')
  if (encoded.length === 0) return new Uint8Array()
  const output = new Uint8Array(
    (encoded.length / 4) * 3 -
      (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0),
  )
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let offset = 0
  for (let index = 0; index < encoded.length; index += 4) {
    const first = alphabet.indexOf(encoded[index]!)
    const second = alphabet.indexOf(encoded[index + 1]!)
    const third =
      encoded[index + 2] === '=' ? 0 : alphabet.indexOf(encoded[index + 2]!)
    const fourth =
      encoded[index + 3] === '=' ? 0 : alphabet.indexOf(encoded[index + 3]!)
    if (first < 0 || second < 0 || third < 0 || fourth < 0)
      fail('BYTES', path, 'bytes must use canonical base64')
    if (
      (encoded[index + 2] === '=' && (second & 0x0f) !== 0) ||
      (encoded[index + 3] === '=' &&
        encoded[index + 2] !== '=' &&
        (third & 0x03) !== 0)
    )
      fail('BYTES', path, 'bytes must use canonical base64')
    const word = (first << 18) | (second << 12) | (third << 6) | fourth
    if (offset < output.length) output[offset++] = (word >> 16) & 0xff
    if (offset < output.length) output[offset++] = (word >> 8) & 0xff
    if (offset < output.length) output[offset++] = word & 0xff
  }
  return output
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = index + 1 < bytes.length ? bytes[index + 1]! : 0
    const third = index + 2 < bytes.length ? bytes[index + 2]! : 0
    const word = (first << 16) | (second << 8) | third
    encoded += alphabet[(word >> 18) & 0x3f]
    encoded += alphabet[(word >> 12) & 0x3f]
    encoded += index + 1 < bytes.length ? alphabet[(word >> 6) & 0x3f] : '='
    encoded += index + 2 < bytes.length ? alphabet[word & 0x3f] : '='
  }
  return encoded
}

function parseBox(value: unknown, path: string): StructBox {
  const parsed = object(value, path, [
    'page',
    'x',
    'y',
    'width',
    'height',
    'rotation',
  ])
  return {
    page: nonNegativeInteger(parsed.page, `${path}.page`),
    x: finiteNumber(parsed.x, `${path}.x`),
    y: finiteNumber(parsed.y, `${path}.y`),
    width: finiteNumber(parsed.width, `${path}.width`),
    height: finiteNumber(parsed.height, `${path}.height`),
    rotation: finiteNumber(parsed.rotation, `${path}.rotation`),
  }
}

function parseEvidence(value: unknown, path: string): StructEvidence {
  const parsed = object(
    value,
    path,
    ['confidence', 'pages', 'boxes', 'sourceIds'],
    ['signals'],
  )
  const pages = array(parsed.pages, `${path}.pages`).map((page, index) =>
    nonNegativeInteger(page, `${path}.pages[${index}]`),
  )
  unique(pages.map(String), `${path}.pages`, 'page')
  const sourceIds = identifierList(parsed.sourceIds, `${path}.sourceIds`)
  return {
    confidence: unitInterval(parsed.confidence, `${path}.confidence`),
    pages,
    boxes: array(parsed.boxes, `${path}.boxes`).map((box, index) =>
      parseBox(box, `${path}.boxes[${index}]`),
    ),
    sourceIds,
    ...(has(parsed, 'signals')
      ? {
          signals: array(parsed.signals, `${path}.signals`).map(
            (signal, index) => stringValue(signal, `${path}.signals[${index}]`),
          ),
        }
      : {}),
  }
}

function parseInline(value: unknown, path: string): StructInline {
  const parsed = object(
    value,
    path,
    ['start', 'end'],
    [
      'href',
      'annotationId',
      'relationshipId',
      'targetIds',
      'bold',
      'italic',
      'verticalAlign',
      'compactMathAtom',
      'semanticRole',
    ],
  )
  const start = nonNegativeInteger(parsed.start, `${path}.start`)
  const end = nonNegativeInteger(parsed.end, `${path}.end`)
  if (end < start) fail('RANGE', path, 'inline end must not precede start')
  return {
    start,
    end,
    ...(has(parsed, 'href')
      ? { href: parseHref(parsed.href, `${path}.href`) }
      : {}),
    ...(has(parsed, 'annotationId')
      ? {
          annotationId: identifier(parsed.annotationId, `${path}.annotationId`),
        }
      : {}),
    ...(has(parsed, 'relationshipId')
      ? {
          relationshipId: identifier(
            parsed.relationshipId,
            `${path}.relationshipId`,
          ),
        }
      : {}),
    ...(has(parsed, 'targetIds')
      ? { targetIds: identifierList(parsed.targetIds, `${path}.targetIds`) }
      : {}),
    ...(has(parsed, 'bold')
      ? { bold: booleanValue(parsed.bold, `${path}.bold`) }
      : {}),
    ...(has(parsed, 'italic')
      ? { italic: booleanValue(parsed.italic, `${path}.italic`) }
      : {}),
    ...(has(parsed, 'verticalAlign')
      ? {
          verticalAlign: enumValue(
            parsed.verticalAlign,
            `${path}.verticalAlign`,
            VERTICAL_ALIGNS,
          ),
        }
      : {}),
    ...(has(parsed, 'compactMathAtom')
      ? {
          compactMathAtom: booleanValue(
            parsed.compactMathAtom,
            `${path}.compactMathAtom`,
          ),
        }
      : {}),
    ...(has(parsed, 'semanticRole')
      ? {
          semanticRole: enumValue(
            parsed.semanticRole,
            `${path}.semanticRole`,
            SEMANTIC_ROLES,
          ),
        }
      : {}),
  }
}

function parseInlineList(value: unknown, path: string, text: string) {
  const inline = array(value, path).map((entry, index) =>
    parseInline(entry, `${path}[${index}]`),
  )
  for (const [index, run] of inline.entries()) {
    if (run.end > text.length)
      fail(
        'RANGE',
        `${path}[${index}]`,
        'inline end must not exceed text length',
      )
  }
  return inline
}

function parseHref(value: unknown, path: string) {
  const parsed = stringValue(value, path)
  if (URL_CONTROL.test(parsed))
    fail('URL', path, 'href must not contain control characters')
  if (/^#[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(parsed)) return parsed
  try {
    const url = new URL(parsed)
    if (
      !['http:', 'https:', 'mailto:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error()
    return parsed
  } catch {
    fail('URL', path, 'href must be a safe fragment or URL')
  }
}

function parseMetadata(value: unknown, path: string): StructMetadata {
  const parsed = object(
    value,
    path,
    ['title', 'subtitle', 'authors', 'abstract'],
    [
      'language',
      'baseDirection',
      'publicationDate',
      'artifactModifiedAt',
      'updated',
      'affiliations',
      'authorAffiliations',
      'authorNotes',
    ],
  )
  const authors = array(parsed.authors, `${path}.authors`).map(
    (author, index) => stringValue(author, `${path}.authors[${index}]`),
  )
  return {
    title: stringValue(parsed.title, `${path}.title`),
    subtitle: stringValue(parsed.subtitle, `${path}.subtitle`),
    authors,
    abstract: stringValue(parsed.abstract, `${path}.abstract`),
    ...(has(parsed, 'language')
      ? { language: stringValue(parsed.language, `${path}.language`) }
      : {}),
    ...(has(parsed, 'baseDirection')
      ? {
          baseDirection: enumValue(
            parsed.baseDirection,
            `${path}.baseDirection`,
            BASE_DIRECTIONS,
          ),
        }
      : {}),
    ...(has(parsed, 'publicationDate')
      ? {
          publicationDate: stringValue(
            parsed.publicationDate,
            `${path}.publicationDate`,
          ),
        }
      : {}),
    ...(has(parsed, 'artifactModifiedAt')
      ? {
          artifactModifiedAt: stringValue(
            parsed.artifactModifiedAt,
            `${path}.artifactModifiedAt`,
          ),
        }
      : {}),
    ...(has(parsed, 'updated')
      ? { updated: stringValue(parsed.updated, `${path}.updated`) }
      : {}),
    ...(has(parsed, 'affiliations')
      ? {
          affiliations: array(parsed.affiliations, `${path}.affiliations`).map(
            (affiliation, index) =>
              stringValue(affiliation, `${path}.affiliations[${index}]`),
          ),
        }
      : {}),
    ...(has(parsed, 'authorAffiliations')
      ? {
          authorAffiliations: array(
            parsed.authorAffiliations,
            `${path}.authorAffiliations`,
          ).map((affiliation, index) => {
            const entry = object(
              affiliation,
              `${path}.authorAffiliations[${index}]`,
              ['author', 'label'],
            )
            return {
              author: stringValue(
                entry.author,
                `${path}.authorAffiliations[${index}].author`,
              ),
              label: stringValue(
                entry.label,
                `${path}.authorAffiliations[${index}].label`,
              ),
            }
          }),
        }
      : {}),
    ...(has(parsed, 'authorNotes')
      ? {
          authorNotes: (() => {
            const notes = array(parsed.authorNotes, `${path}.authorNotes`).map(
              (note, index) => {
                const entry = object(note, `${path}.authorNotes[${index}]`, [
                  'id',
                  'author',
                  'label',
                  'target',
                ])
                return {
                  id: identifier(entry.id, `${path}.authorNotes[${index}].id`),
                  author: stringValue(
                    entry.author,
                    `${path}.authorNotes[${index}].author`,
                  ),
                  label: stringValue(
                    entry.label,
                    `${path}.authorNotes[${index}].label`,
                  ),
                  target: identifier(
                    entry.target,
                    `${path}.authorNotes[${index}].target`,
                  ),
                }
              },
            )
            unique(
              notes.map((note) => note.id),
              `${path}.authorNotes`,
              'author note id',
            )
            return notes
          })(),
        }
      : {}),
  }
}

function parseFurnitureEvidence(
  value: unknown,
  path: string,
): StructFurnitureEvidence {
  const parsed = object(
    value,
    path,
    ['classification', 'band', 'pages', 'boxes', 'evidence'],
    ['normalizedText', 'sequence', 'sourceRunIndexes'],
  )
  const pages = array(parsed.pages, `${path}.pages`).map((page, index) =>
    nonNegativeInteger(page, `${path}.pages[${index}]`),
  )
  unique(pages.map(String), `${path}.pages`, 'page')
  return {
    classification: enumValue(
      parsed.classification,
      `${path}.classification`,
      FURNITURE_CLASSIFICATIONS,
    ),
    band: enumValue(parsed.band, `${path}.band`, BANDS),
    pages,
    boxes: array(parsed.boxes, `${path}.boxes`).map((box, index) =>
      parseBox(box, `${path}.boxes[${index}]`),
    ),
    evidence: array(parsed.evidence, `${path}.evidence`).map((entry, index) =>
      stringValue(entry, `${path}.evidence[${index}]`),
    ),
    ...(has(parsed, 'normalizedText')
      ? {
          normalizedText: stringValue(
            parsed.normalizedText,
            `${path}.normalizedText`,
          ),
        }
      : {}),
    ...(has(parsed, 'sequence')
      ? {
          sequence: array(parsed.sequence, `${path}.sequence`).map(
            (entry, index) =>
              nonNegativeInteger(entry, `${path}.sequence[${index}]`),
          ),
        }
      : {}),
    ...(has(parsed, 'sourceRunIndexes')
      ? {
          sourceRunIndexes: array(
            parsed.sourceRunIndexes,
            `${path}.sourceRunIndexes`,
          ).map((entry, index) =>
            nonNegativeInteger(entry, `${path}.sourceRunIndexes[${index}]`),
          ),
        }
      : {}),
  }
}

function parseFurnitureReview(
  value: unknown,
  path: string,
): StructFurnitureReview {
  const parsed = object(value, path, [
    'reason',
    'band',
    'pages',
    'boxes',
    'evidence',
  ])
  const pages = array(parsed.pages, `${path}.pages`).map((page, index) =>
    nonNegativeInteger(page, `${path}.pages[${index}]`),
  )
  unique(pages.map(String), `${path}.pages`, 'page')
  return {
    reason: enumValue(parsed.reason, `${path}.reason`, [
      'single-occurrence-margin',
    ] as const),
    band: enumValue(parsed.band, `${path}.band`, BANDS),
    pages,
    boxes: array(parsed.boxes, `${path}.boxes`).map((box, index) =>
      parseBox(box, `${path}.boxes[${index}]`),
    ),
    evidence: array(parsed.evidence, `${path}.evidence`).map((entry, index) =>
      stringValue(entry, `${path}.evidence[${index}]`),
    ),
  }
}

function parseAttributes(
  value: unknown,
  path: string,
): Record<string, string | number | boolean> {
  const keys = ownDataKeys(value, path).sort()
  const entries: Array<[string, string | number | boolean]> = []
  for (const key of keys) {
    if (
      !key ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype'
    )
      fail('FIELD', `${path}.${key}`, 'attribute key is not safe')
    const child = (value as DataObject)[key]
    if (typeof child === 'string')
      entries.push([key, stringValue(child, `${path}.${key}`)])
    else if (typeof child === 'boolean') entries.push([key, child])
    else if (typeof child === 'number')
      entries.push([key, finiteNumber(child, `${path}.${key}`)])
    else
      fail(
        'TYPE',
        `${path}.${key}`,
        'attribute value must be a string, number, or boolean',
      )
  }
  return copyRecord(entries) as Record<string, string | number | boolean>
}

function parseTableCell(value: unknown, path: string): StructTableCell {
  const parsed = object(value, path, [
    'id',
    'text',
    'row',
    'column',
    'rowSpan',
    'columnSpan',
    'headerScope',
    'inline',
    'evidence',
  ])
  const text = stringValue(parsed.text, `${path}.text`)
  return {
    id: identifier(parsed.id, `${path}.id`),
    text,
    row: nonNegativeInteger(parsed.row, `${path}.row`),
    column: nonNegativeInteger(parsed.column, `${path}.column`),
    rowSpan: integer(parsed.rowSpan, `${path}.rowSpan`, 1),
    columnSpan: integer(parsed.columnSpan, `${path}.columnSpan`, 1),
    headerScope:
      parsed.headerScope === null
        ? null
        : enumValue(parsed.headerScope, `${path}.headerScope`, HEADER_SCOPES),
    inline: parseInlineList(parsed.inline, `${path}.inline`, text),
    evidence: parseEvidence(parsed.evidence, `${path}.evidence`),
  }
}

function parseTable(value: unknown, path: string): StructTable {
  const parsed = object(value, path, ['rows', 'columns', 'cells', 'semantic'])
  const cells = array(parsed.cells, `${path}.cells`).map((cell, index) =>
    parseTableCell(cell, `${path}.cells[${index}]`),
  )
  unique(
    cells.map((cell) => cell.id),
    `${path}.cells`,
    'table cell id',
  )
  return {
    rows: nonNegativeInteger(parsed.rows, `${path}.rows`),
    columns: nonNegativeInteger(parsed.columns, `${path}.columns`),
    cells,
    semantic: enumValue(parsed.semantic, `${path}.semantic`, TABLE_SEMANTICS),
  }
}

function parseBlock(value: unknown, path: string): StructBlock {
  const parsed = object(
    value,
    path,
    ['id', 'kind', 'text', 'page', 'order', 'column', 'inline', 'evidence'],
    [
      'label',
      'sourceObservationAnchorIds',
      'table',
      'fallbackAssetIds',
      'furniture',
      'furnitureReview',
      'attributes',
    ],
  )
  const text = stringValue(parsed.text, `${path}.text`)
  return {
    id: identifier(parsed.id, `${path}.id`),
    kind: enumValue(parsed.kind, `${path}.kind`, BLOCK_KINDS),
    text,
    ...(has(parsed, 'label')
      ? { label: stringValue(parsed.label, `${path}.label`) }
      : {}),
    page: nullable(parsed.page, `${path}.page`, (entry, entryPath) =>
      nonNegativeInteger(entry, entryPath),
    ),
    order: nonNegativeInteger(parsed.order, `${path}.order`),
    column:
      parsed.column === null
        ? null
        : enumValue(parsed.column, `${path}.column`, COLUMN_SIDES),
    inline: parseInlineList(parsed.inline, `${path}.inline`, text),
    evidence: parseEvidence(parsed.evidence, `${path}.evidence`),
    ...(has(parsed, 'sourceObservationAnchorIds')
      ? {
          sourceObservationAnchorIds: identifierList(
            parsed.sourceObservationAnchorIds,
            `${path}.sourceObservationAnchorIds`,
          ),
        }
      : {}),
    ...(has(parsed, 'table')
      ? { table: parseTable(parsed.table, `${path}.table`) }
      : {}),
    ...(has(parsed, 'fallbackAssetIds')
      ? {
          fallbackAssetIds: identifierList(
            parsed.fallbackAssetIds,
            `${path}.fallbackAssetIds`,
          ),
        }
      : {}),
    ...(has(parsed, 'furniture')
      ? {
          furniture: parseFurnitureEvidence(
            parsed.furniture,
            `${path}.furniture`,
          ),
        }
      : {}),
    ...(has(parsed, 'furnitureReview')
      ? {
          furnitureReview: parseFurnitureReview(
            parsed.furnitureReview,
            `${path}.furnitureReview`,
          ),
        }
      : {}),
    ...(has(parsed, 'attributes')
      ? { attributes: parseAttributes(parsed.attributes, `${path}.attributes`) }
      : {}),
  }
}

function parseAsset(value: unknown, path: string): StructAsset {
  const parsed = object(
    value,
    path,
    [
      'id',
      'kind',
      'href',
      'mediaType',
      'sha256',
      'width',
      'height',
      'sourceObjectIds',
      'evidence',
      'fallback',
    ],
    ['bytes'],
  )
  const href = stringValue(parsed.href, `${path}.href`)
  if (URL_CONTROL.test(href))
    fail(
      'HREF',
      `${path}.href`,
      'asset href must not contain control characters',
    )
  if (
    !href ||
    href.trim() !== href ||
    href.startsWith('/') ||
    href.includes('\\') ||
    /(?:^|\/)\.\.(?:\/|$)/u.test(href)
  )
    fail('HREF', `${path}.href`, 'asset href must be a safe relative path')
  return {
    id: identifier(parsed.id, `${path}.id`),
    kind: enumValue(parsed.kind, `${path}.kind`, ASSET_KINDS),
    href,
    mediaType: stringValue(parsed.mediaType, `${path}.mediaType`),
    sha256: hash(parsed.sha256, `${path}.sha256`),
    width: finiteNumber(parsed.width, `${path}.width`),
    height: finiteNumber(parsed.height, `${path}.height`),
    ...(has(parsed, 'bytes')
      ? { bytes: parseBytes(parsed.bytes, `${path}.bytes`) }
      : {}),
    sourceObjectIds: identifierList(
      parsed.sourceObjectIds,
      `${path}.sourceObjectIds`,
    ),
    evidence: parseEvidence(parsed.evidence, `${path}.evidence`),
    fallback: enumValue(parsed.fallback, `${path}.fallback`, ASSET_FALLBACKS),
  }
}

function parseRelationshipCandidate(
  value: unknown,
  path: string,
): StructRelationshipCandidate {
  const parsed = object(value, path, ['target', 'confidence', 'evidence'])
  return {
    target: reference(parsed.target, `${path}.target`),
    confidence: unitInterval(parsed.confidence, `${path}.confidence`),
    evidence: parseEvidence(parsed.evidence, `${path}.evidence`),
  }
}

function parseRelationship(value: unknown, path: string): StructRelationship {
  const parsed = object(
    value,
    path,
    ['id', 'kind', 'from', 'to', 'status', 'confidence', 'evidence'],
    ['label', 'candidates'],
  )
  const candidates = has(parsed, 'candidates')
    ? array(parsed.candidates, `${path}.candidates`).map((candidate, index) =>
        parseRelationshipCandidate(candidate, `${path}.candidates[${index}]`),
      )
    : undefined
  if (candidates)
    unique(
      candidates.map((candidate) => candidate.target),
      `${path}.candidates`,
      'candidate target',
    )
  return {
    id: identifier(parsed.id, `${path}.id`),
    kind: enumValue(parsed.kind, `${path}.kind`, RELATIONSHIP_KINDS),
    from: identifier(parsed.from, `${path}.from`),
    to: referenceList(parsed.to, `${path}.to`),
    ...(has(parsed, 'label')
      ? { label: stringValue(parsed.label, `${path}.label`) }
      : {}),
    status: enumValue(parsed.status, `${path}.status`, RELATIONSHIP_STATUSES),
    confidence: unitInterval(parsed.confidence, `${path}.confidence`),
    evidence: parseEvidence(parsed.evidence, `${path}.evidence`),
    ...(candidates ? { candidates } : {}),
  }
}

function parseDiagnostic(value: unknown, path: string): StructDiagnostic {
  const parsed = object(
    value,
    path,
    ['id', 'severity', 'category', 'title', 'message', 'pages', 'sourceIds'],
    ['action'],
  )
  const pages = array(parsed.pages, `${path}.pages`).map((page, index) =>
    nonNegativeInteger(page, `${path}.pages[${index}]`),
  )
  unique(pages.map(String), `${path}.pages`, 'page')
  return {
    id: identifier(parsed.id, `${path}.id`),
    severity: enumValue(
      parsed.severity,
      `${path}.severity`,
      DIAGNOSTIC_SEVERITIES,
    ),
    category: enumValue(
      parsed.category,
      `${path}.category`,
      DIAGNOSTIC_CATEGORIES,
    ),
    title: stringValue(parsed.title, `${path}.title`),
    message: stringValue(parsed.message, `${path}.message`),
    ...(has(parsed, 'action')
      ? { action: stringValue(parsed.action, `${path}.action`) }
      : {}),
    pages,
    sourceIds: identifierList(parsed.sourceIds, `${path}.sourceIds`),
  }
}

function parsePage(value: unknown, path: string): StructPageLayout {
  const parsed = object(value, path, [
    'page',
    'width',
    'height',
    'rotation',
    'blocks',
    'columns',
  ])
  const columns = array(parsed.columns, `${path}.columns`).map(
    (column, index) => {
      const entry = object(column, `${path}.columns[${index}]`, [
        'id',
        'side',
        'blockIds',
      ])
      return {
        id: identifier(entry.id, `${path}.columns[${index}].id`),
        side: enumValue(
          entry.side,
          `${path}.columns[${index}].side`,
          COLUMN_SIDES,
        ),
        blockIds: identifierList(
          entry.blockIds,
          `${path}.columns[${index}].blockIds`,
        ),
      }
    },
  )
  unique(
    columns.map((column) => column.id),
    `${path}.columns`,
    'column id',
  )
  return {
    page: nonNegativeInteger(parsed.page, `${path}.page`),
    width: finiteNumber(parsed.width, `${path}.width`),
    height: finiteNumber(parsed.height, `${path}.height`),
    rotation: finiteNumber(parsed.rotation, `${path}.rotation`),
    blocks: identifierList(parsed.blocks, `${path}.blocks`),
    columns,
  }
}

function parseRecovery(value: unknown, path: string): StructRecovery {
  const parsed = object(
    value,
    path,
    ['status', 'title', 'summary', 'issues'],
    ['userAction'],
  )
  return {
    status: enumValue(parsed.status, `${path}.status`, RECOVERY_STATUSES),
    title: stringValue(parsed.title, `${path}.title`),
    summary: stringValue(parsed.summary, `${path}.summary`),
    issues: array(parsed.issues, `${path}.issues`).map((issue, index) => {
      const entry = object(
        issue,
        `${path}.issues[${index}]`,
        ['category', 'title', 'count', 'pages'],
        ['action'],
      )
      const pages = array(entry.pages, `${path}.issues[${index}].pages`).map(
        (page, pageIndex) =>
          nonNegativeInteger(
            page,
            `${path}.issues[${index}].pages[${pageIndex}]`,
          ),
      )
      unique(pages.map(String), `${path}.issues[${index}].pages`, 'page')
      return {
        category: enumValue(
          entry.category,
          `${path}.issues[${index}].category`,
          DIAGNOSTIC_CATEGORIES,
        ),
        title: stringValue(entry.title, `${path}.issues[${index}].title`),
        count: nonNegativeInteger(
          entry.count,
          `${path}.issues[${index}].count`,
        ),
        pages,
        ...(has(entry, 'action')
          ? {
              action: stringValue(
                entry.action,
                `${path}.issues[${index}].action`,
              ),
            }
          : {}),
      }
    }),
    ...(has(parsed, 'userAction')
      ? { userAction: stringValue(parsed.userAction, `${path}.userAction`) }
      : {}),
  }
}

const CONSERVATION_REQUIRED = [
  'sourceNodeCount',
  'accountedSourceNodeCount',
  'sourceRegionCount',
  'accountedSourceRegionCount',
  'sourceAnnotationCount',
  'accountedSourceAnnotationCount',
  'sourceAssetCount',
  'accountedSourceAssetCount',
  'sourceRelationshipCount',
  'accountedSourceRelationshipCount',
  'sourceDiagnosticCount',
  'accountedSourceDiagnosticCount',
  'sourceTextCharacterCount',
  'structBlockCount',
  'structAssetCount',
  'structRelationshipCount',
  'structDiagnosticCount',
  'structTextCharacterCount',
] as const
const CONSERVATION_OPTIONAL = [
  'sourceFurnitureBlockCount',
  'accountedFurnitureBlockCount',
  'sourceFurnitureTextCharacterCount',
  'structFurnitureBlockCount',
  'structFurnitureTextCharacterCount',
  'furnitureContaminationCount',
] as const

function parseConservation(
  value: unknown,
  path: string,
): StructReceipt['conservation'] {
  const parsed = object(
    value,
    path,
    CONSERVATION_REQUIRED,
    CONSERVATION_OPTIONAL,
  )
  const result = copyRecord(
    [...CONSERVATION_REQUIRED, ...CONSERVATION_OPTIONAL]
      .filter((key) => has(parsed, key))
      .map((key) => [key, nonNegativeInteger(parsed[key], `${path}.${key}`)]),
  )
  return result as StructReceipt['conservation']
}

function parseReceipt(value: unknown, path: string): StructReceipt {
  const parsed = object(
    value,
    path,
    [
      'schemaVersion',
      'sourceSha256',
      'blockCount',
      'assetCount',
      'relationshipCount',
      'diagnosticCount',
      'textCharacterCount',
      'conservation',
      'generatedSha256',
    ],
    ['documentId', 'modelConsultations'],
  )
  let modelConsultations: StructReceipt['modelConsultations']
  if (has(parsed, 'modelConsultations')) {
    const copied = copyCanonicalJson(
      parsed.modelConsultations,
      `${path}.modelConsultations`,
    )
    if (!validateModelConsultationReceipt(copied))
      fail(
        'MODEL_RECEIPT',
        `${path}.modelConsultations`,
        'invalid model consultation receipt',
      )
    modelConsultations = copied as StructReceipt['modelConsultations']
  }
  return {
    schemaVersion: parseSchemaVersion(
      parsed.schemaVersion,
      `${path}.schemaVersion`,
    ),
    ...(has(parsed, 'documentId')
      ? { documentId: identifier(parsed.documentId, `${path}.documentId`) }
      : {}),
    sourceSha256: hash(parsed.sourceSha256, `${path}.sourceSha256`),
    ...(modelConsultations ? { modelConsultations } : {}),
    blockCount: nonNegativeInteger(parsed.blockCount, `${path}.blockCount`),
    assetCount: nonNegativeInteger(parsed.assetCount, `${path}.assetCount`),
    relationshipCount: nonNegativeInteger(
      parsed.relationshipCount,
      `${path}.relationshipCount`,
    ),
    diagnosticCount: nonNegativeInteger(
      parsed.diagnosticCount,
      `${path}.diagnosticCount`,
    ),
    textCharacterCount: nonNegativeInteger(
      parsed.textCharacterCount,
      `${path}.textCharacterCount`,
    ),
    conservation: parseConservation(
      parsed.conservation,
      `${path}.conservation`,
    ),
    generatedSha256: hash(parsed.generatedSha256, `${path}.generatedSha256`),
  }
}

function parseSource(value: unknown, path: string): StructSource {
  const parsed = object(value, path, [
    'format',
    'fileName',
    'sha256',
    'byteLength',
    'pageCount',
    'localOnly',
  ])
  return {
    format: enumValue(parsed.format, `${path}.format`, SOURCE_FORMATS),
    fileName: stringValue(parsed.fileName, `${path}.fileName`),
    sha256: hash(parsed.sha256, `${path}.sha256`),
    byteLength: nonNegativeInteger(parsed.byteLength, `${path}.byteLength`),
    pageCount: nonNegativeInteger(parsed.pageCount, `${path}.pageCount`),
    localOnly: booleanValue(parsed.localOnly, `${path}.localOnly`),
  }
}

function parseSchemaVersion(value: unknown, path: string) {
  if (value !== LEGACY_STRUCT_SCHEMA_VERSION && value !== STRUCT_SCHEMA_VERSION)
    fail(
      'SCHEMA_VERSION',
      path,
      `unsupported schema version ${JSON.stringify(value)}`,
    )
  return value
}

function validateDocumentInvariants(
  document: StructDocument,
  input: DataObject,
) {
  const receipt = document.receipt
  if (receipt.schemaVersion !== document.schemaVersion)
    fail(
      'SCHEMA_VERSION',
      '$.receipt.schemaVersion',
      'receipt and document versions must match',
    )
  if (receipt.sourceSha256 !== document.source.sha256)
    fail(
      'BINDING',
      '$.receipt.sourceSha256',
      'receipt source hash must match source',
    )
  if (
    receipt.blockCount !== document.blocks.length ||
    receipt.assetCount !== document.assets.length ||
    receipt.relationshipCount !== document.relationships.length ||
    receipt.diagnosticCount !== document.diagnostics.length
  )
    fail('COUNT', '$.receipt', 'receipt counts must match document arrays')
  const textCharacterCount = document.blocks.reduce(
    (count, block) => count + block.text.length,
    0,
  )
  if (receipt.textCharacterCount !== textCharacterCount)
    fail(
      'COUNT',
      '$.receipt.textCharacterCount',
      'receipt text count must match block text',
    )
  const conservation = receipt.conservation
  if (receipt.textCharacterCount !== conservation.sourceTextCharacterCount)
    fail(
      'COUNT',
      '$.receipt.conservation.sourceTextCharacterCount',
      'receipt text count must match source text count',
    )
  if (
    conservation.structBlockCount !== document.blocks.length ||
    conservation.structAssetCount !== document.assets.length ||
    conservation.structRelationshipCount !== document.relationships.length ||
    conservation.structDiagnosticCount !== document.diagnostics.length ||
    conservation.structTextCharacterCount !== textCharacterCount
  )
    fail(
      'COUNT',
      '$.receipt.conservation',
      'STRUCT conservation counts must match document',
    )

  const version = document.schemaVersion
  if (version === LEGACY_STRUCT_SCHEMA_VERSION) {
    if (
      has(input, 'documentId') ||
      has(receipt as unknown as DataObject, 'documentId')
    )
      fail('MIGRATION', '$', '0.1.0 documents cannot contain document bindings')
    if (receipt.modelConsultations !== undefined)
      fail(
        'MIGRATION',
        '$.receipt.modelConsultations',
        '0.1.0 documents cannot contain model consultations',
      )
  } else {
    if (!document.documentId || receipt.documentId !== document.documentId)
      fail(
        'BINDING',
        '$.documentId',
        'current documents require matching document bindings',
      )
  }
}

function parseDocument(value: unknown): StructDocument {
  const parsed = object(
    value,
    '$',
    [
      'schemaVersion',
      'source',
      'metadata',
      'blocks',
      'assets',
      'relationships',
      'pages',
      'diagnostics',
      'recovery',
      'receipt',
    ],
    ['documentId'],
  )
  const schemaVersion = parseSchemaVersion(
    parsed.schemaVersion,
    '$.schemaVersion',
  )
  const blocks = array(parsed.blocks, '$.blocks').map((block, index) =>
    parseBlock(block, `$.blocks[${index}]`),
  )
  const assets = array(parsed.assets, '$.assets').map((asset, index) =>
    parseAsset(asset, `$.assets[${index}]`),
  )
  const relationships = array(parsed.relationships, '$.relationships').map(
    (relationship, index) =>
      parseRelationship(relationship, `$.relationships[${index}]`),
  )
  const pages = array(parsed.pages, '$.pages').map((page, index) =>
    parsePage(page, `$.pages[${index}]`),
  )
  const diagnostics = array(parsed.diagnostics, '$.diagnostics').map(
    (diagnostic, index) =>
      parseDiagnostic(diagnostic, `$.diagnostics[${index}]`),
  )
  unique(
    blocks.map((block) => block.id),
    '$.blocks',
    'block id',
  )
  unique(
    assets.map((asset) => asset.id),
    '$.assets',
    'asset id',
  )
  unique(
    relationships.map((relationship) => relationship.id),
    '$.relationships',
    'relationship id',
  )
  unique(
    diagnostics.map((diagnostic) => diagnostic.id),
    '$.diagnostics',
    'diagnostic id',
  )
  unique(
    pages.map((page) => String(page.page)),
    '$.pages',
    'page number',
  )
  const document: StructDocument = {
    schemaVersion,
    ...(has(parsed, 'documentId')
      ? { documentId: identifier(parsed.documentId, '$.documentId') }
      : {}),
    source: parseSource(parsed.source, '$.source'),
    metadata: parseMetadata(parsed.metadata, '$.metadata'),
    blocks,
    assets,
    relationships,
    pages,
    diagnostics,
    recovery: parseRecovery(parsed.recovery, '$.recovery'),
    receipt: parseReceipt(parsed.receipt, '$.receipt'),
  }
  validateDocumentInvariants(document, parsed)
  return document
}

/** Decode a JSON-safe or in-memory STRUCT document without coercion. */
export function decodeStructDocument(input: unknown): StructDocument {
  return parseDocument(input)
}

/**
 * Explicit STRUCT migration entrypoint. There are no historical migrations in
 * this slice: declared 0.1.0 and 0.2.0 documents are canonically decoded and
 * returned at their declared version; every other version fails closed.
 */
export function migrateStructDocument(input: unknown): StructDocument {
  return decodeStructDocument(input)
}

function toJsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return bytesToBase64(value)
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (value && typeof value === 'object') {
    const source = value as DataObject
    return copyRecord(
      Object.keys(source)
        .sort()
        .map((key) => [key, toJsonValue(source[key])]),
    )
  }
  return value
}

/** Encode a validated STRUCT document with base64 asset bytes for JSON. */
export function encodeStructDocument(
  document: StructDocument,
): StructDocumentJson {
  return toJsonValue(decodeStructDocument(document)) as StructDocumentJson
}
