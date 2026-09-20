import { describe, expect, it } from 'vitest'

import {
  CHALLENGES_ADAPTER_ID,
  challengesPublicationAdapter,
  readFrontMatter,
  splitBlocks,
} from './challenges'
import { validatePublicationSourceResult } from '../source-adapter'

const CHALLENGE = `+++
id = "biggest-product"
kind = "challenge"
title = "Biggest product of two"
module = "pairwise"
figure = "two-biggest"

[limits]
time_seconds = 5
memory_mb = 512

[tiers.public]
xp = 10
timeout = 30
+++

:::statement
You get a list of whole numbers, none of them negative. Multiply two of them
together and get the biggest result you can.

The two numbers must sit in different spots in the list.
:::

:::io
input: a list of whole numbers
output: the largest product of two of them
:::

:::constraints
- The list holds at least 2 numbers.
- Every number is between 0 and 200,000.
:::

:::sample
| Input | Output |
|---|---|
| \`[1, 2, 3]\` | \`6\` |
| \`[0, 0, 7]\` | \`0\` |
:::

:::figure{id="two-biggest"}
One pass over the list, keeping the best two values seen so far.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
You do not have to look at every pair.
:::

:::solution
Walk the list once, remembering the best two values.
:::
`

const FILES = {
  'challenge.md': CHALLENGE,
  'starter.py': 'def max_pairwise_product(numbers):\n    raise NotImplementedError\n',
}

const adapt = () =>
  challengesPublicationAdapter.adapt({ path: '/nodes/biggest-product', files: FILES })

describe('challenges source adapter', () => {
  it('reads TOML front matter and drops a duplicated leading heading', () => {
    const { meta, body } = readFrontMatter('+++\nid = "x"\ntitle = "X"\n+++\n\n# X\n\nBody.\n')
    expect(meta.id).toBe('x')
    expect(body.trim()).toBe('Body.')
  })

  it('splits the body into directive blocks and prose', () => {
    const names = splitBlocks(readFrontMatter(CHALLENGE).body).map((block) => block.name)
    expect(names).toEqual([
      'statement',
      'io',
      'constraints',
      'sample',
      'figure',
      'run',
      'hint',
      'solution',
    ])
  })

  it('keeps block attributes', () => {
    const blocks = splitBlocks(readFrontMatter(CHALLENGE).body)
    expect(blocks.find((b) => b.name === 'figure')?.attrs.id).toBe('two-biggest')
    expect(blocks.find((b) => b.name === 'run')?.attrs.starter).toBe('starter.py')
    expect(blocks.find((b) => b.name === 'hint')?.attrs.level).toBe('1')
  })

  it('produces a graph the publication codec accepts', async () => {
    const result = await adapt()
    expect(() => validatePublicationSourceResult(result)).not.toThrow()
    expect(result.provenance.adapterId).toBe(CHALLENGES_ADAPTER_ID)
  })

  it('maps each directive onto the compiler vocabulary', async () => {
    const { graph } = await adapt()
    const types = graph.nodes.map((node) => node.type)

    expect(types[0]).toBe('heading')
    expect(types).toContain('paragraph')
    expect(types).toContain('list')
    expect(types).toContain('list-item')
    expect(types).toContain('table')
    expect(types).toContain('figure')
    expect(types).toContain('caption')
    expect(types).toContain('code')
    expect(types.filter((type) => type === 'aside')).toHaveLength(2)
  })

  it('carries the statement as paragraphs, not one blob', async () => {
    const { graph } = await adapt()
    const text = graph.nodes
      .filter((node) => node.type === 'paragraph')
      .map((node) => ('text' in node ? node.text : ''))
    expect(text.length).toBeGreaterThanOrEqual(2)
    expect(text[0]).toContain('none of them negative')
  })

  it('keeps the sample as a table whose first row is its header', async () => {
    const { graph } = await adapt()
    const table = graph.nodes.find((node) => node.type === 'table')
    if (!table || !('rows' in table)) throw new Error('no table node')

    expect(table.rows).toHaveLength(3)
    expect(table.rows[0].cells.map((cell) => cell.text)).toEqual(['Input', 'Output'])
    expect(table.rows[0].cells.every((cell) => cell.headerScope === 'column')).toBe(true)
    expect(table.rows[1].cells.every((cell) => cell.headerScope === null)).toBe(true)
    expect(table.rows[2].cells.map((cell) => cell.text)).toEqual(['`[0, 0, 7]`', '`0`'])
  })

  it('takes the starter file as the exercise code', async () => {
    const { graph } = await adapt()
    const code = graph.nodes.find((node) => node.type === 'code')
    expect(code && 'code' in code && code.code).toContain('def max_pairwise_product')
    expect(code && 'language' in code && code.language).toBe('python')
  })

  it('marks hints and the solution as optional, supplemental asides', async () => {
    const { graph } = await adapt()
    const asides = graph.nodes.filter((node) => node.type === 'aside')
    expect(asides.every((node) => node.requirement === 'optional')).toBe(true)
    expect(asides.every((node) => node.importance === 'supplemental')).toBe(true)
  })

  it('gives every node a stable id derived from the node id', async () => {
    const { graph } = await adapt()
    const ids = graph.nodes.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('biggest-product-'))).toBe(true)

    const again = await adapt()
    expect(again.graph.nodes.map((node) => node.id)).toEqual(ids)
  })

  it('refuses a document with no front matter', async () => {
    await expect(
      challengesPublicationAdapter.adapt({
        path: '/nodes/broken',
        files: { 'challenge.md': '# No front matter\n' },
      }),
    ).rejects.toThrow(/front matter/)
  })
})
