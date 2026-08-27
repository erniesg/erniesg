# Dependency-ordered issue plan for ADR-0001

- Status: User-approved and created; the sole coordinator created all 25 mapped GitHub issues, while implementation and downstream action gates remain separately controlled
- Parent decision: `ADR-0001: Domain ownership and package boundaries for Struct, Ernie.SG, Rucksack, and Aether`
- Date: 2026-08-27
- External mutation owner: one coordinator only

## Creation record and execution gates

The issue-creation gate was satisfied on 2026-08-27:

1. ADR-0001 and this issue plan received independent architecture, security, and landability review at fresh exact default heads.
2. Actionable review findings were repaired and fresh passes found none in the then-reviewed scope.
3. The user explicitly approved coordinator-owned GitHub issue creation.
4. The coordinator rechecked current default heads/open work and created the 25 mapped issues. Their durable repository, number, URL, and recorded state are in the machine-readable issue map.

Completed issue creation does not authorize implementation, package publication, deployment, pull-request mutation, issue transfer, visibility change, outreach, E-ACT, A-REQ, or A-ACT. Before any issue executes, its owner must recheck its exact base, dependency evidence, open work, and reserved seams. The coordinator owns every external mutation unless it explicitly delegates one idempotent, target-scoped operation.

The map retains the completed GitHub creation order as history. It is not execution authority. `depends_on`, `phase_zero_runtime_gate`, and `recommended_execution_dependency_order` are the corrected execution contract; in particular, S-02 cannot start until A-01 lands.

## Planning baseline

| Repository | Architecture-assessment baseline | Final remote-default revalidation |
|---|---:|---:|
| `erniesg/struct` | `6ecb78d1753b847ec7295bf45f43237225663728` | unchanged |
| `erniesg/erniesg` | `c7a706ecbac1a527cad11a3246e602bd56636d6f` | unchanged |
| `erniesg/rucksack` | `9284e95430bb1556d8614427ca05e553d9930dc9` | `2513b7a76ad50e9751101454054bf1120cb1983e`; intervening Evidence Lab-only range audited, gate remains 0/579 |
| `erniesg/aether` | `f8643bee4819afa465be3e32fdd63788566987e6` | unchanged |

Every issue begins by recording its actual base SHA. If a default moved, the owner must inspect the intervening diff and revalidate the issue's assumptions before changing code.

## Dependency tree

```text
ADR/plan reviewed, issue creation explicitly approved, and all 25 issues created
|
+-- Documentation spine (serialized across repositories)
|   S-01 Struct contract and API/release manifest
|     `-- E-01 Ernie.SG product/architecture contract on current base
|           `-- A-01 Aether manual current/target/released-state reconciliation
|           `-- E-WF Register and reconcile Ernie.SG's generated publisher workflow
|
+-- Struct runtime spine (starts only after the complete documentation spine)
|   A-01
|     `-- S-02 Correct Struct dependency direction and public boundary
|           `-- S-03 Implement the fail-closed StructBundle contract
|                 `-- S-04 Prove the packed package in a clean consumer
|
+-- Ernie.SG migration spine
|   S-04 + E-01 + E-WF
|     `-- E-02 Establish the app-owned Struct adapter and frozen parity corpus
|           `-- E-03 Cut over core/codecs/IDs/ordering/recovery
|                 `-- E-04 Cut over XHTML/EPUB and converge publication semantics
|                       `-- E-05 Design and implement durable publication behind an inactive gate
|                             `-- E-ACT target-specific writer/public-route activation decision
|                                   `-- E-06 Activate one governed writer/public route
|                                         `-- E-07 Remove duplicate portable Struct sources/tests
|
+-- Optional Aether runtime spine
|   A-01 + S-04 + E-06 + completed versioned printer requirements
|     `-- A-02 checkpoint 0: independently review renderer/profile contract proof
|           `-- A-02 runtime: inactive authenticated Struct import and local A5/social proof
|                 `-- A-ACT target-specific route/deployment/printer-submission decision
|
`-- Rucksack safety/architecture spine (separate repository lane)
    R-01 Authority-path registry and architecture import contract
      |-- R-02 Bind filesystem rollback and repository provisioning authority
      |     `-- R-07 Make remaining receipts/stores descriptor-rooted and race-safe
      |-- R-03 Make credentials, publisher identity, and hosted identity opaque
      |-- R-04 Bind VM generations and supervise complete process trees
    R-03 + R-04 -> R-05 Constrain VM sandbox credentials/mounts/egress
    all R-02..R-05 + R-07 -> R-06 universal revalidation/single-use ledger
      `-- all R-02..R-07 safety gates pass -> R-08 Cut autopilot/VM/notification cycles and shrink the canonical SCC
            `-- R-09 Cut merge/PR/GitHub/provenance cycles and shrink the SCC
                  `-- R-10 Invert scaffold/setup dependencies and shrink the SCC
                        `-- R-11 Split product-server delivery and finish with SCC <= 1
```

The Struct -> Ernie.SG -> Aether documentation order is mandatory. S-02 and every Struct/Ernie.SG/Aether runtime descendant remain blocked until A-01 lands. Rucksack work is domain-independent, but its mutations must still be deconflicted with all active Rucksack lanes.

## Issue sizing rules

Each issue below is one coherent, independently reviewable unit. Split an issue before implementation if its pilot diff exceeds a reviewer's ability to reason about one dependency cut, but do not create one-function-file or path-only fragments.

The tree contains 25 coordinator-created GitHub issues plus three non-issue action/activation decision gates. That is the maximum initial tree; implementation discoveries may split a node only before it starts and must retire the original bucket rather than creating an unbounded parallel backlog.

Every implementation issue must include:

- immutable base and head SHAs;
- owned files/seams and explicit exclusions;
- tests that demonstrate the changed boundary through its public facade;
- compatibility and rollback evidence where state or writes are involved;
- documentation for any public contract change;
- an independent exact-head review followed by a new review pass after material fixes;
- a statement that no publish/deploy/external mutation occurred unless separately authorized.

## Documentation spine

### S-01 — Land the Struct product contract and freeze the first-release API/release manifest

**Repository:** `erniesg/struct`

**Depends on:** ADR-0001 acceptance and issue-creation approval.

**Purpose:** Reconcile the reviewed Struct documentation head `444317b64b72dbce6c0c0409716fb6a20e810b4d` onto the then-current default, incorporating ADR-0001's normative Bundle decisions and first-release export surface. This is documentation and contract enforcement only.

**Owned seam:** `README`, `CONTRACT`, `MIGRATION`, package payload documentation, API/export manifest, architecture/source-boundary rules.

**Explicit exclusions:** Runtime Bundle implementation, package publication, Ernie.SG edits, consumer migration.

**Acceptance:**

- Product and technical ownership exactly match ADR-0001.
- `StructBundle` is still marked planned until implemented.
- Current, documented-target, implemented-but-unreleased, and released package states are separately labeled with evidence requirements.
- Canonical bytes, asset authority, resolver semantics, limits, receipt equality, verified return type, and independent version axes are normative and unambiguous.
- `npm pack --dry-run` includes required documentation and NOTICE without publishing.
- An API manifest names the intended stable root/subpath exports and classifies current aliases.
- Documentation diff and links are clean at the exact head.

