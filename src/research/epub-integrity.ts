import { strFromU8 } from 'fflate'
import { XMLValidator } from 'fast-xml-parser'
import { isBoundedScholarlyReferenceText } from './publication-integrity'
import {
  comparableText,
  isBareScholarlyIdentifier,
  scholarlyReferenceCandidateRanges,
} from './epub-semantic-links'

export function requireWellFormedXml(value: string, documentName: string) {
  if (XMLValidator.validate(value) !== true) {
    throw new Error(`${documentName} must be well-formed XML`)
  }
}

function tagAttributes(tag: string) {
  return new Map(
    [
      ...tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g),
    ].map((match) => [match[1], match[2] ?? match[3]]),
  )
}

export function xmlAttributeValues(value: string, name: string) {
  const values: string[] = []
  for (const match of value.matchAll(/<[^!?][^>]*>/g)) {
    for (const [attributeName, attributeValue] of tagAttributes(match[0])) {
      if (attributeName === name || attributeName.endsWith(`:${name}`)) {
        values.push(attributeValue)
      }
    }
  }
  return values
}

export function xmlTextElements(value: string, tagName: string) {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    ...value.matchAll(
      new RegExp(
        `<${escapedTagName}\\b([^>]*)>([^<]*)<\\/${escapedTagName}>`,
        'g',
      ),
    ),
  ].map((match) => ({
    attributes: tagAttributes(`<${tagName}${match[1]}>`),
    escapedText: match[2],
  }))
}

function decodedXmlFragmentText(value: string) {
  return value
    .replace(/<[^>]*>/gu, '')
    .replace(
      /&(amp|lt|gt|quot|apos);|&#(x[0-9a-f]+|\d+);/giu,
      (entity, named: string | undefined, numeric: string | undefined) => {
        if (named) {
          return named.toLocaleLowerCase() === 'amp'
            ? '&'
            : named.toLocaleLowerCase() === 'lt'
              ? '<'
              : named.toLocaleLowerCase() === 'gt'
                ? '>'
                : named.toLocaleLowerCase() === 'quot'
                  ? '"'
                  : "'"
        }
        const codePoint = numeric?.toLocaleLowerCase().startsWith('x')
          ? Number.parseInt(numeric.slice(1), 16)
          : Number.parseInt(numeric ?? '', 10)
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : ''
      },
    )
}

export function assertSerializedXhtmlSemanticIntegrity(
  value: string,
  documentName: string,
) {
  const scholarlyTargetIds = new Set<string>()
  for (const match of value.matchAll(/<(h[1-6]|figure)\b[^>]*>/giu)) {
    const id = tagAttributes(match[0]).get('id')
    if (id) scholarlyTargetIds.add(id)
  }

  const relationshipIds = new Set<string>()
  const semanticWrapper = /<(a|span)\b([^>]*)>([\s\S]*?)<\/\1>/giu
  for (const match of value.matchAll(semanticWrapper)) {
    const attributes = tagAttributes(`<${match[1]}${match[2]}>`)
    const semanticRole = attributes.get('data-semantic-role')
    if (!semanticRole) continue
    const relationshipId = attributes.get('data-relationship-id')
    if (!relationshipId || relationshipIds.has(relationshipId)) {
      throw new Error(
        `${documentName} contains a duplicate or unowned semantic relationship wrapper`,
      )
    }
    relationshipIds.add(relationshipId)
    const inner = match[3]
    const canonicalInner = inner.replace(
      /<a\b([^>]*)>([^<]*)<\/a>/giu,
      (link, rawAttributes: string, escapedLinkText: string) => {
        const linkAttributes = tagAttributes(`<a${rawAttributes}>`)
        const classes = new Set(
          (linkAttributes.get('class') ?? '').split(/\s+/u).filter(Boolean),
        )
        if (
          !classes.has('additional-biblioref') &&
          !classes.has('additional-cross-reference')
        ) {
          return link
        }
        if (
          !linkAttributes.get('href')?.startsWith('#') ||
          !decodedXmlFragmentText(escapedLinkText).trim()
        ) {
          throw new Error(
            `${documentName} contains an invalid additional semantic target link`,
          )
        }
        return ''
      },
    )
    if (
      /class\s*=\s*(?:"[^"]*\bvisually-hidden\b|'[^']*\bvisually-hidden\b)/iu.test(
        canonicalInner,
      )
    ) {
      throw new Error(
        `${documentName} contains hidden semantic text that duplicates canonical citation text`,
      )
    }
    const visibleText = decodedXmlFragmentText(canonicalInner).trim()
    if (!visibleText) {
      throw new Error(`${documentName} contains an empty semantic relationship`)
    }
    if (
      semanticRole === 'cross-reference' &&
      !isBoundedScholarlyReferenceText(visibleText)
    ) {
      throw new Error(
        `${documentName} contains unbounded scholarly destination text for semantic relationship ${relationshipId} (${visibleText.length} visible characters)`,
      )
    }
    const childAnchors = [
      ...canonicalInner.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/giu),
    ]
    const childTexts = childAnchors.map((anchor) =>
      decodedXmlFragmentText(anchor[1]).trim(),
    )
    if (childTexts.some((textValue) => !textValue)) {
      throw new Error(
        `${documentName} contains an empty semantic target link in relationship ${relationshipId}`,
      )
    }
    if (
      new Set(childTexts.map((textValue) => comparableText(textValue))).size !==
      childTexts.length
    ) {
      throw new Error(
        `${documentName} contains duplicate canonical citation text`,
      )
    }
  }

  for (const match of value.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)) {
    if (/<a\b/iu.test(match[2])) {
      throw new Error(
        `${documentName} contains overlapping nested destination anchors`,
      )
    }
    const attributes = tagAttributes(`<a${match[1]}>`)
    const fragment = attributes.get('href')?.match(/^#(.+)$/u)?.[1]
    if (
      !attributes.has('data-source-annotation-id') ||
      !fragment ||
      !scholarlyTargetIds.has(fragment)
    ) {
      continue
    }
    const visibleText = decodedXmlFragmentText(match[2]).trim()
    const containsScholarlyMarker = (
      ['figure', 'table', 'equation', 'section'] as const
    ).some(
      (kind) => scholarlyReferenceCandidateRanges(visibleText, kind).length > 0,
    )
    if (
      containsScholarlyMarker &&
      !isBoundedScholarlyReferenceText(visibleText) &&
      !isBareScholarlyIdentifier(visibleText)
    ) {
      throw new Error(
        `${documentName} contains unbounded scholarly destination text for ${attributes.get('data-source-annotation-id')} to #${fragment}`,
      )
    }
  }
}

