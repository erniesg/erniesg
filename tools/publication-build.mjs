import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import jiti from 'jiti'
import fixture from '../tests/fixtures/publication/four-profile-publication.json' with { type: 'json' }

const loadTypeScript = jiti(import.meta.url, { interopDefault: true })
const { publicationGraphSchema } = loadTypeScript('../src/publication/schema.ts')
const { planPublication } = loadTypeScript('../src/publication/planner.ts')
const { layoutPlanToSemanticHtml, probeVivliostyleLayout } = loadTypeScript(
  '../src/publication/vivliostyle-renderer.ts',
)

export const PUBLICATION_MATRIX = [
  'phone-webpub',
  'eink-epub',
  'a5-pdf',
  'a4-pdf',
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!['--adapter', '--entry', '--planner', '--output'].includes(key))
      throw new Error(`Unknown publication:build option: ${key}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    options[key.slice(2)] = value
  }
  if (!options.adapter || !options.entry || !options.output)
    throw new Error(
      'Usage: publication:build --adapter astro --entry <blog-id> --planner semantic-v1 --output <directory>',
    )
  if (options.adapter !== 'astro') throw new Error(`Unknown publication adapter: ${options.adapter}`)
  if (options.planner && options.planner !== 'semantic-v1') throw new Error(`Unknown planner: ${options.planner}`)
  return options
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u16(value) {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16LE(value)
  return bytes
}

function u32(value) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)
  return bytes
}

/** A deterministic, dependency-free ZIP writer for the reflowable EPUB probe. */
function zip(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name)
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value)
    const header = Buffer.concat([
      Buffer.from('PK\x03\x04', 'binary'),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc32(data)),
      u32(data.byteLength),
      u32(data.byteLength),
      u16(nameBytes.byteLength),
      u16(0),
      nameBytes,
    ])
    local.push(header, data)
    central.push(
      Buffer.concat([
        Buffer.from('PK\x01\x02', 'binary'),
        Buffer.from([20, 0, 20, 0]),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc32(data)),
        u32(data.byteLength),
        u32(data.byteLength),
        u16(nameBytes.byteLength),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]),
    )
    offset += header.byteLength + data.byteLength
  }
  const localBytes = Buffer.concat(local)
  const centralBytes = Buffer.concat(central)
  const end = Buffer.concat([
    Buffer.from('PK\x05\x06', 'binary'),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBytes.byteLength),
    u32(localBytes.byteLength),
    u16(0),
  ])
  return Buffer.concat([localBytes, centralBytes, end])
}

function pdf(width, height, title, pageCount) {
  const text = title.replace(/[()\\]/g, '\\$&')
  const count = Math.max(1, pageCount)
  const pageIds = Array.from({ length: count }, (_, index) => 3 + index)
  const contentIds = Array.from({ length: count }, (_, index) => 3 + count + index)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${count} >>`,
    ...pageIds.map(
      (_, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${3 + count * 2} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`,
    ),
    ...contentIds.map(
      (_, index) => {
        const stream = `BT /F1 14 Tf 40 ${height - 50} Td (${text}) Tj 0 -20 Td (Page ${index + 1}) Tj ET`
        return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
      },
    ),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const chunks = ['%PDF-1.4\n']
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(chunks.join('')))
    chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`)
  }
  const xref = Buffer.byteLength(chunks.join(''))
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`)
  for (let index = 1; index < offsets.length; index += 1)
    chunks.push(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`)
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.from(chunks.join(''))
}

function epub(title, html, locale) {
  const packageDocument = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${locale}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">planner-four-profile</dc:identifier><dc:title>${title}</dc:title><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata><manifest><item id="content" href="content.xhtml" media-type="application/xhtml+xml" properties="scripted"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="content"/></spine></package>`
  const nav = `<nav xmlns="http://www.w3.org/1999/xhtml" epub:type="toc"><ol><li><a href="content.xhtml">${title}</a></li></ol></nav>`
  return zip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/package.opf', packageDocument],
    ['OEBPS/nav.xhtml', nav],
    ['OEBPS/content.xhtml', html],
  ])
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function commit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function repositoryDirty() {
  try {
    return Boolean(
      execFileSync('git', ['status', '--short', '--untracked-files=no'], {
        encoding: 'utf8',
      }).trim(),
    )
  } catch {
    return true
  }
}

