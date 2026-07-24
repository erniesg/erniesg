import { strFromU8, strToU8, unzipSync } from 'fflate'
import {
  DOCX_IMPORTER_VERSION,
  DocxImportError,
  MAX_LOCAL_DOCX_BYTES,
  type DocxReconstruction,
  type DocumentImportProgress,
  type PdfNoteRelationship,
  type PublicationAsset,
  type PublicationVisualRelationship,
  type ReconstructionDiagnostic,
} from './import-types'
import {
  researchPaperSchema,
  type ResearchNode,
  type ResearchPaper,
} from './schema'

const MAX_INFLATED_DOCX_BYTES = 200 * 1024 * 1024
const ZIP_LOCAL_FILE_HEADER = [0x50, 0x4b, 0x03, 0x04]
const OFFICE_DOCUMENT_RELATIONSHIP = '/officeDocument'

type XmlElement = {
  name: string
  attributes: Record<string, string>
  children: Array<XmlElement | string>
}

type PackageRelationship = {
  id: string
  type: string
  target: string
  targetMode?: string
  part: string
}

type InlineRun = {
  start: number
  end: number
  bold?: boolean
  italic?: boolean
  href?: string
  relationshipId?: string
}

type ParsedNoteReference = {
  kind: 'footnote' | 'endnote'
  sourceId: string
  label: string
  start: number
  end: number
  sequence: number
}

type ParsedImageReference = {
  relationshipId: string
  altText: string
  width: number
  height: number
}

type ParsedParagraph = {
  kind: 'paragraph'
  index: number
  text: string
  styleId?: string
  styleName?: string
  headingLevel?: number
  quote: boolean
  captionKind?: 'figure' | 'table' | 'generic'
  inlineRuns: InlineRun[]
  noteReferences: ParsedNoteReference[]
  imageReferences: ParsedImageReference[]
  list?: { level: number; ordered: boolean; numberingId: string }
  relationshipIds: string[]
}

type StructuredTable = {
  rows: Array<{
    cells: Array<{
      text: string
      headerScope: 'column' | 'row' | null
      columnSpan: number
      rowSpan: number
    }>
  }>
}

type ParsedTable = {
  kind: 'table'
  index: number
  table: StructuredTable
}

type ParsedBlock = ParsedParagraph | ParsedTable

type StyleInfo = {
  name: string
  basedOn?: string
  outlineLevel?: number
}

type NumberingInfo = Map<string, Map<number, string>>

type ParseContext = {
  diagnostics: ReconstructionDiagnostic[]
  relationships: Map<string, PackageRelationship>
  styles: Map<string, StyleInfo>
  numbering: NumberingInfo
}

function cancelledError() {
  return new DocxImportError(
    'IMPORT_CANCELLED',
    'The local DOCX import was cancelled and its working data was released.',
  )
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelledError()
}

function localName(name: string) {
  return name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
}

function decodeXml(value: string) {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
    (entity, decimal: string, hexadecimal: string, named: string) => {
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10))
      if (hexadecimal)
        return String.fromCodePoint(Number.parseInt(hexadecimal, 16))
      return (
        {
          amp: '&',
          apos: "'",
          gt: '>',
          lt: '<',
          quot: '"',
        }[named.toLowerCase()] ?? entity
      )
    },
  )
}

function parseXml(source: string, part: string): XmlElement {
  const document: XmlElement = {
    name: '#document',
    attributes: {},
    children: [],
  }
  const stack = [document]
  const tokens =
    source.match(
      /<!--[\s\S]*?-->|<\?[^?]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[\s\S]*?>|<[^>]+>|[^<]+/g,
    ) ?? []

  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?')) continue
    if (token.startsWith('<!DOCTYPE')) continue
    if (token.startsWith('<![CDATA[')) {
      stack.at(-1)!.children.push(token.slice(9, -3))
      continue
    }
    if (!token.startsWith('<')) {
      if (token) stack.at(-1)!.children.push(decodeXml(token))
      continue
    }
    if (token.startsWith('</')) {
      const closingName = token.slice(2, -1).trim()
      const current = stack.pop()
      if (!current || current === document || current.name !== closingName) {
        throw new Error(
          `Malformed XML in ${part}: unexpected </${closingName}>`,
        )
      }
      continue
    }
    if (token.startsWith('<!')) continue

    const selfClosing = /\/\s*>$/.test(token)
    const body = token
      .slice(1, selfClosing ? token.lastIndexOf('/') : -1)
      .trim()
    const nameMatch = body.match(/^([^\s/>]+)/)
    if (!nameMatch) throw new Error(`Malformed XML start tag in ${part}`)
    const attributes: Record<string, string> = {}
    const attributeSource = body.slice(nameMatch[0].length)
    const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    for (const match of attributeSource.matchAll(pattern)) {
      attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '')
    }
    const element: XmlElement = {
      name: nameMatch[1],
      attributes,
      children: [],
    }
    stack.at(-1)!.children.push(element)
    if (!selfClosing) stack.push(element)
  }

  if (stack.length !== 1) {
    throw new Error(`Malformed XML in ${part}: unclosed element`)
  }
  const root = document.children.find(
    (child): child is XmlElement => typeof child !== 'string',
  )
  if (!root) throw new Error(`Malformed XML in ${part}: missing root element`)
  return root
}

function elements(element: XmlElement) {
  return element.children.filter(
    (child): child is XmlElement => typeof child !== 'string',
  )
}

function children(element: XmlElement, name: string) {
  return elements(element).filter((child) => localName(child.name) === name)
}

function child(element: XmlElement | undefined, name: string) {
  return element ? children(element, name)[0] : undefined
}

function descendants(element: XmlElement, name?: string): XmlElement[] {
  const result: XmlElement[] = []
  for (const nested of elements(element)) {
    if (!name || localName(nested.name) === name) result.push(nested)
    result.push(...descendants(nested, name))
  }
  return result
}

function directText(element: XmlElement) {
  return element.children
    .filter((nested): nested is string => typeof nested === 'string')
    .join('')
}

function elementText(element: XmlElement): string {
  return element.children
    .map((nested) =>
      typeof nested === 'string' ? nested : elementText(nested),
    )
    .join('')
}

function attribute(element: XmlElement | undefined, name: string) {
  if (!element) return undefined
  return Object.entries(element.attributes).find(
    ([key]) => localName(key) === name,
  )?.[1]
}

