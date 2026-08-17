import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

const MAX_BOUND_FILES = 100_000
const MAX_BOUND_FILE_BYTES = 64 * 1024 * 1024
const MAX_BOUND_TOTAL_BYTES = 3 * 1024 * 1024 * 1024

export class ToolIntegrityError extends Error {
  constructor() {
    super('The trusted executable changed after it was bound.')
    this.name = 'ToolIntegrityError'
    this.code = 'TOOL_INTEGRITY_FAILED'
  }
}

function fail() {
  throw new ToolIntegrityError()
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

async function regularFileIdentity(filePath, requireExecutable) {
  if (!path.isAbsolute(filePath)) fail()
  const canonicalPath = await realpath(filePath).catch(() => null)
  const requestedMetadata = await lstat(filePath).catch(() => null)
  if (!canonicalPath || requestedMetadata?.isSymbolicLink()) fail()
  const metadata = await lstat(canonicalPath).catch(() => null)
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_BOUND_FILE_BYTES ||
    (requireExecutable && (metadata.mode & 0o111) === 0)
  ) {
    fail()
  }

  let handle
  try {
    handle = await open(
      canonicalPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    )
    const before = await handle.stat()
    const bytes = await handle.readFile()
    const after = await handle.stat()
    const currentPath = await lstat(canonicalPath)
    if (
      !before.isFile() ||
      bytes.byteLength !== before.size ||
      before.dev !== metadata.dev ||
      before.ino !== metadata.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      !currentPath.isFile() ||
      currentPath.isSymbolicLink() ||
      currentPath.dev !== after.dev ||
      currentPath.ino !== after.ino
    ) {
      fail()
    }
    return Object.freeze({
      path: canonicalPath,
      dev: before.dev,
      ino: before.ino,
      mode: before.mode & 0o777,
      size: before.size,
      sha256: sha256(bytes),
    })
  } catch (error) {
    if (error instanceof ToolIntegrityError) throw error
    fail()
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function bindExecutable(filePath) {
  return await regularFileIdentity(path.resolve(filePath), true)
}

export async function verifyExecutable(binding) {
  if (!binding || typeof binding !== 'object') fail()
  const observed = await regularFileIdentity(binding.path, true)
  if (
    observed.path !== binding.path ||
    observed.dev !== binding.dev ||
    observed.ino !== binding.ino ||
    observed.mode !== binding.mode ||
    observed.size !== binding.size ||
    observed.sha256 !== binding.sha256
  ) {
    fail()
  }
  return binding.path
}

async function treeDigest(rootPath) {
  const root = await realpath(rootPath).catch(() => null)
  const requestedRootMetadata = await lstat(rootPath).catch(() => null)
  const rootMetadata = root ? await lstat(root).catch(() => null) : null
  if (
    !root ||
    requestedRootMetadata?.isSymbolicLink() ||
    !rootMetadata?.isDirectory() ||
    rootMetadata.isSymbolicLink()
  ) {
    fail()
  }

  const records = []
  let fileCount = 0
  let totalBytes = 0
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink()) fail()
      if (metadata.isDirectory()) {
        records.push({
          path: `${relativePath}/`,
          mode: metadata.mode & 0o777,
        })
        await visit(absolutePath, relativePath)
        continue
      }
      if (!metadata.isFile() || metadata.size > MAX_BOUND_FILE_BYTES) fail()
      fileCount += 1
      totalBytes += metadata.size
      if (
        fileCount > MAX_BOUND_FILES ||
        totalBytes > MAX_BOUND_TOTAL_BYTES
      ) {
        fail()
      }
      const identity = await regularFileIdentity(absolutePath, false)
      records.push({
        path: relativePath,
        mode: identity.mode,
        size: identity.size,
        sha256: identity.sha256,
      })
    }
  }
  await visit(root, '')
  if (fileCount === 0) fail()
  return {
    root,
    sha256: sha256(Buffer.from(JSON.stringify(records))),
    fileCount,
    totalBytes,
  }
}

export async function bindToolTree(rootPath, executablePath) {
  const tree = await treeDigest(rootPath)
  const executable = await bindExecutable(executablePath)
  if (!isWithin(tree.root, executable.path)) fail()
  return Object.freeze({
    root: tree.root,
    treeSha256: tree.sha256,
    fileCount: tree.fileCount,
    totalBytes: tree.totalBytes,
    executable,
  })
}

export async function verifyToolTree(binding) {
  if (!binding || typeof binding !== 'object') fail()
  const observed = await treeDigest(binding.root)
  if (
    observed.root !== binding.root ||
    observed.sha256 !== binding.treeSha256 ||
    observed.fileCount !== binding.fileCount ||
    observed.totalBytes !== binding.totalBytes
  ) {
    fail()
  }
  await verifyExecutable(binding.executable)
  return binding.executable.path
}

export async function runIntegrityBound(binding, operation) {
  if (typeof operation !== 'function') fail()
  await verifyToolTree(binding)
  let result
  let operationError
  try {
    result = await operation(binding.executable.path)
  } catch (error) {
    operationError = error
  }
  await verifyToolTree(binding)
  if (operationError) throw operationError
  return result
}
