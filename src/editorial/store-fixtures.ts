/**
 * The fixtures the editorial store, writer and route adapter tests share.
 *
 * They are built on E05a's `fixtures.ts` — the same records, minted through
 * the same path — so a fixture can never carry an id, a digest or a pin
 * that its own content does not produce. What this module adds is the
 * **package pin registry** the store is given, and the chains the writer
 * walks end to end.
 */
import { deriveEditorialId } from './ids'
import {
  APPROVER,
  ARTIFACTS,
  EDITOR,
  PACKAGE_ARTIFACT,
  PACKAGE_ARTIFACT_SHA256,
  PACKAGE_INTEGRITY,
  PACKAGE_SOURCE_COMMIT,
  PACKAGE_VERSION,
  REVIEWER,
  TOOL,
  approvalFixture,
  candidateFixture,
  decisionFixture,
  releaseFixture,
  revisionFixture,
  validationFixture,
} from './fixtures'
import type { ApprovedPackagePin } from './package-pin'
import type { EditorialActivation } from './activation'
import type { InactiveEditorialWriter } from './writer'
import type {
  EditorialApproval,
  EditorialCandidate,
  EditorialDecision,
  EditorialRelease,
  EditorialRevision,
  EditorialValidation,
  EditorialValidationCheck,
} from './records'
import { MANDATORY_VALIDATION_CHECKS } from './records'

/**
 * The pin the fixtures are cut under.
 *
 * It is E05a's fixture pin: the same Struct commit and artifact as the
 * app's own pin, with the fixture's stand-in artifact digest. The fixtures
 * are the app's records, so they carry the app's pin.
 */
export const FIXTURE_PACKAGE_PIN: ApprovedPackagePin = {
  sourceCommit: PACKAGE_SOURCE_COMMIT,
  artifact: PACKAGE_ARTIFACT,
  artifactSha256: PACKAGE_ARTIFACT_SHA256,
  integrity: PACKAGE_INTEGRITY,
  version: PACKAGE_VERSION,
  sequence: 2,
}

/** A pin that is older than the fixture's: the downgrade. */
export const OLDER_PACKAGE_PIN: ApprovedPackagePin = {
  sourceCommit: '1111111111111111111111111111111111111111',
  artifact:
    'erniesg-struct-0.0.0-1111111111111111111111111111111111111111.tgz',
  artifactSha256: 'a'.repeat(64),
  integrity: 'sha512-older-package-pin',
  version: '0.0.0',
  sequence: 1,
}

/** A pin that is newer than the fixture's: the re-pin. */
export const NEWER_PACKAGE_PIN: ApprovedPackagePin = {
  sourceCommit: '2222222222222222222222222222222222222222',
  artifact:
    'erniesg-struct-0.0.0-2222222222222222222222222222222222222222.tgz',
  artifactSha256: 'b'.repeat(64),
  integrity: 'sha512-newer-package-pin',
  version: '0.0.0',
  sequence: 3,
}

/** A pin the app has never approved. */
export const UNAPPROVED_PACKAGE_PIN: ApprovedPackagePin = {
  sourceCommit: '3333333333333333333333333333333333333333',
  artifact:
    'erniesg-struct-0.0.0-3333333333333333333333333333333333333333.tgz',
  artifactSha256: 'c'.repeat(64),
  integrity: 'sha512-unapproved-package-pin',
  version: '0.0.0',
  sequence: 4,
}

/**
 * The registry the fixtures run against.
 *
 * The fixture pin is the current one, so the pipeline works; the older pin
 * is in the registry, so a downgrade is a *downgrade* rather than an
 * unapproved pin; the unapproved pin is not in it.
 */
export function fixturePinRegistry(): {
  pins: readonly ApprovedPackagePin[]
} {
  return { pins: [OLDER_PACKAGE_PIN, FIXTURE_PACKAGE_PIN] }
}

