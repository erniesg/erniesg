import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { parse } from 'parse5'
import { renderPublicationXhtml } from '@erniesg/struct/renderers/xhtml'
import { adaptAstroBlogEntry } from '../adapters/astro'
import { buildStructDocument } from '../../struct-adapters'
import { loadAdapterCase } from '../../../tests/fixtures/struct-adapter-parity/cases'
import {
  structBundleWire,
  structDocumentSha256,
} from '../struct-source-binding'
import type { PublicationBundle } from '../adapter-registry'
import {
  createPublicationEpub,
  publicationAssetSources,
  publicationPresentation,
  publicationSourceBindingFor,
  wrapPublicationXhtml,
  withFigureSource,
  withTableCorrespondence,
  writePublicationSemanticArtifacts,
} from './vivliostyle'

function attributes(node: any): Record<string, string> {
  const result: Record<string, string> = {}
  for (const attribute of node.attrs ?? []) result[attribute.name] = attribute.value
  return result
}

function collect(node: any, accumulator: any[] = []) {
  accumulator.push(node)
  for (const child of node.childNodes ?? []) collect(child, accumulator)
  return accumulator
}

function textOf(node: any): string {
  return (node.childNodes ?? [])
    .map((child: any) => child.value ?? textOf(child))
    .join('')
}

function indexOf(html: string) {
  const root = parse(html)
  const all = collect(root)
  const elements = new Map<string, any>()
  for (const node of all) {
    const id = attributes(node).id
    if (id && !elements.has(id)) elements.set(id, node)
  }
  return { root, all, elements }
}

async function astroBundle(): Promise<PublicationBundle> {
  return (await adaptAstroBlogEntry({
    entryId: 'moving-to-cloudflare-with-astro',
  })) as unknown as PublicationBundle
}

