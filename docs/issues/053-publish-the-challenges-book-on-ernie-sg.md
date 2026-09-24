# Publish the book at /books/build-a-coding-agent with one renderer and the shared reading shell

## Provider

claude

## Goal

Put the book on the web at `/books/build-a-coding-agent/`, and build the
three-column reading shell as a **shared layout** that `/library`, `/books`,
`/papers` and `/blog` will all use, per [ADR 010](../adr/010-reading-writing-and-the-margin-layer.md).

Today the book exists only as an EPUB and a localhost Python server whose own
docstring says it is "a local preview of the node format, not the published
site." Nothing in `src/pages/` references it. Every later issue in this series
(054-060) annotates, comments on, or proposes edits to pages that do not yet
exist at a URL.

Two constraints decide this issue:

1. `books/tools/render.py` stays the only thing that emits block markup.
   Astro wraps its output; Astro does not re-implement it. The moment a second
   renderer exists the web and EPUB editions drift and the reader sees two
   different books.
2. The reading shell belongs to the site, not to the book. A surface that
   cannot use it is a surface that has diverged for no reason.

## Observed failure

- `challenges/` is absent from `src/pages/`, `astro.config.ts` and the build.
  `npm run build` produces no book page.
- `preview.py` renders on every request from disk and binds to localhost. It is
  a reading tool, not a publishing path, and it grades by running reader code
  in local subprocesses, which cannot happen on a static host.
- There is no shared reading layout. `/research/[id].astro` and the blog each
  lay out their own text column, so a margin rail added to one would not
  appear on the other.

## Success criteria

1. `render.py` is invoked at build time and its HTML is embedded verbatim. A
   byte-comparison test asserts the block markup for a given node is identical
   between the Astro build output and `render_node` called directly. Any
   divergence fails the build.
2. **`challenges` is the node pool, not a book, and must never appear in a
   URL.** `book.toml` declares `collection = "Challenges"`; the book itself is
   a *path* over that pool — `paths/agent.toml`, `id = "agent"`,
   `title = "Build a Coding Agent"`, subtitled "Data structures and
   algorithms, from zero, by building one thing". A second path over the same
   pool would be a second book.

   Routes: `/books/` (index of books), `/books/build-a-coding-agent/` (that
   path's index with the topic map) and
   `/books/build-a-coding-agent/<node-id>/` for all 46 nodes. The book segment
   is derived from the path's own identity, so adding `paths/foo.toml` yields
   `/books/<its slug>/` with no route code change. Generated from
   `load_book()` + `all_nodes()`, never a hand-maintained list.

   **That identity has to be a durable field, so add one.**
   `challenges/paths/agent.toml` (now `books/dsa.toml`) then carried `id = "agent"` and
   `title = "Build a Coding Agent"` and nothing that yields
   `build-a-coding-agent`. Neither existing field can be the source: mapping
   `id` in route code reintroduces the hand-maintained list this criterion
   forbids, and slugifying `title` makes the URL move the day the title is
   edited. Because 054-060 anchor annotations to the document URI, a moved URL
   silently orphans every annotation on the book. Add an explicit
   `slug = "build-a-coding-agent"` to each path file, derive the route from
   that field alone, and treat it as durable: a test asserts the route comes
   from `slug` and that changing `title` does not change any route.
3. **A shared `ReadingLayout`** in `src/layouts/` provides the three columns:
   navigation, text, and a margin column with a stable mount point for
   054-060. It takes the document URI and the text content as inputs and knows
   nothing about books specifically. The book's pages use it; a follow-up
   issue moves `/papers` and `/blog` onto it.
4. The margin column renders as an empty landmark reserving its width, so
   populating it later does not shift the text column. Below 1280px it
   collapses, matching the existing `preview.py` breakpoint for `.rail`.
5. Every node page carries a stable document URI and, where the node has
   struct-addressable blocks, per-block stable IDs in the DOM. These are the
   anchor targets 056 depends on; a block whose ID changes between two builds
   of identical source fails the test.
6. Runnable cells and the grader are out of scope. Where the EPUB shows a
   listing, the web shows a listing.
7. The EPUB build is unchanged: `books/dist/*.epub` stays
   EPUBCheck-clean and byte-stable for unchanged source.

## Acceptance tests

- A test renders `ch12-hash-maps` through the Astro build and through
  `render_node` and asserts the block markup matches exactly.
- A test builds twice from unchanged source and asserts every per-block DOM ID
  is identical across the two builds.
- A test asserts all 46 node routes are emitted under `/books/build-a-coding-agent/` and
  that the count comes from `all_nodes()`.
- A test renders `ReadingLayout` with non-book content and asserts it produces
  the same three-column structure, proving it is not book-coupled.
- A Playwright test asserts three columns above 1280px and two below, with no
  horizontal page scroll at 375px.

## Definition of done

`npm run build` emits `/books/`, `/books/build-a-coding-agent/` and 46 node
pages; the
renderer-parity test passes; the ID-stability test passes; `ReadingLayout` is
proven surface-agnostic by test; EPUBCheck is clean; no second renderer exists
anywhere in `src/`.

## Validation command

```bash
python3 books/tools/validate.py
npm run build
npm test
SRT_E2E_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
npx playwright test tests/e2e/reading-shell.spec.ts
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

`/books` and `/books/<path-slug>` Astro routes; a build-time bridge that calls
`render.py`; `src/layouts/ReadingLayout.astro` with a reserved margin mount
point; renderer-parity, ID-stability and layout-agnosticism tests.

## Stop conditions

Stop before re-implementing any block markup in TypeScript, before
hand-listing node IDs, before changing `render.py`'s output to suit the web
target, and before putting anything book-specific into `ReadingLayout`. If the
web needs something the renderer does not emit, add it to `render.py` behind
the existing web/print target switch so print stays in sync.

## Human clarification protocol

If build-time invocation of Python from Astro proves unworkable on the
Cloudflare build, pre-render to a committed HTML artifact in a build step and
say so, rather than porting the renderer to TypeScript.

## Recommended response

Call `render.py` from a build script that emits a JSON manifest of node HTML,
and have the Astro route read that manifest. It keeps one renderer, needs no
Python at request time, and makes the parity test trivial.

## Trade-offs

A build-time manifest means the site rebuilds to reflect a book edit. That is
correct for a book and it is what the EPUB already assumes.

## Free-form response

The route is `/books/build-a-coding-agent/`. Not `/challenges/`, which is the
directory the nodes happen to live in, and not `/books/challenges/`, which
names the pool rather than the book. The repo's own model is explicit about
this: "The collection. Individual books are paths over this pool of nodes."

Annotations from 056 anchor to a document URI, so getting the URL right before
anything is published is cheaper than redirecting later.
