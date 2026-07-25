import type {
  NormalizedSourceBox,
  PdfEmbeddedLink,
  PdfExternalLinkAnnotation,
  PdfInternalDestinationEvidence,
  PdfInternalLinkAnnotation,
  PdfLinkAnnotation,
  PdfSourceRun,
} from './import-types'
import { normalizePdfTextSequence } from './pdf-font-text'
import { parsePdfScholarlyVisualIdentifier } from './pdf-scholarly-label'

const MAX_PRESERVED_LINK_TARGET_CHARACTERS = 2_048
const MAX_INTERNAL_DESTINATION_CHARACTERS = 256
const SAFE_CANONICAL_FRAGMENT_ID = /^[A-Za-z_][A-Za-z0-9_.:-]{0,511}$/u

export type PdfCanonicalInternalLinkTargetKind =
  | 'section'
  | 'appendix'
  | 'figure'
  | 'table'
  | 'equation'
  | 'reference'
  | 'note'

export type PdfCanonicalInternalLinkTarget = {
  kind: PdfCanonicalInternalLinkTargetKind
  label: string
  nodeId: string
  sourceBoxes?: NormalizedSourceBox[]
}

type ParsedPdfInternalDestination = {
  kind: PdfCanonicalInternalLinkTargetKind
  label: string
}

export type PdfInternalDestinationResolution =
  | { status: 'unsupported'; targetNodeId: null }
  | {
      status: 'missing' | 'ambiguous'
      targetNodeId: null
      parsed?: ParsedPdfInternalDestination
    }
  | {
      status: 'matched'
      targetNodeId: string
      parsed?: ParsedPdfInternalDestination
    }

type PdfNamedDestinationViewport = {
  width: number
  height: number
  rotation: number
  convertToViewportPoint: (x: number, y: number) => number[]
  convertToViewportRectangle: (rect: number[]) => number[]
}

type PdfNamedDestinationDocument = {
  numPages?: number
  getDestination: (destination: string) => Promise<unknown[] | null>
  getPageIndex: (reference: unknown) => Promise<number>
  getPage: (pageNumber: number) => Promise<{
    view?: number[]
    getViewport: (options: { scale: number }) => PdfNamedDestinationViewport
  }>
}

const PDF_DESTINATION_VIEWS = new Set<PdfInternalDestinationEvidence['view']>([
  'XYZ',
  'Fit',
  'FitB',
  'FitH',
  'FitBH',
  'FitV',
  'FitBV',
  'FitR',
])
const PDF_DESTINATION_EXACT_TOLERANCE = 0.0015
const PDF_DESTINATION_NEAR_TOLERANCE = 0.035
const PDF_DESTINATION_UNIQUENESS_MARGIN = 0.0025

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value))
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function normalizedCoordinate(value: number, extent: number) {
  const normalized = value / extent
  if (
    !Number.isFinite(normalized) ||
    normalized < -0.00002 ||
    normalized > 1.00002
  ) {
    return null
  }
  return rounded(clamp(normalized))
}

function normalizedDestinationPoint({
  page,
  rotation,
  viewport,
  x,
  y,
}: {
  page: number
  rotation: number
  viewport: PdfNamedDestinationViewport
  x: number
  y: number
}): NonNullable<PdfInternalDestinationEvidence['point']> | null {
  let converted: number[]
  try {
    converted = viewport.convertToViewportPoint(x, y)
  } catch {
    return null
  }
  if (converted.length < 2 || !converted.slice(0, 2).every(finite)) {
    return null
  }
  const normalizedX = normalizedCoordinate(converted[0], viewport.width)
  const normalizedY = normalizedCoordinate(converted[1], viewport.height)
  return normalizedX === null || normalizedY === null
    ? null
    : {
        page,
        x: normalizedX,
        y: normalizedY,
        rotation,
        method: 'pdf-destination',
      }
}

function normalizedDestinationBox({
  page,
  rotation,
  viewport,
  rect,
}: {
  page: number
  rotation: number
  viewport: PdfNamedDestinationViewport
  rect: number[]
}): PdfInternalDestinationEvidence['box'] {
  const normalized = normalizedAnnotationBox({
    page,
    rotation,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    rect,
    convertToViewportRectangle: viewport.convertToViewportRectangle,
  })
  return normalized ? { ...normalized, method: 'pdf-destination' } : null
}

function destinationView(value: unknown) {
  const name =
    value &&
    typeof value === 'object' &&
    typeof (value as { name?: unknown }).name === 'string'
      ? (value as { name: string }).name
      : null
  return name &&
    PDF_DESTINATION_VIEWS.has(name as PdfInternalDestinationEvidence['view'])
    ? (name as PdfInternalDestinationEvidence['view'])
    : null
}

/**
 * Resolves a PDF named destination through PDF.js without inferring a target
 * from its name. The returned coordinates are normalized in the target page's
 * rotated viewport and remain attached to the source link obligation.
 */
