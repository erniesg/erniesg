import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STRUCT_BUNDLE_LIMITS_PROFILE } from '@erniesg/struct/bundle'
import { loadAdapterCase } from '../tests/fixtures/struct-adapter-parity/cases'
import { buildStructDocument } from '../src/struct-adapters/index.ts'
import {
  createAssetBundle,
  serializeAssetBundle,
} from '../src/publication/asset-bundle.ts'
import { PUBLICATION_OUTPUT_POLICY_VERSIONS } from '../src/publication/output-contract.ts'
import { publicationPlanFromStructDocument } from '../src/publication/publishing-facade.ts'
import {
  structBundleWire,
  structDocumentJson,
} from '../src/publication/struct-source-binding.ts'
import {
  assertPublicationStructAdmission,
  publicationCheck,
} from './publication-check.mjs'

/**
 * The focused admission matrix of the release checker.
 *
 * Every case here runs the REAL release checker: the admission function of
 * `tools/publication-check.mjs` and the CLI entry point that calls it. The
 * fixtures are real wire bytes produced by the receipt helper from a real
 * Struct revision, so nothing in this file is a string-presence check and
 * nothing depends on a frozen golden.
 *
 * The positive publication proof is NOT here: a real publication needs the
 * renderer lane's `struct-bundle.bin` and its rendered artifacts. What is
 * proven here is that the admission accepts exactly the bytes the receipt
 * claims and refuses every forgery the CLI audit found.
 */

const document = buildStructDocument(await loadAdapterCase('structured-docx'))
const wire = structBundleWire(document)

const assetDescriptor = {
  version: '1.0.0',
  assets: document.assets.map((asset) => ({
    id: asset.id,
    sha256: asset.sha256,
    byteLength: asset.bytes?.byteLength ?? 0,
    mediaType: asset.mediaType,
    fileName: `${asset.id}.png`,
  })),
}

const assetBundle = createAssetBundle(assetDescriptor, async () => {
  throw new Error('the admission fixture never resolves asset bytes')
})

const plan = await publicationPlanFromStructDocument(document, assetBundle)

const baseReceipt = {
  version: '1.0.0',
  source: {
    adapterId: 'astro',
    adapterVersion: '1.0.0',
    sourceType: 'astro',
    sourceId: 'blog:admission-fixture',
    sourceRevision: plan.provenance.sourceRevision,
    graphSha256: 'c'.repeat(64),
    assetBundleSha256: 'd'.repeat(64),
    canonicalSubsetSha256: 'e'.repeat(64),
    routeParity: 'astro-canonical-route',
  },
  sourceBinding: plan.sourceBinding,
  profiles: {},
  policyVersions: PUBLICATION_OUTPUT_POLICY_VERSIONS,
  toolchain: {},
  repository: { commit: 'a'.repeat(40), dirty: false },
  artifacts: [],
}

const matrix = 'phone-webpub,eink-epub,a5-pdf,a4-pdf'

const roots = []

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * One checked output directory that carries the semantic artifacts and the
 * receipt of the fixture.
 */
async function checkedOutput(overrides = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'e04-publication-admission-'))
  roots.push(root)
  await writeFile(
    resolve(root, 'struct-document.json'),
    overrides.structDocumentJson ?? structDocumentJson(document),
  )
  await writeFile(
    resolve(root, 'struct-bundle.json'),
    `${JSON.stringify(wire.descriptor, null, 2)}\n`,
  )
  await writeFile(
    resolve(root, 'asset-bundle.json'),
    `${serializeAssetBundle(assetBundle)}\n`,
  )
  if (overrides.bundleBytes !== null)
    await writeFile(
      resolve(root, 'struct-bundle.bin'),
      overrides.bundleBytes ?? wire.bytes,
    )
  await writeFile(
    resolve(root, 'publication-receipt.json'),
    `${JSON.stringify(overrides.receipt ?? baseReceipt, null, 2)}\n`,
  )
  return root
}

function receiptWith(sourceBinding) {
  return { ...baseReceipt, sourceBinding }
}

