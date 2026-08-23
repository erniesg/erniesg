import { createAssetBundle, type AssetDescriptor } from './asset-bundle'
import {
  PUBLICATION_GRAPH_VERSION,
  publicationGraphSchema,
  type PublicationInlineRun,
  type PublicationNode,
} from './schema'
import {
  PUBLICATION_SOURCE_ADAPTER_VERSION,
  type AdapterDiagnostic,
  type PublicationSourceAdapter,
  type PublicationSourceResult,
} from './source-adapter'
import type {
  StructBlock,
  StructDocument,
  StructInline,
  StructRelationship,
  StructTableCell,
} from '../../packages/struct/src/types'

export const STRUCT_PUBLICATION_ADAPTER_ID = 'struct-document' as const
export const STRUCT_PUBLICATION_MAPPING_VERSION = '1.0.0' as const

type Severity = AdapterDiagnostic['severity']

function safeId(value: string, fallback: string) {
  const normalized = value.replace(/[^A-Za-z0-9._:-]+/g, '-')
  if (!normalized) return fallback
  return /^[A-Za-z0-9]/.test(normalized) ? normalized : `id-${normalized}`
}

function uniqueId(value: string, used: Set<string>) {
  const base = safeId(value, 'node')
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) candidate = `${base}-${suffix++}`
  used.add(candidate)
  return candidate
}

function assertUniqueSourceIds(
  kind: 'BLOCK' | 'RELATIONSHIP' | 'ASSET',
  ids: string[],
) {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`STRUCT_DUPLICATE_${kind}_ID:${id}`)
    seen.add(id)
  }
}

function localeFor(document: StructDocument) {
  const candidate = document.metadata.language ?? 'en'
  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? 'en'
  } catch {
    return 'en'
  }
}

function dateOnly(value: string | undefined) {
  if (!value) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  return month >= 1 && day >= 1 && day <= (daysInMonth[month - 1] ?? 0)
    ? value
    : undefined
}

function dateTime(value: string | undefined) {
  if (!value) return undefined
  const match =
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(
      value,
    )
  if (!match || !dateOnly(match[1]) || !Number.isFinite(Date.parse(value)))
    return undefined
  const offset = /([+-])(\d{2}):?(\d{2})$/.exec(value)
  if (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59))
    return undefined
  return value
}

