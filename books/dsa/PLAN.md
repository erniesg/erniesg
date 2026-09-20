# The Rucksack Book of Data Structures & Algorithms — Plan

An executable book that teaches DSA from zero while building, chapter by
chapter, the ideas behind a Rucksack-native context engine (identifier
indexes, inverted indexes, code graphs, routing, budgeted context packing,
learning policies). Every chapter is a test-driven coding challenge with
automatic marking. The book compiles to EPUB, runs online, is edited on an
ongoing basis through the ernie.sg research pipeline, and is versioned.

## Ground rules

### Naming policy (fictional universe only)

All worked scenarios use the **fictional Meridian Times newsroom**. Book
content, code, tests, fixtures, and diagrams must never reference real
employer systems, real internal repositories, real service names, or real
environment variables. The fictional cast:

| Fictional name  | Role in scenarios                                  |
| --------------- | -------------------------------------------------- |
| Meridian Times  | The newsroom / organisation                        |
| Compass         | The CMS the newsroom writes in                     |
| Prosecheck      | Grammar/spelling microservice                      |
| Sideboard       | Asset & embeds service                             |
| Deskmate        | The newsroom's AI editing assistant                |
| `PROSE_UPSTREAM`| Example env var used in debugging scenarios        |

Rucksack itself is real and fine to name — it is the open project this book
builds toward.

### No premature porting

The learner is **not** expected to jump from coding challenges into Rucksack
integration. Parts I–II are plain standalone Python: one file, stdlib only,
run by the book's grader. The book itself teaches the porting path through
explicit **interlude chapters**:

- **Interlude A** (end of Part I): from single files to a proper package —
  `pyproject.toml`, src layout, `uv`, pytest, type checks.
- **Interlude B** (end of Part III): setting up Rucksack properly —
  `rucksack init`, `doctor`, worktrees, the VM runner, evidence discipline.
- **Interlude C** (inside Part V): porting your index and packer into a
  Rucksack-native module, with the same tests carried over.

Until an interlude says otherwise, chapters have zero Rucksack dependency.

### Testing doctrine (every challenge is tested)

