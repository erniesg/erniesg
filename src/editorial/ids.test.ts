import { describe, expect, it } from 'vitest'

import {
  EDITORIAL_ARTIFACT_SET_DERIVATION,
  EDITORIAL_CONTENT_DERIVATION,
  EDITORIAL_ID_DERIVATION,
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
  SEMANTIC_RECEIPT_SHA256,
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
      editorialContentDigest({
        documentSha256: OTHER_DOCUMENT_SHA256,
        semanticReceiptSha256: revision.semanticReceiptSha256,
      }),
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
      semanticReceiptSha256: SEMANTIC_RECEIPT_SHA256,
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

/**
 * The derivation is frozen.
 *
 * Every assertion above is *relative*: it says the id is the id the record
 * derives, which stays true whatever the derivation does. These assertions
 * are the absolute ones: they spell out the digest the derivation produces
 * today, so a change to a derivation tag, to the identity payload or to the
 * canonical serializer fails here instead of quietly minting a second set of
 * ids for records that are already in the store.
 *
 * The fix for a failing pin is a new derivation tag
 * (`erniesg.editorial.id.v2`) and a new record version — never a silent
 * change to a tag that already names records.
 */
describe('the pinned derivation', () => {
  it('pins the domain tag of every derivation', () => {
    expect(EDITORIAL_ID_DERIVATION).toBe('erniesg.editorial.id.v1')
    expect(EDITORIAL_CONTENT_DERIVATION).toBe('erniesg.editorial.content.v1')
    expect(EDITORIAL_ARTIFACT_SET_DERIVATION).toBe(
      'erniesg.editorial.artifact-set.v1',
    )
  })

  it('pins the id a revision derives', () => {
    expect(deriveEditorialId(revisionFixture())).toBe(
      'urn:editorial:revision:d1667d540a7031dfe50b9fad2c6587f11250a578c9def4bc8e05ea6a8ce7b46a',
    )
  })

  it('pins the id a candidate derives', () => {
    const revision = revisionFixture()

    expect(deriveEditorialId(candidateFixture(revision))).toBe(
      'urn:editorial:candidate:42140c6c3a0514e86f4b79c3ecddb8e12d578d907ac1730981c1753fc593a082',
    )
  })

  it('pins the content digest', () => {
    expect(
      editorialContentDigest({
        documentSha256: DOCUMENT_SHA256,
        bundleSha256: BUNDLE_SHA256,
        semanticReceiptSha256: SEMANTIC_RECEIPT_SHA256,
      }),
    ).toBe(
      'f1ad8012fd31f38bdc3fae467726e6adfd5c3fc6669c6c0aaeb94ffd0af9db55',
    )
  })

  it('pins the artifact set digest', () => {
    expect(editorialArtifactSetDigest(ARTIFACTS)).toBe(
      'b8dbcdce122567d3df91b89128f83563a553ba24288391520947547f9c4474ef',
    )
  })

  it('pins the canonical form of an absent optional field', () => {
    const revision = revisionFixture()

    // An absent optional field and an explicit `undefined` are the same
    // value, at the top level of the record and inside a nested object. The
    // two pins below are what make a change to the canonical serializer
    // fail: the first is the identity payload's own rule, the second is the
    // recursive one in `canonicalRecordValue`.
    expect(
      deriveEditorialId({ ...revision, bundleSha256: undefined }),
    ).toBe(
      'urn:editorial:revision:fcf9121e0878ad061b94bbec332e42b0e28ea5b2b031c3eeeaf93dbf4de7c2f8',
    )
    expect(
      deriveEditorialId({
        ...revision,
        sourceBinding: { ...revision.sourceBinding, bundleSha256: undefined },
      }),
    ).toBe(
      'urn:editorial:revision:7a15e9dd597b0edbf3a52dbaef2bfe3459b5670e16969f2680de38e3c1855328',
    )
  })
})