function val(element: XmlElement | undefined) {
  return attribute(element, 'val')
}

function boolProperty(element: XmlElement | undefined) {
  if (!element) return false
  const value = val(element)?.toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'off'
}

function xmlPart(
  files: Record<string, Uint8Array>,
  part: string,
  required = false,
) {
  const bytes = files[part]
  if (!bytes) {
    if (required) throw new Error(`Required DOCX part is missing: ${part}`)
    return undefined
  }
  return parseXml(strFromU8(bytes), part)
}

function relationshipPart(sourcePart: string) {
  const slash = sourcePart.lastIndexOf('/')
  const directory = slash >= 0 ? sourcePart.slice(0, slash + 1) : ''
  const fileName = sourcePart.slice(slash + 1)
  return `${directory}_rels/${fileName}.rels`
}

function resolvePart(sourcePart: string, target: string) {
  const pieces = target.startsWith('/')
    ? target.slice(1).split('/')
    : `${sourcePart.slice(0, Math.max(0, sourcePart.lastIndexOf('/') + 1))}${target}`.split(
        '/',
      )
  const normalized: string[] = []
  for (const piece of pieces) {
    if (!piece || piece === '.') continue
    if (piece === '..') {
      if (!normalized.length)
        throw new Error('Relationship target escapes package')
      normalized.pop()
    } else {
      normalized.push(piece)
    }
  }
  return normalized.join('/')
}

function parseRelationships(
  files: Record<string, Uint8Array>,
  sourcePart: string,
) {
  const part = sourcePart ? relationshipPart(sourcePart) : '_rels/.rels'
  const root = xmlPart(files, part)
  const result = new Map<string, PackageRelationship>()
  if (!root) return result
  for (const relation of descendants(root, 'Relationship')) {
    const id = attribute(relation, 'Id')
    const type = attribute(relation, 'Type')
    const target = attribute(relation, 'Target')
    if (!id || !type || !target) continue
    const targetMode = attribute(relation, 'TargetMode')
    result.set(id, {
      id,
      type,
      target:
        targetMode?.toLowerCase() === 'external'
          ? target
          : resolvePart(sourcePart, target),
      targetMode,
      part,
    })
  }
  return result
}

function parseStyles(files: Record<string, Uint8Array>) {
  const result = new Map<string, StyleInfo>()
  const root = xmlPart(files, 'word/styles.xml')
  if (!root) return result
  for (const style of descendants(root, 'style')) {
    if (attribute(style, 'type') !== 'paragraph') continue
    const id = attribute(style, 'styleId')
    if (!id) continue
    const outline = Number.parseInt(
      val(child(child(style, 'pPr'), 'outlineLvl')) ?? '',
      10,
    )
    result.set(id, {
      name: val(child(style, 'name')) ?? id,
      basedOn: val(child(style, 'basedOn')),
      outlineLevel: Number.isInteger(outline) ? outline + 1 : undefined,
    })
  }
  return result
}

function parseNumbering(files: Record<string, Uint8Array>): NumberingInfo {
  const root = xmlPart(files, 'word/numbering.xml')
  const result: NumberingInfo = new Map()
  if (!root) return result
  const abstract = new Map<string, Map<number, string>>()
  for (const definition of descendants(root, 'abstractNum')) {
    const id = attribute(definition, 'abstractNumId')
    if (!id) continue
    const levels = new Map<number, string>()
    for (const level of children(definition, 'lvl')) {
      const index = Number.parseInt(attribute(level, 'ilvl') ?? '', 10)
      const format = val(child(level, 'numFmt'))
      if (Number.isInteger(index) && format) levels.set(index, format)
    }
    abstract.set(id, levels)
  }
  for (const numbering of descendants(root, 'num')) {
    const id = attribute(numbering, 'numId')
    const abstractId = val(child(numbering, 'abstractNumId'))
    if (id && abstractId && abstract.has(abstractId)) {
      result.set(id, abstract.get(abstractId)!)
    }
  }
  return result
}

function styleInfo(styles: Map<string, StyleInfo>, styleId?: string) {
  if (!styleId) return undefined
  let current = styles.get(styleId)
  let depth = 0
  const aggregate: StyleInfo = { name: current?.name ?? styleId }
  while (current && depth < 12) {
    aggregate.outlineLevel ??= current.outlineLevel
    if (!current.basedOn) break
    current = styles.get(current.basedOn)
    depth += 1
  }
  return aggregate
}

function safeHyperlink(value: string) {
  if (value.startsWith('#')) return value
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : null
  } catch {
    return null
  }
}

function diagnosticOnce(
  diagnostics: ReconstructionDiagnostic[],
  diagnostic: ReconstructionDiagnostic,
) {
  if (
    !diagnostics.some(
      (existing) =>
        existing.code === diagnostic.code &&
        existing.message === diagnostic.message,
    )
  ) {
    diagnostics.push(diagnostic)
  }
}

