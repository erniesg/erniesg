# Extraction architecture bake-off

Issue 95 defines two candidate owners for semantic extraction:

- **LLM-authored** receives source runs and a page rendition and proposes the
  whole structure.
- **LLM-grounded** receives the same source plus only deterministic artifacts
  that have already been proved (region lanes, table scopes, line boundaries,
  note/citation relationships, and source-run provenance).

Both candidates use the shared verifier in
[`src/research/structured-extraction.ts`](../../../src/research/structured-extraction.ts).
The verifier is the authority for text, source spans, assets, and alt text:

- every emitted node is rebuilt from source-run IDs;
- a mismatch, unknown run, duplicate span, or unaccounted boilerplate run
  rejects the complete candidate and invokes the deterministic fallback;
- figures and diagrams can reference only deterministic asset IDs; bytes and
  bounds are never candidate fields;
- figure alt text is rebuilt from the source-backed caption and is never read
  from image content or a model string.

## Reproduction

The runner takes a development/held-out corpus binding and three adapters
behind one interface. It reports per-stratum and per-layout scores, verifier
failures, disagreements, latency/page, cost/page, model identity, model digest,
and prompt hash:

```bash
npm run pdf:extraction:bakeoff
```

The checked-in self-test is synthetic and contains no paper bytes. An owner-
local run should supply the same source-run context and hash-pinned held-out
split from issue 037, plus the named source/output checkpoints from issue 038.
The report schema is
[`docs/schemas/extraction-bakeoff-report.schema.json`](../../../docs/schemas/extraction-bakeoff-report.schema.json).

The runner passes no ground-truth labels to an adapter, permits tuning only on
`development`, scores each held-out candidate identity once, and rejects a
proposal carrying `gold`, `expected`, reviewer labels, or equivalent fields.
The second invocation for a fixed source, identity, and prompt is compared to
the first; a byte-unstable candidate is disqualified.

## Decision record

The deterministic geometric path remains the verifier and fail-closed fallback
in every arm. The grounded interface is the repository's safe model-assisted
owner: it can propose structure only where source artifacts leave a decision
open, while the verifier owns every emitted span and asset association. The
authored interface remains an experimental comparison arm and cannot become an
authority merely by scoring higher.

This is a safety/ownership decision, not a claim that the synthetic self-test
has evaluated private papers. A promotion or reversal requires a new
hash-pinned held-out split scored once per candidate version. The winning arm
must improve the affected stratum and layout without regressing another
stratum, and any unverified span, model-authored alt text, or model-authored
asset geometry disqualifies it regardless of aggregate score. If arms win
different strata, the report is presented for an explicit hybrid decision
instead of silently selecting a global winner.
