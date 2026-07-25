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
const additiveContractPath = new URL(
  '../benchmarks/pdf/corpus-contract-v2.json',
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
  const frozenIds = new Set(frozenDocuments.map(({ id }) => id))
  const selection = catalog
    .filter(({ id }) => !frozenIds.has(id))
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
      algorithm: 'sha256-rank-without-replacement-excluding-frozen-v1',
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
  it('replays the byte-frozen v1 corpus with its historical selection algorithm', async () => {
    const bytes = await readFile(contractPath)
    const contract = JSON.parse(bytes)
    const receipt = validateCorpusContract(contract)

    expect(sha256(bytes)).toBe(
      '6fd631614cbf7f4570a81d0f538631e2061b63ea037a50fad3c3cc9bfaef4c5d',
    )
    expect(receipt).toMatchObject({
      schemaVersion: '1.0.0',
      frozenCount: 10,
      seededRandomCount: 10,
      seededRandomCatalogCount: 18,
      profiles: ['mobile', 'paperProMove', 'paperPro'],
      contractSha256:
        '88eb68eb02bd8b49cc246ac3dda4d9c7e3e9c175ffdb90daa4a464700bfd6889',
      valid: true,
    })
    expect(
      new Set(contract.seededRandom.documents.map(({ id }) => id)).size,
    ).toBe(10)
    const frozenIds = new Set(contract.frozen.documents.map(({ id }) => id))
    expect(
      contract.seededRandom.documents
        .map(({ id }) => id)
        .filter((id) => frozenIds.has(id))
        .sort(),
    ).toEqual(['2405.07987v5', '2507.21509v3'])
  })

  it('binds the additive v2 corpus to a set-disjoint seeded selection', async () => {
    const bytes = await readFile(additiveContractPath)
    const contract = JSON.parse(bytes)
    const receipt = validateCorpusContract(contract)

    expect(sha256(bytes)).toBe(
      '91b38615b1f9b4acce960bc6ee23d41a8c7eb048714184a469677af0645bc956',
    )
    expect(receipt).toMatchObject({
      schemaVersion: '1.0.0',
      frozenCount: 10,
      seededRandomCount: 10,
      seededRandomCatalogCount: 18,
      contractSha256:
        'df8d26b2dfa64e2afe106d4ac53b630012918aeba4638b437307748ee3541814',
      valid: true,
    })
    expect(contract.seededRandom.algorithm).toBe(
      'sha256-rank-without-replacement-excluding-frozen-v1',
    )
    const frozenIds = new Set(contract.frozen.documents.map(({ id }) => id))
    expect(
      contract.seededRandom.documents.every(({ id }) => !frozenIds.has(id)),
    ).toBe(true)
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
      const schemas = await Promise.all(
        [
          'docs/schemas/pdf-corpus-audit.schema.json',
          'docs/schemas/pdf-corpus-audit-v1.6.schema.json',
          'docs/schemas/pdf-corpus-audit-v1.7.schema.json',
        ].map(async (schemaPath) =>
          JSON.parse(await readFile(schemaPath, 'utf8')),
        ),
      )
      const ajv = new Ajv2020({ strict: false })
      for (const schema of schemas) ajv.addSchema(schema)
      const validate = ajv.getSchema(
        'https://ernie.sg/schemas/pdf-corpus-audit-1.7.0.json',
      )
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
