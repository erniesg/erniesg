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
  `GET /documents/:id/history` still return 501 from 054.
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
   revisions. No commit content is duplicated into D1.
9. Applying is idempotent: a retried apply does not open a second pull request.

## Acceptance tests

- A pending proposal renders a diff whose additions and deletions match the
  CriticMarkup exactly.
- Save leaves the proposal pending and writes nothing to the repository;
  a test asserts no git operation occurred.
- Apply opens exactly one pull request containing exactly the proposed change;
  a retry opens none.
- An admin's own edit produces the same artifact as a reader's proposal.
- A proposal whose base commit is behind `main` but conflict-free rebases and
  applies; one that conflicts is refused with the conflict surfaced.
- `history` returns the real git log for a node and a correct diff between two
  revisions.
- The service holds no git credential: a test asserts the Worker's bindings
  contain no repository token, and that apply fails closed if the adapter is
  unreachable rather than falling back to a direct write.
- A non-admin calling apply is 403.

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
SRT_E2E_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
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

## Artifact outputs

The review queue and diff view; save and apply as distinct actions; the source
adapter contract and its challenges implementation in `adapters/margin/`; the
history endpoint; the credential-boundary test.

## Stop conditions

Stop before putting a git credential in the Worker, before letting an admin
edit bypass the proposal path, before applying a stale proposal, and before
copying commit history into D1.

## Human clarification protocol

The adapter's repository credential is a human action: a fine-grained,
repo-scoped token for `erniesg/erniesg` only, staged by name. Apply
`rucksack-needs-human` and build against a stub adapter until it exists.

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
