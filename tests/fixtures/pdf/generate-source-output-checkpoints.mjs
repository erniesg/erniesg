import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

function escaped(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)')
}

function textLine(text, x, y, size = 12, font = 'F1') {
  return `BT\n/${font} ${size} Tf\n${x} ${y} Td\n(${escaped(text)}) Tj\nET`
}

function imageObject() {
  const pixels = Uint8Array.from([
    235, 235, 235, 235, 235, 35, 35, 235, 235, 35, 35, 235, 235, 235, 235, 235,
  ])
  const encoded = `${Buffer.from(deflateSync(pixels)).toString('hex').toUpperCase()}>`
  return `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode] /Length ${encoded.length} >>\nstream\n${encoded}\nendstream`
}

const content = [
  textLine('Source/output checkpoint fixture', 72, 730, 20, 'F2'),
  textLine('Figure 1. Source flowchart', 72, 680),
  textLine('The result sentence continues across a column break.', 72, 640),
  textLine('Pseudocode', 72, 580, 14, 'F2'),
  textLine('for each source line:', 90, 550),
  textLine('compare source and rendition', 108, 528),
  textLine('keep the named property visible', 108, 506),
  'q\n360 0 0 160 126 300 cm\n/Im1 Do\nQ',
  textLine('Figure 1 caption stays below the source flowchart.', 72, 250, 10),
].join('\n')

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [5 0 R] /Count 1 >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  imageObject(),
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents 6 0 R >>',
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
]

let pdf = '%PDF-1.4\n% synthetic fixture owned by erniesg\n'
const offsets = [0]
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf))
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
}
const xref = Buffer.byteLength(pdf)
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
pdf += offsets
  .slice(1)
  .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
  .join('')
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`

writeFileSync(new URL('./source-output-checkpoints.pdf', import.meta.url), pdf)
