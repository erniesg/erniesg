import { strFromU8, unzipSync } from 'fflate'
import { buildStructEpub } from '../struct/epub'
import type { StructDocument } from '../struct/types'
import type { GroundedStructMaterializationReceipt } from './grounded-struct-materializer'
import {
  DETERMINISTIC_CHECK_IDS,
  canonicalTraceJson,
  hashTraceValue,
  parseReconstructionAttemptTrace,
  parseReconstructionAttemptTraceLineage,
  type DeterministicCheckId,
  type HashedArtifact,
  type ReconstructionAttemptTrace,
} from './reconstruction-attempt-trace'
import { profileEpubCss } from './epub'
import { sha256HexSync } from './sha256-sync'
import {
  TARGET_PROFILE_VERSION,
  resolveTargetProfile,
  type TargetProfile,
} from './targets'

export const RECONSTRUCTION_MATERIALIZATION_SCHEMA_VERSION = '1.0.0' as const
export const CLOSED_RECONSTRUCTION_PROFILE_IDS = [
  'mobile',
  'paperProMove',
  'paperPro',
] as const

export type ClosedReconstructionProfileId =
  (typeof CLOSED_RECONSTRUCTION_PROFILE_IDS)[number]

export type ProfiledStructEpubArtifact = {
  profileId: ClosedReconstructionProfileId
  profileVersion: typeof TARGET_PROFILE_VERSION
  profileConfigurationSha256: string
  canonicalStruct: HashedArtifact
  epub: HashedArtifact
  embeddedProfileReceiptSha256: string
  bytes: Uint8Array
  receiptSha256: string
}

export type ReconstructionHardCheck = {
  check: DeterministicCheckId
  status: 'passed' | 'failed'
  expectedSha256: string
  actualSha256: string
}

export type ReconstructionHardCheckVector = {
  schemaVersion: typeof RECONSTRUCTION_MATERIALIZATION_SCHEMA_VERSION
  profileId: ClosedReconstructionProfileId
  traceSha256: string
  sourcePdfSha256: string
  sourceEvidenceGraphSha256: string
  canonicalStructSha256: string
  epubSha256: string
  comparatorSha256: string
  checks: ReconstructionHardCheck[]
  passedCount: number
  failedCount: number
  firstCause: {
    failureId: string
    check: DeterministicCheckId
  } | null
  vectorSha256: string
}

export type ReconstructionMonotonicTransition = {
  schemaVersion: typeof RECONSTRUCTION_MATERIALIZATION_SCHEMA_VERSION
  declaredFirstCause: {
    profileId: ClosedReconstructionProfileId
    failureId: string
    check: DeterministicCheckId
  }
  baselineVectorSetSha256: string
  resultingVectorSetSha256: string
  metric: {
    id: 'passed-hard-check-count'
    before: number
    after: number
  }
  status: 'accepted'
  receiptSha256: string
}

export type ClosedThreeProfileAttempt = {
  canonicalStructSha256: string
  materializationReceipt: GroundedStructMaterializationReceipt
  traces: Record<ClosedReconstructionProfileId, ReconstructionAttemptTrace>
  builds: readonly ProfiledStructEpubArtifact[]
}

export type ClosedThreeProfileReconstructionReceipt = {
  schemaVersion: typeof RECONSTRUCTION_MATERIALIZATION_SCHEMA_VERSION
  sourcePdfSha256: string
  sourceEvidenceGraphSha256: string
  profileIds: typeof CLOSED_RECONSTRUCTION_PROFILE_IDS
  baselineVectorSetSha256: string
  transitions: ReconstructionMonotonicTransition[]
  finalCanonicalStructSha256: string
  finalMaterializationReceiptSha256: string
  finalProfiles: Array<{
    profileId: ClosedReconstructionProfileId
    traceSha256: string
    epubSha256: string
    profileConfigurationSha256: string
    buildReceiptSha256: string
  }>
  status: 'publication-ready'
  receiptSha256: string
}

function artifact(bytes: Uint8Array): HashedArtifact {
  return { sha256: sha256HexSync(bytes), byteLength: bytes.byteLength }
}

