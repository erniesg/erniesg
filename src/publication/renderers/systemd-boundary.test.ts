import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createSocket } from 'node:dgram'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import {
  access,
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Browser, computeExecutablePath } from '@puppeteer/browsers'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PUBLICATION_TOOLCHAIN,
  publicationPdfRendererForArchitecture,
} from '../toolchain'
import { publicationPlaywrightExecutableCandidates } from './vivliostyle'
import {
  PUBLICATION_BOUNDARY_EXECUTABLES,
  assertPublicationBoundaryRuntime,
  attestPublicationRuntimeFile,
  buildPublicationSystemdInvocation,
  createPublicationUnitName,
  runPublicationIsolatedRender,
  runPublicationSystemdInvocation,
  verifyPublicationRuntimeAttestations,
  verifyPublicationBoundaryExecutables,
} from './systemd-boundary'

const invocationInput = {
  publicationRoot: '/tmp/publication root',
  stagingDirectory: '/tmp/publication root/.publication-stage-test',
  requestPath:
    '/tmp/publication root/.publication-stage-test/offline-request.json',
  requestSha256: 'a'.repeat(64),
  runtimeReadOnlyPaths: ['/tmp/publication runtime/entrypoint.js'],
  uid: 1000,
  gid: 1000,
  unitName: 'erniesg-publication-test-0123456789abcdef',
}

const systemdIntegration =
  process.env.PUBLICATION_SYSTEMD_INTEGRATION === '1' ? it : it.skip

async function listen(server: ReturnType<typeof createServer>, host: string) {
  await new Promise<void>((accept, reject) => {
    server.once('error', reject)
    server.listen(0, host, accept)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error(`Missing ${host} sentinel address`)
  return address.port
}

async function listenTcp(
  server: ReturnType<typeof createTcpServer>,
  host: string,
) {
  await new Promise<void>((accept, reject) => {
    server.once('error', reject)
    server.listen(0, host, accept)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error(`Missing ${host} TCP sentinel address`)
  return address.port
}

async function listenUdp(
  socket: ReturnType<typeof createSocket>,
  host: string,
) {
  await new Promise<void>((accept, reject) => {
    socket.once('error', reject)
    socket.bind(0, host, accept)
  })
  const address = socket.address()
  if (typeof address === 'string')
    throw new Error(`Missing ${host} UDP sentinel address`)
  return address.port
}

async function closeServer(server: ReturnType<typeof createServer>) {
  if (!server.listening) return
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  )
}

async function closeTcp(server: ReturnType<typeof createTcpServer>) {
  if (!server.listening) return
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  )
}

async function closeUdp(socket: ReturnType<typeof createSocket>) {
  await new Promise<void>((accept, reject) => {
    try {
      socket.close(accept)
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ERR_SOCKET_DGRAM_NOT_RUNNING'
      )
        accept()
      else reject(error)
    }
  })
}

const temporaryPaths = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  )
  temporaryPaths.clear()
})

function sha256(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function validPdfBytes(title = 'staged publication') {
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  pdf.addPage([200, 300])
  return pdf.save({ useObjectStreams: false })
}

async function atomicPublicationFixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'publication-atomic-'))
  temporaryPaths.add(root)
  const inputPath = resolve(root, 'index.html')
  const browserPath = resolve(root, 'browser')
  const outputPath = resolve(root, 'publication.pdf')
  const original = Buffer.from('known-good-final-bytes')
  await writeFile(inputPath, '<!doctype html><main>fixture</main>')
  await writeFile(browserPath, '#!/bin/false\n', { mode: 0o700 })
  await chmod(browserPath, 0o700)
  await writeFile(outputPath, original)
  return { root, inputPath, browserPath, outputPath, original }
}