describe('the struct admission of the release checker', () => {
  it('accepts the receipt whose wire bytes carry exactly what it claims', async () => {
    const root = await checkedOutput()
    const binding = await assertPublicationStructAdmission(
      root,
      baseReceipt,
      plan,
    )
    expect(binding.documentSha256).toBe(plan.structDocumentSha256)
    expect(binding.bundleSha256).toBe(wire.bundleSha256)
    expect(binding.semanticReceiptSha256).toBe(wire.semanticReceiptSha256)
  })

  it('reaches the admission through the real CLI entry point', async () => {
    const root = await checkedOutput()
    // The CLI rejects the fixture at the repository binding, which is AFTER
    // the admission: the admission itself accepted the fixture.
    await expect(
      publicationCheck(['--input', root, '--matrix', matrix]),
    ).rejects.toThrow(/bound to a different checked-out commit/)
  })
})

describe('the package identity of a struct receipt', () => {
  const forgeries = {
    packageSourceCommit: 'f'.repeat(40),
    packageArtifact: 'erniesg-struct-0.0.0-0000000000000000000000000000000000000000.tgz',
    packageArtifactSha256: 'f'.repeat(64),
    packageIntegrity: 'sha512-0000000000000000000000000000000000000000000000000000=',
    packageVersion: '9.9.9',
  }

  for (const [field, forged] of Object.entries(forgeries))
    it(`rejects a forged ${field}`, async () => {
      const root = await checkedOutput()
      const forgedReceipt = receiptWith({
        ...baseReceipt.sourceBinding,
        [field]: forged,
      })
      await expect(
        assertPublicationStructAdmission(root, forgedReceipt, plan),
      ).rejects.toThrow(/package identity does not match the pinned Struct provenance/u)
    })
})

describe('the digests of a struct receipt', () => {
  it('rejects a receipt without the semantic receipt digest', async () => {
    const root = await checkedOutput()
    const { semanticReceiptSha256: _missing, ...withoutDigest } =
      baseReceipt.sourceBinding
    await expect(
      assertPublicationStructAdmission(
        root,
        receiptWith(withoutDigest),
        plan,
      ),
    ).rejects.toThrow(/semanticReceiptSha256/u)
  })

  it('rejects a changed semantic receipt digest', async () => {
    const root = await checkedOutput()
    await expect(
      assertPublicationStructAdmission(
        root,
        receiptWith({
          ...baseReceipt.sourceBinding,
          semanticReceiptSha256: 'f'.repeat(64),
        }),
        plan,
      ),
    ).rejects.toThrow(/different Struct semantic receipt/u)
  })

  it('rejects a receipt without the bundle digest', async () => {
    const root = await checkedOutput()
    const { bundleSha256: _missing, ...withoutDigest } =
      baseReceipt.sourceBinding
    await expect(
      assertPublicationStructAdmission(
        root,
        receiptWith(withoutDigest),
        plan,
      ),
    ).rejects.toThrow(/not bound to its Struct bundle wire bytes/u)
  })

  it('rejects a changed bundle digest', async () => {
    const root = await checkedOutput()
    await expect(
      assertPublicationStructAdmission(
        root,
        receiptWith({
          ...baseReceipt.sourceBinding,
          bundleSha256: 'f'.repeat(64),
        }),
        plan,
      ),
    ).rejects.toThrow(/different Struct bundle/u)
  })
})

describe('the receipt-bound wire artifact', () => {
  it('rejects a missing wire artifact', async () => {
    const root = await checkedOutput({ bundleBytes: null })
    await expect(
      assertPublicationStructAdmission(root, baseReceipt, plan),
    ).rejects.toThrow(/missing its receipt-bound Struct bundle artifact/u)
  })

  it('rejects a corrupt wire artifact', async () => {
    const corrupt = new Uint8Array(wire.bytes)
    corrupt[corrupt.length - 1] ^= 0xff
    const root = await checkedOutput({ bundleBytes: corrupt })
    await expect(
      assertPublicationStructAdmission(root, baseReceipt, plan),
    ).rejects.toThrow(/did not decode into the bundle the receipt names/u)
  })

  it('rejects a wire artifact of another Struct document', async () => {
    const other = buildStructDocument(await loadAdapterCase('ordinary-pdf'))
    const otherWire = structBundleWire(other)
    const root = await checkedOutput({ bundleBytes: otherWire.bytes })
    await expect(
      assertPublicationStructAdmission(root, baseReceipt, plan),
    ).rejects.toThrow(/did not decode into the bundle the receipt names/u)
  })

  it('rejects an empty wire artifact', async () => {
    const root = await checkedOutput({ bundleBytes: new Uint8Array(0) })
    await expect(
      assertPublicationStructAdmission(root, baseReceipt, plan),
    ).rejects.toThrow(/empty Struct bundle artifact/u)
  })

  it('refuses an oversized wire artifact before allocating it', async () => {
    const root = await checkedOutput({
      bundleBytes: new Uint8Array(
        STRUCT_BUNDLE_LIMITS_PROFILE.maxRawBytes + 1,
      ),
    })
    await expect(
      assertPublicationStructAdmission(root, baseReceipt, plan),
    ).rejects.toThrow(/exceeds the pinned resource limit/u)
  })
})

