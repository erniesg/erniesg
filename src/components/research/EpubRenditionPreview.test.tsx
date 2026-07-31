import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  EPUB_EXPORT_POLICY_VERSION,
  type EpubExport,
} from '../../research/epub'
import EpubRenditionPreview, {
  buildExternalLinkReceipt,
  buildEpubPreview,
  captureReviewBaseFontSizes,
  clampEpubPage,
  commitEpubPreviewAfterTask,
  composePreviewCss,
  composeReviewReaderCss,
  createEpubPreviewCache,
  createEpubPreviewWorkCheckpoint,
  createReviewLayoutAttemptTracker,
  EPUB_PREVIEW_CSP,
  EPUB_PREVIEW_SANDBOX,
  ensureReviewNavigationOriginIdentity,
  epubPreviewArtifactKey,
  focusReviewNavigationTarget,
  internalPreviewTargetId,
  resolveReviewViewport,
  selectCurrentProfileEpub,
  selectEpubPreviewPreparationQueue,
} from './EpubRenditionPreview'
import {
  getTargetProfile,
  TARGET_PROFILE_VERSION,
} from '../../research/targets'
import {
  createReviewPaginationScheduler,
  REVIEW_PAGINATION_SUPERSEDED_MESSAGE,
} from './epub-review-pagination'

const epub: EpubExport = {
  bytes: new Uint8Array(),
  entries: [],
  fileName: 'preview.epub',
  identifier: 'preview',
  mediaType: 'application/epub+zip',
  mode: 'readable-fallback',
  sha256: 'preview',
}

