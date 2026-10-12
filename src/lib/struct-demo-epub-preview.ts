import { strFromU8, Unzip, UnzipInflate } from 'fflate'
import { parse, serialize } from 'parse5'

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
const DEFAULT_LIMITS = {
  archiveBytes: MAX_ARCHIVE_BYTES,
  entries: 512,
  inflatedBytes: 64 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  embeddedBytes: 16 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024,
}

export const STRUCT_DEMO_PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"

export type StructDemoEpubPreview = { html: string; title: string }
export type StructDemoEpubPreviewLimits = Partial<typeof DEFAULT_LIMITS>

type Node = {
  tagName?: string
  nodeName?: string
  attrs?: Array<{ name: string; value: string }>
  childNodes?: Node[]
  parentNode?: Node
}

const blockedElements = new Set([
  'base',
  'embed',
  'form',
  'frame',
  'iframe',
  'input',
  'link',
  'meta',
  'object',
  'script',
  'style',
  'template',
  'textarea',
])
const imageMediaTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}
const fontMediaTypes: Record<string, string> = {
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

function unavailable(): never {
  throw new Error('EPUB preview is unavailable.')
}

function extension(path: string) {
  return path.toLowerCase().split('.').pop() ?? ''
}

function attr(source: string, name: string) {
  const match = source.match(
    new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'),
  )
  return match?.[2]
}

function xmlItems(source: string, tag: string) {
  return [...source.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))].map(
    (match) => match[0],
  )
}

function safePath(path: string) {
  if (!path || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path))
    return null
  const result: string[] = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!result.length) return null
      result.pop()
    } else result.push(segment)
  }
  return result.join('/') || null
}

