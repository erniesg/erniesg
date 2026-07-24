#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  localNodeOcrAssets,
  TESSDATA_MODEL_VERSION,
  TESSERACT_JS_VERSION,
  validateLocalNodeOcrAssets,
} from './pdf-ocr-node.mjs'

const localRequire = createRequire(import.meta.url)
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageManifestPath = join(repositoryRoot, 'package.json')
const sha256Pattern = /^[a-f0-9]{64}$/u
const safeModelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const versionPattern =
  /(?:^|[^A-Za-z0-9])v?([0-9]+(?:\.[0-9]+)+(?:[-+][A-Za-z0-9._-]+)?)(?:$|[^A-Za-z0-9])/mu

const usage =
  'Usage: node tools/pdf-local-mac-doctor.mjs [--require-ocr] [--require-epubcheck]\n'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function canonicalJsonHash(value) {
  return sha256(canonicalJson(value))
}

export function parseArguments(arguments_) {
  const parsed = { requireOcr: false, requireEpubCheck: false }
  for (const argument of arguments_) {
    if (argument === '--require-ocr' && !parsed.requireOcr) {
      parsed.requireOcr = true
    } else if (argument === '--require-epubcheck' && !parsed.requireEpubCheck) {
      parsed.requireEpubCheck = true
    } else {
      throw new Error('INVALID_USAGE')
    }
  }
  return parsed
}

function parsedVersion(value) {
  const match = String(value).match(/^v?(\d+)\.(\d+)\.(\d+)/u)
  return match ? match.slice(1, 4).map(Number) : null
}

function compatibleWithMinimum(version, requirement) {
  const required = String(requirement).match(/^>=(\d+\.\d+\.\d+)$/u)
  const actualParts = parsedVersion(version)
  const requiredParts = required ? parsedVersion(required[1]) : null
  if (!actualParts || !requiredParts) return false
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] !== requiredParts[index]) {
      return actualParts[index] > requiredParts[index]
    }
  }
  return true
}

export async function inspectNodeCompatibility({
  nodeVersion = process.versions.node,
  platform = process.platform,
  arch = process.arch,
  readBytes = readFile,
} = {}) {
  let required = null
  try {
    const manifest = JSON.parse(
      (await readBytes(packageManifestPath)).toString('utf8'),
    )
    required =
      typeof manifest.engines?.node === 'string' ? manifest.engines.node : null
  } catch {
    // A missing build contract is represented as incompatible without its path.
  }
  return {
    host: {
      platform,
      arch,
      macSupported: platform === 'darwin' && ['arm64', 'x64'].includes(arch),
    },
    node: {
      version: nodeVersion,
      required,
      compatible:
        required !== null && compatibleWithMinimum(nodeVersion, required),
    },
  }
}

function dependencyVersion(id, expectedVersion, installedVersion) {
  return {
    id,
    expectedVersion,
    installedVersion,
    matches:
      expectedVersion !== null &&
      installedVersion !== null &&
      expectedVersion === installedVersion,
  }
}

function unavailableOcr() {
  return {
    ready: false,
    reason: 'local-assets-unavailable',
    offlineOnly: true,
    languages: ['eng'],
    engine: dependencyVersion('tesseract.js', TESSERACT_JS_VERSION, null),
    core: dependencyVersion('tesseract.js-core', null, null),
    languagePackage: dependencyVersion('@tesseract.js-data/eng', null, null),
    rasterizer: {
      ...dependencyVersion('@napi-rs/canvas', null, null),
      nativeProbePassed: false,
    },
    model: {
      id: 'tessdata_best_int-eng',
      version: TESSDATA_MODEL_VERSION,
      sha256: null,
    },
    assets: {
      browserWorkerSha256: null,
      nodeWorkerSha256: null,
      coreLstmSha256: null,
      coreSimdLstmSha256: null,
    },
    browserReady: false,
    headlessReady: false,
  }
}

async function defaultCanvasProbe() {
  const { createCanvas } = await import('@napi-rs/canvas')
  const bytes = await createCanvas(1, 1).encode('png')
  return bytes.byteLength > 0
}

