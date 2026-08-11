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
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '=': ['00000', '11111', '00000', '11111', '00000', '00000', '00000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
}

const CJK_GLYPHS = {
  // Arabic-Indic digit one. This tiny repository-owned bitmap lets the
  // association fixture visibly carry a non-Latin numeral without depending
  // on a host font or embedding a third-party typeface.
  '١': [
    '000011000',
    '000111000',
    '001011000',
    '000011000',
    '000011000',
    '000011000',
    '000011000',
    '000011000',
    '000111000',
  ],
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

function textCommand({ text, x, y, size = 11, font = 'F1', renderMode = 0 }) {
  const rendering = renderMode === 0 ? '' : `${renderMode} Tr\n`
  return `BT\n/${font} ${size} Tf\n${rendering}${x} ${y} Td\n(${escaped(text)}) Tj\nET`
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
    const glyphScale = line.scale ?? scale
    let cursor = line.x
    for (const character of line.text.toUpperCase()) {
      if (character === ' ') {
        cursor += glyphScale * 4
        continue
      }
      const glyph = GLYPHS[character] ?? GLYPHS['-']
      for (const [glyphY, row] of glyph.entries()) {
        for (const [glyphX, bit] of [...row].entries()) {
          if (bit !== '1') continue
          for (let dy = 0; dy < glyphScale; dy += 1) {
            for (let dx = 0; dx < glyphScale; dx += 1) {
              paint(
                cursor + glyphX * glyphScale + dx,
                line.y + glyphY * glyphScale + dy,
              )
            }
          }
        }
      }
      cursor += glyphScale * 6
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
  if (!raster) {
    return '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 9 >>\nstream\n30C090F0>\nendstream'
  }
  const compressed = deflateSync(raster.pixels).toString('hex').toUpperCase()
  const encoded = `${compressed}>`
  return `<< /Type /XObject /Subtype /Image /Width ${raster.width} /Height ${raster.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode] /Length ${encoded.length} >>\nstream\n${encoded}\nendstream`
}

function createPdf(pageDefinitions, { language } = {}) {
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
  const fontNames = [
    ...new Set(
      pageDefinitions.flatMap((page) =>
        (page.lines ?? []).map((line) => line.font ?? 'F1'),
      ),
    ),
  ].sort()
  const fontIds = new Map(fontNames.map((name) => [name, reserve()]))
  const pageIds = pageDefinitions.map(() => reserve())
  const contentIds = pageDefinitions.map(() => reserve())
  const pageImages = pageDefinitions.map(
    (page) => page.images ?? (page.image ? [page.image] : []),
  )
  const imageIds = pageImages.map((images) => images.map(() => reserve()))
  const annotationIds = pageDefinitions.map((page) =>
    (page.links ?? []).map(() => reserve()),
  )

  const namedDestinations = pageDefinitions.flatMap((page, pageIndex) =>
    (page.destinations ?? []).map((destination) => ({
      ...destination,
      pageId: pageIds[pageIndex],
    })),
  )
  const destinationNames =
    namedDestinations.length > 0
      ? ` /Names << /Dests << /Names [${namedDestinations
          .map(
            (destination) =>
              `(${escaped(destination.name)}) [${destination.pageId} 0 R /XYZ ${destination.x} ${destination.y} null]`,
          )
          .join(' ')}] >> >>`
      : ''
  set(
    catalogId,
    `<< /Type /Catalog /Pages ${pagesId} 0 R${language ? ` /Lang (${escaped(language)})` : ''}${destinationNames} >>`,
  )
  set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  )
  const baseFonts = {
    F1: 'Helvetica',
    F2: 'Helvetica-Bold',
    F3: 'Helvetica-Oblique',
    F4: 'Helvetica-BoldOblique',
  }
  for (const [name, id] of fontIds) {
    set(
      id,
      `<< /Type /Font /Subtype /Type1 /BaseFont /${baseFonts[name] ?? 'Helvetica'} >>`,
    )
  }

  pageDefinitions.forEach((page, index) => {
    const commands = (page.lines ?? []).map(textCommand)
    for (const [imageIndex, image] of pageImages[index].entries()) {
      const imageId = imageIds[index][imageIndex]
      set(imageId, imageObject(image.raster))
      commands.push(
        `q\n${image.width} 0 0 ${image.height} ${image.x} ${image.y} cm\n/Im${imageIndex + 1} Do\nQ`,
      )
    }
    commands.push(...(page.commands ?? []))
    const content = commands.join('\n')
    const [mediaWidth, mediaHeight] = page.mediaBox ?? [612, 792]
    const xObjects =
      imageIds[index].length > 0
        ? `/XObject << ${imageIds[index]
            .map((imageId, imageIndex) => `/Im${imageIndex + 1} ${imageId} 0 R`)
            .join(' ')} >>`
        : ''
    const rotation = page.rotation ? `/Rotate ${page.rotation}` : ''
    for (const [linkIndex, link] of (page.links ?? []).entries()) {
      const annotationId = annotationIds[index][linkIndex]
      set(
        annotationId,
        `<< /Type /Annot /Subtype /Link /Rect [${link.rect.join(' ')}] /Border [0 0 0] ${
          link.destination
            ? `/Dest (${escaped(link.destination)})`
            : `/A << /S /URI /URI (${escaped(link.url)}) >>`
        } >>`,
      )
    }
    const annotations =
      annotationIds[index].length > 0
        ? ` /Annots [${annotationIds[index].map((id) => `${id} 0 R`).join(' ')}]`
        : ''
    set(
      pageIds[index],
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${mediaWidth} ${mediaHeight}] ${rotation}${annotations} /Resources << /Font << ${[...fontIds].map(([name, id]) => `/${name} ${id} 0 R`).join(' ')} >> ${xObjects} >> /Contents ${contentIds[index]} 0 R >>`,
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
const arabicIndicOne = rasterText({
  width: 90,
  height: 100,
  lines: [],
  marks: [{ text: '١', x: 6, y: 6, scale: 9 }],
})
const visualAdjudicationCandidate = rasterText({
  width: 280,
  height: 180,
  scale: 4,
  lines: [
    { text: 'LOCAL VISUAL', x: 24, y: 28 },
    { text: 'COMPLETE ASSET', x: 24, y: 92 },
  ],
})
const visualAdjudicationCandidateB = rasterText({
  width: 280,
  height: 180,
  scale: 4,
  lines: [
    { text: 'LOCAL VISUAL B', x: 18, y: 28 },
    { text: 'COMPLETE ASSET', x: 24, y: 92 },
  ],
})
const visualAdjudicationCandidateC = rasterText({
  width: 280,
  height: 180,
  scale: 4,
  lines: [
    { text: 'LOCAL FALLBACK', x: 18, y: 28 },
    { text: 'COMPLETE ASSET', x: 24, y: 92 },
  ],
})

const structuredFigureOne = rasterText({
  width: 520,
  height: 220,
  scale: 5,
  decorations: [
    { x: 15, y: 15, width: 230, height: 190, value: 232 },
    { x: 275, y: 15, width: 230, height: 190, value: 214 },
    { x: 245, y: 105, width: 30, height: 8, value: 48 },
  ],
  lines: [
    { text: 'PANEL A', x: 28, y: 70 },
    { text: 'PANEL B', x: 288, y: 70 },
  ],
})
const structuredFigureTwo = rasterText({
  width: 420,
  height: 120,
  scale: 4,
  decorations: [{ x: 10, y: 10, width: 400, height: 100, value: 228 }],
  lines: [{ text: 'BOUNDED RASTER', x: 38, y: 42 }],
})
const captionAboveFigure = rasterText({
  width: 640,
  height: 280,
  scale: 6,
  decorations: [
    { x: 20, y: 20, width: 270, height: 240, value: 232 },
    { x: 350, y: 20, width: 270, height: 240, value: 208 },
    { x: 290, y: 132, width: 60, height: 12, value: 48 },
  ],
  lines: [
    { text: 'ABOVE A', x: 48, y: 104 },
    { text: 'ABOVE B', x: 378, y: 104 },
  ],
})
const captionBelowFigure = rasterText({
  width: 640,
  height: 280,
  scale: 6,
  decorations: [
    { x: 20, y: 20, width: 270, height: 240, value: 216 },
    { x: 350, y: 20, width: 270, height: 240, value: 188 },
    { x: 290, y: 132, width: 60, height: 12, value: 48 },
  ],
  lines: [
    { text: 'BELOW A', x: 48, y: 104 },
    { text: 'BELOW B', x: 378, y: 104 },
  ],
})
const structuredEquation = rasterText({
  width: 420,
  height: 120,
  scale: 7,
  lines: [{ text: 'X + Y = Z', x: 22, y: 34 }],
})
const fidelityDiagram = rasterText({
  width: 750,
  height: 420,
  scale: 5,
  decorations: [
    { x: 20, y: 55, width: 190, height: 300, value: 235 },
    { x: 280, y: 55, width: 190, height: 300, value: 216 },
    { x: 540, y: 55, width: 190, height: 300, value: 196 },
    { x: 210, y: 198, width: 70, height: 12, value: 48 },
    { x: 470, y: 198, width: 70, height: 12, value: 48 },
  ],
  lines: [
    { text: 'INPUT', x: 40, y: 175 },
    { text: 'EVIDENCE', x: 255, y: 175 },
    { text: 'OUTPUT', x: 545, y: 175 },
  ],
})
const fidelityEquation = rasterText({
  width: 680,
  height: 150,
  scale: 10,
  lines: [
    { text: 'E', x: 40, y: 42, scale: 12 },
    { text: '1', x: 115, y: 80, scale: 6 },
    { text: '= M C', x: 165, y: 42, scale: 12 },
    { text: '2', x: 480, y: 18, scale: 6 },
    { text: '(1)', x: 520, y: 48, scale: 8 },
  ],
})

const fixtures = {
  'born-digital.pdf': [
    {
      lines: [
        { text: 'A Reconstructed Research Paper', x: 72, y: 720, size: 24 },
        { text: 'Ada Researcher', x: 72, y: 684, size: 12 },
        {
          text: 'This paragraph contains enough embedded text to prove local PDF extraction.',
          x: 72,
          y: 646,
        },
        {
          text: 'Bounding boxes remain source evidence while the publication becomes reflowable.',
          x: 72,
          y: 622,
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
  'internal-named-destination.pdf': [
    {
      lines: [
        {
          text: 'Named destination extraction fixture',
          x: 54,
          y: 748,
          size: 18,
          font: 'F2',
        },
        {
          text: 'See the source-key bibliography entry.',
          x: 54,
          y: 650,
        },
      ],
      links: [
        {
          destination: 'cite.SourceKey',
          rect: [54, 646, 238, 664],
        },
      ],
    },
    {
      destinations: [
        {
          name: 'cite.SourceKey',
          x: 54,
          y: 650,
        },
      ],
      lines: [
        {
          text: 'References',
          x: 54,
          y: 700,
          size: 16,
          font: 'F2',
        },
        {
          text: '[1] A. Source. Geometry-backed bibliography evidence.',
          x: 54,
          y: 640,
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
          text: 'Ada Researcher',
          x: 54,
          y: 720,
          size: 12,
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
          text: 'Figure 1. Two synthetic panels share one source caption.',
          x: 180,
          y: 430,
        },
        {
          text: 'Figure 2. A complete source raster diagram remains bounded.',
          x: 170,
          y: 300,
        },
        {
          text: 'Table 1. Synthetic values have validated columns.',
          x: 54,
          y: 250,
        },
        { text: 'Group', x: 72, y: 225, font: 'F2' },
        { text: 'Score', x: 115, y: 225, font: 'F2' },
        { text: 'Control', x: 72, y: 205 },
        { text: '10', x: 115, y: 205 },
        {
          text: 'Equation 1. A display equation uses a source glyph raster.',
          x: 54,
          y: 160,
        },
        {
          text: 'x + y = z',
          x: 250,
          y: 135,
          size: 14,
          renderMode: 3,
        },
        {
          text: 'Footnote 1: This note must stay linked to its reference.',
          x: 54,
          y: 70,
          size: 8,
        },
      ],
      images: [
        {
          x: 220,
          y: 460,
          width: 260,
          height: 110,
          raster: structuredFigureOne,
        },
        {
          x: 240,
          y: 330,
          width: 150,
          height: 70,
          raster: structuredFigureTwo,
        },
        {
          x: 225,
          y: 112,
          width: 165,
          height: 42,
          raster: structuredEquation,
        },
      ],
    },
  ],
  'caption-direction-figures.pdf': [
    {
      lines: [
        {
          text: 'Deterministic caption direction fixture',
          x: 54,
          y: 748,
          size: 20,
          font: 'F2',
        },
        {
          text: 'Two nearby source rasters exercise caption ownership in both directions.',
          x: 54,
          y: 710,
        },
        {
          text: 'Figure 1. This complete caption appears above its source raster.',
          x: 82,
          y: 650,
          font: 'F3',
        },
        {
          text: 'Figure 2. This complete caption appears below its source raster.',
          x: 82,
          y: 320,
          font: 'F3',
        },
        {
          text: 'The two figures must retain unique source-object ownership.',
          x: 54,
          y: 276,
        },
      ],
      images: [
        {
          x: 100,
          y: 520,
          width: 220,
          height: 100,
          raster: captionAboveFigure,
        },
        {
          x: 100,
          y: 380,
          width: 220,
          height: 100,
          raster: captionBelowFigure,
        },
      ],
    },
  ],
  'table-citation-crop.pdf': [
    {
      lines: [
        {
          text: 'Deterministic crop table citation study',
          x: 54,
          y: 748,
          size: 20,
          font: 'F2',
        },
        {
          text: 'The compact source rows below must remain one exact visual transcript.',
          x: 54,
          y: 680,
        },
        {
          text: 'Metric name | Baseline | Calibrated | Evidence',
          x: 54,
          y: 600,
          size: 8,
          font: 'F2',
        },
        {
          text: 'Readability score | 71 | 82 | [1]',
          x: 54,
          y: 587,
          size: 8,
        },
        {
          text: 'Diagram fidelity | 68 | 91 | [2]',
          x: 54,
          y: 574,
          size: 8,
        },
        {
          text: 'Equation fidelity | 70 | 93 | [1-2]',
          x: 54,
          y: 561,
          size: 8,
        },
        {
          text: 'Table continuity | 73 | 95 | Verified',
          x: 54,
          y: 548,
          size: 8,
        },
        {
          text: 'Aggregate result | 71 | 90 | Stable',
          x: 54,
          y: 535,
          size: 8,
        },
        {
          text: 'Table 1. Canonical citation crop.',
          x: 54,
          y: 514,
          size: 9,
          font: 'F3',
        },
        {
          text: 'The visible prose resumes after the complete table caption.',
          x: 54,
          y: 460,
        },
      ],
    },
    {
      lines: [
        { text: 'References', x: 54, y: 748, size: 16, font: 'F2' },
        {
          text: '[1] A. Fixture. Exact source ownership. Local Press, 2025.',
          x: 54,
          y: 712,
        },
        {
          text: '[2] L. Test. Deterministic crop evidence. Example Journal, 2026.',
          x: 54,
          y: 686,
        },
      ],
    },
  ],
  'note-citation-associations.pdf': [
    {
      lines: [
        {
          text: 'Deterministic note and citation association fixture',
          x: 54,
          y: 748,
          size: 20,
          font: 'F2',
        },
        { text: 'Repository Fixture Authors', x: 54, y: 716, size: 12 },
        { text: 'Abstract', x: 54, y: 680, size: 14, font: 'F2' },
        {
          text: 'A numeric claim carries footnote marker',
          x: 54,
          y: 640,
        },
        { text: '1', x: 263, y: 644, size: 7 },
        { text: '.', x: 268, y: 640 },
        {
          text: 'A symbol claim carries footnote marker',
          x: 54,
          y: 606,
        },
        { text: '*', x: 258, y: 610, size: 7 },
        { text: '.', x: 263, y: 606 },
        {
          text: 'Arabic-Indic U+0661 note marker appears at right.',
          x: 54,
          y: 560,
        },
        {
          text: 'Arabic-Indic U+0661 note body marker appears at left.',
          x: 82,
          y: 506,
        },
        {
          text: '1. Numeric footnote body contains nested marker',
          x: 54,
          y: 112,
          size: 8,
        },
        { text: '6', x: 268, y: 116, size: 6 },
        { text: '.', x: 273, y: 112, size: 8 },
        {
          text: '6. Nested footnote body.',
          x: 54,
          y: 90,
          size: 8,
        },
        { text: '* Symbol footnote body.', x: 54, y: 68, size: 8 },
      ],
      images: [
        {
          x: 330,
          y: 548,
          width: 14,
          height: 18,
          raster: arabicIndicOne,
        },
        {
          x: 54,
          y: 496,
          width: 14,
          height: 18,
          raster: arabicIndicOne,
        },
      ],
    },
    {
      lines: [
        {
          text: 'Scholarly citations and in-float markers',
          x: 54,
          y: 748,
          size: 18,
          font: 'F2',
        },
        {
          text: 'Prior evidence [1-3, 5] supports the range and group claim.',
          x: 54,
          y: 700,
        },
        {
          text: 'Example et al. (2024) confirms the author-year claim.',
          x: 54,
          y: 670,
        },
        {
          text: 'A separate claim has note reference 3.',
          x: 54,
          y: 640,
        },
        {
          text: 'Figure 1. Caption citation [2] remains associated.',
          x: 120,
          y: 410,
          font: 'F3',
        },
        {
          text: 'Table 1. A note marker inside a table cell remains associated.',
          x: 54,
          y: 238,
          font: 'F3',
        },
        { text: 'Measure', x: 72, y: 306, font: 'F2' },
        { text: 'Evidence', x: 260, y: 306, font: 'F2' },
        { text: 'Cell note', x: 72, y: 292 },
        { text: 'Note ', x: 260, y: 292 },
        { text: '4', x: 285, y: 296, size: 7 },
        { text: 'Control', x: 72, y: 268 },
        { text: 'None', x: 260, y: 268 },
        { text: '4. Table cell note body.', x: 54, y: 70, size: 8 },
      ],
      images: [
        {
          x: 180,
          y: 448,
          width: 190,
          height: 72,
          raster: structuredFigureTwo,
        },
      ],
    },
    {
      lines: [
        {
          text: 'Genuinely ambiguous duplicate-label note',
          x: 54,
          y: 748,
          size: 18,
          font: 'F2',
        },
        { text: 'Left context preserves a column.', x: 54, y: 650 },
        { text: 'Right context preserves a column.', x: 330, y: 650 },
        { text: 'Left evidence remains independent.', x: 54, y: 620 },
        { text: 'Right evidence remains independent.', x: 330, y: 620 },
        {
          text: 'A genuinely ambiguous claim has note reference 7.',
          x: 118,
          y: 400,
        },
        {
          text: '7. Left candidate note body.',
          x: 54,
          y: 72,
          size: 7,
        },
        {
          text: '7. Right candidate note body.',
          x: 330,
          y: 72,
          size: 7,
        },
      ],
    },
    {
      lines: [
        { text: 'Endnotes', x: 54, y: 700, size: 16, font: 'F2' },
        {
          text: '3. Repository-owned endnote body begins here.',
          x: 54,
          y: 650,
        },
        {
          text: 'Additional endnote detail preserves complete source evidence.',
          x: 54,
          y: 625,
        },
        {
          text: 'The note remains local and deterministic for this fixture.',
          x: 54,
          y: 600,
        },
      ],
    },
    {
      lines: [
        { text: 'References', x: 54, y: 748, size: 16, font: 'F2' },
        {
          text: '[1] A. Fixture. Numeric association evidence. Local Press, 2024.',
          x: 54,
          y: 710,
        },
        {
          text: '[2] B. Fixture. Caption association evidence. Local Press, 2024.',
          x: 54,
          y: 680,
        },
        {
          text: '[3] C. Fixture. Range association evidence. Local Press, 2024.',
          x: 54,
          y: 650,
        },
        {
          text: '[5] D. Fixture. Group association evidence. Local Press, 2024.',
          x: 54,
          y: 620,
        },
        {
          text: 'Example, A., and Fixture, B. (2024). Repository-owned author-year evidence.',
          x: 54,
          y: 580,
        },
      ],
    },
  ],
  'pdf-to-epub-fidelity.pdf': [
    {
      lines: [
        {
          text: 'A Deterministic Reflow Fidelity Benchmark',
          x: 54,
          y: 748,
          size: 21,
          font: 'F2',
        },
        { text: 'Ada Fixture and Lin Test', x: 54, y: 716, size: 12 },
        {
          text: 'Repository Laboratory, Local Systems Group',
          x: 54,
          y: 696,
          size: 9,
          font: 'F3',
        },
        { text: 'Abstract', x: 54, y: 660, size: 14, font: 'F2' },
        {
          text: 'This benchmark preserves continuous prose across a discre-',
          x: 54,
          y: 632,
        },
        {
          text: 'tionary line break while an authored state-of-the-art phrase remains.',
          x: 54,
          y: 614,
        },
        {
          text: 'Discretionary evidence keeps canonical spans unique and prevents title text leakage.',
          x: 54,
          y: 596,
        },
        { text: 'Inline evidence keeps ', x: 54, y: 562 },
        { text: 'bold', x: 162, y: 562, font: 'F2' },
        { text: ', ', x: 185, y: 562 },
        { text: 'italic', x: 190, y: 562, font: 'F3' },
        { text: ', ', x: 212, y: 562 },
        { text: 'combined', x: 221, y: 562, font: 'F4' },
        { text: ', and a ', x: 273, y: 562 },
        { text: 'safe link', x: 309, y: 562, font: 'F3' },
        { text: ' intact.', x: 352, y: 562 },
        { text: 'Inline formula H', x: 54, y: 536 },
        { text: '2', x: 131.8, y: 533, size: 7 },
        { text: 'O remains readable.', x: 136, y: 536 },
        { text: '1 Methods', x: 54, y: 514, size: 16, font: 'F2' },
        { text: '1.1 Structure', x: 54, y: 480, size: 13, font: 'F2' },
        {
          text: 'The method follows source order and retains a linked note reference ',
          x: 54,
          y: 450,
        },
        { text: '1', x: 393, y: 454, size: 7 },
        { text: '.', x: 397, y: 450 },
        { text: '1. First ordered benchmark item.', x: 72, y: 416 },
        { text: 'a. Nested evidence item.', x: 92, y: 394 },
        { text: '2. Second ordered benchmark item.', x: 72, y: 372 },
        {
          text: 'Footnote 1: This typed note must retain its backlink.',
          x: 54,
          y: 70,
          size: 8,
        },
      ],
      links: [
        {
          url: 'https://example.com/fidelity-evidence',
          rect: [307, 558, 351, 572],
        },
      ],
    },
    {
      lines: [
        { text: '2 Results', x: 54, y: 748, size: 16, font: 'F2' },
        {
          text: 'The result places each semantic object once at a meaningful reading position.',
          x: 54,
          y: 716,
        },
        {
          text: 'Figure 1. A bounded diagram connects input evidence to output',
          x: 104,
          y: 468,
        },
        {
          text: 'semantics and keeps this complete second caption line attached.',
          x: 104,
          y: 450,
        },
        {
          text: 'Table 1. Validated benchmark values remain structured.',
          x: 54,
          y: 380,
        },
        { text: 'Profile', x: 72, y: 352, font: 'F2' },
        { text: 'Nodes', x: 190, y: 352, font: 'F2' },
        { text: 'Mobile', x: 72, y: 330 },
        { text: '12', x: 190, y: 330 },
        { text: 'E-ink', x: 72, y: 308 },
        { text: '12', x: 190, y: 308 },
        {
          text: 'Equation 1. The bounded display equation remains source backed.',
          x: 54,
          y: 232,
        },
        {
          text: 'E1 = m c2 (1)',
          x: 244,
          y: 194,
          size: 15,
          font: 'F3',
          renderMode: 3,
        },
      ],
      images: [
        {
          x: 180,
          y: 510,
          width: 250,
          height: 150,
          raster: fidelityDiagram,
        },
        {
          x: 220,
          y: 174,
          width: 190,
          height: 48,
          raster: fidelityEquation,
        },
      ],
    },
    {
      lines: [
        { text: 'Discussion', x: 54, y: 748, size: 16, font: 'F2' },
        {
          text: 'Continuous reflow must not alternate columns or preserve source-line whitespace.',
          x: 54,
          y: 716,
        },
        { text: 'References', x: 54, y: 658, size: 16, font: 'F2' },
        {
          text: '[1] A. Fixture. Deterministic document evidence. Local Press, 2025.',
          x: 54,
          y: 626,
        },
        {
          text: '[2] L. Test. Reflowable benchmark methods. Example Journal, 2026.',
          x: 54,
          y: 602,
        },
      ],
    },
  ],
  'diagnostic-overlays.pdf': [
    {
      lines: [
        { text: 'Diagnostic extraction benchmark', x: 54, y: 770, size: 8 },
        { text: 'Left candidate order begins here.', x: 54, y: 690 },
        { text: 'Right candidate order begins here.', x: 330, y: 690 },
        { text: 'Indented left order continues here.', x: 100, y: 300 },
        { text: 'Right candidate order continues here.', x: 330, y: 300 },
        {
          text: 'This deliberately wide source region carries note reference 1 and crosses the uncertain column boundary for visual review.',
          x: 72,
          y: 200,
        },
        {
          text: 'Footnote 1: Left candidate note body.',
          x: 54,
          y: 70,
          size: 8,
        },
        {
          text: 'Footnote 1: Right candidate note body.',
          x: 330,
          y: 70,
          size: 8,
        },
        { text: '1', x: 306, y: 24, size: 8 },
      ],
    },
  ],
  'adjudication-required.pdf': [
    {
      lines: [
        {
          text: 'Left candidate one has complete embedded text.',
          x: 54,
          y: 650,
        },
        {
          text: 'Right candidate one has complete embedded text.',
          x: 330,
          y: 650,
        },
        {
          text: 'Indented left candidate has complete text.',
          x: 110,
          y: 230,
        },
        {
          text: 'Right candidate two has complete embedded text.',
          x: 330,
          y: 230,
        },
      ],
    },
    {
      lines: [
        {
          text: 'The first claim deliberately has note reference 1.',
          x: 72,
          y: 650,
        },
        {
          text: 'The second claim deliberately has note reference 1.',
          x: 72,
          y: 615,
        },
        {
          text: '1. First candidate note contains complete local evidence.',
          x: 72,
          y: 100,
          size: 7,
        },
        {
          text: '1. Second candidate note contains complete local evidence.',
          x: 72,
          y: 70,
          size: 7,
        },
      ],
    },
  ],
  'visual-adjudication-required.pdf': [
    {
      lines: [
        {
          text: 'Bounded visual adjudication study',
          x: 54,
          y: 748,
          size: 20,
          font: 'F2',
        },
        { text: 'Ada Fixture', x: 54, y: 716, size: 12 },
        { text: 'Abstract', x: 54, y: 680, size: 14, font: 'F2' },
        {
          text: 'This local fixture proves that bounded visual choices preserve complete source assets.',
          x: 54,
          y: 652,
        },
        {
          text: 'The replayable decision record contains identifiers and choices without document payloads.',
          x: 54,
          y: 630,
        },
        {
          text: 'Figure 1. Two complete local candidates across the page require one bounded owner choice before publication.',
          x: 30,
          y: 390,
          font: 'F3',
        },
      ],
      images: [
        {
          x: 40,
          y: 450,
          width: 190,
          height: 125,
          raster: visualAdjudicationCandidateB,
        },
        {
          x: 380,
          y: 490,
          width: 190,
          height: 125,
          raster: visualAdjudicationCandidateC,
        },
      ],
    },
    {
      lines: [
        { text: 'Discussion', x: 54, y: 748, size: 16, font: 'F2' },
        {
          text: 'The second visual remains below the deterministic confidence threshold.',
          x: 54,
          y: 714,
        },
        {
          text: 'Its complete source-backed asset is still available for a bounded local fallback.',
          x: 54,
          y: 690,
        },
        {
          text: 'No global matcher threshold or diagnostic category changes during adjudication.',
          x: 54,
          y: 666,
        },
        {
          text: 'Figure 2. A distant complete local fallback requires review.',
          x: 72,
          y: 190,
          font: 'F3',
        },
      ],
      images: [
        {
          x: 200,
          y: 360,
          width: 210,
          height: 135,
          raster: visualAdjudicationCandidate,
        },
      ],
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

const selectedFixtures = new Set(process.argv.slice(2))
const fixtureOptions = {
  'note-citation-associations.pdf': { language: 'en-US' },
  'pdf-to-epub-fidelity.pdf': { language: 'en-US' },
}
for (const [name, pages] of Object.entries(fixtures)) {
  if (selectedFixtures.size > 0 && !selectedFixtures.has(name)) continue
  writeFileSync(
    new URL(name, import.meta.url),
    createPdf(pages, fixtureOptions[name]),
  )
}
