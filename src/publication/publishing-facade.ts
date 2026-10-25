import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { StructDocument } from '@erniesg/struct/document'
import { decodeStructDocument } from '@erniesg/struct/document'
import { parse } from 'parse5'
import { canonicalPublicationSubsetSha256 } from './adapter-conformance'
import { serializeAssetBundle, type AssetBundle } from './asset-bundle'
import { createDefaultPublicationAdapterRegistry } from './adapter-registry'
import {
  publicationInlineLinkTargets,
  publicationNodeForProfile,
  vivliostyleRenderer,
  type PublicationProfile,
  type PublicationReceipt,
} from './renderers/vivliostyle'
import { serializePublicationGraph } from './schema'
import type { PublicationGraph, PublicationNode } from './schema'
import { adaptStructDocument } from './struct-adapter'
import { readStructPackagePin } from './struct-package-pin'
import {
  createStructBundleForDocument,
  structCutoverSourceBinding,
  structDocumentJson,
  structDocumentSha256,
} from './struct-source-binding'
import type { AdapterDiagnostic, AdapterProvenance } from './source-adapter'
import type { PublicationSourceResult } from './source-adapter'
import type { StructCutoverSourceBinding } from './source-binding'
import { publicationSourceBindingSchema } from './source-binding'

/**
 * The app-owned publishing facade.
 *
 * The facade is the only module the CLI tools import for publication
 * semantics. It owns the one-way projection from the pinned approved Struct
 * revision onto the ephemeral renderer plan, and it keeps that plan inside the
 * facade: no graph symbol is exported from this module, and no graph artifact
 * is written, read back, or used as a source identity.
 *
 * The source identity of a publication is the Struct binding: the digest of
 * the canonical Struct document bytes, the package pin that produced them,
 * and - when those bytes were really produced - the digest of the bundle wire
 * bytes and of the package's own semantic receipt.
 */

/** The source locator of a publication plan. */
export type PublicationPlanSource =
  | { adapterId: 'astro'; entryId: string; contentRoot?: string }
  | { adapterId: 'struct'; document: StructDocument }

/** The publication plan: the pinned approved Struct revision and its facts. */
export type PublicationPlan = {
  /** The pinned approved Struct revision this plan is derived from. */
  structDocument: StructDocument
  structDocumentSha256: string
  /** The digest of the bundle wire bytes this plan is bound to. */
  structBundleSha256: string
  /** The package's semantic receipt digest of the pinned Struct revision. */
  semanticReceiptSha256: string
  /** The app-owned asset carrier for the plan (bytes resolved lazily). */
  assetBundle: AssetBundle
  sourceBinding: StructCutoverSourceBinding
  diagnostics: AdapterDiagnostic[]
  provenance: AdapterProvenance
}

/**
 * What one rendered node must contain.
 *
 * The expectation is a checklist derived from the plan, not a semantic model:
 * it carries no identifier of its own, no inline structure and no provenance.
 * Every text in it is copied from the Struct block it was projected from.
 */
export type PublicationPlanNodeExpectation = {
  /** The element id the renderer emits for the node. */
  readonly id: string
  /** The expected element tag, when the profile renders a tagged element. */
  readonly tag: string | undefined
  /** The text fragments the rendered element must contain. */
  readonly texts: readonly string[]
  /** The asset ids the rendered element must carry. */
  readonly assetIds: readonly string[]
  /** The accessibility label the rendered element must carry. */
  readonly alternativeText: string
  /** The source fallback text of a figure that renders no asset. */
  readonly sourceText: string | undefined
  /** The media kind of a media node. */
  readonly mediaKind: 'image' | 'audio' | 'video' | 'interactive' | undefined
  /** Whether a media node is decorative. */
  readonly decorative: boolean | undefined
}

/** The expectations of one rendered profile. */
export type PublicationPlanProfileExpectations = {
  /** The required node ids, in rendered order. */
  readonly nodeOrder: readonly string[]
  /** The required nodes, with the content each of them must carry. */
  readonly nodes: readonly PublicationPlanNodeExpectation[]
  /** The texts the PDF of this profile must preserve. */
  readonly pdfTextRequirements: readonly string[]
  /** The texts the PDF of this profile must not orphan. */
  readonly pdfWidowOrphanTexts: readonly string[]
  /** The link targets the PDF of this profile must carry. */
  readonly pdfLinkRequirements: readonly string[]
  /** The asset ids the PDF of this profile must render. */
  readonly pdfImageAssetIds: readonly string[]
  /** Whether the PDF of this profile must carry link annotations. */
  readonly pdfRequiresLinks: boolean
}

/** The image binding of the plan, as the canonical route must mirror it. */
export type PublicationPlanImageBinding = {
  readonly assetId: string
  readonly fileName: string | undefined
  readonly sha256: string
  readonly alternativeText: string
}

