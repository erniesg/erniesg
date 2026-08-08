import { createHash } from 'node:crypto'
import { createAssetBundle, type AssetDescriptor, type AssetBundle } from '../asset-bundle'
import { PUBLICATION_GRAPH_VERSION, publicationGraphSchema, type PublicationInlineRun, type PublicationNode } from '../schema'
import { PUBLICATION_SOURCE_ADAPTER_VERSION, validatePublicationSourceResult, type AdapterDiagnostic, type PublicationSourceAdapter, type PublicationSourceResult } from '../source-adapter'
import { z } from 'zod'

/** Version of the JSON mapping document, independent from Payload's version. */
export const PAYLOAD_MAPPING_VERSION = '1.0.0' as const
export const PAYLOAD_LEXICAL_ADAPTER_ID = 'payload-lexical' as const
export const PAYLOAD_ADAPTER_ID = PAYLOAD_LEXICAL_ADAPTER_ID
export const PAYLOAD_LEXICAL_ADAPTER_VERSION = PUBLICATION_SOURCE_ADAPTER_VERSION
export const PAYLOAD_MAPPING_POLICY_VERSION = PAYLOAD_MAPPING_VERSION

const MAX_EXPORT_BYTES = 100_000_000
const MAX_CHILDREN = 100_000
const MAX_DEPTH = 256

const pathPartSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)
const pathSchema = z.union([pathPartSchema, z.array(pathPartSchema).min(1).max(32)])

const fieldMappingSchema = z
  .object({
    id: pathSchema.optional(),
    title: pathSchema.optional(),
    description: pathSchema.optional(),
    authors: pathSchema.optional(),
    locale: pathSchema.optional(),
    status: pathSchema.optional(),
    version: pathSchema.optional(),
    content: pathSchema.optional(),
    uploads: pathSchema.optional(),
    locales: pathSchema.optional(),
    created: pathSchema.optional(),
    modified: pathSchema.optional(),
    keywords: pathSchema.optional(),
  })
  .strict()

const blockMappingSchema = z.record(pathPartSchema, z.enum(['paragraph', 'heading', 'quote', 'code', 'aside', 'figure', 'table', 'equation', 'media', 'reference'])).default({})

const relationshipMappingSchema = z
  .record(
    pathPartSchema,
    z
      .object({
        target: pathSchema.optional(),
        label: pathSchema.optional(),
        role: z.enum(['citation', 'cross-reference', 'affiliation-marker', 'bibliography-entry']).optional(),
      })
      .strict(),
  )
  .default({})

const lexicalMappingSchema = z
  .object({
    fields: fieldMappingSchema.optional(),
    blocks: blockMappingSchema.optional(),
    relationships: relationshipMappingSchema.optional(),
  })
  .strict()
  .optional()

export const payloadMappingPolicySchema = z
  .object({
    version: z
      .union([z.string(), z.number().int()])
      .transform(String)
      .refine((value) => /^1(?:\.0){0,2}$/u.test(value), 'Unsupported Payload mapping policy version')
      .transform(() => PAYLOAD_MAPPING_VERSION)
      .default(PAYLOAD_MAPPING_VERSION),
    fields: fieldMappingSchema.default({}),
    blocks: blockMappingSchema,
    relationships: relationshipMappingSchema,
    // `document`/`fieldMap` and `lexical` are accepted as documented aliases
    // for exports produced by small local tooling, then normalized below.
    document: fieldMappingSchema.optional(),
    fieldMap: fieldMappingSchema.optional(),
    lexical: lexicalMappingSchema,
    blockTypes: blockMappingSchema.optional(),
    locale: z.string().min(1).max(64).optional(),
    fallbackLocale: z.string().min(1).max(64).optional(),
  })
  .strict()

export type PayloadMappingPolicy = z.infer<typeof payloadMappingPolicySchema>
export const payloadMappingSchema = payloadMappingPolicySchema

export type PayloadAdapterInput = {
  /** A decoded local export object; no transport or Payload runtime is accepted. */
  document: unknown
  mapping?: unknown
  locale?: string
}

type JsonObject = Record<string, unknown>

type LexicalNode = JsonObject & {
  type?: unknown
  children?: unknown
  text?: unknown
  id?: unknown
  key?: unknown
  nodeId?: unknown
  format?: unknown
  tag?: unknown
  level?: unknown
  url?: unknown
  fields?: unknown
  value?: unknown
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertSafeJson(value: unknown, path = '$', depth = 0): void {
  if (depth > MAX_DEPTH) throw new Error(`Payload export exceeds maximum depth at ${path}`)
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error(`Payload export contains executable value at ${path}`)
  if (Array.isArray(value)) {
    if (value.length > MAX_CHILDREN) throw new Error(`Payload export exceeds collection bound at ${path}`)
    value.forEach((child, index) => assertSafeJson(child, `${path}[${index}]`, depth + 1))
    return
  }
  if (!isObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`Payload export contains unsafe key ${key} at ${path}`)
    if (/^(?:hook|hooks|resolver|resolvers|callback|callbacks|function|execute)$/iu.test(key)) throw new Error(`Payload export cannot contain executable mapping key ${key} at ${path}`)
    assertSafeJson(child, `${path}.${key}`, depth + 1)
  }
}

function parseMapping(value: unknown): PayloadMappingPolicy {
  assertSafeJson(value ?? {})
  if (value !== undefined && !isObject(value)) throw new Error('Payload mapping policy must be an object')
  const raw = payloadMappingPolicySchema.parse(value ?? {})
  const lexical = isObject(raw.lexical) ? raw.lexical : {}
  const rawFields = isObject(raw.fields) && Object.keys(raw.fields).length ? raw.fields : undefined
  const rawBlocks = isObject(raw.blocks) && Object.keys(raw.blocks).length ? raw.blocks : undefined
  const rawRelationships = isObject(raw.relationships) && Object.keys(raw.relationships).length ? raw.relationships : undefined
  const normalized = {
    version: raw.version ?? PAYLOAD_MAPPING_VERSION,
    fields: rawFields ?? raw.fieldMap ?? raw.document ?? lexical.fields ?? {},
    blocks: rawBlocks ?? raw.blockTypes ?? lexical.blocks ?? {},
    relationships: rawRelationships ?? lexical.relationships ?? {},
    locale: raw.locale,
    fallbackLocale: raw.fallbackLocale,
  }
  const parsed = payloadMappingPolicySchema.parse(normalized)
  for (const key of Object.keys(parsed.blocks)) {
    if (Object.prototype.hasOwnProperty.call(parsed.relationships, key))
      throw new Error(
        `Payload mapping key ${key} cannot be both a block and relationship`,
      )
  }
  return parsed
}

function asPath(value: string | string[]): string[] {
  return Array.isArray(value) ? value : value.split('.').filter(Boolean)
}

function readPath(value: unknown, path: string | string[]): unknown {
  let current: unknown = value
  for (const part of asPath(path)) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined
    current = current[part]
  }
  return current
}

const DEFAULT_PATHS: Record<string, string[]> = {
  id: ['id', '_id'],
  title: ['title', 'name'],
  description: ['description', 'excerpt', 'summary'],
  authors: ['authors', 'author'],
  locale: ['locale', 'language'],
  status: ['status', '_status'],
  version: ['version', 'updatedAt', 'updated'],
  content: ['content', 'body', 'richText'],
  uploads: ['uploads', 'media'],
  locales: ['locales', 'localeVariants', 'translations'],
  created: ['createdAt', 'created', 'publishedAt', 'publicationDate'],
  modified: ['updatedAt', 'updated', 'modified'],
  keywords: ['keywords', 'tags'],
}

function mappedValue(document: JsonObject, mapping: PayloadMappingPolicy, field: string) {
  const configured = mapping.fields[field as keyof PayloadMappingPolicy['fields']]
  if (configured !== undefined) return readPath(document, configured)
  for (const path of DEFAULT_PATHS[field] ?? []) {
    const value = readPath(document, path)
    if (value !== undefined) return value
  }
  return undefined
}

function optionalProse(value: unknown, field: string, location = 'metadata') {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Payload ${field} must be a non-empty string at ${location}`)
  return value.trim()
}

function requiredProse(value: unknown, field: string, location = 'metadata') {
  const text = optionalProse(value, field, location)
  if (!text) throw new Error(`Payload publication is missing required ${field}`)
  return text
}

function requiredPayloadId(value: unknown) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw new Error('Payload publication id must be a non-empty string or number')
}

function contributorName(value: unknown, location: string) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (isObject(value)) {
    const candidates = ['name', 'fullName', 'displayName'].filter((key) => value[key] !== undefined).map((key) => value[key])
    if (candidates.length === 1 && typeof candidates[0] === 'string' && candidates[0].trim()) return candidates[0].trim()
  }
  throw new Error(`Payload author must be a non-empty string or named author object at ${location}`)
}

function canonicalLocale(value: unknown, field = 'locale') {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Payload publication has invalid ${field}: ${String(value)}`)
  const raw = value.trim()
  let locale: string
  try {
    locale = Intl.getCanonicalLocales(raw)[0]
  } catch {
    throw new Error(`Payload publication has invalid ${field}: ${raw}`)
  }
  return locale
}

