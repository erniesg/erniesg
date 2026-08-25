import type { PdfPageRegion } from './import-types'
import {
  hasUnsupportedSourceMathRomanWord,
  justifiedUprightSourceMathToken,
  knownSourceMathFont,
  knownSourceMathGlyphFont,
  lineHasCompactSourceScriptIdentifier,
  lineHasSourceScriptGeometry,
  sourceMathFontProvenance,
  sourceMathRomanFont,
  unpublishableEquationTranscriptText,
} from './pdf-equation-source-math'
import { proseDominantPdfMathSource } from './pdf-regions'
import { unionBox } from './pdf-visual-source-geometry'
import { boxGap } from './pdf-visual-figure-grouping'

function sourceMathFragmentProseLead(
  text: string,
  runs: readonly PdfPageRegion['lines'][number]['runs'][number][],
) {
  // A body line can contain mostly math-font glyphs while still being a
  // prose instruction whose first word governs the expression that follows
  // (for example, “Consider E[…]”). Such a line must remain canonical text;
  // lending it to a neighboring display creates competing source ownership.
  const visibleRuns = runs.filter((run) => run.text.trim())
  const firstMathGlyphIndex = visibleRuns.findIndex((run) =>
    knownSourceMathGlyphFont(run.fontName),
  )
  if (firstMathGlyphIndex > 0) {
    const leadingRuns = visibleRuns.slice(0, firstMathGlyphIndex)
    if (
      hasUnsupportedSourceMathRomanWord(leadingRuns) ||
      leadingRuns.some(
        (run) =>
          !knownSourceMathFont(run.fontName) && /\p{L}{2,}/u.test(run.text),
      )
    ) {
      return true
    }
  }
  // Retain a lexical fallback for extractors that merge upright prose and
  // the following formula into one math-font run.
  return /^(?:assume|because|consider|define|given|let(?:['’]s)?|recall|since|suppose|take|where)\b/iu.test(
    text,
  )
}

function inlineStackedFormulaBaseId(lineId: string) {
  return /^(.*-inline-stacked-\d+)-formula$/u.exec(lineId)?.[1] ?? null
}

export function inlineStackedSiblingBaseId(lineId: string) {
  return /^(.*-inline-stacked-\d+)-(?:before|after)$/u.exec(lineId)?.[1] ?? null
}

type DetachedMathHostProvenance =
  | { kind: 'linked'; hostLineId: string }
  | { kind: 'ambiguous' }
  | { kind: 'malformed' }

export function detachedMathHostProvenance(
  lineId: string,
): DetachedMathHostProvenance | null {
  if (!lineId.includes('-detached-math-')) return null
  const match = /-detached-math-\d+-host-(.+)$/u.exec(lineId)
  if (!match) return { kind: 'malformed' }
  if (match[1] === 'ambiguous') return { kind: 'ambiguous' }
  try {
    const hostLineId = decodeURIComponent(match[1])
    return hostLineId && encodeURIComponent(hostLineId) === match[1]
      ? { kind: 'linked', hostLineId }
      : { kind: 'malformed' }
  } catch {
    return { kind: 'malformed' }
  }
}

export function detachedMathHostLineId(lineId: string) {
  const provenance = detachedMathHostProvenance(lineId)
  return provenance?.kind === 'linked' ? provenance.hostLineId : null
}

export function unresolvedDetachedMathHost(region: PdfPageRegion) {
  return region.lines.some((line) => {
    const provenance = detachedMathHostProvenance(line.id)
    return provenance?.kind === 'ambiguous' || provenance?.kind === 'malformed'
  })
}

export function inlineStackedFormulaBaseIds(region: PdfPageRegion) {
  return new Set(
    region.lines.flatMap((line) => {
      const baseId = inlineStackedFormulaBaseId(line.id)
      return baseId ? [baseId] : []
    }),
  )
}

export function sourceProvedInlineStackedMathFormula(region: PdfPageRegion) {
  if (
    !['body', 'spanning', 'equation'].includes(region.kind) ||
    region.lines.length === 0 ||
    region.lines.some((line) => inlineStackedFormulaBaseId(line.id) === null)
  ) {
    return false
  }
  const runs = region.lines.flatMap((line) =>
    line.runs.filter((run) => run.text.trim()),
  )
  const neutralSourcePunctuation = (run: (typeof runs)[number]) =>
    /^[.,;:]+$/u.test(run.text.trim()) &&
    /(?:^|[+_-])STIXGeneral(?:[A-Za-z]*)?(?:$|[+_-])/iu.test(run.fontName)
  return (
    runs.length > 0 &&
    runs.every(
      (run) =>
        Number.isSafeInteger(run.sourceSequenceIndex) &&
        (knownSourceMathFont(run.fontName) || neutralSourcePunctuation(run)),
    ) &&
    runs.some((run) => knownSourceMathFont(run.fontName)) &&
    new Set(runs.map((run) => run.sourceSequenceIndex)).size === runs.length &&
    !hasUnsupportedSourceMathRomanWord(runs)
  )
}

interface InlineStackedSiblingEvidence {
  regionId: string
  lineId: string
}

export function provedProseSplitInlineStackedFormulaBaseIds(
  regions: readonly PdfPageRegion[],
) {
  const ambiguousFormulaBaseIds = new Set<string>()
  const proseSiblingEvidence = new Map<string, InlineStackedSiblingEvidence[]>()
  const mathSiblingEvidence = new Map<string, InlineStackedSiblingEvidence[]>()

  for (const region of regions) {
    if (hasAmbiguousStackedEquationGeometry([region])) {
      for (const baseId of inlineStackedFormulaBaseIds(region)) {
        ambiguousFormulaBaseIds.add(baseId)
      }
    }
    for (const line of region.lines) {
      const formulaBaseId = inlineStackedFormulaBaseId(line.id)
      const siblingBaseId = inlineStackedSiblingBaseId(line.id)
      const baseId = formulaBaseId ?? siblingBaseId
      if (!baseId) continue
      const lineFragment = {
        ...region,
        text: line.text,
        box: line.box,
        lines: [line],
      }
      const proseDominantSibling = proseDominantPdfMathSource({
        text: line.text,
        width: line.box.width,
        runs: line.runs,
      })
      const unsupportedProseToken = (line.text.match(/\p{L}{2,}/gu) ?? []).some(
        (token) =>
          !/\p{Script=Greek}/u.test(token) &&
          !/^\p{Ll}\p{Lu}$/u.test(token) &&
          !/^d(?:\p{Ll}|\p{Script=Greek}){1,2}$/u.test(token) &&
          !/^(?:arg|cosh?|det|diag|dim|exp|gcd|lim|log|max|min|mod|sinh?|sqrt|tanh?|var)$/iu.test(
            token,
          ),
      )
      const formulaMathEvidence =
        formulaBaseId !== null &&
        ambiguousFormulaBaseIds.has(formulaBaseId) &&
        region.kind !== 'body' &&
        !proseDominantSibling &&
        sourceMathFragment(lineFragment)
      const siblingMathEvidence =
        siblingBaseId !== null &&
        region.kind !== 'body' &&
        !proseDominantSibling &&
        !unsupportedProseToken &&
        (sourceMathFragment(lineFragment) ||
          sourceMathFontOnlyContinuation(lineFragment) ||
          sourceMathOperatorFragment(lineFragment) ||
          numericListAssignmentFragment(lineFragment) ||
          bareNumericMathFragment(lineFragment))
      const evidence = { regionId: region.id, lineId: line.id }
      if (formulaMathEvidence || siblingMathEvidence) {
        const existing = mathSiblingEvidence.get(baseId) ?? []
        existing.push(evidence)
        mathSiblingEvidence.set(baseId, existing)
      } else if (
        siblingBaseId &&
        region.kind === 'body' &&
        (proseDominantSibling || unsupportedProseToken)
      ) {
        const existing = proseSiblingEvidence.get(baseId) ?? []
        existing.push(evidence)
        proseSiblingEvidence.set(baseId, existing)
      }
    }
  }

  return new Set(
    [...ambiguousFormulaBaseIds].filter((baseId) =>
      (proseSiblingEvidence.get(baseId) ?? []).some((prose) =>
        (mathSiblingEvidence.get(baseId) ?? []).some(
          (math) =>
            math.regionId !== prose.regionId && math.lineId !== prose.lineId,
        ),
      ),
    ),
  )
}

export function numericListAssignmentFragment(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, ' ').trim()
  if (
    !text ||
    Array.from(text).length > 80 ||
    region.lines.length !== 1 ||
    region.box.width > 0.3 ||
    region.box.height > 0.04
  ) {
    return false
  }
  const match =
    /^[\p{L}](?:\s*[_^]\s*[\p{L}\p{N}]+)?\s*=\s*([\[(])\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*,\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+))+\s*([\])])$/u.exec(
      text,
    )
  if (!match || (match[1] === '[' ? match[2] !== ']' : match[2] !== ')')) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  return (
    runs.length > 0 && runs.every((run) => knownSourceMathFont(run.fontName))
  )
}

