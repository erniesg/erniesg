#!/usr/bin/env node

// Headless/operator boundary for the table-candidate provider. The browser
// importer remains provider-free by default; this module is only used by a
// trusted local benchmark/import run. The configured process receives a
// bounded image payload and never receives a source path or extracted text.

import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

export const TABLE_CANDIDATE_PROVIDER_CONTRACT_VERSION = '1.0.0'
export const TABLE_CANDIDATE_PROVIDERS = Object.freeze([
  'none',
  'docling-tableformer',
])
export const DEFAULT_TABLE_CANDIDATE_PROVIDER = 'none'
export const TABLE_CANDIDATE_OPT_IN_FLAG = '--table-candidate-opt-in'

const execFileAsync = promisify(execFile)
const SHA256 = /^[a-f0-9]{64}$/u
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_INPUT_BYTES = 50 * 1024 * 1024

function invalid(message = 'Invalid table candidate provider configuration.') {
  const error = new Error(message)
  error.code = 'INVALID_TABLE_CANDIDATE_PROVIDER_CONFIGURATION'
  return error
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeString(value, pattern = null) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    (!pattern || pattern.test(value))
  )
}

function validIdentity(value) {
  return (
    object(value) &&
    safeString(value.id, IDENTIFIER) &&
    safeString(value.version, VERSION) &&
    safeString(value.sha256) &&
    SHA256.test(value.sha256)
  )
}

export function parseTableCandidateProviderConfiguration(value) {
  if (!object(value)) throw invalid()
  if (value.provider !== 'docling-tableformer') {
    throw invalid('Only the pinned local docling-tableformer provider is supported.')
  }
  if (!safeString(value.command)) throw invalid()
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) ||
      value.args.some((argument) => typeof argument !== 'string'))
  ) {
    throw invalid()
  }
  if (!safeString(value.version, VERSION) || !SHA256.test(value.modelDigest)) {
    throw invalid()
  }
  if (!validIdentity(value.adapter) || !validIdentity(value.runtime)) {
    throw invalid('Adapter and runtime identities must be pinned SHA-256 records.')
  }
  if (!object(value.configuration)) throw invalid()
  return {
    provider: 'docling-tableformer',
    command: value.command,
    args: [...(value.args ?? [])],
    version: value.version,
    modelDigest: value.modelDigest,
    adapter: { ...value.adapter },
    runtime: { ...value.runtime },
    configuration: structuredClone(value.configuration),
  }
}

export async function readTableCandidateProviderConfiguration(path) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw invalid('The table candidate provider configuration could not be read.')
  }
  return parseTableCandidateProviderConfiguration(parsed)
}

export function resolveTableCandidateProviderConfiguration({
  provider = DEFAULT_TABLE_CANDIDATE_PROVIDER,
  optIn = false,
  configuration = null,
}) {
  if (!TABLE_CANDIDATE_PROVIDERS.includes(provider)) {
    throw invalid('Unknown table candidate provider.')
  }
  if (provider === 'none') {
    return {
      provider,
      available: true,
      diagnostic: null,
      configuration: null,
    }
  }
  if (!optIn) {
    return {
      provider,
      available: false,
      diagnostic: {
        code: 'TABLE_CANDIDATE_OPT_IN_REQUIRED',
        message:
          'The table candidate provider is disabled by default; pass --table-candidate-opt-in for this run.',
      },
      configuration: null,
    }
  }
  if (!configuration) {
    return {
      provider,
      available: false,
      diagnostic: {
        code: 'TABLE_CANDIDATE_CONFIGURATION_REQUIRED',
        message:
          'An operator configuration file is required when the table candidate provider is enabled.',
      },
      configuration: null,
    }
  }
  return {
    provider,
    available: true,
    diagnostic: null,
    configuration,
  }
}

function unavailableError() {
  const error = new Error('The configured table candidate runtime is unavailable.')
  error.name = 'TableCandidateProviderUnavailableError'
  return error
}

async function commandAvailable(command) {
  try {
    await execFileAsync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

function runProcess({ command, args, input, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    let outputBytes = 0
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      callback()
    }
    const abort = () => {
      child.kill()
      finish(() => reject(unavailableError()))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    child.on('error', () => finish(() => reject(unavailableError())))
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill()
        finish(() => reject(unavailableError()))
        return
      }
      output += chunk.toString('utf8')
    })
    child.stderr.resume()
    child.stdin.on('error', () => finish(() => reject(unavailableError())))
    child.on('close', (code) => {
      if (code !== 0) {
        finish(() => reject(unavailableError()))
        return
      }
      finish(() => resolve(output))
    })
    child.stdin.end(input)
  })
}

/**
 * Create the concrete local process adapter after the source module has been
 * loaded by the headless Vite pipeline. Only the image bytes and its digest
 * cross the process boundary.
 */
export function createProcessTableCandidateProvider({
  module,
  configuration,
}) {
  const config = parseTableCandidateProviderConfiguration(configuration)
  let availability
  const infer = async ({ image, mediaType, imageSha256, signal }) => {
    if (image.byteLength > MAX_INPUT_BYTES) throw unavailableError()
    const payload = JSON.stringify({
      schemaVersion: TABLE_CANDIDATE_PROVIDER_CONTRACT_VERSION,
      image: {
        mediaType,
        sha256: imageSha256,
        base64: Buffer.from(image).toString('base64'),
      },
    })
    let output
    try {
      output = await runProcess({
        command: config.command,
        args: config.args,
        input: payload,
        signal,
      })
    } catch {
      throw unavailableError()
    }
    try {
      const parsed = JSON.parse(output)
      return parsed === null ? null : parsed
    } catch {
      throw unavailableError()
    }
  }
  const provider = module.createDoclingTableCandidateProvider({
    version: config.version,
    modelDigest: config.modelDigest,
    configuration: config.configuration,
    adapter: config.adapter,
    runtime: config.runtime,
    infer,
  })
  provider.available = async () => {
    availability ??= commandAvailable(config.command)
    return availability
  }
  return provider
}
