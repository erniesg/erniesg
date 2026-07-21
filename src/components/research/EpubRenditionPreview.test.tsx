import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  EPUB_EXPORT_POLICY_VERSION,
  type EpubExport,
} from '../../research/epub'
import EpubRenditionPreview, {
  buildExternalLinkReceipt,
  composePreviewCss,
  createEpubPreviewCache,
  epubPreviewArtifactKey,
  selectCurrentProfileEpub,
} from './EpubRenditionPreview'
import { TARGET_PROFILE_VERSION } from '../../research/targets'

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
    expect(markup).not.toContain('1,872 × 2,480')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup.match(/aria-pressed="false"/g)).toHaveLength(2)
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

    expect(markup.match(/<button/g)).toHaveLength(3)
    expect(markup.match(/type="button"/g)).toHaveLength(3)
    expect(markup).not.toContain('<a ')
    expect(markup).not.toContain('download=')
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
