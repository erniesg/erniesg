# Restore a reviewed deploy path, with a preview of main before production

## Implementer

**The coordinator owns this spec. It is not for the drain, and it is excluded
from seeding.**

- Part 1 is a deploy: `wrangler deploy` is in `.agent/policy.yaml`
  `blocked_without_approval`.
- Part 2 changes only `.github/**` and `.agent/deploy.yaml`, which
  `.agent/pr-policy.yaml` lists as `human_only_paths`.

The GitHub seeder does not read a `labels:` metadata line; only the local
ledger selector does. So nothing in this file can hold it on the GitHub
queue. And with no `## Provider` section, a seeded copy would fall to the repo
default provider and could be queued. Therefore:

- The coordinator seeds only 069, 070 and 071, with a run scoped to those
  files. It never passes this file to `rucksack github issues seed`.
- If this spec is ever seeded by mistake, the coordinator immediately applies
  `rucksack-needs-human` and `rucksack-blocked` to that GitHub issue and
  removes `rucksack-queued`.
- Part 2's PR is human-merge-only: apply `rucksack-human-merge`.

## Goal

**Part 1, this release:** put current `main` on the preview Worker, then
promote the same build to `ernie.sg` after exactly one owner ask. The ask
carries the preview URL and a diff of what visibly changes. That ask is the
owner's only touchpoint in this release.

**Part 2, later and not part of this release:** replace the manual steps
with CI. A tokenless build job builds each push to `main` once, a fixed
publisher deploys that artifact to preview, and production takes an owner
approval.

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
- On the coordinator VM: a Wrangler OAuth login
  (`~/.wrangler/config/default.toml` and `~/.config/.wrangler/config/default.toml`,
  keys `oauth_token`, `refresh_token`, `expiration_time`, `scopes`). It holds
  `workers_scripts:write`, `workers_routes:write` and `d1:write`, among
  others. `~/.config/rucksack/*.env` has no Cloudflare-named variable.
- Worker secret names the code reads (`src/worker/margin/config.ts`
  `WorkosEnv`): `WORKOS_ISSUER`, `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`,
  `WORKOS_COOKIE_PASSWORD`, `WORKOS_REDIRECT_URI`. They live in each Worker's
  Cloudflare secret store, not in git. If any is missing, `readWorkosConfig`
  returns `null` and margin sign-in is unavailable. The static site still
  serves.

**Part 1 needs no new credential.** It uses the VM's existing Wrangler login.

**Part 2 will need a new credential** (not requested in this release):
`CLOUDFLARE_API_TOKEN`, an environment secret in two new GitHub environments,
`site-preview` and `site-production`, never a repository secret. Start from
Cloudflare's "Edit Cloudflare Workers" template, limited to the one account
and the `ernie.sg` zone: Account › Workers Scripts: Edit; Account › Account
Settings: Read; Account › D1: Read; Zone `ernie.sg` › Workers Routes: Edit.
It also needs `CLOUDFLARE_ACCOUNT_ID` as an environment variable. CI must not
use the VM's personal OAuth login, which refreshes itself and carries the
owner's broad scopes.

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

### Part 1: Interim promotion (this release)

The coordinator does all of this on the VM. It uses no GitHub workflow and
no new credential.

#### I1. One clean exact-head build

Record `HEAD=$(git -C /home/ubuntu/code/erniesg/erniesg rev-parse origin/main)`.
Create a detached worktree at `$HEAD` under the coordinator's scratch
directory, and check that `git status --porcelain` is empty. Install with
`pnpm import && pnpm install --frozen-lockfile --config.shamefully-hoist=true`.
The hoist is needed: under pnpm's default layout, `astro build` fails with
"Could not find Sharp" (seen on this VM on 2026-09-24). Do not commit the
generated `pnpm-lock.yaml`. Then run `npm run build` (`build:production`), and
record
`DIST_DIGEST=$( (cd dist && find . -type f -print0 | sort -z | xargs -0 sha256sum) | sha256sum | cut -d' ' -f1)`. Preview and production
get **this** `dist/`: the preview is a production build, not
`build:staging`, so what the owner reviews is what gets promoted.

#### I2. Read-only preconditions, before the ask

Run each of these from the worktree, and keep the output:
- `npx wrangler d1 migrations list margin-db --remote --config wrangler.production.jsonc`
- `npx wrangler d1 migrations list margin-db-stg --remote --config wrangler.jsonc`
- `npx wrangler secret list --config wrangler.production.jsonc` (names only)
- `npx wrangler secret list --config wrangler.jsonc` (names only)
- `npx wrangler deployments list --config wrangler.production.jsonc`, to
  record the current production version id for rollback.

Compare the secret names with the five `WORKOS_*` names above. A command
that fails for lack of permission is recorded as *could not be evaluated*,
with the error. It is not recorded as "fine" or as "missing".

#### I3. Preview deploy

