import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import { buildEpub, inspectEpub } from './epub'
import { researchPaperSchema } from './schema'
import { getTargetProfile } from './targets'

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

  it('derives deterministic device CSS and progression metadata from profiles', async () => {
    const paperPro = getTargetProfile('paperPro')
    const paperMove = getTargetProfile('paperProMove')
    const [first, second, move] = await Promise.all([
      buildEpub(paper, paperPro),
      buildEpub(paper, undefined, paperPro),
      buildEpub(paper, paperMove),
    ])

    expect(first.bytes).toEqual(second.bytes)
    expect(first.fileName).toBe('publication-paperpro.epub')
    expect(move.fileName).toBe('publication-papermove.epub')
    expect(first.bytes).not.toEqual(move.bytes)

    const { files, manifest } = inspectEpub(first.bytes, paperPro)
    const css = strFromU8(files['EPUB/styles.css'])
    const opf = strFromU8(files['EPUB/package.opf'])
    expect(css).toContain(`font-family: ${paperPro.typography.fontFamily}`)
    expect(css).toContain(`font-size: ${paperPro.typography.bodySizeCssPx}px`)
    expect(css).toContain('6.713% 8.025% 6.713% 8.025%')
    expect(opf).toContain(
      `page-progression-direction="${paperPro.epub.pageProgressionDirection}"`,
    )
    expect(opf).toContain(
      `<meta property="rendition:flow">${paperPro.epub.renditionFlow}</meta>`,
    )
    expect(manifest).toMatchObject({
      schemaVersion: '1.1.0',
      rendition: 'profile-tuned-reflowable-epub',
      profile: {
        id: 'paperPro',
        version: paperPro.version,
        pixelsPerInch: paperPro.pixelsPerInch,
        compositionPolicy: { id: 'large-eink', version: '1.1.0' },
        exportPolicy: {
          id: 'profile-tuned-reflowable',
          version: '1.0.0',
        },
      },
    })
  })
})
