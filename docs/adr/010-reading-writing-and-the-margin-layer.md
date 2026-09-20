# ADR 010: Reading, writing, and the margin layer

## Status

Accepted 2026-09-21. Supersedes the implicit `/research` and `/study` split.

## Context

ernie.sg accumulated its surfaces one feature at a time and they no longer
describe anything. The observable state on 2026-09-20:

- `src/pages/research/studio.astro` and
  `src/pages/study/experiments/pdf-to-epub.astro` mount the **same**
  `PublicationImporter` component under the **same** title, "PDF to EPUB".
  The `/study` route was added 2026-08-28, after the component's last
  substantive change on 2026-08-17. It is a half-finished move with the
  original left in place, not a boundary.
- `/research` is hidden in production: `consts.ts` only adds it to the nav
  when `import.meta.env.DEV` or `PUBLIC_RESEARCH_RELEASE === 'staging'`, and
  `astro.config.ts` drops `/research` from the sitemap on the same condition.
  The publishing surface is unlisted on the published site.
- The in-browser PDF-to-EPUB implementation (`PublicationImporter.tsx`, 2068
  lines) has not changed substantively since 2026-08-17, while
  `erniesg/struct`'s `adapters/pdf` was active through 2026-09-05 and beyond
  and is the version deployed on the trusted VM.
- `challenges/` — a finished-enough book with 46 nodes — sits at the
  repository root with no route at all.

The owner's stated need is three activities: annotate books being read, write
books in public, and publish in public.

The mistake in the previous framing was treating those as three *tiers of
completion* and reaching for a finished-versus-draft split. Ongoing research
also wants annotation — a paper in progress is exactly where collaborator
notes matter most. Completion is therefore not the axis.

## Decision

**The axis is whose work it is. Margin is a layer across all of it, not a
feature of one surface.**

Four content surfaces:

- **`/library`** — work by other people that the owner is reading. Documents
  arrive through struct (PDF and other sources to `StructDocument` to
  XHTML/EPUB) and are annotated with margin. Private by default.
- **`/books`** — the owner's books, written in public. `challenges/` is the
  first. Readers highlight, comment, and propose edits.
- **`/papers`** — the owner's research, ongoing and finished alike.
  Collaborators annotate drafts. Replaces `/research`.
- **`/blog`** — posts. Unchanged in kind.

`/study` is dissolved. It holds one route, which is a duplicate.

Two supporting decisions follow:

1. **Visibility, not routing, carries the in-progress dimension.** A draft
   paper and a published one live at the same URL shape. No `/drafts` tier,
   and no route change when something is finished.

   **This requires document-level read authorization, which margin does not
   provide.** Margin's `visibility` governs annotation rows and its allowlist
   governs who may write; neither controls who may read the underlying
   document. Unlisting a paper from the nav and sitemap hides it from
   discovery, not from anyone holding the URL — and issue 061 deliberately
   keeps unlisted papers reachable by direct link. So a draft that is meant
   for collaborators only needs its own read check on the document, enforced
   server-side, before any of this is safe to rely on. Until that exists,
   treat everything under `/papers` as public regardless of listing.

2. **The three-column reading shell is a shared layout**, not something the
   book owns. All four surfaces render text in the middle and margin on the
   right. A surface that cannot use it is a surface that has diverged for no
   reason.

## Consequences

`/research/studio` is deleted outright as a duplicate of
`/study/experiments/pdf-to-epub`. The surviving browser importer moves to
`/library` as the "add a document" path.

The browser importer is **kept, not retired**, despite being superseded by
struct's adapter for quality. It does one thing struct's deployed pipeline
cannot: it never uploads the file. For reading other people's books that is a
property worth keeping, so `/library` offers both paths — local, in-browser,
private; or struct's pipeline for anything that needs the better extraction.

`/research` is unhidden as `/papers`, with redirects from `/research/*`.
Removing the `PUBLIC_RESEARCH_RELEASE` staging gate is a deliberate act of
publishing, and the owner decides when — the redirect and the gate removal are
separable.

The book gets `/books/challenges/`, not a top-level `/challenges/`. Issue #309
was held before dispatch specifically to avoid building the top-level route
and moving it afterwards, because annotations anchored under the old path
would have needed re-anchoring.

Margin's tenancy key `(site, document)` already accommodates four surfaces;
nothing in its data model changes because of this ADR.

## Non-goals

This ADR does not merge the two publication pipelines. `src/publication/`
(TypeScript, adapter-based, vivliostyle renderer, profile matrix) and
`challenges/tools/render.py` (Python, one renderer for web and print) both
remain. Making the book a third `src/publication/` adapter would mean either
porting `render.py` to TypeScript or bridging Python into the Astro build, and
the book's governing rule is that `render.py` is the only thing that emits
block markup. That consolidation deserves its own ADR and its own evidence.

This ADR does not move `challenges/` out of the repository root, change the
EPUB pipeline, or alter `/blog`.

It does not decide when `/papers` becomes publicly listed. It decides only
that the surface exists and is no longer named `/research`.
