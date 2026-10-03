# Admin review: diff, save or apply, the challenges adapter, and version history

depends-on: 059

## Provider

claude

## Goal

Close the loop. The admin sees pending proposals as a diff with additions and
deletions marked, and chooses to save the review or apply the change. Applying
turns the proposal into a real commit against the book's source. Version
history is the file's git history, because the source is already in git and a
second copy of history in a database would only be a copy that lies.

This issue also builds the boundary that makes `margin` adoptable elsewhere:
**the service never holds a git credential.** It records an approved proposal
and emits an event; the consuming repository's adapter is what writes. This is
the same rule struct states for itself — credentials and deployment authority
stay at each owning adapter boundary.

## Observed failure

- 059 produces proposals that nothing reviews. `POST /proposals/:id/apply` and
  `GET /documents/:id/history` still return 501 from 054. The route table
  comment in `src/worker/margin/routes.ts` attributes history to 059; this
  issue owns it, so correct the comment.
- **A pull request opened with `GITHUB_TOKEN` starts no workflows.** GitHub
  does not trigger workflows from events that `GITHUB_TOKEN` causes. An apply
  that used it would open a PR whose required checks never run, and it could
  never merge. The adapter must open PRs with the repo-scoped credential below.
- No adapter exists, so there is no path from an approved proposal to
  `books/chapters/<node>.md`.
- **The reviewer cannot see private proposals.** `listAnnotationsQuery`
  (`src/worker/margin/queries.ts`) returns a private row only to its creator,
  so a proposal saved under a private default never reaches the admin.
- **`.agent/merge-policy.yaml` only merges branches named `codex/*`,
  `claude/*` or `coordinator/*`**, requires a linked issue, and does not list
  `books/**` as automatic. The policy file itself is a sensitive path that
  needs the owner's opt-in to change, and rucksack's generator refuses to
  overwrite an operator-edited policy (`--reset-merge-policy` is required), so
  a hand edit survives regeneration.

## Success criteria

1. A review queue lists pending proposals across documents, filterable by
   document and state, visible only to the admin identity from 055. It is
   served by an **admin-only review listing**
   (`GET /proposals?scope=review`), whose query includes private proposals
   from every creator within the admin's site. 055's `admin` role is global
   today, so this issue adds an explicit **site-admin mapping**
   (`margin_site_admins(site, identity)`, a D1 migration). The listing's SQL
   predicate requires `site IN (sites this identity administers)`, never a
   site the caller supplies. `ernie.sg`'s owner is seeded as its only site
   admin. The exception is in the query. The ordinary `GET /annotations` and
   `GET /proposals` visibility rules are unchanged, and a non-admin asking for
   `scope=review` gets 403.
2. Each proposal renders as a diff with additions and deletions distinctly
   marked, from the CriticMarkup patch, alongside the reviewer's own view of
   the rendered result.
3. **Save or apply are distinct actions.** Save records a review decision,
   comments and any admin revision, leaving the proposal pending. Apply
   commits it. Saving never writes to the repository.
4. Applying an admin's own inline edit follows the identical path as applying
   a reader's proposal — there is no privileged shortcut that bypasses the
   diff and the commit.
5. `adapters/margin/` implements a source adapter contract with two
   operations: resolve a document id to its source, and apply an approved
   proposal. The challenges implementation maps a document id to
   `books/chapters/<node-id>.md` (or `books/challenges/<node-id>/challenge.md`) and applies by
   opening a pull request against `erniesg/erniesg`.
6. The contract is written so a second site implements it without touching the
   service. The service passes an approved proposal and its base commit and
   receives a result; it knows nothing about git, GitHub or Markdown.
7. A stale proposal cannot be applied. Either it rebases cleanly onto current
   `main` and says so, or it is refused with the conflict shown to the admin.
