# Rucksack Autopilot Drain Timer

This repo includes a user-level systemd timer for a trusted VM to check the
queue every 30 minutes and drain VM-routed GitHub Issues into detached
Codex/Claude sessions.

Prerequisites on the VM:

```bash
command -v rucksack
command -v gh
rucksack github token erniesg/erniesg --role developer --execute >/dev/null
```

Install or update the timer from the repository root:

```bash
rucksack vm autopilot install-timer erniesg/erniesg --repo-root . --profile dev-vm --execute
```

Configure Discord notifications on the VM if you want human-gate pings outside
GitHub. The command opens an SSH prompt and stores the webhook only in the VM
user environment file:

```bash
rucksack vm autopilot discord erniesg/erniesg --profile dev-vm --execute
```

Manual equivalent:

```bash
mkdir -p ~/.config/systemd/user
cp infra/vm/systemd/rucksack-autopilot-erniesg-erniesg-drain.service ~/.config/systemd/user/
cp infra/vm/systemd/rucksack-autopilot-erniesg-erniesg-drain.timer ~/.config/systemd/user/
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now rucksack-autopilot-erniesg-erniesg-drain.timer
systemctl --user list-timers rucksack-autopilot-erniesg-erniesg-drain.timer
systemctl --user status rucksack-autopilot-erniesg-erniesg-drain.timer
```

`loginctl enable-linger "$USER"` lets the trusted VM keep the user timer active
after the SSH session disconnects.

Inspect runs:

```bash
journalctl --user -u rucksack-autopilot-erniesg-erniesg-drain.service -f
```

Manual equivalent:

```bash
rucksack autopilot self-heal erniesg/erniesg --repo-root . --provider vm-codex --request-review codex --execute
rucksack autopilot work-queue erniesg/erniesg --provider vm-codex --max-workers 2 --local --repo-root . --issue-dir docs/issues --reconcile-issues --plan-when-idle --check-provider-ready --notify-github-when-blocked --execute
```

The queue drain first classifies awaiting-review PRs into repair, waiting for
checks, waiting for re-review, merge-ready, or merge-blocked states. It then
checks Codex/Claude readiness after selecting runnable work but before acquiring
VM leases. If provider login is missing or expired, the timer leaves issues
queued and refreshes the human-gate notification instead of starting failing
workers.

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
disposable VM worktrees with repo-scoped credentials.

The timer file contains only repo names and command flags. It mints a
short-lived repo-scoped Rucksack GitHub App token at runtime; keep App PEMs and
provider auth stores on the VM, not in this repository.
