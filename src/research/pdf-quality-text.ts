export function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

export function normalizedText(value: string) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

export function meaningPreservingText(value: string) {
  return value
    .normalize('NFC')
    .replace(/\u00ad/gu, '')
    .replace(/(?<=\p{N}[-–—])\s+(?=\p{N})/gu, '')
    .replace(/\b((?:18|19|20)\d)\s+(?=\d(?:[.,;:)]|$))/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
}

function sourceSemanticFlowBoundaryKey(
  fromRegionId: string,
  toRegionId: string,
) {
  return `${fromRegionId}\u0000${toRegionId}`
}

export function sourceProvenBoundaryTokenText(
  values: readonly string[],
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
  regions: readonly PdfPageRegion[] = [],
  sourceSemanticFlowBoundaryLedger?: SourceSemanticFlowBoundaryLedgerAudit,
  requireCrossPageDecision = false,
) {
  let combined = values[0] ?? ''
  for (const [offset, value] of values.slice(1).entries()) {
    const boundaryIndex = offset + 1
    const semanticFlowDecision =
      regions[boundaryIndex - 1] && regions[boundaryIndex]
        ? sourceSemanticFlowBoundaryLedger?.decisionsByBoundary.get(
            sourceSemanticFlowBoundaryKey(
              regions[boundaryIndex - 1].id,
              regions[boundaryIndex].id,
            ),
          )
        : null
    if (
      sourceSemanticFlowBoundaryLedger &&
      requireCrossPageDecision &&
      regions[boundaryIndex - 1]?.page !== regions[boundaryIndex]?.page &&
      !semanticFlowDecision
    ) {
      sourceSemanticFlowBoundaryLedger.valid = false
    }
    if (semanticFlowDecision && sourceSemanticFlowBoundaryLedger) {
      const consumed =
        (sourceSemanticFlowBoundaryLedger.consumptionById.get(
          semanticFlowDecision.id,
        ) ?? 0) + 1
      sourceSemanticFlowBoundaryLedger.consumptionById.set(
        semanticFlowDecision.id,
        consumed,
      )
      if (consumed > 1) sourceSemanticFlowBoundaryLedger.valid = false
    }
    if (semanticFlowDecision?.outcome === 'no-space') {
      combined = `${combined.trimEnd()}${value.trimStart()}`
      continue
    }
    if (
      semanticFlowDecision?.outcome === 'discretionary-hyphen-delete' &&
      /[-‐‑\u00ad]$/u.test(combined.trimEnd())
    ) {
      combined = `${combined.trimEnd().slice(0, -1)}${value.trimStart()}`
      continue
    }
    if (
      semanticFlowDecision?.outcome === 'hard-hyphen-retain' &&
      /[-‐‑]$/u.test(combined.trimEnd())
    ) {
      combined = `${combined.trimEnd()}${value.trimStart()}`
      continue
    }
    const suppliedBoundaryCandidates =
      regions[boundaryIndex - 1] && regions[boundaryIndex]
        ? sourceSemanticFlowBoundaryLedger?.decisionsByBoundary.has(
            sourceSemanticFlowBoundaryKey(
              regions[boundaryIndex - 1].id,
              regions[boundaryIndex].id,
            ),
          )
        : false
    if (suppliedBoundaryCandidates) {
      combined = `${combined.trimEnd()} ${value.trimStart()}`
      continue
    }
    const urlContinuation =
      /(?:https?:\/\/|www\.)[^\s<>"'`]*[./?=&_%+-]$/iu.test(
        combined.trimEnd(),
      ) && /^[^\s<>"'`]/u.test(value.trimStart())
    if (urlContinuation) {
      combined = `${combined.trimEnd()}${value.trimStart()}`
      continue
    }
    const left = combined.match(/([\p{L}\p{N}]+)[-‐‑]\s*$/u)
    const right = value.match(/^\s*([\p{L}\p{N}]+)/u)
    if (!left || !right) {
      combined = `${combined} ${value}`
      continue
    }
    const proof = resolvePdfHyphenBoundary({
      left: left[1],
      right: right[1],
      language,
      sourceProven: true,
      hardHyphenLexicon,
      unhyphenatedLexicon,
    })
    if (proof.verdict === 'remove') {
      combined = `${combined.trimEnd().slice(0, -1)}${value.trimStart()}`
    } else {
      combined = `${combined.trimEnd()}${value.trimStart()}`
    }
  }
  return combined
}

export function characterCount(value: string) {
  return [...value].length
}

function smallLongestCommonSubsequence(source: string[], output: string[]) {
  const previous = new Uint32Array(output.length + 1)
  const current = new Uint32Array(output.length + 1)
  for (const sourceCharacter of source) {
    current[0] = 0
    for (let outputIndex = 1; outputIndex <= output.length; outputIndex += 1) {
      current[outputIndex] =
        sourceCharacter === output[outputIndex - 1]
          ? previous[outputIndex - 1] + 1
          : Math.max(previous[outputIndex], current[outputIndex - 1])
    }
    previous.set(current)
  }
  return previous[output.length]
}

function isSubsequence(candidate: string[], value: string[]) {
  let candidateIndex = 0
  for (const character of value) {
    if (character === candidate[candidateIndex]) candidateIndex += 1
    if (candidateIndex === candidate.length) return true
  }
  return candidate.length === 0
}

function bigintPopulationCount(value: bigint) {
  let remaining = value
  let count = 0
  const mask = 0xffff_ffffn
  while (remaining > 0n) {
    let chunk = Number(remaining & mask) >>> 0
    chunk -= (chunk >>> 1) & 0x5555_5555
    chunk = (chunk & 0x3333_3333) + ((chunk >>> 2) & 0x3333_3333)
    count += (((chunk + (chunk >>> 4)) & 0x0f0f_0f0f) * 0x0101_0101) >>> 24
    remaining >>= 32n
  }
  return count
}

function bitsetLongestCommonSubsequence(source: string[], output: string[]) {
  const columns = source.length <= output.length ? source : output
  const rows = source.length <= output.length ? output : source
  const matchesByCharacter = new Map<string, bigint>()
  for (const [index, character] of columns.entries()) {
    matchesByCharacter.set(
      character,
      (matchesByCharacter.get(character) ?? 0n) | (1n << BigInt(index)),
    )
  }
  let state = 0n
  for (const character of rows) {
    const matches = matchesByCharacter.get(character) ?? 0n
    const available = matches | state
    state = available & ~(available - ((state << 1n) | 1n))
  }
  return bigintPopulationCount(state)
}

export function orderedMatchedCharacters(source: string, output: string) {
  if (source === output) return characterCount(source)
  const sourceCharacters = [...source]
  const outputCharacters = [...output]
  let prefixLength = 0
  while (
    prefixLength < sourceCharacters.length &&
    prefixLength < outputCharacters.length &&
    sourceCharacters[prefixLength] === outputCharacters[prefixLength]
  ) {
    prefixLength += 1
  }
  let sourceEnd = sourceCharacters.length
  let outputEnd = outputCharacters.length
  while (
    sourceEnd > prefixLength &&
    outputEnd > prefixLength &&
    sourceCharacters[sourceEnd - 1] === outputCharacters[outputEnd - 1]
  ) {
    sourceEnd -= 1
    outputEnd -= 1
  }
  const suffixLength = sourceCharacters.length - sourceEnd
  const sourceMiddle = sourceCharacters.slice(prefixLength, sourceEnd)
  const outputMiddle = outputCharacters.slice(prefixLength, outputEnd)
  const shorter =
    sourceMiddle.length <= outputMiddle.length ? sourceMiddle : outputMiddle
  const longer =
    sourceMiddle.length <= outputMiddle.length ? outputMiddle : sourceMiddle
  const middleMatch = isSubsequence(shorter, longer)
    ? shorter.length
    : sourceMiddle.length * outputMiddle.length <= 1_000_000
      ? smallLongestCommonSubsequence(sourceMiddle, outputMiddle)
      : bitsetLongestCommonSubsequence(sourceMiddle, outputMiddle)
  return prefixLength + middleMatch + suffixLength
}

export function occurrenceBoundedMatchedCharacters(
  source: string,
  output: string,
) {
  const remaining = new Map<string, number>()
  for (const character of output) {
    remaining.set(character, (remaining.get(character) ?? 0) + 1)
  }
  let matched = 0
  for (const character of source) {
    const count = remaining.get(character) ?? 0
    if (count === 0) continue
    remaining.set(character, count - 1)
    matched += 1
  }
  return matched
}
import type {
  PdfPageRegion,
  PdfSourceSemanticFlowBoundaryDecision,
} from './import-types'
import { resolvePdfHyphenBoundary } from './pdf-hyphenation'

export type SourceSemanticFlowBoundaryLedgerAudit = {
  valid: boolean
  decisionsByBoundary: Map<string, PdfSourceSemanticFlowBoundaryDecision>
  consumptionById: Map<string, number>
}
