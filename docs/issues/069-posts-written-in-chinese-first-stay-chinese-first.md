# Posts written in Chinese first stay Chinese first

## Provider

claude

## Goal

Every blog post records the language it was written in. A post written in
Chinese first opens in Chinese for a reader who has not chosen a language, and
search engines are told that Chinese is its default. Each post family is
listed once, and URLs that have moved answer with a real `301`.

GitHub issue #341 (the language and theme row inside each post) depends on
this issue. It reads the `originalLocale` data defined here to mark the
original in its in-post row, and it edits the same files. This issue does
**not** build that row. Once this spec is seeded and has an issue number, the
coordinator adds the queue's dependency marker to #341's body, so #341 does
not start before this issue lands.

#341 also reports that at 390px both header controls are folded into the
hamburger menu. On `main` at `fb60bce` that does not happen:
`src/components/Header.astro` renders `LanguageToggle` and `ModeToggle`
outside `MobileMenu`. At 390px, in Chromium and WebKit, both are visible
without opening the menu. The screenshots were most likely taken on the
ten-week-old production build. #341's in-post row is still wanted; only that
claim in its observed failure does not reproduce.

## Observed failure

Verified on `origin/main` at `fb60bce` and on production `https://ernie.sg`
on 2026-09-24:

- The sight-before-sound, sound-before-symbols and
  symbols-and-the-fabric-of-reality trilogy was written in Chinese. Each post
  exists as a family (`src/content/blog/<slug>/{index.mdx (English), zh.mdx,
  ja.mdx, ko.mdx}`) **and** as a separate `src/content/blog/<slug>-zh/index.mdx`
  post with `draft: false`. The `-zh` body is byte-identical to the family's
  `zh.mdx` body.
- `src/components/Head.astro` always points `hreflang="x-default"` at the
  English URL (`alternates.en`). Nothing in the content schema
  (`src/content.config.ts`) records which language a post was written in.
- On a first visit, the canonical page `/blog/<slug>/` redirects only by
  `navigator.languages` (the inline script at the end of
  `src/pages/blog/[...id].astro`). An English-language browser gets the English
  translation of a Chinese original.
- "No stored preference" never lasts past the first page.
  `LanguageToggle`'s mount effect (`src/components/ui/language-toggle.tsx`)
  writes the *detected* locale to `localStorage.siteLang`. The header script
  (`src/components/Header.astro`, `getPreferredLocale`) writes the route
  locale whenever a `/blog/<slug>/<locale>/` page is visited. So a detected
  default is stored as if the reader had chosen it. Without a fix,
  auto-opening one Chinese original would store `zh` and switch every later
  post to Chinese.
- `/authors/erniesg/` (`src/pages/authors/[...id].astro`) calls
  `getCollection('blog')` with no filter. On main it links 112 post URLs: every
  locale variant of every post, the four `-zh` duplicates, and the two drafts
  (`day-0-building-in-public-to-1m-arr`, `streaming-generated-diagrams`), whose
  pages are not built and return 404. This is where "every post is listed
  twice" shows up. The other listing pages filter correctly, each with its own
  copy of the filter.
- The 29 entries in `astro.config.ts` `redirects` (25 PubPub legacy slugs and
  the four `-zh` slugs) are built as `200` HTML pages with
  `<meta http-equiv="refresh">`, not as HTTP redirects. Production confirms
  this: `https://ernie.sg/blog/hnn0p7d9/` answers `200` with a refresh page.
  Astro's `redirects` option cannot emit a status code in static output.

## Post audit (done at `fb60bce`; use this data, do not re-derive it)

The blog has 31 directories under `src/content/blog/`: 27 post families and
4 `-zh` duplicate posts. The CJK share is the fraction of body characters
that are CJK, after removing code fences, imports, HTML tags and URLs.

| Slug | English `index.mdx` CJK share | `zh.mdx` source | Duplicate post | `originalLocale` to set |
|---|---|---|---|---|
| `sight-before-sound-seeing-and-searching-with-machines` | 0.00 | `imported-legacy`, `final` | `…-zh`, body identical to `zh.mdx` | **`zh`** (owner) |
| `sound-before-symbols-on-human-creativity-and-intelligence` | 0.00 | `imported-legacy`, `final` | `…-zh`, body identical | **`zh`** (owner) |
| `symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human` | 0.00 | `imported-legacy`, `final` | `…-zh`, body identical | **`zh`** (owner) |
| `raggaeton-scaling-a-i-augmented-writing-for-any-content` | 0.01 | `imported-legacy`, `final` | `…-zh`, body identical | `en` (default; see below) |
| the other 23 families | 0.00 to 0.04 | `codex`, `machine` | none | `en` (default) |

