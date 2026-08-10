import { createHash } from 'node:crypto'
import {
  createAssetBundle,
  type AssetDescriptor,
  type AssetBundle,
} from '../asset-bundle'
import {
  PUBLICATION_GRAPH_VERSION,
  publicationGraphSchema,
  type PublicationInlineRun,
  type PublicationNode,
} from '../schema'
import {
  PUBLICATION_SOURCE_ADAPTER_VERSION,
  validatePublicationSourceResult,
  type AdapterDiagnostic,
  type PublicationSourceAdapter,
  type PublicationSourceResult,
} from '../source-adapter'
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
const pathSchema = z.union([
  pathPartSchema,
  z.array(pathPartSchema).min(1).max(32),
])

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

const blockMappingSchema = z
  .record(pathPartSchema, z.enum([
    'paragraph',
    'heading',
    'quote',
    'code',
    'aside',
    'figure',
    'table',
    'equation',
    'media',
    'reference',
  ]))
  .default({})

const relationshipMappingSchema = z
  .record(
    pathPartSchema,
    z
      .object({
        target: pathSchema.optional(),
        label: pathSchema.optional(),
        role: z
          .enum([
            'citation',
            'cross-reference',
            'affiliation-marker',
            'bibliography-entry',
          ])
          .optional(),
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
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint')
    throw new Error(`Payload export contains executable value at ${path}`)
  if (Array.isArray(value)) {
    if (value.length > MAX_CHILDREN)
      throw new Error(`Payload export exceeds collection bound at ${path}`)
    value.forEach((child, index) => assertSafeJson(child, `${path}[${index}]`, depth + 1))
    return
  }
  if (!isObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      throw new Error(`Payload export contains unsafe key ${key} at ${path}`)
    if (/^(?:hook|hooks|resolver|resolvers|callback|callbacks|function|execute)$/iu.test(key))
      throw new Error(`Payload export cannot contain executable mapping key ${key} at ${path}`)
    assertSafeJson(child, `${path}.${key}`, depth + 1)
  }
}

function parseMapping(value: unknown): PayloadMappingPolicy {
  assertSafeJson(value ?? {})
  const raw = isObject(value) ? value : {}
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
  return payloadMappingPolicySchema.parse(normalized)
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

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (isObject(value)) {
    for (const key of ['text', 'name', 'label', 'title', 'value', 'fullName']) {
      const nested = asText(value[key])
      if (nested) return nested
    }
  }
  return undefined
}

function requiredText(value: unknown, field: string): string {
  const text = asText(value)?.trim()
  if (!text) throw new Error(`Payload publication is missing required ${field}`)
  return text
}

function canonicalLocale(value: unknown, field = 'locale') {
  const raw = requiredText(value, field)
  let locale: string
  try {
    locale = Intl.getCanonicalLocales(raw)[0]
  } catch {
    throw new Error(`Payload publication has invalid ${field}: ${raw}`)
  }
  return locale
}

function sourceSafeId(value: string) {
  return value.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '') || 'document'
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
  return `derived-${sourceSafeId(documentId)}-${digest(`${documentId}|${structuralPath}|${stableStringify(node)}`).slice(0, 20)}`
}

function sourceLocation(sourceId: string, path: string) {
  return `${sourceId}:${path}`
}

function decodeBytes(value: unknown, path: string): Uint8Array | undefined {
  if (value === undefined || value === null) return undefined
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255))
    return new Uint8Array(value as number[])
  if (typeof value !== 'string') throw new Error(`Payload upload bytes at ${path} must be base64 or byte array`)
  const encoded = value.trim()
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error(`Payload upload bytes at ${path} are not valid base64`)
  const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'))
  if (bytes.length > MAX_EXPORT_BYTES) throw new Error(`Payload upload exceeds byte bound at ${path}`)
  return bytes
}

