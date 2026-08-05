import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'parse5'

const HELPER_PATH = fileURLToPath(import.meta.url)
const REPOSITORY_ROOT = resolve(dirname(HELPER_PATH), '..')
const BROWSER_CACHE = resolve(
  REPOSITORY_ROOT,
  'node_modules/.cache/publication-browsers',
)
const VIVLIOSTYLE_CLI = resolve(
  REPOSITORY_ROOT,
  'node_modules/@vivliostyle/cli/dist/cli.js',
)
const VIVLIOSTYLE_PACKAGE = resolve(
  REPOSITORY_ROOT,
  'node_modules/@vivliostyle/cli/package.json',
)
const PLAYWRIGHT_PACKAGE = resolve(
  REPOSITORY_ROOT,
  'node_modules/playwright/package.json',
)
const NODE_EXECUTABLE = '/usr/bin/node'
const ISOLATION_DIAGNOSTIC_SOURCE = String.raw`
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createSocket } from 'node:dgram'
import { request as httpRequest } from 'node:http'
import { createServer, connect } from 'node:net'

const input = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'))
const attempted = [
  'tcp-ipv4',
  'tcp-ipv6',
  'http-ipv4',
  'http-ipv6',
  'websocket-ipv4',
  'websocket-ipv6',
  'udp-ipv4',
  'udp-ipv6',
]

function tcp(host, port, websocket = false) {
  return new Promise((accept) => {
    let settled = false
    const socket = connect({ host, port })
    const finish = (connected) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      accept(connected)
    }
    const timeout = setTimeout(() => finish(false), 400)
    socket.once('connect', () => {
      if (!websocket) {
        finish(true)
        return
      }
      socket.end(
        'GET /publication-isolation-probe HTTP/1.1\r\nHost: sentinel\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: cHVibGljYXRpb24tcHJvYmU=\r\n\r\n',
        () => finish(true),
      )
    })
    socket.once('error', () => finish(false))
  })
}

function http(host, port) {
  return new Promise((accept) => {
    const request = httpRequest(
      { host, port, path: '/publication-isolation-probe', timeout: 400 },
      (response) => {
        response.resume()
        accept()
      },
    )
    request.once('timeout', () => request.destroy())
    request.once('error', () => accept())
    request.end()
  })
}

function udp(type, host, port) {
  return new Promise((accept) => {
    const socket = createSocket(type)
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        // The error path can close the socket before the send callback.
      }
      accept()
    }
    socket.send(Buffer.from('publication-isolation-probe'), port, host, finish)
    socket.once('error', finish)
  })
}

function listen(host) {
  return new Promise((accept, reject) => {
    const server = createServer((socket) => socket.end())
    server.once('error', reject)
    server.listen(0, host, () => accept(server))
  })
}

function close(server) {
  return new Promise((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  )
}

const filesystemDiagnostics = []
for (const path of input.filesystemDiagnosticPaths) {
  let inaccessible = false
  try {
    await access(path, constants.R_OK)
  } catch {
    inaccessible = true
  }
  filesystemDiagnostics.push({ path, inaccessible })
}
if (filesystemDiagnostics.some(({ inaccessible }) => !inaccessible))
  throw new Error('A filesystem isolation sentinel remained accessible')

let networkDiagnostic = null
if (input.networkDiagnostic) {
  const server4 = await listen('127.0.0.1')
  const server6 = await listen('::1')
  try {
    const address4 = server4.address()
    const address6 = server6.address()
    const [ipv4, ipv6] = await Promise.all([
      tcp('127.0.0.1', address4.port),
      tcp('::1', address6.port),
    ])
    const ports = input.networkDiagnostic
    await Promise.all([
      tcp('127.0.0.1', ports.tcpIpv4Port),
      tcp('::1', ports.tcpIpv6Port),
      http('127.0.0.1', ports.httpIpv4Port),
      http('::1', ports.httpIpv6Port),
      tcp('127.0.0.1', ports.websocketIpv4Port, true),
      tcp('::1', ports.websocketIpv6Port, true),
      udp('udp4', '127.0.0.1', ports.udpIpv4Port),
      udp('udp6', '::1', ports.udpIpv6Port),
    ])
    networkDiagnostic = {
      attempted,
      privateLoopback: { ipv4, ipv6 },
    }
  } finally {
    await Promise.all([close(server4), close(server6)])
  }
}
if (
  networkDiagnostic &&
  (!networkDiagnostic.privateLoopback.ipv4 ||
    !networkDiagnostic.privateLoopback.ipv6)
)
  throw new Error('Private loopback communication failed')
process.stdout.write(JSON.stringify({ filesystemDiagnostics, networkDiagnostic }))
`
const REQUEST_FIELDS = [
  'browserPath',
  'expectedBrowserVersion',
  'expectedEnvironmentSha256',
  'expectedGid',
  'expectedNodeVersion',
  'expectedRendererVersion',
  'expectedUid',
  'filesystemDiagnosticPaths',
  'hostMountNamespace',
  'hostNetworkNamespace',
  'inputPath',
  'networkDiagnostic',
  'outputPath',
  'proofPath',
  'publicationRoot',
  'renderer',
  'runtimeEntries',
  'size',
  'stagingDirectory',
  'version',
]

function isPathInside(root, path) {
  const child = relative(root, path)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..')
}

function assertRenderRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('Publication render request must be an object')
  const fields = Object.keys(request).sort()
  const unexpected = fields.filter((field) => !REQUEST_FIELDS.includes(field))
  const missing = REQUEST_FIELDS.filter((field) => !fields.includes(field))
  if (unexpected.length)
    throw new Error(`Unexpected request field: ${unexpected.join(', ')}`)
  if (missing.length)
    throw new Error(`Missing request field: ${missing.join(', ')}`)
  if (request.version !== 2)
    throw new Error('Unsupported publication render request version')
  if (!['vivliostyle-cli', 'playwright-chromium'].includes(request.renderer))
    throw new Error('Unsupported publication renderer request')
  if (!['A4', 'A5'].includes(request.size))
    throw new Error('Unsupported publication page size')
  for (const field of [
    'publicationRoot',
    'stagingDirectory',
    'inputPath',
    'outputPath',
    'proofPath',
    'browserPath',
  ])
    if (typeof request[field] !== 'string' || !isAbsolute(request[field]))
      throw new Error(`${field} must be an absolute path`)
  if (!isPathInside(request.publicationRoot, request.inputPath))
    throw new Error('Publication HTML must be inside the publication root')
  if (!isPathInside(request.publicationRoot, request.stagingDirectory))
    throw new Error('Publication staging must be inside the publication root')
  if (!isPathInside(request.stagingDirectory, request.outputPath))
    throw new Error('Publication PDF must be inside private staging')
  if (!isPathInside(request.stagingDirectory, request.proofPath))
    throw new Error('Publication proof must be inside private staging')
  if (!isPathInside(BROWSER_CACHE, request.browserPath))
    throw new Error('Publication browser must be inside the pinned cache')
  if (extname(request.inputPath).toLowerCase() !== '.html')
    throw new Error('Publication input must be HTML')
  if (extname(request.outputPath).toLowerCase() !== '.pdf')
    throw new Error('Publication output must be PDF')
  if (extname(request.proofPath).toLowerCase() !== '.json')
    throw new Error('Publication proof must be JSON')
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(request.expectedBrowserVersion))
    throw new Error('Expected browser version is invalid')
  if (!/^\d+\.\d+\.\d+$/.test(request.expectedRendererVersion))
    throw new Error('Expected renderer version is invalid')
  if (!/^\d+\.\d+\.\d+$/.test(request.expectedNodeVersion))
    throw new Error('Expected Node version is invalid')
  if (!/^[a-f0-9]{64}$/.test(request.expectedEnvironmentSha256))
    throw new Error('Expected environment digest is invalid')
  if (
    !Number.isSafeInteger(request.expectedUid) ||
    request.expectedUid < 1 ||
    !Number.isSafeInteger(request.expectedGid) ||
    request.expectedGid < 1
  )
    throw new Error('Expected caller identity is invalid')
  if (!/^net:\[\d+\]$/.test(request.hostNetworkNamespace))
    throw new Error('Host network namespace identity is invalid')
  if (!/^mnt:\[\d+\]$/.test(request.hostMountNamespace))
    throw new Error('Host mount namespace identity is invalid')
  assertRuntimeEntries(request)
  if (
    request.networkDiagnostic !== null &&
    (!request.networkDiagnostic ||
      typeof request.networkDiagnostic !== 'object' ||
      JSON.stringify(Object.keys(request.networkDiagnostic).sort()) !==
        JSON.stringify(
          [
            'httpIpv4Port',
            'httpIpv6Port',
            'tcpIpv4Port',
            'tcpIpv6Port',
            'udpIpv4Port',
            'udpIpv6Port',
            'websocketIpv4Port',
            'websocketIpv6Port',
          ].sort(),
        ) ||
      Object.values(request.networkDiagnostic).some(
        (port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535,
      ))
  )
    throw new Error('Publication network diagnostic is invalid')
  if (
    !Array.isArray(request.filesystemDiagnosticPaths) ||
    request.filesystemDiagnosticPaths.length > 8 ||
    request.filesystemDiagnosticPaths.some(
      (path) =>
        typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/u.test(path),
    )
  )
    throw new Error('Publication filesystem diagnostics are invalid')
  return request
}

export function authenticatePublicationRequest(serialized, expectedDigest) {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest))
    throw new Error('Publication request digest is invalid')
  const actualDigest = createHash('sha256').update(serialized).digest('hex')
  if (actualDigest !== expectedDigest)
    throw new Error('Publication request digest does not match')
  let request
  try {
    request = JSON.parse(serialized)
  } catch (error) {
    throw new Error(`Publication request is not valid JSON: ${String(error)}`)
  }
  return assertRenderRequest(request)
}

export function publicationChildEnvironment(_publicationRoot) {
  return {
    HOME: '/tmp',
    TMPDIR: '/tmp',
    XDG_CACHE_HOME: '/tmp/.cache',
    PATH: '/usr/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NODE_ENV: 'production',
    TZ: 'UTC',
    SOURCE_DATE_EPOCH: '946684800',
    NO_PROXY: '*',
    no_proxy: '*',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
  }
}

function publicationEnvironmentSha256(environment) {
  return createHash('sha256')
    .update(JSON.stringify(Object.entries(environment).sort()))
    .digest('hex')
}

function lexicalEntryOrder(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

function sameRuntimeIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  )
}

function runtimeClosureRoot(roots, path) {
  const root = roots.find((candidate) => isPathInside(candidate, path))
  if (!root)
    throw new Error(
      `Publication runtime symlink target is outside every authenticated runtime root: ${path}`,
    )
  return root
}

async function resolveRuntimeSymlinkTarget(linkPath, target, roots) {
  let path = resolve(dirname(linkPath), target)
  let root = runtimeClosureRoot(roots, path)
  let current = root
  let remaining = relative(root, path).split(sep).filter(Boolean)
  let followedLinks = 0
  while (remaining.length) {
    const candidate = resolve(current, remaining.shift())
    const before = await lstat(candidate, { bigint: true })
    if (before.isSymbolicLink()) {
      followedLinks += 1
      if (followedLinks > 40)
        throw new Error(
          `Publication runtime symlink chain is too deep: ${linkPath}`,
        )
      const nestedTarget = await readlink(candidate)
      const after = await lstat(candidate, { bigint: true })
      if (!sameRuntimeIdentity(before, after))
        throw new Error(
          `Publication runtime link changed while resolving: ${candidate}`,
        )
      path = resolve(dirname(candidate), nestedTarget)
      root = runtimeClosureRoot(roots, path)
      current = root
      remaining = [
        ...relative(root, path).split(sep).filter(Boolean),
        ...remaining,
      ]
      continue
    }
    if (remaining.length && !before.isDirectory())
      throw new Error(
        `Publication runtime symlink target is invalid: ${linkPath}`,
      )
    current = candidate
  }
  const canonical = await realpath(linkPath)
  if (
    canonical !== current ||
    !roots.some((root) => isPathInside(root, canonical))
  )
    throw new Error(
      `Publication runtime symlink target is outside every authenticated runtime root: ${linkPath}`,
    )
  return canonical
}

async function hashRuntimeFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile())
      throw new Error(`Publication runtime path is not a regular file: ${path}`)
    const digest = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      digest.update(chunk)
    const after = await handle.stat({ bigint: true })
    if (!sameRuntimeIdentity(before, after))
      throw new Error(`Publication runtime file changed while hashing: ${path}`)
    return { metadata: before, sha256: digest.digest('hex') }
  } finally {
    await handle.close()
  }
}

async function runtimeParentIdentity(path) {
  const parentPath = await realpath(dirname(path))
  const metadata = await stat(parentPath, { bigint: true })
  if (!metadata.isDirectory())
    throw new Error(
      `Publication runtime parent is not a directory: ${parentPath}`,
    )
  return {
    parentPath,
    parentDevice: metadata.dev.toString(),
    parentInode: metadata.ino.toString(),
    parentCtimeNanoseconds: metadata.ctimeNs.toString(),
  }
}