export function inspectOpfPackage(
  opf: string,
  files: Record<string, Uint8Array>,
) {
  const items = [...opf.matchAll(/<item\b[^>]*\/?\s*>/g)].map((match) => {
    const attributes = tagAttributes(match[0])
    const item = {
      id: attributes.get('id') ?? '',
      href: attributes.get('href') ?? '',
      mediaType: attributes.get('media-type') ?? '',
      properties: attributes.get('properties') ?? '',
    }
    if (!item.id || !item.href || !item.mediaType) {
      throw new Error('EPUB OPF manifest item is missing required metadata')
    }
    if (
      item.href.startsWith('/') ||
      item.href.includes('\\') ||
      item.href.split('/').includes('..') ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(item.href)
    ) {
      throw new Error(`EPUB manifest href is unsafe: ${item.href}`)
    }
    return item
  })
  const ids = items.map(({ id }) => id)
  const hrefs = items.map(({ href }) => href)
  if (new Set(ids).size !== ids.length) {
    throw new Error('EPUB OPF contains a duplicate manifest id')
  }
  if (new Set(hrefs).size !== hrefs.length) {
    throw new Error('EPUB OPF contains a duplicate manifest href')
  }
  const byId = new Map(items.map((item) => [item.id, item]))
  for (const item of items) {
    if (!files[`EPUB/${item.href}`]) {
      throw new Error(`EPUB manifest has dangling reference ${item.href}`)
    }
  }
  const spineReferences = [...opf.matchAll(/<itemref\b[^>]*\/?\s*>/g)].map(
    (match) => tagAttributes(match[0]).get('idref') ?? '',
  )
  if (spineReferences.length === 0 || spineReferences.some((id) => !id)) {
    throw new Error('EPUB OPF spine is missing a content reference')
  }
  if (new Set(spineReferences).size !== spineReferences.length) {
    throw new Error('EPUB OPF spine contains a duplicate content reference')
  }
  for (const idref of spineReferences) {
    const item = byId.get(idref)
    if (!item) throw new Error(`EPUB spine references missing item ${idref}`)
    if (item.mediaType !== 'application/xhtml+xml') {
      throw new Error(`EPUB spine item ${idref} is not XHTML content`)
    }
  }
  if (
    spineReferences.length !== 1 ||
    byId.get(spineReferences[0])?.href !== 'content.xhtml'
  ) {
    throw new Error(
      'EPUB spine must resolve exactly to the previewed content.xhtml document',
    )
  }
  const navigation = items.filter((item) =>
    item.properties.split(/\s+/).includes('nav'),
  )
  if (
    navigation.length !== 1 ||
    navigation[0].mediaType !== 'application/xhtml+xml'
  ) {
    throw new Error('EPUB OPF must declare exactly one XHTML navigation item')
  }
  return {
    items,
    byId,
    byHref: new Map(items.map((item) => [item.href, item])),
  }
}