**Review routing:** Architecture/package review; security review of Bundle prose.

### E-01 — Rebase the Ernie.SG product and research-architecture contract onto current default

**Repository:** `erniesg/erniesg`

**Depends on:** S-01 landed.

**Purpose:** Reconcile the reviewed Ernie.SG documentation head `a45128c13839b7d5093ef7ba5e30790903007ed8` onto the then-current default and make the application ownership and publication lifecycle consistent with the accepted Struct contract.

**Owned seam:** `PRODUCT.md`, README product boundary, research architecture, cross-repository spec/plan.

**Explicit exclusions:** Runtime package dependency, source moves, writer activation, deployment.

**Acceptance:**

- Ernie.SG owns acquisition, reconstruction, editorial approval, durable records, validation, and public delivery.
- The owner-first MVP is born-digital academic PDF/DOCX -> review/edit/approve -> `/research/:slug` plus deterministic XHTML/accessible EPUB; scans are explicitly unsupported/needs-manual-reconstruction rather than an OCR-quality promise, and journal management is a non-goal.
- Source-specific adapters are explicitly app-owned.
- Struct owns source-neutral semantic and deterministic renderer behavior.
- The lifecycle distinguishes private reconstruction, approved Struct revision, bundle export, validation evidence, approval, and public release.
- Current, documented-target, implemented-but-unreleased, and released/deployed behavior are separately labeled with evidence requirements.
- The known trailing blank line in the reviewed plan is repaired.
- Documentation checks pass at the exact head.

**Review routing:** Product/architecture review; no runtime security claim.

### E-WF — Register and reconcile Ernie.SG's generated publisher workflow

**Repository:** `erniesg/erniesg`

**Depends on:** E-01. It must land before E-02 or any publication-state activation work.

**Purpose:** Give the 5,050-line authority-bearing generated workflow an Ernie.SG-owned, reproducible source and drift gate instead of relying on a comment that says only “Generated by rucksack.”

**Owned seam:** `.github/workflows/agent-evidence-publisher.yml`, an Ernie.SG authority registry/manifest, exact generator revision/source digest, reproducibility or frozen-legacy classification, fail-closed drift test, explicit size exception.

**Explicit exclusions:** Blind regeneration from current Rucksack, workflow activation, permission widening, deployment, product publication behavior.

**Acceptance:**

- The current workflow byte digest, behavior/permissions, and provenance are inventoried at the immutable base.
- The exact current Rucksack generator output is compared; its known byte mismatch cannot be silently accepted.
- Either the workflow is reproducibly generated from a pinned reviewed generator/source digest, or it is classified as a frozen legacy generated artifact with its exact bytes and a separately reviewed migration to a pinned generator.
- A fail-closed test detects drift between the registered source/generator and checked-in workflow.
- Any behavior, permission, trigger, secret, or publisher-boundary difference receives exact-head security review; no workflow run or external mutation is authorized.
- Owner, review class, generator/source identity, drift evidence, and explicit gate-scoped size exception are durable in Ernie.SG.

**Review routing:** Generated-authority, workflow-security, and reproducibility review.

### A-01 — Manually reconcile Aether's current, target, and released-state product contract

**Repository:** `erniesg/aether`

**Depends on:** S-01 and E-01 landed.

**Purpose:** Apply one manual documentation reconciliation commit to then-current Aether default. Preserve current commands, routes, component map, deployment instructions, and UI guidance while adding the accepted optional downstream boundary.

**Owned seam:** `AGENTS.md`, `CLAUDE.md`, `README.md`, architecture and PRD documentation.

**Explicit exclusions:** Cherry-picking the divergent product-contract branch, runtime Struct dependency, route changes, prototype schema migration, deployment.

**Acceptance:**

- The commit is manually reconstructed from reviewed intent; none of the three historical documentation commits is wholesale cherry-picked.
- Current prototype behavior, implemented-but-unreleased capability, configured deployment, actually released/deployed health, and target import/composition/release behavior are separately labeled with evidence requirements.
- Struct verification details have one canonical source and are summarized without drift.
- Aether remains optional and downstream; canonical text mutation is forbidden.
- The owner remains the first required user, and the selected proof remains one image-led A5, 24-page, saddle-stitched booklet, one printer-accepted PDF, and three linked social cutdowns. Only the real printer/profile/renderer decision remains open.
- Existing `asset`, `exportPack`, PNG-ZIP manifest, and workspace state are not mislabeled as target types.
- Diff and documentation checks pass at then-current exact default.

**Review routing:** Architecture reconciliation review against both current Aether source and accepted upstream docs.

## Struct runtime spine

### S-02 — Correct Struct dependency direction and harden the public boundary

**Repository:** `erniesg/struct`

**Depends on:** S-01 and A-01 landed. A-01 transitively proves the complete Struct -> Ernie.SG -> Aether phase-0 documentation sequence.

**Purpose:** Make the package organization express semantic-versus-renderer ownership before Bundle implementation.

**Owned seam:** Move emitted-ID planning to XHTML; remove renderer imports from semantic invariants; relocate bounded renderer ingress; separate source-neutral recovery facts from application copy; collapse redundant internal re-export layers; add import-graph/API checks.

**Explicit exclusions:** Bundle runtime; new application behavior; package publish; broad one-function-file split.

**Acceptance:**

- `document/**` imports no renderer.
- Semantically valid documents decode without XHTML emitted-ID policy; XHTML still rejects emitted-ID collisions at its own boundary.
- Struct emits no PDF/importer/preview/local-device/publishing-workflow copy.
- One semantic receipt/digest implementation and one renderer-ingress normalization path are authoritative.
- Explicit export/API manifest and import rules pass.
- The current decode-only `migrateStructDocument` behavior is not promised as a stable migration transform: either implement a real version transform with migration receipt or adopt honest decode-compatibility naming and a dated prerelease alias.
- Existing codec/ID/recovery/XHTML/EPUB goldens are unchanged except an intentionally reviewed error-ownership change.
- Source-boundary and package tests pass.

**Review routing:** Bounded package architecture review; fresh consumer-surface review after fixes.

### S-03 — Implement the normative fail-closed StructBundle contract

**Repository:** `erniesg/struct`

**Depends on:** S-02.

**Purpose:** Add the first actual portable interchange boundary described in ADR-0001.

**Owned seam:** `StructBundleJson`, exact byte-free bundle-document projection, opaque privately backed verified handle, canonical document/full-envelope encoding and digests, create/bytes-decode/value-verify/encode facade, content-addressed assets, versioned isolated resolver-executor policy/protocol and conformance harness, versioned limit profile, structured errors, receipt binding, version checks.

**Explicit exclusions:** Network/filesystem resolver implementation, application export records, package publish, Ernie.SG/Aether source changes.

**Acceptance:**

