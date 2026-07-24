import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfScholarlyCrossReferenceKind,
  PdfScholarlyCrossReferenceRelationship,
} from './import-types'
import {
  expandPdfScholarlyVisualIdentifierRange,
  parsePdfScholarlyVisualIdentifier,
  parsePdfScholarlyVisualLabel,
  type PdfScholarlyVisualKind,
} from './pdf-scholarly-label'

export type PdfCanonicalCrossReferenceTarget = {
  kind: PdfScholarlyCrossReferenceKind
  label: string
  nodeId: string
  evidence: string[]
  sourceBoxes?: NormalizedSourceBox[]
}

type DetectedTarget = {
  kind: PdfScholarlyCrossReferenceKind
  label: string
  referenceStart: number
  referenceEnd: number
}

type DetectedReference = {
  kind: PdfScholarlyCrossReferenceKind
  text: string
  referenceRegionId: string
  referenceStart: number
  referenceEnd: number
  targets: DetectedTarget[]
  sourceBoxes: NormalizedSourceBox[]
}

const PREFIX_SOURCE = String.raw`\b(fig(?:ure)?s?|tables?|sections?|secs?|appendix|appendices|eq(?:uation)?s?)\.?\s+`
const MAX_EXPLICIT_LIST_TARGETS = 32

function kindForPrefix(value: string): PdfScholarlyCrossReferenceKind {
  if (/^fig/iu.test(value)) return 'figure'
  if (/^table/iu.test(value)) return 'table'
  if (/^append/iu.test(value)) return 'appendix'
  if (/^eq/iu.test(value)) return 'equation'
  return 'section'
}

function canonicalLabel(
  kind: PdfScholarlyCrossReferenceKind,
  identifier: string,
) {
  const name =
    kind === 'figure'
      ? 'Figure'
      : kind === 'table'
        ? 'Table'
        : kind === 'appendix'
          ? 'Appendix'
          : kind === 'equation'
            ? 'Equation'
            : 'Section'
  return `${name} ${identifier}`
}

function identifierAt(
  value: string,
  offset: number,
  kind: PdfScholarlyCrossReferenceKind,
  options: { allowAsciiHyphenCompound?: boolean } = {},
) {
  if (isVisualKind(kind)) {
    const parsed = parsePdfScholarlyVisualIdentifier(value, offset, {
      allowAsciiHyphenCompound: options.allowAsciiHyphenCompound === true,
      allowParentheses: true,
    })
    return parsed
      ? {
          identifier: parsed.identifier,
          start: parsed.start,
          end: parsed.end,
          consumedEnd: parsed.consumedEnd,
        }
      : null
  }
  const source = value.slice(offset)
  const identifierSource = (() => {
    if (kind === 'appendix') {
      return String.raw`[A-Z](?:\.\d+)*`
    }
    if (kind === 'section') {
      return String.raw`(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)+)`
    }
    return String.raw`(?:\d+(?:\.\d+)*(?:[A-Za-z])?|[IVXLCDM]+)`
  })()
  const boundary = String.raw`(?![\p{L}\p{N}]|\.[\p{L}\p{N}])`
  const pattern = new RegExp(
    source.startsWith('(')
      ? String.raw`^\((${identifierSource})\)${boundary}`
      : String.raw`^(${identifierSource})${boundary}`,
    'u',
  )
  const match = source.match(pattern)
  if (!match) return null
  const tokenOffset = match[0].indexOf(match[1])
  return {
    identifier: match[1],
    start: offset + tokenOffset,
    end: offset + tokenOffset + match[1].length,
    consumedEnd: offset + match[0].length,
  }
}

function isVisualKind(
  kind: PdfScholarlyCrossReferenceKind,
): kind is PdfScholarlyVisualKind {
  return kind === 'figure' || kind === 'table' || kind === 'equation'
}

