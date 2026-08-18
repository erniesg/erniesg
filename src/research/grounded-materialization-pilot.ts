import {
  verifyActualProfiledEpubRender,
  verifyEpubCheckReceipt,
  type ActualProfiledEpubRender,
  type EpubCheckReceipt,
} from './actual-profiled-epub'
import {
  compareGroundedProfiledEpub,
  type GroundedProfiledEpubComparison,
} from './grounded-epub-comparison'
import {
  verifyGroundedCoreMaterializationBinding,
  type GroundedStructMaterialization,
} from './grounded-struct-materializer'
import {
  CLOSED_RECONSTRUCTION_PROFILE_IDS,
  createClosedThreeProfileReconstructionReceipt,
  type ClosedThreeProfileReconstructionReceipt,
  type ProfiledStructEpubArtifact,
} from './reconstruction-materialization'
import {
  canonicalTraceJson,
  hashTraceValue,
  parseReconstructionAttemptTrace,
  type ReconstructionAttemptTrace,
} from './reconstruction-attempt-trace'
import { sha256HexSync } from './sha256-sync'
import type { SourceEvidenceContract } from './source-evidence-contract'

export const GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION = '1.0.0' as const

export const GROUNDED_MATERIALIZATION_PILOT_CASES = [
  'prose-hierarchy',
  'semantic-table-spans',
  'formula-text',
  'source-backed-figure',
  'link-destinations',
] as const

export type GroundedMaterializationPilotCase =
  (typeof GROUNDED_MATERIALIZATION_PILOT_CASES)[number]

export type GroundedMaterializationPilotProfile = {
  build: ProfiledStructEpubArtifact
  render: ActualProfiledEpubRender
  epubCheck: EpubCheckReceipt
  comparison: GroundedProfiledEpubComparison
  trace: ReconstructionAttemptTrace
}

export type GroundedMaterializationPilotDocument = {
  caseId: GroundedMaterializationPilotCase
  sourcePdfBytes: Uint8Array
  materialization: GroundedStructMaterialization
  sourceContract: SourceEvidenceContract
  profiles: GroundedMaterializationPilotProfile[]
  outerReceipt: ClosedThreeProfileReconstructionReceipt
}

export type GroundedMaterializationPilotPacket = {
  schemaVersion: typeof GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION
  documents: GroundedMaterializationPilotDocument[]
  negativeControls: Array<{
    id: 'malformed-source-evidence'
    status: 'rejected'
    reason: string
  }>
}

export type GroundedMaterializationPilotReceipt = {
  schemaVersion: typeof GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION
  caseIds: typeof GROUNDED_MATERIALIZATION_PILOT_CASES
  documentCount: 5
  profileCount: 15
  documents: Array<{
    caseId: GroundedMaterializationPilotCase
    sourcePdfSha256: string
    materializationReceiptSha256: string
    outerReceiptSha256: string
    profiles: Array<{
      profileId: ProfiledStructEpubArtifact['profileId']
      epubSha256: string
      renderReceiptSha256: string
      epubCheckReceiptSha256: string
      comparisonReceiptSha256: string
      traceSha256: string
    }>
  }>
  negativeControlReceiptSha256: string
  status: 'passed'
  receiptSha256: string
}

function invalid(code: string): never {
  throw new Error(code)
}

function assertCaseSemantics(document: GroundedMaterializationPilotDocument) {
  const { blocks, assets, relationships } = document.materialization.document
  switch (document.caseId) {
    case 'prose-hierarchy':
      if (blocks.filter(({ kind }) => kind === 'heading').length < 2)
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      return
    case 'semantic-table-spans':
      if (
        !blocks.some(
          ({ kind, table }) =>
            kind === 'table' &&
            table?.semantic === 'verified' &&
            table.cells.some(
              ({ rowSpan, columnSpan }) => rowSpan > 1 || columnSpan > 1,
            ),
        )
      ) {
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      }
      return
    case 'formula-text':
      if (
        !blocks.some(
          ({ kind, text }) => kind === 'equation' && text.trim().length > 0,
        ) ||
        document.materialization.receipt.reviewReasons.includes(
          'formula-visual-crop',
        )
      ) {
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      }
      return
    case 'source-backed-figure':
      if (
        !blocks.some(
          ({ kind, fallbackAssetIds }) =>
            kind === 'figure' &&
            (fallbackAssetIds ?? []).some((id) =>
              assets.some(
                (asset) =>
                  asset.id === id &&
                  (asset.kind === 'figure' || asset.kind === 'diagram') &&
                  asset.fallback === 'asset',
              ),
            ),
        )
      ) {
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      }
      return
    case 'link-destinations':
      if (
        !relationships.some(
          ({ kind, status, to }) =>
            kind === 'hyperlink' && status === 'matched' && to.length === 1,
        )
      ) {
        invalid('PILOT_CASE_SEMANTICS_MISMATCH')
      }
  }
}

