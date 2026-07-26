<!-- rucksack-autopilot-provider:vm-codex -->
<!-- rucksack-autopilot-depends-on:027 -->

# Compile one Astro post into WebPub, EPUB, and paged PDF

depends-on: 027

## Provider

vm-codex

## Goal

Ship the source-first beachhead: compile one published `ernie.sg` Astro MDX post through a source-neutral `PublicationBundle` into a phone WebPub, a reflowable monochrome e-ink EPUB, and deterministic A4 and A5 PDFs using one pinned, replaceable HTML/CSS renderer adapter. The existing responsive Astro route remains a same-source sibling, not yet a graph-rendered output.

## Acceptance tests

- `publication:build` selects a registered source adapter, resolves its source locator into a `PublicationBundle`, and then invokes source-neutral renderers. A renderer cannot import Astro types or inspect adapter provenance to branch its output.
- The Astro adapter accepts a stable blog entry id from the existing `blog` collection and emits phone WebPub, monochrome e-ink EPUB, A4 PDF, A5 PDF, and one `PublicationReceipt`; the existing Astro route remains the canonical responsive web edition.
- The adapter preserves frontmatter title, description, date, authors, locale, translation key, headings, paragraphs, emphasis, links, lists, quotes, code, math, images/captions, footnotes, and source order in `PublicationGraph`. Unsupported MDX components fail with named node/source locations instead of being dropped.
- The first real golden input is the published `src/content/blog/moving-to-cloudflare-with-astro/index.mdx`; add an authored hero-image alternative to the validated content schema/post, then resolve its local image and translation linkage without a network request and include the asset exactly once in each applicable package with that alt text and provenance. Reusing the post title as an invented image description is not accepted.
- A named synthetic MDX fixture covers code, math, quotes, footnotes, captions, links, one local image, and one unsupported component. Supported semantics survive; the unsupported component fails with its type and source location instead of being flattened or evaluated.
- A pinned Vivliostyle CLI adapter consumes repository-owned semantic HTML and CSS to create WebPub, EPUB, and PDF. It runs with the network disabled after `npm ci`, never auto-installs a theme, and can be replaced behind the renderer interface without changing the graph.
- Vivliostyle and Node wrappers are exact `package-lock.json` dependencies; the browser revision, repository font-file checksums, and EPUBCheck version/checksum live in a reviewed toolchain manifest. No release tool is resolved from an unpinned global executable.
- The required output matrix is phone WebPub, monochrome e-ink EPUB, A5 PDF, and A4 PDF. The two print profiles differ in page dimensions, margins, type scale, measure, page count, and figure placement while every output preserves required nodes and relationships; EPUB remains reflowable and reader-overridable.
- WebPub checks language/direction, headings, landmarks, links, canonical order, and image alternatives. EPUB checks navigation, landmarks, accessibility metadata, reading order, references, and assets with structural inspection plus EPUBCheck. PDF checks selectable text, page geometry, embedded fonts, glyphs/assets, clipping/overflow, figure-caption integrity, widows/orphans, and links; tagged PDF/PDF-UA, PDF/X, full CMYK, imposition, and newspaper production are explicitly outside this issue.
- The published Astro route and compiled WebPub receive a structural comparison for canonical order and local assets. This proves same-source sibling parity without claiming that the current route consumes `PublicationGraph`.
- Repeated builds from the same source, compiler/profile/policy versions, pinned renderer, and fonts produce stable semantic/layout receipts. Any unavoidable binary metadata variance is normalized or documented and cannot change page geometry or content checksums.
- `publication:build` and `publication:check` are required commands in `.github/workflows/ci.yml` and `scripts/agent-evidence`; register them inside the evidence schema's existing `build` and `test` lane ids unless the allowlist, `.agent/commands.yaml`, `.agent/verify.md`, local evidence script, and immutable-head workflow are intentionally migrated together. Exact-head evidence cannot pass when the matrix or toolchain is missing.
- New files to add: `src/publication/adapters/astro.ts`, `src/publication/adapters/astro.test.ts`, `src/publication/adapter-registry.ts`, `src/publication/renderers/vivliostyle.ts`, `src/publication/renderers/vivliostyle.test.ts`, `src/publication/toolchain.ts`, `src/publication/toolchain.test.ts`, `src/publication/toolchain-manifest.json`, `tools/publication-build.mjs`, `tools/publication-build.test.mjs`, `tools/publication-check.mjs`, `tools/publication-check.test.mjs`, `tests/fixtures/publication/astro/synthetic-publication.mdx`, `tests/fixtures/publication/astro/unsupported-component.mdx`, and repository-owned CSS under `src/styles/publication/`. Add `publication:build` and `publication:check` scripts to the existing `package.json`.

