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

## Publishing A New Blog Post

After creating `src/content/blog/<slug>/index.mdx`, run:

```bash
npm run translate:codex-sync -- --slug <slug> --write
npm run translate:codex-review -- --slug <slug> --strict-publish
npm run content:check
```

For an all-post publish sweep, run:

```bash
npm run content:publish
```

`content:publish` is the only publish command that may auto-generate translations. Plain `npm run build` remains a check/build command and must never generate, repair, or overwrite translation files.

`content:publish`, `translate:codex-sync`, and `translate:codex-review` use local `codex exec` with `CODEX_TRANSLATION_REASONING_EFFORT=high`. Do not replace them with a direct translation API path unless Ernie explicitly asks.

If Ernie edits a machine translation but has not finalized it:

```bash
npm run translate:mark-edited -- --slug <slug> --locale zh
```

If Ernie approves a translation:

```bash
npm run translate:finalize -- --slug <slug> --locale zh
```