- Runtime, existing `StructDocumentJson`, exact `StructBundleDocumentJson`, and envelope JSON types are distinct; serialized bundle documents structurally exclude asset `bytes` and reject forbidden/unknown keys rather than stripping them.
- Struct `0.2.0` keeps `byteLength` envelope-only and verifies it against decoded/resolved bytes; adding document-level length requires a later schema version and migration.
- RFC 8785 UTF-8 document bytes and lowercase SHA-256 are covered by cross-runtime `0.1`/`0.2` and N-1/N/N+1 fixed vectors with no implicit migration.
- Full-envelope canonical bytes define asset ordering, strict JSON/base64, noncanonical raw-input rejection, `bundleSha256`, and byte-preserving encode/decode round trips with cross-runtime vectors.
- Existing document `href` remains a logical EPUB-relative path. External payload uses only `resourceId = "sha256:" + asset.sha256`; tests keep logical path and content address distinct, reject mismatch, and reject URLs, paths, storage keys, credentials, and attempts to relax `0.2.0` href rules.
- Envelope assets are the only byte carriers and match the document asset set exactly.
- External assets require the versioned isolated streaming resolver executor. Side-effect-free allocation returns supervisor control with idempotent cleanup before the sole authority-granting `start()` call; startup is budgeted, revocable, and cleanable even when it throws, rejects, or never settles. Required logical href/content address, request/result/profile versions, transport-kind-discriminated non-secret receipts, trusted endpoint/root/store equality, synchronous authority revocation, pre-start supervisor cleanup, optional iterator return only after a result exists, out-of-realm termination/join on every outcome, package-monotonic total/cleanup budgets, abort -> revoke -> conditional iterator return -> control cleanup -> terminate ordering, length caps, and residual work are normative and covered by the conformance harness.
- Struct computes `policySha256` from the strict policy projection using the ADR's domain-separated RFC 8785 UTF-8 contract and exact ASCII identifier grammar before allocation; the request carries it, every transport receipt echoes it, and cross-runtime fixed vectors cover every policy kind and boundary value.
- An optional expected `bundleSha256` is checked against size-capped raw envelope bytes before parsing or resolver execution; mismatch tests prove zero executor starts.
- Resolver-capable untrusted ingress exists only on the bytes decoder. The value verifier accepts embedded-byte in-memory values only, exposes neither expected-raw-digest nor executor options, and makes no raw-wire/canonical-input claim; consumer tests forbid Ernie.SG/Aether wire ingress through it.
- Every public acceptance API returns a genuine opaque package-created handle or a structured failure. Private canonical/document/asset storage is inaccessible; snapshots are deep-frozen copies, bytes are copy-on-read, and the encoder rejects forged handles.
- Mutation/aliasing tests change every input and returned nested object, array, map-like view, and byte index after verification; verified encoding/digests/content remain unchanged or access fails closed.
- Wrong media/bundle/schema versions, digest, receipt, base64, asset set, metadata, bytes, resource ID, transport-kind policy/receipt equality, execution/revocation/cleanup/terminal receipt, and resource limits fail closed. Synchronous startup throw, rejected startup, never-settling startup, and clean successful completion all prove pre-start control cleanup, revocation, and terminal join behavior; never-settling cleanup/join is exercised in a sacrificial verification host whose parent proves bounded fail-stop, zero capacity reuse, and aggregate-pressure admission limits.
- Independently valid but unequal envelope/document receipts are rejected.
- Documentation and tests state that Struct verification proves integrity/conservation, not producer authenticity; no Struct digest or receipt is treated as a signature.
- Fuzz/adversarial pilots cover hostile objects, nesting, cycles, lone surrogates, unsafe integers, raw-input/allocation pressure, duplicate keys, and limit boundaries before any broader corpus run.

**Review routing:** Sol/high-assurance security and canonicalization review at immutable head; fresh review after every material contract fix.

### S-04 — Prove the Struct package through a clean packed consumer and frozen goldens

**Repository:** `erniesg/struct`

**Depends on:** S-03.

**Purpose:** Demonstrate that the package, declarations, export map, and deterministic behavior work outside the source tree. Produce a release decision packet, not a publication.

**Owned seam:** Build/pack checks, clean consumer fixture, public-subpath tests, cross-runtime and renderer goldens, compatibility matrix, tarball evidence.

**Explicit exclusions:** `npm publish`, Ernie.SG cutover, deletion of current app copies.

**Acceptance:**

- A clean temporary consumer installs the exact tarball and has no repository source-path access.
- Every documented root/subpath import and declaration resolves; every private path fails.
- Tarball contents and digest are recorded; package payload includes required legal/contract files and excludes source-private/test debris.
- Legacy/current/unsupported document matrix passes.
- Bundle negative matrix passes through public exports.
- Three-run XHTML and normalized EPUB goldens are byte/content-hash identical.
- Release decision packet records exact SHA, tarball digest, export/API manifest, checks, known compatibility limits, and rollback constraints.

**Review routing:** Independent package-consumer review. A separate explicit decision is required before any prerelease publication.

## Ernie.SG migration spine

### E-02 — Establish the app-owned Struct adapter and frozen cross-repository parity corpus

**Repository:** `erniesg/erniesg`

**Depends on:** E-01, E-WF, and S-04. If no registry publication is authorized, use the exact reviewed tarball through a reproducible local artifact mechanism.

**Purpose:** Create the one-way application seam before replacing local implementation files.

**Owned seam:** App facade for reconstruction-to-Struct, source-specific fixtures, versioned source-neutral expected artifacts consumed from Struct, exact dependency/artifact pin, dual-read harness.

**Explicit exclusions:** Local portable source deletion, writer activation, public route activation, moving source adapters into Struct.

**Acceptance:**

- The adapter imports app-private reconstruction types and public package APIs; no reverse import exists.
- Exact package/artifact identity is recorded and reproducible.
- PDF/DOCX/source fixtures prove conservation through adapter -> package decode -> bundle verification.
- Ernie.SG wire ingress uses only the Struct bytes decoder. Any external-asset executor maps the non-secret content address through trusted endpoint/root configuration and passes the Struct conformance harness plus endpoint/path aliases, secret URL/path/matrix/percent-encoding non-retention, redirect, DNS/private-target, traversal/symlink, monotonic-budget/cancellation, deceptive-length, concurrency, synchronous revocation, out-of-realm hard termination, cleanup, and residual-work tests.
- Frozen parity covers canonical JSON, semantic/document digests, receipts, IDs, ordering, recovery facts, XHTML, EPUB entries/content hashes, and validation failures.
- Legacy `0.1.0` and current `0.2.0` reads remain available.
- No production writer changes yet.

**Review routing:** Cross-repository adapter and evidence review.

### E-03 — Cut Ernie.SG core/codecs/IDs/ordering/recovery over to the exact Struct package

**Repository:** `erniesg/erniesg`

**Depends on:** E-02.

**Purpose:** Remove local runtime authority from the semantic core in dependency order while retaining compatibility files until contraction.

**Owned seam:** Production imports for portable types, codecs, identities, ordering, structured recovery; app recovery presentation copy; package/local parity checks.

**Explicit exclusions:** XHTML/EPUB cutover, `ResearchPaper` bridge removal, duplicate-file deletion, writer activation.

**Acceptance:**