function mediaTypeFor(upload: JsonObject): string {
  const direct = asText(upload.mimeType ?? upload.mimetype ?? upload.mediaType)
  if (direct && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(direct)) return direct.toLowerCase()
  const filename = asText(upload.filename ?? upload.fileName ?? upload.name) ?? ''
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

function uploadId(upload: JsonObject) {
  return asText(upload.id ?? upload._id ?? upload.key ?? upload.filename ?? upload.fileName)
}

function indexUploads(value: unknown) {
  const result = new Map<string, JsonObject>()
  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (isObject(item)) {
        const id = uploadId(item)
        if (id) result.set(id, item)
      }
    })
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (isObject(item)) result.set(uploadId(item) ?? key, item)
    }
  }
  return result
}

function nodeChildren(node: LexicalNode): LexicalNode[] {
  const fields = isObject(node.fields) ? node.fields : undefined
  const children = node.children ?? fields?.children ?? fields?.content
  if (children === undefined) return []
  if (isObject(children) && isObject(children.root) && Array.isArray(children.root.children)) return children.root.children.filter(isObject) as LexicalNode[]
  if (isObject(children) && Array.isArray(children.children)) return children.children.filter(isObject) as LexicalNode[]
  if (!Array.isArray(children) || children.length > MAX_CHILDREN || !children.every(isObject))
    throw new Error('Payload Lexical children must be a bounded array of objects')
  return children as LexicalNode[]
}

function formatFlags(format: unknown): Set<string> {
  const flags = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === 'string') {
      value
        .split(/[|,\s]+/u)
        .filter(Boolean)
        .forEach((part) => flags.add(part.toLowerCase()))
    } else if (Array.isArray(value)) value.forEach(add)
    else if (typeof value === 'number' && Number.isInteger(value)) {
      const names = [
        'bold',
        'italic',
        'strikethrough',
        'underline',
        'code',
        'subscript',
        'superscript',
      ]
      names.forEach((name, index) => {
        if ((value & 2 ** index) !== 0) flags.add(name)
      })
    }
  }
  add(format)
  return flags
}

function textValue(node: LexicalNode) {
  return typeof node.text === 'string'
    ? node.text
    : typeof node.value === 'string'
      ? node.value
      : ''
}

function normalizeNodeType(node: LexicalNode) {
  const type = asText(node.type)
  return type?.toLowerCase() ?? ''
}

function hrefValue(node: LexicalNode) {
  const fields = isObject(node.fields) ? node.fields : undefined
  return asText(node.url ?? node.href ?? fields?.url ?? fields?.href)
}

function lexicalRoot(value: unknown): LexicalNode[] {
  if (Array.isArray(value)) {
    if (value.length > MAX_CHILDREN || !value.every(isObject))
      throw new Error('Payload rich text must contain only bounded Lexical node objects')
    return value as LexicalNode[]
  }
  if (!isObject(value)) throw new Error('Payload rich text must be a Lexical JSON object')
  const root = isObject(value.root) ? value.root : value
  const children = (root as LexicalNode).children
  if (!Array.isArray(children) || children.length > MAX_CHILDREN || !children.every(isObject))
    throw new Error('Payload rich text is missing Lexical root.children')
  return children as LexicalNode[]
}

function relationId(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (isObject(value)) return asText(value.id ?? value._id ?? value.value ?? value.target)
  return undefined
}

function relationshipValues(
  state: AdapterState,
  node: LexicalNode,
  type: string,
): { target: string; label: string; role: PublicationInlineRun['semanticRole'] } | undefined {
  const relationType = asText(node.relationType ?? node.relationshipType)
  const config = state.mapping.relationships[type] ?? (relationType ? state.mapping.relationships[relationType] : undefined)
  if (!config && type !== 'relationship') return undefined
  const target = relationId(
    config?.target ? readPath(node, config.target) : node.value ?? node.target ?? node.relationTo ?? node.fields,
  )
  if (!target) return undefined
  const label =
    (config?.label ? asText(readPath(node, config.label)) : undefined) ??
    asText(node.label ?? node.text ?? node.value) ??
    target
  const role = config?.role ?? (asText(node.role ?? node.relationType) as PublicationInlineRun['semanticRole']) ?? 'cross-reference'
  return { target, label, role }
}

