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

`npm run test:e2e:spec` does that port dance for you, so a spec that binds a
dev server can be run without picking a port by hand:

```bash
npm run test:e2e:spec -- tests/e2e/margin-anchoring.spec.ts
```

`tests/e2e/margin-anchoring.spec.ts` and `tests/e2e/reading-shell.spec.ts`
both install the static routes, so they can also be pointed at the built site
and skip the dev server altogether. That is the faster lane, and it is the one
that tests the pages a reader actually gets:

```bash
npm run build          # or `astro build`, for `dist/`
SRT_STATIC_BUILD_DIR=dist npx playwright test \
  tests/e2e/margin-anchoring.spec.ts tests/e2e/reading-shell.spec.ts
```

A dev-server run of either spec needs `astro dev` to answer `/research`, the
readiness URL in `playwright.config.ts`, within 120 s. On a cold agent
worktree it does not, and the run ends at `Timed out waiting 120000ms from
config.webServer` before any test starts. The static-build invocation above
has no such dependency.

`packages/margin` is a standalone package inside this repository. Its own
suite compiles it, checks its `exports` map against what the build emits and
checks the output for repository-specific identifiers, so it is worth running
on its own before the repository-wide lanes:

```bash
npm run build --prefix packages/margin
npm run test  --prefix packages/margin
npm run test:margin   # the package suite plus the book-HTML anchoring tests
```

The package is not registered under `workspaces` in the root `package.json`:
doing so requires regenerating `package-lock.json`, which the agent sandbox
cannot do. Use `--prefix` in the meantime; `npm --workspace packages/margin
test` starts working the moment the workspace is registered.

Two lane limits are reached from an agent worktree and not from a clean
checkout. Neither is caused by the code under test:

- `build` and `tools/publication-adapter-conformance.test.mjs` both end at
  `Publication receipt is not bound to a clean checked-out repository`.
  `publicationRepositoryForCurrentCheckout` asserts `git status` is empty, so
  the publication receipt can only bind on a committed tree. `astro check`,
  `astro build` (181 pages), and `publication:build` all pass before it.
- `scripts/agent-evidence` gives each lane 900 s. `npm run test` measured
  869–923 s on this box, so the `test` lane can be killed mid-run by its own
  timeout rather than by a failing assertion. Read the lane log before reading
  the exit code: a truncated log with no vitest summary means the timeout.

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
