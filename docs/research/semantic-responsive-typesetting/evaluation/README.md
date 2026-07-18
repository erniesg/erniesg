# SRT POC evaluation package

This package evaluates one trusted structured scholarly fixture across continuous mobile, reMarkable Paper Pro Move, reMarkable Paper Pro, and A4 print. It measures engineering invariants; it is not a corpus benchmark, systematic review, or human-subject study.

## Reproduce

Use Node and npm versions compatible with `package.json`, do not supply secrets, and run from the repository root:

```bash
npm ci
npm test
npm run build
npm run srt:evaluate -- --write
scripts/agent-evidence --all
git diff --check
```

`npm run srt:evaluate` is the demo script. It builds the staging research pages, runs the existing deterministic Playwright visual test against that static output without a network server, captures browser geometry and annotation/anchor outcomes for all four targets, composes each target in the same evaluator process, repeats each warm timing 50 times, builds the same-source fixed PDF, and prints JSON. `--write` regenerates the checked-in report package. The normal `npm run test:e2e` development-server mode is unchanged.

To reuse an existing geometry report without relaunching Chromium:

```bash
npm run srt:evaluate -- --geometry .agent/evidence/playwright/path/to/geometry-report.json --write
```

The geometry report must use the `1.0.0` object shape emitted by `tests/e2e/srt-visual.spec.ts`. Timing and `generatedAt` fields are expected to change between machines and runs; structural counts, preservation ratios, fallback counts, and fixed-PDF checksum should remain stable for unchanged source and policy versions.

## Artifacts

- [`benchmark-report.md`](./benchmark-report.md): human-readable measurements and baseline boundaries.
- [`results.json`](./results.json): complete machine-readable result.
- [`geometry-results.json`](./geometry-results.json): raw per-target Chromium geometry evidence from the recorded run.
- [`limitations.md`](./limitations.md): explicit known failures, exclusions, and generalization limits.
- [`adr-index.md`](./adr-index.md): current SRT architecture decisions.
- [`evidence-manifest.json`](./evidence-manifest.json): hashes for the evaluation inputs and outputs. Repository command outcomes remain in `.agent/evidence`.
- [`tools/srt/demo-evaluation.mjs`](../../../../tools/srt/demo-evaluation.mjs): executable evaluator/demo orchestration.

## Interpretation

Zero clipping or overlap means only that the recorded Chromium run found none in this golden fixture at the fixed test environment and tolerances. A 100% preservation ratio means the manifest retained the expected fixture objects; it is not evidence of semantic correctness on arbitrary PDFs. Composition timing excludes module load, browser startup, PDF ingestion, network, and reader interaction.

The fixed-PDF row is the deterministic export produced from this same canonical fixture, so it is not independent. No validated same-content geometric-reflow baseline exists in the repository; its result remains unavailable instead of being replaced with a proxy.
