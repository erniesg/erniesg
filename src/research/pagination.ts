import type { ResearchNode, ResearchPaper } from './schema'
import {
  getPreviewMetrics,
  getTargetProfile,
  type TargetProfileId,
} from './targets'

export const PAGINATION_POLICY_VERSION = '1.0.0' as const

export const PAGINATION_VIOLATION_CODES = [
  'atomic-object-too-tall',
  'minimum-fragment-lines',
] as const

export type PaginationViolationCode =
  (typeof PAGINATION_VIOLATION_CODES)[number]

export type NodePaginationPolicy = {
  fragmentation: 'line' | 'atomic'
  keep: 'none' | 'with-next' | 'with-previous' | 'with-related'
  minimumStartLines?: number
  minimumEndLines?: number
}

export const NODE_PAGINATION_POLICIES: Record<
  ResearchNode['type'],
  NodePaginationPolicy
> = {
  heading: { fragmentation: 'atomic', keep: 'with-next' },
  paragraph: {
    fragmentation: 'line',
    keep: 'none',
    minimumStartLines: 2,
    minimumEndLines: 2,
  },
  quote: { fragmentation: 'atomic', keep: 'none' },
  figure: { fragmentation: 'atomic', keep: 'with-related' },
  caption: { fragmentation: 'atomic', keep: 'with-previous' },
  footnote: { fragmentation: 'atomic', keep: 'with-previous' },
}

export type PaginationConstraints = {
  widthCssPx: number
  heightCssPx: number | null
  contentWidthCssPx: number
  contentHeightCssPx: number | null
  columnWidthCssPx: number
  columns: number
  columnGapCssPx: number
  firstPageHeaderHeightCssPx: number
}

export type PaginationOverrides = Partial<
  Pick<PaginationConstraints, 'widthCssPx' | 'heightCssPx'>
> & {
  fontScale?: number
}

export type PaginationViolation = {
  code: PaginationViolationCode
  severity: 'warning' | 'error'
  message: string
}

export type PaginationFallback = {
  code: 'scale-atomic-object'
  reason: string
  scale: number
}

export type PaginationFragment = {
  id: string
  canonicalId: string
  nodeType: ResearchNode['type']
  index: number
  page: number
  region: number
  span: 'column' | 'page'
  estimatedHeightCssPx: number
  textRange?: { start: number; end: number }
  decision: {
    outcome:
      | 'placed'
      | 'fragmented'
      | 'kept-with-next'
      | 'kept-with-related'
      | 'atomic-fallback'
    reason: string
  }
  violations: PaginationViolation[]
  fallback?: PaginationFallback
}

export type PaginatedNode = {
  canonicalId: string
  policy: NodePaginationPolicy
  fragments: PaginationFragment[]
  decision: PaginationFragment['decision']
  violations: PaginationViolation[]
  fallback?: PaginationFallback
}

export type PaginationPage = {
  number: number
  regions: Array<{
    index: number
    capacityCssPx: number
    usedCssPx: number
    fragments: PaginationFragment[]
  }>
  spanningFragments: PaginationFragment[]
}

export type PaginationResult = {
  target: TargetProfileId
  policyVersion: typeof PAGINATION_POLICY_VERSION
  mode: 'continuous' | 'finite'
  constraints: PaginationConstraints
  pages: PaginationPage[]
  nodes: PaginatedNode[]
  violations: PaginationViolation[]
  finalPageCount: number | null
  pageCountStatus: 'final' | 'not-applicable'
  currentRegionStability: {
    metric: 'anchored-region-prefix'
    status: 'not-compared' | 'stable' | 'unstable'
    anchorCanonicalId: string
    page: number
    region: number
    signature: string
    referenceSignature: string | null
    stable: boolean | null
    comparedFragmentCount: number
    stableFragmentCount: number
  }
}

type PaginationLayoutResult = Omit<PaginationResult, 'currentRegionStability'>

