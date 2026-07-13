import { useEffect, useState } from 'react'
import { buildEpub, type EpubExport } from '@/research/epub'
import type { ResearchPaper } from '@/research/schema'
import EpubDownloadLink from './EpubDownloadLink'

export default function ResearchPaperActions({
  paper,
}: {
  paper: ResearchPaper
}) {
  const [epub, setEpub] = useState<EpubExport>()
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setError('')
    setEpub(undefined)
    void buildEpub(paper)
      .then((value) => {
        if (active) setEpub(value)
      })
      .catch((caught) => {
        if (active) {
          setError(
            caught instanceof Error ? caught.message : 'EPUB export failed',
          )
        }
      })
    return () => {
      active = false
    }
  }, [paper])

  return (
    <nav aria-label="Paper downloads">
      <button onClick={() => window.print()}>Print / PDF</button>
      <EpubDownloadLink epub={epub} pendingLabel="Preparing EPUB…" />
      <a href={`/research/${paper.id}/source.json`}>Source JSON</a>
      {error && <small role="alert">{error}</small>}
    </nav>
  )
}
