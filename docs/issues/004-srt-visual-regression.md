# SRT visual regression and geometry diagnostics

depends-on: 003

## Provider

vm-codex

## Goal

Add reproducible visual evidence for all four targets and mechanically detect clipping, overlap, and unexpected overflow.

## Acceptance tests

- Playwright or an equivalent pinned browser captures all four target renditions.
- Font and viewport setup is documented and reproducible on CI and the trusted VM.
- Geometry assertions detect clipping, overlap, missing nodes, and horizontal overflow.
- Baseline changes are never accepted automatically.
- Generated screenshots and traces are CI/evidence artifacts; only reviewed golden baselines are tracked.

## Validation command

```bash
npm test
npm run build
scripts/agent-evidence --e2e
```

## Allowed secrets

None.

## Artifact outputs

Four screenshots, geometry report, browser trace on failure, and test logs.

## Stop conditions

Stop for human approval before creating or updating visual baselines.

## Human clarification protocol

Attach before/after screenshots and identify whether the change is intentional, a renderer correction, or unexplained drift.

## Recommended response

Land the harness with deliberately reviewed initial baselines, then block unattended baseline rewrites.

## Trade-offs

Pinned browsers and fonts add setup cost but make overnight visual evidence meaningful.

## Free-form response

Do not weaken pixel or geometry checks merely to obtain a green run.
