# E-03 Implementation Record — 2026-10-20

Owner: `erniesg/erniesg` (E-03 IMPLEMENTATION owner for `erniesg/struct` app cutover)
Branch: `e03/boundary-guard-round10` (local round-10 boundary-guard branch, based on the PR #454 head `52c9f0f6`;
the E-03 content was originally
carried on `feat/struct-e03-core-codecs-ids-order-20261020`)
Worktree: `/home/ubuntu/.local/state/struct-migration/20261020-continuation/worktrees/app-e03-guard-round10`
Precondition: E-02 passed (`feat/struct-e03-core-codecs-ids-order-20261020` exists with commits).
Guard state described by this record: `ed7c320a` ("test(struct): close the two E-03 boundary-guard findings of round 10").
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

## Runtime recovery delegations and guard hardening (guard state at `ed7c320a`, with earlier heads marked inline)

This section records the E-03 scope that the restack added on top of the dated candidate measurement recorded below.
It describes the guard state at the commit that last changed the guard, `ed7c320a` ("test(struct): close the two
E-03 boundary-guard findings of round 10"), which is the state of `tests/struct-adapter-boundary.test.ts`
in the reviewed tree; the guard runs of this section were measured in the round-10 worktree
`/home/ubuntu/.local/state/struct-migration/20261020-continuation/worktrees/app-e03-guard-round10`. Bullets whose
measurements were taken at an earlier head say so inline. This record describes the tree **as of that guard
commit**; it does not name a branch tip as the reviewed head, because the record's own commit moves that tip. The guard
commits included in the reviewed tree are the sixteen listed under "Boundary-guard hardening" below, and each of them is
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
- **Boundary-guard hardening** - commits `70727202` ("E-03: switch production imports to package subpaths; keep local
  modules unchanged; extend static guard red→green; record dated E-07 note for /src/struct/ids.ts load", the first
  guard commit of the E-03 candidate, which took the file from 5 cases / 386 lines to 6 cases / 429 lines), `fc73a970`
  ("test(struct): resolve aliased imports and pin the package recovery facts"), `5974df05` ("test(struct): guard the E-03 recovery authorities in the boundary test"), `a99a0f86` ("test(struct):
  add the E-03 guard red-first cases"), `36916381` ("test(struct): close the E-03 boundary guard gaps"), `e9009551`
  ("test(struct): close the E-03 guard alias and MDX gaps"), `7907acff` ("test(struct): close the E-03 guard MDX, CommonJS,
  wrapper and render gaps"), `f6866e41` ("test(struct): close the E-03 guard MDX multiline and Vite glob gaps"),
  `79c0d7c5` ("test(struct): resolve E-03 Vite glob patterns against the importing module"), `dee1f860` ("test(struct):
  close the seven E-03 boundary-guard findings"), `fb1250a0` ("test(struct): give the E-03 boundary guard explicit
  timeouts and one shared analysis"), `d886ddcf` ("test(struct): close the six E-03 boundary-guard findings of round 6"),
  `a832b8ed` ("test(struct): scan Astro template expressions for imports") and `dc117894` ("test(struct): scan MDX
  expressions, export assignments and Astro script ASTs"), `63af8a44` ("test(struct): scan hoisted Astro script
  bodies and MDX JSX attribute expressions"), `957d9b7d` ("test(struct): close the two E-03 boundary-guard
  findings of round 9") and `ed7c320a` ("test(struct): close the two E-03 boundary-guard findings of round 10").
  These sixteen are the guard commits
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
  35 cases (3274 lines) at `a832b8ed`, to 39 cases (3642 lines) at `dc117894`, to 40 cases (3783 lines) at
  `63af8a44`, to 42 cases (4300 lines) at `957d9b7d`, and to 44 cases (4490 lines) at `ed7c320a`. Every count is
  `grep -c "^  it("` on the file at that commit and every line
  count is `wc -l` on it.
  **The complete reviewed set is closed - forty-four reviewed items.** The enumeration and the count are the same
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
    AST, so a real script element is scanned - `dc117894` (one case: "E-03: reads the script bodies of an Astro component
    from its AST"). **Item 38 was corrected at `63af8a44`:** the version of this item written at `dc117894` also named a
    `<pre>` sample as a thing the guard does not scan, and that premise was FALSE. The compiler hoists and executes a
    script element inside a `<pre>` or a `<code>` sample, so the guard scans it; a script example inside an HTML comment
    or a frontmatter string is not scanned, because the compiler AST holds the comment as a comment node and the
    frontmatter as the frontmatter node. The measured evidence is in the "Astro hoisting evidence" bullet below.
  - The two findings of the review raised against the PR #454 head `5b0eaad8` and closed at `63af8a44` (the coordinator
    calls this batch "round 8"): (39) an Astro script element inside a `<pre>` or a `<code>` sample is hoisted out of the
    sample and executed by Astro, so the guard scans its body and reports it, while a script example inside an HTML
    comment and a script example inside a frontmatter string are still not collected - `63af8a44` (one case: "E-03: reads
    the script bodies of an Astro component from its AST", corrected in place); (40) the expression of an MDX JSX
    attribute value (`<Foo bar={import('../struct/ids')} />`) and the spread form (`<Foo {...import('../struct/ids')} />`)
    are evaluated by MDX, so the guard collects them and reports them, while a plain attribute value, the JSX text of an
    element, a fenced code block, an indented code sample, inline code and an HTML comment are still not collected -
    `63af8a44` (one case: "E-03: inspects the MDX JSX attribute expressions of an MDX document").
  - The two findings of the review raised against the PR #454 head `d4b05448` and closed at `957d9b7d` (the coordinator
    calls this batch "round 9"): (41) an exported EXPRESSION that uses an imported binding is traced - an exported arrow
    function (`export const legacyId = (value) => structId('legacy', value)`), an exported function declaration, an
    exported call expression, an exported object literal that holds the imported binding and an exported default
    expression that references the imported binding all make the module the binding was imported from a re-export-chain
    target, so an importer outside the retained tree that reaches such a wrapper is reported, while a binding the module
    defines itself reaches no other module and creates no target, and the plain-identifier and `export { name }` forms keep
    their behaviour - `957d9b7d` (one case: "E-03: traces an exported expression that uses an imported binding");
    (42) a Vite glob that names a literal `base` option resolves its relative pattern from that base - a
    project-root base (`/src`) is resolved against the project root, an absolute base is used as it is, a relative base
    is resolved against the directory of the importing module, and a base that is not a literal fails closed in the same
    way a computed pattern does, while a relative pattern without a base, a project-root pattern, an alias pattern and a
    computed pattern keep their behaviour - `957d9b7d` (one case: "E-03: resolves a Vite glob pattern against a literal
    base option").
  - The two findings of the review raised against the PR #454 head `52c9f0f6` and closed at `ed7c320a` (the coordinator
    calls this batch "round 10"): (43) a Vite glob pattern is matched with the glob matcher Vite itself uses -
    picomatch, the matcher the bundler depends on and the one the globber Vite calls for a glob import matches with -
    so a character class (`../struct/types.[t]s`), a brace alternation (`../struct/types.{ts,tsx}`) and a negated
    class (`../struct/types.[!x]s`) name the modules they name in the bundler and are reported here as well (the
    character class and the negated class were not reported at all at `52c9f0f6`, because the hand-written conversion
    escaped `[` and `]`; the brace alternation was already reported by the hand-written brace expansion of that head
    and stays reported), while a
    negated class that excludes the family (`../struct/types.[!t]s`), a pattern that names no migrated family, a
    computed pattern and a pattern that reaches the family only through a literal base, a project-root pattern or an
    alias pattern keep their behaviour - `ed7c320a` (one case: "E-03: matches a Vite glob pattern with the glob matcher
    Vite uses"); (44) the body of an Astro script element whose type is not a JavaScript type (`text/plain`,
    `application/json`, `text/x-component`, `application/ld+json`) is a data block that Astro never executes, so it is
    not scanned, while a module script (no type, `module`, `text/javascript`, `application/javascript`) and an inline
    script are executed and are still scanned - `ed7c320a` (one case: "E-03: does not scan the body of a non-JavaScript
    Astro script").
  Forty-one of the forty-four are guard-behaviour items; the other three (items 8, 19 and 28) are documentation items.
  The two
  (F14) assertions are in the file the plan names: the case
  "E-03: the production recovery module takes its category and actionable-recovery authority from the package"
  (`tests/struct-adapter-boundary.test.ts:2756-2803` at `ed7c320a`; it was `:2725-2772` at `957d9b7d`, it was
  `:2438-2485` at `63af8a44` and the record
  quoted `:1821-1868` before, which was a stale line reference) asserts both package runtime imports, the absence of any
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
- **Shape of the MDX fix at `63af8a44`** - the mdast path gained the JSX attribute forms at `63af8a44`. An MDX JSX
  element carries its attributes in an `attributes` array, not among its children, so the child-walking visitor of
  `dc117894` never saw them: the mdast of `<Foo bar={import('../struct/ids')} />` is `root -> mdxJsxFlowElement` whose
  `attributes[0]` is `{type: 'mdxJsxAttribute', name: 'bar', value: {type: 'mdxJsxAttributeValueExpression', value:
  "import('../struct/ids')"}}`. The visitor now reads the attributes of a node as well, collects the JavaScript of an
  `mdxJsxAttributeValueExpression` and the JavaScript of the spread form `mdxJsxExpressionAttribute` (whose `value`
  carries the spread marker `...`, which is removed before the expression is scanned), and leaves a plain attribute
  value alone, because a plain value is a string the document renders. The two paths still do not overlap: the line
  scanner contributes only ESM statements and the mdast path only expression values.
- **Astro hoisting evidence at `63af8a44`** - the reason the `<pre>`/`<code>` sample exclusion was wrong is measured
  with the compiler the guard itself uses (`@astrojs/compiler` 2.13.1, `transform` and `parse` from
  `@astrojs/compiler/sync`), not assumed:
  - `<pre><script>import x from "../struct/ids"</script></pre>` - the compiler hoists the script:
    `hoisted: [{ type: 'inline', value: \`import x from "../struct/ids"\` }]`, the rendered output is `<pre></pre>`, and
    the compiler AST holds the script element inside the `pre` element with its text child
    `import x from "../struct/ids"`. The script is taken out of the sample and hoisted exactly like a top-level script,
    so Astro executes it.
  - `<code><script>import x from "../struct/ids"</script></code>` - the same: `hoisted: [{ type: 'inline', value:
    \`import x from "../struct/ids"\` }]`, the rendered output is `<code></code>`.
  - `<!-- <script>import x from "../struct/ids"</script> -->` - `hoisted: []`, the compiler AST holds no script element
    (the comment is a comment node) and the comment is rendered as it stands.
  - the frontmatter string `const note = \`<script>import x from "../struct/ids"</script>\`` - `hoisted: []`, the
    compiler AST holds no script element (the string is part of the frontmatter node).
  The guard therefore scans a script element wherever the compiler AST puts it, and the controls that are true - the
  HTML comment and the frontmatter string - stay at 0.
- **Case inventory at `ed7c320a`** - the 44 cases of `tests/struct-adapter-boundary.test.ts`, in file order:
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
  inspects the MDX JSX attribute expressions of an MDX document"; "E-03: traces a CommonJS export assignment from a
  retained wrapper"; "E-03: reads the script bodies of an Astro component from its AST"; "E-03: traces an exported
  expression that uses an imported binding"; "E-03: resolves a Vite glob pattern against a literal base option";
  "E-03: matches a Vite glob pattern with the glob matcher Vite uses"; "E-03: does not scan the body of a
  non-JavaScript Astro script".
  The case-to-commit attribution, re-derived at `ed7c320a` by reading the case names of
  `tests/struct-adapter-boundary.test.ts` at each guard commit and matching them against the file's case order: cases
  1-5 at the base `5f8c76ab`; case 6 at `70727202`; case 7 at `fc73a970`; case 8 at `5974df05`; cases 9, 10 and 13 at
  `a99a0f86`;
  cases 11-12 at `e9009551`; cases 14-15 at `36916381`; cases 16, 17, 19 and 22 at `7907acff`; cases 18 and 20 at
  `f6866e41`; case 21 at `79c0d7c5`; cases 23-26 and 28-29 at `dee1f860`; case 27 at `a832b8ed`;
  cases 30-35 at `d886ddcf`; cases 36, 37, 39 and 40 at `dc117894`; case 38 at `63af8a44`; cases 41 and 42 at
  `957d9b7d`; cases 43 and 44 at `ed7c320a`.
  (Case indices are the 1-based positions in this inventory. The attribution is measured, not inherited: it is the case
  list of the file at each guard commit, compared with the case list at its parent commit, with the positions read in
  the inventory above. The only change against the attribution this record carried at `dc117894` is the pair
  "cases 36-39 at `dc117894`", which now reads "cases 36, 37, 39 and 40 at `dc117894`; case 38 at `63af8a44`", because
  the case of `63af8a44` was inserted at position 38 and pushed the two `dc117894` cases that followed it one position
  down. The older sentence that attributed the last four cases of the 28-case list to `7907acff` was wrong and stays
  corrected here.)
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
  The round-10 guard commit `ed7c320a` changes the guard file and this record only: it closes two guard findings and it
  claims no gate, changes no plan row and discharges no clause. **The E-03 stage gate is still PENDING.**
- **Measurement frames** - the app-suite numbers (318 files, 4986 tests) and the `astro check` result (0 errors, 279
  hints) recorded in "Not done / not in scope" below, and the FIRST red→green guard pair in "Static guard" above, are the
  dated CANDIDATE-frame measurements (the E-03 step and the candidate `ae4638ce`); they are not re-claimed for the guard
  state described in this section, and the whole app suite was not re-run at that guard state. The round-10 guard runs of
  this section are the two focused commands named under "Guard measurements at `ed7c320a`"; no other suite was run at
  that guard state. The independent review of
  the earlier head ran the focused suites (`tests/struct-adapter-boundary.test.ts`,
  `tests/struct-recovery-category-authority.test.ts`, `tests/struct-recovery-actionable-authority.test.ts`,
  `src/struct/struct.test.ts`, `tests/struct-adapter-parity.test.ts`, `tests/struct-package-parity.test.ts`,
  `tests/struct-adapter-mapped-annotation.test.ts`, `tests/struct-adapter-inline-links.test.ts`,
  `tests/struct-adapter-inline-binding.test.ts`): 9 files, 87 tests, 0 failures, exit 0. That review is not re-claimed
  for the guard state described in this section. No CI result is claimed.
- **Guard measurements at `ed7c320a`** - `npx vitest run tests/struct-adapter-boundary.test.ts --maxWorkers=1
  --testTimeout=30000` reports 1 file, 44 tests, 44 passed, exit 0 (12.31 s total: transform 2.15 s, import 3.30 s,
  tests 8.67 s; wall time 13.18 s), measured at the guard state described in this section, in the round-10 worktree
  `/home/ubuntu/.local/state/struct-migration/20261020-continuation/worktrees/app-e03-guard-round10`
  (node 22.22.3, vitest 4.1.11, shared 4-CPU VM). The two focused recovery-authority files
  (`tests/struct-recovery-category-authority.test.ts`, `tests/struct-recovery-actionable-authority.test.ts`) were
  measured at the same guard state with `npx vitest run tests/struct-recovery-category-authority.test.ts
  tests/struct-recovery-actionable-authority.test.ts --maxWorkers=1 --testTimeout=30000` (2 files, 11 tests, 11 passed,
  exit 0, 675 ms total: transform 94 ms, import 131 ms, tests 43 ms; wall time 1.47 s). The baseline frame at the PR #454 head
  `52c9f0f6` was measured in the same worktree with the same command on an unmodified copy of the guard file of that
  head: 1 file, 42 tests, 42 passed, exit 0 (12.99 s total: transform 2.50 s, import 3.68 s, tests 8.94 s). For
  continuity: the `957d9b7d` frame of this section reported 1 file, 42 tests, 42 passed, exit 0 (12.68 s total; wall
  time 13.55 s), the `63af8a44` frame reported 1 file, 40 tests, 40 passed, exit 0 (11.58 s
  total; wall time 12.44 s), the `dc117894` frame reported 1 file, 39 tests, 39 passed, exit 0, the `a832b8ed` frame
  reported 1 file, 35 tests, 35 passed, exit 0, the `d886ddcf` frame reported 1 file, 34 tests, 34 passed, exit 0, and
  the `dee1f860` frame reported 28 tests, 28 passed. No other suite was run - in particular the whole app suite was not
  re-run - and no CI result is claimed.
- **Known limits of the guard at `ed7c320a` (recorded, NOT closed)** - three of the six P3 observations from the
  independent review of the earlier head are still limits of the guard at this state, and this record does not claim
  that any of them is closed. The first two and the fifth were re-measured at `ed7c320a` with the guard's own
  functions, on a scratch copy of the guard file of this state run against this worktree's tree; the measured values
  are unchanged from the values the record quoted at `dee1f860`, at `d886ddcf`, at `dc117894` and at `63af8a44`. The
  measured result is quoted: (1) an MDX declaration whose `from` clause is separated from the import clause by a comment line is not
  collected - the probe `import T` / `// a comment line` / `from '@/struct/types'` in the MDX frame yields
  `mdxEsmStatements` `""`, `importedPaths` `[]` and an empty violations list; (2) an MDX declaration whose continuation
  line is indented by four spaces is not collected - the probe `import T` / `    from '@/struct/types'` in the MDX
  frame yields `mdxEsmStatements` `""`, `importedPaths` `[]` and an empty violations list (an indented line *inside*
  a braced import is still collected, so the limit is the indented continuation line, not the indentation itself); (3)
  **the observation about a glob pattern with a character class is CLOSED at `ed7c320a` and is no longer a limit**:
  the probe `'../struct/[ct]odec.ts'` yielded `importedPaths` `[]`, an empty violations list and `globMatchesAny`
  `false` at `957d9b7d` and at every earlier head, because the hand-written `globToRegExp` escaped `[` and `]`; at
  `ed7c320a` the same probe yields `["../struct/codec.ts"]` and two violations (the migrated family the glob reaches,
  and the pre-existing wrapper report of the same target), and the character class of the review's own example
  (`'../struct/types.[t]s'`) yields `["../struct/types.ts"]` and one violation; (4) **the
  observation about the `base` option of a glob is CLOSED at `957d9b7d` and is no longer a limit**: the probe
  `import.meta.glob('./struct/codec.ts', { eager: true, base: '/src' })` in a module of `src/research/` yielded
  `importedPaths` `[]` and an empty violations list at `63af8a44`, and yields `["../struct/codec.ts"]` and two
  violations at `957d9b7d` (the migrated family the glob reaches, and the pre-existing wrapper report of the same
  target); (5) `createRequire(import.meta.url)('./local')` contributes no specifier - the probe yields
  `importedPaths` `[]` and an empty violations list, because the collector recognises only the identifier `require`
  as the callee of a require call (the control `require('./local')` yields `["./local"]`).
  The `ed7c320a` change lifts the character-class observation and none of the others: the two MDX probes still fail
  closed to the line scanner, which reads them exactly as before, and the `createRequire` probe is untouched by it.
  Each of the six round-6 findings
  and each of the three findings closed at `dc117894` is provably closed at this state instead -
  the CommonJS wrapper re-export chain, the explicit MDX extension, the barrel as a glob candidate, the module-free
  MDX ESM block, the exported alias form and the worker URL query suffix all report violations now (cases 30-35, red
  against the base `394fba68`, green at `d886ddcf`), and the MDX expression collection, the export-assignment re-export
  and the Astro script AST now report violations as well (cases 36, 37, 39 and 40, red against `9daf2b1e`, green at
  `dc117894`), and the hoisted Astro script body and the MDX JSX attribute expression report violations as well (cases
  38 and 40, red against `5b0eaad8`, green at `63af8a44`), and the exported expression and the Vite glob base now
  report violations as well (cases 41 and 42, red against `d4b05448`, green at `957d9b7d`), and the glob matcher and
  the non-JavaScript Astro script body now report violations as well (cases 43 and 44, red against `52c9f0f6`, green at
  `ed7c320a`).
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
- The boundary guard was hardened on top of that red→green pair: the forty-four reviewed items enumerated under
  "Runtime recovery delegations and guard hardening" above (which include the two (F14) assertions) and the cases added
  at `64209924`, `e9009551`, `7907acff`, `f6866e41`, `79c0d7c5`, `dee1f860`, `d886ddcf`, `a832b8ed`, `dc117894`,
  `63af8a44`, `957d9b7d` and `ed7c320a` are
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
    while a real script element yields 1 violation at both heads. **The 0 of the `<pre>` sample at `dc117894` was
    wrong**: Astro hoists and executes a script element inside a `<pre>` sample, so the sample is not a sample of a
    script but JavaScript the component runs. The case and the guard were corrected at `63af8a44` (item 38 below), and
    the `<pre>` sample yields 1 violation again at that state.
  The negative controls of the new cases (a fenced code block, an indented code sample, inline code and an HTML comment
  in MDX; an HTML comment, a `<pre>` sample and a frontmatter string in Astro) pass in the green run; the red run stops
  at the first assertion of each case, so it does not exercise them.
- The hardening at `63af8a44` has its own red→green pair, measured against `5b0eaad8` (the PR #454 head the two
  findings of this batch were raised against): the two changed/new guard cases (the script bodies of an Astro component,
  with the `<pre>`/`<code>` expectation corrected, and the MDX JSX attribute expressions of an MDX document) FAIL against
  the `5b0eaad8` implementation (1 file, 40 tests, 2 failed, 38 passed, exit 1, 11.48 s total: transform 2.12 s, import
  3.23 s, tests 7.89 s; wall time 12.30 s) and PASS at `63af8a44` (1 file, 40 tests, 40 passed, exit 0, 11.58 s total:
  transform 2.14 s, import 3.25 s, tests 7.98 s; wall time 12.44 s). The red run is the `5b0eaad8` guard implementation
  with the two cases of `63af8a44` injected into it, measured in a scratch copy of the file inside this worktree, so the
  reviewed tree itself was not modified to produce it; the scratch copy was deleted afterwards and is not part of the
  reviewed tree. The two case bodies of the red copy are byte-identical to the case bodies at `63af8a44` (verified by
  diffing the two files: the only difference between them is the implementation the two findings change), and the two
  failing assertions at the red state measure the before-state of each finding directly:
  - the Astro script case fails with `AssertionError: expected [] to deeply equal [ '../struct/ids' ]`: the
    `<pre><script>import x from "../struct/ids"</script></pre>` sample yields 0 collected specifiers and 0 violations at
    `5b0eaad8`, and 1 collected specifier and 1 violation at `63af8a44`. The `<code>` spelling behaves the same way.
    The HTML comment and the frontmatter string of the same case yield 0 collected specifiers at `5b0eaad8` and 0 at
    `63af8a44` - the controls that are true stay true.
  - the MDX attribute case fails with `AssertionError: expected [] to deeply equal [ '../struct/ids' ]`: the attribute
    value expression `<Foo bar={import('../struct/ids')} />` yields 0 collected specifiers and 0 violations at
    `5b0eaad8`, and 1 collected specifier and 1 violation at `63af8a44`.
  The negative controls of the two cases (an HTML comment and a frontmatter string in Astro; a plain attribute value,
  the JSX text of an element, a fenced code block, an indented code sample, inline code and an HTML comment in MDX)
  pass in the green run; the red run stops at the first assertion of each case, so it does not exercise them. The
  controls that were true at `5b0eaad8` are not weakened: the only pre-existing expectation that changed is the
  `<pre>`/`<code>` one, and it changed because the compiler's own transform showed it was false.
- The hardening at `957d9b7d` has its own red→green pair, measured against `d4b05448` (the PR #454 head the two
  findings of this batch were raised against): the two new guard cases (an exported expression that uses an imported
  binding, and a Vite glob pattern resolved against a literal base option) FAIL against the `d4b05448` implementation
  (1 file, 42 tests, 2 failed, 40 passed, exit 1, 11.46 s total: transform 2.13 s, import 3.25 s, tests 7.86 s; wall
  time 12.10 s) and PASS at `957d9b7d` (1 file, 42 tests, 42 passed, exit 0, 12.68 s total: transform 2.17 s, import
  3.26 s, tests 9.08 s; wall time 13.55 s). The red run is the `d4b05448` guard implementation with the two new cases
  injected into it, measured in a scratch copy of the file inside this worktree, so the reviewed tree itself was not
  modified to produce it; the scratch copy was deleted afterwards and is not part of the reviewed tree. The two case
  bodies of the red copy are byte-identical to the case bodies at `957d9b7d` (verified by diffing the two files: the
  only difference between them is the implementation the two findings change), and the two failing assertions at the
  red state measure the before-state of each finding directly:
  - the exported-expression case fails with `AssertionError: expected [] to have a length of 1 but got +0`: the probe
    `import { structId } from './ids'` / `export const legacyId = (value) => structId('legacy', value)` in a retained
    wrapper yields 0 violations at `d4b05448` and 1 violation at `957d9b7d`. The probe of the same shape on the five
    forms of the class (an exported arrow function, an exported function declaration, an exported call expression, an
    exported object literal and an exported default expression) yields 0 violations at `d4b05448` and 1 violation each
    at `957d9b7d`, and the control that exports a locally defined binding yields 0 violations at both heads;
  - the Vite glob base case fails with `AssertionError: expected [] to include '../struct/codec.ts'`: the probe
    `import.meta.glob('./struct/codec.ts', { eager: true, base: '/src' })` in a module of `src/research/` collects no
    specifier and yields 0 violations at `d4b05448`, and collects `["../struct/codec.ts"]` and yields 2 violations at
    `957d9b7d` - the migrated family the glob reaches, plus the pre-existing wrapper report of the same target, which
    a direct import of the same family file reports at both heads (2 violations). The same glob that reaches the
    identity family instead (`'./struct/ids.ts'` with the same base) yields 0 violations at `d4b05448` and exactly 1
    violation at `957d9b7d`, because the identity module re-exports no other family.
  The negative controls of the two new cases (a locally defined binding, the retained tree's own re-export of the
  wrapper, a relative pattern without a base, a project-root pattern, an alias pattern, an absolute base, a relative
  base, a base that names no family, a computed pattern and a computed base) pass in the green run; the red run stops
  at the first assertion of each case, so it does not exercise them.
- The hardening at `ed7c320a` has its own red→green pair, measured against `52c9f0f6` (the PR #454 head the two
  findings of this batch were raised against): the two new guard cases (a Vite glob pattern matched with the glob
  matcher Vite uses, and the body of a non-JavaScript Astro script) FAIL against the `52c9f0f6` implementation
  (1 file, 44 tests, 2 failed, 42 passed, exit 1, 12.32 s total: transform 2.18 s, import 3.33 s, tests 8.65 s) and PASS
  at `ed7c320a` (1 file, 44 tests, 44 passed, exit 0, 12.31 s total: transform 2.15 s, import 3.30 s, tests 8.67 s;
  wall time 13.18 s). The red run is the `52c9f0f6` guard implementation with the two new cases injected into it,
  measured in a scratch copy of the file inside this worktree, so the reviewed tree itself was not modified to produce
  it; the scratch copy was deleted afterwards and is not part of the reviewed tree. The two case bodies of the red copy
  are byte-identical to the case bodies at `ed7c320a` (verified by diffing the two files: the only difference between
  them is the implementation the two findings change), and the two failing assertions at the red state measure the
  before-state of each finding directly:
  - the glob-matcher case fails with `AssertionError: expected [] to include '../struct/types.ts'`: the probe
    `import.meta.glob('../struct/types.[t]s', { eager: true })` in a module of `src/research/` collects no specifier and
    yields 0 violations at `52c9f0f6`, and collects `["../struct/types.ts"]` and yields 1 violation at `ed7c320a`. The
    other spellings of the class behave the same way: the negated class `'../struct/types.[!x]s'` and the negated class
    `'../struct/types.[^x]s'` collect no specifier and yield 0 violations at `52c9f0f6` and collect
    `["../struct/types.ts"]` and yield 1 violation at `ed7c320a`, and the class that names the codec family
    (`'../struct/[ct]odec.ts'`) collects no specifier and yields 0 violations at `52c9f0f6` and collects
    `["../struct/codec.ts"]` and yields 2 violations at `ed7c320a`. The brace alternation
    `'../struct/types.{ts,tsx}'` is **not** a red-first pair and is recorded as such: the hand-written brace expansion
    of the old head already reported it, so it collects `["../struct/types.ts"]` and yields 1 violation at `52c9f0f6`
    and the same at `ed7c320a`; the case pins it, so that the replacement of that expansion by the matcher of the
    bundler does not lose the brace alternation;
  - the Astro script case fails with `AssertionError: expected [ '../struct/ids' ] to deeply equal []`: the probe
    `<script type="text/plain">import x from '../struct/ids'</script>` yields 1 collected specifier and 1 violation at
    `52c9f0f6` and 0 collected specifiers and 0 violations at `ed7c320a`, while the real inline module script
    `<script type="module">import x from '../struct/ids'</script>` yields 1 collected specifier and 1 violation at both
    heads, and a script element with no type and an inline script yield 1 violation at both heads as well.
  The negative controls of the two new cases (a negated class that excludes the family, a pattern that names no
  migrated family, a computed pattern, a data block with a `src`, and the data blocks of the real tree) pass in the
  green run; the red run stops at the first assertion of each case, so it does not exercise them.

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
- `astro check` passes (0 errors, 279 hints pre-existing). **That is the dated candidate-frame result (the candidate
  `ae4638ce`) and it is not a claim about the guard state described in this section** - the measured result at the
  guard state `ed7c320a` is the next bullet.
- **`astro check` re-measured at the guard state `ed7c320a`**: `npx astro check` reports 801 files, **1 error** and
  278 hints. The one error is `tests/struct-adapter-boundary.test.ts:1717:38` -
  `ts(2345): Argument of type 'Block' is not assignable to parameter of type 'Expression'` - and it is **pre-existing
  and not introduced by this round**: the same error is at `:1686` of the guard file of the base head `52c9f0f6`, which
  was measured with the same command in the same worktree (801 files, 1 error, 278 hints - the identical result), and it
  was introduced by the round-9 commit `957d9b7d`, which added the `exportedExpressionModules(body, ...)` call of the
  exported-function-declaration form. The 0-error/279-hint figure quoted above is the dated candidate-frame result
  (the candidate `ae4638ce`) and is not a claim about this head; it is stated as such under "Measurement frames". The
  error is recorded here rather than hidden, and it is NOT fixed by this round, which changes only the two findings it
  was asked to close: the code this round adds introduces no diagnostic (the picomatch binding is typed locally, and
  the `isJavaScriptScript` helper is typed with the compiler's own attribute type). Fixing the round-9 type error
  belongs to the round that introduced it and is recorded as a production finding of this round's review, not as
  work of this round.
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
  The round-8 boundary-guard branch `e03/boundary-guard-round8` is based on the PR #454 head `5b0eaad8` and carries the
  guard commit `63af8a44` and that record's commit; against `5b0eaad8` it changes two paths (the boundary guard and the
  dated record, 163 insertions and 22 deletions in the guard file) and against `main` (`5f8c76ab`) it still carries the
  same 14 paths, because both of its paths are already among them. The round-9 boundary-guard branch
  `e03/boundary-guard-round9` is based on the PR #454 head `d4b05448` and carries the guard commit `957d9b7d` and that
  record's commit; against `d4b05448` it changes two paths (the boundary guard and this dated record) and against
  `main` (`5f8c76ab`) it still carries the same 14 paths, because both of its paths are already among them. The
  round-10 boundary-guard branch `e03/boundary-guard-round10` is based on the PR #454 head `52c9f0f6` and carries the
  guard commit `ed7c320a` and this record's commit; against `52c9f0f6` it changes two paths (the boundary guard and
  this dated record) and against `main` (`5f8c76ab`) it still carries the same 14 paths, because both of its paths are
  already among them.
  **No manifest, lockfile, vendor, golden or expected file changed at `ed7c320a`:**
  `git diff 5f8c76ab ed7c320a -- package.json package-lock.json` is empty, `git diff 52c9f0f6 ed7c320a -- package.json
  package-lock.json` is empty, and the guard reaches the MDX toolchain (`unified` 11.0.5, `remark-parse` 11.0.0,
  `remark-mdx` 3.1.1) through the direct `devDependencies` the repository already declares, so no dependency
  declaration was added. The glob matcher of the round-10 change is `picomatch` 4.0.5, which the guard reaches as a
  TRANSITIVE dependency that the lockfile already places deterministically: `vite` 8.1.6 depends on `picomatch`
  ^4.0.5 and `tinyglobby` 0.2.17 depends on `picomatch` ^4.0.4, and `package-lock.json` resolves
  `node_modules/picomatch` to 4.0.5 (integrity
  `sha512-RvwwcruNjI1ncT5xRakeyS9Lf8lcItv34KD+aif+VH9kduAyfYBipGh12274xtenIPZ119/R9BdTBa8gAwSh0A==`).
  No `package.json` entry and no lockfile line was added, removed or changed by the round-10 commit.
- **Census of the new rules at `957d9b7d`** - the rules of the round-9 batch were measured against the real tree before
  they were trusted. The measurement was taken with the guard's own functions over the real tree (426 portable files
  under `src/`, 22 of them in the retained `src/struct` tree):
  - the exported-expression rule adds **0** violations to the real tree: the tree-wide case of the guard reports 0
    violations for every portable file of the tree at `957d9b7d`, exactly as at `63af8a44`. Eleven retained modules do
    export an expression that uses an imported binding - `struct/codec-test-fixtures.ts` (the `ids` binding),
    `struct/codec/bytes.ts`, `struct/codec/invariants.ts` (the `types` binding), `struct/codec/model.ts`,
    `struct/codec/parsers.ts`, `struct/codec/standards.ts`, `struct/consultation-receipt.ts` (the `codec/primitives`
    binding), `struct/epub.ts`, `struct/ids.ts`, `struct/model-consultation-receipt.ts` and `struct/xhtml.ts` - and the
    two of them that reach the authority of a migrated family (`struct/codec-test-fixtures.ts` and
    `struct/codec/invariants.ts`) are imported only from inside the retained tree or from the test tree, so no
    production file reaches a migrated family through them. The retained renderer branch the cutover plan switches to
    the package in E-04 (`struct/epub.ts` and `struct/xhtml.ts`) uses nested modules of the `codec` family
    (`./codec/parsers`, `./codec/primitives`) rather than the authority of a family, so it is not an E-03 escape.
  - the Vite glob base rule adds **0** violations to the real tree as well: **no** portable file of the repository
    calls `import.meta.glob` at all (0 of the 426 scanned files name it), so the base option changes nothing in the
    real tree.
  - the scoping of the new rule is deliberate and is recorded here: the exported-expression rule makes the module an
    exported expression uses a re-export-chain target only when that module is the AUTHORITY of a migrated family (its
    entry module), and the recovery-authority chain keeps its own semantics, because the allowlist of the app-owned
    recovery module names the modules that IMPORT it and a module that uses a permitted importer does not import the
    recovery module itself. A wider rule was measured as well: it makes the real tree report 5 violations (the app
    barrel `src/struct-adapters/index.ts`, the component `src/components/research/PdfEpubReviewQueue.tsx`, the page
    `src/pages/library/index.astro` and the two research modules `src/research/epub.ts` and
    `src/research/reconstruction-materialization.ts`), and every one of them is a planned E-04 item or an artefact of
    the recovery allowlist, so the narrower rule is used and the wider measurement is recorded here rather than hidden.
  **No production file is a violation because of the findings of this batch or of the earlier ones, and no assertion was
  weakened to hide one.**
- **Census of the new rules at `ed7c320a`** - the rules of the round-10 batch were measured against the real tree
  before they were trusted. The measurement was taken with the guard's own functions over the real tree (426 portable
  files under `src/`, 22 of them in the retained `src/struct` tree, 39 of them `.astro` files):
  - the glob-matcher rule adds **0** violations to the real tree: **no** portable file of the repository calls
    `import.meta.glob` at all (0 of the 426 scanned files name it - the only occurrences of the call in the repository
    are in the guard file itself and in this record), so the matcher the guard now uses changes nothing in the real
    tree. The rule is a widening of the guard's own resolution, not a new prohibition: a pattern that the bundler
    resolves to a migrated family is now reported, and no production file names one;
  - the non-JavaScript Astro script rule adds **0** violations to the real tree: the 39 `.astro` files of `src/` hold
    18 script elements, 13 of them with no `type` and 5 with a type that is not a JavaScript type
    (`application/json` four times, `application/ld+json` once, in `src/components/Head.astro`,
    `src/pages/books/[book]/[node].astro` and `src/pages/books/[book]/map.astro`). All five are data blocks whose
    body is set with `set:html`, so they carry no text child at all and the rule changes nothing for them. The rule can
    only REMOVE a violation - a data block that names a migrated family in its body is not executed and is not an
    escape - and no data block of the tree names one.
  The tree-wide case of the guard ("E-03: prohibits migrated-family imports ...") reports 0 violations for every
  portable file of the tree at `ed7c320a`, exactly as at `957d9b7d`. **No production file is a violation because of the
  findings of this batch or of the earlier ones, and no assertion was weakened to hide one.**
- **Census of the new rules at `63af8a44`** - the rules of the round-8 batch were measured against the real tree before
  they were trusted, and each of them adds 0 violations to it. The MDX census: all 115 tracked `.mdx` files parse with the
  MDX processor (0 parse failures), and the collector of `63af8a44` collects **1** expression in the whole tree, against
  **0** expressions with the collector of `5b0eaad8`: the one expression is the attribute value expression
  `(globalThis.__mustNotRun = true)` of `tests/fixtures/publication/astro/unsupported-component.mdx`, it names no module,
  and the file contributes 0 violations. The 115 files contribute 0 violations in total, and the tree-wide case of the
  guard ("E-03: prohibits migrated-family imports ...") reports 0 violations for every portable file of the tree. The Astro
  census: all 39 tracked `.astro` files parse with the Astro compiler (0 parse failures) and they hold 18 script
  elements, **none of them inside a `<pre>` or a `<code>` element**, so the hoisted-script rule of `63af8a44` collects the
  same 18 script bodies as before and contributes 0 new specifiers and 0 violations. The retained-tree census of the
  earlier batch is unchanged: the 26 tracked files of the retained `src/struct` tree hold no `export =` assignment and no
  computed require, so the export-assignment rule contributes 0 violations. **No production file is a violation because of
  the findings of this batch or of the earlier one, and no assertion was weakened to hide one.**
