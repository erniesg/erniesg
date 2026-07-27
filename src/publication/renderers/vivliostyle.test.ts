import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { adaptAstroBlogEntry } from '../adapters/astro'
import {
  PUBLICATION_PROFILES,
  publicationGraphToHtml,
  vivliostyleRenderer,
} from './vivliostyle'

describe('Vivliostyle publication renderer boundary', () => {
  it('renders repository-owned semantic HTML without Astro knowledge', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    const paths = new Map(
      bundle.assetBundle.descriptor.assets.map((asset) => [
        asset.id,
        `assets/${asset.fileName}`,
      ]),
    )
    const html = publicationGraphToHtml(bundle.graph, paths, 'phone-webpub')
    expect(html).toContain('<main>')
    expect(html).toContain('<h1>Moving to Cloudflare Pages with Astro</h1>')
    expect(html).toContain(
      'alt="The Astro logo in white on an orange-to-purple gradient"',
    )
    expect(html.indexOf('Why Astro?')).toBeLessThan(
      html.indexOf('The Benefits of Cloudflare Pages'),
    )
    const rendererSource = await readFile(
      'src/publication/renderers/vivliostyle.ts',
      'utf8',
    )
    expect(rendererSource).not.toMatch(/from ['"][^'"]*astro/)
    expect(rendererSource).not.toContain('.provenance')
  })

  it('fails an incomplete output matrix before rendering', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    await expect(
      vivliostyleRenderer.render(bundle, {
        outputDirectory: '.agent/evidence/incomplete-publication',
        profiles: PUBLICATION_PROFILES.slice(0, 1),
      }),
    ).rejects.toThrow(/output matrix must be exactly/)
  })
})
