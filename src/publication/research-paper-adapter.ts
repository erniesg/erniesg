/**
 * The ResearchPaper bridge is one-way: a `ResearchPaper` is projected onto a
 * `PublicationGraph`, and the graph never authors `ResearchPaper` text or
 * semantic ids. The reverse writer is retired, so no export of this module
 * converts a graph back into a paper.
 *
 * The projection is a read-only compatibility surface. The adapter stays
 * unregistered in `createDefaultPublicationAdapterRegistry()`, so the graph it
 * produces never enters the release path.
 */
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
  type PublicationInlineRun,
  type PublicationNode,
} from './schema'
import {
  PUBLICATION_SOURCE_ADAPTER_VERSION,
  validatePublicationSourceResult,
  type PublicationSourceAdapter,
  type PublicationSourceResult,
} from './source-adapter'
import { legacyResearchPaperSourceBinding } from './source-binding'

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
  if (
    ('noteReferences' in node && node.noteReferences?.length) ||
    ('inlineRuns' in node &&
      node.inlineRuns?.some((run) => run.semanticRole === 'note-reference'))
  ) {
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

function supportedInlineRuns(node: ResearchNode) {
  const runs = 'inlineRuns' in node ? node.inlineRuns : undefined
  return runs as PublicationInlineRun[] | undefined
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
    const inlineRuns = supportedInlineRuns(node)
    switch (node.type) {
      case 'heading':
        return {
          ...common,
          type: 'heading',
          level: node.level,
          text: node.text,
          inlineRuns,
        }
      case 'paragraph':
        return {
          ...common,
          type: 'paragraph',
          text: node.text,
          inlineRuns,
        }
      case 'quote':
        return {
          ...common,
          type: 'quote',
          text: node.text,
          inlineRuns,
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
          inlineRuns,
        }
      }
      case 'footnote':
        return {
          ...common,
          type: 'note',
          noteKind: node.kind,
          label: node.label,
          text: node.text,
          inlineRuns,
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
          inlineRuns,
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
    // This is the only source in the app that has no Struct document, so it
    // carries the legacy binding. The variant has no Struct field at all: no
    // placeholder digest and no fabricated package pin.
    sourceBinding: legacyResearchPaperSourceBinding(),
  })
}

export const researchPaperSourceAdapter: PublicationSourceAdapter<ResearchPaper> =
  {
    id: RESEARCH_PAPER_ADAPTER_ID,
    version: PUBLICATION_SOURCE_ADAPTER_VERSION,
    adapt: adaptResearchPaper,
  }
