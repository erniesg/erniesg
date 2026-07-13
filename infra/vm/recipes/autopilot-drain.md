# Rucksack Autopilot Drain Timer

This repo includes a held, future user-level systemd timer for a trusted VM to
check the queue every 30 minutes and drain VM-routed GitHub Issues into detached
Codex/Claude sessions. The installer keeps all drain timers disabled until
agent and publisher credentials use separate Unix identities.

Prerequisites on the VM:

```bash
command -v rucksack
command -v gh
rucksack github token erniesg/erniesg --role developer --execute >/dev/null
```

Install or update the held timer and credential-gated daily CLI updater from the repository root:

```bash
rucksack vm autopilot install-timer erniesg/erniesg --repo-root . --profile dev-vm --execute
```

Configure Discord notifications on the VM if you want human-gate pings outside
GitHub. The command opens an SSH prompt and stores the webhook only in the VM
user environment file:

```bash
rucksack vm autopilot discord erniesg/erniesg --profile dev-vm --execute
```

Manual equivalent for the repo-specific queue timer only:

```bash
mkdir -p ~/.config/systemd/user
cp infra/vm/systemd/rucksack-autopilot-v1-ZXJuaWVzZy9lcm5pZXNn-drain.service ~/.config/systemd/user/
cp infra/vm/systemd/rucksack-autopilot-v1-ZXJuaWVzZy9lcm5pZXNn-drain.timer ~/.config/systemd/user/
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user disable --now rucksack-autopilot-v1-ZXJuaWVzZy9lcm5pZXNn-drain.timer
systemctl --user status rucksack-autopilot-v1-ZXJuaWVzZy9lcm5pZXNn-drain.timer
```

`loginctl enable-linger "$USER"` keeps the user service manager available after
the SSH session disconnects. It does not enable the held drain timer. The daily
updater is available only after publisher credentials move to another Unix
identity.

The recommended `rucksack vm autopilot install-timer` command leaves the drain
timer disabled until agent and publisher credentials use separate Unix
identities. It embeds the
host-global updater from the trusted local Rucksack package only when that
account has no publisher credentials; otherwise it preserves both updater
definitions in the user systemd data directory behind higher-priority masks.
It never executes an updater copied from the target project
checkout. When enabled, managed Codex and Claude Code CLIs update together once
daily with jitter. Busy workers and
transient npm failures retry at bounded intervals, while permanent local-path or
tooling errors wait for the next daily run after an operator repairs the VM.
The 30-minute queue drain no longer runs a package update on every poll.

Inspect runs:

```bash
journalctl --user -u rucksack-autopilot-v1-ZXJuaWVzZy9lcm5pZXNn-drain.service -f
```

Manual equivalent:

```bash
rucksack autopilot review-repair erniesg/erniesg --provider vm-codex --execute
rucksack autopilot self-heal erniesg/erniesg --repo-root . --provider vm-codex --request-review codex --execute
rucksack autopilot work-queue erniesg/erniesg --provider vm-codex --max-workers 1 --local --repo-root . --issue-dir docs/issues --reconcile-issues --check-provider-ready --notify-github-when-blocked --execute
```

The queue drain first inspects unresolved review threads and requeues safe
same-repository repair work. Only after that succeeds does self-heal classify
remaining awaiting-review PRs into waiting for checks, waiting for re-review,
merge-ready, or merge-blocked states. It then
checks Codex/Claude readiness after selecting runnable work but before acquiring
VM leases. If provider login is missing or expired, a supervised manual drain
leaves issues queued and refreshes the human-gate notification instead of
starting failing workers. The timer follows the same behavior only after a
future human enables it behind the separate publisher boundary.

The held timer deliberately omits `--plan-when-idle`: a planner may write
partial or successful issue specs, and the durable base checkout must stay
clean. Generate and commit new ledger specs through an operator-owned
disposable worktree before the VM reconciles them.

Review repair fails closed on GraphQL errors, malformed or truncated GitHub
review data, and ambiguous App marker identity. It trusts the configured
Rucksack App slug for reads and updates only markers owned by the active
OAuth user. App-authored markers are append-only, and every new marker POST is
verified against the configured App or current owner before labels move. Repair pushes
compare the expected source SHA, hold the issue during post-push verification,
and return it to review only after the completion marker and final label
transition are both durable. Repeated 30-minute passes recognize the trusted
exact-head repair marker and leave queued or running repair workers unchanged.

Add `--notify-when-blocked` to the manual queue drain only after configuring the
VM Discord webhook with `rucksack vm autopilot discord`; GitHub notification
works without Discord.

When GitHub comments a `vm-codex` or `claude` provider handoff, run the VM
issue worker from the trusted machine:

```bash
rucksack autopilot work erniesg/erniesg --issue ISSUE_NUMBER --provider vm-codex --execute
```

The worker uses the existing VM checkout and local `gh`/agent auth stores,
pushes a provider branch, and opens or reuses a PR.

The Codex VM worker uses `--sandbox danger-full-access` because common free OCI
VMs cannot run Codex's bubblewrap workspace sandbox. Use it only on trusted or
disposable VM worktrees. Clearing `GH_TOKEN` and `GITHUB_TOKEN` prevents
accidental inheritance, but it is not a security boundary while the agent runs
as the same Unix user that owns the GitHub App PEM. Keep autonomous timers
disabled until write authority is moved behind a separate Unix user/service or
external publisher with a bounded patch/receipt interface.

The timer file contains only repo names and command flags. It mints a
short-lived repo-scoped Rucksack GitHub App token separately for each trusted
GitHub command. Token-bearing Git fetches and pushes use a disposable bare
transport with system/global config ignored, hooks disabled, a fixed GitHub
HTTPS URL, and an expected-old-SHA compare-and-swap for repairs. Provider,
validation, repo-hook, and tmux children never inherit `GH_TOKEN` or
`GITHUB_TOKEN`. This protects against accidental propagation only; the App PEM
must be inaccessible to the agent Unix user before treating the VM lane as a
least-privilege autonomous boundary. Keep App PEMs and provider auth stores on
the VM, not in this repository.
