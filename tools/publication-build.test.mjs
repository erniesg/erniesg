import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
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
import { adaptAstroBlogEntry } from '../src/publication/adapters/astro.ts'
import {
  buildPublicationPlan,
  publicationSourceReceiptForPlan,
  renderPublicationPlan,
} from '../src/publication/publishing-facade.ts'
import { buildStructDocument } from '../src/struct-adapters/index.ts'
import { loadAdapterCase } from '../tests/fixtures/struct-adapter-parity/cases.ts'
import {
  PUBLICATION_PROFILES,
  vivliostyleRenderer,
} from '../src/publication/renderers/vivliostyle.ts'
import {
  parsePublicationBuildArgs,
  bindPublicationSourceReceipt,
  canonicalRouteBodyFingerprint,
  consumeRouteImageIndex,
  createPublicationStagingDirectory,
  publicationBuild,
  publicationReceiptDigest,
  publicationRepositoryForCurrentCheckout,
  publicationRouteHtmlDigest,
  publicationSourceReceipt,
  publishPublicationOutput,
} from './publication-build.mjs'
import * as publicationBuildTools from './publication-build.mjs'

const SENTINEL = 'sentinel-untouched\n'

function macOSTemporaryAliasCases(processTemporaryDirectory) {
  const aliases = [['/tmp', '/private/tmp']]
  if (
    processTemporaryDirectory === '/var' ||
    processTemporaryDirectory.startsWith('/var/')
  )
    aliases.unshift([
      processTemporaryDirectory,
      `/private${processTemporaryDirectory}`,
    ])
  return aliases
}

/**
 * The retirement reason the build CLI reports.
 *
 * The message is the one the tool throws, so the refusal is pinned to the
 * documented reason and not to a paraphrase of it.
 */
const PAYLOAD_RETIREMENT_MESSAGE =
  'The Payload publication adapter was retired: `--adapter payload` is no longer available. Re-adding a Payload publication path requires a Struct-semantics conversion first.'

// The Payload publication path was retired (E-04 P-2). The build CLI selects
// the Astro source only, and the plan it publishes is the pinned Struct
// revision the facade derives from that source.
const ASTRO_ENTRY_ID = 'moving-to-cloudflare-with-astro'

function astroBuildArgs(output) {
  return [
    '--adapter',
    'astro',
    '--entry',
    ASTRO_ENTRY_ID,
    '--output',
    output,
  ]
}

/**
 * The publication plan the builder publishes.
 *
 * The builder takes its publication semantics from the facade, so the tests
 * publish a plan instead of a source result. The plan is the pinned Struct
 * revision, and its provenance is the Struct document's own: the retired
 * Payload source is never faked onto it.
 */
let structPlanFixture
async function structPlan() {
  structPlanFixture ??= await (async () => {
    const structDocument = buildStructDocument(
      await loadAdapterCase('ordinary-pdf'),
    )
    return buildPublicationPlan({
      adapterId: 'struct',
      document: structDocument,
    })
  })()
  return structPlanFixture
}

/** The runtime the builder tests publish their plan with. */
const structBuildRuntime = { buildPlan: () => structPlan() }

/**
 * The rendered bundle of the Astro fixture.
 *
 * The bundle carries the pinned Struct revision the Astro adapter produced,
 * so the renderer sees the same bundle the CLI would publish. The fixture has
 * one local image, so the renderer really resolves asset bytes.
 */
async function astroFixtureBundle() {
  const contentRoot = await mkdtemp(
    resolve(tmpdir(), 'publication-build-astro-fixture-'),
  )
  const entryRoot = resolve(contentRoot, 'payload-equivalent')
  await mkdir(entryRoot, { recursive: true })
  await writeFile(
    resolve(entryRoot, 'index.mdx'),
    await readFile(
      resolve('tests/fixtures/publication/astro/payload-equivalent.mdx'),
      'utf8',
    ),
    { flag: 'wx' },
  )
  await copyFile(
    resolve('public/favicon-16x16.png'),
    resolve(entryRoot, 'fixture-image.png'),
    fsConstants.COPYFILE_EXCL,
  )
  const source = await adaptAstroBlogEntry({
    entryId: 'payload-equivalent',
    contentRoot,
  })
  return {
    contentRoot,
    bundle: {
      graph: source.graph,
      assetBundle: source.assetBundle,
      diagnostics: source.diagnostics,
      provenance: source.provenance,
      structDocument: source.structDocument,
      sourceBinding: source.sourceBinding,
    },
  }
}