function verifyDocument(document: GroundedMaterializationPilotDocument) {
  if (
    document.materialization.document.schemaVersion !== '0.2.0' ||
    document.materialization.receipt.status !== 'publication-ready' ||
    document.materialization.receipt.reviewReasons.length !== 0 ||
    new TextDecoder().decode(document.sourcePdfBytes.slice(0, 5)) !== '%PDF-' ||
    sha256HexSync(document.sourcePdfBytes) !==
      document.materialization.receipt.sourcePdfSha256 ||
    document.sourceContract.graphArtifact.sha256 !==
      document.materialization.receipt.sourceEvidenceGraphSha256 ||
    document.profiles.length !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length
  ) {
    invalid('INVALID_GROUNDED_MATERIALIZATION_PILOT_DOCUMENT')
  }
  verifyGroundedCoreMaterializationBinding(document.materialization)
  assertCaseSemantics(document)
  const byProfile = new Map(
    document.profiles.map((profile) => [profile.build.profileId, profile]),
  )
  if (
    byProfile.size !== CLOSED_RECONSTRUCTION_PROFILE_IDS.length ||
    CLOSED_RECONSTRUCTION_PROFILE_IDS.some((id) => !byProfile.has(id))
  ) {
    invalid('INCOMPLETE_GROUNDED_MATERIALIZATION_PILOT_PROFILE_SET')
  }
  for (const profileId of CLOSED_RECONSTRUCTION_PROFILE_IDS) {
    const profile = byProfile.get(profileId)!
    verifyActualProfiledEpubRender(profile.render)
    verifyEpubCheckReceipt(profile.epubCheck)
    const replayed = compareGroundedProfiledEpub({
      materialization: document.materialization,
      sourceContract: document.sourceContract,
      build: profile.build,
      render: profile.render,
      epubCheck: profile.epubCheck,
    })
    const trace = parseReconstructionAttemptTrace(profile.trace)
    if (
      replayed.receiptSha256 !== profile.comparison.receiptSha256 ||
      trace.comparator.status !== 'publication-ready' ||
      trace.comparator.failed !== 0 ||
      trace.epub.bytes.sha256 !== profile.build.epub.sha256 ||
      hashTraceValue(trace.comparator) !==
        hashTraceValue(profile.comparison.comparator)
    ) {
      invalid('GROUNDED_MATERIALIZATION_PILOT_REPLAY_MISMATCH')
    }
  }
  const traces = Object.fromEntries(
    CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) => [
      profileId,
      byProfile.get(profileId)!.trace,
    ]),
  ) as Record<
    ProfiledStructEpubArtifact['profileId'],
    ReconstructionAttemptTrace
  >
  const builds = CLOSED_RECONSTRUCTION_PROFILE_IDS.map(
    (profileId) => byProfile.get(profileId)!.build,
  )
  const reopenedOuter = createClosedThreeProfileReconstructionReceipt({
    attempts: [
      {
        canonicalStructSha256:
          document.materialization.receipt.canonicalStruct.sha256,
        materializationReceipt: document.materialization.receipt,
        traces,
        builds,
      },
    ],
  })
  if (
    canonicalTraceJson(reopenedOuter) !==
    canonicalTraceJson(document.outerReceipt)
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_OUTER_RECEIPT_MISMATCH')
  }
  return { byProfile, builds }
}

export function verifyGroundedMaterializationPilotPacket(
  packet: GroundedMaterializationPilotPacket,
): GroundedMaterializationPilotReceipt {
  if (
    packet.schemaVersion !== GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION ||
    packet.documents.length !== GROUNDED_MATERIALIZATION_PILOT_CASES.length ||
    packet.negativeControls.length !== 1 ||
    packet.negativeControls[0]?.id !== 'malformed-source-evidence' ||
    packet.negativeControls[0].status !== 'rejected' ||
    packet.negativeControls[0].reason.trim().length === 0
  ) {
    invalid('INVALID_GROUNDED_MATERIALIZATION_PILOT_PACKET')
  }
  const byCase = new Map(
    packet.documents.map((document) => [document.caseId, document]),
  )
  if (
    byCase.size !== GROUNDED_MATERIALIZATION_PILOT_CASES.length ||
    GROUNDED_MATERIALIZATION_PILOT_CASES.some((id) => !byCase.has(id)) ||
    new Set(
      packet.documents.map(
        ({ materialization }) => materialization.receipt.sourcePdfSha256,
      ),
    ).size !== GROUNDED_MATERIALIZATION_PILOT_CASES.length
  ) {
    invalid('GROUNDED_MATERIALIZATION_PILOT_REQUIRES_FIVE_UNIQUE_SUCCESSES')
  }
  const documents = GROUNDED_MATERIALIZATION_PILOT_CASES.map((caseId) => {
    const document = byCase.get(caseId)!
    const { byProfile } = verifyDocument(document)
    return {
      caseId,
      sourcePdfSha256: document.materialization.receipt.sourcePdfSha256,
      materializationReceiptSha256:
        document.materialization.receipt.receiptSha256,
      outerReceiptSha256: document.outerReceipt.receiptSha256,
      profiles: CLOSED_RECONSTRUCTION_PROFILE_IDS.map((profileId) => {
        const profile = byProfile.get(profileId)!
        return {
          profileId,
          epubSha256: profile.build.epub.sha256,
          renderReceiptSha256: profile.render.receiptSha256,
          epubCheckReceiptSha256: profile.epubCheck.receiptSha256,
          comparisonReceiptSha256: profile.comparison.receiptSha256,
          traceSha256: profile.trace.traceSha256,
        }
      }),
    }
  })
  const projection = {
    schemaVersion: GROUNDED_MATERIALIZATION_PILOT_SCHEMA_VERSION,
    caseIds: GROUNDED_MATERIALIZATION_PILOT_CASES,
    documentCount: 5 as const,
    profileCount: 15 as const,
    documents,
    negativeControlReceiptSha256: hashTraceValue(packet.negativeControls[0]),
    status: 'passed' as const,
  }
  return { ...projection, receiptSha256: hashTraceValue(projection) }
}