- Production call paths use only public package exports for the migrated families.
- App-specific recovery/UI strings remain in Ernie.SG.
- Legacy/current reads and source-fixture conservation pass.
- Static rules prevent new production imports to the superseded local families.
- Local copies are clearly marked compatibility-only and remain unchanged except necessary forwarding until E-07.
- High-fan-in affected consumers are enumerated and tested.

**Review routing:** Bounded integration review with import-graph evidence.

### E-04 — Cut XHTML/EPUB over to Struct and converge publication semantics

**Repository:** `erniesg/erniesg`

**Depends on:** E-03.

**Purpose:** Make deterministic reflowable output package-owned while preventing `PublicationGraph` or `ResearchPaper` from remaining a competing canonical writer.

**Owned seam:** Struct renderer imports, browser worker/export paths, app publication adapters, `research/epub.ts` compatibility routing, publication projection decision.

**Explicit exclusions:** Immediate `ResearchPaper` compatibility removal, public writer activation, app acceptance evidence removal.

**Acceptance:**

- New StructDocument render paths use the exact package renderer.
- Frozen XHTML and EPUB output/failure parity pass.
- `ResearchPaper` legacy callers remain inventoried and tested behind a read-only compatibility facade.
- `PublicationGraph` is retired or narrowed to an ephemeral, mechanically derived renderer plan from one pinned approved Struct revision. It owns no independent text, semantic IDs, persistence, receipt, writer, or release path; a renamed full schema is not accepted.
- EPUBCheck/Ace/human-accessibility responsibilities remain app-owned.
- No duplicated renderer receives new production changes.

**Review routing:** Renderer/integration review plus publication-boundary architecture review.

### E-05 — Design and implement durable editorial publication behind an inactive gate

**Repository:** `erniesg/erniesg`

**Depends on:** E-04.

**Purpose:** Settle the durable record/state-transition contract and implement it without changing the production writer or public route.

**Owned seam:** A repository-local design record; revision/decision/candidate/validation/approval/release schemas; authenticated producer export/release record or detached-signature contract; authenticated state transitions; inactive writer/route adapter; migration/backfill, concurrency, trust-key rotation/revocation, and rollback/forward-recovery rehearsal.

**Explicit exclusions:** Production writer switch, public-route activation, Aether composition, package publication, deletion of compatibility sources, Rucksack domain logic.

**Acceptance:**

- The design record defines storage choice, immutable IDs, state machine, authenticated actors, target binding, idempotency/CAS, migrations, backfill, failure recovery, retention, and exact record/receipt schemas.
- Only an approved immutable revision can produce the release candidate.
- Decisions bind exact revision/content hashes; stale decisions cannot authorize a changed candidate.
- Bundle verification, EPUBCheck, Ace, required human review, authenticated approval, and target policy are mandatory before release.
- Release record binds exact package, schema, bundle, document, renderer/profile, validation, approval, target, and artifact digests.
- Producer record binds a versioned record type, authenticated producer/key or session identity, approved revision, canonical `bundleSha256`, `documentSha256`, package/schema/artifact versions, audience/target, event ID, issue time, and status/supersession policy. The consumer trust/rotation/revocation contract uses authenticated monotonic policy epochs, validity/freshness bounds, revocation effective times, and either linearizable compare-and-advance rollback-detecting state or a current authenticated online authority before resolver access. Stale/offline status fails closed; compromised-key records need a pre-revocation trusted timestamp/log inclusion proof or that key is revoked for its entire lifetime.
- The inactive public-route adapter cannot expose an unapproved or superseded artifact when exercised in an isolated environment.
- Expanded readers, migrations/backfill, and simulated current-only writes are proven on durable fixtures while the production writer remains unchanged.
- Rollback or forward recovery is rehearsed on representative pre/post-switch records; unsafe package downgrade is rejected.
- Mutation and concurrency tests cover retries, duplicate submissions, stale approvals, CAS conflict, partial failure, and read-after-write evidence.
- A fully rehashed self-consistent forged bundle passes Struct integrity verification but fails producer-record authentication; swapped, stale, superseded, replayed, wrong-audience/target, revoked-key, digest-mismatched, policy-rollback, expired-policy, unavailable-beyond-freshness, and improperly backdated-after-compromise records fail closed.
- Exact evidence states that production writer/public route are still inactive.

**Review routing:** Sol/high-assurance security, concurrency, recovery, and publisher-boundary review at exact head.

### E-ACT — Record the target-specific writer/public-route activation decision

**Type:** Coordinator-owned decision gate, not a GitHub implementation issue.

**Depends on:** E-05 exact-head implementation and independent review; separately authorized package artifact/version; target-specific user approval.

**Decision packet:** Exact repository head, Struct package/artifact/schema pins, target environment/route/store, authorized actor, migration and backfill output, validation evidence, concurrency/recovery results, rollout cohort, observation window and thresholds, rollback or forward-recovery constraints, expiry, and abort conditions.

**Acceptance:** The user explicitly authorizes the named writer/public-route activation at the named immutable inputs. A stale head, artifact, target, expired window, failed threshold, or unsafe downgrade invalidates the decision. E-06 cannot create or self-satisfy this gate.

### E-06 — Activate one governed writer/public route and rehearse recovery

**Repository:** `erniesg/erniesg`

**Depends on:** Accepted E-ACT decision whose immutable inputs still match.

**Purpose:** Switch only the authorized current-schema writer and governed route using the already reviewed inactive implementation.

**Owned seam:** Target-scoped activation configuration/migration, writer switch, authenticated producer-record issuance, route binding, observation evidence, rollback or forward-recovery execution.

**Explicit exclusions:** New schema/design, Aether, package publication, duplicate deletion, broader deployment targets.

**Acceptance:**

- Action-time checks match every E-ACT immutable input and authority.
- New approved revisions use one current schema; original reconstruction data and prior revisions remain immutable.
- Public route exposes only a governed release record and exact artifact.
- Stale decisions, unsafe downgrade, failed migration, failed validation, and threshold breach abort or execute the recorded recovery without a second writer.
- Records created before and after activation pass read/rollback-or-forward-recovery rehearsal.
- Exact target health, observation, writer singularity, and read-after-write evidence are retained.

**Review routing:** Sol/high-assurance action-time publisher, recovery, and concurrency review at the activated exact head.

### E-07 — Remove duplicate portable Struct sources and generic tests from Ernie.SG

**Repository:** `erniesg/erniesg`

**Depends on:** E-06 and all family-specific parity/deletion gates.

**Purpose:** Contract the compatibility layer only after the package and application lifecycle are proven.

**Owned seam:** Portable local Struct modules, duplicate generic tests/fixtures, obsolete barrels/forwarders; separate call-site migration for any remaining legacy renderer overload.

**Explicit exclusions:** Source-specific reconstruction adapter, model-consultation app extension, PDF/DOCX fixtures, active `ResearchPaper` compatibility without proof.

**Acceptance:**

- Extraction-point hashes and path mappings preserve provenance.
- Every deleted generic test maps to a package test; app-specific integration assertions remain.
- Zero production imports resolve to removed portable modules.
- App tests run against the exact built/packed package, not a source fallback.
- Source conservation, package parity, durable publication, and rollback suites remain green.
- Any retained compatibility file has an owner, caller inventory, warning/horizon, and removal issue.

