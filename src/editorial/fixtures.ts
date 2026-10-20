/**
 * The fixtures the editorial record tests share.
 *
 * Every fixture is built through the same minting path the writer uses
 * (`mintEditorialId`), so a fixture can never carry an id its content does
 * not derive. The digests are real SHA-256 values of labelled strings: they
 * stand in for bytes nobody has produced, and they are stable.
 */
import { createHash } from 'node:crypto'

import {
  deriveEditorialId,
  editorialArtifactSetDigest,
  editorialContentDigest,
  editorialRecordDigest,
} from './ids'
import {
  EDITORIAL_APPROVAL_VERSION,
  EDITORIAL_CANDIDATE_VERSION,
  EDITORIAL_DECISION_VERSION,
  EDITORIAL_RELEASE_VERSION,
  EDITORIAL_REVISION_VERSION,
  EDITORIAL_SUPERSESSION_VERSION,
  EDITORIAL_TARGET_VERSION,
  EDITORIAL_VALIDATION_VERSION,
  MANDATORY_VALIDATION_CHECKS,
  type EditorialActor,
  type EditorialApproval,
  type EditorialArtifact,
  type EditorialCandidate,
  type EditorialCandidateSubject,
  type EditorialDecision,
  type EditorialDecisionOutcome,
  type EditorialHumanActor,
  type EditorialProducerActor,
  type EditorialRelease,
  type EditorialRevision,
  type EditorialSourceBinding,
  type EditorialSupersession,
  type EditorialTarget,
  type EditorialToolActor,
  type EditorialValidation,
  type EditorialValidationCheck,
  type EditorialValidationOutcome,
} from './records'

function digestOf(label: string): string {
  return createHash('sha256').update(label).digest('hex')
}

export const DOCUMENT_SHA256 = digestOf('editorial-fixture/document')
export const OTHER_DOCUMENT_SHA256 = digestOf('editorial-fixture/other-document')
export const BUNDLE_SHA256 = digestOf('editorial-fixture/bundle')
export const SEMANTIC_RECEIPT_SHA256 = digestOf(
  'editorial-fixture/semantic-receipt',
)
export const PACKAGE_SOURCE_COMMIT = '90f76f1f80b037cc065169d07b13779c03420026'
export const PACKAGE_ARTIFACT =
  'erniesg-struct-0.0.0-90f76f1f80b037cc065169d07b13779c03420026.tgz'
export const PACKAGE_ARTIFACT_SHA256 = digestOf('editorial-fixture/package')
export const PACKAGE_INTEGRITY =
  'sha512-0WyBLp2PDZr4pOFYhfe6a1IbuZOuBemiR/alDgx73j8JYKZh7m8UthMsimjXp6wt3gUUiNumvXmykYeccnDUBQ=='
export const PACKAGE_VERSION = '0.0.0'

export const CREATED = '2026-10-20T09:00:00.000Z'
export const LATER = '2026-10-20T10:00:00.000Z'
export const MUCH_LATER = '2026-10-21T10:00:00.000Z'

export const EDITOR: EditorialHumanActor = {
  kind: 'editor',
  principal: 'urn:margin:principal:workos:https%3A%2F%2Fidp.example:editor-1',
  provider: 'workos',
  issuer: 'https://idp.example',
  subject: 'editor-1',
}
export const REVIEWER: EditorialHumanActor = {
  kind: 'reviewer',
  principal: 'urn:margin:principal:workos:https%3A%2F%2Fidp.example:reviewer-1',
  provider: 'workos',
  issuer: 'https://idp.example',
  subject: 'reviewer-1',
}
export const APPROVER: EditorialHumanActor = {
  kind: 'approver',
  principal: 'urn:margin:principal:workos:https%3A%2F%2Fidp.example:approver-1',
  provider: 'workos',
  issuer: 'https://idp.example',
  subject: 'approver-1',
}
export const OTHER_REVIEWER: EditorialHumanActor = {
  kind: 'reviewer',
  principal: 'urn:margin:principal:workos:https%3A%2F%2Fidp.example:reviewer-2',
  provider: 'workos',
  issuer: 'https://idp.example',
  subject: 'reviewer-2',
}
export const OTHER_EDITOR: EditorialHumanActor = {
  kind: 'editor',
  principal: 'urn:margin:principal:workos:https%3A%2F%2Fidp.example:editor-2',
  provider: 'workos',
  issuer: 'https://idp.example',
  subject: 'editor-2',
}
export const TOOL: EditorialToolActor = {
  kind: 'tool',
  toolId: 'epubcheck',
  toolVersion: '5.1.0',
}
export const PRODUCER: EditorialProducerActor = {
  kind: 'producer',
  keyId: 'producer-key-1',
  policyEpoch: 1,
}