The other 23 families are: `a-i-art-and-anti-discrimination`,
`a-i-for-humans-be-like-its-just-x`,
`a-i-for-humans-building-a-i-native-products-and-treating-data`,
`a-i-in-non-english-regimes-and-the-things-people-say-in-china`,
`berlayar-building-a-stable-extensible-flexible-and-scalable-stack`,
`berlayar-building-a-stable-extensible-flexible-and-scalable-stack-2`,
`day-0-building-in-public-to-1m-arr` (draft),
`demo-the-sound-of-stories`,
`developer-diaries-a-i-development-be-like-scarcer-than-early-internet`,
`developer-diaries-deep-learning-in-data-poor-regimes-i`,
`developer-diaries-digitalise-any-instrument-and-start-playing`,
`developer-diaries-hack-exams-because-exams-are-not-meant-for-humans`,
`developer-diaries-the-sound-of-stories`,
`developer-diaries-were-all-bayesian-inference-machines-now`,
`fork-work-why-work-when-we-can-use-autonomous-agents-instead`,
`loss-price-love` (0.02), `mcp-for-dummies`, `microdramas-sinking-market`
(0.04), `mlops-for-museums`,
`move-aside-gpt-4-for-i-own-this-google-search-result-mlops-for-museums`
(0.01), `moving-to-cloudflare-with-astro`,
`streaming-generated-diagrams` (draft), `tutorial-air-drumming-with-a-i`.

Findings:

- No family's `index.mdx` body is mostly CJK. The highest share is 0.04.
- The only `-<locale>` duplicates are the four `-zh` directories. There are no
  `-ja`, `-ko` or `-en` duplicates.
- Every asset in the four `-zh` directories (images and one `.mp3`) exists
  byte-for-byte in its canonical family directory, so deleting the `-zh`
  directories loses no asset.
- **RAGgaeton is a duplicate, not a Chinese original.** It has the same
  duplicate shape, so its `-zh` directory is removed and redirected. The owner
  named only the trilogy as written in Chinese, and nothing in the repository
  says otherwise. The `zh.mdx` dates are one day after `index.mdx` for all four
  posts, trilogy included, which is an import artifact and not evidence. Leave
  RAGgaeton at the default `originalLocale: en`.

## Success criteria

1. **Schema.** `src/content.config.ts` adds
   `originalLocale: z.enum(['en', 'zh', 'ko', 'ja']).default('en')` to the
   `blog` collection. It is declared only on a family's `index.mdx`. A locale
   file (`zh.mdx`, `ja.mdx`, `ko.mdx`) that declares it fails the check in
   criterion 9. Set `originalLocale: zh` in the three trilogy `index.mdx`
   files and nowhere else.
2. **A family must contain its original.** A family whose `originalLocale` is
   not `en` must contain that locale's file, and that file's
   `translationSource` must not be `codex`. Otherwise the check fails.
3. **One locale decision, in one place.** Add a pure function, for example
   `resolvePostLocale({ stored, navigatorLanguages, originalLocale, available })`
   in `src/lib/i18n.ts` or a new `src/lib/post-locale.ts`, with this order:
   1. an **explicit** stored choice (criterion 4) that the family has;
   2. otherwise, if `originalLocale !== 'en'`, the original. The browser
      language is deliberately not consulted here: the owner's requirement is
      that a first visit shows the original;
   3. otherwise, the first `navigatorLanguages` entry the family has;
   4. otherwise `en`.

   Replace the `is:inline` redirect script in `src/pages/blog/[...id].astro`
   with a processed `<script>` that imports this function. The canonical URL
   `/blog/<slug>/` is the only URL that auto-redirects. A `/blog/<slug>/<locale>/`
   URL never redirects.
