import type {
  NormalizedSourceBox,
  PdfCitationRelationship,
  PdfLineBoundaryDecision,
  PdfNoteMarkerClassification,
  PdfPageRegion,
} from './import-types'
import { authorNamesFromBlock } from './pdf-front-matter-classification'
import {
  MAX_CITATION_TARGETS_PER_RELATIONSHIP,
  parsePdfCitationSurface,
} from './pdf-citation-surface'
import {
  blockSourceSegments,
  type PdfListRegionBlock,
} from './pdf-list-markers'
import {
  pdfAlternateAuthorYearKeyFromBoundary,
  pdfAuthorYearKey,
  pdfBibliographyAuthorYearKey,
  pdfBibliographyFirstAuthorSurname,
} from './pdf-note-classifier'
import { exactSourceRunRanges } from './pdf-source-run-ranges'
import { normalizedNoteLabel } from './pdf-regions'

export type NoteReferenceDraft = {
  id: string
  label: string
  region: PdfPageRegion
  start: number
  end: number
  classification: PdfNoteMarkerClassification
  canonicalAnchor:
    | { kind: 'node'; nodeId: string; start: number; end: number }
    | { kind: 'author'; author: string }
    | null
}

type AuthorNoteReferenceDraft = NoteReferenceDraft & {
  author: string
}

export type SemanticReferenceDraft = {
  id: string
  start: number
  end: number
  semanticRole:
    | 'citation'
    | 'cross-reference'
    | 'affiliation-marker'
    | 'bibliography-entry'
    | 'note-reference'
  targetIds?: string[]
}

export function detectReferences(
  classifications: PdfNoteMarkerClassification[],
  regionMap: ReadonlyMap<string, PdfPageRegion>,
) {
  return classifications.flatMap<NoteReferenceDraft>((classification) => {
    if (classification.disposition !== 'note-reference') return []
    const region = regionMap.get(classification.referenceRegionId)
    if (!region) return []
    return [
      {
        id: classification.id,
        label: classification.label,
        region,
        start: classification.start,
        end: classification.end,
        classification,
        canonicalAnchor: null,
      },
    ]
  })
}

function exactAuthorSpans(block: PdfListRegionBlock) {
  return authorNamesFromBlock(block).flatMap((author) => {
    const occurrences: Array<{ author: string; start: number; end: number }> =
      []
    let cursor = 0
    while (cursor < block.text.length) {
      const start = block.text.indexOf(author, cursor)
      if (start < 0) break
      const end = start + author.length
      const before = block.text.slice(Math.max(0, start - 1), start)
      const after = block.text.slice(end, end + 1)
      if (!/\p{L}/u.test(before) && !/\p{L}/u.test(after)) {
        occurrences.push({ author, start, end })
      }
      cursor = Math.max(end, start + 1)
    }
    return occurrences.length === 1 ? occurrences : []
  })
}

