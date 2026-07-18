import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./ResearchStudio', () => ({ default: () => null }))
vi.mock('./EpubDownloadLink', () => ({ default: () => null }))

import PublicationImporter from './PublicationImporter'

describe('publication importer OCR controls', () => {
  it('offers automatic English fallback and explicit local language selection', () => {
    const markup = renderToStaticMarkup(<PublicationImporter />)

    expect(markup).toContain('for="publication-ocr-language"')
    expect(markup).toContain('id="publication-ocr-language"')
    expect(markup).toContain('value="auto" selected=""')
    expect(markup).toContain('English fallback')
    expect(markup).toContain('local language pack')
  })
})