export function bareNumericMathFragment(region: PdfPageRegion) {
  // A display-equation fraction part (for example the bare denominator
  // `1000`) can reach line assembly as a line of the neighboring paragraph.
  // Reclaim it for the display scope only when every glyph run uses a
  // known source math-family font and the text is one short unparenthesized
  // number, so prose, printed equation numbers, and operator expressions can
  // never join an equation through this path.
  if (!['body', 'spanning', 'equation'].includes(region.kind)) return false
  const text = region.text.replace(/\s+/gu, ' ').trim()
  if (
    !text ||
    Array.from(text).length > 16 ||
    region.lines.length !== 1 ||
    region.box.width > 0.28 ||
    region.box.height > 0.04
  ) {
    return false
  }
  if (!/^[\p{N}][\p{N}.,]{0,11}$/u.test(text)) return false
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  return (
    runs.length > 0 && runs.every((run) => knownSourceMathFont(run.fontName))
  )
}

export function sourceMathFragment(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, ' ').trim()
  if (
    !text ||
    Array.from(text).length > 40 ||
    region.lines.length === 0 ||
    region.lines.length > 2 ||
    region.box.width > 0.35 ||
    region.box.height > 0.06
  ) {
    return false
  }
  const runs = region.lines
    .flatMap((line) => line.runs)
    .filter((run) => run.text.trim())
  if (
    ['body', 'spanning'].includes(region.kind) &&
    sourceMathFragmentProseLead(text, runs)
  ) {
    return false
  }
  if (
    unpublishableEquationTranscriptText(text) &&
    proseDominantPdfMathSource({
      text,
      width: region.box.width,
      runs,
    })
  ) {
    return false
  }
  // Brackets alone are not mathematical evidence: OCR/font extraction can
  // label ordinary bracketed prose as CMMI and append one unresolved CMEX
  // glyph. Treat operators, numbers, and Greek letters as strong context, but
  // keep every other multi-letter word visible to the prose guard.
  const mathContextCharacter =
    /[\p{Script=Greek}\p{N}∆_=+*/<>^−×÷≤≥≈∼⊙∂∞∏∈∉→←∫∑√]/u
  const strongMathSignal = mathContextCharacter.test(text)
  const proseBoundary = /[\s\p{Ps}\p{Pe}\p{Pi}\p{Pf},.;:!?'"“”‘’]/u
  const unsupportedAlphabeticTokens = [...text.matchAll(/\p{L}{2,}/gu)]
    .map((match) => {
      const word = match[0]
      const start = match.index
      const end = start + word.length
      return {
        word,
        before: text[start - 1] ?? '',
        after: text[end] ?? '',
      }
    })
    .filter(
      ({ word, before, after }) =>
        !/^\p{Ll}\p{Lu}$/u.test(word) &&
        !/^d(?:\p{Ll}|\p{Script=Greek}){1,2}$/u.test(word) &&
        !/^(?:arg|cosh?|det|diag|dim|exp|gcd|lim|log|max|min|mod|sinh?|sqrt|tanh?|var)$/iu.test(
          word,
        ) &&
        after !== '(' &&
        !mathContextCharacter.test(before) &&
        !mathContextCharacter.test(after),
    )
  const standaloneUnsupportedTokenCount = unsupportedAlphabeticTokens.filter(
    ({ before, after }) =>
      (!before || proseBoundary.test(before)) &&
      (!after || proseBoundary.test(after)),
  ).length
  if (
    unsupportedAlphabeticTokens.length >= 2 &&
    (!strongMathSignal || standaloneUnsupportedTokenCount >= 2)
  ) {
    return false
  }
  const sourceCharacterCount = runs.reduce(
    (total, run) => total + Array.from(run.text.replace(/\s+/gu, '')).length,
    0,
  )
  if (sourceCharacterCount === 0) return false
  const mathCharacterCount = runs
    .filter((run) => knownSourceMathGlyphFont(run.fontName))
    .reduce(
      (total, run) => total + Array.from(run.text.replace(/\s+/gu, '')).length,
      0,
    )
  const mathFontRatio = mathCharacterCount / sourceCharacterCount
  const sourceScriptGeometry =
    region.lines.some(
      (line) =>
        lineHasSourceScriptGeometry(line) ||
        lineHasCompactSourceScriptIdentifier(line),
    ) || hasAmbiguousStackedEquationGeometry([region])
  const hasMathToken =
    /[\p{Script=Greek}\p{N}_′″=+\-−×÷≤≥≈∼⊙∂∞∏∫∑√∈∉→←]/u.test(text) ||
    /(?:^|[^\p{L}])(?:arg|cosh?|diag|exp|log|max|min|sinh?|sqrt|tanh?|var)\s*\(/iu.test(
      text,
    )
  const hasMathFunctionToken =
    mathFontRatio >= 0.35 &&
    /(?:^|[^\p{L}])(?:arg|cosh?|diag|exp|log|max|min|sinh?|sqrt|tanh?|var)(?:$|[^\p{L}])/iu.test(
      text,
    )
  return (
    (mathFontRatio >= 0.35 || sourceScriptGeometry) &&
    (hasMathToken ||
      hasMathFunctionToken ||
      sourceScriptGeometry ||
      (mathFontRatio >= 0.8 && unsupportedAlphabeticTokens.length === 0))
  )
}

export function sourceMathFontOnlyContinuation(region: PdfPageRegion) {
  // PDF line assembly can detach the integrand to the right of a large
  // operator even though every glyph still carries source math-font
  // provenance. Keep this recovery narrower than sourceMathFragment: it is
  // only a short, single-line continuation with structural math punctuation,
  // at least one math-glyph run, and no ordinary prose token.
  const text = region.text.replace(/\s+/gu, ' ').trim()
  if (
    !text ||
    Array.from(text).length > 40 ||
    region.lines.length !== 1 ||
    region.box.width > (region.kind === 'equation' ? 0.35 : 0.18) ||
    region.box.height > 0.04
  ) {
    return false
  }
  const proseWords = text.match(/[A-Za-z]{3,}/gu) ?? []
  if (
    proseWords.some(
      (word) =>
        !/^(?:arg|cosh?|det|diag|dim|exp|gcd|lim|log|max|min|mod|sinh?|sqrt|tanh?|var)$/iu.test(
          word,
        ),
    )
  ) {
    return false
  }
  // Commas and semicolons alone are not structural math evidence: short
  // Computer Modern prose can use CMMI for its variables while keeping the
  // surrounding words in CMR (for example, “if x is y,”).
  if (!/[()[\]{}:=+\-−×÷≤≥≈∼˜⊙∂∞∏∈∉→←]/u.test(text)) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  if (hasUnsupportedSourceMathRomanWord(runs)) {
    return false
  }
  return (
    runs.length > 0 &&
    runs.every((run) => knownSourceMathFont(run.fontName)) &&
    runs.some((run) => knownSourceMathGlyphFont(run.fontName))
  )
}

export function sourceUprightMathOperatorContinuation(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, ' ').trim()
  const match = /^(?:=|≤|≥|≈|∼)\s*(\p{L}+(?:\s+\p{L}+){0,2})$/u.exec(text)
  if (
    region.kind !== 'equation' ||
    region.lines.length !== 1 ||
    region.box.width > 0.18 ||
    region.box.height > 0.04 ||
    !match
  ) {
    return false
  }
  const tokens = match[1].split(/\s+/u)
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  return (
    tokens.every(justifiedUprightSourceMathToken) &&
    runs.length > 0 &&
    runs.every((run) => sourceMathRomanFont(run.fontName))
  )
}

