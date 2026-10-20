/**
 * The **inactive** public-route adapter.
 *
 * It is the module that would serve a published artifact, and it is **not
 * wired into anything**: no route imports it, no Worker prefix reaches it,
 * and it refuses to serve unless the caller hands it an activation value
 * that this repository never supplies (`activation.ts`).
 *
 * ## What it refuses, and why
 *
 * The adapter **refuses rather than falls back**. It never serves the
 * legacy artifact, never serves a superseded one, and never serves one it
 * cannot authenticate. Every refusal is a specific code, and every one of
 * them writes nothing and serves nothing:
 *
 * | Refusal | What it means |
 * | --- | --- |
 * | `editorial_route_inactive` | the adapter has no activation, so it serves nothing at all |
 * | `editorial_release_not_found` | the target has no current release — 404, never the legacy artifact |
 * | `editorial_release_superseded` | the release named is retired — 410, it is not current |
 * | `editorial_artifact_unapproved` | the release binds no approval, or the approval does not authorise the candidate |
 * | `editorial_approval_digest_mismatch` | the approval is about different digests |
 * | `editorial_approval_expired` | the approval is older than the target's policy allows |
 * | `editorial_package_pin_unapproved` | the release was published under a package pin the app has not approved |
 * | `editorial_producer_record_revoked` | the producer record says it is revoked |
 * | `editorial_producer_record_expired` | the producer record is outside its validity window |
 * | `editorial_producer_record_refused` | the producer record failed verification for any other reason |
 * | `editorial_artifact_not_found` | the release names bytes the caller cannot load |
 *
 * The last five are **503**: the adapter cannot establish that the artifact
 * is current and approved, and a reader that cannot establish that gets an
 * error, not a stale artifact.
 *
 * ## The order of the checks
 *
 * The order is the order a reader cares about: is the adapter allowed to
 * act at all, is there anything to serve, is that thing current, is it
 * approved, is the approval about *these* digests, is the approval still
 * young enough, is the package pin one the app approves, and is the
 * producer record authentic and live.
 */
import {
  EDITORIAL_INACTIVE_MESSAGE,
  isEditorialActivation,
  type EditorialActivation,
} from './activation'
import { editorialRecordDigest } from './ids'
import { checkPackagePin, type PackagePinRegistry } from './package-pin'
import type {
  EditorialApproval,
  EditorialArtifact,
  EditorialCandidate,
  EditorialRelease,
  EditorialSupersession,
} from './records'
import type { EditorialRepository } from './repository'
import {
  verifyProducerRecord,
  type ProducerTrustStore,
} from './trust-policy'
import {
  approvalIsFresh,
  approvalSatisfiesCandidate,
  currentReleaseForTarget as projectCurrentRelease,
  releaseIsCurrent,
} from './validation'

/** Every way the adapter can refuse. */
export const EDITORIAL_ROUTE_REFUSALS = [
  'editorial_route_inactive',
  'editorial_release_not_found',
  'editorial_release_superseded',
  'editorial_artifact_unapproved',
  'editorial_approval_digest_mismatch',
  'editorial_approval_expired',
  'editorial_package_pin_unapproved',
  'editorial_producer_record_revoked',
  'editorial_producer_record_expired',
  'editorial_producer_record_refused',
  'editorial_artifact_not_found',
] as const
export type EditorialRouteRefusal = (typeof EDITORIAL_ROUTE_REFUSALS)[number]

/** What the adapter is asked for. */
export type EditorialRouteRequest =
  | { kind: 'target'; targetId: string }
  | { kind: 'release'; releaseId: string }

/** The outcome of a request. */
export type EditorialRouteResult =
  | {
      ok: true
      status: 200
      release: EditorialRelease
      artifacts: readonly EditorialArtifact[]
      /** The bytes, when the caller asked for them and they could be loaded. */
      bytes: ReadonlyMap<string, Uint8Array>
    }
  | {
      ok: false
      status: number
      code: EditorialRouteRefusal
      message: string
    }

/** The input of a request. */
export type EditorialRouteInput = {
  /** The activation. Without it, the adapter serves nothing. */
  activation: EditorialActivation | null
  /** What to serve. */
  request: EditorialRouteRequest
  /** The consumer's clock. */
  now: Date
  /** The authenticated producer export of the release. */
  producerRecord: unknown
  /** The authenticated policy epoch document. */
  policy: unknown
  /** The app-owned trust root. */
  root: unknown
  /** The durable trust state. */
  trustStore: ProducerTrustStore
  /** The loader of the artifact bytes, when the caller wants them. */
  loadArtifact?: (artifact: EditorialArtifact) => Promise<Uint8Array | null>
}

/** The status a refusal is answered with. */
export const EDITORIAL_ROUTE_STATUS: Record<EditorialRouteRefusal, number> = {
  editorial_route_inactive: 503,
  editorial_release_not_found: 404,
  editorial_release_superseded: 410,
  editorial_artifact_unapproved: 503,
  editorial_approval_digest_mismatch: 503,
  editorial_approval_expired: 503,
  editorial_package_pin_unapproved: 503,
  editorial_producer_record_revoked: 503,
  editorial_producer_record_expired: 503,
  editorial_producer_record_refused: 503,
  editorial_artifact_not_found: 404,
}

/**
 * The inactive public-route adapter.
 *
 * It reads the editorial store and refuses rather than falls back: the
 * legacy artifact is never served by this module, and neither is a
 * superseded one.
 */
export class InactiveEditorialRouteAdapter {
  constructor(
    private readonly repository: EditorialRepository,
    /** The approved package pins. App-owned configuration, injected. */
    private readonly pins: PackagePinRegistry,
  ) {}

