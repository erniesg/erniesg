import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import {
  STRUCT_SCHEMA_VERSION,
  decodeStructDocument,
} from '@erniesg/struct/document'
import { structDigest } from '@erniesg/struct/identity'
import { buildStructEpub } from '@erniesg/struct/renderers/epub'
import { renderPublicationXhtml } from '@erniesg/struct/renderers/xhtml'
import { createFixtureStructDocument } from '../tools/srt-source-output-evidence.mjs'

const SOURCE_HASH = createHash('sha256')
  .update('srt-source-output-checkpoints')
  .digest('hex')

async function fixtureAsset() {
  const canvas = createCanvas(1200, 1600)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, 1200, 1600)
  return {
    bytes: new Uint8Array(await canvas.encode('png')),
    width: 1200,
    height: 1600,
  }
}

/** The exact document the SRT evidence tool builds for the repository fixture. */
async function toolDocument() {
  return createFixtureStructDocument({
    sourceHash: SOURCE_HASH,
    byteLength: 3868,
    pageCount: 3,
    fileName: 'source-output-checkpoints.pdf',
    page: 1,
    asset: await fixtureAsset(),
    structDigest,
  })
}

/**
 * The canonical receipt digest shape, identical to the app's own construction
 * in `src/struct-adapters/from-reconstruction.ts`.
 */
function canonicalDigest(document) {
  const { receipt, ...withoutReceipt } = document
  return structDigest({
    ...withoutReceipt,
    conservation: receipt.conservation,
    assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
  })
}

/** The pre-fix shape: a legacy document that still carries a document binding. */
function legacyBoundDocument(document) {
  const legacy = {
    ...document,
    schemaVersion: '0.1.0',
    receipt: { ...document.receipt, schemaVersion: '0.1.0' },
  }
  legacy.receipt.generatedSha256 = canonicalDigest(legacy)
  return legacy
}

describe('SRT source/output evidence tool Struct document', () => {
  it('uses the pinned package schema version and a matching document binding', async () => {
    const document = await toolDocument()

    expect(STRUCT_SCHEMA_VERSION).not.toBe('0.1.0')
    expect(document.schemaVersion).toBe(STRUCT_SCHEMA_VERSION)
    expect(document.receipt.schemaVersion).toBe(STRUCT_SCHEMA_VERSION)
    expect(document.documentId).toBeTruthy()
    expect(document.receipt.documentId).toBe(document.documentId)
  })

  it('is accepted by the package document decoder', async () => {
    const document = await toolDocument()

    const decoded = decodeStructDocument(document)

    expect(decoded.schemaVersion).toBe(STRUCT_SCHEMA_VERSION)
    expect(decoded.documentId).toBe(document.documentId)
    expect(decoded.blocks).toHaveLength(document.blocks.length)
    expect(decoded.receipt.generatedSha256).toBe(
      document.receipt.generatedSha256,
    )
  })

  it('is accepted by the package renderers', async () => {
    const document = await toolDocument()

    const epub = await buildStructEpub(document)
    expect(epub.bytes.byteLength).toBeGreaterThan(0)

    const xhtml = await renderPublicationXhtml(document)
    expect(xhtml).toContain('Checkpoint paper')
  })

  it('counts the receipt text against the block text the package measures', async () => {
    const document = await toolDocument()

    const blockText = document.blocks.reduce(
      (total, block) => total + block.text.length,
      0,
    )
    expect(document.receipt.textCharacterCount).toBe(blockText)
    expect(document.receipt.conservation.sourceTextCharacterCount).toBe(
      blockText,
    )
    expect(document.receipt.conservation.structTextCharacterCount).toBe(
      blockText,
    )
  })

  it('binds the receipt digest to the canonical document form', async () => {
    const document = await toolDocument()

    expect(document.receipt.generatedSha256).toBe(canonicalDigest(document))
  })

  it('is refused by the package when the legacy schema version carries a document binding', async () => {
    const legacy = legacyBoundDocument(await toolDocument())

    expect(() => decodeStructDocument(legacy)).toThrow(
      /0\.1\.0 documents cannot contain document bindings or model consultations/u,
    )
    await expect(buildStructEpub(legacy)).rejects.toThrow(
      'STRUCT_RECEIPT_BINDING_MISMATCH',
    )
  })
})