const GRAPH_SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

function sourceSafeId(value: string) {
  if (GRAPH_SAFE_ID_PATTERN.test(value)) return value
  const sanitized = value
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/u, '')
  const suffix = digest(value).slice(0, 16)
  const prefix = (sanitized || 'document').slice(0, 256 - suffix.length - 1)
  return `${prefix}-${suffix}`
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function digest(value: Uint8Array | string) {
  return createHash('sha256').update(value).digest('hex')
}

/** Stable id derivation is public so anchor tests and tooling can prove the
 * structural-path/content-digest rule without invoking the adapter. */
export function derivePayloadNodeId(documentId: string, structuralPath: string, node: unknown) {
  const suffix = digest(`${documentId}|${structuralPath}|${stableStringify(node)}`).slice(0, 20)
  const documentPrefix = sourceSafeId(documentId).slice(
    0,
    256 - 'derived--'.length - suffix.length,
  )
  return `derived-${documentPrefix}-${suffix}`
}

function sourceLocation(sourceId: string, path: string) {
  return `${sourceId}:${path}`
}

function decodeBytes(value: unknown, path: string): Uint8Array | undefined {
  if (value === undefined || value === null) return undefined
  if (value instanceof Uint8Array) return value.byteLength ? new Uint8Array(value) : undefined
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) return value.length ? new Uint8Array(value as number[]) : undefined
  if (typeof value !== 'string') throw new Error(`Payload upload bytes at ${path} must be base64 or byte array`)
  const encoded = value.trim()
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error(`Payload upload bytes at ${path} are not valid base64`)
  const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'))
  if (bytes.length > MAX_EXPORT_BYTES) throw new Error(`Payload upload exceeds byte bound at ${path}`)
  return bytes
}

function mediaTypeFor(upload: JsonObject, location: string): string {
  const direct = upload.mimeType ?? upload.mimetype ?? upload.mediaType
  if (direct !== undefined) {
    if (typeof direct !== 'string' || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(direct)) throw new Error(`Payload upload has invalid media type at ${location}`)
    return direct.toLowerCase()
  }
  const rawFilename = upload.filename ?? upload.fileName ?? upload.name
  if (rawFilename !== undefined && typeof rawFilename !== 'string') throw new Error(`Payload upload filename must be a string at ${location}`)
  const filename = rawFilename ?? ''
  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  const types: Record<string, string> = {
    avif: 'image/avif',
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    pdf: 'application/pdf',
  }
  return (extension && types[extension]) || 'application/octet-stream'
}

function optionalUploadDimension(value: unknown, field: string, location: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 1_000_000) throw new Error(`Payload upload ${field} must be a positive integer at ${location}`)
  return value
}

function uploadFileName(upload: JsonObject, location: string) {
  const value = upload.filename ?? upload.fileName ?? upload.name
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Payload upload filename is invalid at ${location}`)
  return value
}

function uploadFocalPoint(upload: JsonObject, location: string) {
  const hasLegacyFocal = upload.focalX !== undefined || upload.focalY !== undefined
  if (upload.focalPoint !== undefined && hasLegacyFocal) throw new Error(`Payload upload has conflicting focal metadata at ${location}`)
  if (upload.focalPoint !== undefined) {
    if (
      !isObject(upload.focalPoint) ||
      typeof upload.focalPoint.x !== 'number' ||
      typeof upload.focalPoint.y !== 'number' ||
      !Number.isFinite(upload.focalPoint.x) ||
      !Number.isFinite(upload.focalPoint.y) ||
      upload.focalPoint.x < 0 ||
      upload.focalPoint.x > 1 ||
      upload.focalPoint.y < 0 ||
      upload.focalPoint.y > 1
    )
      throw new Error(`Payload upload has invalid focal point at ${location}`)
    return { x: upload.focalPoint.x, y: upload.focalPoint.y }
  }
  if (hasLegacyFocal) {
    if (
      typeof upload.focalX !== 'number' ||
      typeof upload.focalY !== 'number' ||
      !Number.isFinite(upload.focalX) ||
      !Number.isFinite(upload.focalY) ||
      upload.focalX < 0 ||
      upload.focalX > 100 ||
      upload.focalY < 0 ||
      upload.focalY > 100
    )
      throw new Error(`Payload upload has invalid focal point at ${location}`)
    return { x: upload.focalX / 100, y: upload.focalY / 100 }
  }
  return undefined
}

function uploadId(upload: JsonObject) {
  const value = upload.id ?? upload._id ?? upload.key ?? upload.filename ?? upload.fileName
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function uploadCrop(upload: JsonObject, location: string) {
  if (upload.crop === undefined) return undefined
  if (!isObject(upload.crop)) throw new Error(`Payload upload crop must be an object at ${location}`)
  const { x, y, width, height, unit } = upload.crop
  if (![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value)) || Number(x) < 0 || Number(y) < 0 || Number(width) <= 0 || Number(height) <= 0)
    throw new Error(`Payload upload crop has invalid geometry at ${location}`)
  if (unit !== undefined && unit !== 'px' && unit !== 'percent') throw new Error(`Payload upload crop has unsupported unit ${String(unit)} at ${location}`)
  return {
    x: Number(x),
    y: Number(y),
    width: Number(width),
    height: Number(height),
    unit: unit === 'percent' ? ('percent' as const) : ('px' as const),
  }
}

type IntrinsicAssetMetadata = Pick<AssetDescriptor, 'mediaType' | 'width' | 'height' | 'focalPoint' | 'crop'>

function uploadIntrinsicMetadata(upload: JsonObject, location: string): IntrinsicAssetMetadata {
  const width = optionalUploadDimension(upload.width, 'width', location)
  const height = optionalUploadDimension(upload.height, 'height', location)
  const focalPoint = uploadFocalPoint(upload, location)
  const crop = uploadCrop(upload, location)
  return {
    mediaType: mediaTypeFor(upload, location),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(focalPoint ? { focalPoint } : {}),
    ...(crop ? { crop } : {}),
  }
}

function indexUploads(value: unknown, location = 'uploads') {
  const result = new Map<string, JsonObject>()
  const add = (upload: unknown, entryLocation: string, fallbackId?: string) => {
    if (!isObject(upload)) throw new Error(`Payload upload at ${entryLocation} must be an object`)
    const explicitValue = upload.id ?? upload._id ?? upload.key
    if (
      explicitValue !== undefined &&
      typeof explicitValue !== 'string' &&
      typeof explicitValue !== 'number'
    )
      throw new Error(`Payload upload at ${entryLocation} has invalid id`)
    const explicitId =
      typeof explicitValue === 'string' || typeof explicitValue === 'number'
        ? String(explicitValue)
        : undefined
    const id = explicitId ?? fallbackId ?? uploadId(upload)
    if (!id) throw new Error(`Payload upload at ${entryLocation} is missing id`)
    if (result.has(id)) throw new Error(`Payload upload id ${id} is duplicated at ${entryLocation}`)
    result.set(id, explicitId ? upload : { ...upload, id })
  }
  if (value === undefined) return result
  if (Array.isArray(value)) {
    value.forEach((item, index) => add(item, `${location}[${index}]`))
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) add(item, `${location}.${key}`, key)
  } else throw new Error(`Payload uploads at ${location} must be an array or object`)
  return result
}

const LOCALIZED_UPLOAD_FIELDS = new Set(['alt', 'altText', 'alternativeText', 'title', 'caption', 'description'])

function withoutLocalizedUploadText(upload: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(upload).filter(([key]) => !LOCALIZED_UPLOAD_FIELDS.has(key)))
}

function nodeChildren(node: LexicalNode, location: string): LexicalNode[] {
  const fields = isObject(node.fields) ? node.fields : undefined
  const fieldContent = fields?.content
  const structuredFieldContent =
    Array.isArray(fieldContent) || isObject(fieldContent)
      ? fieldContent
      : undefined
  const children = node.children ?? fields?.children ?? structuredFieldContent
  if (children === undefined) return []
  let nested: unknown = children
  if (isObject(children) && isObject(children.root)) {
    if (children.root.type !== undefined && children.root.type !== 'root') throw new Error(`Payload rich text root type ${String(children.root.type)} is unsupported at ${location}`)
    nested = children.root.children
  } else if (isObject(children)) {
    if (children.type !== undefined && children.type !== 'root') throw new Error(`Payload rich text root type ${String(children.type)} is unsupported at ${location}`)
    nested = children.children
  }
  if (!Array.isArray(nested) || nested.length > MAX_CHILDREN || !nested.every(isObject)) throw new Error(`Payload Lexical children must be a bounded array of objects at ${location}`)
  return nested as LexicalNode[]
}

const SUPPORTED_STRING_FORMAT_FLAGS = new Set(['bold', 'italic', 'strike', 'strikethrough', 'underline', 'code', 'inlinecode', 'subscript', 'superscript'])

function formatFlags(format: unknown, location: string): Set<string> {
  const flags = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === 'string') {
      value
        .split(/[|,\s]+/u)
        .filter(Boolean)
        .forEach((part) => {
          const normalized = part.toLowerCase()
          if (!SUPPORTED_STRING_FORMAT_FLAGS.has(normalized)) throw new Error(`Unsupported Lexical text format ${part} at ${location}`)
          flags.add(normalized)
        })
    } else if (Array.isArray(value)) value.forEach(add)
    else if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0 || value > 0x7f) throw new Error(`Unsupported Lexical text format ${value} at ${location}`)
      const names = ['bold', 'italic', 'strikethrough', 'underline', 'code', 'subscript', 'superscript']
      names.forEach((name, index) => {
        if ((value & (2 ** index)) !== 0) flags.add(name)
      })
    } else if (value !== undefined && value !== null) throw new Error(`Unsupported Lexical text format ${String(value)} at ${location}`)
  }
  add(format)
  if (flags.has('subscript') && flags.has('superscript')) throw new Error(`Payload text cannot be both subscript and superscript at ${location}`)
  return flags
}

function textValue(node: LexicalNode, location: string) {
  const value = node.text !== undefined ? node.text : node.value
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Payload text node requires non-empty string text at ${location}`)
  return value
}

