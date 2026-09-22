# Adapter conformance must not require a clean working tree

## Provider

claude

## Goal

`publication-adapter-conformance` asks one question: do the Astro and Payload
adapters produce the same canonical semantics? It answers that question by
rendering fixtures into a throwaway staging directory and comparing two
receipts. It publishes nothing durable.

Today it also, incidentally, asserts that the whole repository working tree is
clean. That assertion belongs to a real publication, not to an equivalence
test, and it makes the `build` validation lane unsatisfiable for every agent
run in this repository.

Separate the two questions, using the pattern this checker already uses for
route parity.

## Observed failure

- `tools/publication-check.mjs:1146` asserts
  `receipt.repository?.dirty === false && !currentDirty`. `currentDirty` comes
  from `publicationRepositoryForCurrentCheckout`
  (`tools/publication-build.mjs:858`), which runs
  `git status --short --untracked-files=all` over the whole repository minus
  invocation-owned staging.
- A Rucksack worker's entire output *is* an uncommitted working-tree diff —
  `provider-result.json` classifies it `uncommitted-changes`. So the tree is
  dirty by construction for the whole of every agent run.
- The worker cannot make the tree clean by committing. Its sandbox binds
  `/mnt/repo.git` read-only and `/mnt/workspace/.git` is a pointer reading
  `gitdir: /mnt/repo.git/worktrees/<name>`, so the object store is read-only
  by design: Rucksack owns the commit, not the agent.
- Result, observed on issue #322 on 2026-09-21: `astro check` reported 618
  files and 0 errors and 133 pages built, but the `build` lane still failed on
  this gate alone. The run ended `rucksack-blocked` + `rucksack-needs-human`
  with no code committed, and its worker correctly refused both available
  workarounds — weakening the assertion, and adding a `scripts/` wrapper to
  evade the command allowlist.
- This is not specific to #322. It blocks every issue dispatched into this
  repository.

## Success criteria

1. In the `adapter-conformance` context, `publicationCheck` no longer requires
   the current working tree to be clean. The conformance run passes against a
   dirty tree.
2. The receipt still records `repository.dirty` **truthfully**. Nothing
   suppresses, normalises or rewrites the observed value. A test asserts that a
   conformance receipt produced from a dirty tree records `dirty: true`.
3. A two-way binding, mirroring the existing route-parity one at
   `tools/publication-check.mjs:76-86`:
   - a receipt that declares the relaxed cleanliness binding is accepted
     **only** when `options.context === 'adapter-conformance'`;
   - the `adapter-conformance` context **requires** that declaration.
   Each direction has its own test, and each test fails if its direction is
   removed.
4. Every non-conformance path is unchanged: a real publication still requires
   `receipt.repository.dirty === false && !currentDirty`. A test asserts that
   a conformance-shaped receipt is rejected by the ordinary publication check,
   and that a dirty tree still fails an ordinary publication check.
5. `receipt.repository.commit === currentCommit` continues to be asserted in
   every context, conformance included. Relaxing cleanliness must not relax
   commit binding.
6. `scripts/agent-evidence` completes its `build` lane on a dirty tree in this
   repository. Demonstrate with an actual dirty working tree, not a fixture.

## Artifact outputs

Changes in `tools/publication-check.mjs` and, if the receipt gains a field,
`tools/publication-build.mjs`; tests in the existing
`tools/publication-check.test.mjs` and `tools/publication-build.test.mjs`.

## Stop conditions

Stop before changing `publicationRepositoryForCurrentCheckout` or the
`cleanlinessExclusions` machinery. That code verifies an excluded directory
still matches its recorded inode, uid, gid and mode, and forces `dirty: true`
on any rejected exclusion. It is doing its job and is not the problem here.

Stop before narrowing the cleanliness check to "the artifact's source input
paths". That sounds tighter and is weaker: reproducibility depends on the
tooling as much as the inputs, and a dirty `tools/publication-build.mjs`
would change the output while an inputs-only check still called it clean.

Stop before touching the `build` lane's command, `.agent/commands.yaml`, or
anything under `scripts/`, to make the gate pass by routing around it.

Stop before making any change that would let a receipt produced under the
relaxed binding reach a real publication path.

## Human clarification protocol

If the two-way binding cannot be expressed without adding a field to the
receipt schema, stop and report the proposed field and its validation before
writing it. The receipt is provenance evidence and its shape is not an
implementation detail.

## Recommended response

Follow the route-parity precedent closely rather than inventing a second
mechanism. `routeParity === 'adapter-conformance'` is already a value that
only the conformance context accepts and that the conformance context
demands; the cleanliness binding wants exactly that shape, and a reviewer who
knows one will then already understand the other.

## Trade-offs

The alternative is for Rucksack to commit the agent's diff to its branch
before running validation, which would fix this for every repository rather
than only this one. That is the better long-term answer and is filed
separately against `erniesg/rucksack`. It is also a much larger change to the
harness. This issue is the local fix that unblocks this repository now, and it
remains correct afterwards: a conformance test should not have been asserting
a clean tree regardless of how the harness commits.

## Free-form response

The thing worth preserving here is why the current assertion exists. A
publication receipt that says `commit: X, dirty: false` is a promise that you
can check out `X`, re-run, and get the same artifact. That promise is real and
this issue does not touch it.

What this issue says is narrower: the conformance test never made that
promise. It renders two fixtures and compares them. Whether some unrelated
file in the tree is dirty tells you nothing about whether the two adapters
agree — and the checker already knows this test is different, which is why
the route-parity policy has a conformance-only value. Cleanliness was simply
never given the same treatment.
