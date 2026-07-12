# SRT deterministic four-target composition

depends-on: 002

## Provider

vm-codex

## Goal

Render the same golden article into A4 print, reMarkable Paper Pro, reMarkable Paper Pro Move, and continuous mobile using deterministic target profiles and policies.

## Acceptance tests

- Target profiles include dimensions, margins, typography, columns, interaction mode, and finite-height capability.
- The four renditions are materially different while retaining identical canonical IDs and content hashes.
- Target switching uses data, not duplicated target-specific article markup.
- Layout decisions and fallbacks appear in the manifest.
- Existing research routes continue to build.

## Validation command

```bash
npm test
npm run build
```

## Allowed secrets

None.

## Artifact outputs

Four target profiles, deterministic policy layer, rendition tests, and profile ADR.

## Stop conditions

Stop before adding one-off coordinates that only make the golden fixture pass.

## Human clarification protocol

Ask only when a device specification cannot be verified or a typography choice changes the public visual direction.

## Recommended response

Use browser/CSS flow for the first continuous rendition and keep finite pagination behind the next issue.

## Trade-offs

Deterministic policies may look less polished initially, but they expose failures instead of hiding them.

## Free-form response

No production deploy from this issue.
