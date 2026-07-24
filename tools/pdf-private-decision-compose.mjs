#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPdfPipeline } from './pdf-corpus-audit-lib.mjs'

export const PDF_PRIVATE_DECISION_COMPOSE_SCHEMA_VERSION = '1.0.0'
const PRIVACY_POLICY =
  'environment-paths-owner-only-transcript-redacted-one-decision-set-digest'
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
const MAX_TRANSCRIPT_FILE_BYTES = 32 * 1024
const SAFE_FAILURE_CODES = new Set([
  'DECISION_SET_IDENTITY_MISMATCH',
  'DECISION_SET_INVALID',
  'DECISION_SET_STALE',
  'EQUATION_DECISION_ALREADY_PRESENT',
  'EQUATION_DECISION_INVALID',
  'INVALID_USAGE',
  'OUTPUT_ALREADY_EXISTS',
  'OUTPUT_PARENT_NOT_OWNER_ONLY',
  'PRIVATE_INPUT_NOT_OWNER_ONLY',
  'SOURCE_IDENTITY_MISMATCH',
  'TRANSCRIPT_IDENTITY_MISMATCH',
  'TRANSCRIPT_INVALID',
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function usage() {
  return 'Usage: npm --silent run pdf:private-decisions:compose -- --input-env <ENV_NAME> --decisions-env <ENV_NAME> --transcript-env <ENV_NAME> --output-env <ENV_NAME> --paper-id <public-id> --relationship-id <relationship-id> --expected-size <bytes> --expected-sha256 <sha256> --expected-decisions-sha256 <sha256> --expected-transcript-sha256 <sha256>\n'
}

function valueAfter(arguments_, index) {
  const value = arguments_[index + 1]
  if (!value || value.startsWith('--')) throw new Error('INVALID_USAGE')
  return value
}

export function parsePrivateDecisionComposeArguments(
  arguments_,
  environment = process.env,
) {
  const values = {}
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (!argument.startsWith('--')) throw new Error('INVALID_USAGE')
    const equals = argument.indexOf('=')
    const key = argument.slice(2, equals < 0 ? undefined : equals)
    const value =
      equals < 0 ? valueAfter(arguments_, index) : argument.slice(equals + 1)
    if (equals < 0) index += 1
    if (!value || Object.hasOwn(values, key)) throw new Error('INVALID_USAGE')
    values[key] = value
  }

  const environmentKeys = [
    'input-env',
    'decisions-env',
    'transcript-env',
    'output-env',
  ]
  const directKeys = [
    'paper-id',
    'relationship-id',
    'expected-size',
    'expected-sha256',
    'expected-decisions-sha256',
    'expected-transcript-sha256',
  ]
  if (
    Object.keys(values).length !== environmentKeys.length + directKeys.length ||
    [...environmentKeys, ...directKeys].some((key) => !values[key]) ||
    Object.keys(values).some(
      (key) => !environmentKeys.includes(key) && !directKeys.includes(key),
    )
  ) {
    throw new Error('INVALID_USAGE')
  }
  const environmentNames = environmentKeys.map((key) => values[key])
  if (
    new Set(environmentNames).size !== environmentNames.length ||
    environmentNames.some((name) => !ENVIRONMENT_NAME_PATTERN.test(name))
  ) {
    throw new Error('INVALID_USAGE')
  }
  const paths = environmentNames.map((name) => environment[name])
  if (
    paths.some((path) => typeof path !== 'string' || !isAbsolute(path)) ||
    new Set(paths).size !== paths.length
  ) {
    throw new Error('INVALID_USAGE')
  }
  const expectedSize = Number(values['expected-size'])
  const expectedSha256 = values['expected-sha256'].toLowerCase()
  const expectedDecisionsSha256 =
    values['expected-decisions-sha256'].toLowerCase()
  const expectedTranscriptSha256 =
    values['expected-transcript-sha256'].toLowerCase()
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize <= 0 ||
    !SAFE_IDENTIFIER_PATTERN.test(values['paper-id']) ||
    !SAFE_IDENTIFIER_PATTERN.test(values['relationship-id']) ||
    !SHA256_PATTERN.test(expectedSha256) ||
    !SHA256_PATTERN.test(expectedDecisionsSha256) ||
    !SHA256_PATTERN.test(expectedTranscriptSha256)
  ) {
    throw new Error('INVALID_USAGE')
  }
  return {
    input: paths[0],
    decisions: paths[1],
    transcript: paths[2],
    output: paths[3],
    paperId: values['paper-id'],
    relationshipId: values['relationship-id'],
    expectedSize,
    expectedSha256,
    expectedDecisionsSha256,
    expectedTranscriptSha256,
  }
}

