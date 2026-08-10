import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { zipSync } from 'fflate'

const PROFILES = ['phone-webpub', 'eink-epub', 'a5-pdf', 'a4-pdf']

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function text(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value && typeof value === 'object')
    return text(value.text ?? value.name ?? value.label ?? value.title ?? value.value)
  return ''
}

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`Unknown publication:build argument: ${key}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    result[key.slice(2)] = value
  }
  if (!result.input || !result.output)
    throw new Error('Usage: publication:build --adapter payload --input <json> --mapping <json> --output <directory>')
  return result
}

function contentChildren(content) {
  const root = content?.root ?? content
  return Array.isArray(root?.children) ? root.children : []
}

function lexicalText(node) {
  if (!node || typeof node !== 'object') return ''
  if (node.type === 'text') return text(node.text ?? node.value)
  return (Array.isArray(node.children) ? node.children : []).map(lexicalText).join('')
}

function inlineRuns(node) {
  const runs = []
  let offset = 0
  const visit = (child, marks = {}) => {
    if (!child || typeof child !== 'object') return
    const type = String(child.type ?? '').toLowerCase()
    if (type === 'text') {
      const value = text(child.text ?? child.value)
      const format = Number(child.format ?? 0)
      const next = {
        ...marks,
        ...(typeof child.format === 'string' && /bold/i.test(child.format) ? { bold: true } : {}),
        ...(format & 1 ? { bold: true } : {}),
        ...(format & 2 ? { italic: true } : {}),
        ...(format & 4 ? { strikethrough: true } : {}),
        ...(format & 8 ? { underline: true } : {}),
        ...(format & 16 ? { inlineCode: true } : {}),
        ...(format & 32 ? { verticalAlign: 'subscript' } : {}),
        ...(format & 64 ? { verticalAlign: 'superscript' } : {}),
      }
      if (Object.keys(next).length) runs.push({ start: offset, end: offset + value.length, ...next })
      offset += value.length
      return
    }
    if (type === 'link') {
      ;(child.children ?? []).forEach((nested) => visit(nested, { ...marks, href: text(child.url ?? child.href) }))
      return
    }
    ;(child.children ?? []).forEach((nested) => visit(nested, marks))
  }
  ;(node.children ?? []).forEach((child) => visit(child))
  return runs
}

function buildGraph(document, mapping, assetsBySourceId = new Map()) {
  const id = text(document.id ?? document._id) || 'payload-publication'
  const locale = text(document.locale ?? document.language) || 'en'
  const sourceId = `payload:${id}:${locale}`
  const editionId = `${id}:${locale}`
  const nodes = []
  let sequence = 0
  const nextId = (node, kind) => text(node?.id ?? node?.nodeId ?? node?.key) || `${kind}-${++sequence}`
  const add = (node, path, forcedType) => {
    if (!node || typeof node !== 'object') return
    const rawType = String(node.type ?? '').toLowerCase()
    const mappedType = mapping?.blocks?.[rawType] ?? forcedType ?? rawType
    const common = {
      id: nextId(node, mappedType),
      locale,
      direction: 'auto',
      requirement: 'required',
      importance: 'essential',
      provenance: { adapterId: 'payload-lexical', sourceId, evidence: [`${sourceId}:${path}`] },
      accessibility: { decorative: false },
      variants: [],
      permittedTransformationIds: [],
      edition: { editionId, sourceLocaleKey: locale },
    }
    if (mappedType === 'heading') {
      const level = Number(node.level ?? String(node.tag ?? 'h2').replace(/^h/i, '')) || 2
      nodes.push({ ...common, type: 'heading', level: Math.max(1, Math.min(6, level)), text: lexicalText(node), inlineRuns: inlineRuns(node) })
    } else if (mappedType === 'quote' || mappedType === 'paragraph' || mappedType === 'aside') {
      nodes.push({ ...common, type: mappedType, text: lexicalText(node) || text(node.text) || ' ', inlineRuns: inlineRuns(node) })
    } else if (mappedType === 'code') {
      nodes.push({ ...common, type: 'code', code: text(node.code ?? node.text ?? node.value) || ' ', language: text(node.language) || undefined })
    } else if (mappedType === 'list') {
      const children = Array.isArray(node.children) ? node.children : []
      const itemIds = children.map((item) => nextId(item, 'item'))
      nodes.push({ ...common, type: 'list', ordered: node.listType === 'number' || node.ordered === true, itemIds })
      children.forEach((item, index) => {
        nodes.push({ ...common, id: itemIds[index], type: 'list-item', parentListId: common.id, childListIds: [], text: lexicalText(item) || text(item.text) || ' ', inlineRuns: inlineRuns(item) })
      })
    } else if (mappedType === 'reference') {
      const target = text(node.target ?? node.value ?? node.id) || `${common.id}-target`
      nodes.push({ ...common, type: 'reference', targetIds: [], text: text(node.label ?? node.text) || target, href: `#${target}` })
    } else if (mappedType === 'figure' || mappedType === 'media' || mappedType === 'upload' || mappedType === 'image') {
      const sourceAssetId = text(node.value ?? node.asset ?? node.upload ?? node.id)
      const asset = assetsBySourceId.get(sourceAssetId)
      nodes.push({ ...common, type: 'figure', title: text(node.title ?? node.alt) || 'Upload', assetIds: asset ? [asset.id] : [], ...(asset ? { accessibility: { decorative: false, ...(asset.accessibilityLabel ? { alternativeText: asset.accessibilityLabel } : {}) } } : {}) })
    } else if (Array.isArray(node.children)) {
      node.children.forEach((child, index) => add(child, `${path}.children[${index}]`))
    }
  }
  contentChildren(document.content ?? document.body ?? document.richText).forEach((node, index) => add(node, `content.root.children[${index}]`))
  if (!nodes.length) add({ type: 'heading', text: document.title }, 'metadata.title', 'heading')
  return {
    version: '1.0.0',
    id,
    metadata: {
      title: text(document.title) || id,
      abstract: text(document.description) || undefined,
      contributors: (Array.isArray(document.authors) ? document.authors : document.authors ? [document.authors] : []).map(text).filter(Boolean),
      status: ['draft', 'working'].includes(String(document.status).toLowerCase()) ? 'working' : String(document.status).toLowerCase() === 'review' ? 'review' : 'published',
      sourceDocumentVersion: text(document.version) || undefined,
      defaultLocale: locale,
      defaultDirection: 'auto',
      keywords: Array.isArray(document.keywords) ? document.keywords.map(text).filter(Boolean) : [],
    },
    edition: { id: editionId, locale, direction: 'auto' },
    nodes,
  }
}

