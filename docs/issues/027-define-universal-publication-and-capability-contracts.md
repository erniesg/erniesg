<!-- rucksack-autopilot-provider:vm-codex -->
<!-- rucksack-autopilot-depends-on:002,003,019,026 -->

# Define universal publication and capability contracts

depends-on: 002,003,019,026

## Provider

vm-codex

## Goal

Introduce a source-neutral, versioned compiler boundary—`PublicationGraph`, `CompositionContext`, and `TransformationPolicy`—that can represent an Astro post, Payload document, DOCX manuscript, or repaired PDF without making a scholarly `ResearchPaper` or a rendered page the universal source of truth.

## Acceptance tests

- A strict, bounded `PublicationGraph` schema represents publication metadata and ordered heading, paragraph, list, quote, code, figure, caption, table, equation, aside, note, reference, and media nodes with stable ids and explicit relationships.
- Every node records locale/direction, required-or-optional status, editorial importance, source provenance, accessibility alternatives, authored compact/monochrome/static variants where present, permitted transformation ids, and explicit edition linkage for Astro translations and Payload locales. Page coordinates are forbidden from canonical content.
- A versioned `PublicationSourceAdapter` returns `{ graph, assetBundle, diagnostics, provenance }`. `assetBundle` contains bounded content-addressed descriptors and a byte-resolver interface; graph JSON never embeds bytes, local paths, credentials, or source-specific runtime objects.
- `CompositionContext` describes continuous or paged flow, logical/physical dimensions and units, orientation, color capability, resolution, refresh behavior, interaction, font control, locale/script, accessibility preferences, duplex, binding, bleed, and offline constraints. Named presets are data, not branches in compiler code.
- `TransformationPolicy` declares legal representation changes, preservation class, required authored alternatives, and hard/soft constraints. Omission, summarization, reading-order changes, and meaning-changing crops are illegal unless an explicit reviewed variant permits them.
- The existing `TargetProfile` plus issue-026 orientation and export-authority contract maps losslessly into `CompositionContext`. Dimensions, margins, orientation, reader-control assumptions, and pagination authority have exactly one registry; `src/publication/profiles.ts` may expose adapters/presets but cannot duplicate those facts.
- Codecs reject unknown versions, extra fields, duplicate ids, dangling relationships, unsafe URLs, unbounded text/collections, invalid ranges/units, and source fields containing secret or local-path material. Round trips are deterministic.
- An adapter maps the existing golden `ResearchPaper` into the new graph and back to its current supported subset with identical canonical ids, text, relationships, inline semantics, and asset references. A separately typed annotation/anchor bundle round-trips beside the graph; the adapter does not pretend those values live in `ResearchPaper`.
- New files to add: `src/publication/schema.ts`, `src/publication/source-adapter.ts`, `src/publication/asset-bundle.ts`, `src/publication/profiles.ts`, `src/publication/transformation-policy.ts`, `src/publication/research-paper-adapter.ts`, `src/publication/annotation-bundle.ts`, one matching `*.test.ts` for each contract/adapter, and `docs/adr/009-universal-publication-contracts.md`.

## TDD sequence

1. **Red:** add the seven exact-path contract/adapter test files, run their focused Vitest command, and preserve failures for versions, extra fields, ids/relationships, unsafe URLs, bounds/units, embedded bytes/paths, and target geometry in canonical nodes.
2. **Green:** implement only the strict graph, source-adapter, asset-bundle, context, and policy codecs needed for those rejection boundaries; do not add a renderer.
3. **Red then green:** add `ResearchPaper`, separate annotation/anchor, and issue-026 profile-authority round-trip failures, then implement lossless thin adapters without duplicating facts.
4. **Refactor:** consolidate bounded primitives and presets only after deterministic edition linkage, byte resolution, compatibility, and security tests pass; then freeze fixture hashes and run full validation.

## Exact-head definition of done

- All contracts reject invalid/unsafe data and round-trip the supported research-paper/profile subset byte-deterministically at the exact PR head, including separately typed annotations and content-addressed assets.
- Focused contract/security tests, build, full validation, and exact-head evidence pass with no ignored unknown field, lossy compatibility snapshot, or second profile authority.
- The ADR names versioning, source/asset boundaries, unsupported features, migration rules, and non-goals; no renderer, binary asset, secret, local path, or target coordinate enters canonical graph data.
- From a clean checkout of the immutable PR head, the canonical evidence manifest records `commit` equal to that head, `dirty: false`, `result: passed`, and every required lane; a post-lane clean-worktree check proves validation did not modify tracked or generated source files.
- Canonical fixture receipts bind graph/asset hashes, schema and profile versions, adapter version, and toolchain versions to that exact head.

## Validation command

```bash
npx vitest run src/publication/schema.test.ts src/publication/source-adapter.test.ts src/publication/asset-bundle.test.ts src/publication/profiles.test.ts src/publication/transformation-policy.test.ts src/publication/research-paper-adapter.test.ts src/publication/annotation-bundle.test.ts
npm test
npm run build
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. Contracts and fixtures are repository-only data.

## Artifact outputs

Versioned universal schemas/codecs, profile fixtures, transformation-policy fixtures, `ResearchPaper` compatibility adapter, ADR, and deterministic round-trip/security tests.

## Stop conditions

Stop before adding a renderer dependency, inventing a general optimizer, embedding binary assets in graph JSON, duplicating existing target/profile facts, renaming the existing SRT runtime prematurely, or allowing source adapters to smuggle target-specific layout into canonical nodes.

## Human clarification protocol

If one source feature has no medium-independent representation, present a typed extension, an opaque-but-preserved node, and an explicit unsupported diagnostic with their round-trip consequences.

## Recommended response

Extract the smallest compiler and adapter contracts from the invariants the SRT proof already enforces, then prove lossless compatibility with the existing profile and research-paper boundaries before moving any current renderer or importer onto them.

## Trade-offs

A broad graph risks becoming an abstract document standard; restricting the first node set to content already present in Astro, Payload Lexical, DOCX, and the SRT proof keeps it implementable while versioned extensions preserve room to grow.

## Free-form response

This is the architectural seam that changes the product from PDF-to-EPUB into write-once publishing. Source adapters and output adapters can then evolve independently around one inspectable meaning graph.

