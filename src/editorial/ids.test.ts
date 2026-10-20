import { describe, expect, it } from 'vitest'

import {
  canonicalRecordValue,
  deriveEditorialId,
  editorialArtifactSetDigest,
  editorialContentDigest,
  editorialRecordDigest,
  editorialRecordIdMatches,
  editorialRecordRef,
  idempotencyFingerprint,
  mintEditorialId,
} from './ids'
import {
  ARTIFACTS,
  BUNDLE_SHA256,
  DOCUMENT_SHA256,
  OTHER_DOCUMENT_SHA256,
  OTHER_EDITOR,
  approvalFixture,
  candidateFixture,
  decisionFixture,
  revisionFixture,
} from './fixtures'

describe('editorial ids', () => {
  it('derives an id from the record content, not from the caller', () => {
    const revision = revisionFixture()

    expect(revision.id).toMatch(/^urn:editorial:revision:[a-f0-9]{64}$/)
    expect(deriveEditorialId(revision)).toBe(revision.id)
    expect(editorialRecordIdMatches(revision)).toBe(true)
  })

  it('derives the same id for the same content', () => {
    expect(revisionFixture().id).toBe(revisionFixture().id)
  })

  it('derives a different id when the content changes', () => {
    const first = revisionFixture()
    const second = revisionFixture({ documentSha256: OTHER_DOCUMENT_SHA256 })

    expect(second.id).not.toBe(first.id)
  })

  it('derives the same id whatever timestamp the record carries', () => {
    const early = revisionFixture({ created: '2026-10-20T09:00:00.000Z' })
    const late = revisionFixture({ created: '2026-10-20T23:59:59.999Z' })

    expect(late.id).toBe(early.id)
  })

  it('treats an absent optional field and an explicit undefined as the same', () => {
    const { bundleSha256: _omitted, ...withoutBundle } = revisionFixture()
    const explicitUndefined = {
      ...revisionFixture(),
      bundleSha256: undefined,
    }

    expect(deriveEditorialId(explicitUndefined)).toBe(
      deriveEditorialId(withoutBundle),
    )
    expect(canonicalRecordValue({ a: undefined, b: 1 })).toEqual({ b: 1 })
  })

  it('refuses a record whose id was not derived from its content', () => {
    const revision = revisionFixture()

    expect(
      editorialRecordIdMatches({ ...revision, id: `${revision.id.slice(0, -1)}0` }),
    ).toBe(false)
  })

  it('gives each record kind its own id namespace', () => {
    const revision = revisionFixture()
    const decision = decisionFixture(revision)

    expect(revision.id).not.toBe(decision.id)
    expect(decision.id).toMatch(/^urn:editorial:decision:[a-f0-9]{64}$/)
  })

  it('binds a content hash to the content digests only', () => {
    const revision = revisionFixture()

    expect(revision.contentHash).toBe(
      editorialContentDigest({
        documentSha256: DOCUMENT_SHA256,
        bundleSha256: BUNDLE_SHA256,
        semanticReceiptSha256: revision.semanticReceiptSha256,
      }),
    )
    expect(
      editorialContentDigest({ documentSha256: OTHER_DOCUMENT_SHA256 }),
    ).not.toBe(revision.contentHash)
  })

  it('orders the artifact set by path, not by the order it was produced in', () => {
    const reversed = [...ARTIFACTS].reverse()

    expect(editorialArtifactSetDigest(reversed)).toBe(
      editorialArtifactSetDigest(ARTIFACTS),
    )
  })

  it('changes the artifact set digest when an artifact changes', () => {
    const changed = [
      { ...ARTIFACTS[0], sha256: 'a'.repeat(64) },
      ARTIFACTS[1],
    ]

    expect(editorialArtifactSetDigest(changed)).not.toBe(
      editorialArtifactSetDigest(ARTIFACTS),
    )
  })

  it('exposes the digest behind a record id as its reference', () => {
    const revision = revisionFixture()
    const reference = editorialRecordRef(revision)

    expect(reference.id).toBe(revision.id)
    expect(reference.sha256).toBe(editorialRecordDigest(revision))
    expect(revision.id.endsWith(reference.sha256)).toBe(true)
  })

  it('gives a submission the same fingerprint as its content digest', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)

    expect(idempotencyFingerprint(candidate)).toBe(
      editorialRecordDigest(candidate),
    )
    expect(idempotencyFingerprint(candidate)).not.toBe(
      idempotencyFingerprint(
        candidateFixture(revision, { author: OTHER_EDITOR }),
      ),
    )
  })

  it('mints an id the record then carries', () => {
    const withoutId = {
      kind: 'revision' as const,
      version: revisionFixture().version,
      contentHash: DOCUMENT_SHA256,
      documentSha256: DOCUMENT_SHA256,
      sourceBinding: revisionFixture().sourceBinding,
      schemaVersions: revisionFixture().schemaVersions,
      rendering: revisionFixture().rendering,
      author: revisionFixture().author,
      created: '2026-10-20T09:00:00.000Z',
    }
    const minted = mintEditorialId(withoutId)

    expect(minted.id).toBe(deriveEditorialId(withoutId))
    expect(editorialRecordIdMatches(minted)).toBe(true)
  })

  it('keeps an approval out of the decision it does not belong to', () => {
    const revision = revisionFixture()
    const candidate = candidateFixture(revision)
    const approval = approvalFixture(candidate)

    expect(approval.id).toMatch(/^urn:editorial:approval:[a-f0-9]{64}$/)
    expect(approval.id).not.toBe(candidate.id)
  })
})
