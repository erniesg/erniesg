import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { loadAdapterCase } from '../../tests/fixtures/struct-adapter-parity/cases'
import {
  decodeStructDocument,
  encodeStructDocument,
  type StructDocument,
} from '@erniesg/struct/document'
import { structReceiptDigest } from '@erniesg/struct/receipt'
import { structDigest } from '@erniesg/struct/identity'
import { encodeStructBundle } from '@erniesg/struct/bundle'
import { buildStructDocument } from '../struct-adapters'
import { structCutoverSourceBindingSchema } from './source-binding'
import { readStructPackagePin } from './struct-package-pin'
import {
  createStructBundleForDocument,
  structBundleDescriptor,
  structBundleSha256,
  structBundleWire,
  structCutoverSourceBinding,
  structCutoverSourceBindingSync,
  structDocumentSha256,
  structSemanticReceiptSha256,
} from './struct-source-binding'

// The pinned package refuses to encode a document whose semantic receipt does
// not verify, so the "receipt did not verify" branch of the binding builder
// is unreachable with a real document. The verification decision is therefore
// the only part of the package this file overrides.
const receiptVerification = vi.hoisted(() => ({
  override: undefined as undefined | (() => boolean),
}))

vi.mock('@erniesg/struct/receipt', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@erniesg/struct/receipt')>()
  return {
    ...actual,
    verifyStructReceipt: (
      document: Parameters<typeof actual.verifyStructReceipt>[0],
    ) =>
      receiptVerification.override
        ? receiptVerification.override()
        : actual.verifyStructReceipt(document),
  }
})

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

async function realDocument() {
  return buildStructDocument(await loadAdapterCase('ordinary-pdf'))
}

