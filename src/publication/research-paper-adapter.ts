import {
  researchPaperSchema,
  type ResearchNode,
  type ResearchPaper,
} from '../research/schema'
import {
  createAssetBundle,
  EMPTY_ASSET_RESOLVER,
  type AssetByteResolver,
  type AssetDescriptor,
} from './asset-bundle'
import {
  defineSourceAdapter,
  PUBLICATION_SOURCE_ADAPTER_VERSION,
  runSourceAdapter,
  type PublicationSourceResult,
  type SourceDiagnostic,
} from './source-adapter'
import {
  publicationDigest,
  PUBLICATION_GRAPH_VERSION,
  parsePublicationGraph,
  type PublicationEdition,
  type PublicationGraph,
  type PublicationNode,
} from './schema'

export const RESEARCH_PAPER_ADAPTER_ID = 'research-paper' as const
export const RESEARCH_PAPER_ADAPTER_VERSION = '1.0.0' as const

/**
 * Everything the adapter cannot express medium-independently. Each one becomes
 * an explicit diagnostic rather than a silent drop, and `toResearchPaper` cannot
 * invent it back.
 */
export const UNSUPPORTED_RESEARCH_PAPER_FEATURES = [
  'figure.table.rows[].cells[].sourceRuns',
] as const

const UNSUPPORTED_GRAPH_NODE_TYPES = [
  'code',
  'aside',
  'reference',
  'media',
] as const

export class ResearchPaperAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResearchPaperAdapterError'
  }
}

function editionId(paper: ResearchPaper) {
  return `${paper.id}.${paper.version}`
}

function paperDirection(paper: ResearchPaper) {
  if (paper.baseDirection === 'ltr' || paper.baseDirection === 'rtl') {
    return paper.baseDirection
  }
  return 'auto' as const
}

function nodeImportance(node: ResearchNode) {
  if (node.type === 'caption' || node.type === 'footnote') return 'supporting'
  return 'primary'
}

function graphObjectType(node: Extract<ResearchNode, { type: 'figure' }>) {
  if (node.objectType === 'table') return 'table' as const
  if (node.objectType === 'equation') return 'equation' as const
  return 'figure' as const
}

type SharedNodeFields = Pick<
  PublicationNode,
  | 'id'
  | 'locale'
  | 'direction'
  | 'requirement'
  | 'importance'
  | 'provenance'
  | 'accessibility'
  | 'authoredVariants'
  | 'permittedTransformations'
  | 'reviewedVariants'
  | 'edition'
  | 'relationships'
  | 'assetRefs'
>

function sharedFields(
  paper: ResearchPaper,
  node: ResearchNode,
): SharedNodeFields {
  return {
    id: node.id,
    locale: paper.language ?? 'und',
    direction: paperDirection(paper),
    requirement: 'required',
    importance: nodeImportance(node),
    provenance: { source: node.source, method: 'authored' },
    accessibility: { alternatives: [] },
    authoredVariants: {},
    permittedTransformations: [],
    reviewedVariants: [],
    edition: { editionId: editionId(paper) },
    relationships: [],
    assetRefs: [],
  }
}

function optional<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Partial<Record<Key, Value>> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>)
}

function toGraphNoteReferences(
  node: Extract<ResearchNode, { noteReferences?: unknown }>,
) {
  if (!('noteReferences' in node) || !node.noteReferences) return {}
  return {
    noteReferences: node.noteReferences.map((reference) => ({
      id: reference.id,
      label: reference.label,
      targetId: reference.target,
      start: reference.start,
      end: reference.end,
      confidence: reference.confidence,
    })),
  }
}

