# Table-candidate provider benchmark

The table-candidate path is a trusted local operator lane. The browser importer
does not load a model, invoke a process, or send a source path or extracted
text to a provider. Deterministic reconstruction remains the default and is
the publication fallback.

## Pinned provider configuration

An operator may opt into the local Docling/TableFormer adapter with a JSON file
whose identity fields are all pinned before the run:

```json
{
  "provider": "docling-tableformer",
  "command": "/private/operator/bin/docling-tableformer",
  "args": ["--json-stdio"],
  "version": "2.48.0",
  "modelDigest": "<64 lowercase hex characters>",
  "adapter": {
    "id": "docling-tableformer-adapter",
    "version": "1.0.0",
    "sha256": "<64 lowercase hex characters>"
  },
  "runtime": {
    "id": "docling-python",
    "version": "2.48.0",
    "sha256": "<64 lowercase hex characters>"
  },
  "configuration": {
    "mode": "accurate",
    "threads": 2
  }
}
```

The placeholders above are deliberately not runnable values. The operator
must replace them with digests obtained from the exact adapter, model, and
runtime that will run. The process receives only a bounded page-crop image,
its media type, and its SHA-256. It must return a JSON candidate conforming to
the provider contract; all provider text is discarded after source verification.

The provider is disabled unless both a configuration file and the explicit
opt-in flag are supplied. An omitted provider therefore exercises the same
deterministic path used by the browser:

```bash
node tools/pdf-table-candidate-benchmark.mjs \
  --corpus-id bookworld-v1 \
  /private/bookworld/deterministic-set
```

For an opt-in provider run, use the same input set and the pinned configuration:

```bash
node tools/pdf-table-candidate-benchmark.mjs \
  --corpus-id bookworld-v1 \
  --table-candidate-opt-in \
  --provider-config /private/operator/docling-tableformer.json \
  --source-render-evidence /private/bookworld/source-render-evidence.json \
  --out /private/bookworld/bookworld-v1-report.json \
  /private/bookworld/deterministic-set
```

The command reports three paths over one denominator:

- `deterministic`: the existing source-proven deterministic detector and image
  fallback;
- `provider`: candidate-only proposals, before source verification; and
- `verifiedProvider`: provider candidates that pass exact source-run ownership,
  text, geometry, and table-span checks and are then canonicalized.

Candidate-only counts are diagnostic and are never publication evidence. A
provider result is usable only when its receipt includes the pinned adapter and
runtime identities and its verified grid retains exact
`{regionId,lineId,runIndex}` ownership for every non-empty cell. Grouped
headers, row/column spans, wrapped continuations, duplicate ownership, and
moved ownership fail closed. The image fallback remains available when a
candidate is absent or fails verification.

## BookWorld and held-out evidence

The issue gate requires fresh evidence from the real private BookWorld corpus,
not the checked-in fixtures. Run the deterministic and provider reports on the
same BookWorld denominator, then repeat the command with a source-disjoint
held-out set and the same pinned identities. Do not copy counts between runs or
describe candidate-only counts as verified coverage.

`--source-render-evidence` attaches an operator-produced JSON receipt with this
shape; the tool validates its presence and records its hash but does not invent
source/render comparisons:

```json
{
  "documents": [
    {
      "sourceSha256": "<source PDF SHA-256>",
      "renderSha256": "<rendered page-set SHA-256>",
      "pages": [1, 2]
    }
  ]
}
```

The required completion packet therefore contains, for both the BookWorld and
held-out sets, the exact commit, corpus/document hashes, provider receipt
identities, deterministic/provider/verified-provider counts, and the
source-versus-render receipt. This checkout has no private BookWorld PDFs,
provider executable/model cache, or held-out receipt, so it cannot honestly
claim those real-world numbers. The implementation and command are ready for
the owner-controlled run; the real-corpus evidence remains the final gate.
