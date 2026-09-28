# Edit mode: a constrained prose editor that produces applicable proposals

depends-on: 057

## Provider

claude

## Goal

A reader turns on edit mode, types into the prose as they would in a shared
document, and saves the result as a proposal for review. The proposal must be
applicable to the book's Markdown source, because an approved change that
cannot be applied is not an edit.

The decision that makes this safe: **constrain the editor's schema**. The
editor permits exactly paragraphs, headings, emphasis, strong, links, inline
code and lists — the prose subset. Then the round trip back to Markdown is
safe by construction, because the editor cannot produce anything else. Figures,
runnable cells, tables and `:::` blocks render read-only and take comments
instead.

## Observed failure

- The book's source is Markdown with `+++` TOML front matter and `:::` fenced
  blocks (`statement`, `io`, `constraints`, `sample`, plus five figure types).
  An unconstrained HTML-to-Markdown round trip over that will mangle the
  fences, the figure attributes or the front matter, producing a proposal that
  cannot be applied.
- Nothing currently lets a reader propose any change at all.
- **The page does not say what it was built from.** `<margin-rail>` carries
  only `document-uri` (checked on the workers.dev preview, 2026-09-28).
  Nothing on the page names the node's source file or the commit it was
  rendered from, so criterion 4's base commit has no source until the build
  stamps one.
- **What already exists; extend it, never duplicate it.** A `proposal` kind is
  in `packages/margin/src/anchor.ts` (`body: string`, no base commit yet), and
  `GET /proposals` in `src/worker/margin/routes.ts` lists `editing` rows. Add
  the base commit and the CriticMarkup patch to that record. Do not add a
  second proposal shape.
- **The body cap is smaller than the book.** `MAX_BODY_LENGTH` in
  `src/worker/margin/web-annotation.ts` (and the PATCH schema in `routes.ts`)
  is 8,000 characters. 12 of the 46 source files are larger than that, and the
  largest is 16,138 bytes, so a proposal that carries enough context to apply
  unambiguously cannot be stored today.
- **Private proposals are invisible to the reviewer.** `listAnnotationsQuery`
  in `src/worker/margin/queries.ts` returns a private row only when
  `creator = viewer`, so a reader whose default is private saves proposals the
  admin can never list. 060 adds the admin-only review listing; this issue
  must not work around it by forcing proposals public.

## Success criteria

1. Edit mode is per-page and explicit. Entering it does not alter the page for
   anyone else; there is no live collaborative editing in this issue.
2. The editor's schema permits only the prose subset named above. A test
   asserts that pasting rich HTML containing tables, images, scripts or
   arbitrary attributes yields only permitted nodes.
3. `:::` blocks, figures, code listings and front matter render read-only and
   visibly locked, and can be commented on through 057's path.
4. A saved proposal is an `editing` annotation carrying a **Markdown patch
   against a named base commit** of the node's source file, expressed in
   CriticMarkup (`{--deleted--}`, `{++added++}`, `{~~old~>new~~}`).
   CriticMarkup is the only stored form. The body is a list of **hunks**, each
   `{ baseStartLine, baseEndLine, criticMarkup }`: the changed lines of the
   base file plus two lines of unchanged context either side, marked up in
   CriticMarkup, with line numbers against the base commit. Hunks never
   overlap and are ordered. One shared converter,
   `toUnifiedDiff(hunks, baseSource, sourcePath)` in
   `src/annotations/criticmarkup.ts`, turns them into a unified diff; 060's
   adapter uses the same function, so what is tested here is what gets applied.
   The body cap rises to 64,000 characters for `editing` rows only (a full
   retype of the largest node in CriticMarkup is about twice its 16,138
   bytes); highlights and notes keep 8,000. A body over the cap is refused
   with a clear 413, never truncated.
5. **The round trip is proven, not assumed.** For every one of the 46 nodes, a
   test parses the source to the editor schema and serializes it back, and
   asserts the Markdown is byte-identical when nothing was edited. Any node
   that fails is either fixed or explicitly marked prose-locked; silent
   corruption is not acceptable.
6. A proposal records its base commit. When the source has moved on, the
   proposal is marked stale and shown as such rather than applied blindly.
7. A reader may save, reopen and revise their own pending proposal, and
   withdraw it. Every revision increments the proposal's `revision` number,
   which 060 binds an approval to. Reviewing and applying belong to 060.
8. Edit mode is keyboard-complete and announces its state to assistive
   technology.
9. The build stamps each node's page with its repo-relative source path and
   `source-commit`, the last commit that touched that file
   (`git log -1 --format=%H -- <file>`), as attributes on `<margin-rail>`.
   A proposal takes its base commit from these, never from the client's clock
   or a guess. **The build refuses incomplete history**: it fails and names
   the fix if `git rev-parse --is-shallow-repository` prints `true`, or if
   any remote is a promisor (`git config --get-regexp '^remote\..*\.promisor$'`
   prints anything, meaning a partial clone whose history objects may be
   missing). Any git error while stamping fails the build rather than
   emitting a page, because in a one-commit or partial clone
   `git log -1 -- <file>` can be empty or can fail for files HEAD did not
   touch. Every build and deploy path that runs it
   (`.github/workflows/ci.yml`, `agent-evidence.yml`, and any deploy
   workflow) checks out with `fetch-depth: 0`.
   **The stamp must describe the text on the page.** Before stamping, the
   build compares each rendered source file with
   `git show <source-commit>:<path>`. If they differ (an uncommitted edit), a
   production or preview build (`npm run build`, `build:staging`) fails and
   names the file. A dev server (`npm run dev`) instead stamps
   `source-commit="dirty"`, and edit mode on that page is disabled with a
   visible reason, so no proposal is ever made against text that does not
   exist at its base commit.