/** Everything the checker needs to know about the rendered artifacts. */
export type PublicationPlanExpectations = {
  /** The publication title. */
  readonly title: string
  /** The edition locale. */
  readonly locale: string
  /** The publication id, from which the canonical route is derived. */
  readonly publicationId: string
  /** The heading order of the publication. */
  readonly headingOrder: readonly string[]
  /** The body fingerprint of the publication. */
  readonly bodyOrder: readonly string[]
  /** The alternative texts of the publication's images, in document order. */
  readonly localImageAlternatives: readonly string[]
  /** The image bindings of the publication, in document order. */
  readonly imageBindings: readonly PublicationPlanImageBinding[]
  /** The per-profile expectations. */
  readonly profiles: Readonly<
    Record<PublicationProfile, PublicationPlanProfileExpectations>
  >
}

/**
 * The `source` block of a publication receipt.
 *
 * The graph, asset and canonical-subset digests are diagnostic back-compat
 * fields: they describe what the render saw, and they are never the source
 * identity. The source identity is the Struct binding the receipt carries
 * separately.
 */
export type PublicationSourceReceiptBlock = {
  adapterId: string
  adapterVersion: string
  sourceType: string
  sourceId: string
  sourceRevision?: string
  mappingVersion?: string
  /** Diagnostic back-compat digest. It is never the source identity. */
  graphSha256: string
  /** Diagnostic back-compat digest. It is never the source identity. */
  assetBundleSha256: string
  /** Diagnostic back-compat digest. It is never the source identity. */
  canonicalSubsetSha256: string
}

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * The projection of a Struct document onto the ephemeral renderer plan.
 *
 * The projection is created here and dropped here: it is never persisted,
 * never handed to the CLI, and never used as a receipt identity.
 */
function projectPlan(structDocument: StructDocument) {
  const projected = adaptStructDocument(structDocument)
  return {
    graph: projected.graph,
    assetBundle: projected.assetBundle,
    diagnostics: projected.diagnostics,
    provenance: projected.provenance,
  }
}

/**
 * The bundle handle of a document.
 *
 * The bundle digest is only ever present when the bundle wire bytes were
 * really produced, so the facade refuses a document the pinned package
 * cannot bundle: a publication whose binding is not bundle-bound cannot be
 * admitted, and there is no release downgrade that drops the bundle digest.
 */
function createBundleForDocument(structDocument: StructDocument) {
  try {
    return createStructBundleForDocument(structDocument)
  } catch (error) {
    throw new Error(
      'Publication source cannot produce a bundle-bound Struct binding; the pinned package refused the document',
      { cause: error },
    )
  }
}

async function resolvePublicationSource(source: PublicationPlanSource): Promise<{
  result: PublicationSourceResult
  structDocument?: StructDocument
}> {
  if (source.adapterId === 'struct')
    // The Struct source carries its own approved revision: the projection of
    // it is the renderer plan and the document itself is the identity.
    return {
      result: adaptStructDocument(source.document),
      structDocument: source.document,
    }
  const registry = createDefaultPublicationAdapterRegistry()
  // The Astro locator may name the content root the entry is read from; the
  // adapter's own locator type owns it.
  const result = await registry.resolve('astro', {
    entryId: source.entryId,
    ...(source.contentRoot === undefined
      ? {}
      : { contentRoot: source.contentRoot }),
  })
  return { result, structDocument: result.structDocument }
}

/**
 * Build a plan from a source locator. This is the ONLY source-to-plan entry
 * point.
 *
 * The source adapter owns the ingress and the conversion; the facade owns
 * everything after it. A source that cannot produce an approved Struct
 * revision has no publication plan: the facade refuses it instead of
 * publishing a plan whose identity is not the Struct binding.
 */
export async function buildPublicationPlan(
  source: PublicationPlanSource,
): Promise<PublicationPlan> {
  const { result, structDocument } = await resolvePublicationSource(source)
  if (!structDocument)
    throw new Error(
      `Publication source ${source.adapterId} did not produce an approved Struct document; the publishing facade publishes the pinned Struct revision only`,
    )
  const projection = projectPlan(structDocument)
  const pin = await readStructPackagePin()
  const sourceBinding = await structCutoverSourceBinding(
    structDocument,
    pin,
    createBundleForDocument(structDocument),
  )
  const bundleSha256 = sourceBinding.bundleSha256
  if (!bundleSha256)
    throw new Error(
      'Publication plan is not bundle-bound; a publication plan carries the digest of its bundle wire bytes',
    )
  return {
    structDocument,
    structDocumentSha256: structDocumentSha256(structDocument),
    structBundleSha256: bundleSha256,
    semanticReceiptSha256: sourceBinding.semanticReceiptSha256,
    assetBundle: projection.assetBundle,
    sourceBinding,
    diagnostics: result.diagnostics,
    provenance: result.provenance,
  }
}

/**
 * Rebuild a plan from a persisted Struct document (used by
 * publication:check).
 *
 * The persisted document is the only semantic artifact the checker reads. The
 * asset bundle is the persisted asset descriptor; its bytes stay in the render
 * output and are never needed to identify the publication.
 */
export async function publicationPlanFromStructDocument(
  structDocument: StructDocument,
  assetBundle: AssetBundle,
): Promise<PublicationPlan> {
  const projection = projectPlan(structDocument)
  const pin = await readStructPackagePin()
  const sourceBinding = await structCutoverSourceBinding(
    structDocument,
    pin,
    createBundleForDocument(structDocument),
  )
  const bundleSha256 = sourceBinding.bundleSha256
  if (!bundleSha256)
    throw new Error(
      'Publication plan is not bundle-bound; a publication plan carries the digest of its bundle wire bytes',
    )
  return {
    structDocument,
    structDocumentSha256: structDocumentSha256(structDocument),
    structBundleSha256: bundleSha256,
    semanticReceiptSha256: sourceBinding.semanticReceiptSha256,
    assetBundle,
    sourceBinding,
    diagnostics: projection.diagnostics,
    provenance: projection.provenance,
  }
}