describe('the pinned package publication rendering', () => {
  it('renders the WebPub from the package XHTML with the app presentation', async () => {
    const bundle = await astroBundle()
    const document = bundle.structDocument!
    const packageXhtml = renderPublicationXhtml(document)
    const presentation = publicationPresentation(bundle, 'phone-webpub', {
      stylesheetHref: 'publication.css',
    })
    const html = wrapPublicationXhtml(packageXhtml, presentation)

    // The semantic rendering is the package's own rendering of the canonical
    // document, not the legacy graph rendering.
    expect(html).toContain('data-struct-id=')
    expect(html).not.toContain('class="figure-title"')

    // The app presentation is present and bounded.
    expect(html).toContain('data-profile="phone-webpub"')
    expect(html).toContain('<main>')
    expect(html).toContain('href="publication.css"')
    expect(html).not.toContain('href="styles.css"')

    // Every canonical block keeps its canonical identifier, in the canonical
    // order.
    const rendered = indexOf(html)
    const canonicalIds = document.blocks
      .filter((block) => block.kind !== 'furniture')
      .map((block) => block.id)
    const renderedIds = canonicalIds.filter((id) => rendered.elements.has(id))
    expect(renderedIds).toEqual(canonicalIds)

    // The canonical text of the document is rendered.
    const heading = document.blocks.find(
      (block) => block.kind === 'heading' && block.text.includes('Why Astro?'),
    )
    expect(heading).toBeDefined()
    expect(textOf(rendered.elements.get(heading!.id)!)).toContain('Why Astro?')
  })

  it('publishes the canonical asset at the app asset path with its alternative text', async () => {
    const bundle = await astroBundle()
    const document = bundle.structDocument!
    const presentation = publicationPresentation(bundle, 'phone-webpub', {
      stylesheetHref: 'publication.css',
    })
    const html = wrapPublicationXhtml(
      renderPublicationXhtml(document),
      presentation,
    )
    const rendered = indexOf(html)
    const images = rendered.all.filter((node: any) => node.tagName === 'img')
    expect(images.length).toBeGreaterThan(0)
    const published = new Set(presentation.assetPaths.values())
    for (const image of images) {
      const attribute = attributes(image)
      expect(published.has(attribute.src!)).toBe(true)
      expect(attribute.alt).toBeTruthy()
    }
    // The app asset path is the one the app asset bundle publishes.
    const appPaths = new Set(
      bundle.assetBundle.descriptor.assets.map(
        (asset) =>
          `assets/${asset.id}${
            asset.mediaType === 'image/png' ? '.png' : '.bin'
          }`,
      ),
    )
    for (const path of published) expect(appPaths.has(path)).toBe(true)
  })

  it('keeps the canonical inline code semantics of the pinned document', async () => {
    const bundle = await astroBundle()
    const document = bundle.structDocument!
    const html = wrapPublicationXhtml(
      renderPublicationXhtml(document),
      publicationPresentation(bundle, 'phone-webpub', {
        stylesheetHref: 'publication.css',
      }),
    )
    const rendered = indexOf(html)
    const codes = rendered.all.filter((node: any) => node.tagName === 'code')
    expect(codes.length).toBeGreaterThan(0)
    expect(codes.map((node: any) => textOf(node))).toContain('main')
  })

  it('lands the canonical table identifier on the inspected table element', async () => {
    const document = buildStructDocument(
      await loadAdapterCase('structured-docx'),
    )
    const table = document.blocks.find((block) => block.kind === 'table')
    expect(table).toBeDefined()
    const packageXhtml = renderPublicationXhtml(document)
    const html = withTableCorrespondence(packageXhtml, table!.id)
    const rendered = indexOf(html)
    const element = rendered.elements.get(table!.id)
    expect(element).toBeDefined()
    expect(element.tagName).toBe('table')
    // The cells keep their canonical text.
    const cells = rendered.all.filter(
      (node: any) => node.tagName === 'td' || node.tagName === 'th',
    )
    expect(cells.length).toBe(table!.table!.rows * table!.table!.columns)
    for (const cell of table!.table!.cells)
      expect(cells.map((node: any) => textOf(node))).toContain(cell.text)
    // The canonical anchor of the document survives the rendering.
    const link = document.blocks.find((block) =>
      block.inline.some((run: any) => run.href),
    )
    expect(link).toBeDefined()
    const href = link!.inline.find((run: any) => run.href)!.href!
    expect(
      rendered.all
        .filter((node: any) => node.tagName === 'a')
        .map((node: any) => attributes(node).href),
    ).toContain(href)
  })

  it('keeps the canonical source fallback of an asset-less figure', () => {
    const packageXhtml = `<figure id="figure-1" data-struct-id="figure-1"><figcaption>Label</figcaption></figure>`
    const html = withFigureSource(packageXhtml, 'figure-1', {
      sourceText: 'The canonical source text',
      alternativeText: 'The alternative text',
    })
    const rendered = indexOf(html)
    const fallback = rendered.elements.get('figure-1-source')
    expect(fallback).toBeDefined()
    expect(fallback.tagName).toBe('pre')
    expect(textOf(fallback)).toBe('The canonical source text')
  })

  it('refuses a package rendering that lost the app presentation', async () => {
    const bundle = await astroBundle()
    const presentation = publicationPresentation(bundle, 'phone-webpub', {
      stylesheetHref: 'publication.css',
    })
    expect(() =>
      wrapPublicationXhtml('<html><body></body></html>', presentation),
    ).toThrow(/package XHTML/)
    expect(() =>
      wrapPublicationXhtml(
        '<html><head></head><body><header></header></body></html>',
        presentation,
      ),
    ).toThrow(/package XHTML/)
  })

  it('publishes the EPUB from the package builder output with the app packaging', async () => {
    const bundle = await astroBundle()
    const root = await mkdtemp(resolve(tmpdir(), 'publication-package-epub-'))
    try {
      const path = resolve(root, 'eink.epub')
      await createPublicationEpub(
        bundle,
        path,
        await readFile('src/styles/publication/publication.css', 'utf8'),
      )
      const bytes = await readFile(path)
      const archive = await JSZip.loadAsync(bytes)
      // The mimetype is the first entry and it is stored uncompressed.
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK')
      expect(bytes.readUInt16LE(8)).toBe(0)
      expect(bytes.subarray(30, 38).toString('latin1')).toBe('mimetype')
      // The package's own artifacts are kept.
      expect(archive.file('EPUB/struct.json')).not.toBeNull()
      expect(archive.file('META-INF/container.xml')).not.toBeNull()
      const content = await archive.file('EPUB/content.xhtml')!.async('string')
      expect(content).toContain('<main>')
      expect(content).toContain('data-profile="eink-epub"')
      expect(content).toContain('href="styles.css"')
      // The app packaging is present.
      const packageDocument = await archive.file('EPUB/package.opf')!.async('string')
      expect(packageDocument).toContain('schema:accessMode')
      expect(packageDocument).toContain('<spine>')
      expect(packageDocument).toContain('fonts/Geist-Regular.ttf')
      const navigation = await archive.file('EPUB/nav.xhtml')!.async('string')
      expect(navigation).toContain('epub:type="toc"')
      expect(navigation).toContain('epub:type="landmarks"')
      expect(archive.file('EPUB/styles.css')).not.toBeNull()
      expect(archive.file('EPUB/fonts/Geist-Regular.ttf')).not.toBeNull()
      // The published assets are deduplicated and declared.
      const assetItems = [...packageDocument.matchAll(/<item\b[^>]*\/>/gu)].map(
        (match) => /href="([^"]*)"/u.exec(match[0])?.[1],
      )
      expect(new Set(assetItems).size).toBe(assetItems.length)
      for (const asset of archive.file(/^EPUB\/assets\//u) ? Object.keys(archive.files) : []) {
        if (!asset.startsWith('EPUB/assets/')) continue
        expect(assetItems).toContain(asset.slice('EPUB/'.length))
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes the exact bundle wire bytes of the pinned document', async () => {
    const bundle = await astroBundle()
    const document = bundle.structDocument!
    const wire = structBundleWire(document)
    const root = await mkdtemp(resolve(tmpdir(), 'publication-package-wire-'))
    try {
      const output = resolve(root, 'render-output')
      const { mkdir } = await import('node:fs/promises')
      await mkdir(output)
      await writePublicationSemanticArtifacts(output, bundle)
      const persisted = await readFile(resolve(output, 'struct-bundle.bin'))
      expect(Buffer.from(persisted).equals(Buffer.from(wire.bytes))).toBe(true)
      const descriptor = JSON.parse(
        await readFile(resolve(output, 'struct-bundle.json'), 'utf8'),
      )
      expect(descriptor.bundleSha256).toBe(wire.bundleSha256)
      expect(descriptor.documentSha256).toBe(structDocumentSha256(document))
      expect(descriptor.documentSha256).toBe(wire.documentSha256)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds a receipt to the wire it produced and refuses another binding', async () => {
    const bundle = await astroBundle()
    const document = bundle.structDocument!
    const wire = structBundleWire(document)
    // A source that hands over a binding without a bundle digest is bound to
    // the wire this render produced.
    const bound = publicationSourceBindingFor(
      {
        kind: 'struct-cutover',
        documentSha256: wire.documentSha256,
        semanticReceiptSha256: wire.semanticReceiptSha256,
        packageSourceCommit: 'a'.repeat(40),
        packageArtifact: 'artifact.tgz',
        packageArtifactSha256: 'b'.repeat(64),
        packageIntegrity: 'sha512-abc',
        packageVersion: '0.0.0',
      },
      wire,
    )
    expect(bound.kind).toBe('struct-cutover')
    expect(
      bound.kind === 'struct-cutover' ? bound.bundleSha256 : undefined,
    ).toBe(wire.bundleSha256)
    expect(
      bound.kind === 'struct-cutover'
        ? bound.semanticReceiptSha256
        : undefined,
    ).toBe(wire.semanticReceiptSha256)
    // A binding that names another document or another bundle is refused.
    expect(() =>
      publicationSourceBindingFor(
        {
          kind: 'struct-cutover',
          documentSha256: 'c'.repeat(64),
          semanticReceiptSha256: wire.semanticReceiptSha256,
          packageSourceCommit: 'a'.repeat(40),
          packageArtifact: 'artifact.tgz',
          packageArtifactSha256: 'b'.repeat(64),
          packageIntegrity: 'sha512-abc',
          packageVersion: '0.0.0',
        },
        wire,
      ),
    ).toThrow(/another Struct document/)
    expect(() =>
      publicationSourceBindingFor(
        {
          kind: 'struct-cutover',
          documentSha256: wire.documentSha256,
          bundleSha256: 'd'.repeat(64),
          semanticReceiptSha256: wire.semanticReceiptSha256,
          packageSourceCommit: 'a'.repeat(40),
          packageArtifact: 'artifact.tgz',
          packageArtifactSha256: 'b'.repeat(64),
          packageIntegrity: 'sha512-abc',
          packageVersion: '0.0.0',
        },
        wire,
      ),
    ).toThrow(/another Struct bundle/)
  })

  it('fails closed when the app asset bundle does not carry a canonical asset', async () => {
    const bundle = await astroBundle()
    const document = bundle.structDocument!
    expect(() =>
      publicationAssetSources(document, {
        descriptor: { version: '1.0.0', assets: [] },
        resolveBytes: async () => new Uint8Array(),
      } as never),
    ).toThrow(/does not carry the canonical asset/)
  })
})
