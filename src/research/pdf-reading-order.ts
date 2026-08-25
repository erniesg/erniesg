import type {
  PdfPageRegion,
  PdfReadingOrderEdge,
  PdfReadingOrderEvaluation,
  PdfReadingOrderGraph,
  PdfReadingOrderResolution,
} from './import-types'

export const READING_ORDER_RESOLUTION_POLICY_VERSION = '1.0.0' as const
export const READING_ORDER_RESOLUTION_THRESHOLD = 0.85

type ColumnLayout = {
  split: number | null
  accepted: boolean
  ambiguous: boolean
  resolution: Omit<PdfReadingOrderResolution, 'page' | 'regionIds'> | null
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

export function inlineStackedFragmentParts(line: { id?: string }) {
  const match = line.id?.match(
    /^(.*-inline-stacked-\d+)-(before|formula|after)$/u,
  )
  return match
    ? {
        baseId: match[1],
        part: match[2] as 'before' | 'formula' | 'after',
      }
    : null
}

export function inlineStackedFragmentOrder(
  left: { id?: string },
  right: { id?: string },
) {
  const leftParts = inlineStackedFragmentParts(left)
  const rightParts = inlineStackedFragmentParts(right)
  if (!leftParts || !rightParts || leftParts.baseId !== rightParts.baseId) {
    return null
  }
  const order = { before: 0, formula: 1, after: 2 } as const
  return order[leftParts.part] - order[rightParts.part]
}

export function restoreInlineStackedAtomicUnits(ordered: PdfPageRegion[]) {
  const units = new Map<
    string,
    {
      page: number
      invalid: boolean
      parts: Map<'before' | 'formula' | 'after', PdfPageRegion>
    }
  >()
  const basesByRegionId = new Map<string, Set<string>>()

  for (const region of ordered) {
    for (const line of region.lines) {
      const fragment = inlineStackedFragmentParts(line)
      if (!fragment) continue
      const unit = units.get(fragment.baseId) ?? {
        page: region.page,
        invalid: false,
        parts: new Map<'before' | 'formula' | 'after', PdfPageRegion>(),
      }
      const existing = unit.parts.get(fragment.part)
      if (unit.page !== region.page || existing !== undefined) {
        unit.invalid = true
      }
      unit.parts.set(fragment.part, region)
      units.set(fragment.baseId, unit)
      const regionBases = basesByRegionId.get(region.id) ?? new Set<string>()
      regionBases.add(fragment.baseId)
      basesByRegionId.set(region.id, regionBases)
    }
  }

  const validUnits = new Map<
    string,
    [PdfPageRegion, PdfPageRegion, PdfPageRegion]
  >()
  for (const [baseId, unit] of units) {
    const before = unit.parts.get('before')
    const formula = unit.parts.get('formula')
    const after = unit.parts.get('after')
    const regionIds = new Set(
      [before, formula, after].flatMap((region) =>
        region === undefined ? [] : [region.id],
      ),
    )
    const notePartitions = new Set(
      [before, formula, after].flatMap((region) =>
        region === undefined
          ? []
          : [region.kind === 'footnote' || region.kind === 'endnote'],
      ),
    )
    if (
      unit.invalid ||
      !before ||
      !formula ||
      !after ||
      regionIds.size !== 3 ||
      notePartitions.size !== 1 ||
      [...regionIds].some(
        (regionId) => (basesByRegionId.get(regionId)?.size ?? 0) !== 1,
      )
    ) {
      continue
    }
    validUnits.set(baseId, [before, formula, after])
  }
  if (validUnits.size === 0) return ordered

  const unitByRegionId = new Map<
    string,
    [PdfPageRegion, PdfPageRegion, PdfPageRegion]
  >()
  for (const unit of validUnits.values()) {
    for (const region of unit) unitByRegionId.set(region.id, unit)
  }
  const emittedRegionIds = new Set<string>()
  return ordered.flatMap((region) => {
    if (emittedRegionIds.has(region.id)) return []
    const unit = unitByRegionId.get(region.id)
    if (!unit) {
      emittedRegionIds.add(region.id)
      return [region]
    }
    for (const member of unit) emittedRegionIds.add(member.id)
    return unit
  })
}

export function splitNoteDefinitionOrder(
  left: PdfPageRegion,
  right: PdfPageRegion,
) {
  const parts = (id: string) => {
    const match = id.match(/^(.*)-note-(\d{3})$/u)
    return {
      base: match?.[1] ?? id,
      ordinal: match ? Number(match[2]) : 1,
    }
  }
  const leftParts = parts(left.id)
  const rightParts = parts(right.id)
  return leftParts.base === rightParts.base
    ? leftParts.ordinal - rightParts.ordinal
    : null
}

function columnOrdered(regions: PdfPageRegion[]) {
  const readingAnchor = (region: PdfPageRegion) => {
    const firstSourceLine = [...region.lines]
      .filter((line) => line.text.trim())
      .sort(
        (left, right) => left.box.y - right.box.y || left.box.x - right.box.x,
      )[0]
    return firstSourceLine?.box ?? region.box
  }
  const byY = (left: PdfPageRegion, right: PdfPageRegion) => {
    const splitDefinitionOrder = splitNoteDefinitionOrder(left, right)
    const leftAnchor = readingAnchor(left)
    const rightAnchor = readingAnchor(right)
    const inlineOrder = inlineStackedFragmentOrder(
      left.lines[0] ?? {},
      right.lines[0] ?? {},
    )
    return (
      splitDefinitionOrder ??
      inlineOrder ??
      (leftAnchor.y - rightAnchor.y ||
        leftAnchor.x - rightAnchor.x ||
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id))
    )
  }
  return [
    ...regions.filter((region) => region.column === 'left').sort(byY),
    ...regions.filter((region) => region.column === 'right').sort(byY),
    ...regions
      .filter(
        (region) => region.column === 'single' || region.column === 'span',
      )
      .sort(byY),
  ]
}

