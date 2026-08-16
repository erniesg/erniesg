import { createHash } from 'node:crypto'

const HEAD_PATTERN = /^[a-f0-9]{40}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const NONCE_PATTERN = /^[a-f0-9]{24}$/u
const VERSION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/iu
const SAFE_STAGES = new Set([
  'preflight',
  'build',
  'deploy',
  'browser',
  'cleanup',
  'receipt',
  'lifecycle',
])
const SAFE_FAILURE_CODES = new Set([
  'INVALID_ARGUMENTS',
  'INVALID_REVIEWED_HEAD',
  'INVALID_WORKER_NONCE',
  'INVALID_WORKER_NAME',
  'UNOWNED_WORKER_NAME',
  'FIXTURE_PIN_MISMATCH',
  'INVALID_SHA256',
  'INVALID_DEPLOY_OUTPUT',
  'INVALID_BROWSER_RECEIPT',
  'TEARDOWN_NOT_PROVEN',
  'INVALID_RECEIPT_STATE',
  'INVALID_LIFECYCLE_DEPENDENCIES',
  'PREFLIGHT_FAILED',
  'BUILD_FAILED',
  'DEPLOY_FAILED',
  'BROWSER_FAILED',
  'CLEANUP_FAILED',
  'RECEIPT_FAILED',
  'LIFECYCLE_FAILED',
])

export const DISPOSABLE_PDF_WORKER_PREFIX = 'erniesg-i171'
export const DISPOSABLE_PDF_WORKER_NAME_PATTERN =
  /^erniesg-i171-[a-f0-9]{12}-[a-f0-9]{24}$/u
export const DISPOSABLE_PDF_FIXTURE_PIN = Object.freeze({
  path: 'tests/fixtures/pdf/pdf-to-epub-fidelity.pdf',
  byteLength: 16_759,
  sha256: '17921375594e87b1377e86d304f9f151c393255eb94b8e0f523179f6b9e07cea',
  license: 'CC0-1.0',
})
export const DISPOSABLE_PDF_PROFILE_IDS = Object.freeze([
  'mobile',
  'paperProMove',
  'paperPro',
])
export const DISPOSABLE_PDF_SEMANTIC_OBLIGATIONS = Object.freeze([
  'prose',
  'sections',
  'lists',
  'notes',
  'referencesOrCitations',
  'figures',
  'captions',
  'tables',
  'equations',
])
export const DISPOSABLE_PDF_UNRESOLVED_OBJECT_KINDS = Object.freeze([
  'assets',
  'captions',
  'citations',
  'equations',
  'footnoteReferences',
  'footnotes',
  'tables',
])
export const DISPOSABLE_PDF_EPUBCHECK_VERSION = 'v5.3.0'
export const DISPOSABLE_PDF_EPUBCHECK_JAR_SHA256 =
  'f7f96617c929371821609b88c8484d6dc9f24fe916499863c46094c5fb778a65'

export class DisposablePdfWorkerError extends Error {
  constructor(code, message = 'Disposable PDF Worker validation failed.') {
    super(message)
    this.name = 'DisposablePdfWorkerError'
    this.code = code
  }
}

export class DisposablePdfWorkerLifecycleError extends Error {
  constructor(failures, cleanupAttempted) {
    super('Disposable PDF Worker lifecycle failed.')
    this.name = 'DisposablePdfWorkerLifecycleError'
    this.code = 'DISPOSABLE_WORKER_LIFECYCLE_FAILED'
    this.failures = failures.map(({ stage, code }) => ({ stage, code }))
    this.cleanupAttempted = cleanupAttempted
  }
}

