#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { chromium } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DOCUMENT = resolve(
  REPOSITORY_ROOT,
  'tests/fixtures/pdf/source-output-checkpoints.pdf',
)
const DEFAULT_CHECKPOINTS = resolve(
  REPOSITORY_ROOT,
  'tests/fixtures/pdf/source-output-checkpoints.json',
)
const DEFAULT_OUTPUT = resolve(
  REPOSITORY_ROOT,
  '.agent/evidence/srt-checkpoints',
)
const TOOL_VERSION = '1.0.0'
const PDF_RECONSTRUCTION_PROPERTIES = new Set([
  'prose-continuity',
  'hyphen-resolution',
  'markup-non-promotion',
  'furniture-exclusion',
  'marker-to-body',
  'citation-to-entry',
  'in-float-marker',
  'dangling-link-verifier',
])

export function renditionSourceForCheckpoint(
  property,
  reconstructionAvailable,
) {
  return reconstructionAvailable && PDF_RECONSTRUCTION_PROPERTIES.has(property)
    ? 'pdf-reconstruction'
    : 'struct-document'
}

const IMAGE_OPERATORS = new Set([
  pdfjs.OPS.paintImageMaskXObject,
  pdfjs.OPS.paintImageMaskXObjectGroup,
  pdfjs.OPS.paintImageMaskXObjectRepeat,
  pdfjs.OPS.paintImageXObject,
  pdfjs.OPS.paintImageXObjectRepeat,
  pdfjs.OPS.paintInlineImageXObject,
  pdfjs.OPS.paintInlineImageXObjectGroup,
  pdfjs.OPS.paintSolidColorImageMask,
])

const VECTOR_VISUAL_OPERATORS = new Set([
  pdfjs.OPS.constructPath,
  pdfjs.OPS.rectangle,
  pdfjs.OPS.stroke,
  pdfjs.OPS.closeStroke,
  pdfjs.OPS.fill,
  pdfjs.OPS.eoFill,
  pdfjs.OPS.fillStroke,
  pdfjs.OPS.eoFillStroke,
  pdfjs.OPS.closeFillStroke,
  pdfjs.OPS.closeEOFillStroke,
  pdfjs.OPS.shadingFill,
  pdfjs.OPS.rawFillPath,
])

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonBytes(value) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
}

function safeStem(value) {
  return (
    basename(value, extname(value))
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-|-$/g, '') || 'document'
  )
}

function parseList(value, label) {
  const values = String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (values.length === 0) throw new Error(`INVALID_${label.toUpperCase()}`)
  return values
}

export function parseArguments(arguments_) {
  let document = DEFAULT_DOCUMENT
  let checkpoints = DEFAULT_CHECKPOINTS
  let output = DEFAULT_OUTPUT
  let explicitDocument = false
  let explicitOutput = false
  let profiles = null
  let pages = null
  let struct = null

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    const nextValue = () => {
      const value = arguments_[index + 1]
      if (!value || value.startsWith('--')) throw new Error('INVALID_USAGE')
      index += 1
      return value
    }
    if (argument === '--document') {
      document = resolve(nextValue())
      explicitDocument = true
    } else if (argument.startsWith('--document=')) {
      document = resolve(argument.slice('--document='.length))
      explicitDocument = true
    } else if (argument === '--checkpoints') {
      checkpoints = resolve(nextValue())
    } else if (argument.startsWith('--checkpoints=')) {
      checkpoints = resolve(argument.slice('--checkpoints='.length))
    } else if (argument === '--output') {
      output = resolve(nextValue())
      explicitOutput = true
    } else if (argument.startsWith('--output=')) {
      output = resolve(argument.slice('--output='.length))
      explicitOutput = true
    } else if (argument === '--profile') {
      profiles = parseList(nextValue(), 'profile')
    } else if (argument.startsWith('--profile=')) {
      profiles = parseList(argument.slice('--profile='.length), 'profile')
    } else if (argument === '--pages') {
      pages = parseList(nextValue(), 'pages').map((value) => {
        if (!/^[1-9][0-9]*$/u.test(value)) throw new Error('INVALID_PAGES')
        return Number(value)
      })
    } else if (argument.startsWith('--pages=')) {
      pages = parseList(argument.slice('--pages='.length), 'pages').map(
        (value) => {
          if (!/^[1-9][0-9]*$/u.test(value)) throw new Error('INVALID_PAGES')
          return Number(value)
        },
      )
    } else if (argument === '--struct') {
      struct = resolve(nextValue())
    } else if (argument.startsWith('--struct=')) {
      struct = resolve(argument.slice('--struct='.length))
    } else {
      throw new Error('INVALID_USAGE')
    }
  }

  return {
    document,
    checkpoints,
    output,
    explicitDocument,
    explicitOutput,
    profiles,
    pages,
    struct,
  }
}