function profileConfiguration(profile: TargetProfile, css: string) {
  return hashTraceValue({ profile, css })
}

function profileBuildProjection(
  value: Omit<ProfiledStructEpubArtifact, 'bytes' | 'receiptSha256'>,
) {
  return value
}

function exactProfile(id: ClosedReconstructionProfileId) {
  const profile = resolveTargetProfile(id)
  if (
    profile.id !== id ||
    profile.version !== TARGET_PROFILE_VERSION ||
    profile.artifact.format !== 'epub' ||
    profile.artifact.renderer !== 'local-profiled-epub'
  ) {
    throw new Error('INVALID_RECONSTRUCTION_TARGET_PROFILE')
  }
  return profile
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build and reopen the exact three publication EPUBs from one immutable STRUCT.
 * This is package materialization only; rendering, comparison, and EPUBCheck
 * remain required before the outer receipt can become publication-ready.
 */
export async function buildExactThreeProfileStructEpubs(
  document: StructDocument,
  canonicalStructBytes: Uint8Array,
) {
  const canonicalStruct = artifact(canonicalStructBytes)
  const parsedCanonicalStruct = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(canonicalStructBytes),
  )
  if (
    canonicalTraceJson(parsedCanonicalStruct) !==
      new TextDecoder().decode(canonicalStructBytes) ||
    !isRecord(parsedCanonicalStruct) ||
    !isRecord(parsedCanonicalStruct.receipt) ||
    parsedCanonicalStruct.receipt.generatedSha256 !==
      document.receipt.generatedSha256
  ) {
    throw new Error('INVALID_CANONICAL_STRUCT_MATERIALIZATION')
  }
  const results: ProfiledStructEpubArtifact[] = []
  for (const profileId of CLOSED_RECONSTRUCTION_PROFILE_IDS) {
    const profile = exactProfile(profileId)
    const css = profileEpubCss(profile)
    const profileConfigurationSha256 = profileConfiguration(profile, css)
    const built = await buildStructEpub(document, {
      profile: {
        id: profile.id,
        version: profile.version,
        fileName: profile.epub.fileName,
        pageProgressionDirection: profile.epub.pageProgressionDirection,
        renditionFlow: profile.epub.renditionFlow,
        configurationSha256: profileConfigurationSha256,
        css,
      },
    })
    const files = unzipSync(built.bytes)
    const embeddedProfileBytes = files['EPUB/profile.json']
    const reopenedCss = files['EPUB/styles.css']
    if (!embeddedProfileBytes || !reopenedCss) {
      throw new Error('PROFILED_EPUB_REOPEN_FAILED')
    }
    const embeddedProfile = JSON.parse(strFromU8(embeddedProfileBytes))
    if (
      embeddedProfile.id !== profile.id ||
      embeddedProfile.version !== profile.version ||
      embeddedProfile.fileName !== profile.epub.fileName ||
      embeddedProfile.configurationSha256 !== profileConfigurationSha256 ||
      embeddedProfile.cssSha256 !== sha256HexSync(reopenedCss) ||
      strFromU8(reopenedCss) !== css ||
      built.sha256 !== sha256HexSync(built.bytes)
    ) {
      throw new Error('PROFILED_EPUB_REOPEN_FAILED')
    }
    const projection = profileBuildProjection({
      profileId,
      profileVersion: TARGET_PROFILE_VERSION,
      profileConfigurationSha256,
      canonicalStruct,
      epub: artifact(built.bytes),
      embeddedProfileReceiptSha256: hashTraceValue(embeddedProfile),
    })
    results.push({
      ...projection,
      bytes: built.bytes,
      receiptSha256: hashTraceValue(projection),
    })
  }
  if (
    new Set(results.map(({ epub }) => epub.sha256)).size !==
    CLOSED_RECONSTRUCTION_PROFILE_IDS.length
  ) {
    throw new Error('PROFILED_EPUB_ARTIFACTS_NOT_DISTINCT')
  }
  return results
}

function hardCheckVectorProjection(
  vector: Omit<ReconstructionHardCheckVector, 'vectorSha256'>,
) {
  return vector
}