function expandedRangeIdentifiers(
  first: string,
  last: string,
  kind: PdfScholarlyCrossReferenceKind,
) {
  if (isVisualKind(kind)) {
    return expandPdfScholarlyVisualIdentifierRange(first, last)
  }
  const bounded = (values: string[]) =>
    values.length >= 2 && values.length <= 32 ? values : null
  const numericFirst = first.split('.')
  const numericLast = last.split('.')
  if (
    numericFirst.every((part) => /^\d+$/u.test(part)) &&
    numericLast.every((part) => /^\d+$/u.test(part)) &&
    numericFirst.length === numericLast.length &&
    numericFirst
      .slice(0, -1)
      .every((part, index) => part === numericLast[index])
  ) {
    const start = Number(numericFirst.at(-1))
    const end = Number(numericLast.at(-1))
    if (
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      end >= start
    ) {
      const prefix = numericFirst.slice(0, -1)
      return bounded(
        Array.from({ length: end - start + 1 }, (_, index) =>
          [...prefix, String(start + index)].join('.'),
        ),
      )
    }
  }
  if (
    kind === 'appendix' &&
    /^[A-Z]$/u.test(first) &&
    /^[A-Z]$/u.test(last) &&
    last.charCodeAt(0) >= first.charCodeAt(0)
  ) {
    return bounded(
      Array.from(
        { length: last.charCodeAt(0) - first.charCodeAt(0) + 1 },
        (_, index) => String.fromCharCode(first.charCodeAt(0) + index),
      ),
    )
  }
  return null
}

function exactVisualIdentifier(value: string) {
  const parsed = parsePdfScholarlyVisualIdentifier(value, 0, {
    allowAsciiHyphenCompound: true,
    allowParentheses: false,
  })
  return parsed && parsed.consumedEnd === value.length
    ? parsed.identifier
    : null
}

function compactParenthesizedVisualRangeAt(
  value: string,
  offset: number,
  kind: PdfScholarlyVisualKind,
) {
  if (value[offset] !== '(') return null
  const closingParenthesis = value.indexOf(')', offset + 1)
  if (
    closingParenthesis < 0 ||
    closingParenthesis - offset > 128 ||
    value.slice(offset + 1, closingParenthesis).includes('(')
  ) {
    return null
  }
  const interior = value.slice(offset + 1, closingParenthesis)
  const candidates = [...interior.matchAll(/[\u2013\u2014-]/gu)].flatMap(
    (match) => {
      const separatorOffset = match.index ?? -1
      if (separatorOffset < 0) return []
      const leftSource = interior.slice(0, separatorOffset)
      const rightSource = interior.slice(separatorOffset + match[0].length)
      const firstSource = leftSource.trim()
      const lastSource = rightSource.trim()
      if (!firstSource || !lastSource) return []
      const first = exactVisualIdentifier(firstSource)
      const last = exactVisualIdentifier(lastSource)
      if (!first || !last) return []
      const identifiers = expandedRangeIdentifiers(first, last, kind)
      if (!identifiers) return []
      const firstStart = offset + 1 + leftSource.indexOf(firstSource)
      const lastStart =
        offset +
        1 +
        separatorOffset +
        match[0].length +
        rightSource.indexOf(lastSource)
      return [
        {
          identifiers,
          firstStart,
          firstEnd: firstStart + firstSource.length,
          lastStart,
          lastEnd: lastStart + lastSource.length,
          consumedEnd: closingParenthesis + 1,
        },
      ]
    },
  )
  return candidates.length === 1 ? candidates[0] : null
}

function sourceBoxesForRange(
  region: PdfPageRegion,
  start: number,
  end: number,
) {
  const referenceText = region.text.slice(start, end)
  const directBoxes = region.lines
    .filter((line) => line.text.includes(referenceText))
    .map((line) => ({ ...line.box }))
  if (directBoxes.length > 0) return directBoxes
  const boxes: NormalizedSourceBox[] = []
  let cursor = 0
  for (const line of region.lines) {
    const lineStart = region.text.indexOf(line.text, cursor)
    if (lineStart < 0) continue
    const lineEnd = lineStart + line.text.length
    cursor = lineEnd
    if (Math.max(start, lineStart) < Math.min(end, lineEnd)) {
      boxes.push({ ...line.box })
    }
  }
  return boxes.length > 0 ? boxes : [{ ...region.box }]
}

