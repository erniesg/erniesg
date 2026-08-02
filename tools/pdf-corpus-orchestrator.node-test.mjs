import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { zipSync } from 'fflate'
import {
  createShardReceipt,
  createShardIdentity,
  currentShardReceipt,
  isCompletedShardReceiptCurrent,
  mergeShardReceipts,
  parseArguments,
  parseExporterPerformanceEvidence,
  partitionContractDocuments,
  publishOperationalObservation,
  publishShard,
  resolveAceBrowserExecutable,
  resolveAceTool,
  runBoundedQueue,
  runPipelinedQueue,
  runProcessTree,
  sealReceipt,
  summarizeRegenerationDocuments,
  validateArtifact,
  writeFinalReceipt,
} from './pdf-corpus-orchestrator.mjs'

const hash = (character) => character.repeat(64)

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

const digest = (value) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex')
const byteDigest = (value) => createHash('sha256').update(value).digest('hex')

async function writeExecutable(path, source) {
  await writeFile(path, source)
  await chmod(path, 0o755)
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function waitForJson(path) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    }
  }
  throw new Error('TEST_OBSERVATION_TIMEOUT')
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!processExists(pid)) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  throw new Error('TEST_PROCESS_EXIT_TIMEOUT')
}

function sources(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `document-${index + 1}`,
    byteLength: 100 + index,
    sha256: hash(String((index % 9) + 1)),
  }))
}

function profile(id, artifact, validations = null) {
  return {
    id,
    artifact,
    validations:
      validations ??
      Object.fromEntries(
        ['epubcheck', 'ace', 'chromiumSpineSmoke'].map((validator) => [
          validator,
          artifact
            ? { status: 'passed' }
            : { status: 'not-run', reason: 'artifact-missing' },
        ]),
      ),
  }
}

function document(source, contractIndex, outcome, profiles, failureCodes = []) {
  return {
    contractIndex,
    id: source.id,
    source: {
      sha256: source.sha256,
      byteLength: source.byteLength,
    },
    outcome,
    failureCodes,
    audit: null,
    profiles,
  }
}

function artifact(target, character) {
  return {
    target,
    basename: `publication-${target}.epub`,
    byteLength: 100,
    sha256: hash(character),
    mode: 'authoritative',
    structuralValidation: 'passed',
    relativePath: `export/publication-${target}.epub`,
  }
}

function shardReceipt(shard, documents) {
  return sealReceipt({
    schemaVersion: '1.1.0',
    kind: 'pdf-corpus-regeneration-shard',
    status: 'completed',
    identity: {
      shard: {
        id: shard.id,
        index: shard.index,
      },
    },
    evidence: {},
    documents,
    summary: summarizeRegenerationDocuments(documents),
    artifacts: documents.flatMap((entry) =>
      entry.profiles.flatMap((entryProfile) =>
        entryProfile.artifact ? [entryProfile.artifact] : [],
      ),
    ),
  })
}

function resumableShardFixture(shard) {
  const contractDocuments = shard.documents.map(
    ({ id, byteLength, sha256 }) => ({ id, byteLength, sha256 }),
  )
  const contractBinding = {
    schemaVersion: '1.0.0',
    setKey: 'frozen',
    setId: 'set-v1',
    contractSha256: hash('a'),
    documentIdentitySha256: digest(contractDocuments),
  }
  const versions = { validators: {} }
  const configuration = {
    profiles: [],
    concurrency: {
      conversionShards: 2,
      exporterDocumentsPerShard: 1,
      maximumConcurrentDocuments: 2,
      externalValidators: 2,
      chromiumSpineSmokes: 1,
    },
    ocrEngine: 'none',
    ocrRemoteOptIn: false,
    documentVisibility: 'private',
    readableFallback: false,
    documentTimeoutSeconds: 900,
    validationTimeoutSeconds: 180,
  }
  const identity = createShardIdentity({
    runIdentitySha256: hash('c'),
    contractBinding,
    shard,
    toolchainSha256: digest(versions),
    configurationSha256: digest(configuration),
  })
  const evidence = {
    versions,
    configuration,
    commands: {
      conversion: {
        executable: 'node',
        arguments: [
          'tools/pdf-export.mjs',
          '<contract-shard-pdfs...>',
          '--ocr-engine',
          'none',
          '--document-visibility',
          'private',
          '--concurrency',
          '1',
          '--document-timeout-seconds',
          '900',
          '--out',
          '<temporary-output>',
        ],
      },
      validators: {},
    },
    concurrency: configuration.concurrency,
    sourceIdentity: {
      contractSha256: contractBinding.contractSha256,
      documentIdentitySha256: contractBinding.documentIdentitySha256,
      documents: contractDocuments,
    },
  }
  const state = (outcome, elapsedMs = 10) => ({
    shard,
    outputDirectory: null,
    documents: shard.documents.map((source) =>
      document(
        source,
        source.contractIndex,
        outcome,
        [],
        outcome === 'ready' ? [] : ['TRANSIENT_FAILURE'],
      ),
    ),
    artifacts: [],
    conversion: {
      status: outcome === 'ready' ? 'completed' : 'failed',
      exitCode: outcome === 'ready' ? 0 : 1,
      ...(outcome === 'ready' ? {} : { reason: 'execution-failed' }),
      performanceEvidence: {
        schemaVersion: '1.0.0',
        status: 'captured',
        documents: [{ basename: 'document-1.pdf', elapsedMs }],
      },
    },
  })
  return { contractDocuments, evidence, identity, state }
}

async function waitForTreeEntry(root, suffix) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const entries = await readdir(root, { recursive: true })
      if (entries.some((entry) => entry.endsWith(suffix))) return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
  }
  throw new Error('TEST_OBSERVATION_TIMEOUT')
}

