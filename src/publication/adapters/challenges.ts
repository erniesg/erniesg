import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'

import {
  PUBLICATION_GRAPH_VERSION,
  type PublicationGraph,
  type PublicationNode,
} from '../schema'
import {
  PUBLICATION_SOURCE_ADAPTER_VERSION,
  type PublicationSourceAdapter,
  type PublicationSourceResult,
} from '../source-adapter'
import { ASSET_BUNDLE_VERSION, createAssetBundle } from '../asset-bundle'

/**
 * Turns a challenges node directory into a PublicationGraph.
 *
 * A node is authored as TOML front matter plus a body restricted to eight
 * container directives. This adapter is the only place that decides what each
 * directive means in the compiler's vocabulary; every rendition then comes from
 * the graph, so the web page and the EPUB cannot disagree about the content.
 *
 *   statement   -> paragraphs
 *   io          -> list of "Key: value" items
 *   constraints -> list
 *   sample      -> table
 *   figure      -> figure + caption
 *   run         -> code (the starter), marked as the exercise
 *   hint        -> aside, optional, supplemental
 *   solution    -> aside carrying the worked answer
 */

export const CHALLENGES_ADAPTER_ID = 'challenges-node'
export const CHALLENGES_MAPPING_VERSION = '1.0.0'

const BLOCK = /^:::(\w+)(\{[^}]*\})?[ \t]*$/gm
const CLOSING = /^:::[ \t]*$/gm
const ATTR = /(\w+)\s*=\s*"?([^",}\s]+)"?/g

export interface ChallengeSource {
  /** Absolute path to the node directory, or to a concept `.md` file. */
  path: string
  /** File contents, keyed by name, so callers can read from disk or memory. */
  files?: Record<string, string>
}

interface Block {
  name: string
  attrs: Record<string, string>
  body: string
}

export function splitBlocks(body: string): Block[] {
  const blocks: Block[] = []
  let position = 0
  BLOCK.lastIndex = 0
  let opening = BLOCK.exec(body)
  while (opening) {
    const before = body.slice(position, opening.index)
    if (before.trim()) blocks.push({ name: 'prose', attrs: {}, body: before })

    const attrs: Record<string, string> = {}
    for (const [, key, value] of (opening[2] ?? '').matchAll(ATTR)) attrs[key] = value

    CLOSING.lastIndex = opening.index + opening[0].length
    const closing = CLOSING.exec(body)
    const inner = closing
      ? body.slice(opening.index + opening[0].length, closing.index)
      : body.slice(opening.index + opening[0].length)
    blocks.push({ name: opening[1], attrs, body: inner })

    position = closing ? closing.index + closing[0].length : body.length
    BLOCK.lastIndex = position
    opening = BLOCK.exec(body)
  }
  const tail = body.slice(position)
  if (tail.trim()) blocks.push({ name: 'prose', attrs: {}, body: tail })
  return blocks
}