function resolvePath(base: string, href: string) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//'))
    return null
  const path = href.split(/[?#]/, 1)[0]
  if (!path) return safePath(base)
  return safePath(`${base.slice(0, base.lastIndexOf('/') + 1)}${path}`)
}

type OutputBudget = {
  embedded: number
  limits: typeof DEFAULT_LIMITS
  cache: Map<Uint8Array, string>
}

function outputBytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function assertOutput(value: string, maximum: number) {
  if (outputBytes(value) > maximum) unavailable()
}

function safeStyleText(value: string) {
  return value.replace(/</g, '\\3C ')
}

function dataUrl(bytes: Uint8Array, mediaType: string, budget: OutputBudget) {
  let encoded = budget.cache.get(bytes)
  if (!encoded) {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    encoded = btoa(binary)
    budget.cache.set(bytes, encoded)
  }
  const value = `data:${mediaType};base64,${encoded}`
  budget.embedded += outputBytes(value)
  if (budget.embedded > budget.limits.embeddedBytes) unavailable()
  return value
}

function safeImageBytes(bytes: Uint8Array, mediaType: string) {
  if (mediaType !== 'image/svg+xml') return bytes
  return new TextEncoder().encode(
    strFromU8(bytes)
      .replace(
        /<\s*(?:script|foreignobject|iframe|object|embed)\b[\s\S]*?<\s*\/\s*(?:script|foreignobject|iframe|object|embed)\s*>/gi,
        '',
      )
      .replace(
        /<\s*(?:script|foreignobject|iframe|object|embed)\b[^>]*\/\s*>/gi,
        '',
      )
      .replace(/\son\w+\s*=\s*(['"])[\s\S]*?\1/gi, '')
      .replace(
        /\s(?:href|xlink:href)\s*=\s*(['"])\s*(?:https?:|\/\/|data:|javascript:)[\s\S]*?\1/gi,
        '',
      )
      .replace(/@import[\s\S]*?(?:;|$)/gi, '')
      .replace(
        /url\(\s*(['"]?)(?:https?:|\/\/|data:|javascript:)[\s\S]*?\1\s*\)/gi,
        'none',
      ),
  )
}

function textTitle(value: string) {
  return value
    .replace(/\.epub$/i, '')
    .replace(/[_.-]+/g, ' ')
    .trim()
}

function find(node: Node, tagName: string): Node | undefined {
  if (node.tagName === tagName) return node
  for (const child of node.childNodes ?? []) {
    const result = find(child, tagName)
    if (result) return result
  }
}

function remove(node: Node) {
  const siblings = node.parentNode?.childNodes
  if (!siblings) return
  const index = siblings.indexOf(node)
  if (index >= 0) siblings.splice(index, 1)
}

function sanitizeDocument(
  source: string,
  documentPath: string,
  files: Record<string, Uint8Array>,
  budget: OutputBudget,
) {
  const document = parse(source) as unknown as Node
  const visit = (node: Node) => {
    for (const child of [...(node.childNodes ?? [])]) {
      const tag = child.tagName?.toLowerCase()
      if (tag && blockedElements.has(tag)) {
        remove(child)
        continue
      }
      if (child.attrs) {
        child.attrs = child.attrs.filter(({ name }) => {
          const lower = name.toLowerCase()
          return (
            !lower.startsWith('on') &&
            !['action', 'formaction', 'srcdoc', 'style'].includes(lower)
          )
        })
      }
      const attributes = child.attrs
      const get = (name: string) =>
        attributes?.find((entry) => entry.name.toLowerCase() === name)?.value
      const set = (name: string, value?: string) => {
        if (!attributes) return
        const index = attributes.findIndex(
          (entry) => entry.name.toLowerCase() === name,
        )
        if (value === undefined) {
          if (index >= 0) attributes.splice(index, 1)
        } else if (index >= 0) attributes[index]!.value = value
        else attributes.push({ name, value })
      }
      if (tag === 'img') {
        const path = resolvePath(documentPath, get('src') ?? '')
        const type = path ? imageMediaTypes[extension(path)] : undefined
        const bytes = path ? files[path] : undefined
        if (!type || !bytes) set('src')
        else set('src', dataUrl(safeImageBytes(bytes, type), type, budget))
      }
      if (tag === 'a' || tag === 'area') {
        const href = get('href')
        if (href) {
          if (href.startsWith('#')) set('href', href)
          else {
            const fragment = href.includes('#')
              ? `#${href.split('#')[1]}`
              : undefined
            set('href', fragment)
          }
        }
      }
      visit(child)
    }
  }
  visit(document)
  const body = serialize(find(document, 'body') as never)
  assertOutput(body, budget.limits.outputBytes)
  return body
}

function sanitizeCss(
  source: string,
  stylesheetPath: string,
  files: Record<string, Uint8Array>,
  budget: OutputBudget,
) {
  return source
    .replace(/@import[\s\S]*?(?:;|$)/gi, '')
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_whole, _quote, value) => {
      const path = resolvePath(stylesheetPath, value.trim())
      const type = path ? fontMediaTypes[extension(path)] : undefined
      const bytes = path ? files[path] : undefined
      return type && bytes ? `url("${dataUrl(bytes, type, budget)}")` : 'none'
    })
}

function archiveFilePath(name: string) {
  return /(?:\.xml|\.opf|\.xhtml|\.html|\.css|\.(?:png|jpe?g|gif|webp|svg|woff2?|ttf|otf))$/i.test(
    name,
  )
}

type ArchiveEntry = {
  name: string
  flags: number
  compression: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(crc: number, bytes: Uint8Array) {
  let next = crc
  for (const byte of bytes)
    next = crcTable[(next ^ byte) & 0xff]! ^ (next >>> 8)
  return next >>> 0
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  )
}

function findEocd(view: DataView, length: number) {
  for (
    let offset = length - 22;
    offset >= Math.max(0, length - 65_557);
    offset -= 1
  ) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue
    if (offset + 22 + view.getUint16(offset + 20, true) === length)
      return offset
  }
  unavailable()
}

function inspectArchive(archive: Uint8Array, limits: typeof DEFAULT_LIMITS) {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  )
  const eocd = findEocd(view, archive.byteLength)
  const disk = view.getUint16(eocd + 4, true)
  const centralDisk = view.getUint16(eocd + 6, true)
  const diskEntries = view.getUint16(eocd + 8, true)
  const entries = view.getUint16(eocd + 10, true)
  const centralSize = view.getUint32(eocd + 12, true)
  const centralOffset = view.getUint32(eocd + 16, true)
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entries ||
    entries > limits.entries ||
    entries === 0 ||
    diskEntries === 0xffff ||
    entries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize !== eocd
  )
    unavailable()
  const records = new Map<string, ArchiveEntry>()
  let cursor = centralOffset
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== 0x02014b50)
      unavailable()
    const flags = view.getUint16(cursor + 8, true)
    const compression = view.getUint16(cursor + 10, true)
    const crc = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength
    if (
      recordEnd > eocd ||
      view.getUint16(cursor + 34, true) !== 0 ||
      (compression !== 0 && compression !== 8)
    )
      unavailable()
    const nameBytes = archive.slice(cursor + 46, cursor + 46 + nameLength)
    const name = new TextDecoder().decode(nameBytes)
    const localOffset = view.getUint32(cursor + 42, true)
    if (!name || records.has(name) || localOffset >= centralOffset)
      unavailable()
    records.set(name, {
      name,
      flags,
      compression,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    })
    cursor = recordEnd
  }
  if (cursor !== eocd || records.size !== entries) unavailable()
  const ordered = [...records.values()].sort(
    (left, right) => left.localOffset - right.localOffset,
  )
  let expectedOffset = 0
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index]!
    if (
      entry.localOffset !== expectedOffset ||
      entry.localOffset + 30 > centralOffset
    )
      unavailable()
    if (view.getUint32(entry.localOffset, true) !== 0x04034b50) unavailable()
    const flags = view.getUint16(entry.localOffset + 6, true)
    const compression = view.getUint16(entry.localOffset + 8, true)
    const nameLength = view.getUint16(entry.localOffset + 26, true)
    const extraLength = view.getUint16(entry.localOffset + 28, true)
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength
    const dataEnd = dataOffset + entry.compressedSize
    if (
      flags !== entry.flags ||
      compression !== entry.compression ||
      dataEnd > centralOffset ||
      !equalBytes(
        archive.slice(
          entry.localOffset + 30,
          entry.localOffset + 30 + nameLength,
        ),
        new TextEncoder().encode(entry.name),
      )
    )
      unavailable()
    let end = dataEnd
    if (flags & 8) {
      if (
        view.getUint32(entry.localOffset + 14, true) !== 0 ||
        view.getUint32(entry.localOffset + 18, true) !== 0 ||
        view.getUint32(entry.localOffset + 22, true) !== 0
      )
        unavailable()
      const nextOffset = ordered[index + 1]?.localOffset ?? centralOffset
      const descriptorSize = nextOffset - dataEnd
      if (descriptorSize !== 12 && descriptorSize !== 16) unavailable()
      if (descriptorSize === 16 && view.getUint32(dataEnd, true) !== 0x08074b50)
        unavailable()
      const descriptorOffset = dataEnd + (descriptorSize === 16 ? 4 : 0)
      if (
        view.getUint32(descriptorOffset, true) !== entry.crc ||
        view.getUint32(descriptorOffset + 4, true) !== entry.compressedSize ||
        view.getUint32(descriptorOffset + 8, true) !== entry.uncompressedSize
      )
        unavailable()
      end = nextOffset
    } else if (
      view.getUint32(entry.localOffset + 14, true) !== entry.crc ||
      view.getUint32(entry.localOffset + 18, true) !== entry.compressedSize ||
      view.getUint32(entry.localOffset + 22, true) !== entry.uncompressedSize
    )
      unavailable()
    expectedOffset = end
    if (expectedOffset !== (ordered[index + 1]?.localOffset ?? centralOffset))
      unavailable()
  }
  return records
}

