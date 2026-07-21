# ADR 003: SRT Target Profiles and Deterministic Composition

## Status

Accepted for the four-target browser-flow proof of concept. Its deferred-pagination boundary is superseded by ADR 006.

## Context

The studio previously kept four preview widths inside its React component while the layout manifest emitted the same placeholder variants for every target. That made the visible rendition and the evidence contract independent sources of layout truth. The next dependency-ready slice requires A4 print, reMarkable Paper Pro, reMarkable Paper Pro Move, and continuous mobile to differ through inspectable data without adding fixture-specific coordinates or implementing finite pagination early.

## Decision

`src/research/targets.ts` is the target-profile registry, validated by `src/research/target-schema.ts`. Every profile declares dimensions, margins, typography, columns, interaction mode, finite-height capability, and separate scaled preview dimensions.

| Profile                   |       Target dimensions | Density | Columns | Interaction       | Finite height |
| ------------------------- | ----------------------: | ------: | ------: | ----------------- | ------------- |
| Continuous mobile         | 390 CSS px × continuous |     n/a |       1 | continuous scroll | no            |
| reMarkable Paper Pro Move |    954 × 1696 device px | 264 PPI |       1 | page turn         | yes           |
| reMarkable Paper Pro      |   1620 × 2160 device px | 229 PPI |       1 | page turn         | yes           |
| A4 print                  |            210 × 297 mm |     n/a |       2 | static print      | yes           |

`src/research/composition.ts` contains named, versioned policy data and one resolver for node variants. The studio and manifest both consume that resolver. Rendering remains a single semantic node renderer; profile data becomes CSS custom properties and `data-*` policy outcomes instead of target-specific article markup.

The policy chooses continuous browser flow for mobile and a finite-sheet browser-flow preview for the other targets. A4 uses two columns and a full-span figure. Paper Pro uses an inline figure. Paper Pro Move requests a dedicated figure view but records an explained `variant-unavailable` fallback to a compact stacked figure. Mobile uses an edge-to-edge in-flow figure.

Layout manifest version `1.1.0` embeds the resolved profile, named policy, decisions, chosen node variants, and any coded fallback. Canonical node IDs, content hashes, relationships, and provenance remain unchanged.

## Consequences

Target switching, the visual rendition, and machine-readable evidence now share one data source. Profile or policy drift fails structural validation, and the four compositions can be compared without writing target geometry into canonical content.

At this milestone, finite height was a declared target capability rather than a claim that pagination existed. ADR 006 subsequently adds page breaking, fragment lineage, and finite-height overflow handling while retaining these profiles.

The device dimensions and densities describe the 7.3-inch Paper Pro Move and 11.8-inch Paper Pro displays, using the manufacturers' current [Paper Pro Move](https://remarkable.com/products/remarkable-paper/pro-move/details/features) and [Paper Pro](https://remarkable.com/products/remarkable-paper/pro/details/features) specifications. The registry preserves the listed landscape pixel pairs (`1696 × 954` and `2160 × 1620`) separately from the portrait logical dimensions (`954 × 1696` and `1620 × 2160`), so transposition is explicit rather than an apparent size disagreement. Browser previews derive both e-ink frames from one common relative physical scale (`device pixels / PPI`) while retaining aspect ratio and receipt identity: with Paper Pro anchored at `540 × 720` CSS pixels, Paper Pro Move is `276 × 490`, not a separately normalized full-width frame. The continuous Mobile profile has no finite target height, so its versioned `844` CSS-pixel inspection window is explicitly advisory. Profile padding is the one authored margin authority in the rendition (`@page` and preview-only body padding do not add a second margin). Reflowable EPUB readers remain free to override pagination, fonts, margins, and orientation, so CSS pixels are not a firmware-exact physical-inch claim.

## Non-goals

This decision does not add a paged-media engine, page coordinates, golden-fixture positioning, arbitrary PDF reconstruction, annotations, target overrides, exports, or visual-baseline approval.
