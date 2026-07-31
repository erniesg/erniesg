import type {
  NormalizedSourceBox,
  PdfEquationMathNode,
  PdfEquationMathToken,
  PdfPageRegion,
  PdfSourceGeometryScriptTranscript,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import { pdfFontTextRequiresStructuralReconstruction } from './pdf-font-text'
import { sha256HexSync } from './sha256-sync'

export const SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE =
  'source-geometry-script-transcript-v1' as const

type TranscriptInput = {
  sourceRegionIds: readonly string[]
  sourceLineIds: readonly string[]
  sourceObjectIds: readonly string[]
  regions: readonly PdfPageRegion[]
  sourceCropAsset: PdfVisualAsset
}

type ScopedRun = PdfPageRegion['lines'][number]['runs'][number]

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function sameValues<T>(left: readonly T[], right: readonly T[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function finitePositiveBox(box: NormalizedSourceBox) {
  return (
    Number.isSafeInteger(box.page) &&
    box.page > 0 &&
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    box.width > 0 &&
    Number.isFinite(box.height) &&
    box.height > 0 &&
    Number.isFinite(box.rotation)
  )
}

function containsBox(
  container: NormalizedSourceBox,
  nested: NormalizedSourceBox,
) {
  const tolerance = 0.000_001
  return (
    container.page === nested.page &&
    container.rotation === nested.rotation &&
    nested.x >= container.x - tolerance &&
    nested.y >= container.y - tolerance &&
    nested.x + nested.width <= container.x + container.width + tolerance &&
    nested.y + nested.height <= container.y + container.height + tolerance
  )
}

function intersectionArea(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  if (left.page !== right.page || left.rotation !== right.rotation) return 0
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  )
  return width * height
}

function sourceRunIdentity(run: ScopedRun) {
  return canonicalJson({
    page: run.page,
    x: run.x,
    y: run.y,
    width: run.width,
    height: run.height,
    rotation: run.rotation,
    method: run.method,
    text: run.text,
    fontName: run.fontName,
    fontSize: run.fontSize,
    sourceSequenceIndex: run.sourceSequenceIndex ?? null,
    confidence: run.confidence,
  })
}

function exactMathFont(fontName: string) {
  return (
    /(?:^|[+_-])(?:CMMI|CMR|CMSY|MSAM|MSBM)\d*(?:$|[+_-])/iu.test(fontName) ||
    /(?:^|[+_-])STIXMath(?:[A-Za-z]*)?(?:$|[+_-])/iu.test(fontName)
  )
}

function disallowedSourceText(value: string) {
  return (
    value.length === 0 ||
    /[\u0000-\u001f\u007f-\u009f\ufffd\ue000-\uf8ff]/u.test(value) ||
    /\p{Mark}/u.test(value) ||
    /[∫∮∯∰∑∏∐√∛∜⌠⌡⎷]/u.test(value) ||
    /[¯ˉˆ^˜~˙¨⃗⃑]/u.test(value) ||
    /[/\\]/u.test(value) ||
    /\b(?:lim|limits?|matrix|cases?)\b/iu.test(value)
  )
}

function balancedParentheses(value: string) {
  let depth = 0
  for (const character of value) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (depth < 0) return false
  }
  return depth === 0
}

function mathToken(value: string): PdfEquationMathToken | null {
  if (/^\p{Letter}$/u.test(value)) return { type: 'mi', text: value }
  if (/^\p{Number}+(?:[.,]\p{Number}+)?$/u.test(value)) {
    return { type: 'mn', text: value }
  }
  if (/^[=+\-−×÷≤≥≠≈≃∼∝∈∉→←↔(),.;:|′″]$/u.test(value)) {
    return { type: 'mo', text: value }
  }
  return null
}

function spokenToken(token: PdfEquationMathToken) {
  if (token.type === 'mn') return token.text
  const operator = new Map([
    ['=', 'equals'],
    ['+', 'plus'],
    ['-', 'minus'],
    ['−', 'minus'],
    ['×', 'times'],
    ['÷', 'divided by'],
    ['≤', 'less than or equal to'],
    ['≥', 'greater than or equal to'],
    ['≠', 'not equal to'],
    ['≈', 'approximately equal to'],
    ['≃', 'asymptotically equal to'],
    ['∼', 'similar to'],
    ['∝', 'proportional to'],
    ['∈', 'is in'],
    ['∉', 'is not in'],
    ['→', 'approaches'],
    ['←', 'left arrow'],
    ['↔', 'if and only if'],
    ['(', 'left parenthesis'],
    [')', 'right parenthesis'],
    [',', 'comma'],
    ['.', 'point'],
    [';', 'semicolon'],
    [':', 'colon'],
    ['|', 'vertical bar'],
    ['′', 'prime'],
    ['″', 'double prime'],
  ]).get(token.text)
  return operator ?? Array.from(token.text).join(' ')
}

function plainNode(node: PdfEquationMathNode) {
  if (node.type === 'mi' || node.type === 'mn' || node.type === 'mo') {
    return node.text
  }
  if (node.type === 'msub') {
    return `${node.base.text}_(${node.subscript.text})`
  }
  if (node.type === 'msup') {
    return `${node.base.text}^(${node.superscript.text})`
  }
  return `${node.base.text}_(${node.subscript.text})^(${node.superscript.text})`
}

function spokenNode(node: PdfEquationMathNode) {
  if (node.type === 'mi' || node.type === 'mn' || node.type === 'mo') {
    return spokenToken(node)
  }
  if (node.type === 'msub') {
    return `${spokenToken(node.base)} subscript ${spokenToken(node.subscript)}`
  }
  if (node.type === 'msup') {
    return `${spokenToken(node.base)} superscript ${spokenToken(node.superscript)}`
  }
  return `${spokenToken(node.base)} subscript ${spokenToken(node.subscript)} superscript ${spokenToken(node.superscript)}`
}

function selectedScope(input: TranscriptInput) {
  if (
    input.sourceRegionIds.length !== 1 ||
    new Set(input.sourceRegionIds).size !== input.sourceRegionIds.length ||
    input.sourceLineIds.length !== 1 ||
    new Set(input.sourceLineIds).size !== input.sourceLineIds.length ||
    input.sourceObjectIds.length !== 1 ||
    new Set(input.sourceObjectIds).size !== input.sourceObjectIds.length
  ) {
    return null
  }
  const regionMatches = input.regions.filter(
    (region) => region.id === input.sourceRegionIds[0],
  )
  if (
    regionMatches.length !== 1 ||
    regionMatches[0].kind !== 'equation' ||
    regionMatches[0].lines.length !== 1 ||
    regionMatches[0].lines[0].id !== input.sourceLineIds[0]
  ) {
    return null
  }
  const lineOccurrences = input.regions.flatMap((region) =>
    region.lines.filter((line) => line.id === input.sourceLineIds[0]),
  )
  return lineOccurrences.length === 1
    ? { region: regionMatches[0], line: regionMatches[0].lines[0] }
    : null
}

function exactSourceCrop(
  input: TranscriptInput,
  scopedBoxes: NormalizedSourceBox[],
) {
  const asset = input.sourceCropAsset
  const crop = asset.sourceCropBox
  if (
    asset.kind !== 'equation' ||
    asset.rendition !== 'source-page-crop' ||
    asset.mediaType !== 'image/png' ||
    !crop ||
    asset.sourceExclusionMask !== undefined ||
    !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
    sha256HexSync(asset.bytes) !== asset.sha256 ||
    !sameValues(asset.sourceObjectIds, input.sourceObjectIds) ||
    asset.sourceBoxes.length !== input.sourceObjectIds.length ||
    asset.sourceBoxes.some(
      (box) => !finitePositiveBox(box) || !containsBox(crop, box),
    ) ||
    !asset.sourceBoxes.some((box) => containsBox(box, scopedBoxes[0])) ||
    !finitePositiveBox(crop) ||
    scopedBoxes.some(
      (box) => !finitePositiveBox(box) || !containsBox(crop, box),
    )
  ) {
    return false
  }
  const inkLeft = Math.min(...scopedBoxes.map((box) => box.x))
  const inkTop = Math.min(...scopedBoxes.map((box) => box.y))
  const inkRight = Math.max(...scopedBoxes.map((box) => box.x + box.width))
  const inkBottom = Math.max(...scopedBoxes.map((box) => box.y + box.height))
  const minimumMargin = 0.000_1
  return (
    inkLeft - crop.x >= minimumMargin &&
    inkTop - crop.y >= minimumMargin &&
    crop.x + crop.width - inkRight >= minimumMargin &&
    crop.y + crop.height - inkBottom >= minimumMargin
  )
}

function uniqueSourceRuns(
  selectedRuns: readonly ScopedRun[],
  regions: readonly PdfPageRegion[],
) {
  const selectedIdentities = selectedRuns.map(sourceRunIdentity)
  if (new Set(selectedIdentities).size !== selectedIdentities.length) {
    return false
  }
  const occurrences = new Map<string, number>()
  for (const run of regions.flatMap((region) =>
    region.lines.flatMap((line) =>
      line.runs.filter((item) => item.text.trim()),
    ),
  )) {
    const identity = sourceRunIdentity(run)
    occurrences.set(identity, (occurrences.get(identity) ?? 0) + 1)
  }
  return selectedIdentities.every((identity) => occurrences.get(identity) === 1)
}

function hasUnownedOverlap(
  selectedRuns: readonly ScopedRun[],
  sourceLineId: string,
  regions: readonly PdfPageRegion[],
) {
  return regions.some((region) =>
    region.lines.some(
      (line) =>
        line.id !== sourceLineId &&
        line.runs
          .filter((run) => run.text.trim())
          .some((unowned) =>
            selectedRuns.some((owned) => {
              const smallerArea = Math.min(
                owned.width * owned.height,
                unowned.width * unowned.height,
              )
              return (
                smallerArea > 0 &&
                intersectionArea(owned, unowned) / smallerArea >= 0.35
              )
            }),
          ),
    ),
  )
}

function scriptMathNodes(runs: ScopedRun[]) {
  if (runs.length < 2) return null
  const ordered = [...runs].sort(
    (left, right) =>
      left.x - right.x ||
      left.y - right.y ||
      (left.sourceSequenceIndex ?? Number.MAX_SAFE_INTEGER) -
        (right.sourceSequenceIndex ?? Number.MAX_SAFE_INTEGER),
  )
  for (let index = 0; index < ordered.length; index += 1) {
    for (let other = index + 1; other < ordered.length; other += 1) {
      if (intersectionArea(ordered[index], ordered[other]) > 0.000_000_01) {
        return null
      }
    }
  }

  const maximumFontSize = Math.max(...ordered.map((run) => run.fontSize))
  const baselineRuns = ordered.filter(
    (run) => run.fontSize >= maximumFontSize * 0.9,
  )
  if (baselineRuns.length === 0) return null
  const baselineCenter =
    baselineRuns.reduce((total, run) => total + run.y + run.height / 2, 0) /
    baselineRuns.length
  const baselineHeight =
    baselineRuns.reduce((total, run) => total + run.height, 0) /
    baselineRuns.length
  const baselineDrift = Math.max(0.001, baselineHeight * 0.1)
  if (
    baselineRuns.some(
      (run) =>
        Math.abs(run.y + run.height / 2 - baselineCenter) > baselineDrift,
    )
  ) {
    return null
  }

  const scriptRuns = ordered.filter((run) => !baselineRuns.includes(run))
  if (scriptRuns.length === 0) return null
  const scriptThreshold = Math.max(0.0015, baselineHeight * 0.15)
  if (
    scriptRuns.some(
      (run) =>
        run.fontSize > maximumFontSize * 0.82 ||
        Math.abs(run.y + run.height / 2 - baselineCenter) <= scriptThreshold ||
        Math.abs(run.y + run.height / 2 - baselineCenter) >
          baselineHeight * 0.9,
    )
  ) {
    return null
  }

  const tokens = new Map<ScopedRun, PdfEquationMathToken>()
  for (const run of ordered) {
    const token = mathToken(run.text.trim())
    if (!token) return null
    tokens.set(run, token)
  }
  const scriptsByBase = new Map<
    ScopedRun,
    { subscript?: PdfEquationMathToken; superscript?: PdfEquationMathToken }
  >()
  for (const script of scriptRuns) {
    const scriptCenter = script.y + script.height / 2
    const position = scriptCenter < baselineCenter ? 'superscript' : 'subscript'
    const candidates = baselineRuns.filter((base) => {
      const token = tokens.get(base)!
      const horizontalGap = script.x - (base.x + base.width)
      return (
        (token.type === 'mi' || token.type === 'mn') &&
        horizontalGap >= 0 &&
        horizontalGap <= Math.max(0.006, base.height * 0.55)
      )
    })
    if (candidates.length !== 1) return null
    const base = candidates[0]
    const attached = scriptsByBase.get(base) ?? {}
    if (attached[position]) return null
    attached[position] = tokens.get(script)!
    scriptsByBase.set(base, attached)
  }

  const nodes = baselineRuns.map<PdfEquationMathNode>((run) => {
    const token = tokens.get(run)!
    const scripts = scriptsByBase.get(run)
    if (!scripts) return token
    if (scripts.subscript && scripts.superscript) {
      return {
        type: 'msubsup',
        base: token,
        subscript: scripts.subscript,
        superscript: scripts.superscript,
      }
    }
    return scripts.subscript
      ? { type: 'msub', base: token, subscript: scripts.subscript }
      : {
          type: 'msup',
          base: token,
          superscript: scripts.superscript!,
        }
  })
  return scriptsByBase.size > 0 ? nodes : null
}

export function createSourceGeometryScriptTranscript(
  input: TranscriptInput,
): PdfSourceGeometryScriptTranscript | null {
  const scope = selectedScope(input)
  if (!scope) return null
  const runs = scope.line.runs.filter((run) => run.text.trim())
  const sourceCharacters = runs.map((run) => run.text).join('')
  if (
    runs.length < 2 ||
    scope.line.text.replace(/\s+/gu, '') !==
      sourceCharacters.replace(/\s+/gu, '') ||
    disallowedSourceText(sourceCharacters) ||
    !balancedParentheses(sourceCharacters) ||
    /[\[\]{}]/u.test(sourceCharacters) ||
    runs.some(
      (run) =>
        !finitePositiveBox(run) ||
        run.rotation !== 0 ||
        run.method !== 'pdf-text' ||
        run.confidence !== 1 ||
        !Number.isFinite(run.fontSize) ||
        run.fontSize <= 0 ||
        !exactMathFont(run.fontName) ||
        /CMEX/iu.test(run.fontName) ||
        disallowedSourceText(run.text) ||
        pdfFontTextRequiresStructuralReconstruction(run.text, run.fontName),
    ) ||
    !uniqueSourceRuns(runs, input.regions) ||
    hasUnownedOverlap(runs, scope.line.id, input.regions) ||
    !exactSourceCrop(input, [scope.region.box, scope.line.box, ...runs])
  ) {
    return null
  }
  const children = scriptMathNodes(runs)
  if (!children) return null
  const mathml = {
    type: 'math' as const,
    display: 'block' as const,
    children,
  }
  const plainText = children.map(plainNode).join(' ')
  const spokenText = children.map(spokenNode).join(' ')
  const transcriptSha256 = sha256HexSync(
    canonicalJson({ mathml, plainText, spokenText }),
  )
  return {
    schemaVersion: '1.0.0',
    source: SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
    mathml,
    plainText,
    spokenText,
    provenance: {
      algorithm: 'exact-unicode-math-font-script-geometry-v1',
      sourceRegionIdsSha256: sha256HexSync(
        canonicalJson(input.sourceRegionIds),
      ),
      sourceLineIdsSha256: sha256HexSync(canonicalJson(input.sourceLineIds)),
      sourceRunsSha256: sha256HexSync(
        canonicalJson(runs.map(sourceRunIdentity)),
      ),
      sourceCropAssetSha256: input.sourceCropAsset.sha256,
      transcriptSha256,
    },
  }
}

export function verifySourceGeometryScriptTranscript(
  transcript: PdfSourceGeometryScriptTranscript | undefined,
  input: TranscriptInput,
) {
  if (
    !transcript ||
    transcript.schemaVersion !== '1.0.0' ||
    transcript.source !== SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE
  ) {
    return false
  }
  const rebuilt = createSourceGeometryScriptTranscript(input)
  return Boolean(
    rebuilt && canonicalJson(rebuilt) === canonicalJson(transcript),
  )
}

export function verifyRelationshipSourceGeometryScriptTranscript({
  relationship,
  regions,
  assets,
}: {
  relationship: PdfVisualRelationship
  regions: readonly PdfPageRegion[]
  assets: readonly PdfVisualAsset[]
}) {
  if (
    relationship.kind !== 'equation' ||
    relationship.status !== 'matched' ||
    relationship.sourceText !== '' ||
    relationship.altTextSource !== 'caption' ||
    !relationship.equationGeometryTranscript ||
    relationship.evidence.filter(
      (item) => item === SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
    ).length !== 1 ||
    relationship.evidence.some((item) =>
      [
        'source-text-transcript-unresolved',
        'incomplete-equation-source-scope',
        'overlapping-unowned-source-text',
        'source-page-crop-unowned-text-masked',
      ].includes(item),
    ) ||
    !relationship.sourceLineIds ||
    relationship.assetIds.length !== 1
  ) {
    return false
  }
  const assetMatches = assets.filter(
    (asset) => asset.id === relationship.assetIds[0],
  )
  return (
    assetMatches.length === 1 &&
    verifySourceGeometryScriptTranscript(
      relationship.equationGeometryTranscript,
      {
        sourceRegionIds: relationship.sourceRegionIds,
        sourceLineIds: relationship.sourceLineIds,
        sourceObjectIds: relationship.sourceObjectIds,
        regions,
        sourceCropAsset: assetMatches[0],
      },
    )
  )
}

function xmlText(value: string) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
}

