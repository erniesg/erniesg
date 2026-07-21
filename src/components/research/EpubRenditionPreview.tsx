import { strFromU8, unzipSync } from 'fflate'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  EPUB_EXPORT_POLICY_VERSION,
  type EpubExport,
} from '../../research/epub'
import { TARGET_PROFILES, type TargetProfileId } from '../../research/targets'

const previewProfileIds = ['mobile', 'paperProMove', 'paperPro'] as const
export type PreviewProfileId = Extract<
  TargetProfileId,
  (typeof previewProfileIds)[number]
>

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
) {
  const profileOrder = [
    selectedProfileId,
    ...previewProfileIds.filter((id) => id !== selectedProfileId),
  ]
  for (const profileId of profileOrder) {
    const profileVersion = TARGET_PROFILES[profileId].version
    const epub = epubs.find(
      (candidate) =>
        candidate.profile?.id === profileId &&
        candidate.profile.version === profileVersion &&
        candidate.profile.exportPolicy?.id === 'profile-tuned-reflowable' &&
        candidate.profile.exportPolicy.version === EPUB_EXPORT_POLICY_VERSION,
    )
    if (epub) return epub
  }
  return undefined
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

export function composePreviewCss(epubCss: string) {
  return `${safeCss(epubCss)}
html { color-scheme: light; background: #fff; }
body { margin: 0; }
.epub-embedded-table { overflow-x: auto; }
img { max-width: 100%; height: auto; }`
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
  | { srcDoc: string; error?: never }
  | { srcDoc?: never; error: string }

type PreparedPreview = {
  srcDoc: string
  revoke: () => void
}

export function epubPreviewArtifactKey(epub: EpubExport) {
  return [
    epub.profile?.id ?? 'unprofiled',
    epub.profile?.version ?? 'unversioned',
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
  onSelectedProfileChange,
  onPreviewReadyChange,
}: {
  epubs: EpubExport[]
  selectedProfileId?: PreviewProfileId
  onSelectedProfileChange?: (profileId: PreviewProfileId) => void
  onPreviewReadyChange?: (artifactKey?: string) => void
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
  const showsRelativeEInkScale = ['paperProMove', 'paperPro'].every((id) =>
    availableScreens.some((screen) => screen.id === id),
  )
  const initialProfileId = availableScreens.some(
    (screen) => screen.id === 'paperPro',
  )
    ? 'paperPro'
    : (availableScreens[0]?.id ?? 'paperPro')
  const [uncontrolledProfileId, setUncontrolledProfileId] =
    useState<PreviewProfileId>(initialProfileId)
  const profileId = selectedProfileId ?? uncontrolledProfileId
  const [, setPreviewRevision] = useState(0)
  const cache = useRef<ReturnType<typeof createEpubPreviewCache> | null>(null)
  if (!cache.current) cache.current = createEpubPreviewCache()
  const epub = selectCurrentProfileEpub(epubs, profileId)
  const screen =
    availableScreens.find((candidate) => candidate.id === epub?.profile?.id) ??
    availableScreens[0] ??
    previewScreens[2]
  const preview = epub ? cache.current.get(epub) : undefined
  const readyArtifactKey =
    epub && preview?.srcDoc ? epubPreviewArtifactKey(epub) : undefined

  useEffect(() => {
    const previews = cache.current
    if (!previews) return
    if (!hasSupportedProfile || !epub) {
      previews.retain([])
      return
    }
    const currentEpubs = epubs.filter(isCurrentPreviewArtifact)
    previews.retain(currentEpubs)
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

  if (!hasSupportedProfile || !epub) {
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
      className="epub-rendition-preview"
      aria-labelledby="epub-preview-heading"
      data-profile-id={epub.profile?.id}
      data-profile-version={epub.profile?.version}
      data-artifact-sha256={epub.sha256}
      data-export-mode={epub.mode}
    >
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
            {availableScreens.map((candidate) => (
              <button
                aria-pressed={candidate.id === screen.id}
                aria-label={`Preview ${candidate.label}, profile ${candidate.id} version ${candidate.version}`}
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
                  {candidate.id}@{candidate.version}
                </small>
              </button>
            ))}
          </div>
          {showsRelativeEInkScale && (
            <p className="epub-device-scale-note">
              Both reMarkable frames use one physical scale. On narrow screens,
              scroll sideways; the frames do not shrink.
            </p>
          )}
        </fieldset>
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
      </div>
      {preview?.error ? (
        <p role="alert">Preview unavailable: {preview.error}</p>
      ) : preview?.srcDoc ? (
        <div
          className="epub-preview-stage"
          role="region"
          aria-label={`Scrollable ${screen.label} EPUB viewport`}
          tabIndex={0}
        >
          <div
            className="epub-preview-device"
            data-device={screen.id}
            style={
              {
                '--epub-device-ratio': `${screen.width} / ${screen.height}`,
                '--epub-device-width': `${screen.previewWidth}px`,
              } as CSSProperties
            }
          >
            <iframe
              key={`${screen.id}-${epub.sha256}`}
              title={`Generated EPUB rendition on ${screen.label}`}
              sandbox=""
              srcDoc={preview.srcDoc}
            />
          </div>
        </div>
      ) : (
        <p aria-live="polite">Preparing EPUB preview…</p>
      )}
    </section>
  )
}
