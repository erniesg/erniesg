import type { ResearchNode } from './schema'
import type {
  NormalizedSourceBox,
  PdfCitationRelationship,
  PdfLineBoundaryDecision,
  PdfPageRegion,
  PdfSourceRun,
  PdfVisualRelationship,
} from './import-types'
import { sourceMathAtomCompactionRanges } from './pdf-inline-script-integrity'
import { replayPdfRegionLineRanges } from './pdf-lines'
import {
  exactSourceRunRanges,
  normalizedInlineSourceText,
} from './pdf-source-run-ranges'
import type { ExactSourceRunRange } from './pdf-source-run-ranges'

type CanonicalInlineRun = NonNullable<
  Extract<ResearchNode, { type: 'paragraph' }>['inlineRuns']
>[number]

type InlineMappingLedger = { expected: number; mapped: number }

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

const EXPLICIT_BOLD_STYLE_FONT_NAME =
  /(?:^|[+,._\s-])(?:bold|black|demi(?:bold)?|semibold)(?:(?:italic|ital|oblique|obl))?(?=$|[+,._\s-])/iu
const CAMELCASE_BOLD_STYLE_FONT_NAME =
  /(?:Bold|Black|DemiBold|SemiBold)(?:Italic|Oblique)?$/u
const NIMBUS_ROMAN_BOLD_FACE_FONT_NAME =
  /(?:^|[+,._\s-])nimbusrom(?:an)?no9l-medi(?:um)?(?:(?:italic|ital|oblique|obl))?(?=$|[+,._\s-])/iu
const TEX_BOLD_FACE_FONT_NAME =
  /(?:^|[+,._\s-])(?:cm(?:bx|b)(?:ti|sl)?\d*|lin(?:biolinum|libertine)t?b(?:i)?)(?=$|[+,._\s-])/iu
export function fontNameIndicatesBold(fontName: string) {
  return (
    EXPLICIT_BOLD_STYLE_FONT_NAME.test(fontName) ||
    CAMELCASE_BOLD_STYLE_FONT_NAME.test(fontName) ||
    NIMBUS_ROMAN_BOLD_FACE_FONT_NAME.test(fontName) ||
    TEX_BOLD_FACE_FONT_NAME.test(fontName)
  )
}

export function boxesOverlap(
  left: {
    page?: number
    x: number
    y: number
    width: number
    height: number
  },
  right: {
    page?: number
    x: number
    y: number
    width: number
    height: number
  },
) {
  return (
    (left.page === undefined ||
      right.page === undefined ||
      left.page === right.page) &&
    Math.min(left.x + left.width, right.x + right.width) >
      Math.max(left.x, right.x) &&
    Math.min(left.y + left.height, right.y + right.height) >
      Math.max(left.y, right.y)
  )
}


const ACADEMIC_MATH_ITALIC_FONT_NAME =
  /(?:^|[+,._\s-])(?:(?:cm|lm)mi(?:b)?\d+|mtmi\d*|math(?:italic|ital))(?=$|[+,._\s-])/iu
const EXPLICIT_ITALIC_STYLE_FONT_NAME =
  /(?:^|[+,._\s-])(?:(?:(?:regular|regu|roman|book|medium|med|bold|demi|semi(?:bold)?)?(?:italic|ital|oblique|obl)|it)(?:mt)?)(?=$|[+,._\s-])/iu

export function fontNameIndicatesItalic(fontName: string) {
  return (
    ACADEMIC_MATH_ITALIC_FONT_NAME.test(fontName) ||
    EXPLICIT_ITALIC_STYLE_FONT_NAME.test(fontName)
  )
}

export function runVerticalAlign(
  line: PdfPageRegion['lines'][number],
  run: PdfPageRegion['lines'][number]['runs'][number],
) {
  const maximumFontSize = Math.max(
    ...line.runs.map((candidate) => candidate.fontSize),
  )
  if (run.fontSize >= maximumFontSize * 0.82) return undefined
  const baselineRuns = line.runs.filter(
    (candidate) => candidate.fontSize >= maximumFontSize * 0.9,
  )
  const baselineCenter = median(
    baselineRuns.map((candidate) => candidate.y + candidate.height / 2),
  )
  const runCenter = run.y + run.height / 2
  const threshold = Math.max(
    0.0015,
    median(baselineRuns.map((candidate) => candidate.height)) * 0.12,
  )
  if (runCenter < baselineCenter - threshold) return 'superscript' as const
  if (runCenter > baselineCenter + threshold) return 'subscript' as const
  return undefined
}