function toGraphNode(
  paper: ResearchPaper,
  node: ResearchNode,
  diagnostics: SourceDiagnostic[],
): PublicationNode {
  const shared = sharedFields(paper, node)
  const inline =
    'inlineRuns' in node ? optional('inlineRuns', node.inlineRuns) : {}

  switch (node.type) {
    case 'heading':
      return {
        ...shared,
        type: 'heading',
        level: node.level,
        text: node.text,
        ...inline,
        ...toGraphNoteReferences(node),
      }
    case 'paragraph':
      if (node.list) {
        return {
          ...shared,
          type: 'list',
          text: node.text,
          list: node.list,
          ...inline,
          ...toGraphNoteReferences(node),
        }
      }
      return {
        ...shared,
        type: 'paragraph',
        text: node.text,
        ...inline,
        ...toGraphNoteReferences(node),
      }
    case 'quote':
      return {
        ...shared,
        type: 'quote',
        text: node.text,
        ...inline,
        ...toGraphNoteReferences(node),
      }
    case 'caption':
      return { ...shared, type: 'caption', text: node.text, ...inline }
    case 'footnote':
      return {
        ...shared,
        type: 'note',
        kind: node.kind,
        label: node.label,
        ...optional('markerText', node.markerText),
        text: node.text,
        ...inline,
        backlinks: [...node.relationships.backlinks],
      }
    case 'figure': {
      const objectType = graphObjectType(node)
      const relationships: PublicationNode['relationships'] = [
        { role: 'caption', targetId: node.relationships.caption },
      ]
      const assetRefs: PublicationNode['assetRefs'] = (
        node.relationships.assets ?? []
      ).map((assetId) => ({ role: 'primary' as const, assetId }))
      const objectFields = {
        ...shared,
        relationships,
        assetRefs,
        title: node.title,
        ...optional('sourceText', node.sourceText),
        ...optional('declaredObjectType', node.objectType),
        ...inline,
      }
      if (objectType === 'table') {
        if (
          node.table?.rows.some((row) =>
            row.cells.some((cell) => cell.sourceRuns),
          )
        ) {
          diagnostics.push({
            code: 'dropped-source-geometry',
            severity: 'warning',
            message:
              'Table cell sourceRuns carry page coordinates and cannot enter canonical content.',
            nodeId: node.id,
          })
        }
        return {
          ...objectFields,
          type: 'table',
          ...optional(
            'table',
            node.table
              ? {
                  rows: node.table.rows.map((row) => ({
                    cells: row.cells.map((cell) => ({
                      text: cell.text,
                      headerScope: cell.headerScope,
                      columnSpan: cell.columnSpan,
                      rowSpan: cell.rowSpan,
                      ...optional('id', cell.id),
                      ...optional('headerIds', cell.headerIds),
                      ...optional('inlineRuns', cell.inlineRuns),
                      ...optional('inlineMapping', cell.inlineMapping),
                    })),
                  })),
                }
              : undefined,
          ),
        }
      }
      if (objectType === 'equation') {
        return { ...objectFields, type: 'equation' }
      }
      return { ...objectFields, type: 'figure' }
    }
  }
}

export function researchPaperToPublicationGraph(paper: ResearchPaper): {
  graph: PublicationGraph
  diagnostics: SourceDiagnostic[]
} {
  const diagnostics: SourceDiagnostic[] = []
  const edition: PublicationEdition = {
    id: editionId(paper),
    kind: 'primary',
    locale: paper.language ?? 'und',
    direction: paperDirection(paper),
    label: paper.title.slice(0, 240),
  }
  if (!paper.language) {
    diagnostics.push({
      code: 'unproven-locale',
      severity: 'info',
      message:
        'The research paper declares no language; the edition locale is "und".',
    })
  }

  const graph = parsePublicationGraph({
    version: PUBLICATION_GRAPH_VERSION,
    metadata: {
      id: paper.id,
      version: paper.version,
      status: paper.status,
      title: paper.title,
      subtitle: paper.subtitle,
      authors: paper.authors,
      abstract: paper.abstract,
      updated: paper.updated,
      ...optional('language', paper.language),
      ...optional('baseDirection', paper.baseDirection),
      ...optional('publicationDate', paper.publicationDate),
      ...optional('artifactModifiedAt', paper.artifactModifiedAt),
      ...optional('affiliations', paper.affiliations),
      ...optional('authorAffiliations', paper.authorAffiliations),
      ...optional(
        'authorNotes',
        paper.authorNotes?.map((entry) => ({
          id: entry.id,
          author: entry.author,
          label: entry.label,
          targetId: entry.target,
        })),
      ),
      ...optional('metadataLineage', paper.metadataLineage),
    },
    editions: [edition],
    nodes: paper.nodes.map((node) => toGraphNode(paper, node, diagnostics)),
  })

  return { graph, diagnostics }
}

function fromGraphNoteReferences(node: PublicationNode) {
  if (!('noteReferences' in node) || !node.noteReferences) return {}
  return {
    noteReferences: node.noteReferences.map((reference) => ({
      id: reference.id,
      label: reference.label,
      target: reference.targetId,
      start: reference.start,
      end: reference.end,
      confidence: reference.confidence,
    })),
  }
}

