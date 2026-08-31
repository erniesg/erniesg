import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import PrivatePdfEpubBridge from './PrivatePdfEpubBridge'

const componentPath = fileURLToPath(
  new URL('./PrivatePdfEpubBridge.tsx', import.meta.url),
)
const routePath = fileURLToPath(
  new URL('../../pages/research/private-pdf-epub.astro', import.meta.url),
)

describe('local-only private PDF EPUB surface', () => {
  it('renders one browser-local PDF input with privacy and bounded-readiness copy', () => {
    const markup = renderToStaticMarkup(<PrivatePdfEpubBridge />)

    expect(markup).toContain('type="file"')
    expect(markup).toContain('accept="application/pdf,.pdf"')
    expect(markup).toMatch(/stays (?:in|on) (?:this|your) (?:browser|device)/iu)
    expect(markup).toMatch(/not (?:saved|uploaded)/iu)
    expect(markup).not.toContain('type="url"')
  })

  it('uses only an ephemeral Blob URL and contains no network or durable-storage API', () => {
    const source = readFileSync(componentPath, 'utf8')

    expect(source).toContain('URL.createObjectURL')
    expect(source).toContain('URL.revokeObjectURL')
    for (const forbidden of [
      'fetch(',
      'XMLHttpRequest',
      'sendBeacon',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'caches.open',
      'showSaveFilePicker',
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })

  it('retains the active local transaction across ordinary state renders', () => {
    const source = readFileSync(componentPath, 'utf8')

    expect(source).toMatch(
      /useEffect\(\s*\(\) => \(\) => \{[\s\S]*?revokeDownload\(\)\s*\},\s*\[\],?\s*\)/u,
    )
  })

  it('is mounted only on the no-index research route removed by the production gate', () => {
    const route = readFileSync(routePath, 'utf8')

    expect(route).toContain(
      "import PrivatePdfEpubBridge from '@/components/research/PrivatePdfEpubBridge'",
    )
    expect(route).toMatch(/<Layout[\s\S]*?noindex/u)
    expect(route).toContain('<PrivatePdfEpubBridge client:load />')
    expect(route).toMatch(/local-only/iu)
  })
})
