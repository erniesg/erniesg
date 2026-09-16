import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  EPUB_EXPORT_POLICY_VERSION,
  type EpubExport,
} from '../../research/epub'
import {
  buildExternalLinkReceipt,
  composePreviewCss,
  EPUB_PREVIEW_CSP,
  epubPreviewPayload,
} from '../../research/epub-preview'
import {
  resolveTargetProfile,
  TARGET_PROFILES,
  type TargetOrientation,
  type TargetProfileId,
} from '../../research/targets'
import {
  createReviewPaginationScheduler,
  materializeDiscreteReviewPages,
  REVIEW_PAGINATION_SUPERSEDED_MESSAGE,
  type DiscreteReviewPagination,
  type ReviewPaginationScheduler,
} from './epub-review-pagination'
import PageNavigation from './PageNavigation'
import PageZoomControls from './PageZoomControls'
import {
  fittedReviewScale,
  shouldPinReviewScrollToTop,
  steppedReviewZoom,
  type ReviewZoomMode,
} from './review-zoom'

const previewProfileIds = ['mobile', 'paperProMove', 'paperPro'] as const
export type PreviewProfileId = Extract<
  TargetProfileId,
  (typeof previewProfileIds)[number]
>

const reviewViewportPresets = [
  {
    id: 'phone',
    label: 'Phone',
    width: 390,
    height: 844,
    unit: 'CSS px',
  },
  {
    id: 'tablet',
    label: 'Tablet',
    width: 768,
    height: 1024,
    unit: 'CSS px',
  },
  {
    id: 'paper-pro-move',
    label: 'reMarkable Paper Pro Move',
    width: TARGET_PROFILES.paperProMove.dimensions.width,
    height: TARGET_PROFILES.paperProMove.dimensions.height!,
    unit: 'device px',
  },
  {
    id: 'paper-pro',
    label: 'reMarkable Paper Pro',
    width: TARGET_PROFILES.paperPro.dimensions.width,
    height: TARGET_PROFILES.paperPro.dimensions.height!,
    unit: 'device px',
  },
] as const

export type ReviewViewportId = (typeof reviewViewportPresets)[number]['id']

const reviewFontSizes = [
  { id: 'small', label: 'Small', scale: 0.9 },
  { id: 'default', label: 'Default', scale: 1 },
  { id: 'large', label: 'Large', scale: 1.15 },
  { id: 'x-large', label: 'XL', scale: 1.3 },
] as const

const reviewFontFamilies = [
  { id: 'publisher', label: 'Publisher', css: '' },
  {
    id: 'serif',
    label: 'Serif',
    css: 'Georgia, "Times New Roman", serif',
  },
  {
    id: 'sans',
    label: 'Sans',
    css: 'Inter, ui-sans-serif, system-ui, sans-serif',
  },
] as const

export type ReviewFontSizeId = (typeof reviewFontSizes)[number]['id']
export type ReviewFontFamilyId = (typeof reviewFontFamilies)[number]['id']

export function clampEpubPage(page: number, pageCount: number) {
  if (!Number.isFinite(page) || pageCount < 1) return 1
  return Math.min(pageCount, Math.max(1, Math.trunc(page)))
}

export function composeReviewReaderCss(
  fontSizeId: ReviewFontSizeId,
  fontFamilyId: ReviewFontFamilyId,
) {
  const fontSize =
    reviewFontSizes.find((candidate) => candidate.id === fontSizeId) ??
    reviewFontSizes[1]
  const fontFamily =
    reviewFontFamilies.find((candidate) => candidate.id === fontFamilyId) ??
    reviewFontFamilies[0]
  return `
html {
  height: 100%;
  overflow-x: hidden;
  overflow-y: hidden;
  overflow-anchor: none;
  --review-font-scale: ${fontSize.scale};
}
body {
  width: 100%;
  height: 100%;
  margin: 0 !important;
  overflow-x: hidden;
  overflow-y: visible;
  overflow-anchor: none;
  ${fontFamily.css ? `font-family: ${fontFamily.css} !important;` : ''}
}
${fontFamily.css ? `body * { font-family: ${fontFamily.css} !important; }` : ''}
[data-review-base-font-size] {
  font-size: calc(
    var(--review-base-font-size) * var(--review-font-scale)
  ) !important;
}
h1[data-review-base-font-size] {
  font-size: clamp(
    ${1.45 * fontSize.scale}rem,
    ${6.25 * fontSize.scale}vw,
    ${2.4 * fontSize.scale}rem
  ) !important;
  line-height: 1.08 !important;
}
h2[data-review-base-font-size] {
  font-size: clamp(
    ${1.2 * fontSize.scale}rem,
    ${4.5 * fontSize.scale}vw,
    ${1.8 * fontSize.scale}rem
  ) !important;
  line-height: 1.15 !important;
}
h3[data-review-base-font-size],
h4[data-review-base-font-size],
h5[data-review-base-font-size],
h6[data-review-base-font-size] {
  font-size: clamp(
    ${1.05 * fontSize.scale}rem,
    ${3.5 * fontSize.scale}vw,
    ${1.4 * fontSize.scale}rem
  ) !important;
  line-height: 1.2 !important;
}
h1, h2, h3, h4, h5, h6 {
  max-width: 100% !important;
  break-after: avoid;
  break-inside: avoid;
  overflow-wrap: anywhere;
  white-space: normal !important;
}
h1 *, h2 *, h3 *, h4 *, h5 *, h6 *,
p, p *, li, li *, dt, dd, figcaption, caption, th, td, a {
  max-width: 100% !important;
  white-space: normal !important;
  overflow-wrap: anywhere !important;
  word-break: normal !important;
}
img, svg {
  max-width: 100% !important;
  height: auto !important;
}
pre, code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
main {
  box-sizing: border-box;
  width: 100vw;
  height: 100vh;
  max-width: none !important;
  min-height: 0;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden;
  overflow-anchor: none;
}
[data-review-pages] {
  box-sizing: border-box;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  transition: none !important;
}
[data-review-page-fragment] {
  box-sizing: border-box;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  width: 100vw;
  height: 100vh;
  min-width: 0;
  gap: 0.7rem;
  overflow: hidden;
  padding: 5vh 7vw;
  background: #fff;
}
[data-review-page-fragment][hidden] {
  display: none !important;
}
[data-review-page-body] {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
[data-review-page-notes] {
  min-width: 0;
  max-height: 32vh;
  overflow: hidden;
  border-top: 0.06rem solid currentColor;
  padding-top: 0.45rem;
  font-size: calc(0.76rem * var(--review-font-scale));
  line-height: 1.25;
}
[data-review-page-notes]:empty {
  display: none;
}
[data-review-page-notes] .publication-note {
  margin: 0.25rem 0 0;
  border: 0;
  padding: 0;
  font-size: inherit;
}
.review-footnote-continuation-label {
  font-weight: 700;
}
[data-review-atomic-fit="true"] {
  box-sizing: border-box;
  max-width: 100% !important;
  max-height: 100% !important;
  overflow: hidden;
}
[data-review-page-body] > figure,
[data-review-page-body] > table,
[data-review-page-body] > pre,
[data-review-page-body] > blockquote {
  box-sizing: border-box;
  max-width: 100% !important;
  max-height: 100% !important;
  overflow: visible;
}
[data-review-page-body] figure img,
[data-review-page-body] figure svg,
[data-review-page-body] figure object {
  display: block;
  width: auto !important;
  max-width: 100% !important;
  max-height: calc(90vh - 5rem) !important;
  margin-inline: auto;
  object-fit: contain;
}
.wide-source-visual-frame,
.epub-embedded-table,
.semantic-table-wrapper {
  max-width: 100%;
  overflow: visible !important;
}
figure, table, pre, blockquote {
  break-inside: avoid;
}`
}

