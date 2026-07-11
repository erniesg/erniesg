# Cloudflare Pages rollback baseline

Captured read-only before the Workers migration at `2026-07-11T01:14:03+08:00`.

## Pages project and deployment

| Setting                   | Recorded value                             |
| ------------------------- | ------------------------------------------ |
| Pages project             | `erniesg`                                  |
| Production branch         | `main`                                     |
| Production commit         | `e3a7fd62468b120b164586b849c09fdb4f460f53` |
| Production deployment ID  | `d5aadc91-304e-491e-b8f8-3797f873fe7d`     |
| Production deployment URL | `https://d5aadc91.erniesg.pages.dev`       |
| Stable Pages URL          | `https://erniesg.pages.dev`                |
| Custom domain             | `ernie.sg` — Active, SSL enabled           |
| Git repository            | `github.com/erniesg/erniesg`               |
| Git integration           | Connected; automatic deployments enabled   |

The Pages project and both `pages.dev` URLs are rollback infrastructure. Do not delete or disable them during this migration.

## Pages build settings

| Setting                            | Recorded value  |
| ---------------------------------- | --------------- |
| Build command                      | `npm run build` |
| Build output                       | `dist`          |
| Root directory                     | repository root |
| Production branch                  | `main`          |
| Automatic deployments              | Enabled         |
| Build watch include paths          | `*`             |
| Build cache                        | Disabled        |
| Build system                       | Version 2       |
| Build comments                     | Enabled         |
| Deploy hooks                       | None            |
| Variables and secrets              | None configured |
| Bindings                           | None configured |
| Pages Functions compatibility date | `2025-02-09`    |
| Compatibility flags                | None            |
| Preview access                     | Public          |

## DNS and Worker routes

The apex record that sends `ernie.sg` to Pages is:

| Name       | Type  | Content             | Proxy   | TTL  |
| ---------- | ----- | ------------------- | ------- | ---- |
| `ernie.sg` | CNAME | `erniesg.pages.dev` | Proxied | Auto |

The remaining recorded DNS rows are:

| Name           | Type | Content                     | Proxy    | TTL / priority |
| -------------- | ---- | --------------------------- | -------- | -------------- |
| `*.ernie.sg`   | A    | `172.67.185.194`            | Proxied  | Auto           |
| `*.ernie.sg`   | A    | `104.21.0.107`              | Proxied  | Auto           |
| `www.ernie.sg` | A    | `104.21.0.107`              | Proxied  | Auto           |
| `www.ernie.sg` | A    | `172.67.185.194`            | Proxied  | Auto           |
| `*.ernie.sg`   | AAAA | `2606:4700:3034::ac43:b9c2` | Proxied  | Auto           |
| `*.ernie.sg`   | AAAA | `2606:4700:3035::6815:6b`   | Proxied  | Auto           |
| `www.ernie.sg` | AAAA | `2606:4700:3035::6815:6b`   | Proxied  | Auto           |
| `www.ernie.sg` | AAAA | `2606:4700:3034::ac43:b9c2` | Proxied  | Auto           |
| `ernie.sg`     | MX   | `aspmx.l.google.com`        | DNS only | Auto / 1       |
| `ernie.sg`     | MX   | `alt1.aspmx.l.google.com`   | DNS only | Auto / 5       |
| `ernie.sg`     | MX   | `alt2.aspmx.l.google.com`   | DNS only | Auto / 5       |
| `ernie.sg`     | MX   | `alt3.aspmx.l.google.com`   | DNS only | Auto / 10      |
| `ernie.sg`     | MX   | `alt4.aspmx.l.google.com`   | DNS only | Auto / 10      |

The Cloudflare zone had **no Worker routes configured** before migration.

## Public baseline probes

The same responses were observed on `https://ernie.sg`, `https://erniesg.pages.dev`, and the immutable deployment URL:

| Probe                                                                    | Expected result                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `/`                                                                      | `200 text/html`                                                     |
| English, zh, ko, ja versions of `/blog/moving-to-cloudflare-with-astro/` | `200 text/html`                                                     |
| `/static/logo.svg`                                                       | `200 image/svg+xml`                                                 |
| `/robots.txt`                                                            | `200 text/plain`                                                    |
| `/rss.xml`                                                               | `200 application/xml`                                               |
| `/sitemap-index.xml`                                                     | `200 application/xml`                                               |
| `/blog/161hmmds`                                                         | `308` to `/blog/161hmmds/`, then the generated legacy redirect page |
| `/migration-404-proof`                                                   | `404 text/html` with the custom 404 page                            |

Pages HTML responses recorded `server: cloudflare`, `cache-control: public, max-age=0, must-revalidate`, `referrer-policy: strict-origin-when-cross-origin`, and `x-content-type-options: nosniff`.
