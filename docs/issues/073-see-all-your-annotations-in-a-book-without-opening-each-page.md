# See all your annotations in a book without opening each page

## Provider

claude

## Prerequisites

Built on #408 (the Map link in the book bar) and #411 (sketches and
`decodeSketch` in `packages/margin`). Both are merged, so it needs no spec
dependency. The "applied" proposal state needs issue 060
(`POST /proposals/:id/apply` still answers 501). Until 060 lands, proposals
show only pending or withdrawn; see criterion 2.

## Goal

The owner wants every highlight, note, sketch and edit proposal they have made
in a book in one place, without opening chapters one by one to find them
(asked 2026-10-03). Each book gets an Annotations page, linked from the book
bar next to Map. It lists the signed-in reader's own annotations, grouped by
chapter in book order, and each entry links back to its exact spot.

## Observed failure

- `GET /api/margin/v1/annotations` lists one page only. Without `source`, or
  `site` and `document`, it answers 400 `missing_scope`
  (`readScope` in `src/worker/margin/routes.ts`). `GET /proposals` uses the
  same scope.
- No page or endpoint lists a reader's annotations across a site or a book.
  The only way to find one is to open the chapter it is on.

## Success criteria

1. **Endpoint.** `GET /api/margin/v1/mine?site=<origin>&prefix=<path>` returns
   the signed-in viewer's own annotations (private and public, every
   motivation), whose `document` is on `site` and whose path starts with
   `prefix`. They come back in the existing `present()` shape, ordered by
   `(document, created, id)`, with the existing page cap.
   - **The cursor carries `document` as well as `created` and `id`.** The
     existing cursor holds only `{created, id}` (`repository.ts`), and with
     a document-first order it would skip older rows in a later document.
     The seek is `(document, created, id) > (?, ?, ?)`.
   - Signed out: 401. It never returns another creator's row, whatever its
     visibility.
   - `prefix` must be an absolute path that starts and ends with `/`.
     Anything else is 400.
   - The query uses the existing `margin_annotations_owner` index
     `(creator, site, document)`. No migration.
2. **Page.** `/books/<slug>/annotations/` is a static page that fetches item 1
   with `prefix=/books/<slug>/`.
   - Chapters are grouped and ordered by the book manifest, not by URL.
   - Rows on pages that are not manifest nodes are still shown. The prefix
     also matches the book's front page (`/books/<slug>/`), which mounts the
     rail too. Those rows go in a "Book front page" group first, and any
     other non-manifest path under the prefix goes in a final "Other pages"
     group. None is dropped.
   - Each entry shows its kind (highlight, note, sketch, proposal), the quoted
     text, the note body, the colour and the date.
   - A sketch shows a small read-only SVG drawn with `decodeSketch` from
     `packages/margin`. A malformed sketch shows as a plain note, the same
     rule the rail uses.
   - A proposal shows its state: pending or withdrawn. It shows "applied"
     too once issue 060 records that state; until then nothing can be
     applied.
   - Replies show under their parent when the parent is also the reader's.
     A reply to **someone else's** note must not pull that note into
     `/mine`, which stays owner-only. The page fetches each such parent
     through the existing visibility-scoped `GET /annotations/:id`. If the
     parent is visible, the reply shows under it, marked as someone else's.
     If it is not, the reply shows on its own as "Reply to a note you can no
     longer see", with its link back to the spot.
3. **Back to the spot.** Each entry links to
   `<chapter URL>?annotation=<id>`. On load, the chapter's margin element
   scrolls to that annotation, focuses it in the rail and highlights its
   anchor. When the anchor no longer resolves because the text changed, the
   rail says so and still shows the annotation. The overview marks it as
   "text changed".
4. **Book bar.** An "Annotations" link sits next to "Map" in both the Site and
   Plain looks. It is shown only to signed-in readers.
5. **Empty and signed-out states.** Signed out, the page shows the existing
   sign-in prompt. Signed in with no annotations, it says so and points to the
   first chapter.
6. Filters on the page, client-side only: kind (highlight, note, sketch,
   proposal) and chapter. Nothing new is stored.

