import { strFromU8, unzipSync } from 'fflate'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  EPUB_EXPORT_POLICY_VERSION,
  type EpubExport,
} from '../../research/epub'
import {
  resolveTargetProfile,
  TARGET_PROFILES,
  type TargetOrientation,
  type TargetProfileId,
} from '../../research/targets'

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
  overflow-y: auto;
  overflow-anchor: none;
  --review-font-scale: ${fontSize.scale};
}
body {
  width: 100%;
  min-height: 100%;
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
  max-width: none !important;
  min-height: 100vh;
  margin: 0 !important;
  padding: 6vh 8vw !important;
  overflow: visible;
  overflow-anchor: none;
}
[data-review-page-content] {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  transition: none !important;
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

const blockedElements = [
  'script',
  'iframe',
  'frame',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'base',
]

function safeCss(value: string) {
  return value
    .replace(/@import[^;]+;?/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none')
}

export function buildExternalLinkReceipt(href: string, accessibleName: string) {
  const label = accessibleName.trim() || href
  return {
    role: 'link',
    tabIndex: 0,
    originalHref: href,
    ariaLabel: `${label} (link disabled in preview)`,
  }
}

export function internalPreviewTargetId(href: string) {
  if (!href.startsWith('#') || href.length < 2) return null
  try {
    return decodeURIComponent(href.slice(1))
  } catch {
    return null
  }
}

export function composePreviewCss(epubCss: string) {
  return `${safeCss(epubCss)}
html { color-scheme: light; background: #fff; }
body { margin: 0; }
.epub-embedded-table { overflow-x: auto; }
img { max-width: 100%; height: auto; }
[data-review-navigation-target="true"] {
  outline: 0.15rem solid #b45309;
  outline-offset: 0.18rem;
  background: #fff7ed;
  scroll-margin-block-start: 1rem;
}`
}

function sanitizeDocument(document: Document) {
  for (const element of document.querySelectorAll(blockedElements.join(','))) {
    element.remove()
  }
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
        element.removeAttribute(attribute.name)
      }
    }
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('#')) continue
    const receipt = buildExternalLinkReceipt(
      href,
      link.getAttribute('aria-label') ?? link.textContent ?? '',
    )
    link.removeAttribute('href')
    link.setAttribute('role', receipt.role)
    link.tabIndex = receipt.tabIndex
    link.dataset.originalHref = receipt.originalHref
    link.setAttribute('aria-label', receipt.ariaLabel)
  }
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta')) {
    if (meta.httpEquiv) meta.remove()
  }
}

function buildPreview(epub: EpubExport) {
  const files = unzipSync(epub.bytes)
  const content = files['EPUB/content.xhtml']
  if (!content) throw new Error('EPUB spine content is missing')
  const parser = new DOMParser()
  const document = parser.parseFromString(strFromU8(content), 'text/html')
  const objectUrls: string[] = []
  let revoked = false
  const revoke = () => {
    if (revoked) return
    revoked = true
    objectUrls.forEach((url) => URL.revokeObjectURL(url))
  }

  try {
    for (const object of document.querySelectorAll<HTMLObjectElement>(
      'object[data]',
    )) {
      const href = object.getAttribute('data') ?? ''
      const embedded = files[`EPUB/${href}`]
      if (!embedded || object.type !== 'application/xhtml+xml') {
        object.replaceWith(document.createTextNode(object.textContent ?? ''))
        continue
      }
      const source = parser.parseFromString(strFromU8(embedded), 'text/html')
      const table = source.querySelector('table')
      if (!table) {
        object.replaceWith(document.createTextNode(object.textContent ?? ''))
        continue
      }
      const wrapper = document.createElement('div')
      wrapper.className = 'epub-embedded-table'
      wrapper.append(document.importNode(table, true))
      object.replaceWith(wrapper)
    }

    for (const image of document.querySelectorAll<HTMLImageElement>(
      'img[src]',
    )) {
      const href = image.getAttribute('src') ?? ''
      const asset = files[`EPUB/${href}`]
      if (!asset) {
        image.removeAttribute('src')
        continue
      }
      const mediaType = href.endsWith('.svg')
        ? 'image/svg+xml'
        : href.endsWith('.png')
          ? 'image/png'
          : href.endsWith('.gif')
            ? 'image/gif'
            : 'image/jpeg'
      const url = URL.createObjectURL(
        new Blob([asset as BlobPart], { type: mediaType }),
      )
      objectUrls.push(url)
      image.src = url
    }

    sanitizeDocument(document)
    document
      .querySelectorAll('link[rel="stylesheet"]')
      .forEach((link) => link.remove())
    const style = document.createElement('style')
    style.textContent = composePreviewCss(
      strFromU8(files['EPUB/styles.css'] ?? new Uint8Array()),
    )
    document.head.append(style)
    const policy = document.createElement('meta')
    policy.httpEquiv = 'Content-Security-Policy'
    policy.content =
      "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; font-src 'none'; object-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'"
    document.head.prepend(policy)
    return {
      srcDoc: `<!doctype html>${document.documentElement.outerHTML}`,
      revoke,
    }
  } catch (error) {
    revoke()
    throw error
  }
}