function codeTextFromChildren(node: LexicalNode, location: string) {
  const children = nodeChildren(node, location)
  if (!children.length) return undefined
  return children
    .map((child, index) => {
      const type = normalizeNodeType(child)
      const childLocation = `${location}.children[${index}]`
      if (type === 'linebreak') return '\n'
      if (type === 'text' || type === 'code-highlight')
        return textValue(child, childLocation)
      throw new Error(
        `Unsupported Payload code child ${type || 'unknown'} at ${childLocation}`,
      )
    })
    .join('')
}

function normalizeNodeType(node: LexicalNode) {
  return typeof node.type === 'string' ? node.type.toLowerCase() : ''
}

function hrefValue(node: LexicalNode, location: string) {
  const fields = isObject(node.fields) ? node.fields : undefined
  const href = node.url ?? node.href ?? fields?.url ?? fields?.href
  if (href === undefined) return undefined
  if (typeof href !== 'string' || !href.trim()) throw new Error(`Payload link href must be a non-empty string at ${location}`)
  return href.trim()
}

function lexicalRoot(value: unknown): LexicalNode[] {
  if (Array.isArray(value)) {
    if (value.length > MAX_CHILDREN || !value.every(isObject)) throw new Error('Payload rich text must contain only bounded Lexical node objects')
    return value as LexicalNode[]
  }
  if (!isObject(value)) throw new Error('Payload rich text must be a Lexical JSON object')
  const root = isObject(value.root) ? value.root : value
  if (root.type !== undefined && root.type !== 'root') throw new Error(`Payload rich text root type ${String(root.type)} is unsupported`)
  const children = (root as LexicalNode).children
  if (!Array.isArray(children) || children.length > MAX_CHILDREN || !children.every(isObject)) throw new Error('Payload rich text is missing Lexical root.children')
  return children as LexicalNode[]
}

function relationId(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (isObject(value)) {
    const id = value.id ?? value._id ?? value.value ?? value.target
    return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
  }
  return undefined
}

function graphSafeRelationshipTarget(target: string, location: string) {
  if (!GRAPH_SAFE_ID_PATTERN.test(target)) throw new Error(`Payload relationship target ${target} is not a graph-safe id at ${location}`)
  return target
}

function relationshipValues(
  state: AdapterState,
  node: LexicalNode,
  type: string,
  location: string,
  options: { allowChildren?: boolean } = {},
):
  | {
      target: string
      label: string
      role: PublicationInlineRun['semanticRole']
    }
  | undefined {
  const rawRelationType = node.relationType ?? node.relationshipType
  if (rawRelationType !== undefined && (typeof rawRelationType !== 'string' || !rawRelationType.trim())) throw new Error(`Payload relationship type must be a non-empty string at ${location}`)
  const relationType = typeof rawRelationType === 'string' ? rawRelationType : undefined
  const config = state.mapping.relationships[type] ?? (relationType ? state.mapping.relationships[relationType] : undefined)
  if (!config && type !== 'relationship') return undefined
  if (!options.allowChildren && nodeChildren(node, location).length) throw new Error(`Payload relationship children are unsupported at ${location}`)
  const target = relationId(
    config?.target ? readPath(node, config.target) : (node.value ?? node.target ?? node.fields),
  )
  if (!target) throw new Error(`Payload relationship is missing target at ${location}`)
  const rawLabel = config?.label ? readPath(node, config.label) : (node.label ?? node.text)
  if (config?.label && rawLabel === undefined) throw new Error(`Payload relationship label is missing at ${location}`)
  if (rawLabel !== undefined && (typeof rawLabel !== 'string' || !rawLabel.trim())) throw new Error(`Payload relationship label is empty or invalid at ${location}`)
  const label = rawLabel === undefined ? target : rawLabel.trim()
  const rawRole = config?.role ?? node.role
  const roles = new Set(['citation', 'cross-reference', 'affiliation-marker', 'bibliography-entry'])
  if (rawRole !== undefined && (typeof rawRole !== 'string' || !roles.has(rawRole))) throw new Error(`Payload relationship role is unsupported at ${location}`)
  const role = (rawRole ?? 'cross-reference') as PublicationInlineRun['semanticRole']
  return { target, label, role }
}

function statusValue(value: unknown): 'working' | 'review' | 'published' | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('Payload status must be a string at metadata')
  const status = value.toLowerCase()
  if (['draft', 'working', 'unpublished'].includes(status)) return 'working'
  if (['review', 'in-review', 'pending'].includes(status)) return 'review'
  if (['published', 'publish', 'live'].includes(status)) return 'published'
  throw new Error(`Payload publication has unsupported status: ${status}`)
}

function directionFor(locale: string): 'ltr' | 'rtl' | 'auto' {
  return /^(?:ar|fa|he|ur)(?:-|$)/iu.test(locale) ? 'rtl' : 'auto'
}

function dateValue(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`Payload ${field} is not a valid date string`)
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/u)
  if (!match) throw new Error(`Payload ${field} is not a valid date string`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || Number.isNaN(new Date(value).valueOf()))
    throw new Error(`Payload ${field} is not a valid date`)
  return `${match[1]}-${match[2]}-${match[3]}`
}

function sourceIdFor(documentId: string, locale: string) {
  return `payload:${sourceSafeId(documentId)}:${sourceSafeId(locale)}`
}

function localeVariantEntries(document: JsonObject, mapping: PayloadMappingPolicy) {
  const locales = mappedValue(document, mapping, 'locales')
  const entries: Array<{ locale: string; value: JsonObject }> = []
  const seen = new Set<string>()
  const baseLocale = pickLocale(document, mapping)
  const add = (rawLocale: unknown, value: unknown, location: string) => {
    if (!isObject(value)) throw new Error(`Payload locale variant at ${location} must be an object`)
    if (typeof rawLocale !== 'string' || !rawLocale.trim()) throw new Error(`Payload locale variant at ${location} is missing a locale`)
    const locale = canonicalLocale(rawLocale)
    const declaredValues = [value.locale, value.language, value.code].filter((candidate) => candidate !== undefined)
    for (const declared of declaredValues) {
      const declaredLocale = canonicalLocale(declared, `${location} locale`)
      if (declaredLocale !== locale) throw new Error(`Payload locale variant at ${location} declares ${declaredLocale}, which conflicts with map key ${locale}`)
    }
    if (locale === baseLocale || seen.has(locale)) throw new Error(`duplicate Payload locale variant ${locale}`)
    seen.add(locale)
    entries.push({ locale, value })
  }
  if (locales === undefined) return entries
  if (Array.isArray(locales)) {
    for (const [index, item] of locales.entries()) {
      const itemLocale = isObject(item) ? (item.locale ?? item.language ?? item.code) : undefined
      add(itemLocale, item, `locales[${index}]`)
    }
  } else if (isObject(locales)) {
    for (const [key, item] of Object.entries(locales)) add(key, item, `locales.${key}`)
  } else throw new Error('Payload locale variants must be an array or object')
  return entries
}

function getVariant(document: JsonObject, mapping: PayloadMappingPolicy, locale: string): JsonObject | undefined {
  return localeVariantEntries(document, mapping).find((entry) => entry.locale === locale)?.value
}

function pickLocale(document: JsonObject, mapping: PayloadMappingPolicy, requested?: string) {
  const configured = requested ?? mapping.locale
  const raw = configured ?? mappedValue(document, mapping, 'locale') ?? 'en'
  return canonicalLocale(raw)
}

