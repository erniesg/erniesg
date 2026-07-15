# Multilingual Authoring Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not overwrite protected translations. Translation must be native bilingual editorial adaptation, not direct sentence-by-sentence translation.

**Goal:** Let Ernie publish one source post in any supported language and safely generate, repair, review, and finalize EN, zh, ko, and ja versions while preserving human-written Chinese and any finalized translations.

**Architecture:** Keep the current Astro collection shape: a post family lives under `src/content/blog/<slug>/`, with `index.mdx` as the source entry and sidecars such as `zh.mdx`, `ko.mdx`, `ja.mdx`, and, for non-English sources, `en.mdx`. Add translation ownership metadata, a manifest, a locked MDX segmentation pipeline, quality gates, and family-aware route helpers. Automation may only write missing targets or machine-owned targets whose source and target hashes still match the manifest.

**Tech Stack:** Astro 5 content collections, MDX, React header controls, Node ESM tooling, unified/remark/MDX parsing, parse5 or htmlparser2 for raw HTML attributes, Vitest, `astro check`, `astro build`.

---

## Current Repo Facts

- Current working repo: `/Users/erniesg/code/erniesg/erniesg`.
- Blog schema is in `src/content.config.ts` and already has optional `lang` and `translationKey`.
- Locale helpers are in `src/lib/i18n.ts` and currently infer locale from URL suffix, treating unsuffixed posts as English.
- Header language behavior is split across `src/components/Header.astro`, `src/components/ui/language-toggle.tsx`, and `src/lib/use-site-locale.ts`.
- Theme mode is split across `src/components/ui/mode-toggle.tsx` and `src/components/Head.astro`.
- Current inventory is 27 source families, 81 sidecars, and 4 protected legacy `*-zh` folders.
- All 81 current sidecars lack `translationStatus` and `translationSource`.
- Four canonical Chinese sidecars lack `lang` and `translationKey`.
- Existing baseline commands pass:
  - `npm test -- src/lib/i18n.test.ts`
  - `npm run build`
- Existing build still reports non-fatal issues that this plan should make easier to catch:
  - Astro check hints in `src/components/Header.astro` around `define:vars` variable names.
  - KaTeX warnings from non-English text appearing inside math contexts.
- Known current translation corruption:
  - `src/content/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human/zh.mdx` has `<audio preload="meta数据">`; correct fixed HTML vocabulary is `preload="metadata"`.
  - The protected legacy source at `src/content/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human-zh/index.mdx` has `preload="metadata"`.

---

## Non-Negotiable Translation Policy

Add this policy to `AGENTS.md`, but enforce it in scripts. `AGENTS.md` guides agents; scripts prevent damage.

- Translations are not direct translations. They are native-level editorial adaptations by a bilingual technical essay editor.
- Preserve Ernie's voice: reflective, technical, blunt, personal, sometimes playful, and comfortable with code-switching.
- For Chinese, study the four protected legacy Chinese posts before translating or repairing zh.
- For Korean and Japanese, use native tech-essay register. Do not transfer English sentence order or Chinese phrasing into ko/ja.
- Research names, publications, places, product names, idioms, technical terms, and cultural references when uncertain.
- Preserve source meaning. Do not add claims, soften arguments, remove jokes, or smooth away personal voice.
- Preserve source typos and source mistakes unless a human changes the source or explicitly asks for source cleanup. Translation tooling may flag source issues in reports, but must not silently rewrite source or protected human translations.
- Translate only human-facing prose and selected human-facing strings.
- Never translate code, HTML/JSX/MDX machinery, URLs, paths, imports, exports, identifiers, fixed attribute values, data attributes, class names, IDs, component names, or math.
- Never edit protected legacy `*-zh` folders.
- Never overwrite `translationStatus: edited` or `translationStatus: final`.
- Treat missing ownership metadata as protected except during the explicit one-time classification command.
- Treat target-hash drift as protected. If a `machine` target has changed since the manifest was written, stop and ask whether to mark it `edited`, mark it `final`, or accept it as machine-owned.
- If uncertain whether text is human-written, stop and ask.

Use:

- `AGENTS.md` for repo-local agent behavior.
- `docs/translation/style/*.md` for house-style instructions.
- `docs/translation/style/rubric.md` for the quality bar and rejection reasons.
- `docs/translation/glossary.json` for recurring term decisions.
- `.translation/style-corpus/*.json` for machine-readable examples extracted from finalized human translations.
- `tools/translation/*.mjs` for enforcement and generation.
- `.githooks/pre-commit` only as an optional check-only guard.
- A reusable Codex skill only later if this workflow should apply across multiple repos.

Decision on `AGENTS.md` vs skills vs hooks:

- Put the rule in `AGENTS.md` because this repo needs every future Codex session to know that translation means native editorial adaptation, not direct translation.
- Put the real guardrails in scripts because agent instructions are advisory and can be missed.
- Use a git hook only for check-only blocking. It must not auto-generate or auto-repair content during commit.
- Do not create a reusable Codex skill yet. Create one later only if this exact translation workflow should be shared across multiple repos.

## Native Editorial Quality Model

This workflow must assume that default LLM translation is too literal unless proven otherwise. The current sidecars include clear direct-translation residue such as `数据set`, `数据源s`, `meta数据`, Korean/Japanese text that leaves English verbs like `ingest`, `chunk`, `query`, `validate` in ordinary prose, and Japanese/Korean strings shaped by English sentence order. These are not acceptable final translations.

For every generated or repaired target:

- Run a style-reference step before translation.
- For Chinese, load the protected legacy `*-zh/index.mdx` posts and extract house-style examples before translating or repairing zh.
- For Korean and Japanese, use a native technical essay rubric plus reviewer feedback. Do not infer ko/ja style from Chinese translations.
- Let technical terms stay in English only when they are code, product names, quoted source text, established borrowed terms, or intentionally code-switched by Ernie's voice. Do not create half-translated hybrids such as `数据set`, `数据源s`, `packages 사이의 compatibility issue`, or `データソースs`.
- Ask the reviewer model to identify whether each target reads like native prose in that language, not merely whether it is semantically aligned.
- When names, papers, cultural references, places, product names, idioms, or technical terms are uncertain, research them and record a concise decision in manifest `researchNotes`.
- If the configured provider cannot research, produce a `research-required` report and stop before writing a translation that depends on unresolved facts.
- Keep a short reviewer report next to each machine write in `.translation/reports/`, so Ernie can inspect why a translation passed.

Quality bar by locale:

- `zh`: Natural Mandarin essay cadence, with Ernie's human Chinese posts as the primary house style. Preserve bluntness, humor, technical code-switching, and rhythm. Reject English-shaped Mandarin.
- `ko`: Natural Korean technical essay style. Reject English word order, awkward topic-comment flow, unnecessary English verbs, and Chinese-shaped phrasing.
- `ja`: Natural Japanese technical essay style. Reject English word order, unnatural katakana/English residue, and sentence endings that read machine-translated.
- `en`: Direct, personal, technical essay voice. Reject corporate smoothing when translating from non-English sources.

Human review states:

- `machine`: generated by automation and writable only when source and target hashes match the manifest.
- `edited`: Ernie or a human touched it but has not declared it final. Automation warns about staleness but never rewrites it.
- `final`: Ernie or a human approved it. Automation warns about staleness but never rewrites it.
- `imported-legacy`: copied from protected legacy Chinese. Treat as final.

---

## Protected Legacy Chinese

These paths are read-only forever:

```text
src/content/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content-zh/**
src/content/blog/sight-before-sound-seeing-and-searching-with-machines-zh/**
src/content/blog/sound-before-symbols-on-human-creativity-and-intelligence-zh/**
src/content/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human-zh/**
```

Canonical sidecars that must be reconciled from those protected sources:

```text
src/content/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content/zh.mdx
src/content/blog/sight-before-sound-seeing-and-searching-with-machines/zh.mdx
src/content/blog/sound-before-symbols-on-human-creativity-and-intelligence/zh.mdx
src/content/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human/zh.mdx
```

Reconciliation rule:

- Read protected `*-zh/index.mdx`.
- Copy its body and human-authored frontmatter values into the canonical `slug/zh.mdx` sidecar only with explicit `--apply`.
- Add canonical ownership metadata to the sidecar.
- Do not write the protected `*-zh` folder.
- Keep redirects in `astro.config.ts` from legacy paths to canonical `/zh` routes.
- If the source protected Chinese has a typo or awkward phrasing, do not "fix" it during reconciliation. Report it only.

---

## Data Model

Modify `src/content.config.ts`:

```ts
lang: z.enum(['en', 'zh', 'ko', 'ja']).optional(),
translationKey: z.string().optional(),
translationStatus: z.enum(['machine', 'edited', 'final']).optional(),
translationSource: z.enum(['codex', 'human', 'imported-legacy']).optional(),
```

