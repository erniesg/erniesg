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
  textLine('Source/output checkpoint fixture', 72, 760, 9),
  textLine('Continuous prose checkpoint paper', 72, 720, 20, 'F2'),
  textLine('Figure 1. Source flowchart', 72, 680),
  textLine('Pseudocode', 72, 580, 14, 'F2'),
  textLine('for each source line:', 90, 550),
  textLine('compare source and rendition', 108, 528),
  textLine('keep the named property visible', 108, 506),
  'q\n360 0 0 160 126 300 cm\n/Im1 Do\nQ',
  textLine('Figure 1 caption stays below the source flowchart.', 72, 250, 10),
  textLine('A second result sentence runs off the bottom of', 72, 104),
  textLine('this page and', 72, 82),
].join('\n')

// Page two carries the halves of the sentence, the word, and the literal text
// that issue 043's page-join, hyphen-resolution, and markup non-promotion
// checkpoints name. The running head repeats page one's title so that furniture
// exclusion has something to exclude between the two halves.
const secondPageContent = [
  textLine('Source/output checkpoint fixture', 72, 760, 9),
  textLine('continues at the top of the next one without losing', 72, 700),
  textLine('its clause.', 72, 680),
  textLine('The high-resolution source photo-', 72, 620),
  textLine('graph remains clear.', 72, 600),
  textLine('A photograph attests the joined form.', 72, 575),
  textLine('The source preserves the rare-', 72, 540),
  textLine('fragment compound.', 72, 520),
  textLine('The rare-fragment spelling is attested.', 72, 495),
  textLine('## Not a heading and **not bold** and {placeholder}', 72, 470),
  textLine('stay literal.', 72, 450),
  textLine('1. Literal numbered syntax stays prose.', 72, 420),
  textLine('First indented paragraph begins', 90, 370),
  textLine('and continues on its next line.', 72, 350),
  textLine('Second indented paragraph begins', 90, 336),
  textLine('and continues independently.', 72, 316),
  textLine('A widely spaced source line begins', 72, 270),
  textLine('and remains source-contiguous despite its spacing.', 72, 244),
  textLine('Prose before the owned equation remains clean.', 72, 180),
  textLine('E = m c 2 (1)', 240, 150, 14, 'F2'),
  textLine('Prose after the owned equation remains clean.', 72, 118),
].join('\n')

// Page three is deliberately only a two-column body. Keeping its source
// geometry independent of the spanning visual fixture makes the column-flow
// proof observable rather than relying on a sentence that merely says it
// crossed a column.
const thirdPageContent = [
  textLine('Source/output checkpoint fixture', 72, 760, 9),
  textLine('Left context establishes a column.', 72, 680),
  textLine('Left evidence preserves source order.', 72, 640),
  textLine('Left geometry reaches the final line.', 72, 600),
  textLine('The result continues toward the', 72, 120),
  textLine('right column with source proof.', 350, 680),
  textLine('Right evidence preserves source order.', 350, 640),
  textLine('Right context completes the gutter.', 350, 600),
].join('\n')

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [5 0 R 7 0 R 9 0 R] /Count 3 >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  imageObject(),
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents 6 0 R >>',
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 3 0 R >> >> /Contents 8 0 R >>',
  `<< /Length ${Buffer.byteLength(secondPageContent)} >>\nstream\n${secondPageContent}\nendstream`,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 3 0 R >> >> /Contents 10 0 R >>',
  `<< /Length ${Buffer.byteLength(thirdPageContent)} >>\nstream\n${thirdPageContent}\nendstream`,
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