export const SCHEMA_VERSIONS = {
  publicationGraph: '1.0.0',
  assetBundle: '1.0.0',
  compositionContext: '1.0.0',
  transformationPolicy: '1.0.0',
  sourceAdapter: '1.0.0',
  targetProfile: '1.1.0',
} as const

export const RENDERING = {
  rendererId: 'vivliostyle',
  rendererVersion: '1.0.0',
  profileIds: ['phone-webpub', 'eink-epub'],
  policyVersions: {
    renderer: '1.0.0',
    semanticHtml: '1.0.0',
    accessibility: '1.0.0',
    transformationPolicy: '1.0.0',
    publicationCheck: '1.0.0',
  },
} as const

export function targetFixture(
  overrides: Partial<EditorialTarget> = {},
): EditorialTarget {
  return {
    version: EDITORIAL_TARGET_VERSION,
    id: 'ernie-sg-production',
    audience: 'public',
    channel: 'web',
    environment: 'production',
    route: '/library/moving-to-cloudflare-with-astro',
    policy: {
      requiredValidationChecks: [...MANDATORY_VALIDATION_CHECKS],
      requireHumanReview: true,
      requireAuthenticatedApproval: true,
      maxApprovalAgeSeconds: 86_400,
    },
    ...overrides,
  }
}

export const ARTIFACTS: readonly EditorialArtifact[] = [
  {
    path: 'eink.epub',
    sha256: digestOf('editorial-fixture/artifact/eink-epub'),
    byteLength: 4096,
    profile: 'eink-epub',
    renderer: 'jszip',
  },
  {
    path: 'phone-webpub/index.html',
    sha256: digestOf('editorial-fixture/artifact/phone-webpub'),
    byteLength: 8192,
    profile: 'phone-webpub',
    renderer: 'semantic-html',
  },
]

export function revisionFixture(
  overrides: {
    documentSha256?: string
    bundleSha256?: string | undefined
    semanticReceiptSha256?: string | undefined
    contentHash?: string
    author?: EditorialActor
    created?: string
  } = {},
): EditorialRevision {
  const documentSha256 = overrides.documentSha256 ?? DOCUMENT_SHA256
  const bundleSha256 =
    overrides.bundleSha256 === undefined
      ? BUNDLE_SHA256
      : overrides.bundleSha256
  const semanticReceiptSha256 =
    overrides.semanticReceiptSha256 === undefined
      ? SEMANTIC_RECEIPT_SHA256
      : overrides.semanticReceiptSha256
  const contentHash =
    overrides.contentHash ??
    editorialContentDigest({
      documentSha256,
      bundleSha256,
      semanticReceiptSha256,
    })
  const withoutId = {
    kind: 'revision' as const,
    version: EDITORIAL_REVISION_VERSION,
    contentHash,
    documentSha256,
    ...(bundleSha256 === undefined ? {} : { bundleSha256 }),
    ...(semanticReceiptSha256 === undefined
      ? {}
      : { semanticReceiptSha256 }),
    sourceBinding: {
      kind: 'struct-cutover' as const,
      documentSha256,
      ...(bundleSha256 === undefined ? {} : { bundleSha256 }),
      ...(semanticReceiptSha256 === undefined
        ? {}
        : { semanticReceiptSha256 }),
      packageSourceCommit: PACKAGE_SOURCE_COMMIT,
      packageArtifact: PACKAGE_ARTIFACT,
      packageArtifactSha256: PACKAGE_ARTIFACT_SHA256,
      packageIntegrity: PACKAGE_INTEGRITY,
      packageVersion: PACKAGE_VERSION,
    },
    schemaVersions: { ...SCHEMA_VERSIONS },
    rendering: { ...RENDERING, profileIds: [...RENDERING.profileIds] },
    author: overrides.author ?? EDITOR,
    created: overrides.created ?? CREATED,
  }
  return { ...withoutId, id: deriveEditorialId(withoutId) }
}

