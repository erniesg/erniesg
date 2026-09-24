# Every page keeps the language toggle and hreflang alternates

depends-on: 069

## Provider

claude

## Goal

Every page a reader can land on carries the site language toggle. Every page
that has versions in other languages declares them with `hreflang`. The build
enforces both over every built page, so a new surface (a book, `/library`,
`/papers`) cannot ship without them unless it is on a named, justified list.

## Observed failure

The owner reports that "different language versions disappeared". Checked on
2026-09-24 against a local `astro build` of `origin/main` `fb60bce` and
against production:

- **The toggle has not disappeared on main.** All 176 non-redirect HTML pages
  in `dist/` render the header `LanguageToggle` (`[data-language-trigger]`).
  That includes the 48 `/books/**` pages. `src/pages/books/**` never imports
  `Header` or `LanguageToggle` directly. They get both through
  `src/layouts/ReadingLayout.astro` → `src/layouts/Layout.astro` →
  `src/components/Header.astro`. At 390px, in Chromium and WebKit, the toggle
  is visible in the header without opening the menu.
- **hreflang exists only on blog posts.** The 100 post-locale pages (25
  published families × 4 locales) carry `en`/`zh`/`ko`/`ja`/`x-default`. No
  other page carries any `hreflang`. `ReadingLayout` accepts no `lang` or
  `alternates` prop, so a book or paper page *cannot* declare translations
  even once they exist.
- **The book pages misstate their language.** The header script
  (`updateStaticText` in `Header.astro`) sets `document.documentElement.lang`
  to the stored locale on every page. On `/books/**`, where the body text is
  English only, a reader whose preference is `zh` gets `<html lang="zh-Hans">`
  over English prose. The toggle switches the chrome, but the book content has
  no other version, which reads as "the language versions disappeared".
- **`/library` does not exist yet.** GitHub issue #321, which is spec
  `061-collapse-research-and-study-into-library-books-and-papers.md`, is open
  and not implemented at `fb60bce`. `dist/` has no `/library/` or `/papers/`.
  Those pages are built on `ReadingLayout` when 061 lands. The check below
  covers them automatically, and 061 must pass it.
- **Legacy refresh pages** (29 `http-equiv="refresh"` stubs) have no toggle.
  Spec 069 replaces all of them with `_redirects` `301`s, which is why this
  spec depends on 069.

## Decision: which pages need what

- **The toggle is required on every HTML page**, including pages with no
  translation. It is the only way to set the site-wide preference. It also
  translates the site chrome (navigation, footer, dates) on every page. If a
  page drops it, a reader who landed there in the wrong language has no way
  out except the back button.
- **hreflang alternates are required on every page whose content exists at
  more than one locale URL.** In `dist/`, a page `P` "has versions" when
  `P/<locale>/index.html` exists for a supported locale other than `en`, or
  when `P` itself is such a locale page. Those pages must list every version
  plus `x-default`. Spec 069 sets `x-default` to the original.
- **Pages with no other version emit no `hreflang`.** A single URL that
  translates only its chrome in the browser has no alternate URL to declare,
  and `hreflang` pointing at itself adds nothing. Such pages must be matched
  by the allowlist below. A page that matches no rule fails the build, so a
  new surface has to pick one.

Allowlist, as data in the checker with one reason per entry:

| Pattern | Reason |
|---|---|
| `/` | One URL; chrome translated client-side (`data-i18n-key`). |
| `/blog/`, `/blog/<n>/` | Listing; one URL; cards switch locale client-side (`data-i18n-card`). |
| `/tags/`, `/tags/<tag>/` | Listing; one URL; chrome translated client-side. |
| `/authors/`, `/authors/<id>/` | Listing; one URL; chrome translated client-side. |
| `/about/` | One URL; copy translated client-side (`about.copy`). |
| `/404.html` | Served at arbitrary paths with status 404; an alternate would name a page that does not exist. |
| `/books/**` | Book content is English-only (`books/` has no locale variants). |
| `/library/**`, `/papers/**` | Spec 061 surfaces; English-only content until a translated edition exists. |
| `/study/**` | English-only experiment page; spec 061 removes it. |

An allowlisted page that **has** versions, by the definition above, still has
to declare them. The allowlist exempts a page from alternates only when it
has none. So a future `/books/<book>/zh/` fails the build until the book pages
pass `alternates`.

## Success criteria

1. `src/layouts/ReadingLayout.astro` accepts optional `lang` and
   `alternates` props and passes them to `Layout`, the same way post pages
   pass them. The book pages pass `lang="en"` and no alternates.
2. A page states its content language, and the header script respects it.
   `Layout` renders `data-content-locale` on `<html>` from its `lang` prop.
   The header's `updateStaticText` changes `document.documentElement.lang`
   only on pages without `data-content-locale`, or when the chosen locale is
   the page's content locale. The page is marked in the template. Do not
   infer it from the URL. Book pages, and all other `ReadingLayout` pages,
   then keep `<html lang="en">` whatever the stored preference is.
