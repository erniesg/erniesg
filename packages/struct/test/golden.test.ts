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
    const xhtml = renderPublicationXhtml(document)
    expect(sha256(xhtml)).toBe(
      '7925d9d9ce6831aa7579851f7c7ec14e406437a5a7a9741b590a8ecbe2628e95',
    )
    expect(document.receipt.conservation).toMatchObject({
      sourceNodeCount: 2,
      accountedSourceNodeCount: 2,
      sourceAssetCount: 1,
      accountedSourceAssetCount: 1,
      structAssetCount: 1,
    })
    const epub = await buildStructEpub(document)
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
      '7925d9d9ce6831aa7579851f7c7ec14e406437a5a7a9741b590a8ecbe2628e95',
    )
    expect(strFromU8(files['EPUB/struct.json']!)).toContain(
      'golden-struct-fixture',
    )
  })
})
