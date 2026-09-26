# @erniesg/margin: the client package, text selection and durable anchoring

depends-on: 053,062

## Provider

claude

## Goal

The browser half of `margin`, as a standalone package at `packages/margin/`
that imports nothing from the book and is publishable to npm as
`@erniesg/margin`.

**A resolver already exists and this issue extends it rather than rewriting
it** — but read its real signature before planning around it.
`createSemanticTextAnchorFromRange(nodeId, text, start, end, contextLength)`
takes a **node id and numeric offsets, not a DOM `Range`**, and produces an
anchor for a **single node**. It is not selection-to-anchor and it cannot
serve multi-block selections. `resolveTextAnchor` is the genuinely reusable
piece: it returns `resolved` / `ambiguous` / `unresolved` with
`matchedBy: 'position-and-context' | 'quote-and-context' | 'unique-quote'`.

So this issue must still build the DOM layer: a browser `Selection` to one or
more semantic anchors, including selections spanning block boundaries.

What this issue adds is what is genuinely missing: a struct-ID selector ahead
of the existing chain, keyboard selection, multi-block and overlapping
highlight painting, orphan handling in the UI, and the packaging that makes
all of it embeddable on another site.

Anchoring matters because the book is actively being written — Parts III-IX
are 22 topics still to come — so highlights will face changed source
constantly.

## Observed failure

- Nothing exists. `packages/` is not in the repo.
- The margin column added in 053 is an empty landmark with a mount point and
  no behaviour.

## Success criteria

1. `packages/margin/` builds and tests independently, with zero imports from
   `books/`, `src/content/` or anything book-specific. A test asserts the
   built bundle contains no book identifiers. It ships as a web component plus
   a plain JS API; the optional React wrapper is a separate entry point.
2. Selection capture works by **keyboard as well as mouse**: a reader
   extending a selection with shift+arrow keys, or selecting with a screen
   reader active, gets the same anchor as a mouse drag. Keyboard selection is
   a first-class path, not a fallback.
3. A DOM layer converts a browser `Selection` into anchors, delegating
   per-node anchor construction to the existing helper rather than
   reimplementing it. A selection spanning several blocks yields an ordered
   set of anchors, not a failure.
4. A `structId` selector is added **ahead of** the existing chain, so
   resolution order becomes struct ID, then position-and-context, then
   quote-and-context, then unique-quote. `resolveTextAnchor` is extended in
   place and its existing `matchedBy` values keep their meaning; the new value
   is additive. Struct owns stable IDs and renders both XHTML and EPUB from
   the same document, so an anchor made on the web edition can resolve in the
   EPUB.
5. `ambiguous` and `unresolved` resolutions surface as **orphaned, not
   silently dropped**: the annotation stays in the rail, marked, with its
   quote readable.
6. Re-anchoring survives realistic edits. Tests cover: text inserted above the
   anchor, the containing paragraph reworded, the anchor's own words unchanged
   but moved to a different block, an identical quote appearing twice in the
   document, and the anchored text deleted outright (which must orphan).
7. Highlight painting handles a selection spanning multiple block elements and
   overlapping highlights, without mutating the book's semantic markup in a
   way that changes what `render.py` produced.
8. The package talks to the service only through the `/api/margin/v1/` surface
   from 054, via an injectable transport so it can be pointed at another host.
   No endpoint is hardcoded.
9. No framework dependency, no CSS framework, and no global style leakage into
   the host page.

## Acceptance tests

- Keyboard-only selection produces an anchor identical to the mouse selection
  of the same range.
- Each of the five edit scenarios in criterion 6 resolves or orphans as
  specified, asserted against real book HTML from `render.py`.
- Every existing `resolveTextAnchor` test still passes unchanged after the
  struct-ID selector is added.
- A duplicate quote resolves to the correct occurrence using prefix/suffix.
- A multi-block selection paints correctly and round-trips to the same anchor.
- The bundle contains no book-specific identifier.
- The transport can be swapped for a stub with no source change.

## Definition of done

`packages/margin/` builds, tests pass including all anchoring scenarios,
the package is publishable (`npm pack` produces a valid tarball), and
selection plus highlight painting work on a real built book page.

## Validation command

```bash
npm run test:margin
npm run margin:build
npm test
npm run build
SRT_E2E_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
npx playwright test tests/e2e/margin-anchoring.spec.ts
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

None. This code runs in the reader's browser and can hold nothing secret.

## Artifact outputs

`packages/margin/` with its build, its tests and a README documenting the
anchor format; the selection capture; the selector resolution chain; highlight
painting; the injectable transport.

## Stop conditions

**Stop before writing a second anchor resolver.** `resolveTextAnchor` exists,
is tested, and is in production use; extend it. If the package cannot import
from `src/annotations/` because of the standalone rule, the resolver moves
into the package and `src/` imports it back — one implementation either way,
never two.

Also stop before importing anything book-specific into the package, before
silently discarding an annotation that fails to re-anchor, and before
hardcoding an API origin.

## Human clarification protocol

If a selection shape cannot be anchored durably at all — a selection entirely
inside a generated figure, say — mark that region non-annotatable in the UI
rather than storing an anchor that will orphan on the next build.

## Recommended response

**Split before moving.** `src/research/annotations.ts` imports `ResearchNode`,
`ResearchPaper` and `TargetProfileId` from research modules and carries
demo-paper and layout-profile helpers. Moving it wholesale into
`packages/margin/` either breaks those imports or drags application code into
a published package, contradicting criterion 1.

So: first extract the generic core — the schemas, `resolveTextAnchor`, and
anchor construction — from the research-specific adapters; move only that
core; leave the research helpers in `src/` importing the package. Do the
split as its own commit before anything else.

## Trade-offs

Carrying three selectors per annotation costs storage and makes the payload
verbose. It is the difference between highlights that survive the book being
finished and highlights that do not.

## Free-form response

This is the piece another site would adopt first, and the piece that is
painful to change once annotations exist in a database. It is specified before
any UI for that reason.