type CanonicalVisualTextSegment = {
  regionId: string
  lineId: string
  sourceStart: number
  sourceEnd: number
  canonicalStart: number
  text: string
  box: NormalizedSourceBox
}

type CanonicalVisualTextOwner = {
  nodeId: string
  relationshipId: string
  text: string
  segments: CanonicalVisualTextSegment[]
}

export function canonicalVisualSourceTranscript(
  relationship: Pick<PdfVisualRelationship, 'kind' | 'status' | 'sourceText'>,
  exactSourceText: string | null | undefined,
) {
  if (
    relationship.kind === 'table' &&
    relationship.status === 'matched' &&
    relationship.sourceText.trim()
  ) {
    return relationship.sourceText
  }
  return exactSourceText?.trim() ? exactSourceText : undefined
}

export function materializeCanonicalVisualNode({
  relationship,
  id,
  captionNodeId,
  source,
  table,
  sourceText,
  inlineRuns,
}: {
  relationship: PdfVisualRelationship
  id: string
  captionNodeId: string
  source: string
  table?: Extract<ResearchNode, { type: 'figure' }>['table']
  sourceText?: string
  inlineRuns?: Extract<ResearchNode, { type: 'figure' }>['inlineRuns']
}) {
  return {
    id,
    type: 'figure' as const,
    objectType: relationship.kind,
    ...(table ? { table } : {}),
    ...(sourceText ? { sourceText } : {}),
    ...(inlineRuns?.length ? { inlineRuns } : {}),
    title: relationship.altText,
    relationships: {
      caption: captionNodeId,
      assets: [...relationship.assetIds],
    },
    source,
  } satisfies Extract<ResearchNode, { type: 'figure' }>
}

