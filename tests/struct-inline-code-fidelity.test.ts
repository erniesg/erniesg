import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import matter from 'gray-matter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { beforeAll, describe, expect, it } from 'vitest'
import { adaptAstroBlogEntry } from '../src/publication/adapters/astro'
import {
  publicationAssetFileExtension,
  publicationGraphToHtml,
} from '../src/publication/renderers/vivliostyle'

/**
 * The inline-code fidelity record.
 *
 * The fixture is the measured base-vs-candidate-vs-fixed comparison of five
 * real inline-code spans. Every side ran its own repository publication
 * adapter over byte-identical extracted source bytes and rendered its own
 * phone-webpub XHTML, so the recorded bytes are measurements, not claims.
 *
 * This test re-measures the fixed side against the same bytes and fails if
 * the current tree stops matching the record.
 */

const root = new URL('../', import.meta.url)
const fixture = JSON.parse(
  await readFile(
    new URL(
      'tests/fixtures/struct-inline-code/case-comparison-20261021.json',
      root,
    ),
    'utf8',
  ),
)

const processor = unified()
  .use(remarkParse)
  .use(remarkMdx)
  .use(remarkGfm)
  .use(remarkMath)

const SLOW = { timeout: 180_000 }

type Span = {
  value: string
  occurrenceIndex: number
  sourceLine: number
  sourceColumn: number
  start: number
  end: number
  baseHtmlBytes: string
  e04CandidateHtmlBytes: string
  fixedHtmlBytes: string
}

type Case = {
  id: string
  sourceFile: string
  sourceSha256: string
  blockType: string
  blockContentLines: string
  blockTextSha256: string
  spans: Span[]
  baseInlineRuns: unknown[]
  e04CandidateInlineRuns: unknown[]
  fixedInlineRuns: unknown[]
  e04CandidateLossyInlineStyleDiagnostics: number
  fixedLossyInlineStyleDiagnostics: number
}

const cases = fixture.cases as Case[]

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Extract the exact source bytes of the top-level mdast block that holds the
 * measured spans, and place them in a temporary Astro collection entry with
 * the original frontmatter, so the real ingress sees the real bytes.
 */