function statusValue(value: unknown): 'working' | 'review' | 'published' | undefined {
  const status = asText(value)?.toLowerCase()
  if (!status) return undefined
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
  const date = new Date(String(value))
  if (Number.isNaN(date.valueOf())) throw new Error(`Payload ${field} is not a valid date`)
  return date.toISOString().slice(0, 10)
}

function sourceIdFor(documentId: string, locale: string) {
  return `payload:${sourceSafeId(documentId)}:${sourceSafeId(locale)}`
}

function getVariant(document: JsonObject, mapping: PayloadMappingPolicy, locale: string): JsonObject | undefined {
  const locales = mappedValue(document, mapping, 'locales')
  const entries: Array<{ locale: string; value: JsonObject }> = []
  if (Array.isArray(locales)) {
    for (const item of locales) {
      if (!isObject(item)) continue
      const itemLocale = asText(item.locale ?? item.language ?? item.code)
      if (itemLocale) entries.push({ locale: canonicalLocale(itemLocale), value: item })
    }
  } else if (isObject(locales)) {
    for (const [key, item] of Object.entries(locales)) {
      if (isObject(item)) entries.push({ locale: canonicalLocale(key), value: item })
    }
  }
  return entries.find((entry) => entry.locale === locale)?.value
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
  if (isObject(input.document)) {
    document = input.document
    mapping = mapping ?? input.mapping
    locale = asText(input.locale)
  } else if (
    isObject(input.data) &&
    (input.mapping !== undefined ||
      (input.document === undefined &&
        !('id' in input) &&
        !('title' in input) &&
        (('content' in input.data) || ('title' in input.data) || ('id' in input.data))))
  ) {
    document = input.data
    mapping = mapping ?? input.mapping
    locale = asText(input.locale)
  } else if (isObject(input.doc) && input.document === undefined && !('id' in input)) {
    document = input.doc
    mapping = mapping ?? input.mapping
    locale = asText(input.locale)
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
  uploads: Map<string, JsonObject>
  diagnostics: AdapterDiagnostic[]
  usedIds: Set<string>
  pendingReferences: Map<string, { label: string; role?: PublicationInlineRun['semanticRole'] }>
  fallbackFrom?: string
}

function nodeId(state: AdapterState, node: LexicalNode, path: string, kind: string) {
  const explicit = asText(node.id ?? node.nodeId ?? node.key ?? (isObject(node.fields) ? node.fields.id : undefined))
  if (explicit && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(explicit) && !state.usedIds.has(explicit)) {
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
      evidence: [
        sourceLocation(state.sourceId, path),
        ...(state.fallbackFrom ? [`locale-fallback:${state.fallbackFrom}->${state.locale}`] : []),
      ],
      idOrigin: origin,
    },
    accessibility: { decorative: false },
    variants: [],
    permittedTransformationIds: [],
    edition: { editionId: state.editionId, sourceLocaleKey: state.locale },
  }
}

