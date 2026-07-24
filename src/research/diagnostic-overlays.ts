import type {
  NormalizedSourceBox,
  PdfNoteRelationship,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReconstruction,
  ReconstructionDiagnostic,
} from './import-types'

export type DiagnosticOverlayCategory =
  | 'ocr'
  | 'page-content'
  | 'reading-order'
  | 'note-relationship'
  | 'asset'
  | 'completeness'

export const DIAGNOSTIC_OVERLAY_PALETTE: Record<
  DiagnosticOverlayCategory,
  { color: string; label: string }
> = {
  ocr: { color: '#dc2626', label: 'OCR' },
  'page-content': { color: '#7c3aed', label: 'Page content' },
  'reading-order': { color: '#2563eb', label: 'Reading order' },
  'note-relationship': { color: '#d97706', label: 'Note relationship' },
  asset: { color: '#059669', label: 'Asset' },
  completeness: { color: '#475569', label: 'Completeness' },
}

export type ReadingOrderCandidate = {
  id: 'left-then-right' | 'right-then-left'
  label: string
  regionIds: string[]
}

export type DiagnosticOverlayItem = {
  id: string
  index: number
  diagnostic: ReconstructionDiagnostic
  category: DiagnosticOverlayCategory
  color: string
  pages: number[]
  sourceBoxes: NormalizedSourceBox[]
  noteRelationship?: PdfNoteRelationship
  readingOrderCandidates?: ReadingOrderCandidate[]
}

export type DiagnosticOverlayPage = {
  page: number
  width: number
  height: number
  items: DiagnosticOverlayItem[]
  regions: PdfPageRegion[]
}

export type DiagnosticOverlayDocument = {
  diagnostics: DiagnosticOverlayItem[]
  pages: DiagnosticOverlayPage[]
}

function categoryFor(
  code: ReconstructionDiagnostic['code'],
): DiagnosticOverlayCategory {
  if (code === 'OCR_REQUIRED' || code === 'NO_RECONSTRUCTABLE_TEXT') {
    return 'ocr'
  }
  if (
    code === 'AMBIGUOUS_READING_ORDER' ||
    code === 'RESOLVED_READING_ORDER' ||
    code === 'SOURCE_ORDER_FLOAT_FALLBACK' ||
    code === 'READING_ORDER_CYCLE' ||
    code === 'LOW_CONFIDENCE_BLOCK' ||
    code === 'REPEATED_MARGIN_TEXT'
  ) {
    return 'reading-order'
  }
  if (
    code === 'AMBIGUOUS_NOTE_MATCH' ||
    code === 'UNRESOLVED_NOTE_REFERENCE' ||
    code === 'UNREFERENCED_NOTE'
  ) {
    return 'note-relationship'
  }
  if (
    code === 'INCOMPLETE_ASSET_COVERAGE' ||
    code === 'UNRESOLVED_SEMANTIC_OBJECTS'
  ) {
    return 'asset'
  }
  if (code.startsWith('INCOMPLETE_')) return 'completeness'
  return 'page-content'
}

function boxKey(box: NormalizedSourceBox) {
  return [
    box.page,
    box.x,
    box.y,
    box.width,
    box.height,
    box.rotation,
    box.method,
  ].join(':')
}

function uniqueBoxes(boxes: NormalizedSourceBox[]) {
  return [...new Map(boxes.map((box) => [boxKey(box), box])).values()].sort(
    (left, right) =>
      left.page - right.page ||
      left.y - right.y ||
      left.x - right.x ||
      left.width - right.width ||
      left.height - right.height,
  )
}

function byGeometry(left: PdfPageRegion, right: PdfPageRegion) {
  return (
    left.box.y - right.box.y ||
    left.box.x - right.box.x ||
    left.id.localeCompare(right.id)
  )
}