const workerPreviewPrefix = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${EPUB_PREVIEW_CSP}"></head><body>`

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
  it('keeps imported EPUB scripts blocked while parent navigation stays portable', () => {
    const permissions = EPUB_PREVIEW_SANDBOX.split(/\s+/)

    expect(permissions).toContain('allow-same-origin')
    expect(permissions).toContain('allow-scripts')
    expect(EPUB_PREVIEW_CSP).toContain("script-src 'none'")
  })

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

  it('retries a failed same-layout attempt and commits only successful pagination', () => {
    const document = {} as Document
    const tracker = createReviewLayoutAttemptTracker()
    const layout = { document, key: 'phone:portrait:default:publisher' }

    expect(tracker.begin(layout)).toBe(true)
    expect(tracker.begin(layout)).toBe(false)
    expect(tracker.current()).toEqual({
      pending: layout,
      applied: undefined,
    })

    tracker.fail(layout)

    expect(tracker.begin(layout)).toBe(true)
    tracker.complete(layout)
    expect(tracker.current()).toEqual({
      pending: undefined,
      applied: layout,
    })
    expect(tracker.begin(layout)).toBe(false)
  })

  it('invalidates an older applied layout when a different attempt fails', () => {
    const document = {} as Document
    const tracker = createReviewLayoutAttemptTracker()
    const first = { document, key: 'phone:portrait:default:publisher' }
    const second = { document, key: 'tablet:portrait:large:serif' }

    expect(tracker.begin(first)).toBe(true)
    tracker.complete(first)
    expect(tracker.begin(second)).toBe(true)
    tracker.fail(second)

    expect(tracker.begin(first)).toBe(true)
  })

  it('composes preview-only pagination and typography overrides', () => {
    const css = composeReviewReaderCss('large', 'sans')

    expect(css).toContain('--review-font-scale: 1.15')
    expect(css).toContain('var(--review-base-font-size)')
    expect(css).toContain(
      'font-family: Inter, ui-sans-serif, system-ui, sans-serif !important',
    )
    expect(css).toContain('height: 100vh')
    expect(css).toContain('[data-review-page-fragment]')
    expect(css).toContain('[data-review-page-body]')
    expect(css).toContain('[data-review-page-notes]')
    expect(css).not.toContain('columns:')
    expect(css).not.toContain('overflow-y: auto')
    expect(css).toContain('overflow-x: hidden')
    expect(css).toContain('.semantic-table-wrapper')
    expect(css).toContain('overflow: visible !important')
    expect(css).not.toContain('overflow: auto hidden')
    expect(css).toContain('overflow-wrap: anywhere !important')
    expect(css).toContain('white-space: normal !important')
  })

  it('captures reader font sizes in cooperative read and write passes', async () => {
    const element = (
      id: string,
      childNodes: Array<{ nodeType: number; textContent?: string }> = [],
    ) => {
      const properties = new Map<string, string>()
      return {
        id,
        childNodes,
        dataset: {} as Record<string, string>,
        style: {
          getPropertyValue: (name: string) => properties.get(name) ?? '',
          setProperty: (name: string, value: string) =>
            properties.set(name, value),
        },
      }
    }
    const first = element('first', [
      { nodeType: 3, textContent: 'First paragraph' },
    ])
    const section = element('section', [{ nodeType: 1 }])
    const second = element('second', [
      { nodeType: 3, textContent: 'Nested text' },
    ])
    const image = element('image')
    const elements = [first, section, second, image]
    const document = {
      querySelectorAll: () => elements,
    } as unknown as Document
    const reads: string[] = []
    let checkpoints = 0
    const scheduler = {
      async checkpoint() {
        checkpoints += 1
      },
    }
    const frameWindow = {
      getComputedStyle(candidate: Element) {
        expect(
          elements.some((candidate) => candidate.dataset.reviewBaseFontSize),
        ).toBe(false)
        reads.push(candidate.id)
        return {
          fontSize: candidate.id === 'first' ? '12px' : '15px',
        } as CSSStyleDeclaration
      },
    } as Pick<Window, 'getComputedStyle'>

    const captured = await captureReviewBaseFontSizes(document, frameWindow, {
      scheduler,
    })

    expect(reads).toEqual(['first', 'second'])
    expect(captured).toBe(2)
    expect(checkpoints).toBe(6)
    expect(first.dataset.reviewBaseFontSize).toBe('true')
    expect(first.style.getPropertyValue('--review-base-font-size')).toBe('12px')
    expect(second.style.getPropertyValue('--review-base-font-size')).toBe(
      '15px',
    )
    expect(section.dataset.reviewBaseFontSize).toBeUndefined()
  })

  it('freezes motion and awaits fonts before the two-pass font capture', async () => {
    let releaseFonts: (() => void) | undefined
    const fontsReady = new Promise<void>((resolve) => {
      releaseFonts = resolve
    })
    const appended: Array<{ id?: string; textContent?: string }> = []
    const properties = new Map<string, string>()
    const paragraph = {
      childNodes: [{ nodeType: 3, textContent: 'Stable typography' }],
      dataset: {} as Record<string, string>,
      style: {
        setProperty: (name: string, value: string) =>
          properties.set(name, value),
      },
    }
    const document = {
      fonts: { ready: fontsReady },
      getElementById: () => null,
      createElement: () => ({}),
      head: {
        append: (node: { id?: string; textContent?: string }) =>
          appended.push(node),
      },
      querySelectorAll: () => [paragraph],
    } as unknown as Document
    const reads: string[] = []
    const capture = captureReviewBaseFontSizes(document, {
      getComputedStyle: () => {
        reads.push('font-size')
        return { fontSize: '17px' } as CSSStyleDeclaration
      },
    } as Pick<Window, 'getComputedStyle'>)

    await Promise.resolve()

    expect(appended).toHaveLength(1)
    expect(appended[0]?.textContent).toContain('animation: none !important')
    expect(appended[0]?.textContent).toContain('transition: none !important')
    expect(reads).toEqual([])

    releaseFonts?.()
    await expect(capture).resolves.toBe(1)
    expect(reads).toEqual(['font-size'])
    expect(properties.get('--review-base-font-size')).toBe('17px')
  })

  it('aborts cooperative reader font capture before mutating the document', async () => {
    const elements = ['First', 'Second'].map((textContent) => ({
      childNodes: [{ nodeType: 3, textContent }],
      dataset: {} as Record<string, string>,
      style: {
        setProperty: () => undefined,
      },
    }))
    const document = {
      querySelectorAll: () => elements,
    } as unknown as Document
    const controller = new AbortController()
    let now = 0
    const scheduler = createReviewPaginationScheduler({
      budgetMs: 1,
      now: () => {
        now += 2
        return now
      },
      yieldTask: async () => {
        controller.abort()
      },
    })

    await expect(
      captureReviewBaseFontSizes(
        document,
        {
          getComputedStyle: () => ({ fontSize: '16px' }) as CSSStyleDeclaration,
        } as Pick<Window, 'getComputedStyle'>,
        { scheduler, signal: controller.signal },
      ),
    ).rejects.toThrow(REVIEW_PAGINATION_SUPERSEDED_MESSAGE)
    expect(
      elements.some((candidate) => candidate.dataset.reviewBaseFontSize),
    ).toBe(false)
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
    expect(markup).toContain('aria-label="Previous page"')
    expect(markup).toContain('aria-label="Next page"')
    expect(markup).toContain('>←</button>')
    expect(markup).toContain('>→</button>')
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

  it('generates one stable origin identity for internal-navigation return focus', () => {
    const link = {
      id: '',
      dataset: {} as Record<string, string>,
    } as HTMLAnchorElement
    const document = {
      getElementById: (id: string) => (link.id === id ? link : null),
    } as unknown as Document

    const first = ensureReviewNavigationOriginIdentity(link, document)
    const second = ensureReviewNavigationOriginIdentity(link, document)

    expect(first).toMatch(/^epub-review-origin-\d+$/)
    expect(second).toBe(first)
    expect(link.id).toBe(first)
    expect(link.dataset.reviewNavigationOriginId).toBe(first)
    expect(document.getElementById(first)).toBe(link)
  })

  it('focuses the exact internal target with only a temporary tabindex', () => {
    const attributes = new Map<string, string>()
    const focused: HTMLElement[] = []
    let scheduled: (() => void) | undefined
    const target = {
      hasAttribute: (name: string) => attributes.has(name),
      setAttribute: (name: string, value: string) =>
        attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      focus: () => focused.push(target as HTMLElement),
    } as unknown as HTMLElement

    focusReviewNavigationTarget(target, (callback) => {
      scheduled = callback
    })

    expect(attributes.get('tabindex')).toBe('-1')
    expect(focused).toEqual([])

    scheduled?.()

    expect(focused).toEqual([target])
    expect(attributes.has('tabindex')).toBe(false)
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

  it('yields cooperative preview work when its elapsed slice exceeds budget', async () => {
    let now = 0
    const yields: Array<{ phase: string; elapsedMs: number }> = []
    const checkpoint = createEpubPreviewWorkCheckpoint({
      budgetMs: 10,
      now: () => now,
      yieldTask: async (phase, elapsedMs) => {
        yields.push({ phase, elapsedMs })
      },
    })

    now = 4
    expect(checkpoint('unzip')).toBeUndefined()
    now = 12
    await checkpoint('parse')
    now = 19
    expect(checkpoint('objects')).toBeUndefined()
    now = 23
    await checkpoint('images')

    expect(yields).toEqual([
      { phase: 'parse', elapsedMs: 12 },
      { phase: 'images', elapsedMs: 11 },
    ])
  })

  it('threads cache cancellation into preview preparation and aborts stale work', async () => {
    const signals: AbortSignal[] = []
    const cache = createEpubPreviewCache((_candidate, { signal }) => {
      signals.push(signal)
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error(REVIEW_PAGINATION_SUPERSEDED_MESSAGE)),
          { once: true },
        )
      })
    })
    const original = profiled('mobile')

    const retained = cache.prepare(original)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)

    cache.retain([])

    expect(signals[0]?.aborted).toBe(true)
    await expect(retained).resolves.toEqual({
      status: 'error',
      error: REVIEW_PAGINATION_SUPERSEDED_MESSAGE,
    })

    const disposed = cache.prepare(original)
    expect(signals).toHaveLength(2)
    cache.dispose()
    expect(signals[1]?.aborted).toBe(true)
    await expect(disposed).resolves.toEqual({
      status: 'error',
      error: REVIEW_PAGINATION_SUPERSEDED_MESSAGE,
    })
  })

  it('revokes prepared object URLs when an aborted checkpoint supersedes a build', async () => {
    const originalCreateObjectUrl = URL.createObjectURL
    const originalRevokeObjectUrl = URL.revokeObjectURL
    const revoked: string[] = []
    const controller = new AbortController()
    let checkpointSignal: AbortSignal | undefined
    URL.createObjectURL = () => 'blob:prepared-preview'
    URL.revokeObjectURL = (url) => revoked.push(url)
    const candidate = {
      ...profiled('mobile'),
      preview: {
        template: {
          segments: [`${workerPreviewPrefix}<img src="`, '"></body></html>'],
          assetIndices: [0],
        },
        assets: [
          {
            href: 'assets/figure.png',
            mediaType: 'image/png',
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      },
    }

    try {
      await expect(
        buildEpubPreview(candidate, {
          signal: controller.signal,
          checkpoint: (phase, signal) => {
            if (phase === 'images') {
              checkpointSignal = signal
              controller.abort()
            }
          },
        }),
      ).rejects.toThrow(REVIEW_PAGINATION_SUPERSEDED_MESSAGE)
      expect(checkpointSignal).toBe(controller.signal)
      expect(revoked).toEqual(['blob:prepared-preview'])
    } finally {
      URL.createObjectURL = originalCreateObjectUrl
      URL.revokeObjectURL = originalRevokeObjectUrl
    }
  })

  it('materializes the worker template cooperatively from exact asset bytes', async () => {
    const phases: string[] = []
    const blobs: Blob[] = []
    const originalCreateObjectUrl = URL.createObjectURL
    const originalRevokeObjectUrl = URL.revokeObjectURL
    URL.createObjectURL = (blob) => {
      blobs.push(blob as Blob)
      return 'blob:exact-asset'
    }
    URL.revokeObjectURL = () => undefined
    const candidate = {
      ...profiled('mobile'),
      preview: {
        template: {
          segments: [
            `${workerPreviewPrefix}<img src="`,
            '"><p>Safe</p></body></html>',
          ],
          assetIndices: [0],
        },
        assets: [
          {
            href: 'assets/figure.png',
            mediaType: 'image/png',
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      },
    }

    try {
      const prepared = await buildEpubPreview(candidate, {
        checkpoint: async (phase) => {
          phases.push(phase)
        },
      })

      expect(phases).toEqual(['images', 'serialize'])
      expect(prepared.srcDoc).toBe(
        `${workerPreviewPrefix}<img src="blob:exact-asset"><p>Safe</p></body></html>`,
      )
      expect(blobs).toHaveLength(1)
      expect(blobs[0]?.type).toBe('image/png')
      expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3]),
      )
      prepared.revoke()
    } finally {
      URL.createObjectURL = originalCreateObjectUrl
      URL.revokeObjectURL = originalRevokeObjectUrl
    }
  })

  it('accepts a CSP-first worker template that preserves EPUB root attributes', async () => {
    const candidate = {
      ...profiled('mobile'),
      preview: {
        template: {
          segments: [
            `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><meta http-equiv="Content-Security-Policy" content="${EPUB_PREVIEW_CSP}"></head><body><p>Safe</p></body></html>`,
          ],
          assetIndices: [],
        },
        assets: [],
      },
    }

    await expect(buildEpubPreview(candidate)).resolves.toMatchObject({
      srcDoc: expect.stringContaining('<p>Safe</p>'),
    })
  })

  it('fails closed when an EPUB lacks its worker-compiled preview payload', async () => {
    await expect(buildEpubPreview(profiled('mobile'))).rejects.toThrow(
      'EPUB preview payload is missing',
    )
  })

  it('fails closed before creating URLs for a malformed preview template', async () => {
    const originalCreateObjectUrl = URL.createObjectURL
    let createCalls = 0
    URL.createObjectURL = () => {
      createCalls += 1
      return 'blob:should-not-exist'
    }
    const candidate = {
      ...profiled('mobile'),
      preview: {
        template: { segments: ['too', 'many'], assetIndices: [] },
        assets: [
          {
            href: 'assets/figure.png',
            mediaType: 'image/png',
            bytes: new Uint8Array([1]),
          },
        ],
      },
    }

    try {
      await expect(buildEpubPreview(candidate)).rejects.toThrow(
        'EPUB preview payload is invalid',
      )
      expect(createCalls).toBe(0)
    } finally {
      URL.createObjectURL = originalCreateObjectUrl
    }
  })

  it('rejects a shaped template that does not put the preview CSP first', async () => {
    const candidate = {
      ...profiled('mobile'),
      preview: {
        template: {
          segments: ['<!DOCTYPE html><html><head></head><body></body></html>'],
          assetIndices: [],
        },
        assets: [],
      },
    }

    await expect(buildEpubPreview(candidate)).rejects.toThrow(
      'EPUB preview payload is invalid',
    )
  })

  it('waits for a separate task before committing prepared iframe content', async () => {
    let releaseTask: (() => void) | undefined
    let commits = 0

    const completion = commitEpubPreviewAfterTask(
      () => {
        commits += 1
      },
      () =>
        new Promise<void>((resolve) => {
          releaseTask = resolve
        }),
    )

    expect(commits).toBe(0)
    releaseTask?.()
    await completion
    expect(commits).toBe(1)
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

  it('deduplicates pending preparation for the same exact profile artifact', async () => {
    const builds: string[] = []
    let finishBuild:
      ((preview: { srcDoc: string; revoke: () => void }) => void) | undefined
    const cache = createEpubPreviewCache((candidate) => {
      builds.push(candidate.sha256)
      return new Promise((resolve) => {
        finishBuild = resolve
      })
    })
    const original = profiled('mobile')

    const first = cache.prepare(original)
    const second = cache.prepare({ ...original })

    expect(second).toBe(first)
    expect(cache.get(original)).toEqual({ status: 'pending' })
    expect(builds).toEqual([original.sha256])

    finishBuild?.({
      srcDoc: original.identifier,
      revoke: () => undefined,
    })

    await expect(first).resolves.toEqual({
      status: 'success',
      srcDoc: original.identifier,
    })
    expect(cache.get(original)).toEqual({
      status: 'success',
      srcDoc: original.identifier,
    })
  })

  it('retries a rebuilt same-SHA artifact after a cached missing-preview error', async () => {
    const cache = createEpubPreviewCache()
    const legacy = profiled('mobile')
    const first = await cache.prepare(legacy)
    const rebuilt = {
      ...legacy,
      preview: {
        template: {
          segments: [workerPreviewPrefix],
          assetIndices: [],
        },
        assets: [],
      },
    }

    expect(first).toMatchObject({
      status: 'error',
      error: expect.stringContaining('payload is missing'),
    })

    cache.retain([rebuilt])

    await expect(cache.prepare(rebuilt)).resolves.toMatchObject({
      status: 'success',
      srcDoc: workerPreviewPrefix,
    })
  })

  it('caches a deterministic error result after preparation fails', async () => {
    let builds = 0
    const cache = createEpubPreviewCache(async () => {
      builds += 1
      throw new Error('Malformed EPUB spine')
    })
    const original = profiled('mobile')

    const first = cache.prepare(original)

    await expect(first).resolves.toEqual({
      status: 'error',
      error: 'Malformed EPUB spine',
    })
    expect(cache.get(original)).toEqual({
      status: 'error',
      error: 'Malformed EPUB spine',
    })
    expect(cache.prepare({ ...original })).toBe(first)
    expect(builds).toBe(1)
  })

  it('discards and revokes a stale pending completion', async () => {
    const revocations: string[] = []
    let finishFirst:
      ((preview: { srcDoc: string; revoke: () => void }) => void) | undefined
    let builds = 0
    const cache = createEpubPreviewCache((candidate) => {
      builds += 1
      if (builds === 1) {
        return new Promise((resolve) => {
          finishFirst = resolve
        })
      }
      return {
        srcDoc: `${candidate.identifier}-current`,
        revoke: () => revocations.push('current'),
      }
    })
    const original = profiled('mobile')

    const stale = cache.prepare(original)
    cache.retain([])
    const current = cache.prepare({ ...original })
    await current
    finishFirst?.({
      srcDoc: `${original.identifier}-stale`,
      revoke: () => revocations.push('stale'),
    })
    await stale

    expect(cache.get(original)).toEqual({
      status: 'success',
      srcDoc: `${original.identifier}-current`,
    })
    expect(revocations).toEqual(['stale'])

    cache.dispose()
    cache.dispose()
    expect(revocations).toEqual(['stale', 'current'])
  })

  it('keeps a pending selected artifact in a restarted preparation queue', async () => {
    const mobile = profiled('mobile')
    const move = profiled('paperProMove')
    const paper = profiled('paperPro')
    const cache = createEpubPreviewCache((candidate) =>
      candidate.profile?.id === 'mobile'
        ? new Promise(() => undefined)
        : {
            srcDoc: candidate.identifier,
            revoke: () => undefined,
          },
    )
    cache.prepare(mobile)
    await cache.prepare(paper)

    expect(
      selectEpubPreviewPreparationQueue(cache, mobile, [
        mobile,
        paper,
        move,
        { ...mobile },
      ]).map(epubPreviewArtifactKey),
    ).toEqual([epubPreviewArtifactKey(mobile), epubPreviewArtifactKey(move)])
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

  it('invalidates and revokes a replaced profile artifact', async () => {
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
    await cache.prepare(original)

    cache.retain([replacement])
    await cache.prepare(replacement)

    expect(revocations).toEqual([original.sha256])
    expect(cache.get(original)).toBeUndefined()
    expect(cache.get(replacement)).toEqual({
      status: 'success',
      srcDoc: replacement.identifier,
    })
  })

  it('revokes every prepared preview exactly once during cleanup', async () => {
    const revocations: string[] = []
    const cache = createEpubPreviewCache((candidate) => ({
      srcDoc: candidate.identifier,
      revoke: () => revocations.push(candidate.sha256),
    }))
    const mobile = profiled('mobile')
    const move = profiled('paperProMove')
    await cache.prepare(mobile)
    await cache.prepare(move)

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