export function readFrontMatter(text: string): {
  meta: Record<string, unknown>
  body: string
} {
  if (!text.startsWith('+++'))
    throw new Error('A challenges node starts with a +++ front matter block')
  const [, raw, body] = text.split('+++')
  return {
    meta: parseToml(raw) as Record<string, unknown>,
    // The title lives in front matter; a leading H1 would duplicate it.
    body: body.replace(/^\s*#\s+.*\n/, ''),
  }
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function tableRows(markdown: string): string[][] {
  return markdown
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|[\s:|-]+\|$/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    )
}

export function createChallengesAdapter(): PublicationSourceAdapter<ChallengeSource> {
  return {
    id: CHALLENGES_ADAPTER_ID,
    version: PUBLICATION_SOURCE_ADAPTER_VERSION,
    async adapt(input: ChallengeSource): Promise<PublicationSourceResult> {
      const files = input.files ?? (await readNodeFiles(input.path))
      const entry = files['challenge.md'] ?? files[`${basename(input.path)}`]
      if (!entry) throw new Error(`No node document found at ${input.path}`)

      const { meta, body } = readFrontMatter(entry)
      const nodeId = String(meta.id)
      const locale = 'en'
      const direction = 'ltr' as const
      const editionId = `${nodeId}-en`

      let counter = 0
      const nextId = (prefix: string) => `${nodeId}-${prefix}-${++counter}`

      const base = (id: string, importance: PublicationNode['importance'] = 'essential') => ({
        id,
        locale,
        direction,
        requirement: 'required' as const,
        importance,
        provenance: {
          adapterId: CHALLENGES_ADAPTER_ID,
          sourceId: nodeId,
          evidence: [],
          idOrigin: 'derived' as const,
        },
        accessibility: { decorative: false },
        variants: [],
        permittedTransformationIds: [],
        edition: { editionId },
      })

      const nodes: PublicationNode[] = []
      const heading = {
        ...base(nextId('heading')),
        type: 'heading' as const,
        level: 1 as const,
        text: String(meta.title),
      }
      nodes.push(heading as PublicationNode)

      for (const block of splitBlocks(body)) {
        if (block.name === 'statement' || block.name === 'prose') {
          for (const text of paragraphs(block.body))
            nodes.push({ ...base(nextId('paragraph')), type: 'paragraph', text } as PublicationNode)
          continue
        }

        if (block.name === 'io' || block.name === 'constraints') {
          const items = (
            block.name === 'io'
              ? block.body
                  .trim()
                  .split('\n')
                  .filter((line) => line.includes(':'))
                  .map((line) => {
                    const [key, ...rest] = line.split(':')
                    return `${key.trim()}: ${rest.join(':').trim()}`
                  })
              : block.body
                  .trim()
                  .split('\n')
                  .map((line) => line.replace(/^[-*]\s*/, '').trim())
                  .filter(Boolean)
          ).filter(Boolean)
          if (!items.length) continue
          const listId = nextId('list')
          const itemIds: string[] = []
          for (const item of items) {
            const itemId = nextId('list-item')
            itemIds.push(itemId)
            nodes.push({
              ...base(itemId),
              type: 'list-item',
              parentListId: listId,
              text: item,
            } as PublicationNode)
          }
          nodes.push({
            ...base(listId),
            type: 'list',
            ordered: false,
            itemIds,
          } as PublicationNode)
          continue
        }

        if (block.name === 'sample') {
          const rows = tableRows(block.body)
          if (rows.length < 2) continue
          nodes.push({
            ...base(nextId('table')),
            type: 'table',
            rows: rows.map((cells, rowIndex) => ({
              cells: cells.map((text) => ({
                text,
                // the first row of a sample is its header
                headerScope: rowIndex === 0 ? ('column' as const) : null,
                columnSpan: 1,
                rowSpan: 1,
              })),
            })),
          } as PublicationNode)
          continue
        }

        if (block.name === 'figure') {
          const figureId = nextId('figure')
          const figureRef = String(block.attrs.id ?? meta.figure ?? '')
          const caption = paragraphs(block.body)[0]
          const captionId = caption ? nextId('caption') : undefined
          nodes.push({
            ...base(figureId),
            type: 'figure',
            title: figureRef || String(meta.title),
            assetIds: [],
            ...(captionId ? { captionId } : {}),
            ...(caption ? { sourceText: caption } : {}),
          } as PublicationNode)
          if (captionId && caption)
            nodes.push({
              ...base(captionId, 'supporting'),
              type: 'caption',
              parentId: figureId,
              text: caption,
            } as PublicationNode)
          continue
        }

        if (block.name === 'run') {
          const starterName = block.attrs.starter ?? 'starter.py'
          const starter = files[starterName]
          if (!starter) continue
          nodes.push({
            ...base(nextId('code')),
            type: 'code',
            language: 'python',
            code: starter,
          } as PublicationNode)
          continue
        }

        if (block.name === 'hint' || block.name === 'solution') {
          const text = paragraphs(block.body).join(' ')
          if (!text) continue
          nodes.push({
            ...base(nextId(block.name), 'supplemental'),
            type: 'aside',
            requirement: 'optional',
            text,
          } as PublicationNode)
        }
      }

      const graph: PublicationGraph = {
        version: PUBLICATION_GRAPH_VERSION,
        id: nodeId,
        metadata: {
          title: String(meta.title),
          contributors: [],
          defaultLocale: locale,
          defaultDirection: direction,
          keywords: [],
        },
        edition: { id: editionId, locale, direction },
        nodes,
      } as PublicationGraph

      return {
        graph,
        // Figures are referenced by id and resolved by the renderer; a node
        // carries no bytes of its own yet.
        assetBundle: createAssetBundle(
          { version: ASSET_BUNDLE_VERSION, assets: [] },
          async () => {
            throw new Error('This adapter publishes no assets')
          },
        ),
        diagnostics: [],
        provenance: {
          adapterId: CHALLENGES_ADAPTER_ID,
          adapterVersion: PUBLICATION_SOURCE_ADAPTER_VERSION,
          sourceType: 'challenges',
          sourceId: nodeId,
          mappingVersion: CHALLENGES_MAPPING_VERSION,
        },
      }
    },
  }
}

async function readNodeFiles(path: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isFile()) files[entry.name] = await readFile(join(path, entry.name), 'utf8')
  }
  return files
}

export const challengesPublicationAdapter = createChallengesAdapter()