Meaning:

- `index.mdx` is the source entry for a family.
- Source may omit `lang`; omission means `en`.
- Non-English source `index.mdx` must set `lang`.
- Sidecars must include `lang`, `translationKey`, `translationStatus`, and `translationSource`.
- `translationKey` must equal the family slug.
- `machine`: automation may update only if manifest source hash and target hash still match.
- `edited`: human edited; automation may warn only.
- `final`: approved or human-written; automation may warn only.
- `translationSource: imported-legacy`: copied from protected legacy Chinese; treat as final.
- Missing `translationStatus` means protected except during `translate:classify`.

Add `.translation/manifest.json`:

```json
{
  "version": 1,
  "promptVersion": "2026-07-09",
  "families": {
    "my-post": {
      "source": {
        "locale": "en",
        "path": "src/content/blog/my-post/index.mdx",
        "sha256": "source-body-and-frontmatter-hash"
      },
      "targets": {
        "zh": {
          "path": "src/content/blog/my-post/zh.mdx",
          "status": "machine",
          "sourceSha256": "source-body-and-frontmatter-hash-at-generation",
          "targetSha256": "target-body-and-frontmatter-hash-at-generation",
          "lockedRegionSha256": "hash-of-all-non-translatable-source-regions",
          "model": "configured-translator-model",
          "reviewerModel": "configured-reviewer-model",
          "promptVersion": "2026-07-09",
          "reviewScore": 0.91,
          "researchNotes": [
            {
              "term": "Return on Happiness",
              "decision": "Preserve source spelling if source says Happinss; report source typo separately."
            }
          ]
        }
      }
    }
  }
}
```

Manifest write rules:

- Write manifest updates atomically through a temp file plus rename.
- Never log provider secrets.
- Never write a target if its current hash differs from the manifest `targetSha256`, unless a human explicitly runs a future accept command.
- When a human runs finalize, update manifest `status`, `targetSha256`, and `reviewScore`.

---

## Translation Segmentation Contract

The most important implementation detail: do not send whole MDX files to a model as loose text.

Create a segmentation layer that produces an ordered list of units:

```ts
type TranslationUnit = {
  id: string
  path: string
  locale: 'en' | 'zh' | 'ko' | 'ja'
  kind:
    | 'frontmatter-title'
    | 'frontmatter-description'
    | 'markdown-heading'
    | 'markdown-paragraph'
    | 'markdown-list-item'
    | 'markdown-blockquote'
    | 'link-text'
    | 'image-alt'
    | 'html-human-attribute'
  sourceText: string
  translatable: boolean
  lockedText?: string
  contextBefore?: string
  contextAfter?: string
}
```

Translate:

- frontmatter `title`
- frontmatter `description`
- markdown headings
- markdown paragraphs
- blockquote text
- list item prose
- link display text, but never link URL
- image alt text if it describes image content for readers
- selected raw HTML/JSX human attributes: `alt`, `title`, `aria-label`, `aria-description`

Lock byte-for-byte:

- frontmatter keys
- frontmatter values for `date`, `authors`, `tags`, `image`, `draft`, `lang`, `translationKey`, `translationStatus`, `translationSource`
- code fences
- inline code
- imports
- exports
- JSX component names
- HTML/JSX tag names
- all attribute names
- fixed HTML vocabulary values, including `preload="metadata"`, `preload="none"`, `preload="auto"`, `controls`, `allowfullscreen`, `loading`, `decoding`, `target`, `rel`, `type`
- `src`, `href`, `id`, `class`, `style`, `data-*`, `aria-describedby`, `aria-controls`, `aria-labelledby`
- URLs
- relative paths
- markdown image destinations
- markdown link destinations
- math blocks and inline math

Fixture that must fail before repair and pass after repair:

```mdx
<audio controls="true" preload="meta数据" src="./file.mp3" alt="reader-facing text" aria-describedby="caption-id"></audio>
```

Expected repaired structure:

```mdx
<audio controls="true" preload="metadata" src="./file.mp3" alt="localized reader-facing text" aria-describedby="caption-id"></audio>
```

The segmenter should never ask the model to translate `preload`, `src`, or `aria-describedby`.

---

## Files To Add

```text
AGENTS.md
docs/translation/style/en.md
docs/translation/style/zh.md
docs/translation/style/ko.md
docs/translation/style/ja.md
docs/translation/style/rubric.md
docs/translation/glossary.json
.translation/config.json
.translation/manifest.json
.translation/reports/.gitkeep
.translation/style-corpus/.gitkeep
tools/translation/content.mjs
tools/translation/segments.mjs
tools/translation/locked-regions.mjs
tools/translation/audit.mjs
tools/translation/classify.mjs
tools/translation/reconcile-legacy.mjs
tools/translation/style-corpus.mjs
tools/translation/check-quality.mjs
tools/translation/prompts.mjs
tools/translation/providers.mjs
tools/translation/generate.mjs
tools/translation/sync.mjs
tools/translation/repair.mjs
tools/translation/finalize.mjs
tools/translation/mark-edited.mjs
tools/translation/__fixtures__/corrupted-audio.mdx
tools/translation/__fixtures__/direct-translation-smell.mdx
tools/translation/__fixtures__/locked-code.mdx
tools/translation/__fixtures__/mixed-mdx.mdx
tools/translation/content.test.mjs
tools/translation/segments.test.mjs
tools/translation/audit.test.mjs
tools/translation/manifest.test.mjs
```

Add to `.gitignore`:

```text
.translation/cache/
.translation/reports/*.tmp.json
```

---

## Files To Modify

```text
astro.config.ts
package.json
src/content.config.ts
src/lib/i18n.ts
src/lib/i18n.test.ts
src/lib/use-site-locale.ts
src/pages/blog/[...id].astro
src/pages/blog/[...page].astro
src/pages/index.astro
src/pages/tags/index.astro
src/pages/tags/[...id].astro
src/pages/authors/[...id].astro
src/pages/rss.xml.ts
src/components/BlogCard.astro
src/components/Header.astro
src/components/ui/language-toggle.tsx
src/components/ui/mode-toggle.tsx
src/components/Head.astro
```

---

## Task 1: Add Translation Policy Docs

**Files:**

- Create: `AGENTS.md`
- Create: `docs/translation/style/en.md`
- Create: `docs/translation/style/zh.md`
- Create: `docs/translation/style/ko.md`
- Create: `docs/translation/style/ja.md`
- Create: `docs/translation/style/rubric.md`
- Create: `docs/translation/glossary.json`

- [ ] **Step 1: Create `AGENTS.md` with repo-local translation rules**

Required content:

```md
# Agent Instructions

## Multilingual Blog Translation

- Translate like a native bilingual editor, not like a direct translation engine.
- Preserve Ernie's voice: reflective, technical, blunt, personal, and occasionally playful.
- Translate only human-facing prose and explicitly allowed human-facing attributes.
- Never translate code, inline code, code fences, MDX imports/exports, JSX component names, HTML tag names, attribute names, URLs, file paths, `src`, `href`, `id`, `class`, `style`, `data-*`, `aria-describedby`, or fixed HTML vocabulary such as `preload="metadata"`.
- Never edit protected legacy Chinese folders ending in `-zh`.
- Never overwrite `translationStatus: edited` or `translationStatus: final`.
- Treat missing translation ownership metadata as protected unless running the explicit classification command.
- Treat target-hash drift in `.translation/manifest.json` as protected.
- For Chinese, study the protected legacy Chinese posts as house style before translating or repairing zh.
- For Korean and Japanese, use natural native tech-essay register, not English sentence order with localized words.
- Research technical terms, names, publications, idioms, cultural references, and place names when uncertain.
- Reject direct translation smell. Examples that must be repaired in machine translations include half-localized plurals like `数据源s`, `数据set`, Korean/Japanese prose that keeps English verbs like `ingest`, `chunk`, `query`, `validate` outside code or quoted terms, and literal English sentence order.
- If research is needed and no research-capable tool/provider is configured, stop with a report instead of guessing.
- If unsure whether a translation is human-written, stop and ask.
```

- [ ] **Step 2: Create style guides**

`docs/translation/style/zh.md` must state:

```md
# Chinese Translation Style

Use the four protected legacy `*-zh` posts as the house-style reference. Aim for natural Mandarin essay cadence. Avoid stiff English-shaped Mandarin, awkward word-for-word transitions, and unnecessary translation of product names or code-adjacent terms.

Keep Ernie's technical-personal voice. When source prose is blunt or playful, preserve that energy instead of smoothing it into generic formal Chinese.
```

`docs/translation/style/ko.md` must state:

```md
# Korean Translation Style

Write like a native Korean technical essayist. Avoid literal English syntax and avoid Chinese-shaped phrasing. Preserve technical precision, personal voice, and rhythm. Product names, code terms, URLs, and identifiers remain unchanged unless the source uses a known Korean-facing name.
```

