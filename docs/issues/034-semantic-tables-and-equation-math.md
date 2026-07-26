# Emit semantic tables and source-derived math instead of defaulting to rasters

depends-on: 013,024,032,033

## Provider

vm-codex

## Goal

Close the gap between the specified scientific-object contract and what the pipeline actually emits. Specs 013 and 032 require semantic HTML tables when aligned structure validates and MathML when it is recoverable from source semantics, with a bounded source-backed raster only as the fallback. In practice the fallback is the default: on real scholarly papers almost every table is exported as an image and every display equation is exported as a raster or text-derived SVG. A rasterized table does not reflow on a 6-inch e-ink page, does not scale with reader font size, and is not selectable, searchable, or accessible — which defeats the purpose of a device-profile EPUB.

## Observed baseline

Owner-local audits over six public scholarly papers recorded `semanticTableCoverage` of `0` on three documents that each declare multiple expected semantic tables, `0.189` on another, and `1` only where no table existed. Across eight further papers, 3 of 31 expected semantic tables (9.7%) reached the reader as semantic markup; 19 shipped as raster crops and 9 were unresolved. Separately, no MathML emission path exists anywhere in the pipeline: the only MathML references in the codebase are tests asserting that MathML is *not* invented, and the equation path chooses between a native rendition, a text-derived SVG, and a page-crop raster. Over the same eight papers, 132 display equations shipped as raster crops and 137 carried no rendition at all.

## Diagnosed cause: no general proven-scope-to-grid promoter

Scope resolution is **not** the blocker. Over 27 table captions in that corpus, 23 resolved a bounded scope (17 `text-tabular-line-band`, 5 `text-nonuniform-grid`, 1 `caption-bounded-text-slab`); only 4 failed with `no-proven-scope`. Yet **20 of those 23 proven scopes produced no grid from any detector** and fell through to the raster path.

The reason is that both proven-scope detectors are narrow special cases rather than a general promoter:

- `detectTableWithinProvenScope` returns `null` immediately unless the scope carries the `supplemental-equation-cell-shard` evidence code. It exists for tables containing equation cells.
- `detectHierarchicalTableWithinProvenScope` returns `null` unless the scope direction is `above` and carries `multi-run-tabular-line-band`, and additionally requires a two-tier header with the body starting at exactly row index 2, at least five rows, a header-like first cell, and every remaining body cell numeric. It matches one table shape.

A proven scope already carries exactly what a grid builder needs — the exact source region lineage and the exact non-empty source line ids of the table. Nothing consumes that in the general case, so an ordinary well-formed scholarly table with a single header row and mixed body cells has no path to semantic markup at all. Closing this is the highest-ranked promotion blocker and should be the first work item.

A wrong semantic table is worse for a reader than a correct image, so the promoter must fail closed to the existing raster path whenever rectangularity, header scope, or per-cell provenance cannot be proved.

## Acceptance tests

- A general promoter turns any proven table scope into a grid without depending on `supplemental-equation-cell-shard` or `multi-run-tabular-line-band` evidence, without requiring a two-tier header, and without requiring a fixed body-start row index. It consumes exactly the scope's proved source region lineage and non-empty source line ids, and it claims every one of them or promotes nothing.
- The promoter fails closed to the existing bounded raster path whenever rectangularity, header scope, or per-cell source provenance cannot be proved. A partially proved grid is never emitted. The two existing narrow detectors keep their current behaviour and are not weakened to make room for the general path.
- The audit reports, per document, how many tables reached the reader as semantic markup, as a bounded raster fallback, and as unresolved, and the same three-way split for display equations. The counts are exact and reconcile with the packaged asset manifest.
- A table whose aligned multi-row/multi-column structure validates is emitted as semantic HTML with typed header scope, preserved cell order, and per-cell source provenance. A structure that does not validate keeps the existing bounded raster fallback; neither path invents a cell, a header, or a span.
- The gap between "structure detected" and "structure promoted to semantic" is itself measured. Where a detector proves a grid but promotion fails, the blocking reason is recorded as a named diagnostic rather than an unexplained fallback, so the dominant promotion blockers on real papers are visible and rankable.
- MathML is emitted only when operator containment, script nesting, and ordered baselines are proved from source geometry, per the failure taxonomy. An unproved formula keeps its bounded source-backed asset and stays review-required. No LaTeX, MathML, variable, or equation number is ever invented, and an equation's visible label and source order are preserved either way.
- Semantic tables and MathML survive the reflow contract: they consume canonical reading order, reflow within the Mobile and both e-ink profiles without horizontal overflow, and carry their caption relationship and canonical position.
- Browser coverage proves a semantic table reflows and remains readable at the narrowest supported profile, and that a rasterized fallback is explicitly labelled as a fallback rather than presented as equivalent.
- Repeated reconstruction produces byte-identical semantic table structure, MathML, and asset hashes.

## TDD sequence

1. **Red:** extend `src/research/semantic-table.test.ts`, `src/research/pdf-table-detection.test.ts`, and `src/research/epub.test.ts` with generated fixtures covering a validating grid, a non-validating grid, and a display equation with provable structure. Preserve failures for the missing three-way audit split, the unexplained promotion failure, and the absent math path.
2. **Green:** add the audit instrumentation first so the promotion blockers are measurable, then close the highest-ranked blocker. Do not relax `isStrictSemanticTable`; a table that is not rectangular with proved header scope must keep failing closed.
3. **Red then green:** add the math emission path behind proved source geometry, with the existing "never invent" assertions kept intact.
4. **Refactor:** share the semantic materializer between preview and export only after provenance, ordering, and byte-stability assertions pass.

## Exact-head definition of done

- The audit publishes the semantic/raster/unresolved split for tables and equations on every document, and the dominant promotion blockers are named diagnostics.
- At least the top-ranked promotion blocker is closed, with the coverage change demonstrated on owner-local papers and no widened threshold.
- No test asserting that LaTeX or MathML is never invented is weakened or removed.
- From a clean checkout of the immutable PR head, `scripts/agent-evidence --all` records `commit` equal to that head, `dirty: false`, and `result: passed`.

## Validation command

```bash
npx vitest run src/research/semantic-table.test.ts src/research/semantic-table-source.test.ts src/research/pdf-table-detection.test.ts src/research/pdf-table-fallback.test.ts src/research/epub.test.ts
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts
```

## Allowed secrets

None. Source papers and rendered evidence remain owner-local.

## Artifact outputs

A general proven-scope-to-grid promoter, a three-way semantic/raster/unresolved audit split, and named promotion-blocker diagnostics.

## Stop conditions

Stop before relaxing isStrictSemanticTable, inventing MathML or LaTeX, or emitting a partially proved grid to raise a coverage number.

## Human clarification protocol

If a proposed grid verifies structurally but a cell's text cannot be matched to source runs, confirm that the whole table falls back rather than promoting partially.

## Recommended response

Add the audit split first so promotion blockers are rankable, then close the highest-ranked blocker rather than guessing which detector to widen.

## Trade-offs

A wrong semantic table is worse for a reader than a correct image, so the promoter must fail closed to the existing bounded raster path.

## Free-form response

Rasterized tables do not reflow on a six-inch page, do not scale with reader font size, and are not selectable or accessible, which defeats the purpose of a device-profile EPUB.