export async function resolvePdfNamedDestinationEvidence({
  destination,
  document,
}: {
  destination: string
  document: PdfNamedDestinationDocument
}): Promise<PdfInternalDestinationEvidence | null> {
  if (
    destination.length === 0 ||
    destination.length > MAX_INTERNAL_DESTINATION_CHARACTERS ||
    /[\u0000-\u001f\u007f]/u.test(destination)
  ) {
    return null
  }
  try {
    const explicit = await document.getDestination(destination)
    if (!Array.isArray(explicit) || explicit.length < 2) return null
    const view = destinationView(explicit[1])
    if (!view) return null
    const pageIndex = Number.isInteger(explicit[0])
      ? (explicit[0] as number)
      : await document.getPageIndex(explicit[0])
    const pageNumber = pageIndex + 1
    if (
      !Number.isInteger(pageIndex) ||
      pageIndex < 0 ||
      (Number.isInteger(document.numPages) &&
        pageNumber > (document.numPages as number))
    ) {
      return null
    }
    const targetPage = await document.getPage(pageNumber)
    const viewport = targetPage.getViewport({ scale: 1 })
    if (
      !finite(viewport.width) ||
      !finite(viewport.height) ||
      viewport.width <= 0 ||
      viewport.height <= 0 ||
      !finite(viewport.rotation)
    ) {
      return null
    }

    let point: PdfInternalDestinationEvidence['point'] = null
    let box: PdfInternalDestinationEvidence['box'] = null
    if (view === 'XYZ' && finite(explicit[2]) && finite(explicit[3])) {
      point = normalizedDestinationPoint({
        page: pageNumber,
        rotation: viewport.rotation,
        viewport,
        x: explicit[2],
        y: explicit[3],
      })
    } else if (
      view === 'FitR' &&
      explicit.slice(2, 6).length === 4 &&
      explicit.slice(2, 6).every(finite)
    ) {
      box = normalizedDestinationBox({
        page: pageNumber,
        rotation: viewport.rotation,
        viewport,
        rect: explicit.slice(2, 6) as number[],
      })
    }

    return {
      source: 'pdfjs-named-destination',
      destination,
      view,
      page: pageNumber,
      point,
      box,
    }
  } catch {
    return null
  }
}