async function authenticatedInvocationRequest(invocation: { args: string[] }) {
  const requestArgument = invocation.args.find((argument) =>
    argument.startsWith('--request='),
  )
  const digestArgument = invocation.args.find((argument) =>
    argument.startsWith('--request-sha256='),
  )
  if (!requestArgument || !digestArgument)
    throw new Error('Missing authenticated request arguments')
  const requestPath = requestArgument.slice('--request='.length)
  const requestSha256 = digestArgument.slice('--request-sha256='.length)
  const serialized = await readFile(requestPath, 'utf8')
  return {
    request: JSON.parse(serialized) as Record<string, any>,
    requestPath,
    requestSha256,
    serialized,
  }
}

function isolationProof(
  request: Record<string, any>,
  requestSha256: string,
  output: Uint8Array,
) {
  return {
    version: 1,
    event: 'publication-isolation-proof',
    requestSha256,
    renderer: request.renderer,
    rendererVersion: request.expectedRendererVersion,
    browserVersion: request.expectedBrowserVersion,
    nodeVersion: request.expectedNodeVersion,
    uid: request.expectedUid,
    gid: request.expectedGid,
    environmentSha256: request.expectedEnvironmentSha256,
    outputSha256: sha256(output),
    outputByteLength: output.byteLength,
    runtimeEntries: request.runtimeEntries,
    networkNamespace: 'net:[987654321]',
    mountNamespace: 'mnt:[987654321]',
    interfaces: ['lo'],
    childNetworkNamespaces: ['net:[987654321]'],
    childMountNamespaces: ['mnt:[987654321]'],
    networkDiagnostic: request.networkDiagnostic ? { passed: true } : null,
    filesystemDiagnostics: (request.filesystemDiagnosticPaths ?? []).map(
      (path: string) => ({ path, inaccessible: true }),
    ),
  }
}

function isolatedRenderRequest(
  fixture: Awaited<ReturnType<typeof atomicPublicationFixture>>,
) {
  return {
    renderer: 'playwright-chromium' as const,
    publicationRoot: fixture.root,
    inputPath: fixture.inputPath,
    outputPath: fixture.outputPath,
    size: 'A4' as const,
    title: 'Atomic fixture',
    browserPath: fixture.browserPath,
    expectedBrowserVersion: '149.0.7827.0',
    expectedRendererVersion: '1.61.1',
  }
}

async function publicationResidue(root: string) {
  return (await readdir(root)).filter((name) =>
    name.startsWith('.publication-'),
  )
}

const testRuntimeAttestationDependencies = {
  createRuntimeAttestations: async () => [],
  verifyRuntimeAttestations: async () => undefined,
}

