import { sha256HexSync } from './sha256-sync.ts'

export const PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION = '1.0.0' as const

export const PDF_EVIDENCE_OBSERVATION_CATEGORIES = [
  'text-exactness',
  'reading-order',
  'hierarchy',
  'object-counts',
  'table-cells',
  'table-spans',
  'table-headers',
  'figures',
  'diagrams',
  'captions',
  'formulas',
  'code-preformatted',
  'notes',
  'citations',
  'links',
  'asset-bytes',
  'clipping',
  'overflow',
  'dangling-targets',
] as const

export type PdfEvidenceObservationCategory =
  (typeof PDF_EVIDENCE_OBSERVATION_CATEGORIES)[number]
export const SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION = '1.0.0' as const
export const DETERMINISTIC_CONTEXT_RECEIPT_SCHEMA_VERSION = '1.0.0' as const
export const REQUIRED_PDF_EVIDENCE_ARMS = ['deterministic', 'mineru'] as const

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const ID_PATTERN = /^[^\u0000-\u001f\u007f]+$/u
const BOX_EPSILON = 1e-9

export type PdfEvidenceJsonValue =
  | null
  | boolean
  | number
  | string
  | PdfEvidenceJsonValue[]
  | { [key: string]: PdfEvidenceJsonValue }

export type PdfEvidenceSourceIdentity = {
  documentId: string
  sha256: string
  byteLength: number
  pageCount: number
}

export type PdfEvidenceProviderKind =
  'pdfjs' | 'mineru' | 'ocr' | 'local-codex' | 'other'

export type PdfEvidenceProviderModelIdentity = {
  id: string
  revision: string
  digestSha256?: string
  license?: string
  architecture?: string
}

export type PdfEvidenceProviderExecutionIdentity = {
  hostClass: 'owner-laptop' | 'trusted-vm'
  operatingSystem: string
  architecture: string
  runtime: string
  backend: string
  backendVersion: string
  runtimeSha256: string
  backendSha256: string
  packageSetSha256: string
  cacheNamespaceSha256: string
  networkIsolation:
    | 'macos-sandbox-exec-deny-network-v1'
    | 'linux-user-netns-loopback-only-v1'
  networkIsolationSha256: string
}

export type PdfEvidenceProviderIdentity = {
  id: string
  kind: PdfEvidenceProviderKind
  name: string
  version: string
  implementationSha256?: string
  model?: PdfEvidenceProviderModelIdentity
  execution?: PdfEvidenceProviderExecutionIdentity
}

/** A page-normalized source box. Coordinates and extents are in [0, 1]. */
export type PdfEvidenceBox = {
  page: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
  method: 'pdf-text' | 'pdf-object' | 'pdf-link' | 'ocr'
}

export type PdfEvidencePageGeometry = {
  page: number
  width: number
  height: number
  rotation: number
}

export type PdfEvidenceArtifact = {
  id: string
  providerId: string
  kind: string
  mediaType: string
  sha256: string
  byteLength: number
  page?: number
  box?: PdfEvidenceBox
  sourceIds?: string[]
}

/**
 * A provider-native source item. Candidates cite these records instead of
 * copying source text, bytes, geometry, or destinations into an answer.
 */
export type PdfEvidenceSource = {
  id: string
  providerId: string
  kind: string
  page?: number
  box?: PdfEvidenceBox
  artifactIds?: string[]
  parentSourceIds?: string[]
  payload?: PdfEvidenceJsonValue
}

/** A selectable interpretation backed by one or more provider source items. */
export type PdfEvidenceCandidate = {
  id: string
  providerId: string
  kind: string
  page?: number
  boxes?: PdfEvidenceBox[]
  sourceIds: string[]
  artifactIds?: string[]
  payload?: PdfEvidenceJsonValue
}

export type PdfEvidenceBundle = {
  schemaVersion: typeof PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION
  id: string
  armId: string
  source: PdfEvidenceSourceIdentity
  provider: PdfEvidenceProviderIdentity
  pages: PdfEvidencePageGeometry[]
  artifacts: PdfEvidenceArtifact[]
  sources: PdfEvidenceSource[]
  candidates: PdfEvidenceCandidate[]
}

export type PdfEvidenceArmState =
  | {
      id: string
      requirement: 'required' | 'optional'
      status: 'enabled'
      frozen: true
      providerId: string
    }
  | {
      id: string
      requirement: 'optional'
      status: 'disabled'
      frozen: true
      reason: string
    }

/** A source obligation may remain unclosed, but it may never dangle. */
export type PdfEvidenceObligation = {
  id: string
  kind: string
  page?: number
  sourceIds: string[]
  artifactIds: string[]
  candidateIds: string[]
  observationCategories: PdfEvidenceObservationCategory[]
  required: boolean
  semantic: boolean
}

/**
 * Disagreements are evidence, not resolutions. Selection belongs to a later
 * grounded verifier, so this record intentionally has no accepted candidate.
 */
export type PdfEvidenceDisagreement = {
  id: string
  kind: string
  obligationIds: string[]
  candidateIds: string[]
  providerIds: string[]
  reason: string
}

/**
 * Hashes the exact normalized deterministic arm, not just its caller-chosen
 * IDs. This binds page geometry, source text/payloads, bounds, assets, and
 * candidates to the graph source identity before another arm is reconciled.
 */
export type PdfDeterministicContextReceipt = {
  schemaVersion: typeof DETERMINISTIC_CONTEXT_RECEIPT_SCHEMA_VERSION
  sourceIdentitySha256: string
  pageSetSha256: string
  pageCount: number
  sourceSetSha256: string
  sourceCount: number
  artifactSetSha256: string
  artifactCount: number
  candidateSetSha256: string
  candidateCount: number
  contextSha256: string
}

export type SourceEvidenceGraph = {
  schemaVersion: typeof SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION
  source: PdfEvidenceSourceIdentity
  deterministicContext: PdfDeterministicContextReceipt
  arms: PdfEvidenceArmState[]
  bundles: PdfEvidenceBundle[]
  obligations: PdfEvidenceObligation[]
  disagreements: PdfEvidenceDisagreement[]
  graphSha256: string
}

export type SourceEvidenceGraphInput = Omit<SourceEvidenceGraph, 'graphSha256'>

export type PdfEvidencePageView = {
  bundleId: string
  providerId: string
  geometry: PdfEvidencePageGeometry
}

