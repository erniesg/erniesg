import { describe, expect, it } from 'vitest'
import {
  parsePublicationBuildArgs,
  canonicalRouteBodyFingerprint,
  consumeRouteImageIndex,
  publicationGraphBodyFingerprint,
  publicationReceiptDigest,
  publicationRouteHtmlDigest,
} from './publication-build.mjs'

describe('publication:build CLI', () => {
  it('requires an explicit registered adapter, stable entry, and output', () => {
    expect(
      parsePublicationBuildArgs([
        '--adapter',
        'astro',
        '--entry',
        'moving-to-cloudflare-with-astro',
        '--output',
        '.agent/evidence/publication',
      ]),
    ).toEqual({
      adapter: 'astro',
      entry: 'moving-to-cloudflare-with-astro',
      output: '.agent/evidence/publication',
    })
    expect(() => parsePublicationBuildArgs(['--entry', 'post'])).toThrow(
      /Usage/,
    )
    expect(() =>
      parsePublicationBuildArgs(['--theme', 'auto-install']),
    ).toThrow(/Unknown/)
  })

  it('accepts a local Payload export and versioned mapping without an Astro entry', () => {
    expect(
      parsePublicationBuildArgs([
        '--adapter',
        'payload',
        '--input',
        'tests/fixtures/payload/publication.json',
        '--mapping',
        'tests/fixtures/payload/mapping.json',
        '--output',
        '.agent/evidence/payload-publication',
      ]),
    ).toEqual({
      adapter: 'payload-lexical',
      input: 'tests/fixtures/payload/publication.json',
      mapping: 'tests/fixtures/payload/mapping.json',
      output: '.agent/evidence/payload-publication',
    })
    expect(() =>
      parsePublicationBuildArgs([
        '--adapter',
        'payload',
        '--entry',
        'astro-only',
        '--output',
        'output',
      ]),
    ).toThrow(/Payload.*--input/)
    expect(() =>
      parsePublicationBuildArgs([
        '--adapter',
        'astro',
        '--input',
        'payload.json',
        '--output',
        'output',
      ]),
    ).toThrow(/Astro.*--entry/)
  })

  it('binds route parity to the exact canonical route bytes', () => {
    expect(publicationRouteHtmlDigest('<html>route</html>')).toMatch(
      /^[a-f0-9]{64}$/,
    )
    expect(publicationRouteHtmlDigest('<html>route</html>')).not.toBe(
      publicationRouteHtmlDigest('<html>changed</html>'),
    )
  })

  it('binds route parity to the exact publication receipt bytes', () => {
    expect(publicationReceiptDigest('{"version":"1.0.0"}')).toMatch(
      /^[a-f0-9]{64}$/,
    )
    expect(publicationReceiptDigest('{"version":"1.0.1"}')).not.toBe(
      publicationReceiptDigest('{"version":"1.0.0"}'),
    )
  })

  it('binds canonical route body semantics to the publication graph', () => {
    const graph = {
      nodes: [
        { type: 'heading', level: 1, text: 'Heading' },
        { type: 'paragraph', text: 'Body proof' },
      ],
    }
    const expected = publicationGraphBodyFingerprint(graph)
    expect(canonicalRouteBodyFingerprint('<article><h1>Heading</h1><p>Body proof</p></article>')).toEqual(expected)
    expect(canonicalRouteBodyFingerprint('<article><h1>Heading</h1><p>Changed</p></article>')).not.toEqual(expected)
  })

  it('treats Astro typographic apostrophes as the same authored body text', () => {
    const graph = {
      nodes: [{ type: 'paragraph', text: "Author's proof" }],
    }
    expect(canonicalRouteBodyFingerprint('<article><p>Author’s proof</p></article>')).toEqual(
      publicationGraphBodyFingerprint(graph),
    )
  })

  it('normalizes Markdown image titles to graph caption semantics', () => {
    const graph = {
      nodes: [
        {
          type: 'figure',
          title: 'Alt text',
          assetIds: ['asset'],
          captionId: 'caption',
        },
        { id: 'caption', type: 'caption', text: 'Authored image title' },
      ],
    }
    const html =
      '<article><p><img src="/assets/figure.png" alt="Alt text" title="Authored image title"></p></article>'
    expect(canonicalRouteBodyFingerprint(html)).toEqual(
      publicationGraphBodyFingerprint(graph),
    )
  })

  it('consumes duplicate canonical-route image matches one-to-one', () => {
    const images = [
      { src: '/assets/figure-a.png', alt: 'Repeated image' },
      { src: '/assets/figure-a-copy.png', alt: 'Repeated image' },
    ]
    const usedIndexes = new Set()
    expect(
      consumeRouteImageIndex(images, usedIndexes, 'Repeated image', 'figurea'),
    ).toBe(0)
    expect(
      consumeRouteImageIndex(images, usedIndexes, 'Repeated image', 'figurea'),
    ).toBe(1)
    expect(
      consumeRouteImageIndex(images, usedIndexes, 'Repeated image', 'figurea'),
    ).toBe(-1)
  })
})
