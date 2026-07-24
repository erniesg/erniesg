import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate'
import type {
  NormalizedSourceBox,
  PdfEmbeddedLink,
  PdfPageRegion,
  PdfRegionLine,
  PdfSourceRun,
  PdfVisualAsset,
} from './import-types'
import { isBoundedPdfPageCropBox } from './pdf-page-crop'
import {
  PDF_TABLE_COLUMN_CENTER_TOLERANCE,
  type PdfDetectedTableGrid,
} from './pdf-table-detection'

function xml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array) {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index
    const value =
      (bytes[index] << 16) |
      ((remaining > 1 ? bytes[index + 1] : 0) << 8) |
      (remaining > 2 ? bytes[index + 2] : 0)
    output += BASE64_ALPHABET[(value >>> 18) & 63]
    output += BASE64_ALPHABET[(value >>> 12) & 63]
    output += remaining > 1 ? BASE64_ALPHABET[(value >>> 6) & 63] : '='
    output += remaining > 2 ? BASE64_ALPHABET[value & 63] : '='
  }
  return output
}

function finite(value: number) {
  return Number.isFinite(value) ? value : 0
}

function rounded(value: number) {
  return Math.round(finite(value) * 1000) / 1000
}

async function sha256(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

function extension(mediaType: PdfVisualAsset['mediaType']) {
  if (mediaType === 'image/png') return 'png'
  if (mediaType === 'image/svg+xml') return 'svg'
  return 'xhtml'
}

async function asset({
  bytes,
  mediaType,
  kind,
  rendition,
  width,
  height,
  resolutionDpi,
  sourceObjectIds,
  sourceBoxes,
  sourceCropBox,
  identityKey,
}: Omit<PdfVisualAsset, 'id' | 'href' | 'sha256'> & {
  identityKey?: string
}) {
  const hash = await sha256(bytes)
  const identityHash = identityKey
    ? await sha256(strToU8(`${hash}\n${identityKey}`))
    : hash
  const id = `asset-${identityHash.slice(0, 24)}`
  return {
    id,
    href: `assets/${id}.${extension(mediaType)}`,
    mediaType,
    kind,
    rendition,
    sha256: hash,
    bytes,
    width: rounded(width),
    height: rounded(height),
    resolutionDpi,
    sourceObjectIds: [...sourceObjectIds],
    sourceBoxes: sourceBoxes.map((box) => ({ ...box })),
    ...(sourceCropBox ? { sourceCropBox: { ...sourceCropBox } } : {}),
  } satisfies PdfVisualAsset
}

function uint32(value: number) {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

function concat(...parts: Uint8Array[]) {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  )
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return crc >>> 0
})

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(name: string, data: Uint8Array) {
  const type = strToU8(name)
  const chunk = new Uint8Array(data.length + 12)
  chunk.set(uint32(data.length), 0)
  chunk.set(type, 4)
  chunk.set(data, 8)
  chunk.set(uint32(crc32(chunk.subarray(4, 8 + data.length))), 8 + data.length)
  return chunk
}

function rgbaPixels({
  pixels,
  width,
  height,
  colorSpace,
}: {
  pixels: Uint8Array
  width: number
  height: number
  colorSpace: 'grayscale-1bpp' | 'rgb' | 'rgba'
}) {
  if (colorSpace === 'rgba') return pixels
  const result = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const output = index * 4
    if (colorSpace === 'rgb') {
      result.set(pixels.subarray(index * 3, index * 3 + 3), output)
      result[output + 3] = 255
      continue
    }
    const bit = (pixels[index >> 3] >> (7 - (index & 7))) & 1
    const gray = bit ? 255 : 0
    result.set([gray, gray, gray, 255], output)
  }
  return result
}

function encodePng(input: {
  pixels: Uint8Array
  width: number
  height: number
  colorSpace: 'grayscale-1bpp' | 'rgb' | 'rgba'
}) {
  if (
    !Number.isInteger(input.width) ||
    input.width < 1 ||
    !Number.isInteger(input.height) ||
    input.height < 1
  ) {
    throw new Error('PNG dimensions must be positive integers')
  }
  const rgba = rgbaPixels(input)
  const rowLength = input.width * 4
  const scanlines = new Uint8Array((rowLength + 1) * input.height)
  for (let row = 0; row < input.height; row += 1) {
    const target = row * (rowLength + 1)
    scanlines[target] = 0
    scanlines.set(
      rgba.subarray(row * rowLength, (row + 1) * rowLength),
      target + 1,
    )
  }
  const header = new Uint8Array(13)
  header.set(uint32(input.width), 0)
  header.set(uint32(input.height), 4)
  header.set([8, 6, 0, 0, 0], 8)
  return concat(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlibSync(scanlines, { level: 9 })),
    pngChunk('IEND', new Uint8Array()),
  )
}

function readUint32(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  )
}

function decodeGeneratedPng(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!signature.every((value, index) => bytes[index] === value)) {
    throw new Error('Profile downscaling requires a PNG source asset')
  }
  let offset = 8
  let width = 0
  let height = 0
  const compressed: Uint8Array[] = []
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset)
    const type = strFromU8(bytes.subarray(offset + 4, offset + 8))
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = readUint32(data, 0)
      height = readUint32(data, 4)
      if (
        data[8] !== 8 ||
        data[9] !== 6 ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        throw new Error('Profile downscaling supports deterministic RGBA PNGs')
      }
    } else if (type === 'IDAT') {
      compressed.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += length + 12
  }
  if (!width || !height || compressed.length === 0) {
    throw new Error('Profile downscaling received an incomplete PNG')
  }
  const scanlines = unzlibSync(concat(...compressed))
  const rowLength = width * 4
  if (scanlines.length !== (rowLength + 1) * height) {
    throw new Error('Profile downscaling received unexpected PNG scanlines')
  }
  const pixels = new Uint8Array(rowLength * height)
  for (let row = 0; row < height; row += 1) {
    const source = row * (rowLength + 1)
    if (scanlines[source] !== 0) {
      throw new Error('Profile downscaling requires unfiltered PNG scanlines')
    }
    pixels.set(
      scanlines.subarray(source + 1, source + 1 + rowLength),
      row * rowLength,
    )
  }
  return { width, height, pixels }
}

