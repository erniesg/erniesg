# Exact Struct artifact (unreleased)

Ernie.sg prepares its standalone Struct dependency using the checked-in tarball
and `provenance.json`. `package.json` pins this file and `package-lock.json` pins
its SHA-512 integrity. `tests/struct-package-artifact.test.ts` verifies the
SHA-256 provenance digest, dependency/lockfile agreement and installed export
map. No sibling Struct checkout is required for `npm ci`.

This private `0.0.0` artifact is implemented and unreleased. It is not an npm
registry release. Its source commit includes the packed XHTML boundary fix in
[Struct PR #22](https://github.com/erniesg/struct/pull/22), a prerequisite for issue #7. Production Ernie.sg consumers still use the
local implementation while cross-repository parity and migration gates are
established. Do not close #282/#283 on the strength of this dependency pin.

Rebuild in a clean checkout of the exact `sourceCommit` from `provenance.json`,
using its recorded Node/npm toolchain:

```sh
npm ci
npm run test:package
npm test
npm run typecheck
npm run test:source-boundary
npm pack --json
```

Compare the resulting tarball SHA-256 and SHA-512 with `provenance.json` before
replacing this file. Any package update requires a new source commit, a new
artifact filename, updated integrity, compatibility evidence and independent
review. An unchanged version string alone does not identify this artifact.

The current writer and serialized versions are unchanged. Before a production
cutover, the approved migration plan still requires the app-owned adapter,
complete parity corpus and unfinished Bundle/package gates. Recovery UI copy,
PDF/model semantics, acquisition and publication approval remain app-owned.

## The previous pin (2026-10-21 inline-code follow-up)

| field | value |
| --- | --- |
| source commit | `119d0411edb525dc7cce2f0f80a5c2ab37f5d040` |
| source base for this delta | `72a64ebbecde6718cbfcf59b17085bd794926cf9` |
| artifact | `erniesg-struct-0.0.0-119d0411edb525dc7cce2f0f80a5c2ab37f5d040.tgz` |
| sha256 | `bb86a4bc192c2485f1029dee32964e5488e9277345dfb5a222d17fa3cfce6296` |
| integrity | `sha512-qHxaJ5MKq8XaxI8zbWSKcMs7Lft64rogSeVzyZoh8KuvqXcCswQH8Ri0/6dUWxgmn52PW3ieX8nL4isdYZWBUQ==` |
| packed files / uncompressed bytes | 33 / 349,559 |
| toolchain | node 22.22.3, npm 10.9.8, pnpm 12.8.1 |

The delta against the previous pin (`90f76f1f80b037cc065169d07b13779c03420026`,
sha256 `42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1`) is
exactly one additive, optional document field: `StructInline` gains a boolean
`code` flag that marks a character range as verbatim source code and renders as
the HTML `<code>` element in the package XHTML renderer and, through the same
XHTML path, in the EPUB content document. A document that omits the flag decodes
and renders exactly as before, so document schema `0.2.0` is unchanged and needs
no version bump. No runtime export, export path or `API_MANIFEST.json` entry
changed.

Two independent `npm ci` + `npm run test:package` + `npm pack --json` builds
from the clean committed head `119d0411edb525dc7cce2f0f80a5c2ab37f5d040`
produced byte-identical tarballs: the same SHA-256
`bb86a4bc192c2485f1029dee32964e5488e9277345dfb5a222d17fa3cfce6296` and the same
SHA-512 integrity above. The producer's suite at that commit is 36 files /
1012 tests, plus a clean typecheck, a clean source-boundary check and the
packed-consumer runtime/declaration/private-negative check.

The previous reviewed artifact file is still in this directory and is
unchanged: it was neither rewritten nor reused. It is simply no longer the
pinned one.

## The current pin (2026-10-21 nested-lists-and-captions follow-up)

| field | value |
| --- | --- |
| source commit | `3d3a7c95b1c55a9ff4b527eee5acf36c168cd896` |
| source base for this delta | `119d0411edb525dc7cce2f0f80a5c2ab37f5d040` |
| artifact | `erniesg-struct-0.0.0-3d3a7c95b1c55a9ff4b527eee5acf36c168cd896.tgz` |
| sha256 | `836f6d3ead7a5ce1dc59f2799c80dfbe5c52931836a5b4f2749ab5b1920a55f9` |
| integrity | `sha512-1wpcnARYQmVSsxiLRiSEtp5hd8h9WvxH22cSN/XwCrx0NWPxFif8mswYvF40PybKzi//e1sCPKuap4UiY+deaQ==` |
| packed files / uncompressed bytes | 33 / 368,119 |
| toolchain | node 22.22.3, npm 10.9.8, pnpm 12.8.1 |

The source base for this delta is the previously pinned source commit
`119d0411edb525dc7cce2f0f80a5c2ab37f5d040`: it is literally the commit the
delta is based on. `git merge-base 119d0411edb525dc7cce2f0f80a5c2ab37f5d040
3d3a7c95b1c55a9ff4b527eee5acf36c168cd896` returns
`119d0411edb525dc7cce2f0f80a5c2ab37f5d040`, and
`git merge-base --is-ancestor 119d0411edb525dc7cce2f0f80a5c2ab37f5d040
3d3a7c95b1c55a9ff4b527eee5acf36c168cd896` succeeds, so the previous pin is a
direct ancestor of the new source head.

The delta against the previous pin (`119d0411edb525dc7cce2f0f80a5c2ab37f5d040`,
sha256 `bb86a4bc192c2485f1029dee32964e5488e9277345dfb5a222d17fa3cfce6296`) is
the merged `erniesg/struct` PR #42 "feat(renderers): publish nested lists and
attached captions once". It touches the XHTML renderer only:

- `src/renderers/xhtml-lists.ts` (new), `src/renderers/xhtml-plan.ts` and
  `src/renderers/xhtml.ts` (modified), plus the `API.md` and `CONTRACT.md`
  sections that state the new rules. The other two changed files in the
  source range, `tests/fixtures/resolver-host/parent_harness.py` and
  `tests/fixtures/resolver-host/real_host_manager.py`, are test fixtures and
  are not part of the packed artifact.
- **Nested and ordered list attributes.** A `list-item` block gains optional,
  additive members of its existing free-form `attributes` bag: `listLevel`
  (integer — the declared nesting level; a negative integer is nesting
  metadata that resolves to the outermost level, and a fractional or
  non-numeric value is not nesting metadata at all), `listOrdered` (boolean —
  the explicit spelling of the older `ordered` attribute, and it wins when a
  document declares both), `listOrdinal` (integer — the item's number inside
  an ordered list, published as the `<ol start="N">` value when it differs
  from `1`), alongside the pre-existing `ordered` (boolean) and `listId`
  (string). A contiguous run of `list-item` blocks is one list. The run is a
  flat list when no item declares the nested contract, and a nested list when
  any item does; a run that mixes the two contracts therefore publishes one
  list, not one list per contract. The declared level is a grouping key, not
  the rendered depth: the run's first item is the base, items that declare
  the same level stay together, and a level that jumps by more than one opens
  exactly one nested list. A change of `listId` is a hard boundary — the
  following list never joins the open list's container and keeps its own
  declared nesting instead of being flattened to the root level. A sibling
  whose ordering differs starts a new sibling list instead of mixing `<ol>`
  and `<ul>` items in one container. The rendered nesting depth is bounded at
  16 nested lists below the outermost list.
- **The attached-caption rule.** A caption is attached to a host block
  (`figure`, `table` or `equation`) only through the document's declared
  relationship — `kind` `caption`, `status` `matched`, `from` the host block
  id, `to` an array holding the caption block id. The renderer never matches a
  caption by text, label or position. An attached caption is published exactly
  once, inside the host's `<figcaption>`, and the caption block is not
  published again as a paragraph. The attached caption is the host's caption:
  the host's own figcaption text is not published a second time, which closes
  the duplication where the host carries its own copy of the caption text. A
  host whose own caption text differs from the attached caption's text is a
  document inconsistency, and the renderer fails closed on it — the
  publication is refused with the renderer's publication-plan error (`name`
  `RenderedPublicationPlanError`, code `CONFLICTING_CAPTION`). An ambiguous
  attachment is not attached at all: a host with more than one matched caption,
  or a caption claimed by more than one host, keeps both sides published
  exactly as the graph states them.

