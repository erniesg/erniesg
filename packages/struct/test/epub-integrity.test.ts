import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildStructEpub } from '../src/renderers/epub'
import {
  characterizationDocument,
  resealDocument,
} from './characterization-fixtures'

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('STRUCT package EPUB integrity contract', () => {
  it('reopens a deterministic EPUB and retains its packaged XHTML/STRUCT entries', async () => {
    const document = characterizationDocument('0.2.0')
    const exported = await buildStructEpub(document)
    const files = unzipSync(exported.bytes)

    expect(exported.entries).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'EPUB/package.opf',
      'EPUB/nav.xhtml',
      'EPUB/content.xhtml',
      'EPUB/styles.css',
      'EPUB/struct.json',
    ])
    expect(strFromU8(files['mimetype']!)).toBe('application/epub+zip')
    expect(strFromU8(files['EPUB/content.xhtml']!)).toContain('Fixture text')
    expect(strFromU8(files['EPUB/struct.json']!)).toContain('characterization')
    expect(exported.sha256).toBe(sha256(exported.bytes))
  })

  it('rejects an asset href that escapes the EPUB package', async () => {
    const document = characterizationDocument('0.2.0') as any
    const bytes = new Uint8Array([1, 2, 3])
    document.assets = [
      {
        id: 'fixture-asset',
        kind: 'figure',
        href: '../escape.bin',
        mediaType: 'application/octet-stream',
        sha256: sha256(bytes),
        width: 1,
        height: 1,
        bytes,
        sourceObjectIds: ['source-asset'],
        evidence: document.blocks[0].evidence,
        fallback: 'asset',
      },
    ]
    document.receipt.assetCount = 1
    document.receipt.conservation.sourceAssetCount = 1
    document.receipt.conservation.accountedSourceAssetCount = 1
    document.receipt.conservation.structAssetCount = 1
    resealDocument(document)

    await expect(buildStructEpub(document)).rejects.toThrow(/unsafe/i)
  })
})