function hasNontrivialSourceInk(
  pixels: Uint8Array,
  width: number,
  height: number,
) {
  if (pixels.byteLength !== width * height * 4) return false
  const minimumInkPixels = Math.max(4, Math.ceil(width * height * 0.0001))
  let inkPixels = 0
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3] / 255
    const red = pixels[offset] * alpha + 255 * (1 - alpha)
    const green = pixels[offset + 1] * alpha + 255 * (1 - alpha)
    const blue = pixels[offset + 2] * alpha + 255 * (1 - alpha)
    if (Math.min(red, green, blue) < 248) inkPixels += 1
    if (inkPixels >= minimumInkPixels) return true
  }
  return false
}

export function isValidSourcePageCropPayload(asset: PdfVisualAsset) {
  if (
    asset.rendition !== 'source-page-crop' ||
    asset.mediaType !== 'image/png' ||
    !asset.sourceCropBox ||
    !isBoundedPdfPageCropBox(asset.sourceCropBox) ||
    !Number.isInteger(asset.width) ||
    asset.width < 2 ||
    !Number.isInteger(asset.height) ||
    asset.height < 2 ||
    asset.bytes.byteLength === 0
  ) {
    return false
  }
  try {
    const decoded = decodeGeneratedPng(asset.bytes)
    return (
      decoded.width === asset.width &&
      decoded.height === asset.height &&
      hasNontrivialSourceInk(decoded.pixels, decoded.width, decoded.height)
    )
  } catch {
    return false
  }
}

export async function downscalePngAsset(
  source: PdfVisualAsset,
  maximumWidth: number,
  pixelsPerInch: number,
) {
  if (source.mediaType !== 'image/png' || source.width <= maximumWidth) {
    return source
  }
  const decoded = decodeGeneratedPng(source.bytes)
  if (decoded.width !== source.width || decoded.height !== source.height) {
    throw new Error('PNG dimensions differ from visual-asset metadata')
  }
  const width = Math.max(1, Math.floor(maximumWidth))
  const height = Math.max(1, Math.round((source.height * width) / source.width))
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(
      source.height - 1,
      Math.floor((y * source.height) / height),
    )
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(
        source.width - 1,
        Math.floor((x * source.width) / width),
      )
      const from = (sourceY * source.width + sourceX) * 4
      pixels.set(decoded.pixels.subarray(from, from + 4), (y * width + x) * 4)
    }
  }
  return asset({
    bytes: encodePng({ pixels, width, height, colorSpace: 'rgba' }),
    mediaType: source.mediaType,
    kind: source.kind,
    rendition: 'profile-downscaled',
    width,
    height,
    resolutionDpi: pixelsPerInch,
    sourceObjectIds: source.sourceObjectIds,
    sourceBoxes: source.sourceBoxes,
    ...(source.sourceCropBox
      ? {
          sourceCropBox: source.sourceCropBox,
          identityKey: JSON.stringify({
            sourceAssetId: source.id,
            sourceCropBox: source.sourceCropBox,
            maximumWidth,
            pixelsPerInch,
          }),
        }
      : {}),
  })
}

export async function createPngAsset(input: {
  sourceObjectId: string
  sourceBox: NormalizedSourceBox
  width: number
  height: number
  colorSpace: 'grayscale-1bpp' | 'rgb' | 'rgba'
  pixels: Uint8Array
}) {
  return asset({
    bytes: encodePng(input),
    mediaType: 'image/png',
    kind: 'raster',
    rendition: 'source-preserved',
    width: input.width,
    height: input.height,
    resolutionDpi: null,
    sourceObjectIds: [input.sourceObjectId],
    sourceBoxes: [input.sourceBox],
  })
}

export async function createCompositePngAsset(input: {
  sourceObjectIds: string[]
  sourceBoxes: NormalizedSourceBox[]
  width: number
  height: number
  pixels: Uint8Array
}) {
  if (
    input.sourceObjectIds.length < 2 ||
    input.sourceObjectIds.length !== input.sourceBoxes.length
  ) {
    throw new Error(
      'Composite PNG assets require a source box for every source object',
    )
  }
  return asset({
    bytes: encodePng({ ...input, colorSpace: 'rgba' }),
    mediaType: 'image/png',
    kind: 'raster',
    rendition: 'browser-composite-raster',
    width: input.width,
    height: input.height,
    resolutionDpi: null,
    sourceObjectIds: input.sourceObjectIds,
    sourceBoxes: input.sourceBoxes,
  })
}