export function createReconstructionHardCheckVector(
  profileId: ClosedReconstructionProfileId,
  traceInput: unknown,
): ReconstructionHardCheckVector {
  if (!CLOSED_RECONSTRUCTION_PROFILE_IDS.includes(profileId)) {
    throw new Error('INVALID_RECONSTRUCTION_TARGET_PROFILE')
  }
  const trace = parseReconstructionAttemptTrace(traceInput)
  const checks = DETERMINISTIC_CHECK_IDS.map((check) => {
    const matches = trace.comparator.checkResults.filter(
      (result) => result.origin === 'deterministic' && result.check === check,
    )
    if (matches.length !== 1) {
      throw new Error('INVALID_RECONSTRUCTION_HARD_CHECK_VECTOR')
    }
    const result = matches[0]!
    return {
      check,
      status: result.status,
      expectedSha256: result.expectedSha256,
      actualSha256: result.actualSha256,
    }
  })
  const firstCauseFailure =
    trace.comparator.firstCauseFailureId === null
      ? null
      : trace.comparator.failures.find(
          ({ id }) => id === trace.comparator.firstCauseFailureId,
        )
  if (
    (trace.comparator.firstCauseFailureId !== null && !firstCauseFailure) ||
    (firstCauseFailure !== null &&
      firstCauseFailure !== undefined &&
      firstCauseFailure.origin !== 'deterministic')
  ) {
    throw new Error('INVALID_RECONSTRUCTION_HARD_CHECK_VECTOR')
  }
  const projection = hardCheckVectorProjection({
    schemaVersion: RECONSTRUCTION_MATERIALIZATION_SCHEMA_VERSION,
    profileId,
    traceSha256: trace.traceSha256,
    sourcePdfSha256: trace.sourcePdf.artifact.sha256,
    sourceEvidenceGraphSha256: trace.evidenceGraph.artifact.sha256,
    canonicalStructSha256: trace.structure.artifact.sha256,
    epubSha256: trace.epub.bytes.sha256,
    comparatorSha256: hashTraceValue(trace.comparator),
    checks,
    passedCount: checks.filter(({ status }) => status === 'passed').length,
    failedCount: checks.filter(({ status }) => status === 'failed').length,
    firstCause: firstCauseFailure
      ? { failureId: firstCauseFailure.id, check: firstCauseFailure.check }
      : null,
  })
  return { ...projection, vectorSha256: hashTraceValue(projection) }
}

function vectorSetSha256(vectors: readonly ReconstructionHardCheckVector[]) {
  return hashTraceValue(
    CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) => {
      const vector = vectors.find(
        (candidate) => candidate.profileId === profileId,
      )
      if (!vector) throw new Error('INCOMPLETE_RECONSTRUCTION_PROFILE_SET')
      return { profileId, vectorSha256: vector.vectorSha256 }
    }),
  )
}

function assertValidHardCheckVector(vector: ReconstructionHardCheckVector) {
  const projection = hardCheckVectorProjection({
    schemaVersion: vector.schemaVersion,
    profileId: vector.profileId,
    traceSha256: vector.traceSha256,
    sourcePdfSha256: vector.sourcePdfSha256,
    sourceEvidenceGraphSha256: vector.sourceEvidenceGraphSha256,
    canonicalStructSha256: vector.canonicalStructSha256,
    epubSha256: vector.epubSha256,
    comparatorSha256: vector.comparatorSha256,
    checks: vector.checks,
    passedCount: vector.passedCount,
    failedCount: vector.failedCount,
    firstCause: vector.firstCause,
  })
  if (
    vector.schemaVersion !== RECONSTRUCTION_MATERIALIZATION_SCHEMA_VERSION ||
    !CLOSED_RECONSTRUCTION_PROFILE_IDS.includes(vector.profileId) ||
    vector.checks.length !== DETERMINISTIC_CHECK_IDS.length ||
    vector.passedCount !==
      vector.checks.filter(({ status }) => status === 'passed').length ||
    vector.failedCount !==
      vector.checks.filter(({ status }) => status === 'failed').length ||
    vector.vectorSha256 !== hashTraceValue(projection)
  ) {
    throw new Error('INVALID_RECONSTRUCTION_HARD_CHECK_VECTOR')
  }
  for (const check of DETERMINISTIC_CHECK_IDS) {
    if (
      vector.checks.filter((candidate) => candidate.check === check).length !==
      1
    ) {
      throw new Error('INVALID_RECONSTRUCTION_HARD_CHECK_VECTOR')
    }
  }
  if (
    (vector.firstCause === null) !== (vector.failedCount === 0) ||
    (vector.firstCause !== null &&
      vector.checks.find(({ check }) => check === vector.firstCause!.check)
        ?.status !== 'failed')
  ) {
    throw new Error('INVALID_RECONSTRUCTION_HARD_CHECK_VECTOR')
  }
}

