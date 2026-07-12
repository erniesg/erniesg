# ADR 001: SRT Canonical Graph Contract

## Status

Accepted for the P0 proof of concept.

## Context

Semantic Responsive Typesetting treats the page as a rendition, not as the document. The PRD sets the default canonical model as a custom validated JSON graph inspired by JATS, with structured source preferred over PDF reconstruction. The literature review also calls out that objects alone are insufficient: figure-caption, reference, provenance, and annotation relationships must survive recomposition.

This ADR freezes the minimum graph contract needed before adding layout complexity.

## Decision

The canonical article source is a strict JSON graph validated at load time.

- Each semantic node has a stable `id`, a `type`, and a `source` provenance string.
- The first supported node types are `heading`, `paragraph`, `quote`, `figure`, and `caption`.
- Heading levels are explicit and limited to levels 1 through 3 for the first fixture.
- Figure captions are represented as relationships from a `figure` node to a separate `caption` node.
- Every node ID must be unique.
- Every relationship target must resolve to an existing canonical node.
- Canonical content must not contain target coordinates or rendition geometry.
- A deterministic SHA-256 content hash is computed from canonical content after removing rendition-only geometry/cache fields.

## Consequences

Later composition work can compare renditions by canonical IDs and content hash instead of by page coordinates. A figure can move away from its caption in a target layout only as a recorded layout decision; the source relationship remains stable.

Schema validation now rejects malformed fixtures early, including duplicate IDs, dangling relationships, invalid heading levels, and geometry accidentally written into canonical source.

## Non-goals

This ADR does not define a universal document schema, a PDF importer, arbitrary equation support, collaboration, freehand ink deformation, a production CMS, or generative layout. Real JATS ingestion remains later work; the current fixture is manually normalized synthetic content.

Target profiles, page boxes, coordinates, cache rectangles, and pagination decisions belong in renditions or manifests, not in canonical content.