function appendInline(state: AdapterState, children: LexicalNode[], path: string, inherited: Partial<PublicationInlineRun> = {}) {
  let text = ''
  const inlineRuns: PublicationInlineRun[] = []
  const append = (value: string, style: Partial<PublicationInlineRun> = {}) => {
    if (!value) return
    const start = text.length
    text += value
    const marks = Object.fromEntries(Object.entries(style).filter(([key]) => !['start', 'end'].includes(key))) as Partial<PublicationInlineRun>
    if (Object.keys(marks).length) inlineRuns.push({ start, end: text.length, ...marks })
  }
  const visit = (node: LexicalNode, current: Partial<PublicationInlineRun>, nodePath: string) => {
    const type = normalizeNodeType(node)
    if (type === 'text' || type === 'linebreak') {
      const flags = formatFlags(node.format)
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
      const value = type === 'linebreak' ? '\n' : textValue(node)
      append(value, { ...style, ...(type === 'linebreak' ? { hardBreak: true } : {}) })
      return
    }
    if (type === 'link' || type === 'autolink') {
      const href = hrefValue(node)
      if (!href) throw new Error(`Payload link is missing href at ${sourceLocation(state.sourceId, nodePath)}`)
      nodeChildren(node).forEach((child, index) => visit(child, { ...current, href }, `${nodePath}.children[${index}]`))
      return
    }
    const configuredRelationship = relationshipValues(state, node, type)
    if (configuredRelationship) {
      const { target, label, role } = configuredRelationship
      const targetNodeId = sourceSafeId(target)
      state.pendingReferences.set(targetNodeId, {
        label,
        role,
      })
      append(label, {
        ...current,
        relationshipId: targetNodeId,
        semanticRole: role,
        targetIds: [targetNodeId],
        href: `#${targetNodeId}`,
      })
      return
    }
    if (type === 'upload' || type === 'image' || type === 'media') {
      // Inline media has no text representation in PublicationGraph.  Keep its
      // relationship visible in source evidence and let the containing block
      // map it to a figure/media node.
      const target = relationId(node.value ?? node.id ?? node.fields)
      if (target) state.pendingReferences.set(sourceSafeId(target), { label: target })
      return
    }
    if (type === 'list') return
    const children = nodeChildren(node)
    if (children.length) children.forEach((child, index) => visit(child, current, `${nodePath}.children[${index}]`))
    else if (type) throw new Error(`Unsupported Lexical inline node ${type} at ${sourceLocation(state.sourceId, nodePath)}`)
  }
  children.forEach((child, index) => visit(child, inherited, `${path}.children[${index}]`))
  return { text, inlineRuns }
}

function addAsset(state: AdapterState, upload: JsonObject, path: string): string | undefined {
  const id = uploadId(upload)
  if (!id) throw new Error(`Payload upload is missing id at ${sourceLocation(state.sourceId, path)}`)
  const bytes = decodeBytes(upload.bytes ?? upload.data ?? upload.buffer ?? upload.base64, sourceLocation(state.sourceId, path))
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
  if (existing) return existing.id
  const descriptor: AssetDescriptor = {
    id: `asset-${hash.slice(0, 20)}`,
    sha256: hash,
    byteLength: bytes.byteLength,
    mediaType: mediaTypeFor(upload),
    fileName: asText(upload.filename ?? upload.fileName ?? upload.name),
    accessibilityLabel: asText(upload.alt ?? upload.altText ?? upload.alternativeText),
    width: typeof upload.width === 'number' ? upload.width : undefined,
    height: typeof upload.height === 'number' ? upload.height : undefined,
    focalPoint:
      isObject(upload.focalPoint) && typeof upload.focalPoint.x === 'number' && typeof upload.focalPoint.y === 'number'
        ? { x: upload.focalPoint.x, y: upload.focalPoint.y }
        : typeof upload.focalX === 'number' && typeof upload.focalY === 'number'
          ? { x: upload.focalX / 100, y: upload.focalY / 100 }
          : undefined,
    crop:
      isObject(upload.crop) &&
      typeof upload.crop.x === 'number' &&
      typeof upload.crop.y === 'number' &&
      typeof upload.crop.width === 'number' &&
      typeof upload.crop.height === 'number'
        ? {
            x: upload.crop.x,
            y: upload.crop.y,
            width: upload.crop.width,
            height: upload.crop.height,
            unit: upload.crop.unit === 'percent' ? 'percent' : 'px',
          }
        : undefined,
  }
  state.assets.push(descriptor)
  state.assetBytes.set(descriptor.id, bytes)
  return descriptor.id
}

function uploadFor(state: AdapterState, node: LexicalNode): JsonObject | undefined {
  const fields = isObject(node.fields) ? node.fields : undefined
  const raw = node.value ?? node.upload ?? node.asset ?? fields?.upload ?? fields?.asset ?? node.id
  const id = relationId(raw)
  if (isObject(raw)) return raw
  return id ? state.uploads.get(id) : undefined
}

