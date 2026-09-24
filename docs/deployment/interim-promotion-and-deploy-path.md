# Interim promotion of main to ernie.sg, and the later automated deploy path

**This is a deployment runbook and plan, not an issue spec.** It
deliberately lives in `docs/deployment/` and not in `docs/issues/`.
`rucksack github issues seed` and
`rucksack autopilot reconcile --queue-after-activation` read every `*.md`
directly in `docs/issues/`, with no per-file scope, so a file there would be
seeded and could be queued to an unattended worker. Keeping it here takes it
out of the queue by construction. The coordinator owns it.

- Part 1 is a deploy: `wrangler deploy` is in `.agent/policy.yaml`
  `blocked_without_approval`.
- Part 2 changes only `.github/**` and `.agent/deploy.yaml`, which
  `.agent/pr-policy.yaml` lists as `human_only_paths`.

Do not move this file into `docs/issues/`. If Part 2 is ever turned into
an issue spec, it needs its own mechanical hold that the seeder honours.
Part 2's PR is human-merge-only: apply `rucksack-human-merge`.

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
credential. It is **not** the publisher half of this plan. This plan neither
builds on it nor supersedes it, and the two touch no common file. This plan
reuses its patterns: a `workflow_run` trigger; a trusted checkout at
`${{ github.workflow_sha }}`; binding to the event's exact head SHA; and
`permissions: {}` by default with per-job grants. Another lane is bringing
#222 up to date with main. Do not push to it.

## Success criteria

### Part 1: Interim promotion (this release)

The coordinator does all of this on the VM. It uses no GitHub workflow and
no new credential.

Every `wrangler` call below uses **the artifact's own wrangler**, installed
from the repository lockfile when the artifact is built (I1 step 5):
`WR="$ART/tooling/node_modules/.bin/wrangler"`. Never use `npx` or a global
`wrangler`. `npx wrangler@<version>` ignores the lockfile, so miniflare,
workerd, esbuild and the rest would resolve fresh with no integrity check,
and these commands run with the owner's broad-scope Wrangler login. If
`$WR` is missing, or the tooling check under I1 fails, **stop**.

#### I1. One clean exact-head build, saved as the artifact

1. Record `HEAD=$(git -C /home/ubuntu/code/erniesg/erniesg rev-parse origin/main)`,
   `SHA8=${HEAD:0:8}` and
   `ART=/home/ubuntu/.local/share/rucksack/deployments/erniesg-$SHA8`, then
   run `mkdir -p "$ART"`. `$ART` is outside anything the daily storage GC
   removes.
2. Create a detached worktree at `$HEAD` under the coordinator's scratch
   directory, and check that `git status --porcelain` is empty.
3. Install the site build's dependencies from the reviewed lockfile, under
   the load gate:

   ```bash
   RUCKSACK_NPM_SHIM=passthrough systemd-run --user --scope -q -p CPUQuota=150% \
     npm ci --no-audit --no-fund
   ```

   The site build ships to readers, so its dependencies must be exactly
   `package-lock.json`'s. `npm ci` installs those versions and checks every
   package's `sha512` integrity. `pnpm import` does not: it re-resolves
   against the registry. **Install scripts stay enabled here**, because
   `sharp` and similar packages need them to fetch or link native binaries
   that the build uses. They are disabled only for the deploy tooling
   (step 5), which never builds and runs only wrangler. npm's layout also
   finds `sharp`, so no pnpm hoist workaround is needed. This is the same
   deliberate exception to the host's pnpm-first rule as step 5, at about
   700 MB of private `node_modules`, which step 9 removes.
4. Run `npm run build` (`build:production`). Preview and production both get
   this production build, not `build:staging`, so what the owner reviews is
   what gets promoted.
5. **Install the deploy tooling into the artifact, from the lockfile.**
   1. `mkdir -p "$ART/tooling"`, then copy `package.json` and
      `package-lock.json` from the worktree into it.
   2. In `$ART/tooling`, under the load gate
      (`until [ "$(cut -d' ' -f1 /proc/loadavg | cut -d. -f1)" -lt 12 ]; do sleep 30; done`),
      run:

      ```bash
      RUCKSACK_NPM_SHIM=passthrough systemd-run --user --scope -q -p CPUQuota=150% \
        npm ci --ignore-scripts --no-audit --no-fund
      ```

      `npm ci` installs exactly the versions in `package-lock.json` and checks
      every package's tarball against the `sha512` integrity recorded there,
      failing on any mismatch. Nothing is re-resolved, so wrangler, miniflare,
      workerd, esbuild and unenv are all tied to the reviewed lock.
      `--ignore-scripts` is safe: the platform binaries (esbuild, workerd)
      arrive as optional dependencies that need no install script.

      **This is a deliberate exception to the host's pnpm-first rule.**
      `pnpm import` does not carry `package-lock.json`'s integrity values: it
      re-resolves against the registry, and `--frozen-lockfile` then enforces
      the `pnpm-lock.yaml` it has just written. So pnpm would not tie the deploy
      tooling to the reviewed lock. The cost is about 700 MB of private
      `node_modules` per artifact. The cleanup in I7 removes it after the
      receipt.
   3. Check the tooling. Both must hold, or stop:
      - `node -p "require('$ART/tooling/package-lock.json').packages['node_modules/wrangler'].version"`
        prints the version that `"$WR" --version` prints (`4.135.0` at
        `fb60bce`);
      - `"$ART/tooling/node_modules/wrangler/package.json"` has that same
        `version`.