function totalPassed(vectors: readonly ReconstructionHardCheckVector[]) {
  return vectors.reduce((total, vector) => total + vector.passedCount, 0)
}

export function acceptMonotonicReconstructionTransition(
  baseline: readonly ReconstructionHardCheckVector[],
  resulting: readonly ReconstructionHardCheckVector[],
): ReconstructionMonotonicTransition {
  baseline.forEach(assertValidHardCheckVector)
  resulting.forEach(assertValidHardCheckVector)
  const baselineByProfile = new Map(
    baseline.map((vector) => [vector.profileId, vector]),
  )
  const resultingByProfile = new Map(
    resulting.map((vector) => [vector.profileId, vector]),
  )
  if (
    baseline.length !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length ||
    resulting.length !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length ||
    baselineByProfile.size !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length ||
    resultingByProfile.size !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length
  ) {
    throw new Error('INCOMPLETE_RECONSTRUCTION_PROFILE_SET')
  }
  const declaredProfileId = CLOSED_RECONSTRUCTION_PROFILE_IDS.find(
    (profileId) => baselineByProfile.get(profileId)?.firstCause !== null,
  )
  if (!declaredProfileId) {
    throw new Error('RECONSTRUCTION_BASELINE_ALREADY_PASSED')
  }
  const declared = baselineByProfile.get(declaredProfileId)!.firstCause!
  for (const profileId of CLOSED_RECONSTRUCTION_PROFILE_IDS) {
    const before = baselineByProfile.get(profileId)!
    const after = resultingByProfile.get(profileId)!
    if (
      before.sourcePdfSha256 !== after.sourcePdfSha256 ||
      before.sourceEvidenceGraphSha256 !== after.sourceEvidenceGraphSha256
    ) {
      throw new Error('STALE_RECONSTRUCTION_TRANSITION')
    }
    for (const beforeCheck of before.checks) {
      const afterCheck = after.checks.find(
        ({ check }) => check === beforeCheck.check,
      )
      if (!afterCheck)
        throw new Error('INVALID_RECONSTRUCTION_HARD_CHECK_VECTOR')
      if (
        beforeCheck.status === 'passed' &&
        (afterCheck.status !== 'passed' ||
          beforeCheck.expectedSha256 !== afterCheck.expectedSha256)
      ) {
        throw new Error('RECONSTRUCTION_HARD_GATE_REGRESSION')
      }
    }
  }
  const declaredAfter = resultingByProfile
    .get(declaredProfileId)!
    .checks.find(({ check }) => check === declared.check)
  const beforePassed = totalPassed(baseline)
  const afterPassed = totalPassed(resulting)
  if (declaredAfter?.status !== 'passed' || afterPassed <= beforePassed) {
    throw new Error('RECONSTRUCTION_FIRST_CAUSE_NOT_IMPROVED')
  }
  const projection = {
    schemaVersion: RECONSTRUCTION_MATERIALIZATION_SCHEMA_VERSION,
    declaredFirstCause: {
      profileId: declaredProfileId,
      failureId: declared.failureId,
      check: declared.check,
    },
    baselineVectorSetSha256: vectorSetSha256(baseline),
    resultingVectorSetSha256: vectorSetSha256(resulting),
    metric: {
      id: 'passed-hard-check-count' as const,
      before: beforePassed,
      after: afterPassed,
    },
    status: 'accepted' as const,
  }
  return { ...projection, receiptSha256: hashTraceValue(projection) }
}

