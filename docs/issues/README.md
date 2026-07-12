# Rucksack Issue Ledger

This directory stores reviewable markdown issue specs for `erniesg/erniesg`.

Generate or update specs with:

```bash
rucksack github issues plan erniesg/erniesg --repo-root . --issue-dir docs/issues --execute
```

After reviewing the generated specs, seed or update GitHub issues:

```bash
rucksack github issues seed erniesg/erniesg --issue-dir docs/issues --label rucksack-ledger --label rucksack-queued --execute
gh workflow run rucksack-autopilot.yml --repo erniesg/erniesg -f action=queue
```

The GitHub issues are the live queue. Use `/rucksack run #123`, `/rucksack queue`,
or labels such as `rucksack-queued` and `rucksack-run` to dispatch work. When
Rucksack asks for a decision, reply `/rucksack accept`, `/rucksack approve`, or
`/rucksack resolve` on the issue to clear decision/blocker labels and queue it.
For human-unlocked gates that need trusted local or VM proof first, reply
`/rucksack accept-proof #123`; GitHub will hold the issue for
`rucksack autopilot resolve erniesg/erniesg --issue 123 --decision accept --repo-root <checkout> --run-post-unlock --execute`
instead of dispatching cloud work immediately.
When review evidence is accepted, use `/rucksack done #123` or
`rucksack autopilot resolve erniesg/erniesg --issue 123 --decision done --execute` to
close the reviewed issue without dispatching more implementation work.

Issue specs may include an optional `## Provider` section to route one issue
away from the repo default:

```markdown
## Provider

claude
```

`provider` routes one issue to `codex-action`, `vm-codex`, or `claude` while
unmarked issues use the repo default. Specs may also include top-level
`depends-on: 001,002` metadata immediately under `# Title` to keep an issue
queued until each dependency is closed or labeled `rucksack-awaiting-review`;
dependency cycles are rejected when specs are seeded.

For local-first overnight checks before a remote queue exists, select the next
ready checked-in spec without requiring GitHub:

```bash
rucksack autopilot next erniesg/erniesg --repo-root . --issue-dir docs/issues --provider vm-codex
```

Local-only ledgers can mark reviewed or held specs with top-level `state: done`
or `labels: rucksack-blocked`; the GitHub-backed queue remains the live source
once issues are seeded. After a local work slice validates, prepare PR-ready
text without requiring an `origin` remote:

```bash
rucksack autopilot submit erniesg/erniesg --issue 123 --repo-root . --execute
```

## Label state machine

These labels are Rucksack's GitHub Issues state machine. They are not topic
tags; they let GitHub Actions, a trusted VM, and humans recover queue state from
the repository without a separate database.

| Label | Meaning |
|---|---|
| `rucksack-ledger` | Generated or synced from markdown specs. |
| `rucksack-queued` | Ready for the queue drain. |
| `rucksack-run` | Manual run-this-now trigger. |
| `rucksack-running` | Build workflow is running or leased. |
| `rucksack-needs-clarification` | Definition of done is unclear; ask/ping before building. |
| `rucksack-needs-decision` | Rucksack recommended a path and needs human approval. |
| `rucksack-needs-human` | Human login/secret/action is required. |
| `rucksack-provider-limited` | Provider quota or subscription limit paused this issue. |
| `rucksack-out-of-work` | No ready implementation work remains; recommend or seed more. |
| `rucksack-blocked` | Failed, held, or waiting on external action. |
| `rucksack-awaiting-review` | PR/evidence is ready for review. |
| `rucksack-review-feedback` | Actionable review feedback was found and repair was requeued. |
| `rucksack-waiting-checks` | Fresh PR checks are still pending or missing. |
| `rucksack-waiting-rereview` | PR is waiting for reviewer re-review. |
| `rucksack-merge-ready` | PR is eligible for merge-policy handling. |
| `rucksack-merge-blocked` | Merge policy blocks automatic merge. |

The installed `.github/workflows/rucksack-ledger.yml` workflow can refresh this
directory from repo context through the Codex app-server planner, seed/update
GitHub issues, and open a review PR for changed specs.
