import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  assertIsolationSnapshot,
  assertPublicationResourceUrl,
  authenticatePublicationRequest,
  executePublicationRenderRequest,
  publicationBrowserVersionMatches,
  publicationChildEnvironment,
  renderPlaywrightPublication,
  validatePublicationResources,
} from './publication-offline-render.mjs'

function requestFor(root, renderer = 'playwright-chromium') {
  const environment = publicationChildEnvironment(root)
  return {
    version: 2,
    renderer,
    publicationRoot: root,
    stagingDirectory: root,
    inputPath: resolve(root, 'index.html'),
    outputPath: resolve(root, 'publication.pdf'),
    proofPath: resolve(root, 'isolation-proof.json'),
    size: 'A4',
    browserPath: resolve(
      'node_modules/.cache/publication-browsers/playwright/chromium-1228/chrome-linux/chrome',
    ),
    expectedBrowserVersion: '149.0.7827.0',
    expectedRendererVersion:
      renderer === 'vivliostyle-cli' ? '11.1.0' : '1.61.1',
    expectedNodeVersion: process.versions.node,
    expectedEnvironmentSha256: createHash('sha256')
      .update(JSON.stringify(Object.entries(environment).sort()))
      .digest('hex'),
    expectedUid: 1000,
    expectedGid: 1000,
    hostNetworkNamespace: 'net:[100]',
    hostMountNamespace: 'mnt:[100]',
    runtimeEntries: [],
    networkDiagnostic: null,
    filesystemDiagnosticPaths: [],
  }
}

async function localPublicationFixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'publication-helper-'))
  await mkdir(resolve(root, 'assets'))
  await writeFile(resolve(root, 'assets', 'fixture.svg'), '<svg></svg>')
  await writeFile(resolve(root, 'assets', 'fixture.ttf'), 'font fixture')
  await writeFile(
    resolve(root, 'publication.css'),
    "@font-face{font-family:Fixture;src:url('./assets/fixture.ttf')} body{background-image:url('./assets/fixture.svg')}",
  )
  await writeFile(
    resolve(root, 'index.html'),
    '<!doctype html><link rel="stylesheet" href="publication.css"><main><img src="assets/fixture.svg" alt="fixture"></main>',
  )
  return root
}