function fail(code, message) {
  throw new DisposablePdfWorkerError(code, message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validHead(value) {
  return typeof value === 'string' && HEAD_PATTERN.test(value)
}

function validSha256(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function requireHead(value) {
  if (!validHead(value)) fail('INVALID_REVIEWED_HEAD')
  return value
}

function requireSha256(value, code = 'INVALID_SHA256') {
  if (!validSha256(value)) fail(code)
  return value
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function validCloudflareToken(value) {
  return (
    typeof value === 'string' &&
    value.length >= 20 &&
    value.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  )
}

export function resolveCloudflareCredentials({
  apiToken,
  accountId,
  authTokenOutput,
  whoamiOutput,
}) {
  const auth = parseRecord(authTokenOutput, 'PREFLIGHT_FAILED')
  const identity = parseRecord(whoamiOutput, 'PREFLIGHT_FAILED')
  if (
    !['api_token', 'oauth'].includes(auth.type) ||
    !validCloudflareToken(auth.token) ||
    (apiToken !== undefined && auth.token !== apiToken) ||
    identity.loggedIn !== true ||
    !Array.isArray(identity.accounts)
  ) {
    fail('PREFLIGHT_FAILED')
  }

  const accountIds = [
    ...new Set(
      identity.accounts
        .map((account) => account?.id)
        .filter(
          (candidate) =>
            typeof candidate === 'string' &&
            CLOUDFLARE_ACCOUNT_ID_PATTERN.test(candidate),
        )
        .map((candidate) => candidate.toLowerCase()),
    ),
  ]
  const selectedAccount =
    typeof accountId === 'string' &&
    CLOUDFLARE_ACCOUNT_ID_PATTERN.test(accountId)
      ? accountId.toLowerCase()
      : accountId === undefined && accountIds.length === 1
        ? accountIds[0]
        : null
  if (!selectedAccount || !accountIds.includes(selectedAccount)) {
    fail('PREFLIGHT_FAILED')
  }
  return { apiToken: auth.token, accountId: selectedAccount }
}

function optionValue(argv, index, inlineValue) {
  if (inlineValue !== undefined) {
    if (!inlineValue) fail('INVALID_ARGUMENTS')
    return { value: inlineValue, nextIndex: index }
  }
  const value = argv[index + 1]
  if (typeof value !== 'string' || !value || value.startsWith('--')) {
    fail('INVALID_ARGUMENTS')
  }
  return { value, nextIndex: index + 1 }
}

export function createOwnedWorkerName({ expectedHead, nonce }) {
  const head = requireHead(expectedHead)
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
    fail('INVALID_WORKER_NONCE')
  }
  const name = `${DISPOSABLE_PDF_WORKER_PREFIX}-${head.slice(0, 12)}-${nonce}`
  if (!DISPOSABLE_PDF_WORKER_NAME_PATTERN.test(name) || name.length > 63) {
    fail('INVALID_WORKER_NAME')
  }
  return name
}

export function validateOwnedWorkerName(name, ownership) {
  if (
    typeof name !== 'string' ||
    !DISPOSABLE_PDF_WORKER_NAME_PATTERN.test(name) ||
    name !== createOwnedWorkerName(ownership)
  ) {
    fail('UNOWNED_WORKER_NAME')
  }
  return name
}

export function parseDisposablePdfWorkerArguments(argv) {
  if (!Array.isArray(argv)) fail('INVALID_ARGUMENTS')
  const parsed = {}
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (typeof argument !== 'string' || !argument.startsWith('--')) {
      fail('INVALID_ARGUMENTS')
    }
    const equals = argument.indexOf('=')
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1)
    const key =
      flag === '--expected-head'
        ? 'expectedHead'
        : flag === '--nonce'
          ? 'nonce'
          : null
    if (!key || seen.has(key)) fail('INVALID_ARGUMENTS')
    const selected = optionValue(argv, index, inlineValue)
    parsed[key] = selected.value
    seen.add(key)
    index = selected.nextIndex
  }
  if (!seen.has('expectedHead') || !seen.has('nonce')) {
    fail('INVALID_ARGUMENTS')
  }
  const expectedHead = requireHead(parsed.expectedHead)
  const nonce = parsed.nonce
  const workerName = createOwnedWorkerName({ expectedHead, nonce })
  return {
    expectedHead,
    nonce,
    workerName,
    fixture: { ...DISPOSABLE_PDF_FIXTURE_PIN },
  }
}

export function validateFixturePin(candidate) {
  if (
    !isRecord(candidate) ||
    candidate.path !== DISPOSABLE_PDF_FIXTURE_PIN.path ||
    candidate.byteLength !== DISPOSABLE_PDF_FIXTURE_PIN.byteLength ||
    candidate.sha256 !== DISPOSABLE_PDF_FIXTURE_PIN.sha256 ||
    candidate.license !== DISPOSABLE_PDF_FIXTURE_PIN.license
  ) {
    fail('FIXTURE_PIN_MISMATCH')
  }
  return {
    path: DISPOSABLE_PDF_FIXTURE_PIN.path,
    byteLength: DISPOSABLE_PDF_FIXTURE_PIN.byteLength,
    sha256: DISPOSABLE_PDF_FIXTURE_PIN.sha256,
    license: DISPOSABLE_PDF_FIXTURE_PIN.license,
  }
}

function parseRecord(value, code) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      fail(code)
    }
  }
  if (!isRecord(value)) fail(code)
  return value
}

