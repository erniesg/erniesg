export type PdfCitationSurface = {
  identities: string[]
  links: Array<{
    start: number
    end: number
    identityIndex: number
  }>
}

const MAX_CITATION_RANGE_TARGETS = 32
const CITATION_RANGE_CONNECTOR = /^\s*([-\u2013\u2014])\s*/u
const CITATION_LIST_CONNECTOR = /^(?:\s*[,;]\s*|\s+(?:and|or)\s+)/iu

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

function parsedCitationIdentifier(value: string, start: number, end: number) {
  const match = value.slice(start, end).match(/^(\d{1,9})(?!\d)/u)
  if (!match) return null
  const parsed = Number(match[1])
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null
  return {
    identifier: String(parsed),
    start,
    end: start + match[1].length,
    consumedEnd: start + match[1].length,
  }
}

export function parsePdfCitationSurface(
  value: string,
): PdfCitationSurface | null {
  let bounds = trimmedBounds(value)
  bounds =
    value[bounds.start] === '['
      ? innerPairedExpression(value, bounds.start, bounds.end, '[', ']')
      : value[bounds.start] === '('
        ? innerPairedExpression(value, bounds.start, bounds.end, '(', ')')
        : bounds
  const expressionBounds = trimmedBounds(value, bounds.start, bounds.end)
  const identities: string[] = []
  const links: PdfCitationSurface['links'] = []
  let cursor = expressionBounds.start
  while (cursor < expressionBounds.end) {
    const first = parsedCitationIdentifier(value, cursor, expressionBounds.end)
    if (!first) return null
    const identityIndex = identities.length
    let groupIdentities = [first.identifier]
    let consumedEnd = first.consumedEnd
    let last: ReturnType<typeof parsedCitationIdentifier> = null
    const rangeConnector = value
      .slice(consumedEnd, expressionBounds.end)
      .match(CITATION_RANGE_CONNECTOR)
    if (rangeConnector) {
      const lastStart = consumedEnd + rangeConnector[0].length
      last = parsedCitationIdentifier(value, lastStart, expressionBounds.end)
      if (!last) return null
      const start = Number(first.identifier)
      const finish = Number(last.identifier)
      const count = finish - start + 1
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(finish) ||
        count < 2 ||
        count > MAX_CITATION_RANGE_TARGETS
      ) {
        return null
      }
      groupIdentities = Array.from({ length: count }, (_, index) =>
        String(start + index),
      )
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
    const remaining = trimmedBounds(value, consumedEnd, expressionBounds.end)
    if (remaining.start === expressionBounds.end) break
    const connector = value
      .slice(consumedEnd, expressionBounds.end)
      .match(CITATION_LIST_CONNECTOR)
    if (!connector) return null
    cursor = trimmedBounds(
      value,
      consumedEnd + connector[0].length,
      expressionBounds.end,
    ).start
    if (cursor >= expressionBounds.end) return null
  }
  return identities.length > 0 && new Set(identities).size === identities.length
    ? { identities, links }
    : null
}