describe('offline publication render helper', () => {
  it('authenticates the exact narrow request bytes', async () => {
    const root = await localPublicationFixture()
    const serialized = `${JSON.stringify(requestFor(root))}\n`
    const digest = createHash('sha256').update(serialized).digest('hex')

    expect(authenticatePublicationRequest(serialized, digest)).toMatchObject({
      version: 2,
      renderer: 'playwright-chromium',
      publicationRoot: root,
    })
    expect(() =>
      authenticatePublicationRequest(`${serialized} `, digest),
    ).toThrow(/digest/i)
    expect(() =>
      authenticatePublicationRequest(
        JSON.stringify({ ...requestFor(root), command: '/bin/sh' }),
        createHash('sha256')
          .update(JSON.stringify({ ...requestFor(root), command: '/bin/sh' }))
          .digest('hex'),
      ),
    ).toThrow(/unexpected request field/i)
  })

  it('requires the exact pinned browser version inside the helper', () => {
    expect(
      publicationBrowserVersionMatches('Chromium 149.0.7827.0', '149.0.7827.0'),
    ).toBe(true)
    expect(
      publicationBrowserVersionMatches(
        'Chromium 149.0.7827.55',
        '149.0.7827.0',
      ),
    ).toBe(false)
  })

  it('accepts expected HTML, CSS, font, and image assets inside the publication root', async () => {
    const root = await localPublicationFixture()
    await expect(
      validatePublicationResources(requestFor(root)),
    ).resolves.toEqual(
      expect.arrayContaining([
        resolve(root, 'index.html'),
        resolve(root, 'publication.css'),
        resolve(root, 'assets', 'fixture.ttf'),
        resolve(root, 'assets', 'fixture.svg'),
      ]),
    )
  })

  it('rejects outside-root files and arbitrary file, data, blob, or network resources', async () => {
    const root = await localPublicationFixture()
    const outside = `${root}-outside-publication.png`
    await writeFile(outside, 'outside')

    await expect(
      assertPublicationResourceUrl(
        pathToFileURL(outside).href,
        resolve(root, 'index.html'),
        root,
      ),
    ).rejects.toThrow(/outside publication root/i)
    await writeFile(
      resolve(root, 'index.html'),
      `<img src="../${basename(outside)}">`,
    )
    await expect(
      validatePublicationResources(requestFor(root)),
    ).rejects.toThrow(/outside publication root/i)
    await writeFile(
      resolve(root, 'index.html'),
      '<img src="assets/fixture.svg" onload="fetch(`https://example.invalid`)">',
    )
    await expect(
      validatePublicationResources(requestFor(root)),
    ).rejects.toThrow(/active publication attribute/i)
    await writeFile(
      resolve(root, 'index.html'),
      '<link rel="stylesheet" href="publication.css">',
    )
    await writeFile(
      resolve(root, 'publication.css'),
      '@font-face{font-family:ambient;src:local("system font")}',
    )
    await expect(
      validatePublicationResources(requestFor(root)),
    ).rejects.toThrow(/Ambient local fonts/i)
    for (const url of [
      'data:image/png;base64,AA==',
      'blob:null/fixture',
      'http://127.0.0.1/fixture.png',
      'https://example.invalid/fixture.png',
    ])
      await expect(
        assertPublicationResourceUrl(url, resolve(root, 'index.html'), root),
      ).rejects.toThrow(/disallowed publication resource/i)
  })

  it('attests a distinct loopback-only namespace, caller identity, and empty capabilities', () => {
    const root = '/tmp/publication-root'
    const environment = publicationChildEnvironment(root)
    const proof = assertIsolationSnapshot(
      {
        networkNamespace: 'net:[200]',
        mountNamespace: 'mnt:[200]',
        interfaces: [{ name: 'lo', up: true }],
        ipv4RouteInterfaces: ['lo'],
        ipv6RouteInterfaces: ['lo'],
        uid: 1000,
        gid: 1000,
        groups: [1000],
        capabilities: {
          inheritable: '0000000000000000',
          permitted: '0000000000000000',
          effective: '0000000000000000',
          ambient: '0000000000000000',
        },
        noNewPrivileges: true,
        cwd: root,
        environment,
        childNetworkNamespaces: ['net:[200]', 'net:[200]'],
        childMountNamespaces: ['mnt:[200]', 'mnt:[200]'],
      },
      requestFor(root),
    )
    expect(proof).toMatchObject({
      networkNamespace: 'net:[200]',
      mountNamespace: 'mnt:[200]',
      interfaces: ['lo'],
      childNetworkNamespaces: ['net:[200]'],
      childMountNamespaces: ['mnt:[200]'],
    })

    expect(() =>
      assertIsolationSnapshot(
        {
          networkNamespace: 'net:[100]',
          mountNamespace: 'mnt:[200]',
          interfaces: [{ name: 'lo', up: true }],
          ipv4RouteInterfaces: ['lo'],
          ipv6RouteInterfaces: ['lo'],
          uid: 1000,
          gid: 1000,
          groups: [1000],
          capabilities: {
            inheritable: '0',
            permitted: '0',
            effective: '0',
            ambient: '0',
          },
          noNewPrivileges: true,
          cwd: root,
          environment,
          childNetworkNamespaces: [],
          childMountNamespaces: [],
        },
        requestFor(root),
      ),
    ).toThrow(/host network namespace/i)
  })

  it.each(['vivliostyle-cli', 'playwright-chromium'])(
    'attests before browser verification and %s rendering',
    async (renderer) => {
      const root = await localPublicationFixture()
      const events = []
      const request = requestFor(root, renderer)
      const proof = {
        networkNamespace: 'net:[200]',
        mountNamespace: 'mnt:[200]',
      }
      await executePublicationRenderRequest(request, {
        attestIsolation: async () => {
          events.push('attest')
          return proof
        },
        validateResources: async () => events.push('resources'),
        verifyRenderer: async () => events.push('renderer-version'),
        verifyBrowser: async () => events.push('browser-version'),
        renderVivliostyle: async () => events.push('vivliostyle'),
        renderPlaywright: async () => events.push('playwright'),
      })
      expect(events).toEqual([
        'attest',
        'resources',
        'renderer-version',
        'browser-version',
        renderer === 'vivliostyle-cli' ? 'vivliostyle' : 'playwright',
      ])
    },
  )

  it('aborts on isolation attestation failure before browser verification', async () => {
    const root = await localPublicationFixture()
    const verifyBrowser = vi.fn()
    await expect(
      executePublicationRenderRequest(requestFor(root), {
        attestIsolation: async () => {
          throw new Error('private network attestation failed')
        },
        verifyBrowser,
      }),
    ).rejects.toThrow(/attestation failed/)
    expect(verifyBrowser).not.toHaveBeenCalled()
  })

  it('uses a fresh service-worker-blocked context and closes it before returning', async () => {
    const root = await localPublicationFixture()
    const events = []
    const page = {
      emulateMedia: vi.fn(async () => events.push('media')),
      goto: vi.fn(async () => events.push('goto')),
      pdf: vi.fn(async () => events.push('pdf')),
    }
    const context = {
      route: vi.fn(async () => events.push('route')),
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => events.push('context-close')),
    }
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => events.push('browser-close')),
    }
    const chromium = { launch: vi.fn(async () => browser) }

    await renderPlaywrightPublication(requestFor(root), { chromium })
    await renderPlaywrightPublication(requestFor(root), { chromium })

    expect(browser.newContext).toHaveBeenCalledTimes(2)
    expect(browser.newContext).toHaveBeenCalledWith({
      serviceWorkers: 'block',
    })
    expect(page.goto).toHaveBeenCalledWith(
      pathToFileURL(resolve(root, 'index.html')).href,
      {
        waitUntil: 'networkidle',
      },
    )
    expect(events).toEqual([
      'route',
      'media',
      'goto',
      'pdf',
      'context-close',
      'browser-close',
      'route',
      'media',
      'goto',
      'pdf',
      'context-close',
      'browser-close',
    ])
    const routeHandler = context.route.mock.calls[0][1]
    const blockedRoute = {
      request: () => ({ url: () => 'data:text/plain,blocked' }),
      continue: vi.fn(),
      abort: vi.fn(),
    }
    await routeHandler(blockedRoute)
    expect(blockedRoute.continue).not.toHaveBeenCalled()
    expect(blockedRoute.abort).toHaveBeenCalledWith('blockedbyclient')
  })
})