describe('the persisted Struct document of a checked output', () => {
  it('rejects mutated document bytes', async () => {
    const persisted = JSON.parse(structDocumentJson(document))
    persisted.blocks[0].text = `${persisted.blocks[0].text} mutated`
    const root = await checkedOutput({
      structDocumentJson: `${JSON.stringify(persisted, null, 2)}\n`,
    })
    // The pinned package's own document codec refuses the mutated document:
    // the receipt text count no longer matches the block text.
    await expect(
      publicationCheck(['--input', root, '--matrix', matrix]),
    ).rejects.toThrow(/receipt text count must match block text/u)
  })

  it('rejects mutated asset bytes', async () => {
    const persisted = JSON.parse(structDocumentJson(document))
    const asset = persisted.assets[0]
    const bytes = Buffer.from(asset.bytes, 'base64')
    bytes[0] ^= 0xff
    asset.bytes = bytes.toString('base64')
    const root = await checkedOutput({
      structDocumentJson: `${JSON.stringify(persisted, null, 2)}\n`,
    })
    // The pinned package's own document codec refuses the mutated asset
    // bytes: they no longer match the declared digest.
    await expect(
      publicationCheck(['--input', root, '--matrix', matrix]),
    ).rejects.toThrow(/asset bytes do not match the declared SHA-256 digest/u)
  })
})

describe('the variant of a struct receipt', () => {
  it('rejects the legacy variant', async () => {
    const root = await checkedOutput()
    await expect(
      assertPublicationStructAdmission(
        root,
        receiptWith({ kind: 'legacy-research-paper' }),
        plan,
      ),
    ).rejects.toThrow(/not bound to a Struct document/u)
  })

  it('rejects a binding with an unknown field', async () => {
    const root = await checkedOutput()
    await expect(
      assertPublicationStructAdmission(
        root,
        receiptWith({
          ...baseReceipt.sourceBinding,
          packageSha256: 'f'.repeat(64),
        }),
        plan,
      ),
    ).rejects.toThrow(/Unrecognized key/u)
  })
})

describe('the diagnostic digests of a receipt', () => {
  it('accepts a receipt without the optional graph diagnostics', async () => {
    const root = await checkedOutput()
    const {
      graphSha256: _graph,
      assetBundleSha256: _asset,
      canonicalSubsetSha256: _canonical,
      ...source
    } = baseReceipt.source
    await expect(
      assertPublicationStructAdmission(
        root,
        { ...baseReceipt, source },
        plan,
      ),
    ).resolves.toBeTruthy()
  })

  it('accepts a receipt whose graph diagnostics changed', async () => {
    const root = await checkedOutput()
    await expect(
      assertPublicationStructAdmission(
        root,
        {
          ...baseReceipt,
          source: {
            ...baseReceipt.source,
            graphSha256: '1'.repeat(64),
            assetBundleSha256: '2'.repeat(64),
            canonicalSubsetSha256: '3'.repeat(64),
          },
        },
        plan,
      ),
    ).resolves.toBeTruthy()
  })

  it('keeps the graph diagnostics from replacing the identity', async () => {
    const root = await checkedOutput({
      receipt: {
        ...baseReceipt,
        source: {
          ...baseReceipt.source,
          graphSha256: '1'.repeat(64),
          assetBundleSha256: '2'.repeat(64),
          canonicalSubsetSha256: '3'.repeat(64),
        },
      },
    })
    // The diagnostics changed, but the identity did not: the CLI still gets
    // past the admission and fails at the later repository binding.
    await expect(
      publicationCheck(['--input', root, '--matrix', matrix]),
    ).rejects.toThrow(/bound to a different checked-out commit/)
  })

  it('refuses a malformed diagnostic digest', async () => {
    const root = await checkedOutput({
      receipt: {
        ...baseReceipt,
        source: { ...baseReceipt.source, graphSha256: 'not-a-digest' },
      },
    })
    await expect(
      publicationCheck(['--input', root, '--matrix', matrix]),
    ).rejects.toThrow(/diagnostic graphSha256 is not a well-formed digest/u)
  })
})
