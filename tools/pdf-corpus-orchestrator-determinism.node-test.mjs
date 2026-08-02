import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { isCompletedShardReceiptCurrent } from './pdf-corpus-orchestrator.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..')
const orchestratorPath = join(
  repositoryRoot,
  'tools',
  'pdf-corpus-orchestrator.mjs',
)
const fixturePath = join(
  repositoryRoot,
  'tests',
  'fixtures',
  'pdf',
  'pdf-to-epub-fidelity.pdf',
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

function seededSelection(catalog, seed) {
  return catalog
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
}

async function tinyCorpus(directory) {
  const sourceRoot = join(directory, 'sources')
  await mkdir(sourceRoot)
  const fixture = await readFile(fixturePath)
  const documents = []
  for (let index = 0; index < 10; index += 1) {
    const id = `tiny-${String(index + 1).padStart(2, '0')}`
    const bytes = Buffer.concat([
      fixture,
      Buffer.from(`\n% deterministic-corpus-source-${index + 1}\n`),
    ])
    await writeFile(join(sourceRoot, `${id}.pdf`), bytes)
    documents.push({
      id,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    })
  }

  const seed = '5'.repeat(64)
  const catalog = Array.from({ length: 11 }, (_, index) => ({
    id: `catalog-${String(index + 1).padStart(2, '0')}`,
    byteLength: 100 + index,
    sha256: sha256(`catalog-${index + 1}`),
  }))
  const selected = seededSelection(catalog, seed)
  const contract = {
    schemaVersion: '1.0.0',
    profiles: ['mobile', 'paperProMove', 'paperPro'],
    frozen: {
      id: 'orchestrator-determinism-tiny-v1',
      identitySha256: sha256(canonicalJson(documents)),
      documents,
    },
    seededRandom: {
      id: 'orchestrator-determinism-seeded-v1',
      algorithm: 'sha256-rank-without-replacement-v1',
      seed,
      seedCommitmentSha256: sha256(seed),
      sampleSize: 10,
      catalogSha256: sha256(
        canonicalJson(
          [...catalog].sort((left, right) => left.id.localeCompare(right.id)),
        ),
      ),
      selectionSha256: sha256(canonicalJson(selected)),
      catalog,
      documents: selected,
    },
  }
  const contractPath = join(directory, 'contract.json')
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`)
  return { contractPath, sourceRoot }
}

async function validatorPath(directory) {
  const path = join(directory, 'validator-bin')
  await mkdir(path)
  const adapter = `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('deterministic-validator-adapter 1.0.0\\n')
}
`
  for (const name of ['epubcheck', 'ace']) {
    const executable = join(path, name)
    await writeFile(executable, adapter)
    await chmod(executable, 0o755)
  }
  return path
}

async function exporterTracePreload(directory) {
  const tracePath = join(directory, 'exporter-invocations.jsonl')
  const preloadPath = join(directory, 'trace-exporter-invocations.cjs')
  await writeFile(
    preloadPath,
    `'use strict'
const { appendFileSync } = require('node:fs')
const path = require('node:path')
const { isMainThread } = require('node:worker_threads')
if (
  isMainThread &&
  path.basename(process.argv[1] ?? '') === 'pdf-export.mjs' &&
  !process.argv.includes('--internal-pdf-export-document-worker')
) {
  appendFileSync(
    process.env.PDF_ORCHESTRATOR_EXPORTER_TRACE,
    JSON.stringify({ executable: 'tools/pdf-export.mjs' }) + '\\n',
  )
}
`,
  )
  return { preloadPath, tracePath }
}

async function exporterInvocationCount(tracePath) {
  try {
    return (await readFile(tracePath, 'utf8')).split('\n').filter(Boolean)
      .length
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

function runCli(arguments_, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [orchestratorPath, ...arguments_], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      rejectRun(new Error('ORCHESTRATOR_DETERMINISM_TIMEOUT'))
    }, 300_000)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectRun(error)
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout)
      resolveRun({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

test(
  'whole orchestrator CLI is byte-deterministic across fresh roots and same-root reuse',
  { timeout: 360_000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'pdf-orchestrator-determinism-'),
    )
    try {
      const { contractPath, sourceRoot } = await tinyCorpus(directory)
      const validatorBin = await validatorPath(directory)
      const { preloadPath, tracePath } = await exporterTracePreload(directory)
      const environment = {
        ...process.env,
        PATH: `${validatorBin}:${process.env.PATH ?? ''}`,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`]
          .filter(Boolean)
          .join(' '),
        PDF_ORCHESTRATOR_EXPORTER_TRACE: tracePath,
      }
      const common = [
        '--contract',
        contractPath,
        '--corpus-set',
        'frozen',
        '--source-root',
        sourceRoot,
        '--shard-size',
        '10',
        '--conversion-concurrency',
        '1',
        '--external-validation-concurrency',
        '1',
        '--chromium-spine-smoke-concurrency',
        '1',
        '--target',
        'mobile',
        '--ocr-engine',
        'none',
        '--document-visibility',
        'private',
        '--document-timeout-seconds',
        '240',
        '--validation-timeout-seconds',
        '120',
      ]
      const outputRoots = [
        join(directory, 'fresh-a'),
        join(directory, 'fresh-b'),
      ]
      const first = await runCli(
        [...common, '--out', outputRoots[0]],
        environment,
      )
      const second = await runCli(
        [...common, '--out', outputRoots[1]],
        environment,
      )
      for (const result of [first, second]) {
        assert.equal(result.signal, null)
        assert.equal(
          result.exitCode,
          0,
          `unexpected exit ${result.exitCode}: ${result.stderr}`,
        )
        assert.doesNotMatch(
          result.stderr,
          /CONFLICTING_CURRENT_SHARD_RECEIPTS/u,
        )
      }
      assert.equal(await exporterInvocationCount(tracePath), 2)

      const receipts = [first, second].map(({ stdout }) => JSON.parse(stdout))
      assert.deepEqual(receipts[0], receipts[1])
      assert.equal(receipts[0].receiptSha256, receipts[1].receiptSha256)
      assert.equal(receipts[0].status, 'completed')
      assert.equal(receipts[0].summary.passed, true)
      assert.equal(receipts[0].shards.length, 1)
      assert.deepEqual(receipts[0].shards, receipts[1].shards)
      assert.match(receipts[0].shards[0].attempt, /^attempt-[a-f0-9]{64}$/u)
      assert.equal(
        JSON.stringify(receipts[0]).includes('performanceEvidence'),
        false,
      )
      assert.equal(
        JSON.stringify(receipts[0]).includes('operational-telemetry'),
        false,
      )
      assert.equal(JSON.stringify(receipts[0]).includes('observation-'), false)

      const runDirectory = `run-${receipts[0].identity.runIdentitySha256.slice(
        0,
        32,
      )}`
      const finalPaths = outputRoots.map((root) =>
        join(root, runDirectory, 'corpus-regeneration-receipt.json'),
      )
      const finalBytes = await Promise.all(
        finalPaths.map((path) => readFile(path)),
      )
      assert.equal(Buffer.compare(finalBytes[0], finalBytes[1]), 0)
      assert.equal(sha256(finalBytes[0]), sha256(finalBytes[1]))

      const shardReceiptPaths = outputRoots.map((root) =>
        join(root, runDirectory, receipts[0].shards[0].receiptPath),
      )
      const shardBytes = await Promise.all(
        shardReceiptPaths.map((path) => readFile(path)),
      )
      assert.equal(Buffer.compare(shardBytes[0], shardBytes[1]), 0)
      assert.equal(sha256(shardBytes[0]), sha256(shardBytes[1]))
      const shardReceipts = shardBytes.map((bytes) => JSON.parse(bytes))
      for (const shardReceipt of shardReceipts) {
        assert.equal(shardReceipt.status, 'completed')
        assert.equal(shardReceipt.summary.passed, true)
        assert.equal(
          isCompletedShardReceiptCurrent(shardReceipt, shardReceipt.identity),
          true,
        )
        assert.equal(
          receipts[0].shards[0].attempt,
          `attempt-${shardReceipt.receiptSha256}`,
        )
      }

      const beforeReuse = Buffer.from(finalBytes[0])
      const exporterInvocationsBeforeReuse = await readFile(tracePath)
      const repeated = await runCli(
        [...common, '--out', outputRoots[0]],
        environment,
      )
      assert.equal(
        repeated.exitCode,
        0,
        `unexpected exit ${repeated.exitCode}: ${repeated.stderr}`,
      )
      assert.equal(repeated.signal, null)
      assert.doesNotMatch(
        repeated.stderr,
        /CONFLICTING_CURRENT_SHARD_RECEIPTS/u,
      )
      assert.equal(
        Buffer.compare(
          exporterInvocationsBeforeReuse,
          await readFile(tracePath),
        ),
        0,
        'same-root rerun invoked pdf-export instead of resuming the current shard receipt',
      )
      assert.equal(await exporterInvocationCount(tracePath), 2)
      assert.deepEqual(JSON.parse(repeated.stdout), receipts[0])
      assert.equal(JSON.parse(repeated.stdout).summary.passed, true)
      assert.equal(
        Buffer.compare(beforeReuse, await readFile(finalPaths[0])),
        0,
      )
      assert.deepEqual(
        await readdir(join(outputRoots[0], runDirectory, 'shards')),
        [receipts[0].shards[0].id],
      )
      assert.deepEqual(
        (
          await readdir(
            join(
              outputRoots[0],
              runDirectory,
              'shards',
              receipts[0].shards[0].id,
            ),
          )
        ).filter((name) => name.startsWith('attempt-')),
        [receipts[0].shards[0].attempt],
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
