import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
}

const CJK_GLYPHS = {
  本: [
    '000010000',
    '111111111',
    '000010000',
    '000111000',
    '001010100',
    '010010010',
    '100010001',
    '000010000',
    '001111100',
  ],
  地: [
    '001000100',
    '001010100',
    '111111110',
    '001010101',
    '001110101',
    '111010101',
    '001010101',
    '001010010',
    '000001100',
  ],
  研: [
    '111101111',
    '001000100',
    '010111111',
    '111010101',
    '101010101',
    '101111111',
    '101010101',
    '111010101',
    '000100010',
  ],
  究: [
    '000010000',
    '001111100',
    '010000010',
    '100101001',
    '000010000',
    '001111100',
    '001010000',
    '010010001',
    '100001110',
  ],
}

function escaped(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

function textCommand({ text, x, y, size = 11 }) {
  return `BT\n/F1 ${size} Tf\n${x} ${y} Td\n(${escaped(text)}) Tj\nET`
}

function rasterText({
  width,
  height,
  lines,
  scale = 7,
  decorations = [],
  marks = [],
}) {
  const pixels = new Uint8Array(width * height).fill(255)
  const paint = (x, y, value = 16) => {
    if (x >= 0 && x < width && y >= 0 && y < height)
      pixels[y * width + x] = value
  }
  for (const decoration of decorations) {
    for (let y = decoration.y; y < decoration.y + decoration.height; y += 1) {
      for (let x = decoration.x; x < decoration.x + decoration.width; x += 1) {
        paint(x, y, decoration.value ?? 80)
      }
    }
  }
  for (const line of lines) {
    let cursor = line.x
    for (const character of line.text.toUpperCase()) {
      if (character === ' ') {
        cursor += scale * 4
        continue
      }
      const glyph = GLYPHS[character] ?? GLYPHS['-']
      for (const [glyphY, row] of glyph.entries()) {
        for (const [glyphX, bit] of [...row].entries()) {
          if (bit !== '1') continue
          for (let dy = 0; dy < scale; dy += 1) {
            for (let dx = 0; dx < scale; dx += 1) {
              paint(cursor + glyphX * scale + dx, line.y + glyphY * scale + dy)
            }
          }
        }
      }
      cursor += scale * 6
    }
  }
  for (const mark of marks) {
    const glyph = CJK_GLYPHS[mark.text]
    for (const [glyphY, row] of glyph.entries()) {
      for (const [glyphX, bit] of [...row].entries()) {
        if (bit !== '1') continue
        for (let dy = 0; dy < mark.scale; dy += 1) {
          for (let dx = 0; dx < mark.scale; dx += 1) {
            paint(
              mark.x + glyphX * mark.scale + dx,
              mark.y + glyphY * mark.scale + dy,
            )
          }
        }
      }
    }
  }
  return { width, height, pixels }
}

function imageObject(raster) {
  const compressed = deflateSync(raster.pixels).toString('hex').toUpperCase()
  const encoded = `${compressed}>`
  return `<< /Type /XObject /Subtype /Image /Width ${raster.width} /Height ${raster.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode] /Length ${encoded.length} >>\nstream\n${encoded}\nendstream`
}

function createPdf(pageDefinitions) {
  const objects = []
  const reserve = () => {
    objects.push('')
    return objects.length
  }
  const set = (id, value) => {
    objects[id - 1] = value
  }

  const catalogId = reserve()
  const pagesId = reserve()
  const fontId = reserve()
  const pageIds = pageDefinitions.map(() => reserve())
  const contentIds = pageDefinitions.map(() => reserve())
  const imageIds = pageDefinitions.map((page) =>
    page.image ? reserve() : null,
  )

  set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  )
  set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  pageDefinitions.forEach((page, index) => {
    const commands = (page.lines ?? []).map(textCommand)
    const imageId = imageIds[index]
    if (page.image && imageId) {
      set(imageId, imageObject(page.image.raster))
      commands.push(
        `q\n${page.image.width} 0 0 ${page.image.height} ${page.image.x} ${page.image.y} cm\n/Im1 Do\nQ`,
      )
    }
    const content = commands.join('\n')
    const [mediaWidth, mediaHeight] = page.mediaBox ?? [612, 792]
    const xObjects = imageId ? `/XObject << /Im1 ${imageId} 0 R >>` : ''
    const rotation = page.rotation ? `/Rotate ${page.rotation}` : ''
    set(
      pageIds[index],
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${mediaWidth} ${mediaHeight}] ${rotation} /Resources << /Font << /F1 ${fontId} 0 R >> ${xObjects} >> /Contents ${contentIds[index]} 0 R >>`,
    )
    set(
      contentIds[index],
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    )
  })

  let pdf = '%PDF-1.4\n% synthetic fixture owned by erniesg\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return pdf
}

const smallFigure = rasterText({
  width: 160,
  height: 100,
  scale: 3,
  lines: [{ text: 'FIGURE 1', x: 10, y: 35 }],
})
const scannedPage = rasterText({
  width: 900,
  height: 1200,
  scale: 5,
  lines: [
    { text: 'LOCAL OCR SCAN', x: 80, y: 150 },
    { text: 'THIS TEXT STAYS ON DEVICE', x: 80, y: 280 },
    { text: 'BOUNDING BOX EVIDENCE', x: 80, y: 410 },
  ],
})
const mixedRaster = rasterText({
  width: 900,
  height: 900,
  scale: 5,
  lines: [
    { text: 'RASTER PARAGRAPH', x: 80, y: 190 },
    { text: 'OCR COMPLETES THIS PAGE', x: 80, y: 330 },
  ],
})
const physicalSpread = rasterText({
  width: 1800,
  height: 1100,
  scale: 6,
  lines: [
    { text: 'LEFT PHYSICAL PAGE', x: 90, y: 150 },
    { text: 'LOCAL OCR LEFT', x: 90, y: 280 },
    { text: 'RIGHT PHYSICAL PAGE', x: 1020, y: 150 },
    { text: 'LOCAL OCR RIGHT', x: 1020, y: 280 },
  ],
  decorations: [{ x: 890, y: 40, width: 20, height: 1020, value: 225 }],
})
const rotatedScan = rasterText({
  width: 900,
  height: 1200,
  scale: 5,
  lines: [
    { text: 'ROTATED SOURCE PAGE', x: 90, y: 180 },
    { text: 'ROTATION IS PROVENANCE', x: 90, y: 320 },
  ],
})
const multilingualScan = rasterText({
  width: 900,
  height: 1200,
  scale: 5,
  lines: [
    { text: 'MULTILINGUAL SOURCE', x: 80, y: 150 },
    { text: 'LANGUAGE PACK REQUIRED', x: 80, y: 280 },
  ],
  marks: [
    { text: '本', x: 100, y: 470, scale: 8 },
    { text: '地', x: 220, y: 470, scale: 8 },
    { text: '研', x: 340, y: 470, scale: 8 },
    { text: '究', x: 460, y: 470, scale: 8 },
  ],
})

const fixtures = {
  'born-digital.pdf': [
    {
      lines: [
        { text: 'A Reconstructed Research Paper', x: 72, y: 720, size: 24 },
        {
          text: 'This paragraph contains enough embedded text to prove local PDF extraction.',
          x: 72,
          y: 670,
        },
        {
          text: 'Bounding boxes remain source evidence while the publication becomes reflowable.',
          x: 72,
          y: 646,
        },
      ],
    },
  ],
  'sparse-embedded-text.pdf': [
    {
      lines: [
        {
          text: 'Section divider',
          x: 72,
          y: 680,
          size: 20,
        },
      ],
    },
  ],
  'structured-scientific.pdf': [
    {
      lines: [
        {
          text: 'Synthetic semantic completeness fixture',
          x: 54,
          y: 750,
          size: 20,
        },
        {
          text: 'Left column line one introduces the experiment.',
          x: 54,
          y: 690,
        },
        { text: 'Left column line two preserves source order.', x: 54, y: 670 },
        { text: 'Left column line three points to Figure 1.', x: 54, y: 650 },
        {
          text: 'Left column line four has footnote reference 1.',
          x: 54,
          y: 630,
        },
        {
          text: 'Right column line one follows the left column.',
          x: 330,
          y: 690,
        },
        {
          text: 'Right column line two describes the visual result.',
          x: 330,
          y: 670,
        },
        {
          text: 'Right column line three introduces the fallback.',
          x: 330,
          y: 650,
        },
        {
          text: 'Right column line four closes the main reading flow.',
          x: 330,
          y: 630,
        },
        {
          text: 'Figure 1. A synthetic image and its semantic caption.',
          x: 180,
          y: 430,
        },
        {
          text: 'Table 1. Synthetic values require a table fallback.',
          x: 54,
          y: 370,
        },
        {
          text: 'Equation 1 (x + y = z) requires an atomic fallback.',
          x: 54,
          y: 340,
        },
        {
          text: 'Footnote 1: This note must stay linked to its reference.',
          x: 54,
          y: 70,
          size: 8,
        },
      ],
      image: { x: 220, y: 460, width: 170, height: 110, raster: smallFigure },
    },
  ],
  'scanned-page.pdf': [
    {
      image: { x: 54, y: 54, width: 504, height: 684, raster: scannedPage },
    },
  ],
  'mixed-page.pdf': [
    {
      lines: [
        {
          text: 'Mixed page with sparse embedded text.',
          x: 54,
          y: 720,
          size: 16,
        },
        {
          text: 'The remaining page content is a source image.',
          x: 54,
          y: 690,
        },
      ],
      image: { x: 54, y: 120, width: 504, height: 500, raster: mixedRaster },
    },
  ],
  'two-page-scan.pdf': [
    {
      mediaBox: [1224, 792],
      image: { x: 24, y: 24, width: 1176, height: 744, raster: physicalSpread },
    },
  ],
  'rotated-scan.pdf': [
    {
      rotation: 90,
      image: { x: 54, y: 54, width: 504, height: 684, raster: rotatedScan },
    },
  ],
  'multilingual-scan.pdf': [
    {
      image: {
        x: 54,
        y: 54,
        width: 504,
        height: 684,
        raster: multilingualScan,
      },
    },
  ],
}

for (const [name, pages] of Object.entries(fixtures)) {
  writeFileSync(new URL(name, import.meta.url), createPdf(pages))
}