export async function createSourcePageCropAsset(input: {
  kind: 'raster' | 'table' | 'equation'
  cropBox: NormalizedSourceBox
  sourceObjectIds: string[]
  sourceBoxes: NormalizedSourceBox[]
  width: number
  height: number
  pixels: Uint8Array
}) {
  if (
    input.sourceObjectIds.length === 0 ||
    input.sourceObjectIds.length !== input.sourceBoxes.length ||
    new Set(input.sourceObjectIds).size !== input.sourceObjectIds.length ||
    input.sourceObjectIds.some((id) => !id.trim())
  ) {
    throw new Error(
      'Source page crops require one unique source box for every source object',
    )
  }
  const geometry = [
    input.cropBox.x,
    input.cropBox.y,
    input.cropBox.width,
    input.cropBox.height,
  ]
  if (
    !Number.isInteger(input.cropBox.page) ||
    input.cropBox.page < 1 ||
    geometry.some((value) => !Number.isFinite(value)) ||
    input.cropBox.x < 0 ||
    input.cropBox.y < 0 ||
    input.cropBox.width <= 0 ||
    input.cropBox.height <= 0 ||
    input.cropBox.x + input.cropBox.width > 1 ||
    input.cropBox.y + input.cropBox.height > 1 ||
    !isBoundedPdfPageCropBox(input.cropBox) ||
    input.sourceBoxes.some((box) => box.page !== input.cropBox.page)
  ) {
    throw new Error(
      'Source page crops require one valid bounded source region on one page',
    )
  }
  if (
    !Number.isInteger(input.width) ||
    input.width < 2 ||
    !Number.isInteger(input.height) ||
    input.height < 2 ||
    input.pixels.byteLength !== input.width * input.height * 4
  ) {
    throw new Error('Source page crops require complete RGBA source pixels')
  }
  if (!hasNontrivialSourceInk(input.pixels, input.width, input.height)) {
    throw new Error('Source page crop contains no nontrivial source ink')
  }
  const boxIdentity = (box: NormalizedSourceBox) => [
    box.page,
    box.x,
    box.y,
    box.width,
    box.height,
    box.rotation,
    box.method,
  ]
  const identityKey = JSON.stringify({
    kind: input.kind,
    cropBox: boxIdentity(input.cropBox),
    lineage: input.sourceObjectIds.map((sourceObjectId, index) => [
      sourceObjectId,
      boxIdentity(input.sourceBoxes[index]),
    ]),
  })
  return asset({
    bytes: encodePng({ ...input, colorSpace: 'rgba' }),
    mediaType: 'image/png',
    kind: input.kind,
    rendition: 'source-page-crop',
    width: input.width,
    height: input.height,
    resolutionDpi: null,
    sourceObjectIds: input.sourceObjectIds,
    sourceBoxes: input.sourceBoxes,
    sourceCropBox: input.cropBox,
    identityKey,
  })
}

export async function createHeadlessCompositePngAsset(input: {
  sourceBox: NormalizedSourceBox
  fragments: Array<{
    sourceObjectId: string
    sourceBox: NormalizedSourceBox
    asset: PdfVisualAsset
  }>
}) {
  if (input.fragments.length < 2) {
    throw new Error('Headless composites require at least two source fragments')
  }
  const decoded = input.fragments.map((fragment) => {
    if (
      fragment.asset.mediaType !== 'image/png' ||
      fragment.asset.rendition !== 'source-preserved' ||
      fragment.asset.bytes.byteLength === 0 ||
      fragment.sourceBox.page !== input.sourceBox.page
    ) {
      throw new Error(
        'Headless composites require same-page source-preserved PNG fragments',
      )
    }
    return { ...fragment, decoded: decodeGeneratedPng(fragment.asset.bytes) }
  })
  const sourceScaleX = Math.max(
    ...decoded.map(
      (fragment) => fragment.decoded.width / fragment.sourceBox.width,
    ),
  )
  const sourceScaleY = Math.max(
    ...decoded.map(
      (fragment) => fragment.decoded.height / fragment.sourceBox.height,
    ),
  )
  let width = Math.max(1, Math.ceil(input.sourceBox.width * sourceScaleX))
  let height = Math.max(1, Math.ceil(input.sourceBox.height * sourceScaleY))
  const maximumPixels = 16_000_000
  const maximumDimension = 4096
  const reduction = Math.min(
    1,
    maximumDimension / Math.max(width, height),
    Math.sqrt(maximumPixels / (width * height)),
  )
  width = Math.max(1, Math.floor(width * reduction))
  height = Math.max(1, Math.floor(height * reduction))
  const pixels = new Uint8Array(width * height * 4).fill(255)
  const outputScaleX = width / input.sourceBox.width
  const outputScaleY = height / input.sourceBox.height
  for (const fragment of decoded) {
    const left = Math.round(
      (fragment.sourceBox.x - input.sourceBox.x) * outputScaleX,
    )
    const top = Math.round(
      (fragment.sourceBox.y - input.sourceBox.y) * outputScaleY,
    )
    const fragmentWidth = Math.max(
      1,
      Math.round(fragment.sourceBox.width * outputScaleX),
    )
    const fragmentHeight = Math.max(
      1,
      Math.round(fragment.sourceBox.height * outputScaleY),
    )
    for (let y = 0; y < fragmentHeight; y += 1) {
      const targetY = top + y
      if (targetY < 0 || targetY >= height) continue
      const sourceY = Math.min(
        fragment.decoded.height - 1,
        Math.floor((y * fragment.decoded.height) / fragmentHeight),
      )
      for (let x = 0; x < fragmentWidth; x += 1) {
        const targetX = left + x
        if (targetX < 0 || targetX >= width) continue
        const sourceX = Math.min(
          fragment.decoded.width - 1,
          Math.floor((x * fragment.decoded.width) / fragmentWidth),
        )
        const sourceOffset = (sourceY * fragment.decoded.width + sourceX) * 4
        const targetOffset = (targetY * width + targetX) * 4
        const alpha = fragment.decoded.pixels[sourceOffset + 3] / 255
        if (alpha === 0) continue
        for (let channel = 0; channel < 3; channel += 1) {
          pixels[targetOffset + channel] = Math.round(
            fragment.decoded.pixels[sourceOffset + channel] * alpha +
              pixels[targetOffset + channel] * (1 - alpha),
          )
        }
        pixels[targetOffset + 3] = 255
      }
    }
  }
  return createCompositePngAsset({
    sourceObjectIds: input.fragments.map((fragment) => fragment.sourceObjectId),
    sourceBoxes: input.fragments.map((fragment) => fragment.sourceBox),
    width,
    height,
    pixels,
  })
}