export function decisionFixture(
  revision: EditorialRevision,
  overrides: {
    outcome?: EditorialDecisionOutcome
    actor?: EditorialActor
    rationale?: string
    decidedAt?: string
    contentHash?: string
    documentSha256?: string
    bundleSha256?: string | undefined
    revisionId?: string
  } = {},
): EditorialDecision {
  const bundleSha256 =
    overrides.bundleSha256 === undefined
      ? revision.bundleSha256
      : overrides.bundleSha256
  const withoutId = {
    kind: 'decision' as const,
    version: EDITORIAL_DECISION_VERSION,
    subject: {
      revisionId: overrides.revisionId ?? revision.id,
      contentHash: overrides.contentHash ?? revision.contentHash,
      documentSha256: overrides.documentSha256 ?? revision.documentSha256,
      ...(bundleSha256 === undefined ? {} : { bundleSha256 }),
    },
    outcome: overrides.outcome ?? ('approved' as const),
    actor: overrides.actor ?? REVIEWER,
    ...(overrides.rationale === undefined
      ? {}
      : { rationale: overrides.rationale }),
    decidedAt: overrides.decidedAt ?? LATER,
  }
  return { ...withoutId, id: deriveEditorialId(withoutId) }
}

export function candidateFixture(
  revision: EditorialRevision,
  overrides: {
    target?: EditorialTarget
    artifacts?: readonly EditorialArtifact[]
    requiredValidationChecks?: EditorialValidationCheck[]
    author?: EditorialActor
    created?: string
    contentHash?: string
    documentSha256?: string
    bundleSha256?: string | undefined
  } = {},
): EditorialCandidate {
  const artifacts = [...(overrides.artifacts ?? ARTIFACTS)]
  const target = overrides.target ?? targetFixture()
  const withoutId = {
    kind: 'candidate' as const,
    version: EDITORIAL_CANDIDATE_VERSION,
    revisionId: revision.id,
    contentHash: overrides.contentHash ?? revision.contentHash,
    documentSha256: overrides.documentSha256 ?? revision.documentSha256,
    ...(overrides.bundleSha256 === undefined
      ? revision.bundleSha256 === undefined
        ? {}
        : { bundleSha256: revision.bundleSha256 }
      : { bundleSha256: overrides.bundleSha256 }),
    target,
    artifacts,
    artifactSetSha256: editorialArtifactSetDigest(artifacts),
    requiredValidationChecks: [
      ...(overrides.requiredValidationChecks ?? [
        ...MANDATORY_VALIDATION_CHECKS,
      ]),
    ],
    author: overrides.author ?? EDITOR,
    created: overrides.created ?? LATER,
  }
  return { ...withoutId, id: deriveEditorialId(withoutId) }
}

export function candidateSubjectOf(
  candidate: EditorialCandidate,
): EditorialCandidateSubject {
  return {
    candidateId: candidate.id,
    revisionId: candidate.revisionId,
    contentHash: candidate.contentHash,
    documentSha256: candidate.documentSha256,
    ...(candidate.bundleSha256 === undefined
      ? {}
      : { bundleSha256: candidate.bundleSha256 }),
    targetId: candidate.target.id,
    artifactSetSha256: candidate.artifactSetSha256,
  }
}

export function validationFixture(
  candidate: EditorialCandidate,
  overrides: {
    check?: EditorialValidationCheck
    outcome?: EditorialValidationOutcome
    actor?: EditorialActor
    validatedAt?: string
    subject?: EditorialCandidateSubject
  } = {},
): EditorialValidation {
  const withoutId = {
    kind: 'validation' as const,
    version: EDITORIAL_VALIDATION_VERSION,
    check: overrides.check ?? ('bundle-verification' as const),
    subject: overrides.subject ?? candidateSubjectOf(candidate),
    outcome: overrides.outcome ?? ('passed' as const),
    evidence: {
      tool: overrides.check ?? 'bundle-verification',
      toolVersion: '1.0.0',
      reportSha256: digestOf(
        `editorial-fixture/report/${overrides.check ?? 'bundle-verification'}`,
      ),
    },
    actor: overrides.actor ?? TOOL,
    validatedAt: overrides.validatedAt ?? LATER,
  }
  return { ...withoutId, id: deriveEditorialId(withoutId) }
}