async function attestRuntimeFile(label, path) {
  if ((await realpath(path)) !== path)
    throw new Error(`Publication runtime file is not canonical: ${path}`)
  const [{ metadata, sha256 }, parent] = await Promise.all([
    hashRuntimeFile(path),
    runtimeParentIdentity(path),
  ])
  return {
    kind: 'file',
    label,
    path,
    sha256,
    byteLength: metadata.size.toString(),
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    ctimeNanoseconds: metadata.ctimeNs.toString(),
    mode: (metadata.mode & 0o777n).toString(8),
    ...parent,
  }
}

async function inspectRuntimeTree(path, hashContents, closureRoots = [path]) {
  if ((await realpath(path)) !== path)
    throw new Error(`Publication runtime tree is not canonical: ${path}`)
  const before = await stat(path, { bigint: true })
  if (!before.isDirectory())
    throw new Error(`Publication runtime tree is not a directory: ${path}`)
  const contentDigest = createHash('sha256')
  const identityDigest = createHash('sha256')
  let entryCount = 0
  const visit = async (directory) => {
    const directoryBefore = await lstat(directory, { bigint: true })
    if (!directoryBefore.isDirectory())
      throw new Error(
        `Publication runtime tree entry is not a directory: ${directory}`,
      )
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      lexicalEntryOrder,
    )
    for (const entry of entries) {
      const entryPath = resolve(directory, entry.name)
      const relativePath = relative(path, entryPath).split(sep).join('/')
      const metadata = await lstat(entryPath, { bigint: true })
      entryCount += 1
      if (metadata.isDirectory()) {
        const identity = [
          'directory',
          relativePath,
          metadata.dev.toString(),
          metadata.ino.toString(),
          metadata.mode.toString(),
          metadata.size.toString(),
          metadata.ctimeNs.toString(),
        ]
        identityDigest.update(`${JSON.stringify(identity)}\n`)
        contentDigest.update(
          `${JSON.stringify(['directory', relativePath, metadata.mode.toString(), metadata.ctimeNs.toString()])}\n`,
        )
        await visit(entryPath)
      } else if (metadata.isFile()) {
        const file = hashContents
          ? await hashRuntimeFile(entryPath)
          : { metadata, sha256: '' }
        if (!sameRuntimeIdentity(metadata, file.metadata))
          throw new Error(
            `Publication runtime file changed while inspecting: ${entryPath}`,
          )
        identityDigest.update(
          `${JSON.stringify([
            'file',
            relativePath,
            file.metadata.dev.toString(),
            file.metadata.ino.toString(),
            file.metadata.mode.toString(),
            file.metadata.size.toString(),
            file.metadata.ctimeNs.toString(),
          ])}\n`,
        )
        if (hashContents)
          contentDigest.update(
            `${JSON.stringify(['file', relativePath, file.metadata.mode.toString(), file.metadata.size.toString(), file.metadata.ctimeNs.toString(), file.sha256])}\n`,
          )
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(entryPath)
        const afterLink = await lstat(entryPath, { bigint: true })
        if (!sameRuntimeIdentity(metadata, afterLink))
          throw new Error(
            `Publication runtime link changed while inspecting: ${entryPath}`,
          )
        const canonicalTarget = await resolveRuntimeSymlinkTarget(
          entryPath,
          target,
          closureRoots,
        )
        const identity = [
          'symlink',
          relativePath,
          metadata.dev.toString(),
          metadata.ino.toString(),
          metadata.mode.toString(),
          metadata.size.toString(),
          metadata.ctimeNs.toString(),
          target,
          canonicalTarget,
        ]
        identityDigest.update(`${JSON.stringify(identity)}\n`)
        contentDigest.update(
          `${JSON.stringify(['symlink', relativePath, metadata.ctimeNs.toString(), target, canonicalTarget])}\n`,
        )
      } else {
        throw new Error(
          `Unsupported publication runtime tree entry: ${entryPath}`,
        )
      }
    }
    const directoryAfter = await lstat(directory, { bigint: true })
    if (!sameRuntimeIdentity(directoryBefore, directoryAfter))
      throw new Error(
        `Publication runtime directory changed while inspecting: ${directory}`,
      )
  }
  await visit(path)
  const after = await stat(path, { bigint: true })
  if (!sameRuntimeIdentity(before, after))
    throw new Error(`Publication runtime tree changed while hashing: ${path}`)
  const parent = await runtimeParentIdentity(path)
  return {
    sha256: hashContents ? contentDigest.digest('hex') : '',
    identitySha256: identityDigest.digest('hex'),
    entryCount,
    device: before.dev.toString(),
    inode: before.ino.toString(),
    ctimeNanoseconds: before.ctimeNs.toString(),
    ...parent,
  }
}

async function attestRuntimeTree(label, path) {
  return {
    kind: 'tree',
    label,
    path,
    ...(await inspectRuntimeTree(path, true)),
  }
}

async function inspectRuntimeForest(paths, hashContents) {
  const contentDigest = createHash('sha256')
  const identityDigest = createHash('sha256')
  let entryCount = 0
  for (const path of paths) {
    const tree = await inspectRuntimeTree(path, hashContents, paths)
    entryCount += tree.entryCount
    identityDigest.update(
      `${JSON.stringify([
        path,
        tree.identitySha256,
        tree.entryCount,
        tree.device,
        tree.inode,
        tree.ctimeNanoseconds,
        tree.parentPath,
        tree.parentDevice,
        tree.parentInode,
        tree.parentCtimeNanoseconds,
      ])}\n`,
    )
    if (hashContents)
      contentDigest.update(
        `${JSON.stringify([path, tree.sha256, tree.entryCount])}\n`,
      )
  }
  return {
    sha256: hashContents ? contentDigest.digest('hex') : '',
    identitySha256: identityDigest.digest('hex'),
    entryCount,
  }
}

export async function attestRuntimeForest(label, paths) {
  return {
    kind: 'forest',
    label,
    paths,
    ...(await inspectRuntimeForest(paths, true)),
  }
}

function expectedRuntimeEntries(request) {
  return [
    ['tree', 'browser-runtime', dirname(request.browserPath)],
    ['file', 'isolation-helper', HELPER_PATH],
    ['file', 'node-executable', NODE_EXECUTABLE],
    ['forest', 'runtime-package-closure', null],
  ].sort((left, right) => left[1].localeCompare(right[1]))
}