type TextLine = { start: number; end: number }

type LayoutItem = {
  canonicalIds: string[]
  nodeTypes: ResearchNode['type'][]
  kind: 'paragraph' | 'atomic'
  estimatedHeightCssPx: number
  lineHeightCssPx?: number
  lines?: TextLine[]
  keepWithNext: boolean
  span: 'column' | 'page'
}

const BLOCK_MARGIN_CSS_PX = 32
const MINIMUM_ATOMIC_SCALE = 0.75

function estimateLineRanges(text: string, charactersPerLine: number) {
  const tokens = [...text.matchAll(/\S+\s*/g)]
  if (tokens.length === 0) return [{ start: 0, end: text.length }]

  const lines: TextLine[] = []
  let lineStart = tokens[0].index ?? 0
  let lineLength = 0
  let lineEnd = lineStart

  for (const token of tokens) {
    const start = token.index ?? lineEnd
    const end = start + token[0].length
    const tokenLength = end - start

    if (lineLength > 0 && lineLength + tokenLength > charactersPerLine) {
      lines.push({ start: lineStart, end: lineEnd })
      lineStart = start
      lineLength = tokenLength
    } else {
      lineLength += tokenLength
    }
    lineEnd = end
  }

  lines.push({ start: lineStart, end: text.length })
  return lines
}

function charactersPerLine(
  widthCssPx: number,
  fontSizeCssPx: number,
  glyphWidthRatio = 0.56,
) {
  return Math.max(
    12,
    Math.floor(widthCssPx / (fontSizeCssPx * glyphWidthRatio)),
  )
}

function textHeight(
  text: string,
  widthCssPx: number,
  fontSizeCssPx: number,
  lineHeight: number,
  glyphWidthRatio = 0.56,
) {
  return (
    estimateLineRanges(
      text,
      charactersPerLine(widthCssPx, fontSizeCssPx, glyphWidthRatio),
    ).length *
    fontSizeCssPx *
    lineHeight
  )
}

function estimateHeaderHeight(
  paper: ResearchPaper,
  contentWidthCssPx: number,
  target: TargetProfileId,
  fontScale: number,
) {
  const typography = getTargetProfile(target).typography
  const title = textHeight(
    paper.title,
    contentWidthCssPx,
    typography.titleSizeCssPx * fontScale,
    0.95,
  )
  const subtitle = textHeight(
    paper.subtitle,
    contentWidthCssPx,
    18 * fontScale,
    1.4,
  )
  const authors = textHeight(
    `${paper.authors.join(', ')} · updated ${paper.updated}`,
    contentWidthCssPx,
    12,
    14 / 12,
    0.52,
  )
  const labelledAbstract = textHeight(
    `Abstract. ${paper.abstract}`,
    contentWidthCssPx,
    14 * fontScale,
    1.65,
  )

  if (target === 'paperProMove') {
    const compactSubtitle = textHeight(
      paper.subtitle,
      contentWidthCssPx,
      18 * fontScale,
      1.4,
      0.48,
    )
    const compactAuthors = textHeight(
      `${paper.authors.join(', ')} · updated ${paper.updated}`,
      contentWidthCssPx,
      12,
      14 / 12,
      0.52,
    )
    const compactAbstract = textHeight(
      `Abstract. ${paper.abstract}`,
      contentWidthCssPx,
      14 * fontScale,
      1.65,
      0.49,
    )

    // The 7.3-inch target keeps the same type sizes but uses a compact
    // vertical rhythm. These values mirror its CSS overrides. The final pixel
    // accounts for the header rule inside the border-box height.
    return Math.ceil(
      12 +
        16 +
        title +
        12 +
        compactSubtitle +
        18 +
        compactAuthors +
        22 +
        compactAbstract +
        16 +
        1,
    )
  }

  // These constants mirror the explicit document-header gaps in global.css.
  return Math.ceil(
    12 +
      16 +
      title +
      12 +
      subtitle +
      24 +
      authors +
      28 +
      labelledAbstract +
      24 +
      1,
  )
}

