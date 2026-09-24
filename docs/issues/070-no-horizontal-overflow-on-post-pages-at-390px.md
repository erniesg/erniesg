# No horizontal overflow on post pages at 390px

## Provider

claude

## Goal

No page on the site scrolls sideways on a phone. That includes a phone whose
reader has enlarged the text. A build-time visual check keeps it that way for
every page, not only the post that was reported.

## Observed failure

The owner reported, with a production screenshot of
`/blog/sight-before-sound-seeing-and-searching-with-machines/` at 390px, that
the post title and the previous/next post cards run off the right edge.

Reproduction on 2026-09-24, against a local `astro build` of `origin/main`
`fb60bce` served from `dist/`, and against `https://ernie.sg`:

- **At default text size, the page does not overflow.** In Chromium and
  WebKit at 390×844, including iPhone 13 emulation, all 176 non-redirect
  pages in `dist/` have `document.scrollingElement.scrollWidth ==
  clientWidth`. Production gives the same result. The same is true at 320px
  wide.
- **With enlarged text, it does.** Setting the root font size to 200%, which
  is what Android's largest font scale and WCAG 1.4.4 "resize text" produce,
  makes 32 of 176 pages overflow at 390px:
  - Post titles: the `<h1 class="text-4xl font-bold leading-tight sm:text-5xl">`
    in `src/pages/blog/[...id].astro` has no `overflow-wrap`. At 200% a long
    word does not fit and pushes the page wider, for example
    `sight-before-sound…` to 395px and
    `developer-diaries-hack-exams…` to 397px. Most of the 32 pages are post
    pages like these.
  - Tag pages: six tag pages overflow, for example `/tags/webdev/` at 455px.
    The offender is the heading chip at `src/pages/tags/[...id].astro:67`
    (`flex items-center gap-x-1 rounded-full bg-secondary px-4 py-2 text-2xl
    font-semibold`).
  - Post bodies: inline `code` and long URLs in `.prose` overflow on the
    `moving-to-cloudflare-with-astro`, `raggaeton-…` and `berlayar-…` locale
    pages. `src/styles/global.css` gives `pre` its own scroller but gives
    inline code no `overflow-wrap`.
- **At a narrow effective width, it does too.** At 260px, which is what
  Safari's page zoom produces on a 390px phone, 9 pages overflow, all from
  inline `code` in prose or post titles.
- `src/components/PostNavigation.astro` builds each card from
  `buttonVariants`, which includes `whitespace-nowrap`. The title span
  truncates correctly, but the card relies on `overflow-hidden` on an inner
  column, with no `min-w-0` on the flex children. When the title makes the
  page wider, the cards are laid out against that wider page. That matches
  the screenshot, where the cards "run off the edge" too.

So the cause is unbreakable content with no wrap rule in three places: the
post `h1`, the tag chip, and inline code or URLs in prose. It shows up
whenever the text is large relative to the viewport. The reading shell
(`src/layouts/ReadingLayout.astro`) already sets `overflow-wrap: anywhere`,
which is why the book pages do not overflow.

## Success criteria

1. At 390×844, every page in `dist/` has
   `document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth`
   at 100% text **and** with the root font size set to 200%. Scroll containers
   that are meant to scroll (`pre`, tables inside an `overflow-x: auto`
   wrapper) are allowed. The page itself is not.
2. The fix is a rule, not per-page patches. Apply `overflow-wrap: anywhere`,
   or Tailwind's `[overflow-wrap:anywhere]` / `break-words`, to:
   - the post `h1` and the post meta row in `src/pages/blog/[...id].astro`;
   - the tag heading chip in `src/pages/tags/[...id].astro`, with
     `max-w-full`;
   - inline `code` and `a` inside `.prose` in `src/styles/global.css`.
   Add `min-w-0` to both `Link` cards and their inner column in
   `src/components/PostNavigation.astro`. Before finishing, sweep
   `src/pages/**` and `src/components/**` for other headings and chips that
   combine `text-2xl` or larger with no wrap rule. Fix them or list them, with
   a count, in the PR.
3. Titles still read as titles. Break inside a word only when the word cannot
   fit. At 100% text, the post pages at 390px look the same as before.
   Compare screenshots.