function addTextNode(state: AdapterState, node: LexicalNode, path: string, type: 'paragraph' | 'heading' | 'quote' | 'aside') {
  const identity = nodeId(state, node, path, type)
  const inline = appendInline(state, nodeChildren(node), path)
  const fields = isObject(node.fields) ? node.fields : undefined
  const text = inline.text || asText(node.text ?? fields?.text ?? fields?.content) || ''
  if (!text.trim()) throw new Error(`Payload ${type} is empty at ${sourceLocation(state.sourceId, path)}`)
  const common = commonNode(state, identity.id, identity.origin, path)
  if (type === 'heading') {
    const rawLevel = Number(node.level ?? String(node.tag ?? 'h2').replace(/^h/iu, ''))
    return { ...common, type, level: Math.min(6, Math.max(1, Number.isFinite(rawLevel) ? rawLevel : 2)), text, inlineRuns: inline.inlineRuns } as PublicationNode
  }
  return { ...common, type, text, inlineRuns: inline.inlineRuns } as PublicationNode
}

function addUploadNode(state: AdapterState, node: LexicalNode, path: string): PublicationNode {
  const identity = nodeId(state, node, path, 'figure')
  const upload = uploadFor(state, node)
  const fields = isObject(node.fields) ? node.fields : undefined
  const alt = asText(node.alt ?? node.altText ?? fields?.alt ?? fields?.altText)
  const title = asText(node.title ?? fields?.title ?? alt ?? upload?.alt ?? upload?.filename) ?? 'Untitled upload'
  const assetId = upload ? addAsset(state, upload, path) : undefined
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
    accessibility: { decorative: false, ...(alt ? { alternativeText: alt } : {}) },
  } as PublicationNode
}

function addTableNode(state: AdapterState, node: LexicalNode, path: string): PublicationNode {
  const identity = nodeId(state, node, path, 'table')
  const fields = isObject(node.fields) ? node.fields : undefined
  const rawRows = node.rows ?? fields?.rows
  if (!Array.isArray(rawRows) || !rawRows.length) throw new Error(`Payload table is missing rows at ${sourceLocation(state.sourceId, path)}`)
  const rows = rawRows.map((rawRow, rowIndex) => {
    const row = isObject(rawRow) ? rawRow : { cells: rawRow }
    const rawCells = row.cells
    if (!Array.isArray(rawCells) || !rawCells.length) throw new Error(`Payload table row ${rowIndex} is empty at ${sourceLocation(state.sourceId, path)}`)
    return {
      cells: rawCells.map((rawCell, cellIndex) => {
        const cell: JsonObject = isObject(rawCell) ? rawCell : { text: rawCell }
        const header = cell.header === true || cell.isHeader === true || cell.headerScope === 'column' || cell.headerScope === 'row'
        return {
          id: asText(cell.id ?? cell.key) || undefined,
          text: asText(cell.text ?? cell.value ?? cell.content) ?? '',
          headerScope: header ? (cell.headerScope === 'row' ? 'row' : 'column') : null,
          columnSpan: Number.isInteger(cell.colSpan ?? cell.columnSpan) ? Number(cell.colSpan ?? cell.columnSpan) : 1,
          rowSpan: Number.isInteger(cell.rowSpan) ? Number(cell.rowSpan) : 1,
          ...(Array.isArray(cell.headerIds) ? { headerIds: cell.headerIds.map(String) } : {}),
          _rowIndex: rowIndex,
          _cellIndex: cellIndex,
        }
      }),
    }
  })
  // `_rowIndex`/`_cellIndex` only make duplicate diagnostics easier while
  // constructing the value; strict graph parsing removes them below.
  const cleanRows = rows.map((row) => ({
    cells: row.cells.map(({ _rowIndex: _row, _cellIndex: _cell, ...cell }) => cell),
  }))
  return { ...commonNode(state, identity.id, identity.origin, path), type: 'table', rows: cleanRows } as PublicationNode
}

