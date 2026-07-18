import { readFile } from 'node:fs/promises'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildEpub, inspectEpub } from './epub'
import { reconstructDocx } from './docx-import'
import { researchPaperSchema } from './schema'

async function fixtureFile(name: string) {
  const bytes = await readFile(
    new URL(`../../tests/fixtures/docx/${name}`, import.meta.url),
  )
  return new File([bytes], name, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    lastModified: Date.UTC(2026, 6, 18),
  })
}

describe('local born-structured DOCX import', () => {
  it('maps explicit OOXML structure into a complete canonical graph', async () => {
    const result = await reconstructDocx(
      await fixtureFile('structured-manuscript.docx'),
    )

    expect(result.source).toMatchObject({
      format: 'docx',
      importerVersion: '1.0.0',
      localOnly: true,
    })
    expect(result.source.packageParts).toEqual(
      [...result.source.packageParts].sort(),
    )
    expect(result.source.packageParts).toContain('word/document.xml')
    expect(result.source.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(researchPaperSchema.safeParse(result.paper).success).toBe(true)
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'heading')
        .map((node) => node.level),
    ).toEqual([1, 2])

    const richParagraph = result.paper.nodes.find(
      (node) => node.type === 'paragraph' && node.text.includes('linked text'),
    )
    expect(richParagraph).toMatchObject({ type: 'paragraph' })
    if (!richParagraph || richParagraph.type !== 'paragraph') {
      throw new Error('Rich paragraph was not reconstructed')
    }
    const formattedText = (property: 'bold' | 'italic' | 'href') => {
      const run = richParagraph.inlineRuns?.find((candidate) =>
        property === 'href'
          ? Boolean(candidate.href)
          : Boolean(candidate[property]),
      )
      return run ? richParagraph.text.slice(run.start, run.end) : undefined
    }
    expect(formattedText('bold')).toBe('bold')
    expect(formattedText('italic')).toBe('italic')
    expect(formattedText('href')).toBe('linked text')
    expect(richParagraph.inlineRuns?.find((run) => run.href)?.href).toBe(
      'https://example.com/source',
    )

    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph' && node.list !== undefined)
        .map((node) => node.type === 'paragraph' && node.list),
    ).toEqual([
      { level: 1, ordered: true, numberingId: '7' },
      { level: 2, ordered: false, numberingId: '7' },
    ])
    expect(result.noteRelationships).toHaveLength(2)
    expect(
      result.noteRelationships.every(
        (relationship) =>
          relationship.status === 'matched' &&
          relationship.evidence[0].startsWith('ooxml-explicit-'),
      ),
    ).toBe(true)
    expect(
      result.paper.nodes.filter((node) => node.type === 'footnote'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'footnote', label: '1' }),
        expect.objectContaining({ kind: 'endnote', label: '2' }),
      ]),
    )

    expect(result.assets.map((asset) => asset.kind)).toEqual([
      'raster',
      'table',
    ])
    expect(result.visualRelationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'figure', status: 'matched' }),
        expect.objectContaining({ kind: 'table', status: 'matched' }),
      ]),
    )
    expect(result.paper.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'figure', objectType: 'figure' }),
        expect.objectContaining({
          type: 'figure',
          objectType: 'table',
          table: expect.objectContaining({ rows: expect.any(Array) }),
        }),
      ]),
    )
    expect(result.completeness).toMatchObject({
      textCoverage: 1,
      assetCoverage: 1,
      relationshipCoverage: 1,
      unresolvedObjectCount: 0,
    })
    expect(result.readiness).toMatchObject({ ready: true, status: 'ready' })
    expect(result.readingOrder.evaluation).toMatchObject({
      algorithm: 'explicit-ooxml-v1',
      mode: 'explicit-structure',
      orderAccuracy: 1,
    })
  })

  it('packages rich text, notes, images, and semantic tables into a valid deterministic EPUB', async () => {
    const first = await reconstructDocx(
      await fixtureFile('structured-manuscript.docx'),
    )
    const second = await reconstructDocx(
      await fixtureFile('structured-manuscript.docx'),
    )
    const firstEpub = await buildEpub(first.paper, first)
    const secondEpub = await buildEpub(second.paper, second)
    const { files, entries } = inspectEpub(firstEpub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const manifest = JSON.parse(strFromU8(files['EPUB/export.json']))

    expect(first.paper).toEqual(second.paper)
    expect(firstEpub.bytes).toEqual(secondEpub.bytes)
    expect(firstEpub.sha256).toBe(secondEpub.sha256)
    expect(content).toContain('<strong>bold</strong>')
    expect(content).toContain('<em>italic</em>')
    expect(content).toContain('href="https://example.com/source"')
    expect(content).toContain('epub:type="noteref"')
    expect(content).toContain('epub:type="footnote"')
    expect(content).toContain('data-object-type="figure"')
    expect(content).toContain('data-object-type="table"')
    expect(entries).toEqual(
      expect.arrayContaining(first.assets.map((asset) => `EPUB/${asset.href}`)),
    )
    expect(
      strFromU8(
        files[
          `EPUB/${first.assets.find((asset) => asset.kind === 'table')!.href}`
        ],
      ),
    ).toContain('<table>')
    expect(manifest).toMatchObject({
      sourceDocxSha256: first.source.sha256,
      sourceFormat: 'docx',
      sourceImporterVersion: '1.0.0',
      sourcePackageParts: first.source.packageParts,
      sourceReadiness: { ready: true },
    })
  })

  it('fails closed with named diagnostics for missing parts and dangling notes', async () => {
    const result = await reconstructDocx(
      await fixtureFile('malformed-manuscript.docx'),
    )

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MISSING_IMAGE_PART' }),
        expect.objectContaining({ code: 'DANGLING_NOTE_REFERENCE' }),
        expect.objectContaining({ code: 'INCOMPLETE_ASSET_COVERAGE' }),
        expect.objectContaining({ code: 'INCOMPLETE_RELATIONSHIP_COVERAGE' }),
      ]),
    )
    expect(result.completeness.assetCoverage).toBeLessThan(1)
    expect(result.completeness.relationshipCoverage).toBeLessThan(1)
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
    await expect(buildEpub(result.paper, result)).rejects.toMatchObject({
      code: 'INCOMPLETE_RECONSTRUCTION',
    })
  })

  it('measures text coverage and fails closed when an image paragraph carries unrepresented text', async () => {
    const fixture = await fixtureFile('structured-manuscript.docx')
    const files = unzipSync(new Uint8Array(await fixture.arrayBuffer()))
    const document = strFromU8(files['word/document.xml'])
    const droppedText = 'Text beside the image must not disappear.'
    files['word/document.xml'] = strToU8(
      document.replace('<w:drawing>', `<w:t>${droppedText}</w:t><w:drawing>`),
    )
    const result = await reconstructDocx(
      new File([zipSync(files)], 'text-bearing-image.docx', {
        type: fixture.type,
        lastModified: fixture.lastModified,
      }),
    )

    expect(result.completeness.outputTextCharacters).toBe(
      result.completeness.sourceTextCharacters - droppedText.length,
    )
    expect(result.completeness.textCoverage).toBeLessThan(1)
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'INCOMPLETE_TEXT_COVERAGE' }),
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
  })

  it('fails closed instead of packaging active SVG from an untrusted DOCX', async () => {
    const fixture = await fixtureFile('structured-manuscript.docx')
    const files = unzipSync(new Uint8Array(await fixture.arrayBuffer()))
    files['[Content_Types].xml'] = strToU8(
      strFromU8(files['[Content_Types].xml']).replace(
        'Extension="png" ContentType="image/png"',
        'Extension="png" ContentType="image/svg+xml"',
      ),
    )
    files['word/media/figure.png'] = strToU8(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    )
    const result = await reconstructDocx(
      new File([zipSync(files)], 'active-svg.docx', {
        type: fixture.type,
        lastModified: fixture.lastModified,
      }),
    )

    expect(result.assets).not.toContainEqual(
      expect.objectContaining({ mediaType: 'image/svg+xml' }),
    )
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'UNSUPPORTED_DOCX_FEATURE' }),
    )
    expect(result.readiness.ready).toBe(false)
  })

  it('rejects non-OOXML input before attempting XML reconstruction', async () => {
    await expect(
      reconstructDocx(
        new File(['not a zip'], 'invalid.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_DOCX' })
  })
})
