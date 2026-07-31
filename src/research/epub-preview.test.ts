import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { EPUB_PREVIEW_CSP, compileEpubPreviewArchive } from './epub-preview'

describe('worker-side EPUB preview compiler', () => {
  it('builds a CSP-first sanitized template with exact referenced assets', () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71])
    const archive = zipSync({
      'EPUB/content.xhtml': strToU8(`<!doctype html>
        <html>
          <head>
            <meta http-equiv="refresh" content="0;url=https://evil.test">
            <link rel="stylesheet" href="styles.css">
          </head>
          <body>
            <script>globalThis.compromised = true</script>
            <style>body { background: url(https://evil.test/stolen) }</style>
            <template><script>globalThis.hiddenCompromise = true</script></template>
            <main>
              <a href="https://example.test/paper">Source paper</a>
              <a href="#note-1">Note 1</a>
              <map name="unsafe-map"><area href="/same-origin-script"></map>
              <img src="assets/figure.png" onerror="alert(1)" style="width:999px">
              <object data="assets/table.xhtml" type="application/xhtml+xml">
                Table fallback
              </object>
              <form><input value="secret"></form>
            </main>
          </body>
        </html>`),
      'EPUB/styles.css': strToU8(
        'main { color: #111 } @import "https://evil.test/x.css";',
      ),
      'EPUB/assets/figure.png': imageBytes,
      'EPUB/assets/table.xhtml': strToU8(
        '<html><body><table><tr><td>Exact cell</td></tr></table></body></html>',
      ),
    })

    const preview = compileEpubPreviewArchive(archive, {
      markerNonce: 'security-fixture',
    })
    const template = preview.template.segments.join('[asset]')

    expect(template).toMatch(
      new RegExp(
        `^<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${EPUB_PREVIEW_CSP.replaceAll(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        )}">`,
      ),
    )
    expect(template).not.toContain('<script')
    expect(template).not.toContain('<template')
    expect(template).not.toContain('evil.test/stolen')
    expect(template).not.toContain('<form')
    expect(template).not.toContain('<input')
    expect(template).not.toContain('http-equiv="refresh"')
    expect(template).not.toContain('rel="stylesheet"')
    expect(template).not.toContain('onerror=')
    expect(template).not.toContain('style=')
    expect(template).not.toContain('@import')
    expect(template).toContain(
      '<a role="link" tabindex="0" data-original-href="https://example.test/paper" aria-label="Source paper (link disabled in preview)">Source paper</a>',
    )
    expect(template).toContain('<a href="#note-1">Note 1</a>')
    expect(template).not.toMatch(/<area[^>]*\shref=/u)
    expect(template).toContain(
      '<area role="link" tabindex="0" data-original-href="/same-origin-script" aria-label="/same-origin-script (link disabled in preview)">',
    )
    expect(template).toContain(
      '<div class="epub-embedded-table"><table><tbody><tr><td>Exact cell</td></tr></tbody></table></div>',
    )
    expect(preview.template.assetIndices).toEqual([0])
    expect(preview.assets).toHaveLength(1)
    expect(preview.assets[0]).toMatchObject({
      href: 'assets/figure.png',
      mediaType: 'image/png',
    })
    expect(preview.assets[0].bytes).toEqual(imageBytes)
  })

  it('uses collision-proof markers and transfers only referenced assets', () => {
    const firstImage = new Uint8Array([1, 2, 3])
    const unusedImage = new Uint8Array([4, 5, 6])
    const collision = '__EPUB_PREVIEW_ASSET_collision_0__'
    const archive = zipSync({
      'EPUB/content.xhtml': strToU8(
        `<html><head></head><body><p>${collision}</p><img src="assets/first.png"><img src="assets/first.png"></body></html>`,
      ),
      'EPUB/assets/first.png': firstImage,
      'EPUB/assets/unused.png': unusedImage,
    })

    const preview = compileEpubPreviewArchive(archive, {
      markerNonce: 'collision',
    })

    expect(preview.assets).toEqual([
      {
        href: 'assets/first.png',
        mediaType: 'image/png',
        bytes: firstImage,
      },
    ])
    expect(preview.template.assetIndices).toEqual([0, 0])
    expect(preview.template.segments.join('blob:materialized')).toContain(
      collision,
    )
    expect(preview.template.segments.join('blob:materialized')).toContain(
      '<img src="blob:materialized"><img src="blob:materialized">',
    )
  })

  it('avoids marker text created by entity decoding during parsing', () => {
    const collision = '__EPUB_PREVIEW_ASSET_entity_0__'
    const entityEncodedCollision = collision.replaceAll('_', '&#95;')
    const archive = zipSync({
      'EPUB/content.xhtml': strToU8(
        `<html><head></head><body><p>${entityEncodedCollision}</p><img src="assets/figure.png"></body></html>`,
      ),
      'EPUB/assets/figure.png': new Uint8Array([1]),
    })

    const preview = compileEpubPreviewArchive(archive, {
      markerNonce: 'entity',
    })

    expect(preview.template.assetIndices).toEqual([0])
    expect(preview.template.segments.join('blob:materialized')).toContain(
      `<p>${collision}</p><img src="blob:materialized">`,
    )
  })

  it('drops missing and unsafe image references instead of synthesizing payloads', () => {
    const archive = zipSync({
      'EPUB/content.xhtml': strToU8(
        '<html><head></head><body><img src="../outside.png"><img src="assets/../secret.png"><img src="assets/missing.png"><img src="assets/not-an-image.html"><img src="assets/safe.png"></body></html>',
      ),
      'EPUB/assets/not-an-image.html': strToU8('<script>alert(1)</script>'),
      'EPUB/assets/safe.png': new Uint8Array([7]),
    })

    const preview = compileEpubPreviewArchive(archive)
    const materialized = preview.template.segments.join('blob:safe')

    expect(preview.assets.map((asset) => asset.href)).toEqual([
      'assets/safe.png',
    ])
    expect(materialized.match(/<img>/g)).toHaveLength(4)
    expect(materialized).toContain('<img src="blob:safe">')
    expect(materialized).not.toContain('outside.png')
    expect(materialized).not.toContain('secret.png')
    expect(materialized).not.toContain('missing.png')
    expect(materialized).not.toContain('not-an-image.html')
  })

  it('fails closed before inflating archives outside the resource envelope', () => {
    const archive = zipSync({
      'EPUB/content.xhtml': strToU8(
        '<html><head></head><body>bounded</body></html>',
      ),
    })

    expect(() =>
      compileEpubPreviewArchive(archive, {
        limits: { documentBytes: 8 },
      }),
    ).toThrow(
      'EPUB preview resource limit exceeded: spine document bytes is 46; maximum is 8.',
    )
  })

  it('does not mutate or detach the exact EPUB bytes while compiling', () => {
    const archive = zipSync({
      'EPUB/content.xhtml': strToU8(
        '<html><head></head><body><img src="assets/figure.png"></body></html>',
      ),
      'EPUB/assets/figure.png': new Uint8Array([9, 8, 7]),
    })
    const before = archive.slice()
    const originalBuffer = archive.buffer

    compileEpubPreviewArchive(archive)

    expect(archive).toEqual(before)
    expect(archive.buffer).toBe(originalBuffer)
    expect(archive.byteLength).toBe(before.byteLength)
  })

  it('breaks cyclic embedded-table references without recursive expansion', () => {
    const archive = zipSync({
      'EPUB/content.xhtml': strToU8(
        '<html><head></head><body><object data="assets/table.xhtml" type="application/xhtml+xml">Outer fallback</object></body></html>',
      ),
      'EPUB/assets/table.xhtml': strToU8(
        '<html><body><table><tbody><tr><td>Exact cell<object data="assets/table.xhtml" type="application/xhtml+xml">Cycle fallback</object></td></tr></tbody></table></body></html>',
      ),
    })

    const preview = compileEpubPreviewArchive(archive)
    const materialized = preview.template.segments.join('')

    expect(materialized).toContain('Exact cellCycle fallback')
    expect(materialized).not.toContain('<object')
  })

  it('fails closed when embedded-table resolution exceeds its reference budget', () => {
    const archive = zipSync({
      'EPUB/content.xhtml': strToU8(
        '<html><head></head><body><object data="assets/a.xhtml" type="application/xhtml+xml">A</object><object data="assets/b.xhtml" type="application/xhtml+xml">B</object></body></html>',
      ),
      'EPUB/assets/a.xhtml': strToU8(
        '<html><body><table><tr><td>A</td></tr></table></body></html>',
      ),
      'EPUB/assets/b.xhtml': strToU8(
        '<html><body><table><tr><td>B</td></tr></table></body></html>',
      ),
    })

    expect(() =>
      compileEpubPreviewArchive(archive, {
        limits: { embeddedObjectReferences: 1 },
      }),
    ).toThrow(
      'EPUB preview resource limit exceeded: embedded object references is 2; maximum is 1.',
    )
  })

  it('fails closed before recursively sanitizing an excessively deep document', () => {
    const archive = zipSync({
      'EPUB/content.xhtml': strToU8(
        `<html><head></head><body>${'<div>'.repeat(12)}deep${'</div>'.repeat(12)}</body></html>`,
      ),
    })

    expect(() =>
      compileEpubPreviewArchive(archive, {
        limits: { documentDepth: 8 },
      }),
    ).toThrow(
      'EPUB preview resource limit exceeded: document depth is 9; maximum is 8.',
    )
  })
})
