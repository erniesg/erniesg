import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
  PdfVisualMatchCandidate,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import { createTableAsset, createTextSvgAsset } from './visual-assets'

type VisualKind = PdfVisualRelationship['kind']

type VisualCandidate = {
  kind: VisualKind
  sourceRegionIds: string[]
  sourceObjectIds: string[]
  assetIds: string[]
  sourceBoxes: NormalizedSourceBox[]
  sourceText: string
  page: number
  column: PdfPageRegion['column']
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function visualLabel(text: string) {
  const match = text
    .trim()
    .match(/^(fig(?:ure)?|table|eq(?:uation)?)\.?\s*([0-9]+|[ivxlcdm]+)\b/i)
  if (!match) return null
  const prefix = match[1].toLocaleLowerCase()
  const kind: VisualKind = prefix.startsWith('fig')
    ? 'figure'
    : prefix.startsWith('table')
      ? 'table'
      : 'equation'
  const name =
    kind === 'figure' ? 'Figure' : kind === 'table' ? 'Table' : 'Equation'
  return { kind, sequence: match[2], label: `${name} ${match[2]}` }
}

function boxGap(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  return {
    horizontal: Math.max(
      left.x - (right.x + right.width),
      right.x - (left.x + left.width),
      0,
    ),
    vertical: Math.max(
      left.y - (right.y + right.height),
      right.y - (left.y + left.height),
      0,
    ),
  }
}

function connected(left: PdfPageRegion, right: PdfPageRegion) {
  if (left.page !== right.page) return false
  const gap = boxGap(left.box, right.box)
  return (
    (gap.vertical === 0 && gap.horizontal <= 0.04) ||
    (gap.horizontal === 0 && gap.vertical <= 0.04)
  )
}

function figureCandidates(regions: PdfPageRegion[]) {
  const remaining = regions.filter(
    (region) => region.kind === 'figure' && region.nativeObjectIds.length > 0,
  )
  const groups: PdfPageRegion[][] = []
  while (remaining.length > 0) {
    const group = [remaining.shift()!]
    for (let index = 0; index < remaining.length; ) {
      if (group.some((region) => connected(region, remaining[index]))) {
        group.push(remaining.splice(index, 1)[0])
        index = 0
      } else {
        index += 1
      }
    }
    groups.push(group)
  }
  return groups
    .map<VisualCandidate>((group) => ({
      kind: 'figure',
      sourceRegionIds: group.map((region) => region.id),
      sourceObjectIds: group.flatMap((region) => region.nativeObjectIds),
      assetIds: [],
      sourceBoxes: group.map((region) => region.box),
      sourceText: '',
      page: group[0].page,
      column: group.every((region) => region.column === group[0].column)
        ? group[0].column
        : 'span',
    }))
    .sort(
      (left, right) =>
        left.page - right.page ||
        Math.min(...left.sourceBoxes.map((box) => box.y)) -
          Math.min(...right.sourceBoxes.map((box) => box.y)),
    )
}

function nextSourceRegions(
  caption: PdfPageRegion,
  regions: PdfPageRegion[],
  kind: 'table' | 'equation',
) {
  const maximumDistance = kind === 'table' ? 0.16 : 0.1
  const matches = regions
    .filter((region) => {
      const distance = region.box.y - (caption.box.y + caption.box.height)
      return (
        region.page === caption.page &&
        region.id !== caption.id &&
        region.lines.length > 0 &&
        distance >= -0.004 &&
        distance <= maximumDistance &&
        (kind === 'table'
          ? ['body', 'spanning', 'chart-label'].includes(region.kind)
          : ['body', 'spanning', 'equation'].includes(region.kind))
      )
    })
    .sort((left, right) => left.box.y - right.box.y)
  return kind === 'table' ? matches : matches.slice(0, 1)
}

function unionBox(regions: PdfPageRegion[]): NormalizedSourceBox {
  const left = Math.min(...regions.map((region) => region.box.x))
  const top = Math.min(...regions.map((region) => region.box.y))
  const right = Math.max(
    ...regions.map((region) => region.box.x + region.box.width),
  )
  const bottom = Math.max(
    ...regions.map((region) => region.box.y + region.box.height),
  )
  return {
    page: regions[0].page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: regions[0].box.rotation,
    method: regions.some((region) => region.box.method === 'ocr')
      ? 'ocr'
      : 'pdf-text',
  }
}

function mergeAsset(store: Map<string, PdfVisualAsset>, next: PdfVisualAsset) {
  const current = store.get(next.id)
  if (!current) {
    store.set(next.id, next)
    return
  }
  for (const [index, sourceObjectId] of next.sourceObjectIds.entries()) {
    if (current.sourceObjectIds.includes(sourceObjectId)) continue
    current.sourceObjectIds.push(sourceObjectId)
    current.sourceBoxes.push({ ...next.sourceBoxes[index] })
  }
}

function candidateScore(
  caption: PdfPageRegion,
  label: NonNullable<ReturnType<typeof visualLabel>>,
  candidate: VisualCandidate,
  sequence: number,
  regions: PdfPageRegion[],
) {
  if (candidate.page !== caption.page) return null
  const top = Math.min(...candidate.sourceBoxes.map((box) => box.y))
  const bottom = Math.max(
    ...candidate.sourceBoxes.map((box) => box.y + box.height),
  )
  const distance =
    label.kind === 'figure'
      ? caption.box.y - bottom
      : top - (caption.box.y + caption.box.height)
  if (distance < -0.02 || distance > 0.28) return null
  let score = 0.44
  const evidence = ['same-page-scope']
  if (distance <= 0.08) {
    score += 0.24 * (1 - Math.max(distance, 0) / 0.08)
    evidence.push('bounded-distance')
  }
  if (
    caption.column === candidate.column ||
    caption.column === 'span' ||
    candidate.column === 'span'
  ) {
    score += 0.1
    evidence.push('column-scope')
  }
  const numericSequence = Number.parseInt(label.sequence, 10)
  if (Number.isFinite(numericSequence) && numericSequence === sequence + 1) {
    score += 0.12
    evidence.push('label-sequence')
  }
  if (caption.confidence >= 0.9) {
    score += 0.05
    evidence.push('caption-typography')
  }
  const crossReference = new RegExp(
    `\\b${label.label.replace(/\s+/g, '\\s+')}\\b`,
    'i',
  )
  if (
    regions.some(
      (region) => region.id !== caption.id && crossReference.test(region.text),
    )
  ) {
    score += 0.05
    evidence.push('source-cross-reference')
  }
  return { score: rounded(Math.min(score, 1)), evidence }
}

function matchCandidate(
  caption: PdfPageRegion,
  label: NonNullable<ReturnType<typeof visualLabel>>,
  candidates: VisualCandidate[],
  regions: PdfPageRegion[],
) {
  const scored = candidates
    .map((candidate, index) => {
      const score = candidateScore(caption, label, candidate, index, regions)
      return score ? { candidate, ...score } : null
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.sourceObjectIds
          .join(':')
          .localeCompare(right.candidate.sourceObjectIds.join(':')),
    )
  const best = scored[0]
  const ambiguous =
    Boolean(best) && Boolean(scored[1]) && best.score - scored[1].score < 0.08
  return {
    scored,
    best,
    ambiguous,
    matched: Boolean(best) && best.score >= 0.72 && !ambiguous,
  }
}

function matchRecord(
  scored: ReturnType<typeof matchCandidate>['scored'][number],
): PdfVisualMatchCandidate {
  return {
    sourceRegionIds: scored.candidate.sourceRegionIds,
    sourceObjectIds: scored.candidate.sourceObjectIds,
    assetIds: scored.candidate.assetIds,
    score: scored.score,
    evidence: scored.evidence,
    sourceBoxes: scored.candidate.sourceBoxes,
  }
}

export async function reconstructPdfVisuals({
  pages,
  regions,
}: {
  pages: PdfPageAnalysis[]
  regions: PdfPageRegion[]
}) {
  const diagnostics: ReconstructionDiagnostic[] = []
  const assetStore = new Map<string, PdfVisualAsset>()
  for (const visualAsset of pages.flatMap((page) => page.assets ?? [])) {
    mergeAsset(assetStore, visualAsset)
  }
  const objectAssetIds = new Map(
    pages
      .flatMap((page) => page.objects ?? [])
      .map((object) => [object.id, object.assetId]),
  )
  const figures = figureCandidates(regions).map((candidate) => ({
    ...candidate,
    assetIds: candidate.sourceObjectIds
      .map((id) => objectAssetIds.get(id))
      .filter((id): id is string => Boolean(id)),
  }))
  const consumedRegionIds = new Set<string>()
  const relationships: PdfVisualRelationship[] = []
  const captions = regions.filter((region) => visualLabel(region.text))

  for (const [captionIndex, caption] of captions.entries()) {
    const label = visualLabel(caption.text)!
    let candidates = figures.filter(
      (candidate) => candidate.kind === label.kind,
    )
    if (label.kind === 'table' || label.kind === 'equation') {
      const sources = nextSourceRegions(caption, regions, label.kind)
      candidates = []
      if (sources.length > 0) {
        const sourceBox = unionBox(sources)
        const sourceObjectId = `${label.kind}-p${String(sourceBox.page).padStart(3, '0')}-${String(captionIndex + 1).padStart(3, '0')}`
        const page = pages.find((item) => item.page === sourceBox.page)!
        const lines = sources.flatMap((source) => source.lines)
        const visualAsset =
          label.kind === 'table'
            ? await createTableAsset({
                sourceObjectId,
                sourceBox,
                lines,
                pageWidth: page.width,
                pageHeight: page.height,
              })
            : await createTextSvgAsset({
                kind: 'equation',
                sourceObjectId,
                sourceBox,
                lines,
                pageWidth: page.width,
                pageHeight: page.height,
              })
        mergeAsset(assetStore, visualAsset)
        candidates.push({
          kind: label.kind,
          sourceRegionIds: sources.map((source) => source.id),
          sourceObjectIds: [sourceObjectId],
          assetIds: [visualAsset.id],
          sourceBoxes: [sourceBox],
          sourceText: sources.map((source) => source.text).join(' '),
          page: sourceBox.page,
          column: sources.every((source) => source.column === sources[0].column)
            ? sources[0].column
            : 'span',
        })
        for (const source of sources) consumedRegionIds.add(source.id)
      }
    }
    const result = matchCandidate(caption, label, candidates, regions)
    const best = result.best?.candidate
    const payloadComplete =
      Boolean(best) &&
      best!.sourceObjectIds.length > 0 &&
      best!.assetIds.length === best!.sourceObjectIds.length
    const status = result.ambiguous
      ? ('ambiguous' as const)
      : result.matched && payloadComplete
        ? ('matched' as const)
        : ('unresolved' as const)
    if (status !== 'matched') {
      diagnostics.push({
        code:
          status === 'ambiguous'
            ? 'AMBIGUOUS_VISUAL_MATCH'
            : 'UNRESOLVED_VISUAL_OBJECT',
        severity: 'error',
        page: caption.page,
        message:
          status === 'ambiguous'
            ? `${label.label} retains ${result.scored.length} similarly scored visual candidates for review.`
            : `${label.label} has no source visual candidate above the deterministic confidence threshold.`,
      })
    }
    relationships.push({
      id: `visual-relationship-${String(relationships.length + 1).padStart(4, '0')}`,
      kind: label.kind,
      label: label.label,
      captionRegionId: caption.id,
      sourceRegionIds: status === 'matched' ? best!.sourceRegionIds : [],
      sourceObjectIds: status === 'matched' ? best!.sourceObjectIds : [],
      assetIds: status === 'matched' ? best!.assetIds : [],
      status,
      confidence: result.best?.score ?? 0,
      evidence:
        result.best && !payloadComplete
          ? [...result.best.evidence, 'source-rendition-unavailable']
          : (result.best?.evidence ?? ['no-source-candidate']),
      candidates: result.scored.map(matchRecord),
      sourceBoxes:
        status === 'matched'
          ? [caption.box, ...best!.sourceBoxes]
          : [caption.box],
      sourceText: status === 'matched' ? best!.sourceText : '',
      altText: caption.text,
      altTextSource: 'caption',
      canonicalNodeId: null,
      captionNodeId: null,
    })
  }

  const referenced = new Set(
    relationships.flatMap((relationship) => relationship.sourceObjectIds),
  )
  for (const object of pages.flatMap((page) => page.objects ?? [])) {
    if (referenced.has(object.id)) continue
    diagnostics.push({
      code: 'UNREFERENCED_VISUAL_ASSET',
      severity: 'error',
      page: object.page,
      message: `Source visual object ${object.id} has no unique caption relationship.`,
    })
  }

  return {
    assets: [...assetStore.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    relationships,
    consumedRegionIds,
    diagnostics,
  }
}