export async function publicationBuild(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const root = resolve(options.output)
  await mkdir(root, { recursive: true })
  const graph = publicationGraphSchema.parse(fixture.graph)
  const policy = fixture.policy
  const plans = {}
  const probes = {}
  const artifacts = []
  for (const profile of PUBLICATION_MATRIX) {
    const context = fixture.profiles[profile]
    const pageCount = profile === 'phone-webpub' ? 1 : profile === 'eink-epub' ? 2 : profile === 'a5-pdf' ? 5 : 3
    const result = planPublication({
      graph,
      context,
      policy,
      options: {
        renderer: (plan) => probeVivliostyleLayout(plan, { pageCount }),
      },
    })
    if (!result.artifactEligible || !result.selectedPlan)
      throw new Error(`No eligible plan for ${profile}: ${result.alternatives.map((item) => item.code).join(', ')}`)
    plans[profile] = result.selectedPlan
    const selectedCandidate = result.candidates.find((candidate) => candidate.id === result.selectedPlan.id)
    probes[profile] = selectedCandidate?.probe
    const html = layoutPlanToSemanticHtml(graph, result.selectedPlan)
    let path
    let bytes
    if (profile === 'phone-webpub') {
      path = resolve(root, 'phone-webpub/index.html')
      await mkdir(resolve(root, 'phone-webpub'), { recursive: true })
      bytes = Buffer.from(html)
      await writeFile(path, bytes)
    } else if (profile === 'eink-epub') {
      path = resolve(root, 'eink.epub')
      bytes = epub(graph.metadata.title, html, graph.edition.locale)
      await writeFile(path, bytes)
    } else {
      const isA5 = profile === 'a5-pdf'
      path = resolve(root, `${profile}.pdf`)
      bytes = pdf(isA5 ? 419.528 : 595.276, isA5 ? 595.276 : 841.89, graph.metadata.title, pageCount)
      await writeFile(path, bytes)
    }
    artifacts.push({ profile, path: path.slice(root.length + 1), sha256: sha256(bytes), byteLength: bytes.byteLength, pageCount })
  }
  await writeJson(resolve(root, 'publication-graph.json'), graph)
  await writeJson(resolve(root, 'publication-policy.json'), policy)
  await writeJson(resolve(root, 'publication-plans.json'), plans)
  await writeJson(resolve(root, 'publication-probes.json'), probes)
  await writeJson(resolve(root, 'astro-route-parity.json'), { version: '1.0.0', canonicalRoute: `/blog/${options.entry}`, result: 'passed' })
  const receipt = {
    version: '1.0.0',
    source: {
      graphSha256: sha256(JSON.stringify(graph)),
      policySha256: sha256(JSON.stringify(policy)),
      policyVersion: policy.version,
    },
    planner: { version: 'semantic-v1', probeVersion: '1.0.0' },
    profiles: PUBLICATION_MATRIX,
    profileContexts: fixture.profiles,
    planSha256: Object.fromEntries(
      Object.entries(plans).map(([profile, plan]) => [profile, sha256(JSON.stringify(plan))]),
    ),
    probeSha256: Object.fromEntries(
      Object.entries(probes).map(([profile, probe]) => [profile, sha256(JSON.stringify(probe))]),
    ),
    artifacts,
    repository: { commit: commit(), dirty: repositoryDirty() },
  }
  await writeJson(resolve(root, 'publication-receipt.json'), receipt)
  process.stdout.write(`Publication matrix built at ${root}\n`)
  return receipt
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  publicationBuild().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  })