export function detectAuthorNoteReferences(
  blocks: PdfListRegionBlock[],
  classifications: PdfNoteMarkerClassification[],
): AuthorNoteReferenceDraft[] {
  const classificationsByRegion = new Map<
    string,
    PdfNoteMarkerClassification[]
  >()
  for (const classification of classifications) {
    if (
      !classification.accepted ||
      classification.disposition !== 'note-reference'
    ) {
      continue
    }
    const values =
      classificationsByRegion.get(classification.referenceRegionId) ?? []
    values.push(classification)
    classificationsByRegion.set(classification.referenceRegionId, values)
  }
  return blocks.flatMap((block) => {
    if (block.frontMatterRole !== 'author') return []
    const authorSpans = exactAuthorSpans(block).sort(
      (left, right) => left.start - right.start || left.end - right.end,
    )
    return (classificationsByRegion.get(block.region.id) ?? []).flatMap(
      (classification) => {
        const sourceMarker = block.text.slice(
          classification.start,
          classification.end,
        )
        if (
          classification.start < 0 ||
          classification.end > block.text.length ||
          normalizedNoteLabel(sourceMarker) !==
            normalizedNoteLabel(classification.label)
        ) {
          return []
        }
        const preceding = authorSpans.filter(
          (span) => span.end <= classification.start,
        )
        const owner = preceding.at(-1)
        if (!owner) return []
        const ownerFamilyName = owner.author
          .split(/\s+/u)
          .filter(Boolean)
          .at(-1)
        const markerOwnedByAuthorLine = block.region.lines.some((line) => {
          if (
            !ownerFamilyName ||
            !line.text.includes(ownerFamilyName) ||
            line.box.page !== classification.sourceBox.page
          ) {
            return false
          }
          const overlap = Math.max(
            0,
            Math.min(
              line.box.y + line.box.height,
              classification.sourceBox.y + classification.sourceBox.height,
            ) - Math.max(line.box.y, classification.sourceBox.y),
          )
          return overlap > 0
        })
        if (!markerOwnedByAuthorLine) return []
        const markerPrefix = block.text.slice(owner.end, classification.start)
        if (!/^[\s,;–—\-\d⁰¹²³⁴⁵⁶⁷⁸⁹*∗†‡§]*$/u.test(markerPrefix)) {
          return []
        }
        const nextAuthor = authorSpans.find((span) => span.start > owner.start)
        if (nextAuthor && classification.start >= nextAuthor.start) return []
        return [
          {
            id: classification.id,
            label: classification.label,
            author: owner.author,
            region: block.region,
            start: classification.start,
            end: classification.end,
            classification,
            canonicalAnchor: null,
          },
        ]
      },
    )
  })
}

export function detectAuthorAffiliationReferences(
  blocks: PdfListRegionBlock[],
  classifications: PdfNoteMarkerClassification[],
) {
  const classificationsByRegion = new Map<
    string,
    PdfNoteMarkerClassification[]
  >()
  for (const classification of classifications) {
    if (
      !classification.accepted ||
      classification.taxonomy !== 'author-affiliation-superscript'
    ) {
      continue
    }
    const values =
      classificationsByRegion.get(classification.referenceRegionId) ?? []
    values.push(classification)
    classificationsByRegion.set(classification.referenceRegionId, values)
  }
  return blocks.flatMap((block) => {
    if (block.frontMatterRole !== 'author') return []
    const authorSpans = exactAuthorSpans(block).sort(
      (left, right) => left.start - right.start || left.end - right.end,
    )
    return (classificationsByRegion.get(block.region.id) ?? []).flatMap(
      (classification) => {
        const sourceMarker = block.text.slice(
          classification.start,
          classification.end,
        )
        if (
          classification.start < 0 ||
          classification.end > block.text.length ||
          normalizedNoteLabel(sourceMarker) !==
            normalizedNoteLabel(classification.label)
        ) {
          return []
        }
        const owner = authorSpans
          .filter((span) => span.end <= classification.start)
          .at(-1)
        if (!owner) return []
        const ownerFamilyName = owner.author
          .split(/\s+/u)
          .filter(Boolean)
          .at(-1)
        const markerOwnedByAuthorLine = block.region.lines.some((line) => {
          if (
            !ownerFamilyName ||
            !line.text.includes(ownerFamilyName) ||
            line.box.page !== classification.sourceBox.page
          ) {
            return false
          }
          const overlap = Math.max(
            0,
            Math.min(
              line.box.y + line.box.height,
              classification.sourceBox.y + classification.sourceBox.height,
            ) - Math.max(line.box.y, classification.sourceBox.y),
          )
          return overlap > 0
        })
        if (!markerOwnedByAuthorLine) return []
        const markerPrefix = block.text.slice(owner.end, classification.start)
        if (!/^[\s,;–—\-\d⁰¹²³⁴⁵⁶⁷⁸⁹*∗†‡§]*$/u.test(markerPrefix)) {
          return []
        }
        const nextAuthor = authorSpans.find((span) => span.start > owner.start)
        if (nextAuthor && classification.start >= nextAuthor.start) return []
        return [{ author: owner.author, label: classification.label }]
      },
    )
  })
}

