import type { ResearchNode } from './schema'
import type {
  NodeSourceEvidence,
  PdfLineBoundaryDecision,
  PdfLinkAnnotation,
  PdfPageRegion,
} from './import-types'
import { safePdfExternalLinkTarget } from './pdf-links'
import { canonicalRangeForSource } from './pdf-canonical-source-anchors'
import { exactSourceRunRanges } from './pdf-source-run-ranges'
import {
  boxesOverlap,
  supportedSourceInlineStyle,
} from './pdf-visual-source-mapping'

export type PdfInlineSourceBlock = {
  region: PdfPageRegion
  text: string
  confidence: number
  nodeId?: string
  sourceSegments?: Array<{
    region: PdfPageRegion
    evidenceRegion?: PdfPageRegion
    sourceStart: number
    canonicalStart: number
    text: string
  }>
}

export type PdfInlineSemanticReference = {
  id: string
  start: number
  end: number
  regionId: string
  semanticRole:
    | 'citation'
    | 'cross-reference'
    | 'affiliation-marker'
    | 'bibliography-entry'
    | 'note-reference'
  targetIds?: string[]
}

type CanonicalInlineRun = NonNullable<
  Extract<ResearchNode, { type: 'paragraph' }>['inlineRuns']
>[number]
type InlineMappingLedger = { expected: number; mapped: number }
type CanonicalHyperlinkMapping = {
  annotationId: string
  blockNodeId: string
  start: number
  end: number
  href: string
}

function inlineSourceSegments(block: PdfInlineSourceBlock) {
  return (
    block.sourceSegments ?? [
      {
        region: block.region,
        sourceStart: 0,
        canonicalStart: 0,
        text: block.text,
      },
    ]
  )
}