8. `GET /documents/:id/history` returns the node's commit history through the
   adapter — commit, author, date, message — and a diff between any two
   revisions. No commit content is duplicated into D1. The challenges adapter
   implements this **at build time**: for each node, the build writes a
   static history asset from `git log --follow --name-status -- <file>`,
   holding each commit's metadata, **the file's path at that commit** (so a
   renamed node keeps its pre-rename versions), and the content read with
   `git show <commit>:<path-at-that-commit>`. A commit whose status for the
   file is `D` (deleted) is recorded as a **tombstone**, with no content and no
   `git show`, so a node that was deleted and later restored keeps building.
   A tombstone is a history entry and keeps its place in the git-log order,
   but it is never rendered or diffed; 072 shows it as a "deleted in this
   commit" step. The page reads that asset, so history needs no credential and no GitHub API
   rate limit, and it always matches the deployed build. Like 059's stamp, it
   refuses a shallow or partial checkout, and any other git error fails the
   build rather than emitting partial history. The asset holds no proposal IDs
   (see 072).
   **History is site-owned.** Each consuming site builds and serves its own
   history asset. When the site registers its adapter with the service, it
   declares a `historyLocation` URL template. `GET /documents/:id/history`
   answers with that site's locator (and, for the co-deployed `ernie.sg`
   site, the asset itself from `ASSETS`). It never reads another site's
   repository.
9. Applying is idempotent across runs, not just within one. Each proposal
   has one deterministic branch, `coordinator/margin-proposal-<proposal-id>`,
   which `.agent/merge-policy.yaml` accepts. Before creating anything, a run
   looks for an existing tracking issue (by a `margin-proposal:<id>` marker)
   and an open or merged PR from that branch, and adopts them. So an
   overlapping scheduled and manual run, or a run that crashed after creating
   the PR but before reporting, never produces a second issue or PR. The
   workflow also sets a `concurrency` group so two runs never overlap.
10. **Apply is one action, bound to what was reviewed; merging follows the
    repository's merge policy.** `POST /proposals/:id/apply` carries the
    `revision` (from 059) the admin reviewed. In one transaction it refuses
    with `409` unless the proposal is still `pending` (not withdrawn) **and**
    still at that revision, and otherwise snapshots that revision's
    CriticMarkup and base commit as the approved change and returns `202` with
    state `approved`. Later revisions never alter
    an approved snapshot. It never waits on the adapter.
    The adapter's feed is rows in `approved`, rows in `pr_open` or `conflict`
    (so every run can refresh them until they reach `merged` or `closed`), and
    rows in `apply_failed` whose attempt count is under the limit (3), so a
    failed apply is retried on the next run. The adapter reports back, and the queue shows every state:
    `pr_open` (PR number, URL and full head SHA), `conflict` (the rebase
    conflict, shown to the admin), `merged` (the merge commit SHA), `closed`,
    or `apply_failed` (reason and attempt count). While a PR is open, each
    adapter run refreshes its head SHA and check state from GitHub and reports
    them.
    **Owner decision (2026-09-28): applied proposals merge automatically when
    green.** The owner's Apply is the review; the required checks and issue
    linkage still gate every merge. This issue's PR adds `books/chapters/**`
    and `books/challenges/*/challenge.md` to `automatic_path_patterns` in
    `.agent/merge-policy.yaml`. Because that file is a sensitive path, that PR
    needs the owner's `/rucksack merge` opt-in, which is the guarded process.
    Keep the edit so rucksack's generator preserves it (it refuses to overwrite
    an operator policy without `--reset-merge-policy`). `.agent/merge-policy.yaml`
    stays authoritative: rucksack merges an eligible adapter PR, and the
    adapter never arms GitHub auto-merge itself. If a PR is not eligible (a
    path outside the automatic list, or a failed gate), the queue says why and
    shows the exact `/rucksack merge <full-current-head-sha>` command, filled
    with the head SHA the adapter last reported. The policy forbids a PR with
    no linked issue, so for each approved proposal the adapter opens one
    tracking issue and puts `Closes #<issue>` in the PR body. **The tracking
    issue carries nothing private:** the title is `Margin proposal for
    <node-id>`, the body names the node and the PR, and the marker is an
    opaque `margin-proposal:<hmac>`, an HMAC of the proposal ID under a
    service-held key, which cannot be reversed to the ID. No proposal title,
    text, author or link to the proposal goes into GitHub for a private
    proposal. A public proposal may link to itself.