export type SourceEvidenceGraphReader = {
  readonly graph: SourceEvidenceGraph
  readonly source: PdfEvidenceSourceIdentity
  readonly graphSha256: string
  provider(id: string): PdfEvidenceProviderIdentity | undefined
  sourceItem(id: string): PdfEvidenceSource | undefined
  artifact(id: string): PdfEvidenceArtifact | undefined
  candidate(id: string): PdfEvidenceCandidate | undefined
  obligation(id: string): PdfEvidenceObligation | undefined
  disagreement(id: string): PdfEvidenceDisagreement | undefined
  page(page: number): readonly PdfEvidencePageView[]
  allCandidates(): readonly PdfEvidenceCandidate[]
  candidatesForObligation(id: string): readonly PdfEvidenceCandidate[]
  candidateSetSha256(candidateIds?: readonly string[]): string
}

function fail(message: string): never {
  throw new Error(`Invalid source evidence graph: ${message}`)
}

function assertRecord(value: unknown, label: string): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object`)
  }
}

function assertAllowedKeys(
  value: object,
  allowedKeys: readonly string[],
  label: string,
) {
  const allowed = new Set(allowedKeys)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail(`${label} contains unsupported field ${String(key)}`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      fail(`${label}.${key} must be an enumerable data property`)
    }
  }
}

function assertPlainArray(
  value: unknown,
  label: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${label} must not contain holes`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue
    if (
      typeof key !== 'string' ||
      !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
      Number(key) >= value.length
    ) {
      fail(`${label} contains unsupported field ${String(key)}`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      fail(`${label}[${key}] must be an enumerable data property`)
    }
  }
}

function assertId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    !ID_PATTERN.test(value)
  ) {
    fail(`${label} must be a non-empty identifier without control characters`)
  }
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`)
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`)
  }
}

function assertFiniteNumber(
  value: unknown,
  label: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${label} must be a finite number`)
  }
}

function assertNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`)
  }
}

function assertPageNumber(value: unknown, pageCount: number, label: string) {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > pageCount
  ) {
    fail(`${label} must be an integer between 1 and ${pageCount}`)
  }
}

function assertStringArray(
  value: unknown,
  label: string,
  options: { nonEmpty?: boolean } = {},
): asserts value is string[] {
  assertPlainArray(value, label)
  if (options.nonEmpty && value.length === 0)
    fail(`${label} must be a non-empty array`)
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    assertId(item, `${label}[${index}]`)
    if (seen.has(item)) fail(`${label} contains duplicate id ${item}`)
    seen.add(item)
  }
}

