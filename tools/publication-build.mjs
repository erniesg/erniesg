import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'parse5'
import { canonicalPublicationSubsetSha256 } from '../src/publication/adapter-conformance.ts'
import { serializeAssetBundle } from '../src/publication/asset-bundle.ts'
import { createDefaultPublicationAdapterRegistry } from '../src/publication/adapter-registry.ts'
import {
  PUBLICATION_PROFILES,
  vivliostyleRenderer,
} from '../src/publication/renderers/vivliostyle.ts'
import { serializePublicationGraph } from '../src/publication/schema.ts'

export function parsePublicationBuildArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (
      ![
        '--adapter',
        '--entry',
        '--input',
        '--mapping',
        '--output',
      ].includes(option)
    )
      throw new Error(`Unknown publication:build option: ${option}`)
    const value = argv[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${option}`)
    options[option.slice(2)] = value
  }
  if (!options.adapter || !options.output)
    throw new Error(
      'Usage: publication:build --adapter astro --entry <blog-id> --output <directory> | --adapter payload --input <json> [--mapping <json>] --output <directory>',
    )
  if (options.adapter === 'payload') options.adapter = 'payload-lexical'
  if (options.adapter === 'astro') {
    if (!options.entry)
      throw new Error('Astro publication builds require --entry <blog-id>')
    if (options.input || options.mapping)
      throw new Error('Astro publication builds do not accept Payload input or mapping files')
  } else if (options.adapter === 'payload-lexical') {
    if (!options.input)
      throw new Error('Payload publication builds require --input <json>')
    if (options.entry)
      throw new Error('Payload publication builds do not accept an Astro --entry')
  } else {
    throw new Error(`Unsupported publication source adapter: ${options.adapter}`)
  }
  return options
}

function resolveThroughExistingAncestor(value) {
  let ancestor = resolve(value)
  const unresolved = []
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    unresolved.unshift(basename(ancestor))
    ancestor = parent
  }
  return resolve(realpathSync(ancestor), ...unresolved)
}

export function assertPublicationOutputDirectory(output) {
  const repositoryRoot = resolveThroughExistingAncestor(
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim(),
  )
  const candidate = resolve(output)
  const policyCandidate = resolveThroughExistingAncestor(candidate)
  const repositoryRelative = relative(repositoryRoot, policyCandidate)
  const repositoryLocal =
    repositoryRelative === '' ||
    (!repositoryRelative.startsWith(`..${sep}`) &&
      repositoryRelative !== '..' &&
      !isAbsolute(repositoryRelative))
  if (!repositoryLocal) return candidate
  let ignored = false
  if (repositoryRelative) {
    try {
      execFileSync(
        'git',
        ['check-ignore', '--quiet', '--no-index', '--', policyCandidate],
        { stdio: 'ignore' },
      )
      ignored = true
    } catch {
      ignored = false
    }
  }
  if (!ignored)
    throw new Error(
      `Repository-local publication output must be ignored before generation: ${candidate}`,
    )
  return candidate
}

export async function createPublicationStagingDirectory(finalOutput) {
  const parent = dirname(resolve(finalOutput))
  await mkdir(parent, { recursive: true })
  // mkdtemp gives the staging root an unpredictable name and mode 0700, so no
  // other principal can pre-place or insert entries for the build to follow.
  return mkdtemp(resolve(parent, '.publication-staging-'))
}

function publicationPublishError(error, finalOutput) {
  if (error?.code === 'EXDEV')
    // The staging directory lives next to the publish target, so a
    // cross-device rename only happens when the target itself is a mount
    // point. Copying into a possibly hostile directory is never a fallback.
    return new Error(
      `Publication output ${finalOutput} cannot be published with an atomic rename (cross-device); failing closed instead of degrading to a copy`,
    )
  return error
}

export async function publishPublicationOutput(stagedOutput, finalOutput) {
  const final = resolve(finalOutput)
  const retired = resolve(
    dirname(final),
    `.publication-retired-${randomBytes(8).toString('hex')}`,
  )
  let hasPrevious = true
  try {
    await rename(final, retired)
  } catch (error) {
    if (error?.code === 'ENOENT') hasPrevious = false
    else throw publicationPublishError(error, final)
  }
  try {
    // Replace, never merge: the completed staging result is swapped in
    // wholesale with a single atomic rename.
    await rename(stagedOutput, final)
  } catch (error) {
    if (hasPrevious) await rename(retired, final).catch(() => {})
    throw publicationPublishError(error, final)
  }
  if (hasPrevious) await rm(retired, { recursive: true, force: true })
}

export function publicationSourceReceipt(bundle, routeParity) {
  return {
    adapterId: bundle.provenance.adapterId,
    adapterVersion: bundle.provenance.adapterVersion,
    sourceType: bundle.provenance.sourceType,
    sourceId: bundle.provenance.sourceId,
    ...(bundle.provenance.sourceRevision
      ? { sourceRevision: bundle.provenance.sourceRevision }
      : {}),
    ...(bundle.provenance.mappingVersion
      ? { mappingVersion: bundle.provenance.mappingVersion }
      : {}),
    graphSha256: createHash('sha256')
      .update(serializePublicationGraph(bundle.graph))
      .digest('hex'),
    assetBundleSha256: createHash('sha256')
      .update(serializeAssetBundle(bundle.assetBundle))
      .digest('hex'),
    canonicalSubsetSha256: canonicalPublicationSubsetSha256(bundle),
    routeParity,
  }
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

function bodyText(value) {
  return String(value ?? '')
    .replace(/\s+/gu, ' ')
    .replaceAll('’', "'")
    .trim()
}

function graphNodeText(node) {
  if ('text' in node) return bodyText(node.text)
  return ''
}

export function publicationGraphBodyFingerprint(graph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const nestedListIds = new Set(
    graph.nodes
      .filter((node) => node.type === 'list-item')
      .flatMap((node) => node.childListIds ?? []),
  )
  const fingerprint = []
  const captionToken = (captionId, tag = 'figcaption') => {
    const caption = captionId ? byId.get(captionId) : undefined
    if (caption?.type === 'caption')
      fingerprint.push(`${tag}:${graphNodeText(caption)}`)
  }
  const visit = (node) => {
    switch (node.type) {
      case 'heading':
        fingerprint.push(`h${node.level}:${graphNodeText(node)}`)
        break
      case 'paragraph':
        fingerprint.push(`p:${graphNodeText(node)}`)
        break
      case 'list':
        fingerprint.push(node.ordered ? 'ol' : 'ul')
        for (const itemId of node.itemIds) {
          const item = byId.get(itemId)
          if (!item || item.type !== 'list-item') continue
          fingerprint.push(`li:${graphNodeText(item)}`)
          for (const childId of item.childListIds ?? []) {
            const child = byId.get(childId)
            if (child?.type === 'list') visit(child)
          }
        }
        break
      case 'list-item':
        break
      case 'quote':
        fingerprint.push(
          `blockquote:${bodyText([node.text, node.attribution].filter(Boolean).join(' '))}`,
        )
        break
      case 'code':
        fingerprint.push(`pre:${bodyText(node.code)}`)
        break
      case 'table':
        fingerprint.push('table')
        captionToken(node.captionId, 'caption')
        for (const row of node.rows)
          for (const cell of row.cells)
            fingerprint.push(`${cell.headerScope ? 'th' : 'td'}:${bodyText(cell.text)}`)
        break
      case 'equation':
        fingerprint.push(`math:${bodyText([node.source, node.label].filter(Boolean).join(' '))}`)
        captionToken(node.captionId)
        break
      case 'aside':
        fingerprint.push(`aside:${graphNodeText(node)}`)
        break
      case 'note':
        fingerprint.push(`aside:${node.noteKind}:${bodyText([node.label, node.text].join(' '))}`)
        break
      case 'reference':
        fingerprint.push(`p:doc-biblioentry:${graphNodeText(node)}`)
        break
      case 'caption':
        break
      case 'figure':
        if (node.assetIds.length === 0 && node.sourceText)
          fingerprint.push(`figure:${bodyText([node.title, node.sourceText].join(' '))}`)
        captionToken(node.captionId)
        break
      case 'media':
        if (node.mediaKind === 'interactive' && node.accessibility.transcript)
          fingerprint.push(`figure:${bodyText(node.accessibility.transcript)}`)
        captionToken(node.captionId)
        break
      default:
        break
    }
  }
  for (const node of graph.nodes) {
    if (node.type === 'list-item' || nestedListIds.has(node.id) || node.type === 'caption') continue
    visit(node)
  }
  return fingerprint
}

function findTag(root, tagName) {
  if (!root) return undefined
  if (root.tagName === tagName) return root
  for (const child of root.childNodes ?? []) {
    const found = findTag(child, tagName)
    if (found) return found
  }
  return undefined
}

function directBodyText(node, excludedTags = new Set()) {
  if (!node) return ''
  if (node.nodeName === '#text') return node.value ?? ''
  if (node.tagName && excludedTags.has(node.tagName)) return ''
  return (node.childNodes ?? [])
    .map((child) => directBodyText(child, excludedTags))
    .join('')
}

function attribute(node, name) {
  return node?.attrs?.find((value) => value.name === name)?.value
}

function textContent(node) {
  if (!node) return ''
  if (node.nodeName === '#text') return node.value ?? ''
  return (node.childNodes ?? []).map(textContent).join('')
}

export function canonicalRouteBodyFingerprint(html) {
  const root = findTag(parse(html), 'article') ?? findTag(parse(html), 'main')
  const fingerprint = []
  const visit = (node) => {
    const tag = node.tagName
    if (!tag) {
      for (const child of node.childNodes ?? []) visit(child)
      return
    }
    if (/^h[1-6]$/u.test(tag)) {
      fingerprint.push(`${tag}:${bodyText(textContent(node))}`)
      return
    }
    if (tag === 'p') {
      const images = []
      const collectImages = (candidate) => {
        if (candidate.tagName === 'img') images.push(candidate)
        for (const child of candidate.childNodes ?? []) collectImages(child)
      }
      collectImages(node)
      if (images.length && !textContent(node).trim()) {
        for (const image of images) {
          const title = attribute(image, 'title')
          if (title) fingerprint.push(`figcaption:${bodyText(title)}`)
        }
        return
      }
      const role = attribute(node, 'role')
      fingerprint.push(
        role === 'doc-biblioentry'
          ? `p:doc-biblioentry:${bodyText(textContent(node))}`
          : `p:${bodyText(textContent(node))}`,
      )
      return
    }
    if (tag === 'blockquote') {
      fingerprint.push(`blockquote:${bodyText(textContent(node))}`)
      return
    }
    if (tag === 'pre') {
      fingerprint.push(`pre:${bodyText(textContent(node))}`)
      return
    }
    if (tag === 'img') {
      const title = attribute(node, 'title')
      if (title) fingerprint.push(`figcaption:${bodyText(title)}`)
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      fingerprint.push(tag)
      for (const child of node.childNodes ?? []) if (child.tagName === 'li') visit(child)
      return
    }
    if (tag === 'li') {
      fingerprint.push(
        `li:${bodyText(directBodyText(node, new Set(['ul', 'ol'])))}`,
      )
      for (const child of node.childNodes ?? []) if (child.tagName === 'ul' || child.tagName === 'ol') visit(child)
      return
    }
    if (tag === 'table') {
      fingerprint.push('table')
      for (const child of node.childNodes ?? []) visit(child)
      return
    }
    if (tag === 'caption') {
      fingerprint.push(`caption:${bodyText(textContent(node))}`)
      return
    }
    if (tag === 'th' || tag === 'td') {
      fingerprint.push(`${tag}:${bodyText(textContent(node))}`)
      return
    }
    if (attribute(node, 'role') === 'math') {
      fingerprint.push(`math:${bodyText(textContent(node))}`)
      return
    }
    if (tag === 'aside') {
      const role = attribute(node, 'role')
      const prefix = role?.startsWith('doc-') ? `aside:${role}:` : 'aside:'
      fingerprint.push(`${prefix}${bodyText(textContent(node))}`)
      return
    }
    if (tag === 'figcaption') {
      fingerprint.push(`figcaption:${bodyText(textContent(node))}`)
      return
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  if (root) visit(root)
  return fingerprint
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

export function consumeRouteImageIndex(
  images,
  usedIndexes,
  alternativeText,
  stem,
) {
  const index = images.findIndex(
    (candidate, candidateIndex) =>
      !usedIndexes.has(candidateIndex) &&
      candidate.alt === alternativeText &&
      isLocalRouteAsset(candidate.src) &&
      (!stem || assetStem(candidate.src).includes(stem)),
  )
  if (index >= 0) usedIndexes.add(index)
  return index
}

export function publicationRouteHtmlDigest(html) {
  return createHash('sha256').update(html).digest('hex')
}

export function publicationReceiptDigest(receipt) {
  return createHash('sha256').update(receipt).digest('hex')
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

export async function writeRouteParity(entry, output, bundle, repository) {
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
  const graphBody = publicationGraphBodyFingerprint(graph)
  const routeBody = canonicalRouteBodyFingerprint(html)
  if (JSON.stringify(graphBody) !== JSON.stringify(routeBody))
    throw new Error('Canonical Astro route body semantics differ from the publication graph')
  const graphImageNodes = graph.nodes.filter(
    (node) =>
      (node.type === 'figure' && node.assetIds.length > 0) ||
      (node.type === 'media' && node.mediaKind === 'image'),
  )
  const usedRouteImageIndexes = new Set()
  const graphImages = []
  for (const node of graphImageNodes) {
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
    const imageIndex = consumeRouteImageIndex(
      route.images,
      usedRouteImageIndexes,
      alternativeText,
      stem,
    )
    const image = imageIndex >= 0 ? route.images[imageIndex] : undefined
    if (!image)
      throw new Error(
        `Canonical Astro route is missing local image asset for ${assetId}`,
      )
    graphImages.push({
      assetId,
      fileName: descriptor.fileName,
      sha256: descriptor.sha256,
      routeSrc: image.src,
      routeSha256: await (async () => {
        const rawSrc = String(image.src ?? '').split(/[?#]/u)[0]
        if (!isLocalRouteAsset(rawSrc) || !rawSrc)
          throw new Error(`Canonical Astro route image is not local for ${assetId}`)
        const routeRoot = resolve('dist')
        const candidate = isAbsolute(rawSrc)
          ? resolve(routeRoot, rawSrc.replace(/^[/\\]+/u, ''))
          : resolve(dirname(routePath), rawSrc)
        const escaped = relative(routeRoot, candidate).split(sep).join('/')
        if (escaped.startsWith('../') || isAbsolute(escaped))
          throw new Error(`Canonical Astro route image escapes dist for ${assetId}`)
        return createHash('sha256').update(await readFile(candidate)).digest('hex')
      })(),
      alternativeText,
    })
  }
  const graphImageAlternatives = graphImages
    .map((image) => image.alternativeText)
    .filter(Boolean)
  const publicationReceipt = await readFile(
    resolve(output, 'publication-receipt.json'),
  )
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
        publicationReceiptSha256: publicationReceiptDigest(publicationReceipt),
        repositoryCommit:
          repository?.commit ?? publicationRepositoryForCurrentCheckout().commit,
        repositoryDirty:
          repository?.dirty ?? publicationRepositoryForCurrentCheckout().dirty,
        routeHtmlSha256: publicationRouteHtmlDigest(html),
        headingOrder: graphHeadings,
        bodyOrder: graphBody,
        localImageAlternatives: graphImageAlternatives,
        imageBindings: graphImages,
        result: 'passed',
      },
      null,
      2,
    )}\n`,
    // Exclusive creation inside the invocation-owned staging directory.
    { flag: 'wx' },
  )
}

