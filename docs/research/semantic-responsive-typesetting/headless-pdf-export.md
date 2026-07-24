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
basenames cannot collide. On Unix, the output path must be absent or an
existing empty directory. On Windows it must be absent because replacing an
existing directory is not an atomic operation there. A rejected output is not
modified.

Corpus export reconstructs and exports exactly one document in each fresh local
worker process. Resolved per-document and staging paths travel to that worker
over private process IPC and are not added to the worker's command line; the
original `<pdf-or-directory>` argument remains caller-supplied CLI input. The
parent enforces a 900-second wall-clock limit by default; override it with
`--document-timeout-seconds <1-86400>`. A timed-out worker and its local process
tree are stopped with a Unix process-group kill or Windows
`taskkill /T /F`, its staging directory is discarded, and the next document
still runs. The deterministic report row uses the fixed
`PDF_DOCUMENT_TIMEOUT` code and contains no duration, PID, signal, source path,
stderr, or stack. The CLI also stops every active worker tree and removes its
tracked private workspace before re-raising `SIGINT`, `SIGTERM`, or `SIGHUP`;
an unexpected parent IPC disconnect makes the worker stop its own tree.

Every completed audit/export run writes `corpus-audit.json`. It reports ready,
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

Workers write only into private per-document staging directories. After a
worker closes successfully, the parent requires the exact expected regular-file
set and opens each file once with no-follow semantics where the runtime
supports them. Before reading, it checks each opened file's size against its
independently expected exact length and fixed limits: 256 MiB per EPUB, 512 MiB
for the complete document, 1 MiB for the manifest, and 64 KiB for checksums.
EPUBs are copied and SHA-256 hashed from that same handle in 1 MiB chunks into
a parent-owned private file, so the parent never retains every profile EPUB in
memory. Manifest and checksum bytes are independently derived first, then read
only to their exact bounded lengths and compared before the derived bytes are
published.

Vite cache files and EPUBCheck scratch EPUBs also live below that
per-document workspace. A timeout or signal therefore removes the scratch data
with the workspace instead of leaving private files in a global temporary
directory.

Verified bytes and `corpus-audit.json` are assembled in one private run
directory created beside the requested output. Only after the complete report
passes its public JSON schema does the parent atomically rename that whole
same-filesystem directory into place. A timeout, malformed worker message,
staging substitution, or publication error therefore cannot expose a partial
run. Corpus-contract identity is bound before any worker starts and rechecked
inside the worker before reconstruction.

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
