# Latest autonomous checkpoint

This file is intentionally short and machine-readable enough for a fresh VM
worker or handoff agent to resume without replaying the whole conversation.

- objective: `#113` — general, source-backed PDF/DOCX extraction and
  typesetting through STRUCT
- branch: `codex/issue-113-struct-typeset`
- pull-request: `#114` (draft; do not merge automatically)
- provider: `vm-codex`
- autonomous-vm-worker-model: `gpt-5.6-sol`
- autonomous-vm-worker-reasoning: `high`
- local-layout-consultation-model: `gpt-5.6-luna`
- local-layout-consultation-reasoning: `max`
- active-worker-model-at-launch: `gpt-5.6-sol` / `high` (do not relabel)
- vm-installed-struct-typeset-skill-sha256: `3d96ae5ffb4a2c66a2cc6c393e4a1a89f0893dec2245998392636f0c13e6e37a`
- branch-struct-typeset-skill-sha256: `40702cd6192a2ab50e97717e3c5cef61c5ddee87a94712e583e5819bd86c7a9a`
- max-workers: `1`
- drain-timeout: `30m`
- stop-timeout: `5m`
- benchmark: BookWorld plus held-out corpus
- human-gate: only after deterministic extraction, bounded candidate layout,
  local fallback, and source-versus-output comparison name an exact page and
  one action

## Resume order

1. Read the labels and comments for `#113`, then its dependencies (`#88`,
   `#91–#95`, `#104–#108`). Do not duplicate a `rucksack-running` lease or
   `rucksack-needs-human`/`rucksack-blocked` issue. Specs 047/048 now have
   verified default-branch provenance and #113/#115 are queued.
2. Run the source-versus-EPUB checkpoint for the current paper and attach the
   source/render screenshots plus deterministic metrics before changing a
   parser or renderer.
3. Keep extraction deterministic and candidate-constrained. Any successful
   model/layout proposal must become a fixture and a deterministic rule before
   the issue can close. Run local layout consultation as a separate Codex task
   with `gpt-5.6-luna` / `max`; never relabel an autonomous VM worker receipt.
4. Run focused TDD, `npm test`, `npm run build:astro`, and
   `scripts/agent-evidence`; record the manifest path in the issue/PR.
5. Commit a small, reviewable slice, push it, and leave the next exact issue
   and command in the checkpoint. Never commit the eight pre-existing user
   files listed in `AGENTS.md`.

## Overnight safety

The trusted VM drain is the only autonomous executor. It must report
`LoadState=loaded`, `UnitFileState=enabled`, `ActiveState=active`, a future
`list-timers` fire, and the repository service's `TimeoutStartUSec=30min` and
`TimeoutStopUSec=5min`. A masked or failed timer is a queue-health failure;
do not claim that work is running until the timer is explicitly re-enabled
after installer cleanup and rechecked.

The repo-owned pulse (`erniesg-struct-typeset-queue.timer`) is the durable
overnight scheduler. It sits outside Rucksack's generated drain-name hold
glob, wakes the proven drain service at most every 30 minutes, skips an active
pass, any VM issue tmux session, or any direct Codex `exec` worker, and honors
`~/.config/rucksack/overnight/erniesg-erniesg.hold`. Its process probes are
self-excluding and contain no systemd-consumed shell expansion.

The queue is intentionally one total live worker at a time. The repo pulse
currently enforces that cap around Rucksack's per-invocation `--max-workers 1`;
the durable total-slot fix belongs in Rucksack's trusted runtime. Rucksack's
bounded retry and self-heal policy remains authoritative (two attempts, then a
human gate).
Safe fallback is automatic; only a source comparison that identifies a page
and exact action may become user work.

Last evidence manifest: `.agent/evidence/20260801T081504739Z/manifest.json`
(`npm run build` and `npm run test` passed).
The first two pulse passes completed successfully on the trusted VM at
2026-08-01 08:18 and 08:44 UTC. Linger is enabled. A VM-owned transient waiter
`erniesg-issue-88-requeue.service` currently owns the only intentional timer
pause: it waits for unrelated Rucksack #226 work to exit, re-queues the exact
preserved #88 provider result, and restores the timer from an EXIT trap. #92
resumed from `f90aef7` without another model pass, passed clean publisher
evidence, and opened PR #118. Do not merge #118 until its recorded P1/P2
source-order, semantic-scope, indentation, and cross-page defects are repaired.
The promised atomic per-pass JSON checkpoint is not implemented yet; spec 048
must add it in the fixed trusted runtime. Do not treat this Markdown file as
that runtime receipt.
Default-branch provenance landed through app PR `#117`; the merged-main
reconcile adopted and queued #113/#115. Rucksack's cross-pulse pool-capacity
defect is #347, host-wide resource contention is #349, and evidence-only retry
before model self-heal is #350. All three are staged by ledger PR #348 at
`5144834`. That PR seeds provenance and must not close any implementation issue.
Until those fixes land, the installed pulse's VM-wide tmux/Codex guard is the
authoritative conservative cap.

The VM-owned controls make the current continuation laptop-free:

- App PR #121 merged at exact green head `5aa4583`. GitHub incorrectly closed
  implementation issue #119 by parsing negative prose as a closing keyword;
  #119 was explicitly reopened, adopted from merged spec 049, and queued.
- `erniesg-issue-88-requeue.service` completed after unrelated Rucksack issue
  #226 exited. It re-queued the preserved #88 provider result without another
  implementation pass and restored the repo timer.
- `erniesg-issue-88-pr-hold.service` is now a persistent enabled user unit,
  explicitly clears provider secrets, survives reboot, and applies a
  deduplicated GitHub merge hold to the future #88 PR until the pinned real
  provider adapter, importer/operator wiring, and actual BookWorld-plus-held-out
  comparison are present.
- App PR #122 merged the owner-requested `gpt-5.6-sol` / `high` profile into
  default-branch spec 048. The same pair is verified in the live VM Codex
  configuration.

PR #118 is green but deliberately `rucksack-blocked`; repair its four recorded
generalization defects before merge. PR #114 remains draft because the product
acceptance benchmark is not met. The Codex queue needs no user action. One
separate security action remains: rotate and re-authenticate the VM Claude Code
OAuth credential after a failed custom watcher invocation wrote the inherited
value to the private VM user journal. The manager environment was cleared,
Claude logout was run, the active token-env source was moved into a mode-`0600`
quarantine, and all replacement units explicitly unset provider secrets; do
not reuse the exposed credential.
Latest handoff artifact:
`/Users/erniesg/.codex/handoffs/erniesg-20260801-182730.md`.