export function resolveReviewViewport(
  id: ReviewViewportId,
  orientation: TargetOrientation,
) {
  const preset =
    reviewViewportPresets.find((candidate) => candidate.id === id) ??
    reviewViewportPresets[0]
  return orientation === 'landscape'
    ? { ...preset, width: preset.height, height: preset.width, orientation }
    : { ...preset, orientation }
}

const previewScreens = previewProfileIds.map((id) => {
  const profile = TARGET_PROFILES[id]
  return {
    id,
    version: profile.version,
    label: profile.label,
    detail: profile.note,
    width: profile.dimensions.width,
    height:
      profile.dimensions.height ?? profile.preview.continuousWindowHeightCssPx!,
    previewWidth: profile.preview.widthCssPx,
    previewWindowTruth: profile.finiteHeight
      ? ('authoritative' as const)
      : ('advisory' as const),
    truth: profile.truth,
  }
})

function isCurrentPreviewArtifact(epub: EpubExport) {
  return previewScreens.some(
    (screen) =>
      epub.profile?.id === screen.id &&
      epub.profile.version === screen.version &&
      epub.profile.exportPolicy?.id === 'profile-tuned-reflowable' &&
      epub.profile.exportPolicy.version === EPUB_EXPORT_POLICY_VERSION,
  )
}

export function selectCurrentProfileEpub(
  epubs: EpubExport[],
  selectedProfileId: PreviewProfileId,
  selectedOrientation: TargetOrientation = 'portrait',
) {
  const profileVersion = TARGET_PROFILES[selectedProfileId].version
  return epubs.find(
    (candidate) =>
      candidate.profile?.id === selectedProfileId &&
      candidate.profile.version === profileVersion &&
      (candidate.profile.orientation?.selected ?? 'portrait') ===
        selectedOrientation &&
      candidate.profile.exportPolicy?.id === 'profile-tuned-reflowable' &&
      candidate.profile.exportPolicy.version === EPUB_EXPORT_POLICY_VERSION,
  )
}

const truthLabels = {
  authoritative: 'Authoritative',
  advisory: 'Advisory',
  'reader-controlled': 'Reader-controlled',
} as const

// WebKit executes the parent-installed pagination and navigation listeners in
// the frame realm, so they require script permission. Imported scripts and
// script-bearing attributes are removed by the worker compiler and remain
// blocked by the CSP before this document is mounted.
export const EPUB_PREVIEW_SANDBOX = 'allow-same-origin allow-scripts'
export { buildExternalLinkReceipt, composePreviewCss, EPUB_PREVIEW_CSP }

export function internalPreviewTargetId(href: string) {
  if (!href.startsWith('#') || href.length < 2) return null
  try {
    return decodeURIComponent(href.slice(1))
  } catch {
    return null
  }
}

let reviewNavigationOriginSequence = 0

export function ensureReviewNavigationOriginIdentity(
  element: HTMLElement,
  document: Pick<Document, 'getElementById'>,
) {
  const generated = element.dataset.reviewNavigationOriginId
  if (
    generated &&
    (!document.getElementById(generated) ||
      document.getElementById(generated) === element)
  ) {
    element.id = generated
    return generated
  }
  if (
    element.id &&
    (!document.getElementById(element.id) ||
      document.getElementById(element.id) === element)
  ) {
    return element.id
  }
  let identity = ''
  do {
    reviewNavigationOriginSequence += 1
    identity = `epub-review-origin-${reviewNavigationOriginSequence}`
  } while (document.getElementById(identity))
  element.id = identity
  element.dataset.reviewNavigationOriginId = identity
  return identity
}

export function focusReviewNavigationTarget(
  target: HTMLElement,
  schedule: (callback: () => void) => void = (callback) => {
    const frameWindow = target.ownerDocument?.defaultView
    if (frameWindow) {
      frameWindow.requestAnimationFrame(() => callback())
    } else {
      globalThis.setTimeout(callback, 0)
    }
  },
) {
  const hadTabIndex = target.hasAttribute('tabindex')
  if (!hadTabIndex) target.setAttribute('tabindex', '-1')
  schedule(() => {
    try {
      target.focus({ preventScroll: true })
    } finally {
      if (!hadTabIndex) target.removeAttribute('tabindex')
    }
  })
}

function waitForReviewImage(
  image: HTMLImageElement,
  signal?: AbortSignal,
  timeoutMs = 10_000,
) {
  if (signal?.aborted) {
    return Promise.reject(new Error(REVIEW_PAGINATION_SUPERSEDED_MESSAGE))
  }
  if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const frameWindow = image.ownerDocument.defaultView
    const finish = (error?: Error) => {
      frameWindow?.clearTimeout(timeout)
      image.removeEventListener('load', loaded)
      image.removeEventListener('error', failed)
      signal?.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve()
    }
    const loaded = () =>
      image.naturalWidth > 0 && image.naturalHeight > 0
        ? finish()
        : finish(new Error('A packaged EPUB image has no intrinsic size.'))
    const failed = () =>
      finish(new Error('A packaged EPUB image failed to load for pagination.'))
    const aborted = () =>
      finish(new Error(REVIEW_PAGINATION_SUPERSEDED_MESSAGE))
    const timeout = frameWindow?.setTimeout(
      () =>
        finish(
          new Error(
            'A packaged EPUB image did not become ready before pagination.',
          ),
        ),
      timeoutMs,
    )
    image.addEventListener('load', loaded, { once: true })
    image.addEventListener('error', failed, { once: true })
    signal?.addEventListener('abort', aborted, { once: true })
    if (image.complete) loaded()
  })
}

function waitForReviewFonts(
  document: Document,
  signal?: AbortSignal,
  timeoutMs = 10_000,
) {
  if (signal?.aborted) {
    return Promise.reject(new Error(REVIEW_PAGINATION_SUPERSEDED_MESSAGE))
  }
  if (!document.fonts) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      globalThis.clearTimeout(timeout)
      signal?.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve()
    }
    const aborted = () =>
      finish(new Error(REVIEW_PAGINATION_SUPERSEDED_MESSAGE))
    const timeout = globalThis.setTimeout(
      () =>
        finish(
          new Error(
            'Packaged EPUB fonts did not become ready before pagination.',
          ),
        ),
      timeoutMs,
    )
    void document.fonts.ready.then(
      () => finish(),
      () =>
        finish(
          new Error('Packaged EPUB fonts failed to load before pagination.'),
        ),
    )
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