describe('publication systemd process-tree boundary', () => {
  it('builds one shell-free, bounded, privilege-dropping system service', () => {
    const invocation = buildPublicationSystemdInvocation(invocationInput)

    expect(invocation.command).toBe('/usr/bin/sudo')
    expect(invocation.args.slice(0, 2)).toEqual(['-n', '/usr/bin/systemd-run'])
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        '--system',
        '--quiet',
        '--wait',
        '--collect',
        '--pipe',
        '--expand-environment=no',
        '--property=Type=exec',
        '--property=PrivateNetwork=yes',
        '--property=NoNewPrivileges=yes',
        '--property=AmbientCapabilities=',
        '--property=CapabilityBoundingSet=CAP_SETUID CAP_SETGID',
        '--property=PrivateDevices=yes',
        '--property=PrivateTmp=yes',
        '--property=ProtectHome=tmpfs',
        '--property=TemporaryFileSystem=/:ro',
        '--property=BindReadOnlyPaths=/usr',
        '--property=BindReadOnlyPaths=/tmp/publication\\x20root',
        '--property=BindReadOnlyPaths=/tmp/publication\\x20runtime/entrypoint.js',
        '--property=BindPaths=/tmp/publication\\x20root/.publication-stage-test',
        '--property=ReadWritePaths=/tmp/publication\\x20root/.publication-stage-test',
        '--property=ProtectKernelTunables=yes',
        '--property=ProtectKernelModules=yes',
        '--property=ProtectKernelLogs=yes',
        '--property=ProtectControlGroups=yes',
        '--property=ExitType=cgroup',
        '--property=KillMode=control-group',
        '--property=SendSIGKILL=yes',
        '--property=RuntimeMaxSec=120s',
        '--working-directory=/tmp/publication root',
        '/usr/bin/setpriv',
        '--reuid=1000',
        '--regid=1000',
        '--clear-groups',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--no-new-privs',
        '/usr/bin/env',
        '-i',
        'PATH=/usr/bin',
        '/usr/bin/node',
        resolve('tools/publication-offline-render.mjs'),
        '--request=/tmp/publication root/.publication-stage-test/offline-request.json',
        `--request-sha256=${'a'.repeat(64)}`,
      ]),
    )
    expect(invocation.args.join('\n')).toMatch(
      /InaccessiblePaths=.*systemd\/private.*docker\.sock/,
    )
    expect(invocation.args).not.toContain('sh')
    expect(invocation.args).not.toContain('-c')
    expect(invocation.args).not.toContain('--user')
    expect(invocation.args).not.toContain('--map-root-user')
    expect(invocation.args.join('\n')).not.toMatch(/\bunshare\b|\bip\b/)
    expect(invocation.timeoutMilliseconds).toBeGreaterThan(120_000)
    expect(invocation.timeoutMilliseconds).toBeLessThanOrEqual(135_000)
    expect(invocation.unitName).toBe(invocationInput.unitName)
  })

  it('uses only absolute trusted boundary tools despite a shadowed PATH', () => {
    const hostileEnvironment = {
      PATH: '/tmp/path-shadow',
      HTTPS_PROXY: 'http://host-proxy.invalid',
      LD_PRELOAD: '/tmp/hostile.so',
      NODE_OPTIONS: '--require=/tmp/hostile.cjs',
    }
    const originalEnvironment = { ...process.env }
    Object.assign(process.env, hostileEnvironment)
    try {
      const invocation = buildPublicationSystemdInvocation(invocationInput)
      expect(invocation.command).toBe(PUBLICATION_BOUNDARY_EXECUTABLES.sudo)
      const completeArgv = [invocation.command, ...invocation.args]
      for (const executable of Object.values(PUBLICATION_BOUNDARY_EXECUTABLES))
        expect(completeArgv).toContain(executable)
      expect(invocation.environment).toEqual({
        PATH: '/usr/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      })
      const envIndex = invocation.args.indexOf('-i')
      const nodeIndex = invocation.args.indexOf(
        PUBLICATION_BOUNDARY_EXECUTABLES.node,
      )
      const childEnvironment = invocation.args.slice(envIndex + 1, nodeIndex)
      expect(childEnvironment).toEqual([
        'HOME=/tmp',
        'TMPDIR=/tmp',
        'XDG_CACHE_HOME=/tmp/.cache',
        'PATH=/usr/bin',
        'LANG=C.UTF-8',
        'LC_ALL=C.UTF-8',
        'NODE_ENV=production',
        'TZ=UTC',
        'SOURCE_DATE_EPOCH=946684800',
        'NO_PROXY=*',
        'no_proxy=*',
        'HTTP_PROXY=',
        'HTTPS_PROXY=',
        'ALL_PROXY=',
        'http_proxy=',
        'https_proxy=',
        'all_proxy=',
      ])
      expect(invocation.args.join('\n')).not.toMatch(
        /path-shadow|host-proxy|hostile\.so|hostile\.cjs/,
      )
    } finally {
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, originalEnvironment)
    }
  })

  it('generates a unique bounded systemd unit name', () => {
    const name = createPublicationUnitName(1234, 'abcdef0123456789')
    expect(name).toBe('erniesg-publication-1234-abcdef0123456789')
    expect(name.length).toBeLessThanOrEqual(63)
    expect(name).toMatch(/^[a-z0-9-]+$/)
  })

  it('detects same-UID mutation of an authenticated runtime entrypoint', async () => {
    const fixture = await atomicPublicationFixture()
    const attestation = await attestPublicationRuntimeFile(
      'browser-executable',
      fixture.browserPath,
    )
    await writeFile(fixture.browserPath, '#!/bin/true\n', { mode: 0o700 })

    await expect(
      verifyPublicationRuntimeAttestations([attestation]),
    ).rejects.toThrow(/runtime.*changed|attestation/i)
  })

  it('refuses publication when a runtime entrypoint changes after request authentication', async () => {
    const fixture = await atomicPublicationFixture()
    const attestation = await attestPublicationRuntimeFile(
      'browser-executable',
      fixture.browserPath,
    )
    const rawPdf = await validPdfBytes()

    await expect(
      runPublicationIsolatedRender(isolatedRenderRequest(fixture), {
        verifyExecutables: async () => undefined,
        createRuntimeAttestations: async () => [attestation],
        runInvocation: async (invocation) => {
          const { request, requestSha256 } =
            await authenticatedInvocationRequest(invocation)
          await writeFile(fixture.browserPath, '#!/bin/true\n', { mode: 0o700 })
          await writeFile(String(request.outputPath), rawPdf)
          await writeFile(
            String(request.proofPath),
            `${JSON.stringify(isolationProof(request, requestSha256, rawPdf))}\n`,
          )
        },
      }),
    ).rejects.toThrow(/runtime attestation changed/i)
    expect(await readFile(fixture.outputPath)).toEqual(fixture.original)
    expect(await publicationResidue(fixture.root)).toEqual([])
  })

  it('rejects unsupported platforms, root callers, and missing identity APIs', () => {
    expect(() =>
      assertPublicationBoundaryRuntime({
        platform: 'darwin',
        uid: 501,
        gid: 20,
      }),
    ).toThrow(/requires Linux/)
    expect(() =>
      assertPublicationBoundaryRuntime({
        platform: 'linux',
        uid: 0,
        gid: 1000,
      }),
    ).toThrow(/must not run as root/)
    expect(() =>
      assertPublicationBoundaryRuntime({
        platform: 'linux',
        uid: 1000,
        gid: 0,
      }),
    ).toThrow(/must not run with a root group/)
    expect(() =>
      assertPublicationBoundaryRuntime({
        platform: 'linux',
        uid: undefined,
        gid: undefined,
      }),
    ).toThrow(/numeric caller UID and GID/)
  })

  it.each(['sudo', 'systemdRun', 'setpriv'] as const)(
    'fails before rendering when absolute %s is unavailable',
    async (name) => {
      const inspected: string[] = []
      const missing = PUBLICATION_BOUNDARY_EXECUTABLES[name]
      await expect(
        verifyPublicationBoundaryExecutables(async (path) => {
          inspected.push(path)
          if (path === missing)
            throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }),
      ).rejects.toThrow(
        new RegExp(
          `${name === 'systemdRun' ? 'systemd-run' : name}.*unavailable`,
        ),
      )
      expect(inspected.at(-1)).toBe(missing)
    },
  )

  it('preserves output streams and propagates a nonzero systemd result', async () => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>
    }
    child.kill = vi.fn()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 37, null))
      return child as never
    })
    const invocation = buildPublicationSystemdInvocation(invocationInput)

    await expect(
      runPublicationSystemdInvocation(invocation, spawnProcess),
    ).rejects.toMatchObject({ exitCode: 37 })
    expect(spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      invocation.args,
      expect.objectContaining({
        env: invocation.environment,
        shell: false,
        stdio: 'inherit',
      }),
    )
  })

  it('publishes only a verified normalized staging PDF and never sends the final path to the renderer', async () => {
    const fixture = await atomicPublicationFixture()
    const rawPdf = await validPdfBytes('raw renderer output')
    let rendererOutputPath = ''
    const events: string[] = []

    await runPublicationIsolatedRender(isolatedRenderRequest(fixture), {
      ...testRuntimeAttestationDependencies,
      verifyExecutables: async () => undefined,
      runInvocation: async (invocation) => {
        const { request, requestSha256, serialized } =
          await authenticatedInvocationRequest(invocation)
        rendererOutputPath = String(request.outputPath)
        expect(serialized).not.toContain(fixture.outputPath)
        expect(await readFile(fixture.outputPath)).toEqual(fixture.original)
        events.push('render')
        await writeFile(rendererOutputPath, rawPdf)
        await writeFile(
          String(request.proofPath),
          `${JSON.stringify(isolationProof(request, requestSha256, rawPdf))}\n`,
        )
      },
      normalizePdf: async (renderedPath, normalizedPath) => {
        events.push('normalize')
        expect(await readFile(fixture.outputPath)).toEqual(fixture.original)
        const pdf = await PDFDocument.load(await readFile(renderedPath))
        pdf.setTitle('normalized publication')
        await writeFile(
          normalizedPath,
          await pdf.save({ useObjectStreams: false }),
          { flag: 'wx', mode: 0o600 },
        )
      },
    })

    expect(rendererOutputPath).not.toBe(fixture.outputPath)
    expect(dirname(dirname(rendererOutputPath))).toBe(fixture.root)
    expect(basename(rendererOutputPath)).toBe('rendered.pdf')
    expect(events).toEqual(['render', 'normalize'])
    expect(sha256(await readFile(fixture.outputPath))).not.toBe(
      sha256(fixture.original),
    )
    expect(await publicationResidue(fixture.root)).toEqual([])
  })

  it.each([
    'resource failure',
    'version failure',
    'partial renderer failure',
    'missing proof',
    'invalid proof',
    'digest mismatch',
    'runtime proof mismatch',
    'parse failure',
    'normalization failure',
    'timeout',
  ])(
    'preserves a prior final and removes every private artifact after %s',
    async (failure) => {
      const fixture = await atomicPublicationFixture()
      const validPdf = await validPdfBytes()
      const normalizePdf = vi.fn(
        async (renderedPath: string, normalizedPath: string) => {
          if (failure === 'normalization failure') {
            await writeFile(normalizedPath, 'partial normalized output')
            throw new Error('injected normalization failure')
          }
          const pdf = await PDFDocument.load(await readFile(renderedPath))
          await writeFile(
            normalizedPath,
            await pdf.save({ useObjectStreams: false }),
            { flag: 'wx', mode: 0o600 },
          )
        },
      )
      const render = runPublicationIsolatedRender(
        isolatedRenderRequest(fixture),
        {
          ...testRuntimeAttestationDependencies,
          verifyExecutables: async () => undefined,
          runInvocation: async (invocation) => {
            const { request, requestSha256 } =
              await authenticatedInvocationRequest(invocation)
            if (failure === 'resource failure')
              throw new Error('injected resource validation failure')
            if (failure === 'version failure')
              throw new Error('injected browser version failure')
            if (failure === 'partial renderer failure') {
              await writeFile(String(request.outputPath), 'partial PDF')
              throw new Error('injected renderer failure')
            }
            if (failure === 'timeout') {
              await writeFile(
                String(request.outputPath),
                'partial before timeout',
              )
              throw new Error('systemd-run exceeded 5ms')
            }
            const output =
              failure === 'parse failure'
                ? Buffer.from('not a PDF')
                : Buffer.from(validPdf)
            await writeFile(String(request.outputPath), output)
            if (failure === 'missing proof') return
            if (failure === 'invalid proof') {
              await writeFile(String(request.proofPath), '{invalid json')
              return
            }
            const proof = isolationProof(request, requestSha256, output)
            if (failure === 'digest mismatch')
              proof.outputSha256 = '0'.repeat(64)
            if (failure === 'runtime proof mismatch')
              proof.runtimeEntries = [{ injected: true }]
            await writeFile(
              String(request.proofPath),
              `${JSON.stringify(proof)}\n`,
            )
          },
          normalizePdf,
        },
      )

      await expect(render).rejects.toThrow()
      await new Promise((accept) => setTimeout(accept, 25))
      expect(await readFile(fixture.outputPath)).toEqual(fixture.original)
      expect(await publicationResidue(fixture.root)).toEqual([])
      if (
        [
          'resource failure',
          'version failure',
          'partial renderer failure',
          'missing proof',
          'invalid proof',
          'digest mismatch',
          'runtime proof mismatch',
          'timeout',
        ].includes(failure)
      )
        expect(normalizePdf).not.toHaveBeenCalled()
    },
  )

  it('rejects output-parent and final symlinks without mutating their targets', async () => {
    const fixture = await atomicPublicationFixture()
    const outside = await mkdtemp(resolve(tmpdir(), 'publication-outside-'))
    temporaryPaths.add(outside)
    const outsideFinal = resolve(outside, 'outside.pdf')
    const outsideBytes = Buffer.from('outside-target-bytes')
    await writeFile(outsideFinal, outsideBytes)
    const linkedParent = resolve(fixture.root, 'linked-parent')
    await symlink(outside, linkedParent, 'dir')
    const neverRun = vi.fn(async () => undefined)

    await expect(
      runPublicationIsolatedRender(
        {
          ...isolatedRenderRequest(fixture),
          outputPath: resolve(linkedParent, 'outside.pdf'),
        },
        {
          ...testRuntimeAttestationDependencies,
          verifyExecutables: async () => undefined,
          runInvocation: neverRun,
        },
      ),
    ).rejects.toThrow(/outside the publication root|symlink/i)
    expect(await readFile(outsideFinal)).toEqual(outsideBytes)

    await rm(fixture.outputPath)
    await symlink(outsideFinal, fixture.outputPath)
    await expect(
      runPublicationIsolatedRender(isolatedRenderRequest(fixture), {
        ...testRuntimeAttestationDependencies,
        verifyExecutables: async () => undefined,
        runInvocation: neverRun,
      }),
    ).rejects.toThrow(/symbolic link|symlink/i)
    expect(await readFile(outsideFinal)).toEqual(outsideBytes)
    expect(neverRun).not.toHaveBeenCalled()
    expect(await publicationResidue(fixture.root)).toEqual([])
  })

  systemdIntegration(
    'coordinator smoke: renders nested assets and proves physical filesystem and network confinement',
    async () => {
      const root = await mkdtemp(resolve('.publication-systemd-smoke-'))
      const tcpCounts = { ipv4: 0, ipv6: 0 }
      const httpCounts = { ipv4: 0, ipv6: 0, ws4: 0, ws6: 0 }
      const udpCounts = { ipv4: 0, ipv6: 0 }
      const tcp4 = createTcpServer((socket) => {
        tcpCounts.ipv4 += 1
        socket.destroy()
      })
      const tcp6 = createTcpServer((socket) => {
        tcpCounts.ipv6 += 1
        socket.destroy()
      })
      const http4 = createServer((_request, response) => {
        httpCounts.ipv4 += 1
        response.end('unexpected')
      })
      const http6 = createServer((_request, response) => {
        httpCounts.ipv6 += 1
        response.end('unexpected')
      })
      http4.on('upgrade', (_request, socket) => {
        httpCounts.ws4 += 1
        socket.destroy()
      })
      http6.on('upgrade', (_request, socket) => {
        httpCounts.ws6 += 1
        socket.destroy()
      })
      const udp4 = createSocket('udp4')
      const udp6 = createSocket('udp6')
      udp4.on('message', () => (udpCounts.ipv4 += 1))
      udp6.on('message', () => (udpCounts.ipv6 += 1))
      const outsidePath = `${root}-outside.svg`
      try {
        const [tcp4Port, tcp6Port, http4Port, http6Port, udp4Port, udp6Port] =
          await Promise.all([
            listenTcp(tcp4, '127.0.0.1'),
            listenTcp(tcp6, '::1'),
            listen(http4, '127.0.0.1'),
            listen(http6, '::1'),
            listenUdp(udp4, '127.0.0.1'),
            listenUdp(udp6, '::1'),
          ])
        await writeFile(outsidePath, '<svg></svg>')
        const outsideLink = resolve(root, 'outside-link.svg')
        await symlink(outsidePath, outsideLink)
        await copyFile(
          'public/fonts/Geist-Regular.ttf',
          resolve(root, 'fixture.ttf'),
        )
        await writeFile(
          resolve(root, 'fixture.png'),
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
            'base64',
          ),
        )
        await writeFile(
          resolve(root, 'publication.css'),
          "@font-face{font-family:Fixture;src:url('./fixture.ttf')} body{font-family:Fixture;background:#f5f5f5} img{width:48px;height:48px}",
        )
        const htmlPath = resolve(root, 'index.html')
        const outputPath = resolve(root, 'publication.pdf')
        await writeFile(
          htmlPath,
          '<!doctype html><link rel="stylesheet" href="publication.css"><main>Boundary fixture<img src="fixture.png" alt="fixture"></main>',
        )
        const renderer = publicationPdfRendererForArchitecture()
        let browserPath: string
        let expectedBrowserVersion: string
        if (renderer === 'playwright-chromium') {
          const candidates = publicationPlaywrightExecutableCandidates(
            PUBLICATION_TOOLCHAIN.browser.compatibility.arm64Revision,
          )
          browserPath = ''
          for (const candidate of candidates) {
            try {
              await access(candidate)
              browserPath = candidate
              break
            } catch {
              // Try the next pinned repository-local layout.
            }
          }
          if (!browserPath)
            throw new Error('Pinned ARM64 browser is unavailable')
          expectedBrowserVersion =
            PUBLICATION_TOOLCHAIN.browser.compatibility.arm64BrowserVersion
        } else {
          browserPath = computeExecutablePath({
            browser: Browser.CHROME,
            buildId: PUBLICATION_TOOLCHAIN.browser.revision,
            cacheDir: resolve(
              'node_modules/.cache/publication-browsers/puppeteer',
            ),
          })
          expectedBrowserVersion = PUBLICATION_TOOLCHAIN.browser.browserVersion
        }
        const proof = (await runPublicationIsolatedRender({
          renderer,
          publicationRoot: root,
          inputPath: htmlPath,
          outputPath,
          size: 'A4',
          browserPath,
          expectedBrowserVersion,
          expectedRendererVersion:
            renderer === 'vivliostyle-cli'
              ? PUBLICATION_TOOLCHAIN.vivliostyleCli.version
              : PUBLICATION_TOOLCHAIN.browser.compatibility.version,
          title: 'Boundary fixture',
          filesystemDiagnosticPaths: [outsidePath, outsideLink],
          networkDiagnostic: {
            tcpIpv4Port: tcp4Port,
            tcpIpv6Port: tcp6Port,
            httpIpv4Port: http4Port,
            httpIpv6Port: http6Port,
            websocketIpv4Port: http4Port,
            websocketIpv6Port: http6Port,
            udpIpv4Port: udp4Port,
            udpIpv6Port: udp6Port,
          },
        })) as {
          networkNamespace: string
          mountNamespace: string
          childNetworkNamespaces: string[]
          childMountNamespaces: string[]
          networkDiagnostic: {
            attempted: string[]
            privateLoopback: { ipv4: boolean; ipv6: boolean }
          }
          filesystemDiagnostics: Array<{
            path: string
            inaccessible: boolean
          }>
        }
        expect(proof.childNetworkNamespaces.length).toBeGreaterThan(0)
        expect(
          proof.childNetworkNamespaces.every(
            (identity) => identity === proof.networkNamespace,
          ),
        ).toBe(true)
        expect(proof.childMountNamespaces.length).toBeGreaterThan(0)
        expect(
          proof.childMountNamespaces.every(
            (identity) => identity === proof.mountNamespace,
          ),
        ).toBe(true)
        expect(proof.networkDiagnostic).toEqual({
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
        })
        expect(proof.filesystemDiagnostics).toEqual([
          { path: outsidePath, inaccessible: true },
          { path: outsideLink, inaccessible: true },
        ])
        await new Promise((accept) => setTimeout(accept, 50))
        expect(tcpCounts).toEqual({ ipv4: 0, ipv6: 0 })
        expect(httpCounts).toEqual({ ipv4: 0, ipv6: 0, ws4: 0, ws6: 0 })
        expect(udpCounts).toEqual({ ipv4: 0, ipv6: 0 })
        const pdf = await PDFDocument.load(await readFile(outputPath))
        const resources = pdf.getPage(0).node.Resources()
        expect(
          resources?.lookup(PDFName.of('Font'), PDFDict)?.keys().length,
        ).toBeGreaterThan(0)
        expect(
          resources?.lookup(PDFName.of('XObject'), PDFDict)?.keys().length,
        ).toBeGreaterThan(0)
        expect(
          (await readdir(root)).some((name) =>
            name.startsWith('.publication-'),
          ),
        ).toBe(false)
        const successfulDigest = sha256(await readFile(outputPath))
        const escapedName = basename(outsidePath)
        const invalidCarriers = [
          async () =>
            writeFile(htmlPath, `<!doctype html><img src="${outsidePath}">`),
          async () => {
            await writeFile(
              resolve(root, 'publication.css'),
              `main{background-image:image-set("${pathToFileURL(outsidePath).href}" 1x)}`,
            )
            await writeFile(
              htmlPath,
              '<!doctype html><link rel="stylesheet" href="publication.css"><main>fixture</main>',
            )
          },
          async () =>
            writeFile(
              htmlPath,
              `<svg><rect fill="url(${pathToFileURL(outsidePath).href})"/></svg>`,
            ),
          async () =>
            writeFile(
              htmlPath,
              `<svg><animate attributeName="xlink:href" values="#local;${pathToFileURL(outsidePath).href}"/></svg>`,
            ),
          async () => writeFile(htmlPath, `<img src="%2e%2e/${escapedName}">`),
          async () => writeFile(htmlPath, '<img src="outside-link.svg">'),
        ]
        for (const prepareInvalidCarrier of invalidCarriers) {
          await prepareInvalidCarrier()
          await expect(
            runPublicationIsolatedRender({
              renderer,
              publicationRoot: root,
              inputPath: htmlPath,
              outputPath,
              size: 'A4',
              browserPath,
              expectedBrowserVersion,
              expectedRendererVersion:
                renderer === 'vivliostyle-cli'
                  ? PUBLICATION_TOOLCHAIN.vivliostyleCli.version
                  : PUBLICATION_TOOLCHAIN.browser.compatibility.version,
              title: 'Boundary fixture',
            }),
          ).rejects.toThrow(/systemd-run exited with status/)
          expect(sha256(await readFile(outputPath))).toBe(successfulDigest)
          expect(await publicationResidue(root)).toEqual([])
        }
      } finally {
        await Promise.all([
          closeTcp(tcp4),
          closeTcp(tcp6),
          closeUdp(udp4),
          closeUdp(udp6),
          closeServer(http4),
          closeServer(http6),
        ])
        await rm(outsidePath, { force: true })
        await rm(root, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