function assertJsonValue(
  value: unknown,
  label: string,
  seen = new Set<object>(),
) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`)
    return
  }
  if (!value || typeof value !== 'object') {
    fail(`${label} must contain only JSON values`)
  }
  if (seen.has(value)) fail(`${label} must not contain a cycle`)
  seen.add(value)
  if (Array.isArray(value)) {
    assertPlainArray(value, label)
    value.forEach((item, index) =>
      assertJsonValue(item, `${label}[${index}]`, seen),
    )
  } else {
    assertRecord(value, label)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        fail(`${label} contains unsupported field ${String(key)}`)
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        fail(`${label}.${key} must be an enumerable data property`)
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (key.length === 0) fail(`${label} contains an empty object key`)
      assertJsonValue(item, `${label}.${key}`, seen)
    }
  }
  seen.delete(value)
}

function assertSourceIdentity(
  source: unknown,
  label: string,
): asserts source is PdfEvidenceSourceIdentity {
  assertRecord(source, label)
  assertAllowedKeys(
    source,
    ['documentId', 'sha256', 'byteLength', 'pageCount'],
    label,
  )
  const candidate = source as Partial<PdfEvidenceSourceIdentity>
  assertId(candidate.documentId, `${label}.documentId`)
  assertSha256(candidate.sha256, `${label}.sha256`)
  assertNonNegativeInteger(candidate.byteLength, `${label}.byteLength`)
  if (candidate.byteLength === 0) fail(`${label}.byteLength must be positive`)
  assertNonNegativeInteger(candidate.pageCount, `${label}.pageCount`)
  if (candidate.pageCount === 0) fail(`${label}.pageCount must be positive`)
}

function sameSource(
  left: PdfEvidenceSourceIdentity,
  right: PdfEvidenceSourceIdentity,
) {
  return (
    left.documentId === right.documentId &&
    left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength &&
    left.pageCount === right.pageCount
  )
}

function assertProviderIdentity(
  provider: unknown,
  label: string,
): asserts provider is PdfEvidenceProviderIdentity {
  assertRecord(provider, label)
  assertAllowedKeys(
    provider,
    [
      'id',
      'kind',
      'name',
      'version',
      'implementationSha256',
      'model',
      'execution',
    ],
    label,
  )
  const candidate = provider as Partial<PdfEvidenceProviderIdentity>
  assertId(candidate.id, `${label}.id`)
  if (
    candidate.kind !== 'pdfjs' &&
    candidate.kind !== 'mineru' &&
    candidate.kind !== 'ocr' &&
    candidate.kind !== 'local-codex' &&
    candidate.kind !== 'other'
  ) {
    fail(`${label}.kind is unsupported`)
  }
  assertNonEmptyString(candidate.name, `${label}.name`)
  assertNonEmptyString(candidate.version, `${label}.version`)
  if (candidate.implementationSha256 !== undefined) {
    assertSha256(
      candidate.implementationSha256,
      `${label}.implementationSha256`,
    )
  }
  if (candidate.model !== undefined) {
    assertRecord(candidate.model, `${label}.model`)
    assertAllowedKeys(
      candidate.model,
      ['id', 'revision', 'digestSha256', 'license', 'architecture'],
      `${label}.model`,
    )
    assertNonEmptyString(candidate.model.id, `${label}.model.id`)
    assertNonEmptyString(candidate.model.revision, `${label}.model.revision`)
    if (candidate.model.digestSha256 !== undefined) {
      assertSha256(candidate.model.digestSha256, `${label}.model.digestSha256`)
    }
    if (candidate.model.license !== undefined) {
      assertNonEmptyString(candidate.model.license, `${label}.model.license`)
    }
    if (candidate.model.architecture !== undefined) {
      assertNonEmptyString(
        candidate.model.architecture,
        `${label}.model.architecture`,
      )
    }
  }
  if (candidate.execution !== undefined) {
    const executionLabel = `${label}.execution`
    assertRecord(candidate.execution, executionLabel)
    assertAllowedKeys(
      candidate.execution,
      [
        'hostClass',
        'operatingSystem',
        'architecture',
        'runtime',
        'backend',
        'backendVersion',
        'runtimeSha256',
        'backendSha256',
        'packageSetSha256',
        'cacheNamespaceSha256',
        'networkIsolation',
        'networkIsolationSha256',
      ],
      executionLabel,
    )
    if (
      candidate.execution.hostClass !== 'owner-laptop' &&
      candidate.execution.hostClass !== 'trusted-vm'
    ) {
      fail(`${executionLabel}.hostClass is unsupported`)
    }
    for (const key of [
      'operatingSystem',
      'architecture',
      'runtime',
      'backend',
      'backendVersion',
    ] as const) {
      assertNonEmptyString(candidate.execution[key], `${executionLabel}.${key}`)
    }
    for (const key of [
      'runtimeSha256',
      'backendSha256',
      'packageSetSha256',
      'cacheNamespaceSha256',
      'networkIsolationSha256',
    ] as const) {
      assertSha256(candidate.execution[key], `${executionLabel}.${key}`)
    }
    if (
      candidate.execution.networkIsolation !==
        'macos-sandbox-exec-deny-network-v1' &&
      candidate.execution.networkIsolation !==
        'linux-user-netns-loopback-only-v1'
    ) {
      fail(`${executionLabel}.networkIsolation is unsupported`)
    }
  }
}

function assertBox(box: unknown, pageCount: number, label: string) {
  assertRecord(box, label)
  assertAllowedKeys(
    box,
    ['page', 'x', 'y', 'width', 'height', 'rotation', 'method'],
    label,
  )
  const candidate = box as Partial<PdfEvidenceBox>
  assertPageNumber(candidate.page, pageCount, `${label}.page`)
  for (const key of ['x', 'y', 'width', 'height', 'rotation'] as const) {
    assertFiniteNumber(candidate[key], `${label}.${key}`)
  }
  if (candidate.x! < 0 || candidate.y! < 0) {
    fail(`${label} has a negative normalized origin`)
  }
  if (candidate.width! < 0 || candidate.height! < 0) {
    fail(`${label} has a negative extent`)
  }
  if (
    candidate.x! + candidate.width! > 1 + BOX_EPSILON ||
    candidate.y! + candidate.height! > 1 + BOX_EPSILON
  ) {
    fail(`${label} exceeds normalized page bounds`)
  }
  if (
    candidate.method !== 'pdf-text' &&
    candidate.method !== 'pdf-object' &&
    candidate.method !== 'pdf-link' &&
    candidate.method !== 'ocr'
  ) {
    fail(`${label}.method is unsupported`)
  }
}

function assertOptionalEntityPageAndBox(
  entity: { page?: number; box?: PdfEvidenceBox },
  pageCount: number,
  label: string,
) {
  if (entity.page !== undefined) {
    assertPageNumber(entity.page, pageCount, `${label}.page`)
  }
  if (entity.box !== undefined) {
    assertBox(entity.box, pageCount, `${label}.box`)
    if (entity.page === undefined) {
      fail(`${label}.page is required when box is present`)
    }
    if (entity.box.page !== entity.page) {
      fail(`${label}.box.page must equal ${label}.page`)
    }
  }
}

function assertUniqueIds<T extends { id: string }>(items: T[], label: string) {
  const seen = new Set<string>()
  for (const item of items) {
    assertId(item.id, `${label}.id`)
    if (seen.has(item.id)) fail(`duplicate ${label} id ${item.id}`)
    seen.add(item.id)
  }
}

function validateBundleShape(
  bundle: unknown,
): asserts bundle is PdfEvidenceBundle {
  assertRecord(bundle, 'bundle')
  assertAllowedKeys(
    bundle,
    [
      'schemaVersion',
      'id',
      'armId',
      'source',
      'provider',
      'pages',
      'artifacts',
      'sources',
      'candidates',
    ],
    'bundle',
  )
  const candidate = bundle as Partial<PdfEvidenceBundle>
  if (candidate.schemaVersion !== PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION) {
    fail(`bundle.schemaVersion must be ${PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION}`)
  }
  assertId(candidate.id, 'bundle.id')
  assertId(candidate.armId, 'bundle.armId')
  assertSourceIdentity(candidate.source, 'bundle.source')
  const pageCount = candidate.source.pageCount
  assertProviderIdentity(candidate.provider, 'bundle.provider')
  assertPlainArray(candidate.pages, 'bundle.pages')
  assertPlainArray(candidate.artifacts, 'bundle.artifacts')
  assertPlainArray(candidate.sources, 'bundle.sources')
  assertPlainArray(candidate.candidates, 'bundle.candidates')

  const pagesSeen = new Set<number>()
  for (const [index, page] of candidate.pages.entries()) {
    assertRecord(page, `bundle.pages[${index}]`)
    assertAllowedKeys(
      page,
      ['page', 'width', 'height', 'rotation'],
      `bundle.pages[${index}]`,
    )
    assertPageNumber(page.page, pageCount, `bundle.pages[${index}].page`)
    assertFiniteNumber(page.width, `bundle.pages[${index}].width`)
    assertFiniteNumber(page.height, `bundle.pages[${index}].height`)
    assertFiniteNumber(page.rotation, `bundle.pages[${index}].rotation`)
    if (page.width <= 0 || page.height <= 0) {
      fail(`bundle.pages[${index}] dimensions must be positive`)
    }
    if (!Number.isInteger(page.rotation) || page.rotation % 90 !== 0) {
      fail(`bundle.pages[${index}].rotation must be an integer multiple of 90`)
    }
    if (pagesSeen.has(page.page)) fail(`bundle has duplicate page ${page.page}`)
    pagesSeen.add(page.page)
  }
  if (pagesSeen.size !== pageCount) {
    fail('bundle.pages must contain every source page exactly once')
  }

  assertUniqueIds(candidate.artifacts, 'artifact')
  assertUniqueIds(candidate.sources, 'source')
  assertUniqueIds(candidate.candidates, 'candidate')

  for (const [index, artifact] of candidate.artifacts.entries()) {
    const label = `bundle.artifacts[${index}]`
    assertRecord(artifact, label)
    assertAllowedKeys(
      artifact,
      [
        'id',
        'providerId',
        'kind',
        'mediaType',
        'sha256',
        'byteLength',
        'page',
        'box',
        'sourceIds',
      ],
      label,
    )
    assertId(artifact.id, `${label}.id`)
    assertId(artifact.providerId, `${label}.providerId`)
    if (artifact.providerId !== candidate.provider.id) {
      fail(`${label}.providerId does not match bundle provider`)
    }
    assertNonEmptyString(artifact.kind, `${label}.kind`)
    assertNonEmptyString(artifact.mediaType, `${label}.mediaType`)
    assertSha256(artifact.sha256, `${label}.sha256`)
    assertNonNegativeInteger(artifact.byteLength, `${label}.byteLength`)
    assertOptionalEntityPageAndBox(artifact, pageCount, label)
    if (artifact.sourceIds !== undefined) {
      assertStringArray(artifact.sourceIds, `${label}.sourceIds`)
    }
  }

  for (const [index, source] of candidate.sources.entries()) {
    const label = `bundle.sources[${index}]`
    assertRecord(source, label)
    assertAllowedKeys(
      source,
      [
        'id',
        'providerId',
        'kind',
        'page',
        'box',
        'artifactIds',
        'parentSourceIds',
        'payload',
      ],
      label,
    )
    assertId(source.id, `${label}.id`)
    assertId(source.providerId, `${label}.providerId`)
    if (source.providerId !== candidate.provider.id) {
      fail(`${label}.providerId does not match bundle provider`)
    }
    assertNonEmptyString(source.kind, `${label}.kind`)
    assertOptionalEntityPageAndBox(source, pageCount, label)
    if (source.artifactIds !== undefined) {
      assertStringArray(source.artifactIds, `${label}.artifactIds`)
    }
    if (source.parentSourceIds !== undefined) {
      assertStringArray(source.parentSourceIds, `${label}.parentSourceIds`)
      if (source.parentSourceIds.includes(source.id)) {
        fail(`${label}.parentSourceIds must not contain itself`)
      }
    }
    if (source.payload !== undefined) {
      assertJsonValue(source.payload, `${label}.payload`)
    }
  }

  for (const [index, evidenceCandidate] of candidate.candidates.entries()) {
    const label = `bundle.candidates[${index}]`
    assertRecord(evidenceCandidate, label)
    assertAllowedKeys(
      evidenceCandidate,
      [
        'id',
        'providerId',
        'kind',
        'page',
        'boxes',
        'sourceIds',
        'artifactIds',
        'payload',
      ],
      label,
    )
    assertId(evidenceCandidate.id, `${label}.id`)
    assertId(evidenceCandidate.providerId, `${label}.providerId`)
    if (evidenceCandidate.providerId !== candidate.provider.id) {
      fail(`${label}.providerId does not match bundle provider`)
    }
    assertNonEmptyString(evidenceCandidate.kind, `${label}.kind`)
    if (evidenceCandidate.page !== undefined) {
      assertPageNumber(evidenceCandidate.page, pageCount, `${label}.page`)
    }
    if (evidenceCandidate.boxes !== undefined) {
      assertPlainArray(evidenceCandidate.boxes, `${label}.boxes`)
      if (evidenceCandidate.boxes.length === 0) {
        fail(`${label}.boxes must be a non-empty array when present`)
      }
      evidenceCandidate.boxes.forEach((box, boxIndex) => {
        assertBox(box, pageCount, `${label}.boxes[${boxIndex}]`)
      })
    }
    assertStringArray(evidenceCandidate.sourceIds, `${label}.sourceIds`, {
      nonEmpty: true,
    })
    if (evidenceCandidate.artifactIds !== undefined) {
      assertStringArray(evidenceCandidate.artifactIds, `${label}.artifactIds`)
    }
    if (evidenceCandidate.payload !== undefined) {
      assertJsonValue(evidenceCandidate.payload, `${label}.payload`)
    }
  }
}

function assertNoSourceCycles(sources: ReadonlyMap<string, PdfEvidenceSource>) {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string) => {
    if (visited.has(id)) return
    if (visiting.has(id)) fail(`source parent cycle includes ${id}`)
    visiting.add(id)
    for (const parentId of sources.get(id)?.parentSourceIds ?? [])
      visit(parentId)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of sources.keys()) visit(id)
}

function validateGraphShape(
  graph: unknown,
  options: { requireHash: boolean },
): asserts graph is SourceEvidenceGraph | SourceEvidenceGraphInput {
  assertRecord(graph, 'graph')
  assertAllowedKeys(
    graph,
    [
      'schemaVersion',
      'source',
      'deterministicContext',
      'arms',
      'bundles',
      'obligations',
      'disagreements',
      'graphSha256',
    ],
    'graph',
  )
  const candidate = graph as Partial<SourceEvidenceGraph>
  if (candidate.schemaVersion !== SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION) {
    fail(`graph.schemaVersion must be ${SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION}`)
  }
  assertSourceIdentity(candidate.source, 'graph.source')
  assertRecord(candidate.deterministicContext, 'graph.deterministicContext')
  assertAllowedKeys(
    candidate.deterministicContext,
    [
      'schemaVersion',
      'sourceIdentitySha256',
      'pageSetSha256',
      'pageCount',
      'sourceSetSha256',
      'sourceCount',
      'artifactSetSha256',
      'artifactCount',
      'candidateSetSha256',
      'candidateCount',
      'contextSha256',
    ],
    'graph.deterministicContext',
  )
  const deterministicContext =
    candidate.deterministicContext as Partial<PdfDeterministicContextReceipt>
  if (
    deterministicContext.schemaVersion !==
    DETERMINISTIC_CONTEXT_RECEIPT_SCHEMA_VERSION
  ) {
    fail(
      `graph.deterministicContext.schemaVersion must be ${DETERMINISTIC_CONTEXT_RECEIPT_SCHEMA_VERSION}`,
    )
  }
  for (const key of [
    'sourceIdentitySha256',
    'pageSetSha256',
    'sourceSetSha256',
    'artifactSetSha256',
    'candidateSetSha256',
    'contextSha256',
  ] as const) {
    assertSha256(deterministicContext[key], `graph.deterministicContext.${key}`)
  }
  for (const key of [
    'pageCount',
    'sourceCount',
    'artifactCount',
    'candidateCount',
  ] as const) {
    assertNonNegativeInteger(
      deterministicContext[key],
      `graph.deterministicContext.${key}`,
    )
  }
  assertPlainArray(candidate.arms, 'graph.arms')
  assertPlainArray(candidate.bundles, 'graph.bundles')
  assertPlainArray(candidate.obligations, 'graph.obligations')
  assertPlainArray(candidate.disagreements, 'graph.disagreements')
  if (options.requireHash)
    assertSha256(candidate.graphSha256, 'graph.graphSha256')

  assertUniqueIds(candidate.arms, 'arm')
  assertUniqueIds(candidate.bundles, 'bundle')
  assertUniqueIds(candidate.obligations, 'obligation')
  assertUniqueIds(candidate.disagreements, 'disagreement')

  const arms = new Map<string, PdfEvidenceArmState>()
  for (const [index, arm] of candidate.arms.entries()) {
    const label = `graph.arms[${index}]`
    assertRecord(arm, label)
    assertAllowedKeys(
      arm,
      ['id', 'requirement', 'status', 'frozen', 'providerId', 'reason'],
      label,
    )
    assertId(arm.id, `${label}.id`)
    if (arm.frozen !== true) fail(`${label}.frozen must be true`)
    if (arm.status === 'enabled') {
      assertAllowedKeys(
        arm,
        ['id', 'requirement', 'status', 'frozen', 'providerId'],
        label,
      )
      if (arm.requirement !== 'required' && arm.requirement !== 'optional') {
        fail(`${label}.requirement is unsupported`)
      }
      assertId(arm.providerId, `${label}.providerId`)
    } else if (arm.status === 'disabled') {
      assertAllowedKeys(
        arm,
        ['id', 'requirement', 'status', 'frozen', 'reason'],
        label,
      )
      if (arm.requirement !== 'optional') {
        fail(`${label} may be disabled only when optional`)
      }
      assertNonEmptyString(arm.reason, `${label}.reason`)
      if ('providerId' in arm)
        fail(`${label} disabled arm must not name a provider`)
    } else {
      fail(`${label}.status is unsupported`)
    }
    arms.set(arm.id, arm as PdfEvidenceArmState)
  }

  const providers = new Map<string, PdfEvidenceProviderIdentity>()
  const bundlesByArm = new Map<string, PdfEvidenceBundle[]>()
  const sources = new Map<string, PdfEvidenceSource>()
  const artifacts = new Map<string, PdfEvidenceArtifact>()
  const evidenceCandidates = new Map<string, PdfEvidenceCandidate>()

  for (const requiredArmId of REQUIRED_PDF_EVIDENCE_ARMS) {
    const arm = arms.get(requiredArmId)
    if (!arm || arm.status !== 'enabled' || arm.requirement !== 'required') {
      fail(
        `required evidence arm ${requiredArmId} must be enabled and required`,
      )
    }
  }

  for (const bundle of candidate.bundles) {
    validateBundleShape(bundle)
    if (!sameSource(bundle.source, candidate.source)) {
      fail(`bundle ${bundle.id} source identity does not match graph source`)
    }
    if (providers.has(bundle.provider.id)) {
      fail(`duplicate provider id ${bundle.provider.id}`)
    }
    providers.set(bundle.provider.id, bundle.provider)
    const arm = arms.get(bundle.armId)
    if (!arm) fail(`bundle ${bundle.id} references unknown arm ${bundle.armId}`)
    if (arm.status !== 'enabled') {
      fail(`bundle ${bundle.id} references disabled arm ${bundle.armId}`)
    }
    if (arm.providerId !== bundle.provider.id) {
      fail(`bundle ${bundle.id} provider does not match arm ${bundle.armId}`)
    }
    const armBundles = bundlesByArm.get(bundle.armId) ?? []
    armBundles.push(bundle)
    bundlesByArm.set(bundle.armId, armBundles)

    for (const source of bundle.sources) {
      if (sources.has(source.id)) fail(`duplicate source id ${source.id}`)
      sources.set(source.id, source)
    }
    for (const artifact of bundle.artifacts) {
      if (artifacts.has(artifact.id))
        fail(`duplicate artifact id ${artifact.id}`)
      artifacts.set(artifact.id, artifact)
    }
    for (const item of bundle.candidates) {
      if (evidenceCandidates.has(item.id))
        fail(`duplicate candidate id ${item.id}`)
      evidenceCandidates.set(item.id, item)
    }
  }

  for (const arm of arms.values()) {
    const bundleCount = bundlesByArm.get(arm.id)?.length ?? 0
    if (arm.status === 'enabled' && bundleCount !== 1) {
      fail(`enabled arm ${arm.id} must have exactly one evidence bundle`)
    }
    if (arm.status === 'disabled' && bundleCount !== 0) {
      fail(`disabled arm ${arm.id} must not have an evidence bundle`)
    }
    if (arm.status === 'enabled' && arm.requirement === 'required') {
      const bundle = bundlesByArm.get(arm.id)?.[0]
      if (
        !bundle ||
        bundle.sources.length === 0 ||
        bundle.artifacts.length === 0 ||
        bundle.candidates.length === 0
      ) {
        fail(`required arm ${arm.id} evidence bundle must contain evidence`)
      }
    }
  }

  for (const bundle of candidate.bundles) {
    for (const source of bundle.sources) {
      for (const artifactId of source.artifactIds ?? []) {
        const artifact = artifacts.get(artifactId)
        if (!artifact)
          fail(`source ${source.id} references unknown artifact ${artifactId}`)
        if (artifact.providerId !== source.providerId) {
          fail(`source ${source.id} references artifact from another provider`)
        }
      }
      for (const parentId of source.parentSourceIds ?? []) {
        const parent = sources.get(parentId)
        if (!parent)
          fail(
            `source ${source.id} references unknown parent source ${parentId}`,
          )
        if (parent.providerId !== source.providerId) {
          fail(`source ${source.id} references parent from another provider`)
        }
      }
    }
    for (const artifact of bundle.artifacts) {
      for (const sourceId of artifact.sourceIds ?? []) {
        const source = sources.get(sourceId)
        if (!source)
          fail(`artifact ${artifact.id} references unknown source ${sourceId}`)
        if (source.providerId !== artifact.providerId) {
          fail(
            `artifact ${artifact.id} references source from another provider`,
          )
        }
      }
    }
    for (const item of bundle.candidates) {
      for (const sourceId of item.sourceIds) {
        const source = sources.get(sourceId)
        if (!source)
          fail(`candidate ${item.id} references unknown source ${sourceId}`)
        if (source.providerId !== item.providerId) {
          fail(`candidate ${item.id} references source from another provider`)
        }
      }
      for (const artifactId of item.artifactIds ?? []) {
        const artifact = artifacts.get(artifactId)
        if (!artifact)
          fail(`candidate ${item.id} references unknown artifact ${artifactId}`)
        if (artifact.providerId !== item.providerId) {
          fail(`candidate ${item.id} references artifact from another provider`)
        }
      }
    }
  }
  assertNoSourceCycles(sources)

  const obligations = new Map<string, PdfEvidenceObligation>()
  const candidateOwners = new Map<string, string>()
  const sourceOwners = new Map<string, string>()
  const artifactOwners = new Map<string, string>()
  for (const [index, obligation] of candidate.obligations.entries()) {
    const label = `graph.obligations[${index}]`
    assertRecord(obligation, label)
    assertAllowedKeys(
      obligation,
      [
        'id',
        'kind',
        'page',
        'sourceIds',
        'artifactIds',
        'candidateIds',
        'observationCategories',
        'required',
        'semantic',
      ],
      label,
    )
    assertId(obligation.id, `${label}.id`)
    assertNonEmptyString(obligation.kind, `${label}.kind`)
    if (obligation.page !== undefined) {
      assertPageNumber(
        obligation.page,
        candidate.source.pageCount,
        `${label}.page`,
      )
    }
    assertStringArray(obligation.sourceIds, `${label}.sourceIds`, {
      nonEmpty: true,
    })
    assertStringArray(obligation.artifactIds, `${label}.artifactIds`)
    assertStringArray(obligation.candidateIds, `${label}.candidateIds`)
    assertPlainArray(
      obligation.observationCategories,
      `${label}.observationCategories`,
    )
    if (obligation.observationCategories.length === 0) {
      fail(`${label}.observationCategories must be non-empty`)
    }
    const categorySet = new Set(PDF_EVIDENCE_OBSERVATION_CATEGORIES)
    const seenCategories = new Set<string>()
    for (const observationCategory of obligation.observationCategories) {
      if (
        typeof observationCategory !== 'string' ||
        !categorySet.has(
          observationCategory as PdfEvidenceObservationCategory,
        ) ||
        seenCategories.has(observationCategory)
      ) {
        fail(`${label}.observationCategories contains an invalid category`)
      }
      seenCategories.add(observationCategory)
    }
    if (typeof obligation.required !== 'boolean')
      fail(`${label}.required must be boolean`)
    if (typeof obligation.semantic !== 'boolean')
      fail(`${label}.semantic must be boolean`)
    for (const sourceId of obligation.sourceIds) {
      if (!sources.has(sourceId)) {
        fail(
          `obligation ${obligation.id} references unknown source ${sourceId}`,
        )
      }
      const owner = sourceOwners.get(sourceId)
      if (owner) {
        fail(
          `source ${sourceId} is owned by multiple obligations ${owner} and ${obligation.id}`,
        )
      }
      sourceOwners.set(sourceId, obligation.id)
    }
    for (const artifactId of obligation.artifactIds) {
      if (!artifacts.has(artifactId)) {
        fail(
          `obligation ${obligation.id} references unknown artifact ${artifactId}`,
        )
      }
      const owner = artifactOwners.get(artifactId)
      if (owner) {
        fail(
          `artifact ${artifactId} is owned by multiple obligations ${owner} and ${obligation.id}`,
        )
      }
      artifactOwners.set(artifactId, obligation.id)
    }
    for (const candidateId of obligation.candidateIds) {
      if (!evidenceCandidates.has(candidateId)) {
        fail(
          `obligation ${obligation.id} references unknown candidate ${candidateId}`,
        )
      }
      const owner = candidateOwners.get(candidateId)
      if (owner) {
        fail(
          `candidate ${candidateId} is owned by multiple obligations ${owner} and ${obligation.id}`,
        )
      }
      candidateOwners.set(candidateId, obligation.id)
    }
    obligations.set(obligation.id, obligation)
  }

  for (const candidateId of evidenceCandidates.keys()) {
    if (!candidateOwners.has(candidateId)) {
      fail(`candidate ${candidateId} is not owned by an obligation`)
    }
  }
  for (const sourceId of sources.keys()) {
    if (!sourceOwners.has(sourceId)) {
      fail(`source ${sourceId} is not owned by an obligation`)
    }
  }
  for (const artifactId of artifacts.keys()) {
    if (!artifactOwners.has(artifactId)) {
      fail(`artifact ${artifactId} is not owned by an obligation`)
    }
  }

  for (const [index, disagreement] of candidate.disagreements.entries()) {
    const label = `graph.disagreements[${index}]`
    assertRecord(disagreement, label)
    assertAllowedKeys(
      disagreement,
      ['id', 'kind', 'obligationIds', 'candidateIds', 'providerIds', 'reason'],
      label,
    )
    assertId(disagreement.id, `${label}.id`)
    assertNonEmptyString(disagreement.kind, `${label}.kind`)
    assertStringArray(disagreement.obligationIds, `${label}.obligationIds`, {
      nonEmpty: true,
    })
    assertStringArray(disagreement.candidateIds, `${label}.candidateIds`, {
      nonEmpty: true,
    })
    if (disagreement.candidateIds.length < 2) {
      fail(`${label}.candidateIds must contain at least two candidates`)
    }
    assertStringArray(disagreement.providerIds, `${label}.providerIds`, {
      nonEmpty: true,
    })
    assertNonEmptyString(disagreement.reason, `${label}.reason`)
    for (const obligationId of disagreement.obligationIds) {
      if (!obligations.has(obligationId)) {
        fail(
          `disagreement ${disagreement.id} references unknown obligation ${obligationId}`,
        )
      }
    }
    const referencedProviderIds = new Set<string>()
    for (const candidateId of disagreement.candidateIds) {
      const item = evidenceCandidates.get(candidateId)
      if (!item) {
        fail(
          `disagreement ${disagreement.id} references unknown candidate ${candidateId}`,
        )
      }
      referencedProviderIds.add(item.providerId)
    }
    const declaredProviders = [...disagreement.providerIds].sort()
    const referencedProviders = [...referencedProviderIds].sort()
    if (stableJson(declaredProviders) !== stableJson(referencedProviders)) {
      fail(
        `disagreement ${disagreement.id} providerIds do not match its candidates`,
      )
    }
  }

  const deterministicBundles = bundlesByArm.get('deterministic') ?? []
  if (deterministicBundles.length === 1) {
    const expected = deterministicContextReceiptForBundle(
      deterministicBundles[0]!,
    )
    if (stableJson(candidate.deterministicContext) !== stableJson(expected)) {
      fail(
        'graph.deterministicContext does not match the exact normalized deterministic bundle',
      )
    }
  }
}

function cloneJsonValue(value: PdfEvidenceJsonValue): PdfEvidenceJsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        cloneJsonValue(nested),
      ]),
    )
  }
  return value
}

function copyOptional<T extends object, K extends keyof T>(
  output: T,
  source: T,
  key: K,
) {
  if (source[key] !== undefined) output[key] = source[key]
}

function normalizeStringSet(values: readonly string[] | undefined) {
  return values ? [...values].sort() : undefined
}

function normalizeBox(box: PdfEvidenceBox): PdfEvidenceBox {
  return { ...box }
}

function normalizeSourceIdentity(
  source: PdfEvidenceSourceIdentity,
): PdfEvidenceSourceIdentity {
  return { ...source }
}

function normalizeProvider(
  provider: PdfEvidenceProviderIdentity,
): PdfEvidenceProviderIdentity {
  const output: PdfEvidenceProviderIdentity = {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    version: provider.version,
  }
  copyOptional(output, provider, 'implementationSha256')
  if (provider.model) output.model = { ...provider.model }
  if (provider.execution) output.execution = { ...provider.execution }
  return output
}

function normalizeArtifact(artifact: PdfEvidenceArtifact): PdfEvidenceArtifact {
  const output: PdfEvidenceArtifact = {
    id: artifact.id,
    providerId: artifact.providerId,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
  }
  copyOptional(output, artifact, 'page')
  if (artifact.box) output.box = normalizeBox(artifact.box)
  const sourceIds = normalizeStringSet(artifact.sourceIds)
  if (sourceIds) output.sourceIds = sourceIds
  return output
}

function normalizeSource(source: PdfEvidenceSource): PdfEvidenceSource {
  const output: PdfEvidenceSource = {
    id: source.id,
    providerId: source.providerId,
    kind: source.kind,
  }
  copyOptional(output, source, 'page')
  if (source.box) output.box = normalizeBox(source.box)
  const artifactIds = normalizeStringSet(source.artifactIds)
  if (artifactIds) output.artifactIds = artifactIds
  const parentSourceIds = normalizeStringSet(source.parentSourceIds)
  if (parentSourceIds) output.parentSourceIds = parentSourceIds
  if (source.payload !== undefined)
    output.payload = cloneJsonValue(source.payload)
  return output
}

function normalizeCandidate(
  candidate: PdfEvidenceCandidate,
): PdfEvidenceCandidate {
  const output: PdfEvidenceCandidate = {
    id: candidate.id,
    providerId: candidate.providerId,
    kind: candidate.kind,
    sourceIds: [...candidate.sourceIds].sort(),
  }
  copyOptional(output, candidate, 'page')
  if (candidate.boxes) {
    output.boxes = candidate.boxes
      .map(normalizeBox)
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
  }
  const artifactIds = normalizeStringSet(candidate.artifactIds)
  if (artifactIds) output.artifactIds = artifactIds
  if (candidate.payload !== undefined)
    output.payload = cloneJsonValue(candidate.payload)
  return output
}

function normalizeBundle(bundle: PdfEvidenceBundle): PdfEvidenceBundle {
  return {
    schemaVersion: PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
    id: bundle.id,
    armId: bundle.armId,
    source: normalizeSourceIdentity(bundle.source),
    provider: normalizeProvider(bundle.provider),
    pages: bundle.pages
      .map((page) => ({ ...page }))
      .sort((a, b) => a.page - b.page),
    artifacts: bundle.artifacts
      .map(normalizeArtifact)
      .sort((a, b) => a.id.localeCompare(b.id)),
    sources: bundle.sources
      .map(normalizeSource)
      .sort((a, b) => a.id.localeCompare(b.id)),
    candidates: bundle.candidates
      .map(normalizeCandidate)
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export function deterministicContextReceiptForBundle(
  bundle: PdfEvidenceBundle,
): PdfDeterministicContextReceipt {
  validateBundleShape(bundle)
  if (bundle.armId !== 'deterministic') {
    fail('deterministic context receipt requires the deterministic arm')
  }
  const normalized = normalizeBundle(bundle)
  const exactContext = {
    source: normalized.source,
    pages: normalized.pages,
    artifacts: normalized.artifacts,
    sources: normalized.sources,
    candidates: normalized.candidates,
  }
  return {
    schemaVersion: DETERMINISTIC_CONTEXT_RECEIPT_SCHEMA_VERSION,
    sourceIdentitySha256: sha256HexSync(stableJson(normalized.source)),
    pageSetSha256: sha256HexSync(stableJson(normalized.pages)),
    pageCount: normalized.pages.length,
    sourceSetSha256: sha256HexSync(stableJson(normalized.sources)),
    sourceCount: normalized.sources.length,
    artifactSetSha256: sha256HexSync(stableJson(normalized.artifacts)),
    artifactCount: normalized.artifacts.length,
    candidateSetSha256: sha256HexSync(stableJson(normalized.candidates)),
    candidateCount: normalized.candidates.length,
    contextSha256: sha256HexSync(stableJson(exactContext)),
  }
}

function normalizeGraphInput(
  graph: SourceEvidenceGraphInput | SourceEvidenceGraph,
): SourceEvidenceGraphInput {
  return {
    schemaVersion: SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
    source: normalizeSourceIdentity(graph.source),
    deterministicContext: { ...graph.deterministicContext },
    arms: graph.arms
      .map((arm): PdfEvidenceArmState =>
        arm.status === 'enabled'
          ? { ...arm }
          : {
              id: arm.id,
              requirement: 'optional',
              status: 'disabled',
              frozen: true,
              reason: arm.reason,
            },
      )
      .sort((a, b) => a.id.localeCompare(b.id)),
    bundles: graph.bundles
      .map(normalizeBundle)
      .sort((a, b) => a.id.localeCompare(b.id)),
    obligations: graph.obligations
      .map((obligation) => {
        const output: PdfEvidenceObligation = {
          id: obligation.id,
          kind: obligation.kind,
          sourceIds: [...obligation.sourceIds].sort(),
          artifactIds: [...obligation.artifactIds].sort(),
          candidateIds: [...obligation.candidateIds].sort(),
          observationCategories: [...obligation.observationCategories].sort(),
          required: obligation.required,
          semantic: obligation.semantic,
        }
        copyOptional(output, obligation, 'page')
        return output
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
    disagreements: graph.disagreements
      .map((disagreement) => ({
        id: disagreement.id,
        kind: disagreement.kind,
        obligationIds: [...disagreement.obligationIds].sort(),
        candidateIds: [...disagreement.candidateIds].sort(),
        providerIds: [...disagreement.providerIds].sort(),
        reason: disagreement.reason,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      fail('canonical value contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`
  }
  fail('canonical value contains a non-JSON value')
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const nested of Object.values(value as object)) deepFreeze(nested, seen)
  return Object.freeze(value)
}

