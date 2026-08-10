import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const PROFILES = ['phone-webpub', 'eink-epub', 'a5-pdf', 'a4-pdf']

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function parse(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`Unknown publication:check argument: ${key}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    result[key.slice(2)] = value
  }
  if (!result.input || !result.matrix) throw new Error('Usage: publication:check --input <directory> --matrix phone-webpub,eink-epub,a5-pdf,a4-pdf')
  const matrix = result.matrix.split(',').filter(Boolean)
  if (matrix.length !== PROFILES.length || PROFILES.some((profile) => !matrix.includes(profile)))
    throw new Error(`Publication check matrix must be exactly: ${PROFILES.join(',')}`)
  return { input: resolve(result.input), matrix }
}

async function main() {
  const { input, matrix } = parse(process.argv.slice(2))
  const graph = JSON.parse(await readFile(resolve(input, 'graph.json'), 'utf8'))
  const assets = JSON.parse(await readFile(resolve(input, 'assets.json'), 'utf8'))
  const receipt = JSON.parse(await readFile(resolve(input, 'receipt.json'), 'utf8'))
  if (receipt.adapter !== 'payload-lexical') throw new Error('Publication receipt is not from the Payload adapter')
  if (JSON.stringify(receipt.profiles) !== JSON.stringify(PROFILES)) throw new Error('Publication receipt has an incomplete output matrix')
  if (!graph.metadata?.title || !Array.isArray(graph.nodes) || !graph.nodes.length) throw new Error('Publication graph is incomplete')
  if (receipt.graphSha256 !== sha256(Buffer.from(JSON.stringify(graph, null, 2) + '\n'))) throw new Error('Publication graph hash does not match its receipt')
  if (!assets || assets.version !== '1.0.0' || !Array.isArray(assets.assets)) throw new Error('Publication asset bundle is incomplete')
  for (const profile of matrix) {
    const artifact = receipt.artifacts?.[profile]
    if (!artifact) throw new Error(`Publication receipt is missing ${profile}`)
    const bytes = await readFile(resolve(input, artifact.relativePath))
    if (bytes.byteLength !== artifact.byteLength || sha256(bytes) !== artifact.sha256)
      throw new Error(`Publication artifact changed: ${profile}`)
    if (!bytes.toString('utf8').includes(graph.metadata.title)) throw new Error(`Publication artifact dropped title: ${profile}`)
  }
  process.stdout.write(`${JSON.stringify({ result: 'passed', input, matrix })}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
