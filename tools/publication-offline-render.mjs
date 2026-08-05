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
  if (!Array.isArray(request.runtimeEntries) || request.runtimeEntries.length)
    throw new Error('Publication runtime attestation list is invalid')
  if (request.networkDiagnostic !== null)
    throw new Error('Publication network diagnostic is invalid')
  if (
    !Array.isArray(request.filesystemDiagnosticPaths) ||
    request.filesystemDiagnosticPaths.length
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
  return matches.map((match) => (match[1] ?? match[2] ?? match[3]).trim())
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
  const renderVivliostyle =
    dependencies.renderVivliostyle ?? renderVivliostylePublication
  const renderPlaywright =
    dependencies.renderPlaywright ?? renderPlaywrightPublication
  if (process.versions.node !== request.expectedNodeVersion)
    throw new Error(
      `Publication helper Node ${process.versions.node} does not match ${request.expectedNodeVersion}`,
    )
  const initialSnapshot = await isolate(request)
  const monitor = monitorRendererNamespaces(
    initialSnapshot.networkNamespace,
    initialSnapshot.mountNamespace,
  )
  let childNetworkNamespaces = []
  let childMountNamespaces = []
  let rendererVersion
  let browserVersion
  try {
    await validateResources(request)
    rendererVersion = await verifySelectedRenderer(request, monitor)
    browserVersion = await verify(request, monitor)
    if (request.renderer === 'vivliostyle-cli')
      await renderVivliostyle(request, { monitor })
    else await renderPlaywright(request, { monitor })
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
    networkDiagnostic: null,
    filesystemDiagnostics: [],
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