function validateProfileBuild(
  build: ProfiledStructEpubArtifact,
  canonicalStructSha256: string,
) {
  const profile = exactProfile(build.profileId)
  const css = profileEpubCss(profile)
  const profileConfigurationSha256 = profileConfiguration(profile, css)
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(build.bytes)
  } catch {
    throw new Error('PROFILED_EPUB_REOPEN_FAILED')
  }
  const profileBytes = files['EPUB/profile.json']
  const stylesheetBytes = files['EPUB/styles.css']
  if (!profileBytes || !stylesheetBytes) {
    throw new Error('PROFILED_EPUB_REOPEN_FAILED')
  }
  const profileReceipt = JSON.parse(strFromU8(profileBytes))
  const projection = profileBuildProjection({
    profileId: build.profileId,
    profileVersion: build.profileVersion,
    profileConfigurationSha256: build.profileConfigurationSha256,
    canonicalStruct: build.canonicalStruct,
    epub: build.epub,
    embeddedProfileReceiptSha256: build.embeddedProfileReceiptSha256,
  })
  if (
    build.profileVersion !== TARGET_PROFILE_VERSION ||
    build.profileConfigurationSha256 !== profileConfigurationSha256 ||
    build.canonicalStruct.sha256 !== canonicalStructSha256 ||
    build.epub.sha256 !== sha256HexSync(build.bytes) ||
    build.epub.byteLength !== build.bytes.byteLength ||
    build.receiptSha256 !== hashTraceValue(projection) ||
    strFromU8(stylesheetBytes) !== css ||
    profileReceipt.id !== profile.id ||
    profileReceipt.version !== profile.version ||
    profileReceipt.fileName !== profile.epub.fileName ||
    profileReceipt.configurationSha256 !== profileConfigurationSha256 ||
    profileReceipt.cssSha256 !== sha256HexSync(stylesheetBytes) ||
    build.embeddedProfileReceiptSha256 !== hashTraceValue(profileReceipt)
  ) {
    throw new Error('INVALID_PROFILED_EPUB_BUILD_RECEIPT')
  }
}

function vectorsForAttempt(attempt: ClosedThreeProfileAttempt) {
  if (
    attempt.builds.length !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length ||
    new Set(attempt.builds.map(({ profileId }) => profileId)).size !==
      CLOSED_RECONSTRUCTION_PROFILE_IDS.length ||
    new Set(attempt.builds.map(({ epub }) => epub.sha256)).size !==
      CLOSED_RECONSTRUCTION_PROFILE_IDS.length
  ) {
    throw new Error('INCOMPLETE_RECONSTRUCTION_PROFILE_SET')
  }
  const {
    receiptSha256: materializationReceiptSha256,
    ...materializationProjection
  } = attempt.materializationReceipt
  if (
    attempt.materializationReceipt.status !== 'publication-ready' ||
    attempt.materializationReceipt.reviewReasons.length !== 0 ||
    attempt.materializationReceipt.selections.length === 0 ||
    attempt.materializationReceipt.canonicalStruct.sha256 !==
      attempt.canonicalStructSha256 ||
    materializationReceiptSha256 !== hashTraceValue(materializationProjection)
  ) {
    throw new Error('INVALID_GROUNDED_MATERIALIZATION_RECEIPT')
  }
  return CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) => {
    const trace = parseReconstructionAttemptTrace(attempt.traces[profileId])
    const build = attempt.builds.find(
      (candidate) => candidate.profileId === profileId,
    )!
    validateProfileBuild(build, attempt.canonicalStructSha256)
    if (trace.structure.artifact.sha256 !== attempt.canonicalStructSha256) {
      throw new Error('STALE_RECONSTRUCTION_ATTEMPT_STRUCT')
    }
    if (trace.epub.bytes.sha256 !== build.epub.sha256) {
      throw new Error('RECONSTRUCTION_PROFILE_TRACE_MISMATCH')
    }
    if (
      trace.sourcePdf.artifact.sha256 !==
        attempt.materializationReceipt.sourcePdfSha256 ||
      trace.evidenceGraph.artifact.sha256 !==
        attempt.materializationReceipt.sourceEvidenceGraphSha256 ||
      attempt.materializationReceipt.selections.some(
        (selection) =>
          !trace.evidenceCandidates.some(
            (candidate) =>
              candidate.referenceSha256 ===
                selection.candidateReferenceSha256 &&
              candidate.bindingSha256 === selection.bindingSha256,
          ),
      )
    ) {
      throw new Error('RECONSTRUCTION_MATERIALIZATION_TRACE_MISMATCH')
    }
    return createReconstructionHardCheckVector(profileId, trace)
  })
}