**Review routing:** Deletion/provenance review and fresh exact-head integration review.

## Optional Aether runtime spine

### A-REQ — Authorize a target-scoped printer-requirements inquiry when evidence is unavailable

**Type:** Coordinator-owned external-action gate, not a GitHub implementation issue.

**Depends on:** A-01 exact-head product contract and explicit user authorization. The gate is unnecessary when complete requirements are user-supplied or gathered from public material without contact.

**Decision packet:** Named printer/contact and channel, exact questions, disclosed project/files/metadata, communication authority, cost if any, expiry, and evidence-retention location. It authorizes requirements discovery only—not artifact submission, proof approval, ordering, purchase, or deployment.

**Acceptance:** Only the named inquiry may be sent. The resulting versioned PDF/X, ICC, font, bleed, resolution, imposition, binding, and acceptance requirements are retained with source/date evidence. Changed contact, disclosure, cost, or purpose invalidates the gate. A-REQ cannot authorize A-02 implementation or A-ACT actions.

### A-02 — Build an inactive authenticated Struct import and the selected local A5/social proof

**Repository:** `erniesg/aether`

**Depends on:** A-01, S-04, E-06, exact package/artifact availability, and completed versioned real-printer requirements obtained from user-supplied/public no-contact evidence or a completed A-REQ inquiry.

**Purpose:** Introduce the already selected owner-first proof—one image-led A5, 24-page, saddle-stitched booklet PDF and three linked social cutdowns—without importing Ernie.SG internals or broadening Struct. The issue produces a local proof candidate; printer submission/acceptance is outside this issue.

**Owned seam:** Isolated Struct bytes-only import and resolver executor, authenticated Ernie.SG producer-record verification, rollback-detecting/current-online trust-policy state, atomic content-addressed full-bundle and asset persistence, immutable import record/receipt, inactive actor/session/workspace authorization boundary, stable-ID reference layer, one `CreativeGraph` projection, one renderer/profile/preflight/release-manifest path behind an inactive route/feature gate.

**Explicit exclusions:** Route/feature activation, deployment, printer outreach/submission, generic print platform, multiple renderers, canonical text editing, source acquisition/reconstruction, silent migration of prototype types.

**Checkpoint 0 — renderer/profile contract proof:** Before any runtime edit, record one candidate renderer and versioned profile against every captured printer requirement, frozen representative pages/assets/fonts, expected PDF standard/color/bleed/imposition/binding properties, preflight commands, failure criteria, and rollback boundary. An independent renderer/print review must accept that exact proof. If no candidate satisfies it, A-02 remains blocked at checkpoint 0; the issue does not silently change printer, format, or MVP.

**Acceptance:**

- Only `struct-import/**` imports public Struct exports at one exact pin.
- The route/feature remains inactive by default; tests prove no current user or external caller can reach the new import/composition path.
- A size cap is enforced and the unparsed raw envelope is hashed before any resolver-capable decode. A current authenticated producer record/signature must bind that digest, approved revision, producer trust, audience/target, status/supersession, key status, and replay/idempotency. Linearizable compare-and-advance rollback detection or an authenticated current online authority settles policy epoch/revocation status before Struct's bytes-only decoder runs with the digest as expected `bundleSha256`.
- Fully rehashed forged, absent, stale, superseded, replayed, wrong-target/audience, revoked-key, mismatched, policy-rollback, expired-policy, unavailable-beyond-freshness, or improperly backdated-after-compromise producer evidence causes zero resolver-executor starts and fails Aether import. Pre-revocation records from a compromised key require trusted timestamp/log inclusion proof or fail.
- Authentication plus atomic/recoverable content-addressed persistence of canonical full-envelope bytes, every resolved asset byte, and the immutable import record complete before editable composition is reachable.
- Import record stores exact package/schema/bundle/document/receipt/asset hashes, canonical-bundle and asset object identities, producer-record identity/digest, and a separate Aether event receipt. Composition decodes/reads only that pinned import; re-resolution is recovery-only and repeats integrity+authenticity checks.
- The Aether executor maps only the digest-derived non-secret resource ID through trusted endpoint/root configuration. Side-effect-free allocation returns independently revocable supervisor control with idempotent cleanup before authority-granting startup; cleanup remains callable after synchronous throw, rejection, or never-settling startup, and clean success also terminates/joins with a receipt. It passes the Struct conformance harness plus domain-separated policy-digest vectors, endpoint/path aliases, secret URL/path/matrix/percent-encoding non-retention, redirect, DNS/private-target, traversal/symlink, monotonic-budget/cancellation, deceptive-length, concurrency, synchronous authority revocation, pre-start cleanup, conditional iterator return, out-of-realm hard termination/join, transport-kind receipt equality, terminal-receipt, sacrificial-host fail-stop, repeated-failure admission, and residual-work tests.
- The inactive actor/session/workspace contract authorizes import, read, edit, release, and asset access separately; unauthorized and cross-workspace reads, writes, imports, ID enumeration, and direct Convex/API mutations fail before domain or storage access.
- `CreativeGraph` references stable block/asset IDs and rejects missing or changed upstream references.
- Semantic corrections require a newly verified upstream revision.
- The local A5 PDF candidate and three linked social cutdowns share the approved master/lineage, and their release manifest binds authenticated import, graph, renderer/profile, supplied printer/preflight rules/results, approval, and artifact digests.
- Prototype asset/export/manifest data is explicitly migrated or remains separately named.
- Crash-between-bundle/assets/receipt, source mutation/deletion, duplicate/concurrent import, storage aliasing, rollback graph reads, and old/current import fixtures either reproduce exact canonical document/assets or fail closed.
- No deployment, route activation, external submission, or claim of printer acceptance occurs.

**Review routing:** Sol/high-assurance import, provenance, mutation, and release review; renderer-specific review only for the selected MVP.

### A-ACT — Record the target-specific Aether route/deployment/printer-submission decision

**Type:** Coordinator-owned decision gate, not a GitHub implementation issue.

**Depends on:** A-02 exact-head inactive proof and independent review; explicit user authorization for each named external action.

**Decision packet:** Exact repository head and artifacts, route/environment/audience, actor/session/workspace authorization policy and negative-test evidence, import pin, trust root, rollback-detecting/online status mode, minimum acceptable trust-policy epoch/witness and freshness, renderer/profile, health/rollback thresholds, and—only for printer submission—the named printer/contact, disclosed files/metadata, purpose, acceptance criteria, cost, and communication authority.

**Acceptance:** Only the actions and targets explicitly authorized in the current packet may occur. Activation proves unauthorized reads, writes, imports, and cross-workspace access still fail at the exact head. An expired/stale head, changed artifact/profile, trust-policy rollback/staleness, ambiguous audience, unapproved cost/outreach, or failed health threshold invalidates the gate. A-02 cannot create or self-satisfy it; user-supplied printer evidence may be recorded without external outreach.

## Rucksack safety and architecture spine

### R-01 — Add a fail-closed authority-path registry and machine-enforced import/public-API contract

**Repository:** `erniesg/rucksack`

**Depends on:** ADR-0001 acceptance, issue-creation approval, and deconfliction with active Rucksack lanes.