function normalizeInput(input: unknown, mappingArgument?: unknown): { document: JsonObject; mapping: PayloadMappingPolicy; locale?: string } {
  assertSafeJson(input)
  if (!isObject(input)) throw new Error('Payload adapter input must be an export object')
  let document: unknown = input
  let mapping = mappingArgument
  let locale: string | undefined
  const requestedLocale = (value: unknown) => {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value.trim()) throw new Error('Payload requested locale must be a non-empty string')
    return value
  }
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(input, key)
  const outerHasDocumentIdentity = ['id', '_id', 'title', 'name'].some(hasOwn)
  const outerHasDocumentContent = ['content', 'body', 'richText'].some(hasOwn)
  const explicitDocumentWrapper = input.mapping !== undefined
  if (
    isObject(input.document) &&
    (explicitDocumentWrapper ||
      (!outerHasDocumentIdentity && !outerHasDocumentContent))
  ) {
    document = input.document
    mapping = mapping ?? input.mapping
    locale = requestedLocale(input.locale)
  } else if (
    isObject(input.data) &&
    (input.mapping !== undefined || (input.document === undefined && !('id' in input) && !('title' in input) && ('content' in input.data || 'title' in input.data || 'id' in input.data)))
  ) {
    document = input.data
    mapping = mapping ?? input.mapping
    locale = requestedLocale(input.locale)
  } else if (isObject(input.doc) && input.document === undefined && !('id' in input)) {
    document = input.doc
    mapping = mapping ?? input.mapping
    locale = requestedLocale(input.locale)
  }
  if (!isObject(document)) throw new Error('Payload adapter document must be an export object')
  return { document, mapping: parseMapping(mapping), locale }
}

type AdapterState = {
  document: JsonObject
  mapping: PayloadMappingPolicy
  documentId: string
  locale: string
  sourceId: string
  sourceRevision: string
  editionId: string
  nodes: PublicationNode[]
  assets: AssetDescriptor[]
  assetBytes: Map<string, Uint8Array>
  assetByteLength: number
  assetOriginBySha: Map<string, { location: string; intrinsic: IntrinsicAssetMetadata }>
  uploads: Map<string, JsonObject>
  diagnostics: AdapterDiagnostic[]
  usedIds: Set<string>
  pendingReferences: Map<string, { label: string; role?: PublicationInlineRun['semanticRole'] }>
  variantUploadIds?: Set<string>
  fallbackFrom?: string
}

function nodeId(state: AdapterState, node: LexicalNode, path: string, kind: string) {
  const explicitValue = node.id !== undefined ? node.id : node.nodeId !== undefined ? node.nodeId : node.key !== undefined ? node.key : isObject(node.fields) ? node.fields.id : undefined
  if (explicitValue !== undefined) {
    if (typeof explicitValue !== 'string' || !GRAPH_SAFE_ID_PATTERN.test(explicitValue)) throw new Error(`Payload source node id is invalid at ${sourceLocation(state.sourceId, path)}`)
    const explicit = explicitValue
    if (state.usedIds.has(explicit)) throw new Error(`Payload source node id is duplicated at ${sourceLocation(state.sourceId, path)}`)
    state.usedIds.add(explicit)
    return { id: explicit, origin: 'source' as const }
  }
  void kind
  const id = derivePayloadNodeId(state.documentId, path, node)
  let candidate = id
  let suffix = 1
  while (state.usedIds.has(candidate)) candidate = `${id}-${suffix++}`
  state.usedIds.add(candidate)
  return { id: candidate, origin: 'derived' as const }
}

function commonNode(state: AdapterState, id: string, origin: 'source' | 'derived', path: string, importance: 'essential' | 'supporting' | 'supplemental' = 'essential') {
  return {
    id,
    locale: state.locale,
    direction: directionFor(state.locale),
    requirement: 'required' as const,
    importance,
    provenance: {
      adapterId: PAYLOAD_LEXICAL_ADAPTER_ID,
      sourceId: state.sourceId,
      sourceRevision: state.sourceRevision,
      evidence: [sourceLocation(state.sourceId, path), ...(state.fallbackFrom ? [`locale-fallback:${state.fallbackFrom}->${state.locale}`] : [])],
      idOrigin: origin,
    },
    accessibility: { decorative: false },
    variants: [],
    permittedTransformationIds: [],
    edition: { editionId: state.editionId, sourceLocaleKey: state.locale },
  }
}

function appendInline(state: AdapterState, children: LexicalNode[], path: string, inherited: Partial<PublicationInlineRun> = {}, options: { skipTopLevelLists?: boolean } = {}) {
  let text = ''
  const inlineRuns: PublicationInlineRun[] = []
  const append = (value: string, style: Partial<PublicationInlineRun> = {}) => {
    if (!value) return
    const start = text.length
    text += value
    const marks = Object.fromEntries(Object.entries(style).filter(([key]) => !['start', 'end'].includes(key))) as Partial<PublicationInlineRun>
    if (Object.keys(marks).length) inlineRuns.push({ start, end: text.length, ...marks })
  }
  const visit = (
    node: LexicalNode,
    current: Partial<PublicationInlineRun>,
    nodePath: string,
    insideLink = false,
  ) => {
    const type = normalizeNodeType(node)
    if (type === 'text' || type === 'linebreak') {
      const location = sourceLocation(state.sourceId, nodePath)
      const flags = formatFlags(node.format, location)
      const style: Partial<PublicationInlineRun> = {
        ...current,
        ...(flags.has('bold') ? { bold: true } : {}),
        ...(flags.has('italic') ? { italic: true } : {}),
        ...(flags.has('underline') ? { underline: true } : {}),
        ...(flags.has('strikethrough') || flags.has('strike') ? { strikethrough: true } : {}),
        ...(flags.has('code') || flags.has('inlinecode') ? { inlineCode: true } : {}),
        ...(flags.has('subscript') ? { verticalAlign: 'subscript' as const } : {}),
        ...(flags.has('superscript') ? { verticalAlign: 'superscript' as const } : {}),
      }
      const value = type === 'linebreak' ? '\n' : textValue(node, location)
      append(value, {
        ...style,
        ...(type === 'linebreak' ? { hardBreak: true } : {}),
      })
      return
    }
    if (type === 'link' || type === 'autolink') {
      if (current.href || insideLink)
        throw new Error(
          `Payload link-producing node ${type} cannot be nested inside a link at ${sourceLocation(state.sourceId, nodePath)}`,
        )
      const location = sourceLocation(state.sourceId, nodePath)
      const href = hrefValue(node, location)
      const configuredRelationship = href
        ? undefined
        : relationshipValues(state, node, type, location, {
            allowChildren: true,
          })
      if (configuredRelationship) {
        const { target, role } = configuredRelationship
        const targetNodeId = graphSafeRelationshipTarget(target, location)
        const anchorBase = `relationship-${digest(`${state.sourceId}|${nodePath}|${targetNodeId}`).slice(0, 20)}`
        let relationshipId = anchorBase
        let suffix = 1
        while (relationshipId === targetNodeId || state.usedIds.has(relationshipId)) relationshipId = `${anchorBase}-${suffix++}`
        state.usedIds.add(relationshipId)
        const labelStart = text.length
        nodeChildren(node, location).forEach((child, index) =>
          visit(
            child,
            current,
            `${nodePath}.children[${index}]`,
            true,
          ),
        )
        const label = text.slice(labelStart)
        if (!label.trim()) throw new Error(`Payload link is empty at ${location}`)
        inlineRuns.push({
          start: labelStart,
          end: text.length,
          ...current,
          relationshipId,
          semanticRole: role,
          targetIds: [targetNodeId],
          href: `#${targetNodeId}`,
        })
        state.pendingReferences.set(targetNodeId, { label, role })
        return
      }
      if (!href) throw new Error(`Payload link is missing href at ${sourceLocation(state.sourceId, nodePath)}`)
      const labelStart = text.length
      nodeChildren(node, sourceLocation(state.sourceId, nodePath)).forEach((child, index) => visit(child, { ...current, href }, `${nodePath}.children[${index}]`, true))
      if (!text.slice(labelStart).trim()) throw new Error(`Payload link is empty at ${sourceLocation(state.sourceId, nodePath)}`)
      return
    }
    const configuredRelationship = relationshipValues(state, node, type, sourceLocation(state.sourceId, nodePath))
    if (configuredRelationship) {
      if (current.href || insideLink)
        throw new Error(
          `Payload link-producing node ${type} cannot be nested inside a link at ${sourceLocation(state.sourceId, nodePath)}`,
        )
      const { target, label, role } = configuredRelationship
      const targetNodeId = graphSafeRelationshipTarget(target, sourceLocation(state.sourceId, nodePath))
      const anchorBase = `relationship-${digest(`${state.sourceId}|${nodePath}|${targetNodeId}`).slice(0, 20)}`
      let relationshipId = anchorBase
      let suffix = 1
      while (relationshipId === targetNodeId || state.usedIds.has(relationshipId)) relationshipId = `${anchorBase}-${suffix++}`
      state.usedIds.add(relationshipId)
      state.pendingReferences.set(targetNodeId, {
        label,
        role,
      })
      append(label, {
        ...current,
        relationshipId,
        semanticRole: role,
        targetIds: [targetNodeId],
        href: `#${targetNodeId}`,
      })
      return
    }
    if (type === 'upload' || type === 'image' || type === 'media') {
      throw new Error(`Unsupported Lexical inline node ${type} at ${sourceLocation(state.sourceId, nodePath)}`)
    }
    if (type === 'list') throw new Error(`Unsupported Lexical inline node list at ${sourceLocation(state.sourceId, nodePath)}`)
    throw new Error(`Unsupported Lexical inline node ${type || 'unknown'} at ${sourceLocation(state.sourceId, nodePath)}`)
  }
  children.forEach((child, index) => {
    if (options.skipTopLevelLists && normalizeNodeType(child) === 'list') return
    visit(child, inherited, `${path}.children[${index}]`)
  })
  return { text, inlineRuns }
}

