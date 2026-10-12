# Translation publish workflow

`content:publish` is the automatic translation step used at publication time.
It is not a scheduled job and it does not run a translation provider on a
developer machine or ordinary CI runner.

The command entry point is:

```bash
node tools/translation/run-publish.mjs
```

It creates a temporary `generated/tmp/erniesg-localization-<id>` input bundle,
then sends that bundle to the existing `erniesg-ai-vm` SSH alias. The runner
rejects any other host. The bundle contains only translation inputs:

- `package.json`, `tools/translation/`, `.translation/`, and
  `docs/translation/`;
- `src/content/blog/` and optional `public/data/` source copy; and
- HTML files from the already gated `dist/` build.

It never stages `.env`, `.git`, `node_modules`, Cloudflare configuration, or
publisher credentials. The VM uses its existing Codex login and its existing
`node_modules`; the bridge does not create, copy, or print credentials.

On the trusted VM, the runner sets `TRANSLATION_PROVIDER=codex-cli` without
forcing a model, then runs the blog sequence:

1. sync writable missing or stale machine sidecars;
2. fresh native review;
3. revise;
4. fresh native review;
5. revise; and
6. strict publication review.

It then generates missing or stale machine page translations for `zh`, `ja`,
and `ko` in three independent locale catalogs. Each locale generator persists
after each page, and the runner merges only that locale's result into the base
catalog serially before validating the catalog against the staged HTML.

The bridge returns only `.translation` metadata/reports and localized blog
sidecars. Before the command applies any returned file locally, it rejects an
unexpected artifact, any modified protected input, an unsafe existing sidecar
overwrite, or a changed native page-catalog locale. It repeats the existing
machine-provenance and hash check against the caller's current checkout and
preserves source originals and human-owned targets. New sidecars must identify
themselves as machine translations. The bridge never deploys or publishes;
the caller performs the gated build and deployment after the local result is
applied.

For a deterministic build or ordinary CI validation, use the non-mutating
translation/catalog checks wired by the main build. Those checks do not invoke
the trusted VM or a provider.
