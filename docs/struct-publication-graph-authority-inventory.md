# PublicationGraph authority inventory (E-04 / E-07 evidence)

## Status

**Evidence inventory only.** This document records what actually exists in the
Ernie.SG app repository at the stated baseline: what `PublicationGraph` *is*,
who consumes it, what it serializes, what it persists, which receipts bind it,
and where it currently sits relative to the ADR-0001 target.

It is **not** an acceptance claim, **not** a cutover claim, **not** a
retirement claim for `src/publication/**`, and **not** a claim that any
E-04/E-07 gate is satisfied or that any proposed gate is implemented. Where
this document describes an assertion that does not yet exist in the
repository, it says so explicitly.

No source file was modified while producing it. No build, test, renderer,
golden, or receipt run was executed.

This document is **evidence input for the cutover plan, not a decision**. It
is linked reciprocally with
[`docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md`](superpowers/plans/2026-10-20-struct-full-cutover-sequence.md)
(§"E-04 — Cut XHTML/EPUB and converge publication semantics", §"E-04 exit
evidence must include two checked-in inventories", and the E-04 future-gate
table) and with its companion
[`docs/struct-research-paper-caller-inventory.md`](struct-research-paper-caller-inventory.md).
The plan requires the *existence and scope* of this document; it does not treat
this document as gate satisfaction, and it records the same grep-bounded
limitation described below. The gate table in §9 below is the source of the
plan's pending-gate list; every row of it is still **PENDING**.

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
| Governing issue plan | `docs/superpowers/plans/2026-08-27-cross-repository-architecture-issue-plan.md` — E-04 (#284), E-07 (#287) |
| App cutover plan (read only when inventoried; linked reciprocally) | [`docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md`](superpowers/plans/2026-10-20-struct-full-cutover-sequence.md), §"E-04 — Cut XHTML/EPUB and converge publication semantics" |
| Companion inventory (same worktree, same scan; linked reciprocally) | [`docs/struct-research-paper-caller-inventory.md`](struct-research-paper-caller-inventory.md) |

### Scan scope and limitations (shared with the companion inventory)

`ripgrep 14.1.0` only; **no AST tooling was executed** (`node_modules/` is
absent from this worktree, so `typescript`/`ts-morph` are not importable, and
installing dependencies is not authorized for this task). The repository does
contain an existing AST import scanner at
`tests/struct-adapter-boundary.test.ts:12-55`
(`ts.createSourceFile` + `ImportDeclaration`/`ExportDeclaration`/
`ImportTypeNode`/`CallExpression`+`ImportKeyword` walk), which is the natural
home for the E-04 static assertion — but it currently covers only
`src/struct/**` and `src/struct-adapters/**`, and it could not be run here.

> **Therefore every "no importer was found" statement below is grep-bounded,
> not compiler-proven.** Roots scanned: the whole worktree at the stated HEAD
> (`src/`, `tools/`, `tests/`, `packages/`, `docs/`, `scripts/`, `config`
> files). Code globs: `*.{ts,tsx,astro,mjs,cjs,js,jsx,vue,svelte,html,md,json}`.
> The only alias is `"@/*" → "./src/*"` (`tsconfig.json`); there is no
> `vite`/`vitest` alias file and **no barrel** (`index.ts`) exists for
> `src/research/` or `src/publication/`, so no barrel re-export path is live.
> Full scan detail and limitations: companion inventory §"Method, scanned
> roots, globs, and limitations".

The cutover plan
([`docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md`](superpowers/plans/2026-10-20-struct-full-cutover-sequence.md))
relies on this document and repeats the same limitation: it cites this
inventory as evidence input, marks every E-04 gate it does not satisfy as
**PENDING**, and — where the inventories and the plan previously disagreed —
corrects the plan against the observed state recorded here rather than the
other way round.

## 1. What `PublicationGraph` actually is

Defined in **`src/publication/schema.ts`** (897 lines):

| Symbol | Location | Kind |
|---|---|---|
| `PUBLICATION_GRAPH_VERSION` | `src/publication/schema.ts:3` | exported const `'1.0.0'` |
| `MAX_PUBLICATION_NODES` | `:4` | exported const `10_000` |
| `MAX_TEXT_LENGTH` | `:5` | exported const `1_000_000` |
| `publicationInlineRunSchema` / `PublicationInlineRun` | `:76-103` | exported schema + type |
| `publicationNodeSchema` | `:317-332` | exported discriminated union on `type` |
| `publicationGraphSchema` | `:412-886` | exported zod schema (`.strict()` + `.superRefine()`) |
| `PublicationGraph` | `:888` | exported type |
| `PublicationNode` | `:889` | exported type |
| `parsePublicationGraph` | `:891-893` | exported function |
| `serializePublicationGraph` | `:895-897` | exported function (`JSON.stringify(publicationGraphSchema.parse(value))`) |

### 1a. It is a full second semantic model, not a narrow projection

The graph carries, per node (`nodeBase`, `src/publication/schema.ts:153-170`):
its own `id`, `locale`, `direction`, `requirement`, `importance`,
`provenance` (`adapterId`, `sourceId`, `sourceRevision`, `evidence`,
`idOrigin`), `accessibility` (`alternativeText`, `longDescription`,
`transcript`, `decorative`), `variants` (max 3, kinds `compact|monochrome|static`,
each with `reviewed`), `permittedTransformationIds`, and `edition`.

Graph node kinds (14, `:196-315`): `heading`, `paragraph`, `list`,
`list-item`, `quote`, `code`, `figure`, `caption`, `table`, `equation`,
`aside`, `note`, `reference`, `media`.

ResearchPaper node kinds (6, `src/research/schema.ts:312-323`): `heading`,
`paragraph`, `quote`, `caption`, `figure`, `footnote`.

Eight graph node kinds have **no** ResearchPaper counterpart, and the
ResearchPaper→graph bridge **rejects** ResearchPaper features rather than
mapping them (`src/publication/research-paper-adapter.ts:59-74`, `:85-94`,
`:150-159`).

The two models also use **different id grammars**:

| Model | Id rule | Location |
|---|---|---|
| ResearchPaper | `z.string().min(1)` — any non-empty string | `src/research/schema.ts:3` |
| PublicationGraph | `z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)` | `src/publication/schema.ts:7-11` |

So graph ids cannot be assumed to be derived from a Struct/ResearchPaper id
without an explicit mapping, and vice versa.

The two id namespaces are **distinct and stricter**, not **disjoint**: the
graph→ResearchPaper reverse converter copies `node.id` verbatim in every node
case (`src/publication/research-paper-adapter.ts:207`, `:216`, `:224`, `:232`,
`:242`, `:253`), and the round-trip test asserts that graph ids equal the
source paper ids (`src/publication/research-paper-adapter.test.ts:18-20`). The
graph's stricter grammar therefore constrains which id strings the graph
*accepts*; it does not by itself separate the two id namespaces.

### 1b. Graph-level integrity rules (`.superRefine`, `:427-886`)

Unique node ids; unique *rendered DOM* ids (node id, `<id>-source` for
figures, `<id>-transcript` for non-decorative media, inline `relationshipId`
anchors, table cell ids); no dangling inline `targetIds`; no dangling
relationships; reciprocal list↔list-item; reciprocal caption↔caption-owner;
note backlinks must identify exactly one unique inline run targeting the note
with a unique anchor relationship id; link-producing inline runs must render
in every publication profile and must not overlap; table `headerIds` must
target header cells; nested-list cycle detection.

These are the concrete reasons the graph is **not** mechanically
re-derivable from an arbitrary source without the projection logic.

## 2. Module inventory — `src/publication/**`

| File | Lines | Role | Imports the graph? | Notes |
|---|---|---|---|---|
| `src/publication/schema.ts` | 897 | **definition** — `publicationGraphSchema`, `PublicationGraph`, `PublicationNode`, `parsePublicationGraph`, `serializePublicationGraph` | defines it | the only graph authority in the app |
| `src/publication/source-adapter.ts` | 216 | **adapter contract** — `PublicationSourceAdapter`, `PublicationSourceResult`, `AdapterProvenance`, `AdapterDiagnostic`, `validatePublicationSourceResult` (`:177`), `PublicationContractReceipt` (`:63`), `publicationContractReceiptSchema` (`:25`), `createPublicationContractReceipt` (`:148`) | yes (`:13-16`) | the generic "adapter produces a graph" contract |
| `src/publication/asset-bundle.ts` | 145 | asset descriptor + byte resolver; `ASSET_BUNDLE_VERSION` | no | paired with the graph |
| `src/publication/adapter-registry.ts` | 60 | **registry** — `PublicationAdapterRegistry` (`:20`), `buildRegisteredPublication` (`:41`), `createDefaultPublicationAdapterRegistry` (`:55-60`) | indirectly (via `PublicationSourceResult`) | registers **astro**, **payload-lexical**, **struct** adapters only |
| `src/publication/struct-adapter.ts` | 1320 | **projection** — `adaptStructDocument` (`:188`), `structPublicationAdapter` (`:1313`), `structDocumentToPublicationSourceResult` (`:1320`), `STRUCT_PUBLICATION_ADAPTER_ID = 'struct-document'` (`:24`), `STRUCT_PUBLICATION_MAPPING_VERSION = '1.0.0'` (`:25`) | yes (`:7`) — uses a **private local** `parsePublicationGraph` (`:104`) | this is the existing Struct→graph projection the cutover plan proposes to keep |
| `src/publication/research-paper-adapter.ts` | 322 | **bidirectional bridge** — `researchPaperToPublicationGraph` (`:81`), `publicationGraphToResearchPaper` (`:198`), `adaptResearchPaper` (`:298`), `researchPaperSourceAdapter` (`:317`) | yes (`:13`) | see §5 |
| `src/publication/adapters/astro.ts` | 611 | source adapter — `adaptAstroBlogEntry`, `astroPublicationAdapter` | yes (`:14`) | Astro blog entries → graph |
| `src/publication/adapters/payload-lexical.ts` | 1745 | source adapter — `adaptPayloadLexical`, `adaptPayloadLexicalEditions`, `payloadMappingPolicySchema` | yes (`:3`) | Payload JSON → graph |
| `src/publication/renderers/vivliostyle.ts` | 1208 | **render** — `publicationGraphToHtml` (`:508`), `createPublicationEpub` (`:793`), `publicationEpubAccessibilityMetadata` (`:724`), `publicationEpubTocHeadings` (`:678`), `renderEpubToc` (`:687`), `publicationEpubNavigationLabels` (`:711`), `publicationAssetFileExtension` (`:569`), `vivliostyleRenderer` (`:1081`), `PublicationReceipt` (`:109`) | yes (`:28-32`) | the only renderer of a graph |
| `src/publication/adapter-conformance.ts` | 544 | **conformance** — `canonicalPublicationSubset` (`:364`), `serializeCanonicalPublicationSubset` (`:368`), `canonicalPublicationSubsetSha256` (`:372`), `comparePublicationSemanticSubset` (`:376`), `canonicalPublicationGraph` (`:385`), `canonicalPublicationSourceResult` (`:401`), `publicationOutputReceiptContract` (`:444`), `comparePublicationOutputReceipts` (`:528`), `sourceReceiptHashes` (`:535`), `PUBLICATION_CONFORMANCE_VERSION` (`:6`) | yes (`:2`) | semantic-subset hashing, receipt contract |
| `src/publication/profiles.ts` | 289 | composition context — `COMPOSITION_CONTEXT_VERSION = '1.0.0'` (`:12`), `compositionContextSchema` (`:22`), `targetProfileToCompositionContext` (`:190`), `compositionContextToTargetProfile` (`:257`) | no | coupled to `src/research/targets.ts` `TARGET_PROFILE_IDS` (`:10`) |
| `src/publication/transformation-policy.ts` | 144 | `TRANSFORMATION_POLICY_VERSION = '1.0.0'` (`:3`), `transformationPolicySchema` (`:107`), `parseTransformationPolicy` (`:136`), `serializeTransformationPolicy` (`:142`) | no | — |
| `src/publication/output-contract.ts` | 11 | `PUBLICATION_CHECK_VERSION = '1.0.0'` (`:3`), `PUBLICATION_OUTPUT_POLICY_VERSIONS` (`:5-11`) | no | renderer policy versions |
| `src/publication/browser-runtime.ts` | 1565 | browser runtime snapshots (Playwright/Puppeteer) | no | — |
| `src/publication/toolchain.ts` | 412 | `PUBLICATION_TOOLCHAIN` (`:10`), `publicationToolchainForRuntime` (`:280`), `verifyPublicationToolchain` (`:320`), runtime evidence helpers | no | — |
| `src/publication/platform.mjs` | — | `publicationPlatformKey` | no | — |
| `src/publication/toolchain-manifest.json` | — | pinned toolchain manifest | no | — |

Tests in the same directory (kept separate in §8): `schema.test.ts`,
`source-adapter.test.ts`, `research-paper-adapter.test.ts`,
`adapter-conformance.test.ts`, `struct-adapter.test.ts`,
`asset-bundle.test.ts`, `profiles.test.ts`, `toolchain.test.ts`,
`transformation-policy.test.ts`, `renderers/vivliostyle.test.ts`,
`adapters/astro.test.ts`, `adapters/payload-lexical.test.ts`.

## 3. Consumers of the graph — actual importers

### 3a. `PublicationGraph` (the **type**)

| # | Importer | Line | Kind | Module role | Direction |
|---|---|---|---|---|---|
| G1 | `src/publication/schema.ts` | 888 | definition | definition | — |
| G2 | `src/publication/source-adapter.ts` | 15, 130 | type import | adapter contract | graph is the adapter **output** |
| G3 | `src/publication/research-paper-adapter.ts` | 10, 83, 199 | type import | bridge | both directions |
| G4 | `src/publication/renderers/vivliostyle.ts` | 28, 307, 323, 509, 724 | type import | renderer | graph is the renderer **input** |
| G5 | `src/publication/adapter-conformance.ts` | 2, 33, 36, 387 | type import | conformance | graph is hashed/compared |
| G6 | `src/annotations/annotation-bundle.ts` | 13 | **type-only** import, outside `src/publication/**` | annotation bundle | graph is the **annotation anchor authority** |
| G7 | `src/annotations/annotation-bundle.test.ts` | 10 | type-only import | test | — |

**`src/publication/struct-adapter.ts` does not import the `PublicationGraph`
type** — it imports `PUBLICATION_GRAPH_VERSION`, `publicationGraphSchema`,
`PublicationInlineRun`, `PublicationNode` (`:2-7`) and uses a private
`parsePublicationGraph` (`:104`).

### 3b. `publicationGraphSchema` (runtime value)

| # | Importer | Line(s) | Module role |
|---|---|---|---|
| S1 | `src/publication/schema.ts` | 412 (def), 892, 896 | definition |
| S2 | `src/publication/research-paper-adapter.ts` | 9, 172, 201 | bridge |
| S3 | `src/publication/source-adapter.ts` | 13, 180 | adapter contract |
| S4 | `src/publication/adapter-conformance.ts` | 2 | conformance |
| S5 | `src/publication/adapters/astro.ts` | 14, 567 | source adapter |
| S6 | `src/publication/adapters/payload-lexical.ts` | 3, 1646, 1726 | source adapter |
| S7 | `src/publication/struct-adapter.ts` | 7, 1254 | projection |
| S8 | `tools/publication-check.mjs` | 22, 1144 | CLI checker |
| S9 | `src/publication/schema.test.ts` | 2 | test |
| S10 | `src/publication/struct-adapter.test.ts` | 5 | test |
| S11 | `src/publication/adapter-conformance.test.ts` | 27 | test |

### 3c. `serializePublicationGraph` (runtime value)

| # | Importer | Line(s) | Module role |
|---|---|---|---|
| X1 | `src/publication/schema.ts` | 895 (def) | definition |
| X2 | `src/publication/source-adapter.ts` | 14, 155 | **receipt digest** |
| X3 | `src/publication/adapter-conformance.ts` | 2, 540 | **digest** |
| X4 | `src/publication/renderers/vivliostyle.ts` | 32, 1192 | **receipt digest + persisted artifact** |
| X5 | `tools/publication-build.mjs` | 29, 463, 997 | **CLI writer** |
| X6 | `tools/publication-check.mjs` | 23, 1162, 1354 | CLI checker |
| X7 | `src/publication/schema.test.ts` | 2 | test |
| X8 | `src/publication/adapter-conformance.test.ts` | 28, 494 | test |
| X9 | `src/publication/research-paper-adapter.test.ts` | 9, 21, 22, 30 | test |

### 3d. `parsePublicationGraph` (exported from `src/publication/schema.ts:891`)

**No importer was found.** The only same-named function outside `schema.ts` is
the *private* `parsePublicationGraph` in `src/publication/struct-adapter.ts:104`.
The exported parser is currently dead surface.

### 3e. Non-`src/publication` consumers of graph symbols

| # | Importer | Line | What it uses | Direction |
|---|---|---|---|---|
| N1 | `src/annotations/annotation-bundle.ts` | 13 | `type PublicationGraph` | graph → annotation anchors |
| N2 | `tools/publication-build.mjs` | 22-29 | `canonicalPublicationSubsetSha256`, `serializeAssetBundle`, `createDefaultPublicationAdapterRegistry`, `PUBLICATION_PROFILES`, `vivliostyleRenderer`, `serializePublicationGraph` | CLI build/writer |
| N3 | `tools/publication-check.mjs` | 22-23 | `publicationGraphSchema`, `serializePublicationGraph` | CLI check/writer |

**No importer of any graph symbol was found in `src/pages/`, `src/worker/`,
`src/components/`, `src/content/`, `src/layouts/`, `src/lib/`, `src/research/`
(except through the bridge) or `packages/`.**

## 4. Serialization, persistence, writers, routes

### 4a. Serialization

| Mechanism | Location | Output |
|---|---|---|
| `serializePublicationGraph` | `src/publication/schema.ts:895-897` | `JSON.stringify(publicationGraphSchema.parse(value))` — a **stable, schema-validated** JSON encoding |
| `serializeCanonicalPublicationSubset` | `src/publication/adapter-conformance.ts:368-370` | JSON of the *canonical semantic subset* (normalised ids/links, provenance stripped, `sourceDocumentVersion`/`created`/`modified`/`artifactModifiedAt` dropped — `:346-352`) |
| `canonicalPublicationSubsetSha256` | `:372-374` | sha256 of the above |
| `serializeAssetBundle` | `src/publication/asset-bundle.ts` | JSON of the asset descriptor |
| `serializeTransformationPolicy` | `src/publication/transformation-policy.ts:142` | JSON of the policy |
| `serializeLayoutManifest` | `src/research/manifest.ts:976` | **ResearchPaper-side** manifest (not a graph artifact) |

### 4b. Persistence — the graph **is** written to disk today

| Artifact | Location | Writer | Content |
|---|---|---|---|
| `publication-graph.json` | `src/publication/renderers/vivliostyle.ts:1107-1111` | `vivliostyleRenderer.render` (`:1081`), `writeFile(..., EXCLUSIVE_WRITE)` | `JSON.stringify(bundle.graph, null, 2)` |
| `asset-bundle.json` | `src/publication/renderers/vivliostyle.ts:1112-1116` | same | asset descriptor |
| `publication-receipt.json` | `src/publication/renderers/vivliostyle.ts:1201-1205` | same | `PublicationReceipt` (see §6) |
| `astro-route-parity.json` | `tools/publication-build.mjs:990-1019` | CLI | route parity + `graphSha256` |
| `publication-graph.json` (read back) | `tools/publication-check.mjs:1145` | CLI reader | parsed with `publicationGraphSchema` and re-hashed at `:1162` |

The renderer writes into a **fresh, invocation-owned output directory**
(`src/publication/renderers/vivliostyle.ts:1093-1106`: `mkdir(output)` and
fail on `EEXIST`), and `tools/publication-build.mjs:112-175` additionally
enforces that the output path is repository-local, not a symlink, git-ignored,
and published by atomic rename.

### 4c. Writers / build entry points

| Writer | Location | Adapter used | Notes |
|---|---|---|---|
| `tools/publication-build.mjs` (`npm run publication:build`) | `parsePublicationBuildArgs` (`:31-69`); registry at `:1053`; `registry.resolve(options.adapter, locator)` at `:1067`; output at `:1052`, receipt re-stamped at `:1023-1043` | `astro` and `payload-lexical` only — `--adapter` accepts only `astro`/`payload`→`payload-lexical` (`:54-67`) | `createDefaultPublicationAdapterRegistry()` also registers `struct`, but **the CLI cannot select it** — the option parser rejects any other adapter id |
| `src/publication/renderers/vivliostyle.ts` (`vivliostyleRenderer`) | `:1081-1207` | receives an already-resolved `PublicationBundle` | writes graph + assets + artifacts + receipt |
| `npm run publication:check` (`tools/publication-check.mjs`) | `:1144-1162`, `:1354` | re-parses the emitted `publication-graph.json` | compares `receipt.source?.graphSha256` to `sha256(serializePublicationGraph(graph))` |
| `npm run build:production` | `package.json` `build:production` | `--adapter astro --entry moving-to-cloudflare-with-astro` → `.agent/evidence/publication` | the only wired production build path for the graph pipeline |

### 4d. Routes

**No route, worker endpoint, or public HTTP surface consumes a
`PublicationGraph`.** Route inventory checked: `src/pages/**` (22 route
files), `src/worker/**`. The only graph-adjacent public routes are
ResearchPaper-side (§6 of the companion inventory):
`src/pages/papers/[id].astro`, `src/pages/papers/[id]/source.json.ts`,
`src/pages/papers/[id]/manifest.json.ts`,
`src/pages/papers/[id]/exports/[file].ts`.

## 5. The bidirectional ResearchPaper bridge

`src/publication/research-paper-adapter.ts` is **not** a facade that gates
all `ResearchPaper` imports — it is a **bidirectional** converter with
**four test importers and no production importer**
(`src/publication/research-paper-adapter.test.ts:8`,
`src/publication/source-adapter.test.ts:8`,
`src/annotations/move-parity.test.ts:2`,
`src/annotations/annotation-bundle.test.ts:11`).

### 5a. Forward — `researchPaperToPublicationGraph` (`:81-196`)

Projects ResearchPaper nodes → graph nodes (`heading`, `paragraph`, `quote`,
`caption`, `note`, `figure`), copies text and inline runs verbatim, maps
`paper.authors` → `metadata.contributors`, `paper.version` →
`metadata.sourceDocumentVersion`, and sets per-node
`provenance: { adapterId: 'research-paper', sourceId: node.source, evidence: [] }`
(`:47-51`). **`evidence` is always empty and `idOrigin` is never set.**

It **throws** (does not degrade) for: scholarly metadata extensions
(`authorNotes`/`authorAffiliations`/`affiliations`/`metadataLineage`, `:85-94`),
embedded note references (`:59-68`), legacy paragraph list context
(`:69-73`), and structured figure subtypes (`table`/`equation`, `:150-159`).

### 5b. Reverse — `publicationGraphToResearchPaper` (`:198-296`)

**This is the direction that matters for E-04.** It converts graph nodes back
into ResearchPaper nodes and rebuilds the paper envelope:

| Graph input | Reverse output | Line |
|---|---|---|
| `node.id` | `node.id` (semantic id minted from the graph) | `:207`, `:216`, `:224`, `:232`, `:242`, `:253` |
| `node.text` / `node.sourceText` | `node.text` / `node.sourceText` (canonical text minted from the graph) | `:210`, `:219`, `:228`, `:237`, `:246`, `:255` |
| `node.provenance.sourceId` | `node.source` | `:203` and each case |
| `graph.id` | `paper.id` | `:276` |
| `graph.metadata.sourceDocumentVersion` | `paper.version` | `:277` |
| `graph.metadata.status` | `paper.status` | `:278` |
| `graph.metadata.title` / `.subtitle` / `.contributors` | `paper.title` / `.subtitle` / `.authors` | `:279-281` |
| `graph.metadata.defaultLocale` (`'und'` → `undefined`) | `paper.language` | `:282-285` |
| `graph.metadata.defaultDirection` (`'auto'` → `'unknown'`) | `paper.baseDirection` | `:286-289` |
| `graph.metadata.created` / `.artifactModifiedAt` / `.modified` / `.abstract` | `paper.publicationDate` / `.artifactModifiedAt` / `.updated` / `.abstract` | `:290-293` |

It throws for `noteKind === 'author-note'` (`:239-240`) and for every node type
outside the ResearchPaper subset (`:268-271`).

**Callers of the reverse direction: `src/publication/research-paper-adapter.test.ts:6,17`
only.** The test asserts a lossless round trip:
`expect(publicationGraphToResearchPaper(graph)).toEqual(paper)`
(`src/publication/research-paper-adapter.test.ts:17`).

> **Concrete E-04 consequence:** the graph can currently act as a *second
> semantic writer* that produces canonical ids and canonical text for a
> ResearchPaper. ADR-0001 forbids a second graph that "owns independent text,
> semantic IDs, persistence, receipt, writer, or release path", and states
> that *"Renaming a full competing schema 'noncanonical' is insufficient."*
> The reverse converter plus its round-trip test are the two concrete
> artifacts that a "narrow" decision must remove or re-scope. **Neither has
> been removed; no decision has been made here.**

### 5c. Forward direction callers

`researchPaperToPublicationGraph` is called from `adaptResearchPaper`
(`:304`) and from **tests only**
(`src/publication/research-paper-adapter.test.ts:7,16,22,30,33,41`;
`src/publication/source-adapter.test.ts:7,54`;
`src/annotations/move-parity.test.ts:2,77`;
`src/annotations/annotation-bundle.test.ts:11,15,66,75,93,107,122,171,196,224,271,283,357,385`).

`adaptResearchPaper` (`:298-315`) is called from
`src/publication/source-adapter.test.ts:6,17,79` and from the
`researchPaperSourceAdapter` object (`:321`).

`researchPaperSourceAdapter` (`:317-322`) has **no importer**, and
`createDefaultPublicationAdapterRegistry()`
(`src/publication/adapter-registry.ts:55-60`) registers **only**
`astroPublicationAdapter`, `payloadLexicalSourceAdapter`, and
`structPublicationAdapter`. The ResearchPaper adapter is therefore
**not** reachable through the production registry or the CLI.

## 6. Receipt shapes, authority, and the pin-metadata gap

### 6a. `PublicationReceipt` — the **vivliostyle renderer** receipt

`src/publication/renderers/vivliostyle.ts:109-117`:

```ts
export type PublicationReceipt = {
  version: '1.0.0'
  source: { graphSha256: string; assetBundleSha256: string }
  profiles: typeof PROFILE_DETAILS
  policyVersions: typeof PUBLICATION_OUTPUT_POLICY_VERSIONS
  toolchain: ReturnType<typeof publicationToolchainForRuntime>
  repository: { commit: string; dirty: boolean }
  artifacts: ArtifactReceipt[]
}
```

- Constructed at `src/publication/renderers/vivliostyle.ts:1189-1200`;
  `source.graphSha256 = sha256(serializePublicationGraph(bundle.graph))`
  (`:1192`), `source.assetBundleSha256 =
  sha256(serializeAssetBundle(bundle.assetBundle))` (`:1193`).
- Written to `<output>/publication-receipt.json` (`:1201-1205`,
  `EXCLUSIVE_WRITE`).
- `repository.commit`/`dirty` are read from `git rev-parse HEAD` and
  `git status --short` at **render time** (`:1180-1188`) — note `dirty` here
  is a plain `boolean`, unlike the contract receipt below.
- `toolchain` comes from `publicationToolchainForRuntime(publicationBrowser)`
  (`:1197`) — the **browser/Vivliostyle toolchain**, not a Struct package pin.

### 6b. `PublicationContractReceipt` — the **source-adapter** contract receipt

`src/publication/source-adapter.ts:25-61` (schema) and `:63-65` (type):

```ts
{
  version: '1.0.0'                       // PUBLICATION_CONTRACT_RECEIPT_VERSION
  graphSha256: <sha256>                  // sha256(serializePublicationGraph(result.graph))
  assetBundleSha256: <sha256>            // sha256(serializeAssetBundle(result.assetBundle))
  contracts: {
    publicationGraph: '1.0.0'            // PUBLICATION_GRAPH_VERSION
    assetBundle: <ASSET_BUNDLE_VERSION>
    compositionContext: '1.0.0'          // COMPOSITION_CONTEXT_VERSION
    transformationPolicy: '1.0.0'        // TRANSFORMATION_POLICY_VERSION
    sourceAdapter: '1.0.0'               // PUBLICATION_SOURCE_ADAPTER_VERSION
    targetProfile: <TARGET_PROFILE_VERSION>
  }
  source?: {
    adapterId: string
    sourceType: 'astro'|'payload'|'docx'|'pdf'|'research-paper'
    mappingVersion?: string
  }
  toolchain: { node: string; packageLockSha256: <sha256> }
  repository: { commit: <40-hex>; dirty: false }   // dirty is z.literal(false)
}
```

- Produced by `createPublicationContractReceipt` (`:148-175`); `graphSha256`
  computed at `:155`.
- `toolchain.packageLockSha256` is the **app's own** `package-lock.json`
  digest — it is **not** a Struct package artifact digest and **not** a
  Struct package version pin.
- `contracts.sourceAdapter` is `PUBLICATION_SOURCE_ADAPTER_VERSION`
  (`'1.0.0'`) — the **app adapter** version, not a Struct package version.

### 6c. The pin-metadata gap (exact)

**Neither receipt contains any Struct package pin or Struct canonical
digest.** Concretely, across both receipt shapes the following are **absent**:

| Missing field | Where it would have to appear |
|---|---|
| Struct package name / version | `PublicationReceipt` (vivliostyle `:109-117`); `PublicationContractReceipt.contracts` (`source-adapter.ts:30-39`) |
| Struct package artifact/tarball SHA-256 | same |
| Struct `document` canonical digest | `PublicationReceipt.source`; `PublicationContractReceipt` top level (next to `graphSha256`) |
| Struct `receipt` canonical digest | same |
| Pinned approved Struct **revision** identity | same |

What *is* present instead is a **graph digest as the sole source identity**:
`PublicationReceipt.source.graphSha256` (`:111`) and
`PublicationContractReceipt.graphSha256` (`:28`).

### 6d. The shared output-receipt contract (used by the CLI tools)

`publicationOutputReceiptContract` (`src/publication/adapter-conformance.ts:444-526`)
is the **closed allowlist** that the CLI build/check path enforces:

- top-level allowed keys (`:447-455`): `version`, `source`, `profiles`,
  `policyVersions`, `toolchain`, `repository`, `artifacts` — anything else
  is **rejected** (`:456-462`).
- `source` allowed keys (`:464-475`): `adapterId`, `adapterVersion`,
  `sourceType`, `sourceId`, `sourceRevision`, `mappingVersion`,
  `graphSha256`, `assetBundleSha256`, `canonicalSubsetSha256`, `routeParity`.
- required `source` strings (`:485-494`): `adapterId`, `adapterVersion`,
  `sourceType`, `sourceId`, `graphSha256`, `assetBundleSha256`,
  `canonicalSubsetSha256`, `routeParity`.
- `sourceReceiptHashes` (`:535-544`) returns `sourceType`, `sourceId`,
  `sourceRevision`, `graphSha256`, `assetBundleSha256`,
  `canonicalSubsetSha256` — again **no Struct digest**.

**Concrete consequence:** adding a Struct digest or a Struct package pin to a
receipt today would be *rejected* by `publicationOutputReceiptContract` as an
"unsupported output receipt key" (`:456-462`, `:476-483`). Any future change
that binds receipts to Struct must widen this allowlist **deliberately** —
it cannot be added additively without touching this function.

### 6e. Current callers of the two receipt factories

| Factory | Callers |
|---|---|
| `createPublicationContractReceipt` | `src/publication/source-adapter.test.ts:11,87,88,103`; `src/publication/adapter-conformance.test.ts:34,94,95` — **tests only** |
| `PublicationReceipt` construction | `src/publication/renderers/vivliostyle.ts:1189` (production renderer) |
| `publicationOutputReceiptContract` | `tools/publication-check.mjs` (via the CLI check path); `src/publication/adapter-conformance.test.ts` |

## 7. Graph-based annotation anchors

`src/annotations/annotation-bundle.ts` is the only module **outside**
`src/publication/**` that binds anything to graph nodes.

| Element | Location | Behavior |
|---|---|---|
| `import type { PublicationGraph } from '../publication/schema'` | `:13` | **type-only** — no runtime dependency on the graph schema |
| `ANNOTATION_BUNDLE_VERSION = '1.1.0'` / `LEGACY_ANNOTATION_BUNDLE_VERSION = '1.0.0'` | `:15-16` | bundle versions |
| `annotationBundleSchema` | `:18-61` | `{ version, graphId, anchors[], annotations[] }`, strict; unique anchor ids and unique annotation ids |
| `graphId` | `:24` | the bundle records the **graph id** as its document identity |
| `createAnnotationBundle(graph, annotations, anchors?)` | `:65-140` | builds the bundle from a graph |
| `nodesById` map | `:76` | every anchor must resolve to a **graph node id** |
| `documentNodes` | `:77-88` | per-node text extracted from the graph: `node.text`, or `node.code` for `code`, or `node.source` for `equation` |
| anchor resolution | `:89-128` | for `anchor.nodeId === DOCUMENT_SCOPE_NODE_ID`, the whole-document anchor must resolve; otherwise the anchor's node must exist in `graph.nodes` (`:96-101`) and the quoted text must match the **graph node's** text exactly (`:112-127`) |
| `serializeAnnotationBundle` | `:143-145` | JSON of the validated bundle |
| test assertion | `src/annotations/annotation-bundle.test.ts:84` | `expect(serializeAnnotationBundle(read)).not.toContain('"graph":')` — the bundle deliberately carries only `graphId`, **not** the graph |

**Authority direction:** the graph is the **anchor authority** here — the
annotation bundle's anchors are graph-node-id scoped and quote-matched against
graph node text. The ResearchPaper is the anchor authority on the other side
(`src/annotations/annotations.ts:20,29` — `createDemoAnnotations(paper)`).

**Callers of `createAnnotationBundle`: tests only**
(`src/annotations/annotation-bundle.test.ts:40,42,65,74,92,106,141,171,196,224,271,327,357,385`;
`src/annotations/move-parity.test.ts:76`). No route, worker, or storage path
consumes an annotation bundle today.

**The two anchor models therefore disagree about what an anchor is anchored
to**, and the only place they are reconciled is
`src/annotations/move-parity.test.ts` and
`src/annotations/annotation-bundle.test.ts` — both of which obtain a graph by
calling `researchPaperToPublicationGraph(paper)`. That is the concrete
coupling point between the legacy model and the graph model, and it is
test-only.

## 8. Current red baseline vs. the desired one-way Struct-derived projection

### 8a. What ADR-0001 and the issue plan require (target)

ADR-0001, §"History-preserving moves and duplicate disposition":

> `src/publication` semantic graph | Transitional/possibly superseded |
> Derive an app-private projection from approved Struct or retire competing
> semantics | Publishing facade and production call-path migration

ADR-0001, §"Decision":

> `src/publication` is transitional. Generic compilation mechanics that remain
> app-specific may stay behind the publishing facade. **Any second graph
> competing with `StructDocument` must be retired or narrowed to an
> ephemeral, mechanically derived renderer plan from one pinned approved Struct
> revision. Such a plan owns no independent text, semantic IDs, persistence,
> receipt, writer, or release path. Renaming a full competing schema
> "noncanonical" is insufficient.**

E-04 acceptance (issue plan `:361-368`):

> `PublicationGraph` is retired or narrowed to an ephemeral, mechanically
> derived renderer plan from one pinned approved Struct revision. It owns no
> independent text, semantic IDs, persistence, receipt, writer, or release
> path; a renamed full schema is not accepted.

The app cutover plan §E-04 recommends **narrow**, with a proof obligation, and
lists the proof obligations (read-only; reproduced here for traceability, not
as an implementation claim):

1. Keep `src/publication/struct-adapter.ts` as a deterministic
   `StructDocument -> PublicationGraph` projection used only for
   print/Vivliostyle rendering.
2. Conformance test: adapting one pinned `StructDocument` twice yields a
   byte-identical graph, and the graph is never persisted or treated as
   canonical text authority.
3. Red-first static assertion that `PublicationGraph`,
   `publicationGraphSchema`, `serializePublicationGraph`, and any graph
   persistence/import/export helper are absent from storage, API, route,
   writer, and release modules; only renderer/projection modules may import
   them.
4. Bind publication receipts to the Struct `document`/`receipt` digests and
   the exact package pin; graph-only digests are diagnostic only.

### 8b. The concrete current red baseline (observed)

| # | Red condition (ADR-0001 wording) | Observed today | Evidence |
|---|---|---|---|
| R1 | "owns no independent **text**" | the graph has its own `text`/`sourceText`/`code`/`source` fields, its own `metadata` envelope, and its own 14-kind node taxonomy | `src/publication/schema.ts:172-315`, `:372-387` |
| R2 | "owns no independent **semantic IDs**" | the graph has its own id grammar — **distinct and stricter** than ResearchPaper's — but the two namespaces are **not disjoint**: the bridge copies `node.id` verbatim in every node case (`src/publication/research-paper-adapter.ts:207`, `:216`, `:224`, `:232`, `:242`, `:253`), and the round-trip test asserts that graph ids equal the source paper ids (`src/publication/research-paper-adapter.test.ts:18-20`) | `src/publication/schema.ts:7-11` vs `src/research/schema.ts:3` |
| R3 | "owns no **persistence**" | `publication-graph.json` is written to the render output directory on every render | `src/publication/renderers/vivliostyle.ts:1107-1111`; read back at `tools/publication-check.mjs:1145` |
| R4 | "owns no **receipt**" | both receipt shapes bind the **graph digest as the source identity** | `src/publication/renderers/vivliostyle.ts:111`, `:1192`; `src/publication/source-adapter.ts:28`, `:155` |
| R5 | "owns no **writer**" | `vivliostyleRenderer.render` writes the graph file, the asset bundle, the artifacts, and the receipt; `tools/publication-build.mjs` orchestrates the renderer, directly writes only `astro-route-parity.json`, and re-stamps the renderer-produced receipt | `src/publication/renderers/vivliostyle.ts:1107-1116`, `:1201-1205`; `tools/publication-build.mjs:463`, `:990-1019`, `:1022-1043`, `:1077-1080` |
| R6 | "owns no **release path**" | `npm run build:production` runs `publication:build` + `publication:check` on the graph pipeline | `package.json` `build:production` |
| R7 | "mechanically derived from one pinned approved Struct revision" | the graph is produced by **three** independent adapters (astro, payload-lexical, struct) with no shared pinned Struct revision; the canonical-subset mechanism (`:364-399`) exists to make *two different adapters* comparable — the opposite of one pinned source | `src/publication/adapter-registry.ts:55-60`; `src/publication/adapter-conformance.ts:364-399` |
| R8 | "narrow … to an ephemeral renderer plan" | the graph has a **public schema module** with its own version constant, exported parser/serializer, a 10,000-node cap and a 1,000,000-char text cap | `src/publication/schema.ts:3-5`, `:412`, `:891-897` |
| R9 | reverse writer | `publicationGraphToResearchPaper` converts graph nodes/text/ids back into a ResearchPaper, and a test asserts the round trip | `src/publication/research-paper-adapter.ts:198-296`; `src/publication/research-paper-adapter.test.ts:17` |
| R10 | graph-anchored annotation authority | `createAnnotationBundle` anchors annotations to graph node ids and graph node text; only `graphId` is persisted, but the anchor semantics are graph-owned | `src/annotations/annotation-bundle.ts:13,24,65-140` |
| R11 | no Struct digest / package pin in receipts | neither receipt shape carries a Struct package pin, artifact digest, `document` digest, or `receipt` digest | `src/publication/renderers/vivliostyle.ts:109-117`; `src/publication/source-adapter.ts:25-61` |
| R12 | receipt allowlist blocks Struct bindings | `publicationOutputReceiptContract` rejects unknown receipt/source keys, so Struct bindings cannot be added additively | `src/publication/adapter-conformance.ts:456-462`, `:476-483` |

**Counter-facts that must not be overstated** (things that are *not* red):

- The graph has **no public route and no worker endpoint** (§4d).
- The ResearchPaper adapter is **not registered** in the default registry and
  **not selectable** by the CLI (§5c, §4c).
- `parsePublicationGraph` (exported) has **no importer** (§3d).
- `createPublicationContractReceipt` has **no production caller** (§6e).
- `createAnnotationBundle` has **no production caller** (§7).

So the graph is *currently* a build-time, CLI-and-renderer artifact — but it is
**live code**, not retired: it has a schema module, a registry entry
(`struct`), a renderer input, a persisted file, and a place in the production
build script.

### 8c. The desired end state (target, not implemented)

```
one pinned approved Struct revision (approved + pinned)
        │  (app-private projection, one direction only)
        ▼
PublicationGraph as an EPHEMERAL renderer plan
        │  in-memory only; no write of publication-graph.json
        │  no reverse conversion to ResearchPaper
        ▼
vivliostyle renderer  ──►  receipt binding:
                            { structDocumentSha256, structReceiptSha256,
                              structPackageName, structPackageVersion,
                              structPackageArtifactSha256, ... }
                            graphSha256 retained as DIAGNOSTIC ONLY
```

### 8d. Existing graph digests: diagnostic-only is a **target**, not the current state

The cutover plan requires: *"do not treat an independent graph digest as the
semantic authority. Receipts must include the canonical Struct digests and
exact package pin/version; graph-only digests are diagnostic only."*

**Current reality, stated plainly:**

- `graphSha256` is **not** diagnostic today. It is the **primary and only**
  source binding in `PublicationReceipt` (`src/publication/renderers/vivliostyle.ts:111`,
  `:1192`) and in `PublicationContractReceipt`
  (`src/publication/source-adapter.ts:28`, `:155`).
- `canonicalSubsetSha256` is **required** by the shared output-receipt
  contract (`src/publication/adapter-conformance.ts:489`, `:494`), and the
  CLI check compares `receipt.source?.graphSha256` to a freshly computed
  `sha256(serializePublicationGraph(graph))` (`tools/publication-check.mjs:1162`).
- **No Struct digest and no Struct package pin exist in any receipt.** There
  is therefore nothing today that could be "diagnostic-only" — the demotion
  target requires **adding** the Struct bindings first, and **then**
  demoting the graph digests.

> **This document does not claim that any of the four proof obligations in
> §8a is implemented.** None of them exists in the repository today:
> (1) `src/publication/struct-adapter.ts` exists but is **not** restricted to
> Struct-only production use — `astro` and `payload-lexical` adapters also
> produce graphs and are the two the CLI can actually select; (2) no
> byte-identical double-adapt conformance test for a pinned `StructDocument`
> was found; (3) the red-first static assertion does **not** exist (see §9);
> (4) receipt Struct bindings do **not** exist and the receipt allowlist
> would currently reject them.

## 9. Exact gates that a future E-04 change must satisfy

These are the **required** gates, derived from ADR-0001, the E-04 issue
acceptance, and the app cutover plan, cross-referenced to the concrete
artifacts that must change. **None of them is implemented or verified here.**
Every row is **PENDING**, and the cutover plan's "E-04 future gates" table
mirrors these rows as pending obligations; nothing in this table is a runtime,
golden, receipt, or activation result.

| # | Gate (required) | Concrete artifact that must change | Current status |
|---|---|---|---|
| G-01 | `PublicationGraph` is narrowed to an ephemeral, mechanically derived renderer plan from **one pinned approved Struct revision** | `src/publication/adapter-registry.ts:55-60` (drop/limit `astro` + `payload-lexical` graph production), `tools/publication-build.mjs:54-67` (`--adapter` allowlist), `src/publication/adapters/astro.ts`, `src/publication/adapters/payload-lexical.ts` | not done |
| G-02 | The graph owns **no independent text** | `src/publication/schema.ts:172-315`, `:372-387` (text-bearing fields), `src/publication/research-paper-adapter.ts:198-296` (reverse text minting) | not done |
| G-03 | The graph owns **no independent semantic IDs** | `src/publication/schema.ts:7-11` (own id grammar) — a narrowed plan must derive ids from the pinned Struct revision | not done |
| G-04 | The graph owns **no persistence** | delete/disable `src/publication/renderers/vivliostyle.ts:1107-1111`; and the reader at `tools/publication-check.mjs:1145` | not done |
| G-05 | The graph owns **no receipt** | `src/publication/renderers/vivliostyle.ts:109-117` + `:1189-1200`; `src/publication/source-adapter.ts:25-61` + `:148-175`; and the allowlist in `src/publication/adapter-conformance.ts:447-494` must be widened **deliberately** to accept the Struct bindings | not done |
| G-06 | The graph owns **no writer** and **no release path** | `tools/publication-build.mjs` (`package.json` `build:production`); `src/publication/renderers/vivliostyle.ts:1081-1207` | not done |
| G-07 | No reverse graph→ResearchPaper writer | `src/publication/research-paper-adapter.ts:198-296` and the round-trip assertion at `src/publication/research-paper-adapter.test.ts:17` | not done |
| G-08 | Red-first static assertion: `PublicationGraph`, `publicationGraphSchema`, `serializePublicationGraph`, and graph persistence helpers are **absent** from storage / API / route / writer / release modules; only renderer/projection modules may import them | extend `tests/struct-adapter-boundary.test.ts` (AST harness at `:12-55`) to the `src/publication/**` + route/worker/writer roots | **does not exist** |
| G-09 | Byte-identical double-adapt conformance for one pinned `StructDocument`, plus an assertion that the graph is never persisted or treated as canonical text | `src/publication/struct-adapter.ts:188` (`adaptStructDocument`), `src/publication/struct-adapter.test.ts` | not found |
| G-10 | Receipts carry the canonical Struct digests and the exact package pin/version; graph digests demoted to diagnostic | `src/publication/renderers/vivliostyle.ts:109-117`; `src/publication/source-adapter.ts:25-61`; `src/publication/adapter-conformance.ts:447-494`; the CLI check at `tools/publication-check.mjs:1162` | not done |
| G-11 | `ResearchPaper` stays a read-only compatibility model; a checked-in caller/test inventory exists for `src/publication/research-paper-adapter.ts` | [`docs/struct-research-paper-caller-inventory.md`](struct-research-paper-caller-inventory.md) (companion doc, same tree after the inventory merge) | inventory **exists** (companion doc; grep-bounded, not compiler-proven); read-only enforcement not done |
| G-12 | EPUBCheck / Ace / human-accessibility acceptance stays app-owned | `src/publication/renderers/vivliostyle.ts:724` (`publicationEpubAccessibilityMetadata`), `src/research/publication-integrity.ts` | app-owned today |
| G-13 | Legacy `research/epub.ts` overloads keep both-mode parity until the last `ResearchPaper` consumer migrates | `src/research/epub.ts:133-141`, `:1422-1447`, `:2094-2118` | parity **not demonstrated** here |
| G-14 | E-07 deletion gates: zero production imports to removed portable modules; package-only app tests; retained-compatibility register with owner, caller inventory, warning/horizon, removal issue | `src/struct/**`, `src/struct-adapters/**` | not done |

## 10. Tests and frozen fixtures (kept separate from production callers)

### 10a. In-package tests

| File | What it pins |
|---|---|
| `src/publication/schema.test.ts` | `publicationGraphSchema` accept/reject matrix; `serializePublicationGraph` determinism (`:203-205`); node-type and profile rules |
| `src/publication/source-adapter.test.ts` | `researchPaperSchema` parse, `adaptResearchPaper`, `createPublicationContractReceipt` determinism (`:87-88`) and `dirty` failure (`:103`) |
| `src/publication/research-paper-adapter.test.ts` | forward determinism (`:16-22`), **reverse round-trip equality (`:17`)**, unsupported-subset throws (`:33`, `:41`) |
| `src/publication/adapter-conformance.test.ts` | cross-adapter semantic-subset equality (`astro` vs `payload`, `:94-95`), canonical-graph equality (`:906`, `:915`), output-receipt contract (`:1031`, `:1044`) |
| `src/publication/struct-adapter.test.ts` | Struct→graph projection validity (`:333`, `:658`, `:810`) |
| `src/publication/asset-bundle.test.ts` | asset descriptor/bundle contract |
| `src/publication/profiles.test.ts` | composition context ↔ `src/research/targets.ts` target profiles |
| `src/publication/toolchain.test.ts` | toolchain manifest/runtime |
| `src/publication/transformation-policy.test.ts` | transformation policy contract |
| `src/publication/renderers/vivliostyle.test.ts` | renderer behaviour (imports `adaptAstroBlogEntry` at `:25` and the browser runtime at `:35`) |
| `src/publication/adapters/astro.test.ts` | Astro adapter (`:12`, `:16`) |
| `src/publication/adapters/payload-lexical.test.ts` | Payload adapter (`:2-5`) |

### 10b. Out-of-package tests that touch the graph

| File | Graph usage |
|---|---|
| `src/annotations/annotation-bundle.test.ts` | `researchPaperToPublicationGraph` (`:11`, and 14 further call sites), `type PublicationGraph` (`:10`) |
| `src/annotations/move-parity.test.ts` | `researchPaperToPublicationGraph` (`:2`, `:77`), `createAnnotationBundle` (`:76`) |
| `tools/publication-check.test.mjs` | `publicationGraphSchema` (`:15`), `serializePublicationGraph` (`:16`), `:839-840` |
| `tools/publication-build.test.mjs` | CLI build behaviour (no direct graph import observed) |

### 10c. Frozen fixtures

| Path | Content |
|---|---|
| `tests/fixtures/payload/publication.json` | frozen Payload source input (`src/publication/adapters/payload-lexical.test.ts:2`) |
| `tests/fixtures/payload/mapping.json` | frozen Payload mapping (`:3`; `src/publication/adapter-conformance.test.ts:6`) |
| `tests/fixtures/payload/equivalent-publication.json` | frozen equivalence fixture (`src/publication/adapter-conformance.test.ts:5`) |
| `tests/fixtures/payload/README.md` | fixture provenance notes |
| `tests/fixtures/publication/astro/synthetic-publication.mdx` | Astro adapter fixture |
| `tests/fixtures/publication/astro/payload-equivalent.mdx` | cross-adapter equivalence fixture |
| `tests/fixtures/publication/astro/unsupported-component.mdx` | negative fixture |
| `tests/fixtures/publication/astro/fixture-image.svg` | asset fixture |
| `tests/fixtures/struct-adapter-parity/observe.ts` | Struct parity observer (`buildStructEpub` at `:7`, `:89`) |
| `tests/fixtures/struct-adapter-parity/reconstructions/` | frozen reconstruction inputs |
| `tests/fixtures/struct-package-parity/` | frozen package-parity inputs |
| `src/research/papers/*.json` (2 files) | the two shipped ResearchPaper documents |

**No golden was regenerated, compared, or re-baselined while producing this
document.**

## 11. Unresolved / not proven by this inventory

1. **No compiler-level import proof.** All "absent from route/writer/release
   modules" statements are grep-bounded (§"Scan scope and limitations"). The
   AST harness needed to make them compiler-proven is
   `tests/struct-adapter-boundary.test.ts` and it is not currently extended to
   these roots, and it could not be executed here (no `node_modules`).
2. **`tools/publication-build.mjs` `--adapter` allowlist** rejects
   `struct`, so the Struct projection has **no CLI entry point** today. The
   exact intent of that restriction was not derived from any issue or plan in
   this repository; it is reported as observed.
3. **`src/publication/adapters/astro.ts` and `payload-lexical.ts` are large**
   (~600 and ~1730 lines). Their exact semantic overlap with the Struct
   projection was not measured; whether they can be retired under a "narrow"
   decision is an open question, not a finding.
4. **`publicationGraphSchema` is 897 lines with ~460 lines of
   `.superRefine`** (`:427-886`). The cost of replacing it with a narrowed
   plan was not estimated.
5. **The two anchor models** (graph-anchored `annotation-bundle.ts` vs
   paper-anchored `annotations.ts`) are reconciled only in tests. Whether the
   durable annotation model should be graph-anchored, Struct-anchored, or
   paper-anchored after E-04 was **not** decided here.
6. **`canonicalPublicationSubsetSha256`** is the closest existing thing to a
   semantic digest, but it is a digest **of the graph's own canonical
   projection** (normalised ids, provenance stripped, revision fields
   dropped — `src/publication/adapter-conformance.ts:336-361`). It is not a
   Struct digest, and it depends on the graph remaining the canonical
   intermediate.
7. **No runtime/golden/receipt evidence was produced.** Nothing was built,
   rendered, hashed, or compared.
8. **The `struct` registry entry is live but unreachable from the CLI**
   (`src/publication/adapter-registry.ts:59`), so the Struct→graph projection
   has no production writer in the current scripts. Whether that is a
   deliberate interim state or a gap was not determined from the repository.
