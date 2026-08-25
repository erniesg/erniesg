import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const require = createRequire(import.meta.url)
const EPUBCHECK_PACKAGE = 'epubcheck-static'
const EPUBCHECK_PACKAGE_VERSION = '4.0.0-v5.3.0'
const EPUBCHECK_MAIN_JAR_SHA256 =
  'f7f96617c929371821609b88c8484d6dc9f24fe916499863c46094c5fb778a65'
const EPUBCHECK_VENDOR_SHA256 =
  '212c2c3f7e3e10cbc64535dfb7ed63364ac2c14915f9e25d4489aba7fcafd252'
const SHA256 = /^[a-f0-9]{64}$/u

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function privateCommandResult(command, arguments_, options = {}) {
  return spawnSync(command, arguments_, {
    stdio: options.stdio ?? 'ignore',
    timeout: options.timeout ?? 10_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024,
    windowsHide: true,
    env: options.env,
  })
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  )
}

function inaccessible(code = 'EPUBCHECK_REQUIRED') {
  throw new Error(code)
}

export function privateJavaPathEntryIsProtected(details, { launcher }) {
  return (
    !details.isSymbolicLink() &&
    details.uid === 0 &&
    (details.mode & 0o022) === 0 &&
    (!launcher || (details.isFile() && (details.mode & 0o111) !== 0))
  )
}

async function stableRegularFile(path, code = 'EPUBCHECK_REQUIRED') {
  try {
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(code)
    const bytes = await readFile(path)
    const after = await lstat(path, { bigint: true })
    if (!sameIdentity(before, after) || BigInt(bytes.byteLength) !== after.size)
      throw new Error(code)
    return {
      bytes,
      identity: {
        dev: after.dev,
        ino: after.ino,
        size: after.size,
        mtimeNs: after.mtimeNs,
        fileSha256: sha256(bytes),
      },
    }
  } catch {
    throw new Error(code)
  }
}

async function vendorFiles(vendorRoot) {
  const records = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    )
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('EPUBCHECK_REQUIRED')
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        const artifact = await stableRegularFile(path)
        const relativePath = relative(vendorRoot, path).split(sep).join('/')
        if (
          !relativePath ||
          relativePath.startsWith('../') ||
          relativePath.includes('\\')
        )
          throw new Error('EPUBCHECK_REQUIRED')
        records.push({
          path: relativePath,
          byteLength: artifact.bytes.byteLength,
          fileSha256: artifact.identity.fileSha256,
          bytes: artifact.bytes,
        })
      } else {
        throw new Error('EPUBCHECK_REQUIRED')
      }
    }
  }
  await visit(vendorRoot)
  records.sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  )
  assertCapturedDistribution(records)
  return records
}

function capturedDistributionIdentity(records) {
  return records.map(({ path, bytes }) => ({
    path,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  }))
}

function assertCapturedDistribution(records) {
  const identity = capturedDistributionIdentity(records)
  if (
    sha256(JSON.stringify(identity)) !== EPUBCHECK_VENDOR_SHA256 ||
    identity.find((record) => record.path === 'epubcheck.jar')?.sha256 !==
      EPUBCHECK_MAIN_JAR_SHA256
  )
    throw new Error('EPUBCHECK_REQUIRED')
  for (const [index, record] of records.entries()) {
    if (
      record.byteLength !== identity[index].byteLength ||
      record.fileSha256 !== identity[index].sha256
    )
      throw new Error('EPUBCHECK_REQUIRED')
  }
}

async function resolveEpubCheckDistribution() {
  try {
    const packageJsonPath = require.resolve('epubcheck-static/package.json')
    const packageRoot = dirname(packageJsonPath)
    const packageJson = JSON.parse((await readFile(packageJsonPath)).toString())
    if (
      packageJson.name !== EPUBCHECK_PACKAGE ||
      packageJson.version !== EPUBCHECK_PACKAGE_VERSION
    )
      throw new Error('EPUBCHECK_REQUIRED')
    const vendorRoot = resolve(packageRoot, 'vendor')
    const [packageRealPath, vendorRealPath] = await Promise.all([
      realpath(packageRoot),
      realpath(vendorRoot),
    ])
    if (!vendorRealPath.startsWith(`${packageRealPath}${sep}`))
      throw new Error('EPUBCHECK_REQUIRED')
    return { vendorRoot, records: await vendorFiles(vendorRoot) }
  } catch {
    throw new Error('EPUBCHECK_REQUIRED')
  }
}

