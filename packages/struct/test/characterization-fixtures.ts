import { legacyStructDigest, structDigest } from '../src/ids'
import type { StructDocument, StructSchemaVersion } from '../src/schema'

const SOURCE_SHA256 = 'b'.repeat(64)

export function characterizationDocument(
  schemaVersion: StructSchemaVersion,
): StructDocument {
  const document = {
    schemaVersion,
    ...(schemaVersion === '0.2.0' ? { documentId: 'characterization' } : {}),
    source: {
      format: 'unknown' as const,
      fileName: 'characterization.struct',
      sha256: SOURCE_SHA256,
      byteLength: 12,
      pageCount: 1,
      localOnly: true,
    },
    metadata: {
      title: 'Characterization fixture',
      subtitle: '',
      authors: ['Fixture Author'],
      abstract: '',
      updated: '2026-08-20',
    },
    blocks: [
      {
        id: 'fixture-block',
        kind: 'paragraph' as const,
        text: 'Fixture text',
        page: 1,
        order: 0,
        column: 'single' as const,
        inline: [],
        evidence: {
          confidence: 1,
          pages: [1],
          boxes: [],
          sourceIds: ['source-node'],
        },
      },
    ],
    assets: [],
    relationships: [],
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0 as const,
        blocks: ['fixture-block'],
        columns: [
          {
            id: 'fixture-column',
            side: 'single' as const,
            blockIds: ['fixture-block'],
          },
        ],
      },
    ],
    diagnostics: [],
    recovery: {
      status: 'ready' as const,
      title: 'Ready',
      summary: 'Ready',
      issues: [],
    },
    receipt: {
      schemaVersion,
      ...(schemaVersion === '0.2.0' ? { documentId: 'characterization' } : {}),
      sourceSha256: SOURCE_SHA256,
      blockCount: 1,
      assetCount: 0,
      relationshipCount: 0,
      diagnosticCount: 0,
      textCharacterCount: 12,
      conservation: {
        sourceNodeCount: 1,
        accountedSourceNodeCount: 1,
        sourceRegionCount: 0,
        accountedSourceRegionCount: 0,
        sourceAnnotationCount: 0,
        accountedSourceAnnotationCount: 0,
        sourceAssetCount: 0,
        accountedSourceAssetCount: 0,
        sourceRelationshipCount: 0,
        accountedSourceRelationshipCount: 0,
        sourceDiagnosticCount: 0,
        accountedSourceDiagnosticCount: 0,
        sourceTextCharacterCount: 12,
        structBlockCount: 1,
        structAssetCount: 0,
        structRelationshipCount: 0,
        structDiagnosticCount: 0,
        structTextCharacterCount: 12,
      },
      generatedSha256: '',
    },
  } as StructDocument
  return resealDocument(document)
}

export function resealDocument(document: StructDocument) {
  const { receipt, ...withoutReceipt } = document
  receipt.generatedSha256 =
    document.schemaVersion === '0.1.0'
      ? legacyStructDigest({
          ...withoutReceipt,
          conservation: receipt.conservation,
          assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
        })
      : structDigest({
          ...withoutReceipt,
          conservation: receipt.conservation,
          assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
        })
  return document
}
