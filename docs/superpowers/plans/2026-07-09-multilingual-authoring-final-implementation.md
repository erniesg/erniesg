# Multilingual Authoring Workflow Final Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not rewrite this into another broad plan unless a reviewer identifies a concrete blocker.

**Goal:** Make Ernie's Astro site safely generate, review, repair, and preserve EN, zh, ko, and ja blog translations, with native-level editorial quality and no overwrites of human/final translations.

**Architecture:** Keep the existing post-family shape: `src/content/blog/<slug>/index.mdx` is the source post, and locale sidecars are `en.mdx`, `zh.mdx`, `ko.mdx`, and `ja.mdx` as needed. Add a small ownership schema, a tracked translation manifest, fail-closed audit scripts, a range-based MDX segment/lock/reconstruct layer that patches only approved source offsets, a required research pass, an independent native-style review gate, and then repair machine translations in controlled batches. UI routing and preferences are fixed only after the content ownership layer is safe.

**Tech Stack:** Astro 5 content collections, MDX, React controls, Node ESM scripts, `gray-matter`, `fast-glob`, `unified`/`remark` where needed, Vitest 2.1.9, `astro check`, `astro build`.

---

## Why Previous Attempts Kept Failing

The June multilingual rollout made routes and builds work, then generated 81 sidecars. That validated presence, frontmatter, route output, and build success. It did not validate native translation quality.

The later Codex threads repeatedly produced new "full plans" instead of landing a first safety invariant. This final plan fixes that by making the first executable slice small: classify ownership, protect human Chinese, and add an audit that fails on known bad machine-translation residue.

Best ideas consolidated from prior Codex threads:

- Use `AGENTS.md` for repo-local behavior, but scripts for enforcement.
- Use minimal human-facing frontmatter for ownership; keep LLM/model/provider provenance in `.translation/manifest.json`.
- Never hand whole MDX files to the model as loose text; segment the document, lock machine-readable regions, translate only approved human-facing units, reconstruct by applying translations to exact source ranges instead of stringifying a whole AST, then verify locked regions byte-for-byte.
- Treat the four legacy `*-zh/index.mdx` posts as authoritative human Chinese.
- Treat canonical sidecars derived from those legacy posts as protected until `reconcile-legacy` restores and marks them `final/imported-legacy`.
- Build a Chinese style corpus from Ernie's human Chinese before any Chinese repair or generation; use explicit Korean/Japanese style guides and reviewer notes for those locales.
- Require a research pass for technical terms, names, publications, idioms, cultural references, and place names; if research-capable tooling is unavailable and the model is uncertain, stop with a report instead of guessing.
- Use actual sibling maps for language routes; never synthesize fake localized URLs.
- Fix `system` theme persistence separately from translation generation.

Do not start by repairing all translations. First make it impossible for automation to overwrite protected content or pass obvious direct-translation defects.

---

## Current Repo Facts To Verify Before Implementation

Run:

```bash
pwd
git status --short
find src/content/blog -mindepth 2 -maxdepth 2 \( -name 'zh.mdx' -o -name 'ko.mdx' -o -name 'ja.mdx' \) | wc -l
rg --files-without-match '^translationStatus:' src/content/blog/*/{zh,ko,ja}.mdx | wc -l
rg --files-without-match '^translationSource:' src/content/blog/*/{zh,ko,ja}.mdx | wc -l
npm test -- src/lib/i18n.test.ts
npm run build
```

Expected:

```text
cwd: /Users/erniesg/code/erniesg/erniesg
sidecars: 81
sidecars missing translationStatus: 81
sidecars missing translationSource: 81
i18n tests: pass
build: pass, with existing Header define:vars hints and KaTeX/Browserslist warnings allowed
```

Protected legacy Chinese folders:

```text
src/content/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content-zh/**
src/content/blog/sight-before-sound-seeing-and-searching-with-machines-zh/**
src/content/blog/sound-before-symbols-on-human-creativity-and-intelligence-zh/**
src/content/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human-zh/**
```

Canonical sidecars derived from those protected posts:

```text
src/content/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content/zh.mdx
src/content/blog/sight-before-sound-seeing-and-searching-with-machines/zh.mdx
src/content/blog/sound-before-symbols-on-human-creativity-and-intelligence/zh.mdx
src/content/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human/zh.mdx
```

Known bad machine-translation residue that must fail checks:

```text
preload="meta数据"
数据set
数据源s
データset
データソースs
데이터 소스s
English verbs such as ingest/chunk/query/validate used as ordinary zh/ko/ja prose outside code, quotes, or approved glossary entries
```

---

## Data Model

Modify `src/content.config.ts`:

```ts
translationStatus: z.enum(['machine', 'edited', 'final']).optional(),
translationSource: z.enum(['codex', 'human', 'imported-legacy']).optional(),
```

Meaning:

- Source `index.mdx`: may omit `lang`; omission means `en`.
- Non-English source `index.mdx`: must set `lang`.
- Sidecars: must eventually include `lang`, `translationKey`, `translationStatus`, and `translationSource`.
- `machine`: automation may repair/update only if manifest hashes still match.
- `edited`: human touched it; automation warns only.
- `final`: human approved or wrote it; automation warns only.
- `translationSource: imported-legacy`: copied from protected Chinese; treat as final.
- Missing ownership metadata: protected except during explicit `translate:classify`.
- Machine translations are never considered publishable unless they have a passing mechanical audit, a passing native-review report, no unresolved research questions, and manifest hashes matching the current source/target files.

Manifest `.translation/manifest.json`:

```json
{
  "version": 1,
  "promptVersion": "2026-07-09",
  "families": {}
}
```

Manifest target records should include:

```json
{
  "path": "src/content/blog/my-post/zh.mdx",
  "status": "machine",
  "sourcePath": "src/content/blog/my-post/index.mdx",
  "sourceLocale": "en",
  "targetLocale": "zh",
  "sourceSha256": "sha256-of-source-at-generation",
  "targetSha256": "sha256-of-target-at-generation",
  "lockedRegionSha256": "sha256-of-locked-source-regions",
  "provider": "openai",
  "model": "gpt-5",
  "reviewProvider": "openai",
  "reviewerModel": "gpt-5",
  "researchProvider": "openai",
  "promptVersion": "2026-07-09",
  "styleGuideVersion": "zh-2026-07-09",
  "styleGuideSha256": "sha256-of-style-guide-and-corpus",
  "rubricSha256": "sha256-of-rubric-and-glossary",
  "generatedAt": "2026-07-09T00:00:00+08:00",
  "classifiedAt": null,
  "qualityStatus": "passed",
  "reviewScore": 0.91,
  "researchNotes": [],
  "unresolvedResearch": [],
  "qualityReportPath": ".translation/reports/my-post.zh.quality.json"
}
```

Never store secrets or full prompts in the manifest.

Hash contract:

- `sourceSha256` and `targetSha256` are SHA-256 hashes of the exact raw UTF-8 file bytes as read from disk after the source or target write. Do not normalize frontmatter, line endings, whitespace, MDX syntax, or parser output before hashing.
- `lockedRegionSha256` is a SHA-256 hash of a deterministic JSON array of locked regions in source order. Each item includes `kind`, `start`, `end`, and the exact raw text slice. If parser offsets are unavailable for a region, treat the file as unsafe for automated translation and stop.
- Hash drift always blocks writes for existing `machine` targets until a human runs `translate:mark-edited`, `translate:finalize`, or a future explicit accept-machine command.
- `translate:classify` must create manifest records for the 77 existing generated sidecars before any later write command can touch them. Those records must include `path`, `status`, `sourcePath`, `sourceLocale`, `targetLocale`, `sourceSha256`, `targetSha256`, `provider`, `model`, `promptVersion`, `classifiedAt`, `qualityStatus: "unreviewed"`, `reviewScore: null`, `researchNotes: []`, and `unresolvedResearch: ["classified-existing-machine-translation-needs-review"]`.
- `lockedRegionSha256`, `styleGuideSha256`, `rubricSha256`, and `qualityReportPath` may be absent immediately after classification because the segmenter and quality gate are added later. `translate:check` and any generation/repair command must backfill them before a machine target can be considered publishable.
- Initial classification proves ownership only. It does not certify quality. `content:publish` must fail any classified machine target that is still `qualityStatus: "unreviewed"` or has unresolved research.

Provider contract:

- Use the official `openai` Node package for OpenAI calls and the Responses API as the default OpenAI interface.
- Translation and review calls use structured JSON outputs. Translation output is a JSON object keyed by segment id; review output follows the reviewer schema in Task 6.
- Research-capable OpenAI calls use Responses API tools with web search enabled when the configured model/tool combination supports it. Include returned source annotations or source URLs in `.translation/reports/*.quality.json`; do not copy long source text into reports.
- Required environment: `OPENAI_API_KEY`. Optional environment overrides: `OPENAI_TRANSLATION_MODEL`, `OPENAI_REVIEW_MODEL`, `OPENAI_RESEARCH_MODEL`, and `OPENAI_BASE_URL` for compatible local/proxy endpoints. Scripts must fail with a clear error before model calls when required credentials or configured capabilities are missing.
- Do not assume every configured model can do research. `.translation/config.json` must declare provider capabilities; if `supportsWebResearch` is false and `extractResearchCandidates()` finds ambiguous candidates, the command writes unresolved research and stops without writing content.
- Before implementing the provider module, verify current OpenAI SDK/Responses API syntax against the installed SDK and official OpenAI docs. Keep API-specific code isolated in `providers.mjs` so the rest of the translation pipeline remains provider-agnostic.

Quality report cache contract:

- `translate:check` may reuse an existing `.translation/reports/<slug>.<locale>.quality.json` only when `sourceSha256`, `targetSha256`, `promptVersion`, `styleGuideSha256`, `rubricSha256`, `reviewProvider`, `reviewerModel`, and `reviewProfile` all match the current manifest/config.
- If the cache is valid, `translate:check` still reruns deterministic mechanical audit and locked-region checks, but it may skip paid model review.
- `--refresh-review` forces all reviewer passes to rerun and rewrites the report/manifest.
- Cached report reuse must be visible in command output so publish checks are auditable.

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
src/lib/site-preferences.ts
.translation/config.json
.translation/manifest.json
.translation/reports/.gitkeep
.translation/style-corpus/.gitkeep
tools/translation/content.mjs
tools/translation/audit.mjs
tools/translation/classify.mjs
tools/translation/reconcile-legacy.mjs
tools/translation/style-corpus.mjs
tools/translation/research.mjs
tools/translation/check-quality.mjs
tools/translation/segments.mjs
tools/translation/locked-regions.mjs
tools/translation/prompts.mjs
tools/translation/providers.mjs
tools/translation/generate.mjs
tools/translation/sync.mjs
tools/translation/repair.mjs
tools/translation/mark-edited.mjs
tools/translation/finalize.mjs
tools/translation/*.test.mjs
```

## Files To Modify

```text
package.json
package-lock.json
.gitignore
src/content.config.ts
src/lib/i18n.ts
src/lib/i18n.test.ts
src/lib/use-site-locale.ts
src/layouts/Layout.astro
src/pages/blog/[...id].astro
src/pages/blog/[...page].astro
src/pages/index.astro
src/pages/tags/index.astro
src/pages/tags/[...id].astro
src/pages/authors/[...id].astro
src/pages/rss.xml.ts
src/components/BlogCard.astro
src/components/PostNavigation.astro
src/components/Header.astro
src/components/ui/language-toggle.tsx
src/components/ui/mode-toggle.tsx
src/components/Head.astro
```

---

## Task 1: Add Repo Translation Policy

**Files:**
- Create: `AGENTS.md`
- Create: `docs/translation/style/en.md`
- Create: `docs/translation/style/zh.md`
- Create: `docs/translation/style/ko.md`
- Create: `docs/translation/style/ja.md`
- Create: `docs/translation/style/rubric.md`
- Create: `docs/translation/glossary.json`

- [ ] **Step 1: Create `AGENTS.md`**

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
- Treat manifest target-hash drift as protected.
- For Chinese, study the protected legacy Chinese posts as house style before translating or repairing zh.
- For Korean and Japanese, use natural native tech-essay register, not English sentence order with localized words.
- Research technical terms, names, publications, idioms, cultural references, and place names when uncertain.
- Before generating or repairing Chinese, inspect the protected legacy Chinese posts or the derived style corpus for voice, cadence, and terminology.
- For Korean and Japanese, do not use Chinese-shaped phrasing or English sentence order with localized nouns; require native technical-essay phrasing.
- Reject direct translation smell. Examples that must be repaired in machine translations include `数据set`, `数据源s`, `meta数据`, `データset`, `データソースs`, and English verbs like `ingest`, `chunk`, `query`, or `validate` used as ordinary zh/ko/ja prose outside code or quotes.
- If research is needed and no research-capable tool/provider is configured, stop with a report instead of guessing.
- If unsure whether a translation is human-written, stop and ask.
```

- [ ] **Step 2: Create style guides**

`docs/translation/style/zh.md`:

```md
# Chinese Translation Style

Use the four protected legacy `*-zh` posts as the house-style reference. Aim for natural Mandarin essay cadence. Avoid stiff English-shaped Mandarin, awkward word-for-word transitions, and unnecessary translation of product names or code-adjacent terms.

Keep Ernie's technical-personal voice. When source prose is blunt or playful, preserve that energy instead of smoothing it into generic formal Chinese.

Preserve intentional code-switching, but repair accidental half-translations such as `数据set`, `数据源s`, `meta数据`, `ingest 更多`, `chunk 到`, or English verbs used as ordinary Chinese prose.
```

`docs/translation/style/ko.md`:

```md
# Korean Translation Style

Write like a native Korean technical essayist. Avoid literal English syntax and avoid Chinese-shaped phrasing. Preserve technical precision, personal voice, and rhythm. Product names, code terms, URLs, and identifiers remain unchanged unless the source uses a known Korean-facing name.

Reject hybrid machine residue such as `데이터 소스s`, `데이터set`, `items를 chunk`, `ingest할`, or `validate하게` unless the phrase is inside code, quoted source text, or an approved glossary entry.
```

`docs/translation/style/ja.md`:

```md
# Japanese Translation Style

Write like a native Japanese technical essayist. Avoid literal English syntax. Preserve argument structure, humor, and personal tone while making the prose read naturally in Japanese. Product names, code terms, URLs, and identifiers remain unchanged unless a standard Japanese-facing name is clearly established.

Reject hybrid machine residue such as `データset`, `データソースs`, `本番環境ise`, `ingest する`, or English verbs used as ordinary Japanese prose unless the phrase is inside code, quoted source text, or an approved glossary entry.
```

`docs/translation/style/en.md`:

```md
# English Translation Style

When translating into English from a non-English source, preserve Ernie's direct technical-personal essay voice. Do not flatten the writing into corporate prose. Keep source-specific cultural references unless a short clarification is needed for English readers.
```

`docs/translation/style/rubric.md`:

```md
# Translation Quality Rubric

Reject a translation when it:

- reads like sentence-by-sentence translation from the source
- preserves English word order in Chinese, Korean, or Japanese
- leaves ordinary prose as half-translated technical residue, such as `数据set`, `数据源s`, `データset`, `データソースs`, `데이터 소스s`, or English verbs like `ingest`, `chunk`, `query`, `validate` used as untranslated verbs
- over-translates code, product names, URLs, paths, identifiers, fixed HTML values, math, or quoted source text
- removes Ernie's bluntness, humor, uncertainty, or code-switching
- adds claims not present in the source
- weakens titles or descriptions into generic SEO text
- uses culturally wrong terminology for names, places, publications, idioms, or technical concepts

For Chinese, compare against the protected legacy Chinese posts before approving. For Korean and Japanese, require native technical essay register and reviewer notes explaining why the prose passes. Any reviewer pass must include one short explanation of why the output is not a direct translation.
```

- [ ] **Step 3: Create glossary**

`docs/translation/glossary.json`:

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

Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/translation
git commit -m "docs: add multilingual translation policy"
```

---

## Task 2: Add Minimal Translation Tooling Skeleton And Ownership Schema

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Modify: `src/content.config.ts`
- Create: `.translation/config.json`
- Create: `.translation/manifest.json`
- Create: `.translation/reports/.gitkeep`
- Create: `.translation/style-corpus/.gitkeep`

- [ ] **Step 1: Install dependencies**

Run:

```bash
npm install --save-dev fast-glob gray-matter unified remark-parse remark-mdx remark-frontmatter unist-util-visit parse5 yaml openai
```

Expected: `package.json` and `package-lock.json` update.

- [ ] **Step 2: Add package scripts**

Add scripts without removing existing scripts:

```json
{
  "translate:audit": "node tools/translation/audit.mjs",
  "translate:classify": "node tools/translation/classify.mjs",
  "translate:reconcile-legacy": "node tools/translation/reconcile-legacy.mjs",
  "translate:style-corpus": "node tools/translation/style-corpus.mjs",
  "translate:research": "node tools/translation/research.mjs",
  "translate:check": "node tools/translation/check-quality.mjs",
  "translate:generate": "node tools/translation/generate.mjs",
  "translate:sync": "node tools/translation/sync.mjs",
  "translate:repair": "node tools/translation/repair.mjs",
  "translate:mark-edited": "node tools/translation/mark-edited.mjs",
  "translate:finalize": "node tools/translation/finalize.mjs",
  "translate:test": "vitest run tools/translation/*.test.mjs",
  "content:check": "npm run translate:audit && npm run translate:check && npm test -- src/lib/i18n.test.ts && npm run build",
  "content:publish": "npm run translate:sync -- --all && npm run content:check"
}
```

- [ ] **Step 3: Extend content schema**

In `src/content.config.ts`, add:

```ts
translationStatus: z.enum(['machine', 'edited', 'final']).optional(),
translationSource: z.enum(['codex', 'human', 'imported-legacy']).optional(),
```

- [ ] **Step 4: Add translation config**

Create `.translation/config.json`:

```json
{
  "supportedLocales": ["en", "zh", "ko", "ja"],
  "defaultLocale": "en",
  "providers": {
    "default": { "provider": "openai", "api": "responses", "model": "gpt-5" },
    "translate": {
      "en": { "provider": "openai", "api": "responses", "model": "gpt-5" },
      "zh": { "provider": "openai", "api": "responses", "model": "gpt-5" },
      "ko": { "provider": "openai", "api": "responses", "model": "gpt-5" },
      "ja": { "provider": "openai", "api": "responses", "model": "gpt-5" }
    },
    "review": {
      "pass1": {
        "en": { "provider": "openai", "api": "responses", "model": "gpt-5", "profile": "native-editor-reviewer" },
        "zh": { "provider": "openai", "api": "responses", "model": "gpt-5", "profile": "native-editor-reviewer" },
        "ko": { "provider": "openai", "api": "responses", "model": "gpt-5", "profile": "native-editor-reviewer" },
        "ja": { "provider": "openai", "api": "responses", "model": "gpt-5", "profile": "native-editor-reviewer" }
      },
      "pass2": {
        "en": { "provider": "openai", "api": "responses", "model": "gpt-5", "profile": "adversarial-direct-translation-reviewer" },
        "zh": { "provider": "openai", "api": "responses", "model": "gpt-5", "profile": "adversarial-direct-translation-reviewer" },
        "ko": { "provider": "openai", "api": "responses", "model": "gpt-5", "profile": "adversarial-direct-translation-reviewer" },
        "ja": { "provider": "openai", "api": "responses", "model": "gpt-5", "profile": "adversarial-direct-translation-reviewer" }
      }
    },
    "research": {
      "en": { "provider": "openai", "api": "responses", "model": "gpt-5", "tools": ["web_search"] },
      "zh": { "provider": "openai", "api": "responses", "model": "gpt-5", "tools": ["web_search"] },
      "ko": { "provider": "openai", "api": "responses", "model": "gpt-5", "tools": ["web_search"] },
      "ja": { "provider": "openai", "api": "responses", "model": "gpt-5", "tools": ["web_search"] }
    }
  },
  "providerCapabilities": {
    "openai": {
      "requiresEnv": ["OPENAI_API_KEY"],
      "supportsStructuredJson": true,
      "supportsWebResearch": true,
      "supportsSourceAnnotations": true
    }
  },
  "reviewCache": {
    "enabled": true,
    "reuseWhenHashesMatch": true,
    "forceFlag": "--refresh-review"
  },
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
  "requiredPublishLocales": ["en", "zh", "ko", "ja"],
  "failPublishOnMissingRequiredLocales": true,
  "promptVersion": "2026-07-09",
  "minReviewScore": 0.88,
  "requiredReviewerPasses": 2,
  "reviewPolicy": {
    "mustUseFreshContext": true,
    "forbidTranslatorSelfReview": true,
    "preferDifferentModelOrProviderWhenAvailable": true,
    "allowSameBaseModelOnlyWithDistinctReviewerProfiles": true
  }
}
```

Create `.translation/manifest.json`:

```json
{
  "version": 1,
  "promptVersion": "2026-07-09",
  "families": {}
}
```

- [ ] **Step 5: Add ignores**

Append to `.gitignore`:

```gitignore
.translation/cache/
.translation/reports/*.tmp.json
```

- [ ] **Step 6: Validate**

Run:

```bash
npm run build
node -e "const pkg=require('./package.json'); for (const s of ['translate:audit','translate:classify','translate:research','translate:repair','translate:mark-edited','content:check','content:publish']) if (!pkg.scripts[s]) throw new Error('missing '+s)"
```

Expected: build passes; node command has no output.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore src/content.config.ts .translation
git commit -m "feat: add translation ownership scaffold"
```

---

## Task 3: Add Fail-Closed Inventory, Audit, And Classification

**Files:**
- Create: `tools/translation/content.mjs`
- Create: `tools/translation/audit.mjs`
- Create: `tools/translation/classify.mjs`
- Create: `tools/translation/content.test.mjs`
- Create: `tools/translation/audit.test.mjs`

- [ ] **Step 1: Implement inventory helpers**

`tools/translation/content.mjs` must implement this API contract:

```js
export const SUPPORTED_LOCALES = ['en', 'zh', 'ko', 'ja']
export const BLOG_ROOT = 'src/content/blog'
// sha256(text: string): string
// isProtectedLegacyPath(filePath: string): boolean
// isProtectedHumanTranslationPath(filePath: string): boolean
// isSourceEntry(filePath: string): boolean
// getSidecarLocale(filePath: string): SupportedLocale | null
// getFamilySlug(filePath: string): string | null
// readMdx(filePath: string): { raw: string, frontmatter: Record<string, unknown>, body: string }
// canWriteExistingTarget(args): boolean
// listFamilies(): Promise<BlogFamily[]>
// writeMdxAtomic(filePath: string, text: string): Promise<void>
```

Required behavior:

- Protected legacy paths and protected canonical human sidecars are loaded from `.translation/config.json`.
- `isSourceEntry()` is true only for `src/content/blog/<slug>/index.mdx` when `<slug>` does not end with `-zh`.
- Missing targets may be created only by generate/sync when the path does not exist and the target path is not protected.
- Existing targets may be written only when `translationStatus === 'machine'`, the path is not protected, and the current hash matches the manifest target hash.
- Missing `translationStatus`, `edited`, and `final` all block writes.

- [ ] **Step 2: Add tests for write safety**

`tools/translation/content.test.mjs`:

```js
import { describe, expect, it } from 'vitest'
import { canWriteExistingTarget, sha256 } from './content.mjs'

describe('translation write safety', () => {
  it('blocks missing ownership metadata', () => {
    expect(canWriteExistingTarget({ filePath: 'src/content/blog/x/zh.mdx', frontmatter: {}, manifestTarget: null, currentText: 'x' })).toBe(false)
  })

  it('blocks edited and final targets', () => {
    expect(canWriteExistingTarget({ filePath: 'src/content/blog/x/zh.mdx', frontmatter: { translationStatus: 'edited' }, manifestTarget: null, currentText: 'x' })).toBe(false)
    expect(canWriteExistingTarget({ filePath: 'src/content/blog/x/zh.mdx', frontmatter: { translationStatus: 'final' }, manifestTarget: null, currentText: 'x' })).toBe(false)
  })

  it('blocks hash drift for machine targets', () => {
    expect(canWriteExistingTarget({
      filePath: 'src/content/blog/x/zh.mdx',
      frontmatter: { translationStatus: 'machine' },
      manifestTarget: { targetSha256: sha256('old') },
      currentText: 'human changed'
    })).toBe(false)
  })

  it('allows matching machine hash', () => {
    expect(canWriteExistingTarget({
      filePath: 'src/content/blog/x/zh.mdx',
      frontmatter: { translationStatus: 'machine' },
      manifestTarget: { targetSha256: sha256('old') },
      currentText: 'old'
    })).toBe(true)
  })
})
```

- [ ] **Step 3: Implement audit**

`tools/translation/audit.mjs` must fail on:

- planned write to protected `*-zh`
- sidecar missing `lang`, `translationKey`, `translationStatus`, or `translationSource`
- sidecar `translationKey` not equal to folder slug
- sidecar filename not matching `lang`
- legacy-derived canonical Chinese sidecar not marked `translationStatus: final` and `translationSource: imported-legacy`
- fixed HTML vocabulary corruption, including `preload="meta数据"`
- direct-translation residue in machine or unclassified sidecars: `数据set`, `数据源s`, `meta数据`, `データset`, `データソースs`, `데이터 소스s`
- English verbs or plural suffix residue used as ordinary zh/ko/ja prose outside code fences, inline code, blockquotes marked as source quotation, URLs, or glossary-approved terms, including `ingest`, `chunk`, `query`, `validate`, `items`, `schemas`, `tests`, and trailing `s` attached to localized nouns

Audit must be segment-aware. It must ignore code fences, inline code, URLs, and explicitly quoted source examples, but fail when those same words appear in normal translated prose.

It may warn, not fail, on stale `edited` or `final` targets after source changes.

- [ ] **Step 4: Add audit tests**

`tools/translation/audit.test.mjs`:

```js
import { describe, expect, it } from 'vitest'
import { auditMdxText } from './audit.mjs'

describe('translation audit', () => {
  it('fails corrupted fixed HTML vocabulary', () => {
    const mdx = '<audio controls="true" preload="meta数据" src="./file.mp3"></audio>'
    const result = auditMdxText(mdx, { path: 'src/content/blog/x/zh.mdx', locale: 'zh' })
    expect(result.errors.some((error) => error.includes('preload'))).toBe(true)
  })

  it('fails direct translation residue', () => {
    const mdx = '这就是我如何把 items chunk 到 数据set 里，并 ingest 更多 数据源s。'
    const result = auditMdxText(mdx, { path: 'src/content/blog/x/zh.mdx', locale: 'zh' })
    expect(result.errors.some((error) => error.includes('direct translation'))).toBe(true)
  })

  it('fails Korean and Japanese hybrid machine residue outside code', () => {
    const ko = auditMdxText('더 많은 데이터 소스s를 ingest할 필요가 있다.', { path: 'src/content/blog/x/ko.mdx', locale: 'ko' })
    const ja = auditMdxText('もっと多くの データソースs を ingest する必要がある。', { path: 'src/content/blog/x/ja.mdx', locale: 'ja' })
    expect(ko.errors.some((error) => error.includes('direct translation'))).toBe(true)
    expect(ja.errors.some((error) => error.includes('direct translation'))).toBe(true)
  })

  it('allows the same technical words inside code fences', () => {
    const mdx = '```py\nfor chunk in chunks:\n    ingest(chunk)\n```'
    const result = auditMdxText(mdx, { path: 'src/content/blog/x/zh.mdx', locale: 'zh' })
    expect(result.errors).toEqual([])
  })
})
```

- [ ] **Step 5: Implement classification**

`tools/translation/classify.mjs` behavior:

- `--dry-run`: print proposed changes, no writes.
- `--apply`: add sidecar metadata only; never change body text.
- Known protected canonical Chinese sidecars remain protected until legacy reconciliation.
- Current non-protected sidecars are classified as:

```yaml
translationStatus: "machine"
translationSource: "codex"
```

- For every classified machine target, create or update the corresponding `.translation/manifest.json` record in the same run.
- Classification manifest records must include current raw-byte `sourceSha256` and `targetSha256`; without these hashes, later safe-write checks cannot distinguish machine-owned text from human edits.
- Set `generatedAt: null`, `classifiedAt` to the current ISO timestamp, `qualityStatus: "unreviewed"`, `reviewScore: null`, `researchNotes: []`, and `unresolvedResearch: ["classified-existing-machine-translation-needs-review"]`.
- Do not set `lockedRegionSha256` during classification unless `listLockedRegions()` already exists and can prove offsets. Task 5/6 backfills this before publishability.
- If the source post for a sidecar cannot be resolved, do not classify that sidecar; leave it protected and report it.
- Unknowns remain unclassified and protected.

- [ ] **Step 6: Validate**

Run:

```bash
npm run translate:test
npm run translate:audit
npm run translate:classify -- --dry-run
```

Expected before classification:

```text
translate:test passes
translate:audit fails because 81 sidecars lack translationStatus/translationSource
classify dry-run proposes 77 generated-machine updates and 4 protected human sidecars
classify dry-run proposes 77 manifest target records with source/target hashes and qualityStatus=unreviewed
```

- [ ] **Step 7: Commit scripts before applying classification**

```bash
git add tools/translation
git commit -m "feat: add translation audit and classification"
```

- [ ] **Step 8: Apply classification**

Run:

```bash
npm run translate:classify -- --apply
npm run translate:audit
```

Expected:

- Metadata is added to 77 generated sidecars.
- `.translation/manifest.json` has 77 matching machine target records with current `sourceSha256` and `targetSha256`.
- Four protected human sidecars are not machine-owned.
- Audit still reports legacy reconciliation is required.
- Existing classified machine translations remain not publishable until repair/check clears `qualityStatus` and unresolved research.

- [ ] **Step 9: Commit classified metadata**

```bash
git add src/content/blog .translation/manifest.json
git commit -m "feat: classify existing machine translations"
```

---

## Task 4: Reconcile Protected Legacy Chinese

The protected legacy `*-zh/index.mdx` files are the source of truth. Reconciliation does not imply a human changed them; it exists because the canonical `src/content/blog/<slug>/zh.mdx` sidecars can diverge from the protected copies through migration, script, or machine-translation damage.

**Files:**
- Create: `tools/translation/reconcile-legacy.mjs`
- Modify: the four canonical protected `zh.mdx` sidecars only
- Modify: `.translation/manifest.json`

- [ ] **Step 1: Implement legacy reconciliation**

Behavior:

- Pair each protected `*-zh/index.mdx` with its canonical sidecar.
- `--dry-run`: report body/frontmatter differences, fixed-vocabulary corruption, and relative asset references that would be copied.
- Before `--apply`, verify every relative image/audio/video/iframe source referenced by the protected legacy MDX exists in the canonical family folder, or can be copied from the protected legacy folder without overwriting a different existing asset.
- If a required asset is missing in both places, fail before writing any MDX.
- `--apply`: copy protected body into the canonical sidecar and preserve only these human frontmatter fields from the protected legacy file when present: `title`, `description`, `date`, `authors`, `tags`, `image`, and `draft`.
- Preserve legacy `tags` exactly instead of silently inheriting source-post tags. These four files are migrated human Chinese posts; changing their tag semantics belongs in a separate explicit UX/content decision, not in safety reconciliation.
- Preserve source/canonical sidecar fields only when they are required for the new multilingual data model or when the legacy file lacks the corresponding field.
- After the human frontmatter fields, add or overwrite:

```yaml
lang: "zh"
translationKey: "<slug>"
translationStatus: "final"
translationSource: "imported-legacy"
```

- Never write protected `*-zh` folders.
- Update the manifest record for each canonical sidecar with `status: "final"`, `source: "imported-legacy"`, current `targetSha256`, `qualityStatus: "human-final"`, empty unresolved research, and no model/provider claim. Do not create a fake translation model provenance entry for imported legacy text.

- [ ] **Step 2: Validate dry run**

Run:

```bash
npm run translate:reconcile-legacy -- --dry-run
```

Expected:

```text
legacy pairs checked: 4
protected legacy writes: 0
canonical sidecars checked for divergence: 4
canonical sidecars requiring update: 3 or 4 depending on current branch state
asset references verified before apply
known corruption includes preload="meta数据" vs preload="metadata"
```

- [ ] **Step 3: Apply and validate**

Run:

```bash
npm run translate:reconcile-legacy -- --apply
rg -n 'preload="meta数据"' src/content/blog/*/zh.mdx
npm run translate:reconcile-legacy -- --dry-run
npm run translate:audit
npm run build
```

Expected:

- `rg` returns no canonical sidecar matches.
- Reconciliation dry run after apply reports no remaining body/frontmatter divergence and no missing assets.
- Protected `*-zh` folders unchanged.
- Four canonical sidecars are marked `final/imported-legacy`.
- Build passes.

- [ ] **Step 4: Commit**

```bash
git add tools/translation/reconcile-legacy.mjs \
  src/content/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content/zh.mdx \
  src/content/blog/sight-before-sound-seeing-and-searching-with-machines/zh.mdx \
  src/content/blog/sound-before-symbols-on-human-creativity-and-intelligence/zh.mdx \
  src/content/blog/symbols-and-the-fabric-of-reality-what-a-i-taught-me-about-the-human/zh.mdx \
  .translation/manifest.json