function toResearchNode(node: PublicationNode): unknown {
  const base = { id: node.id, source: node.provenance.source }
  const inline =
    'inlineRuns' in node ? optional('inlineRuns', node.inlineRuns) : {}

  switch (node.type) {
    case 'heading':
      return {
        ...base,
        type: 'heading',
        level: node.level,
        text: node.text,
        ...inline,
        ...fromGraphNoteReferences(node),
      }
    case 'paragraph':
      return {
        ...base,
        type: 'paragraph',
        text: node.text,
        ...inline,
        ...fromGraphNoteReferences(node),
      }
    case 'list':
      return {
        ...base,
        type: 'paragraph',
        text: node.text,
        list: node.list,
        ...inline,
        ...fromGraphNoteReferences(node),
      }
    case 'quote':
      return {
        ...base,
        type: 'quote',
        text: node.text,
        ...inline,
        ...fromGraphNoteReferences(node),
      }
    case 'caption':
      return { ...base, type: 'caption', text: node.text, ...inline }
    case 'note':
      return {
        ...base,
        type: 'footnote',
        kind: node.kind,
        label: node.label,
        ...optional('markerText', node.markerText),
        text: node.text,
        ...inline,
        relationships: { backlinks: [...node.backlinks] },
      }
    case 'figure':
    case 'table':
    case 'equation': {
      const caption = node.relationships.find(
        (relationship) => relationship.role === 'caption',
      )
      if (!caption) {
        throw new ResearchPaperAdapterError(
          `Node ${node.id} has no caption relationship; ResearchPaper requires one`,
        )
      }
      const assets = node.assetRefs.map((reference) => reference.assetId)
      const objectType =
        node.declaredObjectType ?? (node.type === 'figure' ? undefined : node.type)
      return {
        ...base,
        type: 'figure',
        title: node.title,
        ...optional('objectType', objectType),
        ...optional('sourceText', node.sourceText),
        ...inline,
        ...(node.type === 'table' ? optional('table', node.table) : {}),
        relationships: {
          caption: caption.targetId,
          ...(assets.length > 0 ? { assets } : {}),
        },
      }
    }
    default:
      throw new ResearchPaperAdapterError(
        `${node.type} nodes have no ResearchPaper representation`,
      )
  }
}

export function publicationGraphToResearchPaper(
  graph: PublicationGraph,
): ResearchPaper {
  const unsupported = graph.nodes.filter((node) =>
    (UNSUPPORTED_GRAPH_NODE_TYPES as readonly string[]).includes(node.type),
  )
  if (unsupported.length > 0) {
    throw new ResearchPaperAdapterError(
      `ResearchPaper does not support these graph nodes: ${unsupported
        .map((node) => `${node.id}:${node.type}`)
        .join(', ')}`,
    )
  }
  const { metadata } = graph
  if (!metadata.subtitle) {
    throw new ResearchPaperAdapterError(
      `Graph ${metadata.id} has no subtitle; ResearchPaper requires one`,
    )
  }

  return researchPaperSchema.parse({
    id: metadata.id,
    version: metadata.version,
    status: metadata.status,
    title: metadata.title,
    subtitle: metadata.subtitle,
    authors: metadata.authors,
    ...optional('language', metadata.language),
    ...optional('baseDirection', metadata.baseDirection),
    ...optional('publicationDate', metadata.publicationDate),
    ...optional('artifactModifiedAt', metadata.artifactModifiedAt),
    ...optional('metadataLineage', metadata.metadataLineage),
    ...optional(
      'authorNotes',
      metadata.authorNotes?.map((entry) => ({
        id: entry.id,
        author: entry.author,
        label: entry.label,
        target: entry.targetId,
      })),
    ),
    ...optional('authorAffiliations', metadata.authorAffiliations),
    ...optional('affiliations', metadata.affiliations),
    updated: metadata.updated,
    abstract: metadata.abstract,
    nodes: graph.nodes.map(toResearchNode),
  })
}

function capturedAt(paper: ResearchPaper) {
  return paper.artifactModifiedAt ?? `${paper.updated}T00:00:00.000Z`
}

export type ResearchPaperSourceInput = {
  paper: ResearchPaper
  assets?: readonly AssetDescriptor[]
  resolver?: AssetByteResolver
}

export const researchPaperSourceAdapter = defineSourceAdapter<
  ResearchPaperSourceInput
>({
  id: RESEARCH_PAPER_ADAPTER_ID,
  version: PUBLICATION_SOURCE_ADAPTER_VERSION,
  sourceKind: 'research-paper',
  read({ paper, assets = [], resolver = EMPTY_ASSET_RESOLVER }) {
    const { graph, diagnostics } = researchPaperToPublicationGraph(paper)
    return {
      version: PUBLICATION_SOURCE_ADAPTER_VERSION,
      graph,
      assetBundle: createAssetBundle(assets, resolver),
      diagnostics,
      provenance: {
        adapterId: RESEARCH_PAPER_ADAPTER_ID,
        adapterVersion: RESEARCH_PAPER_ADAPTER_VERSION,
        sourceKind: 'research-paper',
        sourceId: `${paper.id}@${paper.version}`,
        sourceDigest: publicationDigest(paper),
        capturedAt: capturedAt(paper),
      },
    } satisfies PublicationSourceResult
  },
})

export function readResearchPaper(
  input: ResearchPaperSourceInput,
): PublicationSourceResult {
  return runSourceAdapter(researchPaperSourceAdapter, input)
}
