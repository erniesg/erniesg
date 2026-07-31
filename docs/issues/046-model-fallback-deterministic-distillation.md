# Use model intelligence only where evidence runs out, and distill it into deterministic rules

depends-on: 036,041,045

## Provider

vm-codex

## Goal

Handle unseen papers' edge cases with model assistance under issue 041's grounded rules — the model proposes structure only where deterministic evidence leaves a decision open, and never authors text — while every model decision is recorded so it can be distilled into a fixture plus a deterministic rule, making the pipeline measurably less model-dependent over time.

## Observed failure

Every deterministic fix to date was fitted to the paper that motivated it (98 named thresholds, 268 magic numbers, 392 regexes, zero real held-out papers), so unseen layouts keep failing in new ways, and there is no mechanism that turns a one-off repair into a general rule. Meanwhile genuinely ambiguous cases — a caption that geometry cannot bound, a note marker with two candidate bodies — currently just fail closed with no path to resolution short of hand-patching.

## Acceptance tests

- A model consultation happens only when a named deterministic decision point reports insufficient evidence; the decision class, inputs, and open candidates are recorded before the model is asked. Consultations are per-decision, not per-document.
- The model may choose among deterministically proven candidates, associate, order, and label; it may never emit text, author asset bounds or bytes, or introduce a candidate the deterministic layer did not produce — enforced by the issue 041 verifier, with a test proving an out-of-candidate-set response is rejected and falls back to review-required.
- Every consultation is a provenance record: decision class, model identity and digest, prompt hash, candidates offered, choice made, and cost — persisted in the receipt and queryable per document and per class. Byte-stability holds: the same source, model identity, and prompt hash reproduce the same choice or the mismatch is a named failure.
- A distillation ledger aggregates consultations by decision class; each entry carries at least one generated fixture reproducing the ambiguity. Landing a deterministic rule for a class must flip its fixtures from model-consulted to deterministically-decided and drive that class's consultation count to zero — asserted by test.
- The per-document model-consultation rate is a first-class metric in PR evidence, reported per decision class; the pipeline runs with model assistance disabled by default and everything then falls back to today's fail-closed behavior — model use is owner opt-in per run.
- Fixtures cover at least three decision classes observed on the corpus (candidate-ambiguous caption association, ambiguous note-marker match, reading-order tie), each with: the ambiguity, the model path resolving it, the rejection path, and a distilled deterministic rule retiring one class end to end as the reference example.

## TDD sequence

1. **Red:** fixtures for the three decision classes failing closed today; a test that the consultation gate refuses when evidence is sufficient.
2. **Green:** the consultation gate, candidate-constrained proposal interface, and provenance records behind the issue 041 verifier.
3. **Red then green:** the distillation ledger and the reference distillation retiring one class.
4. **Refactor:** none beyond what the verifier interface requires; this issue must not modify deterministic extraction logic except via its one reference distillation.

## Exact-head definition of done

- With model assistance off, behavior is unchanged from `main`. With it on, the three fixture classes resolve with full provenance, the out-of-set rejection test passes, and one class is demonstrably retired to deterministic code with its consultation count at zero.
- From a clean checkout of the immutable PR head, `scripts/agent-evidence --all` records `commit` equal to that head, `dirty: false`, and `result: passed`.

## Validation command

```bash
npx vitest run src/struct/struct.test.ts src/research/epub.test.ts
npm test
npm run build
```

## Allowed secrets

A model credential is required for the opt-in path only and is explicit owner opt-in. It never enters the repository, logs, receipts, issues, or PR comments. Source content leaving the machine follows issue 041's boundary: remote-model arms run only under explicit opt-in and the receipt records that they did. Tests use a recorded/stub model client; CI never holds a live credential.

## Artifact outputs

A consultation gate with per-class provenance records, a candidate-constrained proposal interface behind the 041 verifier, a distillation ledger with generated fixtures, one reference distillation, and consultation-rate reporting in PR evidence.

## Stop conditions

Stop before letting model output bypass the verifier, consulting without a recorded decision class, shipping with model assistance on by default, or counting a distillation as done while its fixtures still consult.

## Human clarification protocol

If two decision classes turn out to be one underlying ambiguity, merge them in the ledger and say so; do not double-count retirement progress.

## Recommended response

Build the consultation gate as a wrapper over existing fail-closed decision points so the deterministic path stays the only path when the model is off; the distillation ledger is then just structured logging of what the wrapper saw.

## Trade-offs

Per-decision consultation costs more calls than one whole-document prompt but keeps each answer verifiable against its candidate set — and the recorded classes are precisely the curriculum for retiring the model, which whole-document prompting can never produce.

## Free-form response

This is the ratchet: intelligence handles what evidence cannot yet decide, every use of it is a logged confession of a missing rule, and the ledger converts confessions into fixtures until the deterministic layer has learned the corpus.