function parsePublicationGraph(value: unknown) {
  const parsed = publicationGraphSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'graph'}:${issue.message}`)
    .join(';')
  throw new Error(`STRUCT_PUBLICATION_SCHEMA_INVALID:${details}`)
}

function direction(
  value: StructDocument['metadata']['baseDirection'],
): 'ltr' | 'rtl' | 'auto' {
  return value === 'ltr' || value === 'rtl' ? value : 'auto'
}

function basename(value: string) {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? ''
  const part = withoutQuery.split(/[\\/]/).at(-1)
  return part && /^[^\u0000-\u001f\u007f/\\]+$/.test(part) ? part : undefined
}

function isExternalHref(value: string) {
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:', 'mailto:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

function inlineStyle(
  inline: StructInline,
): Omit<PublicationInlineRun, 'start' | 'end'> {
  return {
    ...(inline.bold ? { bold: true } : {}),
    ...(inline.italic ? { italic: true } : {}),
    ...(inline.verticalAlign ? { verticalAlign: inline.verticalAlign } : {}),
    ...(inline.compactMathAtom ? { compactMathAtom: true } : {}),
  }
}

function relationshipStatusIsResolved(
  relationship: StructRelationship | undefined,
) {
  return relationship?.status === 'matched'
}

function sourceType(
  document: StructDocument,
): 'astro' | 'payload' | 'docx' | 'pdf' | 'research-paper' {
  if (document.source.format === 'pdf') return 'pdf'
  if (document.source.format === 'docx') return 'docx'
  return 'research-paper'
}

/**
 * Convert the source-neutral STRUCT document into the app-owned publication
 * graph.  Page geometry, recovery state, model receipts, and provider
 * evidence are deliberately read only for diagnostics and never projected.
 */
export function adaptStructDocument(
  document: StructDocument,
): PublicationSourceResult {
  const diagnostics: AdapterDiagnostic[] = []
  const sourceId =
    basename(document.source.fileName) ??
    `struct-${document.source.sha256.slice(0, 16)}`
  const addDiagnostic = (
    severity: Severity,
    code: string,
    message: string,
    nodeId?: string,
  ) => {
    diagnostics.push({
      severity,
      code,
      message,
      sourceId,
      ...(nodeId ? { nodeId } : {}),
    })
  }

  assertUniqueSourceIds(
    'BLOCK',
    document.blocks.map((block) => block.id),
  )
  assertUniqueSourceIds(
    'RELATIONSHIP',
    document.relationships.map((relationship) => relationship.id),
  )
  assertUniqueSourceIds(
    'ASSET',
    document.assets.map((asset) => asset.id),
  )

  for (const diagnostic of document.diagnostics) {
    addDiagnostic(
      diagnostic.severity,
      `struct-${diagnostic.category}`,
      `${diagnostic.title}: ${diagnostic.message}`,
    )
  }

  const locale = localeFor(document)
  const directionValue = direction(document.metadata.baseDirection)
  const graphId = uniqueId(
    document.documentId ?? `struct-${document.source.sha256.slice(0, 16)}`,
    new Set(),
  )
  const editionId = uniqueId(`${graphId}-${locale}`, new Set())
  const orderedBlocks = document.blocks
    .map((block, index) => ({ block, index }))
    .sort(
      (left, right) =>
        left.block.order - right.block.order || left.index - right.index,
    )

  const usedNodeIds = new Set<string>()
  const nodeIds = new Map<string, string>()
  for (const { block } of orderedBlocks)
    nodeIds.set(block.id, uniqueId(block.id, usedNodeIds))
  const nonGraphBlockIds = new Set(
    document.blocks
      .filter((block) => block.kind === 'furniture' || block.kind === 'unknown')
      .map((block) => block.id),
  )
  const relationshipIds = new Map<string, string>()
  for (const relationship of document.relationships) {
    relationshipIds.set(relationship.id, uniqueId(relationship.id, usedNodeIds))
  }
  const relationships = new Map(
    document.relationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  )
  const baseGraphBlockIds = new Set(
    document.blocks
      .filter((block) => {
        if (
          block.kind === 'furniture' ||
          block.kind === 'unknown' ||
          block.kind === 'caption'
        )
          return false
        if (
          [
            'heading',
            'paragraph',
            'quote',
            'code',
            'equation',
            'footnote',
            'endnote',
            'list-item',
          ].includes(block.kind)
        )
          return Boolean(block.text)
        if (block.kind === 'figure') return Boolean(block.label || block.text)
        if (block.kind === 'table')
          return Boolean(
            block.table &&
            block.table.rows > 0 &&
            block.table.cells.some(
              (cell) =>
                cell.row >= 0 &&
                cell.row < block.table!.rows &&
                cell.column >= 0 &&
                cell.column < block.table!.columns,
            ),
          )
        return false
      })
      .map((block) => block.id),
  )
  const blocksById = new Map(document.blocks.map((block) => [block.id, block]))
  const captionParentKinds = new Set(['figure', 'table', 'equation', 'media'])
  const captionLinks = new Map<
    string,
    { captionId: string; parentId: string }
  >()
  const captionIdsByParent = new Map<string, string>()
  const captionParentsByCaption = new Map<string, string>()
  const graphBlockIds = new Set(baseGraphBlockIds)
  const knownAssetIds = new Set(document.assets.map((asset) => asset.id))
  const captionEndpointsFor = (relationship: StructRelationship) => {
    const fromBlock = blocksById.get(relationship.from)
    if (!fromBlock) return undefined
    if (relationship.kind === 'caption') {
      const toBlock =
        relationship.to.length === 1
          ? blocksById.get(relationship.to[0]!)
          : undefined
      return captionParentKinds.has(fromBlock.kind) &&
        toBlock?.kind === 'caption'
        ? { captionId: toBlock.id, parentId: fromBlock.id }
        : undefined
    }
    if (
      !['figure', 'table', 'equation'].includes(relationship.kind) ||
      fromBlock.kind !== relationship.kind
    )
      return undefined
    const captionTargets = relationship.to.filter(
      (target) => blocksById.get(target)?.kind === 'caption',
    )
    const relatedAssets = relationship.to.filter((target) =>
      knownAssetIds.has(target),
    )
    return captionTargets.length === 1 &&
      relatedAssets.length > 0 &&
      relationship.to.length === relatedAssets.length + 1
      ? { captionId: captionTargets[0]!, parentId: fromBlock.id }
      : undefined
  }
  for (const relationship of document.relationships) {
    if (relationship.status !== 'matched') continue
    const endpoints = captionEndpointsFor(relationship)
    if (!endpoints) {
      if (
        relationship.kind === 'caption' &&
        (!blocksById.has(relationship.from) ||
          relationship.to.length !== 1 ||
          !blocksById.has(relationship.to[0]!))
      )
        continue
      const mentionsCaption = relationship.to.some(
        (target) => blocksById.get(target)?.kind === 'caption',
      )
      const isTypedCaptionRelation =
        ['figure', 'table', 'equation'].includes(relationship.kind) &&
        blocksById.get(relationship.from)?.kind === relationship.kind &&
        mentionsCaption
      if (relationship.kind !== 'caption' && !isTypedCaptionRelation) continue
      addDiagnostic(
        'warning',
        'invalid-caption-relationship',
        `Caption relationship ${relationship.id} did not connect one caption to one figure, table, equation, or media node and was omitted.`,
        relationship.from,
      )
      continue
    }
    if (
      captionIdsByParent.has(endpoints.parentId) ||
      captionParentsByCaption.has(endpoints.captionId)
    ) {
      addDiagnostic(
        'warning',
        'invalid-caption-relationship',
        `Caption relationship ${relationship.id} would create an ambiguous caption owner and was omitted.`,
        relationship.from,
      )
      continue
    }
    captionLinks.set(relationship.id, endpoints)
    captionIdsByParent.set(endpoints.parentId, endpoints.captionId)
    captionParentsByCaption.set(endpoints.captionId, endpoints.parentId)
    if (
      baseGraphBlockIds.has(endpoints.parentId) &&
      blocksById.get(endpoints.captionId)?.text
    )
      graphBlockIds.add(endpoints.captionId)
  }
  const mappedNode = (id: string) =>
    nonGraphBlockIds.has(id) || !graphBlockIds.has(id)
      ? undefined
      : nodeIds.get(id)
  const mappedRelationship = (id: string) => relationshipIds.get(id)
  const inlineRelationshipIds = new Map<StructInline, string>()
  const occurrenceCounts = new Map<string, number>()
  for (const { block } of orderedBlocks) {
    if (!graphBlockIds.has(block.id)) continue
    for (const inline of block.inline) {
      const sourceRelationshipId = inline.relationshipId
      const relationship = sourceRelationshipId
        ? relationships.get(sourceRelationshipId)
        : undefined
      const mapped = sourceRelationshipId
        ? mappedRelationship(sourceRelationshipId)
        : undefined
      if (!sourceRelationshipId || !relationship || !mapped) continue
      const count = (occurrenceCounts.get(sourceRelationshipId) ?? 0) + 1
      occurrenceCounts.set(sourceRelationshipId, count)
      inlineRelationshipIds.set(
        inline,
        count === 1
          ? mapped
          : uniqueId(`${mapped}-occurrence-${count}`, usedNodeIds),
      )
    }
  }

  for (const relationship of document.relationships) {
    if (relationship.status === 'matched') continue
    const appearsInline = document.blocks.some((block) =>
      block.inline.some((inline) => inline.relationshipId === relationship.id),
    )
    if (appearsInline || relationship.kind === 'caption') continue
    const prefix =
      relationship.status === 'source-preserved'
        ? 'source-preserved'
        : 'unresolved'
    addDiagnostic(
      'warning',
      `${prefix}-${relationship.kind}`,
      `Relationship ${relationship.id} (${relationship.kind}) was ${relationship.status} and was not projected as a link.`,
      relationship.from,
    )
  }

  const captionParent = new Map<string, string>()
  for (const relationship of document.relationships) {
    if (relationship.status === 'matched') {
      const endpoints = captionLinks.get(relationship.id)
      if (endpoints) captionParent.set(endpoints.captionId, endpoints.parentId)
    } else if (relationship.kind === 'caption') {
      addDiagnostic(
        'warning',
        'unresolved-caption',
        `Caption relationship ${relationship.id} was ${relationship.status} and was not linked.`,
      )
    }
  }

  const mapInline = (
    text: string,
    source: StructInline[],
    ownerId: string,
  ): PublicationInlineRun[] => {
    const result: PublicationInlineRun[] = []
    for (const inline of source) {
      if (
        inline.start < 0 ||
        inline.end <= inline.start ||
        inline.end > text.length
      ) {
        addDiagnostic(
          'warning',
          'lossy-inline-range',
          `Inline range ${inline.start}:${inline.end} was outside ${ownerId} and was omitted.`,
          ownerId,
        )
        continue
      }
      const relationship = inline.relationshipId
        ? relationships.get(inline.relationshipId)
        : undefined
      const targets = inline.targetIds ?? []
      const mappedTargets = targets
        .map(mappedNode)
        .filter((target): target is string => Boolean(target))
      const hasMissingTarget = mappedTargets.length !== targets.length
      const hasMissingRelationship = Boolean(
        inline.relationshipId && !relationship,
      )
      const relationshipHasMissingTarget = Boolean(
        relationship &&
        (relationship.to.length === 0 ||
          relationship.to.some((target) => !mappedNode(target))),
      )
      const hasUnavailableMatchedTarget = Boolean(
        relationship?.status === 'matched' &&
        (hasMissingTarget ||
          targets.length === 0 ||
          relationshipHasMissingTarget),
      )
      if (hasMissingRelationship)
        addDiagnostic(
          'warning',
          'unresolved-relationship',
          `Inline relationship ${inline.relationshipId} in ${ownerId} had no matching source relationship.`,
          ownerId,
        )
      const hasRoleSpecificTargetDiagnostic =
        inline.semanticRole === 'citation' ||
        inline.semanticRole === 'cross-reference' ||
        inline.semanticRole === 'note-reference'
      if (
        hasMissingTarget &&
        !hasRoleSpecificTargetDiagnostic &&
        !hasUnavailableMatchedTarget
      )
        addDiagnostic(
          'warning',
          'unresolved-relationship-target',
          `Inline target in ${ownerId} was unavailable and was source-preserved without a destination.`,
          ownerId,
        )
      if (hasUnavailableMatchedTarget)
        addDiagnostic(
          'warning',
          'unresolved-relationship-target',
          `Matched relationship ${inline.relationshipId} in ${ownerId} had an unavailable target.`,
          ownerId,
        )
      const preservesGenericRelationship = Boolean(
        relationship &&
        !hasMissingTarget &&
        !hasUnavailableMatchedTarget &&
        mappedTargets.length,
      )
      if (
        relationship &&
        relationship.status !== 'matched' &&
        preservesGenericRelationship &&
        inline.semanticRole !== 'citation' &&
        inline.semanticRole !== 'cross-reference' &&
        inline.semanticRole !== 'note-reference'
      )
        addDiagnostic(
          'warning',
          'unresolved-relationship-status',
          `Inline relationship ${inline.relationshipId} in ${ownerId} was ${relationship.status}; its safe source targets were preserved.`,
          ownerId,
        )
      const resolved = relationship
        ? relationshipStatusIsResolved(relationship) &&
          !hasUnavailableMatchedTarget
        : !hasMissingTarget && !hasMissingRelationship
      const base = {
        start: inline.start,
        end: inline.end,
        ...inlineStyle(inline),
      }

      if (inline.semanticRole === 'note-reference') {
        const noteTarget = mappedTargets.find((target) => {
          const block = document.blocks.find(
            (candidate) => mappedNode(candidate.id) === target,
          )
          return block?.kind === 'footnote' || block?.kind === 'endnote'
        })
        if (
          resolved &&
          !hasMissingTarget &&
          noteTarget &&
          (relationship?.kind === 'footnote' ||
            relationship?.kind === 'endnote')
        ) {
          result.push({
            ...base,
            href: `#${noteTarget}`,
            relationshipId:
              inlineRelationshipIds.get(inline) ??
              mappedRelationship(inline.relationshipId ?? '') ??
              safeId(
                inline.relationshipId ?? `${ownerId}-note`,
                `${ownerId}-note`,
              ),
            semanticRole: 'cross-reference',
            targetIds: [noteTarget],
          })
        } else {
          addDiagnostic(
            'warning',
            'unresolved-note-reference',
            `Note reference in ${ownerId} was source-preserved without a destination.`,
            ownerId,
          )
          result.push(base)
        }
        continue
      }

      if (
        (inline.semanticRole === 'citation' ||
          inline.semanticRole === 'cross-reference') &&
        (!resolved || hasMissingTarget || !mappedTargets.length)
      ) {
        addDiagnostic(
          'warning',
          'unresolved-cross-reference',
          `The ${inline.semanticRole} in ${ownerId} was source-preserved without an unverified destination.`,
          ownerId,
        )
        result.push(base)
        continue
      }

      const href = inline.href
        ? inline.href.startsWith('#')
          ? mappedNode(inline.href.slice(1))
            ? `#${mappedNode(inline.href.slice(1))}`
            : undefined
          : isExternalHref(inline.href)
            ? inline.href
            : undefined
        : undefined
      if (inline.href && !href)
        addDiagnostic(
          'warning',
          'unresolved-link',
          `Link in ${ownerId} was source-preserved without an unsafe or unresolved destination.`,
          ownerId,
        )
      result.push({
        ...base,
        ...(href ? { href } : {}),
        ...(inline.annotationId
          ? {
              annotationId: safeId(
                inline.annotationId,
                `${ownerId}-annotation`,
              ),
            }
          : {}),
        ...(inline.relationshipId && (resolved || preservesGenericRelationship)
          ? {
              relationshipId:
                inlineRelationshipIds.get(inline) ??
                mappedRelationship(inline.relationshipId),
            }
          : {}),
        ...(inline.semanticRole ? { semanticRole: inline.semanticRole } : {}),
        ...(mappedTargets.length && (resolved || preservesGenericRelationship)
          ? { targetIds: mappedTargets }
          : {}),
      })
    }
    return result
  }

  const common = (block: StructBlock) => ({
    id: nodeIds.get(block.id)!,
    locale,
    direction: directionValue,
    requirement: 'required' as const,
    importance:
      block.kind === 'caption' ||
      block.kind === 'footnote' ||
      block.kind === 'endnote'
        ? ('supporting' as const)
        : ('essential' as const),
    provenance: {
      adapterId: STRUCT_PUBLICATION_ADAPTER_ID,
      sourceId,
      sourceRevision: document.source.sha256,
      evidence: [],
    },
    accessibility: { decorative: false },
    variants: [],
    permittedTransformationIds: [],
    edition: { editionId },
  })

  const captionIdFor = (block: StructBlock) => {
    const captionId = captionIdsByParent.get(block.id)
    return captionId ? mappedNode(captionId) : undefined
  }

  const mapTableCell = (
    cell: StructTableCell,
    ownerId: string,
    cellId: string,
  ) => ({
    ...(cell.id ? { id: cellId } : {}),
    text: cell.text,
    headerScope:
      cell.headerScope === 'column' || cell.headerScope === 'row'
        ? cell.headerScope
        : null,
    columnSpan: cell.columnSpan,
    rowSpan: cell.rowSpan,
    ...(cell.headerScope === 'colgroup' || cell.headerScope === 'rowgroup'
      ? (addDiagnostic(
          'warning',
          'lossy-table-header-scope',
          `Table cell ${cell.id} used unsupported ${cell.headerScope} scope; it was projected to an unscoped cell.`,
          ownerId,
        ),
        {})
      : {}),
    ...(cell.inline.length
      ? (addDiagnostic(
          'warning',
          'lossy-table-inline',
          `Table cell ${cell.id} contained inline annotations that are not supported by the publication table-cell schema; annotations were omitted.`,
          ownerId,
        ),
        {})
      : {}),
  })

  const mapBlock = (block: StructBlock): PublicationNode | undefined => {
    const base = common(block)
    const inlineRuns = block.inline.length
      ? mapInline(block.text, block.inline, block.id)
      : undefined
    switch (block.kind) {
      case 'heading':
        if (!block.text) {
          addDiagnostic(
            'warning',
            'unsupported-heading',
            `Heading ${block.id} had no text and was omitted.`,
            block.id,
          )
          return undefined
        }
        return {
          ...base,
          type: 'heading',
          level:
            typeof block.attributes?.level === 'number'
              ? Math.min(6, Math.max(1, Math.trunc(block.attributes.level)))
              : 1,
          text: block.text,
          ...(inlineRuns ? { inlineRuns } : {}),
        }
      case 'paragraph':
        if (!block.text) {
          addDiagnostic(
            'warning',
            'unsupported-paragraph',
            `Paragraph ${block.id} had no text and was omitted.`,
            block.id,
          )
          return undefined
        }
        if (block.attributes?.bibliographyEntry === true)
          return {
            ...base,
            type: 'reference',
            targetIds: [],
            text: block.text,
            ...(inlineRuns ? { inlineRuns } : {}),
          }
        return {
          ...base,
          type: 'paragraph',
          text: block.text,
          ...(inlineRuns ? { inlineRuns } : {}),
        }
      case 'quote':
        if (!block.text) {
          addDiagnostic(
            'warning',
            'unsupported-quote',
            `Quote ${block.id} had no text and was omitted.`,
            block.id,
          )
          return undefined
        }
        return {
          ...base,
          type: 'quote',
          text: block.text,
          ...(typeof block.attributes?.attribution === 'string'
            ? { attribution: block.attributes.attribution }
            : {}),
          ...(inlineRuns ? { inlineRuns } : {}),
        }
      case 'code':
        if (!block.text) {
          addDiagnostic(
            'warning',
            'unsupported-code',
            `Code block ${block.id} had no text and was omitted.`,
            block.id,
          )
          return undefined
        }
        return {
          ...base,
          type: 'code',
          code: block.text,
          ...(typeof block.attributes?.language === 'string'
            ? { language: block.attributes.language }
            : {}),
        }
      case 'figure': {
        const title = block.label || block.text
        if (!title) {
          addDiagnostic(
            'error',
            'unsupported-figure',
            `Figure ${block.id} had no title and was omitted.`,
            block.id,
          )
          return undefined
        }
        const relatedAssetIds = document.relationships
          .filter(
            (relationship) =>
              relationship.from === block.id &&
              relationship.kind === 'figure' &&
              relationship.status === 'matched',
          )
          .flatMap((relationship) =>
            relationship.to.filter((target) => knownAssetIds.has(target)),
          )
        const sourceAssetIds = block.fallbackAssetIds?.length
          ? block.fallbackAssetIds
          : relatedAssetIds
        const assetIds = sourceAssetIds
          .map((id) => assetIdsMap.get(id))
          .filter((id): id is string => Boolean(id))
        if (sourceAssetIds.length > assetIds.length)
          addDiagnostic(
            'warning',
            'unresolved-asset',
            `Figure ${block.id} referenced an unavailable asset; its source text was retained.`,
            block.id,
          )
        return {
          ...base,
          type: 'figure',
          title,
          ...(block.text ? { sourceText: block.text } : {}),
          ...(inlineRuns ? { inlineRuns } : {}),
          assetIds,
          ...(captionIdFor(block) ? { captionId: captionIdFor(block) } : {}),
        }
      }
      case 'caption': {
        if (!block.text) {
          addDiagnostic(
            'warning',
            'unsupported-caption',
            `Caption ${block.id} had no text and was omitted.`,
            block.id,
          )
          return undefined
        }
        const parent = captionParent.get(block.id)
        const parentId = parent ? mappedNode(parent) : undefined
        if (!parentId) {
          addDiagnostic(
            'warning',
            'unsupported-caption',
            `Caption ${block.id} had no verified owning node and was omitted.`,
            block.id,
          )
          return undefined
        }
        return {
          ...base,
          type: 'caption',
          parentId,
          text: block.text,
          ...(inlineRuns ? { inlineRuns } : {}),
        }
      }
      case 'table': {
        if (!block.table) {
          addDiagnostic(
            'warning',
            'unsupported-table',
            `Table ${block.id} had no cell grid and was omitted.`,
            block.id,
          )
          return undefined
        }
        if (block.table.semantic !== 'verified')
          addDiagnostic(
            'warning',
            `source-preserved-table`,
            `Table ${block.id} was ${block.table.semantic}; its text and spans were retained without promoting its semantics.`,
            block.id,
          )
        const cellIds = new Map<string, string>()
        const sourceCellIds = new Set<string>()
        for (const [index, cell] of block.table.cells.entries()) {
          if (sourceCellIds.has(cell.id))
            throw new Error(`STRUCT_DUPLICATE_TABLE_CELL_ID:${cell.id}`)
          sourceCellIds.add(cell.id)
          cellIds.set(
            cell.id,
            uniqueId(
              `${nodeIds.get(block.id)}-cell-${cell.id || index + 1}`,
              usedNodeIds,
            ),
          )
        }
        const rows = Array.from({ length: block.table.rows }, () => ({
          cells: [] as ReturnType<typeof mapTableCell>[],
        }))
        for (const cell of [...block.table.cells].sort(
          (left, right) => left.row - right.row || left.column - right.column,
        )) {
          const row = rows[cell.row]
          if (
            !row ||
            cell.column < 0 ||
            cell.column >= block.table.columns ||
            cell.rowSpan < 1 ||
            cell.columnSpan < 1
          ) {
            addDiagnostic(
              'warning',
              'lossy-table-cell',
              `Table cell ${cell.id} was outside the declared table geometry and was omitted.`,
              block.id,
            )
            continue
          }
          if (
            cell.row + cell.rowSpan > block.table.rows ||
            cell.column + cell.columnSpan > block.table.columns
          )
            addDiagnostic(
              'warning',
              'lossy-table-geometry',
              `Table cell ${cell.id} exceeded the declared table geometry; its source span was retained.`,
              block.id,
            )
          row.cells.push(mapTableCell(cell, block.id, cellIds.get(cell.id)!))
        }
        const emptyRows = rows
          .map((row, index) => (row.cells.length ? undefined : index))
          .filter((index): index is number => index !== undefined)
        if (emptyRows.length)
          addDiagnostic(
            'warning',
            'lossy-table-geometry',
            `Table ${block.id} omitted empty source rows ${emptyRows.join(', ')} when projecting the strict publication table schema.`,
            block.id,
          )
        const validRows = rows.filter((row) => row.cells.length)
        if (!validRows.length) return undefined
        return {
          ...base,
          type: 'table',
          rows: validRows,
          ...(captionIdFor(block) ? { captionId: captionIdFor(block) } : {}),
        }
      }
      case 'equation': {
        const format = block.attributes?.equationFormat
        const equationFormat =
          format === 'mathml' || format === 'latex' || format === 'plain-text'
            ? format
            : 'plain-text'
        if (block.attributes?.equationFormat && format !== equationFormat)
          addDiagnostic(
            'warning',
            'lossy-equation-format',
            `Equation ${block.id} used an unsupported format and was retained as plain text.`,
            block.id,
          )
        if (block.attributes?.sourcePreserved === true)
          addDiagnostic(
            'warning',
            'source-preserved-equation',
            `Equation ${block.id} was source-preserved; no unverified transcription was introduced.`,
            block.id,
          )
        if (!block.text) {
          addDiagnostic(
            'error',
            'unsupported-equation',
            `Equation ${block.id} had no source text and was omitted.`,
            block.id,
          )
          return undefined
        }
        return {
          ...base,
          type: 'equation',
          source: block.text,
          format: equationFormat,
          ...(block.label ? { label: block.label } : {}),
          ...(captionIdFor(block) ? { captionId: captionIdFor(block) } : {}),
        }
      }
      case 'footnote':
      case 'endnote': {
        if (!block.text) {
          addDiagnostic(
            'warning',
            'unsupported-note',
            `Note ${block.id} had no text and was omitted.`,
            block.id,
          )
          return undefined
        }
        const backlinks = document.relationships
          .filter(
            (relationship) =>
              (relationship.kind === 'footnote' ||
                relationship.kind === 'endnote') &&
              relationship.status === 'matched' &&
              relationship.to.includes(block.id) &&
              document.blocks.some(
                (candidate) =>
                  candidate.text.length > 0 &&
                  candidate.inline.some(
                    (inline) =>
                      inline.relationshipId === relationship.id &&
                      inline.semanticRole === 'note-reference' &&
                      inline.targetIds?.includes(block.id) &&
                      inline.start >= 0 &&
                      inline.end > inline.start &&
                      inline.end <= candidate.text.length,
                  ),
              ),
          )
          .flatMap((relationship) => {
            const occurrences = document.blocks.flatMap((candidate) =>
              candidate.inline
                .filter(
                  (inline) =>
                    inline.relationshipId === relationship.id &&
                    inline.semanticRole === 'note-reference' &&
                    inline.targetIds?.includes(block.id) &&
                    inline.start >= 0 &&
                    inline.end > inline.start &&
                    inline.end <= candidate.text.length,
                )
                .map((inline) => inlineRelationshipIds.get(inline)),
            )
            return occurrences.length
              ? occurrences
              : [mappedRelationship(relationship.id)]
          })
          .filter((id): id is string => Boolean(id))
          .filter((id, index, all) => all.indexOf(id) === index)
        return {
          ...base,
          type: 'note',
          noteKind: block.kind === 'endnote' ? 'endnote' : 'footnote',
          label: block.label || block.id,
          backlinkIds: backlinks,
          text: block.text,
          ...(inlineRuns ? { inlineRuns } : {}),
        }
      }
      default:
        addDiagnostic(
          'warning',
          block.kind === 'furniture'
            ? 'unsupported-furniture'
            : 'unsupported-block',
          `STRUCT block ${block.id} (${block.kind}) was not flattened into PublicationGraph.`,
          block.id,
        )
        return undefined
    }
  }

  const assetIdsMap = new Map<string, string>()
  const assetDescriptors: AssetDescriptor[] = []
  const assetBytes = new Map<string, Uint8Array>()
  const assetHashes = new Map<string, string>()
  for (const asset of document.assets) {
    if (!asset.bytes) {
      addDiagnostic(
        'warning',
        'asset-bytes-unavailable',
        `Asset ${asset.id} has no local bytes and was omitted from the publication asset bundle.`,
        asset.id,
      )
      continue
    }
    const prior = assetHashes.get(asset.sha256)
    if (prior) {
      assetIdsMap.set(asset.id, prior)
      addDiagnostic(
        'warning',
        'duplicate-asset-content',
        `Asset ${asset.id} shared content with ${prior}; the bundle uses one stable descriptor.`,
        asset.id,
      )
      continue
    }
    const id = uniqueId(asset.id, usedNodeIds)
    assetIdsMap.set(asset.id, id)
    assetHashes.set(asset.sha256, id)
    assetDescriptors.push({
      id,
      sha256: asset.sha256,
      byteLength: asset.bytes?.byteLength ?? 0,
      mediaType: asset.mediaType,
      ...(basename(asset.href) ? { fileName: basename(asset.href) } : {}),
      ...(asset.width > 0 ? { width: asset.width } : {}),
      ...(asset.height > 0 ? { height: asset.height } : {}),
    })
    assetBytes.set(id, new Uint8Array(asset.bytes))
  }

  for (const relationship of document.relationships) {
    if (relationship.status !== 'matched') continue
    const appearsInline = document.blocks.some((block) =>
      block.inline.some((inline) => inline.relationshipId === relationship.id),
    )
    const fromAvailable = Boolean(mappedNode(relationship.from))
    const toAvailable =
      relationship.to.length > 0 &&
      relationship.to.every((target) =>
        captionLinks.get(relationship.id)?.captionId === target
          ? Boolean(mappedNode(target))
          : relationship.kind === 'figure' || captionLinks.has(relationship.id)
            ? assetIdsMap.has(target)
            : Boolean(mappedNode(target)),
      )
    if (
      (!fromAvailable || !toAvailable) &&
      !(appearsInline && fromAvailable && !toAvailable)
    )
      addDiagnostic(
        'warning',
        'unresolved-relationship-target',
        `Matched relationship ${relationship.id} (${relationship.kind}) had an unavailable endpoint and was not projected as a link.`,
        relationship.from,
      )
  }

  const nodes: PublicationNode[] = []
  const listGroups = new Map<
    string,
    {
      id: string
      level: number
      ordered: boolean
      start?: number
      itemIds: string[]
      firstIndex: number
      parentItemId?: string
    }
  >()
  const listStack: Array<{
    level: number
    group: {
      id: string
      level: number
      ordered: boolean
      start?: number
      itemIds: string[]
      firstIndex: number
      parentItemId?: string
    }
  }> = []
  for (const { block, index } of orderedBlocks) {
    if (block.kind === 'list-item') {
      if (!block.text) {
        addDiagnostic(
          'warning',
          'unsupported-list-item',
          `List item ${block.id} had no text and was omitted.`,
          block.id,
        )
        continue
      }
      const level =
        typeof block.attributes?.listLevel === 'number'
          ? Math.max(0, Math.trunc(block.attributes.listLevel))
          : 0
      const ordered = block.attributes?.listOrdered === true
      while (listStack.at(-1) && listStack.at(-1)!.level > level)
        listStack.pop()
      let group =
        listStack.at(-1)?.level === level &&
        listStack.at(-1)?.group.ordered === ordered
          ? listStack.at(-1)!.group
          : undefined
      if (!group) {
        group = {
          id: uniqueId(`${nodeIds.get(block.id)}-list`, usedNodeIds),
          level,
          ordered,
          ...(ordered && typeof block.attributes?.listOrdinal === 'number'
            ? { start: Math.max(0, Math.trunc(block.attributes.listOrdinal)) }
            : {}),
          itemIds: [],
          firstIndex: index,
          ...(listStack.at(-1)
            ? { parentItemId: listStack.at(-1)!.group.itemIds.at(-1) }
            : {}),
        }
        listGroups.set(`${level}:${ordered}:${index}`, group)
        listStack.push({ level, group })
        nodes.push({
          ...common(block),
          id: group.id,
          type: 'list',
          ordered,
          itemIds: [],
          ...(group.start !== undefined ? { start: group.start } : {}),
        })
      }
      group.itemIds.push(nodeIds.get(block.id)!)
      const listInlineRuns = inlineRunsFor(block, mapInline)
      nodes.push({
        ...common(block),
        type: 'list-item',
        parentListId: group.id,
        childListIds: [],
        text: block.text,
        ...(listInlineRuns ? { inlineRuns: listInlineRuns } : {}),
      })
      continue
    }
    listStack.length = 0
    const mapped = mapBlock(block)
    if (mapped) nodes.push(mapped)
  }
  for (const group of listGroups.values()) {
    const list = nodes.find((node) => node.id === group.id)
    if (list?.type === 'list') list.itemIds = group.itemIds
  }
  for (const group of listGroups.values()) {
    if (!group.parentItemId) continue
    const parent = nodes.find((node) => node.id === group.parentItemId)
    if (parent?.type === 'list-item') parent.childListIds.push(group.id)
  }

  if (!nodes.length) throw new Error('STRUCT_NO_PUBLICATION_NODES')
  const created = dateOnly(document.metadata.publicationDate)
  if (document.metadata.publicationDate && !created)
    addDiagnostic(
      'warning',
      'invalid-publication-date',
      `Publication date ${document.metadata.publicationDate} was not a valid calendar date and was omitted.`,
    )
  const modified = dateOnly(document.metadata.updated)
  if (document.metadata.updated && !modified)
    addDiagnostic(
      'warning',
      'invalid-updated-date',
      `Updated date ${document.metadata.updated} was not a valid calendar date and was omitted.`,
    )
  const artifactModifiedAt = dateTime(document.metadata.artifactModifiedAt)
  if (document.metadata.artifactModifiedAt && !artifactModifiedAt)
    addDiagnostic(
      'warning',
      'invalid-artifact-modified-at',
      `Artifact modified timestamp ${document.metadata.artifactModifiedAt} was not a valid offset datetime and was omitted.`,
    )
  const graph = parsePublicationGraph({
    version: PUBLICATION_GRAPH_VERSION,
    id: graphId,
    metadata: {
      title: document.metadata.title || sourceId,
      ...(document.metadata.subtitle
        ? { subtitle: document.metadata.subtitle }
        : {}),
      contributors: document.metadata.authors,
      ...(document.metadata.abstract
        ? { abstract: document.metadata.abstract }
        : {}),
      sourceDocumentVersion: document.schemaVersion,
      ...(created ? { created } : {}),
      ...(modified ? { modified } : {}),
      ...(artifactModifiedAt ? { artifactModifiedAt } : {}),
      defaultLocale: locale,
      defaultDirection: directionValue,
      keywords: [],
    },
    edition: { id: editionId, locale, direction: directionValue },
    nodes,
  })
  return {
    graph,
    assetBundle: createAssetBundle(
      { version: '1.0.0', assets: assetDescriptors },
      async (descriptor) => {
        const bytesForAsset = assetBytes.get(descriptor.id)
        if (!bytesForAsset)
          throw new Error(`STRUCT_ASSET_BYTES_UNAVAILABLE:${descriptor.id}`)
        return new Uint8Array(bytesForAsset)
      },
    ),
    diagnostics,
    provenance: {
      adapterId: STRUCT_PUBLICATION_ADAPTER_ID,
      adapterVersion: PUBLICATION_SOURCE_ADAPTER_VERSION,
      sourceType: sourceType(document),
      sourceId,
      sourceRevision: document.source.sha256,
      mappingVersion: STRUCT_PUBLICATION_MAPPING_VERSION,
    },
  }
}

function inlineRunsFor(
  block: StructBlock,
  mapInline: (
    text: string,
    source: StructInline[],
    ownerId: string,
  ) => PublicationInlineRun[],
) {
  return block.inline.length
    ? mapInline(block.text, block.inline, block.id)
    : undefined
}

export const structPublicationAdapter: PublicationSourceAdapter<StructDocument> =
  {
    id: STRUCT_PUBLICATION_ADAPTER_ID,
    version: PUBLICATION_SOURCE_ADAPTER_VERSION,
    adapt: adaptStructDocument,
  }

export const structDocumentToPublicationSourceResult = adaptStructDocument