export function contextualSourceRomanScriptFragment(
  region: PdfPageRegion,
  ownedRegions: readonly PdfPageRegion[],
) {
  const text = region.text.replace(/\s+/gu, '').trim()
  if (
    !/^[A-Za-z]$/u.test(text) ||
    region.lines.length !== 1 ||
    region.box.width > 0.04 ||
    region.box.height > 0.02 ||
    ownedRegions.length === 0
  ) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  if (
    runs.length === 0 ||
    !runs.every((run) => sourceMathRomanFont(run.fontName))
  ) {
    return false
  }
  const ownedRuns = ownedRegions.flatMap((owned) =>
    owned.lines.flatMap((line) => line.runs.filter((run) => run.text.trim())),
  )
  const maximumOwnedFontSize = Math.max(
    0,
    ...ownedRuns.map((run) => run.fontSize),
  )
  const ownedEnvelope = unionBox([...ownedRegions])
  const centerX = region.box.x + region.box.width / 2
  const nearOwnedEnvelope =
    centerX >= ownedEnvelope.x &&
    centerX <= ownedEnvelope.x + ownedEnvelope.width &&
    boxGap(ownedEnvelope, region.box).vertical <= 0.015
  const ownedStackedMath =
    ownedRegions.some(
      (owned) =>
        hasAmbiguousStackedEquationGeometry([owned]) ||
        owned.lines.some((line) =>
          line.runs.some(
            (run) =>
              sourceMathFontProvenance(run.fontName)?.role === 'math-extension',
          ),
        ),
    ) && ownedRuns.some((run) => sourceMathRomanFont(run.fontName))
  return (
    maximumOwnedFontSize > 0 &&
    Math.max(...runs.map((run) => run.fontSize)) <=
      maximumOwnedFontSize * 0.82 &&
    nearOwnedEnvelope &&
    ownedStackedMath
  )
}

