# Collapse /research and /study into /library, /books and /papers

depends-on: 053,057

## Provider

claude

## Goal

Execute [ADR 010](../adr/010-reading-writing-and-the-margin-layer.md): replace
the accidental `/research` and `/study` split with surfaces named for whose
work they hold — `/library` for other people's, `/books` and `/papers` for the
owner's — and put every one of them on the shared `ReadingLayout` that 053
builds, so margin appears on all of them rather than only on the book.

## Observed failure

- `src/pages/research/studio.astro` and
  `src/pages/study/experiments/pdf-to-epub.astro` mount the **same**
  `PublicationImporter` component under the **same** title, "PDF to EPUB".
  Two routes, one page. `/study` was added 2026-08-28, after that component's
  last substantive change on 2026-08-17: a move that was never finished.
- `/research` is hidden on the published site. `src/consts.ts` adds it to the
  nav only when `import.meta.env.DEV` or
  `PUBLIC_RESEARCH_RELEASE === 'staging'`, and `astro.config.ts` drops
  `/research` from the sitemap on the same condition. The surface for
  publishing in public is unlisted in public.
- `/study` holds exactly one route, and it is the duplicate.
- Research papers and blog posts each lay out their own text column, so the
  margin rail from 057 would appear on the book and nowhere else.

## Success criteria

1. **Four** places reach `PublicationImporter`, not two. Three render it
   directly: `src/pages/research/studio.astro`,
   `src/pages/study/experiments/pdf-to-epub.astro`, and
   `src/pages/research/index.astro`. The fourth reaches it one hop away:
   `src/components/research/PdfEpubReviewQueue.tsx` imports and renders it, and
   `src/pages/research/pdf-review.astro` mounts that queue — so after the
   blanket research move, `/papers/pdf-review` is a second importer route even
   once the three direct copies are gone. All of them collapse into **one**
   route under `/library`, including removal from the migrated index;
   otherwise `/papers` keeps an importer and `/library` is not its single home.
   Either move the review workflow under `/library` too, or decouple it from
   `PublicationImporter`. The test asserts the importer is reachable from
   exactly one route and names `/papers/pdf-review` among the routes that must
   not reach it.
   Note which copy is richest before deleting: `studio.astro` carries the only
   link to the 20-paper benchmark at `/research/pdf-review`. Keep it.
2. **Struct's pipeline reaches `/library` too, or ADR 010 narrows.** The ADR
   promises both ingestion paths — the local browser importer and struct's
   higher-quality adapter. Either wire the second one up here with its own
   criterion and test, or amend ADR 010 to promise only the local path. Do not
   leave the ADR claiming a capability no issue delivers.
3. `/library` exists and holds the browser importer as its "add a document"
   path. The importer is kept, not retired: it never uploads the file, which
   is the right property for reading other people's books, even though
   `erniesg/struct`'s adapter produces better extraction and is the deployed
   pipeline for anything else.
4. `/research/*` becomes `/papers/*`, with permanent redirects from every old
   path. **The redirect inventory covers static assets as well as routes**:
   `public/research/` holds the linked paper PDF, EPUB and three images, which
   no route manifest enumerates. Either alias them or move them with
   redirects, and test both.
   **And the redirects have to survive the production release gate.**
   `npm run build` runs `tools/deployment/apply-release-gate.mjs`, which
   recursively deletes `dist/research` after Astro emits it. Redirects written
   under `/research/*` therefore pass a Playwright test against the dev server
   and are still absent from the deployed artifact, turning every old research
   URL into a production 404. This issue updates that gate to keep the
   redirect stubs while still withholding unreleased research, and validates
   the **post-gate `dist/`**, not only the dev route manifest.
5. `/study/*` is removed entirely, with redirects to the library equivalent.
6. The book, papers and blog entry pages all render through `ReadingLayout`
   from 053, **and each carries stable per-block IDs**. Mounting the rail is
   not enough: 056's anchors need a durable `nodeId`, and the blog route
   currently renders `<Content />` with no stable IDs on prose blocks, while
   053 requires ID stability only for book nodes. Round-trip anchoring tests
   cover a paper and a blog entry, not just layout structure.
7. `ResearchStudio.tsx` is migrated onto the margin rail from 057 rather than
   left as a second annotation UI. Its in-memory annotations become margin
   annotations; the annotation bundle export keeps working.
8. Navigation reflects the four surfaces. `NAV_LINKS` is no longer
   conditional on `PUBLIC_RESEARCH_RELEASE` for the existence of the surface.
9. **Whether `/papers` is publicly listed stays a separate switch.** Removing
   the staging gate is an act of publishing and is the owner's call; this
   issue makes the surface exist and keeps the listing behind one flag that
   defaults to its current behaviour.

## Acceptance tests

- Every path under the old `/research/*` and `/study/*` returns a 301 to its
  new location; a test enumerates them from the route manifest **and from
  `public/research/`** so neither a new page nor a new asset can be added
  without a redirect.
- `PublicationImporter` is reachable from exactly one route.
- A paper and a blog entry each expose stable per-block IDs that survive two
  builds of identical source, and an anchor created against one re-resolves.
- `/library`, `/books/build-a-coding-agent`, `/papers/<id>` and a blog post each render
  `ReadingLayout` with a margin mount point present in the DOM.
- The browser importer still converts a PDF end to end from `/library`.
- `ResearchStudio`'s existing annotation tests pass against margin-backed
  storage.
- With the listing flag off, `/papers` is absent from the sitemap and the nav
  but still reachable by direct URL; with it on, it appears in both.

## Definition of done

`/research/studio` is gone, `/study` is gone, every old URL redirects, the
four surfaces share one reading layout, and `ResearchStudio` no longer
carries its own annotation implementation.

## Validation command

```bash
npm test
npm run build
SRT_E2E_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
npx playwright test tests/e2e/ia-redirects.spec.ts tests/e2e/reading-shell.spec.ts
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

`/library`, `/books`, `/papers` routes; deletion of `research/studio.astro`
and the `study/` tree; a redirect table generated from the route manifest;
`ResearchStudio` migrated onto the margin rail; the `/papers` listing flag.

## Stop conditions

Stop before deleting the browser importer — it is superseded on quality, not
on privacy, and `/library` is the reason to keep it. Stop before letting any
old URL 404. Stop before unlisting or listing `/papers` publicly as a side
effect; that switch is the owner's.

## Human clarification protocol

If migrating `ResearchStudio` onto the margin rail turns out to be larger than
the rest of this issue combined, ship the routes and redirects first and file
the studio migration separately rather than blocking the IA on it.

## Recommended response

Do the redirects before the moves. A redirect table generated from the route
manifest, landing first, means the moves cannot silently break a URL and the
test that enforces it exists before there is anything to enforce.

## Trade-offs

Renaming `/research` to `/papers` costs permanent redirects and some external
links pointing at a 301 forever. The alternative is a surface whose name
describes a category ("research") rather than the owner's relationship to the
work, which is the distinction ADR 010 turns on.

## Free-form response

The axis here is whose work it is, not how finished it is. Ongoing research
wants annotation more than finished research does, which is why `/papers`
holds both and visibility — not the URL — carries the difference.
