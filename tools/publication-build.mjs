import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'parse5'
import {
  PublicationAdapterRegistry,
} from '../src/publication/adapter-registry.ts'
import { astroPublicationAdapter } from '../src/publication/adapters/astro.ts'
import {
  PUBLICATION_PROFILES,
  vivliostyleRenderer,
} from '../src/publication/renderers/vivliostyle.ts'

export function parsePublicationBuildArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (!['--adapter', '--entry', '--output'].includes(option))
      throw new Error(`Unknown publication:build option: ${option}`)
    const value = argv[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${option}`)
    options[option.slice(2)] = value
  }
  if (!options.adapter || !options.entry || !options.output)
    throw new Error(
      'Usage: publication:build --adapter astro --entry <blog-id> --output <directory>',
    )
  return options
}

function collectElements(node, result = { headings: [], images: [] }) {
  if (node.tagName && /^h[1-6]$/.test(node.tagName)) {
    const text = []
    const collectText = (child) => {
      if (child.nodeName === '#text') text.push(child.value)
      child.childNodes?.forEach(collectText)
    }
    collectText(node)
    result.headings.push(text.join('').trim())
  }
  if (node.tagName === 'img') {
    const attributes = Object.fromEntries(
      (node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]),
    )
    result.images.push({ src: attributes.src, alt: attributes.alt })
  }
  node.childNodes?.forEach((child) => collectElements(child, result))
  return result
}

async function writeRouteParity(entry, output, graph) {
  const routePath = resolve('dist/blog', entry, 'index.html')
  let html
  try {
    html = await readFile(routePath, 'utf8')
  } catch {
    throw new Error(
      `Canonical Astro route is unavailable at ${routePath}; run the normal Astro build before publication:build`,
    )
  }
  const route = collectElements(parse(html))
  const graphHeadings = graph.nodes
    .filter((node) => node.type === 'heading')
    .map((node) => node.text)
  let cursor = 0
  for (const heading of graphHeadings) {
    const index = route.headings.indexOf(heading, cursor)
    if (index < 0)
      throw new Error(
        `Canonical Astro route is missing publication heading: ${heading}`,
      )
    cursor = index + 1
  }
  const graphImages = graph.nodes
    .filter(
      (node) =>
        (node.type === 'figure' && node.assetIds.length > 0) ||
        (node.type === 'media' && node.mediaKind === 'image'),
    )
    .map(
      (node) =>
        node.accessibility.alternativeText ??
        node.accessibility.longDescription ??
        node.accessibility.transcript,
    )
    .filter(Boolean)
  for (const alternative of graphImages)
    if (!route.images.some((image) => image.alt === alternative))
      throw new Error(
        `Canonical Astro route is missing local image alternative: ${alternative}`,
      )
  await writeFile(
    resolve(output, 'astro-route-parity.json'),
    `${JSON.stringify(
      {
        version: '1.0.0',
        canonicalRoute: `/blog/${entry}`,
        headingOrder: graphHeadings,
        localImageAlternatives: graphImages,
        result: 'passed',
      },
      null,
      2,
    )}\n`,
  )
}

export async function publicationBuild(argv = process.argv.slice(2)) {
  const options = parsePublicationBuildArgs(argv)
  const registry = new PublicationAdapterRegistry().register(
    astroPublicationAdapter,
  )
  const bundle = await registry.resolve(options.adapter, {
    entryId: options.entry,
  })
  const receipt = await vivliostyleRenderer.render(bundle, {
    outputDirectory: options.output,
    profiles: PUBLICATION_PROFILES,
  })
  await writeRouteParity(options.entry, options.output, bundle.graph)
  process.stdout.write(
    `Publication matrix built at ${resolve(options.output)} (${receipt.artifacts.length} artifacts)\n`,
  )
  return receipt
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  publicationBuild().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  })
}
