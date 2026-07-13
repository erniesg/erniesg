import { describe, expect, it } from 'vitest'
import { strFromU8 } from 'fflate'
import { readFile } from 'node:fs/promises'
import { buildEpub, inspectEpub } from './epub'
import { reconstructPdf } from './pdf'

function makeBornDigitalPdf() {
  const content = [
    'BT',
    '/F1 24 Tf',
    '72 720 Td',
    '(A Reconstructed Research Paper) Tj',
    '/F1 12 Tf',
    '0 -48 Td',
    '(This paragraph contains enough embedded text to prove local PDF extraction.) Tj',
    '0 -22 Td',
    '(Bounding boxes remain source evidence while the publication becomes reflowable.) Tj',
    'ET',
  ].join('\n')
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

describe('PDF.js browser ingestion', () => {
  it('opens an actual born-digital PDF and reconstructs text with boxes', async () => {
    const bytes = makeBornDigitalPdf()
    const file = new File([bytes], 'fixture.pdf', {
      type: 'application/pdf',
      lastModified: Date.UTC(2026, 6, 13),
    })
    const result = await reconstructPdf(file)

    expect(result.source.pageCount).toBe(1)
    expect(result.pages[0]).toMatchObject({
      kind: 'born-digital',
      rotation: 0,
    })
    expect(result.paper.nodes.length).toBeGreaterThan(0)
    expect(
      result.paper.nodes.some(
        (node) =>
          'text' in node && node.text.includes('Reconstructed Research Paper'),
      ),
    ).toBe(true)
    expect(Object.values(result.provenance)[0].boxes[0]).toMatchObject({
      page: 1,
      method: 'pdf-text',
    })

    const epub = await buildEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    expect(epub.fileName).toMatch(/\.epub$/)
    expect(strFromU8(files['EPUB/content.xhtml'])).toContain(
      'Reconstructed Research Paper',
    )
    expect(JSON.parse(strFromU8(files['EPUB/export.json']))).toMatchObject({
      sourcePdfSha256: result.source.sha256,
      rendition: 'reflowable-epub',
    })
  })

  it('reconstructs the fellowship paper without tracked-letter or title-line fragmentation', async () => {
    const bytes = await readFile(
      new URL(
        '../../public/research/if-letters-home-could-sing/if-letters-home-could-sing.pdf',
        import.meta.url,
      ),
    )
    const result = await reconstructPdf(
      new File([bytes], 'if-letters-home-could-sing.pdf', {
        type: 'application/pdf',
      }),
    )
    const text = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join('\n')

    expect(text).toContain('NATIONAL MUSEUM OF SINGAPORE')
    expect(text).not.toContain('N A T I O N A L')
    expect(text).toContain('If letters home could sing.')
  })
})