function buildAssets(document) {
  const bySourceId = new Map()
  const descriptors = []
  const byHash = new Map()
  const uploads = Array.isArray(document.uploads) ? document.uploads : []
  for (const upload of uploads) {
    const sourceId = text(upload?.id ?? upload?._id ?? upload?.filename)
    const encoded = text(upload?.data ?? upload?.base64 ?? upload?.bytes)
    if (!sourceId || !encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) continue
    const bytes = Buffer.from(encoded, 'base64')
    const hash = sha256(bytes)
    const existing = byHash.get(hash)
    if (existing) {
      bySourceId.set(sourceId, existing)
      continue
    }
    const descriptor = {
      id: `asset-${hash.slice(0, 20)}`,
      sha256: hash,
      byteLength: bytes.byteLength,
      mediaType: text(upload?.mimeType ?? upload?.mimetype) || 'application/octet-stream',
      fileName: text(upload?.filename ?? upload?.fileName) || undefined,
      accessibilityLabel: text(upload?.alt ?? upload?.altText) || undefined,
      ...(Number.isInteger(upload?.width) ? { width: upload.width } : {}),
      ...(Number.isInteger(upload?.height) ? { height: upload.height } : {}),
    }
    descriptors.push(descriptor)
    byHash.set(hash, descriptor)
    bySourceId.set(sourceId, descriptor)
  }
  return { descriptors, bySourceId }
}

function renderHtml(graph, profile) {
  const escape = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const body = graph.nodes.map((node) => {
    if (node.type === 'heading') return `<h${node.level} id="${escape(node.id)}">${escape(node.text)}</h${node.level}>`
    if (node.type === 'quote') return `<blockquote id="${escape(node.id)}">${escape(node.text)}</blockquote>`
    if (node.type === 'code') return `<pre id="${escape(node.id)}"><code>${escape(node.code)}</code></pre>`
    if (node.type === 'figure') return `<figure id="${escape(node.id)}"><figcaption>${escape(node.title)}</figcaption></figure>`
    if (node.type === 'list') return `<ul id="${escape(node.id)}">${node.itemIds.map((id) => `<li>${escape(graph.nodes.find((candidate) => candidate.id === id)?.text)}</li>`).join('')}</ul>`
    if (node.type === 'list-item') return ''
    if ('text' in node) return `<p id="${escape(node.id)}">${escape(node.text)}</p>`
    return ''
  }).join('\n')
  return `<!doctype html><html lang="${escape(graph.edition.locale)}"><head><meta charset="utf-8"><title>${escape(graph.metadata.title)}</title></head><body data-profile="${escape(profile)}"><main>${body}</main></body></html>\n`
}

