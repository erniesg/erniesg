# Make STRUCT the only contract between extraction and rendering

depends-on: 027,038

## Provider

vm-codex

## Goal

Complete the source-agnostic STRUCT package started in `src/struct/` so that every renderer (EPUB, HTML preview, future paged output) consumes only `StructDocument`, every extractor (PDF today, DOCX/HTML adapters later) produces one, and the package's receipts make any conversion reproducible and diffable — independent of `ResearchPaper`, paper IDs, and the PDF extractor's private types.

## Observed failure

Rendering code reaches directly into the PDF reconstruction's private implementation details, so every extraction fix risks renderer breakage and no second source format can be added without duplicating the renderer. The extraction boundary exists as types (`src/struct/types.ts`, schema 0.1.0) with a partial adapter (`from-reconstruction.ts`), but the EPUB and importer paths still consume the reconstruction directly; STRUCT is currently a bystander, not a contract. Paper-specific patches accumulate because there is no neutral graph at which to aim a general fix.

## Acceptance tests

- `renderPublicationXhtml` and the EPUB build path consume `StructDocument` (blocks, assets, relationships, page layouts, diagnostics, recovery, receipt) with no imports from the PDF extractor's private modules; the type checker enforces the boundary.
- `from-reconstruction.ts` covers the full reconstruction surface: every node, visual relationship, note, citation, annotation, and unresolved object maps to a STRUCT block, asset, relationship, or accounted diagnostic — with a conservation test proving nothing is dropped in conversion (counts and text mass reconcile).
- Stable STRUCT IDs are deterministic functions of source content and position, not of extractor run order; converting the same source twice yields byte-identical graphs and identical `receipt.generatedSha256`.
- The receipt records schema version, source hash, and counts such that two receipts differing implies a real difference; a golden-receipt regression test pins the fixture corpus.
- The package has no dependency on `ResearchPaper`, paper IDs, or Astro modules; a dependency-direction test (or lint rule) fails if one is introduced.
- Fixture regression spans document shapes: born-digital and scanned, one- and two-column, raster and vector visuals, semantic and ambiguous tables, equations, notes, and internal/external links — each shape round-tripping source → STRUCT → EPUB with its invariants asserted.
- `skills/struct-typeset/SKILL.md` still describes the landed behavior after the change; its validation commands run green as written.

## TDD sequence

1. **Red:** conservation test over the current adapter exposing what `from-reconstruction` drops; boundary test exposing renderer imports of extractor internals.
2. **Green:** complete the adapter; move the EPUB path onto `StructDocument`, narrowest surface first (recovery and diagnostics are already consumed — visuals, notes, then flow).
3. **Red then green:** determinism and golden-receipt tests; dependency-direction rule.
4. **Refactor:** delete renderer-side reconstruction imports once every consumer compiles against STRUCT alone.

## Exact-head definition of done

- No renderer file imports the PDF extractor's private modules; conversion is byte-stable; conservation and golden-receipt tests pin the fixture corpus; the skill document matches reality.
- From a clean checkout of the immutable PR head, `scripts/agent-evidence --all` records `commit` equal to that head, `dirty: false`, and `result: passed`.

## Validation command

```bash
npx vitest run src/struct/struct.test.ts src/research/epub.test.ts src/research/epub-source-fallback.test.ts
npm test
npm run build
```

## Allowed secrets

None.

## Artifact outputs

A complete reconstruction→STRUCT adapter with conservation proof, renderers consuming only STRUCT, deterministic IDs and receipts with golden regression, a dependency-direction guard, and an updated skill document.

## Stop conditions

Stop before changing extraction behavior in the same PR (this is a boundary move, not an extraction fix), breaking byte-stability, or leaving a renderer with a private-module import "temporarily".

## Human clarification protocol

If moving a consumer onto STRUCT would change rendered output rather than merely rerouting it, stop and report the delta with evidence instead of absorbing it silently.

## Recommended response

Move consumers one stratum at a time with a conservation test at each step; a big-bang cutover of a 25,000-line surface is how regressions hide.

## Trade-offs

The adapter duplicates some shape information during the transition, costing memory and a temporary parallel path, but it buys the one thing paper-specific patching can never produce: a fixed target that generalises.

## Free-form response

Every other open extraction issue lands its result in this graph; the sooner the graph is the only contract, the sooner a fix for one paper is automatically a fix for all of them.