`docs/translation/style/ja.md` must state:

```md
# Japanese Translation Style

Write like a native Japanese technical essayist. Avoid literal English syntax. Preserve argument structure, humor, and personal tone while making the prose read naturally in Japanese. Product names, code terms, URLs, and identifiers remain unchanged unless a standard Japanese-facing name is clearly established.
```

`docs/translation/style/en.md` must state:

```md
# English Translation Style

When translating into English from a non-English source, preserve Ernie's direct technical-personal essay voice. Do not flatten the writing into corporate prose. Keep source-specific cultural references unless a short clarification is needed for English readers.
```

`docs/translation/style/rubric.md` must state:

```md
# Translation Quality Rubric

Machine translations must pass both mechanical safety and native editorial quality.

Reject a translation when it:

- reads like sentence-by-sentence translation from the source
- preserves English word order in Chinese, Korean, or Japanese
- leaves ordinary prose as half-translated technical residue, such as `数据set`, `数据源s`, `データソースs`, or Korean/Japanese prose using `ingest`, `chunk`, `query`, `validate` as untranslated verbs
- over-translates code, product names, URLs, paths, identifiers, fixed HTML values, math, or quoted source text
- removes Ernie's bluntness, humor, uncertainty, or code-switching
- adds claims not present in the source
- weakens titles or descriptions into generic SEO text
- uses culturally wrong terminology for names, places, publications, idioms, or technical concepts

For Chinese, compare against the protected legacy Chinese posts before approving. For Korean and Japanese, require native technical essay register and reviewer notes explaining why the prose passes.
```

- [ ] **Step 3: Create initial glossary**

Create `docs/translation/glossary.json`:

```json
{
  "version": 1,
  "terms": {
    "A.I.": {
      "preserve": true,
      "note": "Keep Ernie's dotted spelling when it appears in source prose."
    },
    "MDX": {
      "preserve": true,
      "note": "Technical format name."
    },
    "Codex": {
      "preserve": true,
      "note": "Product/tool name."
    },
    "RAGgaeton": {
      "preserve": true,
      "note": "Project name and pun."
    }
  }
}
```

- [ ] **Step 4: Validate**

Run:

```bash
test -f AGENTS.md
test -f docs/translation/style/zh.md
test -f docs/translation/style/rubric.md
test -f docs/translation/glossary.json
```

Expected: no output and exit code 0.

- [ ] **Step 5: Commit**

Run:

```bash
git add AGENTS.md docs/translation
git commit -m "docs: add multilingual translation policy"
```

---

