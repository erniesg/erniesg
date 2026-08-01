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
  an exact live session consumes the global slot before selection. Preserve a
  worker whose process is still live even when its heartbeat has expired; a
  completed or expired process-free session frees the slot. Missing,
  malformed, or conflicting session state fails closed. Reconcile GitHub
  labels and exact issue leases before dispatch; never duplicate a running or
  human-blocked issue.
- Keep parser-core work serialized through declared dependencies. Evidence or
  evaluation work may run in parallel only when its declared path/resource
  scope is disjoint from the active worker.
- Preflight disk capacity before dispatch. At the configured high-water mark,
  preserve the active lease, handoffs, receipts, evidence, and referenced
  artifacts. Reclaim only an explicitly checkpointed terminal, clean worktree
  or a cache inside the dedicated reproducible-cache root. If safe reclamation
  does not restore the configured headroom, launch nothing and record the exact
  queue-health blocker.
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
  skill and record its SHA-256 in each applicable worker receipt. Future layout
  workers use the owner-requested `gpt-5.6-sol` / `high` VM profile;
  already-running workers keep their recorded model and are never relabeled
  retroactively.
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
  or handoff path remain untouched. Cleanup accepts only a terminal checkpoint
  with the exact worktree and source SHA, or a path beneath the dedicated
  reproducible-cache root. Every worktree-local log/reference must first have
  a checksum-verified durable copy outside that worktree. Insufficient
  post-cleanup headroom launches nothing.
- An interrupted worker, completed worker, and provider-blocked worker each
  leave one atomic checkpoint with a resumable next action and no duplicate
  lease.
- Two consecutive pulse passes keep the repo-owned scheduler enabled while the
  generated drain may be held during a worker pass, and never exceed the total
  configured session cap.
- A future applicable worker receipt identifies `gpt-5.6-sol`, `high`, and the
  exact installed `struct-typeset` skill digest. Stubbed tests do not require a
  live provider credential.
- A later two-lane scheduler may run at most one parser-core worker plus one
  evidence/eval worker only when both carry versioned resource claims, their
  write scopes and ports are disjoint, and measured disk and memory headroom
  pass under the dispatch lock. Unknown claims, overlapping scopes, or low
  headroom retain the total cap of one. This cross-pulse selection belongs to
  Rucksack issues `erniesg/rucksack#347` and `erniesg/rucksack#349`; the repo
  pulse must not guess it from process names.

## Validation command

```bash
npx vitest run tools/struct-queue-pulse.test.mjs
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
lease, increasing worker/retry limits without verified resource claims,
treating a masked timer as idle, deleting an uncheckpointed worktree or
evidence artifact, or claiming unattended completion without a durable
checkpoint and future timer fire.

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
or installer cleanup from silently disabling future work. The conservative
one-worker default avoids duplicate edits and makes evidence ordering
deterministic. Verified resource claims can later recover one disjoint
evidence/eval lane without turning every 30-minute pulse into another parser
worker.

## Free-form response

Overnight development is successful when a disconnected laptop changes nothing:
the VM keeps one bounded pass moving, records what happened, and leaves the next
worker an exact command rather than a mystery state.

## Definition of done

Two consecutive unattended queue passes leave the selected timer active and
produce durable checkpoints. A fresh VM worker can continue the next ready
issue without conversation context, duplicate dispatch, or an unexplained
"idle" result.