export function safePdfExternalLinkTarget(value: string) {
  // WHATWG URL parsing repairs backslashes and ASCII whitespace in special
  // URLs. Emitting the repaired target would silently change source meaning.
  if (/[\u0000-\u0020\u007f\\]/u.test(value)) return false
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

export function normalizedPdfExternalLinkTarget(value: string) {
  if (!safePdfExternalLinkTarget(value)) return null
  try {
    return new URL(value).href
  } catch {
    return null
  }
}

export type PdfLinkedTokenBoundaryEvidence = {
  page: number
  fromLineIndex: number
  toLineIndex: number
  fromText: string
  toText: string
  status: 'matched' | 'unresolved'
  target: string
  normalizedTarget: string
  annotationIds: string[]
  visibleText: string
  sourceBoxes: NormalizedSourceBox[]
  evidence: string[]
  reason?: 'ambiguous-source-geometry' | 'url-round-trip-failed'
}

type PdfLinkedTokenSourceLine = {
  page?: number
  text: string
  runs: PdfSourceRun[]
}

const PDF_LINKED_TOKEN_ANNOTATIONS = Symbol('pdf-linked-token-annotations')
type PdfLinkedTokenAnnotationCarrier = {
  [PDF_LINKED_TOKEN_ANNOTATIONS]?: readonly PdfEmbeddedLink[]
}

function registeredPdfLinkedTokenAnnotations(line: object) {
  return (line as PdfLinkedTokenAnnotationCarrier)[PDF_LINKED_TOKEN_ANNOTATIONS]
}

export function registerPdfLinkedTokenSourceAnnotations(
  line: object,
  annotations: readonly PdfEmbeddedLink[],
) {
  ;(line as PdfLinkedTokenAnnotationCarrier)[PDF_LINKED_TOKEN_ANNOTATIONS] =
    annotations
}

export function copyPdfLinkedTokenSourceAnnotations(
  source: object,
  target: object,
) {
  const annotations = registeredPdfLinkedTokenAnnotations(source)
  if (annotations) registerPdfLinkedTokenSourceAnnotations(target, annotations)
}

export function resolveRegisteredPdfLinkedTokenContinuity(
  lines: readonly PdfLinkedTokenSourceLine[],
) {
  const annotations = [
    ...new Set(
      lines.flatMap((line) => [
        ...(registeredPdfLinkedTokenAnnotations(line) ?? []),
      ]),
    ),
  ]
  return resolvePdfLinkedTokenContinuity(lines, annotations)
}

type PdfLinkedTokenLineFragment = {
  lineIndex: number
  start: number
  end: number
  text: string
  target: string
  normalizedTarget: string
  annotationIds: string[]
  sourceBoxes: NormalizedSourceBox[]
}

function sourceBoxesOverlap(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  if (left.page !== right.page) return false
  const overlapWidth =
    Math.min(left.x + left.width, right.x + right.width) -
    Math.max(left.x, right.x)
  const overlapHeight =
    Math.min(left.y + left.height, right.y + right.height) -
    Math.max(left.y, right.y)
  return overlapWidth > 0 && overlapHeight > 0
}

function lineRunRanges(line: PdfLinkedTokenSourceLine) {
  const ranges = new Map<PdfSourceRun, { start: number; end: number }>()
  let cursor = 0
  for (const run of [...line.runs].sort(
    (left, right) => left.x - right.x || left.y - right.y,
  )) {
    const text = normalizePdfTextSequence(run.text.trim())
    if (!text) continue
    const start = line.text.indexOf(text, cursor)
    if (start < 0) return null
    const end = start + text.length
    ranges.set(run, { start, end })
    cursor = end
  }
  return ranges
}

function linkedTokenLineFragments(
  lines: readonly PdfLinkedTokenSourceLine[],
  annotations: readonly PdfEmbeddedLink[],
) {
  const normalizedAnnotations = normalizePdfLinkAnnotations(
    lines[0]?.page ?? lines[0]?.runs[0]?.page ?? 0,
    annotations,
  ).flatMap((annotation) => {
    if (annotation.status !== 'external' || !annotation.box) return []
    const normalizedTarget = normalizedPdfExternalLinkTarget(annotation.url)
    return normalizedTarget ? [{ annotation, normalizedTarget }] : []
  })
  const fragments: PdfLinkedTokenLineFragment[] = []

  for (const [lineIndex, line] of lines.entries()) {
    const ranges = lineRunRanges(line)
    if (!ranges) continue
    const byTarget = new Map<
      string,
      Array<{
        annotation: PdfExternalLinkAnnotation
        ranges: Array<{ start: number; end: number }>
      }>
    >()
    for (const { annotation, normalizedTarget } of normalizedAnnotations) {
      const overlappingRanges = line.runs.flatMap((run) => {
        const range = ranges.get(run)
        return range && sourceBoxesOverlap(annotation.box!, run) ? [range] : []
      })
      if (overlappingRanges.length === 0) continue
      const entries = byTarget.get(normalizedTarget) ?? []
      entries.push({ annotation, ranges: overlappingRanges })
      byTarget.set(normalizedTarget, entries)
    }
    for (const [normalizedTarget, entries] of byTarget) {
      const rangesForTarget = entries.flatMap((entry) => entry.ranges)
      const start = Math.min(...rangesForTarget.map((range) => range.start))
      const end = Math.max(...rangesForTarget.map((range) => range.end))
      if (!(start >= 0 && start < end && end <= line.text.length)) continue
      fragments.push({
        lineIndex,
        start,
        end,
        text: line.text.slice(start, end),
        target: entries[0].annotation.url,
        normalizedTarget,
        annotationIds: [
          ...new Set(entries.map((entry) => entry.annotation.id)),
        ].sort(),
        sourceBoxes: entries
          .map((entry) => entry.annotation.box)
          .filter((box): box is NormalizedSourceBox => box !== null),
      })
    }
  }
  return fragments
}

function urlRoundTripCandidates(value: string) {
  const candidates = [value]
  let candidate = value
  while (/[.,;:!?)}\]]$/u.test(candidate)) {
    candidate = candidate.slice(0, -1)
    candidates.push(candidate)
  }
  return candidates
}

export function pdfVisibleUrlRoundTrip(
  visibleText: string,
  target: string,
): {
  normalizedTarget: string
  visibleToken: string
} | null {
  const normalizedTarget = normalizedPdfExternalLinkTarget(target)
  const visible = visibleText.trim()
  if (
    !normalizedTarget ||
    !visible ||
    /[\u0000-\u0020\u007f\\]/u.test(visible)
  ) {
    return null
  }
  for (const candidate of urlRoundTripCandidates(visible)) {
    const normalizedVisible = normalizedPdfExternalLinkTarget(candidate)
    if (normalizedVisible === normalizedTarget) {
      return { normalizedTarget, visibleToken: candidate }
    }
  }
  return null
}

/**
 * Proves only line-boundary joins whose source link boxes overlap the visible
 * suffix/prefix runs, whose destinations normalize identically, and whose
 * concatenated visible fragments round-trip to that destination. Candidate
 * joins that fail the round trip remain explicit review obligations.
 */