function parseParagraph(
  paragraph: XmlElement,
  index: number,
  context: ParseContext,
): ParsedParagraph {
  const properties = child(paragraph, 'pPr')
  const styleId = val(child(properties, 'pStyle'))
  const style = styleInfo(context.styles, styleId)
  const directOutline = Number.parseInt(
    val(child(properties, 'outlineLvl')) ?? '',
    10,
  )
  const namedHeading = style?.name.match(/heading\s*([1-9])/i)
  const headingLevel = Number.isInteger(directOutline)
    ? Math.min(3, directOutline + 1)
    : style?.outlineLevel
      ? Math.min(3, style.outlineLevel)
      : namedHeading
        ? Math.min(3, Number.parseInt(namedHeading[1], 10))
        : undefined
  const styleName = style?.name ?? styleId
  const normalizedStyle = styleName?.toLowerCase() ?? ''
  const numProperties = child(properties, 'numPr')
  const numberingId = val(child(numProperties, 'numId'))
  const listLevel = Number.parseInt(
    val(child(numProperties, 'ilvl')) ?? '0',
    10,
  )
  const numberingFormat = numberingId
    ? context.numbering.get(numberingId)?.get(listLevel)
    : undefined
  const parsed: ParsedParagraph = {
    kind: 'paragraph',
    index,
    text: '',
    styleId,
    styleName,
    headingLevel,
    quote: /quote|blockquote/.test(normalizedStyle),
    captionKind: /caption/.test(normalizedStyle) ? 'generic' : undefined,
    inlineRuns: [],
    noteReferences: [],
    imageReferences: [],
    relationshipIds: [],
    ...(numberingId
      ? {
          list: {
            level: Math.min(9, Math.max(1, listLevel + 1)),
            ordered: numberingFormat !== 'bullet',
            numberingId,
          },
        }
      : {}),
  }

  const appendText = (
    value: string,
    formatting: Omit<InlineRun, 'start' | 'end'>,
  ) => {
    if (!value) return
    const start = parsed.text.length
    parsed.text += value
    parsed.inlineRuns.push({ start, end: parsed.text.length, ...formatting })
  }

  const appendNote = (kind: ParsedNoteReference['kind'], sourceId: string) => {
    const label = sourceId
    const start = parsed.text.length
    parsed.text += label
    parsed.noteReferences.push({
      kind,
      sourceId,
      label,
      start,
      end: parsed.text.length,
      sequence: parsed.noteReferences.length + 1,
    })
  }

  const parseDrawing = (drawing: XmlElement) => {
    const extent = descendants(drawing, 'extent')[0]
    const width = Math.max(
      0,
      Math.round(Number.parseInt(attribute(extent, 'cx') ?? '0', 10) / 9525),
    )
    const height = Math.max(
      0,
      Math.round(Number.parseInt(attribute(extent, 'cy') ?? '0', 10) / 9525),
    )
    const docProperties = descendants(drawing, 'docPr')[0]
    const altText =
      attribute(docProperties, 'descr') ??
      attribute(docProperties, 'title') ??
      ''
    for (const blip of descendants(drawing, 'blip')) {
      const relationshipId = attribute(blip, 'embed')
      if (!relationshipId) continue
      parsed.imageReferences.push({
        relationshipId,
        altText,
        width,
        height,
      })
      parsed.relationshipIds.push(relationshipId)
    }
  }

  const parseRun = (
    run: XmlElement,
    hyperlink?: { href: string; relationshipId?: string },
  ) => {
    const runProperties = child(run, 'rPr')
    const formatting: Omit<InlineRun, 'start' | 'end'> = {
      ...(boolProperty(child(runProperties, 'b')) ? { bold: true } : {}),
      ...(boolProperty(child(runProperties, 'i')) ? { italic: true } : {}),
      ...(hyperlink?.href ? { href: hyperlink.href } : {}),
      ...(hyperlink?.relationshipId
        ? { relationshipId: hyperlink.relationshipId }
        : {}),
    }
    const visit = (element: XmlElement) => {
      const name = localName(element.name)
      if (name === 'rPr') return
      if (name === 't' || name === 'instrText') {
        appendText(directText(element), formatting)
        return
      }
      if (name === 'tab') {
        appendText('\t', formatting)
        return
      }
      if (name === 'br' || name === 'cr') {
        appendText('\n', formatting)
        return
      }
      if (name === 'footnoteReference') {
        const sourceId = attribute(element, 'id')
        if (sourceId) appendNote('footnote', sourceId)
        return
      }
      if (name === 'endnoteReference') {
        const sourceId = attribute(element, 'id')
        if (sourceId) appendNote('endnote', sourceId)
        return
      }
      if (name === 'drawing' || name === 'pict') {
        parseDrawing(element)
        return
      }
      for (const nested of elements(element)) visit(nested)
    }
    visit(run)
  }

  const visitParagraphContent = (container: XmlElement) => {
    for (const nested of elements(container)) {
      const name = localName(nested.name)
      if (name === 'pPr') continue
      if (name === 'r') {
        parseRun(nested)
        continue
      }
      if (name === 'hyperlink') {
        const relationshipId = attribute(nested, 'id')
        const anchor = attribute(nested, 'anchor')
        const relationship = relationshipId
          ? context.relationships.get(relationshipId)
          : undefined
        const candidate = anchor ? `#${anchor}` : relationship?.target
        const href = candidate ? safeHyperlink(candidate) : null
        if (relationshipId) parsed.relationshipIds.push(relationshipId)
        if (!href) {
          diagnosticOnce(context.diagnostics, {
            code: 'UNRESOLVED_HYPERLINK',
            severity: 'error',
            message: `DOCX hyperlink ${relationshipId ?? '(missing id)'} has no safe resolvable target.`,
          })
        }
        for (const hyperlinkRun of children(nested, 'r')) {
          parseRun(hyperlinkRun, href ? { href, relationshipId } : undefined)
        }
        continue
      }
      visitParagraphContent(nested)
    }
  }
  visitParagraphContent(paragraph)

  if (/^\s*(?:fig(?:ure)?\.?\s*\d+\b|figure\s*[:.-])/i.test(parsed.text)) {
    parsed.captionKind = 'figure'
  } else if (/^\s*table\s+(?:\d+|[ivxlcdm]+)\b/i.test(parsed.text)) {
    parsed.captionKind = 'table'
  }
  return parsed
}

function parseTable(table: XmlElement, index: number): ParsedTable {
  const rows = children(table, 'tr').map((row, rowIndex) => {
    const declaredHeader = Boolean(child(child(row, 'trPr'), 'tblHeader'))
    return {
      cells: children(row, 'tc').map((cell) => {
        const properties = child(cell, 'tcPr')
        const columnSpan = Number.parseInt(
          val(child(properties, 'gridSpan')) ?? '1',
          10,
        )
        return {
          text: children(cell, 'p')
            .map((paragraph) =>
              descendants(paragraph, 't').map(directText).join(''),
            )
            .join('\n')
            .trim(),
          headerScope:
            declaredHeader || rowIndex === 0 ? ('column' as const) : null,
          columnSpan: Number.isInteger(columnSpan)
            ? Math.max(1, columnSpan)
            : 1,
          rowSpan: 1,
        }
      }),
    }
  })
  return { kind: 'table', index, table: { rows } }
}

function parseNotes(
  files: Record<string, Uint8Array>,
  part: string,
  context: ParseContext,
) {
  const notes = new Map<string, string>()
  const root = xmlPart(files, part)
  if (!root) return notes
  const noteElementName = part.includes('endnotes') ? 'endnote' : 'footnote'
  for (const note of children(root, noteElementName)) {
    const id = attribute(note, 'id')
    if (!id || id.startsWith('-')) continue
    const text = children(note, 'p')
      .map((paragraph, index) => parseParagraph(paragraph, index, context).text)
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) notes.set(id, text)
  }
  return notes
}