function pathWithin(root, candidate) {
  const value = relative(root, candidate)
  return (
    value === '' ||
    (value !== '..' && !value.startsWith(`..${'/'}`) && !isAbsolute(value))
  )
}

async function policyPath(candidate) {
  const resolved = resolve(candidate)
  const missingSegments = []
  let current = resolved
  while (true) {
    try {
      const existing = await realpath(current)
      return join(existing, ...missingSegments.reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) return resolved
      missingSegments.push(basename(current))
      current = parent
    }
  }
}

async function enforceOutputPrivacy(options) {
  const [repositoryRoot, documentPath, outputPath] = await Promise.all([
    realpath(REPOSITORY_ROOT),
    policyPath(options.document),
    policyPath(options.output),
  ])
  const fixtureDocument = pathWithin(repositoryRoot, documentPath)
  const defaultFixture = documentPath === (await policyPath(DEFAULT_DOCUMENT))
  const callerOutputPath = resolve(options.output)
  if (
    !fixtureDocument &&
    (pathWithin(repositoryRoot, callerOutputPath) ||
      pathWithin(repositoryRoot, outputPath))
  ) {
    throw new Error(
      'PRIVATE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY: owner-local documents require a caller-named local output directory',
    )
  }
  if (!defaultFixture && !options.struct) {
    throw new Error(
      'PRIVATE_STRUCT_REQUIRED: documents other than the repository fixture require a caller-provided STRUCT JSON document',
    )
  }
  if (options.explicitDocument && !options.explicitOutput) {
    throw new Error(
      'PRIVATE_OUTPUT_REQUIRED: custom documents require an explicit --output directory',
    )
  }
  return { defaultFixture }
}

async function renderSourcePage(pdfDocument, pageNumber, width) {
  if (
    !Number.isInteger(pageNumber) ||
    pageNumber < 1 ||
    pageNumber > pdfDocument.numPages
  ) {
    throw new Error(`SOURCE_PAGE_OUT_OF_RANGE: ${pageNumber}`)
  }
  const page = await pdfDocument.getPage(pageNumber)
  try {
    const base = page.getViewport({ scale: 1 })
    const scale = width / base.width
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(
      Math.max(1, Math.ceil(viewport.width)),
      Math.max(1, Math.ceil(viewport.height)),
    )
    const context = canvas.getContext('2d')
    context.save()
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.restore()
    await page.render({
      canvas,
      canvasContext: context,
      viewport,
      background: 'white',
    }).promise
    const operatorList = await page.getOperatorList()
    const textContent = await page.getTextContent()
    const text = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    return {
      bytes: new Uint8Array(await canvas.encode('png')),
      width: canvas.width,
      height: canvas.height,
      text,
      hasVisual: operatorList.fnArray.some(
        (operator) =>
          IMAGE_OPERATORS.has(operator) ||
          VECTOR_VISUAL_OPERATORS.has(operator),
      ),
    }
  } finally {
    page.cleanup()
  }
}

