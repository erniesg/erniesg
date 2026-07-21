import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { validateCorpusContract } from './pdf-corpus-contract.mjs'

const contractPath = new URL(
  '../benchmarks/pdf/corpus-contract-v1.json',
  import.meta.url,
)

describe('PDF corpus benchmark contract', () => {
  it('binds a frozen ten and a distinct seeded ten selected without replacement', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'))
    const receipt = validateCorpusContract(contract)

    expect(receipt).toMatchObject({
      schemaVersion: '1.0.0',
      frozenCount: 10,
      seededRandomCount: 10,
      seededRandomCatalogCount: 18,
      profiles: ['mobile', 'paperProMove', 'paperPro'],
      valid: true,
    })
    expect(
      new Set(contract.seededRandom.documents.map(({ id }) => id)).size,
    ).toBe(10)
    expect(contract.seededRandom.documents).not.toEqual(
      contract.frozen.documents,
    )
  })

  it('rejects selection, commitment, source identity, or count tampering', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'))
    const mutations = [
      (value) => value.seededRandom.documents.reverse(),
      (value) => {
        value.seededRandom.seedCommitmentSha256 = '0'.repeat(64)
      },
      (value) => {
        value.frozen.documents[0].sha256 = '0'.repeat(64)
      },
      (value) => value.seededRandom.catalog.pop(),
    ]

    for (const mutate of mutations) {
      const candidate = structuredClone(contract)
      mutate(candidate)
      expect(() => validateCorpusContract(candidate)).toThrow(
        'INVALID_PDF_CORPUS_CONTRACT',
      )
    }
  })
})