export function semanticRoleForClassification(
  classification: PdfNoteMarkerClassification,
): SemanticReferenceDraft['semanticRole'] | undefined {
  if (classification.disposition === 'citation') return 'citation'
  if (
    classification.taxonomy === 'equation-reference' ||
    classification.taxonomy === 'section-reference'
  ) {
    return 'cross-reference'
  }
  if (classification.taxonomy === 'author-affiliation-superscript') {
    return 'affiliation-marker'
  }
  if (classification.taxonomy === 'bibliography-entry') {
    return 'bibliography-entry'
  }
  return undefined
}

export function exactSourceBoxesForCitationRange(
  region: PdfPageRegion,
  start: number,
  end: number,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  if (start < 0 || start >= end || end > region.text.length) return []
  const overlaps = exactSourceRunRanges(region, lineBoundaryDecisions)
    .flatMap((sourceRun) => {
      const overlapStart = Math.max(start, sourceRun.sourceStart)
      const overlapEnd = Math.min(end, sourceRun.sourceEnd)
      const sourceLength = sourceRun.sourceEnd - sourceRun.sourceStart
      if (
        overlapStart >= overlapEnd ||
        sourceLength <= 0 ||
        sourceRun.run.rotation !== 0 ||
        sourceRun.run.width <= 0 ||
        sourceRun.run.height <= 0
      ) {
        return []
      }
      const startRatio = (overlapStart - sourceRun.sourceStart) / sourceLength
      const endRatio = (overlapEnd - sourceRun.sourceStart) / sourceLength
      return [
        {
          sourceStart: overlapStart,
          sourceEnd: overlapEnd,
          box: {
            page: sourceRun.run.page,
            x: sourceRun.run.x + sourceRun.run.width * startRatio,
            y: sourceRun.run.y,
            width: sourceRun.run.width * (endRatio - startRatio),
            height: sourceRun.run.height,
            rotation: sourceRun.run.rotation,
            method: sourceRun.run.method,
          } satisfies NormalizedSourceBox,
        },
      ]
    })
    .sort(
      (left, right) =>
        left.sourceStart - right.sourceStart ||
        left.sourceEnd - right.sourceEnd,
    )
  if (overlaps.length === 0) return []
  let coveredEnd = start
  for (const overlap of overlaps) {
    if (
      overlap.sourceStart > coveredEnd &&
      region.text.slice(coveredEnd, overlap.sourceStart).trim()
    ) {
      return []
    }
    coveredEnd = Math.max(coveredEnd, overlap.sourceEnd)
  }
  if (coveredEnd < end && region.text.slice(coveredEnd, end).trim()) return []
  return [
    ...new Map(
      overlaps.map(({ box }) => [
        `${box.page}:${box.x}:${box.y}:${box.width}:${box.height}:${box.rotation}:${box.method}`,
        box,
      ]),
    ).values(),
  ]
}

function exactCitationTargetProvenance({
  classification,
  labels,
  targetNodeIds,
  regionMap,
  lineBoundaryDecisions,
}: {
  classification: PdfNoteMarkerClassification
  labels: readonly string[]
  targetNodeIds: readonly string[]
  regionMap: ReadonlyMap<string, PdfPageRegion>
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[]
}): NonNullable<PdfCitationRelationship['targets']> {
  if (
    labels.length === 0 ||
    labels.length !== targetNodeIds.length ||
    new Set(labels).size !== labels.length
  ) {
    return []
  }
  const region = regionMap.get(classification.referenceRegionId)
  if (!region) return []
  const sourceText = region.text.slice(classification.start, classification.end)
  if (!sourceText) return []
  const surfaces =
    labels.length === 1
      ? {
          identities: [...labels],
          links: [
            {
              identityIndex: 0,
              start: 0,
              end: sourceText.length,
            },
          ],
        }
      : parsePdfCitationSurface(sourceText)
  if (
    !surfaces ||
    surfaces.identities.length !== labels.length ||
    surfaces.identities.some((identity, index) => identity !== labels[index])
  ) {
    return []
  }
  const targets = surfaces.links.flatMap((surface) => {
    const label = labels[surface.identityIndex]
    const targetNodeId = targetNodeIds[surface.identityIndex]
    const referenceStart = classification.start + surface.start
    const referenceEnd = classification.start + surface.end
    const sourceBoxes = exactSourceBoxesForCitationRange(
      region,
      referenceStart,
      referenceEnd,
      lineBoundaryDecisions,
    )
    return label && targetNodeId && sourceBoxes.length > 0
      ? [
          {
            label,
            targetNodeId,
            referenceStart,
            referenceEnd,
            sourceBoxes,
            evidence: [
              'ordered-citation-label-target-cardinality',
              'exact-replayed-source-run-range',
              'target-specific-source-geometry',
            ],
          },
        ]
      : []
  })
  return targets.length === surfaces.links.length ? targets : []
}