function evidence(page, sourceHash, byteLength, width, height) {
  return {
    confidence: 1,
    pages: [page],
    boxes: [
      {
        page,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        rotation: 0,
      },
    ],
    sourceIds: [
      `source-page-${page}-${sourceHash.slice(0, 12)}-${byteLength}-${width}x${height}`,
    ],
  }
}

async function cropFixtureFigure(asset) {
  const image = await loadImage(Buffer.from(asset.bytes))
  const xScale = asset.width / 612
  const yScale = asset.height / 792
  const crop = {
    x: Math.round(126 * xScale),
    y: Math.round((792 - 460) * yScale),
    width: Math.round(360 * xScale),
    height: Math.round(160 * yScale),
  }
  const canvas = createCanvas(crop.width, crop.height)
  const context = canvas.getContext('2d')
  context.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  )
  return {
    bytes: new Uint8Array(await canvas.encode('png')),
    width: crop.width,
    height: crop.height,
  }
}

async function createFixtureStructDocument({
  sourceHash,
  byteLength,
  pageCount,
  fileName,
  page,
  asset,
  structDigest,
}) {
  const figureAsset = await cropFixtureFigure(asset)
  const sourceEvidence = evidence(
    page,
    sourceHash,
    byteLength,
    asset.width,
    asset.height,
  )
  const blockEvidence = {
    ...sourceEvidence,
    sourceIds: [`source-page-${page}`],
  }
  const cells = [
    {
      id: 'checkpoint-table-profile',
      text: 'Profile',
      row: 0,
      column: 0,
      rowSpan: 1,
      columnSpan: 1,
      headerScope: 'column',
      inline: [],
      evidence: blockEvidence,
    },
    {
      id: 'checkpoint-table-nodes',
      text: 'Nodes',
      row: 0,
      column: 1,
      rowSpan: 1,
      columnSpan: 1,
      headerScope: 'column',
      inline: [],
      evidence: blockEvidence,
    },
    {
      id: 'checkpoint-table-paper',
      text: 'Paper Pro',
      row: 1,
      column: 0,
      rowSpan: 1,
      columnSpan: 1,
      headerScope: null,
      inline: [],
      evidence: blockEvidence,
    },
    {
      id: 'checkpoint-table-value',
      text: '4',
      row: 1,
      column: 1,
      rowSpan: 1,
      columnSpan: 1,
      headerScope: null,
      inline: [],
      evidence: blockEvidence,
    },
  ]
  // Issue 043 prose claims: a sentence the source split across a page break, a
  // discretionary hyphen resolved to its attested joined form, and source text
  // that merely looks like markup and must stay literal.
  const pageJoinProse =
    'A second result sentence runs off the bottom of this page and continues at the top of the next one without losing its clause.'
  const hyphenResolutionProse =
    'The high-resolution photograph is attested elsewhere as photograph.'
  const literalMarkupProse =
    '## Not a heading and **not bold** and {placeholder} stay literal.'
  const textCharacterCount = [
    'Checkpoint paper',
    'The result sentence continues across a column break.',
    'Figure 1. Source flowchart',
    'Table 1. Validated checkpoint values remain structured.',
    'for each source line:\n  compare source and rendition\n  keep the named property visible',
    pageJoinProse,
    hyphenResolutionProse,
    literalMarkupProse,
    ...cells.map(({ text }) => text),
  ].reduce((total, value) => total + value.length, 0)
  const figureEvidence = {
    ...sourceEvidence,
    boxes: [
      {
        page,
        x: 126 / 612,
        y: 300 / 792,
        width: 360 / 612,
        height: 160 / 792,
        rotation: 0,
      },
    ],
    sourceIds: [`source-figure-${page}`],
  }
  const documentId = `srt-checkpoint-${sourceHash.slice(0, 24)}`
  const document = {
    schemaVersion: '0.1.0',
    documentId,
    source: {
      format: 'pdf',
      fileName,
      sha256: sourceHash,
      byteLength,
      pageCount,
      localOnly: true,
    },
    metadata: {
      title: 'A source/output checkpoint fixture',
      subtitle: 'The reader-visible rendition is the evidence.',
      authors: ['Ernie Fixture'],
      abstract: 'A deterministic fixture for source-versus-output review.',
      language: 'en',
      baseDirection: 'ltr',
      updated: '2026-01-01',
      artifactModifiedAt: '2026-01-01T00:00:00Z',
    },
    blocks: [
      {
        id: 'checkpoint-heading',
        kind: 'heading',
        text: 'Checkpoint paper',
        page,
        order: 0,
        column: 'single',
        inline: [],
        attributes: { level: 1 },
        evidence: blockEvidence,
      },
      {
        id: 'checkpoint-prose',
        kind: 'paragraph',
        text: 'The result sentence continues across a column break.',
        page,
        order: 1,
        column: 'single',
        inline: [],
        evidence: blockEvidence,
      },
      {
        id: 'checkpoint-figure',
        kind: 'figure',
        label: 'Figure 1',
        text: 'Figure 1. Source flowchart',
        page,
        order: 2,
        column: 'single',
        inline: [],
        fallbackAssetIds: ['checkpoint-source-flowchart'],
        evidence: blockEvidence,
      },
      {
        id: 'checkpoint-table',
        kind: 'table',
        text: 'Table 1. Validated checkpoint values remain structured.',
        page,
        order: 3,
        column: 'single',
        inline: [],
        table: { rows: 2, columns: 2, cells, semantic: 'verified' },
        evidence: blockEvidence,
      },
      {
        id: 'checkpoint-code',
        kind: 'code',
        text: 'for each source line:\n  compare source and rendition\n  keep the named property visible',
        page,
        order: 4,
        column: 'single',
        inline: [],
        evidence: blockEvidence,
      },
      {
        id: 'checkpoint-page-join-prose',
        kind: 'paragraph',
        text: pageJoinProse,
        page,
        order: 5,
        column: 'single',
        inline: [],
        evidence: blockEvidence,
      },
      {
        id: 'checkpoint-hyphen-prose',
        kind: 'paragraph',
        text: hyphenResolutionProse,
        page,
        order: 6,
        column: 'single',
        inline: [],
        evidence: blockEvidence,
      },
      {
        id: 'checkpoint-markup-prose',
        kind: 'paragraph',
        text: literalMarkupProse,
        page,
        order: 7,
        column: 'single',
        inline: [],
        evidence: blockEvidence,
      },
    ],
    assets: [
      {
        id: 'checkpoint-source-flowchart',
        kind: 'figure',
        href: 'assets/source-flowchart.png',
        mediaType: 'image/png',
        sha256: sha256(figureAsset.bytes),
        width: figureAsset.width,
        height: figureAsset.height,
        bytes: figureAsset.bytes,
        sourceObjectIds: [`source-figure-${page}`],
        evidence: figureEvidence,
        fallback: 'asset',
      },
    ],
    relationships: [],
    pages: [
      {
        page,
        width: asset.width,
        height: asset.height,
        rotation: 0,
        blocks: [
          'checkpoint-heading',
          'checkpoint-prose',
          'checkpoint-figure',
          'checkpoint-table',
          'checkpoint-code',
          'checkpoint-page-join-prose',
          'checkpoint-hyphen-prose',
          'checkpoint-markup-prose',
        ],
        columns: [
          {
            id: 'column-single',
            side: 'single',
            blockIds: [
              'checkpoint-heading',
              'checkpoint-prose',
              'checkpoint-figure',
              'checkpoint-table',
              'checkpoint-code',
              'checkpoint-page-join-prose',
              'checkpoint-hyphen-prose',
              'checkpoint-markup-prose',
            ],
          },
        ],
      },
    ],
    diagnostics: [],
    recovery: {
      status: 'ready',
      title: 'Checkpoint fixture is ready.',
      summary: 'All named source/output properties are available for review.',
      issues: [],
    },
    receipt: {
      schemaVersion: '0.1.0',
      documentId,
      sourceSha256: sourceHash,
      blockCount: 8,
      assetCount: 1,
      relationshipCount: 0,
      diagnosticCount: 0,
      textCharacterCount,
      conservation: {
        sourceNodeCount: 8,
        accountedSourceNodeCount: 8,
        sourceRegionCount: 1,
        accountedSourceRegionCount: 1,
        sourceAnnotationCount: 0,
        accountedSourceAnnotationCount: 0,
        sourceAssetCount: 1,
        accountedSourceAssetCount: 1,
        sourceRelationshipCount: 0,
        accountedSourceRelationshipCount: 0,
        sourceDiagnosticCount: 0,
        accountedSourceDiagnosticCount: 0,
        sourceTextCharacterCount: textCharacterCount,
        structBlockCount: 8,
        structAssetCount: 1,
        structRelationshipCount: 0,
        structDiagnosticCount: 0,
        structTextCharacterCount: textCharacterCount,
        furnitureContaminationCount: 0,
      },
      generatedSha256: '',
    },
  }
  const { receipt, ...withoutReceipt } = document
  receipt.generatedSha256 = structDigest({
    ...withoutReceipt,
    conservation: receipt.conservation,
    assets: document.assets.map(({ bytes: _bytes, ...asset }) => asset),
  })
  return document
}