export async function createHeadlessCompositeSvgAsset(input: {
  sourceBox: NormalizedSourceBox
  fragments: Array<{
    sourceObjectId: string
    sourceBox: NormalizedSourceBox
    asset: PdfVisualAsset
  }>
}) {
  if (
    input.fragments.length < 2 ||
    input.fragments.some(
      (fragment) =>
        fragment.sourceBox.page !== input.sourceBox.page ||
        !fragment.asset.mediaType.startsWith('image/') ||
        fragment.asset.rendition !== 'source-preserved' ||
        fragment.asset.bytes.byteLength === 0,
    )
  ) {
    throw new Error(
      'Headless SVG composites require same-page preserved image fragments',
    )
  }
  const scale = 1000
  const width = Math.max(1, input.sourceBox.width * scale)
  const height = Math.max(1, input.sourceBox.height * scale)
  const content = input.fragments
    .map((fragment) => {
      const x = rounded((fragment.sourceBox.x - input.sourceBox.x) * scale)
      const y = rounded((fragment.sourceBox.y - input.sourceBox.y) * scale)
      const fragmentWidth = rounded(fragment.sourceBox.width * scale)
      const fragmentHeight = rounded(fragment.sourceBox.height * scale)
      const href = `data:${fragment.asset.mediaType};base64,${base64(fragment.asset.bytes)}`
      return `<image href="${xml(href)}" x="${x}" y="${y}" width="${fragmentWidth}" height="${fragmentHeight}" preserveAspectRatio="none" />`
    })
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${rounded(width)} ${rounded(height)}" role="img" data-pdf-composite="true">${content}</svg>\n`
  return asset({
    bytes: strToU8(svg),
    mediaType: 'image/svg+xml',
    kind: 'vector',
    rendition: 'source-preserved',
    width,
    height,
    resolutionDpi: null,
    sourceObjectIds: input.fragments.map((fragment) => fragment.sourceObjectId),
    sourceBoxes: input.fragments.map((fragment) => fragment.sourceBox),
  })
}

export async function createVectorSvgAsset(input: {
  sourceObjectId: string
  sourceBox: NormalizedSourceBox
  path: string
  viewBox: { x: number; y: number; width: number; height: number }
  paint: 'fill' | 'stroke' | 'fill-stroke'
}) {
  const fill = input.paint === 'stroke' ? 'none' : '#000'
  const stroke = input.paint === 'fill' ? 'none' : '#000'
  const viewBox = [
    input.viewBox.x,
    input.viewBox.y,
    input.viewBox.width,
    input.viewBox.height,
  ]
    .map(rounded)
    .join(' ')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img"><path d="${xml(input.path)}" fill="${fill}" stroke="${stroke}" vector-effect="non-scaling-stroke" /></svg>\n`
  return asset({
    bytes: strToU8(svg),
    mediaType: 'image/svg+xml',
    kind: 'vector',
    rendition: 'bounded-svg-fallback',
    width: input.viewBox.width,
    height: input.viewBox.height,
    resolutionDpi: null,
    sourceObjectIds: [input.sourceObjectId],
    sourceBoxes: [input.sourceBox],
  })
}

export async function createTextSvgAsset(input: {
  kind: 'table' | 'equation'
  sourceObjectId: string
  sourceBox: NormalizedSourceBox
  lines: PdfRegionLine[]
  pageWidth: number
  pageHeight: number
}) {
  const runs = input.lines.flatMap((line) => line.runs)
  const left = Math.min(input.sourceBox.x, ...runs.map((run) => run.x))
  const top = Math.min(input.sourceBox.y, ...runs.map((run) => run.y))
  const right = Math.max(
    input.sourceBox.x + input.sourceBox.width,
    ...runs.map((run) => run.x + run.width),
  )
  const bottom = Math.max(
    input.sourceBox.y + input.sourceBox.height,
    ...runs.map((run) => run.y + run.height),
  )
  // PDF text boxes commonly stop at the baseline. A fixed one-point inset is
  // enough to preserve superscript/subscript and descender ink without
  // guessing at font metrics or changing the source lineage box.
  const inset = 1
  const width = Math.max(1, (right - left) * input.pageWidth + inset * 2)
  const height = Math.max(1, (bottom - top) * input.pageHeight + inset * 2)
  const content = runs
    .map((run) => {
      const x = rounded((run.x - left) * input.pageWidth + inset)
      const y = rounded((run.y - top) * input.pageHeight + run.fontSize + inset)
      return `<text x="${x}" y="${y}" font-size="${rounded(run.fontSize)}">${xml(run.text)}</text>`
    })
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${rounded(width)} ${rounded(height)}" role="img"><g font-family="serif" fill="#000">${content}</g></svg>\n`
  return asset({
    bytes: strToU8(svg),
    mediaType: 'image/svg+xml',
    kind: input.kind,
    rendition: 'bounded-svg-fallback',
    width,
    height,
    resolutionDpi: null,
    sourceObjectIds: [input.sourceObjectId],
    sourceBoxes: [input.sourceBox],
  })
}

function tableRows(
  lines: PdfRegionLine[],
  options: { detectedRectangularGeometry?: boolean } = {},
) {
  const bands: PdfRegionLine[][] = []
  for (const line of [...lines].sort(
    (left, right) => left.box.y - right.box.y,
  )) {
    const band = bands.find(
      (candidate) => Math.abs(candidate[0].box.y - line.box.y) <= 0.004,
    )
    if (band) band.push(line)
    else bands.push([line])
  }
  const rows = bands.map((band) =>
    band
      .flatMap((line) => line.runs)
      .filter((run) => run.text.trim())
      .sort((left, right) => left.x - right.x),
  )
  const columnCount = rows[0]?.length ?? 0
  if (
    rows.length < 2 ||
    columnCount < 2 ||
    columnCount > 12 ||
    rows.some((row) => row.length !== columnCount)
  ) {
    return null
  }
  const anchors = rows[0].map((run) => run.x)
  if (
    rows.some(
      (row) =>
        row.some((run, index) => Math.abs(run.x - anchors[index]) > 0.035) ||
        (!options.detectedRectangularGeometry &&
          row.slice(1).some((run, index) => {
            const previous = row[index]
            return run.x - (previous.x + previous.width) < 0.012
          })),
    )
  ) {
    return null
  }
  return { bands, rows }
}