export function validatePdfEvidenceBundle(
  bundle: unknown,
): asserts bundle is PdfEvidenceBundle {
  validateBundleShape(bundle)
}

export function sourceEvidenceGraphSha256(
  graph: SourceEvidenceGraphInput | SourceEvidenceGraph,
) {
  validateGraphShape(graph, { requireHash: false })
  const normalized = normalizeGraphInput(graph)
  return sha256HexSync(stableJson(normalized))
}

export function validateSourceEvidenceGraph(
  graph: unknown,
): asserts graph is SourceEvidenceGraph {
  validateGraphShape(graph, { requireHash: true })
  const typed = graph as SourceEvidenceGraph
  const expected = sourceEvidenceGraphSha256(typed)
  if (typed.graphSha256 !== expected) {
    fail('graph.graphSha256 does not match the canonical graph content')
  }
}

export function buildSourceEvidenceGraph(
  input: SourceEvidenceGraphInput,
): SourceEvidenceGraph {
  validateGraphShape(input, { requireHash: false })
  const normalized = normalizeGraphInput(input)
  const graph: SourceEvidenceGraph = {
    ...normalized,
    graphSha256: sha256HexSync(stableJson(normalized)),
  }
  validateSourceEvidenceGraph(graph)
  return deepFreeze(graph)
}

