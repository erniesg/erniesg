import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  comparePublicationOutputReceipts,
  publicationOutputReceiptContract,
} from './adapter-conformance'
import type { PublicationSourceBinding } from './source-binding'

/**
 * The negative acceptance for the deliberate `sourceBinding` widening of the
 * output-receipt allowlist.
 *
 * Non-vacuity: the receipt allowlist stays closed, so a widening that only
 * adds the key to the allowed set still fails N1 (nothing projects the
 * parsed binding), N5/N6/N7 (nothing parses the binding) and N8 (nothing
 * requires the binding). A widening that makes the receipt object
 * non-strict instead fails N3 and N4, because the unknown-key rejection
 * path is the thing under test there.
 */

const hex = (character: string) => character.repeat(64)

const structBinding = {
  kind: 'struct-cutover',
  documentSha256: hex('1'),
  bundleSha256: hex('2'),
  semanticReceiptSha256: hex('3'),
  packageSourceCommit: 'b'.repeat(40),
  packageArtifact:
    'erniesg-struct-0.0.0-90f76f1f80b037cc065169d07b13779c03420026.tgz',
  packageArtifactSha256: hex('4'),
  packageIntegrity:
    'sha512-0WyBLp2PDZr4pOFYhfe6a1IbuZOuBemiR/alDgx73j8JYKZh7m8UthMsimjXp6wt3gUUiNumvXmykYeccnDUBQ==',
  packageVersion: '0.0.0',
} satisfies PublicationSourceBinding

const legacyBinding = {
  kind: 'legacy-research-paper',
} satisfies PublicationSourceBinding

const baseReceipt = {
  version: '1.0.0',
  source: {
    adapterId: 'astro',
    adapterVersion: '1.0.0',
    sourceType: 'astro',
    sourceId: 'blog:equivalent',
    graphSha256: hex('c'),
    assetBundleSha256: hex('d'),
    canonicalSubsetSha256: hex('e'),
    routeParity: 'not-applicable',
  },
  profiles: { 'phone-webpub': { dimensions: '390px x continuous' } },
  policyVersions: { renderer: '1.0.0', semanticHtml: '1.0.0' },
  toolchain: { node: '22.22.3' },
  repository: { commit: 'a'.repeat(40), dirty: false },
  artifacts: [
    {
      profile: 'phone-webpub',
      path: 'phone-webpub',
      sha256: hex('b'),
      byteLength: 42,
      renderer: 'semantic-html',
    },
  ],
}

function receiptWith(sourceBinding: unknown) {
  return { ...baseReceipt, sourceBinding }
}

function rejection(run: () => unknown) {
  try {
    run()
  } catch (error) {
    return error as Error & { cause?: unknown }
  }
  throw new Error('expected the output receipt contract to reject this receipt')
}

function zodIssues(error: Error & { cause?: unknown }) {
  const cause = error.cause
  if (!(cause instanceof z.ZodError))
    throw new Error('expected the rejection to carry a zod cause')
  return cause.issues.map((issue) => ({
    code: issue.code,
    path: issue.path,
    message: issue.message,
  }))
}

