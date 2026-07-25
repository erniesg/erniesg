#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA256 = /^[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const EXPECTED_PROFILES = ['mobile', 'paperProMove', 'paperPro']

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

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

function validDocuments(documents, count) {
  return (
    Array.isArray(documents) &&
    documents.length === count &&
    documents.every(
      (document) =>
        exactKeys(document, ['id', 'byteLength', 'sha256']) &&
        SAFE_ID.test(document.id) &&
        Number.isSafeInteger(document.byteLength) &&
        document.byteLength > 0 &&
        SHA256.test(document.sha256),
    ) &&
    new Set(documents.map(({ id }) => id)).size === documents.length &&
    new Set(documents.map(({ sha256 }) => sha256)).size === documents.length
  )
}

function invalidContract() {
  throw new Error('INVALID_PDF_CORPUS_CONTRACT')
}

function contractMismatch() {
  throw new Error('PDF_CORPUS_CONTRACT_MISMATCH')
}

export function validateCorpusContract(contract) {
  try {
    if (
      !exactKeys(contract, [
        'schemaVersion',
        'profiles',
        'frozen',
        'seededRandom',
      ]) ||
      contract.schemaVersion !== '1.0.0' ||
      canonicalJson(contract.profiles) !== canonicalJson(EXPECTED_PROFILES) ||
      !exactKeys(contract.frozen, ['id', 'identitySha256', 'documents']) ||
      !SAFE_ID.test(contract.frozen.id) ||
      !SHA256.test(contract.frozen.identitySha256) ||
      !validDocuments(contract.frozen.documents, 10) ||
      !exactKeys(contract.seededRandom, [
        'id',
        'algorithm',
        'seed',
        'seedCommitmentSha256',
        'sampleSize',
        'catalogSha256',
        'selectionSha256',
        'catalog',
        'documents',
      ]) ||
      !SAFE_ID.test(contract.seededRandom.id) ||
      ![
        'sha256-rank-without-replacement-v1',
        'sha256-rank-without-replacement-excluding-frozen-v1',
      ].includes(contract.seededRandom.algorithm) ||
      !SHA256.test(contract.seededRandom.seed) ||
      !SHA256.test(contract.seededRandom.seedCommitmentSha256) ||
      sha256(contract.seededRandom.seed) !==
        contract.seededRandom.seedCommitmentSha256 ||
      contract.seededRandom.sampleSize !== 10 ||
      !validDocuments(
        contract.seededRandom.catalog,
        contract.seededRandom.catalog.length,
      ) ||
      contract.seededRandom.catalog.length <=
        contract.seededRandom.sampleSize ||
      !validDocuments(
        contract.seededRandom.documents,
        contract.seededRandom.sampleSize,
      )
    ) {
      invalidContract()
    }
    if (
      sha256(canonicalJson(contract.frozen.documents)) !==
      contract.frozen.identitySha256
    ) {
      invalidContract()
    }

    const sortedCatalog = [...contract.seededRandom.catalog].sort(
      (left, right) => left.id.localeCompare(right.id),
    )
    if (
      sha256(canonicalJson(sortedCatalog)) !==
      contract.seededRandom.catalogSha256
    ) {
      invalidContract()
    }
    const frozenIds = new Set(
      contract.frozen.documents.map((document) => document.id),
    )
    const excludesFrozen =
      contract.seededRandom.algorithm ===
      'sha256-rank-without-replacement-excluding-frozen-v1'
    const eligibleCatalog = excludesFrozen
      ? contract.seededRandom.catalog.filter(
          (document) => !frozenIds.has(document.id),
        )
      : contract.seededRandom.catalog
    if (eligibleCatalog.length < contract.seededRandom.sampleSize) {
      invalidContract()
    }
    const expectedSelection = eligibleCatalog
      .map((document) => ({
        document,
        score: sha256(
          `${contract.seededRandom.seed}\0${document.id}\0${document.sha256}`,
        ),
      }))
      .sort(
        (left, right) =>
          left.score.localeCompare(right.score) ||
          left.document.id.localeCompare(right.document.id),
      )
      .slice(0, contract.seededRandom.sampleSize)
      .map(({ document }) => document)
    if (
      canonicalJson(expectedSelection) !==
        canonicalJson(contract.seededRandom.documents) ||
      sha256(canonicalJson(expectedSelection)) !==
        contract.seededRandom.selectionSha256 ||
      (excludesFrozen
        ? contract.seededRandom.documents.some((document) =>
            frozenIds.has(document.id),
          )
        : canonicalJson(contract.frozen.documents) ===
          canonicalJson(contract.seededRandom.documents))
    ) {
      invalidContract()
    }

    return {
      schemaVersion: contract.schemaVersion,
      profiles: [...contract.profiles],
      frozenCount: contract.frozen.documents.length,
      frozenIdentitySha256: contract.frozen.identitySha256,
      seededRandomCatalogCount: contract.seededRandom.catalog.length,
      seededRandomCount: contract.seededRandom.documents.length,
      seedCommitmentSha256: contract.seededRandom.seedCommitmentSha256,
      catalogSha256: contract.seededRandom.catalogSha256,
      selectionSha256: contract.seededRandom.selectionSha256,
      contractSha256: sha256(canonicalJson(contract)),
      valid: true,
    }
  } catch {
    invalidContract()
  }
}

export function createCorpusContractBinding(contract, setKey, documents) {
  const validation = validateCorpusContract(contract)
  if (!['frozen', 'seededRandom'].includes(setKey)) contractMismatch()
  const selected = contract[setKey]
  if (!validDocuments(documents, selected.documents.length)) {
    contractMismatch()
  }

  const actualById = new Map(
    documents.map((document) => [document.id, document]),
  )
  for (const expected of selected.documents) {
    const actual = actualById.get(expected.id)
    if (
      !actual ||
      actual.byteLength !== expected.byteLength ||
      actual.sha256 !== expected.sha256
    ) {
      contractMismatch()
    }
  }

  const exactDocuments = selected.documents.map((document) => ({ ...document }))
  const documentIdentitySha256 = sha256(canonicalJson(exactDocuments))
  const expectedIdentitySha256 =
    setKey === 'frozen' ? selected.identitySha256 : selected.selectionSha256
  if (documentIdentitySha256 !== expectedIdentitySha256) contractMismatch()

  return {
    schemaVersion: contract.schemaVersion,
    setKey,
    setId: selected.id,
    contractSha256: validation.contractSha256,
    documentIdentitySha256,
    documents: exactDocuments,
  }
}

export async function bindCorpusContractPaths(contractPath, setKey, paths) {
  const contract = JSON.parse(await readFile(contractPath, 'utf8'))
  const documents = []
  for (const path of paths) {
    const bytes = await readFile(path)
    documents.push({
      id: basename(path, extname(path)),
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    })
  }
  return createCorpusContractBinding(contract, setKey, documents)
}

async function main() {
  if (process.argv.length !== 3) {
    process.stderr.write(
      'Usage: node tools/pdf-corpus-contract.mjs <corpus-contract.json>\n',
    )
    process.exitCode = 2
    return
  }
  const contract = JSON.parse(await readFile(process.argv[2], 'utf8'))
  process.stdout.write(`${JSON.stringify(validateCorpusContract(contract))}\n`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write('PDF corpus contract validation failed.\n')
    process.exitCode = 2
  })
}
