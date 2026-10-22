# E-03 Implementation Record — 2026-10-20

Owner: `erniesg/erniesg` (E-03 IMPLEMENTATION owner for `erniesg/struct` app cutover)
Branch: `e03/boundary-guard-round7` (local round-7 boundary-guard branch, based on the PR #454 head `9daf2b1e`;
the E-03 content was originally
carried on `feat/struct-e03-core-codecs-ids-order-20261020`)
Worktree: `/home/ubuntu/.local/state/struct-migration/20261020-continuation/worktrees/app-e03-guard-round7`
Precondition: E-02 passed (`feat/struct-e03-core-codecs-ids-order-20261020` exists with commits).
Guard state described by this record: `dc117894` ("test(struct): scan MDX expressions, export assignments and Astro script ASTs").
**This record describes the tree as of that guard commit.** The record's own commit comes later on the same
branch and changes only this document, so the guard state described here does not move with it; the record therefore
names the guard commit, and never a branch tip, as the state it describes.

## What was done
- Switched production imports exactly as the E-03 mapping table requires:
  - `types` family → `@erniesg/struct/document`
  - `ids` family → `@erniesg/struct/identity`
  - `reading-order` family → `@erniesg/struct/ordering`
  - `codec` family: adopted package `decodeCompatibleStructDocument` naming (no deprecated `migrateStructDocument` used in production)
- Production consumers switched (all non-test modules under `src/`):
  `src/publication/struct-adapter.ts`, `src/struct-adapters/from-reconstruction.ts`,
  `src/research/epub.ts`, `src/research/reconstruction-materialization.ts`,
  `src/research/reconstruction-attempt-trace.ts`, `src/research/grounded-epub-comparison.ts`,
  `src/research/grounded-struct-materializer.ts`, `src/research/grounded-struct-repair-applicator.ts`.
- The local portable MODULE implementations (`src/struct/types.ts`, `src/struct/ids.ts`, `src/struct/codec*`,
  `src/struct/reading-order.ts`) are kept physically unchanged; their tests remain green.
  `src/struct-adapters/recovery.ts` is NOT one of them and is NOT kept physically unchanged: at the guard state
  described in this section it is changed by 78 lines (`git diff --stat 5f8c76ab dee1f860 -- src/struct-adapters/recovery.ts`
  -> 34 insertions, 44 deletions; the same measurement holds at `79c0d7c5` and at `64209924`). Exactly what changed in it
  is recorded under "Runtime recovery delegations and guard hardening" below.
  `src/struct-adapters/from-reconstruction.ts` is a CONSUMER of those families, not one of them: its imports were
  re-pointed at the package subpaths in this step, and its module body is otherwise unchanged.
- `src/research/epub.ts` `import type { StructDocument }` switched in E-03; renderer-branch switch (`../struct/xhtml` / `../struct/epub` → package renderers) stays in E-04 and was NOT done.
- `src/struct/recovery.ts` stays a compatibility forwarder to `src/struct-adapters/recovery.ts`; the app's enriched `recoverySummary` was NOT replaced by the package generic copy.
- `src/struct/codec*` local modules kept; no new production semantics added to retained copies.
- `src/struct/sha256.ts`, `src/research/sha256-sync.ts`, `legacyStructDigest`, model-consultation modules, and `src/struct/recovery.ts` were not migrated (per "Not migrated" list).

## Runtime recovery delegations and guard hardening (guard state at `dc117894`, with earlier heads marked inline)