export function getPaginationConstraints(
  paper: ResearchPaper,
  target: TargetProfileId,
  overrides: PaginationOverrides = {},
): PaginationConstraints {
  const fontScale = overrides.fontScale ?? 1
  if (!Number.isFinite(fontScale) || fontScale <= 0) {
    throw new RangeError('Pagination font scale must be a positive number')
  }
  const profile = getTargetProfile(target)
  const preview = getPreviewMetrics(profile)
  const widthCssPx = overrides.widthCssPx ?? preview.widthCssPx
  const heightCssPx =
    overrides.heightCssPx === undefined
      ? (profile.preview.heightCssPx ?? null)
      : overrides.heightCssPx
  const horizontalScale = widthCssPx / profile.dimensions.width
  const verticalScale = preview.widthCssPx / profile.dimensions.width
  const horizontalMargins =
    (profile.margins.left + profile.margins.right) * horizontalScale
  const verticalMargins =
    (profile.margins.top + profile.margins.bottom) * verticalScale
  const contentWidthCssPx = widthCssPx - horizontalMargins
  const contentHeightCssPx =
    heightCssPx === null ? null : heightCssPx - verticalMargins
  const totalColumnGap = profile.columns.gapCssPx * (profile.columns.count - 1)
  const columnWidthCssPx =
    (contentWidthCssPx - totalColumnGap) / profile.columns.count

  return {
    widthCssPx,
    heightCssPx,
    contentWidthCssPx,
    contentHeightCssPx,
    columnWidthCssPx,
    columns: profile.columns.count,
    columnGapCssPx: profile.columns.gapCssPx,
    firstPageHeaderHeightCssPx: estimateHeaderHeight(
      paper,
      contentWidthCssPx,
      target,
      fontScale,
    ),
  }
}

function estimateAtomicHeight(
  node: ResearchNode,
  paper: ResearchPaper,
  target: TargetProfileId,
  widthCssPx: number,
  fontScale: number,
) {
  const profile = getTargetProfile(target)
  const typography = profile.typography

  if (node.type === 'heading') {
    return (
      textHeight(
        node.text,
        widthCssPx,
        typography.headingSizeCssPx * fontScale,
        1.2,
      ) + 48
    )
  }
  if (node.type === 'quote') {
    return (
      textHeight(
        node.text,
        widthCssPx,
        typography.quoteSizeCssPx * fontScale,
        typography.lineHeight,
      ) + 72
    )
  }
  if (node.type === 'figure') {
    const caption = paper.nodes.find(
      (candidate) => candidate.id === node.relationships.caption,
    )
    const captionText = caption?.type === 'caption' ? caption.text : ''
    const pipelineHeight = target === 'paperProMove' ? 126 : 40
    return (
      140 +
      pipelineHeight +
      textHeight(
        `${node.title}. ${captionText}`,
        widthCssPx,
        12 * fontScale,
        1.6,
      )
    )
  }
  if (node.type === 'caption') return 0
  if (node.type === 'footnote') {
    return (
      textHeight(
        `${node.label}. ${node.text}`,
        widthCssPx,
        12 * fontScale,
        typography.lineHeight,
      ) + 28
    )
  }
  return 0
}