function pngCrc32(bytes: Uint8Array) {
  let crc = 0xffff_ffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0)
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function validPngStructure(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (
    bytes.length < 45 ||
    signature.some((value, index) => bytes[index] !== value)
  ) {
    return false
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = signature.length
  let firstChunk = true
  let sawImageData = false
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    if (length > bytes.length - offset - 12) return false
    const typeOffset = offset + 4
    const dataOffset = offset + 8
    const crcOffset = dataOffset + length
    const nextOffset = crcOffset + 4
    const type = strFromU8(bytes.subarray(typeOffset, dataOffset))
    if (!/^[A-Za-z]{4}$/.test(type)) return false
    if (
      pngCrc32(bytes.subarray(typeOffset, crcOffset)) !==
      view.getUint32(crcOffset)
    ) {
      return false
    }
    if (firstChunk) {
      if (type !== 'IHDR' || length !== 13) return false
      const width = view.getUint32(dataOffset)
      const height = view.getUint32(dataOffset + 4)
      const bitDepth = bytes[dataOffset + 8]
      const colorType = bytes[dataOffset + 9]
      const validBitDepth =
        (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
        ((colorType === 2 || colorType === 4 || colorType === 6) &&
          [8, 16].includes(bitDepth)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth))
      if (
        width === 0 ||
        height === 0 ||
        width > 0x7fff_ffff ||
        height > 0x7fff_ffff ||
        !validBitDepth ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        ![0, 1].includes(bytes[dataOffset + 12])
      ) {
        return false
      }
    } else if (type === 'IHDR') {
      return false
    }
    if (
      type.charCodeAt(0) >= 65 &&
      type.charCodeAt(0) <= 90 &&
      !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)
    ) {
      return false
    }
    if (type === 'IDAT') sawImageData = true
    if (type === 'IEND') {
      return length === 0 && sawImageData && nextOffset === bytes.length
    }
    firstChunk = false
    offset = nextOffset
  }
  return false
}

function validJpegStructure(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return false
  }
  const frameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ])
  let offset = 2
  let sawFrame = false
  let sawScan = false
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) return false
    const marker = bytes[offset]
    offset += 1
    if (marker === 0x00 || marker === 0xd8) return false
    if (marker === 0xd9) {
      return sawFrame && sawScan && offset === bytes.length
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return false
    const length = (bytes[offset] << 8) | bytes[offset + 1]
    if (length < 2 || length > bytes.length - offset) return false
    if (frameMarkers.has(marker)) sawFrame = true
    if (marker !== 0xda) {
      offset += length
      continue
    }
    sawScan = true
    offset += length
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const markerOffset = offset
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
      if (offset >= bytes.length) return false
      const scanMarker = bytes[offset]
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        offset += 1
        continue
      }
      offset = markerOffset
      break
    }
  }
  return false
}

function skipGifSubBlocks(bytes: Uint8Array, start: number) {
  let offset = start
  while (offset < bytes.length) {
    const length = bytes[offset]
    offset += 1
    if (length === 0) return offset
    if (length > bytes.length - offset) return -1
    offset += length
  }
  return -1
}

function validGifStructure(bytes: Uint8Array) {
  if (
    bytes.length < 14 ||
    !/^GIF8[79]a$/.test(strFromU8(bytes.subarray(0, 6)))
  ) {
    return false
  }
  const width = bytes[6] | (bytes[7] << 8)
  const height = bytes[8] | (bytes[9] << 8)
  if (width === 0 || height === 0) return false
  const globalColorTableBytes =
    bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 0x07) + 1) : 0
  let offset = 13 + globalColorTableBytes
  if (offset > bytes.length) return false
  let sawImage = false
  while (offset < bytes.length) {
    const blockType = bytes[offset]
    offset += 1
    if (blockType === 0x3b) return sawImage && offset === bytes.length
    if (blockType === 0x21) {
      if (offset >= bytes.length) return false
      offset = skipGifSubBlocks(bytes, offset + 1)
      if (offset < 0) return false
      continue
    }
    if (blockType !== 0x2c || offset + 9 > bytes.length) return false
    const imageWidth = bytes[offset + 4] | (bytes[offset + 5] << 8)
    const imageHeight = bytes[offset + 6] | (bytes[offset + 7] << 8)
    if (imageWidth === 0 || imageHeight === 0) return false
    const localColorTableBytes =
      bytes[offset + 8] & 0x80 ? 3 * 2 ** ((bytes[offset + 8] & 0x07) + 1) : 0
    offset += 9 + localColorTableBytes
    if (offset >= bytes.length || bytes[offset] === 0) return false
    offset = skipGifSubBlocks(bytes, offset + 1)
    if (offset < 0) return false
    sawImage = true
  }
  return false
}

export function validateAssetMedia(
  bytes: Uint8Array,
  mediaType: string,
  href: string,
) {
  const valid =
    mediaType === 'image/png'
      ? validPngStructure(bytes)
      : mediaType === 'image/jpeg'
        ? validJpegStructure(bytes)
        : mediaType === 'image/gif'
          ? validGifStructure(bytes)
          : mediaType === 'image/svg+xml' ||
              mediaType === 'application/xhtml+xml'
            ? (() => {
                const value = strFromU8(bytes)
                requireWellFormedXml(value, `EPUB asset ${href}`)
                return mediaType === 'image/svg+xml'
                  ? /<svg\b/.test(value)
                  : /<html\b/.test(value)
              })()
            : false
  if (!valid) {
    throw new Error(`EPUB asset ${href} bytes do not match ${mediaType}`)
  }
}