6. **Bundle the Worker once, before the ask**, with that binary. From the
   worktree:
   `"$WR" deploy --dry-run --outdir "$ART/worker" --config wrangler.production.jsonc`.
   The `main` entry is the same in both configs, and `vars` are applied at
   deploy time, not in the bundle, so one bundle serves both Workers.
   Confirm that `ls -A "$ART/worker"` lists exactly `index.js` and
   `index.js.map`, and record that listing and `"$WR" --version` for the
   ask. If the outdir holds any other file, stop and report it:
   `--no-bundle` would not upload that file. The check is done once, here;
   later steps only deploy what it produced.
7. Complete the artifact in `$ART`. It contains:
   - `dist/` (copied with `cp -a dist "$ART/dist"`);
   - `worker/` (from step 6);
   - `tooling/` (from step 5);
   - `migrations/` (copied from the worktree);
   - two derived configs, `wrangler.jsonc` and
     `wrangler.production.jsonc`. Each is copied from the worktree with one
     line changed, `"main": "./src/worker/index.ts"` →
     `"main": "./worker/index.js"`. Their `assets.directory` (`./dist`) and
     `migrations_dir` (`migrations`) already resolve inside `$ART`. Check
     that `diff` against the original shows exactly that one line.
   - `HEAD`, a file containing the full commit SHA.
8. Write the manifest, then its digest. The file list is defined once and
   used both here and in the checks below:

   ```bash
   artifact_files() {
     (cd "$ART" && find . \( -path ./.wrangler -o -path ./tooling/node_modules/.cache \) -prune \
       -o -type f ! -name MANIFEST.sha256 -print | LC_ALL=C sort)
   }
   (cd "$ART" && artifact_files | xargs -d '\n' sha256sum --) > "$ART/MANIFEST.sha256"
   ARTIFACT_DIGEST=$(sha256sum "$ART/MANIFEST.sha256" | cut -d' ' -f1)
   ```

   The manifest covers `tooling/package.json`, `tooling/package-lock.json`,
   and every regular file under `tooling/node_modules`, including the
   wrangler package and everything it loads. That is roughly 37,000 files
   and 700 MB. Run the hashing, both here and in every check below, under the
   load gate and inside `systemd-run --user --scope -q -p CPUQuota=150%`.
   Expect about 1–3 minutes per pass on this VM. Do not make `$ART` read-only. `wrangler` writes its
   scratch directory, `.wrangler/`, next to the config, and its cache,
   `node_modules/.cache/`, under the tooling. Those two paths are the only
   ones left out of the manifest.
9. Remove the build's dependencies, now that the artifact is saved. The
   bundle from step 6 has already been made, and it needed the worktree's
   `node_modules`:
   `rm -rf -- "${WORKTREE:?}/node_modules"`, where `WORKTREE` is the step 2
   worktree. From then on, a command that needs the worktree's dependencies
   (only `npm run worker:verify` in I3 and I6) runs with
   `ln -s "$ART/tooling/node_modules" "$WORKTREE/node_modules"`. That tree
   comes from the same lockfile and has already been integrity-checked, and
   the verifier needs no install scripts. Remove the link afterwards with
   `rm -- "$WORKTREE/node_modules"`.

**Verify the artifact before every wrangler call after I1 (I2, I3, I6 and
the rollback).** All of these must pass:
- `(cd "$ART" && sha256sum --quiet --strict -c MANIFEST.sha256)`;
- the file list equals the manifest's list:
  `diff <(artifact_files) <(sed 's/^[0-9a-f]\{64\}  //' "$ART/MANIFEST.sha256")`;
- `sha256sum "$ART/MANIFEST.sha256"` still equals `ARTIFACT_DIGEST`;
- `"$WR" --version` still prints the recorded version.

If `$ART` or `$WR` is missing, or any check fails, **stop**. Do not deploy,
do not reinstall, and **never rebuild silently**. Post the failure on the
promotion issue. Rebuilding to produce a new artifact means a new preview
and an update to the same ask, so the owner approves the digest that will
actually ship.