async function loadStructDocument(path, fallback) {
  if (!path) return fallback
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  return {
    ...parsed,
    assets: Array.isArray(parsed.assets)
      ? parsed.assets.map((asset) => ({
          ...asset,
          bytes: decodeAssetBytes(asset.bytes),
        }))
      : parsed.assets,
  }
}

function decodeAssetBytes(value) {
  if (value === undefined || value instanceof Uint8Array) return value
  if (typeof value === 'string') {
    return new Uint8Array(Buffer.from(value, 'base64'))
  }
  if (Array.isArray(value)) return Uint8Array.from(value)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([key]) => /^[0-9]+$/u.test(key))
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, entry]) => entry)
    if (entries.length > 0) return Uint8Array.from(entries)
  }
  return value
}

async function writeArchive(archive, root) {
  for (const [name, bytes] of Object.entries(archive)) {
    const destination = join(root, ...name.split('/'))
    if (!pathWithin(root, destination)) {
      throw new Error(`EPUB_ARCHIVE_PATH_ESCAPE: ${name}`)
    }
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
  }
}

async function renderRendition({
  buildEpub,
  profile,
  document,
  renditionSource,
  browser,
  root,
}) {
  const epub =
    renditionSource === 'pdf-reconstruction'
      ? await buildEpub(document, profile)
      : await buildEpub(document)
  const archive = unzipSync(epub.bytes)
  const packagedDocuments = Object.fromEntries(
    Object.entries(archive).flatMap(([name, bytes]) =>
      name.startsWith('EPUB/') && name.endsWith('.xhtml')
        ? [[name.slice('EPUB/'.length), strFromU8(bytes)]]
        : [],
    ),
  )
  const unpacked = await mkdtemp(join(root, 'rendition-'))
  await writeArchive(archive, unpacked)
  const page = await browser.newPage({
    viewport: {
      width: Math.max(1, Math.round(profile.preview.widthCssPx)),
      height: Math.max(
        1,
        Math.round(
          profile.preview.heightCssPx ??
            profile.preview.continuousWindowHeightCssPx ??
            900,
        ),
      ),
    },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
  })
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    if (/^(?:file|data|about):/u.test(url)) await route.continue()
    else await route.abort('blockedbyclient')
  })
  try {
    await page.goto(pathToFileURL(join(unpacked, 'EPUB/content.xhtml')).href, {
      waitUntil: 'load',
      timeout: 30_000,
    })
    const html = await page.evaluate(() => document.documentElement.outerHTML)
    const bytes = new Uint8Array(
      await page.screenshot({ type: 'png', fullPage: true }),
    )
    const renderedHeight = await page.evaluate(() =>
      Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
      ),
    )
    return {
      html,
      packagedDocuments,
      bytes,
      width: Math.max(1, Math.round(profile.preview.widthCssPx)),
      height: Math.max(1, renderedHeight),
    }
  } finally {
    await page.close()
    await rm(unpacked, { recursive: true, force: true })
  }
}