git commit -m "fix: reconcile legacy Chinese translations"
```

---

## Task 5: Add MDX Segmenter And Locked-Region Guard

**Files:**
- Create: `tools/translation/segments.mjs`
- Create: `tools/translation/locked-regions.mjs`
- Create: `tools/translation/segments.test.mjs`
- Create: `tools/translation/__fixtures__/corrupted-audio.mdx`
- Create: `tools/translation/__fixtures__/locked-code.mdx`
- Create: `tools/translation/__fixtures__/mixed-mdx.mdx`

- [ ] **Step 1: Implement locked-region definitions**

`tools/translation/locked-regions.mjs` implements this API contract:

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

// isLockedAttribute(name: string): boolean
// isTranslatableAttribute(name: string): boolean
// isFixedHtmlVocabulary(name: string, value: string): boolean
```

Fixed vocabulary must include:

```js
const FIXED_VALUES = {
  preload: new Set(['metadata', 'none', 'auto']),
  loading: new Set(['lazy', 'eager']),
  decoding: new Set(['async', 'auto', 'sync']),
  target: new Set(['_blank', '_self', '_parent', '_top']),
}
```

- [ ] **Step 2: Implement MDX segment extraction**

`tools/translation/segments.mjs` implements this API contract:

```js
// extractSegments(mdxText: string, options?: object): TranslationSegment[]
// applySegmentTranslations(mdxText: string, translatedSegments: Record<string, string>, options?: object): string
// listLockedRegions(mdxText: string): LockedRegion[]
// assertLockedRegionsPreserved(sourceMdx: string, targetMdx: string): void
```

