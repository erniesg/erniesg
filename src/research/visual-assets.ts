import { strToU8, zlibSync } from 'fflate'
import type {
  NormalizedSourceBox,
  PdfRegionLine,
  PdfVisualAsset,
} from './import-types'

function xml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
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
}: Omit<PdfVisualAsset, 'id' | 'href' | 'sha256'>) {
  const hash = await sha256(bytes)
  const id = `asset-${hash.slice(0, 24)}`
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
    rendition: 'source-preserved',
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
  const width = Math.max(1, input.sourceBox.width * input.pageWidth)
  const height = Math.max(1, input.sourceBox.height * input.pageHeight)
  const content = input.lines
    .flatMap((line) => line.runs)
    .map((run) => {
      const x = rounded((run.x - input.sourceBox.x) * input.pageWidth)
      const y = rounded(
        (run.y - input.sourceBox.y) * input.pageHeight + run.fontSize,
      )
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

function tableRows(lines: PdfRegionLine[]) {
  const rows = lines.map((line) =>
    [...line.runs]
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
    rows.some((row) =>
      row.some((run, index) => Math.abs(run.x - anchors[index]) > 0.035),
    )
  ) {
    return null
  }
  return rows
}

export async function createTableAsset(input: {
  sourceObjectId: string
  sourceBox: NormalizedSourceBox
  lines: PdfRegionLine[]
  pageWidth: number
  pageHeight: number
}) {
  const rows = tableRows(input.lines)
  if (!rows) return createTextSvgAsset({ ...input, kind: 'table' })
  const [head, ...body] = rows
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="UTF-8" /><title>Source table</title></head><body><table><thead><tr>${head.map((cell) => `<th scope="col">${xml(cell.text)}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${xml(cell.text)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>
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