function readingOrderCandidates(
  page: number,
  reconstruction: PdfReconstruction,
): ReadingOrderCandidate[] {
  const regions = reconstruction.regions.filter(
    (region) => region.page === page && region.includedInReadingOrder,
  )
  const canonical = reconstruction.readingOrder.order.filter((id) =>
    regions.some((region) => region.id === id),
  )
  const left = regions
    .filter((region) => region.column === 'left')
    .sort(byGeometry)
  const right = regions
    .filter((region) => region.column === 'right')
    .sort(byGeometry)
  const boundaries = regions
    .filter((region) => region.column === 'span' || region.column === 'single')
    .sort(byGeometry)
  const reverseColumns = [...right, ...left, ...boundaries].map(
    (region) => region.id,
  )
  return [
    {
      id: 'left-then-right',
      label: 'Candidate A · left column then right column',
      regionIds: canonical,
    },
    {
      id: 'right-then-left',
      label: 'Candidate B · right column then left column',
      regionIds: reverseColumns,
    },
  ]
}

function relationshipFor(
  diagnostic: ReconstructionDiagnostic,
  reconstruction: PdfReconstruction,
) {
  if (diagnostic.relationshipId) {
    return reconstruction.noteRelationships.find(
      (relationship) => relationship.id === diagnostic.relationshipId,
    )
  }
  if (
    diagnostic.code !== 'AMBIGUOUS_NOTE_MATCH' &&
    diagnostic.code !== 'UNRESOLVED_NOTE_REFERENCE'
  ) {
    return undefined
  }
  return reconstruction.noteRelationships.find(
    (relationship) =>
      relationship.status !== 'matched' &&
      (diagnostic.page === undefined ||
        relationship.sourceBoxes.some((box) => box.page === diagnostic.page)),
  )
}

function inferredBoxes(
  diagnostic: ReconstructionDiagnostic,
  reconstruction: PdfReconstruction,
  relationship?: PdfNoteRelationship,
) {
  if (diagnostic.sourceBoxes?.length) return diagnostic.sourceBoxes
  if (diagnostic.noteMarkerClassification) {
    return [diagnostic.noteMarkerClassification.sourceBox]
  }
  if (relationship) {
    return [
      ...relationship.sourceBoxes,
      ...relationship.candidates.flatMap((candidate) => candidate.sourceBoxes),
    ]
  }
  const pages =
    diagnostic.page === undefined
      ? reconstruction.pages
      : reconstruction.pages.filter((page) => page.page === diagnostic.page)
  if (diagnostic.code === 'NO_RECONSTRUCTABLE_TEXT') {
    return pages.map((page) => ({
      page: page.page,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      rotation: page.rotation,
      method: 'pdf-object' as const,
    }))
  }
  if (diagnostic.code === 'INCOMPLETE_ASSET_COVERAGE') {
    return pages.flatMap((page) =>
      (page.objects ?? []).map((object) => object.box),
    )
  }
  if (diagnostic.code === 'UNRESOLVED_SEMANTIC_OBJECTS') {
    return [
      ...pages.flatMap((page) =>
        (page.objects ?? []).map((object) => object.box),
      ),
      ...reconstruction.regions
        .filter(
          (region) =>
            pages.some((page) => page.page === region.page) &&
            (['figure', 'caption', 'footnote', 'endnote'].includes(
              region.kind,
            ) ||
              /\b(?:table|equation)\s+\d+/i.test(region.text)),
        )
        .map((region) => region.box),
    ]
  }
  if (diagnostic.code === 'INCOMPLETE_RELATIONSHIP_COVERAGE') {
    return [
      ...reconstruction.noteRelationships.flatMap((item) => [
        ...item.sourceBoxes,
        ...item.candidates.flatMap((candidate) => candidate.sourceBoxes),
      ]),
      ...reconstruction.regions
        .filter((region) => region.kind === 'caption')
        .map((region) => region.box),
    ]
  }
  if (diagnostic.code === 'INCOMPLETE_TEXT_COVERAGE') {
    return pages.flatMap((page) => page.runs)
  }
  if (diagnostic.code === 'REPEATED_MARGIN_TEXT') {
    return reconstruction.regions
      .filter((region) => region.kind === 'header' || region.kind === 'footer')
      .map((region) => region.box)
  }
  if (diagnostic.code === 'READING_ORDER_CYCLE') {
    return reconstruction.regions
      .filter((region) => region.includedInReadingOrder)
      .map((region) => region.box)
  }
  if (diagnostic.page !== undefined) {
    return reconstruction.regions
      .filter((region) => region.page === diagnostic.page)
      .map((region) => region.box)
  }
  return []
}

