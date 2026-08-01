# Keep the trusted VM drain active and make overnight work resumable

depends-on: 047

## Provider

vm-codex

## Goal

Make unattended development safe and efficient after the laptop closes. A
successful queue pass must not silently leave the repo timer masked, and every
pass must leave enough durable state for the next worker or handoff to resume
without repeating work.

## Required behavior

- Activate only the selected repository timer after bubblewrap and
  system-manager network-isolation proofs pass. Keep every other repository
  drain held.
- After installation cleanup and after each queue pass, verify the selected
  timer is loaded, enabled, active, has a future fire, and the service has the
  repository timeout policy (`30m` start, `5m` stop). A mask or failed state is
  a queue-health failure, not a successful idle result.
- Keep one VM worker at a time. Reconcile GitHub labels and exact issue leases
  before dispatch; never duplicate a running or human-blocked issue.
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

## Tests and evidence

- Unit-test timer-state and checkpoint parsing with a fake systemd/queue
  response.
- Exercise an interrupted worker, a completed worker, and a masked timer; all
  three must produce an explicit resumable state.
- Run the full repository evidence command and a held-out STRUCT corpus pass.

## Definition of done

Two consecutive unattended queue passes leave the selected timer active and
produce durable checkpoints. A fresh VM worker can continue the next ready
issue without conversation context, duplicate dispatch, or an unexplained
"idle" result.