export async function inspectLocalOcrCapabilities({
  resolveModule = localRequire.resolve,
  readBytes = readFile,
  accessFile = access,
  canvasProbe = defaultCanvasProbe,
} = {}) {
  const unavailable = unavailableOcr()
  try {
    const rootManifest = JSON.parse(
      (await readBytes(packageManifestPath)).toString('utf8'),
    )
    const expected = rootManifest.dependencies ?? {}
    const packageIds = [
      'tesseract.js',
      'tesseract.js-core',
      '@tesseract.js-data/eng',
      '@napi-rs/canvas',
    ]
    const installed = Object.fromEntries(
      await Promise.all(
        packageIds.map(async (id) => {
          const manifest = JSON.parse(
            (await readBytes(resolveModule(`${id}/package.json`))).toString(
              'utf8',
            ),
          )
          return [id, manifest.version]
        }),
      ),
    )
    const engine = dependencyVersion(
      'tesseract.js',
      expected['tesseract.js'] ?? null,
      installed['tesseract.js'] ?? null,
    )
    const core = dependencyVersion(
      'tesseract.js-core',
      expected['tesseract.js-core'] ?? null,
      installed['tesseract.js-core'] ?? null,
    )
    const languagePackage = dependencyVersion(
      '@tesseract.js-data/eng',
      expected['@tesseract.js-data/eng'] ?? null,
      installed['@tesseract.js-data/eng'] ?? null,
    )
    const rasterizerDependency = dependencyVersion(
      '@napi-rs/canvas',
      expected['@napi-rs/canvas'] ?? null,
      installed['@napi-rs/canvas'] ?? null,
    )
    const nodeAssets = await validateLocalNodeOcrAssets(
      localNodeOcrAssets(resolveModule),
      accessFile,
    )
    const browserWorker = resolveModule('tesseract.js/dist/worker.min.js')
    const [
      browserWorkerBytes,
      nodeWorkerBytes,
      modelBytes,
      coreLstmBytes,
      coreSimdLstmBytes,
      nativeProbePassed,
    ] = await Promise.all([
      readBytes(browserWorker),
      readBytes(nodeAssets.workerPath),
      readBytes(nodeAssets.modelPath),
      readBytes(nodeAssets.corePaths[0]),
      readBytes(nodeAssets.corePaths[1]),
      canvasProbe(),
    ])
    const versionsMatch =
      engine.matches &&
      engine.installedVersion === TESSERACT_JS_VERSION &&
      core.matches &&
      languagePackage.matches &&
      rasterizerDependency.matches
    const browserReady =
      versionsMatch &&
      browserWorkerBytes.byteLength > 0 &&
      modelBytes.byteLength > 0 &&
      coreLstmBytes.byteLength > 0 &&
      coreSimdLstmBytes.byteLength > 0
    const headlessReady =
      versionsMatch &&
      nodeWorkerBytes.byteLength > 0 &&
      modelBytes.byteLength > 0 &&
      coreLstmBytes.byteLength > 0 &&
      coreSimdLstmBytes.byteLength > 0 &&
      nativeProbePassed
    const ready = browserReady && headlessReady
    return {
      ready,
      reason: ready
        ? null
        : versionsMatch
          ? 'rasterizer-unavailable'
          : 'dependency-version-mismatch',
      offlineOnly: true,
      languages: ['eng'],
      engine,
      core,
      languagePackage,
      rasterizer: {
        ...rasterizerDependency,
        nativeProbePassed,
      },
      model: {
        id: 'tessdata_best_int-eng',
        version: TESSDATA_MODEL_VERSION,
        sha256: sha256(modelBytes),
      },
      assets: {
        browserWorkerSha256: sha256(browserWorkerBytes),
        nodeWorkerSha256: sha256(nodeWorkerBytes),
        coreLstmSha256: sha256(coreLstmBytes),
        coreSimdLstmSha256: sha256(coreSimdLstmBytes),
      },
      browserReady,
      headlessReady,
    }
  } catch {
    return unavailable
  }
}

async function resolveExecutable(
  command,
  environment,
  { realpathFile = realpath, fileDetails = lstat, accessFile = access } = {},
) {
  if (typeof command !== 'string' || command.length === 0) return null
  const candidates =
    isAbsolute(command) || command.includes(sep)
      ? [resolve(command)]
      : String(environment.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(directory, command))
  for (const candidate of candidates) {
    try {
      const path = await realpathFile(candidate)
      const details = await fileDetails(path)
      await accessFile(path, fsConstants.X_OK)
      if (details.isFile()) return path
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error?.code)) {
        return null
      }
    }
  }
  return null
}

function observedVersion(output) {
  const match = String(output).match(versionPattern)
  return match ? match[1] : null
}

function unavailableTool(id, reason = 'executable-unavailable') {
  return {
    id,
    available: false,
    reason,
    version: null,
    executableSha256: null,
    versionOutputSha256: null,
  }
}