#### I2. Read-only preconditions, before the ask

Run each of these from `$ART`, and keep the output:
- `"$WR" d1 migrations list margin-db --remote --config wrangler.production.jsonc`
- `"$WR" d1 migrations list margin-db-stg --remote --config wrangler.jsonc`
- `"$WR" secret list --config wrangler.production.jsonc` (names only)
- `"$WR" secret list --config wrangler.jsonc` (names only)
- `"$WR" deployments list --config wrangler.production.jsonc`. From the
  current deployment, record the **version id** (not the deployment id) as
  `PREV_VERSION`, for rollback.

Compare the secret names with the five `WORKOS_*` names above. A command
that fails for lack of permission is recorded as *could not be evaluated*,
with the error. It is not recorded as "fine" or as "missing".

#### I3. Preview deploy of the saved artifact

After the artifact check passes, run from `$ART`:

```bash
"$WR" deploy --config wrangler.jsonc --no-bundle --message "preview $HEAD $ARTIFACT_DIGEST"
```

`--no-bundle` uploads `worker/index.js` as it is, with the assets in
`./dist`, so nothing is rebuilt.

If `margin-db-stg` has an unapplied migration, apply it to the **preview**
database first: `"$WR" d1 migrations apply margin-db-stg --remote --config wrangler.jsonc`.
Preview data is disposable, so one retry is allowed. If the retry also
fails, stop and post the error on the promotion issue as *failed*. That is a
different state from *could not be evaluated*.

Then, from the worktree at `$HEAD`, with `node_modules` linked to the
tooling as in I1 step 9, run the verifier. If the GC has removed the
worktree, recreate it at `$HEAD`; the verifier is not part of the artifact.
Run
`npm run worker:verify -- --base https://erniesg-workers-preview.erniesg.workers.dev --expect workers`,
and check that `/books/build-a-coding-agent/` returns 200.

#### I4. Visible-change diff

Run this from a worktree at `$HEAD`. It needs no token:

```bash
set -euo pipefail
PREVIEW=https://erniesg-workers-preview.erniesg.workers.dev
get() { curl -fsS --retry 2 --max-time 30 "$1"; }
routes() {
  local index subs s
  index=$(get "$1/sitemap-index.xml")
  subs=$(printf '%s\n' "$index" | grep -o '<loc>[^<]*' | sed 's#<loc>https://ernie.sg/##')
  [ -n "$subs" ] || { echo "no sub-sitemaps at $1" >&2; exit 1; }
  for s in $subs; do get "$1/$s"; done \
    | grep -o '<loc>[^<]*' | sed 's#<loc>https://ernie.sg##' | sort -u
}
text_hash() {
  get "$1" | python3 -c 'import sys,re,hashlib;h=sys.stdin.read();h=re.sub(r"(?s)<(script|style)\b.*?</\1>","",h);print(hashlib.sha256(" ".join(re.sub(r"<[^>]+>"," ",h).split()).encode()).hexdigest())'
}
routes https://ernie.sg > prod.txt
routes "$PREVIEW" > preview.txt
[ -s prod.txt ] && [ -s preview.txt ] || { echo "empty route list: refetch" >&2; exit 1; }
comm -13 prod.txt preview.txt > added.txt
comm -23 prod.txt preview.txt > removed.txt
: > changed.txt
while read -r r; do
  [ "$(text_hash "https://ernie.sg$r")" = "$(text_hash "$PREVIEW$r")" ] || echo "$r" >> changed.txt
done < <(comm -12 prod.txt preview.txt)
git log --first-parent --since=2026-07-08 --format='%h %s' "$HEAD" -- src public astro.config.ts wrangler.jsonc wrangler.production.jsonc migrations > features.txt
```

Any failed fetch (a 404 or 5xx sub-sitemap or page) stops the script, so a
partial route list is refused the same way an empty one is. One test run on
2026-09-24 did return an empty list.

The ask summarizes these files: routes added (with counts per top-level
section, for example `/books/**`), routes removed, the number of pages
changed plus the first 20, and a short list of user-visible features drawn
from `features.txt` (books, the DSA practice book, margin, and so on).
Production's deployed commit is unknown. The last recorded version is from
2026-07-11, and the served content falls between the 2026-07-08 and
2026-08-28 merges. So the feature list starts at 2026-07-08 and says so.

#### I5. Exactly one owner ask

Open one GitHub issue, "Promote main to ernie.sg", with the marker
`<!-- site-promote -->`. Update it in place; never open a second one. It
contains:
- the preview URL;
- `$HEAD`, `ARTIFACT_DIGEST` and the artifact path;
- the tooling's wrangler version and the I1 step 6 bundle listing;
- the diff summary from I4;
- the precondition results from I2.

