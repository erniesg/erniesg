# Headless PDF export and corpus benchmark

The headless command uses the same Vite-loaded PDF reconstruction,
completeness gate, composition policy, target profiles, EPUB builder, and
`inspectEpub` checks as the browser studio:

```bash
npm run pdf:export -- paper.pdf \
  --target paperPro \
  --target paperProMove \
  --out ./local-export
```

Both targets are the default when `--target` is omitted. A directory input is
walked deterministically without following symbolic links. A single input puts
`publication-paperpro.epub`, `publication-papermove.epub`,
`export-manifest.json`, and `checksums.sha256` directly in the output directory.
Corpus inputs use one basename-and-hash directory per document so equal
basenames cannot collide.

The command always writes `corpus-audit.json`. It reports ready,
review-required, and failed counts, pass rate, and gate-code failure buckets.
It exits `1` if any document is not ready and never builds or writes an EPUB for
that document. Reports contain basenames, hashes, metrics, redacted diagnostics,
and artifact metadata only—never source text or local paths. They contain no
timestamps or other volatile fields, so identical inputs produce byte-identical
reports and artifacts with compatible pinned runtimes.

Run the benchmark without exporting with:

```bash
npm run pdf:corpus-audit -- ./local-pdf-corpus
```

Those commands remain ad-hoc by default. Frozen or seeded-random evidence must
opt into the checked-in corpus contract with both arguments:

```bash
npm run pdf:corpus-audit -- --report-only \
  --corpus-contract benchmarks/pdf/corpus-contract-v1.json \
  --corpus-set frozen \
  "$SRT_PRIVATE_PDF_FROZEN_10"

npm run pdf:export -- "$SRT_PRIVATE_PDF_FROZEN_10" \
  --corpus-contract benchmarks/pdf/corpus-contract-v1.json \
  --corpus-set frozen \
  --target mobile \
  --target paperProMove \
  --target paperPro \
  --out /tmp/srt-frozen-export
```

Use `--corpus-set seededRandom` only for the contract's distinct seeded sample.
The option pair validates the contract itself and then requires exactly the ten
ordered public ids with their pinned byte lengths and SHA-256 values. Missing,
extra, renamed/wrong-version, swapped, or changed files abort before audit or
artifact publication. A valid report adds only the contract schema, set key and
id, whole-contract SHA-256, ordered document identities, and their canonical
identity SHA-256. The benchmark comparator requires both reports to carry the
same binding; it refuses one-sided or mismatched frozen/random evidence.

## Validation

Every artifact passes `inspectEpub` and its canonical-node, relationship, and
manifest-reference invariants before it is written. If an `epubcheck` command
is already on `PATH`, the command runs it locally with `--failonwarnings`. With
Java and a separately installed EPUBCheck JAR, set `EPUBCHECK_JAR` for that
invocation; the JAR path is also invoked with `--failonwarnings`. Common local
system JAR locations are detected. Nothing is downloaded at runtime. EPUBCheck
warnings and errors both abort export before any artifact for that document is
published, so neither can be reported as externally valid.

Successful artifact and corpus reports record EPUBCheck as `passed`, or as
`skipped` with `java-unavailable` / `epubcheck-unavailable`. A skip is explicit
and may be comparator-allowlisted for deterministic internal evidence, but it
is never equivalent to an EPUBCheck pass. Structural validation remains
required even when EPUBCheck is unavailable.

## Reproducible fixture transcript

Using Node 22.22.3 with the lockfile dependencies and no local Java runtime:

```text
$ npm run pdf:export -- tests/fixtures/pdf/born-digital.pdf --target paperPro --target paperProMove --out ./local-export
summary: 1 ready, 0 review-required, 0 failed; pass-rate 1
publication-paperpro.epub  4568 bytes  1ea7be566f5f4cf436e38ac117579452e233913063d3b447edba3cdf958f0689
publication-papermove.epub 4600 bytes  ea6a9dd1bec141736350e36b9ae7ca03c3f18e20bc7b84ace393ae067ace8f0e
EPUBCheck: skipped (java-unavailable); inspectEpub: passed
```

The JSON report printed by the command is the authoritative transcript; the
short rendering above lists its fixture artifact sizes and SHA-256 values.
