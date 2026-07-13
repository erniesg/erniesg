export function makeBornDigitalPdf() {
  const content = [
    'BT',
    '/F1 24 Tf',
    '72 720 Td',
    '(A Real Browser Conversion Test) Tj',
    '/F1 12 Tf',
    '0 -48 Td',
    '(This paragraph contains enough embedded text to prove browser PDF extraction.) Tj',
    '0 -22 Td',
    '(The exported EPUB must preserve reading order and source-backed content.) Tj',
    'ET',
  ].join('\n')
  return makePdf(content)
}

export function makeBlankPdf() {
  return makePdf('')
}

function makePdf(content: string) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}