11. The adapter runs as a GitHub Actions workflow in `erniesg/erniesg`
    (`schedule` plus `workflow_dispatch`) that **pulls** approved proposals
    from the service. The Worker never calls GitHub, so it holds no GitHub
    credential of any kind. The adapter authenticates to the service with an
    adapter token **bound to one site and one adapter identity**. The Worker
    stores only the token's SHA-256 with that `(site, adapter)` scope, compares
    in constant time, and lets the token do exactly two things within its site:
    read the feed and report results. Proposals from another site are
    invisible to it. A second consuming repository gets its own token without
    any change to this contract.
    When the PR merges, the adapter reports the merge commit SHA, and the
    service stores it on the proposal. That stored SHA is the only
    commit-to-proposal link. It does not depend on the merge actor copying a
    trailer into the squash commit, and it never appears in a public asset.
    072 resolves a history commit to its proposal through the service, keyed
    by that SHA.
12. The page has a history panel: the node's versions, newest first, and any
    two picked to show a rendered diff. Replay over time is 072.
13. **A proposal's author can see its state.** The annotation response
    (`present()`) carries `margin:proposalState` (`approved`, `pr_open`,
    `conflict`, `merged`, `closed` or `apply_failed`) once a proposal has left
    `pending`, but only for its creator and the admin. Nobody else gets it, so
    a private proposal's progress is not disclosed. 073's overview reads this
    field.

## Acceptance tests

- A pending proposal renders a diff whose additions and deletions match the
  CriticMarkup exactly.
- Save leaves the proposal pending and writes nothing to the repository;
  a test asserts no git operation occurred.
