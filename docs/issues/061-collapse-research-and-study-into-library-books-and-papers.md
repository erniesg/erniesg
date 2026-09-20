# Collapse /research and /study into /library, /books and /papers

depends-on: 053

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

1. `src/pages/research/studio.astro` and
   `src/pages/study/experiments/pdf-to-epub.astro` collapse into **one** route
   under `/library`. Note which is which before deleting: `studio.astro` is
   the *richer* of the two — it carries a back-link to `/research` and a link
   to the 20-paper benchmark at `/research/pdf-review` — while the `/study`
   copy is a stripped version that gained only a `canonicalPath`. Keep the
   benchmark link; it is the only route that points at `pdf-review`.
2. `/library` exists and holds the browser importer as its "add a document"
   path. The importer is kept, not retired: it never uploads the file, which
   is the right property for reading other people's books, even though
   `erniesg/struct`'s adapter produces better extraction and is the deployed
   pipeline for anything else.
3. `/research/*` becomes `/papers/*`, with permanent redirects from every old
   path. No existing URL 404s.
4. `/study/*` is removed entirely, with redirects to the library equivalent.
5. The book, papers and blog entry pages all render through `ReadingLayout`
   from 053. A test asserts each surface produces the same three-column
   structure and the same margin mount point.
6. `ResearchStudio.tsx` is migrated onto the margin rail from 057 rather than
   left as a second annotation UI. Its in-memory annotations become margin
   annotations; the annotation bundle export keeps working.
7. Navigation reflects the four surfaces. `NAV_LINKS` is no longer
   conditional on `PUBLIC_RESEARCH_RELEASE` for the existence of the surface.
8. **Whether `/papers` is publicly listed stays a separate switch.** Removing
   the staging gate is an act of publishing and is the owner's call; this
   issue makes the surface exist and keeps the listing behind one flag that
   defaults to its current behaviour.

## Acceptance tests

- Every path under the old `/research/*` and `/study/*` returns a 301 to its
  new location; a test enumerates them from the route manifest so a new page
  cannot be added without a redirect.
- `/library`, `/books/challenges`, `/papers/<id>` and a blog post each render
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
npx playwright test tests/e2e/ia-redirects.spec.ts tests/e2e/reading-shell.spec.ts
```

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
