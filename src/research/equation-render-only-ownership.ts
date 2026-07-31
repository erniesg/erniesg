import type {
  PdfEquationRenderOnlySourceRunOwnership,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
} from './import-types'
import { sha256HexSync } from './sha256-sync'

export const RENDER_ONLY_EQUATION_OWNERSHIP_EVIDENCE =
  'source-render-only-extension-glyph-owned-v1' as const

export type PdfEquationRenderOnlyOwnershipScope = {
  id: string
  page: number
  sourceRegionIds: readonly string[]
  sourceLineIds: readonly string[]
}

export type PdfEquationRenderOnlyOwnershipProjection = {
  sourceRuns: PdfSourceRun[]
  ownerships: PdfEquationRenderOnlySourceRunOwnership[]
}

export type PdfEquationRenderOnlyOwnershipAudit = {
  structurallyValid: boolean
  projections: Map<string, PdfEquationRenderOnlyOwnershipProjection>
  obligationScopeIds: Set<string>
}

const SOURCE_BOX_TOLERANCE = 0.000_01
const SOURCE_ITEM_CONTIGUITY_TOLERANCE = 0.000_001
const MAX_MISSING_ASSEMBLY_GAP_RATIO = 0.5

function canonicalSourceTextPaint(run: PdfSourceRun) {
  return run.sourceTextPaint
    ? {
        algorithm: run.sourceTextPaint.algorithm,
        textLedgerSha256: run.sourceTextPaint.textLedgerSha256,
        normalizedTextStart: run.sourceTextPaint.normalizedTextStart,
        normalizedTextEnd: run.sourceTextPaint.normalizedTextEnd,
        operatorLedgerSha256: run.sourceTextPaint.operatorLedgerSha256,
        operationIndexes: [...run.sourceTextPaint.operationIndexes],
        filterableOperationIndexes: [
          ...run.sourceTextPaint.filterableOperationIndexes,
        ],
      }
    : null
}

export function equationRenderOnlySourceRunIdentity(run: PdfSourceRun) {
  return JSON.stringify({
    page: run.page,
    sourceSequenceIndex: run.sourceSequenceIndex ?? null,
    text: run.text,
    x: run.x,
    y: run.y,
    width: run.width,
    height: run.height,
    rotation: run.rotation,
    method: run.method,
    fontName: run.fontName,
    fontSize: run.fontSize,
    confidence: run.confidence,
    sourceTextPaint: canonicalSourceTextPaint(run),
    sourceSemanticAdmission: run.sourceSemanticAdmission ?? null,
  })
}

export function equationRenderOnlySourceRunSha256(run: PdfSourceRun) {
  return sha256HexSync(equationRenderOnlySourceRunIdentity(run))
}

function sourceItemIdentity(run: PdfSourceRun) {
  return JSON.stringify({
    page: run.page,
    sourceSequenceIndex: run.sourceSequenceIndex ?? null,
    text: run.text,
    fontName: run.fontName,
    sourceTextPaint: canonicalSourceTextPaint(run),
  })
}

function finitePositiveSourceRun(run: PdfSourceRun) {
  return (
    Number.isSafeInteger(run.page) &&
    run.page > 0 &&
    Number.isFinite(run.x) &&
    Number.isFinite(run.y) &&
    Number.isFinite(run.width) &&
    run.width > 0 &&
    Number.isFinite(run.height) &&
    run.height > 0 &&
    Number.isFinite(run.rotation) &&
    Number.isFinite(run.fontSize) &&
    run.fontSize > 0
  )
}

function finitePositiveSourceBox(box: PdfPageRegion['lines'][number]['box']) {
  return (
    Number.isSafeInteger(box.page) &&
    box.page > 0 &&
    Number.isFinite(box.x) &&
    box.x >= -SOURCE_BOX_TOLERANCE &&
    Number.isFinite(box.y) &&
    box.y >= -SOURCE_BOX_TOLERANCE &&
    Number.isFinite(box.width) &&
    box.width > 0 &&
    Number.isFinite(box.height) &&
    box.height > 0 &&
    Number.isFinite(box.rotation) &&
    box.x + box.width <= 1 + SOURCE_BOX_TOLERANCE &&
    box.y + box.height <= 1 + SOURCE_BOX_TOLERANCE
  )
}

