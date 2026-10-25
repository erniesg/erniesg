import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeStructDocument,
  encodeStructDocument,
  type StructBlock,
  type StructDocument,
} from '@erniesg/struct/document'
import { buildStructDocument } from '../src/struct-adapters/from-reconstruction'
import { adaptStructDocument } from '../src/publication/struct-adapter'
import { serializePublicationGraph } from '../src/publication/schema'
import { publicationSourceBindingSchema } from '../src/publication/source-binding'
import {
  createPublicationContractReceipt,
  validatePublicationSourceResult,
  type PublicationSourceResult,
} from '../src/publication/source-adapter'
import { readStructPackagePin } from '../src/publication/struct-package-pin'
import {
  structCutoverSourceBindingSync,
  structDocumentJson,
  structDocumentSha256,
} from '../src/publication/struct-source-binding'
import { decodeReconstruction } from './fixtures/struct-adapter-parity/observe'

/**
 * The fixture is read and the ingress conversion is run inside every test, so
 * the timeout is explicit rather than the default.
 */
const ADAPT_TIMEOUT = 300_000

/**
 * EG-09 - the double-adapt conformance for one pinned Struct document.
 *
 * The pinned document is the checked-in Struct ingress fixture, loaded with
 * the repository's own decoder and converted with the app-owned ingress
 * `buildStructDocument`. The same document is adapted twice, and the two
 * adaptations must agree byte for byte: the graph bytes, the encoded document,
 * the source binding and the persisted serialization.
 *
 * The last assertions are the ones that matter for the convergence: the graph
 * is not the text authority. Every text-bearing graph node carries the text
 * of the Struct block it was projected from, and every graph node id is a
 * Struct block id (or a documented deterministic suffix of one), so the graph
 * can never author text or a semantic id of its own.
 */
const repositoryRoot = resolve(import.meta.dirname, '..')

async function loadPinnedDocument(): Promise<StructDocument> {
  const text = await readFile(
    new URL(
      './fixtures/struct-adapter-parity/reconstructions/ordinary-pdf.json',
      import.meta.url,
    ),
    'utf8',
  )
  return buildStructDocument(decodeReconstruction(text))
}

/**
 * The Struct block a graph node was projected from.
 *
 * A graph node id is the Struct block id verbatim. The only deviations are
 * the documented deterministic suffixes of a block id: `-list` for a synthetic
 * list container, `-occurrence-N` for a repeated inline relationship and
 * `-cell-<cell id>` for a table cell anchor.
 */
function sourceBlockId(
  nodeId: string,
  blocks: ReadonlyMap<string, StructBlock>,
): string | undefined {
  if (blocks.has(nodeId)) return nodeId
  for (const pattern of [
    /^(.*)-list$/u,
    /^(.*)-occurrence-\d+$/u,
    /^(.*)-cell-.+$/u,
  ]) {
    const match = pattern.exec(nodeId)
    if (match && blocks.has(match[1]!)) return match[1]!
  }
  return undefined
}