describe('publication output receipt source binding', () => {
  it('N1: accepts a struct-variant binding and projects the parsed binding', () => {
    const receipt = receiptWith(structBinding)
    const contract = publicationOutputReceiptContract(receipt)
    expect(contract.sourceBinding).toEqual(structBinding)
    // The projection is the parsed binding, not the raw receipt value.
    expect(contract.sourceBinding).not.toBe(receipt.sourceBinding)
  })

  it('N2: accepts the legacy-research-paper binding', () => {
    const contract = publicationOutputReceiptContract(receiptWith(legacyBinding))
    expect(contract.sourceBinding).toEqual({ kind: 'legacy-research-paper' })
  })

  it('N3: rejects an unknown top-level receipt key', () => {
    const error = rejection(() =>
      publicationOutputReceiptContract({
        ...receiptWith(structBinding),
        structPin: 'not-a-closed-allowlist-key',
      }),
    )
    expect(error.message).toBe(
      'Publication output receipt has unsupported output receipt key: structPin',
    )
  })

  it('N4: rejects an unknown source receipt key', () => {
    const error = rejection(() =>
      publicationOutputReceiptContract({
        ...baseReceipt,
        source: { ...baseReceipt.source, documentSha256: hex('1') },
        sourceBinding: structBinding,
      }),
    )
    expect(error.message).toBe(
      'Publication output receipt has unsupported source receipt key: documentSha256',
    )
  })

  it('N5: rejects an unknown field inside the struct binding', () => {
    const error = rejection(() =>
      publicationOutputReceiptContract(
        receiptWith({ ...structBinding, packageSha256: hex('5') }),
      ),
    )
    expect(error.message).toBe(
      'Publication output receipt is missing its shared contract',
    )
    expect(zodIssues(error)).toEqual([
      {
        code: 'unrecognized_keys',
        path: [],
        message: "Unrecognized key(s) in object: 'packageSha256'",
      },
    ])
  })

  it('N6: rejects a malformed digest inside the struct binding', () => {
    const error = rejection(() =>
      publicationOutputReceiptContract(
        receiptWith({ ...structBinding, documentSha256: 'abc' }),
      ),
    )
    expect(error.message).toBe(
      'Publication output receipt is missing its shared contract',
    )
    expect(zodIssues(error)).toEqual([
      { code: 'invalid_string', path: ['documentSha256'], message: 'Invalid' },
    ])
  })

  it('N7: rejects a non-hex package source commit inside the struct binding', () => {
    const error = rejection(() =>
      publicationOutputReceiptContract(
        receiptWith({ ...structBinding, packageSourceCommit: 'not-hex' }),
      ),
    )
    expect(error.message).toBe(
      'Publication output receipt is missing its shared contract',
    )
    expect(zodIssues(error)).toEqual([
      {
        code: 'invalid_string',
        path: ['packageSourceCommit'],
        message: 'Invalid',
      },
    ])
  })

  it('N8: rejects a receipt without any source binding', () => {
    const error = rejection(() => publicationOutputReceiptContract(baseReceipt))
    expect(error.message).toBe(
      'Publication output receipt is missing its shared contract',
    )
  })

  it('N9: separates two receipts that differ only in their Struct binding', () => {
    const left = receiptWith(structBinding)
    const right = receiptWith({ ...structBinding, documentSha256: hex('9') })
    expect(comparePublicationOutputReceipts(left, right)).toBe(false)
    expect(comparePublicationOutputReceipts(left, left)).toBe(true)
  })
})

describe('the diagnostic digests of a publication output receipt', () => {
  it('accepts a receipt without the optional graph diagnostics', () => {
    const {
      graphSha256: _graph,
      assetBundleSha256: _asset,
      canonicalSubsetSha256: _canonical,
      ...source
    } = baseReceipt.source
    const contract = publicationOutputReceiptContract({
      ...baseReceipt,
      source,
      sourceBinding: structBinding,
    })
    expect(contract.sourceBinding).toEqual(structBinding)
  })

  it('separates nothing on a changed diagnostic digest', () => {
    // The graph, asset and canonical-subset digests are diagnostics: they
    // describe one render and are never the source identity.
    const left = receiptWith(structBinding)
    const right = {
      ...left,
      source: {
        ...baseReceipt.source,
        graphSha256: hex('1'),
        assetBundleSha256: hex('2'),
        canonicalSubsetSha256: hex('3'),
      },
    }
    expect(comparePublicationOutputReceipts(left, right)).toBe(true)
  })

  it('refuses a malformed diagnostic digest', () => {
    const error = rejection(() =>
      publicationOutputReceiptContract({
        ...baseReceipt,
        source: { ...baseReceipt.source, graphSha256: 'not-a-digest' },
        sourceBinding: structBinding,
      }),
    )
    expect(error.message).toBe(
      'Publication output receipt is missing its shared contract',
    )
  })
})