Deploy that `dist/` to `erniesg-workers-preview`:
`npx wrangler deploy --config wrangler.jsonc --message "preview $HEAD"`.
Do not re-run the build: `wrangler deploy` bundles `src/worker/index.ts`
from the same worktree and uploads the existing `dist/`. If `margin-db-stg`
has an unapplied migration, the coordinator applies it to the **preview**
database only (`npx wrangler d1 migrations apply margin-db-stg --remote --config wrangler.jsonc`),
since preview data is disposable. Then run
`npm run worker:verify -- --base https://erniesg-workers-preview.erniesg.workers.dev --expect workers`,
and check that `/books/build-a-coding-agent/` returns 200.

#### I4. Visible-change diff

Run this from the worktree. It needs no token:

```bash
PREVIEW=https://erniesg-workers-preview.erniesg.workers.dev
routes() { curl -s "$1/sitemap-index.xml" | grep -o '<loc>[^<]*' | sed 's#<loc>##' \
  | while read -r s; do curl -s "$1/${s#https://ernie.sg/}"; done \
  | grep -o '<loc>[^<]*' | sed 's#<loc>https://ernie.sg##' | sort -u; }
routes https://ernie.sg > prod.txt; routes "$PREVIEW" > preview.txt
[ -s prod.txt ] && [ -s preview.txt ] || { echo "empty route list: refetch" >&2; exit 1; }
comm -13 prod.txt preview.txt > added.txt; comm -23 prod.txt preview.txt > removed.txt
comm -12 prod.txt preview.txt | while read -r r; do
  a=$(curl -s "https://ernie.sg$r" | python3 -c 'import sys,re,hashlib;h=sys.stdin.read();h=re.sub(r"(?s)<(script|style)\b.*?</\1>","",h);print(hashlib.sha256(" ".join(re.sub(r"<[^>]+>"," ",h).split()).encode()).hexdigest())')
  b=$(curl -s "$PREVIEW$r" | python3 -c 'import sys,re,hashlib;h=sys.stdin.read();h=re.sub(r"(?s)<(script|style)\b.*?</\1>","",h);print(hashlib.sha256(" ".join(re.sub(r"<[^>]+>"," ",h).split()).encode()).hexdigest())')
  [ "$a" = "$b" ] || echo "$r"; done > changed.txt
git log --first-parent --since=2026-07-08 --format='%h %s' "$HEAD" -- src public astro.config.ts wrangler.jsonc wrangler.production.jsonc migrations > features.txt
```

An empty route list means the fetch failed, not that there are no
routes. This happened once in testing on 2026-09-24, so the guard refuses to
go on. The ask summarizes these files: routes added (with counts per top-level
section, for example `/books/**`), routes removed, the number of pages
changed plus the first 20, and a short list of user-visible features
drawn from `features.txt` (books, the DSA practice book, margin, and so
on). Production's deployed commit is unknown. The last recorded version is
from 2026-07-11, and the served content falls between the 2026-07-08 and
2026-08-28 merges. So the feature list starts at 2026-07-08 and says so.

#### I5. Exactly one owner ask

Open one GitHub issue, "Promote main to
ernie.sg", with the marker `<!-- site-promote -->`. Update it in place;
never open a second one. It contains:
- the preview URL;
- `$HEAD` and `DIST_DIGEST`;
- the diff summary from I4;
- the precondition results from I2.

The owner's approval covers exactly what the ask states, and nothing else
is asked later:
- If `margin-db` has an unapplied migration, the ask names the file (for
  example `migrations/0001_margin_annotations.sql`), and approval covers
  applying exactly that file to `margin-db`.
- If a `WORKOS_*` name is missing on `erniesg-workers`, the ask says that
  margin sign-in will be unavailable in production until it is set. It
  does not ask the owner to set it now.
- Approval is a comment by `erniesg` on that issue that says "approve".
  Do not ask for a `/rucksack` command, because rucksack automation acts on
  those.

#### I6. Promotion, on approval only

From the same worktree, still at `$HEAD`:
1. recompute the digest and check it equals `DIST_DIGEST`;
2. apply the named migration, if the ask named one:
   `npx wrangler d1 migrations apply margin-db --remote --config wrangler.production.jsonc`;
3. `npx wrangler deploy --config wrangler.production.jsonc --message "promote $HEAD"`;
4. `npm run worker:verify -- --base https://ernie.sg --expect workers`.

Always deploy the **approved** `$HEAD`, even if `origin/main` has moved
since the ask; newer commits wait for the next promotion. If the digest in
step 1 differs, the worktree has changed. Recreate it at `$HEAD`, rebuild,
and redeploy and re-verify preview. Record both digests on the issue, then
continue. The approval is for the head, so this needs no new ask.

#### I7. Receipts and rollback

Record, in a comment on the promotion issue
and in `docs/deployment/cloudflare-workers-migration.md` under a new
"Promotions" table: `$HEAD`, `DIST_DIGEST`, the preview and production
Worker version ids, the previous production version id, the migration
applied (if any), and the verifier results. The rollback is
`npx wrangler rollback <previous-version-id> --config wrangler.production.jsonc`,
and it runs only if the owner asks. Close the issue after the receipt.

### Part 2: Later, the automated path (not part of this release)

Nothing in Part 2 is asked of the owner in this release. No token ask is
filed while the Part 1 promotion issue is open. Part 2 starts as a separate
coordinator task once Part 1 is closed.

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