function closedReceiptProjection(
  receipt: Omit<ClosedThreeProfileReconstructionReceipt, 'receiptSha256'>,
) {
  return receipt
}

/** Close all three valid #199 traces into one monotonic publication receipt. */
export function createClosedThreeProfileReconstructionReceipt(input: {
  attempts: readonly ClosedThreeProfileAttempt[]
}): ClosedThreeProfileReconstructionReceipt {
  if (input.attempts.length < 1 || input.attempts.length > 4) {
    throw new Error('MISSING_RECONSTRUCTION_ATTEMPT')
  }
  for (const profileId of CLOSED_RECONSTRUCTION_PROFILE_IDS) {
    parseReconstructionAttemptTraceLineage(
      input.attempts.map((attempt) => attempt.traces[profileId]),
    )
  }
  const vectorHistory = input.attempts.map(vectorsForAttempt)
  const sourcePdfSha256 = vectorHistory[0]![0]!.sourcePdfSha256
  const sourceEvidenceGraphSha256 =
    vectorHistory[0]![0]!.sourceEvidenceGraphSha256
  if (
    vectorHistory
      .flat()
      .some(
        (vector) =>
          vector.sourcePdfSha256 !== sourcePdfSha256 ||
          vector.sourceEvidenceGraphSha256 !== sourceEvidenceGraphSha256,
      )
  ) {
    throw new Error('STALE_RECONSTRUCTION_ATTEMPT_EVIDENCE')
  }
  const transitions = vectorHistory
    .slice(1)
    .map((vectors, index) =>
      acceptMonotonicReconstructionTransition(vectorHistory[index]!, vectors),
    )
  const finalVectors = vectorHistory.at(-1)!
  const finalAttempt = input.attempts.at(-1)!
  if (
    finalVectors.some(
      (vector) => vector.failedCount !== 0 || vector.firstCause !== null,
    )
  ) {
    throw new Error('RECONSTRUCTION_NOT_PUBLICATION_READY')
  }
  const finalProfiles = CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) => {
    const vector = finalVectors.find(
      (candidate) => candidate.profileId === profileId,
    )!
    const build = finalAttempt.builds.find(
      (candidate) => candidate.profileId === profileId,
    )
    if (
      !build ||
      build.canonicalStruct.sha256 !== finalAttempt.canonicalStructSha256 ||
      build.epub.sha256 !== vector.epubSha256 ||
      build.epub.byteLength !== build.bytes.byteLength ||
      build.epub.sha256 !== sha256HexSync(build.bytes)
    ) {
      throw new Error('RECONSTRUCTION_FINAL_ARTIFACT_MISMATCH')
    }
    return {
      profileId,
      traceSha256: vector.traceSha256,
      epubSha256: build.epub.sha256,
      profileConfigurationSha256: build.profileConfigurationSha256,
      buildReceiptSha256: build.receiptSha256,
    }
  })
  const projection = closedReceiptProjection({
    schemaVersion: RECONSTRUCTION_MATERIALIZATION_SCHEMA_VERSION,
    sourcePdfSha256,
    sourceEvidenceGraphSha256,
    profileIds: CLOSED_RECONSTRUCTION_PROFILE_IDS,
    baselineVectorSetSha256: vectorSetSha256(vectorHistory[0]!),
    transitions,
    finalCanonicalStructSha256: finalAttempt.canonicalStructSha256,
    finalMaterializationReceiptSha256:
      finalAttempt.materializationReceipt.receiptSha256,
    finalProfiles,
    status: 'publication-ready',
  })
  return { ...projection, receiptSha256: hashTraceValue(projection) }
}