Unchanged by this delta: the document schema stays `0.2.0` and needs no
version bump, because a document that omits every new attribute decodes and
renders exactly as before; the public export map is unchanged (the same nine
paths — `.`, `./document`, `./identity`, `./ordering`, `./receipt`,
`./recovery`, `./renderers/xhtml`, `./renderers/epub`, `./bundle`); and
`API_MANIFEST.json` is byte-identical to the previous pin's. The pin therefore
neither widens nor narrows the public surface.

Reproducibility: the artifact was built twice from two independent clean
checkouts of `3d3a7c95b1c55a9ff4b527eee5acf36c168cd896` (two separate clones
of `https://github.com/erniesg/struct`, each verified with `git rev-parse HEAD`
equal to that commit and a clean `git status --porcelain`). Each checkout ran
the full recorded pipeline with node 22.22.3 and npm 10.9.8: `npm ci`,
`npm run build`, `npm test -- --testTimeout=30000`, `npm run typecheck`,
`npm run test:source-boundary`, `npm run test:package`, and
`npm pack --json --pack-destination <scratch>`. Both builds produced a
byte-identical tarball — the same SHA-256
`836f6d3ead7a5ce1dc59f2799c80dfbe5c52931836a5b4f2749ab5b1920a55f9` and the
same SHA-512 integrity above — and `cmp` reports the two files as identical.
The producer's suite at that commit is 37 files / 1033 tests, plus a clean
typecheck, a clean source-boundary check and the packed-consumer
runtime/declaration/private-negative check.

The previous reviewed artifact file is still in this directory and is
unchanged: it was neither rewritten nor reused. It is simply no longer the
pinned one. The E-02 artifact file is also still in this directory, unchanged.