/** A revision cut under a different pin. */
export function revisionWithPin(
  revision: EditorialRevision,
  pin: ApprovedPackagePin,
): EditorialRevision {
  const withoutId = {
    ...revision,
    sourceBinding: {
      ...revision.sourceBinding,
      packageSourceCommit: pin.sourceCommit,
      packageArtifact: pin.artifact,
      packageArtifactSha256: pin.artifactSha256,
      packageIntegrity: pin.integrity,
      packageVersion: pin.version,
    },
  }
  return { ...withoutId, id: deriveEditorialId(withoutId) }
}

/** The whole chain, from a cut of the content to a published release. */
export type ReleaseChain = {
  revision: EditorialRevision
  decision: EditorialDecision
  candidate: EditorialCandidate
  validations: EditorialValidation[]
  approval: EditorialApproval
  release: EditorialRelease
}

/**
 * The chain the writer walks, with every mandatory check satisfied.
 *
 * The human review is recorded by a reviewer and the other three by a
 * tool, because that is what the state machine requires of them.
 */
export function releaseChainFixture(
  overrides: {
    revision?: EditorialRevision
    candidate?: EditorialCandidate
    artifacts?: typeof ARTIFACTS
  } = {},
): ReleaseChain {
  const revision = overrides.revision ?? revisionFixture()
  const decision = decisionFixture(revision)
  const candidate =
    overrides.candidate ?? candidateFixture(revision, { artifacts: overrides.artifacts })
  const validations = MANDATORY_VALIDATION_CHECKS.map((check) =>
    validationFixture(candidate, {
      check: check as EditorialValidationCheck,
      actor: check === 'human-review' ? REVIEWER : TOOL,
    }),
  )
  const approval = approvalFixture(candidate)
  const release = releaseFixture(revision, candidate, validations, approval)
  return { revision, decision, candidate, validations, approval, release }
}

/** The actor the fixtures write with, per action. */
export const FIXTURE_ACTORS = {
  editor: EDITOR,
  reviewer: REVIEWER,
  approver: APPROVER,
  tool: TOOL,
} as const

/**
 * Write a whole chain into a store, in the order the pipeline writes it.
 *
 * Every write is checked: a chain that does not write is a broken fixture,
 * not a broken writer.
 */
export async function publishChain(
  writer: InactiveEditorialWriter,
  chain: ReleaseChain,
  activation: EditorialActivation,
  now: string,
): Promise<void> {
  const revision = await writer.proposeRevision({
    activation,
    actor: chain.revision.author,
    now,
    record: chain.revision,
  })
  if (!revision.ok) {
    throw new Error(`the fixture chain did not propose: ${revision.refusal.code}`)
  }
  const decision = await writer.recordDecision({
    activation,
    actor: chain.decision.actor,
    now,
    record: chain.decision,
  })
  if (!decision.ok) {
    throw new Error(`the fixture chain did not decide: ${decision.refusal.code}`)
  }
  const candidate = await writer.assembleCandidate({
    activation,
    actor: chain.candidate.author,
    now,
    record: chain.candidate,
  })
  if (!candidate.ok) {
    throw new Error(
      `the fixture chain did not assemble: ${candidate.refusal.code}`,
    )
  }
  for (const validation of chain.validations) {
    const written = await writer.recordValidation({
      activation,
      actor: validation.actor,
      now,
      record: validation,
    })
    if (!written.ok) {
      throw new Error(
        `the fixture chain did not validate: ${written.refusal.code}`,
      )
    }
  }
  const approval = await writer.recordApproval({
    activation,
    actor: chain.approval.actor,
    now,
    record: chain.approval,
  })
  if (!approval.ok) {
    throw new Error(`the fixture chain did not approve: ${approval.refusal.code}`)
  }
  const release = await writer.recordRelease({
    activation,
    actor: chain.release.producer,
    now,
    record: chain.release,
  })
  if (!release.ok) {
    throw new Error(`the fixture chain did not release: ${release.refusal.code}`)
  }
}
