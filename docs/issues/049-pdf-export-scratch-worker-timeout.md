# Make killed-worker PDF scratch cleanup tests event-driven under load

## Provider

vm-codex

## Goal

Make the killed-worker PDF export regression deterministic under normal
parallel test load without increasing or weakening the production document
deadline. The test must prove worker-tree termination and workspace cleanup
from observable lifecycle events, not machine-speed sleeps.

## Observed failure

`tools/pdf-export.test.mjs` gives the isolated export job a real three-second
deadline. The scratch-worker fixture writes `observation.json` only after a
second PDF pipeline has started Vite and loaded SSR modules. Under parallel VM
load the worker can be correctly killed before that write. The exporter then
publishes `PDF_DOCUMENT_TIMEOUT` and removes the workspace, while the test
polls up to 30 seconds for a file that can no longer appear. Vitest reaches the
same 30-second outer budget and reports a false failure. The test passed alone
in 7.51 seconds and the full suite passed with one Vitest worker.

## Required behavior

- Preserve the real production timeout, process-tree kill, output isolation,
  and per-document workspace cleanup semantics.
- Make the fixture publish observable scratch-directory readiness before it
  waits for full Vite SSR startup or module loading.
- Drive the parent timeout deterministically with an injected/fake timer in the
  test. Do not make success depend on CPU speed, sleeps, or serial-only config.
- Restore real timers and await or abort every pending task in `finally` so the
  test cannot leak a worker, Vite server, timer, or temporary directory.

## Acceptance tests

- A delayed Vite/module-load seam reproduces the old harness race and the new
  event-driven test still completes within its bounded test timeout.
- Advancing exactly the configured 3,000 ms produces `PDF_DOCUMENT_TIMEOUT`.
- The worker process tree exits, the observed `srt-pdf-vite-*` directory lives
  inside per-document staging, and staging plus cache are deleted afterward.
- The output directory contains only `corpus-audit.json` after the timeout.
- The focused test passes repeatedly with normal Vitest parallelism, then the
  full `npm test` and repository evidence lanes pass under constrained VM load.
- No deadline increase, retry loop, global serialization, or paper-specific
  behavior is introduced.

## TDD sequence

1. Add a delayed-start regression that fails against the current polling
   harness.
2. Move fixture readiness observation ahead of full Vite/SSR initialization.
3. Start `processExportDocuments` without awaiting, wait for the readiness
   event with a real-Date bounded helper, advance the fake parent deadline, and
   await the result.
4. Add `finally` cleanup assertions and repeat the focused test under ordinary
   parallel settings before running the full suite.

## Likely files

- `tools/pdf-export.test.mjs`
- `tests/fixtures/pdf-export-scratch-worker.mjs`

Keep `tools/pdf-export.mjs` unchanged unless a minimal injected timer seam is
strictly required and covered by production-behavior tests.

## Validation command

```bash
npx vitest run tools/pdf-export.test.mjs -t "keeps killed-worker Vite scratch inside the discarded document workspace"
npx vitest run tools/pdf-export.test.mjs
npm test
scripts/agent-evidence
```

## Allowed secrets

None. All tests use generated fixture workspaces and local child processes.

## Artifact outputs

The event-driven fixture/test regression, repeated focused-run logs, and a full
evidence manifest showing the timeout/cleanup proof passes under normal
parallelism.

## Stop conditions

Stop before raising the production deadline, weakening process-tree cleanup or
private-path isolation, adding a sleep-based workaround, forcing the whole test
suite serial, or hiding the timeout assertion.

## Human clarification protocol

No human decision is expected. If the event cannot be observed without a
production seam, report the exact missing lifecycle boundary and propose one
minimal injected callback/timer interface before changing production code.

## Recommended response

Make readiness and timeout explicit test events. Preserve the three-second
production contract and prove cleanup after advancing that exact deadline.

## Trade-offs

A small fixture/timer seam adds test plumbing, but it removes a 30-second flaky
poll and avoids wasting full model self-heal and evidence passes on machine
load. Keeping production semantics fixed is more important than minimizing
test-only code.

## Free-form response

The regression should fail only when cleanup is wrong, never because Vite was
slower than the VM on that run.
