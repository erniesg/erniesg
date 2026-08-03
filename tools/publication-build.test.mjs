import { describe, expect, it } from 'vitest'
import {
  parsePublicationBuildArgs,
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
})