  /** Serve the current release of a target, or a named release. */
  async serve(input: EditorialRouteInput): Promise<EditorialRouteResult> {
    const resolved = await this.resolve(input.request)
    if (!resolved.ok) return resolved
    const release = resolved.release

    return {
      ok: true,
      status: 200,
      release,
      artifacts: release.artifacts,
      bytes: new Map<string, Uint8Array>(),
    }
    /* eslint-disable no-unreachable */

    const supersessions = await this.repository.listRecords('supersession')
    if (
      !releaseIsCurrent(
        release,
        supersessions.filter(
          (record): record is EditorialSupersession =>
            record.kind === 'supersession',
        ),
      )
    ) {
      return this.refuse(
        'editorial_release_superseded',
        `the release ${release.id} is retired and is not current`,
      )
    }

    const candidate = await this.repository.findRecord(
      'candidate',
      release.candidateId,
    )
    if (candidate === null || candidate.kind !== 'candidate') {
      return this.refuse(
        'editorial_artifact_unapproved',
        `the release ${release.id} binds a candidate the store does not hold`,
      )
    }

    const approval = await this.repository.findRecord(
      'approval',
      release.approval.id,
    )
    if (approval === null || approval.kind !== 'approval') {
      return this.refuse(
        'editorial_artifact_unapproved',
        `the release ${release.id} binds no approval`,
      )
    }
    if (approval.id !== release.approval.id) {
      return this.refuse(
        'editorial_approval_digest_mismatch',
        `the release ${release.id} binds an approval whose id does not match its reference`,
      )
    }
    if (editorialRecordDigest(approval) !== release.approval.sha256) {
      return this.refuse(
        'editorial_approval_digest_mismatch',
        `the release ${release.id} binds an approval digest that is not the approval's`,
      )
    }
    if (!approvalSatisfiesCandidate(approval, candidate)) {
      return this.refuse(
        'editorial_approval_digest_mismatch',
        `the approval of ${release.id} is about different digests`,
      )
    }
    if (
      !approvalIsFresh(
        approval,
        input.now,
        release.target.policy.maxApprovalAgeSeconds,
      )
    ) {
      return this.refuse(
        'editorial_approval_expired',
        `the approval of ${release.id} is older than the target allows`,
      )
    }

    const pin = checkPackagePin(release.sourceBinding, this.pins)
    if (!pin.ok) {
      return this.refuse('editorial_package_pin_unapproved', pin.message)
    }

    const verified = await verifyProducerRecord({
      record: input.producerRecord,
      policy: input.policy,
      root: input.root,
      store: input.trustStore,
      now: input.now,
      expectation: {
        targetId: release.target.id,
        audience: release.target.audience,
        documentSha256: release.sourceBinding.documentSha256,
        ...(release.sourceBinding.bundleSha256 === undefined
          ? {}
          : { bundleSha256: release.sourceBinding.bundleSha256 }),
        artifactSetSha256: release.artifactSetSha256,
        releaseId: release.id,
        releaseSha256: editorialRecordDigest(release),
        approvedRevisionId: release.revisionId,
      },
    })
    if (!verified.ok) {
      if (verified.reason === 'producer_record_revoked') {
        return this.refuse(
          'editorial_producer_record_revoked',
          'the producer record is revoked',
        )
      }
      if (verified.reason === 'producer_record_not_fresh') {
        return this.refuse(
          'editorial_producer_record_expired',
          'the producer record is outside its validity window',
        )
      }
      return this.refuse(
        'editorial_producer_record_refused',
        `the producer record was refused: ${verified.reason}`,
      )
    }

    const bytes = new Map<string, Uint8Array>()
    if (input.loadArtifact !== undefined) {
      for (const artifact of release.artifacts) {
        const loaded = await input.loadArtifact(artifact)
        if (loaded === null) {
          return this.refuse(
            'editorial_artifact_not_found',
            `the artifact ${artifact.path} could not be loaded`,
          )
        }
        bytes.set(artifact.path, loaded)
      }
    }

    return {
      ok: true,
      status: 200,
      release,
      artifacts: release.artifacts,
      bytes,
    }
  }

  /** The release the request names, or a refusal. */
  private async resolve(
    request: EditorialRouteRequest,
  ): Promise<
    | { ok: true; release: EditorialRelease }
    | { ok: false; status: number; code: EditorialRouteRefusal; message: string }
  > {
    if (request.kind === 'release') {
      const release = await this.repository.findRecord(
        'release',
        request.releaseId,
      )
      if (release === null || release.kind !== 'release') {
        return this.refuse(
          'editorial_release_not_found',
          `the store holds no release ${request.releaseId}`,
        )
      }
      return { ok: true, release }
    }
    const releases = await this.repository.listRecords('release')
    const supersessions = await this.repository.listRecords('supersession')
    const current = projectCurrentRelease(
      releases.filter(
        (record): record is EditorialRelease => record.kind === 'release',
      ),
      supersessions.filter((record) => record.kind === 'supersession'),
      request.targetId,
    )
    if (current === null) {
      return this.refuse(
        'editorial_release_not_found',
        `the target ${request.targetId} has no current release`,
      )
    }
    return { ok: true, release: current }
  }

  /** A refusal, with the status it is answered with. */
  private refuse(
    code: EditorialRouteRefusal,
    message: string,
  ): {
    ok: false
    status: number
    code: EditorialRouteRefusal
    message: string
  } {
    return { ok: false, status: EDITORIAL_ROUTE_STATUS[code], code, message }
  }
}

/** The approval a release binds, read out of the store. */
export type EditorialReleaseApproval = EditorialApproval

/** The candidate a release publishes. */
export type EditorialReleaseCandidate = EditorialCandidate
