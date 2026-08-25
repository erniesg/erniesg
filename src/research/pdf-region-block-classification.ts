import type {
  PdfImportProgress,
  PdfLineBoundaryDecision,
  PdfPageRegion,
} from './import-types'
import { authorNamesFromLine } from './pdf-front-matter-classification'
import {
  parsedBulletListMarker,
  parsedOrderedListMarker,
  sourceMarkupShape,
  type PdfListRegionBlock,
} from './pdf-list-markers'
import {
  inlineHardHyphenLexicon,
  inlineUnhyphenatedLexicon,
  replayPdfRegionLineRanges,
} from './pdf-lines'
import { splitPdfCompoundAffiliationNote } from './pdf-note-classifier'
import {
  emphasizedLineShare,
  fontNameIndicatesEmphasizedFace,
  residualPdfRegionFragmentsAfterLineConsumption,
  sourceStyledOrdinalSmallCapsHeading,
  sourceStyledStandaloneBoundaryHeading,
  splitLeadingStyledHeadingRegion,
  type PdfResidualRegionFragment,
} from './pdf-region-fragments'
import {
  PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE,
  boxForRegionLines,
  mapPdfReconstructionInBatches,
  median,
  yieldPdfReconstructionTask,
} from './pdf-region-block-recovery'
import { normalizedNoteLabel, noteLabelFromText } from './pdf-regions'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import {
  headingLevel,
  structuralOrdinalHeadingText,
} from './pdf-structural-headings'

