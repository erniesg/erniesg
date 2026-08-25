import type { PdfPageRegion } from './import-types'
import { pdfFontTextRequiresStructuralReconstruction } from './pdf-font-text'
import { sanitizeXmlText } from './publication-integrity'

export function unpublishableEquationTranscriptText(text: string) {
  return text.includes('\ufffd') || sanitizeXmlText(text) !== text
}

function unresolvedMathExtensionRun(
  run: PdfPageRegion['lines'][number]['runs'][number],
) {
  return (
    sourceMathFontProvenance(run.fontName)?.role === 'math-extension' &&
    (unpublishableEquationTranscriptText(run.text) ||
      pdfFontTextRequiresStructuralReconstruction(run.text, run.fontName))
  )
}

export function unresolvedMathExtensionRegion(region: PdfPageRegion) {
  return region.lines.some((line) => line.runs.some(unresolvedMathExtensionRun))
}

export function unreliableMathExtensionRun(
  run: PdfPageRegion['lines'][number]['runs'][number],
) {
  return (
    sourceMathFontProvenance(run.fontName)?.role === 'math-extension' &&
    (unresolvedMathExtensionRun(run) || /^[A-Za-z]$/u.test(run.text))
  )
}

export function mathExtensionGlyphFragment(region: PdfPageRegion) {
  const runs = region.lines.flatMap((line) => line.runs)
  return (
    runs.length > 0 &&
    runs.every(
      (run) =>
        sourceMathFontProvenance(run.fontName)?.role === 'math-extension',
    )
  )
}

export function sourceMathExtensionScaffoldFragment(region: PdfPageRegion) {
  if (
    region.lines.length !== 1 ||
    region.box.width > 0.18 ||
    region.box.height > 0.04
  ) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  const extensionRuns = runs.filter(
    (run) => sourceMathFontProvenance(run.fontName)?.role === 'math-extension',
  )
  return (
    extensionRuns.length >= 2 &&
    runs.length > extensionRuns.length &&
    runs
      .filter(
        (run) =>
          sourceMathFontProvenance(run.fontName)?.role !== 'math-extension',
      )
      .every((run) => /^[\s.\u2026\d]+$/u.test(run.text))
  )
}

export function contextualNeutralVerticalEllipsisFragment(
  region: PdfPageRegion,
  ownedRegions: readonly PdfPageRegion[],
) {
  const text = region.text.replace(/\s+/gu, '')
  if (
    !/^(?:\.{3}|\u2026)$/u.test(text) ||
    region.lines.length !== 1 ||
    region.box.width > 0.02 ||
    region.box.height < 0.012 ||
    region.box.height > 0.04 ||
    ownedRegions.length === 0
  ) {
    return false
  }
  const runs = region.lines[0].runs.filter((run) => run.text.trim())
  if (
    runs.length === 0 ||
    !runs.every((run) => /^[.\u2026]+$/u.test(run.text.trim()))
  ) {
    return false
  }
  const extensionRuns = ownedRegions.flatMap((owned) =>
    owned.lines.flatMap((line) =>
      line.runs.filter(
        (run) =>
          run.text.trim() &&
          sourceMathFontProvenance(run.fontName)?.role === 'math-extension',
      ),
    ),
  )
  const centerX = region.box.x + region.box.width / 2
  const centerY = region.box.y + region.box.height / 2
  const verticallyEnclosesCenter = (
    candidates: readonly PdfPageRegion['lines'][number]['runs'][number][],
  ) =>
    candidates.length > 0 &&
    Math.min(...candidates.map((run) => run.y)) <= centerY &&
    Math.max(...candidates.map((run) => run.y + run.height)) >= centerY
  const leftColumn = extensionRuns.filter(
    (run) =>
      run.x + run.width <= centerX && centerX - (run.x + run.width) <= 0.12,
  )
  const rightColumn = extensionRuns.filter(
    (run) => run.x >= centerX && run.x - centerX <= 0.12,
  )
  return (
    verticallyEnclosesCenter(leftColumn) &&
    verticallyEnclosesCenter(rightColumn)
  )
}

export function unresolvedMathExtensionGlyphFragment(region: PdfPageRegion) {
  return (
    mathExtensionGlyphFragment(region) && unresolvedMathExtensionRegion(region)
  )
}

export function equationTranscriptResolved(regions: PdfPageRegion[]) {
  return !regions.some((region) =>
    region.lines.some(
      (line) =>
        unpublishableEquationTranscriptText(line.text) ||
        line.runs.some(unreliableMathExtensionRun),
    ),
  )
}

export function sourceEquationLineText(regions: PdfPageRegion[]) {
  return regions
    .flatMap((region) => region.lines)
    .sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    )
    .map((line) => line.text.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join(' ')
}

type SourceMathFontProvenance = {
  family: 'computer-modern' | 'latin-modern' | 'stix'
  role: 'roman' | 'math-glyph' | 'math-extension'
}

export function sourceMathFontProvenance(
  fontName: string,
): SourceMathFontProvenance | null {
  if (/(?:^|[+_-])CMR\d*(?:$|[+_-])/iu.test(fontName)) {
    return { family: 'computer-modern', role: 'roman' }
  }
  if (/(?:^|[+_-])CMEX\d*(?:$|[+_-])/iu.test(fontName)) {
    return { family: 'computer-modern', role: 'math-extension' }
  }
  if (/(?:^|[+_-])(?:CMMI|CMSY|MSAM|MSBM)\d*(?:$|[+_-])/iu.test(fontName)) {
    return { family: 'computer-modern', role: 'math-glyph' }
  }
  if (
    /(?:^|[+_-])LMRoman\d*(?:-(?:Regular|Bold|Italic|BoldItalic))?(?:$|[+_-])/iu.test(
      fontName,
    )
  ) {
    return { family: 'latin-modern', role: 'roman' }
  }
  if (
    /(?:^|[+_-])LMMathExtension\d*(?:-Regular)?(?:$|[+_-])/iu.test(fontName)
  ) {
    return { family: 'latin-modern', role: 'math-extension' }
  }
  if (
    /(?:^|[+_-])LMMath(?:Italic|Symbols)\d*(?:-Regular)?(?:$|[+_-])/iu.test(
      fontName,
    )
  ) {
    return { family: 'latin-modern', role: 'math-glyph' }
  }
  if (stixMathFont(fontName)) {
    return { family: 'stix', role: 'math-glyph' }
  }
  return null
}