## Task 2: Add Dependencies And Package Scripts

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`

- [ ] **Step 1: Install parser and test tooling dependencies**

Run:

```bash
npm install --save-dev fast-glob gray-matter unified remark-parse remark-mdx remark-frontmatter remark-stringify unist-util-visit parse5 yaml
```

Expected: `package.json` and `package-lock.json` update.

- [ ] **Step 2: Add scripts to `package.json`**

Keep existing scripts and add:

```json
{
  "scripts": {
    "translate:audit": "node tools/translation/audit.mjs",
    "translate:classify": "node tools/translation/classify.mjs",
    "translate:reconcile-legacy": "node tools/translation/reconcile-legacy.mjs",
    "translate:style-corpus": "node tools/translation/style-corpus.mjs",
    "translate:check": "node tools/translation/check-quality.mjs",
    "translate:generate": "node tools/translation/generate.mjs",
    "translate:sync": "node tools/translation/sync.mjs",
    "translate:repair": "node tools/translation/repair.mjs",
    "translate:finalize": "node tools/translation/finalize.mjs",
    "translate:mark-edited": "node tools/translation/mark-edited.mjs",
    "translate:test": "vitest run tools/translation/*.test.mjs",
    "content:check": "npm run translate:audit && npm run translate:check && npm test -- src/lib/i18n.test.ts && npm run build",
    "content:publish": "npm run translate:sync && npm run content:check"
  }
}
```

- [ ] **Step 3: Add translation cache ignores**

Append to `.gitignore`:

```gitignore
.translation/cache/
.translation/reports/*.tmp.json
```

- [ ] **Step 4: Validate**

Run:

```bash
node -e "const pkg=require('./package.json'); for (const name of ['translate:audit','translate:style-corpus','translate:sync','translate:repair','translate:mark-edited','translate:test','content:check']) { if (!pkg.scripts[name]) throw new Error('missing script '+name) }"
```

Expected: no output and exit code 0.

- [ ] **Step 5: Commit**

Run:

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: add translation workflow tooling"
```

---

## Task 3: Add Translation Ownership Schema

**Files:**

- Modify: `src/content.config.ts`

- [ ] **Step 1: Extend blog schema**

Add these optional fields next to existing `lang` and `translationKey`:

```ts
translationStatus: z.enum(['machine', 'edited', 'final']).optional(),
translationSource: z.enum(['codex', 'human', 'imported-legacy']).optional(),
```

- [ ] **Step 2: Validate**

Run:

```bash
npm run build
```

Expected: build passes because fields are optional.

- [ ] **Step 3: Commit**

Run:

```bash
git add src/content.config.ts
git commit -m "feat: add translation ownership metadata"
```

---

## Task 4: Build Content Inventory And Manifest Helpers

**Files:**

- Create: `.translation/config.json`
- Create: `.translation/manifest.json`
- Create: `.translation/reports/.gitkeep`
- Create: `.translation/style-corpus/.gitkeep`
- Create: `tools/translation/content.mjs`
- Create: `tools/translation/manifest.test.mjs`

- [ ] **Step 1: Create `.translation/config.json`**

```json
{
  "supportedLocales": ["en", "zh", "ko", "ja"],
  "defaultLocale": "en",
  "protectedLegacyDirs": [
    "src/content/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content-zh",
    "src/content/blog/sight-before-sound-seeing-and-searching-with-machines-zh",
    "src/content/blog/sound-before-symbols-on-human-creativity-and-intelligence-zh",
    "src/content/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human-zh"
  ],
  "protectedHumanTranslations": [
    "src/content/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content/zh.mdx",
    "src/content/blog/sight-before-sound-seeing-and-searching-with-machines/zh.mdx",
    "src/content/blog/sound-before-symbols-on-human-creativity-and-intelligence/zh.mdx",
    "src/content/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human/zh.mdx"
  ],
  "promptVersion": "2026-07-09",
  "minReviewScore": 0.88,
  "requiredReviewerPasses": 2
}
```

- [ ] **Step 2: Create initial `.translation/manifest.json`**

```json
{
  "version": 1,
  "promptVersion": "2026-07-09",
  "families": {}
}
```

- [ ] **Step 3: Create translation artifact directories**

Run:

```bash
mkdir -p .translation/reports .translation/style-corpus
touch .translation/reports/.gitkeep .translation/style-corpus/.gitkeep
```

Expected: directories exist. Report files are allowed to be committed when they are durable reviewer evidence; only temporary `*.tmp.json` reports are ignored.

- [ ] **Step 4: Implement `tools/translation/content.mjs`**

Required exports:

```js
export const SUPPORTED_LOCALES = ['en', 'zh', 'ko', 'ja']
export const BLOG_ROOT = 'src/content/blog'
export const PROTECTED_LEGACY_DIRS = [
  'src/content/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content-zh',
  'src/content/blog/sight-before-sound-seeing-and-searching-with-machines-zh',
  'src/content/blog/sound-before-symbols-on-human-creativity-and-intelligence-zh',
  'src/content/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human-zh',
]
export const PROTECTED_HUMAN_TRANSLATIONS = [
  'src/content/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content/zh.mdx',
  'src/content/blog/sight-before-sound-seeing-and-searching-with-machines/zh.mdx',
  'src/content/blog/sound-before-symbols-on-human-creativity-and-intelligence/zh.mdx',
  'src/content/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human/zh.mdx',
]
export function sha256(text) {}
export function isProtectedLegacyPath(filePath) {}
export function isProtectedHumanTranslationPath(filePath) {}
export function isSourceEntry(filePath) {}
export function getSidecarLocale(filePath) {}
export function getFamilySlug(filePath) {}
export function canWriteTranslation(frontmatter, manifestTarget, currentTargetText) {}
export async function listFamilies() {}
export async function readMdx(filePath) {}
export async function writeMdxAtomic(filePath, text) {}
```

Behavior:

- `sha256(text)` returns a hex SHA-256 digest.
- `isProtectedLegacyPath(path)` returns true for any path under the four protected legacy dirs.
- `isProtectedHumanTranslationPath(path)` returns true for canonical sidecars listed in `.translation/config.json` `protectedHumanTranslations`, until `reconcile-legacy` marks them `final/imported-legacy`.
- `isSourceEntry(path)` returns true only for `src/content/blog/<slug>/index.mdx` where `<slug>` does not end with `-zh`.
- `getSidecarLocale(path)` returns `zh`, `ko`, `ja`, or `en` for sidecar files such as `zh.mdx`; returns null for `index.mdx`.
- `getFamilySlug(path)` returns the blog family folder name.
- `canWriteTranslation` returns true only when:
  - the file does not exist, or
  - frontmatter has `translationStatus: machine`, and
  - the path is not protected, and
  - the path is not in `protectedHumanTranslations`, and
  - manifest target hash matches the current target hash.
- `listFamilies()` returns source families and sidecars, excluding protected legacy folders from writable families but listing them separately as protected references.
- `writeMdxAtomic` writes to a temp file in the same directory and renames it.

- [ ] **Step 5: Add manifest tests**

`tools/translation/manifest.test.mjs` must test:

```js
import { describe, expect, it } from 'vitest'
import { canWriteTranslation, sha256 } from './content.mjs'

describe('translation manifest safety', () => {
  it('allows writing missing machine targets', () => {
    expect(canWriteTranslation({ translationStatus: 'machine' }, null, '')).toBe(true)
  })

  it('blocks edited and final targets', () => {
    expect(canWriteTranslation({ translationStatus: 'edited' }, null, '')).toBe(false)
    expect(canWriteTranslation({ translationStatus: 'final' }, null, '')).toBe(false)
  })

  it('blocks hash drift for machine targets', () => {
    const current = 'human changed text'
    const manifestTarget = { targetSha256: sha256('old machine text') }
    expect(canWriteTranslation({ translationStatus: 'machine' }, manifestTarget, current)).toBe(false)
  })

  it('allows matching machine target hash', () => {
    const current = 'old machine text'
    const manifestTarget = { targetSha256: sha256(current) }
    expect(canWriteTranslation({ translationStatus: 'machine' }, manifestTarget, current)).toBe(true)
  })
})
```

- [ ] **Step 6: Validate inventory**

Run:

```bash
node tools/translation/content.mjs --list
npm run translate:test
```

Expected inventory:

```text
source families: 27
sidecars: 81
protected legacy zh folders: 4
sidecars missing translationStatus: 81
sidecars missing translationSource: 81
sidecars missing lang: 4
sidecars missing translationKey: 4
```

- [ ] **Step 7: Commit**

Run:

```bash
git add .translation tools/translation/content.mjs tools/translation/manifest.test.mjs
git commit -m "feat: add translation inventory and manifest safety"
```

---

## Task 5: Build MDX Segmenter And Locked-Region Tests

**Files:**

- Create: `tools/translation/segments.mjs`
- Create: `tools/translation/locked-regions.mjs`
- Create: `tools/translation/segments.test.mjs`
- Create: `tools/translation/__fixtures__/corrupted-audio.mdx`
- Create: `tools/translation/__fixtures__/direct-translation-smell.mdx`
- Create: `tools/translation/__fixtures__/locked-code.mdx`
- Create: `tools/translation/__fixtures__/mixed-mdx.mdx`

- [ ] **Step 1: Create corrupted audio fixture**

`tools/translation/__fixtures__/corrupted-audio.mdx`:

```mdx
---
title: "Symbols"
description: "Description"
date: 2023-08-05
authors: ["erniesg"]
tags: ["AI"]
image: "./logo.png"
draft: false
---

<audio controls="true" preload="meta数据" src="./file.mp3" alt="Maybe the half-life of love is remorse." aria-describedby="caption-id"></audio>
```

- [ ] **Step 2: Create direct-translation smell fixture**

`tools/translation/__fixtures__/direct-translation-smell.mdx`:

```mdx
---
title: "Fork Work"
description: "A machine-shaped translation sample"
date: 2026-07-09
authors: ["erniesg"]
tags: ["AI"]
lang: "zh"
translationKey: "fork-work"
translationStatus: "machine"
translationSource: "codex"
draft: false
---

这就是我如何最终把 75 个 items chunk 到我的 `Deep Lake` 数据set 里。现在我已经在思考 ingest 更多 数据源s 的需求，让我们 query 所有 SQL schemas。
```

This fixture must fail editorial quality checks. Code spans such as `` `Deep Lake` `` stay locked, but ordinary prose must not contain half-translated fragments like `数据set`, `数据源s`, or English verbs used as Chinese verbs.

- [ ] **Step 3: Create locked code fixture**

`tools/translation/__fixtures__/locked-code.mdx`:

````mdx
---
title: "Code Post"
description: "A post with code"
date: 2026-07-09
authors: ["erniesg"]
tags: ["AI"]
draft: false
---

Translate this sentence.

Do not translate `npm run build`.

```ts
const preload = "metadata"
console.log(preload)
```

[Translate this link text](https://example.com/path?x=metadata)
````

- [ ] **Step 4: Create mixed MDX fixture**

`tools/translation/__fixtures__/mixed-mdx.mdx`:

```mdx
---
title: "A.I. for Humans"
description: "A short description"
date: 2026-07-09
authors: ["erniesg"]
tags: ["AI", "tools"]
draft: false
---

import Demo from './Demo.astro'

# Translate this heading

<Demo data-id="keep-this" title="Translate this title for readers" />

![Translate image alt](./image.png)
```

- [ ] **Step 5: Implement segment extraction**

`tools/translation/segments.mjs` must export:

```js
export function extractSegments(mdxText, options = {}) {}
export function applySegmentTranslations(mdxText, translatedSegments, options = {}) {}
export function listLockedRegions(mdxText) {}
export function assertLockedRegionsPreserved(sourceMdx, targetMdx) {}
```

Required behavior:

- Parse frontmatter with `gray-matter`.
- Parse markdown/MDX body with unified, `remark-parse`, `remark-mdx`, and `remark-frontmatter`.
- For raw HTML, parse attributes with `parse5`.
- Extract translatable units only for the approved kinds in the segmentation contract.
- Represent all locked regions with exact source text and stable IDs.
- `applySegmentTranslations` reconstructs an MDX document while preserving every locked region.
- `assertLockedRegionsPreserved` throws an error with region ID and path if any locked region changes.

- [ ] **Step 6: Implement locked-region helpers**

`tools/translation/locked-regions.mjs` must export:

```js
export const LOCKED_HTML_ATTRIBUTES = new Set([
  'src',
  'href',
  'id',
  'class',
  'style',
  'data-*',
  'aria-describedby',
  'aria-controls',
  'aria-labelledby',
  'allowfullscreen',
  'controls',
  'preload',
  'loading',
  'decoding',
  'target',
  'rel',
  'type',
])

export const TRANSLATABLE_HTML_ATTRIBUTES = new Set([
  'alt',
  'title',
  'aria-label',
  'aria-description',
])

export function isLockedAttribute(name) {}
export function isTranslatableAttribute(name) {}
export function isFixedHtmlVocabulary(name, value) {}
```

Required fixed vocabulary:

```js
const FIXED_VALUES = {
  preload: new Set(['metadata', 'none', 'auto']),
  loading: new Set(['lazy', 'eager']),
  decoding: new Set(['async', 'auto', 'sync']),
  target: new Set(['_blank', '_self', '_parent', '_top']),
}
```

- [ ] **Step 7: Add segmenter tests**

`tools/translation/segments.test.mjs` must test:

```js
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applySegmentTranslations,
  assertLockedRegionsPreserved,
  extractSegments,
} from './segments.mjs'

describe('MDX translation segmenter', () => {
  it('extracts title, description, prose, link text, and reader-facing attributes', () => {
    const mdx = fs.readFileSync('tools/translation/__fixtures__/mixed-mdx.mdx', 'utf8')
    const segments = extractSegments(mdx)
    expect(segments.some((segment) => segment.kind === 'frontmatter-title')).toBe(true)
    expect(segments.some((segment) => segment.kind === 'frontmatter-description')).toBe(true)
    expect(segments.some((segment) => segment.sourceText === 'Translate this heading')).toBe(true)
    expect(segments.some((segment) => segment.sourceText === 'Translate this title for readers')).toBe(true)
    expect(segments.some((segment) => segment.sourceText === 'Translate image alt')).toBe(true)
  })

  it('does not translate inline code, code fences, URLs, imports, or fixed HTML vocabulary', () => {
    const mdx = fs.readFileSync('tools/translation/__fixtures__/locked-code.mdx', 'utf8')
    const segments = extractSegments(mdx)
    expect(segments.some((segment) => segment.sourceText.includes('npm run build'))).toBe(false)
    expect(segments.some((segment) => segment.sourceText.includes('const preload'))).toBe(false)
    expect(segments.some((segment) => segment.sourceText.includes('https://example.com'))).toBe(false)
  })

  it('preserves locked regions byte-for-byte after applying translations', () => {
    const mdx = fs.readFileSync('tools/translation/__fixtures__/locked-code.mdx', 'utf8')
    const segments = extractSegments(mdx)
    const translated = Object.fromEntries(
      segments.map((segment) => [segment.id, `[zh] ${segment.sourceText}`]),
    )
    const output = applySegmentTranslations(mdx, translated)
    expect(() => assertLockedRegionsPreserved(mdx, output)).not.toThrow()
    expect(output).toContain('```ts')
    expect(output).toContain('const preload = "metadata"')
    expect(output).toContain('https://example.com/path?x=metadata')
  })
})
```

- [ ] **Step 8: Validate**

Run:

```bash
npm run translate:test
```

Expected: all translation tests pass.

- [ ] **Step 9: Commit**

Run:

```bash
git add tools/translation/segments.mjs tools/translation/locked-regions.mjs tools/translation/segments.test.mjs tools/translation/__fixtures__
git commit -m "feat: segment translatable MDX safely"
```

---

## Task 6: Add Audit Command

**Files:**

- Create: `tools/translation/audit.mjs`
- Create: `tools/translation/audit.test.mjs`

- [ ] **Step 1: Implement audit command**

`tools/translation/audit.mjs` must fail on:

- planned write to protected `*-zh`
- sidecar missing `lang`, `translationKey`, `translationStatus`, or `translationSource`
- sidecar `translationKey` not equal to folder slug
- sidecar filename not matching `lang`
- missing source `index.mdx`
- stale `machine` target after source digest changed
- target-hash drift for `machine`
- changed locked regions
- corrupted HTML fixed vocabulary, including `preload="meta数据"`
- translated URLs, relative paths, code fences, inline code, imports, exports, component names, tag names, or locked attribute values
- legacy-derived canonical Chinese sidecar not marked `translationStatus: final` and `translationSource: imported-legacy`
- direct-translation smell in `machine` targets when the smell is mechanical and high-confidence, including mixed-script pluralization (`数据源s`, `データソースs`), hybrid compounds (`数据set`, `meta数据`, `metaデータ` when not an accepted term), and untranslated English verbs used as normal zh/ko/ja prose outside code, quotes, product names, or glossary-approved terms

It must warn on:

- missing target locales
- stale `edited` or `final`
- low review score
- missing manifest entry
- suspected source typo such as `Happinss`, without changing it
- possible direct-translation smell that requires reviewer judgment, such as English-like clause order, repeated literal connectives, awkward topic flow, or unnatural sentence endings

- [ ] **Step 2: Add audit tests**

`tools/translation/audit.test.mjs` must test:

```js
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { auditMdxText } from './audit.mjs'

describe('translation audit', () => {
  it('fails corrupted fixed HTML vocabulary', () => {
    const mdx = fs.readFileSync('tools/translation/__fixtures__/corrupted-audio.mdx', 'utf8')
    const result = auditMdxText(mdx, { path: 'example/zh.mdx', locale: 'zh' })
    expect(result.errors.some((error) => error.includes('preload'))).toBe(true)
  })

  it('does not require source typo repair', () => {
    const mdx = '---\\ntitle: "x"\\ndescription: "x"\\ndate: 2026-07-09\\n---\\n\\nReturn on Happinss'
    const result = auditMdxText(mdx, { path: 'example/index.mdx', locale: 'en' })
    expect(result.errors.length).toBe(0)
    expect(result.warnings.some((warning) => warning.includes('Happinss'))).toBe(true)
  })

  it('fails high-confidence direct translation residue in machine targets', () => {
    const mdx = fs.readFileSync('tools/translation/__fixtures__/direct-translation-smell.mdx', 'utf8')
    const result = auditMdxText(mdx, { path: 'example/zh.mdx', locale: 'zh' })
    expect(result.errors.some((error) => error.includes('direct translation'))).toBe(true)
  })
})
```

- [ ] **Step 3: Validate before classification**

Run:

```bash
npm run translate:audit
```

Expected before metadata classification: failure reporting current sidecars missing ownership metadata, with these counts:

```text
sidecars missing translationStatus: 81
sidecars missing translationSource: 81
sidecars missing lang: 4
sidecars missing translationKey: 4
```

- [ ] **Step 4: Commit**

Run:

```bash
git add tools/translation/audit.mjs tools/translation/audit.test.mjs
git commit -m "feat: audit translation safety"
```

---

## Task 7: Add Classification Command

**Files:**

- Create: `tools/translation/classify.mjs`

- [ ] **Step 1: Implement classification**

Behavior:

- `--dry-run` prints proposed metadata changes and exits without writes.
- Classification produces three buckets:
  - `protected-human`: protected legacy folders and canonical sidecars listed in `.translation/config.json` `protectedHumanTranslations`
  - `generated-machine`: sidecars that are not protected, not hash-drifted, and match the current generated sidecar pattern
  - `unknown`: anything the script cannot confidently classify
- Existing generated sidecars in `generated-machine` become:

```yaml
translationStatus: "machine"
translationSource: "codex"
```

- Four canonical Chinese sidecars paired with protected legacy posts are not marked `final/imported-legacy` until `reconcile-legacy` succeeds.
- Any sidecar already marked `edited`, `final`, `human`, or `imported-legacy` remains untouched.
- Unknown files remain unclassified and protected.
- Body content is not changed.
- Frontmatter formatting may change only for keys required by the metadata operation.
- To avoid accidentally taking ownership of Ernie's writing, `--apply` must fail if the `unknown` bucket is non-empty unless the user passes explicit `--mark-machine path/to/file.mdx` or adds the path to `protectedHumanTranslations`.

- [ ] **Step 2: Validate dry run**

Run:

```bash
npm run translate:classify -- --dry-run
```

Expected:

```text
proposed generated-machine metadata updates: 77
protected human sidecars: 4
unknown sidecars: 0
body changes: 0
protected legacy writes: 0
```

- [ ] **Step 3: Apply classification**

Run:

```bash
npm run translate:classify -- --apply
npm run translate:audit
```

Expected:

- Audit no longer reports missing `translationStatus` or `translationSource`.
- Audit treats four protected-human canonical Chinese sidecars as blocked from machine ownership and reports that they still require reconciliation.
- Audit reports the known corrupted `preload="meta数据"` until reconciliation or repair fixes it.

- [ ] **Step 4: Commit**

Run:

```bash
git add tools/translation/classify.mjs src/content/blog .translation/manifest.json
git commit -m "feat: classify existing machine translations"
```

---

## Task 8: Reconcile Protected Legacy Chinese

**Files:**

- Create: `tools/translation/reconcile-legacy.mjs`
- Modify: four canonical `src/content/blog/<slug>/zh.mdx` sidecars only when `--apply` is used
- Modify: `.translation/manifest.json`

- [ ] **Step 1: Implement reconciliation**

Behavior:

- Pair the four protected folders with their canonical sidecars.
- Compare protected source body and canonical sidecar body.
- Report structure differences, text differences, and locked-region corruption.
- With `--apply`, copy protected body into canonical sidecar.
- With `--apply`, add canonical sidecar metadata:

```yaml
lang: "zh"
translationKey: "<slug>"
translationStatus: "final"
translationSource: "imported-legacy"
```

- Never write protected `*-zh` folders.

- [ ] **Step 2: Validate dry run**

Run:

```bash
npm run translate:reconcile-legacy -- --dry-run
```

Expected:

```text
legacy pairs checked: 4
protected legacy writes: 0
canonical sidecars requiring update: 4
known corruption: preload="meta数据" differs from protected preload="metadata"
```

- [ ] **Step 3: Apply reconciliation**

Run:

```bash
npm run translate:reconcile-legacy -- --apply
npm run translate:audit
npm run build
```

Expected:

- Protected `*-zh` folders unchanged.
- Four canonical `zh.mdx` sidecars match protected bodies.
- Four canonical `zh.mdx` sidecars are marked `final/imported-legacy`.
- `preload="meta数据"` no longer exists in canonical sidecars.

- [ ] **Step 4: Commit**

Run:

```bash
git add tools/translation/reconcile-legacy.mjs src/content/blog/*/zh.mdx .translation/manifest.json
git commit -m "fix: reconcile legacy Chinese translations"
```

---

## Task 9: Add Style Corpus, Prompt, And Provider Layer

**Files:**

- Create: `.translation/style-corpus/.gitkeep`
- Create: `tools/translation/style-corpus.mjs`
- Create: `tools/translation/prompts.mjs`
- Create: `tools/translation/providers.mjs`

- [ ] **Step 1: Implement style corpus extraction**

`tools/translation/style-corpus.mjs` must export:

```js
export async function buildStyleCorpus({ locale, dryRun }) {}
export async function loadStyleCorpus(locale) {}
export function extractVoiceNotes(mdxTexts, locale) {}
```

Behavior:

- For `zh`, read only protected legacy Chinese `*-zh/index.mdx` files and canonical `final/imported-legacy` Chinese sidecars.
- For `ko` and `ja`, do not pretend the repo has a human house corpus. Use `docs/translation/style/ko.md`, `docs/translation/style/ja.md`, and `docs/translation/style/rubric.md`.
- Extract short examples of cadence, paragraph rhythm, technical code-switching, titles, and how Ernie handles jokes or blunt lines.
- Write `.translation/style-corpus/zh.json` only after reconciliation succeeds.
- Never write or modify source MDX while building the corpus.
- Include corpus hashes so stale style examples can be rebuilt when protected legacy content changes.
- `--check` verifies the current corpus exists and source hashes match, without writing.

Expected `.translation/style-corpus/zh.json` shape:

```json
{
  "locale": "zh",
  "version": 1,
  "sources": [
    {
      "path": "src/content/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content-zh/index.mdx",
      "sha256": "..."
    }
  ],
  "voiceNotes": [
    "Uses direct first-person technical reflection without corporate smoothing.",
    "Keeps project names and some AI/product terms in English when they are names or code-adjacent.",
    "Uses natural Mandarin transitions rather than mirroring English clause order."
  ],
  "examples": [
    {
      "kind": "paragraph",
      "text": "short excerpt under the repo's own content policy",
      "note": "Natural Mandarin cadence with technical code-switching."
    }
  ]
}
```

- [ ] **Step 2: Validate style corpus dry run**

Run:

```bash
npm run translate:style-corpus -- --locale zh --dry-run
```

Expected:

```text
locale: zh
protected legacy sources: 4
write target: .translation/style-corpus/zh.json
dry run: true
```

- [ ] **Step 3: Implement prompts**

`tools/translation/prompts.mjs` must export:

```js
export function buildTranslatorPrompt({ sourceLocale, targetLocale, styleGuide, styleCorpus, glossary, rubric, segments, researchNotes }) {}
export function buildReviewerPrompt({ sourceLocale, targetLocale, sourceSegments, targetSegments, styleGuide, styleCorpus, glossary, rubric }) {}
```

Translator system instruction must include:

```text
You are a native-level bilingual literary and technical editor translating Ernie's personal technical essays.

