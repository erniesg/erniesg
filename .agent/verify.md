# Verification

Before claiming completion, run the evidence command and attach the manifest.

```bash
scripts/agent-evidence
```

Optional lanes are opt-in:

```bash
scripts/agent-evidence --e2e
scripts/agent-evidence --only=lint,type-check
# If wrapped in npm, pass flags after `--`: npm run agent:evidence -- --e2e
```

Validation lanes discovered:

- `model-consultation`: reopens actual PDF-to-EPUB fixture receipts and validates privacy-safe per-document, per-class consultation aggregates (required)
- `build`: `npm run build` (required)
- `test`: `npm run test` (required)
- `e2e`: `npm run test:e2e` (optional)

The reading-shell spec binds a dev server, so give it a per-run port rather
than the config default:

```bash
SRT_E2E_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()') \
  npx playwright test tests/e2e/reading-shell.spec.ts
```

Two lane limits are reached from an agent worktree and not from a clean
checkout. Neither is caused by the code under test:

- `build` and `tools/publication-adapter-conformance.test.mjs` both end at
  `Publication receipt is not bound to a clean checked-out repository`.
  `publicationRepositoryForCurrentCheckout` asserts `git status` is empty, so
  the publication receipt can only bind on a committed tree. `astro check`,
  `astro build` (181 pages), and `publication:build` all pass before it.
- `scripts/agent-evidence` gives all lanes one shared budget,
  `DEFAULT_BUDGET_MS` in that script, not a per-lane grant. Lanes run in order
  (`association-audit`, `unit`, `build`, `test`), and each one gets only what
  the lanes before it left. `npm run test` alone has measured about 1,724 s on
  this box, so a slow `build` still shrinks what `test` gets. When the budget
  runs out mid-lane, that lane is killed and recorded with exit `124`, and its
  log ends with `lane timed out against the shared ... ms budget`. Every later
  lane is recorded as failed with exit `124` and `duration_ms: 0`, a log that
  says `this lane was never started`, and a `lane not run:` caveat in the
  manifest. Read the lane log before reading the exit code: an exit of `124`
  means the budget ran out, not that an assertion failed. The trusted publisher
  reads the same constant to size its outer bound, so change the budget only
  there.

Run the model-consultation receipt lane on its own with:

```bash
scripts/agent-evidence --only=model-consultation
```

Its `model-consultation-evidence` artifact contains only hashed document IDs,
exact decision classes, counts, rates, provider-call counts, and retirement
booleans. It does not serialize source content, candidate data, model identity,
credentials, or raw consultation receipts.

Deploy contract:

- `.agent/deploy.yaml` records provider-neutral deploy and infrastructure gates.
- Deploy, rollback, and infrastructure apply lanes require trusted context and human approval.
- `scripts/agent-evidence` does not execute secret-bearing deploy commands.
- When `.agent/storage.yaml` exists, `scripts/agent-evidence` records large untracked files over `repo_limit_mb` as manifest caveats and artifact entries.
- `infra/vm/verify.sh` is the reusable trusted-VM health and hardening check.
- Detected deploy/IaC hints:
  - `cloudflare` via `wrangler` from `wrangler.jsonc`.

Exit taxonomy:

- `0`: required validation passed
- `1`: required validation failed
- `2`: blocked by missing dependency or environment setup
- `3`: blocked by missing auth/secret or subscription/browser state
- `4`: blocked by required human decision