function detectRegionReferences(region: PdfPageRegion) {
  const found: DetectedReference[] = []
  for (const match of region.text.matchAll(new RegExp(PREFIX_SOURCE, 'giu'))) {
    const referenceStart = match.index ?? 0
    const kind = kindForPrefix(match[1])
    const identifierOffset = referenceStart + match[0].length
    const compactRange = isVisualKind(kind)
      ? compactParenthesizedVisualRangeAt(region.text, identifierOffset, kind)
      : null
    const parsedVisualLabel = isVisualKind(kind)
      ? parsePdfScholarlyVisualLabel(region.text.slice(referenceStart), {
          context: 'reference',
        })
      : null
    const first = compactRange
      ? {
          identifier: compactRange.identifiers[0],
          start: compactRange.firstStart,
          end: compactRange.firstEnd,
          consumedEnd: compactRange.consumedEnd,
        }
      : parsedVisualLabel?.status === 'parsed' &&
          parsedVisualLabel.kind === kind
        ? {
            identifier: parsedVisualLabel.identifier,
            start: referenceStart + parsedVisualLabel.identifierStart,
            end: referenceStart + parsedVisualLabel.identifierEnd,
            consumedEnd: referenceStart + parsedVisualLabel.consumedEnd,
          }
        : identifierAt(region.text, identifierOffset, kind, {
            allowAsciiHyphenCompound: true,
          })
    if (!first) continue
    const targets: DetectedTarget[] = compactRange
      ? compactRange.identifiers.map((identifier) => ({
          kind,
          label: canonicalLabel(kind, identifier),
          referenceStart: compactRange.firstStart,
          referenceEnd: compactRange.lastEnd,
        }))
      : [
          {
            kind,
            label: canonicalLabel(kind, first.identifier),
            referenceStart: first.start,
            referenceEnd: first.end,
          },
        ]
    let referenceEnd = compactRange?.consumedEnd ?? first.consumedEnd
    let cursor = referenceEnd
    if (!compactRange) {
      const rangeConnector = region.text
        .slice(cursor)
        .match(/^\s*[\u2013\u2014-]\s*/u)
      if (rangeConnector) {
        const last = identifierAt(
          region.text,
          cursor + rangeConnector[0].length,
          kind,
          { allowAsciiHyphenCompound: true },
        )
        if (last) {
          const identifiers = expandedRangeIdentifiers(
            first.identifier,
            last.identifier,
            kind,
          )
          const rangeStart = first.start
          const rangeEnd = last.end
          targets.splice(
            0,
            targets.length,
            ...(
              identifiers ?? [`${first.identifier}\u2013${last.identifier}`]
            ).map((identifier) => ({
              kind,
              label: canonicalLabel(kind, identifier),
              referenceStart: rangeStart,
              referenceEnd: rangeEnd,
            })),
          )
          referenceEnd = last.consumedEnd
          cursor = last.consumedEnd
        }
      }
    }
    while (
      cursor < region.text.length &&
      targets.length < MAX_EXPLICIT_LIST_TARGETS
    ) {
      const connector = region.text
        .slice(cursor)
        .match(/^\s*(?:(?:[,;])\s*(?:(?:and|or)\b\s*)?|(?:and|or)\s+)/iu)
      if (!connector) break
      const next = identifierAt(
        region.text,
        cursor + connector[0].length,
        kind,
        { allowAsciiHyphenCompound: true },
      )
      if (!next) break
      targets.push({
        kind,
        label: canonicalLabel(kind, next.identifier),
        referenceStart: next.start,
        referenceEnd: next.end,
      })
      referenceEnd = next.consumedEnd
      cursor = next.consumedEnd
    }
    found.push({
      kind,
      text: region.text.slice(referenceStart, referenceEnd),
      referenceRegionId: region.id,
      referenceStart,
      referenceEnd,
      targets,
      sourceBoxes: sourceBoxesForRange(region, referenceStart, referenceEnd),
    })
  }
  return found
}

function targetKey(kind: PdfScholarlyCrossReferenceKind, label: string) {
  return `${kind}:${label.toLocaleLowerCase()}`
}

