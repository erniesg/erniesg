import { describe, expect, it } from 'vitest'
import {
  decodeStructDocument,
  encodeStructDocument,
  migrateStructDocument,
} from '../src/core'
import { characterizationDocument } from './characterization-fixtures'

describe('STRUCT package codec and migration contract', () => {
  it.each(['0.1.0', '0.2.0'] as const)(
    'round-trips the declared %s document through JSON-safe codec imports',
    (schemaVersion) => {
      const document = characterizationDocument(schemaVersion)
      const encoded = encodeStructDocument(document)
      expect(encoded.assets).toEqual([])
      expect(decodeStructDocument(encoded)).toEqual(document)
    },
  )

  it('keeps the 0.1.0 to 0.2.0 migration boundary explicit', () => {
    const legacy = characterizationDocument('0.1.0')
    const current = characterizationDocument('0.2.0')

    expect(migrateStructDocument(legacy)).toMatchObject({
      schemaVersion: '0.1.0',
    })
    expect(migrateStructDocument(legacy)).not.toHaveProperty('documentId')
    expect(migrateStructDocument(current)).toMatchObject({
      schemaVersion: '0.2.0',
      documentId: 'characterization',
      receipt: { documentId: 'characterization' },
    })
  })

  it('rejects an unsupported schema instead of coercing it', () => {
    const unsupported = characterizationDocument('0.2.0') as unknown as Record<
      string,
      unknown
    >
    unsupported.schemaVersion = '0.3.0'
    expect(() => decodeStructDocument(unsupported)).toThrow(/schema version/i)
  })
})
