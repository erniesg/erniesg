import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  rename,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { canonicalPublicationSourceResult } from '../src/publication/adapter-conformance.ts'
import { adaptPayloadLexical } from '../src/publication/adapters/payload-lexical.ts'
import {
  PUBLICATION_PROFILES,
  vivliostyleRenderer,
} from '../src/publication/renderers/vivliostyle.ts'
import {
  parsePublicationBuildArgs,
  canonicalRouteBodyFingerprint,
  consumeRouteImageIndex,
  createPublicationStagingDirectory,
  publicationGraphBodyFingerprint,
  publicationBuild,
  publicationReceiptDigest,
  publicationRepositoryForCurrentCheckout,
  publicationRouteHtmlDigest,
  publicationSourceReceipt,
  publishPublicationOutput,
} from './publication-build.mjs'
import * as publicationBuildTools from './publication-build.mjs'

const SENTINEL = 'sentinel-untouched\n'

function payloadBuildArgs(output) {
  return [
    '--adapter',
    'payload',
    '--input',
    'tests/fixtures/payload/equivalent-publication.json',
    '--mapping',
    'tests/fixtures/payload/mapping.json',
    '--output',
    output,
  ]
}

async function payloadFixtureBundle() {
  return canonicalPublicationSourceResult(
    adaptPayloadLexical(
      JSON.parse(
        await readFile(
          resolve('tests/fixtures/payload/equivalent-publication.json'),
          'utf8',
        ),
      ),
      JSON.parse(
        await readFile(resolve('tests/fixtures/payload/mapping.json'), 'utf8'),
      ),
    ),
  )
}

