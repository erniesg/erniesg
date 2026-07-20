# Bind preview profiles to authoritative exports and orientation

depends-on: 015,023

## Provider

vm-codex

## Goal

Make target selection an explicit, inspectable export contract: the chosen capability profile and orientation determine the primary artifact and manifest, while width and font controls are labelled as reader simulations rather than silently disconnected export settings.

## Acceptance tests

- `ResearchStudio` supports controlled profile selection and reports changes to `PublicationImporter`; there is one selected profile shared by preview metadata, primary download labeling, export manifest, and print-preview behavior.
- The authoritative registry records Paper Pro Move as `954 × 1696` device pixels and Paper Pro as `1620 × 2160` device pixels. Preview CSS may scale those viewports to fit the browser, but its aspect ratio, finite-height pagination, profile id/version, and geometry receipt derive from those exact dimensions rather than copied UI constants.
- Every profile in `TARGET_PROFILE_IDS` has an honest artifact policy. Mobile, Paper Pro, Paper Pro Move, and print-profile outputs are either generated and structurally validated or visibly marked unsupported with a reason; the UI never offers a profile that has no corresponding result.
- After every fresh upload, the user can inspect Mobile, Paper Pro Move, and Paper Pro previews before choosing whether to download. Switching profiles is side-effect free, downloads remain optional explicit actions, and each action names and returns only the checked artifact whose profile id/version and hash match the visible preview receipt.
- A print action is restored only for a selected print profile with a generated, checked PDF whose page geometry and receipt match the preview contract. It downloads that artifact and never aliases the continuous source-review surface to `window.print()`.
- Target profiles declare orientation support and whether orientation is publisher-locked, reader-controlled, or unsupported. A portrait/landscape choice swaps logical dimensions and recomposes without mutating canonical content.
- The export manifest records profile id/version, orientation, composition policy, reader-control assumptions, artifact renderer, and whether pagination is authoritative, advisory, or reader-controlled.
- `Narrow width` and `Larger text` are renamed or grouped as reader simulations. Their state appears in preview evidence but does not claim to alter EPUB bytes unless an explicit authored profile records the same setting.
- Reflowable EPUB tests acknowledge that a reading system may override flow, font, margin, and orientation; no UI copy promises fixed page parity.
- Browser tests select each profile and both supported orientations, assert the matching primary action and manifest, and detect clipping, overlap, horizontal overflow, lost nodes, or lost figure/caption relationships.
- Implementation extends `src/research/target-schema.ts`, `src/research/targets.ts`, `src/components/research/ResearchStudio.tsx`, and `src/components/research/PublicationImporter.tsx`; focused contract coverage lives in `src/research/targets.test.ts`, `src/research/epub.test.ts`, `src/research/export-package.test.ts`, and `src/research/manifest.test.ts`, with geometry and interaction coverage in the existing importer and visual browser specs.

## TDD sequence

1. **Red:** extend the four named research tests plus importer/visual E2E, run `npx vitest run src/research/targets.test.ts src/research/epub.test.ts src/research/export-package.test.ts src/research/manifest.test.ts`, and preserve failures proving preview state, actions, manifests, orientation, and `window.print()` disagree.
2. **Green:** introduce one controlled rendition-selection contract and move profile/orientation facts into the validated registry until resolver tests pass without duplicated constants.
3. **Red then green:** make selected EPUB/PDF artifacts and receipts consume that resolver, then test fresh-upload invalidation, scaled `954 × 1696` and `1620 × 2160` preview geometry, preview-before-download behavior, profile/orientation changes, unsupported combinations, filenames, and checked PDF geometry.
4. **Refactor:** remove duplicated selection/orientation logic and choose eager or on-demand generation only after every supported geometry/structural/E2E case passes; then run the full validation command.

## Exact-head definition of done

- One selected profile/orientation drives preview metadata, artifact label/bytes, filenames, manifests, receipts, and supported controls at the exact PR head; preview-only reader simulations are explicitly separate.
- Resolver, export, importer, visual-geometry, and full validation commands pass with exact-head evidence and no skipped target/orientation or stale artifact.
- No profile fact is duplicated, no `window.print()` output is called production PDF, and no EPUB copy promises reader-controlled pagination or typography parity.
- From a clean checkout of the immutable PR head, the canonical evidence manifest records `commit` equal to that head, `dirty: false`, `result: passed`, and every required lane; a post-lane clean-worktree check proves validation did not modify tracked or generated source files.
- Every generated artifact receipt binds source, selected profile/version/orientation, renderer/toolchain versions, geometry authority, and artifact hash to that exact head.

## Validation command

```bash
npx vitest run src/research/targets.test.ts src/research/epub.test.ts src/research/export-package.test.ts src/research/manifest.test.ts
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts tests/e2e/srt-visual.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. Profiles and artifact generation remain local.

## Artifact outputs

Controlled target state, orientation-aware profile schema and composition, complete target artifact policy, authoritative manifest metadata, clarified reader simulations, and browser evidence.

## Stop conditions

Stop before turning reader font overrides into a fixed-layout EPUB, treating `window.print()` as a production print renderer, adding device-name conditionals outside the profile registry, or claiming firmware-specific pagination without observed device evidence.

## Human clarification protocol

If a target's orientation or pagination behavior is controlled by the reading system, present publisher-locked, advisory, and reader-controlled options with the observable artifact differences.

## Recommended response

Lift profile state to the importer, keep profile facts in the validated registry, and make every preview-only control and artifact-affecting control visually and structurally distinct.

## Trade-offs

Generating every target eagerly makes switching fast but costs browser time and memory; generating the selected target on demand is cheaper but adds a deliberate build step. Either is acceptable when selection and status are truthful.

## Free-form response

The current importer automatically builds a generic EPUB plus two reMarkable variants, while the preview also offers mobile and A4 and its width/font state never reaches export. Orientation is absent from the target schema. Issue 032 is the named end-to-end acceptance gate proving these profile contracts against a fresh PDF upload without committing private source or rendered evidence.
