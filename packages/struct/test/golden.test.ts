import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  buildStructEpub,
  decodeStructDocument,
  encodeStructDocument,
  renderPublicationXhtml,
  structDigest,
  type StructDocument,
} from '../src/index'

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

const GOLDEN_ASSET_BYTES_SHA256 =
  'ff5d8507b6a72bee2debce2c0054798deaccdc5d8a1b945b6280ce8aa9cba52e'
const GOLDEN_TABLE_CONSERVATION_SHA256 =
  '8a9b741052998c6f7f23039a6af62c528589ed14aa777c1af2eba5f6977bf666'
const GOLDEN_STRUCT_JSON_ENTRY_SHA256 =
  '3b274aac8c4486ce6698fc485db5a1e4f6fcfe8c66f69c7e898681e0612e2284'
// XHTML and EPUB hashes changed when table-cell/source-anchor IDs gained
// collision-free derived namespaces; canonical JSON remains unchanged.
const GOLDEN_EPUB_ARCHIVE_SHA256 =
  'de0cf23f4ed6182dc304924a365e7b8e1e9bae0956f22df183ccdceed683a400'

function fixture(): StructDocument {
  const bytes = new Uint8Array([0, 1, 2, 3, 255])
  const evidence = {
    confidence: 1,
    pages: [1],
    boxes: [],
    sourceIds: ['fixture-node'],
  }
  const document: StructDocument = {
    schemaVersion: '0.2.0',
    documentId: 'golden-struct-fixture',
    source: {
      format: 'unknown',
      fileName: 'golden.struct',
      sha256: 'a'.repeat(64),
      byteLength: bytes.byteLength,
      pageCount: 1,
      localOnly: true,
    },
    metadata: {
      title: 'Golden STRUCT fixture',
      subtitle: '',
      authors: ['Ada Example'],
      abstract: '',
      updated: '1970-01-01',
    },
    blocks: [
      {
        id: 'paragraph-1',
        kind: 'paragraph',
        text: 'Hello STRUCT',
        page: 1,
        order: 0,
        column: 'single',
        inline: [],
        evidence,
      },
      {
        id: 'table-1',
        kind: 'table',
        text: 'A B',
        page: 1,
        order: 1,
        column: 'single',
        inline: [],
        evidence,
        table: {
          rows: 1,
          columns: 2,
          semantic: 'verified',
          cells: [
            {
              id: 'cell-a',
              text: 'A',
              row: 0,
              column: 0,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: 'column',
              inline: [],
              evidence,
            },
            {
              id: 'cell-b',
              text: 'B',
              row: 0,
              column: 1,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: null,
              inline: [],
              evidence,
            },
          ],
        },
      },
    ],
    assets: [
      {
        id: 'asset-1',
        kind: 'figure',
        href: 'assets/asset-1.bin',
        mediaType: 'application/octet-stream',
        sha256: sha256(bytes),
        width: 1,
        height: 1,
        bytes,
        sourceObjectIds: ['fixture-asset'],
        evidence,
        fallback: 'asset',
      },
    ],
    relationships: [
      {
        id: 'relationship-1',
        kind: 'figure',
        from: 'paragraph-1',
        to: ['asset-1'],
        status: 'matched',
        confidence: 1,
        evidence,
      },
    ],
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        blocks: ['paragraph-1', 'table-1'],
        columns: [
          {
            id: 'page-1-single',
            side: 'single',
            blockIds: ['paragraph-1', 'table-1'],
          },
        ],
      },
    ],
    diagnostics: [],
    recovery: {
      status: 'ready',
      title: 'Ready',
      summary: 'Ready',
      issues: [],
    },
    receipt: {
      schemaVersion: '0.2.0',
      documentId: 'golden-struct-fixture',
      sourceSha256: 'a'.repeat(64),
      blockCount: 2,
      assetCount: 1,
      relationshipCount: 1,
      diagnosticCount: 0,
      textCharacterCount: 15,
      conservation: {
        sourceNodeCount: 2,
        accountedSourceNodeCount: 2,
        sourceRegionCount: 0,
        accountedSourceRegionCount: 0,
        sourceAnnotationCount: 0,
        accountedSourceAnnotationCount: 0,
        sourceAssetCount: 1,
        accountedSourceAssetCount: 1,
        sourceRelationshipCount: 1,
        accountedSourceRelationshipCount: 1,
        sourceDiagnosticCount: 0,
        accountedSourceDiagnosticCount: 0,
        sourceTextCharacterCount: 15,
        structBlockCount: 2,
        structAssetCount: 1,
        structRelationshipCount: 1,
        structDiagnosticCount: 0,
        structTextCharacterCount: 15,
      },
      generatedSha256: '',
    },
  }
  const { receipt, ...withoutReceipt } = document
  receipt.generatedSha256 = structDigest({
    ...withoutReceipt,
    conservation: receipt.conservation,
    assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
  })
  return document
}

describe('STRUCT package golden contract', () => {
  it('keeps canonical JSON and the source-bound receipt stable', () => {
    const document = fixture()
    const encoded = encodeStructDocument(document)
    expect(sha256(JSON.stringify(encoded))).toBe(
      'cbd5600b13cb036277cb848bce700a4f37962854614f5788398946f17ba82468',
    )
    expect(document.receipt.generatedSha256).toBe(
      'e03b502d665d803b01c813264ea6c5f20a1223df0dc5532118d2d53a6a7df7f8',
    )
    expect(decodeStructDocument(encoded)).toEqual(document)
  })

  it('keeps XHTML, EPUB entries, and table conservation stable', async () => {
    const document = fixture()
    const assetBytes = document.assets[0]!.bytes
    expect(sha256(assetBytes)).toBe(GOLDEN_ASSET_BYTES_SHA256)
    const table = document.blocks.find((block) => block.kind === 'table')!.table
    expect(
      sha256(
        JSON.stringify({
          table,
          conservation: document.receipt.conservation,
        }),
      ),
    ).toBe(GOLDEN_TABLE_CONSERVATION_SHA256)
    const xhtml = renderPublicationXhtml(document)
    expect(sha256(xhtml)).toBe(
      '154d88f7e78b2f215bb38fdbe2d7e3143690c12d252daf13659053d7d64b19c2',
    )
    expect(document.receipt.conservation).toMatchObject({
      sourceNodeCount: 2,
      accountedSourceNodeCount: 2,
      sourceAssetCount: 1,
      accountedSourceAssetCount: 1,
      structAssetCount: 1,
    })
    const epub = await buildStructEpub(document)
    expect(sha256(epub.bytes)).toBe(GOLDEN_EPUB_ARCHIVE_SHA256)
    expect(epub.entries).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'EPUB/package.opf',
      'EPUB/nav.xhtml',
      'EPUB/content.xhtml',
      'EPUB/styles.css',
      'EPUB/struct.json',
      'EPUB/assets/asset-1.bin',
    ])
    const files = unzipSync(epub.bytes)
    expect(sha256(files['EPUB/content.xhtml']!)).toBe(
      '154d88f7e78b2f215bb38fdbe2d7e3143690c12d252daf13659053d7d64b19c2',
    )
    expect(sha256(files['EPUB/struct.json']!)).toBe(
      GOLDEN_STRUCT_JSON_ENTRY_SHA256,
    )
    expect(strFromU8(files['EPUB/struct.json']!)).toContain(
      'golden-struct-fixture',
    )
  })
})
