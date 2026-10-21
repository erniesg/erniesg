import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  decodeStructDocument,
  encodeStructDocument,
  type StructBlock,
} from '@erniesg/struct/document'
import { verifyStructReceipt } from '@erniesg/struct/receipt'
import { adaptStructDocument } from '../publication/struct-adapter'
import type { PublicationSourceResult } from '../publication/source-adapter'
import {
  buildAstroStructDocument,
  type AstroStructConversion,
} from './from-markdown'

const PRODUCTION_ENTRY = 'moving-to-cloudflare-with-astro'
const PRODUCTION_ALT =
  'The Astro logo in white on an orange-to-purple gradient'
/**
 * The Struct digest of the golden entry covers a 1.5 MB asset, so the
 * conversion and its projection are slower than the default test timeout
 * allows.
 */
const SLOW = { timeout: 120_000 }

let conversion: AstroStructConversion
let projection: PublicationSourceResult

beforeAll(async () => {
  conversion = await buildAstroStructDocument({ entryId: PRODUCTION_ENTRY })
  projection = adaptStructDocument(conversion.document)
}, SLOW.timeout)

async function temporaryEntry(name: string, body: string) {
  const root = await mkdtemp(resolve(tmpdir(), 'publication-struct-markdown-'))
  const entry = resolve(root, name)
  await mkdir(entry)
  await writeFile(
    resolve(entry, 'index.mdx'),
    `---\ntitle: ${name}\ndescription: Struct ingress fixture\ndate: 2026-07-27\n---\n${body}`,
  )
  return root
}

function expectGraphTextFromBlock(
  node: { type: string } & Record<string, unknown>,
  block: StructBlock,
) {
  switch (node.type) {
    case 'code':
      expect(node.code).toBe(block.text)
      break
    case 'equation':
      expect(node.source).toBe(block.text)
      break
    case 'figure':
      expect(node.title).toBe(block.label || block.text)
      expect(node.sourceText ?? undefined).toBe(block.text || undefined)
      break
    case 'list':
      break
    default:
      expect('text' in node ? node.text : undefined).toBe(block.text)
  }
}

describe('MDX to Struct document ingress', () => {
  it('builds a Struct document the pinned package decodes and verifies', () => {
    const document = conversion.document
    expect(document.schemaVersion).toBe('0.2.0')
    expect(document.documentId).toBeTruthy()
    expect(document.source.format).toBe('html')
    expect(document.source.fileName).toBe(`${PRODUCTION_ENTRY}/index.mdx`)
    expect(document.source.pageCount).toBe(0)
    expect(document.source.localOnly).toBe(true)
    expect(document.blocks.length).toBeGreaterThan(0)
    expect(document.assets).toHaveLength(1)
    expect(() => decodeStructDocument(document)).not.toThrow()
    expect(verifyStructReceipt(document)).toBe(true)
    expect(() => encodeStructDocument(document)).not.toThrow()
  })

  it('authors no graph text: every graph node text is its Struct block text', () => {
    const result = projection
    const blocks = new Map<string, StructBlock>(
      conversion.document.blocks.map((block) => [block.id, block]),
    )
    for (const node of result.graph.nodes) {
      if (node.type === 'list') {
        // The list container is a renderer-plan construct, not a Struct kind.
        expect('text' in node ? node.text : undefined).toBeUndefined()
        continue
      }
      const block = blocks.get(node.id)
      expect(block, `graph node ${node.id} has no Struct block`).toBeDefined()
      if (!block) continue
      expectGraphTextFromBlock(
        node as unknown as { type: string } & Record<string, unknown>,
        block,
      )
    }
  })

  it('mints every graph node id from a Struct block id', () => {
    const result = projection
    const blockIds = new Set(conversion.document.blocks.map((block) => block.id))
    for (const node of result.graph.nodes) {
      if (node.type === 'list') {
        expect(
          blockIds.has(node.id.replace(/-list$/, '')),
          `list container ${node.id} has no Struct block`,
        ).toBe(true)
        continue
      }
      expect(blockIds.has(node.id), `graph node ${node.id} is not a block id`).toBe(
        true,
      )
    }
  })

  it('carries the authored alternative text into the graph accessibility metadata', () => {
    const figure = conversion.document.blocks.find(
      (block) => block.kind === 'figure',
    )
    expect(figure).toBeDefined()
    expect(figure?.label).toBe(PRODUCTION_ALT)
    expect(figure?.attributes?.alternativeText).toBe(PRODUCTION_ALT)
    const result = projection
    const node = result.graph.nodes.find((candidate) => candidate.type === 'figure')
    expect(node).toBeDefined()
    expect(
      node && 'accessibility' in node
        ? node.accessibility.alternativeText
        : undefined,
    ).toBe(PRODUCTION_ALT)
    expect(result.assetBundle.descriptor.assets[0]).toMatchObject({
      accessibilityLabel: PRODUCTION_ALT,
    })
  })

  it('keeps the inline-code span as a code inline run', () => {
    const lossy = conversion.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'lossy-inline-style',
    )
    expect(lossy).toEqual([])
    const paragraph = conversion.document.blocks.find(
      (block) =>
        block.kind === 'paragraph' &&
        block.text.includes('when I push to main'),
    )
    expect(paragraph).toBeDefined()
    const code = paragraph?.inline.filter((run) => run.code === true) ?? []
    expect(code).toHaveLength(1)
    const run = code[0]
    expect(run).toBeDefined()
    // The exact span of the `main` span in the authored paragraph.
    expect(run?.start).toBe(122)
    expect(run?.end).toBe(126)
    expect(paragraph?.text.slice(run!.start, run!.end)).toBe('main')
  })

  it('projects the code inline run into the publication inline run', () => {
    const paragraph = conversion.document.blocks.find(
      (block) =>
        block.kind === 'paragraph' &&
        block.text.includes('when I push to main'),
    )
    expect(paragraph).toBeDefined()
    const node = projection.graph.nodes.find(
      (candidate) => candidate.id === paragraph?.id,
    )
    expect(node).toBeDefined()
    const runs = node && 'inlineRuns' in node ? (node.inlineRuns ?? []) : []
    const code = runs.filter((run) => run.inlineCode === true)
    expect(code).toHaveLength(1)
    expect(code[0]?.start).toBe(122)
    expect(code[0]?.end).toBe(126)
    expect(
      node && 'text' in node ? node.text.slice(code[0]!.start, code[0]!.end) : '',
    ).toBe('main')
  })

  it('fails the unsupported constructs the Astro adapter rejects today', async () => {
    const root = await temporaryEntry('thematic-break', '\nBefore\n\n---\n\nAfter\n')
    await expect(
      buildAstroStructDocument({ entryId: 'thematic-break', contentRoot: root }),
    ).rejects.toThrow(/thematicBreak/)

    const taskRoot = await temporaryEntry('task-list', '\n- [x] Shipped\n')
    await expect(
      buildAstroStructDocument({ entryId: 'task-list', contentRoot: taskRoot }),
    ).rejects.toThrow(/task-list/i)

    const mdxRoot = await temporaryEntry('mdx-component', '\n<ClientOnly />\n')
    await expect(
      buildAstroStructDocument({ entryId: 'mdx-component', contentRoot: mdxRoot }),
    ).rejects.toThrow(/Unsupported MDX node ClientOnly/)
  })
})