function validDetectedTableGrid(grid: PdfDetectedTableGrid) {
  if (
    grid.columnCount < 2 ||
    grid.columnCount > 12 ||
    grid.headerRowCount < 1 ||
    grid.headerRowCount >= grid.lines.length ||
    grid.lines.length < 2 ||
    grid.lines.some(
      (line) =>
        line.cells.length === 0 ||
        line.cells.length !== line.runs.length ||
        line.cells.some(
          (cell, index) =>
            cell.run !== line.runs[index] ||
            !Number.isInteger(cell.columnIndex) ||
            cell.columnIndex < 0 ||
            !Number.isInteger(cell.columnSpan) ||
            cell.columnSpan < 1 ||
            !Number.isInteger(cell.rowSpan) ||
            cell.rowSpan < 1,
        ),
    )
  ) {
    return false
  }
  const occupied = Array.from({ length: grid.lines.length }, () =>
    Array.from({ length: grid.columnCount }, () => false),
  )
  for (const [rowIndex, row] of grid.lines.entries()) {
    for (const cell of row.cells) {
      if (
        cell.columnIndex + cell.columnSpan > grid.columnCount ||
        rowIndex + cell.rowSpan > grid.lines.length
      ) {
        return false
      }
      for (
        let targetRow = rowIndex;
        targetRow < rowIndex + cell.rowSpan;
        targetRow += 1
      ) {
        for (
          let targetColumn = cell.columnIndex;
          targetColumn < cell.columnIndex + cell.columnSpan;
          targetColumn += 1
        ) {
          if (occupied[targetRow][targetColumn]) return false
          occupied[targetRow][targetColumn] = true
        }
      }
    }
  }
  return occupied.every((row) => row.every(Boolean))
}

export type CanonicalTable = {
  rows: Array<{
    cells: Array<{
      text: string
      headerScope: 'column' | 'row' | null
      columnSpan: number
      rowSpan: number
      id?: string
      headerIds?: string[]
      sourceRuns?: Array<{
        regionId: string
        lineId: string
        runIndex: number
        text: string
        box: NormalizedSourceBox
      }>
      inlineRuns?: Array<{
        start: number
        end: number
        bold?: boolean
        italic?: boolean
        href?: string
        annotationId?: string
        verticalAlign?: 'superscript' | 'subscript'
      }>
      inlineMapping?: {
        expected: number
        mapped: number
      }
    }>
  }>
}

function hasExplicitHeaderStyle(run: PdfRegionLine['runs'][number]) {
  return (
    run.bold === true ||
    /(?:bold|black|demi|semibold|(?:^|[-_])medi(?:um)?(?:$|[-_]))/i.test(
      run.fontName,
    )
  )
}

