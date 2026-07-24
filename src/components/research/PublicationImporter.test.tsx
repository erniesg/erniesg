import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  EPUB_EXPORT_POLICY_VERSION,
  type EpubExport,
} from '../../research/epub'
import { TARGET_PROFILE_VERSION } from '../../research/targets'
import { epubPreviewArtifactKey } from './EpubRenditionPreview'

vi.mock('./ResearchStudio', () => ({ default: () => null }))
vi.mock('./EpubDownloadLink', () => ({ default: () => null }))

import PublicationImporter, {
  importErrorCode,
  importErrorMessage,
  isSelectedEpubPreviewReady,
  LineJoinAdjudicationCard,
  shouldReloadStaleApplicationModule,
} from './PublicationImporter'

describe('publication importer OCR controls', () => {
  it('offers three explicit line-join choices with no default selection', () => {
    const markup = renderToStaticMarkup(
      <LineJoinAdjudicationCard
        context={{
          identity: {
            transitionId: 'line-boundary-001',
            regionId: 'page-001-region-001',
            fromLineId: 'page-001-line-0001',
            toLineId: 'page-001-line-0002',
          },
          page: 1,
          from: {
            id: 'page-001-line-0001',
            text: 'The source contains a scenar-',
            fontSize: 10,
            box: {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.7,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text',
            },
            truncated: false,
          },
          to: {
            id: 'page-001-line-0002',
            text: 'io continues in prose.',
            fontSize: 10,
            box: {
              page: 1,
              x: 0.1,
              y: 0.22,
              width: 0.7,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text',
            },
            truncated: false,
          },
          evidence: ['insufficient-hyphen-evidence'],
        }}
        onDecision={vi.fn()}
      />,
    )

    expect(markup).toContain('Line-join review')
    expect(markup).toContain('The source contains a scenar-')
    expect(markup).toContain('io continues in prose.')
    expect(markup).toContain('Remove wrap hyphen')
    expect(markup).toContain('Preserve authored hyphen')
    expect(markup).toContain('Leave unresolved')
    expect(markup).not.toContain('aria-pressed="true"')
  })

  it('withholds the selected download until that exact EPUB preview is ready', () => {
    const candidate: EpubExport = {
      bytes: new Uint8Array(),
      entries: [],
      fileName: 'paper-pro.epub',
      identifier: 'paper-pro',
      mediaType: 'application/epub+zip',
      mode: 'publication',
      sha256: 'a'.repeat(64),
      profile: {
        id: 'paperPro',
        version: TARGET_PROFILE_VERSION,
        compositionPolicy: {} as NonNullable<
          EpubExport['profile']
        >['compositionPolicy'],
        truth: {
          geometry: 'authoritative',
          typography: 'advisory',
          pagination: 'reader-controlled',
          orientation: 'reader-controlled',
        },
        exportPolicy: {
          id: 'profile-tuned-reflowable',
          version: EPUB_EXPORT_POLICY_VERSION,
        },
      },
    }

    expect(isSelectedEpubPreviewReady(candidate)).toBe(false)
    expect(isSelectedEpubPreviewReady(candidate, 'another-artifact')).toBe(
      false,
    )
    expect(
      isSelectedEpubPreviewReady(candidate, epubPreviewArtifactKey(candidate)),
    ).toBe(true)
  })

  it('offers automatic English fallback and explicit local language selection', () => {
    const markup = renderToStaticMarkup(<PublicationImporter />)

    expect(markup).toContain('for="publication-ocr-language"')
    expect(markup).toContain('id="publication-ocr-language"')
    expect(markup).toContain('value="auto" selected=""')
    expect(markup).toContain('English fallback')
    expect(markup).toContain('local language pack')
  })

  it('states the actual 50 MiB local upload limit', () => {
    const markup = renderToStaticMarkup(<PublicationImporter />)

    expect(markup).toContain('Up to 50 MiB')
    expect(markup).not.toContain('Up to 75 MB')
  })

  it('recognizes an outdated Vite dynamic import without exposing its internal URL', () => {
    const staleImportA = new TypeError(
      'Failed to fetch dynamically imported module: http://127.0.0.1:4321/node_modules/.vite/deps/pdfjs-dist.js?v=bfb6b1be',
    )
    const staleImportB = new TypeError(
      'Failed to fetch dynamically imported module: http://127.0.0.1:4321/node_modules/.vite/deps/pdfjs-dist.js?v=c9af6a8a',
    )

    expect(importErrorCode(staleImportA)).toBe('STALE_APPLICATION_MODULE')
    expect(importErrorMessage(staleImportA)).toBe(
      'The converter changed while this tab was open. Reload the studio once, then choose the same paper again.',
    )
    expect(importErrorMessage(staleImportA)).not.toContain('node_modules')
    expect(shouldReloadStaleApplicationModule(staleImportA)).toBe(true)
    expect(
      shouldReloadStaleApplicationModule(staleImportA, staleImportA.message),
    ).toBe(false)
    expect(
      shouldReloadStaleApplicationModule(staleImportB, staleImportA.message),
    ).toBe(true)
    expect(
      shouldReloadStaleApplicationModule(
        new Error('The selected file is not a PDF.'),
      ),
    ).toBe(false)
  })
})
