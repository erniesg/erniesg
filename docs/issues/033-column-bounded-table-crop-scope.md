# Bound table crop scopes to their own column lane

depends-on: 013,025,032

## Provider

vm-codex

## Goal

Stop the line-band table scope from unioning two page columns into one crop. On a multi-column page the neighbouring column's body prose shares row coordinates with a table, so grouping candidate lines by `y` alone produces a crop box spanning the whole text measure. The exported raster then bakes neighbouring prose and section headings into the table image, and the same prose is also emitted as reflowable text, so the reader sees it twice — once live, once as a picture.

## Observed failure

An owner-local run over a public two-column paper produced a `text-tabular-line-band` scope whose crop box was `x=0.12101 y=0.07296 w=0.75121 h=0.11286` on a page whose table occupies only `x>=0.527`. Its proved line lineage contained both the right-column table lines and two left-column body-prose regions. A second table on the same document produced `x=0.10701 w=0.7969`, baking a section heading and three prose lines into the raster. A third, genuinely page-spanning table on the same document cropped correctly, so the defect is specific to per-column tables.

## Acceptance tests

- A candidate line set that contains a vertical corridor which no candidate line crosses, whose width and centre are consistent with a page gutter, and whose two sides the region classifier independently reads as opposite columns, never produces one row, one band, or one crop box spanning that corridor.
- A genuinely page-spanning table whose cells tile across the gutter keeps banding as one lane and retains its existing full-measure crop box, source lineage, and asset identity. Column lane separation may not be inferred from `region.column` alone, because a spanning table's cells carry mixed `left`/`right`/`span` labels by x position.
- Each column lane bands independently. Interleaving two columns' rows by `y` and banding the merged sequence may neither union the columns nor shatter both into single rows.
- A per-column table whose own lane proves a band exports a crop box contained in that lane, with no source line from the opposite column in its lineage.
- A per-column table whose own lane cannot prove a band remains review-required with bounded candidate evidence. It is never exported with an opposite-column crop, and the metric change is visible in the audit rather than silently absorbed.
- A regression fixture reduced from the observed page geometry — faithful bounding geometry, synthetic text, no bytes or prose copied from any source paper — reproduces the gutter-crossing scope before the fix and a lane-bounded scope after it.
- Repeated reconstruction of the same source produces byte-identical scope ids, crop boxes, and packaged asset hashes.

## TDD sequence

1. **Red:** add a fragmented two-column fixture to `src/research/pdf-table-scope.test.ts` whose right-column table splits into many single-line regions so the grid detector cannot own it and the line-band fallback runs. Preserve the failure proving the resolved scope claims the left-column prose regions.
2. **Green:** prove the separating gutter from the candidate lines, assign lanes geometrically, and band each lane independently. Do not widen or relax an existing proof threshold.
3. **Red then green:** confirm on an owner-local named paper that the per-column table crop becomes lane-bounded, the page-spanning table is unchanged, and text coverage does not regress.
4. **Refactor:** only after scope, detection, fallback, integration, and visual suites pass unchanged.

## Exact-head definition of done

- The named-paper per-column table exports a crop containing only its own column; the page-spanning table on the same document is byte-identical to its accepted baseline.
- No suite is skipped, no locator relaxed, and no threshold widened to accept the new geometry.
- Any table that loses its export because its own lane cannot prove a band is reported as review-required with its diagnostic code, not silently dropped.
- From a clean checkout of the immutable PR head, `scripts/agent-evidence --all` records `commit` equal to that head, `dirty: false`, and `result: passed`.

## Validation command

```bash
npx vitest run src/research/pdf-table-scope.test.ts src/research/pdf-table-scope-integration.test.ts src/research/pdf-table-detection.test.ts src/research/pdf-table-fallback.test.ts src/research/pdf-visuals.test.ts
npm test
npm run build
```

## Allowed secrets

None. Source papers, rasters, and audit output remain owner-local.

## Artifact outputs

Column-lane gutter proof in the table scope resolver, lane-independent banding, and a two-column regression fixture with faithful geometry and synthetic text.

## Stop conditions

Stop before widening a scope proof threshold, keying lanes off region.column labels alone, or accepting an opposite-column crop to preserve an export count.

## Human clarification protocol

If a per-column table cannot prove a band within its own lane, confirm whether review-required is preferred over an opposite-column crop; this issue assumes it is.

## Recommended response

Prove the gutter geometrically from candidate lines rather than trusting classifier labels, because a spanning table's cells carry mixed left/right/span labels by x position.

## Trade-offs

Lane separation loses exports for tables whose own lane cannot prove a band; that is a smaller harm than shipping a raster containing a neighbouring column's prose.

## Free-form response

A reader seeing body prose baked into a table image, duplicated against the same prose as live text, loses trust in every other object on the page.
