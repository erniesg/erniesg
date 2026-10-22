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

Two independent `npm pack` runs at upstream source commit `90f76f1f80b037cc065169d07b13779c03420026` produced byte-identical tarballs with SHA-256 `42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1` (33 packed files, 346,288 uncompressed bytes). The producer's suite at that commit is 35 files / 1003 tests, plus a clean typecheck, a clean source-boundary check and the packed-consumer runtime/declaration/private-negative check.
