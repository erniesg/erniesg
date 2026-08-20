import { describe, expect, it } from 'vitest'

const expected = {
  '.': [
    'STRUCT_SCHEMA_VERSION',
    'decodeStructDocument',
    'encodeStructDocument',
    'migrateStructDocument',
    'structId',
    'structDigest',
    'legacyStructDigest',
    'legacyStructDigests',
    'legacyStructDigestMatches',
    'orderBlocksByLayout',
    'pageLayoutsFromBlocks',
    'diagnosticCopy',
    'hasActionableRecovery',
    'recoverySummary',
    'renderPublicationXhtml',
    'buildStructEpub',
  ],
  './core': [
    'STRUCT_SCHEMA_VERSION',
    'decodeStructDocument',
    'encodeStructDocument',
    'migrateStructDocument',
    'orderBlocksByLayout',
    'pageLayoutsFromBlocks',
  ],
  './schema': ['STRUCT_SCHEMA_VERSION', 'LEGACY_STRUCT_SCHEMA_VERSION'],
  './ids': [
    'structId',
    'structDigest',
    'legacyStructDigest',
    'legacyStructDigests',
    'legacyStructDigestMatches',
  ],
  './recovery': ['diagnosticCopy', 'hasActionableRecovery', 'recoverySummary'],
  './renderers/xhtml': ['renderPublicationXhtml'],
  './renderers/epub': ['buildStructEpub'],
} as const

const forbidden = [
  'buildStructDocument',
  'fromReconstruction',
  'PublicationGraph',
  'Astro',
  'PdfReconstruction',
  'ModelFallbackReceipt',
  'ModelConsultationClient',
]

describe('STRUCT package boundary', () => {
  for (const [subpath, names] of Object.entries(expected)) {
    it(`exports the reviewed ${subpath} surface`, async () => {
      const module = await import(
        subpath === '.' ? '../src/index' : `../src/${subpath.slice(2)}`
      )
      for (const name of names) expect(name in module).toBe(true)
      for (const name of forbidden) expect(name in module).toBe(false)
    })
  }
})