/** Exact canonical bytes used by #199's opaque evidence-graph binding. */
export function serializeSourceEvidenceGraph(graph: SourceEvidenceGraph) {
  validateSourceEvidenceGraph(graph)
  const bytes = new TextEncoder().encode(stableJson(normalizeGraphInput(graph)))
  if (sha256HexSync(bytes) !== graph.graphSha256) {
    fail('serialized graph bytes do not match graph.graphSha256')
  }
  return bytes
}

function indexesForGraph(graph: SourceEvidenceGraph) {
  const providers = new Map<string, PdfEvidenceProviderIdentity>()
  const sources = new Map<string, PdfEvidenceSource>()
  const artifacts = new Map<string, PdfEvidenceArtifact>()
  const candidates = new Map<string, PdfEvidenceCandidate>()
  const pages = new Map<number, PdfEvidencePageView[]>()
  for (const bundle of graph.bundles) {
    providers.set(bundle.provider.id, bundle.provider)
    for (const source of bundle.sources) sources.set(source.id, source)
    for (const artifact of bundle.artifacts)
      artifacts.set(artifact.id, artifact)
    for (const candidate of bundle.candidates)
      candidates.set(candidate.id, candidate)
    for (const geometry of bundle.pages) {
      const views = pages.get(geometry.page) ?? []
      views.push({
        bundleId: bundle.id,
        providerId: bundle.provider.id,
        geometry,
      })
      pages.set(geometry.page, views)
    }
  }
  return {
    providers,
    sources,
    artifacts,
    candidates,
    obligations: new Map(graph.obligations.map((item) => [item.id, item])),
    disagreements: new Map(graph.disagreements.map((item) => [item.id, item])),
    pages,
  }
}

