import type { ResearchNode, ResearchPaper } from './schema'
import type {
  NodeSourceEvidence,
  PdfPageAnalysis,
  PdfReconstruction,
  PdfSourceRun,
  ReconstructionDiagnostic,
} from './import-types'

type TextLine = {
  page: number
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
  runs: PdfSourceRun[]
  column: 'left' | 'right' | 'span'
}

type TextBlock = {
  type: 'heading' | 'paragraph'
  text: string
  lines: TextLine[]
  confidence: number
}

export type PdfDocumentMetadata = {
  title?: string
  author?: string
  subject?: string
  modified?: string
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function normalizeTrackedRunText(value: string) {
  const tokens = value.trim().split(/\s+/)
  if (
    tokens.length >= 2 &&
    tokens.every((token) => /^[\p{Lu}\d]$/u.test(token))
  ) {
    return tokens.join('')
  }
  return value.trim()
}

function mergeRunText(runs: PdfSourceRun[]) {
  let text = ''
  let previous: PdfSourceRun | undefined
  for (const run of runs) {
    const word = normalizeTrackedRunText(run.text)
    if (!word) continue
    const gap = previous
      ? run.x - (previous.x + previous.width)
      : Number.POSITIVE_INFINITY
    const needsSpace =
      text.length > 0 &&
      !/^[,.;:!?%)}\]]/.test(word) &&
      !/[({[]$/.test(text) &&
      gap >
        Math.max(
          0.0015,
          run.height *
            (/^[\p{Lu}\d]$/u.test(word) &&
            previous &&
            /^[\p{Lu}\d]$/u.test(normalizeTrackedRunText(previous.text))
              ? 0.24
              : 0.08),
        )
    text += `${needsSpace ? ' ' : ''}${word}`
    previous = run
  }
  return text.replace(/\s+/g, ' ').trim()
}

function groupRunsIntoLines(page: PdfPageAnalysis): TextLine[] {
  const lines: TextLine[] = []
  const runs = page.runs
    .filter((run) => run.text.trim())
    .sort((left, right) => left.y - right.y || left.x - right.x)

  for (const run of runs) {
    const center = run.y + run.height / 2
    const matching = lines.find((line) => {
      const lineCenter = line.y + line.height / 2
      return Math.abs(center - lineCenter) <= Math.max(0.004, run.height * 0.45)
    })
    if (matching) {
      matching.runs.push(run)
      matching.x = Math.min(matching.x, run.x)
      matching.y = Math.min(matching.y, run.y)
      matching.width = Math.max(matching.width, run.x + run.width - matching.x)
      matching.height = Math.max(matching.height, run.height)
      matching.fontSize = Math.max(matching.fontSize, run.fontSize)
      continue
    }
    lines.push({
      page: page.page,
      text: '',
      x: run.x,
      y: run.y,
      width: run.width,
      height: run.height,
      fontSize: run.fontSize,
      runs: [run],
      column: 'span',
    })
  }

  for (const line of lines) {
    line.runs.sort((left, right) => left.x - right.x)
    line.text = mergeRunText(line.runs)
  }
  return lines.filter((line) => line.text)
}

function normalizeMarginText(text: string) {
  return text
    .toLocaleLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

function repeatedMarginKeys(linesByPage: TextLine[][]) {
  const occurrences = new Map<string, Set<number>>()
  for (const lines of linesByPage) {
    for (const line of lines) {
      if (line.y > 0.1 && line.y + line.height < 0.9) continue
      const key = normalizeMarginText(line.text)
      if (!key || key.length > 160) continue
      const pages = occurrences.get(key) ?? new Set<number>()
      pages.add(line.page)
      occurrences.set(key, pages)
    }
  }
  return new Set(
    [...occurrences.entries()]
      .filter(([, pages]) => pages.size >= 2)
      .map(([key]) => key),
  )
}

function orderPageLines(lines: TextLine[]) {
  const candidates = lines.filter((line) => line.text)
  const left = candidates.filter(
    (line) => line.x < 0.43 && line.x + line.width < 0.62,
  )
  const right = candidates.filter((line) => line.x >= 0.43)
  const hasColumns = left.length >= 3 && right.length >= 3

  if (!hasColumns) {
    return candidates.sort((a, b) => a.y - b.y || a.x - b.x)
  }

  const bodyTop = Math.min(
    ...left.map((line) => line.y),
    ...right.map((line) => line.y),
  )
  const bodyBottom = Math.max(
    ...left.map((line) => line.y + line.height),
    ...right.map((line) => line.y + line.height),
  )
  const top: TextLine[] = []
  const bottom: TextLine[] = []
  for (const line of candidates) {
    if (left.includes(line)) line.column = 'left'
    else if (right.includes(line)) line.column = 'right'
    else if (line.y < bodyTop) top.push(line)
    else if (line.y > bodyBottom) bottom.push(line)
  }

  return [
    ...top.sort((a, b) => a.y - b.y),
    ...left.sort((a, b) => a.y - b.y),
    ...right.sort((a, b) => a.y - b.y),
    ...bottom.sort((a, b) => a.y - b.y),
  ]
}

function joinLineText(current: string, next: string) {
  if (/[-‐‑]$/.test(current) && /^[a-z]/.test(next)) {
    return `${current.slice(0, -1)}${next}`
  }
  return `${current} ${next}`
}

function linesToBlocks(lines: TextLine[]) {
  const bodySize =
    median(lines.map((line) => line.fontSize).filter(Boolean)) || 12
  const blocks: TextBlock[] = []

  for (const line of lines) {
    const isHeading =
      line.text.length <= 180 &&
      (line.fontSize >= bodySize * 1.28 ||
        (/^(abstract|introduction|methods?|results?|discussion|conclusion|references)\b/i.test(
          line.text,
        ) &&
          line.text.length < 80))
    const previous = blocks.at(-1)
    const previousLine = previous?.lines.at(-1)
    const gap = previousLine
      ? line.y - (previousLine.y + previousLine.height)
      : 1
    const continuesHeading = Boolean(
      isHeading &&
        previous?.type === 'heading' &&
        previousLine?.page === line.page &&
        previousLine.column === line.column &&
        Math.abs(previousLine.fontSize - line.fontSize) <=
          Math.max(1, previousLine.fontSize * 0.12) &&
        gap <= Math.max(0.04, line.height * 2.4),
    )
    const newParagraph =
      !previous ||
      (isHeading && !continuesHeading) ||
      (previous.type === 'heading' && !continuesHeading) ||
      previousLine?.page !== line.page ||
      previousLine?.column !== line.column ||
      gap > Math.max(0.016, line.height * 1.35)

    if (newParagraph) {
      blocks.push({
        type: isHeading ? 'heading' : 'paragraph',
        text: line.text,
        lines: [line],
        confidence: isHeading ? 0.9 : 0.86,
      })
      continue
    }
    previous.text = joinLineText(previous.text, line.text)
    previous.lines.push(line)
    previous.confidence = Math.min(previous.confidence, 0.84)
  }
  return blocks
}

function parseAuthors(author?: string) {
  const authors = author
    ?.split(/[;,]/)
    .map((value) => value.trim())
    .filter(Boolean)
  return authors?.length ? authors : ['Imported locally']
}

function validDate(value?: string) {
  if (!value) return '1970-01-01'
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf())
    ? '1970-01-01'
    : parsed.toISOString().slice(0, 10)
}

function nodeId(index: number, type: TextBlock['type'], text: string) {
  const fragment = text
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36)
  return `${type === 'heading' ? 'sec' : 'p'}-${String(index + 1).padStart(3, '0')}-${fragment || 'content'}`
}