function sourceLineEndsSentenceBeforeRaisedNoteMarker(
  line: PdfPageRegion['lines'][number],
) {
  if (/[.!?](?:["'’”)\]]*)$/u.test(line.text.trimEnd())) return true
  const runs = line.runs
    .filter((run) => run.text.trim())
    .sort((left, right) => left.x - right.x)
  const marker = runs.at(-1)
  const prose = runs.at(-2)
  if (
    !marker ||
    !prose ||
    !/^(?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*†‡§]+)$/u.test(marker.text.trim()) ||
    marker.fontSize > prose.fontSize * 0.85
  ) {
    return false
  }
  const markerCenter = marker.y + marker.height / 2
  const proseCenter = prose.y + prose.height / 2
  return (
    markerCenter <
      proseCenter -
        Math.max(0.0005, Math.min(marker.height, prose.height) * 0.08) &&
    /[.!?](?:["'’”)\]]*)$/u.test(prose.text.trimEnd())
  )
}

export function splitListItemTailParagraphs(
  blocks: PdfListRegionBlock[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  // Split from the end so inserting two fragments cannot invalidate the
  // source indexes of later candidates captured from the original block list.
  for (const [blockIndex, block] of [...blocks.entries()].reverse()) {
    if (
      block.type !== 'paragraph' ||
      block.sourceSegments ||
      block.region.lines.length < 2
    ) {
      continue
    }
    const firstLine = block.region.lines[0]
    const marker =
      parsedOrderedListMarker(firstLine.text) ??
      parsedBulletListMarker(firstLine.text)
    if (!marker) continue
    const firstRuns = firstLine.runs
      .filter((run) => run.text.trim())
      .sort((left, right) => left.x - right.x)
    const markerRunIndex = firstRuns.findIndex(
      (run) => run.text.trim() === marker.markerText,
    )
    const firstContentRun =
      markerRunIndex >= 0 ? firstRuns[markerRunIndex + 1] : undefined
    if (!firstContentRun) continue

    const splitIndex = block.region.lines.findIndex(
      (line, lineIndex, lines) => {
        if (lineIndex === 0) return false
        const previous = lines[lineIndex - 1]
        const verticalGap = line.box.y - (previous.box.y + previous.box.height)
        const paragraphGap = Math.max(
          0.005,
          Math.min(line.box.height, previous.box.height) * 0.4,
        )
        return (
          verticalGap >= paragraphGap &&
          line.box.x <= firstContentRun.x - 0.01 &&
          sourceLineEndsSentenceBeforeRaisedNoteMarker(previous) &&
          /^(?:["'‘“(]\s*)?\p{Lu}/u.test(line.text.trimStart())
        )
      },
    )
    if (splitIndex <= 0) continue

    const replay = replayPdfRegionLineRanges(
      block.region,
      lineBoundaryDecisions,
    )
    const itemLines = block.region.lines.slice(0, splitIndex)
    const tailLines = block.region.lines.slice(splitIndex)
    const itemStart = replay?.ranges.get(itemLines[0].id)
    const itemEnd = replay?.ranges.get(itemLines.at(-1)!.id)
    const tailStart = replay?.ranges.get(tailLines[0].id)
    const tailEnd = replay?.ranges.get(tailLines.at(-1)!.id)
    if (
      !replay ||
      replay.text !== block.text ||
      !itemStart ||
      !itemEnd ||
      !tailStart ||
      !tailEnd
    ) {
      continue
    }
    const sourceRegion = block.region
    const fragment = (
      lines: PdfPageRegion['lines'],
      start: number,
      end: number,
    ): PdfListRegionBlock => {
      const text = block.text.slice(start, end)
      const evidenceRegion: PdfPageRegion = {
        ...sourceRegion,
        box: boxForRegionLines(lines),
        lines,
        text,
      }
      return {
        ...block,
        region: evidenceRegion,
        text,
        sourceSegments: [
          {
            region: sourceRegion,
            evidenceRegion,
            sourceStart: start,
            canonicalStart: 0,
            text,
          },
        ],
      }
    }
    blocks.splice(
      blockIndex,
      1,
      fragment(itemLines, itemStart.start, itemEnd.end),
      fragment(tailLines, tailStart.start, tailEnd.end),
    )
  }
}

function noteText(region: PdfPageRegion, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const independentlyRunBackedMarker =
    normalizedNoteLabel(
      region.lines[0]?.runs.find((run) => run.text.trim())?.text ?? '',
    ) === label
  if (
    independentlyRunBackedMarker &&
    normalizedNoteLabel(region.text).startsWith(label)
  ) {
    return normalizedNoteLabel(region.text).slice(label.length).trim()
  }
  return (
    normalizedNoteLabel(region.text)
      .replace(
        new RegExp(
          `^(?:(?:footnote|note)\\s+)?${escaped}(?:\\s*[:.)\\]-]|\\s+)\\s*`,
          'i',
        ),
        '',
      )
      .trim() || region.text.trim()
  )
}

function noteMarkerText(region: PdfPageRegion, label: string) {
  const marker = region.text
    .trim()
    .match(
      /^(?:(?:footnote|note)\s+)?(?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*∗†‡§])(?:\s*[:.)\]-])?/iu,
    )?.[0]
    ?.trim()
  return marker && normalizedNoteLabel(marker).includes(label) ? marker : label
}

function exactCanonicalSubtextSourceSegment(
  region: PdfPageRegion,
  canonicalText: string,
) {
  const directStart = region.text.indexOf(canonicalText)
  const leadingWhitespace = region.text.length - region.text.trimStart().length
  const normalizedStart =
    directStart >= 0
      ? directStart
      : normalizedNoteLabel(region.text).indexOf(canonicalText)
  const sourceStart =
    directStart >= 0
      ? directStart
      : normalizedStart >= 0
        ? leadingWhitespace + normalizedStart
        : -1
  if (
    sourceStart < 0 ||
    sourceStart + canonicalText.length > region.text.length
  ) {
    return undefined
  }
  return [
    {
      region,
      sourceStart,
      canonicalStart: 0,
      text: canonicalText,
    },
  ]
}

export async function classifyPdfRegionBlocks(
  orderedRegions: PdfPageRegion[],
  regions: PdfPageRegion[],
  excludedRegionIds = new Set<string>(),
  bibliographyRegionIds: ReadonlySet<string> = new Set<string>(),
  sourceEquationCaptions: ReadonlyMap<string, string> = new Map<
    string,
    string
  >(),
  consumedLineIds: ReadonlySet<string> = new Set<string>(),
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[] = [],
  onProgress?: (progress: PdfImportProgress) => void,
  signal?: AbortSignal,
) {
  const residualFragments = new WeakMap<
    PdfPageRegion,
    PdfResidualRegionFragment
  >()
  const retainedRegions = orderedRegions.flatMap((region) => {
    if (
      excludedRegionIds.has(region.id) ||
      ![
        'body',
        'spanning',
        'caption',
        'equation',
        'footnote',
        'endnote',
      ].includes(region.kind)
    ) {
      return []
    }
    const fragments = residualPdfRegionFragmentsAfterLineConsumption(
      region,
      consumedLineIds,
      lineBoundaryDecisions,
    )
    for (const fragment of fragments) {
      if (
        fragment.sourceStart !== 0 ||
        fragment.sourceEnd !== fragment.sourceRegion.text.length
      ) {
        residualFragments.set(fragment.region, fragment)
      }
    }
    return fragments.map((fragment) => fragment.region)
  })
  const bodySize =
    median(
      regions
        .filter((region) => region.kind === 'body')
        .flatMap((region) => region.lines.map((line) => line.fontSize)),
    ) || 12
  const sourceRegionLines = regions.flatMap((region) => region.lines)
  const hardHyphenLexicon = inlineHardHyphenLexicon(sourceRegionLines)
  const unhyphenatedLexicon = inlineUnhyphenatedLexicon(sourceRegionLines)
  const readingRegions = retainedRegions.flatMap((region) => {
    if (bibliographyRegionIds.has(region.id) || residualFragments.has(region)) {
      return [region]
    }
    const fragments = splitLeadingStyledHeadingRegion(
      region,
      lineBoundaryDecisions,
    )
    if (fragments.length === 1) return [region]
    for (const fragment of fragments) {
      residualFragments.set(fragment.region, fragment)
    }
    return fragments.map((fragment) => fragment.region)
  })
  const explicitSectionHierarchy = readingRegions.some(
    (region) =>
      /^(?:\d+(?:\.\d+){0,3}|[A-Z](?:\.\d+)+)[.)]?\s+\p{Lu}/u.test(
        region.text.trim(),
      ) && region.lines.some((line) => emphasizedLineShare(line) >= 0.6),
  )
  const regionsByPage = new Map<number, PdfPageRegion[]>()
  for (const region of readingRegions) {
    const pageRegions = regionsByPage.get(region.page) ?? []
    pageRegions.push(region)
    regionsByPage.set(region.page, pageRegions)
  }
  const hasAppendixContentsStructure = (pageRegions: PdfPageRegion[]) => {
    const dotLeaderEntries = pageRegions.filter(
      (region) =>
        /(?:\.\s*){3,}\d+\s*$/u.test(region.text.trim()) &&
        /^[A-Z](?:\.\d+(?:\.\d+)*)?\.?\s+\S/u.test(region.text.trim()),
    )
    const rightAlignedPageNumbers = pageRegions.filter(
      (region) => /^\d{1,4}$/u.test(region.text.trim()) && region.box.x >= 0.65,
    )
    const entriesWithTrailingPageNumbers = pageRegions.filter((region) => {
      const trimmed = region.text.trim()
      if (!/^[A-Z](?:\.\d+(?:\.\d+)*)?\.?\s+\S/u.test(trimmed)) {
        return false
      }
      if (/\s\d{1,4}\s*$/u.test(trimmed)) return true
      return rightAlignedPageNumbers.some(
        (pageNumber) =>
          Math.abs(pageNumber.box.y - region.box.y) <= 0.006 &&
          pageNumber.box.x >= region.box.x + region.box.width + 0.02,
      )
    })
    return (
      dotLeaderEntries.length >= 2 || entriesWithTrailingPageNumbers.length >= 2
    )
  }
  const appendixContentsPages = new Set<number>()
  for (const marker of readingRegions.filter((region) =>
    /^appendix(?: contents)?$/iu.test(region.text.trim()),
  )) {
    for (let page = marker.page; regionsByPage.has(page); page += 1) {
      const pageRegions = regionsByPage.get(page)!
      const explicitContentsLabel =
        page === marker.page && /^appendix contents$/iu.test(marker.text.trim())
      if (
        !explicitContentsLabel &&
        !hasAppendixContentsStructure(pageRegions)
      ) {
        break
      }
      appendixContentsPages.add(page)
    }
  }
  const numberedCandidates = readingRegions.flatMap((region, index) => {
    const trimmed = region.text.trim()
    const match = trimmed.match(/^(\d+(?:\.\d+){0,3})[.)]?\s+(\S.*)$/u)
    const largestFont = Math.max(
      ...region.lines.map((line) => line.fontSize),
      bodySize,
    )
    const emphasizedShare = Math.max(
      ...region.lines.map((line) => emphasizedLineShare(line)),
      0,
    )
    const styledAsHeading =
      largestFont >= bodySize * 1.12 || emphasizedShare >= 0.6
    const partiallyStyledRunInLabel =
      largestFont < bodySize * 1.12 &&
      emphasizedShare >= 0.3 &&
      emphasizedShare < 0.98 &&
      /^\d+[.)]\s+.+:\s+(?:This|These|The|A|An|We|Our|It)$/u.test(trimmed)
    if (
      !match ||
      partiallyStyledRunInLabel ||
      /^(?:(?:https?:\/\/|www\.)|\S*[_@]\S*)/iu.test(match[2]) ||
      (/^\d+[.)]\s/u.test(trimmed) && !styledAsHeading) ||
      region.lines.length > 2 ||
      trimmed.length > 180 ||
      /[.!?](?:["'’”)\]]*)$/u.test(trimmed)
    ) {
      return []
    }
    return [
      {
        index,
        regionId: region.id,
        ordinal: match[1].split('.').map(Number),
        styledAsHeading,
      },
    ]
  })
  const sequencedNumberedHeadingRegions = new Set<PdfPageRegion>()
  const followsInSequence = (left: number[], right: number[]) =>
    left.length === right.length &&
    left.slice(0, -1).every((part, index) => part === right[index]) &&
    right.at(-1) === (left.at(-1) ?? 0) + 1
  const isDirectChild = (parent: number[], child: number[]) =>
    child.length === parent.length + 1 &&
    parent.every((part, index) => child[index] === part)
  const advancesToNextRoot = (left: number[], right: number[]) =>
    left.length > 1 && right.length === 1 && right[0] === (left[0] ?? 0) + 1
  for (let index = 0; index < numberedCandidates.length - 1; index += 1) {
    const current = numberedCandidates[index]
    const next = numberedCandidates[index + 1]
    if (
      next.index > current.index + 1 &&
      followsInSequence(current.ordinal, next.ordinal)
    ) {
      sequencedNumberedHeadingRegions.add(readingRegions[current.index])
      sequencedNumberedHeadingRegions.add(readingRegions[next.index])
    } else if (
      next.index > current.index + 1 &&
      current.styledAsHeading &&
      isDirectChild(current.ordinal, next.ordinal)
    ) {
      sequencedNumberedHeadingRegions.add(readingRegions[current.index])
      sequencedNumberedHeadingRegions.add(readingRegions[next.index])
    }
  }
  const letteredCandidates = readingRegions.flatMap((region, index) => {
    const trimmed = region.text.trim()
    const match = trimmed.match(
      /^([A-Z])(?:\.(\d+(?:\.\d+){0,2}))?\.?\s+\p{Lu}/u,
    )
    const styledAsHeading =
      Math.max(...region.lines.map((line) => line.fontSize), bodySize) >=
        bodySize * 1.12 ||
      sourceStyledOrdinalSmallCapsHeading(region.lines[0]) ||
      region.lines.some((line) => emphasizedLineShare(line) >= 0.6)
    if (
      !match ||
      !styledAsHeading ||
      region.lines.length > 2 ||
      trimmed.length > 180 ||
      /[.!?](?:["'’”)\]]*)$/u.test(trimmed)
    ) {
      return []
    }
    return [
      {
        index,
        ordinal: [
          match[1].charCodeAt(0) - 'A'.charCodeAt(0) + 1,
          ...(match[2]?.split('.').map(Number) ?? []),
        ],
      },
    ]
  })
  const sequencedLetteredHeadingRegions = new Set<PdfPageRegion>()
  for (let index = 0; index < letteredCandidates.length; index += 1) {
    if (index > 0 && index % PDF_RECONSTRUCTION_COOPERATIVE_BATCH_SIZE === 0) {
      await yieldPdfReconstructionTask()
    }
    const current = letteredCandidates[index]
    const next = letteredCandidates
      .slice(index + 1)
      .find(
        (candidate) =>
          followsInSequence(current.ordinal, candidate.ordinal) ||
          isDirectChild(current.ordinal, candidate.ordinal) ||
          advancesToNextRoot(current.ordinal, candidate.ordinal),
      )
    if (!next) continue
    if (
      followsInSequence(current.ordinal, next.ordinal) ||
      advancesToNextRoot(current.ordinal, next.ordinal)
    ) {
      sequencedLetteredHeadingRegions.add(readingRegions[current.index])
      sequencedLetteredHeadingRegions.add(readingRegions[next.index])
    } else if (isDirectChild(current.ordinal, next.ordinal)) {
      sequencedLetteredHeadingRegions.add(readingRegions[current.index])
      sequencedLetteredHeadingRegions.add(readingRegions[next.index])
    }
  }
  const compoundAffiliationSourceSegments = new WeakMap<
    PdfPageRegion,
    NonNullable<PdfListRegionBlock['sourceSegments']>[number]
  >()
  const expandedReadingRegions = readingRegions.flatMap((region) => {
    if (bibliographyRegionIds.has(region.id) || residualFragments.has(region)) {
      return [region]
    }
    const compound = splitPdfCompoundAffiliationNote(
      region,
      lineBoundaryDecisions,
    )
    if (!compound) return [region]
    return [
      ...compound.affiliations,
      ...(compound.correspondence ? [compound.correspondence] : []),
    ].map((segment) => {
      const selectedLines = segment.sourceLineIds.length
        ? region.lines.filter((line) => segment.sourceLineIds.includes(line.id))
        : region.lines
      const text =
        segment.label === 'Correspondence'
          ? `Correspondence to: ${segment.text}`
          : `${segment.markerText} ${segment.text}`
      const derivedRegion: PdfPageRegion = {
        ...region,
        text,
        lines: selectedLines,
        ...(selectedLines.length > 0
          ? { box: boxForRegionLines(selectedLines) }
          : {}),
      }
      const sourceWindow = region.text.slice(
        segment.sourceStart,
        segment.sourceEnd,
      )
      const relativeCanonicalStart = sourceWindow.indexOf(segment.text)
      if (relativeCanonicalStart >= 0) {
        compoundAffiliationSourceSegments.set(derivedRegion, {
          region,
          evidenceRegion: derivedRegion,
          sourceStart: segment.sourceStart + relativeCanonicalStart,
          canonicalStart: 0,
          text: segment.text,
        })
      }
      return derivedRegion
    })
  })
  const initialBlocks = await mapPdfReconstructionInBatches<
    PdfPageRegion,
    PdfListRegionBlock
  >(
    expandedReadingRegions,
    (region, regionIndex) => {
      const residualFragment = residualFragments.get(region)
      const sourceSegments = residualFragment
        ? [
            {
              region: residualFragment.sourceRegion,
              evidenceRegion: region,
              sourceStart: residualFragment.sourceStart,
              canonicalStart: 0,
              text: region.text,
            },
          ]
        : undefined
      if (region.kind === 'caption') {
        return {
          type: 'caption',
          region,
          text: region.text,
          confidence: region.confidence,
          ...(sourceSegments ? { sourceSegments } : {}),
        }
      }
      if (region.kind === 'equation' && sourceEquationCaptions.has(region.id)) {
        return {
          type: 'caption',
          region,
          text: sourceEquationCaptions.get(region.id)!,
          confidence: region.confidence,
          suppressSourceInlineRuns: true,
        }
      }
      if (
        (region.kind === 'footnote' || region.kind === 'endnote') &&
        !bibliographyRegionIds.has(region.id)
      ) {
        const correspondence = region.text.match(
          /^Correspondence\s+to\s*:\s*(.+)$/iu,
        )
        const label = correspondence
          ? 'Correspondence'
          : (noteLabelFromText(region.text) ?? '?')
        const text = correspondence?.[1]?.trim() ?? noteText(region, label)
        const compoundSourceSegment =
          compoundAffiliationSourceSegments.get(region)
        const sourceSegments =
          compoundSourceSegment?.text === text
            ? [compoundSourceSegment]
            : exactCanonicalSubtextSourceSegment(region, text)
        return {
          type: 'footnote',
          region,
          text,
          confidence: region.confidence,
          noteKind: region.kind,
          noteLabel: label,
          noteMarkerText: correspondence
            ? 'Correspondence'
            : noteMarkerText(region, label),
          ...(sourceSegments ? { sourceSegments } : {}),
        }
      }
      const largestFont = Math.max(
        ...region.lines.map((line) => line.fontSize),
        bodySize,
      )
      const styledRuns = region.lines.flatMap((line) =>
        line.runs.filter((run) => run.text.trim()),
      )
      const emphasizedCharacters = styledRuns.reduce(
        (total, run) =>
          total +
          (run.bold || fontNameIndicatesEmphasizedFace(run.fontName)
            ? run.text.trim().length
            : 0),
        0,
      )
      const visibleCharacters = styledRuns.reduce(
        (total, run) => total + run.text.trim().length,
        0,
      )
      const representativeFontSize = (() => {
        const weightedSizes = styledRuns
          .map((run) => ({
            size: run.fontSize,
            weight: run.text.replace(/\s/gu, '').length,
          }))
          .filter(({ size, weight }) => size > 0 && weight > 0)
          .sort((left, right) => left.size - right.size)
        const midpoint =
          weightedSizes.reduce((total, run) => total + run.weight, 0) / 2
        let cumulative = 0
        for (const run of weightedSizes) {
          cumulative += run.weight
          if (cumulative >= midpoint) return run.size
        }
        return largestFont
      })()
      const sourceStyledLetteredHeading =
        region.lines.length === 1 &&
        sourceStyledOrdinalSmallCapsHeading(region.lines[0])
      const sourceStyledNamedBoundaryHeading =
        sourceStyledStandaloneBoundaryHeading(region, readingRegions)
      const appendixContentsEntry =
        appendixContentsPages.has(region.page) &&
        /^[A-Z](?:\.\d+(?:\.\d+)*)?\.?\s+\S/u.test(region.text.trim())
      const alignedTabularHeaderPeers = readingRegions.filter(
        (peer) =>
          peer !== region &&
          peer.page === region.page &&
          ['body', 'spanning'].includes(peer.kind) &&
          Math.abs(peer.box.y - region.box.y) <= 0.004,
      )
      const alignedTabularHeaderPeerCount = alignedTabularHeaderPeers.length
      const alignedExcludedTableLabelPeerCount = regions.filter(
        (peer) =>
          peer.page === region.page &&
          peer.kind === 'chart-label' &&
          Math.abs(peer.box.y - region.box.y) <= 0.004,
      ).length
      const nearbyTableCaption = readingRegions.some((peer) => {
        const label = parsePdfScholarlyVisualLabel(peer.text, {
          context: 'caption',
        })
        return (
          peer.page === region.page &&
          (peer.column === region.column ||
            peer.column === 'span' ||
            region.column === 'span' ||
            (peer.column === 'single' && region.column === 'single')) &&
          peer.box.y <= region.box.y &&
          region.box.y - (peer.box.y + peer.box.height) <= 0.12 &&
          label?.kind === 'table'
        )
      })
      const allAlignedPeersAreStructural =
        structuralOrdinalHeadingText(region.text) &&
        alignedTabularHeaderPeers.every((peer) =>
          structuralOrdinalHeadingText(peer.text),
        )
      const probableTabularColumnHeader =
        alignedExcludedTableLabelPeerCount >= 2 ||
        (!allAlignedPeersAreStructural &&
          (alignedTabularHeaderPeerCount >= 2 ||
            (nearbyTableCaption && alignedTabularHeaderPeerCount >= 1)))
      const compactEquationSyntax = (() => {
        if (region.kind !== 'equation' || !/[=+−×÷∫∑√≤≥≈]/u.test(region.text)) {
          return false
        }
        const words = region.text.match(/\p{L}+/gu) ?? []
        return (
          words.length <= 6 &&
          words.filter((word) => word.length > 2).length <= 1
        )
      })()
      const emphasizedNumberedHeading =
        emphasizedCharacters >= Math.max(1, visibleCharacters * 0.6) &&
        /^\d+(?:\.\d+){0,3}[.)]?\s+\p{Lu}/u.test(region.text.trim()) &&
        (!/^\d+[.)]\s/u.test(region.text.trim()) ||
          largestFont >= bodySize * 1.12)
      const emphasizedLetteredHeading =
        emphasizedCharacters >= Math.max(1, visibleCharacters * 0.6) &&
        /^(?:[A-Z]\.\s+|[A-Z](?:\.\d+)+\.?\s+)\p{Lu}/u.test(region.text.trim())
      const namedSectionPrefix =
        /^(?:abstract|introduction|methods?|results?|discussion|conclusion|references|acknowledg(?:e)?ments?|ethics statement|impact statement|broader impacts?|limitations?|endnotes?|notes?)\b/i.test(
          region.text,
        )
      const namedSectionHeading =
        namedSectionPrefix &&
        (/^(?:abstract|introduction|methods?|results?|discussion|conclusion|references|acknowledg(?:e)?ments?|ethics statement|impact statement|broader impacts?|limitations?|endnotes?|notes?)$/i.test(
          region.text.trim(),
        ) ||
          emphasizedCharacters >= Math.max(1, visibleCharacters * 0.6))
      const numberedSectionHeading =
        /^\d+(?:\.\d+){0,3}[.)]?\s+(?:abstract|introduction|background|related work|literature review|methods?|methodology|approach|framework|experiments?|evaluation|results?|discussion|limitations?|conclusion|references|appendix)\b/i.test(
          region.text.trim(),
        )
      const sourceStyledWrappedStructuralHeading =
        region.lines.length <= 3 &&
        region.lines.every((line) => emphasizedLineShare(line) >= 0.6) &&
        /^(?:\d+(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?\s+\p{Lu}/u.test(
          region.text.trim(),
        )
      const headingBoundaryEvidence =
        (region.lines.length <= 2 || sourceStyledWrappedStructuralHeading) &&
        region.text.trim().length <= 180 &&
        (sourceStyledLetteredHeading ||
          !/[.](?:["'’”)]*)$/.test(region.text.trim()) ||
          emphasizedNumberedHeading ||
          emphasizedLetteredHeading)
      const probableFirstPageAuthorLine =
        region.page === 1 &&
        regionIndex > 0 &&
        region.box.y < 0.28 &&
        !/[.!?](?:\s|$)/.test(region.text) &&
        authorNamesFromLine(region.text).length > 0
      const fontOnlyHeading =
        region.text.trim().length > 1 &&
        representativeFontSize >= bodySize * 1.18 &&
        (/^\p{Lu}/u.test(region.text.trim()) ||
          /^\d+(?:\.\d+){1,3}\s+\p{Lu}/u.test(region.text.trim()) ||
          compactEquationSyntax) &&
        !/[,;]/u.test(region.text) &&
        (!explicitSectionHierarchy ||
          /^\d+(?:\.\d+){0,3}[.)]?\s+\p{Lu}/u.test(region.text.trim()) ||
          /^[A-Z](?:\.\d+)+\.?\s+\p{Lu}/u.test(region.text.trim()) ||
          sequencedLetteredHeadingRegions.has(region) ||
          namedSectionPrefix)
      const markup = sourceMarkupShape(region.text)
      const sourceMarkupHasIndependentEvidence =
        !Object.values(markup).some(Boolean) ||
        representativeFontSize >= bodySize * 1.12 ||
        emphasizedCharacters >= Math.max(1, visibleCharacters * 0.6) ||
        sourceStyledLetteredHeading ||
        sourceStyledNamedBoundaryHeading ||
        sequencedNumberedHeadingRegions.has(region) ||
        sequencedLetteredHeadingRegions.has(region)
      const heading =
        !probableFirstPageAuthorLine &&
        !appendixContentsEntry &&
        !probableTabularColumnHeader &&
        sourceMarkupHasIndependentEvidence &&
        headingBoundaryEvidence &&
        (namedSectionHeading ||
          numberedSectionHeading ||
          emphasizedNumberedHeading ||
          emphasizedLetteredHeading ||
          sourceStyledLetteredHeading ||
          sourceStyledNamedBoundaryHeading ||
          sequencedNumberedHeadingRegions.has(region) ||
          sequencedLetteredHeadingRegions.has(region) ||
          fontOnlyHeading)
      return {
        type: heading ? 'heading' : 'paragraph',
        region,
        text: region.text,
        confidence: Math.min(region.confidence, heading ? 0.9 : 0.86),
        ...(sourceSegments ? { sourceSegments } : {}),
        ...(heading
          ? {
              headingLevel: sourceStyledNamedBoundaryHeading
                ? (1 as const)
                : headingLevel(region.text, largestFont, bodySize),
            }
          : {}),
      }
    },
    (completed, total) =>
      onProgress?.({
        phase: 'reading-order',
        completed,
        total,
        message: `Reconstructing logical prose and legal float boundaries across ${completed} of ${total} regions…`,
      }),
    signal,
  )
  return {
    initialBlocks,
    bodySize,
    hardHyphenLexicon,
    unhyphenatedLexicon,
  }
}