The owner's approval covers exactly what the ask states, and nothing else is
asked later:
- If `margin-db` has an unapplied migration, the ask names the file (for
  example `migrations/0001_margin_annotations.sql`), and approval covers
  applying exactly that file to `margin-db`.
- If a `WORKOS_*` name is missing on `erniesg-workers`, the ask says that
  margin sign-in will be unavailable in production until it is set. It does
  not ask the owner to set it now.
- Approval is a comment by `erniesg` on that issue that says "approve". Do
  not ask for a `/rucksack` command, because rucksack automation acts on
  those.

#### I6. Promotion, on approval only

From `$ART`, in this order:

1. Verify the artifact (the checks under I1). If they fail, stop.
2. If the ask named a migration:
   1. record a D1 Time Travel bookmark first:
      `"$WR" d1 time-travel info margin-db --config wrangler.production.jsonc`,
      and save the bookmark as `BOOKMARK`;
   2. apply it: `"$WR" d1 migrations apply margin-db --remote --config wrangler.production.jsonc`;
   3. **if the apply exits non-zero: do not deploy, and do not retry.**
      `0001_margin_annotations.sql` has no `IF NOT EXISTS`, so a retry after a
      partial apply fails with "already exists". Re-run
      `"$WR" d1 migrations list margin-db --remote --config wrangler.production.jsonc`.
      Post its output on the promotion issue, with `BOOKMARK` and the restore
      command,
      `"$WR" d1 time-travel restore margin-db --bookmark=<BOOKMARK> --config wrangler.production.jsonc`,
      marked as an owner-only action. Record the state as *failed*, not
      *could not be evaluated*, and stop. This is a stop, not a second
      decision: the promotion ends there.
3. Deploy: `"$WR" deploy --config wrangler.production.jsonc --no-bundle --message "promote $HEAD $ARTIFACT_DIGEST"`.
4. From the worktree at `$HEAD`, with `node_modules` linked to the tooling
   (I1 step 9), run
   `npm run worker:verify -- --base https://ernie.sg --expect workers`.

Always deploy the **approved** artifact, even if `origin/main` has moved
since the ask. Newer commits wait for the next promotion.

#### I7. Receipts and rollback

Record the receipt in a comment on the promotion issue, and in
`docs/deployment/cloudflare-workers-migration.md` under a new "Promotions"
table. It contains:
- `$HEAD` and `ARTIFACT_DIGEST`;
- the preview and production Worker version ids;
- `PREV_VERSION`;
- the migration applied (if any) and `BOOKMARK`;
- the verifier results.

The rollback, which runs only if the owner asks, uses the same artifact's
wrangler after the artifact check passes:

```bash
"$WR" rollback "$PREV_VERSION" --config wrangler.production.jsonc --message "rollback to $PREV_VERSION" --yes
```

It restores the previous Worker version, **not** the database. A migration
applied in I6 stays. That is acceptable for `0001_margin_annotations.sql`,
which only adds a table, indexes and triggers, because the old Worker
version has no D1 binding and never reads them. If a future promotion applies
a non-additive migration, the receipt must say so, and the rollback note
must name `BOOKMARK` and the restore command.

Close the issue after the receipt.

**Cleanup after the receipt is recorded.** Remove the ~700 MB of tooling
dependencies, and keep the record: `dist/`, `worker/`, `migrations/`, the
derived configs, `HEAD`, `tooling/package.json`, `tooling/package-lock.json`
and `MANIFEST.sha256`:

```bash
rm -rf -- "/home/ubuntu/.local/share/rucksack/deployments/erniesg-${SHA8:?}/tooling/node_modules"
```

A later rollback first restores the tooling. Run the same
`npm ci --ignore-scripts --no-audit --no-fund` in `$ART/tooling`; it checks
integrity against the kept lock. Then run the full artifact check against
the kept manifest. If that check fails, stop and post the mismatching paths
on the issue. The owner can still roll back without wrangler, from the
Cloudflare dashboard (Workers › `erniesg-workers` › Deployments), to
`PREV_VERSION`.

Keep the rest of `$ART` until the next promotion's receipt is recorded, then
remove it with
`rm -rf -- "/home/ubuntu/.local/share/rucksack/deployments/erniesg-${OLD_SHA8:?}"`.

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
  the approved artifact `$ART`, with its manifest check passing and
  `ARTIFACT_DIGEST` unchanged. Never rebuild silently.
- Part 1: stop before applying any production D1 migration that the ask did
  not name, or before applying one without first recording a Time Travel
  bookmark. After a failed production apply, stop: do not deploy and do not
  retry (I6).
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
plan builds the path the hold asked for, and makes the owner's approval the
only way into production.
