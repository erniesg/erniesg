import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  assertIsolationSnapshot,
  assertPublicationResourceUrl,
  attestRuntimeForest,
  authenticatePublicationRequest,
  createPublicationSourceSnapshot,
  executePublicationRenderRequest,
  materializePublicationSourceSnapshot,
  PUBLICATION_SOURCE_MAXIMUM_FILE_BYTES,
  publicationBrowserVersionMatches,
  publicationChildEnvironment,
  renderPlaywrightPublication,
  validatePublicationResources,
  verifyRuntimeEntries,
} from './publication-offline-render.mjs'

const LOCAL_SOURCE_CONTENTS = {
  'assets/fixture.svg': '<svg></svg>',
  'assets/fixture.ttf': 'font fixture',
  'index.html':
    '<!doctype html><link rel="stylesheet" href="publication.css"><main><img src="assets/fixture.svg" alt="fixture"></main>',
  'publication.css':
    "@font-face{font-family:Fixture;src:url('./assets/fixture.ttf')} body{background-image:url('./assets/fixture.svg')}",
}

function sourceManifest(contents = LOCAL_SOURCE_CONTENTS) {
  const sourceEntries = Object.entries(contents)
    .map(([path, value]) => ({
      path,
      byteLength: Buffer.byteLength(value),
      sha256: createHash('sha256').update(value).digest('hex'),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
  return {
    sourceEntries,
    sourceInputPath: 'index.html',
    sourceSha256: createHash('sha256')
      .update(JSON.stringify(sourceEntries))
      .digest('hex'),
  }
}

function fakeRuntimeEntry(kind, label, path) {
  return {
    kind,
    label,
    path,
    sha256: 'a'.repeat(64),
    ...(kind === 'file'
      ? { byteLength: '1', mode: '700' }
      : { entryCount: 1, identitySha256: 'b'.repeat(64) }),
    device: '1',
    inode: '1',
    ctimeNanoseconds: '1',
    parentPath: dirname(path),
    parentDevice: '1',
    parentInode: '1',
    parentCtimeNanoseconds: '1',
  }
}

function fakeRuntimeClosure(paths) {
  return {
    kind: 'forest',
    label: 'runtime-package-closure',
    paths: [...paths].sort(),
    sha256: 'a'.repeat(64),
    identitySha256: 'b'.repeat(64),
    entryCount: paths.length,
  }
}

function fakeRuntimeEntries(renderer, browserPath) {
  const entries = [
    fakeRuntimeEntry('tree', 'browser-runtime', dirname(browserPath)),
    fakeRuntimeEntry(
      'file',
      'isolation-helper',
      resolve('tools/publication-offline-render.mjs'),
    ),
    fakeRuntimeEntry('file', 'node-executable', '/usr/bin/node'),
  ]
  const packages = [resolve('node_modules/parse5')]
  if (renderer === 'vivliostyle-cli')
    packages.push(resolve('node_modules/@vivliostyle/cli'))
  else {
    packages.push(
      resolve('node_modules/playwright'),
      resolve('node_modules/playwright-core'),
    )
  }
  entries.push(fakeRuntimeClosure(packages))
  return entries.sort((left, right) => left.label.localeCompare(right.label))
}

function requestFor(root, renderer = 'playwright-chromium') {
  const environment = publicationChildEnvironment(root)
  const stagingDirectory = dirname(root)
  const browserPath = resolve(
    'node_modules/.cache/publication-browsers/playwright/chromium-1228/chrome-linux/chrome',
  )
  return {
    version: 5,
    renderer,
    publicationRoot: root,
    stagingDirectory,
    inputPath: resolve(root, 'index.html'),
    outputPath: resolve(stagingDirectory, 'publication.pdf'),
    ...sourceManifest(),
    size: 'A4',
    browserPath,
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
    hostPidNamespace: 'pid:[100]',
    expectedUnitName: 'erniesg-publication-test-0123456789abcdef',
    expectedControlGroup:
      '/system.slice/erniesg-publication-test-0123456789abcdef.service',
    expectedIdentityName: 'epub-0123456789abcdef',
    runtimeEntries: fakeRuntimeEntries(renderer, browserPath),
    networkDiagnostic: null,
    filesystemDiagnosticPaths: [],
  }
}

async function localPublicationFixture() {
  const stagingDirectory = await mkdtemp(
    resolve(tmpdir(), 'publication-helper-'),
  )
  const root = resolve(stagingDirectory, 'source')
  await mkdir(resolve(root, 'assets'), { recursive: true })
  await Promise.all(
    Object.entries(LOCAL_SOURCE_CONTENTS).map(([path, contents]) =>
      writeFile(resolve(root, path), contents),
    ),
  )
  return root
}

async function nestedPublicationFixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'publication-helper-nested-'))
  await Promise.all([
    mkdir(resolve(root, 'chapters')),
    mkdir(resolve(root, 'styles')),
    mkdir(resolve(root, 'assets', 'images'), { recursive: true }),
    mkdir(resolve(root, 'assets', 'fonts'), { recursive: true }),
  ])
  const files = {
    html: resolve(root, 'chapters', 'index.html'),
    css: resolve(root, 'styles', 'print.css'),
    image: resolve(root, 'assets', 'images', 'fixture.svg'),
    font: resolve(root, 'assets', 'fonts', 'fixture.ttf'),
  }
  const trusted = {
    html: '<!doctype html><link rel="stylesheet" href="../styles/print.css"><main>trusted</main>',
    css: "@font-face{font-family:Trusted;src:url('../assets/fonts/fixture.ttf')}main{background:url('../assets/images/fixture.svg')}",
    image: '<svg>trusted</svg>',
    font: 'trusted-font-bytes',
  }
  await Promise.all([
    writeFile(files.html, trusted.html),
    writeFile(files.css, trusted.css),
    writeFile(files.image, trusted.image),
    writeFile(files.font, trusted.font),
  ])
  return { root, files, trusted }
}

