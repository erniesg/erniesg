<!-- rucksack-autopilot-provider:vm-codex -->
<!-- rucksack-autopilot-depends-on:026,029,030 -->

# Review every rendition and apply scoped editorial locks

depends-on: 026,029,030

## Provider

vm-codex

## Goal

Give an editor one truthful preview matrix for Astro and Payload publications: trace a semantic node through every rendered profile, inspect transformations and hard/soft evidence, and apply only versioned planner choices without turning the publication into target-specific page coordinates.

## Acceptance tests

- The matrix consumes `PublicationBundle`, `LayoutPlan`, renderer probes, checked artifacts, and receipts produced by issues 029 and 030; it does not independently reinterpret source nodes or estimate output geometry.
- Selecting a source node highlights its output anchors in phone WebPub, monochrome e-ink EPUB, A5 PDF, and A4 PDF and shows the selected representation, transformation reasons, profile/policy versions, hard-gate result, and soft trade-offs before raw renderer diagnostics.
- Astro and equivalent Payload fixtures use the same matrix components and output-adapter identifiers. Missing, failed, or stale artifacts show a bounded unavailable state instead of a synthetic preview.
- A strict `EditorialLock` names graph hash, canonical node id, profile id/version, policy version, transformation family, and one choice already enumerated by the planner. It contains no coordinates, CSS, source text, binary data, arbitrary patch, or source-adapter branch.
- Applying a lock reruns planning, renderer probe, production validation, and receipt generation. It may select among eligible choices but cannot suppress a hard violation, change canonical reading order, omit required content, or authorize an unauthored summary/crop.
- A changed graph/profile/policy or missing candidate reports `STALE_EDITORIAL_LOCK`; it is never rebound by list position. Removing the lock restores deterministic standing policy.
- Keyboard and screen-reader flows can select a node, move between the four outputs, read transformation/violation summaries, apply or remove a legal lock, and return focus to the same source node.
- Browser coverage locks one figure full-span only in A4, proves phone/e-ink/A5 plans and bytes remain unchanged, verifies the regenerated A4 receipt and geometry, and exercises a stale lock plus a no-eligible-plan state.
- New files to add: `src/publication/editorial-lock.ts`, `src/publication/editorial-lock.test.ts`, `src/components/publication/PublicationPreviewMatrix.tsx`, `src/components/publication/PublicationPreviewMatrix.test.tsx`, `src/components/publication/publication-preview-matrix.css`, and `tests/e2e/publication-preview-matrix.spec.ts`.

## TDD sequence

1. **Red:** create the lock and matrix component tests, run `npx vitest run src/publication/editorial-lock.test.ts src/components/publication/PublicationPreviewMatrix.test.tsx`, and preserve failures for legal choices, forbidden patches/coordinates, scope/version/hash mismatches, stale candidates, hard-gate bypass, accessibility, and focus return.
2. **Green:** implement only the strict lock codec/applier, source-neutral receipt selectors, and accessible checked-artifact matrix needed for those tests.
3. **Red then green:** add the A4-only browser journey, generate both source matrices, and wire lock application through replan, renderer probe, production validation, and receipt regeneration while comparing the other three artifact hashes.
4. **Refactor:** extract source-neutral navigation/focus management only after stale-lock and no-eligible-plan browser cases pass; then regenerate/check both matrices and run full validation.

## Exact-head definition of done

- The matrix displays only checked artifacts/receipts, legal locks cannot override a hard gate or mutate canonical content, and profile isolation plus stale behavior is proven at the exact PR head.
- Schema/component/browser tests, four-output checks, normal build, and exact-head evidence pass for Astro and Payload fixtures with no skipped accessibility or failure state.
- Locks contain no coordinates, CSS, source/artifact bytes, secrets, source-CMS branch, or implicit model choice; unsupported artifacts remain explicitly unavailable.
- From a clean checkout of the immutable PR head, the canonical evidence manifest records `commit` equal to that head, `dirty: false`, `result: passed`, and every required lane; a post-lane clean-worktree check proves validation did not modify tracked or generated source files.
- The Astro and Payload matrices are generated before browser review; their receipts bind source/graph hashes, locks, profile/policy/planner/probe/toolchain versions, and all four artifact hashes to that exact head, while untouched-profile hashes remain byte-identical after an A4-only lock.

## Validation command

```bash
npx vitest run src/publication/editorial-lock.test.ts src/components/publication/PublicationPreviewMatrix.test.tsx
npm test
npm run build
npm run publication:build -- --adapter astro --entry moving-to-cloudflare-with-astro --planner semantic-v1 --output .agent/evidence/publication-matrix/astro
npm run publication:check -- --input .agent/evidence/publication-matrix/astro --matrix phone-webpub,eink-epub,a5-pdf,a4-pdf
npm run publication:build -- --adapter payload --input tests/fixtures/payload/publication.json --mapping tests/fixtures/payload/mapping.json --planner semantic-v1 --output .agent/evidence/publication-matrix/payload
npm run publication:check -- --input .agent/evidence/publication-matrix/payload --matrix phone-webpub,eink-epub,a5-pdf,a4-pdf
npm run test:e2e -- tests/e2e/publication-preview-matrix.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. Source content, artifacts, locks, and review state remain local.

## Artifact outputs

Versioned editorial-lock schema/applier, source-to-output preview matrix, accessible comparison and evidence UI, stale/failed states, regenerated receipts, and browser evidence across Astro and Payload fixtures.

## Stop conditions

Stop before adding a coordinate/page editor, letting a lock bypass static or measured hard gates, embedding source or artifact bytes in lock files, branching UI behavior by source CMS, or presenting an unvalidated browser mock as a final PDF/EPUB preview.

## Human clarification protocol

When standing policy leaves several eligible material choices, show their rendered evidence and affected profiles, recommend the smallest scoped lock, and ask which choice should be persisted.

## Recommended response

Treat the matrix as an evidence and policy interface over compiled artifacts: editors choose among legal plans, while the compiler remains responsible for semantic preservation and geometric validation.

## Trade-offs

Editors cannot drag arbitrary boxes or tune one line break. That constraint keeps locks replayable across content changes and future renderers, while scoped profile-specific choices preserve meaningful art direction.

## Free-form response

This issue is the mixed-initiative product surface. Model-proposed layouts may be added later as clearly attributed candidate plans, but no model suggestion becomes a lock or final artifact without the same gates and explicit editor action.

