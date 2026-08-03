import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import jiti from 'jiti'
import { PUBLICATION_MATRIX } from './publication-build.mjs'

const loadTypeScript = jiti(import.meta.url, { interopDefault: true })
const { publicationGraphSchema } = loadTypeScript('../src/publication/schema.ts')
const { layoutPlanSchema } = loadTypeScript('../src/publication/planner.ts')
const { rendererProbeSchema } = loadTypeScript('../src/publication/renderer-probe.ts')
const { runStaticPreflight } = loadTypeScript('../src/publication/static-preflight.ts')
const { validateProduction } = loadTypeScript('../src/publication/production-validation.ts')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!['--input', '--matrix'].includes(key)) throw new Error(`Unknown publication:check option: ${key}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    options[key.slice(2)] = value
  }
  if (!options.input || !options.matrix) throw new Error('Usage: publication:check --input <directory> --matrix phone-webpub,eink-epub,a5-pdf,a4-pdf')
  const matrix = options.matrix.split(',').filter(Boolean)
  if (matrix.length !== PUBLICATION_MATRIX.length || PUBLICATION_MATRIX.some((profile) => !matrix.includes(profile)))
    throw new Error(`Publication check matrix must be exactly: ${PUBLICATION_MATRIX.join(',')}`)
  return { input: resolve(options.input), matrix }
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

export async function publicationCheck(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const graph = publicationGraphSchema.parse(JSON.parse(await readFile(resolve(options.input, 'publication-graph.json'), 'utf8')))
  const receipt = JSON.parse(await readFile(resolve(options.input, 'publication-receipt.json'), 'utf8'))
  assert(receipt.profiles?.length === PUBLICATION_MATRIX.length, 'Publication receipt matrix is incomplete')
  const plans = JSON.parse(await readFile(resolve(options.input, 'publication-plans.json'), 'utf8'))
  const probes = JSON.parse(await readFile(resolve(options.input, 'publication-probes.json'), 'utf8'))
  const policy = JSON.parse(await readFile(resolve(options.input, 'publication-policy.json'), 'utf8'))
  for (const profile of options.matrix) {
    const plan = layoutPlanSchema.parse(plans[profile])
    const probe = rendererProbeSchema.parse(probes[profile])
    assert(runStaticPreflight({ graph, context: fixtureContext(profile, receipt), policy, plan }).passed, `Static preflight failed for ${profile}`)
    assert(validateProduction({ graph, context: fixtureContext(profile, receipt), plan, probe }).passed, `Production validation failed for ${profile}`)
    const artifact = receipt.artifacts.find((candidate) => candidate.profile === profile)
    assert(artifact, `Missing artifact receipt for ${profile}`)
    const bytes = await readFile(resolve(options.input, artifact.path))
    assert(sha256(bytes) === artifact.sha256, `${profile} artifact hash mismatch`)
    assert(bytes.byteLength === artifact.byteLength, `${profile} artifact length mismatch`)
  }
  const html = await readFile(resolve(options.input, 'phone-webpub/index.html'), 'utf8')
  assert(html.includes(`<html lang="${graph.edition.locale}"`), 'WebPub language is missing')
  for (const node of graph.nodes) assert(html.includes(`data-canonical-id="${node.id}"`), `WebPub dropped ${node.id}`)
  const parity = JSON.parse(await readFile(resolve(options.input, 'astro-route-parity.json'), 'utf8'))
  assert(parity.result === 'passed', 'Canonical route parity did not pass')
  process.stdout.write(`Publication matrix passed at ${options.input}\n`)
  return { result: 'passed', matrix: options.matrix }
}

function fixtureContext(profile, receipt) {
  const contexts = receipt.profileContexts
  if (!contexts?.[profile]) throw new Error(`Missing context for ${profile}`)
  return contexts[profile]
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  publicationCheck().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  })