Do not translate sentence by sentence. Produce a native editorial adaptation that preserves meaning, voice, rhythm, humor, and intent.

Translate only the provided translatable segment text. Do not alter locked regions. Do not translate code, URLs, paths, identifiers, HTML or JSX syntax, frontmatter keys, fixed HTML vocabulary, imports, exports, or math.

Research names, publications, cultural references, technical terms, idioms, places, and product names when uncertain. Record research decisions in concise notes.

Reject direct translation smell. The result must read like native prose in the target language, not source-language syntax with localized words.

Return strict JSON matching the requested schema.
```

Chinese addendum:

```text
Before translating into Chinese, use the protected legacy Chinese posts as house-style references. Match their natural essay cadence where appropriate. Avoid stiff literal English syntax and awkward mixed-language residue.
```

Reviewer prompt must ask for JSON:

```json
{
  "verdict": "pass",
  "score": 0.91,
  "issues": [],
  "suggestions": [],
  "directTranslationSmell": false,
  "lockedRegionRisk": false,
  "nativeRegisterRisk": false,
  "voiceLossRisk": false,
  "requiresResearch": false,
  "researchNotes": []
}
```

- [ ] **Step 4: Implement provider abstraction**

`tools/translation/providers.mjs` must export:

```js
export async function translateSegments({ sourceLocale, targetLocale, segments, styleGuide, styleCorpus, glossary, rubric, dryRun }) {}
export async function reviewTranslation({ sourceLocale, targetLocale, sourceSegments, targetSegments, styleGuide, styleCorpus, glossary, rubric, dryRun }) {}
```

Required behavior:

- Dry run returns deterministic mock translations prefixed with `[<locale>]`.
- Real provider mode reads API credentials only from environment variables.
- No provider request logs full secrets.
- Provider returns structured JSON, not raw MDX.
- Provider may include research notes.
- Provider must not receive locked region text except short context required for language quality.
- If the provider or active Codex session can use search tools, it may research uncertain terms before writing. If not, it must return `requiresResearch: true` with unresolved terms and the command must refuse to write.
- Reviewer output must explain why native register passes for the target language. A bare semantic-alignment pass is not enough.

- [ ] **Step 5: Validate dry run**

Run:

```bash
npm run translate:generate -- --slug a-i-for-humans-be-like-its-just-x --targets zh --dry-run
```

Expected after Task 11 creates `generate.mjs`: no writes, shows prompt version, source locale, target locale, style-corpus status, segment count, locked-region count, provider mode `dry-run`.

- [ ] **Step 6: Commit**

Run:

```bash
git add .translation/style-corpus tools/translation/style-corpus.mjs tools/translation/prompts.mjs tools/translation/providers.mjs
git commit -m "feat: add native translation style and provider layer"
```

---

## Task 10: Add Quality Checker

**Files:**

- Create: `tools/translation/check-quality.mjs`

- [ ] **Step 1: Implement mechanical checks**

`check-quality.mjs` must check:

- frontmatter parses
- MDX compiles through Astro-compatible parser
- locked regions preserved
- code fences preserved
- inline code preserved
- URLs preserved
- imports/exports preserved
- image/audio/video/iframe paths preserved
- JSX/HTML tag names preserved
- locked attribute names and values preserved
- math preserved
- protected names preserved
- no fixed HTML vocabulary corruption
- no high-confidence direct-translation residue from the rubric fixture

- [ ] **Step 2: Implement editorial checks**

Call reviewer model for machine targets and fail if:

- `verdict` is `fail`
- score is below `.translation/config.json` `minReviewScore`
- direct translation smell is true
- locked region risk is true
- native register risk is true
- voice loss risk is true
- unresolved `requiresResearch` is true
- reviewer identifies awkward native phrasing, lost voice, changed meaning, weak title/description, terminology errors, bad over-translation of proper nouns, or under-translation where readers need clarification

The reviewer must compare:

- source segments against target segments for meaning
- target prose against `docs/translation/style/<locale>.md`
- target prose against `docs/translation/style/rubric.md`
- Chinese targets against `.translation/style-corpus/zh.json`

The checker must fail `tools/translation/__fixtures__/direct-translation-smell.mdx` and include the exact offending phrases in the report.

- [ ] **Step 3: Validate**

Run:

```bash
npm run translate:check -- --dry-run
```

Expected before repairs:

- Existing `machine` translations may warn or fail depending on classification and reconciliation state.
- `final/imported-legacy` translations are mechanically checked but not rewritten.
- Direct-translation smell in current generated sidecars is reported as repair work, not silently accepted.

- [ ] **Step 4: Commit**

Run:

```bash
git add tools/translation/check-quality.mjs
git commit -m "feat: add translation quality checks"
```

---

## Task 11: Add Generate, Sync, Repair, Edited, And Finalize Commands

**Files:**

- Create: `tools/translation/generate.mjs`
- Create: `tools/translation/sync.mjs`
- Create: `tools/translation/repair.mjs`
- Create: `tools/translation/finalize.mjs`
- Create: `tools/translation/mark-edited.mjs`

- [ ] **Step 1: Implement `generate.mjs`**

Behavior:

- Accept `--slug <slug>`.
- Accept `--targets zh,ko,ja,en`.
- Accept `--source <locale>` for non-English source posts.
- Dry run prints planned writes.
- Creates missing sidecars only.
- Refuses to overwrite existing sidecars.
- Runs style-corpus loading, segmenter, provider translation, reconstruction, locked-region assertion, reviewer, quality checker, and audit before writing.
- Refuses to write if reviewer reports direct-translation smell, native-register risk, voice-loss risk, locked-region risk, or unresolved research.

- [ ] **Step 2: Implement `sync.mjs`**

Behavior:

- Accept `--slug <slug>` or `--all`.
- Generates missing targets.
- Refreshes stale `machine` targets only if manifest source hash changed and target hash still matches manifest.
- Warns but does not update `edited` or `final`.
- Refuses target-hash drift.
- If a target hash drift is detected, prints exact next commands: `translate:mark-edited` or `translate:finalize`; it must not guess.

- [ ] **Step 3: Implement `repair.mjs`**

Behavior:

- Accept `--slug <slug>`, `--locale <locale>`, or `--all-machine`.
- Repairs only `translationStatus: machine`.
- Runs mechanical locked-region repair first for fixed vocabulary corruption.
- Runs editorial repair with reviewer feedback and style-corpus/rubric guidance.
- Refuses protected legacy paths, `edited`, `final`, missing-status files, and hash-drifted machine files.
- For existing machine translations, repair should target the current direct-translation residue first, including half-localized technical plurals and English verbs left in ordinary zh/ko/ja prose.

- [ ] **Step 4: Implement `mark-edited.mjs`**

Behavior:

- Accept `--slug <slug> --locale <locale>`.
- Marks a human-touched but not approved target:

```yaml
translationStatus: "edited"
translationSource: "human"
```

- Updates manifest target hash.
- Does not alter body content.
- Future `sync` and `repair` warn only and never overwrite it.

- [ ] **Step 5: Implement `finalize.mjs`**

Behavior:

- Accept `--slug <slug> --locale <locale>`.
- Marks a reviewed translation:

```yaml
translationStatus: "final"
translationSource: "human"
```

- Updates manifest target hash.
- Does not alter body content.
- If target is `machine`, run `translate:check` first and require reviewer pass before finalizing unless `--human-reviewed` is provided.
- If target is `edited`, mark it `final/human` without changing body after hash update.

- [ ] **Step 6: Validate dry runs**

Run:

```bash
npm run translate:sync -- --dry-run
npm run translate:repair -- --all-machine --dry-run
npm run translate:mark-edited -- --slug my-post --locale zh --dry-run
```

Expected:

- `sync` lists missing or stale writable `machine` targets only.
- `repair` lists machine-owned targets only.
- `mark-edited` prints the target and proposed metadata without body changes.
- Protected legacy paths are listed as protected references, never as write targets.

- [ ] **Step 7: Commit**

Run:

```bash
git add tools/translation/generate.mjs tools/translation/sync.mjs tools/translation/repair.mjs tools/translation/mark-edited.mjs tools/translation/finalize.mjs
git commit -m "feat: add translation generation workflow"
```

---

## Task 12: Refactor Blog I18n Helpers

**Files:**

- Modify: `src/lib/i18n.ts`
- Modify: `src/lib/i18n.test.ts`

- [ ] **Step 1: Add family-aware helpers**

Add helpers:

```ts
export function getSourceLocale(entry: { data: { lang?: SupportedLocale } }): SupportedLocale {
  return entry.data.lang ?? DEFAULT_LOCALE
}

