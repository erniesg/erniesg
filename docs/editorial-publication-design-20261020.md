# Durable editorial publication: the design record

**Issue:** E-05, "Design and implement durable editorial publication behind an inactive gate"
(`erniesg/erniesg` #285), phase E-05a.
**Date:** 2026-10-20.
**Status of this document:** the design of record for the durable editorial
publication contract. It is implementable as written: every schema, rule and
bound below is the one the code in `src/editorial/**` enforces, and every
refusal it names is a refusal code the code returns.

**What this document is not.** It is not a plan and not a summary. It is the
contract that E05b (the authenticated producer export) and E05c (the inactive
writer and public-route adapter) build on, and it is deliberately the *first*
half of E-05's acceptance criteria. The second half — the producer trust
contract's proofs, the inactive route proof, the migration/backfill and
concurrency proofs, the rollback rehearsal and the forged-record negative
matrix — belongs to E05b and E05c and is stated here only as a contract, not
as a claim.

**§9.5, §9.6 and §9.7 are E05b's addition** (phase E-05b, 2026-10-20):
they state what E05b settled and implemented against §9.3 and §9.4 — the
primitive, the epoch rule, the replay ledger, the rotation, the revocation
and compromise rules, the refusal reasons, the authenticated policy epoch
document, and the negative matrix with the reason each case returns. Every
other section is E-05a's and is unchanged.

---

## 0. The problem, in one paragraph

Today the app publishes a book by running a build: the writer produces
artifacts, the artifacts are served, and the evidence that a human approved
*these* bytes is a set of files on a disk that nothing binds to what was
served. E-05 settles the durable record and state-transition contract for
that: a **revision** of the content, a **decision** about that revision, a
**candidate** assembled from it, the **validations** that ran against it, an
**approval** of it, a **release** that binds all of it, and the
**supersession** that retires a release. Every one of those is immutable,
content-addressed, and refusable. The production writer and the public route
do not change.

---

## 1. Storage choice

### 1.1 The store

**Cloudflare D1 (SQLite), in its own database, reached only by the Worker.**

The app already has one durable store and one durable-store pattern:
`src/worker/margin/d1-repository.ts` (the repository that runs the
statements), `src/worker/margin/d1.ts` (the D1 client interface and its
type guard), `src/worker/margin/queries.ts` (every SQL statement, as pure
`(sql, params)` values), `src/worker/margin/repository.ts` (the storage
seam the handlers depend on), `src/worker/margin/schema.sql` (the bootstrap
DDL), `src/worker/margin/sqlite-database.ts` (the local SQLite stand-in
for D1, used by the tests) and `migrations/0001..0004` (the numbered,
forward-only migrations). E-05 follows that pattern exactly, in a
**separate `EDITORIAL_DB` binding**.

Why a separate database rather than more tables in the margin one:

1. **The margin schema is a published contract.** `migrations/0003` and
   `0004` already added columns, indexes and triggers to it. Adding editorial
   tables to that migration sequence couples the margin service's schema
   history to the publication pipeline's, for no gain.
2. **The lifecycle differs.** The margin store holds short-lived annotations
   with a tombstone; the editorial store holds a permanent ledger with a
   different retention policy (§8). One backup and one retention job cannot
   serve both.
3. **"The production writer is unchanged" becomes provable by construction.**
   A new, unapplied database is not touched by anything that exists today.

What D1 guarantees, and what it does not:

| D1 guarantees | D1 does not guarantee |
| --- | --- |
| A transaction is atomic: it commits whole or not at all. | Cross-transaction atomicity. Two appends are two transactions. |
| A committed row is durable and replicated per the D1 durability setting. | Ordering between transactions. The writer's clock is the only order. |
| A conditional `UPDATE` runs under a write lock, so `UPDATE ... WHERE state = 'x'` changes either zero or one row. | Mutual exclusion between two *different* conditional updates that both match. The loser sees zero changed rows and must re-read. |
| `batch()` runs its statements in one transaction. | Isolation from a reader that has not begun its own transaction: a reader sees committed rows only. |

The application-level guarantees E-05 adds on top:

- **Records are immutable.** Every *record row* is written once and only
  ever inserted; there is no `updated_at` column anywhere in
  `src/editorial/schema.sql`. The only `UPDATE` the store ever runs is on
  the materialised `state` column, in the same transaction as the append it
  belongs to (§1.3, §6.2).
- **A record's id is its content's digest.** A row cannot be updated to
  point at different bytes without changing its primary key.
- **One current release per target.** Enforced by the state machine
  (`guardRecordRelease`, §5.7) and by the storage: the partial unique
  index `editorial_releases_one_current` on
  `editorial_releases (target_id) WHERE state = 'release-released'`. The
  CAS on `editorial_releases.state` cannot enforce it — there is no
  per-target row to compare and swap — so the index is what makes it
  storage-enforced as well as application-enforced.

### 1.2 The tables

`src/editorial/schema.sql` is the schema of record. It is **not applied** by
E-05a and it does **not** live under `migrations/`, so neither the Wrangler
migration runner nor the margin test harness (which applies every
`migrations/*.sql` in filename order) ever sees it. E05c adds the numbered
migration and the coordinator authorises the apply.

| Table | Primary key | Holds |
| --- | --- | --- |
| `editorial_revisions` | `id` | the immutable content revision |
| `editorial_decisions` | `id` | review decisions |
| `editorial_candidates` | `id` | release candidates |
| `editorial_validations` | `id` | one check and its outcome |
| `editorial_approvals` | `id` | authenticated approvals |
| `editorial_releases` | `id` | the published releases |
| `editorial_supersessions` | `id` | retirements |
| `editorial_idempotency_receipts` | `(actor, record_kind, request_key)` | keyed submission receipts |

Every table has a `kind` column constrained to its own value, so a row
cannot be read as the wrong kind, and the JSON columns (`source_binding`,
`schema_versions`, `rendering`, `target`, `artifacts`, `actor`, `evidence`)
hold the nested objects of §7 verbatim. The authoritative shape of each JSON
column is the zod schema in `src/editorial/records.ts`; the column is where
it is stored.

### 1.3 The atomicity boundary

**A reader never sees a record that is being written.** The unit of
visibility is a committed D1 transaction.

- One record, plus its idempotency receipt, commit together in one
  `batch()` — the same shape as
  `MarginRepository.insertAnnotationWithReceipt` and its receipt. There is
  no window in which a record exists without its receipt, or a receipt
  without its record.
- The materialised `state` column and the evidence record commit together.
  A reader that trusts the column and a reader that re-derives the
  projection see the same thing, because the two cannot be committed apart.
- **Across records, the boundary is the record, not the pipeline.** A
  revision, a decision, a candidate, a validation, an approval and a release
  are six transactions. A reader that wants to know "is there a current
  release for this target?" expands the supersessions (§4.4, §5.8) and sees a
  consistent set of committed rows.

The one thing that is *not* atomic is the pair "write the artifacts, then
write the release". The order is: upload the artifacts, verify their
digests, then append the release in one transaction that references the
verified digests. A crash between the two leaves orphaned bytes, never a
release that points at bytes nobody verified. §7 covers the recovery.

---

## 2. Immutable ids

### 2.1 The scheme

Every editorial record's id is:

```
urn:editorial:<kind>:<64 lowercase hex characters>
```

where the hex is the SHA-256 of the record's **identity payload** under a
domain tag, computed by `src/editorial/ids.ts`.

The identity payload is:

- the record's own fields,
- minus its `id`,
- minus its **timestamp field**,
- with every `undefined` removed recursively,
- under `domain: 'erniesg.editorial.id.v1'` and the record's `kind`.

The digest primitive is `structDigest` from the pinned Struct package
(`@erniesg/struct/identity`) — the app's one canonical digest after the E-03
cutover. It is synchronous and runs unchanged in Node, in the Worker and in
a browser, so the same id can be derived on either side of the store. Its
canonical form orders object members by **code unit**, never by collation:
`localeCompare` would order `a` before `B` under `en-US` and `y` before `w`
under Lithuanian, and a collation-dependent id is not a portable id.

### 2.2 The three rules

1. **An id never changes.** Nothing in the identity payload is mutable. The
   lifecycle state of a candidate or a release is a *projection* over the
   record set (§5), never a field of the record, so it cannot leak into an
   id.
2. **An id never encodes mutable state.** The timestamp field is excluded.
   A timestamp is evidence of *when* a record was written, not of *what* it
   is: two identical submissions at different times are the same record and
   share the same id, which is what makes the retry in §6 idempotent.
3. **An id never encodes server state.** No sequence number, no row id, no
   clock reading, no session token. The payload is the record's own fields.

### 2.3 The timestamp field of each kind

| Kind | Timestamp field | Excluded from the id |
| --- | --- | --- |
| `revision` | `created` | yes |
| `decision` | `decidedAt` | yes |
| `candidate` | `created` | yes |
| `validation` | `validatedAt` | yes |
| `approval` | `approvedAt` | yes |
| `release` | `releasedAt` | yes |
| `supersession` | `at` | yes |

### 2.4 Two other digests

- **`contentHash`** — the digest of `{ documentSha256, bundleSha256?,
  semanticReceiptSha256? }` under
  `erniesg.editorial.content.v1`. It is the *content* identity, and it is
  what a decision binds. It deliberately does not cover the renderer, the
  profile or the schema versions: those are how the content is presented,
  not what it is.
- **`artifactSetSha256`** — the digest of the artifact list, ordered by path,
  under `erniesg.editorial.artifact-set.v1`. It is what an approval binds,
  so an approval cannot be carried over to different bytes.

### 2.5 The derivation is frozen

The derivation is pinned by **literal digests** in
`src/editorial/ids.test.ts` (`describe('the pinned derivation')`). Every other
assertion in the editorial suite is *relative* — it says the id is the id the
record derives, which stays true whatever the derivation does — so these are
the only assertions that notice a change to it. The pins are:

| Pinned | Value |
| --- | --- |
| `EDITORIAL_ID_DERIVATION` | `erniesg.editorial.id.v1` |
| `EDITORIAL_CONTENT_DERIVATION` | `erniesg.editorial.content.v1` |
| `EDITORIAL_ARTIFACT_SET_DERIVATION` | `erniesg.editorial.artifact-set.v1` |
| the id of the fixture revision | `urn:editorial:revision:d1667d54…` |
| the id of the fixture candidate | `urn:editorial:candidate:42140c6c…` |
| the content digest of the fixture revision | `f1ad8012fd31f38b…` |
| the artifact-set digest of the fixture artifacts | `b8dbcdce122567d3…` |
| the id of a record whose absent optional field is an explicit `undefined`, at the top level and nested | `urn:editorial:revision:fcf9121e…`, `urn:editorial:revision:7a15e9dd…` |

A change to a derivation tag, to the identity payload, or to the canonical
serializer that moved any of those digests fails those tests loudly. The fix
is a new derivation tag (`erniesg.editorial.id.v2`) and a new record version —
never a silent change to a tag that already names records in the store.

---

## 3. Authenticated actors

### 3.1 The kinds

| Kind | Who it is | What it carries |
| --- | --- | --- |
| `editor` | a person who cuts content | `principal`, `provider`, `issuer`, `subject` |
| `reviewer` | a person who reviews and decides | `principal`, `provider`, `issuer`, `subject` |
| `approver` | a person who authorises a release | `principal`, `provider`, `issuer`, `subject` |
| `tool` | a deterministic program | `toolId`, `toolVersion` |
| `producer` | the writing session that exports a release | `keyId`, `policyEpoch` |

The schema is `editorialActorSchema`, a discriminated union on `kind`.

### 3.2 How a human actor is authenticated

A human actor is **already authenticated** by the app's existing session
mechanism before any editorial record is written. The identity is the
`(provider, issuer, subject)` triple that `src/worker/principal.ts` derives
from a verified WorkOS access token — never an email address, which is
profile data. The principal key in the record uses the margin service's own
spelling, `urn:margin:principal:<provider>:<issuer>:<subject>`
(`src/worker/margin/identity.ts`).

The role (`editor` / `reviewer` / `approver`) is what the record says the
principal acted *as*. Which principals may hold which role is the margin
service's allowlist (`margin_allowlist`), and it is the route adapter's job
(E05c) to map an allowlist role onto an editorial role. E-05a fixes the
*record* and the *transition table*; it does not create a second identity
system, and it does not read the allowlist.

The separation is deliberate: a **role** in a record is not an
**authorisation**. The authorisation is checked at the composition root, the
way `src/worker/gate.ts` does it: "gated by omission rather than open by
omission". A route that forgets to call the gate is the bug this pattern
exists to prevent, and E05c must not add a second gate.

### 3.3 How a machine actor is authenticated

- A `tool` actor is a program whose output is the evidence. It is
  authenticated by the *digests* it validates: the validation record binds
  the candidate's exact digests, and the report digest in `evidence` names
  the bytes the tool produced. A tool cannot be a person and cannot approve
  anything.
- A `producer` actor is the writing session. It is authenticated by the
  **producer record** and its detached signature (§9), which E05b
  implements. The `keyId` and `policyEpoch` in the actor say *which* key
  claims the release, and they are a claim, not a proof: the release record
  alone proves nothing to a consumer. The proof is the producer record.

### 3.4 Who may do what

| Action | Actor kinds | § |
| --- | --- | --- |
| `propose-revision` | `editor` | 5.2 |
| `record-decision` | `reviewer` | 5.3 |
| `assemble-candidate` | `editor` | 5.4 |
| `record-validation` | `tool` (machine checks), `reviewer` (`human-review`) | 5.5 |
| `record-approval` | `approver` | 5.6 |
| `record-release` | `producer` | 5.7 |
| `supersede-release` | `producer`, `approver` | 5.8 |

Two further rules the state machine enforces on top of the table:

- The record's own author/actor must be **the same identity** as the
  transition's actor (`sameActor`). A record cannot be attributed to
  somebody else.
- A `human-review` validation must be recorded by a `reviewer`; the three
  machine checks must be recorded by a `tool`. A tool cannot review, and a
  reviewer cannot stand in for EPUBCheck.

---

## 4. Target binding

### 4.1 What a target is

A **target** is where a release is published: the audience, the channel, the
environment, the route, and the policy that applies there.

```ts
{
  version: '1.0.0',
  id: 'ernie-sg-production',            // slug
  audience: 'public' | 'members' | 'subscribers' | 'internal',
  channel: 'web' | 'epub' | 'pdf' | 'print' | 'email',
  environment: 'production' | 'staging' | 'preview',
  route: '/library/moving-to-cloudflare-with-astro',
  policy: {
    requiredValidationChecks: EditorialValidationCheck[],
    requireHumanReview: true,            // z.literal(true)
    requireAuthenticatedApproval: true,   // z.literal(true)
    maxApprovalAgeSeconds: 86_400,
  },
}
```

**This is not the rendering `TargetProfile`** of `src/research/targets.ts`,
which says how a page is laid out (geometry, typography, pagination). The two
are different concerns in different modules, and E-05 does not touch
`src/research/**`. The rendering intent of a revision is its `rendering`
field (§7.1); the destination is its `target`.

**Who owns the target definitions.** The four mandatory checks are a hard
floor, enforced by the schema and by the state machine, but the rest of the
policy is a *choice*: `maxApprovalAgeSeconds` may be as high as the
schema's ceiling of 31 536 000 (one year) against the 86 400 (24 hours)
this document uses as its example, and `audience`, `environment`, `route`
and `id` are free strings with nothing behind them.

**The registry is E05c's and E06's.** The set of legal targets belongs in a
**server-side registry** — the app's own configuration, not anything a
caller supplies — and **the target embedded in a candidate and in a release
must match a registered target exactly**, the whole object under the
canonical form. A writer that cannot find its target in the registry must
refuse the write rather than write the target it was handed.

**E-05a implements none of that, and does not claim it.** The target is
app-owned and embedded verbatim (§4.2); the writer that assembles a
candidate is the app's own writer (E05c), not a client; and the only bound
on `maxApprovalAgeSeconds` is the schema's ceiling. Until the registry
exists, the target policy is only as trustworthy as the code that
assembles the candidate, and the registry is what makes it reviewable in
one place instead of spread across that code. The ceiling is a bound on the
*shape*, not a recommended policy: the targets in this document bound the
approval age at 86 400 seconds (24 hours).

### 4.2 How a release binds to exactly one target

The target is a **single embedded object**, not an id and not a list, in
the candidate and in the release. Three consequences:

1. A release names exactly one target, structurally. There is no array to
   be ambiguous about.
2. The target is carried **verbatim**, so a release is self-contained: a
   reader that has only the release knows where it went and under which
   policy, without a join and without a second version of the target that
   could drift.
3. The release's target must equal the candidate's target exactly
   (`sameValue` over the canonical form). A release cannot be pointed at a
   different target than the candidate it publishes.

### 4.3 What a target policy requires

- **`requiredValidationChecks`** must be a superset of the four mandatory
  checks and may not name a check twice. A target may add (`preflight`,
  `link-integrity`); it may never drop one. The schema enforces it, so no
  target can be written that weakens the baseline.
- **`requireHumanReview`** and **`requireAuthenticatedApproval`** are
  `z.literal(true)`. They are not options; they are the shape.
- **`maxApprovalAgeSeconds`** bounds how old an approval may be when the
  release is written. The bound is **exclusive**: an approval that has
  *reached* the maximum age is already too old, and an approval stamped in
  the future is never fresh. The schema's ceiling is 31 536 000 (one year):
  a bound on the shape, not a policy. Who owns the value is §4.1's
  question.
- The candidate must cover the target's policy: the candidate's
  `requiredValidationChecks` must contain every check the target requires
  (`targetPolicyIsSatisfied`). A candidate may require more than the target
  does, never less.

### 4.4 One current release per target

At most one release per target is **current** at a time. A second release
for a target that still has a current one is refused
(`target_already_released`). This is the writer-singularity property E-06
depends on, and it is what makes "the current artifact for this target" a
well-defined question.

The rule is enforced twice: by the state machine (§5.7) and by the storage —
the partial unique index `editorial_releases_one_current` on
`editorial_releases (target_id) WHERE state = 'release-released'`
(`src/editorial/schema.sql`). A compare-and-swap cannot enforce it: the CAS
guards the state of one release row, and there is no per-target row to
compare and swap.

The order of a replacement is: **supersede, then release**. The old release
is retired first; there is then no current release for the target, and the
new one may be published. The alternative — publishing the new one first —
would leave two current releases and is refused.

---

## 5. The state machine

**The module that enforces it is `src/editorial/state-machine.ts`.**
`applyTransition` is a pure function over records: it takes the records the
caller has read, plus the record the caller wants to append, and answers
"may this happen, and what is the state afterwards". It touches no store, no
clock (beyond the `now` the caller passes) and no network, so the whole
contract is exercisable in isolation — which is what
`src/editorial/state-machine.test.ts` does.

The rules themselves live in `src/editorial/validation.ts` as pure
predicates; the state machine composes them into transitions.

The exported table `EDITORIAL_TRANSITIONS` lists, for each action, the
states the aggregate may hold **after** it — every outcome, not only the
common one. It is descriptive: the guards decide, the table describes. But
it is the map a reader consults, so it is kept honest by a test that
asserts the table contains every outcome `applyTransition` can return.

### 5.1 The diagram

```
                       propose-revision (editor)
                                │
                                ▼
                       ┌──────────────────┐
                       │ revision-proposed│
                       └────────┬─────────┘
                                │  record-decision (reviewer)
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
   ┌──────────────────┐ ┌──────────────┐ ┌───────────────────────┐
   │ revision-approved│ │revision-    │ │ revision-changes-     │
   │ (one decision)   │ │rejected      │ │ requested (terminal)  │
   └────────┬─────────┘ │(terminal)    │ └───────────────────────┘
            │           └──────────────┘
            │ assemble-candidate (editor)
            ▼
   ┌──────────────────┐
   │candidate-assembled│ ◀── record-validation (tool | reviewer)
   └────────┬─────────┘         (the mandatory set is still incomplete,
            │                   or one of them failed)
            │ record-validation × N
            ▼
   ┌──────────────────┐
   │ candidate-validated│
   └────────┬─────────┘
            │ record-approval (approver)
            ▼
   ┌───────────────────────────────┐
   │ candidate-approved-for-release│
   └────────┬──────────────────────┘
            │ record-release (producer)
            ▼
   ┌──────────────────┐        supersede-release (producer | approver)
   │  release-released│ ─────────────────────────────────────┐
   └──────────────────┘                                      ▼
                                              ┌────────────────────────┐
                                              │ release-superseded    │
                                              │ (terminal)             │
                                              ├────────────────────────┤
                                              │ release-withdrawn      │
                                              │ (terminal)             │
                                              └────────────────────────┘
```

**What "terminal" means here.** A terminal state is one the *record* does
not leave: no further transition of its own kind may be recorded on it. A
revision takes exactly one decision, so `revision-rejected` and
`revision-changes-requested` are terminal, and `revision-approved` is
terminal *as a revision state* — no second decision may be recorded on that
revision — while the pipeline continues from it into `assemble-candidate`.
A terminal release is one the pipeline never leaves.

### 5.2 `propose-revision`

- **From:** the revision does not exist yet. **To:** `revision-proposed`.
- **Actor:** `editor`, and the revision's `author` must be that same editor.
- **Requires:** the revision satisfies `editorialRevisionSchema`, and its id
  is derived from its content.
- **Terminal:** `revision-proposed` is not terminal; it is one decision
  away.

### 5.3 `record-decision`

- **From:** `revision-proposed`. **To:** `revision-approved`,
  `revision-rejected` or `revision-changes-requested`, per the decision's
  `outcome`.
- **Actor:** `reviewer`, and the decision's `actor` must be that reviewer.
- **Requires:** the decision's `subject` matches the revision **exactly** —
  the same `revisionId`, the same `contentHash`, the same `documentSha256`
  and the same `bundleSha256` — otherwise `stale_decision`.
- **Terminal:** all three outcomes end the revision's decision — a revision
  takes exactly one decision, and none of the three leaves a revision state
  that takes another. **A revision takes exactly one decision.** A changed
  mind produces a new revision, because a revision is immutable and a
  decision is about one cut of the content. This is what makes "a stale
  decision cannot authorize a changed candidate" structural rather than a
  check: there is no second decision to confuse the first with. (The
  pipeline still continues from `revision-approved` into
  `assemble-candidate`; see §5.1.)
- **Refusals:** `actor_not_permitted`, `wrong_state`, `stale_decision`.

### 5.4 `assemble-candidate`

- **From:** the candidate does not exist yet. **To:** `candidate-assembled`.
- **Actor:** `editor`, and the candidate's `author` must be that editor.
- **Requires:**
  1. the candidate's `revisionId`, `contentHash`, `documentSha256` and
     `bundleSha256` equal the revision's — otherwise `digest_mismatch`;
  2. **the revision is approved by an exact decision** — otherwise
     `revision_not_approved`. If the only decision on that revision id
     binds different content hashes, the refusal is `stale_decision`;
  3. the candidate covers its target's policy — otherwise
     `target_policy_not_satisfied`.
- **Refusals:** `actor_not_permitted`, `digest_mismatch`,
  `revision_not_approved`, `stale_decision`,
  `target_policy_not_satisfied`.

**This is the acceptance criterion "only an approved immutable revision can
produce the release candidate", enforced in one place.**

### 5.5 `record-validation`

- **From:** `candidate-assembled` or `candidate-validated`. **To:**
  `candidate-validated` when the mandatory set becomes complete and passing,
  otherwise `candidate-assembled`.
- **Actor:** `tool` for `bundle-verification`, `epubcheck`, `ace`,
  `preflight` and `link-integrity`; `reviewer` for `human-review`.
- **Requires:**
  1. the validation's `subject` matches the candidate **exactly** — the same
     `candidateId`, `revisionId`, `contentHash`, `documentSha256`,
     `bundleSha256`, `targetId` and `artifactSetSha256` — otherwise
     `digest_mismatch`;
  2. the check is one the candidate requires — otherwise
     `mandatory_validation_missing`.
- **A failed validation is recorded, and the candidate stays
  `candidate-assembled`.** A failure is evidence, and the candidate can
  never reach `candidate-validated` while that check has no passing
  validation. A fixed candidate is a *different* candidate: the id is
  content-addressed, so re-rendering produces a new id and a new approval.
- **Refusals:** `actor_not_permitted`, `wrong_state`, `digest_mismatch`,
  `mandatory_validation_missing`.

### 5.6 `record-approval`

- **From:** `candidate-validated`. **To:** `candidate-approved-for-release`.
- **Actor:** `approver`, and the approval's `actor` must be that approver.
- **Requires:**
  1. the candidate's mandatory validation set is complete and passing — if
     it is not, the refusal is `mandatory_validation_missing`; if it is but
     the candidate is in another state, `wrong_state`;
  2. the approval's `subject` matches the candidate exactly — otherwise
     `digest_mismatch`.
- **Terminal:** the approval record itself is terminal. There is no
  "revoke an approval" transition: a candidate that must not be released is
  simply never released. The approval's own expiry is handled by
  `maxApprovalAgeSeconds` at the release.
- **Refusals:** `actor_not_permitted`, `wrong_state`, `digest_mismatch`,
  `mandatory_validation_missing`.

### 5.7 `record-release`

- **From:** `candidate-approved-for-release`. **To:** `release-released`.
- **Actor:** `producer`, and the release's `producer` must be that producer.
- **Requires, in order:**
  1. the release names the candidate and revision it publishes — the same
     `candidateId`, `revisionId` and `contentHash` — otherwise
     `digest_mismatch`;
  2. the release's `sourceBinding` equals the revision's, byte for byte
     under the canonical form, and names the revision's `documentSha256`
     and `bundleSha256` — otherwise `digest_mismatch`. **This is where the
     Struct-cutover provenance is carried:** the app-owned `sourceBinding`
     shape (§7.1), over the same one provenance source,
     `vendor/struct/provenance.json`;
  3. the release's `schemaVersions` and `rendering` equal the revision's —
     otherwise `digest_mismatch`;
  4. the release's `target` equals the candidate's, and its `artifacts` and
     `artifactSetSha256` equal the candidate's — otherwise
     `digest_mismatch`;
  5. every validation the release binds exists, is content addressed, is
     bound by its own digest, was recorded by the actor kind its check
     requires, passed, and matches the candidate's digests —
     `mandatory_validation_missing`, `digest_mismatch`,
     `actor_not_permitted` or `validation_not_passed`;
  6. the bound validations cover the candidate's whole required set —
     otherwise `mandatory_validation_missing`;
  7. the approval the release binds exists, is content addressed, is bound by
     its own digest, was given by an approver, matches the candidate, and is
     still fresh under the target's `maxApprovalAgeSeconds` —
     `approval_missing`, `digest_mismatch`, `actor_not_permitted` or
     `target_policy_not_satisfied`;
  8. the target has no current release — otherwise
     `target_already_released`.
- **Refusals:** `actor_not_permitted`, `wrong_state`, `digest_mismatch`,
  `mandatory_validation_missing`, `validation_not_passed`,
  `approval_missing`, `target_policy_not_satisfied`,
  `target_already_released`.

**This is the acceptance criterion "the release record binds the exact
package, schema, bundle, document, renderer/profile, validation, approval,
target and artifact digests".** Every one of those bindings is checked
against the record it must equal, and a mismatch is a refusal, not a
warning.

**The release's own `{ id, sha256 }` references are bindings too.** A
reference is not a claim the reader takes on trust: the referenced record
must be in the reader's set, its id must be the id its own content derives,
and the `sha256` the release carries must be that record's digest. A
release that binds a validation or an approval whose digest it does not
carry, or whose id was minted by something other than its content, is
refused with `digest_mismatch`. The approval must also be an approval —
`actor.kind === 'approver'` — and every bound validation must have been
recorded by the actor kind its check requires, so a `human-review` that a
tool recorded does not satisfy a release.

### 5.8 `supersede-release`

- **From:** `release-released`. **To:** `release-superseded` or
  `release-withdrawn`.
- **Actor:** `producer` or `approver`, and the supersession's `actor` must be
  that actor.
- **Requires:** the subject release is current — otherwise
  `release_not_current`; the supersession names the release it retires;
  and, when the replacement release is among the records the caller read,
  it publishes to the same target.
- **Terminal:** `release-superseded` and `release-withdrawn` are terminal.
- **Refusals:** `actor_not_permitted`, `release_not_current`,
  `digest_mismatch`.

### 5.9 The states, in one table

| Kind | States | Terminal |
| --- | --- | --- |
| `revision` | `revision-proposed`, `revision-approved`, `revision-rejected`, `revision-changes-requested` | all but `revision-proposed` |
| `decision` | written directly in `decision-recorded` | yes |
| `candidate` | `candidate-assembled`, `candidate-validated`, `candidate-approved-for-release`, `candidate-released` | `candidate-released` |
| `validation` | written directly in `validation-passed` or `validation-failed` | yes |
| `approval` | written directly in `approval-granted` | yes |
| `release` | `release-released`, `release-superseded`, `release-withdrawn` | all but `release-released` |
| `supersession` | written directly in `supersession-recorded` | yes |

The projections are `projectRevisionState`, `projectCandidateState` and
`projectReleaseState` in `src/editorial/validation.ts`.

"Terminal" in the third column means *the record takes no further transition
of its own kind* — see §5.1. `revision-approved` is terminal as a revision
state (no second decision), and the pipeline continues from it into
`assemble-candidate`.

### 5.10 The refusal codes

`EDITORIAL_REFUSAL_CODES`, in `src/editorial/state-machine.ts`:

| Code | Meaning |
| --- | --- |
| `action_not_permitted` | no transition is defined for the action |
| `actor_not_permitted` | the actor's kind, or the record's attribution, is wrong |
| `record_kind_mismatch` | the action appends a different kind |
| `record_schema_invalid` | the record does not satisfy its own schema |
| `record_id_mismatch` | the record's id is not derived from its content |
| `record_timestamp_in_future` | the record is stamped after the transition |
| `wrong_state` | the aggregate is not in a state that allows the transition |
| `revision_not_approved` | no exact approving decision on the revision |
| `stale_decision` | the decision binds different revision or content hashes |
| `digest_mismatch` | a bound digest does not equal the digest it must equal |
| `mandatory_validation_missing` | a required check has no passing validation |
| `validation_not_passed` | a bound validation did not pass |
| `approval_missing` | the bound approval does not exist |
| `target_policy_not_satisfied` | the target's policy is not met |
| `release_not_current` | the release is already superseded or withdrawn |
| `target_already_released` | the target already has a current release |

The order of the checks is the order of the refusals a reader cares about:
**who is asking**, then **what they are appending** (kind, schema, id,
timestamp), then **the aggregate's state**, then **the rule specific to the
action**.

Every code in the table has a test. `action_not_permitted` is the only one
a typed caller cannot reach — `TransitionInput['action']` is the closed
union of the seven actions in the table — so the branch is the guard against
an action that is not in the table at all.

### 5.11 What a reader sees

- `currentReleaseForTarget(releases, supersessions, targetId)` returns the
  one current release, or `null`. It returns `null` when there is more than
  one, because an ambiguous answer is not an answer.
- `releaseIsCurrent(release, supersessions)` is false as soon as any
  supersession names the release. **A superseded artifact is never presented
  as current**, and the supersession — not an edit of the release — is what
  says so.
- The `state` column in the store is the *materialised* projection. It
  exists for the CAS (§6.2). The authoritative state is the projection over
  the record set; the column is written in the same transaction as the
  append, so the two cannot diverge.

---

## 6. Idempotency and compare-and-swap

### 6.1 The idempotency key

The writer accepts a client-supplied `Idempotency-Key`, in the same shape
the margin service uses: a UUID. The receipt scope is

```
(actor, record_kind, request_key)
```

so one caller's key never collides with another's, and the same key used for
a different kind of record is a different submission.

The **fingerprint** is the record's identity digest (§2.1): because every
editorial record is content addressed, the fingerprint and the hex inside the
id are the same value. A retry of the same submission carries the same
fingerprint; a reused key with different content carries a different one.

The receipt row is
`(actor, record_kind, request_key, fingerprint, record_id, created)`, and it
commits in the same transaction as the record it describes.

Behaviour:

| Situation | Result |
| --- | --- |
| Same key, same content, the record is there | the original record is returned; nothing is written |
| Same key, same content, the response was lost | the original record is returned; nothing is written |
| Same key, **different** content | refused: the key was used for something else |
| Same key, the record was written but the receipt was not | the transaction rolled back, so neither exists; the retry writes both |
| No key | a plain write; the record's content-addressed id still makes a repeat submission a no-op at the primary key |

### 6.2 Compare-and-swap

Every state change is a conditional update guarded by the expected prior
state:

```sql
UPDATE editorial_candidates SET state = ? WHERE id = ? AND state = ?
```

Zero changed rows means somebody else moved first, and the writer re-reads
and re-decides. This is the app's existing idiom — the margin service puts
the same guard in the same statement as the write
(`AND withdrawn_at IS NULL` in `updateAnnotationQuery`) precisely so that a
withdrawal between the read and the write wins.

D1 serialises writes, so exactly one of two concurrent conditional updates
matches. The loser does not overwrite: it reads the new state and either
retries (if the transition is still legal) or refuses (if the aggregate has
reached a terminal state).

The CAS covers the aggregate, not the id: the id is the primary key, so two
writers producing identical content converge on one row rather than racing.

---

## 7. The record and receipt schemas

This section is the contract. It matches `src/editorial/records.ts` field
for field.

Common leaves:

```ts
sha256Schema   = z.string().regex(/^[a-f0-9]{64}$/)
commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/)
timestampSchema = z.string().datetime()          // ISO 8601, Z only
```

Every object is `.strict()`: an unknown field is a refusal, not a shrug.

### 7.1 `revision` — version `1.0.0`

The immutable content revision.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | `'revision'` | yes | literal |
| `version` | `'1.0.0'` | yes | literal |
| `id` | `urn:editorial:revision:<64 hex>` | yes | derived (§2) |
| `contentHash` | 64 hex | yes | the digest of the content digests (§2.4) |
| `documentSha256` | 64 hex | yes | the Struct document digest |
| `bundleSha256` | 64 hex | no | the Struct bundle digest |
| `semanticReceiptSha256` | 64 hex | no | the Struct semantic receipt digest |
| `sourceBinding` | see below | yes | the app-owned source binding |
| `schemaVersions` | see below | yes | the artifact schema versions |
| `rendering` | see below | yes | the rendering intent |
| `author` | actor | yes | must be `kind: 'editor'` |
| `created` | timestamp | yes | excluded from the id |

`sourceBinding` (the app-owned `struct-cutover` binding):

```ts
{
  kind: 'struct-cutover',
  documentSha256: sha256,
  bundleSha256?: sha256,
  semanticReceiptSha256?: sha256,
  packageSourceCommit: /^[a-f0-9]{40}$/,
  packageArtifact: string(1..256),
  packageArtifactSha256: sha256,
  packageIntegrity: string(1..256),
  packageVersion: string(1..64),
}
```

The package fields are the fields of the **one** provenance source,
`vendor/struct/provenance.json` (`sourceCommit`, `artifact`, `sha256`,
`integrity`, `packageVersion`). The legacy `ResearchPaper` variant of the
E-04 union is deliberately **not** admitted: a release in this contract must
bind a Struct-cutover source.

**This shape is app-owned and provisional.** It is *not* a verified copy of
another contract's shape: E-04 has not landed on this branch, and no module
in `src/**` defines a `sourceBinding` to check it against (measured — the
E-04 worktree `app-e04-receipt@b4521168` has no such module either). The
field list is pinned in the shared constant `EDITORIAL_SOURCE_BINDING_FIELDS`
(`src/editorial/records.ts`), which `records.test.ts` checks against the
schema's own field list, and **the E-04 module must compare its shape
against that constant when it lands**. Until then a drift between the two
shapes would not be visible, and this document does not claim that it is.

`schemaVersions`:

```ts
{ publicationGraph, assetBundle, compositionContext,
  transformationPolicy, sourceAdapter, targetProfile }   // all string(1..32)
```

`rendering`:

```ts
{
  rendererId: string(1..64),
  rendererVersion: string(1..64),
  profileIds: string(1..64)[1..16],
  policyVersions: { renderer, semanticHtml, accessibility,
                    transformationPolicy, publicationCheck },
}
```

**Validation rules (failure modes):**

| Rule | Failure |
| --- | --- |
| `author.kind === 'editor'` | `editorialRevisionSchema` refuses |
| `sourceBinding`'s digests equal the record's digests | refuses |
| `contentHash` equals the digest of the content digests | refuses |
| the id is derived from the content | `record_id_mismatch` at the transition |

### 7.2 `decision` — version `1.0.0`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | `'decision'` | yes | literal |
| `version` | `'1.0.0'` | yes | literal |
| `id` | `urn:editorial:decision:<64 hex>` | yes | derived |
| `subject` | see below | yes | the exact revision and content hashes |
| `outcome` | `'approved' \| 'rejected' \| 'changes-requested'` | yes | |
| `actor` | actor | yes | must be `kind: 'reviewer'` (the state machine) |
| `rationale` | string ≤ 4096 | no | free text |
| `decidedAt` | timestamp | yes | excluded from the id |

`subject`:

```ts
{ revisionId, contentHash, documentSha256, bundleSha256? }
```

**Validation rules:** the subject must match the revision exactly, or the
transition refuses with `stale_decision`; a revision that already has a
decision refuses with `wrong_state`.

### 7.3 `candidate` — version `1.0.0`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | `'candidate'` | yes | literal |
| `version` | `'1.0.0'` | yes | literal |
| `id` | `urn:editorial:candidate:<64 hex>` | yes | derived |
| `revisionId` | revision id | yes | the approved revision |
| `contentHash` | 64 hex | yes | the revision's content hash |
| `documentSha256` | 64 hex | yes | |
| `bundleSha256` | 64 hex | no | |
| `target` | target | yes | embedded verbatim (§4.2) |
| `artifacts` | artifact[1..64] | yes | sorted by path, unique paths |
| `artifactSetSha256` | 64 hex | yes | the digest of the artifacts |
| `requiredValidationChecks` | check[1..16] | yes | unique, ⊇ mandatory, ⊇ the target's policy |
| `author` | actor | yes | must be `kind: 'editor'` |
| `created` | timestamp | yes | excluded from the id |

artifact:

```ts
{ path: string(1..512), sha256: sha256, byteLength: int ≥ 0,
  profile: string(1..64), renderer: string(1..64) }
```

**Validation rules:** no duplicate check; the four mandatory checks are
present; the target's required checks are present; the artifact paths are
unique and ordered; `artifactSetSha256` equals the digest of the artifacts.

### 7.4 `validation` — version `1.0.0`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | `'validation'` | yes | literal |
| `version` | `'1.0.0'` | yes | literal |
| `id` | `urn:editorial:validation:<64 hex>` | yes | derived |
| `check` | `bundle-verification` \| `epubcheck` \| `ace` \| `human-review` \| `preflight` \| `link-integrity` | yes | |
| `subject` | candidate subject | yes | the exact digests validated |
| `outcome` | `'passed' \| 'failed'` | yes | |
| `evidence` | see below | yes | |
| `actor` | actor | yes | `tool` for machine checks, `reviewer` for `human-review` |
| `validatedAt` | timestamp | yes | excluded from the id |

candidate subject:

```ts
{ candidateId, revisionId, contentHash, documentSha256,
  bundleSha256?, targetId, artifactSetSha256 }
```

evidence:

```ts
{ tool: string(1..128), toolVersion: string(1..64),
  reportSha256?: sha256, detail?: string ≤ 4096 }
```

**Validation rules:** the subject must match the candidate exactly, or the
transition refuses with `digest_mismatch`; the check must be one the
candidate requires; the actor's kind must match the check, or the
transition refuses with `actor_not_permitted`. The actor/check
correspondence is a *transition* rule and not a schema rule, so that a
refusal says "a tool may not stand in for a reviewer" rather than "the
record is malformed".

### 7.5 `approval` — version `1.0.0`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | `'approval'` | yes | literal |
| `version` | `'1.0.0'` | yes | literal |
| `id` | `urn:editorial:approval:<64 hex>` | yes | derived |
| `candidateId` | candidate id | yes | |
| `subject` | candidate subject | yes | the exact digests approved |
| `actor` | actor | yes | must be `kind: 'approver'` |
| `approvedAt` | timestamp | yes | excluded from the id |

**Validation rules:** the subject must match the candidate exactly; the
candidate must have the complete passing validation set; the approval must be
fresh at the moment of release.

### 7.6 `release` — version `1.0.0`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | `'release'` | yes | literal |
| `version` | `'1.0.0'` | yes | literal |
| `id` | `urn:editorial:release:<64 hex>` | yes | derived |
| `candidateId` | candidate id | yes | |
| `revisionId` | revision id | yes | |
| `contentHash` | 64 hex | yes | |
| `sourceBinding` | the app-owned binding (§7.1) | yes | the package pin and the document, bundle and receipt digests |
| `schemaVersions` | as §7.1 | yes | |
| `rendering` | as §7.1 | yes | the renderer and the profiles |
| `validations` | `{ id, sha256 }`[1..16] | yes | unique, ordered by id |
| `approval` | `{ id, sha256 }` | yes | the approval reference |
| `target` | target | yes | embedded verbatim |
| `artifacts` | artifact[1..64] | yes | sorted by path, unique paths |
| `artifactSetSha256` | 64 hex | yes | |
| `producer` | `{ kind: 'producer', keyId, policyEpoch }` | yes | who wrote it (§3.3) |
| `releasedAt` | timestamp | yes | excluded from the id |

**Validation rules:** every one of §5.7's eight requirements. The release
binds the exact package, schema, bundle, document, renderer/profile,
validation, approval, target and artifact digests, and a mismatch in any of
them is a refusal.

### 7.7 `supersession` — version `1.0.0`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | `'supersession'` | yes | literal |
| `version` | `'1.0.0'` | yes | literal |
| `id` | `urn:editorial:supersession:<64 hex>` | yes | derived |
| `subjectReleaseId` | release id | yes | the release being retired |
| `supersedingReleaseId` | release id \| `null` | yes | `null` when there is no replacement |
| `reason` | `'replacement' \| 'correction' \| 'withdrawn' \| 'revocation'` | yes | |
| `actor` | actor | yes | |
| `at` | timestamp | yes | excluded from the id |

**Validation rules:** `replacement` and `correction` must name a
replacement; `withdrawn` and `revocation` must not.

### 7.8 The receipts

Two receipt shapes exist.

**The idempotency receipt** (§6.1): `(actor, record_kind, request_key,
fingerprint, record_id, created)`. It is the durable result of a keyed
submission, retained after the record it describes is gone.

**The record reference** `{ id, sha256 }`: the id of a referenced record and
the digest behind it. Because every record is content addressed, the `id`
*is* the digest; the `sha256` is spelled out so a reader can compare
digests without parsing URNs. A release's `validations` array and its
`approval` field are references of this kind. **A reference is verified
against the record it names at the transition** (§5.7): the record must be
in the reader's set, its id must be the id its own content derives, and the
`sha256` must be that record's digest.

**The producer record** is a receipt of a different kind — the authenticated
export — and is specified in §9.

---

## 8. Migrations, backfill, recovery and retention

### 8.1 The migration scheme

The app's scheme: `migrations/NNNN_snake_case_subject.sql`, four digits,
sequential from `0001`, applied in filename order. The editorial store uses
the same scheme in its own directory, `migrations/editorial/`, because it is
a separate database with a separate `migrations_dir` in `wrangler.jsonc`.

**Forward-only.** There are no down migrations. A schema change is a new
numbered file. A destructive change is a new table, a backfill, and a read
expansion (§8.2); the old table is dropped by a later numbered file once
nothing reads it.

E-05a creates **no** migration and applies **no** migration. The DDL of
record is `src/editorial/schema.sql`, which is outside `migrations/` and is
therefore invisible to both the Wrangler runner and the margin test
harness.

### 8.2 The backfill and the expanded reader

The editorial store starts empty: there is no historical data to migrate
into it, because the pipeline that would have produced it has never run
through a gate. So the backfill is not a row copy; it is a **read
expansion**.

An **expanded reader** is a reader that consults the new store *and* the
legacy source, and prefers the new one:

1. read the current release for the target from the editorial store;
2. if there is none, fall back to the legacy source;
3. once the new store has a current release for the target, the legacy
   source is not consulted for that target any more.

The reader is expanded from the day the store exists, so the fallback is
always there and always correct; it is narrowed only at activation (E-06),
and narrowing it is a separate, explicitly authorised act. **A reader must
never be narrowed before the store is authoritative for a target**, and the
expanded reader is what makes "the production writer is unchanged" true:
the production writer keeps writing where it writes, and the new store is
filled beside it.

"Simulated current-only writes" — writing to the new store while the
production writer is still the only writer — are E05c's proof, run against
durable fixtures.

### 8.3 Failure recovery

| Partial failure | What happens | Retried or reconciled |
| --- | --- | --- |
| The renderer produced artifacts, the candidate append failed | the transaction rolled back; the bytes are orphaned | reconciled: unreferenced artifacts are deleted after a grace period |
| The artifacts were uploaded, the release append failed | the transaction rolled back; the release does not exist | reconciled: the same orphan sweep, plus a re-run of the release append |
| The producer signature did not verify | **nothing is appended** — the check happens before the write | not retried as-is; the producer re-signs |
| A CAS lost the race | zero rows changed; the writer re-reads and re-decides | retried, or refused if the aggregate is terminal |
| The idempotency receipt insert failed | the whole batch rolled back, record included | retried with the same key: it writes both |
| The validation ran and the append failed | the check is deterministic and re-runnable | retried: the same digests, the same result |
| The store was unavailable | the write is refused; nothing is half-written | retried by the caller |

The rule that makes all of this safe: **the evidence and the state change
commit together.** There is no state that says "validated" without the
validation record, and no release without its validations.

### 8.4 Retention

| What | How long | Deleted when |
| --- | --- | --- |
| `editorial_releases` | indefinitely | never. The ledger of what was published is the point. |
| `editorial_supersessions` | indefinitely | never. "This release was retired" must stay provable, or a superseded artifact could be presented as current. |
| `editorial_revisions`, `editorial_decisions`, `editorial_validations`, `editorial_approvals` | while referenced by a release; otherwise 180 days | pruned only when no release references the record and the record is not in a non-terminal state |
| `editorial_candidates` | while referenced by a release; otherwise 180 days | as above |
| `editorial_idempotency_receipts` | while the record they describe exists, plus 30 days | then, and only then — a key is never silently reused |
| the artifact **bytes** of a superseded release | 30 days | then. The *record* of them stays forever; only the bytes go. |
| the artifact bytes of a current release | while the release is current | when the release is superseded and the grace period ends |

### 8.5 The migration and the backfill E05c added

E05c adds the numbered migrations and the backfill §8.1 and §8.2
describe. It applies nothing, and it creates no database.

**The files.** `migrations/editorial/0001_editorial_store.sql` and
`migrations/editorial/0002_editorial_control.sql`, in the scheme of §8.1.
They are in their own directory because the editorial store is a separate
database with a separate `migrations_dir`, and the directory is what keeps
them out of the margin runner: the Wrangler runner for `MARGIN_DB` reads
`migrations/*.sql` and the margin test harness applies every
`migrations/*.sql` in filename order, and a *directory* is neither. The
`EDITORIAL_DB` binding and its `migrations_dir` are added when the cutover
is authorised, not before.

**0001** is the DDL of record, `src/editorial/schema.sql`, unchanged.
**0002** is the control the store needs beside the records: the durable
trust state (`editorial_trust_state`, `editorial_trust_events`), the
cutover switch (`editorial_switch_state`) and the backfill's cursor
(`editorial_backfill_progress`).

**The ledger.** `editorial_schema_migrations` records which numbered files
have been applied. The runner creates it itself, because it has to know
what is applied before it can decide what to apply.

**The backfill** copies the legacy source's records into the store, in
**dependency order** — a revision before the decision about it, a decision
before the candidate it authorises, a candidate before the validations and
the approval about it, a release last — in bounded batches, and records its
cursor after every batch. It is therefore interruptible (a run that stops
leaves a cursor) and resumable (the next run continues from the cursor). A
reader that finds a release in the store finds its whole chain beside it,
and never a release whose approval has not arrived yet.

**The materialised state of a restored row** is the *projected* state of
the whole legacy record set, not the state a new record starts in. A
revision that was approved before the cutover is restored as
`revision-approved`; a release that was superseded before the cutover is
restored as `release-superseded`, so the store's partial unique index —
one current release per target — holds over the restored set exactly as it
holds over a live one. The projection is §5's own (`validation.ts`), so the
restored column and the restored projection cannot disagree about what the
history says.

**The expanded reader** is `src/editorial/expanded-reader.ts`. It reads the
store first and the legacy source second, and it is correct throughout the
backfill: the copy is verbatim and the id is the content's digest, so the
record a reader observes for a target is the *same* record before and after
that target's row is migrated. The reader is observationally transparent.

**The cutover switch** is the durable state of the read mode, and it has
three states:

| Mode | What the reader does |
| --- | --- |
| `expanded` | the store first, the legacy source second. This is the reader of the day the store exists, so the fallback is always there and always correct. |
| `store-only` | the narrowed reader. Narrowing is the act of activation, and it is a separate, explicitly authorised one. |
| `legacy-only` | the rolled-back reader. The cutover was undone, so the store is not consulted at all. |

A rollback wins over a switch: a switch that was undone is not in force,
whatever its timestamps say. E05c narrows nothing.

### 8.6 The rollback and forward-recovery rehearsal

E05c rehearses both directions of the cutover on representative pre-switch
and post-switch records, in `src/editorial/recovery.ts`.

**The rollback.** The cutover is undone: the switch moves to `legacy-only`
and the reader serves the legacy source again. The post-switch records are
not served — they exist only in the store — and **nothing is deleted**. The
rehearsal asserts that the store holds the same number of records before
and after the rollback, so the rollback is recoverable rather than
destructive.

**The forward recovery.** The cutover is re-made: the switch moves back to
`store-only` and the reader serves the store again. The records the
backfill has not copied yet are still served from the legacy source,
because the reader is expanded.

**The unsafe package downgrade.** The rehearsal also re-pins the app — the
approved pin registry gains a newer pin, so every pin before it is older —
and then offers a candidate cut under a pin that was current before the
re-pin. The writer refuses it with `package_pin_downgrade`, and the refusal
writes nothing.

A downgrade is not a forged pin; it is a **stale** one. That is why the
approved pins are an *ordered* registry rather than a set, and why the
refusal is a refusal of the pipeline moving backwards rather than of a
digest that does not match.

---

## 9. The trust model (the contract E05b implements)

E-05a states this contract and implements **no cryptography in it**. The
shapes and the bounds are in `src/editorial/trust.ts`; the signature
verification, the key registry and the online authority are E05b's work, and
they are written against exactly these names.

### 9.1 Two records, not one

- The **release record** is the app's own durable ledger entry. It says
  what was published. It is written by the writer. **On its own it proves
  nothing to a consumer**, because a consumer cannot tell a genuine release
  record from a forged one.
- The **producer record** is the authenticated *export* of a release. It is
  signed by a producer key. It is what a consumer authenticates before it
  resolves anything, and it is self-contained: a consumer that holds only
  the producer record knows which revision was approved, which bytes were
  published, under which package, schema, target and artifact versions, and
  can check all of it.

### 9.2 The producer record

`recordType: 'erniesg.editorial.producer-export.v1'`, `version: '1.0.0'`:

| Field | Meaning |
| --- | --- |
| `producerRecordId` | this record's own id |
| `eventId` | the event it reports |
| `keyId`, `policyEpoch` | the key and the trust epoch that signed it |
| `releaseId`, `releaseSha256` | the release it exports, and its digest |
| `approvedRevisionId`, `contentHash` | the approved revision and its content hash |
| `documentSha256`, `bundleSha256?` | the canonical digests |
| `package` | `{ sourceCommit, artifact, artifactSha256, integrity, version }` — the provenance source |
| `schemaVersions` | the artifact schema versions |
| `artifacts`, `artifactSetSha256` | the exact published bytes |
| `target` | the audience and target |
| `issuedAt`, `expiresAt` | the validity window |
| `status` | `'active' \| 'superseded' \| 'revoked'` |
| `supersedes?` | the producer record this one replaces |
| `signatureAlgorithm`, `signature` | the detached signature, base64url |

### 9.3 The rules, all fail-closed

1. **Monotonic epochs; one producer record per epoch.** `policyEpoch` is a
   non-negative integer that only ever increases, and it is the epoch of the
   **key's authority**, not a counter of the records. A consumer keeps the
   highest epoch it has accepted and refuses anything at or below it
   (`trustEpochIsAcceptable`; refusal reason `producer_epoch_not_advanced`).
   An equal epoch is refused because the contract admits **exactly one
   producer record per epoch**: a record at an already-accepted epoch is
   treated as a replay, since the epoch alone cannot tell a distinct record
   from a replayed one. A lower epoch is a rollback and is refused, not
   merged.

   - **A distinct record at the already-accepted epoch.** The contract does
     not admit one today, and it does not pretend to. Admitting it needs a
     **per-record replay ledger**: the pair (`eventId`, the record's own
     digest) of every record the consumer has accepted. A record whose pair
     is already in the ledger is a replay; a record whose pair is not is a
     distinct record. That ledger is E05b's, and with it the epoch is used
     *only* for rollback detection. Until the ledger exists, the epoch rule
     stands on its own and refuses the second record.
   - **What a `supersedes` record does to the epoch.** Nothing by itself: a
     producer record that supersedes another **inherits the epoch of the
     record it replaces**, because supersession is the same authority saying
     something new about the same release, and only a rotation advances the
     epoch (rule 3). Under the rule as implemented, a superseding record is
     therefore refused as `producer_epoch_not_advanced` unless the producer's
     key is issued under a fresh epoch — so **E05b owns the answer**: it
     either issues a fresh epoch for a supersession, or it adds the
     per-record replay ledger above and tells the superseding record apart
     by its (`eventId`, digest) pair. What E05b may not do is accept a
     second record at an epoch on the strength of the epoch alone.
   - **`status` is not the epoch.** `status` (`active`, `superseded`,
     `revoked`) is the record's own claim about the export it carries, it
     is inside the signed payload, and it never lowers the epoch: a consumer
     refuses a record whose `status` is not `active` when it resolves the
     current release, and it takes the epoch only from the epoch rule and
     the key registry.
2. **Freshness.** A record outside its validity window, issued too far in
   the future, claiming a validity window longer than
   `TRUST_MAX_VALIDITY_SECONDS` (7 days), or older than
   `TRUST_MAX_RECORD_AGE_SECONDS` (24 hours) is refused. **Stale or
   offline status is a refusal, never a fallback to the last known good
   record.**
3. **Rotation.** A new key is introduced under a new epoch. The old key
   stays usable only until its `notAfter`, and only for records it issued
   before then. A rotation whose overlap exceeds
   `TRUST_KEY_ROTATION_MAX_OVERLAP_SECONDS` (24 hours) is a migration, not a
   rotation, and needs its own epoch.
4. **Revocation.** A revoked key is refused from its revocation's effective
   time onwards. A **compromised** key is refused for its *entire* lifetime,
   because the records it signed before the compromise are exactly the ones
   an attacker could have made. The escape hatch — a trusted timestamp or a
   transparency-log inclusion proof placing the issue time before the
   compromise — belongs to the verifier, and is not modelled here.
5. **The authority.** A consumer must hold either a linearizable
   compare-and-advance local epoch state, or a current authenticated online
   authority, before it resolves anything. If it has neither, it fails
   closed. A consumer that cannot verify the signature must not treat
   `trustPreconditionsHold`'s answer as an authorisation: that function
   answers only the questions that do not need the signature. The consumer
   must also hold the **epoch floor** the app has provisioned (§9.5): the
   local epoch state is *relative* — it says what this consumer has
   accepted — so on its own it cannot tell a stale policy from the current
   one until the consumer has accepted the current epoch under it.

### 9.4 What E05b must add

The signature verification, the key registry (with rotation and revocation
effective times), the transparency-log or trusted-timestamp path for a
compromised key, the linearizable epoch state, **the per-record replay
ledger — or a fresh epoch per superseding record — that settles §9.3's
open question**, and the negative matrix:
swapped, stale, superseded, replayed, wrong-audience, revoked-key,
digest-mismatched, policy-rollback, expired-policy, unavailable-beyond-
freshness and improperly backdated-after-compromise records must all fail
closed.

### 9.5 What E05b settled and implemented

E05b implements §9.4. This subsection states what it settled, because two
of the questions §9.3 left open had more than one consistent answer, and
the settlement is part of the contract.

**The primitive: ECDSA over NIST P-256 with SHA-256, detached, through
WebCrypto** (`globalThis.crypto.subtle`). No dependency is added; the app
already uses `crypto.subtle.digest` in `src/research/epub.ts`,
`src/research/docx-import.ts` and `src/research/overrides.ts`, and the
primitive runs unchanged in Node, in the Worker and in a browser, so a
producer in Node and a consumer in the Worker verify with the same code. It
is asymmetric, so the consumer holds the *public* key and the key registry
is publishable. P-256 is the one asymmetric algorithm every WebCrypto
implementation is required to have. `EDITORIAL_SIGNATURE_ALGORITHMS` names
three algorithms; **this implementation supports exactly one and refuses the
other two** with `producer_signature_algorithm_unsupported`, because a
verifier that guesses is a verifier that can be fooled.

**What is signed.** The signed message is the **canonical digest** of the
record's signing payload — every field except `signature` — under the
domain tag `erniesg.editorial.producer-export.v1`:

```
signing payload = every field of the record except `signature`
digest          = structDigest({ domain, payload })   // the pinned Struct digest
signed message  = the 32 raw bytes of that digest
signature       = ECDSA-P256-SHA256(message, privateKey), base64url, detached
```

The digest is the pinned Struct package's `structDigest` (`ids.ts`), so the
bytes that are signed are the bytes the app's one canonical serializer
produces. Every field is covered, `issuedAt` and `expiresAt` included: a
field that is not in the payload is a field an attacker may change. The
record's own id is derived from the same canonical form
(`erniesg.editorial.producer-id.v1`), so the id is a function of the signed
content and cannot be swapped.

**The key identity is the public key fingerprint.** The key id is
`<algorithm>:<fingerprint>`, where the fingerprint is the SHA-256 of the
key's SPKI bytes. A record that names a key id can therefore only be
verified against the key whose fingerprint that id names, and a registry
entry whose key id is not its own fingerprint is refused
(`producer_key_identity_mismatch`). The material the consumer needs to
verify is in the **policy epoch document** (§9.6), which is itself signed
by the trust root; the producer record carries the identity, not the key.

**The epoch rule, settled.** The **policy epoch** is the monotonic unit: it
is the epoch of the *authority* (the key set), not a counter of the
records.

- A policy at a **lower** epoch than the one the consumer has accepted is a
  **rollback** and is refused (`trust_policy_rollback`).
- A policy at the **same** epoch is the same policy. It neither advances
  the state nor is a refusal.
- A policy at a **higher** epoch advances the state, and the advance is a
  **compare-and-advance**: it happens only if the state has not moved since
  it was read. Two consumers that race lose one of the two advances, and
  the loser refuses (`trust_state_concurrent_modification`).

**The epoch floor, settled.** The rollback rule above is **relative**: it
compares the policy with the epoch *this consumer* has accepted, and the
accepted epoch only advances when a producer record is accepted under a
policy. So the rollback rule on its own is **not** the anti-rollback
property, and the design record does not claim it is. A consumer that has
accepted nothing yet (its accepted epoch is `-1`) cannot tell a stale
policy from the current one, and an attacker who holds an old, genuinely
root-signed policy can serve it with an old key set that carries a key the
current policy has revoked.

The **epoch floor** closes that hole, and it is the app's own configuration:
the trust root carries `minPolicyEpoch`, the epoch the app has provisioned.

- A policy at an epoch **below the floor** is refused
  (`trust_policy_epoch_below_floor`), and it is refused **before the key
  lookup**: the stale policy's key set is never consulted at all, so it
  cannot resurrect a revoked key.
- The floor is covered by the **trust root's own signature**. The root is a
  signed document about itself, so lowering the floor takes the root's
  private key: a root whose floor was edited without re-signing it does not
  verify, and the consumer refuses it (`trust_root_unauthenticated`) rather
  than accept the lower floor. The root's **public key** is the anchor and
  is pinned out of band; the self-signature is the root's integrity check
  on its own contents.
- The floor and the rollback rule are both epoch refusals, and the floor is
  checked first: it is the absolute statement ("this policy is older than
  the app's authority"), while the rollback rule is the relative one.

Together the two give the property the earlier draft of this record
claimed for the rollback rule alone: an attacker cannot serve an old
policy, with an old key set, to resurrect a key that has since been
revoked. The residual exposure of a consumer that is provisioned with **no**
floor (a floor of `0`) is exactly the exposure the rollback rule leaves: a
consumer below the authority's current epoch cannot detect the rollback on
its own.

The **record's** `policyEpoch` is the epoch of the key that signed it: it
must equal that key's epoch and must not exceed the policy's epoch. It is
*not* compared with the accepted epoch, because §9.3's rule 3 requires that
a superseded key stays usable for the records it issued before its
`notAfter` — and those records carry the old epoch. Whether an old key may
still validate a record is decided by the **current** policy's registry
entry (its validity window, its revocation, its compromise), not by an
epoch counter.

**§9.3's open question, settled: the replay ledger.** The ledger holds the
pair (`eventId`, the record's own digest) of every record the consumer has
accepted. A pair that is already in the ledger is a replay
(`producer_record_replayed`); an `eventId` that is already in the ledger
with a *different* digest is an event id presented twice with different
content (`producer_event_id_reused`). Both are refusals. So the epoch's
role is reduced to rollback detection of the authority, and the ledger —
not the epoch — is what tells a superseding record from a replayed one.
The ledger only has to hold the pairs inside the freshness window, because
a record older than the freshness bound is refused before the ledger is
consulted.

This is the one place where E05b's rule is *wider* than §9.3's strict
"refuses anything at or below it". It has to be: under the strict rule
every record after the first would need a new epoch, which makes §9.3's
rotation overlap (§9.3 rule 3) and every supersession unreachable. The
strict helper `trustEpochIsAcceptable` in `trust.ts` is left as E-05a
wrote it and remains the rule for a consumer that keeps no ledger; E05b's
verifier is the ledger-bearing variant, and it refuses a *lower* epoch
exactly as the strict rule does.

**Rotation.** A new key is introduced under a new epoch. The old key stays
usable only until its `notAfter`, and only for the records it issued
before then. A policy whose successor key takes over more than
`maxRotationOverlapSeconds` after its predecessor stopped is a migration,
not a rotation, and is refused
(`trust_policy_rotation_overlap_exceeded`).

**Revocation and compromise.** A revoked key is refused **from the
revocation's effective time onwards** (`producer_key_revoked`): what it
signed before the revocation is still good. A **compromised** key is
refused for its **entire lifetime** (`producer_key_compromised`): the
records it signed before the compromise are exactly the records an attacker
could have made. The one exception is evidence — a **pre-compromise
inclusion proof**, a trusted timestamp or a transparency-log inclusion,
signed by a registered timestamp authority, naming the record's digest and
placing its issue time *before* the compromise. Without such a proof, or
with a proof the authority did not make before the compromise, the key is
treated as revoked for its whole life.

**Freshness.** The bounds are the **policy's own** (inside the policy's
signature, so they cannot be widened by an attacker): the freshness bound
on a record's age, the longest validity window a record may claim, the
future skew, and the rotation overlap. A record outside its window, issued
too far in the future, claiming too long a window, or older than the
freshness bound is refused (`producer_record_not_fresh`). A policy past its
expiry is refused (`trust_policy_expired`); a policy that is not yet valid
is refused (`trust_policy_not_yet_valid`).

**Failing closed.** Every failure is a refusal with a specific reason, and
there is no "assume valid" path: no policy (`trust_policy_unavailable`), a
malformed policy (`trust_policy_malformed`), an unauthenticated policy
(`trust_policy_unauthenticated`), a trust root that does not satisfy its
schema (`trust_root_malformed`) or whose own signature does not verify
(`trust_root_unauthenticated`), a policy below the app's epoch floor
(`trust_policy_epoch_below_floor`), a trust state that cannot be read
(`trust_authority_unavailable`), a compare-and-advance that lost the race
(`trust_state_concurrent_modification`). A refusal writes nothing: the
trust state is advanced only when the whole chain has been verified. The
signature refusal is deliberately **non-leaking**: a bad signature, a
truncated signature, a signature over different bytes and a signature by a
different key are all `producer_signature_invalid`.

**The refusal reasons**, in `PRODUCER_REFUSAL_REASONS`
(`src/editorial/trust-policy.ts`):

| Reason | Meaning |
| --- | --- |
| `producer_record_malformed` | the record does not satisfy its own schema |
| `producer_record_id_mismatch` | the record's id is not derived from its content |
| `producer_signature_algorithm_unsupported` | the algorithm is not one this verifier implements |
| `producer_signature_invalid` | the signature does not verify (non-leaking) |
| `producer_key_unknown` | the policy does not carry the key the record names |
| `producer_key_identity_mismatch` | the registry entry's key id is not its fingerprint |
| `producer_key_material_invalid` | the registry entry's fingerprint is not its public key |
| `producer_epoch_mismatch` | the record's epoch is not its key's epoch, or exceeds the policy's |
| `producer_record_not_fresh` | the record is expired, too old, or from too far in the future |
| `producer_record_superseded` | the record's own status says it is superseded |
| `producer_record_revoked` | the record's own status says it is revoked |
| `producer_record_replayed` | the (event id, digest) pair was already accepted |
| `producer_event_id_reused` | the event id was already accepted with other content |
| `producer_key_not_usable` | the record was issued outside the key's validity window |
| `producer_key_revoked` | the key was revoked at or before the record's issue time |
| `producer_key_compromised` | the key was compromised and there is no pre-compromise proof |
| `producer_artifact_set_mismatch` | the record's artifact set digest is not its artifacts' digest |
| `producer_digest_mismatch` | a bound digest is not the digest it must equal |
| `producer_target_mismatch` | the record is not for the target being resolved |
| `producer_audience_mismatch` | the record is not for the audience being resolved |
| `producer_release_mismatch` | the record does not name the release being resolved |
| `producer_revision_stale` | the record was issued against a superseded revision |
| `trust_root_malformed` | the trust root does not satisfy its schema |
| `trust_root_unauthenticated` | the trust root's own signature does not verify, so its epoch floor is not trusted |
| `trust_policy_malformed` | the policy does not satisfy its schema |
| `trust_policy_unavailable` | there is no policy, so there is no authority |
| `trust_policy_unauthenticated` | the policy's signature does not verify against the root |
| `trust_policy_expired` | the policy is past its expiry |
| `trust_policy_not_yet_valid` | the policy claims to be from the future |
| `trust_policy_rollback` | the policy's epoch is older than the accepted epoch |
| `trust_policy_epoch_below_floor` | the policy's epoch is below the trust root's epoch floor |
| `trust_policy_rotation_overlap_exceeded` | the policy's key rotation overlaps too long |
| `trust_authority_unavailable` | the trust state could not be read |
| `trust_state_concurrent_modification` | the compare-and-advance lost the race |

### 9.6 The authenticated policy epoch document

The consumer needs an authority before it resolves anything: a **policy
epoch document**, signed by the **trust root**, carrying the epoch, the
bounds and the key registry.

```
recordType: 'erniesg.editorial.trust-policy.v1', version: '1.0.0'
policyEpoch, issuedAt, expiresAt
bounds: { maxRecordAgeSeconds, maxValiditySeconds,
           maxFutureSkewSeconds, maxRotationOverlapSeconds }
keys: [ { keyId, policyEpoch, algorithm, notBefore, notAfter,
          revokedAt?, compromisedAt?, publicKeySpki, fingerprint } ]
signatureAlgorithm, signature
```

The **trust root** is app-owned configuration, configured out of band, the
same way the margin service's allowlist and the target registry are: it is
the only thing a consumer trusts a priori. It carries the root's public key
and the **timestamp authorities** — the keys that may vouch for a record's
inclusion — and the **epoch floor** `minPolicyEpoch` the app has
provisioned, which the root's own signature covers:

```
version: '1.0.0'
minPolicyEpoch                      # the epoch floor, in the root's signature
key: { keyId, algorithm, publicKeySpki, fingerprint }
timestampAuthorities: [ { keyId, algorithm, publicKeySpki, fingerprint } ]
signatureAlgorithm, signature       # the root's own signature over the above
```

The root is a **signed document about itself**: the signature covers every
field except the signature itself, under the domain tag
`erniesg.editorial.trust-root.v1`. A root whose floor was lowered without
the root's private key does not verify, and the consumer refuses it
(`trust_root_unauthenticated`). The anchor is still the root's **public
key**, pinned out of band.

The verification order is the order a reader cares about: **who is the
authority** (the root, its own signature, the policy, its signature, its
epoch against the floor and against the accepted epoch, its freshness, its
rotation), then **what is the record** (its schema, its id, its key, its
epoch), then **is it authentic** (its signature), then **may it be used**
(its status, its freshness, its key's usability, the replay ledger), and
finally **does it bind what the consumer is resolving** (the target, the
digests, the release and the revision).

### 9.7 The negative matrix

Every one of these fails closed, with the reason the code returns. The
tests are in `src/editorial/trust-policy.test.ts` and
`src/editorial/producer-record.test.ts`.

| Case | What it is | Refusal |
| --- | --- | --- |
| forged bundle | fully rehashed and self-consistent under the Struct digest; Struct integrity passes | `producer_signature_invalid` |
| swapped | the record's digests are not the bundle's digests | `producer_digest_mismatch` |
| stale | the record was issued against a superseded revision | `producer_revision_stale` |
| superseded | the release the record names is no longer current | `producer_record_superseded` |
| replayed | the same event id presented twice | `producer_record_replayed` |
| wrong audience | the record is for another audience | `producer_audience_mismatch` |
| wrong target | the record is for another target | `producer_target_mismatch` |
| revoked key | the key was revoked at or before the issue time | `producer_key_revoked` |
| digest mismatch | the record's artifact set digest is not its artifacts' digest | `producer_artifact_set_mismatch` |
| policy rollback | an older policy epoch after a newer one was accepted | `trust_policy_rollback` |
| policy below the epoch floor | a stale policy, genuinely signed by the trust root, whose epoch is below the app's provisioned floor | `trust_policy_epoch_below_floor` |
| tampered trust root | the root's floor was lowered, or its own signature does not verify | `trust_root_unauthenticated` |
| expired policy | the policy is past its expiry | `trust_policy_expired` |
| unavailable beyond freshness | the trust state cannot be read | `trust_authority_unavailable` |
| past the freshness bound | the record is older than the policy's bound | `producer_record_not_fresh` |
| backdated after compromise | a compromised key's record, with no pre-compromise proof | `producer_key_compromised` |

---

## 10. The inactive writer and route

### 10.1 Their shape

E-05a writes **neither**. The seam is fixed here so E05c has one contract
to build on, and so the review of E-05 can check that the seam is right
before anything is built.

**The inactive writer** is a `EditorialWriter` behind a repository seam, in
the shape of `MarginRepository` (`src/worker/margin/repository.ts`): the
handlers depend on the interface and never on D1. Its methods are one per
transition, plus the reads:

```ts
interface EditorialWriter {
  proposeRevision(input): Promise<EditorialRevision>
  recordDecision(input): Promise<EditorialDecision>
  assembleCandidate(input): Promise<EditorialCandidate>
  recordValidation(input): Promise<EditorialValidation>
  recordApproval(input): Promise<EditorialApproval>
  recordRelease(input): Promise<EditorialRelease>
  supersedeRelease(input): Promise<EditorialSupersession>
  currentReleaseForTarget(targetId): Promise<EditorialRelease | null>
}
```

Each method: reads the records the transition needs, calls `applyTransition`,
and on a refusal returns the refusal code and writes nothing; on an
allowance, writes the record and the state change in **one** transaction,
with the CAS on the aggregate's `state`, and the idempotency receipt in the
same batch.

**The inactive route adapter** is a route that serves the *current* release
for a target, and it refuses rather than falls back:

- no current release for the target → 404, never the legacy artifact;
- the current release is superseded → it is not current, so it is not
  served;
- the release's producer binding is not verified → **fail closed**, 503,
  never the artifact.

It is structured like `src/worker/gate.ts`: the gate is at the composition
root, not in each handler, so a route that forgets to call it cannot exist.
"**Gated by omission rather than open by omission**" is the phrase from
that file, and it is the rule the inactive adapter must follow: a prefix
that is not registered in `WORKER_FIRST_PREFIXES` is not served at all,
rather than served by a handler that forgot to check.

### 10.2 The statement

**The production writer and the public route are UNCHANGED and INACTIVE.**

- The production writer is `tools/publication-build.mjs` and
  `src/publication/renderers/vivliostyle.ts`. E-05a does not modify them,
  does not import them, and does not run them.
- The public route is the Astro route that serves the published artifacts.
  E-05a does not modify it, does not add a route, and does not add a
  Worker prefix.
- No gate is opened, no gate is closed, and no configuration is changed.
  `wrangler.jsonc` and `wrangler.production.jsonc` are untouched.
- The editorial store does not exist yet: no database is created, no
  migration is applied, no live database is touched, and nothing is
  deployed.
- `src/editorial/**` is imported by nothing outside itself and by its own
  tests. The tree is inert code until E05c wires it, and E05c's wiring
  must also be inert.

The proof is the diff: E-05a's two commits touch `docs/` (one new file) and
`src/editorial/**` (new files) and nothing else. The command is in the
report.

### 10.3 The storage adapter, the writer and the route adapter E05c built

E05c builds the three modules §10.1 describes, and wires none of them.

| Module | What it is |
| --- | --- |
| `src/editorial/d1.ts` | the slice of the D1 client the store uses, typed structurally |
| `src/editorial/queries.ts` | every statement the store runs, as pure `(sql, params)` values |
| `src/editorial/repository.ts` | the storage seam: `EditorialRepository` |
| `src/editorial/d1-repository.ts` | the D1 implementation of the seam |
| `src/editorial/sqlite-fixture.ts` | the durable SQLite fixture the store is exercised against |
| `src/editorial/migration.ts` | the migration scheme, the runner and the backfill |
| `src/editorial/expanded-reader.ts` | the expanded reader of §8.2 |
| `src/editorial/legacy-source.ts` | the legacy publication source, and the static one the tests use |
| `src/editorial/activation.ts` | the activation value the inactive modules refuse without |
| `src/editorial/package-pin.ts` | the approved package pins and the downgrade refusal |
| `src/editorial/writer.ts` | the inactive writer |
| `src/editorial/route-adapter.ts` | the inactive public-route adapter |
| `src/editorial/trust-store.ts` | the durable trust state E05b's contract asks for |
| `src/editorial/recovery.ts` | the rollback and forward-recovery rehearsal |

**The store.** Three rules, and they are the store's job rather than the
caller's:

1. **A write is one transaction.** The record, the aggregate's state change
   and the idempotency receipt are one `batch()`. A reader never sees a
   record without its receipt, or a receipt without its record.
2. **A refused write writes nothing.** The compare-and-swap guard lives in
   the insert statement itself — `INSERT ... SELECT ... WHERE EXISTS
   (SELECT 1 FROM <aggregate> WHERE id = ? AND state = ?)` — so a lost race
   inserts nothing, updates nothing and receipts nothing. It is the app's
   existing idiom: the margin service puts the same guard in the same
   statement as the write.
3. **A row is read back through its own schema.** Every read parses the
   row with the zod schema of its kind, so a row that does not satisfy the
   record contract is a hard failure rather than a shrug.

**The durable fixture** is a *file*, not `:memory:`. An in-memory database
proves nothing about durability: a reader that opens a second connection
sees nothing. The fixture is a file in a temporary directory the fixture
owns, so a second connection sees the committed rows, the file survives the
close of the first connection, and an interrupted run leaves a real file
behind.

**The activation value.** The writer and the route adapter refuse to act
unless the caller hands them an activation. It is a **phrase**, not a
configuration file, an environment variable or a binding: every one of
those is a thing a later commit could add without anybody thinking about
it, while a phrase has to be *carried*, per call, by the caller. The
phrase is exported, so it is not a secret — it is a **claim of authority**:
the caller has read this record and has decided the cutover may happen. The
only place in this repository that supplies one is the editorial module's
own test.

**The writer.** One method per transition, plus the reads. Each method
refuses without an activation, answers a replay, decides with
`applyTransition`, checks the expected version against the transition's
`from`, and writes once. The package pin check is a *precondition* of the
writer rather than a rule of the state machine: the pins are app-owned
configuration, and a configuration is not part of a pure function over
records.

**The route adapter.** It refuses rather than falls back. The four
refusals that matter are:

| Refusal | Status | What it means |
| --- | --- | --- |
| `editorial_artifact_unapproved` | 503 | the release binds no approval, or the approval does not authorise the candidate |
| `editorial_release_superseded` | 410 | the release is retired and is not current |
| `editorial_approval_digest_mismatch` | 503 | the approval is about different digests |
| `editorial_producer_record_revoked` / `editorial_producer_record_expired` | 503 | the producer record is revoked, or outside its validity window |

The 503s are one answer: the adapter cannot establish that the artifact is
current and approved, and a reader that cannot establish that gets an
error, not a stale artifact.

### 10.4 The inactivity evidence

Two independent claims, and neither of them is "the code looks inactive".

1. **The import graph.** Nothing the Worker serves and nothing the site
   serves reaches `src/editorial/**`. It is computed with the TypeScript
   compiler's own resolver over the project's real `paths` mapping, from
   the Worker entry and from every route, following the transitive closure
   — so an alias, a re-export and a dynamic import are all followed. The
   assertion is on the *graph*, not on a grep of the tree.
2. **The bytes.** The production writer (`tools/publication-build.mjs` and
   `src/publication/renderers/vivliostyle.ts`) and every route under
   `src/pages/**` are byte-identical to the commit E-05 started from
   (`9003ea76`), and the only files E-05 changed are the editorial
   modules, the editorial migrations and this design record.

E05c's commits extend that diff: the editorial modules, the editorial
migrations, and this record. Nothing else.

There is a third, weaker claim, and it is worth stating because it is the
one that survives a careless future commit: the activation phrase appears
in no module outside `src/editorial/`, so a module that wanted to activate
the writer would have to add the phrase itself — which is a change anybody
can see in the diff.

---

## 11. What E-05 explicitly does NOT do

- **No production writer switch.** The writer stays as it is. E-05 does not
  choose which schema the writer writes, and does not write the new schema.
- **No public-route activation.** The route that serves the artifacts is
  untouched. The inactive adapter is not built here and, when it is built
  (E05c), it stays behind a gate that is closed.
- **No package publication.** `@erniesg/struct` is not published, and its
  version is not changed. The pin in `package.json`, the lockfiles and
  `vendor/struct/provenance.json` are untouched.
- **No deletion of compatibility sources.** `src/struct/**`,
  `src/struct-adapters/**`, the legacy `ResearchPaper` path and the local
  portable Struct copies all stay. That is E-07's job, after E-06.
- **No Aether composition.** Nothing here is composed into
  `erniesg/aether`, and the producer record is not consumed by anything.
- **No Rucksack domain logic.** Rucksack is a separate lane.
- **No change to the Struct package, the Struct pin, or any lockfile.**
- **No migration applied, no live database touched, no deployment, no
  activation of any kind.**
- **No cryptography in the trust contract.** E-05a fixes the shapes and the
  bounds; E05b implements the verification.
- **No new product feature.** This is the durable record contract for the
  publication pipeline that already exists.

---

## 12. The modules

| Module | Owns |
| --- | --- |
| `src/editorial/records.ts` | the seven record schemas, the target, the actors, the app-owned source binding, the cross-field rules |
| `src/editorial/ids.ts` | the immutable id derivation, the content and artifact-set digests, the idempotency fingerprint |
| `src/editorial/validation.ts` | the cross-record rules and the state projections |
| `src/editorial/state-machine.ts` | the transition table, the actor authorisation, the pure transition function, the refusal codes |
| `src/editorial/trust.ts` | the producer record shape and the trust bounds (no cryptography) |
| `src/editorial/producer-record.ts` | the producer record's field list, its canonical payloads, its id and digest derivations, the key material and its fingerprint, the detached signature and its verification |
| `src/editorial/trust-policy.ts` | the authenticated policy epoch document, the trust root, the key registry, the inclusion proof, the monotonic trust state and its replay ledger, the compare-and-advance store, and the verification |
| `src/editorial/producer-fixtures.ts` | the shared producer and trust fixtures (test-only) |
| `src/editorial/schema.sql` | the DDL of record (not applied) |
| `src/editorial/fixtures.ts` | the shared test fixtures |
| `src/editorial/index.ts` | the public surface |
| `src/editorial/*.test.ts` | the accept path and every refusal path |

The dependency direction is one way: `records.ts` → `ids.ts` (runtime),
`ids.ts` → `records.ts` (types only), `state-machine.ts` → `records.ts`,
`ids.ts`, `validation.ts`, `validation.ts` → `records.ts` (types only). There
is no cycle.

E05b's two modules continue that direction:
`producer-record.ts` → `ids.ts`, `records.ts`, `trust.ts`;
`trust-policy.ts` → `ids.ts`, `records.ts`, `trust.ts`, `producer-record.ts`.
`src/editorial/index.ts` is E-05a's file and is **not** extended here: the
E05b modules are imported by path, and whoever owns the public surface
(`index.ts`) may re-export them.

E05c's modules continue that direction too, and they add one new rule:
**a module under `src/editorial/` is imported by nothing outside
`src/editorial/`**. The dependency arrows are:

`d1-repository.ts` → `d1.ts`, `queries.ts`, `records.ts`, `ids.ts`,
`repository.ts`;
`repository.ts` → `queries.ts` (types only);
`writer.ts` → `activation.ts`, `ids.ts`, `package-pin.ts`,
`state-machine.ts`, `records.ts`, `repository.ts`, `validation.ts`;
`route-adapter.ts` → `activation.ts`, `ids.ts`, `package-pin.ts`,
`records.ts`, `repository.ts`, `trust-policy.ts`, `validation.ts`;
`expanded-reader.ts` → `migration.ts`, `records.ts`, `repository.ts`,
`validation.ts`;
`legacy-source.ts` → `migration.ts`, `records.ts`, `validation.ts`;
`migration.ts` → `records.ts`, `repository.ts`, `validation.ts`;
`recovery.ts` → `activation.ts`, `expanded-reader.ts`, `migration.ts`,
`package-pin.ts`, `records.ts`, `repository.ts`, `writer.ts`;
`trust-store.ts` → `d1.ts`, `queries.ts`, `trust-policy.ts`.

There is no cycle among them, and none of them is imported by the Worker,
by a route or by the production writer.

E05c's modules are listed with what they own in §10.3; the tests are
`src/editorial/storage.test.ts`, `src/editorial/writer.test.ts`,
`src/editorial/route-adapter.test.ts`, `src/editorial/concurrency.test.ts`,
`src/editorial/migration.test.ts`, `src/editorial/recovery.test.ts` and
`src/editorial/inactivity.test.ts`.