4. **Only an explicit choice is a stored preference, including for
   returning visitors.** Every past visitor already has `siteLang` stored,
   because `LanguageToggle`'s mount effect wrote the *detected* locale on every
   page load. A stored `siteLang` therefore does not show that anyone chose
   it; the owner has `siteLang=en` too. So:
   - Add a new key, `SITE_LOCALE_CHOICE_STORAGE_KEY = 'siteLangChoice'`, in
     `src/lib/site-preferences.ts`. It is written **only** on an explicit pick:
     `LanguageToggle.chooseLocale`, the header's `[data-language-choice]`
     click listener in `Header.astro`, and later #341's in-post row. An
     explicit pick also writes `siteLang`, so chrome display keeps working.
   - `resolvePostLocale`'s `stored` input reads `siteLangChoice` **only**. A
     bare legacy `siteLang` or `blogLang` with no `siteLangChoice` counts as no
     choice, so it is skipped in step 1 and not used in step 3. This is the
     migration. Nothing is deleted, so a rollback still finds the old keys.
   - Remove all four implicit writes of `siteLang`:
     1. the mount-effect write in `src/components/ui/language-toggle.tsx`;
     2. the route-locale write in `Header.astro` `getPreferredLocale`
        (line 102 at `fb60bce`);
     3. the `blogLang` → `siteLang` copy in the same function (line 110 at
        `fb60bce`). Keep reading `blogLang` as a display fallback, but stop
        copying it;
     4. the `if (!savedLocale) localStorage.setItem(...)` in the post page
        script.
   - Display does not change: the header chrome still reads `siteLang`, then
     `blogLang`, for its text, and a locale URL still renders its chrome in
     that locale. Arriving somewhere just does not persist anything.
5. **hreflang.** `src/components/Head.astro` points `x-default` at the
   original's URL, not at `alternates.en`. The post page passes the family's
   `originalLocale` through `Layout` to `Head` as an explicit prop. For the
   trilogy, every locale page's `x-default` is
   `https://ernie.sg/blog/<slug>/zh`. For every other family it is unchanged,
   the English URL. The per-locale `en`/`zh`/`ko`/`ja` links are unchanged.
6. **Original and translation data for the UI.** Every post page emits one
   machine-readable record of its original. For example, add
   `<script type="application/json" id="site-locale-meta">{"original":"zh"}</script>`
   next to the existing `#site-locale-paths`, which stays unchanged because
   other code parses it as a plain locale-to-path map. The header
   `LanguageToggle` dropdown reads it and adds a small secondary label to each
   post-locale item: "original" on the original, "translation" on the others.
   Add the labels as `ui.locale.original` and `ui.locale.translation` in all
   four `STATIC_TRANSLATIONS` locales (en: original / translation; zh: 原文 /
   译文; ja: 原文 / 翻訳; ko: 원문 / 번역). On pages without the record the
   dropdown is unchanged. #341's in-post row uses the same record. Do not
   build that row here.
7. **Remove the duplicates.** Delete the four directories
   `src/content/blog/<slug>-zh/` (the three trilogy slugs and
   `raggaeton-scaling-a-i-augmented-writing-for-any-content-zh`). Delete
   `isLegacyChinesePostId` from `src/lib/i18n.ts` and its call sites, since
   nothing can match it any more.
8. **One listing rule.** Add one helper, for example
   `listPostFamilies()` in `src/lib/`, that returns one entry per family
   (the canonical `index.mdx`, drafts excluded outside `import.meta.env.DEV`).
   Use it at every listing site: `src/pages/index.astro`,
   `src/pages/blog/[...page].astro`, `src/pages/tags/index.astro`,
   `src/pages/tags/[...id].astro`, `src/pages/rss.xml.ts`,
   `src/pages/authors/[...id].astro`, and the prev/next list in
   `src/pages/blog/[...id].astro`. That is seven sites, and the authors page
   is the only one that is wrong today.

   **`src/components/BlogCard.astro` is not a listing site.** It looks up
   every locale entry of one family to build the card's `data-localizations`
   (zh/ja/ko titles and URLs), so it must not receive family-only entries.
   The same module exports a second helper, for example
   `listPostEntries()`: every non-draft entry of every locale. BlogCard uses
   that in place of its own `getCollection` filter, which today depends on
   the `isLegacyChinesePostId` being deleted.
9. **301 redirects.** Move all 29 entries out of `astro.config.ts`
   `redirects` into `public/_redirects`. Astro copies that file to
   `dist/_redirects`, and Cloudflare Workers Static Assets serves it
   (`wrangler.jsonc` and `wrangler.production.jsonc` both serve `./dist`;
   `public/_headers` already works this way). Write each entry as
   `<from> <to> 301`, twice: once without and once with a trailing slash,
   because `_redirects` matches paths exactly. Point every target at its
   trailing-slash form. Each `-zh` slug goes to `/blog/<slug>/zh/`. Remove the
   `redirects` key from `astro.config.ts` so no refresh page is built at a
   redirected path. Dev servers lose these redirects; that is accepted.