/**
 * The canonical semantic digest used for parity comparison. Graph-free at the
 * boundary: the caller passes a plan, the facade projects it internally.
 */
export function canonicalSubsetSha256ForPlan(plan: PublicationPlan): string {
  const projection = projectPlan(plan.structDocument)
  return canonicalPublicationSubsetSha256({
    graph: projection.graph,
    assetBundle: plan.assetBundle,
  })
}

/**
 * Canonical bytes of the persisted Struct document (stable, reproducible).
 */
export function serializeStructDocumentForPersistence(
  plan: PublicationPlan,
): string {
  return structDocumentJson(plan.structDocument)
}

/**
 * The diagnostic digest of the ephemeral renderer plan.
 *
 * It is a back-compat field of the receipt and of the route parity payload.
 * It is never the source identity: the Struct binding is.
 */
export function publicationPlanDiagnosticGraphSha256(
  plan: PublicationPlan,
): string {
  return sha256(
    serializePublicationGraph(projectPlan(plan.structDocument).graph),
  )
}

/**
 * The `source` block of a publication receipt, derived from a plan.
 *
 * The shape is unchanged: the graph and asset digests stay beside the
 * canonical semantic digest as diagnostic back-compat fields, and the source
 * identity is the Struct binding the receipt carries separately.
 */
export function publicationSourceReceiptForPlan(
  plan: PublicationPlan,
): PublicationSourceReceiptBlock {
  return {
    adapterId: plan.provenance.adapterId,
    adapterVersion: plan.provenance.adapterVersion,
    sourceType: plan.provenance.sourceType,
    sourceId: plan.provenance.sourceId,
    ...(plan.provenance.sourceRevision
      ? { sourceRevision: plan.provenance.sourceRevision }
      : {}),
    ...(plan.provenance.mappingVersion
      ? { mappingVersion: plan.provenance.mappingVersion }
      : {}),
    graphSha256: publicationPlanDiagnosticGraphSha256(plan),
    assetBundleSha256: sha256(serializeAssetBundle(plan.assetBundle)),
    canonicalSubsetSha256: canonicalSubsetSha256ForPlan(plan),
  }
}

/**
 * Decode the persisted canonical Struct document.
 *
 * The persisted bytes are decoded by the pinned package, so the checker reads
 * the canonical form and never a re-serialization of it.
 */
export function decodePersistedStructDocument(value: unknown): StructDocument {
  return decodeStructDocument(value)
}

/**
 * Parse and cross-check the Struct binding a receipt carries.
 *
 * The binding is parsed by the strict schema, so an unknown field, a
 * malformed digest or a non-hex package commit is refused. The struct
 * variant is the only variant a publication may be admitted with, so the
 * legacy variant is refused here as well: there is no legacy escape from
 * the struct-only release admission.
 *
 * The three digests of the binding are the source identity: the canonical
 * document digest, the digest of the bundle wire bytes and the package's
 * semantic receipt digest. A receipt that names another document, another
 * bundle or another semantic receipt than the plan it is checked against is
 * refused.
 */
export function assertPublicationPlanSourceBinding(
  receipt: unknown,
  plan: PublicationPlan,
): StructCutoverSourceBinding {
  const binding = publicationSourceBindingSchema.parse(
    (receipt as { sourceBinding?: unknown })?.sourceBinding,
  )
  if (binding.kind !== 'struct-cutover')
    throw new Error(
      'Publication receipt is not bound to a Struct document',
    )
  if (binding.documentSha256 !== plan.structDocumentSha256)
    throw new Error(
      'Publication receipt is bound to a different Struct document than the checked plan',
    )
  if (binding.bundleSha256 === undefined)
    throw new Error(
      'Publication receipt is not bound to its Struct bundle wire bytes',
    )
  if (binding.bundleSha256 !== plan.structBundleSha256)
    throw new Error(
      'Publication receipt is bound to a different Struct bundle than the checked plan',
    )
  if (binding.semanticReceiptSha256 !== plan.semanticReceiptSha256)
    throw new Error(
      'Publication receipt is bound to a different Struct semantic receipt than the checked plan',
    )
  return binding
}

/**
 * The `source` block of a publication receipt, derived from a validated
 * source result.
 *
 * The adapter-conformance harness compares two source adapters with each
 * other, so it holds a source result rather than a plan. The block it needs
 * is the same block a plan produces; the facade computes it here so the
 * harness never names a graph symbol itself.
 */