- Apply opens exactly one pull request containing exactly the proposed change
  (the approved snapshot, converted by 059's `toUnifiedDiff`), with a linked
  tracking issue and a `Margin-Proposal` trailer; a retry opens none.
- Apply with a stale `revision` is refused with `409`. A revision saved after
  approval does not change what the adapter applies.
- A row that failed once is in the next run's feed and ends with exactly one
  PR; after three failures it leaves the feed and stays `apply_failed`.
- The adapter's reports move a row through `pr_open`, `conflict`, `merged` and
  `closed` across **separate runs**: a row reported `pr_open` in one run is in
  the next run's feed and reaches `merged` with its merge commit SHA stored.
- For a PR that is not merge-eligible, the queue shows
  `/rucksack merge <full-head-sha>` with the last reported head SHA.
- Apply on a proposal withdrawn after the admin loaded it is refused with
  `409`, even at the same revision.
- A run that crashes after creating the PR but before reporting, followed by
  a second run, leaves exactly one tracking issue and one PR, on
  `coordinator/margin-proposal-<id>`.
- A private proposal from another reader appears in the admin's
  `scope=review` listing and nowhere else; a non-admin's `scope=review` is 403.
  An admin of one site given a second site's scope gets none of that site's
  private proposals.
- The tracking issue and PR for a private proposal contain no proposal ID,
  title, text or author, only the node, the PR and the opaque marker.
- A fixture node that is deleted and later restored builds, with the
  deletion shown as a tombstone.
- A second fake adapter registered for another site gets its own
  `historyLocation` back from `GET /documents/:id/history`, and the service
  never reads that site's repository.
- An admin's own edit produces the same artifact as a reader's proposal.
- A proposal whose base commit is behind `main` but conflict-free rebases and
  applies; one that conflicts is refused with the conflict surfaced.
- `history` returns the real git log for a node and a correct diff between two
  revisions.
- The service holds no git credential: a test asserts the Worker's bindings
  contain no repository token. With the adapter not running, apply returns
  `202`, the row stays `approved`, and nothing is written; the Worker never
  falls back to a direct write. After an adapter run fails, the next run
  opens exactly one PR for that row.
- An adapter token can read its own site's feed and report results for its
  own site's proposals, and nothing else: another site's proposals are absent
  from its feed, reporting on them is 403, and every other route is 403.
- A non-admin calling apply is 403.
- The adapter's pull-request step uses the repo-scoped credential, never
  `GITHUB_TOKEN` (a workflow-boundary test greps the adapter workflow). It
  never arms GitHub auto-merge, and every branch it creates matches
  `coordinator/margin-proposal-*`, which a policy-boundary test checks against
  `.agent/merge-policy.yaml`'s `head_branch_patterns`.
- The build's history asset for a node lists the same commits as
  `git log --follow --format=%H -- <file>`, and the content at each commit
  equals `git show <commit>:<path-at-that-commit>`. A fixture that renames a
  node keeps its pre-rename versions.

## Definition of done

A reader's proposal can be reviewed, saved, revised, applied as a pull request,
and the node's version history is readable from the page — with no git
credential present in the Worker.

## Validation command

```bash
npx vitest run src/worker/margin adapters/margin
npm run test:margin
python3 books/tools/validate.py
npm test
npm run build
if [ -f tools/e2e-port.mjs ]; then SRT_E2E_PORT=$(node tools/e2e-port.mjs) || exit 1; else SRT_E2E_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()') || exit 1; fi; [ -n "$SRT_E2E_PORT" ] || exit 1; export SRT_E2E_PORT
npx playwright test tests/e2e/margin-review.spec.ts
```

## Concurrency

This repository runs multiple issue workers on one host. Any command in this
spec that binds a port must choose it per run, never a fixed default, and any
temporary path must be unique per worker. A spec that hardcodes `8787`, `4321`
or a fixed preview port is a spec that cannot be run in parallel with another.
Playwright is the trap worth naming: `playwright.config.ts` reads
`SRT_E2E_PORT` and otherwise binds every run to `1234`, so set that
variable per run rather than inventing a new name for it. Ask the kernel
for a free port rather than sampling a range: with up to 16 workers,
`$RANDOM % 200` collides often enough to fail a correct run.

## Allowed secrets

The adapter requires a repository-scoped credential, by name only, held at the
adapter boundary and never in the Worker. Never `admin:org`. The Worker's own
bindings must contain no repository token at all.

Two secrets, both by name only:
- `MARGIN_ADAPTER_GITHUB_TOKEN`: a GitHub Actions secret on `erniesg/erniesg`,
  a fine-grained token for this repository only, with **Contents, Pull
  requests and Issues: write** (Issues for the tracking issue the merge policy
  requires). It opens the adapter's PRs, so their checks run.
- `MARGIN_ADAPTER_TOKEN`: a GitHub Actions secret holding this repository's
  adapter token for the `ernie.sg` site. The Worker holds only its SHA-256,
  bound to `(site, adapter)`, never the token itself.

## Artifact outputs

The review queue and diff view; save and apply as distinct actions; the source
adapter contract and its challenges implementation in `adapters/margin/`; the
history endpoint; the credential-boundary test.

## Stop conditions

Stop before putting a git credential in the Worker, before letting an admin
edit bypass the proposal path, before applying a stale or withdrawn proposal,
before copying commit history into D1, before putting a proposal ID in a
public asset, and before arming GitHub auto-merge from the adapter.

## Human clarification protocol

Both adapter secrets are human actions. The owner creates the fine-grained,
repo-scoped token for `erniesg/erniesg` and stages it as
`MARGIN_ADAPTER_GITHUB_TOKEN`. The owner (or the coordinator on the owner's
say-so) generates `MARGIN_ADAPTER_TOKEN`, stages it as an Actions secret, and
registers its SHA-256 with the Worker, bound to the `ernie.sg` site and this
adapter. Apply
`rucksack-needs-human` with one ask covering both, and build against a stub
adapter until they exist.

## Recommended response

Have apply open a pull request rather than commit to `main` directly, even for
the admin. The book's own CI then reviews every reader-proposed change, and a
bad apply is a closed pull request rather than a revert.

## Trade-offs

A pull request per approved proposal is heavier than a direct commit and will
feel slow for a one-word typo fix. It is also the only version of this where
an automated write to the book's source is reviewable before it lands.

## Free-form response

Version history and "show me the diff like git" are the two requirements that
tempt a database re-implementation. The source is already in git. Reading it
through the adapter is less code and it cannot drift from the truth.