function createLayoutItems(
  paper: ResearchPaper,
  target: TargetProfileId,
  constraints: PaginationConstraints,
  fontScale: number,
) {
  const captionIds = new Set(
    paper.nodes
      .filter((node) => node.type === 'figure')
      .map((node) => node.relationships.caption),
  )
  const items: LayoutItem[] = []

  for (const node of paper.nodes) {
    if (node.type === 'caption' && captionIds.has(node.id)) continue

    if (node.type === 'paragraph') {
      const lineHeightCssPx =
        getTargetProfile(target).typography.bodySizeCssPx *
        getTargetProfile(target).typography.lineHeight *
        fontScale
      const lines = estimateLineRanges(
        node.text,
        charactersPerLine(
          constraints.columnWidthCssPx,
          getTargetProfile(target).typography.bodySizeCssPx * fontScale,
        ),
      )
      items.push({
        canonicalIds: [node.id],
        nodeTypes: [node.type],
        kind: 'paragraph',
        estimatedHeightCssPx:
          lines.length * lineHeightCssPx + BLOCK_MARGIN_CSS_PX,
        lineHeightCssPx,
        lines,
        keepWithNext: false,
        span: 'column',
      })
      continue
    }

    if (node.type === 'figure') {
      items.push({
        canonicalIds: [node.id, node.relationships.caption],
        nodeTypes: ['figure', 'caption'],
        kind: 'atomic',
        estimatedHeightCssPx: estimateAtomicHeight(
          node,
          paper,
          target,
          node.type === 'figure' && target === 'print'
            ? constraints.contentWidthCssPx
            : constraints.columnWidthCssPx,
          fontScale,
        ),
        keepWithNext: false,
        span: target === 'print' ? 'page' : 'column',
      })
      continue
    }

    items.push({
      canonicalIds: [node.id],
      nodeTypes: [node.type],
      kind: 'atomic',
      estimatedHeightCssPx: estimateAtomicHeight(
        node,
        paper,
        target,
        constraints.columnWidthCssPx,
        fontScale,
      ),
      keepWithNext: node.type === 'heading',
      span: 'column',
    })
  }

  return items
}

function createContinuousResult(
  paper: ResearchPaper,
  target: TargetProfileId,
  constraints: PaginationConstraints,
): PaginationLayoutResult {
  const fragments = paper.nodes.map<PaginationFragment>((node, order) => ({
    id: `${node.id}#fragment-1`,
    canonicalId: node.id,
    nodeType: node.type,
    index: 0,
    page: 1,
    region: 0,
    span: 'column',
    estimatedHeightCssPx: 0,
    ...(node.type === 'paragraph'
      ? { textRange: { start: 0, end: node.text.length } }
      : {}),
    decision: {
      outcome: 'placed',
      reason: `Continuous flow preserves canonical order ${order}.`,
    },
    violations: [],
  }))

  return {
    target,
    policyVersion: PAGINATION_POLICY_VERSION,
    mode: 'continuous',
    constraints,
    pages: [
      {
        number: 1,
        regions: [
          {
            index: 0,
            capacityCssPx: Number.POSITIVE_INFINITY,
            usedCssPx: 0,
            fragments,
          },
        ],
        spanningFragments: [],
      },
    ],
    nodes: paper.nodes.map((node, index) => ({
      canonicalId: node.id,
      policy: NODE_PAGINATION_POLICIES[node.type],
      fragments: [fragments[index]],
      decision: fragments[index].decision,
      violations: [],
    })),
    violations: [],
    finalPageCount: null,
    pageCountStatus: 'not-applicable',
  }
}

type RegionPrefixSnapshot = {
  anchorCanonicalId: string
  page: number
  region: number
  signature: string
  fragmentSignatures: string[]
}

function fragmentStabilitySignature(fragment: PaginationFragment) {
  return JSON.stringify({
    id: fragment.id,
    page: fragment.page,
    region: fragment.region,
    span: fragment.span,
    estimatedHeightCssPx: fragment.estimatedHeightCssPx,
    textRange: fragment.textRange ?? null,
    outcome: fragment.decision.outcome,
  })
}

