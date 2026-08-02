# Source/output checkpoint evidence

SRT visual changes are reviewed as a source page beside the rendition a reader
receives. The fixture command is:

```bash
npm run srt:checkpoint-evidence
```

It reads the repository-owned checkpoint set at
`tests/fixtures/pdf/source-output-checkpoints.json`, renders the named source
page with PDF.js, builds the deterministic EPUB through the normal export entry
point, and captures the resulting rendition at the named target profile width.
The output is written to `.agent/evidence/srt-checkpoints/`; its `README.md`
is the review index and `checkpoint-manifest.json` records the artifact hashes and
fail-closed checkpoint results.

The machine-readable shape is
`docs/schemas/source-output-checkpoints.schema.json`. Each checkpoint must
name a document, page, profile, reviewer-visible property, criterion, source
feature, and rendition feature. The TypeScript validator additionally binds
each property to its expected rendition feature and rejects duplicate IDs. A
pair fails when the source page is missing readable/visual evidence, the
profile is wrong, the rendition is empty, or the named structure is absent. An
image file by itself never passes a checkpoint.

For an owner-local paper, provide a caller-owned output directory outside the
repository. Local output is never written to Git or the PR evidence directory:

```bash
node tools/srt-source-output-evidence.mjs \
  --document /absolute/local/paper.pdf \
  --checkpoints /absolute/local/checkpoints.json \
  --struct /absolute/local/paper.struct.json \
  --output /absolute/local/source-output-review
```

The local STRUCT must carry the same source SHA-256, basename, and byte length
as the selected PDF; this prevents a checkpoint from passing against a
fabricated or unrelated rendition. The local manifest contains only the input
basename, digest, dimensions, and checkpoint outcomes. The generated images
remain in the caller-named local directory. The checked-in fixture flow is the
required evidence lane for SRT pull requests.
