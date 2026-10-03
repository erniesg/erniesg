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

A second clean archive/build of source commit `10116f4726da89ebabc823cb25706f2de5386f40` reproduced SHA-256 `e18d743de5e2c8431b64a830974bd1180299f21cc8ab8cf70a9b184c36ab1374`. The producer passes 298 unit tests, typecheck, source-boundary checks and the clean packed-consumer runtime/declaration check. Independent review of that exact source commit found no actionable defects.
