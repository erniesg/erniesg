import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import {
  createCorpusContractBinding,
  validateCorpusContract,
} from './pdf-corpus-contract.mjs'

const contractPath = new URL(
  '../benchmarks/pdf/corpus-contract-v1.json',
  import.meta.url,
)

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function writeSyntheticContractCorpus(directory) {
  const corpus = join(directory, 'corpus')
  await mkdir(corpus)
  const frozenDocuments = []
  for (let index = 0; index < 10; index += 1) {
    const id = `synthetic-${String(index + 1).padStart(2, '0')}v1`
    const bytes = Buffer.from(`%PDF-1.7\ninvalid synthetic ${index + 1}\n`)
    await writeFile(join(corpus, `${id}.pdf`), bytes)
    frozenDocuments.push({
      id,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    })
  }
  const catalog = Array.from({ length: 11 }, (_, index) => {
    const bytes = Buffer.from(`catalog ${index + 1}`)
    return {
      id: `catalog-${String(index + 1).padStart(2, '0')}v1`,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    }
  })
  const seed = sha256('synthetic corpus contract seed')
  const selection = catalog
    .map((document) => ({
      document,
      score: sha256(`${seed}\0${document.id}\0${document.sha256}`),
    }))
    .sort(
      (left, right) =>
        left.score.localeCompare(right.score) ||
        left.document.id.localeCompare(right.document.id),
    )
    .slice(0, 10)
    .map(({ document }) => document)
  const contract = {
    schemaVersion: '1.0.0',
    profiles: ['mobile', 'paperProMove', 'paperPro'],
    frozen: {
      id: 'synthetic-frozen-ten-v1',
      identitySha256: sha256(canonicalJson(frozenDocuments)),
      documents: frozenDocuments,
    },
    seededRandom: {
      id: 'synthetic-seeded-ten-v1',
      algorithm: 'sha256-rank-without-replacement-v1',
      seed,
      seedCommitmentSha256: sha256(seed),
      sampleSize: 10,
      catalogSha256: sha256(
        canonicalJson(
          [...catalog].sort((left, right) => left.id.localeCompare(right.id)),
        ),
      ),
      selectionSha256: sha256(canonicalJson(selection)),
      catalog,
      documents: selection,
    },
  }
  const path = join(directory, 'corpus-contract.json')
  await writeFile(path, `${JSON.stringify(contract, null, 2)}\n`)
  return { contract, corpus, path }
}

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

  it('emits a deterministic exact-document receipt for either ten-paper set', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'))
    const schema = JSON.parse(
      await readFile('docs/schemas/pdf-corpus-audit.schema.json', 'utf8'),
    )
    expect(schema.properties.corpusContract).toEqual({
      $ref: '#/$defs/corpusContractBinding',
    })
    expect(schema.$defs.corpusContractBinding).toBeDefined()
    const validateBinding = new Ajv2020({ strict: false }).compile({
      $schema: schema.$schema,
      $defs: schema.$defs,
      ...schema.$defs.corpusContractBinding,
    })

    for (const setKey of ['frozen', 'seededRandom']) {
      const documents = contract[setKey].documents.map((document) => ({
        ...document,
      }))
      const first = createCorpusContractBinding(contract, setKey, documents)
      const second = createCorpusContractBinding(
        structuredClone(contract),
        setKey,
        [...documents].reverse(),
      )

      expect(second).toEqual(first)
      expect(validateBinding(first), validateBinding.errors).toBe(true)
      expect(first).toEqual({
        schemaVersion: '1.0.0',
        setKey,
        setId: contract[setKey].id,
        contractSha256: validateCorpusContract(contract).contractSha256,
        documentIdentitySha256:
          setKey === 'frozen'
            ? contract.frozen.identitySha256
            : contract.seededRandom.selectionSha256,
        documents: contract[setKey].documents,
      })
    }
  })

  it('rejects swapped, missing, extra, wrong-SHA, and wrong-version inputs', async () => {
    const contract = JSON.parse(await readFile(contractPath, 'utf8'))
    const documents = structuredClone(contract.frozen.documents)
    const swapped = structuredClone(documents)
    ;[swapped[0].sha256, swapped[1].sha256] = [
      swapped[1].sha256,
      swapped[0].sha256,
    ]
    ;[swapped[0].byteLength, swapped[1].byteLength] = [
      swapped[1].byteLength,
      swapped[0].byteLength,
    ]
    const extra = [
      ...structuredClone(documents),
      {
        id: '9999.99999v1',
        byteLength: 1,
        sha256: 'f'.repeat(64),
      },
    ]
    const wrongSha = structuredClone(documents)
    wrongSha[0].sha256 = '0'.repeat(64)
    const wrongVersion = structuredClone(documents)
    wrongVersion[0].id = wrongVersion[0].id.replace(/v1$/, 'v2')

    for (const candidate of [
      swapped,
      documents.slice(1),
      extra,
      wrongSha,
      wrongVersion,
    ]) {
      expect(() =>
        createCorpusContractBinding(contract, 'frozen', candidate),
      ).toThrow('PDF_CORPUS_CONTRACT_MISMATCH')
    }
  })

  it('publishes a schema-valid exact ten-set binding from the audit CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-contract-audit-'))
    try {
      const { contract, corpus, path } =
        await writeSyntheticContractCorpus(directory)
      const result = spawnSync(
        process.execPath,
        [
          'tools/pdf-corpus-audit.mjs',
          '--report-only',
          '--corpus-contract',
          path,
          '--corpus-set',
          'frozen',
          corpus,
        ],
        { encoding: 'utf8', timeout: 120_000 },
      )

      expect(result.status, result.stderr).toBe(0)
      const report = JSON.parse(result.stdout)
      const schema = JSON.parse(
        await readFile('docs/schemas/pdf-corpus-audit.schema.json', 'utf8'),
      )
      const validate = new Ajv2020({ strict: false }).compile(schema)
      expect(validate(report), validate.errors).toBe(true)
      expect(report.summary).toMatchObject({
        documents: 10,
        ready: 0,
        reviewRequired: 0,
        failed: 10,
      })
      expect(report.corpusContract).toEqual({
        schemaVersion: '1.0.0',
        setKey: 'frozen',
        setId: contract.frozen.id,
        contractSha256: validateCorpusContract(contract).contractSha256,
        documentIdentitySha256: contract.frozen.identitySha256,
        documents: contract.frozen.documents,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