export function getPostFamilyId(entryOrId: { id: string; data?: { translationKey?: string } } | string): string {
  if (typeof entryOrId === 'string') return getCanonicalPostId(entryOrId)
  return entryOrId.data?.translationKey ?? getCanonicalPostId(entryOrId.id)
}

export function getPostEntryLocale(entry: { id: string; data: { lang?: SupportedLocale } }): SupportedLocale {
  return entry.data.lang ?? getLocaleFromPostId(entry.id)
}

export function isSourcePostEntry(entry: { id: string; data: { translationKey?: string } }): boolean {
  return !isLegacyChinesePostId(entry.id) && !entry.data.translationKey && entry.id.split('/').at(-1) === entry.id
}

export function getLocalizedPostPath(familyId: string, locale: SupportedLocale, sourceLocale: SupportedLocale): string {
  return locale === sourceLocale ? `/blog/${familyId}` : `/blog/${familyId}/${locale}`
}
```

Also add a helper that builds only real sibling paths from entries:

```ts
export function getAvailableLocalePaths(
  familyId: string,
  entries: Array<{ id: string; data: { lang?: SupportedLocale; translationKey?: string } }>,
): Partial<Record<SupportedLocale, string>> {
  const source = entries.find((entry) => getPostFamilyId(entry) === familyId && isSourcePostEntry(entry))
  const sourceLocale = source ? getSourceLocale(source) : DEFAULT_LOCALE
  return Object.fromEntries(
    entries
      .filter((entry) => getPostFamilyId(entry) === familyId)
      .map((entry) => {
        const locale = getPostEntryLocale(entry)
        return [locale, getLocalizedPostPath(familyId, locale, sourceLocale)]
      }),
  ) as Partial<Record<SupportedLocale, string>>
}
```

- [ ] **Step 2: Update tests**

Add test cases:

- English source routes `/blog/slug`.
- English sidecars route `/blog/slug/zh`, `/ko`, `/ja`.
- Non-English source routes `/blog/slug`.
- Non-English English sidecar routes `/blog/slug/en`.
- Missing target does not synthesize a URL.
- Legacy `*-zh` is excluded from sibling maps and writable maps.

- [ ] **Step 3: Validate**

Run:

```bash
npm test -- src/lib/i18n.test.ts
```

Expected: all i18n tests pass.

- [ ] **Step 4: Commit**

Run:

```bash
git add src/lib/i18n.ts src/lib/i18n.test.ts
git commit -m "feat: make blog i18n family-aware"
```

---

## Task 13: Update Blog Route And Cards

**Files:**

- Modify: `src/pages/blog/[...id].astro`
- Modify: `src/components/BlogCard.astro`
- Modify: `astro.config.ts`

- [ ] **Step 1: Update blog route**

Behavior:

- `getStaticPaths` includes real source and sidecar entries.
- It excludes protected legacy `*-zh` content entries from generated pages.
- It keeps `astro.config.ts` redirects from old `*-zh` routes to canonical `/zh`.
- Current post locale comes from entry metadata and route family, not only URL suffix.
- Canonical URL uses actual current route.
- Alternates include only real localized siblings.
- Language redirect uses `siteLang`, not `blogLang`.
- If selected locale is unavailable, update preference and stay on the current valid URL.

- [ ] **Step 2: Update `BlogCard.astro`**

Behavior:

- Card localizations are built from actual sibling entries.
- Card links use `getAvailableLocalePaths`.
- No card synthesizes a locale URL for a missing sidecar.
- Card defaults to current `siteLang` when available; otherwise source entry.

- [ ] **Step 3: Ensure legacy redirects remain**

`astro.config.ts` must continue redirecting:

```ts
'/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content-zh':
  '/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content/zh',