10. **The deploy verifier moves with the redirects.**
    `tools/deployment/verify-cloudflare.mjs` makes two assertions about
    `/blog/161hmmds` (lines 224–251 at `fb60bce`), and both change:
    - `/blog/161hmmds` (no slash) is asserted to be `307` (Workers) or `308`
      (Pages) with `location: /blog/161hmmds/`. That is the platform's
      clean-URL behaviour. With the `_redirects` entry it becomes a `301`
      straight to
      `/blog/a-i-for-humans-building-a-i-native-products-and-treating-data/`.
      Assert that. Move the clean-URL probe to a path that is not redirected,
      `/about`, which must still answer `307` or `308` to `/about/`.
    - `/blog/161hmmds/` is asserted to return a `200` refresh page. Change it
      to a `301` to the same target.
    - Add the same `301` assertion for
      `/blog/sight-before-sound-seeing-and-searching-with-machines-zh/` →
      `/blog/sight-before-sound-seeing-and-searching-with-machines/zh/`.

    Update `tools/deployment/verify-cloudflare.test.mjs` to match. Its mock
    server serves `/blog/161hmmds` at lines 43–47.
11. **A build-time check enforces 1, 2, 5, 7, 8 and 9.** Add
    `tools/site/check-post-families.mjs --dist dist` and run it in
    `build:production` in `package.json`, straight after
    `apply-release-gate.mjs`. It fails, naming each offending path, if:
    - a directory under `src/content/blog/` ends in `-en`, `-zh`, `-ja` or
      `-ko`;
    - a locale file declares `originalLocale`;
    - criterion 2 is violated;
    - any listing page in `dist` (`index.html`, `blog/**/index.html` pages
      that are not posts, `tags/**`, `authors/**`, `rss.xml`) links the same
      family more than once, links a non-canonical locale URL as a separate
      entry, or links a draft. The checker counts only `<a href>` values (and
      `<link>` in `rss.xml`). It does not count the URLs inside a card's
      `data-localizations` JSON, which list every locale by design;
    - any post page's `x-default` differs from its family's original URL;
    - any HTML file in `dist` contains `http-equiv="refresh"`;
    - any `from` in `dist/_redirects` has a built page at that path.

    Cover the checker with a vitest file `tools/site/check-post-families.test.mjs`
    that uses small fixture trees. Each rule needs a failing fixture.

## Acceptance tests

- `tools/site/check-post-families.test.mjs`: one failing fixture per rule in
  criterion 11, and one passing fixture.
- A unit test of `resolvePostLocale` covering the four orders in
  criterion 3. It must include "no explicit choice, `navigatorLanguages` is
  `['ja']`, original `zh`" → `zh`, and "explicit choice `en`, original `zh`"
  → `en`.
- **Every family is listed once.** After `npm run build`, the checker passes.
  It covers `/`, `/blog/`, `/blog/2/`, `/blog/3/`, `/tags/**`,
  `/authors/erniesg/` and `rss.xml`.
- **hreflang.** For each trilogy slug and each of its four locale pages,
  `x-default` is `https://ernie.sg/blog/<slug>/zh`. For
  `moving-to-cloudflare-with-astro`, it is still `…/moving-to-cloudflare-with-astro`.
- **Redirects.** `dist/_redirects` contains 58 lines (29 entries, each with and
  without a trailing slash), all `301`. `dist/blog/<slug>-zh/` does not exist
  for any of the four slugs. The live check runs against a local Worker:
  `npx wrangler dev --config wrangler.jsonc --local --port "$PORT"`, then
  `curl -sI http://127.0.0.1:$PORT/blog/sight-before-sound-seeing-and-searching-with-machines-zh/`
  must show `301` and `location: /blog/sight-before-sound-seeing-and-searching-with-machines/zh/`.
  If `wrangler dev` cannot start in the sandbox, record that as *could not be
  evaluated* with the exact error. Do not report it as a pass. The static
  `_redirects` assertions still have to pass.
