# Restore a reviewed deploy path, with a preview of main before production

labels: rucksack-blocked, rucksack-needs-human

## Implementer

**The coordinator implements this, not the drain.** Every file it changes is
under `.github/**` or `.agent/deploy.yaml`, which `.agent/pr-policy.yaml`
lists as `human_only_paths` and `.agent/policy.yaml` lists under
`require_human_approval`. It also needs a new credential, which only the
owner can create. The `rucksack-blocked` and `rucksack-needs-human` labels
keep it out of the queue. There is deliberately no `## Provider` section.
Merge is human-only: apply `rucksack-human-merge` to the PR.

## Goal

Every push to `main` builds the site once, in a job that holds no secrets.
A fixed publisher deploys that exact artifact to the preview Worker. The same
artifact goes to `ernie.sg` only when the owner approves one promotion ask,
which carries the preview URL and a list of what visibly changes.

## Observed failure

Checked on 2026-09-24:

- **Production is about ten weeks behind `main`.** `/books/`,
  `/books/build-a-coding-agent/` (#327) and `/study/experiments/pdf-to-epub/`
  return 404 on `https://ernie.sg`. Posts added before July return 200.
- **No GitHub workflow has ever deployed this site.**
  `gh run list -R erniesg/erniesg --workflow deploy.yml` shows successful runs
  up to 2026-07-15 (run `29430585471`, head `3c7b54b`), but in every run
  checked (`29430585471`, `29390769337`, `29201913014`) only the `full-ci` job
  ran. The `staging` and `production` jobs were **skipped**, because
  `vars.RUCKSACK_DEPLOY_ENABLED` was never `true`, and the repository has no
  Cloudflare secrets. `c6893a6` (2026-07-16, "refresh Rucksack hold
  contracts") replaced the workflow with the current
  `Rucksack VM Deploy (Held)` stub, which exits 2 on dispatch.
- **ernie.sg was deployed by hand.**
  `docs/deployment/cloudflare-workers-migration.md` records the cutover on
  2026-07-11: `npm run worker:deploy:production`, which runs
  `wrangler deploy --config wrangler.production.jsonc`, from a machine logged
  in to Wrangler. The final production version was
  `8ca6bbad-e2b5-45de-82ad-bee58e51868d`. Production serves
  multilingual posts (merged 2026-07-08) and not `/study` (merged
  2026-08-28), so its last manual deploy falls between those dates.
- **The preview target already exists.** Worker `erniesg-workers-preview`
  (`wrangler.jsonc`: `workers_dev: true`, `preview_urls: true`, D1
  `margin-db-stg`, no route) serves
  `https://erniesg-workers-preview.erniesg.workers.dev`. It answers 200 and
  sends `X-Robots-Tag: noindex` through `public/_headers`. Its content is
  also stale: it has `/study` (a `build:staging` build after 2026-08-28), but
  `/books/build-a-coding-agent/` returns 404. Production is Worker
  `erniesg-workers` (`wrangler.production.jsonc`: route `ernie.sg/*`, D1
  `margin-db`).
- **The Pages fallback is stale too.** `https://erniesg.pages.dev` returns
  404 for `/books/build-a-coding-agent/`.

## Credentials (names only)

What exists now:

- GitHub repository secrets: **none**.
- GitHub repository variables: `RUCKSACK_AUTOPILOT_ENABLED` only.
  `RUCKSACK_DEPLOY_ENABLED` does not exist.
- GitHub environments: `Preview` only. It is a 2025 Vercel leftover with no
  secrets, no variables and no protection rules. No `staging` or
  `production` environment exists, although `.agent/deploy.yaml` names both.
- On the coordinator VM: a personal Wrangler OAuth login
  (`~/.wrangler/config/default.toml` and `~/.config/.wrangler/config/default.toml`,
  keys `oauth_token`, `refresh_token`, `expiration_time`, `scopes`). It
  carries broad account scopes and belongs to the owner's user.
  `~/.config/rucksack/*.env` has no Cloudflare-named variable.

What this needs, and it is **new**:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token that the owner creates. It
  is stored as an **environment secret** in two new GitHub environments,
  `site-preview` and `site-production`, and never as a repository secret.
  Start from Cloudflare's "Edit Cloudflare Workers" template, limited to the
  one account and the `ernie.sg` zone: Account › Workers Scripts: Edit;
  Account › Account Settings: Read; Account › D1: Read (for the migration
  check below); Zone `ernie.sg` › Workers Routes: Edit. Drop KV, R2 and every
  other permission.
- `CLOUDFLARE_ACCOUNT_ID`: an environment **variable**, not a secret, in both
  environments.

Do not reuse the VM's Wrangler OAuth login. It is the owner's personal,
broad-scope session, and it refreshes itself, so an unattended publisher
would act with the owner's full account.

## Relation to PR #222

PR #222, "fix: port trusted publisher closure boundary" (open since
2026-08-24, fixes #192), changes only
`.github/workflows/agent-evidence-publisher.yml`. That is the publisher for
**PR evidence**: it revalidates a candidate's evidence artifact and posts a
check. It does not build or deploy the site, and it holds no Cloudflare
credential. It is **not** the publisher half of this spec. This spec neither
builds on it nor supersedes it, and the two touch no common file. This spec
reuses its patterns: a `workflow_run` trigger; a trusted checkout at
`${{ github.workflow_sha }}`; binding to the event's exact head SHA; and
`permissions: {}` by default with per-job grants. Another lane is bringing
#222 up to date with main. Do not push to it.

## Success criteria

1. **Tokenless build**, `.github/workflows/site-build.yml`:
   - `on: push: branches: [main]` and `workflow_dispatch`;
     `permissions: contents: read`; runs on `ubuntu-latest` only. Never use
     `vars.RUCKSACK_RUNS_ON`: this repository is public, and it must not
     build on a self-hosted runner.
   - Check out `github.sha` with `persist-credentials: false`, then run
     `npm ci` and `npm run build` (that is `build:production`, including
     `apply-release-gate.mjs` and the checks from specs 069 and 071).
   - Run `npx wrangler deploy --config wrangler.production.jsonc --dry-run --outdir worker-bundle`
     to bundle the Worker without credentials.
   - Upload one artifact `site-<sha>` with `dist/`, `worker-bundle/`, and a
     `manifest.json` holding the commit SHA, run id, run attempt, and the
     SHA-256 of every file.
   - Read no secret and no environment. Preview and production are the
     **same** artifact, a production build, so the preview shows exactly what
     promotion would serve. This ends the old split where preview was a
     `build:staging` build with `/research` included.
2. **Fixed publisher**, `.github/workflows/site-publish.yml`:
   - `on: workflow_run: workflows: [site-build], types: [completed], branches: [main]`.
   - It runs only when `conclusion == 'success'`, `event == 'push'`,
     `head_branch == 'main'`, and `head_repository.full_name ==
     github.repository`.
   - It checks out its own code at `${{ github.workflow_sha }}` (the default
     branch), never the artifact's source. It installs the Wrangler version
     pinned in that checkout's `package-lock.json` with
     `npm ci --ignore-scripts`.
   - It downloads `site-<head_sha>` from `workflow_run.id` with
     `actions: read`. Then it runs the trusted checkout's
     `node tools/deployment/verify-artifact.mjs <dir> --commit <workflow_run.head_sha>`,
     which checks every file against `manifest.json` and checks that
     `manifest.commit` matches. It refuses on a changed, missing or extra
     file, or on a commit mismatch.
   - It deploys with the trusted checkout's `wrangler.jsonc` or
     `wrangler.production.jsonc`, with `main` and `assets.directory`
     overridden to point at the verified `worker-bundle/` and `dist/`. Use
     `--no-bundle`, so no code from the artifact runs in the job that holds
     the token.
3. **Preview, automatic**: job `preview`, in environment `site-preview` with
   deployment branches limited to `main`. It deploys to
   `erniesg-workers-preview`, then runs
   `npm run worker:verify -- --base https://erniesg-workers-preview.erniesg.workers.dev --expect workers`.
   It uploads a receipt: commit, run id, Worker version id, artifact digest,
   verifier result.
4. **Production, only on owner approval**: job `production`,
   `needs: preview`, in environment `site-production` with **required
   reviewer: the owner (`erniesg`)**, deployment branches `main` only, and
   "prevent self-review" off because the owner is the only reviewer. It
   deploys the **same downloaded artifact**, by the same digest, to
   `erniesg-workers`, then runs
   `npm run worker:verify -- --base https://ernie.sg --expect workers`.
   Approving the pending `site-production` deployment is the promotion. There
   is no other path to production. Do not add an enable variable such as
   `RUCKSACK_DEPLOY_ENABLED`, because the environment approval is the gate.
5. **One owner ask per preview.** After a successful preview, the job comments
   on a single tracking issue, "Promote main to ernie.sg", found by the marker
   `<!-- site-promote -->`. It creates the issue if none exists, and never
   opens a second one. It needs `issues: write` on that job only. The comment
   carries:
   - the preview URL;
   - the commit range between production and preview (production's deployed
     commit, read from the last production receipt);
   - the link to the pending `site-production` approval;
   - the visible-change diff from criterion 6;
   - any refusal reason from criterion 7.

   A newer preview edits the same comment instead of adding one, so the
   owner is asked once.
6. **Visible-change diff**: `tools/deployment/visible-diff.mjs --base <preview> --compare https://ernie.sg`.
   It reads both `sitemap-index.xml` trees and lists routes added and routes
   removed. For routes present in both, it fetches the HTML, removes
   `<script>`, `<style>` and hashed asset URLs, compares the visible text,
   and lists the routes that changed, with a short excerpt of the first
   difference. Its output is Markdown. Cover it with
   `tools/deployment/visible-diff.test.mjs` using fixture HTML.
7. **Refusals are visible, never silent.** Before production, the job runs
   `wrangler d1 migrations list margin-db --remote --config wrangler.production.jsonc`.
   If any migration in `migrations/` is unapplied, the job does not deploy.
   It names the pending files in the tracking-issue comment and exits with a
   distinct code. The publisher never applies migrations. If Cloudflare
   refuses the query for lack of permission, the comment says *could not be
   evaluated: D1 read permission*, which is not the same as "pending".
8. **Rollback**: the production receipt records the previous Worker version
   id. The tracking issue lists
   `npx wrangler rollback <previous-version-id> --config wrangler.production.jsonc`
   as the owner's manual rollback. Nothing rolls back automatically.
9. **Retire the stubs.** Delete `.github/workflows/deploy.yml`, the held stub
   (it is rucksack-generated, so record in the PR that a rucksack refresh
   must not recreate it). Rewrite `.agent/deploy.yaml` to describe this path:
   `target: cloudflare-workers`, environments `site-preview` and
   `site-production`, `required_secrets: [CLOUDFLARE_API_TOKEN]`, and
   `required_vars: [CLOUDFLARE_ACCOUNT_ID]`. Remove the `RUCKSACK_VM_*` names
   that never applied to this site. Update the "Preview deployment" section of
   `docs/deployment/cloudflare-workers-migration.md` to point at the new
   workflows.

## Acceptance tests

- `site-build.yml` has no `secrets.` reference, no `environment:`, and no
  write permission. A grep-based vitest test,
  `tools/deployment/workflow-boundary.test.mjs`, asserts this. It also
  asserts that `site-publish.yml` never checks out anything other than
  `github.workflow_sha`, never runs `npm run build` or any script from the
  artifact, and reads `CLOUDFLARE_API_TOKEN` only in jobs whose
  `environment` is `site-preview` or `site-production`.
- `npx vitest run tools/deployment/visible-diff.test.mjs tools/deployment/workflow-boundary.test.mjs tools/deployment/verify-artifact.test.mjs`
  passes.
- `actionlint` (or `npx @action-validator/cli`) passes on both workflow files.
- Live, after the owner creates the credential and the coordinator creates
  the environments: one push to `main` produces a `site-build` run, a
  `site-publish` preview deployment,
  `https://erniesg-workers-preview.erniesg.workers.dev/books/build-a-coding-agent/`
  returning 200, one tracking-issue comment, and a `production` job **waiting
  for approval**. Production stays unchanged until approval.
- Refusal path: `tools/deployment/verify-artifact.test.mjs` builds a fixture
  artifact and asserts a non-zero exit, naming the file, for each of these: one
  byte changed in `dist/index.html`, a file missing, an extra file, and
  `--commit` differing from `manifest.commit`. The unmodified fixture must
  pass. In `site-publish.yml`, the verify step comes before any step that
  reads `CLOUDFLARE_API_TOKEN`; the boundary test asserts that order.

## Definition of done

`main` builds without secrets. The preview shows current `main`. The owner
receives exactly one ask with the preview URL and the visible diff.
`ernie.sg` changes only after the owner approves that exact artifact.

## Validation command

```bash
npx vitest run tools/deployment/visible-diff.test.mjs tools/deployment/workflow-boundary.test.mjs tools/deployment/verify-artifact.test.mjs tools/deployment/verify-cloudflare.test.mjs
npx --yes @action-validator/cli .github/workflows/site-build.yml
npx --yes @action-validator/cli .github/workflows/site-publish.yml
gh run list -R erniesg/erniesg --workflow site-build.yml --limit 1
gh run list -R erniesg/erniesg --workflow site-publish.yml --limit 1
curl -s -o /dev/null -w '%{http_code}\n' https://erniesg-workers-preview.erniesg.workers.dev/books/build-a-coding-agent/
```

## Concurrency

Independent of 069, 070 and 071. Once it lands, each of their merges
produces a preview and updates the single promotion ask. Only one
`site-publish` run may deploy at a time:
`concurrency: { group: site-publish, cancel-in-progress: false }`.

## Allowed secrets

`CLOUDFLARE_API_TOKEN`, only in the `site-preview` and `site-production`
environment jobs of `site-publish.yml`. `CLOUDFLARE_ACCOUNT_ID` is a
variable.

## Artifact outputs

`.github/workflows/site-build.yml`, `.github/workflows/site-publish.yml`,
deletion of `.github/workflows/deploy.yml`, the rewritten
`.agent/deploy.yaml`, `tools/deployment/visible-diff.mjs` and
`tools/deployment/verify-artifact.mjs` with their tests,
`tools/deployment/workflow-boundary.test.mjs`, and the doc update. Outside
git, done by the coordinator and the owner: the two GitHub environments, the
required-reviewer rule, the token, and the account variable.

## Stop conditions

- Stop before deploying to `erniesg-workers` (production) from anywhere other
  than the approved `site-production` job. That includes a manual
  `wrangler deploy` from the VM "just this once".
- Stop before storing any Cloudflare credential as a repository secret, or
  giving it to `site-build.yml`.
- Stop before applying D1 migrations, changing routes, DNS or the Pages
  project, or running `worker:rollback`, which deletes the production Worker.
- Stop before touching `.github/workflows/agent-evidence-publisher.yml` or
  PR #222.

## Human clarification protocol

Two owner actions are needed, and both are required, so neither is left
open: create `CLOUDFLARE_API_TOKEN` with the permissions above, and approve
each production promotion. The coordinator files one owner ask for the token,
naming the token permissions and the environment it goes into. It does not
ask again while the ask is open.

## Recommended response

Land the workflows with the environments created but the token absent. The
preview job then fails at a named step: "CLOUDFLARE_API_TOKEN is not set in
site-preview". That proves the wiring and gives the owner ask an exact
target. Then the owner adds the token, the coordinator re-runs the last
`site-build`, and the first real preview of current `main` goes up with its
promotion ask.

## Trade-offs

Cloudflare cannot scope "Workers Scripts: Edit" to a single Worker. The token
in `site-preview` can technically overwrite `erniesg-workers` too. The
boundary against that is the fixed publisher code, which pins the Worker name
per job in the trusted checkout, plus GitHub's environment protection. The
token scope is not part of that boundary. A second Cloudflare account for
preview would close the gap, at the cost of a separate D1 and a separate
`workers.dev` subdomain. That is not worth it for a personal site.

## Free-form response

The held workflow's own message named this design: "a reviewed tokenless
build artifact and a separate fixed publisher boundary". The deploy that
actually happened, a laptop running `wrangler deploy`, had neither. This
spec builds the path the hold asked for, and makes the owner's approval the
only way into production.