export function resolvePdfLinkedTokenContinuity(
  lines: readonly PdfLinkedTokenSourceLine[],
  annotations: readonly PdfEmbeddedLink[],
): PdfLinkedTokenBoundaryEvidence[] {
  if (lines.length < 2 || annotations.length < 2) return []
  const fragments = linkedTokenLineFragments(lines, annotations)
  const edges = Array.from({ length: lines.length - 1 }, (_, fromLineIndex) => {
    const left = fragments.filter(
      (fragment) =>
        fragment.lineIndex === fromLineIndex &&
        !lines[fromLineIndex].text.slice(fragment.end).trim(),
    )
    const right = fragments.filter(
      (fragment) =>
        fragment.lineIndex === fromLineIndex + 1 &&
        !lines[fromLineIndex + 1].text.slice(0, fragment.start).trim(),
    )
    return left.flatMap((leftFragment) =>
      right
        .filter(
          (rightFragment) =>
            rightFragment.normalizedTarget === leftFragment.normalizedTarget,
        )
        .map((rightFragment) => ({
          fromLineIndex,
          normalizedTarget: leftFragment.normalizedTarget,
          target: leftFragment.target,
          left: leftFragment,
          right: rightFragment,
        })),
    )
  })
  const results: PdfLinkedTokenBoundaryEvidence[] = []

  for (
    let boundaryIndex = 0;
    boundaryIndex < edges.length;
    boundaryIndex += 1
  ) {
    for (const edge of edges[boundaryIndex]) {
      if (
        results.some(
          (result) =>
            result.fromLineIndex === edge.fromLineIndex &&
            result.normalizedTarget === edge.normalizedTarget,
        )
      ) {
        continue
      }
      const chain = [edge]
      let nextBoundaryIndex = boundaryIndex + 1
      while (nextBoundaryIndex < edges.length) {
        const next = edges[nextBoundaryIndex].find(
          (candidate) =>
            candidate.normalizedTarget === edge.normalizedTarget &&
            candidate.left.start === chain.at(-1)!.right.start &&
            candidate.left.end === chain.at(-1)!.right.end &&
            candidate.left.text === chain.at(-1)!.right.text,
        )
        if (!next) break
        chain.push(next)
        nextBoundaryIndex += 1
      }
      const visibleText = [
        chain[0].left.text,
        ...chain.map((candidate) => candidate.right.text),
      ].join('')
      const roundTrip = pdfVisibleUrlRoundTrip(visibleText, edge.target)
      const annotationIds = [
        ...new Set(
          chain.flatMap((candidate) => [
            ...candidate.left.annotationIds,
            ...candidate.right.annotationIds,
          ]),
        ),
      ].sort()
      const sourceBoxes = [
        ...new Map(
          chain
            .flatMap((candidate) => [
              ...candidate.left.sourceBoxes,
              ...candidate.right.sourceBoxes,
            ])
            .map((box) => [
              `${box.page}:${box.x}:${box.y}:${box.width}:${box.height}`,
              box,
            ]),
        ).values(),
      ]
      for (const candidate of chain) {
        results.push({
          page:
            lines[candidate.fromLineIndex].page ??
            lines[candidate.fromLineIndex].runs[0]?.page ??
            0,
          fromLineIndex: candidate.fromLineIndex,
          toLineIndex: candidate.fromLineIndex + 1,
          fromText: lines[candidate.fromLineIndex].text,
          toText: lines[candidate.fromLineIndex + 1].text,
          status: roundTrip ? 'matched' : 'unresolved',
          target: edge.target,
          normalizedTarget: edge.normalizedTarget,
          annotationIds,
          visibleText,
          sourceBoxes,
          evidence: roundTrip
            ? [
                'same-normalized-link-target',
                'source-link-geometry',
                'url-round-trip',
              ]
            : [
                'same-normalized-link-target',
                'source-link-geometry',
                'url-round-trip-failed',
              ],
          ...(!roundTrip ? { reason: 'url-round-trip-failed' as const } : {}),
        })
      }
    }
  }
  return results.sort(
    (left, right) =>
      left.fromLineIndex - right.fromLineIndex ||
      left.normalizedTarget.localeCompare(right.normalizedTarget),
  )
}

export type PdfLinkedTokenRangeCandidate = {
  annotationId: string
  ownerId: string
  start: number
  end: number
  target: string
  sourceBox?: NormalizedSourceBox | null
}

export type PdfLinkedTokenRangeResolution = {
  status: 'matched' | 'unresolved'
  ownerId: string
  start: number
  end: number
  target: string
  normalizedTarget: string
  annotationIds: string[]
  sourceBoxes: NormalizedSourceBox[]
  visibleText: string
  fragments: PdfLinkedTokenRangeCandidate[]
  reason?: 'unproven-wrap-whitespace' | 'url-round-trip-failed'
}

/**
 * Audits canonical ranges that came from PDF annotations and visibly present
 * themselves as URL tokens. A single range or zero-gap same-target chain must
 * round-trip to the normalized target before it can be emitted as an anchor.
 * Descriptive link labels are intentionally left alone; malformed, truncated,
 * or whitespace-corrupted visible URL surfaces remain explicit obligations.
 */