async function createViteModules() {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    root: REPOSITORY_ROOT,
    server: { middlewareMode: true, watch: null },
  })
  try {
    const [checkpoints, pdf, struct, targets, structIds] = await Promise.all([
      vite.ssrLoadModule('/src/research/source-output-checkpoints.ts'),
      vite.ssrLoadModule('/src/research/pdf.ts'),
      vite.ssrLoadModule('/src/research/epub.ts'),
      vite.ssrLoadModule('/src/research/targets.ts'),
      vite.ssrLoadModule('/src/struct/ids.ts'),
    ])
    return { vite, checkpoints, pdf, struct, targets, structIds }
  } catch (error) {
    await vite.close()
    throw error
  }
}

function artifactName(checkpoint, kind) {
  return `${safeStem(checkpoint.id)}.${kind}.png`
}

function reviewerConclusion(checkpoint, result) {
  return result.status === 'passed'
    ? `Pass: inspect the ${checkpoint.property} claim in this source/after pair.`
    : `Fail: ${result.reason ?? 'the named property is not proven'}`
}

function assertStructMatchesSource(
  document,
  sourceHash,
  sourceBytes,
  fileName,
) {
  if (!document || typeof document !== 'object') {
    throw new Error('STRUCT_DOCUMENT_INVALID: expected a JSON object')
  }
  if (document.source?.sha256 !== sourceHash) {
    throw new Error(
      'STRUCT_SOURCE_MISMATCH: STRUCT source.sha256 must match the selected PDF',
    )
  }
  if (document.source?.fileName && document.source.fileName !== fileName) {
    throw new Error(
      'STRUCT_SOURCE_MISMATCH: STRUCT source.fileName must match the selected PDF basename',
    )
  }
  if (document.source?.byteLength !== sourceBytes.byteLength) {
    throw new Error(
      'STRUCT_SOURCE_MISMATCH: STRUCT source.byteLength must match the selected PDF',
    )
  }
}

