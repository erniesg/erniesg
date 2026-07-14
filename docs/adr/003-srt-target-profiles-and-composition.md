# ADR 003: SRT Target Profiles and Deterministic Composition

## Status

Accepted for the four-target browser-flow proof of concept. Its deferred-pagination boundary is superseded by ADR 006.

## Context

The studio previously kept four preview widths inside its React component while the layout manifest emitted the same placeholder variants for every target. That made the visible rendition and the evidence contract independent sources of layout truth. The next dependency-ready slice requires A4 print, reMarkable Paper Pro, reMarkable Paper Pro Move, and continuous mobile to differ through inspectable data without adding fixture-specific coordinates or implementing finite pagination early.

## Decision

`src/research/targets.ts` is the target-profile registry, validated by `src/research/target-schema.ts`. Every profile declares dimensions, margins, typography, columns, interaction mode, finite-height capability, and separate scaled preview dimensions.

| Profile                   |       Target dimensions | Columns | Interaction       | Finite height |
| ------------------------- | ----------------------: | ------: | ----------------- | ------------- |
| Continuous mobile         | 390 CSS px × continuous |       1 | continuous scroll | no            |
| reMarkable Paper Pro Move |    954 × 1696 device px |       1 | page turn         | yes           |
| reMarkable Paper Pro      |   1620 × 2160 device px |       1 | page turn         | yes           |
| A4 print                  |            210 × 297 mm |       2 | static print      | yes           |

`src/research/composition.ts` contains named, versioned policy data and one resolver for node variants. The studio and manifest both consume that resolver. Rendering remains a single semantic node renderer; profile data becomes CSS custom properties and `data-*` policy outcomes instead of target-specific article markup.

The policy chooses continuous browser flow for mobile and a finite-sheet browser-flow preview for the other targets. A4 uses two columns and a full-span figure. Paper Pro uses an inline figure. Paper Pro Move requests a dedicated figure view but records an explained `variant-unavailable` fallback to a compact stacked figure. Mobile uses an edge-to-edge in-flow figure.

Layout manifest version `1.1.0` embeds the resolved profile, named policy, decisions, chosen node variants, and any coded fallback. Canonical node IDs, content hashes, relationships, and provenance remain unchanged.

## Consequences

Target switching, the visual rendition, and machine-readable evidence now share one data source. Profile or policy drift fails structural validation, and the four compositions can be compared without writing target geometry into canonical content.

At this milestone, finite height was a declared target capability rather than a claim that pagination existed. ADR 006 subsequently adds page breaking, fragment lineage, and finite-height overflow handling while retaining these profiles.

## Non-goals

This decision does not add a paged-media engine, page coordinates, golden-fixture positioning, arbitrary PDF reconstruction, annotations, target overrides, exports, or visual-baseline approval.
