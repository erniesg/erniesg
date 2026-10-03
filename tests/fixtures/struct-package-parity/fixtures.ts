import { seal, validDocument } from '../../../src/struct/codec-test-fixtures'
import type { StructDocument } from '@erniesg/struct/document'

type FixtureDocument = StructDocument

function currentDocument(documentId: string): FixtureDocument {
  const document = validDocument() as unknown as FixtureDocument
  document.schemaVersion = '0.2.0'
  document.documentId = documentId
  document.receipt.schemaVersion = '0.2.0'
  document.receipt.documentId = documentId
  return seal(document)
}

export const structPackageParityFixtures = {
  legacy: validDocument() as unknown as FixtureDocument,
  current: currentDocument('fixture-current'),
  recoverable: (() => {
    const document = currentDocument('fixture-recoverable')
    document.diagnostics[0]!.severity = 'warning'
    document.recovery = {
      status: 'review-required',
      title: 'Review required',
      summary: 'One source relationship needs review',
      issues: [
        {
          category: 'links',
          title: 'Unresolved reference',
          count: 1,
          pages: [1],
          action: 'Review source',
        },
      ],
      userAction: 'Review source',
    }
    return seal(document)
  })(),
} as const

export const structPackageParityOrdering = [
  {
    ...validDocument().blocks[0],
    id: 'block-right',
    order: 3,
    column: 'right' as const,
    evidence: {
      ...validDocument().blocks[0].evidence,
      boxes: [{ page: 1, x: 320, y: 5, width: 10, height: 10, rotation: 0 }],
    },
  },
  {
    ...validDocument().blocks[0],
    id: 'block-left-later',
    order: 2,
    column: 'left' as const,
    evidence: {
      ...validDocument().blocks[0].evidence,
      boxes: [{ page: 1, x: 10, y: 20, width: 10, height: 10, rotation: 0 }],
    },
  },
  {
    ...validDocument().blocks[0],
    id: 'block-left-first',
    order: 1,
    column: 'left' as const,
    evidence: {
      ...validDocument().blocks[0].evidence,
      boxes: [{ page: 1, x: 10, y: 10, width: 10, height: 10, rotation: 0 }],
    },
  },
] as const

export const validConsultationReceipt = {
  schemaVersion: '1.0.0',
  documentId: 'fixture-current',
  sourceSha256: 'a'.repeat(64),
  consultations: [],
  decisions: [],
  metrics: {},
} as const

/**
 * Frozen against Ernie.SG local Struct at 0e37f441 and the packed Struct
 * artifact built from 10116f. The canonical digest is SHA-256 of the public
 * package's JSON-safe encoded document, not its semantic receipt digest.
 */
export const frozenStructPackageParity = {
  documents: {
    legacy: {
      canonicalJsonSha256:
        '75a565ac9e3c640e1221a479b5ef9b6cb4fa8bd7d1f829f05e4135f9f7c531fd',
      receiptSha256:
        '96ccaab653062d7cdc7578c3d6d7f851bba7f7e617dadef84af850c48d26c946',
    },
    current: {
      canonicalJsonSha256:
        'fbf4510c077b5f123ec877ebb6858c925a1d8b66997b1e416e6b380aacf12313',
      receiptSha256:
        'ad2c54c9f6d41fd80924ee17c16ee8b060f7c91ee329b76f7e16f4e2b56288ad',
    },
    recoverable: {
      canonicalJsonSha256:
        '7b33d6abfc7678219399514ff363824332e3737e85df489384ffa20cddeef7a9',
      receiptSha256:
        '3cd71c8620aff9ee935ea481b603c7e12e3739d1ec59428c17ce9060a95b258e',
    },
  },
  identity: {
    digest: 'd548771247f9a8fd3cee953dc265b28901cb1b9af33342222d7c3c267070990e',
    id: 'struct-fixture-cd42404d52ad55ccfa9aca4a',
  },
  ordering: ['block-left-first', 'block-left-later', 'block-right'],
} as const