3. A build-time checker `tools/site/check-page-i18n.mjs --dist dist` runs
   inside `build:production` in `package.json`, after spec 069's
   `check-post-families.mjs`. For **every** `*.html` file in `dist/`, it
   asserts:
   - exactly one header language toggle:
     `header [data-language-trigger]`. It counts only the header control, so
     #341's in-post language row, which is a separate control inside the post
     body, is neither required nor forbidden by this check;
   - no `http-equiv="refresh"`;
   - if the page has versions: an `hreflang` link for each existing version,
     each `href` resolving to a built page, and exactly one `x-default`;
   - if the page has no versions: it matches an allowlist entry, and it
     emits no `hreflang`;
   - `<html lang>` matches the page's `data-content-locale`.

   The checker prints a per-rule count and each failing path with the rule it
   broke.
4. Cover the checker with `tools/site/check-page-i18n.test.mjs` (vitest). It
   needs one failing fixture per rule: a page with no toggle; two toggles in
   the header; a refresh stub; a page with versions but a missing
   alternate; an alternate pointing at a page that is not built; a page with
   no versions that is not allowlisted; an allowlisted page that does have
   versions and declares none. It also needs one fixture proving that an
   extra in-body language control (the #341 shape) passes.
5. **One rule for every surface, including future ones.** The checker
   enumerates `dist/` and holds no list of today's pages, so `/library` and
   `/papers` from spec 061 are checked the moment they are built. Add one
   sentence to `docs/issues/061-collapse-research-and-study-into-library-books-and-papers.md`,
   under its acceptance tests: "`tools/site/check-page-i18n.mjs` passes over
   the new routes."

## Acceptance tests

- `npx vitest run tools/site/check-page-i18n.test.mjs` passes, with every
  fixture in criterion 4.
- `npm run build` passes, and the checker's output reports 0 failures over
  every built HTML page. Record the page count in the PR.
- Playwright, in static-build mode (`SRT_STATIC_BUILD_DIR=dist`), new file
  `tests/e2e/page-language.spec.ts`:
  - With `siteLang` stored as `zh`, `/books/` and one book node page keep
    `<html lang="en">`, and the header toggle is visible without opening the
    menu at 390px, 768px and 1280px.
  - On `/books/`, choosing 中文 from the header dropdown changes the
    navigation labels to Chinese and stores `zh`.
  - On a post page, choosing 日本語 still navigates to the `/ja/` URL and sets
    `<html lang="ja">`. This guards against a regression from criterion 2.

## Definition of done

Every built page has the header language toggle. Every page with versions
declares all of them. Every page without versions is on a named allowlist
with a reason. Book pages stop claiming to be Chinese. `npm run build` fails
if any of these regress, including on routes added later.

## Validation command

```bash
npx vitest run tools/site/check-page-i18n.test.mjs
npm run build
SRT_STATIC_BUILD_DIR=dist npx playwright test tests/e2e/page-language.spec.ts
```

## Concurrency

Static-build mode binds no port. This issue edits `src/layouts/Layout.astro`,
`src/layouts/ReadingLayout.astro`, `src/components/Header.astro` and
`package.json`'s `build:production`. It runs after 069, which edits
`Header.astro`, `Head.astro` and the same `build:production` line. It can run
in parallel with 070 and with #341, which adds an in-post row and does not
change the header toggle. Rebase on whichever lands first.

## Allowed secrets

None.

## Artifact outputs

The `ReadingLayout` props; `data-content-locale` and the header script
change; `tools/site/check-page-i18n.mjs` with its allowlist and test; the
`build:production` hook; `tests/e2e/page-language.spec.ts`; the one-line
addition to spec 061.

## Stop conditions

- Stop before translating book content or adding book locale routes. That is
  a content decision.
- Stop before removing or restyling the header toggle, and before building an
  in-post switcher. That is #341.
- Stop before adding `hreflang` to single-URL pages to make the check pass.
  The allowlist is the mechanism, and each entry needs its reason.

## Human clarification protocol

None expected. The decision section above settles which pages need the toggle
and which need alternates.

## Recommended response

Write the checker and its fixtures first, then run it over today's `dist/`.
It should report only the book `lang` problem once 069 has removed the
refresh stubs. Then change `Layout`, `ReadingLayout` and the header script
until it is clean.

## Trade-offs

Requiring the toggle on English-only pages means a reader can pick 中文 on a
book and still read English prose. The chrome changes and the preference is
kept for the rest of the site. The alternative, hiding the toggle there, is
what reads as "the language versions disappeared".

## Free-form response

The owner's report did not match what main renders. The toggle is present on
every page. What is missing is the declaration: nothing tells a crawler or a
reader which pages have other versions, and book pages claim a language they
are not written in. This spec makes both explicit and checks them on every
page.