4. The visual evidence carries the check permanently (see Acceptance tests).
   It runs over **every** built page, so a page type added later (the
   `/library` and `/papers` routes from spec 061, #341's in-post controls) is
   covered without editing the test.

## Acceptance tests

- New Playwright spec `tests/e2e/site-overflow.spec.ts`, run under the root
  `playwright.config.ts` in static-build mode (`SRT_STATIC_BUILD_DIR=dist`,
  routes installed with `installStaticRoutes` from
  `tests/e2e/static-build.ts`):
  - It lists every `index.html` and `404.html` under `dist/`, skipping only
    files whose first 400 bytes contain `http-equiv="refresh"`. It fails if
    the list is empty.
  - **One generated test per page and per pass**, not one loop. Build the
    page list at module load and call `` test(`${path} @ ${pass}`, …) `` for
    each, so one slow page cannot exhaust a shared 30 s timeout and a failure
    names its page. Today that is about 176 pages × 2 passes per browser.
  - Viewport 390×844. Each test does this, in order:
    1. `page.goto(path, { waitUntil: 'load' })`;
    2. `await page.evaluate(() => document.fonts.ready)`;
    3. wait for hydration, meaning every `astro-island` has lost its `ssr`
       attribute (`await page.waitForFunction(() => !document.querySelector('astro-island[ssr]'))`);
    4. for the 200% pass only, set
       `document.documentElement.style.fontSize = '200%'`, then
       `await document.fonts.ready` again;
    5. force a reflow: read `document.body.offsetWidth`, then wait two
       `requestAnimationFrame` callbacks;
    6. assert
       `document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth`.
  - The check is **strict, with no tolerance**. The overflows seen were 5 and
    7 px (395 and 397 against 390), so a 1–2 px allowance would not hide
    them. But `scrollWidth` and `clientWidth` are integers, so sub-pixel
    rounding cannot produce a false 1 px failure, and no tolerance is
    justified.
  - A failure message names the page and the outermost element whose right
    edge passes the viewport, ignoring elements inside a **component-level**
    scroll container (see the stop conditions for what counts).
  - It requires coverage of these page types and fails if any is missing from
    `dist/`: home `/`; `/blog/`; a post in each of `en`, `zh`, `ja`, `ko`;
    `/books/`; one book (`/books/<book>/`); one book node
    (`/books/<book>/<node>/`); `/tags/<tag>/`. It adds `/library/` and
    `/papers/` whenever `dist/library/index.html` or `dist/papers/index.html`
    exists, and prints `library: not built` otherwise. Spec 061 has not
    landed at `fb60bce`, so today that line prints.
  - It saves a screenshot at 390px, default text, of one page of each type
    to `.agent/evidence/playwright/overflow-390/<type>.png`.
- The same spec passes with `SRT_E2E_BROWSER=webkit`.
- #341's in-post language and theme controls are covered by the page-level
  assertion once #341 lands, because they are part of every post page. Their
  **visibility** at 390px is asserted by #341's own acceptance tests. This
  spec does not duplicate that check.
- `.agent/verify.md` gets a short "No sideways scroll at 390px" section with
  the two commands below, next to the existing static-build instructions.
- `tests/playwright-configs.test.ts` still passes, so the new spec runs under
  exactly one config.

## Definition of done

`tests/e2e/site-overflow.spec.ts` passes in Chromium and WebKit over every
built page at 390px, at default and 200% text. Screenshots of each page type
are in the evidence directory. `.agent/verify.md` documents the check.

## Validation command

```bash
npm run build
SRT_STATIC_BUILD_DIR=dist npx playwright test tests/e2e/site-overflow.spec.ts
SRT_STATIC_BUILD_DIR=dist SRT_E2E_BROWSER=webkit npx playwright test tests/e2e/site-overflow.spec.ts
npx vitest run tests/playwright-configs.test.ts
```

## Concurrency

Static-build mode binds no port. If a dev-server run is ever needed, use
`npm run test:e2e:spec`, which picks a free port. Do not use the
`playwright.config.ts` default. This issue edits the `h1` and `PostNavigation`
markup in `src/pages/blog/[...id].astro`. Spec 069 edits that file's script
and data code, and spec 071 does not touch it. GitHub #341 adds its in-post
row directly under the title and meta line, which is the region this spec
edits. This issue can run in parallel with 069, 071 and #341. Rebase on
whichever lands first, and on a conflict with #341 keep both the wrap rules
and #341's row.

## Allowed secrets

None.

## Artifact outputs

CSS and class changes in `src/pages/blog/[...id].astro`,
`src/components/PostNavigation.astro`, `src/pages/tags/[...id].astro` and
`src/styles/global.css`; `tests/e2e/site-overflow.spec.ts`; screenshots under
`.agent/evidence/playwright/overflow-390/`; the `.agent/verify.md` section.

## Stop conditions

- Stop before setting `overflow-x: hidden` or `clip` on `html`, `body`, `main`
  or any page-level wrapper. That hides the overflow from the check without
  fixing it, and iOS Safari still lets the reader pan. A test that passes only
  because a page-level ancestor clips is not a pass.

  "Page-level" means `html`, `body`, `main`, the direct children of `body`
  and `main`, the `Layout` wrapper `div` in `src/layouts/Layout.astro`, the
  post page's outer `section` grid in `src/pages/blog/[...id].astro`, and
  `.reading-shell` in `ReadingLayout`. For each page, the spec asserts that
  every one of these present has computed `overflow-x: visible`. Any other
  element (`pre`, a table wrapper, `.reading-contents`) is component-level,
  and it may scroll.
- Stop before changing font sizes to make titles fit.
- Stop before narrowing the page list to the reported post.

## Human clarification protocol

None expected. The default-text case does not reproduce, so do not wait for
the owner's device details. The 200% case reproduces the reported shape and
is the one this spec fixes.

## Recommended response

Write the spec first and watch it fail on the 200% pass, on the 32 pages
listed above. Then add the wrap rules at the component level until it passes.
The page count is the progress measure.

## Trade-offs

`overflow-wrap: anywhere` can break a long word mid-word at extreme text
sizes. Breaking the word is better than a page that scrolls sideways, and at
default size nothing changes.

## Free-form response

Book pages already use `overflow-wrap: anywhere` in `ReadingLayout`, and they
passed every width tried. The blog was built before that shell and never got
the rule.