export function publicationSourceReceiptForSourceResult(
  result: PublicationSourceResult,
): PublicationSourceReceiptBlock {
  return {
    adapterId: result.provenance.adapterId,
    adapterVersion: result.provenance.adapterVersion,
    sourceType: result.provenance.sourceType,
    sourceId: result.provenance.sourceId,
    ...(result.provenance.sourceRevision
      ? { sourceRevision: result.provenance.sourceRevision }
      : {}),
    ...(result.provenance.mappingVersion
      ? { mappingVersion: result.provenance.mappingVersion }
      : {}),
    graphSha256: sha256(serializePublicationGraph(result.graph)),
    assetBundleSha256: sha256(serializeAssetBundle(result.assetBundle)),
    canonicalSubsetSha256: canonicalPublicationSubsetSha256(result),
  }
}

/**
 * Render the plan through the Vivliostyle renderer. The graph is created and
 * dropped here.
 *
 * The renderer persists the canonical Struct document, the Struct bundle
 * descriptor, the asset descriptor, the artifacts and the receipt. It never
 * persists the renderer plan.
 */
export async function renderPublicationPlan(
  plan: PublicationPlan,
  request: {
    outputDirectory: string
    profiles: readonly string[]
    routeParity:
      | 'astro-canonical-route'
      | 'not-applicable'
      | 'adapter-conformance'
  },
): Promise<PublicationReceipt> {
  const projection = projectPlan(plan.structDocument)
  const receipt = await vivliostyleRenderer.render(
    {
      graph: projection.graph,
      assetBundle: projection.assetBundle,
      diagnostics: plan.diagnostics,
      provenance: plan.provenance,
      structDocument: plan.structDocument,
      sourceBinding: plan.sourceBinding,
    },
    {
      outputDirectory: request.outputDirectory,
      profiles: request.profiles,
    },
  )
  return receipt as PublicationReceipt
}

// ---------------------------------------------------------------------------
// The plan-derived expectations of the rendered artifacts.
//
// The expectations are derived from the plan, so the checker never needs the
// renderer plan and never needs a graph symbol of its own.
// ---------------------------------------------------------------------------

function bodyText(value: unknown) {
  return String(value ?? '')
    .replace(/\s+/gu, ' ')
    .replaceAll('’', "'")
    .trim()
}

/**
 * The renderer plan's node as it is rendered for one profile.
 *
 * The renderer selects the profile variant of a node by replacing one field
 * of it and by keeping its identity, so the selection is the same node. The
 * facade uses the renderer's own selection, so the expectations it derives
 * match the rendered artifacts exactly.
 */
function selectForProfile(
  node: PublicationNode,
  profile: PublicationProfile,
): PublicationNode {
  return publicationNodeForProfile(node, profile) as unknown as PublicationNode
}

function nodeText(node: PublicationNode) {
  return 'text' in node ? bodyText(node.text) : ''
}

/**
 * The body fingerprint of the publication: the ordered semantic tokens of its
 * content. The canonical route is compared against it.
 */