Modeled on the UCSD/Coursera algorithms course style ("Ace Your Next Coding
Interview by Learning Algorithms"): each challenge states input format,
constraints, and a time limit, and is graded in four tiers, run in order,
stopping at the first failure:

1. **public** — small, visible examples. Correctness of the happy path.
2. **edge** — hidden-style boundary cases: empty input, duplicates,
   negatives, unicode, minimum/maximum constraint values.
3. **stress** — hundreds of randomized rounds comparing the learner's fast
   solution against a brute-force reference implemented in the test. This is
   how the course caught the classic max-pairwise-product bug, and how we
   catch yours.
4. **perf** — one huge generated input (10^5–10^6 scale) under a wall-clock
   time limit enforced by the grader. A correct-but-quadratic solution fails
   here on purpose.

Reference solutions live in each chapter's `solution/` directory and must
pass all four tiers in CI (`runner.py verify`). Time limits are chosen with
≥5× headroom for the reference solution on a laptop.

### TDD loop for the learner

`start` a chapter → read `chapter.md` → run the grader and watch it fail
(red) → implement in `books/dsa/workspace/<ch>/` → re-run until green tier by
tier → quiz yourself → move on. The grader never edits your code; you never
edit the tests.

## Book outline

Six parts, ~40 chapters plus interludes. Chapter numbering is stable; slugs
are `chNN-kebab-title`.

### Part I — Learning to measure
1. What an algorithm actually is *(authored — runnable)*
2. Tests as executable definitions *(authored — runnable)*
3. Counting work: Big-O without the maths fog *(authored — runnable)*
4. Arrays, strings, files, and sequential scanning
5. Sets and hash maps: exchanging memory for speed
   — **Milestone:** a tiny exact identifier index.
   — **Interlude A:** from scripts to a package.

### Part II — Building retrieval
6. Tokens and normalization
7. Inverted indexes and posting lists
8. Set intersection for multi-term search
9. Sorting, scoring, and top-k retrieval
10. Stacks and parsing nested source code
11. Trees, syntax trees, and source ranges
12. Graphs, dependencies, callers, and callees
13. BFS and bounded graph expansion
   — **Milestone:** retrieve definitions, references, tests, and one-hop
     dependencies without reading entire files.

### Part III — Making it survive real repositories
14. Persistent indexing with SQLite and B-trees
15. File hashes and incremental updates
16. Immutable indexes per Git commit
17. Worktree overlays and invalidation
18. Memory limits, caching, and LRU eviction
19. Concurrency and deterministic merging
20. Measuring index time, RSS, latency, and recall
   — **Milestone:** index a large repository on a constrained VM.
   — **Interlude B:** setting up Rucksack properly.

### Part IV — Routing across an organisation
21. Why repository search cannot find an unknown repository
22. Service catalogs and repository metadata
23. Typed relationships: calls, deploys, owns, configures
24. Multi-repository graphs
25. Routing from error → service → deployment → repository → symbol
26. Confidence, freshness, permissions, and missing evidence
27. Runtime evidence from logs, traces, manifests, and deployed SHAs
   — **Milestone:** reproduce the Meridian Times investigation: a bad
     `PROSE_UPSTREAM` value routes from a Compass bug report through
     Prosecheck and Sideboard to the responsible line of config.

### Part V — Context as an optimization problem
28. Token budgets and context receipts
29. Greedy context packing
30. Knapsack and maximum-coverage intuitions
31. Redundancy and marginal information gain
32. Deterministic retrieval recipes
33. Pareto frontiers: success, tokens, latency, and memory
   — **Interlude C:** porting your engine into Rucksack.
   — **Milestone:** measured savings against disciplined `rg` + file reads.

### Part VI — Learning policies
34. Logging decisions without fooling yourself
35. Supervised ranking
36. Exploration versus exploitation
37. Contextual bandits
38. Offline policy evaluation
39. User-specific preferences without overfitting
40. Safe fallbacks and policy rollback
   — **Milestone:** adaptive retrieval recipes with deterministic replay.

### Final project
The complete context engine: task → router → repos at exact commits →
identifier/structure/graph retrieval → budgeted packer → agent → tests →
evaluation record → optional policy learning.

## Chapter anatomy

```
books/dsa/chapters/chNN-slug/
  chapter.md        # narrative, challenge spec, quiz (EPUB/web source)
  exercise.toml     # id, title, module, tier XP, time limits
  starter/          # what `runner.py start` copies into your workspace
  solution/         # reference solution; must pass verify in CI
  tests/
    test_public.py
    test_edge.py
    test_stress.py
    test_perf.py
```

`chapter.md` is the single authoring source for print, web, and grader
metadata cross-checks. Tests import the learner's code only through
`bookgrader.load_solution(...)`, which reads `BOOK_SOLUTION_DIR` — the same
tests grade the workspace, the reference solution, and (later) web
submissions.

## Grader (`books/dsa/tools/runner.py`)

Stdlib-only, Python ≥3.11 (needs `tomllib`).

```
python3 books/dsa/tools/runner.py list            # chapters, status, XP
python3 books/dsa/tools/runner.py start ch01      # copy starter → workspace
python3 books/dsa/tools/runner.py run ch01        # grade tiers in order
python3 books/dsa/tools/runner.py verify ch01     # grade reference solution (CI)
python3 books/dsa/tools/runner.py status          # XP, badges, streak
```

Each tier runs in a subprocess with a hard timeout; exceeding it reports
`TIME LIMIT EXCEEDED` rather than hanging. Progress persists to
`books/dsa/.progress.json` (gitignored).

## Gamification

- **XP per tier** (declared in `exercise.toml`; defaults 10/15/20/25) —
  awarded once, on first pass.
- **Badges:** `first-green` (first fully green chapter), `stress-buster`
  (first stress tier passed), `big-input-slayer` (first perf tier passed),
  `part-i-summit` … `part-vi-summit` (all chapters in a part green).
- **Streak:** consecutive calendar days with at least one tier newly passed.
- Progress is a plain JSON ledger — inspectable, resettable, and honest: XP
  is only granted by passing tests, never by reading.

## Publishing pipeline (phased)

- **Phase 0 (done):** the local publication is the standalone executable
  Rucksack reader; chapters are graded locally. It does not simulate the
  Ernie.SG Study library or inline blog rendition.
- **Phase 1a (done):** `books/dsa/tools/export.py` emits a self-contained,
  reflowable EPUB 3 with cover, title page, preface, navigation, and authored
  chapters from the same Markdown sources.
- **Phase 1b — Study integration:** publish the same metadata, Markdown, and
  EPUB artifact at `/study/dsa`, built directly from this in-repo source
  (#70). The Study index groups entries by kind; the URL carries only the
  slug. Do not couple this book to the active PDF semantic reconstruction
  implementation.
- **Phase 2 — Web (runnable online):** the blog's web edition at
  `/study/dsa/practice` embeds an editor + Pyodide test runner reusing the
  same `tests/` files, running learner code in the browser (never on a
  server), with
  progressive hints and the "why it failed" explanations (e.g. "correct
  result, but your lookup opened 8,714 files").
- **Phase 3 — Rucksack lab:** exercises optionally run against disposable
  exact-head repositories via Rucksack's VM runner (post Interlude B).

## Versioning

- `books/dsa/VERSION` holds the edition (semver; starts 0.1.0). `CHANGELOG.md`
  records chapter additions and breaking spec changes.
- Chapter specs are append-mostly: once published, a challenge's constraints
  and tier semantics only change with a minor version bump and a changelog
  entry, so learner progress stays meaningful.
- Git is the history; the EPUB export stamps the edition on the title page.

## Definition of done

Per chapter:
- `chapter.md` (narrative + spec + constraints + time limit + quiz),
  `exercise.toml`, starter, solution, all four tier tests present.
- `runner.py verify chNN` exits 0 (reference passes every tier).
- `runner.py run chNN` on an untouched starter fails the public tier with a
  readable message (the red state is part of the product).
- No real-workplace names anywhere in the chapter (naming policy above).

Per release (edition bump):
- All authored chapters verify green.
- `python3 books/dsa/tools/test_runner.py` (grader's own unit tests) passes.
- Site suite `npm run test` and `npm run build` still pass — the book is
  additive and must never break Ernie.SG.
- CHANGELOG updated; VERSION bumped.

## Immediate roadmap

1. **Done in this branch:** grader + tests, chapters 1–3 runnable, this plan.
2. Author ch04–ch05 and the Part I milestone (identifier index) + Interlude A.
3. Publish the existing EPUB and web publication through Ernie.SG Study at
   `/study/dsa` (#70); its universal-publication dependencies have landed.
4. Draft Part II (the inverted-index arc from the sample chapter).