describe('Struct source binding digests', () => {
  it('derives the document digest from the canonical document bytes', async () => {
    const document = await realDocument()
    const digest = structDocumentSha256(document)
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(digest).toBe(structDigest(encodeStructDocument(document)))
    expect(structDocumentSha256(document)).toBe(digest)
  })

  it('agrees with the package bundle handle about both digests', async () => {
    const document = await realDocument()
    const bundle = createStructBundleForDocument(document)
    expect(structDocumentSha256(document)).toBe(bundle.documentSha256)
    expect(structBundleSha256(bundle)).toBe(bundle.bundleSha256)
    expect(structBundleSha256(bundle)).toBe(sha256(encodeStructBundle(bundle)))
  })

  it('uses the package semantic receipt digest', async () => {
    const document = await realDocument()
    expect(structSemanticReceiptSha256(document)).toBe(
      structReceiptDigest(document),
    )
  })

  it('omits the bundle digest when the bundle bytes were not produced', async () => {
    const document = await realDocument()
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = await structCutoverSourceBinding(document, pin)
    expect('bundleSha256' in binding).toBe(false)
    expect(binding.documentSha256).toBe(structDocumentSha256(document))
  })

  it('carries the bundle digest when the bundle bytes were produced', async () => {
    const document = await realDocument()
    const pin = await readStructPackagePin(repositoryRoot)
    const bundle = createStructBundleForDocument(document)
    const binding = await structCutoverSourceBinding(document, pin, bundle)
    expect(binding.bundleSha256).toBe(structBundleSha256(bundle))
    expect(structCutoverSourceBindingSync(document, pin, bundle)).toEqual(
      binding,
    )
  })

  it('omits the semantic receipt digest when the receipt does not verify', async () => {
    const document = await realDocument()
    const pin = await readStructPackagePin(repositoryRoot)
    receiptVerification.override = () => false
    try {
      const binding = structCutoverSourceBindingSync(document, pin)
      expect('semanticReceiptSha256' in binding).toBe(false)
    } finally {
      receiptVerification.override = undefined
    }
  })

  it('carries the semantic receipt digest when the receipt verifies', async () => {
    const document = await realDocument()
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = structCutoverSourceBindingSync(document, pin)
    expect(binding.semanticReceiptSha256).toBe(
      structSemanticReceiptSha256(document),
    )
  })

  it('derives a different document digest for a different document', async () => {
    const ordinary = await realDocument()
    const structured = buildStructDocument(
      await loadAdapterCase('structured-docx'),
    )
    expect(structDocumentSha256(structured)).not.toBe(
      structDocumentSha256(ordinary),
    )
  })

  it('maps the package pin fields exactly', async () => {
    const document = await realDocument()
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = await structCutoverSourceBinding(document, pin)
    expect(binding.packageSourceCommit).toBe(pin.sourceCommit)
    expect(binding.packageArtifact).toBe(pin.artifact)
    expect(binding.packageArtifactSha256).toBe(pin.artifactSha256)
    expect(binding.packageIntegrity).toBe(pin.integrity)
    expect(binding.packageVersion).toBe(pin.packageVersion)
    expect(binding.kind).toBe('struct-cutover')
    expect(structCutoverSourceBindingSchema.parse(binding)).toEqual(binding)
  })

  it('describes the bundle with the asset digests and no asset bytes', async () => {
    const document = buildStructDocument(
      await loadAdapterCase('structured-docx'),
    )
    const bundle = createStructBundleForDocument(document)
    const descriptor = structBundleDescriptor(document, bundle)
    expect(descriptor.bundleVersion).toBe('1.0.0')
    expect(descriptor.schemaVersion).toBe(document.schemaVersion)
    expect(descriptor.documentSha256).toBe(structDocumentSha256(document))
    expect(descriptor.bundleSha256).toBe(structBundleSha256(bundle))
    expect(descriptor.assets.map((asset) => asset.id)).toEqual(
      document.assets.map((asset) => asset.id),
    )
    expect(
      descriptor.assets.every(
        (asset) => asset.sha256.length === 64 && asset.byteLength > 0,
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The three pilot documents of the bundle wire.
//
// The pilots are built here, not frozen: every value in them is computed, so
// the suite never depends on a checked-in golden that could drift away from
// the pinned package. Each pilot is a document the pinned package itself
// accepts (its own decoder validates it), so the helper is exercised against
// real documents and not against hand-written shapes.
// ---------------------------------------------------------------------------

const pilotEvidence = {
  confidence: 1,
  pages: [],
  boxes: [],
  sourceIds: ['pilot-source'],
} as const

type PilotBlock = {
  id: string
  kind: 'heading' | 'paragraph' | 'table'
  text: string
  inline?: { start: number; end: number; code?: boolean }[]
  attributes?: Record<string, string | number | boolean>
  table?: {
    rows: number
    columns: number
    cells: {
      id: string
      text: string
      row: number
      column: number
      rowSpan: number
      columnSpan: number
      headerScope: 'column' | 'row' | 'colgroup' | 'rowgroup' | null
    }[]
    semantic: 'verified'
  }
}

/**
 * Build one pilot document with a receipt the pinned package accepts.
 *
 * The receipt is computed from the document itself - the block text count and
 * the canonical digest of the byte-free semantic input - so the pilots carry
 * a verifiable semantic receipt without any hand-written digest.
 */
function pilotDocument(spec: {
  id: string
  blocks: PilotBlock[]
  assets?: {
    id: string
    bytes: Uint8Array
    href: string
    mediaType: string
    width: number
    height: number
  }[]
}): StructDocument {
  const blocks = spec.blocks.map((block, order) => ({
    ...block,
    ...(block.table
      ? {
          table: {
            ...block.table,
            cells: block.table.cells.map((cell) => ({
              ...cell,
              inline: [],
              evidence: pilotEvidence,
            })),
          },
        }
      : {}),
    page: null,
    order,
    column: 'single' as const,
    inline: block.inline ?? [],
    evidence: pilotEvidence,
  }))
  const assets = (spec.assets ?? []).map((asset) => ({
    id: asset.id,
    kind: 'figure' as const,
    href: asset.href,
    mediaType: asset.mediaType,
    sha256: sha256(asset.bytes),
    width: asset.width,
    height: asset.height,
    bytes: asset.bytes,
    sourceObjectIds: ['pilot-source'],
    evidence: pilotEvidence,
    fallback: 'asset' as const,
  }))
  const source = {
    format: 'pdf' as const,
    fileName: 'pilot.pdf',
    sha256: 'a'.repeat(64),
    byteLength: 3,
    pageCount: 1,
    localOnly: true,
  }
  const textCharacterCount = blocks.reduce(
    (count, block) => count + block.text.length,
    0,
  )
  const conservation = {
    sourceNodeCount: blocks.length,
    accountedSourceNodeCount: blocks.length,
    sourceRegionCount: 0,
    accountedSourceRegionCount: 0,
    sourceAnnotationCount: 0,
    accountedSourceAnnotationCount: 0,
    sourceAssetCount: assets.length,
    accountedSourceAssetCount: assets.length,
    sourceRelationshipCount: 0,
    accountedSourceRelationshipCount: 0,
    sourceDiagnosticCount: 0,
    accountedSourceDiagnosticCount: 0,
    sourceTextCharacterCount: textCharacterCount,
    structBlockCount: blocks.length,
    structAssetCount: assets.length,
    structRelationshipCount: 0,
    structDiagnosticCount: 0,
    structTextCharacterCount: textCharacterCount,
  }
  const withoutReceipt = {
    schemaVersion: '0.2.0' as const,
    documentId: spec.id,
    source,
    metadata: {
      title: 'Pilot document',
      subtitle: 'A bundle wire pilot',
      authors: ['Ada Example'],
      abstract: 'A bundle wire pilot document.',
      language: 'en',
      baseDirection: 'ltr' as const,
    },
    blocks,
    assets,
    relationships: [],
    pages: [],
    diagnostics: [],
    recovery: {
      status: 'ready' as const,
      title: 'The pilot document is complete.',
      summary: 'The pilot document carries no unresolved content.',
      issues: [],
    },
  }
  const generatedSha256 = structDigest({
    ...withoutReceipt,
    conservation,
    assets: assets.map(({ bytes: _bytes, ...asset }) => asset),
  })
  const document = {
    ...withoutReceipt,
    receipt: {
      schemaVersion: '0.2.0' as const,
      documentId: spec.id,
      sourceSha256: source.sha256,
      blockCount: blocks.length,
      assetCount: assets.length,
      relationshipCount: 0,
      diagnosticCount: 0,
      textCharacterCount,
      conservation,
      generatedSha256,
    },
  }
  // The pinned package's own decoder is the authority: a pilot the package
  // cannot decode is a broken fixture, not a helper failure.
  return decodeStructDocument(document as never)
}

const pilotAssetBytes = new Uint8Array([1, 2, 3, 4, 5])

/** The baseline pilot: prose only, no assets. */
function baselinePilot() {
  return pilotDocument({
    id: 'pilot-baseline',
    blocks: [
      { id: 'pilot-baseline-heading', kind: 'heading', text: 'Pilot heading' },
      {
        id: 'pilot-baseline-paragraph',
        kind: 'paragraph',
        text: 'A baseline paragraph of pilot prose.',
      },
    ],
  })
}

/** The inline-code pilot: an inline code span and one asset with bytes. */
function inlineCodePilot() {
  return pilotDocument({
    id: 'pilot-inline-code',
    blocks: [
      {
        id: 'pilot-inline-code-paragraph',
        kind: 'paragraph',
        text: 'Call the fn() now.',
        inline: [{ start: 9, end: 14, code: true }],
      },
    ],
    assets: [
      {
        id: 'pilot-inline-code-asset',
        bytes: pilotAssetBytes,
        href: 'assets/pilot.png',
        mediaType: 'image/png',
        width: 2,
        height: 2,
      },
    ],
  })
}

/** The table/anchor pilot: a heading anchor, a table and a cross reference. */
function tableAnchorPilot() {
  return pilotDocument({
    id: 'pilot-table-anchor',
    blocks: [
      {
        id: 'pilot-table-anchor-heading',
        kind: 'heading',
        text: 'Pilot anchor target',
        attributes: { level: 2 },
      },
      {
        id: 'pilot-table-anchor-table',
        kind: 'table',
        text: '',
        table: {
          rows: 1,
          columns: 2,
          cells: [
            {
              id: 'pilot-table-anchor-cell-0',
              text: 'Header',
              row: 0,
              column: 0,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: 'column',
            },
            {
              id: 'pilot-table-anchor-cell-1',
              text: 'Value',
              row: 0,
              column: 1,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: 'column',
            },
          ],
          semantic: 'verified',
        },
      },
    ],
  })
}

const pilots = [
  { name: 'baseline', build: baselinePilot },
  { name: 'inline code and asset', build: inlineCodePilot },
  { name: 'table and anchor', build: tableAnchorPilot },
] as const

describe('Struct bundle wire', () => {
  it.each(pilots)(
    'returns the exact encoded bytes and the digests that bind them ($name)',
    ({ build }) => {
      const document = build()
      const wire = structBundleWire(document)
      const handle = createStructBundleForDocument(document)

      expect(wire.bytes).toBeInstanceOf(Uint8Array)
      expect(wire.bytes.length).toBeGreaterThan(0)
      expect(sha256(wire.bytes)).toBe(wire.bundleSha256)
      expect(wire.bundleSha256).toBe(handle.bundleSha256)
      expect(wire.documentSha256).toBe(structDocumentSha256(document))
      expect(wire.semanticReceiptSha256).toBe(structReceiptDigest(document))
      expect(wire.semanticReceiptSha256).toMatch(/^[a-f0-9]{64}$/)

      // The descriptor is the persisted shape and is unchanged by the wire.
      expect(wire.descriptor).toEqual(
        structBundleDescriptor(document, handle),
      )
      expect(wire.descriptor.bundleSha256).toBe(wire.bundleSha256)
      expect(wire.descriptor.documentSha256).toBe(wire.documentSha256)
    },
  )

  it.each(pilots)(
    'encodes the same bytes on every call ($name)',
    ({ build }) => {
      const document = build()
      const first = structBundleWire(document)
      const second = structBundleWire(document)
      expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(
        true,
      )
      expect(second.bundleSha256).toBe(first.bundleSha256)
      expect(second.documentSha256).toBe(first.documentSha256)
      expect(second.semanticReceiptSha256).toBe(first.semanticReceiptSha256)
      expect(second.descriptor).toEqual(first.descriptor)
    },
  )

  it('rehydrates the asset bytes and reproduces the app document digest', () => {
    const document = inlineCodePilot()
    const wire = structBundleWire(document)
    const handle = createStructBundleForDocument(document)

    // The bundle handle carries the byte-free document: the app digest is
    // over the document WITH the asset bytes, so the two must not be
    // compared to each other.
    const snapshot = handle.documentSnapshot()
    expect(snapshot.assets).toHaveLength(1)
    expect('bytes' in (snapshot.assets[0] as Record<string, unknown>)).toBe(
      false,
    )
    expect(handle.documentSha256).not.toBe(wire.documentSha256)

    // Rehydrating the verified asset bytes reproduces the app digest exactly.
    const rehydrated = decodeStructDocument({
      ...snapshot,
      assets: snapshot.assets.map((asset) => ({
        ...asset,
        bytes: handle.assetBytes(asset.id),
      })),
    } as never)
    expect(structDocumentSha256(rehydrated)).toBe(wire.documentSha256)
    expect(handle.assetBytes('pilot-inline-code-asset')).toEqual(
      pilotAssetBytes,
    )
  })

  it('refuses a document whose semantic receipt does not verify', () => {
    const document = baselinePilot()
    receiptVerification.override = () => false
    try {
      expect(() => structBundleWire(document)).toThrow(
        /semantic receipt verifies/u,
      )
    } finally {
      receiptVerification.override = undefined
    }
  })
})