function sourceBoxContainsBox(
  container: PdfPageRegion['lines'][number]['box'],
  content: PdfPageRegion['lines'][number]['box'],
) {
  return (
    container.page === content.page &&
    container.rotation === content.rotation &&
    content.x >= container.x - SOURCE_BOX_TOLERANCE &&
    content.y >= container.y - SOURCE_BOX_TOLERANCE &&
    content.x + content.width <=
      container.x + container.width + SOURCE_BOX_TOLERANCE &&
    content.y + content.height <=
      container.y + container.height + SOURCE_BOX_TOLERANCE
  )
}

function sourceBoxContainsRun(
  box: PdfPageRegion['lines'][number]['box'],
  run: PdfSourceRun,
) {
  return (
    box.page === run.page &&
    box.rotation === run.rotation &&
    run.x >= box.x - SOURCE_BOX_TOLERANCE &&
    run.y >= box.y - SOURCE_BOX_TOLERANCE &&
    run.x + run.width <= box.x + box.width + SOURCE_BOX_TOLERANCE &&
    run.y + run.height <= box.y + box.height + SOURCE_BOX_TOLERANCE
  )
}

function sourceBoxesIntersect(left: PdfSourceRun, right: PdfSourceRun) {
  return (
    left.page === right.page &&
    left.rotation === right.rotation &&
    Math.min(left.x + left.width, right.x + right.width) >
      Math.max(left.x, right.x) &&
    Math.min(left.y + left.height, right.y + right.height) >
      Math.max(left.y, right.y)
  )
}

function sameBaselineAssembly(marker: PdfSourceRun, neighbor: PdfSourceRun) {
  return (
    marker.fontName === neighbor.fontName &&
    Math.abs(marker.y - neighbor.y) <= SOURCE_ITEM_CONTIGUITY_TOLERANCE &&
    Math.abs(marker.height - neighbor.height) <=
      SOURCE_ITEM_CONTIGUITY_TOLERANCE &&
    Math.abs(marker.fontSize - neighbor.fontSize) <=
      SOURCE_ITEM_CONTIGUITY_TOLERANCE
  )
}

function validRenderOnlyMarker(run: PdfSourceRun) {
  return (
    isPotentialEquationRenderOnlySourceRun(run) &&
    run.sourceTextPaint === undefined &&
    run.sourceSemanticAdmission?.algorithm ===
      'pdf-text-item-semantic-admission-v1' &&
    run.sourceSemanticAdmission.status === 'unresolved-extension-glyph'
  )
}

export function isPotentialEquationRenderOnlySourceRun(run: PdfSourceRun) {
  return (
    run.text === '\ufffd' &&
    /CMEX\d*/iu.test(run.fontName) &&
    Number.isSafeInteger(run.sourceSequenceIndex) &&
    finitePositiveSourceRun(run) &&
    run.rotation === 0 &&
    run.method === 'pdf-text'
  )
}

function mathAssemblyFont(fontName: string) {
  return /CM(?:EX|MI|SY)\d*/iu.test(fontName)
}

function bracketedSemanticRunGap(
  preceding: PdfSourceRun,
  following: PdfSourceRun,
) {
  const precedingSequence = preceding.sourceSequenceIndex
  const followingSequence = following.sourceSequenceIndex
  const horizontalGap = following.x - (preceding.x + preceding.width)
  const verticalOverlap =
    Math.min(preceding.y + preceding.height, following.y + following.height) -
    Math.max(preceding.y, following.y)
  return (
    finitePositiveSourceRun(preceding) &&
    finitePositiveSourceRun(following) &&
    Number.isSafeInteger(precedingSequence) &&
    Number.isSafeInteger(followingSequence) &&
    followingSequence === precedingSequence! + 2 &&
    preceding.page === following.page &&
    preceding.rotation === following.rotation &&
    preceding.method === 'pdf-text' &&
    following.method === 'pdf-text' &&
    !(
      following.sourceWhitespaceBefore === 'pdf-text-item' &&
      following.sourceWhitespacePredecessorIndex === precedingSequence
    ) &&
    horizontalGap > SOURCE_ITEM_CONTIGUITY_TOLERANCE &&
    horizontalGap <=
      Math.min(preceding.width, following.width) *
        MAX_MISSING_ASSEMBLY_GAP_RATIO +
        SOURCE_ITEM_CONTIGUITY_TOLERANCE &&
    verticalOverlap > 0 &&
    Math.abs(preceding.height - following.height) <=
      SOURCE_ITEM_CONTIGUITY_TOLERANCE &&
    Math.abs(preceding.fontSize - following.fontSize) <=
      SOURCE_ITEM_CONTIGUITY_TOLERANCE &&
    (/CMEX\d*/iu.test(preceding.fontName) ||
      /CMEX\d*/iu.test(following.fontName)) &&
    mathAssemblyFont(preceding.fontName) &&
    mathAssemblyFont(following.fontName)
  )
}

