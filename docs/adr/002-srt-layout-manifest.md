# ADR 002: SRT Layout Manifest Contract

## Status

Accepted for the P0 proof of concept.

## Context

A rendition must be mechanically comparable with the canonical graph before pagination and annotations add more derived state. A global list of nodes cannot prove that each target retained the same content and relationships, and it cannot distinguish intentional fragmentation from silent duplication.

## Decision

Layout manifests use a strict, runtime-validated JSON contract with `schemaVersion: "1.0.0"`.

- Each configured target owns one rendition record and every rendition carries the canonical document hash.
- Each mandatory canonical node has one rendition entry. An entry may instead record an ordered, contiguous fragment list.
- Entries repeat the target ID, canonical node ID and type, canonical node hash, source provenance, and relationships so target-by-target preservation is directly testable.
- Placement is either a semantic flow position or derived geometry. Geometry remains rendition data and never enters the canonical graph.
- Every entry records its chosen variant and a diagnostics array.
- A fallback variant requires a `VARIANT_FALLBACK` diagnostic. Explicit fragmentation similarly requires a `CONTENT_FRAGMENTED` diagnostic.
- The manifest builder uses canonical order and stable object field order so serialized output is deterministic.

The schema checks shape, duplicate entries, target agreement, fragment structure, and explained fallbacks. Contract validation additionally compares every rendition with the canonical graph to reject omissions, unknown nodes, content-hash drift, provenance drift, relationship loss, and semantic flow reordering.

## Consequences

The manifest is inspectable evidence for a rendition, not a second document source. Current targets use flow positions because finite-height pagination has not been implemented; later composition may emit geometry or fragments without changing the version 1 representation.

Target-specific policy, page breaking, annotation geometry, and visual baseline approval remain later milestones.