function regionPrefixSnapshot(
  result: Pick<PaginationResult, 'pages'>,
  anchorCanonicalId: string,
): RegionPrefixSnapshot {
  const regions = result.pages.flatMap((page) =>
    page.spanningFragments.length > 0
      ? [
          {
            page: page.number,
            region: 0,
            fragments: page.spanningFragments,
          },
        ]
      : page.regions.map((region) => ({
          page: page.number,
          region: region.index,
          fragments: region.fragments,
        })),
  )
  const anchorRegionIndex = regions.findIndex((region) =>
    region.fragments.some(
      (fragment) => fragment.canonicalId === anchorCanonicalId,
    ),
  )
  if (anchorRegionIndex < 0) {
    throw new Error(
      `Pagination omitted current-region anchor ${anchorCanonicalId}`,
    )
  }

  const anchorRegion = regions[anchorRegionIndex]
  const fragments = regions
    .slice(0, anchorRegionIndex + 1)
    .flatMap((region) => region.fragments)
  const fragmentSignatures = fragments.map(fragmentStabilitySignature)
  const signature = JSON.stringify({
    anchorCanonicalId,
    page: anchorRegion.page,
    region: anchorRegion.region,
    fragmentSignatures,
  })

  return {
    anchorCanonicalId,
    page: anchorRegion.page,
    region: anchorRegion.region,
    signature,
    fragmentSignatures,
  }
}

function baselineCurrentRegionStability(
  result: Pick<PaginationResult, 'pages'>,
  anchorCanonicalId: string,
): PaginationResult['currentRegionStability'] {
  const snapshot = regionPrefixSnapshot(result, anchorCanonicalId)
  return {
    metric: 'anchored-region-prefix',
    status: 'not-compared',
    anchorCanonicalId,
    page: snapshot.page,
    region: snapshot.region,
    signature: snapshot.signature,
    referenceSignature: null,
    stable: null,
    comparedFragmentCount: 0,
    stableFragmentCount: 0,
  }
}

export function measureCurrentRegionStability(
  reference: PaginationResult,
  current: PaginationResult,
  anchorCanonicalId: string,
): PaginationResult['currentRegionStability'] {
  const previous = regionPrefixSnapshot(reference, anchorCanonicalId)
  const next = regionPrefixSnapshot(current, anchorCanonicalId)
  const comparedFragmentCount = Math.max(
    previous.fragmentSignatures.length,
    next.fragmentSignatures.length,
  )
  let stableFragmentCount = 0

  while (
    stableFragmentCount < previous.fragmentSignatures.length &&
    stableFragmentCount < next.fragmentSignatures.length &&
    previous.fragmentSignatures[stableFragmentCount] ===
      next.fragmentSignatures[stableFragmentCount]
  ) {
    stableFragmentCount += 1
  }

  const stable = previous.signature === next.signature
  return {
    metric: 'anchored-region-prefix',
    status: stable ? 'stable' : 'unstable',
    anchorCanonicalId,
    page: next.page,
    region: next.region,
    signature: next.signature,
    referenceSignature: previous.signature,
    stable,
    comparedFragmentCount,
    stableFragmentCount,
  }
}