function assertRuntimeEntries(request) {
  if (!Array.isArray(request.runtimeEntries))
    throw new Error('Publication runtime attestation list is invalid')
  const expected = expectedRuntimeEntries(request)
  if (
    JSON.stringify(
      request.runtimeEntries.map(({ kind, label, path }) => [
        kind,
        label,
        kind === 'forest' ? null : path,
      ]),
    ) !== JSON.stringify(expected)
  )
    throw new Error('Publication runtime attestation paths are incomplete')
  const closure = request.runtimeEntries.find(({ kind }) => kind === 'forest')
  const nodeModules = resolve(REPOSITORY_ROOT, 'node_modules')
  const requiredPackages = [
    resolve(nodeModules, 'parse5'),
    ...(request.renderer === 'vivliostyle-cli'
      ? [resolve(nodeModules, '@vivliostyle/cli')]
      : [
          resolve(nodeModules, 'playwright'),
          resolve(nodeModules, 'playwright-core'),
        ]),
  ]
  if (
    !closure ||
    !Array.isArray(closure.paths) ||
    closure.paths.length < requiredPackages.length ||
    closure.paths.length > 1024 ||
    JSON.stringify(closure.paths) !==
      JSON.stringify([...new Set(closure.paths)].sort()) ||
    requiredPackages.some((path) => !closure.paths.includes(path)) ||
    closure.paths.some(
      (path) =>
        typeof path !== 'string' ||
        !isAbsolute(path) ||
        !isPathInside(nodeModules, path) ||
        isPathInside(BROWSER_CACHE, path),
    ) ||
    closure.paths.some((path, index) =>
      closure.paths.some(
        (possibleParent, parentIndex) =>
          index !== parentIndex && isPathInside(possibleParent, path),
      ),
    )
  )
    throw new Error('Publication runtime package closure is invalid')
  const sharedFields = [
    'ctimeNanoseconds',
    'device',
    'inode',
    'kind',
    'label',
    'parentCtimeNanoseconds',
    'parentDevice',
    'parentInode',
    'parentPath',
    'path',
    'sha256',
  ]
  for (const entry of request.runtimeEntries) {
    if (entry.kind === 'forest') {
      if (
        JSON.stringify(Object.keys(entry).sort()) !==
          JSON.stringify(
            [
              'entryCount',
              'identitySha256',
              'kind',
              'label',
              'paths',
              'sha256',
            ].sort(),
          ) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !/^[a-f0-9]{64}$/.test(entry.identitySha256) ||
        !Number.isSafeInteger(entry.entryCount) ||
        entry.entryCount < entry.paths.length
      )
        throw new Error('Publication runtime attestation is invalid')
      continue
    }
    const expectedFields = [
      ...sharedFields,
      ...(entry.kind === 'file'
        ? ['byteLength', 'mode']
        : ['entryCount', 'identitySha256']),
    ].sort()
    if (
      !['file', 'tree'].includes(entry.kind) ||
      JSON.stringify(Object.keys(entry).sort()) !==
        JSON.stringify(expectedFields) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      (entry.kind === 'tree' && !/^[a-f0-9]{64}$/.test(entry.identitySha256)) ||
      !/^\d+$/.test(entry.device) ||
      !/^\d+$/.test(entry.inode) ||
      !/^\d+$/.test(entry.ctimeNanoseconds) ||
      !/^\d+$/.test(entry.parentDevice) ||
      !/^\d+$/.test(entry.parentInode) ||
      !/^\d+$/.test(entry.parentCtimeNanoseconds) ||
      (entry.kind === 'file' &&
        (!/^\d+$/.test(entry.byteLength) ||
          !/^[0-7]{3,4}$/.test(entry.mode))) ||
      (entry.kind === 'tree' &&
        (!Number.isSafeInteger(entry.entryCount) || entry.entryCount < 1))
    )
      throw new Error('Publication runtime attestation is invalid')
  }
}

export async function verifyRuntimeEntries(expected) {
  await Promise.all(
    expected.map(async (entry) => {
      if (entry.kind === 'file') {
        const actual = await attestRuntimeFile(entry.label, entry.path)
        if (JSON.stringify(actual) !== JSON.stringify(entry))
          throw new Error('Publication runtime attestation changed')
        return
      }
      if (entry.kind === 'tree') {
        const actual = await inspectRuntimeTree(entry.path, false)
        if (
          actual.identitySha256 !== entry.identitySha256 ||
          actual.entryCount !== entry.entryCount ||
          actual.device !== entry.device ||
          actual.inode !== entry.inode ||
          actual.ctimeNanoseconds !== entry.ctimeNanoseconds ||
          actual.parentPath !== entry.parentPath ||
          actual.parentDevice !== entry.parentDevice ||
          actual.parentInode !== entry.parentInode ||
          actual.parentCtimeNanoseconds !== entry.parentCtimeNanoseconds
        )
          throw new Error('Publication runtime attestation changed')
        return
      }
      const actual = await inspectRuntimeForest(entry.paths, false)
      if (
        actual.identitySha256 !== entry.identitySha256 ||
        actual.entryCount !== entry.entryCount
      )
        throw new Error('Publication runtime attestation changed')
    }),
  )
}

export async function assertPublicationResourceUrl(url, referrerPath, root) {
  if (url.startsWith('#')) return null
  let parsed
  try {
    parsed = new URL(url, pathToFileURL(referrerPath).href)
  } catch {
    throw new Error(`Disallowed publication resource URL: ${url}`)
  }
  if (parsed.protocol !== 'file:')
    throw new Error(
      `Disallowed publication resource scheme ${parsed.protocol || '(missing)'}`,
    )
  let path
  try {
    path = await realpath(fileURLToPath(parsed))
  } catch (error) {
    throw new Error(
      `Publication resource is unavailable: ${url}: ${String(error)}`,
    )
  }
  const canonicalRoot = await realpath(root)
  if (!isPathInside(canonicalRoot, path))
    throw new Error(`Publication resource is outside publication root: ${url}`)
  if (!(await stat(path)).isFile())
    throw new Error(`Publication resource is not a regular file: ${url}`)
  return path
}

function attributes(node) {
  return new Map(
    (node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]),
  )
}

