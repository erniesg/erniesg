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