export function computerOrLatinModernMathFont(fontName: string) {
  const provenance = sourceMathFontProvenance(fontName)
  return (
    provenance?.family === 'computer-modern' ||
    provenance?.family === 'latin-modern'
  )
}

export function sourceMathRomanFont(fontName: string) {
  return sourceMathFontProvenance(fontName)?.role === 'roman'
}

export function justifiedUprightSourceMathToken(value: string) {
  return /^(?:arg|cosh?|det|diag|dim|exp|gcd|im|lim|log|max|min|mod|pr|re|sinh?|sqrt|tanh?|var|d[p-z])$/iu.test(
    value,
  )
}

export function hasUnsupportedSourceMathRomanWord(
  runs: readonly PdfPageRegion['lines'][number]['runs'][number][],
) {
  let token = ''
  const flush = () => {
    const unsupported =
      Array.from(token).length >= 2 && !justifiedUprightSourceMathToken(token)
    token = ''
    return unsupported
  }
  for (const run of runs) {
    if (!sourceMathRomanFont(run.fontName)) {
      if (flush()) return true
      continue
    }
    if (token && justifiedUprightSourceMathToken(token) && flush()) return true
    for (const character of run.text) {
      if (/\p{L}/u.test(character) && !/\p{Lm}/u.test(character)) {
        token += character
      } else if (flush()) {
        return true
      }
    }
  }
  return flush()
}

function stixMathFont(fontName: string) {
  return /(?:^|[+_-])STIXMath(?:[A-Za-z]*)?(?:$|[+_-])/iu.test(fontName)
}

export function knownSourceMathFont(fontName: string) {
  return sourceMathFontProvenance(fontName) !== null
}

export function lineHasSourceScriptGeometry(
  line: PdfPageRegion['lines'][number],
) {
  const runs = line.runs.filter((run) => run.text.trim())
  if (runs.length < 2) return false
  const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
  const baselineRuns = runs.filter(
    (run) => run.fontSize >= maximumFontSize * 0.9,
  )
  if (baselineRuns.length === 0) return false
  const baselineCenter =
    baselineRuns.reduce((total, run) => total + run.y + run.height / 2, 0) /
    baselineRuns.length
  const baselineHeight =
    baselineRuns.reduce((total, run) => total + run.height, 0) /
    baselineRuns.length
  const threshold = Math.max(0.0015, baselineHeight * 0.12)
  return runs.some(
    (run) =>
      knownSourceMathFont(run.fontName) &&
      run.fontSize <= maximumFontSize * 0.82 &&
      Math.abs(run.y + run.height / 2 - baselineCenter) > threshold,
  )
}

export function lineHasCompactSourceScriptIdentifier(
  line: PdfPageRegion['lines'][number],
) {
  const text = line.text.replace(/\s+/gu, '')
  const runs = line.runs.filter((run) => run.text.trim())
  if (
    runs.length < 2 ||
    !/^[\p{L}\p{N}]{2,8}$/u.test(text) ||
    !runs.every((run) => knownSourceMathFont(run.fontName))
  ) {
    return false
  }
  const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
  const minimumFontSize = Math.min(...runs.map((run) => run.fontSize))
  return maximumFontSize > 0 && minimumFontSize <= maximumFontSize * 0.82
}

export function lineHasUnencodedSourceScriptGeometry(
  line: PdfPageRegion['lines'][number],
) {
  const runs = line.runs.filter((run) => run.text.trim())
  if (runs.length < 2) return false
  const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
  const baselineRuns = runs.filter(
    (run) => run.fontSize >= maximumFontSize * 0.9,
  )
  if (baselineRuns.length === 0) return false
  const baselineCenter =
    baselineRuns.reduce((total, run) => total + run.y + run.height / 2, 0) /
    baselineRuns.length
  const baselineHeight =
    baselineRuns.reduce((total, run) => total + run.height, 0) /
    baselineRuns.length
  const threshold = Math.max(0.0015, baselineHeight * 0.12)
  const normalizedLine = line.text.replace(/\s+/gu, '')
  return runs.some((run) => {
    const sourceToken = run.text.replace(/\s+/gu, '')
    const isScriptRun =
      run.fontSize <= maximumFontSize * 0.82 &&
      Math.abs(run.y + run.height / 2 - baselineCenter) > threshold
    if (!isScriptRun || !sourceToken) return false
    const unicodeScriptToken = /^[\u00b2\u00b3\u00b9\u2070-\u209c]+$/u.test(
      sourceToken,
    )
    const explicitlyMarked =
      normalizedLine.includes(`_${sourceToken}`) ||
      normalizedLine.includes(`^{${sourceToken}}`) ||
      normalizedLine.includes(`_{${sourceToken}}`) ||
      normalizedLine.includes(`^${sourceToken}`)
    return !unicodeScriptToken && !explicitlyMarked
  })
}

export function knownSourceMathGlyphFont(fontName: string) {
  const role = sourceMathFontProvenance(fontName)?.role
  return role === 'math-glyph' || role === 'math-extension'
}
