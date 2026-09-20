# Publish the challenges book on ernie.sg with one renderer and a three-column shell

## Provider

claude

## Goal

Put `challenges/` on the web. Today the book exists only as an EPUB and a
localhost Python server whose own docstring says it is "a local preview of the
node format, not the published site." Nothing in `src/pages/` references it.
Every later issue in this series (054-060) annotates, comments on, or proposes
edits to book pages that do not yet exist at a URL.

The constraint that decides this issue: `challenges/tools/render.py` stays the
only thing that emits block markup. Astro wraps its output; Astro does not
re-implement it. The moment a second renderer exists the web and EPUB editions
drift and the reader sees two different books.

## Observed failure

- `challenges/` is absent from `src/pages/`, `astro.config.ts` and the build.
  `npm run build` produces no book page.
- `preview.py` renders on every request from disk and binds to localhost. It is
  a reading tool, not a publishing path, and it grades by running reader code
  in local subprocesses, which cannot happen on a static host.
- `main` carries no `/challenges/` route, so a highlight or comment has no
  document URI to anchor to and no origin to be same-origin with.

## Success criteria

1. `render.py` is invoked at build time and its HTML is embedded verbatim.
   A byte-comparison test asserts the block markup for a given node is
   identical between the Astro build output and `render_node` called directly.
   Any divergence fails the build.
2. Routes: `/challenges/` (the path index, with the topic map) and
   `/challenges/<node-id>/` for all 46 nodes, generated from
   `load_book()` + `all_nodes()`, not from a hand-maintained list.
3. The page shell is three columns at desktop width: table of contents, book
   text, and an empty margin column reserved for 056-060. The margin column
   renders as an empty landmark with a stable mount point; it must not shift
   the text column when populated later.
4. Below 1280px the margin column collapses, matching the existing
   `preview.py` breakpoint behaviour for `.rail`.
5. Every node page carries a stable document URI and, where the node has
   struct-addressable blocks, per-block stable IDs in the DOM. These are the
   anchor targets 056 depends on; a block whose ID changes between two builds
   of identical source fails the test.
6. Runnable cells and the grader are out of scope. Where the EPUB shows a
   listing, the web shows a listing. Interactive execution is a later issue.
7. The EPUB build is unchanged: `challenges/dist/*.epub` stays
   EPUBCheck-clean and byte-stable for unchanged source.

## Acceptance tests

- A test renders `ch12-hash-maps` through the Astro build and through
  `render_node` and asserts the block markup matches exactly.
- A test builds twice from unchanged source and asserts every per-block DOM ID
  is identical across the two builds.
- A test asserts all 46 node routes are emitted and that the count comes from
  `all_nodes()`.
- A Playwright test asserts three columns above 1280px and two below, with no
  horizontal page scroll at 375px.

## Definition of done

`npm run build` emits `/challenges/` and 46 node pages; the renderer-parity
test passes; the ID-stability test passes; EPUBCheck is clean; no second
renderer exists anywhere in `src/`.

## Validation command

```bash
python3 challenges/tools/validate.py
npm run build
npm test
npx playwright test tests/e2e/challenges-shell.spec.ts
```

## Allowed secrets

None.

## Artifact outputs

Astro routes for the book; a build-time bridge that calls `render.py`; the
three-column shell with a reserved margin mount point; renderer-parity and
ID-stability tests.

## Stop conditions

Stop before re-implementing any block markup in TypeScript, before
hand-listing node IDs, and before changing `render.py`'s output to suit the
web target. If the web needs something the renderer does not emit, add it to
`render.py` behind the existing web/print target switch so print stays in sync.

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

Parts III-IX are 22 topics still to come, so this shell will take new nodes
continuously. Generating routes from `all_nodes()` rather than a list is what
makes that free.