export function resolvePdfLinkedTokenRangeContinuity({
  ownerTexts,
  ranges,
}: {
  ownerTexts: ReadonlyMap<string, string>
  ranges: readonly PdfLinkedTokenRangeCandidate[]
}): PdfLinkedTokenRangeResolution[] {
  const ordered = [...ranges].sort(
    (left, right) =>
      left.ownerId.localeCompare(right.ownerId) ||
      left.start - right.start ||
      left.end - right.end ||
      left.annotationId.localeCompare(right.annotationId),
  )
  const resolutions: PdfLinkedTokenRangeResolution[] = []

  for (let index = 0; index < ordered.length; index += 1) {
    const first = ordered[index]
    const text = ownerTexts.get(first.ownerId)
    const normalizedTarget = normalizedPdfExternalLinkTarget(first.target)
    if (!text || !normalizedTarget) continue
    const chain = [first]
    let cursor = index + 1
    while (cursor < ordered.length) {
      const previous = chain.at(-1)!
      const candidate = ordered[cursor]
      if (
        candidate.ownerId !== first.ownerId ||
        normalizedPdfExternalLinkTarget(candidate.target) !==
          normalizedTarget ||
        candidate.start < previous.end ||
        text.slice(previous.end, candidate.start).trim()
      ) {
        break
      }
      chain.push(candidate)
      cursor += 1
    }
    index = cursor - 1
    const visibleText = chain
      .map((candidate) => text.slice(candidate.start, candidate.end))
      .join('')
    if (!/^(?:https?|mailto)\s*:/iu.test(visibleText.trim())) continue
    const roundTrip = pdfVisibleUrlRoundTrip(visibleText, first.target)
    const hasCanonicalWhitespace = chain
      .slice(1)
      .some((candidate, itemIndex) =>
        Boolean(text.slice(chain[itemIndex].end, candidate.start)),
      )
    const sourceBoxes = chain
      .map((candidate) => candidate.sourceBox)
      .filter((box): box is NormalizedSourceBox => Boolean(box))
    const annotationIds = [
      ...new Set(chain.map((candidate) => candidate.annotationId)),
    ]
    if (roundTrip && !hasCanonicalWhitespace) {
      resolutions.push({
        status: 'matched',
        ownerId: first.ownerId,
        start: first.start,
        end: first.start + roundTrip.visibleToken.length,
        target: roundTrip.normalizedTarget,
        normalizedTarget: roundTrip.normalizedTarget,
        annotationIds,
        sourceBoxes,
        visibleText,
        fragments: chain,
      })
      continue
    }
    resolutions.push({
      status: 'unresolved',
      ownerId: first.ownerId,
      start: first.start,
      end: chain.at(-1)!.end,
      target: first.target,
      normalizedTarget,
      annotationIds,
      sourceBoxes,
      visibleText,
      fragments: chain,
      reason: roundTrip ? 'unproven-wrap-whitespace' : 'url-round-trip-failed',
    })
  }
  return resolutions
}

function normalizedInternalTargetKey(
  kind: PdfCanonicalInternalLinkTargetKind,
  label: string,
) {
  return `${kind}:${label.trim().replace(/\s+/gu, ' ').toLocaleLowerCase()}`
}

function boundedSectionIdentifier(value: string) {
  if (/^\d{1,4}(?:\.\d{1,4}){0,3}$/u.test(value)) return value
  if (/^[A-Z](?:\.\d{1,4}){0,3}$/iu.test(value)) {
    return `${value[0].toUpperCase()}${value.slice(1)}`
  }
  return null
}

function boundedVisualIdentifier(value: string) {
  const parsed = parsePdfScholarlyVisualIdentifier(value, 0, {
    allowAsciiHyphenCompound: true,
    allowParentheses: false,
  })
  return parsed?.consumedEnd === value.length ? parsed.identifier : null
}