export function reconstructPageAnalyses({
  pages,
  sourceHash,
  fileName,
  byteLength,
  metadata = {},
}: {
  pages: PdfPageAnalysis[]
  sourceHash: string
  fileName: string
  byteLength: number
  metadata?: PdfDocumentMetadata
}): PdfReconstruction {
  const diagnostics: ReconstructionDiagnostic[] = []
  for (const page of pages) {
    if (page.kind === 'ocr-required') {
      diagnostics.push({
        code: 'OCR_REQUIRED',
        severity: 'error',
        page: page.page,
        message: `Page ${page.page} has insufficient embedded text and requires local OCR.`,
      })
    } else if (page.kind === 'mixed') {
      diagnostics.push({
        code: 'MIXED_PAGE',
        severity: 'warning',
        page: page.page,
        message: `Page ${page.page} mixes sparse text with image content; review the reconstruction.`,
      })
    }
  }

  const rawLines = pages.map(groupRunsIntoLines)
  const repeated = repeatedMarginKeys(rawLines)
  const orderedLines = rawLines.flatMap((pageLines) => {
    const filtered = pageLines.filter(
      (line) => !repeated.has(normalizeMarginText(line.text)),
    )
    return orderPageLines(filtered)
  })
  if (repeated.size > 0) {
    diagnostics.push({
      code: 'REPEATED_MARGIN_TEXT',
      severity: 'info',
      message: `Removed ${repeated.size} repeated header or footer pattern${repeated.size === 1 ? '' : 's'} from reading order.`,
    })
  }

  const blocks = linesToBlocks(orderedLines)
  if (blocks.length === 0) {
    diagnostics.push({
      code: 'NO_RECONSTRUCTABLE_TEXT',
      severity: 'error',
      message: 'No reconstructable embedded text was found.',
    })
  }

  const provenance: Record<string, NodeSourceEvidence> = {}
  const nodes: ResearchNode[] = blocks.map((block, index) => {
    const id = nodeId(index, block.type, block.text)
    const boxes = block.lines.flatMap((line) => line.runs)
    const pages = [...new Set(boxes.map((box) => box.page))]
    provenance[id] = {
      confidence: rounded(block.confidence),
      pages,
      boxes: boxes.map((box) => ({
        ...box,
        x: rounded(box.x),
        y: rounded(box.y),
        width: rounded(box.width),
        height: rounded(box.height),
        fontSize: rounded(box.fontSize),
        confidence: rounded(box.confidence),
      })),
    }
    if (block.confidence < 0.75) {
      diagnostics.push({
        code: 'LOW_CONFIDENCE_BLOCK',
        severity: 'warning',
        page: pages[0],
        message: `${id} needs reading-order review.`,
      })
    }
    return block.type === 'heading'
      ? {
          id,
          type: 'heading' as const,
          level: 2 as const,
          text: block.text,
          source: `pdf:${sourceHash.slice(0, 16)}#page=${pages[0]}`,
        }
      : {
          id,
          type: 'paragraph' as const,
          text: block.text,
          source: `pdf:${sourceHash.slice(0, 16)}#page=${pages[0]}`,
        }
  })

  const firstHeading = nodes.find(
    (node): node is Extract<ResearchNode, { type: 'heading' }> =>
      node.type === 'heading',
  )
  const firstParagraph = nodes.find(
    (node): node is Extract<ResearchNode, { type: 'paragraph' }> =>
      node.type === 'paragraph',
  )
  const paper: ResearchPaper = {
    id: `pdf-${sourceHash.slice(0, 16)}`,
    version: '1.0.0-import',
    status: 'working',
    title:
      metadata.title?.trim() ||
      firstHeading?.text ||
      fileName.replace(/\.pdf$/i, ''),
    subtitle:
      metadata.subject?.trim() || `Reconstructed locally from ${fileName}`,
    authors: parseAuthors(metadata.author),
    updated: validDate(metadata.modified),
    abstract:
      firstParagraph?.text.slice(0, 700) ||
      'This document requires OCR or manual reconstruction before publication.',
    nodes,
  }

  return {
    source: {
      fileName,
      byteLength,
      sha256: sourceHash,
      pageCount: pages.length,
      localOnly: true,
    },
    paper,
    pages,
    provenance,
    diagnostics,
  }
}