function addEquationNode(state: AdapterState, node: LexicalNode, path: string): PublicationNode {
  const identity = nodeId(state, node, path, 'equation')
  const fields = isObject(node.fields) ? node.fields : undefined
  const source = asText(node.source ?? node.latex ?? node.value ?? fields?.source ?? fields?.latex) ?? ''
  if (!source) throw new Error(`Payload equation is empty at ${sourceLocation(state.sourceId, path)}`)
  const rawFormat = asText(node.format ?? fields?.format)?.toLowerCase()
  const format = rawFormat === 'mathml' || rawFormat === 'plain-text' ? rawFormat : 'latex'
  return { ...commonNode(state, identity.id, identity.origin, path), type: 'equation', source, format, ...(asText(node.label ?? fields?.label) ? { label: asText(node.label ?? fields?.label) } : {}) } as PublicationNode
}

function addMediaNode(state: AdapterState, node: LexicalNode, path: string): PublicationNode {
  const upload = uploadFor(state, node)
  const assetId = upload ? addAsset(state, upload, path) : undefined
  if (!assetId) return addUploadNode(state, node, path)
  const identity = nodeId(state, node, path, 'media')
  const rawKind = asText(node.mediaKind ?? node.kind ?? (isObject(node.fields) ? node.fields.kind : undefined))?.toLowerCase()
  const mediaKind = rawKind === 'audio' || rawKind === 'video' || rawKind === 'interactive' ? rawKind : 'image'
  return { ...commonNode(state, identity.id, identity.origin, path), type: 'media', mediaKind, assetId, accessibility: { decorative: false, ...(asText(node.alt ?? node.altText ?? (isObject(node.fields) ? node.fields.alt : undefined)) ? { alternativeText: asText(node.alt ?? node.altText ?? (isObject(node.fields) ? node.fields.alt : undefined)) } : {}) } } as PublicationNode
}

