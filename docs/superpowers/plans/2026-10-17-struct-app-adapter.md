# E-02 app adapter preparation — 2026-10-17

## Baseline and scope

- App base: `74d483a04716af9dc46e2d3c390ecd242dcaff4c` on `refactor/struct-app-adapter-20261017`.
- Pinned private Struct artifact: `vendor/struct/erniesg-struct-0.0.0-10116f4726da89ebabc823cb25706f2de5386f40.tgz`, SHA-256 `e18d743de5e2c8431b64a830974bd1180299f21cc8ab8cf70a9b184c36ab1374`; source commit `10116f4726da89ebabc823cb25706f2de5386f40` (`vendor/struct/provenance.json`). This is implemented and unreleased.
- This is preparation for E-02/#282, not E-02 acceptance. ADR-0001 and the E-02/E-03 issue plan govern ownership. The unmerged Struct ADR-0002 does not change the default app extraction owner.
- New `src/struct-adapters` owns reconstruction-to-Struct. The old path and root export retain function identity as compatibility re-exports. No writer, renderer, route, Bundle, or portable production family switches here.

## Frozen source pilot

At the base, before relocation, `tests/fixtures/struct-adapter-parity/expected.json` was captured by running the actual `buildStructDocument` on three existing app source files: structured DOCX, ordinary born-digital PDF, and source-output-checkpoints PDF with recoverable/source-preserved visuals. `cases.ts` retains the exact source-file inputs. Expectations are literal data, never produced by the implementation during a parity test. They pin source digest/counts, document JSON and receipt digests, conservation, ordered block/asset/relationship IDs, asset digest/path/length, recovery presentation, XHTML digest, EPUB archive and entry hashes, and package decode failure messages. The source-neutral generic fixtures remain unchanged.

The structured DOCX output has assets and relationships and produces a deterministic EPUB, but both local strict encoding and the pinned package decoder reject its existing conservation count: `STRUCT_CODEC_CONSERVATION at $.receipt.conservation.accountedSourceRelationshipCount: accountedSourceRelationshipCount must match accounted output`. The frozen `documentJsonSha256` for this case hashes raw `JSON.stringify(document)` because a canonical encoded document is unavailable; the other two cases hash `JSON.stringify(encodeStructDocument(document))`. The source-preserved PDF decodes in the pinned package but its EPUB builder rejects with `STRUCT_EPUB_RECOVERY_REVIEW_REQUIRED`. These outcomes are preserved, not repaired or silently normalized in this stage.

## Checked preparation

- [x] Freeze the 3-case base adapter pilot and exact artifact identity.
- [x] Add a red boundary regression, then move the implementation without algorithm changes and green the boundary.
- [x] Keep the legacy and root exports as the same function.
- [x] Exercise app source/consultation, frozen package, and ResearchPaper legacy EPUB focused tests.
- [ ] Full E-02 conservation through package Bundle decode/verification; S-03/S-04 Bundle support and a new exact reviewed artifact are upstream gates.
- [ ] Resolve the existing structured-DOCX strict decoder incompatibility with separately scoped review; do not weaken conservation assertions.
- [ ] Later E-03/E-04 migrations may replace temporary local `src/struct` ID, ordering, receipt, recovery presentation, and renderer dependencies. The adapter uses public package document types now, while those runtime imports remain on local production implementations to avoid a premature cutover. Existing local recovery copy remains the presentation owner pending a separately scoped move.
- [ ] Coordinator runs `scripts/agent-evidence` and integrated exact-head review on a clean integrated head; this isolated stage does not claim those gates.

## Independent review finding repair

The review of `133b739556a23915e83886424d2fc870dde4f36e` found that the boundary test missed direct app research imports and unexported package paths. The test now scans imports and re-exports with the TypeScript AST in every non-test `.ts` file under `src/struct` and `src/struct-adapters`. It checks type imports, dynamic imports, and import types, resolves portable relative paths within `src/struct`, and allows only the legacy reconstruction re-export and the root index compatibility path. Package imports must appear in the pinned package's `exports` map.

The old guard missed all three representative forbidden imports in a baseline reproduction (red). The new boundary suite passes its synthetic negative cases and live source scan (green). The package artifact suite also passes. Adapter parity and package parity are pending coordinator repair of the installed dependency tree: both fail to load because `fast-xml-parser` cannot resolve `@nodable/entities`. This repair has not received fresh integrated-head evidence or independent review.

## Rollback

Revert this preparation commit to restore the base adapter location and remove the frozen source pilot. No durable writer or public route changes are involved. Preserve dirty canonical/recovery worktrees and the verified offload archive.