Segment shape:

```ts
type TranslationSegment = {
  id: string
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
  start: number
  end: number
  contextBefore?: string
  contextAfter?: string
}
```

`start` and `end` are UTF-16 string offsets into the original `mdxText`, suitable for `mdxText.slice(start, end)`. `extractSegments()` must verify that `mdxText.slice(start, end) === sourceText` for every segment. If a parser cannot provide reliable offsets for a translatable unit, skip that unit and report it; do not fall back to whole-file translation.

`applySegmentTranslations()` must:

- Replace only exact `[start, end)` spans from the original source string.
- Apply replacements from highest start offset to lowest start offset so earlier offsets remain valid.
- Never reserialize the full MDX document through `remark-stringify`, `rehype-stringify`, Prettier, or any AST stringifier.
- Leave all bytes outside approved replacement spans exactly unchanged.
- Throw if a translated segment is missing, if an unknown segment id is supplied, or if the original source slice no longer matches `sourceText`.

Translate only:

- frontmatter `title`
- frontmatter `description`
- markdown headings
- markdown paragraphs
- markdown list item prose
- markdown blockquotes
- link display text, never link URL
- image alt text when content-facing
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
- URLs
- relative paths
- image/audio/video/iframe paths
- math
- locked attributes and fixed vocabulary values such as `preload="metadata"`

- [ ] **Step 3: Add fixtures**

`tools/translation/__fixtures__/corrupted-audio.mdx`:

```mdx
---
title: "Symbols"
description: "Description"
date: 2023-08-05
authors: ["erniesg"]
draft: false
---

<audio controls="true" preload="meta数据" src="./file.mp3" alt="Maybe the half-life of love is remorse." aria-describedby="caption-id"></audio>
```

`tools/translation/__fixtures__/locked-code.mdx`:

````mdx
---
title: "Code Post"
description: "A post with code"
date: 2026-07-09
authors: ["erniesg"]
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

`tools/translation/__fixtures__/mixed-mdx.mdx`:

```mdx
---
title: "A.I. for Humans"
description: "A short description"
date: 2026-07-09
authors: ["erniesg"]
draft: false
---

import Demo from './Demo.astro'

# Translate this heading

<Demo data-id="keep-this" title="Translate this title for readers" />

![Translate image alt](./image.png)
```

- [ ] **Step 4: Add segmenter tests**

`tools/translation/segments.test.mjs`:

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
    const translated = Object.fromEntries(segments.map((segment) => [segment.id, `[zh] ${segment.sourceText}`]))
    const output = applySegmentTranslations(mdx, translated)
    expect(() => assertLockedRegionsPreserved(mdx, output)).not.toThrow()
    expect(output).toContain('```ts')
    expect(output).toContain('const preload = "metadata"')
    expect(output).toContain('https://example.com/path?x=metadata')
  })

  it('patches only approved source ranges and does not stringify the whole document', () => {
    const mdx = [
      '---',
      'title: "Code Post"',
      'description: "A post with code"',
      'date: 2026-07-09',
      'authors: ["erniesg"]',
      '---',
      '',
      'Translate this sentence.',
      '',
      '<audio controls="true" preload="metadata" src="./file.mp3"></audio>',
      '',
    ].join('\n')
    const segments = extractSegments(mdx)
    const sentence = segments.find((segment) => segment.sourceText === 'Translate this sentence.')
    expect(sentence).toBeTruthy()
    const output = applySegmentTranslations(mdx, { [sentence.id]: '翻译这一句。' })
    expect(output).toContain('翻译这一句。')
    expect(output).toContain('<audio controls="true" preload="metadata" src="./file.mp3"></audio>')
    expect(output).not.toContain('Translate this sentence.')
  })
})
```

- [ ] **Step 5: Validate**

Run:

```bash
npm run translate:test
```

Expected: segmenter tests pass.

- [ ] **Step 6: Commit**

```bash
git add tools/translation/segments.mjs tools/translation/locked-regions.mjs tools/translation/segments.test.mjs tools/translation/__fixtures__
git commit -m "feat: segment translatable MDX safely"
```

---

## Task 6: Add Style Corpus, Research Pass, And Quality Gate

**Files:**
- Create: `tools/translation/style-corpus.mjs`
- Create: `tools/translation/research.mjs`
- Create: `tools/translation/research.test.mjs`
- Create: `tools/translation/check-quality.mjs`
- Create: `tools/translation/prompts.mjs`
- Create: `tools/translation/providers.mjs`

- [ ] **Step 1: Implement Chinese style corpus**

`style-corpus.mjs` must:

- Read only protected legacy Chinese posts and canonical `final/imported-legacy` Chinese sidecars.
- Extract short voice notes and source hashes.
- Write `.translation/style-corpus/zh.json`.
- Provide `--check` to verify corpus exists and hashes match.

Expected `zh.json` shape:

```json
{
  "locale": "zh",
  "version": 1,
  "sources": [],
  "voiceNotes": [
    "Uses direct first-person technical reflection without corporate smoothing.",
    "Keeps project names and some AI/product terms in English when they are names or code-adjacent.",
    "Uses natural Mandarin transitions rather than mirroring English clause order."
  ],
  "examples": []
}
```

- [ ] **Step 2: Implement research pass**

`research.mjs` must export:

```js
// extractResearchCandidates({ sourceLocale, targetLocale, segments, glossary }): ResearchCandidate[]
// researchTranslationTerms({ sourceLocale, targetLocale, segments, glossary, styleGuide, dryRun }): Promise<ResearchReport>
// hasUnresolvedResearch(researchReport: ResearchReport): boolean
```

Required behavior:

- Candidate extraction is deterministic and includes proper nouns, publication names, place names, idioms, product names, ambiguous technical terms, and culturally loaded references.
- It ignores code fences, inline code, URLs, file paths, imports, exports, and locked HTML/JSX attributes.
- Dry run returns stable fixture-like notes without network or model calls.
- Real mode uses only configured providers and env credentials; it never logs secrets.
- If the provider lacks research capability and candidates remain ambiguous, return `unresolvedResearch` instead of guessing.
- For OpenAI, real mode uses the official `openai` package and `client.responses.create()`.
- OpenAI research requests include the configured web-search tool only when `.translation/config.json` says the provider supports web research. If web search is unavailable, the report must say which candidates remained unresolved.
- Research output must be structured JSON. Include concise `researchNotes` and source URLs/annotations returned by the tool; do not store full copied source pages.
- The report shape is:

```json
{
  "sourceLocale": "en",
  "targetLocale": "zh",
  "candidates": [
    { "text": "TextFX", "kind": "product", "decision": "preserve", "note": "Product name in quoted/generated examples." }
  ],
  "researchNotes": [
    "Preserve TextFX as a product/tool name."
  ],
  "sources": [
    { "url": "https://example.com/source", "title": "Short source title", "note": "Why it was used." }
  ],
  "unresolvedResearch": []
}
```

`research.test.mjs` must assert that `extractResearchCandidates()` finds `TextFX`, `Fu Gai Mountain`, `Bilibili`, and `MITx DEDP` in prose, and ignores `TextFX` inside code fences or URLs.

- [ ] **Step 3: Implement prompt builders**

`prompts.mjs` exports:

```js
// buildTranslatorPrompt(args): { instructions: string, input: object, responseSchema: object }
// buildReviewerPrompt(args): { instructions: string, input: object, responseSchema: object }
```

Translator prompt must include:

```text
You are a native-level bilingual literary and technical editor translating Ernie's personal technical essays.

