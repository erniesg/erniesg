# Keep the trusted VM drain active and make overnight work resumable

## Provider

vm-codex

## Goal

Make unattended development safe and efficient after the laptop closes. A
successful queue pass must not silently leave the repo timer masked, and every
pass must leave enough durable state for the next worker or handoff to resume
without repeating work. This issue supports spec 047 and must be runnable before
that product umbrella completes.

## Required behavior

- Activate only the selected repository timer after bubblewrap and
  system-manager network-isolation proofs pass. Keep every other repository
  drain held.
- After installation cleanup and after each queue pass, verify the selected
  timer is loaded, enabled, active, has a future fire, and the service has the
  repository timeout policy (`30m` start, `5m` stop). A mask or failed state is
  a queue-health failure, not a successful idle result.
- Enforce one total live VM issue session for this repository across repeated
  pulse invocations. `--max-workers 1` is only a per-invocation launch limit;
  active unexpired leases/sessions consume the global slot before selection.
  Reconcile GitHub labels and exact issue leases before dispatch; never
  duplicate a running or human-blocked issue.
- Preflight disk capacity before dispatch. At the configured high-water mark,
  preserve the active lease, handoff, evidence receipts, and referenced
  artifacts; reclaim only completed/expired worktrees and reproducible caches
  whose owning run has an atomic checkpoint. Never clean during an active run,
  and fail closed with a queue-health checkpoint if safe reclamation cannot
  restore the required headroom.
- Keep parser-core work serialized through declared dependencies. Evidence or
  evaluation work may run in parallel only when its declared path/resource
  scope is disjoint from the active worker.
- Record an atomic checkpoint after each pass: issue, branch/PR, source SHA,
  evidence manifest, tests, visual source/output artifacts, next issue, and
  failure class. A reconnecting agent must be able to resume from it.
- Use bounded retries/self-heal. After the configured two attempts, retain the
  issue's actionable failure and move it to a human gate; do not spin forever.
- Require source-vs-render comparison and the local readable fallback before
  exposing human work. User work must name one page/region and one exact
  action; internal diagnostic counts stay in evidence, not the UI.
- Keep model/layout calls optional and candidate-constrained. Persist every
  accepted proposal and distill it into a fixture plus deterministic rule.
- Install the default-branch `struct-typeset` skill as a pinned, read-only VM
  skill and record its SHA-256 in each applicable worker receipt. Autonomous VM
  implementation workers use `gpt-5.6-sol` / `high`. An on-demand local layout
  consultation is a separate Codex task using `gpt-5.6-luna` / `max`; record a
  separate receipt and never conflate it with the implementation worker. An
  already-running worker keeps its launch model and is never relabeled.
- Resolve the generated drain through an installer-owned stable target alias or
  validated state file rather than a repository-hard-coded unit version.

## Tests and evidence

- Unit-test timer-state, total active-slot accounting, stable target resolution,
  disk high-water handling, skill digest recording, and checkpoint parsing with
  fake systemd/queue/session responses.
- Exercise an interrupted worker, a completed worker, and a masked timer; all
  three must produce an explicit resumable state.
- Run the full repository evidence command and a held-out STRUCT corpus pass.

## Acceptance tests

- A fake systemd response for a healthy timer is accepted only when it is
  loaded, enabled, active, and has a future fire; masked, failed, or missing
  state is reported as queue-health failure.
- At total capacity one, one live session plus one queued issue launches
  nothing; a completed/expired session frees exactly one slot. Missing or
  malformed lease state fails closed for recovery instead of opening a slot.
- At the disk high-water mark, an active worktree and every referenced evidence
  artifact remain untouched. Only a completed/expired worktree with a durable
  checkpoint and reproducible cache entries are eligible; insufficient safe
  reclamation launches no worker and records the exact capacity blocker.
- An interrupted worker, completed worker, and provider-blocked worker each
  leave one atomic checkpoint with a resumable next action and no duplicate
  lease.
- Two consecutive pulse passes keep the repo-owned scheduler enabled while the
  generated drain may be held during a worker pass, and never exceed the total
  configured session cap.
- A future autonomous VM worker receipt identifies `gpt-5.6-sol`, `high`, and
  the exact installed `struct-typeset` skill digest. Any local layout
  consultation has its own receipt identifying `gpt-5.6-luna`, `max`, the
  bounded candidates supplied, and the accepted or rejected proposal. Stubbed
  tests do not require a live provider credential.

## Validation command

```bash
systemd-analyze verify infra/vm/systemd/erniesg-struct-typeset-queue.service infra/vm/systemd/erniesg-struct-typeset-queue.timer
infra/vm/verify.sh
scripts/agent-evidence
```

## Allowed secrets

None in the repository or checkpoints. GitHub/provider credentials remain in
the trusted VM stores and are minted only by the fixed parent runtime.

## Artifact outputs

The repo-owned pulse units, durable checkpoint, systemd/timer verification,
queue labels and lease receipts, source-versus-render evidence manifest, and a
plain-language blocked/resumable status.

## Stop conditions

Stop before automatically clearing an operator hold, dispatching a duplicate
lease, increasing worker/retry limits, treating a masked timer as idle, or
claiming unattended completion without a durable checkpoint and future timer
fire.

## Human clarification protocol

Ask only when the queue reaches a named external gate (provider login, source
comparison decision, or publication-bundle review). Include the exact issue,
page/region or gate, the one action required, and the command that resumes it.

## Recommended response

Keep the generated Rucksack drain as the proven execution boundary and add a
small repo-owned scheduler outside its containment glob. Checkpoint every pass
so restarting is cheaper and safer than rerunning a whole corpus.

## Trade-offs

The extra pulse unit adds one scheduler to verify, but it prevents a long worker
or installer cleanup from silently disabling future work. One worker at a time
reduces throughput while avoiding duplicate edits and makes evidence ordering
deterministic.

## Free-form response

Overnight development is successful when a disconnected laptop changes nothing:
the VM keeps one bounded pass moving, records what happened, and leaves the next
worker an exact command rather than a mystery state.

## Definition of done

Two consecutive unattended queue passes leave the selected timer active and
produce durable checkpoints. A fresh VM worker can continue the next ready
issue without conversation context, duplicate dispatch, or an unexplained
"idle" result.
