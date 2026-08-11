# Repair post-merge Payload Lexical review findings from PR #156

provider: vm-codex
depends-on: 030

## Goal

Repair the five unresolved exact-head Codex findings that arrived 92 seconds
after PR #156 merged. The Payload adapter, semantic conformance comparison, and
publication build must redact unsafe relationship targets, canonicalize
equivalent inline-run sets independently of array order, resolve object upload
references through the upload index, fail before rendering when the Python
atomic-rename runtime is unavailable, and accept redundant author-name fields
only when their normalized values agree.

## Acceptance tests

- A Payload relationship target containing the synthetic value
  `unsafe-target?credential=redact-me` fails closed without reproducing the
  target or query value in the thrown error, CLI stdout, CLI stderr, receipts,
  or evidence. The diagnostic retains only its safe source location or an
  opaque digest. Update the existing test that currently expects the raw
  invalid target.
- A CLI-level regression captures a failed `publication:build` and proves the
  unsafe sentinel cannot cross the stderr boundary.
- Two bundles containing the same overlapping bold and italic ranges in
  opposite array orders compare semantically equal, produce the same canonical
  subset SHA-256, and serialize to the same deterministic run order.
  Canonicalization continues to preserve links, hard breaks, relationship
  anchors, target order, and every other authored boundary.
- A Lexical node shaped as
  `{ type: "upload", value: { id: "pic" } }` resolves bytes, media type,
  dimensions, filename, and alternative text from the indexed top-level upload
  exactly as scalar `value: "pic"` does. It emits one content-addressed asset
  and no false `missing-asset` diagnostic.
- Indexed upload data supplies fields missing from an object reference.
  Explicit object fields have documented deterministic precedence; conflicting
  identities or intrinsic metadata fail closed. Locale-specific upload text
  and variant filtering remain intact.
- On supported Linux or macOS with `python3` unavailable, `publicationBuild`
  returns an actionable sanitized dependency error before adapter resolution,
  staging creation, renderer invocation, or output mutation. The test observes
  that none of those later boundaries ran.
- Existing atomic no-replace, exchange, symlink, identity, restoration,
  cross-device, and all-or-nothing publication regressions remain green. No
  ordinary overwrite or copy fallback is introduced.
- `{ name: "Ada", displayName: " Ada ", fullName: "Ada" }` yields one
  contributor named `Ada`. Different normalized values, empty populated
  values, and non-string values remain rejected.
- Each finding has a focused regression demonstrated RED at current main
  `ce2b023893ddf4df6a85cb3b3be9a6c653ac9d6b` and GREEN at the repair head.
  The repair preserves existing locale, asset, canonicalization, renderer, and
  publication behavior.
- A fresh exact-head review has zero unresolved threads, all hosted checks and
  exact-head evidence pass, and the five original PR #156 threads are replied
  to with their specific regression evidence before they are resolved.

## Validation command

```bash
node --version
python3 --version
npx vitest run src/publication/adapter-conformance.test.ts src/publication/adapters/payload-lexical.test.ts tools/publication-build.test.mjs
npm test
npm run build
npm run publication:build -- --adapter payload --input tests/fixtures/payload/publication.json --mapping tests/fixtures/payload/mapping.json --output .agent/evidence/pr156-postmerge-repair
npm run publication:check -- --input .agent/evidence/pr156-postmerge-repair --matrix phone-webpub,eink-epub,a5-pdf,a4-pdf
scripts/agent-evidence --all
git diff --check
git status --short
```

## Allowed secrets

None. Tests use only an obviously synthetic sentinel, never a real token,
credential, customer document, or private upload. Source values, errors,
receipts, logs, evidence, and review replies must not expose secret-looking
input. No GitHub, deployment, CMS, subscription, or browser credential is
required.

## Artifact outputs

- Focused changes to `src/publication/adapter-conformance.ts`,
  `src/publication/adapters/payload-lexical.ts`, and
  `tools/publication-build.mjs`.
- One RED-to-GREEN regression per finding in
  `src/publication/adapter-conformance.test.ts`,
  `src/publication/adapters/payload-lexical.test.ts`, and
  `tools/publication-build.test.mjs`.
- A minimal operator-runtime note if `python3` remains required for atomic
  publication.
- Ignored exact-head publication artifacts and an evidence manifest under
  `.agent/evidence/`, plus a thread-to-test disposition for all five findings.
  Generated publications are not committed.

## Stop conditions

Stop before weakening atomic publication, following or overwriting an untrusted
path, fetching a remote upload, exposing a raw source value, changing renderer
semantics instead of canonical comparison, or touching deployment,
infrastructure, CMS, browser, or secret-bearing paths. Stop and deconflict if
another actor owns an overlapping branch, worktree, lease, issue, or pull
request. If early Python preflight cannot preserve the existing atomic contract
without a new native dependency, report that exact architecture choice instead
of silently changing the boundary.

## Human clarification protocol

No human decision is expected. Use the safe defaults in this spec: opaque
relationship diagnostics, deterministic semantic ordering, indexed upload data
supplying missing object fields with fail-closed conflicts, an early Python
runtime preflight, and author acceptance only when trimmed fields agree. If
those defaults prove impossible, send one bounded decision packet with the
smallest reproducer, recommended option, and trade-off; do not request routine
implementation or merge approval.

## Recommended response

Keep one repair pull request narrow and fail closed. Remove raw relationship
values from errors; sort canonical runs by effective interval and stable
semantics before adjacency folding; resolve object upload references through
the existing index without hiding conflicts; retain the secure Python syscall
shim but probe and document it before expensive work; and accept multiple
author fields only when their trimmed values are identical.

## Trade-offs

An early Python preflight retains an external runtime prerequisite but is
smaller and safer than replacing the atomic rename implementation or adding a
native dependency. Canonical sorting changes only the comparison
representation, not rendering. Indexed upload completion improves real Payload
export support but needs explicit conflict precedence. Requiring author-field
agreement preserves ambiguity detection while accepting common redundant CMS
records.

## Free-form response

Provenance: issue #161 follows PR #156 head
`a6cdd150e7ee59d7516fc53ec523153d0be31ca9` and squash merge
`f3a457c61afb644e0cf197402aa3283b21786710`. Exact-head review
`PRR_kwDON227nc8AAAABI_97mA` arrived 92 seconds after merge and opened P1
thread `PRRT_kwDON227nc6X84W7` plus P2 threads
`PRRT_kwDON227nc6X84Wn`, `PRRT_kwDON227nc6X84Ww`,
`PRRT_kwDON227nc6X84W0`, and `PRRT_kwDON227nc6X84XC`. All remain
non-outdated and unresolved on base
`ce2b023893ddf4df6a85cb3b3be9a6c653ac9d6b`. PR #159 changed only the
Erniesg drain service and timer and repairs none of them.
