# Ernie.SG

Personal site and blog for [ernie.sg](https://ernie.sg), built with Astro, Tailwind, MDX, React islands, and Cloudflare Workers static assets.

The site is based on `astro-erudite`, but this repo is now the production source for Ernie.SG rather than a generic template checkout.

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
hash-bound receipt remains the review authority used by Rucksack.

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