/**
 * Publish a rendered plan over an existing output directory.
 *
 * The CLI's Astro path additionally writes the canonical route parity
 * payload, which needs the built Astro route (`dist/blog/<entry>/index.html`).
 * A unit test cannot produce that build, so the publish boundary itself is
 * exercised here, with the same facade plan the CLI would publish.
 */
async function publishStagedPlan(plan, output) {
  const staging = await createPublicationStagingDirectory(output)
  try {
    const stagedOutput = resolve(staging, 'output')
    await renderPublicationPlan(plan, {
      outputDirectory: stagedOutput,
      profiles: PUBLICATION_PROFILES,
      routeParity: 'not-applicable',
    })
    await bindPublicationSourceReceipt(
      stagedOutput,
      publicationSourceReceiptForPlan(plan),
      'not-applicable',
      [staging],
    )
    await publishPublicationOutput(stagedOutput, output)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
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

  it('refuses the retired Payload publication adapter with the documented reason', () => {
    // The Payload publication path was retired (E-04 P-2). Every spelling of
    // the retired adapter is refused with the documented retirement reason,
    // not with a generic "unsupported adapter" error.
    for (const adapter of ['payload', 'payload-lexical']) {
      expect(() =>
        parsePublicationBuildArgs([
          '--adapter',
          adapter,
          '--input',
          'tests/fixtures/payload/publication.json',
          '--mapping',
          'tests/fixtures/payload/mapping.json',
          '--output',
          '.agent/evidence/payload-publication',
        ]),
      ).toThrow(PAYLOAD_RETIREMENT_MESSAGE)
    }
    // The Payload-only options are gone with the path they served. They are
    // not left dangling as silently ignored flags: each one names the option
    // and the retirement reason.
    for (const option of ['--input', '--mapping']) {
      expect(() =>
        parsePublicationBuildArgs([
          '--adapter',
          'astro',
          option,
          'tests/fixtures/payload/publication.json',
          '--output',
          'output',
        ]),
      ).toThrow(
        `Publication:build option ${option} was removed with the retired Payload publication path: ${PAYLOAD_RETIREMENT_MESSAGE}`,
      )
    }
    // The surviving Astro path still requires its entry.
    expect(() =>
      parsePublicationBuildArgs(['--adapter', 'astro', '--output', 'output']),
    ).toThrow(/Astro publication builds require --entry/)
    expect(
      parsePublicationBuildArgs([
        '--adapter',
        'astro',
        '--entry',
        'astro-only',
        '--output',
        'output',
      ]),
    ).toEqual({
      adapter: 'astro',
      entry: 'astro-only',
      output: 'output',
    })
  })

  it(
    'never reads or echoes operator-supplied Payload input when the CLI refuses the retired adapter',
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
        // The refusal is the documented retirement reason, and the retired
        // path never read the operator-supplied export, so nothing of it can
        // cross the CLI boundary.
        expect(stderr).toContain(PAYLOAD_RETIREMENT_MESSAGE)
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
        publicationBuild(astroBuildArgs(output), structBuildRuntime),
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
      const error = await publicationBuild(astroBuildArgs(output), {
        ...structBuildRuntime,
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
    // The retired Payload source is gone, so the CLI resolves an Astro entry
    // now. This entry does not exist: the probe below has to fail before the
    // adapter ever looks at it.
    const missingEntry = 'publication-build-python-preflight-missing-entry'
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
          'astro',
          '--entry',
          missingEntry,
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
      // The python3 probe ran before adapter resolution, so the missing Astro
      // entry was never resolved (that failure would have carried a different
      // message); no staging directory or output parent was ever created.
      expect(error?.message).not.toContain(missingEntry)
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
      const source = publicationSourceReceipt(
        await structPlan(),
        'not-applicable',
      )
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
      // The CLI's Astro path additionally writes the canonical route parity
      // payload, which needs the built Astro route
      // (`dist/blog/<entry>/index.html`); a unit test cannot produce that
      // build, so the publish boundary itself is exercised here, with the
      // same facade plan the CLI would publish.
      await publishStagedPlan(await structPlan(), output)
      await expect(access(staleParity)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(access(strayFile)).rejects.toMatchObject({ code: 'ENOENT' })
      const receipt = JSON.parse(
        await readFile(resolve(output, 'publication-receipt.json'), 'utf8'),
      )
      expect(receipt.source.adapterId).toBe('struct-document')
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
        publicationBuild(astroBuildArgs(repositoryOutput), structBuildRuntime),
      ).rejects.toThrow(/repository-local publication output.*ignored/i)
      await expect(
        publicationBuild(astroBuildArgs(linkedRepositoryOutput), structBuildRuntime),
      ).rejects.toThrow(/repository-local publication output.*ignored/i)
      await expect(
        publicationBuild(astroBuildArgs(repositorySymlinkOutput), structBuildRuntime),
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
        publicationBuild(astroBuildArgs(ignoredOutput), structBuildRuntime),
      ).rejects.toThrow('render-boundary-captured')
      await expect(
        publicationBuild(astroBuildArgs(externalOutput), structBuildRuntime),
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

  it('publishes only the pinned Struct revision, never a retired Payload source', async () => {
    // The retired Payload adapter derived an opaque document identity from an
    // operator-supplied export id. The surviving path identifies its source
    // with the pinned Struct revision the facade published, so a receipt can
    // no longer name a Payload source at all.
    const receipt = publicationSourceReceipt(
      await structPlan(),
      'not-applicable',
    )
    expect(receipt.adapterId).toBe('struct-document')
    expect(receipt.adapterId).not.toBe('payload-lexical')
    expect(receipt.sourceType).not.toBe('payload')
    expect(receipt.sourceRevision).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(receipt)).not.toContain('payload')
  })

  it('records observed dirtiness truthfully in an adapter-conformance receipt', async () => {
    const repositoryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-conformance-repository-'),
    )
    // The rendered output lives outside the repository, so the only thing that
    // can make this checkout dirty is the unrelated file written below.
    const outputRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-conformance-output-'),
    )
    const previousDirectory = process.cwd()
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot })
      execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], {
        cwd: repositoryRoot,
      })
      execFileSync('git', ['config', 'user.name', 'Publication Tests'], {
        cwd: repositoryRoot,
      })
      await writeFile(resolve(repositoryRoot, 'tracked.txt'), 'tracked\n')
      execFileSync('git', ['add', '.'], { cwd: repositoryRoot })
      execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], {
        cwd: repositoryRoot,
      })
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }).trim()
      const source = publicationSourceReceipt(
        await structPlan(),
        'adapter-conformance',
      )
      await writeFile(
        resolve(outputRoot, 'publication-receipt.json'),
        `${JSON.stringify(
          {
            source: {
              graphSha256: source.graphSha256,
              assetBundleSha256: source.assetBundleSha256,
            },
          },
          null,
          2,
        )}\n`,
      )
      await writeFile(
        resolve(repositoryRoot, 'uncommitted-agent-change.txt'),
        'dirty\n',
      )
      process.chdir(repositoryRoot)

      const receipt = await bindPublicationSourceReceipt(
        outputRoot,
        publicationSourceReceiptForPlan(await structPlan()),
        'adapter-conformance',
      )

      expect(receipt.source.routeParity).toBe('adapter-conformance')
      expect(receipt.repository).toEqual({ commit, dirty: true })
      expect(
        JSON.parse(
          await readFile(resolve(outputRoot, 'publication-receipt.json'), 'utf8'),
        ).repository,
      ).toEqual({ commit, dirty: true })
    } finally {
      process.chdir(previousDirectory)
      await rm(repositoryRoot, { recursive: true, force: true })
      await rm(outputRoot, { recursive: true, force: true })
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
      await mkdir(staging, { mode: 0o700 })
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
      expect(macOSTemporaryAliasCases('/private/var/folders/custom')).toEqual([
        ['/tmp', '/private/tmp'],
      ])
      expect(macOSTemporaryAliasCases('/Users/custom/tmp')).toEqual([
        ['/tmp', '/private/tmp'],
      ])
      for (const [aliasRoot, canonicalRoot] of macOSTemporaryAliasCases(
        tmpdir(),
      )) {
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
          await mkdir(staging, { mode: 0o700 })
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
      await mkdir(staging, { mode: 0o700 })
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

  it('treats an owned staging path as a literal Git pathspec', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-cleanliness-literal-pathspec-'),
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
      const staging = resolve(temporaryRoot, '.publication-staging-*')
      await mkdir(staging, { mode: 0o700 })
      await writeFile(resolve(staging, 'candidate.txt'), 'candidate\n')
      await writeFile(
        resolve(temporaryRoot, '.publication-staging-unrelated.txt'),
        'must remain visible\n',
      )
      process.chdir(temporaryRoot)

      expect(publicationRepositoryForCurrentCheckout([staging]).dirty).toBe(
        true,
      )
    } finally {
      process.chdir(previousDirectory)
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('refuses a staging exclusion that is writable by other users', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-cleanliness-shared-exclusion-'),
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
      const staging = resolve(temporaryRoot, '.publication-staging-shared')
      await mkdir(staging, { mode: 0o700 })
      await writeFile(resolve(staging, 'candidate.txt'), 'candidate\n')
      await chmod(staging, 0o777)
      process.chdir(temporaryRoot)

      expect(publicationRepositoryForCurrentCheckout([staging]).dirty).toBe(
        true,
      )
    } finally {
      process.chdir(previousDirectory)
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('marks rejected repository-local ignored exclusions dirty', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-cleanliness-ignored-rejection-'),
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
      await writeFile(resolve(temporaryRoot, '.gitignore'), '.agent/evidence/\n')
      await writeFile(resolve(temporaryRoot, 'tracked.txt'), 'tracked\n')
      execFileSync('git', ['add', '.'], { cwd: temporaryRoot })
      execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], {
        cwd: temporaryRoot,
      })
      const staging = resolve(temporaryRoot, '.agent/evidence')
      await mkdir(staging, { recursive: true, mode: 0o700 })
      await writeFile(resolve(staging, 'candidate.txt'), 'candidate\n')
      process.chdir(temporaryRoot)

      expect(publicationRepositoryForCurrentCheckout([staging]).dirty).toBe(
        false,
      )
      await chmod(staging, 0o777)
      expect(publicationRepositoryForCurrentCheckout([staging]).dirty).toBe(
        true,
      )
    } finally {
      process.chdir(previousDirectory)
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it.runIf(
    typeof process.getuid === 'function' &&
      typeof process.geteuid === 'function',
  )('binds staging ownership to the effective user ID', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-cleanliness-effective-owner-'),
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
      const staging = resolve(temporaryRoot, '.publication-staging-owned')
      await mkdir(staging, { mode: 0o700 })
      await writeFile(resolve(staging, 'candidate.txt'), 'candidate\n')
      const owner = (await stat(staging)).uid
      process.chdir(temporaryRoot)

      const realUid = vi.spyOn(process, 'getuid').mockReturnValue(owner + 1)
      expect(publicationRepositoryForCurrentCheckout([staging]).dirty).toBe(
        false,
      )
      realUid.mockRestore()

      const effectiveUid = vi
        .spyOn(process, 'geteuid')
        .mockReturnValue(owner + 1)
      expect(publicationRepositoryForCurrentCheckout([staging]).dirty).toBe(
        true,
      )
      effectiveUid.mockRestore()
    } finally {
      vi.restoreAllMocks()
      process.chdir(previousDirectory)
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('preserves full-width staging identities across status collection', async () => {
    const originalChildProcess = await import('node:child_process')
    const originalFs = await import('node:fs')
    const repositoryRoot = '/Users/publication-cleanliness-bigint'
    const staging = resolve(repositoryRoot, '.publication-staging-owned')
    const owner = BigInt(process.geteuid?.() ?? process.getuid?.() ?? 0)
    const originalIdentity = {
      dev: 9_007_199_254_740_992n,
      ino: 9_007_199_254_740_992n,
    }
    const replacementIdentity = {
      dev: 9_007_199_254_740_993n,
      ino: 9_007_199_254_740_993n,
    }
    const identityModes = []
    let replaced = false

    const stagingStats = (identity, bigint) => ({
      dev: bigint ? identity.dev : Number(identity.dev),
      ino: bigint ? identity.ino : Number(identity.ino),
      uid: bigint ? owner : Number(owner),
      gid: bigint ? 20n : 20,
      mode: bigint ? 0o40700n : 0o40700,
      isDirectory: () => true,
    })

    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...originalFs,
      lstatSync: (path, options) => {
        expect(resolve(path)).toBe(staging)
        const bigint = options?.bigint === true
        identityModes.push(bigint)
        return stagingStats(
          replaced ? replacementIdentity : originalIdentity,
          bigint,
        )
      },
      realpathSync: (path) => resolve(path),
      statSync: (_path, options) => {
        const bigint = options?.bigint === true
        return {
          dev: bigint
            ? originalIdentity.dev
            : Number(originalIdentity.dev),
        }
      },
    }))
    vi.doMock('node:child_process', () => ({
      ...originalChildProcess,
      execFileSync: (_command, args) => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel')
          return `${repositoryRoot}\n`
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'fixture\n'
        if (args[0] === 'status') {
          replaced = true
          return ''
        }
        throw new Error(`Unexpected Git invocation: ${args.join(' ')}`)
      },
    }))

    try {
      const { publicationRepositoryForCurrentCheckout: repositoryReceipt } =
        await import('./publication-build.mjs')

      expect(repositoryReceipt([staging])).toEqual({
        commit: 'fixture',
        dirty: true,
      })
      expect(identityModes).toEqual([true, true])
    } finally {
      vi.doUnmock('node:child_process')
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('fails closed when an owned staging directory changes during status collection', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-cleanliness-identity-change-'),
    )
    const wrapperRoot = await mkdtemp(
      resolve(tmpdir(), 'publication-cleanliness-git-wrapper-'),
    )
    const previousDirectory = process.cwd()
    const previousPath = process.env.PATH
    try {
      const realGit = execFileSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim()
      execFileSync(realGit, ['init', '--quiet'], { cwd: temporaryRoot })
      execFileSync(realGit, ['config', 'user.email', 'tests@example.invalid'], {
        cwd: temporaryRoot,
      })
      execFileSync(realGit, ['config', 'user.name', 'Publication Tests'], {
        cwd: temporaryRoot,
      })
      await writeFile(resolve(temporaryRoot, 'tracked.txt'), 'tracked\n')
      execFileSync(realGit, ['add', '.'], { cwd: temporaryRoot })
      execFileSync(realGit, ['commit', '--quiet', '-m', 'fixture'], {
        cwd: temporaryRoot,
      })
      const staging = resolve(temporaryRoot, '.publication-staging-owned')
      await mkdir(staging, { mode: 0o700 })
      await writeFile(resolve(staging, 'candidate.txt'), 'candidate\n')
      const wrapper = resolve(wrapperRoot, 'git')
      await writeFile(
        wrapper,
        `#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const staging = process.env.PUBLICATION_TEST_STAGING
const held = process.env.PUBLICATION_TEST_HELD
if (args[0] === 'status' && staging && held) {
  renameSync(staging, held)
  mkdirSync(staging, { mode: 0o700 })
  writeFileSync(resolve(staging, 'replacement.txt'), 'must remain visible\\n')
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`,
      )
      await chmod(wrapper, 0o700)
      process.env.PATH = `${wrapperRoot}:${previousPath}`
      process.env.PUBLICATION_TEST_STAGING = staging
      process.env.PUBLICATION_TEST_HELD = resolve(wrapperRoot, 'held')
      process.chdir(temporaryRoot)

      expect(publicationRepositoryForCurrentCheckout([staging]).dirty).toBe(
        true,
      )
    } finally {
      process.chdir(previousDirectory)
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      delete process.env.PUBLICATION_TEST_STAGING
      delete process.env.PUBLICATION_TEST_HELD
      await rm(temporaryRoot, { recursive: true, force: true })
      await rm(wrapperRoot, { recursive: true, force: true })
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
      const outcome = await publicationBuild(astroBuildArgs(output), structBuildRuntime).then(
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
    const { contentRoot, bundle: fixtureBundle } = await astroFixtureBundle()
    try {
      const sentinel = resolve(temporaryRoot, 'victim.txt')
      await writeFile(sentinel, SENTINEL)
      const renderTarget = resolve(temporaryRoot, 'render-output')
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
      await rm(contentRoot, { recursive: true, force: true })
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
      await publicationBuild(astroBuildArgs(output), structBuildRuntime).catch(() => {})
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
      const buildOutcome = publicationBuild(astroBuildArgs(output), structBuildRuntime).then(
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
