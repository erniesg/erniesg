import { strToU8, zipSync } from 'fflate'
import { parse } from 'parse5'
import { describe, expect, it } from 'vitest'
import { compileStructDemoEpubPreview } from './struct-demo-epub-preview'

const archive = (files: Record<string, Uint8Array | string>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, value]) => [
        path,
        typeof value === 'string' ? strToU8(value) : value,
      ]),
    ),
  )

const forgedStoredMetadata = () => {
  const archive = zipSync({
    'META-INF/container.xml': [strToU8(container), { level: 0 }],
    'OPS/book.opf': [strToU8(opf), { level: 0 }],
    'OPS/one.xhtml': [
      strToU8(`<html><body>${'x'.repeat(4_122)}</body></html>`),
      { level: 0 },
    ],
    'OPS/two.xhtml': [strToU8('<html><body>two</body></html>'), { level: 0 }],
  })
  const forged = archive.slice()
  for (let offset = 0; offset < forged.length - 3; offset += 1) {
    if (
      forged[offset] === 0x50 &&
      forged[offset + 1] === 0x4b &&
      forged[offset + 2] === 0x01 &&
      forged[offset + 3] === 0x02
    ) {
      const nameLength = new DataView(
        forged.buffer,
        forged.byteOffset,
        forged.byteLength,
      ).getUint16(offset + 28, true)
      const name = new TextDecoder().decode(
        forged.slice(offset + 46, offset + 46 + nameLength),
      )
      if (name === 'OPS/one.xhtml') {
        new DataView(
          forged.buffer,
          forged.byteOffset,
          forged.byteLength,
        ).setUint32(offset + 24, 128, true)
        return forged
      }
    }
  }
  throw new Error('fixture did not contain a central directory entry')
}

const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>`
const opf = `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Converted paper</dc:title></metadata><manifest>
  <item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>
  <item id="two" href="two.xhtml" media-type="application/xhtml+xml"/>
  <item id="css" href="book.css" media-type="text/css"/>
  <item id="figure" href="images/figure.png" media-type="image/png"/>
  <item id="diagram" href="images/diagram.svg" media-type="image/svg+xml"/>
  <item id="font" href="fonts/text.woff2" media-type="font/woff2"/>
</manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`

type ParsedNode = {
  tagName?: string
  attrs?: Array<{ name: string }>
  childNodes?: ParsedNode[]
}

describe('struct demo EPUB preview compiler', () => {
  it('keeps the ordered spine semantics and local assets in a scriptless document', () => {
    const result = compileStructDemoEpubPreview(
      archive({
        'META-INF/container.xml': container,
        'OPS/book.opf': opf,
        'OPS/one.xhtml': `<html><body><h1 id="start">First heading</h1><table><tr><td>Cell</td></tr></table><math><mi>x</mi></math><pre><code>const x = 1</code></pre><img src="images/figure.png" onerror="alert(1)"><img src="images/diagram.svg"><script>alert(1)</script></body></html>`,
        'OPS/two.xhtml': `<html><body><h2 id="second">Second heading</h2><a href="one.xhtml#start">Back</a><iframe src="https://evil.test"></iframe></body></html>`,
        'OPS/book.css': `@import url(https://evil.test/theme.css); @font-face { font-family: Text; src: url(fonts/text.woff2) } body { background-image: url(https://evil.test/pixel) }`,
        'OPS/images/figure.png': new Uint8Array([137, 80, 78, 71]),
        'OPS/images/diagram.svg':
          '<svg><script>alert(1)</script><path d="M0 0" onload="alert(1)"/><image href="https://evil.test/pixel"/></svg>',
        'OPS/fonts/text.woff2': new Uint8Array([119, 79, 70, 50]),
      }),
      'source-file.epub',
    )

    expect(result.title).toBe('Converted paper')
    expect(result.html).toMatch(/First heading[\s\S]*Second heading/)
    expect(result.html).toContain('<table>')
    expect(result.html).toContain('<math>')
    expect(result.html).toContain('<code>const x = 1</code>')
    expect(result.html).toContain('data:image/png;base64,iVBORw==')
    expect(result.html).toContain('data:image/svg+xml;base64,')
    expect(result.html).toContain('data:font/woff2;base64,d09GMg==')
    expect(result.html).toContain('href="#start"')
    expect(result.html).toContain("default-src 'none'")
    expect(result.html).not.toMatch(
      /<script|<iframe|onerror|evil\.test|@import/i,
    )
  })

  it('fails closed for malformed, oversized, and archive-bomb inputs', () => {
    expect(() =>
      compileStructDemoEpubPreview(strToU8('not a zip'), 'bad.epub'),
    ).toThrow('EPUB preview is unavailable.')
    expect(() =>
      compileStructDemoEpubPreview(
        archive({
          'META-INF/container.xml': container,
          'OPS/book.opf': opf,
          'OPS/one.xhtml': '<html><body>one</body></html>',
          'OPS/two.xhtml': '<html><body>two</body></html>',
          'OPS/too-large.bin': new Uint8Array(128),
        }),
        'large.epub',
        { inflatedBytes: 100 },
      ),
    ).toThrow('EPUB preview is unavailable.')
    expect(() =>
      compileStructDemoEpubPreview(forgedStoredMetadata(), 'forged.epub', {
        entryBytes: 512,
      }),
    ).toThrow('EPUB preview is unavailable.')
  })

  it('counts each repeated embedded image and font URL against output limits', () => {
    const image = new Uint8Array(64 * 1024).fill(7)
    const repeatedImages = '<img src="images/figure.png">'.repeat(128)
    const repeatedFonts = 'url(fonts/text.woff2) '.repeat(128)
    expect(() =>
      compileStructDemoEpubPreview(
        archive({
          'META-INF/container.xml': container,
          'OPS/book.opf': opf,
          'OPS/one.xhtml': `<html><body>${repeatedImages}</body></html>`,
          'OPS/two.xhtml': '<html><body>two</body></html>',
          'OPS/book.css': `@font-face { src: ${repeatedFonts} }`,
          'OPS/images/figure.png': image,
          'OPS/fonts/text.woff2': image,
        }),
        'repeated.epub',
        { outputBytes: 1024 * 1024, embeddedBytes: 2 * 1024 * 1024 },
      ),
    ).toThrow('EPUB preview is unavailable.')
  })

  it('keeps hostile stylesheet text inside the single generated style element', () => {
    const result = compileStructDemoEpubPreview(
      archive({
        'META-INF/container.xml': container,
        'OPS/book.opf': opf,
        'OPS/one.xhtml': '<html><body>one</body></html>',
        'OPS/two.xhtml': '<html><body>two</body></html>',
        'OPS/book.css':
          '</style><meta http-equiv="refresh" content="0;url=https://example.test/"><script>globalThis.compromised=true</script>',
      }),
      'style-breakout.epub',
    )
    const document = parse(result.html) as unknown as ParsedNode
    const html = document.childNodes?.find((node) => node.tagName === 'html')
    const head = html?.childNodes?.find((node) => node.tagName === 'head')

    expect(head?.childNodes?.map((node) => node.tagName)).toEqual([
      'meta',
      'style',
    ])
    expect(result.html).not.toContain('<script')
  })
})