describe('PDF corpus shard orchestration', () => {
  it('partitions contract order deterministically into balanced contiguous shards', () => {
    const documents = sources(7)
    const first = partitionContractDocuments(documents, { shardCount: 3 })
    const second = partitionContractDocuments(documents, { shardCount: 3 })

    assert.deepEqual(first, second)
    assert.deepEqual(
      first.map((shard) => shard.documents.map((entry) => entry.contractIndex)),
      [
        [0, 1, 2],
        [3, 4],
        [5, 6],
      ],
    )
    assert.deepEqual(
      first.map(({ id }) => id),
      ['shard-0001-of-0003', 'shard-0002-of-0003', 'shard-0003-of-0003'],
    )
    assert.deepEqual(documents, sources(7))
    assert.deepEqual(
      partitionContractDocuments(documents, { shardSize: 3 }).map((shard) =>
        shard.documents.map(({ contractIndex }) => contractIndex),
      ),
      [
        [0, 1, 2],
        [3, 4],
        [5, 6],
      ],
    )
  })

  it('resumes only an intact completed receipt with exact source and toolchain identity', () => {
    const [shard] = partitionContractDocuments(sources(2), {
      shardCount: 1,
    })
    const contractDocuments = shard.documents.map(
      ({ id, byteLength, sha256 }) => ({ id, byteLength, sha256 }),
    )
    const contractBinding = {
      schemaVersion: '1.0.0',
      setKey: 'frozen',
      setId: 'set-v1',
      contractSha256: hash('a'),
      documentIdentitySha256: digest(contractDocuments),
    }
    const versions = { validators: {} }
    const configuration = {
      profiles: [],
      concurrency: {
        conversionShards: 2,
        exporterDocumentsPerShard: 1,
        maximumConcurrentDocuments: 2,
        externalValidators: 2,
        chromiumSpineSmokes: 1,
      },
      ocrEngine: 'none',
      ocrRemoteOptIn: false,
      documentVisibility: 'private',
      readableFallback: false,
      documentTimeoutSeconds: 900,
    }
    const commands = {
      conversion: {
        executable: 'node',
        arguments: [
          'tools/pdf-export.mjs',
          '<contract-shard-pdfs...>',
          '--ocr-engine',
          'none',
          '--document-visibility',
          'private',
          '--concurrency',
          '1',
          '--document-timeout-seconds',
          '900',
          '--out',
          '<temporary-output>',
        ],
      },
      validators: {},
    }
    const identity = createShardIdentity({
      runIdentitySha256: hash('c'),
      contractBinding,
      shard,
      toolchainSha256: digest(versions),
      configurationSha256: digest(configuration),
    })
    const receiptDocuments = shard.documents.map((source) =>
      document(source, source.contractIndex, 'ready', []),
    )
    const receipt = sealReceipt({
      schemaVersion: '1.1.0',
      kind: 'pdf-corpus-regeneration-shard',
      status: 'completed',
      identity,
      evidence: {
        versions,
        configuration,
        commands,
        concurrency: configuration.concurrency,
        sourceIdentity: {
          contractSha256: contractBinding.contractSha256,
          documentIdentitySha256: contractBinding.documentIdentitySha256,
          documents: contractDocuments,
        },
        conversionResult: { status: 'completed', exitCode: 0 },
      },
      documents: receiptDocuments,
      summary: summarizeRegenerationDocuments(receiptDocuments),
      artifacts: [],
    })

    assert.equal(isCompletedShardReceiptCurrent(receipt, identity), true)

    const failedDocuments = shard.documents.map((source) =>
      document(source, source.contractIndex, 'failed', [], ['TEST_FAILURE']),
    )
    const failedReceipt = sealReceipt({
      ...receipt,
      status: 'failed',
      documents: failedDocuments,
      summary: summarizeRegenerationDocuments(failedDocuments),
    })
    assert.equal(isCompletedShardReceiptCurrent(failedReceipt, identity), false)

    const changedSource = structuredClone(identity)
    changedSource.shard.documents[0].sha256 = hash('f')
    assert.equal(isCompletedShardReceiptCurrent(receipt, changedSource), false)

    const changedToolchain = structuredClone(identity)
    changedToolchain.toolchainSha256 = hash('f')
    assert.equal(
      isCompletedShardReceiptCurrent(receipt, changedToolchain),
      false,
    )

    const oldReceipt = sealReceipt({
      ...receipt,
      schemaVersion: '1.0.0',
    })
    assert.equal(isCompletedShardReceiptCurrent(oldReceipt, identity), false)

    const tampered = structuredClone(receipt)
    tampered.status = 'interrupted'
    assert.equal(isCompletedShardReceiptCurrent(tampered, identity), false)

    const incomplete = sealReceipt({
      ...receipt,
      summary: {},
    })
    assert.equal(isCompletedShardReceiptCurrent(incomplete, identity), false)

    const { conversionResult: _conversionResult, ...withoutConversionResult } =
      receipt.evidence
    const omittedConversionResult = sealReceipt({
      ...receipt,
      evidence: withoutConversionResult,
    })
    assert.equal(
      isCompletedShardReceiptCurrent(omittedConversionResult, identity),
      false,
    )

    for (const conversionResult of [
      {
        status: 'completed',
        exitCode: 0,
        performanceEvidence: { elapsedMs: 10 },
      },
      { status: 'completed', exitCode: 0, elapsedMs: 10 },
      { status: 'completed', exitCode: 0, reason: 'execution-failed' },
      { status: 'completed', exitCode: null },
      { status: 'completed', exitCode: 2 },
      { status: 'failed', exitCode: 0 },
      [],
      null,
    ]) {
      const invalidConversionResult = sealReceipt({
        ...receipt,
        evidence: {
          ...receipt.evidence,
          conversionResult,
        },
      })
      assert.equal(
        isCompletedShardReceiptCurrent(invalidConversionResult, identity),
        false,
      )
    }

    const validFailedConversionResult = sealReceipt({
      ...receipt,
      evidence: {
        ...receipt.evidence,
        conversionResult: {
          status: 'failed',
          exitCode: 1,
          reason: 'execution-failed',
        },
      },
    })
    assert.equal(
      isCompletedShardReceiptCurrent(validFailedConversionResult, identity),
      false,
    )

    for (const sibling of [
      {
        performanceEvidence: {
          schemaVersion: '1.0.0',
          status: 'captured',
        },
      },
      { volatileElapsedMs: 10 },
      { unknownEvidence: { value: 'self-sealed' } },
    ]) {
      const siblingEvidence = sealReceipt({
        ...receipt,
        evidence: {
          ...receipt.evidence,
          ...sibling,
        },
      })
      assert.equal(
        isCompletedShardReceiptCurrent(siblingEvidence, identity),
        false,
      )
    }
  })

  it('merges shard receipts in original contract order, independent of completion order', () => {
    const contractDocuments = sources(4)
    const profiles = ['mobile']
    const shards = partitionContractDocuments(contractDocuments, {
      shardCount: 2,
    })
    const firstDocuments = shards[0].documents.map((source) =>
      document(source, source.contractIndex, 'ready', [
        profile('mobile', artifact('mobile', 'a')),
      ]),
    )
    const secondDocuments = shards[1].documents.map((source) =>
      document(source, source.contractIndex, 'ready', [
        profile('mobile', artifact('mobile', 'b')),
      ]),
    )
    const firstReceipt = shardReceipt(shards[0], firstDocuments)
    const secondReceipt = shardReceipt(shards[1], secondDocuments)
    const firstAttempt = `attempt-${firstReceipt.receiptSha256}`
    const secondAttempt = `attempt-${secondReceipt.receiptSha256}`
    const merged = mergeShardReceipts({
      contractDocuments,
      profiles,
      receipts: [secondReceipt, firstReceipt],
      attempts: [firstAttempt, secondAttempt],
    })

    assert.deepEqual(
      merged.documents.map(({ id }) => id),
      contractDocuments.map(({ id }) => id),
    )
    assert.deepEqual(
      merged.shards.map(({ id }) => id),
      shards.map(({ id }) => id),
    )
    assert.deepEqual(
      merged.documents.map(
        ({ profiles: [entryProfile] }) => entryProfile.artifact.relativePath,
      ),
      [
        `shards/shard-0001-of-0002/${firstAttempt}/export/publication-mobile.epub`,
        `shards/shard-0001-of-0002/${firstAttempt}/export/publication-mobile.epub`,
        `shards/shard-0002-of-0002/${secondAttempt}/export/publication-mobile.epub`,
        `shards/shard-0002-of-0002/${secondAttempt}/export/publication-mobile.epub`,
      ],
    )
    assert.deepEqual(
      merged.shards.map(({ attempt, receiptPath }) => ({
        attempt,
        receiptPath,
      })),
      [
        {
          attempt: firstAttempt,
          receiptPath: `shards/shard-0001-of-0002/${firstAttempt}/receipt.json`,
        },
        {
          attempt: secondAttempt,
          receiptPath: `shards/shard-0002-of-0002/${secondAttempt}/receipt.json`,
        },
      ],
    )
    assert.equal(merged.validationScope.publicationReadinessEstablished, false)
    assert.deepEqual(merged.validationScope.chromiumSpineSmoke.excluded, [
      'webkit',
      'href-and-fragment-integrity',
      'reader-marker-scans',
      'responsiveness',
      'apple-books',
      'target-e-ink',
    ])
  })

  it('publishes byte-identical fresh-root and concurrent receipts at content-derived locators', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-receipt-content-'))
    try {
      const [shard] = partitionContractDocuments(sources(1), { shardCount: 1 })
      const outputDirectory = join(directory, 'export-source')
      await mkdir(outputDirectory)
      const bytes = Buffer.from('deterministic-publication-bytes')
      await writeFile(join(outputDirectory, 'publication-mobile.epub'), bytes)
      const publishedArtifact = {
        target: 'mobile',
        basename: 'publication-mobile.epub',
        byteLength: bytes.byteLength,
        sha256: byteDigest(bytes),
        mode: 'authoritative',
        structuralValidation: 'passed',
        relativePath: 'export/publication-mobile.epub',
      }
      const documents = shard.documents.map((source) =>
        document(source, source.contractIndex, 'ready', [
          profile('mobile', publishedArtifact),
        ]),
      )
      const performanceEvidence = (elapsedMs) => ({
        schemaVersion: '1.0.0',
        status: 'captured',
        documents: [
          {
            basename: 'document-1.pdf',
            status: 'completed',
            telemetry: { elapsedMs },
          },
        ],
      })
      const state = {
        shard,
        outputDirectory,
        documents,
        artifacts: [],
        conversion: {
          status: 'completed',
          exitCode: 0,
          performanceEvidence: performanceEvidence(10),
        },
      }
      const differentTelemetryState = structuredClone(state)
      differentTelemetryState.conversion.performanceEvidence =
        performanceEvidence(90)
      const receipt = createShardReceipt({
        state,
        identity: {
          runIdentitySha256: hash('f'),
          shard: {
            id: shard.id,
            index: shard.index,
          },
        },
        evidence: {},
      })
      const differentTelemetryReceipt = createShardReceipt({
        state: differentTelemetryState,
        identity: {
          runIdentitySha256: hash('f'),
          shard: {
            id: shard.id,
            index: shard.index,
          },
        },
        evidence: {},
      })
      assert.deepEqual(differentTelemetryReceipt, receipt)
      assert.deepEqual(receipt.evidence.conversionResult, {
        status: 'completed',
        exitCode: 0,
      })
      assert.equal(
        JSON.stringify(receipt).includes('performanceEvidence'),
        false,
      )
      assert.equal(JSON.stringify(receipt).includes('observation-'), false)
      const runRoots = ['fresh-a', 'fresh-b', 'concurrent'].map((name) =>
        join(directory, name),
      )
      await Promise.all(runRoots.map((runRoot) => mkdir(runRoot)))
      const shardParents = ['fresh-a', 'fresh-b', 'concurrent'].map((name) =>
        join(directory, name, 'shards', shard.id),
      )
      const firstObservation = await publishOperationalObservation({
        runRoot: runRoots[0],
        state,
        receipt,
      })
      const secondObservation = await publishOperationalObservation({
        runRoot: runRoots[1],
        state: differentTelemetryState,
        receipt,
      })
      const concurrentObservations = await Promise.all(
        Array.from({ length: 4 }, () =>
          publishOperationalObservation({
            runRoot: runRoots[2],
            state,
            receipt,
          }),
        ),
      )
      const concurrentObservationDirectory = join(
        runRoots[2],
        'operational-telemetry',
        shard.id,
      )
      assert.deepEqual(await readdir(concurrentObservationDirectory), [
        firstObservation.basename,
      ])
      const differingObservation = await publishOperationalObservation({
        runRoot: runRoots[2],
        state: differentTelemetryState,
        receipt,
      })
      assert.notEqual(
        firstObservation.observation.observationSha256,
        secondObservation.observation.observationSha256,
      )
      assert.notEqual(firstObservation.basename, differingObservation.basename)
      assert.deepEqual(
        concurrentObservations.map(({ basename: name }) => name),
        Array(4).fill(firstObservation.basename),
      )
      assert.deepEqual(
        (await readdir(concurrentObservationDirectory)).sort(),
        [firstObservation.basename, differingObservation.basename].sort(),
      )
      for (const { observation } of [
        firstObservation,
        secondObservation,
        differingObservation,
      ]) {
        const { observationSha256, ...payload } = observation
        assert.equal(observationSha256, digest(payload))
        assert.equal(observation.scope, 'operational-only')
        assert.equal(
          observation.deterministicReceiptSha256,
          receipt.receiptSha256,
        )
      }
      const first = await publishShard({
        state,
        receipt,
        shardParent: shardParents[0],
      })
      const second = await publishShard({
        state,
        receipt,
        shardParent: shardParents[1],
      })
      const concurrent = await Promise.all(
        Array.from({ length: 4 }, () =>
          publishShard({
            state,
            receipt,
            shardParent: shardParents[2],
          }),
        ),
      )
      const expectedAttempt = `attempt-${receipt.receiptSha256}`
      assert.equal(first.attempt, expectedAttempt)
      assert.equal(second.attempt, expectedAttempt)
      assert.deepEqual(
        concurrent.map(({ attempt }) => attempt),
        Array(4).fill(expectedAttempt),
      )
      assert.deepEqual(await readdir(shardParents[2]), [expectedAttempt])

      const mergedReceipts = [first, second, concurrent[0]].map(
        ({ receipt: publishedReceipt, attempt }) =>
          mergeShardReceipts({
            contractDocuments: sources(1),
            receipts: [publishedReceipt],
            attempts: [attempt],
            profiles: ['mobile'],
            identity: { runIdentitySha256: hash('f') },
            evidence: {},
          }),
      )
      assert.deepEqual(mergedReceipts[0], mergedReceipts[1])
      assert.deepEqual(mergedReceipts[0], mergedReceipts[2])
      const finalPaths = ['fresh-a', 'fresh-b', 'concurrent'].map((name) =>
        join(directory, name, 'corpus-regeneration-receipt.json'),
      )
      await Promise.all([
        writeFinalReceipt(finalPaths[0], mergedReceipts[0]),
        writeFinalReceipt(finalPaths[1], mergedReceipts[1]),
        ...Array.from({ length: 4 }, () =>
          writeFinalReceipt(finalPaths[2], mergedReceipts[2]),
        ),
      ])
      const finalBytes = await Promise.all(
        finalPaths.map((path) => readFile(path)),
      )
      assert.equal(Buffer.compare(finalBytes[0], finalBytes[1]), 0)
      assert.equal(Buffer.compare(finalBytes[0], finalBytes[2]), 0)
      assert.equal(
        mergedReceipts[0].receiptSha256,
        mergedReceipts[1].receiptSha256,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects pre-existing operational telemetry symlink traversal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-telemetry-symlink-'))
    try {
      const [shard] = partitionContractDocuments(sources(1), { shardCount: 1 })
      const fixture = resumableShardFixture(shard)
      const state = fixture.state('ready')
      const receipt = createShardReceipt({
        state,
        identity: fixture.identity,
        evidence: fixture.evidence,
      })
      const outside = join(directory, 'outside')
      await mkdir(outside)

      const realRunRoot = join(directory, 'real-run-root')
      const runRootLink = join(directory, 'run-root-link')
      await mkdir(realRunRoot)
      await symlink(realRunRoot, runRootLink)
      await assert.rejects(
        publishOperationalObservation({
          runRoot: runRootLink,
          state,
          receipt,
        }),
        /UNSAFE_OPERATIONAL_TELEMETRY_PATH/u,
      )

      const telemetryLinkRoot = join(directory, 'telemetry-link-root')
      await mkdir(telemetryLinkRoot)
      await symlink(outside, join(telemetryLinkRoot, 'operational-telemetry'))
      await assert.rejects(
        publishOperationalObservation({
          runRoot: telemetryLinkRoot,
          state,
          receipt,
        }),
        /UNSAFE_OPERATIONAL_TELEMETRY_PATH/u,
      )

      const shardLinkRoot = join(directory, 'shard-link-root')
      await mkdir(join(shardLinkRoot, 'operational-telemetry'), {
        recursive: true,
      })
      await symlink(
        outside,
        join(shardLinkRoot, 'operational-telemetry', shard.id),
      )
      await assert.rejects(
        publishOperationalObservation({
          runRoot: shardLinkRoot,
          state,
          receipt,
        }),
        /UNSAFE_OPERATIONAL_TELEMETRY_PATH/u,
      )
      assert.deepEqual(await readdir(outside), [])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retains failed attempts, retries the same identity, and replaces only a failed merged receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-receipt-retry-'))
    try {
      const [shard] = partitionContractDocuments(sources(1), { shardCount: 1 })
      const fixture = resumableShardFixture(shard)
      const shardParent = join(directory, 'shards', shard.id)
      const failedReceipt = createShardReceipt({
        state: fixture.state('failed'),
        identity: fixture.identity,
        evidence: fixture.evidence,
      })
      const failed = await publishShard({
        state: fixture.state('failed'),
        receipt: failedReceipt,
        shardParent,
      })
      assert.equal(failed.receipt.status, 'failed')
      assert.equal(
        await currentShardReceipt(shardParent, fixture.identity),
        null,
      )

      const failedMerged = mergeShardReceipts({
        contractDocuments: fixture.contractDocuments,
        receipts: [failed.receipt],
        attempts: [failed.attempt],
        profiles: [],
        identity: { runIdentitySha256: hash('c') },
      })
      const finalPath = join(directory, 'corpus-regeneration-receipt.json')
      await writeFinalReceipt(finalPath, failedMerged)
      assert.equal(failedMerged.summary.passed, false)

      const passedState = fixture.state('ready')
      const passedReceipt = createShardReceipt({
        state: passedState,
        identity: fixture.identity,
        evidence: fixture.evidence,
      })
      const passed = await publishShard({
        state: passedState,
        receipt: passedReceipt,
        shardParent,
      })
      const repeatedState = fixture.state('ready', 900)
      const repeatedReceipt = createShardReceipt({
        state: repeatedState,
        identity: fixture.identity,
        evidence: fixture.evidence,
      })
      assert.deepEqual(repeatedReceipt, passedReceipt)
      const repeated = await publishShard({
        state: repeatedState,
        receipt: repeatedReceipt,
        shardParent,
      })
      assert.equal(repeated.attempt, passed.attempt)
      const current = await currentShardReceipt(shardParent, fixture.identity)
      assert.equal(current.attempt, passed.attempt)
      assert.equal(current.receipt.summary.passed, true)
      const passedMerged = mergeShardReceipts({
        contractDocuments: fixture.contractDocuments,
        receipts: [passed.receipt],
        attempts: [passed.attempt],
        profiles: [],
        identity: { runIdentitySha256: hash('c') },
      })
      const finalReceipt = await writeFinalReceipt(finalPath, passedMerged)
      assert.deepEqual(finalReceipt, passedMerged)
      assert.deepEqual(
        JSON.parse(await readFile(finalPath, 'utf8')),
        passedMerged,
      )
      assert.deepEqual(
        await writeFinalReceipt(finalPath, failedMerged),
        passedMerged,
      )
      assert.deepEqual(
        (await readdir(shardParent)).sort(),
        [failed.attempt, passed.attempt].sort(),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('checkpoints a passed shard before cancellation and resumes only the remaining shards', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-checkpoint-cancel-'))
    const controller = new AbortController()
    const shards = partitionContractDocuments(sources(3), { shardCount: 3 })
    const fixtures = shards.map(resumableShardFixture)
    const shardParent = (shard) => join(directory, 'shards', shard.id)
    const receipts = fixtures.map((fixture) => {
      const state = fixture.state('ready')
      return {
        state,
        receipt: createShardReceipt({
          state,
          identity: fixture.identity,
          evidence: fixture.evidence,
        }),
      }
    })
    try {
      await assert.rejects(
        runPipelinedQueue(
          shards,
          {
            conversionConcurrency: 2,
            externalValidationConcurrency: 2,
            chromiumSpineSmokeConcurrency: 1,
          },
          async (shard, index, stages, signal) => {
            const converted = await stages.conversion(async () => {
              if (index === 0) return receipts[index].state
              return await new Promise((_resolveStage, rejectStage) => {
                const abort = () =>
                  rejectStage(signal.reason ?? new Error('TEST_CANCELLED'))
                if (signal.aborted) abort()
                else signal.addEventListener('abort', abort, { once: true })
              })
            })
            const published = await publishShard({
              state: converted,
              receipt: receipts[index].receipt,
              shardParent: shardParent(shard),
              signal,
            })
            controller.abort(new Error('TEST_CHECKPOINT_CANCEL'))
            return published
          },
          { signal: controller.signal },
        ),
        /TEST_CHECKPOINT_CANCEL/u,
      )

      const current = await Promise.all(
        shards.map((shard, index) =>
          currentShardReceipt(shardParent(shard), fixtures[index].identity),
        ),
      )
      assert.equal(current[0]?.receipt.summary.passed, true)
      assert.deepEqual(current.slice(1), [null, null])
      const pending = shards.filter((_shard, index) => !current[index])
      assert.deepEqual(
        pending.map(({ index }) => index),
        [1, 2],
      )

      for (const shard of pending) {
        const index = shard.index
        await publishShard({
          state: receipts[index].state,
          receipt: receipts[index].receipt,
          shardParent: shardParent(shard),
        })
      }
      const resumed = await Promise.all(
        shards.map((shard, index) =>
          currentShardReceipt(shardParent(shard), fixtures[index].identity),
        ),
      )
      assert.equal(resumed.every(Boolean), true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retains failures, review-required documents, and missing artifacts in every denominator', () => {
    const contractDocuments = sources(4)
    const documents = [
      document(contractDocuments[0], 0, 'ready', [
        profile('mobile', artifact('mobile', 'a')),
        profile('paper', artifact('paper', 'b')),
      ]),
      document(
        contractDocuments[1],
        1,
        'review-required',
        [
          profile('mobile', artifact('mobile', 'c'), {
            epubcheck: { status: 'passed' },
            ace: { status: 'unavailable', reason: 'ace-unavailable' },
            chromiumSpineSmoke: {
              status: 'failed',
              reason: 'validation-failed',
            },
          }),
          profile('paper', null),
        ],
        ['REVIEW_NEEDED'],
      ),
      document(
        contractDocuments[2],
        2,
        'failed',
        [profile('mobile', null), profile('paper', null)],
        ['CONVERSION_FAILED'],
      ),
      document(
        contractDocuments[3],
        3,
        'failed',
        [profile('mobile', null), profile('paper', null)],
        ['CONVERSION_FAILED'],
      ),
    ]

    const summary = summarizeRegenerationDocuments(documents)
    assert.deepEqual(summary.documents, {
      total: 4,
      ready: 1,
      reviewRequired: 1,
      failed: 2,
      passRate: 0.25,
      failureReasons: {
        CONVERSION_FAILED: 2,
        REVIEW_NEEDED: 1,
      },
    })
    assert.deepEqual(summary.artifacts, {
      expected: 8,
      produced: 3,
      missing: 5,
    })
    assert.deepEqual(summary.validations, {
      epubcheck: {
        total: 8,
        passed: 3,
        failed: 0,
        unavailable: 0,
        notRun: 5,
      },
      ace: {
        total: 8,
        passed: 2,
        failed: 0,
        unavailable: 1,
        notRun: 5,
      },
      chromiumSpineSmoke: {
        total: 8,
        passed: 2,
        failed: 1,
        unavailable: 0,
        notRun: 5,
      },
    })
    assert.equal(summary.passed, false)
  })

  it('enforces independent conversion, external-validator, and Chromium smoke queue bounds', async () => {
    const observed = {}
    const exercise = async (name, limit, count) => {
      let active = 0
      let maximum = 0
      const results = await runBoundedQueue(
        Array.from({ length: count }, (_, index) => index),
        limit,
        async (value) => {
          active += 1
          maximum = Math.max(maximum, active)
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
          active -= 1
          return value * 2
        },
      )
      observed[name] = maximum
      assert.deepEqual(
        results,
        Array.from({ length: count }, (_, index) => index * 2),
      )
    }

    await exercise('conversion', 2, 7)
    await exercise('external', 2, 9)
    await exercise('chromiumSmoke', 1, 5)
    assert.deepEqual(observed, {
      conversion: 2,
      external: 2,
      chromiumSmoke: 1,
    })

    const pipelineActive = {
      conversion: 0,
      external: 0,
      chromiumSmoke: 0,
    }
    const pipelineMaximum = structuredClone(pipelineActive)
    const stage = async (name) => {
      pipelineActive[name] += 1
      pipelineMaximum[name] = Math.max(
        pipelineMaximum[name],
        pipelineActive[name],
      )
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
      pipelineActive[name] -= 1
    }
    await runPipelinedQueue(
      Array.from({ length: 7 }, (_, index) => index),
      {
        conversionConcurrency: 2,
        externalValidationConcurrency: 2,
        chromiumSpineSmokeConcurrency: 1,
      },
      async (_value, _index, stages) => {
        await stages.conversion(() => stage('conversion'))
        await Promise.all([
          stages.externalValidation(() => stage('external')),
          stages.externalValidation(() => stage('external')),
        ])
        await stages.chromiumSpineSmoke(() => stage('chromiumSmoke'))
      },
    )
    assert.deepEqual(pipelineMaximum, {
      conversion: 2,
      external: 2,
      chromiumSmoke: 1,
    })

    assert.throws(
      () =>
        parseArguments([
          '--contract',
          'contract.json',
          '--corpus-set',
          'frozen',
          '--source-root',
          'sources',
          '--out',
          '/tmp/output',
          '--conversion-concurrency',
          '3',
        ]),
      /INVALID_USAGE/u,
    )
  })

  it('accepts only bounded path-redacted exporter performance evidence', () => {
    const performance = {
      schemaVersion: '1.1.0',
      documents: [
        {
          basename: 'paper.pdf',
          status: 'completed',
          telemetry: {
            heartbeatCount: 4,
            maximumRssBytes: 4096,
            maximumHeapUsedBytes: 2048,
            lastStage: 'completed',
            lastCheckpoint: 'completed',
            elapsedMs: 40,
            userCpuMicros: 300,
            systemCpuMicros: 30,
            stages: [
              {
                stage: 'validating',
                checkpoint: 'quality-complete',
                heartbeatCount: 1,
                firstElapsedMs: 30,
                lastElapsedMs: 30,
                firstCompleted: 1,
                lastCompleted: 1,
                total: 1,
              },
            ],
          },
        },
      ],
    }
    const parsed = parseExporterPerformanceEvidence(
      `untrusted diagnostic at /private/source/paper.pdf\nPDF_EXPORT_PERFORMANCE_EVIDENCE ${JSON.stringify(performance)}\n`,
      ['paper.pdf'],
    )

    assert.equal(parsed.status, 'captured')
    assert.equal(parsed.documents[0].basename, 'paper.pdf')
    assert.equal(JSON.stringify(parsed).includes('/private/'), false)

    const pathBearing = structuredClone(performance)
    pathBearing.documents[0].basename = '/private/source/paper.pdf'
    assert.deepEqual(
      parseExporterPerformanceEvidence(
        `PDF_EXPORT_PERFORMANCE_EVIDENCE ${JSON.stringify(pathBearing)}\n`,
        ['paper.pdf'],
      ),
      {
        schemaVersion: '1.0.0',
        status: 'unavailable',
        reason: 'invalid-document',
      },
    )
    assert.equal(
      parseExporterPerformanceEvidence('', ['paper.pdf'], {
        truncated: true,
      }).reason,
      'capture-truncated',
    )
  })

  it('aborts queued work and kills a sibling child process tree after an unexpected rejection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-orchestrator-abort-'))
    const observationPath = join(directory, 'process-tree.json')
    const started = []
    let observation = null
    const childScript = `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(process.argv[1], JSON.stringify({ parentPid: process.pid, grandchildPid: grandchild.pid }))
setInterval(() => {}, 1000)
`
    try {
      await assert.rejects(
        runBoundedQueue([0, 1, 2, 3], 2, async (value, _index, queueSignal) => {
          started.push(value)
          if (value === 0) {
            observation = await waitForJson(observationPath)
            throw new Error('UNEXPECTED_QUEUE_FAILURE')
          }
          return await runProcessTree(
            process.execPath,
            ['-e', childScript, observationPath],
            { signal: queueSignal },
          )
        }),
        /UNEXPECTED_QUEUE_FAILURE/u,
      )

      assert.deepEqual(started, [0, 1])
      await waitForProcessExit(observation.parentPid)
      await waitForProcessExit(observation.grandchildPid)
    } finally {
      for (const pid of [observation?.grandchildPid, observation?.parentPid]) {
        if (pid && processExists(pid)) process.kill(pid, 'SIGKILL')
      }
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('passes validator-scoped browser configuration without exposing it in the result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ace-browser-env-'))
    const validatorScratchRoot = join(directory, 'validator')
    const epubPath = join(directory, 'publication.epub')
    const browserPath = join(directory, 'browser executable')
    const inheritedName = 'PDF_ORCHESTRATOR_TEST_INHERITED_ENV'
    const previousInherited = process.env[inheritedName]
    const previousBrowser = process.env.PUPPETEER_EXECUTABLE_PATH
    await mkdir(validatorScratchRoot)
    await writeFile(epubPath, 'fixture')
    await writeFile(browserPath, 'fixture')
    try {
      process.env[inheritedName] = 'inherited'
      process.env.PUPPETEER_EXECUTABLE_PATH = 'parent-value'
      const validation = await validateArtifact(
        {
          validator: 'ace',
          artifact: { path: epubPath },
        },
        {
          invocation: () => ({
            command: process.execPath,
            arguments: [
              '-e',
              `if (process.env.PUPPETEER_EXECUTABLE_PATH !== process.argv[1]) process.exit(17)
if (process.env.${inheritedName} !== 'inherited') process.exit(18)`,
              browserPath,
            ],
            environment: {
              PUPPETEER_EXECUTABLE_PATH: browserPath,
            },
          }),
        },
        { validationTimeoutSeconds: 20 },
        validatorScratchRoot,
      )

      assert.deepEqual(validation, { status: 'passed' })
      assert.equal(JSON.stringify(validation).includes(browserPath), false)
      assert.equal(process.env.PUPPETEER_EXECUTABLE_PATH, 'parent-value')
      assert.deepEqual(await readdir(validatorScratchRoot), [])
    } finally {
      restoreEnvironment(inheritedName, previousInherited)
      restoreEnvironment('PUPPETEER_EXECUTABLE_PATH', previousBrowser)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resolves only Chrome-family executables with redacted, mutation-bound Ace evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ace-browser-resolver-'))
    const validatorBin = join(directory, 'bin')
    const acePath = join(validatorBin, 'ace')
    const browserPath = join(directory, 'chromium.cjs')
    const invalidBrowserPath = join(directory, 'not-a-browser.cjs')
    const disappearingBrowserPath = join(directory, 'disappearing-browser.cjs')
    const missingBrowserPath = join(directory, 'missing-browser')
    const previousPath = process.env.PATH
    const previousBrowser = process.env.PUPPETEER_EXECUTABLE_PATH
    const browserSource = `#!/usr/bin/env node
if (process.argv.includes('--version')) process.stdout.write('Chromium 148.0.0.0\\n')
`
    await mkdir(validatorBin)
    await writeExecutable(
      acePath,
      `#!/usr/bin/env node
if (process.argv.includes('--version')) process.stdout.write('Ace 1.4.6\\n')
`,
    )
    await writeExecutable(browserPath, browserSource)
    await writeExecutable(
      invalidBrowserPath,
      `#!/usr/bin/env node
if (process.argv.includes('--version')) process.stdout.write('Not a browser 1.0.0\\n')
`,
    )
    await writeExecutable(
      disappearingBrowserPath,
      `#!/usr/bin/env node
const { unlinkSync } = require('node:fs')
if (process.argv.includes('--version')) {
  process.stdout.write('Chromium 148.0.0.0\\n')
  unlinkSync(process.argv[1])
}
`,
    )
    try {
      const resolvedBrowserPath = await realpath(browserPath)
      const configured = await resolveAceBrowserExecutable({
        configuredPath: browserPath,
        playwrightExecutablePath: null,
      })
      assert.equal(configured.path, resolvedBrowserPath)
      assert.equal(configured.sha256, byteDigest(await readFile(browserPath)))

      const fallback = await resolveAceBrowserExecutable({
        configuredPath: invalidBrowserPath,
        playwrightExecutablePath: browserPath,
      })
      assert.equal(fallback.path, resolvedBrowserPath)
      assert.equal(
        await resolveAceBrowserExecutable({
          configuredPath: invalidBrowserPath,
          playwrightExecutablePath: null,
        }),
        null,
      )
      assert.equal(
        await resolveAceBrowserExecutable({
          configuredPath: missingBrowserPath,
          playwrightExecutablePath: disappearingBrowserPath,
        }),
        null,
      )

      process.env.PATH = `${validatorBin}${delimiter}${previousPath ?? ''}`
      const unavailable = await resolveAceTool({
        configuredPath: invalidBrowserPath,
        playwrightExecutablePath: null,
      })
      assert.equal(unavailable.evidence.availability, 'unavailable')
      assert.equal(unavailable.invocation, null)
      assert.equal(
        JSON.stringify(unavailable.evidence).includes(directory),
        false,
      )

      process.env.PUPPETEER_EXECUTABLE_PATH = browserPath
      const first = await resolveAceTool()
      assert.equal(first.evidence.availability, 'available')
      assert.equal(
        first.evidence.version.browserExecutableSha256,
        byteDigest(await readFile(browserPath)),
      )
      assert.equal(JSON.stringify(first.evidence).includes(directory), false)
      assert.deepEqual(first.evidence.command.environment, {
        PUPPETEER_EXECUTABLE_PATH: '<browser-executable>',
      })
      assert.equal(
        first.invocation('publication.epub', 'scratch').environment
          .PUPPETEER_EXECUTABLE_PATH,
        resolvedBrowserPath,
      )

      await writeExecutable(browserPath, `${browserSource}// mutation\n`)
      const changed = await resolveAceTool()
      assert.notEqual(
        changed.evidence.version.browserExecutableSha256,
        first.evidence.version.browserExecutableSha256,
      )
      assert.equal(
        changed.evidence.version.browserVersionOutputSha256,
        first.evidence.version.browserVersionOutputSha256,
      )
      assert.notDeepEqual(changed.evidence, first.evidence)
      assert.equal(JSON.stringify(changed.evidence).includes(directory), false)
    } finally {
      restoreEnvironment('PATH', previousPath)
      restoreEnvironment('PUPPETEER_EXECUTABLE_PATH', previousBrowser)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('distinguishes Ace execution failure from accessibility violations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ace-exit-taxonomy-'))
    const validatorScratchRoot = join(directory, 'validator')
    const epubPath = join(directory, 'publication.epub')
    await mkdir(validatorScratchRoot)
    await writeFile(epubPath, 'fixture')
    try {
      const validateExit = (exitCode) =>
        validateArtifact(
          {
            validator: 'ace',
            artifact: { path: epubPath },
          },
          {
            invocation: () => ({
              command: process.execPath,
              arguments: [
                '-e',
                'process.exit(Number(process.argv[1]))',
                String(exitCode),
              ],
            }),
          },
          { validationTimeoutSeconds: 20 },
          validatorScratchRoot,
        )

      assert.deepEqual(await validateExit(1), {
        status: 'failed',
        reason: 'validator-execution-failed',
      })
      assert.deepEqual(await validateExit(2), {
        status: 'failed',
        reason: 'accessibility-violations',
      })
      assert.deepEqual(await readdir(validatorScratchRoot), [])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it(
    'removes parent-owned unpacked EPUB scratch after forced process-tree termination',
    { timeout: 30_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'epub-kill-cleanup-'))
      const validatorScratchRoot = join(directory, 'validator')
      const epubPath = join(directory, 'publication.epub')
      const readerPath = fileURLToPath(
        new URL('./pdf-epub-browser-reader.mjs', import.meta.url),
      )
      await mkdir(validatorScratchRoot)
      const entries = {
        mimetype: Buffer.from('application/epub+zip'),
        'META-INF/container.xml': Buffer.from(
          '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
        ),
        'OEBPS/content.opf': Buffer.from(
          '<?xml version="1.0"?><package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
        ),
        'OEBPS/chapter.xhtml': Buffer.from(
          '<html xmlns="http://www.w3.org/1999/xhtml"><body>test</body></html>',
        ),
      }
      for (let index = 0; index < 1_000; index += 1) {
        entries[`OEBPS/payload-${String(index).padStart(4, '0')}.bin`] =
          Buffer.alloc(8 * 1024, index % 251)
      }
      await writeFile(epubPath, zipSync(entries, { level: 0 }))
      const controller = new AbortController()
      try {
        const validation = validateArtifact(
          {
            validator: 'chromiumSpineSmoke',
            artifact: { path: epubPath },
          },
          {
            invocation: (artifactPath, scratchDirectory) => ({
              command: process.execPath,
              arguments: [
                readerPath,
                artifactPath,
                '--scratch-root',
                scratchDirectory,
              ],
            }),
          },
          { validationTimeoutSeconds: 20 },
          validatorScratchRoot,
          controller.signal,
        )
        await waitForTreeEntry(validatorScratchRoot, 'META-INF/container.xml')
        controller.abort(new Error('FORCED_VALIDATOR_TERMINATION'))
        await assert.rejects(validation, /FORCED_VALIDATOR_TERMINATION/u)
        assert.deepEqual(await readdir(validatorScratchRoot), [])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