function htmlResourceReferences(document) {
  const references = []
  const styles = []
  const visit = (node) => {
    const tag = node.tagName?.toLowerCase()
    const attrs = attributes(node)
    if ([...attrs.keys()].some((name) => name.startsWith('on')))
      throw new Error(`Disallowed active publication attribute on ${tag}`)
    if (['script', 'iframe', 'object', 'embed', 'base'].includes(tag))
      throw new Error(`Disallowed active publication element: ${tag}`)
    if (tag === 'meta' && attrs.get('http-equiv')?.toLowerCase() === 'refresh')
      throw new Error('Disallowed publication refresh directive')
    const resourceAttributes = []
    if (tag === 'link') resourceAttributes.push('href')
    if (['img', 'source', 'audio', 'video', 'track'].includes(tag))
      resourceAttributes.push('src')
    if (tag === 'video') resourceAttributes.push('poster')
    if (tag === 'input' && attrs.get('type')?.toLowerCase() === 'image')
      resourceAttributes.push('src')
    if (attrs.get('background')) resourceAttributes.push('background')
    if (
      ['image', 'use'].includes(tag) ||
      (node.namespaceURI === 'http://www.w3.org/2000/svg' && tag !== 'a')
    )
      resourceAttributes.push('href', 'xlink:href')
    for (const name of resourceAttributes) {
      const value = attrs.get(name)
      if (value) references.push(value)
    }
    const srcset = attrs.get('srcset')
    if (srcset)
      for (const candidate of srcset.split(',')) {
        const value = candidate.trim().split(/\s+/u)[0]
        if (value) references.push(value)
      }
    if (attrs.get('style')) styles.push(attrs.get('style'))
    if (node.namespaceURI === 'http://www.w3.org/2000/svg') {
      for (const name of [
        'clip-path',
        'color-profile',
        'cursor',
        'fill',
        'filter',
        'marker',
        'marker-end',
        'marker-mid',
        'marker-start',
        'mask',
        'stroke',
      ]) {
        const value = attrs.get(name)
        if (value) styles.push(value)
      }
      if (['animate', 'set'].includes(tag)) {
        const targetAttribute =
          attrs
            .get('attributeName')
            ?.toLowerCase()
            .replace(/^xlink:/u, '') ??
          attrs
            .get('attributename')
            ?.toLowerCase()
            .replace(/^xlink:/u, '')
        const animationValues = ['from', 'to', 'by', 'values'].flatMap(
          (name) => attrs.get(name)?.split(';') ?? [],
        )
        if (targetAttribute === 'href')
          references.push(...animationValues.filter(Boolean))
        else styles.push(...animationValues.filter(Boolean))
      }
    }
    if (tag === 'style')
      styles.push(
        (node.childNodes ?? [])
          .filter((child) => child.nodeName === '#text')
          .map((child) => child.value ?? '')
          .join(''),
      )
    for (const child of node.childNodes ?? []) visit(child)
    if (node.content) visit(node.content)
  }
  visit(document)
  return { references, styles }
}

function cssFunctionBodies(css, pattern) {
  const bodies = []
  pattern.lastIndex = 0
  for (let match = pattern.exec(css); match; match = pattern.exec(css)) {
    const start = pattern.lastIndex
    let quote = ''
    let depth = 1
    let index = start
    for (; index < css.length && depth > 0; index += 1) {
      const character = css[index]
      if (quote) {
        if (character === quote) quote = ''
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
        continue
      }
      if (character === '(') depth += 1
      if (character === ')') depth -= 1
    }
    if (depth !== 0 || quote)
      throw new Error('Malformed publication CSS image-set()')
    bodies.push(css.slice(start, index - 1))
    pattern.lastIndex = index
  }
  return bodies
}

function splitCssCandidates(body) {
  const candidates = []
  let quote = ''
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      candidates.push(body.slice(start, index).trim())
      start = index + 1
    }
  }
  candidates.push(body.slice(start).trim())
  return candidates.filter(Boolean)
}