function extractBoundedArchive(
  archive: Uint8Array,
  limits: typeof DEFAULT_LIMITS,
  records: ReadonlyMap<string, ArchiveEntry>,
) {
  const files: Record<string, Uint8Array> = {}
  let inflated = 0
  const observed = new Set<string>()
  const unzip = new Unzip((file) => {
    const entry = records.get(file.name)
    if (
      !entry ||
      observed.has(file.name) ||
      file.compression !== entry.compression
    )
      unavailable()
    observed.add(file.name)
    const selected = archiveFilePath(file.name)
    const chunks: Uint8Array[] = []
    let entryBytes = 0
    let crc = 0xffffffff
    file.ondata = (error, chunk, final) => {
      if (error) unavailable()
      entryBytes += chunk.byteLength
      inflated += chunk.byteLength
      crc = crc32(crc, chunk)
      if (entryBytes > limits.entryBytes || inflated > limits.inflatedBytes) {
        file.terminate()
        unavailable()
      }
      if (selected) chunks.push(chunk)
      if (!final) return
      if (
        entryBytes !== entry.uncompressedSize ||
        (crc ^ 0xffffffff) >>> 0 !== entry.crc
      )
        unavailable()
      if (!selected) return
      const bytes = new Uint8Array(entryBytes)
      let offset = 0
      for (const part of chunks) {
        bytes.set(part, offset)
        offset += part.byteLength
      }
      files[file.name] = bytes
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  const chunkSize = 256
  for (let offset = 0; offset < archive.byteLength; offset += chunkSize) {
    unzip.push(
      archive.subarray(
        offset,
        Math.min(offset + chunkSize, archive.byteLength),
      ),
      offset + chunkSize >= archive.byteLength,
    )
  }
  if (archive.byteLength === 0) unzip.push(archive, true)
  if (observed.size !== records.size) unavailable()
  return files
}

export function compileStructDemoEpubPreview(
  archive: Uint8Array,
  sourceFilename: string,
  overrides: StructDemoEpubPreviewLimits = {},
): StructDemoEpubPreview {
  try {
    const limits = { ...DEFAULT_LIMITS, ...overrides }
    if (archive.byteLength > limits.archiveBytes) unavailable()
    const records = inspectArchive(archive, limits)
    const files = extractBoundedArchive(archive, limits, records)
    const container = files['META-INF/container.xml']
    if (!container) unavailable()
    const rootPath = attr(strFromU8(container), 'full-path')
    const opfPath = rootPath && safePath(rootPath)
    if (!opfPath || !files[opfPath]) unavailable()
    const opf = strFromU8(files[opfPath]!)
    const title =
      attr(xmlItems(opf, 'dc:title')[0] ?? '', 'value') ??
      (opf
        .match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]
        ?.replace(/<[^>]+>/g, '')
        .trim() ||
        textTitle(sourceFilename))
    const manifest = new Map<string, string>()
    for (const item of xmlItems(opf, 'item')) {
      const id = attr(item, 'id')
      const href = attr(item, 'href')
      if (id && href) {
        const path = resolvePath(opfPath, href)
        if (path) manifest.set(id, path)
      }
    }
    const spine = xmlItems(opf, 'itemref')
      .map((item) => attr(item, 'idref'))
      .flatMap((id) => (id ? [manifest.get(id)] : []))
      .filter((path): path is string => Boolean(path && files[path]))
    if (!spine.length) unavailable()
    const budget: OutputBudget = {
      embedded: 0,
      limits,
      cache: new Map(),
    }
    let css = ''
    for (const path of [...manifest.values()].filter(
      (candidate) => extension(candidate) === 'css' && files[candidate],
    )) {
      css += `${css ? '\n' : ''}${sanitizeCss(
        strFromU8(files[path]!),
        path,
        files,
        budget,
      )}`
      assertOutput(css, limits.outputBytes)
    }
    let body = ''
    for (const path of spine) {
      body += `${body ? '\n' : ''}${sanitizeDocument(
        strFromU8(files[path]!),
        path,
        files,
        budget,
      )}`
      assertOutput(body, limits.outputBytes)
    }
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${STRUCT_DEMO_PREVIEW_CSP}"><style>${safeStyleText(css)}</style></head><body>${body}</body></html>`
    assertOutput(html, limits.outputBytes)
    return {
      title: title.replace(/<[^>]+>/g, '').trim() || textTitle(sourceFilename),
      html,
    }
  } catch {
    unavailable()
  }
}