function orderPageRegions(regions: PdfPageRegion[], layout: ColumnLayout) {
  const included = regions.filter((region) => region.includedInReadingOrder)
  const notes = included.filter(
    (region) => region.kind === 'footnote' || region.kind === 'endnote',
  )
  const flow = included.filter(
    (region) => region.kind !== 'footnote' && region.kind !== 'endnote',
  )
  if (layout.split === null) {
    return restoreInlineStackedAtomicUnits([
      ...flow.sort(
        (left, right) =>
          inlineStackedFragmentOrder(
            left.lines[0] ?? {},
            right.lines[0] ?? {},
          ) ??
          (left.box.y - right.box.y || left.box.x - right.box.x),
      ),
      ...notes.sort(
        (left, right) =>
          splitNoteDefinitionOrder(left, right) ??
          (left.box.y - right.box.y || left.box.x - right.box.x),
      ),
    ])
  }

  const spanning = flow
    .filter((region) => region.column === 'span')
    .sort((left, right) => left.box.y - right.box.y)
  const columnFlow = flow.filter((region) => region.column !== 'span')
  const ordered: PdfPageRegion[] = []
  const emitted = new Set<string>()
  for (const span of spanning) {
    const band = columnFlow.filter(
      (region) => !emitted.has(region.id) && region.box.y < span.box.y,
    )
    ordered.push(...columnOrdered(band), span)
    for (const region of band) emitted.add(region.id)
  }
  ordered.push(
    ...columnOrdered(columnFlow.filter((region) => !emitted.has(region.id))),
    ...columnOrdered(notes),
  )
  return restoreInlineStackedAtomicUnits(ordered)
}

function edgeEvidence(from: PdfPageRegion, to: PdfPageRegion) {
  if (from.page !== to.page) {
    return {
      code: 'page-sequence' as const,
      detail: `Page ${from.page} precedes page ${to.page}.`,
    }
  }
  if (to.kind === 'footnote' || to.kind === 'endnote') {
    return {
      code: 'note-after-body' as const,
      detail: 'The separated note region follows the page body flow.',
    }
  }
  if (from.column !== to.column) {
    return {
      code: 'column-flow' as const,
      detail: `${from.column} column flow precedes ${to.column} column flow.`,
    }
  }
  if (
    from.kind === 'spanning' ||
    to.kind === 'spanning' ||
    from.column === 'span' ||
    to.column === 'span'
  ) {
    return {
      code: 'spanning-boundary' as const,
      detail: 'A page-spanning region forms a deterministic flow boundary.',
    }
  }
  return {
    code: 'vertical-flow' as const,
    detail: 'Regions in the same flow follow normalized vertical geometry.',
  }
}

export function hasAcceptedCycle(
  regionIds: string[],
  edges: PdfReadingOrderEdge[],
) {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges.filter(
    (candidate) => candidate.status === 'accepted',
  )) {
    const targets = outgoing.get(edge.from) ?? []
    targets.push(edge.to)
    outgoing.set(edge.from, targets)
  }
  const state = new Map<string, 'visiting' | 'visited'>()
  for (const root of regionIds) {
    if (state.has(root)) continue
    state.set(root, 'visiting')
    const stack = [{ id: root, nextTarget: 0 }]
    while (stack.length > 0) {
      const frame = stack.at(-1)!
      const targets = outgoing.get(frame.id) ?? []
      if (frame.nextTarget >= targets.length) {
        state.set(frame.id, 'visited')
        stack.pop()
        continue
      }
      const target = targets[frame.nextTarget]
      frame.nextTarget += 1
      if (state.get(target) === 'visiting') return true
      if (state.get(target) === 'visited') continue
      state.set(target, 'visiting')
      stack.push({ id: target, nextTarget: 0 })
    }
  }
  return false
}

