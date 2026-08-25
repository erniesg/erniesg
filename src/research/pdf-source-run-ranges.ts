import type {
  PdfLineBoundaryDecision,
  PdfPageRegion,
  PdfSourceRun,
} from './import-types'
import {
  mergePdfRunText,
  positionedPdfPrefixAccentText,
  replayPdfRegionLineRanges,
} from './pdf-lines'

export function normalizedInlineSourceText(value: string) {
  return value
    .replace(/\u00ad/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const TEX_SUFFIX_PREFIX_ACCENT = /[¨¯´¸ˆˇ˘˙˚˜˝]$/u

export function sourceRunBoundaryNormalizationAliasText(
  left: PdfSourceRun,
  right: PdfSourceRun,
) {
  const leftText = normalizedInlineSourceText(left.text)
  const rightText = normalizedInlineSourceText(right.text)
  const leftSequence = left.sourceSequenceIndex
  const rightSequence = right.sourceSequenceIndex
  const sequenceProven =
    leftSequence === undefined && rightSequence === undefined
      ? true
      : leftSequence !== undefined &&
        rightSequence !== undefined &&
        rightSequence === leftSequence + 1
  const boundaryTolerance = Math.max(
    0.0015,
    Math.min(left.height, right.height) * 0.9,
  )
  if (
    !TEX_SUFFIX_PREFIX_ACCENT.test(leftText) ||
    !/^\p{L}/u.test(rightText) ||
    left.page !== right.page ||
    left.rotation !== right.rotation ||
    left.method !== right.method ||
    left.fontName !== right.fontName ||
    Boolean(left.bold) !== Boolean(right.bold) ||
    Boolean(left.italic) !== Boolean(right.italic) ||
    !sequenceProven ||
    right.sourceWhitespaceBefore !== undefined ||
    right.x < left.x ||
    Math.abs(right.x - (left.x + left.width)) > boundaryTolerance
  ) {
    return null
  }
  const sourceJoined = `${leftText}${rightText}`
  const normalized = normalizedInlineSourceText(mergePdfRunText([left, right]))
  return normalized && normalized !== sourceJoined ? normalized : null
}

export type ExactSourceRunRange = {
  line: PdfPageRegion['lines'][number]
  run: PdfSourceRun
  sourceStart: number
  sourceEnd: number
  text: string
}

type ExactSourceRunCandidate = {
  run: PdfSourceRun
  text: string
  occurrences: Array<{ start: number; end: number }>
}

export function retainUniqueMonotoneSourceRunAssignment(
  candidates: ExactSourceRunCandidate[],
) {
  // Repeated mathematical atoms (for example x, p, or a printed equation
  // number) are often individually ambiguous in the reconstructed line text.
  // Source run order can disambiguate them without guessing, but only when an
  // occurrence participates in a complete non-overlapping monotone assignment
  // for every substantive run on the line. Resolve the line only when exactly
  // one complete assignment exists; a locally fixed atom inside an otherwise
  // ambiguous sequence must remain fail-closed too.
  const substantive = candidates.filter((candidate) => candidate.text)
  if (substantive.length < 2) return false
  if (substantive.some((candidate) => candidate.occurrences.length === 0)) {
    substantive.forEach((candidate) => {
      candidate.occurrences = []
    })
    return false
  }

  const pathCounts = substantive.map((candidate) =>
    candidate.occurrences.map(() => 0),
  )
  substantive[0].occurrences.forEach((_, index) => {
    pathCounts[0][index] = 1
  })
  for (
    let candidateIndex = 1;
    candidateIndex < substantive.length;
    candidateIndex += 1
  ) {
    const previous = substantive[candidateIndex - 1]
    const candidate = substantive[candidateIndex]
    candidate.occurrences.forEach((occurrence, occurrenceIndex) => {
      pathCounts[candidateIndex][occurrenceIndex] = Math.min(
        2,
        previous.occurrences.reduce(
          (total, previousOccurrence, previousIndex) =>
            previousOccurrence.end <= occurrence.start
              ? total + pathCounts[candidateIndex - 1][previousIndex]
              : total,
          0,
        ),
      )
    })
  }
  const lastIndex = substantive.length - 1
  const completeAssignmentCount = Math.min(
    2,
    pathCounts[lastIndex].reduce((total, count) => total + count, 0),
  )
  if (completeAssignmentCount !== 1) {
    substantive.forEach((candidate) => {
      candidate.occurrences = []
    })
    return false
  }

  const assignment = new Array<number>(substantive.length)
  assignment[lastIndex] = pathCounts[lastIndex].findIndex(
    (count) => count === 1,
  )
  for (
    let candidateIndex = substantive.length - 2;
    candidateIndex >= 0;
    candidateIndex -= 1
  ) {
    const nextOccurrence =
      substantive[candidateIndex + 1].occurrences[
        assignment[candidateIndex + 1]
      ]
    const predecessors = substantive[candidateIndex].occurrences.flatMap(
      (occurrence, occurrenceIndex) =>
        pathCounts[candidateIndex][occurrenceIndex] === 1 &&
        occurrence.end <= nextOccurrence.start
          ? [occurrenceIndex]
          : [],
    )
    if (predecessors.length !== 1) {
      substantive.forEach((candidate) => {
        candidate.occurrences = []
      })
      return false
    }
    assignment[candidateIndex] = predecessors[0]
  }
  substantive.forEach((candidate, candidateIndex) => {
    candidate.occurrences = [candidate.occurrences[assignment[candidateIndex]]]
  })
  return true
}

export function retainUniqueSourceRunAssignmentWithAliases(
  candidates: ExactSourceRunCandidate[],
  partnerByRun: ReadonlyMap<PdfSourceRun, PdfSourceRun>,
) {
  // A positioned prefix accent and its target intentionally describe the same
  // canonical glyph interval. Collapse that pair to one logical atom, prove
  // one complete assignment across the whole line, then propagate the
  // selected interval back to both source runs. Unrelated logical atoms remain
  // non-overlapping.
  const grouped = new Set<ExactSourceRunCandidate>()
  const logicalCandidates = candidates.flatMap((candidate) => {
    if (grouped.has(candidate)) return []
    const partnerRun = partnerByRun.get(candidate.run)
    const partner = partnerRun
      ? candidates.find((peer) => peer.run === partnerRun)
      : undefined
    if (!partner || partner.text !== candidate.text) {
      grouped.add(candidate)
      return [{ logical: candidate, members: [candidate] }]
    }
    grouped.add(candidate)
    grouped.add(partner)
    const partnerOccurrences = new Set(
      partner.occurrences.map(
        (occurrence) => `${occurrence.start}:${occurrence.end}`,
      ),
    )
    return [
      {
        logical: {
          run: candidate.run,
          text: candidate.text,
          occurrences: candidate.occurrences.filter((occurrence) =>
            partnerOccurrences.has(`${occurrence.start}:${occurrence.end}`),
          ),
        },
        members: [candidate, partner],
      },
    ]
  })
  const unique =
    logicalCandidates.length === 1
      ? logicalCandidates[0].logical.occurrences.length === 1
      : retainUniqueMonotoneSourceRunAssignment(
          logicalCandidates.map(({ logical }) => logical),
        )
  for (const { logical, members } of logicalCandidates) {
    for (const member of members) {
      member.occurrences = [...logical.occurrences]
    }
  }
  return unique
}

function exactFallbackLineRanges(region: PdfPageRegion) {
  const ranges = new Map<string, { start: number; end: number }>()
  let cursor = 0
  for (const line of region.lines) {
    const text = normalizedInlineSourceText(line.text)
    if (!text) return null
    const start = region.text.indexOf(text, cursor)
    if (start < 0 || region.text.indexOf(text, start + 1) >= 0) {
      return null
    }
    const end = start + text.length
    ranges.set(line.id, { start, end })
    cursor = end
  }
  return ranges
}

export function exactSourceRunRanges(
  region: PdfPageRegion,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const replay = replayPdfRegionLineRanges(region, lineBoundaryDecisions)
  const lineRanges =
    replay?.text === region.text
      ? replay.ranges
      : lineBoundaryDecisions.some(
            (decision) => decision.regionId === region.id,
          )
        ? null
        : exactFallbackLineRanges(region)
  if (!lineRanges) return []

  const removedDiscretionaryHyphenLineIds = new Set(
    lineBoundaryDecisions.flatMap((decision) =>
      decision.regionId === region.id &&
      decision.outcome === 'removed-discretionary-hyphen'
        ? [decision.fromLineId]
        : [],
    ),
  )
  const mapped: ExactSourceRunRange[] = []
  for (const line of region.lines) {
    const lineRange = lineRanges.get(line.id)
    if (!lineRange) continue
    const positionedAccentTextByRun = new Map<PdfSourceRun, string>()
    const positionedAccentPartnerByRun = new Map<PdfSourceRun, PdfSourceRun>()
    for (let index = 0; index < line.runs.length - 1; index += 1) {
      const accent = line.runs[index]
      const target = line.runs[index + 1]
      const text = positionedPdfPrefixAccentText(accent, target)
      if (!text) continue
      const normalizedText = normalizedInlineSourceText(text)
      positionedAccentTextByRun.set(accent, normalizedText)
      positionedAccentTextByRun.set(target, normalizedText)
      positionedAccentPartnerByRun.set(accent, target)
      positionedAccentPartnerByRun.set(target, accent)
      index += 1
    }
    const candidates = line.runs.map((run, runIndex) => {
      let text =
        positionedAccentTextByRun.get(run) ??
        normalizedInlineSourceText(run.text)
      if (
        runIndex === line.runs.length - 1 &&
        removedDiscretionaryHyphenLineIds.has(line.id) &&
        /[-‐‑]$/u.test(text)
      ) {
        text = text.slice(0, -1)
      }
      const occurrences: Array<{ start: number; end: number }> = []
      if (text) {
        let cursor = lineRange.start
        while (cursor <= lineRange.end - text.length) {
          const start = region.text.indexOf(text, cursor)
          if (start < 0 || start + text.length > lineRange.end) break
          occurrences.push({ start, end: start + text.length })
          cursor = start + Math.max(text.length, 1)
        }
      }
      return { run, text, occurrences }
    })

    const firstWithCandidates = candidates.findIndex(
      (candidate) => candidate.occurrences.length > 0,
    )
    if (firstWithCandidates === 0) {
      const edge = candidates[0].occurrences.filter(
        (candidate) => candidate.start === lineRange.start,
      )
      if (edge.length > 0) candidates[0].occurrences = edge
    }
    let lastWithCandidates = -1
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (candidates[index].occurrences.length > 0) {
        lastWithCandidates = index
        break
      }
    }
    if (lastWithCandidates === candidates.length - 1) {
      const edge = candidates[lastWithCandidates].occurrences.filter(
        (candidate) => candidate.end === lineRange.end,
      )
      if (edge.length > 0) {
        candidates[lastWithCandidates].occurrences = edge
      }
    }

    // Some producers leave a spacing accent at the end of one source run and
    // the base letter at the start of the next. Whole-line normalization then
    // composes the pair even though neither raw run is an exact substring.
    // Use the exact combined interval only as a logical ordering atom; neither
    // physical run receives that broad interval as an inline-style mapping.
    const normalizationOnlyRuns = new Set<PdfSourceRun>()
    for (let index = 0; index < candidates.length - 1; index += 1) {
      const left = candidates[index]
      const right = candidates[index + 1]
      const boundaryAliasText = sourceRunBoundaryNormalizationAliasText(
        left.run,
        right.run,
      )
      const provedBoundaryAlias =
        left.occurrences.length === 0 && boundaryAliasText
      if (
        ((left.occurrences.length > 0 || right.occurrences.length > 0) &&
          !provedBoundaryAlias) ||
        positionedAccentPartnerByRun.has(left.run) ||
        positionedAccentPartnerByRun.has(right.run)
      ) {
        continue
      }
      const combinedText =
        provedBoundaryAlias ??
        normalizedInlineSourceText(mergePdfRunText([left.run, right.run]))
      if (!combinedText) continue
      const occurrences: Array<{ start: number; end: number }> = []
      let cursor = lineRange.start
      while (cursor <= lineRange.end - combinedText.length) {
        const start = region.text.indexOf(combinedText, cursor)
        if (start < 0 || start + combinedText.length > lineRange.end) break
        occurrences.push({ start, end: start + combinedText.length })
        cursor = start + Math.max(combinedText.length, 1)
      }
      if (occurrences.length === 0) continue
      left.text = combinedText
      right.text = combinedText
      left.occurrences = [...occurrences]
      right.occurrences = [...occurrences]
      positionedAccentPartnerByRun.set(left.run, right.run)
      positionedAccentPartnerByRun.set(right.run, left.run)
      normalizationOnlyRuns.add(left.run)
      normalizationOnlyRuns.add(right.run)
      index += 1
    }
    retainUniqueSourceRunAssignmentWithAliases(
      candidates,
      positionedAccentPartnerByRun,
    )
    for (const candidate of candidates) {
      if (normalizationOnlyRuns.has(candidate.run)) {
        candidate.occurrences = []
      }
    }

    for (const candidate of candidates) {
      if (candidate.occurrences.length !== 1) continue
      mapped.push({
        line,
        run: candidate.run,
        sourceStart: candidate.occurrences[0].start,
        sourceEnd: candidate.occurrences[0].end,
        text: candidate.text,
      })
    }
  }
  return mapped
}
