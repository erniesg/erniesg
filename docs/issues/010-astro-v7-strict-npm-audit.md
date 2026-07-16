# Migrate the Astro stack to v7 and restore strict npm audit CI

## Provider

vm-codex

## Goal

Perform the separately reviewed breaking Astro 7 migration authorized after issue #13 reached its stop condition, clear all high and critical npm audit findings, and restore green required checks without weakening the security gate or changing research semantics.

## Acceptance tests

- Capture the current `npm audit --json` dependency paths before changing dependencies.
- Upgrade Astro and only the integrations, build adapters, test tooling, and compatibility code required by the migration.
- Do not use `npm audit fix --force`, dependency overrides, ignored advisories, or a lower audit threshold.
- `npm audit --audit-level=high` exits successfully.
- Existing production and research-staging builds retain their release gating: production excludes research routes and navigation while staging includes them with `noindex`.
- Existing translation, SRT schema, PDF reconstruction, responsive-layout, and Cloudflare configuration tests pass without semantic fixture rewrites.
- Record any remaining low or moderate advisories with package path and exposure assessment.
- No production deployment occurs in this issue.

## Validation command

```bash
npm audit --audit-level=high
npm test
npm run build
npm run test:e2e
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None.

## Artifact outputs

Updated package manifests and lockfile, compatibility changes, before/after audit reports, migration notes, and full test/evidence output.

## Stop conditions

Stop for a bounded human decision if the migration requires dropping a supported browser/runtime, changing the public site design, replacing the deployment platform, suppressing an advisory, or changing SRT canonical data.

## Human clarification protocol

Report the exact incompatible package/API, the smallest safe alternatives, affected surfaces, and recommended choice. Do not broaden the migration silently.

## Recommended response

Upgrade in coherent dependency groups, preserve the existing release gates and semantic tests, and prove the final supported stack under the strict audit threshold.

## Trade-offs

A single reviewed major migration is broader than a narrow audit fix, but it removes the vulnerable dependency paths that cannot be cleared on the current Astro major.

## Free-form response

This is the authorized breaking-migration follow-up requested by #13. Keep it independent from PDF ingestion behavior and production deployment.