function roundedSourceEvidenceCoordinate(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function unmatchedClosingDelimiter(value: string, open: string, close: string) {
  return value.split(close).length > value.split(open).length
}

export function literalAbsoluteHyperlinks(value: string) {
  const links: Array<{ start: number; end: number; url: string }> = []
  for (const match of value.matchAll(/(?:https?:\/\/|mailto:)[^\s<>"']+/giu)) {
    if (match.index === undefined) continue
    let url = match[0].replace(/[.,;:!?]+$/u, '')
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ]) {
      while (
        url.endsWith(close) &&
        unmatchedClosingDelimiter(url, open, close)
      ) {
        url = url.slice(0, -1)
      }
    }
    if (!url || !safePdfExternalLinkTarget(url)) continue
    links.push({ start: match.index, end: match.index + url.length, url })
  }
  return links
}

export function sourceInlineRuns(
  block: PdfInlineSourceBlock,
  links: PdfLinkAnnotation[],
  canonicalHyperlinks: CanonicalHyperlinkMapping[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
  noteReferences: Array<{
    id: string
    start: number
    end: number
    regionId: string
    canonicalRange?: { start: number; end: number }
  }>,
  semanticReferences: Array<PdfInlineSemanticReference> = [],
) {
  const mapped = new Map<string, CanonicalInlineRun>()
  const ledger: InlineMappingLedger = { expected: 0, mapped: 0 }
  const sourceAnnotationRanges: Array<{ start: number; end: number }> = []
  const removedStandaloneDiscretionaryHyphens = new Set(
    lineBoundaryDecisions.flatMap((decision) =>
      decision.outcome === 'removed-discretionary-hyphen'
        ? [`${decision.regionId}:${decision.fromLineId}`]
        : [],
    ),
  )
  const store = (run: CanonicalInlineRun) => {
    const rangeKey = `${run.start}:${run.end}`
    const key = run.annotationId
      ? `${rangeKey}:annotation:${run.annotationId}`
      : rangeKey
    mapped.set(key, {
      ...(run.annotationId ? mapped.get(rangeKey) : undefined),
      ...mapped.get(key),
      ...run,
    })
  }
  for (const segment of inlineSourceSegments(block)) {
    const exactRangesByRun = new Map(
      exactSourceRunRanges(segment.region, lineBoundaryDecisions).map(
        (sourceRun) => [sourceRun.run, sourceRun] as const,
      ),
    )
    for (const line of segment.region.lines) {
      for (const [runIndex, run] of line.runs.entries()) {
        const style = supportedSourceInlineStyle({
          regionId: segment.region.id,
          line,
          run,
          runIndex,
          removedStandaloneDiscretionaryHyphens,
        })
        if (!style) continue
        const {
          sourceText,
          bold,
          italic,
          verticalAlign,
          compactMathSpans,
          expectedStyleCount,
        } = style
        const overlappingLinks = links.filter(
          (candidate) =>
            candidate.box !== null && boxesOverlap(candidate.box, run),
        )
        // Literal URLs are mapped only after the complete canonical block has
        // been assembled, so a line-wrapped URL cannot become a partial link.
        const rawLiteralLinks: Array<{
          start: number
          end: number
          url: string
        }> = []
        const exactRange = exactRangesByRun.get(run)
        if (!exactRange) {
          ledger.expected += expectedStyleCount + rawLiteralLinks.length
          continue
        }
        const { sourceStart, sourceEnd } = exactRange
        const canonicalRange = canonicalRangeForSource(
          block,
          segment.region.id,
          sourceStart,
          sourceEnd,
        )
        if (!canonicalRange) continue
        if (
          overlappingLinks.length > 0 ||
          links.some(
            (candidate) =>
              candidate.page === run.page && candidate.box === null,
          )
        ) {
          sourceAnnotationRanges.push(canonicalRange)
        }
        const intersectionStart =
          segment.sourceStart + canonicalRange.start - segment.canonicalStart
        const canonicalText = segment.region.text.slice(
          intersectionStart,
          intersectionStart + canonicalRange.end - canonicalRange.start,
        )
        const hyperlinkSpans = rawLiteralLinks
          .map((link) => ({
            start: sourceStart + link.start,
            end: sourceStart + link.end,
            url: link.url,
          }))
          .flatMap((link) => {
            const start = Math.max(link.start, intersectionStart)
            const end = Math.min(
              link.end,
              intersectionStart + canonicalText.length,
            )
            return start < end
              ? [
                  {
                    start: start - intersectionStart,
                    end: end - intersectionStart,
                    url: link.url,
                  },
                ]
              : []
          })
        ledger.expected += expectedStyleCount + hyperlinkSpans.length
        if (
          bold ||
          italic ||
          hyperlinkSpans.length > 0 ||
          verticalAlign ||
          compactMathSpans.length > 0
        ) {
          const boundaries = [
            0,
            canonicalText.length,
            ...hyperlinkSpans.flatMap((link) => [link.start, link.end]),
            ...compactMathSpans.flatMap((span) => [span.start, span.end]),
          ]
          const points = [...new Set(boundaries)].sort(
            (left, right) => left - right,
          )
          for (let index = 0; index < points.length - 1; index += 1) {
            const segmentStart = points[index]
            const segmentEnd = points[index + 1]
            if (segmentStart === segmentEnd) continue
            const hyperlink = hyperlinkSpans.find(
              (candidate) =>
                candidate.start <= segmentStart && candidate.end >= segmentEnd,
            )
            const compactMathAtom = compactMathSpans.some(
              (candidate) =>
                candidate.start <= segmentStart && candidate.end >= segmentEnd,
            )
            store({
              start: canonicalRange.start + segmentStart,
              end: canonicalRange.start + segmentEnd,
              ...(bold ? { bold: true } : {}),
              ...(italic ? { italic: true } : {}),
              ...(hyperlink ? { href: hyperlink.url } : {}),
              ...(verticalAlign ? { verticalAlign } : {}),
              ...(compactMathAtom ? { compactMathAtom: true } : {}),
            })
          }
          ledger.mapped += expectedStyleCount + hyperlinkSpans.length
        }
      }
    }
  }
  const explicitHyperlinkRanges = canonicalHyperlinks.filter(
    (candidate) => candidate.blockNodeId === block.nodeId,
  )
  const literalLinks = literalAbsoluteHyperlinks(block.text).filter(
    (link) =>
      !sourceAnnotationRanges.some(
        (range) => link.start < range.end && link.end > range.start,
      ) &&
      !explicitHyperlinkRanges.some(
        (range) => link.start < range.end && link.end > range.start,
      ),
  )
  ledger.expected += literalLinks.length
  ledger.mapped += literalLinks.length
  for (const link of literalLinks) {
    store({ start: link.start, end: link.end, href: link.url })
  }
  for (const hyperlink of canonicalHyperlinks.filter(
    (candidate) => candidate.blockNodeId === block.nodeId,
  )) {
    ledger.expected += 1
    ledger.mapped += 1
    store({
      start: hyperlink.start,
      end: hyperlink.end,
      href: hyperlink.href,
      annotationId: hyperlink.annotationId,
    })
  }
  for (const reference of noteReferences) {
    const range =
      reference.canonicalRange ??
      canonicalRangeForSource(
        block,
        reference.regionId,
        reference.start,
        reference.end,
      )
    if (!range) continue
    store({ ...range, relationshipId: reference.id })
  }
  for (const reference of semanticReferences) {
    const range = canonicalRangeForSource(
      block,
      reference.regionId,
      reference.start,
      reference.end,
    )
    if (!range) continue
    store({
      ...range,
      relationshipId: reference.id,
      semanticRole: reference.semanticRole,
      ...(reference.targetIds ? { targetIds: reference.targetIds } : {}),
    })
  }
  const hydratedRuns = [...mapped.entries()]
    .map(([key, run]) => {
      if (!run.annotationId) return run
      const rangeKey = key.slice(0, key.indexOf(':annotation:'))
      return { ...mapped.get(rangeKey), ...run }
    })
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const orderedRuns = hydratedRuns.filter((run, index) => {
    if (!run.annotationId) {
      return !hydratedRuns.some(
        (candidate) =>
          candidate.annotationId &&
          candidate.start === run.start &&
          candidate.end === run.end,
      )
    }
    return !(
      run.href &&
      hydratedRuns
        .slice(0, index)
        .some(
          (candidate) =>
            candidate.annotationId &&
            candidate.start === run.start &&
            candidate.end === run.end &&
            candidate.href === run.href,
        )
    )
  })
  const coalescedRuns: CanonicalInlineRun[] = []
  for (const run of orderedRuns) {
    const previous = coalescedRuns.at(-1)
    const sameStyle =
      previous &&
      previous.end === run.start &&
      previous.bold === run.bold &&
      previous.italic === run.italic &&
      previous.verticalAlign === run.verticalAlign &&
      previous.compactMathAtom === run.compactMathAtom &&
      Boolean(
        run.bold || run.italic || run.verticalAlign || run.compactMathAtom,
      ) &&
      !previous.href &&
      !run.href &&
      !previous.annotationId &&
      !run.annotationId &&
      !previous.relationshipId &&
      !run.relationshipId &&
      !previous.semanticRole &&
      !run.semanticRole &&
      !previous.targetIds &&
      !run.targetIds
    if (sameStyle) {
      previous.end = run.end
    } else {
      coalescedRuns.push({ ...run })
    }
  }
  return {
    runs: coalescedRuns,
    ledger,
  }
}

export function sourceEvidence(
  block: PdfInlineSourceBlock,
  links: PdfLinkAnnotation[],
): NodeSourceEvidence {
  const sourceRegions = inlineSourceSegments(block).map(
    (segment) => segment.evidenceRegion ?? segment.region,
  )
  return {
    confidence: roundedSourceEvidenceCoordinate(block.confidence),
    pages: [...new Set(sourceRegions.map((region) => region.page))],
    regionIds: [...new Set(sourceRegions.map((region) => region.id))],
    boxes: sourceRegions.flatMap((region) =>
      region.lines.flatMap((line) =>
        line.runs.map((run) => ({
          ...run,
          x: roundedSourceEvidenceCoordinate(run.x),
          y: roundedSourceEvidenceCoordinate(run.y),
          width: roundedSourceEvidenceCoordinate(run.width),
          height: roundedSourceEvidenceCoordinate(run.height),
          fontSize: roundedSourceEvidenceCoordinate(run.fontSize),
          confidence: roundedSourceEvidenceCoordinate(run.confidence),
        })),
      ),
    ),
    links: links.filter(
      (link) =>
        link.box !== null &&
        sourceRegions.some(
          (region) =>
            link.box !== null &&
            link.box.page === region.page &&
            boxesOverlap(link.box, region.box),
        ),
    ),
  }
}