describe('publication:build CLI', () => {
  it('requires an explicit registered adapter, stable entry, and output', () => {
    expect(
      parsePublicationBuildArgs([
        '--adapter',
        'astro',
        '--entry',
        'moving-to-cloudflare-with-astro',
        '--output',
        '.agent/evidence/publication',
      ]),
    ).toEqual({
      adapter: 'astro',
      entry: 'moving-to-cloudflare-with-astro',
      output: '.agent/evidence/publication',
    })
    expect(() => parsePublicationBuildArgs(['--entry', 'post'])).toThrow(
      /Usage/,
    )
    expect(() =>
      parsePublicationBuildArgs(['--theme', 'auto-install']),
    ).toThrow(/Unknown/)
  })

  it('accepts a local Payload export and versioned mapping without an Astro entry', () => {
    expect(
      parsePublicationBuildArgs([
        '--adapter',
        'payload',
        '--input',
        'tests/fixtures/payload/publication.json',
        '--mapping',
        'tests/fixtures/payload/mapping.json',
        '--output',
        '.agent/evidence/payload-publication',
      ]),
    ).toEqual({
      adapter: 'payload-lexical',
      input: 'tests/fixtures/payload/publication.json',
      mapping: 'tests/fixtures/payload/mapping.json',
      output: '.agent/evidence/payload-publication',
    })
    expect(() =>
      parsePublicationBuildArgs([
        '--adapter',
        'payload',
        '--entry',
        'astro-only',
        '--output',
        'output',
      ]),
    ).toThrow(/Payload.*--input/)
    expect(() =>
      parsePublicationBuildArgs([
        '--adapter',
        'astro',
        '--input',
        'payload.json',
        '--output',
        'output',
      ]),
    ).toThrow(/Astro.*--entry/)
  })

  it(
    'never lets an unsafe relationship target cross the CLI stderr boundary',
    { timeout: 120_000 },
    async () => {
      const sentinel = 'unsafe-target?credential=redact-me'
      const temporaryRoot = await mkdtemp(
        resolve(tmpdir(), 'publication-build-redacted-target-'),
      )
      const input = resolve(temporaryRoot, 'unsafe-relationship.json')
      const mappingPath = resolve(temporaryRoot, 'mapping.json')
      const output = resolve(temporaryRoot, 'output')
      try {
        await writeFile(
          input,
          `${JSON.stringify({
            id: 'unsafe-relationship-cli',
            title: 'Unsafe relationship',
            content: {
              root: {
                children: [
                  {
                    type: 'paragraph',
                    children: [
                      { type: 'citation', value: sentinel, label: 'Sentinel' },
                    ],
                  },
                ],
              },
            },
          })}\n`,
        )
        await writeFile(
          mappingPath,
          `${JSON.stringify({
            relationships: { citation: { role: 'citation' } },
          })}\n`,
        )
        const failure = await new Promise((resolveRun) => {
          try {
            execFileSync(
              process.execPath,
              [
                resolve('node_modules/tsx/dist/cli.mjs'),
                resolve('tools/publication-build.mjs'),
                '--adapter',
                'payload',
                '--input',
                input,
                '--mapping',
                mappingPath,
                '--output',
                output,
              ],
              { encoding: 'utf8', stdio: 'pipe' },
            )
            resolveRun(undefined)
          } catch (error) {
            resolveRun(error)
          }
        })
        expect(failure).toBeDefined()
        expect(failure.status).not.toBe(0)
        const stdout = String(failure.stdout ?? '')
        const stderr = String(failure.stderr ?? '')
        expect(stderr).toMatch(
          /Payload relationship target \(sha256:[0-9a-f]{16}\) is not a graph-safe id/,
        )
        for (const stream of [stdout, stderr]) {
          expect(stream).not.toContain(sentinel)
          expect(stream).not.toContain('credential')
          expect(stream).not.toContain('redact-me')
          expect(stream).not.toContain('unsafe-target')
        }
        await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true })
      }
    },
  )

  it('binds route parity to the exact canonical route bytes', () => {
    expect(publicationRouteHtmlDigest('<html>route</html>')).toMatch(
      /^[a-f0-9]{64}$/,
    )
    expect(publicationRouteHtmlDigest('<html>route</html>')).not.toBe(
      publicationRouteHtmlDigest('<html>changed</html>'),
    )
  })

  it('binds route parity to the exact publication receipt bytes', () => {
    expect(publicationReceiptDigest('{"version":"1.0.0"}')).toMatch(
      /^[a-f0-9]{64}$/,
    )
    expect(publicationReceiptDigest('{"version":"1.0.1"}')).not.toBe(
      publicationReceiptDigest('{"version":"1.0.0"}'),
    )
  })

  it('binds canonical route body semantics to the publication graph', () => {
    const graph = {
      nodes: [
        { type: 'heading', level: 1, text: 'Heading' },
        { type: 'paragraph', text: 'Body proof' },
      ],
    }
    const expected = publicationGraphBodyFingerprint(graph)
    expect(canonicalRouteBodyFingerprint('<article><h1>Heading</h1><p>Body proof</p></article>')).toEqual(expected)
    expect(canonicalRouteBodyFingerprint('<article><h1>Heading</h1><p>Changed</p></article>')).not.toEqual(expected)
  })

  it('treats Astro typographic apostrophes as the same authored body text', () => {
    const graph = {
      nodes: [{ type: 'paragraph', text: "Author's proof" }],
    }
    expect(canonicalRouteBodyFingerprint('<article><p>Author’s proof</p></article>')).toEqual(
      publicationGraphBodyFingerprint(graph),
    )
  })

  it('normalizes Markdown image titles to graph caption semantics', () => {
    const graph = {
      nodes: [
        {
          type: 'figure',
          title: 'Alt text',
          assetIds: ['asset'],
          captionId: 'caption',
        },
        { id: 'caption', type: 'caption', text: 'Authored image title' },
      ],
    }
    const html =
      '<article><p><img src="/assets/figure.png" alt="Alt text" title="Authored image title"></p></article>'
    expect(canonicalRouteBodyFingerprint(html)).toEqual(
      publicationGraphBodyFingerprint(graph),
    )
  })

  it('consumes duplicate canonical-route image matches one-to-one', () => {
    const images = [
      { src: '/assets/figure-a.png', alt: 'Repeated image' },
      { src: '/assets/figure-a-copy.png', alt: 'Repeated image' },
    ]
    const usedIndexes = new Set()
    expect(
      consumeRouteImageIndex(images, usedIndexes, 'Repeated image', 'figurea'),
    ).toBe(0)
    expect(
      consumeRouteImageIndex(images, usedIndexes, 'Repeated image', 'figurea'),
    ).toBe(1)
    expect(
      consumeRouteImageIndex(images, usedIndexes, 'Repeated image', 'figurea'),
    ).toBe(-1)
  })

  it('leaves a reused output directory fully untouched when the build fails', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-build-failed-reuse-'),
    )
    const output = resolve(temporaryRoot, 'output')
    const staleParity = resolve(output, 'astro-route-parity.json')
    const strayFile = resolve(output, 'stray-before-build.txt')
    const originalRender = vivliostyleRenderer.render
    vivliostyleRenderer.render = async () => {
      throw new Error('render-boundary-captured')
    }
    try {
      await mkdir(output)
      await writeFile(staleParity, '{"stale":true}\n')
      await writeFile(strayFile, 'kept-on-failure\n')
      await expect(
        publicationBuild(payloadBuildArgs(output)),
      ).rejects.toThrow('render-boundary-captured')
      expect(await readFile(staleParity, 'utf8')).toBe('{"stale":true}\n')
      expect(await readFile(strayFile, 'utf8')).toBe('kept-on-failure\n')
      expect((await readdir(temporaryRoot)).sort()).toEqual(['output'])
    } finally {
      vivliostyleRenderer.render = originalRender
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('rejects unsupported win32 before rendering, staging, or output mutation', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-build-win32-preflight-'),
    )
    const outputParent = resolve(temporaryRoot, 'must-not-be-created')
    const output = resolve(outputParent, 'private-output-marker')
    const originalRender = vivliostyleRenderer.render
    let renderCalls = 0
    vivliostyleRenderer.render = async () => {
      renderCalls += 1
      throw new Error('renderer must not run on an unsupported platform')
    }
    try {
      const error = await publicationBuild(payloadBuildArgs(output), {
        platform: 'win32',
      }).then(
        () => undefined,
        (failure) => failure,
      )
      expect(error).toMatchObject({ code: 'ENOTSUP' })
      expect(error?.message).toBe(
        'Atomic directory publication is unsupported on this platform',
      )
      expect(error?.message).not.toContain('win32')
      expect(error?.message).not.toContain(output)
      expect(renderCalls).toBe(0)
      await expect(access(outputParent)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(await readdir(temporaryRoot)).toEqual([])
    } finally {
      vivliostyleRenderer.render = originalRender
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('verifies the python3 atomic-rename runtime before adapter, staging, or renderer work', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-build-python-preflight-'),
    )
    const outputParent = resolve(temporaryRoot, 'must-not-be-created')
    const output = resolve(outputParent, 'output')
    const neverReadInput = resolve(temporaryRoot, 'never-read.json')
    const originalRender = vivliostyleRenderer.render
    let renderCalls = 0
    vivliostyleRenderer.render = async () => {
      renderCalls += 1
      throw new Error('renderer must not run without the python3 runtime')
    }
    const originalPath = process.env.PATH
    try {
      process.env.PATH = resolve(temporaryRoot, 'empty-path-entry')
      const error = await publicationBuild(
        [
          '--adapter',
          'payload',
          '--input',
          neverReadInput,
          '--output',
          output,
        ],
        { platform: process.platform },
      ).then(
        () => undefined,
        (failure) => failure,
      )
      process.env.PATH = originalPath
      expect(error).toMatchObject({ code: 'ENOENT' })
      expect(error?.message).toBe(
        'Atomic directory publication requires a python3 runtime on PATH; install python3 before running publication builds',
      )
      expect(error?.message).not.toContain(output)
      expect(renderCalls).toBe(0)
      // The missing input file was never read, so adapter resolution did not
      // start; no staging directory or output parent was ever created.
      await expect(access(neverReadInput)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(access(outputParent)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(await readdir(temporaryRoot)).toEqual([])
    } finally {
      process.env.PATH = originalPath
      vivliostyleRenderer.render = originalRender
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('replaces a reused output directory wholesale instead of merging into it', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-build-replaced-reuse-'),
    )
    const output = resolve(temporaryRoot, 'output')
    const staleParity = resolve(output, 'astro-route-parity.json')
    const strayFile = resolve(output, 'stray-before-build.txt')
    const originalRender = vivliostyleRenderer.render
    vivliostyleRenderer.render = async (bundle, request) => {
      const target = resolve(request.outputDirectory)
      await mkdir(target, { recursive: true })
      const source = publicationSourceReceipt(bundle, 'not-applicable')
      await writeFile(
        resolve(target, 'publication-graph.json'),
        'staged-graph\n',
      )
      await writeFile(
        resolve(target, 'publication-receipt.json'),
        `${JSON.stringify(
          {
            version: '1.0.0',
            source: {
              graphSha256: source.graphSha256,
              assetBundleSha256: source.assetBundleSha256,
            },
            artifacts: [],
          },
          null,
          2,
        )}\n`,
      )
      return { artifacts: [] }
    }
    try {
      await mkdir(output)
      await writeFile(staleParity, '{"stale":true}\n')
      await writeFile(strayFile, 'merged-into?\n')
      await publicationBuild(payloadBuildArgs(output))
      await expect(access(staleParity)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(access(strayFile)).rejects.toMatchObject({ code: 'ENOENT' })
      const receipt = JSON.parse(
        await readFile(resolve(output, 'publication-receipt.json'), 'utf8'),
      )
      expect(receipt.source.adapterId).toBe('payload-lexical')
      expect((await readdir(temporaryRoot)).sort()).toEqual(['output'])
    } finally {
      vivliostyleRenderer.render = originalRender
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('rejects unignored repository outputs before staging but allows ignored and external outputs', async () => {
    // Unique test-owned names: nothing pre-existing can live at these paths,
    // so the test only ever removes what it created itself.
    const unique = randomBytes(6).toString('hex')
    const repositoryOutput = resolve(
      `.publication-build-unignored-output-${unique}`,
    )
    const ignoredOutput = resolve(
      `.agent/evidence/publication-build-output-policy-${unique}`,
    )
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-build-output-policy-'),
    )
    const externalOutput = resolve(temporaryRoot, 'output')
    const repositoryLink = resolve(temporaryRoot, 'repository-link')
    const linkedRepositoryOutput = resolve(
      repositoryLink,
      `.publication-build-linked-output-${unique}`,
    )
    const linkedRepositoryTarget = resolve(
      `.publication-build-linked-output-${unique}`,
    )
    const repositorySymlinkOutput = resolve(
      `.agent/evidence/publication-build-symlink-output-${unique}`,
    )
    const externalSymlinkTarget = resolve(temporaryRoot, 'external-target')
    const staleRepositoryParity = resolve(
      repositoryOutput,
      'astro-route-parity.json',
    )
    const originalRender = vivliostyleRenderer.render
    const renderedOutputs = []
    vivliostyleRenderer.render = async (_bundle, request) => {
      renderedOutputs.push(resolve(request.outputDirectory))
      throw new Error('render-boundary-captured')
    }
    try {
      await mkdir(repositoryOutput)
      await writeFile(staleRepositoryParity, '{"sentinel":true}\n')
      await symlink(resolve('.'), repositoryLink, 'dir')
      await mkdir(externalSymlinkTarget)
      await writeFile(resolve(externalSymlinkTarget, 'sentinel.txt'), 'kept\n')
      await symlink(externalSymlinkTarget, repositorySymlinkOutput, 'dir')
      await expect(
        publicationBuild(payloadBuildArgs(repositoryOutput)),
      ).rejects.toThrow(/repository-local publication output.*ignored/i)
      await expect(
        publicationBuild(payloadBuildArgs(linkedRepositoryOutput)),
      ).rejects.toThrow(/repository-local publication output.*ignored/i)
      await expect(
        publicationBuild(payloadBuildArgs(repositorySymlinkOutput)),
      ).rejects.toThrow(/publication output path.*symbolic link/i)
      expect(renderedOutputs).toEqual([])
      await expect(readFile(staleRepositoryParity, 'utf8')).resolves.toBe(
        '{"sentinel":true}\n',
      )
      await expect(access(linkedRepositoryTarget)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect((await lstat(repositorySymlinkOutput)).isSymbolicLink()).toBe(true)
      await expect(
        readFile(resolve(externalSymlinkTarget, 'sentinel.txt'), 'utf8'),
      ).resolves.toBe('kept\n')

      await expect(
        publicationBuild(payloadBuildArgs(ignoredOutput)),
      ).rejects.toThrow('render-boundary-captured')
      await expect(
        publicationBuild(payloadBuildArgs(externalOutput)),
      ).rejects.toThrow('render-boundary-captured')
      expect(renderedOutputs).toHaveLength(2)
      // Renders target invocation-owned staging directories next to the
      // authorized output, never the output path itself.
      for (const [rendered, finalOutput] of [
        [renderedOutputs[0], ignoredOutput],
        [renderedOutputs[1], externalOutput],
      ]) {
        expect(rendered).not.toBe(finalOutput)
        const stagingRoot = dirname(rendered)
        expect(basename(stagingRoot)).toMatch(/^\.publication-staging-/)
        expect(dirname(stagingRoot)).toBe(dirname(finalOutput))
        // All-or-nothing: the failed builds published nothing and cleaned
        // their staging directories.
        await expect(access(stagingRoot)).rejects.toMatchObject({
          code: 'ENOENT',
        })
        await expect(access(finalOutput)).rejects.toMatchObject({
          code: 'ENOENT',
        })
      }
    } finally {
      vivliostyleRenderer.render = originalRender
      await rm(repositoryOutput, { recursive: true, force: true })
      await rm(ignoredOutput, { recursive: true, force: true })
      await rm(linkedRepositoryTarget, { recursive: true, force: true })
      await rm(repositorySymlinkOutput, { force: true })
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('keeps opaque Payload document identities in source receipts', () => {
    const rawId = ['github', '_pat_', 'R'.repeat(24)].join('')
    const bundle = canonicalPublicationSourceResult(
      adaptPayloadLexical({
        id: rawId,
        title: 'Opaque receipt identity',
        locale: 'en',
        content: {
          root: {
            type: 'root',
            children: [
              {
                type: 'paragraph',
                children: [{ type: 'text', text: 'Body' }],
              },
            ],
          },
        },
      }),
    )

    const receipt = publicationSourceReceipt(bundle, 'not-applicable')
    expect(JSON.stringify(receipt)).not.toContain(rawId)
    expect(receipt.sourceId).toMatch(
      /^payload:document-[a-f0-9]{64}:en$/,
    )
  })
})

describe('publication staging and publish helpers', () => {
  it('creates a private unpredictable staging directory next to the output', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-staging-helper-'),
    )
    try {
      const finalOutput = resolve(temporaryRoot, 'nested', 'output')
      const staging = await createPublicationStagingDirectory(finalOutput)
      expect(dirname(staging)).toBe(resolve(temporaryRoot, 'nested'))
      expect(basename(staging)).toMatch(/^\.publication-staging-/)
      expect((await stat(staging)).mode & 0o777).toBe(0o700)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked publish target without following or replacing it', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-publish-helper-'),
    )
    try {
      const elsewhere = resolve(temporaryRoot, 'elsewhere')
      await mkdir(elsewhere)
      await writeFile(resolve(elsewhere, 'keep.txt'), 'kept\n')
      const finalOutput = resolve(temporaryRoot, 'final')
      await symlink(elsewhere, finalOutput)
      const staged = resolve(temporaryRoot, 'staged')
      await mkdir(staged)
      await writeFile(resolve(staged, 'artifact.txt'), 'published\n')
      await expect(
        publishPublicationOutput(staged, finalOutput),
      ).rejects.toThrow(/publication output path.*symbolic link/i)
      expect((await lstat(finalOutput)).isSymbolicLink()).toBe(true)
      expect(await readFile(resolve(staged, 'artifact.txt'), 'utf8')).toBe(
        'published\n',
      )
      expect(await readFile(resolve(elsewhere, 'keep.txt'), 'utf8')).toBe(
        'kept\n',
      )
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('does not replace a symlink raced into an initially absent target', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-publish-absent-race-'),
    )
    try {
      const elsewhere = resolve(temporaryRoot, 'elsewhere')
      await mkdir(elsewhere)
      await writeFile(resolve(elsewhere, 'keep.txt'), 'kept\n')
      const finalOutput = resolve(temporaryRoot, 'final')
      const staged = resolve(temporaryRoot, 'staged')
      await mkdir(staged)
      await writeFile(resolve(staged, 'artifact.txt'), 'candidate\n')
      let publishCalls = 0

      await expect(
        publishPublicationOutput(staged, finalOutput, {
          atomicPublishNew: async (candidate, live) => {
            publishCalls += 1
            await symlink(elsewhere, live)
            expect(
              publicationBuildTools.atomicPublishNewPublicationPath,
            ).toBeTypeOf('function')
            await publicationBuildTools.atomicPublishNewPublicationPath(
              candidate,
              live,
            )
          },
        }),
      ).rejects.toThrow(/atomic publication no-replace failed/i)

      expect(publishCalls).toBe(1)
      expect((await lstat(finalOutput)).isSymbolicLink()).toBe(true)
      await expect(
        readFile(resolve(elsewhere, 'keep.txt'), 'utf8'),
      ).resolves.toBe('kept\n')
      await expect(
        readFile(resolve(staged, 'artifact.txt'), 'utf8'),
      ).resolves.toBe('candidate\n')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('atomically restores a symlink substituted during existing-target exchange', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-publish-existing-race-'),
    )
    try {
      const finalOutput = resolve(temporaryRoot, 'final')
      const staged = resolve(temporaryRoot, 'staged')
      const previous = resolve(temporaryRoot, 'previous')
      const elsewhere = resolve(temporaryRoot, 'elsewhere')
      await mkdir(finalOutput)
      await mkdir(staged)
      await mkdir(elsewhere)
      await writeFile(resolve(finalOutput, 'artifact.txt'), 'previous\n')
      await writeFile(resolve(staged, 'artifact.txt'), 'candidate\n')
      await writeFile(resolve(elsewhere, 'keep.txt'), 'kept\n')
      let exchangeCalls = 0

      await expect(
        publishPublicationOutput(staged, finalOutput, {
          atomicExchange: async (candidate, live) => {
            exchangeCalls += 1
            if (exchangeCalls === 1) {
              await rename(live, previous)
              await symlink(elsewhere, live)
            }
            await publicationBuildTools.atomicExchangePublicationPaths(
              candidate,
              live,
            )
          },
        }),
      ).rejects.toThrow(/publication output identity changed/i)

      expect(exchangeCalls).toBe(2)
      expect((await lstat(finalOutput)).isSymbolicLink()).toBe(true)
      await expect(
        readFile(resolve(elsewhere, 'keep.txt'), 'utf8'),
      ).resolves.toBe('kept\n')
      await expect(
        readFile(resolve(staged, 'artifact.txt'), 'utf8'),
      ).resolves.toBe('candidate\n')
      await expect(
        readFile(resolve(previous, 'artifact.txt'), 'utf8'),
      ).resolves.toBe('previous\n')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('rejects adjacent unsafe-range same-type identities that collide as Numbers', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-publish-unsafe-identity-'),
    )
    const finalOutput = resolve(temporaryRoot, 'final')
    const staged = resolve(temporaryRoot, 'staged')
    const originalFsPromises = await import('node:fs/promises')
    const identityModes = []
    let exchangeCalls = 0
    const previousIdentity = {
      dev: 9_007_199_254_740_992n,
      ino: 9_007_199_254_740_992n,
    }
    const substitutedIdentity = {
      dev: 9_007_199_254_740_993n,
      ino: 9_007_199_254_740_993n,
    }
    const candidateIdentity = {
      dev: 9_007_199_254_740_996n,
      ino: 9_007_199_254_740_996n,
    }
    const withIdentity = (stats, identity, bigint) => {
      const result = Object.assign(
        Object.create(Object.getPrototypeOf(stats)),
        stats,
      )
      result.dev = bigint ? identity.dev : Number(identity.dev)
      result.ino = bigint ? identity.ino : Number(identity.ino)
      return result
    }

    vi.resetModules()
    vi.doMock('node:fs/promises', () => ({
      ...originalFsPromises,
      lstat: async (path, options) => {
        const stats = await originalFsPromises.lstat(path, options)
        const resolvedPath = resolve(path)
        if (resolvedPath !== finalOutput && resolvedPath !== staged)
          return stats
        const bigint = options?.bigint === true
        identityModes.push(bigint)
        const identity =
          exchangeCalls === 0
            ? resolvedPath === staged
              ? candidateIdentity
              : previousIdentity
            : exchangeCalls === 1
              ? resolvedPath === finalOutput
                ? candidateIdentity
                : substitutedIdentity
              : resolvedPath === finalOutput
                ? substitutedIdentity
                : candidateIdentity
        return withIdentity(stats, identity, bigint)
      },
    }))

    try {
      await mkdir(finalOutput)
      await mkdir(staged)
      await writeFile(resolve(finalOutput, 'artifact.txt'), 'previous\n')
      await writeFile(resolve(staged, 'artifact.txt'), 'candidate\n')
      const { publishPublicationOutput: publishWithMockedIdentity } =
        await import('./publication-build.mjs')

      await expect(
        publishWithMockedIdentity(staged, finalOutput, {
          atomicExchange: async () => {
            exchangeCalls += 1
          },
        }),
      ).rejects.toThrow(/publication output identity changed/i)

      expect(exchangeCalls).toBe(2)
      expect(identityModes).toEqual([true, true, true, true, true, true])
      await expect(
        readFile(resolve(staged, 'artifact.txt'), 'utf8'),
      ).resolves.toBe('candidate\n')
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('sanitizes and preserves identity-mismatch and restoration failures', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-publish-mismatch-recovery-'),
    )
    try {
      const finalOutput = resolve(temporaryRoot, 'final')
      const staged = resolve(temporaryRoot, 'staged')
      const previous = resolve(temporaryRoot, 'previous')
      const elsewhere = resolve(temporaryRoot, 'elsewhere')
      const rawMarker = ['github', '_pat_', 'S'.repeat(24)].join('')
      await mkdir(finalOutput)
      await mkdir(staged)
      await mkdir(elsewhere)
      await writeFile(resolve(finalOutput, 'artifact.txt'), 'previous\n')
      await writeFile(resolve(staged, 'artifact.txt'), 'candidate\n')
      let exchangeCalls = 0

      const error = await publishPublicationOutput(staged, finalOutput, {
        atomicExchange: async (candidate, live) => {
          exchangeCalls += 1
          if (exchangeCalls === 1) {
            await rename(live, previous)
            await symlink(elsewhere, live)
            await publicationBuildTools.atomicExchangePublicationPaths(
              candidate,
              live,
            )
            return
          }
          throw new Error(
            `restore failed for ${rawMarker} at ${temporaryRoot}`,
            { cause: { rawMarker, temporaryRoot } },
          )
        },
      }).then(
        () => undefined,
        (value) => value,
      )

      expect(error).toBeInstanceOf(AggregateError)
      expect(error.message).toBe(
        'Atomic publication replacement failed and restoration also failed',
      )
      expect(error.errors.map((value) => value.message)).toEqual([
        'Publication output identity changed during atomic replacement',
        'Atomic publication restoration failed',
      ])
      expect(error.cause).toBeUndefined()
      expect(error.errors.every((value) => value.cause === undefined)).toBe(
        true,
      )
      expect(
        JSON.stringify({
          message: error.message,
          cause: error.cause,
          errors: error.errors.map((value) => ({
            message: value.message,
            cause: value.cause,
            code: value.code,
          })),
        }),
      ).not.toMatch(new RegExp(`${rawMarker}|${temporaryRoot}`, 'u'))
      expect(exchangeCalls).toBe(2)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('keeps the previous output addressable and unchanged when an atomic exchange fails', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-publish-exchange-failure-'),
    )
    try {
      const finalOutput = resolve(temporaryRoot, 'final')
      const staged = resolve(temporaryRoot, 'staged')
      await mkdir(finalOutput)
      await mkdir(staged)
      await writeFile(resolve(finalOutput, 'artifact.txt'), 'previous\n')
      await writeFile(resolve(staged, 'artifact.txt'), 'candidate\n')
      let exchangeCalls = 0

      await expect(
        publishPublicationOutput(staged, finalOutput, {
          atomicExchange: async () => {
            exchangeCalls += 1
            await expect(
              readFile(resolve(finalOutput, 'artifact.txt'), 'utf8'),
            ).resolves.toBe('previous\n')
            throw new Error('injected atomic exchange failure')
          },
        }),
      ).rejects.toThrow(/injected atomic exchange failure/)
      expect(exchangeCalls).toBe(1)
      await expect(
        readFile(resolve(finalOutput, 'artifact.txt'), 'utf8'),
      ).resolves.toBe('previous\n')
      await expect(
        readFile(resolve(staged, 'artifact.txt'), 'utf8'),
      ).resolves.toBe('candidate\n')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('preserves both the exchange and restoration errors when recovery also fails', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-publish-restoration-failure-'),
    )
    try {
      const finalOutput = resolve(temporaryRoot, 'final')
      const staged = resolve(temporaryRoot, 'staged')
      await mkdir(finalOutput)
      await mkdir(staged)
      await writeFile(resolve(finalOutput, 'artifact.txt'), 'previous\n')
      await writeFile(resolve(staged, 'artifact.txt'), 'candidate\n')
      let exchangeCalls = 0

      const error = await publishPublicationOutput(staged, finalOutput, {
        atomicExchange: async (candidate, live) => {
          exchangeCalls += 1
          if (exchangeCalls === 1) {
            const held = resolve(temporaryRoot, 'held')
            await rename(candidate, held)
            await rename(live, candidate)
            await rename(held, live)
            throw new Error('injected exchange completion error')
          }
          throw new Error('injected restoration failure')
        },
      }).then(
        () => undefined,
        (value) => value,
      )

      expect(error).toBeInstanceOf(AggregateError)
      expect(error.message).toBe(
        'Atomic publication replacement failed and restoration also failed',
      )
      expect(error.errors.map((value) => value.message)).toEqual([
        'Atomic publication exchange reported failure after completion',
        'Atomic publication restoration failed',
      ])
      expect(error.cause).toBeUndefined()
      expect(error.errors.every((value) => value.cause === undefined)).toBe(
        true,
      )
      expect(exchangeCalls).toBe(2)
      await expect(
        readFile(resolve(finalOutput, 'artifact.txt'), 'utf8'),
      ).resolves.toBe('candidate\n')
      await expect(
        readFile(resolve(staged, 'artifact.txt'), 'utf8'),
      ).resolves.toBe('previous\n')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('excludes invocation-owned staging roots from repository cleanliness evidence', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-cleanliness-exclusion-'),
    )
    const previousDirectory = process.cwd()
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: temporaryRoot })
      execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], {
        cwd: temporaryRoot,
      })
      execFileSync('git', ['config', 'user.name', 'Publication Tests'], {
        cwd: temporaryRoot,
      })
      await writeFile(resolve(temporaryRoot, '.gitignore'), 'output/\n')
      await writeFile(resolve(temporaryRoot, 'tracked.txt'), 'tracked\n')
      const nestedDirectory = resolve(temporaryRoot, 'nested')
      await mkdir(nestedDirectory)
      await writeFile(resolve(nestedDirectory, '.gitkeep'), '')
      execFileSync('git', ['add', '.'], { cwd: temporaryRoot })
      execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], {
        cwd: temporaryRoot,
      })
      const staging = resolve(temporaryRoot, '.publication-staging-owned')
      await mkdir(staging)
      await writeFile(resolve(staging, 'candidate.txt'), 'candidate\n')
      process.chdir(nestedDirectory)

      expect(publicationRepositoryForCurrentCheckout([staging])).toEqual({
        commit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: temporaryRoot,
          encoding: 'utf8',
        }).trim(),
        dirty: false,
      })
      await writeFile(resolve(temporaryRoot, 'tracked.txt'), 'changed\n')
      expect(publicationRepositoryForCurrentCheckout([staging]).dirty).toBe(
        true,
      )
      await writeFile(resolve(temporaryRoot, 'tracked.txt'), 'tracked\n')
      await writeFile(resolve(temporaryRoot, 'unrelated-output.txt'), 'dirty\n')
      expect(publicationRepositoryForCurrentCheckout([staging]).dirty).toBe(
        true,
      )
    } finally {
      process.chdir(previousDirectory)
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'darwin')(
    'canonicalizes root-owned /var and /tmp aliases for the repository and staging root',
    async () => {
      const previousDirectory = process.cwd()
      for (const [aliasRoot, canonicalRoot] of [
        [tmpdir(), `/private${tmpdir()}`],
        ['/tmp', '/private/tmp'],
      ]) {
        const temporaryRoot = await mkdtemp(
          resolve(aliasRoot, 'publication-cleanliness-macos-alias-'),
        )
        try {
          expect(temporaryRoot.startsWith(`${aliasRoot}/`)).toBe(true)
          expect(
            execFileSync('python3', [
              '-c',
              'import os,sys; print(os.path.realpath(sys.argv[1]))',
              temporaryRoot,
            ], { encoding: 'utf8' }).trim().startsWith(`${canonicalRoot}/`),
          ).toBe(true)
          execFileSync('git', ['init', '--quiet'], { cwd: temporaryRoot })
          execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], {
            cwd: temporaryRoot,
          })
          execFileSync('git', ['config', 'user.name', 'Publication Tests'], {
            cwd: temporaryRoot,
          })
          await writeFile(resolve(temporaryRoot, 'tracked.txt'), 'tracked\n')
          execFileSync('git', ['add', '.'], { cwd: temporaryRoot })
          execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], {
            cwd: temporaryRoot,
          })
          const staging = resolve(temporaryRoot, '.publication-staging-owned')
          await mkdir(staging)
          await writeFile(resolve(staging, 'candidate.txt'), 'candidate\n')
          process.chdir(temporaryRoot)

          expect(publicationRepositoryForCurrentCheckout([staging]).dirty).toBe(
            false,
          )
        } finally {
          process.chdir(previousDirectory)
          await rm(temporaryRoot, { recursive: true, force: true })
        }
      }
    },
  )

  it('does not let a repository symlink masquerade as an owned staging root', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-cleanliness-symlink-exclusion-'),
    )
    const externalRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-cleanliness-external-'),
    )
    const previousDirectory = process.cwd()
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: temporaryRoot })
      execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], {
        cwd: temporaryRoot,
      })
      execFileSync('git', ['config', 'user.name', 'Publication Tests'], {
        cwd: temporaryRoot,
      })
      await writeFile(resolve(temporaryRoot, 'tracked.txt'), 'tracked\n')
      execFileSync('git', ['add', '.'], { cwd: temporaryRoot })
      execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], {
        cwd: temporaryRoot,
      })
      const stagingLink = resolve(
        temporaryRoot,
        '.publication-staging-attacker-link',
      )
      await symlink(externalRoot, stagingLink, 'dir')
      process.chdir(temporaryRoot)

      expect(
        publicationRepositoryForCurrentCheckout([stagingLink]).dirty,
      ).toBe(true)
    } finally {
      process.chdir(previousDirectory)
      await rm(temporaryRoot, { recursive: true, force: true })
      await rm(externalRoot, { recursive: true, force: true })
    }
  })

  it('does not normalize traversal into an owned staging exclusion', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-cleanliness-traversal-exclusion-'),
    )
    const previousDirectory = process.cwd()
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: temporaryRoot })
      execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], {
        cwd: temporaryRoot,
      })
      execFileSync('git', ['config', 'user.name', 'Publication Tests'], {
        cwd: temporaryRoot,
      })
      await writeFile(resolve(temporaryRoot, 'tracked.txt'), 'tracked\n')
      const nestedDirectory = resolve(temporaryRoot, 'nested')
      await mkdir(nestedDirectory)
      execFileSync('git', ['add', '.'], { cwd: temporaryRoot })
      execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], {
        cwd: temporaryRoot,
      })
      const staging = resolve(temporaryRoot, '.publication-staging-owned')
      await mkdir(staging)
      await writeFile(resolve(staging, 'candidate.txt'), 'candidate\n')
      process.chdir(temporaryRoot)

      expect(
        publicationRepositoryForCurrentCheckout([
          `${nestedDirectory}/../.publication-staging-owned`,
        ]).dirty,
      ).toBe(true)
    } finally {
      process.chdir(previousDirectory)
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})

