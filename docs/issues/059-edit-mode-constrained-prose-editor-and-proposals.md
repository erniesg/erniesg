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
5. **The round trip is proven, not assumed.** For every one of the 46 nodes, a
   test parses the source to the editor schema and serializes it back, and
   asserts the Markdown is byte-identical when nothing was edited. Any node
   that fails is either fixed or explicitly marked prose-locked; silent
   corruption is not acceptable.
6. A proposal records its base commit. When the source has moved on, the
   proposal is marked stale and shown as such rather than applied blindly.
7. A reader may save, reopen and revise their own pending proposal, and
   withdraw it. Reviewing and applying belong to 060.
8. Edit mode is keyboard-complete and announces its state to assistive
   technology.

## Acceptance tests

- All 46 nodes round-trip byte-identically through the editor schema with no
  edit applied.
- Pasting a table, an image, a script tag and a styled span yields only
  permitted nodes and no attributes outside the allowlist.
- Editing a single word produces a CriticMarkup patch touching only that word.
- A proposal against an outdated base commit is marked stale, not applied.
- A locked block cannot be edited by keyboard, paste or drag.
- Withdrawing a proposal removes it from review without deleting its thread.

## Definition of done

Every node round-trips clean, the paste-sanitization tests pass, and a saved
proposal applies cleanly to its base commit with `git apply` in a test.

## Validation command

```bash
npm --workspace packages/margin test
npx vitest run src/worker/margin
python3 challenges/tools/validate.py
npm test
SRT_E2E_PORT=$((4300 + RANDOM % 200)) npx playwright test tests/e2e/margin-edit-mode.spec.ts
```

## Concurrency

This repository runs multiple issue workers on one host. Any command in this
spec that binds a port must choose it per run, never a fixed default, and any
temporary path must be unique per worker. A spec that hardcodes `8787`, `4321`
or a fixed preview port is a spec that cannot be run in parallel with another.
Playwright is the trap worth naming: `playwright.config.ts` reads
`SRT_E2E_PORT` and otherwise binds every run to `1234`, so set that
variable per run rather than inventing a new name for it.

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
