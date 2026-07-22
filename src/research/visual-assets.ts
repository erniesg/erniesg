import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate'
import type {
  NormalizedSourceBox,
  PdfRegionLine,
  PdfVisualAsset,
} from './import-types'
import { isBoundedPdfPageCropBox } from './pdf-page-crop'

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
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(name: string, data: Uint8Array) {
  const type = strToU8(name)
  return concat(
    uint32(data.length),
    type,
    data,
    uint32(crc32(concat(type, data))),
  )
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
  const result = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const output = index * 4
    if (colorSpace === 'rgba') {
      result.set(pixels.subarray(output, output + 4), output)
      continue
    }
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

export type CanonicalTable = {
  rows: Array<{
    cells: Array<{
      text: string
      headerScope: 'column' | 'row' | null
      columnSpan: number
      rowSpan: number
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

export function canonicalTableFromLines(
  lines: PdfRegionLine[],
  options: {
    sourceHeaderLineIds?: readonly string[]
    detectedRectangularGeometry?: boolean
  } = {},
): CanonicalTable | null {
  const table = tableRows(lines, options)
  if (!table) return null
  const { bands, rows } = table
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
    exactSourceHeaderRole || headerRuns.every(hasExplicitHeaderStyle)
  const bodyHasNonHeaderStyle = rows
    .slice(1)
    .flat()
    .some((run) => !hasExplicitHeaderStyle(run))
  if (!explicitHeader || !bodyHasNonHeaderStyle) return null
  return {
    rows: rows.map((row, rowIndex) => ({
      cells: row.map((cell) => ({
        text: cell.text,
        headerScope: rowIndex === 0 ? 'column' : null,
        columnSpan: 1,
        rowSpan: 1,
      })),
    })),
  }
}

export async function createTableAsset(input: {
  sourceObjectId: string
  sourceBox: NormalizedSourceBox
  lines: PdfRegionLine[]
  sourceHeaderLineIds?: readonly string[]
  detectedRectangularGeometry?: boolean
  pageWidth: number
  pageHeight: number
}) {
  const table = canonicalTableFromLines(input.lines, {
    sourceHeaderLineIds: input.sourceHeaderLineIds,
    detectedRectangularGeometry: input.detectedRectangularGeometry,
  })
  if (!table) return null
  const [head, ...body] = table.rows
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="UTF-8" /><title>Source table</title></head><body><table><thead><tr>${head.cells.map((cell) => `<th scope="col">${xml(cell.text)}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.cells.map((cell) => `<td>${xml(cell.text)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>
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
