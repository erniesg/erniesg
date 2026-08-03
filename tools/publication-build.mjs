import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'parse5'
import { serializeAssetBundle } from '../src/publication/asset-bundle.ts'
import { PublicationAdapterRegistry } from '../src/publication/adapter-registry.ts'
import { astroPublicationAdapter } from '../src/publication/adapters/astro.ts'
import {
  PUBLICATION_PROFILES,
  vivliostyleRenderer,
} from '../src/publication/renderers/vivliostyle.ts'
import { serializePublicationGraph } from '../src/publication/schema.ts'

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

function isLocalRouteAsset(src) {
  return Boolean(src) && !/^[a-z][a-z\d+.-]*:/iu.test(src)
}

function assetStem(fileName) {
  return (fileName ?? '')
    .replace(/\.[^.]*$/u, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, '')
}

export function publicationRouteHtmlDigest(html) {
  return createHash('sha256').update(html).digest('hex')
}

export function publicationRepositoryForCurrentCheckout() {
  return {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    dirty:
      execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim()
        .length > 0,
  }
}

export async function writeRouteParity(entry, output, bundle) {
  const { graph } = bundle
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
  const graphImageNodes = graph.nodes.filter(
    (node) =>
      (node.type === 'figure' && node.assetIds.length > 0) ||
      (node.type === 'media' && node.mediaKind === 'image'),
  )
  const graphImages = graphImageNodes.map((node) => {
    const assetId = node.type === 'figure' ? node.assetIds[0] : node.assetId
    const descriptor = bundle.assetBundle.descriptor.assets.find(
      (asset) => asset.id === assetId,
    )
    if (!descriptor)
      throw new Error(`Publication graph image asset is missing: ${assetId}`)
    const alternativeText =
      [
        node.accessibility.alternativeText,
        node.accessibility.longDescription,
        node.accessibility.transcript,
      ].find((value) => typeof value === 'string' && value.trim()) ?? ''
    const stem = assetStem(descriptor.fileName)
    const image = route.images.find(
      (candidate) =>
        candidate.alt === alternativeText &&
        isLocalRouteAsset(candidate.src) &&
        (!stem || assetStem(candidate.src).includes(stem)),
    )
    if (!image)
      throw new Error(
        `Canonical Astro route is missing local image asset for ${assetId}`,
      )
    return {
      assetId,
      fileName: descriptor.fileName,
      sha256: descriptor.sha256,
      routeSrc: image.src,
      alternativeText,
    }
  })
  const graphImageAlternatives = graphImages
    .map((image) => image.alternativeText)
    .filter(Boolean)
  await writeFile(
    resolve(output, 'astro-route-parity.json'),
    `${JSON.stringify(
      {
        version: '1.0.0',
        canonicalRoute: `/blog/${entry}`,
        graphSha256: createHash('sha256')
          .update(serializePublicationGraph(graph))
          .digest('hex'),
        assetBundleSha256: createHash('sha256')
          .update(serializeAssetBundle(bundle.assetBundle))
          .digest('hex'),
        routeHtmlSha256: publicationRouteHtmlDigest(html),
        headingOrder: graphHeadings,
        localImageAlternatives: graphImageAlternatives,
        imageBindings: graphImages,
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
  await writeRouteParity(options.entry, options.output, bundle)
  const receiptPath = resolve(options.output, 'publication-receipt.json')
  const currentReceipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  const repository = publicationRepositoryForCurrentCheckout()
  currentReceipt.repository = repository
  await writeFile(receiptPath, `${JSON.stringify(currentReceipt, null, 2)}\n`)
  process.stdout.write(
    `Publication matrix built at ${resolve(options.output)} (${receipt.artifacts.length} artifacts)\n`,
  )
  return { ...receipt, repository }
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
