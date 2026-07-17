# SRT evaluation package, benchmarks, and limitations

depends-on: 017

## Provider

vm-codex

## Goal

Produce the reproducible POC evaluation package without overstating novelty or converting the scoping review into a claimed systematic review.

## Acceptance tests

- Measure structural coverage, relationship preservation, clipping/overlap, annotation survival, anchor stability, composition time, and fallback counts across four targets.
- Compare fixed PDF, geometric reflow when available, and semantic rendition without manufacturing unavailable baselines.
- Document reference hardware/runtime, warm/cold behavior, sample size, and limitations.
- Include ADR index, demo script, evidence manifest, and reproducibility instructions.
- Novelty language remains qualified as `to our knowledge` pending systematic database search and citation chaining.

## Validation command

```bash
npm test
npm run build
scripts/agent-evidence --all
```

## Allowed secrets

None. Bibliographic database or subscription sessions may be used only interactively on the trusted VM and must not enter artifacts.

## Artifact outputs

Benchmark report, machine-readable results, demo script, limitations log, ADR index, and evidence bundle.

## Stop conditions

Stop before making publication novelty claims, enrolling users, deploying production, or accessing subscription databases without human authorization.

## Human clarification protocol

Create a decision request linking the exact claim, missing evidence, and smallest human-run research step.

## Recommended response

Ship an honest POC report first and maintain a separate publication-research checklist.

## Trade-offs

A narrow evaluation supports fewer general claims but makes the integrated contribution falsifiable and reproducible.

## Free-form response

Do not let benchmark polish hide renderer failures or unresolved research gaps.