function bodyFingerprint(graph: PublicationGraph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const nestedListIds = new Set(
    graph.nodes
      .filter((node) => node.type === 'list-item')
      .flatMap((node) => node.childListIds ?? []),
  )
  const fingerprint: string[] = []
  const captionToken = (captionId: string | undefined, tag = 'figcaption') => {
    const caption = captionId ? byId.get(captionId) : undefined
    if (caption?.type === 'caption')
      fingerprint.push(`${tag}:${nodeText(caption)}`)
  }
  const visit = (node: PublicationNode) => {
    switch (node.type) {
      case 'heading':
        fingerprint.push(`h${node.level}:${nodeText(node)}`)
        break
      case 'paragraph':
        fingerprint.push(`p:${nodeText(node)}`)
        break
      case 'list':
        fingerprint.push(node.ordered ? 'ol' : 'ul')
        for (const itemId of node.itemIds) {
          const item = byId.get(itemId)
          if (!item || item.type !== 'list-item') continue
          fingerprint.push(`li:${nodeText(item)}`)
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
          `blockquote:${bodyText(
            [node.text, node.attribution].filter(Boolean).join(' '),
          )}`,
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
            fingerprint.push(
              `${cell.headerScope ? 'th' : 'td'}:${bodyText(cell.text)}`,
            )
        break
      case 'equation':
        fingerprint.push(
          `math:${bodyText([node.source, node.label].filter(Boolean).join(' '))}`,
        )
        captionToken(node.captionId)
        break
      case 'aside':
        fingerprint.push(`aside:${nodeText(node)}`)
        break
      case 'note':
        fingerprint.push(
          `aside:${node.noteKind}:${bodyText(
            [node.label, node.text].join(' '),
          )}`,
        )
        break
      case 'reference':
        fingerprint.push(`p:doc-biblioentry:${nodeText(node)}`)
        break
      case 'caption':
        break
      case 'figure':
        if (node.assetIds.length === 0 && node.sourceText)
          fingerprint.push(
            `figure:${bodyText([node.title, node.sourceText].join(' '))}`,
          )
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
    if (
      node.type === 'list-item' ||
      nestedListIds.has(node.id) ||
      node.type === 'caption'
    )
      continue
    visit(node)
  }
  return fingerprint
}

/** The text fragments a rendered node must carry. */
function requiredNodeText(node: PublicationNode): string[] {
  const texts = (values: (string | undefined)[]) =>
    values.filter((value): value is string => typeof value === 'string')
  switch (node.type) {
    case 'heading':
    case 'paragraph':
    case 'list-item':
    case 'quote':
    case 'caption':
    case 'aside':
    case 'reference':
    case 'note':
      return node.text ? [node.text] : []
    case 'code':
      return [node.code]
    case 'figure':
      return texts([node.title, node.sourceText])
    case 'table':
      return node.rows.flatMap((row) => row.cells.map((cell) => cell.text))
    case 'equation':
      return texts([node.source, node.label])
    default:
      return []
  }
}

/** The required node ids, in the order they are rendered. */
function requiredNodeOrder(graph: PublicationGraph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const required = (node: PublicationNode | undefined) =>
    Boolean(node) && node?.requirement !== 'optional'
  const nestedListIds = new Set(
    graph.nodes
      .filter((node) => node.type === 'list-item')
      .flatMap((node) => node.childListIds ?? []),
  )
  const result: string[] = []
  const visited = new Set<string>()
  const append = (node: PublicationNode | undefined) => {
    if (!node || visited.has(node.id)) return
    visited.add(node.id)
    if (required(node)) result.push(node.id)
    if ('captionId' in node && node.captionId) append(byId.get(node.captionId))
    if (node.type !== 'list') return
    for (const itemId of node.itemIds ?? []) {
      const item = byId.get(itemId)
      append(item)
      const childListIds =
        item?.type === 'list-item' ? item.childListIds ?? [] : []
      for (const childListId of childListIds) append(byId.get(childListId))
    }
  }
  for (const node of graph.nodes) {
    if (visited.has(node.id)) continue
    if (node.type === 'caption') {
      const parent = byId.get(node.parentId)
      if (parent && 'captionId' in parent && parent.captionId === node.id)
        continue
    }
    if (node.type === 'list' && nestedListIds.has(node.id)) continue
    if (
      node.type === 'list-item' &&
      byId.get(node.parentListId)?.type === 'list'
    )
      continue
    append(node)
  }
  return result
}

function alternativeTextOf(node: PublicationNode) {
  if (node.type !== 'figure' && node.type !== 'media') return ''
  return (
    [
      node.accessibility.alternativeText,
      node.accessibility.longDescription,
      node.accessibility.transcript,
    ].find((value) => typeof value === 'string' && value.trim()) ?? ''
  )
}

function nodeExpectation(
  node: PublicationNode,
): PublicationPlanNodeExpectation {
  const base = {
    id: node.id,
    texts: requiredNodeText(node),
    alternativeText: alternativeTextOf(node),
  }
  if (node.type === 'heading')
    return {
      ...base,
      tag: `h${node.level}`,
      assetIds: [],
      sourceText: undefined,
      mediaKind: undefined,
      decorative: undefined,
    }
  if (node.type === 'figure')
    return {
      ...base,
      tag: 'figure',
      assetIds: [...node.assetIds],
      sourceText: node.sourceText,
      mediaKind: undefined,
      decorative: undefined,
    }
  if (node.type === 'media')
    return {
      ...base,
      tag: 'figure',
      assetIds: node.assetId ? [node.assetId] : [],
      sourceText: undefined,
      mediaKind: node.mediaKind,
      decorative: node.accessibility.decorative,
    }
  return {
    ...base,
    tag: undefined,
    assetIds: [],
    sourceText: undefined,
    mediaKind: undefined,
    decorative: undefined,
  }
}

/** The texts the PDF of a profile must preserve. */
function pdfTextRequirements(
  graph: PublicationGraph,
  profile: PublicationProfile,
): string[] {
  const required: string[] = []
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) required.push(value)
  }
  add(graph.metadata.title)
  add(graph.metadata.subtitle)
  add(graph.metadata.abstract)
  for (const contributor of graph.metadata.contributors ?? [])
    add(contributor)
  let titleHeadingHeaderPending = true
  for (const node of graph.nodes) {
    const selected = selectForProfile(node, profile)
    if (
      selected.type === 'heading' &&
      selected.level === 1 &&
      selected.text === graph.metadata.title
    ) {
      if (titleHeadingHeaderPending) {
        titleHeadingHeaderPending = false
        continue
      }
    }
    if ('text' in selected) add(selected.text)
    switch (selected.type) {
      case 'quote':
        add(selected.attribution)
        break
      case 'code':
        add(selected.code)
        break
      case 'figure':
        add(selected.title)
        add(selected.sourceText)
        break
      case 'table':
        for (const row of selected.rows)
          for (const cell of row.cells) add(cell.text)
        break
      case 'equation':
        add(selected.source)
        add(selected.label)
        break
      case 'note':
        add(selected.label)
        break
      case 'media':
        if (!selected.accessibility.decorative)
          add(selected.accessibility.transcript)
        break
      default:
        break
    }
  }
  return required
}

/** The texts the PDF of a profile must not orphan. */
function pdfWidowOrphanRequirements(
  graph: PublicationGraph,
  profile: PublicationProfile,
): string[] {
  const required: string[] = []
  for (const node of graph.nodes) {
    const selected = selectForProfile(node, profile)
    if (selected.requirement === 'optional') continue
    if (
      selected.type === 'paragraph' ||
      selected.type === 'list-item' ||
      selected.type === 'quote' ||
      selected.type === 'aside'
    ) {
      if (selected.text.trim()) required.push(selected.text)
    }
  }
  return required
}