10. Edit mode covers ordinary editing, not only one-word fixes. Deleting a
    word, a sentence, a whole paragraph or a list item, replacing text,
    retyping a passage, and splitting or joining paragraphs all work, with
    undo and redo inside the session. Before saving, the change shows inline
    as tracked changes (deletions struck, insertions marked). The owner uses
    this same mode; applying their change belongs to 060, and this issue gives
    nobody a direct write.

## Acceptance tests

- All 46 nodes round-trip byte-identically through the editor schema with no
  edit applied.
- Pasting a table, an image, a script tag and a styled span yields only
  permitted nodes and no attributes outside the allowlist.
- Editing a single word produces a CriticMarkup patch touching only that word.
- A proposal against an outdated base commit is marked stale, not applied.
- A locked block cannot be edited by keyboard, paste or drag.
- Withdrawing a proposal removes it from review without deleting its thread.
- For three nodes, the stamped `source-commit` equals
  `git log -1 --format=%H -- <file>` at the build commit, and the stamped
  path exists.
- The build run in a `git clone --depth 1` checkout fails with a message
  naming the shallow clone, and emits no page.
- Deleting a whole paragraph and joining two paragraphs each produce a
  CriticMarkup patch that, converted by `toUnifiedDiff`, `git apply`s cleanly
  to the base commit; undo restores a byte-identical document.
- The build fails in a `--filter=blob:none` partial clone as well as a
  depth-1 clone.
- With an uncommitted edit to one chapter, `npm run build` fails naming that
  file, and `npm run dev` serves the page with edit mode disabled and
  `source-commit="dirty"`.
- Retyping the whole of the largest node saves as one proposal under the
  64,000-character `editing` cap, converts with `toUnifiedDiff` and
  `git apply`s cleanly; a body one character over the cap is refused with
  413. A note over 8,000 characters is still refused.
- `tools/e2e-port.mjs`: two concurrent calls never print the same port, and a
  lock whose owning process has exited is reclaimed.

## Definition of done

Every node round-trips clean, the paste-sanitization tests pass, and a saved
proposal, converted by `toUnifiedDiff`, applies cleanly to its base commit
with `git apply` in a test.

## Validation command

```bash
npm run test:margin
npx vitest run src/worker/margin
python3 books/tools/validate.py
npm test
export SRT_E2E_PORT=$(node tools/e2e-port.mjs 2>/dev/null || python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
npx playwright test tests/e2e/margin-edit-mode.spec.ts
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

**This issue builds the port helper every e2e spec now calls.** Asking the
kernel for port 0 and closing the socket leaves a gap in which another worker
can be handed the same port before Playwright binds it. `tools/e2e-port.mjs`
closes that gap between workers: it asks the kernel for a free port, then
claims it by creating `$TMPDIR/srt-e2e-ports/<port>.lock` with an exclusive
create (`O_EXCL`), writing the PID of the calling shell (`process.ppid`). If
the lock already exists and its PID is alive, it asks for another port. If the
PID is dead, it reclaims the lock. It prints the port and exits. The lock
lives as long as the validation shell does, which covers Playwright's server.
The validation line in every e2e spec falls back to the old one-liner while
this file does not exist, so specs that run before this issue lands still work.

## Allowed secrets

None. This issue produces proposals; it never writes to the repository.

## Artifact outputs

The constrained editor and its schema; the Markdown round-trip with its
46-node proof; CriticMarkup patch generation; base-commit tracking and
staleness; proposal save, revise and withdraw.

## Stop conditions

Stop before widening the editor schema to make a node round-trip, before
allowing any edit inside a `:::` block or front matter, before storing a
proposal that does not carry its base commit, and before writing anything to
the repository from this issue.

## Human clarification protocol

If a node cannot round-trip byte-identically, do not widen the schema. Mark
that node prose-locked, list it in the package README, and report it. A
smaller editable surface is correct; a lossy round trip is not.

## Recommended response

Build on a schema-constrained editor (ProseMirror or equivalent) where the
document schema is the enforcement mechanism, rather than sanitizing output
after the fact. Post-hoc sanitization of a permissive editor is the version of
this that leaks.

## Trade-offs

Locking figures and `:::` blocks means the most structural edits still need a
pull request by hand. That is the right trade: prose is the overwhelming
majority of the book and the part readers can usefully improve.

## Free-form response

CriticMarkup is chosen over a raw diff because it survives being read by a
human in the rail, which is where the review in 060 happens.
