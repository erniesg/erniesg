# Latest autonomous checkpoint

This file is intentionally short and machine-readable enough for a fresh VM
worker or handoff agent to resume without replaying the whole conversation.

- objective: `#113` — general, source-backed PDF/DOCX extraction and
  typesetting through STRUCT
- branch: `codex/issue-113-struct-typeset`
- pull-request: `#114` (draft; do not merge automatically)
- provider: `vm-codex`
- future-worker-model: `gpt-5.6-luna`
- future-worker-reasoning: `max`
- active-worker-model-at-launch: `gpt-5.6-sol` / `high` (do not relabel)
- struct-typeset-skill-sha256: `3d96ae5ffb4a2c66a2cc6c393e4a1a89f0893dec2245998392636f0c13e6e37a`
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
   `rucksack-needs-human`/`rucksack-blocked` issue. #113/#115 are not runnable
   until specs 047/048 have default-branch provenance; never bypass that gate.
2. Run the source-versus-EPUB checkpoint for the current paper and attach the
   source/render screenshots plus deterministic metrics before changing a
   parser or renderer.
3. Keep extraction deterministic and candidate-constrained. Any successful
   model/layout proposal must become a fixture and a deterministic rule before
   the issue can close.
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
pass or any still-live repository issue tmux session, and honors
`~/.config/rucksack/overnight/erniesg-erniesg.hold`.

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
2026-08-01 08:18 and 08:44 UTC. The pulse timer is loaded/enabled/active, linger
is enabled, and the installed active-session guard skipped a manual probe
without dispatching another worker. Issues `#88` and `#92` remain detached and
leased; the pulse will wait until all live repository issue sessions exit.
The promised atomic per-pass JSON checkpoint is not implemented yet; spec 048
must add it in the fixed trusted runtime. Do not treat this Markdown file as
that runtime receipt.
Default-branch provenance is staged in app PR `#117` (linked issue `#116`).
After it merges, run an adopt/reconcile pass before expecting `#113` or `#115`
to remain queued. Rucksack's cross-pulse total-capacity defect is tracked by
`erniesg/rucksack#347` with ledger PR `erniesg/rucksack#348`; until that lands,
the installed repo pulse's live-session guard is the authoritative cap.
Latest handoff artifact:
`/Users/erniesg/.codex/handoffs/erniesg-20260801-155555.md`.
