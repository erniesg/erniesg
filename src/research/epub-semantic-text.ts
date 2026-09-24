import { XMLValidator } from 'fast-xml-parser'
import { parsePdfCitationSurface } from './pdf-citation-surface'
import { expandPdfScholarlyVisualIdentifierRange } from './pdf-scholarly-label'
import { sanitizeXmlText } from './publication-integrity'

function cleanXml(value: string) {
  return sanitizeXmlText(value)
}

export function text(value: string) {
  return cleanXml(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function attribute(value: string) {
  return text(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function stableId(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, '-')
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n-${cleaned}`
}

export function comparableText(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

export function validNoteReferences<
  Reference extends {
    id: string
    target: string
    start: number
    end: number
  },
>(value: string, references?: Reference[]) {
  return (references ?? []).filter(
    (reference) =>
      reference.start >= 0 &&
      reference.start < reference.end &&
      reference.end <= value.length,
  )
}

export type ScholarlyTargetKind = 'figure' | 'table' | 'equation' | 'section'

export type ScholarlyTarget = {
  kind: ScholarlyTargetKind
  identifier?: string
}

export type CanonicalSemanticTarget =
  ScholarlyTarget | { kind: 'citation'; identifier: string }

type VisibleTextRange = {
  start: number
  end: number
}

type ParsedSurfaceIdentifier = VisibleTextRange & {
  consumedEnd: number
  identifier: string
}

type ParsedSemanticSurface = {
  identities: string[]
  links: Array<VisibleTextRange & { identityIndex: number }>
  kind?: ScholarlyTargetKind
}

const MAX_SEMANTIC_RANGE_TARGETS = 32
const CANONICAL_UPPER_ROMAN_IDENTIFIER = String.raw`(?=[IVXLCDM])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})`
export const INLINE_SCHOLARLY_IDENTIFIER = String.raw`(?:\([A-Za-z]?\d+(?:\.\d+)*(?:[A-Za-z])?\)|\(${CANONICAL_UPPER_ROMAN_IDENTIFIER}\)|[A-Za-z](?:\.\d+)*|[A-Za-z]?\d+(?:\.\d+)*(?:[A-Za-z])?|${CANONICAL_UPPER_ROMAN_IDENTIFIER})`
const CROSS_REFERENCE_IDENTIFIER_AT_START = new RegExp(
  String.raw`^(?:[A-Za-z](?:[.-]\d+)+|[A-Za-z]?\d+(?:\.\d+)*(?:[A-Za-z])?|${CANONICAL_UPPER_ROMAN_IDENTIFIER}|[A-Za-z](?:\.\d+)*)`,
  'u',
)
const SEMANTIC_RANGE_CONNECTOR = /^\s*([-\u2013\u2014])\s*/u
const SEMANTIC_LIST_CONNECTOR = /^(?:\s*[,;]\s*|\s+(?:and|or)\s+)/iu

function explicitScholarlyIdentifierRanges(
  value: string,
  semanticRole: 'citation' | 'cross-reference',
) {
  const prefix =
    semanticRole === 'cross-reference'
      ? (value.match(
          /^(?:fig(?:ure)?s?|tables?|sections?|secs?|appendix|appendices|eq(?:uation)?s?)\.?\s+/iu,
        )?.[0].length ?? 0)
      : 0
  const ranges: VisibleTextRange[] = []
  const identifierPattern = new RegExp(
    String.raw`(^|[^\p{L}\p{N}])(${INLINE_SCHOLARLY_IDENTIFIER})(?![\p{L}\p{N}])`,
    'gu',
  )
  for (const match of value.slice(prefix).matchAll(identifierPattern)) {
    const start = prefix + (match.index ?? 0) + match[1].length
    ranges.push({ start, end: start + match[2].length })
  }
  return ranges
}

function trimmedBounds(value: string, start = 0, end = value.length) {
  while (start < end && /\s/u.test(value[start])) start += 1
  while (end > start && /\s/u.test(value[end - 1])) end -= 1
  return { start, end }
}

function innerPairedExpression(
  value: string,
  start: number,
  end: number,
  open: '[' | '(',
  close: ']' | ')',
) {
  const trimmed = trimmedBounds(value, start, end)
  if (value[trimmed.start] !== open) return trimmed
  let depth = 0
  for (let index = trimmed.start; index < trimmed.end; index += 1) {
    if (value[index] === open) depth += 1
    if (value[index] !== close) continue
    depth -= 1
    if (depth === 0) {
      return index === trimmed.end - 1
        ? trimmedBounds(value, trimmed.start + 1, index)
        : trimmed
    }
  }
  return trimmed
}

export function normalizedNumericIdentity(value: string) {
  if (!/^\d{1,9}$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? String(parsed) : null
}

export function normalizedCrossReferenceIdentity(value: string) {
  if (
    new RegExp(String.raw`^${CANONICAL_UPPER_ROMAN_IDENTIFIER}$`, 'u').test(
      value,
    )
  ) {
    return value
  }
  if (
    !/^(?:[A-Za-z](?:[.-]\d+)+|[A-Za-z]?\d+(?:\.\d+)*(?:[A-Za-z])?|[A-Za-z](?:\.\d+)*)$/u.test(
      value,
    )
  ) {
    return null
  }
  return /^[A-Za-z]/u.test(value)
    ? `${value[0].toUpperCase()}${value.slice(1)}`
    : value
}

function parsedCrossReferenceIdentifier(
  value: string,
  start: number,
  end: number,
): ParsedSurfaceIdentifier | null {
  let tokenStart = start
  let parenthesized = false
  if (value[tokenStart] === '(') {
    parenthesized = true
    tokenStart = trimmedBounds(value, tokenStart + 1, end).start
  }
  const match = value
    .slice(tokenStart, end)
    .match(CROSS_REFERENCE_IDENTIFIER_AT_START)
  if (!match) return null
  const tokenEnd = tokenStart + match[0].length
  if (/[\p{L}\p{N}.]/u.test(value[tokenEnd] ?? '')) return null
  const identifier = normalizedCrossReferenceIdentity(match[0])
  if (!identifier) return null
  let consumedEnd = tokenEnd
  if (parenthesized) {
    consumedEnd = trimmedBounds(value, tokenEnd, end).start
    if (value[consumedEnd] !== ')') return null
    consumedEnd += 1
  }
  return {
    identifier,
    start: tokenStart,
    end: tokenEnd,
    consumedEnd,
  }
}

function parseDelimitedSemanticExpression({
  value,
  start,
  end,
  parseIdentifier,
  expandRange,
}: {
  value: string
  start: number
  end: number
  parseIdentifier: (
    value: string,
    start: number,
    end: number,
  ) => ParsedSurfaceIdentifier | null
  expandRange: (first: string, last: string) => string[] | null
}): Omit<ParsedSemanticSurface, 'kind'> | null {
  const bounds = trimmedBounds(value, start, end)
  const identities: string[] = []
  const links: Array<VisibleTextRange & { identityIndex: number }> = []
  let cursor = bounds.start
  while (cursor < bounds.end) {
    const first = parseIdentifier(value, cursor, bounds.end)
    if (!first) return null
    const identityIndex = identities.length
    let groupIdentities = [first.identifier]
    let consumedEnd = first.consumedEnd
    let last: ParsedSurfaceIdentifier | null = null
    const rangeConnector = value
      .slice(consumedEnd, bounds.end)
      .match(SEMANTIC_RANGE_CONNECTOR)
    if (rangeConnector) {
      const lastStart = consumedEnd + rangeConnector[0].length
      last = parseIdentifier(value, lastStart, bounds.end)
      if (!last) return null
      groupIdentities = expandRange(first.identifier, last.identifier) ?? []
      if (
        groupIdentities.length < 2 ||
        groupIdentities.length > MAX_SEMANTIC_RANGE_TARGETS
      ) {
        return null
      }
      consumedEnd = last.consumedEnd
    }
    identities.push(...groupIdentities)
    links.push({ start: first.start, end: first.end, identityIndex })
    if (last) {
      links.push({
        start: last.start,
        end: last.end,
        identityIndex: identityIndex + groupIdentities.length - 1,
      })
    }
    const remaining = trimmedBounds(value, consumedEnd, bounds.end)
    if (remaining.start === bounds.end) break
    const connector = value
      .slice(consumedEnd, bounds.end)
      .match(SEMANTIC_LIST_CONNECTOR)
    if (!connector) return null
    cursor = trimmedBounds(
      value,
      consumedEnd + connector[0].length,
      bounds.end,
    ).start
    if (cursor >= bounds.end) return null
  }
  return identities.length > 0 && new Set(identities).size === identities.length
    ? { identities, links }
    : null
}

function crossReferencePrefix(value: string) {
  const trimmed = trimmedBounds(value)
  if (value[trimmed.start] === '§') {
    const match = value.slice(trimmed.start).match(/^§\s*/u)
    return match
      ? {
          kind: 'section' as const,
          expressionStart: trimmed.start + match[0].length,
          expressionEnd: trimmed.end,
        }
      : null
  }
  const match = value
    .slice(trimmed.start)
    .match(
      /^(fig(?:ure)?s?|tables?|sections?|secs?|appendix|appendices|eq(?:uation)?s?)\.?\s+/iu,
    )
  if (!match) return null
  const prefix = match[1].toLocaleLowerCase()
  return {
    kind: (prefix.startsWith('fig')
      ? 'figure'
      : prefix.startsWith('table')
        ? 'table'
        : prefix.startsWith('eq')
          ? 'equation'
          : 'section') as ScholarlyTargetKind,
    expressionStart: trimmed.start + match[0].length,
    expressionEnd: trimmed.end,
  }
}

function parseCrossReferenceSurface(
  value: string,
): ParsedSemanticSurface | null {
  const prefix = crossReferencePrefix(value)
  if (!prefix) return null
  const bounds = innerPairedExpression(
    value,
    prefix.expressionStart,
    prefix.expressionEnd,
    '(',
    ')',
  )
  const parsed = parseDelimitedSemanticExpression({
    value,
    ...bounds,
    parseIdentifier: parsedCrossReferenceIdentifier,
    expandRange: (first, last) => {
      const expanded = expandPdfScholarlyVisualIdentifierRange(first, last)
      if (!expanded) return null
      const normalized = expanded.map(normalizedCrossReferenceIdentity)
      return normalized.every(
        (identifier): identifier is string => identifier !== null,
      )
        ? normalized
        : null
    },
  })
  return parsed ? { ...parsed, kind: prefix.kind } : null
}

function targetRangesForSemanticGroup(
  value: string,
  semanticRole: 'citation' | 'cross-reference',
  targets: readonly string[],
  canonicalTargets: ReadonlyMap<string, CanonicalSemanticTarget>,
) {
  if (new Set(targets).size !== targets.length) return null
  const evidence = targets.map((target) => canonicalTargets.get(target))
  if (evidence.some((target) => !target?.identifier)) return null
  if (
    semanticRole === 'citation'
      ? evidence.some((target) => target?.kind !== 'citation')
      : evidence.some((target) => target?.kind === 'citation')
  ) {
    return null
  }
  const parsed =
    semanticRole === 'citation'
      ? parsePdfCitationSurface(value)
      : parseCrossReferenceSurface(value)
  if (!parsed) return null
  if (
    semanticRole === 'cross-reference' &&
    (!('kind' in parsed) ||
      evidence.some(
        (target) => target?.kind === 'citation' || target?.kind !== parsed.kind,
      ))
  ) {
    return null
  }
  const targetIdentities = evidence.map((target) => target!.identifier!)
  if (
    targetIdentities.length !== parsed.identities.length ||
    new Set(targetIdentities).size !== targetIdentities.length ||
    targetIdentities.some(
      (identifier, index) => identifier !== parsed.identities[index],
    )
  ) {
    return null
  }
  return parsed.links.map((range) => ({
    start: range.start,
    end: range.end,
    target: targets[range.identityIndex],
  }))
}

function inlineHtmlVisibleBoundaries(html: string, value: string) {
  const starts = new Map<number, number>()
  const ends = new Map<number, number>()
  let htmlIndex = 0
  let visibleIndex = 0
  while (htmlIndex < html.length) {
    if (html[htmlIndex] === '<') {
      const tagEnd = html.indexOf('>', htmlIndex + 1)
      if (tagEnd < 0) return null
      htmlIndex = tagEnd + 1
      continue
    }
    let decoded = html[htmlIndex]
    let tokenEnd = htmlIndex + 1
    if (html[htmlIndex] === '&') {
      const entityEnd = html.indexOf(';', htmlIndex + 1)
      if (entityEnd < 0) return null
      const entity = html.slice(htmlIndex, entityEnd + 1)
      decoded =
        entity === '&amp;'
          ? '&'
          : entity === '&lt;'
            ? '<'
            : entity === '&gt;'
              ? '>'
              : ''
      if (!decoded) return null
      tokenEnd = entityEnd + 1
    }
    if (!value.startsWith(decoded, visibleIndex)) return null
    starts.set(visibleIndex, htmlIndex)
    visibleIndex += decoded.length
    ends.set(visibleIndex, tokenEnd)
    htmlIndex = tokenEnd
  }
  return visibleIndex === value.length ? { starts, ends } : null
}

function injectInlineLinks({
  html,
  value,
  ranges,
  semanticRole,
  annotationId,
}: {
  html: string
  value: string
  ranges: Array<VisibleTextRange & { target: string }>
  semanticRole?: 'citation' | 'cross-reference'
  annotationId?: string
}) {
  const boundaries = inlineHtmlVisibleBoundaries(html, value)
  if (!boundaries) return null
  const ordered = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )
  if (
    ordered.some(
      (range, index) =>
        range.start < 0 ||
        range.start >= range.end ||
        range.end > value.length ||
        (index > 0 && range.start < ordered[index - 1].end),
    )
  ) {
    return null
  }
  let linked = html
  for (const range of [...ordered].reverse()) {
    const start = boundaries.starts.get(range.start)
    const end = boundaries.ends.get(range.end)
    if (start === undefined || end === undefined) return null
    const attributes = [
      `href="#${attribute(stableId(range.target))}"`,
      ...(semanticRole === 'citation'
        ? ['epub:type="biblioref"', 'role="doc-biblioref"']
        : []),
      ...(annotationId
        ? [`data-source-annotation-id="${attribute(stableId(annotationId))}"`]
        : []),
    ].join(' ')
    linked = `${linked.slice(0, start)}<a ${attributes}>${linked.slice(start, end)}</a>${linked.slice(end)}`
  }
  return XMLValidator.validate(
    `<root xmlns:epub="http://www.idpf.org/2007/ops">${linked}</root>`,
  ) === true
    ? linked
    : null
}

export function scholarlyReferenceCandidateRanges(
  value: string,
  kind: ScholarlyTargetKind,
) {
  const prefix =
    kind === 'figure'
      ? String.raw`[Ff][Ii][Gg](?:[Uu][Rr][Ee])?[Ss]?`
      : kind === 'table'
        ? String.raw`[Tt][Aa][Bb][Ll][Ee][Ss]?`
        : kind === 'equation'
          ? String.raw`[Ee][Qq](?:[Uu][Aa][Tt][Ii][Oo][Nn])?[Ss]?`
          : String.raw`(?:[Ss][Ee][Cc][Tt][Ii][Oo][Nn][Ss]?|[Ss][Ee][Cc][Ss]?|[Aa][Pp][Pp][Ee][Nn][Dd][Ii][Xx]|[Aa][Pp][Pp][Ee][Nn][Dd][Ii][Cc][Ee][Ss])`
  const candidates: VisibleTextRange[] = []
  const explicit = new RegExp(
    String.raw`\b${prefix}\.?\s+${INLINE_SCHOLARLY_IDENTIFIER}(?:(?:\s*(?:[,;]|\b(?:[Aa][Nn][Dd]|[Oo][Rr])\b|[\u2013\u2014-])\s*)${INLINE_SCHOLARLY_IDENTIFIER})*(?![\p{L}\p{N}])`,
    'gu',
  )
  for (const match of value.matchAll(explicit)) {
    candidates.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    })
  }
  if (kind === 'section') {
    for (const match of value.matchAll(
      new RegExp(
        String.raw`§\s*${INLINE_SCHOLARLY_IDENTIFIER}(?![\p{L}\p{N}])`,
        'gu',
      ),
    )) {
      candidates.push({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      })
    }
  }
  if (kind === 'equation' || kind === 'section') {
    for (const match of value.matchAll(
      /\([A-Z]?\d+(?:\.\d+)*(?:[A-Za-z])?\)/gu,
    )) {
      candidates.push({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      })
    }
  }
  const maximal = candidates.filter(
    (candidate, index) =>
      !candidates.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.start <= candidate.start &&
          other.end >= candidate.end &&
          other.end - other.start > candidate.end - candidate.start,
      ),
  )
  return maximal.filter(
    (candidate, index) =>
      maximal.findIndex(
        (other) =>
          other.start === candidate.start && other.end === candidate.end,
      ) === index,
  )
}

function scholarlyReferenceRangesForTarget(
  value: string,
  target: ScholarlyTarget,
) {
  const candidates = scholarlyReferenceCandidateRanges(value, target.kind)
  if (!target.identifier) return candidates
  const escapedIdentifier = target.identifier.replace(
    /[.*+?^${}()|[\]\\]/gu,
    '\\$&',
  )
  const identifiers: VisibleTextRange[] = []
  for (const match of value.matchAll(
    new RegExp(String.raw`\(${escapedIdentifier}\)`, 'gu'),
  )) {
    identifiers.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    })
  }
  for (const match of value.matchAll(
    new RegExp(
      String.raw`(^|[^\p{L}\p{N}.])(${escapedIdentifier})(?![\p{L}\p{N}]|\.\d)`,
      'gu',
    ),
  )) {
    const start = (match.index ?? 0) + match[1].length
    identifiers.push({ start, end: start + match[2].length })
  }
  const maximalIdentifiers = identifiers.filter(
    (identifier, index) =>
      !identifiers.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.start <= identifier.start &&
          other.end >= identifier.end &&
          other.end - other.start > identifier.end - identifier.start,
      ),
  )
  if (maximalIdentifiers.length !== 1) return []
  const identifier = maximalIdentifiers[0]
  const containingCandidates = candidates.filter(
    (candidate) =>
      candidate.start <= identifier.start && candidate.end >= identifier.end,
  )
  if (containingCandidates.length === 1) {
    const candidate = containingCandidates[0]
    const candidateValue = value.slice(candidate.start, candidate.end)
    if (
      explicitScholarlyIdentifierRanges(candidateValue, 'cross-reference')
        .length === 1
    ) {
      return [candidate]
    }
  }
  return [identifier]
}

export function renderTextWithNoteReferences(
  value: string,
  references?: Array<{
    id: string
    target: string
    start: number
    end: number
  }>,
  inlineRuns?: Array<{
    start: number
    end: number
    bold?: boolean
    italic?: boolean
    href?: string
    annotationId?: string
    verticalAlign?: 'superscript' | 'subscript'
    compactMathAtom?: boolean
    relationshipId?: string
    semanticRole?:
      | 'citation'
      | 'cross-reference'
      | 'note-reference'
      | 'affiliation-marker'
      | 'bibliography-entry'
    targetIds?: string[]
  }>,
  scholarlyTargetKinds: ReadonlyMap<
    string,
    CanonicalSemanticTarget
  > = new Map(),
) {
  if (!references?.length && !inlineRuns?.length) return text(value)
  const validReferences = validNoteReferences(value, references)
  const validRuns = (inlineRuns ?? [])
    .filter(
      (run) => run.start >= 0 && run.start < run.end && run.end <= value.length,
    )
    .flatMap((run) => {
      const fragment = run.href?.match(/^#(.+)$/u)?.[1]
      const target = fragment ? scholarlyTargetKinds.get(fragment) : undefined
      if (
        !run.annotationId ||
        !fragment ||
        !target ||
        target.kind === 'citation'
      ) {
        return [run]
      }
      const runValue = value.slice(run.start, run.end)
      const hasConflictingScholarlyKind =
        scholarlyReferenceCandidateRanges(runValue, target.kind).length === 0 &&
        (['figure', 'table', 'equation', 'section'] as const).some(
          (kind) =>
            kind !== target.kind &&
            scholarlyReferenceCandidateRanges(runValue, kind).length > 0,
        )
      if (hasConflictingScholarlyKind) return []
      const candidates = scholarlyReferenceRangesForTarget(runValue, target)
      return candidates.length === 1
        ? [
            {
              ...run,
              start: run.start + candidates[0].start,
              end: run.start + candidates[0].end,
            },
          ]
        : [run]
    })
  const boundaries = [
    0,
    value.length,
    ...validReferences.flatMap((reference) => [reference.start, reference.end]),
    ...validRuns.flatMap((run) => [run.start, run.end]),
  ]
  const points = [...new Set(boundaries)].sort((left, right) => left - right)
  type Wrapper =
    | { kind: 'note'; id: string; target: string }
    | { kind: 'hyperlink'; href: string; annotationId?: string }
    | {
        kind: 'semantic'
        relationshipId: string
        semanticRole: NonNullable<
          NonNullable<typeof inlineRuns>[number]['semanticRole']
        >
        targetIds: string[]
      }
  const segments: Array<{
    html: string
    value: string
    wrapper?: Wrapper
    key: string
  }> = []
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]
    const end = points[index + 1]
    if (start === end) continue
    const segmentValue = value.slice(start, end)
    const activeRuns = validRuns.filter(
      (candidate) => candidate.start <= start && candidate.end >= end,
    )
    const reference = validReferences.find(
      (candidate) => candidate.start <= start && candidate.end >= end,
    )
    const renderedSegmentValue = activeRuns.some((run) => run.compactMathAtom)
      ? segmentValue.replace(/\s+/gu, '')
      : segmentValue
    let segment = text(renderedSegmentValue)
    if (activeRuns.some((run) => run.italic)) segment = `<em>${segment}</em>`
    if (activeRuns.some((run) => run.bold))
      segment = `<strong>${segment}</strong>`
    const verticalAlign = activeRuns.find(
      (run) => run.verticalAlign,
    )?.verticalAlign
    if (verticalAlign === 'superscript') segment = `<sup>${segment}</sup>`
    if (verticalAlign === 'subscript') segment = `<sub>${segment}</sub>`
    const hyperlinkRun = activeRuns.find(
      (run) => run.href && normalizedEpubHref(run.href),
    )
    const hyperlinkHref = hyperlinkRun?.href
      ? normalizedEpubHref(hyperlinkRun.href)
      : null
    const linkableHyperlinkHref = segmentValue.trim() ? hyperlinkHref : null
    const semanticRun = activeRuns.find(
      (run) => run.semanticRole && run.relationshipId,
    )
    if (
      !reference &&
      linkableHyperlinkHref &&
      semanticRun?.semanticRole &&
      semanticRun.relationshipId &&
      (semanticRun.targetIds?.length ?? 0) === 0
    ) {
      const annotation =
        hyperlinkRun?.annotationId && linkableHyperlinkHref.startsWith('#')
          ? ` data-source-annotation-id="${attribute(stableId(hyperlinkRun.annotationId))}"`
          : ''
      segment = `<a href="${attribute(linkableHyperlinkHref)}"${annotation}>${segment}</a>`
    }
    let wrapper: Wrapper | undefined
    if (reference) {
      wrapper = { kind: 'note', id: reference.id, target: reference.target }
    } else if (semanticRun?.semanticRole && semanticRun.relationshipId) {
      wrapper = {
        kind: 'semantic',
        relationshipId: semanticRun.relationshipId,
        semanticRole: semanticRun.semanticRole,
        targetIds: [...(semanticRun.targetIds ?? [])],
      }
    } else if (linkableHyperlinkHref) {
      wrapper = {
        kind: 'hyperlink',
        href: linkableHyperlinkHref,
        ...(hyperlinkRun?.annotationId
          ? { annotationId: hyperlinkRun.annotationId }
          : {}),
      }
    }
    const key = wrapper ? JSON.stringify(wrapper) : ''
    const previous = segments.at(-1)
    if (previous?.key === key) {
      previous.html += segment
      previous.value += segmentValue
    } else {
      segments.push({ html: segment, value: segmentValue, wrapper, key })
    }
  }

  const emittedIds = new Set<string>()
  const idAttribute = (rawId: string) => {
    const id = stableId(rawId)
    if (emittedIds.has(id)) return ''
    emittedIds.add(id)
    return ` id="${attribute(id)}"`
  }
  return segments
    .map(({ html, value: segmentValue, wrapper }) => {
      if (!wrapper) return html
      if (wrapper.kind === 'note') {
        return `<a${idAttribute(wrapper.id)} href="#${attribute(stableId(wrapper.target))}" epub:type="noteref" role="doc-noteref">${html}</a>`
      }
      if (wrapper.kind === 'hyperlink') {
        const target = wrapper.href.match(/^#(.+)$/u)?.[1]
        const scholarlyTarget = target
          ? scholarlyTargetKinds.get(target)
          : undefined
        if (
          wrapper.annotationId &&
          target &&
          scholarlyTarget &&
          scholarlyTarget.kind !== 'citation'
        ) {
          const candidates = scholarlyReferenceRangesForTarget(
            segmentValue,
            scholarlyTarget,
          )
          if (candidates.length === 1) {
            return (
              injectInlineLinks({
                html,
                value: segmentValue,
                ranges: [{ ...candidates[0], target }],
                annotationId: wrapper.annotationId,
              }) ?? html
            )
          }
        }
        const annotation =
          wrapper.annotationId && wrapper.href.startsWith('#')
            ? ` data-source-annotation-id="${attribute(stableId(wrapper.annotationId))}"`
            : ''
        return `<a href="${attribute(wrapper.href)}"${annotation}>${html}</a>`
      }
      const relationshipId = stableId(wrapper.relationshipId)
      const targets = wrapper.targetIds.map(stableId)
      if (wrapper.semanticRole === 'citation' && targets.length > 0) {
        if (targets.length === 1) {
          return `<a${idAttribute(relationshipId)} href="#${attribute(targets[0])}" epub:type="biblioref" role="doc-biblioref" data-semantic-role="citation" data-relationship-id="${attribute(relationshipId)}" data-target-ids="${attribute(targets[0])}">${html}</a>`
        }
        const ranges = targetRangesForSemanticGroup(
          segmentValue,
          'citation',
          targets,
          scholarlyTargetKinds,
        )
        const links =
          ranges &&
          injectInlineLinks({
            html,
            value: segmentValue,
            ranges,
            semanticRole: 'citation',
          })
        if (!links) {
          throw new Error(
            `EPUB_SEMANTIC_LINK_ALIGNMENT: Citation ${relationshipId} has ${targets.length} canonical targets but its visible labels cannot be mapped one-to-one without duplicating text.`,
          )
        }
        const linkedTargets = new Set(ranges.map((range) => range.target))
        const additionalTargets = targets
          .filter((target) => !linkedTargets.has(target))
          .map((target) => {
            const identifier = scholarlyTargetKinds.get(target)?.identifier
            return `<a href="#${attribute(target)}" epub:type="biblioref" role="doc-biblioref" class="additional-biblioref">Additional citation target ${text(identifier ?? target)}</a>`
          })
          .join('')
        return `<span${idAttribute(relationshipId)} data-semantic-role="citation" data-relationship-id="${attribute(relationshipId)}" data-target-ids="${attribute(targets.join(' '))}">${links}${additionalTargets}</span>`
      }
      if (wrapper.semanticRole === 'cross-reference' && targets.length > 0) {
        if (targets.length === 1) {
          return `<a${idAttribute(relationshipId)} href="#${attribute(targets[0])}" data-semantic-role="cross-reference" data-relationship-id="${attribute(relationshipId)}" data-target-ids="${attribute(targets[0])}">${html}</a>`
        }
        const ranges = targetRangesForSemanticGroup(
          segmentValue,
          'cross-reference',
          targets,
          scholarlyTargetKinds,
        )
        const links =
          ranges &&
          injectInlineLinks({
            html,
            value: segmentValue,
            ranges,
            semanticRole: 'cross-reference',
          })
        if (!links) {
          throw new Error(
            `EPUB_SEMANTIC_LINK_ALIGNMENT: Cross-reference ${relationshipId} has ${targets.length} canonical targets but its visible labels cannot be mapped one-to-one without duplicating text.`,
          )
        }
        const linkedTargets = new Set(ranges.map((range) => range.target))
        const additionalTargets = targets
          .filter((target) => !linkedTargets.has(target))
          .map((target) => {
            const identifier = scholarlyTargetKinds.get(target)?.identifier
            return `<a href="#${attribute(target)}" class="additional-cross-reference">Additional cross-reference target ${text(identifier ?? target)}</a>`
          })
          .join('')
        return `<span${idAttribute(relationshipId)} data-semantic-role="cross-reference" data-relationship-id="${attribute(relationshipId)}" data-target-ids="${attribute(targets.join(' '))}">${links}${additionalTargets}</span>`
      }
      return `<span${idAttribute(relationshipId)} data-semantic-role="${attribute(wrapper.semanticRole)}" data-relationship-id="${attribute(relationshipId)}"${targets.length > 0 ? ` data-target-ids="${attribute(targets.join(' '))}"` : ''}>${html}</span>`
    })
    .join('')
}

export function normalizedEpubHref(value: string) {
  // Do not rely on WHATWG URL repair here: EPUBCheck rejects raw backslashes
  // and ASCII whitespace. Preserve valid percent escapes and delimiters while
  // encoding RFC-unwise ASCII code points that EPUBCheck rejects.
  if (/[\u0000-\u0020\u007f\\]/u.test(value)) return null
  if (value.startsWith('#')) return value
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return null
    return parsed.href.replace(
      /[<>"{}|^`]/gu,
      (character) =>
        `%${character.codePointAt(0)!.toString(16).toUpperCase().padStart(2, '0')}`,
    )
  } catch {
    return null
  }
}