**Purpose:** Make authority and dependency changes visible before touching dangerous seams.

**Owned seam:** Central authority-bearing path registry, review classification, public API manifest, import graph rules, current-cycle inventory, compatibility facade inventory.

**Explicit exclusions:** Broad moves, behavior changes in mutation adapters, automatic reclassification as routine.

**Acceptance:**

- Every current authority-bearing file is registered with owner and risk class, including recently extracted autopilot self-heal/review-repair/VM/provisioning files.
- Generated authority artifacts are registered too. The 7,775-line Rucksack publisher workflow records owner, generator/source digest, reproducibility/drift check, review class, and explicit gate-scoped size exception. The Ernie.SG counterpart is owned by E-WF in its repository.
- A new or moved authority-bearing file fails closed until explicitly classified.
- Only `rucksack.api.*` and CLI are declared stable; compatibility surfaces are enumerated.
- One canonical import extractor and its handling of static, late, and dynamic imports are checked in. The exact largest-SCC member/edge set is recorded, resolving the prior 51-versus-71 extractor discrepancy; new SCCs and domain-to-adapter/delivery edges fail.
- R-08 through R-11 must each name removed edges, record exact before/after member sets, and strictly reduce the canonical largest-SCC size; R-11 must finish at size <= 1.
- Current failures are recorded without weakening the rule for new work.

**Review routing:** Security/policy review of classification; architecture review of import/API enforcement.

### R-02 — Bind scaffold rollback and repository provisioning to explicit authority

**Repository:** `erniesg/rucksack`

**Depends on:** R-01.

**Purpose:** Close the filesystem confused-deputy and direct-provisioning bypasses through narrow application ports.

**Owned seam:** Descriptor-rooted `FileTransactionPort`, explicit authorized repo/root binding, manifest validation, one `RepositoryProvisionerPort`, independent `ApprovalPort`, idempotency and read-after-write evidence.

**Explicit exclusions:** Generic module-tree move, self-approval, accepting manifest-selected roots, unrelated GitHub operations.

**Acceptance:**

- A manifest cannot redirect rollback outside or to a different repository than the explicit authorized target.
- Symlink, replacement, traversal, and time-of-check/time-of-use adversarial cases fail closed.
- All repository creation routes pass through one coordinator and target-scoped port.
- Approval actor and provisioning actor are independently authenticated where policy requires it.
- Cross-host retries are idempotent or return a conflict requiring reconciliation; read-after-write evidence binds the created repository.
- Legacy direct CLI bypass is removed or a tested non-mutating compatibility facade.

**Review routing:** Sol/high-assurance filesystem, provisioning, approval, and concurrency review.

### R-03 — Replace raw publisher credentials and caller-controlled identity with opaque capabilities

**Repository:** `erniesg/rucksack`

**Depends on:** R-01. May run in parallel with R-02 and R-04 if files and shared fixtures do not overlap.

**Purpose:** Prevent credentials and hosted identity from crossing ambient or self-asserted boundaries, while leaving durable capability consumption and replay reconciliation to R-06.

**Owned seam:** `CredentialBrokerPort`, opaque proposal/artifact- and target-scoped capability issuance and validation, publisher invocation, proxy/backend authentication context, representations/logs/receipts, process environment handling.

**Explicit exclusions:** Durable capability-consumption/outcome ledger and crash/replay reconciliation (R-06), new identity provider, broader hosted deployment, token rotation, provider outreach.

**Acceptance:**

- Raw token values are unavailable to domain/application objects and safe object representations.
- Publication does not mutate a process-global credential environment.
- Capability binds immutable proposal/artifact digest, exact resource version or OID, policy and approval-record digests, authenticated actor/worker, target, operation, nonce/idempotency key, expiry, generation, and adapter invocation.
- Publisher invocation refuses a capability whose proposal/artifact, policy/approval/OID, actor/worker, target/operation, expiry, or generation binding differs. R-03 does not claim durable single-use or concurrent replay safety until the R-06 ledger lands; the publisher adapter remains classified as not broadly reorganizable or activation-ready in that interval.
- Proxy/backend identity is authenticated and not accepted from a caller-controlled legacy header.
- Least-privilege process separation is documented and tested where hosted components share a machine.
- Logs, exceptions, receipts, and tests demonstrate secret non-disclosure.

**Review routing:** Sol/high-assurance authentication, credentials, and publisher-boundary review.

### R-04 — Bind VM lease generations and supervise complete process trees

**Repository:** `erniesg/rucksack`

**Depends on:** R-01. May run in parallel with R-02/R-03 only with non-overlapping ownership.

**Purpose:** Ensure work cannot outlive or renew stale authority.

**Owned seam:** VM dispatch/lease generation and commit-OID binding, stale-comment handling, process groups/jobs/subreaping, success/failure/timeout/cancel cleanup.

**Explicit exclusions:** Provider migration, VM product redesign, unrelated worker refactor.

**Acceptance:**

- Dispatch and renewal bind repository, ref, current commit OID, lease generation, and authenticated worker identity.
- Stale comments, prior OIDs, and prior generations cannot renew or dispatch current work.
- Successful commands as well as failures/timeouts/cancellations leave no unauthorized descendants.
- Platform-specific process-tree semantics are tested for Linux and Darwin behavior supported by the project.
- Cleanup receipt proves the supervised tree's terminal state without trusting child output.

**Review routing:** Sol/high-assurance concurrency, lease, and process-supervision review.

### R-05 — Constrain VM sandbox credentials, host mounts, and network egress

**Repository:** `erniesg/rucksack`

**Depends on:** R-03 and R-04 integrated. R-05 owns the combined sandbox seam after their narrower credential and process contracts settle.

**Purpose:** Prevent untrusted repository/issue-driven agent work and descendants from receiving exportable provider credentials, unrelated host-readable data, or unrestricted egress before VM/autopilot reorganization.

**Owned seam:** Linux/Darwin sandbox credential provisioning, provider-call broker, readable/bind-mounted host paths, child environment/inheritance, network-egress policy and audit, synthetic secret/file canaries.

**Explicit exclusions:** New provider, credential rotation, broad VM redesign, weakening authorized provider functionality without an explicit compatibility decision.

**Acceptance:**

- Raw provider credential files/values are not copied into the worker home or inherited by untrusted descendants where a brokered non-exportable capability is required.
- Readable host mounts are task-scoped and exclude unrelated host roots/data; Linux and Darwin policies have equivalent declared guarantees.
- Network egress is deny-by-default or explicit-destination allowlisted with DNS/private-address rechecks and auditable exceptions.
- Synthetic canaries launched by the worker and its descendants cannot read provider credentials/unrelated host files or exfiltrate them; authorized provider calls through the broker still succeed.
- Success, failure, cancellation, and timeout revoke broker/network/mount authority and leave no residual process or capability.

**Review routing:** Sol/high-assurance sandbox, credential, host-data, egress, and child-inheritance review.

### R-06 — Revalidate and single-use every mutation capability at adapter invocation

**Repository:** `erniesg/rucksack`

**Depends on:** R-02, R-03, R-04, R-05, and R-07 integrated. It is the final cross-writer safety integration before architecture cycle cuts.