function parsedPdfInternalDestination(
  value: string,
): ParsedPdfInternalDestination | null {
  if (
    value.length === 0 ||
    value.length > MAX_INTERNAL_DESTINATION_CHARACTERS ||
    /[\u0000-\u0020\u007f\\/#?]/u.test(value)
  ) {
    return null
  }
  const section = value.match(/^(?:section|subsection|subsubsection)\.(.+)$/iu)
  if (section) {
    const identifier = boundedSectionIdentifier(section[1])
    return identifier
      ? { kind: 'section', label: `Section ${identifier}` }
      : null
  }
  const appendix = value.match(/^appendix\.(.+)$/iu)
  if (appendix) {
    const identifier = boundedSectionIdentifier(appendix[1])
    return identifier && /^[A-Z]/u.test(identifier)
      ? { kind: 'appendix', label: `Appendix ${identifier}` }
      : null
  }
  const visual = value.match(/^(figure|table|equation)(?:\.caption)?\.(.+)$/iu)
  if (visual) {
    const kind = visual[1].toLocaleLowerCase() as
      'figure' | 'table' | 'equation'
    const identifier = boundedVisualIdentifier(visual[2])
    const name =
      kind === 'figure' ? 'Figure' : kind === 'table' ? 'Table' : 'Equation'
    return identifier ? { kind, label: `${name} ${identifier}` } : null
  }
  const reference = value.match(
    /^(?:cite|reference|bibliography|bib)\.([\p{L}\p{N}][\p{L}\p{N}._:-]{0,127})$/iu,
  )
  return reference
    ? { kind: 'reference', label: `Reference ${reference[1]}` }
    : null
}

export function resolvePdfInternalDestination(
  destination: string,
  canonicalTargets: readonly PdfCanonicalInternalLinkTarget[],
): PdfInternalDestinationResolution {
  const parsed = parsedPdfInternalDestination(destination)
  if (!parsed) return { status: 'unsupported', targetNodeId: null }
  const key = normalizedInternalTargetKey(parsed.kind, parsed.label)
  const targetNodeIds = [
    ...new Set(
      canonicalTargets.flatMap((target) =>
        normalizedInternalTargetKey(target.kind, target.label) === key &&
        SAFE_CANONICAL_FRAGMENT_ID.test(target.nodeId)
          ? [target.nodeId]
          : [],
      ),
    ),
  ]
  return targetNodeIds.length === 1
    ? {
        status: 'matched',
        parsed,
        targetNodeId: targetNodeIds[0],
      }
    : {
        status: targetNodeIds.length > 1 ? 'ambiguous' : 'missing',
        parsed,
        targetNodeId: null,
      }
}

function destinationGeometryKind(
  destination: string,
  parsed: ParsedPdfInternalDestination | null,
): PdfCanonicalInternalLinkTargetKind | null {
  if (parsed) return parsed.kind
  if (/^Hfootnote\.[\p{L}\p{N}._:-]{1,128}$/u.test(destination)) return 'note'
  // biblatex names each bibliography anchor `cite.<refsection>@<entrykey>`,
  // and an entry key may contain characters (`@`, `:`, `/`) that the parsed
  // label alphabet rejects. The name still identifies a bibliography entry,
  // so resolution may proceed on named-destination geometry alone; without
  // geometry evidence the destination stays unsupported.
  if (/^cite\.[^\u0000-\u0020\u007f]{1,192}$/u.test(destination)) {
    return 'reference'
  }
  return null
}

function validTargetSourceBox(box: NormalizedSourceBox) {
  return (
    Number.isInteger(box.page) &&
    box.page > 0 &&
    finite(box.x) &&
    finite(box.y) &&
    finite(box.width) &&
    finite(box.height) &&
    finite(box.rotation) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= 1.00002 &&
    box.y + box.height <= 1.00002
  )
}

function axisDistance(value: number | null, start: number, size: number) {
  if (value === null) return 0
  return Math.max(start - value, value - (start + size), 0)
}

function pointToBoxDistance(
  point: NonNullable<PdfInternalDestinationEvidence['point']>,
  box: NormalizedSourceBox,
) {
  return Math.hypot(
    axisDistance(point.x, box.x, box.width),
    axisDistance(point.y, box.y, box.height),
  )
}

function boxToBoxDistance(
  destination: Pick<NormalizedSourceBox, 'x' | 'y' | 'width' | 'height'>,
  target: NormalizedSourceBox,
) {
  return Math.hypot(
    Math.max(
      destination.x - (target.x + target.width),
      target.x - (destination.x + destination.width),
      0,
    ),
    Math.max(
      destination.y - (target.y + target.height),
      target.y - (destination.y + destination.height),
      0,
    ),
  )
}

function validDestinationPoint(evidence: PdfInternalDestinationEvidence) {
  const point = evidence.point
  return Boolean(
    point &&
    point.method === 'pdf-destination' &&
    point.page === evidence.page &&
    finite(point.rotation) &&
    [point.x, point.y].every(
      (coordinate) =>
        coordinate === null ||
        (finite(coordinate) && coordinate >= 0 && coordinate <= 1),
    ) &&
    (point.x !== null || point.y !== null),
  )
}

function validDestinationBox(evidence: PdfInternalDestinationEvidence) {
  const box = evidence.box
  return Boolean(
    box &&
    box.method === 'pdf-destination' &&
    box.page === evidence.page &&
    Number.isInteger(box.page) &&
    box.page > 0 &&
    finite(box.rotation) &&
    [box.x, box.y, box.width, box.height].every(finite) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= 1.00002 &&
    box.y + box.height <= 1.00002,
  )
}

function geometryBackedInternalDestination(
  annotation: PdfInternalLinkAnnotation,
  canonicalTargets: readonly PdfCanonicalInternalLinkTarget[],
): PdfInternalDestinationResolution | null {
  const evidence = annotation.destinationEvidence
  if (
    !evidence ||
    evidence.source !== 'pdfjs-named-destination' ||
    evidence.destination !== annotation.destination ||
    !Number.isInteger(evidence.page) ||
    evidence.page < 1
  ) {
    return null
  }
  const point = validDestinationPoint(evidence) ? evidence.point : null
  const destinationBox = validDestinationBox(evidence) ? evidence.box : null
  if (!point && !destinationBox) return null
  const parsed = parsedPdfInternalDestination(annotation.destination)
  const kind = destinationGeometryKind(annotation.destination, parsed)
  if (!kind) return null
  const compatibleTargets = canonicalTargets.filter(
    (target) =>
      target.kind === kind &&
      SAFE_CANONICAL_FRAGMENT_ID.test(target.nodeId) &&
      (target.sourceBoxes ?? []).some(validTargetSourceBox),
  )
  if (compatibleTargets.length === 0) return null

  const distancesByNodeId = new Map<string, number>()
  for (const target of compatibleTargets) {
    for (const box of target.sourceBoxes ?? []) {
      if (
        !validTargetSourceBox(box) ||
        box.page !== evidence.page ||
        (point && box.rotation !== point.rotation) ||
        (destinationBox && box.rotation !== destinationBox.rotation)
      ) {
        continue
      }
      const distance = destinationBox
        ? boxToBoxDistance(destinationBox, box)
        : point
          ? pointToBoxDistance(point, box)
          : Number.POSITIVE_INFINITY
      const prior = distancesByNodeId.get(target.nodeId)
      if (prior === undefined || distance < prior) {
        distancesByNodeId.set(target.nodeId, distance)
      }
    }
  }
  const ordered = [...distancesByNodeId]
    .map(([targetNodeId, distance]) => ({ targetNodeId, distance }))
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.targetNodeId.localeCompare(right.targetNodeId),
    )
  const exact = ordered.filter(
    (candidate) => candidate.distance <= PDF_DESTINATION_EXACT_TOLERANCE,
  )
  if (exact.length === 1) {
    return {
      status: 'matched',
      targetNodeId: exact[0].targetNodeId,
      ...(parsed ? { parsed } : {}),
    }
  }
  if (exact.length > 1) {
    return {
      status: 'ambiguous',
      targetNodeId: null,
      ...(parsed ? { parsed } : {}),
    }
  }
  const near = ordered.filter(
    (candidate) => candidate.distance <= PDF_DESTINATION_NEAR_TOLERANCE,
  )
  if (
    near.length >= 1 &&
    (near.length === 1 ||
      near[1].distance - near[0].distance >= PDF_DESTINATION_UNIQUENESS_MARGIN)
  ) {
    return {
      status: 'matched',
      targetNodeId: near[0].targetNodeId,
      ...(parsed ? { parsed } : {}),
    }
  }
  return {
    status: near.length > 1 ? 'ambiguous' : 'missing',
    targetNodeId: null,
    ...(parsed ? { parsed } : {}),
  }
}

