import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadAdapterCase } from '../../tests/fixtures/struct-adapter-parity/cases'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import { researchPaperSchema } from '../research/schema'
import { buildStructDocument } from '../struct-adapters'
import { adaptResearchPaper } from './research-paper-adapter'
import { legacyResearchPaperSourceBinding } from './source-binding'
import {
  createPublicationContractReceipt,
  validatePublicationSourceResult,
  type PublicationSourceResult,
} from './source-adapter'
import { readStructPackagePin } from './struct-package-pin'
import { structCutoverSourceBinding } from './struct-source-binding'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

const environment = {
  toolchain: {
    node: 'v22.22.3',
    packageLockSha256: 'a'.repeat(64),
  },
  repository: { commit: 'b'.repeat(40), dirty: false as const },
}

function researchPaperResult(): PublicationSourceResult {
  return adaptResearchPaper(researchPaperSchema.parse(rawPaper))
}

function nonResearchPaperResult(
  overrides: Partial<PublicationSourceResult> = {},
): PublicationSourceResult {
  return {
    ...researchPaperResult(),
    provenance: {
      adapterId: 'astro',
      adapterVersion: '1.0.0',
      sourceType: 'astro',
      sourceId: 'blog:entry',
    },
    sourceBinding: undefined,
    ...overrides,
  }
}

describe('publication source binding on the source result', () => {
  it('gives the legacy ResearchPaper path the legacy binding', () => {
    const result = researchPaperResult()
    const validated = validatePublicationSourceResult(result)
    expect(validated.sourceBinding).toEqual(legacyResearchPaperSourceBinding())
    expect(Object.keys(validated.sourceBinding!)).toEqual(['kind'])
  })

  it('carries the binding into the contract receipt', () => {
    const receipt = createPublicationContractReceipt(
      researchPaperResult(),
      environment,
    )
    expect(receipt.sourceBinding).toEqual(legacyResearchPaperSourceBinding())
    // The graph and asset digests stay beside it as diagnostic fields.
    expect(receipt.graphSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.assetBundleSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('leaves a source without a Struct document unbound', () => {
    const result = nonResearchPaperResult()
    const validated = validatePublicationSourceResult(result)
    expect(validated.sourceBinding).toBeUndefined()
    expect(
      createPublicationContractReceipt(result, environment).sourceBinding,
    ).toBeUndefined()
  })

  it('accepts a Struct binding that matches its Struct document', async () => {
    const document = buildStructDocument(
      await loadAdapterCase('ordinary-pdf'),
    )
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = await structCutoverSourceBinding(document, pin)
    const result = nonResearchPaperResult({
      structDocument: document,
      sourceBinding: binding,
    })
    const validated = validatePublicationSourceResult(result)
    expect(validated.sourceBinding).toEqual(binding)
    expect(
      createPublicationContractReceipt(result, environment).sourceBinding,
    ).toEqual(binding)
  })

  it('rejects a Struct binding without the document it was derived from', async () => {
    const document = buildStructDocument(
      await loadAdapterCase('ordinary-pdf'),
    )
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = await structCutoverSourceBinding(document, pin)
    const result = nonResearchPaperResult({ sourceBinding: binding })
    expect(() => validatePublicationSourceResult(result)).toThrow(
      /require the Struct document they were derived from/,
    )
  })

  it('rejects a Struct binding whose digest does not match its document', async () => {
    const document = buildStructDocument(
      await loadAdapterCase('ordinary-pdf'),
    )
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = await structCutoverSourceBinding(document, pin)
    const result = nonResearchPaperResult({
      structDocument: document,
      sourceBinding: { ...binding, documentSha256: 'f'.repeat(64) },
    })
    expect(() => validatePublicationSourceResult(result)).toThrow(
      /document digest does not match the Struct document/,
    )
  })

  it('rejects a Struct binding on the legacy ResearchPaper path', async () => {
    const document = buildStructDocument(
      await loadAdapterCase('ordinary-pdf'),
    )
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = await structCutoverSourceBinding(document, pin)
    const result: PublicationSourceResult = {
      ...researchPaperResult(),
      structDocument: document,
      sourceBinding: binding,
    }
    expect(() => validatePublicationSourceResult(result)).toThrow(
      /binding kind does not match its source type: struct-cutover for research-paper/,
    )
  })

  it('rejects the legacy binding on a source that is not a ResearchPaper', () => {
    const result = nonResearchPaperResult({
      sourceBinding: legacyResearchPaperSourceBinding(),
    })
    expect(() => validatePublicationSourceResult(result)).toThrow(
      /binding kind does not match its source type: legacy-research-paper for astro/,
    )
  })
})