function addAsset(state: AdapterState, upload: JsonObject, path: string, accessibilityLabel?: string): string | undefined {
  const id = uploadId(upload)
  if (!id) throw new Error(`Payload upload is missing id at ${sourceLocation(state.sourceId, path)}`)
  const location = sourceLocation(state.sourceId, path)
  const fileName = uploadFileName(upload, location)
  const intrinsic = uploadIntrinsicMetadata(upload, location)
  const bytes = decodeBytes(upload.bytes ?? upload.data ?? upload.buffer ?? upload.base64, location)
  if (!bytes) {
    state.diagnostics.push({
      severity: 'warning',
      code: 'missing-asset',
      message: `Payload upload ${id} has no embedded bytes; no remote URL was fetched`,
      sourceId: state.sourceId,
    })
    return undefined
  }
  const hash = digest(bytes)
  const existing = state.assets.find((asset) => asset.sha256 === hash)
  if (existing) {
    const prior = state.assetOriginBySha.get(hash)
    if (!prior || stableStringify(prior.intrinsic) !== stableStringify(intrinsic))
      throw new Error(`Payload uploads at ${prior?.location ?? 'unknown'} and ${location} share bytes but disagree on intrinsic metadata`)
    const retainedFileName = [existing.fileName, fileName]
      .filter((value): value is string => Boolean(value))
      .sort()[0]
    if (retainedFileName) existing.fileName = retainedFileName
    return existing.id
  }
  const aggregateByteLength = state.assetByteLength + bytes.byteLength
  if (aggregateByteLength > MAX_EXPORT_BYTES)
    throw new Error(`Payload export exceeds cumulative byte bound at ${location}`)
  const descriptor: AssetDescriptor = {
    id: `asset-${hash.slice(0, 16)}`,
    sha256: hash,
    byteLength: bytes.byteLength,
    ...intrinsic,
    ...(fileName ? { fileName } : {}),
    accessibilityLabel,
  }
  state.assets.push(descriptor)
  state.assetBytes.set(descriptor.id, bytes)
  state.assetByteLength = aggregateByteLength
  state.assetOriginBySha.set(hash, { location, intrinsic })
  return descriptor.id
}

function rawUploadValue(node: LexicalNode) {
  const fields = isObject(node.fields) ? node.fields : undefined
  return node.value ?? node.upload ?? node.asset ?? fields?.upload ?? fields?.asset ?? node.id
}

function uploadFor(state: AdapterState, node: LexicalNode): JsonObject | undefined {
  const raw = rawUploadValue(node)
  const id = relationId(raw)
  if (isObject(raw)) return raw
  const upload = id ? state.uploads.get(id) : undefined
  if (!upload || state.variantUploadIds === undefined || state.variantUploadIds.has(String(id))) return upload
  return withoutLocalizedUploadText(upload)
}

function uploadAlternativeText(node: LexicalNode, upload: JsonObject | undefined, location: string) {
  const fields = isObject(node.fields) ? node.fields : undefined
  return optionalProse(node.alt ?? node.altText ?? fields?.alt ?? fields?.altText ?? upload?.alt ?? upload?.altText ?? upload?.alternativeText, 'upload alternative text', location)
}

function assertLocalizedUploadAlternative(state: AdapterState, node: LexicalNode, upload: JsonObject | undefined, path: string, alternativeText: string | undefined) {
  if (state.variantUploadIds === undefined || !upload || alternativeText) return
  const id = relationId(rawUploadValue(node)) ?? uploadId(upload) ?? 'unknown'
  throw new Error(`Payload locale ${state.locale} upload ${id} is missing localized alternative text at ${sourceLocation(state.sourceId, path)}`)
}

function headingLevel(node: LexicalNode, location: string) {
  const fields = isObject(node.fields) ? node.fields : undefined
  if (node.level !== undefined && fields?.level !== undefined && node.level !== fields.level) throw new Error(`Payload heading has invalid level or tag at ${location}`)
  if (node.tag !== undefined && fields?.tag !== undefined && node.tag !== fields.tag) throw new Error(`Payload heading has invalid level or tag at ${location}`)
  const rawLevel = node.level ?? fields?.level
  const rawTag = node.tag ?? fields?.tag
  let level: number | undefined
  if (rawLevel !== undefined) {
    if (typeof rawLevel !== 'number' || !Number.isInteger(rawLevel) || rawLevel < 1 || rawLevel > 6) throw new Error(`Payload heading has invalid level or tag at ${location}`)
    level = rawLevel
  }
  if (rawTag !== undefined) {
    if (typeof rawTag !== 'string' || !/^h[1-6]$/iu.test(rawTag)) throw new Error(`Payload heading has invalid level or tag at ${location}`)
    const tagLevel = Number(rawTag.slice(1))
    if (level !== undefined && level !== tagLevel) throw new Error(`Payload heading has invalid level or tag at ${location}`)
    level = tagLevel
  }
  return level ?? 2
}

function addTextNode(state: AdapterState, node: LexicalNode, path: string, type: 'paragraph' | 'heading' | 'quote' | 'aside') {
  const identity = nodeId(state, node, path, type)
  const location = sourceLocation(state.sourceId, path)
  const inline = appendInline(state, nodeChildren(node, location), path)
  const fields = isObject(node.fields) ? node.fields : undefined
  const directText = optionalProse(node.text ?? fields?.text, `${type} text`, location)
  const rawContent = fields?.content
  const contentText =
    rawContent === undefined || Array.isArray(rawContent) || isObject(rawContent)
      ? undefined
      : optionalProse(rawContent, `${type} text`, location)
  if (
    (inline.text && (directText || contentText)) ||
    (directText && contentText)
  )
    throw new Error(
      `Payload ${type} has conflicting inline and direct text at ${location}`,
    )
  const text = inline.text || directText || contentText || ''
  if (!text.trim()) throw new Error(`Payload ${type} is empty at ${location}`)
  const common = commonNode(state, identity.id, identity.origin, path)
  if (type === 'heading') {
    const level = headingLevel(node, location)
    return {
      ...common,
      type,
      level,
      text,
      inlineRuns: inline.inlineRuns,
    } as PublicationNode
  }
  if (type === 'quote') {
    const rawAttribution = node.attribution ?? fields?.attribution
    if (rawAttribution !== undefined && (typeof rawAttribution !== 'string' || !rawAttribution.trim())) throw new Error(`Payload quote attribution is invalid at ${location}`)
    return {
      ...common,
      type,
      text,
      inlineRuns: inline.inlineRuns,
      ...(rawAttribution !== undefined ? { attribution: rawAttribution } : {}),
    } as PublicationNode
  }
  return {
    ...common,
    type,
    text,
    inlineRuns: inline.inlineRuns,
  } as PublicationNode
}

function addUploadNode(state: AdapterState, node: LexicalNode, path: string, resolved?: { upload?: JsonObject; assetId?: string }): PublicationNode {
  const identity = nodeId(state, node, path, 'figure')
  const upload = resolved ? resolved.upload : uploadFor(state, node)
  const fields = isObject(node.fields) ? node.fields : undefined
  const location = sourceLocation(state.sourceId, path)
  const alt = uploadAlternativeText(node, upload, location)
  assertLocalizedUploadAlternative(state, node, upload, path, alt)
  const rawTitle = node.title ?? fields?.title ?? upload?.title
  const title = optionalProse(rawTitle, 'upload title', location) ?? alt ?? (upload ? uploadFileName(upload, location) : undefined) ?? 'Untitled upload'
  if (upload && !resolved && !mediaTypeFor(upload, location).startsWith('image/')) throw new Error(`Payload figure requires image media at ${location}`)
  const assetId = resolved ? resolved.assetId : upload ? addAsset(state, upload, path, alt) : undefined
  if (assetId && !alt) throw new Error(`Payload upload requires non-empty alternative text at ${location}`)
  if (!upload) {
    state.diagnostics.push({
      severity: 'warning',
      code: 'missing-asset',
      message: `Payload upload is incomplete at ${sourceLocation(state.sourceId, path)}`,
      sourceId: state.sourceId,
      nodeId: identity.id,
    })
  }
  return {
    ...commonNode(state, identity.id, identity.origin, path),
    type: 'figure',
    title,
    assetIds: assetId ? [assetId] : [],
    sourceText: assetId ? undefined : `Missing local asset: ${title}`,
    accessibility: {
      decorative: false,
      alternativeText: alt ?? title,
    },
  } as PublicationNode
}

