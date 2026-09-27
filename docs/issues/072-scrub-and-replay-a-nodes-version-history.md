# Version history you can scrub: replay a node's edits over time

depends-on: 060

## Provider

claude

## Goal

The owner opens a chapter and watches it change: step back through every
version, play the edits forward, and see at each step exactly what changed,
marked in the rendered prose rather than as a raw Markdown diff. Picking any
two versions to compare is 060's; this issue adds time.

Every version is a git commit, and 060's build-time history asset already
holds each commit's metadata and the file's content at that commit. Replay is
a view over that asset. It needs no new storage, no new endpoint and no
credential.

## Observed failure

- 060 gives a history list and a two-version diff. Nothing shows how a node
  got to where it is, step by step, and nothing links a version to the
  proposal or thread that caused it.
- The owner asked for this directly (2026-09-28): "version history / replay /
  see diffs between versions."

## Success criteria

1. Each node's page has a history view with a scrubber over its versions,
   oldest to newest, from 060's history asset. Every step shows the date,
   author and commit message.
2. At each step the rendered chapter shows that version, with the change from
   the previous step marked inline: deletions struck, insertions highlighted,
   in the prose as the reader sees it and not as Markdown source.
3. Step back, step forward and play (auto-advance at a readable pace, with
   pause). Play respects `prefers-reduced-motion`, which steps without
   animation.
4. Each version links to its commit, and when it came from an applied margin
   proposal (060's PR), to that proposal and its thread, but only if the
   proposal is public or the viewer may see it. Visibility rules come from
   the service and are never re-derived in the client.
5. Deep links: `?version=<commit>` opens the history view at that version,
   and `?compare=<a>..<b>` opens 060's two-version diff.
6. The history view is read-only. It never offers to edit, restore or apply.
   Restoring an old version, if ever wanted, is a proposal through 059 like
   any other change.
7. Keyboard-complete, with the current step announced to assistive
   technology.

## Acceptance tests

- For a node with at least three commits, the scrubber lists the same
  commits in the same order as `git log --follow --reverse -- <file>`.
- At each step the inline marks match a word diff between consecutive
  versions: every deleted word is struck and every inserted word is marked,
  with no others.
- `?version=<commit>` renders that version; an unknown commit shows a clear
  "no such version" state rather than the latest.
- A version produced by a private proposal does not link that proposal for
  another reader.
- Under `prefers-reduced-motion`, play steps without transition.
- The history view has no control that writes anything (a test asserts no
  POST, PATCH or DELETE is sent while using it).

## Definition of done

On the preview, the owner can open a chapter's history, scrub and play
through every version with changes marked inline, deep link to a version,
and follow a version back to its proposal.

## Validation command

```bash
npm run test:margin
npx vitest run src/worker/margin
python3 books/tools/validate.py
npm test
npm run build
SRT_E2E_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
npx playwright test tests/e2e/margin-history-replay.spec.ts
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

None.

## Artifact outputs

The history view with scrubber, step and play; inline change marks between
consecutive versions; version and compare deep links; version-to-proposal
links under the service's visibility rules.

## Stop conditions

Stop before copying history or file content into D1, before adding any
endpoint that reads git at request time, before adding a credential, and
before putting any write action in the history view.

## Human clarification protocol

If 060's history asset is not built the way 060 specifies (commit metadata
plus file content per commit), do not build a second history source. Fix the
asset in 060's code path and say so.

## Recommended response

Render each version with the same pipeline the page uses, then word-diff the
rendered text blocks between consecutive versions, keyed by struct ID where
the block exists in both. Diffing rendered blocks keeps figures, `:::` blocks
and code intact, with changes inside them shown at block level.

## Trade-offs

Rendering every version at build time costs build time and asset size in
proportion to history length. Build it lazily, rendering a version when it is
first visited and caching the result in the browser. At 46 nodes with short
histories, that is small.

## Free-form response

Replay is where "version history is git" pays off: the data already exists
and is already true.
