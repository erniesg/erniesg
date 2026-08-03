import { describe, expect, it } from 'vitest'
import {
  parsePublicationBuildArgs,
  canonicalRouteBodyFingerprint,
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
})