## Acceptance tests

- Worker unit tests (`src/worker/margin`) against `SqliteD1Database` built
  from every migration:
  - `/mine` returns only the viewer's rows across several documents, in
    order, with pagination, including a page boundary that falls between
    two documents (no row skipped or repeated);
  - another creator's private and public rows are excluded;
  - 401 when signed out, 400 on a bad `prefix`;
  - rows on another site, or outside the prefix, are excluded.
- `tests/e2e/margin-annotations-overview.spec.ts`, with the same in-process
  router pattern as `tests/e2e/margin-edit-mode.spec.ts`, served from the
  static build through `installStaticRoutes` (as `book-look.spec.ts` does):
  - seed a highlight on one chapter, a note and a sketch on another, and a
    proposal;
  - the overview lists all four under the right chapters in book order;
  - a note on the book's front page appears under "Book front page";
  - a reply to another reader's public note shows under that note, and a
    reply whose parent is private to someone else shows as "Reply to a note
    you can no longer see";
  - clicking one lands on the chapter with that annotation focused in the
    rail;
  - an annotation whose quote no longer matches shows "text changed" in both
    places;
  - the Annotations link appears in both looks when signed in, and not when
    signed out.

## Definition of done

Every success criterion is covered by a passing test, and the validation
command exits 0 on a clean tree. Screenshots of the overview are attached to
the PR at 390 px and 1280 px, with no horizontal overflow at 390 px (070).

## Validation command

```bash
npm run test:margin
npx vitest run src/worker/margin
npm test
npm run build
if [ -f tools/e2e-port.mjs ]; then SRT_E2E_PORT=$(node tools/e2e-port.mjs) || exit 1; else SRT_E2E_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()') || exit 1; fi; [ -n "$SRT_E2E_PORT" ] || exit 1; export SRT_E2E_PORT
# The static-build lane: astro dev often times out on a cold worktree (.agent/verify.md).
SRT_STATIC_BUILD_DIR=dist npx playwright test tests/e2e/margin-annotations-overview.spec.ts
```

## Concurrency

This repository runs multiple issue workers on one host. Any command that
binds a port must choose it per run (set `SRT_E2E_PORT` as above, never a
fixed `8787`, `4321` or `1234`), and any temporary path must be unique per
worker.

## Allowed secrets

None.

## Artifact outputs

The `/mine` endpoint, the per-book Annotations page, `?annotation=<id>` deep
links into the rail, and the book-bar link.

## Stop conditions

- Stop before adding a migration or a new table.
- Stop before listing any annotation the viewer did not create.
- Stop before adding a cross-book or cross-site view.
- Stop before building the page on the server at request time; it stays a
  static page that fetches the API.

## Human clarification protocol

If the margin element has no way to focus one annotation by id, add
`?annotation=<id>` handling to it rather than scrolling from outside the
element, and say so in the PR. If `present()` lacks a field the overview needs
(for example the chapter title), take it from the book manifest on the page,
not by widening the API.

## Recommended response

Add `listOwnAnnotationsQuery(site, prefix, creator, page)` beside
`listAnnotationsQuery` in `src/worker/margin/queries.ts`. Use
`creator = ? AND site = ? AND document >= ? AND document < ?`, with the
prefix's upper bound made by incrementing its last character, so the
`margin_annotations_owner` index serves it, and order by
`(document, created, id)`. Route it as `GET /mine` in `routes.ts` with the
existing `readPage` and `encodeCursor`. The page is an Astro route,
`src/pages/books/[book]/annotations.astro`, beside 408's `map.astro`, with a
small client script that pages through `/mine` and renders it.

## Trade-offs

- **Own annotations only.** Others' public annotations stay on their pages.
  A "public notes by others" view is a separate decision.
- **Per book, not per site.** The prefix keeps the query and the page small.
  A site-wide "all my annotations" can reuse `/mine` later with a wider
  prefix.
- **Ordering:** the endpoint orders by document, and the page re-orders by
  the manifest. So the API does not need to know book structure.

## Free-form response

The data is already per owner and indexed by owner. This is a listing and a
link back, not a new store.