export function canonicalVisualTextOwner(
  relationship: PdfVisualRelationship,
  nodeId: string,
  regions: PdfPageRegion[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
): CanonicalVisualTextOwner | null {
  if (
    relationship.kind !== 'table' ||
    relationship.status !== 'matched' ||
    !relationship.sourceText ||
    !relationship.sourceLineIds?.length ||
    new Set(relationship.sourceLineIds).size !==
      relationship.sourceLineIds.length
  ) {
    return null
  }
  const selectedRegionIds = new Set(relationship.sourceRegionIds)
  const lineOwners = new Map<
    string,
    Array<{ region: PdfPageRegion; line: PdfPageRegion['lines'][number] }>
  >()
  for (const region of regions.filter((candidate) =>
    selectedRegionIds.has(candidate.id),
  )) {
    for (const line of region.lines) {
      const owners = lineOwners.get(line.id) ?? []
      owners.push({ region, line })
      lineOwners.set(line.id, owners)
    }
  }
  const sourceRangesByRegion = new Map<
    string,
    ReturnType<typeof replayPdfRegionLineRanges>
  >()
  const segments: CanonicalVisualTextSegment[] = []
  let canonicalStart = 0
  for (const lineId of relationship.sourceLineIds) {
    const owners = lineOwners.get(lineId) ?? []
    if (owners.length !== 1) return null
    const { region, line } = owners[0]
    let ranges = sourceRangesByRegion.get(region.id)
    if (ranges === undefined) {
      ranges = replayPdfRegionLineRanges(region, lineBoundaryDecisions)
      sourceRangesByRegion.set(region.id, ranges)
    }
    if (ranges?.text !== region.text) return null
    const range = ranges.ranges.get(line.id)
    if (!range) return null
    segments.push({
      regionId: region.id,
      lineId,
      sourceStart: range.start,
      sourceEnd: range.end,
      canonicalStart,
      text: line.text,
      box: { ...line.box },
    })
    canonicalStart += line.text.length + 1
  }
  if (
    segments.map((segment) => segment.text).join(' ') !==
    relationship.sourceText
  ) {
    return null
  }
  return {
    nodeId,
    relationshipId: relationship.id,
    text: relationship.sourceText,
    segments,
  }
}

export function exactVisualCanonicalRangeForSource(
  owner: CanonicalVisualTextOwner,
  relationship: Pick<
    PdfCitationRelationship,
    'referenceRegionId' | 'referenceStart' | 'referenceEnd' | 'sourceBoxes'
  >,
  regionsById: ReadonlyMap<string, PdfPageRegion>,
) {
  if (
    relationship.referenceStart < 0 ||
    relationship.referenceStart >= relationship.referenceEnd
  ) {
    return null
  }
  const region = regionsById.get(relationship.referenceRegionId)
  if (!region) return null
  const markerText = region.text.slice(
    relationship.referenceStart,
    relationship.referenceEnd,
  )
  if (!markerText) return null
  const segments = owner.segments.filter(
    (segment) =>
      segment.regionId === relationship.referenceRegionId &&
      segment.sourceStart <= relationship.referenceStart &&
      segment.sourceEnd >= relationship.referenceEnd &&
      relationship.sourceBoxes.some((box) => boxesOverlap(box, segment.box)),
  )
  if (segments.length !== 1) return null
  const segment = segments[0]
  const start =
    segment.canonicalStart + relationship.referenceStart - segment.sourceStart
  const end = start + markerText.length
  return owner.text.slice(start, end) === markerText
    ? { nodeId: owner.nodeId, start, end }
    : null
}

export function supportedSourceInlineStyle({
  regionId,
  line,
  run,
  runIndex,
  removedStandaloneDiscretionaryHyphens,
}: {
  regionId: string
  line: PdfPageRegion['lines'][number]
  run: PdfSourceRun
  runIndex: number
  removedStandaloneDiscretionaryHyphens: ReadonlySet<string>
}) {
  const sourceText = normalizedInlineSourceText(run.text)
  if (!sourceText) return null
  if (
    runIndex === line.runs.length - 1 &&
    /^[-‐‑]$/u.test(sourceText) &&
    /^[-‐‑]$/u.test(run.text.replace(/\s+/gu, '')) &&
    removedStandaloneDiscretionaryHyphens.has(`${regionId}:${line.id}`)
  ) {
    // PDF producers often emit the discretionary hyphen as its own styled
    // glyph run. Once the source-proved boundary decision removes that glyph,
    // it has no canonical range or inline semantic obligation of its own.
    return null
  }
  const bold = run.bold ?? fontNameIndicatesBold(run.fontName)
  const italic = run.italic ?? fontNameIndicatesItalic(run.fontName)
  const verticalAlign = runVerticalAlign(line, run)
  const compactMathSpans = sourceMathAtomCompactionRanges(
    sourceText,
    run.fontName,
  )
  return {
    sourceText,
    bold,
    italic,
    verticalAlign,
    compactMathSpans,
    expectedStyleCount:
      Number(bold) +
      Number(italic) +
      Number(Boolean(verticalAlign)) +
      compactMathSpans.length,
  }
}

function canonicalVisualSourceInlineMappingFromOwner(
  owner: CanonicalVisualTextOwner,
  regionsById: ReadonlyMap<string, PdfPageRegion>,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const mapped = new Map<string, CanonicalInlineRun>()
  const ledger: InlineMappingLedger = { expected: 0, mapped: 0 }
  const removedStandaloneDiscretionaryHyphens = new Set(
    lineBoundaryDecisions.flatMap((decision) =>
      decision.outcome === 'removed-discretionary-hyphen'
        ? [`${decision.regionId}:${decision.fromLineId}`]
        : [],
    ),
  )
  const exactRangesByRegion = new Map<
    string,
    Map<PdfSourceRun, ExactSourceRunRange>
  >()
  for (const segment of owner.segments) {
    const region = regionsById.get(segment.regionId)
    const line = region?.lines.find(
      (candidate) => candidate.id === segment.lineId,
    )
    if (!region || !line) continue
    let exactRangesByRun = exactRangesByRegion.get(region.id)
    if (!exactRangesByRun) {
      exactRangesByRun = new Map(
        exactSourceRunRanges(region, lineBoundaryDecisions).map(
          (sourceRun) => [sourceRun.run, sourceRun] as const,
        ),
      )
      exactRangesByRegion.set(region.id, exactRangesByRun)
    }
    for (const [runIndex, run] of line.runs.entries()) {
      const style = supportedSourceInlineStyle({
        regionId: region.id,
        line,
        run,
        runIndex,
        removedStandaloneDiscretionaryHyphens,
      })
      if (!style || style.expectedStyleCount === 0) continue
      ledger.expected += style.expectedStyleCount
      const exactRange = exactRangesByRun.get(run)
      if (
        !exactRange ||
        exactRange.sourceStart < segment.sourceStart ||
        exactRange.sourceEnd > segment.sourceEnd
      ) {
        continue
      }
      const start =
        segment.canonicalStart + exactRange.sourceStart - segment.sourceStart
      const end = start + exactRange.sourceEnd - exactRange.sourceStart
      if (
        start < 0 ||
        start >= end ||
        end > owner.text.length ||
        owner.text.slice(start, end) !== exactRange.text
      ) {
        continue
      }
      const boundaries = [
        0,
        exactRange.text.length,
        ...style.compactMathSpans.flatMap((span) => [span.start, span.end]),
      ]
      const points = [...new Set(boundaries)].sort(
        (left, right) => left - right,
      )
      for (let index = 0; index < points.length - 1; index += 1) {
        const segmentStart = points[index]
        const segmentEnd = points[index + 1]
        if (segmentStart === segmentEnd) continue
        const compactMathAtom = style.compactMathSpans.some(
          (span) => span.start <= segmentStart && span.end >= segmentEnd,
        )
        const runStart = start + segmentStart
        const runEnd = start + segmentEnd
        const key = `${runStart}:${runEnd}`
        mapped.set(key, {
          ...mapped.get(key),
          start: runStart,
          end: runEnd,
          ...(style.bold ? { bold: true } : {}),
          ...(style.italic ? { italic: true } : {}),
          ...(style.verticalAlign
            ? { verticalAlign: style.verticalAlign }
            : {}),
          ...(compactMathAtom ? { compactMathAtom: true } : {}),
        })
      }
      ledger.mapped += style.expectedStyleCount
    }
  }
  return {
    runs: [...mapped.values()].sort(
      (left, right) => left.start - right.start || left.end - right.end,
    ),
    ledger,
  }
}

export function canonicalVisualSourceInlineMapping({
  relationship,
  nodeId,
  regions,
  lineBoundaryDecisions,
}: {
  relationship: PdfVisualRelationship
  nodeId: string
  regions: PdfPageRegion[]
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[]
}) {
  if (
    relationship.kind !== 'table' ||
    relationship.status !== 'matched' ||
    !relationship.sourceText ||
    !relationship.sourceLineIds?.length
  ) {
    return { runs: [], ledger: { expected: 0, mapped: 0 } }
  }
  const regionsById = new Map(
    regions.map((region) => [region.id, region] as const),
  )
  const owner = canonicalVisualTextOwner(
    relationship,
    nodeId,
    regions,
    lineBoundaryDecisions,
  )
  if (owner) {
    return canonicalVisualSourceInlineMappingFromOwner(
      owner,
      regionsById,
      lineBoundaryDecisions,
    )
  }
  const selectedRegionIds = new Set(relationship.sourceRegionIds)
  const selectedLineIds = new Set(relationship.sourceLineIds)
  const selectedLineOwnerCounts = new Map<string, number>()
  for (const region of regions.filter((candidate) =>
    selectedRegionIds.has(candidate.id),
  )) {
    for (const line of region.lines) {
      if (!selectedLineIds.has(line.id)) continue
      selectedLineOwnerCounts.set(
        line.id,
        (selectedLineOwnerCounts.get(line.id) ?? 0) + 1,
      )
    }
  }
  const invalidLineage =
    new Set(relationship.sourceLineIds).size !==
      relationship.sourceLineIds.length ||
    relationship.sourceLineIds.some(
      (lineId) => selectedLineOwnerCounts.get(lineId) !== 1,
    )
  const removedStandaloneDiscretionaryHyphens = new Set(
    lineBoundaryDecisions.flatMap((decision) =>
      decision.outcome === 'removed-discretionary-hyphen'
        ? [`${decision.regionId}:${decision.fromLineId}`]
        : [],
    ),
  )
  const expected = regions
    .filter((region) => selectedRegionIds.has(region.id))
    .flatMap((region) =>
      region.lines
        .filter((line) => selectedLineIds.has(line.id))
        .flatMap((line) =>
          line.runs.flatMap((run, runIndex) => {
            const style = supportedSourceInlineStyle({
              regionId: region.id,
              line,
              run,
              runIndex,
              removedStandaloneDiscretionaryHyphens,
            })
            return style ? [style.expectedStyleCount] : []
          }),
        ),
    )
    .reduce((total, count) => total + count, 0)
  // A malformed selected-line lineage cannot prove that it enumerated every
  // source style. Retain a sentinel obligation so the ordinary inline-coverage
  // gate remains fail-closed even when the missing line cannot be inspected.
  return {
    runs: [],
    ledger: { expected: expected + Number(invalidLineage), mapped: 0 },
  }
}
