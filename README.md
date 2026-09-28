# Ernie.SG

Personal site and blog for [ernie.sg](https://ernie.sg), built with Astro, Tailwind, MDX, React islands, and Cloudflare Workers static assets.

The site is based on `astro-erudite`, but this repo is now the production source for Ernie.SG rather than a generic template checkout.

## Research publishing boundary

`/research` is part of this owner-first Astro research-publishing application,
not a journal-management system. Current routes use `/research` and
`/research/[id]`; `/research/:slug` describes the documented target durable
publication lifecycle, not a current dynamic publication record. The current
browser importer accepts local PDF/DOCX and direct PDF URLs, but its
browser/local-first review evidence and existing research artifacts do not yet
establish durable editorial approval, release, or deployment.

- [Product contract](PRODUCT.md) — owner scope, lifecycle, and boundaries.
- [Research publishing architecture](docs/research/ARCHITECTURE.md) — current
  capabilities, target evidence requirements, and the Struct/Aether/Rucksack
  boundary.

## What This Site Does

- Publishes essays, experiments, and field notes from `src/content/blog`.
- Supports English, Chinese, Korean, and Japanese versions of the same post.
- Uses a global language switcher in the header.
- Detects the visitor's preferred browser language on first visit.
- Remembers explicit language choice in `localStorage`.
- Preserves light/dark/system theme preference through the theme toggle.
- Generates localized post routes such as `/blog/post-slug/zh`, `/blog/post-slug/ko`, and `/blog/post-slug/ja`.
- Keeps legacy PubPub redirects in `astro.config.ts`.

## Stack

| Area                | Tooling                          |
| ------------------- | -------------------------------- |
| Framework           | Astro                            |
| Styling             | Tailwind                         |
| UI islands          | React                            |
| Content             | MDX content collections          |
| Icons               | `astro-icon`, Lucide             |
| Code/math rendering | Shiki, KaTeX                     |
| Hosting             | Cloudflare Workers static assets |
| Production domain   | `ernie.sg`                       |

## Local Development

```bash
npm install
npm run dev -- --host 127.0.0.1 --port 1234
```

Open [http://127.0.0.1:1234](http://127.0.0.1:1234).

Useful commands:

```bash
npm test -- src/lib/i18n.test.ts
npm run build
npm run preview
```

### Run the book with margin locally

`npm run dev` serves the pages but not the margin API or auth, which live in
the Worker. To use highlights, notes and the rail locally, run the Worker over
a built site with a local D1 and the development principal stub instead of
WorkOS:

```bash
# 1. Development identity (.dev.vars is git-ignored). The stub is honoured only
#    when MARGIN_ENVIRONMENT is exactly `development` and the request is on
#    loopback.
cat > .dev.vars <<'VARS'
MARGIN_ENVIRONMENT=development
MARGIN_DEV_PRINCIPAL={"provider":"dev","issuer":"urn:margin:dev","subject":"owner","email":"hello@ernie.sg"}
VARS

# 2. Local database and a built site for the Worker's assets.
npx wrangler d1 migrations apply margin-db-stg --local
npm run build:astro

# 3. Serve Worker + assets.
npx wrangler dev --local --ip 127.0.0.1 --port 8787
```

Open <http://127.0.0.1:8787/books/build-a-coding-agent/>. `GET /auth/me`
should report the stub principal.

Writing needs an allowlist row. In a deployed environment the admin row is
bound once, on the first verified WorkOS sign-in with the admin email
(`recordSignIn` in `src/worker/margin/auth-routes.ts`). The stub never passes
through that callback, so locally the row is added by hand. The identity and
allowlist tables are created by that same sign-in path, not by a migration, so
the statement creates them too:

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
npx wrangler d1 execute margin-db-stg --local --command "
CREATE TABLE IF NOT EXISTS margin_identity (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL, email TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, UNIQUE (provider, issuer, subject));
CREATE TABLE IF NOT EXISTS margin_allowlist (identity_id INTEGER PRIMARY KEY REFERENCES margin_identity(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('writer', 'admin')), added_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS margin_allowlist_single_admin ON margin_allowlist (role) WHERE role = 'admin';
INSERT INTO margin_identity (provider, issuer, subject, email, first_seen_at, last_seen_at) VALUES ('dev', 'urn:margin:dev', 'owner', 'hello@ernie.sg', '$NOW', '$NOW') ON CONFLICT (provider, issuer, subject) DO NOTHING;
INSERT INTO margin_allowlist (identity_id, role, added_at) SELECT id, 'admin', '$NOW' FROM margin_identity WHERE provider = 'dev' AND subject = 'owner' ON CONFLICT (identity_id) DO UPDATE SET role = 'admin';"
```

`/auth/me` then reports `"canWrite": true, "isAdmin": true`. The schema is
`SCHEMA_STATEMENTS` in `src/worker/margin/identity.ts`; keep this block in step
with it.

The Worker entry (`src/worker/index.ts`) exports only `default`. Local
`wrangler dev` treats every named runtime export of `main` as an entrypoint and
refuses to start on a constant, so shared paths and the write gate live in
`src/worker/gate.ts`.

### Publication build runtime

`npm run publication:build` publishes its output matrix with an atomic
directory swap that shells out to `python3` (for the `renameat2` /
`renameatx_np` syscalls). Supported Linux and macOS hosts therefore need
`python3` on `PATH`; the build verifies this before any adapter, staging, or
rendering work and fails with a dependency error when it is missing.

### PDF → EPUB human-review feedback

The 20-paper review queue always writes a versioned, hash-bound receipt to
browser storage and can export it as JSON. To additionally collate criterion
labels in a local append-only log and optionally mirror them to Langfuse:

```bash
PUBLIC_PDF_REVIEW_SINK_URL=http://127.0.0.1:4319/events \
  npm run dev -- --host 127.0.0.1 --port 1234

npm run pdf:review-sink
```

The trusted sink reads `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and
optional `LANGFUSE_BASE_URL` from its process environment. Those secrets never
enter the browser bundle. Langfuse is an analysis mirror; the exported
hash-bound receipt remains browser/local-first review evidence used by
Rucksack, not a durable approval or public-release record.

## Content Model

Blog posts live under `src/content/blog`.

Default English/source post:

```text
src/content/blog/example-post/index.mdx
```

Generated or translated versions:

```text
src/content/blog/example-post/zh.mdx
src/content/blog/example-post/ko.mdx
src/content/blog/example-post/ja.mdx
```

Each localized file should share the same `translationKey` as the source post. The route builder groups posts by this key so the language switch can move between versions of the same post.

Important: legacy human Chinese posts using old `*-zh/index.mdx` paths are treated as legacy content and should not be overwritten by generated translations. New generated Chinese translations should use `zh.mdx` inside the canonical post folder.

## Site UI Translations

Static UI strings are in:

```text
src/lib/i18n.ts
```

The global language behavior is split across:

```text
src/components/ui/language-toggle.tsx
src/lib/use-site-locale.ts
src/components/Header.astro
src/layouts/Layout.astro
```

The language picker supports:

- `en`
- `zh`
- `ko`
- `ja`

## Deployment

Production is deployed as Cloudflare Worker `erniesg-workers`, serving the Astro `./dist` output as static assets on the `ernie.sg/*` route.

Deployment configuration is version controlled in:

```text
wrangler.jsonc
wrangler.production.jsonc
tools/deployment/verify-cloudflare.mjs
```

Deploy and validate an isolated `workers.dev` preview before production:

```bash
npm run worker:deploy:preview
npm run worker:verify -- \
  --base https://erniesg-workers-preview.erniesg.workers.dev \
  --compare https://erniesg.pages.dev \
  --expect workers
```

After the repository gates and rollback dry run pass, deploy production:

```bash
npm run worker:rollback:dry-run
npm run worker:deploy:production
npm run worker:verify -- \
  --base https://ernie.sg \
  --compare https://erniesg.pages.dev \
  --expect workers
```

The previous Cloudflare Pages project `erniesg` is intentionally preserved as a temporary rollback target at `https://erniesg.pages.dev`. Its Git integration and apex `CNAME` remain in place; the Worker route takes precedence for production traffic. Roll back by removing only the production Worker and route:

```bash
npm run worker:rollback
npm run worker:verify -- \
  --base https://ernie.sg \
  --compare https://erniesg.pages.dev \
  --expect pages
```

Do not delete or disable the Pages project during the rollback window. The complete baseline, cutover, validation, and rollback procedure is in [`docs/deployment/cloudflare-workers-migration.md`](docs/deployment/cloudflare-workers-migration.md).

To inspect Cloudflare deployment status from this machine:

```bash
npx wrangler deployments status --config wrangler.production.jsonc
npm_config_cache=/tmp/codex-npm-cache npx wrangler pages project list
npm_config_cache=/tmp/codex-npm-cache npx wrangler pages deployment list --project-name erniesg
```

## Current Site Copy

Homepage intro:

> Essays and experiments on building AI in the wild: turning fuzzy ideas and messy workflows into useful systems and playable tools, with notes on everything else along the way.

Metadata is configured in:

```text
src/consts.ts
src/components/Head.astro
```

## Notes For Future Translation Automation

The next step is to automate translation generation so a single source-language post can produce missing target-language MDX files while preserving manual legacy translations.

Expected guardrails:

- Detect the source language from frontmatter or content.
- Generate only missing or explicitly requested target locales.
- Never overwrite `*-zh/index.mdx` legacy posts.
- Preserve frontmatter fields, images, embeds, code blocks, math, links, and MDX components.
- Keep technical terms natural rather than leaving accidental English fragments in Chinese, Korean, or Japanese prose.
- Run `npm test -- src/lib/i18n.test.ts` and `npm run build` before publishing.
