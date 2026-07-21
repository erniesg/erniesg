import { useEffect, useState, type ReactNode } from 'react'
import type { EpubExport } from '@/research/epub'

type PreparedDownload = { artifactKey: string; url: string }

export function matchingArtifactUrl(
  prepared: PreparedDownload | undefined,
  epub: EpubExport | undefined,
) {
  if (!prepared || !epub || prepared.artifactKey !== epub.sha256) return ''
  return prepared.url
}

export default function EpubDownloadLink({
  epub,
  pendingLabel = 'Validating EPUB…',
  children = 'Download EPUB',
}: {
  epub?: EpubExport
  pendingLabel?: string
  children?: ReactNode
}) {
  const [prepared, setPrepared] = useState<PreparedDownload>()

  useEffect(() => {
    if (!epub) {
      setPrepared(undefined)
      return
    }
    const next = URL.createObjectURL(
      new Blob([epub.bytes as BlobPart], { type: epub.mediaType }),
    )
    setPrepared({ artifactKey: epub.sha256, url: next })
    return () => URL.revokeObjectURL(next)
  }, [epub])

  const url = matchingArtifactUrl(prepared, epub)

  if (!epub || !url) {
    return <span aria-live="polite">{pendingLabel}</span>
  }

  return (
    <a
      href={url}
      download={epub.fileName}
      data-profile-id={epub.profile?.id}
      data-profile-version={epub.profile?.version}
      data-artifact-sha256={epub.sha256}
      data-export-mode={epub.mode}
    >
      {children}
    </a>
  )
}