function validWorkersDevUrl(value, workerName) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.port &&
      !url.username &&
      !url.password &&
      (url.pathname === '/' || url.pathname === '') &&
      !url.search &&
      !url.hash &&
      url.hostname.startsWith(`${workerName}.`) &&
      url.hostname.endsWith('.workers.dev') &&
      url.hostname.split('.').length === 4
    )
  } catch {
    return false
  }
}

function requireOwnedWorkersDevOrigin(value, workerName, code) {
  if (
    !validWorkersDevUrl(value, workerName) ||
    new URL(value).origin !== value
  ) {
    fail(code)
  }
  return value
}

export function validateDeployOutput(output, context) {
  const record = parseRecord(output, 'INVALID_DEPLOY_OUTPUT')
  const workerName = validateOwnedWorkerName(record.workerName, context)
  const expectedHead = requireHead(context.expectedHead)
  if (
    record.head !== expectedHead ||
    typeof record.versionId !== 'string' ||
    !VERSION_PATTERN.test(record.versionId) ||
    !validWorkersDevUrl(record.url, workerName)
  ) {
    fail('INVALID_DEPLOY_OUTPUT')
  }
  return {
    workerName,
    versionId: record.versionId,
    head: expectedHead,
    url: new URL(record.url).origin,
  }
}

function requireZero(value) {
  return Number.isInteger(value) && value === 0
}

function requirePositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function validateProfileReceipt(profile, id) {
  if (
    !isRecord(profile) ||
    profile.profileId !== id ||
    profile.profileVersion !== '1.1.0'
  ) {
    fail('INVALID_BROWSER_RECEIPT')
  }
  const hashFields = [
    'artifactSha256',
    'canonicalGraphSha256',
    'assetIndexSha256',
    'visualRelationshipIndexSha256',
  ]
  for (const field of hashFields) {
    requireSha256(profile[field], 'INVALID_BROWSER_RECEIPT')
  }
  if (
    !requirePositiveInteger(profile.canonicalNodeCount) ||
    !requirePositiveInteger(profile.assetCount) ||
    !requirePositiveInteger(profile.visualRelationshipCount) ||
    profile.internalValidation !== 'passed' ||
    !isRecord(profile.epubCheck) ||
    profile.epubCheck.status !== 'passed' ||
    profile.epubCheck.version !== DISPOSABLE_PDF_EPUBCHECK_VERSION ||
    profile.epubCheck.jarSha256 !== DISPOSABLE_PDF_EPUBCHECK_JAR_SHA256 ||
    profile.epubCheck.failOnWarnings !== true ||
    !requireZero(profile.epubCheck.errorCount) ||
    !requireZero(profile.epubCheck.warningCount) ||
    !requireZero(profile.epubCheck.skipCount)
  ) {
    fail('INVALID_BROWSER_RECEIPT')
  }
  return {
    profileId: id,
    profileVersion: '1.1.0',
    artifactSha256: profile.artifactSha256,
    canonicalGraphSha256: profile.canonicalGraphSha256,
    canonicalNodeCount: profile.canonicalNodeCount,
    assetIndexSha256: profile.assetIndexSha256,
    assetCount: profile.assetCount,
    visualRelationshipIndexSha256: profile.visualRelationshipIndexSha256,
    visualRelationshipCount: profile.visualRelationshipCount,
    internalValidation: 'passed',
    epubCheck: {
      status: 'passed',
      version: DISPOSABLE_PDF_EPUBCHECK_VERSION,
      jarSha256: DISPOSABLE_PDF_EPUBCHECK_JAR_SHA256,
      failOnWarnings: true,
      warningCount: 0,
      errorCount: 0,
      skipCount: 0,
    },
  }
}