function addTableNode(state: AdapterState, node: LexicalNode, path: string): PublicationNode {
  const identity = nodeId(state, node, path, 'table')
  const fields = isObject(node.fields) ? node.fields : undefined
  const rawRows = node.rows ?? fields?.rows
  if (!Array.isArray(rawRows) || !rawRows.length) throw new Error(`Payload table is missing rows at ${sourceLocation(state.sourceId, path)}`)
  const usedCellIds = new Set<string>()
  const rows = rawRows.map((rawRow, rowIndex) => {
    const row = isObject(rawRow) ? rawRow : { cells: rawRow }
    const rawCells = row.cells
    if (!Array.isArray(rawCells) || !rawCells.length) throw new Error(`Payload table row ${rowIndex} is empty at ${sourceLocation(state.sourceId, path)}`)
    return {
      cells: rawCells.map((rawCell, cellIndex) => {
        const location = sourceLocation(state.sourceId, `${path}.rows[${rowIndex}].cells[${cellIndex}]`)
        const cell: JsonObject = isObject(rawCell) ? rawCell : { text: rawCell }
        for (const field of ['header', 'isHeader']) {
          if (cell[field] !== undefined && typeof cell[field] !== 'boolean') throw new Error(`Payload table cell ${field} must be boolean at ${location}`)
        }
        if (cell.header !== undefined && cell.isHeader !== undefined && cell.header !== cell.isHeader) throw new Error(`Payload table cell header declarations conflict at ${location}`)
        if (cell.headerScope !== undefined && cell.headerScope !== null && cell.headerScope !== 'column' && cell.headerScope !== 'row')
          throw new Error(`Payload table cell headerScope is invalid at ${location}`)
        const declaredHeader = (cell.header ?? cell.isHeader) as boolean | undefined
        if (declaredHeader !== undefined && declaredHeader !== (cell.headerScope === 'column' || cell.headerScope === 'row') && cell.headerScope !== undefined)
          throw new Error(`Payload table cell header declarations conflict at ${location}`)
        const span = (value: unknown, field: string) => {
          if (value === undefined) return 1
          if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1_000) throw new Error(`Payload table cell ${field} must be a positive integer at ${location}`)
          return Number(value)
        }
        const rawId = cell.id ?? cell.key
        if (rawId !== undefined && (typeof rawId !== 'string' || !GRAPH_SAFE_ID_PATTERN.test(rawId))) throw new Error(`Payload table cell id is invalid at ${location}`)
        if (typeof rawId === 'string' && usedCellIds.has(rawId)) throw new Error(`Payload table cell id is duplicated at ${location}`)
        if (typeof rawId === 'string') usedCellIds.add(rawId)
        const rawText = cell.text ?? cell.value ?? cell.content
        if (rawText !== undefined && typeof rawText !== 'string') throw new Error(`Payload table cell text must be a string at ${location}`)
        if (cell.headerIds !== undefined) {
          if (!Array.isArray(cell.headerIds) || !cell.headerIds.every((headerId) => typeof headerId === 'string' && GRAPH_SAFE_ID_PATTERN.test(headerId)))
            throw new Error(`Payload table cell headerIds must be graph-safe ids at ${location}`)
        }
        const headerScope = cell.headerScope === 'row' || cell.headerScope === 'column' ? cell.headerScope : declaredHeader ? 'column' : null
        return {
          ...(typeof rawId === 'string' ? { id: rawId } : {}),
          text: rawText ?? '',
          headerScope,
          columnSpan: span(cell.colSpan ?? cell.columnSpan, 'columnSpan'),
          rowSpan: span(cell.rowSpan, 'rowSpan'),
          ...(Array.isArray(cell.headerIds) ? { headerIds: cell.headerIds } : {}),
        }
      }),
    }
  })
  return {
    ...commonNode(state, identity.id, identity.origin, path),
    type: 'table',
    rows,
  } as PublicationNode
}

function addEquationNode(state: AdapterState, node: LexicalNode, path: string): PublicationNode {
  const identity = nodeId(state, node, path, 'equation')
  const fields = isObject(node.fields) ? node.fields : undefined
  const location = sourceLocation(state.sourceId, path)
  const rawSource = node.source ?? node.latex ?? node.value ?? fields?.source ?? fields?.latex
  if (typeof rawSource !== 'string' || !rawSource.trim()) throw new Error(`Payload equation is empty at ${location}`)
  const source = rawSource
  const rawFormat = node.format ?? fields?.format
  let format: 'latex' | 'plain-text' = 'latex'
  if (rawFormat !== undefined) {
    if (typeof rawFormat !== 'string' || !['latex', 'plain-text'].includes(rawFormat.toLowerCase())) throw new Error(`Payload equation has unsupported format ${String(rawFormat)} at ${location}`)
    format = rawFormat.toLowerCase() as typeof format
  }
  const label = optionalProse(node.label ?? fields?.label, 'equation label', location)
  return {
    ...commonNode(state, identity.id, identity.origin, path),
    type: 'equation',
    source,
    format,
    ...(label ? { label } : {}),
  } as PublicationNode
}

function addMediaNode(state: AdapterState, node: LexicalNode, path: string): PublicationNode {
  const location = sourceLocation(state.sourceId, path)
  const upload = uploadFor(state, node)
  const mediaType = upload ? mediaTypeFor(upload, location) : undefined
  const rawKind = node.mediaKind ?? node.kind ?? (isObject(node.fields) ? node.fields.kind : undefined)
  const inferredKind = mediaType?.startsWith('image/') ? 'image' : mediaType?.startsWith('audio/') ? 'audio' : mediaType?.startsWith('video/') ? 'video' : undefined
  let mediaKind: 'image' | 'audio' | 'video' | 'interactive'
  if (rawKind !== undefined) {
    if (typeof rawKind !== 'string' || !['image', 'audio', 'video', 'interactive'].includes(rawKind.toLowerCase()))
      throw new Error(`Payload media has unsupported kind ${String(rawKind)} at ${location}`)
    mediaKind = rawKind.toLowerCase() as typeof mediaKind
    if (inferredKind && mediaKind !== 'interactive' && mediaKind !== inferredKind) throw new Error(`Payload media kind ${mediaKind} contradicts ${mediaType} at ${location}`)
  } else if (inferredKind) mediaKind = inferredKind
  else if (!upload) mediaKind = 'image'
  else throw new Error(`Payload media kind cannot be inferred from ${mediaType} at ${location}`)
  if (
    mediaType &&
    mediaKind !== 'interactive' &&
    !mediaType.startsWith(`${mediaKind}/`)
  )
    throw new Error(
      `Payload media kind ${mediaKind} contradicts ${mediaType} at ${location}`,
    )
  const alt = uploadAlternativeText(node, upload, location)
  assertLocalizedUploadAlternative(state, node, upload, path, alt)
  const assetId = upload ? addAsset(state, upload, path, alt) : undefined
  if (!assetId && (mediaKind === 'audio' || mediaKind === 'video'))
    throw new Error(
      `Payload ${mediaKind} media has no embedded bytes at ${location}`,
    )
  if (!assetId) return addUploadNode(state, node, path, { upload, assetId })
  if (!alt) throw new Error(`Payload media requires non-empty alternative text at ${location}`)
  const identity = nodeId(state, node, path, 'media')
  return {
    ...commonNode(state, identity.id, identity.origin, path),
    type: 'media',
    mediaKind,
    assetId,
    accessibility: {
      decorative: false,
      ...(alt ? { alternativeText: alt } : {}),
    },
  } as PublicationNode
}