Do not translate sentence by sentence. Produce a native editorial adaptation that preserves meaning, voice, rhythm, humor, and intent.

Translate only provided translatable prose. Do not alter locked regions, code, URLs, paths, identifiers, HTML/JSX syntax, frontmatter keys, fixed HTML vocabulary, imports, exports, or math.

Research names, publications, cultural references, technical terms, idioms, places, and product names when uncertain. Record concise research notes.

Reject direct translation smell. The result must read like native prose in the target language.
```

- [ ] **Step 4: Implement provider abstraction**

`providers.mjs` exports:

```js
// translateSegments(args): Promise<Record<string, string>>
// reviewTranslation(args): Promise<ReviewReport>
```

Required:

- Dry run is deterministic.
- Real mode reads credentials only from env.
- OpenAI real mode must instantiate the SDK as `new OpenAI()` and call `client.responses.create()` through a single local adapter function. Do not scatter raw API calls through generation, research, or review modules.
- Translation/review requests must use structured JSON output. If the provider returns non-JSON, invalid JSON, missing segment ids, extra segment ids, or generic reviewer rationale, the command fails without writing content.
- Research-capable requests must pass the configured web-search tool and request source annotations when supported.
- Use `store: false` by default unless a future config explicitly opts into provider-side response storage.
- No secret logging.
- Translation and review must be separate calls with fresh contexts. A reviewer must never receive the translator's hidden reasoning, prompt state, or a request to justify its own output.
- Prefer a different capable model or provider for review when configured. If only one base model/provider is configured, still run both configured reviewer profiles in fresh contexts and require both to pass.
- Each reviewer pass must be adversarial: it should try to reject direct translation smell, unnatural target-language register, over-translated code-adjacent terms, source drift, and missing research.
- Reviewer returns structured JSON:

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
  "researchNotes": [],
  "unresolvedResearch": [],
  "nativeRegisterRationale": "Reads as natural target-language technical essay prose rather than source-language syntax with localized words."
}
```

- [ ] **Step 5: Implement quality checker**

`check-quality.mjs` must:

- Run mechanical audit checks.
- Run `extractSegments()` and `assertLockedRegionsPreserved()` when comparing source/target.
- For `machine` targets, run all configured reviewer passes unless `--mechanical-only`.
- Fail if any reviewer says direct translation smell, native register risk, voice loss risk, locked region risk, or unresolved research.
- Fail if any review score is below `.translation/config.json` `minReviewScore`.
- Fail if any reviewer verdict is pass but `nativeRegisterRationale` is missing or generic.
- Fail if reviewer passes are not fresh independent calls, or if both review profiles collapse to identical generic rationale.
- Fail if manifest `unresolvedResearch` is non-empty.
- Compute `styleGuideSha256` from the target style guide plus target style corpus, and `rubricSha256` from `docs/translation/style/rubric.md` plus `docs/translation/glossary.json`.
- Before paid reviewer calls, check for a reusable `.translation/reports/<slug>.<locale>.quality.json`. Reuse only when `sourceSha256`, `targetSha256`, `promptVersion`, `styleGuideSha256`, `rubricSha256`, reviewer provider/model/profile, and report schema version all match.
- `--refresh-review` bypasses the cache and reruns all reviewer passes.
- Write `.translation/reports/<slug>.<locale>.quality.json` with schema version, cache key inputs, mechanical issues, reviewer-pass issues, per-pass scores, research notes/sources, unresolved research, native-register rationale, and whether the report was freshly generated or reused.
- Update the manifest with `qualityStatus: "passed"` only after deterministic checks and reviewer checks pass; otherwise keep or set `qualityStatus: "failed"` with the report path.

- [ ] **Step 6: Validate**

Run:

```bash
npm run translate:style-corpus -- --locale zh --dry-run
npm run translate:style-corpus -- --locale zh
npm run translate:style-corpus -- --locale zh --check
npm run translate:research -- --slug raggaeton-scaling-a-i-augmented-writing-for-any-content --locale zh --dry-run
npx vitest run tools/translation/research.test.mjs
npm run translate:check -- --mechanical-only
```

Expected:

- Style corpus writes and checks.
- Research dry run records candidate terms and no unresolved research for fixture-safe examples.
- Research tests pass.
- Mechanical check fails only on remaining machine direct-translation residue, not on protected final Chinese.
- Any model-backed `translate:check` writes cacheable quality reports keyed by source/target/config hashes; rerunning without changes reports cache reuse, while `--refresh-review` reruns reviewers.

- [ ] **Step 7: Commit**

```bash
git add .translation/style-corpus tools/translation/style-corpus.mjs tools/translation/research.mjs tools/translation/research.test.mjs tools/translation/check-quality.mjs tools/translation/prompts.mjs tools/translation/providers.mjs
git commit -m "feat: add native translation quality gate"
```

---

## Task 7: Add Generation, Sync, Repair, And Human Review Commands

**Files:**
- Create: `tools/translation/generate.mjs`
- Create: `tools/translation/sync.mjs`
- Create: `tools/translation/repair.mjs`
- Create: `tools/translation/mark-edited.mjs`
- Create: `tools/translation/finalize.mjs`

- [ ] **Step 1: Implement `generate.mjs`**

Behavior:

- Accept `--slug <slug>`.
- Accept `--targets zh,ko,ja,en`.
- Accept `--source <locale>` for non-English source posts.
- Dry run prints planned writes.
- Creates missing sidecars only.
- Refuses to overwrite existing sidecars.
- Runs style corpus, research, translation, two fresh independent reviewer passes, quality, and audit before write.
- Stops without writing if research returns unresolved questions, if no research-capable provider is configured and the candidate list is non-empty, or if native review fails.
- Sends only extracted translatable segments to the provider; never sends whole MDX as a free-text translation target.
- Reconstructs MDX with `applySegmentTranslations()` and verifies locked regions before writing.
- Writes manifest `researchNotes`, `unresolvedResearch`, `reviewScore`, `nativeRegisterRationale`, `sourceSha256`, `targetSha256`, `lockedRegionSha256`, `styleGuideSha256`, `rubricSha256`, `qualityStatus`, and `qualityReportPath`.
- Uses a temp file or in-memory candidate for quality review before replacing the target path, so failed review never leaves a partial sidecar on disk.

- [ ] **Step 2: Implement `sync.mjs`**

Behavior:

- Accept `--slug <slug>` or `--all`.
- Generates missing targets.
- Refreshes stale `machine` targets only when source hash changed and target hash still matches manifest.
- Warns only on `edited` and `final`.
- Refuses target-hash drift and prints exact next commands: `translate:mark-edited` or `translate:finalize`.
- Refuses to treat `qualityStatus: "unreviewed"` classified machine targets as publishable; it must run repair/check or fail with the exact target path.
- Enforces `.translation/config.json` `requiredPublishLocales` for publish checks: missing required locales are generated only when writable; otherwise `content:publish` fails with exact blocked paths. Existing `edited` and `final` targets count as present and warn only if source hashes changed.

- [ ] **Step 3: Implement `repair.mjs`**

Behavior:

- Accept `--slug <slug>`, `--locale <locale>`, or `--all-machine`.
- Repairs only `translationStatus: machine`.
- Refuses protected legacy paths, protected human sidecars, `edited`, `final`, missing-status files, and hash-drifted files.
- Targets known direct-translation residue first.
- Runs research again before repair; stale or unresolved research blocks repair.
- Repairs must improve both mechanical audit and independent native-review score; if score does not improve, keep the original file and write a failed report only.
- Writes the repaired candidate to disk only after audit, locked-region checks, research, and reviewer gates pass. If any gate fails, leave the original file and manifest target hash unchanged.
- Updates manifest hashes and quality report cache keys only after the repaired file is written successfully.

- [ ] **Step 4: Implement `mark-edited.mjs`**

Behavior:

- Accept `--slug <slug> --locale <locale>`.
- Mark target:

```yaml
translationStatus: "edited"
translationSource: "human"
```

- Update manifest target hash.
- Set manifest `status: "edited"`, `source: "human"`, current `targetSha256`, `qualityStatus: "human-edited"`, and empty unresolved research. Preserve prior source hash so future sync can warn when the source changes.
- Do not alter body.

- [ ] **Step 5: Implement `finalize.mjs`**

Behavior:

- Accept `--slug <slug> --locale <locale>`.
- Mark target:

```yaml
translationStatus: "final"
translationSource: "human"
```

- If target is `machine`, run `translate:check` first unless `--human-reviewed` is provided.
- If target is `edited`, mark final without body changes after hash update.
- Set manifest `status: "final"`, `source: "human"`, current `targetSha256`, `qualityStatus: "human-final"`, and empty unresolved research.

- [ ] **Step 6: Validate dry runs**

Run:

```bash
npm run translate:sync -- --dry-run
npm run translate:repair -- --all-machine --dry-run
npm run translate:mark-edited -- --slug fork-work-why-work-when-we-can-use-autonomous-agents-instead --locale zh --dry-run
```

Expected:

- `sync` lists missing/stale writable targets only.
- `repair` lists machine-owned targets only.
- `mark-edited` proposes metadata only.
- Protected legacy and final/imported-legacy sidecars are never write targets.

- [ ] **Step 7: Commit**

```bash
git add tools/translation/generate.mjs tools/translation/sync.mjs tools/translation/repair.mjs tools/translation/mark-edited.mjs tools/translation/finalize.mjs
git commit -m "feat: add translation generation workflow"
```

---

## Task 8: Repair One Representative Machine Translation End To End

**Files:**
- Modify: one machine-owned target, recommended `src/content/blog/fork-work-why-work-when-we-can-use-autonomous-agents-instead/zh.mdx`
- Modify: `.translation/manifest.json`
- Create: `.translation/reports/<slug>-zh.json`

- [ ] **Step 1: Dry-run repair**

Run:

```bash
npm run translate:repair -- --slug fork-work-why-work-when-we-can-use-autonomous-agents-instead --locale zh --dry-run
```

Expected: reports direct-translation residue around `数据set`, `数据源s`, `ingest`, `chunk`, `query`, and `validate`.

- [ ] **Step 2: Apply repair**

Run:

```bash
npm run translate:repair -- --slug fork-work-why-work-when-we-can-use-autonomous-agents-instead --locale zh
```

- [ ] **Step 3: Validate**

Run:

```bash
npm run translate:check -- --slug fork-work-why-work-when-we-can-use-autonomous-agents-instead --locale zh
npm run translate:audit
npm run build
git diff -- src/content/blog/fork-work-why-work-when-we-can-use-autonomous-agents-instead/zh.mdx .translation/manifest.json .translation/reports
```

Expected:

- Direct-translation residue removed from prose.
- Code, inline code, URLs, iframe/audio/image attrs, and paths preserved.
- Reviewer report states native register passed.
- `.translation/reports/<slug>.zh.quality.json` records whether reviewer output was fresh or cache-reused.
- Build passes.

- [ ] **Step 4: Commit**

```bash
git add src/content/blog/fork-work-why-work-when-we-can-use-autonomous-agents-instead/zh.mdx .translation/manifest.json .translation/reports
git commit -m "fix: repair representative Chinese machine translation"
```

Stop here for human review before bulk repair.

---

## Task 9: Bulk Repair Existing Machine Translations

**Files:**
- Modify: only `src/content/blog/**/{zh,ko,ja,en}.mdx` with `translationStatus: machine`
- Modify: `.translation/manifest.json`
- Create/modify: `.translation/reports/*.json`

- [ ] **Step 1: Dry-run all repairs**

Run:

```bash
npm run translate:repair -- --all-machine --dry-run
```

Expected:

- Protected legacy folders: 0 write targets.
- Final/imported-legacy Chinese sidecars: 0 write targets.
- Edited/final translations: 0 write targets.
- Machine translations with direct-translation smell are listed.

- [ ] **Step 2: Apply in batches**

Run batches by locale:

```bash
npm run translate:repair -- --all-machine --locale zh
npm run translate:check -- --locale zh
npm run translate:repair -- --all-machine --locale ko
npm run translate:check -- --locale ko
npm run translate:repair -- --all-machine --locale ja
npm run translate:check -- --locale ja
```

Expected:

- No protected writes.
- Reviewer score for repaired machine translations is at least `minReviewScore`.
- Reports record native-register pass and research notes where needed.

- [ ] **Step 3: Validate all**

Run:

```bash
npm run translate:audit
npm run translate:check
npm test -- src/lib/i18n.test.ts
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/content/blog .translation/manifest.json .translation/reports
git commit -m "fix: repair machine translations"
```

---

## Task 10: Fix Family-Aware Routing And Locale Path Maps

Do this only after ownership/audit exists, so UI changes do not hide content safety problems.

**Files:**
- Modify: `src/lib/i18n.ts`
- Modify: `src/lib/i18n.test.ts`
- Modify: `src/layouts/Layout.astro`
- Modify: `src/components/Head.astro`
- Modify: `src/pages/blog/[...id].astro`
- Modify: `src/components/BlogCard.astro`
- Modify: `src/components/PostNavigation.astro`
- Modify: `src/pages/blog/[...page].astro`
- Modify: `src/pages/index.astro`
- Modify: `src/pages/tags/index.astro`
- Modify: `src/pages/tags/[...id].astro`
- Modify: `src/pages/authors/[...id].astro`
- Modify: `src/pages/rss.xml.ts`

- [ ] **Step 1: Add i18n helpers**

Add helpers:

```ts
export type LocalePathMap = Partial<Record<SupportedLocale, string>>

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
  const parts = entry.id.split('/')
  return !isLegacyChinesePostId(entry.id) && parts.length === 1 && !entry.data.translationKey
}

export function getLocalizedPostPath(familyId: string, locale: SupportedLocale, sourceLocale: SupportedLocale): string {
  return locale === sourceLocale ? `/blog/${familyId}` : `/blog/${familyId}/${locale}`
}

export function getStaticPageLocalePaths(pathname: string): LocalePathMap {
  return Object.fromEntries(SUPPORTED_LOCALES.map((locale) => [locale, pathname])) as LocalePathMap
}
```

Implementation note: verify Astro content IDs before finalizing `isSourcePostEntry`; current source IDs are folder slugs, and sidecars are `slug/locale`.

- [ ] **Step 2: Add tests**

Test cases:

- English source routes `/blog/slug`.
- English source sidecars route `/blog/slug/zh`, `/ko`, `/ja`.
- Non-English source routes `/blog/slug`.
- Non-English English sidecar routes `/blog/slug/en`.
- Missing target does not synthesize a URL.
- Legacy `*-zh` excluded from sibling maps.
- Static pages map all supported locales to the current path so the language toggle updates page text without navigation.
- Blog detail maps only real sibling locales; unavailable locales are absent from the map.
- Blog cards link to the actual localized sibling entry, not to a synthesized locale path for a missing sibling.
- Previous/next post navigation links to actual localized sibling entries when present and falls back to the source post URL when the sibling is missing; it never links to a missing `/blog/<slug>/<locale>` route.

- [ ] **Step 3: Update routes/lists**

Required behavior:

- Blog detail alternates include only real siblings.
- Blog card links use actual siblings. In `src/components/BlogCard.astro`, the URL for each localization must be derived from the `localizedEntry` found in the collection, not from the current card entry plus requested locale.
- `src/components/PostNavigation.astro` must receive resolved `prevHref` and `nextHref`, or sibling entries whose IDs already point to real content. It must not call `getPostLocalePath(prevPost.id, locale)` or `getPostLocalePath(nextPost.id, locale)` in a way that creates unavailable locale URLs.
- Home/blog/tags/authors/RSS list each source family once.
- Existing legacy redirects in `astro.config.ts` remain.
- `Layout.astro` accepts `localePaths?: LocalePathMap` and passes it to `Head.astro`.
- `Head.astro` imports `getStaticPageLocalePaths`, accepts `localePaths?: LocalePathMap`, and emits one inline JSON script:

```astro
<script
  is:inline
  type="application/json"
  id="site-locale-paths"
  set:html={JSON.stringify(localePaths ?? getStaticPageLocalePaths(Astro.url.pathname))}
/>
```

- Blog detail pages pass the real sibling map from content collection entries.
- Static/list pages pass `getStaticPageLocalePaths(Astro.url.pathname)`.
- Do not invent paths for missing translations. If `zh` is missing for a post, `zh` is absent from that post's locale path map.

- [ ] **Step 4: Validate**

Run:

```bash
npm test -- src/lib/i18n.test.ts
npm run build
npx astro build >/tmp/erniesg-build.log && rg '/blog/.+/(zh|ko|ja|en)/index.html' /tmp/erniesg-build.log
```

Spot check:

```text
/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content
/blog/raggaeton-scaling-a-i-augmented-writing-for-any-content/zh
/blog/a-i-for-humans-be-like-its-just-x/ko
/blog/a-i-for-humans-be-like-its-just-x/ja
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n.ts src/lib/i18n.test.ts src/layouts/Layout.astro src/components/Head.astro src/pages/blog src/pages/index.astro src/pages/tags src/pages/authors/[...id].astro src/pages/rss.xml.ts src/components/BlogCard.astro src/components/PostNavigation.astro
git commit -m "feat: make blog routing family-aware"
```

---

## Task 11: Fix Global Language And Theme Preferences

**Files:**
- Create: `src/lib/site-preferences.ts`
- Modify: `src/lib/use-site-locale.ts`
- Modify: `src/components/Header.astro`
- Modify: `src/components/ui/language-toggle.tsx`
- Modify: `src/components/ui/mode-toggle.tsx`
- Modify: `src/components/Head.astro`

- [ ] **Step 1: Move from `blogLang` to `siteLang`**

Behavior:

- Read `siteLang` first.
- If `siteLang` is absent and old `blogLang` exists, migrate it into `siteLang` and remove `blogLang`.
- If neither exists, detect from `navigator.languages`.
- Write only `siteLang`.
- Dispatch `site-language-change`.
- Temporarily also dispatch `blog-language-change` until all listeners are migrated.
- Language toggle reads the `#site-locale-paths` JSON map emitted by `Head.astro`. If the selected locale has no real path in that map, update preference and stay on the current URL.

Create `src/lib/site-preferences.ts`:

```ts
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type LocalePathMap,
  type SupportedLocale,
} from '@/lib/i18n'

export type SiteThemePreference = 'light' | 'dark' | 'system'

const supportedLocaleSet = new Set<string>(SUPPORTED_LOCALES)

export function normalizeLocalePreference(locale: string | null | undefined): SupportedLocale {
  const primary = locale?.toLowerCase().split('-')[0]
  return primary && supportedLocaleSet.has(primary) ? (primary as SupportedLocale) : DEFAULT_LOCALE
}

export function readLocalePathsFromDocument(documentRef: Document = document): LocalePathMap {
  const element = documentRef.getElementById('site-locale-paths')
  if (!element?.textContent) return {}
  try {
    return JSON.parse(element.textContent) as LocalePathMap
  } catch {
    return {}
  }
}

export function chooseLocalePath(locale: SupportedLocale, paths: LocalePathMap, currentPath: string): string | null {
  const nextPath = paths[locale]
  return nextPath && nextPath !== currentPath ? nextPath : null
}

export function normalizeThemePreference(value: string | null | undefined): SiteThemePreference {
  if (value === 'theme-light') return 'light'
  if (value === 'light' || value === 'dark' || value === 'system') return value
  return 'system'
}

export function resolveThemeClass(theme: SiteThemePreference, prefersDark: boolean): boolean {
  return theme === 'dark' || (theme === 'system' && prefersDark)
}
```

- [ ] **Step 2: Persist theme as `light | dark | system`**

Behavior:

- Migrate old `theme-light` to `light`.
- `light`: remove `dark`.
- `dark`: add `dark`.
- `system`: follow `prefers-color-scheme`.
- Do not rewrite `system` to resolved light/dark.
- Remove the `MutationObserver` pattern in `Head.astro` that writes resolved dark/light back into `localStorage.theme`.
- `Head.astro` should read `localStorage.theme`, migrate `theme-light` to `light`, default missing values to `system`, apply the resolved `dark` class, and leave `localStorage.theme` set to the user's explicit preference.
- `ModeToggle` should write only `light`, `dark`, or `system` to `localStorage.theme` and update the DOM immediately.
- Add a `matchMedia('(prefers-color-scheme: dark)')` listener only when the selected theme is `system`; remove it when switching away from `system`.

- [ ] **Step 3: Validate manually**

Run:

```bash
npm run dev
```

Manual checks:

- Choose zh on `/`: static UI and cards update.
- Open a blog post with zh sibling: route changes to `/zh`.
- Choose a locale unavailable for a test page: UI preference updates, URL stays valid.
- Confirm the language toggle reads `#site-locale-paths` and never constructs `/blog/<slug>/<locale>` itself.
- Reload: `siteLang` persists.
- Put `blogLang=ko` in localStorage, reload: `siteLang=ko` is created and `blogLang` is removed.
- Choose light/dark/system and reload; `localStorage.theme` remains `light`, `dark`, or `system` exactly, never a resolved value when `system` was selected.

- [ ] **Step 4: Validate build**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/site-preferences.ts src/lib/use-site-locale.ts src/components/Header.astro src/components/ui/language-toggle.tsx src/components/ui/mode-toggle.tsx src/components/Head.astro
git commit -m "feat: persist site language and theme preferences"
```

---

## Task 12: Final Publish Workflow And Optional Hook

**Files:**
- Optional create: `.githooks/pre-commit`

- [ ] **Step 1: Document new post workflow**

Add this to `AGENTS.md` or `docs/translation/style/rubric.md` if not already present:

````md
## Publishing A New Blog Post

After creating `src/content/blog/<slug>/index.mdx`, run:

```bash
npm run translate:sync -- --slug <slug>
npm run content:check
```

For an all-post publish sweep, run:

```bash
npm run content:publish
```

`content:publish` is the only publish command that may auto-generate translations. Plain `npm run build` remains a check/build command and must never generate, repair, or overwrite translation files. Deploy/CI should run `npm run content:publish` when the desired behavior is "publish this source post and generate/update writable machine translations"; use `npm run build` only when you want a non-mutating build.

`content:publish` must fail if any required EN, zh, ko, or ja target is missing, if a required `machine` target is stale but cannot be safely regenerated, if a target has hash drift, or if a machine target is blocked by unresolved research/native-review failure. It may generate writable missing/stale `machine` targets through `translate:sync -- --all`; it must never overwrite `edited`, `final`, protected legacy, or hash-drifted files. Existing `edited` and `final` targets satisfy the required-locale check and produce warnings only when the source changed.

`translate:check` may reuse cached reviewer reports only when the report hash inputs match the current source, target, prompts, style guide/corpus, glossary, rubric, provider, model, and reviewer profile. Use `npm run translate:check -- --refresh-review` when you intentionally want fresh reviewer calls for machine translations.

If the source post is non-English, set `lang` on `index.mdx` and run:

```bash
npm run translate:sync -- --slug <slug> --source zh
npm run content:check
```

If Ernie edits a machine translation but has not finalized it:

```bash
npm run translate:mark-edited -- --slug <slug> --locale zh
```

If Ernie approves a translation:

```bash
npm run translate:finalize -- --slug <slug> --locale zh
```
````

- [ ] **Step 2: Optional check-only hook**

Create `.githooks/pre-commit` only if requested:

```bash
#!/usr/bin/env bash
set -euo pipefail
npm run translate:audit
npm run translate:check -- --mechanical-only
```

Enable:

```bash
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
```

Hook must never generate or repair content.
Hook must never call `translate:sync`, `translate:generate`, or `translate:repair`.

- [ ] **Step 3: Final acceptance**

Run:

```bash
npm run translate:audit
npm run translate:style-corpus -- --locale zh --check
npm run translate:research -- --all --dry-run
npm run translate:check
npm run translate:test
npm test -- src/lib/i18n.test.ts
npm run build
```

Expected:

- Protected legacy folders unchanged.
- No canonical `preload="meta数据"`.
- No high-confidence direct-translation residue in machine/final content.
- Machine/final translations have no unresolved research in manifest or reports.
- Existing classified machine translations are either repaired to `qualityStatus: passed` or deliberately kept out of publish by `qualityStatus: unreviewed/failed`.
- `edited` and `final` translations are never overwritten.
- New source posts can generate missing targets.
- Blog routes use real siblings only.
- Lists/RSS show each family once.
- `siteLang` and `theme` persist correctly.

---

## Reviewer Approval Checklist

Approve this plan only if all are true:

- The first executable task is policy plus fail-closed ownership, not bulk translation repair.
- The four protected Chinese folders are never write targets.
- The four canonical human Chinese sidecars become `final/imported-legacy` only through reconciliation.
- Existing unclassified sidecars are protected until classification.
- Machine translations can be repaired, but only after hash and status checks.
- Native-quality review is explicit and independent from build success.
- The plan stops after one representative repair before bulk repair.
- Routing/preference work is separated from translation ownership work.

If a reviewer asks for changes, edit this plan narrowly. Do not ask another agent to produce a new full plan from scratch.