function validateUnresolvedObjects(value) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !==
      DISPOSABLE_PDF_UNRESOLVED_OBJECT_KINDS.length ||
    !DISPOSABLE_PDF_UNRESOLVED_OBJECT_KINDS.every(
      (key) => Object.hasOwn(value, key) && requireZero(value[key]),
    )
  ) {
    fail('INVALID_BROWSER_RECEIPT')
  }
  return Object.fromEntries(
    DISPOSABLE_PDF_UNRESOLVED_OBJECT_KINDS.map((key) => [key, 0]),
  )
}

function validateBrowserReceiptRecord(record, context, projected) {
  const expectedHead = requireHead(context.expectedHead)
  const workerName = validateOwnedWorkerName(
    context.workerName ?? createOwnedWorkerName(context),
    context,
  )
  const origin = requireOwnedWorkersDevOrigin(
    context.origin,
    workerName,
    'INVALID_BROWSER_RECEIPT',
  )
  if (
    typeof context.versionId !== 'string' ||
    !VERSION_PATTERN.test(context.versionId)
  ) {
    fail('INVALID_BROWSER_RECEIPT')
  }
  const deployment = record.deployment
  if (
    !isRecord(deployment) ||
    deployment.exactHead !== expectedHead ||
    deployment.workerName !== workerName ||
    deployment.workerVersionId !== context.versionId ||
    deployment.runNonce !== context.nonce ||
    (projected
      ? deployment.originSha256 !== sha256(origin)
      : deployment.observedOrigin !== origin)
  ) {
    fail('INVALID_BROWSER_RECEIPT')
  }
  const fixture = validateFixturePin({
    ...DISPOSABLE_PDF_FIXTURE_PIN,
    byteLength: record.source?.byteLength,
    sha256: record.source?.sha256,
  })
  if (
    record.schemaVersion !== '1.0.0' ||
    !isRecord(record.semanticCompleteness) ||
    record.semanticCompleteness.unresolvedObjectCount !== 0 ||
    !requireZero(record.semanticCompleteness.ocrRequiredPageCount) ||
    !requireZero(record.semanticCompleteness.readingOrderDiagnosticCount) ||
    !requireZero(record.semanticCompleteness.unresolvedCorruptingJoinCount) ||
    !validSha256(record.semanticCompleteness.unresolvedObjectsSha256) ||
    !Number.isFinite(record.semanticCompleteness.textCoverage) ||
    !(record.semanticCompleteness.textCoverage > 0.99) ||
    record.semanticCompleteness.textCoverage > 1 ||
    !isRecord(record.isolation) ||
    record.isolation.crossRequest !== 'passed' ||
    record.isolation.objectUrlCleanup !== 'passed' ||
    record.negativeInputs !== 'passed' ||
    !isRecord(record.privacy) ||
    record.privacy.sourceBearingRequestCount !== 0 ||
    record.privacy.sourceBearingLogCount !== 0 ||
    record.privacy.retainedSourceMarkerCount !== 0
  ) {
    fail('INVALID_BROWSER_RECEIPT')
  }
  const unresolvedObjects = validateUnresolvedObjects(
    record.semanticCompleteness.unresolvedObjects,
  )
  for (const obligation of DISPOSABLE_PDF_SEMANTIC_OBLIGATIONS) {
    if (!requirePositiveInteger(record.semanticCompleteness[obligation])) {
      fail('INVALID_BROWSER_RECEIPT')
    }
  }
  if (!Array.isArray(record.profiles) || record.profiles.length !== 3) {
    fail('INVALID_BROWSER_RECEIPT')
  }
  const byId = new Map(
    record.profiles.map((profile) => [profile?.profileId, profile]),
  )
  if (byId.size !== DISPOSABLE_PDF_PROFILE_IDS.length) {
    fail('INVALID_BROWSER_RECEIPT')
  }
  const profiles = DISPOSABLE_PDF_PROFILE_IDS.map((id) =>
    validateProfileReceipt(byId.get(id), id),
  )
  if (
    new Set(profiles.map(({ artifactSha256 }) => artifactSha256)).size !== 3 ||
    new Set(profiles.map(({ canonicalGraphSha256 }) => canonicalGraphSha256))
      .size !== 1 ||
    new Set(profiles.map(({ canonicalNodeCount }) => canonicalNodeCount))
      .size !== 1 ||
    new Set(
      profiles.map(
        ({ visualRelationshipIndexSha256 }) => visualRelationshipIndexSha256,
      ),
    ).size !== 1 ||
    new Set(
      profiles.map(({ visualRelationshipCount }) => visualRelationshipCount),
    ).size !== 1
  ) {
    fail('INVALID_BROWSER_RECEIPT')
  }
  return {
    schemaVersion: '1.0.0',
    deployment: {
      exactHead: expectedHead,
      workerName,
      workerVersionId: context.versionId,
      runNonce: context.nonce,
      originSha256: sha256(origin),
    },
    source: { byteLength: fixture.byteLength, sha256: fixture.sha256 },
    semanticCompleteness: {
      ...Object.fromEntries(
        DISPOSABLE_PDF_SEMANTIC_OBLIGATIONS.map((key) => [
          key,
          record.semanticCompleteness[key],
        ]),
      ),
      textCoverage: record.semanticCompleteness.textCoverage,
      unresolvedObjectCount: 0,
      unresolvedObjects,
      unresolvedObjectsSha256:
        record.semanticCompleteness.unresolvedObjectsSha256,
      ocrRequiredPageCount: 0,
      readingOrderDiagnosticCount: 0,
      unresolvedCorruptingJoinCount: 0,
    },
    profiles,
    isolation: { crossRequest: 'passed', objectUrlCleanup: 'passed' },
    negativeInputs: 'passed',
    privacy: {
      sourceBearingRequestCount: 0,
      sourceBearingLogCount: 0,
      retainedSourceMarkerCount: 0,
    },
  }
}

