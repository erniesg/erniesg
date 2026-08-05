import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createSocket } from 'node:dgram'
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { Browser, computeExecutablePath } from '@puppeteer/browsers'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { describe, expect, it, vi } from 'vitest'
import {
  PUBLICATION_TOOLCHAIN,
  publicationPdfRendererForArchitecture,
} from '../toolchain'
import { publicationPlaywrightExecutableCandidates } from './vivliostyle'
import {
  PUBLICATION_BOUNDARY_EXECUTABLES,
  assertPublicationBoundaryRuntime,
  buildPublicationSystemdInvocation,
  createPublicationUnitName,
  runPublicationIsolatedRender,
  runPublicationSystemdInvocation,
  verifyPublicationBoundaryExecutables,
} from './systemd-boundary'

const invocationInput = {
  publicationRoot: '/tmp/publication root',
  requestPath: '/tmp/publication root/.offline-request.json',
  requestSha256: 'a'.repeat(64),
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
        '--property=ProtectKernelTunables=yes',
        '--property=ProtectKernelModules=yes',
        '--property=ProtectKernelLogs=yes',
        '--property=ProtectControlGroups=yes',
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
        '--request=/tmp/publication root/.offline-request.json',
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
  })

  it('uses only absolute trusted boundary tools despite a shadowed PATH', () => {
    const originalPath = process.env.PATH
    process.env.PATH = '/tmp/path-shadow'
    try {
      const invocation = buildPublicationSystemdInvocation(invocationInput)
      expect(invocation.command).toBe(PUBLICATION_BOUNDARY_EXECUTABLES.sudo)
      const completeArgv = [invocation.command, ...invocation.args]
      for (const executable of Object.values(PUBLICATION_BOUNDARY_EXECUTABLES))
        expect(completeArgv).toContain(executable)
      expect(invocation.environment.PATH).toBe('/usr/bin')
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('generates a unique bounded systemd unit name', () => {
    const name = createPublicationUnitName(1234, 'abcdef0123456789')
    expect(name).toBe('erniesg-publication-1234-abcdef0123456789')
    expect(name.length).toBeLessThanOrEqual(63)
    expect(name).toMatch(/^[a-z0-9-]+$/)
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
      assertPublicationBoundaryRuntime({ platform: 'linux', uid: 0, gid: 0 }),
    ).toThrow(/must not run as root/)
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

  systemdIntegration(
    'coordinator smoke: renders real local assets and proves host sentinels stay untouched',
    async () => {
      const root = await mkdtemp(resolve('.publication-systemd-smoke-'))
      const httpCounts = { ipv4: 0, ipv6: 0, ws4: 0, ws6: 0 }
      const udpCounts = { ipv4: 0, ipv6: 0 }
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
      try {
        const [http4Port, http6Port, udp4Port, udp6Port] = await Promise.all([
          listen(http4, '127.0.0.1'),
          listen(http6, '::1'),
          listenUdp(udp4, '127.0.0.1'),
          listenUdp(udp6, '::1'),
        ])
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
        })) as {
          networkNamespace: string
          childNetworkNamespaces: string[]
        }
        expect(proof.childNetworkNamespaces.length).toBeGreaterThan(0)
        expect(
          proof.childNetworkNamespaces.every(
            (identity) => identity === proof.networkNamespace,
          ),
        ).toBe(true)
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

        const outsidePath = `${root}-outside.png`
        await writeFile(outsidePath, 'outside')
        try {
          await writeFile(htmlPath, `<!doctype html><img src="${outsidePath}">`)
          await expect(
            runPublicationIsolatedRender({
              renderer,
              publicationRoot: root,
              inputPath: htmlPath,
              outputPath,
              size: 'A4',
              browserPath,
              expectedBrowserVersion,
            }),
          ).rejects.toThrow(/systemd-run exited with status/)
          await writeFile(
            htmlPath,
            `<!doctype html><img src="${outsidePath}"><script>navigator.serviceWorker?.register('service-worker.js');fetch('http://127.0.0.1:${http4Port}/fresh',{cache:'reload'});fetch('http://[::1]:${http6Port}/fresh');new WebSocket('ws://127.0.0.1:${http4Port}/delayed');new WebSocket('ws://[::1]:${http6Port}/delayed');const peer=new RTCPeerConnection({iceServers:[{urls:['stun:127.0.0.1:${udp4Port}','stun:[::1]:${udp6Port}']}]});peer.createDataChannel('probe');peer.createOffer().then((offer)=>peer.setLocalDescription(offer));setTimeout(()=>fetch('http://dns-probe.invalid/delayed'),250)</script>`,
          )
          await expect(
            runPublicationIsolatedRender({
              renderer,
              publicationRoot: root,
              inputPath: htmlPath,
              outputPath,
              size: 'A4',
              browserPath,
              expectedBrowserVersion,
            }),
          ).rejects.toThrow(/systemd-run exited with status/)
          await new Promise((accept) => setTimeout(accept, 350))
          expect(httpCounts).toEqual({ ipv4: 0, ipv6: 0, ws4: 0, ws6: 0 })
          expect(udpCounts).toEqual({ ipv4: 0, ipv6: 0 })
        } finally {
          await rm(outsidePath, { force: true })
        }
      } finally {
        await Promise.all([
          closeUdp(udp4),
          closeUdp(udp6),
          closeServer(http4),
          closeServer(http6),
        ])
        await rm(root, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