function fontNameIndicatesItalic(fontName: string) {
  return /(?:italic|ital(?:ic)?|oblique|(?:^|[-_])it(?:$|[-_]))/iu.test(
    fontName,
  )
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function tableRunVerticalAlign(
  rowRuns: readonly PdfSourceRun[],
  run: PdfSourceRun,
) {
  const maximumFontSize = Math.max(
    ...rowRuns.map((candidate) => candidate.fontSize),
  )
  if (run.fontSize >= maximumFontSize * 0.82) return undefined
  const baselineRuns = rowRuns.filter(
    (candidate) => candidate.fontSize >= maximumFontSize * 0.9,
  )
  const baselineCenter = median(
    baselineRuns.map((candidate) => candidate.y + candidate.height / 2),
  )
  const runCenter = run.y + run.height / 2
  const threshold = Math.max(
    0.0015,
    median(baselineRuns.map((candidate) => candidate.height)) * 0.12,
  )
  if (runCenter < baselineCenter - threshold) return 'superscript' as const
  if (runCenter > baselineCenter + threshold) return 'subscript' as const
  return undefined
}

function boxesOverlap(
  left: Pick<NormalizedSourceBox, 'page' | 'x' | 'y' | 'width' | 'height'>,
  right: Pick<NormalizedSourceBox, 'page' | 'x' | 'y' | 'width' | 'height'>,
) {
  return (
    left.page === right.page &&
    Math.min(left.x + left.width, right.x + right.width) >
      Math.max(left.x, right.x) &&
    Math.min(left.y + left.height, right.y + right.height) >
      Math.max(left.y, right.y)
  )
}

function safeTableHyperlink(value: string) {
  if (/[\u0000-\u0020\u007f\\]/u.test(value)) return false
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function normalizedSourceBox(run: PdfSourceRun): NormalizedSourceBox {
  return {
    page: run.page,
    x: run.x,
    y: run.y,
    width: run.width,
    height: run.height,
    rotation: run.rotation,
    method: run.method,
  }
}

function tableLineSourceIds(line: PdfRegionLine) {
  const detected = line as PdfRegionLine & { sourceLineIds?: string[] }
  return detected.sourceLineIds?.length ? detected.sourceLineIds : [line.id]
}

function sameSourceRun(left: PdfSourceRun, right: PdfSourceRun) {
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.000_001
  return (
    left.text === right.text &&
    left.page === right.page &&
    close(left.x, right.x) &&
    close(left.y, right.y) &&
    close(left.width, right.width) &&
    close(left.height, right.height) &&
    left.rotation === right.rotation &&
    left.method === right.method
  )
}

function sameSourceBackedDetectedCell(
  source: PdfSourceRun,
  detected: PdfSourceRun,
) {
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.000_001
  return (
    source.text === detected.text &&
    source.page === detected.page &&
    Math.abs(source.x - detected.x) <= PDF_TABLE_COLUMN_CENTER_TOLERANCE &&
    close(source.y, detected.y) &&
    close(source.width, detected.width) &&
    close(source.height, detected.height) &&
    source.rotation === detected.rotation &&
    source.method === detected.method &&
    source.fontName === detected.fontName &&
    close(source.fontSize, detected.fontSize) &&
    source.bold === detected.bold &&
    source.italic === detected.italic
  )
}

type OwnedTableSourceRun = {
  key: string
  regionId: string
  line: PdfRegionLine
  runIndex: number
  run: PdfSourceRun
}

function ownedTableSourceRunKey(
  regionId: string,
  lineId: string,
  runIndex: number,
) {
  return `${regionId}\u0000${lineId}\u0000${runIndex}`
}

function orderedOwnedTableSourceRuns(
  runs: OwnedTableSourceRun[],
) {
  return [...runs].sort(
    (left, right) =>
      left.run.x - right.run.x ||
      left.run.y - right.run.y ||
      left.line.id.localeCompare(right.line.id) ||
      left.runIndex - right.runIndex,
  )
}

function tableSourceRunLayout(runs: readonly OwnedTableSourceRun[]) {
  let text = ''
  return runs.map((source, index) => {
    if (index > 0) {
      const previous = runs[index - 1].run
      const gap = source.run.x - (previous.x + previous.width)
      const noSpaceThreshold = Math.max(
        0.0005,
        Math.min(previous.height, source.run.height) * 0.18,
      )
      if (gap > noSpaceThreshold) text += ' '
    }
    const start = text.length
    text += source.run.text
    return { source, start, end: text.length, text }
  })
}

function sourceSequenceMatchesDetectedCell(
  sourceRuns: readonly OwnedTableSourceRun[],
  cell: PdfSourceRun,
) {
  if (sourceRuns.length === 0) return false
  const first = sourceRuns[0].run
  const right = Math.max(
    ...sourceRuns.map(({ run }) => run.x + run.width),
  )
  const bottom = Math.max(
    ...sourceRuns.map(({ run }) => run.y + run.height),
  )
  const derived = {
    ...first,
    width: right - first.x,
    height: bottom - first.y,
    text: tableSourceRunLayout(sourceRuns).at(-1)?.text ?? '',
  }
  return sameSourceBackedDetectedCell(derived, cell)
}

function exactSourceSequenceForDetectedCell(
  cell: PdfSourceRun,
  detectedLines: readonly PdfRegionLine[],
  sourceLineOwners: ReadonlyMap<
    string,
    Array<{ regionId: string; line: PdfRegionLine }>
  >,
) {
  const owningDetectedLines = detectedLines.filter((line) =>
    line.runs.includes(cell),
  )
  if (owningDetectedLines.length !== 1) return null
  const available = orderedOwnedTableSourceRuns(
    tableLineSourceIds(owningDetectedLines[0]).flatMap((lineId) => {
      const owner = sourceLineOwners.get(lineId)?.[0]
      if (!owner) return []
      return owner.line.runs.flatMap<OwnedTableSourceRun>(
        (run, runIndex) =>
          run.text.trim()
            ? [
                {
                  key: ownedTableSourceRunKey(
                    owner.regionId,
                    owner.line.id,
                    runIndex,
                  ),
                  regionId: owner.regionId,
                  line: owner.line,
                  runIndex,
                  run,
                },
              ]
            : [],
      )
    }),
  )
  const matches: OwnedTableSourceRun[][] = []
  for (let start = 0; start < available.length; start += 1) {
    for (let end = start + 1; end <= available.length; end += 1) {
      const sequence = available.slice(start, end)
      if (sourceSequenceMatchesDetectedCell(sequence, cell)) {
        matches.push(sequence)
      }
    }
  }
  return matches.length === 1 ? matches[0] : null
}

export function canonicalTableFromLines(
  lines: PdfRegionLine[],
  options: {
    sourceHeaderLineIds?: readonly string[]
    detectedRectangularGeometry?: boolean
    detectedGrid?: PdfDetectedTableGrid
    sourceRegions?: readonly PdfPageRegion[]
    links?: readonly PdfEmbeddedLink[]
  } = {},
): CanonicalTable | null {
  if (options.detectedGrid && !validDetectedTableGrid(options.detectedGrid)) {
    return null
  }
  const table = options.detectedGrid ? null : tableRows(lines, options)
  if (!table && !options.detectedGrid) return null
  const bands = options.detectedGrid
    ? options.detectedGrid.lines.map((line) => [line])
    : table!.bands
  const rows = options.detectedGrid
    ? options.detectedGrid.lines.map((line) =>
        line.cells.map((cell) => cell.run),
      )
    : table!.rows
  const placements = options.detectedGrid
    ? options.detectedGrid.lines.map((line) =>
        line.cells.map((cell) => ({
          columnIndex: cell.columnIndex,
          columnSpan: cell.columnSpan,
          rowSpan: cell.rowSpan,
        })),
      )
    : rows.map((row) =>
        row.map((_, columnIndex) => ({
          columnIndex,
          columnSpan: 1,
          rowSpan: 1,
        })),
      )
  const headerRowCount = options.detectedGrid?.headerRowCount ?? 1
  const headerRuns = rows[0]
  const expectedHeaderLineIds = bands[0].map((line) => line.id).sort()
  const sourceHeaderLineIds = [
    ...new Set(options.sourceHeaderLineIds ?? []),
  ].sort()
  const exactSourceHeaderRole =
    sourceHeaderLineIds.length > 0 &&
    sourceHeaderLineIds.length === expectedHeaderLineIds.length &&
    sourceHeaderLineIds.every(
      (lineId, index) => lineId === expectedHeaderLineIds[index],
    )
  const explicitHeader =
    Boolean(options.detectedGrid) ||
    exactSourceHeaderRole ||
    headerRuns.every(hasExplicitHeaderStyle)
  const bodyHasNonHeaderStyle = rows
    .slice(headerRowCount)
    .flat()
    .some((run) => !hasExplicitHeaderStyle(run))
  if (!explicitHeader || !bodyHasNonHeaderStyle) return null
  const sourceLineOwners = new Map<
    string,
    Array<{ regionId: string; line: PdfRegionLine }>
  >()
  for (const region of options.sourceRegions ?? []) {
    for (const sourceLine of region.lines) {
      const owners = sourceLineOwners.get(sourceLine.id) ?? []
      owners.push({ regionId: region.id, line: sourceLine })
      sourceLineOwners.set(sourceLine.id, owners)
    }
  }
  const sourceVerified = options.sourceRegions !== undefined
  if (
    sourceVerified &&
    lines.some((line) =>
      tableLineSourceIds(line).some(
        (lineId) => sourceLineOwners.get(lineId)?.length !== 1,
      ),
    )
  ) {
    return null
  }
  const sourceRowRuns = bands.map((band) =>
    orderedOwnedTableSourceRuns(
      [
        ...new Map(
          band
            .flatMap((detectedLine) =>
              tableLineSourceIds(detectedLine).flatMap((lineId) => {
                const owner = sourceLineOwners.get(lineId)?.[0]
                if (!owner) return []
                return owner.line.runs.flatMap<OwnedTableSourceRun>(
                  (run, runIndex) =>
                    run.text.trim()
                      ? [
                          {
                            key: ownedTableSourceRunKey(
                              owner.regionId,
                              owner.line.id,
                              runIndex,
                            ),
                            regionId: owner.regionId,
                            line: owner.line,
                            runIndex,
                            run,
                          },
                        ]
                      : [],
                )
              }),
            )
            .map((source) => [source.key, source]),
        ).values(),
      ],
    ),
  )
  const claimedSourceRunKeys = new Set<string>()
  const claimedSourceRunKeysByRow = bands.map(() => [] as string[])
  let unresolvedInlineEvidence = false
  const headerIdsForCell = (
    rowIndex: number,
    columnIndex: number,
    columnSpan: number,
  ) =>
    placements
      .slice(0, Math.min(rowIndex, headerRowCount))
      .flatMap((row, headerRowIndex) =>
        row.flatMap((placement) =>
          placement.columnIndex <= columnIndex &&
          placement.columnIndex + placement.columnSpan >=
            columnIndex + columnSpan
            ? [
                `cell-r${headerRowIndex + 1}-c${placement.columnIndex + 1}`,
              ]
            : [],
        ),
      )
  const canonicalTable: CanonicalTable = {
    rows: rows.map((row, rowIndex) => ({
      cells: row.map((cell, columnIndex) => {
        const placement = placements[rowIndex][columnIndex]
        const id = `cell-r${rowIndex + 1}-c${placement.columnIndex + 1}`
        const headerScope =
          rowIndex < headerRowCount ? ('column' as const) : null
        const headerIds =
          headerScope === null
            ? headerIdsForCell(
                rowIndex,
                placement.columnIndex,
                placement.columnSpan,
              )
            : []
        if (!sourceVerified) {
          return {
            text: cell.text,
            headerScope,
            columnSpan: placement.columnSpan,
            rowSpan: placement.rowSpan,
          }
        }
        const sourceMatches = exactSourceSequenceForDetectedCell(
          cell,
          bands[rowIndex],
          sourceLineOwners,
        )
        if (
          !sourceMatches ||
          sourceMatches.some((source) =>
            claimedSourceRunKeys.has(source.key),
          )
        ) {
          unresolvedInlineEvidence = true
          return {
            text: cell.text,
            headerScope,
            columnSpan: placement.columnSpan,
            rowSpan: placement.rowSpan,
          }
        }
        sourceMatches.forEach((source) =>
          claimedSourceRunKeys.add(source.key),
        )
        claimedSourceRunKeysByRow[rowIndex].push(
          ...sourceMatches.map((source) => source.key),
        )
        const layout = tableSourceRunLayout(sourceMatches)
        const rowRuns = sourceRowRuns[rowIndex].map(
          (source) => source.run,
        )
        const overlappingLinks = (options.links ?? []).flatMap((link) =>
          link.status === 'external' &&
          boxesOverlap(link.box, cell) &&
          safeTableHyperlink(link.url)
            ? [link]
            : [],
        )
        if (overlappingLinks.length > 1) unresolvedInlineEvidence = true
        const hyperlink =
          overlappingLinks.length === 1 ? overlappingLinks[0] : undefined
        const href = hyperlink?.url
        let expected = Number(Boolean(href))
        const inlineRuns: NonNullable<
          CanonicalTable['rows'][number]['cells'][number]['inlineRuns']
        > = layout.flatMap(
          ({ source, start, end }) => {
            const bold =
              source.run.bold === true ||
              (source.run.bold === undefined &&
                hasExplicitHeaderStyle(source.run))
            const italic =
              source.run.italic === true ||
              (source.run.italic === undefined &&
                fontNameIndicatesItalic(source.run.fontName))
            const verticalAlign = tableRunVerticalAlign(
              rowRuns,
              source.run,
            )
            const runExpected =
              Number(bold) +
              Number(italic) +
              Number(Boolean(verticalAlign))
            expected += runExpected
            return runExpected > 0
              ? [
                  {
                    start,
                    end,
                    ...(bold ? { bold: true } : {}),
                    ...(italic ? { italic: true } : {}),
                    ...(verticalAlign ? { verticalAlign } : {}),
                  },
                ]
              : []
          },
        )
        if (href) {
          const coextensive = inlineRuns.find(
            (run) =>
              run.start === 0 && run.end === cell.text.length,
          )
          if (coextensive) {
            Object.assign(coextensive, {
              href,
              annotationId: hyperlink!.id,
            })
          } else {
            inlineRuns.push({
              start: 0,
              end: cell.text.length,
              href,
              annotationId: hyperlink!.id,
            })
          }
        }
        return {
          id,
          text: cell.text,
          headerScope,
          headerIds,
          columnSpan: placement.columnSpan,
          rowSpan: placement.rowSpan,
          sourceRuns: sourceMatches.map((source) => ({
            regionId: source.regionId,
            lineId: source.line.id,
            runIndex: source.runIndex,
            text: source.run.text,
            box: normalizedSourceBox(source.run),
          })),
          ...(expected > 0
            ? {
                inlineRuns,
              }
            : {}),
          inlineMapping: {
            expected,
            mapped: expected,
          },
        }
      }),
    })),
  }
  if (sourceVerified) {
    const expectedSourceRunKeys = new Set(
      sourceRowRuns.flatMap((row) => row.map((source) => source.key)),
    )
    if (
      expectedSourceRunKeys.size !== claimedSourceRunKeys.size ||
      [...expectedSourceRunKeys].some(
        (key) => !claimedSourceRunKeys.has(key),
      ) ||
      sourceRowRuns.some((row, rowIndex) => {
        const expected = row.map((source) => source.key)
        const claimed = claimedSourceRunKeysByRow[rowIndex]
        return (
          expected.length !== claimed.length ||
          expected.some((key, index) => key !== claimed[index])
        )
      })
    ) {
      unresolvedInlineEvidence = true
    }
  }
  return unresolvedInlineEvidence ? null : canonicalTable
}

export async function createTableAsset(input: {
  sourceObjectId: string
  sourceBox: NormalizedSourceBox
  lines: PdfRegionLine[]
  sourceHeaderLineIds?: readonly string[]
  detectedRectangularGeometry?: boolean
  detectedGrid?: PdfDetectedTableGrid
  sourceRegions?: readonly PdfPageRegion[]
  links?: readonly PdfEmbeddedLink[]
  pageWidth: number
  pageHeight: number
}) {
  const table = canonicalTableFromLines(input.lines, {
    sourceHeaderLineIds: input.sourceHeaderLineIds,
    detectedRectangularGeometry: input.detectedRectangularGeometry,
    detectedGrid: input.detectedGrid,
    sourceRegions: input.sourceRegions,
    links: input.links,
  })
  if (!table) return null
  const inlineCellText = (
    cell: CanonicalTable['rows'][number]['cells'][number],
  ) => {
    const boundaries = [
      0,
      cell.text.length,
      ...(cell.inlineRuns ?? []).flatMap((run) => [run.start, run.end]),
    ]
    const points = [...new Set(boundaries)].sort(
      (left, right) => left - right,
    )
    return points
      .slice(0, -1)
      .map((start, index) => {
        const end = points[index + 1]
        const runs = (cell.inlineRuns ?? []).filter(
          (run) => run.start <= start && run.end >= end,
        )
        let content = xml(cell.text.slice(start, end))
        if (runs.some((run) => run.bold)) {
          content = `<strong>${content}</strong>`
        }
        if (runs.some((run) => run.italic)) {
          content = `<em>${content}</em>`
        }
        const verticalAlign = runs.find(
          (run) => run.verticalAlign,
        )?.verticalAlign
        if (verticalAlign) {
          content =
            verticalAlign === 'superscript'
              ? `<sup>${content}</sup>`
              : `<sub>${content}</sub>`
        }
        const href = runs.find((run) => run.href)?.href
        return href ? `<a href="${xml(href)}">${content}</a>` : content
      })
      .join('')
  }
  const rowXhtml = (
    row: CanonicalTable['rows'][number],
    rowIndex: number,
  ) =>
    `<tr>${row.cells
      .map((cell, columnIndex) => {
        const tag = cell.headerScope ? 'th' : 'td'
        const id = cell.id ?? `cell-r${rowIndex + 1}-c${columnIndex + 1}`
        const scope = cell.headerScope
          ? ` scope="${cell.headerScope === 'column' ? 'col' : 'row'}"`
          : ''
        const headers =
          cell.headerScope === null && (cell.headerIds?.length ?? 0) > 0
            ? ` headers="${xml(cell.headerIds!.join(' '))}"`
            : ''
        const columnSpan =
          cell.columnSpan > 1 ? ` colspan="${cell.columnSpan}"` : ''
        const rowSpan = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''
        return `<${tag} id="${xml(id)}"${scope}${headers}${columnSpan}${rowSpan}>${inlineCellText(cell)}</${tag}>`
      })
      .join('')}</tr>`
  const firstBodyRow = table.rows.findIndex(
    (row) => !row.cells.every((cell) => cell.headerScope === 'column'),
  )
  const headerRows =
    firstBodyRow === -1 ? table.rows : table.rows.slice(0, firstBodyRow)
  const bodyRows = firstBodyRow === -1 ? [] : table.rows.slice(firstBodyRow)
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="UTF-8" /><title>Source table</title></head><body><table>${headerRows.length > 0 ? `<thead>${headerRows.map((row, index) => rowXhtml(row, index)).join('')}</thead>` : ''}${bodyRows.length > 0 ? `<tbody>${bodyRows.map((row, index) => rowXhtml(row, Math.max(firstBodyRow, 0) + index)).join('')}</tbody>` : ''}</table></body></html>
`
  return asset({
    bytes: strToU8(xhtml),
    mediaType: 'application/xhtml+xml',
    kind: 'table',
    rendition: 'semantic-table',
    width: input.sourceBox.width * input.pageWidth,
    height: input.sourceBox.height * input.pageHeight,
    resolutionDpi: null,
    sourceObjectIds: [input.sourceObjectId],
    sourceBoxes: [input.sourceBox],
  })
}
