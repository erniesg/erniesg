import {
  researchPaperSchema,
  type ResearchNode,
  type ResearchPaper,
} from '../research/schema'
import { createAssetBundle, type AssetBundle } from './asset-bundle'
import {
  PUBLICATION_GRAPH_VERSION,
  publicationGraphSchema,
  type PublicationGraph,
  type PublicationNode,
} from './schema'
import {
  PUBLICATION_SOURCE_ADAPTER_VERSION,
  validatePublicationSourceResult,
  type PublicationSourceAdapter,
  type PublicationSourceResult,
} from './source-adapter'

export const RESEARCH_PAPER_ADAPTER_ID = 'research-paper' as const

const emptyAssetBundle = () =>
  createAssetBundle({ version: '1.0.0', assets: [] }, async () => {
    throw new Error('The research-paper adapter has no embedded asset bytes')
  })

function direction(
  value: ResearchPaper['baseDirection'],
): 'ltr' | 'rtl' | 'auto' {
  return value === 'ltr' || value === 'rtl' ? value : 'auto'
}

function commonNode(
  paper: ResearchPaper,
  node: ResearchNode,
): Omit<PublicationNode, 'type'> {
  return {
    id: node.id,
    locale: paper.language ?? 'und',
    direction: direction(paper.baseDirection),
    requirement: 'required',
    importance:
      node.type === 'caption' || node.type === 'footnote'
        ? 'supporting'
        : 'essential',
    provenance: {
      adapterId: RESEARCH_PAPER_ADAPTER_ID,
      sourceId: node.source,
      evidence: [],
    },
    accessibility: { decorative: false },
    variants: [],
    permittedTransformationIds: [],
    edition: { editionId: `${paper.id}:${paper.language ?? 'und'}` },
  } as Omit<PublicationNode, 'type'>
}

function assertSupportedNode(node: ResearchNode) {
  if ('noteReferences' in node && node.noteReferences?.length) {
    throw new Error(
      `Research node ${node.id} uses unsupported embedded note references`,
    )
  }
  if (node.type === 'paragraph' && node.list) {
    throw new Error(
      `Research node ${node.id} uses unsupported legacy list context`,
    )
  }
}

export function researchPaperToPublicationGraph(
  input: ResearchPaper,
): PublicationGraph {
  const paper = researchPaperSchema.parse(input)
  if (
    paper.authorNotes?.length ||
    paper.authorAffiliations?.length ||
    paper.affiliations?.length ||
    paper.metadataLineage
  ) {
    throw new Error(
      'The first research-paper adapter subset does not support scholarly metadata extensions',
    )
  }
  const captionParents = new Map<string, string>()
  for (const node of paper.nodes) {
    if (node.type === 'figure')
      captionParents.set(node.relationships.caption, node.id)
  }

  const nodes = paper.nodes.map((node): PublicationNode => {
    assertSupportedNode(node)
    const common = commonNode(paper, node)
    switch (node.type) {
      case 'heading':
        return {
          ...common,
          type: 'heading',
          level: node.level,
          text: node.text,
          inlineRuns: node.inlineRuns,
        }
      case 'paragraph':
        return {
          ...common,
          type: 'paragraph',
          text: node.text,
          inlineRuns: node.inlineRuns,
        }
      case 'quote':
        return {
          ...common,
          type: 'quote',
          text: node.text,
          inlineRuns: node.inlineRuns,
        }
      case 'caption': {
        const parentId = captionParents.get(node.id)
        if (!parentId)
          throw new Error(`Caption ${node.id} has no owning research figure`)
        return {
          ...common,
          type: 'caption',
          parentId,
          text: node.text,
          inlineRuns: node.inlineRuns,
        }
      }
      case 'footnote':
        return {
          ...common,
          type: 'note',
          noteKind: node.kind,
          label: node.label,
          text: node.text,
          inlineRuns: node.inlineRuns,
          backlinkIds: node.relationships.backlinks,
        }
      case 'figure':
        if (
          node.objectType === 'table' ||
          node.objectType === 'equation' ||
          node.table
        ) {
          throw new Error(
            `Research node ${node.id} uses an unsupported structured figure subtype`,
          )
        }
        return {
          ...common,
          type: 'figure',
          title: node.title,
          sourceText: node.sourceText,
          inlineRuns: node.inlineRuns,
          assetIds: node.relationships.assets ?? [],
          captionId: node.relationships.caption,
        }
    }
  })

  return publicationGraphSchema.parse({
    version: PUBLICATION_GRAPH_VERSION,
    id: paper.id,
    metadata: {
      title: paper.title,
      subtitle: paper.subtitle,
      contributors: paper.authors,
      abstract: paper.abstract,
      status: paper.status,
      sourceDocumentVersion: paper.version,
      created: paper.publicationDate,
      modified: paper.updated,
      artifactModifiedAt: paper.artifactModifiedAt,
      defaultLocale: paper.language ?? 'und',
      defaultDirection: direction(paper.baseDirection),
      keywords: [],
    },
    edition: {
      id: `${paper.id}:${paper.language ?? 'und'}`,
      locale: paper.language ?? 'und',
      direction: direction(paper.baseDirection),
    },
    nodes,
  })
}

