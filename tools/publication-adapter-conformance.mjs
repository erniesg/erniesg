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
import { canonicalPublicationSourceResult } from '../src/publication/adapter-conformance.ts'
import { adaptAstroBlogEntry } from '../src/publication/adapters/astro.ts'
import {
  PUBLICATION_PROFILES,
  vivliostyleRenderer,
} from '../src/publication/renderers/vivliostyle.ts'
import {
  assertAtomicPublicationPlatform,
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
  assertAtomicPublicationPlatform(execution.platform ?? process.platform)
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
    const canonicalAstro = canonicalPublicationSourceResult(astro)

    const astroOutput = resolve(staging, 'astro-output')
    await vivliostyleRenderer.render(canonicalAstro, {
      outputDirectory: astroOutput,
      profiles: PUBLICATION_PROFILES,
    })
    astroReceipt = await bindPublicationSourceReceipt(
      astroOutput,
      canonicalAstro,
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
    `Astro publication output receipt conforms at ${root} (${PUBLICATION_PROFILES.length} artifacts)\n` +
      'Coverage loss: the cross-adapter equivalence proof no longer has a second adapter. ' +
      'The Payload-Lexical publication path was retired, so this tool can no longer compare ' +
      'an Astro receipt against an equivalent Payload receipt.\n',
  )
  return { astroReceipt }
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