function safeFailureDiagnostic(error, stage) {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : ''
  const code = SAFE_FAILURE_CODES.has(message) ? message : 'UNCLASSIFIED'
  return {
    schemaVersion: PDF_PRIVATE_DECISION_COMPOSE_SCHEMA_VERSION,
    passed: false,
    errorCode: code,
    messageSha256: sha256(message),
    stage,
  }
}

async function readPinnedFile(
  path,
  {
    expectedSha256,
    expectedSize,
    maximumBytes,
    requireOwnerOnly = false,
    requireOutsideRepository = false,
    identityError,
  },
) {
  const linkDetails = await lstat(path)
  if (linkDetails.isSymbolicLink()) throw new Error(identityError)
  const details = await stat(path)
  if (
    !details.isFile() ||
    details.size <= 0 ||
    details.size > maximumBytes ||
    (expectedSize !== undefined && details.size !== expectedSize) ||
    (requireOwnerOnly && (details.mode & 0o077) !== 0)
  ) {
    throw new Error(
      requireOwnerOnly && (details.mode & 0o077) !== 0
        ? 'PRIVATE_INPUT_NOT_OWNER_ONLY'
        : identityError,
    )
  }
  if (requireOutsideRepository) {
    const repository = await realpath(
      fileURLToPath(new URL('../', import.meta.url)),
    )
    const target = await realpath(path)
    const fromRepository = relative(repository, target)
    if (
      fromRepository === '' ||
      (!isAbsolute(fromRepository) &&
        fromRepository !== '..' &&
        !fromRepository.startsWith(`..${sep}`))
    ) {
      throw new Error('PRIVATE_INPUT_NOT_OWNER_ONLY')
    }
  }
  const bytes = await readFile(path)
  if (sha256(bytes) !== expectedSha256) throw new Error(identityError)
  return bytes
}

