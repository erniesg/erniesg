/**
 * The book's own stylesheet, confined to rendered book content. The site's
 * reset zeroes things a book assumes (list markers, heading weight, paragraph
 * spacing), so the few rules that put them back are the site's business and
 * stay here rather than in the renderer. Shared by every page that shows
 * rendered nodes: a node page and the print edition.
 */
export const RESTORED_BOOK_CSS = `
/* The container itself keeps the site's foreground over the site's background,
   in either theme. Only the panels CONTENT_CSS gives a hard-coded light
   background pin a dark foreground to go with it: pinning it on the container
   would put near-black prose on the near-black page in dark mode, and leaving
   it off the panels would put near-white text on a white panel. Inline code is
   one of those panels; code inside a \`pre\` is not, because \`pre\` carries its
   own pair. */
.book-content { overflow-wrap: anywhere; }
.book-content .figure,
.book-content .cell,
.book-content .hint,
.book-content .solution,
.book-content :not(pre) > code { color: #1a1a1a; }
/* CONTENT_CSS's greys, its rules and its link colour are all chosen against a
   light page — --ink draws the rules above and below a challenge card, so at
   #1a1a1a on the dark page the card loses its boundary entirely. They get dark
   values on the container; the light panels take the light ones back. */
.dark .book-content { --ink: #ededed; --dim: #9a9a9a; --line: #3f3f3f; --accent: #7dd3fc; }
.dark .book-content .figure,
.dark .book-content .cell,
.dark .book-content .hint,
.dark .book-content .solution { --ink: #1a1a1a; --dim: #666; --line: #e2e2e2; --accent: #0369a1; }
/* The exercise card is a tinted panel, not a light one: in dark mode it takes
   a dark tint and keeps the site's foreground, instead of the light green
   CONTENT_CSS gives it, which left the prompt near-white on near-white. */
.dark .book-content .exercise { background: #0f1c14; border-left-color: #22c55e; }
.dark .book-content .exercise-title { color: #4ade80; }
/* The site's article rule strips horizontal padding from every \`pre\` for the
   blog's highlighted blocks, whose lines pad themselves. The book's blocks do
   not, so their own padding comes back — per kind, as CONTENT_CSS sets it. */
.book-content pre { padding-left: 16px !important; padding-right: 16px !important; }
.book-content pre.output { padding-left: 14px !important; padding-right: 14px !important; }
.book-content pre.code-hl { padding-left: 3.6em !important; padding-right: 12px !important; }
.book-content pre.code-gutter { padding-left: 0 !important; padding-right: 0 !important; }
.book-content h1, .book-content h2, .book-content h3 { font-weight: 700; }
.book-content p { margin: 1rem 0; }
.book-content ul { list-style: disc; margin: 1rem 0; padding-left: 1.4rem; }
.book-content ol { list-style: decimal; margin: 1rem 0; padding-left: 1.4rem; }
.book-content .cells, .book-content .hints { list-style: none; padding-left: 0; }
.book-content strong, .book-content b { font-weight: 700; }
.book-content em, .book-content i { font-style: italic; }
.book-content a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.book-content figure.figure { overflow-x: auto; }
.book-content img, .book-content svg { max-width: 100%; }
`

/**
 * The plain look's rail, the map and the print edition share the book's
 * variables (`--ink`, `--dim`, `--line`, `--accent`, `--panel`). These map
 * them onto each look's palette for chrome that sits outside `.book-content`.
 */
export const BOOK_CHROME_VARIABLES = `
.book-chrome { --ink: hsl(var(--foreground)); --dim: hsl(var(--muted-foreground)); --line: hsl(var(--border)); --accent: #0369a1; --panel: hsl(var(--background)); }
.dark .book-chrome { --accent: #7dd3fc; }
html[data-book-look='plain'] .book-chrome { --ink: var(--plain-ink); --dim: var(--plain-dim); --line: var(--plain-line); --accent: var(--plain-accent); --panel: var(--plain-panel); }
`
