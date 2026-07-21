import { describe, expect, it } from 'vitest'
import type { EpubExport } from '../../research/epub'
import { matchingArtifactUrl } from './EpubDownloadLink'

const artifact = (sha256: string): EpubExport => ({
  bytes: new Uint8Array([1]),
  entries: [],
  fileName: 'paper.epub',
  identifier: 'same-identifier',
  mediaType: 'application/epub+zip',
  mode: 'publication',
  sha256,
})

describe('EPUB download link artifact identity', () => {
  it('never exposes a previous blob URL with replacement artifact metadata', () => {
    const previous = artifact('a'.repeat(64))
    const replacement = artifact('b'.repeat(64))
    const prepared = {
      artifactKey: previous.sha256,
      url: 'blob:previous',
    }

    expect(matchingArtifactUrl(prepared, previous)).toBe('blob:previous')
    expect(matchingArtifactUrl(prepared, replacement)).toBe('')
  })
})
