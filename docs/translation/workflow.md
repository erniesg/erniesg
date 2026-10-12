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

- translation JSON/reports, translation documentation, blog MDX, and public
  image assets; and
- HTML files from the already gated `dist/` build.

It never stages executable project code, `.env`, `.git`, `node_modules`,
Cloudflare configuration, or publisher credentials. The VM runs the reviewed,
pinned publisher runtime installed under `/opt/erniesg-translation-publisher/`;
the bridge does not create, copy, or print credentials.

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

Before that work starts, the pinned VM helper snapshots every source and
human-owned translation. At export it rejects any changed source, human-owned
target, or unexpected result, and returns only changed or new machine sidecars
plus the manifest, page catalog, and review reports. Project code is never
uploaded or executed on the VM.

Before applying a returned archive locally, the bridge validates every archive
entry's path and type, rejects links and special files, checks all returned
machine provenance and hashes, and preserves every non-machine manifest, page,
and translation-memory record. It snapshots the output bytes once, checks the
entire staged checkout state (including paths that must still be absent), then
prepares every replacement before the first atomic rename. A local exclusive
lock prevents two publishers from racing. If a rename fails, only files that
were already committed are restored. The bridge never deploys or publishes;
the caller performs the gated build and deployment after the local result is
applied.

For a deterministic build or ordinary CI validation, use the non-mutating
translation/catalog checks wired by the main build. Those checks do not invoke
the trusted VM or a provider.
