# Pluggable OCR engines: Apple Vision local backend and explicit opt-in remote worker

depends-on: 014,017

labels: rucksack-blocked

## Provider

vm-codex

## Goal

Generalize the issue-014 OCR integration behind an engine interface so alternative engines can be benchmarked and selected per run: the vendored Tesseract engine stays the default everywhere, an Apple Vision backend becomes available in the headless CLI on macOS hosts, and a remote GPU worker backend (for example Modal running a document OCR model) exists only as an explicit, documented opt-in that is disabled by default. Held until the issue-017 corpus benchmark reports Tesseract accuracy on the scanned corpus documents; if Tesseract clears the completeness gate on them, this issue should be closed unstarted.

## Acceptance tests

- An OCR engine interface carries the issue-014 contract unchanged: word and line bounding boxes, confidence, page rotation, engine and model versions, and source hashes; the existing Tesseract path becomes the reference implementation with no behavior change and remains the default.
- On macOS hosts, the headless CLI can select an Apple Vision engine that fulfills the same contract via a small local helper invoked per page image; on non-macOS hosts the engine reports itself unavailable with a named diagnostic instead of failing obscurely.
- A remote engine adapter defines the request and response schema for a self-hosted GPU OCR worker, is disabled by default, requires an explicit per-run flag plus an environment-variable endpoint to activate, and refuses to run when the completeness policy marks the document private; activating it is recorded in provenance and the export manifest.
- The corpus benchmark from the issue-017 work can run the same scanned fixtures through each available engine and report per-engine accuracy, gate pass-rate, and per-page latency side by side.
- Engine selection, versions, and provenance appear in the reconstruction diagnostics so two runs with different engines are distinguishable artifacts.
- Browser studio behavior is unchanged: it uses only the bundled local engine.

## Validation command

```bash
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

A remote OCR endpoint URL and token as environment-variable names only, read exclusively by the opt-in remote adapter; never written to files, logs, or evidence. All default paths require no secrets.

## Artifact outputs

Engine interface refactor, Apple Vision CLI backend with availability diagnostics, remote adapter schema and opt-in gating, per-engine benchmark report, and provenance evidence.

## Stop conditions

Stop before making any remote engine a default or silent fallback, uploading document bytes without the explicit opt-in flag, adding a hosted OCR SaaS dependency, or duplicating the issue-014 merge and review semantics per engine.

## Human clarification protocol

If Apple Vision cannot express word-level boxes for a script the corpus needs, present the observable accuracy difference against Tesseract and ask whether line-level boxes are acceptable for that engine.

## Recommended response

Keep this issue held until the issue-017 benchmark quantifies Tesseract on the real scanned documents; only the measured gap justifies the added surface, and the engine interface should be extracted in the smallest refactor that leaves the issue-014 tests green.

## Trade-offs

Multiple engines add configuration surface and test matrix cost for accuracy the corpus may not need; the opt-in remote path trades the local-only privacy guarantee for GPU-class accuracy and speed, which is why it must stay off by default with activation recorded in provenance.

## Free-form response

Only 18 of the 72 corpus documents require OCR at all, so engine work is deliberately sequenced behind the benchmark rather than ahead of it; the owner's interest is cheap serverless OCR (Modal-style scale-to-zero GPU) if and only if local engines prove insufficient.