export function sourceEvidenceCandidateSetSha256(
  graph: SourceEvidenceGraph,
  candidateIds?: readonly string[],
) {
  validateSourceEvidenceGraph(graph)
  const { candidates } = indexesForGraph(graph)
  const ids = candidateIds ? [...candidateIds] : [...candidates.keys()]
  assertStringArray(ids, 'candidateIds')
  ids.sort()
  const selected = ids.map((id) => {
    const candidate = candidates.get(id)
    if (!candidate) fail(`candidate set references unknown candidate ${id}`)
    return candidate
  })
  return sha256HexSync(
    stableJson({
      schemaVersion: SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
      graphSha256: graph.graphSha256,
      candidates: selected,
    }),
  )
}

export function readSourceEvidenceGraph(
  graph: SourceEvidenceGraph,
): SourceEvidenceGraphReader {
  validateSourceEvidenceGraph(graph)
  const immutableGraph = buildSourceEvidenceGraph(normalizeGraphInput(graph))
  const indexes = indexesForGraph(immutableGraph)
  for (const views of indexes.pages.values()) {
    views.sort((left, right) => left.providerId.localeCompare(right.providerId))
    deepFreeze(views)
  }

  return Object.freeze({
    graph: immutableGraph,
    source: immutableGraph.source,
    graphSha256: immutableGraph.graphSha256,
    provider: (id: string) => indexes.providers.get(id),
    sourceItem: (id: string) => indexes.sources.get(id),
    artifact: (id: string) => indexes.artifacts.get(id),
    candidate: (id: string) => indexes.candidates.get(id),
    obligation: (id: string) => indexes.obligations.get(id),
    disagreement: (id: string) => indexes.disagreements.get(id),
    page: (page: number) => indexes.pages.get(page) ?? Object.freeze([]),
    allCandidates: () => Object.freeze([...indexes.candidates.values()]),
    candidatesForObligation: (id: string) => {
      const obligation = indexes.obligations.get(id)
      if (!obligation) return Object.freeze([])
      return Object.freeze(
        obligation.candidateIds.map((candidateId) =>
          indexes.candidates.get(candidateId)!,
        ),
      )
    },
    candidateSetSha256: (candidateIds?: readonly string[]) =>
      sourceEvidenceCandidateSetSha256(immutableGraph, candidateIds),
  })
}
