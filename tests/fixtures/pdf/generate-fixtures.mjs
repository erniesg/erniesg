import { writeFileSync } from 'node:fs'

function escaped(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

function textCommand({ text, x, y, size = 11 }) {
  return `BT\n/F1 ${size} Tf\n${x} ${y} Td\n(${escaped(text)}) Tj\nET`
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
  const imageId = reserve()
  const pageIds = pageDefinitions.map(() => reserve())
  const contentIds = pageDefinitions.map(() => reserve())

  set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  )
  set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  set(
    imageId,
    '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 9 >>\nstream\n30C090F0>\nendstream',
  )

  pageDefinitions.forEach((page, index) => {
    const commands = page.lines.map(textCommand)
    if (page.image) {
      commands.push(
        `q\n${page.image.width} 0 0 ${page.image.height} ${page.image.x} ${page.image.y} cm\n/Im1 Do\nQ`,
      )
    }
    const content = commands.join('\n')
    set(
      pageIds[index],
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`,
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
      image: { x: 220, y: 460, width: 170, height: 110 },
    },
  ],
  'adjudication-required.pdf': [
    {
      lines: [
        { text: 'Left candidate one.', x: 54, y: 650 },
        { text: 'Right candidate one.', x: 330, y: 650 },
        { text: 'Left 2.', x: 110, y: 230 },
        { text: 'Right candidate two.', x: 330, y: 230 },
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
        { text: '1. First candidate note.', x: 72, y: 100, size: 7 },
        { text: '1. Second candidate note.', x: 72, y: 70, size: 7 },
      ],
    },
  ],
  'scanned-page.pdf': [
    {
      lines: [],
      image: { x: 54, y: 54, width: 504, height: 684 },
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
      image: { x: 54, y: 120, width: 504, height: 500 },
    },
  ],
  'two-page-scan.pdf': [
    {
      lines: [],
      image: { x: 54, y: 54, width: 504, height: 684 },
    },
    {
      lines: [],
      image: { x: 54, y: 54, width: 504, height: 684 },
    },
  ],
}

for (const [name, pages] of Object.entries(fixtures)) {
  writeFileSync(new URL(name, import.meta.url), createPdf(pages))
}
