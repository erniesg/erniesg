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

## Success criteria

1. A review queue lists pending proposals across documents, filterable by
   document and state, visible only to the admin identity from 055.
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
   `git show <commit>:<path-at-that-commit>`. The page and the endpoint read
   that asset, so history needs no credential and no GitHub API rate limit,
   and it always matches the deployed build. Like 059's stamp, it refuses a
   shallow or partial checkout, and any git error fails the build rather than
   emitting partial history.
9. Applying is idempotent: a retried apply does not open a second pull request.
10. **Apply is one action, bound to what was reviewed; merging follows the
    repository's merge policy.** `POST /proposals/:id/apply` carries the
    `revision` (from 059) the admin reviewed. In one transaction it refuses
    with `409` if the proposal has moved past that revision, and otherwise
    snapshots that revision's CriticMarkup and base commit as the approved
    change and returns `202` with state `approved`. Later revisions never alter
    an approved snapshot. It never waits on the adapter.
    The adapter's feed is rows in `approved`, plus rows in `apply_failed` whose
    attempt count is under the limit (3), so a failed apply is retried on the
    next run. The adapter reports back, and the queue shows every state:
    `pr_open` (PR number, URL and full head SHA), `conflict` (the rebase
    conflict, shown to the admin), `merged` (the merge commit SHA), `closed`,
    or `apply_failed` (reason and attempt count). While a PR is open, each
    adapter run refreshes its head SHA and check state from GitHub and reports
    them.
    `.agent/merge-policy.yaml` is authoritative for merging. Today `books/**`
    is not an automatic path, so an applied PR waits for the owner's
    `/rucksack merge <full-current-head-sha>`. The queue shows that exact
    command, filled with the head SHA the adapter last reported. The policy also
    forbids a PR with no linked issue, so for each approved proposal the adapter
    opens one tracking issue (title from the proposal, body linking it) and puts
    `Closes #<issue>` in the PR body. Adding book paths to automatic merge is an
    owner policy decision made through the guarded policy process, outside this
    issue. Do not arm GitHub auto-merge around it.
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
    Every adapter PR puts a `Margin-Proposal: <proposal-id>` trailer in its
    body and in the squash commit message, and the reported merge commit SHA
    is stored on the proposal. 072 resolves a history commit to its proposal
    through either one.
12. The page has a history panel: the node's versions, newest first, and any
    two picked to show a rendered diff. Replay over time is 072.

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
  `closed`, and the queue shows `/rucksack merge <full-head-sha>` with the
  last reported head SHA.
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
  `GITHUB_TOKEN` (a workflow-boundary test greps the adapter workflow), and it
  never arms auto-merge on a PR touching a path that
  `.agent/merge-policy.yaml` does not list as automatic.
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
export SRT_E2E_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
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
  a fine-grained token for this repository only, with contents and pull
  requests write. It opens the adapter's PRs, so their checks run.
- `MARGIN_ADAPTER_TOKEN`: a GitHub Actions secret holding this repository's
  adapter token for the `ernie.sg` site. The Worker holds only its SHA-256,
  bound to `(site, adapter)`, never the token itself.

## Artifact outputs

The review queue and diff view; save and apply as distinct actions; the source
adapter contract and its challenges implementation in `adapters/margin/`; the
history endpoint; the credential-boundary test.

## Stop conditions

Stop before putting a git credential in the Worker, before letting an admin
edit bypass the proposal path, before applying a stale proposal, and before
copying commit history into D1.

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