export function buildCitationRelationships(
  classifications: PdfNoteMarkerClassification[],
  blocks: PdfListRegionBlock[],
  regionMap: ReadonlyMap<string, PdfPageRegion>,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const blocksBySourceRegion = new Map<string, PdfListRegionBlock[]>()
  for (const block of blocks) {
    for (const regionId of new Set(
      blockSourceSegments(block).map((segment) => segment.region.id),
    )) {
      const owners = blocksBySourceRegion.get(regionId) ?? []
      owners.push(block)
      blocksBySourceRegion.set(regionId, owners)
    }
  }
  const bibliographyTargets = new Map<string, string[]>()
  for (const classification of classifications.filter(
    (candidate) => candidate.taxonomy === 'bibliography-entry',
  )) {
    const owners =
      blocksBySourceRegion.get(classification.referenceRegionId) ?? []
    const bibliographyOrdinal = /^\d+$/.test(classification.label)
      ? Number(classification.label)
      : null
    const markerOwners = owners.filter(
      (block) =>
        block.list?.numberingId === 'references' &&
        ((bibliographyOrdinal !== null &&
          block.list.ordinal === bibliographyOrdinal) ||
          normalizedNoteLabel(block.list.markerText ?? '') ===
            normalizedNoteLabel(classification.label)),
    )
    const target = (
      markerOwners.length === 1
        ? markerOwners[0]
        : owners.length === 1
          ? owners[0]
          : undefined
    )?.nodeId
    if (!target) continue
    for (const label of classification.label.split(',')) {
      const targets = bibliographyTargets.get(label) ?? []
      if (!targets.includes(target)) targets.push(target)
      bibliographyTargets.set(label, targets)
    }
  }
  const authorYearTargets = new Map<string, string[]>()
  const storeAuthorYearTarget = (key: string, nodeId: string) => {
    const targets = authorYearTargets.get(key) ?? []
    if (!targets.includes(nodeId)) targets.push(nodeId)
    authorYearTargets.set(key, targets)
  }
  for (const [index, block] of blocks.entries()) {
    if (block.list?.numberingId !== 'references' || !block.nodeId) continue
    const key = pdfBibliographyAuthorYearKey(block.text)
    if (key) storeAuthorYearTarget(key, block.nodeId)
    const continuation = blocks[index + 1]
    const continuationIndentation = continuation
      ? continuation.region.box.x - block.region.box.x
      : 0
    if (
      key ||
      !pdfBibliographyFirstAuthorSurname(block.text) ||
      continuation?.list?.numberingId !== 'references' ||
      !continuation.list.continuedFromPreviousPage ||
      continuationIndentation < 0.008 ||
      continuationIndentation > 0.04
    ) {
      continue
    }
    const continuedKey = pdfBibliographyAuthorYearKey(
      `${block.text} ${continuation.text}`,
    )
    if (continuedKey) storeAuthorYearTarget(continuedKey, block.nodeId)
  }

  return classifications.flatMap<PdfCitationRelationship>((classification) => {
    if (!classification.accepted || classification.disposition !== 'citation')
      return []
    const labels = classification.label.split(',').filter(Boolean)
    if (
      labels.length === 0 ||
      labels.length > MAX_CITATION_TARGETS_PER_RELATIONSHIP
    ) {
      return []
    }
    if (classification.taxonomy === 'author-year-bibliography-citation') {
      let normalizedBoundaryKey = false
      const candidates = labels.map((label) => {
        const rawTargets = authorYearTargets.get(label) ?? []
        if (rawTargets.length !== 0) return rawTargets
        const region = regionMap.get(classification.referenceRegionId)
        const sourceText = region?.text.slice(
          classification.start,
          classification.end,
        )
        const firstSurname = sourceText?.match(
          /^\s*(\p{Lu}[\p{L}\p{M}'’.-]*)/u,
        )?.[1]
        const year = label.match(/:((?:18|19|20)\d{2}[a-z]?)$/u)?.[1]
        const surnameStart =
          region && sourceText && firstSurname
            ? classification.start + sourceText.indexOf(firstSurname)
            : -1
        if (
          !region ||
          !firstSurname ||
          !year ||
          surnameStart < classification.start ||
          pdfAuthorYearKey(firstSurname, year) !== label
        ) {
          return rawTargets
        }
        const alternateKey = pdfAlternateAuthorYearKeyFromBoundary(
          region,
          lineBoundaryDecisions,
          firstSurname,
          year,
          surnameStart,
        )
        const alternateTargets = alternateKey
          ? (authorYearTargets.get(alternateKey) ?? [])
          : []
        if (alternateTargets.length !== 1) return rawTargets
        normalizedBoundaryKey = true
        return alternateTargets
      })
      const missing = candidates.some((targets) => targets.length === 0)
      const ambiguous = candidates.some((targets) => targets.length > 1)
      const status = missing
        ? 'unresolved'
        : ambiguous
          ? 'ambiguous'
          : 'matched'
      const targetNodeIds =
        status === 'matched' ? candidates.map((targets) => targets[0]) : []
      const candidateNodeIds = [...new Set(candidates.flat())]
      const targets =
        status === 'matched'
          ? exactCitationTargetProvenance({
              classification,
              labels,
              targetNodeIds,
              regionMap,
              lineBoundaryDecisions,
            })
          : []
      return [
        {
          id: classification.id,
          label: classification.label,
          labels,
          referenceRegionId: classification.referenceRegionId,
          referenceStart: classification.start,
          referenceEnd: classification.end,
          taxonomy: classification.taxonomy,
          targetNodeIds,
          ...(status !== 'matched' && candidateNodeIds.length > 0
            ? { candidateNodeIds }
            : {}),
          targets,
          status,
          canonicalAnchor: null,
          confidence: classification.confidence,
          evidence: [
            ...classification.evidence,
            ...(normalizedBoundaryKey
              ? [
                  'author-year-key-normalized-from-unresolved-line-boundary-hyphen',
                ]
              : []),
            ...(missing
              ? ['bibliography-author-year-target-missing']
              : ambiguous
                ? ['bibliography-author-year-target-ambiguous']
                : ['bibliography-author-year-key-unique']),
          ],
          sourceBoxes: [{ ...classification.sourceBox }],
        },
      ]
    }
    const candidates = labels.map(
      (label) => bibliographyTargets.get(label) ?? [],
    )
    const missing = candidates.some((targets) => targets.length === 0)
    const ambiguous = candidates.some((targets) => targets.length > 1)
    const status = missing ? 'unresolved' : ambiguous ? 'ambiguous' : 'matched'
    const targetNodeIds =
      status === 'matched' ? candidates.map((targets) => targets[0]) : []
    const candidateNodeIds = [...new Set(candidates.flat())]
    const targets =
      status === 'matched'
        ? exactCitationTargetProvenance({
            classification,
            labels,
            targetNodeIds,
            regionMap,
            lineBoundaryDecisions,
          })
        : []
    return [
      {
        id: classification.id,
        label: classification.label,
        labels,
        referenceRegionId: classification.referenceRegionId,
        referenceStart: classification.start,
        referenceEnd: classification.end,
        taxonomy:
          classification.taxonomy as PdfCitationRelationship['taxonomy'],
        targetNodeIds,
        ...(status !== 'matched' && candidateNodeIds.length > 0
          ? { candidateNodeIds }
          : {}),
        targets,
        status,
        canonicalAnchor: null,
        confidence: classification.confidence,
        evidence: [
          ...classification.evidence,
          ...(status === 'matched'
            ? ['bibliography-label-target']
            : status === 'ambiguous'
              ? ['bibliography-label-target-ambiguous']
              : ['bibliography-label-target-missing']),
        ],
        sourceBoxes: [{ ...classification.sourceBox }],
      },
    ]
  })
}