'/blog/sight-before-sound-seeing-and-searching-with-machines-zh':
  '/blog/sight-before-sound-seeing-and-searching-with-machines/zh',
'/blog/sound-before-symbols-on-human-creativity-and-intelligence-zh':
  '/blog/sound-before-symbols-on-human-creativity-and-intelligence/zh',
'/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human-zh':
  '/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human/zh',
```

- [ ] **Step 4: Validate**

Run:

```bash
npm run build
```

Spot-check generated routes:

```text
/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content
/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content/zh
/blog/a-i-for-humans-be-like-its-just-x/ko
/blog/a-i-for-humans-be-like-its-just-x/ja
```

Expected: protected legacy `*-zh` content pages are not generated as normal pages, but redirects still exist.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/pages/blog/[...id].astro src/components/BlogCard.astro astro.config.ts
git commit -m "feat: route blog translations by actual siblings"
```

---

## Task 14: Update Listings, Tags, Authors, RSS

**Files:**

- Modify: `src/pages/blog/[...page].astro`
- Modify: `src/pages/index.astro`
- Modify: `src/pages/tags/index.astro`
- Modify: `src/pages/tags/[...id].astro`
- Modify: `src/pages/authors/[...id].astro`
- Modify: `src/pages/rss.xml.ts`

- [ ] **Step 1: Replace default-English filtering**

Replace `isCanonicalDefaultPostId()` filtering with `isSourcePostEntry()`.

- [ ] **Step 2: Fix author duplicate issue**

`src/pages/authors/[...id].astro` currently includes every localized sidecar for an author. Filter to source post entries only:

```ts
const authorPosts = allPosts
  .filter((post) => isSourcePostEntry(post))
  .filter((post) => post.data.authors?.includes(author.id))
  .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
```

- [ ] **Step 3: Validate**

Run:

```bash
npm run build
```

Expected:

- Home page shows each post family once.
- Blog index shows each post family once.
- Tags count each post family once.
- Author page shows each post family once.
- RSS includes each post family once.

- [ ] **Step 4: Commit**

Run:

```bash
git add src/pages/blog/[...page].astro src/pages/index.astro src/pages/tags/index.astro src/pages/tags/[...id].astro src/pages/authors/[...id].astro src/pages/rss.xml.ts
git commit -m "feat: list source post families once"
```

---

## Task 15: Update Global Language Preference

**Files:**

- Modify: `src/lib/use-site-locale.ts`
- Modify: `src/components/Header.astro`
- Modify: `src/components/ui/language-toggle.tsx`

- [ ] **Step 1: Move from `blogLang` to `siteLang`**

Behavior:

- Read `siteLang` first.
- If `siteLang` is absent and old `blogLang` exists, migrate it into `siteLang` and remove `blogLang`.
- If neither exists, detect from `navigator.languages`.
- Write only `siteLang`.
- Dispatch `site-language-change`.
- Temporarily also dispatch `blog-language-change` for compatibility until all listeners are migrated.

- [ ] **Step 2: Make route switching use actual siblings**