/** The link targets the PDF of a profile must carry. */
function pdfLinkRequirements(
  graph: PublicationGraph,
  profile: PublicationProfile,
): string[] {
  const links: string[] = []
  for (const node of graph.nodes) {
    const selected = selectForProfile(node, profile)
    const runs = 'inlineRuns' in selected ? selected.inlineRuns ?? [] : []
    if (
      'text' in selected &&
      typeof selected.text === 'string' &&
      runs.every(
        (run) => Number.isInteger(run.start) && Number.isInteger(run.end),
      )
    ) {
      links.push(...publicationInlineLinkTargets(selected.text, runs))
    } else {
      for (const run of runs) {
        if (run.href) links.push(run.href)
        else if (
          (run.semanticRole === 'citation' ||
            run.semanticRole === 'cross-reference') &&
          run.targetIds?.length
        )
          links.push(`#${run.targetIds[0]}`)
      }
    }
    if (selected.type === 'reference' && selected.href) links.push(selected.href)
  }
  return links
}

/** The asset ids the PDF of a profile must render. */
function pdfImageAssetIds(
  graph: PublicationGraph,
  profile: PublicationProfile,
): string[] {
  const assetIds: string[] = []
  const seen = new Set<string>()
  for (const original of graph.nodes ?? []) {
    const node = selectForProfile(original, profile)
    if (node.requirement === 'optional') continue
    const renderedAssetIds =
      node.type === 'figure' && node.assetIds.length > 0
        ? node.assetIds
        : node.type === 'media' && node.mediaKind === 'image'
          ? [node.assetId]
          : []
    for (const assetId of renderedAssetIds) {
      if (seen.has(assetId)) continue
      seen.add(assetId)
      assetIds.push(assetId)
    }
  }
  return assetIds
}

function profileExpectations(
  graph: PublicationGraph,
  profile: PublicationProfile,
): PublicationPlanProfileExpectations {
  const nodes = graph.nodes
    .filter((node) => node.requirement !== 'optional')
    .map((node) => nodeExpectation(selectForProfile(node, profile)))
  const linkRequirements = pdfLinkRequirements(graph, profile)
  return {
    nodeOrder: requiredNodeOrder(graph),
    nodes,
    pdfTextRequirements: pdfTextRequirements(graph, profile),
    pdfWidowOrphanTexts: pdfWidowOrphanRequirements(graph, profile),
    pdfLinkRequirements: linkRequirements,
    pdfImageAssetIds: pdfImageAssetIds(graph, profile),
    pdfRequiresLinks: linkRequirements.length > 0,
  }
}

/**
 * The expectations of the rendered artifacts, derived from the plan.
 *
 * The checker compares the rendered artifacts against these expectations, so
 * it never needs the renderer plan and never needs a graph symbol.
 */
export function publicationPlanExpectations(
  plan: PublicationPlan,
): PublicationPlanExpectations {
  const projection = projectPlan(plan.structDocument)
  const { graph } = projection
  const headings = graph.nodes
    .filter(
      (node): node is Extract<PublicationNode, { type: 'heading' }> =>
        node.type === 'heading',
    )
    .map((node) => node.text)
  const imageNodes = graph.nodes.filter(
    (node): node is
      | Extract<PublicationNode, { type: 'figure' }>
      | Extract<PublicationNode, { type: 'media' }> =>
      (node.type === 'figure' && node.assetIds.length > 0) ||
      (node.type === 'media' && node.mediaKind === 'image'),
  )
  const imageBindings: PublicationPlanImageBinding[] = imageNodes.map((node) => {
    const assetId =
      node.type === 'figure'
        ? node.assetIds[0]
        : node.type === 'media'
          ? node.assetId
          : undefined
    if (!assetId)
      throw new Error('Publication plan image node carries no asset')
    const descriptor = plan.assetBundle.descriptor.assets.find(
      (asset) => asset.id === assetId,
    )
    if (!descriptor)
      throw new Error(`Publication plan image asset is missing: ${assetId}`)
    return {
      assetId,
      fileName: descriptor.fileName,
      sha256: descriptor.sha256,
      alternativeText: alternativeTextOf(node),
    }
  })
  return {
    title: graph.metadata.title,
    locale: graph.edition.locale,
    publicationId: graph.id,
    headingOrder: headings,
    bodyOrder: bodyFingerprint(graph),
    localImageAlternatives: imageBindings
      .map((binding) => binding.alternativeText)
      .filter(Boolean),
    imageBindings,
    profiles: {
      'phone-webpub': profileExpectations(graph, 'phone-webpub'),
      'eink-epub': profileExpectations(graph, 'eink-epub'),
      'a5-pdf': profileExpectations(graph, 'a5-pdf'),
      'a4-pdf': profileExpectations(graph, 'a4-pdf'),
    },
  }
}

// ---------------------------------------------------------------------------
// The canonical route parity, computed from the plan.
// ---------------------------------------------------------------------------

type RouteElement = {
  tagName?: string
  nodeName?: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: RouteElement[]
}

function routeTextContent(node: RouteElement): string {
  if (node.nodeName === '#text') return node.value ?? ''
  return (node.childNodes ?? []).map(routeTextContent).join('')
}