const REVIEW_MEASUREMENT_FREEZE_STYLE_ID =
  'epub-review-measurement-motion-freeze'

function freezeReviewMeasurementMotion(document: Document) {
  if (document.getElementById?.(REVIEW_MEASUREMENT_FREEZE_STYLE_ID)) return
  if (!document.head || !document.createElement) return
  const style = document.createElement('style')
  style.id = REVIEW_MEASUREMENT_FREEZE_STYLE_ID
  style.textContent = `
*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  scroll-behavior: auto !important;
}`
  document.head.append(style)
}

export async function captureReviewBaseFontSizes(
  document: Document,
  frameWindow: Pick<Window, 'getComputedStyle'>,
  {
    scheduler = createReviewPaginationScheduler(),
    signal,
  }: {
    scheduler?: ReviewPaginationScheduler
    signal?: AbortSignal
  } = {},
) {
  freezeReviewMeasurementMotion(document)
  await waitForReviewFonts(document, signal)
  const measurements: Array<{
    element: HTMLElement
    fontSize: string
  }> = []
  for (const element of document.querySelectorAll<HTMLElement>('main *')) {
    let ownsVisibleText = false
    for (const node of element.childNodes) {
      if (node.nodeType === 3 && Boolean(node.textContent?.trim())) {
        ownsVisibleText = true
        break
      }
    }
    if (ownsVisibleText) {
      measurements.push({
        element,
        fontSize: frameWindow.getComputedStyle(element).fontSize,
      })
    }
    await scheduler.checkpoint(signal)
  }
  for (const { element, fontSize } of measurements) {
    element.dataset.reviewBaseFontSize = 'true'
    element.style.setProperty('--review-base-font-size', fontSize)
    await scheduler.checkpoint(signal)
  }
  return measurements.length
}

export type EpubPreviewWorkPhase =
  'unzip' | 'parse' | 'objects' | 'images' | 'sanitize' | 'serialize'

type EpubPreviewWorkCheckpoint = (
  phase: EpubPreviewWorkPhase,
  signal?: AbortSignal,
) => Promise<void> | void

const EPUB_PREVIEW_WORK_BUDGET_MS = 16

function yieldEpubPreviewTask() {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
}

function epubPreviewAbortError() {
  return new Error(REVIEW_PAGINATION_SUPERSEDED_MESSAGE)
}

function throwIfEpubPreviewAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw epubPreviewAbortError()
}