This section records the E-03 scope that the restack added on top of the dated candidate measurement recorded below.
It describes the guard state at the commit that last changed the guard, `dc117894` ("test(struct): scan MDX
expressions, export assignments and Astro script ASTs"), which is the state of `tests/struct-adapter-boundary.test.ts`
in the reviewed tree; the guard runs of this section were measured in the round-7 worktree
`/home/ubuntu/.local/state/struct-migration/20261020-continuation/worktrees/app-e03-guard-round7`. Bullets whose
measurements were taken at an earlier head say so inline. This record describes the tree **as of that guard
commit**; it does not name a branch tip as the reviewed head, because the record's own commit moves that tip. The guard
commits included in the reviewed tree are the thirteen listed under "Boundary-guard hardening" below, and each of them is
an ancestor of the branch that carries this record.

- **Category delegation** - source unit `554ce8e2` ("fix(struct): make the package recovery category authoritative at
  runtime"), replayed onto this branch as `0aef7178`. `src/struct-adapters/recovery.ts` imports the package runtime
  export (`:6-9`, `diagnosticCategory as packageDiagnosticCategory`), drops the local `category` column from all 37
  `DIAGNOSTIC_COPY` entries (`:37-241`) and from `FALLBACK_COPY` (`:243-249`) - both are now typed
  `AppDiagnosticCopy = Omit<DiagnosticCopy, 'category'>` (`:21`) - and turns the app facade into a delegation:
  `diagnosticCopy` derives the category from the package (`:261-267`), `diagnosticCategory` is
  `return packageDiagnosticCategory(code)` (`:269-271`), and the unknown-code default `UNKNOWN_CODE_CATEGORY` is read
  from the package (`:257-259`). The app keeps its titles, messages and actions; the package is the single runtime
  category authority.
- **Actionable-recovery delegation** - source unit `d192642d` ("fix(struct): delegate the actionable-recovery predicate
  to the package export"), replayed onto this branch as `4213ff4f`. The same file imports
  `hasActionableRecovery as packageHasActionableRecovery` (`:6-9`) and `hasActionableRecovery` is now
  `return packageHasActionableRecovery(recovery)` (`:414-418`); the old local `Boolean(recovery?.userAction)` rule is
  gone. The exported signature and the type guard `recovery is StructRecovery & { userAction: string }` are
  unchanged, so no app caller changes.
- **Boundary-guard hardening** - commits `fc73a970` ("test(struct): resolve aliased imports and pin the package recovery
  facts"), `5974df05` ("test(struct): guard the E-03 recovery authorities in the boundary test"), `a99a0f86` ("test(struct):
  add the E-03 guard red-first cases"), `36916381` ("test(struct): close the E-03 boundary guard gaps"), `e9009551`
  ("test(struct): close the E-03 guard alias and MDX gaps"), `7907acff` ("test(struct): close the E-03 guard MDX, CommonJS,
  wrapper and render gaps"), `f6866e41` ("test(struct): close the E-03 guard MDX multiline and Vite glob gaps"),
  `79c0d7c5` ("test(struct): resolve E-03 Vite glob patterns against the importing module"), `dee1f860` ("test(struct):
  close the seven E-03 boundary-guard findings"), `fb1250a0` ("test(struct): give the E-03 boundary guard explicit
  timeouts and one shared analysis"), `d886ddcf` ("test(struct): close the six E-03 boundary-guard findings of round 6"),
  `a832b8ed` ("test(struct): scan Astro template expressions for imports") and `dc117894` ("test(struct): scan MDX
  expressions, export assignments and Astro script ASTs"). These thirteen are the guard commits
  included in the reviewed tree.
  `d886ddcf` is the replay of the round-6 unit's `b3beed76` onto `fb1250a0`: the expected conflict in the
  `reexportSpecifiers` region was resolved by keeping `fb1250a0`'s `reexportSpecifierCache` wrapper and its
  `computeReexportSpecifiers` rename while taking the round-6 body, its four helpers
  (`importedBindingModules`, `commonJsReexportSpecifier`, `isCommonJsExportTarget`, `hasExportModifier`) and all six
  round-6 cases. Nothing else conflicted, and the describe-block change is a pure append.
  `tests/struct-adapter-boundary.test.ts` grows from 5 cases (386 lines) at the base `5f8c76ab`, to 7 cases (584 lines)
  at `fc73a970`, to 8 cases (689 lines) at `5974df05` (the same state the record commit `64e6774b` carries), to 11 cases
  (788 lines) at `a99a0f86`, to 13 cases (1053 lines) at `36916381` (the same state the record commit `64209924`
  carries), to 15 cases (1215 lines) at `e9009551`, to 19 cases (1607 lines) at `7907acff`, to 21 cases (2010 lines) at
  `f6866e41`, to 22 cases (2090 lines) at `79c0d7c5` (the same state the record commit `8411b8c5` carries), to 28 cases
  (2615 lines) at `dee1f860`, to 28 cases (2717 lines) at `fb1250a0`, to 34 cases (3137 lines) at `d886ddcf`, to
  35 cases (3274 lines) at `a832b8ed`, and to 39 cases (3642 lines) at `dc117894`. Every count is
  `grep -c "^  it("` on the file at that commit and every line
  count is `wc -l` on it.
  **The complete reviewed set is closed - thirty-eight reviewed items.** The enumeration and the count are the same
  thing, and each item names the commit that closed it:
  - The ten reviewed gaps of the first review of PR #454: (1) aliased local imports resolved before skipping -
    `fc73a970`; (2) package recovery-fact parity check importing `@erniesg/struct/recovery` - `fc73a970`; (3) project-root
    imports of migrated families rejected - `a99a0f86`; (4) recovery importer allowlist enforced - `a99a0f86` (the
    new-importer case) and `36916381` (the allowlist inside the retained tree); (5) decoder and renderer validation split
    covered - `36916381`; (6) MDX modules included in the scan - `a99a0f86`; (7) nested imports from the local codec
    family rejected - `a99a0f86`; (8) implementation record for the dependency override - the record commits `64209924`
    and `b6b150f3`; (9) computed dynamic imports rejected - `a99a0f86`; (10) CommonJS imports inspected - `a99a0f86`.
  - The two (F14) assertions of the same review: (11) the production recovery module imports `diagnosticCategory` from
    `@erniesg/struct/recovery` - `5974df05`; (12) the app `hasActionableRecovery` is a delegation to the package runtime
    export - `5974df05`.
  - The two findings of the guard re-review: (13) consecutive leading MDX import statements are collected -
    `e9009551`; (14) every spelling of the compatibility recovery forwarder is rejected - `e9009551`.
  - The five findings of round 3: (15) MDX ESM flow blocks are collected wherever they appear in the document -
    `7907acff`; (16) computed CommonJS requires are rejected - `7907acff`; (17) the package EPUB renderer and the app's
    own render paths are exercised - `7907acff`; (18) retained-tree wrapper re-exports are traced - `7907acff`; (19) the
    dated record is updated after the final guard change - `8411b8c5`.
  - The two findings of round 4: (20) a multiline MDX import declaration is read until the parser recognises it -
    `f6866e41`; (21) Vite glob imports are inspected - `f6866e41`, with the canonical `'./'`-relative spelling of a Vite
    glob pattern resolved against the directory of the importing module at `79c0d7c5`.
  - The seven findings of round 5: (22) a project-root or alias Vite glob pattern is normalised before matching -
    `dee1f860` (this one finding covers both spellings, the project-root-absolute one and the alias one); (23) the
    two-step form of a retained wrapper that re-exports an imported binding is followed - `dee1f860`; (24) a Vite worker
    entry module is inspected - `dee1f860`; (25) a local Astro script `src` is inspected - `dee1f860`; (26) a transitive
    path to the recovery authority is a violation for a module outside the retained tree - `dee1f860`; (27) a retained
    wrapper stored as a CommonJS TypeScript module is resolved - `dee1f860`; (28) the cutover plan's stale current-state
    recovery description is corrected - `dee1f860` (a document finding, not a guard gap).
  - The six findings of round 6: (29) a CommonJS re-export form in a retained wrapper
    (`module.exports = require('./types')` and the equivalent property form `exports.types = require(...)`) is traced,
    so an external import of such a wrapper is reported - `d886ddcf` (replaying the unit's `b3beed76`); (30) an
    explicit extension on an imported retained MDX wrapper is normalised before the wrapper traversal, so the chain is
    followed - `d886ddcf`; (31) the retained barrel is considered as a glob candidate of its own, so an eager glob over
    the retained tree is reported - `d886ddcf`; (32) an MDX ESM block that names no module is preserved for the AST
    scan, so a module-free declaration is not silently dropped from the reduction, while a fenced or indented code
    sample is still not collected as a real import - `d886ddcf`; (33) an export declaration that aliases an imported
    binding is traced to the imported module, in the named, exported-variable and default-export forms - `d886ddcf`;
    (34) a worker URL's query suffix is normalised before its target is resolved, so a worker entry spelled with Vite's
    `?worker` suffix is reported - `d886ddcf`.
  - The one finding of round 7: (35) an `.astro` component that executes an import inside a template expression
    (`{(await import('../struct/ids')).structId('x')}`) is reported, with expression-valued attributes and nested
    expressions covered as well, while prose, fenced and indented code samples, `<pre><code>` text, HTML comments,
    `<style>` CSS and script source text are still not collected - `a832b8ed`.
  - The three findings of the review raised against the PR #454 head `9daf2b1e` and closed at `dc117894` (the
    coordinator calls this batch "round 7"; the earlier "round 7" label above names the different, earlier batch that
    closed item 35, so both labels are kept here): (36) an MDX
    document that evaluates an executable expression (`{import('../struct/ids').then(({ structId }) => structId('x'))}`)
    is reported, because the expression is parsed from a real MDX tree rather than from a line scanner, while a fenced
    code block, an indented code sample, inline code and an HTML comment that merely show an import are still not
    collected, and a document the MDX parser refuses fails the guard loudly instead of being skipped - `dc117894`
    (two cases: "E-03: inspects the executable expressions of an MDX document" and "E-03: fails loudly when a real MDX
    document cannot be parsed"); (37) a retained wrapper that uses the CommonJS export-assignment form
    (`export = require('./types')`) is traced as a re-export, so an external import of such a wrapper is reported, and
    a computed require in an export assignment fails closed - `dc117894` (one case: "E-03: traces a CommonJS export
    assignment from a retained wrapper"); (38) the script bodies of an `.astro` component are taken from the compiler
    AST, so a `<script>` example inside an HTML comment, a `<pre>` sample or a frontmatter string is not scanned while a
    real script element still is - `dc117894` (one case: "E-03: reads the script bodies of an Astro component from its
    AST").
  Thirty-five of the thirty-eight are guard-behaviour items; the other three (items 8, 19 and 28) are documentation items.
  The two
  (F14) assertions are in the file the plan names: the case
  "E-03: the production recovery module takes its category and actionable-recovery authority from the package"
  (`tests/struct-adapter-boundary.test.ts:1821-1868`) asserts both package runtime imports, the absence of any
  `category:` field in the app copy table, and that the app facade delegates instead of deciding either fact. The two
  new focused files `tests/struct-recovery-category-authority.test.ts` and `tests/struct-recovery-actionable-authority.test.ts`
  pin the behaviour.
- **Shape of the MDX fix at `dc117894`** - the MDX path is two paths, not one, and the reason is measured rather than
  assumed. The MDX processor (`unified` + `remark-parse` + `remark-mdx`) yields `mdxjsEsm` nodes for the ESM flow blocks
  and `mdxFlowExpression`/`mdxTextExpression` nodes for the executable expressions, but it **throws** on a document whose
  prose merely begins with `import` or `export` (`Could not parse import/exports with acorn`), because that is not a
  valid MDX document, and the line scanner the guard has always used tolerates exactly that prose. The line scanner also
  strips the frontmatter and preserves a module-free ESM block, and the existing cases pin both behaviours. A single
  mdast path would therefore have had to change existing behaviour to be used at all, so the guard keeps the line
  scanner for the ESM flow blocks and adds the mdast path for the expressions. The two paths do not overlap: the line
  scanner contributes only ESM statements and the mdast path only expression values, so no import is counted twice
  (the existing exact assertions, e.g. `expect(importedPaths(fenced, mdxProbe)).toEqual(['./a'])`, still hold). The
  mdast path fails loudly for a document of the repository that the MDX parser refuses; for a document that is not a file
  of the repository - a probe of the guard itself - it contributes nothing and the line scanner still reads the ESM
  blocks, so the tolerance the existing prose cases require is kept.
- **Case inventory at `dc117894`** - the 39 cases of `tests/struct-adapter-boundary.test.ts`, in file order:
  "keeps one implementation and identity through the legacy and root exports"; "keeps one app-owned recovery
  implementation and legacy forwarding"; "keeps app recovery consumers on the app-owned path"; "keeps all implementation
  modules within their allowed import boundaries"; "rejects app reconstruction and private package imports in synthetic
  modules"; "E-03: prohibits migrated-family imports (types/ids/reading-order/codec) and validates package paths";
  "E-03: app diagnostic categories match package recovery facts"; "E-03: the production recovery module takes its
  category and actionable-recovery authority from the package"; "E-03: rejects project-root, nested-family, computed and
  CommonJS migrated-family imports"; "E-03: inspects MDX modules under src for migrated-family imports"; "E-03:
  collects every consecutive leading MDX import statement"; "E-03: rejects every spelling of the compatibility recovery
  forwarder"; "E-03: rejects a new production importer of the app-owned recovery module"; "E-03: enforces the app-owned
  recovery importer allowlist inside the retained tree"; "E-03: pins the decoder and renderer validation split for
  colliding emitted identifiers"; "E-03: the package EPUB renderer and the app render paths refuse colliding emitted
  identifiers"; "E-03: collects MDX ESM flow blocks wherever they appear in the document"; "E-03: reads a multiline MDX
  import declaration until the parser recognises it"; "E-03: rejects a computed CommonJS require"; "E-03: inspects Vite
  glob imports"; "E-03: resolves a Vite glob pattern against the directory of the importing module"; "E-03: catches an
  external import of a retained-tree wrapper that re-exports a migrated family"; "E-03: normalises a project-root or
  alias Vite glob pattern before matching"; "E-03: follows an imported binding that a retained wrapper re-exports";
  "E-03: inspects a Vite worker entry module"; "E-03: inspects a local Astro script source"; "E-03: inspects Astro
  template expressions"; "E-03: treats a transitive path to the recovery authority as a violation"; "E-03: resolves a
  retained wrapper stored as a CommonJS TypeScript module"; "E-03: traces a CommonJS re-export from a retained wrapper";
  "E-03: normalises an explicit MDX extension before the wrapper traversal"; "E-03: treats the retained barrel as a Vite
  glob candidate"; "E-03: preserves a module-free MDX ESM block for the AST scan"; "E-03: traces an exported alias of an
  imported binding"; "E-03: normalises a worker URL query suffix before resolving the target"; "E-03: inspects the
  executable expressions of an MDX document"; "E-03: fails loudly when a real MDX document cannot be parsed"; "E-03:
  traces a CommonJS export assignment from a retained wrapper"; "E-03: reads the script bodies of an Astro component
  from its AST".
  The case-to-commit attribution, measured with `git show <commit> -- tests/struct-adapter-boundary.test.ts` and
  matched against the file's case order: cases 16, 17, 19 and 22 were added at `7907acff`; cases 18 and 20 at
  `f6866e41`; case 21 at `79c0d7c5`; cases 23-26 and 28-29 at `dee1f860`; case 27 at `a832b8ed`; cases 30-35 at
  `d886ddcf`; cases 36-39 at `dc117894`.
  (Case indices are the 1-based positions in this inventory and correspond directly to the reviewed-gap indices above,
  which share the case names. The older sentence that attributed the last four cases of the 28-case list to
  `7907acff` was wrong and is corrected here; the measured attribution above is the true one - `7907acff` added the
  EPUB-refusal case and three cases that sit earlier in the file than the `f6866e41` and `dee1f860` cases inserted
  before them.)
- **Plan status update** - `docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md` carries the E-03
  "Status at this head" bullet (`:494-533` at `dee1f860`; it was `:479-518` at `79c0d7c5`), confined to the E-03 status
  bullet: it records that the two source units above discharge the (F14) production-delegation clause, and that the E-03
  stage row is unchanged and still PENDING as a stage gate. `dee1f860` added three further hunks to the same plan, all
  of them factual corrections inside the recovery copy ownership section (`:331-363`, `:389-403` and `:444-454`): the
  stale "at this head" description of the app recovery module became an explicit historical baseline that names the
  commits that changed it, and the two neighbouring clauses that repeated the same stale state were corrected the same
  way. No normative obligation, gate row, red-first requirement or drift rule changed there either.
- **Gate state - the E-03 stage gate is still PENDING and is not claimed here.** The plan's E-03 stage row
  (`docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md:1907` at `dee1f860`; it was `:1892` at `79c0d7c5`)
  is unchanged - the two rows are byte-identical and only the line number moved: the package/local dual-read
  equality, the accepted/rejected input matrix, and the high-fan-in consumer enumeration and test are not produced by
  these commits and have not been accepted. The two delegations discharge the (F14) production-delegation clause only.
- **Measurement frames** - the app-suite numbers (318 files, 4986 tests) and the `astro check` result (0 errors, 279
  hints) recorded in "Not done / not in scope" below, and the FIRST red→green guard pair in "Static guard" above, are the
  dated CANDIDATE-frame measurements (the E-03 step and the candidate `ae4638ce`); they are not re-claimed for the guard
  state described in this section, and the whole app suite was not re-run at that guard state. The independent review of
  the earlier head ran the focused suites (`tests/struct-adapter-boundary.test.ts`,
  `tests/struct-recovery-category-authority.test.ts`, `tests/struct-recovery-actionable-authority.test.ts`,
  `src/struct/struct.test.ts`, `tests/struct-adapter-parity.test.ts`, `tests/struct-package-parity.test.ts`,
  `tests/struct-adapter-mapped-annotation.test.ts`, `tests/struct-adapter-inline-links.test.ts`,
  `tests/struct-adapter-inline-binding.test.ts`): 9 files, 87 tests, 0 failures, exit 0. That review is not re-claimed
  for the guard state described in this section. No CI result is claimed.
- **Guard measurements at `dc117894`** - `npx vitest run tests/struct-adapter-boundary.test.ts --maxWorkers=1
  --testTimeout=30000` reports 1 file, 39 tests, 39 passed, exit 0 (11.65 s total: transform 2.12 s, import 3.23 s,
  tests 8.10 s; wall time 12.49 s), measured at the guard state described in this section, in the round-7 worktree
  `/home/ubuntu/.local/state/struct-migration/20261020-continuation/worktrees/app-e03-guard-round7`
  (node 22.22.3, vitest 4.1.11, shared 4-CPU VM). The two focused recovery-authority files
  (`tests/struct-recovery-category-authority.test.ts`, `tests/struct-recovery-actionable-authority.test.ts`) were
  measured at the same guard state with `npx vitest run tests/struct-recovery-category-authority.test.ts
  tests/struct-recovery-actionable-authority.test.ts --maxWorkers=1 --testTimeout=30000` (2 files, 11 tests, 11 passed,
  exit 0, 0.654 s; wall time 1.44 s). For continuity: the earlier `a832b8ed` frame of this section reported 1 file, 35
  tests, 35 passed, exit 0, the `d886ddcf` frame reported 1 file, 34 tests, 34 passed, exit 0, and the `dee1f860`
  frame reported 28 tests, 28 passed. No other suite was run and no CI result is claimed.
- **Known limits of the guard at `dc117894` (recorded, NOT closed)** - five of the six P3 observations from the
  independent review of the earlier head are still limits of the guard at this state, and this record does not claim
  that any of them is closed. All five were re-measured at `dc117894` with the guard's own functions, on a scratch
  copy of the guard file of this state run against this worktree's tree; the measured values are unchanged from the
  values the record quoted at `dee1f860` and at `d886ddcf`. The measured result is quoted: (1) an MDX declaration whose `from` clause is separated from the import clause by a comment line is not
  collected - the probe `import T` / `// a comment line` / `from '@/struct/types'` in the MDX frame yields
  `mdxEsmStatements` `""`, `importedPaths` `[]` and an empty violations list; (2) an MDX declaration whose continuation
  line is indented by four spaces is not collected - the probe `import T` / `    from '@/struct/types'` in the MDX
  frame yields `mdxEsmStatements` `""`, `importedPaths` `[]` and an empty violations list (an indented line *inside*
  a braced import is still collected, so the limit is the indented continuation line, not the indentation itself); (3)
  a glob pattern with a character class (`'../struct/[ct]odec.ts'`) is not matched - the probe yields `importedPaths`
  `[]`, an empty violations list and `globMatchesAny` `false`, because `globToRegExp` escapes `[` and `]`; (4) a glob
  that carries the `base` option is matched against the importing module's own directory rather than against `base` -
  the probe `import.meta.glob('./struct/codec.ts', { eager: true, base: '/src' })` in a module of `src/research/`
  yields `importedPaths` `[]` and an empty violations list, although Vite would resolve that pattern against `base` to
  `src/struct/codec.ts`; (5) `createRequire(import.meta.url)('./local')` contributes no specifier - the probe yields
  `importedPaths` `[]` and an empty violations list, because the collector recognises only the identifier `require`
  as the callee of a require call (the control `require('./local')` yields `["./local"]`).
  The `dc117894` change does not lift any of them: the two MDX probes still fail closed to the line scanner, which
  reads them exactly as before, and the three remaining probes are untouched by it. Each of the six round-6 findings
  and each of the three findings closed at `dc117894` is provably closed at this state instead -
  the CommonJS wrapper re-export chain, the explicit MDX extension, the barrel as a glob candidate, the module-free
  MDX ESM block, the exported alias form and the worker URL query suffix all report violations now (cases 30-35, red
  against the base `394fba68`, green at `d886ddcf`), and the MDX expression collection, the export-assignment re-export
  and the Astro script AST now report violations as well (cases 36-39, red against `9daf2b1e`, green at `dc117894`).
  The sixth observation - that a worker entry (`new Worker(new URL('../struct/codec.ts', import.meta.url), { type:
  'module' })`) contributes no specifier - **still no longer holds at this state**: it was closed by `dee1f860`, and
  the round-6 case 35 extends the same coverage to the query-suffixed spelling
  `new Worker(new URL('../struct/ids.ts?worker', import.meta.url), { type: 'module' })`, which now collects
  `["../struct/ids.ts"]` and is reported, red against the base `394fba68` (see the red→green pair below). No limit is
  recorded here that was not measured at the round-6 guard state.

## Static guard (red → green)
- Added E-03 entry to `tests/struct-adapter-boundary.test.ts`.
- Red run recorded against a temporarily reverted import (`src/research/grounded-struct-materializer.ts` restored to `../struct/ids` and `../struct/types`): guard reported 2 violations (`migrated family import ../struct/ids` and `../struct/types`).
- Green run confirmed after restoring switched imports.
- The boundary guard was hardened on top of that red→green pair: the thirty-eight reviewed items enumerated under
  "Runtime recovery delegations and guard hardening" above (which include the two (F14) assertions) and the cases added
  at `64209924`, `e9009551`, `7907acff`, `f6866e41`, `79c0d7c5`, `dee1f860`, `d886ddcf`, `a832b8ed` and `dc117894` are
  recorded there.
- The hardening at `7907acff` has its own red→green pair, measured against `e9009551`: the three new guard cases (MDX
  ESM flow blocks wherever they appear in the document, a computed CommonJS require, and an external import of a
  retained-tree wrapper that re-exports a migrated family) FAIL against the `e9009551` implementation (1 file, 19
  tests, 3 failed, 16 passed, exit 1) and PASS at `7907acff` (1 file, 19 tests, 19 passed, exit 0). The renderer case
  is red-first against a deliberate mutation of `src/struct/xhtml.ts` that drops the emitted-identifier assertion: the
  `e9009551` guard passes under that mutation (1 file, 15 tests, 15 passed, exit 0) and the `7907acff` guard fails (1
  file, 19 tests, 1 failed, 18 passed, exit 1). The mutation was reverted and is not part of the reviewed tree.
- The hardening at `f6866e41` has its own red→green pair, measured against `7907acff`: the two new guard cases (a
  multiline MDX import declaration read until the parser recognises it, and Vite glob imports inspected) FAIL against
  the `7907acff` implementation (1 file, 21 tests, 2 failed, 19 passed, exit 1) and PASS at `f6866e41` (1 file, 21
  tests, 21 passed, exit 0).
- The hardening at `79c0d7c5` has its own red→green pair, measured against `f6866e41`: the one new guard case (a Vite
  glob pattern resolved against the directory of the importing module) FAILS against the `f6866e41` implementation
  (1 file, 22 tests, 1 failed, 21 passed, exit 1 - the failing assertion is
  `expect(importedPaths(dotSlash, srcModule)).toContain('./struct/codec.ts')`, because the `'./'`-relative spelling
  collected nothing) and PASSES at `79c0d7c5` (1 file, 22 tests, 22 passed, exit 0). In both of the last two pairs the
  red run is the parent implementation with the new case injected into it, and it was measured in a scratch copy of the
  tree, so the reviewed tree itself was not modified to produce it.
- The hardening at `dee1f860` has its own red→green pair, measured against `8411b8c5`: the six new guard cases (a
  project-root or alias Vite glob pattern normalised before matching, the two-step form of a retained wrapper that
  re-exports an imported binding, a Vite worker entry module, a local Astro script source, a transitive path to the
  recovery authority, and a retained wrapper stored as a CommonJS TypeScript module) FAIL against the `8411b8c5`
  implementation (1 file, 28 tests, 6 failed, 22 passed, exit 1) and PASS at `dee1f860` (1 file, 28 tests, 28 passed,
  exit 0). The red run is the parent implementation with the six new cases injected into it, and it was measured in a
  scratch copy of the tree, so the reviewed tree itself was not modified to produce it.
- The round-6 hardening, replayed as `d886ddcf`, has its own red→green pair, measured against the base `394fba68` (the
  PR #454 head the six round-6 findings were raised against): the six new guard cases (a CommonJS re-export from a retained wrapper
  traced, an explicit MDX extension on an imported retained wrapper normalised before the wrapper traversal, the
  retained barrel treated as a Vite glob candidate, a module-free MDX ESM block preserved for the AST scan, an
  exported alias of an imported binding traced, and a worker URL query suffix normalised before the target is
  resolved) FAIL against the `394fba68` implementation (1 file, 34 tests, 6 failed, 28 passed, exit 1) and PASS at
  `d886ddcf` (1 file, 34 tests, 34 passed, exit 0). The red run is the `394fba68` guard implementation with the six
  new cases injected into it; the six case bodies in the red copy of `tests/struct-adapter-boundary.test.ts` are
  byte-identical to the six case bodies at `d886ddcf` (verified by diffing the two `describe(...)` blocks), and the
  red run was measured in a scratch copy of the tree at `/tmp/opencode/app-e03-guard-round6` (node 22.22.3, vitest
  4.1.11), so the reviewed tree itself was not modified to produce it. The six failing assertions at the red state
  measure the before-state of each finding directly: the CommonJS wrapper import of `../struct/__e03_probe_legacy_cjs`
  collects no violation; the retained tree warnings list for the same wrapper is empty even at the chain check;
  `importedPaths` of the explicit-`.mdx` wrapper import collects nothing; the barrel glob
  `import.meta.glob('../struct/index.ts', { eager: true })` collects no specifier at all; `mdxEsmStatements('export
  const x = 1')` returns `""` instead of preserving the module-free declaration; the alias wrapper and the
  default-alias wrapper collect no violation; and the query-suffixed worker URL keeps its suffix and collects
  `['../struct/ids.ts?worker']` instead of `['../struct/ids.ts']`.
- The hardening at `a832b8ed` has its own red→green pair, measured with the expression collection disabled on the
  final head (the parent behaviour, because `fb1250a0` and `d886ddcf` had no Astro template-expression scan): the new
  case "E-03: inspects Astro template expressions" FAILS with `AssertionError: expected [] to include '../struct/ids'`
  (1 file, 35 tests, 1 failed, 34 skipped, exit 1) and PASSES with the real collector (1 file, 35 tests, 35 passed,
  exit 0). The failing assertion is the template expression
  `{(await import('../struct/ids')).structId('x')}`, which yields 0 violations without the fix and 1 violation with it.
  The negative controls in the same case (prose, fenced and indented code samples, `<pre><code>` text, an HTML comment,
  `<style>` CSS, script source text, nested JSX text, and a template expression with no migrated import) pass in the
  green run; the red run stops at the first assertion, so it does not exercise them. The red run was measured by
  temporarily replacing the collector call with an empty list in this worktree and was restored immediately; the
  reviewed tree at `a832b8ed` contains the real collector.
- The hardening at `dc117894` has its own red→green pair, measured against `9daf2b1e` (the PR #454 head the three
  findings of this batch were raised against): the four new guard cases (the executable expressions of an MDX document,
  a real MDX document that cannot be parsed, a CommonJS export assignment of a retained wrapper, and the script bodies
  of an Astro component) FAIL against the `9daf2b1e` implementation (1 file, 39 tests, 4 failed, 35 passed, exit 1,
   10.29 s total, wall time 11.13 s) and PASS at `dc117894` (1 file, 39 tests, 39 passed, exit 0, 11.65 s total, wall
  time 12.49 s). The red run is the `9daf2b1e` guard implementation with the four new cases injected into it, measured
  in a scratch copy of the file inside this worktree, so the reviewed tree itself was not modified to produce it; the
  scratch copy was deleted afterwards and is not part of the reviewed tree. The four failing assertions at the red state
  measure the before-state of each finding directly, and each is the assertion the review named:
  - the MDX expression case fails with `AssertionError: expected [] to include '../struct/ids'`: the expression
    `{import('../struct/ids').then(({ structId }) => structId('x'))}` yields 0 violations at `9daf2b1e` and 1 violation
    at `dc117894`;
  - the fail-loud MDX case fails with `AssertionError: expected [Function] to throw an error`: a real document the MDX
    parser refuses is silently skipped at `9daf2b1e` and fails the guard loudly at `dc117894`;
  - the export-assignment case fails with `AssertionError: expected [] to not deeply equal []`: an external import of
    the wrapper `export = require('./types')` yields 0 violations at `9daf2b1e` and 1 violation at `dc117894`;
  - the Astro script case fails with `AssertionError: expected [ '../struct/ids' ] to deeply equal []`: a `<script>`
    example inside an HTML comment or a `<pre>` sample yields 1 violation at `9daf2b1e` and 0 violations at `dc117894`,
    while a real script element yields 1 violation at both heads.
  The negative controls of the new cases (a fenced code block, an indented code sample, inline code and an HTML comment
  in MDX; an HTML comment, a `<pre>` sample and a frontmatter string in Astro) pass in the green run; the red run stops
  at the first assertion of each case, so it does not exercise them.

## Evidence tools (E-07 note)
- Evidence tools (`tools/srt-source-output-evidence.mjs`, `tools/pdf-epub-package-scan.mjs`, `tools/pdf-corpus-audit-lib.mjs`, `tools/pdf-association-fixture-audit.mjs`, `tools/model-consultation-evidence.ts`) keep working because local modules remain.
- The `/src/struct/ids.ts` load used by `tools/srt-source-output-evidence.mjs` will be migrated at E-07, not in E-03.

## Not done / not in scope
- No E-04/E-05/E-06/E-07 work performed.
- No renderer or publication-semantics cutover.
- No golden regenerated; no artifact repinned.
- No `npm publish`, no deploy, no writer/route change, no PR created, no push, no merge **by the E-03 implementation
  step**. The branch itself is carried by the coordinator's PR #454; this record does not name a PR tip, because the
  record's own commit moves it. Nothing in this record is merged, released or deployed.
- `astro check` passes (0 errors, 279 hints pre-existing).
- The repository's own app suite (`npx vitest run --exclude 'tests/e2e/**' --exclude 'tools/agent-evidence-budget.test.mjs' --maxWorkers=1`):
  318 files (316 passed, 2 skipped), 4986 tests (4969 passed, 17 skipped), exit 0 - no failures. The independent
  review of this candidate measured the same numbers at the same commit.
- **Known load sensitivity, stated plainly:** a SECOND recorded run of that identical command at this candidate
  reported one failing FILE - `src/research/grounded-struct-materializer.test.ts` - with
  `Error: Test timed out in 300000ms` on its `continues one #199 task through a rejected sibling to terminal
  promotion` case. That is a per-test timeout, not an assertion failure: the case exercises the materializer of
  `src/research/grounded-struct-materializer.ts`, one of the eight files re-pointed at the package subpaths in this
  step, and it runs close to vitest's 300 s per-test limit. The same file passes at the E-02 parent head and in the
  independent review's run, and the implementation of `structId`/`structDigest` in the package
  (`@erniesg/struct/identity`) is the same algorithm as the app's local `src/struct/ids.ts`, so the switch adds no
  new work per identifier. The failure was observed while several suites ran concurrently on one machine; it is
  recorded here rather than hidden, and no assertion was weakened to hide it.
- A bare `npx vitest run --maxWorkers=1` (which also collects the Playwright e2e specs, which the repository's script excludes) reports the e2e spec files as collection failures plus the `publication:build` symlink case, whose own setup fails when the gitignored `.agent/evidence/` directory does not exist yet in a fresh worktree. That invocation is not the repository's suite command and is recorded here only so the difference is not mistaken for a regression.
- `git status --porcelain` clean. **The change is not documentation-only and not limited to the import switches.**
  At the archived pre-restack E-03 candidate head `ae4638ce` (archived at
  `origin/archive/struct-e03-core-codecs-ids-order-20261020-pre-restack`; it was the tip of
  `feat/struct-e03-core-codecs-ids-order-20261020` at the time, and the candidate's parent before the E-03 content
  is `3f671e2b`) the branch carries **12 changed files, not 10**: the 8 production import
  switches, the guard extension, this dated record, **and the dependency-override pair** -
  `package.json` (+1 line: the root `overrides` entry `"vite": "8.1.6"`, at `package.json:177`) and
  `package-lock.json` (218 lines changed: 31 insertions, 187 deletions), both from commit `ae4638ce`
  "fix(deps): override vite to the patched 8.1.6 for the runtime audit gate". The lock was regenerated with
  `RUCKSACK_NPM_SHIM=passthrough npm install --package-lock-only --ignore-scripts` under npm 10.9.8.
  0 vendor / golden / expected changes. The PR branch `feat/struct-e03-core-codecs-ids-order-20261020` does **not**
  contain `ae4638ce` as an ancestor: that override content is already byte-identical
  on `main` (`5f8c76ab`; `package.json` blob `e39978fa68be8c703cf99fd1804aa05fe90da9f6` and `package-lock.json` blob
  `f16d1dc1f78403c1a5b39f7ac3a35907d9c3ef8a` are the same blobs in both), so
  `git diff 5f8c76ab dee1f860 -- package.json package-lock.json` is empty in the guard state described in this section
  (the same measurement holds at `79c0d7c5` and at `64209924`) while the override itself is present
  in the tree. The dependency override is therefore part of the E-03 change's real scope in both frames.
  At the guard state described in this section the branch carries **14 changed paths** against `main` (`5f8c76ab`): the 8
  production import switches, `src/struct-adapters/recovery.ts`, the plan's E-03 status paragraph, this dated record,
  the boundary guard, and the two new focused authority test files - no manifest, lockfile, vendor, golden or expected
  file is among them. The guard commits and this record touch only the boundary guard, the recovery copy ownership
  paragraphs of the cutover plan and this dated record, all of which are already among those 14 paths, so the count is
  unchanged. The restack branch `feat/struct-e03-core-codecs-ids-order-20261021` contains `64e6774b`, and the
  final-integration branch `fix/struct-e03-final-integration-20261022` contains the round-6 replay `d886ddcf` and the
  Astro-expression commit `a832b8ed`; each of those commits is an ancestor of the guard state described in this section.
  The round-7 boundary-guard branch `e03/boundary-guard-round7` is based on the PR #454 head `9daf2b1e` and carries the
  guard commit `dc117894` and this record's commit; against `9daf2b1e` it changes two paths (the boundary guard and this
  dated record, 434 insertions and 66 deletions in the guard file) and against `main` (`5f8c76ab`) it still carries the
  same 14 paths, because both of its paths are already among them. **No manifest, lockfile, vendor, golden or expected
  file changed at `dc117894`:** `git diff 5f8c76ab dc117894 -- package.json package-lock.json` is empty, and the guard
  reaches the MDX toolchain (`unified` 11.0.5, `remark-parse` 11.0.0, `remark-mdx` 3.1.1) through the direct
  `devDependencies` the repository already declares, so no dependency declaration was added.
- **Census of the new rules at `dc117894`** - the three new rules were measured against the real tree before they were
  trusted, and each of them adds 0 violations to it: all 115 tracked `.mdx` files parse with the MDX processor (0 parse
  failures) and none of them carries an `mdxFlowExpression`, an `mdxTextExpression` or an `mdxjsEsm` node, so the
  expression rule contributes 0 specifiers; all 39 tracked `.astro` files parse with the Astro compiler (0 parse
  failures) and they hold 18 script elements, none of them inside a `<pre>` or `<code>` element, so the script-body rule
  contributes 0 specifiers; and the 26 tracked files of the retained `src/struct` tree hold no `export =` assignment and
  no computed require, so the export-assignment rule contributes 0 violations. The repository-wide case of the guard
  ("keeps all implementation modules within their allowed import boundaries") reports 0 violations for every portable
  file of the tree at this state, which is the same result it reported at `9daf2b1e`. **No production file is a
  violation because of the three findings, and no assertion was weakened to hide one.**
