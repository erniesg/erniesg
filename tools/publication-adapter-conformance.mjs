import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  canonicalPublicationSourceResult,
  comparePublicationOutputReceipts,
  comparePublicationSemanticSubset,
} from '../src/publication/adapter-conformance.ts'
import { adaptAstroBlogEntry } from '../src/publication/adapters/astro.ts'
import { adaptPayloadLexical } from '../src/publication/adapters/payload-lexical.ts'
import {
  PUBLICATION_PROFILES,
  vivliostyleRenderer,
} from '../src/publication/renderers/vivliostyle.ts'
import {
  assertPublicationOutputDirectory,
  bindPublicationSourceReceipt,
  createPublicationStagingDirectory,
  publishPublicationOutput,
} from './publication-build.mjs'
import { publicationCheck } from './publication-check.mjs'

export function parsePublicationAdapterConformanceArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--output' || !argv[1] || argv[1].startsWith('--'))
    throw new Error('Usage: publication-adapter-conformance --output <new-directory>')
  return { output: argv[1] }
}

export async function publicationAdapterConformance(
  argv = process.argv.slice(2),
  execution = {},
) {
  const options = parsePublicationAdapterConformanceArgs(argv)
  // Repository-local final outputs must already be git-ignored. Invocation-owned
  // staging is excluded explicitly from the clean-source receipt evidence.
  const root = assertPublicationOutputDirectory(options.output)
  // Reserve the caller's new output directory up front (this still fails
  // closed on a reused path), then assemble everything inside a private
  // invocation-owned staging directory and publish it with one atomic swap.
  await mkdir(dirname(root), { recursive: true })
  await mkdir(root)
  let staging
  let astroReceipt
  let payloadReceipt
  try {
    staging = await (
      execution.createStagingDirectory ?? createPublicationStagingDirectory
    )(root)
    const contentRoot = resolve(staging, 'astro-source')
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

    const astro = await adaptAstroBlogEntry({
      entryId: 'payload-equivalent',
      contentRoot,
    })
    const payload = adaptPayloadLexical(
      JSON.parse(
        await readFile(
          resolve('tests/fixtures/payload/equivalent-publication.json'),
          'utf8',
        ),
      ),
      JSON.parse(
        await readFile(resolve('tests/fixtures/payload/mapping.json'), 'utf8'),
      ),
    )
    if (!comparePublicationSemanticSubset(astro, payload))
      throw new Error('Equivalent Astro and Payload fixtures have different canonical semantics')
    const canonicalAstro = canonicalPublicationSourceResult(astro)
    const canonicalPayload = canonicalPublicationSourceResult(payload)

    const astroOutput = resolve(staging, 'astro-output')
    const payloadOutput = resolve(staging, 'payload-output')
    await vivliostyleRenderer.render(canonicalAstro, {
      outputDirectory: astroOutput,
      profiles: PUBLICATION_PROFILES,
    })
    await vivliostyleRenderer.render(canonicalPayload, {
      outputDirectory: payloadOutput,
      profiles: PUBLICATION_PROFILES,
    })
    astroReceipt = await bindPublicationSourceReceipt(
      astroOutput,
      canonicalAstro,
      'adapter-conformance',
      [staging],
    )
    payloadReceipt = await bindPublicationSourceReceipt(
      payloadOutput,
      canonicalPayload,
      'adapter-conformance',
      [staging],
    )
    const matrix = PUBLICATION_PROFILES.join(',')
    const checkerContext = {
      context: 'adapter-conformance',
      cleanlinessExclusions: [staging],
    }
    await publicationCheck(
      ['--input', astroOutput, '--matrix', matrix],
      checkerContext,
    )
    await publicationCheck(
      ['--input', payloadOutput, '--matrix', matrix],
      checkerContext,
    )
    if (!comparePublicationOutputReceipts(astroReceipt, payloadReceipt))
      throw new Error(
        'Equivalent Astro and Payload output receipts differ outside the source allowlist',
      )
    await publishPublicationOutput(staging, root)
  } catch (error) {
    // All-or-nothing: only the reservation this invocation created (and only
    // while still empty) is removed on failure.
    await rmdir(root).catch(() => {})
    throw error
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true })
  }
  process.stdout.write(
    `Astro/Payload publication output receipts conform at ${root} (${PUBLICATION_PROFILES.length} artifacts each)\n`,
  )
  return { astroReceipt, payloadReceipt }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  publicationAdapterConformance().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  })
}