export function buildReadingOrder(
  regions: PdfPageRegion[],
  layouts: Map<number, ColumnLayout>,
) {
  const orderedRegions = [...layouts.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([page, layout]) =>
      orderPageRegions(
        regions.filter((region) => region.page === page),
        layout,
      ),
    )
  const edges: PdfReadingOrderEdge[] = []
  for (let index = 0; index < orderedRegions.length - 1; index += 1) {
    const from = orderedRegions[index]
    const to = orderedRegions[index + 1]
    const layout = layouts.get(from.page)
    const crossColumnBoundary =
      from.page === to.page && from.column === 'left' && to.column === 'right'
    const ambiguousBoundary = crossColumnBoundary && Boolean(layout?.ambiguous)
    const resolvedBoundary =
      crossColumnBoundary && layout?.resolution?.status === 'resolved'
    edges.push({
      id: `reading-edge-${String(edges.length + 1).padStart(4, '0')}`,
      from: from.id,
      to: to.id,
      status: ambiguousBoundary ? 'candidate' : 'accepted',
      confidence:
        ambiguousBoundary || resolvedBoundary
          ? (layout?.resolution?.confidence ?? 0.5)
          : 0.96,
      evidence: ambiguousBoundary
        ? [
            ...(layout?.resolution?.evidence ?? []),
            {
              code: 'ambiguous-column-flow',
              detail: `Both column orders remain candidates because confidence ${layout?.resolution?.confidence ?? 0.5} is below threshold ${READING_ORDER_RESOLUTION_THRESHOLD}.`,
            },
          ]
        : resolvedBoundary
          ? [...layout.resolution!.evidence, edgeEvidence(from, to)]
          : [edgeEvidence(from, to)],
      sourceBoxes: [from.box, to.box],
    })
    if (ambiguousBoundary) {
      const rightRegions = orderedRegions.filter(
        (region) => region.page === from.page && region.column === 'right',
      )
      const leftRegions = orderedRegions.filter(
        (region) => region.page === from.page && region.column === 'left',
      )
      const reverseFrom = rightRegions.at(-1)
      const reverseTo = leftRegions[0]
      if (reverseFrom && reverseTo) {
        edges.push({
          id: `reading-edge-${String(edges.length + 1).padStart(4, '0')}`,
          from: reverseFrom.id,
          to: reverseTo.id,
          status: 'candidate',
          confidence: layout?.resolution?.confidence ?? 0.5,
          evidence: [
            ...(layout?.resolution?.evidence ?? []),
            {
              code: 'ambiguous-column-flow',
              detail: `The reverse column order is retained for bounded review below threshold ${READING_ORDER_RESOLUTION_THRESHOLD}.`,
            },
          ],
          sourceBoxes: [reverseFrom.box, reverseTo.box],
        })
      }
    }
  }
  const regionIds = regions.map((region) => region.id)
  const resolutions = [...layouts.entries()]
    .filter(
      (
        entry,
      ): entry is [
        number,
        ColumnLayout & { resolution: NonNullable<ColumnLayout['resolution']> },
      ] => entry[1].resolution !== null,
    )
    .map<PdfReadingOrderResolution>(([page, layout]) => ({
      page,
      ...layout.resolution,
      regionIds: regions
        .filter(
          (region) => region.page === page && region.includedInReadingOrder,
        )
        .map((region) => region.id),
    }))
  const acyclic = !hasAcceptedCycle(regionIds, edges)
  const unresolvedEdgeCount = edges.filter(
    (edge) => edge.status === 'candidate',
  ).length
  const evaluation: PdfReadingOrderEvaluation = {
    schemaVersion: '1.0.0',
    algorithm: 'deterministic-geometry-v1',
    mode: 'deterministic-only',
    regionCount: orderedRegions.length,
    acceptedEdgeCount: edges.length - unresolvedEdgeCount,
    unresolvedEdgeCount,
    cycleRate: acyclic ? 0 : 1,
    orderAccuracy: null,
    provider: null,
    modelVersion: null,
    latencyMs: 0,
    costUsd: 0,
    reviewRequired: !acyclic || unresolvedEdgeCount > 0,
  }
  return {
    schemaVersion: '1.0.0',
    regionIds,
    order: orderedRegions.map((region) => region.id),
    edges,
    resolutions,
    acyclic,
    evaluation,
  } satisfies PdfReadingOrderGraph
}

export function evaluateReadingOrder(
  graph: PdfReadingOrderGraph,
  expectedOrder?: readonly string[],
) {
  if (!expectedOrder) return { ...graph.evaluation }
  const expectedPositions = new Map(
    expectedOrder.map((id, index) => [id, index]),
  )
  const comparable = graph.order.filter((id) => expectedPositions.has(id))
  const correct = comparable.filter(
    (id, index) => expectedPositions.get(id) === index,
  ).length
  return {
    ...graph.evaluation,
    orderAccuracy:
      expectedOrder.length === 0
        ? 1
        : rounded(correct / Math.max(expectedOrder.length, graph.order.length)),
  }
}