function listOrdering(node: LexicalNode, location: string) {
  const declarations: boolean[] = []
  if (node.listType !== undefined) {
    if (typeof node.listType !== 'string') throw new Error(`Payload list type must be a string at ${location}`)
    const listType = node.listType.toLowerCase()
    if (!['bullet', 'number', 'unordered', 'ordered'].includes(listType)) throw new Error(`Payload list type ${node.listType} is unsupported at ${location}`)
    declarations.push(listType === 'number' || listType === 'ordered')
  }
  if (node.tag !== undefined) {
    if (typeof node.tag !== 'string' || !['ul', 'ol'].includes(node.tag.toLowerCase())) throw new Error(`Payload list tag is unsupported at ${location}`)
    declarations.push(node.tag.toLowerCase() === 'ol')
  }
  if (node.ordered !== undefined) {
    if (typeof node.ordered !== 'boolean') throw new Error(`Payload list ordered must be boolean at ${location}`)
    declarations.push(node.ordered)
  }
  if (new Set(declarations).size > 1) throw new Error(`Payload list ordering declarations conflict at ${location}`)
  const ordered = declarations[0] ?? false
  if (
    node.start !== undefined &&
    (!Number.isInteger(node.start) || Number(node.start) < 1 || (!ordered && node.start !== 1))
  )
    throw new Error(`Payload list start is invalid at ${location}`)
  return ordered
}

function addList(state: AdapterState, node: LexicalNode, path: string): PublicationNode[] {
  const ordered = listOrdering(node, sourceLocation(state.sourceId, path))
  const listIdentity = nodeId(state, node, path, 'list')
  const items = nodeChildren(node, sourceLocation(state.sourceId, path))
  if (!items.length) throw new Error(`Payload list is empty at ${sourceLocation(state.sourceId, path)}`)
  items.forEach((item, index) => {
    const itemType = normalizeNodeType(item)
    if (itemType !== 'listitem' && itemType !== 'list-item')
      throw new Error(`Payload list child ${itemType || 'unknown'} must be listitem at ${sourceLocation(state.sourceId, `${path}.children[${index}]`)}`)
    if (item.checked !== undefined) throw new Error(`Payload checklist item is unsupported at ${sourceLocation(state.sourceId, `${path}.children[${index}]`)}`)
  })
  const itemIdentities = items.map((item, index) => nodeId(state, item, `${path}.children[${index}]`, 'item'))
  const itemIds = itemIdentities.map((identity) => identity.id)
  const list = {
    ...commonNode(state, listIdentity.id, listIdentity.origin, path),
    type: 'list',
    ordered,
    ...(ordered && node.start !== undefined ? { start: Number(node.start) } : {}),
    itemIds,
  } as PublicationNode
  const result: PublicationNode[] = [list]
  items.forEach((item, index) => {
    const itemPath = `${path}.children[${index}]`
    const identity = itemIdentities[index]
    const itemChildren = nodeChildren(item, sourceLocation(state.sourceId, itemPath))
    let nestedListSeen = false
    itemChildren.forEach((child, childIndex) => {
      if (normalizeNodeType(child) === 'list') nestedListSeen = true
      else if (nestedListSeen) throw new Error(`Payload listitem content after a nested list is unsupported at ${sourceLocation(state.sourceId, `${itemPath}.children[${childIndex}]`)}`)
    })
    const inline = appendInline(state, itemChildren, itemPath, {}, { skipTopLevelLists: true })
    const childLists: PublicationNode[] = []
    const childListIds: string[] = []
    itemChildren.forEach((child, childIndex) => {
      if (normalizeNodeType(child) === 'list') {
        const nestedNodes = addList(state, child, `${itemPath}.children[${childIndex}]`)
        childListIds.push(nestedNodes[0]!.id)
        childLists.push(...nestedNodes)
      }
    })
    const itemFields = isObject(item.fields) ? item.fields : undefined
    const directText = optionalProse(item.text ?? itemFields?.text, 'listitem text', sourceLocation(state.sourceId, itemPath))
    if (inline.text && directText) throw new Error(`Payload listitem has conflicting inline and direct text at ${sourceLocation(state.sourceId, itemPath)}`)
    const itemText = inline.text || directText || ''
    if (!itemText.trim() && !childListIds.length) throw new Error(`Payload listitem is empty at ${sourceLocation(state.sourceId, itemPath)}`)
    result.push({
      ...commonNode(state, identity.id, identity.origin, itemPath),
      type: 'list-item',
      parentListId: listIdentity.id,
      childListIds,
      text: itemText || ' ',
      inlineRuns: inline.inlineRuns,
    } as PublicationNode)
    result.push(...childLists)
  })
  return result
}

function addBlock(state: AdapterState, node: LexicalNode, path: string): PublicationNode[] {
  const type = normalizeNodeType(node)
  if (type === 'paragraph') return [addTextNode(state, node, path, 'paragraph')]
  if (type === 'heading') return [addTextNode(state, node, path, 'heading')]
  if (type === 'quote' || type === 'blockquote') return [addTextNode(state, node, path, 'quote')]
  if (type === 'list') return addList(state, node, path)
  if (type === 'code') {
    const identity = nodeId(state, node, path, 'code')
    const fields = isObject(node.fields) ? node.fields : undefined
    const location = sourceLocation(state.sourceId, path)
    const rawCode =
      codeTextFromChildren(node, location) ??
      node.code ??
      node.text ??
      node.value ??
      fields?.code ??
      fields?.text
    if (typeof rawCode !== 'string' || !rawCode.trim()) throw new Error(`Payload code must be a non-empty string at ${location}`)
    const language = optionalProse(node.language ?? fields?.language, 'code language', location)
    return [
      {
        ...commonNode(state, identity.id, identity.origin, path),
        type: 'code',
        code: rawCode,
        ...(language ? { language } : {}),
      } as PublicationNode,
    ]
  }
  if (type === 'upload' || type === 'image') return [addUploadNode(state, node, path)]
  if (type === 'media') return [addMediaNode(state, node, path)]
  if (type === 'relationship') {
    const configured = relationshipValues(state, node, type, sourceLocation(state.sourceId, path))
    if (!configured) throw new Error(`Payload relationship is missing target at ${sourceLocation(state.sourceId, path)}`)
    const { target, label, role } = configured
    if (role !== 'cross-reference') throw new Error(`Payload block relationship role ${role} is unsupported at ${sourceLocation(state.sourceId, path)}`)
    const id = graphSafeRelationshipTarget(target, sourceLocation(state.sourceId, path))
    const identity = nodeId(state, node, path, 'reference')
    state.pendingReferences.set(id, { label, role })
    return [
      {
        ...commonNode(state, identity.id, identity.origin, path),
        type: 'reference',
        targetIds: [id],
        text: label,
        href: `#${id}`,
      } as PublicationNode,
    ]
  }
  const configuredRelationship = relationshipValues(state, node, type, sourceLocation(state.sourceId, path))
  if (configuredRelationship) {
    const { target, label, role } = configuredRelationship
    if (role !== 'cross-reference') throw new Error(`Payload block relationship role ${role} is unsupported at ${sourceLocation(state.sourceId, path)}`)
    const id = graphSafeRelationshipTarget(target, sourceLocation(state.sourceId, path))
    const identity = nodeId(state, node, path, 'reference')
    state.pendingReferences.set(id, { label, role })
    return [
      {
        ...commonNode(state, identity.id, identity.origin, path),
        type: 'reference',
        targetIds: [id],
        text: label,
        href: `#${id}`,
      } as PublicationNode,
    ]
  }
  const fields = isObject(node.fields) ? node.fields : undefined
  const rawConfiguredName = fields?.blockType ?? fields?.type ?? node.blockType ?? node.blockName
  if (type === 'block' && rawConfiguredName !== undefined && (typeof rawConfiguredName !== 'string' || !rawConfiguredName.trim()))
    throw new Error(`Payload configured block type must be a non-empty string at ${sourceLocation(state.sourceId, path)}`)
  const configuredName = type === 'block' && typeof rawConfiguredName === 'string' ? rawConfiguredName : type
  const mapped = (configuredName ? state.mapping.blocks[configuredName] : undefined) ?? state.mapping.blocks[type]
  if (mapped === 'paragraph' || mapped === 'heading' || mapped === 'quote' || mapped === 'aside') return [addTextNode(state, node, path, mapped)]
  if (mapped === 'figure') return [addUploadNode(state, node, path)]
  if (mapped === 'media') return [addMediaNode(state, node, path)]
  if (mapped === 'table') return [addTableNode(state, node, path)]
  if (mapped === 'equation') return [addEquationNode(state, node, path)]
  if (mapped === 'code') return addBlock(state, { ...node, type: 'code' }, path)
  if (mapped === 'reference') return addBlock(state, { ...node, type: 'relationship' }, path)
  throw new Error(`Unsupported Lexical node ${type || 'unknown'} at ${sourceLocation(state.sourceId, path)}`)
}

function makeAssetBundle(state: AdapterState): AssetBundle {
  return createAssetBundle({ version: '1.0.0', assets: state.assets }, async (descriptor) => {
    const bytes = state.assetBytes.get(descriptor.id)
    if (!bytes) throw new Error(`Asset ${descriptor.id} is unavailable in the local Payload export`)
    return bytes
  })
}

