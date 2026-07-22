# Compose imported PDFs into device-profile renditions and EPUB packages

depends-on: 013

## Provider

vm-codex

## Goal

Join the PDF import pipeline to the target-profile registry so a gate-passing imported paper composes through all four targets and exports device-profile EPUB packages for reMarkable Paper Pro and Paper Pro Move, instead of one generic reflowable EPUB.

## Current status (2026-07-21)

This issue remains open. The importer now builds and structurally validates selected Mobile, Paper Pro Move, and Paper Pro reflowable EPUBs from one canonical reconstruction, but it does not yet emit a checked print artifact or a per-target four-profile layout-manifest set. The three-profile upload/preview/download slice is issue 032 evidence, not proof that this four-target contract is complete.

## Acceptance tests

- An imported born-digital PDF that passes the completeness gate composes through `mobile`, `paperProMove`, `paperPro`, and `print` with a layout manifest per target recording page/fragment lineage, decisions, and violations.
- `buildEpub` accepts a target profile and derives typography, margins, and page-progression CSS from the profile registry in `src/research/targets.ts`; no profile values are duplicated or hard-coded in export code.
- The registry identifies the 7.3-inch Paper Pro Move as `954 × 1696` device pixels at `264 PPI` and the 11.8-inch Paper Pro as `1620 × 2160` device pixels at `229 PPI`. Those facts drive intended viewport and asset policy; reflowable reader pagination, fonts, margins, and orientation remain reader-controlled and are not promised to match the browser page-for-page.
- Exports emit `publication-paperpro.epub` and `publication-papermove.epub` alongside the existing reflowable baseline, and the export manifest records the profile id, version, and policy that produced each artifact.
- Figure and equation assets are packaged at a resolution appropriate to the profile's device pixels and PPI, never upscaled beyond source fidelity, with the downscale policy documented in the export manifest.
- Structural invariants hold for every device EPUB: each canonical node appears exactly once or as ordered fragments, figure/caption relationships survive, and `inspectEpub` verifies there are no dangling manifest references per profile.
- The publication importer e2e flow produces both device EPUBs for a gate-passing fixture PDF, and geometry diagnostics confirm no clipped or overlapping content in the e-ink preview renditions.
- Rebuilding the same input with the same profile and policy versions is byte-identical.

## Validation command

```bash
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts tests/e2e/srt-visual.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. Composition and export run locally with no hosted services.

## Artifact outputs

Profile-aware EPUB exporter, per-target export manifests, device EPUB fixtures evidence, extended `inspectEpub` checks, and structural/visual evidence.

## Stop conditions

Stop before adding an unjustified runtime dependency, emitting fixed-layout EPUB pages when reflowable output is possible, forking profile data into export code, or weakening the completeness gate to make an export succeed.

## Human clarification protocol

If reMarkable reader behavior (its own pagination, CSS support, or image handling) makes a profile decision ambiguous, report the smallest set of candidate export policies with their observable differences.

## Recommended response

Treat the device EPUB as profile-tuned reflowable output: profile typography and margins as EPUB CSS, assets sized for the device, and the finite-height manifest kept as verification evidence rather than forcing hard page boxes.

## Trade-offs

Pre-paginated fixed layout would match the studio preview exactly but fights e-ink readers' own reflow; profile-tuned reflowable output is more robust across firmware versions at the cost of exact page parity.

## Free-form response

The four target profiles already exist and are tested; this issue is the missing join between `reconstructPdf` output and the profile/composition/export spine that issues 003–007 built for the golden fixtures.