function defaultCommandRunner(command, arguments_, options) {
  return spawnSync(command, arguments_, options)
}

export async function inspectVersionedExecutable(
  id,
  command,
  arguments_,
  {
    environment = process.env,
    readBytes = readFile,
    runCommand = defaultCommandRunner,
    ...resolutionDependencies
  } = {},
) {
  const resolvedPath = await resolveExecutable(
    command,
    environment,
    resolutionDependencies,
  )
  if (!resolvedPath) {
    return {
      capability: unavailableTool(id),
      resolvedPath: null,
    }
  }
  let executableSha256 = null
  try {
    const bytes = await readBytes(resolvedPath)
    if (bytes.byteLength === 0) throw new Error('EMPTY_EXECUTABLE')
    executableSha256 = sha256(bytes)
  } catch {
    return {
      capability: unavailableTool(id),
      resolvedPath: null,
    }
  }
  const result = runCommand(resolvedPath, arguments_, {
    encoding: 'utf8',
    env: environment,
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  const output =
    result && !result.error
      ? `${result.stdout ?? ''}\0${result.stderr ?? ''}`
      : null
  const version = output === null ? null : observedVersion(output)
  const versionOutputSha256 = output === null ? null : sha256(output)
  if (!result || result.error || result.status !== 0 || version === null) {
    return {
      capability: {
        ...unavailableTool(id, 'version-unavailable'),
        executableSha256,
        versionOutputSha256,
      },
      resolvedPath,
    }
  }
  return {
    capability: {
      id,
      available: true,
      reason: null,
      version,
      executableSha256,
      versionOutputSha256,
    },
    resolvedPath,
  }
}

export async function inspectJavaCapabilities(options = {}) {
  return inspectVersionedExecutable('java', 'java', ['-version'], options)
}

function unavailableEpubCheck(reason = 'epubcheck-unavailable') {
  return {
    id: 'epubcheck',
    available: false,
    reason,
    mode: 'unavailable',
    version: null,
    executableSha256: null,
    jarSha256: null,
    versionOutputSha256: null,
    javaRequired: false,
  }
}

export async function inspectEpubCheckCapabilities({
  environment = process.env,
  javaObservation,
  readBytes = readFile,
  runCommand = defaultCommandRunner,
  ...dependencies
} = {}) {
  const direct = await inspectVersionedExecutable(
    'epubcheck',
    'epubcheck',
    ['--version'],
    { environment, readBytes, runCommand, ...dependencies },
  )
  if (direct.capability.available) {
    return {
      ...direct.capability,
      mode: 'command',
      jarSha256: null,
      javaRequired: false,
    }
  }
  const java =
    javaObservation ??
    (await inspectJavaCapabilities({
      environment,
      readBytes,
      runCommand,
      ...dependencies,
    }))
  if (!java.capability.available || !java.resolvedPath) {
    return unavailableEpubCheck('java-unavailable')
  }
  const candidates = [
    environment.EPUBCHECK_JAR,
    join(repositoryRoot, 'tools', 'epubcheck', 'epubcheck.jar'),
    '/usr/share/java/epubcheck.jar',
    '/usr/local/share/java/epubcheck.jar',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const jarBytes = await readBytes(candidate)
      if (jarBytes.byteLength === 0) continue
      const result = runCommand(
        java.resolvedPath,
        ['-jar', candidate, '--version'],
        {
          encoding: 'utf8',
          env: environment,
          timeout: 10_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
      )
      if (result.error || result.status !== 0) continue
      const output = `${result.stdout ?? ''}\0${result.stderr ?? ''}`
      const version = observedVersion(output)
      if (version === null) continue
      return {
        id: 'epubcheck',
        available: true,
        reason: null,
        mode: 'jar',
        version,
        executableSha256: null,
        jarSha256: sha256(jarBytes),
        versionOutputSha256: sha256(output),
        javaRequired: true,
      }
    } catch {
      // Candidate paths and errors stay owner-local and out of the receipt.
    }
  }
  return unavailableEpubCheck()
}

function configuredModelIdentity(environment) {
  const id = environment.SRT_MINERU_MODEL_ID
  const checkpoint = environment.SRT_MINERU_MODEL_SHA256
  const configured = id !== undefined || checkpoint !== undefined
  const configurationValid =
    configured &&
    typeof id === 'string' &&
    safeModelIdPattern.test(id) &&
    typeof checkpoint === 'string' &&
    sha256Pattern.test(checkpoint)
  return {
    configured,
    configurationValid,
    identityVerified: false,
    authority: configured ? 'owner-configured-unverified' : 'not-configured',
    declaredIdSha256:
      typeof id === 'string' && id.length > 0 ? sha256(id) : null,
    declaredCheckpointSha256: configurationValid ? checkpoint : null,
  }
}

export async function inspectMineruCapabilities({
  environment = process.env,
  ...dependencies
} = {}) {
  const command = environment.SRT_MINERU_BIN
  const model = configuredModelIdentity(environment)
  if (command === undefined) {
    return {
      configured: model.configured,
      toolReady: false,
      modelIdentityVerified: false,
      promotionAuthority: false,
      tool: {
        configured: false,
        ...unavailableTool('mineru', 'not-configured'),
      },
      model,
    }
  }
  const offlineEnvironment = {
    ...environment,
    SRT_PDF_EVAL_OFFLINE: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
  }
  const observed = await inspectVersionedExecutable(
    'mineru',
    command,
    ['--version'],
    { environment: offlineEnvironment, ...dependencies },
  )
  return {
    configured: true,
    toolReady: observed.capability.available,
    modelIdentityVerified: false,
    promotionAuthority: false,
    tool: {
      configured: true,
      ...observed.capability,
    },
    model,
  }
}

export async function inspectPdfLocalMacCapabilities({
  environment = process.env,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  inspectOcr = inspectLocalOcrCapabilities,
  inspectJava = inspectJavaCapabilities,
  inspectEpubCheck = inspectEpubCheckCapabilities,
  inspectMineru = inspectMineruCapabilities,
} = {}) {
  const [runtime, ocr, javaObservation, mineru] = await Promise.all([
    inspectNodeCompatibility({ nodeVersion, platform, arch }),
    inspectOcr(),
    inspectJava({ environment }),
    inspectMineru({ environment }),
  ])
  const epubCheck = await inspectEpubCheck({
    environment,
    javaObservation,
  })
  return {
    host: runtime.host,
    node: runtime.node,
    ocr,
    java: javaObservation.capability,
    epubCheck,
    mineru,
  }
}

export function createPdfLocalMacDoctorReceipt(
  capabilities,
  { requireOcr = false, requireEpubCheck = false } = {},
) {
  const browserFullyLocal =
    capabilities.host.macSupported && capabilities.ocr.browserReady
  const headlessFullyLocal =
    capabilities.host.macSupported &&
    capabilities.node.compatible &&
    capabilities.ocr.headlessReady
  const blockingReasons = [
    ...(requireOcr && !headlessFullyLocal
      ? ['local-headless-ocr-required']
      : []),
    ...(requireEpubCheck && !capabilities.epubCheck.available
      ? ['epubcheck-required']
      : []),
  ]
  const evidence = {
    schemaVersion: '1.0.0',
    receiptKind: 'pdf-local-mac-capability',
    privacy: 'no-paths-usernames-or-raw-version-output',
    host: capabilities.host,
    node: capabilities.node,
    ocr: capabilities.ocr,
    java: capabilities.java,
    epubCheck: capabilities.epubCheck,
    mineru: capabilities.mineru,
    lanes: {
      browser: {
        fullyLocal: browserFullyLocal,
        networkRequired: false,
      },
      headless: {
        fullyLocal: headlessFullyLocal,
        networkRequired: false,
        epubCheckAvailable: capabilities.epubCheck.available,
      },
    },
    requirements: {
      requireOcr,
      requireEpubCheck,
      satisfied: blockingReasons.length === 0,
      blockingReasons,
    },
  }
  return {
    ...evidence,
    receiptSha256: canonicalJsonHash(evidence),
  }
}

export async function runDoctor(arguments_, options = {}) {
  const requirements = parseArguments(arguments_)
  const capabilities = await inspectPdfLocalMacCapabilities(options)
  const receipt = createPdfLocalMacDoctorReceipt(capabilities, requirements)
  return {
    receipt,
    exitCode: receipt.requirements.satisfied ? 0 : 1,
  }
}

async function main() {
  let result
  try {
    result = await runDoctor(process.argv.slice(2))
  } catch {
    process.stderr.write(usage)
    process.exitCode = 2
    return
  }
  process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`)
  if (result.exitCode !== 0) {
    process.stderr.write('PDF_LOCAL_MAC_DOCTOR_REQUIREMENTS_UNMET\n')
  }
  process.exitCode = result.exitCode
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main()
}