export function validateBrowserReceipt(receipt, context) {
  return validateBrowserReceiptRecord(
    parseRecord(receipt, 'INVALID_BROWSER_RECEIPT'),
    context,
    false,
  )
}

export function validateTeardownProof(proof, ownership) {
  if (
    !isRecord(proof) ||
    proof.deleteAttempted !== true ||
    proof.deploymentsAbsent !== true ||
    proof.versionsAbsent !== true ||
    !Array.isArray(proof.customDomains) ||
    proof.customDomains.length !== 0 ||
    !Array.isArray(proof.remainingResources) ||
    proof.remainingResources.length !== 0 ||
    proof.urlUnavailable !== true
  ) {
    fail('TEARDOWN_NOT_PROVEN')
  }
  createOwnedWorkerName(ownership)
  return {
    deleteAttempted: true,
    deploymentsAbsent: true,
    versionsAbsent: true,
    customDomains: [],
    remainingResources: [],
    urlUnavailable: true,
    verified: true,
  }
}

function safeFailure(failure) {
  const stage =
    typeof failure?.stage === 'string' && SAFE_STAGES.has(failure.stage)
      ? failure.stage
      : 'lifecycle'
  const code =
    typeof failure?.code === 'string' && SAFE_FAILURE_CODES.has(failure.code)
      ? failure.code
      : 'LIFECYCLE_FAILED'
  return { stage, code }
}

