import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import equivalentPayload from '../../tests/fixtures/payload/equivalent-publication.json'
import mapping from '../../tests/fixtures/payload/mapping.json'
import {
  createDefaultPublicationAdapterRegistry,
  PublicationAdapterRegistry,
} from './adapter-registry'
import { adaptAstroBlogEntry } from './adapters/astro'
import {
  adaptPayloadLexical,
  payloadLexicalSourceAdapter,
} from './adapters/payload-lexical'
import {
  canonicalPublicationSubsetSha256,
  comparePublicationOutputReceipts,
  comparePublicationSemanticSubset,
  sourceReceiptHashes,
} from './adapter-conformance'
import { createPublicationContractReceipt } from './source-adapter'

describe('publication source adapter conformance', () => {
  it('registers Payload through the same validated bundle boundary', async () => {
    const registry = createDefaultPublicationAdapterRegistry()
    const bundle = await registry.resolve('payload-lexical', {
      id: 'conformance',
      title: 'Conformance',
      content: { root: { children: [{ type: 'paragraph', children: [{ type: 'text', text: 'One' }] }] } },
    })
    expect(bundle.provenance.sourceType).toBe('payload')
    expect(bundle.graph.nodes[0].provenance.adapterId).toBe('payload-lexical')
  })

  it('rejects duplicate registrations and unknown adapters', async () => {
    const registry = new PublicationAdapterRegistry().register(payloadLexicalSourceAdapter)
    expect(() => registry.register(payloadLexicalSourceAdapter)).toThrow(/already registered/)
    await expect(registry.resolve('missing', {})).rejects.toThrow(/Unknown publication source adapter/)
  })

  it('gives equivalent Astro and Payload fixtures the same canonical semantics and contracts', async () => {
    const contentRoot = await mkdtemp(resolve(tmpdir(), 'publication-conformance-'))
    const entryRoot = resolve(contentRoot, 'payload-equivalent')
    try {
      await mkdir(entryRoot)
      await writeFile(
        resolve(entryRoot, 'index.mdx'),
        await readFile(
          resolve('tests/fixtures/publication/astro/payload-equivalent.mdx'),
          'utf8',
        ),
      )
      await copyFile(
        resolve('public/favicon-16x16.png'),
        resolve(entryRoot, 'fixture-image.png'),
      )
      const astro = await adaptAstroBlogEntry({
        entryId: 'payload-equivalent',
        contentRoot,
      })
      const payload = adaptPayloadLexical(equivalentPayload, mapping)
      expect(comparePublicationSemanticSubset(astro, payload)).toBe(true)
      expect(canonicalPublicationSubsetSha256(astro)).toBe(
        canonicalPublicationSubsetSha256(payload),
      )

      const astroHashes = sourceReceiptHashes(astro)
      const payloadHashes = sourceReceiptHashes(payload)
      expect(payloadHashes.canonicalSubsetSha256).toBe(
        astroHashes.canonicalSubsetSha256,
      )
      expect(payloadHashes.sourceRevision).not.toBe(astroHashes.sourceRevision)

      const environment = {
        toolchain: {
          node: 'v22.22.3',
          packageLockSha256: 'a'.repeat(64),
        },
        repository: { commit: 'b'.repeat(40), dirty: false as const },
      }
      const astroReceipt = createPublicationContractReceipt(astro, environment)
      const payloadReceipt = createPublicationContractReceipt(payload, environment)
      expect(payloadReceipt.contracts).toEqual(astroReceipt.contracts)
      expect(payloadReceipt.source).toEqual({
        adapterId: 'payload-lexical',
        sourceType: 'payload',
        mappingVersion: '1.0.0',
      })
    } finally {
      await rm(contentRoot, { recursive: true, force: true })
    }
  })

  it('allows only source provenance and source hashes to differ in output receipts', () => {
    const shared = {
      version: '1.0.0',
      profiles: { 'phone-webpub': { dimensions: '390px x continuous' } },
      policyVersions: {
        renderer: '1.0.0',
        semanticHtml: '1.0.0',
        accessibility: '1.0.0',
        transformationPolicy: '1.0.0',
        publicationCheck: '1.0.0',
      },
      toolchain: { node: '22.22.3' },
      repository: { commit: 'a'.repeat(40), dirty: false },
      artifacts: [
        {
          profile: 'phone-webpub',
          path: 'phone-webpub',
          sha256: 'b'.repeat(64),
          byteLength: 42,
          renderer: 'semantic-html',
        },
      ],
    }
    const astro = {
      ...shared,
      source: {
        adapterId: 'astro',
        adapterVersion: '1.0.0',
        sourceType: 'astro',
        sourceId: 'blog:equivalent',
        graphSha256: 'c'.repeat(64),
        assetBundleSha256: 'd'.repeat(64),
        canonicalSubsetSha256: 'e'.repeat(64),
        routeParity: 'not-applicable',
      },
    }
    const payload = {
      ...shared,
      source: {
        ...astro.source,
        adapterId: 'payload-lexical',
        sourceType: 'payload',
        sourceId: 'payload:equivalent:en',
        graphSha256: 'f'.repeat(64),
        assetBundleSha256: '0'.repeat(64),
        mappingVersion: '1.0.0',
      },
    }
    expect(comparePublicationOutputReceipts(astro, payload)).toBe(true)
    expect(comparePublicationOutputReceipts(astro, {
      ...payload,
      policyVersions: { ...payload.policyVersions, publicationCheck: '2.0.0' },
    })).toBe(false)
    expect(comparePublicationOutputReceipts(astro, {
      ...payload,
      artifacts: [{ ...payload.artifacts[0], sha256: '1'.repeat(64) }],
    })).toBe(false)
    expect(() =>
      comparePublicationOutputReceipts(astro, {
        ...payload,
        source: { ...payload.source, ignoredPolicyBypass: true },
      }),
    ).toThrow(/unsupported source receipt key.*ignoredPolicyBypass/)
    expect(() =>
      comparePublicationOutputReceipts(astro, {
        ...payload,
        unexpectedOutputPolicy: 'changed',
      }),
    ).toThrow(/unsupported output receipt key.*unexpectedOutputPolicy/)
  })
})
