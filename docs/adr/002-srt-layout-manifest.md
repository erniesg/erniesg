# ADR 002: SRT Layout Manifest Contract

## Status

Accepted for the structural rendition proof of concept.

## Context

A rendition must be mechanically comparable with the canonical graph before target-specific composition, pagination, or annotations are added. A list of rendered IDs is insufficient because it cannot expose changed content, lost relationships, missing provenance, fragmentation, or unexplained fallbacks.

## Decision

Layout manifests use the strict, versioned schema in `src/research/manifest.ts`. The original structural contract was `1.0.0`; ADR 003 extends it to `1.1.0` with target-profile and deterministic-policy evidence, and ADR 006 extends it to `1.2.0` with finite-page evidence.

- Each rendition and each entry names its target and carries the canonical document hash.
- Every canonical node has exactly one manifest entry. A node is represented either by one flow/geometry placement or by two or more ordered, uniquely identified fragments.
- Every entry retains the canonical ID, node type, node content hash, source provenance, and relationships.
- Every entry records its chosen variant and diagnostics, even when the diagnostics list is empty.
- A fallback names the attempted variant and a diagnostic code that must also occur in the entry diagnostics.
- Geometry and flow positions exist only in the manifest. They are never written into canonical source data.
- Structural validation compares every rendition with the canonical graph and rejects missing or unexpected targets and nodes, changed hashes, provenance drift, and relationship loss.

The generated manifest uses deterministic target and canonical-node order. It deliberately omits a generation timestamp so identical inputs produce identical evidence.

## Consequences

Composition implementations can change placement and chosen variants while sharing the same structural assertions. New diagnostic codes or incompatible fields require a manifest schema version change. Formatting is less important than the invariant checks, so generated manifests remain runtime or evidence artifacts rather than committed golden files.

## Non-goals

This contract does not define annotation geometry, visual baselines, or exports. Those remain later dependency-ordered issues.
