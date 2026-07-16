import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReadingOrderEdge,
  PdfReadingOrderEvaluation,
  PdfReadingOrderGraph,
  PdfRegionColumn,
  PdfRegionKind,
  PdfRegionLine,
} from './import-types'
import { groupRunsIntoLines, type PdfTextLine } from './pdf-lines'

type ClassifiedLine = PdfTextLine & {
  id: string
  kind: PdfRegionKind
  confidence: number
  noteLabel: string | null
}

type ColumnLayout = {
  split: number | null
  accepted: boolean
  ambiguous: boolean
}

const NOTE_LABEL = String.raw`(?:\d{1,3}|[*†‡§])`

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

function quantile(values: number[], fraction: number) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[
    Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))
  ]
}

function normalizeMarginText(text: string) {
  return text
    .toLocaleLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

function repeatedMarginKeys(linesByPage: PdfTextLine[][]) {
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

export function normalizedNoteLabel(value: string) {
  const superscripts: Record<string, string> = {
    '⁰': '0',
    '¹': '1',
    '²': '2',
    '³': '3',
    '⁴': '4',
    '⁵': '5',
    '⁶': '6',
    '⁷': '7',
    '⁸': '8',
    '⁹': '9',
  }
  return [...value]
    .map((character) => superscripts[character] ?? character)
    .join('')
    .trim()
}

export function noteLabelFromText(text: string) {
  const normalized = normalizedNoteLabel(text)
  const explicit = normalized.match(
    new RegExp(`^(?:footnote|note)\\s+(${NOTE_LABEL})(?:\\s*[:.)-]|\\s+)`, 'i'),
  )
  if (explicit) return explicit[1]
  const leading = normalized.match(
    new RegExp(`^(${NOTE_LABEL})(?:[.)\\]]|\\s+)`),
  )
  return leading?.[1] ?? null
}

function bodyFontSize(lines: PdfTextLine[]) {
  const central = lines.filter(
    (line) => line.y > 0.1 && line.y + line.height < 0.9,
  )
  const sizes = (central.length > 0 ? central : lines)
    .map((line) => line.fontSize)
    .filter((size) => size > 0)
  return quantile(sizes, 0.75) || median(sizes) || 12
}

function detectColumns(lines: ClassifiedLine[]): ColumnLayout {
  const candidates = lines.filter(
    (line) => line.kind === 'body' && line.text.length > 1 && line.width < 0.72,
  )
  const gaps: Array<{
    split: number
    left: ClassifiedLine
    right: ClassifiedLine
  }> = []
  for (let index = 0; index < candidates.length; index += 1) {
    for (
      let nextIndex = index + 1;
      nextIndex < candidates.length;
      nextIndex += 1
    ) {
      const first = candidates[index]
      const second = candidates[nextIndex]
      const left = first.x <= second.x ? first : second
      const right = left === first ? second : first
      const centerDifference = Math.abs(
        left.y + left.height / 2 - (right.y + right.height / 2),
      )
      const gap = right.x - (left.x + left.width)
      if (
        centerDifference > Math.max(0.007, left.height, right.height) ||
        gap <= Math.max(0.01, Math.min(left.height, right.height) * 0.6)
      ) {
        continue
      }
      gaps.push({ split: left.x + left.width + gap / 2, left, right })
    }
  }
  if (gaps.length === 0) {
    return { split: null, accepted: false, ambiguous: false }
  }

  const clusters = gaps.map((seed) => {
    const members = gaps.filter(
      (candidate) => Math.abs(candidate.split - seed.split) <= 0.05,
    )
    return {
      members,
      split: median(members.map((member) => member.split)),
    }
  })
  const strongest = clusters.sort(
    (left, right) =>
      right.members.length - left.members.length || left.split - right.split,
  )[0]
  const tolerance = 0.008
  const leftLines = candidates.filter(
    (line) => line.x + line.width <= strongest.split + tolerance,
  )
  const rightLines = candidates.filter(
    (line) => line.x >= strongest.split - tolerance,
  )
  const leftRange = [
    Math.min(...leftLines.map((line) => line.y)),
    Math.max(...leftLines.map((line) => line.y + line.height)),
  ]
  const rightRange = [
    Math.min(...rightLines.map((line) => line.y)),
    Math.max(...rightLines.map((line) => line.y + line.height)),
  ]
  const overlapsVertically =
    leftLines.length > 0 &&
    rightLines.length > 0 &&
    Math.min(leftRange[1], rightRange[1]) >
      Math.max(leftRange[0], rightRange[0])
  const accepted =
    overlapsVertically &&
    strongest.members.length >= 3 &&
    leftLines.length >= 3 &&
    rightLines.length >= 3
  const ambiguous =
    !accepted &&
    overlapsVertically &&
    leftLines.length >= 2 &&
    rightLines.length >= 2
  return {
    split: accepted || ambiguous ? rounded(strongest.split) : null,
    accepted,
    ambiguous,
  }
}

function columnFor(line: PdfTextLine, layout: ColumnLayout): PdfRegionColumn {
  if (layout.split === null) return 'single'
  const tolerance = Math.max(0.006, line.height * 0.4)
  if (line.x + line.width <= layout.split + tolerance) return 'left'
  if (line.x >= layout.split - tolerance) return 'right'
  return 'span'
}

function lineBox(line: PdfTextLine): NormalizedSourceBox {
  return {
    page: line.page,
    x: rounded(line.x),
    y: rounded(line.y),
    width: rounded(line.width),
    height: rounded(line.height),
    rotation: line.runs[0]?.rotation ?? 0,
    method: line.runs.some((run) => run.method === 'ocr') ? 'ocr' : 'pdf-text',
  }
}

function unionBox(lines: PdfRegionLine[]): NormalizedSourceBox {
  const left = Math.min(...lines.map((line) => line.box.x))
  const top = Math.min(...lines.map((line) => line.box.y))
  const right = Math.max(...lines.map((line) => line.box.x + line.box.width))
  const bottom = Math.max(...lines.map((line) => line.box.y + line.box.height))
  return {
    page: lines[0].box.page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: lines[0].box.rotation,
    method: lines.some((line) => line.box.method === 'ocr')
      ? 'ocr'
      : 'pdf-text',
  }
}

function joinsRegion(previous: ClassifiedLine, line: ClassifiedLine) {
  if (previous.page !== line.page) return false
  if (previous.kind !== line.kind || previous.column !== line.column)
    return false
  if (
    (line.kind === 'footnote' || line.kind === 'endnote') &&
    line.noteLabel !== null
  ) {
    return false
  }
  if (line.kind === 'chart-label' || line.kind === 'page-number') return false
  const gap = line.y - (previous.y + previous.height)
  const fontRatio =
    Math.max(previous.fontSize, line.fontSize) /
    Math.max(1, Math.min(previous.fontSize, line.fontSize))
  return (
    gap >= -0.004 &&
    gap <= Math.max(0.024, Math.max(previous.height, line.height) * 1.6) &&
    fontRatio <= 1.2
  )
}

function makeRegions(lines: ClassifiedLine[]) {
  const groups: ClassifiedLine[][] = []
  const ordered = [...lines].sort(
    (left, right) =>
      left.page - right.page ||
      left.column.localeCompare(right.column) ||
      left.y - right.y ||
      left.x - right.x,
  )
  for (const line of ordered) {
    const previousGroup = groups.at(-1)
    const previous = previousGroup?.at(-1)
    if (previous && joinsRegion(previous, line)) previousGroup!.push(line)
    else groups.push([line])
  }

  const sourceOrderedGroups = groups.sort(
    (left, right) =>
      left[0].page - right[0].page ||
      left[0].y - right[0].y ||
      left[0].x - right[0].x,
  )
  const pageCounters = new Map<number, number>()
  return sourceOrderedGroups.map<PdfPageRegion>((group) => {
    const page = group[0].page
    const number = (pageCounters.get(page) ?? 0) + 1
    pageCounters.set(page, number)
    const regionLines = group.map<PdfRegionLine>((line) => ({
      id: line.id,
      text: line.text,
      fontSize: rounded(line.fontSize),
      box: lineBox(line),
      runs: line.runs.map((run) => ({ ...run })),
    }))
    const kind = group[0].kind
    return {
      id: `page-${String(page).padStart(3, '0')}-region-${String(number).padStart(3, '0')}`,
      page,
      kind,
      column: group[0].column,
      text: group.map((line) => line.text).join(' '),
      confidence: rounded(Math.min(...group.map((line) => line.confidence))),
      box: unionBox(regionLines),
      lines: regionLines,
      nativeObjectIds: [],
      includedInReadingOrder: ![
        'header',
        'footer',
        'page-number',
        'side',
        'chart-label',
      ].includes(kind),
    }
  })
}

function makeObjectRegions(
  pages: PdfPageAnalysis[],
  layouts: Map<number, ColumnLayout>,
) {
  return pages.flatMap((page) =>
    (page.objects ?? [])
      .filter((object) => object.role !== 'scan-source')
      .map<PdfPageRegion>((object, index) => {
        const layout = layouts.get(page.page) ?? {
          split: null,
          accepted: false,
          ambiguous: false,
        }
        const column = columnFor(
          {
            page: page.page,
            text: '',
            x: object.box.x,
            y: object.box.y,
            width: object.box.width,
            height: object.box.height,
            fontSize: 0,
            runs: [],
            column: 'single',
          },
          layout,
        )
        return {
          id: `page-${String(page.page).padStart(3, '0')}-object-region-${String(index + 1).padStart(3, '0')}`,
          page: page.page,
          kind: 'figure',
          column,
          text: '',
          confidence: object.confidence,
          box: { ...object.box },
          lines: [],
          nativeObjectIds: [object.id],
          includedInReadingOrder: true,
        }
      }),
  )
}

function columnOrdered(regions: PdfPageRegion[]) {
  const byY = (left: PdfPageRegion, right: PdfPageRegion) =>
    left.box.y - right.box.y || left.box.x - right.box.x
  return [
    ...regions.filter((region) => region.column === 'left').sort(byY),
    ...regions.filter((region) => region.column === 'right').sort(byY),
    ...regions
      .filter(
        (region) => region.column === 'single' || region.column === 'span',
      )
      .sort(byY),
  ]
}

function orderPageRegions(regions: PdfPageRegion[], layout: ColumnLayout) {
  const included = regions.filter((region) => region.includedInReadingOrder)
  const notes = included.filter(
    (region) => region.kind === 'footnote' || region.kind === 'endnote',
  )
  const flow = included.filter(
    (region) => region.kind !== 'footnote' && region.kind !== 'endnote',
  )
  if (layout.split === null) {
    return [
      ...flow.sort(
        (left, right) => left.box.y - right.box.y || left.box.x - right.box.x,
      ),
      ...notes.sort(
        (left, right) => left.box.y - right.box.y || left.box.x - right.box.x,
      ),
    ]
  }

  const spanning = flow
    .filter((region) => region.column === 'span')
    .sort((left, right) => left.box.y - right.box.y)
  const columnFlow = flow.filter((region) => region.column !== 'span')
  const ordered: PdfPageRegion[] = []
  let boundary = Number.NEGATIVE_INFINITY
  for (const span of spanning) {
    const band = columnFlow.filter(
      (region) => region.box.y >= boundary && region.box.y < span.box.y,
    )
    ordered.push(...columnOrdered(band), span)
    boundary = span.box.y + span.box.height
  }
  ordered.push(
    ...columnOrdered(columnFlow.filter((region) => region.box.y >= boundary)),
    ...columnOrdered(notes),
  )
  return ordered
}

function edgeEvidence(from: PdfPageRegion, to: PdfPageRegion) {
  if (from.page !== to.page) {
    return {
      code: 'page-sequence' as const,
      detail: `Page ${from.page} precedes page ${to.page}.`,
    }
  }
  if (to.kind === 'footnote' || to.kind === 'endnote') {
    return {
      code: 'note-after-body' as const,
      detail: 'The separated note region follows the page body flow.',
    }
  }
  if (from.column !== to.column) {
    return {
      code: 'column-flow' as const,
      detail: `${from.column} column flow precedes ${to.column} column flow.`,
    }
  }
  if (
    from.kind === 'spanning' ||
    to.kind === 'spanning' ||
    from.column === 'span' ||
    to.column === 'span'
  ) {
    return {
      code: 'spanning-boundary' as const,
      detail: 'A page-spanning region forms a deterministic flow boundary.',
    }
  }
  return {
    code: 'vertical-flow' as const,
    detail: 'Regions in the same flow follow normalized vertical geometry.',
  }
}

function hasAcceptedCycle(regionIds: string[], edges: PdfReadingOrderEdge[]) {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges.filter(
    (candidate) => candidate.status === 'accepted',
  )) {
    const targets = outgoing.get(edge.from) ?? []
    targets.push(edge.to)
    outgoing.set(edge.from, targets)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    if ((outgoing.get(id) ?? []).some(visit)) return true
    visiting.delete(id)
    visited.add(id)
    return false
  }
  return regionIds.some(visit)
}

function buildReadingOrder(
  regions: PdfPageRegion[],
  layouts: Map<number, ColumnLayout>,
) {
  const orderedRegions = [...layouts.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([page, layout]) =>
      orderPageRegions(
        regions.filter((region) => region.page === page),
        layout,
      ),
    )
  const edges: PdfReadingOrderEdge[] = []
  for (let index = 0; index < orderedRegions.length - 1; index += 1) {
    const from = orderedRegions[index]
    const to = orderedRegions[index + 1]
    const layout = layouts.get(from.page)
    const ambiguousBoundary =
      from.page === to.page &&
      Boolean(layout?.ambiguous) &&
      from.column === 'left' &&
      to.column === 'right'
    edges.push({
      id: `reading-edge-${String(edges.length + 1).padStart(4, '0')}`,
      from: from.id,
      to: to.id,
      status: ambiguousBoundary ? 'candidate' : 'accepted',
      confidence: ambiguousBoundary ? 0.5 : 0.96,
      evidence: ambiguousBoundary
        ? [
            {
              code: 'ambiguous-column-flow',
              detail:
                'Both column orders remain candidates because the page has too little repeated geometry.',
            },
          ]
        : [edgeEvidence(from, to)],
      sourceBoxes: [from.box, to.box],
    })
    if (ambiguousBoundary) {
      const rightRegions = orderedRegions.filter(
        (region) => region.page === from.page && region.column === 'right',
      )
      const leftRegions = orderedRegions.filter(
        (region) => region.page === from.page && region.column === 'left',
      )
      const reverseFrom = rightRegions.at(-1)
      const reverseTo = leftRegions[0]
      if (reverseFrom && reverseTo) {
        edges.push({
          id: `reading-edge-${String(edges.length + 1).padStart(4, '0')}`,
          from: reverseFrom.id,
          to: reverseTo.id,
          status: 'candidate',
          confidence: 0.5,
          evidence: [
            {
              code: 'ambiguous-column-flow',
              detail:
                'The reverse column order is retained for bounded review.',
            },
          ],
          sourceBoxes: [reverseFrom.box, reverseTo.box],
        })
      }
    }
  }
  const regionIds = regions.map((region) => region.id)
  const acyclic = !hasAcceptedCycle(regionIds, edges)
  const unresolvedEdgeCount = edges.filter(
    (edge) => edge.status === 'candidate',
  ).length
  const evaluation: PdfReadingOrderEvaluation = {
    schemaVersion: '1.0.0',
    algorithm: 'deterministic-geometry-v1',
    mode: 'deterministic-only',
    regionCount: orderedRegions.length,
    acceptedEdgeCount: edges.length - unresolvedEdgeCount,
    unresolvedEdgeCount,
    cycleRate: acyclic ? 0 : 1,
    orderAccuracy: null,
    provider: null,
    modelVersion: null,
    latencyMs: 0,
    costUsd: 0,
    reviewRequired: !acyclic || unresolvedEdgeCount > 0,
  }
  return {
    schemaVersion: '1.0.0',
    regionIds,
    order: orderedRegions.map((region) => region.id),
    edges,
    acyclic,
    evaluation,
  } satisfies PdfReadingOrderGraph
}

export function evaluateReadingOrder(
  graph: PdfReadingOrderGraph,
  expectedOrder?: readonly string[],
) {
  if (!expectedOrder) return { ...graph.evaluation }
  const expectedPositions = new Map(
    expectedOrder.map((id, index) => [id, index]),
  )
  const comparable = graph.order.filter((id) => expectedPositions.has(id))
  const correct = comparable.filter(
    (id, index) => expectedPositions.get(id) === index,
  ).length
  return {
    ...graph.evaluation,
    orderAccuracy:
      expectedOrder.length === 0
        ? 1
        : rounded(correct / Math.max(expectedOrder.length, graph.order.length)),
  }
}

export function reconstructPageRegions(pages: PdfPageAnalysis[]) {
  const rawLines = pages.map(groupRunsIntoLines)
  const repeated = repeatedMarginKeys(rawLines)
  const classified: ClassifiedLine[] = []
  const layouts = new Map<number, ColumnLayout>()
  let inEndnotes = false

  for (const [pageIndex, pageLines] of rawLines.entries()) {
    const page = pages[pageIndex]
    const fontSize = bodyFontSize(pageLines)
    const lowerBand = quantile(
      pageLines.map((line) => line.y + line.height),
      0.65,
    )
    const preliminary = pageLines
      .sort((left, right) => left.y - right.y || left.x - right.x)
      .map<ClassifiedLine>((line, lineIndex) => {
        const normalized = normalizedNoteLabel(line.text)
        const endnoteHeading = /^(?:endnotes?|notes?)$/i.test(normalized)
        const label = noteLabelFromText(normalized)
        const explicitFootnote = new RegExp(
          `^(?:footnote|note)\\s+${NOTE_LABEL}`,
          'i',
        ).test(normalized)
        const renderedFootnote =
          label !== null &&
          line.fontSize <= fontSize * 0.9 &&
          line.y + line.height >= lowerBand
        let kind: PdfRegionKind = 'body'
        let confidence = 0.9
        if (inEndnotes && label !== null) {
          kind = 'endnote'
          confidence = 0.96
        } else if (explicitFootnote || renderedFootnote) {
          kind = 'footnote'
          confidence = explicitFootnote ? 0.98 : 0.9
        } else if (
          (line.y <= 0.1 || line.y + line.height >= 0.9) &&
          /^(?:\d{1,4}|[ivxlcdm]+)$/i.test(normalized)
        ) {
          kind = 'page-number'
          confidence = 0.98
        } else if (repeated.has(normalizeMarginText(line.text))) {
          kind = line.y < 0.5 ? 'header' : 'footer'
          confidence = 0.99
        } else if (line.y <= 0.08 && line.fontSize <= fontSize * 0.9) {
          kind = 'header'
          confidence = 0.78
        } else if (
          line.y + line.height >= 0.92 &&
          line.fontSize <= fontSize * 0.9
        ) {
          kind = 'footer'
          confidence = 0.78
        } else if (
          /^(?:fig(?:ure)?\.?\s*\d+\b|figure\s*[:.-])/i.test(normalized)
        ) {
          kind = 'caption'
          confidence = 0.94
        } else if (
          line.fontSize <= fontSize * 0.82 &&
          normalized.length <= 32 &&
          /(?:%|^[-+]?\d+(?:\.\d+)?$|^[A-Za-z]{1,12}$)/.test(normalized)
        ) {
          kind = 'chart-label'
          confidence = 0.82
        }
        if (endnoteHeading) inEndnotes = true
        return {
          ...line,
          id: `page-${String(page.page).padStart(3, '0')}-line-${String(lineIndex + 1).padStart(4, '0')}`,
          kind,
          confidence,
          noteLabel: label,
        }
      })

    const spreadBoundary =
      page.spread?.status === 'split' ? page.spread.boundary : null
    const layout: ColumnLayout =
      spreadBoundary !== null
        ? { split: spreadBoundary, accepted: true, ambiguous: false }
        : detectColumns(preliminary)
    layouts.set(page.page, layout)
    const commonX = median(
      preliminary.filter((line) => line.kind === 'body').map((line) => line.x),
    )
    for (const line of preliminary) {
      line.column = columnFor(line, layout)
      if (
        line.kind === 'body' &&
        line.column === 'span' &&
        layout.split !== null
      ) {
        line.kind = 'spanning'
        line.confidence = layout.accepted ? 0.95 : 0.58
      } else if (
        line.kind === 'body' &&
        line.fontSize <= fontSize * 0.85 &&
        line.text.length <= 120 &&
        Math.abs(line.x - commonX) > Math.max(0.18, line.width * 0.8)
      ) {
        line.kind = 'side'
        line.confidence = 0.76
      }
      if (
        layout.ambiguous &&
        (line.column === 'left' || line.column === 'right')
      ) {
        line.confidence = Math.min(line.confidence, 0.58)
      }
      classified.push(line)
    }
  }

  const regions = [
    ...makeRegions(classified),
    ...makeObjectRegions(pages, layouts),
  ].sort(
    (left, right) =>
      left.page - right.page ||
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id),
  )
  const readingOrder = buildReadingOrder(regions, layouts)
  return {
    regions,
    readingOrder,
    repeatedMarginCount: repeated.size,
    ambiguousPages: [...layouts.entries()]
      .filter(([, layout]) => layout.ambiguous)
      .map(([page]) => page),
  }
}