async function assertProtectedJavaPath(path) {
  let current = path
  while (true) {
    const details = await lstat(current)
    if (
      !privateJavaPathEntryIsProtected(details, {
        launcher: current === path,
      })
    )
      inaccessible()
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

async function resolveJavaRuntime(environment = process.env) {
  if (process.platform === 'win32') throw new Error('EPUBCHECK_REQUIRED')
  const configured = environment.SRT_EPUBCHECK_JAVA_BIN
  const candidate = configured || '/usr/bin/java'
  if (!isAbsolute(candidate)) throw new Error('EPUBCHECK_REQUIRED')
  const expectedSha256 = environment.SRT_EPUBCHECK_JAVA_SHA256
  if (!SHA256.test(expectedSha256 ?? ''))
    throw new Error('EPUBCHECK_REQUIRED')
  if (configured && (await lstat(candidate)).isSymbolicLink())
    throw new Error('EPUBCHECK_REQUIRED')
  const path = await realpath(candidate)
  await assertProtectedJavaPath(path)
  const artifact = await stableRegularFile(path)
  if (artifact.identity.fileSha256 !== expectedSha256)
    throw new Error('EPUBCHECK_REQUIRED')
  const probe = privateCommandResult(path, ['-XshowSettings:properties', '-version'], {
    env: minimalJavaEnvironment(),
    maxBuffer: 64 * 1024,
  })
  const output = Buffer.concat([
    Buffer.isBuffer(probe.stdout) ? probe.stdout : Buffer.alloc(0),
    Buffer.isBuffer(probe.stderr) ? probe.stderr : Buffer.alloc(0),
  ]).toString('utf8')
  const javaHome = /^\s*java\.home\s*=\s*(.+)\s*$/mu.exec(output)?.[1]
  if (probe.error || probe.status !== 0 || !javaHome || !isAbsolute(javaHome))
    throw new Error('EPUBCHECK_REQUIRED')
  const home = await realpath(javaHome)
  const releasePath = resolve(home, 'release')
  const release = await stableRegularFile(releasePath)
  if (!releasePath.startsWith(`${home}${sep}`)) throw new Error('EPUBCHECK_REQUIRED')
  await assertProtectedJavaPath(releasePath)
  return { path, identity: artifact.identity, release: { path: releasePath, identity: release.identity } }
}

async function reverifyJavaRuntime(runtime) {
  await assertProtectedJavaPath(runtime.path)
  await assertProtectedJavaPath(runtime.release.path)
  const current = await stableRegularFile(runtime.path)
  const release = await stableRegularFile(runtime.release.path)
  if (
    !sameIdentity(current.identity, runtime.identity) ||
    current.identity.fileSha256 !== runtime.identity.fileSha256
  )
    throw new Error('EPUBCHECK_FAILED')
  if (
    !sameIdentity(release.identity, runtime.release.identity) ||
    release.identity.fileSha256 !== runtime.release.identity.fileSha256
  )
    throw new Error('EPUBCHECK_FAILED')
}

function minimalJavaEnvironment() {
  return { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }
}

export async function requiredPrivateEpubCheckValidator(options = {}) {
  const distribution = await resolveEpubCheckDistribution()
  const java = await resolveJavaRuntime(options.environment)
  const validator = {
    distribution,
    java,
    runner: options.runner ?? privateCommandResult,
    environment: minimalJavaEnvironment(),
  }
  try {
    await proveJavaRuntime(validator)
  } catch {
    throw new Error('EPUBCHECK_REQUIRED')
  }
  return validator
}

async function anonymousFile(directory, name, bytes) {
  const path = join(directory, name)
  if (!Number.isInteger(fsConstants.O_NOFOLLOW))
    throw new Error('EPUBCHECK_FAILED')
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_RDWR |
    fsConstants.O_NOFOLLOW
  const handle = await open(path, flags, 0o600)
  try {
    const [pathIdentity, handleIdentity] = await Promise.all([
      lstat(path, { bigint: true }),
      handle.stat({ bigint: true }),
    ])
    if (
      pathIdentity.isSymbolicLink() ||
      !pathIdentity.isFile() ||
      pathIdentity.dev !== handleIdentity.dev ||
      pathIdentity.ino !== handleIdentity.ino
    )
      throw new Error('EPUBCHECK_FAILED')
    await unlink(path)
    const unlinkedIdentity = await handle.stat({ bigint: true })
    if (
      unlinkedIdentity.dev !== handleIdentity.dev ||
      unlinkedIdentity.ino !== handleIdentity.ino ||
      unlinkedIdentity.nlink !== 0n
    )
      throw new Error('EPUBCHECK_FAILED')
    let written = 0
    while (written < bytes.byteLength) {
      const result = await handle.write(
        bytes,
        written,
        bytes.byteLength - written,
        written,
      )
      if (result.bytesWritten <= 0) throw new Error('EPUBCHECK_FAILED')
      written += result.bytesWritten
    }
    await handle.sync()
    const writtenIdentity = await handle.stat({ bigint: true })
    const binding = {
      dev: handleIdentity.dev,
      ino: handleIdentity.ino,
      size: BigInt(bytes.byteLength),
      mode: writtenIdentity.mode,
      fileSha256: sha256(bytes),
    }
    await verifyAnonymousFile({ handle, binding })
    return { handle, binding }
  } catch (error) {
    await handle.close()
    try {
      await unlink(path)
    } catch {
      // The normal secure path is already anonymous.
    }
    throw error
  }
}

async function verifyAnonymousFile(snapshot) {
  const details = await snapshot.handle.stat({ bigint: true })
  if (
    !details.isFile() ||
    details.dev !== snapshot.binding.dev ||
    details.ino !== snapshot.binding.ino ||
    details.size !== snapshot.binding.size ||
    details.mode !== snapshot.binding.mode ||
    (details.mode & 0o077n) !== 0n ||
    details.nlink !== 0n
  )
    throw new Error('EPUBCHECK_FAILED')
  const bytes = Buffer.alloc(Number(details.size))
  let read = 0
  while (read < bytes.byteLength) {
    const result = await snapshot.handle.read(
      bytes,
      read,
      bytes.byteLength - read,
      read,
    )
    if (result.bytesRead <= 0) throw new Error('EPUBCHECK_FAILED')
    read += result.bytesRead
  }
  if (sha256(bytes) !== snapshot.binding.fileSha256)
    throw new Error('EPUBCHECK_FAILED')
}

async function proveJavaRuntime(validator) {
  const directory = await mkdtemp(join(tmpdir(), 'srt-private-java-proof-'))
  const handles = []
  try {
    await vendorFiles(validator.distribution.vendorRoot)
    assertCapturedDistribution(validator.distribution.records)
    await reverifyJavaRuntime(validator.java)
    const jars = validator.distribution.records.filter((record) =>
      record.path.endsWith('.jar'),
    )
    for (const [index, jar] of jars.entries())
      handles.push(
        await anonymousFile(directory, `runtime-${index}.jar`, jar.bytes),
      )
    await Promise.all(handles.map(verifyAnonymousFile))
    const descriptorRoot =
      process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'
    const descriptorPaths = handles.map(
      (_handle, index) => `${descriptorRoot}/${index + 3}`,
    )
    const result = validator.runner(
      validator.java.path,
      [
        '-cp',
        descriptorPaths.join(':'),
        'com.adobe.epubcheck.tool.Checker',
        '--version',
      ],
      {
        stdio: [
          'ignore',
          'pipe',
          'pipe',
          ...handles.map((snapshot) => snapshot.handle.fd),
        ],
        timeout: 30_000,
        maxBuffer: 16 * 1024,
        env: validator.environment,
      },
    )
    await Promise.all(handles.map(verifyAnonymousFile))
    await reverifyJavaRuntime(validator.java)
    await vendorFiles(validator.distribution.vendorRoot)
    if (
      result.error ||
      result.status !== 0 ||
      !Buffer.isBuffer(result.stdout) ||
      !result.stdout.equals(Buffer.from('EPUBCheck v5.3.0\n')) ||
      !Buffer.isBuffer(result.stderr) ||
      result.stderr.byteLength !== 0
    )
      throw new Error('EPUBCHECK_REQUIRED')
  } finally {
    await Promise.all(handles.map((snapshot) => snapshot.handle.close()))
    await rm(directory, { recursive: true, force: true })
  }
}

/** @returns {Promise<{ status: 'passed', javaSha256: string, jreReleaseSha256: string }>} */
export async function validatePrivateEpubWithEpubCheck(bytes, validator) {
  const directory = await mkdtemp(join(tmpdir(), 'srt-private-epubcheck-'))
  const handles = []
  try {
    await vendorFiles(validator.distribution.vendorRoot)
    assertCapturedDistribution(validator.distribution.records)
    await reverifyJavaRuntime(validator.java)

    const jars = validator.distribution.records.filter((record) =>
      record.path.endsWith('.jar'),
    )
    for (const [index, jar] of jars.entries())
      handles.push(
        await anonymousFile(directory, `runtime-${index}.jar`, jar.bytes),
      )
    handles.push(await anonymousFile(directory, 'publication.epub', bytes))
    await Promise.all(handles.map(verifyAnonymousFile))
    const descriptorRoot =
      process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'
    const descriptorPaths = handles.map(
      (_handle, index) => `${descriptorRoot}/${index + 3}`,
    )
    const result = validator.runner(
      validator.java.path,
      [
        '-cp',
        descriptorPaths.slice(0, -1).join(':'),
        'com.adobe.epubcheck.tool.Checker',
        '--failonwarnings',
        descriptorPaths.at(-1),
      ],
      {
        stdio: [
          'ignore',
          'ignore',
          'ignore',
          ...handles.map((snapshot) => snapshot.handle.fd),
        ],
        timeout: 120_000,
        env: validator.environment,
      },
    )
    await Promise.all(handles.map(verifyAnonymousFile))
    await reverifyJavaRuntime(validator.java)
    await vendorFiles(validator.distribution.vendorRoot)
    if (result.error || result.status !== 0) throw new Error('EPUBCHECK_FAILED')
    return {
      status: 'passed',
      javaSha256: validator.java.identity.fileSha256,
      jreReleaseSha256: validator.java.release.identity.fileSha256,
    }
  } catch {
    throw new Error('EPUBCHECK_FAILED')
  } finally {
    await Promise.all(handles.map((snapshot) => snapshot.handle.close()))
    await rm(directory, { recursive: true, force: true })
  }
}
