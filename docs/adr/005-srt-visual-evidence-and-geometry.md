# ADR 005: SRT Visual Evidence and Geometry Diagnostics

## Status

Accepted for reproducible four-target evidence without an approved pixel baseline.

## Context

The four SRT profiles share canonical nodes and deterministic composition policy, but unit tests cannot detect browser-only clipping, overlap, or overflow. The next dependency-ready slice needs reviewable screenshots and mechanical geometry checks without silently accepting a visual baseline or implementing finite-height pagination early.

## Decision

Playwright `1.61.1` is an exact development dependency. Its bundled Chromium revision is installed from the lockfile on CI and the trusted VM:

```bash
npm ci
npx playwright install --with-deps chromium
```

`playwright.config.ts` fixes the browser engine, 1440 × 1200 CSS-pixel viewport, 1× device scale, UTC timezone, `en-US` locale, light color scheme, reduced motion, one worker, and zero retries. The test waits for `document.fonts.ready` before measuring. The site shell uses the repository's versioned Geist webfonts; the article uses the target profile's declared Georgia/Times/serif stack and the font packages installed by Playwright's operating-system dependency setup. Both CI and the trusted VM must use the command above rather than a system browser with ad hoc dependencies.

One browser test switches the single semantic article renderer through all four target profiles. It measures each rendition in the studio, then moves that fully composed paper element onto an isolated capture surface so sticky site chrome and the studio's scroll container cannot obscure the artifact. Target paper dimensions and composition styles remain unchanged. For each profile it writes a complete paper screenshot and records rendered dimensions, canonical node IDs, missing or duplicated nodes, clipped boxes, intersecting non-ancestor boxes, and horizontal overflow. A selected `e2e` evidence lane fails on any diagnostic and stores its screenshots, JSON geometry report, failure trace, and log beneath `.agent/evidence/`. These outputs remain CI/evidence artifacts and are ignored by Git.

The Playwright configuration sets `updateSnapshots: 'none'`. No pixel baselines are created in this issue because baseline creation or acceptance requires human review. CI never invokes a snapshot-update mode. A future reviewed baseline must also pin any font files needed for pixel-level portability before the golden images are accepted.

## Reproduction

Run the focused harness locally with:

```bash
npm run test:e2e
```

Run the full issue contract, including browser evidence, with:

```bash
scripts/agent-evidence --e2e
```

The dedicated agent-evidence workflow installs the pinned Chromium build, runs the full command, and uploads `.agent/evidence/` even when a browser assertion fails.

## Consequences

Every target now produces reviewable visual evidence and fails mechanically on missing content, clipping, overlap, or horizontal overflow. The geometry report remains inspectable instead of reducing failure to an opaque image difference.

The harness does not claim pixel equality and does not approve a visual baseline. ADR 006 subsequently extends these geometry diagnostics to explicit pages and fragments.

## Non-goals

This decision does not add pagination, fixture-specific coordinates, arbitrary PDF reconstruction, annotations, target overrides, exports, production deployment, or unattended golden-image updates.