export function buildDiagnosticOverlayDocument(
  reconstruction: PdfReconstruction,
): DiagnosticOverlayDocument {
  const diagnostics = reconstruction.diagnostics.map<DiagnosticOverlayItem>(
    (diagnostic, index) => {
      const category = categoryFor(diagnostic.code)
      const relationship = relationshipFor(diagnostic, reconstruction)
      const sourceBoxes = uniqueBoxes(
        inferredBoxes(diagnostic, reconstruction, relationship),
      )
      const pages = [
        ...new Set([
          ...(diagnostic.page === undefined ? [] : [diagnostic.page]),
          ...sourceBoxes.map((box) => box.page),
        ]),
      ].sort((left, right) => left - right)
      if (pages.length === 0) {
        pages.push(...reconstruction.pages.map((page) => page.page))
      }
      return {
        id: `diagnostic-${String(index + 1).padStart(4, '0')}`,
        index,
        diagnostic,
        category,
        color: DIAGNOSTIC_OVERLAY_PALETTE[category].color,
        pages,
        sourceBoxes,
        ...(relationship ? { noteRelationship: relationship } : {}),
        ...(diagnostic.code === 'AMBIGUOUS_READING_ORDER' &&
        diagnostic.page !== undefined
          ? {
              readingOrderCandidates: readingOrderCandidates(
                diagnostic.page,
                reconstruction,
              ),
            }
          : {}),
      }
    },
  )
  return {
    diagnostics,
    pages: reconstruction.pages.map((page) => ({
      page: page.page,
      width: page.width,
      height: page.height,
      items: diagnostics.filter((diagnostic) =>
        diagnostic.pages.includes(page.page),
      ),
      regions: reconstruction.regions.filter(
        (region) => region.page === page.page,
      ),
    })),
  }
}

function escapeMarkup(value: unknown) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function boxMarkup(
  box: NormalizedSourceBox,
  color: string,
  selected: boolean,
  pageHeight: number,
) {
  return `<rect x="${box.x * 1000}" y="${box.y * pageHeight}" width="${box.width * 1000}" height="${box.height * pageHeight}" fill="${color}" fill-opacity="${selected ? 0.16 : 0.06}" stroke="${color}" stroke-width="${selected ? 4 : 2}" vector-effect="non-scaling-stroke"/>`
}

function center(region: PdfPageRegion, pageHeight: number, offset: number) {
  return {
    x: (region.box.x + region.box.width / 2) * 1000 + offset,
    y: (region.box.y + region.box.height / 2) * pageHeight + offset,
  }
}