type PreviewResult =
  { srcDoc: string; error?: never } | { srcDoc?: never; error: string }

type PreparedPreview = {
  srcDoc: string
  revoke: () => void
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
  builder: (epub: EpubExport) => PreparedPreview = buildPreview,
) {
  const entries = new Map<
    string,
    { preview: PreviewResult; revoke?: () => void }
  >()

  const remove = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    entry.revoke?.()
  }

  return {
    get(epub: EpubExport) {
      return entries.get(epubPreviewArtifactKey(epub))?.preview
    },
    prepare(epub: EpubExport) {
      const key = epubPreviewArtifactKey(epub)
      const cached = entries.get(key)
      if (cached) return cached.preview
      try {
        const built = builder(epub)
        const entry = {
          preview: { srcDoc: built.srcDoc } satisfies PreviewResult,
          revoke: built.revoke,
        }
        entries.set(key, entry)
        return entry.preview
      } catch (error) {
        const preview: PreviewResult = {
          error:
            error instanceof Error ? error.message : 'EPUB preview unavailable',
        }
        entries.set(key, { preview })
        return preview
      }
    },
    retain(epubs: EpubExport[]) {
      const retained = new Set(epubs.map(epubPreviewArtifactKey))
      for (const key of entries.keys()) {
        if (!retained.has(key)) remove(key)
      }
    },
    dispose() {
      for (const key of [...entries.keys()]) remove(key)
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
  const epubPageCountRef = useRef(1)
  const profileId = selectedProfileId ?? uncontrolledProfileId
  const [, setPreviewRevision] = useState(0)
  const iframe = useRef<HTMLIFrameElement>(null)
  const previewStage = useRef<HTMLDivElement>(null)
  const [reviewStageSize, setReviewStageSize] = useState({
    width: 0,
    height: 0,
  })
  const navigationHistory = useRef<number[]>([])
  const [navigation, setNavigation] = useState<{
    marker: string
    target: string
  } | null>(null)
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
  const viewportWidth = reviewMode ? reviewViewport.width : screen.width
  const viewportHeight = reviewMode ? reviewViewport.height : screen.height
  const viewportPreviewWidth = reviewMode
    ? reviewViewport.width
    : screen.previewWidth
  const reviewPreviewScale =
    reviewMode && reviewStageSize.width > 0 && reviewStageSize.height > 0
      ? Math.min(
          1,
          Math.max(
            0.1,
            Math.min(
              (reviewStageSize.width - 32) / viewportPreviewWidth,
              (reviewStageSize.height - 32) / viewportHeight,
            ),
          ),
        )
      : 1
  const preview = epub ? cache.current.get(epub) : undefined
  const readyArtifactKey =
    epub && preview?.srcDoc ? epubPreviewArtifactKey(epub) : undefined

  useEffect(() => {
    const previews = cache.current
    if (!previews) return
    const currentEpubs = epubs.filter(isCurrentPreviewArtifact)
    previews.retain(currentEpubs)
    if (!hasSupportedProfile || !epub) return
    const queue = [epub, ...currentEpubs].filter(
      (candidate, index, candidates) =>
        previews.get(candidate) === undefined &&
        candidates.findIndex(
          (other) =>
            epubPreviewArtifactKey(other) === epubPreviewArtifactKey(candidate),
        ) === index,
    )
    let cancelled = false
    let timer: number | undefined
    const prepareNext = () => {
      const candidate = queue.shift()
      if (!candidate || cancelled) return
      previews.prepare(candidate)
      if (cancelled) return
      setPreviewRevision((revision) => revision + 1)
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
  }, [reviewMode])

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
      if (frameDocument) {
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
    navigationHistory.current = []
    setNavigation(null)
    setEpubPage(1)
    setEpubPageCount(1)
    epubPageCountRef.current = 1
  }, [epub?.sha256])

  const showEpubPage = (
    requestedPage: number,
    count = epubPageCountRef.current,
  ) => {
    const frameWindow = iframe.current?.contentWindow
    const frameDocument = iframe.current?.contentDocument
    const content = frameDocument?.querySelector<HTMLElement>(
      '[data-review-page-content]',
    )
    if (!frameWindow || !frameDocument || !content) return
    const page = clampEpubPage(requestedPage, count)
    content.style.transform = 'none'
    content.dataset.reviewPage = String(page)
    frameDocument.documentElement.scrollLeft = 0
    frameDocument.documentElement.scrollTop = 0
    frameDocument.body.scrollLeft = 0
    frameDocument.body.scrollTop = 0
    frameWindow.scrollTo({
      left: 0,
      top: (page - 1) * frameWindow.innerHeight,
      behavior: 'auto',
    })
    if (previewStage.current) {
      previewStage.current.scrollLeft = 0
      previewStage.current.scrollTop = 0
    }
    setEpubPage(page)
  }

  const applyReviewReaderSettings = () => {
    if (!reviewMode) return
    const frame = iframe.current
    const document = frame?.contentDocument
    const frameWindow = frame?.contentWindow
    if (!document || !frameWindow) return
    const styleId = 'epub-review-reader-settings'
    const style =
      document.getElementById(styleId) ?? document.createElement('style')
    if (!style.parentElement) {
      document.querySelectorAll<HTMLElement>('main *').forEach((element) => {
        const ownsVisibleText = [...element.childNodes].some(
          (node) =>
            node.nodeType === Node.TEXT_NODE &&
            Boolean(node.textContent?.trim()),
        )
        if (!ownsVisibleText) return
        element.dataset.reviewBaseFontSize = 'true'
        element.style.setProperty(
          '--review-base-font-size',
          frameWindow.getComputedStyle(element).fontSize,
        )
      })
    }
    style.id = styleId
    style.textContent = composeReviewReaderCss(
      reviewFontSizeId,
      reviewFontFamilyId,
    )
    if (!style.parentElement) document.head.append(style)
    const main = document.querySelector('main')
    if (main && !main.querySelector(':scope > [data-review-page-content]')) {
      const content = document.createElement('div')
      content.dataset.reviewPageContent = 'true'
      while (main.firstChild) content.append(main.firstChild)
      main.append(content)
    }
    frameWindow.requestAnimationFrame(() => {
      frameWindow.requestAnimationFrame(() => {
        const content = document.querySelector<HTMLElement>(
          '[data-review-page-content]',
        )
        const contentHeight = Math.max(
          (content?.scrollHeight ?? 0) + frameWindow.innerHeight * 0.12,
          frameWindow.innerHeight,
        )
        const count = Math.max(
          1,
          Math.ceil((contentHeight - 1) / frameWindow.innerHeight),
        )
        epubPageCountRef.current = count
        setEpubPageCount(count)
        showEpubPage(1, count)
        navigationHistory.current = []
        setNavigation(null)
      })
    })
  }

  useEffect(() => {
    applyReviewReaderSettings()
  }, [
    epub?.sha256,
    reviewFontFamilyId,
    reviewFontSizeId,
    reviewMode,
    reviewViewport.height,
    reviewViewport.width,
  ])

  const connectInternalNavigation = () => {
    const frame = iframe.current
    const document = frame?.contentDocument
    if (!frame || !document) return
    document.addEventListener('click', (event) => {
      const origin = event.target
      const link =
        origin && typeof (origin as Element).closest === 'function'
          ? (origin as Element).closest<HTMLAnchorElement>('a[href^="#"]')
          : null
      if (!link) return
      const targetId = internalPreviewTargetId(link.getAttribute('href') ?? '')
      const target = targetId ? document.getElementById(targetId) : null
      event.preventDefault()
      document
        .querySelectorAll('[data-review-navigation-target="true"]')
        .forEach((candidate) =>
          candidate.removeAttribute('data-review-navigation-target'),
        )
      if (!target) {
        setNavigation({
          marker: link.textContent?.trim() || 'Link',
          target: 'Target missing from this EPUB',
        })
        return
      }
      target.setAttribute('data-review-navigation-target', 'true')
      const frameWindow = frame.contentWindow
      if (reviewMode && frameWindow) {
        const content = document.querySelector<HTMLElement>(
          '[data-review-page-content]',
        )
        navigationHistory.current.push(Number(content?.dataset.reviewPage ?? 1))
        const absoluteTargetTop =
          target.getBoundingClientRect().top -
          (content?.getBoundingClientRect().top ?? 0)
        showEpubPage(
          Math.floor(absoluteTargetTop / frameWindow.innerHeight) + 1,
        )
      } else {
        navigationHistory.current.push(frameWindow?.scrollY ?? 0)
        target.scrollIntoView({ block: 'start' })
      }
      const targetText = (target.textContent ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 220)
      setNavigation({
        marker: link.textContent?.trim() || 'Link',
        target: targetText || targetId || 'Unnamed target',
      })
    })
    if (reviewMode && frame.contentWindow) {
      frame.contentWindow.addEventListener(
        'scroll',
        () => {
          const frameWindow = frame.contentWindow
          if (!frameWindow) return
          const livePageCount = Math.max(
            1,
            Math.ceil(
              frameWindow.document.documentElement.scrollHeight /
                frameWindow.innerHeight,
            ),
          )
          setEpubPage(
            clampEpubPage(
              Math.floor(frameWindow.scrollY / frameWindow.innerHeight) + 1,
              livePageCount,
            ),
          )
        },
        { passive: true },
      )
    }
    applyReviewReaderSettings()
  }

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
          {navigation && (
            <div className="epub-review-navigation" aria-live="polite">
              <button
                type="button"
                onClick={() => {
                  const position = navigationHistory.current.pop()
                  if (position === undefined) return
                  const frame = iframe.current
                  frame?.contentDocument
                    ?.querySelectorAll('[data-review-navigation-target="true"]')
                    .forEach((candidate) =>
                      candidate.removeAttribute(
                        'data-review-navigation-target',
                      ),
                    )
                  if (reviewMode) {
                    showEpubPage(position)
                  } else {
                    frame?.contentWindow?.scrollTo(0, position)
                  }
                  setNavigation(null)
                }}
              >
                ← Back
              </button>
              <span>{`${navigation.marker} → ${navigation.target}`}</span>
            </div>
          )}
          <div
            className="epub-review-pagination"
            aria-label="EPUB page navigation"
          >
            <button
              type="button"
              disabled={epubPage <= 1}
              onClick={() => showEpubPage(epubPage - 1)}
            >
              ← Previous page
            </button>
            <strong aria-live="polite">
              EPUB page {epubPage} of {epubPageCount}
            </strong>
            <button
              type="button"
              disabled={epubPage >= epubPageCount}
              onClick={() => showEpubPage(epubPage + 1)}
            >
              Next page →
            </button>
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
                    onChange={(event) =>
                      setReviewViewportId(
                        event.target.value as ReviewViewportId,
                      )
                    }
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
                    onChange={(event) =>
                      setReviewOrientation(
                        event.target.value as TargetOrientation,
                      )
                    }
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
                    onChange={(event) =>
                      setReviewFontSizeId(
                        event.target.value as ReviewFontSizeId,
                      )
                    }
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
                    onChange={(event) =>
                      setReviewFontFamilyId(
                        event.target.value as ReviewFontFamilyId,
                      )
                    }
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
          </div>
        </div>
      )}
      {!epub ? (
        <p aria-live="polite">
          {buildingProfileId === profileId
            ? `Building ${screen.label} EPUB locally…`
            : `Preparing ${screen.label} EPUB build…`}
        </p>
      ) : preview?.error ? (
        <p role="alert">Preview unavailable: {preview.error}</p>
      ) : preview?.srcDoc ? (
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
            tabIndex={0}
            onScroll={(event) => {
              if (reviewMode && event.currentTarget.scrollTop !== 0) {
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
              }
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
                  key={`${screen.id}-${epub.sha256}${
                    reviewMode
                      ? `-${reviewViewportId}-${reviewOrientation}-${reviewFontSizeId}-${reviewFontFamilyId}`
                      : ''
                  }`}
                  title={`Generated EPUB rendition on ${screen.label}`}
                  sandbox="allow-same-origin"
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
