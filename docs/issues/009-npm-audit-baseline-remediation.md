# Remediate the npm audit baseline and restore green required checks

## Provider

vm-codex

## Goal

Remove the current high and critical npm audit findings from the repository baseline and restore the required `npm audit --audit-level=high` check.

The observed baseline currently reports 39 vulnerabilities: 2 low, 17 moderate, 17 high, and 3 critical.

## Acceptance tests

- Capture a machine-readable before-state from `npm audit --json`, including vulnerability counts and dependency paths.
- Identify which direct dependencies introduce the high and critical findings.
- Apply the smallest non-breaking dependency and lockfile upgrade set that clears the required audit threshold.
- Do not use `npm audit fix --force` without explicit human approval.
- `npm audit --audit-level=high` exits successfully.
- Record any low or moderate findings that remain.
- `npm test` passes.
- `npm run build` passes.
- `scripts/agent-evidence` passes.
- `git diff --check` passes.
- Astro and Cloudflare build behavior remains intact.
- The dependency gate can pass for PR #12 without changing its SRT implementation.
- Limit changes to package manifests, the lockfile, and compatibility changes strictly required by dependency upgrades.
- Do not change SRT schemas, rendition layouts, translations, or production deployment configuration.
- Do not suppress or ignore an advisory unless an explicit reviewed exception records:
  - advisory identifier
  - affected package and path
  - exploitability assessment
  - owner
  - expiry or review date
- Split broad or breaking framework upgrades into a separately reviewed issue rather than expanding this task silently.

## Validation command

```bash
npm audit --audit-level=high
npm test
npm run build
scripts/agent-evidence
git diff --check
```

## Allowed secrets

None.

## Artifact outputs

- Updated package manifest and lockfile
- Before-and-after audit summaries
- Upgrade and compatibility notes
- Agent evidence bundle
- Pull request linking this remediation to the existing failed audit runs

## Stop conditions

- A required fix needs a breaking major-version upgrade with material application changes.
- The only available remediation is `npm audit fix --force`.
- An advisory has no supported fixed version and would require suppression.
- Validation would require a production deployment or production credentials.
- Dependency resolution changes platform support or Cloudflare compatibility.

## Human clarification protocol

If a breaking upgrade or advisory exception is unavoidable, present the smallest alternatives and their affected packages. Default to splitting the work and preserving the existing gate.

## Recommended response

Inspect the audit dependency paths, deliberately upgrade the responsible top-level packages, regenerate the lockfile, and validate after each coherent upgrade group.

## Trade-offs

A narrow upgrade minimizes regression risk but may leave low and moderate debt. A broad framework upgrade could clear more findings but should receive separate review because it expands application risk.

## Free-form response

Commit in coherent upgrade groups with audit and test evidence after each group. Keep the remediation independent of the SRT feature branch.