function parseContentTypes(files: Record<string, Uint8Array>) {
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  const root = xmlPart(files, '[Content_Types].xml', true)!
  for (const item of descendants(root)) {
    if (localName(item.name) === 'Default') {
      const extension = attribute(item, 'Extension')?.toLowerCase()
      const contentType = attribute(item, 'ContentType')
      if (extension && contentType) defaults.set(extension, contentType)
    }
    if (localName(item.name) === 'Override') {
      const part = attribute(item, 'PartName')?.replace(/^\//, '')
      const contentType = attribute(item, 'ContentType')
      if (part && contentType) overrides.set(part, contentType)
    }
  }
  return { defaults, overrides }
}

function normalizedMediaType(
  part: string,
  contentTypes: ReturnType<typeof parseContentTypes>,
): PublicationAsset['mediaType'] | null {
  const extension = part.split('.').at(-1)?.toLowerCase() ?? ''
  const declared =
    contentTypes.overrides.get(part) ?? contentTypes.defaults.get(extension)
  const normalized =
    declared === 'image/jpg' || declared === 'image/pjpeg'
      ? 'image/jpeg'
      : declared === 'image/x-png'
        ? 'image/png'
        : declared
  return ['image/png', 'image/jpeg', 'image/gif'].includes(normalized ?? '')
    ? (normalized as PublicationAsset['mediaType'])
    : null
}

function mediaExtension(mediaType: PublicationAsset['mediaType']) {
  return {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'application/xhtml+xml': 'xhtml',
  }[mediaType]
}

function cleanXmlText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function tableXhtml(table: StructuredTable) {
  const rows = table.rows
    .map(
      (row) =>
        `<tr>${row.cells
          .map((cell) => {
            const tag = cell.headerScope ? 'th' : 'td'
            const scope = cell.headerScope
              ? ` scope="${cell.headerScope === 'column' ? 'col' : 'row'}"`
              : ''
            return `<${tag}${scope} colspan="${cell.columnSpan}" rowspan="${cell.rowSpan}">${cleanXmlText(cell.text)}</${tag}>`
          })
          .join('')}</tr>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Structured table</title></head><body><table>${rows}</table></body></html>\n`
}

async function sha256(value: Uint8Array) {
  const buffer = value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function stableSegment(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-')
}

function validDate(value?: string) {
  if (!value) return '1980-01-01'
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf())
    ? '1980-01-01'
    : parsed.toISOString().slice(0, 10)
}

function coreMetadata(files: Record<string, Uint8Array>) {
  const core = xmlPart(files, 'docProps/core.xml')
  const textOf = (name: string) => {
    const match = core ? descendants(core, name)[0] : undefined
    return match ? elementText(match).trim() : undefined
  }
  return {
    title: textOf('title'),
    subject: textOf('subject'),
    creator: textOf('creator'),
    modified: textOf('modified'),
  }
}

function coverage(resolved: number, expected: number) {
  return expected === 0 ? 1 : resolved / expected
}

function emptyReadingOrder(nodeIds: string[], reviewRequired: boolean) {
  return {
    schemaVersion: '1.0.0' as const,
    regionIds: nodeIds,
    order: nodeIds,
    edges: [],
    resolutions: [],
    acyclic: true,
    evaluation: {
      schemaVersion: '1.0.0' as const,
      algorithm: 'explicit-ooxml-v1' as const,
      mode: 'explicit-structure' as const,
      regionCount: nodeIds.length,
      acceptedEdgeCount: Math.max(0, nodeIds.length - 1),
      unresolvedEdgeCount: 0,
      cycleRate: 0,
      orderAccuracy: 1,
      provider: null,
      modelVersion: null,
      latencyMs: 0 as const,
      costUsd: 0 as const,
      reviewRequired,
    },
  }
}

function unsupportedFeatureDiagnostics(
  document: XmlElement,
  diagnostics: ReconstructionDiagnostic[],
) {
  const features: Array<[string[], string]> = [
    [['ins', 'del', 'moveFrom', 'moveTo'], 'tracked changes'],
    [['commentRangeStart', 'commentRangeEnd', 'commentReference'], 'comments'],
    [['sdt'], 'content controls'],
    [['chart'], 'embedded charts'],
    [['oleObject', 'altChunk'], 'embedded or alternate content'],
    [['fldSimple', 'instrText'], 'field-code content'],
  ]
  for (const [names, label] of features) {
    if (names.some((name) => descendants(document, name).length > 0)) {
      diagnosticOnce(diagnostics, {
        code: 'UNSUPPORTED_DOCX_FEATURE',
        severity: 'error',
        message: `DOCX ${label} are deferred and cannot be silently imported.`,
      })
    }
  }
}

function authors(value?: string) {
  const parsed = value
    ?.split(/[;,]/)
    .map((author) => author.trim())
    .filter(Boolean)
  return parsed?.length ? parsed : ['Unknown author']
}

export async function reconstructDocx(
  file: File,
  onProgress?: (progress: DocumentImportProgress) => void,
  options: { signal?: AbortSignal } = {},
): Promise<DocxReconstruction> {
  throwIfAborted(options.signal)
  if (file.size > MAX_LOCAL_DOCX_BYTES) {
    throw new DocxImportError(
      'OVERSIZED_DOCX',
      `DOCX resource limit exceeded: received ${file.size} bytes; the bounded local limit is ${MAX_LOCAL_DOCX_BYTES} bytes. No document bytes were read.`,
    )
  }
  onProgress?.({
    phase: 'opening',
    completed: 0,
    total: 1,
    message: 'Reading the DOCX package locally…',
  })
  const bytes = new Uint8Array(await file.arrayBuffer())
  throwIfAborted(options.signal)
  if (
    ZIP_LOCAL_FILE_HEADER.some((expected, index) => bytes[index] !== expected)
  ) {
    throw new DocxImportError(
      'INVALID_DOCX',
      'The selected file is not an OOXML DOCX package.',
    )
  }

  const sourceHash = await sha256(bytes)
  throwIfAborted(options.signal)
  let inflatedBytes = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter(file) {
        inflatedBytes += file.originalSize
        if (inflatedBytes > MAX_INFLATED_DOCX_BYTES) {
          throw new Error('DOCX inflated package limit exceeded')
        }
        return true
      },
    })
  } catch (error) {
    throw new DocxImportError(
      'INVALID_DOCX',
      error instanceof Error && error.message.includes('limit exceeded')
        ? `DOCX inflated package limit exceeded: the local limit is ${MAX_INFLATED_DOCX_BYTES} bytes.`
        : 'The selected file is not a readable OOXML DOCX package.',
    )
  }
  const packageParts = Object.keys(files).sort()
  if (
    packageParts.some(
      (part) =>
        part.startsWith('/') ||
        part.split('/').some((segment) => segment === '..'),
    )
  ) {
    throw new DocxImportError(
      'INVALID_DOCX',
      'The DOCX package contains an unsafe part path.',
    )
  }

  onProgress?.({
    phase: 'extracting',
    completed: 1,
    total: 3,
    message: 'Mapping explicit OOXML structure…',
  })
  const diagnostics: ReconstructionDiagnostic[] = []
  try {
    const packageRelationships = parseRelationships(files, '')
    const officeDocument = [...packageRelationships.values()].find((relation) =>
      relation.type.endsWith(OFFICE_DOCUMENT_RELATIONSHIP),
    )
    const documentPart = officeDocument?.target ?? 'word/document.xml'
    const document = xmlPart(files, documentPart, true)!
    const relationships = parseRelationships(files, documentPart)
    const styles = parseStyles(files)
    const numbering = parseNumbering(files)
    const context: ParseContext = {
      diagnostics,
      relationships,
      styles,
      numbering,
    }
    unsupportedFeatureDiagnostics(document, diagnostics)
    const body = descendants(document, 'body')[0]
    if (!body) throw new Error('word/document.xml has no document body')
    const blocks: ParsedBlock[] = []
    for (const element of elements(body)) {
      const name = localName(element.name)
      if (name === 'p') {
        blocks.push(parseParagraph(element, blocks.length, context))
      } else if (name === 'tbl') {
        blocks.push(parseTable(element, blocks.length))
      }
    }

    const referencedKinds = blocks
      .filter((block): block is ParsedParagraph => block.kind === 'paragraph')
      .flatMap((paragraph) => paragraph.noteReferences)
    if (
      referencedKinds.some((reference) => reference.kind === 'footnote') &&
      !files['word/footnotes.xml']
    ) {
      diagnostics.push({
        code: 'MISSING_DOCX_PART',
        severity: 'error',
        message: 'DOCX footnote references require word/footnotes.xml.',
      })
    }
    if (
      referencedKinds.some((reference) => reference.kind === 'endnote') &&
      !files['word/endnotes.xml']
    ) {
      diagnostics.push({
        code: 'MISSING_DOCX_PART',
        severity: 'error',
        message: 'DOCX endnote references require word/endnotes.xml.',
      })
    }
    const footnotes = parseNotes(files, 'word/footnotes.xml', context)
    const endnotes = parseNotes(files, 'word/endnotes.xml', context)
    const contentTypes = parseContentTypes(files)
    const metadata = coreMetadata(files)
    const nodes: ResearchNode[] = []
    const provenance: DocxReconstruction['provenance'] = {}
    const noteRelationships: PdfNoteRelationship[] = []
    const visualRelationships: PublicationVisualRelationship[] = []
    const assets: PublicationAsset[] = []
    const backlinks = new Map<string, string[]>()
    const usedCaptions = new Set<number>()
    const visualCaptions = new Map<number, ParsedParagraph>()
    const coveredTextBlocks = new Set<number>()
    const assignCaption = (index: number, kind: 'figure' | 'table') => {
      for (const offset of [-1, 1]) {
        const candidate = blocks[index + offset]
        if (
          candidate?.kind === 'paragraph' &&
          candidate.text.trim() &&
          !usedCaptions.has(candidate.index) &&
          (candidate.captionKind === kind ||
            candidate.captionKind === 'generic')
        ) {
          usedCaptions.add(candidate.index)
          visualCaptions.set(index, candidate)
          return
        }
      }
    }
    for (const [index, block] of blocks.entries()) {
      if (block.kind === 'table') assignCaption(index, 'table')
      if (block.kind === 'paragraph' && block.imageReferences.length > 0) {
        assignCaption(index, 'figure')
      }
    }

    const addProvenance = (nodeId: string, relationshipIds: string[] = []) => {
      provenance[nodeId] = {
        confidence: 1,
        pages: [],
        regionIds: [],
        boxes: [],
        links: [],
        part: documentPart,
        ...(relationshipIds.length
          ? { relationshipIds: [...new Set(relationshipIds)].sort() }
          : {}),
      }
    }

    const createImageAsset = async (
      reference: ParsedImageReference,
      blockIndex: number,
    ) => {
      const relation = relationships.get(reference.relationshipId)
      if (
        !relation ||
        !relation.type.endsWith('/image') ||
        relation.targetMode?.toLowerCase() === 'external'
      ) {
        diagnostics.push({
          code: 'MISSING_IMAGE_PART',
          severity: 'error',
          message: `DOCX image relationship ${reference.relationshipId} does not resolve to an embedded image part.`,
        })
        return undefined
      }
      const imageBytes = files[relation.target]
      if (!imageBytes) {
        diagnostics.push({
          code: 'MISSING_IMAGE_PART',
          severity: 'error',
          message: `DOCX image relationship ${reference.relationshipId} targets a missing package part.`,
        })
        return undefined
      }
      const mediaType = normalizedMediaType(relation.target, contentTypes)
      if (!mediaType) {
        diagnostics.push({
          code: 'UNSUPPORTED_DOCX_FEATURE',
          severity: 'error',
          message: `DOCX image relationship ${reference.relationshipId} uses an unsupported media type.`,
        })
        return undefined
      }
      const hash = await sha256(imageBytes)
      const id = `asset-img-b${String(blockIndex + 1).padStart(4, '0')}-${stableSegment(reference.relationshipId)}-${hash.slice(0, 12)}`
      const asset: PublicationAsset = {
        id,
        href: `assets/${id}.${mediaExtension(mediaType)}`,
        mediaType,
        kind: mediaType === 'image/svg+xml' ? 'vector' : 'raster',
        rendition: 'source-preserved',
        sha256: hash,
        bytes: imageBytes,
        width: reference.width,
        height: reference.height,
        resolutionDpi: null,
        sourceObjectIds: [reference.relationshipId],
        sourceBoxes: [],
      }
      assets.push(asset)
      return asset
    }

    for (const [blockIndex, block] of blocks.entries()) {
      throwIfAborted(options.signal)
      if (block.kind === 'paragraph' && block.imageReferences.length > 0) {
        const caption = visualCaptions.get(blockIndex)
        const figureId = `fig-docx-${String(blockIndex + 1).padStart(4, '0')}`
        const captionId = `cap-docx-${String(blockIndex + 1).padStart(4, '0')}`
        const imageAssets = (
          await Promise.all(
            block.imageReferences.map((reference) =>
              createImageAsset(reference, blockIndex),
            ),
          )
        ).filter((asset): asset is PublicationAsset => Boolean(asset))
        const matched =
          Boolean(caption) &&
          imageAssets.length === block.imageReferences.length
        if (!caption) {
          diagnostics.push({
            code: 'MISSING_IMAGE_CAPTION',
            severity: 'error',
            message: `DOCX image block ${blockIndex + 1} has no adjacent caption paragraph.`,
          })
        }
        if (caption) {
          nodes.push({
            id: figureId,
            type: 'figure',
            title: caption.text,
            objectType: 'figure',
            relationships: {
              caption: captionId,
              ...(imageAssets.length
                ? { assets: imageAssets.map((asset) => asset.id) }
                : {}),
            },
            source: `docx:${sourceHash.slice(0, 16)}#${documentPart}@block=${blockIndex + 1}`,
          })
          nodes.push({
            id: captionId,
            type: 'caption',
            text: caption.text,
            source: `docx:${sourceHash.slice(0, 16)}#${documentPart}@block=${caption.index + 1}`,
          })
          addProvenance(
            figureId,
            block.imageReferences.map((reference) => reference.relationshipId),
          )
          addProvenance(captionId)
          coveredTextBlocks.add(caption.index)
        }
        visualRelationships.push({
          id: `visual-docx-${String(blockIndex + 1).padStart(4, '0')}`,
          kind: 'figure',
          label: caption?.text ?? `image block ${blockIndex + 1}`,
          captionRegionId: captionId,
          sourceRegionIds: [`block-${blockIndex + 1}`],
          sourceObjectIds: block.imageReferences.map(
            (reference) => reference.relationshipId,
          ),
          assetIds: imageAssets.map((asset) => asset.id),
          status: matched ? 'matched' : 'unresolved',
          confidence: matched ? 1 : 0,
          evidence: ['ooxml-image-relationship', 'adjacent-caption-paragraph'],
          candidates: [],
          sourceBoxes: [],
          sourceText: caption?.text ?? '',
          altText:
            caption?.text ??
            block.imageReferences
              .map((reference) => reference.altText)
              .find(Boolean) ??
            '',
          altTextSource: caption ? 'caption' : 'source-text',
          canonicalNodeId: caption ? figureId : null,
          captionNodeId: caption ? captionId : null,
        })
        continue
      }

      if (block.kind === 'table') {
        const caption = visualCaptions.get(blockIndex)
        const tableId = `table-docx-${String(blockIndex + 1).padStart(4, '0')}`
        const captionId = `cap-table-docx-${String(blockIndex + 1).padStart(4, '0')}`
        const tableBytes = strToU8(tableXhtml(block.table))
        const hash = await sha256(tableBytes)
        const assetId = `asset-${tableId}-${hash.slice(0, 12)}`
        const asset: PublicationAsset = {
          id: assetId,
          href: `assets/${assetId}.xhtml`,
          mediaType: 'application/xhtml+xml',
          kind: 'table',
          rendition: 'semantic-table',
          sha256: hash,
          bytes: tableBytes,
          width: Math.max(
            0,
            ...block.table.rows.map((row) => row.cells.length),
          ),
          height: block.table.rows.length,
          resolutionDpi: null,
          sourceObjectIds: [`table-block-${blockIndex + 1}`],
          sourceBoxes: [],
        }
        assets.push(asset)
        if (!caption) {
          diagnostics.push({
            code: 'MISSING_IMAGE_CAPTION',
            severity: 'error',
            message: `DOCX table block ${blockIndex + 1} has no adjacent caption paragraph.`,
          })
        } else {
          nodes.push({
            id: tableId,
            type: 'figure',
            title: caption.text,
            objectType: 'table',
            table: block.table,
            relationships: { caption: captionId, assets: [asset.id] },
            source: `docx:${sourceHash.slice(0, 16)}#${documentPart}@block=${blockIndex + 1}`,
          })
          nodes.push({
            id: captionId,
            type: 'caption',
            text: caption.text,
            source: `docx:${sourceHash.slice(0, 16)}#${documentPart}@block=${caption.index + 1}`,
          })
          addProvenance(tableId)
          addProvenance(captionId)
          coveredTextBlocks.add(blockIndex)
          coveredTextBlocks.add(caption.index)
        }
        visualRelationships.push({
          id: `visual-table-docx-${String(blockIndex + 1).padStart(4, '0')}`,
          kind: 'table',
          label: caption?.text ?? `table block ${blockIndex + 1}`,
          captionRegionId: captionId,
          sourceRegionIds: [`block-${blockIndex + 1}`],
          sourceObjectIds: [`table-block-${blockIndex + 1}`],
          assetIds: [asset.id],
          status: caption ? 'matched' : 'unresolved',
          confidence: caption ? 1 : 0,
          evidence: ['ooxml-table-grid', 'adjacent-caption-paragraph'],
          candidates: [],
          sourceBoxes: [],
          sourceText: caption?.text ?? '',
          altText: caption?.text ?? '',
          altTextSource: caption ? 'caption' : 'source-text',
          canonicalNodeId: caption ? tableId : null,
          captionNodeId: caption ? captionId : null,
        })
        continue
      }

      if (
        block.kind !== 'paragraph' ||
        !block.text.trim() ||
        usedCaptions.has(block.index)
      ) {
        continue
      }
      const prefix = block.headingLevel
        ? 'sec'
        : block.quote
          ? 'quote'
          : block.captionKind
            ? 'cap'
            : 'p'
      const nodeId = `${prefix}-docx-${String(blockIndex + 1).padStart(4, '0')}`
      const canonicalReferences: Array<{
        id: string
        label: string
        target: string
        start: number
        end: number
        confidence: number
      }> = []
      for (const reference of block.noteReferences) {
        const notes = reference.kind === 'footnote' ? footnotes : endnotes
        const targetPrefix = reference.kind === 'footnote' ? 'fn' : 'en'
        const target = `${targetPrefix}-docx-${stableSegment(reference.sourceId)}`
        const referenceId = `noteref-${reference.kind}-${stableSegment(reference.sourceId)}-b${String(blockIndex + 1).padStart(4, '0')}-${reference.sequence}`
        const matched = notes.has(reference.sourceId)
        noteRelationships.push({
          id: referenceId,
          label: reference.label,
          referenceRegionId: nodeId,
          referenceStart: reference.start,
          referenceEnd: reference.end,
          targetNoteId: matched ? target : null,
          status: matched ? 'matched' : 'unresolved',
          canonicalAnchor: {
            kind: 'node',
            nodeId,
            start: reference.start,
            end: reference.end,
          },
          confidence: matched ? 1 : 0,
          threshold: 1,
          evidence: [`ooxml-explicit-${reference.kind}-id`],
          candidates: [],
          sourceBoxes: [],
        })
        if (matched) {
          canonicalReferences.push({
            id: referenceId,
            label: reference.label,
            target,
            start: reference.start,
            end: reference.end,
            confidence: 1,
          })
          backlinks.set(target, [...(backlinks.get(target) ?? []), referenceId])
        } else {
          diagnostics.push({
            code: 'DANGLING_NOTE_REFERENCE',
            severity: 'error',
            message: `DOCX ${reference.kind} reference ${reference.sourceId} has no matching note definition.`,
          })
        }
      }
      const common = {
        id: nodeId,
        text: block.text,
        ...(canonicalReferences.length
          ? { noteReferences: canonicalReferences }
          : {}),
        ...(block.inlineRuns.length ? { inlineRuns: block.inlineRuns } : {}),
        source: `docx:${sourceHash.slice(0, 16)}#${documentPart}@block=${blockIndex + 1}`,
      }
      if (block.headingLevel) {
        nodes.push({ ...common, type: 'heading', level: block.headingLevel })
      } else if (block.quote) {
        nodes.push({ ...common, type: 'quote' })
      } else if (block.captionKind) {
        nodes.push({
          id: nodeId,
          type: 'caption',
          text: block.text,
          source: common.source,
        })
      } else {
        nodes.push({
          ...common,
          type: 'paragraph',
          ...(block.list ? { list: block.list } : {}),
        })
      }
      addProvenance(nodeId, block.relationshipIds)
      coveredTextBlocks.add(block.index)
    }

    const referencedFootnotes = new Set(
      noteRelationships
        .filter(
          (relationship) =>
            relationship.status === 'matched' &&
            relationship.targetNoteId?.startsWith('fn-'),
        )
        .map((relationship) => relationship.targetNoteId!),
    )
    const referencedEndnotes = new Set(
      noteRelationships
        .filter(
          (relationship) =>
            relationship.status === 'matched' &&
            relationship.targetNoteId?.startsWith('en-'),
        )
        .map((relationship) => relationship.targetNoteId!),
    )
    for (const [kind, noteMap, referenced, prefix] of [
      ['footnote', footnotes, referencedFootnotes, 'fn'],
      ['endnote', endnotes, referencedEndnotes, 'en'],
    ] as const) {
      for (const [sourceId, text] of [...noteMap.entries()].sort(
        ([left], [right]) =>
          left.localeCompare(right, undefined, { numeric: true }),
      )) {
        const nodeId = `${prefix}-docx-${stableSegment(sourceId)}`
        nodes.push({
          id: nodeId,
          type: 'footnote',
          kind,
          label: sourceId,
          text,
          relationships: { backlinks: backlinks.get(nodeId) ?? [] },
          source: `docx:${sourceHash.slice(0, 16)}#word/${kind === 'footnote' ? 'footnotes' : 'endnotes'}.xml@id=${stableSegment(sourceId)}`,
        })
        provenance[nodeId] = {
          confidence: 1,
          pages: [],
          regionIds: [],
          boxes: [],
          links: [],
          part: `word/${kind === 'footnote' ? 'footnotes' : 'endnotes'}.xml`,
        }
        if (!referenced.has(nodeId)) {
          diagnostics.push({
            code: 'UNREFERENCED_NOTE',
            severity: 'error',
            message: `DOCX ${kind} ${sourceId} has no explicit reference.`,
          })
        }
      }
    }

    if (!nodes.length) {
      throw new Error('DOCX contains no supported reconstructable content')
    }
    const firstHeading = nodes.find(
      (node): node is Extract<ResearchNode, { type: 'heading' }> =>
        node.type === 'heading',
    )
    const abstractParagraph = blocks.find(
      (block): block is ParsedParagraph =>
        block.kind === 'paragraph' &&
        /abstract/.test(block.styleName?.toLowerCase() ?? '') &&
        Boolean(block.text.trim()),
    )
    const firstParagraph = nodes.find(
      (node): node is Extract<ResearchNode, { type: 'paragraph' }> =>
        node.type === 'paragraph',
    )
    const paperDraft: ResearchPaper = {
      id: `docx-${sourceHash.slice(0, 16)}`,
      version: `${DOCX_IMPORTER_VERSION}-import`,
      status: 'working',
      title: metadata.title || firstHeading?.text || 'Untitled DOCX manuscript',
      subtitle: metadata.subject || 'Structured DOCX manuscript',
      authors: authors(metadata.creator),
      updated: validDate(metadata.modified),
      abstract:
        abstractParagraph?.text ||
        firstParagraph?.text.slice(0, 700) ||
        'Structured manuscript imported locally.',
      nodes,
    }
    const paper = researchPaperSchema.parse(paperDraft)
    const blockTextCharacters = (block: ParsedBlock) => {
      if (block.kind === 'paragraph') return block.text.length
      return block.table.rows.reduce(
        (rowTotal, row) =>
          rowTotal +
          row.cells.reduce(
            (cellTotal, cell) => cellTotal + cell.text.length,
            0,
          ),
        0,
      )
    }
    const noteTextCharacters = [
      ...footnotes.values(),
      ...endnotes.values(),
    ].reduce((total, note) => total + note.length, 0)
    const sourceTextCharacters =
      blocks.reduce((total, block) => total + blockTextCharacters(block), 0) +
      noteTextCharacters
    const outputTextCharacters =
      blocks.reduce(
        (total, block) =>
          total +
          (coveredTextBlocks.has(block.index) ? blockTextCharacters(block) : 0),
        0,
      ) + noteTextCharacters
    const matchedTextCharacters = Math.min(
      sourceTextCharacters,
      outputTextCharacters,
    )
    const sourceAssetCount = blocks.reduce(
      (total, block) =>
        total + (block.kind === 'table' ? 1 : block.imageReferences.length),
      0,
    )
    const resolvedRelationshipCount =
      noteRelationships.filter(
        (relationship) => relationship.status === 'matched',
      ).length +
      visualRelationships.filter(
        (relationship) => relationship.status === 'matched',
      ).length
    const expectedRelationshipCount =
      noteRelationships.length + visualRelationships.length
    const unresolvedAssets = Math.max(sourceAssetCount - assets.length, 0)
    const unresolvedVisuals = visualRelationships.filter(
      (relationship) => relationship.status !== 'matched',
    ).length
    const unresolvedNotes = noteRelationships.filter(
      (relationship) => relationship.status !== 'matched',
    ).length
    const unreferencedNotes = diagnostics.filter(
      (diagnostic) => diagnostic.code === 'UNREFERENCED_NOTE',
    ).length
    const unresolvedObjects = {
      assets: unresolvedAssets,
      captions: unresolvedVisuals,
      tables: visualRelationships.filter(
        (relationship) =>
          relationship.kind === 'table' && relationship.status !== 'matched',
      ).length,
      equations: 0,
      citations: 0,
      footnoteReferences: unresolvedNotes,
      footnotes: unreferencedNotes,
    }
    const unresolvedObjectCount = Object.values(unresolvedObjects).reduce(
      (total, count) => total + count,
      0,
    )
    const completeness = {
      sourceTextCharacters,
      outputTextCharacters,
      matchedTextCharacters,
      textCoverage: coverage(matchedTextCharacters, sourceTextCharacters),
      duplicateCanonicalSpanCount: 0,
      missingSourceRegionCount: 0,
      unprovenancedRenderedUnitCount: 0,
      expectedInlineSpanCount: 0,
      mappedInlineSpanCount: 0,
      inlineSpanCoverage: 1,
      expectedHyperlinkCount: 0,
      mappedHyperlinkCount: 0,
      hyperlinkCoverage: 1,
      lineBoundaryCount: 0,
      decidedLineBoundaryCount: 0,
      unresolvedCorruptingJoinCount: 0,
      structurallyConsumedLineBoundaryCount: 0,
      sourceAssetCount,
      exportedAssetCount: assets.length,
      assetCoverage: coverage(assets.length, sourceAssetCount),
      expectedRelationshipCount,
      resolvedRelationshipCount,
      relationshipCoverage: coverage(
        resolvedRelationshipCount,
        expectedRelationshipCount,
      ),
      unresolvedObjectCount,
      unresolvedObjects,
      ocrRequiredPages: [],
      readingOrderDiagnostics: 0,
      readingOrderEvaluation: emptyReadingOrder([], false).evaluation,
    }
    if (completeness.textCoverage < 1) {
      diagnostics.push({
        code: 'INCOMPLETE_TEXT_COVERAGE',
        severity: 'error',
        message: `Preserved ${matchedTextCharacters} of ${sourceTextCharacters} explicit DOCX text characters.`,
      })
    }
    if (completeness.assetCoverage < 1) {
      diagnostics.push({
        code: 'INCOMPLETE_ASSET_COVERAGE',
        severity: 'error',
        message: `Imported ${assets.length} of ${sourceAssetCount} explicit DOCX assets.`,
      })
    }
    if (completeness.relationshipCoverage < 1) {
      diagnostics.push({
        code: 'INCOMPLETE_RELATIONSHIP_COVERAGE',
        severity: 'error',
        message: `Resolved ${resolvedRelationshipCount} of ${expectedRelationshipCount} explicit DOCX relationships.`,
      })
    }
    if (unresolvedObjectCount > 0) {
      diagnostics.push({
        code: 'UNRESOLVED_SEMANTIC_OBJECTS',
        severity: 'error',
        message: `${unresolvedObjectCount} explicit DOCX semantic objects remain unresolved.`,
      })
    }
    const blockingDiagnosticCodes = [
      ...new Set(
        diagnostics
          .filter((diagnostic) => diagnostic.severity === 'error')
          .map((diagnostic) => diagnostic.code),
      ),
    ]
    const ready = blockingDiagnosticCodes.length === 0
    const readingOrder = emptyReadingOrder(
      paper.nodes.map((node) => node.id),
      !ready,
    )
    completeness.readingOrderEvaluation = readingOrder.evaluation

    onProgress?.({
      phase: 'reconstructing',
      completed: 3,
      total: 3,
      message: ready
        ? 'Validating EPUB…'
        : 'Checking completeness diagnostics…',
    })
    throwIfAborted(options.signal)
    return {
      source: {
        fileName: file.name,
        byteLength: bytes.byteLength,
        sha256: sourceHash,
        pageCount: 0,
        localOnly: true,
        format: 'docx',
        packageParts,
        importerVersion: DOCX_IMPORTER_VERSION,
      },
      paper,
      pages: [],
      regions: [],
      readingOrder,
      noteRelationships,
      visualRelationships,
      assets,
      provenance,
      diagnostics,
      semanticSignals: {
        captions: visualRelationships.length,
        tables: blocks.filter((block) => block.kind === 'table').length,
        equations: 0,
        citations: 0,
        footnoteReferences: noteRelationships.length,
        footnotes: footnotes.size + endnotes.size,
      },
      completeness,
      readiness: {
        status: ready ? 'ready' : 'review-required',
        ready,
        policy: {
          minimumTextCoverage: 1,
          minimumAssetCoverage: 1,
          minimumRelationshipCoverage: 1,
          maximumUnresolvedObjects: 0,
          maximumOcrRequiredPages: 0,
          maximumReadingOrderDiagnostics: 0,
        },
        blockingDiagnosticCodes,
      },
    }
  } catch (error) {
    if (error instanceof DocxImportError) throw error
    throw new DocxImportError(
      'DOCX_PARSE_FAILED',
      error instanceof Error
        ? `DOCX parsing failed locally: ${error.message}`
        : 'DOCX parsing failed locally.',
    )
  }
}
