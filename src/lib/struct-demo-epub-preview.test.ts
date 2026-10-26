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

const forgedDeflatedMetadata = () => {
  const archive = zipSync({
    'META-INF/container.xml': strToU8(container),
    'OPS/book.opf': strToU8(opf),
    'OPS/one.xhtml': strToU8(
      `<html><body>${'x'.repeat(1_048_576)}</body></html>`,
    ),
    'OPS/two.xhtml': strToU8('<html><body>two</body></html>'),
  })
  const forged = archive.slice()
  for (let offset = 0; offset < forged.length - 3; offset += 1) {
    if (
      forged[offset] === 0x50 &&
      forged[offset + 1] === 0x4b &&
      forged[offset + 2] === 0x01 &&
      forged[offset + 3] === 0x02
    ) {
      const view = new DataView(
        forged.buffer,
        forged.byteOffset,
        forged.byteLength,
      )
      const nameLength = view.getUint16(offset + 28, true)
      const name = new TextDecoder().decode(
        forged.slice(offset + 46, offset + 46 + nameLength),
      )
      if (name === 'OPS/one.xhtml') {
        view.setUint32(offset + 24, 128, true)
        view.setUint32(view.getUint32(offset + 42, true) + 22, 128, true)
        return forged
      }
    }
  }
  throw new Error('fixture did not contain a central directory entry')
}

const centralEntry = (archive: Uint8Array, name: string) => {
  for (let offset = 0; offset < archive.length - 46; offset += 1) {
    if (
      archive[offset] === 0x50 &&
      archive[offset + 1] === 0x4b &&
      archive[offset + 2] === 0x01 &&
      archive[offset + 3] === 0x02
    ) {
      const view = new DataView(
        archive.buffer,
        archive.byteOffset,
        archive.byteLength,
      )
      const nameLength = view.getUint16(offset + 28, true)
      if (
        new TextDecoder().decode(
          archive.slice(offset + 46, offset + 46 + nameLength),
        ) === name
      )
        return { offset, view }
    }
  }
  throw new Error(`missing central entry: ${name}`)
}

