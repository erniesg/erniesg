import type {
  NodeSourceEvidence,
  PdfPageRegion,
  PdfSourceRun,
} from './import-types'
import type { ResearchPaper } from './schema'

function median(values: readonly number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle]
}

function sourceRunVerticalAlign(
  line: PdfPageRegion['lines'][number],
  run: PdfSourceRun,
) {
  const substantiveRuns = line.runs.filter((candidate) =>
    Boolean(candidate.text.trim()),
  )
  if (substantiveRuns.length < 2) return undefined
  const maximumFontSize = Math.max(
    ...substantiveRuns.map((candidate) => candidate.fontSize),
  )
  if (run.fontSize >= maximumFontSize * 0.82) return undefined
  const baselineRuns = substantiveRuns.filter(
    (candidate) => candidate.fontSize >= maximumFontSize * 0.9,
  )
  if (baselineRuns.length === 0) return undefined
  const baselineCenter = median(
    baselineRuns.map((candidate) => candidate.y + candidate.height / 2),
  )
  const threshold = Math.max(
    0.0015,
    median(baselineRuns.map((candidate) => candidate.height)) * 0.12,
  )
  const runCenter = run.y + run.height / 2
  if (runCenter < baselineCenter - threshold) return 'superscript' as const
  if (runCenter > baselineCenter + threshold) return 'subscript' as const
  return undefined
}

function mathFont(fontName: string) {
  return /(?:^|[+,._\s-])(?:(?:CM|LM)MI(?:B)?\d+|MTMI\d*|MATH(?:ITALIC|ITAL)|CMSY\d+|MSAM\d+|MSBM\d+|MATHSYMBOL|SYMBOL)(?=$|[+,._\s-])/iu.test(
    fontName,
  )
}

function normalizedScriptToken(value: string) {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

/**
 * Returns only lexical subranges whose whitespace was emitted inside one
 * academic-math source run. Delimiter and operator spacing stays outside the
 * ranges, so a run such as `, RInf o.` renders as `, RInfo.` rather than
 * `,RInfo.`.
 *
 * A PDF source run is the smallest text unit for which the importer retains
 * font and geometry provenance. Restricting this repair to a single math-font
 * run prevents ordinary italic prose (and spacing between separate runs) from
 * being normalized.
 */
export function sourceMathAtomCompactionRanges(
  value: string,
  fontName: string,
) {
  if (!mathFont(fontName)) return []
  return [
    ...value.matchAll(
      /[\p{L}\p{N}]+(?:\s+[\p{L}\p{N}]+)+(?:\.)?/gu,
    ),
  ].flatMap((match) =>
    match.index === undefined ||
    match[0].trim().split(/\s+/u).length !== 2 ||
    match[0].replace(/\s+/gu, '').length > 16
      ? []
      : [{ start: match.index, end: match.index + match[0].length }],
  )
}

/**
 * Finds canonical inline math atoms whose source geometry proves one
 * math-font run but not the token boundary published inside that atom.
 *
 * PDF extraction can emit a single source run such as `P lot` for a raised
 * `Plot`, or `RInf o.` for a baseline `RInfo.` identifier. Preserving that
 * extractor-created whitespace would silently certify a token boundary the
 * source page does not prove.
 */
export function unprovedInlineMathAtomNodeIds({
  paper,
  provenance,
  regions,
}: {
  paper: ResearchPaper
  provenance: Record<string, NodeSourceEvidence> | undefined
  regions: readonly PdfPageRegion[]
}) {
  if (!provenance || regions.length === 0) return []
  const regionsById = new Map(regions.map((region) => [region.id, region]))
  const implicated = new Set<string>()

  for (const node of paper.nodes) {
    if (!('text' in node) || !node.inlineRuns?.length) continue
    const sourceRegions = (provenance[node.id]?.regionIds ?? [])
      .map((regionId) => regionsById.get(regionId))
      .filter((region): region is PdfPageRegion => Boolean(region))
    if (sourceRegions.length === 0) continue

    for (const inlineRun of node.inlineRuns) {
      const atomText = node.text.slice(inlineRun.start, inlineRun.end)
      if (!atomText.trim()) continue
      if (!inlineRun.compactMathAtom && !/\s/u.test(atomText)) continue
      const normalizedCanonicalToken = normalizedScriptToken(atomText)
      const hasSourceMathAtomProof = sourceRegions.some((region) =>
        region.lines.some((line) =>
          line.runs.some((sourceRun) =>
            sourceMathAtomCompactionRanges(
              sourceRun.text,
              sourceRun.fontName,
            ).some(
              (range) =>
                normalizedScriptToken(
                  sourceRun.text.slice(range.start, range.end),
                ) === normalizedCanonicalToken &&
                (!inlineRun.verticalAlign ||
                  sourceRunVerticalAlign(line, sourceRun) ===
                    inlineRun.verticalAlign),
            ),
          ),
        ),
      )
      if (
        (inlineRun.compactMathAtom && !hasSourceMathAtomProof) ||
        (!inlineRun.compactMathAtom &&
          /\s/u.test(atomText) &&
          hasSourceMathAtomProof)
      ) {
        implicated.add(node.id)
        break
      }
    }
  }

  return [...implicated]
}

// Transitional export for callers that predate baseline math-atom support.
export const unprovedInlineScriptNodeIds = unprovedInlineMathAtomNodeIds