describe('EG-09 double-adapt conformance for one pinned Struct document', () => {
  it(
    'serializes the same graph bytes for two adaptations of the same document',
    async () => {
      const document = await loadPinnedDocument()
      const first = adaptStructDocument(document)
      const second = adaptStructDocument(document)
      const firstBytes = serializePublicationGraph(first.graph)
      const secondBytes = serializePublicationGraph(second.graph)
      expect(firstBytes.length).toBeGreaterThan(0)
      expect(firstBytes).toBe(secondBytes)
    },
    ADAPT_TIMEOUT,
  )

  it(
    'encodes the same Struct document bytes on every call',
    async () => {
      const document = await loadPinnedDocument()
      const first = encodeStructDocument(document)
      const second = encodeStructDocument(document)
      expect(JSON.stringify(first)).toBe(JSON.stringify(second))
      expect(structDocumentSha256(document)).toBe(structDocumentSha256(document))
    },
    ADAPT_TIMEOUT,
  )

  it(
    'binds both adaptations to the digest of the document they came from',
    async () => {
      const document = await loadPinnedDocument()
      const pin = await readStructPackagePin(repositoryRoot)
      const first = structCutoverSourceBindingSync(document, pin)
      const second = structCutoverSourceBindingSync(document, pin)
      // Byte-identical, not deep-equal: the binding is a value the receipts
      // carry verbatim.
      expect(JSON.stringify(first)).toBe(JSON.stringify(second))
      expect(first.documentSha256).toBe(structDocumentSha256(document))
      expect(publicationSourceBindingSchema.parse(first)).toEqual(first)
    },
    ADAPT_TIMEOUT,
  )

  it(
    'persists the same Struct document bytes on every call',
    async () => {
      const document = await loadPinnedDocument()
      const first = structDocumentJson(document)
      const second = structDocumentJson(document)
      expect(first.length).toBeGreaterThan(0)
      expect(first).toBe(second)
      // The persisted semantic artifact is the Struct document, never a graph
      // facade and never the graph's node array.
      expect(first.includes('"nodes"')).toBe(false)
    },
    ADAPT_TIMEOUT,
  )

  it(
    'projects the same graph from the re-encoded document',
    async () => {
      const document = await loadPinnedDocument()
      const canonical = decodeStructDocument(encodeStructDocument(document))
      expect(
        serializePublicationGraph(adaptStructDocument(canonical).graph),
      ).toBe(serializePublicationGraph(adaptStructDocument(document).graph))
    },
    ADAPT_TIMEOUT,
  )

  it(
    'never lets the graph author text or a semantic id',
    async () => {
      const document = await loadPinnedDocument()
      const result = adaptStructDocument(document)
      const blocks = new Map(document.blocks.map((block) => [block.id, block]))
      const problems: string[] = []
      let textBearing = 0
      for (const node of result.graph.nodes) {
        const record = node as unknown as Record<string, unknown>
        const blockId = sourceBlockId(node.id, blocks)
        if (!blockId) {
          problems.push(`node ${node.id} is not a Struct block id`)
          continue
        }
        const block = blocks.get(blockId)!
        const text = record.text
        if (typeof text === 'string') {
          textBearing += 1
          // A text-bearing node is the projection of one block, so its id is
          // the block id and its text is the block's text.
          if (node.id !== block.id)
            problems.push(`node ${node.id} carries text but is not a block id`)
          if (text !== block.text)
            problems.push(
              `node ${node.id} does not carry the text of block ${block.id}`,
            )
        }
        if (typeof record.code === 'string' && record.code !== block.text)
          problems.push(`code node ${node.id} does not carry the block text`)
        if (typeof record.source === 'string' && record.source !== block.text)
          problems.push(`equation node ${node.id} does not carry the block text`)
        if (
          typeof record.sourceText === 'string' &&
          record.sourceText !== block.text
        )
          problems.push(`figure node ${node.id} does not carry the block text`)
        if (typeof record.title === 'string') {
          const expected = block.label || block.text
          if (record.title !== expected)
            problems.push(
              `figure node ${node.id} does not carry the block title`,
            )
        }
      }
      // The fixture really does project text, so the assertions above are not
      // vacuous.
      expect(textBearing).toBeGreaterThan(0)
      expect(problems).toEqual([])
    },
    ADAPT_TIMEOUT,
  )

  it(
    'carries the binding on the contract receipt and refuses a forged digest',
    async () => {
      const document = await loadPinnedDocument()
      const pin = await readStructPackagePin(repositoryRoot)
      const result = adaptStructDocument(document)
      const binding = structCutoverSourceBindingSync(document, pin)
      const bound: PublicationSourceResult = {
        ...result,
        structDocument: document,
        sourceBinding: binding,
      }
      const receipt = createPublicationContractReceipt(bound, {
        toolchain: {
          node: process.version,
          packageLockSha256: 'a'.repeat(64),
        },
        repository: { commit: 'b'.repeat(40), dirty: false },
      })
      expect(receipt.sourceBinding).toEqual(binding)
      const receiptBinding = receipt.sourceBinding
      expect(receiptBinding?.kind).toBe('struct-cutover')
      if (receiptBinding?.kind !== 'struct-cutover')
        throw new Error('The contract receipt carries no Struct binding')
      expect(receiptBinding.documentSha256).toBe(structDocumentSha256(document))
      // A binding that claims a digest the document does not have is refused:
      // the binding can only ever describe bytes this invocation produced.
      expect(() =>
        validatePublicationSourceResult({
          ...result,
          structDocument: document,
          sourceBinding: { ...binding, documentSha256: 'c'.repeat(64) },
        }),
      ).toThrow(/document digest does not match/)
    },
    ADAPT_TIMEOUT,
  )
})
