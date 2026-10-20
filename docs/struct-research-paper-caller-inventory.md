# ResearchPaper caller inventory (E-04 / E-07 evidence)

## Status

**Evidence inventory only.** This document records what actually exists in the
Ernie.SG app repository at the stated baseline. It is **not** an acceptance
claim, **not** a cutover or retirement claim, **not** a migration completion
claim, and **not** evidence that any gate is satisfied. Every "keep / migrate /
retire" entry below is a **proposed disposition for a future issue**, not a
recorded decision and not a recorded state.

Nothing in this document was implemented, tested, built, deployed, or
published while producing it. No source file was modified.

This document is **evidence input for the cutover plan, not a decision**. It
is linked reciprocally with
[`docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md`](superpowers/plans/2026-10-20-struct-full-cutover-sequence.md)
(§"E-04 — Cut XHTML/EPUB and converge publication semantics" and §"E-04 exit
evidence must include two checked-in inventories") and with its companion
[`docs/struct-publication-graph-authority-inventory.md`](struct-publication-graph-authority-inventory.md).
The plan requires the *existence and scope* of this document; it does not treat
this document as gate satisfaction, and it records the same grep-bounded
limitation described below.

## Authority and baseline

| Item | Value |
|---|---|
| Repository | `erniesg/erniesg` |
| Worktree | `/home/ubuntu/.local/state/struct-migration/20261020-continuation/worktrees/app-inventory` |
| Source baseline (immutable) | `84747cb49a36fea0eb4db0322dbd092430daf754` |
| HEAD observed while inventorying | `b65c75b0` (docs-only descendant of the baseline) |
| Inventory commit (immutable) | `58c9097c7191c182416ee8329fee518b0355a791` |
| Merged into | `docs/struct-cutover-integrated-plan-20261020` (the cutover plan branch; the plan now links to this document) |
| Governing ADR | `docs/superpowers/specs/2026-08-27-cross-repository-domain-ownership-and-package-boundaries.md` (ADR-0001) |
| Governing issue plan | `docs/superpowers/plans/2026-08-27-cross-repository-architecture-issue-plan.md` — E-04 (issue #284), E-07 (issue #287) |
| App cutover sequence plan (read only when inventoried; linked reciprocally) | [`docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md`](superpowers/plans/2026-10-20-struct-full-cutover-sequence.md), section "E-04 — Cut XHTML/EPUB and converge publication semantics" |
| Companion inventory (same worktree, same scan; linked reciprocally) | [`docs/struct-publication-graph-authority-inventory.md`](struct-publication-graph-authority-inventory.md) |
| Global agent guide | `/home/ubuntu/.codex/AGENTS.md`; repository `AGENTS.md` |

ADR-0001 §"History-preserving moves and duplicate disposition" classifies
`research/epub.ts` overloads as **"Active compatibility — Keep until all
`ResearchPaper` consumers migrate"** with deletion gate *"Call-site inventory
and both-mode parity"*, and states that `ResearchPaper` *"remains a read-only
compatibility model until its active UI, worker, preview, and export consumers
move; it is not renamed into the canonical package model."* This document is
the call-site inventory half of that gate. **It does not assert that both-mode
parity has been demonstrated** — no parity run was performed here.

## Method, scanned roots, globs, and limitations

### Tooling actually used

`ripgrep 14.1.0` only. **No AST tooling was executed.** `node_modules/` is
absent from this worktree (`ls node_modules` → no such directory), so
`typescript`, `ts-morph`, `madge`, `dependency-cruiser` and `knip` were not
importable, and installing dependencies is not authorized for this task.

The repository *does* contain an existing AST-based import scanner —
`tests/struct-adapter-boundary.test.ts:12-55` implements `importedPaths()`
with `ts.createSourceFile(...)` and walks `ImportDeclaration`,
`ExportDeclaration`, `ImportTypeNode`, and `CallExpression` +
`ImportKeyword`. That harness is the natural place to add the E-04
"red-first static assertion" that the cutover plan calls for, but it **could
not be run here** (no installed dependencies). Consequently:

> **This inventory is grep-bounded, not compiler-proven.** Every claim below is
> "no importer was found under the stated scan", not "no importer exists". A
> compiler-level proof requires the AST harness in
> `tests/struct-adapter-boundary.test.ts` (or an equivalent) to be extended to
> the `src/publication/**` and `src/research/**` roots and executed.

The cutover plan
([`docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md`](superpowers/plans/2026-10-20-struct-full-cutover-sequence.md))
relies on this document and repeats the same limitation: it cites this
inventory as evidence input, marks the E-04 gates it does not satisfy as
**PENDING**, and does not treat the call-site half of the ADR-0001 deletion
gate ("Call-site inventory and both-mode parity") as satisfied by this
document.

### Exact scan scope

- Roots scanned: the **whole worktree** at the HEAD above, i.e. `src/`,
  `tools/`, `tests/`, `packages/`, `docs/`, `scripts/`, `benchmarks/`,
  `books/`, `infra/`, `public/`, `vendor/`, `skills/`, `astro.config.ts`,
  `package.json`.
- Globs used for code import/symbol scans:
  `*.{ts,tsx,astro,mjs,cjs,js,jsx,vue,svelte,html,md,json}`.
- Additional targeted globs: `src/publication/**` (all relative imports),
  `src/research/**` for same-directory `'./schema'` and `'./epub'` specifiers.
- Import-specifier patterns searched (literal string, both quote styles):
  `research/schema`, `research/epub`, `publication/schema`,
  `publication/research-paper-adapter`, `publication/source-adapter`,
  `publication/renderers/vivliostyle`, `publication/adapter-conformance`,
  `publication/adapter-registry`, `publication/profiles`,
  `publication/asset-bundle`, `publication/output-contract`,
  `publication/struct-adapter`, `publication/transformation-policy`,
  `publication/browser-runtime`, `publication/toolchain`,
  `publication/platform`.
- Symbol-level scans (word-boundary): `ResearchPaper`, `ResearchNode`,
  `researchPaperSchema`, `PublicationGraph`, `publicationGraphSchema`,
  `parsePublicationGraph`, `serializePublicationGraph`,
  `PUBLICATION_GRAPH_VERSION`, `PublicationReceipt`,
  `PublicationContractReceipt`, `publicationContractReceiptSchema`,
  `createPublicationContractReceipt`, `researchPaperToPublicationGraph`,
  `publicationGraphToResearchPaper`, `adaptResearchPaper`,
  `researchPaperSourceAdapter`, `RESEARCH_PAPER_ADAPTER_ID`,
  `PublicationSourceAdapter`, `validatePublicationSourceResult`,
  `buildEpub`, `buildReadableEpub`, `renderPublicationXhtml`, `inspectEpub`,
  `createAssetBundle`, `ASSET_BUNDLE_VERSION`, `createAnnotationBundle`,
  `annotationBundleSchema`, `serializeAnnotationBundle`,
  `createDemoAnnotations`, `canonicalContentHash`, `canonicalNodeContentHash`,
  `buildExportPackage`, `verifyExportPackage`, `getExportFile`,
  `buildStructEpub`, `assertStructEpubArchiveByteLength`.
- Dynamic imports searched separately: `import(` occurrences across all
  code globs, filtered for `research|publication`.
- Alias handling: `tsconfig.json` declares exactly one path alias,
  `"@/*": ["./src/*"]` (baseUrl `.`). No `vite`/`vitest` alias config file
  exists in the repository root (`astro.config.ts`, `playwright.config.ts`,
  `playwright.book.config.ts`, `postcss.config.mjs`, `tailwind.config.ts` are
  the only `*.config.*` files). `@/research/schema` and `@/research/epub` were
  therefore resolved manually to `src/research/schema` and `src/research/epub`.
- **No barrel file exists for `src/research/` or `src/publication/`** — there
  is no `src/research/index.ts` and no `src/publication/index.ts`. Re-export
  through a barrel is therefore not a live path for either module; the only
  re-export surface found is `src/research/epub.ts:35-36`, `:46-49` and
  `:128-131` (re-exports
  `EPUB_EXPORT_POLICY_VERSION`, `profileEpubCss`, `EpubExportMode`,
  `MAX_READABLE_FALLBACK_EQUATIONS_PER_BOOK`,
  `projectReadableFallbackReconstruction`, `MAX_EPUB_ASSET_BYTES_PER_BOOK`,
  `MAX_EPUB_ASSETS_PER_BOOK`) and `src/annotations/annotations.ts:23-24`
  (`export * from '../../packages/margin/src/anchor'` and `.../document`).
- `tools/model-consultation-evidence.ts:98` uses
  `typeof import('../src/research/epub')` — a **type-position dynamic import
  type**, not a runtime dynamic import. No runtime `await import(...)` of any
  `research/*` or `publication/*` module was found.

### Known limitations of this scan

1. No compiler/type-checker resolution was performed; a specifier that
   TypeScript resolves through a path mapping, `exports` field, or
   `case-insensitive` filesystem match that the literal string search missed
   would not appear here.
2. Indirection through a local variable holding a module path
   (`const p = 'research/schema'; await import(p)`) is not detectable by
   literal search; no such pattern was found, but absence is not proof.
3. String-concatenated or template-built specifiers are not matched.
4. Files excluded by the code globs (e.g. `.yml`, `.sql`, `.json` handled
   separately) are not import sites; `docs/**` was matched only to the extent
   that it contains import-like literals, which it does not.
5. `git status` was clean before authoring, so the tree matched the stated
   HEAD; the scan does not cover untracked or ignored files.

## 1. What `ResearchPaper` actually is

Defined in **`src/research/schema.ts`**:

| Symbol | Location | Kind |
|---|---|---|
| `researchPaperBaseSchema` | `src/research/schema.ts:266-325` | module-private zod object |
| `researchPaperSchema` | `src/research/schema.ts:327-660` | **exported** zod schema (`.strict()` base + `.superRefine()` integrity checks) |
| `ResearchPaper` | `src/research/schema.ts:662` | **exported** type (`z.infer<typeof researchPaperSchema>`) |
| `ResearchNode` | `src/research/schema.ts:663` | **exported** type (union member) |

These three are the module's only exports.

Node kinds (`src/research/schema.ts:312-323`, discriminated union on `type`):
`heading`, `paragraph`, `quote`, `caption`, `figure`, `footnote`. Each node
carries `id` and `source` (`canonicalNodeBase`, `src/research/schema.ts:40-45`).

Paper-level fields (`src/research/schema.ts:266-325`): `id`, `version`,
`status` (`working|review|published`), `title`, `subtitle`, `authors`,
`language?`, `baseDirection?`, `publicationDate?`, `artifactModifiedAt?`,
`metadataLineage?`, `authorNotes?`, `authorAffiliations?`, `affiliations?`,
`updated`, `abstract`, `nodes[]` (min 1).

Schema-enforced integrity (`superRefine`, lines 327-660) includes: unique node
ids; dangling note-reference/author-note/caption relationships rejected;
inline-run ranges must lie inside node text; footnote backlinks must be
reciprocal and point at the right note; structured table cells must form a
complete rectangular span grid; table rowspan must not cross the
header/body row-group boundary.

### Who owns `ResearchPaper` data today

- `src/research/papers.ts:1-13` is the **only** runtime loader of paper data:
  it imports `src/research/papers/if-letters-home-could-sing.json` and
  `src/research/papers/semantic-responsive-typesetting.json`, parses both with
  `researchPaperSchema`, and exports the `papers` array plus `getPaper(id)`.
- Those two JSON files are the only files in `src/research/papers/`.
- Every public paper route is generated from that array
  (`src/pages/papers/[id].astro:10-12`,
  `src/pages/papers/[id]/source.json.ts:3-5`,
  `src/pages/papers/[id]/manifest.json.ts:7-9`,
  `src/pages/papers/[id]/exports/[file].ts:16-23`).

## 2. Importer inventory — `src/research/schema.ts`

### 2a. Runtime (value) importers — production (non-test) files

| # | File | Line | Imported symbols | Direction | Source authority | Actual use | Proposed stage | Relevant tests |
|---|---|---|---|---|---|---|---|---|
| R1 | `src/research/papers.ts` | 3 | `researchPaperSchema` | paper → schema | **authoritative parse** of the two shipped JSON papers | `researchPaperSchema.parse(...)` on both JSON files (`:5-8`); exports `papers`, `getPaper` | **keep** (E-04: unchanged); migrate later to a Struct-derived source once the Struct pipeline can emit the same nodes | `src/research/schema.test.ts` (schema semantics) |
| R2 | `src/research/export-package.ts` | 32 | `researchPaperSchema`, `type ResearchPaper` | paper → schema | **parses and re-emits** the ResearchPaper as export `source.json` | `researchPaperSchema.parse` at `:439`; `canonicalContentHash(paper)` at `:364`; `verifyExportPackage` compares hashes at `:464`, `:679` | **keep** for E-04; **migrate** at E-07 (export package must be built from a Struct revision) | `src/research/export-package.test.ts` |
| R3 | `src/research/docx-import.ts` | 13-17 | `researchPaperSchema`, `type ResearchNode`, `type ResearchPaper` | paper → schema | DOCX import produces ResearchPaper nodes | import-time parse of imported DOCX reconstruction | **keep** (import path is app-owned source reconstruction); migrate at E-07 | `src/research/docx-import.test.ts` |
| R4 | `src/publication/research-paper-adapter.ts` | 1-5 | `researchPaperSchema`, `type ResearchNode`, `type ResearchPaper` | paper → schema | **graph bridge**; parses the paper before projecting to `PublicationGraph` | `:84` and `:302` parse; `:275` parses the reverse-projected paper | **keep** for E-04 (read-only bridge); the *reverse* direction is a **retire** candidate (see §4) | `src/publication/research-paper-adapter.test.ts`, `src/publication/source-adapter.test.ts` |
| R5 | `src/research/epub-readable-fallback-fixtures.ts` | 13 | `researchPaperSchema` | paper → schema | fixture builder for readable-fallback | parses fixture papers | **keep** (test-support module, non-`.test.ts`) | `src/research/epub-readable-fallback.test.ts` |

### 2b. Runtime (value) importers — test files

`src/publication/source-adapter.test.ts:3` · `src/publication/research-paper-adapter.test.ts:4` ·
`src/annotations/move-parity.test.ts:5` · `src/annotations/annotation-bundle.test.ts:4` ·
`src/annotations/annotations.test.ts:17` · `src/research/epub-note-relationships.test.ts:7` ·
`src/research/epub-metadata-profiles.test.ts:6` · `src/research/epub-scholarly-references.test.ts:4` ·
`src/research/epub-semantic-visuals.test.ts:10` · `src/research/epub.test.ts:38` ·
`src/research/evaluation.test.ts:10` · `src/research/export-package.test.ts:19` ·
`src/research/manifest.test.ts:16` · `src/research/overrides.test.ts:13` ·
`src/research/pagination.test.ts:9` · `src/research/pdf-semantic-runtime-regression.test.ts:6` ·
`src/research/schema.test.ts:4`.

All of these import `researchPaperSchema` as a **value**. All are **keep**
under ADR-0001 ("`ResearchPaper` compatibility remains tested until its last
production caller moves"), but each is a **migrate** candidate at E-07 if the
schema is replaced by a Struct-derived model.

### 2c. Type-only importers — production (non-test) files

All of these use `import type { … }` or inline `type` modifiers, i.e. they
consume the **shape** of `ResearchPaper` / `ResearchNode` but do **not** create
a runtime dependency on `src/research/schema.ts`.

| # | File | Line | Symbols | Actual use | Proposed stage |
|---|---|---|---|---|---|
| T1 | `src/annotations/annotations.ts` | 20 | `ResearchPaper` | `createDemoAnnotations(paper)` (`:29`) mints demo annotations keyed to paper node ids | keep; migrate with the annotation-anchor model |
| T2 | `src/components/research/ResearchPaperActions.tsx` | 1 | `ResearchPaper` | prop type for the export/action UI | keep; migrate at E-07 |
| T3 | `src/components/research/ResearchStudio.tsx` | 36 | `ResearchNode`, `ResearchPaper` | prop types for the studio UI; `:637` calls `createDemoAnnotations(paper)` | keep; migrate at E-07 |
| T4 | `src/components/research/IfLettersPublication.astro` | 4 | `ResearchPaper` | prop type for the fellowship publication page | keep; migrate at E-07 |
| T5 | `src/struct-adapters/from-reconstruction.ts` | 7 | `ResearchNode` | **app-owned reconstruction → Struct adapter**: maps ResearchNode → StructBlock (`nodeKind` `:106`, `nodeText` `:123`) | keep (ADR: canonical app adapter, never moves into Struct) |
| T6 | `src/research/canonical-hash.ts` | 2 | `ResearchNode`, `ResearchPaper` | `canonicalContentHash` (`:49`), `canonicalNodeContentHash` (`:53`) — the **current app-side canonical content digest** for a paper | keep; **migrate** — these hashes must eventually be Struct `document`/`receipt` digests |
| T7 | `src/research/composition.ts` | 1 | `ResearchNode` | per-node variant/composition typing (`:22`, `:149`) | keep; migrate |
| T8 | `src/research/epub-cross-reference-evidence.ts` | 9 | `ResearchNode`, `ResearchPaper` | cross-reference evidence validation | keep; migrate |
| T9 | `src/research/epub-package-presentation.ts` | 4 | `ResearchNode`, `ResearchPaper` | EPUB package/CSS presentation helpers | keep; migrate |
| T10 | `src/research/epub-readable-fallback.ts` | 19 | `ResearchPaper` | readable-fallback projection | keep; migrate |
| T11 | `src/research/evaluation.ts` | 6 | `ResearchPaper` | evaluation scoring, uses `canonicalNodeContentHash` (`:230`) | keep; migrate |
| T12 | `src/research/export-pdf.ts` | 3 | `ResearchNode`, `ResearchPaper` | PDF export rendering | keep; migrate |
| T13 | `src/research/import-types.ts` | 1 | `ResearchPaper` | **central app type re-export surface** for import/reconstruction types | keep; migrate |
| T14 | `src/research/manifest.ts` | 7 | `type ResearchNode`, `type ResearchPaper` | `buildLayoutManifest` (`:891`), `serializeLayoutManifest` (`:976`), `canonicalContentHash` (`:654`, `:897`) | keep; migrate |
| T15 | `src/research/overrides.ts` | 3 | `ResearchNode`, `ResearchPaper` | editorial overrides applied to paper nodes | keep; migrate |
| T16 | `src/research/pagination.ts` | 1 | `ResearchNode`, `ResearchPaper` | pagination/viewport model | keep; migrate |
| T17 | `src/research/pdf-canonical-node-composition.ts` | 1 | `ResearchNode` | canonical node composition | keep; migrate |
| T18 | `src/research/pdf-canonical-source-anchors.ts` | 1 | `ResearchNode` | source anchors for canonical nodes | keep; migrate |
| T19 | `src/research/pdf-inline-script-integrity.ts` | 6 | `ResearchPaper` | inline script integrity | keep; migrate |
| T20 | `src/research/pdf-layout.ts` | 1 | `ResearchNode`, `ResearchPaper` | PDF → ResearchNode layout engine (`:1888` maps regions to ResearchNode) | keep; migrate |
| T21 | `src/research/pdf-prose-boundary-evidence.ts` | 1 | `ResearchPaper` | prose boundary evidence | keep; migrate |
| T22 | `src/research/pdf-publication-metadata.ts` | 1 | `ResearchPaper` | publication metadata extraction | keep; migrate |
| T23 | `src/research/pdf-quality-canonical-analysis.ts` | 11 | `ResearchNode`, `ResearchPaper` | canonical analysis helpers (`nodeText` `:26`) | keep; migrate |
| T24 | `src/research/pdf-quality-line-boundary-analysis.ts` | 10 | `ResearchPaper` | line-boundary analysis | keep; migrate |
| T25 | `src/research/pdf-quality-relationships.ts` | 34 | `ResearchNode`, `ResearchPaper` | relationship analysis | keep; migrate |
| T26 | `src/research/pdf-quality.ts` | 54 | `ResearchNode`, `ResearchPaper` | PDF quality assessment | keep; migrate |
| T27 | `src/research/pdf-source-inline-evidence.ts` | 1 | `ResearchNode` | source inline evidence | keep; migrate |
| T28 | `src/research/pdf-visual-order.ts` | 1 | `ResearchNode`, `ResearchPaper` | visual ordering | keep; migrate |
| T29 | `src/research/pdf-visual-source-mapping.ts` | 1 | `ResearchNode` | visual source mapping | keep; migrate |
| T30 | `src/research/pdf-visual-validation.ts` | 21 | `ResearchPaper` | visual validation | keep; migrate |
| T31 | `src/research/publication-integrity.ts` | 11 | `ResearchNode`, `ResearchPaper` | `assertPublicationIntegrity`, `renderableAuthorNoteReferences` — **pre-publication integrity gate for the legacy EPUB path** | keep; migrate |
| T32 | `src/research/epub.ts` | 116 | `ResearchNode`, `ResearchPaper` | the legacy renderer itself (see §3) | keep (ResearchPaper branch) / migrate (Struct branch) |

### 2d. Type-only importers — test files

`src/components/research/ResearchStudio.test.tsx:8` ·
`src/research/decision-record.test.ts:42` ·
`src/research/epub-cross-reference-evidence.test.ts:3` ·
`src/research/epub-package-presentation.test.ts:3` ·
`src/research/pdf-exact-provenance.test.ts:10` ·
`src/research/pdf-inline-script-quality.test.ts:15` ·
`src/research/pdf-layout-deferred-float-ordering.test.ts:8` ·
`src/research/pdf-layout-document-structure.test.ts:52` ·
`src/research/pdf-layout-equation-lineage.test.ts:8` ·
`src/research/pdf-layout-float-reference-scoping.test.ts:8` ·
`src/research/pdf-layout-lists-and-heading-flow.test.ts:52` ·
`src/research/pdf-layout.test.ts:51` ·
`src/research/pdf-layout-visual-pair-ordering.test.ts:17` ·
`src/research/pdf-quality-equation.test.ts:10` ·
`src/research/pdf-quality-ocr-assets.test.ts:10` ·
`src/research/pdf-quality-semantic-flow.test.ts:11` ·
`src/research/pdf-quality-visual-obligations.test.ts:9` ·
`src/research/pdf-quality-visual-text.test.ts:12` ·
`src/research/pdf-quality.test-helpers.ts:11` ·
`src/research/pdf-quality.test.ts:19` ·
`src/research/pdf-visual-order-quality.test.ts:9` ·
`src/research/pdf-visual-order.test.ts:3` ·
`src/research/pdf-visual-validation.test.ts:32` ·
`src/research/publication-integrity.test.ts:15` ·
`src/research/semantic-table-source.test.ts:13`.

**Summary of the `research/schema` importer set:** 5 production runtime
importers, 17 test runtime importers, 32+ production type-only importers, 25+
test type-only importers. **No importer outside `src/research/`,
`src/publication/`, `src/annotations/`, `src/components/research/` and
`src/struct-adapters/` was found.**

## 3. Legacy renderer / export entry points — `src/research/epub.ts`

`src/research/epub.ts` is 2,593 lines and is a **dual-mode module**: it
dispatches between a `StructDocument` branch and a legacy `ResearchPaper`
branch at runtime.

### 3a. Dispatch and overloads

| Item | Location | Detail |
|---|---|---|
| `isStructDocument` | `src/research/epub.ts:133-141` | runtime type guard on `input` (`StructDocument | ResearchPaper`) |
| `renderPublicationXhtml` — overload 1 | `src/research/epub.ts:1422-1425` | `(document: StructDocument, options?: StructXhtmlOptions) => string` → `renderStructPublicationXhtml` (`src/struct/xhtml.ts`) |
| `renderPublicationXhtml` — overload 2 | `src/research/epub.ts:1426-1434` | `(paper: ResearchPaper, options?: {embedStyles, reconstruction, styles, visualAssets}) => string` → `renderResearchPublicationXhtml` (`src/research/epub.ts:1117`) |
| `renderPublicationXhtml` — implementation | `src/research/epub.ts:1435-1447` | `isStructDocument(input) ? renderStructPublicationXhtml(input, options) : renderResearchPublicationXhtml(input, options)` |
| `buildEpub` — overload 1 | `src/research/epub.ts:2094` | `(document: StructDocument) => Promise<EpubExport>` → `buildStructEpub` (`src/struct/epub.ts:428`) |
| `buildEpub` — overload 2 | `src/research/epub.ts:2095-2098` | `(paper: ResearchPaper, profile: TargetProfile) => Promise<EpubExport>` |
| `buildEpub` — overload 3 | `src/research/epub.ts:2099-2103` | `(paper: ResearchPaper, reconstruction?: DocumentReconstruction, profile?: TargetProfile) => Promise<EpubExport>` |
| `buildEpub` — implementation | `src/research/epub.ts:2104-2118` | `isStructDocument(paper) ? buildStructEpub(paper) : buildEpubInternal(paper, …, 'publication')` |
| `buildReadableEpub` | `src/research/epub.ts:2120-2126` | **ResearchPaper-only** → `buildEpubInternal(paper, reconstruction, profile, 'readable-fallback')` |
| `buildEpubInternal` | `src/research/epub.ts:2149+` | the legacy (ResearchPaper) EPUB assembly implementation |
| `inspectEpub` | `src/research/epub.ts:1854` | verification of a produced EPUB export |
| `getEpubProfileMetadata` | `src/research/epub.ts:465` | target-profile metadata |
| `readerFacingDebugMarkers` | `src/research/epub.ts:1807` | debug marker detection in produced XHTML |
| `renderNode` | `src/research/epub.ts:851` | per-node legacy XHTML rendering |
| `renderSemanticTable` | `src/research/epub.ts:626` | legacy semantic-table rendering |
| `renderResearchPublicationXhtml` | `src/research/epub.ts:1117` | the legacy XHTML writer (asserts semantic integrity at `:1418`) |

### 3b. Production (non-test) callers of the legacy renderer/export entries

| # | Caller | Line(s) | Entry used | Direction | Use | Proposed stage |
|---|---|---|---|---|---|---|
| L1 | `src/research/publication.worker.ts` | 3 | `buildEpub`, `buildReadableEpub` | paper → legacy renderer | Web Worker module that produces the EPUB export in the browser; instantiated as an inline Vite worker by `src/research/publication-worker-client.ts:19` (`import PublicationWorker from './publication.worker?worker&inline'`), which is consumed by `src/components/research/PublicationImporter.tsx:43` | **keep** for E-04 (app-owned worker/export surface per the cutover plan); migrate at E-07 |
| L2 | `src/research/export-package.ts` | 9-14 | `buildEpub`, `renderPublicationXhtml`, `inspectEpub` | paper → legacy renderer | assembles the multi-file export package (`reflowable.html`, `publication*.epub`, `print.pdf`, `source.json`, `layout-manifest.json`, `annotations.json`, `export-manifest.json`, `checksums.sha256`) | **keep** for E-04; **migrate** at E-07 (package must be built from a Struct revision) |
| L3 | `src/pages/papers/[id]/exports/[file].ts` | 26-30 | `buildExportPackage` (→ L2) | paper → legacy renderer → **public route** | the only public route that emits the legacy EPUB/PDF/HTML export artifacts; `getExportFile` at `:31` | **keep** for E-04; migrate at E-07 |
| L4 | `src/research/epub-preview.ts` | 9-13 | `MAX_EPUB_ASSETS_PER_BOOK`, `MAX_EPUB_ASSET_BYTES_PER_BOOK`, `type EpubExport` | epub → preview | compiles the in-browser EPUB preview archive | keep; migrate |
| L5 | `src/research/publication-worker-client.ts` | 1 | `type EpubExportMode` (type-only) | — | client protocol typing | keep |
| L6 | `src/research/publication-worker-protocol.ts` | 1 | `type EpubExport`, `type EpubExportMode` (type-only) | — | worker protocol typing | keep |
| L7 | `src/components/research/EpubRenditionPreview.tsx` | 2-5 | `EPUB_EXPORT_POLICY_VERSION` (runtime), `type EpubExport` (type-only) | — | UI preview of the produced EPUB | keep; migrate |
| L8 | `src/components/research/EpubDownloadLink.tsx` | 2 | `type EpubExport` (type-only) | — | UI download link | keep; migrate |
| L9 | `src/components/research/PublicationImporter.tsx` | 25 | `type EpubExport` (type-only) | — | import UI typing | keep |
| L10 | `src/research/reconstruction-materialization.ts` | 15 | `profileEpubCss` (runtime) | — | **Struct** path already uses `buildStructEpub` from `src/struct/epub` (`:2`) | migrate (E-04 renderer switch) |
| L11 | `src/research/export-pdf.ts` | 3 | `type ResearchNode`, `type ResearchPaper` (type-only) | — | legacy PDF writer | keep; migrate |
| L12 | `src/research/publication-integrity.ts` | 11 | `type ResearchNode`, `type ResearchPaper` (type-only) | — | pre-export integrity assertion | keep; migrate |
| L13 | `tools/pdf-export.mjs`, `tools/pdf-private-fidelity.mjs`, `tools/pdf-corpus-audit-lib.mjs`, `tools/srt-source-output-evidence.mjs`, `tools/pdf-epub-package-scan.mjs` | (see §5) | `buildEpub` / `buildReadableEpub` / `inspectEpub` | paper → legacy renderer | offline evidence tooling | keep; migrate when the Struct renderer is authoritative |
| L14 | `tools/model-consultation-evidence.ts` | 97-100 | `typeof import('../src/research/epub')` (type-position dynamic import) | — | type-only evidence gathering | keep |

**No production caller of `src/research/epub.ts` was found outside
`src/research/`, `src/components/research/`, `src/pages/papers/`, and
`tools/`.**

### 3c. Test callers of the legacy renderer/export entries

`src/research/epub.test.ts` · `src/research/epub-note-relationships.test.ts` ·
`src/research/epub-metadata-profiles.test.ts` ·
`src/research/epub-readable-fallback.test.ts` · `src/research/epub-source-fallback.test.ts` ·
`src/research/epub-scholarly-references.test.ts` ·
`src/research/epub-semantic-visuals.test.ts` · `src/research/epub-visual-packaging.test.ts` ·
`src/research/decision-record.test.ts` · `src/research/docx-import.test.ts` ·
`src/research/export-package.test.ts` · `src/research/pdf.test.ts` ·
`src/research/pdf-fidelity-regression.test.ts` ·
`src/research/pdf-layout.test.ts` · `src/research/pdf-layout-document-structure.test.ts` ·
`src/research/pdf-layout-equation-lineage.test.ts` ·
`src/research/pdf-layout-heading-classification.test.ts` ·
`src/research/pdf-layout-inline-source-semantics.test.ts` ·
`src/research/pdf-layout-link-target-resolution.test.ts` ·
`src/research/pdf-layout-lists-and-heading-flow.test.ts` ·
`src/research/pdf-layout-source-geometry.test.ts` ·
`src/research/pdf-paragraph-math.test.ts` ·
`src/research/pdf-regions.test.ts` · `src/research/pdf-regions-captions.test.ts` ·
`src/research/pdf-regions-equations.test.ts` · `src/research/pdf-regions-notes.test.ts` ·
`src/research/pdf-semantic-runtime-regression.test.ts` ·
`src/research/pdf-table-citation-crop-regression.test.ts` ·
`src/research/semantic-table-source.test.ts` ·
`src/struct/struct.test.ts:25-27` (imports `buildEpub as buildPublicEpub`,
`renderPublicationXhtml`) · `src/struct/codec.test.ts` ·
`tools/pdf-export.test.mjs`.

**Frozen/struct-adapter fixtures (separate from tests):**
`tests/fixtures/struct-adapter-parity/observe.ts:7,89` imports
`buildStructEpub` from `../../../src/struct/epub`; `tests/fixtures/struct-adapter-parity/reconstructions/` and
`tests/fixtures/struct-package-parity/` hold the frozen parity inputs.

## 4. The graph bridge — `src/publication/research-paper-adapter.ts`

**This module is a bidirectional bridge, not a facade that gates all
imports.** It is imported by exactly **two** files, both of them tests:

| # | Importer | Line | Kind | Symbols |
|---|---|---|---|---|
| B1 | `src/annotations/move-parity.test.ts` | 2 | runtime value import | `researchPaperToPublicationGraph` |
| B2 | `src/annotations/annotation-bundle.test.ts` | 11 | runtime value import | `researchPaperToPublicationGraph` |

Module exports and their actual callers:

| Export | Definition | Callers outside the module | Direction | Notes |
|---|---|---|---|---|
| `RESEARCH_PAPER_ADAPTER_ID` | `:21` | **none** | — | no importer found |
| `researchPaperToPublicationGraph` | `:81-196` | tests only: `src/publication/research-paper-adapter.test.ts:7,16,22,30,33,41`; `src/publication/source-adapter.test.ts:7,54`; `src/annotations/move-parity.test.ts:2,77`; `src/annotations/annotation-bundle.test.ts:11,15,66,75,93,107,122,171,196,224,271,283,357,385` | paper → graph | forward projection |
| `publicationGraphToResearchPaper` | `:198-296` | **tests only**: `src/publication/research-paper-adapter.test.ts:6,17` | graph → paper | **reverse path — the only place where a `PublicationGraph` can mint `ResearchPaper` semantic ids and text.** No production caller was found. |
| `adaptResearchPaper` | `:298-315` | `src/publication/source-adapter.test.ts:6,17,79` and the `researchPaperSourceAdapter` object at `:321` | paper → graph + receipt-less `PublicationSourceResult` | forward |
| `researchPaperSourceAdapter` | `:317-322` | **none** | — | **not registered** in `createDefaultPublicationAdapterRegistry()` (`src/publication/adapter-registry.ts:55-60` registers `astroPublicationAdapter`, `payloadLexicalSourceAdapter`, `structPublicationAdapter` only) |

### Bridge semantics that matter for E-04

- Forward (`researchPaperToPublicationGraph`) **rejects** several ResearchPaper
  features rather than degrading: scholarly metadata extensions
  (`authorNotes`, `authorAffiliations`, `affiliations`, `metadataLineage` —
  `:85-94`), embedded note references (`:59-68`), legacy list context
  (`:69-73`), and structured figure subtypes (`table`/`equation`
  — `:150-159`).
- Reverse (`publicationGraphToResearchPaper`) **reconstructs** a ResearchPaper
  from graph nodes, mapping `note` → `footnote` (`:238-250`), `caption` →
  `caption` (`:230-237`), `figure` → `figure` (`:251-267`), and rebuilding
  the paper-level `id`/`version`/`status`/`title`/`subtitle`/`authors`/
  `language`/`baseDirection`/`publicationDate`/`artifactModifiedAt`/`updated`/
  `abstract` from graph metadata (`:275-295`). It throws for `author-note`
  nodes (`:239-240`) and for every node type outside the ResearchPaper subset
  (`:268-271`).
- **Consequence for E-04:** the reverse direction is exactly the shape the ADR
  forbids — a second semantic writer that can produce canonical ids and text
  from a graph. It is currently exercised only by
  `src/publication/research-paper-adapter.test.ts:17`, which asserts a
  round-trip equality (`expect(publicationGraphToResearchPaper(graph)).toEqual(paper)`).
  That round-trip test is the concrete thing that must be retired or
  re-scoped before the graph can be narrowed.

## 5. Tooling callers of the legacy renderer

| Tool | File | Symbols |
|---|---|---|
| PDF export | `tools/pdf-export.mjs` | `buildEpub`, `buildReadableEpub`, `inspectEpub` |
| Private fidelity | `tools/pdf-private-fidelity.mjs` | `buildEpub`, `buildReadableEpub`, `inspectEpub` |
| Corpus audit | `tools/pdf-corpus-audit-lib.mjs` | `buildEpub`, `buildReadableEpub`, `inspectEpub` |
| SRT source-output evidence | `tools/srt-source-output-evidence.mjs` | `buildEpub` |
| EPUB package scan | `tools/pdf-epub-package-scan.mjs` | `inspectEpub` |
| Model consultation evidence | `tools/model-consultation-evidence.ts:97-100` | `typeof import(...)` types only |
| Demo evaluation | `tools/srt/demo-evaluation.mjs:308` | `createDemoAnnotations(paper)` (ResearchPaper annotations) |

## 6. Current source-authority picture (as observed, not as target)

| Concern | Observed current owner | Evidence |
|---|---|---|
| Canonical text of a paper | `ResearchPaper` JSON under `src/research/papers/` | `src/research/papers.ts:1-8` |
| Canonical content digest of a paper | `canonicalContentHash` (app-local, ResearchPaper-shaped) | `src/research/canonical-hash.ts:49`; consumed at `src/research/export-package.ts:364,464,679`, `src/research/manifest.ts:654,897`, `src/research/evaluation.ts:230` |
| Layout manifest | `src/research/manifest.ts` (`LAYOUT_MANIFEST_VERSION = '1.3.0'`, `:36`) | `src/pages/papers/[id]/manifest.json.ts:11-15` |
| Public JSON exposure of the paper | `src/pages/papers/[id]/source.json.ts:7-9` serves the raw ResearchPaper as `application/json` | route file itself |
| Public export artifacts | `src/pages/papers/[id]/exports/[file].ts:25-43` | route file itself |
| Graph (`PublicationGraph`) | derived projection; **not** wired to any route, writer, or the default adapter registry | §4 above; `src/publication/adapter-registry.ts:55-60` |
| Annotation anchors bound to graph nodes | `src/annotations/annotation-bundle.ts` — **test-only caller** | `src/annotations/annotation-bundle.test.ts`, `src/annotations/move-parity.test.ts` |

**The two `PublicationGraph`-anchored annotation surfaces are
`src/annotations/annotation-bundle.ts` (graph → annotation bundle) and
`src/annotations/annotations.ts` (ResearchPaper → demo annotations).** See the
companion document
[`docs/struct-publication-graph-authority-inventory.md`](struct-publication-graph-authority-inventory.md)
§7 for the anchor model.

## 7. Unresolved / not proven by this inventory

1. **No compiler-level import proof.** The absence of an importer is
   grep-bounded; see §"Known limitations".
2. **No both-mode parity evidence.** The cutover plan's E-04 deletion gate
   for `research/epub.ts` requires *"Call-site inventory and both-mode
   parity"*. Only the call-site half is in this document. Parity was not run.
3. **No E-04 static assertion was added or run.** The cutover plan's proposed
   red-first assertion (`PublicationGraph`, `publicationGraphSchema`,
   `serializePublicationGraph` absent from storage/API/route/writer/release
   modules) does not exist in the repository today. `tests/struct-adapter-boundary.test.ts`
   is the only AST-based boundary harness, and it currently covers
   `src/struct/**` and `src/struct-adapters/**` only — it says nothing about
   `src/publication/**`.
4. **Existing partial precedent, not coverage.** `src/struct/struct.test.ts:1234-1250`
   asserts that `src/struct/{types,ids,reading-order,model-consultation-receipt,xhtml,epub}.ts`
   do not import any `research/` module and do not contain the literal
   `ResearchPaper`. This covers the Struct side only; it does **not** assert
   anything about `src/publication/**`.
5. **Reverse-bridge round-trip test.** `src/publication/research-paper-adapter.test.ts:17`
   currently *requires* `publicationGraphToResearchPaper` to round-trip
   losslessly. Any E-04 "narrow or retire" decision must account for that
   test.
6. **`src/research/papers.ts` remains the only paper loader.** Whether the
   Struct-derived pipeline will emit the same node ids/text for the two
   shipped papers — and therefore whether `source.json` and the export
   package can be reproduced byte-for-byte — was **not** determined here.
7. **Publication-worker wiring.** `src/research/publication.worker.ts` is
   loaded as an inline Vite worker module by
   `src/research/publication-worker-client.ts:19`
   (`'./publication.worker?worker&inline'`), which is consumed by
   `src/components/research/PublicationImporter.tsx:43`.
   `tools/astro-config.test.ts:11-24` asserts the Vite `optimizeDeps` set for
   the **publication worker dependency graph** (`pdfjs-dist`,
   `pdfjs-dist/legacy/build/pdf.mjs`, `tesseract.js`) and
   `tools/astro-config.test.ts:53` transforms
   `/src/research/publication.worker.ts`. The exact production bundle wiring
   was not re-derived for this document.
8. **No frozen golden set was regenerated or compared.** No build, test,
   renderer, or golden run was executed.
