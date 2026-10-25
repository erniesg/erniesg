import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadAdapterCase } from '../../tests/fixtures/struct-adapter-parity/cases'
import { buildStructDocument } from '../struct-adapters'
import { buildAstroStructDocument } from '../struct-adapters/from-markdown'
import { adaptStructDocument } from './struct-adapter'
import { legacyResearchPaperSourceBinding } from './source-binding'
import {
  createPublicationContractReceipt,
  validatePublicationSourceResult,
  type PublicationSourceResult,
} from './source-adapter'
import { readStructPackagePin } from './struct-package-pin'
import { structCutoverSourceBinding } from './struct-source-binding'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

const environment = {
  toolchain: {
    node: 'v22.22.3',
    packageLockSha256: 'a'.repeat(64),
  },
  repository: { commit: 'b'.repeat(40), dirty: false as const },
}

/**
 * The legacy ResearchPaper source, taken through the Struct projection.
 *
 * The retired forward producer minted its own graph from a `ResearchPaper`.
 * The legacy source type now reaches the publication layer the only way it
 * may: through the app-owned ingress conversion, which produces a
 * `StructDocument`, and the one Struct projection, which produces the graph.
 * The source type of that document is not a PDF and not a DOCX, so the
 * projection reports the legacy `research-paper` source type and the legacy
 * binding variant applies to it, exactly as the contract says.
 */
let legacyDocument: Awaited<
  ReturnType<typeof buildAstroStructDocument>
>['document']
let legacyResult: PublicationSourceResult

beforeAll(async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'publication-source-binding-'))
  const entry = resolve(root, 'legacy-research-paper')
  await mkdir(entry)
  await writeFile(
    resolve(entry, 'index.mdx'),
    [
      '---',
      'title: Legacy Research Paper',
      'description: A Struct ingress fixture for the legacy source type.',
      'date: 2026-07-27',
      '---',
      'A legacy research paper paragraph, carried by the Struct document.',
      '',
    ].join('\n'),
  )
  const conversion = await buildAstroStructDocument({
    entryId: 'legacy-research-paper',
    contentRoot: root,
  })
  legacyDocument = conversion.document
  legacyResult = adaptStructDocument(legacyDocument)
})

function nonResearchPaperResult(
  overrides: Partial<PublicationSourceResult> = {},
): PublicationSourceResult {
  return {
    ...legacyResult,
    provenance: {
      adapterId: 'astro',
      adapterVersion: '1.0.0',
      sourceType: 'astro',
      sourceId: 'blog:entry',
    },
    sourceBinding: undefined,
    ...overrides,
  }
}

describe('publication source binding on the source result', () => {
  it('gives the legacy ResearchPaper path the legacy binding', () => {
    const result = legacyResult
    const validated = validatePublicationSourceResult(result)
    expect(validated.sourceBinding).toEqual(legacyResearchPaperSourceBinding())
    expect(Object.keys(validated.sourceBinding!)).toEqual(['kind'])
    // The legacy variant carries no Struct field at all: no placeholder
    // digest and no fabricated package pin.
    expect(validated.sourceBinding).not.toHaveProperty('documentSha256')
    expect(validated.sourceBinding).not.toHaveProperty('packageSourceCommit')
  })

  it('projects the legacy ResearchPaper source through the Struct document', () => {
    // The graph is the projection of the Struct document and of nothing
    // else: its text is the text of the Struct block it was projected from,
    // and its id is that block's id. The retired producer's own id and text
    // namespace does not exist any more.
    const blocks = new Map(legacyDocument.blocks.map((b) => [b.id, b]))
    const result = legacyResult
    expect(result.provenance.sourceType).toBe('research-paper')
    expect(result.graph.nodes.length).toBeGreaterThan(0)
    const texts: string[] = []
    for (const node of result.graph.nodes) {
      const block = blocks.get(node.id)
      expect(block, `node ${node.id} is not a Struct block id`).toBeDefined()
      if (!('text' in node)) continue
      expect(node.text).toBe(block!.text)
      texts.push(node.text)
    }
    expect(texts).toEqual([
      'A legacy research paper paragraph, carried by the Struct document.',
    ])
  })

  it('carries the binding into the contract receipt', () => {
    const receipt = createPublicationContractReceipt(legacyResult, environment)
    expect(receipt.sourceBinding).toEqual(legacyResearchPaperSourceBinding())
    // The graph and asset digests stay beside it as diagnostic fields.
    expect(receipt.graphSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.assetBundleSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('leaves a source without a Struct document unbound', () => {
    const result = nonResearchPaperResult()
    const validated = validatePublicationSourceResult(result)
    expect(validated.sourceBinding).toBeUndefined()
    expect(
      createPublicationContractReceipt(result, environment).sourceBinding,
    ).toBeUndefined()
  })

  it('accepts a Struct binding that matches its Struct document', async () => {
    const document = buildStructDocument(await loadAdapterCase('ordinary-pdf'))
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = await structCutoverSourceBinding(document, pin)
    const result = nonResearchPaperResult({
      structDocument: document,
      sourceBinding: binding,
    })
    const validated = validatePublicationSourceResult(result)
    expect(validated.sourceBinding).toEqual(binding)
    expect(
      createPublicationContractReceipt(result, environment).sourceBinding,
    ).toEqual(binding)
  })

  it('rejects a Struct binding without the document it was derived from', async () => {
    const document = buildStructDocument(await loadAdapterCase('ordinary-pdf'))
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = await structCutoverSourceBinding(document, pin)
    const result = nonResearchPaperResult({ sourceBinding: binding })
    expect(() => validatePublicationSourceResult(result)).toThrow(
      /require the Struct document they were derived from/,
    )
  })

  it('rejects a Struct binding whose digest does not match its document', async () => {
    const document = buildStructDocument(await loadAdapterCase('ordinary-pdf'))
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = await structCutoverSourceBinding(document, pin)
    const result = nonResearchPaperResult({
      structDocument: document,
      sourceBinding: { ...binding, documentSha256: 'f'.repeat(64) },
    })
    expect(() => validatePublicationSourceResult(result)).toThrow(
      /document digest does not match the Struct document/,
    )
  })

  it('rejects a Struct binding on the legacy ResearchPaper path', async () => {
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = await structCutoverSourceBinding(legacyDocument, pin)
    const result: PublicationSourceResult = {
      ...legacyResult,
      structDocument: legacyDocument,
      sourceBinding: binding,
    }
    expect(() => validatePublicationSourceResult(result)).toThrow(
      /binding kind does not match its source type: struct-cutover for research-paper/,
    )
  })

  it('rejects the legacy binding on a source that is not a ResearchPaper', () => {
    const result = nonResearchPaperResult({
      sourceBinding: legacyResearchPaperSourceBinding(),
    })
    expect(() => validatePublicationSourceResult(result)).toThrow(
      /binding kind does not match its source type: legacy-research-paper for astro/,
    )
  })
})