function stageFailure(error, stage) {
  return safeFailure({
    stage,
    code:
      error instanceof DisposablePdfWorkerError
        ? error.code
        : `${stage.replaceAll('-', '_').toUpperCase()}_FAILED`,
  })
}

function safePresenceArray(value, placeholder, evidenceExpected) {
  if (Array.isArray(value)) {
    return value.map(() => placeholder)
  }
  return evidenceExpected ? ['unverified'] : []
}

export function createSanitizedReceipt(state) {
  if (!isRecord(state)) fail('INVALID_RECEIPT_STATE')
  const expectedHead = requireHead(state.expectedHead)
  const workerName = validateOwnedWorkerName(state.workerName, state)
  const fixture = validateFixturePin(state.fixture)
  const failuresAreValid = Array.isArray(state.failures)
  const failures = failuresAreValid
    ? state.failures.map(safeFailure)
    : [{ stage: 'lifecycle', code: 'INVALID_RECEIPT_STATE' }]
  const teardownExpected = isRecord(state.teardown)
  const teardown = {
    delete_attempted: state.teardown?.deleteAttempted === true,
    deployments_absent: state.teardown?.deploymentsAbsent === true,
    versions_absent: state.teardown?.versionsAbsent === true,
    custom_domains: safePresenceArray(
      state.teardown?.customDomains,
      'present',
      teardownExpected,
    ),
    remaining_resources: safePresenceArray(
      state.teardown?.remainingResources,
      'present',
      teardownExpected,
    ),
    url_unavailable: state.teardown?.urlUnavailable === true,
    verified: state.teardown?.verified === true,
  }
  let deploy
  if (state.deploy !== undefined) {
    try {
      deploy = validateDeployOutput(state.deploy, {
        expectedHead,
        nonce: state.nonce,
      })
    } catch {
      fail('INVALID_RECEIPT_STATE')
    }
  }
  const versionId = deploy?.versionId
  const browser = state.browser
    ? validateBrowserReceiptRecord(
        state.browser,
        {
          expectedHead,
          nonce: state.nonce,
          workerName,
          versionId,
          origin: deploy?.url,
        },
        true,
      )
    : null
  const profiles = browser
    ? browser.profiles.map((profile) => ({
        id: profile.profileId,
        profile_version: profile.profileVersion,
        artifact_sha256: requireSha256(
          profile.artifactSha256,
          'INVALID_RECEIPT_STATE',
        ),
        canonical_graph_sha256: requireSha256(
          profile.canonicalGraphSha256,
          'INVALID_RECEIPT_STATE',
        ),
        canonical_node_count: profile.canonicalNodeCount,
        asset_index_sha256: requireSha256(
          profile.assetIndexSha256,
          'INVALID_RECEIPT_STATE',
        ),
        asset_count: profile.assetCount,
        visual_relationship_index_sha256: requireSha256(
          profile.visualRelationshipIndexSha256,
          'INVALID_RECEIPT_STATE',
        ),
        visual_relationship_count: profile.visualRelationshipCount,
        internal_validation: 'passed',
        epubcheck: {
          status: 'passed',
          version: profile.epubCheck.version,
          jar_sha256: profile.epubCheck.jarSha256,
          fail_on_warnings: true,
          warning_count: 0,
          error_count: 0,
          skip_count: 0,
        },
      }))
    : []
  const lockfileSha256 =
    state.lockfileSha256 === undefined
      ? undefined
      : requireSha256(state.lockfileSha256, 'INVALID_RECEIPT_STATE')
  const buildSha256 =
    state.buildSha256 === undefined
      ? undefined
      : requireSha256(state.buildSha256, 'INVALID_RECEIPT_STATE')
  const passed =
    failuresAreValid &&
    failures.length === 0 &&
    profiles.length === 3 &&
    lockfileSha256 !== undefined &&
    buildSha256 !== undefined &&
    state.deploymentVerified === true &&
    teardown.verified &&
    teardown.delete_attempted &&
    teardown.deployments_absent &&
    teardown.versions_absent &&
    teardown.custom_domains.length === 0 &&
    teardown.remaining_resources.length === 0 &&
    teardown.url_unavailable
  const receipt = {
    schema_version: '1',
    issue: 171,
    result: passed ? 'passed' : 'failed',
    exact_head: expectedHead,
    fixture: {
      byte_length: fixture.byteLength,
      sha256: fixture.sha256,
      license: fixture.license,
    },
    worker: {
      name: workerName,
      ...(versionId ? { version_id: versionId } : {}),
      deployment_verified: state.deploymentVerified === true,
      ...(browser
        ? {
            run_nonce: browser.deployment.runNonce,
            origin_sha256: browser.deployment.originSha256,
          }
        : {}),
    },
    ...(browser
      ? {
          reconstruction: {
            ready: true,
            unresolved_required_objects: 0,
            text_coverage: browser.semanticCompleteness.textCoverage,
            semantic_completeness: {
              ...Object.fromEntries(
                DISPOSABLE_PDF_SEMANTIC_OBLIGATIONS.map((key) => [
                  key,
                  browser.semanticCompleteness[key],
                ]),
              ),
              unresolved_objects_sha256:
                browser.semanticCompleteness.unresolvedObjectsSha256,
              unresolved_objects:
                browser.semanticCompleteness.unresolvedObjects,
              ocr_required_page_count:
                browser.semanticCompleteness.ocrRequiredPageCount,
              reading_order_diagnostic_count:
                browser.semanticCompleteness.readingOrderDiagnosticCount,
              unresolved_corrupting_join_count:
                browser.semanticCompleteness.unresolvedCorruptingJoinCount,
            },
            isolation: browser.isolation,
            negative_inputs: browser.negativeInputs,
            privacy: browser.privacy,
          },
        }
      : {}),
    profiles,
    teardown,
    failures,
  }
  if (lockfileSha256 !== undefined) {
    receipt.lockfile_sha256 = lockfileSha256
  }
  if (buildSha256 !== undefined) {
    receipt.build_sha256 = buildSha256
  }
  return receipt
}