function cssResourceReferences(css) {
  const withoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//gu, '')
  if (withoutComments.includes('\\'))
    throw new Error('CSS escapes are not allowed in publication resource URLs')
  const matches = [
    ...withoutComments.matchAll(
      /\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^'"\s][^)]*?))\s*\)/giu,
    ),
  ]
  const urlTokenCount = withoutComments.match(/\burl\s*\(/giu)?.length ?? 0
  if (matches.length !== urlTokenCount)
    throw new Error('Malformed publication CSS resource URL')
  if (/@import\b/iu.test(withoutComments))
    throw new Error('CSS imports are not allowed in publication output')
  if (/\blocal\s*\(/iu.test(withoutComments))
    throw new Error('Ambient local fonts are not allowed in publication output')
  const imageSetStrings = cssFunctionBodies(
    withoutComments,
    /(?:-webkit-)?image-set\s*\(/giu,
  ).flatMap((body) =>
    splitCssCandidates(body).flatMap((candidate) => {
      const quoted = candidate.match(/^(?:"([^"]*)"|'([^']*)')/u)
      return quoted ? [(quoted[1] ?? quoted[2]).trim()] : []
    }),
  )
  return [
    ...matches.map((match) => (match[1] ?? match[2] ?? match[3]).trim()),
    ...imageSetStrings,
  ]
}

export async function validatePublicationResources(request) {
  assertRenderRequest(request)
  const root = await realpath(request.publicationRoot)
  const input = await realpath(request.inputPath)
  if (!isPathInside(root, input))
    throw new Error('Publication HTML is outside publication root')
  const visited = new Set()
  const inspect = async (path) => {
    if (visited.has(path)) return
    visited.add(path)
    const extension = extname(path).toLowerCase()
    if (!['.html', '.htm', '.xhtml', '.css', '.svg'].includes(extension)) return
    const contents = await readFile(path, 'utf8')
    if (/<\?xml-stylesheet\b/iu.test(contents))
      throw new Error('XML stylesheet processing instructions are not allowed')
    if (extension === '.css') {
      for (const url of cssResourceReferences(contents)) {
        const resource = await assertPublicationResourceUrl(url, path, root)
        if (resource) await inspect(resource)
      }
      return
    }
    const { references, styles } = htmlResourceReferences(parse(contents))
    for (const style of styles)
      for (const url of cssResourceReferences(style)) {
        const resource = await assertPublicationResourceUrl(url, path, root)
        if (resource) await inspect(resource)
      }
    for (const url of references) {
      const resource = await assertPublicationResourceUrl(url, path, root)
      if (resource) await inspect(resource)
    }
  }
  await inspect(input)
  return [...visited].sort()
}

function normalizedHexIsZero(value) {
  return typeof value === 'string' && /^[0]+$/u.test(value)
}

export function assertIsolationSnapshot(snapshot, request) {
  assertRenderRequest(request)
  if (
    snapshot.networkNamespace === request.hostNetworkNamespace ||
    !/^net:\[\d+\]$/.test(snapshot.networkNamespace)
  )
    throw new Error('Helper remained in the host network namespace')
  if (
    snapshot.mountNamespace === request.hostMountNamespace ||
    !/^mnt:\[\d+\]$/.test(snapshot.mountNamespace)
  )
    throw new Error('Helper remained in the host mount namespace')
  if (
    snapshot.interfaces.length !== 1 ||
    snapshot.interfaces[0].name !== 'lo' ||
    !snapshot.interfaces[0].up
  )
    throw new Error(
      'Private network namespace must contain only an enabled loopback',
    )
  if (
    [...snapshot.ipv4RouteInterfaces, ...snapshot.ipv6RouteInterfaces].some(
      (name) => name !== 'lo',
    )
  )
    throw new Error('Private network namespace contains a non-loopback route')
  if (
    snapshot.uid !== request.expectedUid ||
    snapshot.gid !== request.expectedGid
  )
    throw new Error('Helper did not run as the expected caller identity')
  if (
    snapshot.groups.length !== 1 ||
    snapshot.groups[0] !== request.expectedGid
  )
    throw new Error('Helper retained supplementary groups')
  if (
    !Object.values(snapshot.capabilities).every(normalizedHexIsZero) ||
    !snapshot.noNewPrivileges
  )
    throw new Error('Helper retained capabilities or new-privilege authority')
  if (resolve(snapshot.cwd) !== resolve(request.publicationRoot))
    throw new Error('Helper working directory is not the publication root')
  const expectedEnvironment = publicationChildEnvironment(
    request.publicationRoot,
  )
  if (
    JSON.stringify(Object.entries(snapshot.environment).sort()) !==
    JSON.stringify(Object.entries(expectedEnvironment).sort())
  )
    throw new Error(
      'Helper environment is not the minimal publication environment',
    )
  if (
    publicationEnvironmentSha256(snapshot.environment) !==
    request.expectedEnvironmentSha256
  )
    throw new Error('Helper environment digest does not match the request')
  if (
    snapshot.childNetworkNamespaces.some(
      (identity) => identity !== snapshot.networkNamespace,
    )
  )
    throw new Error(
      'A renderer descendant escaped the private network namespace',
    )
  if (
    snapshot.childMountNamespaces.some(
      (identity) => identity !== snapshot.mountNamespace,
    )
  )
    throw new Error('A renderer descendant escaped the private mount namespace')
  return {
    networkNamespace: snapshot.networkNamespace,
    mountNamespace: snapshot.mountNamespace,
    interfaces: snapshot.interfaces.map(({ name }) => name),
    childNetworkNamespaces: [...new Set(snapshot.childNetworkNamespaces)],
    childMountNamespaces: [...new Set(snapshot.childMountNamespaces)],
  }
}

function statusValue(status, name) {
  const value = status.match(new RegExp(`^${name}:\\s*(.+)$`, 'mu'))?.[1]
  if (!value) throw new Error(`Missing ${name} in process status`)
  return value.trim()
}

async function readIsolationSnapshot(
  request,
  childNetworkNamespaces = [],
  childMountNamespaces = [],
) {
  const [
    networkNamespace,
    mountNamespace,
    interfaceNames,
    status,
    ipv4Routes,
    ipv6Routes,
  ] = await Promise.all([
    readlink('/proc/self/ns/net'),
    readlink('/proc/self/ns/mnt'),
    readdir('/sys/class/net'),
    readFile('/proc/self/status', 'utf8'),
    readFile('/proc/net/route', 'utf8'),
    readFile('/proc/net/ipv6_route', 'utf8').catch(() => ''),
  ])
  const interfaces = await Promise.all(
    interfaceNames.sort().map(async (name) => ({
      name,
      up:
        (Number.parseInt(
          await readFile(`/sys/class/net/${name}/flags`, 'utf8'),
          16,
        ) &
          1) ===
        1,
    })),
  )
  const ipv4RouteInterfaces = ipv4Routes
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter(Boolean)
  const ipv6RouteInterfaces = ipv6Routes
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/u).at(-1))
    .filter(Boolean)
  return {
    networkNamespace,
    mountNamespace,
    interfaces,
    ipv4RouteInterfaces,
    ipv6RouteInterfaces,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    groups: process.getgroups?.() ?? [],
    capabilities: {
      inheritable: statusValue(status, 'CapInh'),
      permitted: statusValue(status, 'CapPrm'),
      effective: statusValue(status, 'CapEff'),
      ambient: statusValue(status, 'CapAmb'),
    },
    noNewPrivileges: statusValue(status, 'NoNewPrivs') === '1',
    cwd: await realpath(process.cwd()),
    environment: { ...process.env },
    childNetworkNamespaces,
    childMountNamespaces,
  }
}

async function attestIsolation(request) {
  return readIsolationSnapshot(request).then((snapshot) => {
    assertIsolationSnapshot(snapshot, request)
    return snapshot
  })
}

async function descendantPids(parentPid) {
  const entries = (await readdir('/proc', { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && /^\d+$/.test(entry.name),
  )
  const parents = new Map()
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const status = await readFile(`/proc/${entry.name}/status`, 'utf8')
        parents.set(Number(entry.name), Number(statusValue(status, 'PPid')))
      } catch {
        // The process ended between directory enumeration and status read.
      }
    }),
  )
  const descendants = new Set()
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, parent] of parents) {
      if (
        !descendants.has(pid) &&
        (parent === parentPid || descendants.has(parent))
      ) {
        descendants.add(pid)
        changed = true
      }
    }
  }
  return descendants
}

function monitorRendererNamespaces(
  expectedNetworkNamespace,
  expectedMountNamespace,
) {
  const observedNetwork = new Set()
  const observedMount = new Set()
  let failure
  const observePid = async (pid) => {
    if (!pid) return
    try {
      const [networkIdentity, mountIdentity] = await Promise.all([
        readlink(`/proc/${pid}/ns/net`),
        readlink(`/proc/${pid}/ns/mnt`),
      ])
      observedNetwork.add(networkIdentity)
      observedMount.add(mountIdentity)
      if (networkIdentity !== expectedNetworkNamespace)
        failure = new Error(
          `Renderer descendant ${pid} entered unexpected network namespace ${networkIdentity}`,
        )
      if (mountIdentity !== expectedMountNamespace)
        failure = new Error(
          `Renderer descendant ${pid} entered unexpected mount namespace ${mountIdentity}`,
        )
    } catch {
      // A short-lived child can exit before its namespace link is read.
    }
  }
  const scan = async () => {
    for (const pid of await descendantPids(process.pid)) await observePid(pid)
  }
  const interval = setInterval(
    () => void scan().catch((error) => (failure = error)),
    10,
  )
  return {
    observePid,
    async stop() {
      clearInterval(interval)
      await scan()
      if (failure) throw failure
      return {
        network: [...observedNetwork],
        mount: [...observedMount],
      }
    },
  }
}