export function publicationGraphToResearchPaper(
  input: PublicationGraph,
): ResearchPaper {
  const graph = publicationGraphSchema.parse(input)
  const nodes = graph.nodes.map((node): ResearchNode => {
    const source = node.provenance.sourceId
    switch (node.type) {
      case 'heading':
        return {
          id: node.id,
          type: 'heading',
          level: node.level as 1 | 2 | 3,
          text: node.text,
          inlineRuns: node.inlineRuns,
          source,
        }
      case 'paragraph':
        return {
          id: node.id,
          type: 'paragraph',
          text: node.text,
          inlineRuns: node.inlineRuns,
          source,
        }
      case 'quote':
        return {
          id: node.id,
          type: 'quote',
          text: node.text,
          inlineRuns: node.inlineRuns,
          source,
        }
      case 'caption':
        return {
          id: node.id,
          type: 'caption',
          text: node.text,
          inlineRuns: node.inlineRuns,
          source,
        }
      case 'note':
        if (node.noteKind === 'author-note')
          throw new Error('ResearchPaper does not support author-note nodes')
        return {
          id: node.id,
          type: 'footnote',
          kind: node.noteKind,
          label: node.label,
          text: node.text,
          inlineRuns: node.inlineRuns,
          relationships: { backlinks: node.backlinkIds },
          source,
        }
      case 'figure':
        return {
          id: node.id,
          type: 'figure',
          title: node.title,
          sourceText: node.sourceText,
          inlineRuns: node.inlineRuns,
          relationships: {
            caption:
              node.captionId ??
              (() => {
                throw new Error(`Figure ${node.id} lacks a caption`)
              })(),
            ...(node.assetIds.length ? { assets: node.assetIds } : {}),
          },
          source,
        }
      default:
        throw new Error(
          `Publication node ${node.id} (${node.type}) is outside the ResearchPaper subset`,
        )
    }
  })

  return researchPaperSchema.parse({
    id: graph.id,
    version: graph.metadata.sourceDocumentVersion,
    status: graph.metadata.status,
    title: graph.metadata.title,
    subtitle: graph.metadata.subtitle,
    authors: graph.metadata.contributors,
    language:
      graph.metadata.defaultLocale === 'und'
        ? undefined
        : graph.metadata.defaultLocale,
    baseDirection:
      graph.metadata.defaultDirection === 'auto'
        ? 'unknown'
        : graph.metadata.defaultDirection,
    publicationDate: graph.metadata.created,
    artifactModifiedAt: graph.metadata.artifactModifiedAt,
    updated: graph.metadata.modified,
    abstract: graph.metadata.abstract,
    nodes,
  })
}

export function adaptResearchPaper(
  input: ResearchPaper,
  assetBundle: AssetBundle = emptyAssetBundle(),
): PublicationSourceResult {
  const paper = researchPaperSchema.parse(input)
  return validatePublicationSourceResult({
    graph: researchPaperToPublicationGraph(paper),
    assetBundle,
    diagnostics: [],
    provenance: {
      adapterId: RESEARCH_PAPER_ADAPTER_ID,
      adapterVersion: PUBLICATION_SOURCE_ADAPTER_VERSION,
      sourceType: 'research-paper',
      sourceId: paper.id,
      sourceRevision: paper.version,
    },
  })
}

export const researchPaperSourceAdapter: PublicationSourceAdapter<ResearchPaper> =
  {
    id: RESEARCH_PAPER_ADAPTER_ID,
    version: PUBLICATION_SOURCE_ADAPTER_VERSION,
    adapt: adaptResearchPaper,
  }