function buildState(document: JsonObject, mapping: PayloadMappingPolicy, requestedLocale?: string): AdapterState {
  const documentId = requiredPayloadId(mappedValue(document, mapping, 'id'))
  const locale = pickLocale(document, mapping, requestedLocale)
  const sourceId = sourceIdFor(documentId, locale)
  const sourceRevision = digest(stableStringify(document))
  const editionId = sourceSafeId(`${documentId}:${locale}`)
  return {
    document,
    mapping,
    documentId,
    locale,
    sourceId,
    sourceRevision,
    editionId,
    nodes: [],
    assets: [],
    assetBytes: new Map(),
    assetByteLength: 0,
    assetOriginBySha: new Map(),
    uploads: indexUploads(mappedValue(document, mapping, 'uploads'), 'uploads'),
    diagnostics: [],
    usedIds: new Set(),
    pendingReferences: new Map(),
  }
}

function buildResult(state: AdapterState): PublicationSourceResult {
  const selectedVariant = getVariant(state.document, state.mapping, state.locale)
  if (selectedVariant && mappedValue(selectedVariant, state.mapping, 'content') === undefined) throw new Error(`Payload locale ${state.locale} is missing mapped Lexical content`)
  const localizedSource = selectedVariant ?? state.document
  const inheritedMappedValue = (field: string) => {
    const localized = selectedVariant
      ? mappedValue(selectedVariant, state.mapping, field)
      : undefined
    return localized !== undefined
      ? localized
      : mappedValue(state.document, state.mapping, field)
  }
  if (selectedVariant) {
    const variantUploads = indexUploads(mappedValue(selectedVariant, state.mapping, 'uploads'), `localeVariants.${state.locale}.uploads`)
    state.variantUploadIds = new Set(variantUploads.keys())
    for (const [id, upload] of variantUploads) {
      const baseUpload = state.uploads.get(id)
      state.uploads.set(id, {
        ...(baseUpload ? withoutLocalizedUploadText(baseUpload) : {}),
        ...upload,
      })
    }
  }
  const content = mappedValue(localizedSource, state.mapping, 'content')
  if (content === undefined) throw new Error(`Payload publication ${state.documentId} is missing mapped Lexical content`)
  const rootNodes = lexicalRoot(content)
  if (!rootNodes.length) throw new Error(`Payload Lexical content is empty at ${sourceLocation(state.sourceId, 'content.root')}`)
  for (const [index, node] of rootNodes.entries()) state.nodes.push(...addBlock(state, node, `content.root.children[${index}]`))
  for (const [targetId, info] of state.pendingReferences) {
    if (state.nodes.some((node) => node.id === targetId)) continue
    const identity = nodeId(state, { id: targetId, type: 'reference' }, `relationship.${targetId}`, 'reference')
    state.nodes.push({
      ...commonNode(state, identity.id, identity.origin, `relationship.${targetId}`, 'supporting'),
      type: 'reference',
      targetIds: [],
      text: info.label,
    } as PublicationNode)
  }
  const title = requiredProse(mappedValue(localizedSource, state.mapping, 'title'), 'title')
  const description = optionalProse(mappedValue(localizedSource, state.mapping, 'description'), 'description')
  const contributorsValue = mappedValue(localizedSource, state.mapping, 'authors')
  const contributors = Array.isArray(contributorsValue)
    ? contributorsValue.map((author, index) => contributorName(author, `authors[${index}]`))
    : contributorsValue === undefined
      ? []
      : [contributorName(contributorsValue, 'authors')]
  const rawVersion = inheritedMappedValue('version')
  const version = optionalProse(rawVersion, 'version')
  const created = dateValue(inheritedMappedValue('created'), 'created')
  const modified = dateValue(inheritedMappedValue('modified'), 'modified')
  const rawKeywords = mappedValue(localizedSource, state.mapping, 'keywords')
  if (rawKeywords !== undefined && !Array.isArray(rawKeywords)) throw new Error('Payload keywords must be an array at metadata')
  const keywords = (rawKeywords ?? []).map((keyword, index) => requiredProse(keyword, 'keyword', `keywords[${index}]`))
  const status = statusValue(inheritedMappedValue('status'))
  const metadata = {
    title,
    ...(description ? { abstract: description } : {}),
    contributors,
    ...(status ? { status } : {}),
    ...(version ? { sourceDocumentVersion: version } : {}),
    ...(created ? { created } : {}),
    ...(modified ? { modified } : {}),
    defaultLocale: state.locale,
    defaultDirection: directionFor(state.locale),
    keywords,
  }
  const graph = publicationGraphSchema.parse({
    version: PUBLICATION_GRAPH_VERSION,
    id: sourceSafeId(state.documentId),
    metadata,
    edition: {
      id: state.editionId,
      locale: state.locale,
      direction: directionFor(state.locale),
    },
    nodes: state.nodes,
  })
  return validatePublicationSourceResult({
    graph,
    assetBundle: makeAssetBundle(state),
    diagnostics: state.diagnostics,
    provenance: {
      adapterId: PAYLOAD_LEXICAL_ADAPTER_ID,
      adapterVersion: PUBLICATION_SOURCE_ADAPTER_VERSION,
      sourceType: 'payload',
      sourceId: state.sourceId,
      sourceRevision: state.sourceRevision,
      mappingVersion: state.mapping.version,
    },
  })
}

/** Adapt one locale of a decoded Payload export.  This function never reads a URL or invokes Payload code. */
export function adaptPayloadLexical(input: unknown, mappingArgument?: unknown): PublicationSourceResult {
  const normalized = normalizeInput(input, mappingArgument)
  const state = buildState(normalized.document, normalized.mapping, normalized.locale)
  const requestedLocale = canonicalLocale(normalized.locale ?? state.locale)
  const availableVariant = getVariant(normalized.document, normalized.mapping, state.locale)
  if (!availableVariant && requestedLocale !== pickLocale(normalized.document, normalized.mapping)) {
    const fallback = normalized.mapping.fallbackLocale
    if (!fallback) throw new Error(`Payload locale ${requestedLocale} is unavailable; configure an explicit fallbackLocale`)
    const fallbackLocale = canonicalLocale(fallback, 'fallbackLocale')
    const baseLocale = pickLocale(normalized.document, normalized.mapping)
    if (fallbackLocale !== baseLocale && !getVariant(normalized.document, normalized.mapping, fallbackLocale)) throw new Error(`Payload fallback locale ${fallbackLocale} is unavailable`)
    state.locale = fallbackLocale
    state.fallbackFrom = requestedLocale
    state.sourceId = sourceIdFor(state.documentId, fallbackLocale)
    state.editionId = sourceSafeId(`${state.documentId}:${fallbackLocale}`)
    state.diagnostics.push({
      severity: 'warning',
      code: 'locale-fallback',
      message: `Locale ${requestedLocale} was unavailable; used ${fallbackLocale}`,
      sourceId: state.sourceId,
    })
  }
  return buildResult(state)
}

/** Build every declared locale as separate linked editions. */
export function adaptPayloadLexicalEditions(input: unknown, mappingArgument?: unknown): PublicationSourceResult[] {
  const normalized = normalizeInput(input, mappingArgument)
  const values: string[] = [pickLocale(normalized.document, normalized.mapping)]
  values.push(...localeVariantEntries(normalized.document, normalized.mapping).map((entry) => entry.locale))
  const results = [...new Set(values)].map((locale) =>
    adaptPayloadLexical({
      document: normalized.document,
      mapping: normalized.mapping,
      locale,
    }),
  )
  const canonical = results[0]
  if (canonical) {
    const canonicalByStableId = new Map(canonical.graph.nodes.filter((node) => node.provenance.idOrigin === 'source').map((node) => [node.id, node]))
    for (const result of results.slice(1)) {
      const nodes = result.graph.nodes.map((node) => {
        const equivalent = node.provenance.idOrigin === 'source' ? canonicalByStableId.get(node.id) : undefined
        return {
          ...node,
          edition: {
            ...node.edition,
            ...(equivalent?.type === node.type ? { equivalentNodeId: equivalent.id } : {}),
          },
        }
      })
      result.graph = publicationGraphSchema.parse({ ...result.graph, nodes })
    }
  }
  return results
}

export const payloadLexicalSourceAdapter: PublicationSourceAdapter<PayloadAdapterInput | unknown> = {
  id: PAYLOAD_LEXICAL_ADAPTER_ID,
  version: PUBLICATION_SOURCE_ADAPTER_VERSION,
  adapt: (input) => adaptPayloadLexical(input),
}

// Friendly aliases used by source registries and downstream integrations.
export const payloadPublicationAdapter = payloadLexicalSourceAdapter
export const payloadLexicalAdapter = payloadLexicalSourceAdapter
export const payloadAdapter = payloadLexicalSourceAdapter
export const adaptPayloadExport = adaptPayloadLexical
export const adaptPayloadDocument = adaptPayloadLexical
export const adaptPayloadLexicalDocument = adaptPayloadLexical
export const parsePayloadMappingPolicy = parseMapping