function addList(state: AdapterState, node: LexicalNode, path: string): PublicationNode[] {
  const listIdentity = nodeId(state, node, path, 'list')
  const items = nodeChildren(node)
  if (!items.length) throw new Error(`Payload list is empty at ${sourceLocation(state.sourceId, path)}`)
  const itemIdentities = items.map((item, index) => nodeId(state, item, `${path}.children[${index}]`, 'item'))
  const itemIds = itemIdentities.map((identity) => identity.id)
  const list = {
    ...commonNode(state, listIdentity.id, listIdentity.origin, path),
    type: 'list',
    ordered: Boolean(node.listType === 'number' || node.ordered || node.tag === 'ol'),
    ...(Number.isInteger(node.start) ? { start: Number(node.start) } : {}),
    itemIds,
  } as PublicationNode
  const result: PublicationNode[] = [list]
  items.forEach((item, index) => {
    const itemPath = `${path}.children[${index}]`
    const identity = itemIdentities[index]
    const inline = appendInline(state, nodeChildren(item), itemPath)
    const childLists: PublicationNode[] = []
    nodeChildren(item).forEach((child, childIndex) => {
      if (normalizeNodeType(child) === 'list') childLists.push(...addList(state, child, `${itemPath}.children[${childIndex}]`))
    })
    const childListIds = childLists.filter((candidate) => candidate.type === 'list').map((candidate) => candidate.id)
    result.push({
      ...commonNode(state, identity.id, identity.origin, itemPath),
      type: 'list-item',
      parentListId: listIdentity.id,
      childListIds,
      text: inline.text || asText(item.text) || ' ',
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
    const code = asText(node.code ?? node.text ?? node.value ?? fields?.code ?? fields?.text) ?? ''
    if (!code) throw new Error(`Payload code node is empty at ${sourceLocation(state.sourceId, path)}`)
    return [{ ...commonNode(state, identity.id, identity.origin, path), type: 'code', code, ...(asText(node.language) ? { language: asText(node.language) } : {}) } as PublicationNode]
  }
  if (type === 'upload' || type === 'image') return [addUploadNode(state, node, path)]
  if (type === 'media') return [addMediaNode(state, node, path)]
  if (type === 'relationship') {
    const configured = relationshipValues(state, node, type)
    if (!configured) throw new Error(`Payload relationship is missing target at ${sourceLocation(state.sourceId, path)}`)
    const { target, label, role } = configured
    const id = sourceSafeId(target)
    const identity = nodeId(state, node, path, 'reference')
    state.pendingReferences.set(id, { label, role })
    return [{ ...commonNode(state, identity.id, identity.origin, path), type: 'reference', targetIds: [id], text: label, href: `#${id}` } as PublicationNode]
  }
  const configuredRelationship = relationshipValues(state, node, type)
  if (configuredRelationship) {
    const { target, label, role } = configuredRelationship
    const id = sourceSafeId(target)
    const identity = nodeId(state, node, path, 'reference')
    state.pendingReferences.set(id, { label, role })
    return [{ ...commonNode(state, identity.id, identity.origin, path), type: 'reference', targetIds: [id], text: label, href: `#${id}` } as PublicationNode]
  }
  const fields = isObject(node.fields) ? node.fields : undefined
  const configuredName =
    type === 'block'
      ? asText(fields?.blockType ?? fields?.type ?? node.blockType ?? node.blockName)
      : type
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
  return createAssetBundle(
    { version: '1.0.0', assets: state.assets },
    async (descriptor) => {
      const bytes = state.assetBytes.get(descriptor.id)
      if (!bytes) throw new Error(`Asset ${descriptor.id} is unavailable in the local Payload export`)
      return bytes
    },
  )
}

function buildState(document: JsonObject, mapping: PayloadMappingPolicy, requestedLocale?: string): AdapterState {
  const documentId = requiredText(mappedValue(document, mapping, 'id'), 'id')
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
    uploads: indexUploads(mappedValue(document, mapping, 'uploads')),
    diagnostics: [],
    usedIds: new Set(),
    pendingReferences: new Map(),
  }
}

function buildResult(state: AdapterState): PublicationSourceResult {
  const selectedVariant = getVariant(state.document, state.mapping, state.locale)
  const source = selectedVariant ? { ...state.document, ...selectedVariant } : state.document
  if (selectedVariant) {
    const variantUploads = indexUploads(mappedValue(selectedVariant, state.mapping, 'uploads'))
    for (const [id, upload] of variantUploads) state.uploads.set(id, upload)
  }
  const content = mappedValue(source, state.mapping, 'content')
  if (content === undefined) throw new Error(`Payload publication ${state.documentId} is missing mapped Lexical content`)
  for (const [index, node] of lexicalRoot(content).entries()) state.nodes.push(...addBlock(state, node, `content.root.children[${index}]`))
  if (!state.nodes.length) {
    const identity = nodeId(state, { type: 'heading', text: requiredText(mappedValue(source, state.mapping, 'title'), 'title') }, 'metadata.title', 'heading')
    state.nodes.push({ ...commonNode(state, identity.id, identity.origin, 'metadata.title'), type: 'heading', level: 1, text: requiredText(mappedValue(source, state.mapping, 'title'), 'title') } as PublicationNode)
  }
  for (const [targetId, info] of state.pendingReferences) {
    if (state.nodes.some((node) => node.id === targetId)) continue
    const identity = nodeId(state, { id: targetId, type: 'reference' }, `relationship.${targetId}`, 'reference')
    state.nodes.push({ ...commonNode(state, identity.id, identity.origin, `relationship.${targetId}`, 'supporting'), type: 'reference', targetIds: [], text: info.label } as PublicationNode)
  }
  const title = requiredText(mappedValue(source, state.mapping, 'title'), 'title')
  const description = asText(mappedValue(source, state.mapping, 'description'))
  const contributorsValue = mappedValue(source, state.mapping, 'authors')
  const contributors = Array.isArray(contributorsValue)
    ? contributorsValue.map((author) => requiredText(author, 'author'))
    : contributorsValue === undefined
      ? []
      : [requiredText(contributorsValue, 'author')]
  const metadata = {
    title,
    ...(description ? { abstract: description } : {}),
    contributors,
    ...(statusValue(mappedValue(source, state.mapping, 'status')) ? { status: statusValue(mappedValue(source, state.mapping, 'status')) } : {}),
    ...(asText(mappedValue(source, state.mapping, 'version')) ? { sourceDocumentVersion: asText(mappedValue(source, state.mapping, 'version')) } : {}),
    ...(dateValue(mappedValue(source, state.mapping, 'created'), 'created') ? { created: dateValue(mappedValue(source, state.mapping, 'created'), 'created') } : {}),
    ...(dateValue(mappedValue(source, state.mapping, 'modified'), 'modified') ? { modified: dateValue(mappedValue(source, state.mapping, 'modified'), 'modified') } : {}),
    defaultLocale: state.locale,
    defaultDirection: directionFor(state.locale),
    keywords: Array.isArray(mappedValue(source, state.mapping, 'keywords')) ? (mappedValue(source, state.mapping, 'keywords') as unknown[]).map((keyword) => requiredText(keyword, 'keyword')) : [],
  }
  const graph = publicationGraphSchema.parse({
    version: PUBLICATION_GRAPH_VERSION,
    id: sourceSafeId(state.documentId),
    metadata,
    edition: { id: state.editionId, locale: state.locale, direction: directionFor(state.locale) },
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
  const requestedLocale = normalized.locale ?? state.locale
  const availableVariant = getVariant(normalized.document, normalized.mapping, state.locale)
  if (!availableVariant && requestedLocale !== pickLocale(normalized.document, normalized.mapping)) {
    const fallback = normalized.mapping.fallbackLocale
    if (!fallback)
      throw new Error(`Payload locale ${requestedLocale} is unavailable; configure an explicit fallbackLocale`)
    const fallbackLocale = canonicalLocale(fallback, 'fallbackLocale')
    const baseLocale = pickLocale(normalized.document, normalized.mapping)
    if (fallbackLocale !== baseLocale && !getVariant(normalized.document, normalized.mapping, fallbackLocale))
      throw new Error(`Payload fallback locale ${fallbackLocale} is unavailable`)
    state.locale = fallbackLocale
    state.fallbackFrom = requestedLocale
    state.sourceId = sourceIdFor(state.documentId, fallbackLocale)
    state.editionId = sourceSafeId(`${state.documentId}:${fallbackLocale}`)
    state.diagnostics.push({ severity: 'warning', code: 'locale-fallback', message: `Locale ${requestedLocale} was unavailable; used ${fallbackLocale}`, sourceId: state.sourceId })
  }
  return buildResult(state)
}

/** Build every declared locale as separate linked editions. */
export function adaptPayloadLexicalEditions(input: unknown, mappingArgument?: unknown): PublicationSourceResult[] {
  const normalized = normalizeInput(input, mappingArgument)
  const locales = mappedValue(normalized.document, normalized.mapping, 'locales')
  const values: string[] = [pickLocale(normalized.document, normalized.mapping, normalized.locale)]
  if (Array.isArray(locales)) locales.forEach((entry) => { if (isObject(entry)) { const locale = asText(entry.locale ?? entry.language ?? entry.code); if (locale) values.push(canonicalLocale(locale)) } })
  else if (isObject(locales)) Object.keys(locales).forEach((locale) => values.push(canonicalLocale(locale)))
  const results = [...new Set(values)].map((locale) => adaptPayloadLexical({ document: normalized.document, mapping: normalized.mapping, locale }))
  const canonical = results[0]
  if (canonical) {
    for (const result of results.slice(1)) {
      const nodes = result.graph.nodes.map((node, index) => ({
        ...node,
        edition: {
          ...node.edition,
          ...(canonical.graph.nodes[index]
            ? { equivalentNodeId: canonical.graph.nodes[index].id }
            : {}),
        },
      }))
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