export function approvalFixture(
  candidate: EditorialCandidate,
  overrides: {
    actor?: EditorialActor
    approvedAt?: string
    subject?: EditorialCandidateSubject
    candidateId?: string
  } = {},
): EditorialApproval {
  const withoutId = {
    kind: 'approval' as const,
    version: EDITORIAL_APPROVAL_VERSION,
    candidateId: overrides.candidateId ?? candidate.id,
    subject: overrides.subject ?? candidateSubjectOf(candidate),
    actor: overrides.actor ?? APPROVER,
    approvedAt: overrides.approvedAt ?? LATER,
  }
  return { ...withoutId, id: deriveEditorialId(withoutId) }
}

export function releaseFixture(
  revision: EditorialRevision,
  candidate: EditorialCandidate,
  validations: readonly EditorialValidation[],
  approval: EditorialApproval,
  overrides: {
    producer?: EditorialProducerActor
    releasedAt?: string
    target?: EditorialTarget
    artifacts?: readonly EditorialArtifact[]
    sourceBinding?: EditorialSourceBinding
    revisionId?: string
    artifactSetSha256?: string
    approvalRef?: { id: string; sha256: string }
    validationRefs?: readonly { id: string; sha256: string }[]
  } = {},
): EditorialRelease {
  const artifacts = [...(overrides.artifacts ?? candidate.artifacts)]
  const withoutId = {
    kind: 'release' as const,
    version: EDITORIAL_RELEASE_VERSION,
    candidateId: candidate.id,
    revisionId: overrides.revisionId ?? revision.id,
    contentHash: candidate.contentHash,
    sourceBinding: overrides.sourceBinding ?? revision.sourceBinding,
    schemaVersions: revision.schemaVersions,
    rendering: revision.rendering,
    validations: (
      overrides.validationRefs ??
      validations.map((validation) => ({
        id: validation.id,
        sha256: editorialRecordDigest(validation),
      }))
    ).sort((left, right) => (left.id < right.id ? -1 : 1)),
    approval:
      overrides.approvalRef ?? {
        id: approval.id,
        sha256: editorialRecordDigest(approval),
      },
    target: overrides.target ?? candidate.target,
    artifacts,
    // A release publishes the candidate's artifacts, so the digest it claims
    // is the candidate's. A test that swaps the bytes must say what digest
    // it is claiming.
    artifactSetSha256:
      overrides.artifactSetSha256 ??
      editorialArtifactSetDigest(candidate.artifacts),
    producer: overrides.producer ?? PRODUCER,
    releasedAt: overrides.releasedAt ?? LATER,
  }
  return { ...withoutId, id: deriveEditorialId(withoutId) }
}

export function supersessionFixture(
  release: EditorialRelease,
  overrides: {
    supersedingReleaseId?: string | null
    reason?: EditorialSupersession['reason']
    actor?: EditorialActor
    at?: string
  } = {},
): EditorialSupersession {
  const reason = overrides.reason ?? ('replacement' as const)
  const replaces = reason === 'replacement' || reason === 'correction'
  const supersedingReleaseId =
    overrides.supersedingReleaseId === undefined
      ? replaces
        ? `urn:editorial:release:${digestOf('editorial-fixture/replacement')}`
        : null
      : overrides.supersedingReleaseId
  const withoutId = {
    kind: 'supersession' as const,
    version: EDITORIAL_SUPERSESSION_VERSION,
    subjectReleaseId: release.id,
    supersedingReleaseId,
    reason,
    actor: overrides.actor ?? PRODUCER,
    at: overrides.at ?? LATER,
  }
  return { ...withoutId, id: deriveEditorialId(withoutId) }
}