export async function bindPublicationSourceReceipt(output, bundle, routeParity) {
  const receiptPath = resolve(output, 'publication-receipt.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  const source = publicationSourceReceipt(bundle, routeParity)
  if (
    receipt.source?.graphSha256 !== source.graphSha256 ||
    receipt.source?.assetBundleSha256 !== source.assetBundleSha256
  )
    throw new Error('Publication renderer receipt does not match its source bundle')
  receipt.source = source
  receipt.repository = publicationRepositoryForCurrentCheckout()
  // In-place update of a receipt this invocation created inside its private
  // staging directory; the bound result is then published atomically.
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  return receipt
}

export async function publicationBuild(argv = process.argv.slice(2)) {
  const options = parsePublicationBuildArgs(argv)
  // Repository-local outputs must already be git-ignored before anything —
  // staging included — is created for them.
  const finalOutput = assertPublicationOutputDirectory(options.output)
  const registry = createDefaultPublicationAdapterRegistry()
  const locator =
    options.adapter === 'astro'
      ? { entryId: options.entry }
      : {
          document: JSON.parse(await readFile(resolve(options.input), 'utf8')),
          ...(options.mapping
            ? {
                mapping: JSON.parse(
                  await readFile(resolve(options.mapping), 'utf8'),
                ),
              }
            : {}),
        }
  const bundle = await registry.resolve(options.adapter, locator)
  // The whole build writes into a private invocation-owned staging directory
  // and only ever touches the caller-supplied output path through one final
  // atomic swap, so a reused (possibly attacker-seeded) output directory is
  // never followed into, merged into, or partially mutated.
  const staging = await createPublicationStagingDirectory(finalOutput)
  let receipt
  let boundReceipt
  try {
    const stagedOutput = resolve(staging, 'output')
    receipt = await vivliostyleRenderer.render(bundle, {
      outputDirectory: stagedOutput,
      profiles: PUBLICATION_PROFILES,
    })
    boundReceipt = await bindPublicationSourceReceipt(
      stagedOutput,
      bundle,
      options.adapter === 'astro'
        ? 'astro-canonical-route'
        : 'not-applicable',
    )
    if (options.adapter === 'astro')
      await writeRouteParity(options.entry, stagedOutput, bundle, boundReceipt.repository)
    await publishPublicationOutput(stagedOutput, finalOutput)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  process.stdout.write(
    `Publication matrix built at ${finalOutput} (${receipt.artifacts.length} artifacts)\n`,
  )
  return boundReceipt
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
