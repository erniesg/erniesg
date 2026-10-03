# See all your annotations in a book without opening each page

## Provider

claude

## Prerequisites

Built on #408 (the Map link in the book bar) and #411 (sketches and
`decodeSketch` in `packages/margin`). Both are merged, so it needs no spec
dependency. The later proposal states come from issue 060
(`POST /proposals/:id/apply` still answers 501). Until 060 lands, proposals
are only pending or withdrawn; see criterion 2.

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
   - Each entry shows its kind, the quoted text and the date, plus only the
     fields that kind carries on the wire. Nothing is invented for a missing
     field:
     - highlight: its colour (a highlight has no body);
     - note: its body, and its colour if it has one;
     - sketch: its note text and the preview below;
     - proposal: a short summary of the proposed change and its state (a
       proposal has no colour).
   - A sketch shows a small read-only SVG drawn with `decodeSketch` from
     `packages/margin`. A malformed sketch shows as a plain note, the same
     rule the rail uses.
   - A proposal shows its state, using issue 060's state machine
     (`docs/issues/060-admin-review-apply-and-version-history.md`, item 10):
     pending → "Pending", withdrawn → "Withdrawn", `approved` or `pr_open` →
     "Being applied", `merged` → "Applied", `conflict` or `apply_failed` →
     "Needs attention", `closed` → "Closed". The overview reads the state
     from a `margin:proposalState` field on the annotation response, which
     060 adds for the proposal's author (see 060, item 13). Without that
     field, the state is "Withdrawn" when `margin:withdrawnAt` is set and
     "Pending" otherwise. Until 060 lands only those two can occur, so the
     test for the other states stubs the `/mine` response: rows carrying
     `margin:proposalState` for every 060 state, each shown with its label.
     Producing those rows for real is 060's work, and 060's tests cover it.
   - Replies show under their parent when the parent is also the reader's.
     A reply to **someone else's** note must not pull that note into
     `/mine`, which stays owner-only. The page fetches each such parent
     through the existing visibility-scoped `GET /annotations/:id`, and the
     reply shows under it, marked as someone else's. (A parent cannot become
     invisible to a reply's author: migration 0001's triggers refuse a reply
     to someone else's private note and refuse making a replied-to note
     private.) If the lookup fails, for example offline, the reply shows on
     its own with its link back to the spot.
   - A note the reader deleted while replies still hang from it is kept as a
     tombstone (`margin:deleted`, no body). It shows as "Deleted note", with
     no body, and its replies stay nested under it.
3. **Back to the spot.** Each entry links to its own stored document
   (`target.source`) with `annotation=<id>` added through `URL`
   `searchParams`, so an existing query or fragment survives. That is the
   chapter URL for chapter rows, and the front page, `/map/` or wherever it
   was made for the others. On load, the chapter's margin element
   scrolls to that annotation, focuses it in the rail and highlights its
   anchor. When the anchor no longer resolves because the text changed, the
   rail says so and still shows the annotation. The overview marks it as
   "text changed".
4. **Book bar.** An "Annotations" link sits next to "Map" in both the Site and
   Plain looks. It is shown only to signed-in readers.
5. **Empty and signed-out states.** Signed out (`/auth/me` reports no
   principal), the page shows "Sign in to see your annotations" with a link
   to `/auth/login?return_to=<this page's path>`. The Worker already accepts
   and sanitises `return_to`. No such prompt exists elsewhere yet, so this
   one is new. Signed in with no annotations, it says so and points to the
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
  - rows on another site, or outside the prefix, are excluded;
  - `EXPLAIN QUERY PLAN` for the `/mine` query (first page and a cursor
    page) uses `margin_annotations_owner` and never scans
    `margin_annotations`, following `pagination-plan.test.ts`.
- `tests/e2e/margin-annotations-overview.spec.ts`, with the same in-process
  router pattern as `tests/e2e/margin-edit-mode.spec.ts`, served from the
  static build through `installStaticRoutes` (as `book-look.spec.ts` does):
  - seed a highlight on one chapter, a note and a sketch on another, and a
    proposal; each shows only the fields its kind carries (no body on the
    highlight, no colour on the proposal);
  - the overview lists all four under the right chapters in book order;
  - a note on the book's front page appears under "Book front page", and a
    note on another non-manifest path under the prefix under "Other pages";
  - the reader's reply to their own note shows nested under it;
  - a reply to another reader's public note shows under that note, marked as
    theirs; when that parent lookup fails (the route answers 500), the reply
    shows on its own with its link;
  - a note whose body starts with the sketch prefix but does not decode shows
    as a plain note, and a valid sketch shows its preview;
  - proposals show "Pending" and, once withdrawn, "Withdrawn"; a stubbed
    `/mine` response with `margin:proposalState` set to each 060 state shows
    each mapped label (criterion 2);
  - a deleted note with a reply shows as "Deleted note" with the reply
    nested under it;
  - a note made on `/books/<slug>/map/` links back to `/map/?annotation=<id>`,
    and one whose stored source is `/books/<slug>/map/?view=all#topic` links
    to `/books/<slug>/map/?view=all&annotation=<id>#topic`: the existing
    parameter and the fragment both survive;
  - signed out, the prompt links to `/auth/login?return_to=` this page;
    signed in with no annotations, the page says so and links to the first
    chapter;
  - clicking one lands on the chapter with that annotation focused in the
    rail;
  - an annotation whose quote no longer matches shows "text changed" in both
    places;
  - the Annotations link appears in both looks when signed in, and not when
    signed out;
  - with more rows than the endpoint's page cap (seed the cap plus a few),
    every row appears: the overview follows `nextCursor` to the end;
  - the kind filter shows only the chosen kind, the chapter filter only the
    chosen chapter's group, and clearing both brings every row back.

## Definition of done

Every clause of every success criterion is covered by at least one
acceptance case above, the PR body lists that mapping clause by clause, and
the validation command exits 0 on a clean tree. Screenshots of the overview are attached to
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
- Stop before `/mine` returns any annotation the viewer did not create.
  Showing a foreign parent fetched through the visibility-scoped
  `GET /annotations/:id` (criterion 2) is not listing it.
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