function readingOrderMarkup(
  item: DiagnosticOverlayItem,
  page: DiagnosticOverlayPage,
  pageHeight: number,
) {
  if (!item.readingOrderCandidates) return ''
  const regionMap = new Map(page.regions.map((region) => [region.id, region]))
  return item.readingOrderCandidates
    .map((candidate, candidateIndex) => {
      const color = candidateIndex === 0 ? '#2563eb' : '#d97706'
      const offset = candidateIndex === 0 ? -5 : 5
      const points = candidate.regionIds
        .map((id) => regionMap.get(id))
        .filter((region): region is PdfPageRegion => Boolean(region))
        .map((region) => center(region, pageHeight, offset))
      const line =
        points.length > 1
          ? `<polyline points="${points.map((point) => `${point.x},${point.y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="3" stroke-dasharray="${candidateIndex === 0 ? '8 4' : '3 4'}" vector-effect="non-scaling-stroke"/>`
          : ''
      const numbers = points
        .map(
          (point, index) =>
            `<g><circle cx="${point.x}" cy="${point.y}" r="12" fill="${color}" vector-effect="non-scaling-stroke"/><text x="${point.x}" y="${point.y + 4}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" font-weight="700" fill="white">${index + 1}</text></g>`,
        )
        .join('')
      return `${line}${numbers}`
    })
    .join('')
}

function noteRelationshipMarkup(
  item: DiagnosticOverlayItem,
  page: DiagnosticOverlayPage,
  pageHeight: number,
) {
  const relationship = item.noteRelationship
  if (!relationship) return ''
  const reference = page.regions.find(
    (region) => region.id === relationship.referenceRegionId,
  )
  if (!reference || reference.page !== page.page) return ''
  const referenceCenter = center(reference, pageHeight, 0)
  return relationship.candidates
    .map((candidate, index) => {
      const target = page.regions.find(
        (region) => region.id === candidate.targetRegionId,
      )
      if (!target) return ''
      const targetCenter = center(target, pageHeight, 0)
      const labelX = Math.min(targetCenter.x + 10, 760)
      const labelY = Math.max(targetCenter.y - 10 - index * 18, 18)
      return `<g><line x1="${referenceCenter.x}" y1="${referenceCenter.y}" x2="${targetCenter.x}" y2="${targetCenter.y}" stroke="${item.color}" stroke-width="3" vector-effect="non-scaling-stroke"/><circle cx="${targetCenter.x}" cy="${targetCenter.y}" r="6" fill="${item.color}"/><rect x="${labelX - 5}" y="${labelY - 14}" width="235" height="20" rx="3" fill="white" fill-opacity="0.92" stroke="${item.color}"/><text x="${labelX}" y="${labelY}" font-family="ui-monospace, monospace" font-size="11" fill="#111827">${escapeMarkup(`${candidate.score.toFixed(2)} · ${candidate.evidence.join(' · ')}`)}</text></g>`
    })
    .join('')
}

export function renderDiagnosticOverlaySvg(
  page: DiagnosticOverlayPage,
  selectedId?: string,
  options: { selectedOnly?: boolean } = {},
) {
  const pageHeight = (page.height / Math.max(page.width, 1)) * 1000
  const selected = page.items.find((item) => item.id === selectedId)
  const boxItems = options.selectedOnly
    ? selected
      ? [selected]
      : []
    : page.items
  const boxes = boxItems
    .flatMap((item) =>
      item.sourceBoxes
        .filter((box) => box.page === page.page)
        .map((box) =>
          boxMarkup(box, item.color, item.id === selectedId, pageHeight),
        ),
    )
    .join('')
  return `<svg class="pdf-diagnostic-overlay__svg" viewBox="0 0 1000 ${pageHeight}" role="img" aria-label="Diagnostic source boxes for page ${page.page}" xmlns="http://www.w3.org/2000/svg">${boxes}${selected ? readingOrderMarkup(selected, page, pageHeight) : ''}${selected ? noteRelationshipMarkup(selected, page, pageHeight) : ''}</svg>`
}

function renderSourcePageSvg(page: PdfPageAnalysis) {
  const pageHeight = (page.height / Math.max(page.width, 1)) * 1000
  const objects = (page.objects ?? [])
    .map(
      (object) =>
        `<rect x="${object.box.x * 1000}" y="${object.box.y * pageHeight}" width="${object.box.width * 1000}" height="${object.box.height * pageHeight}" fill="#e2e8f0" stroke="#94a3b8"/><text x="${object.box.x * 1000 + 8}" y="${object.box.y * pageHeight + 18}" font-family="ui-monospace, monospace" font-size="12" fill="#475569">source image</text>`,
    )
    .join('')
  const text = page.runs
    .map(
      (run) =>
        `<text x="${run.x * 1000}" y="${(run.y + run.height) * pageHeight}" font-family="Arial, sans-serif" font-size="${Math.max(run.height * pageHeight, 8)}" fill="#111827">${escapeMarkup(run.text)}</text>`,
    )
    .join('')
  return `<svg class="pdf-source-page" viewBox="0 0 1000 ${pageHeight}" role="img" aria-label="Deterministic source rendering for page ${page.page}" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="${pageHeight}" fill="white"/>${objects}${text}</svg>`
}

export function renderDiagnosticEvidenceHtml(
  reconstruction: PdfReconstruction,
  options: { overlays?: boolean; selectedDiagnosticId?: string } = {},
) {
  const model = buildDiagnosticOverlayDocument(reconstruction)
  const overlays = options.overlays !== false
  const selectedId =
    options.selectedDiagnosticId ??
    model.diagnostics.find((item) => item.diagnostic.severity === 'error')
      ?.id ??
    model.diagnostics[0]?.id
  const pages = model.pages
    .map((page) => {
      const source = reconstruction.pages.find(
        (candidate) => candidate.page === page.page,
      )!
      const layers = overlays
        ? `<div class="overlay-base">${renderDiagnosticOverlaySvg(page)}</div>${page.items
            .map(
              (item) =>
                `<div class="overlay-layer" data-overlay-id="${item.id}"${item.id === selectedId ? '' : ' hidden'}>${renderDiagnosticOverlaySvg(page, item.id, { selectedOnly: true })}</div>`,
            )
            .join('')}`
        : ''
      return `<section class="evidence-page"><h2>Page ${page.page}</h2><div class="page-frame">${renderSourcePageSvg(source)}${layers}</div></section>`
    })
    .join('')
  const diagnostics = model.diagnostics
    .map((item) => {
      const candidates = item.noteRelationship?.candidates
        .map(
          (candidate) =>
            `<li><strong>${escapeMarkup(candidate.targetRegionId)} · ${candidate.score.toFixed(2)}</strong><span>${escapeMarkup(candidate.evidence.join(' · '))}</span></li>`,
        )
        .join('')
      const orders = item.readingOrderCandidates
        ?.map(
          (candidate) =>
            `<li><strong>${escapeMarkup(candidate.label)}</strong><span>${escapeMarkup(candidate.regionIds.join(' → '))}</span></li>`,
        )
        .join('')
      return `<li class="diagnostic" data-diagnostic-id="${item.id}"><button type="button" data-select-diagnostic="${item.id}" aria-pressed="${item.id === selectedId}"><strong style="color:${item.color}">${escapeMarkup(item.diagnostic.code)}</strong><span>${escapeMarkup(item.diagnostic.message)}</span></button>${candidates ? `<ol>${candidates}</ol>` : ''}${orders ? `<ol>${orders}</ol>` : ''}</li>`
    })
    .join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeMarkup(reconstruction.source.fileName)} diagnostic evidence</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f1f5f9;color:#0f172a;font:14px/1.5 system-ui,sans-serif}header,main{width:min(1180px,calc(100% - 32px));margin:24px auto}header p{color:#475569}.layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:24px}.evidence-page{margin:0 0 24px}.page-frame{position:relative;overflow:hidden;border:1px solid #94a3b8;background:white;box-shadow:0 8px 24px #0f172a1f}.pdf-source-page{display:block;width:100%;height:auto}.overlay-base,.overlay-layer,.pdf-diagnostic-overlay__svg{position:absolute;inset:0;width:100%;height:100%}.overlay-layer[hidden]{display:none}.diagnostics{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow:auto;margin:0;padding:0;list-style:none}.diagnostic{display:grid;gap:5px;padding:12px 0;border-bottom:1px solid #cbd5e1}.diagnostic button{display:grid;gap:5px;width:100%;padding:8px;border:0;background:transparent;text-align:left;cursor:pointer}.diagnostic button[aria-pressed=true]{background:#e2e8f0}.diagnostic button>strong{font:700 11px ui-monospace,monospace}.diagnostic button>span,.diagnostic li span{display:block;color:#475569}.diagnostic ol{padding-left:28px}.diagnostic li{margin-top:6px;font-size:12px}@media(max-width:800px){.layout{grid-template-columns:1fr}.diagnostics{position:static;max-height:none}}
</style>
</head>
<body>
<header><h1>Visual diagnostic evidence</h1><p>${escapeMarkup(reconstruction.source.fileName)} · ${escapeMarkup(reconstruction.source.sha256)} · deterministic source rendering with normalized diagnostic overlays</p></header>
<main class="layout"><div>${pages}</div><ol class="diagnostics" aria-label="Accessible diagnostic list">${diagnostics}</ol></main>
${overlays ? `<script>(()=>{const buttons=[...document.querySelectorAll('[data-select-diagnostic]')];const layers=[...document.querySelectorAll('[data-overlay-id]')];for(const button of buttons){button.addEventListener('click',()=>{const id=button.getAttribute('data-select-diagnostic');for(const candidate of buttons)candidate.setAttribute('aria-pressed',String(candidate===button));for(const layer of layers)layer.hidden=layer.getAttribute('data-overlay-id')!==id})}})()</script>` : ''}
</body>
</html>
`
}
