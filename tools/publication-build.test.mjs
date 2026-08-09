import { execFileSync } from 'node:child_process'
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
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  publicationRouteHtmlDigest,
  publicationSourceReceipt,
  publishPublicationOutput,
} from './publication-build.mjs'

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

  it('retires a symlinked publish target instead of following it', async () => {
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
      await publishPublicationOutput(staged, finalOutput)
      const published = await lstat(finalOutput)
      expect(published.isSymbolicLink()).toBe(false)
      expect(published.isDirectory()).toBe(true)
      expect(await readFile(resolve(finalOutput, 'artifact.txt'), 'utf8')).toBe(
        'published\n',
      )
      expect(await readFile(resolve(elsewhere, 'keep.txt'), 'utf8')).toBe(
        'kept\n',
      )
    } finally {
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