export function paginateResearchPaper(
  paper: ResearchPaper,
  target: TargetProfileId,
  overrides: PaginationOverrides = {},
): PaginationResult {
  const constraints = getPaginationConstraints(paper, target, overrides)
  if (
    constraints.heightCssPx === null ||
    constraints.contentHeightCssPx === null
  ) {
    const result = createContinuousResult(paper, target, constraints)
    return {
      ...result,
      currentRegionStability: baselineCurrentRegionStability(
        result,
        paper.nodes[0].id,
      ),
    }
  }

  const items = createLayoutItems(
    paper,
    target,
    constraints,
    overrides.fontScale ?? 1,
  )
  const pages: PaginationPage[] = []
  const fragmentsByNode = new Map<string, PaginationFragment[]>()
  const violations: PaginationViolation[] = []

  const ensurePage = (number: number) => {
    while (pages.length < number) {
      const pageNumber = pages.length + 1
      const headerReserve =
        pageNumber === 1 ? constraints.firstPageHeaderHeightCssPx : 0
      const capacity = Math.max(
        1,
        constraints.contentHeightCssPx! - headerReserve,
      )
      pages.push({
        number: pageNumber,
        regions: Array.from({ length: constraints.columns }, (_, index) => ({
          index,
          capacityCssPx: capacity,
          usedCssPx: 0,
          fragments: [],
        })),
        spanningFragments: [],
      })
    }
    return pages[number - 1]
  }

  let pageNumber = 1
  let regionIndex = 0
  ensurePage(pageNumber)

  const currentRegion = () => ensurePage(pageNumber).regions[regionIndex]
  const advanceRegion = () => {
    if (regionIndex + 1 < constraints.columns) {
      regionIndex += 1
    } else {
      pageNumber += 1
      regionIndex = 0
      ensurePage(pageNumber)
    }
  }
  const pageHasContent = () =>
    ensurePage(pageNumber).regions.some((region) => region.usedCssPx > 0) ||
    ensurePage(pageNumber).spanningFragments.length > 0
  const addFragment = (fragment: PaginationFragment) => {
    const nodeFragments = fragmentsByNode.get(fragment.canonicalId) ?? []
    nodeFragments.push(fragment)
    fragmentsByNode.set(fragment.canonicalId, nodeFragments)
    if (fragment.span === 'page') {
      ensurePage(fragment.page).spanningFragments.push(fragment)
    } else {
      ensurePage(fragment.page).regions[fragment.region].fragments.push(
        fragment,
      )
      ensurePage(fragment.page).regions[fragment.region].usedCssPx +=
        fragment.estimatedHeightCssPx
    }
  }
  const minimumItemHeight = (item: LayoutItem | undefined) => {
    if (!item) return 0
    if (item.kind === 'paragraph') {
      const minimumLines =
        NODE_PAGINATION_POLICIES.paragraph.minimumStartLines ?? 2
      return (
        (item.lineHeightCssPx ?? 0) *
          Math.min(item.lines?.length ?? minimumLines, minimumLines) +
        BLOCK_MARGIN_CSS_PX
      )
    }
    return item.estimatedHeightCssPx
  }

  for (const [itemIndex, item] of items.entries()) {
    if (item.span === 'page') {
      if (pageHasContent()) {
        pageNumber += 1
        regionIndex = 0
        ensurePage(pageNumber)
      }

      // Page one may already reserve space for the document header even when
      // the spanning object is the first canonical node. Use the page's real
      // region capacity so the plan matches the rendered flex region.
      const capacity = ensurePage(pageNumber).regions[0].capacityCssPx
      const requiredScale = Math.min(1, capacity / item.estimatedHeightCssPx)
      const fallback =
        requiredScale < 1
          ? {
              code: 'scale-atomic-object' as const,
              reason: `The page-spanning atomic object is ${Math.ceil(item.estimatedHeightCssPx - capacity)} CSS px taller than the content region.`,
              scale: Math.max(MINIMUM_ATOMIC_SCALE, requiredScale),
            }
          : undefined
      const itemViolations: PaginationViolation[] = []
      if (requiredScale < MINIMUM_ATOMIC_SCALE) {
        const violation = {
          code: 'atomic-object-too-tall' as const,
          severity: 'error' as const,
          message: `Atomic object ${item.canonicalIds[0]} cannot fit without scaling below ${MINIMUM_ATOMIC_SCALE}.`,
        }
        itemViolations.push(violation)
        violations.push(violation)
      }

      for (const [memberIndex, canonicalId] of item.canonicalIds.entries()) {
        addFragment({
          id: `${canonicalId}#fragment-1`,
          canonicalId,
          nodeType: item.nodeTypes[memberIndex],
          index: 0,
          page: pageNumber,
          region: 0,
          span: 'page',
          estimatedHeightCssPx:
            memberIndex === 0
              ? Math.min(item.estimatedHeightCssPx, capacity)
              : 0,
          decision: {
            outcome: fallback ? 'atomic-fallback' : 'kept-with-related',
            reason:
              memberIndex === 0
                ? 'The full-span figure occupies a dedicated page and remains atomic with its caption.'
                : 'The caption stays on the same dedicated page as its figure.',
          },
          violations: itemViolations,
          ...(fallback ? { fallback } : {}),
        })
      }

      pageNumber += 1
      regionIndex = 0
      ensurePage(pageNumber)
      continue
    }

    if (item.kind === 'paragraph') {
      const lines = item.lines ?? []
      const lineHeight = item.lineHeightCssPx ?? 1
      const minimumStart =
        NODE_PAGINATION_POLICIES.paragraph.minimumStartLines ?? 2
      const minimumEnd = NODE_PAGINATION_POLICIES.paragraph.minimumEndLines ?? 2
      let lineIndex = 0

      while (lineIndex < lines.length) {
        const region = currentRegion()
        const remainingHeight = region.capacityCssPx - region.usedCssPx
        const remainingLines = lines.length - lineIndex
        const maximumFittingLines = Math.floor(
          (remainingHeight - BLOCK_MARGIN_CSS_PX) / lineHeight,
        )
        let fittingLines = Math.floor(
          (remainingHeight - BLOCK_MARGIN_CSS_PX) / lineHeight,
        )
        const fragmentViolations: PaginationViolation[] = []

        const wholeParagraphFits = remainingLines <= fittingLines
        if (wholeParagraphFits) fittingLines = remainingLines
        if (
          remainingLines > fittingLines &&
          remainingLines - fittingLines < minimumEnd
        ) {
          fittingLines = remainingLines - minimumEnd
        }
        const wouldFragment = fittingLines < remainingLines
        if (
          fittingLines < 1 ||
          (wouldFragment && fittingLines < minimumStart)
        ) {
          if (region.usedCssPx > 0) {
            advanceRegion()
            continue
          }

          // An empty region that cannot satisfy the minimum split policy will
          // never improve by advancing to another identical page. Emit an
          // explicit violation and make bounded progress instead of looping.
          fittingLines = Math.min(
            remainingLines,
            Math.max(1, maximumFittingLines),
          )
          const violation = {
            code: 'minimum-fragment-lines' as const,
            severity: 'error' as const,
            message: `Paragraph ${item.canonicalIds[0]} cannot satisfy the ${minimumStart}/${minimumEnd} minimum fragment-line policy in a ${Math.round(region.capacityCssPx)} CSS px region.`,
          }
          fragmentViolations.push(violation)
          violations.push(violation)
        }

        const fragmentLines = lines.slice(lineIndex, lineIndex + fittingLines)
        const nodeFragments = fragmentsByNode.get(item.canonicalIds[0]) ?? []
        const isFragmented = lineIndex > 0 || fittingLines < lines.length
        addFragment({
          id: `${item.canonicalIds[0]}#fragment-${nodeFragments.length + 1}`,
          canonicalId: item.canonicalIds[0],
          nodeType: 'paragraph',
          index: nodeFragments.length,
          page: pageNumber,
          region: regionIndex,
          span: 'column',
          estimatedHeightCssPx: fittingLines * lineHeight + BLOCK_MARGIN_CSS_PX,
          textRange: {
            start: fragmentLines[0].start,
            end: fragmentLines[fragmentLines.length - 1].end,
          },
          decision: {
            outcome: isFragmented ? 'fragmented' : 'placed',
            reason: isFragmented
              ? `Paragraph split at an estimated line boundary with at least ${minimumStart}/${minimumEnd} lines at the fragment edges.`
              : 'The paragraph fits in the current finite-height region.',
          },
          violations: fragmentViolations,
        })
        lineIndex += fittingLines
        if (lineIndex < lines.length) advanceRegion()
      }
      continue
    }

    const nextItem = items[itemIndex + 1]
    const keepReserve = item.keepWithNext ? minimumItemHeight(nextItem) : 0
    let region = currentRegion()
    if (
      item.estimatedHeightCssPx + keepReserve >
        region.capacityCssPx - region.usedCssPx &&
      (region.usedCssPx > 0 ||
        item.estimatedHeightCssPx + keepReserve <=
          constraints.contentHeightCssPx)
    ) {
      advanceRegion()
      region = currentRegion()
    }

    const requiredScale = Math.min(
      1,
      (region.capacityCssPx - region.usedCssPx) / item.estimatedHeightCssPx,
    )
    const fallback =
      requiredScale < 1
        ? {
            code: 'scale-atomic-object' as const,
            reason: `Atomic object ${item.canonicalIds[0]} exceeds an empty finite-height region.`,
            scale: Math.max(MINIMUM_ATOMIC_SCALE, requiredScale),
          }
        : undefined
    const itemViolations: PaginationViolation[] = []
    if (requiredScale < MINIMUM_ATOMIC_SCALE) {
      const violation = {
        code: 'atomic-object-too-tall' as const,
        severity: 'error' as const,
        message: `Atomic object ${item.canonicalIds[0]} cannot fit without scaling below ${MINIMUM_ATOMIC_SCALE}.`,
      }
      itemViolations.push(violation)
      violations.push(violation)
    }

    for (const [memberIndex, canonicalId] of item.canonicalIds.entries()) {
      addFragment({
        id: `${canonicalId}#fragment-1`,
        canonicalId,
        nodeType: item.nodeTypes[memberIndex],
        index: 0,
        page: pageNumber,
        region: regionIndex,
        span: 'column',
        estimatedHeightCssPx:
          memberIndex === 0
            ? item.estimatedHeightCssPx * (fallback?.scale ?? 1)
            : 0,
        decision: {
          outcome: fallback
            ? 'atomic-fallback'
            : item.keepWithNext
              ? 'kept-with-next'
              : item.canonicalIds.length > 1
                ? 'kept-with-related'
                : 'placed',
          reason: fallback
            ? fallback.reason
            : item.keepWithNext
              ? 'The heading remains atomic and shares a region with the start of the following object.'
              : memberIndex === 1
                ? 'The caption stays in the same region as its figure.'
                : item.canonicalIds.length > 1
                  ? 'The figure remains atomic with its caption.'
                  : 'The atomic object fits in the current finite-height region.',
        },
        violations: itemViolations,
        ...(fallback ? { fallback } : {}),
      })
    }
  }

  while (
    pages.length > 1 &&
    pages.at(-1)?.regions.every((region) => region.fragments.length === 0) &&
    pages.at(-1)?.spanningFragments.length === 0
  ) {
    pages.pop()
  }

  const nodes = paper.nodes.map<PaginatedNode>((node) => {
    const fragments = fragmentsByNode.get(node.id) ?? []
    const decision = fragments[0]?.decision ?? {
      outcome: 'placed' as const,
      reason: 'The node has no visible box and follows its related object.',
    }
    return {
      canonicalId: node.id,
      policy: NODE_PAGINATION_POLICIES[node.type],
      fragments,
      decision,
      violations: fragments.flatMap((fragment) => fragment.violations),
      ...(fragments[0]?.fallback ? { fallback: fragments[0].fallback } : {}),
    }
  })
  const result: PaginationLayoutResult = {
    target,
    policyVersion: PAGINATION_POLICY_VERSION,
    mode: 'finite',
    constraints,
    pages,
    nodes,
    violations,
    finalPageCount: pages.length,
    pageCountStatus: 'final',
  }
  return {
    ...result,
    currentRegionStability: baselineCurrentRegionStability(
      result,
      paper.nodes[0].id,
    ),
  }
}