**Purpose:** Close the general trusted-input gap for every mutation family, not only scaffold/provisioning.

**Owned seam:** Inventory from mutation leases/policy, immutable proposal schema, trusted-configuration rebinding, action/provider/base/credential/resource validation immediately before each adapter call, stale-plan refusal, mutation-ledger state machine and reconciliation over the R-07 `MutationLedgerStorePort` for every mutation family including publisher invocation.

**Explicit exclusions:** Redesign or alternate implementation of the R-07 ledger-store/transaction contract, module moves, new mutation families, weakening policy to preserve legacy issue markers.

**Acceptance:**

- Exhaustive writer inventory includes every GitHub/provider/filesystem/store/heartbeat mutation, including families absent from the current six-operation mutation-lease advisory list.
- Every mutation family has one immutable proposal, named trusted configuration source, and explicit idempotency class.
- Provider markers, action tags, target/base refs, resource versions/OIDs, credentials, approvals, policies, and capabilities are rebound immediately before the adapter call.
- Changing any untrusted field or trusted input between planning and invocation refuses without mutation.
- Same-target replay with a different artifact/proposal fails.
- A durable atomic capability-consumption/outcome ledger binds nonce/idempotency key to the complete capability and uses CAS transitions `reserved -> invoking -> succeeded | failed | indeterminate`; `invoking` is durably committed before the external adapter call, and `failed` is terminal only when trusted evidence proves no mutation occurred.
- An orphaned `invoking` CAS-transitions to `indeterminate`. Authoritative positive read-after-write evidence may transition it to `succeeded`; transition to `failed` additionally requires provider-issued final negative idempotency/transaction status or equivalent proof that the original invocation is terminal/quiesced and had no effect. A negative read alone never settles failure; no automatic replay occurs while invoking or indeterminate.
- Provider idempotency keys are passed where supported. Concurrent identical replay performs at most one adapter mutation and returns the same authenticated settled result. Restored-snapshot, forked-history, crash-at-every-transition, ambiguous-response, delayed-commit-after-negative-read, cross-host, and reconciliation-race tests prove the R-07 store/witness prevents reuse of a consumed capability.
- Publisher capabilities issued under R-03 use this same ledger; no separate publisher replay store or duplicate consumption authority exists.
- Inventory proves no writer bypasses the revalidation boundary.

**Review routing:** Sol/high-assurance mutation-authority and time-of-check/time-of-use review.

### R-07 — Make every filesystem receipt and store descriptor-rooted and race-safe

**Repository:** `erniesg/rucksack`

**Depends on:** R-02 integrated. R-07 consumes, and may extend through separate interfaces, the reviewed descriptor-rooted `FileTransactionPort`; it does not redesign that contract.

**Purpose:** Close the general filesystem receipt/store gate beyond scaffold rollback and establish the hardened linearizable storage substrate that R-06 will use for mutation-ledger state.

**Owned seam:** Complete non-scaffold store/receipt inventory; validated root handles; descriptor-relative opens using the R-02 transaction contract where applicable; symlink/replacement/traversal defenses; revalidation, atomic write/rename, permissions, and read-before-use integrity; one `MutationLedgerStorePort` with linearizable CAS and rollback/fork detection or monotonic external witness.

**Explicit exclusions:** R-06 ledger state schema/reconciliation policy, R-02-owned scaffold rollback/recovery/apply/journal paths and `FileTransactionPort` redesign, repository-provisioning semantics, broad module moves, unrelated remote object stores.

**Acceptance:**

- Every R-07-owned filesystem-backed receipt/store has a named validated root and target binding; the combined R-02/R-07 inventory accounts for every filesystem authority store exactly once.
- Traversal, symlink, root replacement, rename race, hard-link where relevant, permissions, partial write, and stale receipt cases fail closed.
- Reads verify integrity/provenance immediately before authority-bearing use.
- Crash recovery leaves either the prior valid object or the new complete authenticated object, never a trusted partial.
- `MutationLedgerStorePort` proves linearizable CAS across its authorized host scope and detects valid-snapshot rollback and forked history through a non-restorable monotonic witness or an equivalent reviewed transactional backend. Replacement, symlink, crash, stale-CAS, restored-snapshot, and split-brain tests fail closed.
- Combined R-02/R-07 inventory proves no filesystem authority store remains on raw pathname trust.

**Review routing:** Sol/high-assurance filesystem/recovery review.

### R-08 — Cut the autopilot/VM/notification cycle behind explicit ports and shrink the canonical SCC

**Repository:** `erniesg/rucksack`

**Depends on:** R-02 through R-07 integrated and exact-head safety acceptance.

**Purpose:** Remove the first named high-risk cycle after its VM, credential, proposal, and store authorities are contained.

**Owned seam:** Autopilot application facade, VM dispatch and notification ports, composition root, compatibility aliases for `autopilot`, `vm_access`, and notification credential access.

**Explicit exclusions:** Merge/PR/GitHub cycles, scaffold/setup, product server, unrelated autopilot redesign.

**Acceptance:**

- R-01's canonical graph records the exact pre-cut largest-SCC member/edge set. This issue names every edge it removes and checks in the exact post-cut set.
- Named autopilot <-> VM and autopilot <-> notification edges are removed; the canonical largest-SCC size strictly decreases and no new SCC appears.
- Application depends on ports; adapters do not reenter autopilot for policy or credentials.
- Composition alone chooses concrete VM/notification adapters.
- Compatibility aliases are thin, explicit, warning-bearing, and tested.
- VM/process/credential/proposal/store safety tests remain green.

**Review routing:** Fresh architecture review plus affected safety-boundary review.

### R-09 — Cut merge/PR and GitHub/provenance cycles and shrink the canonical SCC

**Repository:** `erniesg/rucksack`

**Depends on:** R-08.

**Purpose:** Separate pure merge/PR policy and provenance from GitHub mutation adapters.

**Owned seam:** `merge_policy`/`pr_policy` dependency cut, GitHub/provenance port, application coordinator, compatibility facades, relevant tests.

**Explicit exclusions:** Scaffold/setup, product server, new merge behavior, cross-repository domain APIs.

**Acceptance:**

- `merge_policy` and `pr_policy` no longer import each other at runtime.
- GitHub access and issue provenance do not form a cycle; pure policy accepts immutable inputs and returns proposals/decisions.
- Only the target-scoped adapter publishes after capability/policy/approval/OID revalidation.
- The exact named removed edges and post-cut canonical member set are recorded; largest-SCC size strictly decreases and no new SCC appears.

**Review routing:** Architecture plus merge/publisher authority review.

### R-10 — Invert scaffold/setup dependencies, shrink the canonical SCC, and preserve compatibility

**Repository:** `erniesg/rucksack`

**Depends on:** R-09.

**Purpose:** Move scaffold/setup orchestration behind domain defaults and ports without reintroducing merge/PR or provisioning authority.

**Owned seam:** Scaffold/setup application facade, default-policy inputs, provisioning/file ports already established by R-02/R-07, compatibility aliases and tests.

**Explicit exclusions:** Product server, target domain integration, deletion of supported CLI compatibility.

**Acceptance:**