async function run(options) {
  const privacy = await enforceOutputPrivacy(options)
  const [sourceBytes, checkpointInput] = await Promise.all([
    readFile(options.document),
    readFile(options.checkpoints, 'utf8'),
  ])
  const sourceHash = sha256(sourceBytes)
  const modules = await createViteModules()
  let browser
  let pdfDocument
  try {
    const checkpointSet = modules.checkpoints.parseSourceOutputCheckpointSet(
      JSON.parse(checkpointInput),
    )
    let checkpoints = checkpointSet.checkpoints.filter(
      (checkpoint) => checkpoint.document === basename(options.document),
    )
    if (checkpoints.length === 0) {
      throw new Error(
        `NO_CHECKPOINTS_FOR_DOCUMENT: ${basename(options.document)}`,
      )
    }
    if (options.profiles) {
      checkpoints = checkpoints.filter((checkpoint) =>
        options.profiles.includes(checkpoint.profile),
      )
    }
    if (options.pages) {
      checkpoints = checkpoints.filter((checkpoint) =>
        options.pages.includes(checkpoint.page),
      )
    }
    if (checkpoints.length === 0) throw new Error('NO_CHECKPOINTS_SELECTED')
    checkpoints = modules.checkpoints.sortSourceOutputCheckpoints(checkpoints)

    pdfDocument = await pdfjs.getDocument({
      data: new Uint8Array(sourceBytes),
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise
    const sourceAsset = await renderSourcePage(
      pdfDocument,
      checkpoints[0].page,
      1200,
    )
    const fallback = privacy.defaultFixture
      ? await createFixtureStructDocument({
          sourceHash,
          byteLength: sourceBytes.byteLength,
          pageCount: pdfDocument.numPages,
          fileName: basename(options.document),
          page: checkpoints[0].page,
          asset: sourceAsset,
          structDigest: modules.structIds.structDigest,
        })
      : null
    const document = await loadStructDocument(options.struct, fallback)
    assertStructMatchesSource(
      document,
      sourceHash,
      sourceBytes,
      basename(options.document),
    )
    const reconstruction = privacy.defaultFixture
      ? await modules.pdf.reconstructPdf(
          new File([sourceBytes], basename(options.document), {
            type: 'application/pdf',
            lastModified: 0,
          }),
          undefined,
          { language: 'en-US' },
        )
      : null
    browser = await chromium.launch({ headless: true })
    const browserRoot = await mkdtemp(join(tmpdir(), 'srt-source-output-'))
    const byPair = new Map()
    const results = []
    const artifacts = []
    const artifactPaths = new Set()
    try {
      await mkdir(join(options.output, 'pairs'), { recursive: true })
      for (const checkpoint of checkpoints) {
        const profile = modules.targets.getTargetProfile(checkpoint.profile)
        const renditionSource = renditionSourceForCheckpoint(
          checkpoint.property,
          Boolean(reconstruction),
        )
        const pairKey = `${checkpoint.page}\0${checkpoint.profile}\0${renditionSource}`
        let pair = byPair.get(pairKey)
        if (!pair) {
          const source = await renderSourcePage(
            pdfDocument,
            checkpoint.page,
            Math.max(1, Math.round(profile.preview.widthCssPx)),
          )
          const rendition = await renderRendition({
            buildEpub: modules.struct.buildEpub,
            profile,
            document:
              renditionSource === 'pdf-reconstruction'
                ? reconstruction.paper
                : document,
            renditionSource,
            browser,
            root: browserRoot,
          })
          pair = { source, rendition }
          byPair.set(pairKey, pair)
        }
        const result = modules.checkpoints.evaluateSourceOutputCheckpoint(
          checkpoint,
          {
            source: {
              page: checkpoint.page,
              text: pair.source.text,
              hasVisual: pair.source.hasVisual,
              furnitureContaminationCount:
                renditionSource === 'pdf-reconstruction'
                  ? reconstruction.completeness.furnitureContaminationCount
                  : document.receipt?.conservation?.furnitureContaminationCount,
            },
            rendition: {
              profile: checkpoint.profile,
              width: pair.rendition.width,
              html: pair.rendition.html,
              packagedDocuments: pair.rendition.packagedDocuments,
              semanticFlowBoundaryLedgerValid:
                renditionSource === 'pdf-reconstruction'
                  ? !reconstruction.diagnostics.some(
                      (diagnostic) =>
                        diagnostic.code ===
                        'INVALID_SOURCE_SEMANTIC_FLOW_BOUNDARY_LEDGER',
                    )
                  : undefined,
              semanticFlowBoundaryDecisions:
                renditionSource === 'pdf-reconstruction'
                  ? reconstruction.sourceSemanticFlowBoundaryDecisions
                  : undefined,
            },
          },
        )
        const sourceName = artifactName(checkpoint, 'source')
        const outputName = artifactName(checkpoint, 'after')
        for (const artifactPath of [sourceName, outputName]) {
          if (artifactPaths.has(artifactPath)) {
            throw new Error(
              `CHECKPOINT_ARTIFACT_COLLISION: ${artifactPath} is not unique`,
            )
          }
          artifactPaths.add(artifactPath)
        }
        await writeFile(
          join(options.output, 'pairs', sourceName),
          pair.source.bytes,
        )
        await writeFile(
          join(options.output, 'pairs', outputName),
          pair.rendition.bytes,
        )
        artifacts.push(
          {
            checkpointId: checkpoint.id,
            kind: 'source-page',
            path: `pairs/${sourceName}`,
            sha256: sha256(pair.source.bytes),
            byteLength: pair.source.bytes.byteLength,
            width: pair.source.width,
            height: pair.source.height,
          },
          {
            checkpointId: checkpoint.id,
            kind: 'rendered-output',
            path: `pairs/${outputName}`,
            sha256: sha256(pair.rendition.bytes),
            byteLength: pair.rendition.bytes.byteLength,
            width: pair.rendition.width,
            height: pair.rendition.height,
          },
        )
        results.push({
          ...result,
          document: checkpoint.document,
          page: checkpoint.page,
          profile: checkpoint.profile,
          property: checkpoint.property,
          criterion: checkpoint.criterion,
          sourceExpectation: checkpoint.source,
          outputExpectation: checkpoint.output,
          renditionSource,
          sourceArtifact: `pairs/${sourceName}`,
          outputArtifact: `pairs/${outputName}`,
          conclusion: reviewerConclusion(checkpoint, result),
        })
      }
    } finally {
      await rm(browserRoot, { recursive: true, force: true })
    }

    const manifest = {
      schemaVersion: TOOL_VERSION,
      kind: 'srt-source-output-checkpoint-evidence',
      source: {
        document: basename(options.document),
        sha256: sourceHash,
        byteLength: sourceBytes.byteLength,
        pageCount: pdfDocument.numPages,
      },
      profiles: [
        ...new Set(checkpoints.map((checkpoint) => checkpoint.profile)),
      ].map((id) => {
        const profile = modules.targets.getTargetProfile(id)
        return {
          id,
          version: profile.version,
          width: profile.preview.widthCssPx,
          height:
            profile.preview.heightCssPx ??
            profile.preview.continuousWindowHeightCssPx ??
            null,
        }
      }),
      checkpoints: results,
      artifacts,
      result: results.every((result) => result.status === 'passed')
        ? 'passed'
        : 'failed',
      determinism: {
        volatileFields: [],
        guarantee:
          'Fixed source bytes, checkpoint set, target profile, export implementation, and compatible browser/toolchain produce byte-stable artifacts.',
      },
    }
    await writeFile(
      join(options.output, 'checkpoint-manifest.json'),
      jsonBytes(manifest),
    )
    const rows = results
      .map(
        (result) =>
          `| ${result.checkpointId} | ${result.document} | ${result.page} | ${result.profile} | ${result.property} | [source](./${result.sourceArtifact}) | [after](./${result.outputArtifact}) | ${result.status} | ${result.conclusion} |`,
      )
      .join('\n')
    const readme = `# Source/output checkpoint evidence

Generated by \`npm run srt:checkpoint-evidence\`. Each row names the source
page, the target profile width, the property under test, and the conclusion a
reviewer should draw from the paired images. The \"after\" image is captured
from the deterministic EPUB produced by the same export entry point used by
the reader; it is not a studio approximation or a raw canonical-text render.

Private documents may use this tool with a caller-named output directory
outside the repository. Only repository-owned fixture inputs are eligible for
the checked-in evidence flow.

| Checkpoint | Document | Page | Profile | Property | Source | After | Result | Reviewer conclusion |
|---|---|---:|---|---|---|---|---|---|
${rows}

The JSON checkpoint manifest records SHA-256 digests, dimensions, and the exact named
criteria. No timestamp, absolute path, or local document text is emitted.
`
    await writeFile(join(options.output, 'README.md'), readme)
    if (manifest.result !== 'passed') {
      throw new Error('SOURCE_OUTPUT_CHECKPOINT_FAILED')
    }
    return manifest
  } finally {
    await pdfDocument?.destroy().catch(() => undefined)
    await browser?.close()
    await modules.vite.close()
  }
}

async function main() {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
    await run(options)
    process.stdout.write('Source/output checkpoint evidence passed.\n')
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = /INVALID_USAGE|INVALID_PAGES/u.test(String(error))
      ? 2
      : 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main()
}
