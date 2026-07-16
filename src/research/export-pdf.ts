import { createHash } from 'node:crypto'
import type { LayoutManifest } from './manifest'
import type { ResearchNode, ResearchPaper } from './schema'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type PaginatedPdfExport = {
  bytes: Uint8Array
  fileName: 'print.pdf'
  mediaType: 'application/pdf'
  pageCount: number
  sha256: string
}

export function normalizePdfText(value: string) {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '?')
}

function pdfString(value: string) {
  return normalizePdfText(value).replace(/([\\()])/g, '\\$1')
}

function wrap(value: string, width = 88) {
  const words = normalizePdfText(value).trim().split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (!line) {
      line = word
    } else if (line.length + word.length + 1 <= width) {
      line += ` ${word}`
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : ['']
}

function nodeText(node: ResearchNode) {
  return node.type === 'figure' ? node.title : node.text
}

function placementPage(
  entry: LayoutManifest['renditions'][number]['entries'][number],
) {
  const placements =
    entry.representation.kind === 'whole'
      ? [entry.representation.placement]
      : entry.representation.fragments.map((fragment) => fragment.placement)
  return placements[0]?.page ?? 1
}

function pageLines(
  paper: ResearchPaper,
  print: LayoutManifest['renditions'][number],
  pageCount: number,
) {
  const nodes = new Map(paper.nodes.map((node) => [node.id, node]))
  const appliedOverrides = new Map(
    print.overrideSet.applied.map((override) => [
      override.canonicalId,
      override,
    ]),
  )
  const pages = Array.from({ length: pageCount }, () => [] as string[])
  pages[0].push(
    paper.title,
    paper.subtitle,
    `Authors: ${paper.authors.join(', ')}`,
    `${paper.status} | ${paper.version} | ${paper.updated}`,
    '',
    'Abstract',
    ...wrap(paper.abstract),
    '',
  )

  for (const entry of print.entries) {
    const node = nodes.get(entry.canonicalId)
    if (!node) continue
    const appliedOverride = appliedOverrides.get(entry.canonicalId)
    const presentation = appliedOverride
      ? [`Print presentation: ${entry.chosenVariant}`, '']
      : []

    if (entry.representation.kind === 'fragments') {
      for (const fragment of entry.representation.fragments) {
        const value =
          fragment.textRange && node.type !== 'figure'
            ? node.text.slice(fragment.textRange.start, fragment.textRange.end)
            : nodeText(node)
        const page = Math.max(1, fragment.placement.page ?? 1)
        pages[page - 1].push(
          ...(fragment === entry.representation.fragments[0]
            ? presentation
            : []),
          ...wrap(`[${node.id}] ${value}`).map((line) => line),
          '',
        )
      }
      continue
    }

    const page = Math.max(1, placementPage(entry))
    pages[page - 1].push(
      ...presentation,
      ...wrap(`[${node.id}] ${nodeText(node)}`).map((line) => line),
      '',
    )
  }

  return pages
}

function contentStream(lines: readonly string[], page: number, total: number) {
  const body = lines
    .flatMap((line, index) => [
      `(${pdfString(line)}) Tj`,
      index === lines.length - 1 ? '' : '0 -10 Td',
    ])
    .filter(Boolean)
  return [
    'BT',
    '/F1 8 Tf',
    '10 TL',
    '40 806 Td',
    ...body,
    'ET',
    'BT',
    '/F1 8 Tf',
    '515 24 Td',
    `(${page} / ${total}) Tj`,
    'ET',
  ].join('\n')
}

function buildPdfObjects(
  paper: ResearchPaper,
  layoutVersion: string,
  linesByPage: readonly (readonly string[])[],
) {
  const pageCount = linesByPage.length
  const pageIds = linesByPage.map((_, index) => 4 + index * 2)
  const infoId = 4 + pageCount * 2
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  for (const [index, lines] of linesByPage.entries()) {
    const pageId = pageIds[index]
    const contentId = pageId + 1
    const stream = contentStream(lines, index + 1, pageCount)
    objects[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`
    objects[contentId - 1] =
      `<< /Length ${encoder.encode(stream).byteLength} >>\nstream\n${stream}\nendstream`
  }

  const date = paper.updated.replace(/-/g, '')
  objects[infoId - 1] =
    `<< /Title (${pdfString(paper.title)}) /Author (${pdfString(paper.authors.join(', '))}) /Subject (${pdfString(`SRT ${layoutVersion}`)}) /Creator (erniesg deterministic SRT exporter) /Producer (erniesg deterministic SRT exporter) /CreationDate (D:${date}000000Z) /ModDate (D:${date}000000Z) >>`

  return { objects, infoId }
}

function serializePdf(objects: readonly string[], infoId: number) {
  let pdf = '%PDF-1.4\n% SRT deterministic paginated export\n'
  const offsets = [0]

  for (const [index, object] of objects.entries()) {
    offsets[index + 1] = encoder.encode(pdf).byteLength
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }

  const xrefOffset = encoder.encode(pdf).byteLength
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return encoder.encode(pdf)
}

export function inspectPaginatedPdf(bytes: Uint8Array) {
  const value = decoder.decode(bytes)
  if (!value.startsWith('%PDF-1.4')) {
    throw new Error('Paginated export is not a PDF 1.4 file')
  }
  if (!value.endsWith('%%EOF\n')) {
    throw new Error('Paginated export is missing its EOF marker')
  }
  const declared = value.match(/\/Type \/Pages \/Count (\d+)/)
  const pageObjects = [...value.matchAll(/\/Type \/Page\b/g)].length
  if (!declared) throw new Error('Paginated export has no page tree')
  return {
    pageCount: pageObjects,
    declaredPageCount: Number(declared[1]),
    text: value,
  }
}

export function buildPaginatedPdf(
  paper: ResearchPaper,
  manifest: LayoutManifest,
): PaginatedPdfExport {
  const print = manifest.renditions.find(
    (rendition) => rendition.target === 'print',
  )
  if (!print || print.pagination.finalPageCount === null) {
    throw new Error('A finite print rendition is required for PDF export')
  }
  const pageCount = print.pagination.finalPageCount
  const lines = pageLines(paper, print, pageCount)
  const { objects, infoId } = buildPdfObjects(paper, print.layoutVersion, lines)
  const bytes = serializePdf(objects, infoId)
  const inspection = inspectPaginatedPdf(bytes)
  if (
    inspection.pageCount !== pageCount ||
    inspection.declaredPageCount !== pageCount
  ) {
    throw new Error('Generated PDF page tree does not match the print layout')
  }

  return {
    bytes,
    fileName: 'print.pdf',
    mediaType: 'application/pdf',
    pageCount,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