async function writeOwnerOnlyExclusive(path, value) {
  const requested = resolve(path)
  const parent = await realpath(dirname(requested))
  const target = resolve(parent, basename(requested))
  const repository = await realpath(
    fileURLToPath(new URL('../', import.meta.url)),
  )
  const fromRepository = relative(repository, target)
  const parentDetails = await stat(parent)
  if (
    !parentDetails.isDirectory() ||
    (parentDetails.mode & 0o077) !== 0 ||
    fromRepository === '' ||
    (!isAbsolute(fromRepository) &&
      fromRepository !== '..' &&
      !fromRepository.startsWith(`..${sep}`))
  ) {
    throw new Error('OUTPUT_PARENT_NOT_OWNER_ONLY')
  }
  try {
    await lstat(target)
    throw new Error('OUTPUT_ALREADY_EXISTS')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const handle = await open(target, 'wx', 0o600)
  try {
    await handle.writeFile(value)
  } finally {
    await handle.close()
  }
}

function resolutionCounts(decisionFile) {
  const counts = {}
  for (const decision of decisionFile.decisions) {
    const key = decision.resolution.type
    if (!SAFE_IDENTIFIER_PATTERN.test(key))
      throw new Error('DECISION_SET_INVALID')
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function composePrivateDecisionSet({
  reconstruction,
  decisionFile,
  relationshipId,
  transcript,
  modules,
}) {
  if (
    decisionFile.decisions.some(
      (decision) =>
        (decision.diagnosticCode === 'UNRESOLVED_EQUATION_TRANSCRIPT' ||
          decision.resolution.type === 'accept-equation-transcript') &&
        (decision.target?.markerId === relationshipId ||
          (decision.resolution.type === 'accept-equation-transcript' &&
            decision.resolution.relationshipId === relationshipId)),
    )
  ) {
    throw new Error('EQUATION_DECISION_ALREADY_PRESENT')
  }
  let equationDecision
  try {
    equationDecision = modules.createEquationTranscriptDecision(
      reconstruction,
      relationshipId,
      transcript,
    )
  } catch {
    throw new Error('EQUATION_DECISION_INVALID')
  }
  const composed = modules.upsertHumanDecision(decisionFile, equationDecision)
  if (composed.decisions.length !== decisionFile.decisions.length + 1) {
    throw new Error('EQUATION_DECISION_INVALID')
  }
  const adjudicated = modules.applyHumanDecisionFile(reconstruction, composed)
  if (
    adjudicated.humanAdjudications.stale.length > 0 ||
    adjudicated.humanAdjudications.applied.length !== composed.decisions.length
  ) {
    throw new Error('DECISION_SET_STALE')
  }
  const serialized = modules.serializeHumanDecisionFile(composed)
  const decisionSetSha256 = modules.humanDecisionFileSha256(composed)
  if (sha256(serialized) !== decisionSetSha256) {
    throw new Error('DECISION_SET_INVALID')
  }
  return {
    decisionFile: composed,
    serialized,
    receipt: {
      schemaVersion: PDF_PRIVATE_DECISION_COMPOSE_SCHEMA_VERSION,
      privacy: PRIVACY_POLICY,
      passed: true,
      documentSha256: composed.documentSha256,
      inputDecisionCount: decisionFile.decisions.length,
      outputDecisionCount: composed.decisions.length,
      resolutionCounts: resolutionCounts(composed),
      decisionSetSha256,
    },
  }
}

async function main() {
  let stage = 'argument-parse'
  let parsed
  try {
    parsed = parsePrivateDecisionComposeArguments(process.argv.slice(2))
  } catch {
    process.stderr.write(usage())
    process.exitCode = 2
    return
  }

  let pipeline
  try {
    stage = 'pipeline-create'
    pipeline = await createPdfPipeline()
    stage = 'source-load'
    const sourceBytes = await readPinnedFile(parsed.input, {
      expectedSha256: parsed.expectedSha256,
      expectedSize: parsed.expectedSize,
      maximumBytes: pipeline.maximumBytes,
      identityError: 'SOURCE_IDENTITY_MISMATCH',
    })
    stage = 'decision-modules-load'
    const modules = await pipeline.loadDecisionModules()
    stage = 'decision-set-load'
    const decisionBytes = await readPinnedFile(parsed.decisions, {
      expectedSha256: parsed.expectedDecisionsSha256,
      maximumBytes: modules.maximumBytes,
      requireOwnerOnly: true,
      requireOutsideRepository: true,
      identityError: 'DECISION_SET_IDENTITY_MISMATCH',
    })
    let decisionFile
    try {
      decisionFile = modules.parseHumanDecisionFile(
        new TextDecoder('utf-8', { fatal: true }).decode(decisionBytes),
      )
    } catch {
      throw new Error('DECISION_SET_INVALID')
    }
    if (decisionFile.documentSha256 !== parsed.expectedSha256) {
      throw new Error('DECISION_SET_IDENTITY_MISMATCH')
    }
    stage = 'transcript-load'
    const transcriptBytes = await readPinnedFile(parsed.transcript, {
      expectedSha256: parsed.expectedTranscriptSha256,
      maximumBytes: MAX_TRANSCRIPT_FILE_BYTES,
      requireOwnerOnly: true,
      requireOutsideRepository: true,
      identityError: 'TRANSCRIPT_IDENTITY_MISMATCH',
    })
    let transcript
    try {
      transcript = new TextDecoder('utf-8', { fatal: true }).decode(
        transcriptBytes,
      )
    } catch {
      throw new Error('TRANSCRIPT_INVALID')
    }
    stage = 'reconstruction'
    const reconstruction = await pipeline.reconstructPdf(
      new File([sourceBytes], `${parsed.paperId}.pdf`, {
        type: 'application/pdf',
        lastModified: 0,
      }),
      undefined,
      { standardFontDataUrl: pipeline.standardFontDataUrl },
    )
    stage = 'decision-compose'
    const composed = composePrivateDecisionSet({
      reconstruction,
      decisionFile,
      relationshipId: parsed.relationshipId,
      transcript,
      modules,
    })
    stage = 'output-write'
    await writeOwnerOnlyExclusive(parsed.output, composed.serialized)
    process.stdout.write(`${JSON.stringify(composed.receipt)}\n`)
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(safeFailureDiagnostic(error, stage))}\n`,
    )
    process.exitCode = 1
  } finally {
    await pipeline?.close()
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main()
}