describe('publication output safety', () => {
  it('never follows a pre-existing symlinked publication-graph.json out of the output root', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-output-safety-symlink-'),
    )
    try {
      const sentinel = resolve(temporaryRoot, 'victim.txt')
      await writeFile(sentinel, SENTINEL)
      const output = resolve(temporaryRoot, 'output')
      await mkdir(output)
      await symlink(sentinel, resolve(output, 'publication-graph.json'))
      const outcome = await publicationBuild(payloadBuildArgs(output)).then(
        () => 'published',
        () => 'failed',
      )
      expect(await readFile(sentinel, 'utf8')).toBe(SENTINEL)
      const entry = await lstat(resolve(output, 'publication-graph.json'))
      if (outcome === 'published') expect(entry.isSymbolicLink()).toBe(false)
      else expect(entry.isSymbolicLink()).toBe(true)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 120_000)

  it('fails closed when a symlink is inserted into the render target after the build starts', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-output-safety-toctou-'),
    )
    try {
      const sentinel = resolve(temporaryRoot, 'victim.txt')
      await writeFile(sentinel, SENTINEL)
      const renderTarget = resolve(temporaryRoot, 'render-output')
      const fixtureBundle = await payloadFixtureBundle()
      let planted = false
      const bundle = {
        ...fixtureBundle,
        assetBundle: {
          ...fixtureBundle.assetBundle,
          resolveBytes: async (descriptor) => {
            if (!planted) {
              planted = true
              await symlink(sentinel, resolve(renderTarget, 'eink.epub'))
            }
            return fixtureBundle.assetBundle.resolveBytes(descriptor)
          },
        },
      }
      await expect(
        vivliostyleRenderer.render(bundle, {
          outputDirectory: renderTarget,
          profiles: [...PUBLICATION_PROFILES],
        }),
      ).rejects.toThrow()
      expect(planted).toBe(true)
      expect(await readFile(sentinel, 'utf8')).toBe(SENTINEL)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 120_000)

  it('never writes through a hard-linked publication output entry', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-output-safety-hardlink-'),
    )
    try {
      const sentinel = resolve(temporaryRoot, 'victim.txt')
      await writeFile(sentinel, SENTINEL)
      const output = resolve(temporaryRoot, 'output')
      await mkdir(output)
      await link(sentinel, resolve(output, 'publication-graph.json'))
      await publicationBuild(payloadBuildArgs(output)).catch(() => {})
      expect(await readFile(sentinel, 'utf8')).toBe(SENTINEL)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 120_000)

  it('is neither stalled nor redirected by a FIFO publication output entry', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-output-safety-fifo-'),
    )
    try {
      const output = resolve(temporaryRoot, 'output')
      await mkdir(output)
      const fifo = resolve(output, 'publication-graph.json')
      execFileSync('mkfifo', [fifo])
      const buildOutcome = publicationBuild(payloadBuildArgs(output)).then(
        () => 'completed',
        () => 'completed',
      )
      const outcome = await Promise.race([
        buildOutcome,
        new Promise((accept) => setTimeout(accept, 20_000, 'stalled')),
      ])
      if (outcome === 'stalled') {
        // Unblock the FIFO writer so the stalled build can settle and the
        // suite can exit; the assertion below still fails the test.
        const reader = await open(
          fifo,
          fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
        ).catch(() => undefined)
        if (reader) {
          const buffer = Buffer.alloc(65536)
          let settled = false
          const settle = buildOutcome.then(() => {
            settled = true
          })
          while (!settled) {
            await reader
              .read(buffer, 0, buffer.length, null)
              .catch(() => {})
            await new Promise((accept) => setTimeout(accept, 50))
          }
          await settle
          await reader.close()
        }
      }
      expect(outcome).toBe('completed')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