async function runAbsolute(
  command,
  args,
  { capture = false, monitor, timeoutMilliseconds = 90_000 } = {},
) {
  if (!isAbsolute(command))
    throw new Error('Renderer executable must be absolute')
  return new Promise((accept, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    void monitor?.observePid(child.pid)
    if (capture) {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.stderr.on('data', (chunk) => (stderr += chunk))
    }
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMilliseconds)
    const finish = (callback) => {
      clearTimeout(timeout)
      callback()
    }
    child.once('error', (error) => finish(() => reject(error)))
    child.once('exit', (code, signal) =>
      finish(() => {
        if (timedOut) {
          reject(new Error(`${command} exceeded ${timeoutMilliseconds}ms`))
          return
        }
        if (code === 0) {
          accept({ stdout, stderr })
          return
        }
        reject(
          new Error(
            `${command} ${
              code === null
                ? `terminated by ${signal ?? 'unknown signal'}`
                : `exited with status ${code}`
            }${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
          ),
        )
      }),
    )
  })
}

async function runIsolationDiagnostics(request, monitor) {
  if (!request.networkDiagnostic && !request.filesystemDiagnosticPaths.length)
    return { filesystemDiagnostics: [], networkDiagnostic: null }
  const encoded = Buffer.from(
    JSON.stringify({
      filesystemDiagnosticPaths: request.filesystemDiagnosticPaths,
      networkDiagnostic: request.networkDiagnostic,
    }),
  ).toString('base64url')
  const { stdout } = await runAbsolute(
    NODE_EXECUTABLE,
    ['--input-type=module', '--eval', ISOLATION_DIAGNOSTIC_SOURCE, encoded],
    { capture: true, monitor, timeoutMilliseconds: 10_000 },
  )
  let result
  try {
    result = JSON.parse(stdout)
  } catch (error) {
    throw new Error(
      `Isolation diagnostic returned invalid JSON: ${String(error)}`,
    )
  }
  const expectedNetwork = request.networkDiagnostic
    ? {
        attempted: [
          'tcp-ipv4',
          'tcp-ipv6',
          'http-ipv4',
          'http-ipv6',
          'websocket-ipv4',
          'websocket-ipv6',
          'udp-ipv4',
          'udp-ipv6',
        ],
        privateLoopback: { ipv4: true, ipv6: true },
      }
    : null
  const expectedFilesystem = request.filesystemDiagnosticPaths.map((path) => ({
    path,
    inaccessible: true,
  }))
  if (
    JSON.stringify(Object.keys(result).sort()) !==
      JSON.stringify(['filesystemDiagnostics', 'networkDiagnostic']) ||
    JSON.stringify(result.networkDiagnostic) !==
      JSON.stringify(expectedNetwork) ||
    JSON.stringify(result.filesystemDiagnostics) !==
      JSON.stringify(expectedFilesystem)
  )
    throw new Error('Isolation diagnostic returned invalid results')
  return result
}

export function publicationBrowserVersionMatches(output, expectedVersion) {
  const actual = String(output).match(/\b(\d+\.\d+\.\d+\.\d+)\b/u)?.[1]
  return (
    actual === expectedVersion && /^\d+\.\d+\.\d+\.\d+$/.test(expectedVersion)
  )
}

async function verifyBrowser(request, monitor) {
  const browser = await realpath(request.browserPath)
  if (!isPathInside(await realpath(BROWSER_CACHE), browser))
    throw new Error('Pinned browser resolves outside the repository cache')
  await access(browser, constants.X_OK)
  const { stdout, stderr } = await runAbsolute(browser, ['--version'], {
    capture: true,
    monitor,
    timeoutMilliseconds: 10_000,
  })
  const output = `${stdout}\n${stderr}`.trim()
  const actual = output.match(/\b(\d+\.\d+\.\d+\.\d+)\b/u)?.[1]
  if (!publicationBrowserVersionMatches(output, request.expectedBrowserVersion))
    throw new Error(
      `Pinned publication browser version ${actual ?? '(missing)'} does not match ${request.expectedBrowserVersion}`,
    )
  return actual
}

async function verifyRenderer(request, monitor) {
  const packagePath =
    request.renderer === 'vivliostyle-cli'
      ? VIVLIOSTYLE_PACKAGE
      : PLAYWRIGHT_PACKAGE
  const packageRecord = JSON.parse(await readFile(packagePath, 'utf8'))
  if (packageRecord.version !== request.expectedRendererVersion)
    throw new Error(
      `Pinned publication renderer version ${String(packageRecord.version)} does not match ${request.expectedRendererVersion}`,
    )
  if (request.renderer === 'vivliostyle-cli') {
    const { stdout, stderr } = await runAbsolute(
      NODE_EXECUTABLE,
      [VIVLIOSTYLE_CLI, '--version'],
      { capture: true, monitor, timeoutMilliseconds: 10_000 },
    )
    const actual = `${stdout}\n${stderr}`.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1]
    if (actual !== request.expectedRendererVersion)
      throw new Error(
        `Vivliostyle CLI reported ${actual ?? '(missing)'}; expected ${request.expectedRendererVersion}`,
      )
  }
  return packageRecord.version
}

async function renderVivliostylePublication(request, { monitor } = {}) {
  if ((await realpath(VIVLIOSTYLE_CLI)) !== VIVLIOSTYLE_CLI)
    throw new Error('Vivliostyle CLI path is not canonical')
  await runAbsolute(
    NODE_EXECUTABLE,
    [
      VIVLIOSTYLE_CLI,
      'build',
      request.inputPath,
      '--single-doc',
      '--output',
      request.outputPath,
      '--format',
      'pdf',
      '--size',
      request.size,
      '--executable-browser',
      request.browserPath,
      '--viewer-param',
      'allowScripts=false',
      '--host',
      '127.0.0.1',
      '--timeout',
      '90',
      '--no-vite-config-file',
      '--no-enable-static-serve',
      '--log-level',
      'silent',
    ],
    { monitor },
  )
}

function blockedRequestError(blockedRequests) {
  if (!blockedRequests.size) return null
  return new Error(
    `Publication rendering blocked external request: ${[
      ...blockedRequests,
    ].join(', ')}`,
  )
}

export async function renderPlaywrightPublication(
  request,
  { chromium, monitor } = {},
) {
  const playwright = chromium ? { chromium } : await import('playwright')
  const browser = await playwright.chromium.launch({
    executablePath: request.browserPath,
    headless: true,
  })
  const blockedRequests = new Set()
  let context
  try {
    context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', async (route) => {
      const url = route.request().url()
      if (url === 'about:blank') {
        await route.continue()
        return
      }
      try {
        await assertPublicationResourceUrl(
          url,
          request.inputPath,
          request.publicationRoot,
        )
        await route.continue()
      } catch {
        blockedRequests.add(url)
        await route.abort('blockedbyclient')
      }
    })
    const page = await context.newPage()
    await page.emulateMedia({ media: 'print' })
    await page.goto(pathToFileURL(request.inputPath).href, {
      waitUntil: 'networkidle',
    })
    const beforePdf = blockedRequestError(blockedRequests)
    if (beforePdf) throw beforePdf
    await page.pdf({
      path: request.outputPath,
      format: request.size,
      printBackground: true,
      tagged: true,
      outline: true,
    })
    const afterPdf = blockedRequestError(blockedRequests)
    if (afterPdf) throw afterPdf
    await context.close()
    context = undefined
  } finally {
    if (context) await context.close().catch(() => undefined)
    await browser.close()
  }
  void monitor
}

export async function executePublicationRenderRequest(
  request,
  dependencies = {},
) {
  assertRenderRequest(request)
  const isolate = dependencies.attestIsolation ?? attestIsolation
  const validateResources =
    dependencies.validateResources ?? validatePublicationResources
  const verify = dependencies.verifyBrowser ?? verifyBrowser
  const verifySelectedRenderer = dependencies.verifyRenderer ?? verifyRenderer
  const verifyRuntime =
    dependencies.verifyRuntimeEntries ?? verifyRuntimeEntries
  const diagnoseIsolation =
    dependencies.runIsolationDiagnostics ?? runIsolationDiagnostics
  const renderVivliostyle =
    dependencies.renderVivliostyle ?? renderVivliostylePublication
  const renderPlaywright =
    dependencies.renderPlaywright ?? renderPlaywrightPublication
  if (process.versions.node !== request.expectedNodeVersion)
    throw new Error(
      `Publication helper Node ${process.versions.node} does not match ${request.expectedNodeVersion}`,
    )
  const initialSnapshot = await isolate(request)
  await verifyRuntime(request.runtimeEntries)
  const monitor = monitorRendererNamespaces(
    initialSnapshot.networkNamespace,
    initialSnapshot.mountNamespace,
  )
  let childNetworkNamespaces = []
  let childMountNamespaces = []
  let rendererVersion
  let browserVersion
  let diagnostics = { filesystemDiagnostics: [], networkDiagnostic: null }
  try {
    diagnostics = await diagnoseIsolation(request, monitor)
    await validateResources(request)
    rendererVersion = await verifySelectedRenderer(request, monitor)
    browserVersion = await verify(request, monitor)
    if (request.renderer === 'vivliostyle-cli')
      await renderVivliostyle(request, { monitor })
    else await renderPlaywright(request, { monitor })
    await verifyRuntime(request.runtimeEntries)
  } finally {
    const observedNamespaces = await monitor.stop()
    childNetworkNamespaces = observedNamespaces.network
    childMountNamespaces = observedNamespaces.mount
    if (initialSnapshot.interfaces)
      assertIsolationSnapshot(
        {
          ...initialSnapshot,
          childNetworkNamespaces,
          childMountNamespaces,
        },
        request,
      )
  }
  return {
    ...initialSnapshot,
    childNetworkNamespaces,
    childMountNamespaces,
    rendererVersion,
    browserVersion,
    ...diagnostics,
  }
}

async function readBoundedRegularFile(path, maximumBytes, description) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes)
      throw new Error(`${description} is not a bounded regular file`)
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      bytes.byteLength !== before.size
    )
      throw new Error(`${description} changed while it was being read`)
    return bytes
  } finally {
    await handle.close()
  }
}

function parseArguments(argv) {
  if (argv.length !== 2)
    throw new Error(
      'Publication helper requires exactly two authenticated arguments',
    )
  const request = argv.find((argument) => argument.startsWith('--request='))
  const digest = argv.find((argument) =>
    argument.startsWith('--request-sha256='),
  )
  if (!request || !digest)
    throw new Error('Publication helper request arguments are incomplete')
  return {
    requestPath: request.slice('--request='.length),
    digest: digest.slice('--request-sha256='.length),
  }
}

async function main() {
  const { requestPath, digest } = parseArguments(process.argv.slice(2))
  const serialized = (
    await readBoundedRegularFile(
      requestPath,
      64 * 1024,
      'Publication render request',
    )
  ).toString('utf8')
  const request = authenticatePublicationRequest(serialized, digest)
  const canonicalRoot = await realpath(request.publicationRoot)
  const canonicalRequest = await realpath(requestPath)
  const canonicalStaging = await realpath(request.stagingDirectory)
  if (
    canonicalRoot !== request.publicationRoot ||
    canonicalStaging !== request.stagingDirectory ||
    !isPathInside(canonicalRoot, canonicalStaging) ||
    !isPathInside(canonicalStaging, canonicalRequest)
  )
    throw new Error('Authenticated request file is outside private staging')
  const proof = await executePublicationRenderRequest(request)
  const output = await readBoundedRegularFile(
    request.outputPath,
    512 * 1024 * 1024,
    'Rendered publication PDF',
  )
  const proofRecord = {
    version: 1,
    event: 'publication-isolation-proof',
    requestSha256: digest,
    renderer: request.renderer,
    rendererVersion: proof.rendererVersion,
    browserVersion: proof.browserVersion,
    nodeVersion: process.versions.node,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    environmentSha256: request.expectedEnvironmentSha256,
    outputSha256: createHash('sha256').update(output).digest('hex'),
    outputByteLength: output.byteLength,
    runtimeEntries: request.runtimeEntries,
    networkNamespace: proof.networkNamespace,
    mountNamespace: proof.mountNamespace,
    interfaces: proof.interfaces.map(({ name }) => name),
    childNetworkNamespaces: [...new Set(proof.childNetworkNamespaces)].sort(),
    childMountNamespaces: [...new Set(proof.childMountNamespaces)].sort(),
    networkDiagnostic: proof.networkDiagnostic,
    filesystemDiagnostics: proof.filesystemDiagnostics,
  }
  await writeFile(request.proofPath, `${JSON.stringify(proofRecord)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  process.stdout.write(`${JSON.stringify(proofRecord)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === HELPER_PATH)
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  })