export function contextualStixMathOperatorFragment(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, ' ').trim()
  if (
    region.lines.length !== 1 ||
    region.box.width > 0.08 ||
    region.box.height > 0.04 ||
    !/^(?:arg|cosh?|diag|exp|log|max|min|sinh?|sqrt|tanh?|var)$/iu.test(text)
  ) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  return (
    runs.length > 0 &&
    runs.every((run) =>
      /(?:^|[+_-])STIXGeneral(?:[A-Za-z]*)?(?:$|[+_-])/iu.test(run.fontName),
    )
  )
}

export function sourceMathOperatorFragment(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, '').trim()
  if (
    !text ||
    Array.from(text).length > 8 ||
    region.lines.length !== 1 ||
    region.box.width > 0.08 ||
    region.box.height > 0.04 ||
    !/^[()[\]{}.,;:|=+*/<>_\-−×÷≤≥≈∼˜⊙∂∞∑∏∈∉→←]+$/u.test(text) ||
    !/[=+\-−×÷≤≥≈∼˜⊙∂∞∑∏∈∉→←]/u.test(text)
  ) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  return (
    runs.length > 0 &&
    runs.every(
      (run) =>
        knownSourceMathFont(run.fontName) ||
        /(?:^|[+_-])STIXGeneral(?:[A-Za-z]*)?(?:$|[+_-])/iu.test(run.fontName),
    )
  )
}