function waitForEpubPreviewTask(task: Promise<void>, signal?: AbortSignal) {
  if (!signal) return task
  throwIfEpubPreviewAborted(signal)
  return new Promise<void>((resolve, reject) => {
    const aborted = () => {
      cleanup()
      reject(epubPreviewAbortError())
    }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    void task.then(
      () => {
        cleanup()
        resolve()
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

async function runEpubPreviewCheckpoint(
  checkpoint: EpubPreviewWorkCheckpoint,
  phase: EpubPreviewWorkPhase,
  signal?: AbortSignal,
) {
  throwIfEpubPreviewAborted(signal)
  const pendingYield = checkpoint(phase, signal)
  if (pendingYield) await waitForEpubPreviewTask(pendingYield, signal)
  throwIfEpubPreviewAborted(signal)
}

export async function commitEpubPreviewAfterTask(
  commit: () => void,
  yieldTask: () => Promise<void> = yieldEpubPreviewTask,
) {
  await yieldTask()
  commit()
}

export function createEpubPreviewWorkCheckpoint({
  budgetMs = EPUB_PREVIEW_WORK_BUDGET_MS,
  now = () => globalThis.performance?.now() ?? Date.now(),
  yieldTask = () => yieldEpubPreviewTask(),
}: {
  budgetMs?: number
  now?: () => number
  yieldTask?: (phase: EpubPreviewWorkPhase, elapsedMs: number) => Promise<void>
} = {}) {
  let sliceStartedAt = now()
  return (phase: EpubPreviewWorkPhase, signal?: AbortSignal) => {
    throwIfEpubPreviewAborted(signal)
    const elapsedMs = Math.max(0, now() - sliceStartedAt)
    if (elapsedMs < budgetMs) return undefined
    return waitForEpubPreviewTask(yieldTask(phase, elapsedMs), signal).then(
      () => {
        throwIfEpubPreviewAborted(signal)
        sliceStartedAt = now()
      },
    )
  }
}

export async function buildEpubPreview(
  epub: EpubExport,
  {
    checkpoint = createEpubPreviewWorkCheckpoint(),
    signal,
  }: {
    checkpoint?: EpubPreviewWorkCheckpoint
    signal?: AbortSignal
  } = {},
) {
  throwIfEpubPreviewAborted(signal)
  const preview = epubPreviewPayload(epub)
  if (!preview) {
    throw new Error(
      'EPUB preview payload is missing; rebuild this artifact in the current background worker.',
    )
  }
  const escapedPreviewCsp = EPUB_PREVIEW_CSP.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  )
  const cspFirstPattern = new RegExp(
    `^<!DOCTYPE html><html(?: [^<>]*)?><head(?: [^<>]*)?><meta http-equiv="Content-Security-Policy" content="${escapedPreviewCsp}">`,
    'u',
  )
  if (
    !Array.isArray(preview.template?.segments) ||
    !Array.isArray(preview.template.assetIndices) ||
    !Array.isArray(preview.assets) ||
    preview.template.segments.length !==
      preview.template.assetIndices.length + 1 ||
    preview.template.segments.some((segment) => typeof segment !== 'string') ||
    !cspFirstPattern.test(preview.template.segments[0] ?? '') ||
    preview.template.assetIndices.some(
      (assetIndex) =>
        !Number.isSafeInteger(assetIndex) ||
        assetIndex < 0 ||
        assetIndex >= preview.assets.length,
    ) ||
    preview.assets.some(
      (asset) =>
        !(asset.bytes instanceof Uint8Array) ||
        typeof asset.href !== 'string' ||
        typeof asset.mediaType !== 'string' ||
        !asset.mediaType.startsWith('image/'),
    )
  ) {
    throw new Error(
      'EPUB preview payload is invalid; rebuild this artifact in the current background worker.',
    )
  }
  const objectUrls: string[] = []
  let revoked = false
  const revoke = () => {
    if (revoked) return
    revoked = true
    objectUrls.forEach((url) => URL.revokeObjectURL(url))
  }

  try {
    for (const asset of preview.assets) {
      const url = URL.createObjectURL(
        new Blob([asset.bytes as BlobPart], { type: asset.mediaType }),
      )
      objectUrls.push(url)
      await runEpubPreviewCheckpoint(checkpoint, 'images', signal)
    }
    if (preview.assets.length === 0) {
      await runEpubPreviewCheckpoint(checkpoint, 'images', signal)
    }

    const materialized: string[] = []
    for (
      let markerIndex = 0;
      markerIndex < preview.template.assetIndices.length;
      markerIndex += 1
    ) {
      materialized.push(
        preview.template.segments[markerIndex],
        objectUrls[preview.template.assetIndices[markerIndex]],
      )
      await runEpubPreviewCheckpoint(checkpoint, 'serialize', signal)
    }
    materialized.push(preview.template.segments.at(-1)!)
    if (preview.template.assetIndices.length === 0) {
      await runEpubPreviewCheckpoint(checkpoint, 'serialize', signal)
    }
    throwIfEpubPreviewAborted(signal)
    const srcDoc = materialized.join('')
    return {
      srcDoc,
      revoke,
    }
  } catch (error) {
    revoke()
    throw error
  }
}

type PreviewResult =
  | { status: 'pending' }
  | { status: 'success'; srcDoc: string }
  | { status: 'error'; error: string }

type PreparedPreview = {
  srcDoc: string
  revoke: () => void
}

type PreviewCacheEntry = {
  preview: PreviewResult
  promise: Promise<PreviewResult>
  controller: AbortController
  payloadIdentity: ReturnType<typeof epubPreviewPayload>
  revoke?: () => void
}

function revokeOnce(revoke: () => void) {
  let revoked = false
  return () => {
    if (revoked) return
    revoked = true
    revoke()
  }
}

export function epubPreviewArtifactKey(epub: EpubExport) {
  return [
    epub.profile?.id ?? 'unprofiled',
    epub.profile?.version ?? 'unversioned',
    epub.profile?.orientation?.selected ?? 'portrait',
    epub.profile?.exportPolicy?.id ?? 'unidentified-policy',
    epub.profile?.exportPolicy?.version ?? 'unversioned-policy',
    epub.mode,
    epub.sha256,
  ].join(':')
}

export function createEpubPreviewCache(
  builder: (
    epub: EpubExport,
    options: { signal: AbortSignal },
  ) => PreparedPreview | Promise<PreparedPreview> = buildEpubPreview,
) {
  const entries = new Map<string, PreviewCacheEntry>()

  const remove = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    entry.controller.abort()
    entry.revoke?.()
  }

  return {
    get(epub: EpubExport) {
      return entries.get(epubPreviewArtifactKey(epub))?.preview
    },
    prepare(epub: EpubExport) {
      const key = epubPreviewArtifactKey(epub)
      const payloadIdentity = epubPreviewPayload(epub)
      const cached = entries.get(key)
      if (cached && cached.payloadIdentity === payloadIdentity) {
        return cached.promise
      }
      if (cached) remove(key)
      const entry: PreviewCacheEntry = {
        preview: { status: 'pending' },
        promise: Promise.resolve({ status: 'pending' }),
        controller: new AbortController(),
        payloadIdentity,
      }
      entries.set(key, entry)
      entry.promise = (async () => {
        try {
          const built = await builder(epub, {
            signal: entry.controller.signal,
          })
          const revoke = revokeOnce(built.revoke)
          const preview: PreviewResult = {
            status: 'success',
            srcDoc: built.srcDoc,
          }
          if (entries.get(key) !== entry) {
            revoke()
            return preview
          }
          entry.preview = preview
          entry.revoke = revoke
          return preview
        } catch (error) {
          const preview: PreviewResult = {
            status: 'error',
            error:
              error instanceof Error
                ? error.message
                : 'EPUB preview unavailable',
          }
          if (entries.get(key) === entry) entry.preview = preview
          return preview
        }
      })()
      return entry.promise
    },
    retain(epubs: EpubExport[]) {
      const retained = new Map<
        string,
        Set<ReturnType<typeof epubPreviewPayload>>
      >()
      for (const epub of epubs) {
        const key = epubPreviewArtifactKey(epub)
        const identities = retained.get(key) ?? new Set()
        identities.add(epubPreviewPayload(epub))
        retained.set(key, identities)
      }
      for (const [key, entry] of entries) {
        if (!retained.get(key)?.has(entry.payloadIdentity)) remove(key)
      }
    },
    dispose() {
      for (const key of [...entries.keys()]) remove(key)
    },
  }
}

export function selectEpubPreviewPreparationQueue(
  previews: Pick<ReturnType<typeof createEpubPreviewCache>, 'get'>,
  selected: EpubExport,
  candidates: EpubExport[],
) {
  return [selected, ...candidates].filter((candidate, index, queue) => {
    const key = epubPreviewArtifactKey(candidate)
    if (
      queue.findIndex((other) => epubPreviewArtifactKey(other) === key) !==
      index
    ) {
      return false
    }
    const preview = previews.get(candidate)
    return preview === undefined || preview.status === 'pending'
  })
}

type ReviewLayoutAttempt = {
  document: Document
  key: string
}

function isSameReviewLayout(
  left: ReviewLayoutAttempt | undefined,
  right: ReviewLayoutAttempt,
) {
  return left?.document === right.document && left.key === right.key
}

export function createReviewLayoutAttemptTracker() {
  let pending: ReviewLayoutAttempt | undefined
  let applied: ReviewLayoutAttempt | undefined

  return {
    begin(layout: ReviewLayoutAttempt) {
      if (isSameReviewLayout(pending, layout)) return false
      if (!pending && isSameReviewLayout(applied, layout)) return false
      pending = layout
      applied = undefined
      return true
    },
    complete(layout: ReviewLayoutAttempt) {
      if (!isSameReviewLayout(pending, layout)) return
      pending = undefined
      applied = layout
    },
    fail(layout: ReviewLayoutAttempt) {
      if (isSameReviewLayout(pending, layout)) pending = undefined
    },
    reset() {
      pending = undefined
      applied = undefined
    },
    current() {
      return { pending, applied }
    },
  }
}

export default function EpubRenditionPreview({
  epubs,
  selectedProfileId,
  selectedOrientation = 'portrait',
  buildingProfileId,
  onSelectedProfileChange,
  onSelectedOrientationChange,
  onPreviewReadyChange,
  reviewMode = false,
}: {
  epubs: EpubExport[]
  selectedProfileId?: PreviewProfileId
  selectedOrientation?: TargetOrientation
  buildingProfileId?: PreviewProfileId
  onSelectedProfileChange?: (profileId: PreviewProfileId) => void
  onSelectedOrientationChange?: (orientation: TargetOrientation) => void
  onPreviewReadyChange?: (artifactKey?: string) => void
  reviewMode?: boolean
}) {
  const availableScreens = previewScreens.filter((screen) =>
    epubs.some(
      (epub) =>
        epub.profile?.id === screen.id &&
        epub.profile.version === screen.version &&
        epub.profile.exportPolicy?.id === 'profile-tuned-reflowable' &&
        epub.profile.exportPolicy.version === EPUB_EXPORT_POLICY_VERSION,
    ),
  )
  const hasSupportedProfile = availableScreens.length > 0
  const selectableScreens = onSelectedProfileChange
    ? previewScreens
    : availableScreens
  const showsRelativeEInkScale = ['paperProMove', 'paperPro'].every((id) =>
    selectableScreens.some((screen) => screen.id === id),
  )
  const initialProfileId = availableScreens.some(
    (screen) => screen.id === 'paperPro',
  )
    ? 'paperPro'
    : (availableScreens[0]?.id ?? 'paperPro')
  const [uncontrolledProfileId, setUncontrolledProfileId] =
    useState<PreviewProfileId>(initialProfileId)
  const [reviewViewportId, setReviewViewportId] =
    useState<ReviewViewportId>('phone')
  const [reviewOrientation, setReviewOrientation] =
    useState<TargetOrientation>('portrait')
  const [reviewFontSizeId, setReviewFontSizeId] =
    useState<ReviewFontSizeId>('default')
  const [reviewFontFamilyId, setReviewFontFamilyId] =
    useState<ReviewFontFamilyId>('publisher')
  const [epubPage, setEpubPage] = useState(1)
  const [epubPageCount, setEpubPageCount] = useState(1)
  const epubPageRef = useRef(1)
  const [reviewZoomMode, setReviewZoomMode] =
    useState<ReviewZoomMode>('fit-page')
  const [reviewZoomPercent, setReviewZoomPercent] = useState(100)
  const epubPageCountRef = useRef(1)
  const discretePagination = useRef<DiscreteReviewPagination>()
  const paginationRevision = useRef(0)
  const reviewPaginationQueue = useRef<Promise<void>>(Promise.resolve())
  const reviewPaginationAbortController = useRef<AbortController>()
  const reviewLayoutAttempts = useRef(createReviewLayoutAttemptTracker())
  const navigationHistory = useRef<
    Array<{ page: number; originId: string | null }>
  >([])
  const [navigationHistorySize, setNavigationHistorySize] = useState(0)
  const [reviewPaginationError, setReviewPaginationError] = useState('')
  const [reviewPaginationStatus, setReviewPaginationStatus] = useState<
    'idle' | 'paginating' | 'complete' | 'failed'
  >('idle')
  const [paginatedReviewLayoutKey, setPaginatedReviewLayoutKey] = useState('')
  const profileId = selectedProfileId ?? uncontrolledProfileId
  const [, setPreviewRevision] = useState(0)
  const iframe = useRef<HTMLIFrameElement>(null)
  const previewStage = useRef<HTMLDivElement>(null)
  const [reviewStageSize, setReviewStageSize] = useState({
    width: 0,
    height: 0,
  })
  const [navigationAnnouncement, setNavigationAnnouncement] = useState('')
  const cache = useRef<ReturnType<typeof createEpubPreviewCache> | null>(null)
  if (!cache.current) cache.current = createEpubPreviewCache()
  const epub = selectCurrentProfileEpub(epubs, profileId, selectedOrientation)
  const baseScreen =
    previewScreens.find((candidate) => candidate.id === profileId) ??
    availableScreens[0] ??
    previewScreens[2]
  const resolvedProfile = resolveTargetProfile(
    baseScreen.id,
    baseScreen.id === 'mobile' ? 'portrait' : selectedOrientation,
  )
  const screen = {
    ...baseScreen,
    width: resolvedProfile.dimensions.width,
    height:
      resolvedProfile.dimensions.height ??
      resolvedProfile.preview.continuousWindowHeightCssPx!,
    previewWidth: resolvedProfile.preview.widthCssPx,
    truth: resolvedProfile.truth,
  }
  const reviewViewport = resolveReviewViewport(
    reviewViewportId,
    reviewOrientation,
  )
  const reviewLayoutKey = [
    reviewViewport.id,
    reviewOrientation,
    reviewFontSizeId,
    reviewFontFamilyId,
  ].join(':')
  const viewportWidth = reviewMode ? reviewViewport.width : screen.width
  const viewportHeight = reviewMode ? reviewViewport.height : screen.height
  const viewportPreviewWidth = reviewMode
    ? reviewViewport.width
    : screen.previewWidth
  const reviewPreviewScale = reviewMode
    ? fittedReviewScale({
        mode: reviewZoomMode,
        customPercent: reviewZoomPercent,
        contentWidth: viewportPreviewWidth,
        contentHeight: viewportHeight,
        stageWidth: reviewStageSize.width,
        stageHeight: reviewStageSize.height,
      })
    : 1
  const preview = epub ? cache.current.get(epub) : undefined
  const readyArtifactKey =
    epub && preview?.status === 'success'
      ? epubPreviewArtifactKey(epub)
      : undefined

  useEffect(() => {
    const previews = cache.current
    if (!previews) return
    const currentEpubs = epubs.filter(isCurrentPreviewArtifact)
    previews.retain(currentEpubs)
    if (!hasSupportedProfile || !epub) return
    const queue = selectEpubPreviewPreparationQueue(
      previews,
      epub,
      currentEpubs,
    )
    let cancelled = false
    let timer: number | undefined
    const prepareNext = async () => {
      const candidate = queue.shift()
      if (!candidate || cancelled) return
      await previews.prepare(candidate)
      if (cancelled) return
      await commitEpubPreviewAfterTask(() => {
        if (!cancelled) {
          setPreviewRevision((revision) => revision + 1)
        }
      })
      if (cancelled) return
      timer = window.setTimeout(prepareNext, 0)
    }
    timer = window.setTimeout(prepareNext, 0)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [epub, epubs, hasSupportedProfile])

  useEffect(
    () => () => {
      reviewPaginationAbortController.current?.abort()
      cache.current?.dispose()
    },
    [],
  )

  useEffect(() => {
    onPreviewReadyChange?.(readyArtifactKey)
  }, [onPreviewReadyChange, readyArtifactKey])

  useEffect(() => {
    if (!reviewMode) return
    const stage = previewStage.current
    if (!stage) return
    const updateSize = () =>
      setReviewStageSize({
        width: stage.clientWidth,
        height: stage.clientHeight,
      })
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [readyArtifactKey, reviewMode])

  useEffect(() => {
    if (!reviewMode || !previewStage.current) return
    const resetOrigins = () => {
      const stage = previewStage.current
      const frameDocument = iframe.current?.contentDocument
      const frameWindow = iframe.current?.contentWindow
      if (stage) {
        stage.scrollLeft = 0
        stage.scrollTop = 0
      }
      if (frameDocument?.documentElement && frameDocument.body) {
        frameDocument.documentElement.scrollLeft = 0
        frameDocument.documentElement.scrollTop = 0
        frameDocument.body.scrollLeft = 0
        frameDocument.body.scrollTop = 0
      }
      frameWindow?.scrollTo({ left: 0, top: 0 })
    }
    resetOrigins()
    const timer = window.setTimeout(resetOrigins, 250)
    return () => window.clearTimeout(timer)
  }, [epub?.sha256, reviewMode, reviewPreviewScale])

  useEffect(() => {
    reviewPaginationAbortController.current?.abort()
    reviewPaginationAbortController.current = undefined
    paginationRevision.current += 1
    discretePagination.current = undefined
    setNavigationAnnouncement('')
    setReviewPaginationError('')
    setReviewPaginationStatus('idle')
    setPaginatedReviewLayoutKey('')
    navigationHistory.current = []
    setNavigationHistorySize(0)
    setEpubPage(1)
    epubPageRef.current = 1
    setEpubPageCount(1)
    epubPageCountRef.current = 1
    reviewLayoutAttempts.current.reset()
  }, [epub?.sha256])

  const showEpubPage = (
    requestedPage: number,
    count = epubPageCountRef.current,
  ) => {
    const frameDocument = iframe.current?.contentDocument
    const pagination = discretePagination.current
    if (!frameDocument?.documentElement || !frameDocument.body || !pagination) {
      return
    }
    const page = clampEpubPage(requestedPage, count)
    pagination.show(page)
    frameDocument.documentElement.scrollLeft = 0
    frameDocument.documentElement.scrollTop = 0
    frameDocument.body.scrollLeft = 0
    frameDocument.body.scrollTop = 0
    iframe.current?.contentWindow?.scrollTo({ left: 0, top: 0 })
    if (previewStage.current) {
      previewStage.current.scrollLeft = 0
      previewStage.current.scrollTop = 0
    }
    epubPageRef.current = page
    setEpubPage(page)
  }

  const applyReviewReaderSettings = () => {
    if (!reviewMode) return
    const frame = iframe.current
    const document = frame?.contentDocument
    const frameWindow = frame?.contentWindow
    if (!document || !frameWindow) return
    const layoutAttempt = { document, key: reviewLayoutKey }
    if (!reviewLayoutAttempts.current.begin(layoutAttempt)) return
    setReviewPaginationError('')
    setReviewPaginationStatus('paginating')
    setNavigationAnnouncement('Paginating EPUB for the selected layout…')
    const layoutKey = reviewLayoutKey
    const revision = paginationRevision.current + 1
    paginationRevision.current = revision
    reviewPaginationAbortController.current?.abort()
    const paginationAbortController = new AbortController()
    reviewPaginationAbortController.current = paginationAbortController
    const scheduler = createReviewPaginationScheduler()
    const isCurrentLayout = () =>
      paginationRevision.current === revision &&
      iframe.current?.contentDocument === document

    void (async () => {
      const styleId = 'epub-review-reader-settings'
      const style =
        document.getElementById(styleId) ?? document.createElement('style')
      if (!style.parentElement) {
        document.documentElement.dataset.reviewPreparationPhase = 'font-capture'
        const captureStartedAt = frameWindow.performance.now()
        await captureReviewBaseFontSizes(document, frameWindow, {
          scheduler,
          signal: paginationAbortController.signal,
        })
        if (!isCurrentLayout()) return
        document.documentElement.dataset.reviewFontCaptureMilliseconds = (
          frameWindow.performance.now() - captureStartedAt
        ).toFixed(1)
      }
      if (!isCurrentLayout()) return
      style.id = styleId
      style.textContent = composeReviewReaderCss(
        reviewFontSizeId,
        reviewFontFamilyId,
      )
      if (!style.parentElement) document.head.append(style)
      document.documentElement.dataset.reviewPreparationPhase = 'assets'
      await Promise.all([
        waitForReviewFonts(document, paginationAbortController.signal),
        ...[...document.images].map((image) =>
          waitForReviewImage(image, paginationAbortController.signal),
        ),
      ])
      if (!isCurrentLayout()) return
      await new Promise<void>((resolve) => {
        // WebKit does not reliably dispatch callbacks registered on a
        // script-disabled sandboxed frame's Window. Schedule from the parent
        // realm while measuring the already-loaded frame document.
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => resolve()),
        )
      })
      if (!isCurrentLayout() || !document.documentElement || !document.body) {
        return
      }
      document.documentElement.dataset.reviewPreparationPhase = 'pagination'
      const previousPage = epubPageRef.current
      const previousCount = epubPageCountRef.current
      const run = reviewPaginationQueue.current.then(() =>
        materializeDiscreteReviewPages(document, {
          scheduler,
          signal: paginationAbortController.signal,
        }),
      )
      reviewPaginationQueue.current = run.then(
        () => undefined,
        () => undefined,
      )
      const pagination = await run
      if (!isCurrentLayout()) return
      reviewLayoutAttempts.current.complete(layoutAttempt)
      discretePagination.current = pagination
      if (
        reviewPaginationAbortController.current === paginationAbortController
      ) {
        reviewPaginationAbortController.current = undefined
      }
      document.documentElement.dataset.reviewPreparationPhase = 'complete'
      setPaginatedReviewLayoutKey(layoutKey)
      setReviewPaginationStatus('complete')
      const count = pagination.pageCount
      epubPageCountRef.current = count
      setEpubPageCount(count)
      const relativePosition =
        previousCount <= 1 ? 0 : (previousPage - 1) / (previousCount - 1)
      const selected = clampEpubPage(
        1 + Math.round(relativePosition * Math.max(0, count - 1)),
        count,
      )
      showEpubPage(selected, count)
      setNavigationAnnouncement(
        `EPUB repaginated into ${count} complete pages.`,
      )
    })()
      .catch((error) => {
        if (!isCurrentLayout()) return
        if (
          reviewPaginationAbortController.current === paginationAbortController
        ) {
          reviewPaginationAbortController.current = undefined
        }
        document.documentElement.dataset.reviewPreparationPhase = 'failed'
        setReviewPaginationError(
          error instanceof Error
            ? error.message
            : 'EPUB review pagination failed closed.',
        )
        setReviewPaginationStatus('failed')
      })
      .finally(() => reviewLayoutAttempts.current.fail(layoutAttempt))
  }

  const beginReviewRepagination = () => {
    reviewPaginationAbortController.current?.abort()
    reviewPaginationAbortController.current = undefined
    paginationRevision.current += 1
    discretePagination.current = undefined
    navigationHistory.current = []
    setNavigationHistorySize(0)
    setReviewPaginationError('')
    setReviewPaginationStatus('paginating')
    setPaginatedReviewLayoutKey('')
    reviewLayoutAttempts.current.reset()
    setNavigationAnnouncement('Paginating EPUB for the selected layout…')
  }

  const connectInternalNavigation = () => {
    const frame = iframe.current
    const document = frame?.contentDocument
    if (!frame || !document) return
    const openInternalTarget = (
      targetId: string,
      link: HTMLAnchorElement | null,
    ) => {
      const target = document.getElementById(targetId)
      document
        .querySelectorAll('[data-review-navigation-target="true"]')
        .forEach((candidate) =>
          candidate.removeAttribute('data-review-navigation-target'),
        )
      if (!target) {
        setNavigationAnnouncement('Target missing from this EPUB.')
        return
      }
      target.setAttribute('data-review-navigation-target', 'true')
      const frameWindow = frame.contentWindow
      if (reviewMode && frameWindow) {
        const targetPage =
          discretePagination.current?.pageForTarget(target) ?? null
        if (!targetPage) {
          setNavigationAnnouncement('Target is not on a materialized page.')
          return
        }
        navigationHistory.current.push({
          page: epubPageRef.current,
          originId: link
            ? ensureReviewNavigationOriginIdentity(link, document)
            : null,
        })
        setNavigationHistorySize(navigationHistory.current.length)
        showEpubPage(targetPage)
        focusReviewNavigationTarget(target, (callback) =>
          frameWindow.requestAnimationFrame(() => callback()),
        )
        setNavigationAnnouncement(
          `Opened ${link?.textContent?.trim() || 'target'} on EPUB page ${targetPage}.`,
        )
      } else {
        target.scrollIntoView({ block: 'start' })
        focusReviewNavigationTarget(target)
        setNavigationAnnouncement(
          `Opened ${link?.textContent?.trim() || 'target'}.`,
        )
      }
    }
    document.addEventListener('click', (event) => {
      const origin = event.target
      const link =
        origin && typeof (origin as Element).closest === 'function'
          ? (origin as Element).closest<HTMLAnchorElement>('a[href^="#"]')
          : null
      if (!link) return
      const targetId = internalPreviewTargetId(link.getAttribute('href') ?? '')
      event.preventDefault()
      if (targetId) openInternalTarget(targetId, link)
    })
    applyReviewReaderSettings()
  }

  useEffect(() => {
    if (
      !reviewMode ||
      !readyArtifactKey ||
      !iframe.current?.contentDocument?.querySelector('main')
    ) {
      return
    }
    applyReviewReaderSettings()
  }, [readyArtifactKey, reviewLayoutKey, reviewMode])

  const canBuildSelectedProfile =
    hasSupportedProfile && Boolean(onSelectedProfileChange)
  if (!hasSupportedProfile || (!epub && !canBuildSelectedProfile)) {
    return (
      <section className="epub-rendition-preview" aria-label="EPUB preview">
        <p role="alert">
          Preview unavailable: unsupported target-profile version or EPUB
          export-policy version. Rebuild the EPUB with the current profile
          registry before inspecting or downloading it.
        </p>
      </section>
    )
  }

  return (
    <section
      className={[
        'epub-rendition-preview',
        reviewMode ? 'epub-rendition-preview--review' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-labelledby="epub-preview-heading"
      data-profile-id={epub?.profile?.id ?? screen.id}
      data-profile-version={epub?.profile?.version ?? screen.version}
      data-artifact-sha256={epub?.sha256}
      data-export-mode={epub?.mode}
      data-review-viewport={reviewMode ? reviewViewport.id : undefined}
      data-review-orientation={reviewMode ? reviewOrientation : undefined}
      data-review-font-size={reviewMode ? reviewFontSizeId : undefined}
      data-review-font-family={reviewMode ? reviewFontFamilyId : undefined}
      data-review-pagination-status={
        reviewMode ? reviewPaginationStatus : undefined
      }
      data-review-paginated-layout={
        reviewMode ? paginatedReviewLayoutKey : undefined
      }
    >
      {!reviewMode && (
        <div className="epub-preview-header">
          <span className="epub-preview-kicker">Generated artifact</span>
          <h3 id="epub-preview-heading">EPUB rendition preview</h3>
          <p>
            This sandboxed view renders the sanitized spine and packaged assets
            from the same EPUB offered for download.
          </p>
          <fieldset className="epub-device-switcher">
            <legend>Preview screen</legend>
            <div>
              {selectableScreens.map((candidate) => {
                const candidateOrientation = TARGET_PROFILES[
                  candidate.id
                ].orientation.supported.includes(selectedOrientation)
                  ? selectedOrientation
                  : 'portrait'
                const artifactStatus = selectCurrentProfileEpub(
                  epubs,
                  candidate.id,
                  candidateOrientation,
                )
                  ? 'ready'
                  : buildingProfileId === candidate.id
                    ? 'building'
                    : 'unbuilt'
                return (
                  <button
                    aria-pressed={candidate.id === screen.id}
                    aria-label={`Preview ${candidate.label}, profile ${candidate.id} version ${candidate.version}`}
                    data-artifact-status={artifactStatus}
                    data-profile-id={candidate.id}
                    data-profile-version={candidate.version}
                    key={candidate.id}
                    onClick={() => {
                      if (onSelectedProfileChange) {
                        onSelectedProfileChange(candidate.id)
                      } else {
                        setUncontrolledProfileId(candidate.id)
                      }
                    }}
                    type="button"
                  >
                    <strong>{candidate.label}</strong>
                    <small>{candidate.detail}</small>
                    <small className="epub-preview-profile-key">
                      {candidate.id}@{candidate.version} · {artifactStatus}
                    </small>
                  </button>
                )
              })}
            </div>
            {showsRelativeEInkScale && (
              <p className="epub-device-scale-note">
                Both reMarkable frames use one physical scale. On narrow
                screens, scroll sideways; the frames do not shrink.
              </p>
            )}
          </fieldset>
          {resolvedProfile.orientation.supported.length > 1 && (
            <fieldset className="epub-device-switcher">
              <legend>Orientation</legend>
              {resolvedProfile.orientation.supported.map((candidate) => (
                <button
                  aria-pressed={selectedOrientation === candidate}
                  key={candidate}
                  onClick={() => onSelectedOrientationChange?.(candidate)}
                  type="button"
                >
                  {candidate === 'portrait' ? 'Portrait' : 'Landscape'}
                </button>
              ))}
            </fieldset>
          )}
          {epub && (
            <dl
              className="epub-preview-receipt"
              aria-label="Selected EPUB artifact receipt"
              aria-live="polite"
            >
              <div>
                <dt>Profile</dt>
                <dd>
                  <code>
                    {epub.profile?.id}@{epub.profile?.version}
                  </code>
                </dd>
              </div>
              <div>
                <dt>Artifact SHA-256</dt>
                <dd>
                  <code>{epub.sha256}</code>
                </dd>
              </div>
              <div>
                <dt>Selected orientation</dt>
                <dd>{selectedOrientation}</dd>
              </div>
              {(
                [
                  ['Profile geometry', 'geometry'],
                  ['Typography and margins', 'typography'],
                  ['Pagination', 'pagination'],
                  ['Orientation', 'orientation'],
                ] as const
              ).map(([label, key]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd data-truth-authority={screen.truth[key]}>
                    {truthLabels[screen.truth[key]]}
                  </dd>
                </div>
              ))}
              <div>
                <dt>Preview window</dt>
                <dd data-truth-authority={screen.previewWindowTruth}>
                  {truthLabels[screen.previewWindowTruth]}
                </dd>
              </div>
            </dl>
          )}
        </div>
      )}
      {reviewMode && epub && (
        <div className="epub-review-controls">
          {reviewPaginationError && (
            <p className="epub-review-pagination-error" role="alert">
              {reviewPaginationError}
            </p>
          )}
          <div
            className="epub-review-pagination"
            aria-label="EPUB page navigation"
          >
            <PageNavigation
              page={epubPage}
              pageCount={epubPageCount}
              label="EPUB"
              onPageChange={showEpubPage}
            />
            {navigationHistorySize > 0 && (
              <button
                type="button"
                className="epub-review-return"
                aria-label="Return to previous EPUB location"
                title="Return to previous EPUB location"
                onClick={() => {
                  const origin = navigationHistory.current.pop()
                  setNavigationHistorySize(navigationHistory.current.length)
                  if (!origin) return
                  showEpubPage(origin.page)
                  setNavigationAnnouncement(
                    `Returned to EPUB page ${origin.page}.`,
                  )
                  const originElement = origin.originId
                    ? iframe.current?.contentDocument?.getElementById(
                        origin.originId,
                      )
                    : null
                  if (originElement) {
                    focusReviewNavigationTarget(originElement)
                  }
                }}
              >
                ↩
              </button>
            )}
            <PageZoomControls
              mode={reviewZoomMode}
              percent={reviewZoomPercent}
              actualScale={reviewPreviewScale}
              onChange={(mode, percent) => {
                setReviewZoomMode(mode)
                setReviewZoomPercent(percent)
              }}
            />
            <details className="epub-review-settings">
              <summary>
                <span>Reader settings</span>
                <span>
                  {reviewViewport.label} · {reviewOrientation} ·{' '}
                  {reviewFontSizes.find(
                    (candidate) => candidate.id === reviewFontSizeId,
                  )?.label ?? 'Default'}
                </span>
              </summary>
              <div
                className="epub-review-viewport-controls"
                aria-label="EPUB viewport controls"
              >
                <label>
                  <span>Viewport size</span>
                  <select
                    aria-label="Viewport size"
                    value={reviewViewportId}
                    onChange={(event) => {
                      const next = event.target.value as ReviewViewportId
                      if (next === reviewViewportId) return
                      beginReviewRepagination()
                      setReviewViewportId(next)
                    }}
                  >
                    {reviewViewportPresets.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Orientation</span>
                  <select
                    aria-label="Orientation"
                    value={reviewOrientation}
                    onChange={(event) => {
                      const next = event.target.value as TargetOrientation
                      if (next === reviewOrientation) return
                      beginReviewRepagination()
                      setReviewOrientation(next)
                    }}
                  >
                    <option value="portrait">Portrait</option>
                    <option value="landscape">Landscape</option>
                  </select>
                </label>
                <label>
                  <span>Font size</span>
                  <select
                    aria-label="Font size"
                    value={reviewFontSizeId}
                    onChange={(event) => {
                      const next = event.target.value as ReviewFontSizeId
                      if (next === reviewFontSizeId) return
                      beginReviewRepagination()
                      setReviewFontSizeId(next)
                    }}
                  >
                    {reviewFontSizes.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Font family</span>
                  <select
                    aria-label="Font family"
                    value={reviewFontFamilyId}
                    onChange={(event) => {
                      const next = event.target.value as ReviewFontFamilyId
                      if (next === reviewFontFamilyId) return
                      beginReviewRepagination()
                      setReviewFontFamilyId(next)
                    }}
                  >
                    {reviewFontFamilies.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.label}
                      </option>
                    ))}
                  </select>
                </label>
                <output aria-live="polite">
                  <strong>
                    {reviewViewport.width} × {reviewViewport.height}
                  </strong>
                  <span>{reviewViewport.unit} · scaled preview</span>
                </output>
              </div>
            </details>
            <span className="sr-only" aria-live="polite">
              {navigationAnnouncement}
            </span>
          </div>
        </div>
      )}
      {!epub ? (
        <p aria-live="polite">
          {buildingProfileId === profileId
            ? `Building ${screen.label} EPUB locally…`
            : `Preparing ${screen.label} EPUB build…`}
        </p>
      ) : preview?.status === 'error' ? (
        <p role="alert">Preview unavailable: {preview.error}</p>
      ) : preview?.status === 'success' ? (
        <>
          <div
            ref={previewStage}
            className="epub-preview-stage"
            role="region"
            aria-label={
              reviewMode
                ? `Single ${screen.label} EPUB page`
                : `Scrollable ${screen.label} EPUB viewport`
            }
            data-zoom-mode={reviewMode ? reviewZoomMode : undefined}
            tabIndex={0}
            onScroll={(event) => {
              if (
                shouldPinReviewScrollToTop(reviewMode, reviewZoomMode) &&
                event.currentTarget.scrollTop !== 0
              ) {
                event.currentTarget.scrollTop = 0
              }
            }}
            onKeyDown={(event) => {
              if (
                reviewMode &&
                (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
              ) {
                event.preventDefault()
                event.stopPropagation()
                showEpubPage(epubPage + (event.key === 'ArrowLeft' ? -1 : 1))
              } else if (
                reviewMode &&
                (event.key === '+' || event.key === '=' || event.key === '-')
              ) {
                event.preventDefault()
                const direction = event.key === '-' ? -1 : 1
                setReviewZoomMode('custom')
                setReviewZoomPercent(
                  steppedReviewZoom(
                    reviewZoomMode === 'custom'
                      ? reviewZoomPercent
                      : reviewPreviewScale * 100,
                    direction,
                  ),
                )
              } else if (reviewMode && event.key === '0') {
                event.preventDefault()
                setReviewZoomMode('fit-page')
              }
            }}
            onWheel={(event) => {
              if (!reviewMode || !event.ctrlKey) return
              event.preventDefault()
              setReviewZoomMode('custom')
              setReviewZoomPercent(
                steppedReviewZoom(
                  reviewZoomMode === 'custom'
                    ? reviewZoomPercent
                    : reviewPreviewScale * 100,
                  event.deltaY > 0 ? -1 : 1,
                ),
              )
            }}
          >
            <div
              className="epub-preview-device-shell"
              style={
                {
                  '--epub-review-scale': reviewPreviewScale,
                  '--epub-review-shell-width': `${viewportPreviewWidth * reviewPreviewScale}px`,
                  '--epub-review-shell-height': `${viewportHeight * reviewPreviewScale}px`,
                  '--epub-device-ratio': `${viewportWidth} / ${viewportHeight}`,
                  '--epub-device-width': `${viewportPreviewWidth}px`,
                  '--epub-device-height': `${viewportHeight}px`,
                } as CSSProperties
              }
            >
              <div
                className="epub-preview-device"
                data-device={
                  reviewMode ? `review-${reviewViewport.id}` : screen.id
                }
              >
                <iframe
                  ref={iframe}
                  key={`${screen.id}-${epub.sha256}`}
                  title={`Generated EPUB rendition on ${screen.label}`}
                  sandbox={EPUB_PREVIEW_SANDBOX}
                  srcDoc={preview.srcDoc}
                  onLoad={connectInternalNavigation}
                />
              </div>
            </div>
          </div>
          {reviewMode && (
            <small className="epub-review-page-status" aria-live="polite">
              EPUB page {epubPage} of {epubPageCount} · use the page buttons or
              focus the page and press ←/→
            </small>
          )}
        </>
      ) : (
        <p aria-live="polite">Preparing EPUB preview…</p>
      )}
    </section>
  )
}