## TDD sequence

1. **Red:** create the named Astro/renderer/toolchain/CLI tests and MDX fixtures, run their focused Vitest command, and preserve failures for supported/unsupported MDX, missing alt text, traversal, attempted execution, missing/mismatched toolchains, and an incomplete output matrix.
2. **Green:** implement the adapter registry and bundle handoff, then make a source-neutral renderer produce and structurally check only phone WebPub from repository-owned HTML/CSS.
3. **Red then green:** add EPUB, A5, and A4 artifact/check failures; pin and wire Vivliostyle, fonts, browser, and EPUBCheck until the exact four-output matrix passes offline and from a clean install.
4. **Refactor:** enforce one publication traversal and renderer boundary only after determinism, route-sibling parity, accessibility boundaries, and build/test evidence-lane failures pass; repeat the build and compare normalized receipt hashes before full validation.

## Exact-head definition of done

- The published entry and synthetic fixture pass the declared adapter boundary; unsupported/unsafe input fails closed, and all four real artifacts preserve required semantics at the exact PR head.
- `publication:build`, `publication:check`, focused tests, normal build, CI, and exact-head evidence all pass from a clean dependency install with network-disabled rendering and no skipped matrix cell.
- Toolchain and font versions/checksums are pinned; artifacts stay in ignored evidence storage; renderers import no Astro types; PDF accessibility/production claims remain within the stated boundary.
- From a clean checkout of the immutable PR head, the canonical evidence manifest records `commit` equal to that head, `dirty: false`, `result: passed`, and the existing evidence lane ids containing both publication commands; a post-lane clean-worktree check proves validation did not modify tracked or generated source files.
- One receipt binds source/graph/assets, all four profile and policy versions, the pinned Node/browser/Vivliostyle/font/EPUBCheck toolchain, and all four artifact hashes to that exact head; the browser and EPUB validators install portably in CI and do not rely on desktop-bundled paths.

## Validation command

```bash
npx vitest run src/publication/adapters/astro.test.ts src/publication/renderers/vivliostyle.test.ts src/publication/toolchain.test.ts tools/publication-build.test.mjs tools/publication-check.test.mjs
npm test
npm run build
npm run publication:build -- --adapter astro --entry moving-to-cloudflare-with-astro --output .agent/evidence/publication
npm run publication:check -- --input .agent/evidence/publication --matrix phone-webpub,eink-epub,a5-pdf,a4-pdf
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. Source, assets, rendering, and validation run locally without hosted services.

## Artifact outputs

Astro source adapter and registry, pinned replaceable renderer/toolchain, repository-owned themes, multi-output CLI, A4/A5/WebPub/EPUB artifacts in ignored evidence storage, publication receipt, required CI/evidence lanes, and semantic/visual/accessibility/conformance tests.

## Stop conditions

Stop before scraping the public blog HTML as canonical content, silently flattening or executing MDX, letting a renderer import Astro types, fetching a theme/tool/asset during the build, committing generated publications, weakening the existing production build, or marketing A4/A5 proof as arbitrary magazine/newspaper production.

## Human clarification protocol

If an existing MDX component cannot map losslessly, report the component, affected post ids, and smallest authored static or print alternative rather than embedding client-only behavior in EPUB/PDF.

## Recommended response

Use Astro's validated collection as one registered source adapter and Vivliostyle as a pinned output engine, keeping all editorial meaning and transformation decisions in repository-owned contracts and themes and all source-specific knowledge outside renderers.

## Trade-offs

Vivliostyle accelerates a real multi-output release and supports custom page sizes, but it does not supply editorial intelligence. Keeping it behind an adapter avoids coupling the future planner to one paged-media engine.

## Free-form response

This is the first user-visible proof of “write once, publish beautifully everywhere”: one published post already authored on `ernie.sg`, not a reconstructed PDF, produces compiler-generated WebPub, ebook, and print artifacts alongside its existing responsive route.