export function resolvePdfInternalLinkAnnotation(
  annotation: PdfInternalLinkAnnotation,
  canonicalTargets: readonly PdfCanonicalInternalLinkTarget[],
): PdfInternalDestinationResolution {
  return (
    geometryBackedInternalDestination(annotation, canonicalTargets) ??
    resolvePdfInternalDestination(annotation.destination, canonicalTargets)
  )
}

export function isExternalPdfLinkAnnotation(
  annotation: PdfEmbeddedLink,
): annotation is PdfExternalLinkAnnotation {
  return annotation.status === 'external'
}

export function normalizePdfLinkAnnotations(
  page: number,
  annotations: readonly PdfEmbeddedLink[],
): PdfLinkAnnotation[] {
  return annotations.map((annotation, index) => {
    if (annotation.status !== undefined) return annotation
    const id = `pdf-link-p${String(page).padStart(3, '0')}-a${String(index + 1).padStart(4, '0')}`
    return safePdfExternalLinkTarget(annotation.url)
      ? {
          id,
          page,
          status: 'external',
          url: annotation.url,
          box: annotation.box,
        }
      : {
          id,
          page,
          status: 'unresolved',
          target: annotation.url,
          reason: 'unsafe-external-target',
          box: annotation.box,
        }
  })
}

function stableJsonValue(
  value: unknown,
  seen: Set<object>,
): string | number | boolean | null | unknown[] | Record<string, unknown> {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.map((item) => stableJsonValue(item, seen))
    seen.delete(value)
    return result
  }
  const result = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableJsonValue(item, seen)]),
  )
  seen.delete(value)
  return result
}