const withDataDescriptor = (
  original: Uint8Array,
  name: string,
  signature: boolean,
) => {
  const eocd = (() => {
    for (let offset = original.length - 22; offset >= 0; offset -= 1) {
      if (
        original[offset] === 0x50 &&
        original[offset + 1] === 0x4b &&
        original[offset + 2] === 0x05 &&
        original[offset + 3] === 0x06
      )
        return offset
    }
    throw new Error('missing EOCD')
  })()
  const originalView = new DataView(
    original.buffer,
    original.byteOffset,
    original.byteLength,
  )
  const centralOffset = originalView.getUint32(eocd + 16, true)
  const entry = centralEntry(original, name)
  const localOffset = entry.view.getUint32(entry.offset + 42, true)
  const dataOffset =
    localOffset +
    30 +
    originalView.getUint16(localOffset + 26, true) +
    originalView.getUint16(localOffset + 28, true)
  const descriptor = new Uint8Array(signature ? 16 : 12)
  const descriptorView = new DataView(descriptor.buffer)
  const fieldOffset = signature ? 4 : 0
  if (signature) descriptorView.setUint32(0, 0x08074b50, true)
  descriptorView.setUint32(
    fieldOffset,
    entry.view.getUint32(entry.offset + 16, true),
    true,
  )
  descriptorView.setUint32(
    fieldOffset + 4,
    entry.view.getUint32(entry.offset + 20, true),
    true,
  )
  descriptorView.setUint32(
    fieldOffset + 8,
    entry.view.getUint32(entry.offset + 24, true),
    true,
  )
  const patched = new Uint8Array(original.byteLength + descriptor.byteLength)
  const descriptorOffset =
    dataOffset + entry.view.getUint32(entry.offset + 20, true)
  patched.set(original.subarray(0, descriptorOffset))
  patched.set(descriptor, descriptorOffset)
  patched.set(
    original.subarray(descriptorOffset),
    descriptorOffset + descriptor.byteLength,
  )
  const view = new DataView(patched.buffer)
  view.setUint16(
    localOffset + 6,
    view.getUint16(localOffset + 6, true) | 8,
    true,
  )
  view.setUint32(localOffset + 14, 0, true)
  view.setUint32(localOffset + 18, 0, true)
  view.setUint32(localOffset + 22, 0, true)
  const shiftedCentral = centralOffset + descriptor.byteLength
  const shiftedEocd = eocd + descriptor.byteLength
  for (let offset = shiftedCentral; offset < shiftedEocd;) {
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const candidate = new TextDecoder().decode(
      patched.slice(offset + 46, offset + 46 + nameLength),
    )
    if (candidate === name)
      view.setUint16(offset + 8, view.getUint16(offset + 8, true) | 8, true)
    if (view.getUint32(offset + 42, true) > localOffset)
      view.setUint32(
        offset + 42,
        view.getUint32(offset + 42, true) + descriptor.byteLength,
        true,
      )
    offset += 46 + nameLength + extraLength + commentLength
  }
  view.setUint32(shiftedEocd + 16, shiftedCentral, true)
  return patched
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
    expect(() =>
      compileStructDemoEpubPreview(forgedDeflatedMetadata(), 'forged.epub', {
        entryBytes: 512,
        inflatedBytes: 8 * 1024,
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

  it('requires a complete central directory matching every streamed local entry', () => {
    const valid = archive({
      'META-INF/container.xml': container,
      'OPS/book.opf': opf,
      'OPS/one.xhtml': '<html><body>one</body></html>',
      'OPS/two.xhtml': '<html><body>two</body></html>',
    })
    const truncated = valid.slice(0, valid.length - 22)
    const renamed = valid.slice()
    const renamedEntry = centralEntry(renamed, 'OPS/one.xhtml')
    renamed[renamedEntry.offset + 46] = 'X'.charCodeAt(0)
    const badOffset = valid.slice()
    const offsetEntry = centralEntry(badOffset, 'OPS/one.xhtml')
    offsetEntry.view.setUint32(offsetEntry.offset + 42, 1, true)
    const badCrc = valid.slice()
    const crcEntry = centralEntry(badCrc, 'OPS/one.xhtml')
    crcEntry.view.setUint32(crcEntry.offset + 16, 1, true)
    const badCompressedSize = valid.slice()
    const sizeEntry = centralEntry(badCompressedSize, 'OPS/one.xhtml')
    sizeEntry.view.setUint32(
      sizeEntry.offset + 20,
      sizeEntry.view.getUint32(sizeEntry.offset + 20, true) + 1,
      true,
    )

    for (const candidate of [
      truncated,
      renamed,
      badOffset,
      badCrc,
      badCompressedSize,
    ]) {
      expect(() =>
        compileStructDemoEpubPreview(candidate, 'invalid-directory.epub'),
      ).toThrow('EPUB preview is unavailable.')
    }
  })

  it('accepts an unsigned descriptor whose CRC equals the signature and rejects nonzero local descriptor fields', () => {
    const magicCrcBody = new Uint8Array([
      ...strToU8('<html><body>descriptor</body></html>'),
      0x1f,
      0x32,
      0xde,
      0x6c,
    ])
    const valid = archive({
      'META-INF/container.xml': container,
      'OPS/book.opf': opf,
      'OPS/one.xhtml': magicCrcBody,
      'OPS/two.xhtml': '<html><body>two</body></html>',
    })
    const signed = withDataDescriptor(valid, 'OPS/one.xhtml', true)
    expect(
      compileStructDemoEpubPreview(signed, 'descriptor.epub').html,
    ).toContain('descriptor')
    const unsigned = withDataDescriptor(valid, 'OPS/one.xhtml', false)
    expect(
      compileStructDemoEpubPreview(unsigned, 'descriptor.epub').html,
    ).toContain('descriptor')
    const nonzeroLocalFields = unsigned.slice()
    const entry = centralEntry(nonzeroLocalFields, 'OPS/one.xhtml')
    const localOffset = entry.view.getUint32(entry.offset + 42, true)
    new DataView(
      nonzeroLocalFields.buffer,
      nonzeroLocalFields.byteOffset,
      nonzeroLocalFields.byteLength,
    ).setUint32(localOffset + 14, 1, true)
    expect(() =>
      compileStructDemoEpubPreview(nonzeroLocalFields, 'descriptor.epub'),
    ).toThrow('EPUB preview is unavailable.')
  })
})
