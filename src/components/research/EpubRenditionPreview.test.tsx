import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  EPUB_EXPORT_POLICY_VERSION,
  type EpubExport,
} from '../../research/epub'
import EpubRenditionPreview, {
  buildExternalLinkReceipt,
  clampEpubPage,
  composePreviewCss,
  composeReviewReaderCss,
  createEpubPreviewCache,
  epubPreviewArtifactKey,
  internalPreviewTargetId,
  resolveReviewViewport,
  selectCurrentProfileEpub,
} from './EpubRenditionPreview'
import {
  getTargetProfile,
  TARGET_PROFILE_VERSION,
} from '../../research/targets'

const epub: EpubExport = {
  bytes: new Uint8Array(),
  entries: [],
  fileName: 'preview.epub',
  identifier: 'preview',
  mediaType: 'application/epub+zip',
  mode: 'readable-fallback',
  sha256: 'preview',
}

function profiled(id: 'mobile' | 'paperProMove' | 'paperPro'): EpubExport {
  const target = getTargetProfile(id)
  return {
    ...epub,
    identifier: `preview-${id}`,
    sha256:
      id === 'mobile'
        ? 'a'.repeat(64)
        : id === 'paperProMove'
          ? 'b'.repeat(64)
          : 'c'.repeat(64),
    profile: {
      id,
      version: TARGET_PROFILE_VERSION,
      orientation: target.orientation,
      artifact: target.artifact,
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
}

describe('EPUB rendition preview', () => {
  it('transposes review viewport dimensions without changing the artifact', () => {
    expect(resolveReviewViewport('phone', 'portrait')).toMatchObject({
      width: 390,
      height: 844,
    })
    expect(resolveReviewViewport('phone', 'landscape')).toMatchObject({
      width: 844,
      height: 390,
    })
    expect(resolveReviewViewport('tablet', 'landscape')).toMatchObject({
      width: 1024,
      height: 768,
    })
  })

  it('clamps reader-controlled EPUB pages', () => {
    expect(clampEpubPage(-4, 12)).toBe(1)
    expect(clampEpubPage(5.8, 12)).toBe(5)
    expect(clampEpubPage(18, 12)).toBe(12)
    expect(clampEpubPage(Number.NaN, 12)).toBe(1)
  })

  it('composes preview-only pagination and typography overrides', () => {
    const css = composeReviewReaderCss('large', 'sans')

    expect(css).toContain('--review-font-scale: 1.15')
    expect(css).toContain('var(--review-base-font-size)')
    expect(css).toContain(
      'font-family: Inter, ui-sans-serif, system-ui, sans-serif !important',
    )
    expect(css).toContain('height: 100vh')
    expect(css).toContain('[data-review-page-content]')
    expect(css).not.toContain('columns:')
    expect(css).toContain('overflow-y: auto')
    expect(css).toContain('overflow-x: hidden')
    expect(css).toContain('overflow-wrap: anywhere !important')
    expect(css).toContain('white-space: normal !important')
  })

  it('exposes phone, tablet, and orientation controls in review mode', () => {
    const markup = renderToStaticMarkup(
      <EpubRenditionPreview
        epubs={[profiled('mobile')]}
        selectedProfileId="mobile"
        reviewMode
      />,
    )

    expect(markup).toContain('aria-label="EPUB viewport controls"')
    expect(markup).toContain('<select aria-label="Viewport size">')
    expect(markup).toContain('Phone')
    expect(markup).toContain('Tablet')
    expect(markup).toContain('reMarkable Paper Pro Move')
    expect(markup).toContain('reMarkable Paper Pro')
    expect(markup).toContain('<select aria-label="Orientation">')
    expect(markup).toContain('<select aria-label="Font size">')
    expect(markup).toContain('<select aria-label="Font family">')
    expect(markup).toContain('Portrait')
    expect(markup).toContain('Landscape')
    expect(markup).toContain('Small')
    expect(markup).toContain('Default')
    expect(markup).toContain('Large')
    expect(markup).toContain('XL')
    expect(markup).toContain('Publisher')
    expect(markup).toContain('Serif')
    expect(markup).toContain('Sans')
    expect(markup).toContain('aria-label="EPUB page navigation"')
    expect(markup).toContain('← Previous page')
    expect(markup).toContain('Next page →')
    expect(markup).toContain('EPUB page 1 of 1')
    expect(markup).not.toContain(
      'Citation and cross-reference targets will be highlighted here.',
    )
    expect(markup).toContain('390')
    expect(markup).toContain('844')
    expect(markup).toContain('CSS px · scaled preview')
    expect(markup).toContain('data-review-viewport="phone"')
    expect(markup).toContain('data-review-orientation="portrait"')
    expect(markup).toContain('data-review-font-size="default"')
    expect(markup).toContain('data-review-font-family="publisher"')
    expect(markup).toContain(
      'class="epub-rendition-preview epub-rendition-preview--review"',
    )
  })

  it('accepts only decodable same-document navigation targets', () => {
    expect(internalPreviewTargetId('#bibliography-entry-2')).toBe(
      'bibliography-entry-2',
    )
    expect(internalPreviewTargetId('#entry%202')).toBe('entry 2')
    expect(internalPreviewTargetId('https://example.test/#entry-2')).toBeNull()
    expect(internalPreviewTargetId('#%E0%A4%A')).toBeNull()
  })

  it('describes an external link as an inert, focusable semantic receipt', () => {
    expect(
      buildExternalLinkReceipt('https://example.com/source', 'Source paper'),
    ).toEqual({
      role: 'link',
      tabIndex: 0,
      originalHref: 'https://example.com/source',
      ariaLabel: 'Source paper (link disabled in preview)',
    })
  })

  it('keys preview readiness to the exact artifact and export policy', () => {
    const current = profiled('paperPro')
    const stalePolicy = {
      ...current,
      profile: {
        ...current.profile!,
        exportPolicy: {
          ...current.profile!.exportPolicy,
          version: '1.0.0',
        },
      },
    } as unknown as EpubExport

    expect(epubPreviewArtifactKey(current)).not.toBe(
      epubPreviewArtifactKey(stalePolicy),
    )
    expect(epubPreviewArtifactKey(current)).not.toBe(
      epubPreviewArtifactKey({ ...current, sha256: 'f'.repeat(64) }),
    )
  })

  it('keeps the EPUB profile stylesheet as the only content geometry authority', () => {
    const css = composePreviewCss(
      'main { padding: 6% 8%; } @page { margin: 0; }',
    )

    expect(css).toContain('main { padding: 6% 8%; }')
    expect(css).toContain('@page { margin: 0; }')
    expect(css).not.toMatch(/body\s*\{[^}]*padding:/)
    expect(css).not.toMatch(/body\s*\{[^}]*max-width:/)
  })

  it('uses the authoritative publication target profiles without duplicate dimensions', () => {
    const markup = renderToStaticMarkup(
      <EpubRenditionPreview
        epubs={[
          profiled('mobile'),
          profiled('paperProMove'),
          profiled('paperPro'),
        ]}
      />,
    )

    expect(markup).toContain('<legend>Preview screen</legend>')
    expect(markup).toContain('Mobile')
    expect(markup).toContain('Paper Pro Move')
    expect(markup).toContain('7.3″ · 954 × 1696 · 264 PPI')
    expect(markup).toContain('Paper Pro')
    expect(markup).toContain('11.8″ · 1620 × 2160 · 229 PPI')
    expect(markup).toContain(
      'Both reMarkable frames use one physical scale. On narrow screens, scroll sideways; the frames do not shrink.',
    )
    expect(markup).not.toContain('1,872 × 2,480')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup.match(/aria-pressed="false"/g)).toHaveLength(3)
    expect(markup).toContain('data-profile-id="paperPro"')
    expect(markup).toContain(`data-profile-version="${TARGET_PROFILE_VERSION}"`)
    expect(markup).toContain(`data-artifact-sha256="${'c'.repeat(64)}"`)
    expect(markup).toContain('Selected EPUB artifact receipt')
    expect(markup).toContain('Profile geometry')
    expect(markup.match(/data-truth-authority="authoritative"/g)).toHaveLength(
      2,
    )
    expect(markup).toContain('Typography and margins')
    expect(markup).toContain('data-truth-authority="advisory"')
    expect(
      markup.match(/data-truth-authority="reader-controlled"/g),
    ).toHaveLength(2)
  })

  it('reuses a prepared preview for the same exact profile artifact', () => {
    const builds: string[] = []
    const cache = createEpubPreviewCache((candidate) => {
      builds.push(candidate.sha256)
      return { srcDoc: candidate.identifier, revoke: () => undefined }
    })
    const original = profiled('mobile')

    const first = cache.prepare(original)
    const second = cache.prepare({ ...original })

    expect(second).toBe(first)
    expect(builds).toEqual([original.sha256])
  })

  it('keeps equal hashes separated by profile and profile version', () => {
    const builds: string[] = []
    const cache = createEpubPreviewCache((candidate) => {
      builds.push(`${candidate.profile?.id}@${candidate.profile?.version}`)
      return { srcDoc: candidate.identifier, revoke: () => undefined }
    })
    const original = profiled('mobile')
    const otherProfile = {
      ...profiled('paperProMove'),
      sha256: original.sha256,
    }
    const otherVersion = {
      ...original,
      profile: { ...original.profile!, version: '1.1.1' },
    }

    cache.prepare(original)
    cache.prepare(otherProfile)
    cache.prepare(otherVersion)

    expect(builds).toEqual([
      'mobile@1.1.0',
      'paperProMove@1.1.0',
      'mobile@1.1.1',
    ])
  })

  it('invalidates and revokes a replaced profile artifact', () => {
    const revocations: string[] = []
    const cache = createEpubPreviewCache((candidate) => ({
      srcDoc: candidate.identifier,
      revoke: () => revocations.push(candidate.sha256),
    }))
    const original = profiled('mobile')
    const replacement = {
      ...original,
      identifier: 'replacement-mobile',
      sha256: 'd'.repeat(64),
    }
    cache.prepare(original)

    cache.retain([replacement])
    cache.prepare(replacement)

    expect(revocations).toEqual([original.sha256])
    expect(cache.get(original)).toBeUndefined()
    expect(cache.get(replacement)?.srcDoc).toBe(replacement.identifier)
  })

  it('revokes every prepared preview exactly once during cleanup', () => {
    const revocations: string[] = []
    const cache = createEpubPreviewCache((candidate) => ({
      srcDoc: candidate.identifier,
      revoke: () => revocations.push(candidate.sha256),
    }))
    const mobile = profiled('mobile')
    const move = profiled('paperProMove')
    cache.prepare(mobile)
    cache.prepare(move)

    cache.dispose()
    cache.dispose()

    expect(revocations).toEqual([mobile.sha256, move.sha256])
  })

  it('uses buttons for profile switching without a download action', () => {
    const markup = renderToStaticMarkup(
      <EpubRenditionPreview
        epubs={[
          profiled('mobile'),
          profiled('paperProMove'),
          profiled('paperPro'),
        ]}
      />,
    )

    expect(markup.match(/<button/g)).toHaveLength(5)
    expect(markup.match(/type="button"/g)).toHaveLength(5)
    expect(markup).not.toContain('<a ')
    expect(markup).not.toContain('download=')
  })

  it('offers unbuilt controlled profiles and marks the selected profile as building', () => {
    const markup = renderToStaticMarkup(
      <EpubRenditionPreview
        epubs={[profiled('mobile')]}
        selectedProfileId="paperPro"
        buildingProfileId="paperPro"
        onSelectedProfileChange={() => undefined}
      />,
    )

    expect(markup.match(/<button/g)).toHaveLength(5)
    expect(markup.match(/data-artifact-status="ready"/g)).toHaveLength(1)
    expect(markup.match(/data-artifact-status="unbuilt"/g)).toHaveLength(1)
    expect(markup.match(/data-artifact-status="building"/g)).toHaveLength(1)
    expect(markup).toContain('Building Paper Pro EPUB locally…')
    expect(markup).toContain('data-profile-id="paperPro"')
    expect(markup).not.toContain('data-artifact-sha256')
    expect(markup).not.toContain('Generated EPUB rendition on Mobile')
  })

  it('renders the parent-selected profile as the exact visible artifact', () => {
    const markup = renderToStaticMarkup(
      <EpubRenditionPreview
        epubs={[
          profiled('mobile'),
          profiled('paperProMove'),
          profiled('paperPro'),
        ]}
        selectedProfileId="mobile"
        onSelectedProfileChange={() => undefined}
      />,
    )

    expect(markup).toContain('data-profile-id="mobile"')
    expect(markup).toContain(`data-profile-version="${TARGET_PROFILE_VERSION}"`)
    expect(markup).toContain(`data-artifact-sha256="${'a'.repeat(64)}"`)
    expect(markup).toMatch(
      /aria-pressed="true"[^>]*aria-label="Preview Mobile,/,
    )
  })

  it('selects the current exact profile artifact when a stale match appears first', () => {
    const current = profiled('paperPro')
    const stale = {
      ...current,
      identifier: 'preview-paperPro-stale',
      sha256: 'd'.repeat(64),
      profile: { ...current.profile!, version: '1.0.0' },
    }
    const markup = renderToStaticMarkup(
      <EpubRenditionPreview
        epubs={[stale, current]}
        selectedProfileId="paperPro"
      />,
    )

    expect(markup).toContain(`data-artifact-sha256="${current.sha256}"`)
    expect(markup).not.toContain(`data-artifact-sha256="${stale.sha256}"`)
    expect(markup).toContain(`data-profile-version="${TARGET_PROFILE_VERSION}"`)
  })

  it('selects the current export policy when a stale-policy artifact appears first', () => {
    const current = profiled('paperPro')
    const stalePolicy = {
      ...current,
      identifier: 'preview-paperPro-stale-policy',
      sha256: 'e'.repeat(64),
      profile: {
        ...current.profile!,
        exportPolicy: {
          ...current.profile!.exportPolicy,
          version: '1.0.0',
        },
      },
    } as unknown as EpubExport
    const markup = renderToStaticMarkup(
      <EpubRenditionPreview
        epubs={[stalePolicy, current]}
        selectedProfileId="paperPro"
      />,
    )

    expect(markup).toContain(`data-artifact-sha256="${current.sha256}"`)
    expect(markup).not.toContain(`data-artifact-sha256="${stalePolicy.sha256}"`)
  })

  it('refuses to frame an artifact with a stale target-profile version', () => {
    const stale = {
      ...profiled('paperPro'),
      profile: { ...profiled('paperPro').profile!, version: '1.0.0' },
    }
    const markup = renderToStaticMarkup(
      <EpubRenditionPreview epubs={[stale]} />,
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('unsupported target-profile version')
    expect(markup).not.toContain('data-artifact-sha256')
    expect(markup).not.toContain('<iframe')
    expect(markup).not.toContain('11.8″ · 1620 × 2160 · 229 PPI')
    expect(selectCurrentProfileEpub([stale], 'paperPro')).toBeUndefined()
  })

  it('refuses a legacy profiled artifact with no export-policy receipt', () => {
    const current = profiled('paperPro')
    const { exportPolicy: _exportPolicy, ...legacyProfile } = current.profile!
    const legacy = {
      ...current,
      profile: legacyProfile,
    } as unknown as EpubExport

    expect(() =>
      renderToStaticMarkup(<EpubRenditionPreview epubs={[legacy]} />),
    ).not.toThrow()
    const markup = renderToStaticMarkup(
      <EpubRenditionPreview epubs={[legacy]} />,
    )
    expect(markup).toContain('role="alert"')
    expect(markup).not.toContain('data-artifact-sha256')
    expect(selectCurrentProfileEpub([legacy], 'paperPro')).toBeUndefined()
  })
})
