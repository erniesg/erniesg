<!-- rucksack-autopilot-provider:vm-codex -->
<!-- rucksack-autopilot-depends-on:027,028 -->

# Map Payload Lexical documents into the publication compiler

depends-on: 027,028

## Provider

claude

## Goal

Add a Payload CMS source adapter that maps typed Lexical JSON, blocks, uploads, relationships, and locales into the same `PublicationGraph` consumed by Astro, so Payload-authored publications reach every existing output without a Payload-specific renderer branch.

## Acceptance tests

- A strict adapter accepts a documented local Payload export shape plus a field-mapping policy and maps title, description, authors, locale, status/version, and Lexical rich text into `PublicationGraph`.
- Paragraphs, headings, bold, italic, underline, strike, subscript, superscript, inline code, links, lists, quotes, uploads, relationships, and configured block types preserve source order, semantics, and source provenance. Unsupported enabled Lexical nodes fail with their type and tree location.
- Uploads map to content-addressed assets with alt text, dimensions, media type, focal/crop metadata when supplied, and a declared missing-asset diagnostic when the export is incomplete. No remote URL is fetched implicitly.
- Block and relationship mappings are explicit configuration, versioned in the receipt, and cannot execute functions or arbitrary Payload hooks from untrusted export JSON.
- Locale variants become linked publication editions. Fallback locale use is recorded per node; it never silently mixes languages in one edition.
- When stored Lexical data lacks stable node ids, the adapter derives deterministic ids from document id, structural path, and content digest, marks them as derived, and proves how insertions affect anchor stability.
- One committed synthetic fixture under the new `tests/fixtures/payload/` directory registers through the same `PublicationSourceAdapter` registry as Astro, then builds and passes `publication:check` for phone WebPub, monochrome e-ink EPUB, A5 PDF, and A4 PDF. No renderer imports Payload types or branches on source provenance.
- An equivalent Astro/Payload fixture pair produces the same canonical semantic subset and traverses identical renderer, profile, transformation-policy, and check versions. Their receipts may differ in source adapter/provenance and source hashes only; output lineage and required-content checks use the same schema and gates.
- An optional live reader remains a separate boundary. If later enabled through Payload Local API or REST, it passes only the resulting data object into this adapter and keeps authentication names/values out of source, logs, issues, and receipts. New files to add: `src/publication/adapters/payload-lexical.ts`, `src/publication/adapters/payload-lexical.test.ts`, `src/publication/adapter-conformance.test.ts`, `tests/fixtures/payload/publication.json`, `tests/fixtures/payload/mapping.json`, `tests/fixtures/payload/equivalent-publication.json`, `tests/fixtures/publication/astro/payload-equivalent.mdx`, and `tests/fixtures/payload/README.md`.

## TDD sequence

1. **Red:** create the exact adapter/conformance tests and local fixtures, run `npx vitest run src/publication/adapters/payload-lexical.test.ts src/publication/adapter-conformance.test.ts`, and preserve failures for supported/unknown Lexical nodes, assets/relationships, locales, drafts, derived ids, and executable mapping input.
2. **Green:** implement only the pure field mapping and Lexical-to-`PublicationBundle` adapter needed for graph/asset/provenance tests, without Payload packages, transport, hooks, or network access.
3. **Red then green:** add the equivalent Astro/Payload fixture pair and receipt failures, then register Payload through the same source boundary and real renderer/check matrix.
4. **Refactor:** separate generic Lexical walking from mapping policy only after both sources traverse identical renderer/profile/policy versions and all four real outputs pass; then run full validation.

## Exact-head definition of done

- Supported local Payload JSON maps deterministically; every unknown/incomplete/unsafe case fails with the named diagnostic; draft/locale/derived-id provenance is explicit at the exact PR head.
- Adapter tests, equivalent-source comparison, four-output build/check, normal build, and exact-head evidence pass with identical renderer/profile/policy identifiers and no skipped matrix cell.
- No Payload dependency, database, credential, live request, implicit upload fetch, serialized hook, customer content, or source-specific renderer branch is added.
- From a clean checkout of the immutable PR head, the canonical evidence manifest records `commit` equal to that head, `dirty: false`, `result: passed`, and every required lane; a post-lane clean-worktree check proves validation did not modify tracked or generated source files.
- Astro/Payload conformance and output receipts bind both source hashes, their shared canonical subset hash, adapter versions, identical profile/policy/renderer/toolchain versions, and every artifact hash to that exact head.

## Validation command

```bash
npx vitest run src/publication/adapters/payload-lexical.test.ts src/publication/adapter-conformance.test.ts
npm test
npm run build
npm run publication:build -- --adapter payload --input tests/fixtures/payload/publication.json --mapping tests/fixtures/payload/mapping.json --output .agent/evidence/payload-publication
npm run publication:check -- --input .agent/evidence/payload-publication --matrix phone-webpub,eink-epub,a5-pdf,a4-pdf
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None for the adapter and fixtures. A future live reader may name an external auth requirement but is not part of this issue.

## Artifact outputs

Payload export schema, field-mapping policy, registered Lexical-to-bundle adapter, synthetic/equivalent-source fixtures, provenance/locale/anchor tests, four checked output artifacts, cross-adapter receipt comparison, renderer-interface conformance, and adapter documentation.

## Stop conditions

Stop before installing or provisioning Payload, connecting to a live CMS, committing real customer/editor content, fetching uploads implicitly, executing serialized hooks, or branching output renderers on `source === payload`.

## Human clarification protocol

If a custom Lexical node or Payload block lacks a mapping, present preserve-as-opaque, typed adapter extension, and explicit unsupported options with their downstream reachability effects.

## Recommended response

Start from local typed JSON fixtures and a pure registered adapter, then prove real multi-output parity through the existing renderer/check stack; add Local API or REST transport only after the compiler contract and access policy are stable.

## Trade-offs

A pure export adapter does not provide live collaborative CMS updates, but it proves the important architectural claim—that Payload and Astro share one compiler and output stack—without adding database, auth, or deployment scope.

## Free-form response

Payload already stores rich text as structured Lexical JSON and exposes it through Local, REST, and GraphQL APIs. The adapter should preserve that structure rather than converting to flat HTML and then reconstructing meaning.