Part 1:

- `origin/main` at `$HEAD` builds clean in a detached worktree with an empty
  `git status --porcelain`.
- The preview `worker:verify` passes, and
  `https://erniesg-workers-preview.erniesg.workers.dev/books/build-a-coding-agent/`
  returns 200.
- One promotion issue exists, with the preview URL, the digest, the diff
  summary and the precondition results. There is no other open owner ask for
  this site.
- After approval: `https://ernie.sg/books/build-a-coding-agent/` returns 200,
  the production `worker:verify` passes, and the receipt is recorded.

Part 2:

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

Part 1, which is the done for this release: the preview shows current
`main`. The owner received exactly one ask with the preview URL and the
visible diff. `ernie.sg` serves the approved head, and a receipt with the
rollback version is recorded.

Part 2, later: `main` builds without secrets, and production changes only
through the approved `site-production` job.

## Validation command

```bash
# Part 1
curl -s -o /dev/null -w '%{http_code}\n' https://erniesg-workers-preview.erniesg.workers.dev/books/build-a-coding-agent/
npm run worker:verify -- --base https://erniesg-workers-preview.erniesg.workers.dev --expect workers
npm run worker:verify -- --base https://ernie.sg --expect workers
curl -s -o /dev/null -w '%{http_code}\n' https://ernie.sg/books/build-a-coding-agent/
# Part 2
npx vitest run tools/deployment/visible-diff.test.mjs tools/deployment/workflow-boundary.test.mjs tools/deployment/verify-artifact.test.mjs tools/deployment/verify-cloudflare.test.mjs
npx --yes @action-validator/cli .github/workflows/site-build.yml
npx --yes @action-validator/cli .github/workflows/site-publish.yml
gh run list -R erniesg/erniesg --workflow site-build.yml --limit 1
gh run list -R erniesg/erniesg --workflow site-publish.yml --limit 1
curl -s -o /dev/null -w '%{http_code}\n' https://erniesg-workers-preview.erniesg.workers.dev/books/build-a-coding-agent/
```

## Concurrency

Independent of 069, 070 and 071. Part 1 promotes whatever `main` is at
`$HEAD`. If they land before the ask, they are included; if after, they wait
for the next promotion. Once Part 2 lands, each merge produces a preview and
updates the single promotion ask. Only one
`site-publish` run may deploy at a time:
`concurrency: { group: site-publish, cancel-in-progress: false }`.

## Allowed secrets

Part 1: the VM's existing Wrangler login, used only by the coordinator,
only for the commands in I2, I3 and I6. No secret value is printed or
written anywhere.

Part 2: `CLOUDFLARE_API_TOKEN`, only in the `site-preview` and
`site-production` environment jobs of `site-publish.yml`.
`CLOUDFLARE_ACCOUNT_ID` is a variable.

## Artifact outputs

Part 1: the promotion issue, the receipt comment, and the "Promotions"
table in `docs/deployment/cloudflare-workers-migration.md`.

Part 2: `.github/workflows/site-build.yml`, `.github/workflows/site-publish.yml`,
deletion of `.github/workflows/deploy.yml`, the rewritten
`.agent/deploy.yaml`, `tools/deployment/visible-diff.mjs` and
`tools/deployment/verify-artifact.mjs` with their tests,
`tools/deployment/workflow-boundary.test.mjs`, and the doc update. Outside
git, done by the coordinator and the owner: the two GitHub environments, the
required-reviewer rule, the token, and the account variable.

## Stop conditions

- Part 1: stop before deploying to `erniesg-workers` without the owner's
  approval on the promotion issue, or deploying any head or build other than
  the approved `$HEAD` with a matching `DIST_DIGEST`.
- Part 1: stop before applying any production D1 migration that the ask did
  not name.
- Part 2 (the CI path): stop before deploying production from anywhere other
  than the approved `site-production` job, and before using the VM's
  personal Wrangler OAuth login in any workflow. The manual-deploy ban and
  the no-reuse rule apply to the CI path. They do not apply to the Part 1
  interim promotion, which the owner approves explicitly.
- Stop before storing any Cloudflare credential as a repository secret, or
  giving it to `site-build.yml`.
- Stop before changing routes, DNS or the Pages project, or running
  `worker:rollback`, which deletes the production Worker, in either part.
- Stop before touching `.github/workflows/agent-evidence-publisher.yml` or
  PR #222.

## Human clarification protocol

This release has exactly one owner touchpoint: the Part 1 promotion ask
(I5). Everything that ask depends on (migrations, missing secret names,
routes, features) is stated inside it, so approving it is the whole decision.
No token ask and no environment setup is filed in this release. The Part 2
token ask comes later, as its own single ask, after Part 1 is closed.

## Recommended response

Do Part 1 now: build once, check the preconditions, deploy to preview,
diff, ask once, and promote the same build on approval. Start Part 2 later.
There, land the workflows with the environments created but the token absent,
so the preview job fails at a named step ("CLOUDFLARE_API_TOKEN is not set in
site-preview"). That proves the wiring, and gives the token ask an exact
target.

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