function parentFigureLabelForPanelSuffix(label: string) {
  const identifier = label.match(/^Figure\s+(.+)$/u)?.[1]
  if (!identifier) return null
  const panel = identifier.match(/^(.+\d)([A-Za-z])$/u)
  return panel ? `Figure ${panel[1]}` : null
}

function relationshipId(reference: DetectedReference) {
  const region = reference.referenceRegionId
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
  return `scholarly-cross-reference-${region || 'region'}-${reference.referenceStart}-${reference.referenceEnd}`
}

export function resolvePdfScholarlyCrossReferences({
  regions,
  canonicalTargets,
}: {
  regions: readonly PdfPageRegion[]
  canonicalTargets: readonly PdfCanonicalCrossReferenceTarget[]
}): PdfScholarlyCrossReferenceRelationship[] {
  const targetsByLabel = new Map<string, PdfCanonicalCrossReferenceTarget[]>()
  for (const target of canonicalTargets) {
    const key = targetKey(target.kind, target.label)
    const values = targetsByLabel.get(key) ?? []
    values.push(target)
    targetsByLabel.set(key, values)
  }
  return regions.flatMap(detectRegionReferences).map((reference) => {
    const targets = reference.targets.map((target) => {
      const exactCandidates =
        targetsByLabel.get(targetKey(target.kind, target.label)) ?? []
      const parentFigureLabel =
        target.kind === 'figure' && exactCandidates.length === 0
          ? parentFigureLabelForPanelSuffix(target.label)
          : null
      const parentFigureCandidates = parentFigureLabel
        ? (targetsByLabel.get(targetKey('figure', parentFigureLabel)) ?? [])
        : []
      const parentFigureNodeIds = [
        ...new Set(parentFigureCandidates.map((candidate) => candidate.nodeId)),
      ]
      const usedParentFigureFallback =
        exactCandidates.length === 0 && parentFigureNodeIds.length === 1
      const candidates = usedParentFigureFallback
        ? parentFigureCandidates
        : exactCandidates
      const candidateNodeIds = [
        ...new Set(candidates.map((candidate) => candidate.nodeId)),
      ]
      const status =
        candidateNodeIds.length === 1
          ? ('matched' as const)
          : candidateNodeIds.length > 1
            ? ('ambiguous' as const)
            : ('unresolved' as const)
      return {
        ...target,
        status,
        candidateNodeIds,
        targetNodeId: status === 'matched' ? candidateNodeIds[0] : null,
        evidence: [
          'explicit-scholarly-cross-reference-syntax',
          ...new Set(candidates.flatMap((candidate) => candidate.evidence)),
          ...(usedParentFigureFallback
            ? [
                'explicit-panel-suffix',
                'canonical-parent-figure-fallback',
                'canonical-parent-label-unique',
              ]
            : []),
          ...(status === 'matched'
            ? [
                usedParentFigureFallback
                  ? 'canonical-panel-parent-unique'
                  : 'canonical-label-unique',
              ]
            : status === 'ambiguous'
              ? ['canonical-label-ambiguous']
              : ['canonical-label-missing']),
        ],
      }
    })
    const status = targets.some((target) => target.status === 'ambiguous')
      ? ('ambiguous' as const)
      : targets.some((target) => target.status === 'unresolved')
        ? ('unresolved' as const)
        : ('matched' as const)
    return {
      id: relationshipId(reference),
      kind: reference.kind,
      text: reference.text,
      labels: targets.map((target) => target.label),
      referenceRegionId: reference.referenceRegionId,
      referenceStart: reference.referenceStart,
      referenceEnd: reference.referenceEnd,
      targets,
      targetNodeIds:
        status === 'matched'
          ? targets.flatMap((target) =>
              target.targetNodeId ? [target.targetNodeId] : [],
            )
          : [],
      status,
      canonicalAnchor: null,
      confidence: 0.99,
      evidence: [
        'explicit-scholarly-cross-reference-syntax',
        ...(status === 'matched'
          ? ['all-canonical-labels-unique']
          : status === 'ambiguous'
            ? ['one-or-more-canonical-labels-ambiguous']
            : ['one-or-more-canonical-labels-missing']),
      ],
      sourceBoxes: reference.sourceBoxes,
    }
  })
}