function preservedTarget(value: unknown) {
  if (typeof value === 'string') {
    return value.slice(0, MAX_PRESERVED_LINK_TARGET_CHARACTERS)
  }
  try {
    return JSON.stringify(stableJsonValue(value, new Set())).slice(
      0,
      MAX_PRESERVED_LINK_TARGET_CHARACTERS,
    )
  } catch {
    return String(value).slice(0, MAX_PRESERVED_LINK_TARGET_CHARACTERS)
  }
}

function normalizedAnnotationBox({
  page,
  rotation,
  viewportWidth,
  viewportHeight,
  rect,
  convertToViewportRectangle,
}: {
  page: number
  rotation: number
  viewportWidth: number
  viewportHeight: number
  rect: unknown
  convertToViewportRectangle: (rect: number[]) => number[]
}): NormalizedSourceBox | null {
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    !Array.isArray(rect) ||
    rect.length < 4 ||
    !rect.slice(0, 4).every(finite)
  ) {
    return null
  }
  let converted: number[]
  try {
    converted = convertToViewportRectangle(rect.slice(0, 4))
  } catch {
    return null
  }
  if (converted.length < 4 || !converted.slice(0, 4).every(finite)) {
    return null
  }
  const left = clamp(Math.min(converted[0], converted[2]) / viewportWidth)
  const right = clamp(Math.max(converted[0], converted[2]) / viewportWidth)
  const top = clamp(Math.min(converted[1], converted[3]) / viewportHeight)
  const bottom = clamp(Math.max(converted[1], converted[3]) / viewportHeight)
  if (right <= left || bottom <= top) return null
  return {
    page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation,
    method: 'pdf-link',
  }
}

function isPdfLinkAnnotation(value: Record<string, unknown>) {
  return (
    value.subtype === 'Link' ||
    'url' in value ||
    'unsafeUrl' in value ||
    'dest' in value ||
    'action' in value
  )
}

export function extractPdfLinkAnnotations({
  page,
  rotation,
  viewportWidth,
  viewportHeight,
  annotations,
  convertToViewportRectangle,
  resolvedInternalDestinations = new Map(),
}: {
  page: number
  rotation: number
  viewportWidth: number
  viewportHeight: number
  annotations: unknown[]
  convertToViewportRectangle: (rect: number[]) => number[]
  resolvedInternalDestinations?: ReadonlyMap<
    string,
    PdfInternalDestinationEvidence
  >
}): PdfLinkAnnotation[] {
  const links: PdfLinkAnnotation[] = []
  for (const [annotationIndex, annotation] of annotations.entries()) {
    if (!annotation || typeof annotation !== 'object') continue
    const value = annotation as Record<string, unknown>
    if (!isPdfLinkAnnotation(value)) continue
    const id = `pdf-link-p${String(page).padStart(3, '0')}-a${String(annotationIndex + 1).padStart(4, '0')}`
    const box = normalizedAnnotationBox({
      page,
      rotation,
      viewportWidth,
      viewportHeight,
      rect: value.rect,
      convertToViewportRectangle,
    })
    const externalTarget =
      typeof value.url === 'string'
        ? value.url
        : typeof value.unsafeUrl === 'string'
          ? value.unsafeUrl
          : null
    const hasInternalDestination =
      ('dest' in value && value.dest !== null && value.dest !== undefined) ||
      (typeof value.action === 'string' && value.action.length > 0)
    const internalDestination =
      'dest' in value && value.dest !== null && value.dest !== undefined
        ? preservedTarget(value.dest)
        : typeof value.action === 'string'
          ? `action:${value.action}`
          : null
    const target = externalTarget ?? internalDestination

    if (!box) {
      links.push({
        id,
        page,
        status: 'unresolved',
        target,
        reason: 'invalid-geometry',
        box: null,
      })
      continue
    }
    if (externalTarget !== null && hasInternalDestination) {
      links.push({
        id,
        page,
        status: 'unresolved',
        target: `${externalTarget} | ${internalDestination}`,
        reason: 'conflicting-targets',
        box,
      })
      continue
    }
    if (externalTarget !== null) {
      links.push(
        safePdfExternalLinkTarget(externalTarget)
          ? {
              id,
              page,
              status: 'external',
              url: externalTarget,
              box,
            }
          : {
              id,
              page,
              status: 'unresolved',
              target: externalTarget,
              reason: 'unsafe-external-target',
              box,
            },
      )
      continue
    }
    if (hasInternalDestination && internalDestination !== null) {
      const destinationEvidence =
        resolvedInternalDestinations.get(internalDestination)
      links.push({
        id,
        page,
        status: 'internal',
        destination: internalDestination,
        ...(destinationEvidence?.destination === internalDestination
          ? { destinationEvidence }
          : {}),
        box,
      })
      continue
    }
    links.push({
      id,
      page,
      status: 'unresolved',
      target: null,
      reason: 'missing-target',
      box,
    })
  }
  return links
}
