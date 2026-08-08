import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  comparePublicationOutputReceipts,
  comparePublicationSemanticSubset,
} from '../src/publication/adapter-conformance.ts'
import { adaptAstroBlogEntry } from '../src/publication/adapters/astro.ts'
import { adaptPayloadLexical } from '../src/publication/adapters/payload-lexical.ts'
import {
  PUBLICATION_PROFILES,
  vivliostyleRenderer,
} from '../src/publication/renderers/vivliostyle.ts'
import { bindPublicationSourceReceipt } from './publication-build.mjs'
import { publicationCheck } from './publication-check.mjs'

export function parsePublicationAdapterConformanceArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--output' || !argv[1] || argv[1].startsWith('--'))
    throw new Error('Usage: publication-adapter-conformance --output <new-directory>')
  return { output: argv[1] }
}

export async function publicationAdapterConformance(argv = process.argv.slice(2)) {
  const options = parsePublicationAdapterConformanceArgs(argv)
  const root = resolve(options.output)
  await mkdir(root)
  const contentRoot = resolve(root, 'astro-source')
  const entryRoot = resolve(contentRoot, 'payload-equivalent')
  await mkdir(entryRoot, { recursive: true })
  await writeFile(
    resolve(entryRoot, 'index.mdx'),
    await readFile(
      resolve('tests/fixtures/publication/astro/payload-equivalent.mdx'),
      'utf8',
    ),
  )
  await copyFile(
    resolve('public/favicon-16x16.png'),
    resolve(entryRoot, 'fixture-image.png'),
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

  const astroOutput = resolve(root, 'astro-output')
  const payloadOutput = resolve(root, 'payload-output')
  await vivliostyleRenderer.render(astro, {
    outputDirectory: astroOutput,
    profiles: PUBLICATION_PROFILES,
  })
  await vivliostyleRenderer.render(payload, {
    outputDirectory: payloadOutput,
    profiles: PUBLICATION_PROFILES,
  })
  const astroReceipt = await bindPublicationSourceReceipt(
    astroOutput,
    astro,
    'adapter-conformance',
  )
  const payloadReceipt = await bindPublicationSourceReceipt(
    payloadOutput,
    payload,
    'adapter-conformance',
  )
  const matrix = PUBLICATION_PROFILES.join(',')
  const checkerContext = { context: 'adapter-conformance' }
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