function renderEpub(graph) {
  const html = renderHtml(graph, 'eink-epub')
  const opf = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">${graph.id}</dc:identifier><dc:title>${graph.metadata.title}</dc:title><dc:language>${graph.edition.locale}</dc:language></metadata><manifest><item id="content" href="content.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="content"/></spine></package>`
  const container = `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  const files = {
    mimetype: new TextEncoder().encode('application/epub+zip'),
    'META-INF/container.xml': new TextEncoder().encode(container),
    'OEBPS/content.xhtml': new TextEncoder().encode(html),
    'OEBPS/content.opf': new TextEncoder().encode(opf),
  }
  return Buffer.from(zipSync(files, { level: 0 }))
}

function renderPdf(graph, profile) {
  const width = profile === 'a4-pdf' ? 595 : 419
  const height = profile === 'a4-pdf' ? 842 : 595
  const escape = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
  const content = `BT /F1 14 Tf 48 ${height - 72} Td (${escape(graph.metadata.title)}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index < offsets.length; index += 1) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

async function main() {
  const options = args(process.argv.slice(2))
  if (options.adapter && options.adapter !== 'payload') throw new Error(`Unsupported publication adapter in this slice: ${options.adapter}`)
  const input = JSON.parse(await readFile(resolve(options.input), 'utf8'))
  const mapping = options.mapping ? JSON.parse(await readFile(resolve(options.mapping), 'utf8')) : {}
  const document = input?.document ?? input?.data ?? input
  const assets = buildAssets(document)
  const graph = buildGraph(document, mapping, assets.bySourceId)
  const root = resolve(options.output)
  await mkdir(root, { recursive: true })
  const graphBytes = Buffer.from(JSON.stringify(graph, null, 2) + '\n')
  await writeFile(resolve(root, 'graph.json'), graphBytes)
  await writeFile(resolve(root, 'assets.json'), JSON.stringify({ version: '1.0.0', assets: assets.descriptors }, null, 2) + '\n')
  await writeFile(resolve(root, 'mapping.json'), JSON.stringify(mapping, null, 2) + '\n')
  const artifacts = {}
  for (const profile of PROFILES) {
    const relativePath = profile === 'phone-webpub' ? `${profile}/index.html` : `${profile}/publication.${profile.endsWith('epub') ? 'epub' : 'pdf'}`
    const bytes = profile === 'eink-epub'
      ? renderEpub(graph)
      : profile.endsWith('-pdf')
        ? renderPdf(graph, profile)
        : Buffer.from(renderHtml(graph, profile))
    await mkdir(dirname(resolve(root, relativePath)), { recursive: true })
    await writeFile(resolve(root, relativePath), bytes)
    artifacts[profile] = { relativePath, byteLength: bytes.byteLength, sha256: sha256(bytes) }
  }
  const receipt = {
    version: '1.0.0',
    adapter: 'payload-lexical',
    adapterVersion: '1.0.0',
    mappingVersion: mapping.version ?? '1.0.0',
    graphSha256: sha256(graphBytes),
    assetBundleSha256: sha256(stable({ version: '1.0.0', assets: assets.descriptors })),
    sourceSha256: sha256(stable(document)),
    canonicalSubsetSha256: sha256(stable({ title: graph.metadata.title, contributors: graph.metadata.contributors, nodes: graph.nodes.map(({ provenance, ...node }) => node) })),
    rendererVersion: 'source-neutral-html-1.0.0',
    profiles: PROFILES,
    artifacts,
    repository: { commit: process.env.PUBLICATION_COMMIT || '0'.repeat(40), dirty: false },
  }
  await writeFile(resolve(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(`${JSON.stringify({ output: root, profiles: PROFILES, graphSha256: receipt.graphSha256 })}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
