import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import { buildEpub, inspectEpub } from './epub'
import { researchPaperSchema } from './schema'

const paper = researchPaperSchema.parse(rawPaper)

describe('EPUB 3 export', () => {
  it('builds a deterministic reflowable container with stored first mimetype', async () => {
    const first = await buildEpub(paper)
    const second = await buildEpub(paper)
    const { files, entries } = inspectEpub(first.bytes)

    expect(first.bytes).toEqual(second.bytes)
    expect(first.sha256).toBe(second.sha256)
    expect(first.fileName).toMatch(/\.epub$/)
    expect(entries[0]).toBe('mimetype')
    expect(first.bytes[8] | (first.bytes[9] << 8)).toBe(0)
    expect(strFromU8(files['META-INF/container.xml'])).toContain(
      'EPUB/package.opf',
    )
    expect(strFromU8(files['EPUB/package.opf'])).toContain('version="3.0"')
    expect(strFromU8(files['EPUB/package.opf'])).toContain('properties="nav"')
  })

  it('preserves canonical reading order and addressable node IDs in XHTML', async () => {
    const epub = await buildEpub(paper)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json']))

    expect(manifest.canonicalNodeIds).toEqual(
      paper.nodes.map((node) => node.id),
    )
    for (const node of paper.nodes) {
      expect(content).toContain(`id="${node.id}"`)
    }
    expect(content.indexOf(paper.nodes[0].id)).toBeLessThan(
      content.indexOf(paper.nodes.at(-1)!.id),
    )
  })

  it('escapes publication metadata rather than emitting invalid XHTML', async () => {
    const escaped = structuredClone(paper)
    escaped.title = 'Evidence & <meaning>'
    escaped.authors = ['A. "Reader" & Co.']
    const epub = await buildEpub(escaped)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain('Evidence &amp; &lt;meaning&gt;')
    expect(content).not.toContain('Evidence & <meaning>')
  })
})
