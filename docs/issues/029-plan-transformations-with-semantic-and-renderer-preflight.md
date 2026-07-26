<!-- rucksack-autopilot-provider:vm-codex -->
<!-- rucksack-autopilot-depends-on:027,028 -->

# Plan transformations with semantic and renderer preflight

depends-on: 027,028

## Provider

vm-codex

## Goal

Add the missing dynamic-typesetting middle layer: enumerate deterministic representation and layout candidates for a `CompositionContext`, reject static semantic failures, probe bounded survivors with the renderer, reject measured geometric/production failures, and explain the selected eligible plan and artifact.

## Acceptance tests

- A renderer-neutral `LayoutPlan` records every canonical node exactly once or as ordered fragments, selected representation, flow region, keep/split rules, source/output anchors, reasons, policy versions, hard violations, soft trade-offs, and remaining uncertainty.
- The planner chooses from bounded authored modes—editorial spread, conventional page, compact page, single-column reading, and sequence—without free coordinates or target-name conditionals.
- Component policies demonstrate at least: figure inline/full-span; table conventional/stacked-records; aside margin/inline/endnote; interactive media authored-static alternative; and color chart authored-monochrome alternative. Required authored variants fail closed when absent.
- Static semantic preflight rejects unreachable required content, changed reading order, dangling relationships, missing required representations/alternatives, policy violations, known legibility floors, insufficient declared asset resolution, and incompatible bleed/binding constraints before rendering.
- The issue-028 Vivliostyle adapter is migrated to consume `LayoutPlan` and return a versioned renderer probe with actual page count, shaped glyph coverage, line/page breaks, overflow, clipping, figure-caption geometry, link targets, and output anchors. Renderer-specific facts remain probe evidence and never enter `PublicationGraph` or standing policy.
- Geometric/production validation rejects unusable table/equation fallback, unexpected clipping/overflow, unsupported glyph shaping or hyphenation, broken keeps/relationships, and actual print constraints. A bounded failed candidate may advance to the next deterministic candidate; no artifact is final until one candidate passes both stages.
- Soft comparison applies only to candidates that pass static and measured hard gates and exposes page count, density, hierarchy, figure prominence, whitespace, and policy preference separately; no weighted aesthetic score can compensate for a hard failure.
- A four-profile fixture renders phone WebPub, six-inch monochrome e-ink EPUB, A5 PDF, and A4 PDF with materially different but eligible plans, stable source/output anchors, identical required-content reachability, and successful `publication:check`. An undersized custom profile returns no eligible plan plus the smallest actionable alternatives without emitting a final artifact.
- New files to add: `src/publication/planner.ts`, `src/publication/planner.test.ts`, `src/publication/static-preflight.ts`, `src/publication/static-preflight.test.ts`, `src/publication/renderer-probe.ts`, `src/publication/renderer-probe.test.ts`, `src/publication/production-validation.ts`, `src/publication/production-validation.test.ts`, `src/publication/vivliostyle-renderer.test.ts`, `tests/fixtures/publication/four-profile-publication.json`, and `tests/fixtures/publication/undersized-profile.json`. Preview matrix and editorial-lock UI are excluded and tracked by issue 031.

## TDD sequence

1. **Red:** add the five exact-path planner/preflight/probe tests and two fixtures, run their focused Vitest command, and preserve failures for bounded candidate order, policy bounds, semantic rejection, missing alternatives, and an undersized no-eligible-plan context.
2. **Green:** implement only candidate enumeration, one figure/table transformation, and static semantic preflight until statically legal `LayoutPlan` values are the only values reaching a renderer.
3. **Red then green:** add renderer-probe failures for overflow, clipping, glyphs, keeps/links, and unusable fallbacks; migrate the issue-028 adapter to return measured evidence and parameterize the remaining bounded policies.
4. **Refactor:** separate static from measured facts and stabilize reason codes only after next-candidate selection, four receipts, repeated plan/probe bytes, and normalized output hashes are deterministic; then run full validation.

## Exact-head definition of done

- No final artifact exists without a static-pass plan and measured production-pass probe; hard failures cannot be outweighed, hidden, or converted into a soft score at the exact PR head.
- Planner/probe/production unit tests, four-output build/check, normal build, and exact-head evidence pass with a second failure fixture and no UI or editorial-lock scope leakage.
- Graph and standing policy remain renderer-neutral, every required node has lineage, no authored alternative is invented, and no model participates in a gating decision.
- From a clean checkout of the immutable PR head, the canonical evidence manifest records `commit` equal to that head, `dirty: false`, `result: passed`, and every required lane; a post-lane clean-worktree check proves validation did not modify tracked or generated source files.
- Plan/probe/artifact receipts bind source and graph hashes, profile/policy/planner/probe versions, pinned toolchain versions, selected-candidate reasons, and all four artifact hashes to that exact head.

## Validation command

```bash
npx vitest run src/publication/planner.test.ts src/publication/static-preflight.test.ts src/publication/renderer-probe.test.ts src/publication/production-validation.test.ts src/publication/vivliostyle-renderer.test.ts
npm test
npm run build
npm run publication:build -- --adapter astro --entry moving-to-cloudflare-with-astro --planner semantic-v1 --output .agent/evidence/publication-planner
npm run publication:check -- --input .agent/evidence/publication-planner --matrix phone-webpub,eink-epub,a5-pdf,a4-pdf
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. Planning is deterministic and offline; no model call is required.

## Artifact outputs

Deterministic planner, static semantic preflight, versioned renderer probe, geometric/production validation, eligible candidate comparison, renderer-neutral plans, four rendered profile artifacts, and receipts.

## Stop conditions

Stop before adding an LLM as the deciding planner, treating unmeasured geometry as proven, letting an aesthetic score hide semantic loss, producing a summary or crop that lacks an authored variant, optimizing against one golden fixture, or copying Vivliostyle-specific measurements into canonical graph/policy fields.

## Human clarification protocol

When no eligible plan exists, report the conflicting hard constraints and smallest legal authored alternative or profile relaxation; ask for editorial judgment only when standing policy cannot choose among those options.

## Recommended response

Build a deterministic constraint/policy layer and explicit renderer feedback loop first, then use model-assisted proposals only as non-gating candidates with provenance after a human-labelled evaluation set exists.

## Trade-offs

Bounded modes cannot invent every art-directed spread, but they are testable, explainable, and stable. Renderer probes add build cost, but geometric truth cannot be inferred from semantic plans alone.

## Free-form response

Renderers already solve much of HTML, EPUB, and paged CSS. This planner is the product innovation: preserving editorial intent while changing representation and geometry across capabilities.

