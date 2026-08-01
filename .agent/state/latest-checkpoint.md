# Latest autonomous checkpoint

This file is intentionally short and machine-readable enough for a fresh VM
worker or handoff agent to resume without replaying the whole conversation.

- objective: `#113` — general, source-backed PDF/DOCX extraction and
  typesetting through STRUCT
- branch: `codex/issue-113-struct-typeset`
- pull-request: `#114` (draft; do not merge automatically)
- provider: `vm-codex`
- model: `gpt-5.6-sol`
- reasoning: `high`
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
   `rucksack-needs-human`/`rucksack-blocked` issue.
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
pass, and honors `~/.config/rucksack/overnight/erniesg-erniesg.hold`.

The queue is intentionally one worker at a time. Rucksack's bounded retry and
self-heal policy remains authoritative (two attempts, then a human gate).
Safe fallback is automatic; only a source comparison that identifies a page
and exact action may become user work.

Last evidence manifest: `.agent/evidence/20260801T074540748Z/manifest.json`.
Latest handoff artifact:
`/Users/erniesg/.codex/handoffs/erniesg-20260801-155555.md`.