type ScopedLine = {
  scopeId: string
  line: PdfPageRegion['lines'][number]
}

export function auditEquationRenderOnlySourceRunOwnerships({
  pages,
  regions,
  scopes,
}: {
  pages: readonly PdfPageAnalysis[]
  regions: readonly PdfPageRegion[]
  scopes: readonly PdfEquationRenderOnlyOwnershipScope[]
}): PdfEquationRenderOnlyOwnershipAudit {
  const invalidAudit = (): PdfEquationRenderOnlyOwnershipAudit => ({
    structurallyValid: false,
    projections: new Map(),
    obligationScopeIds: new Set(),
  })
  const pageNumbers = new Set<number>()
  const pagesByNumber = new Map<number, PdfPageAnalysis>()
  for (const page of pages) {
    if (
      !Number.isSafeInteger(page.page) ||
      page.page < 1 ||
      !Number.isFinite(page.width) ||
      page.width <= 0 ||
      !Number.isFinite(page.height) ||
      page.height <= 0 ||
      !Number.isFinite(page.rotation) ||
      pageNumbers.has(page.page) ||
      [...page.runs, ...(page.renderVisibleTextRuns ?? [])].some(
        (run) =>
          !finitePositiveSourceRun(run) ||
          run.page !== page.page ||
          run.rotation !== page.rotation,
      )
    ) {
      return invalidAudit()
    }
    pageNumbers.add(page.page)
    pagesByNumber.set(page.page, page)
  }
  const regionsById = new Map<string, PdfPageRegion>()
  const linesById = new Map<
    string,
    {
      region: PdfPageRegion
      line: PdfPageRegion['lines'][number]
    }
  >()
  for (const region of regions) {
    const page = pagesByNumber.get(region.page)
    const regionHasText = region.text.trim().length > 0
    const hasLineText = region.lines.some(
      (line) =>
        line.text.trim().length > 0 ||
        line.runs.some((run) => run.text.trim().length > 0),
    )
    if (
      !region.id ||
      regionsById.has(region.id) ||
      !page ||
      !finitePositiveSourceBox(region.box) ||
      region.box.page !== region.page ||
      region.box.rotation !== page.rotation ||
      regionHasText !== hasLineText
    ) {
      return invalidAudit()
    }
    regionsById.set(region.id, region)
    for (const line of region.lines) {
      const lineHasText = line.text.trim().length > 0
      const hasRunText = line.runs.some((run) => run.text.trim().length > 0)
      if (
        !line.id ||
        linesById.has(line.id) ||
        !finitePositiveSourceBox(line.box) ||
        line.box.page !== region.page ||
        line.box.rotation !== region.box.rotation ||
        line.box.method !== region.box.method ||
        !sourceBoxContainsBox(region.box, line.box) ||
        lineHasText !== hasRunText ||
        line.runs.some(
          (run) =>
            !finitePositiveSourceRun(run) ||
            run.page !== line.box.page ||
            run.rotation !== line.box.rotation ||
            run.method !== line.box.method ||
            !sourceBoxContainsRun(line.box, run),
        )
      ) {
        return invalidAudit()
      }
      linesById.set(line.id, { region, line })
    }
  }
  const scopeIds = new Set<string>()
  for (const scope of scopes) {
    if (
      !scope.id ||
      scopeIds.has(scope.id) ||
      !Number.isSafeInteger(scope.page) ||
      scope.page < 1 ||
      !pageNumbers.has(scope.page) ||
      scope.sourceRegionIds.length === 0 ||
      scope.sourceLineIds.length === 0 ||
      new Set(scope.sourceRegionIds).size !== scope.sourceRegionIds.length ||
      new Set(scope.sourceLineIds).size !== scope.sourceLineIds.length
    ) {
      return invalidAudit()
    }
    scopeIds.add(scope.id)
    const selectedRegionIds = new Set(scope.sourceRegionIds)
    const selectedLines = scope.sourceLineIds.map((lineId) =>
      linesById.get(lineId),
    )
    if (
      scope.sourceRegionIds.some((regionId) => {
        const region = regionsById.get(regionId)
        return !region || region.page !== scope.page
      }) ||
      selectedLines.some(
        (entry) =>
          !entry ||
          entry.region.page !== scope.page ||
          entry.line.box.page !== scope.page ||
          !selectedRegionIds.has(entry.region.id),
      ) ||
      scope.sourceRegionIds.some((regionId) =>
        selectedLines.every((entry) => entry?.region.id !== regionId),
      )
    ) {
      return invalidAudit()
    }
  }

  const sourceItemOccurrences = new Map<string, number>()
  for (const region of regions) {
    for (const line of region.lines) {
      for (const run of line.runs.filter((candidate) =>
        candidate.text.trim(),
      )) {
        const key = sourceItemIdentity(run)
        sourceItemOccurrences.set(
          key,
          (sourceItemOccurrences.get(key) ?? 0) + 1,
        )
      }
    }
  }

  const ownersBySourceItem = new Map<string, ScopedLine[]>()
  const scopedLines = new Map<string, ScopedLine>()
  for (const scope of scopes) {
    for (const sourceLineId of scope.sourceLineIds) {
      const line = linesById.get(sourceLineId)!.line
      const scopedLine = { scopeId: scope.id, line }
      scopedLines.set(`${scope.id}\u001f${sourceLineId}`, scopedLine)
      for (const run of line.runs.filter((candidate) =>
        candidate.text.trim(),
      )) {
        if (
          !Number.isSafeInteger(run.sourceSequenceIndex) ||
          sourceItemOccurrences.get(sourceItemIdentity(run)) !== 1
        ) {
          continue
        }
        const key = sourceItemIdentity(run)
        const owners = ownersBySourceItem.get(key) ?? []
        owners.push(scopedLine)
        ownersBySourceItem.set(key, owners)
      }
    }
  }

  const candidatesByMarker = new Map<
    string,
    Array<{
      scopeId: string
      sourceRun: PdfSourceRun
      ownership: PdfEquationRenderOnlySourceRunOwnership
    }>
  >()
  const obligationScopeIds = new Set<string>()
  for (const page of pages) {
    const inventory = page.renderVisibleTextRuns ?? []
    const inventoryBySequence = new Map<number, PdfSourceRun[]>()
    for (const run of inventory) {
      if (!Number.isSafeInteger(run.sourceSequenceIndex)) continue
      const sequence = run.sourceSequenceIndex!
      const values = inventoryBySequence.get(sequence) ?? []
      values.push(run)
      inventoryBySequence.set(sequence, values)
    }
    for (const scopedLine of scopedLines.values()) {
      if (scopedLine.line.box.page !== page.page) continue
      const semanticRuns = scopedLine.line.runs.filter((run) => run.text.trim())
      for (let index = 1; index < semanticRuns.length; index += 1) {
        const preceding = semanticRuns[index - 1]
        const following = semanticRuns[index]
        if (
          bracketedSemanticRunGap(preceding, following) &&
          sourceItemOccurrences.get(sourceItemIdentity(preceding)) === 1 &&
          sourceItemOccurrences.get(sourceItemIdentity(following)) === 1 &&
          !inventoryBySequence.has(preceding.sourceSequenceIndex! + 1)
        ) {
          obligationScopeIds.add(scopedLine.scopeId)
        }
      }
    }
    for (const marker of inventory.filter(
      isPotentialEquationRenderOnlySourceRun,
    )) {
      const sequence = marker.sourceSequenceIndex!
      const markerMatches = inventoryBySequence.get(sequence) ?? []
      const precedingMatches = inventoryBySequence.get(sequence - 1) ?? []
      const followingMatches = inventoryBySequence.get(sequence + 1) ?? []
      if (
        markerMatches.length !== 1 ||
        precedingMatches.length !== 1 ||
        followingMatches.length !== 1
      ) {
        continue
      }
      const preceding = precedingMatches[0]
      const following = followingMatches[0]
      if (
        !preceding.text.trim() ||
        !following.text.trim() ||
        !finitePositiveSourceRun(preceding) ||
        !finitePositiveSourceRun(following) ||
        preceding.page !== marker.page ||
        following.page !== marker.page ||
        preceding.rotation !== 0 ||
        following.rotation !== 0 ||
        preceding.method !== 'pdf-text' ||
        following.method !== 'pdf-text' ||
        !bracketedSemanticRunGap(preceding, following) ||
        Math.abs(preceding.x + preceding.width - marker.x) >
          SOURCE_ITEM_CONTIGUITY_TOLERANCE ||
        Math.abs(marker.x + marker.width - following.x) >
          SOURCE_ITEM_CONTIGUITY_TOLERANCE ||
        !(
          sameBaselineAssembly(marker, preceding) ||
          sameBaselineAssembly(marker, following)
        )
      ) {
        continue
      }
      const precedingOwners =
        ownersBySourceItem.get(sourceItemIdentity(preceding)) ?? []
      const followingOwners =
        ownersBySourceItem.get(sourceItemIdentity(following)) ?? []
      if (precedingOwners.length !== 1 || followingOwners.length !== 1) {
        continue
      }
      const precedingOwner = precedingOwners[0]
      const followingOwner = followingOwners[0]
      const ownerSemanticRuns = precedingOwner.line.runs.filter((run) =>
        run.text.trim(),
      )
      const precedingOwnerIndex = ownerSemanticRuns.findIndex(
        (run) => sourceItemIdentity(run) === sourceItemIdentity(preceding),
      )
      const followingOwnerIndex = ownerSemanticRuns.findIndex(
        (run) => sourceItemIdentity(run) === sourceItemIdentity(following),
      )
      if (
        precedingOwner.scopeId !== followingOwner.scopeId ||
        precedingOwner.line.id !== followingOwner.line.id ||
        followingOwnerIndex !== precedingOwnerIndex + 1 ||
        !sourceBoxContainsRun(precedingOwner.line.box, marker) ||
        regions.some((region) =>
          region.lines.some(
            (line) =>
              line.id !== precedingOwner.line.id &&
              line.text.trim().length > 0 &&
              sourceBoxesIntersect(marker, {
                ...marker,
                ...line.box,
                text: line.text,
              }),
          ),
        ) ||
        inventory.some(
          (run) =>
            run !== marker &&
            run !== preceding &&
            run !== following &&
            run.text.trim().length > 0 &&
            sourceBoxesIntersect(marker, run),
        )
      ) {
        continue
      }
      obligationScopeIds.add(precedingOwner.scopeId)
      if (!validRenderOnlyMarker(marker)) continue
      const ownership: PdfEquationRenderOnlySourceRunOwnership = {
        algorithm: 'equation-bracketed-render-only-extension-glyph-v1',
        page: marker.page,
        sourceLineId: precedingOwner.line.id,
        sourceSequenceIndex: sequence,
        precedingSourceSequenceIndex: sequence - 1,
        followingSourceSequenceIndex: sequence + 1,
        sourceRunSha256: equationRenderOnlySourceRunSha256(marker),
        precedingSourceRunSha256: equationRenderOnlySourceRunSha256(preceding),
        followingSourceRunSha256: equationRenderOnlySourceRunSha256(following),
      }
      const markerKey = equationRenderOnlySourceRunIdentity(marker)
      const candidates = candidatesByMarker.get(markerKey) ?? []
      candidates.push({
        scopeId: precedingOwner.scopeId,
        sourceRun: marker,
        ownership,
      })
      candidatesByMarker.set(markerKey, candidates)
    }
  }

  const projections = new Map<
    string,
    PdfEquationRenderOnlyOwnershipProjection
  >()
  for (const candidates of candidatesByMarker.values()) {
    if (candidates.length !== 1) continue
    const candidate = candidates[0]
    if (
      !scopedLines.has(
        `${candidate.scopeId}\u001f${candidate.ownership.sourceLineId}`,
      )
    ) {
      continue
    }
    const projection = projections.get(candidate.scopeId) ?? {
      sourceRuns: [],
      ownerships: [],
    }
    projection.sourceRuns.push(candidate.sourceRun)
    projection.ownerships.push(candidate.ownership)
    projections.set(candidate.scopeId, projection)
  }
  for (const projection of projections.values()) {
    const bySequence = (
      left: PdfEquationRenderOnlySourceRunOwnership,
      right: PdfEquationRenderOnlySourceRunOwnership,
    ) =>
      left.page - right.page ||
      left.sourceSequenceIndex - right.sourceSequenceIndex
    projection.ownerships.sort(bySequence)
    projection.sourceRuns.sort(
      (left, right) =>
        left.page - right.page ||
        left.sourceSequenceIndex! - right.sourceSequenceIndex!,
    )
  }
  return {
    structurallyValid: true,
    projections,
    obligationScopeIds,
  }
}

export function proveEquationRenderOnlySourceRunOwnerships(input: {
  pages: readonly PdfPageAnalysis[]
  regions: readonly PdfPageRegion[]
  scopes: readonly PdfEquationRenderOnlyOwnershipScope[]
}): Map<string, PdfEquationRenderOnlyOwnershipProjection> {
  const audit = auditEquationRenderOnlySourceRunOwnerships(input)
  return audit.structurallyValid
    ? audit.projections
    : new Map<string, PdfEquationRenderOnlyOwnershipProjection>()
}
