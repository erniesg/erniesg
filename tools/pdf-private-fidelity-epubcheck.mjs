import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
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
  const identity = records.map(({ path, byteLength, fileSha256 }) => ({
    path,
    byteLength,
    sha256: fileSha256,
  }))
  if (
    sha256(JSON.stringify(identity)) !== EPUBCHECK_VENDOR_SHA256 ||
    records.find((record) => record.path === 'epubcheck.jar')?.fileSha256 !==
      EPUBCHECK_MAIN_JAR_SHA256
  )
    throw new Error('EPUBCHECK_REQUIRED')
  return records
}

async function resolveEpubCheckDistribution() {
  try {
    const packageJsonPath = require.resolve(`${EPUBCHECK_PACKAGE}/package.json`)
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
  let current = dirname(path)
  while (true) {
    const details = await stat(current)
    const writableByCurrentUser =
      typeof process.getuid === 'function' &&
      details.uid === process.getuid() &&
      (details.mode & 0o200) !== 0
    if (writableByCurrentUser || (details.mode & 0o022) !== 0)
      throw new Error('EPUBCHECK_REQUIRED')
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
  if (Boolean(configured) !== Boolean(expectedSha256))
    throw new Error('EPUBCHECK_REQUIRED')
  if (configured && (await lstat(candidate)).isSymbolicLink())
    throw new Error('EPUBCHECK_REQUIRED')
  const path = await realpath(candidate)
  await assertProtectedJavaPath(path)
  const artifact = await stableRegularFile(path)
  if (
    expectedSha256 !== undefined &&
    (!SHA256.test(expectedSha256) ||
      artifact.identity.fileSha256 !== expectedSha256)
  )
    throw new Error('EPUBCHECK_REQUIRED')
  return { path, identity: artifact.identity }
}

async function reverifyJavaRuntime(runtime) {
  const current = await stableRegularFile(runtime.path)
  if (
    !sameIdentity(current.identity, runtime.identity) ||
    current.identity.fileSha256 !== runtime.identity.fileSha256
  )
    throw new Error('EPUBCHECK_FAILED')
}

function sanitizedJavaEnvironment(environment = process.env) {
  const blocked = new Set([
    'JAVA_TOOL_OPTIONS',
    '_JAVA_OPTIONS',
    'JDK_JAVA_OPTIONS',
    'CLASSPATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
  ])
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !blocked.has(name)),
  )
}

export async function requiredPrivateEpubCheckValidator(options = {}) {
  const distribution = await resolveEpubCheckDistribution()
  const java = options.java ?? (await resolveJavaRuntime(options.environment))
  return {
    distribution,
    java,
    runner: options.runner ?? privateCommandResult,
    environment: sanitizedJavaEnvironment(options.environment),
  }
}

async function anonymousFile(directory, name, bytes) {
  const path = join(directory, name)
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  const handle = await open(path, 'r')
  await unlink(path)
  return handle
}

/** @returns {Promise<{ status: 'passed' }>} */
export async function validatePrivateEpubWithEpubCheck(bytes, validator) {
  const directory = await mkdtemp(join(tmpdir(), 'srt-private-epubcheck-'))
  const handles = []
  try {
    await vendorFiles(validator.distribution.vendorRoot)
    await reverifyJavaRuntime(validator.java)

    const jars = validator.distribution.records.filter((record) =>
      record.path.endsWith('.jar'),
    )
    for (const [index, jar] of jars.entries())
      handles.push(
        await anonymousFile(directory, `runtime-${index}.jar`, jar.bytes),
      )
    handles.push(await anonymousFile(directory, 'publication.epub', bytes))
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
          ...handles.map((handle) => handle.fd),
        ],
        timeout: 120_000,
        env: validator.environment,
      },
    )
    await reverifyJavaRuntime(validator.java)
    await vendorFiles(validator.distribution.vendorRoot)
    if (result.error || result.status !== 0) throw new Error('EPUBCHECK_FAILED')
    return { status: 'passed' }
  } catch {
    throw new Error('EPUBCHECK_FAILED')
  } finally {
    await Promise.all(handles.map((handle) => handle.close()))
    await rm(directory, { recursive: true, force: true })
  }
}
