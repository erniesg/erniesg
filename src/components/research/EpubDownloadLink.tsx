import { useEffect, useState, type ReactNode } from 'react'
import type { EpubExport } from '@/research/epub'

export default function EpubDownloadLink({
  epub,
  pendingLabel = 'Validating EPUB…',
  children = 'Download EPUB',
}: {
  epub?: EpubExport
  pendingLabel?: string
  children?: ReactNode
}) {
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (!epub) {
      setUrl('')
      return
    }
    const next = URL.createObjectURL(
      new Blob([epub.bytes as BlobPart], { type: epub.mediaType }),
    )
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [epub])

  if (!epub || !url) {
    return <span aria-live="polite">{pendingLabel}</span>
  }

  return (
    <a href={url} download={epub.fileName}>
      {children}
    </a>
  )
}
