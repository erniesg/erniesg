import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  decodeCompatibleStructDocument as packageDecodeCompatible,
  decodeStructDocument as packageDecode,
  encodeStructDocument as packageEncode,
} from '@erniesg/struct/document'
import {
  structDigest as packageDigest,
  structId as packageId,
} from '@erniesg/struct/identity'
import {
  orderBlocksByLayout as packageOrderBlocks,
  pageLayoutsFromBlocks as packagePageLayouts,
} from '@erniesg/struct/ordering'
import {
  structReceiptDigest as packageReceiptDigest,
  validateStructConsultationReceipt as packageValidateReceipt,
  verifyStructReceipt as packageVerifyReceipt,
} from '@erniesg/struct/receipt'
import {
  decodeStructDocument as localDecode,
  encodeStructDocument as localEncode,
  migrateStructDocument as localDecodeCompatible,
} from '../src/struct'
import {
  legacyStructDigest,
  structDigest as localDigest,
  structId as localId,
} from '../src/struct/ids'
import {
  orderBlocksByLayout as localOrderBlocks,
  pageLayoutsFromBlocks as localPageLayouts,
} from '../src/struct/reading-order'
import { validateStructConsultationReceipt as localValidateReceipt } from '../src/struct/consultation-receipt'
import {
  structPackageParityFixtures,
  structPackageParityOrdering,
  frozenStructPackageParity,
  validConsultationReceipt,
} from './fixtures/struct-package-parity/fixtures'

const execFileAsync = promisify(execFile)

function localReceiptInput(document: Record<string, any>) {
  const { receipt: _receipt, ...withoutReceipt } = document
  return {
    ...withoutReceipt,
    conservation: document.receipt.conservation,
    assets: document.assets.map(({ bytes: _bytes, ...asset }: any) => asset),
  }
}

describe('packed Struct public API parity', () => {
  it.each(Object.entries(structPackageParityFixtures))(
    'matches the local baseline for the frozen %s document',
    (name, fixture) => {
      const local = localDecode(fixture)
      const packaged = packageDecode(fixture)
      const frozen =
        frozenStructPackageParity.documents[
          name as keyof typeof frozenStructPackageParity.documents
        ]

      expect(packageEncode(packaged)).toEqual(localEncode(local))
      expect(
        createHash('sha256')
          .update(JSON.stringify(packageEncode(packaged)))
          .digest('hex'),
      ).toBe(frozen.canonicalJsonSha256)
      // A 0.1.0 receipt digest is recomputed with the host's collation, so on
      // other locales it is compared with the local implementation on the
      // same host; the stored digest stays frozen (sealed with 'en').
      expect(packageReceiptDigest(packaged)).toBe(
        name === 'legacy'
          ? legacyStructDigest(localReceiptInput(fixture))
          : frozen.receiptSha256,
      )
      expect(local.receipt.generatedSha256).toBe(frozen.receiptSha256)
      expect(packageVerifyReceipt(packaged)).toBe(true)
      expect(packageDecodeCompatible(fixture)).toEqual(
        localDecodeCompatible(fixture),
      )
    },
  )

  it('keeps frozen identity and deterministic ordering outputs aligned', () => {
    const value = { z: 1, a: ['value'] }
    expect(packageDigest(value)).toBe(localDigest(value))
    expect(packageId('fixture', 'value')).toBe(localId('fixture', 'value'))
    expect(packageDigest(value)).toBe(frozenStructPackageParity.identity.digest)
    expect(packageId('fixture', 'value')).toBe(
      frozenStructPackageParity.identity.id,
    )

    const localOrdered = localOrderBlocks(structPackageParityOrdering as any)
    const packagedOrdered = packageOrderBlocks(
      structPackageParityOrdering as any,
    )
    expect(packagedOrdered.map((block) => block.id)).toEqual(
      localOrdered.map((block) => block.id),
    )
    expect(packagedOrdered.map((block) => block.id)).toEqual(
      frozenStructPackageParity.ordering,
    )
    expect(
      packagePageLayouts(
        [{ page: 1, width: 600, height: 800, rotation: 0 }],
        packagedOrdered,
      ),
    ).toEqual(
      localPageLayouts(
        [{ page: 1, width: 600, height: 800, rotation: 0 }],
        localOrdered,
      ),
    )
  })

  it('rejects unsupported versions, altered receipts, and secret-shaped receipt input', () => {
    const unsupported = structuredClone(structPackageParityFixtures.current)
    unsupported.schemaVersion = '9.9.9' as any
    expect(() => packageDecode(unsupported)).toThrow()
    expect(() => localDecode(unsupported)).toThrow()

    const tampered = structuredClone(structPackageParityFixtures.current)
    tampered.receipt.generatedSha256 = 'b'.repeat(64)
    expect(() => packageDecode(tampered)).toThrow()
    expect(() => localDecode(tampered)).toThrow()

    expect(packageValidateReceipt(validConsultationReceipt)).toBe(true)
    expect(localValidateReceipt(validConsultationReceipt)).toBe(true)

    const secretBearing = {
      ...validConsultationReceipt,
      metrics: { apiToken: 'not-a-real-secret' },
    }
    expect(packageValidateReceipt(secretBearing)).toBe(
      localValidateReceipt(secretBearing),
    )
    expect(packageValidateReceipt(secretBearing)).toBe(false)
  })

  it('retains a locale-specific legacy digest through compatibility decode', () => {
    const legacy = structuredClone(structPackageParityFixtures.legacy)
    legacy.receipt.generatedSha256 = legacyStructDigest(
      localReceiptInput(legacy),
      'en',
    )

    expect(packageDecodeCompatible(legacy)).toEqual(
      localDecodeCompatible(legacy),
    )
  })

  it.each(['core', 'schema', 'ids', 'bundle'])(
    'keeps the unavailable public ./%s path closed',
    async (path) => {
      await expect(
        execFileAsync(process.execPath, [
          '--input-type=module',
          '-e',
          `import('@erniesg/struct/${path}')`,
        ]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('ERR_PACKAGE_PATH_NOT_EXPORTED'),
      })
    },
  )
})
