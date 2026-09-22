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
test, and it fails on every agent run, because an agent run is dirty by
construction.

Separate the two questions, using the pattern this checker already uses for
route parity.

**Scope, stated up front.** This fixes the conformance check in the `test`
lane only. It does **not** unblock the `build` lane, which fails for a
different reason on the same underlying cause -- see below. Landing this alone
does not make an agent run pass.

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
  files and 0 errors and 133 pages built, and validation still failed. The run
  ended `rucksack-blocked` + `rucksack-needs-human` with no code committed, and
  its worker correctly refused both available workarounds — weakening the
  assertion, and adding a `scripts/` wrapper to evade the command allowlist.
- **Two different lanes fail, on two different code paths, from the same dirty
  tree.** They are worth keeping apart:
  - The `test` lane fails in `tools/publication-adapter-conformance.test.mjs`,
    under `context: 'adapter-conformance'`. **That is what this issue fixes.**
  - The `build` lane runs `npm run build` -> `build:production`
    (`package.json:17-19`), which ends with `publication:build` and
    `publication:check` over a real entry, with **no** conformance context. That
    is the ordinary publication path, and criterion 4 below deliberately keeps
    it rejecting dirty trees. This issue does not and must not change it.
- So this is not specific to #322 — the conformance half blocks every issue
  dispatched here — but fixing it is necessary, not sufficient.

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
6. `tools/publication-adapter-conformance.test.mjs` passes with an actually
   dirty working tree in this repository. Demonstrate against a real dirty
   tree, not a fixture.
7. The `build` lane is explicitly **out of scope** and is expected to keep
   failing on a dirty tree after this lands. Do not change `package.json`'s
   `build:production`, `publication:build` or the ordinary `publication:check`
   path to make it pass.

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

**What actually unblocks an agent run is the other issue, not this one.**
`build:production` publishes a real artifact during validation, and a real
publication receipt should bind to a clean commit — that requirement is
correct and this issue keeps it. The only way to satisfy it under the harness
is for the tree to genuinely be clean at a real commit, which is what Rucksack
committing the agent diff before validation achieves. That is filed against
`erniesg/rucksack` and it is the change that makes agent runs pass here.

This issue remains worth landing on its own terms: an adapter-equivalence test
should never have asserted a clean tree, it is one of the `test` lane's
failures, and it stays correct regardless of how the harness commits. It is
just not the unblocker, and the earlier draft of this spec wrongly claimed it
was.

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