function routeAttribute(node: RouteElement, name: string) {
  return node.attrs?.find((value) => value.name === name)?.value
}

function routeTagName(node: RouteElement) {
  return node.tagName
}

function routeDirectBodyText(
  node: RouteElement,
  excludedTags: Set<string>,
): string {
  if (!node) return ''
  if (node.nodeName === '#text') return node.value ?? ''
  if (node.tagName && excludedTags.has(node.tagName)) return ''
  return (node.childNodes ?? [])
    .map((child) => routeDirectBodyText(child, excludedTags))
    .join('')
}

function routeFindTag(
  root: RouteElement | undefined,
  tagName: string,
): RouteElement | undefined {
  if (!root) return undefined
  if (root.tagName === tagName) return root
  for (const child of root.childNodes ?? []) {
    const found = routeFindTag(child, tagName)
    if (found) return found
  }
  return undefined
}

function routeFindWithAttribute(
  root: RouteElement,
  name: string,
): RouteElement | undefined {
  if (root.attrs?.some((candidate) => candidate.name === name)) return root
  for (const child of root.childNodes ?? []) {
    const found = routeFindWithAttribute(child, name)
    if (found) return found
  }
  return undefined
}

function routeRootOf(html: string): RouteElement | undefined {
  const document = parse(html) as unknown as RouteElement
  return (
    routeFindWithAttribute(document, 'data-post-content') ??
    routeFindTag(document, 'article') ??
    routeFindTag(document, 'main')
  )
}