function requireLifecycleDependencies(dependencies) {
  for (const name of ['preflight', 'build', 'deploy', 'browser', 'cleanup']) {
    if (typeof dependencies?.[name] !== 'function') {
      fail('INVALID_LIFECYCLE_DEPENDENCIES')
    }
  }
}

export async function runDisposablePdfWorkerLifecycle(context, dependencies) {
  requireLifecycleDependencies(dependencies)
  const expectedHead = requireHead(context?.expectedHead)
  const nonce = context?.nonce
  const workerName = createOwnedWorkerName({ expectedHead, nonce })
  const fixture = validateFixturePin(context?.fixture)
  const ownership = { expectedHead, nonce }
  const failures = []
  let stage = 'preflight'
  let deployAttempted = false
  let deploy
  let browser
  let teardown

  try {
    await dependencies.preflight({ expectedHead, workerName, fixture })
    stage = 'build'
    await dependencies.build({ expectedHead, workerName, fixture })
    stage = 'deploy'
    deployAttempted = true
    deploy = validateDeployOutput(
      await dependencies.deploy({ expectedHead, workerName, fixture }),
      ownership,
    )
    stage = 'browser'
    browser = validateBrowserReceipt(
      await dependencies.browser({ expectedHead, workerName, fixture, deploy }),
      {
        ...ownership,
        workerName,
        versionId: deploy.versionId,
        origin: deploy.url,
      },
    )
  } catch (error) {
    failures.push(stageFailure(error, stage))
  } finally {
    if (deployAttempted) {
      try {
        stage = 'cleanup'
        teardown = validateTeardownProof(
          await dependencies.cleanup({ expectedHead, workerName, deploy }),
          ownership,
        )
      } catch (error) {
        failures.push(stageFailure(error, 'cleanup'))
      }
    }
  }

  if (failures.length > 0) {
    throw new DisposablePdfWorkerLifecycleError(failures, deployAttempted)
  }
  return { expectedHead, workerName, fixture, deploy, browser, teardown }
}