- **Default-locale behaviour** (Playwright, static-build mode, new file
  `tests/e2e/original-locale.spec.ts`):
  - A fresh context with empty storage and `locale: 'en-US'` opens
    `/blog/sight-before-sound-seeing-and-searching-with-machines/` and lands
    on `…/zh/`. Afterwards `localStorage.siteLang` and
    `localStorage.siteLangChoice` are both still `null`.
  - The same fresh context then opens `/blog/moving-to-cloudflare-with-astro/`
    and stays in English.
  - **Returning visitor:** a context with legacy `siteLang=en` (and a second
    one with legacy `blogLang=en`), but no `siteLangChoice`, opens the
    trilogy URL and lands on `/zh/`. `siteLang` is still `en` afterwards.
  - A context with explicit `siteLangChoice=en` opens the trilogy URL and
    stays in English.
  - A context with explicit `siteLangChoice=ja` opens
    `/blog/moving-to-cloudflare-with-astro/` and lands on its `/ja/` page.
    The explicit-choice path still works for English-original posts.
  - A context with `locale: 'ja-JP'` and no explicit choice opens the
    trilogy URL and lands on `/zh/`.
  - Opening the header dropdown on a trilogy page shows "original" on 中文
    and "translation" on the other three.
  - Choosing 日本語 from the dropdown stores `ja` in both `siteLangChoice` and
    `siteLang`.

## Definition of done

The trilogy opens in Chinese for a reader who has not chosen a language. It
declares Chinese as `x-default`, and the header toggle marks Chinese as the
original. Every family is listed once. Every moved URL answers `301`. The
build fails if any of these regress.

## Validation command

```bash
npx vitest run tools/site/check-post-families.test.mjs tools/deployment/verify-cloudflare.test.mjs src/lib/i18n.test.ts
npm run build
SRT_STATIC_BUILD_DIR=dist npx playwright test tests/e2e/original-locale.spec.ts
```

## Concurrency

Pick the `wrangler dev` port per run
(`PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')`);
never use a fixed one. This issue edits
`src/pages/blog/[...id].astro` (the locale script and the listing helper),
`src/components/Head.astro`, `src/components/Header.astro` and
`src/components/ui/language-toggle.tsx`. Spec 071 and #341 edit the same
files, so both run after this lands. Spec 070 touches the post title and
`PostNavigation` markup in `[...id].astro`, which is a different region, so it
can run in parallel.

## Allowed secrets

None.

## Artifact outputs

Schema change; three trilogy frontmatter edits; four deleted `-zh`
directories; `public/_redirects`; the `astro.config.ts` redirect removal;
`resolvePostLocale` and its test; the `siteLangChoice` key; the listing
helpers and their call sites (seven listing sites, plus BlogCard); the `Head`/`Layout` x-default prop; the `site-locale-meta` record and
the dropdown labels; `tools/site/check-post-families.mjs` and its test; the
`verify-cloudflare` update; `tests/e2e/original-locale.spec.ts`.

## Stop conditions

- Stop before changing any post URL. `/blog/<slug>/` stays the canonical URL
  of every family, including the trilogy.
- Stop before running `translate:sync`, `translate:generate` or any
  translation tool. Stop before editing any `zh.mdx`, `ja.mdx` or `ko.mdx`
  body.
- Stop before building the in-post language or theme row. That is #341.
- Stop before deploying. Production and preview deploys belong to spec 072.

## Human clarification protocol

None expected. The owner named the trilogy; the audit table above is the
data. If a check finds a family that the table does not describe, stop and
report it rather than guessing its original.

## Recommended response

Build the locale decision function and its tests first, then the
explicit-preference change. Without that change, the redirect sets a stored
preference and flips the whole site to Chinese. Then do the content deletions
and `_redirects`, and finish with the build checker, so the build enforces
the rule and not only the three posts.

## Trade-offs

A Japanese-browser reader with no explicit choice is sent to the Chinese
original of the trilogy, not to the Japanese translation. That is the owner's
stated requirement, and the header toggle, with its new "translation" label,
is one click away.

Readers who really did pick English before this change had that choice
stored only as a bare `siteLang`, which can't be told apart from a detected
value. They see the trilogy in Chinese once. Choosing English again from the
toggle stores an explicit choice, and it holds from then on. The alternative
is to trust every legacy `siteLang`, which would show the owner, and nearly
everyone else, the English translation.

Moving the redirects to `_redirects` means `astro dev` no longer serves them.
The static check and the local Worker check cover them instead.

## Free-form response

The `ja` and `ko` files of the trilogy were machine-translated from the
English file, so they are translations of a translation. Retranslating them
from the Chinese original is worth a separate issue. It is out of scope here.