describe('offline publication render helper', () => {
  it('authenticates the exact narrow request bytes', async () => {
    const root = await localPublicationFixture()
    const serialized = `${JSON.stringify(requestFor(root))}\n`
    const digest = createHash('sha256').update(serialized).digest('hex')

    expect(authenticatePublicationRequest(serialized, digest)).toMatchObject({
      version: 5,
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

  it('rejects malformed source manifests before touching renderer state', async () => {
    const root = await localPublicationFixture()
    const request = requestFor(root)
    const authenticate = (candidate) => {
      const serialized = `${JSON.stringify(candidate)}\n`
      return () =>
        authenticatePublicationRequest(
          serialized,
          createHash('sha256').update(serialized).digest('hex'),
        )
    }
    const first = request.sourceEntries[0]

    expect(
      authenticate({
        ...request,
        sourceEntries: [first, first, ...request.sourceEntries.slice(1)],
      }),
    ).toThrow(/source snapshot manifest/i)
    expect(
      authenticate({
        ...request,
        sourceEntries: [
          { ...first, path: '../outside' },
          ...request.sourceEntries.slice(1),
        ],
      }),
    ).toThrow(/source snapshot entry/i)
    expect(authenticate({ ...request, sourceSha256: '0'.repeat(64) })).toThrow(
      /source snapshot manifest/i,
    )
    expect(
      authenticate({
        ...request,
        sourceEntries: [
          { ...first, untrusted: true },
          ...request.sourceEntries.slice(1),
        ],
      }),
    ).toThrow(/source snapshot entry/i)
  })

  it('rejects truncated and symlink-replaced snapshots without private residue', async () => {
    const root = await localPublicationFixture()
    const request = requestFor(root)
    const prefix = `publication-source-${request.sourceSha256.slice(0, 16)}-`
    const before = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith(prefix)),
    )
    await truncate(resolve(root, 'assets', 'fixture.ttf'), 4)
    await expect(materializePublicationSourceSnapshot(request)).rejects.toThrow(
      /does not match|bounded regular file/i,
    )
    expect(
      (await readdir(tmpdir())).filter(
        (name) => name.startsWith(prefix) && !before.has(name),
      ),
    ).toEqual([])

    const symlinkRoot = await localPublicationFixture()
    const symlinkRequest = requestFor(symlinkRoot)
    const outside = `${symlinkRoot}-outside.svg`
    await writeFile(outside, '<svg></svg>')
    await rm(resolve(symlinkRoot, 'assets', 'fixture.svg'))
    await symlink(outside, resolve(symlinkRoot, 'assets', 'fixture.svg'))
    await expect(
      materializePublicationSourceSnapshot(symlinkRequest),
    ).rejects.toThrow(/not canonical|unsafe/i)
  })

  it('rejects unbounded source files and removes a partial snapshot', async () => {
    const root = await localPublicationFixture()
    const stagingDirectory = await mkdtemp(
      resolve(tmpdir(), 'publication-source-unbounded-'),
    )
    const snapshotRoot = resolve(stagingDirectory, 'source')
    await truncate(
      resolve(root, 'assets', 'fixture.svg'),
      PUBLICATION_SOURCE_MAXIMUM_FILE_BYTES + 1,
    )

    await expect(
      createPublicationSourceSnapshot(
        root,
        resolve(root, 'index.html'),
        snapshotRoot,
      ),
    ).rejects.toThrow(/bounded regular file/i)
    await expect(access(snapshotRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects non-regular source resources', async () => {
    const root = await localPublicationFixture()
    const image = resolve(root, 'assets', 'fixture.svg')
    await rm(image)
    await mkdir(image)

    await expect(
      createPublicationSourceSnapshot(
        root,
        resolve(root, 'index.html'),
        resolve(dirname(root), 'replacement-source'),
      ),
    ).rejects.toThrow(/not a regular file/i)
  })

  it('requires a closed, in-repository runtime package allowlist', async () => {
    const root = await localPublicationFixture()
    const request = requestFor(root)
    const closure = request.runtimeEntries.find(({ kind }) => kind === 'forest')
    const authenticate = (candidate) => {
      const serialized = `${JSON.stringify(candidate)}\n`
      return () =>
        authenticatePublicationRequest(
          serialized,
          createHash('sha256').update(serialized).digest('hex'),
        )
    }
    expect(closure).toBeDefined()
    const missingRequired = {
      ...request,
      runtimeEntries: request.runtimeEntries.map((entry) =>
        entry === closure
          ? {
              ...entry,
              paths: entry.paths.filter(
                (path) => path !== resolve('node_modules/playwright-core'),
              ),
            }
          : entry,
      ),
    }
    expect(authenticate(missingRequired)).toThrow(/package closure/i)
    const outsideExpansion = {
      ...request,
      runtimeEntries: request.runtimeEntries.map((entry) =>
        entry === closure
          ? { ...entry, paths: [...entry.paths, '/tmp/outside-runtime'].sort() }
          : entry,
      ),
    }
    expect(authenticate(outsideExpansion)).toThrow(/package closure/i)
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

  it('rejects a same-size mutation anywhere in the authenticated runtime closure', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-helper-runtime-'))
    const first = resolve(root, 'first')
    const second = resolve(root, 'second')
    try {
      await Promise.all([mkdir(first), mkdir(second)])
      await writeFile(resolve(first, 'package.json'), '{}\n')
      const runtimePath = resolve(second, 'runtime.js')
      await writeFile(runtimePath, 'export const trusted = true\n')
      const attestation = await attestRuntimeForest('runtime-package-closure', [
        first,
        second,
      ])
      await writeFile(runtimePath, 'export const trusted = null\n')

      await expect(verifyRuntimeEntries([attestation])).rejects.toThrow(
        /runtime attestation changed/i,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds runtime symlinks to targets inside the authenticated closure', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-helper-runtime-'))
    const links = resolve(root, 'links')
    const targets = resolve(root, 'targets')
    try {
      await Promise.all([mkdir(links), mkdir(targets)])
      const target = resolve(targets, 'runtime.js')
      await writeFile(target, 'export const trusted = true\n')
      await symlink('../targets/runtime.js', resolve(links, 'runtime.js'))
      const attestation = await attestRuntimeForest('runtime-package-closure', [
        links,
        targets,
      ])
      const replacement = resolve(targets, 'replacement.js')
      await writeFile(replacement, 'export const trusted = null\n')
      await rename(replacement, target)

      await expect(verifyRuntimeEntries([attestation])).rejects.toThrow(
        /runtime attestation changed/i,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects runtime symlinks that escape every authenticated root', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-helper-runtime-'))
    const closureRoot = resolve(root, 'closure')
    const outside = resolve(root, 'outside.js')
    try {
      await mkdir(closureRoot)
      await writeFile(outside, 'export const outside = true\n')
      await symlink(outside, resolve(closureRoot, 'linked.js'))

      await expect(
        attestRuntimeForest('runtime-package-closure', [closureRoot]),
      ).rejects.toThrow(/symlink target.*authenticated runtime root/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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

  it.each([
    [
      'an XML declaration',
      '<?xml version="1.0"?><?xml-stylesheet href="outside.css"?><svg/>',
    ],
    ['a comment', '<!-- lead --><?xml-stylesheet href="outside.css"?><svg/>'],
    ['whitespace', ' \n\t<?xml-stylesheet href="outside.css"?><svg/>'],
    [
      'another processing instruction',
      '<?xml-model href="schema.rng"?><?xml-stylesheet href="outside.css"?><svg/>',
    ],
    ['mixed case', '<?XmL-StYlEsHeEt href="outside.css"?><svg/>'],
  ])('rejects an SVG XML stylesheet PI after %s', async (_prefix, svg) => {
    const root = await localPublicationFixture()
    await writeFile(resolve(root, 'assets', 'fixture.svg'), svg)

    await expect(
      validatePublicationResources(requestFor(root)),
    ).rejects.toThrow(/XML stylesheet processing instructions/i)
  })

  it('accepts an SVG preamble without an XML stylesheet PI', async () => {
    const root = await localPublicationFixture()
    await writeFile(
      resolve(root, 'assets', 'fixture.svg'),
      '<?xml version="1.0"?>\n<!-- safe -->\n<?xml-model href="schema.rng"?>\n<svg/>',
    )

    await expect(
      validatePublicationResources(requestFor(root)),
    ).resolves.toContain(resolve(root, 'assets', 'fixture.svg'))
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
    ).rejects.toThrow(/outside publication root|symbolic links/i)
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

  it.each(['image-set', '-webkit-image-set'])(
    'discovers outside-root string URLs in CSS %s()',
    async (functionName) => {
      const root = await localPublicationFixture()
      const outside = `${root}-outside-image-set.svg`
      await writeFile(outside, '<svg></svg>')
      await writeFile(
        resolve(root, 'publication.css'),
        `main{background-image:${functionName}("${pathToFileURL(outside).href}" 1x)}`,
      )

      await expect(
        validatePublicationResources(requestFor(root)),
      ).rejects.toThrow(/outside publication root/i)
    },
  )

  it.each([
    '<svg><rect fill="url(OUTSIDE)"/></svg>',
    '<svg><animate attributeName="fill" from="none" to="url(OUTSIDE)"/></svg>',
    '<svg><set attributeName="href" to="OUTSIDE"/></svg>',
    '<svg><animate attributeName="xlink:href" values="#local;OUTSIDE"/></svg>',
  ])('discovers outside-root SVG presentation and SMIL URLs', async (svg) => {
    const root = await localPublicationFixture()
    const outside = `${root}-outside-svg.svg`
    await writeFile(outside, '<svg></svg>')
    await writeFile(
      resolve(root, 'index.html'),
      svg.replaceAll('OUTSIDE', pathToFileURL(outside).href),
    )

    await expect(
      validatePublicationResources(requestFor(root)),
    ).rejects.toThrow(/outside publication root|symbolic links/i)
  })

  it('canonicalizes encoded traversal and in-root symlink resources', async () => {
    const root = await localPublicationFixture()
    const outside = `${root}-outside-encoded.svg`
    await writeFile(outside, '<svg></svg>')
    const outsideName = basename(outside)
    await writeFile(
      resolve(root, 'index.html'),
      `<img src="%2e%2e/${outsideName}">`,
    )
    await expect(
      validatePublicationResources(requestFor(root)),
    ).rejects.toThrow(/outside publication root/i)
    await writeFile(
      resolve(root, 'index.html'),
      `<img src="..%2f${outsideName}">`,
    )
    await expect(
      validatePublicationResources(requestFor(root)),
    ).rejects.toThrow(/unavailable|outside publication root/i)

    const escape = resolve(root, 'assets', 'escape.svg')
    await symlink(outside, escape)
    await writeFile(
      resolve(root, 'index.html'),
      '<img src="assets/escape.svg">',
    )
    await expect(
      validatePublicationResources(requestFor(root)),
    ).rejects.toThrow(/outside publication root|symbolic links/i)
  })

  it('attests a distinct loopback-only namespace, caller identity, and empty capabilities', () => {
    const root = '/tmp/publication-root'
    const environment = publicationChildEnvironment(root)
    const snapshot = {
      networkNamespace: 'net:[200]',
      mountNamespace: 'mnt:[200]',
      pidNamespace: 'pid:[200]',
      nspid: [1],
      cgroup: '/system.slice/erniesg-publication-test-0123456789abcdef.service',
      interfaces: [{ name: 'lo', up: true }],
      ipv4RouteInterfaces: ['lo'],
      ipv6RouteInterfaces: ['lo'],
      uid: 62000,
      gid: 62000,
      groups: [62000],
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
      childPidNamespaces: ['pid:[200]', 'pid:[200]'],
      childCgroups: [
        '/system.slice/erniesg-publication-test-0123456789abcdef.service',
      ],
    }
    const request = requestFor(root)
    const proof = assertIsolationSnapshot(snapshot, request)
    expect(proof).toMatchObject({
      networkNamespace: 'net:[200]',
      mountNamespace: 'mnt:[200]',
      pidNamespace: 'pid:[200]',
      cgroup: '/system.slice/erniesg-publication-test-0123456789abcdef.service',
      interfaces: ['lo'],
      childNetworkNamespaces: ['net:[200]'],
      childMountNamespaces: ['mnt:[200]'],
      childPidNamespaces: ['pid:[200]'],
    })
    expect(() =>
      assertIsolationSnapshot(
        { ...snapshot, childPidNamespaces: ['pid:[300]'] },
        request,
      ),
    ).toThrow(/escaped the private PID namespace/i)
    expect(() =>
      assertIsolationSnapshot(
        { ...snapshot, childCgroups: ['/system.slice/escaped.service'] },
        request,
      ),
    ).toThrow(/escaped the transient-unit cgroup/i)
    expect(() =>
      assertIsolationSnapshot(
        { ...snapshot, uid: request.expectedUid },
        request,
      ),
    ).toThrow(/distinct kernel identity/i)

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
        pidNamespace: 'pid:[200]',
        cgroup: request.expectedControlGroup,
      }
      await executePublicationRenderRequest(request, {
        attestIsolation: async () => {
          events.push('attest')
          return proof
        },
        verifyRuntimeEntries: async () => events.push('runtime'),
        validateResources: async () => events.push('resources'),
        verifyRenderer: async () => events.push('renderer-version'),
        verifyBrowser: async () => events.push('browser-version'),
        renderVivliostyle: async () => events.push('vivliostyle'),
        renderPlaywright: async () => events.push('playwright'),
      })
      expect(events).toEqual([
        'attest',
        'runtime',
        'resources',
        'renderer-version',
        'browser-version',
        renderer === 'vivliostyle-cli' ? 'vivliostyle' : 'playwright',
        'runtime',
      ])
    },
  )

  it.each(['vivliostyle-cli', 'playwright-chromium'])(
    'renders %s only from immutable nested source bytes after live replacement',
    async (renderer) => {
      const fixture = await nestedPublicationFixture()
      const stagingDirectory = await mkdtemp(
        resolve(tmpdir(), 'publication-source-stage-'),
      )
      const sourceSnapshot = await createPublicationSourceSnapshot(
        fixture.root,
        fixture.files.html,
        resolve(stagingDirectory, 'source'),
      )
      const outside = `${fixture.root}-outside.svg`
      await writeFile(outside, '<svg>hostile</svg>')
      const request = {
        ...requestFor(sourceSnapshot.root, renderer),
        inputPath: sourceSnapshot.inputPath,
        sourceEntries: sourceSnapshot.sourceEntries,
        sourceInputPath: sourceSnapshot.sourceInputPath,
        sourceSha256: sourceSnapshot.sourceSha256,
      }
      const render = vi.fn(async (renderRequest) => {
        expect(renderRequest.publicationRoot).not.toBe(fixture.root)
        await expect(readFile(renderRequest.inputPath, 'utf8')).resolves.toBe(
          fixture.trusted.html,
        )
        await expect(
          readFile(
            resolve(renderRequest.publicationRoot, 'styles', 'print.css'),
            'utf8',
          ),
        ).resolves.toBe(fixture.trusted.css)
        await expect(
          readFile(
            resolve(
              renderRequest.publicationRoot,
              'assets',
              'images',
              'fixture.svg',
            ),
            'utf8',
          ),
        ).resolves.toBe(fixture.trusted.image)
        await expect(
          readFile(
            resolve(
              renderRequest.publicationRoot,
              'assets',
              'fonts',
              'fixture.ttf',
            ),
            'utf8',
          ),
        ).resolves.toBe(fixture.trusted.font)
      })

      await executePublicationRenderRequest(request, {
        attestIsolation: async () => ({
          networkNamespace: 'net:[200]',
          mountNamespace: 'mnt:[200]',
          pidNamespace: 'pid:[200]',
          cgroup: request.expectedControlGroup,
        }),
        verifyRuntimeEntries: async () => undefined,
        validateResources: async (snapshotRequest) => {
          const resources = await validatePublicationResources(snapshotRequest)
          await writeFile(
            fixture.files.html,
            fixture.trusted.html.replace('trusted', 'hostile'),
          )
          const replacement = `${fixture.files.css}.replacement`
          await writeFile(
            replacement,
            fixture.trusted.css.replace('Trusted', 'Hostile'),
          )
          await rename(replacement, fixture.files.css)
          await rm(fixture.files.image)
          await symlink(outside, fixture.files.image)
          await writeFile(
            fixture.files.font,
            fixture.trusted.font.replace('trusted', 'hostile'),
          )
          return resources
        },
        verifyRenderer: async () => request.expectedRendererVersion,
        verifyBrowser: async () => request.expectedBrowserVersion,
        renderVivliostyle: render,
        renderPlaywright: render,
      })
      expect(render).toHaveBeenCalledOnce()
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

  it('runs the filesystem isolation diagnostic in a monitored child', async () => {
    const root = await localPublicationFixture()
    const request = requestFor(root)
    request.filesystemDiagnosticPaths = [resolve(root, 'missing-sentinel')]
    const [networkNamespace, mountNamespace, pidNamespace, cgroupText] =
      await Promise.all([
        readlink('/proc/self/ns/net'),
        readlink('/proc/self/ns/mnt'),
        readlink('/proc/self/ns/pid'),
        readFile('/proc/self/cgroup', 'utf8'),
      ])
    const cgroup = cgroupText.trim().slice(3)

    const result = await executePublicationRenderRequest(request, {
      attestIsolation: async () => ({
        networkNamespace,
        mountNamespace,
        pidNamespace,
        cgroup,
      }),
      verifyRuntimeEntries: async () => undefined,
      validateResources: async () => undefined,
      verifyRenderer: async () => request.expectedRendererVersion,
      verifyBrowser: async () => request.expectedBrowserVersion,
      renderPlaywright: async () => undefined,
    })

    expect(result.filesystemDiagnostics).toEqual([
      { path: resolve(root, 'missing-sentinel'), inaccessible: true },
    ])
    expect(result.childNetworkNamespaces).toContain(networkNamespace)
    expect(result.childMountNamespaces).toContain(mountNamespace)
    expect(result.childPidNamespaces).toContain(pidNamespace)
    expect(result.childCgroups).toContain(cgroup)
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
