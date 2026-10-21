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

## The current pin (2026-10-21 inline-code follow-up)

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
