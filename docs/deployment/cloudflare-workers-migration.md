# Cloudflare Workers static-assets migration

This runbook moves `ernie.sg` from Cloudflare Pages delivery to Cloudflare Workers static assets without deleting or disabling the existing Pages project.

## Design

- `wrangler.jsonc` deploys `erniesg-workers-preview` to its safe `workers.dev` URL. It has no `ernie.sg` route.
- `wrangler.production.jsonc` deploys `erniesg-workers` with the `ernie.sg/*` route.
- Both Workers serve `./dist`, use `404-page` handling, and explicitly use `auto-trailing-slash` HTML handling.
- The production Worker route sits in front of the existing proxied `ernie.sg` CNAME. The Pages custom-domain association and `ernie.sg CNAME erniesg.pages.dev` record stay unchanged.
- `public/_headers` restores the shared security/referrer headers and prevents indexing of the `workers.dev` preview URL. Because the same static output can be served by either platform, content headers do not identify the serving platform.

This route overlay is deliberate. Removing the single Worker route immediately exposes the preserved Pages origin again without a DNS or certificate change.

Official references:

- [Migrate from Pages to Workers](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [SSG and custom 404 pages](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/)
- [Workers routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)

## Preview deployment and validation

Build and deploy the isolated preview:

```bash
npm run worker:deploy:preview
```

Use the URL printed by Wrangler and compare it with the preserved Pages deployment:

```bash
npm run worker:verify -- \
  --base https://erniesg-workers-preview.erniesg.workers.dev \
  --compare https://erniesg.pages.dev \
  --expect workers
```

The verifier checks representative English, Chinese, Korean, and Japanese routes; localized author names and tag labels; canonical and hreflang metadata; a static asset; the legacy redirect; the custom 404; robots; sitemap; RSS; content types; shared Cloudflare/security headers; the platform-owned `307`/`308` clean-URL behavior; and `noindex` on the `workers.dev` preview.

Cloudflare Workers static assets deliberately returns `307` for automatic HTML clean-URL redirects; Pages returns `308` for the same trailing-slash target. The verifier requires the documented status for each platform and an identical `Location` target. No Worker script is added just to rewrite this platform-owned response.

## Production cutover

Only run this after preview validation, the repository quality gates, and the rollback dry run pass:

```bash
npm run worker:rollback:dry-run
npm run worker:deploy:production
npm run worker:verify -- \
  --base https://ernie.sg \
  --compare https://erniesg.pages.dev \
  --expect workers
npm run worker:verify -- \
  --base https://erniesg.pages.dev \
  --expect pages
```

After cutover, confirm that the zone has exactly one new Worker route, `ernie.sg/*` to `erniesg-workers`, and that the baseline apex CNAME remains unchanged.

## Exact rollback to Pages

The rollback target is the preserved Pages project and deployment recorded in [cloudflare-pages-baseline.md](./cloudflare-pages-baseline.md).

Run:

```bash
npm run worker:rollback
```

This deletes only the `erniesg-workers` Worker and its `ernie.sg/*` route. It does not touch the Pages project, Pages deployments, Pages custom domain, DNS records, or the isolated preview Worker.

Then prove restoration:

```bash
npm run worker:verify -- \
  --base https://ernie.sg \
  --compare https://erniesg.pages.dev \
  --expect pages
```

Also verify in Cloudflare that:

1. The `ernie.sg/*` Worker route is absent.
2. The Pages custom domain `ernie.sg` remains Active with SSL enabled.
3. The proxied apex CNAME remains `ernie.sg -> erniesg.pages.dev` with automatic TTL.
4. `https://erniesg.pages.dev` and `https://d5aadc91.erniesg.pages.dev` remain reachable.

Re-cutover uses the same deterministic command:

```bash
npm run worker:deploy:production
```

## Required repository gates

Run these before a deployment from new repository changes:

```bash
npm run translate:audit
npm run translate:check -- --strict-publish
npm run translate:test
npm run i18n:check
npm run content:check
git diff --check
```

Astro hints and Browserslist notices are warnings. Translation, content, build, deployment verification, and diff failures are blockers.

## Preserved temporary fallback

Keep the Cloudflare Pages project `erniesg`, its Git integration, and its `pages.dev` URLs until a separate, explicitly approved cleanup. Never use `wrangler pages project delete` as part of this migration or rollback.

The rollback contract needs automatic builds of the production branch, not a
deployment for every pull-request or agent branch. In **Workers & Pages →
`erniesg` → Settings → Builds → Branch control**, keep `main` as the production
branch and set **Preview branches** to **None**. This prevents `codex/*` pushes
from creating Pages previews while retaining the connected project, production
fallback, custom domain, and immutable rollback URL. Re-enable a preview branch
only for a deliberate Pages-specific test.

Preview-history cleanup is a separate destructive operation. First disable new
preview builds and capture a read-only inventory. Then retain the current
production deployment and the pinned rollback deployment below; older atomic
preview deployments may be removed only after their exact IDs and branch names
are reviewed. Do not delete unrelated Pages projects merely because they appear
in the same account inventory. Cloudflare does not allow deleting the latest
deployment for a branch, so branch-control changes must come before any pruning.

Official references:

- [Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)
- [Branch build controls](https://developers.cloudflare.com/pages/configuration/branch-build-controls/)
- [Preview deployments and deletion](https://developers.cloudflare.com/pages/configuration/preview-deployments/)

## Executed migration evidence

Final evidence was captured at `2026-07-11T11:52:36+08:00`.

| Item                                             | Evidence                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Preview Worker                                   | `erniesg-workers-preview` at `https://erniesg-workers-preview.erniesg.workers.dev` |
| Preview version                                  | `77d78362-30b8-4c38-9ca8-146245451dd2`                                             |
| First production version used for rollback drill | `789ea055-4b41-4614-bcfa-907204e19e76`                                             |
| Final production Worker                          | `erniesg-workers`                                                                  |
| Final production version                         | `8ca6bbad-e2b5-45de-82ad-bee58e51868d`                                             |
| Final production route                           | `ernie.sg/* -> erniesg-workers`                                                    |
| Pages fallback deployment                        | `d5aadc91-304e-491e-b8f8-3797f873fe7d`, commit `e3a7fd6`                           |

The rollback drill used the exact documented command, `npm run worker:rollback`. Wrangler reported `Successfully deleted erniesg-workers`; the zone then reported no Worker routes; and the full verifier proved that `https://ernie.sg` once again matched `https://erniesg.pages.dev` with Pages' `308` clean-URL behavior restored. The same production deploy command then recreated the Worker and route.

After the final cutover:

- `https://ernie.sg` passed the complete verifier with Workers' documented `307` clean-URL behavior.
- `https://erniesg.pages.dev` and `https://d5aadc91.erniesg.pages.dev` independently passed the complete Pages verifier.
- The separately named preview URL independently passed the complete Workers verifier against Pages and returned `X-Robots-Tag: noindex`.
- Cloudflare's route table showed exactly `ernie.sg/* -> erniesg-workers`.
- The Pages custom domain `ernie.sg` remained Active with SSL enabled.
- The apex record remained the proxied automatic-TTL CNAME `ernie.sg -> erniesg.pages.dev`; all other recorded DNS rows remained unchanged.
- The Pages project remained connected to Git and continued to list both `erniesg.pages.dev` and `ernie.sg`.