async function extractedEntry(entry: Case) {
  const source = await readFile(new URL(entry.sourceFile, root), 'utf8')
  expect(sha256(source)).toBe(entry.sourceSha256)
  const parsed = matter(source)
  const { content } = parsed
  const tree = processor.parse(content)
  const spans: { value: string; line: number; column: number }[] = []
  const visit = (node: {
    type: string
    value?: string
    position?: { start?: { line?: number; column?: number } }
    children?: unknown[]
  }) => {
    if (node.type === 'inlineCode')
      spans.push({
        value: node.value ?? '',
        line: node.position?.start?.line ?? 0,
        column: node.position?.start?.column ?? 0,
      })
    for (const child of (node.children ?? []) as typeof node[])
      visit(child)
  }
  visit(tree as never)
  const [first, last] = entry.blockContentLines.split('-').map(Number)
  const blockSpans = spans.filter(
    (span) => span.line >= first && span.line <= last,
  )
  const target = blockSpans[entry.spans[0]!.occurrenceIndex]
  expect(target?.value).toBe(entry.spans[0]!.value)
  const block = (tree.children ?? []).find(
    (child) =>
      (child.position?.start?.line ?? 0) <= (target?.line ?? 0) &&
      (child.position?.end?.line ?? 0) >= (target?.line ?? 0),
  )
  expect(block).toBeDefined()
  const blockBytes = content.slice(
    block!.position!.start.offset!,
    block!.position!.end.offset!,
  )
  const frontmatter = source.slice(0, source.length - content.length)
  const collection = await mkdtemp(
    resolve(tmpdir(), 'inline-code-fidelity-'),
  )
  const directory = resolve(collection, entry.id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    resolve(directory, 'index.mdx'),
    `${frontmatter}\n${blockBytes}`,
  )
  // The entry keeps its original frontmatter, so a hero image has to come
  // with it or the ingress refuses the entry.
  const hero = parsed.data.image
  if (hero)
    await copyFile(
      new URL(String(hero).replace(/^\.\//, ''), new URL(entry.sourceFile, root)),
      resolve(directory, String(hero).replace(/^\.\//, '')),
    )
  return { collection, directory }
}

async function render(entry: Case) {
  const { collection: collectionRoot } = await extractedEntry(entry)
  const result = await adaptAstroBlogEntry({
    entryId: entry.id.replace(/-/g, '-'),
    contentRoot: collectionRoot,
  })
  const assetPaths = new Map<string, string>()
  for (const descriptor of result.assetBundle.descriptor.assets)
    assetPaths.set(
      descriptor.id,
      `assets/${descriptor.id}${publicationAssetFileExtension(
        descriptor.fileName,
        descriptor.mediaType,
      )}`,
    )
  const html = publicationGraphToHtml(result.graph, assetPaths, 'phone-webpub')
  const paragraph = result.graph.nodes.find(
    (node) => node.type === 'paragraph' && 'text' in node,
  )
  return {
    result,
    html,
    paragraph,
    inlineRuns:
      paragraph && 'inlineRuns' in paragraph ? (paragraph.inlineRuns ?? []) : [],
  }
}

describe('inline-code fidelity against the measured record', () => {
  it('measures five real inline-code spans', () => {
    expect(cases).toHaveLength(5)
    expect(cases.map((entry) => entry.id)).toContain('pinned-main')
    const spanCount = cases.reduce(
      (total, entry) => total + entry.spans.length,
      0,
    )
    expect(spanCount).toBeGreaterThanOrEqual(5)
  })

  for (const entry of cases) {
    it(`restores the inline code span of ${entry.id}`, SLOW, async () => {
      const { result, html, paragraph, inlineRuns } = await render(entry)

      // The text bytes are unchanged: the base, the E-04 candidate and this
      // branch all carry the same paragraph text.
      expect(sha256((paragraph as { text: string }).text)).toBe(
        entry.blockTextSha256,
      )

      // The E-04 candidate reduced every inline-code span to plain text and
      // reported each one as a lossy inline style.
      expect(entry.e04CandidateLossyInlineStyleDiagnostics).toBe(
        entry.spans.length,
      )
      expect(
        entry.e04CandidateInlineRuns.filter(
          (run) => (run as { inlineCode?: boolean }).inlineCode === true,
        ),
      ).toEqual([])
      expect(entry.baseInlineRuns).toEqual(entry.fixedInlineRuns)

      // This branch keeps the run and reports no loss.
      expect(
        result.diagnostics.filter(
          (diagnostic) => diagnostic.code === 'lossy-inline-style',
        ),
      ).toEqual([])
      expect(inlineRuns).toEqual(entry.fixedInlineRuns)
      expect(
        inlineRuns.filter((run) => run.inlineCode === true),
      ).toHaveLength(entry.spans.length)

      for (const span of entry.spans) {
        const run = inlineRuns.find(
          (candidate) =>
            candidate.start === span.start && candidate.end === span.end,
        )
        expect(run?.inlineCode).toBe(true)
        expect(
          (paragraph as { text: string }).text.slice(span.start, span.end),
        ).toBe(span.value)
        expect(html).toContain(span.fixedHtmlBytes)
      }
    })
  }

  it('renders the pinned production entry with the code element', SLOW, async () => {
    const result = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    const assetPaths = new Map<string, string>()
    for (const descriptor of result.assetBundle.descriptor.assets)
      assetPaths.set(
        descriptor.id,
        `assets/${descriptor.id}${publicationAssetFileExtension(
          descriptor.fileName,
          descriptor.mediaType,
        )}`,
      )
    const html = publicationGraphToHtml(result.graph, assetPaths, 'phone-webpub')
    expect(html).toContain('<code>main</code>')
    expect(html).not.toContain('push to main')
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'lossy-inline-style',
      ),
    ).toEqual([])
  })
})

describe('inline-code escaping in the publication output', () => {
  it('escapes the code text and keeps the same characters', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'inline-code-escaping-'))
    await mkdir(resolve(root, 'escaping'), { recursive: true })
    await writeFile(
      resolve(root, 'escaping', 'index.mdx'),
      '---\ntitle: Escaping\ndescription: Escaping fixture\ndate: 2026-10-21\n---\n\nRun `a<b & c` now.\n',
    )
    const result = await adaptAstroBlogEntry({
      entryId: 'escaping',
      contentRoot: root,
    })
    const html = publicationGraphToHtml(
      result.graph,
      new Map(),
      'phone-webpub',
    )
    expect(html).toContain('<code>a&lt;b &amp; c</code>')
    expect(html).not.toContain('<code>a<b & c</code>')
  })
})
