import type {
  NormalizedSourceBox,
  PdfLineBoundaryDecision,
  PdfPageRegion,
} from './import-types'
import {
  authorNamesFromBlock,
  largestBlockFont,
  likelyAffiliation,
  numberedAffiliationsFromBlock,
} from './pdf-front-matter-classification'
import { replayPdfRegionLineRanges } from './pdf-lines'

type PdfFrontMatterSplitBlock = {
  type: 'heading' | 'paragraph' | 'caption' | 'footnote'
  region: PdfPageRegion
  text: string
  confidence: number
  noteKind?: 'footnote' | 'endnote'
  noteLabel?: string
  noteMarkerText?: string
  sourceSegments?: Array<{
    region: PdfPageRegion
    evidenceRegion?: PdfPageRegion
    sourceStart: number
    canonicalStart: number
    text: string
  }>
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function boxForRegionLines(lines: PdfPageRegion['lines']): NormalizedSourceBox {
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

export function splitLeadingFrontMatterAffiliationFromProse(
  blocks: PdfFrontMatterSplitBlock[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  for (const [blockIndex, block] of [...blocks].entries()) {
    if (
      block.region.page !== 1 ||
      block.type !== 'paragraph' ||
      block.sourceSegments ||
      block.region.lines.length < 3 ||
      block.region.box.y >= 0.45 ||
      !blocks
        .slice(0, blockIndex)
        .some(
          (candidate) =>
            candidate.region.page === 1 &&
            (authorNamesFromBlock(candidate).length > 0 ||
              largestBlockFont(candidate) >= 14),
        )
    ) {
      continue
    }
    const replay = replayPdfRegionLineRanges(
      block.region,
      lineBoundaryDecisions,
    )
    if (!replay || replay.text !== block.text) continue

    let splitIndex = -1
    for (
      let candidateIndex = 1;
      candidateIndex < Math.min(5, block.region.lines.length);
      candidateIndex += 1
    ) {
      const prefixLines = block.region.lines.slice(0, candidateIndex)
      const suffixLines = block.region.lines.slice(candidateIndex)
      const prefixRange = replay.ranges.get(prefixLines[0].id)
      const prefixEndRange = replay.ranges.get(prefixLines.at(-1)!.id)
      const suffixRange = replay.ranges.get(suffixLines[0].id)
      const suffixEndRange = replay.ranges.get(suffixLines.at(-1)!.id)
      if (!prefixRange || !prefixEndRange || !suffixRange || !suffixEndRange) {
        continue
      }
      const prefixText = block.text
        .slice(prefixRange.start, prefixEndRange.end)
        .trim()
      const suffixText = block.text
        .slice(suffixRange.start, suffixEndRange.end)
        .trim()
      const suffixWordCount = suffixText.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
      const suffixSentenceCount =
        suffixText.match(/[.!?](?:\s|$)/gu)?.length ?? 0
      if (
        prefixText.length <= 320 &&
        likelyAffiliation(prefixText) &&
        suffixText.length >= 300 &&
        suffixWordCount >= 40 &&
        suffixSentenceCount >= 2
      ) {
        splitIndex = candidateIndex
        break
      }
    }
    if (splitIndex < 0) continue

    const makeFragment = (
      lines: PdfPageRegion['lines'],
      sourceStart: number,
      sourceEnd: number,
    ): PdfFrontMatterSplitBlock => {
      const text = block.region.text.slice(sourceStart, sourceEnd)
      const evidenceRegion: PdfPageRegion = {
        ...block.region,
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
            region: block.region,
            evidenceRegion,
            sourceStart,
            canonicalStart: 0,
            text,
          },
        ],
      }
    }
    const prefixLines = block.region.lines.slice(0, splitIndex)
    const suffixLines = block.region.lines.slice(splitIndex)
    const prefixStart = replay.ranges.get(prefixLines[0].id)!.start
    const prefixEnd = replay.ranges.get(prefixLines.at(-1)!.id)!.end
    const suffixStart = replay.ranges.get(suffixLines[0].id)!.start
    const suffixEnd = replay.ranges.get(suffixLines.at(-1)!.id)!.end
    blocks.splice(
      blockIndex,
      1,
      makeFragment(prefixLines, prefixStart, prefixEnd),
      makeFragment(suffixLines, suffixStart, suffixEnd),
    )
  }
}

export function splitFrontMatterAffiliationContact(
  blocks: PdfFrontMatterSplitBlock[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  for (const [blockIndex, block] of [...blocks].entries()) {
    if (
      block.region.page !== 1 ||
      block.type !== 'paragraph' ||
      block.sourceSegments ||
      block.region.lines.length < 2 ||
      block.region.box.y >= 0.35
    ) {
      continue
    }
    const contactLineIndex = block.region.lines.findIndex((line) =>
      /@[\p{L}\p{N}.-]+\.\p{L}{2,}/iu.test(line.text),
    )
    if (contactLineIndex <= 0) continue
    const affiliationLines = block.region.lines.slice(0, contactLineIndex)
    const contactLines = block.region.lines.slice(contactLineIndex)
    if (
      contactLines.some(
        (line) => !/@[\p{L}\p{N}.-]+\.\p{L}{2,}/iu.test(line.text),
      )
    ) {
      continue
    }
    const replay = replayPdfRegionLineRanges(
      block.region,
      lineBoundaryDecisions,
    )
    const affiliationStart = replay?.ranges.get(affiliationLines[0].id)
    const affiliationEnd = replay?.ranges.get(affiliationLines.at(-1)!.id)
    const contactStart = replay?.ranges.get(contactLines[0].id)
    const contactEnd = replay?.ranges.get(contactLines.at(-1)!.id)
    if (
      !replay ||
      replay.text !== block.text ||
      !affiliationStart ||
      !affiliationEnd ||
      !contactStart ||
      !contactEnd
    ) {
      continue
    }
    const affiliationText = block.text
      .slice(affiliationStart.start, affiliationEnd.end)
      .trim()
    const contactText = block.text
      .slice(contactStart.start, contactEnd.end)
      .trim()
    if (
      numberedAffiliationsFromBlock({
        ...block,
        region: {
          ...block.region,
          lines: affiliationLines,
          text: affiliationText,
        },
        text: affiliationText,
      }).length === 0 ||
      !contactText
    ) {
      continue
    }
    const sourceRegion = block.region
    const affiliationRegion: PdfPageRegion = {
      ...sourceRegion,
      box: boxForRegionLines(affiliationLines),
      lines: affiliationLines,
      text: affiliationText,
    }
    const contactEvidenceRegion: PdfPageRegion = {
      ...sourceRegion,
      box: boxForRegionLines(contactLines),
      lines: contactLines,
      text: contactText,
    }
    const contactRegion: PdfPageRegion = {
      ...contactEvidenceRegion,
      id: `${sourceRegion.id}-contact`,
      kind: 'footnote',
      text: `Correspondence to: ${contactText}`,
    }
    blocks.splice(
      blockIndex,
      1,
      {
        ...block,
        region: affiliationRegion,
        text: affiliationText,
        sourceSegments: [
          {
            region: sourceRegion,
            evidenceRegion: affiliationRegion,
            sourceStart: affiliationStart.start,
            canonicalStart: 0,
            text: affiliationText,
          },
        ],
      },
      {
        type: 'footnote',
        region: contactRegion,
        text: contactText,
        confidence: block.confidence,
        noteKind: 'footnote',
        noteLabel: 'Correspondence',
        noteMarkerText: 'Correspondence',
        sourceSegments: [
          {
            region: sourceRegion,
            evidenceRegion: contactEvidenceRegion,
            sourceStart: contactStart.start,
            canonicalStart: 0,
            text: contactText,
          },
        ],
      },
    )
  }
}

export function splitEmbeddedPublicationReference(
  blocks: PdfFrontMatterSplitBlock[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  for (const [blockIndex, block] of [...blocks.entries()].reverse()) {
    if (
      block.type !== 'paragraph' ||
      block.sourceSegments ||
      block.region.page !== 1 ||
      block.region.lines.length < 2
    ) {
      continue
    }
    const boundaryIndex = block.region.lines.findIndex(
      (line, index) =>
        index > 0 && /^ACM\s+Reference\s+Format\s*:/iu.test(line.text.trim()),
    )
    if (boundaryIndex < 1) continue
    const leadingLines = block.region.lines.slice(0, boundaryIndex)
    const referenceLines = block.region.lines.slice(boundaryIndex)
    const replay = replayPdfRegionLineRanges(
      block.region,
      lineBoundaryDecisions,
    )
    const leadingStart = replay?.ranges.get(leadingLines[0].id)
    const leadingEnd = replay?.ranges.get(leadingLines.at(-1)!.id)
    const referenceStart = replay?.ranges.get(referenceLines[0].id)
    const referenceEnd = replay?.ranges.get(referenceLines.at(-1)!.id)
    if (
      !replay ||
      replay.text !== block.text ||
      !leadingStart ||
      !leadingEnd ||
      !referenceStart ||
      !referenceEnd
    ) {
      continue
    }
    const sourceRegion = block.region
    const fragment = (
      lines: PdfPageRegion['lines'],
      start: number,
      end: number,
    ): PdfFrontMatterSplitBlock => {
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
      fragment(leadingLines, leadingStart.start, leadingEnd.end),
      fragment(referenceLines, referenceStart.start, referenceEnd.end),
    )
  }
}