`LanguageToggle` should not synthesize paths from URL string operations alone. It should consume a page-provided map such as:

```html
<script type="application/json" id="available-locale-paths">
  {"en":"/blog/post","zh":"/blog/post/zh"}
</script>
```

Behavior:

- If selected locale has a real path, navigate to it.
- If selected locale does not have a real path, update UI preference and stay.

- [ ] **Step 3: Update `Header.astro` listeners**

Behavior:

- Static text updates on `site-language-change`.
- Blog cards update on `site-language-change`.
- Existing `blog-language-change` listener remains only as a temporary compatibility path.
- Fix current Astro check hints by making `define:vars` names explicit and type-safe.

- [ ] **Step 4: Manual validation**

Run dev server:

```bash
npm run dev
```

Manual checks:

- Choose zh on `/`: static UI and cards update.
- Open a blog post with zh sibling: route changes to `/zh`.
- Choose ja on a page without ja sibling after creating a test missing sidecar locally: UI preference updates, URL stays valid.
- Reload: `siteLang` persists.
- Put `blogLang=ko` in localStorage, reload: `siteLang=ko` is created and `blogLang` is removed.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/lib/use-site-locale.ts src/components/Header.astro src/components/ui/language-toggle.tsx
git commit -m "feat: make language preference site-wide"
```

---

## Task 16: Fix Theme Persistence

**Files:**

- Modify: `src/components/ui/mode-toggle.tsx`
- Modify: `src/components/Head.astro`

- [ ] **Step 1: Store stable theme preference**

Behavior:

- Store `theme = light | dark | system`.
- Migrate old `theme-light` to `light`.
- `light`: remove `dark` class.
- `dark`: add `dark` class.
- `system`: follow `prefers-color-scheme`.
- Listen to OS theme changes only when stored preference is `system`.
- Never rewrite `system` to resolved `light` or `dark`.

- [ ] **Step 2: Validate manually**

Run:

```bash
npm run dev
```

Manual checks:

- Choose light, reload: `localStorage.theme` remains `light`.
- Choose dark, reload: `localStorage.theme` remains `dark`.
- Choose system, reload: `localStorage.theme` remains `system`.
- Change OS theme while system selected: site follows.

- [ ] **Step 3: Commit**

Run:

```bash
git add src/components/ui/mode-toggle.tsx src/components/Head.astro
git commit -m "fix: persist system theme preference"
```

---

## Task 17: Repair Existing Machine Translations

**Files:**

- Modify: only `src/content/blog/**/{en,zh,ko,ja}.mdx` with `translationStatus: machine`
- Modify: `.translation/manifest.json`
- Do not modify: protected `src/content/blog/*-zh/**`
- Do not modify: `translationStatus: edited`
- Do not modify: `translationStatus: final`

- [ ] **Step 1: Dry-run all repairs**

Run:

```bash
npm run translate:repair -- --all-machine --dry-run
```

Expected:

- Protected legacy folders: 0 write targets.
- Final/imported-legacy Chinese sidecars: 0 write targets.
- Edited/final translations: 0 write targets.
- Machine translations with locked-region corruption are listed.
- Machine translations with direct-translation smell are listed.

- [ ] **Step 2: Repair machine translations**

Run:

```bash
npm run translate:repair -- --all-machine
```

Required repair behavior:

- Fix mechanical corruptions such as `preload="meta数据"` only in writable machine translations.
- Improve non-native direct translations through segment-based translation and reviewer feedback.
- Use `.translation/style-corpus/zh.json` before repairing zh, and use `docs/translation/style/rubric.md` plus native-register review before repairing ko/ja.
- Repair current known direct-translation patterns such as `数据set`, `数据源s`, `数据 itself`, Korean/Japanese prose using `ingest`, `chunk`, `query`, `validate` as untranslated verbs, and literal English clause order.
- Preserve locked regions byte-for-byte.
- Preserve source meaning and voice.
- Do not rewrite source posts.
- Do not rewrite protected human Chinese.
- Write reviewer reports under `.translation/reports/` and manifest `reviewScore`/`researchNotes` for each repaired target.

- [ ] **Step 3: Validate repaired content**

Run:

```bash
npm run translate:check
npm run translate:audit
npm run build
```

Expected:

- No locked-region corruption.
- No writes to protected legacy folders.
- Reviewer score for repaired machine translations is at least `.translation/config.json` `minReviewScore`.
- Reviewer reports explicitly say native register passed and direct-translation smell is false.
- Build passes.

- [ ] **Step 4: Manual diff review**

Run:

```bash
git diff -- src/content/blog .translation/manifest.json
```

Review requirements:

- Confirm code fences, inline code, URLs, paths, imports, exports, JSX/HTML structures remain unchanged.
- Confirm prose is native and not direct translation.
- Confirm legacy-derived final Chinese sidecars are not changed by this repair task.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/content/blog .translation/manifest.json
git commit -m "fix: repair machine translations"
```

---

## Task 18: New Publish Workflow

**Files:**

- No new files unless the user creates a new post.

- [ ] **Step 1: Publish a new English source post**

After creating `src/content/blog/my-post/index.mdx`, run:

```bash
npm run translate:sync -- --slug my-post
npm run content:check
```

Expected:

- Missing `zh`, `ko`, and `ja` sidecars are generated.
- Generated sidecars are `translationStatus: machine`.
- Locked regions are preserved.
- Reviewer passes.

- [ ] **Step 2: Publish a new non-English source post**

For a new Chinese source at `src/content/blog/my-post/index.mdx` with `lang: "zh"`, run:

```bash
npm run translate:sync -- --slug my-post --source zh
npm run content:check
```

Expected:

- Missing `en`, `ko`, and `ja` sidecars are generated.
- Source route remains `/blog/my-post`.
- English sidecar route is `/blog/my-post/en`.

- [ ] **Step 3: Finalize a reviewed translation**

If Ernie edits a machine translation but does not want to approve it as final yet:

```bash
npm run translate:mark-edited -- --slug my-post --locale zh
npm run translate:audit
```

Expected:

- Target becomes `translationStatus: edited` and `translationSource: human`.
- Future `translate:sync` never updates it.
- If source changes later, audit warns that edited translation may be stale.

After Ernie edits and approves a target:

```bash
npm run translate:finalize -- --slug my-post --locale zh
npm run translate:audit
```

Expected:

- Target becomes `translationStatus: final` and `translationSource: human`.
- Future `translate:sync` never updates it.
- If source changes later, audit warns that final translation may be stale.

---

## Task 19: Optional Check-Only Git Hook

**Files:**

- Create: `.githooks/pre-commit`

- [ ] **Step 1: Create hook**

```bash
#!/usr/bin/env bash
set -euo pipefail
npm run translate:audit
npm run translate:check
```

- [ ] **Step 2: Enable hook locally**

Run:

```bash
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
```

Expected: hook blocks unsafe translation changes, but never generates, repairs, classifies, or mutates files.

- [ ] **Step 3: Commit hook if desired**

Run:

```bash
git add .githooks/pre-commit
git commit -m "chore: add translation safety pre-commit hook"
```

---

## Final Acceptance

Run:

```bash
npm run translate:audit
npm run translate:style-corpus -- --locale zh --check
npm run translate:check
npm run translate:test
npm test -- src/lib/i18n.test.ts
npm run build
```

Manual smoke:

```text
/
/blog
/about
/tags
/authors/erniesg
/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content
/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content/zh
/blog/a-i-for-humans-be-like-its-just-x/ko
/blog/a-i-for-humans-be-like-its-just-x/ja
```

Acceptance criteria:

- New source posts in any supported source language can generate missing EN/zh/ko/ja targets.
- Existing machine translations can be repaired.
- Protected legacy Chinese folders remain untouched.
- Canonical Chinese sidecars for legacy posts are reconciled from protected sources and marked `final/imported-legacy`.
- `edited` and `final` translations are never overwritten.
- Human-edited but not finalized translations can be marked `edited/human` and remain protected.
- Target-hash drift stops automation.
- Finalized translations stop auto-updating.
- Stale `edited` and `final` translations warn only.
- Quality checks reject direct, awkward, non-native translations.
- Chinese machine translations use the protected Chinese corpus as style reference before generation/repair.
- Korean and Japanese machine translations are reviewed against native technical essay register, not Chinese or English sentence order.
- Research-dependent translations either record research notes or refuse to write until research is resolved.
- Code, inline code, code fences, MDX, JSX, HTML tags, locked HTML attributes, URLs, paths, imports, exports, math, embeds, and assets are preserved.
- Known corruption `preload="meta数据"` is fixed in writable canonical content and prevented in future.
- Language preference works globally via `siteLang`.
- Blog route switching uses actual siblings only.
- Lists, tags, authors, and RSS show each family once.
- Theme preference persists as `light | dark | system`.
- Build passes.