function xmlAttribute(value: string) {
  return xmlText(value).replace(/"/gu, '&quot;')
}

function renderMathToken(token: PdfEquationMathToken) {
  return `<${token.type}>${xmlText(token.text)}</${token.type}>`
}

function renderMathNode(node: PdfEquationMathNode) {
  if (node.type === 'mi' || node.type === 'mn' || node.type === 'mo') {
    return renderMathToken(node)
  }
  if (node.type === 'msub') {
    return `<msub>${renderMathToken(node.base)}${renderMathToken(node.subscript)}</msub>`
  }
  if (node.type === 'msup') {
    return `<msup>${renderMathToken(node.base)}${renderMathToken(node.superscript)}</msup>`
  }
  return `<msubsup>${renderMathToken(node.base)}${renderMathToken(node.subscript)}${renderMathToken(node.superscript)}</msubsup>`
}

export function renderSourceGeometryScriptMathMl(
  transcript: PdfSourceGeometryScriptTranscript,
  id: string,
) {
  return `<math xmlns="http://www.w3.org/1998/Math/MathML" id="${xmlAttribute(id)}" class="visually-hidden" display="block" data-equation-transcript-source="${SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE}" data-equation-spoken-text="${xmlAttribute(transcript.spokenText)}"><semantics><mrow>${transcript.mathml.children.map(renderMathNode).join('')}</mrow><annotation encoding="text/plain">${xmlText(transcript.plainText)}</annotation></semantics></math>`
}