/** The headings and the images of a canonical route document. */
export function collectRouteElements(html: string) {
  const result: {
    headings: string[]
    images: { src?: string; alt?: string }[]
  } = { headings: [], images: [] }
  const visit = (node: RouteElement) => {
    if (node.tagName && /^h[1-6]$/u.test(node.tagName))
      result.headings.push(routeTextContent(node).trim())
    if (node.tagName === 'img') {
      const attributes = Object.fromEntries(
        (node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]),
      )
      result.images.push({ src: attributes.src, alt: attributes.alt })
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(parse(html) as unknown as RouteElement)
  return result
}

/**
 * The body fingerprint of a canonical route document.
 *
 * The fingerprint is the ordered semantic tokens of the rendered route, and it
 * is compared against the fingerprint the plan derives.
 */
export function canonicalRouteBodyFingerprint(html: string): string[] {
  const fingerprint: string[] = []
  const visit = (node: RouteElement) => {
    const tag = node.tagName
    if (!tag) {
      for (const child of node.childNodes ?? []) visit(child)
      return
    }
    if (/^h[1-6]$/u.test(tag)) {
      fingerprint.push(`${tag}:${bodyText(routeTextContent(node))}`)
      return
    }
    if (tag === 'p') {
      const images: RouteElement[] = []
      const collectImages = (candidate: RouteElement) => {
        if (candidate.tagName === 'img') images.push(candidate)
        for (const child of candidate.childNodes ?? []) collectImages(child)
      }
      collectImages(node)
      if (images.length && !routeTextContent(node).trim()) {
        for (const image of images) {
          const title = routeAttribute(image, 'title')
          if (title) fingerprint.push(`figcaption:${bodyText(title)}`)
        }
        return
      }
      const role = routeAttribute(node, 'role')
      fingerprint.push(
        role === 'doc-biblioentry'
          ? `p:doc-biblioentry:${bodyText(routeTextContent(node))}`
          : `p:${bodyText(routeTextContent(node))}`,
      )
      return
    }
    if (tag === 'blockquote') {
      fingerprint.push(`blockquote:${bodyText(routeTextContent(node))}`)
      return
    }
    if (tag === 'pre') {
      fingerprint.push(`pre:${bodyText(routeTextContent(node))}`)
      return
    }
    if (tag === 'img') {
      const title = routeAttribute(node, 'title')
      if (title) fingerprint.push(`figcaption:${bodyText(title)}`)
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      fingerprint.push(tag)
      for (const child of node.childNodes ?? [])
        if (routeTagName(child) === 'li') visit(child)
      return
    }
    if (tag === 'li') {
      fingerprint.push(
        `li:${bodyText(routeDirectBodyText(node, new Set(['ul', 'ol'])))}`,
      )
      for (const child of node.childNodes ?? [])
        if (routeTagName(child) === 'ul' || routeTagName(child) === 'ol')
          visit(child)
      return
    }
    if (tag === 'table') {
      fingerprint.push('table')
      for (const child of node.childNodes ?? []) visit(child)
      return
    }
    if (tag === 'caption') {
      fingerprint.push(`caption:${bodyText(routeTextContent(node))}`)
      return
    }
    if (tag === 'th' || tag === 'td') {
      fingerprint.push(`${tag}:${bodyText(routeTextContent(node))}`)
      return
    }
    if (routeAttribute(node, 'role') === 'math') {
      fingerprint.push(`math:${bodyText(routeTextContent(node))}`)
      return
    }
    if (tag === 'aside') {
      const role = routeAttribute(node, 'role')
      const prefix = role?.startsWith('doc-') ? `aside:${role}:` : 'aside:'
      fingerprint.push(`${prefix}${bodyText(routeTextContent(node))}`)
      return
    }
    if (tag === 'figcaption') {
      fingerprint.push(`figcaption:${bodyText(routeTextContent(node))}`)
      return
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  const root = routeRootOf(html)
  if (root) visit(root)
  return fingerprint
}

function assetStem(fileName: string | undefined) {
  return (fileName ?? '')
    .replace(/\.[^.]*$/u, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, '')
}

function isLocalRouteAsset(src: string | undefined) {
  return Boolean(src) && !/^[a-z][a-z\d+.-]*:/iu.test(String(src))
}

/**
 * Consume the canonical route image that matches the publication image.
 *
 * The matches are consumed one to one, so a repeated alternative text is
 * bound to its own route image.
 */
export function consumeRouteImageIndex(
  images: readonly { src?: string; alt?: string }[],
  usedIndexes: Set<number>,
  alternativeText: string,
  stem: string,
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

/** The request of the canonical route parity writer. */
export type RouteParityRequest = {
  /** The canonical route entry, for example a blog entry id. */
  readonly entry: string
  /** The directory the parity payload is written into. */
  readonly output: string
  /** The repository facts the payload is bound to. */
  readonly repository?: { commit: string; dirty: boolean }
}

async function routeImageDigest(
  routePath: string,
  src: string | undefined,
  assetId: string,
) {
  const rawSrc = String(src ?? '').split(/[?#]/u)[0]
  if (!isLocalRouteAsset(rawSrc) || !rawSrc)
    throw new Error(`Canonical Astro route image is not local for ${assetId}`)
  const routeRoot = resolve('dist')
  const candidate = isAbsolute(rawSrc)
    ? resolve(routeRoot, rawSrc.replace(/^[/\\]+/u, ''))
    : resolve(dirname(routePath), rawSrc)
  const escaped = relative(routeRoot, candidate).split(sep).join('/')
  if (escaped.startsWith('../') || isAbsolute(escaped))
    throw new Error(`Canonical Astro route image escapes dist for ${assetId}`)
  return sha256(await readFile(candidate))
}

/**
 * Write the canonical route parity payload from the plan.
 *
 * The heading order, the body fingerprint and the image bindings are derived
 * from the plan, so the parity payload never depends on a graph the CLI can
 * see. The payload keeps its current keys: the Struct-derived digest
 * replaces the graph digest as the source identity, and the graph digest
 * stays as a diagnostic field.
 */
export async function writeRouteParityFromPlan(
  plan: PublicationPlan,
  request: RouteParityRequest,
): Promise<void> {
  const expectations = publicationPlanExpectations(plan)
  const routePath = resolve('dist/blog', request.entry, 'index.html')
  let html: string
  try {
    html = await readFile(routePath, 'utf8')
  } catch {
    throw new Error(
      `Canonical Astro route is unavailable at ${routePath}; run the normal Astro build before publication:build`,
    )
  }
  const route = collectRouteElements(html)
  let cursor = 0
  for (const heading of expectations.headingOrder) {
    const index = route.headings.indexOf(heading, cursor)
    if (index < 0)
      throw new Error(
        `Canonical Astro route is missing publication heading: ${heading}`,
      )
    cursor = index + 1
  }
  const routeBody = canonicalRouteBodyFingerprint(html)
  if (JSON.stringify(expectations.bodyOrder) !== JSON.stringify(routeBody))
    throw new Error(
      'Canonical Astro route body semantics differ from the publication plan',
    )
  const usedRouteImageIndexes = new Set<number>()
  const imageBindings = []
  for (const binding of expectations.imageBindings) {
    const imageIndex = consumeRouteImageIndex(
      route.images,
      usedRouteImageIndexes,
      binding.alternativeText,
      assetStem(binding.fileName),
    )
    const image = imageIndex >= 0 ? route.images[imageIndex] : undefined
    if (!image)
      throw new Error(
        `Canonical Astro route is missing local image asset for ${binding.assetId}`,
      )
    imageBindings.push({
      assetId: binding.assetId,
      fileName: binding.fileName,
      sha256: binding.sha256,
      routeSrc: image.src,
      routeSha256: await routeImageDigest(routePath, image.src, binding.assetId),
      alternativeText: binding.alternativeText,
    })
  }
  const publicationReceipt = await readFile(
    resolve(request.output, 'publication-receipt.json'),
  )
  await writeFile(
    resolve(request.output, 'astro-route-parity.json'),
    `${JSON.stringify(
      {
        version: '1.0.0',
        canonicalRoute: `/blog/${request.entry}`,
        structDocumentSha256: plan.structDocumentSha256,
        sourceBinding: plan.sourceBinding,
        graphSha256: publicationPlanDiagnosticGraphSha256(plan),
        assetBundleSha256: sha256(serializeAssetBundle(plan.assetBundle)),
        publicationReceiptSha256: sha256(publicationReceipt),
        repositoryCommit: request.repository?.commit,
        repositoryDirty: request.repository?.dirty,
        routeHtmlSha256: sha256(html),
        headingOrder: expectations.headingOrder,
        bodyOrder: expectations.bodyOrder,
        localImageAlternatives: expectations.localImageAlternatives,
        imageBindings,
        result: 'passed',
      },
      null,
      2,
    )}\n`,
    // Exclusive creation inside the invocation-owned staging directory.
    { flag: 'wx' },
  )
}