export function hasAmbiguousStackedEquationGeometry(regions: PdfPageRegion[]) {
  const lines = regions
    .flatMap((region) => region.lines)
    .filter(
      (line) =>
        line.text.trim().length > 0 &&
        !/^\(\s*\d+[a-z]?\s*\)$/iu.test(line.text.trim()),
    )
  for (const line of lines) {
    const runs = line.runs.filter((run) => run.text.trim())
    if (runs.length < 2) continue
    const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
    for (let leftIndex = 0; leftIndex < runs.length; leftIndex += 1) {
      const left = runs[leftIndex]
      if (left.fontSize > maximumFontSize * 0.86) {
        continue
      }
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < runs.length;
        rightIndex += 1
      ) {
        const right = runs[rightIndex]
        if (right.fontSize > maximumFontSize * 0.86) {
          continue
        }
        const horizontalOverlap = Math.max(
          0,
          Math.min(left.x + left.width, right.x + right.width) -
            Math.max(left.x, right.x),
        )
        const minimumWidth = Math.min(left.width, right.width)
        if (
          minimumWidth <= 0 ||
          horizontalOverlap < minimumWidth * 0.7 ||
          Math.abs(left.x + left.width / 2 - (right.x + right.width / 2)) >
            Math.max(0.008, Math.max(left.width, right.width) * 0.3)
        ) {
          continue
        }
        const leftCenterY = left.y + left.height / 2
        const rightCenterY = right.y + right.height / 2
        const minimumHeight = Math.min(left.height, right.height)
        const verticalGap = Math.max(
          left.y - (right.y + right.height),
          right.y - (left.y + left.height),
          0,
        )
        if (
          Math.abs(leftCenterY - rightCenterY) >=
            Math.max(0.003, minimumHeight * 0.45) &&
          verticalGap <= Math.max(0.006, minimumHeight * 0.7)
        ) {
          return true
        }
      }
    }
  }
  for (let leftIndex = 0; leftIndex < lines.length; leftIndex += 1) {
    const left = lines[leftIndex].box
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < lines.length;
      rightIndex += 1
    ) {
      const right = lines[rightIndex].box
      if (
        left.page !== right.page ||
        left.rotation !== right.rotation ||
        left.width <= 0 ||
        right.width <= 0 ||
        left.height <= 0 ||
        right.height <= 0
      ) {
        continue
      }
      const leftCenterY = left.y + left.height / 2
      const rightCenterY = right.y + right.height / 2
      const minimumHeight = Math.min(left.height, right.height)
      if (
        Math.abs(leftCenterY - rightCenterY) <=
        Math.max(0.001, minimumHeight * 0.15)
      ) {
        continue
      }
      const verticalGap = Math.max(
        left.y - (right.y + right.height),
        right.y - (left.y + left.height),
        0,
      )
      if (verticalGap > Math.max(0.003, minimumHeight * 0.35)) continue
      const horizontalOverlap = Math.max(
        0,
        Math.min(left.x + left.width, right.x + right.width) -
          Math.max(left.x, right.x),
      )
      const minimumWidth = Math.min(left.width, right.width)
      if (horizontalOverlap < minimumWidth * 0.75) continue
      const maximumWidth = Math.max(left.width, right.width)
      const widthRatio = minimumWidth / maximumWidth
      const leftCenterX = left.x + left.width / 2
      const rightCenterX = right.x + right.width / 2
      const boxesVerticallyOverlap = verticalGap === 0
      const centersAligned =
        Math.abs(leftCenterX - rightCenterX) <=
        Math.max(0.012, maximumWidth * 0.12)
      if (centersAligned && (widthRatio <= 0.8 || boxesVerticallyOverlap)) {
        return true
      }
    }
  }
  for (const candidate of lines) {
    const candidateCenterY = candidate.box.y + candidate.box.height / 2
    const upperLines = lines.filter((line) => {
      if (
        line.id === candidate.id ||
        line.box.page !== candidate.box.page ||
        line.box.rotation !== candidate.box.rotation
      ) {
        return false
      }
      const centerY = line.box.y + line.box.height / 2
      const verticalGap = Math.max(
        candidate.box.y - (line.box.y + line.box.height),
        0,
      )
      return (
        centerY <
          candidateCenterY -
            Math.max(
              0.001,
              Math.min(line.box.height, candidate.box.height) * 0.15,
            ) && verticalGap <= 0.015
      )
    })
    if (upperLines.length < 2) continue
    const upperLeft = Math.min(...upperLines.map((line) => line.box.x))
    const upperRight = Math.max(
      ...upperLines.map((line) => line.box.x + line.box.width),
    )
    const upperWidth = upperRight - upperLeft
    if (upperWidth <= 0 || candidate.box.width / upperWidth > 0.4) {
      continue
    }
    const upperCenterX = upperLeft + upperWidth / 2
    const candidateCenterX = candidate.box.x + candidate.box.width / 2
    if (
      Math.abs(candidateCenterX - upperCenterX) <=
      Math.max(0.012, upperWidth * 0.12)
    ) {
      return true
    }
  }
  return false
}