- Scaffold domain/default logic imports no merge/PR/GitHub/filesystem adapter.
- Setup uses explicit immutable inputs and existing target-scoped ports.
- History-preserving moves retain CLI behavior and provenance.
- The exact named removed edges and post-cut canonical member set are recorded; largest-SCC size strictly decreases and no new SCC appears.
- R-02/R-06/R-07 adversarial cases remain green.

**Review routing:** Bounded architecture and filesystem/provisioning regression review.

### R-11 — Split product-server delivery and finalize explicit public facades with no nontrivial SCC

**Repository:** `erniesg/rucksack`

**Depends on:** R-10.

**Purpose:** Make delivery/composition the last outward layer and close remaining cycles/public-surface ambiguity.

**Owned seam:** Product-server HTTP/auth/composition separation, `rucksack.api` implementation, remaining delivery edges, dynamic facade removal, final compatibility manifest and import graph.

**Explicit exclusions:** Struct/Ernie.SG/Aether semantic imports, new hosted product behavior, deployment, arbitrary file fragmentation.

**Acceptance:**

- Product server is delivery/composition only; policy/domain does not import HTTP/auth/GitHub/OCI/workspace implementations.
- Only `rucksack.api.*` and CLI are stable; dynamic global/`__module__` facade mutation is absent from the public contract.
- Every compatibility alias is thin, enumerated, warning-bearing, and has a removal version/horizon.
- The exact named removed edges and final canonical member sets are recorded; final import graph has no SCC larger than one and domain has zero adapter/delivery edges.
- CLI and supported compatibility suites plus all R-02..R-07 security suites pass at the exact head.
- Rucksack has no Struct/Ernie.SG/Aether domain dependency; future invocation remains deferred until target-owned stable capabilities exist.

**Review routing:** Fresh exact-head architecture integration and security review.

## Shared-seam reservations

The coordinator must serialize these seams even when issues otherwise appear independent:

| Shared seam | Owning issue/order |
|---|---|
| Struct export map/API manifest | S-01 -> S-02 -> S-03 -> S-04 |
| Struct canonical JSON/digest/receipt | S-02 -> S-03 only |
| Struct package manifest and lockfile | One Struct issue at a time |
| Ernie.SG Struct dependency/lockfile | E-02, then later issues consume it |
| Ernie.SG generated publisher workflow/registry | E-WF only; later issues consume its exact evidence |
| Ernie.SG local Struct compatibility barrels | E-03 -> E-04 -> E-07 |
| Ernie.SG publication record schema | E-05 only; E-06 may activate but not redesign it |
| Aether product docs | A-01 only |
| Aether import/release schemas and lockfile | A-02 only |
| Rucksack authority registry/import rules | R-01, then coordinator-owned updates from R-02..R-11 |
| Rucksack descriptor-rooted transaction/store/ledger contract | R-02 establishes `FileTransactionPort` and scaffold paths -> R-07 hardens remaining stores and establishes `MutationLedgerStorePort` -> R-06 consumes it without redesign; no parallel edits |
| Rucksack global fixtures/CI/config | One named R issue at a time |
| GitHub issues, PRs, merges, package registry, deployment | Coordinator only; serialized by external target |

## Cross-issue acceptance dashboard

The coordinator should track evidence, not percentages:

| Gate | Evidence required | Unlocks |
|---|---|---|
| Issue creation completed | Reviewed exact ADR/map + user `go` + coordinator-created identities for all 25 issues | Planning backlog only; no implementation or downstream action authority |
| Struct docs current | Landed S-01 exact SHA | E-01 |
| Ernie.SG docs current | Landed E-01 exact SHA | E-WF and A-01 |
| Phase-0 documentation complete | Landed A-01 exact SHA after S-01 and E-01 | S-02 and the Struct/Ernie.SG/Aether runtime spines |
| Ernie generated workflow governed | E-WF pinned source/generator or frozen-legacy manifest + drift test | E-02 and publication-state work |
| Struct boundary clean | Import graph + unchanged goldens | S-03 |
| Bundle verified | Negative/mutation matrix + cross-runtime vectors + resolver conformance | S-04 |
| Packed package proven | Clean consumer + tarball digest | E-02; package publication remains deferred outside this tree |
| Ernie bridge proven | Source conservation + full parity | E-03 |
| Semantic core cut | Static imports + affected tests | E-04 |
| Renderer/publication semantics cut | Output parity + one canonical semantic model | E-05 |
| Durable publication designed/inactive | State-machine, authority, migration, concurrency, simulated recovery evidence | E-ACT decision packet |
| Writer/public route activation authorized | Exact E-ACT target, head, pins, authority, thresholds, recovery | E-06 |
| Durable publication active | Exact target health, singular writer, authority and recovery evidence | E-07, A-02 |
| Duplicate contraction proven | Zero imports + package-only tests | Program convergence |
| Rucksack safety gates closed | Exact-head security acceptance for R-02 through R-07 | R-08 cycle cuts |
| Aether requirements outreach authorized | Exact A-REQ printer/contact/questions/disclosure/cost/expiry packet | Only the named inquiry |
| Aether printer requirements complete | Versioned user/public or A-REQ-derived real-printer requirements | A-02 checkpoint 0 |
| Aether renderer/profile proof accepted | Independent review of exact renderer/profile contract against captured requirements and frozen fixtures | A-02 runtime work |
| Aether local proof inactive | Authenticated import, canonical bundle/assets, local artifacts, zero reachable route/submission | A-ACT decision packet |
| Aether external action authorized | Exact A-ACT head/artifacts, route/environment or printer/contact/disclosure/cost, thresholds, recovery | Only the named route/deployment/submission action |

## Deferred backlog, not issues in this tree

- Publishing any Struct prerelease or stable npm version.
- Deploying Ernie.SG, Aether, or hosted Rucksack services.
- Selecting a print renderer without a real printer/output requirement.
- General Aether workspace redesign.
- Broad Rucksack product work, stale PR revival, or Evidence Lab follow-ups unrelated to the accepted architecture.
- Moving Rucksack issues between repositories.
- New repository visibility, organization, IAM, or credential changes.
- Eliminating every legacy `ResearchPaper` use before the package and durable-publication seams are proven.

These require separate evidence and authority. They must not be smuggled into a dependency issue as “cleanup.”

## Final program completion evidence

The architecture program may be called complete only after:

- the exact final heads of every implemented repository are recorded;
- current default heads are independently fetched and match the reviewed commits;
- gate-scoped entry scans over the explicitly listed extensions remain zero-root for the three original repositories, while generated YAML authority artifacts retain their registered/reproducible exception evidence;
- architecture/import/API/security checks pass at final integrated heads;
- no duplicate semantic authority remains between Struct and Ernie.SG;
- any active Aether import has rollback-safe/current producer trust evidence, bytes-only decode evidence with zero pre-auth resolver-executor starts, and atomically pinned canonical full-bundle bytes, content-addressed asset bytes, and immutable metadata, or Aether remains explicitly inactive;
- Rucksack remains a generic non-domain automation layer;
- fresh independent final review reports no actionable in-scope defects;
- publications/deployments, if any, have their own recorded authorization and evidence.
